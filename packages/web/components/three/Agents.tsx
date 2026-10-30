"use client";

import { useFrame } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { featureGeometries } from "./features.ts";
import { tintedStandardMaterial } from "./geometry.ts";
import type { RoadNet } from "./roads.ts";
import { ROAD, TILE, hash2 } from "./world-style.ts";
import { companyColor } from "../../lib/palette.ts";

const MAX_TRUCKS = 128;
const MAX_PEDS = 64;
const TRUCK_SPEED = 2.2; // world units / s
const ASPHALT_TOP = 0.03;
const WALK_TOP = 0.05;
/** Sidewalk centre offset from the street axis. */
const CURB = ROAD.asphalt / 2 + ROAD.walk / 2;
/** Walkable length of one street segment (between the corner squares). */
const SEG_LEN = TILE - ROAD.width;
const PED_COLORS = ["#e2e8f0", "#93c5fd", "#fca5a5", "#86efac", "#fde68a", "#c4b5fd"].map((c) => new THREE.Color(c));

interface Truck { pts: [number, number][]; cum: number[]; length: number; phase: number; color: THREE.Color }
interface Ped { x: number; z: number; horizontal: boolean; side: number; speed: number; phase: number; color: THREE.Color }

const dummy = new THREE.Object3D();

/**
 * Ambient life on the street network: one delivery truck per haul route
 * (company HQ ↔ building) shuttling in its company colour on the right-hand
 * lane, and pedestrians pacing the sidewalks. Positions are pure functions of
 * the clock, so a new tick's road net never makes anything jump.
 */
export function Agents({ roads }: { roads: RoadNet }) {
  const geos = featureGeometries();
  const material = useMemo(() => tintedStandardMaterial({ roughness: 0.6 }), []);
  const truckRef = useRef<THREE.InstancedMesh>(null);
  const pedRef = useRef<THREE.InstancedMesh>(null);

  const trucks = useMemo<Truck[]>(() => roads.routes.slice(0, MAX_TRUCKS).map((r, i) => {
    const cum = [0];
    for (let k = 1; k < r.points.length; k++) cum.push(cum[k - 1] + Math.hypot(r.points[k][0] - r.points[k - 1][0], r.points[k][1] - r.points[k - 1][1]));
    return { pts: r.points, cum, length: r.length, phase: hash2(i, r.points.length, 7), color: new THREE.Color(companyColor(r.companyId)) };
  }), [roads]);

  const peds = useMemo<Ped[]>(() => {
    const segs = roads.segments;
    if (segs.length === 0) return [];
    const out: Ped[] = [];
    for (let i = 0; i < Math.min(MAX_PEDS, segs.length); i++) {
      const s = segs[Math.floor(hash2(i, 0, 11) * segs.length)];
      out.push({
        x: s.wx, z: s.wz, horizontal: s.horizontal,
        side: hash2(i, 1, 11) < 0.5 ? -1 : 1,
        speed: 0.3 + hash2(i, 2, 11) * 0.25,
        phase: hash2(i, 3, 11) * 10,
        color: PED_COLORS[i % PED_COLORS.length],
      });
    }
    return out;
  }, [roads]);

  // Colours change only with the route/segment lists; matrices move every frame.
  useLayoutEffect(() => {
    const tm = truckRef.current;
    if (tm) {
      trucks.forEach((t, i) => tm.setColorAt(i, t.color));
      tm.count = trucks.length;
      if (tm.instanceColor) tm.instanceColor.needsUpdate = true;
    }
    const pm = pedRef.current;
    if (pm) {
      peds.forEach((p, i) => pm.setColorAt(i, p.color));
      pm.count = peds.length;
      if (pm.instanceColor) pm.instanceColor.needsUpdate = true;
    }
  }, [trucks, peds]);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const tm = truckRef.current;
    if (tm && trucks.length) {
      trucks.forEach((tr, i) => {
        // ping-pong along the polyline: out to the building, back to HQ
        const s = (t * TRUCK_SPEED + tr.phase * tr.length * 2) % (tr.length * 2);
        const d = s < tr.length ? s : tr.length * 2 - s;
        let k = 1;
        while (k < tr.cum.length - 1 && tr.cum[k] < d) k++;
        const [ax, az] = tr.pts[k - 1];
        const [bx, bz] = tr.pts[k];
        const seg = tr.cum[k] - tr.cum[k - 1] || 1;
        const f = (d - tr.cum[k - 1]) / seg;
        const dir = s < tr.length ? 1 : -1;
        const fx = ((bx - ax) / seg) * dir;
        const fz = ((bz - az) / seg) * dir;
        // right-hand lane: right of heading (fx, fz) is (-fz, fx)
        dummy.position.set(ax + (bx - ax) * f - fz * ROAD.laneOffset, ASPHALT_TOP, az + (bz - az) * f + fx * ROAD.laneOffset);
        dummy.rotation.set(0, Math.atan2(-fz, fx), 0);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        tm.setMatrixAt(i, dummy.matrix);
      });
      tm.instanceMatrix.needsUpdate = true;
    }

    const pm = pedRef.current;
    if (pm && peds.length) {
      peds.forEach((p, i) => {
        // pace the sidewalk end to end: triangle wave over the segment
        const w = ((t * p.speed + p.phase) % 2 + 2) % 2;
        const u = (w < 1 ? w : 2 - w) * SEG_LEN - SEG_LEN / 2;
        const heading = w < 1 ? 1 : -1;
        const bob = Math.abs(Math.sin(t * 9 + p.phase)) * 0.025;
        if (p.horizontal) {
          dummy.position.set(p.x + u, WALK_TOP + bob, p.z + p.side * CURB);
          dummy.rotation.set(0, heading > 0 ? Math.PI / 2 : -Math.PI / 2, 0);
        } else {
          dummy.position.set(p.x + p.side * CURB, WALK_TOP + bob, p.z + u);
          dummy.rotation.set(0, heading > 0 ? 0 : Math.PI, 0);
        }
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        pm.setMatrixAt(i, dummy.matrix);
      });
      pm.instanceMatrix.needsUpdate = true;
    }
  });

  return (
    <group>
      <instancedMesh ref={truckRef} args={[geos.truck, material, MAX_TRUCKS]} castShadow frustumCulled={false} raycast={() => null} />
      <instancedMesh ref={pedRef} args={[geos.ped, material, MAX_PEDS]} castShadow frustumCulled={false} raycast={() => null} />
    </group>
  );
}
