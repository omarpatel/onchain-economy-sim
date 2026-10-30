import { keccak_256 } from "@noble/hashes/sha3";
import { PublicKey } from "@solana/web3.js";

/**
 * Off-chain -> on-chain dividend settlement. Each epoch the game computes a
 * per-holder payout; we build a Merkle tree whose leaves EXACTLY match the
 * `dividends` program:
 *
 *   leaf = keccak256( epoch:u64le || index:u64le || claimant:32 || amount:u64le )
 *
 * and internal nodes use sorted-pair hashing. The root is published on-chain via
 * `set_epoch_root`; holders then claim with the generated proofs.
 */
export interface Allocation {
  index: number;
  claimant: PublicKey;
  amount: bigint;
}

function u64le(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  let v = n;
  for (let i = 0; i < 8; i++) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
}

function cat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function leafHash(epoch: bigint, a: Allocation): Uint8Array {
  return keccak_256(cat(u64le(epoch), u64le(BigInt(a.index)), a.claimant.toBytes(), u64le(a.amount)));
}

function hashPair(a: Uint8Array, b: Uint8Array): Uint8Array {
  // sorted pair (matches the program's `computed <= node` branch)
  return Buffer.compare(Buffer.from(a), Buffer.from(b)) <= 0
    ? keccak_256(cat(a, b))
    : keccak_256(cat(b, a));
}

export interface EpochTree {
  epoch: bigint;
  root: Uint8Array;
  total: bigint;
  proofs: Record<number, Uint8Array[]>;
}

export function buildEpochTree(epoch: bigint, allocations: Allocation[]): EpochTree {
  const leaves = allocations.map((a) => leafHash(epoch, a));
  const total = allocations.reduce((s, a) => s + a.amount, 0n);

  // Build all levels, tracking sibling nodes to reconstruct proofs.
  const levels: Uint8Array[][] = [leaves];
  while (levels[levels.length - 1].length > 1) {
    const prev = levels[levels.length - 1];
    const next: Uint8Array[] = [];
    for (let i = 0; i < prev.length; i += 2) {
      next.push(i + 1 < prev.length ? hashPair(prev[i], prev[i + 1]) : prev[i]);
    }
    levels.push(next);
  }
  const root = levels[levels.length - 1][0] ?? new Uint8Array(32);

  const proofs: Record<number, Uint8Array[]> = {};
  allocations.forEach((a, leafIdx) => {
    const proof: Uint8Array[] = [];
    let idx = leafIdx;
    for (let l = 0; l < levels.length - 1; l++) {
      const level = levels[l];
      const sib = idx % 2 === 0 ? idx + 1 : idx - 1;
      if (sib < level.length) proof.push(level[sib]);
      idx = Math.floor(idx / 2);
    }
    proofs[a.index] = proof;
  });

  return { epoch, root, total, proofs };
}

export const toHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
export const fromHex = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));

/** Mirror of the program's `verify`: fold the proof with sorted-pair keccak and compare to the root. */
export function verifyProof(epoch: bigint, a: Allocation, proof: Uint8Array[], root: Uint8Array): boolean {
  let computed = leafHash(epoch, a);
  for (const node of proof) computed = hashPair(computed, node);
  return Buffer.compare(Buffer.from(computed), Buffer.from(root)) === 0;
}

/** Shape served by `GET /api/epochs/:n` on the game server (see packages/sim/src/protocol.ts `EpochAllocation`). */
export interface ServerEpoch {
  epoch: number;
  tickClosed: number;
  allocations: { playerId: string; claimant: string | null; amountEcon: number; source: string }[];
}

/**
 * Collapse a server epoch into Merkle leaves: allocations without a claimant
 * pubkey are skipped (nothing to claim on-chain), amounts are summed per
 * claimant, and leaves are ordered by claimant pubkey so the index is a pure
 * function of the input. Amounts are $ECON minor units, floored to integers.
 */
export function allocationsFromEpoch(ep: ServerEpoch): Allocation[] {
  const byClaimant = new Map<string, bigint>();
  for (const a of ep.allocations) {
    if (!a.claimant || !Number.isFinite(a.amountEcon) || a.amountEcon <= 0) continue;
    const minor = BigInt(Math.floor(a.amountEcon));
    if (minor <= 0n) continue;
    byClaimant.set(a.claimant, (byClaimant.get(a.claimant) ?? 0n) + minor);
  }
  return [...byClaimant.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([claimant, amount], index) => ({ index, claimant: new PublicKey(claimant), amount }));
}

/** JSON written to `DATA_DIR/proofs/<epoch>.json` and served by the proofs HTTP endpoint. */
export interface ProofsFile {
  /** Game-server epoch number. */
  epoch: number;
  /** On-chain epoch (dense counter the dividends program enforces; equals the leaf's `epoch`). */
  chainEpoch: number;
  tickClosed: number;
  root: string;
  total: string;
  mint: string;
  programId: string;
  distributor: string;
  epochRoot: string;
  claims: Record<string, { index: number; amount: string; proof: string[] }>;
}

export function buildProofsFile(
  ep: ServerEpoch,
  chainEpoch: bigint,
  allocations: Allocation[],
  keys: { mint: PublicKey; programId: PublicKey; distributor: PublicKey; epochRoot: PublicKey },
): ProofsFile {
  const tree = buildEpochTree(chainEpoch, allocations);
  const claims: ProofsFile["claims"] = {};
  for (const a of allocations) {
    claims[a.claimant.toBase58()] = {
      index: a.index,
      amount: a.amount.toString(),
      proof: tree.proofs[a.index].map(toHex),
    };
  }
  return {
    epoch: ep.epoch,
    chainEpoch: Number(chainEpoch),
    tickClosed: ep.tickClosed,
    root: toHex(tree.root),
    total: tree.total.toString(),
    mint: keys.mint.toBase58(),
    programId: keys.programId.toBase58(),
    distributor: keys.distributor.toBase58(),
    epochRoot: keys.epochRoot.toBase58(),
    claims,
  };
}
