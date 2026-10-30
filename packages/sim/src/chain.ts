import { CONFIG } from "./config.ts";
import type { Company } from "./company.ts";
import type { Ledger, Posting } from "./ledger.ts";
import type { Tile } from "./map.ts";
import type { Rng } from "./rng.ts";
import { ACCT } from "./types.ts";
import { econ } from "./units.ts";

/** External source of creator-fee $ECON (value flowing in from pump.fun/DEX
 *  traders outside the game). Kept as a mint so it can fund the treasury. */
export const EXT_PUMPFUN = "ext:pumpfun";

/** Non-circulating genesis reserve / protocol-owned liquidity. Airdrops and
 *  emissions come from here; it is NOT part of distributable fee revenue. */
export const RESERVE = "reserve:ECON";

export interface LandNft {
  id: string;
  tileId: string;
  owner: string;
  mintedTick: number;
  priceEcon: number;
}

export interface ChainState {
  landNfts: LandNft[];
  stakes: Record<string, Record<string, number>>; // account -> company -> $ECON minor
  totalCreatorFees: number;
  totalBurned: number;
  totalYield: number;
  feeEpoch: number;
  feeEpochSimulated: boolean;
  nftId: number;
  externalFeePerTick: number | null;
}

/**
 * On-chain settlement bridge (models the Solana layer inside the sim):
 *   - $ECON genesis + allocation
 *   - pump.fun creator fees streaming into the protocol treasury
 *   - premium land as NFTs bought with $ECON
 *   - staking $ECON for company production boosts (and unstaking)
 *   - veECON real-yield: treasury shares creator-fee revenue with stakers
 *   - DAO buyback-and-burn for deflationary value accrual
 */
export class ChainBridge {
  landNfts: LandNft[] = [];
  private stakes: Record<string, Record<string, number>> = {}; // account -> company -> minor
  totalCreatorFees = 0;
  totalBurned = 0;
  totalYield = 0;
  private feeEpoch = 0; // creator fees accrued this epoch (the yield source)
  private feeEpochSimulated = false; // any of this epoch's fees came from the volume model
  private nftId = 1;
  private externalFeePerTick: number | null = null;

  private ledger: Ledger;
  constructor(ledger: Ledger) {
    this.ledger = ledger;
    ledger.open(EXT_PUMPFUN, "mint", "pump.fun external float");
    ledger.open(RESERVE, "treasury", "genesis reserve / POL");
  }

  /** Genesis: mint the fixed supply into the non-circulating reserve. */
  genesis(totalSupplyEcon: number): void {
    this.ledger.issue("genesis", ACCT.econMint, RESERVE, "ECON", econ(totalSupplyEcon));
  }

  /** Airdrop $ECON (minor units) from the genesis reserve. */
  airdrop(to: string, amountEcon: number): void {
    this.ledger.transfer("airdrop", RESERVE, to, "ECON", amountEcon);
  }

  /** When the settlement worker observes real creator-fee inflow it pins the
   *  per-tick amount here; `null` returns to the simulated volume model. */
  setExternalCreatorFees(econMinorPerTick: number | null): void {
    this.externalFeePerTick = econMinorPerTick === null ? null : Math.max(0, Math.floor(econMinorPerTick));
  }

  /** Memecoin volume -> creator fees into the treasury (simulated unless pinned). */
  creatorFeeTick(rng: Rng): number {
    let fee: number;
    if (this.externalFeePerTick !== null) {
      fee = this.externalFeePerTick;
    } else {
      const daily = CONFIG.chain.baseDailyVolumeEcon * (0.6 + rng.next() * 0.8);
      const volumeTick = econ(daily) / CONFIG.ticksPerDay;
      fee = Math.floor((volumeTick * CONFIG.chain.creatorFeeBps) / 10_000);
      this.feeEpochSimulated = true;
    }
    if (fee <= 0) return 0;
    this.ledger.issue("pumpfun:creatorfee", EXT_PUMPFUN, ACCT.treasury, "ECON", fee);
    this.totalCreatorFees += fee;
    this.feeEpoch += fee;
    return fee;
  }

  /** Buy a premium tile with $ECON from `buyer`; mints a land NFT to the buyer.
   *  The tile's owner becomes `tileOwner` (a player's company, or the buyer). */
  buyPremiumLand(buyer: string, tile: Tile, tick: number, tileOwner = buyer): LandNft | null {
    if (!tile.premium || tile.ownerId) return null;
    if (this.ledger.balance(buyer, "ECON") < tile.priceEcon) return null;
    this.ledger.transfer(`land ${tile.id}`, buyer, ACCT.treasury, "ECON", tile.priceEcon);
    tile.ownerId = tileOwner;
    const nft: LandNft = { id: `land#${this.nftId++}`, tileId: tile.id, owner: buyer, mintedTick: tick, priceEcon: tile.priceEcon };
    this.landNfts.push(nft);
    return nft;
  }

  stakeOf(acct: string, companyId?: string): number {
    const by = this.stakes[acct];
    if (!by) return 0;
    if (companyId !== undefined) return by[companyId] ?? 0;
    let s = 0;
    for (const v of Object.values(by)) s += v;
    return s;
  }

  totalStaked(): number {
    let s = 0;
    for (const acct of Object.keys(this.stakes)) s += this.stakeOf(acct);
    return s;
  }

  /** Stake $ECON (minor) behind a company for a production boost (also earns yield). */
  stakeToCompany(co: Company, fromAcct: string, amountEcon: number): boolean {
    if (!Number.isInteger(amountEcon) || amountEcon <= 0) return false;
    if (this.ledger.balance(fromAcct, "ECON") < amountEcon) return false;
    this.ledger.transfer(`stake ${co.id}`, fromAcct, ACCT.stakeVault, "ECON", amountEcon);
    const by = (this.stakes[fromAcct] ??= {});
    by[co.id] = (by[co.id] ?? 0) + amountEcon;
    co.stakedEcon += amountEcon;
    return true;
  }

  /** Return staked $ECON (minor) from the vault to the staker. */
  unstakeFromCompany(co: Company, toAcct: string, amountEcon: number): boolean {
    if (!Number.isInteger(amountEcon) || amountEcon <= 0) return false;
    const have = this.stakeOf(toAcct, co.id);
    if (have < amountEcon) return false;
    this.ledger.transfer(`unstake ${co.id}`, ACCT.stakeVault, toAcct, "ECON", amountEcon);
    const by = this.stakes[toAcct];
    by[co.id] = have - amountEcon;
    if (by[co.id] === 0) delete by[co.id];
    if (Object.keys(by).length === 0) delete this.stakes[toAcct];
    co.stakedEcon -= amountEcon;
    return true;
  }

  private distributeToStakers(pool: number): number {
    const totalStake = this.totalStaked();
    if (totalStake <= 0 || pool <= 0) return 0;
    if (this.ledger.balance(ACCT.treasury, "ECON") < pool) return 0;
    const postings: Posting[] = [{ account: ACCT.treasury, unit: "ECON", delta: 0 }];
    let paid = 0;
    for (const acct of Object.keys(this.stakes)) {
      const cut = Math.floor((pool * this.stakeOf(acct)) / totalStake);
      if (cut <= 0) continue;
      postings.push({ account: acct, unit: "ECON", delta: cut });
      paid += cut;
    }
    postings[0].delta = -paid;
    if (paid > 0) {
      this.ledger.post("veECON yield", postings);
      this.totalYield += paid;
    }
    return paid;
  }

  /**
   * Epoch settlement of protocol fee revenue (real yield model): route this
   * epoch's creator fees to veECON stakers and buyback-burn, the rest retained
   * by the treasury. Nothing is paid out of the non-circulating reserve.
   * `external` is true only when every fee tick this epoch came from the
   * pinned real-world feed (only then may they back on-chain liabilities).
   */
  epochSettle(yieldFrac: number, burnFrac: number): { yield: number; burn: number; fees: number; external: boolean } {
    const fees = this.feeEpoch;
    const external = this.externalFeePerTick !== null && !this.feeEpochSimulated;
    this.feeEpoch = 0;
    this.feeEpochSimulated = false;
    const yieldPaid = this.distributeToStakers(Math.floor(fees * yieldFrac));
    let burned = 0;
    const burnAmt = Math.floor(fees * burnFrac);
    if (burnAmt > 0 && this.ledger.balance(ACCT.treasury, "ECON") >= burnAmt) {
      this.ledger.transfer("buyback-burn", ACCT.treasury, ACCT.burn, "ECON", burnAmt);
      this.totalBurned += burnAmt;
      burned = burnAmt;
    }
    return { yield: yieldPaid, burn: burned, fees, external };
  }

  toJSON(): ChainState {
    const stakes: Record<string, Record<string, number>> = {};
    for (const [a, by] of Object.entries(this.stakes)) stakes[a] = { ...by };
    return {
      landNfts: this.landNfts.map((n) => ({ ...n })),
      stakes,
      totalCreatorFees: this.totalCreatorFees,
      totalBurned: this.totalBurned,
      totalYield: this.totalYield,
      feeEpoch: this.feeEpoch,
      feeEpochSimulated: this.feeEpochSimulated,
      nftId: this.nftId,
      externalFeePerTick: this.externalFeePerTick,
    };
  }

  restore(state: ChainState): void {
    for (const k of ["landNfts", "stakes", "totalCreatorFees", "totalBurned", "totalYield", "feeEpoch", "feeEpochSimulated", "nftId", "externalFeePerTick"] as const) {
      if (state[k] === undefined) throw new Error(`chain state: missing field "${k}"`);
    }
    this.landNfts = state.landNfts.map((n) => ({ ...n }));
    this.stakes = {};
    for (const [a, by] of Object.entries(state.stakes)) this.stakes[a] = { ...by };
    this.totalCreatorFees = state.totalCreatorFees;
    this.totalBurned = state.totalBurned;
    this.totalYield = state.totalYield;
    this.feeEpoch = state.feeEpoch;
    this.feeEpochSimulated = state.feeEpochSimulated;
    this.nftId = state.nftId;
    this.externalFeePerTick = state.externalFeePerTick;
  }
}
