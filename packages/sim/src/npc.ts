import { CONFIG } from "./config.ts";
import { unitWeight, type Company } from "./company.ts";
import type { Game } from "./engine.ts";
import {
  ALL_BUILDINGS, ALL_GOODS, CONSUMER_GOODS, RECIPES,
  type BuildingType, type Good,
} from "./goods.ts";
import { LOGI } from "./logistics.ts";
import type { Tile } from "./map.ts";
import { borrow, buildOn, buyTruck, demolish, ipo, repay, stake } from "./ops.ts";
import { ACCT, type SimContext } from "./types.ts";
import { cr, econ } from "./units.ts";

/** Households spend a slice of accumulated wage income on consumer goods each
 *  tick. This closes the loop: company wages -> households -> final demand.
 *  Returns welfare = spend-weighted fulfilment of what households wanted to buy. */
export function consumerDemandTick(ctx: SimContext): number {
  const budget = Math.floor(ctx.ledger.balance(ACCT.households, "CR") * CONFIG.households.spendRatePerTick);
  if (budget <= 0) return 1;
  const per = Math.floor(budget / CONSUMER_GOODS.length);
  let wanted = 0;
  let got = 0;
  for (const g of CONSUMER_GOODS) {
    const px = ctx.market.price(g);
    const qty = Math.floor(per / Math.max(1, px));
    if (qty <= 0) continue;
    wanted += qty * px;
    got += ctx.market.buy(ACCT.households, g, qty).qty * px;
  }
  return wanted > 0 ? Math.min(1, got / wanted) : 1;
}

/** Per-good units/tick that plants still under construction (anyone's) will add
 *  to demand (as inputs) and supply (as outputs) once live. */
interface PendingCapacity { buy: Record<Good, number>; sell: Record<Good, number> }

function pendingCapacity(game: Game): PendingCapacity {
  const buy = {} as Record<Good, number>;
  const sell = {} as Record<Good, number>;
  for (const g of ALL_GOODS) { buy[g] = 0; sell[g] = 0; }
  const tick = game.ledger.tick;
  for (const co of game.companies) {
    for (const b of co.buildings) {
      if (b.liveAtTick <= tick) continue;
      const r = RECIPES[b.type];
      for (const [g, q] of Object.entries(r.inputs)) buy[g as Good] += (q as number) * r.baseThroughput;
      for (const [g, q] of Object.entries(r.outputs)) sell[g as Good] += (q as number) * r.baseThroughput;
    }
  }
  return { buy, sell };
}

/**
 * Expected per-tick net margin of one such building on `tile`, priced with the
 * market's own clearing formula projected forward: this plant's output (plus
 * everything under construction) is added to supply and its inputs to demand,
 * so the estimate already includes the price impact of the herd. Hauling to
 * the hub is included; the margin is discounted when an input cannot actually
 * be sourced (float + current production) for a day of operation.
 */
function buildingMargin(type: BuildingType, tile: Tile, hub: Tile, ctx: SimContext, pending: PendingCapacity): number {
  const r = RECIPES[type];
  const richness = r.requiresResource ? tile.resources[r.requiresResource] ?? 0 : 1;
  const units = r.baseThroughput * richness;
  let outVal = 0;
  for (const [g, q] of Object.entries(r.outputs)) {
    const good = g as Good;
    outVal += ctx.market.projectedPrice(good, pending.buy[good], pending.sell[good] + units * (q as number)) * (q as number);
  }
  let inVal = 0;
  let supply = 1;
  for (const [g, q] of Object.entries(r.inputs)) {
    const good = g as Good;
    const need = units * (q as number);
    inVal += ctx.market.projectedPrice(good, pending.buy[good] + need, pending.sell[good]) * (q as number);
    const dayNeed = need * CONFIG.ticksPerDay;
    const sourced = ctx.market.available(good) + (ctx.market.flowRates(good).supply + pending.sell[good]) * CONFIG.ticksPerDay;
    supply = Math.min(supply, sourced / dayNeed);
  }
  const haulPerUnit = unitWeight(type) * ctx.map.distance(tile, hub) * LOGI.ratePerWeightTile;
  return ((outVal - inVal - r.energyCr - haulPerUnit) * units - r.laborCr) * supply;
}

/** Cash needed to run every plant at full throughput for one tick at current prices. */
function operatingCostPerTick(co: Company, ctx: SimContext): number {
  let c = 0;
  for (const b of co.buildings) {
    const r = RECIPES[b.type];
    let inputs = 0;
    for (const [g, q] of Object.entries(r.inputs)) inputs += ctx.market.price(g as Good) * (q as number);
    c += r.laborCr + (r.energyCr + inputs) * r.baseThroughput;
  }
  return c;
}

/**
 * A company's capital-allocation AI (drives NPC firms and auto-piloted player
 * companies): relieve logistics bottlenecks, retire chronically idle plants,
 * expand into the most profitable building it can fund, deleverage when flush,
 * go public when large, stake for a boost.
 */
export function companyManageTick(co: Company, game: Game): void {
  if (co.bankrupt) return;
  const ctx = game.ctx();
  const cash = (): number => ctx.ledger.balance(co.account, "CR");

  // 1. Relieve logistics bottleneck.
  if (co.haulDemand() > co.trucks * LOGI.truckCapacity && cash() > LOGI.truckCostCr * 2) buyTruck(game, co);

  // 2. Retire a plant that has sat idle for three full epochs (frees the tile).
  const idle = co.buildings.find((b) => b.idleTicks >= 3 * CONFIG.ticksPerDay);
  if (idle && co.buildings.length > 2) demolish(game, co, idle.id);

  // 3. Expand: choose the highest-margin affordable building (best tile per type),
  //    always keeping working capital to actually run the plants. Once the map
  //    is down to the HQ reserve, managers only build on land they already own
  //    so joining players can still found a company.
  if (co.buildings.length < CONFIG.company.npcMaxBuildings) {
    let best: { type: BuildingType; tile: Tile; margin: number } | null = null;
    const hub = ctx.map.tile(co.hubTileId);
    const pending = pendingCapacity(game);
    const free = ctx.map.freePlainTiles();
    const claimable = (t: Tile): boolean => t.ownerId === co.id || (!t.ownerId && free.length > CONFIG.player.reservedHqTiles);
    const plain = [...free, ...ctx.map.ownedBy(co.id)]
      .filter((t) => !t.premium && claimable(t) && !game.buildingOn(t.id))
      .sort((a, z) => ctx.map.distance(a, hub) - ctx.map.distance(z, hub))[0];
    for (const type of ALL_BUILDINGS) {
      const res = RECIPES[type].requiresResource;
      let tile: Tile | undefined = plain;
      let margin = -Infinity;
      if (res) {
        tile = undefined;
        for (const t of [...ctx.map.freeResourceTiles(res), ...ctx.map.ownedBy(co.id).filter((o) => (o.resources[res] ?? 0) > 0)]) {
          if (t.premium || !claimable(t) || game.buildingOn(t.id)) continue;
          const m = buildingMargin(type, t, hub, ctx, pending);
          if (m > margin) { margin = m; tile = t; }
        }
      } else if (tile) {
        margin = buildingMargin(type, tile, hub, ctx, pending);
      }
      if (!tile) continue;
      // Hurdle: pay back capex + land within ~10 epochs at the expected margin.
      const capex = RECIPES[type].buildCostCr + tile.priceCr;
      if (margin * 10 * CONFIG.ticksPerDay > capex && (!best || margin > best.margin)) best = { type, tile, margin };
    }
    if (best) {
      // Keep enough cash to run everything (including the new plant) for a while.
      const buffer = (operatingCostPerTick(co, ctx) + RECIPES[best.type].laborCr * 2) * CONFIG.company.npcWorkingCapitalTicks;
      const need = RECIPES[best.type].buildCostCr + best.tile.priceCr + buffer;
      const equity = Math.max(0, co.bookValue(ctx));
      const shortfall = need - cash();
      if (shortfall > 0 && co.debt + shortfall <= equity * CONFIG.bank.npcMaxLeverage) {
        borrow(game, co, Math.min(shortfall, game.bank.maxNewLoan(co, ctx)));
      }
      if (cash() >= need) buildOn(game, co, best.type, best.tile);
    }
  }

  // 4. Deleverage when flush (keep one epoch of wages as a buffer).
  if (co.debt > 0 && cash() > co.debt + cr(5_000)) repay(game, co, Math.min(co.debt, Math.ceil(co.debt / 2)));

  // 5. Go public once sizeable and seasoned.
  if (!co.isPublic && co.buildings.length >= 4 && co.valuation(ctx) > CONFIG.exchange.npcIpoValuationCr && ctx.tick > CONFIG.ticksPerDay) {
    ipo(game, co, CONFIG.exchange.npcIpoShares, CONFIG.exchange.npcIpoFloat);
  }

  // 6. Stake $ECON behind the company for a production boost.
  if (ctx.ledger.balance(co.ownerId, "ECON") > econ(200) && co.stakedEcon < CONFIG.chain.npcStakeTargetEcon) {
    stake(game, co, co.ownerId, econ(100));
  }
}

/**
 * Share-market investor/speculator (also the "helper" NPCs): buys companies
 * trading below intrinsic value, sells rich holdings, and quotes a small
 * two-sided market so player shares stay liquid (only when it has no resting
 * orders in that book, so it does not churn the exchange every tick).
 */
export function investorTradeTick(acct: string, co: Company, game: Game, aggressiveness: number): void {
  if (!co.isPublic) return;
  const ctx = game.ctx();
  const exchange = game.exchange;
  const fair = Math.max(1, Math.round(co.valuation(ctx) / co.totalShares));
  const cash = exchange.freeCash(acct);
  const held = exchange.available(co.id, acct);

  // Value buy: bid when the offer is below intrinsic value.
  const ask = exchange.bestAsk(co.id);
  if (ask !== undefined && ask < fair * 0.99 && cash > ask * 50) {
    const qty = Math.min(Math.floor((cash * aggressiveness) / ask), 200);
    if (qty > 0) exchange.place(co.id, acct, "bid", Math.min(fair, Math.round(ask * 1.01)), qty);
  }
  // Take profit: sell when the bid is above intrinsic value.
  const bid = exchange.bestBid(co.id);
  if (bid !== undefined && held > 0 && bid > fair * 1.03) {
    exchange.place(co.id, acct, "ask", Math.round(fair * 1.02), Math.min(held, 150));
  }
  // Passive liquidity anchored on intrinsic value (+-5% band, never on the
  // last print, which a manipulator could steer), only if we are not already quoting.
  if (!exchange.hasOrders(co.id, acct)) {
    if (cash > fair * 40) exchange.place(co.id, acct, "bid", Math.max(1, Math.round(fair * 0.97)), 20);
    if (held > 20) exchange.place(co.id, acct, "ask", Math.round(fair * 1.03), 20);
  }
}
