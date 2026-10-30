"use client";

import { create } from "zustand";
import { SERVER_URL } from "./config.ts";

/**
 * Session handling against the tick server: guest logins, Sign-In-With-Solana
 * and the persisted `econ.session` record every online connection is made with.
 */

export interface Session {
  token: string;
  playerId: string;
  name: string;
  kind: "guest" | "wallet";
  /** base58 wallet pubkey for `kind: "wallet"` */
  pubkey?: string;
}

export const SESSION_KEY = "econ.session";

function readStorage(): Session | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<Session>;
    if (typeof s.token !== "string" || typeof s.playerId !== "string") return null;
    return { token: s.token, playerId: s.playerId, name: typeof s.name === "string" ? s.name : s.playerId, kind: s.kind === "wallet" ? "wallet" : "guest", pubkey: typeof s.pubkey === "string" ? s.pubkey : undefined };
  } catch {
    return null;
  }
}

interface SessionStore {
  session: Session | null;
  /** false until localStorage has been read on the client */
  hydrated: boolean;
  hydrate(): void;
  set(session: Session): void;
  rename(name: string): void;
  clear(): void;
}

/** Persisted session; `hydrate()` once on the client before trusting `session`. */
export const useSession = create<SessionStore>((set, get) => ({
  session: null,
  hydrated: false,
  hydrate: () => { if (!get().hydrated) set({ session: readStorage(), hydrated: true }); },
  set: (session) => { window.localStorage.setItem(SESSION_KEY, JSON.stringify(session)); set({ session, hydrated: true }); },
  rename: (name) => { const s = get().session; if (s) get().set({ ...s, name }); },
  clear: () => { window.localStorage.removeItem(SESSION_KEY); set({ session: null, hydrated: true }); },
}));

/* ───────────────────────────── HTTP ───────────────────────────── */

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** JSON call to the tick server; throws `ApiError` with the server's `{ error }` text. */
export async function api<T>(path: string, init: { method?: string; body?: unknown; token?: string; signal?: AbortSignal } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  let res: Response;
  try {
    res = await fetch(`${SERVER_URL}${path}`, { method: init.method ?? (init.body === undefined ? "GET" : "POST"), headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: init.signal, cache: "no-store" });
  } catch (e) {
    throw new ApiError(0, e instanceof Error && e.name === "AbortError" ? "request timed out" : `server unreachable (${SERVER_URL})`);
  }
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const msg = json && typeof json === "object" && typeof (json as { error?: unknown }).error === "string" ? (json as { error: string }).error : `HTTP ${res.status}`;
    throw new ApiError(res.status, msg);
  }
  return json as T;
}

export interface HealthInfo { ok: boolean; tick: number; players: number; uptime: number; tickMs: number; clients: number }

/** `GET /api/health` with a hard timeout; resolves null when the server is unreachable. */
export async function probeServer(timeoutMs = 1500): Promise<HealthInfo | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const h = await api<HealthInfo>("/api/health", { signal: ctl.signal });
    return h.ok ? h : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

interface AuthResponse { token: string; playerId: string; name: string }

export async function guestLogin(name: string): Promise<Session> {
  const r = await api<AuthResponse>("/auth/guest", { body: { name } });
  return { token: r.token, playerId: r.playerId, name: r.name, kind: "guest" };
}

export async function renamePlayer(token: string, name: string): Promise<string> {
  const r = await api<{ playerId: string; name: string }>("/auth/name", { body: { name }, token });
  return r.name;
}

/* ───────────────────────────── SIWS ───────────────────────────── */

/** Mirrors `packages/server/src/auth.ts` `SiwsFields`; the text below must parse there. */
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

export const SIWS_STATEMENT = "Sign in to Economy Sim. This request will not trigger a blockchain transaction or cost any gas fees.";

/**
 * Canonical Sign-In-With-Solana text (CAIP-122 / Phantom SIWS). Byte-identical
 * to the server's `buildSiwsMessage` and to what wallet-standard `signIn`
 * renders for the same input, so either signing path verifies.
 */
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

/** The fields we sign for `address` with a fresh server nonce; `domain` must equal the server's `DOMAIN`. */
export function siwsFields(address: string, nonce: string, opts: { domain: string; uri: string; chainId?: string; now?: Date }): SiwsFields {
  const now = opts.now ?? new Date();
  return {
    domain: opts.domain,
    address,
    statement: SIWS_STATEMENT,
    uri: opts.uri,
    version: "1",
    chainId: opts.chainId ?? "devnet",
    nonce,
    issuedAt: now.toISOString(),
    expirationTime: new Date(now.getTime() + 5 * 60_000).toISOString(),
  };
}

export async function fetchNonce(): Promise<string> {
  return (await api<{ nonce: string }>("/auth/nonce")).nonce;
}

/** Bytes → base64 (the server accepts base58 or base64 signatures). */
export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** `POST /auth/siws`; `signature` base64 or base58. */
export async function siwsLogin(pubkey: string, message: string, signature: string): Promise<Session> {
  const r = await api<AuthResponse>("/auth/siws", { body: { pubkey, message, signature } });
  return { token: r.token, playerId: r.playerId, name: r.name, kind: "wallet", pubkey };
}
