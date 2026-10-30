import { writeFileSync } from "node:fs";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  TokenAccountNotFoundError,
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import type { Equity } from "../../chain/target/types/equity.ts";
import type { MemecoinFactory } from "../../chain/target/types/memecoin_factory.ts";
import type { Staking } from "../../chain/target/types/staking.ts";
import { loadProgramIds } from "../src/config.ts";
import { DividendsClient, loadDividendsIdl } from "../src/dividends.ts";
import { rewardVaultPda, stakePoolPda, stakeVaultPda } from "../src/pdas.ts";
import { airdropIfBelow, anchorProgram, authorityKeypairPath, ENV_FILE, env, fmtEcon, fail, keypairFile, sendTx } from "./localnet.ts";

/**
 * One-shot localnet bootstrap, safe to re-run (every step skips what exists):
 *   1. $ECON SPL mint (6 decimals, authority = deployer) + MINT_ECON to the deployer ATA
 *   2. dividends.init_distributor(CLAIM_WINDOW_SECS)
 *   3. staking.init_pool
 *   4. memecoin_factory.init_factory(CREATOR_FEE_BPS, PROTOCOL_FEE_BPS)  (treasury = deployer)
 *   5. equity.init_config(authority = deployer)
 * then writes packages/integration/.env.localnet for the worker and the other scripts.
 *
 * Env (process env over .env.localnet): RPC_URL, KEYPAIR, ECON_MINT (reuse), MINT_ECON,
 * CLAIM_WINDOW_SECS, CREATOR_FEE_BPS, PROTOCOL_FEE_BPS, SERVER_URL, ADMIN_TOKEN, MAX_EPOCH_TOTAL_ECON, PORT.
 */

const ECON_DECIMALS = 6;

async function main(): Promise<void> {
  const e = env();
  const rpcUrl = e.RPC_URL ?? "http://127.0.0.1:8899";
  const conn = new Connection(rpcUrl, "confirmed");
  const keypairPath = authorityKeypairPath(e);
  const authority = keypairFile(keypairPath);
  const programs = loadProgramIds();
  console.log(`[bootstrap] rpc=${rpcUrl} authority=${authority.publicKey.toBase58()} (${keypairPath})`);
  await airdropIfBelow(conn, authority.publicKey, 20, 100);

  for (const [name, id] of Object.entries(programs)) {
    const info = await conn.getAccountInfo(id);
    if (!info?.executable) throw new Error(`${name} program ${id.toBase58()} is not deployed on ${rpcUrl} — run \`npm --workspace=@econ-sim/chain run deploy:localnet\``);
  }

  // 1. mint
  let mint: PublicKey;
  if (e.ECON_MINT && (await conn.getAccountInfo(new PublicKey(e.ECON_MINT)))) {
    mint = new PublicKey(e.ECON_MINT);
    console.log(`[bootstrap] mint ${mint.toBase58()} exists (decimals=${(await getMint(conn, mint)).decimals})`);
  } else {
    const kp = Keypair.generate();
    mint = kp.publicKey;
    const lamports = await conn.getMinimumBalanceForRentExemption(MINT_SIZE);
    const tx = new Transaction().add(
      SystemProgram.createAccount({ fromPubkey: authority.publicKey, newAccountPubkey: mint, lamports, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
      createInitializeMint2Instruction(mint, ECON_DECIMALS, authority.publicKey, null),
    );
    await sendTx(conn, tx, [authority, kp], `create $ECON mint ${mint.toBase58()}`);
  }
  const authorityAta = getAssociatedTokenAddressSync(mint, authority.publicKey);
  let ataBalance = 0n;
  try {
    ataBalance = (await getAccount(conn, authorityAta)).amount;
  } catch (err) {
    if (!(err instanceof TokenAccountNotFoundError)) throw err;
  }
  const mintEcon = BigInt(e.MINT_ECON ?? 1_000_000);
  if (ataBalance === 0n) {
    const amount = mintEcon * 10n ** BigInt(ECON_DECIMALS);
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, authorityAta, authority.publicKey, mint),
      createMintToInstruction(mint, authorityAta, authority.publicKey, amount),
    );
    await sendTx(conn, tx, [authority], `mint ${mintEcon} $ECON → ${authorityAta.toBase58()}`);
    ataBalance = amount;
  }
  console.log(`[bootstrap] authority ATA ${authorityAta.toBase58()} = ${fmtEcon(ataBalance, ECON_DECIMALS)}`);

  // 2. dividends distributor
  const dividends = new DividendsClient({ conn, authority, mint, programId: programs.dividends, idl: loadDividendsIdl(), dryRun: false });
  const claimWindow = BigInt(e.CLAIM_WINDOW_SECS ?? 7 * 24 * 3600);
  const init = await dividends.ensureDistributor(claimWindow);
  console.log(`[bootstrap] distributor ${dividends.distributor.toBase58()} vault ${dividends.vault.toBase58()} ${init ? `init ${init.signature}` : "exists"}`);

  // 3. staking pool
  const staking = anchorProgram<Staking>(conn, authority, "staking", programs.staking);
  const pool = stakePoolPda(programs.staking, mint);
  if (await conn.getAccountInfo(pool)) {
    console.log(`[bootstrap] staking pool ${pool.toBase58()} exists`);
  } else {
    const sig = await staking.methods
      .initPool()
      .accountsPartial({
        admin: authority.publicKey,
        econMint: mint,
        pool,
        stakeVault: stakeVaultPda(programs.staking, pool),
        rewardVault: rewardVaultPda(programs.staking, pool),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });
    console.log(`[bootstrap] staking init_pool ${pool.toBase58()} ${sig}`);
  }

  // 4. memecoin factory
  const factoryProgram = anchorProgram<MemecoinFactory>(conn, authority, "memecoin_factory", programs.memecoinFactory);
  const factory = PublicKey.findProgramAddressSync([Buffer.from("factory")], programs.memecoinFactory)[0];
  if (await conn.getAccountInfo(factory)) {
    console.log(`[bootstrap] memecoin factory ${factory.toBase58()} exists`);
  } else {
    const sig = await factoryProgram.methods
      .initFactory(Number(e.CREATOR_FEE_BPS ?? 50), Number(e.PROTOCOL_FEE_BPS ?? 50))
      .accountsPartial({
        authority: authority.publicKey,
        protocolTreasury: authority.publicKey,
        econMint: mint,
        factory,
        protocolFeeAta: authorityAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });
    console.log(`[bootstrap] memecoin init_factory ${factory.toBase58()} ${sig}`);
  }

  // 5. equity config
  const equity = anchorProgram<Equity>(conn, authority, "equity", programs.equity);
  const config = PublicKey.findProgramAddressSync([Buffer.from("config")], programs.equity)[0];
  if (await conn.getAccountInfo(config)) {
    console.log(`[bootstrap] equity config ${config.toBase58()} exists`);
  } else {
    const sig = await equity.methods
      .initConfig(authority.publicKey)
      .accountsPartial({ payer: authority.publicKey, config, systemProgram: SystemProgram.programId })
      .rpc({ commitment: "confirmed" });
    console.log(`[bootstrap] equity init_config ${config.toBase58()} ${sig}`);
  }

  const lines = [
    "# written by scripts/bootstrap-localnet.ts — worker: node --env-file=.env.localnet src/index.ts",
    `RPC_URL=${rpcUrl}`,
    `KEYPAIR=${keypairPath}`,
    `ECON_MINT=${mint.toBase58()}`,
    `SERVER_URL=${e.SERVER_URL ?? "http://localhost:8793"}`,
    `ADMIN_TOKEN=${e.ADMIN_TOKEN ?? "e2e"}`,
    "DRY_RUN=0",
    `MAX_EPOCH_TOTAL_ECON=${e.MAX_EPOCH_TOTAL_ECON ?? 50_000}`,
    `PORT=${e.PORT ?? 8790}`,
    `CLAIM_WINDOW_SECS=${claimWindow}`,
    "",
  ];
  writeFileSync(ENV_FILE, lines.join("\n"));
  console.log(`[bootstrap] wrote ${ENV_FILE}\n${lines.slice(1, -1).join("\n")}`);
  console.log(
    `[bootstrap] addresses\n  mint=${mint.toBase58()}\n  authorityAta=${authorityAta.toBase58()}\n  distributor=${dividends.distributor.toBase58()}\n  vault=${dividends.vault.toBase58()}\n  stakingPool=${pool.toBase58()}\n  factory=${factory.toBase58()}\n  equityConfig=${config.toBase58()}`,
  );
}

main().catch(fail);
