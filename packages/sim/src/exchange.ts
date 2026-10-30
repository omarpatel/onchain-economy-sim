import { CONFIG } from "./config.ts";
import type { Company } from "./company.ts";
import type { Ledger, Posting } from "./ledger.ts";
import { ACCT, type SimContext } from "./types.ts";

export type Side = "bid" | "ask";

export interface Order {
  id: number;
  companyId: string;
  acct: string;
  side: Side;
  price: number; // CR minor per share
  qty: number; // shares remaining
}

interface Book {
  bids: Order[]; // price desc
  asks: Order[]; // price asc
}

export interface Trade {
  tick: number;
  companyId: string;
  price: number;
  qty: number;
  buyer: string;
  seller: string;
}

export interface Level { price: number; qty: number }

export interface IpoResult { price: number; floatShares: number; raisedCr: number }

/** Per-tick aggregate of secondary trades (primary IPO fills excluded). */
export interface Flow { tick: number; qty: number; notional: number }

export interface ExchangeState {
  books: Record<string, Book>;
  holdings: Record<string, Record<string, number>>;
  reserved: Record<string, Record<string, number>>;
  reservedCr: Record<string, number>;
  lastPrice: Record<string, number>;
  lockups: Record<string, { acct: string; until: number }>;
  recent: Record<string, Trade[]>;
  flow: Record<string, Flow[]>;
  shareTicks: Record<string, Record<string, number>>; // company -> holder -> share-ticks this epoch
  epochSamples: number; // holdings samples taken this epoch
  oid: number;
  tradeCount: number;
}

/**
 * Internal stock exchange. Companies go public via primary issuance: founder
 * shares (locked until ipoTick + lockup) plus a public float sold from the
 * company treasury (proceeds fund the company). Secondary trading runs through
 * a price-time bid/ask matching engine; bids reserve cash and asks reserve
 * shares at placement so a resting order can always settle. An order never
 * fills against the same account's resting order (self-trades cannot print a
 * price). Dividends are paid pro-rata to time-weighted holdings over the epoch.
 */
export class Exchange {
  private books: Record<string, Book> = {};
  private holdings: Record<string, Record<string, number>> = {};
  private reserved: Record<string, Record<string, number>> = {}; // shares locked in asks
  private reservedCr: Record<string, number> = {}; // CR locked in bids, per account
  lastPrice: Record<string, number> = {};
  private lockups: Record<string, { acct: string; until: number }> = {};
  private recent: Record<string, Trade[]> = {};
  private flow: Record<string, Flow[]> = {}; // secondary volume per tick, last `flowTicks`
  private shareTicks: Record<string, Record<string, number>> = {};
  private epochSamples = 0;
  private pending: Trade[] = []; // trades since the engine last drained
  private oid = 1;
  tradeCount = 0;

  private ledger: Ledger;
  constructor(ledger: Ledger) {
    this.ledger = ledger;
  }

  private book(companyId: string): Book {
    return (this.books[companyId] ??= { bids: [], asks: [] });
  }

  shares(companyId: string, acct: string): number {
    return this.holdings[companyId]?.[acct] ?? 0;
  }

  /** Shares not locked in resting asks. */
  available(companyId: string, acct: string): number {
    return this.shares(companyId, acct) - (this.reserved[companyId]?.[acct] ?? 0);
  }

  /** CR not locked in resting bids. */
  freeCash(acct: string): number {
    return this.ledger.balance(acct, "CR") - (this.reservedCr[acct] ?? 0);
  }

  private credit(companyId: string, acct: string, n: number): void {
    (this.holdings[companyId] ??= {})[acct] = this.shares(companyId, acct) + n;
  }

  holders(companyId: string): [string, number][] {
    return Object.entries(this.holdings[companyId] ?? {}).filter(([, n]) => n > 0);
  }

  /** Every company the account holds shares in. */
  holdingsOf(acct: string): { companyId: string; shares: number }[] {
    const out: { companyId: string; shares: number }[] = [];
    for (const [companyId, byAcct] of Object.entries(this.holdings)) {
      const n = byAcct[acct] ?? 0;
      if (n > 0) out.push({ companyId, shares: n });
    }
    return out;
  }

  ordersOf(acct: string): Order[] {
    const out: Order[] = [];
    for (const b of Object.values(this.books)) {
      for (const o of b.bids) if (o.acct === acct) out.push(o);
      for (const o of b.asks) if (o.acct === acct) out.push(o);
    }
    return out.sort((a, z) => a.id - z.id);
  }

  hasOrders(companyId: string, acct: string): boolean {
    const b = this.books[companyId];
    return !!b && (b.bids.some((o) => o.acct === acct) || b.asks.some((o) => o.acct === acct));
  }

  marketCap(co: Company): number {
    const px = this.lastPrice[co.id] ?? 0;
    return px * co.totalShares;
  }

  /** Founder lockup: the controlling account may not sell before this tick (-1 if none). */
  lockedUntil(companyId: string): number {
    return this.lockups[companyId]?.until ?? -1;
  }

  /** Aggregated top-of-book levels (price desc for bids, asc for asks). */
  depth(companyId: string, levels: number): { bids: Level[]; asks: Level[] } {
    const agg = (orders: Order[]): Level[] => {
      const out: Level[] = [];
      for (const o of orders) {
        const top = out[out.length - 1];
        if (top && top.price === o.price) top.qty += o.qty;
        else if (out.length < levels) out.push({ price: o.price, qty: o.qty });
        else break;
      }
      return out;
    };
    const b = this.book(companyId);
    return { bids: agg(b.bids), asks: agg(b.asks) };
  }

  recentTrades(companyId: string): Trade[] {
    return this.recent[companyId] ?? [];
  }

  /** Trades executed since the last drain (the engine calls this once per tick). */
  drainTrades(): Trade[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }

  private flowWindow(companyId: string, ticks: number): Flow[] {
    const since = this.ledger.tick - ticks;
    return (this.flow[companyId] ?? []).filter((f) => f.tick > since);
  }

  /** Volume-weighted average price of secondary trades over the last `ticks`
   *  ticks (0 if none traded). Primary IPO fills and self-trades never count. */
  vwap(companyId: string, ticks: number): number {
    let qty = 0;
    let notional = 0;
    for (const f of this.flowWindow(companyId, ticks)) { qty += f.qty; notional += f.notional; }
    return qty > 0 ? Math.round(notional / qty) : 0;
  }

  /** Shares traded on the secondary market over the last `ticks` ticks. */
  volume(companyId: string, ticks: number): number {
    let qty = 0;
    for (const f of this.flowWindow(companyId, ticks)) qty += f.qty;
    return qty;
  }

  /** Sample every holder's position once per tick; the engine calls this at the
   *  end of each tick so dividends weight by time held, not close-tick holdings. */
  accrueHoldings(): void {
    for (const [companyId, byAcct] of Object.entries(this.holdings)) {
      const st = (this.shareTicks[companyId] ??= {});
      for (const [acct, n] of Object.entries(byAcct)) if (n > 0) st[acct] = (st[acct] ?? 0) + n;
    }
    this.epochSamples++;
  }

  /** Time-weighted average shares held per account over the epoch in progress
   *  (company treasury shares excluded). Reset by `closeEpoch()`. */
  twaHoldings(companyId: string): [string, number][] {
    const st = this.shareTicks[companyId];
    if (!st || this.epochSamples === 0) return [];
    const out: [string, number][] = [];
    for (const [acct, ticks] of Object.entries(st)) if (acct !== companyId && ticks > 0) out.push([acct, ticks / this.epochSamples]);
    return out;
  }

  /** End the dividend epoch: forget accumulated share-ticks. */
  closeEpoch(): void {
    this.shareTicks = {};
    this.epochSamples = 0;
  }

  /**
   * Take a company public: mint the cap table, charge the listing fee, then
   * bookbuild the float: `subscribers` (NPC investors) buy at the IPO price,
   * pro-rata and bounded by their free cash, so the company raises capital
   * immediately; whatever is left is listed as laddered asks. The price is
   * floored (never rounded up) so price x sharesTotal <= valuation; callers
   * enforce the `ipoMinPriceCr` floor via the share cap.
   */
  ipo(co: Company, sharesTotal: number, floatPct: number, ctx: SimContext, subscribers: readonly string[] = []): IpoResult {
    if (co.isPublic) throw new Error(`exchange: ${co.id} already public`);
    const price = Math.floor(co.valuation(ctx) / sharesTotal);
    if (price < CONFIG.exchange.ipoMinPriceCr) throw new Error(`exchange: ${co.id} IPO price ${price} below floor ${CONFIG.exchange.ipoMinPriceCr}`);
    this.ledger.transfer(`listing ${co.id}`, co.account, ACCT.treasury, "CR", CONFIG.exchange.listingFeeCr);

    co.isPublic = true;
    co.totalShares = sharesTotal;
    co.ipoTick = ctx.tick;
    const floatShares = Math.floor(sharesTotal * floatPct);
    co.floatShares = floatShares;

    // Founder keeps the rest (locked); company treasury holds the float to sell.
    this.credit(co.id, co.ownerId, sharesTotal - floatShares);
    this.credit(co.id, co.account, floatShares);
    this.lastPrice[co.id] = price;
    this.lockups[co.id] = { acct: co.ownerId, until: ctx.tick + CONFIG.exchange.ipoLockupTicks };

    // Primary sale to subscribers at the IPO price.
    let remaining = floatShares;
    let raisedCr = 0;
    const perSub = Math.ceil(floatShares / Math.max(1, subscribers.length));
    for (const acct of subscribers) {
      if (remaining <= 0) break;
      const budget = Math.floor(this.freeCash(acct) * 0.25);
      const q = Math.min(remaining, perSub, Math.floor(budget / price));
      if (q <= 0) continue;
      const cost = price * q;
      const feeCr = Math.floor((cost * CONFIG.exchange.tradingFeeBps) / 10_000);
      this.ledger.post(`ipo ${co.id}`, [
        { account: acct, unit: "CR", delta: -cost },
        { account: co.account, unit: "CR", delta: cost - feeCr },
        { account: ACCT.treasury, unit: "CR", delta: feeCr },
      ]);
      this.credit(co.id, co.account, -q);
      this.credit(co.id, acct, q);
      this.recordTrade({ tick: ctx.tick, companyId: co.id, price, qty: q, buyer: acct, seller: co.account }, true);
      remaining -= q;
      raisedCr += cost - feeCr;
    }

    // List the rest slightly laddered above the IPO reference.
    const lot = Math.ceil(Math.max(1, remaining) / 5);
    for (let i = 0; i < 5 && remaining > 0; i++) {
      const q = Math.min(lot, remaining);
      this.place(co.id, co.account, "ask", Math.round(price * (1 + i * 0.02)), q);
      remaining -= q;
    }
    return { price, floatShares, raisedCr };
  }

  /** Why an order would be rejected, or null if it can be placed. */
  rejectReason(companyId: string, acct: string, side: Side, price: number, qty: number): string | null {
    if (!Number.isInteger(qty) || qty <= 0) return "qty must be a positive integer";
    if (!Number.isInteger(price) || price <= 0) return "price must be a positive integer (CR minor)";
    if (side === "ask") {
      const lock = this.lockups[companyId];
      if (lock && lock.acct === acct && this.ledger.tick < lock.until) return `founder shares locked until tick ${lock.until}`;
      if (this.available(companyId, acct) < qty) return `only ${this.available(companyId, acct)} shares available to sell`;
    } else if (this.freeCash(acct) < price * qty) {
      return `insufficient free cash for bid (${price * qty} needed)`;
    }
    return null;
  }

  /** Place an order and immediately match. Returns order id (0 if rejected). */
  place(companyId: string, acct: string, side: Side, price: number, qty: number): number {
    if (this.rejectReason(companyId, acct, side, price, qty)) return 0;
    if (side === "ask") {
      (this.reserved[companyId] ??= {})[acct] = (this.reserved[companyId]?.[acct] ?? 0) + qty;
    } else {
      this.reservedCr[acct] = (this.reservedCr[acct] ?? 0) + price * qty;
    }
    const order: Order = { id: this.oid++, companyId, acct, side, price, qty };
    const b = this.book(companyId);
    if (side === "bid") {
      b.bids.push(order);
      b.bids.sort((x, y) => y.price - x.price || x.id - y.id);
    } else {
      b.asks.push(order);
      b.asks.sort((x, y) => x.price - y.price || x.id - y.id);
    }
    this.match(order);
    return order.id;
  }

  private releaseBid(o: Order, qty: number): void {
    this.reservedCr[o.acct] -= o.price * qty;
  }

  /**
   * Fill the incoming `taker` against resting orders on the opposite side in
   * price-time priority at the maker's price. Resting orders of the taker's
   * own account are skipped (they stay resting and untouched), so an account
   * can never trade with itself.
   */
  private match(taker: Order): void {
    const b = this.book(taker.companyId);
    const opposite = taker.side === "bid" ? b.asks : b.bids;
    const crosses = (maker: Order): boolean => (taker.side === "bid" ? taker.price >= maker.price : maker.price >= taker.price);
    const fee = CONFIG.exchange.tradingFeeBps;
    let i = 0;
    while (taker.qty > 0 && i < opposite.length && crosses(opposite[i])) {
      const maker = opposite[i];
      if (maker.acct === taker.acct) { i++; continue; }
      const bid = taker.side === "bid" ? taker : maker;
      const ask = taker.side === "bid" ? maker : taker;
      const price = maker.price;
      const qty = Math.min(bid.qty, ask.qty);
      const cost = price * qty;

      // Cash is reserved at placement; if it somehow vanished, cancel the bid.
      if (this.ledger.balance(bid.acct, "CR") < cost) {
        this.releaseBid(bid, bid.qty);
        bid.qty = 0;
        if (bid === maker) opposite.splice(i, 1);
        continue;
      }
      const feeCr = Math.floor((cost * fee) / 10_000);
      this.ledger.post(`trade ${taker.companyId}`, [
        { account: bid.acct, unit: "CR", delta: -cost },
        { account: ask.acct, unit: "CR", delta: cost - feeCr },
        { account: ACCT.treasury, unit: "CR", delta: feeCr },
      ]);

      // Move shares seller -> buyer, release reservations.
      this.credit(taker.companyId, ask.acct, -qty);
      this.credit(taker.companyId, bid.acct, qty);
      this.reserved[taker.companyId][ask.acct] -= qty;
      this.releaseBid(bid, qty);

      bid.qty -= qty;
      ask.qty -= qty;
      this.recordTrade({ tick: this.ledger.tick, companyId: taker.companyId, price, qty, buyer: bid.acct, seller: ask.acct }, false);
      if (maker.qty === 0) opposite.splice(i, 1);
      else i++;
    }
    if (taker.qty === 0) {
      const own = taker.side === "bid" ? b.bids : b.asks;
      const at = own.indexOf(taker);
      if (at >= 0) own.splice(at, 1);
    }
  }

  private recordTrade(trade: Trade, primary: boolean): void {
    this.lastPrice[trade.companyId] = trade.price;
    this.pending.push(trade);
    const recent = (this.recent[trade.companyId] ??= []);
    recent.push(trade);
    if (recent.length > CONFIG.exchange.recentTrades) recent.shift();
    this.tradeCount++;
    if (primary) return;
    const flow = (this.flow[trade.companyId] ??= []);
    const last = flow[flow.length - 1];
    if (last && last.tick === trade.tick) {
      last.qty += trade.qty;
      last.notional += trade.price * trade.qty;
    } else {
      flow.push({ tick: trade.tick, qty: trade.qty, notional: trade.price * trade.qty });
      const keepFrom = trade.tick - CONFIG.exchange.flowTicks;
      while (flow.length && flow[0].tick <= keepFrom) flow.shift();
    }
  }

  /** Cancel all resting orders for an account on a company (releases reserves). */
  cancelAll(companyId: string, acct: string): number {
    const b = this.book(companyId);
    let n = 0;
    for (const o of b.asks) if (o.acct === acct) { this.reserved[companyId][acct] -= o.qty; n++; }
    for (const o of b.bids) if (o.acct === acct) { this.releaseBid(o, o.qty); n++; }
    b.bids = b.bids.filter((o) => o.acct !== acct);
    b.asks = b.asks.filter((o) => o.acct !== acct);
    return n;
  }

  /** Cancel every resting order in a company's book (bankruptcy), releasing all reservations. */
  cancelBook(companyId: string): void {
    const b = this.book(companyId);
    for (const o of b.asks) this.reserved[companyId][o.acct] -= o.qty;
    for (const o of b.bids) this.releaseBid(o, o.qty);
    b.bids = [];
    b.asks = [];
  }

  bestBid(companyId: string): number | undefined {
    return this.book(companyId).bids[0]?.price;
  }
  bestAsk(companyId: string): number | undefined {
    return this.book(companyId).asks[0]?.price;
  }

  /**
   * Distribute `pool` CR of dividends pro-rata to time-weighted holdings over
   * the epoch (excluding the company's own unsold treasury shares). Founder is
   * eligible. Returns the total paid, the per-share rate (floored, CR minor,
   * per average share) and each holder's cut.
   */
  payDividends(co: Company, pool: number, ledger: Ledger): { paid: number; perShare: number; holders: { account: string; amountCr: number }[] } {
    const none = { paid: 0, perShare: 0, holders: [] };
    if (pool <= 0) return none;
    const st = this.shareTicks[co.id];
    if (!st || this.epochSamples === 0) return none;
    let totalTicks = 0;
    for (const [acct, n] of Object.entries(st)) if (acct !== co.account) totalTicks += n;
    if (totalTicks <= 0) return none;
    let paid = 0;
    const holders: { account: string; amountCr: number }[] = [];
    const postings: Posting[] = [{ account: co.account, unit: "CR", delta: 0 }];
    for (const [acct, n] of Object.entries(st)) {
      if (acct === co.account) continue;
      const cut = Math.floor((pool * n) / totalTicks);
      if (cut <= 0) continue;
      postings.push({ account: acct, unit: "CR", delta: cut });
      holders.push({ account: acct, amountCr: cut });
      paid += cut;
    }
    postings[0].delta = -paid;
    if (paid > 0 && ledger.balance(co.account, "CR") >= paid) {
      ledger.post(`dividend ${co.id}`, postings);
      return { paid, perShare: Math.floor((paid * this.epochSamples) / totalTicks), holders };
    }
    return none;
  }

  toJSON(): ExchangeState {
    return cloneExchangeState({
      books: this.books, holdings: this.holdings, reserved: this.reserved, reservedCr: this.reservedCr,
      lastPrice: this.lastPrice, lockups: this.lockups, recent: this.recent, flow: this.flow,
      shareTicks: this.shareTicks, epochSamples: this.epochSamples, oid: this.oid, tradeCount: this.tradeCount,
    });
  }

  restore(state: ExchangeState): void {
    const s = cloneExchangeState(state); // never alias the caller's object
    this.books = s.books;
    this.holdings = s.holdings;
    this.reserved = s.reserved;
    this.reservedCr = s.reservedCr;
    this.lastPrice = s.lastPrice;
    this.lockups = s.lockups;
    this.recent = s.recent;
    this.flow = s.flow;
    this.shareTicks = s.shareTicks;
    this.epochSamples = s.epochSamples;
    this.pending = [];
    this.oid = s.oid;
    this.tradeCount = s.tradeCount;
  }
}

function cloneExchangeState(s: ExchangeState): ExchangeState {
  for (const k of ["books", "holdings", "reserved", "reservedCr", "lastPrice", "lockups", "recent", "flow", "shareTicks", "epochSamples", "oid", "tradeCount"] as const) {
    if (s[k] === undefined) throw new Error(`exchange state: missing field "${k}"`);
  }
  const nested = <T>(r: Record<string, Record<string, T>>): Record<string, Record<string, T>> => {
    const out: Record<string, Record<string, T>> = {};
    for (const [k, v] of Object.entries(r)) out[k] = { ...v };
    return out;
  };
  const books: Record<string, Book> = {};
  for (const [id, b] of Object.entries(s.books)) {
    books[id] = { bids: b.bids.map((o) => ({ ...o })), asks: b.asks.map((o) => ({ ...o })) };
  }
  const recent: Record<string, Trade[]> = {};
  for (const [id, t] of Object.entries(s.recent)) recent[id] = t.map((x) => ({ ...x }));
  const flow: Record<string, Flow[]> = {};
  for (const [id, f] of Object.entries(s.flow)) flow[id] = f.map((x) => ({ ...x }));
  const lockups: Record<string, { acct: string; until: number }> = {};
  for (const [id, l] of Object.entries(s.lockups)) lockups[id] = { ...l };
  return {
    books, holdings: nested(s.holdings), reserved: nested(s.reserved), reservedCr: { ...s.reservedCr },
    lastPrice: { ...s.lastPrice }, lockups, recent, flow, shareTicks: nested(s.shareTicks), epochSamples: s.epochSamples,
    oid: s.oid, tradeCount: s.tradeCount,
  };
}
