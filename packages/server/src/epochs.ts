import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG } from "@econ-sim/sim/config";
import type { EpochAllocation, GameEvent } from "@econ-sim/sim/protocol";
import { CR_MINOR, ECON_MINOR } from "@econ-sim/sim/units";

/**
 * Credits are the off-chain gameplay currency. CR dividends of graduated
 * companies are converted to $ECON at this fixed peg ONLY to weight the
 * epoch's real dividend pool; the peg never creates an on-chain liability.
 */
export const PEG_USD_PER_CR = 0.01;

/** Oracle updates kept for the $ECON/USD median used at epoch close. */
export const ORACLE_RING = 24;
/** Max relative move of the epoch price versus the previous epoch's price. */
export const ORACLE_MAX_EPOCH_CHANGE = 0.3;

/** CR minor units → $ECON minor units at the peg and the given $ECON/USD price. */
export function crMinorToEconMinor(crMinor: number, econPriceUsd: number): number {
  if (econPriceUsd <= 0) return 0;
  return Math.floor(((crMinor / CR_MINOR) * PEG_USD_PER_CR * ECON_MINOR) / econPriceUsd);
}

/** Median of the ring (average of the two middle values for even lengths); 0 for an empty ring. */
export function medianPrice(ring: readonly number[]): number {
  if (ring.length === 0) return 0;
  const sorted = [...ring].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The oracle price an epoch settles at: ring median, clamped to ±30% of the previous epoch's price. */
export function epochPrice(ring: readonly number[], previous: number | null, fallback: number): number {
  const median = ring.length > 0 ? medianPrice(ring) : fallback;
  if (previous === null || previous <= 0) return median;
  return Math.min(previous * (1 + ORACLE_MAX_EPOCH_CHANGE), Math.max(previous * (1 - ORACLE_MAX_EPOCH_CHANGE), median));
}

type EpochClose = Extract<GameEvent, { kind: "epoch_close" }>;
type Dividend = Extract<GameEvent, { kind: "dividend" }>;

export interface AllocationInputs {
  close: EpochClose;
  dividends: Dividend[];
  /** Ids of every graduated (on-chain) company. */
  onChainCompanies: Set<string>;
  /** playerId → wallet pubkey for SIWS players. */
  pubkeys: Map<string, string>;
  /** wallet pubkey → $ECON minor staked in the on-chain staking program (worker-reported). */
  onchainStakes: Record<string, number>;
  /** $ECON/USD used for the peg conversion (oracle ring median, clamped). */
  econPriceUsd: number;
}

/**
 * Claimable $ECON for one epoch (SyncSpace model: in-sim balances are soft,
 * only observed creator fees back on-chain value):
 *  - `dividend`: CR actually paid this epoch by on-chain companies to
 *    wallet-holding players (time-weighted by the sim), peg-converted, and
 *    used ONLY as weights over the pool `min(pegConvertedTotal, realFeePool)`
 *    where `realFeePool = feesEcon × dividendShareOfFees` when the fee feed is
 *    external, else 0. Rows are scaled down proportionally to fit the pool.
 *  - `yield`: `feesEcon × yieldFrac` (external fees only) pro-rata to the
 *    worker-reported on-chain staking positions; sim stake earns nothing real.
 * `claimant` is the wallet pubkey; guests never receive rows.
 */
export function buildEpochAllocation(input: AllocationInputs): EpochAllocation {
  const { close, pubkeys, onchainStakes, econPriceUsd } = input;
  const realFeesEcon = close.feesExternal ? close.feesEcon : 0;
  const allocations: EpochAllocation["allocations"] = [];

  // ── dividends: weights = peg-converted CR received from on-chain companies ──
  const dividendPool = Math.floor(realFeesEcon * CONFIG.chain.dividendShareOfFees);
  if (dividendPool > 0) {
    const crByPlayer: Record<string, number> = {};
    for (const d of input.dividends) {
      if (!input.onChainCompanies.has(d.companyId)) continue;
      for (const p of d.paid) {
        if (p.amountCr <= 0 || !pubkeys.has(p.account)) continue;
        crByPlayer[p.account] = (crByPlayer[p.account] ?? 0) + p.amountCr;
      }
    }
    const weights: { playerId: string; claimant: string; weight: number }[] = [];
    let pegConvertedTotal = 0;
    for (const playerId of Object.keys(crByPlayer).sort()) {
      const weight = crMinorToEconMinor(crByPlayer[playerId], econPriceUsd);
      if (weight <= 0) continue;
      pegConvertedTotal += weight;
      weights.push({ playerId, claimant: pubkeys.get(playerId) ?? "", weight });
    }
    const pool = Math.min(pegConvertedTotal, dividendPool);
    for (const w of weights) {
      const amountEcon = Math.floor((w.weight * pool) / pegConvertedTotal);
      if (amountEcon > 0) allocations.push({ playerId: w.playerId, claimant: w.claimant, amountEcon, source: "dividend" });
    }
  }

  // ── yield: real fee share pro-rata to on-chain staking positions ──
  const yieldPool = Math.floor(realFeesEcon * CONFIG.chain.yieldFrac);
  if (yieldPool > 0) {
    const stakers = Object.keys(onchainStakes)
      .filter((pk) => onchainStakes[pk] > 0)
      .sort();
    let totalStaked = 0;
    for (const pk of stakers) totalStaked += onchainStakes[pk];
    if (totalStaked > 0) {
      const playerByPubkey: Record<string, string> = {};
      for (const [playerId, pk] of pubkeys) playerByPubkey[pk] = playerId;
      for (const pk of stakers) {
        const amountEcon = Math.floor((yieldPool * onchainStakes[pk]) / totalStaked);
        if (amountEcon > 0) allocations.push({ playerId: playerByPubkey[pk] ?? `sol:${pk}`, claimant: pk, amountEcon, source: "yield" });
      }
    }
  }
  return { epoch: close.epoch, tickClosed: close.tick, allocations };
}

export function writeEpochFile(dataDir: string, alloc: EpochAllocation): string {
  const dir = join(dataDir, "epochs");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${alloc.epoch}.json`);
  writeFileSync(file, JSON.stringify(alloc, null, 2));
  return file;
}
