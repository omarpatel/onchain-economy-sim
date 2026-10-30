import * as anchor from "@coral-xyz/anchor";
import { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, getAccount, getAssociatedTokenAddressSync, getMint, TOKEN_PROGRAM_ID, TokenAccountNotFoundError } from "@solana/spl-token";
import { Connection, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import type { Staking } from "../../chain/target/types/staking.ts";
import { loadProgramIds } from "../src/config.ts";
import { stakePoolPda, stakePositionPda, stakeVaultPda } from "../src/pdas.ts";
import { airdropIfBelow, anchorProgram, authorityKeypairPath, env, fmtEcon, fail, keypairFile, need, PLAYER_KEYPAIR, sendTx } from "./localnet.ts";

/**
 * Give the test player (PLAYER_KEYPAIR, default .localnet/player.json, generated
 * on first run) SOL + FUND_ECON $ECON from the mint authority, then lock
 * STAKE_ECON into the staking pool for LOCK_DAYS. Skips the stake when the
 * position already holds at least STAKE_ECON (re-run safe).
 */

const { BN } = anchor;

async function main(): Promise<void> {
  const e = env();
  const conn = new Connection(e.RPC_URL ?? "http://127.0.0.1:8899", "confirmed");
  const authority = keypairFile(authorityKeypairPath(e));
  const player = keypairFile(e.PLAYER_KEYPAIR ?? PLAYER_KEYPAIR, true);
  const mint = new PublicKey(need(e, "ECON_MINT"));
  const decimals = (await getMint(conn, mint)).decimals;
  const unit = 10n ** BigInt(decimals);
  const fundEcon = BigInt(e.FUND_ECON ?? 5_000) * unit;
  const stakeEcon = BigInt(e.STAKE_ECON ?? 1_000) * unit;
  const lockSecs = BigInt(Math.round(Number(e.LOCK_DAYS ?? 30) * 86_400));
  const programs = loadProgramIds();
  console.log(`[stake] player=${player.publicKey.toBase58()} mint=${mint.toBase58()} authority=${authority.publicKey.toBase58()}`);

  await airdropIfBelow(conn, player.publicKey, 1, 2);

  const playerAta = getAssociatedTokenAddressSync(mint, player.publicKey);
  let balance = 0n;
  try {
    balance = (await getAccount(conn, playerAta)).amount;
  } catch (err) {
    if (!(err instanceof TokenAccountNotFoundError)) throw err;
  }
  if (balance < fundEcon) {
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, playerAta, player.publicKey, mint),
      createMintToInstruction(mint, playerAta, authority.publicKey, fundEcon - balance),
    );
    await sendTx(conn, tx, [authority], `mint ${fmtEcon(fundEcon - balance, decimals)} → player ATA ${playerAta.toBase58()}`);
    balance = fundEcon;
  }
  console.log(`[stake] player ATA ${playerAta.toBase58()} = ${fmtEcon(balance, decimals)}`);

  const staking = anchorProgram<Staking>(conn, player, "staking", programs.staking);
  const pool = stakePoolPda(programs.staking, mint);
  const position = stakePositionPda(programs.staking, pool, player.publicKey);
  const existing = await staking.account.stakePosition.fetchNullable(position);
  if (existing && BigInt(existing.amount.toString()) >= stakeEcon) {
    console.log(`[stake] position ${position.toBase58()} already holds ${fmtEcon(BigInt(existing.amount.toString()), decimals)} (lock until ${new Date(Number(existing.lockUntil) * 1000).toISOString()}) — skipping`);
    return;
  }
  const sig = await staking.methods
    .stake(new BN(stakeEcon.toString()), new BN(lockSecs.toString()))
    .accountsPartial({
      user: player.publicKey,
      pool,
      position,
      stakeVault: stakeVaultPda(programs.staking, pool),
      userEcon: playerAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc({ commitment: "confirmed" });
  const pos = await staking.account.stakePosition.fetch(position);
  console.log(
    `[stake] stake(${fmtEcon(stakeEcon, decimals)}, lock ${lockSecs}s) ${sig}\n  position=${position.toBase58()} amount=${pos.amount} weight=${pos.weight} boostBps=${pos.boostBps} lockUntil=${new Date(Number(pos.lockUntil) * 1000).toISOString()}\n  player ATA now ${fmtEcon((await getAccount(conn, playerAta)).amount, decimals)}`,
  );
}

main().catch(fail);
