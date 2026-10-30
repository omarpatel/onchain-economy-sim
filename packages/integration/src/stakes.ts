import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import type { Staking } from "../../chain/target/types/staking.ts";
import { CHAIN_DIR, ConfigError } from "./config.ts";
import { stakePoolPda } from "./pdas.ts";

const { AnchorProvider, Program, Wallet } = anchor;

/** Byte offset of `StakePosition.pool`: 8-byte discriminator + 32-byte `owner`. */
export const POSITION_POOL_OFFSET = 8 + 32;

export function loadStakingIdl(chainDir = CHAIN_DIR): anchor.Idl {
  const file = resolve(chainDir, "target/idl/staking.json");
  if (!existsSync(file)) {
    throw new ConfigError(`${file} not found. Run \`anchor build\` in packages/chain to generate the staking IDL.`);
  }
  return JSON.parse(readFileSync(file, "utf8")) as anchor.Idl;
}

/** The subset of a decoded `StakePosition` the observer needs. */
export interface StakePosition {
  owner: PublicKey;
  pool: PublicKey;
  amount: bigint;
}

/** What the game server receives on `POST /admin/onchain-stakes`. */
export interface StakeSnapshot {
  /** owner pubkey → staked $ECON minor units (positions in `pool` only, zero-amount positions dropped). */
  stakes: Record<string, number>;
  asOfSlot: number;
  positions: number;
}

/**
 * Sum principal per owner for positions in `pool`. Positions from other pools
 * and emptied (`amount == 0`, closed-but-not-yet-reaped) positions are dropped
 * so the server's yield denominator only counts real, locked $ECON.
 */
export function aggregateStakes(positions: StakePosition[], pool: PublicKey): Record<string, number> {
  const byOwner = new Map<string, bigint>();
  for (const p of positions) {
    if (p.amount <= 0n || !p.pool.equals(pool)) continue;
    const key = p.owner.toBase58();
    byOwner.set(key, (byOwner.get(key) ?? 0n) + p.amount);
  }
  const out: Record<string, number> = {};
  for (const [owner, amount] of [...byOwner.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`stake for ${owner} (${amount}) exceeds 2^53 minor units`);
    out[owner] = Number(amount);
  }
  return out;
}

/**
 * Reads every `StakePosition` of the $ECON pool (`getProgramAccounts` filtered
 * by the Anchor discriminator + pool) so on-chain yield is allocated to $ECON
 * that is verifiably locked, never to in-sim balances. Read-only: the wallet is
 * never asked to sign.
 */
export class StakeObserver {
  readonly conn: Connection;
  readonly programId: PublicKey;
  readonly pool: PublicKey;
  readonly program: anchor.Program<Staking>;

  constructor(opts: { conn: Connection; programId: PublicKey; econMint: PublicKey; idl: anchor.Idl }) {
    this.conn = opts.conn;
    this.programId = opts.programId;
    this.pool = stakePoolPda(opts.programId, opts.econMint);
    const provider = new AnchorProvider(opts.conn, new Wallet(Keypair.generate()), { commitment: "confirmed" });
    const idl = { ...opts.idl, address: opts.programId.toBase58() } as Staking;
    this.program = new Program<Staking>(idl, provider);
  }

  /** Decode raw `StakePosition` account bytes (discriminator included). */
  decode(data: Buffer): StakePosition {
    const acc = this.program.coder.accounts.decode<{ owner: PublicKey; pool: PublicKey; amount: anchor.BN }>("stakePosition", data);
    return { owner: acc.owner, pool: acc.pool, amount: BigInt(acc.amount.toString()) };
  }

  /** All positions in the pool at `confirmed` commitment. */
  async fetchPositions(): Promise<StakePosition[]> {
    const raw = await this.conn.getProgramAccounts(this.programId, {
      commitment: "confirmed",
      filters: [
        // coder.accounts.memcmp() returns the inner { offset, bytes }; unwrapped it is rejected by Agave ≥ 2.x
        { memcmp: this.program.coder.accounts.memcmp("stakePosition") },
        { memcmp: { offset: POSITION_POOL_OFFSET, bytes: this.pool.toBase58() } },
      ],
    });
    return raw.map(({ account }) => this.decode(account.data));
  }

  async snapshot(): Promise<StakeSnapshot> {
    const asOfSlot = await this.conn.getSlot("confirmed");
    const positions = await this.fetchPositions();
    return { stakes: aggregateStakes(positions, this.pool), asOfSlot, positions: positions.length };
  }
}
