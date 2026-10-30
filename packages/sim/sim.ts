import { Game } from "./src/engine.ts";
import { ALL_GOODS, type Good } from "./src/goods.ts";
import { CONFIG } from "./src/config.ts";
import { BALANCE_TARGETS, runBalanceProbe } from "./src/metrics.ts";
import { fmt, fromCr, fromEcon } from "./src/units.ts";

function arg(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : dflt;
}

const ticks = arg("ticks", 480);
const players = arg("players", 8);
const npcs = arg("npcs", 18);
const investors = arg("investors", 8);
const seed = arg("seed", CONFIG.seed);

const game = new Game(seed);
game.boot({ players, npcs, investors });
const startPrices = game.market.snapshot();

console.log(`\n=== Economy Sim ===`);
console.log(`world ${game.map.width}x${game.map.height}  |  ${players} players  ${npcs} NPC firms  ${investors} investors  |  ${ticks} ticks (${(ticks / CONFIG.ticksPerDay).toFixed(0)} days)  seed ${seed}\n`);

const t0 = Date.now();
const m = runBalanceProbe(game, ticks);
const ms = Date.now() - t0;
const ctx = game.ctx();

// ---- money supply ----
const cons = game.ledger.conserved();
console.log(`--- MONEY ---`);
console.log(`CR supply        ${fmt(game.ledger.supply("CR"), "CR")}`);
console.log(`$ECON supply     ${fmt(game.ledger.supply("ECON"), "ECON")}  (burned ${fromEcon(game.chain.totalBurned).toLocaleString()} )`);
console.log(`Treasury         ${fmt(game.ledger.balance("treasury", "CR"), "CR")}  |  ${fmt(game.ledger.balance("treasury", "ECON"), "ECON")}`);
console.log(`Households (labor pool) ${fmt(game.ledger.balance("households", "CR"), "CR")}  welfare ${game.welfare.toFixed(2)}`);
console.log(`pump.fun creator fees -> treasury: ${fromEcon(game.chain.totalCreatorFees).toLocaleString()} $ECON`);
console.log(`veECON real yield paid to stakers: ${fromEcon(game.chain.totalYield).toLocaleString()} $ECON`);
console.log(`Dividends distributed (CR): ${fromCr(game.dividendsCr).toLocaleString()} CR`);
console.log(`Ledger conserved: ${cons.ok ? "YES" : "NO"}  (CR sum ${cons.sums.CR}, ECON sum ${cons.sums.ECON})\n`);

// ---- goods market ----
console.log(`--- GOODS MARKET (price start -> end, % of ticks on band edge) ---`);
for (const g of ALL_GOODS as Good[]) {
  const s = fromCr(startPrices[g]);
  const e = fromCr(game.market.price(g));
  const chg = Math.round(((e - s) / s) * 100);
  console.log(`  ${g.padEnd(11)} ${s.toFixed(2).padStart(7)} -> ${e.toFixed(2).padStart(7)} CR  (${chg > 0 ? "+" : ""}${chg}%)  edge ${(m.bandEdgeFraction[g] * 100).toFixed(1).padStart(5)}%`);
}

// ---- companies ----
console.log(`\n--- COMPANIES ---`);
console.log(`total ${m.companies}  |  public ${m.publicCount}  |  graduated on-chain ${m.graduated}  |  bankrupt ${m.bankrupt}`);
console.log(`share trades executed: ${m.shareTrades}  |  positive lifetime profit: ${(m.positiveProfitShare * 100).toFixed(0)}%\n`);

const ranked = [...game.companies].sort((a, z) => z.valuation(ctx) - a.valuation(ctx)).slice(0, 8);
console.log(`  ${"company".padEnd(18)} ${"bldgs".padStart(5)} ${"cash".padStart(12)} ${"debt".padStart(11)} ${"lifeProfit".padStart(13)} ${"valuation".padStart(13)} ${"mktCap".padStart(13)} pub`);
for (const c of ranked) {
  console.log(
    `  ${c.name.padEnd(18)} ${String(c.buildings.length).padStart(5)} ` +
    `${fromCr(game.ledger.balance(c.id, "CR")).toFixed(0).padStart(12)} ` +
    `${fromCr(c.debt).toFixed(0).padStart(11)} ` +
    `${fromCr(c.lifetimeProfit).toFixed(0).padStart(13)} ` +
    `${fromCr(c.valuation(ctx)).toFixed(0).padStart(13)} ` +
    `${fromCr(game.exchange.marketCap(c)).toFixed(0).padStart(13)} ` +
    `${c.isOnChain ? "chain" : c.isPublic ? "yes" : "no"}`,
  );
}

// ---- player wealth ----
console.log(`\n--- PLAYER NET WORTH (start grant: ${fromCr(CONFIG.player.starterCr).toLocaleString()} CR personal + ${fromCr(CONFIG.player.companyCapitalCr).toLocaleString()} CR company + ${fromEcon(CONFIG.player.starterEcon).toLocaleString()} $ECON) ---`);
const start = CONFIG.player.starterCr + CONFIG.player.companyCapitalCr;
const rows = game.players.map((p) => {
  const co = p.companyId ? game.company(p.companyId) : undefined;
  let shareVal = 0;
  for (const c of game.companies) {
    const px = game.exchange.lastPrice[c.id] ?? Math.round(c.valuation(ctx) / Math.max(1, c.totalShares));
    shareVal += game.exchange.shares(c.id, p.id) * px;
  }
  const privateEquity = co && !co.isPublic ? Math.max(0, co.bookValue(ctx)) : 0;
  return { p, netCr: game.ledger.balance(p.id, "CR") + shareVal + privateEquity, econBal: game.ledger.balance(p.id, "ECON") };
}).sort((a, z) => z.netCr - a.netCr);
for (const r of rows) {
  console.log(`  ${r.p.id.padEnd(10)} net ${fromCr(r.netCr).toFixed(0).padStart(10)} CR  + ${fromEcon(r.econBal).toFixed(0).padStart(6)} $ECON  (${r.netCr > start ? "up" : "down"})`);
}

// ---- on-chain assets ----
console.log(`\n--- ON-CHAIN ASSETS ---`);
console.log(`premium land NFTs minted: ${game.chain.landNfts.length}  |  staked ${fmt(game.ledger.balance("stake:ECON", "ECON"), "ECON")}`);
const q = game.rwa.quotesUsd();
console.log(`RWA oracle (USD): ${Object.entries(q).map(([t, v]) => `${t} $${v.toFixed(2)}`).join("  ")}`);
console.log(`$ECON price: $${game.rwa.econUsd.toFixed(4)}`);

// ---- events ----
console.log(`\n--- EVENTS (${ticks} ticks) ---`);
console.log(`  ${Object.entries(m.events).map(([k, v]) => `${k}=${v}`).join("  ")}`);

// ---- balance acceptance ----
const mark = (ok: boolean): string => (ok ? "PASS" : "FAIL");
console.log(`\n--- BALANCE METRICS (${ms.toFixed(0)} ms, ${(ms / Math.max(1, m.ticks)).toFixed(1)} ms/tick) ---`);
console.log(`  ${mark(m.passes.bandEdge)}  max band-edge fraction ${(m.maxBandEdgeFraction * 100).toFixed(1)}%  (target <= ${BALANCE_TARGETS.maxBandEdgeFraction * 100}%)`);
console.log(`  ${mark(m.passes.profit)}  companies with positive lifetime profit ${(m.positiveProfitShare * 100).toFixed(0)}%  (target >= ${BALANCE_TARGETS.minPositiveProfitShare * 100}%)`);
console.log(`  ${mark(m.passes.supply)}  CR supply growth last ${BALANCE_TARGETS.supplyWindowEpochs} epochs ${(m.supplyGrowthPerEpoch * 100).toFixed(2)}%/epoch  (target < ${BALANCE_TARGETS.maxSupplyGrowthPerEpoch * 100}%)`);
console.log(`  ${mark(m.passes.graduation)}  graduated ${m.graduated}/${m.companies} (public ${m.publicCount}; target: some public, not all graduated)`);
console.log(`  ${mark(m.passes.conserved)}  ledger conserved`);
console.log(`  ${mark(m.passes.overdraft)}  overdraft/engine throws: ${m.overdraftThrows}`);
console.log(m.allPass ? `\nBALANCE OK\n` : `\nBALANCE TARGETS MISSED\n`);

if (!cons.ok || m.overdraftThrows > 0) process.exit(1);
