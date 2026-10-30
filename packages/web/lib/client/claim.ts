"use client";

import { BN, Program } from "@coral-xyz/anchor";
import { createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, SystemProgram, Transaction, type Connection } from "@solana/web3.js";
import dividendsIdl from "../../../chain/target/idl/dividends.json";
import type { Dividends } from "../../../chain/target/types/dividends.ts";
import programs from "../../../chain/programs.json";
import { claimAccounts as deriveClaimAccounts, type ClaimAccounts } from "../../../integration/src/pdas.ts";
import { api, ApiError } from "./auth.ts";
import { EXPLORER_CLUSTER, PROOFS_URL, ECON_MINT } from "./config.ts";

/** Deployed program ids (programs.json is the source of truth; the IDL `address` may be stale). */
export const PROGRAM_IDS = programs;

/** How many epochs back from the latest we look for unclaimed allocations. */
const CLAIM_LOOKBACK = 10;

/** `GET /proofs/:epoch/:pubkey` from the settlement worker. Amounts are $ECON minor units. */
export interface ClaimProof {
  epoch: number;
  chainEpoch: number;
  tickClosed: number;
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

export interface Claimable {
  proof: ClaimProof;
  /** null when the receipt lookup failed (RPC down); the claim can still be attempted */
  claimed: boolean | null;
}

export class ClaimError extends Error {}

function hex32(hex: string): number[] {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length !== 64) throw new ClaimError(`proof node must be 32 bytes, got ${clean.length / 2}`);
  const out: number[] = [];
  for (let i = 0; i < 64; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));
  return out;
}

/** PDAs per the `dividends` program (shared with the worker: packages/integration/src/pdas.ts). */
export function claimAccounts(claimant: PublicKey, p: Pick<ClaimProof, "programId" | "mint" | "chainEpoch">): ClaimAccounts {
  return deriveClaimAccounts(new PublicKey(p.programId || PROGRAM_IDS.dividends), new PublicKey(p.mint || ECON_MINT), claimant, p.chainEpoch);
}

async function fetchProof(epoch: number, pubkey: string): Promise<ClaimProof | null> {
  let res: Response;
  try {
    res = await fetch(`${PROOFS_URL}/proofs/${epoch}/${pubkey}`, { cache: "no-store" });
  } catch {
    throw new ClaimError(`proofs API unreachable (${PROOFS_URL})`);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new ClaimError(`proofs API HTTP ${res.status}`);
  return (await res.json()) as ClaimProof;
}

/**
 * Allocations for `pubkey` over the last `CLAIM_LOOKBACK` game epochs, newest
 * first, with the receipt PDA checked on-chain so already-claimed rows are marked.
 */
export async function loadClaims(pubkey: string, connection: Connection): Promise<{ latestEpoch: number | null; rows: Claimable[] }> {
  let latest: number;
  try {
    latest = (await api<{ epoch: number }>("/api/epochs/latest")).epoch;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return { latestEpoch: null, rows: [] };
    throw e;
  }
  const epochs: number[] = [];
  for (let e = latest; e >= Math.max(1, latest - CLAIM_LOOKBACK); e--) epochs.push(e);
  const proofs = (await Promise.all(epochs.map((e) => fetchProof(e, pubkey)))).filter((p): p is ClaimProof => p !== null);
  if (proofs.length === 0) return { latestEpoch: latest, rows: [] };

  const claimant = new PublicKey(pubkey);
  let receipts: (unknown | null)[] | null = null;
  try {
    receipts = await connection.getMultipleAccountsInfo(proofs.map((p) => claimAccounts(claimant, p).receipt));
  } catch {
    receipts = null; // RPC unreachable: leave `claimed` unknown
  }
  return { latestEpoch: latest, rows: proofs.map((proof, i) => ({ proof, claimed: receipts ? receipts[i] !== null : null })) };
}

/**
 * `create ATA (idempotent)` + `dividends.claim(index, amount, proof)`. Verifies
 * the program and distributor exist first so a missing devnet deployment is a
 * readable error rather than a raw simulation failure.
 */
export async function buildClaimTx(connection: Connection, claimant: PublicKey, p: ClaimProof): Promise<{ tx: Transaction; accounts: ClaimAccounts }> {
  if (!p.mint && !ECON_MINT) throw new ClaimError("NEXT_PUBLIC_ECON_MINT is not configured and the proof carries no mint");
  const accounts = claimAccounts(claimant, p);
  const [programInfo, distributorInfo] = await connection.getMultipleAccountsInfo([accounts.programId, accounts.distributor]);
  if (!programInfo?.executable) {
    throw new ClaimError(`The dividends program ${accounts.programId.toBase58()} is not deployed on ${EXPLORER_CLUSTER}. Deploy packages/chain first.`);
  }
  if (!distributorInfo) {
    throw new ClaimError(`No distributor initialised for mint ${accounts.mint.toBase58()} — the settlement worker has not run init_distributor yet.`);
  }
  const program = new Program<Dividends>({ ...dividendsIdl, address: accounts.programId.toBase58() } as Dividends, { connection });
  const claimIx = await program.methods
    .claim(new BN(p.index), new BN(p.amount), p.proof.map(hex32))
    .accountsPartial({
      claimant,
      distributor: accounts.distributor,
      epochRoot: accounts.epochRoot,
      receipt: accounts.receipt,
      vault: accounts.vault,
      claimantAta: accounts.claimantAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(claimant, accounts.claimantAta, claimant, accounts.mint),
    claimIx,
  );
  tx.feePayer = claimant;
  return { tx, accounts };
}

/** Human-readable text for wallet / RPC failures during a claim. */
export function claimErrorText(e: unknown): string {
  if (e instanceof ClaimError) return e.message;
  const msg = e instanceof Error ? e.message : String(e);
  if (/InvalidProof/.test(msg)) return "The Merkle proof was rejected on-chain — the epoch root may not be set yet.";
  if (/already in use|0x0\b/.test(msg)) return "This epoch was already claimed by this wallet.";
  if (/User rejected/i.test(msg)) return "Signature request rejected in the wallet.";
  if (/Attempt to load a program that does not exist|ProgramAccountNotFound/.test(msg)) return `The dividends program is not deployed on ${EXPLORER_CLUSTER}.`;
  return msg;
}
