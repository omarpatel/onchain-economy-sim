import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { JoinError } from "@econ-sim/sim/engine";
import type { Intent, IntentKind, IntentResult, PlayerView } from "@econ-sim/sim/protocol";
import type { Auth } from "./auth.ts";
import { SlidingWindow } from "./ratelimit.ts";
import type { TickInfo, World } from "./world.ts";

const AUTH_TIMEOUT_MS = 5000;
const HEARTBEAT_MS = 30_000;
const RATE_LIMIT_PER_SEC = 20;
/** Concurrent authenticated sockets allowed per player. */
export const MAX_SOCKETS_PER_PLAYER = 2;
const MAX_STR = 64;
const MAX_MESSAGE_BYTES = 16 * 1024;

interface Client {
  ws: WebSocket;
  playerId: string | null;
  alive: boolean;
}

// ───────────────────────── intent shape validation ─────────────────────────

type Shape = Record<string, "str" | "pos" | "int" | "num01" | "bool" | "side" | "mode">;

const SHAPES: Record<IntentKind, Shape> = {
  build: { buildingType: "str", x: "int", y: "int" },
  demolish: { buildingId: "str" },
  buy_land: { x: "int", y: "int" },
  buy_good: { good: "str", qty: "pos" },
  sell_good: { good: "str", qty: "pos" },
  set_sell_policy: { good: "str", mode: "mode" },
  buy_truck: {},
  borrow: { amountCr: "pos" },
  repay: { amountCr: "pos" },
  ipo: { sharesTotal: "pos", floatPct: "pos" },
  set_dividend_policy: { payoutRatio: "num01" },
  place_order: { companyId: "str", side: "side", priceCr: "pos", qty: "pos" },
  cancel_orders: { companyId: "str" },
  stake: { amountEcon: "pos" },
  unstake: { amountEcon: "pos" },
  buy_rwa: { symbol: "str", qty: "pos" },
  sell_rwa: { symbol: "str", qty: "pos" },
  set_autopilot: { enabled: "bool" },
  rename_company: { name: "str" },
};

function fieldError(key: string, rule: Shape[string], v: unknown): string | null {
  switch (rule) {
    case "str":
      return typeof v === "string" && v.length > 0 && v.length <= MAX_STR ? null : `${key} must be a string of 1..${MAX_STR} chars`;
    case "pos":
      return typeof v === "number" && Number.isFinite(v) && v > 0 ? null : `${key} must be a finite number > 0`;
    case "int":
      return typeof v === "number" && Number.isInteger(v) && v >= 0 ? null : `${key} must be a non-negative integer`;
    case "num01":
      return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? null : `${key} must be a number in 0..1`;
    case "bool":
      return typeof v === "boolean" ? null : `${key} must be a boolean`;
    case "side":
      return v === "bid" || v === "ask" ? null : `${key} must be "bid" or "ask"`;
    case "mode":
      return v === "auto" || v === "hold" ? null : `${key} must be "auto" or "hold"`;
  }
}

/** Shape-level validation only (the sim validates semantics). Returns the intent or an error string. */
export function validateIntent(raw: unknown): { intent: Intent } | { error: string } {
  if (!raw || typeof raw !== "object" || !("kind" in raw) || typeof raw.kind !== "string") return { error: "intent.kind is required" };
  if (!Object.hasOwn(SHAPES, raw.kind)) return { error: `unknown intent kind "${raw.kind.slice(0, MAX_STR)}"` };
  const kind: IntentKind = raw.kind as IntentKind; // narrowed by hasOwn on the exhaustive SHAPES table
  const shape = SHAPES[kind];
  const src: Record<string, unknown> = { ...raw };
  const intent: Record<string, unknown> = { kind };
  for (const key of Object.keys(shape)) {
    const err = fieldError(key, shape[key], src[key]);
    if (err) return { error: err };
    intent[key] = src[key];
  }
  return { intent: intent as unknown as Intent }; // every field of the kind's shape was checked above
}

function parseClientMessage(data: string): { type: string; id?: unknown; token?: unknown; intent?: unknown; t?: unknown } | null {
  let msg: unknown;
  try {
    msg = JSON.parse(data);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== "object" || !("type" in msg) || typeof msg.type !== "string") return null;
  return msg as { type: string; id?: unknown; token?: unknown; intent?: unknown; t?: unknown }; // optional fields re-checked per type
}

// ───────────────────────── hub ─────────────────────────

/** WebSocket hub at `/ws`: auth handshake, per-tick fan-out, intent intake. */
export class WsHub {
  private wss: WebSocketServer;
  private clients = new Set<Client>();
  private byPlayer = new Map<string, Set<Client>>();
  private intentLimiter = new SlidingWindow(RATE_LIMIT_PER_SEC, 1000); // keyed by playerId, shared across their sockets
  private world: World;
  private auth: Auth;
  private log: (line: string) => void;
  private heartbeat: NodeJS.Timeout;

  constructor(world: World, auth: Auth, log: (line: string) => void = () => {}) {
    this.world = world;
    this.auth = auth;
    this.log = log;
    this.wss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: { threshold: 1024 },
      maxPayload: MAX_MESSAGE_BYTES,
    });
    this.wss.on("connection", (ws) => this.onConnection(ws));
    this.heartbeat = setInterval(() => this.sweep(), HEARTBEAT_MS);
    world.onTick((info) => this.broadcast(info));
  }

  attach(server: Server): void {
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (path !== "/ws") {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit("connection", ws, req));
    });
  }

  get size(): number {
    return this.clients.size;
  }

  get authed(): number {
    let n = 0;
    for (const c of this.clients) if (c.playerId) n++;
    return n;
  }

  /** Open sockets currently authenticated as `playerId`. */
  socketsOf(playerId: string): number {
    return this.byPlayer.get(playerId)?.size ?? 0;
  }

  private onConnection(ws: WebSocket): void {
    const client: Client = { ws, playerId: null, alive: true };
    this.clients.add(client);
    const authTimer = setTimeout(() => {
      if (!client.playerId) ws.close(4001, "auth timeout");
    }, AUTH_TIMEOUT_MS);
    ws.on("pong", () => {
      client.alive = true;
    });
    ws.on("message", (data) => {
      try {
        this.onMessage(client, data.toString());
      } catch (err) {
        this.log(`ws: message from ${client.playerId ?? "unauthenticated"} failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
        this.send(ws, JSON.stringify({ type: "error", message: "internal error" }));
      }
    });
    ws.on("close", () => {
      clearTimeout(authTimer);
      this.clients.delete(client);
      if (client.playerId) {
        const set = this.byPlayer.get(client.playerId);
        set?.delete(client);
        if (set && set.size === 0) this.byPlayer.delete(client.playerId);
      }
    });
    ws.on("error", () => ws.terminate());
  }

  private send(ws: WebSocket, json: string): void {
    if (ws.readyState === ws.OPEN) ws.send(json);
  }

  private onMessage(client: Client, data: string): void {
    const msg = parseClientMessage(data);
    if (!msg) {
      this.send(client.ws, JSON.stringify({ type: "error", message: "malformed message" }));
      return;
    }
    if (msg.type === "ping") {
      this.send(client.ws, JSON.stringify({ type: "pong", t: typeof msg.t === "number" ? msg.t : Date.now() }));
      return;
    }
    if (!client.playerId) {
      if (msg.type !== "auth" || typeof msg.token !== "string") {
        client.ws.close(4001, "first message must be auth");
        return;
      }
      const session = this.auth.session(msg.token);
      if (!session) {
        client.ws.close(4003, "invalid session");
        return;
      }
      if (this.socketsOf(session.playerId) >= MAX_SOCKETS_PER_PLAYER) {
        client.ws.close(4008, `max ${MAX_SOCKETS_PER_PLAYER} connections per player`);
        return;
      }
      const player = this.world.persist.getPlayer(session.playerId);
      let you: PlayerView;
      try {
        you = this.world.join(session.playerId, player?.name ?? session.playerId);
      } catch (err) {
        if (!(err instanceof JoinError)) throw err;
        client.ws.close(4013, `world is full (${err.code})`);
        return;
      }
      client.playerId = session.playerId;
      let set = this.byPlayer.get(session.playerId);
      if (!set) this.byPlayer.set(session.playerId, (set = new Set()));
      set.add(client);
      const w = this.world;
      this.send(
        client.ws,
        `{"type":"hello","playerId":${JSON.stringify(session.playerId)},"tick":${w.head},"ticksPerDay":${w.ticksPerDay},"tickMs":${w.tickMs},"snapshot":${w.snapshotJson},"you":${JSON.stringify(you)}}`,
      );
      return;
    }
    if (msg.type === "auth") return; // already authenticated; ignore
    if (msg.type !== "intent") {
      this.send(client.ws, JSON.stringify({ type: "error", message: `unknown message type "${msg.type.slice(0, MAX_STR)}"` }));
      return;
    }
    const id = typeof msg.id === "string" && msg.id.length > 0 && msg.id.length <= MAX_STR ? msg.id : null;
    const reject = (error: string): void => {
      const result: IntentResult = { id: id ?? "", ok: false, tick: this.world.head, error };
      this.send(client.ws, JSON.stringify({ type: "result", result }));
    };
    if (id === null) return reject("intent id must be a string of 1..64 chars");
    if (!this.intentLimiter.hit(client.playerId)) return reject(`rate limit: max ${RATE_LIMIT_PER_SEC} intents/s`);
    const v = validateIntent(msg.intent);
    if ("error" in v) return reject(v.error);
    this.world.queue({ id, playerId: client.playerId, intent: v.intent });
  }

  /** One shared snapshot/events string per tick; `you` + `results` are serialized once per player. */
  private broadcast(info: TickInfo): void {
    if (this.byPlayer.size === 0) return;
    const eventsJson = JSON.stringify(info.events);
    const prefix = `{"type":"tick","tick":${info.tick},"snapshot":${info.snapshotJson},"events":${eventsJson},"you":`;
    const none = "[]";
    for (const [playerId, sockets] of this.byPlayer) {
      const results = info.resultsByPlayer.get(playerId);
      const frame = `${prefix}${JSON.stringify(this.world.playerView(playerId))},"results":${results ? JSON.stringify(results) : none}}`;
      for (const c of sockets) if (c.ws.readyState === c.ws.OPEN) c.ws.send(frame);
    }
  }

  private sweep(): void {
    this.intentLimiter.prune();
    for (const c of this.clients) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const c of this.clients) c.ws.close(1001, "server shutting down");
    this.wss.close();
  }
}
