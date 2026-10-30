"use client";

import { useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  AlertTriangle, ArrowLeftRight, Banknote, Coins, Flame, Hammer, Landmark, Lock, MapPin, Rocket, Skull, Sparkles, TrendingDown, TrendingUp, Unlock, XCircle,
} from "lucide-react";
import type { GameEvent } from "@econ-sim/sim/protocol";
import type { Candle, EconomySnapshot } from "@econ-sim/sim/snapshot";
import { useWorld } from "../../lib/world.ts";
import { fmtCr, fmtPct, fmtEcon, titleCase } from "../../lib/format.ts";
import { sound } from "../../lib/sound.ts";

interface Rendered { icon: ReactNode; text: string; tone: string }

function render(e: GameEvent, snap: EconomySnapshot): Rendered {
  const co = (id: string) => snap.companies.find((c) => c.id === id)?.name ?? id;
  switch (e.kind) {
    case "build_started": return { icon: <Hammer size={12} />, text: `${co(e.companyId)} broke ground on a ${titleCase(e.buildingType)} at ${e.tileId}`, tone: "text-amber-300" };
    case "build_live": return { icon: <Sparkles size={12} />, text: `${co(e.companyId)}'s ${titleCase(e.buildingType)} is live`, tone: "text-emerald-300" };
    case "demolished": return { icon: <XCircle size={12} />, text: `${co(e.companyId)} demolished a building`, tone: "text-slate-400" };
    case "land_bought": return { icon: <MapPin size={12} />, text: `${co(e.buyer)} bought tile ${e.tileId} for ${e.unit === "CR" ? fmtCr(e.price) : fmtEcon(e.price)}${e.nft ? ` · NFT ${e.nft}` : ""}`, tone: "text-cyan-300" };
    case "ipo": return { icon: <Rocket size={12} />, text: `IPO · ${co(e.companyId)} floats ${e.floatShares.toLocaleString()} shares @ ${fmtCr(e.priceCr)} raising ${fmtCr(e.raisedCr)}`, tone: "text-gold" };
    case "share_trade": return { icon: <ArrowLeftRight size={12} />, text: `${co(e.companyId)} ${e.qty.toLocaleString()} sh @ ${fmtCr(e.priceCr)}`, tone: "text-slate-200" };
    case "dividend": return { icon: <Coins size={12} />, text: `${co(e.companyId)} paid ${fmtCr(e.poolCr)} dividends (${fmtCr(e.perShareCr)}/sh)`, tone: "text-emerald-300" };
    case "loan": return { icon: <Banknote size={12} />, text: `${co(e.companyId)} borrowed ${fmtCr(e.amountCr)} @ ${(e.rateBps / 100).toFixed(2)}%/tick`, tone: "text-amber-200" };
    case "repaid": return { icon: <Banknote size={12} />, text: `${co(e.companyId)} repaid ${fmtCr(e.amountCr)}`, tone: "text-emerald-200" };
    case "bankrupt": return { icon: <Skull size={12} />, text: `${co(e.companyId)} went bankrupt`, tone: "text-rose-400" };
    case "graduated": return { icon: <Landmark size={12} />, text: `${co(e.companyId)} graduated on-chain at ${fmtCr(e.marketCapCr)} cap`, tone: "text-gold" };
    case "staked": return { icon: <Lock size={12} />, text: `${e.account} staked ${fmtEcon(e.amountEcon)} behind ${co(e.companyId)}`, tone: "text-cyan-300" };
    case "unstaked": return { icon: <Unlock size={12} />, text: `${e.account} unstaked ${fmtEcon(e.amountEcon)} from ${co(e.companyId)}`, tone: "text-cyan-200" };
    case "epoch_close": return { icon: <Flame size={12} />, text: `Epoch ${e.epoch} closed · ${fmtCr(e.dividendsCr)} dividends · ${fmtEcon(e.yieldEcon)} yield · ${fmtEcon(e.burnedEcon)} burned`, tone: "text-gold" };
    case "market_flow": return { icon: <ArrowLeftRight size={12} />, text: `${titleCase(e.good)} ${fmtCr(e.priceCr)} · ${e.bought} bought / ${e.sold} sold`, tone: "text-slate-400" };
    case "price_alert": return { icon: e.pct >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />, text: `${titleCase(e.good)} ${fmtPct(e.pct)} → ${fmtCr(e.priceCr)}`, tone: e.pct >= 0 ? "text-emerald-300" : "text-rose-300" };
    case "intent_rejected": return { icon: <AlertTriangle size={12} />, text: `${e.playerId}: ${e.intentKind} rejected — ${e.error}`, tone: "text-rose-300" };
  }
}

/** Kinds shown in the ticker; per-good market flow would drown everything else. */
const SHOWN: Record<GameEvent["kind"], boolean> = {
  build_started: true, build_live: true, demolished: true, land_bought: true, ipo: true, share_trade: true, dividend: true,
  loan: true, repaid: true, bankrupt: true, graduated: true, staked: true, unstaked: true, epoch_close: true,
  market_flow: false, price_alert: true, intent_rejected: true,
};

/** Loan traffic below this (CR minor) is NPC treasury housekeeping; only your own company's is always shown. */
const MATERIAL_LOAN_CR = 1000 * 100;

/** Price change of a public company vs the close 24 candles ago (or the oldest candle if history is shorter). */
function shareChange(price: number, candles: Candle[] | undefined): number | null {
  if (!candles || candles.length === 0) return null;
  const base = candles[Math.max(0, candles.length - 24)].c;
  return base > 0 ? price / base - 1 : null;
}

/** 24px glass strip: public company prices interleaved with events; plays cues for fills/dividends as they arrive. */
export function Ticker() {
  const { events, snap, you } = useWorld();
  const lastTick = useRef<number | null>(null);
  const myCompany = you?.company?.id ?? null;
  const shown = useMemo(() => {
    // one share_trade per company per tick; the exchange emits one per fill
    const lastTrade: Record<string, number> = {};
    events.forEach((e, i) => { if (e.kind === "share_trade") lastTrade[`${e.companyId}@${e.tick}`] = i; });
    return events.filter((e, i) => {
      if (!SHOWN[e.kind]) return false;
      if (e.kind === "share_trade") return lastTrade[`${e.companyId}@${e.tick}`] === i;
      if (e.kind === "loan" || e.kind === "repaid") return e.companyId === myCompany || e.amountCr >= MATERIAL_LOAN_CR;
      return true;
    }).slice(-40);
  }, [events, myCompany]);

  useEffect(() => {
    if (events.length === 0) return;
    const newest = events[events.length - 1].tick;
    const since = lastTick.current;
    lastTick.current = newest;
    if (since === null) return; // first paint: don't replay history
    for (const e of events) {
      if (e.tick <= since) continue;
      if (e.kind === "dividend" && you?.holdings.some((h) => h.companyId === e.companyId)) sound.play("dividend");
      else if (e.kind === "share_trade" && you && (e.buyer === you.playerId || e.seller === you.playerId)) sound.play("fill");
    }
  }, [events, you]);

  const items = useMemo<ReactNode[]>(() => {
    const prices = snap.companies.filter((c) => c.public);
    const out: ReactNode[] = [];
    const n = Math.max(prices.length, shown.length);
    for (let i = 0; i < n; i++) {
      const c = prices[i];
      if (c) {
        const ch = shareChange(c.sharePrice, snap.history.shares[c.id]);
        const up = (ch ?? 0) >= 0;
        out.push(
          <span key={`c-${c.id}`} className={`flex h-full items-center gap-1.5 px-3 font-mono text-[11px] tabular-nums ${up ? "bg-mint/[0.07] text-mint-300" : "bg-rose-500/[0.08] text-rose-300"}`}>
            <span className="font-sans font-semibold text-slate-200">{c.name}</span>
            <span className="text-white">${fmtCr(c.sharePrice, { unit: false })}</span>
            <span>{ch === null ? "—" : `${up ? "▲" : "▼"}${(Math.abs(ch) * 100).toFixed(1)}%`}</span>
          </span>,
        );
      }
      const e = shown[i];
      if (e) {
        const r = render(e, snap);
        out.push(
          <span key={`e-${i}-${e.tick}-${e.kind}`} className={`flex h-full items-center gap-1.5 px-3 text-[11px] font-semibold ${r.tone}`}>
            <span className="font-mono text-[10px] font-normal text-muted">t{e.tick}</span>
            {r.icon}
            {r.text}
          </span>,
        );
      }
    }
    return out;
  }, [shown, snap]);

  return (
    <footer className="glass relative h-6 shrink-0 overflow-hidden !rounded-none !border-x-0 !border-b-0">
      <div className="label absolute left-0 top-0 z-10 flex h-full w-24 items-center justify-center whitespace-nowrap border-r border-edge bg-[#161618]">
        Events · {events.length}
      </div>
      {items.length === 0 ? (
        <div className="flex h-full items-center pl-28 text-[11px] text-muted">Waiting for the first tick…</div>
      ) : (
        <div className="absolute inset-y-0 left-24 right-0 overflow-hidden">
          <div className="ticker-track flex h-full items-center whitespace-nowrap" style={{ animationDuration: `${Math.max(30, items.length * 3)}s` }}>
            {[0, 1].map((k) => <span key={k} className="contents">{items}</span>)}
          </div>
        </div>
      )}
    </footer>
  );
}
