import { CONFIG } from "./config.ts";
import { ALL_GOODS, GOODS, type Good } from "./goods.ts";
import type { Ledger } from "./ledger.ts";

interface GoodMarket {
  price: number; // current price, CR minor
  inv: number; // market float inventory (glut/shortage proxy)
  buyQ: number; // units actually taken from the float this tick (volume)
  sellQ: number; // units actually delivered to the float this tick (volume)
  wantB: number; // units buyers TRIED to buy this tick (incl. unfilled) -> demand signal
  wantS: number; // units sellers TRIED to sell this tick (incl. unfilled) -> supply signal
  ewB: number; // smoothed demand rate
  ewS: number; // smoothed supply rate
}

export type MarketState = Record<Good, GoodMarket>;

/** Result of one fill against the float. Partial fills are normal: the float
 *  only sells what it holds and only pays what it has in cash. */
export interface Fill {
  qty: number; // units actually traded
  cr: number; // CR minor paid by the buyer (incl. fee) or received by the seller (net of fee)
}

/** Per-good flow of the tick just settled, for candles / `market_flow` events. */
export interface GoodFlow {
  good: Good;
  open: number; // price the tick traded at
  close: number; // price after settlement
  bought: number;
  sold: number;
}

/**
 * NPC-backed commodity market. Always-available counterparty whose price clears
 * Victoria-3 style from the tick's order imbalance, blended with the float's
 * inventory signal, smoothed and circuit-broken per tick, inside a hard
 * 0.25x-4x band around the reference price. Trading fees route to the treasury.
 */
export class Market {
  private book: MarketState = {} as MarketState;

  private ledger: Ledger;
  private accountId: string;
  private treasuryId: string;
  constructor(ledger: Ledger, accountId: string, treasuryId: string) {
    this.ledger = ledger;
    this.accountId = accountId;
    this.treasuryId = treasuryId;
    for (const g of ALL_GOODS) {
      this.book[g] = { price: GOODS[g].refPrice, inv: CONFIG.market.mmInitial, buyQ: 0, sellQ: 0, wantB: 0, wantS: 0, ewB: 0, ewS: 0 };
    }
  }

  price(good: Good): number {
    return this.book[good].price;
  }

  /** Units the float can deliver to buyers right now. */
  available(good: Good): number {
    return this.book[good].inv;
  }

  /** Units the float will buy right now: bounded by its cash and by how much
   *  glut it is willing to warehouse (stops at mmAbsorbCap x target). */
  bidCapacity(good: Good): number {
    const m = this.book[good];
    const room = Math.max(0, Math.round(CONFIG.market.mmTarget * CONFIG.market.mmAbsorbCap) - m.inv);
    return Math.min(room, Math.floor(this.ledger.balance(this.accountId, "CR") / Math.max(1, m.price)));
  }

  snapshot(): Record<Good, number> {
    const out = {} as Record<Good, number>;
    for (const g of ALL_GOODS) out[g] = this.book[g].price;
    return out;
  }

  /** Smoothed units bought / sold per tick (the clearing signal's inputs). */
  flowRates(good: Good): { demand: number; supply: number } {
    return { demand: this.book[good].ewB, supply: this.book[good].ewS };
  }

  /**
   * Where the clearing formula would put the price if `extraBuy` / `extraSell`
   * units per tick were added to the current smoothed flows (what a planner
   * should expect after adding capacity). The float's own refill shortfall
   * (or dump surplus), spread over a day, counts as demand (or supply): a
   * float 4,000 units short is real demand even if no one is bidding yet.
   * Same clearing formula as `settleTick`, band clamped, without smoothing or
   * the per-tick circuit breaker.
   */
  projectedPrice(good: Good, extraBuy: number, extraSell: number): number {
    const c = CONFIG.market;
    const m = this.book[good];
    const gap = (c.mmTarget - m.inv) / CONFIG.ticksPerDay;
    const demand = m.ewB + extraBuy + Math.max(0, gap);
    const supply = m.ewS + extraSell + Math.max(0, -gap);
    const target = clearingTarget(GOODS[good].refPrice, demand, supply, m.inv);
    return Math.min(Math.round(GOODS[good].refPrice * c.bandMax), Math.max(Math.max(1, Math.round(GOODS[good].refPrice * c.bandMin)), Math.round(target)));
  }

  /** Buyer's all-in cost (price + fee) for `qty` units at the current price. */
  quoteBuy(good: Good, qty: number): number {
    const gross = this.book[good].price * qty;
    return gross + Math.floor((gross * CONFIG.market.feeBps) / 10_000);
  }

  /** Seller delivers up to `qty` of `good`; receives proceeds (net of fee) in CR. */
  sell(sellerAcct: string, good: Good, qty: number): Fill {
    const m = this.book[good];
    const want = Math.max(0, Math.floor(qty));
    m.wantS += want;
    const q = Math.min(want, this.bidCapacity(good));
    if (q <= 0) return { qty: 0, cr: 0 };
    const gross = m.price * q;
    const fee = Math.floor((gross * CONFIG.market.feeBps) / 10_000);
    const net = gross - fee;
    this.ledger.post(`sell ${good}x${q}`, [
      { account: this.accountId, unit: "CR", delta: -gross },
      { account: sellerAcct, unit: "CR", delta: net },
      { account: this.treasuryId, unit: "CR", delta: fee },
    ]);
    m.inv += q;
    m.sellQ += q;
    return { qty: q, cr: net };
  }

  /** Buyer purchases up to `qty` of `good` (bounded by float stock), pays price+fee in CR. */
  buy(buyerAcct: string, good: Good, qty: number): Fill {
    const m = this.book[good];
    const want = Math.max(0, Math.floor(qty));
    m.wantB += want;
    const q = Math.min(want, m.inv);
    if (q <= 0) return { qty: 0, cr: 0 };
    const gross = m.price * q;
    const fee = Math.floor((gross * CONFIG.market.feeBps) / 10_000);
    const total = gross + fee;
    this.ledger.post(`buy ${good}x${q}`, [
      { account: buyerAcct, unit: "CR", delta: -total },
      { account: this.accountId, unit: "CR", delta: gross },
      { account: this.treasuryId, unit: "CR", delta: fee },
    ]);
    m.inv -= q;
    m.buyQ += q;
    return { qty: q, cr: total };
  }

  /**
   * Recompute prices from smoothed order flow + inventory, then reset flow.
   *   B̄, S̄ = EWMA of per-tick units bought / sold (flowSmoothing)
   *   P_flow = ref * (1 + w_f * clamp((B̄ - S̄) / min(B̄, S̄), -1, 1))
   *   invMul = clamp(1 + w_i * (target - inv) / target, min, max)
   *   target = P_flow * invMul;  price -> price + smoothing * (target - price)
   * bounded by the per-tick circuit breaker and the [bandMin, bandMax] * ref band.
   * Goods are conserved: the float only changes through trades, except that a
   * glut above target slowly spoils (no CR moves, so this is not a money sink).
   */
  settleTick(refJitter: (good: Good) => number): GoodFlow[] {
    const c = CONFIG.market;
    const flows: GoodFlow[] = [];
    for (const g of ALL_GOODS) {
      const m = this.book[g];
      const open = m.price;
      const B = m.buyQ;
      const S = m.sellQ;
      // The signal uses ATTEMPTED quantities so an empty shelf still registers demand
      // and an unwilling buyer still registers oversupply.
      m.ewB = m.ewB * (1 - c.flowSmoothing) + m.wantB * c.flowSmoothing;
      m.ewS = m.ewS * (1 - c.flowSmoothing) + m.wantS * c.flowSmoothing;
      const target = clearingTarget(GOODS[g].refPrice * (1 + refJitter(g)), m.ewB, m.ewS, m.inv);

      let next = m.price + (target - m.price) * c.smoothing;
      const maxUp = m.price * (1 + c.maxMovePerTick);
      const maxDown = m.price * (1 - c.maxMovePerTick);
      next = Math.round(Math.min(maxUp, Math.max(maxDown, next)));
      const floor = Math.max(1, Math.round(GOODS[g].refPrice * c.bandMin));
      const ceil = Math.round(GOODS[g].refPrice * c.bandMax);
      m.price = Math.min(ceil, Math.max(floor, next));

      // Glut spoils slowly; shortages are only relieved by production.
      if (m.inv > c.mmTarget) m.inv -= Math.round((m.inv - c.mmTarget) * c.glutDecay);
      flows.push({ good: g, open, close: m.price, bought: B, sold: S });
      m.buyQ = 0;
      m.sellQ = 0;
      m.wantB = 0;
      m.wantS = 0;
    }
    return flows;
  }

  /** True when the price sits on the hard band edge. */
  atBandEdge(good: Good): boolean {
    const p = this.book[good].price;
    const ref = GOODS[good].refPrice;
    return p <= Math.max(1, Math.round(ref * CONFIG.market.bandMin)) || p >= Math.round(ref * CONFIG.market.bandMax);
  }

  toJSON(): MarketState {
    const out = {} as MarketState;
    for (const g of ALL_GOODS) out[g] = { ...this.book[g] };
    return out;
  }

  restore(state: MarketState): void {
    for (const g of ALL_GOODS) this.book[g] = { ...state[g] };
  }
}

/** Victoria-3 style clearing target blended with the float's inventory signal. */
function clearingTarget(ref: number, demand: number, supply: number, inv: number): number {
  const c = CONFIG.market;
  const denom = Math.min(demand, supply);
  const diff = demand - supply;
  const flow = Math.abs(diff) < 1e-9 ? 0 : denom < 1e-9 ? Math.sign(diff) : Math.max(-1, Math.min(1, diff / denom));
  const shortage = (c.mmTarget - inv) / c.mmTarget;
  const invMul = Math.max(c.invMulMin, Math.min(c.invMulMax, 1 + c.invWeight * shortage));
  return ref * (1 + c.flowWeight * flow) * invMul;
}
