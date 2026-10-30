"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Bell, Building2, Clock3, Coins, PanelRightClose, PanelRightOpen, TrendingDown, TrendingUp } from "lucide-react";
import { useWorld } from "../../lib/world.ts";
import { useUi } from "../../lib/store.ts";
import { fmtClock, fmtCr, fmtEcon } from "../../lib/format.ts";
import { IconButton, Sparkline } from "../ui/index.tsx";
import { AnimatedNumber } from "../ui/AnimatedNumber.tsx";
import { WalletSlot } from "./WalletSlot.tsx";
import { PlaceSearch } from "./PlaceSearch.tsx";

/** Small-caps label over a mono value; the $ECON group on the left. */
function Group({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex shrink-0 flex-col justify-center whitespace-nowrap leading-none">
      <span className="label mb-1">{label}</span>
      <span className="font-mono text-[13px] font-semibold tabular-nums text-white">{value}</span>
    </div>
  );
}

/** Inline label/value pair for the macro group (CR supply, treasury…); one full header row tall so cells that don't fit wrap out of view. */
function Cell({ label, value, tone = "text-slate-200" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex h-11 items-center whitespace-nowrap">
      <span className="flex items-baseline gap-1.5">
        <span className="label">{label}</span>
        <span className={`font-mono text-[11px] font-semibold tabular-nums ${tone}`}>{value}</span>
      </span>
    </div>
  );
}

/** Events in the last 24 ticks that mention your company id. */
const RECENT_TICKS = 24;
/** Cash samples kept for the money sparkline (one per sim tick, ~40 s at 800 ms ticks). */
const TREND_TICKS = 48;

/**
 * Rolling per-tick samples of `value`, recorded client-side when `tick` advances (the snapshot keeps no
 * per-company cash history). Restarts when `key` changes, e.g. on founding a company.
 */
function useTickSeries(value: number, tick: number, key: string): number[] {
  const latest = useRef(value);
  latest.current = value;
  const [series, setSeries] = useState<{ key: string; v: number[] }>({ key, v: [] });
  useEffect(() => {
    const v = latest.current;
    setSeries((p) => (p.key !== key ? { key, v: [v] } : { key, v: p.v.length >= TREND_TICKS ? [...p.v.slice(1), v] : [...p.v, v] }));
  }, [tick, key]);
  return series.key === key ? series.v : [];
}

/** Treasury capsule: coin chip, tweened balance, per-tick P&L chip and the cash sparkline. */
function MoneyPill({ cash, pnl, trend }: { cash: number; pnl: number; trend: number[] }) {
  const up = pnl >= 0;
  return (
    <div className="glass flex h-8 shrink-0 items-center gap-2 !rounded-full py-1 pl-1 pr-3" title="Company cash · net P&L per tick">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-b from-amber-300 to-amber-500 text-amber-950 shadow-[inset_0_1px_0_rgba(255,255,255,.6),0_0_10px_rgba(245,158,11,.35)]">
        <Coins size={13} strokeWidth={2.5} />
      </span>
      <AnimatedNumber value={cash} format={(n) => fmtCr(Math.round(n))} className="whitespace-nowrap font-mono text-[13px] font-bold text-white" />
      <span className={`flex items-center gap-0.5 whitespace-nowrap rounded-full px-1.5 py-px font-mono text-[10px] font-semibold tabular-nums ${up ? "bg-mint/10 text-mint-300" : "bg-rose-500/10 text-rose-300"}`}>
        {up ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
        {fmtCr(pnl, { sign: true })}<span className="max-sm:hidden">/tick</span>
      </span>
      <span className="hidden sm:block"><Sparkline values={trend} width={56} height={18} area /></span>
    </div>
  );
}

/** 44px glass header: logo, money capsule, clock pill, macro cells (dropped whole when space runs out), search, action buttons, wallet. */
export function TopBar() {
  const { snap, you, events, connected, mode, latencyMs } = useWorld();
  const drawerOpen = useUi((s) => s.drawerOpen);
  const toggleDrawer = useUi((s) => s.toggleDrawer);
  const setTab = useUi((s) => s.setTab);
  const m = snap.money;
  const company = you?.company ?? null;
  const cash = company?.cashCr ?? you?.cashCr ?? 0;
  const pnl = company?.lastPnl.net ?? 0;
  const trend = useTickSeries(cash, snap.tick, company?.id ?? "wallet");

  const myId = company?.id ?? null;
  const mine = useMemo(() => {
    if (!myId) return 0;
    const since = snap.tick - RECENT_TICKS;
    let n = 0;
    // quoted so co:2 doesn't also count events of co:20…co:29
    for (const e of events) if (e.tick > since && JSON.stringify(e).includes(`"${myId}"`)) n++;
    return n;
  }, [events, myId, snap.tick]);

  const linkTitle = mode === "online"
    ? (connected ? `Authoritative tick server · ${latencyMs === null ? "live" : `${latencyMs} ms round trip`}` : "Connection lost — reconnecting with backoff")
    : "In-browser sandbox engine · local";

  return (
    <header className="glass relative z-40 flex h-11 shrink-0 items-center gap-3 !rounded-none !border-x-0 !border-t-0 px-3 !shadow-[inset_0_-1px_0_rgba(0,0,0,.4),0_8px_24px_-12px_rgba(0,0,0,.8)] md:gap-4">
      <Link href="/" className="font-logo shrink-0 text-[20px] leading-none tracking-wide text-mint-300 drop-shadow-[0_0_10px_rgba(125,255,179,.4)] transition-[filter] hover:drop-shadow-[0_0_14px_rgba(125,255,179,.7)]">
        <span className="text-white">ECONOMY</span> SIM
      </Link>

      <MoneyPill cash={cash} pnl={pnl} trend={trend} />
      <div className="hidden sm:flex"><Group label="$ECON" value={fmtEcon(you?.econ ?? 0)} /></div>

      <div className="hidden shrink-0 grow justify-center md:flex">
        <span
          title={linkTitle}
          className="flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full bg-black/30 px-3 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-100 shadow-[inset_0_1px_2px_rgba(0,0,0,.5)] ring-1 ring-white/[0.07]"
        >
          <span className="relative flex h-1.5 w-1.5">
            {connected && <span className="absolute inset-0 animate-ping rounded-full bg-mint/60 motion-reduce:hidden" />}
            <span className={`relative h-1.5 w-1.5 rounded-full ${connected ? "bg-mint" : "animate-pulse bg-amber-400"}`} />
          </span>
          <Clock3 size={11} className="text-muted" />
          Epoch {snap.epoch} · {fmtClock(snap.tick, snap.ticksPerDay)}
          <span className="text-muted">· {mode === "online" ? (connected ? (latencyMs === null ? "live" : `${latencyMs}ms`) : "reconnecting") : "sandbox"}</span>
        </span>
      </div>
      <div className="hidden h-11 min-w-0 flex-wrap items-center gap-x-4 overflow-hidden xl:flex">
        <Cell label="CR supply" value={fmtCr(m.crSupply, { compact: true })} />
        <Cell label="$ECON circ." value={fmtEcon(m.econCirculating, { compact: true })} />
        <Cell label="Treasury" value={fmtCr(m.treasuryCr, { compact: true })} tone="text-gold" />
        <Cell label="Creator fees" value={fmtEcon(m.creatorFees, { compact: true })} tone="text-gold" />
        <Cell label="Ledger" value={m.conserved ? "conserved" : "DRIFT"} tone={m.conserved ? "text-mint-300" : "text-rose-400"} />
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <div className="hidden lg:block"><PlaceSearch /></div>
        <div className="hidden items-center gap-1.5 sm:flex">
          <IconButton size="sm" icon={<Bell size={14} />} label="Events" title="Your company's recent events · Ledger" badge={mine} onClick={() => setTab("ledger")} />
          <IconButton size="sm" icon={<Building2 size={14} />} label="Company" title="Company tab" onClick={() => setTab("company")} />
          <span className="mx-1 h-5 w-px bg-gradient-to-b from-transparent via-white/15 to-transparent" />
        </div>
        <div className="hidden md:block"><WalletSlot /></div>
        <button
          onClick={toggleDrawer}
          title={drawerOpen ? "Hide panel (Tab)" : "Show panel (Tab)"}
          aria-label={drawerOpen ? "Hide panel" : "Show panel"}
          aria-expanded={drawerOpen}
          className={`flex h-[30px] w-[30px] items-center justify-center rounded-lg border transition-[background-color,color,border-color,transform] duration-150 active:scale-95 ${drawerOpen ? "border-white/15 bg-white/[0.06] text-slate-100" : "border-edge text-muted"} hover:bg-white/[0.1] hover:text-white`}
        >
          {drawerOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
        </button>
      </div>
    </header>
  );
}
