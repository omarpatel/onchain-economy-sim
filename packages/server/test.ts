import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import bs58 from "bs58";
import { JoinError } from "@econ-sim/sim/engine";
import { CONFIG } from "@econ-sim/sim/config";
import type { EconomySnapshot } from "@econ-sim/sim/snapshot";
import type { EpochAllocation, GameEvent, IntentResult, PlayerView, ServerMessage } from "@econ-sim/sim/protocol";
import { Auth, buildSiwsMessage, NONCE_CAP } from "./src/auth.ts";
import { buildEpochAllocation, epochPrice, medianPrice, type AllocationInputs } from "./src/epochs.ts";
import { AUTH_RATE_LIMIT, createHttpServer } from "./src/http.ts";
import { Persist } from "./src/persist.ts";
import { SlidingWindow } from "./src/ratelimit.ts";
import { World, type WorldOptions } from "./src/world.ts";
import { MAX_SOCKETS_PER_PLAYER, WsHub } from "./src/ws.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "econ-server-"));
const BASE: Omit<WorldOptions, "dataDir"> = { seed: 7, npcs: 6, investors: 3, tickMs: 1000, warmupTicks: 48 };

// Same joins + intents + admin updates at the same head ticks in every run.
function scripted(w: World, ticks: number): void {
  w.join("p1", "Ann");
  w.join("p2", "Bob");
  for (let i = 0; i < ticks; i++) {
    if (i === 1) w.queue({ id: `r${i}`, playerId: "p1", intent: { kind: "rename_company", name: "Ann Industries" } });
    if (i === 2) w.setQuotesUsd({ AAPL: 150 }, 0.04);
    if (i === 3) w.queue({ id: `b${i}`, playerId: "p2", intent: { kind: "borrow", amountCr: 500 } });
    if (i === 3) w.queue({ id: `t${i}`, playerId: "p2", intent: { kind: "buy_truck" } });
    if (i === 5) w.setOnchainStakes({ "11111111111111111111111111111111": 5_000_000 }, 900);
    if (i === 9) w.queue({ id: `d${i}`, playerId: "p1", intent: { kind: "set_dividend_policy", payoutRatio: 0.3 } });
    if (i === 26) w.queue({ id: `g${i}`, playerId: "p1", intent: { kind: "buy_good", good: "wheat", qty: 5 } });
    if (i === 26) w.saveSnapshot(); // forced mid-head snapshot: the queued intent above is inside it AND in the journal
    if (i === 27) w.rename("p2", "Bobby");
    if (i === 28) w.setQuotesUsd({}, 0.05);
    w.step();
  }
}

describe("persistence", () => {
  test("snapshot + journal replay reproduces an uninterrupted run byte-for-byte, including server state", () => {
    const dir = tmp();
    try {
      const a = World.boot({ ...BASE, dataDir: dir });
      const headAtBoot = a.head;
      scripted(a, 30);
      const uninterrupted = a.snapshotJson;
      const serverState = JSON.stringify(a.state);
      assert.equal(a.head, headAtBoot + 30);
      const snap = a.persist.latestSnapshot();
      assert.ok(snap && snap.tick === headAtBoot + 26 && snap.seq === 1, `forced snapshot expected at head ${headAtBoot + 26} seq 1, got ${snap?.tick}/${snap?.seq}`);
      assert.ok(a.persist.journalFrom(0).length >= 10);
      a.persist.close(); // crash: no shutdown snapshot

      const resumed = World.boot({ ...BASE, dataDir: dir });
      assert.equal(resumed.head, headAtBoot + 30);
      assert.equal(resumed.snapshotJson, uninterrupted);
      assert.equal(JSON.stringify(resumed.state), serverState);
      assert.deepEqual(resumed.state.oracleRing, [0.04, 0.05]);
      assert.equal(resumed.state.onchainStakes["11111111111111111111111111111111"], 5_000_000);
      assert.equal(resumed.persist.getPlayer("p1"), null); // sim state came from the journal, not the players table
      assert.deepEqual(resumed.game.players.map((p) => p.name), ["Ann", "Bobby"]);
      resumed.close();

      const b = World.boot({ ...BASE, dataDir: ":memory:" });
      scripted(b, 30);
      assert.equal(b.snapshotJson, uninterrupted);
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a snapshot the engine cannot restore is archived and a fresh world boots", () => {
    const dir = tmp();
    try {
      const stale = new Persist(join(dir, "economy.sqlite"));
      stale.saveSnapshot(10, 0, JSON.stringify({ v: 0 }), "{}");
      stale.close();
      const lines: string[] = [];
      const w = World.boot({ ...BASE, dataDir: dir, log: (l) => lines.push(l) });
      assert.equal(w.head, BASE.warmupTicks);
      assert.ok(lines.some((l) => /snapshot @10 cannot be restored/.test(l)), lines.join("\n"));
      const files = readdirSync(dir);
      assert.ok(files.some((f) => /^economy\.sqlite\.bak-/.test(f)), files.join(","));
      assert.ok(files.includes("economy.sqlite"));
      assert.equal(w.persist.latestSnapshot()?.tick, BASE.warmupTicks);
      w.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a join the sim rejects is not journaled and does not break replay", () => {
    const w = World.boot({ ...BASE, dataDir: ":memory:" });
    try {
      for (let i = 0; i < CONFIG.player.maxPlayers; i++) w.join(`p${i}`, `P${i}`);
      const head = w.head;
      assert.throws(() => w.join("overflow", "Nope"), (err: unknown) => err instanceof JoinError && err.code === "max_players");
      w.step();
      const joins = w.persist.journalFrom(head).flatMap((r) => (r.entry.t === "join" ? [r.entry.playerId] : []));
      assert.equal(joins.length, CONFIG.player.maxPlayers);
      assert.ok(!joins.includes("overflow"));
      assert.equal(w.hasPlayer("overflow"), false);
      assert.equal(w.playerCount, CONFIG.player.maxPlayers);
    } finally {
      w.close();
    }
  });

  test("intent results are routed by (player, id): equal ids from two players do not collide", () => {
    const w = World.boot({ ...BASE, dataDir: ":memory:" });
    try {
      w.join("p1", "Ann");
      w.join("p2", "Bob");
      w.step();
      w.queue({ id: "same", playerId: "p1", intent: { kind: "buy_truck" } });
      w.queue({ id: "same", playerId: "p2", intent: { kind: "borrow", amountCr: -1 } });
      w.queue({ id: "same", playerId: "p1", intent: { kind: "set_autopilot", enabled: true } });
      const info = w.step();
      const p1 = info.resultsByPlayer.get("p1") ?? [];
      const p2 = info.resultsByPlayer.get("p2") ?? [];
      assert.equal(p1.length, 2);
      assert.equal(p2.length, 1);
      assert.ok(p1.every((r) => r.id === "same"));
      assert.equal(p2[0].id, "same");
      assert.equal(p2[0].ok, false); // the rejected borrow went to p2, not to p1
      assert.ok(p1.every((r) => r.ok), JSON.stringify(p1));
    } finally {
      w.close();
    }
  });
});

// ───────────────────────── rate limiting ─────────────────────────

describe("sliding window", () => {
  test("blocks the (limit+1)th hit inside the window and frees it once the window passes", () => {
    const win = new SlidingWindow(3, 1000);
    assert.ok(win.hit("a", 0) && win.hit("a", 10) && win.hit("a", 20));
    assert.equal(win.hit("a", 999), false);
    assert.ok(win.hit("b", 999)); // independent keys
    assert.ok(win.hit("a", 1001)); // the t=0 hit fell out of the window
    assert.equal(win.hit("a", 1005), false);
    win.prune(3000);
    assert.equal(win.size, 0);
  });
});

// ───────────────────────── epoch allocation ─────────────────────────

describe("epoch allocation", () => {
  const PK_A = "A".repeat(32);
  const PK_B = "B".repeat(32);
  const PK_C = "C".repeat(32);
  const close = (feesEcon: number, feesExternal: boolean): AllocationInputs["close"] => ({
    tick: 240, kind: "epoch_close", epoch: 10, dividendsCr: 0, yieldEcon: 0, burnedEcon: 0, feesEcon, feesExternal,
  });
  const dividend = (companyId: string, paid: { account: string; amountCr: number }[]): Extract<GameEvent, { kind: "dividend" }> => ({
    tick: 240, kind: "dividend", companyId, poolCr: paid.reduce((s, p) => s + p.amountCr, 0), perShareCr: 1, paid,
  });
  // econPriceUsd = 1: 1 CR (100 minor) → 0.01 USD → 0.01 $ECON = 10_000 minor.
  const base = (): AllocationInputs => ({
    close: close(100_000, true),
    dividends: [
      dividend("co:1", [{ account: "sol:a", amountCr: 300 }, { account: "sol:b", amountCr: 100 }, { account: "guest:x", amountCr: 100 }, { account: "co:1", amountCr: 500 }]),
      dividend("co:2", [{ account: "sol:a", amountCr: 9_000_000 }]), // not on-chain: never a weight
    ],
    onChainCompanies: new Set(["co:1"]),
    pubkeys: new Map([["sol:a", PK_A], ["sol:b", PK_B]]),
    onchainStakes: {},
    econPriceUsd: 1,
  });

  test("no external fees → no on-chain value at all, whatever the sim paid", () => {
    const input = base();
    input.close = close(100_000, false);
    input.onchainStakes = { [PK_A]: 1_000 };
    assert.deepEqual(buildEpochAllocation(input).allocations, []);
  });

  test("dividend rows are weights scaled into min(pegConverted, fees × dividendShareOfFees)", () => {
    const alloc = buildEpochAllocation(base());
    const rows = alloc.allocations.filter((a) => a.source === "dividend");
    const pool = Math.floor(100_000 * CONFIG.chain.dividendShareOfFees);
    assert.equal(pool, 30_000);
    // peg-converted weights: a = 30_000, b = 10_000 → total 40_000 > pool → scaled 3:1 into the pool
    assert.deepEqual(rows, [
      { playerId: "sol:a", claimant: PK_A, amountEcon: 22_500, source: "dividend" },
      { playerId: "sol:b", claimant: PK_B, amountEcon: 7_500, source: "dividend" },
    ]);
    assert.ok(rows.reduce((s, r) => s + r.amountEcon, 0) <= pool);
    assert.equal(alloc.epoch, 10);
    assert.equal(alloc.tickClosed, 240);
  });

  test("a pool larger than the peg-converted total pays the peg amounts without scaling up", () => {
    const input = base();
    input.close = close(10_000_000, true); // pool 3_000_000 ≫ 40_000 converted
    const rows = buildEpochAllocation(input).allocations.filter((a) => a.source === "dividend");
    assert.deepEqual(rows.map((r) => r.amountEcon), [30_000, 10_000]);
  });

  test("a tiny pool rounds rows down and never exceeds the pool", () => {
    const input = base();
    input.close = close(10, true); // pool = 3
    const rows = buildEpochAllocation(input).allocations.filter((a) => a.source === "dividend");
    assert.deepEqual(rows.map((r) => [r.playerId, r.amountEcon]), [["sol:a", 2]]); // b's share floors to 0 and is dropped
  });

  test("yield comes only from on-chain staking positions, pro-rata, never from sim stake", () => {
    const input = base();
    input.dividends = [];
    input.onchainStakes = { [PK_A]: 300, [PK_B]: 100, [PK_C]: 0 };
    const rows = buildEpochAllocation(input).allocations;
    const yieldPool = Math.floor(100_000 * CONFIG.chain.yieldFrac);
    assert.deepEqual(rows, [
      { playerId: "sol:a", claimant: PK_A, amountEcon: (yieldPool * 3) / 4, source: "yield" },
      { playerId: "sol:b", claimant: PK_B, amountEcon: yieldPool / 4, source: "yield" },
    ]);
    // a staker who never signed in is still paid, keyed by the canonical sol:<pubkey> id
    input.onchainStakes = { [PK_C]: 50 };
    assert.deepEqual(buildEpochAllocation(input).allocations, [{ playerId: `sol:${PK_C}`, claimant: PK_C, amountEcon: yieldPool, source: "yield" }]);
    input.onchainStakes = {};
    assert.deepEqual(buildEpochAllocation(input).allocations, []);
  });

  test("oracle: ring median with a ±30% per-epoch clamp", () => {
    const near = (a: number, b: number): void => assert.ok(Math.abs(a - b) < 1e-12, `${a} ≉ ${b}`);
    assert.equal(medianPrice([]), 0);
    assert.equal(medianPrice([0.02, 100, 0.01]), 0.02);
    near(medianPrice([0.01, 0.03]), 0.02);
    assert.equal(epochPrice([], null, 0.07), 0.07); // no external updates yet → sim price
    assert.equal(epochPrice([5, 0.02, 0.03], null, 0.07), 0.03); // first epoch: median, no anchor
    near(epochPrice([1, 1, 1], 0.02, 0.07), 0.026); // capped at +30%
    near(epochPrice([0.001, 0.001, 0.001], 0.02, 0.07), 0.014); // floored at -30%
    assert.equal(epochPrice([0.021], 0.02, 0.07), 0.021); // inside the band → median as-is
  });

  test("world: the epoch settles at the ring median and the anchor carries to the next epoch", () => {
    const w = World.boot({ ...BASE, dataDir: ":memory:" });
    try {
      w.setQuotesUsd({}, 0.02);
      w.setQuotesUsd({}, 0.01);
      w.setQuotesUsd({}, 100); // outlier: a single manipulated print
      let closes = 0;
      while (closes === 0) closes += w.step().events.filter((e) => e.kind === "epoch_close").length;
      assert.equal(w.state.epochEconUsd, 0.02);
      for (let i = 0; i < 24; i++) w.setQuotesUsd({}, 100); // the whole ring is now the manipulated price
      assert.equal(w.state.oracleRing.length, 24);
      closes = 0;
      while (closes === 0) closes += w.step().events.filter((e) => e.kind === "epoch_close").length;
      assert.ok(Math.abs((w.state.epochEconUsd ?? 0) - 0.026) < 1e-12, String(w.state.epochEconUsd));
    } finally {
      w.close();
    }
  });
});

// ───────────────────────── live server ─────────────────────────

interface Live {
  url: string;
  wsUrl: string;
  world: World;
  hub: WsHub;
  auth: Auth;
  close: () => void;
}

function startServer(dataDir: string, tickMs: number, authRateLimit = 1000): Promise<Live> {
  const world = World.boot({ ...BASE, dataDir, tickMs });
  const auth = new Auth(world.persist, { domain: "localhost", allowGuest: true });
  const hub = new WsHub(world, auth);
  const http = createHttpServer(world, auth, { corsOrigin: "http://localhost:3000", adminToken: "adm", clients: () => hub.authed, authRateLimit });
  hub.attach(http);
  const { promise, resolve } = Promise.withResolvers<Live>();
  http.listen(0, "127.0.0.1", () => {
    const addr = http.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    world.start(() => hub.authed);
    resolve({
      url: `http://127.0.0.1:${addr.port}`,
      wsUrl: `ws://127.0.0.1:${addr.port}/ws`,
      world,
      hub,
      auth,
      close: () => {
        hub.close();
        http.close();
        world.close();
      },
    });
  });
  return promise;
}

async function json<T>(res: Response): Promise<T> {
  const body: T = await res.json();
  return body;
}

function opened(ws: WebSocket): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  ws.onopen = () => resolve();
  return promise;
}

/** Poll `cond` until true (server-side socket bookkeeping lags the client's close event). */
async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("timeout waiting for condition");
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 10);
    await promise;
  }
}

interface WsClient {
  ws: WebSocket;
  next: <T extends ServerMessage>(pred: (m: ServerMessage) => m is T, timeoutMs?: number) => Promise<T>;
  closed: Promise<number>;
}

/** Open a socket and expose typed "wait for the next matching message" plus the close code. */
async function wsClient(url: string): Promise<WsClient> {
  const ws = new WebSocket(url);
  const waiters: ((m: ServerMessage) => boolean)[] = [];
  ws.onmessage = (ev) => {
    const m: ServerMessage = JSON.parse(String(ev.data));
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i](m)) waiters.splice(i, 1);
  };
  const closed = Promise.withResolvers<number>();
  ws.onclose = (ev) => closed.resolve(ev.code);
  const next = <T extends ServerMessage>(pred: (m: ServerMessage) => m is T, timeoutMs = 3000): Promise<T> => {
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${pred.name || "message"}`)), timeoutMs);
    waiters.push((m) => {
      if (!pred(m)) return false;
      clearTimeout(timer);
      resolve(m);
      return true;
    });
    return promise;
  };
  await opened(ws);
  return { ws, next, closed: closed.promise };
}

const isHello = (m: ServerMessage): m is Extract<ServerMessage, { type: "hello" }> => m.type === "hello";
const isTick = (m: ServerMessage): m is Extract<ServerMessage, { type: "tick" }> => m.type === "tick";

/** Authenticate a fresh socket as `token`; resolves with the hello or the close code. */
async function authed(url: string, token: string): Promise<{ client: WsClient; hello: Extract<ServerMessage, { type: "hello" }> | null; code: number | null }> {
  const client = await wsClient(url);
  client.ws.send(JSON.stringify({ type: "auth", token }));
  const outcome = await Promise.race([client.next(isHello).then((hello) => ({ hello, code: null })), client.closed.then((code) => ({ hello: null, code }))]);
  return { client, ...outcome };
}

function keypair(): { pubkey: string; priv: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  if (typeof jwk.x !== "string") throw new Error("no jwk.x");
  return { pubkey: bs58.encode(Buffer.from(jwk.x, "base64url")), priv: privateKey };
}

describe("server", () => {
  let live: Live;
  let dir: string;
  before(async () => {
    dir = tmp();
    live = await startServer(dir, 100);
  });
  after(() => {
    live.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("health + economy snapshot with ETag", async () => {
    const health = await json<{ ok: boolean; tick: number; players: number }>(await fetch(`${live.url}/api/health`));
    assert.equal(health.ok, true);
    assert.ok(health.tick >= 48);
    const res = await fetch(`${live.url}/api/economy`);
    const etag = res.headers.get("etag") ?? "";
    assert.match(etag, /^"t\d+"$/);
    const snap = await json<EconomySnapshot>(res);
    assert.equal(snap.ticksPerDay, 24);
    assert.ok(snap.companies.length > 0 && snap.world.tiles.length > 0);
    assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:3000");
    const again = await fetch(`${live.url}/api/economy`, { headers: { "if-none-match": etag } });
    assert.ok(again.status === 304 || again.status === 200); // 200 only if a tick landed in between
  });

  test("SIWS: nonce → signed message → session; bad signature and nonce reuse rejected", async () => {
    const { pubkey, priv } = keypair();
    const { nonce } = await json<{ nonce: string }>(await fetch(`${live.url}/auth/nonce`));
    const message = buildSiwsMessage({
      domain: "localhost",
      address: pubkey,
      statement: "Sign in to Economy Sim",
      uri: "http://localhost:3000",
      version: "1",
      chainId: "mainnet",
      nonce,
      issuedAt: new Date().toISOString(),
    });
    const signature = bs58.encode(sign(null, Buffer.from(message), priv));
    const post = (body: unknown): Promise<Response> =>
      fetch(`${live.url}/auth/siws`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const bad = await post({ pubkey, message, signature: bs58.encode(Buffer.alloc(64, 1)) });
    assert.equal(bad.status, 401);

    const okRes = await post({ pubkey, message, signature });
    assert.equal(okRes.status, 200);
    const session = await json<{ token: string; playerId: string; name: string }>(okRes);
    assert.equal(session.playerId, `sol:${pubkey}`);
    assert.equal(session.name, `${pubkey.slice(0, 4)}…${pubkey.slice(-4)}`);
    assert.equal(session.token.length, 64);

    const reuse = await post({ pubkey, message, signature });
    assert.equal(reuse.status, 401);

    const wrongDomain = buildSiwsMessage({ domain: "evil.example", address: pubkey, nonce: await json<{ nonce: string }>(await fetch(`${live.url}/auth/nonce`)).then((n) => n.nonce), issuedAt: new Date().toISOString() });
    const wd = await post({ pubkey, message: wrongDomain, signature: bs58.encode(sign(null, Buffer.from(wrongDomain), priv)) });
    assert.equal(wd.status, 401);

    // base64 signatures are accepted too
    const { nonce: n2 } = await json<{ nonce: string }>(await fetch(`${live.url}/auth/nonce`));
    const m2 = buildSiwsMessage({ domain: "localhost", address: pubkey, nonce: n2, issuedAt: new Date().toISOString() });
    const b64 = await post({ pubkey, message: m2, signature: sign(null, Buffer.from(m2), priv).toString("base64") });
    assert.equal(b64.status, 200);

    // /api/me auto-joins and returns the PlayerView
    const me = await json<PlayerView>(await fetch(`${live.url}/api/me`, { headers: { authorization: `Bearer ${session.token}` } }));
    assert.equal(me.playerId, session.playerId);
    assert.ok(me.company && me.company.buildings.length >= 1);
    const noAuth = await fetch(`${live.url}/api/me`);
    assert.equal(noAuth.status, 401);

    // rename player
    const renamed = await fetch(`${live.url}/auth/name`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ name: "Satoshi" }),
    });
    assert.equal(renamed.status, 200);
    assert.equal(live.world.game.player(session.playerId)?.name, "Satoshi");
  });

  test("WS: auth → hello, build intent applied next tick, malformed intent rejected immediately", async () => {
    const guest = await json<{ token: string; playerId: string }>(
      await fetch(`${live.url}/auth/guest`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Tester" }) }),
    );
    const ws = new WebSocket(live.wsUrl);
    const inbox: ServerMessage[] = [];
    const waiters: ((m: ServerMessage) => boolean)[] = [];
    ws.onmessage = (ev) => {
      const m: ServerMessage = JSON.parse(String(ev.data));
      inbox.push(m);
      for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i](m)) waiters.splice(i, 1);
    };
    const next = <T extends ServerMessage>(pred: (m: ServerMessage) => m is T, timeoutMs = 3000): Promise<T> => {
      const { promise, resolve, reject } = Promise.withResolvers<T>();
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${pred.name || "message"}`)), timeoutMs);
      waiters.push((m) => {
        if (!pred(m)) return false;
        clearTimeout(timer);
        resolve(m);
        return true;
      });
      return promise;
    };
    await opened(ws);
    ws.send(JSON.stringify({ type: "auth", token: guest.token }));
    const hello = await next((m): m is Extract<ServerMessage, { type: "hello" }> => m.type === "hello");
    assert.equal(hello.playerId, guest.playerId);
    assert.equal(hello.ticksPerDay, 24);
    assert.equal(hello.tickMs, 100);
    assert.ok(hello.you.company, "guest has a company");

    // malformed intents → immediate result error, never queued
    ws.send(JSON.stringify({ type: "intent", id: "m1", intent: { kind: "borrow", amountCr: -5 } }));
    const r1 = await next((m): m is Extract<ServerMessage, { type: "result" }> => m.type === "result");
    assert.equal(r1.result.id, "m1");
    assert.equal(r1.result.ok, false);
    ws.send(JSON.stringify({ type: "intent", id: "m2", intent: { kind: "teleport" } }));
    const r2 = await next((m): m is Extract<ServerMessage, { type: "result" }> => m.type === "result");
    assert.match(r2.result.error ?? "", /unknown intent kind/);
    assert.ok(!live.world.playerView(guest.playerId).pending.some((p) => p.id === "m1" || p.id === "m2"));

    // build on a free fertile tile (build buys common land itself)
    const before = hello.you.company.buildings.length;
    const tile = hello.snapshot.world.tiles.find((t) => t.res === "fertile" && !t.owner && !t.building && !t.premium);
    assert.ok(tile, "a free fertile tile exists");
    ws.send(JSON.stringify({ type: "intent", id: "farm", intent: { kind: "build", buildingType: "farm", x: tile.x, y: tile.y } }));
    const tickMsg = await next(
      (m): m is Extract<ServerMessage, { type: "tick" }> => m.type === "tick" && m.results.some((r: IntentResult) => r.id === "farm"),
    );
    const farm = tickMsg.results.find((r) => r.id === "farm");
    assert.ok(farm?.ok, `build rejected: ${farm?.error}`);
    assert.equal(tickMsg.you.company?.buildings.length, before + 1);
    assert.ok(tickMsg.events.some((e) => e.kind === "build_started"));
    assert.ok(tickMsg.snapshot.players.some((p) => p.id === guest.playerId && p.name === "Tester"));
    assert.equal(tickMsg.snapshot.tick, tickMsg.tick + 1); // snapshot.tick is the head (next tick to simulate)

    // ping/pong
    ws.send(JSON.stringify({ type: "ping", t: 42 }));
    const pong = await next((m): m is Extract<ServerMessage, { type: "pong" }> => m.type === "pong");
    assert.equal(pong.t, 42);
    ws.close();

    // unauthenticated socket is closed after the timeout / on a non-auth first message
    const rogue = new WebSocket(live.wsUrl);
    await opened(rogue);
    rogue.send(JSON.stringify({ type: "intent", id: "x", intent: { kind: "buy_truck" } }));
    const closed = Promise.withResolvers<number>();
    rogue.onclose = (ev) => closed.resolve(ev.code);
    const closeCode = await closed.promise;
    assert.equal(closeCode, 4001);
  });

  test("epochs: allocation persisted and served after an epoch close", async () => {
    let closed = false;
    for (let i = 0; i < 48 && !closed; i++) {
      const info = live.world.step();
      closed = info.events.some((e) => e.kind === "epoch_close");
    }
    assert.ok(closed);
    const latest = await json<EpochAllocation>(await fetch(`${live.url}/api/epochs/latest`));
    assert.equal(latest.tickClosed % 24, 0);
    assert.equal(latest.epoch, latest.tickClosed / 24);
    for (const a of latest.allocations) {
      assert.ok(Number.isInteger(a.amountEcon) && a.amountEcon > 0);
      assert.ok(a.source === "dividend" || a.source === "yield");
    }
    const byN = await json<EpochAllocation>(await fetch(`${live.url}/api/epochs/${latest.epoch}`));
    assert.deepEqual(byN, latest);
    assert.equal((await fetch(`${live.url}/api/epochs/999999`)).status, 404);

    const events = await json<{ events: { kind: string }[] }>(await fetch(`${live.url}/api/events?since=${latest.tickClosed}`));
    assert.ok(events.events.some((e) => e.kind === "epoch_close"));
  });

  test("admin: oracle + creator fees + snapshot need the token and are journaled", async () => {
    const hdr = { "content-type": "application/json", authorization: "Bearer adm" };
    const denied = await fetch(`${live.url}/admin/snapshot`, { method: "POST" });
    assert.equal(denied.status, 401);
    for (const bad of ["adn", "ad", "admx", "ADM"]) {
      const res = await fetch(`${live.url}/admin/snapshot`, { method: "POST", headers: { authorization: `Bearer ${bad}` } });
      assert.equal(res.status, 401, `token ${JSON.stringify(bad)} accepted`);
    }
    const headBefore = live.world.head;
    const oracle = await fetch(`${live.url}/admin/oracle`, { method: "POST", headers: hdr, body: JSON.stringify({ quotes: { AAPL: 111 }, econUsd: 0.02 }) });
    assert.equal(oracle.status, 200);
    const fees = await fetch(`${live.url}/admin/creator-fees`, { method: "POST", headers: hdr, body: JSON.stringify({ econMinorPerTick: 1234 }) });
    assert.equal(fees.status, 200);
    const snap = await json<{ ok: boolean; tick: number }>(await fetch(`${live.url}/admin/snapshot`, { method: "POST", headers: hdr }));
    assert.ok(snap.tick >= headBefore && live.world.persist.latestSnapshot()?.tick === snap.tick);
    live.world.step();
    const kinds = live.world.persist.journalFrom(headBefore).map((r) => r.entry.t);
    assert.ok(kinds.includes("oracle") && kinds.includes("fees"));
    assert.equal(live.world.snapshot.chain.rwa.find((r) => r.symbol === "AAPL")?.usd, 111);
    assert.equal(live.world.snapshot.chain.econPriceUsd, 0.02);
    assert.ok(live.world.state.oracleRing.includes(0.02));
  });

  test("admin: on-chain stakes are validated, journaled and replace the previous set", async () => {
    const hdr = { "content-type": "application/json", authorization: "Bearer adm" };
    const post = (body: unknown): Promise<Response> => fetch(`${live.url}/admin/onchain-stakes`, { method: "POST", headers: hdr, body: JSON.stringify(body) });
    const { pubkey } = keypair();
    assert.equal((await fetch(`${live.url}/admin/onchain-stakes`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
    assert.equal((await post({ stakes: [], asOfSlot: 1 })).status, 400);
    assert.equal((await post({ stakes: { [pubkey]: 10 } })).status, 400);
    assert.equal((await post({ stakes: { "not a pubkey": 10 }, asOfSlot: 1 })).status, 400);
    assert.equal((await post({ stakes: { [pubkey]: -1 }, asOfSlot: 1 })).status, 400);
    assert.equal((await post({ stakes: { [pubkey]: 1.5 }, asOfSlot: 1 })).status, 400);
    const headBefore = live.world.head;
    const first = await json<{ ok: boolean; stakers: number; asOfSlot: number }>(await post({ stakes: { [pubkey]: 4_000_000, [keypair().pubkey]: 0 }, asOfSlot: 500 }));
    assert.deepEqual(first, { ok: true, stakers: 1, asOfSlot: 500 });
    assert.deepEqual(live.world.state.onchainStakes, { [pubkey]: 4_000_000 });
    assert.equal((await post({ stakes: { [pubkey]: 1 }, asOfSlot: 499 })).status, 409); // stale report
    const second = await post({ stakes: {}, asOfSlot: 501 });
    assert.equal(second.status, 200);
    assert.deepEqual(live.world.state.onchainStakes, {});
    live.world.step();
    const rows = live.world.persist.journalFrom(headBefore).map((r) => r.entry).filter((e) => e.t === "stakes");
    assert.equal(rows.length, 2);
  });

  test("WS: at most two sockets per player; the third is refused", async () => {
    const guest = live.auth.guest({ name: "Multi" });
    const a = await authed(live.wsUrl, guest.token);
    const b = await authed(live.wsUrl, guest.token);
    assert.ok(a.hello && b.hello);
    assert.equal(live.hub.socketsOf(guest.playerId), 2);
    const c = await authed(live.wsUrl, guest.token);
    assert.equal(c.hello, null);
    assert.equal(c.code, 4008);
    assert.equal(MAX_SOCKETS_PER_PLAYER, 2);
    a.client.ws.close();
    await until(() => live.hub.socketsOf(guest.playerId) === 1);
    // a slot freed by a close is reusable
    const d = await authed(live.wsUrl, guest.token);
    assert.ok(d.hello);
    b.client.ws.close();
    d.client.ws.close();
    await until(() => live.hub.socketsOf(guest.playerId) === 0);
  });

  test("WS: the intent rate limit is per player across its sockets", async () => {
    const guest = live.auth.guest({ name: "Spammer" });
    const a = await authed(live.wsUrl, guest.token);
    const b = await authed(live.wsUrl, guest.token);
    assert.ok(a.hello && b.hello);
    const rejected = Promise.race([
      a.client.next((m): m is Extract<ServerMessage, { type: "result" }> => m.type === "result" && /rate limit/.test(m.result.error ?? "")),
      b.client.next((m): m is Extract<ServerMessage, { type: "result" }> => m.type === "result" && /rate limit/.test(m.result.error ?? "")),
    ]);
    for (let i = 0; i < 15; i++) a.client.ws.send(JSON.stringify({ type: "intent", id: `a${i}`, intent: { kind: "buy_truck" } }));
    for (let i = 0; i < 15; i++) b.client.ws.send(JSON.stringify({ type: "intent", id: `b${i}`, intent: { kind: "buy_truck" } }));
    const r = await rejected;
    assert.equal(r.result.ok, false);
    a.client.ws.close();
    b.client.ws.close();
  });

  test("WS: a malformed-but-parseable message never kills the process", async () => {
    const guest = live.auth.guest({ name: "Fuzz" });
    const a = await authed(live.wsUrl, guest.token);
    assert.ok(a.hello);
    a.client.ws.send(JSON.stringify({ type: "intent", id: { nested: true }, intent: null }));
    const r = await a.client.next((m): m is Extract<ServerMessage, { type: "result" }> => m.type === "result");
    assert.equal(r.result.ok, false);
    a.client.ws.send(JSON.stringify({ type: "intent", id: "ok1", intent: { kind: "buy_truck" } }));
    const tick = await a.client.next((m): m is Extract<ServerMessage, { type: "tick" }> => isTick(m) && m.results.some((x) => x.id === "ok1"));
    assert.ok(tick);
    assert.equal((await fetch(`${live.url}/api/health`)).status, 200);
    a.client.ws.close();
  });
});

describe("auth rate limit", () => {
  let live: Live;
  before(async () => {
    live = await startServer(":memory:", 1000, AUTH_RATE_LIMIT);
  });
  after(() => live.close());

  test(`the ${AUTH_RATE_LIMIT + 1}th /auth/* call from one IP inside a minute is refused with 429`, async () => {
    const statuses: number[] = [];
    for (let i = 0; i < AUTH_RATE_LIMIT + 2; i++) {
      const path = i % 3 === 0 ? "/auth/nonce" : i % 3 === 1 ? "/auth/guest" : "/auth/siws";
      const res = await fetch(`${live.url}${path}`, path === "/auth/nonce" ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      statuses.push(res.status);
      await res.arrayBuffer();
    }
    assert.deepEqual(statuses.slice(AUTH_RATE_LIMIT), [429, 429]);
    assert.ok(statuses.slice(0, AUTH_RATE_LIMIT).every((s) => s !== 429), statuses.join(","));
    // non-auth routes are unaffected
    assert.equal((await fetch(`${live.url}/api/health`)).status, 200);
  });

  test("the nonce store is capped: issuing beyond the cap evicts the oldest nonce", () => {
    const auth = new Auth(live.world.persist, { domain: "localhost", allowGuest: true });
    const first = auth.nonce();
    for (let i = 0; i < NONCE_CAP; i++) auth.nonce();
    assert.equal(auth.liveNonces, NONCE_CAP);
    const { pubkey, priv } = keypair();
    const message = buildSiwsMessage({ domain: "localhost", address: pubkey, nonce: first, issuedAt: new Date().toISOString() });
    assert.throws(() => auth.siws({ pubkey, message, signature: bs58.encode(sign(null, Buffer.from(message), priv)) }), /unknown or expired nonce/);
  });
});

describe("full world", () => {
  let live: Live;
  before(async () => {
    live = await startServer(":memory:", 1000);
    for (let i = 0; i < CONFIG.player.maxPlayers; i++) live.world.join(`filler:${i}`, `F${i}`);
  });
  after(() => live.close());

  test("a join beyond the player cap is refused cleanly over WS and HTTP, nothing is journaled, the server keeps serving", async () => {
    const guest = live.auth.guest({ name: "Late" });
    const head = live.world.head;
    const a = await authed(live.wsUrl, guest.token);
    assert.equal(a.hello, null);
    assert.equal(a.code, 4013);
    const me = await fetch(`${live.url}/api/me`, { headers: { authorization: `Bearer ${guest.token}` } });
    assert.equal(me.status, 503);
    assert.match((await json<{ error: string }>(me)).error, /max_players/);
    assert.equal(live.world.hasPlayer(guest.playerId), false);
    live.world.step();
    assert.ok(!live.world.persist.journalFrom(head).some((r) => r.entry.t === "join" && r.entry.playerId === guest.playerId));
    assert.equal(live.world.playerCount, CONFIG.player.maxPlayers);
    const health = await json<{ ok: boolean }>(await fetch(`${live.url}/api/health`));
    assert.equal(health.ok, true);
    // an existing player still connects fine
    const filler = live.world.persist.createSession("filler-token", "filler:3", 60_000);
    const b = await authed(live.wsUrl, filler.token);
    assert.ok(b.hello);
    assert.equal(b.hello.playerId, "filler:3");
    b.client.ws.close();
  });
});
