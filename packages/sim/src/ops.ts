import { CONFIG } from "./config.ts";
import type { Company } from "./company.ts";
import type { Game } from "./engine.ts";
import { RECIPES, type BuildingType, type Good } from "./goods.ts";
import { LOGI } from "./logistics.ts";
import type { Tile } from "./map.ts";
import { ACCT } from "./types.ts";

/**
 * State-mutating company operations shared by player intents and the NPC
 * manager. Each validates against the authoritative state, applies atomically
 * (all ledger movement happens after validation) and emits the matching
 * `GameEvent`. Returns a rejection reason, or `null` on success.
 */
export type OpResult = string | null;

export function buildOn(game: Game, co: Company, type: BuildingType, tile: Tile): OpResult {
  if (co.bankrupt) return "company is bankrupt";
  if (co.buildings.length >= CONFIG.company.maxBuildings) return `building cap of ${CONFIG.company.maxBuildings} reached`;
  if (game.buildingOn(tile.id)) return `tile ${tile.id} already has a building`;
  const r = RECIPES[type];
  if (r.requiresResource && !((tile.resources[r.requiresResource] ?? 0) > 0)) return `${type} must sit on a ${r.requiresResource} tile`;

  let landCost = 0;
  if (tile.ownerId !== co.id) {
    if (tile.ownerId) return `tile ${tile.id} is owned by someone else`;
    if (tile.premium) return `tile ${tile.id} is premium land: buy_land with $ECON first`;
    landCost = tile.priceCr;
  }
  const cash = game.ledger.balance(co.account, "CR");
  const total = landCost + r.buildCostCr;
  if (cash < total) return `insufficient cash: need ${total}, have ${cash}`;

  const tick = game.ledger.tick;
  if (landCost > 0) {
    game.ledger.transfer(`land ${tile.id}`, co.account, ACCT.treasury, "CR", landCost);
    tile.ownerId = co.id;
    game.emit({ tick, kind: "land_bought", buyer: co.id, tileId: tile.id, unit: "CR", price: landCost });
  }
  // Capex is construction labor: it flows to households and is not recoverable.
  game.ledger.transfer(`build ${type}`, co.account, ACCT.households, "CR", r.buildCostCr);
  const b = co.addBuilding(type, tile.id, tick + r.buildTicks);
  game.emit({ tick, kind: "build_started", companyId: co.id, buildingId: b.id, buildingType: type, tileId: tile.id });
  return null;
}

/** Demolition frees the tile for a new building; the land stays owned. No refund:
 *  capex was paid to construction labor at build time (capital destruction). */
export function demolish(game: Game, co: Company, buildingId: string): OpResult {
  const b = co.removeBuilding(buildingId);
  if (!b) return `unknown building ${buildingId}`;
  game.emit({ tick: game.ledger.tick, kind: "demolished", companyId: co.id, buildingId: b.id });
  return null;
}

/** Buy a tile for the company. Common land costs CR from the company treasury;
 *  premium land costs $ECON from `payer` (the player's wallet) and mints the
 *  land NFT to the payer while the company becomes the tile's owner. */
export function buyLand(game: Game, co: Company, tile: Tile, payer: string): OpResult {
  if (co.bankrupt) return "company is bankrupt";
  if (tile.ownerId === co.id) return `tile ${tile.id} already owned by the company`;
  if (tile.ownerId) return `tile ${tile.id} is owned by someone else`;
  const tick = game.ledger.tick;
  if (tile.premium) {
    const have = game.ledger.balance(payer, "ECON");
    if (have < tile.priceEcon) return `insufficient $ECON: need ${tile.priceEcon}, have ${have}`;
    const nft = game.chain.buyPremiumLand(payer, tile, tick, co.id);
    if (!nft) return "premium purchase failed";
    game.emit({ tick, kind: "land_bought", buyer: payer, tileId: tile.id, unit: "ECON", price: tile.priceEcon, nft: nft.id });
    return null;
  }
  const cash = game.ledger.balance(co.account, "CR");
  if (cash < tile.priceCr) return `insufficient cash: need ${tile.priceCr}, have ${cash}`;
  game.ledger.transfer(`land ${tile.id}`, co.account, ACCT.treasury, "CR", tile.priceCr);
  tile.ownerId = co.id;
  game.emit({ tick, kind: "land_bought", buyer: co.id, tileId: tile.id, unit: "CR", price: tile.priceCr });
  return null;
}

export function buyTruck(game: Game, co: Company): OpResult {
  if (co.bankrupt) return "company is bankrupt";
  const cash = game.ledger.balance(co.account, "CR");
  if (cash < LOGI.truckCostCr) return `insufficient cash: need ${LOGI.truckCostCr}, have ${cash}`;
  game.ledger.transfer(`truck ${co.id}`, co.account, ACCT.households, "CR", LOGI.truckCostCr);
  co.trucks += 1;
  return null;
}

export function borrow(game: Game, co: Company, amountCr: number): OpResult {
  if (co.bankrupt) return "company is bankrupt";
  if (!Number.isInteger(amountCr) || amountCr <= 0) return "amountCr must be a positive integer";
  const ctx = game.ctx();
  const limit = game.bank.maxNewLoan(co, ctx);
  if (amountCr > limit) return `credit limit: can borrow at most ${limit}`;
  const score = game.bank.creditScore(co, ctx);
  game.bank.lend(co, amountCr, ctx);
  game.emit({ tick: ctx.tick, kind: "loan", companyId: co.id, amountCr, rateBps: game.bank.rateBps(score) });
  return null;
}

export function repay(game: Game, co: Company, amountCr: number): OpResult {
  if (!Number.isInteger(amountCr) || amountCr <= 0) return "amountCr must be a positive integer";
  if (amountCr > co.debt) return `debt is only ${co.debt}`;
  const cash = game.ledger.balance(co.account, "CR");
  if (cash < amountCr) return `insufficient cash: need ${amountCr}, have ${cash}`;
  game.bank.repay(co, amountCr, game.ctx());
  game.emit({ tick: game.ledger.tick, kind: "repaid", companyId: co.id, amountCr });
  return null;
}

export function ipo(game: Game, co: Company, sharesTotal: number, floatPct: number): OpResult {
  const x = CONFIG.exchange;
  if (co.bankrupt) return "company is bankrupt";
  if (co.isPublic) return "company is already public";
  if (!Number.isInteger(sharesTotal) || sharesTotal < x.ipoMinShares || sharesTotal > x.ipoMaxShares)
    return `sharesTotal must be an integer in [${x.ipoMinShares}, ${x.ipoMaxShares}]`;
  if (!(floatPct >= x.ipoMinFloat && floatPct <= x.ipoMaxFloat)) return `floatPct must be in [${x.ipoMinFloat}, ${x.ipoMaxFloat}]`;
  if (co.buildings.length === 0) return "company needs at least one building to list";
  const cash = game.ledger.balance(co.account, "CR");
  if (cash < x.listingFeeCr) return `insufficient cash for listing fee ${x.listingFeeCr}`;
  const ctx = game.ctx();
  // Price floor: every share must be worth at least ipoMinPriceCr, so a huge
  // share count cannot round a tiny valuation up into a large market cap.
  const maxShares = Math.floor(co.valuation(ctx) / x.ipoMinPriceCr);
  if (sharesTotal > maxShares) return `sharesTotal must be at most ${maxShares} (valuation / ${x.ipoMinPriceCr} minor per share)`;
  const res = game.exchange.ipo(co, sharesTotal, floatPct, ctx, game.investors);
  game.emit({ tick: ctx.tick, kind: "ipo", companyId: co.id, sharesTotal, floatShares: res.floatShares, priceCr: res.price, raisedCr: res.raisedCr });
  return null;
}

export function stake(game: Game, co: Company, acct: string, amountEcon: number): OpResult {
  if (!Number.isInteger(amountEcon) || amountEcon <= 0) return "amountEcon must be a positive integer";
  const have = game.ledger.balance(acct, "ECON");
  if (have < amountEcon) return `insufficient $ECON: need ${amountEcon}, have ${have}`;
  game.chain.stakeToCompany(co, acct, amountEcon);
  game.emit({ tick: game.ledger.tick, kind: "staked", account: acct, companyId: co.id, amountEcon });
  return null;
}

export function unstake(game: Game, co: Company, acct: string, amountEcon: number): OpResult {
  if (!Number.isInteger(amountEcon) || amountEcon <= 0) return "amountEcon must be a positive integer";
  const have = game.chain.stakeOf(acct, co.id);
  if (have < amountEcon) return `only ${have} $ECON staked in ${co.id}`;
  game.chain.unstakeFromCompany(co, acct, amountEcon);
  game.emit({ tick: game.ledger.tick, kind: "unstaked", account: acct, companyId: co.id, amountEcon });
  return null;
}

/** Company buys goods from the market into inventory (cash accounting: counts against profit until sold). */
export function buyGood(game: Game, co: Company, good: Good, qty: number): OpResult {
  if (co.bankrupt) return "company is bankrupt";
  if (!Number.isInteger(qty) || qty <= 0) return "qty must be a positive integer";
  const avail = game.market.available(good);
  if (avail < qty) return `market has only ${avail} ${good}`;
  const cost = game.market.quoteBuy(good, qty);
  const cash = game.ledger.balance(co.account, "CR");
  if (cash < cost) return `insufficient cash: need ${cost}, have ${cash}`;
  const fill = game.market.buy(co.account, good, qty);
  co.inventory[good] += fill.qty;
  co.lifetimeProfit -= fill.cr;
  co.epochProfitCr -= fill.cr;
  return null;
}

export function sellGood(game: Game, co: Company, good: Good, qty: number): OpResult {
  if (!Number.isInteger(qty) || qty <= 0) return "qty must be a positive integer";
  if (co.inventory[good] < qty) return `inventory has only ${co.inventory[good]} ${good}`;
  if (game.market.bidCapacity(good) < qty) return `market can absorb only ${game.market.bidCapacity(good)} ${good} right now`;
  const fill = game.market.sell(co.account, good, qty);
  co.inventory[good] -= fill.qty;
  co.lifetimeProfit += fill.cr;
  co.epochProfitCr += fill.cr;
  return null;
}
