import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { PublicKey } from "@solana/web3.js";
import type { SettlementStore } from "./settle.ts";

/**
 * Read-only proofs API for the web claim button:
 *   GET /health                    → { ok, lastEpoch }
 *   GET /proofs/:epoch             → full proofs file
 *   GET /proofs/:epoch/:pubkey     → { epoch, chainEpoch, root, mint, programId, distributor, epochRoot, claimant, index, amount, proof }
 * `epoch` may be a number or `latest`.
 */
export function startProofServer(store: SettlementStore, port: number, health: () => Record<string, unknown> = () => ({})): Server {
  const server = createServer((req, res) => handle(store, req, res, health));
  server.listen(port, () => console.log(`[http] proofs api on http://localhost:${port}`));
  return server;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function handle(store: SettlementStore, req: IncomingMessage, res: ServerResponse, health: () => Record<string, unknown>): void {
  if (req.method === "OPTIONS") return send(res, 204, null);
  if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
  const url = new URL(req.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);

  if (parts[0] === "health" && parts.length === 1) {
    return send(res, 200, { ok: true, lastEpoch: store.lastEpoch, ...health() });
  }
  if (parts[0] !== "proofs" || parts.length < 2 || parts.length > 3) return send(res, 404, { error: "not found" });

  const epoch = parts[1] === "latest" ? store.lastEpoch : Number(parts[1]);
  if (!Number.isInteger(epoch) || epoch < 0) return send(res, 400, { error: "bad epoch" });
  const file = store.readProofs(epoch);
  if (!file) return send(res, 404, { error: `no proofs for epoch ${epoch}`, lastEpoch: store.lastEpoch });
  if (parts.length === 2) return send(res, 200, file);

  let pubkey: string;
  try {
    pubkey = new PublicKey(parts[2]).toBase58();
  } catch {
    return send(res, 400, { error: "bad pubkey" });
  }
  const claim = file.claims[pubkey];
  if (!claim) return send(res, 404, { error: `no allocation for ${pubkey} in epoch ${epoch}` });
  const { claims: _claims, ...meta } = file;
  return send(res, 200, { ...meta, claimant: pubkey, ...claim });
}
