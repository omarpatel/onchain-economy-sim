import { CONFIG } from "./config.ts";
import { ALL_GOODS, type Good } from "./goods.ts";
import type { Candle } from "./snapshot.ts";

export interface MacroPoint { t: number; crSupply: number; households: number; treasuryCr: number }

export interface HistoryState {
  goods: Record<Good, Candle[]>;
  shares: Record<string, Candle[]>;
  macro: MacroPoint[];
}

/** Fixed-length per-tick history: goods OHLCV, public-company share OHLCV
 *  (carrying the last close through tickless ticks), and macro series. */
export class History {
  goods: Record<Good, Candle[]> = {} as Record<Good, Candle[]>;
  shares: Record<string, Candle[]> = {};
  macro: MacroPoint[] = [];

  constructor() {
    for (const g of ALL_GOODS) this.goods[g] = [];
  }

  private push<T>(buf: T[], item: T): void {
    buf.push(item);
    if (buf.length > CONFIG.history.ticks) buf.shift();
  }

  recordGood(t: number, good: Good, open: number, close: number, volume: number): void {
    this.push(this.goods[good], { t, o: open, h: Math.max(open, close), l: Math.min(open, close), c: close, v: volume });
  }

  /** Build one share candle from the tick's trades (chronological). With no
   *  trades the candle is flat at the previous close (or `fallback` when the
   *  company has no history yet). */
  recordShares(t: number, companyId: string, trades: { price: number; qty: number }[], fallback: number): void {
    const buf = (this.shares[companyId] ??= []);
    const prev = buf.length ? buf[buf.length - 1].c : fallback;
    if (trades.length === 0) {
      this.push(buf, { t, o: prev, h: prev, l: prev, c: prev, v: 0 });
      return;
    }
    let h = -Infinity;
    let l = Infinity;
    let v = 0;
    for (const tr of trades) {
      if (tr.price > h) h = tr.price;
      if (tr.price < l) l = tr.price;
      v += tr.qty;
    }
    this.push(buf, { t, o: prev, h: Math.max(h, prev), l: Math.min(l, prev), c: trades[trades.length - 1].price, v });
  }

  recordMacro(p: MacroPoint): void {
    this.push(this.macro, p);
  }

  /** Fractional price change of a good vs `ticks` ago (0 if not enough history). */
  change(good: Good, ticks: number): number {
    const buf = this.goods[good];
    if (buf.length < 2) return 0;
    const now = buf[buf.length - 1].c;
    const then = buf[Math.max(0, buf.length - 1 - ticks)].o;
    return then > 0 ? now / then - 1 : 0;
  }

  volume(good: Good, ticks: number): number {
    const buf = this.goods[good];
    let v = 0;
    for (let i = Math.max(0, buf.length - ticks); i < buf.length; i++) v += buf[i].v;
    return v;
  }

  toJSON(): HistoryState {
    return cloneHistoryState(this);
  }

  restore(state: HistoryState): void {
    const s = cloneHistoryState(state);
    this.goods = s.goods;
    this.shares = s.shares;
    this.macro = s.macro;
  }
}

function cloneHistoryState(s: HistoryState): HistoryState {
  const goods = {} as Record<Good, Candle[]>;
  for (const g of ALL_GOODS) goods[g] = (s.goods[g] ?? []).map((c) => ({ ...c }));
  const shares: Record<string, Candle[]> = {};
  for (const [id, buf] of Object.entries(s.shares)) shares[id] = buf.map((c) => ({ ...c }));
  return { goods, shares, macro: s.macro.map((m) => ({ ...m })) };
}
