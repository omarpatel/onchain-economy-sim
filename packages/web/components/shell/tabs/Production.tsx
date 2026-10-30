"use client";

import { ArrowRight, DoorOpen, LogOut, Trash2 } from "lucide-react";
import { CONFIG } from "@econ-sim/sim/config";
import { RECIPES, type BuildingType, type Good } from "@econ-sim/sim/goods";
import type { CompanyView } from "@econ-sim/sim/protocol";
import type { EconomySnapshot } from "@econ-sim/sim/snapshot";
import { useUi } from "../../../lib/store.ts";
import { fmtCr, fmtPct, num, titleCase } from "../../../lib/format.ts";
import { BUILDING_STYLE, RES_LABEL } from "../../three/world-style.ts";
import { GoodIcon } from "../../ui/GoodIcon.tsx";
import { Badge, Bar, Button, Stat } from "../../ui/index.tsx";
import { useIntent } from "../useIntent.ts";

export type OwnBuilding = CompanyView["buildings"][number];

/** Recipe legs as `[good, qty per unit]`, typed once instead of re-casting `Object.entries` at every call site. */
export function legs(m: Partial<Record<Good, number>>): [Good, number][] {
  return Object.entries(m) as [Good, number][];
}

/** Current market price per good, CR minor. */
export function priceMap(snap: EconomySnapshot): Partial<Record<Good, number>> {
  const out: Partial<Record<Good, number>> = {};
  for (const g of snap.goods) out[g.good] = g.price;
  return out;
}

/**
 * Per-unit margin at today's prices: output value minus inputs, energy and
 * labor amortized over full throughput. Mirrors the engine's average-cost
 * restart test (haul distance excluded), so a negative value explains an idle plant.
 */
export function unitMargin(type: BuildingType, prices: Partial<Record<Good, number>>): number {
  const r = RECIPES[type];
  let v = 0;
  for (const [g, q] of legs(r.outputs)) v += (prices[g] ?? 0) * q;
  for (const [g, q] of legs(r.inputs)) v -= (prices[g] ?? 0) * q;
  return v - r.energyCr - r.laborCr / r.baseThroughput;
}

function Chip({ good, qty, stock }: { good: Good; qty: number; stock?: number }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 rounded-md border border-edge bg-white/[0.04] py-1 pl-1 pr-2" title={titleCase(good)}>
      <GoodIcon good={good} size={26} />
      <div className="min-w-0 leading-tight">
        <div className="truncate text-[11px] font-semibold text-slate-100">{qty > 1 ? `${qty}× ` : ""}{titleCase(good)}</div>
        {stock !== undefined && <div className="font-mono text-[10px] tabular-nums text-muted">{num(stock)} in stock</div>}
      </div>
    </div>
  );
}

/** `inputs → outputs` chips for a building type; extractors show the deposit they mine as the input. */
export function RecipeFlow({ type, inventory }: { type: BuildingType; inventory?: Record<Good, number> }) {
  const r = RECIPES[type];
  const ins = legs(r.inputs);
  return (
    <div className="flex items-center gap-2">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {ins.length > 0
          ? ins.map(([g, q]) => <Chip key={g} good={g} qty={q} stock={inventory?.[g]} />)
          : <div className="rounded-md border border-dashed border-edge px-2 py-2 text-[11px] text-muted">{r.requiresResource ? `${RES_LABEL[r.requiresResource]} deposit` : "No inputs"}</div>}
      </div>
      <ArrowRight size={16} className="shrink-0 text-mint-300" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {legs(r.outputs).map(([g, q]) => <Chip key={g} good={g} qty={q} stock={inventory?.[g]} />)}
      </div>
    </div>
  );
}

/** Why a live plant made nothing last tick, in the engine's own order of checks. */
function idleReason(b: OwnBuilding, co: CompanyView, margin: number): string {
  const r = RECIPES[b.type];
  if (r.requiresResource && b.richness <= 0) return "No deposit under this tile.";
  const full = legs(r.outputs).find(([g, q]) => co.inventory[g] > q * r.baseThroughput * CONFIG.company.maxStockTicks);
  if (full) return `Warehouse full of ${titleCase(full[0])} — sell it or switch it to auto-sell.`;
  if (margin <= 0) return "Output price doesn't cover costs right now; it restarts when the spread recovers.";
  return "Short of inputs or cash to buy them this tick.";
}

/**
 * The player's own building: recipe with live stock, throughput, margin,
 * per-good sell policy and the "Look inside" cutaway toggle.
 */
export function ProductionCard({ tileId, b, co, snap }: { tileId: string; b: OwnBuilding; co: CompanyView; snap: EconomySnapshot }) {
  const interior = useUi((s) => s.interiorTile);
  const setInterior = useUi((s) => s.setInterior);
  const selectGood = useUi((s) => s.selectGood);
  const setTab = useUi((s) => s.setTab);
  const { submit, busy } = useIntent();
  const r = RECIPES[b.type];
  const style = BUILDING_STYLE[b.type];
  const prices = priceMap(snap);
  const margin = unitMargin(b.type, prices);
  const unitsPerTick = b.utilization * r.baseThroughput;
  const inside = interior === tileId;
  const progress = b.live ? 1 : Math.max(0, Math.min(1, 1 - (b.liveAtTick - snap.tick) / r.buildTicks));
  const goods = [...legs(r.inputs), ...legs(r.outputs)];
  const isOutput = (g: Good) => g in r.outputs;

  return (
    <section className="glass rounded-lg p-3 ring-1 ring-mint/20">
      <header className="mb-3 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-block h-3 w-3 shrink-0 rounded-sm" style={{ background: style.color }} />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-slate-100">{style.label}</div>
            <div className="label">Your production · ({b.x}, {b.y})</div>
          </div>
        </div>
        {b.live
          ? <Badge tone={b.utilization > 0 ? "up" : "down"}>{b.utilization > 0 ? "running" : "idle"}</Badge>
          : <Badge tone="gold">building</Badge>}
      </header>

      <RecipeFlow type={b.type} inventory={co.inventory} />

      <div className="mt-3">
        <div className="mb-1 flex items-center justify-between text-[11px]">
          <span className="text-muted">{b.live ? "Utilization" : "Construction"}</span>
          <span className="font-mono tabular-nums text-slate-100">
            {b.live ? `${fmtPct(b.utilization, 0, false)} · ${num(unitsPerTick, 1)}/${num(r.baseThroughput)} per tick` : `${fmtPct(progress, 0, false)} · live t${b.liveAtTick}`}
          </span>
        </div>
        <Bar value={b.live ? b.utilization : progress} tone={!b.live ? "gold" : b.utilization > 0.5 ? "up" : b.utilization > 0 ? "gold" : "down"} />
        {b.live && b.utilization === 0 && <p className="mt-1.5 text-[11px] text-amber-300">{idleReason(b, co, margin)}</p>}
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2">
        <Stat label="Unit margin" value={fmtCr(margin, { sign: true })} size="sm" tone={margin > 0 ? "up" : "down"} sub="at spot" />
        <Stat label="Per tick" value={fmtCr(Math.round(margin * unitsPerTick), { sign: true })} size="sm" tone={margin * unitsPerTick > 0 ? "up" : margin * unitsPerTick < 0 ? "down" : "default"} sub="≈ gross" />
        {r.requiresResource
          ? <Stat label="Richness" value={b.richness.toFixed(2)} size="sm" sub={RES_LABEL[r.requiresResource]} />
          : <Stat label="Labor" value={fmtCr(r.laborCr, { digits: 0 })} size="sm" sub="per tick max" />}
      </div>

      <div className="mt-3">
        <div className="label mb-1">Inventory</div>
        {goods.map(([g]) => {
          const hold = co.sellPolicy[g] === "hold";
          return (
            <div key={g} className="flex items-center gap-2 border-b border-edge/60 py-1 text-[11px] last:border-0">
              <GoodIcon good={g} size={18} />
              <button className="flex-1 truncate text-left text-slate-100 hover:text-mint-300" onClick={() => { selectGood(g); setTab("market"); }} title="Open in Market">
                {titleCase(g)} <span className="text-muted">· {isOutput(g) ? "output" : "input"}</span>
              </button>
              <span className="font-mono tabular-nums text-muted">{fmtCr(prices[g] ?? 0)}</span>
              <span className="w-12 text-right font-mono tabular-nums text-slate-100">{num(co.inventory[g])}</span>
              {isOutput(g) && (
                <button
                  disabled={busy}
                  title={hold ? "Holding: surplus stays in inventory. Click to auto-sell." : "Auto: surplus is sold each tick. Click to hold."}
                  onClick={() => submit({ kind: "set_sell_policy", good: g, mode: hold ? "auto" : "hold" }, `${titleCase(g)}: ${hold ? "auto-sell" : "hold"}`)}
                  className={`w-11 rounded border py-px text-[9px] font-bold uppercase ${hold ? "border-amber-500/40 text-amber-300" : "border-mint/40 text-mint-300"}`}
                >
                  {hold ? "hold" : "auto"}
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex gap-2">
        {b.live && (
          <Button tone={inside ? "default" : "primary"} active={inside} className="h-9 flex-1 text-[13px]" onClick={() => setInterior(inside ? null : tileId)}>
            {inside ? <><LogOut size={14} /> Exit interior</> : <><DoorOpen size={14} /> Look inside</>}
          </Button>
        )}
        <Button tone="ghost" className="h-9 text-rose-300 hover:!bg-rose-500/10" disabled={busy} title="Demolish this building" onClick={() => submit({ kind: "demolish", buildingId: b.id }, "Building demolished", "place")}>
          <Trash2 size={13} />
        </Button>
      </div>
    </section>
  );
}
