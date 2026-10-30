/**
 * Money units. All balances are stored as INTEGER minor units to guarantee
 * exact conservation in the double-entry ledger (no float drift).
 *
 *  - Credits (CR): the off-chain soft/gameplay currency. 1 CR = 100 cents.
 *  - Econ   ($ECON): the on-chain SPL reserve/memecoin. 1 ECON = 1_000_000 micro.
 *
 * The two are NEVER directly convertible (the economic firewall). $ECON only
 * enters gameplay by buying productive assets; Credits run the simulation.
 */

export type Unit = "CR" | "ECON";

export const CR_MINOR = 100; // cents per credit
export const ECON_MINOR = 1_000_000; // micro per ECON

export const cr = (whole: number): number => Math.round(whole * CR_MINOR);
export const econ = (whole: number): number => Math.round(whole * ECON_MINOR);

export const fromCr = (minor: number): number => minor / CR_MINOR;
export const fromEcon = (minor: number): number => minor / ECON_MINOR;

export function fmt(minor: number, unit: Unit): string {
  if (unit === "CR") return `${(minor / CR_MINOR).toLocaleString("en-US", { maximumFractionDigits: 2 })} CR`;
  return `${(minor / ECON_MINOR).toLocaleString("en-US", { maximumFractionDigits: 4 })} $ECON`;
}
