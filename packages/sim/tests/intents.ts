import { CONFIG } from "../src/config.ts";
import { Game, newDemoGame } from "../src/engine.ts";
import { RECIPES } from "../src/goods.ts";
import { LOGI } from "../src/logistics.ts";
import type { Tile } from "../src/map.ts";
import type { Intent, IntentResult } from "../src/protocol.ts";
import { ACCT } from "../src/types.ts";
import { cr, econ } from "../src/units.ts";
import type { Tester } from "./harness.ts";

const P = "p:test";
let seq = 0;

function send(game: Game, intent: Intent, playerId = P): IntentResult {
  return game.apply({ id: `i${seq++}`, playerId, intent });
}

function freePlain(game: Game, near: Tile, exclude: (t: Tile) => boolean = () => false): Tile {
  const t = game.map.freePlainTiles()
    .filter((x) => !game.buildingOn(x.id) && Object.keys(x.resources).length === 0 && !exclude(x))
    .sort((a, z) => game.map.distance(a, near) - game.map.distance(z, near))[0];
  if (!t) throw new Error("no free plain tile");
  return t;
}

/** Every intent kind: at least one happy path and one rejection each. */
export function run(t: Tester): void {
  const game = newDemoGame({ seed: 2024, players: 2, npcs: 6, investors: 4, warmupTicks: 48 });

  // ── join ──
  const view = game.joinPlayer(P, "Tester");
  const co = game.company(view.company!.id)!;
  const hq = game.map.tile(co.hubTileId);
  t.check("joinPlayer grants starter CR + $ECON and founds a company", view.cashCr === CONFIG.player.starterCr && view.econ === CONFIG.player.starterEcon && view.company !== null);
  t.check("joined player's company is NOT on autopilot", view.company!.autopilot === false);
  t.check("founding company owns its HQ tile and a live starter extractor", hq.ownerId === co.id && co.buildings.length === 1 && co.buildings[0].liveAtTick <= game.headTick);
  const again = game.joinPlayer(P, "Tester");
  t.check("joinPlayer is idempotent", again.company!.id === co.id && again.cashCr === view.cashCr && game.players.filter((p) => p.id === P).length === 1);
  t.check("HQ is spread away from existing HQs", game.companies.every((c) => c === co || game.map.distance(game.map.tile(c.hubTileId), hq) >= 2));
  t.throws("playerView throws for unknown player", () => game.playerView("nobody"));

  // ── build ──
  const tile = freePlain(game, hq);
  const cashBefore = game.ledger.balance(co.id, "CR");
  let r = send(game, { kind: "build", buildingType: "smelter", x: tile.x, y: tile.y });
  const built = co.buildings.find((b) => b.tileId === tile.id);
  t.check("build: buys the land and starts construction", r.ok && !!built && tile.ownerId === co.id
    && game.ledger.balance(co.id, "CR") === cashBefore - tile.priceCr - RECIPES.smelter.buildCostCr, r.error);
  let events = game.tick().events;
  t.check("build: build_started + land_bought events surface on the next tick",
    events.some((e) => e.kind === "build_started" && e.buildingId === built?.id) && events.some((e) => e.kind === "land_bought" && e.tileId === tile.id && e.unit === "CR"));
  for (let i = 0; i < RECIPES.smelter.buildTicks; i++) events = game.tick().events;
  t.check("build: build_live fires when construction completes", events.some((e) => e.kind === "build_live" && e.buildingId === built?.id) || game.headTick > built!.liveAtTick);
  r = send(game, { kind: "build", buildingType: "mine", x: freePlain(game, hq).x, y: freePlain(game, hq).y });
  t.check("build: extractor off its resource is rejected", !r.ok && /iron tile/.test(r.error ?? ""), r.error);
  const premium = game.map.tiles.find((x) => x.premium && !x.ownerId)!;
  r = send(game, { kind: "build", buildingType: "sawmill", x: premium.x, y: premium.y });
  t.check("build: premium tile requires buy_land first", !r.ok && /premium/.test(r.error ?? ""), r.error);
  const foreign = game.map.tiles.find((x) => x.ownerId && x.ownerId !== co.id && !game.buildingOn(x.id))!;
  r = send(game, { kind: "build", buildingType: "sawmill", x: foreign.x, y: foreign.y });
  t.check("build: someone else's tile is rejected", !r.ok && /owned/.test(r.error ?? ""), r.error);
  r = send(game, { kind: "build", buildingType: "castle" as never, x: tile.x, y: tile.y });
  t.check("build: unknown building type is rejected", !r.ok);
  r = send(game, { kind: "build", buildingType: "sawmill", x: tile.x, y: tile.y });
  t.check("build: occupied tile is rejected", !r.ok && /already has a building/.test(r.error ?? ""), r.error);

  // ── demolish ──
  r = send(game, { kind: "demolish", buildingId: built!.id });
  t.check("demolish: removes the building, land stays owned, no refund", r.ok && !co.building(built!.id) && tile.ownerId === co.id, r.error);
  t.check("demolish: demolished event", game.tick().events.some((e) => e.kind === "demolished" && e.buildingId === built!.id));
  r = send(game, { kind: "demolish", buildingId: "nope" });
  t.check("demolish: unknown building is rejected", !r.ok);

  // ── buy_land ──
  const land = freePlain(game, hq, (x) => x.id === tile.id);
  const treasuryBefore = game.ledger.balance(ACCT.treasury, "CR");
  r = send(game, { kind: "buy_land", x: land.x, y: land.y });
  t.check("buy_land: common tile paid in CR to treasury", r.ok && land.ownerId === co.id && game.ledger.balance(ACCT.treasury, "CR") === treasuryBefore + land.priceCr, r.error);
  r = send(game, { kind: "buy_land", x: land.x, y: land.y });
  t.check("buy_land: already-owned tile is rejected", !r.ok);
  const econBefore = game.ledger.balance(P, "ECON");
  r = send(game, { kind: "buy_land", x: premium.x, y: premium.y });
  const nft = game.chain.landNfts.find((n) => n.tileId === premium.id);
  t.check("buy_land: premium tile paid in $ECON, NFT minted to player, tile owned by company",
    r.ok && premium.ownerId === co.id && nft?.owner === P && game.ledger.balance(P, "ECON") === econBefore - premium.priceEcon, r.error);
  t.check("buy_land: land_bought ECON event carries the nft id", game.tick().events.some((e) => e.kind === "land_bought" && e.unit === "ECON" && e.nft === nft?.id));
  r = send(game, { kind: "build", buildingType: "sawmill", x: premium.x, y: premium.y });
  t.check("build: allowed on owned premium tile", r.ok, r.error);

  // ── buy_good / sell_good ──
  const invBefore = co.inventory.iron_ore;
  const quote = game.market.quoteBuy("iron_ore", 10);
  const cash0 = game.ledger.balance(co.id, "CR");
  r = send(game, { kind: "buy_good", good: "iron_ore", qty: 10 });
  t.check("buy_good: inventory +qty, cash -quote", r.ok && co.inventory.iron_ore === invBefore + 10 && game.ledger.balance(co.id, "CR") === cash0 - quote, r.error);
  r = send(game, { kind: "buy_good", good: "iron_ore", qty: 0 });
  t.check("buy_good: qty 0 is rejected", !r.ok);
  r = send(game, { kind: "buy_good", good: "iron_ore", qty: game.market.available("iron_ore") + 1 });
  t.check("buy_good: more than the float holds is rejected", !r.ok && /only/.test(r.error ?? ""), r.error);
  r = send(game, { kind: "buy_good", good: "gold" as never, qty: 1 });
  t.check("buy_good: unknown good is rejected", !r.ok);
  r = send(game, { kind: "sell_good", good: "iron_ore", qty: 5 });
  t.check("sell_good: inventory -qty", r.ok && co.inventory.iron_ore === invBefore + 5, r.error);
  r = send(game, { kind: "sell_good", good: "iron_ore", qty: co.inventory.iron_ore + 1 });
  t.check("sell_good: more than inventory is rejected", !r.ok);

  // ── set_sell_policy ── (iron_ore: the company has no smelter, so any stock is surplus)
  r = send(game, { kind: "set_sell_policy", good: "iron_ore", mode: "hold" });
  send(game, { kind: "buy_good", good: "iron_ore", qty: 40 });
  const held0 = co.inventory.iron_ore;
  game.run(2);
  t.check("set_sell_policy hold: surplus stock is NOT auto-sold in produceTick", r.ok && co.sellPolicy.iron_ore === "hold" && co.inventory.iron_ore >= held0 && held0 >= 40, `${held0} -> ${co.inventory.iron_ore}`);
  r = send(game, { kind: "set_sell_policy", good: "iron_ore", mode: "auto" });
  game.run(1);
  t.check("set_sell_policy auto: surplus is sold again", r.ok && co.sellPolicy.iron_ore === undefined && co.inventory.iron_ore === 0, `${co.inventory.iron_ore}`);
  r = send(game, { kind: "set_sell_policy", good: "iron_ore", mode: "dump" as never });
  t.check("set_sell_policy: bad mode is rejected", !r.ok);

  // ── borrow / repay ──
  const limit = game.bank.maxNewLoan(co, game.ctx());
  r = send(game, { kind: "borrow", amountCr: limit + 1 });
  t.check("borrow: above credit limit is rejected", !r.ok && /credit limit/.test(r.error ?? ""), r.error);
  r = send(game, { kind: "borrow", amountCr: 12.5 });
  t.check("borrow: non-integer is rejected", !r.ok);
  const cashB = game.ledger.balance(co.id, "CR");
  r = send(game, { kind: "borrow", amountCr: 100_000 });
  t.check("borrow: mints principal into the company", r.ok && co.debt === 100_000 && game.ledger.balance(co.id, "CR") === cashB + 100_000, r.error);
  t.check("borrow: loan event with rate", game.tick().events.some((e) => e.kind === "loan" && e.companyId === co.id && e.rateBps > 0));
  r = send(game, { kind: "repay", amountCr: co.debt + 1 });
  t.check("repay: more than debt is rejected", !r.ok);
  r = send(game, { kind: "repay", amountCr: co.debt });
  t.check("repay: clears debt", r.ok && co.debt === 0, r.error);
  t.check("repay: repaid event", game.tick().events.some((e) => e.kind === "repaid" && e.companyId === co.id));

  // ── buy_truck ──
  r = send(game, { kind: "buy_truck" });
  t.check("buy_truck: fleet grows", r.ok && co.trucks === 2, r.error);

  // ── ipo ──
  r = send(game, { kind: "ipo", sharesTotal: 100_000, floatPct: 0.05 });
  t.check("ipo: float below 10% is rejected", !r.ok);
  r = send(game, { kind: "ipo", sharesTotal: 10, floatPct: 0.4 });
  t.check("ipo: too few shares is rejected", !r.ok);
  const val0 = co.valuation(game.ctx());
  const maxShares = Math.floor(val0 / CONFIG.exchange.ipoMinPriceCr);
  r = send(game, { kind: "ipo", sharesTotal: maxShares + 1, floatPct: 0.4 });
  t.check("ipo: more shares than valuation / price floor is rejected", !r.ok && /at most/.test(r.error ?? ""), r.error);
  const sharesTotal = 10_000;
  t.check("test premise: 10k shares fit under the price floor", sharesTotal <= maxShares, `max ${maxShares}`);
  r = send(game, { kind: "ipo", sharesTotal, floatPct: 0.4 });
  const ipoEvents = game.tick().events;
  const ipoEv = ipoEvents.find((e) => e.kind === "ipo" && e.companyId === co.id);
  t.check("ipo: company goes public, founder holds 60%", r.ok && co.isPublic && game.exchange.shares(co.id, P) === 6_000, r.error);
  t.check("ipo: event reports float and capital raised from subscribers", ipoEv?.kind === "ipo" && ipoEv.floatShares === 4_000 && ipoEv.raisedCr > 0);
  t.check("ipo: price is at least the floor and price x shares <= pre-IPO valuation", ipoEv?.kind === "ipo" && ipoEv.priceCr >= CONFIG.exchange.ipoMinPriceCr && ipoEv.priceCr * sharesTotal <= val0);
  r = send(game, { kind: "ipo", sharesTotal, floatPct: 0.4 });
  t.check("ipo: already public is rejected", !r.ok);

  // ── set_dividend_policy ──
  r = send(game, { kind: "set_dividend_policy", payoutRatio: 0.8 });
  t.check("set_dividend_policy: within [0,1]", r.ok && co.dividendPayoutRatio === 0.8);
  r = send(game, { kind: "set_dividend_policy", payoutRatio: 1.5 });
  t.check("set_dividend_policy: >1 is rejected", !r.ok);

  // ── place_order / lockup / cancel_orders ──
  const px = game.exchange.lastPrice[co.id];
  r = send(game, { kind: "place_order", companyId: co.id, side: "ask", priceCr: px, qty: 10 });
  t.check("place_order: founder ask during lockup is rejected", !r.ok && /locked until/.test(r.error ?? ""), r.error);
  const wallet = game.ledger.balance(P, "CR");
  r = send(game, { kind: "place_order", companyId: co.id, side: "bid", priceCr: px, qty: Math.floor(wallet / px) + 1000 });
  t.check("place_order: bid beyond free cash is rejected", !r.ok && /insufficient free cash/.test(r.error ?? ""), r.error);
  const priv = game.companies.find((c) => !c.isPublic)!;
  r = send(game, { kind: "place_order", companyId: priv.id, side: "bid", priceCr: 100, qty: 1 });
  t.check("place_order: private company is rejected", !r.ok);
  r = send(game, { kind: "place_order", companyId: co.id, side: "bid", priceCr: Math.max(1, Math.round(px * 0.5)), qty: 100 });
  const pv = game.playerView(P);
  t.check("place_order: low bid rests in the book, cash reserved", r.ok && pv.orders.length === 1 && game.exchange.freeCash(P) === wallet - pv.orders[0].priceCr * 100, r.error);
  r = send(game, { kind: "cancel_orders", companyId: co.id });
  t.check("cancel_orders: releases the reservation", r.ok && game.playerView(P).orders.length === 0 && game.exchange.freeCash(P) === wallet, r.error);
  r = send(game, { kind: "cancel_orders", companyId: co.id });
  t.check("cancel_orders: nothing to cancel is rejected", !r.ok);
  const unlockAt = game.exchange.lockedUntil(co.id);
  t.check("founderLockedUntilTick = ipoTick + lockup", game.playerView(P).company!.founderLockedUntilTick === co.ipoTick + CONFIG.exchange.ipoLockupTicks && unlockAt === co.ipoTick + CONFIG.exchange.ipoLockupTicks);
  while (game.headTick < unlockAt) game.tick();
  const held = game.exchange.shares(co.id, P);
  const wallet1 = game.ledger.balance(P, "CR");
  const bestBid = game.exchange.bestBid(co.id);
  const bestAsk = game.exchange.bestAsk(co.id);
  t.check("book has liquidity from NPC investors", bestBid !== undefined || bestAsk !== undefined, JSON.stringify(game.exchange.depth(co.id, 2)));
  if (bestBid !== undefined) {
    r = send(game, { kind: "place_order", companyId: co.id, side: "ask", priceCr: bestBid, qty: 10 });
    t.check("place_order: founder's marketable ask fills against resting bids after the lockup",
      r.ok && game.exchange.shares(co.id, P) === held - 10 && game.ledger.balance(P, "CR") > wallet1, r.error);
    t.check("share_trade event with player as seller", game.tick().events.some((e) => e.kind === "share_trade" && e.companyId === co.id && e.seller === P));
  } else {
    r = send(game, { kind: "place_order", companyId: co.id, side: "bid", priceCr: bestAsk!, qty: 10 });
    t.check("place_order: marketable bid fills against the resting ask",
      r.ok && game.exchange.shares(co.id, P) === held + 10 && game.ledger.balance(P, "CR") < wallet1, r.error);
    t.check("share_trade event with player as buyer", game.tick().events.some((e) => e.kind === "share_trade" && e.companyId === co.id && e.buyer === P));
  }
  const held2 = game.exchange.shares(co.id, P);
  r = send(game, { kind: "place_order", companyId: co.id, side: "ask", priceCr: Math.round(px * 3), qty: 10 });
  t.check("place_order: founder's resting ask reserves shares after the lockup", r.ok && game.exchange.available(co.id, P) === held2 - 10, r.error);
  send(game, { kind: "cancel_orders", companyId: co.id });
  t.check("cancel_orders: releases reserved shares", game.exchange.available(co.id, P) === held2);

  // ── stake / unstake ──
  const w0 = game.ledger.balance(P, "ECON");
  const vault0 = game.ledger.balance(ACCT.stakeVault, "ECON");
  r = send(game, { kind: "stake", amountEcon: w0 + 1 });
  t.check("stake: more than the wallet holds is rejected", !r.ok);
  r = send(game, { kind: "stake", amountEcon: econ(100) });
  t.check("stake: moves $ECON to the vault and boosts the company", r.ok && co.stakedEcon === econ(100) && game.chain.stakeOf(P, co.id) === econ(100)
    && game.ledger.balance(ACCT.stakeVault, "ECON") === vault0 + econ(100) && co.stakingBoost() > 0, r.error);
  t.check("stake: staked event", game.tick().events.some((e) => e.kind === "staked" && e.account === P && e.amountEcon === econ(100)));
  r = send(game, { kind: "unstake", amountEcon: econ(101) });
  t.check("unstake: more than staked is rejected", !r.ok);
  r = send(game, { kind: "unstake", amountEcon: econ(100) });
  t.check("unstake: round trip conserves $ECON", r.ok && game.ledger.balance(P, "ECON") === w0 && game.ledger.balance(ACCT.stakeVault, "ECON") === vault0
    && co.stakedEcon === 0 && game.chain.stakeOf(P) === 0 && game.ledger.conserved().ok, r.error);
  t.check("unstake: unstaked event", game.tick().events.some((e) => e.kind === "unstaked" && e.account === P));

  // ── buy_rwa / sell_rwa ──
  r = send(game, { kind: "buy_rwa", symbol: "DOGE", qty: 1 });
  t.check("buy_rwa: unknown symbol is rejected", !r.ok);
  r = send(game, { kind: "buy_rwa", symbol: "AAPL", qty: 0 });
  t.check("buy_rwa: qty 0 is rejected", !r.ok);
  r = send(game, { kind: "buy_rwa", symbol: "AAPL", qty: 1 });
  t.check("buy_rwa: one share costs more $ECON than the wallet holds -> rejected", !r.ok && /insufficient \$ECON/.test(r.error ?? ""), r.error);
  game.chain.airdrop(P, econ(10_000)); // whole shares of a $230 stock at $0.05/ECON need ~4,600 ECON
  const wR = game.ledger.balance(P, "ECON");
  const q1 = game.rwa.quoteBuy("AAPL", 1);
  r = send(game, { kind: "buy_rwa", symbol: "AAPL", qty: 1 });
  t.check("buy_rwa: position opens, $ECON paid", r.ok && game.rwa.position(P, "AAPL") === 1 && game.ledger.balance(P, "ECON") === wR - q1
    && game.playerView(P).rwa.some((p) => p.symbol === "AAPL" && p.qty === 1), r.error);
  r = send(game, { kind: "sell_rwa", symbol: "AAPL", qty: 2 });
  t.check("sell_rwa: more than held is rejected", !r.ok);
  r = send(game, { kind: "sell_rwa", symbol: "AAPL", qty: 1 });
  t.check("sell_rwa: position closes, $ECON returned (net of fee)", r.ok && game.rwa.position(P, "AAPL") === 0 && game.ledger.balance(P, "ECON") > wR - q1, r.error);

  // ── set_autopilot ──
  r = send(game, { kind: "set_autopilot", enabled: "yes" as never });
  t.check("set_autopilot: non-boolean is rejected", !r.ok);
  const nb = co.buildings.length;
  game.ledger.issue("test: capital", ACCT.crMint, co.id, "CR", cr(150_000)); // working capital so the manager can expand
  r = send(game, { kind: "set_autopilot", enabled: true });
  game.run(30);
  t.check("set_autopilot on: NPC manager runs the company", r.ok && co.autopilot && co.buildings.length > nb, `${nb} -> ${co.buildings.length}`);
  r = send(game, { kind: "set_autopilot", enabled: false });
  t.check("set_autopilot off", r.ok && !co.autopilot);

  // ── rename_company ──
  r = send(game, { kind: "rename_company", name: "  " });
  t.check("rename_company: blank is rejected", !r.ok);
  r = send(game, { kind: "rename_company", name: "x".repeat(CONFIG.company.maxNameLength + 1) });
  t.check("rename_company: too long is rejected", !r.ok);
  r = send(game, { kind: "rename_company", name: "\u0000\u200e\n  " });
  t.check("rename_company: control characters only is rejected", !r.ok);
  r = send(game, { kind: "rename_company", name: " Acme\u0007  Steel\u202e " });
  t.check("rename_company: strips control/bidi chars, collapses whitespace, trims", r.ok && co.name === "Acme Steel" && game.ledger.get(co.id).label === "Acme Steel", co.name);

  // ── envelope-level rejections and queueing ──
  r = send(game, { kind: "buy_truck" }, "ghost");
  t.check("unknown player is rejected", !r.ok && r.error === "unknown player");
  r = send(game, { kind: "teleport" } as never);
  t.check("unknown intent kind is rejected", !r.ok);
  t.check("rejections surface as intent_rejected events", game.tick().events.some((e) => e.kind === "intent_rejected" && e.playerId === "ghost"));
  game.queue({ id: "q1", playerId: P, intent: { kind: "rename_company", name: "Queued Co" } });
  game.queue({ id: "q2", playerId: P, intent: { kind: "repay", amountCr: 1 } });
  const pending = game.playerView(P).pending;
  t.check("queued intents show as pending in the player view", pending.length === 2 && pending[0].id === "q1" && pending[0].kind === "rename_company");
  const tr = game.tick();
  t.check("tick() applies queued intents in order and returns their results",
    tr.results.length === 2 && tr.results[0].id === "q1" && tr.results[0].ok && tr.results[1].id === "q2" && !tr.results[1].ok && co.name === "Queued Co"
    && tr.results.every((x) => x.tick === tr.tick));
  t.check("queue drained after tick", game.playerView(P).pending.length === 0);

  // ── views ──
  const cv = game.playerView(P).company!;
  t.check("CompanyView exposes bank/logistics fields", cv.creditScore >= 300 && cv.rateBps > 0 && cv.truckCapacity === co.trucks * LOGI.truckCapacity && cv.haulDemand === co.haulDemand() && cv.buildings.length === co.buildings.length);
  t.check("ledger still conserved after every intent", game.ledger.conserved().ok);
}
