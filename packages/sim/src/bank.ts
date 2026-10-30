import { CONFIG } from "./config.ts";
import type { Company } from "./company.ts";
import { ACCT, type SimContext } from "./types.ts";

/**
 * Central bank / lender. Loans are credit creation: principal is minted from the
 * CR mint into the borrower and burned back on repayment (money-supply expansion
 * and contraction). Interest flows to the protocol treasury. A credit score from
 * leverage and profitability sets each company's borrowing limit and rate.
 * The bank is stateless: everything it needs lives on the company and ledger.
 */
export class Bank {
  creditScore(co: Company, ctx: SimContext): number {
    const equity = Math.max(1, co.bookValue(ctx));
    const leverage = co.debt / equity;
    let score = 850 - leverage * 180;
    score += co.smoothedProfit() > 0 ? 40 : -150;
    return Math.round(Math.max(CONFIG.bank.minCreditScore, Math.min(CONFIG.bank.maxCreditScore, score)));
  }

  /** Per-tick interest rate in basis points, worse credit pays more
   *  (base .. base + (max-min)/rateSlope, i.e. ~0.5%..2% per day). */
  rateBps(score: number): number {
    return CONFIG.bank.baseRateBpsPerTick + (CONFIG.bank.maxCreditScore - score) / CONFIG.bank.rateSlope;
  }

  maxNewLoan(co: Company, ctx: SimContext): number {
    if (this.creditScore(co, ctx) < CONFIG.bank.minCreditScore + 1) return 0;
    const equity = Math.max(0, co.bookValue(ctx));
    const cap = Math.round(equity * CONFIG.bank.maxLoanToEquity);
    return Math.max(0, cap - co.debt);
  }

  /** Mint up to `amount` (bounded by the credit limit) into the company. Returns the principal issued. */
  lend(co: Company, amount: number, ctx: SimContext): number {
    const limit = this.maxNewLoan(co, ctx);
    const take = Math.min(Math.floor(amount), limit);
    if (take <= 0) return 0;
    ctx.ledger.issue(`loan ${co.id}`, ACCT.crMint, co.account, "CR", take);
    co.debt += take;
    return take;
  }

  repay(co: Company, amount: number, ctx: SimContext): number {
    const pay = Math.min(Math.floor(amount), co.debt, ctx.ledger.balance(co.account, "CR"));
    if (pay <= 0) return 0;
    ctx.ledger.transfer(`repay ${co.id}`, co.account, ACCT.crMint, "CR", pay); // burn back to mint
    co.debt -= pay;
    return pay;
  }

  /** Accrue and collect interest. Unpayable interest capitalizes into principal. */
  accrueTick(co: Company, ctx: SimContext): number {
    if (co.debt <= 0) return 0;
    const bps = this.rateBps(this.creditScore(co, ctx));
    const interest = Math.round((co.debt * bps) / 10_000);
    if (interest <= 0) return 0;
    const cash = ctx.ledger.balance(co.account, "CR");
    if (cash >= interest) {
      ctx.ledger.transfer(`interest ${co.id}`, co.account, ACCT.treasury, "CR", interest);
      co.charge("interest", interest);
    } else {
      co.debt += interest; // capitalize -> raises leverage, hurts score
    }
    return interest;
  }
}
