import { cr, econ } from "./units.ts";

/** Tunable economic constants. One place to balance the whole economy.
 *  Every money value is in ledger minor units (use `cr()` / `econ()`). */
export const CONFIG = {
  seed: 1337,

  world: { width: 32, height: 32 },

  // Tick timing (sim ticks; 1 tick ~= 1 in-game hour). An epoch is one day.
  ticksPerDay: 24,
  // Boot-time money seeds: the goods market's CR float (the always-available
  // counterparty's buying power) and initial household savings.
  boot: {
    marketFloatCr: cr(8_000_000),
    householdSavingsCr: cr(60_000),
    npcGrantCr: cr(20_000),
    npcEcon: econ(500),
    investorGrantCr: cr(300_000),
    investorEcon: econ(1000),
  },

  // Players joining the live world (also used for boot-time autopilot players).
  player: {
    starterCr: cr(40_000), // personal wallet grant
    companyCapitalCr: cr(35_000), // founding company treasury
    starterEcon: econ(2000), // $ECON airdrop from the genesis reserve
    hqCandidates: 40, // free plain tiles closest to the map center considered for a new HQ
    maxPlayers: 64, // hard cap on human players (JoinError "max_players" beyond this)
    // NPC/autopilot managers never claim free plain tiles once this few remain,
    // so a joining player can always find an HQ tile. Player intents may still use them.
    reservedHqTiles: 128, // = maxPlayers x 2
  },

  company: {
    maxBuildings: 32, // hard cap per company (bounds per-tick work)
    maxStockTicks: 48, // a plant idles once its output stock exceeds this many ticks of production
    npcMaxBuildings: 10,
    npcWorkingCapitalTicks: 8, // NPC keeps this many ticks of operating cash before expanding
    maxNameLength: 32,
  },
  // Goods market pricing dynamics (Victoria-3 style clearing blended with the
  // market-maker inventory signal).
  market: {
    // EWMA weight applied to each tick's bought/sold units before computing imbalance
    flowSmoothing: 0.2,
    // P_flow = ref * (1 + flowWeight * clamp((B̄ - S̄) / min(B̄, S̄), -1, 1))
    flowWeight: 0.6,
    // inventory multiplier = clamp(1 + invWeight * (target - inv) / target, invMulMin, invMulMax)
    invWeight: 0.75,
    invMulMin: 0.4,
    invMulMax: 2.5,
    // fraction of the gap to the clearing target closed each tick
    smoothing: 0.15,
    // max fraction price can move in one tick (circuit breaker); price_alert fires at 10%
    maxMovePerTick: 0.12,
    // hard band around the reference price
    bandMin: 0.25,
    bandMax: 4,
    // market-maker float target per good; the float opens at mmInitial (below
    // target, so a fresh world rewards production), stops buying at
    // mmAbsorbCap x target, and glut above target spoils at glutDecay per tick
    mmTarget: 5000,
    mmInitial: 1500,
    mmAbsorbCap: 2,
    glutDecay: 0.02,
    // fee (basis points) charged by market on each trade -> protocol treasury
    feeBps: 30,
  },

  // Rest-of-world export demand for finished goods: price-elastic, bounded,
  // scaled by the number of live finished-goods buildings (never a fixed mint).
  exports: {
    crPerLiveFinishedBuildingPerTick: cr(120),
    // demand multiplier falls linearly from 1 at ref price to 0 at this multiple
    zeroDemandAtRefMultiple: 1.5,
    // hard cap on the export injection: share of current CR supply per epoch
    maxShareOfSupplyPerEpoch: 0.02,
  },

  // Households: consumer spending and welfare -> labor productivity.
  households: {
    spendRatePerTick: 0.12, // share of household savings spent each tick
    welfareSmoothing: 0.1, // EWMA weight of each tick's fulfilment ratio
    productivityMin: 0.85, // labor multiplier at welfare 0
    productivityMax: 1.1, // labor multiplier at welfare 1
  },

  // Finance
  bank: {
    baseRateBpsPerTick: 2, // interest per tick on outstanding loans at the best score (~0.5%/day)
    rateSlope: 90, // + (maxCreditScore - score) / rateSlope bps -> ~2%/day at the worst score
    maxLoanToEquity: 2.0, // leverage cap
    minCreditScore: 300,
    maxCreditScore: 850,
    npcMaxLeverage: 0.5, // NPC manager will not borrow past debt/equity of this
  },

  // Stock exchange
  exchange: {
    listingFeeCr: cr(500), // to go public internally
    ipoLockupTicks: 48, // founder may not sell before ipoTick + lockup
    ipoMinFloat: 0.1,
    ipoMaxFloat: 0.6,
    ipoMinShares: 1_000,
    ipoMaxShares: 10_000_000,
    ipoMinPriceCr: cr(1), // IPO price floor per share: sharesTotal <= valuation / ipoMinPriceCr
    dividendPayoutRatio: 0.5, // default fraction of epoch net profit distributed
    tradingFeeBps: 20,
    recentTrades: 10, // per-company trade tail kept for the snapshot
    flowTicks: 48, // per-tick secondary-trade aggregates kept for vwap()/volume() (>= graduation window)
    // NPC manager policy
    npcIpoValuationCr: cr(250_000),
    npcIpoShares: 100_000,
    npcIpoFloat: 0.4,
  },

  // Land: Harberger-lite upkeep paid to the treasury each epoch.
  land: {
    upkeepBpsOfPricePerEpoch: 250, // 2.5% of the tile's CR price per epoch
    forfeitAfterUnpaidEpochs: 3, // unpaid upkeep capitalizes to debt; then the tile is forfeited
    hqPriceMultiplier: 1, // HQ tiles pay the same upkeep but are never forfeited
  },

  // Anti-hoarding sinks (Sim Companies "accounting overhead").
  sinks: {
    idleCashThresholdCr: cr(150_000),
    idleCashTaxBps: 100, // 1% of company cash above the threshold, per epoch
  },

  // Chain / token layer
  chain: {
    genesisSupplyEcon: 1_000_000_000,
    // pump.fun creator fee: token launched on pump.fun; creator earns fees on
    // trading volume, which stream into the protocol treasury each tick.
    creatorFeeBps: 100, // 1% of simulated on-chain volume
    baseDailyVolumeEcon: 250_000, // simulated external $ECON trading volume/day
    // Premium land priced in $ECON
    premiumLandBaseEcon: 25,
    // Staking: stake $ECON for a production boost, capped.
    stakingBoostPerEcon: 0.00002, // boost fraction per staked whole ECON
    stakingBoostCap: 0.35, // max +35% production
    npcStakeTargetEcon: econ(3000),
    // Public companies graduate to on-chain settlement on traded evidence:
    // public for >= graduateMinEpochs, VWAP over that window x totalShares
    // above graduateMarketCapCr, and secondary volume over the window of at
    // least graduateMinVolumeOfFloat of the float (self-trades never fill).
    graduateMarketCapCr: cr(400_000),
    graduateMinEpochs: 2,
    graduateMinVolumeOfFloat: 0.05,
    yieldFrac: 0.5, // share of epoch creator fees paid to veECON stakers
    burnFrac: 0.2, // share of epoch creator fees bought back and burned
    // Share of this epoch's observed (external) creator fees that backs the
    // on-chain $ECON dividend pool; in-sim CR dividends are only weights.
    dividendShareOfFees: 0.3,
  },

  // RWA real-stock desk (tokenized equities: xStocks / Dinari style).
  // In production these route to a licensed, KYC-gated provider. Here we model
  // an oracle price feed so players can hold tokenized real equity with $ECON.
  rwa: {
    tickers: ["AAPL", "TSLA", "NVDA", "MSFT", "SPY"] as const,
    feeBps: 15,
    // per-tick drift/vol for the mock oracle random walk
    driftPerTick: 0.00002,
    volPerTick: 0.004,
  },

  // Ring-buffer length of per-tick history (candles, macro series).
  history: { ticks: 288 },
} as const;

export type Config = typeof CONFIG;
