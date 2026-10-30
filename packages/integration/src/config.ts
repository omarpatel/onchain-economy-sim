import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";

/** Package root (`packages/integration`), independent of the process cwd. */
export const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Sibling Anchor workspace that produces `programs.json` and `target/idl`. */
export const CHAIN_DIR = resolve(PKG_DIR, "../chain");

/** pump.fun bonding-curve program (mainnet + devnet share this id). */
export const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
/** Wrapped SOL: a real mint on every cluster, used as the DRY_RUN stand-in for $ECON. */
export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
/** Default `MAX_EPOCH_TOTAL_ECON`: no single epoch may pull more than this many whole $ECON from the funder. */
export const DEFAULT_MAX_EPOCH_TOTAL_ECON = 50_000;

export interface ProgramIds {
  dividends: PublicKey;
  staking: PublicKey;
  equity: PublicKey;
  memecoinFactory: PublicKey;
}

export interface Config {
  rpcUrl: string;
  /** Fee payer + dividends admin + pump.fun creator (unless PUMP_CREATOR overrides). */
  authority: Keypair;
  keypairPath: string;
  serverUrl: string;
  adminToken: string;
  econMint: PublicKey;
  /** The pump.fun-launched $ECON mint (null = creator-fee sweep disabled). */
  pumpMint: PublicKey | null;
  /** Explicit pump.fun creator; default = the bonding curve's stored creator, else `authority`. */
  pumpCreator: PublicKey | null;
  dryRun: boolean;
  dataDir: string;
  port: number;
  pollMs: number;
  minSweepLamports: number;
  /** Whole $ECON; `set_epoch_root` totals above this are refused (see settle.ts). */
  maxEpochTotalEcon: number;
  programs: ProgramIds;
  hermesUrl: string;
  pythApiKey: string | null;
  jupPriceUrl: string;
}

export class ConfigError extends Error {}

function pubkey(name: string, value: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw new ConfigError(`${name}: "${value}" is not a valid base58 Solana pubkey`);
  }
}

function int(name: string, value: string, min: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) throw new ConfigError(`${name}: "${value}" must be an integer >= ${min}`);
  return n;
}

/** Minimal `.env` reader (KEY=VALUE, `#` comments, optional quotes); process env wins. */
export function readDotEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

/** `packages/chain/programs.json` → validated program ids. Written by `anchor keys sync` in the chain package. */
export function loadProgramIds(chainDir = CHAIN_DIR): ProgramIds {
  const file = resolve(chainDir, "programs.json");
  if (!existsSync(file)) {
    throw new ConfigError(
      `${file} not found. Build the chain package first (it writes programs.json with the deployed program ids).`,
    );
  }
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  const need = (key: string): PublicKey => {
    const v = raw[key];
    if (typeof v !== "string") throw new ConfigError(`programs.json: missing "${key}"`);
    return pubkey(`programs.json.${key}`, v);
  };
  return {
    dividends: need("dividends"),
    staking: need("staking"),
    equity: need("equity"),
    memecoinFactory: need("memecoin_factory"),
  };
}

export function loadKeypair(path: string): Keypair {
  const secret = JSON.parse(readFileSync(path, "utf8")) as number[];
  if (!Array.isArray(secret) || secret.length !== 64) throw new ConfigError(`${path}: expected a 64-byte secret key array`);
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

/**
 * Build the worker config from `process.env` (+ `packages/integration/.env`).
 * Every pubkey is parsed at load; invalid input fails fast with the offending key.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, chainDir = CHAIN_DIR): Config {
  const dot = readDotEnv(resolve(PKG_DIR, ".env"));
  const get = (k: string): string | undefined => env[k] ?? dot[k];

  const dryRun = (get("DRY_RUN") ?? "1") !== "0";
  const keypairPath = (get("KEYPAIR") ?? "~/.config/solana/id.json").replace(/^~(?=$|[\\/])/, homedir());

  let authority: Keypair;
  if (existsSync(keypairPath)) {
    authority = loadKeypair(keypairPath);
  } else if (dryRun) {
    authority = Keypair.generate();
    console.warn(`[config] KEYPAIR ${keypairPath} not found; DRY_RUN uses ephemeral ${authority.publicKey.toBase58()}`);
  } else {
    throw new ConfigError(`KEYPAIR ${keypairPath} not found (required when DRY_RUN=0)`);
  }

  const econMintRaw = get("ECON_MINT");
  let econMint: PublicKey;
  if (econMintRaw) {
    econMint = pubkey("ECON_MINT", econMintRaw);
  } else if (dryRun) {
    econMint = WSOL_MINT;
    console.warn(`[config] ECON_MINT not set; DRY_RUN uses wrapped SOL ${WSOL_MINT.toBase58()} as the distributor mint`);
  } else {
    throw new ConfigError("ECON_MINT is required when DRY_RUN=0");
  }

  const pumpMintRaw = get("PUMP_MINT");
  const pumpCreatorRaw = get("PUMP_CREATOR");

  return {
    rpcUrl: get("RPC_URL") ?? "https://api.devnet.solana.com",
    authority,
    keypairPath,
    serverUrl: (get("SERVER_URL") ?? "http://localhost:8787").replace(/\/+$/, ""),
    adminToken: get("ADMIN_TOKEN") ?? "",
    econMint,
    pumpMint: pumpMintRaw ? pubkey("PUMP_MINT", pumpMintRaw) : null,
    pumpCreator: pumpCreatorRaw ? pubkey("PUMP_CREATOR", pumpCreatorRaw) : null,
    dryRun,
    dataDir: resolve(get("DATA_DIR") ?? resolve(PKG_DIR, "data")),
    port: int("PORT", get("PORT") ?? "8790", 1),
    pollMs: int("POLL_MS", get("POLL_MS") ?? "30000", 1000),
    minSweepLamports: int("MIN_SWEEP_LAMPORTS", get("MIN_SWEEP_LAMPORTS") ?? String(50_000_000), 0),
    maxEpochTotalEcon: int("MAX_EPOCH_TOTAL_ECON", get("MAX_EPOCH_TOTAL_ECON") ?? String(DEFAULT_MAX_EPOCH_TOTAL_ECON), 0),
    programs: loadProgramIds(chainDir),
    hermesUrl: (get("PYTH_HERMES_URL") ?? "https://hermes.pyth.network").replace(/\/+$/, ""),
    pythApiKey: get("PYTH_API_KEY") || null,
    jupPriceUrl: get("JUP_PRICE_URL") ?? "https://lite-api.jup.ag/price/v3",
  };
}
