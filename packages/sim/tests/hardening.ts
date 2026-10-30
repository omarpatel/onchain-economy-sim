import { CONFIG } from "../src/config.ts";
import { Game, JoinError, newDemoGame } from "../src/engine.ts";
import { investorTradeTick } from "../src/npc.ts";
import { cleanName } from "../src/text.ts";
import { ACCT } from "../src/types.ts";
import { cr, econ } from "../src/units.ts";
import type { Tester } from "./harness.ts";

const DAY = CONFIG.ticksPerDay;

/** Take a joined player's company public with a cash windfall so the cap table is predictable. */
function listCompany(game: Game, playerId: string, windfallCr: number, sharesTotal: number, floatPct: number): string {
  const co = game.company(game.player(playerId)!.companyId!)!;
  game.ledger.issue("test: windfall", ACCT.crMint, co.id, "CR", windfallCr);
  const r = game.apply({ id: `ipo-${playerId}`, playerId, intent: { kind: "ipo", sharesTotal, floatPct } });
  if (!r.ok) throw new Error(`ipo failed: ${r.error}`);
  return co.id;
}

/** Economic-exploit regressions from the security review. */
export function run(t: Tester): void {
  // ── cleanName ──
  t.check("cleanName strips control chars, collapses whitespace, trims and caps length",
    cleanName(" \u0000Acme\u0007 \n  Steel\u202e\u200b ") === "Acme Steel" && cleanName("x".repeat(40), 32).length === 32 && cleanName("a".repeat(31) + " b", 32) === "a".repeat(31));
  t.check("cleanName returns \"\" for non-strings and control-only input", cleanName(42) === "" && cleanName(undefined) === "" && cleanName("\u0000\u009f\u200e \t") === "");

  // ── self-trades never fill ──
  {
    const game = newDemoGame({ seed: 31, players: 1, npcs: 2, investors: 3, warmupTicks: 10 });
    game.joinPlayer("p:self", "Self");
    const coId = listCompany(game, "p:self", cr(200_000), 20_000, 0.5);
    const ex = game.exchange;
    const inv = "inv:0";
    const other = "inv:1";
    const px = Math.max(1, Math.floor(ex.lastPrice[coId] / 2)); // below the company's laddered asks
    const held0 = ex.shares(coId, inv);
    const trades0 = ex.tradeCount;
    const last0 = ex.lastPrice[coId];
    t.check("test premise: investor holds IPO shares", held0 >= 20);
    ex.place(coId, inv, "ask", px, 10);
    ex.place(coId, inv, "bid", px, 10);
    t.check("self-crossing bid does not fill against the account's own resting ask (no trade, no price print)",
      ex.shares(coId, inv) === held0 && ex.tradeCount === trades0 && ex.lastPrice[coId] === last0 && ex.ordersOf(inv).length === 2, JSON.stringify(ex.ordersOf(inv)));
    const heldOther0 = ex.shares(coId, other);
    ex.place(coId, other, "ask", px, 10);
    ex.place(coId, inv, "bid", px, 20);
    t.check("a bid skips the account's own ask but still fills another maker's ask behind it",
      ex.shares(coId, inv) === held0 + 10 && ex.shares(coId, other) === heldOther0 - 10 && ex.tradeCount === trades0 + 1
      && ex.ordersOf(inv).filter((o) => o.side === "ask").length === 1 && ex.ordersOf(inv).filter((o) => o.side === "bid").reduce((a, o) => a + o.qty, 0) === 20,
      JSON.stringify(ex.ordersOf(inv)));
    t.check("ledger still conserved after self-cross attempts", game.ledger.conserved().ok);

    // Passive NPC quotes anchor on fair value even when the last print is absurd.
    const co = game.company(coId)!;
    const fair = Math.max(1, Math.round(co.valuation(game.ctx()) / co.totalShares));
    ex.cancelAll(coId, "inv:2");
    ex.lastPrice[coId] = fair * 10;
    investorTradeTick("inv:2", co, game, 0.15);
    const quotes = ex.ordersOf("inv:2").filter((o) => o.companyId === coId);
    t.check("investor never bids above / asks below the +-5% fair-value band, ignoring a manipulated last price",
      quotes.length > 0 && quotes.every((o) => (o.side === "bid" ? o.price <= fair * 1.05 + 1 : o.price >= fair * 0.95 - 1)), JSON.stringify({ fair, quotes }));
  }

  // ── graduation needs traded evidence ──
  {
    const game = new Game(41);
    game.boot({ players: 0, npcs: 0, investors: 0 });
    game.joinPlayer("p:founder", "Founder");
    const co = game.company(game.player("p:founder")!.companyId!)!;
    game.ledger.issue("test: windfall", ACCT.crMint, co.id, "CR", cr(1_000_000));
    const maxShares = Math.min(CONFIG.exchange.ipoMaxShares, Math.floor(co.valuation(game.ctx()) / CONFIG.exchange.ipoMinPriceCr));
    const r = game.apply({ id: "ipo", playerId: "p:founder", intent: { kind: "ipo", sharesTotal: maxShares, floatPct: 0.4 } });
    t.check("IPO at the share cap is accepted", r.ok, r.error);
    game.run(3 * DAY);
    const g0 = game.companyView(co).graduationProgress;
    t.check("max-share IPO with zero secondary trades does NOT graduate even though lastPrice x shares exceeds the cap",
      !co.isOnChain && game.exchange.marketCap(co) > CONFIG.chain.graduateMarketCapCr && g0.epochsPublic >= 2 && g0.vwapCapCr === 0 && g0.volumePctFloat === 0, JSON.stringify(g0));

    game.joinPlayer("p:trader", "Trader");
    game.ledger.issue("test: trader cash", ACCT.crMint, "p:trader", "CR", cr(100_000));
    const want = Math.ceil(co.floatShares * CONFIG.chain.graduateMinVolumeOfFloat);
    const top = Math.round(game.exchange.lastPrice[co.id] * 1.1);
    const buy = game.apply({ id: "buy", playerId: "p:trader", intent: { kind: "place_order", companyId: co.id, side: "bid", priceCr: top, qty: want } });
    t.check("trader lifts >= 5% of the float from the laddered asks", buy.ok && game.exchange.shares(co.id, "p:trader") >= want, buy.error);
    while (game.headTick % DAY !== 1) game.tick();
    const g1 = game.companyView(co).graduationProgress;
    t.check("with >= 2 epochs public, VWAP cap above the threshold and >= 5% float traded, the company graduates at the epoch close",
      co.isOnChain && g1.vwapCapCr > CONFIG.chain.graduateMarketCapCr && g1.volumePctFloat >= CONFIG.chain.graduateMinVolumeOfFloat, JSON.stringify(g1));
  }

  // ── time-weighted dividends ──
  {
    const game = new Game(43);
    game.boot({ players: 0, npcs: 0, investors: 0 });
    game.joinPlayer("p:a", "A");
    game.joinPlayer("p:b", "B");
    game.joinPlayer("p:c", "C");
    const coId = listCompany(game, "p:a", cr(500_000), 10_000, 0.4);
    const co = game.company(coId)!;
    game.apply({ id: "policy", playerId: "p:a", intent: { kind: "set_dividend_policy", payoutRatio: 1 } });
    game.ledger.issue("test: cash", ACCT.crMint, "p:b", "CR", cr(100_000));
    game.ledger.issue("test: cash", ACCT.crMint, "p:c", "CR", cr(100_000));
    while (game.headTick % DAY !== 1) game.tick(); // first tick of a fresh epoch
    const askTop = Math.round(game.exchange.lastPrice[coId] * 1.1);
    const b = game.apply({ id: "b", playerId: "p:b", intent: { kind: "place_order", companyId: coId, side: "bid", priceCr: askTop, qty: 1_000 } });
    t.check("B buys 1,000 shares on the first tick of the epoch", b.ok && game.exchange.shares(coId, "p:b") === 1_000, b.error);
    while (game.headTick % DAY !== 0) game.tick(); // head = closing tick
    const c = game.apply({ id: "c", playerId: "p:c", intent: { kind: "place_order", companyId: coId, side: "bid", priceCr: askTop, qty: 1_000 } });
    t.check("C buys 1,000 shares on the closing tick", c.ok && game.exchange.shares(coId, "p:c") === 1_000, c.error);
    co.epochProfitCr = cr(169_000);
    const cashB = game.ledger.balance("p:b", "CR");
    const cashC = game.ledger.balance("p:c", "CR");
    const ev = game.tick().events.find((e) => e.kind === "dividend" && e.companyId === coId);
    const paidB = game.ledger.balance("p:b", "CR") - cashB;
    const paidC = game.ledger.balance("p:c", "CR") - cashC;
    t.check("dividend paid to both holders", ev?.kind === "dividend" && paidB > 0 && paidC > 0, JSON.stringify(ev));
    t.check("holder present for 1 of 24 ticks gets ~1/24 of the full-epoch holder's dividend", Math.abs(paidC * DAY - paidB) <= DAY, `B=${paidB} C=${paidC}`);
    t.check("dividend event lists each holder's time-weighted cut", ev?.kind === "dividend"
      && ev.paid.find((p) => p.account === "p:b")?.amountCr === paidB && ev.paid.find((p) => p.account === "p:c")?.amountCr === paidC
      && ev.paid.every((p) => p.account !== coId) && ev.paid.reduce((a, p) => a + p.amountCr, 0) === ev.poolCr);
    t.check("twaHoldings resets at the epoch close", game.exchange.twaHoldings(coId).length === 0);
    game.tick();
    const twa = Object.fromEntries(game.exchange.twaHoldings(coId));
    t.check("twaHoldings after one tick of the new epoch equals current holdings (treasury excluded)",
      twa["p:b"] === 1_000 && twa["p:c"] === 1_000 && twa["p:a"] === 6_000 && twa[coId] === undefined, JSON.stringify(twa));
  }

  // ── joinPlayer limits ──
  {
    const game = new Game(47);
    game.boot({ players: 0, npcs: 0, investors: 0 });
    for (let i = 0; i < CONFIG.player.maxPlayers; i++) game.joinPlayer(`p:${i}`, `P${i}`);
    let err: unknown;
    try { game.joinPlayer("p:overflow", "Late"); } catch (e) { err = e; }
    t.check("joinPlayer throws JoinError(max_players) beyond CONFIG.player.maxPlayers without mutating state",
      err instanceof JoinError && err.code === "max_players" && game.players.length === CONFIG.player.maxPlayers && game.player("p:overflow") === undefined);
    t.check("joinPlayer stays idempotent for existing players at the cap", game.joinPlayer("p:0", "P0").playerId === "p:0");
    t.check("joinPlayer sanitizes the display name", game.joinPlayer("p:1", "x").playerId === "p:1" && game.player("p:1")!.name === "P1"
      && (() => { const g = new Game(48); g.boot({ players: 0, npcs: 0, investors: 0 }); g.joinPlayer("p:n", " Bad\u0000  Name "); return g.player("p:n")!.name === "Bad Name"; })());

    const full = new Game(49);
    full.boot({ players: 0, npcs: 0, investors: 0 });
    for (const tile of full.map.freePlainTiles()) tile.ownerId = "test:squatter";
    const companies = full.companies.length;
    err = undefined;
    try { full.joinPlayer("p:nowhere", "Nowhere"); } catch (e) { err = e; }
    t.check("joinPlayer throws JoinError(map_full) when no HQ tile is free, without founding anything",
      err instanceof JoinError && err.code === "map_full" && full.players.length === 0 && full.companies.length === companies && full.ledger.balance("p:nowhere", "CR") === 0);
  }

  // ── NPC managers leave the HQ reserve alone ──
  {
    const game = new Game(53);
    game.boot({ players: 0, npcs: 6, investors: 2 });
    const reserve = CONFIG.player.reservedHqTiles;
    const free = game.map.freePlainTiles();
    for (const tile of free.slice(reserve)) tile.ownerId = "test:squatter"; // leave exactly the reserve
    for (const co of game.companies) game.ledger.issue("test: rich npc", ACCT.crMint, co.id, "CR", cr(2_000_000));
    game.run(60);
    t.check("NPC managers never claim a free tile once only the HQ reserve remains", game.map.freePlainTiles().length === reserve, `${game.map.freePlainTiles().length}`);
    const view = game.joinPlayer("p:late", "Late");
    const co = game.company(view.company!.id)!;
    const target = game.map.freePlainTiles().find((x) => !game.buildingOn(x.id) && Object.keys(x.resources).length === 0)!;
    const r = game.apply({ id: "b", playerId: "p:late", intent: { kind: "build", buildingType: "sawmill", x: target.x, y: target.y } });
    t.check("a player can still join and build on the reserved tiles", r.ok && target.ownerId === co.id, r.error);
  }
  {
    const game = new Game(59);
    game.boot({ players: 0, npcs: 24, investors: 8 });
    game.run(1000);
    let joined = 0;
    for (let i = 0; i < 20; i++) {
      try { game.joinPlayer(`p:new${i}`, `New${i}`); joined++; } catch { break; }
    }
    t.check("after 24 NPCs run 1000 ticks, 20 players can still join", joined === 20, `joined ${joined}, free ${game.map.freePlainTiles().length}`);
    t.check("ledger conserved after the long NPC run", game.ledger.conserved().ok);
  }

  // ── epochSettle reports whether fees were externally observed ──
  {
    const game = new Game(61);
    game.boot({ players: 0, npcs: 0, investors: 0 });
    game.chain.setExternalCreatorFees(econ(1));
    let close = game.tick().events.find((e) => e.kind === "epoch_close");
    for (let i = 0; i < DAY && !close; i++) close = game.tick().events.find((e) => e.kind === "epoch_close");
    t.check("epoch_close.feesExternal is true when every fee tick came from the pinned feed",
      close?.kind === "epoch_close" && close.feesExternal && close.feesEcon === (DAY + 1) * econ(1), JSON.stringify(close));
    game.tick();
    game.chain.setExternalCreatorFees(null);
    close = undefined;
    for (let i = 0; i < DAY && !close; i++) close = game.tick().events.find((e) => e.kind === "epoch_close");
    t.check("epoch_close.feesExternal is false once any tick in the epoch used the simulated volume model",
      close?.kind === "epoch_close" && !close.feesExternal && close.feesEcon > 0, JSON.stringify(close));
  }
}
