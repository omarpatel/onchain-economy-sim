"use client";

import { useEffect, useRef } from "react";
import type { EconomySnapshot } from "@econ-sim/sim/snapshot";
import { OUTLINE, worldToTile, type PlayerPos } from "../three/world-style.ts";
import { buildRoads } from "../three/roads.ts";
import { useUi } from "../../lib/store.ts";
import { useWorld } from "../../lib/world.ts";

const SIZE = 168;
/** Backing-store scale so the map stays crisp on hi-dpi screens. */
const DPR = 2;

/** Map-style flat colours, matched to the 3D ground, deposits and sandstone buildings. */
const MAP = {
  grass: "#6f9a52", grassAlt: "#76a158", road: "#4f4a44", building: "#d9cfb8", construction: "#a39d93",
  iron: "#9a9ca1", coal: "#55555c", oil: "#3d3644", fertile: "#b8954e", forest: "#3f7d3a", aquifer: "#4fa3c4",
} as const;

/**
 * Top-down minimap. Ground, deposits, streets, buildings and your parcels are
 * baked once per tick; the avatar marker (walk mode) and the selection redraw
 * every frame. Click to focus the camera.
 */
export function Minimap({ snap, playerPos }: { snap: EconomySnapshot; playerPos: { current: PlayerPos } }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const baseRef = useRef<HTMLCanvasElement | null>(null);
  const focusTile = useUi((s) => s.focusTile);
  const selectTile = useUi((s) => s.selectTile);
  const youCompany = useWorld().you?.company?.id ?? null;

  useEffect(() => {
    const { width, tiles } = snap.world;
    const cell = SIZE / width;
    const base = document.createElement("canvas");
    base.width = base.height = SIZE * DPR;
    const b = base.getContext("2d")!;
    b.scale(DPR, DPR);
    for (const t of tiles) {
      b.fillStyle = t.res ? MAP[t.res] : (t.x + t.y) % 2 ? MAP.grass : MAP.grassAlt;
      b.fillRect(t.x * cell, t.y * cell, cell, cell);
    }
    // your parcels: mint wash under everything built on them
    b.fillStyle = OUTLINE.mine;
    b.globalAlpha = 0.35;
    for (const t of tiles) if (t.owner && t.owner === youCompany) b.fillRect(t.x * cell, t.y * cell, cell, cell);
    b.globalAlpha = 1;
    b.strokeStyle = MAP.road;
    b.lineWidth = 1.4;
    b.beginPath();
    for (const s of buildRoads(snap).segments) {
      b.moveTo(s.i * cell, s.j * cell);
      b.lineTo((s.i + (s.horizontal ? 1 : 0)) * cell, (s.j + (s.horizontal ? 0 : 1)) * cell);
    }
    b.stroke();
    const inset = cell * 0.2;
    for (const t of tiles) {
      if (!t.building) continue;
      b.fillStyle = t.building.live ? MAP.building : MAP.construction;
      b.fillRect(t.x * cell + inset, t.y * cell + inset, cell - inset * 2, cell - inset * 2);
    }
    // your HQ beacon
    const hq = tiles.find((t) => t.hq && t.owner === youCompany);
    if (hq) {
      b.fillStyle = OUTLINE.mine;
      b.beginPath();
      b.arc((hq.x + 0.5) * cell, (hq.y + 0.5) * cell, cell * 0.45, 0, Math.PI * 2);
      b.fill();
      b.strokeStyle = "#0e0e10";
      b.lineWidth = 1;
      b.stroke();
    }
    baseRef.current = base;
  }, [snap, youCompany]);

  useEffect(() => {
    const { width, height, tiles } = snap.world;
    const cell = SIZE / width;
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    let raf = 0;
    const draw = () => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (baseRef.current) ctx.drawImage(baseRef.current, 0, 0);
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      const ui = useUi.getState();
      const sel = ui.selectedTile ? tiles.find((t) => t.id === ui.selectedTile) : undefined;
      if (sel) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(sel.x * cell - 1, sel.y * cell - 1, cell + 2, cell + 2);
      }
      if (ui.walkMode) {
        const [tx, ty] = worldToTile(playerPos.current.x, playerPos.current.z, width, height);
        const px = (tx + 0.5) * cell;
        const py = (ty + 0.5) * cell;
        ctx.strokeStyle = "#fbbf24";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px + Math.sin(playerPos.current.heading + Math.PI) * 10, py + Math.cos(playerPos.current.heading + Math.PI) * 10);
        ctx.stroke();
        ctx.fillStyle = "#fbbf24";
        ctx.beginPath();
        ctx.arc(px, py, 3.2, 0, Math.PI * 2);
        ctx.fill();
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [snap, playerPos]);

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const cell = SIZE / snap.world.width;
    const x = Math.floor((e.clientX - r.left) / cell);
    const y = Math.floor((e.clientY - r.top) / cell);
    const t = snap.world.tiles.find((tt) => tt.x === x && tt.y === y);
    if (!t) return;
    selectTile(t.id);
    focusTile(x, y);
  };

  return (
    <div className="absolute bottom-3 right-3 z-20 rounded-lg border border-edge bg-panel/90 p-1.5 shadow-xl backdrop-blur">
      <canvas ref={canvasRef} width={SIZE * DPR} height={SIZE * DPR} style={{ width: SIZE, height: SIZE }} className="cursor-crosshair rounded" onClick={onClick} />
      <div className="mt-1 text-center text-[9px] uppercase tracking-wider text-muted">click to focus</div>
    </div>
  );
}
