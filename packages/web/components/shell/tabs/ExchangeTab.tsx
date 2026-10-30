"use client";

import { useMemo, useState } from "react";
import type { EconomySnapshot } from "@econ-sim/sim/snapshot";
import type { Side } from "@econ-sim/sim/exchange";
import { useWorld } from "../../../lib/world.ts";
import { useUi } from "../../../lib/store.ts";
import { fmtCr, fmtPct, num, shortId, signColor } from "../../../lib/format.ts";
import { companyColor } from "../../../lib/palette.ts";
import { Badge, Button, FormError, NumberInput, Panel, Sparkline, Table } from "../../ui/index.tsx";
import { CandleChart } from "../../charts/CandleChart.tsx";
import { useIntent } from "../useIntent.ts";
import { QuickChips, SideToggle } from "./MarketTab.tsx";

/** Exchange fee on filled orders. */
const FEE = 0.002;

type CompanyRow = EconomySnapshot["companies"][number];

/** Top-5 bid/ask ladder with proportional depth bars. */
function DepthLadder({ book }: { book: CompanyRow["book"] }) {
  const max = Math.max(1, ...book.bids.map((l) => l.qty), ...book.asks.map((l) => l.qty));
  const rows = Array.from({ length: 5 }, (_, i) => ({ bid: book.bids[i], ask: book.asks[i] }));
  return (
    <div className="grid grid-cols-2 gap-px text-[11px] font-mono tabular-nums">
      <div className="text-[9px] uppercase tracking-wider text-muted">bids</div>
      <div className="text-right text-[9px] uppercase tracking-wider text-muted">asks</div>
      {rows.map((r, i) => (
        <div key={i} className="contents">
          <div className="relative h-5 overflow-hidden rounded-l">
            {r.bid && <div className="absolute inset-y-0 right-0 bg-emerald-500/15" style={{ width: `${(r.bid.qty / max) * 100}%` }} />}
            <div className="relative flex h-full items-center justify-between px-1.5">
              <span className="text-muted">{r.bid ? num(r.bid.qty) : ""}</span>
              <span className="text-emerald-300">{r.bid ? fmtCr(r.bid.price, { unit: false }) : "—"}</span>
            </div>
          </div>
          <div className="relative h-5 overflow-hidden rounded-r">
            {r.ask && <div className="absolute inset-y-0 left-0 bg-rose-500/15" style={{ width: `${(r.ask.qty / max) * 100}%` }} />}
            <div className="relative flex h-full items-center justify-between px-1.5">
              <span className="text-rose-300">{r.ask ? fmtCr(r.ask.price, { unit: false }) : "—"}</span>
              <span className="text-muted">{r.ask ? num(r.ask.qty) : ""}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** 24-candle share price change for a company, 0 until there is history. */
function change24(sharePrice: number, candles: { c: number }[]): number {
  return candles.length > 1 ? sharePrice / candles[Math.max(0, candles.length - 25)].c - 1 : 0;
}

function ChangeBadge({ value }: { value: number }) {
  const cls = value < 0 ? "bg-rose-500/10 text-rose-300" : value > 0 ? "bg-[#3ddc97]/10 text-[#7dffb3]" : "bg-white/5 text-slate-400";
  return <span className={`inline-block rounded px-1 py-px font-mono text-[10px] tabular-nums ${cls}`}>{value < 0 ? "▼" : "▲"}{fmtPct(Math.abs(value), 1, false)}</span>;
}

export function ExchangeTab() {
  const { snap, you } = useWorld();
  const selectedCompany = useUi((s) => s.selectedCompany);
  const selectCompany = useUi((s) => s.selectCompany);
  const { submit, busy, error } = useIntent();
  const [side, setSide] = useState<Side>("bid");
  const [price, setPrice] = useState(0);
  const [qty, setQty] = useState(10);

  const listed = useMemo(() => snap.companies.filter((c) => c.public).sort((a, z) => z.marketCap - a.marketCap), [snap.companies]);
  const co = listed.find((c) => c.id === selectedCompany) ?? listed[0];
  const candles = co ? snap.history.shares[co.id] ?? [] : [];
  const holding = co ? you?.holdings.find((h) => h.companyId === co.id) : undefined;
  const myOrders = co ? (you?.orders ?? []).filter((o) => o.companyId === co.id) : [];
  const change = co ? change24(co.sharePrice, candles) : 0;
  // the book checks bids against CR not already reserved by your resting bids (the fee comes out of the seller's proceeds),
  // and asks against shares not already locked in your resting asks
  const priceMinor = Math.round(price * 100);
  const allOrders = you?.orders ?? [];
  const freeCr = (you?.cashCr ?? 0) - allOrders.reduce((s, o) => s + (o.side === "bid" ? o.priceCr * o.qty : 0), 0);
  const freeShares = (holding?.shares ?? 0) - myOrders.reduce((s, o) => s + (o.side === "ask" ? o.qty : 0), 0);
  const maxQty = side === "bid" ? (priceMinor > 0 ? Math.max(0, Math.floor(freeCr / priceMinor)) : 0) : Math.max(0, freeShares);
  const total = priceMinor * qty;

  const pick = (c: CompanyRow) => { selectCompany(c.id); setPrice(Math.round(c.sharePrice) / 100); };

  return (
    <div className="flex flex-col gap-3 p-3">
      <header className="flex items-baseline justify-between">
        <h2 className="text-[13px] font-extrabold tracking-wide text-slate-100">EXCHANGE</h2>
        <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted">Shares</span>
      </header>

      <div>
        <div className="mb-1 text-[9px] font-semibold uppercase tracking-[0.15em] text-muted">Listed · {listed.length}</div>
        <div className="flex flex-col gap-1">
          {listed.map((c) => {
            const hist = snap.history.shares[c.id] ?? [];
            const on = c.id === co?.id;
            return (
              <button
                key={c.id} type="button" onClick={() => pick(c)}
                className={`grid grid-cols-[auto_1fr_auto_auto] items-center gap-2 rounded-md border border-l-2 px-2 py-1.5 text-left transition-colors ${on ? "border-edge border-l-[#3ddc97] bg-[#3ddc97]/[0.06] ring-1 ring-[#3ddc97]/40" : "border-edge border-l-transparent bg-white/[0.03] hover:bg-white/[0.07]"}`}
              >
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: companyColor(c.id) }} />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 truncate text-xs font-bold text-slate-100">{c.name}{c.onChain && <Badge tone="up">chain</Badge>}</span>
                  <span className="block text-[9px] uppercase tracking-wider text-muted">mcap <span className="font-mono normal-case tracking-normal text-slate-300">{fmtCr(c.marketCap, { compact: true, unit: false })}</span></span>
                </span>
                <Sparkline values={hist.slice(-48).map((k) => k.c)} width={52} height={18} />
                <span className="flex flex-col items-end gap-0.5">
                  <span className="font-mono text-xs font-bold tabular-nums text-slate-100">{fmtCr(c.sharePrice, { unit: false })}</span>
                  <ChangeBadge value={change24(c.sharePrice, hist)} />
                </span>
              </button>
            );
          })}
          {listed.length === 0 && <div className="rounded-md border border-edge bg-white/[0.03] py-6 text-center text-[11px] text-muted">No company has gone public yet.</div>}
        </div>
      </div>

      {co && (
        <>
          <Panel
            title={<span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: companyColor(co.id) }} />{co.name}</span>}
            action={<span className={`font-mono text-[11px] tabular-nums ${signColor(change)}`}>{fmtPct(change)} / 24t</span>}
          >
            <div className="mb-2 grid grid-cols-3 gap-2 text-[11px]">
              <div><div className="text-[9px] uppercase tracking-wider text-muted">Last</div><div className="font-mono text-base font-bold tabular-nums text-slate-100">{fmtCr(co.sharePrice)}</div></div>
              <div><div className="text-[9px] uppercase tracking-wider text-muted">Float / total</div><div className="font-mono tabular-nums">{num(co.floatShares)} / {num(co.totalShares)}</div></div>
              <div><div className="text-[9px] uppercase tracking-wider text-muted">Valuation</div><div className="font-mono tabular-nums">{fmtCr(co.valuation, { compact: true })}</div></div>
            </div>
            {candles.length > 1 ? <CandleChart candles={candles} height={170} /> : <div className="py-6 text-center text-[11px] text-muted">No trades yet.</div>}
          </Panel>

          <Panel title="Order book">
            <DepthLadder book={co.book} />
            <div className="mt-2 text-[10px] uppercase tracking-wider text-muted">Last trades</div>
            <div className="mt-1 grid grid-cols-5 gap-x-2 font-mono text-[11px] tabular-nums">
              {co.lastTrades.slice(0, 10).map((t, i) => (
                <div key={i} className="contents">
                  <span className="text-muted">t{t.tick}</span>
                  <span className="col-span-2 text-right text-slate-100">{fmtCr(t.price, { unit: false })}</span>
                  <span className="col-span-2 text-right text-muted">{num(t.qty)} sh</span>
                </div>
              ))}
              {co.lastTrades.length === 0 && <span className="col-span-5 text-muted">—</span>}
            </div>
          </Panel>

          <div className="rounded-md border border-edge bg-white/[0.03] p-3">
            <div className="mb-2 flex items-baseline justify-between">
              <span className="text-[13px] font-extrabold text-slate-100">Place order</span>
              {holding && <span className="font-mono text-[10px] tabular-nums text-muted">you hold {num(holding.shares)} sh</span>}
            </div>
            <SideToggle value={side} onChange={setSide} buy="bid" sell="ask" />
            <div className="mt-2 flex items-center justify-between gap-1 text-[10px] text-muted">
              <span>Fill from book</span>
              <span className="flex gap-1">
                {co.book.bids[0] && <Button size="sm" tone="ghost" onClick={() => setPrice(co.book.bids[0].price / 100)}>bid {fmtCr(co.book.bids[0].price, { unit: false })}</Button>}
                {co.book.asks[0] && <Button size="sm" tone="ghost" onClick={() => setPrice(co.book.asks[0].price / 100)}>ask {fmtCr(co.book.asks[0].price, { unit: false })}</Button>}
                {!co.book.bids[0] && !co.book.asks[0] && <span>empty book</span>}
              </span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <NumberInput label="Price" value={price} min={0.01} step={0.01} onChange={setPrice} suffix="CR" />
              <NumberInput label={`Shares · max ${num(maxQty)}`} value={qty} min={1} max={maxQty} onChange={(v) => setQty(Math.max(1, Math.floor(v)))} suffix="sh" />
            </div>
            <div className="mt-1.5 flex justify-end">
              <QuickChips presets={[10, 50, 100]} max={maxQty} onPick={setQty} />
            </div>
            <div className="mt-2 flex items-end justify-between">
              <span className="text-[11px] text-muted">{side === "bid" ? "Total cost" : "You receive"} <span className="text-[10px]">· fee {(FEE * 100).toFixed(1)}%</span></span>
              <span className="font-mono text-xl font-bold tabular-nums text-slate-100">{fmtCr(total)}</span>
            </div>
            <button
              type="button" disabled={!you || busy || price <= 0 || qty <= 0 || qty > maxQty}
              onClick={() => submit({ kind: "place_order", companyId: co.id, side, priceCr: priceMinor, qty }, `${side === "bid" ? "Bid" : "Ask"} placed: ${qty} ${co.name} @ ${fmtCr(priceMinor)}`)}
              className={`mt-3 h-10 w-full rounded-md text-sm font-extrabold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${side === "bid" ? "bg-[#3ddc97] text-black hover:bg-[#7dffb3]" : "bg-rose-500 text-white hover:bg-rose-400"}`}
            >
              {side === "bid" ? "Place bid" : "Place ask"}
            </button>
            <FormError text={error} />
            {myOrders.length > 0 && (
              <div className="mt-3 border-t border-edge pt-2">
                <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-muted">
                  <span>Your open orders</span>
                  <Button size="sm" tone="ghost" disabled={busy} onClick={() => submit({ kind: "cancel_orders", companyId: co.id }, "Orders cancelled")}>cancel all</Button>
                </div>
                {myOrders.map((o) => (
                  <div key={o.id} className="flex justify-between font-mono text-[11px] tabular-nums">
                    <span className={o.side === "bid" ? "text-[#7dffb3]" : "text-rose-300"}>{o.side === "bid" ? "BID" : "ASK"} #{o.id}</span>
                    <span>{num(o.qty)} @ {fmtCr(o.priceCr)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {you && you.holdings.length > 0 && (
        <Panel title="Your portfolio" pad={false}>
          <Table
            dense
            rows={you.holdings}
            rowKey={(h) => h.companyId}
            onRow={(h) => selectCompany(h.companyId)}
            columns={[
              { key: "co", header: "Company", cell: (h) => snap.companies.find((c) => c.id === h.companyId)?.name ?? shortId(h.companyId) },
              { key: "sh", header: "Shares", align: "right", cell: (h) => num(h.shares) },
              { key: "val", header: "Value", align: "right", cell: (h) => fmtCr(h.shares * h.lastPriceCr, { compact: true }) },
            ]}
          />
        </Panel>
      )}
    </div>
  );
}
