"use client";

import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronLeft, Minus, Plus, Search } from "lucide-react";
import type { Good, GoodCategory } from "@econ-sim/sim/goods";
import { GOODS } from "@econ-sim/sim/goods";
import { useWorld } from "../../../lib/world.ts";
import { useUi } from "../../../lib/store.ts";
import { fmtCr, fmtPct, num, signColor, titleCase } from "../../../lib/format.ts";
import { Badge, FormError } from "../../ui/index.tsx";
import { GoodIcon } from "../../ui/GoodIcon.tsx";
import { AreaChart } from "../../charts/AreaChart.tsx";
import { useIntent } from "../useIntent.ts";

/** Instant-market fee, both sides; the spread shown is ask/bid around last. */
const FEE = 0.003;
const MINT = "#3ddc97";

/* ─────────────── local controls (shared with ExchangeTab) ─────────────── */

/** Two-way BUY / SELL toggle: active buy = mint fill, active sell = rose fill. */
export function SideToggle<T extends string>({ value, onChange, buy, sell, labels = ["Buy", "Sell"] }: {
  value: T; onChange: (v: T) => void; buy: T; sell: T; labels?: [string, string];
}) {
  const base = "h-8 rounded text-[11px] font-extrabold uppercase tracking-[0.15em] transition-colors";
  return (
    <div className="grid grid-cols-2 gap-0.5 rounded-md bg-white/[0.06] p-0.5">
      <button type="button" onClick={() => onChange(buy)} className={`${base} ${value === buy ? "bg-[#3ddc97] text-black" : "text-slate-400 hover:text-slate-200"}`}>{labels[0]}</button>
      <button type="button" onClick={() => onChange(sell)} className={`${base} ${value === sell ? "bg-rose-500 text-white" : "text-slate-400 hover:text-slate-200"}`}>{labels[1]}</button>
    </div>
  );
}

/** Quick-pick quantity chips; each is disabled when it exceeds `max`. */
export function QuickChips({ presets, max, onPick, maxLabel = "max" }: { presets: number[]; max: number; onPick: (n: number) => void; maxLabel?: string }) {
  const cls = "h-7 min-w-8 rounded px-2 font-mono text-[11px] tabular-nums text-slate-300 transition-colors hover:bg-white/[0.08] hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-30";
  return (
    <div className="flex items-center gap-0.5">
      {presets.map((n) => <button key={n} type="button" disabled={n > max} onClick={() => onPick(n)} className={cls}>{num(n)}</button>)}
      <button type="button" disabled={max <= 0} onClick={() => onPick(max)} className={`${cls} font-sans uppercase tracking-wider`}>{maxLabel}</button>
    </div>
  );
}

/** − [qty] + stepper, mono, clamped to `min`. */
export function Stepper({ value, onChange, min = 1 }: { value: number; onChange: (v: number) => void; min?: number }) {
  const btn = "flex h-8 w-9 items-center justify-center rounded bg-white/[0.06] text-slate-200 transition-colors hover:bg-white/[0.12] disabled:opacity-30";
  return (
    <div className="flex items-center gap-1">
      <button type="button" className={btn} disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))} aria-label="decrease"><Minus size={13} /></button>
      <input
        type="number" inputMode="numeric" min={min} value={value}
        onChange={(e) => onChange(Math.max(min, Math.floor(Number(e.target.value) || min)))}
        className="h-8 w-16 rounded bg-black/40 text-center font-mono text-sm font-bold tabular-nums text-slate-100 outline-none ring-1 ring-white/[0.08] focus:ring-[#3ddc97]/60 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <button type="button" className={btn} onClick={() => onChange(value + 1)} aria-label="increase"><Plus size={13} /></button>
    </div>
  );
}

/* ─────────────────────────────── grid ─────────────────────────────── */

const CATS: { id: "all" | GoodCategory; label: string }[] = [
  { id: "all", label: "All items" }, { id: "raw", label: "Raw" }, { id: "intermediate", label: "Intermediate" }, { id: "finished", label: "Finished" },
];

function GridView({ onPick, active }: { onPick: (g: Good) => void; active: Good | null }) {
  const { snap } = useWorld();
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState<"all" | GoodCategory>("all");
  const q = query.trim().toLowerCase();
  const rows = snap.goods.filter((g) => (cat === "all" || GOODS[g.good].category === cat) && (!q || titleCase(g.good).toLowerCase().includes(q)));

  return (
    <>
      <div className="relative">
        <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
        <input
          value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search the market"
          className="h-9 w-full rounded-md border border-edge bg-black/30 pl-8 pr-2 text-xs text-slate-100 outline-none placeholder:text-muted focus:border-[#3ddc97]/50"
        />
      </div>
      <div className="relative">
        <select value={cat} onChange={(e) => setCat(e.target.value as "all" | GoodCategory)} className="h-9 w-full appearance-none rounded-md border border-edge bg-black/30 px-3 pr-8 text-xs font-semibold text-slate-200 outline-none focus:border-[#3ddc97]/50">
          {CATS.map((c) => <option key={c.id} value={c.id} className="bg-[#161618]">{c.label}</option>)}
        </select>
        <ChevronDown size={13} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted" />
      </div>
      <div className="grid grid-cols-5 gap-2">
        {rows.map((g) => (
          <button
            key={g.good} type="button" onClick={() => onPick(g.good)} title={titleCase(g.good)}
            className={`flex aspect-square flex-col items-center justify-center gap-0.5 rounded-md border border-edge bg-white/[0.04] p-1 transition-colors hover:bg-white/[0.08] ${active === g.good ? "ring-1 ring-[#3ddc97]" : ""}`}
          >
            <GoodIcon good={g.good} size={30} />
            <span className="w-full truncate text-center text-[9px] font-semibold leading-tight text-slate-200">{titleCase(g.good)}</span>
            <span className="font-mono text-[10px] leading-tight tabular-nums text-slate-100">{fmtCr(g.price, { unit: false })}</span>
            <span className={`font-mono text-[9px] leading-tight tabular-nums ${signColor(g.change24)}`}>{g.change24 < 0 ? "▼" : "▲"}{fmtPct(Math.abs(g.change24), 1, false)}</span>
          </button>
        ))}
        {rows.length === 0 && <div className="col-span-5 py-8 text-center text-[11px] text-muted">No goods match.</div>}
      </div>
    </>
  );
}

/* ─────────────────────────────── item ─────────────────────────────── */

function Tile({ label, value, tone, align = "left" }: { label: string; value: ReactNode; tone: "mint" | "amber" | "rose"; align?: "left" | "center" | "right" }) {
  const cls = { mint: "bg-[#3ddc97]/10 text-[#7dffb3]", amber: "bg-amber-500/10 text-amber-300", rose: "bg-rose-500/10 text-rose-300" }[tone];
  const al = { left: "text-left", center: "text-center", right: "text-right" }[align];
  return (
    <div className={`rounded-md px-3 py-2 ${cls} ${al}`}>
      <div className="text-[9px] font-semibold uppercase tracking-[0.15em] text-muted">{label}</div>
      <div className="font-mono text-lg font-bold leading-tight tabular-nums">{value}</div>
    </div>
  );
}

function ItemView({ good, onBack }: { good: Good; onBack: () => void }) {
  const { snap, you } = useWorld();
  const { submit, busy, error } = useIntent();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [qty, setQty] = useState(16);

  const row = snap.goods.find((g) => g.good === good);
  const candles = snap.history.goods[good] ?? [];
  const points = useMemo(() => candles.map((c) => ({ t: c.t, v: c.c / 100 })), [candles]);
  if (!row) return null;

  const inv = you?.company?.inventory[good] ?? 0;
  const ask = Math.round(row.price * (1 + FEE));
  const bid = Math.round(row.price * (1 - FEE));
  // (ask − bid) / mid on the unrounded quotes, so cent rounding on cheap goods doesn't wobble it
  const spread = (row.price * (1 + FEE) - row.price * (1 - FEE)) / row.price;
  const unit = side === "buy" ? ask : bid;
  // buys are capped by cash at the fee-inclusive price and by what the market maker holds; sells by inventory
  const maxBuy = you?.company ? Math.max(0, Math.min(row.float, Math.floor(you.company.cashCr / (row.price * (1 + FEE))))) : 0;
  const max = side === "buy" ? maxBuy : inv;
  const total = unit * qty;
  const disabled = !you?.company || busy || qty < 1 || qty > max;

  return (
    <>
      <button type="button" onClick={onBack} className="flex w-fit items-center gap-0.5 text-[11px] font-semibold text-muted transition-colors hover:text-slate-100">
        <ChevronLeft size={13} /> All items
      </button>

      <div className="flex items-center gap-3">
        <GoodIcon good={good} size={48} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-extrabold text-slate-100">{titleCase(good)}</div>
          <div className="truncate text-[10px] text-muted">{titleCase(GOODS[good].category)} · {num(inv)} held · ref {fmtCr(row.refPrice)}</div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Badge tone={row.change24 < 0 ? "down" : "up"}>{row.change24 < 0 ? "▼" : "▲"} {fmtPct(Math.abs(row.change24), 1, false)} · 24t</Badge>
          <span className="font-mono text-[10px] tabular-nums text-muted">{num(row.volume24)} u traded</span>
        </div>
      </div>

      <div className="grid grid-cols-[1.3fr_1fr_1.3fr] gap-1.5">
        <Tile label="Buy / ea" value={fmtCr(ask, { unit: false })} tone="mint" />
        <Tile label="Spread" value={fmtPct(spread, 1, false)} tone="amber" align="center" />
        <Tile label="Sell / ea" value={fmtCr(bid, { unit: false })} tone="rose" align="right" />
      </div>

      <div>
        <div className="mb-1 flex items-baseline justify-between text-[9px] font-semibold uppercase tracking-[0.15em] text-muted">
          <span>Price history · traded</span>
          <span className="font-mono normal-case tracking-normal">{num(row.volume24)} u / 24t</span>
        </div>
        <div className="rounded-md border border-edge bg-black/30">
          {points.length > 1
            ? <AreaChart points={points} height={150} color={MINT} />
            : <div className="flex h-[150px] items-center justify-center text-[11px] text-muted">Candles accumulate as ticks pass.</div>}
        </div>
      </div>

      <SideToggle value={side} onChange={setSide} buy="buy" sell="sell" />
      <div className="-mt-1 flex justify-between font-mono text-[10px] tabular-nums text-muted">
        <span>last {fmtCr(row.price)}</span>
        <span>MM float {num(row.float)} u</span>
      </div>

      <div className="rounded-md border border-edge bg-white/[0.03] p-3">
        <div className="text-[13px] font-extrabold text-slate-100">{side === "buy" ? "Instant buy" : "Instant sell"}</div>
        <div className={`font-mono text-[11px] tabular-nums ${side === "buy" ? "text-[#7dffb3]" : "text-rose-300"}`}>{fmtCr(unit)} / ea</div>
        <div className="mt-3 flex items-center justify-between gap-2">
          <Stepper value={qty} onChange={setQty} />
          <QuickChips presets={[16, 64, 256]} max={max} onPick={setQty} />
        </div>
        <div className="mt-3 flex items-end justify-between">
          <span className="text-[11px] text-muted">{side === "buy" ? "Total cost" : "You receive"}</span>
          <span className="font-mono text-xl font-bold tabular-nums text-slate-100">{fmtCr(total)}</span>
        </div>
        <button
          type="button" disabled={disabled}
          onClick={() => side === "buy"
            ? submit({ kind: "buy_good", good, qty }, `Bought ${num(qty)} ${titleCase(good)}`)
            : submit({ kind: "sell_good", good, qty }, `Sold ${num(qty)} ${titleCase(good)}`)}
          className={`mt-3 h-10 w-full rounded-md text-sm font-extrabold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${side === "buy" ? "bg-[#3ddc97] text-black hover:bg-[#7dffb3]" : "bg-rose-500 text-white hover:bg-rose-400"}`}
        >
          {side === "buy" ? "Buy" : "Sell"} {num(qty)} now
        </button>
        {!you?.company && <div className="mt-1.5 text-center text-[10px] text-muted">Found a company to trade goods.</div>}
        {you?.company && qty > max && <div className="mt-1.5 text-center text-[10px] text-amber-300">{side === "buy" ? (max === row.float ? `Market holds only ${num(max)} u` : `You can afford ${num(max)} u`) : `You hold ${num(max)} u`}</div>}
        <FormError text={error} />
        <p className="mt-2 text-[10px] text-muted">Market fee {(FEE * 100).toFixed(1)}% to treasury. Sell policy per good is set in the Company tab.</p>
      </div>
    </>
  );
}

/* ─────────────────────────────── tab ─────────────────────────────── */

export function MarketTab() {
  const { snap } = useWorld();
  const selectedGood = useUi((s) => s.selectedGood);
  const selectGood = useUi((s) => s.selectGood);
  const good = snap.goods.find((g) => g.good === selectedGood)?.good ?? null;
  // the last opened item keeps its ring in the grid after "← All items"
  const [last, setLast] = useState<Good | null>(null);

  return (
    <div className="flex flex-col gap-3 p-3">
      <header className="flex items-baseline justify-between">
        <h2 className="text-[13px] font-extrabold tracking-wide text-slate-100">EXCHANGE</h2>
        <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted">Market</span>
      </header>
      {good ? <ItemView key={good} good={good} onBack={() => { setLast(good); selectGood(null); }} /> : <GridView onPick={selectGood} active={last} />}
    </div>
  );
}
