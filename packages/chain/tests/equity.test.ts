import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import type BN from "bn.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { Chain, PROGRAM_IDS, big, bn, pda, econ } from "./harness.ts";

const chain = new Chain();
const program = chain.program("equity");
const PID = PROGRAM_IDS.equity;

const LOCKUP = 86_400n;
const econMint = chain.createMint(chain.payer.publicKey);
const protocolAuthority = chain.wallet();
const founder = chain.wallet();
const buyer = chain.wallet();
const treasury = chain.createAta(founder.publicKey, econMint);
const buyerEcon = chain.fund(buyer.publicKey, econMint, econ(1_000_000));

const config = pda(PID, "config");
const companyPda = (who: PublicKey, id: Buffer) => pda(PID, "company", who, id);
const companyId = randomBytes(16);
const company = companyPda(founder.publicKey, companyId);
const founderVault = pda(PID, "founder", company);
const saleVault = pda(PID, "sale", company);
const shareMint = Keypair.generate();

interface Company { sharesSold: BN; floatShares: BN; totalShares: BN; founderReleased: boolean; founderUnlockTs: BN; authority: PublicKey }
const companyState = (pk: PublicKey = company) => chain.decode<Company>(program, "company", pk);

const initConfigIx = (authority: PublicKey, payer: Keypair = chain.payer) =>
  program.methods
    .initConfig(authority)
    .accountsStrict({ payer: payer.publicKey, config, systemProgram: SystemProgram.programId })
    .instruction();

interface ListOpts { signer?: Keypair; founder?: PublicKey }
const listIx = (id: Buffer, mint: Keypair, total: bigint, float: bigint, price: bigint, unlockTs: bigint, opts: ListOpts = {}) => {
  const who = opts.founder ?? founder.publicKey;
  const co = companyPda(who, id);
  return program.methods
    .listCompany(Array.from(id), bn(total), bn(float), bn(price), bn(unlockTs))
    .accountsStrict({
      authority: (opts.signer ?? protocolAuthority).publicKey,
      config,
      founder: who,
      company: co,
      shareMint: mint.publicKey,
      econMint,
      treasury,
      founderVault: pda(PID, "founder", co),
      saleVault: pda(PID, "sale", co),
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
};

const buyIx = (shares: bigint, who: Keypair = buyer) =>
  program.methods
    .buyIpo(bn(shares))
    .accountsStrict({
      buyer: who.publicKey,
      company,
      shareMint: shareMint.publicKey,
      treasury,
      saleVault,
      buyerEcon: chain.ata(who.publicKey, econMint),
      buyerShares: chain.ata(who.publicKey, shareMint.publicKey),
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

const unlockIx = (who: Keypair = founder) =>
  program.methods
    .unlockFounder()
    .accountsStrict({
      authority: who.publicKey,
      company,
      shareMint: shareMint.publicKey,
      founderVault,
      founderShares: chain.ata(who.publicKey, shareMint.publicKey),
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

describe("equity", () => {
  it("refuses to list before the config exists, then initializes the singleton config once", async () => {
    const id = randomBytes(16);
    const mint = Keypair.generate();
    const err = chain.fails([await listIx(id, mint, 100n, 40n, econ(1), 0n)], [protocolAuthority, mint]);
    assert.ok(err.has("AccountNotInitialized"), err.message);

    chain.send([await initConfigIx(protocolAuthority.publicKey)]);
    const c = chain.decode<{ authority: PublicKey }>(program, "config", config);
    assert.ok(c.authority.equals(protocolAuthority.publicKey));
    // nobody can re-point the authority by initializing again
    const again = chain.fails([await initConfigIx(buyer.publicKey, buyer)], [buyer]);
    assert.ok(again.has("already in use"), again.message);
    assert.ok(chain.decode<{ authority: PublicKey }>(program, "config", config).authority.equals(protocolAuthority.publicKey));
  });

  it("only the protocol authority may list a company", async () => {
    const id = randomBytes(16);
    const mint = Keypair.generate();
    // the founder themselves cannot self-list
    const err = chain.fails([await listIx(id, mint, 100n, 40n, econ(1), 0n, { signer: founder })], [founder, mint]);
    assert.ok(err.has("Unauthorized"), err.message);
    assert.equal(chain.account(companyPda(founder.publicKey, id)), null);
    assert.equal(chain.account(mint.publicKey), null);
  });

  it("rejects a float larger than the cap table", async () => {
    const id = randomBytes(16);
    const mint = Keypair.generate();
    assert.ok(chain.fails([await listIx(id, mint, 100n, 101n, econ(1), 0n)], [protocolAuthority, mint]).has("BadFloat"));
  });

  it("lists a company: founder shares escrowed, float in the sale vault, mint frozen", async () => {
    const unlockTs = chain.now() + LOCKUP;
    chain.send([await listIx(companyId, shareMint, 1_000n, 400n, econ(5), unlockTs)], [protocolAuthority, shareMint]);
    assert.equal(chain.tokenBalance(founderVault), 600n);
    assert.equal(chain.tokenBalance(saleVault), 400n);
    const m = chain.mintInfo(shareMint.publicKey);
    assert.equal(m.supply, 1_000n);
    assert.equal(m.mintAuthority, null);
    const c = companyState();
    assert.equal(big(c.totalShares), 1_000n);
    assert.equal(big(c.floatShares), 400n);
    assert.equal(big(c.founderUnlockTs), unlockTs);
    assert.ok(c.authority.equals(founder.publicKey));
    // the founder holds nothing liquid
    assert.equal(chain.account(chain.ata(founder.publicKey, shareMint.publicKey)), null);
  });

  it("gives the same company id a distinct PDA per founder, and never relists the same pair", async () => {
    const other = chain.wallet();
    const otherCompany = companyPda(other.publicKey, companyId);
    assert.notEqual(otherCompany.toBase58(), company.toBase58());
    const mint = Keypair.generate();
    chain.send([await listIx(companyId, mint, 50n, 10n, econ(2), 0n, { founder: other.publicKey })], [protocolAuthority, mint]);
    assert.ok(companyState(otherCompany).authority.equals(other.publicKey));
    assert.equal(big(companyState(otherCompany).totalShares), 50n);
    // the original listing is untouched
    assert.equal(big(companyState().totalShares), 1_000n);
    assert.equal(chain.tokenBalance(founderVault), 600n);
    // (founder, id) is unique
    const dup = Keypair.generate();
    const err = chain.fails([await listIx(companyId, dup, 50n, 10n, econ(2), 0n)], [protocolAuthority, dup]);
    assert.ok(err.has("already in use"), err.message);
  });

  it("sells IPO shares for $ECON into the treasury and creates the buyer's share ATA", async () => {
    chain.send([await buyIx(100n)], [buyer]);
    assert.equal(chain.tokenBalance(treasury), econ(500));
    assert.equal(chain.tokenBalance(buyerEcon), econ(1_000_000) - econ(500));
    assert.equal(chain.tokenBalance(chain.ata(buyer.publicKey, shareMint.publicKey)), 100n);
    assert.equal(chain.tokenBalance(saleVault), 300n);
    assert.equal(big(companyState().sharesSold), 100n);
  });

  it("never sells more than the float", async () => {
    assert.ok(chain.fails([await buyIx(301n)], [buyer]).has("FloatExhausted"));
    assert.ok(chain.fails([await buyIx(0n)], [buyer]).has("ZeroShares"));
    chain.send([await buyIx(300n)], [buyer]);
    assert.equal(chain.tokenBalance(saleVault), 0n);
    assert.equal(chain.tokenBalance(chain.ata(buyer.publicKey, shareMint.publicKey)), 400n);
    assert.ok(chain.fails([await buyIx(1n)], [buyer]).has("FloatExhausted"));
    assert.equal(chain.tokenBalance(treasury), econ(2_000));
  });

  it("keeps founder shares locked until the unlock timestamp, and only for the authority", async () => {
    assert.ok(chain.fails([await unlockIx()], [founder]).has("FounderLocked"));
    chain.warp(LOCKUP + 1n);
    assert.ok(chain.fails([await unlockIx(buyer)], [buyer]).has("ConstraintHasOne"));
    assert.equal(chain.tokenBalance(founderVault), 600n);
  });

  it("releases the escrow to the founder after the lockup and closes the vault", async () => {
    const lamportsBefore = chain.svm.getBalance(founder.publicKey.toBase58() as never) ?? 0n;
    chain.send([await unlockIx()], [founder]);
    assert.equal(chain.tokenBalance(chain.ata(founder.publicKey, shareMint.publicKey)), 600n);
    assert.equal(chain.account(founderVault), null);
    assert.ok(companyState().founderReleased);
    // the founder paid rent for their new share ATA and got exactly the escrow's rent back
    const lamportsAfter = chain.svm.getBalance(founder.publicKey.toBase58() as never) ?? 0n;
    assert.equal(lamportsAfter, lamportsBefore);
    // cannot be released twice
    const err = chain.fails([await unlockIx()], [founder]);
    assert.ok(err.has("AccountNotInitialized") || err.has("AlreadyReleased"), err.message);
  });
});
