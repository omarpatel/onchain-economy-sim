import { resolve } from "node:path";
import { Auth } from "./auth.ts";
import { createHttpServer } from "./http.ts";
import { World } from "./world.ts";
import { WsHub } from "./ws.ts";

const env = process.env;
const int = (key: string, dflt: number): number => {
  const v = Number(env[key]);
  return env[key] !== undefined && Number.isFinite(v) ? v : dflt;
};

const PORT = int("PORT", 8787);
const TICK_MS = int("TICK_MS", 1000);
const DATA_DIR = resolve(env.DATA_DIR ?? "./data");
const SEED = env.SEED !== undefined ? int("SEED", 0) : undefined;
const NPCS = int("NPCS", 24);
const INVESTORS = int("INVESTORS", 8);
const WARMUP_TICKS = int("WARMUP_TICKS", 48);
const ALLOW_GUEST = (env.ALLOW_GUEST ?? "1") === "1";
const ADMIN_TOKEN = env.ADMIN_TOKEN || null;
const CORS_ORIGIN = env.CORS_ORIGIN ?? "http://localhost:3000";
const DOMAIN = env.DOMAIN ?? "localhost";
const AUTH_RATE_LIMIT = int("AUTH_RATE_LIMIT", 10);

const log = (line: string): void => console.log(`[server ${new Date().toISOString()}] ${line}`);

const world = World.boot({ dataDir: DATA_DIR, seed: SEED, npcs: NPCS, investors: INVESTORS, tickMs: TICK_MS, warmupTicks: WARMUP_TICKS, log });
const auth = new Auth(world.persist, { domain: DOMAIN, allowGuest: ALLOW_GUEST });
const hub = new WsHub(world, auth, log);
const http = createHttpServer(world, auth, { corsOrigin: CORS_ORIGIN, adminToken: ADMIN_TOKEN, clients: () => hub.authed, authRateLimit: AUTH_RATE_LIMIT });
hub.attach(http);

http.listen(PORT, () => {
  log(`listening on http://localhost:${PORT} (ws://localhost:${PORT}/ws) tick=${TICK_MS}ms data=${DATA_DIR} guest=${ALLOW_GUEST} admin=${ADMIN_TOKEN ? "on" : "off"} siws-domain=${DOMAIN}`);
  world.start(() => hub.authed);
});

let shuttingDown = false;
const shutdown = (signal: string): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal}: stopping loop, snapshotting @${world.head}`);
  hub.close();
  http.close();
  world.close();
  log("closed");
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
