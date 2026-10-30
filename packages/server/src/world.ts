import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { Game } from "@econ-sim/sim/engine";
import { CONFIG } from "@econ-sim/sim/config";
import { snapshotGame, type EconomySnapshot } from "@econ-sim/sim/snapshot";
import type { GameEvent, IntentEnvelope, IntentResult, PlayerView } from "@econ-sim/sim/protocol";
import { buildEpochAllocation, epochPrice, ORACLE_RING, writeEpochFile } from "./epochs.ts";
import { Persist, type JournalEntry } from "./persist.ts";

export interface WorldOptions {
  dataDir: string; // ":memory:" for tests
  seed?: number;
  npcs: number;
  investors: number;
  tickMs: number;
  warmupTicks: number;
  log?: (line: string) => void;
}

export interface TickInfo {
  tick: number;
  ms: number;
  events: GameEvent[];
  results: IntentResult[];
  resultsByPlayer: Map<string, IntentResult[]>;
  snapshot: EconomySnapshot;
  snapshotJson: string;
}

/**
 * Server-side state that is not part of `Game` but feeds settlement, so it is
 * snapshotted with the game and rebuilt by the same journal replay.
 */
export interface ServerState {
  /** Last `ORACLE_RING` external `econUsd` updates, oldest first. */
  oracleRing: number[];
  /** $ECON/USD the previous epoch settled at (anchor for the ±30% clamp); null before the first close. */
  epochEconUsd: number | null;
  /** wallet pubkey → $ECON minor staked on-chain, as reported by the settlement worker. */
  onchainStakes: Record<string, number>;
  stakesAsOfSlot: number;
}

const EVENT_BUFFER = 5000;
const noop = (): void => {};

function freshServerState(): ServerState {
  return { oracleRing: [], epochEconUsd: null, onchainStakes: {}, stakesAsOfSlot: 0 };
}

/**
 * Owns the authoritative `Game`. Every state mutation made between ticks
 * (intents, joins, renames, admin oracle/fee/stake updates) goes through here
 * so it is journaled at the current head tick; boot = snapshot + deterministic
 * replay of the journal. A mutation is journaled only after the sim accepted
 * it, so a rejected join can never poison replay.
 */
export class World {
  readonly game: Game;
  readonly persist: Persist;
  readonly tickMs: number;
  readonly ticksPerDay: number = CONFIG.ticksPerDay;
  readonly startedAt = Date.now();
  readonly state: ServerState;
  private readonly dataDir: string;
  private readonly log: (line: string) => void;

  private journal: JournalEntry[] = [];
  private queued: { playerId: string; id: string }[] = []; // intents queued at the head tick, in arrival order
  private recentEvents: GameEvent[] = [];
  private listeners: ((info: TickInfo) => void)[] = [];
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private tickCount = 0;
  private lastTickMs = 0;

  snapshot: EconomySnapshot;
  snapshotJson: string;

  private constructor(game: Game, persist: Persist, state: ServerState, opts: WorldOptions) {
    this.game = game;
    this.persist = persist;
    this.state = state;
    this.tickMs = opts.tickMs;
    this.dataDir = opts.dataDir;
    this.log = opts.log ?? noop;
    this.snapshot = snapshotGame(game);
    this.snapshotJson = JSON.stringify(this.snapshot);
  }

  /**
   * Resume from `DATA_DIR/economy.sqlite` when it holds a snapshot, else boot fresh and warm up.
   * A snapshot the current engine cannot restore (e.g. `StateVersionError` after a
   * `GameState.v` bump) is not fatal: the database is archived as
   * `economy.sqlite.bak-<timestamp>` (with its -wal/-shm) and a fresh world is booted.
   */
  static boot(opts: WorldOptions): World {
    const log = opts.log ?? noop;
    const file = opts.dataDir === ":memory:" ? ":memory:" : join(opts.dataDir, "economy.sqlite");
    let persist = new Persist(file);
    let snap = persist.latestSnapshot();
    let game: Game | null = null;
    let state = freshServerState();
    if (snap) {
      try {
        game = Game.fromJSON(JSON.parse(snap.json));
      } catch (err) {
        log(`snapshot @${snap.tick} cannot be restored: ${err instanceof Error ? err.message : String(err)}`);
        persist.close();
        if (file !== ":memory:") {
          const bak = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
          for (const suffix of ["", "-wal", "-shm"]) if (existsSync(file + suffix)) renameSync(file + suffix, bak + suffix);
          log(`archived ${file} → ${bak}; booting a fresh world`);
        }
        persist = new Persist(file);
        snap = null;
      }
    }
    if (snap && game) {
      if (snap.serverJson !== null) state = { ...state, ...JSON.parse(snap.serverJson) };
      const head = persist.head() ?? snap.tick;
      const rows = persist.journalFrom(snap.tick, snap.seq);
      let i = 0;
      let skipped = 0;
      for (let t = snap.tick; t < head; t++) {
        for (; i < rows.length && rows[i].tick === t; i++) {
          try {
            World.applyEntry(game, state, rows[i].entry);
          } catch (err) {
            skipped++;
            log(`replay: skipped journal row @${t} (${rows[i].entry.t}): ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        game.tick();
      }
      log(`resumed from snapshot @${snap.tick}, replayed ${rows.length} journal rows (${skipped} skipped) → head ${game.ledger.tick}`);
    } else {
      game = new Game(opts.seed);
      game.boot({ players: 0, npcs: opts.npcs, investors: opts.investors });
      game.run(opts.warmupTicks);
      log(`fresh world seed=${opts.seed ?? CONFIG.seed} npcs=${opts.npcs} investors=${opts.investors} warmup=${opts.warmupTicks} → head ${game.ledger.tick}`);
    }
    const world = new World(game, persist, state, opts);
    if (!snap) world.saveSnapshot();
    return world;
  }

  private static applyEntry(game: Game, state: ServerState, e: JournalEntry): void {
    switch (e.t) {
      case "intent":
        game.queue(e.env);
        break;
      case "join":
        game.joinPlayer(e.playerId, e.name);
        break;
      case "rename":
        game.renamePlayer(e.playerId, e.name);
        break;
      case "oracle":
        game.rwa.setQuotesUsd(e.quotes, e.econUsd);
        if (e.econUsd !== undefined && e.econUsd > 0) {
          state.oracleRing.push(e.econUsd);
          if (state.oracleRing.length > ORACLE_RING) state.oracleRing.splice(0, state.oracleRing.length - ORACLE_RING);
        }
        break;
      case "fees":
        game.chain.setExternalCreatorFees(e.econMinorPerTick);
        break;
      case "stakes":
        state.onchainStakes = { ...e.stakes };
        state.stakesAsOfSlot = e.asOfSlot;
        break;
    }
  }

  /** Next tick to simulate. */
  get head(): number {
    return this.game.ledger.tick;
  }

  get playerCount(): number {
    return this.game.players.length;
  }

  hasPlayer(playerId: string): boolean {
    return this.game.player(playerId) !== undefined;
  }

  /** Idempotent; journals only a join the sim accepted. Throws the sim's `JoinError` when the world is full. */
  join(playerId: string, name: string): PlayerView {
    if (this.hasPlayer(playerId)) return this.game.playerView(playerId);
    const view = this.game.joinPlayer(playerId, name);
    this.journal.push({ t: "join", playerId, name });
    return view;
  }

  rename(playerId: string, name: string): void {
    if (!this.hasPlayer(playerId)) return;
    this.game.renamePlayer(playerId, name);
    this.journal.push({ t: "rename", playerId, name });
  }

  playerView(playerId: string): PlayerView {
    return this.game.playerView(playerId);
  }

  queue(env: IntentEnvelope): void {
    this.game.queue(env);
    this.journal.push({ t: "intent", env });
    this.queued.push({ playerId: env.playerId, id: env.id });
  }

  setQuotesUsd(quotes: Record<string, number>, econUsd?: number): void {
    const entry: JournalEntry = { t: "oracle", quotes, econUsd };
    World.applyEntry(this.game, this.state, entry);
    this.journal.push(entry);
  }

  setExternalCreatorFees(econMinorPerTick: number | null): void {
    this.game.chain.setExternalCreatorFees(econMinorPerTick);
    this.journal.push({ t: "fees", econMinorPerTick });
  }

  /** Replace the worker-reported on-chain staking positions (wallet pubkey → $ECON minor). */
  setOnchainStakes(stakes: Record<string, number>, asOfSlot: number): void {
    const entry: JournalEntry = { t: "stakes", stakes, asOfSlot };
    World.applyEntry(this.game, this.state, entry);
    this.journal.push(entry);
  }

  onTick(cb: (info: TickInfo) => void): void {
    this.listeners.push(cb);
  }

  eventsSince(tick: number, limit = 500): GameEvent[] {
    const out: GameEvent[] = [];
    for (let i = this.recentEvents.length - 1; i >= 0 && out.length < limit; i--) {
      if (this.recentEvents[i].tick < tick) break;
      out.push(this.recentEvents[i]);
    }
    return out.reverse();
  }

  /** Simulate exactly one tick: apply queued intents, commit the journal, close epochs, refresh the snapshot. */
  step(): TickInfo {
    if (this.ticking) throw new Error("re-entrant tick");
    this.ticking = true;
    const t0 = performance.now();
    try {
      const entries = this.journal;
      this.journal = [];
      const queued = this.queued;
      this.queued = [];

      const { tick, events, results } = this.game.tick();
      this.persist.commitTick(tick, entries, results);

      // Results come back in queue order. Intents restored from a snapshot's pending list
      // precede the ones queued through this World, so align from the tail and route each
      // result by the (playerId, id) pair it was queued under.
      const resultsByPlayer = new Map<string, IntentResult[]>();
      const offset = results.length - queued.length;
      if (offset < 0) this.log(`tick ${tick}: ${results.length} results for ${queued.length} queued intents`);
      for (let i = 0; offset >= 0 && i < queued.length; i++) {
        const r = results[offset + i];
        const q = queued[i];
        if (r.id !== q.id) {
          this.log(`tick ${tick}: result ${offset + i} does not match queued ${q.playerId}:${q.id}`);
          continue;
        }
        const list = resultsByPlayer.get(q.playerId);
        if (list) list.push(r);
        else resultsByPlayer.set(q.playerId, [r]);
      }

      this.snapshot = snapshotGame(this.game);
      this.snapshotJson = JSON.stringify(this.snapshot);
      if (events.length > 0) {
        this.recentEvents.push(...events);
        if (this.recentEvents.length > EVENT_BUFFER) this.recentEvents.splice(0, this.recentEvents.length - EVENT_BUFFER);
      }

      for (const ev of events) {
        if (ev.kind !== "epoch_close") continue;
        const econPriceUsd = epochPrice(this.state.oracleRing, this.state.epochEconUsd, this.snapshot.chain.econPriceUsd);
        this.state.epochEconUsd = econPriceUsd;
        const onChainCompanies = new Set<string>();
        for (const c of this.snapshot.companies) if (c.onChain) onChainCompanies.add(c.id);
        const alloc = buildEpochAllocation({
          close: ev,
          dividends: events.filter((e) => e.kind === "dividend"),
          onChainCompanies,
          pubkeys: this.persist.pubkeys(),
          onchainStakes: this.state.onchainStakes,
          econPriceUsd,
        });
        this.persist.saveEpoch(alloc);
        if (this.dataDir !== ":memory:") writeEpochFile(this.dataDir, alloc);
        const total = alloc.allocations.reduce((s, a) => s + a.amountEcon, 0);
        this.log(
          `epoch ${ev.epoch} closed @${ev.tick}: dividends=${ev.dividendsCr} CR yield=${ev.yieldEcon} burned=${ev.burnedEcon} fees=${ev.feesEcon} $ECON minor (${ev.feesExternal ? "external" : "simulated"}); price=${econPriceUsd}; ${alloc.allocations.length} allocations totalling ${total} $ECON minor`,
        );
      }
      if (tick % this.ticksPerDay === 0) {
        this.saveSnapshot();
        this.persist.trimResults();
      }

      const ms = performance.now() - t0;
      this.lastTickMs = ms;
      this.tickCount++;
      const info: TickInfo = { tick, ms, events, results, resultsByPlayer, snapshot: this.snapshot, snapshotJson: this.snapshotJson };
      for (const cb of this.listeners) cb(info);
      return info;
    } finally {
      this.ticking = false;
    }
  }

  /** Fixed-interval loop; an overrunning tick is logged and the missed interval is skipped (no catch-up burst). */
  start(clients: () => number = () => 0): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.ticking) return;
      const queued = this.journal.length;
      const info = this.step();
      if (info.ms > this.tickMs) this.log(`tick ${info.tick} overran: ${info.ms.toFixed(0)}ms > ${this.tickMs}ms`);
      if (info.tick % 10 === 0) {
        this.log(`tick ${info.tick} ${info.ms.toFixed(1)}ms clients=${clients()} intents=${queued} events=${info.events.length}`);
      }
    }, this.tickMs);
  }

  stop(): void {
    clearInterval(this.timer ?? undefined);
    this.timer = null;
  }

  /** Snapshot the current head; journal entries already made at this head are recorded so replay skips them. */
  saveSnapshot(): number {
    const head = this.head;
    this.persist.saveSnapshot(head, this.journal.length, JSON.stringify(this.game.toJSON()), JSON.stringify(this.state));
    return head;
  }

  /** Graceful shutdown: stop ticking, snapshot the head, close the DB. */
  close(): void {
    this.stop();
    this.saveSnapshot();
    this.persist.close();
  }

  stats(): { tick: number; players: number; uptime: number; lastTickMs: number; ticks: number } {
    return {
      tick: this.head,
      players: this.playerCount,
      uptime: Math.round((Date.now() - this.startedAt) / 1000),
      lastTickMs: Math.round(this.lastTickMs * 10) / 10,
      ticks: this.tickCount,
    };
  }
}
