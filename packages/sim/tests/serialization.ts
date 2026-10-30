import { Game, StateVersionError, type GameState } from "../src/engine.ts";
import { snapshotGame } from "../src/snapshot.ts";
import { econ } from "../src/units.ts";
import type { Tester } from "./harness.ts";

/** toJSON/fromJSON must be a complete, deterministic round trip. */
export function run(t: Tester): void {
  const a = new Game(99);
  a.boot({ players: 3, npcs: 8, investors: 4 });
  a.joinPlayer("p:ser", "Serial");
  a.run(100);
  a.queue({ id: "pending-1", playerId: "p:ser", intent: { kind: "buy_truck" } });
  a.apply({ id: "sync-1", playerId: "p:ser", intent: { kind: "rename_company" as const, name: "" } }); // buffers an intent_rejected event

  const wire = JSON.stringify(a.toJSON());
  const b = Game.fromJSON(JSON.parse(wire) as GameState);
  t.check("fromJSON restores queued intents and buffered events", b.playerView("p:ser").pending.length === 1 && b.toJSON().pendingEvents.length === 1);
  t.check("fromJSON restores head tick, rng, players, companies, ledger", b.headTick === a.headTick && b.rng.state === a.rng.state
    && b.players.length === a.players.length && b.companies.length === a.companies.length && b.ledger.supply("CR") === a.ledger.supply("CR"));
  t.check("restored snapshot is byte-identical", JSON.stringify(snapshotGame(b)) === JSON.stringify(snapshotGame(a)));

  a.run(100);
  b.run(100);
  t.check("100 ticks after restore == 200 ticks straight (snapshot byte-identical)", JSON.stringify(snapshotGame(a)) === JSON.stringify(snapshotGame(b)));
  t.check("100 ticks after restore == 200 ticks straight (full state byte-identical)", JSON.stringify(a.toJSON()) === JSON.stringify(b.toJSON()));
  t.check("restored game is conserved", b.ledger.conserved().ok);

  // External oracle pins persist and override the random walk.
  a.rwa.setQuotesUsd({ AAPL: 123.45, BOGUS: 1 }, 0.07);
  a.chain.setExternalCreatorFees(econ(3));
  const c = Game.fromJSON(JSON.parse(JSON.stringify(a.toJSON())) as GameState);
  const fees0 = c.chain.totalCreatorFees;
  c.run(5);
  t.check("setQuotesUsd persists and pinned symbols stop random-walking", c.rwa.quotesUsd().AAPL === 123.45 && c.rwa.econUsd === 0.07 && c.rwa.quotesUsd().BOGUS === undefined);
  t.check("setExternalCreatorFees persists and drives creatorFeeTick exactly", c.chain.totalCreatorFees - fees0 === 5 * econ(3));
  c.rwa.clearExternalQuotes();
  c.chain.setExternalCreatorFees(null);
  c.run(3);
  t.check("clearing the pins resumes the simulated walk", c.rwa.quotesUsd().AAPL !== 123.45);

  t.check("fromJSON rejects other versions with a typed StateVersionError", (() => {
    try { Game.fromJSON({ ...a.toJSON(), v: 1 as never }); return false; } catch (e) { return e instanceof StateVersionError && e.found === 1 && e.expected === 2; }
  })());
  t.check("restore rejects a same-version snapshot missing exchange fields", (() => {
    const s = a.toJSON();
    delete (s.exchange as Partial<GameState["exchange"]>).shareTicks;
    try { Game.fromJSON(s); return false; } catch (e) { return !(e instanceof StateVersionError) && /shareTicks/.test(String(e)); }
  })());
}
