import { Bank } from "./bank.ts";
import { ChainBridge, type ChainState } from "./chain.ts";
import { Company, type Building, type CompanyState } from "./company.ts";
import { CONFIG } from "./config.ts";
import { Exchange, type ExchangeState, type Trade } from "./exchange.ts";
import { GOODS, RECIPES, RES_OF, type Good, type Resource } from "./goods.ts";
import { History, type HistoryState } from "./history.ts";
import { applyIntent } from "./intents.ts";
import { Ledger, type LedgerState } from "./ledger.ts";
import { LOGI } from "./logistics.ts";
import { Market, type MarketState } from "./market.ts";
import { WorldMap, type MapState, type Tile } from "./map.ts";
import { consumerDemandTick, companyManageTick, investorTradeTick } from "./npc.ts";
import type { CompanyView, GameEvent, IntentEnvelope, IntentResult, PlayerView } from "./protocol.ts";
import { RwaDesk, type RwaState } from "./rwa.ts";
import { Rng } from "./rng.ts";
import { cleanName } from "./text.ts";
import { ACCT, type SimContext } from "./types.ts";

/** `Game.joinPlayer` failure: the world cannot take another player right now. */
export class JoinError extends Error {
  readonly code: "map_full" | "max_players";
  constructor(code: "map_full" | "max_players", message: string) {
    super(message);
    this.name = "JoinError";
    this.code = code;
  }
}

export interface BootOptions {
  players: number;
  npcs: number;
  investors: number;
}

export interface PlayerRecord {
  id: string; // ledger account
  name: string;
  companyId: string | null;
  joinedTick: number;
}

export interface TickResult {
  tick: number; // the tick that was just simulated
  events: GameEvent[];
  results: IntentResult[];
}

/** Bump when the serialized shape changes; `Game.fromJSON` refuses other versions. */
export const GAME_STATE_VERSION = 2;

/** `Game.fromJSON` refused a snapshot written by a different engine version. */
export class StateVersionError extends Error {
  readonly found: unknown;
  readonly expected: number;
  constructor(found: unknown) {
    super(`unsupported game state version ${String(found)} (expected ${GAME_STATE_VERSION})`);
    this.name = "StateVersionError";
    this.found = found;
    this.expected = GAME_STATE_VERSION;
  }
}

/** Complete serialized game (see `Game.toJSON` / `Game.fromJSON`). Terrain is
 *  regenerated from `seed`; everything else is state. */
export interface GameState {
  v: typeof GAME_STATE_VERSION;
  seed: number;
  rng: number;
  ledger: LedgerState;
  map: MapState;
  market: MarketState;
  exchange: ExchangeState;
  chain: ChainState;
  rwa: RwaState;
  companies: CompanyState[];
  players: PlayerRecord[];
  investors: string[];
  dividendsCr: number;
  cid: number;
  welfare: number;
  history: HistoryState;
  pendingIntents: IntentEnvelope[];
  pendingEvents: GameEvent[];
}

const STARTER_RESOURCES: readonly Resource[] = ["iron", "coal", "oil", "fertile", "forest", "aquifer"];

/** The whole game world: state + wiring + the per-tick simulation loop. */
export class Game {
  readonly seed: number;
  rng: Rng;
  ledger = new Ledger();
  map: WorldMap;
  market: Market;
  exchange: Exchange;
  bank = new Bank();
  chain: ChainBridge;
  rwa: RwaDesk;
  history = new History();

  companies: Company[] = [];
  players: PlayerRecord[] = [];
  investors: string[] = [];
  dividendsCr = 0; // cumulative dividends distributed (survives journal trims)
  /** Household welfare (0..1) measured last tick: consumer-goods fulfilment. */
  welfare = 1;
  private cid = 1;
  private pendingIntents: IntentEnvelope[] = [];
  private events: GameEvent[] = [];

  constructor(seed: number = CONFIG.seed) {
    this.seed = seed;
    this.rng = new Rng(seed);
    this.map = new WorldMap(this.rng);
    this.chain = new ChainBridge(this.ledger);
    this.rwa = new RwaDesk(this.ledger);

    for (const a of Object.values(ACCT)) {
      const kind =
        a === ACCT.crMint || a === ACCT.econMint ? "mint"
        : a === ACCT.burn ? "burn"
        : a === ACCT.treasury ? "treasury"
        : a === ACCT.market ? "market"
        : a === ACCT.stakeVault ? "stake"
        : "npc";
      this.ledger.open(a, kind, a);
    }
    this.market = new Market(this.ledger, ACCT.market, ACCT.treasury);
    this.exchange = new Exchange(this.ledger);
  }

  /** Next tick to be simulated (== `ledger.tick`). */
  get headTick(): number {
    return this.ledger.tick;
  }

  ctx(): SimContext {
    const h = CONFIG.households;
    return {
      ledger: this.ledger, market: this.market, map: this.map, rng: this.rng, tick: this.ledger.tick,
      labor: h.productivityMin + (h.productivityMax - h.productivityMin) * this.welfare,
    };
  }

  emit(e: GameEvent): void {
    this.events.push(e);
  }

  company(id: string): Company | undefined {
    return this.companies.find((c) => c.id === id);
  }

  player(id: string): PlayerRecord | undefined {
    return this.players.find((p) => p.id === id);
  }

  /** The building occupying a tile, if any. */
  buildingOn(tileId: string): { company: Company; building: Building } | undefined {
    for (const company of this.companies) {
      for (const building of company.buildings) if (building.tileId === tileId) return { company, building };
    }
    return undefined;
  }

  // ───────────────────────────── boot ─────────────────────────────

  boot(opts: BootOptions): void {
    // Money supply seeds: the market float and initial household savings.
    this.ledger.issue("seed:market", ACCT.crMint, ACCT.market, "CR", CONFIG.boot.marketFloatCr);
    this.ledger.issue("seed:households", ACCT.crMint, ACCT.households, "CR", CONFIG.boot.householdSavingsCr);

    // $ECON genesis into the reserve.
    this.chain.genesis(CONFIG.chain.genesisSupplyEcon);

    // Autopilot "players": exercise the player code path without a human.
    for (let i = 0; i < opts.players; i++) this.addPlayer(`player:${i}`, `Player${i}`, true);
    // NPC industrialist firms.
    for (let i = 0; i < opts.npcs; i++) {
      const owner = `npc:${i}`;
      this.ledger.open(owner, "npc", owner);
      this.ledger.issue(`grant ${owner}`, ACCT.crMint, owner, "CR", CONFIG.boot.npcGrantCr);
      this.chain.airdrop(owner, CONFIG.boot.npcEcon);
      this.foundCompany(`NPC Corp ${i}`, owner, true);
    }
    // Investors / helpers (share-market participants).
    for (let i = 0; i < opts.investors; i++) {
      const acct = `inv:${i}`;
      this.ledger.open(acct, "npc", acct);
      this.ledger.issue(`grant ${acct}`, ACCT.crMint, acct, "CR", CONFIG.boot.investorGrantCr);
      this.chain.airdrop(acct, CONFIG.boot.investorEcon);
      this.investors.push(acct);
    }
  }

  /**
   * Register a human player (idempotent): open their wallet, grant starter
   * CR + $ECON, and found a company (autopilot OFF) with an HQ spread away
   * from existing HQs plus a starter extractor. Throws `JoinError` (and
   * mutates nothing) when the player cap is reached or no HQ tile is free.
   */
  joinPlayer(playerId: string, name: string): PlayerView {
    if (!this.player(playerId)) {
      if (this.players.length >= CONFIG.player.maxPlayers) throw new JoinError("max_players", `player cap of ${CONFIG.player.maxPlayers} reached`);
      if (!this.map.freePlainTiles().some((t) => !this.buildingOn(t.id))) throw new JoinError("map_full", "map is full: no free plain tile for an HQ");
      this.addPlayer(playerId, cleanName(name, CONFIG.company.maxNameLength) || "Player", false);
    }
    return this.playerView(playerId);
  }

  private addPlayer(playerId: string, name: string, autopilot: boolean): void {
    this.ledger.open(playerId, "player", name);
    this.ledger.issue(`grant ${playerId}`, ACCT.crMint, playerId, "CR", CONFIG.player.starterCr);
    this.chain.airdrop(playerId, CONFIG.player.starterEcon);
    const co = this.foundCompany(`${name} Industries`, playerId, autopilot);
    this.players.push({ id: playerId, name, companyId: co.id, joinedTick: this.ledger.tick });
  }

  renamePlayer(playerId: string, name: string): void {
    const p = this.player(playerId);
    if (!p) throw new Error(`unknown player ${playerId}`);
    p.name = name;
    this.ledger.get(playerId).label = name;
  }

  private pickHqTile(): Tile {
    const cx = (this.map.width - 1) / 2;
    const cy = (this.map.height - 1) / 2;
    const candidates = this.map.freePlainTiles()
      .filter((t) => !this.buildingOn(t.id))
      .sort((a, z) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(z.x - cx, z.y - cy))
      .slice(0, CONFIG.player.hqCandidates);
    if (candidates.length === 0) throw new JoinError("map_full", "map is full: no free plain tile for an HQ");
    const hqs = this.companies.map((c) => this.map.tile(c.hubTileId));
    if (hqs.length === 0) return candidates[0];
    let best = candidates[0];
    let bestD = -1;
    for (const t of candidates) {
      let d = Infinity;
      for (const h of hqs) d = Math.min(d, this.map.distance(t, h));
      if (d > bestD) { bestD = d; best = t; }
    }
    return best;
  }

  private foundCompany(name: string, ownerId: string, autopilot: boolean): Company {
    const hub = this.pickHqTile();
    const co = new Company(`co:${this.cid++}`, name, ownerId, hub.id);
    hub.ownerId = co.id;
    co.autopilot = autopilot;
    this.ledger.open(co.id, "company", name);
    this.ledger.issue(`capital ${co.id}`, ACCT.crMint, co.id, "CR", CONFIG.player.companyCapitalCr);
    this.companies.push(co);

    // Starter extractor (live immediately) on the nearest free tile of a random resource.
    const first = this.rng.pick(STARTER_RESOURCES);
    const order = [first, ...STARTER_RESOURCES.filter((r) => r !== first)];
    for (const res of order) {
      const tile = this.map.freeResourceTiles(res)
        .filter((t) => !t.premium && !this.buildingOn(t.id))
        .sort((a, z) => this.map.distance(a, hub) - this.map.distance(z, hub))[0];
      if (!tile) continue;
      tile.ownerId = co.id;
      co.addBuilding(RES_OF[res], tile.id, this.ledger.tick);
      break;
    }
    return co;
  }

  // ───────────────────────────── intents ─────────────────────────────

  /** Queue an intent; it is applied at the start of the next `tick()`. */
  queue(env: IntentEnvelope): void {
    this.pendingIntents.push(env);
  }

  /** Apply an intent synchronously at the head tick (local sandbox client). */
  apply(env: IntentEnvelope): IntentResult {
    return applyIntent(this, env);
  }

  // ───────────────────────────── tick ─────────────────────────────

  tick(): TickResult {
    const t = this.ledger.tick;

    // 1. Player intents, in arrival order.
    const queued = this.pendingIntents;
    this.pendingIntents = [];
    const results: IntentResult[] = queued.map((env) => applyIntent(this, env));

    // 2. Macro / on-chain layer.
    this.chain.creatorFeeTick(this.rng);
    this.rwa.oracleTick(this.rng);

    // 3. Firms: construction completes, production, debt service.
    const ctx = this.ctx();
    for (const co of this.companies) {
      for (const b of co.buildings) {
        if (b.liveAtTick === t) this.emit({ tick: t, kind: "build_live", companyId: co.id, buildingId: b.id, buildingType: b.type });
      }
      co.produceTick(ctx);
      this.bank.accrueTick(co, ctx);
      co.closeTick();
    }

    // 4. Final demand: households (wage-funded) + exports (bounded injection).
    //    Welfare is smoothed so one empty shelf does not whipsaw productivity.
    const fulfilment = consumerDemandTick(ctx);
    this.welfare += (fulfilment - this.welfare) * CONFIG.households.welfareSmoothing;
    this.exportDemandTick();

    // 5. Capital allocation for autopiloted companies (every 3 ticks to reduce churn).
    if (t % 3 === 0) for (const co of this.companies) if (co.autopilot) companyManageTick(co, this);

    // 6. Share market: investors trade public companies.
    for (const co of this.companies) {
      if (!co.isPublic || co.bankrupt) continue;
      for (const acct of this.investors) investorTradeTick(acct, co, this, 0.15);
    }

    // 7. Occasional $ECON utility usage: premium land + RWA exposure.
    if (t % 6 === 0) this.macroWorldActions();

    // 8. Price discovery for goods + candles/flow events.
    for (const f of this.market.settleTick(() => this.rng.jitter(0.01))) {
      this.history.recordGood(t, f.good, f.open, f.close, f.bought + f.sold);
      if (f.bought + f.sold > 0) this.emit({ tick: t, kind: "market_flow", good: f.good, priceCr: f.close, bought: f.bought, sold: f.sold });
      const pct = f.open > 0 ? f.close / f.open - 1 : 0;
      if (Math.abs(pct) >= 0.1) this.emit({ tick: t, kind: "price_alert", good: f.good, priceCr: f.close, pct });
    }

    // 9. Share trades executed this tick -> events + candles.
    const byCompany: Record<string, Trade[]> = {};
    for (const tr of this.exchange.drainTrades()) {
      this.emit({ tick: t, kind: "share_trade", companyId: tr.companyId, priceCr: tr.price, qty: tr.qty, buyer: tr.buyer, seller: tr.seller });
      (byCompany[tr.companyId] ??= []).push(tr);
    }
    for (const co of this.companies) {
      if (co.isPublic) this.history.recordShares(t, co.id, byCompany[co.id] ?? [], this.exchange.lastPrice[co.id] ?? 0);
    }
    this.exchange.accrueHoldings(); // end-of-tick holdings sample for time-weighted dividends
    this.history.recordMacro({
      t, crSupply: this.ledger.supply("CR"),
      households: this.ledger.balance(ACCT.households, "CR"), treasuryCr: this.ledger.balance(ACCT.treasury, "CR"),
    });

    // 10. Epoch bookkeeping (daily).
    if (t > 0 && t % CONFIG.ticksPerDay === 0) this.epochClose(t);

    this.ledger.tick = t + 1;
    const events = this.events;
    this.events = [];
    return { tick: t, events, results };
  }

  private macroWorldActions(): void {
    // An investor buys a premium land NFT if any remain affordable.
    const buyer = this.rng.pick(this.investors);
    const premium = this.map.tiles.find((t) => t.premium && !t.ownerId);
    if (premium && buyer) {
      const nft = this.chain.buyPremiumLand(buyer, premium, this.ledger.tick);
      if (nft) this.emit({ tick: this.ledger.tick, kind: "land_bought", buyer, tileId: premium.id, unit: "ECON", price: premium.priceEcon, nft: nft.id });
    }
    // An investor takes tokenized real-equity exposure with $ECON.
    const rwaBuyer = this.rng.pick(this.investors);
    const ticker = this.rng.pick(CONFIG.rwa.tickers);
    const qty = this.rng.int(1, 5);
    if (rwaBuyer) this.rwa.buy(rwaBuyer, ticker, qty);
  }

  /**
   * Exports to the rest of the world: an external buyer purchases finished
   * goods each tick. Demand scales with the number of live finished-goods
   * plants (so it grows with the real economy, never a fixed mint), is
   * price-elastic (falls to zero at `zeroDemandAtRefMultiple` x ref), capped
   * at a share of the CR supply per epoch, and only the CR actually spent is
   * issued.
   */
  private exportDemandTick(): void {
    const finished = (Object.keys(GOODS) as Good[]).filter((g) => GOODS[g].category === "finished");
    let plants = 0;
    for (const co of this.companies) {
      if (co.bankrupt) continue;
      for (const b of co.buildings) {
        if (this.ledger.tick < b.liveAtTick) continue;
        const outs = Object.keys(RECIPES[b.type].outputs) as Good[];
        if (outs.some((g) => GOODS[g].category === "finished")) plants++;
      }
    }
    if (plants === 0) return;
    const cap = Math.floor((this.ledger.supply("CR") * CONFIG.exports.maxShareOfSupplyPerEpoch) / CONFIG.ticksPerDay);
    const budget = Math.min(CONFIG.exports.crPerLiveFinishedBuildingPerTick * plants, cap);
    const per = Math.floor(budget / finished.length);
    for (const g of finished) {
      const price = this.market.price(g);
      const rel = price / GOODS[g].refPrice;
      const mult = Math.max(0, Math.min(1, (CONFIG.exports.zeroDemandAtRefMultiple - rel) / (CONFIG.exports.zeroDemandAtRefMultiple - 1)));
      const qty = Math.min(Math.floor((per * mult) / Math.max(1, price)), this.market.available(g));
      if (qty <= 0) continue;
      const cost = this.market.quoteBuy(g, qty);
      this.ledger.issue("export:fund", ACCT.crMint, ACCT.exportBuyer, "CR", cost);
      this.market.buy(ACCT.exportBuyer, g, qty);
    }
  }

  private epochClose(t: number): void {
    const epoch = t / CONFIG.ticksPerDay;
    let epochDividends = 0;
    for (const co of this.companies) {
      if (co.bankrupt) continue;
      this.chargeLandUpkeep(co, t);
      this.chargeIdleCash(co);

      // Dividends from public firms (CR), pro-rata to time-weighted holdings.
      if (co.isPublic) {
        const pool = Math.max(0, Math.floor(co.epochProfitCr * co.dividendPayoutRatio));
        if (pool > 0) {
          const { paid, perShare, holders } = this.exchange.payDividends(co, pool, this.ledger);
          if (paid > 0) {
            this.dividendsCr += paid;
            epochDividends += paid;
            this.emit({ tick: t, kind: "dividend", companyId: co.id, poolCr: paid, perShareCr: perShare, paid: holders });
          }
        }
        // Graduate to on-chain listing on traded evidence (see graduationProgress).
        if (!co.isOnChain) {
          const g = this.graduationProgress(co);
          if (g.epochsPublic >= CONFIG.chain.graduateMinEpochs && g.vwapCapCr > CONFIG.chain.graduateMarketCapCr
            && g.volumePctFloat >= CONFIG.chain.graduateMinVolumeOfFloat) {
            co.isOnChain = true;
            this.emit({ tick: t, kind: "graduated", companyId: co.id, marketCapCr: g.vwapCapCr });
          }
        }
      }
      co.epochProfitCr = 0;

      // Insolvency: liabilities exceed assets -> restructure (terminal).
      if (co.debt > 0 && co.bookValue(this.ctx()) < 0) this.bankrupt(co, t);
    }
    this.exchange.closeEpoch();
    // veECON real yield + DAO buyback-burn from this epoch's creator fees.
    const s = this.chain.epochSettle(CONFIG.chain.yieldFrac, CONFIG.chain.burnFrac);
    this.emit({ tick: t, kind: "epoch_close", epoch, dividendsCr: epochDividends, yieldEcon: s.yield, burnedEcon: s.burn, feesEcon: s.fees, feesExternal: s.external });
  }

  /** Graduation gates measured over the last `graduateMinEpochs` epochs:
   *  epochs public, VWAP x totalShares, secondary volume as a fraction of float. */
  graduationProgress(co: Company): CompanyView["graduationProgress"] {
    if (!co.isPublic) return { epochsPublic: 0, vwapCapCr: 0, volumePctFloat: 0 };
    const window = CONFIG.chain.graduateMinEpochs * CONFIG.ticksPerDay;
    return {
      epochsPublic: Math.floor((this.ledger.tick - co.ipoTick) / CONFIG.ticksPerDay),
      vwapCapCr: this.exchange.vwap(co.id, window) * co.totalShares,
      volumePctFloat: co.floatShares > 0 ? this.exchange.volume(co.id, window) / co.floatShares : 0,
    };
  }

  /** Harberger-lite: each owned tile owes a share of its price every epoch.
   *  Unpaid upkeep capitalizes into debt; after `forfeitAfterUnpaidEpochs`
   *  the tile (and any building on it) is forfeited. HQ tiles never forfeit. */
  private chargeLandUpkeep(co: Company, t: number): void {
    const bps = CONFIG.land.upkeepBpsOfPricePerEpoch;
    let paid = 0;
    for (const tile of this.map.ownedBy(co.id)) {
      const due = Math.floor((tile.priceCr * bps) / 10_000);
      if (due <= 0) continue;
      if (this.ledger.balance(co.account, "CR") >= due) {
        this.ledger.transfer(`upkeep ${tile.id}`, co.account, ACCT.treasury, "CR", due);
        paid += due;
        delete co.landArrears[tile.id];
        continue;
      }
      co.debt += due;
      const missed = (co.landArrears[tile.id] = (co.landArrears[tile.id] ?? 0) + 1);
      if (missed >= CONFIG.land.forfeitAfterUnpaidEpochs && tile.id !== co.hubTileId) this.forfeitTile(co, tile, t);
    }
    co.charge("overhead", paid);
  }

  private forfeitTile(co: Company, tile: Tile, t: number): void {
    const on = this.buildingOn(tile.id);
    if (on && on.company === co) {
      co.removeBuilding(on.building.id);
      this.emit({ tick: t, kind: "demolished", companyId: co.id, buildingId: on.building.id });
    }
    tile.ownerId = null;
    delete co.landArrears[tile.id];
  }

  /** Accounting overhead: idle cash above the threshold is taxed each epoch. */
  private chargeIdleCash(co: Company): void {
    const excess = this.ledger.balance(co.account, "CR") - CONFIG.sinks.idleCashThresholdCr;
    if (excess <= 0) return;
    const tax = Math.floor((excess * CONFIG.sinks.idleCashTaxBps) / 10_000);
    if (tax <= 0) return;
    this.ledger.transfer(`overhead ${co.id}`, co.account, ACCT.treasury, "CR", tax);
    co.charge("overhead", tax);
  }

  /** Terminal insolvency: plants are seized, non-HQ land forfeited, debt
   *  written off (the lender eats the loss), orders cancelled. The company
   *  keeps its cash and cap table but no longer operates. */
  private bankrupt(co: Company, t: number): void {
    co.bankrupt = true;
    for (const b of [...co.buildings]) {
      co.removeBuilding(b.id);
      this.emit({ tick: t, kind: "demolished", companyId: co.id, buildingId: b.id });
    }
    for (const tile of this.map.ownedBy(co.id)) if (tile.id !== co.hubTileId) tile.ownerId = null;
    co.landArrears = {};
    co.debt = 0;
    this.exchange.cancelBook(co.id);
    this.emit({ tick: t, kind: "bankrupt", companyId: co.id });
  }

  run(ticks: number): void {
    for (let i = 0; i < ticks; i++) this.tick();
  }

  // ───────────────────────────── views ─────────────────────────────

  playerView(playerId: string): PlayerView {
    const p = this.player(playerId);
    if (!p) throw new Error(`unknown player ${playerId}`);
    const co = p.companyId ? this.company(p.companyId) : undefined;
    return {
      playerId,
      cashCr: this.ledger.balance(playerId, "CR"),
      econ: this.ledger.balance(playerId, "ECON"),
      stakedEcon: this.chain.stakeOf(playerId),
      rwa: this.rwa.positions(playerId),
      holdings: this.exchange.holdingsOf(playerId).map((h) => ({ ...h, lastPriceCr: this.exchange.lastPrice[h.companyId] ?? 0 })),
      orders: this.exchange.ordersOf(playerId).map((o) => ({ id: o.id, companyId: o.companyId, side: o.side, priceCr: o.price, qty: o.qty })),
      company: co ? this.companyView(co) : null,
      pending: this.pendingIntents.filter((e) => e.playerId === playerId).map((e) => ({ id: e.id, kind: e.intent.kind })),
    };
  }

  companyView(co: Company): CompanyView {
    const ctx = this.ctx();
    const score = this.bank.creditScore(co, ctx);
    const inventory = { ...co.inventory };
    return {
      id: co.id, name: co.name, hubTileId: co.hubTileId, autopilot: co.autopilot, bankrupt: co.bankrupt,
      cashCr: this.ledger.balance(co.account, "CR"), debtCr: co.debt,
      creditScore: score, maxNewLoanCr: this.bank.maxNewLoan(co, ctx), rateBps: this.bank.rateBps(score),
      trucks: co.trucks, truckCapacity: co.trucks * LOGI.truckCapacity, haulDemand: co.haulDemand(),
      stakedEcon: co.stakedEcon, boost: co.stakingBoost(),
      inventory, sellPolicy: { ...co.sellPolicy },
      buildings: co.buildings.map((b) => {
        const tile = this.map.tile(b.tileId);
        const res = RECIPES[b.type].requiresResource;
        return {
          id: b.id, type: b.type, tileId: b.tileId, x: tile.x, y: tile.y,
          live: ctx.tick >= b.liveAtTick, liveAtTick: b.liveAtTick, utilization: b.lastUtilization,
          richness: res ? tile.resources[res] ?? 0 : 1,
        };
      }),
      lastPnl: {
        revenue: co.lastPnl.revenue, inputCost: co.lastPnl.inputCost, labor: co.lastPnl.labor, energy: co.lastPnl.energy,
        logistics: co.lastPnl.logistics, interest: co.lastPnl.interest, net: co.lastPnl.net,
      },
      epochProfitCr: co.epochProfitCr, smoothedProfitCr: Math.round(co.smoothedProfit()),
      bookValueCr: co.bookValue(ctx), valuationCr: co.valuation(ctx),
      isPublic: co.isPublic, isOnChain: co.isOnChain,
      totalShares: co.totalShares, floatShares: co.floatShares,
      founderShares: co.isPublic ? this.exchange.shares(co.id, co.ownerId) : 0,
      founderLockedUntilTick: co.isPublic ? this.exchange.lockedUntil(co.id) : -1,
      dividendPayoutRatio: co.dividendPayoutRatio,
      marketCapCr: this.exchange.marketCap(co), sharePriceCr: this.exchange.lastPrice[co.id] ?? 0,
      bestBidCr: this.exchange.bestBid(co.id) ?? null, bestAskCr: this.exchange.bestAsk(co.id) ?? null,
      graduationProgress: this.graduationProgress(co),
    };
  }

  // ───────────────────────────── serialization ─────────────────────────────

  toJSON(): GameState {
    return {
      v: GAME_STATE_VERSION,
      seed: this.seed,
      rng: this.rng.state,
      ledger: this.ledger.toJSON(),
      map: this.map.toJSON(),
      market: this.market.toJSON(),
      exchange: this.exchange.toJSON(),
      chain: this.chain.toJSON(),
      rwa: this.rwa.toJSON(),
      companies: this.companies.map((c) => c.toJSON()),
      players: this.players.map((p) => ({ ...p })),
      investors: [...this.investors],
      dividendsCr: this.dividendsCr,
      cid: this.cid,
      welfare: this.welfare,
      history: this.history.toJSON(),
      pendingIntents: this.pendingIntents.map((e) => ({ id: e.id, playerId: e.playerId, intent: { ...e.intent } })),
      pendingEvents: this.events.map((e) => ({ ...e })),
    };
  }

  static fromJSON(state: GameState): Game {
    if (state.v !== GAME_STATE_VERSION) throw new StateVersionError(state.v);
    const g = new Game(state.seed);
    g.rng.state = state.rng;
    g.ledger.restore(state.ledger);
    g.map.restore(state.map);
    g.market.restore(state.market);
    g.exchange.restore(state.exchange);
    g.chain.restore(state.chain);
    g.rwa.restore(state.rwa);
    g.companies = state.companies.map((c) => Company.fromJSON(c));
    g.players = state.players.map((p) => ({ ...p }));
    g.investors = [...state.investors];
    g.dividendsCr = state.dividendsCr;
    g.cid = state.cid;
    g.welfare = state.welfare;
    g.history.restore(state.history);
    g.pendingIntents = state.pendingIntents.map((e) => ({ id: e.id, playerId: e.playerId, intent: { ...e.intent } }));
    g.events = state.pendingEvents.map((e) => ({ ...e }));
    return g;
  }
}

/** Boot a populated world and warm it up; used by the CLI, tests and the web sandbox. */
export function newDemoGame(opts: { seed?: number; players?: number; npcs?: number; investors?: number; warmupTicks?: number } = {}): Game {
  const game = new Game(opts.seed ?? CONFIG.seed);
  game.boot({ players: opts.players ?? 8, npcs: opts.npcs ?? 18, investors: opts.investors ?? 8 });
  game.run(opts.warmupTicks ?? 240);
  return game;
}
