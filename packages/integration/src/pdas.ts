import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";

/**
 * PDA derivations for the `dividends` and `staking` programs, mirrored from
 * packages/chain/programs/<name>/src/lib.rs. Shared by the worker, the localnet
 * scripts and the web claim button (packages/web/lib/client/claim.ts), so this
 * module must stay free of Node-only imports and of `Buffer`.
 */

const utf8 = new TextEncoder();

export function u64le(n: bigint | number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
}

export function distributorPda(programId: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([utf8.encode("distributor"), mint.toBytes()], programId)[0];
}
export function vaultPda(programId: PublicKey, distributor: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([utf8.encode("vault"), distributor.toBytes()], programId)[0];
}
export function epochRootPda(programId: PublicKey, distributor: PublicKey, epoch: bigint | number): PublicKey {
  return PublicKey.findProgramAddressSync([utf8.encode("epoch"), distributor.toBytes(), u64le(epoch)], programId)[0];
}
export function receiptPda(programId: PublicKey, epochRoot: PublicKey, claimant: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([utf8.encode("receipt"), epochRoot.toBytes(), claimant.toBytes()], programId)[0];
}

export interface ClaimAccounts {
  programId: PublicKey;
  mint: PublicKey;
  distributor: PublicKey;
  epochRoot: PublicKey;
  receipt: PublicKey;
  vault: PublicKey;
  claimantAta: PublicKey;
}

/** Every account `dividends.claim` needs for `claimant` on on-chain epoch `chainEpoch`. */
export function claimAccounts(programId: PublicKey, mint: PublicKey, claimant: PublicKey, chainEpoch: bigint | number): ClaimAccounts {
  const distributor = distributorPda(programId, mint);
  const epochRoot = epochRootPda(programId, distributor, chainEpoch);
  return {
    programId,
    mint,
    distributor,
    epochRoot,
    receipt: receiptPda(programId, epochRoot, claimant),
    vault: vaultPda(programId, distributor),
    claimantAta: getAssociatedTokenAddressSync(mint, claimant),
  };
}

export function stakePoolPda(programId: PublicKey, econMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([utf8.encode("pool"), econMint.toBytes()], programId)[0];
}
export function stakeVaultPda(programId: PublicKey, pool: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([utf8.encode("stake"), pool.toBytes()], programId)[0];
}
export function rewardVaultPda(programId: PublicKey, pool: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([utf8.encode("reward"), pool.toBytes()], programId)[0];
}
export function stakePositionPda(programId: PublicKey, pool: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([utf8.encode("position"), pool.toBytes(), owner.toBytes()], programId)[0];
}
