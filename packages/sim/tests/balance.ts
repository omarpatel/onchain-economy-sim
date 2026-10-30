import { Game } from "../src/engine.ts";
import { BALANCE_TARGETS, runBalanceProbe } from "../src/metrics.ts";
import type { GameEventKind } from "../src/protocol.ts";
import type { Tester } from "./harness.ts";

/** The acceptance run: 720 ticks, 12 autopilot players, 40 NPC firms. */
export function run(t: Tester): void {
  const game = new Game(1337);
  game.boot({ players: 12, npcs: 40, investors: 8 });
  const m = runBalanceProbe(game, 720);

  t.check(`no good sits at a band edge > ${BALANCE_TARGETS.maxBandEdgeFraction * 100}% of ticks (max ${(m.maxBandEdgeFraction * 100).toFixed(1)}%)`, m.passes.bandEdge);
  t.check(`>= ${BALANCE_TARGETS.minPositiveProfitShare * 100}% of companies profitable (${(m.positiveProfitShare * 100).toFixed(0)}%)`, m.passes.profit);
  t.check(`CR supply growth < ${BALANCE_TARGETS.maxSupplyGrowthPerEpoch * 100}%/epoch over last ${BALANCE_TARGETS.supplyWindowEpochs} epochs (${(m.supplyGrowthPerEpoch * 100).toFixed(2)}%)`, m.passes.supply);
  t.check(`some public companies, not all graduated (${m.publicCount} public, ${m.graduated} graduated of ${m.companies})`, m.passes.graduation);
  t.check("ledger conserved", m.passes.conserved);
  t.check("zero overdraft / engine throws", m.passes.overdraft);

  const expected: GameEventKind[] = [
    "build_started", "build_live", "land_bought", "ipo", "share_trade", "dividend", "loan", "repaid",
    "staked", "epoch_close", "market_flow", "price_alert",
  ];
  const missing = expected.filter((k) => !(m.events[k] ?? 0));
  t.check("every routine event kind was emitted during the run", missing.length === 0, `missing: ${missing.join(", ")}`);
  t.check("market_flow is emitted at most once per good per tick", (m.events.market_flow ?? 0) <= m.ticks * 14);
}
