"use client";

import { useEffect } from "react";
import { Crosshair, Factory, Footprints, Hammer, Map as MapIcon, Pickaxe, Volume2, VolumeX, Workflow, X } from "lucide-react";
import { ALL_BUILDINGS, RECIPES, type BuildingType } from "@econ-sim/sim/goods";
import { useUi } from "../../lib/store.ts";
import { useWorld } from "../../lib/world.ts";
import { fmtCr, titleCase } from "../../lib/format.ts";
import { BUILDING_STYLE, RES_LABEL } from "../three/world-style.ts";
import { IconButton, Kbd } from "../ui/index.tsx";

const GROUPS: { title: string; icon: React.ReactNode; types: BuildingType[] }[] = [
  { title: "Extractors", icon: <Pickaxe size={11} />, types: ["mine", "coal_mine", "oil_well", "farm", "forestry", "waterworks"] },
  { title: "Processors", icon: <Workflow size={11} />, types: ["smelter", "refinery", "sawmill", "mill"] },
  { title: "Factories", icon: <Factory size={11} />, types: ["machine_factory", "toolworks", "bakery", "furniture_factory"] },
];

/** Build palette: pick a type, then click a tile; the ghost shows validity. */
export function BuildMenu({ onClose, onPick }: { onClose: () => void; onPick: () => void }) {
  const { you } = useWorld();
  const buildMode = useUi((s) => s.buildMode);
  const setBuildMode = useUi((s) => s.setBuildMode);
  const cash = you?.company?.cashCr ?? 0;
  return (
    <div className="glass glass-ring max-h-[60vh] w-[min(560px,calc(100vw-24px))] animate-rise overflow-y-auto !rounded-2xl p-3 shadow-float" role="dialog" aria-label="Build menu">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-mint/15 text-mint-300 ring-1 ring-mint/30"><Hammer size={12} /></span>
          <span className="text-sm font-extrabold text-white">Build</span>
          <span className="text-[11px] text-muted max-sm:hidden">pick a type, then click a tile</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1 text-[10px] text-muted max-sm:hidden"><Kbd>Esc</Kbd> close</span>
          <button onClick={onClose} className="flex h-6 w-6 items-center justify-center rounded-full text-muted transition-colors hover:bg-white/10 hover:text-white" aria-label="close"><X size={13} /></button>
        </div>
      </div>
      {!you?.company && <div className="mb-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-200">You need a company to build.</div>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {GROUPS.map((g) => (
          <div key={g.title}>
            <div className="label mb-1.5 flex items-center gap-1">{g.icon}{g.title}</div>
            <div className="flex flex-col gap-1">
              {g.types.map((t) => {
                const r = RECIPES[t];
                const affordable = cash >= r.buildCostCr;
                const on = buildMode === t;
                return (
                  <button
                    key={t}
                    onClick={() => { setBuildMode(on ? null : t); if (!on) onPick(); }}
                    className={`group flex items-center justify-between gap-2 rounded-lg border px-2 py-1.5 text-left text-[11px] transition-[background-color,border-color,transform,box-shadow] duration-150 ease-out hover:-translate-y-px active:translate-y-0 active:scale-[.98] ${on ? "border-mint/60 bg-mint/15 shadow-glow-mint" : "border-white/[0.07] bg-white/[0.03] hover:border-white/15 hover:bg-white/[0.08] hover:shadow-lift"} ${affordable ? "" : "opacity-50"}`}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        className="inline-block h-5 w-5 shrink-0 rounded-md shadow-[inset_0_1px_0_rgba(255,255,255,.35),inset_0_-2px_0_rgba(0,0,0,.25)] ring-1 ring-black/40 transition-transform duration-200 ease-spring group-hover:scale-110"
                        style={{ background: BUILDING_STYLE[t].color }}
                      />
                      <span className="min-w-0">
                        <span className="block truncate font-bold text-slate-100">{BUILDING_STYLE[t].label}</span>
                        <span className="block truncate text-[9px] text-muted">
                          {r.requiresResource ? `on ${RES_LABEL[r.requiresResource].toLowerCase()}` : `${Object.keys(r.inputs).map(titleCase).join(" + ")} → ${Object.keys(r.outputs).map(titleCase).join(", ")}`}
                        </span>
                      </span>
                    </span>
                    <span className={`shrink-0 font-mono text-[10px] font-semibold tabular-nums ${affordable ? "text-slate-300" : "text-rose-300"}`}>{fmtCr(r.buildCostCr, { compact: true })}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Bottom-center dock: Build · Walk · [avatar → HQ + Company] · HQ · Map · Sound; H and M are dock-only hotkeys (B lives in PlayShell). */
export function Hotbar() {
  const { you, snap } = useWorld();
  const menu = useUi((s) => s.buildMenu);
  const buildMode = useUi((s) => s.buildMode);
  const walkMode = useUi((s) => s.walkMode);
  const minimap = useUi((s) => s.minimap);
  const soundOn = useUi((s) => s.soundOn);
  const ui = useUi.getState;

  const focusHq = () => {
    const hub = you?.company?.hubTileId;
    const tile = hub ? snap.world.tiles.find((t) => t.id === hub) : snap.world.tiles.find((t) => t.hq);
    if (!tile) return;
    ui().selectTile(tile.id);
    ui().selectCompany(tile.owner);
    ui().focusTile(tile.x, tile.y);
  };
  const focusHqRef = { current: focusHq };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || useUi.getState().walkMode) return;
      if (e.code === "KeyH") focusHqRef.current();
      else if (e.code === "KeyM") useUi.getState().toggleMinimap();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="pointer-events-none absolute bottom-3 left-1/2 z-30 flex -translate-x-1/2 flex-col items-center gap-2">
      {menu && <div className="pointer-events-auto"><BuildMenu onClose={() => { ui().setBuildMenu(false); ui().setBuildMode(null); }} onPick={() => ui().setBuildMenu(false)} /></div>}
      {buildMode && !menu && (
        <div className="glass glass-ring pointer-events-auto flex animate-rise items-center gap-2 !rounded-full py-1 pl-2 pr-3 text-[11px] font-semibold text-slate-100 shadow-float">
          <span className="inline-block h-3.5 w-3.5 rounded ring-1 ring-black/40" style={{ background: BUILDING_STYLE[buildMode].color }} />
          Placing <span className="text-white">{BUILDING_STYLE[buildMode].label}</span>
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-mint" />
          <span className="text-muted">click a tile</span>
          <button className="ml-1 flex items-center gap-1 rounded-full px-1.5 py-0.5 text-muted transition-colors hover:bg-white/10 hover:text-white" onClick={() => ui().setBuildMode(null)}>
            <Kbd>Esc</Kbd> cancel
          </button>
        </div>
      )}
      <div className="glass pointer-events-auto flex items-end gap-1.5 !rounded-full px-2 py-1.5 shadow-float sm:gap-2">
        <IconButton size="lg" tip hotkey="B" icon={<Hammer size={18} />} label="Build" title="Build" active={menu || !!buildMode} badge={buildMode ? "!" : undefined} onClick={() => ui().setBuildMenu(!menu)} />
        <IconButton size="lg" tip icon={<Footprints size={18} />} label="Walk" title="Walk the streets · WASD, F drive" active={walkMode} onClick={() => ui().toggleWalk()} />
        <button
          type="button"
          onClick={() => { focusHq(); ui().setTab("company"); }}
          title="Your HQ · Company"
          aria-label="Your HQ and company"
          className="group relative mx-1 -mt-3 flex h-[62px] w-8 flex-col items-center justify-end transition-transform duration-200 ease-spring hover:-translate-y-1 active:translate-y-0 active:scale-95"
        >
          <span className="absolute -bottom-0.5 h-1.5 w-8 rounded-full bg-black/50 blur-[2px] transition-[width,opacity] duration-200 group-hover:w-6 group-hover:opacity-60" />
          <span className="absolute top-0 z-10 h-7 w-7 rounded-full bg-[#e4d3b5] shadow-[inset_-2px_-3px_0_rgba(0,0,0,.12),inset_2px_2px_0_rgba(255,255,255,.35),0_2px_4px_rgba(0,0,0,.5)]" />
          <span className="relative h-11 w-7 rounded-full bg-gradient-to-b from-[#4a86f0] to-[#2d6cdf] shadow-[inset_-3px_-4px_0_rgba(0,0,0,.2),inset_2px_2px_0_rgba(255,255,255,.25),0_2px_6px_rgba(0,0,0,.5)] ring-1 ring-black/40" />
        </button>
        <IconButton size="lg" tip hotkey="H" icon={<Crosshair size={18} />} label="HQ" title="Focus your HQ" onClick={focusHq} />
        <IconButton size="lg" tip hotkey="M" icon={<MapIcon size={18} />} label="Map" title="Minimap" active={minimap} onClick={() => ui().toggleMinimap()} />
        <IconButton size="lg" tip icon={soundOn ? <Volume2 size={18} /> : <VolumeX size={18} />} label="Sound" title={soundOn ? "Sound on" : "Sound off"} active={soundOn} onClick={() => ui().toggleSound()} />
      </div>
    </div>
  );
}
