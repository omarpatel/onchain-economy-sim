"use client";

import { useMemo } from "react";
import * as THREE from "three";
import { Html } from "@react-three/drei";
import { Select } from "@react-three/postprocessing";
import type { EconomySnapshot } from "@econ-sim/sim/snapshot";
import type { PlayerView } from "@econ-sim/sim/protocol";
import { RECIPES, type BuildingType } from "@econ-sim/sim/goods";
import { buildingHeight, buildingMeshProps } from "./geometry.ts";
import { BUILDING_STYLE, RES_LABEL, tileToWorld } from "./world-style.ts";
import { useUi } from "../../lib/store.ts";
import { fmtCr } from "../../lib/format.ts";
import { companyColor } from "../../lib/palette.ts";

type Tile = EconomySnapshot["world"]["tiles"][number];

export interface BuildCheck {
  ok: boolean;
  reasons: string[];
}

/** Client-side preflight for a `build` intent; the engine is still authoritative. */
export function checkBuild(type: BuildingType, tile: Tile, you: PlayerView | null): BuildCheck {
  const reasons: string[] = [];
  const recipe = RECIPES[type];
  if (tile.building) reasons.push("Tile already built");
  if (recipe.requiresResource && tile.res !== recipe.requiresResource) reasons.push(`Needs ${RES_LABEL[recipe.requiresResource].toLowerCase()}`);
  const co = you?.company ?? null;
  if (!co) reasons.push("No company");
  else {
    const ownedByYou = tile.owner === co.id;
    if (tile.owner && !ownedByYou) reasons.push(`Owned by ${tile.ownerName ?? tile.owner}`);
    const landCost = ownedByYou ? 0 : tile.premium ? 0 : tile.priceCr;
    if (!ownedByYou && tile.premium) reasons.push("Premium land: buy with $ECON first");
    if (co.cashCr < recipe.buildCostCr + landCost) reasons.push(`Need ${fmtCr(recipe.buildCostCr + landCost)}`);
  }
  return { ok: reasons.length === 0, reasons };
}

/** Translucent preview of the building about to be placed on the hovered tile. */
export function Ghost({ snap, you }: { snap: EconomySnapshot; you: PlayerView | null }) {
  const buildMode = useUi((s) => s.buildMode);
  const hoverTile = useUi((s) => s.hoverTile);
  const mat = useMemo(() => new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false, emissiveIntensity: 0.6 }), []);
  const tile = useMemo(() => (hoverTile ? snap.world.tiles.find((t) => t.id === hoverTile) : undefined), [snap.world.tiles, hoverTile]);
  if (!buildMode || !tile) return null;
  const check = checkBuild(buildMode, tile, you);
  mat.emissive.set(check.ok ? "#10b981" : "#f43f5e");
  mat.color.set(check.ok ? "#9fffd9" : "#ffb4c0");
  const [wx, wz] = tileToWorld(tile.x, tile.y, snap.world.width, snap.world.height);
  return (
    <group position={[wx, 0, wz]}>
      <mesh {...buildingMeshProps(buildMode, tile.x, tile.y)} material={mat} raycast={() => null} />
      <Html position={[0, buildingHeight(buildMode, tile.x, tile.y) + 0.6, 0]} center zIndexRange={[20, 0]} style={{ pointerEvents: "none" }}>
        <div className={`whitespace-nowrap rounded border px-2 py-1 text-[11px] font-medium shadow ${check.ok ? "border-emerald-500/50 bg-emerald-950/85 text-emerald-100" : "border-rose-500/50 bg-rose-950/85 text-rose-100"}`}>
          <div>{BUILDING_STYLE[buildMode].label} · {fmtCr(RECIPES[buildMode].buildCostCr)}</div>
          {check.reasons.map((r) => <div key={r} className="font-mono text-[10px] opacity-90">{r}</div>)}
          {check.ok && <div className="font-mono text-[10px] opacity-80">click to build</div>}
        </div>
      </Html>
    </group>
  );
}

/**
 * Invisible copy of the selected building so the Outline pass can draw its
 * edges. `colorWrite`/`depthWrite` are off: it is only rendered by the outline
 * mask pass, never in the main pass, so it cannot z-fight the instance.
 * Skipped while that building is shown as a cutaway (the shell is hidden).
 */
export function SelectionProxy({ snap }: { snap: EconomySnapshot }) {
  const selected = useUi((s) => s.selectedTile);
  const interior = useUi((s) => s.interiorTile);
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }), []);
  const tile = useMemo(() => (selected ? snap.world.tiles.find((t) => t.id === selected) : undefined), [snap.world.tiles, selected]);
  if (!tile?.building || tile.id === interior) return null;
  const [wx, wz] = tileToWorld(tile.x, tile.y, snap.world.width, snap.world.height);
  return (
    <Select enabled>
      <mesh {...buildingMeshProps(tile.building.type, tile.x, tile.y)} material={mat} position={[wx, 0, wz]} raycast={() => null} />
    </Select>
  );
}

/** A single DOM label following the hovered tile. */
export function HoverLabel({ snap }: { snap: EconomySnapshot }) {
  const hoverTile = useUi((s) => s.hoverTile);
  const buildMode = useUi((s) => s.buildMode);
  const tile = useMemo(() => (hoverTile ? snap.world.tiles.find((t) => t.id === hoverTile) : undefined), [snap.world.tiles, hoverTile]);
  if (!tile || buildMode) return null;
  const [wx, wz] = tileToWorld(tile.x, tile.y, snap.world.width, snap.world.height);
  const b = tile.building;
  const title = b ? BUILDING_STYLE[b.type].label : tile.res ? RES_LABEL[tile.res] : "Plain";
  return (
    <Html position={[wx, b ? buildingHeight(b.type, tile.x, tile.y) + 0.4 : 0.6, wz]} center zIndexRange={[20, 0]} style={{ pointerEvents: "none" }}>
      <div className="whitespace-nowrap rounded border border-edge bg-black/75 px-2 py-1 text-[11px] shadow backdrop-blur">
        <div className="font-medium text-slate-100">{title}{tile.premium ? " · premium" : ""}</div>
        <div className="font-mono text-[10px] text-muted">
          ({tile.x},{tile.y}){tile.res ? ` · rich ${tile.rich.toFixed(1)}` : ""}
          {b && ` · ${b.live ? `${Math.round(b.utilization * 100)}% util` : "building"}`}
        </div>
        {tile.ownerName && (
          <div className="flex items-center gap-1 font-mono text-[10px]">
            <span className="inline-block h-2 w-2 rounded-sm" style={{ background: companyColor(tile.owner ?? "") }} />
            <span className="text-slate-300">{tile.ownerName}</span>
          </div>
        )}
      </div>
    </Html>
  );
}
