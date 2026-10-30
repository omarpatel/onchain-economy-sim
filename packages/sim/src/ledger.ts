import type { Unit } from "./units.ts";

/**
 * Double-entry ledger. Every value movement is a balanced transaction whose
 * postings sum to exactly zero per unit. This is the single source of truth for
 * all money (Credits and $ECON) and makes the whole economy auditable and
 * conservation-checkable.
 *
 * "Source" accounts (the mints) are allowed to carry a negative balance: they
 * represent issuance. The invariant `sum(all balances) === 0` per unit then
 * holds by construction, so total supply === -mintBalance.
 */

export type AccountKind =
  | "mint" // issuance source (may go negative)
  | "burn" // sink
  | "player" // player wallet
  | "company" // company treasury
  | "npc" // npc agent
  | "market" // goods-market counterparty float
  | "treasury" // protocol treasury (fees, creator fees)
  | "escrow" // IPO / order escrow
  | "stake"; // staking vault

export interface Account {
  id: string;
  kind: AccountKind;
  label: string;
  bal: Record<Unit, number>;
}

export interface Posting {
  account: string;
  unit: Unit;
  delta: number; // integer minor units, signed
}

export interface JournalEntry {
  tick: number;
  memo: string;
  postings: Posting[];
}

/** Serialized ledger: balances are the source of truth; the journal is dropped. */
export interface LedgerState {
  tick: number;
  seq: number;
  accounts: { id: string; kind: AccountKind; label: string; CR: number; ECON: number }[];
}

export class Ledger {
  private accounts = new Map<string, Account>();
  readonly journal: JournalEntry[] = [];
  tick = 0;
  private seq = 0;

  open(id: string, kind: AccountKind, label = id): Account {
    if (this.accounts.has(id)) return this.accounts.get(id)!;
    const acct: Account = { id, kind, label, bal: { CR: 0, ECON: 0 } };
    this.accounts.set(id, acct);
    return acct;
  }

  get(id: string): Account {
    const a = this.accounts.get(id);
    if (!a) throw new Error(`ledger: unknown account ${id}`);
    return a;
  }

  has(id: string): boolean {
    return this.accounts.has(id);
  }

  balance(id: string, unit: Unit): number {
    return this.accounts.get(id)?.bal[unit] ?? 0;
  }

  all(): Account[] {
    return [...this.accounts.values()];
  }

  /**
   * Post a balanced transaction. Throws on imbalance or on overdraft of a
   * non-mint account. Returns the journal sequence number.
   */
  post(memo: string, postings: Posting[]): number {
    const sums: Record<Unit, number> = { CR: 0, ECON: 0 };
    for (const p of postings) {
      if (!Number.isInteger(p.delta)) throw new Error(`ledger: non-integer delta in "${memo}"`);
      sums[p.unit] += p.delta;
    }
    if (sums.CR !== 0 || sums.ECON !== 0)
      throw new Error(`ledger: unbalanced "${memo}" (CR=${sums.CR}, ECON=${sums.ECON})`);

    // Validate overdrafts before mutating (transactional).
    for (const p of postings) {
      const a = this.get(p.account);
      const next = a.bal[p.unit] + p.delta;
      if (next < 0 && a.kind !== "mint")
        throw new Error(
          `ledger: overdraft ${a.id}.${p.unit} -> ${next} in "${memo}"`,
        );
    }
    for (const p of postings) this.get(p.account).bal[p.unit] += p.delta;

    this.journal.push({ tick: this.tick, memo, postings });
    // Bound memory for long live sessions; balances are the source of truth.
    if (this.journal.length > 12_000) this.journal.splice(0, 6_000);
    return this.seq++;
  }

  /** Convenience: move `amount` of `unit` from -> to. */
  transfer(memo: string, from: string, to: string, unit: Unit, amount: number): void {
    if (amount < 0) throw new Error(`ledger: negative transfer ${amount}`);
    if (amount === 0) return;
    this.post(memo, [
      { account: from, unit, delta: -amount },
      { account: to, unit, delta: amount },
    ]);
  }

  /** Issue new money from a mint account (mint goes negative). */
  issue(memo: string, mint: string, to: string, unit: Unit, amount: number): void {
    this.transfer(memo, mint, to, unit, amount);
  }

  /** Conservation check: every unit must sum to zero across all accounts. */
  conserved(): { ok: boolean; sums: Record<Unit, number> } {
    const sums: Record<Unit, number> = { CR: 0, ECON: 0 };
    for (const a of this.accounts.values()) {
      sums.CR += a.bal.CR;
      sums.ECON += a.bal.ECON;
    }
    return { ok: sums.CR === 0 && sums.ECON === 0, sums };
  }

  /** Total circulating supply of a unit (= negative of mint balances). */
  supply(unit: Unit): number {
    let s = 0;
    for (const a of this.accounts.values()) if (a.kind === "mint") s -= a.bal[unit];
    return s;
  }

  toJSON(): LedgerState {
    return {
      tick: this.tick,
      seq: this.seq,
      accounts: this.all().map((a) => ({ id: a.id, kind: a.kind, label: a.label, CR: a.bal.CR, ECON: a.bal.ECON })),
    };
  }

  /** Replace all accounts/balances with the serialized state (journal starts empty). */
  restore(state: LedgerState): void {
    this.accounts.clear();
    this.journal.length = 0;
    for (const a of state.accounts) {
      this.accounts.set(a.id, { id: a.id, kind: a.kind, label: a.label, bal: { CR: a.CR, ECON: a.ECON } });
    }
    this.tick = state.tick;
    this.seq = state.seq;
  }
}
