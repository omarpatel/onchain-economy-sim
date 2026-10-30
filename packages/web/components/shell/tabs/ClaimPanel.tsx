"use client";

import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { useSession } from "../../../lib/client/auth.ts";
import { buildClaimTx, claimErrorText, loadClaims, PROGRAM_IDS, type Claimable } from "../../../lib/client/claim.ts";
import { EXPLORER_CLUSTER, explorerAddress, explorerTx, ECON_MINT } from "../../../lib/client/config.ts";
import { fmtEcon } from "../../../lib/format.ts";
import { useUi } from "../../../lib/store.ts";
import { Badge, Button, Panel, Table } from "../../ui/index.tsx";

function Addr({ value, label }: { value: string; label?: string }) {
  if (!value) return <span className="text-amber-300">not configured</span>;
  return (
    <a href={explorerAddress(value)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-[11px] text-cyan hover:underline" title={value}>
      {label ?? `${value.slice(0, 6)}…${value.slice(-6)}`} <ExternalLink size={10} />
    </a>
  );
}

type TxState = { status: "idle" } | { status: "sending" } | { status: "sent"; signature: string } | { status: "error"; text: string };

/**
 * Merkle-claim UI for epoch $ECON dividends: lists the connected wallet's
 * allocations from the proofs API and submits `dividends.claim` through the
 * wallet adapter. Everything else on-chain (staking, land NFTs, RWA) stays
 * in-sim and is settled per epoch by the worker.
 */
export function ClaimPanel() {
  const session = useSession((s) => s.session);
  const wallet = useWallet();
  const { connection } = useConnection();
  const toast = useUi((s) => s.toast);
  const [rows, setRows] = useState<Claimable[] | null>(null);
  const [latestEpoch, setLatestEpoch] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tx, setTx] = useState<Record<number, TxState>>({});

  const pubkey = session?.kind === "wallet" ? session.pubkey ?? null : null;

  const refresh = useCallback(async () => {
    if (!pubkey) return;
    setLoading(true);
    setError(null);
    try {
      const r = await loadClaims(pubkey, connection);
      setRows(r.rows);
      setLatestEpoch(r.latestEpoch);
    } catch (e) {
      setError(claimErrorText(e));
    } finally {
      setLoading(false);
    }
  }, [pubkey, connection]);

  useEffect(() => { void refresh(); }, [refresh]);

  const claim = async (row: Claimable) => {
    const epoch = row.proof.epoch;
    if (!wallet.publicKey || wallet.publicKey.toBase58() !== pubkey) {
      setTx((t) => ({ ...t, [epoch]: { status: "error", text: `Connect ${pubkey?.slice(0, 4)}… in your wallet to sign the claim.` } }));
      return;
    }
    setTx((t) => ({ ...t, [epoch]: { status: "sending" } }));
    try {
      const { tx: transaction } = await buildClaimTx(connection, wallet.publicKey, row.proof);
      const signature = await wallet.sendTransaction(transaction, connection);
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      const conf = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
      if (conf.value.err) throw new Error(`transaction failed: ${JSON.stringify(conf.value.err)}`);
      setTx((t) => ({ ...t, [epoch]: { status: "sent", signature } }));
      toast("ok", `Claimed ${fmtEcon(Number(row.proof.amount))} for epoch ${epoch}`);
      setRows((rs) => rs && rs.map((r) => (r.proof.epoch === epoch ? { ...r, claimed: true } : r)));
    } catch (e) {
      const text = claimErrorText(e);
      setTx((t) => ({ ...t, [epoch]: { status: "error", text } }));
      toast("error", text);
    }
  };

  return (
    <Panel
      title="On-chain claims"
      action={<span className="flex items-center gap-1.5"><Badge tone="cyan">{EXPLORER_CLUSTER}</Badge>{pubkey && <Button size="sm" tone="ghost" disabled={loading} onClick={() => void refresh()} title="Reload allocations"><RefreshCw size={11} className={loading ? "animate-spin" : ""} /></Button>}</span>}
    >
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
        <span className="text-muted">Dividends program</span><Addr value={PROGRAM_IDS.dividends} />
        <span className="text-muted">$ECON mint</span><Addr value={ECON_MINT} />
      </div>
      <p className="mt-2 text-[10px] text-muted">Epoch dividends of on-chain companies and veECON yield are committed as a Merkle root per epoch; claim them here. Staking, land and RWA positions are in-sim — settled per epoch.</p>

      {!pubkey ? (
        <div className="mt-3 rounded border border-edge bg-white/[0.03] px-2 py-2 text-[11px] text-slate-300">
          {session ? "Sign in with a Solana wallet (top bar) to see and claim your $ECON allocations. Guest earnings are not claimable." : "Sign in with a wallet to see your claimable $ECON."}
        </div>
      ) : (
        <div className="mt-3">
          {error && <div className="mb-2 rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-200">{error}</div>}
          {wallet.publicKey && wallet.publicKey.toBase58() !== pubkey && (
            <div className="mb-2 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200">Wallet {wallet.publicKey.toBase58().slice(0, 4)}… is connected but you are signed in as {pubkey.slice(0, 4)}…; switch accounts to claim.</div>
          )}
          <Table
            dense
            rows={rows ?? []}
            rowKey={(r) => String(r.proof.epoch)}
            empty={rows === null ? (loading ? "Loading allocations…" : "—") : latestEpoch === null ? "No epoch has closed yet." : `Nothing to claim in epochs ${Math.max(1, latestEpoch - 10)}–${latestEpoch}.`}
            columns={[
              { key: "epoch", header: "Epoch", cell: (r) => <span>{r.proof.epoch} <span className="text-[9px] text-muted">chain {r.proof.chainEpoch}</span></span> },
              { key: "amt", header: "$ECON", align: "right", cell: (r) => fmtEcon(Number(r.proof.amount)) },
              {
                key: "act", header: "", align: "right", cell: (r) => {
                  const s = tx[r.proof.epoch] ?? { status: "idle" };
                  if (s.status === "sent") return <a href={explorerTx(s.signature)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] text-emerald-300 hover:underline">claimed <ExternalLink size={10} /></a>;
                  if (r.claimed) return <Badge tone="up">claimed</Badge>;
                  return (
                    <span className="flex flex-col items-end gap-1">
                      <Button size="sm" tone="primary" disabled={s.status === "sending"} onClick={() => void claim(r)}>{s.status === "sending" ? "Signing…" : "Claim"}</Button>
                      {s.status === "error" && <span className="max-w-[180px] text-right text-[10px] text-rose-300">{s.text}</span>}
                    </span>
                  );
                },
              },
            ]}
          />
        </div>
      )}
    </Panel>
  );
}
