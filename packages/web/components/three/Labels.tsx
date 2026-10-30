"use client";

import { useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import type { EconomySnapshot } from "@econ-sim/sim/snapshot";
import { BUILDING_STYLE, OUTLINE, tileToWorld } from "./world-style.ts";

/** Labels farther than this from the camera are hidden (zoomed-out overview stays clean). */
const HIDE_DIST = 76;
/** Your own label survives a little further out. */
const MINE_DIST = 150;
/** Max DOM labels at once; nearest win. */
const MAX_LABELS = 24;
/** Visibility is recomputed at this rate, never per frame. */
const TICK = 0.25;

interface Label { id: string; name: string; mine: boolean; pos: THREE.Vector3 }

/**
 * Floating owner name pills over player-company HQs (Capital Rift's player
 * labels; NPC firms would bury them). Candidates are derived once per
 * snapshot; a 4 Hz camera-distance pass picks the nearest few and React only
 * re-renders when that set changes.
 */
export function Labels({ snap, youCompany }: { snap: EconomySnapshot; youCompany: string | null }) {
  const labels = useMemo(() => {
    const names = new Map(snap.companies.map((c) => [c.id, c] as const));
    const out: Label[] = [];
    for (const t of snap.world.tiles) {
      if (!t.hq || !t.owner) continue;
      const c = names.get(t.owner);
      if (!c || !(c.isPlayer || c.id === youCompany)) continue;
      const [wx, wz] = tileToWorld(t.x, t.y, snap.world.width, snap.world.height);
      const h = t.building ? BUILDING_STYLE[t.building.type].height : 0.4;
      out.push({ id: c.id, name: c.name, mine: c.id === youCompany, pos: new THREE.Vector3(wx, h + 0.7, wz) });
    }
    return out;
  }, [snap.companies, snap.world, youCompany]);

  const scores = useMemo(() => new Float32Array(labels.length), [labels]);
  const order = useMemo(() => labels.map((_, i) => i), [labels]);
  const byId = useMemo(() => new Map(labels.map((l) => [l.id, l] as const)), [labels]);
  const [shown, setShown] = useState<readonly string[]>([]);
  const shownKey = useRef("");
  const acc = useRef(TICK);

  useFrame(({ camera }, dt) => {
    acc.current += dt;
    if (acc.current < TICK) return;
    acc.current = 0;
    for (let i = 0; i < labels.length; i++) {
      const l = labels[i];
      const d = camera.position.distanceTo(l.pos);
      scores[i] = d > (l.mine ? MINE_DIST : HIDE_DIST) ? Infinity : l.mine ? -1 : d;
    }
    order.sort((a, b) => scores[a] - scores[b]);
    let n = 0;
    while (n < order.length && n < MAX_LABELS && scores[order[n]] !== Infinity) n++;
    let key = "";
    for (let i = 0; i < n; i++) key += `${labels[order[i]].id},`;
    if (key === shownKey.current) return;
    shownKey.current = key;
    setShown(order.slice(0, n).map((i) => labels[i].id));
  });

  return (
    <>
      {shown.map((id) => {
        const l = byId.get(id);
        if (!l) return null;
        return (
          <Html key={l.id} position={l.pos} center zIndexRange={[10, 0]} style={{ pointerEvents: "none" }}>
            <div
              className="flex items-center gap-1.5 whitespace-nowrap rounded-full bg-black/70 px-2.5 py-0.5 text-[11px] font-semibold text-white shadow-md backdrop-blur-sm"
              style={l.mine ? { boxShadow: `0 0 0 1px ${OUTLINE.mine}`, color: OUTLINE.mine } : undefined}
            >
              {l.mine && <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: OUTLINE.mine }} />}
              {l.name}
            </div>
          </Html>
        );
      })}
    </>
  );
}
