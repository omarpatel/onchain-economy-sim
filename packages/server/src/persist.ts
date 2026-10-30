import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { EpochAllocation, IntentEnvelope, IntentResult } from "@econ-sim/sim/protocol";

/**
 * Durable state (SQLite, WAL). Two layers:
 *   - `snapshots`: full `Game.toJSON()` every epoch (last 3 kept), paired with
 *     `server_state` (oracle ring, on-chain stakes) at the same tick
 *   - journal (table `intents`): every state-mutating call made between
 *     ticks, tagged with the head tick it was made at, so boot = latest
 *     snapshot + replay of journal rows with tick >= snapshot tick.
 */
export type JournalEntry =
  | { t: "intent"; env: IntentEnvelope }
  | { t: "join"; playerId: string; name: string }
  | { t: "rename"; playerId: string; name: string }
  | { t: "oracle"; quotes: Record<string, number>; econUsd?: number }
  | { t: "fees"; econMinorPerTick: number | null }
  | { t: "stakes"; stakes: Record<string, number>; asOfSlot: number };

export interface PlayerRow {
  playerId: string;
  pubkey: string | null;
  name: string;
  createdAt: number;
}

export interface SessionRow {
  token: string;
  playerId: string;
  createdAt: number;
  expiresAt: number;
}

const RESULTS_KEEP = 10_000;
const SNAPSHOTS_KEEP = 3;

type Row = Record<string, SQLOutputValue>;

function str(row: Row, key: string): string {
  const v = row[key];
  if (typeof v !== "string") throw new Error(`sqlite: column ${key} is not text`);
  return v;
}

function num(row: Row, key: string): number {
  const v = row[key];
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  throw new Error(`sqlite: column ${key} is not numeric`);
}

export class Persist {
  private db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS snapshots (tick INTEGER PRIMARY KEY, seq INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS intents (
        tick INTEGER NOT NULL, seq INTEGER NOT NULL, player_id TEXT, json TEXT NOT NULL,
        PRIMARY KEY (tick, seq)
      );
      CREATE TABLE IF NOT EXISTS players (
        player_id TEXT PRIMARY KEY, pubkey TEXT UNIQUE, name TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY, player_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS epochs (epoch INTEGER PRIMARY KEY, tick_closed INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS results (tick INTEGER NOT NULL, intent_id TEXT NOT NULL, ok INTEGER NOT NULL, error TEXT);
      CREATE INDEX IF NOT EXISTS results_tick ON results (tick);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS server_state (tick INTEGER PRIMARY KEY, json TEXT NOT NULL);
    `);
  }

  private get(sql: string, ...params: (string | number | null)[]): Row | undefined {
    return this.db.prepare(sql).get(...params);
  }

  private all(sql: string, ...params: (string | number | null)[]): Row[] {
    return this.db.prepare(sql).all(...params);
  }

  // ── snapshots ──

  /** `seq` = journal entries made at `tick` that are already baked into the snapshot (mid-tick forced snapshots).
   *  `serverJson` is the server-side state (oracle ring, on-chain stakes) as of the same point. */
  saveSnapshot(tick: number, seq: number, json: string, serverJson: string): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT OR REPLACE INTO snapshots (tick, seq, json) VALUES (?, ?, ?)").run(tick, seq, json);
      this.db.prepare("INSERT OR REPLACE INTO server_state (tick, json) VALUES (?, ?)").run(tick, serverJson);
      this.db
        .prepare("DELETE FROM snapshots WHERE tick NOT IN (SELECT tick FROM snapshots ORDER BY tick DESC LIMIT ?)")
        .run(SNAPSHOTS_KEEP);
      this.db.prepare("DELETE FROM server_state WHERE tick NOT IN (SELECT tick FROM snapshots)").run();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** `serverJson` is null for snapshots written before `server_state` existed. */
  latestSnapshot(): { tick: number; seq: number; json: string; serverJson: string | null } | null {
    const row = this.get(
      "SELECT s.tick AS tick, s.seq AS seq, s.json AS json, x.json AS server_json FROM snapshots s LEFT JOIN server_state x ON x.tick = s.tick ORDER BY s.tick DESC LIMIT 1",
    );
    if (!row) return null;
    const serverJson = row.server_json;
    return { tick: num(row, "tick"), seq: num(row, "seq"), json: str(row, "json"), serverJson: typeof serverJson === "string" ? serverJson : null };
  }

  // ── journal / head ──

  /** Head tick = the next tick to simulate; persisted with every tick's journal. */
  head(): number | null {
    const row = this.get("SELECT value FROM meta WHERE key = 'head'");
    return row ? Number(str(row, "value")) : null;
  }

  /** Atomically persist everything that happened at head tick `tick`
   *  (journal rows in arrival order, the results the sim produced) and
   *  advance the persisted head to `tick + 1`. */
  commitTick(tick: number, entries: JournalEntry[], results: IntentResult[]): void {
    const insJ = this.db.prepare("INSERT INTO intents (tick, seq, player_id, json) VALUES (?, ?, ?, ?)");
    const insR = this.db.prepare("INSERT INTO results (tick, intent_id, ok, error) VALUES (?, ?, ?, ?)");
    const setHead = this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('head', ?)");
    this.db.exec("BEGIN");
    try {
      entries.forEach((e, seq) => {
        const playerId = e.t === "intent" ? e.env.playerId : e.t === "join" || e.t === "rename" ? e.playerId : null;
        insJ.run(tick, seq, playerId, JSON.stringify(e));
      });
      for (const r of results) insR.run(r.tick, r.id, r.ok ? 1 : 0, r.error ?? null);
      setHead.run(String(tick + 1));
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Journal rows at or after `tick`, skipping the first `seq` rows of `tick` itself. */
  journalFrom(tick: number, seq = 0): { tick: number; entry: JournalEntry }[] {
    return this.all("SELECT tick, json FROM intents WHERE tick > ? OR (tick = ? AND seq >= ?) ORDER BY tick, seq", tick, tick, seq).map((r) => {
      const entry: JournalEntry = JSON.parse(str(r, "json"));
      return { tick: num(r, "tick"), entry };
    });
  }

  trimResults(): void {
    this.db
      .prepare("DELETE FROM results WHERE rowid NOT IN (SELECT rowid FROM results ORDER BY rowid DESC LIMIT ?)")
      .run(RESULTS_KEEP);
  }

  // ── players / sessions ──

  private toPlayer(r: Row): PlayerRow {
    const pubkey = r.pubkey;
    return {
      playerId: str(r, "player_id"),
      pubkey: typeof pubkey === "string" ? pubkey : null,
      name: str(r, "name"),
      createdAt: num(r, "created_at"),
    };
  }

  getPlayer(playerId: string): PlayerRow | null {
    const r = this.get("SELECT player_id, pubkey, name, created_at FROM players WHERE player_id = ?", playerId);
    return r ? this.toPlayer(r) : null;
  }

  /** Insert if missing; returns the stored row (existing name wins). */
  upsertPlayer(playerId: string, pubkey: string | null, name: string): PlayerRow {
    const existing = this.getPlayer(playerId);
    if (existing) return existing;
    const createdAt = Date.now();
    this.db
      .prepare("INSERT INTO players (player_id, pubkey, name, created_at) VALUES (?, ?, ?, ?)")
      .run(playerId, pubkey, name, createdAt);
    return { playerId, pubkey, name, createdAt };
  }

  renamePlayer(playerId: string, name: string): void {
    this.db.prepare("UPDATE players SET name = ? WHERE player_id = ?").run(name, playerId);
  }

  /** playerId → pubkey for every wallet-backed player (epoch claimants). */
  pubkeys(): Map<string, string> {
    const out = new Map<string, string>();
    for (const r of this.all("SELECT player_id, pubkey FROM players WHERE pubkey IS NOT NULL")) {
      out.set(str(r, "player_id"), str(r, "pubkey"));
    }
    return out;
  }

  playerCount(): number {
    const r = this.get("SELECT COUNT(*) AS n FROM players");
    return r ? num(r, "n") : 0;
  }

  createSession(token: string, playerId: string, ttlMs: number): SessionRow {
    const createdAt = Date.now();
    const expiresAt = createdAt + ttlMs;
    this.db
      .prepare("INSERT INTO sessions (token, player_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(token, playerId, createdAt, expiresAt);
    return { token, playerId, createdAt, expiresAt };
  }

  getSession(token: string): SessionRow | null {
    const r = this.get(
      "SELECT token, player_id, created_at, expires_at FROM sessions WHERE token = ? AND expires_at > ?",
      token,
      Date.now(),
    );
    if (!r) return null;
    return { token: str(r, "token"), playerId: str(r, "player_id"), createdAt: num(r, "created_at"), expiresAt: num(r, "expires_at") };
  }

  // ── epochs ──

  saveEpoch(alloc: EpochAllocation): void {
    this.db
      .prepare("INSERT OR REPLACE INTO epochs (epoch, tick_closed, json) VALUES (?, ?, ?)")
      .run(alloc.epoch, alloc.tickClosed, JSON.stringify(alloc));
  }

  private toEpoch(r: Row | undefined): EpochAllocation | null {
    if (!r) return null;
    const alloc: EpochAllocation = JSON.parse(str(r, "json"));
    return alloc;
  }

  getEpoch(epoch: number): EpochAllocation | null {
    return this.toEpoch(this.get("SELECT json FROM epochs WHERE epoch = ?", epoch));
  }

  latestEpoch(): EpochAllocation | null {
    return this.toEpoch(this.get("SELECT json FROM epochs ORDER BY epoch DESC LIMIT 1"));
  }

  close(): void {
    this.db.close();
  }
}
