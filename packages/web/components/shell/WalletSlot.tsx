"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, LogOut, Pencil, Wallet, X } from "lucide-react";
import { renamePlayer, useSession } from "../../lib/client/auth.ts";
import { useWalletSignIn } from "../../lib/client/useWalletSignIn.ts";
import { useUi } from "../../lib/store.ts";

const btn = "flex h-7 items-center gap-1.5 rounded-md border border-edge bg-white/[0.04] px-2.5 text-[11px] font-semibold text-slate-200 transition-colors hover:bg-white/[0.08] disabled:opacity-50";

const GUEST_SWITCH_HINT = "Signing in with a wallet starts a new session. Your guest company stays with the guest id; the wallet player gets its own company.";

/**
 * Top-bar / landing-header session control: wallet sign-in (SIWS), the
 * current player (short pubkey + editable name) and sign-out. Independent of
 * the WorldContext so the landing page can mount it too.
 */
export function WalletSlot() {
  const session = useSession((s) => s.session);
  const hydrate = useSession((s) => s.hydrate);
  const rename = useSession((s) => s.rename);
  const toast = useUi((s) => s.toast);
  const wallet = useWalletSignIn();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const shownError = useRef<string | null>(null);
  useEffect(() => hydrate(), [hydrate]);

  useEffect(() => {
    if (!wallet.error) { shownError.current = null; return; }
    if (wallet.error !== shownError.current) {
      shownError.current = wallet.error;
      toast("error", `Wallet sign-in failed: ${wallet.error}`);
      wallet.clearError();
    }
  }, [wallet, toast]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!session) return;
    const next = name.trim();
    if (!next || next === session.name) { setEditing(false); return; }
    setSaving(true);
    try {
      rename(await renamePlayer(session.token, next));
      toast("ok", `Now playing as ${next}`);
      setEditing(false);
    } catch (err) {
      toast("error", err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (!session) {
    return (
      <button type="button" onClick={() => void wallet.signIn()} disabled={wallet.busy} className={btn} title="Sign in with a Solana wallet (SIWS)">
        <Wallet size={13} className="text-mint-300" />
        {wallet.busy ? "Signing in…" : "Connect wallet"}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <div className="flex h-7 items-center gap-1.5 rounded-md border border-edge bg-white/[0.04] px-2 text-[11px]" title={session.kind === "wallet" ? `Signed in as ${session.pubkey}` : `Guest session · ${session.playerId}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${session.kind === "wallet" ? "bg-mint" : "bg-amber-400"}`} />
        {session.kind === "wallet" && session.pubkey && <span className="font-mono text-[10px] text-muted">{session.pubkey.slice(0, 4)}…{session.pubkey.slice(-4)}</span>}
        {editing ? (
          <form onSubmit={save} className="flex items-center gap-1">
            <input autoFocus value={name} maxLength={32} onChange={(e) => setName(e.target.value)} className="h-5 w-28 rounded border border-edge bg-black/40 px-1 text-[11px] text-slate-100 outline-none focus:border-mint/60" />
            <button type="submit" disabled={saving} className="text-mint-300 hover:text-white" title="Save"><Check size={12} /></button>
            <button type="button" onClick={() => setEditing(false)} className="text-muted hover:text-slate-100" title="Cancel"><X size={12} /></button>
          </form>
        ) : (
          <>
            <span className="max-w-[9rem] truncate text-slate-100">{session.name}</span>
            <button type="button" onClick={() => { setName(session.name); setEditing(true); }} className="text-muted hover:text-slate-100" title="Rename player"><Pencil size={11} /></button>
          </>
        )}
      </div>
      {session.kind === "guest" && (
        <button type="button" onClick={() => void wallet.signIn()} disabled={wallet.busy} className={btn} title={GUEST_SWITCH_HINT}>
          <Wallet size={13} className="text-mint-300" />
          {wallet.busy ? "Signing in…" : "Connect wallet"}
        </button>
      )}
      <button type="button" onClick={() => void wallet.signOut()} className="rounded-md border border-edge p-1 text-muted hover:text-slate-100" title="Sign out">
        <LogOut size={13} />
      </button>
    </div>
  );
}
