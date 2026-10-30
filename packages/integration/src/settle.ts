import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PublicKey } from "@solana/web3.js";
import { DEFAULT_MAX_EPOCH_TOTAL_ECON } from "./config.ts";
import type { TxOutcome } from "./dividends.ts";
import { epochRootPda } from "./pdas.ts";
import type { GameServer } from "./server.ts";
import { allocationsFromEpoch, buildProofsFile, fromHex, type ProofsFile, type ServerEpoch } from "./settlement.ts";

/** What the settler needs from the chain; `DividendsClient` implements it, tests can stub it. */
export interface RootPublisher {
  readonly programId: PublicKey;
  readonly mint: PublicKey;
  readonly distributor: PublicKey;
  readonly dryRun: boolean;
  /** Current on-chain epoch counter, or null while the distributor is uninitialised. */
  distributorState(): Promise<{ epoch: bigint } | null>;
  /** Mint decimals + the authority's ATA balance in minor units (null when the ATA does not exist). */
  funder(): Promise<{ decimals: number; balance: bigint | null }>;
  setEpochRoot(epoch: bigint, root: Uint8Array, total: bigint): Promise<TxOutcome>;
}

export interface SettledEpoch {
  chainEpoch: number;
  root: string;
  total: string;
  holders: number;
  signature: string | null;
  dryRun: boolean;
  at: string;
}

/** An epoch the settler refused to fund; it is retried every poll until the total fits `limit`. */
export interface BlockedEpoch {
  blocked: "ceiling" | "funds";
  total: string;
  limit: string;
  at: string;
}

interface SettledFile {
  lastEpoch: number;
  epochs: Record<string, SettledEpoch | BlockedEpoch | { skipped: "empty" | "missing"; at: string }>;
}

/** `DATA_DIR/settled.json` + `DATA_DIR/proofs/<epoch>.json`, written atomically. */
export class SettlementStore {
  readonly dataDir: string;
  private state: SettledFile;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    mkdirSync(resolve(dataDir, "proofs"), { recursive: true });
    const file = resolve(dataDir, "settled.json");
    this.state = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as SettledFile) : { lastEpoch: 0, epochs: {} };
  }

  get lastEpoch(): number {
    return this.state.lastEpoch;
  }

  /** Highest chain epoch we have published (dry-run included) — the fallback counter when the distributor is unreachable. */
  get lastChainEpoch(): number {
    let max = 0;
    for (const e of Object.values(this.state.epochs)) if ("chainEpoch" in e && e.chainEpoch > max) max = e.chainEpoch;
    return max;
  }

  entry(epoch: number): SettledFile["epochs"][string] | undefined {
    return this.state.epochs[String(epoch)];
  }

  private atomicWrite(path: string, data: unknown): void {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, path);
  }

  writeProofs(file: ProofsFile): string {
    const path = resolve(this.dataDir, "proofs", `${file.epoch}.json`);
    this.atomicWrite(path, file);
    return path;
  }

  readProofs(epoch: number): ProofsFile | null {
    const path = resolve(this.dataDir, "proofs", `${epoch}.json`);
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as ProofsFile) : null;
  }

  /** Blocked entries are recorded for `/health` but never advance `lastEpoch`, so the epoch is retried next pass. */
  record(epoch: number, entry: SettledFile["epochs"][string]): void {
    this.state.epochs[String(epoch)] = entry;
    if (!("blocked" in entry) && epoch > this.state.lastEpoch) this.state.lastEpoch = epoch;
    this.atomicWrite(resolve(this.dataDir, "settled.json"), this.state);
  }

  /** Epochs currently refused (ceiling / funds), oldest first. */
  blocked(): (BlockedEpoch & { epoch: number })[] {
    return Object.entries(this.state.epochs)
      .filter((kv): kv is [string, BlockedEpoch] => "blocked" in kv[1])
      .map(([k, e]) => ({ epoch: Number(k), ...e }))
      .sort((a, b) => a.epoch - b.epoch);
  }
}

export interface SettleResult {
  epoch: number;
  status: "published" | "empty" | "missing" | "blocked";
  proofsPath?: string;
  outcome?: TxOutcome;
  /** Why a `blocked` epoch was refused. */
  reason?: string;
}

/**
 * One settlement pass: pull every epoch the server closed since the last one we
 * recorded, build the Merkle tree for claimant-bearing allocations, write the
 * proofs file, and publish the root. Epochs without claimants are recorded as
 * skipped so the on-chain epoch counter stays dense.
 *
 * The server's total is never trusted blindly: an epoch is refused (recorded as
 * `blocked`, retried next pass, later epochs wait behind it) when its total
 * exceeds `maxEpochTotalEcon` or — live only — the funder ATA balance, so a
 * compromised or buggy server can at most drain one ceiling's worth per epoch.
 */
export class EpochSettler {
  private readonly server: GameServer;
  private readonly chain: RootPublisher;
  private readonly store: SettlementStore;
  private readonly maxEpochTotalEcon: number;

  constructor(server: GameServer, chain: RootPublisher, store: SettlementStore, opts: { maxEpochTotalEcon?: number } = {}) {
    this.server = server;
    this.chain = chain;
    this.store = store;
    this.maxEpochTotalEcon = opts.maxEpochTotalEcon ?? DEFAULT_MAX_EPOCH_TOTAL_ECON;
  }

  async run(): Promise<SettleResult[]> {
    const latest = await this.server.latestEpoch();
    if (!latest) return [];
    const results: SettleResult[] = [];
    for (let n = this.store.lastEpoch + 1; n <= latest.epoch; n++) {
      const ep = n === latest.epoch ? latest : await this.server.epoch(n);
      const r = await this.settleOne(n, ep);
      results.push(r);
      // The chain epoch counter is dense: nothing after a refused epoch may be published before it.
      if (r.status === "blocked") break;
    }
    return results;
  }

  /** Ceiling + (live) funder balance check. Returns the `blocked` entry to record, or null when the total may be funded. */
  private async refuse(total: bigint): Promise<Omit<BlockedEpoch, "at"> | null> {
    const { decimals, balance } = await this.chain.funder();
    const ceiling = BigInt(this.maxEpochTotalEcon) * 10n ** BigInt(decimals);
    if (total > ceiling) return { blocked: "ceiling", total: String(total), limit: String(ceiling) };
    if (this.chain.dryRun) return null; // ephemeral dry-run keys hold nothing; the simulation reports funding errors instead
    if (balance === null || total > balance) return { blocked: "funds", total: String(total), limit: String(balance ?? 0n) };
    return null;
  }

  async settleOne(n: number, ep: ServerEpoch | null): Promise<SettleResult> {
    const at = new Date().toISOString();
    if (!ep) {
      this.store.record(n, { skipped: "missing", at });
      return { epoch: n, status: "missing" };
    }
    const allocations = allocationsFromEpoch(ep);
    if (allocations.length === 0) {
      this.store.record(n, { skipped: "empty", at });
      return { epoch: n, status: "empty" };
    }

    let total = 0n;
    for (const a of allocations) total += a.amount;
    const refusal = await this.refuse(total);
    if (refusal) {
      this.store.record(n, { ...refusal, at });
      const reason = `total ${refusal.total} minor exceeds ${refusal.blocked === "ceiling" ? "MAX_EPOCH_TOTAL_ECON" : "funder ATA balance"} (${refusal.limit})`;
      console.warn(`[settle] epoch ${n} BLOCKED: ${reason}; retrying next poll`);
      return { epoch: n, status: "blocked", reason };
    }

    // Live: the program is the counter (it rejects anything but epoch+1). Dry-run: nothing is ever
    // sent, so advance our own counter past whatever the chain and earlier dry-runs reached.
    const onChain = await this.chain.distributorState();
    const stored = this.store.lastChainEpoch;
    const base = onChain ? (this.chain.dryRun ? Math.max(Number(onChain.epoch), stored) : Number(onChain.epoch)) : stored;
    const chainEpoch = BigInt(base) + 1n;
    const file = buildProofsFile(ep, chainEpoch, allocations, {
      mint: this.chain.mint,
      programId: this.chain.programId,
      distributor: this.chain.distributor,
      epochRoot: epochRootPda(this.chain.programId, this.chain.distributor, chainEpoch),
    });
    const proofsPath = this.store.writeProofs(file);
    console.log(
      `[settle] epoch=${n} chainEpoch=${chainEpoch} holders=${allocations.length} total=${file.total} root=0x${file.root}`,
    );

    const outcome = await this.chain.setEpochRoot(chainEpoch, fromHex(file.root), BigInt(file.total));
    this.store.record(n, {
      chainEpoch: Number(chainEpoch),
      root: file.root,
      total: file.total,
      holders: allocations.length,
      signature: outcome.signature,
      dryRun: outcome.dryRun,
      at,
    });
    return { epoch: n, status: "published", proofsPath, outcome };
  }
}
