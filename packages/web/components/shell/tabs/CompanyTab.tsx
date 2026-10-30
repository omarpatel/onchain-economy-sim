"use client";

import { useState } from "react";
import { Crosshair, Pencil, Trash2, Truck } from "lucide-react";
import type { Good } from "@econ-sim/sim/goods";
import { ALL_GOODS, RECIPES } from "@econ-sim/sim/goods";
import type { CompanyView } from "@econ-sim/sim/protocol";
import { CONFIG } from "@econ-sim/sim/config";
import { useWorld } from "../../../lib/world.ts";
import { useUi } from "../../../lib/store.ts";
import { fmtCr, fmtPct, fmtEcon, num, titleCase } from "../../../lib/format.ts";
import { BUILDING_STYLE } from "../../three/world-style.ts";
import { Badge, Bar, Button, FormError, NumberInput, Panel, Slider, Stat, TextInput, Toggle } from "../../ui/index.tsx";
import { useIntent } from "../useIntent.ts";

function PnlRow({ k, v, neg }: { k: string; v: number; neg?: boolean }) {
  return (
    <div className="flex justify-between font-mono text-[11px] tabular-nums">
      <span className="text-muted">{k}</span>
      <span className={neg ? "text-rose-300" : v >= 0 ? "text-emerald-300" : "text-rose-300"}>{fmtCr(neg ? -v : v, { sign: true })}</span>
    </div>
  );
}

function Header({ co }: { co: CompanyView }) {
  const { submit, busy } = useIntent();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(co.name);
  return (
    <Panel>
      <div className="flex items-start justify-between gap-2">
        {editing ? (
          <form className="flex flex-1 gap-1" onSubmit={(e) => { e.preventDefault(); void submit({ kind: "rename_company", name }, `Renamed to ${name}`).then((r) => r.ok && setEditing(false)); }}>
            <TextInput value={name} onChange={setName} maxLength={32} />
            <Button type="submit" size="sm" tone="primary" disabled={busy || name.trim().length < 2}>Save</Button>
            <Button size="sm" tone="ghost" onClick={() => setEditing(false)}>×</Button>
          </form>
        ) : (
          <div>
            <div className="flex items-center gap-2 text-base font-semibold text-slate-100">
              {co.name}
              <button onClick={() => { setName(co.name); setEditing(true); }} className="text-muted hover:text-slate-100" title="Rename"><Pencil size={12} /></button>
            </div>
            <div className="mt-1 flex flex-wrap gap-1">
              {co.isPublic ? <Badge tone="gold">public</Badge> : <Badge>private</Badge>}
              {co.isOnChain && <Badge tone="up">on-chain</Badge>}
              {co.bankrupt && <Badge tone="down">bankrupt</Badge>}
              <Badge tone="cyan">HQ {co.hubTileId}</Badge>
            </div>
          </div>
        )}
      </div>
      <div className="mt-3">
        <Toggle label="Autopilot" hint="Let the NPC manager run production, trades and expansion" checked={co.autopilot}
          onChange={(v) => submit({ kind: "set_autopilot", enabled: v }, v ? "Autopilot engaged" : "Manual control")} />
      </div>
    </Panel>
  );
}

function Financials({ co }: { co: CompanyView }) {
  const p = co.lastPnl;
  return (
    <Panel title="Financials">
      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
        <Stat label="Cash" value={fmtCr(co.cashCr)} size="sm" />
        <Stat label="Debt" value={fmtCr(co.debtCr)} size="sm" tone={co.debtCr > 0 ? "down" : "default"} />
        <Stat label="Book value" value={fmtCr(co.bookValueCr)} size="sm" />
        <Stat label="Valuation" value={fmtCr(co.valuationCr)} size="sm" />
        <Stat label="Epoch profit" value={fmtCr(co.epochProfitCr, { sign: true })} size="sm" tone={co.epochProfitCr >= 0 ? "up" : "down"} />
        <Stat label="Smoothed profit" value={fmtCr(co.smoothedProfitCr, { sign: true })} size="sm" tone={co.smoothedProfitCr >= 0 ? "up" : "down"} />
      </div>
      <div className="mt-3 border-t border-edge pt-2">
        <div className="mb-1 text-[10px] uppercase tracking-wider text-muted">Last tick P&L</div>
        <PnlRow k="Revenue" v={p.revenue} />
        <PnlRow k="Input cost" v={p.inputCost} neg />
        <PnlRow k="Labor" v={p.labor} neg />
        <PnlRow k="Energy" v={p.energy} neg />
        <PnlRow k="Logistics" v={p.logistics} neg />
        <PnlRow k="Interest" v={p.interest} neg />
        <div className="mt-1 flex justify-between border-t border-edge pt-1 font-mono text-xs font-semibold tabular-nums">
          <span>Net</span>
          <span className={p.net >= 0 ? "text-emerald-300" : "text-rose-300"}>{fmtCr(p.net, { sign: true })}</span>
        </div>
      </div>
    </Panel>
  );
}

function BuildingsList({ co }: { co: CompanyView }) {
  const { submit, busy } = useIntent();
  const focusTile = useUi((s) => s.focusTile);
  const selectTile = useUi((s) => s.selectTile);
  const setBuildMode = useUi((s) => s.setBuildMode);
  return (
    <Panel title={`Buildings · ${co.buildings.length}`} action={<Button size="sm" tone="ghost" onClick={() => setBuildMode("mine")}>+ Build</Button>}>
      {co.buildings.length === 0 && <div className="text-[11px] text-muted">No buildings yet — open Build in the hotbar.</div>}
      <div className="flex flex-col gap-1.5">
        {co.buildings.map((b) => (
          <div key={b.id} className="rounded border border-edge/70 bg-black/20 px-2 py-1.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="flex items-center gap-1.5 text-slate-100">
                <span className="inline-block h-2 w-2 rounded-sm" style={{ background: BUILDING_STYLE[b.type].color }} />
                {BUILDING_STYLE[b.type].label}
                <span className="font-mono text-muted">({b.x},{b.y})</span>
              </span>
              <span className="flex items-center gap-1">
                {b.live ? <span className="font-mono tabular-nums">{fmtPct(b.utilization, 0, false)}</span> : <Badge tone="gold">building · live t{b.liveAtTick}</Badge>}
                <button className="text-muted hover:text-slate-100" title="Focus" onClick={() => { selectTile(b.tileId); focusTile(b.x, b.y); }}><Crosshair size={11} /></button>
                <button className="text-muted hover:text-rose-300" title="Demolish" disabled={busy} onClick={() => submit({ kind: "demolish", buildingId: b.id }, `${BUILDING_STYLE[b.type].label} demolished`, "place")}><Trash2 size={11} /></button>
              </span>
            </div>
            <Bar className="mt-1" value={b.live ? b.utilization : 0} tone={b.utilization > 0.5 ? "up" : b.utilization > 0 ? "gold" : "down"} />
          </div>
        ))}
      </div>
    </Panel>
  );
}

function Inventory({ co }: { co: CompanyView }) {
  const { submit, busy } = useIntent();
  const selectGood = useUi((s) => s.selectGood);
  const setTab = useUi((s) => s.setTab);
  const { snap } = useWorld();
  const rows = ALL_GOODS.filter((g) => (co.inventory[g] ?? 0) > 0 || co.buildings.some((b) => g in RECIPES[b.type].inputs || g in RECIPES[b.type].outputs));
  const price = (g: Good) => snap.goods.find((x) => x.good === g)?.price ?? 0;
  return (
    <Panel title="Inventory" action={<span className="text-[10px] text-muted">value {fmtCr(rows.reduce((s, g) => s + (co.inventory[g] ?? 0) * price(g), 0), { compact: true })}</span>}>
      {rows.length === 0 && <div className="text-[11px] text-muted">Empty.</div>}
      <div className="flex flex-col">
        {rows.map((g) => {
          const hold = co.sellPolicy[g] === "hold";
          return (
            <div key={g} className="flex items-center justify-between border-b border-edge/60 py-1 text-[11px] last:border-0">
              <button className="text-left text-slate-100 hover:text-cyan-200" onClick={() => { selectGood(g); setTab("market"); }}>{titleCase(g)}</button>
              <span className="flex items-center gap-2">
                <span className="font-mono tabular-nums">{num(co.inventory[g] ?? 0)} u</span>
                <button
                  disabled={busy}
                  title={hold ? "Holding: surplus stays in inventory" : "Auto: surplus is sold each tick"}
                  onClick={() => submit({ kind: "set_sell_policy", good: g, mode: hold ? "auto" : "hold" }, `${titleCase(g)}: ${hold ? "auto-sell" : "hold"}`)}
                  className={`rounded border px-1.5 py-px text-[9px] uppercase ${hold ? "border-amber-500/40 text-amber-300" : "border-emerald-500/40 text-emerald-300"}`}
                >
                  {hold ? "hold" : "auto"}
                </button>
              </span>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function Logistics({ co }: { co: CompanyView }) {
  const { submit, busy, error } = useIntent();
  const ratio = co.haulDemand > 0 ? co.truckCapacity / co.haulDemand : 1;
  return (
    <Panel title="Logistics" action={<Button size="sm" disabled={busy} onClick={() => submit({ kind: "buy_truck" }, "Truck added to the fleet", "place")}><Truck size={12} /> Buy truck</Button>}>
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Trucks" value={String(co.trucks)} size="sm" />
        <Stat label="Capacity" value={`${num(co.truckCapacity)} w/t`} size="sm" />
        <Stat label="Demand" value={`${num(co.haulDemand)} w/t`} size="sm" tone={ratio < 1 ? "down" : "default"} />
      </div>
      <Bar className="mt-2" value={Math.min(1, ratio)} tone={ratio < 1 ? "down" : "up"} />
      {ratio < 1 && <div className="mt-1 text-[10px] text-rose-300">Fleet is short — buildings throttle to what can be hauled.</div>}
      <FormError text={error} />
    </Panel>
  );
}

function Staking({ co, econ }: { co: CompanyView; econ: number }) {
  const { submit, busy, error } = useIntent();
  const [amt, setAmt] = useState(10);
  const maxStake = Math.floor(econ / 10_000) / 100; // wallet $ECON, 2 dp
  const maxUnstake = Math.floor(co.stakedEcon / 10_000) / 100;
  const maxAmt = Math.max(maxStake, maxUnstake);
  return (
    <Panel title="Staking" action={<Badge tone="cyan">boost +{fmtPct(co.boost, 1, false)}</Badge>}>
      <div className="grid grid-cols-2 gap-2">
        <Stat label="Staked behind company" value={fmtEcon(co.stakedEcon)} size="sm" />
        <Stat label="Your wallet" value={fmtEcon(econ)} size="sm" />
      </div>
      <div className="mt-2 grid grid-cols-[1fr_auto_auto] items-end gap-2">
        <NumberInput label={`Amount · max stake ${num(maxStake, 2)}`} value={amt} min={0.01} max={maxAmt} step={0.01} onChange={(v) => setAmt(Math.min(v, maxAmt))} suffix="$ECON" />
        <Button tone="primary" disabled={busy || amt <= 0 || amt > maxStake} onClick={() => submit({ kind: "stake", amountEcon: Math.round(amt * 1_000_000) }, `Staked ${amt} $ECON`)}>Stake</Button>
        <Button disabled={busy || amt <= 0 || amt > maxUnstake} onClick={() => submit({ kind: "unstake", amountEcon: Math.round(amt * 1_000_000) }, `Unstaked ${amt} $ECON`)}>Unstake</Button>
      </div>
      <FormError text={error} />
      <p className="mt-1 text-[10px] text-muted">Staked $ECON boosts production (capped +35%) and earns veECON yield at epoch close — settled per epoch.</p>
    </Panel>
  );
}

function Equity({ co }: { co: CompanyView }) {
  const { submit, busy, error } = useIntent();
  const x = CONFIG.exchange;
  // the engine prices every IPO share at ≥ ipoMinPriceCr, so valuation caps the share count
  const maxShares = Math.min(x.ipoMaxShares, Math.floor(co.valuationCr / x.ipoMinPriceCr));
  const [shares, setShares] = useState(() => Math.max(x.ipoMinShares, Math.min(100_000, Math.floor(maxShares / 1000) * 1000)));
  const [floatPct, setFloatPct] = useState(0.3);
  const blocker = co.buildings.length === 0 ? "Needs at least one building to list"
    : co.cashCr < x.listingFeeCr ? `Needs ${fmtCr(x.listingFeeCr)} cash for the listing fee`
    : maxShares < x.ipoMinShares ? `Valuation supports at most ${num(maxShares)} shares (min ${num(x.ipoMinShares)})`
    : shares > maxShares ? `At most ${num(maxShares)} shares at this valuation`
    : null;
  const [payout, setPayout] = useState(co.dividendPayoutRatio);
  const { snap } = useWorld();
  const founderPct = co.totalShares > 0 ? co.founderShares / co.totalShares : 0;
  const floatFrac = co.totalShares > 0 ? co.floatShares / co.totalShares : 0;
  return (
    <Panel title="Equity">
      {co.isPublic ? (
        <>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2">
            <Stat label="Share price" value={fmtCr(co.sharePriceCr)} size="sm" />
            <Stat label="Market cap" value={fmtCr(co.marketCapCr)} size="sm" />
            <Stat label="Bid / ask" value={`${co.bestBidCr === null ? "—" : fmtCr(co.bestBidCr, { unit: false })} / ${co.bestAskCr === null ? "—" : fmtCr(co.bestAskCr, { unit: false })}`} size="sm" />
            <Stat label="Founder lockup" value={co.founderLockedUntilTick > snap.tick ? `until t${co.founderLockedUntilTick}` : "unlocked"} size="sm" tone={co.founderLockedUntilTick > snap.tick ? "gold" : "up"} />
          </div>
          <div className="mt-3">
            <div className="mb-1 text-[10px] uppercase tracking-wider text-muted">Cap table · {num(co.totalShares)} shares</div>
            <div className="flex h-2 w-full overflow-hidden rounded">
              <div className="bg-cyan" style={{ width: `${founderPct * 100}%` }} title="founder" />
              <div className="bg-gold" style={{ width: `${floatFrac * 100}%` }} title="float" />
              <div className="flex-1 bg-white/10" title="treasury / other" />
            </div>
            <div className="mt-1 flex justify-between font-mono text-[10px] tabular-nums text-muted">
              <span><span className="text-cyan-300">■</span> founder {fmtPct(founderPct, 0, false)} ({num(co.founderShares)})</span>
              <span><span className="text-gold">■</span> float {fmtPct(floatFrac, 0, false)} ({num(co.floatShares)})</span>
            </div>
          </div>
          <div className="mt-3 border-t border-edge pt-2">
            <Slider label="Dividend payout of epoch net profit" value={Math.round(payout * 100)} min={0} max={100} step={5} onChange={(v) => setPayout(v / 100)} format={(v) => `${v}%`} />
            <div className="mt-1 flex justify-end">
              <Button size="sm" tone="primary" disabled={busy || payout === co.dividendPayoutRatio} onClick={() => submit({ kind: "set_dividend_policy", payoutRatio: payout }, `Payout set to ${Math.round(payout * 100)}%`)}>Apply policy</Button>
            </div>
          </div>
        </>
      ) : (
        <>
          <p className="mb-2 text-[11px] text-muted">Go public to raise CR from investors. You keep (1 − float) of the shares; founder shares are locked for {x.ipoLockupTicks} ticks.</p>
          <div className="grid grid-cols-2 gap-2">
            <NumberInput label={`Total shares · max ${num(maxShares)}`} value={shares} min={x.ipoMinShares} max={maxShares} step={1000} onChange={(v) => setShares(Math.floor(v))} />
            <div>
              <Slider label="Float" value={Math.round(floatPct * 100)} min={x.ipoMinFloat * 100} max={x.ipoMaxFloat * 100} step={5} onChange={(v) => setFloatPct(v / 100)} format={(v) => `${v}%`} />
            </div>
          </div>
          <div className="mt-2 flex items-center justify-between">
            <span className="text-[11px] text-muted">≈ {fmtCr(Math.round(co.valuationCr * floatPct), { compact: true })} raised at valuation · listing fee {fmtCr(x.listingFeeCr)}</span>
            <Button tone="primary" disabled={busy || blocker !== null || shares < x.ipoMinShares} title={blocker ?? undefined} onClick={() => submit({ kind: "ipo", sharesTotal: shares, floatPct }, "IPO filed — shares list next tick", "dividend")}>IPO</Button>
          </div>
          {blocker && <div className="mt-1 text-[10px] text-amber-300">{blocker}</div>}
        </>
      )}
      <FormError text={error} />
    </Panel>
  );
}

export function CompanyTab() {
  const { you } = useWorld();
  if (!you) return <div className="p-4 text-xs text-muted">Sign in to run a company.</div>;
  const co = you.company;
  if (!co) return <div className="p-4 text-xs text-muted">You don&apos;t have a company yet — the server founds one on first join.</div>;
  return (
    <div className="flex flex-col gap-3 p-3">
      <Header co={co} />
      <Financials co={co} />
      <BuildingsList co={co} />
      <Inventory co={co} />
      <Logistics co={co} />
      <Equity co={co} />
      <Staking co={co} econ={you.econ} />
      {you.pending.length > 0 && (
        <div className="rounded border border-sky-500/30 bg-sky-500/10 px-2 py-1 text-[10px] text-sky-200">
          {you.pending.length} intent{you.pending.length > 1 ? "s" : ""} queued for next tick: {you.pending.map((p) => p.kind).join(", ")}
        </div>
      )}
    </div>
  );
}
