"use client";

import { useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import type { EconomySnapshot } from "@econ-sim/sim/snapshot";
import type { RoadNet } from "./roads.ts";
import { tileToWorld } from "./world-style.ts";
import { useUi, type ViewStats } from "../../lib/store.ts";

const PERIOD = 0.25; // s between publishes (~4 Hz)
const frustum = new THREE.Frustum();
const viewProj = new THREE.Matrix4();
const point = new THREE.Vector3();

/**
 * Aggregates the tiles and streets inside the camera frustum and publishes
 * them to the store for the Layers panel. Renders nothing; only writes when a
 * value actually changed so the panel doesn't re-render on a static camera.
 */
export function ViewStatsProbe({ snap, roads }: { snap: EconomySnapshot; roads: RoadNet }) {
  const since = useRef(PERIOD);

  useFrame(({ camera }, dt) => {
    since.current += dt;
    if (since.current < PERIOD) return;
    since.current = 0;
    frustum.setFromProjectionMatrix(viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));

    const { width, height, tiles } = snap.world;
    let n = 0, price = 0, resN = 0, rich = 0, live = 0, util = 0;
    for (const t of tiles) {
      const [wx, wz] = tileToWorld(t.x, t.y, width, height);
      if (!frustum.containsPoint(point.set(wx, 0, wz))) continue;
      n++;
      price += t.priceCr;
      if (t.res) { resN++; rich += t.rich; }
      if (t.building?.live) { live++; util += t.building.utilization; }
    }
    let segN = 0, traffic = 0;
    for (const s of roads.segments) {
      if (!frustum.containsPoint(point.set(s.wx, 0, s.wz))) continue;
      segN++;
      traffic += s.traffic;
    }

    const next: ViewStats = {
      tiles: n,
      priceCr: n ? Math.round(price / n) : 0,
      richness: resN ? rich / resN : 0,
      utilization: live ? util / live : 0,
      buildings: live,
      traffic: segN ? traffic / segN : 0,
    };
    const ui = useUi.getState();
    const prev = ui.viewStats;
    if (prev.tiles !== next.tiles || prev.priceCr !== next.priceCr || prev.buildings !== next.buildings
      || Math.abs(prev.richness - next.richness) > 0.005 || Math.abs(prev.utilization - next.utilization) > 0.005
      || Math.abs(prev.traffic - next.traffic) > 0.005) {
      ui.setViewStats(next);
    }
  });

  return null;
}
