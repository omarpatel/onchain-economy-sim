import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BN as BNType } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, SystemProgram, type Keypair } from "@solana/web3.js";
import { Chain, PROGRAM_IDS, big, bn, pda, econ } from "./harness.ts";

const chain = new Chain();
const program = chain.program("staking");
const PID = PROGRAM_IDS.staking;

const YEAR = 365n * 24n * 3600n;
const MAX_LOCK = 4n * YEAR;

const econMint = chain.createMint(chain.payer.publicKey);
const pool = pda(PID, "pool", econMint);
const stakeVault = pda(PID, "stake", pool);
const rewardVault = pda(PID, "reward", pool);
const positionPda = (user: PublicKey) => pda(PID, "position", pool, user);

const alice = chain.wallet();
const bob = chain.wallet();
const aliceAta = chain.fund(alice.publicKey, econMint, econ(10_000));
const bobAta = chain.fund(bob.publicKey, econMint, econ(10_000));
const treasuryAta = chain.fund(chain.payer.publicKey, econMint, econ(1_000_000));

interface Pool { totalWeight: BNType; accRewardPerWeight: BNType }
interface Position { amount: BNType; weight: BNType; lockUntil: BNType; boostBps: BNType; unclaimed: BNType; rewardDebt: BNType }
const poolState = () => chain.decode<Pool>(program, "stakePool", pool);
const position = (user: PublicKey) => chain.decode<Position>(program, "stakePosition", positionPda(user));

const stakeIx = (user: Keypair, amount: bigint, lockSecs: bigint) =>
  program.methods
    .stake(bn(amount), bn(lockSecs))
    .accountsStrict({
      user: user.publicKey,
      pool,
      position: positionPda(user.publicKey),
      stakeVault,
      userEcon: chain.ata(user.publicKey, econMint),
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

const claimIx = (user: Keypair) =>
  program.methods
    .claim()
    .accountsStrict({
      user: user.publicKey,
      pool,
      position: positionPda(user.publicKey),
      rewardVault,
      userEcon: chain.ata(user.publicKey, econMint),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

const unstakeIx = (user: Keypair) =>
  program.methods
    .unstake()
    .accountsStrict({
      user: user.publicKey,
      pool,
      position: positionPda(user.publicKey),
      stakeVault,
      rewardVault,
      userEcon: chain.ata(user.publicKey, econMint),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

const distributeIx = (amount: bigint) =>
  program.methods
    .distribute(bn(amount))
    .accountsStrict({
      payer: chain.payer.publicKey,
      pool,
      rewardVault,
      payerEcon: treasuryAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

describe("staking", () => {
  it("initializes the pool and refuses to distribute with no stakers", async () => {
    const ix = await program.methods
      .initPool()
      .accountsStrict({
        admin: chain.payer.publicKey,
        econMint,
        pool,
        stakeVault,
        rewardVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    chain.send([ix]);
    assert.equal(big(poolState().totalWeight), 0n);
    assert.ok(chain.fails([await distributeIx(econ(1))]).has("NoStakers"));
  });

  it("rejects out-of-range locks, zero and dust stakes", async () => {
    assert.ok(chain.fails([await stakeIx(alice, econ(1), 0n)], [alice]).has("BadLock"));
    assert.ok(chain.fails([await stakeIx(alice, econ(1), MAX_LOCK + 1n)], [alice]).has("BadLock"));
    assert.ok(chain.fails([await stakeIx(alice, 0n, YEAR)], [alice]).has("ZeroAmount"));
    assert.ok(chain.fails([await stakeIx(alice, 999_999n, YEAR)], [alice]).has("BelowMinStake"));
  });

  it("weights stakes by lock duration (1x .. 2x)", async () => {
    chain.send([await stakeIx(alice, econ(1_000), MAX_LOCK)], [alice]);
    const a = position(alice.publicKey);
    assert.equal(big(a.amount), econ(1_000));
    assert.equal(big(a.boostBps), 20_000n);
    assert.equal(big(a.weight), econ(2_000));
    assert.equal(big(a.lockUntil), chain.now() + MAX_LOCK);

    chain.send([await stakeIx(bob, econ(1_000), YEAR)], [bob]);
    const b = position(bob.publicKey);
    assert.equal(big(b.boostBps), 12_500n);
    assert.equal(big(b.weight), econ(1_250));
    assert.equal(big(poolState().totalWeight), econ(3_250));
    assert.equal(chain.tokenBalance(stakeVault), econ(2_000));
  });

  it("splits distributed rewards pro rata by weight and pays them on claim", async () => {
    chain.send([await distributeIx(econ(325))]);
    assert.equal(chain.tokenBalance(rewardVault), econ(325));

    const before = chain.tokenBalance(aliceAta);
    chain.send([await claimIx(alice)], [alice]);
    assert.equal(chain.tokenBalance(aliceAta) - before, econ(200)); // 2000 / 3250 * 325
    // a second claim right away pays nothing more
    chain.send([await claimIx(alice)], [alice]);
    assert.equal(chain.tokenBalance(aliceAta) - before, econ(200));
    assert.equal(chain.tokenBalance(rewardVault), econ(125)); // bob's share still parked
  });

  it("merges a re-stake: settles rewards, extends the lock, re-weights the whole amount", async () => {
    chain.send([await stakeIx(bob, econ(1_000), 2n * YEAR)], [bob]);
    let b = position(bob.publicKey);
    assert.equal(big(b.amount), econ(2_000));
    assert.equal(big(b.unclaimed), econ(125)); // pending settled, not lost
    assert.equal(big(b.lockUntil), chain.now() + 2n * YEAR);
    assert.equal(big(b.boostBps), 15_000n);
    assert.equal(big(b.weight), econ(3_000));
    assert.equal(big(poolState().totalWeight), econ(5_000));

    // topping up with a SHORTER lock keeps the longer lock and its boost
    chain.send([await stakeIx(bob, econ(1_000), 86_400n)], [bob]);
    b = position(bob.publicKey);
    assert.equal(big(b.amount), econ(3_000));
    assert.equal(big(b.lockUntil), chain.now() + 2n * YEAR);
    assert.equal(big(b.boostBps), 15_000n);
    assert.equal(big(b.weight), econ(4_500));
    assert.equal(big(poolState().totalWeight), econ(6_500));
  });

  it("blocks unstaking while locked and rejects other users' positions", async () => {
    assert.ok(chain.fails([await unstakeIx(bob)], [bob]).has("StillLocked"));
    const mallory = chain.wallet();
    chain.createAta(mallory.publicKey, econMint);
    const ix = await program.methods
      .claim()
      .accountsStrict({
        user: mallory.publicKey,
        pool,
        position: positionPda(bob.publicKey),
        rewardVault,
        userEcon: chain.ata(mallory.publicKey, econMint),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    assert.ok(chain.fails([ix], [mallory]).has("ConstraintSeeds"));
  });

  it("unstake pays principal plus every accrued reward and closes the position", async () => {
    chain.send([await distributeIx(econ(650))]); // acc += 650/6500 -> alice +200, bob +450
    chain.warp(2n * YEAR + 1n);

    const bobBefore = chain.tokenBalance(bobAta);
    chain.send([await unstakeIx(bob)], [bob]);
    assert.equal(chain.tokenBalance(bobAta) - bobBefore, econ(3_000) + econ(125) + econ(450));
    assert.equal(chain.account(positionPda(bob.publicKey)), null);
    assert.equal(big(poolState().totalWeight), econ(2_000));

    assert.ok(chain.fails([await unstakeIx(alice)], [alice]).has("StillLocked"));
    chain.warp(2n * YEAR);
    const aliceBefore = chain.tokenBalance(aliceAta);
    chain.send([await unstakeIx(alice)], [alice]);
    assert.equal(chain.tokenBalance(aliceAta) - aliceBefore, econ(1_000) + econ(200));
    assert.equal(big(poolState().totalWeight), 0n);
    assert.equal(chain.tokenBalance(stakeVault), 0n);
    assert.equal(chain.tokenBalance(rewardVault), 0n);
  });

  it("lets a user who fully unstaked open a fresh position", async () => {
    chain.send([await stakeIx(bob, econ(10), YEAR)], [bob]);
    const b = position(bob.publicKey);
    assert.equal(big(b.amount), econ(10));
    assert.equal(big(b.unclaimed), 0n);
    assert.equal(big(poolState().totalWeight), 12_500_000n); // 10 ECON * 1.25
  });
});
