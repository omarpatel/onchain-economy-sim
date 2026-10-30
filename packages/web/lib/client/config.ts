/**
 * Public runtime configuration. `NEXT_PUBLIC_*` variables are inlined at build
 * time, so each one must be referenced literally. Documented in `.env.example`.
 */
/** Tick server HTTP origin (WebSocket at `/ws`). */
export const SERVER_URL = (process.env.NEXT_PUBLIC_ECON_SERVER ?? "http://localhost:8788").replace(/\/+$/, "");
/** Settlement worker proofs API (`GET /proofs/:epoch/:pubkey`). */
export const PROOFS_URL = (process.env.NEXT_PUBLIC_PROOFS_URL ?? "http://localhost:8790").replace(/\/+$/, "");
/** Solana JSON-RPC endpoint used by the wallet adapter and the claim flow. */
export const RPC_URL = process.env.NEXT_PUBLIC_RPC ?? "https://api.devnet.solana.com";
/** $ECON SPL mint the dividends distributor was initialised with (empty = not configured). */
export const ECON_MINT = process.env.NEXT_PUBLIC_ECON_MINT ?? "";
/** Public origin of this web app; absolute base for Open Graph image URLs. */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000").replace(/\/+$/, "");

export const WS_URL = `${SERVER_URL.replace(/^http/, "ws")}/ws`;

export const EXPLORER_CLUSTER = /devnet/.test(RPC_URL) ? "devnet" : /testnet/.test(RPC_URL) ? "testnet" : /localhost|127\.0\.0\.1/.test(RPC_URL) ? "custom" : "mainnet-beta";

export function explorerTx(signature: string): string {
  const q = EXPLORER_CLUSTER === "custom" ? `?cluster=custom&customUrl=${encodeURIComponent(RPC_URL)}` : EXPLORER_CLUSTER === "mainnet-beta" ? "" : `?cluster=${EXPLORER_CLUSTER}`;
  return `https://explorer.solana.com/tx/${signature}${q}`;
}

export function explorerAddress(address: string): string {
  const q = EXPLORER_CLUSTER === "custom" ? `?cluster=custom&customUrl=${encodeURIComponent(RPC_URL)}` : EXPLORER_CLUSTER === "mainnet-beta" ? "" : `?cluster=${EXPLORER_CLUSTER}`;
  return `https://explorer.solana.com/address/${address}${q}`;
}
