import { CONFIG } from "./config.ts";
import type { Game, TickResult } from "./engine.ts";
import { ALL_GOODS, type Good } from "./goods.ts";
import type { GameEventKind } from "./protocol.ts";

/** Acceptance targets for a balanced economy. */
export const BALANCE_TARGETS = {
  maxBandEdgeFraction: 0.1, // no good pinned at a band edge > 10% of ticks
  minPositiveProfitShare: 0.6, // >= 60% of companies profitable over their lifetime
  maxSupplyGrowthPerEpoch: 0.03, // CR supply growth over the last 10 epochs < 3%/epoch
  supplyWindowEpochs: 10,
} as const;

export interface BalanceMetrics {
  ticks: number;
  companies: number;
  publicCount: number;
  graduated: number;
  bankrupt: number;
  bandEdgeFraction: Record<Good, number>;
  maxBandEdgeFraction: number;
  positiveProfitShare: number;
  supplyGrowthPerEpoch: number;
  crSupply: number;
  conserved: boolean;
  overdraftThrows: number;
  shareTrades: number;
  events: Partial<Record<GameEventKind, number>>;
  passes: {
    bandEdge: boolean;
    profit: boolean;
    supply: boolean;
    graduation: boolean; // some but not all public companies graduated
    conserved: boolean;
    overdraft: boolean;
  };
  allPass: boolean;
}

/** Run `ticks` ticks on `game`, sampling balance metrics every tick. Any
 *  exception thrown by the engine (an overdraft would be one) is counted and
 *  aborts the run. */
export function runBalanceProbe(game: Game, ticks: number, onTick?: (r: TickResult) => void): BalanceMetrics {
  const edgeTicks = {} as Record<Good, number>;
  for (const g of ALL_GOODS) edgeTicks[g] = 0;
  const supplyByEpoch: number[] = [game.ledger.supply("CR")];
  const events: Partial<Record<GameEventKind, number>> = {};
  let overdraftThrows = 0;
  let ran = 0;
  const startTrades = game.exchange.tradeCount;

  for (let i = 0; i < ticks; i++) {
    let r: TickResult;
    try {
      r = game.tick();
    } catch (e) {
      overdraftThrows++;
      console.error(`tick ${game.ledger.tick} threw:`, e);
      break;
    }
    ran++;
    for (const g of ALL_GOODS) if (game.market.atBandEdge(g)) edgeTicks[g]++;
    for (const e of r.events) events[e.kind] = (events[e.kind] ?? 0) + 1;
    if (r.tick > 0 && r.tick % CONFIG.ticksPerDay === 0) supplyByEpoch.push(game.ledger.supply("CR"));
    onTick?.(r);
  }

  const bandEdgeFraction = {} as Record<Good, number>;
  let maxBandEdgeFraction = 0;
  for (const g of ALL_GOODS) {
    bandEdgeFraction[g] = ran > 0 ? edgeTicks[g] / ran : 0;
    maxBandEdgeFraction = Math.max(maxBandEdgeFraction, bandEdgeFraction[g]);
  }

  const companies = game.companies.length;
  const positive = game.companies.filter((c) => c.lifetimeProfit > 0).length;
  const positiveProfitShare = companies > 0 ? positive / companies : 0;

  const window = supplyByEpoch.slice(-(BALANCE_TARGETS.supplyWindowEpochs + 1));
  let growth = 0;
  for (let i = 1; i < window.length; i++) growth += window[i] / window[i - 1] - 1;
  const supplyGrowthPerEpoch = window.length > 1 ? growth / (window.length - 1) : 0;

  const publicCount = game.companies.filter((c) => c.isPublic).length;
  const graduated = game.companies.filter((c) => c.isOnChain).length;
  const conserved = game.ledger.conserved().ok;

  const passes = {
    bandEdge: maxBandEdgeFraction <= BALANCE_TARGETS.maxBandEdgeFraction,
    profit: positiveProfitShare >= BALANCE_TARGETS.minPositiveProfitShare,
    supply: supplyGrowthPerEpoch < BALANCE_TARGETS.maxSupplyGrowthPerEpoch,
    graduation: graduated < companies && publicCount > 0,
    conserved,
    overdraft: overdraftThrows === 0,
  };
  return {
    ticks: ran, companies, publicCount, graduated, bankrupt: game.companies.filter((c) => c.bankrupt).length,
    bandEdgeFraction, maxBandEdgeFraction, positiveProfitShare, supplyGrowthPerEpoch,
    crSupply: game.ledger.supply("CR"), conserved, overdraftThrows,
    shareTrades: game.exchange.tradeCount - startTrades, events, passes,
    allPass: Object.values(passes).every(Boolean),
  };
}
