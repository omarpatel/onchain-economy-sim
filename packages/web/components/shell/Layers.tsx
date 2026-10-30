"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Coins, Gauge, Gem, Globe2, Landmark, Truck, Waypoints } from "lucide-react";
import { LAYERS, useUi, type Layer } from "../../lib/store.ts";
import { fmtCr } from "../../lib/format.ts";

const ICON: Record<Layer, ReactNode> = {
  world: <Globe2 size={13} />,
  ownership: <Landmark size={13} />,
  price: <Coins size={13} />,
  richness: <Gem size={13} />,
  utilization: <Gauge size={13} />,
  traffic: <Truck size={13} />,
  logistics: <Waypoints size={13} />,
};

/** Right-side layer picker (glass menu of icon rows) plus legend and "middle of the screen" stats for heat layers. */
export function Layers() {
  const layer = useUi((s) => s.layer);
  const setLayer = useUi((s) => s.setLayer);
  const stats = useUi((s) => s.viewStats);
  const [open, setOpen] = useState(true);
  // the menu covers too much of a phone screen: start collapsed there
  useEffect(() => { if (!window.matchMedia("(min-width: 768px)").matches) setOpen(false); }, []);
  const active = LAYERS.find((l) => l.id === layer) ?? LAYERS[0];
  const heat = layer !== "world";

  return (
    <>
      {heat && (
        <div className="glass pointer-events-none absolute left-3 top-3 z-30 flex h-7 items-center gap-2 whitespace-nowrap !rounded-full px-3 text-[11px] md:left-1/2 md:-translate-x-1/2">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
          <span className="font-bold uppercase tracking-[0.12em] text-amber-300">Layer · {active.label}</span>
          <span className="hidden text-slate-300 md:inline">{active.hint}</span>
          <span className="hidden text-muted md:inline">Esc exits.</span>
        </div>
      )}

      <div className="absolute right-3 top-3 z-30 flex items-start gap-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="glass label flex h-7 items-center gap-1 rounded-md px-2.5 !text-slate-200 transition-colors hover:bg-white/[0.08]"
        >
          Layers {open ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
        </button>

        {open && (
          <div className="glass w-[200px] rounded-lg py-1">
            {LAYERS.map((l) => {
              const on = l.id === layer;
              return (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => setLayer(l.id)}
                  aria-pressed={on}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[10px] font-bold uppercase tracking-[0.12em] transition-colors ${on ? "bg-mint/10 text-mint-300" : "text-slate-200 hover:bg-white/[0.06]"}`}
                >
                  <span className={on ? "text-mint-300" : "text-muted"}>{ICON[l.id]}</span>
                  {l.label}
                </button>
              );
            })}

            {heat && (
              <div className="mt-1 border-t border-edge px-3 pb-2 pt-2">
                <div className="label">{active.label}</div>
                <p className="mt-0.5 text-[11px] leading-snug text-slate-300">{active.hint}</p>
                {active.legend && (
                  <div className="mt-2">
                    <div className="h-1.5 w-full rounded-full" style={{ background: "linear-gradient(90deg,#3ddc97,#facc15,#ef4444)" }} />
                    <div className="mt-1 flex justify-between text-[9px] uppercase tracking-wider text-muted">
                      <span>{active.legend[0]}</span>
                      <span>{active.legend[1]}</span>
                    </div>
                  </div>
                )}

                <div className="label mt-3 flex items-center gap-1.5 !text-slate-200">
                  <span className="h-1.5 w-1.5 rounded-full bg-mint" />
                  Middle of the screen
                </div>
                <dl className="mt-1.5 flex flex-col gap-1.5">
                  <Row label="Land price" value={fmtCr(stats.priceCr)} hot={layer === "price"} />
                  <Row label="Richness" value={stats.richness.toFixed(2)} hot={layer === "richness"} />
                  <Row label="Utilization" value={`${Math.round(stats.utilization * 100)}%`} sub={`${stats.buildings} live building${stats.buildings === 1 ? "" : "s"} in view`} hot={layer === "utilization"} />
                  <Row label="Traffic" value={`${Math.round(stats.traffic * 100)}%`} hot={layer === "traffic"} />
                  <Row label="Tiles in view" value={String(stats.tiles)} />
                </dl>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

function Row({ label, value, sub, hot }: { label: string; value: string; sub?: string; hot?: boolean }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <dt className={`text-[11px] ${hot ? "font-semibold text-mint-300" : "text-slate-300"}`}>{label}</dt>
        <dd className={`font-mono text-[11px] font-semibold tabular-nums ${hot ? "text-mint-300" : "text-white"}`}>{value}</dd>
      </div>
      {sub && <div className="text-[10px] text-muted">{sub}</div>}
    </div>
  );
}
