// Shared LiteSVM harness: boots an in-process SVM, loads the built programs
// from target/deploy, and gives the tests a tiny web3.js-v1-flavoured API.
// litesvm 1.x speaks @solana/kit, so signed legacy transactions are re-decoded
// from their wire bytes before submission.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { getTransactionDecoder, type Address } from "@solana/kit";
import {
  ACCOUNT_SIZE,
  AccountLayout,
  MINT_SIZE,
  MintLayout,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeAccount3Instruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { FailedTransactionMetadata, LiteSVM, type TransactionMetadata } from "litesvm";

export { BN };
export type ProgramName = "dividends" | "staking" | "equity" | "memecoin_factory";

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
export const PROGRAM_IDS: Record<ProgramName, PublicKey> = Object.fromEntries(
  Object.entries(JSON.parse(readFileSync(here("../programs.json"), "utf8")) as Record<string, string>).map(
    ([k, v]) => [k, new PublicKey(v)],
  ),
) as Record<ProgramName, PublicKey>;

export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const ECON_DECIMALS = 6;
export const econ = (n: number | bigint): bigint => BigInt(n) * 1_000_000n;

export class TxError extends Error {
  readonly logs: string[];
  readonly err: string;
  constructor(logs: string[], err: string) {
    super(`transaction failed: ${err}\n${logs.join("\n")}`);
    this.logs = logs;
    this.err = err;
  }
  has(text: string): boolean {
    return this.err.includes(text) || this.logs.some((l) => l.includes(text));
  }
}

export class Chain {
  readonly svm = new LiteSVM();
  readonly payer = Keypair.generate();

  constructor() {
    this.airdrop(this.payer.publicKey, 1_000n * LAMPORTS_PER_SOL);
  }

  program(name: ProgramName): anchor.Program {
    const idl = JSON.parse(readFileSync(here(`../target/idl/${name}.json`), "utf8")) as anchor.Idl;
    this.svm.addProgramFromFile(addr(PROGRAM_IDS[name]), here(`../target/deploy/${name}.so`));
    // No RPC: every instruction is built with accountsStrict(), so the
    // provider only needs to exist.
    const provider = { connection: new Connection("http://127.0.0.1:8899"), publicKey: this.payer.publicKey };
    return new anchor.Program(idl, provider as unknown as anchor.Provider);
  }

  airdrop(to: PublicKey, lamports: bigint): void {
    this.svm.airdrop(addr(to), lamports);
  }

  wallet(sol = 10n): Keypair {
    const kp = Keypair.generate();
    this.airdrop(kp.publicKey, sol * LAMPORTS_PER_SOL);
    return kp;
  }

  /** Send instructions signed by `signers` (payer auto-added). Throws TxError on failure. */
  send(ixs: TransactionInstruction[], signers: Keypair[] = []): TransactionMetadata {
    const tx = new Transaction({ feePayer: this.payer.publicKey, recentBlockhash: this.svm.latestBlockhash() });
    tx.add(...ixs);
    const uniq = new Map<string, Keypair>();
    for (const s of [this.payer, ...signers]) uniq.set(s.publicKey.toBase58(), s);
    tx.sign(...uniq.values());
    const res = this.svm.sendTransaction(getTransactionDecoder().decode(tx.serialize()));
    // A fresh blockhash per transaction so identical retries are never deduplicated.
    this.svm.expireBlockhash();
    if (res instanceof FailedTransactionMetadata) throw new TxError(res.meta().logs(), res.err().toString());
    return res;
  }

  /** Send and return the TxError instead of throwing; fails the test if the tx succeeded. */
  fails(ixs: TransactionInstruction[], signers: Keypair[] = []): TxError {
    try {
      this.send(ixs, signers);
    } catch (e) {
      if (e instanceof TxError) return e;
      throw e;
    }
    throw new Error("expected transaction to fail");
  }

  account(pk: PublicKey): Buffer | null {
    const a = this.svm.getAccount(addr(pk));
    return a.exists ? Buffer.from(a.data) : null;
  }

  decode<T>(program: anchor.Program, name: string, pk: PublicKey): T {
    const data = this.account(pk);
    if (!data) throw new Error(`account ${pk.toBase58()} (${name}) does not exist`);
    return program.coder.accounts.decode(name, data) as T;
  }

  tokenBalance(pk: PublicKey): bigint {
    const data = this.account(pk);
    if (!data) return 0n;
    return AccountLayout.decode(data).amount;
  }

  mintInfo(mint: PublicKey) {
    const data = this.account(mint);
    if (!data) throw new Error("mint missing");
    const m = MintLayout.decode(data);
    return { supply: m.supply, mintAuthority: m.mintAuthorityOption === 1 ? m.mintAuthority : null };
  }

  createMint(authority: PublicKey, decimals = ECON_DECIMALS): PublicKey {
    const mint = Keypair.generate();
    this.send(
      [
        SystemProgram.createAccount({
          fromPubkey: this.payer.publicKey,
          newAccountPubkey: mint.publicKey,
          lamports: Number(this.svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE))),
          space: MINT_SIZE,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(mint.publicKey, decimals, authority, null),
      ],
      [mint],
    );
    return mint.publicKey;
  }

  ata(owner: PublicKey, mint: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(mint, owner, true);
  }

  createAta(owner: PublicKey, mint: PublicKey): PublicKey {
    const ata = this.ata(owner, mint);
    if (!this.account(ata)) {
      this.send([createAssociatedTokenAccountInstruction(this.payer.publicKey, ata, owner, mint)]);
    }
    return ata;
  }

  /** A plain (non-associated) token account owned by `owner`. */
  createAuxTokenAccount(owner: PublicKey, mint: PublicKey): PublicKey {
    const acct = Keypair.generate();
    this.send(
      [
        SystemProgram.createAccount({
          fromPubkey: this.payer.publicKey,
          newAccountPubkey: acct.publicKey,
          lamports: Number(this.svm.minimumBalanceForRentExemption(BigInt(ACCOUNT_SIZE))),
          space: ACCOUNT_SIZE,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeAccount3Instruction(acct.publicKey, mint, owner),
      ],
      [acct],
    );
    return acct.publicKey;
  }

  /** Create (if needed) the owner's ATA and mint `amount` into it; `authority` signs. */
  fund(owner: PublicKey, mint: PublicKey, amount: bigint, authority: Keypair = this.payer): PublicKey {
    const ata = this.createAta(owner, mint);
    this.send([createMintToInstruction(mint, ata, authority.publicKey, amount)], [authority]);
    return ata;
  }

  now(): bigint {
    return this.svm.getClock().unixTimestamp;
  }

  /** Advance the Clock sysvar by `secs` (and one slot so blockhashes rotate). */
  warp(secs: bigint | number): void {
    const clock = this.svm.getClock();
    clock.unixTimestamp = clock.unixTimestamp + BigInt(secs);
    clock.slot = clock.slot + 1n;
    this.svm.setClock(clock);
  }

  rentFor(size: number = ACCOUNT_SIZE): bigint {
    return this.svm.minimumBalanceForRentExemption(BigInt(size));
  }
}

export const addr = (pk: PublicKey): Address => pk.toBase58() as Address;
export const pda = (program: PublicKey, ...seeds: (Buffer | Uint8Array | PublicKey | string)[]): PublicKey =>
  PublicKey.findProgramAddressSync(
    seeds.map((s) => (s instanceof PublicKey ? s.toBuffer() : typeof s === "string" ? Buffer.from(s) : Buffer.from(s))),
    program,
  )[0];
export const u64le = (n: bigint | number): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
export const bn = (n: bigint | number) => new BN(n.toString());
export const big = (v: BN | bigint | number): bigint => BigInt(v.toString());
