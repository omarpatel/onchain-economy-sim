import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, type Signer, type Transaction } from "@solana/web3.js";
import { CHAIN_DIR, loadKeypair, PKG_DIR, readDotEnv } from "../src/config.ts";

/**
 * Shared plumbing for the localnet end-to-end scripts (bootstrap / stake /
 * login / claim). Everything is keyed off `packages/integration/.env.localnet`,
 * which `bootstrap-localnet.ts` writes and the worker reads through `--env-file`.
 */

const { AnchorProvider, Program, Wallet } = anchor;

export const ENV_FILE = resolve(PKG_DIR, ".env.localnet");
/** Throwaway keypairs (test player); git-ignored. */
export const LOCALNET_DIR = resolve(PKG_DIR, ".localnet");
export const PLAYER_KEYPAIR = resolve(LOCALNET_DIR, "player.json");

/** `process.env` over `.env.localnet`. */
export function env(): Record<string, string | undefined> {
  return { ...readDotEnv(ENV_FILE), ...process.env };
}

export function need(e: Record<string, string | undefined>, key: string): string {
  const v = e[key];
  if (!v) throw new Error(`${key} is not set (run scripts/bootstrap-localnet.ts first or export it)`);
  return v;
}

export function expandHome(p: string): string {
  return p.replace(/^~(?=$|[\\/])/, homedir());
}

/**
 * The deployer key. Solana lives in WSL on this project's workstations, so when
 * `~/.config/solana/id.json` is missing on Windows fall back to the WSL copy
 * (`WSL_DISTRO`, default Ubuntu-24.04) — the same key `anchor deploy` used.
 */
export function authorityKeypairPath(e: Record<string, string | undefined>): string {
  const explicit = e.KEYPAIR ? expandHome(e.KEYPAIR) : null;
  if (explicit && existsSync(explicit)) return explicit;
  const home = expandHome("~/.config/solana/id.json");
  if (!explicit && existsSync(home)) return home;
  const wsl = `//wsl.localhost/${e.WSL_DISTRO ?? "Ubuntu-24.04"}/root/.config/solana/id.json`;
  if (!explicit && process.platform === "win32" && existsSync(wsl)) return wsl;
  throw new Error(`KEYPAIR ${explicit ?? home} not found${process.platform === "win32" ? ` (also tried ${wsl})` : ""}`);
}

/** Load a keypair file, generating (and persisting) it when `create` is set and it is missing. */
export function keypairFile(path: string, create = false): Keypair {
  if (existsSync(path)) return loadKeypair(path);
  if (!create) throw new Error(`${path} not found`);
  const kp = Keypair.generate();
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)));
  console.log(`[localnet] generated ${path} → ${kp.publicKey.toBase58()}`);
  return kp;
}

export async function airdropIfBelow(conn: Connection, to: PublicKey, minSol: number, sol: number): Promise<void> {
  const balance = await conn.getBalance(to);
  if (balance >= minSol * LAMPORTS_PER_SOL) return;
  const sig = await conn.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
  await confirm(conn, sig);
  console.log(`[localnet] airdrop ${sol} SOL → ${to.toBase58()} ${sig}`);
}

export async function confirm(conn: Connection, signature: string): Promise<void> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const res = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) throw new Error(`${signature} failed: ${JSON.stringify(res.value.err)}`);
}

export async function sendTx(conn: Connection, tx: Transaction, signers: Signer[], label: string): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = blockhash;
  tx.sign(...signers);
  const signature = await conn.sendRawTransaction(tx.serialize());
  const res = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) throw new Error(`${label} failed on-chain: ${JSON.stringify(res.value.err)} (${signature})`);
  console.log(`[localnet] ${label} ${signature}`);
  return signature;
}

/** Anchor client for `packages/chain/target/idl/<name>.json` at the id from programs.json. */
export function anchorProgram<T extends anchor.Idl>(conn: Connection, payer: Keypair, name: string, programId: PublicKey): anchor.Program<T> {
  const file = resolve(CHAIN_DIR, `target/idl/${name}.json`);
  if (!existsSync(file)) throw new Error(`${file} not found — run \`npm --workspace=@econ-sim/chain run build\``);
  const idl = { ...(JSON.parse(readFileSync(file, "utf8")) as anchor.Idl), address: programId.toBase58() } as T;
  return new Program<T>(idl, new AnchorProvider(conn, new Wallet(payer), { commitment: "confirmed" }));
}

export function fmtEcon(minor: bigint, decimals: number): string {
  const s = minor.toString().padStart(decimals + 1, "0");
  return `${s.slice(0, -decimals)}.${s.slice(-decimals)} $ECON (${minor} minor)`;
}

export function fail(e: unknown): never {
  console.error(e instanceof Error ? `[localnet] ${e.message}` : e);
  process.exit(1);
}
