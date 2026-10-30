import * as anchor from "@coral-xyz/anchor";
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { PUMP_PROGRAM_ID } from "./config.ts";
// Real pump.fun program IDL, vendored verbatim from
// https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/idl/pump.json
// (repo: https://github.com/pump-fun/pump-public-docs, path idl/pump.json).
import pumpIdl from "./idl/pump.json" with { type: "json" };

const { BorshAccountsCoder } = anchor;

/**
 * pump.fun creator-fee stream. When $ECON is launched on pump.fun, the coin's
 * creator earns a share of every bonding-curve buy/sell (and, post-migration,
 * of PumpSwap trades) which accrues as SOL in the creator vault PDA
 * `["creator-vault", creator]`. `collect_creator_fee_v2` (the current form of
 * `collect_creator_fee`, see pump-public-docs/docs/instructions/COLLECT_CREATOR_FEE.md)
 * moves the vault balance minus the rent reserve to the creator account; the
 * worker cranks it once the claimable balance clears `MIN_SWEEP_LAMPORTS`.
 */
const IDL = pumpIdl as anchor.Idl;
const COLLECT_IX = IDL.instructions.find((i) => i.name === "collect_creator_fee_v2");
if (!COLLECT_IX) throw new Error("pump IDL: collect_creator_fee_v2 instruction missing");
const COLLECT_DISCRIMINATOR = Buffer.from(COLLECT_IX.discriminator);

/**
 * Lamports the program leaves in the creator vault so it stays rent-exempt.
 * Measured on mainnet (2026-09-28) by simulating the collect instruction against
 * live vaults: every vault drains to exactly 650,240 lamports.
 */
export const PUMP_VAULT_RESERVE_LAMPORTS = 650_240;

export function creatorVaultPda(creator: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("creator-vault"), creator.toBuffer()], PUMP_PROGRAM_ID)[0];
}
export function bondingCurvePda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mint.toBuffer()], PUMP_PROGRAM_ID)[0];
}
export function eventAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PUMP_PROGRAM_ID)[0];
}

/**
 * `collect_creator_fee_v2` for a SOL-paired coin, account metas exactly as the
 * IDL declares them (quote mint = wrapped SOL; the two ATAs are unused but must
 * be passed). Permissionless: the creator does not sign, the payer just pays the fee.
 */
export function buildCollectCreatorFeeIx(creator: PublicKey): TransactionInstruction {
  const vault = creatorVaultPda(creator);
  return new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys: [
      { pubkey: creator, isSigner: false, isWritable: true },
      { pubkey: getAssociatedTokenAddressSync(NATIVE_MINT, creator, true), isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: getAssociatedTokenAddressSync(NATIVE_MINT, vault, true), isSigner: false, isWritable: true },
      { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: eventAuthorityPda(), isSigner: false, isWritable: false },
      { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: COLLECT_DISCRIMINATOR,
  });
}

/** Creator recorded on the coin's bonding curve (null if the curve account doesn't exist). */
export async function bondingCurveCreator(conn: Connection, mint: PublicKey): Promise<PublicKey | null> {
  const info = await conn.getAccountInfo(bondingCurvePda(mint));
  if (!info) return null;
  const coder = new BorshAccountsCoder(IDL);
  const curve = coder.decode("BondingCurve", info.data) as { creator: PublicKey };
  return curve.creator;
}

/**
 * Convert an observed lamport inflow into the sim's `econMinorPerTick`:
 *
 *   econMinorPerTick = (lamports / 1e9) × solUsd ÷ econUsd × 10^econDecimals ÷ ticksElapsed
 *
 * i.e. fees in SOL → USD (Pyth SOL/USD) → $ECON (÷ $ECON/USD from Jupiter Price v3)
 * → minor units → per game tick. Returns 0 when no ticks elapsed or no inflow.
 */
export function feeInflowEconMinorPerTick(p: {
  lamports: number;
  solUsd: number;
  econUsd: number;
  econDecimals: number;
  ticksElapsed: number;
}): number {
  if (p.lamports <= 0 || p.ticksElapsed <= 0 || !(p.solUsd > 0) || !(p.econUsd > 0)) return 0;
  const usd = (p.lamports / 1e9) * p.solUsd;
  return Math.floor((usd / p.econUsd) * 10 ** p.econDecimals / p.ticksElapsed);
}

export class PumpFunFees {
  readonly conn: Connection;
  readonly creator: PublicKey;
  readonly vault: PublicKey;
  readonly minSweepLamports: number;
  readonly dryRun: boolean;

  constructor(opts: { conn: Connection; creator: PublicKey; minSweepLamports: number; dryRun: boolean }) {
    this.conn = opts.conn;
    this.creator = opts.creator;
    this.vault = creatorVaultPda(opts.creator);
    this.minSweepLamports = opts.minSweepLamports;
    this.dryRun = opts.dryRun;
  }

  /** Raw vault balance (0 if the vault was never funded). */
  async vaultLamports(): Promise<number> {
    const info = await this.conn.getAccountInfo(this.vault);
    return info?.lamports ?? 0;
  }

  /** Lamports the collect instruction would actually move (the program keeps `PUMP_VAULT_RESERVE_LAMPORTS`). */
  async claimableLamports(): Promise<number> {
    return Math.max(0, (await this.vaultLamports()) - PUMP_VAULT_RESERVE_LAMPORTS);
  }

  /**
   * Crank `collect_creator_fee_v2` when the claimable balance clears the threshold.
   * Returns the signature, "dry-run" when only simulated, or null when below threshold.
   */
  async sweep(payer: Keypair): Promise<string | null> {
    const claimable = await this.claimableLamports();
    if (claimable < this.minSweepLamports || claimable === 0) return null;
    const tx = new Transaction().add(buildCollectCreatorFeeIx(this.creator));
    const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash("confirmed");
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = blockhash;
    tx.sign(payer);
    if (this.dryRun) {
      const sim = await this.conn.simulateTransaction(tx);
      console.log(
        `[pumpfun] DRY_RUN collect_creator_fee (${claimable} lamports) simulated: ${sim.value.err ? `error ${JSON.stringify(sim.value.err)}` : "ok"}`,
      );
      return "dry-run";
    }
    const signature = await this.conn.sendRawTransaction(tx.serialize());
    const conf = await this.conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
    if (conf.value.err) throw new Error(`collect_creator_fee failed: ${JSON.stringify(conf.value.err)} (${signature})`);
    console.log(`[pumpfun] swept ${claimable} lamports → ${this.creator.toBase58()} ${signature}`);
    return signature;
  }
}
