import type { BuildingType } from "@econ-sim/sim/goods";
import { RECIPES } from "@econ-sim/sim/goods";
import type { EconomySnapshot } from "@econ-sim/sim/snapshot";
import { tileToWorld } from "./world-style.ts";
import { buildingPose, type BuildingPose } from "./geometry.ts";

/** Everything the instanced renderers need per building, derived once per tick. */
export interface BuildInfo {
  id: string;
  type: BuildingType;
  tileId: string;
  x: number;
  y: number;
  wx: number;
  wz: number;
  live: boolean;
  utilization: number;
  companyId: string;
  hq: boolean;
  premium: boolean;
  /** construction progress 0..1 (1 when live) */
  progress: number;
  /** variant, street-facing yaw and size jitter, stable per tile */
  pose: BuildingPose;
}

/**
 * `firstSeen` remembers the tick a building first appeared under
 * construction so the scaffold can rise over `buildTicks` without the public
 * snapshot exposing per-building start ticks.
 */
export function deriveBuilds(snap: EconomySnapshot, firstSeen: Map<string, number>): BuildInfo[] {
  const { width, height, tiles } = snap.world;
  const out: BuildInfo[] = [];
  const seen = new Set<string>();
  for (const t of tiles) {
    const b = t.building;
    if (!b) continue;
    seen.add(b.id);
    const [wx, wz] = tileToWorld(t.x, t.y, width, height);
    let progress = 1;
    if (!b.live) {
      const start = firstSeen.get(b.id) ?? snap.tick;
      if (!firstSeen.has(b.id)) firstSeen.set(b.id, snap.tick);
      progress = Math.min(0.95, Math.max(0.05, (snap.tick - start) / RECIPES[b.type].buildTicks));
    } else if (firstSeen.has(b.id)) {
      firstSeen.delete(b.id);
    }
    out.push({
      id: b.id, type: b.type, tileId: t.id, x: t.x, y: t.y, wx, wz,
      live: b.live, utilization: b.utilization, companyId: b.companyId, hq: t.hq, premium: t.premium, progress,
      pose: buildingPose(b.type, t.x, t.y),
    });
  }
  for (const id of firstSeen.keys()) if (!seen.has(id)) firstSeen.delete(id);
  return out;
}
