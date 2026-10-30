import type { Ledger } from "./ledger.ts";
import type { Market } from "./market.ts";
import type { WorldMap } from "./map.ts";
import type { Rng } from "./rng.ts";

/** Well-known singleton ledger accounts. */
export const ACCT = {
  crMint: "mint:CR", // issues Credits (bank credit creation, faucets)
  econMint: "mint:ECON", // issues $ECON at genesis
  burn: "burn",
  treasury: "treasury", // protocol treasury: fees + pump.fun creator fees
  market: "market:goods", // goods-market float
  households: "households", // aggregate labor income + consumer spending
  stakeVault: "stake:ECON", // staked $ECON
  exportBuyer: "export", // rest-of-world export demand
} as const;

/** Everything a per-tick update needs. */
export interface SimContext {
  ledger: Ledger;
  market: Market;
  map: WorldMap;
  rng: Rng;
  tick: number;
  /** Labor productivity multiplier from household welfare, in
   *  [households.productivityMin, households.productivityMax]. */
  labor: number;
}
