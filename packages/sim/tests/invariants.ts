import { CONFIG } from "../src/config.ts";
import { Game } from "../src/engine.ts";
import { ALL_GOODS, GOODS } from "../src/goods.ts";
import type { Tester } from "./harness.ts";

/** Core economic invariants over a seeded 300-tick autopilot economy. */
export function run(t: Tester): void {
  const game = new Game(4242);
  game.boot({ players: 6, npcs: 14, investors: 6 });
  const startGrant = CONFIG.player.starterCr + CONFIG.player.companyCapitalCr;

  let conservedEveryTick = true;
  let negativeInventory = false;
  let negativeNonMintBalance = false;
  let ticksAscending = true;
  let eventTicksMatch = true;
  let prev = -1;
  for (let i = 0; i < 300; i++) {
    const r = game.tick();
    if (r.tick !== prev + 1 || game.headTick !== r.tick + 1) ticksAscending = false;
    prev = r.tick;
    if (r.events.some((e) => e.tick !== r.tick)) eventTicksMatch = false;
    if (!game.ledger.conserved().ok) conservedEveryTick = false;
    for (const co of game.companies) for (const g of ALL_GOODS) if (co.inventory[g] < 0) negativeInventory = true;
    for (const a of game.ledger.all()) if (a.kind !== "mint" && (a.bal.CR < 0 || a.bal.ECON < 0)) negativeNonMintBalance = true;
  }

  let negativeShares = false;
  for (const co of game.companies) for (const [, n] of game.exchange.holders(co.id)) if (n < 0) negativeShares = true;

  const cons = game.ledger.conserved();
  t.check("ledger conserved every tick (CR & ECON sum to 0)", conservedEveryTick);
  t.check("final ledger conserved", cons.ok, JSON.stringify(cons.sums));
  t.check("tick() returns consecutive ticks and headTick = tick + 1", ticksAscending);
  t.check("every event is stamped with the tick it happened in", eventTicksMatch);
  t.check("no negative company inventory", !negativeInventory);
  t.check("no negative non-mint balances (no overdrafts)", !negativeNonMintBalance);
  t.check("no negative share holdings", !negativeShares);
  t.check("some companies went public", game.companies.some((c) => c.isPublic));
  t.check("not every company went public", game.companies.some((c) => !c.isPublic));
  t.check("share trades occurred", game.exchange.tradeCount > 0);
  t.check("pump.fun creator fees accrued to treasury", game.chain.totalCreatorFees > 0);
  t.check("goods prices stayed inside the 0.25x-4x band", ALL_GOODS.every((g) => {
    const p = game.market.price(g);
    return p >= GOODS[g].refPrice * CONFIG.market.bandMin - 1 && p <= GOODS[g].refPrice * CONFIG.market.bandMax;
  }));
  const supplyEcon = game.ledger.supply("ECON");
  t.check("$ECON supply positive and finite", supplyEcon > 0 && Number.isFinite(supplyEcon));
  t.check("surplus distributed as dividends", game.dividendsCr > 0, `dividends=${game.dividendsCr}`);
  t.check("at least some firms are profitable", game.companies.some((c) => c.lifetimeProfit > 0));
  t.check("protocol treasury captured fees", game.ledger.balance("treasury", "CR") > 0);
  t.check("labor productivity multiplier stays in [min, max]", (() => {
    const l = game.ctx().labor;
    return l >= CONFIG.households.productivityMin && l <= CONFIG.households.productivityMax;
  })());

  let playerNet = 0;
  for (const p of game.players) {
    playerNet += game.ledger.balance(p.id, "CR");
    for (const co of game.companies) playerNet += game.exchange.shares(co.id, p.id) * (game.exchange.lastPrice[co.id] ?? 0);
    const co = p.companyId ? game.company(p.companyId) : undefined;
    if (co && !co.isPublic) playerNet += Math.max(0, co.bookValue(game.ctx()));
  }
  t.check("autopilot players grew net worth above starting grants", playerNet > game.players.length * startGrant,
    `net=${playerNet} start=${game.players.length * startGrant}`);
}
