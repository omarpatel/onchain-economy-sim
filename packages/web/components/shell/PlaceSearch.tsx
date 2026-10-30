"use client";

import { useMemo, useState, type ReactNode } from "react";
import { MapPin, Search } from "lucide-react";
import { ALL_BUILDINGS, ALL_GOODS } from "@econ-sim/sim/goods";
import { useWorld } from "../../lib/world.ts";
import { useUi } from "../../lib/store.ts";
import { titleCase } from "../../lib/format.ts";
import { companyColor } from "../../lib/palette.ts";
import { BUILDING_STYLE } from "../three/world-style.ts";
import { GoodIcon } from "../ui/GoodIcon.tsx";

/** DOM id the global `/` hotkey focuses. */
export const PLACE_SEARCH_ID = "place-search";
const MAX_RESULTS = 8;

interface Result { key: string; icon: ReactNode; title: string; sub: string; go: () => void }

/**
 * "Search places": companies (fly to HQ), building types (fly to the nearest
 * one, yours first), goods (open the market item) and `x,y` coordinates.
 * Arrow keys move, Enter goes, Esc clears and blurs.
 */
export function PlaceSearch() {
  const { snap, you } = useWorld();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);

  const results = useMemo<Result[]>(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    const ui = useUi.getState();
    const { tiles, width, height } = snap.world;
    const fly = (tileId: string) => {
      const t = tiles.find((x) => x.id === tileId);
      if (!t) return;
      ui.selectTile(t.id);
      ui.selectCompany(t.owner);
      ui.focusTile(t.x, t.y);
    };
    const out: Result[] = [];

    const xy = /^(\d+)\s*[, ]\s*(\d+)$/.exec(s);
    if (xy) {
      const x = Number(xy[1]), y = Number(xy[2]);
      if (x < width && y < height) out.push({ key: `xy:${x},${y}`, icon: <MapPin size={13} className="text-mint-300" />, title: `Tile ${x},${y}`, sub: "Coordinates", go: () => fly(`${x},${y}`) });
    }

    const myId = you?.company?.id ?? null;
    const companies = snap.companies
      .filter((c) => c.name.toLowerCase().includes(s))
      .sort((a, b) => +(b.id === myId) - +(a.id === myId) || +b.isPlayer - +a.isPlayer || b.valuation - a.valuation);
    for (const c of companies) {
      out.push({
        key: `co:${c.id}`,
        icon: <span className="h-2.5 w-2.5 rounded-full" style={{ background: companyColor(c.id) }} />,
        title: c.name,
        sub: `${c.id === myId ? "Your company" : c.isPlayer ? "Player company" : "NPC company"} · ${c.buildings} buildings · HQ ${c.hubTileId}`,
        go: () => fly(c.hubTileId),
      });
    }

    for (const type of ALL_BUILDINGS) {
      const label = BUILDING_STYLE[type].label;
      if (!label.toLowerCase().includes(s) && !type.includes(s)) continue;
      const built = tiles.filter((t) => t.building?.type === type);
      if (built.length === 0) continue;
      const mine = built.filter((t) => t.owner === myId);
      const target = (mine.length ? mine : built)[0];
      out.push({
        key: `b:${type}`,
        icon: <span className="h-2.5 w-2.5 rounded-sm" style={{ background: BUILDING_STYLE[type].color }} />,
        title: label,
        sub: `${built.length} in the world${mine.length ? ` · ${mine.length} yours` : ""} · ${mine.length ? "fly to yours" : "fly to one"}`,
        go: () => fly(target.id),
      });
    }

    for (const g of ALL_GOODS) {
      const label = titleCase(g);
      if (!label.toLowerCase().includes(s)) continue;
      out.push({ key: `g:${g}`, icon: <GoodIcon good={g} size={16} />, title: label, sub: "Market item", go: () => { ui.selectGood(g); ui.setTab("market"); } });
    }
    return out.slice(0, MAX_RESULTS);
  }, [q, snap, you]);

  const pick = (r: Result | undefined) => {
    if (!r) return;
    r.go();
    setQ("");
    setOpen(false);
    (document.getElementById(PLACE_SEARCH_ID) as HTMLInputElement | null)?.blur();
  };

  const at = Math.min(cursor, Math.max(0, results.length - 1));

  return (
    <div className="relative w-[200px] shrink-0">
      <label className="flex h-7 items-center gap-1.5 rounded-md border border-edge bg-black/30 px-2 text-muted focus-within:border-mint/50">
        <Search size={13} className="shrink-0" />
        <input
          id={PLACE_SEARCH_ID}
          value={q}
          placeholder="Search places"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => { setQ(e.target.value); setCursor(0); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(results.length - 1, c + 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
            else if (e.key === "Enter") { e.preventDefault(); pick(results[at]); }
            else if (e.key === "Escape") { setQ(""); e.currentTarget.blur(); }
          }}
          className="min-w-0 flex-1 bg-transparent text-xs text-slate-100 outline-none placeholder:text-muted"
        />
        {!q && <kbd className="rounded border border-edge px-1 font-mono text-[9px] text-muted">/</kbd>}
      </label>
      {open && q.trim() && (
        <div className="glass absolute right-0 top-8 z-50 w-[300px] overflow-hidden rounded-lg py-1 shadow-2xl" role="listbox">
          {results.length === 0 && <div className="px-3 py-2 text-[11px] text-muted">No places match “{q.trim()}”.</div>}
          {results.map((r, i) => (
            <button
              key={r.key}
              type="button"
              role="option"
              aria-selected={i === at}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setCursor(i)}
              onClick={() => pick(r)}
              className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left ${i === at ? "bg-white/[0.08]" : ""}`}
            >
              <span className="flex h-5 w-5 shrink-0 items-center justify-center">{r.icon}</span>
              <span className="min-w-0">
                <span className="block truncate text-xs font-semibold text-slate-100">{r.title}</span>
                <span className="block truncate text-[10px] text-muted">{r.sub}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
