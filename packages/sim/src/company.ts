import {
  ALL_GOODS, GOODS, RECIPES,
  type BuildingType, type Good,
} from "./goods.ts";
import { haulPlan, LOGI, type HaulLeg, type HaulResult } from "./logistics.ts";
import { CONFIG } from "./config.ts";
import { ACCT, type SimContext } from "./types.ts";

export interface Building {
  id: string;
  type: BuildingType;
  tileId: string;
  liveAtTick: number; // operational once tick >= this
  lastUtilization: number;
  idleTicks: number; // consecutive live ticks at zero utilization
}

/** One tick's profit and loss. `net` also absorbs charges posted after
 *  production (interest every tick; land upkeep and idle-cash overhead on
 *  epoch-close ticks), so on those ticks net < revenue - listed costs. */
export interface TickPnl {
  revenue: number;
  inputCost: number;
  labor: number;
  energy: number;
  logistics: number;
  interest: number;
  overhead: number; // land upkeep + idle-cash tax (epoch-close ticks only)
  net: number;
}

export type SellMode = "auto" | "hold";

export interface CompanyState {
  id: string;
  name: string;
  ownerId: string;
  hubTileId: string;
  autopilot: boolean;
  buildings: Building[];
  inventory: Record<Good, number>;
  sellPolicy: Partial<Record<Good, SellMode>>;
  landArrears: Record<string, number>;
  trucks: number;
  debt: number;
  stakedEcon: number;
  bankrupt: boolean;
  isPublic: boolean;
  isOnChain: boolean;
  totalShares: number;
  floatShares: number;
  ipoTick: number;
  dividendPayoutRatio: number;
  lifetimeProfit: number;
  epochProfitCr: number;
  lastPnl: TickPnl;
  profitEwma: number;
  bId: number;
}

const EMPTY_PNL = (): TickPnl => ({ revenue: 0, inputCost: 0, labor: 0, energy: 0, logistics: 0, interest: 0, overhead: 0, net: 0 });

const CATEGORY_ORDER: Record<Good, number> = (() => {
  const order = { raw: 0, intermediate: 1, finished: 2 } as const;
  const out = {} as Record<Good, number>;
  for (const g of ALL_GOODS) out[g] = order[GOODS[g].category];
  return out;
})();

/** Weight per unit of throughput (inputs + outputs) for a building type. */
export function unitWeight(type: BuildingType): number {
  const r = RECIPES[type];
  let w = 0;
  for (const [g, q] of Object.entries(r.inputs)) w += GOODS[g as Good].weight * (q as number);
  for (const [g, q] of Object.entries(r.outputs)) w += GOODS[g as Good].weight * (q as number);
  return w;
}

/** A player- or NPC-owned company: a set of buildings on tiles, a treasury,
 *  inventory, a truck fleet, debt, and (once public) a cap table. */
export class Company {
  readonly id: string;
  name: string;
  ownerId: string; // controlling account (player or npc)
  hubTileId: string;
  /** When true the NPC manager (`companyManageTick`) runs this company. */
  autopilot = true;
  buildings: Building[] = [];
  inventory: Record<Good, number> = {} as Record<Good, number>;
  /** Goods marked `hold` are kept in inventory instead of auto-sold after production. */
  sellPolicy: Partial<Record<Good, SellMode>> = {};
  /** tileId -> consecutive epochs with unpaid land upkeep. */
  landArrears: Record<string, number> = {};
  trucks = 1;
  debt = 0; // outstanding loan principal, CR minor
  stakedEcon = 0; // $ECON staked behind the company, minor units
  bankrupt = false;

  // cap table (managed by the exchange once public)
  isPublic = false;
  isOnChain = false; // graduated: shares tradeable in $ECON
  totalShares = 0;
  floatShares = 0; // shares not held by founder
  ipoTick = -1;
  dividendPayoutRatio: number = CONFIG.exchange.dividendPayoutRatio;

  // rolling stats
  lifetimeProfit = 0;
  epochProfitCr = 0; // accumulated this epoch (dividend base)
  lastPnl: TickPnl = EMPTY_PNL();
  private profitEwma = 0;

  private bId = 0;

  constructor(id: string, name: string, ownerId: string, hubTileId: string) {
    this.id = id;
    this.name = name;
    this.ownerId = ownerId;
    this.hubTileId = hubTileId;
    for (const g of ALL_GOODS) this.inventory[g] = 0;
  }

  get account(): string {
    return this.id;
  }

  /** Production multiplier from staked $ECON, capped. */
  stakingBoost(): number {
    return Math.min(CONFIG.chain.stakingBoostCap, (this.stakedEcon / 1_000_000) * CONFIG.chain.stakingBoostPerEcon);
  }

  addBuilding(type: BuildingType, tileId: string, liveAtTick: number): Building {
    const b: Building = { id: `${this.id}-b${this.bId++}`, type, tileId, liveAtTick, lastUtilization: 0, idleTicks: 0 };
    this.buildings.push(b);
    return b;
  }

  building(id: string): Building | undefined {
    return this.buildings.find((b) => b.id === id);
  }

  /** Remove a building; the tile stays owned by the company. */
  removeBuilding(id: string): Building | undefined {
    const i = this.buildings.findIndex((b) => b.id === id);
    if (i < 0) return undefined;
    return this.buildings.splice(i, 1)[0];
  }

  /** Post a non-production cost against this tick's P&L and the running profit totals. */
  charge(kind: "interest" | "overhead", amount: number): void {
    if (amount <= 0) return;
    this.lastPnl[kind] += amount;
    this.lastPnl.net -= amount;
    this.lifetimeProfit -= amount;
    this.epochProfitCr -= amount;
  }

  /** Fold the finished tick's net into the smoothed-profit estimate. */
  closeTick(): void {
    this.profitEwma = this.profitEwma === 0 ? this.lastPnl.net : this.profitEwma * 0.9 + this.lastPnl.net * 0.1;
  }

  /** Downstream per-tick demand for a good across own buildings (kept as buffer). */
  private internalDemand(good: Good): number {
    let d = 0;
    for (const b of this.buildings) {
      const need = RECIPES[b.type].inputs[good];
      if (need) d += need * RECIPES[b.type].baseThroughput;
    }
    return d;
  }

  /** Weight per tick the fleet must move if every building ran at full throughput. */
  haulDemand(): number {
    let w = 0;
    for (const b of this.buildings) w += unitWeight(b.type) * RECIPES[b.type].baseThroughput;
    return w;
  }

  private haul(ctx: SimContext, live: Building[]): HaulResult {
    const hub = ctx.map.tile(this.hubTileId);
    const legs: HaulLeg[] = [];
    for (const b of live) {
      const dist = ctx.map.distance(ctx.map.tile(b.tileId), hub);
      legs.push({ weight: unitWeight(b.type) * RECIPES[b.type].baseThroughput, distance: dist });
    }
    return haulPlan(legs, this.trucks);
  }

  /**
   * Run one production tick. Buildings pull inputs from own inventory first
   * (vertical integration = no market fee), buy shortfalls from market, pay
   * wages to households and energy to the utility, then sell surplus to market
   * (unless the good's sell policy is `hold`).
   */
  produceTick(ctx: SimContext): TickPnl {
    const pnl = EMPTY_PNL();
    this.lastPnl = pnl;
    if (this.bankrupt) return pnl;

    const { ledger, market, map } = ctx;
    const boost = (1 + this.stakingBoost()) * ctx.labor;
    const hub = map.tile(this.hubTileId);

    const live = this.buildings.filter((b) => ctx.tick >= b.liveAtTick);
    const haul = this.haul(ctx, live);
    let haulCost = 0;

    // Produce upstream-first so this tick's outputs feed downstream inputs.
    const ordered = [...live].sort((a, z) => outCat(a.type) - outCat(z.type));

    for (const b of ordered) {
      const r = RECIPES[b.type];
      let eff = r.baseThroughput * haul.throttle * boost;
      if (r.requiresResource) eff *= map.tile(b.tileId).resources[r.requiresResource] ?? 0;
      eff = Math.floor(eff);
      if (eff <= 0) {
        this.idle(b);
        continue;
      }
      // Warehouse cap: with nowhere to sell (or a `hold` policy piling up),
      // stop producing once the output stock exceeds maxStockTicks of output.
      const stocked = Object.entries(r.outputs).some(
        ([g, q]) => this.inventory[g as Good] > (q as number) * r.baseThroughput * CONFIG.company.maxStockTicks,
      );
      if (stocked) {
        this.idle(b);
        continue;
      }

      // Gross value per unit of output at current market prices.
      let outValue = 0;
      for (const [g, q] of Object.entries(r.outputs)) outValue += market.price(g as Good) * (q as number);
      // Variable cost per unit: inputs at market price (own inventory is valued
      // the same), energy, and hauling this plant's weight to the hub.
      let marginalInputCost = 0;
      for (const [g, q] of Object.entries(r.inputs)) marginalInputCost += market.price(g as Good) * (q as number);
      const haulPerUnit = unitWeight(b.type) * map.distance(map.tile(b.tileId), hub) * LOGI.ratePerWeightTile;
      const variableCost = marginalInputCost + r.energyCr + haulPerUnit;
      // Average total cost adds labor amortized over full throughput. A stopped
      // plant restarts only when price clears full average cost with a margin;
      // a running plant keeps going while price covers variable cost plus half
      // its labor (hysteresis: firms don't fire and rehire every tick).
      const laborPerUnit = r.laborCr / r.baseThroughput;
      const threshold = b.lastUtilization > 0 ? variableCost + laborPerUnit * 0.5 : (variableCost + laborPerUnit) * 1.05;
      if (outValue <= threshold) {
        this.idle(b);
        continue;
      }
      const energyPerUnit = r.energyCr;

      // Cash-safe throughput cap. Worst case we BUY every input (with fee) and
      // pay energy; using own inventory only lowers actual spend, so this can
      // never overdraw. Also bound by physical input availability (own stock +
      // what the market float can deliver).
      const feeMul = 1 + CONFIG.market.feeBps / 10_000;
      let perUnitCash = energyPerUnit;
      let maxByInputs = eff;
      const cash = ledger.balance(this.account, "CR");
      for (const [gg, qq] of Object.entries(r.inputs)) {
        const g = gg as Good;
        const per = qq as number;
        const unitBuyCost = market.price(g) * per * feeMul;
        perUnitCash += unitBuyCost;
        const affordFromMarket = Math.floor(cash / Math.max(1, unitBuyCost));
        const marketUnits = Math.floor(market.available(g) / per);
        maxByInputs = Math.min(maxByInputs, Math.floor(this.inventory[g] / per) + Math.min(affordFromMarket, marketUnits));
      }
      const units = Math.min(eff, maxByInputs, Math.floor(cash / Math.max(1, perUnitCash)));
      if (units <= 0) {
        this.idle(b);
        continue;
      }

      // Consume inputs: inventory first, buy the rest from market.
      for (const [gg, qq] of Object.entries(r.inputs)) {
        const g = gg as Good;
        const need = (qq as number) * units;
        const fromInv = Math.min(this.inventory[g], need);
        this.inventory[g] -= fromInv;
        const buyQty = need - fromInv;
        if (buyQty > 0) pnl.inputCost += market.buy(this.account, g, buyQty).cr;
      }

      // Energy cost -> households (utility labor); recycles into consumer demand.
      const energy = Math.min(energyPerUnit * units, ledger.balance(this.account, "CR"));
      if (energy > 0) {
        ledger.transfer(`energy ${b.id}`, this.account, ACCT.households, "CR", energy);
        pnl.energy += energy;
      }

      // Outputs into inventory.
      for (const [gg, qq] of Object.entries(r.outputs)) this.inventory[gg as Good] += (qq as number) * units;

      b.lastUtilization = units / r.baseThroughput;
      b.idleTicks = 0;
      haulCost += haulPerUnit * units;

      // Wages scale with utilization -> paid to households (funds consumption).
      const wage = Math.min(Math.round(r.laborCr * b.lastUtilization), ledger.balance(this.account, "CR"));
      if (wage > 0) {
        ledger.transfer(`wages ${b.id}`, this.account, ACCT.households, "CR", wage);
        pnl.labor += wage;
      }
    }

    // Logistics cost for the weight actually moved -> households (drivers are labor too).
    const haulPaid = Math.min(Math.round(haulCost), ledger.balance(this.account, "CR"));
    if (haulPaid > 0) {
      ledger.transfer(`haul ${this.id}`, this.account, ACCT.households, "CR", haulPaid);
      pnl.logistics = haulPaid;
    }

    // Sell surplus above the next tick's internal demand buffer.
    for (const g of ALL_GOODS) {
      if (this.sellPolicy[g] === "hold") continue;
      const surplus = this.inventory[g] - this.internalDemand(g);
      if (surplus > 0) {
        const fill = market.sell(this.account, g, surplus);
        this.inventory[g] -= fill.qty;
        pnl.revenue += fill.cr;
      }
    }

    pnl.net = pnl.revenue - pnl.inputCost - pnl.labor - pnl.energy - pnl.logistics;
    this.lifetimeProfit += pnl.net;
    this.epochProfitCr += pnl.net;
    return pnl;
  }

  private idle(b: Building): void {
    b.lastUtilization = 0;
    b.idleTicks++;
  }

  /** Smoothed profit-per-tick, used for valuation and dividends. */
  smoothedProfit(): number {
    return this.profitEwma;
  }

  inventoryValue(ctx: SimContext): number {
    let v = 0;
    for (const g of ALL_GOODS) v += this.inventory[g] * ctx.market.price(g);
    return v;
  }

  /** Book value: treasury + inventory + capitalized buildings + trucks - debt. */
  bookValue(ctx: SimContext): number {
    const cash = ctx.ledger.balance(this.account, "CR");
    let capital = this.trucks * LOGI.truckCostCr;
    for (const b of this.buildings) capital += Math.round(RECIPES[b.type].buildCostCr * 0.7);
    return cash + this.inventoryValue(ctx) + capital - this.debt;
  }

  /** Enterprise valuation: max of liquid assets and book value plus capitalized earnings (P/E ~ 15). */
  valuation(ctx: SimContext): number {
    const earnings = Math.max(0, this.smoothedProfit()) * 15 * CONFIG.ticksPerDay;
    return Math.max(ctx.ledger.balance(this.account, "CR") + this.inventoryValue(ctx), Math.round(earnings) + this.bookValue(ctx));
  }

  toJSON(): CompanyState {
    return {
      id: this.id, name: this.name, ownerId: this.ownerId, hubTileId: this.hubTileId, autopilot: this.autopilot,
      buildings: this.buildings.map((b) => ({ ...b })),
      inventory: { ...this.inventory },
      sellPolicy: { ...this.sellPolicy },
      landArrears: { ...this.landArrears },
      trucks: this.trucks, debt: this.debt, stakedEcon: this.stakedEcon, bankrupt: this.bankrupt,
      isPublic: this.isPublic, isOnChain: this.isOnChain, totalShares: this.totalShares, floatShares: this.floatShares,
      ipoTick: this.ipoTick, dividendPayoutRatio: this.dividendPayoutRatio,
      lifetimeProfit: this.lifetimeProfit, epochProfitCr: this.epochProfitCr, lastPnl: { ...this.lastPnl },
      profitEwma: this.profitEwma, bId: this.bId,
    };
  }

  static fromJSON(s: CompanyState): Company {
    const co = new Company(s.id, s.name, s.ownerId, s.hubTileId);
    co.autopilot = s.autopilot;
    co.buildings = s.buildings.map((b) => ({ ...b }));
    for (const g of ALL_GOODS) co.inventory[g] = s.inventory[g] ?? 0;
    co.sellPolicy = { ...s.sellPolicy };
    co.landArrears = { ...s.landArrears };
    co.trucks = s.trucks;
    co.debt = s.debt;
    co.stakedEcon = s.stakedEcon;
    co.bankrupt = s.bankrupt;
    co.isPublic = s.isPublic;
    co.isOnChain = s.isOnChain;
    co.totalShares = s.totalShares;
    co.floatShares = s.floatShares;
    co.ipoTick = s.ipoTick;
    co.dividendPayoutRatio = s.dividendPayoutRatio;
    co.lifetimeProfit = s.lifetimeProfit;
    co.epochProfitCr = s.epochProfitCr;
    co.lastPnl = { ...s.lastPnl };
    co.profitEwma = s.profitEwma;
    co.bId = s.bId;
    return co;
  }
}

function outCat(type: BuildingType): number {
  const outs = Object.keys(RECIPES[type].outputs) as Good[];
  return outs.length ? Math.max(...outs.map((g) => CATEGORY_ORDER[g])) : 0;
}
