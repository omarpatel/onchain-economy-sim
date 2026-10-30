import { CONFIG } from "../src/config.ts";
import { Game, newDemoGame } from "../src/engine.ts";
import type { Tile } from "../src/map.ts";
import { ACCT } from "../src/types.ts";
import { cr } from "../src/units.ts";
import type { Tester } from "./harness.ts";

const P = "p:sink";

function nextEpochBoundary(game: Game): number {
  const t = game.headTick;
  return t % CONFIG.ticksPerDay === 0 ? t : t + (CONFIG.ticksPerDay - (t % CONFIG.ticksPerDay));
}

/** Land upkeep / forfeiture, idle-cash overhead, dividend accounting. */
export function run(t: Tester): void {
  const game = newDemoGame({ seed: 77, players: 1, npcs: 4, investors: 3, warmupTicks: 30 });
  game.joinPlayer(P, "Sink");
  const co = game.company(game.player(P)!.companyId!)!;
  const hq = game.map.tile(co.hubTileId);

  // Own a second tile, then remove every source of income and cash.
  const land: Tile = game.map.freePlainTiles().filter((x) => !game.buildingOn(x.id))
    .sort((a, z) => game.map.distance(a, hq) - game.map.distance(z, hq))[0];
  let r = game.apply({ id: "l", playerId: P, intent: { kind: "buy_land", x: land.x, y: land.y } });
  t.check("setup: player company owns HQ + one extra tile", r.ok && land.ownerId === co.id, r.error);
  r = game.apply({ id: "d", playerId: P, intent: { kind: "demolish", buildingId: co.buildings[0].id } });
  game.ledger.transfer("test: drain", co.id, ACCT.treasury, "CR", game.ledger.balance(co.id, "CR"));
  t.check("setup: company has no plants and no cash", r.ok && co.buildings.length === 0 && game.ledger.balance(co.id, "CR") === 0);

  const debt0 = co.debt;
  const owned = game.map.ownedBy(co.id); // HQ + starter-extractor tile + bought land
  const due = owned.reduce((a, x) => a + Math.floor((x.priceCr * CONFIG.land.upkeepBpsOfPricePerEpoch) / 10_000), 0);
  for (let epoch = 1; epoch <= CONFIG.land.forfeitAfterUnpaidEpochs; epoch++) {
    const boundary = nextEpochBoundary(game); // run through the epoch-close tick
    while (game.headTick <= boundary) game.tick();
    if (epoch < CONFIG.land.forfeitAfterUnpaidEpochs) {
      // debt grows by the unpaid upkeep (plus interest capitalized on it, since cash is 0)
      t.check(`epoch ${epoch} unpaid: upkeep capitalizes into debt, tile still owned`, co.debt >= debt0 + due * epoch && land.ownerId === co.id && co.landArrears[land.id] === epoch,
        `debt=${co.debt} expected>=${debt0 + due * epoch} arrears=${JSON.stringify(co.landArrears)}`);
    }
  }
  t.check(`tile forfeited after ${CONFIG.land.forfeitAfterUnpaidEpochs} unpaid epochs`, land.ownerId === null && co.landArrears[land.id] === undefined);
  t.check("HQ tile is never forfeited (arrears keep accruing)", hq.ownerId === co.id && (co.landArrears[hq.id] ?? 0) >= CONFIG.land.forfeitAfterUnpaidEpochs);

  // Forfeiture also demolishes whatever stood on the tile.
  const game2 = newDemoGame({ seed: 78, players: 1, npcs: 4, investors: 3, warmupTicks: 30 });
  game2.joinPlayer(P, "Sink2");
  const co2 = game2.company(game2.player(P)!.companyId!)!;
  const starter = co2.buildings[0];
  const starterTile = game2.map.tile(starter.tileId);
  game2.apply({ id: "h", playerId: P, intent: { kind: "set_sell_policy", good: "iron_ore", mode: "hold" } });
  for (const g of Object.keys(co2.inventory) as (keyof typeof co2.inventory)[]) co2.sellPolicy[g] = "hold"; // no revenue
  game2.ledger.transfer("test: drain", co2.id, ACCT.treasury, "CR", game2.ledger.balance(co2.id, "CR"));
  let seized = false;
  for (let i = 0; i < CONFIG.ticksPerDay * (CONFIG.land.forfeitAfterUnpaidEpochs + 1); i++) {
    for (const e of game2.tick().events) if (e.kind === "demolished" && e.buildingId === starter.id) seized = true;
  }
  t.check("forfeiting a built tile demolishes the plant with a demolished event", seized && starterTile.ownerId === null && !co2.building(starter.id));
  t.check("ledger conserved through forfeiture", game.ledger.conserved().ok && game2.ledger.conserved().ok);

  // Idle-cash overhead: cash above the threshold is taxed at epoch close.
  const game3 = newDemoGame({ seed: 79, players: 1, npcs: 4, investors: 3, warmupTicks: 10 });
  game3.joinPlayer(P, "Rich");
  const co3 = game3.company(game3.player(P)!.companyId!)!;
  game3.apply({ id: "d3", playerId: P, intent: { kind: "demolish", buildingId: co3.buildings[0].id } });
  game3.ledger.issue("test: windfall", ACCT.crMint, co3.id, "CR", cr(400_000));
  while (game3.headTick < nextEpochBoundary(game3)) game3.tick();
  const cashBefore = game3.ledger.balance(co3.id, "CR");
  const upkeep = game3.map.ownedBy(co3.id).reduce((a, x) => a + Math.floor((x.priceCr * CONFIG.land.upkeepBpsOfPricePerEpoch) / 10_000), 0);
  const expectedTax = Math.floor(((cashBefore - upkeep - CONFIG.sinks.idleCashThresholdCr) * CONFIG.sinks.idleCashTaxBps) / 10_000);
  const tre0 = game3.ledger.balance(ACCT.treasury, "CR");
  game3.tick(); // epoch close
  const paid = cashBefore - game3.ledger.balance(co3.id, "CR");
  t.check("idle-cash overhead taxed above threshold into the treasury", paid === upkeep + expectedTax && game3.ledger.balance(ACCT.treasury, "CR") - tre0 >= upkeep + expectedTax
    && co3.lastPnl.overhead === upkeep + expectedTax, `paid=${paid} upkeep=${upkeep} tax=${expectedTax} overhead=${co3.lastPnl.overhead}`);

  // Dividend events sum to the cumulative counter's delta.
  const game4 = newDemoGame({ seed: 80, players: 4, npcs: 12, investors: 6, warmupTicks: 120 });
  const div0 = game4.dividendsCr;
  let eventSum = 0;
  let epochSum = 0;
  let dividendEvents = 0;
  for (let i = 0; i < CONFIG.ticksPerDay * 4; i++) {
    for (const e of game4.tick().events) {
      if (e.kind === "dividend") { eventSum += e.poolCr; dividendEvents++; }
      if (e.kind === "epoch_close") epochSum += e.dividendsCr;
    }
  }
  t.check("dividend events sum to the dividendsCr delta (and epoch_close totals agree)", dividendEvents > 0 && eventSum === game4.dividendsCr - div0 && epochSum === eventSum,
    `events=${eventSum} delta=${game4.dividendsCr - div0} epoch=${epochSum}`);
}
