import { createPrivateKey, sign } from "node:crypto";
import { buildSiwsMessage } from "../../server/src/auth.ts";
import { env, fail, keypairFile, PLAYER_KEYPAIR } from "./localnet.ts";

/**
 * Sign the test player into the tick server with SIWS (nonce → ed25519 signed
 * text → `POST /auth/siws`) and call `GET /api/me` so the player exists and
 * founds a company. With FEE_ECON_PER_TICK set it also switches the server to
 * the external creator-fee feed (`POST /admin/creator-fees`), which is what
 * turns on real `dividend`/`yield` rows at the next epoch close.
 *
 * Env: SERVER_URL, ADMIN_TOKEN, DOMAIN (server's SIWS domain, default localhost),
 * PLAYER_KEYPAIR, FEE_ECON_PER_TICK (whole $ECON per tick; decimals fixed at 6).
 */

/** ASN.1 PKCS#8 prefix for a raw 32-byte Ed25519 seed. */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(`${res.url} → ${res.status} ${body.error ?? ""}`);
  return body;
}

async function main(): Promise<void> {
  const e = env();
  const server = (e.SERVER_URL ?? "http://localhost:8793").replace(/\/+$/, "");
  const player = keypairFile(e.PLAYER_KEYPAIR ?? PLAYER_KEYPAIR);
  const pubkey = player.publicKey.toBase58();

  const { nonce } = await json<{ nonce: string }>(await fetch(`${server}/auth/nonce`));
  const message = buildSiwsMessage({
    domain: e.DOMAIN ?? "localhost",
    address: pubkey,
    statement: "Sign in to Economy Sim",
    uri: "http://localhost:3000",
    version: "1",
    nonce,
    issuedAt: new Date().toISOString(),
  });
  const priv = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(player.secretKey.subarray(0, 32))]), format: "der", type: "pkcs8" });
  const signature = sign(null, Buffer.from(message), priv).toString("base64");
  const session = await json<{ token: string; playerId: string; name: string }>(
    await fetch(`${server}/auth/siws`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pubkey, message, signature }) }),
  );
  console.log(`[login] ${server} playerId=${session.playerId} name=${session.name} token=${session.token.slice(0, 8)}…`);

  const me = await json<{ playerId: string; company?: { id: string; name: string } | null; cash?: number }>(
    await fetch(`${server}/api/me`, { headers: { authorization: `Bearer ${session.token}` } }),
  );
  console.log(`[login] /api/me → ${JSON.stringify({ playerId: me.playerId, company: me.company?.name ?? me.company, cash: me.cash })}`);

  if (e.FEE_ECON_PER_TICK) {
    const econMinorPerTick = Math.round(Number(e.FEE_ECON_PER_TICK) * 1_000_000);
    const res = await json<{ ok: boolean; econMinorPerTick: number }>(
      await fetch(`${server}/admin/creator-fees`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${e.ADMIN_TOKEN ?? ""}` },
        body: JSON.stringify({ econMinorPerTick }),
      }),
    );
    console.log(`[login] /admin/creator-fees → ${JSON.stringify(res)} (external feed on: dividend/yield rows from the next epoch close)`);
  }
}

main().catch(fail);
