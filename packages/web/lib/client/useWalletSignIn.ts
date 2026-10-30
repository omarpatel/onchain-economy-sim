"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { buildSiwsMessage, fetchNonce, siwsFields, siwsLogin, toBase64, useSession } from "./auth.ts";

/**
 * Connect (wallet-standard picker) → nonce → SIWS → session. Uses the wallet's
 * native `signIn` feature when offered (Phantom, Solflare, Backpack) so the
 * user sees the structured sign-in sheet; falls back to `signMessage` over the
 * identical text otherwise. Switching from a guest session replaces it; the
 * guest company stays with the guest player id.
 */
export function useWalletSignIn(): { signIn: () => Promise<void>; signOut: () => Promise<void>; busy: boolean; error: string | null; clearError: () => void } {
  const wallet = useWallet();
  const { setVisible } = useWalletModal();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const armed = useRef(false); // sign in as soon as the picker yields a public key

  const run = useCallback(async () => {
    if (!wallet.publicKey) return;
    setBusy(true);
    setError(null);
    try {
      const nonce = await fetchNonce();
      const fields = siwsFields(wallet.publicKey.toBase58(), nonce, { domain: window.location.hostname, uri: window.location.origin });
      let address = fields.address;
      let message: string;
      let signature: Uint8Array;
      if (wallet.signIn) {
        const out = await wallet.signIn(fields);
        address = out.account.address;
        message = new TextDecoder().decode(out.signedMessage);
        signature = out.signature;
      } else if (wallet.signMessage) {
        message = buildSiwsMessage(fields);
        signature = await wallet.signMessage(new TextEncoder().encode(message));
      } else {
        throw new Error(`${wallet.wallet?.adapter.name ?? "This wallet"} cannot sign messages`);
      }
      useSession.getState().set(await siwsLogin(address, message, toBase64(signature)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [wallet]);

  useEffect(() => {
    if (armed.current && wallet.publicKey) {
      armed.current = false;
      void run();
    }
  }, [wallet.publicKey, run]);

  const signIn = useCallback(async () => {
    if (wallet.publicKey) return run();
    armed.current = true;
    if (wallet.wallet) {
      try { await wallet.connect(); } catch (e) { armed.current = false; setError(e instanceof Error ? e.message : String(e)); }
    } else {
      setVisible(true);
    }
  }, [wallet, run, setVisible]);

  const signOut = useCallback(async () => {
    useSession.getState().clear();
    if (wallet.connected) await wallet.disconnect().catch(() => undefined);
  }, [wallet]);

  return { signIn, signOut, busy, error, clearError: () => setError(null) };
}
