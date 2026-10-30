import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as anchor from "@coral-xyz/anchor";
import { getAccount, getAssociatedTokenAddressSync, getMint, TOKEN_PROGRAM_ID, TokenAccountNotFoundError } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import type { Dividends } from "../../chain/target/types/dividends.ts";
import { CHAIN_DIR, ConfigError } from "./config.ts";
import { distributorPda, epochRootPda, vaultPda } from "./pdas.ts";

const { AnchorProvider, BN, Program, Wallet } = anchor;

export function loadDividendsIdl(chainDir = CHAIN_DIR): anchor.Idl {
  const file = resolve(chainDir, "target/idl/dividends.json");
  if (!existsSync(file)) {
    throw new ConfigError(`${file} not found. Run \`anchor build\` in packages/chain to generate the dividends IDL.`);
  }
  return JSON.parse(readFileSync(file, "utf8")) as anchor.Idl;
}

export interface TxOutcome {
  /** Transaction signature when sent; null in dry-run. */
  signature: string | null;
  dryRun: boolean;
  /** Program logs from simulation (dry-run) or confirmation. */
  logs: string[];
  /** Simulation error text (dry-run only) — the tx was still built and printed. */
  simulationError: string | null;
}

/**
 * Thin wrapper over the Anchor client for the `dividends` Merkle distributor.
 * In dry-run mode every instruction is built, signed and simulated but never sent.
 */
export class DividendsClient {
  readonly conn: Connection;
  readonly authority: Keypair;
  readonly mint: PublicKey;
  readonly programId: PublicKey;
  readonly distributor: PublicKey;
  readonly vault: PublicKey;
  readonly dryRun: boolean;
  readonly program: anchor.Program<Dividends>;
  private readonly accountNames: Record<string, string[]>;
  private decimals: number | null = null;

  constructor(opts: {
    conn: Connection;
    authority: Keypair;
    mint: PublicKey;
    programId: PublicKey;
    idl: anchor.Idl;
    dryRun: boolean;
  }) {
    this.conn = opts.conn;
    this.authority = opts.authority;
    this.mint = opts.mint;
    this.programId = opts.programId;
    this.dryRun = opts.dryRun;
    this.distributor = distributorPda(opts.programId, opts.mint);
    this.vault = vaultPda(opts.programId, this.distributor);
    const provider = new AnchorProvider(opts.conn, new Wallet(opts.authority), { commitment: "confirmed" });
    // programs.json is the source of truth for the deployed id; the IDL's `address` may be a stale localnet key.
    const idl = { ...opts.idl, address: opts.programId.toBase58() } as Dividends;
    this.program = new Program<Dividends>(idl, provider);
    this.accountNames = {};
    for (const ix of opts.idl.instructions) this.accountNames[ix.name] = ix.accounts.map((a) => a.name);
  }

  get funderAta(): PublicKey {
    return getAssociatedTokenAddressSync(this.mint, this.authority.publicKey, true);
  }

  /** Only pass accounts the IDL actually declares (snake_case in IDL → camelCase in the TS client). */
  private pick(ix: string, all: Record<string, PublicKey>): Record<string, PublicKey> {
    const names = this.accountNames[ix];
    if (!names) throw new ConfigError(`dividends IDL has no instruction "${ix}"`);
    const out: Record<string, PublicKey> = {};
    for (const snake of names) {
      const camel = snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      if (all[camel]) out[camel] = all[camel];
    }
    return out;
  }

  async distributorState(): Promise<{ epoch: bigint; admin: PublicKey } | null> {
    const acc = await this.program.account.distributor.fetchNullable(this.distributor);
    if (!acc) return null;
    return { epoch: BigInt(acc.epoch.toString()), admin: acc.admin };
  }

  /** Mint decimals (cached) + funder ATA balance; the settler refuses roots the ATA cannot cover. */
  async funder(): Promise<{ decimals: number; balance: bigint | null }> {
    this.decimals ??= (await getMint(this.conn, this.mint)).decimals;
    try {
      return { decimals: this.decimals, balance: (await getAccount(this.conn, this.funderAta)).amount };
    } catch (e) {
      if (e instanceof TokenAccountNotFoundError) return { decimals: this.decimals, balance: null };
      throw e;
    }
  }

  async epochRootExists(epoch: bigint): Promise<boolean> {
    const info = await this.conn.getAccountInfo(epochRootPda(this.programId, this.distributor, epoch));
    return info !== null;
  }

  /** `init_distributor` once; a no-op when the PDA already exists. */
  async ensureDistributor(claimWindowSecs: bigint): Promise<TxOutcome | null> {
    if (await this.distributorState()) return null;
    const accounts = this.pick("init_distributor", {
      admin: this.authority.publicKey,
      mint: this.mint,
      distributor: this.distributor,
      vault: this.vault,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    });
    const tx = await this.program.methods
      .initDistributor(new BN(claimWindowSecs.toString()))
      .accountsPartial(accounts)
      .transaction();
    return this.execute(tx, `init_distributor(claim_window_secs=${claimWindowSecs})`);
  }

  async setEpochRoot(epoch: bigint, root: Uint8Array, total: bigint): Promise<TxOutcome> {
    const epochRoot = epochRootPda(this.programId, this.distributor, epoch);
    const accounts = this.pick("set_epoch_root", {
      admin: this.authority.publicKey,
      distributor: this.distributor,
      epochRoot,
      vault: this.vault,
      funderAta: this.funderAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    });
    const tx = await this.program.methods
      .setEpochRoot(new BN(epoch.toString()), Array.from(root), new BN(total.toString()))
      .accountsPartial(accounts)
      .transaction();
    return this.execute(tx, `set_epoch_root(epoch=${epoch}, total=${total})`);
  }

  private async execute(tx: Transaction, label: string): Promise<TxOutcome> {
    const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash("confirmed");
    tx.feePayer = this.authority.publicKey;
    tx.recentBlockhash = blockhash;
    tx.sign(this.authority);

    if (this.dryRun) {
      const sim = await this.conn.simulateTransaction(tx);
      const err = sim.value.err ? JSON.stringify(sim.value.err) : null;
      console.log(`[dividends] DRY_RUN ${label} simulated: ${err ? `error ${err}` : "ok"} (${sim.value.unitsConsumed ?? "?"} CU)`);
      return { signature: null, dryRun: true, logs: sim.value.logs ?? [], simulationError: err };
    }

    const signature = await this.conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    const conf = await this.conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
    if (conf.value.err) throw new Error(`${label} failed on-chain: ${JSON.stringify(conf.value.err)} (${signature})`);
    console.log(`[dividends] ${label} confirmed ${signature}`);
    return { signature, dryRun: false, logs: [], simulationError: null };
  }
}
