import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { BN } from "@coral-xyz/anchor";
import { keccak_256 } from "@noble/hashes/sha3";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { ConfigError, DEFAULT_MAX_EPOCH_TOTAL_ECON, loadConfig } from "./src/config.ts";
import type { TxOutcome } from "./src/dividends.ts";
import { startProofServer } from "./src/http.ts";
import { median, RollingMedian } from "./src/median.ts";
import { bondingCurveCreator, buildCollectCreatorFeeIx, creatorVaultPda, feeInflowEconMinorPerTick, PUMP_VAULT_RESERVE_LAMPORTS } from "./src/pumpfun.ts";
import { RWA_FEEDS, RwaFeed, verifyFeedIds } from "./src/rwa.ts";
import { GameServer } from "./src/server.ts";
import { EpochSettler, SettlementStore, type RootPublisher } from "./src/settle.ts";
import { aggregateStakes, loadStakingIdl, POSITION_POOL_OFFSET, StakeObserver } from "./src/stakes.ts";
import { stakePoolPda } from "./src/pdas.ts";
import {
  allocationsFromEpoch,
  buildEpochTree,
  fromHex,
  toHex,
  verifyProof,
  type Allocation,
  type ServerEpoch,
} from "./src/settlement.ts";

const u64le = (n: bigint): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const sortedPair = (a: Uint8Array, b: Uint8Array): Uint8Array =>
  Buffer.compare(Buffer.from(a), Buffer.from(b)) <= 0
    ? keccak_256(Buffer.concat([a, b]))
    : keccak_256(Buffer.concat([b, a]));

const K = [Keypair.generate(), Keypair.generate(), Keypair.generate()].map((k) => k.publicKey);

describe("merkle settlement", () => {
  const epoch = 7n;
  const allocs: Allocation[] = [
    { index: 0, claimant: K[0], amount: 1_000n },
    { index: 1, claimant: K[1], amount: 25n },
    { index: 2, claimant: K[2], amount: 3_000_000_000n },
  ];

  test("root of a 3-leaf tree matches the hand-computed value", () => {
    const leaf = (a: Allocation): Uint8Array =>
      keccak_256(Buffer.concat([u64le(epoch), u64le(BigInt(a.index)), a.claimant.toBuffer(), u64le(a.amount)]));
    const [l0, l1, l2] = allocs.map(leaf);
    const n01 = sortedPair(l0, l1);
    const expectedRoot = sortedPair(n01, l2); // odd leaf is carried up unchanged

    const tree = buildEpochTree(epoch, allocs);
    assert.equal(toHex(tree.root), toHex(expectedRoot));
    assert.equal(tree.total, 3_000_001_025n);
    assert.deepEqual(tree.proofs[0].map(toHex), [toHex(l1), toHex(l2)]);
    assert.deepEqual(tree.proofs[2].map(toHex), [toHex(n01)]);
  });

  test("proofs verify for every leaf and reject tampering", () => {
    const tree = buildEpochTree(epoch, allocs);
    for (const a of allocs) assert.ok(verifyProof(epoch, a, tree.proofs[a.index], tree.root), `leaf ${a.index}`);
    assert.ok(!verifyProof(epoch, { ...allocs[1], amount: 26n }, tree.proofs[1], tree.root));
    assert.ok(!verifyProof(epoch + 1n, allocs[1], tree.proofs[1], tree.root));
    assert.ok(!verifyProof(epoch, { ...allocs[1], index: 0 }, tree.proofs[1], tree.root));
    // hex round-trip used by the proofs file
    assert.ok(verifyProof(epoch, allocs[0], tree.proofs[0].map(toHex).map(fromHex), fromHex(toHex(tree.root))));
  });

  test("single leaf: root is the leaf, proof is empty", () => {
    const tree = buildEpochTree(1n, [allocs[0]]);
    assert.deepEqual(tree.proofs[0], []);
    assert.ok(verifyProof(1n, allocs[0], [], tree.root));
  });

  test("allocationsFromEpoch drops null claimants, sums per pubkey, orders by pubkey", () => {
    const [a, b] = [K[0].toBase58(), K[1].toBase58()].sort();
    const ep: ServerEpoch = {
      epoch: 3,
      tickClosed: 72,
      allocations: [
        { playerId: "guest:x", claimant: null, amountEcon: 999, source: "dividend" },
        { playerId: "sol:b", claimant: b, amountEcon: 10.9, source: "dividend" },
        { playerId: "sol:a", claimant: a, amountEcon: 5, source: "yield" },
        { playerId: "sol:b", claimant: b, amountEcon: 4, source: "yield" },
        { playerId: "sol:c", claimant: K[2].toBase58(), amountEcon: 0, source: "yield" },
      ],
    };
    const out = allocationsFromEpoch(ep);
    assert.deepEqual(
      out.map((x) => [x.index, x.claimant.toBase58(), x.amount]),
      [
        [0, a, 5n],
        [1, b, 14n],
      ],
    );
  });
});

describe("settlement loop (mock server, dry-run publisher)", () => {
  let mock: Server;
  let baseUrl: string;
  const epochs: Record<number, ServerEpoch> = {
    1: { epoch: 1, tickClosed: 24, allocations: [{ playerId: "g", claimant: null, amountEcon: 5, source: "dividend" }] },
    2: {
      epoch: 2,
      tickClosed: 48,
      allocations: [
        { playerId: "p0", claimant: K[0].toBase58(), amountEcon: 1_500_000, source: "dividend" },
        { playerId: "p1", claimant: K[1].toBase58(), amountEcon: 250_000, source: "yield" },
        { playerId: "p0", claimant: K[0].toBase58(), amountEcon: 100, source: "yield" },
      ],
    },
  };
  let latest = 2;

  before(async () => {
    mock = createServer((req, res) => {
      const m = /^\/api\/epochs\/(latest|\d+)$/.exec(req.url ?? "");
      const n = m ? (m[1] === "latest" ? latest : Number(m[1])) : NaN;
      const ep = epochs[n];
      res.writeHead(ep ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(ep ?? { error: "not found" }));
    });
    await new Promise<void>((r) => mock.listen(0, r));
    baseUrl = `http://127.0.0.1:${(mock.address() as { port: number }).port}`;
  });
  after(() => mock.close());

  const programId = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const published: { epoch: bigint; root: string; total: bigint }[] = [];
  const funder = { decimals: 6, balance: null as bigint | null };
  const publisher: RootPublisher = {
    programId,
    mint,
    distributor: Keypair.generate().publicKey,
    dryRun: true,
    async distributorState() {
      return null;
    },
    async funder() {
      return funder;
    },
    async setEpochRoot(epoch, root, total): Promise<TxOutcome> {
      published.push({ epoch, root: toHex(root), total });
      return { signature: null, dryRun: true, logs: [], simulationError: null };
    },
  };

  test("writes proofs/<epoch>.json for claimant-bearing epochs and records skips", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "econ-settle-"));
    const store = new SettlementStore(dataDir);
    const settler = new EpochSettler(new GameServer(baseUrl, ""), publisher, store);

    const results = await settler.run();
    assert.deepEqual(results.map((r) => [r.epoch, r.status]), [
      [1, "empty"],
      [2, "published"],
    ]);
    assert.equal(published.length, 1);
    assert.equal(published[0].epoch, 1n); // first dense on-chain epoch

    const file = JSON.parse(readFileSync(join(dataDir, "proofs", "2.json"), "utf8"));
    assert.equal(file.epoch, 2);
    assert.equal(file.chainEpoch, 1);
    assert.equal(file.root, published[0].root);
    assert.equal(file.total, "1750100");
    assert.equal(file.programId, programId.toBase58());
    const [first, second] = [K[0].toBase58(), K[1].toBase58()].sort();
    assert.equal(file.claims[first].index, 0);
    assert.equal(file.claims[second].index, 1);
    assert.equal(file.claims[K[0].toBase58()].amount, "1500100");
    // every served proof verifies against the served root
    for (const [pk, c] of Object.entries<{ index: number; amount: string; proof: string[] }>(file.claims)) {
      const alloc = { index: c.index, claimant: new PublicKey(pk), amount: BigInt(c.amount) };
      assert.ok(verifyProof(1n, alloc, c.proof.map(fromHex), fromHex(file.root)));
    }

    const settled = JSON.parse(readFileSync(join(dataDir, "settled.json"), "utf8"));
    assert.equal(settled.lastEpoch, 2);
    assert.equal(settled.epochs["1"].skipped, "empty");
    assert.equal(settled.epochs["2"].chainEpoch, 1);
    assert.equal(settled.epochs["2"].dryRun, true);

    // idempotent: nothing new on the server → nothing republished
    assert.deepEqual(await settler.run(), []);
    assert.equal(published.length, 1);

    // a new epoch appears; the settler catches up and the chain epoch stays dense
    epochs[3] = { epoch: 3, tickClosed: 72, allocations: [{ playerId: "p2", claimant: K[2].toBase58(), amountEcon: 42, source: "dividend" }] };
    latest = 3;
    const again = await new EpochSettler(new GameServer(baseUrl, ""), publisher, new SettlementStore(dataDir)).run();
    assert.deepEqual(again.map((r) => [r.epoch, r.status]), [[3, "published"]]);
    assert.equal(published[1].epoch, 2n);
    assert.equal(published[1].total, 42n);

    // proofs HTTP API serves the claim for the web claim button
    const http = startProofServer(new SettlementStore(dataDir), 0);
    await new Promise<void>((r) => http.once("listening", r));
    const port = (http.address() as { port: number }).port;
    try {
      const claim = await (await fetch(`http://127.0.0.1:${port}/proofs/2/${K[0].toBase58()}`)).json();
      assert.equal(claim.claimant, K[0].toBase58());
      assert.equal(claim.amount, "1500100");
      assert.equal(claim.chainEpoch, 1);
      assert.ok(Array.isArray(claim.proof));
      assert.equal(claim.claims, undefined);
      assert.equal((await fetch(`http://127.0.0.1:${port}/proofs/latest`)).status, 200);
      assert.equal((await fetch(`http://127.0.0.1:${port}/proofs/2/${Keypair.generate().publicKey.toBase58()}`)).status, 404);
      assert.equal((await fetch(`http://127.0.0.1:${port}/proofs/2/not-a-key`)).status, 400);
      assert.equal((await fetch(`http://127.0.0.1:${port}/proofs/99`)).status, 404);
      const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
      assert.equal(health.lastEpoch, 3);
    } finally {
      http.close();
    }
  });

  test("refuses totals above MAX_EPOCH_TOTAL_ECON, records `blocked` without advancing, retries once raised", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "econ-settle-cap-"));
    const server = new GameServer(baseUrl, "");
    const before = published.length;
    // epoch 2 totals 1_750_100 minor = 1.7501 $ECON at 6 decimals; a 1 $ECON ceiling refuses it
    const capped = new EpochSettler(server, publisher, new SettlementStore(dataDir), { maxEpochTotalEcon: 1 });
    const results = await capped.run();
    assert.deepEqual(results.map((r) => [r.epoch, r.status]), [
      [1, "empty"],
      [2, "blocked"],
    ]);
    assert.match(results[1].reason!, /MAX_EPOCH_TOTAL_ECON/);
    assert.equal(published.length, before);
    assert.equal(existsSync(join(dataDir, "proofs", "2.json")), false);
    let settled = JSON.parse(readFileSync(join(dataDir, "settled.json"), "utf8"));
    assert.equal(settled.lastEpoch, 1);
    assert.deepEqual(settled.epochs["2"], { blocked: "ceiling", total: "1750100", limit: "1000000", at: settled.epochs["2"].at });
    assert.equal(settled.epochs["3"], undefined); // epoch 3 waits behind the blocked one (dense chain counter)

    // every pass retries the blocked epoch and stops there
    assert.deepEqual((await capped.run()).map((r) => [r.epoch, r.status]), [[2, "blocked"]]);
    assert.equal(published.length, before);

    // a raised ceiling (2 $ECON) lets it through and the settler catches up
    const raised = new EpochSettler(server, publisher, new SettlementStore(dataDir), { maxEpochTotalEcon: 2 });
    assert.deepEqual((await raised.run()).map((r) => [r.epoch, r.status]), [
      [2, "published"],
      [3, "published"],
    ]);
    assert.equal(published.length, before + 2);
    settled = JSON.parse(readFileSync(join(dataDir, "settled.json"), "utf8"));
    assert.equal(settled.lastEpoch, 3);
    assert.equal(settled.epochs["2"].chainEpoch, 1);
    assert.equal(settled.epochs["2"].blocked, undefined);
  });

  test("live publisher: refuses totals the funder ATA cannot cover; dry-run only warns", async () => {
    const live: RootPublisher = { ...publisher, dryRun: false };
    const before = published.length;

    funder.balance = null; // ATA missing
    let dataDir = mkdtempSync(join(tmpdir(), "econ-settle-funds-"));
    let results = await new EpochSettler(new GameServer(baseUrl, ""), live, new SettlementStore(dataDir)).run();
    assert.deepEqual(results.map((r) => [r.epoch, r.status]), [
      [1, "empty"],
      [2, "blocked"],
    ]);
    assert.match(results[1].reason!, /funder ATA balance \(0\)/);
    assert.equal(JSON.parse(readFileSync(join(dataDir, "settled.json"), "utf8")).epochs["2"].blocked, "funds");

    funder.balance = 1_750_099n; // one minor short
    results = await new EpochSettler(new GameServer(baseUrl, ""), live, new SettlementStore(dataDir)).run();
    assert.deepEqual(results.map((r) => [r.epoch, r.status, r.reason?.includes("(1750099)")]), [[2, "blocked", true]]);
    assert.equal(published.length, before);

    funder.balance = 1_750_100n; // exactly covered
    results = await new EpochSettler(new GameServer(baseUrl, ""), live, new SettlementStore(dataDir)).run();
    assert.deepEqual(results.map((r) => [r.epoch, r.status]), [
      [2, "published"],
      [3, "published"],
    ]);
    assert.equal(published.length, before + 2);

    // dry-run with no ATA (ephemeral key) still publishes: the simulation is the funding check there
    funder.balance = null;
    dataDir = mkdtempSync(join(tmpdir(), "econ-settle-dry-"));
    results = await new EpochSettler(new GameServer(baseUrl, ""), publisher, new SettlementStore(dataDir)).run();
    assert.deepEqual(results.map((r) => r.status), ["empty", "published", "published"]);
    assert.equal(new SettlementStore(dataDir).blocked().length, 0);
  });
});

describe("config", () => {
  const chainDir = mkdtempSync(join(tmpdir(), "econ-sim-chain-"));
  writeFileSync(
    join(chainDir, "programs.json"),
    JSON.stringify({
      dividends: K[0].toBase58(),
      staking: K[1].toBase58(),
      equity: K[2].toBase58(),
      memecoin_factory: K[0].toBase58(),
    }),
  );

  test("rejects an invalid pubkey naming the offending key", () => {
    assert.throws(
      () => loadConfig({ ECON_MINT: "N0tAPubkey0000000000000000000000000000000000", KEYPAIR: "/nope" }, chainDir),
      (e: unknown) => e instanceof ConfigError && /ECON_MINT/.test((e as Error).message),
    );
    assert.throws(
      () => loadConfig({ PUMP_MINT: "xyz", KEYPAIR: "/nope" }, chainDir),
      (e: unknown) => e instanceof ConfigError && /PUMP_MINT/.test((e as Error).message),
    );
  });

  test("fails fast without programs.json and requires KEYPAIR/ECON_MINT when live", () => {
    assert.throws(() => loadConfig({ KEYPAIR: "/nope" }, mkdtempSync(join(tmpdir(), "empty-"))), /programs\.json/);
    assert.throws(() => loadConfig({ DRY_RUN: "0", KEYPAIR: "/nope" }, chainDir), /KEYPAIR/);
  });

  test("dry-run defaults: devnet, ephemeral key, wSOL mint, program ids from programs.json", () => {
    const cfg = loadConfig({ KEYPAIR: "/nope" }, chainDir);
    assert.equal(cfg.dryRun, true);
    assert.equal(cfg.rpcUrl, "https://api.devnet.solana.com");
    assert.equal(cfg.econMint.toBase58(), "So11111111111111111111111111111111111111112");
    assert.equal(cfg.programs.dividends.toBase58(), K[0].toBase58());
    assert.equal(cfg.port, 8790);
    assert.equal(cfg.maxEpochTotalEcon, DEFAULT_MAX_EPOCH_TOTAL_ECON);
    assert.equal(loadConfig({ KEYPAIR: "/nope", MAX_EPOCH_TOTAL_ECON: "1234" }, chainDir).maxEpochTotalEcon, 1234);
    assert.throws(() => loadConfig({ KEYPAIR: "/nope", MAX_EPOCH_TOTAL_ECON: "-1" }, chainDir), /MAX_EPOCH_TOTAL_ECON/);
  });
});

describe("on-chain stake observer", () => {
  const programId = Keypair.generate().publicKey;
  const econMint = Keypair.generate().publicKey;
  const observer = new StakeObserver({ conn: new Connection("http://127.0.0.1:1"), programId, econMint, idl: loadStakingIdl() });
  const otherPool = Keypair.generate().publicKey;

  const encode = (owner: PublicKey, pool: PublicKey, amount: bigint): Promise<Buffer> =>
    observer.program.coder.accounts.encode("stakePosition", {
      owner,
      pool,
      amount: new BN(amount.toString()),
      weight: new BN(amount.toString()),
      lockUntil: new BN(1_800_000_000),
      boostBps: new BN(0),
      rewardDebt: new BN(0),
      unclaimed: new BN(0),
      bump: 255,
    });

  test("pool PDA + pool memcmp offset match the program layout", async () => {
    assert.ok(observer.pool.equals(stakePoolPda(programId, econMint)));
    assert.ok(observer.pool.equals(PublicKey.findProgramAddressSync([Buffer.from("pool"), econMint.toBuffer()], programId)[0]));
    const bytes = await encode(K[0], observer.pool, 5n);
    assert.ok(observer.pool.equals(new PublicKey(bytes.subarray(POSITION_POOL_OFFSET, POSITION_POOL_OFFSET + 32))));
    assert.equal(observer.program.coder.accounts.memcmp("stakePosition").offset, 0);
  });

  test("fetchPositions sends single-key memcmp filters (Agave rejects the bare {offset, bytes} anchor returns)", async () => {
    let sent: Record<string, unknown>[] = [];
    // Only getProgramAccounts is exercised; nothing else on Connection is touched by fetchPositions.
    const conn = {
      getProgramAccounts: async (_id: PublicKey, cfg: { filters: Record<string, unknown>[] }) => {
        sent = cfg.filters;
        return [];
      },
    } as unknown as Connection;
    const stub = new StakeObserver({ conn, programId, econMint, idl: loadStakingIdl() });
    assert.deepEqual(await stub.fetchPositions(), []);
    assert.deepEqual(sent, [
      { memcmp: { offset: 0, bytes: stub.program.coder.accounts.memcmp("stakePosition").bytes } },
      { memcmp: { offset: POSITION_POOL_OFFSET, bytes: stub.pool.toBase58() } },
    ]);
  });

  test("decodes IDL-encoded positions and sums principal per owner for the $ECON pool only", async () => {
    const positions = [
      await encode(K[0], observer.pool, 1_000_000n),
      await encode(K[1], observer.pool, 2_500_000n),
      await encode(K[0], otherPool, 9_000_000n), // another pool: ignored
      await encode(K[2], observer.pool, 0n), // unstaked, not yet reaped: ignored
    ].map((b) => observer.decode(b));
    assert.equal(positions[0].amount, 1_000_000n);
    assert.ok(positions[2].pool.equals(otherPool));
    const stakes = aggregateStakes(positions, observer.pool);
    const expected: Record<string, number> = {};
    for (const [k, v] of [[K[0].toBase58(), 1_000_000], [K[1].toBase58(), 2_500_000]] as const) expected[k] = v;
    assert.deepEqual(stakes, expected);
    assert.deepEqual(Object.keys(stakes), [K[0].toBase58(), K[1].toBase58()].sort());
    assert.throws(() => observer.decode(Buffer.alloc(137)), /discriminator/i);
    assert.throws(() => aggregateStakes([{ owner: K[0], pool: observer.pool, amount: 2n ** 53n }], observer.pool), RangeError);
  });
});

describe("rolling median", () => {
  test("median of odd/even lists", () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(median([7]), 7);
    assert.throws(() => median([]), RangeError);
  });

  test("a short spike cannot move the published price; a sustained move can", () => {
    const m = new RollingMedian(12);
    assert.equal(m.value, null);
    for (let i = 0; i < 12; i++) m.push(0.05);
    assert.equal(m.push(0.001), 0.05); // one manipulated poll
    for (let i = 0; i < 4; i++) m.push(0.001);
    assert.equal(m.value, 0.05); // 5 of 12 still lose
    m.push(0.001);
    assert.equal(m.value, (0.05 + 0.001) / 2); // 6 of 12: midpoint
    m.push(0.001);
    assert.equal(m.value, 0.001); // majority of the window agrees → follows
    assert.equal(m.size, 12);
    m.push(NaN);
    m.push(-1);
    m.push(0);
    assert.equal(m.size, 12); // junk samples ignored
    assert.throws(() => new RollingMedian(0), RangeError);
  });
});

describe("pump.fun", () => {
  test("collect_creator_fee_v2 instruction matches the IDL account layout", () => {
    const creator = K[1];
    const ix = buildCollectCreatorFeeIx(creator);
    assert.equal(ix.programId.toBase58(), "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
    assert.deepEqual(Array.from(ix.data), [207, 17, 138, 242, 4, 34, 19, 56]);
    assert.equal(ix.keys.length, 10);
    assert.ok(ix.keys[0].pubkey.equals(creator) && ix.keys[0].isWritable && !ix.keys[0].isSigner);
    assert.ok(ix.keys[2].pubkey.equals(creatorVaultPda(creator)) && ix.keys[2].isWritable);
    assert.equal(ix.keys[4].pubkey.toBase58(), "So11111111111111111111111111111111111111112");
    assert.equal(ix.keys[9].pubkey.toBase58(), "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
  });

  test("simulates against a live mainnet creator vault (NET=1, PUMP_TEST_MINT)", { skip: process.env.NET !== "1" || !process.env.PUMP_TEST_MINT }, async () => {
    // Any SOL-paired pump.fun coin works as long as its creator is funded enough to act as the fee payer.
    const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
    const creator = await bondingCurveCreator(conn, new PublicKey(process.env.PUMP_TEST_MINT!));
    if (!creator) throw new Error("bonding curve not found");
    const vault = creatorVaultPda(creator);
    const tx = new Transaction().add(buildCollectCreatorFeeIx(creator));
    tx.feePayer = creator;
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    const pre = (await conn.getAccountInfo(vault))?.lamports ?? 0;
    const sim = await conn.simulateTransaction(tx, undefined, [vault]);
    assert.equal(sim.value.err, null, (sim.value.logs ?? []).join("\n"));
    assert.ok(sim.value.logs?.some((l) => /Instruction: CollectCreatorFeeV2/.test(l)));
    const post = sim.value.accounts?.[0]?.lamports;
    assert.equal(post, Math.min(pre, PUMP_VAULT_RESERVE_LAMPORTS));
  });

  test("fee inflow formula: SOL → USD → $ECON minor per tick", () => {
    // 1 SOL over 10 ticks at SOL=$100 and ECON=$0.05 (6 decimals): $100 / 0.05 = 2000 ECON = 2e9 minor → 2e8 per tick
    assert.equal(
      feeInflowEconMinorPerTick({ lamports: 1e9, solUsd: 100, econUsd: 0.05, econDecimals: 6, ticksElapsed: 10 }),
      200_000_000,
    );
    assert.equal(feeInflowEconMinorPerTick({ lamports: 0, solUsd: 100, econUsd: 0.05, econDecimals: 6, ticksElapsed: 10 }), 0);
    assert.equal(feeInflowEconMinorPerTick({ lamports: 1e9, solUsd: 100, econUsd: 0.05, econDecimals: 6, ticksElapsed: 0 }), 0);
  });
});

describe("rwa feeds", () => {
  test("feed table covers the sim tickers + SOL with 32-byte ids", () => {
    assert.deepEqual(Object.keys(RWA_FEEDS), ["AAPL", "TSLA", "NVDA", "MSFT", "SPY", "SOL"]);
    for (const f of Object.values(RWA_FEEDS)) {
      assert.match(f.pythId, /^[0-9a-f]{64}$/);
      new PublicKey(f.jupMint);
    }
  });

  test("pyth feed ids resolve to the expected instruments (NET=1)", { skip: process.env.NET !== "1" }, async () => {
    assert.deepEqual(await verifyFeedIds("https://hermes.pyth.network"), []);
  });

  test("live quotes arrive for every symbol (NET=1)", { skip: process.env.NET !== "1" }, async () => {
    const feed = new RwaFeed({
      hermesUrl: "https://hermes.pyth.network",
      apiKey: process.env.PYTH_API_KEY ?? null,
      jupUrl: "https://lite-api.jup.ag/price/v3",
    });
    const quotes = await feed.refresh();
    assert.equal(quotes.length, 6);
    for (const q of quotes) assert.ok(q.priceUsd > 0, q.symbol);
  });
});
