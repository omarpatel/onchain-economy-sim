"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { C, box, boxUp, merge, tintedStandardMaterial } from "./geometry.ts";
import { TOWN_TIME, buildTown, townMaterial } from "./town.ts";

/** Chunks nearer than this (camera → chunk bounds, world units) draw their detailed LOD. */
const LOD_NEAR = 72;
/** Road surface the moving cars ride on (town asphalt top). */
const CAR_Y = 0.028;
const noRaycast = () => null;

let carGeo: THREE.BufferGeometry | null = null;
/** Small hatchback along +x: tinted body, dark glasshouse, wheel pairs, head/tail lights that glow at night (~100 triangles). */
function carGeometry(): THREE.BufferGeometry {
  if (carGeo) return carGeo;
  carGeo = merge([
    { geo: boxUp(0.34, 0.06, 0.15, 0, 0.026, 0), color: "#fff", tint: true },
    { geo: boxUp(0.19, 0.055, 0.135, -0.02, 0.086, 0), color: "#fff", tint: true },
    { geo: box(0.008, 0.04, 0.12, 0.074, 0.112, 0), color: "#2a3038", tint: false },
    { geo: box(0.17, 0.035, 0.137, -0.02, 0.112, 0), color: "#2a3038", tint: false },
    { geo: box(0.01, 0.022, 0.035, 0.171, 0.06, -0.05), color: "#fff4d6", tint: false, glow: true },
    { geo: box(0.01, 0.022, 0.035, 0.171, 0.06, 0.05), color: "#fff4d6", tint: false, glow: true },
    { geo: box(0.01, 0.02, 0.03, -0.171, 0.064, -0.05), color: "#c0392b", tint: false, glow: true },
    { geo: box(0.01, 0.02, 0.03, -0.171, 0.064, 0.05), color: "#c0392b", tint: false, glow: true },
    { geo: box(0.064, 0.056, 0.16, 0.1, 0.03, 0), color: C.dark, tint: false },
    { geo: box(0.064, 0.056, 0.16, -0.1, 0.03, 0), color: C.dark, tint: false },
  ]);
  return carGeo;
}

/**
 * The living town around the playable map (see `town.ts`): one ground mesh,
 * per-chunk building meshes that swap to a lighter LOD with distance, and an
 * instanced fleet of cars lapping the town's blocks. Deterministic for a map
 * size and independent of the economy snapshot, so ticks never rebuild it.
 */
export function Town({ width, height }: { width: number; height: number }) {
  const town = useMemo(() => buildTown(width, height), [width, height]);
  const material = useMemo(() => townMaterial(), []);
  const carMaterial = useMemo(() => tintedStandardMaterial({ roughness: 0.45 }), []);
  useEffect(() => () => { material.dispose(); carMaterial.dispose(); }, [material, carMaterial]);
  const hi = useRef<(THREE.Mesh | null)[]>([]);
  const lo = useRef<(THREE.Mesh | null)[]>([]);
  const carsRef = useRef<THREE.InstancedMesh>(null);

  // per car: x0 z0 x1 z1 cw speed phase perimeter
  const laps = useMemo(() => {
    const a = new Float32Array(town.cars.length * 8);
    town.cars.forEach((c, i) => {
      a.set([c.x0, c.z0, c.x1, c.z1, c.cw ? 1 : 0, c.speed, c.phase, 2 * (c.x1 - c.x0 + c.z1 - c.z0)], i * 8);
    });
    return a;
  }, [town]);

  useLayoutEffect(() => {
    const m = carsRef.current;
    if (!m) return;
    const col = new THREE.Color();
    town.cars.forEach((c, i) => m.setColorAt(i, col.set(c.color)));
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [town]);

  useFrame(({ camera, clock }) => {
    const t = clock.elapsedTime;
    TOWN_TIME.value = t;
    const p = camera.position;
    for (let i = 0; i < town.chunks.length; i++) {
      const c = town.chunks[i];
      const dx = Math.max(c.min[0] - p.x, 0, p.x - c.max[0]);
      const dz = Math.max(c.min[1] - p.z, 0, p.z - c.max[1]);
      const near = dx * dx + dz * dz + p.y * p.y < LOD_NEAR * LOD_NEAR;
      const h = hi.current[i], l = lo.current[i];
      if (h) h.visible = near;
      if (l) l.visible = !near;
    }
    const m = carsRef.current;
    if (!m) return;
    const te = m.instanceMatrix.array as Float32Array;
    const n = town.cars.length;
    for (let i = 0; i < n; i++) {
      const o = i * 8;
      const x0 = laps[o], z0 = laps[o + 1], x1 = laps[o + 2], z1 = laps[o + 3];
      const w = x1 - x0, d = z1 - z0;
      let s = (laps[o + 6] + t * laps[o + 5]) % laps[o + 7];
      let x: number, z: number, cs: number, sn: number;
      if (laps[o + 4] > 0.5) {
        // clockwise on screen: east along the top, south, west, north
        if (s < w) { x = x0 + s; z = z0; cs = 1; sn = 0; }
        else if ((s -= w) < d) { x = x1; z = z0 + s; cs = 0; sn = -1; }
        else if ((s -= d) < w) { x = x1 - s; z = z1; cs = -1; sn = 0; }
        else { s -= w; x = x0; z = z1 - s; cs = 0; sn = 1; }
      } else {
        if (s < d) { x = x0; z = z0 + s; cs = 0; sn = -1; }
        else if ((s -= d) < w) { x = x0 + s; z = z1; cs = 1; sn = 0; }
        else if ((s -= w) < d) { x = x1; z = z1 - s; cs = 0; sn = 1; }
        else { s -= d; x = x1 - s; z = z0; cs = -1; sn = 0; }
      }
      const k = i * 16;
      te[k] = cs; te[k + 1] = 0; te[k + 2] = -sn; te[k + 3] = 0;
      te[k + 4] = 0; te[k + 5] = 1; te[k + 6] = 0; te[k + 7] = 0;
      te[k + 8] = sn; te[k + 9] = 0; te[k + 10] = cs; te[k + 11] = 0;
      te[k + 12] = x; te[k + 13] = CAR_Y; te[k + 14] = z; te[k + 15] = 1;
    }
    m.instanceMatrix.needsUpdate = true;
  });

  return (
    <group>
      <mesh geometry={town.ground} material={material} receiveShadow raycast={noRaycast} />
      {town.chunks.map((c, i) => (
        <group key={i}>
          <mesh ref={(el) => { hi.current[i] = el; }} geometry={c.hi} material={material} castShadow receiveShadow raycast={noRaycast} />
          <mesh ref={(el) => { lo.current[i] = el; }} geometry={c.lo} material={material} castShadow receiveShadow visible={false} raycast={noRaycast} />
        </group>
      ))}
      <instancedMesh ref={carsRef} args={[carGeometry(), carMaterial, town.cars.length]} castShadow frustumCulled={false} raycast={noRaycast} />
    </group>
  );
}
