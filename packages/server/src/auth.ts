import { createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import bs58 from "bs58";
import { cleanName } from "@econ-sim/sim/text";
import type { Persist, PlayerRow, SessionRow } from "./persist.ts";

/**
 * Sign-In-With-Solana (Phantom SIWS / CAIP-122 text) + guest sessions.
 * Sessions are opaque 32-byte hex tokens stored in SQLite (30 days).
 */

export class AuthError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface SiwsFields {
  domain: string;
  address: string;
  statement?: string;
  uri?: string;
  version?: string;
  chainId?: string;
  nonce: string;
  issuedAt: string;
  expirationTime?: string;
}

const NONCE_TTL_MS = 5 * 60_000;
/** Live nonces kept at most; beyond this the oldest is evicted on issue. */
export const NONCE_CAP = 10_000;
const ISSUED_AT_WINDOW_MS = 10 * 60_000;
const SESSION_TTL_MS = 30 * 24 * 3600_000;

/** ASN.1 SubjectPublicKeyInfo prefix for a raw 32-byte Ed25519 key. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

const HEADER_RE = /^(.+) wants you to sign in with your Solana account:$/;

/** Render the canonical SIWS text (what wallets show and sign). */
export function buildSiwsMessage(f: SiwsFields): string {
  const lines = [`${f.domain} wants you to sign in with your Solana account:`, f.address];
  if (f.statement) lines.push("", f.statement);
  const fields: string[] = [];
  if (f.uri) fields.push(`URI: ${f.uri}`);
  if (f.version) fields.push(`Version: ${f.version}`);
  if (f.chainId) fields.push(`Chain ID: ${f.chainId}`);
  fields.push(`Nonce: ${f.nonce}`, `Issued At: ${f.issuedAt}`);
  if (f.expirationTime) fields.push(`Expiration Time: ${f.expirationTime}`);
  lines.push("", ...fields);
  return lines.join("\n");
}

/** Parse SIWS text; returns null when the header/required fields are missing. */
export function parseSiwsMessage(message: string): SiwsFields | null {
  const lines = message.split("\n");
  const header = HEADER_RE.exec(lines[0] ?? "");
  const address = lines[1];
  if (!header || !address) return null;
  const fieldOf = (label: string): string | undefined => {
    const prefix = `${label}: `;
    const line = lines.find((l, i) => i >= 2 && l.startsWith(prefix));
    return line?.slice(prefix.length);
  };
  const nonce = fieldOf("Nonce");
  const issuedAt = fieldOf("Issued At");
  if (!nonce || !issuedAt) return null;
  // Statement = the text between the blank line after the address and the next blank line.
  let statement: string | undefined;
  if (lines[2] === "" && lines[3] !== undefined && lines[3] !== "" && !/^[A-Za-z ]+: /.test(lines[3])) statement = lines[3];
  return {
    domain: header[1],
    address,
    statement,
    uri: fieldOf("URI"),
    version: fieldOf("Version"),
    chainId: fieldOf("Chain ID"),
    nonce,
    issuedAt,
    expirationTime: fieldOf("Expiration Time"),
  };
}

function decodeSignature(sig: string): Uint8Array | null {
  if (BASE58_RE.test(sig)) {
    try {
      const b = bs58.decode(sig);
      if (b.length === 64) return b;
    } catch {
      /* fall through to base64 */
    }
  }
  const b = Buffer.from(sig, "base64");
  return b.length === 64 ? b : null;
}

export function verifyEd25519(pubkeyBase58: string, message: string, signature: string): boolean {
  let raw: Uint8Array;
  try {
    raw = bs58.decode(pubkeyBase58);
  } catch {
    return false;
  }
  if (raw.length !== 32) return false;
  const sig = decodeSignature(signature);
  if (!sig) return false;
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
  return verify(null, Buffer.from(message, "utf8"), key, sig);
}

export interface AuthResponse {
  token: string;
  playerId: string;
  name: string;
}

export class Auth {
  private persist: Persist;
  private domain: string;
  private allowGuest: boolean;
  private nonces = new Map<string, number>(); // nonce → expiry ms

  constructor(persist: Persist, opts: { domain: string; allowGuest: boolean }) {
    this.persist = persist;
    this.domain = opts.domain;
    this.allowGuest = opts.allowGuest;
  }

  /** Fresh single-use nonce (5-minute TTL). Insertion order = expiry order, so the sweep
   *  stops at the first live entry; beyond `NONCE_CAP` live nonces the oldest is evicted. */
  nonce(): string {
    const now = Date.now();
    for (const [n, exp] of this.nonces) {
      if (exp >= now && this.nonces.size < NONCE_CAP) break;
      this.nonces.delete(n);
    }
    const nonce = randomBytes(16).toString("hex");
    this.nonces.set(nonce, now + NONCE_TTL_MS);
    return nonce;
  }

  get liveNonces(): number {
    return this.nonces.size;
  }

  private issueSession(player: PlayerRow): AuthResponse {
    const token = randomBytes(32).toString("hex");
    this.persist.createSession(token, player.playerId, SESSION_TTL_MS);
    return { token, playerId: player.playerId, name: player.name };
  }

  siws(body: { pubkey?: unknown; message?: unknown; signature?: unknown }): AuthResponse {
    const { pubkey, message, signature } = body;
    if (typeof pubkey !== "string" || typeof message !== "string" || typeof signature !== "string") {
      throw new AuthError(400, "pubkey, message and signature are required");
    }
    const fields = parseSiwsMessage(message);
    if (!fields) throw new AuthError(400, "malformed SIWS message");
    if (fields.domain !== this.domain) throw new AuthError(401, `domain mismatch (expected ${this.domain})`);
    if (fields.address !== pubkey) throw new AuthError(401, "address does not match pubkey");
    const issuedAt = Date.parse(fields.issuedAt);
    if (!Number.isFinite(issuedAt) || Math.abs(Date.now() - issuedAt) > ISSUED_AT_WINDOW_MS) {
      throw new AuthError(401, "issued-at outside the 10-minute window");
    }
    if (fields.expirationTime !== undefined && Date.parse(fields.expirationTime) < Date.now()) {
      throw new AuthError(401, "message expired");
    }
    const nonceExp = this.nonces.get(fields.nonce);
    if (nonceExp === undefined || nonceExp < Date.now()) throw new AuthError(401, "unknown or expired nonce");
    if (!verifyEd25519(pubkey, message, signature)) throw new AuthError(401, "bad signature");
    this.nonces.delete(fields.nonce); // single use, only consumed by a valid signature

    const playerId = `sol:${pubkey}`;
    const player = this.persist.upsertPlayer(playerId, pubkey, `${pubkey.slice(0, 4)}…${pubkey.slice(-4)}`);
    return this.issueSession(player);
  }

  guest(body: { name?: unknown }): AuthResponse {
    if (!this.allowGuest) throw new AuthError(403, "guest login disabled");
    const id = randomUUID();
    const player = this.persist.upsertPlayer(`guest:${id}`, null, cleanName(body.name) || `guest-${id.slice(0, 6)}`);
    return this.issueSession(player);
  }

  session(token: string | null): SessionRow | null {
    return token ? this.persist.getSession(token) : null;
  }
}
