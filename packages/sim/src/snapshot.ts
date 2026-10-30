import { CONFIG } from "./config.ts";
import type { Game } from "./engine.ts";
import { ALL_GOODS, GOODS, type BuildingType, type Good, type Resource } from "./goods.ts";
import { ACCT } from "./types.ts";
import { RESERVE } from "./chain.ts";

/** One OHLCV bar per tick (or per aggregated bucket), minor units. */
export interface Candle { t: number; o: number; h: number; l: number; c: number; v: number }

/** Plain, JSON-serializable, PUBLIC view of the economy for the frontend/API.
 *  Everything here may be seen by every player; private per-player data lives
 *  in `PlayerView` (protocol.ts). Money is integer minor units (CR cents,
 *  $ECON micro) — the UI formats. */
export interface EconomySnapshot {
  tick: number;
  epoch: number; // floor(tick / ticksPerDay)
  ticksPerDay: number;
  money: {
    crSupply: number;
    econSupply: number;
    econCirculating: number; // supply minus non-circulating reserve
    treasuryCr: number;
    treasuryEcon: number;
    householdsCr: number;
    creatorFees: number; // cumulative $ECON
    yieldPaid: number; // cumulative $ECON to stakers
    burned: number; // cumulative $ECON
    dividends: number; // cumulative CR
    stakedEcon: number;
    conserved: boolean;
  };
  goods: {
    good: Good;
    price: number;
    refPrice: number;
    change24: number; // fractional change vs 24 ticks ago, e.g. 0.05
    volume24: number; // units traded (bought+sold) over last 24 ticks
    float: number; // market-maker inventory
  }[];
  companies: {
    id: string; name: string; ownerId: string; isPlayer: boolean; hubTileId: string;
    buildings: number; trucks: number; cash: number; debt: number;
    lifetimeProfit: number; lastNet: number; valuation: number; marketCap: number;
    sharePrice: number; totalShares: number; floatShares: number;
    public: boolean; onChain: boolean; bankrupt: boolean; autopilot: boolean;
    dividendPayoutRatio: number; stakedEcon: number;
    book: { bids: { price: number; qty: number }[]; asks: { price: number; qty: number }[] }; // top 5 levels
    lastTrades: { tick: number; price: number; qty: number }[]; // most recent 10
  }[];
  players: { id: string; name: string; companyId: string | null; netCr: number; econ: number }[];
  chain: {
    landNfts: { id: string; tileId: string; owner: string; priceEcon: number }[];
    econPriceUsd: number;
    rwa: { symbol: string; usd: number }[];
  };
  history: {
    goods: Record<Good, Candle[]>; // last N ticks (N = CONFIG.history.ticks)
    shares: Record<string, Candle[]>; // by public company id
    macro: { t: number; crSupply: number; households: number; treasuryCr: number }[];
  };
  world: {
    width: number;
    height: number;
    tiles: {
      id: string; x: number; y: number;
      res: Resource | null; rich: number;
      premium: boolean; priceCr: number; priceEcon: number;
      owner: string | null; // company id or account id
      ownerName: string | null;
      hq: boolean;
      building: { id: string; type: BuildingType; companyId: string; live: boolean; utilization: number } | null;
    }[];
  };
}

/** Snapshot a running Game: the public state every client may see. */
export function snapshotGame(game: Game): EconomySnapshot {
  const ctx = game.ctx();
  const tick = game.ledger.tick;
  const { ledger, exchange, market, chain, map } = game;

  const companyName: Record<string, string> = {};
  const hqTiles: Record<string, string> = {};
  const buildingAt: Record<string, { id: string; type: BuildingType; companyId: string; live: boolean; utilization: number }> = {};
  const playerName: Record<string, string> = {};
  for (const p of game.players) playerName[p.id] = p.name;
  for (const c of game.companies) {
    companyName[c.id] = c.name;
    hqTiles[c.hubTileId] = c.id;
    for (const b of c.buildings) {
      buildingAt[b.tileId] = { id: b.id, type: b.type, companyId: c.id, live: tick >= b.liveAtTick, utilization: b.lastUtilization };
    }
  }

  const sharePrice = (c: (typeof game.companies)[number]): number =>
    exchange.lastPrice[c.id] ?? (c.totalShares > 0 ? Math.round(c.valuation(ctx) / c.totalShares) : 0);

  const companies = game.companies.map((c) => ({
    id: c.id, name: c.name, ownerId: c.ownerId, isPlayer: c.ownerId in playerName, hubTileId: c.hubTileId,
    buildings: c.buildings.length, trucks: c.trucks,
    cash: ledger.balance(c.id, "CR"), debt: c.debt,
    lifetimeProfit: c.lifetimeProfit, lastNet: c.lastPnl.net,
    valuation: c.valuation(ctx), marketCap: exchange.marketCap(c),
    sharePrice: c.isPublic ? sharePrice(c) : 0, totalShares: c.totalShares, floatShares: c.floatShares,
    public: c.isPublic, onChain: c.isOnChain, bankrupt: c.bankrupt, autopilot: c.autopilot,
    dividendPayoutRatio: c.dividendPayoutRatio, stakedEcon: c.stakedEcon,
    book: exchange.depth(c.id, 5),
    lastTrades: exchange.recentTrades(c.id).map((t) => ({ tick: t.tick, price: t.price, qty: t.qty })),
  }));

  const players = game.players.map((p) => {
    let shareVal = 0;
    for (const c of game.companies) shareVal += exchange.shares(c.id, p.id) * sharePrice(c);
    const co = p.companyId ? game.company(p.companyId) : undefined;
    const privateEquity = co && !co.isPublic ? Math.max(0, co.bookValue(ctx)) : 0;
    return {
      id: p.id, name: p.name, companyId: p.companyId,
      netCr: ledger.balance(p.id, "CR") + shareVal + privateEquity,
      econ: ledger.balance(p.id, "ECON"),
    };
  }).sort((a, z) => z.netCr - a.netCr);

  const tiles = map.tiles.map((t) => {
    let res: Resource | null = null;
    let rich = 0;
    for (const [r, v] of Object.entries(t.resources)) {
      if ((v as number) > rich) { rich = v as number; res = r as Resource; }
    }
    return {
      id: t.id, x: t.x, y: t.y, res, rich,
      premium: t.premium, priceCr: t.priceCr, priceEcon: t.priceEcon,
      owner: t.ownerId,
      ownerName: t.ownerId ? companyName[t.ownerId] ?? playerName[t.ownerId] ?? ledger.get(t.ownerId).label : null,
      hq: t.id in hqTiles,
      building: buildingAt[t.id] ?? null,
    };
  });

  const econSupply = ledger.supply("ECON");
  return {
    tick,
    epoch: Math.floor(tick / CONFIG.ticksPerDay),
    ticksPerDay: CONFIG.ticksPerDay,
    money: {
      crSupply: ledger.supply("CR"),
      econSupply,
      econCirculating: econSupply - ledger.balance(RESERVE, "ECON"),
      treasuryCr: ledger.balance(ACCT.treasury, "CR"),
      treasuryEcon: ledger.balance(ACCT.treasury, "ECON"),
      householdsCr: ledger.balance(ACCT.households, "CR"),
      creatorFees: chain.totalCreatorFees,
      yieldPaid: chain.totalYield,
      burned: chain.totalBurned,
      dividends: game.dividendsCr,
      stakedEcon: ledger.balance(ACCT.stakeVault, "ECON"),
      conserved: ledger.conserved().ok,
    },
    goods: ALL_GOODS.map((g: Good) => ({
      good: g, price: market.price(g), refPrice: GOODS[g].refPrice,
      change24: game.history.change(g, CONFIG.ticksPerDay), volume24: game.history.volume(g, CONFIG.ticksPerDay),
      float: market.available(g),
    })),
    companies,
    players,
    chain: {
      landNfts: chain.landNfts.map((n) => ({ id: n.id, tileId: n.tileId, owner: n.owner, priceEcon: n.priceEcon })),
      econPriceUsd: game.rwa.econUsd,
      rwa: Object.entries(game.rwa.quotesUsd()).map(([symbol, usd]) => ({ symbol, usd })),
    },
    history: game.history.toJSON(),
    world: { width: map.width, height: map.height, tiles },
  };
}
