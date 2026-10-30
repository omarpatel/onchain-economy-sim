import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { JoinError } from "@econ-sim/sim/engine";
import type { PlayerView } from "@econ-sim/sim/protocol";
import { cleanName } from "@econ-sim/sim/text";
import { Auth, AuthError } from "./auth.ts";
import { SlidingWindow } from "./ratelimit.ts";
import type { World } from "./world.ts";

const MAX_BODY = 64 * 1024;
/** Default `/auth/*` calls allowed per client IP per minute. */
export const AUTH_RATE_LIMIT = 10;
const AUTH_RATE_WINDOW_MS = 60_000;
/** Distinct staking positions accepted in one `/admin/onchain-stakes` body. */
const MAX_STAKE_ROWS = 50_000;

export interface HttpOptions {
  corsOrigin: string;
  adminToken: string | null;
  clients: () => number;
  /** Per-IP `/auth/*` budget per minute; defaults to `AUTH_RATE_LIMIT`. */
  authRateLimit?: number;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) {
      req.destroy();
      throw new HttpError(413, "body too large");
    }
    chunks.push(c);
  }
  if (size === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "body must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "body must be a JSON object");
  return { ...parsed };
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  return h && h.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

/** Constant-time bearer check: both sides are hashed so lengths never leak. */
function tokenMatches(presented: string | null, expected: string): boolean {
  if (presented === null) return false;
  return timingSafeEqual(createHash("sha256").update(presented).digest(), createHash("sha256").update(expected).digest());
}

/** HTTP API: health/economy/me/epochs/events, SIWS + guest auth, admin hooks. */
export function createHttpServer(world: World, auth: Auth, opts: HttpOptions): Server {
  const sendJson = (res: ServerResponse, status: number, json: string, extra: Record<string, string> = {}): void => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra });
    res.end(json);
  };
  const ok = (res: ServerResponse, body: unknown): void => sendJson(res, 200, JSON.stringify(body));
  const authRateLimit = opts.authRateLimit ?? AUTH_RATE_LIMIT;
  const authLimiter = new SlidingWindow(authRateLimit, AUTH_RATE_WINDOW_MS);
  const requireSession = (req: IncomingMessage): string => {
    const s = auth.session(bearer(req));
    if (!s) throw new HttpError(401, "missing or expired session");
    return s.playerId;
  };
  const requireAdmin = (req: IncomingMessage): void => {
    if (!opts.adminToken || !tokenMatches(bearer(req), opts.adminToken)) throw new HttpError(401, "admin token required");
  };
  let authCalls = 0;
  const limitAuth = (req: IncomingMessage): void => {
    if (++authCalls % 256 === 0) authLimiter.prune();
    if (!authLimiter.hit(req.socket.remoteAddress ?? "unknown")) throw new HttpError(429, `rate limit: ${authRateLimit} auth requests per minute`);
  };
  const playerName = (playerId: string): string => world.persist.getPlayer(playerId)?.name ?? playerId;
  const joinOrFull = (playerId: string): PlayerView => {
    try {
      return world.join(playerId, playerName(playerId));
    } catch (err) {
      if (err instanceof JoinError) throw new HttpError(503, `world is full (${err.code})`);
      throw err;
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (method === "GET" && path === "/api/health") {
      return ok(res, { ok: true, ...world.stats(), clients: opts.clients(), tickMs: world.tickMs });
    }
    if (method === "GET" && path === "/api/economy") {
      const etag = `"t${world.head}"`;
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { etag });
        res.end();
        return;
      }
      return sendJson(res, 200, world.snapshotJson, { etag });
    }
    if (method === "GET" && path === "/api/me") {
      const playerId = requireSession(req);
      return ok(res, joinOrFull(playerId));
    }
    if (method === "GET" && path === "/api/epochs/latest") {
      const e = world.persist.latestEpoch();
      if (!e) throw new HttpError(404, "no epoch closed yet");
      return ok(res, e);
    }
    const epochMatch = method === "GET" ? /^\/api\/epochs\/(\d+)$/.exec(path) : null;
    if (epochMatch) {
      const e = world.persist.getEpoch(Number(epochMatch[1]));
      if (!e) throw new HttpError(404, "unknown epoch");
      return ok(res, e);
    }
    if (method === "GET" && path === "/api/events") {
      const since = Number(url.searchParams.get("since") ?? 0);
      if (!Number.isFinite(since) || since < 0) throw new HttpError(400, "since must be a non-negative tick");
      return ok(res, { tick: world.head, events: world.eventsSince(since) });
    }

    if (method === "GET" && path === "/auth/nonce") {
      limitAuth(req);
      return ok(res, { nonce: auth.nonce() });
    }
    if (method === "POST" && path === "/auth/siws") {
      limitAuth(req);
      return ok(res, auth.siws(await readJson(req)));
    }
    if (method === "POST" && path === "/auth/guest") {
      limitAuth(req);
      return ok(res, auth.guest(await readJson(req)));
    }
    if (method === "POST" && path === "/auth/name") {
      const playerId = requireSession(req);
      const body = await readJson(req);
      if (typeof body.name !== "string") throw new HttpError(400, "name is required");
      const name = cleanName(body.name);
      if (!name) throw new HttpError(400, "name is empty");
      world.persist.renamePlayer(playerId, name);
      world.rename(playerId, name);
      return ok(res, { playerId, name });
    }

    if (method === "POST" && path === "/admin/oracle") {
      requireAdmin(req);
      const body = await readJson(req);
      const quotesRaw = body.quotes;
      if (!quotesRaw || typeof quotesRaw !== "object") throw new HttpError(400, "quotes must be an object of SYM → usd");
      const quotes: Record<string, number> = {};
      for (const [sym, usd] of Object.entries(quotesRaw)) {
        if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) throw new HttpError(400, `quote ${sym} must be a positive number`);
        quotes[sym] = usd;
      }
      const econUsd = body.econUsd;
      if (econUsd !== undefined && (typeof econUsd !== "number" || !Number.isFinite(econUsd) || econUsd <= 0)) {
        throw new HttpError(400, "econUsd must be a positive number");
      }
      world.setQuotesUsd(quotes, econUsd);
      return ok(res, { ok: true, quotes, econUsd: econUsd ?? null });
    }
    if (method === "POST" && path === "/admin/creator-fees") {
      requireAdmin(req);
      const body = await readJson(req);
      const v = body.econMinorPerTick;
      if (v !== null && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) {
        throw new HttpError(400, "econMinorPerTick must be a non-negative number or null");
      }
      world.setExternalCreatorFees(v);
      return ok(res, { ok: true, econMinorPerTick: v });
    }
    if (method === "POST" && path === "/admin/onchain-stakes") {
      requireAdmin(req);
      const body = await readJson(req);
      const raw = body.stakes;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "stakes must be an object of pubkey → $ECON minor");
      const asOfSlot = body.asOfSlot;
      if (typeof asOfSlot !== "number" || !Number.isInteger(asOfSlot) || asOfSlot < 0) throw new HttpError(400, "asOfSlot must be a non-negative integer");
      if (asOfSlot < world.state.stakesAsOfSlot) throw new HttpError(409, `stale: have slot ${world.state.stakesAsOfSlot}`);
      const entries = Object.entries(raw);
      if (entries.length > MAX_STAKE_ROWS) throw new HttpError(400, `at most ${MAX_STAKE_ROWS} stakes per update`);
      const stakes: Record<string, number> = {};
      for (const [pubkey, amount] of entries) {
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pubkey)) throw new HttpError(400, `stake key ${pubkey.slice(0, 44)} is not a base58 pubkey`);
        if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 0) throw new HttpError(400, `stake ${pubkey} must be a non-negative integer`);
        if (amount > 0) stakes[pubkey] = amount;
      }
      world.setOnchainStakes(stakes, asOfSlot);
      return ok(res, { ok: true, stakers: Object.keys(stakes).length, asOfSlot });
    }
    if (method === "POST" && path === "/admin/snapshot") {
      requireAdmin(req);
      return ok(res, { ok: true, tick: world.saveSnapshot() });
    }
    throw new HttpError(404, "not found");
  };

  return createServer((req, res) => {
    res.setHeader("access-control-allow-origin", opts.corsOrigin);
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    res.setHeader("access-control-allow-headers", "authorization, content-type, if-none-match");
    res.setHeader("access-control-expose-headers", "etag");
    res.setHeader("vary", "origin");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    handle(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError || err instanceof AuthError ? err.status : 500;
      const message = err instanceof Error ? err.message : String(err);
      if (status === 500) console.error(`[http] ${req.method} ${req.url}:`, err);
      sendJson(res, status, JSON.stringify({ error: message }));
    });
  });
}
