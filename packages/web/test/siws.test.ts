import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import bs58 from "bs58";
import { buildSiwsMessage as serverBuild, parseSiwsMessage, verifyEd25519 } from "../../server/src/auth.ts";
import { buildSiwsMessage, siwsFields } from "../lib/client/auth.ts";

const NONCE = "0123456789abcdef0123456789abcdef";
const ADDRESS = "CKy5Psn6QoYAL4Kd2o7wJGPZbEBupg5ABXBhkkKMeyoo";

test("client SIWS text is byte-identical to the server renderer", () => {
  const f = siwsFields(ADDRESS, NONCE, { domain: "localhost", uri: "http://localhost:3000", now: new Date("2026-09-27T10:00:00.000Z") });
  assert.equal(buildSiwsMessage(f), serverBuild(f));
});

test("server parser recovers every field the client signs", () => {
  const now = new Date("2026-09-27T10:00:00.000Z");
  const f = siwsFields(ADDRESS, NONCE, { domain: "localhost", uri: "http://localhost:3000", now });
  const parsed = parseSiwsMessage(buildSiwsMessage(f));
  assert.ok(parsed, "message must parse");
  assert.equal(parsed.domain, "localhost");
  assert.equal(parsed.address, ADDRESS);
  assert.equal(parsed.statement, f.statement);
  assert.equal(parsed.uri, "http://localhost:3000");
  assert.equal(parsed.version, "1");
  assert.equal(parsed.chainId, "devnet");
  assert.equal(parsed.nonce, NONCE);
  assert.equal(parsed.issuedAt, now.toISOString());
  assert.equal(parsed.expirationTime, new Date(now.getTime() + 5 * 60_000).toISOString());
});

test("signMessage fallback: ed25519 signature over the client text verifies on the server", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const address = bs58.encode(raw);
  const message = buildSiwsMessage(siwsFields(address, NONCE, { domain: "localhost", uri: "http://localhost:3000" }));
  const signature = sign(null, Buffer.from(message, "utf8"), privateKey);
  assert.equal(verifyEd25519(address, message, signature.toString("base64")), true);
  assert.equal(verifyEd25519(address, message, bs58.encode(signature)), true);
  assert.equal(verifyEd25519(address, `${message}x`, signature.toString("base64")), false);
});
