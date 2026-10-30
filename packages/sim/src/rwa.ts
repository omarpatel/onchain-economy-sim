import { CONFIG } from "./config.ts";
import type { Ledger } from "./ledger.ts";
import type { Rng } from "./rng.ts";
import { ACCT } from "./types.ts";

export type Ticker = (typeof CONFIG.rwa.tickers)[number];

export const TICKERS: readonly Ticker[] = CONFIG.rwa.tickers;

export interface RwaState {
  usd: Record<string, number>;
  econUsd: number;
  external: string[]; // symbols (and "ECON") pinned by an external oracle
  pos: Record<string, Record<string, number>>; // account -> ticker -> shares
}

/**
 * Real-World-Asset desk: tokenized real equities (the xStocks / Dinari model on
 * Solana), priced by an oracle and settled in $ECON.
 *
 * PRODUCTION NOTE: real tokenized securities are regulated. In production this
 * desk is a thin routing layer over a *licensed* issuer (Backed xStocks, Dinari)
 * and MUST be KYC-gated and geofenced. Here we model the oracle + settlement so
 * the in-game economy can hold real-equity exposure with $ECON.
 */
export class RwaDesk {
  /** oracle price in USD per share */
  private usd: Record<string, number> = {
    AAPL: 230, TSLA: 250, NVDA: 170, MSFT: 420, SPY: 560,
  };
  /** $ECON price in USD -> lets us quote stocks in ECON */
  econUsd = 0.05;
  /** Symbols currently driven by external (Pyth) quotes: no random walk for these. */
  private external: Record<string, true> = {};
  private pos: Record<string, Record<string, number>> = {};

  private ledger: Ledger;
  constructor(ledger: Ledger) {
    this.ledger = ledger;
  }

  isTicker(symbol: string): symbol is Ticker {
    return (TICKERS as readonly string[]).includes(symbol);
  }

  /** ECON (minor units) price per share of a ticker. */
  priceEcon(ticker: Ticker): number {
    const usd = this.usd[ticker];
    return Math.round((usd / this.econUsd) * 1_000_000);
  }

  position(acct: string, ticker: Ticker): number {
    return this.pos[acct]?.[ticker] ?? 0;
  }

  positions(acct: string): { symbol: Ticker; qty: number; usd: number }[] {
    const out: { symbol: Ticker; qty: number; usd: number }[] = [];
    for (const t of TICKERS) {
      const q = this.position(acct, t);
      if (q > 0) out.push({ symbol: t, qty: q, usd: q * this.usd[t] });
    }
    return out;
  }

  /**
   * Pin oracle quotes from an external feed. Pinned symbols stop random-walking
   * in `oracleTick` until `clearExternalQuotes()`. Passing `econUsd` pins the
   * $ECON/USD price as well.
   */
  setQuotesUsd(quotes: Partial<Record<string, number>>, econUsd?: number): void {
    for (const [symbol, usd] of Object.entries(quotes)) {
      if (!this.isTicker(symbol) || usd === undefined || !(usd > 0)) continue;
      this.usd[symbol] = usd;
      this.external[symbol] = true;
    }
    if (econUsd !== undefined && econUsd > 0) {
      this.econUsd = econUsd;
      this.external.ECON = true;
    }
  }

  clearExternalQuotes(): void {
    this.external = {};
  }

  /** Oracle random walk each tick (drift + volatility) for unpinned symbols; also drifts ECON/USD. */
  oracleTick(rng: Rng): void {
    const { driftPerTick, volPerTick } = CONFIG.rwa;
    for (const t of TICKERS) {
      const shock = driftPerTick + rng.jitter(volPerTick);
      if (this.external[t]) continue;
      this.usd[t] = Math.max(1, this.usd[t] * (1 + shock));
    }
    // $ECON is a memecoin: more volatile than equities.
    const econShock = rng.jitter(volPerTick * 3);
    if (!this.external.ECON) this.econUsd = Math.max(0.001, this.econUsd * (1 + econShock));
  }

  /** Buyer's all-in $ECON cost for `shares` of `ticker`. */
  quoteBuy(ticker: Ticker, shares: number): number {
    const gross = this.priceEcon(ticker) * shares;
    return gross + Math.floor((gross * CONFIG.rwa.feeBps) / 10_000);
  }

  buy(acct: string, ticker: Ticker, shares: number): boolean {
    if (!Number.isInteger(shares) || shares <= 0) return false;
    const total = this.quoteBuy(ticker, shares);
    if (this.ledger.balance(acct, "ECON") < total) return false;
    this.ledger.post(`rwa buy ${ticker}`, [
      { account: acct, unit: "ECON", delta: -total },
      { account: ACCT.treasury, unit: "ECON", delta: total },
    ]);
    (this.pos[acct] ??= {})[ticker] = this.position(acct, ticker) + shares;
    return true;
  }

  sell(acct: string, ticker: Ticker, shares: number): boolean {
    if (!Number.isInteger(shares) || shares <= 0 || this.position(acct, ticker) < shares) return false;
    const gross = this.priceEcon(ticker) * shares;
    const fee = Math.floor((gross * CONFIG.rwa.feeBps) / 10_000);
    const net = gross - fee;
    if (this.ledger.balance(ACCT.treasury, "ECON") < net) return false;
    this.ledger.post(`rwa sell ${ticker}`, [
      { account: ACCT.treasury, unit: "ECON", delta: -net },
      { account: acct, unit: "ECON", delta: net },
    ]);
    this.pos[acct][ticker] -= shares;
    return true;
  }

  quotesUsd(): Record<string, number> {
    return { ...this.usd };
  }

  toJSON(): RwaState {
    const pos: Record<string, Record<string, number>> = {};
    for (const [a, by] of Object.entries(this.pos)) pos[a] = { ...by };
    return { usd: { ...this.usd }, econUsd: this.econUsd, external: Object.keys(this.external), pos };
  }

  restore(state: RwaState): void {
    this.usd = { ...state.usd };
    this.econUsd = state.econUsd;
    this.external = {};
    for (const s of state.external) this.external[s] = true;
    this.pos = {};
    for (const [a, by] of Object.entries(state.pos)) this.pos[a] = { ...by };
  }
}
