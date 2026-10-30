import * as anchor from "@coral-xyz/anchor";
import { createAssociatedTokenAccountIdempotentInstruction, getAccount, getMint, TOKEN_PROGRAM_ID, TokenAccountNotFoundError } from "@solana/spl-token";
import { Connection, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import type { Dividends } from "../../chain/target/types/dividends.ts";
import { claimAccounts } from "../src/pdas.ts";
import { fromHex } from "../src/settlement.ts";
import { anchorProgram, env, fmtEcon, fail, keypairFile, PLAYER_KEYPAIR, sendTx } from "./localnet.ts";

/**
 * Claim the test player's allocation for one epoch straight from the proofs
 * API, the way the web Chain tab does it (packages/web/lib/client/claim.ts):
 * `create ATA (idempotent)` + `dividends.claim(index, amount, proof)`, then
 * prove the receipt by sending the same claim again and expecting it to fail.
 *
 *   node scripts/claim-localnet.ts [epoch|latest]
 *
 * Env: RPC_URL, PROOFS_URL (default http://localhost:8790), PLAYER_KEYPAIR.
 */

const { BN } = anchor;

interface ClaimProof {
  epoch: number;
  chainEpoch: number;
  root: string;
  mint: string;
  programId: string;
  distributor: string;
  epochRoot: string;
  claimant: string;
  index: number;
  amount: string;
  proof: string[];
}

async function main(): Promise<void> {
  const e = env();
  const conn = new Connection(e.RPC_URL ?? "http://127.0.0.1:8899", "confirmed");
  const player = keypairFile(e.PLAYER_KEYPAIR ?? PLAYER_KEYPAIR);
  const proofsUrl = (e.PROOFS_URL ?? "http://localhost:8790").replace(/\/+$/, "");
  const epochArg = process.argv[2] ?? "latest";

  const res = await fetch(`${proofsUrl}/proofs/${epochArg}/${player.publicKey.toBase58()}`);
  if (!res.ok) throw new Error(`${proofsUrl}/proofs/${epochArg}/${player.publicKey.toBase58()} → ${res.status} ${await res.text()}`);
  const p = (await res.json()) as ClaimProof;
  console.log(`[claim] proof epoch=${p.epoch} chainEpoch=${p.chainEpoch} index=${p.index} amount=${p.amount} proof=[${p.proof.join(", ")}] root=${p.root}`);

  const programId = new PublicKey(p.programId);
  const mint = new PublicKey(p.mint);
  const accounts = claimAccounts(programId, mint, player.publicKey, p.chainEpoch);
  if (!accounts.distributor.equals(new PublicKey(p.distributor)) || !accounts.epochRoot.equals(new PublicKey(p.epochRoot))) {
    throw new Error(`PDA mismatch: derived ${accounts.distributor.toBase58()}/${accounts.epochRoot.toBase58()} vs proof ${p.distributor}/${p.epochRoot}`);
  }
  const decimals = (await getMint(conn, mint)).decimals;
  const balance = async (): Promise<bigint> => {
    try {
      return (await getAccount(conn, accounts.claimantAta)).amount;
    } catch (err) {
      if (err instanceof TokenAccountNotFoundError) return 0n;
      throw err;
    }
  };
  const before = await balance();
  console.log(`[claim] claimant ATA ${accounts.claimantAta.toBase58()} before = ${fmtEcon(before, decimals)}; receipt ${accounts.receipt.toBase58()} exists=${(await conn.getAccountInfo(accounts.receipt)) !== null}`);

  const program = anchorProgram<Dividends>(conn, player, "dividends", programId);
  const claimTx = async (): Promise<Transaction> =>
    new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(player.publicKey, accounts.claimantAta, player.publicKey, mint),
      await program.methods
        .claim(new BN(p.index), new BN(p.amount), p.proof.map((h) => Array.from(fromHex(h))))
        .accountsPartial({
          claimant: player.publicKey,
          distributor: accounts.distributor,
          epochRoot: accounts.epochRoot,
          receipt: accounts.receipt,
          vault: accounts.vault,
          claimantAta: accounts.claimantAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
    );

  const signature = await sendTx(conn, await claimTx(), [player], `claim(epoch ${p.epoch} / chain ${p.chainEpoch})`);
  const after = await balance();
  const delta = after - before;
  console.log(`[claim] claimant ATA after = ${fmtEcon(after, decimals)}; Δ = ${delta} minor (expected ${p.amount}) ${delta === BigInt(p.amount) ? "OK" : "MISMATCH"}`);
  if (delta !== BigInt(p.amount)) throw new Error(`balance moved by ${delta}, expected ${p.amount}`);
  console.log(`[claim] receipt ${accounts.receipt.toBase58()} exists=${(await conn.getAccountInfo(accounts.receipt)) !== null} tx=${signature}`);

  try {
    await sendTx(conn, await claimTx(), [player], "second claim");
    throw new Error("second claim unexpectedly succeeded");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/unexpectedly/.test(msg)) throw err;
    const receiptRejected = /already in use|0x0\b|custom program error: 0x0|AlreadyClaimed/.test(msg);
    const why = msg.split("\n").filter((l) => /Message:|already in use|custom program error/.test(l)).map((l) => l.trim());
    console.log(`[claim] second claim rejected${receiptRejected ? " by the receipt PDA" : ""}: ${(why.length ? why : [msg]).join(" | ").slice(0, 400)}`);
    if (!receiptRejected) throw new Error(`second claim failed for an unexpected reason: ${msg}`);
  }
  console.log(`[claim] balance unchanged after the rejected retry: ${fmtEcon(await balance(), decimals)}`);
}

main().catch(fail);
