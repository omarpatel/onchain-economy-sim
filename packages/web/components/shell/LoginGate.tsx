"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { Globe2, Wallet } from "lucide-react";
import { guestLogin, useSession } from "../../lib/client/auth.ts";
import { useWalletSignIn } from "../../lib/client/useWalletSignIn.ts";
import { Button, TextInput } from "../ui/index.tsx";

/** Full-screen gate shown by the online provider when there is no session yet. */
export function LoginGate() {
  const setSession = useSession((s) => s.set);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wallet = useWalletSignIn();

  const guest = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setSession(await guestLogin(name.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-screen w-full items-center justify-center bg-obsidian text-slate-200">
      <div className="w-[380px] rounded-lg border border-edge bg-panel p-5 shadow-2xl">
        <div className="mb-1 flex items-center gap-2 text-xl font-bold tracking-wide"><Globe2 className="text-cyan" /> ECONOMY SIM</div>
        <p className="mb-4 text-xs text-muted">Pick a name to found a company on the live server. A wallet is only needed to claim on-chain dividends.</p>
        <form onSubmit={guest} className="flex flex-col gap-2">
          <TextInput label="Company founder" value={name} onChange={setName} placeholder="e.g. Ada" maxLength={32} />
          <Button type="submit" tone="primary" disabled={busy || wallet.busy || name.trim().length < 1}>{busy ? "Founding…" : "Play as guest"}</Button>
        </form>
        <div className="my-3 flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted"><span className="h-px flex-1 bg-edge" />or<span className="h-px flex-1 bg-edge" /></div>
        <Button className="w-full" disabled={busy || wallet.busy} onClick={() => void wallet.signIn()}>
          <Wallet size={13} className="text-cyan" /> {wallet.busy ? "Waiting for wallet…" : "Sign in with Solana wallet"}
        </Button>
        {(error ?? wallet.error) && <div className="mt-3 rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-200">{error ?? wallet.error}</div>}
        <div className="mt-4 text-center text-[11px] text-muted">
          Prefer to stay offline? <Link href="/play?mode=sandbox" className="text-cyan hover:underline">Run the sandbox</Link>
        </div>
      </div>
    </div>
  );
}
