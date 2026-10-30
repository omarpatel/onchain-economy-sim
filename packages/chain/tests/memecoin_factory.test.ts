import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type BN from "bn.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { Chain, PROGRAM_IDS, type TxError, big, bn, pda, econ } from "./harness.ts";

const chain = new Chain();
const program = chain.program("memecoin_factory");
const PID = PROGRAM_IDS.memecoin_factory;

// Curve constants mirrored from the program.
const TOTAL_SUPPLY = 1_000_000_000n * 1_000_000n;
const VIRTUAL_ECON = 30_000n * 1_000_000n;
const VIRTUAL_TOKEN = 1_073_000_000n * 1_000_000n;
const CREATOR_BPS = 50n;
const PROTOCOL_BPS = 50n;
const THRESHOLD = econ(1_000);

const authority = chain.payer;
const protocolTreasury = Keypair.generate().publicKey;
const econMint = chain.createMint(authority.publicKey);
const factory = pda(PID, "factory");
const protocolFeeAta = chain.ata(protocolTreasury, econMint);

const creator = chain.wallet();
const trader = chain.wallet();
const traderEcon = chain.fund(trader.publicKey, econMint, econ(10_000));
const creatorFeeAta = chain.ata(creator.publicKey, econMint);

const coinMint = Keypair.generate();
const config = pda(PID, "config", coinMint.publicKey);
const curveVault = pda(PID, "curve", coinMint.publicKey);
const econVault = pda(PID, "econ", coinMint.publicKey);
const traderTokens = chain.ata(trader.publicKey, coinMint.publicKey);

interface Config {
  name: string; symbol: string; creator: PublicKey; realEcon: BN; realTokenSold: BN;
  graduated: boolean; finalized: boolean; creatorFeeBps: number; protocolFeeBps: number;
}
const cfg = () => chain.decode<Config>(program, "coinConfig", config);

const createIx = (mint: Keypair, name: string, symbol: string, threshold: bigint) =>
  program.methods
    .createCoin(name, symbol, bn(threshold))
    .accountsStrict({
      creator: creator.publicKey,
      factory,
      econMint,
      mint: mint.publicKey,
      config: pda(PID, "config", mint.publicKey),
      curveVault: pda(PID, "curve", mint.publicKey),
      econVault: pda(PID, "econ", mint.publicKey),
      creatorFeeAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

interface TradeOverrides { creator?: PublicKey; creatorFeeAta?: PublicKey; protocolFeeAta?: PublicKey }
const tradeAccounts = (user: Keypair, o: TradeOverrides = {}) => ({
  user: user.publicKey,
  factory,
  config,
  mint: coinMint.publicKey,
  econMint,
  curveVault,
  econVault,
  userTokenAta: chain.ata(user.publicKey, coinMint.publicKey),
  userEconAta: chain.ata(user.publicKey, econMint),
  creator: o.creator ?? creator.publicKey,
  protocolTreasury,
  creatorFeeAta: o.creatorFeeAta ?? creatorFeeAta,
  protocolFeeAta: o.protocolFeeAta ?? protocolFeeAta,
  tokenProgram: TOKEN_PROGRAM_ID,
  associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
  systemProgram: SystemProgram.programId,
});
const buyIx = (user: Keypair, econIn: bigint, minOut = 0n, o?: TradeOverrides) =>
  program.methods.buy(bn(econIn), bn(minOut)).accountsStrict(tradeAccounts(user, o)).instruction();
const sellIx = (user: Keypair, tokensIn: bigint, minOut = 0n, o?: TradeOverrides) =>
  program.methods.sell(bn(tokensIn), bn(minOut)).accountsStrict(tradeAccounts(user, o)).instruction();

const finalizeIx = () =>
  program.methods
    .finalizeGraduation()
    .accountsStrict({ config, mint: coinMint.publicKey, curveVault, tokenProgram: TOKEN_PROGRAM_ID })
    .instruction();
const withdrawIx = (signer: Keypair, destination: PublicKey) =>
  program.methods
    .withdrawGraduated()
    .accountsStrict({ authority: signer.publicKey, factory, config, econVault, destination, tokenProgram: TOKEN_PROGRAM_ID })
    .instruction();

const fees = (amount: bigint) => [(amount * CREATOR_BPS) / 10_000n, (amount * PROTOCOL_BPS) / 10_000n] as const;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

describe("memecoin_factory", () => {
  it("initializes the factory and the protocol treasury's fee ATA", async () => {
    const ix = await program.methods
      .initFactory(Number(CREATOR_BPS), Number(PROTOCOL_BPS))
      .accountsStrict({
        authority: authority.publicKey,
        protocolTreasury,
        econMint,
        factory,
        protocolFeeAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    chain.send([ix]);
    assert.ok(chain.account(protocolFeeAta));
    const f = chain.decode<{ authority: PublicKey; protocolTreasury: PublicKey }>(program, "factory", factory);
    assert.ok(f.authority.equals(authority.publicKey));
    assert.ok(f.protocolTreasury.equals(protocolTreasury));
  });

  it("validates metadata and graduation threshold", async () => {
    const m = Keypair.generate();
    assert.ok(chain.fails([await createIx(m, "x".repeat(33), "OK", THRESHOLD)], [creator, m]).has("MetadataTooLong"));
    assert.ok(chain.fails([await createIx(m, "ok", "", THRESHOLD)], [creator, m]).has("MetadataTooLong"));
    assert.ok(chain.fails([await createIx(m, "ok", "OK", 0n)], [creator, m]).has("BadThreshold"));
    assert.ok(chain.fails([await createIx(m, "ok", "OK", econ(500_000))], [creator, m]).has("BadThreshold"));
  });

  it("creates a coin with the whole supply on the curve and the creator's fee ATA in place", async () => {
    chain.send([await createIx(coinMint, "Doge World", "DOGEW", THRESHOLD)], [creator, coinMint]);
    const c = cfg();
    assert.equal(c.name, "Doge World");
    assert.equal(c.symbol, "DOGEW");
    assert.ok(c.creator.equals(creator.publicKey));
    assert.equal(c.creatorFeeBps, Number(CREATOR_BPS));
    assert.equal(chain.tokenBalance(curveVault), TOTAL_SUPPLY);
    assert.equal(chain.tokenBalance(chain.ata(creator.publicKey, coinMint.publicKey)), 0n);
    assert.ok(chain.account(creatorFeeAta));
    assert.ok(chain.mintInfo(coinMint.publicKey).mintAuthority?.equals(config));
  });

  it("buys along the constant-product curve and routes fees to the creator and protocol ATAs", async () => {
    const econIn = econ(100);
    const [cf, pf] = fees(econIn);
    const net = econIn - cf - pf;
    const k = VIRTUAL_ECON * VIRTUAL_TOKEN;
    const expectedOut = VIRTUAL_TOKEN - ceilDiv(k, VIRTUAL_ECON + net);

    assert.ok(chain.fails([await buyIx(trader, econIn, expectedOut + 1n)], [trader]).has("SlippageExceeded"));
    chain.send([await buyIx(trader, econIn, expectedOut)], [trader]);

    assert.equal(chain.tokenBalance(traderTokens), expectedOut);
    assert.equal(chain.tokenBalance(curveVault), TOTAL_SUPPLY - expectedOut);
    assert.equal(chain.tokenBalance(econVault), net);
    assert.equal(chain.tokenBalance(creatorFeeAta), cf);
    assert.equal(chain.tokenBalance(protocolFeeAta), pf);
    assert.equal(chain.tokenBalance(traderEcon), econ(10_000) - econIn);
    assert.equal(big(cfg().realEcon), net);
    assert.equal(big(cfg().realTokenSold), expectedOut);
  });

  it("rejects fee accounts that are not the creator's / protocol treasury's ATAs", async () => {
    const attackerAta = traderEcon; // trader tries to pay fees to themselves
    const expectFail = (err: TxError, text: string) => assert.ok(err.has(text), `expected ${text}:\n${err.message}`);
    // associated_token::authority is checked as a token-owner constraint attributed to the fee account
    const creatorGuard = "caused by account: creator_fee_ata. Error Code: ConstraintTokenOwner";
    const protocolGuard = "caused by account: protocol_fee_ata. Error Code: ConstraintTokenOwner";
    expectFail(chain.fails([await buyIx(trader, econ(1), 0n, { creatorFeeAta: attackerAta })], [trader]), creatorGuard);
    expectFail(chain.fails([await buyIx(trader, econ(1), 0n, { protocolFeeAta: attackerAta })], [trader]), protocolGuard);
    // ...or to swap in themselves as the "creator"
    expectFail(
      chain.fails([await buyIx(trader, econ(1), 0n, { creator: trader.publicKey, creatorFeeAta: attackerAta })], [trader]),
      "caused by account: config. Error Code: ConstraintHasOne",
    );
    // a non-ATA token account owned by the right wallet is rejected too (must be *the* ATA)
    const creatorAux = chain.createAuxTokenAccount(creator.publicKey, econMint);
    expectFail(
      chain.fails([await buyIx(trader, econ(1), 0n, { creatorFeeAta: creatorAux })], [trader]),
      "caused by account: creator_fee_ata. Error Code: ConstraintAssociated",
    );
    // same guards on the sell side, where fees come out of the vault
    expectFail(chain.fails([await sellIx(trader, 1_000_000n, 0n, { creatorFeeAta: attackerAta })], [trader]), creatorGuard);
    expectFail(chain.fails([await sellIx(trader, 1_000_000n, 0n, { protocolFeeAta: attackerAta })], [trader]), protocolGuard);
    assert.equal(chain.tokenBalance(creatorFeeAta), fees(econ(100))[0]);
  });

  it("sells back to the curve, fees split from the gross", async () => {
    const before = cfg();
    const held = chain.tokenBalance(traderTokens);
    const tokensIn = held / 2n;
    const econR = VIRTUAL_ECON + big(before.realEcon);
    const tokenR = VIRTUAL_TOKEN - big(before.realTokenSold);
    const gross = econR - ceilDiv(econR * tokenR, tokenR + tokensIn);
    const [cf, pf] = fees(gross);

    const traderBefore = chain.tokenBalance(traderEcon);
    const cfBefore = chain.tokenBalance(creatorFeeAta);
    const pfBefore = chain.tokenBalance(protocolFeeAta);
    assert.ok(chain.fails([await sellIx(trader, tokensIn, gross)], [trader]).has("SlippageExceeded"));
    chain.send([await sellIx(trader, tokensIn, gross - cf - pf)], [trader]);

    assert.equal(chain.tokenBalance(traderTokens), held - tokensIn);
    assert.equal(chain.tokenBalance(traderEcon) - traderBefore, gross - cf - pf);
    assert.equal(chain.tokenBalance(creatorFeeAta) - cfBefore, cf);
    assert.equal(chain.tokenBalance(protocolFeeAta) - pfBefore, pf);
    assert.equal(big(cfg().realEcon), big(before.realEcon) - gross);
    assert.equal(big(cfg().realTokenSold), big(before.realTokenSold) - tokensIn);
    assert.equal(chain.tokenBalance(econVault), big(cfg().realEcon));
    assert.ok(!cfg().graduated);
  });

  it("graduates once the real reserve crosses the threshold and then freezes trading", async () => {
    assert.ok(chain.fails([await finalizeIx()]).has("NotGraduated"));
    const meta = chain.send([await buyIx(trader, econ(1_200))], [trader]);
    assert.ok(cfg().graduated);
    assert.ok(big(cfg().realEcon) >= THRESHOLD);
    assert.ok(meta.logs().some((l) => l.startsWith("Program data:")), "Graduated event emitted");
    assert.ok(chain.fails([await buyIx(trader, econ(1))], [trader]).has("AlreadyGraduated"));
    assert.ok(chain.fails([await sellIx(trader, 1n)], [trader]).has("AlreadyGraduated"));
  });

  it("finalize revokes the mint authority and burns the unsold curve supply", async () => {
    const sold = big(cfg().realTokenSold);
    chain.send([await finalizeIx()]);
    assert.equal(chain.mintInfo(coinMint.publicKey).mintAuthority, null);
    assert.equal(chain.mintInfo(coinMint.publicKey).supply, sold);
    assert.equal(chain.tokenBalance(curveVault), 0n);
    assert.ok(cfg().finalized);
    assert.ok(chain.fails([await finalizeIx()]).has("AlreadyFinalized"));
  });

  it("only the factory authority can move the graduated $ECON reserve", async () => {
    const reserve = chain.tokenBalance(econVault);
    assert.ok(reserve > 0n);
    assert.ok(chain.fails([await withdrawIx(trader, traderEcon)], [trader]).has("ConstraintHasOne"));
    const before = chain.tokenBalance(protocolFeeAta);
    chain.send([await withdrawIx(authority, protocolFeeAta)]);
    assert.equal(chain.tokenBalance(econVault), 0n);
    assert.equal(chain.tokenBalance(protocolFeeAta) - before, reserve);
    assert.ok(chain.fails([await withdrawIx(authority, protocolFeeAta)]).has("ZeroAmount"));
  });
});
