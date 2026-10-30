"use client";

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import type { EconomySnapshot } from "@econ-sim/sim/snapshot";
import {
  LAND, PUMP_PIVOT, blurTiles, farmland, featureGeometries, fieldMaterial, lakeGeometries, landforms, natureGeometries, pitGeometry, roadDistance,
  rockingMaterial, vnoise, waterMaterial, type HasRoad,
} from "./features.ts";
import { tintedStandardMaterial } from "./geometry.ts";
import type { RoadNet } from "./roads.ts";
import { heat } from "./Terrain.tsx";
import { ROAD, cornerToWorld, hash2, tileToWorld } from "./world-style.ts";
import { useUi } from "../../lib/store.ts";

type Tile = EconomySnapshot["world"]["tiles"][number];

/** One placed copy of a feature geometry; `color` multiplies the geometry's tinted parts. `sy`/`sz` (default 1) stretch local y/z on top of `s`; `y` (default 0) lifts it. */
export interface Inst { x: number; z: number; ry: number; s: number; sy?: number; sz?: number; y?: number; color: THREE.Color }

const { smoothstep } = THREE.MathUtils;

const dummy = new THREE.Object3D();
const WHITE = new THREE.Color(1, 1, 1);
const ASPHALT = new THREE.Color(ROAD.asphaltColor);
/** Canopy tints multiply the leaf albedo: fresh, neutral, shaded, olive and the odd early-autumn crown. */
export const BROAD_TINT = [new THREE.Color(1.12, 1.16, 0.96), WHITE, new THREE.Color(0.8, 0.9, 0.78), new THREE.Color(1.2, 1.12, 0.72), new THREE.Color(1.5, 0.98, 0.52)];
export const CONIFER_TINT = [WHITE, new THREE.Color(0.82, 0.92, 0.9), new THREE.Color(1.08, 1.1, 0.96)];
const PUMP_PAINT = ["#d4a63a", "#3f7f9a", "#b5442f"].map((c) => new THREE.Color(c));
/** Sidewalk centre offset from the street axis, also where lamps stand. */
const CURB = ROAD.asphalt / 2 + ROAD.walk / 2;

/** Advances the shared water/pumpjack clock and the sky colour the water reflects. Idempotent, so every landscape component may call it. */
export function useLandClock(): void {
  const scene = useThree((s) => s.scene);
  useFrame(({ clock }) => {
    LAND.uTime.value = clock.elapsedTime;
    if (scene.background instanceof THREE.Color) LAND.uSky.value.copy(scene.background);
  });
}

/**
 * Everything on the ground that isn't a building: streets (asphalt tinted by
 * haul intensity under the traffic layer), street lamps that glow at night,
 * and each undeveloped deposit as a natural landform — lakes with animated
 * water, terraced open pits with spoil heaps, dense mixed woodland, crop
 * patchworks behind hedgerows, and oil pads with nodding pumpjacks.
 * Analysis layers hide the flat landforms so the heat colours read.
 */
export function Features({ snap, roads }: { snap: EconomySnapshot; roads: RoadNet }) {
  const geos = featureGeometries();
  const nat = natureGeometries();
  const material = useMemo(() => tintedStandardMaterial({ roughness: 0.9 }), []);
  const bedMaterial = useMemo(() => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 }), []);
  const layer = useUi((s) => s.layer);
  const { width, height, tiles } = snap.world;
  useLandClock();

  const street = useMemo(() => {
    const traffic = layer === "traffic";
    const seg: Inst[] = [];
    // busiest segment touching each corner, keyed like roads.ts nodes
    const nodeHeat = new Map<number, number>();
    const bump = (i: number, j: number, v: number) => { const k = j * (width + 2) + i; nodeHeat.set(k, Math.max(nodeHeat.get(k) ?? 0, v)); };
    for (const s of roads.segments) {
      // sqrt ramp like the price layer: a few trunk routes would otherwise wash every other street out to green
      seg.push({ x: s.wx, z: s.wz, ry: s.horizontal ? 0 : Math.PI / 2, s: 1, color: traffic ? heat(Math.sqrt(s.traffic), new THREE.Color()) : ASPHALT });
      bump(s.i, s.j, s.traffic);
      if (s.horizontal) bump(s.i + 1, s.j, s.traffic); else bump(s.i, s.j + 1, s.traffic);
    }
    const node: Inst[] = [];
    const cap: Inst[] = [];
    const crossing: Inst[] = [];
    for (const n of roads.nodes) {
      node.push({ x: n.wx, z: n.wz, ry: 0, s: 1, color: traffic ? heat(Math.sqrt(nodeHeat.get(n.j * (width + 2) + n.i) ?? 0), new THREE.Color()) : ASPHALT });
      // roadCap closes the -z side (n); rotate it onto every side without a street — except outward arms on
      // the map boundary, where the town's perimeter streets carry on
      if (!n.n && n.j !== 0) cap.push({ x: n.wx, z: n.wz, ry: 0, s: 1, color: WHITE });
      if (!n.s && n.j !== height) cap.push({ x: n.wx, z: n.wz, ry: Math.PI, s: 1, color: WHITE });
      if (!n.e && n.i !== width) cap.push({ x: n.wx, z: n.wz, ry: -Math.PI / 2, s: 1, color: WHITE });
      if (!n.w && n.i !== 0) cap.push({ x: n.wx, z: n.wz, ry: Math.PI / 2, s: 1, color: WHITE });
      // zebras only where streets actually meet (3+ arms), not on bends and dead ends; geometry faces +x (e)
      if (+n.n + +n.s + +n.e + +n.w < 3) continue;
      if (n.e) crossing.push({ x: n.wx, z: n.wz, ry: 0, s: 1, color: WHITE });
      if (n.w) crossing.push({ x: n.wx, z: n.wz, ry: Math.PI, s: 1, color: WHITE });
      if (n.s) crossing.push({ x: n.wx, z: n.wz, ry: -Math.PI / 2, s: 1, color: WHITE });
      if (n.n) crossing.push({ x: n.wx, z: n.wz, ry: Math.PI / 2, s: 1, color: WHITE });
    }
    // on the south-east corner sidewalk, arm reaching over the intersection
    const lamp = roads.lamps.map(([x, z]): Inst => ({ x: x + CURB, z: z + CURB, ry: (3 * Math.PI) / 4, s: 1, color: WHITE }));
    return { seg, node, cap, crossing, lamp };
  }, [roads, layer, width, height]);

  // Natural features only change when a tile gets developed or claimed, or the street layout changes: key on that, not on every tick's snapshot.
  const landKey = useMemo(() => tiles.map((t) => `${t.res ?? "-"}${t.building ? "b" : t.owner ? "o" : "_"}`).join(""), [tiles]);
  const roadKey = useMemo(() => roads.segments.map((s) => (s.j * (width + 1) + s.i) * 2 + (s.horizontal ? 1 : 0)).join(","), [roads, width]);
  const land = useMemo(() => natural(tiles, width, height, roads.hasRoad), [landKey, roadKey, width, height]);
  const lf = landforms(tiles, width, height);
  const lakes = useMemo(() => lakeGeometries(lf), [lf]);
  const pits = useMemo(() => pitGeometry(lf), [lf]);
  useEffect(() => () => { lakes.bed.dispose(); lakes.water.dispose(); }, [lakes]);
  useEffect(() => () => pits.geo.dispose(), [pits]);
  useEffect(() => () => land.fields.dispose(), [land]);
  const broadleaf = useMemo(() => [...land.broadleaf, ...lakes.trees], [land, lakes]);
  const bush = useMemo(() => [...land.bush, ...lakes.bushes], [land, lakes]);

  const nature = layer === "world";

  return (
    <group>
      <InstanceSet geometry={geos.roadSeg} material={material} items={street.seg} />
      <InstanceSet geometry={geos.roadNode} material={material} items={street.node} />
      <InstanceSet geometry={geos.roadCap} material={material} items={street.cap} />
      <InstanceSet geometry={geos.crossing} material={material} items={street.crossing} />
      <InstanceSet geometry={geos.lamp} material={material} items={street.lamp} shadows />
      <group visible={nature}>
        <mesh geometry={lakes.bed} material={bedMaterial} receiveShadow raycast={() => null} />
        <mesh geometry={lakes.water} material={waterMaterial()} raycast={() => null} />
        <mesh geometry={pits.geo} material={bedMaterial} receiveShadow raycast={() => null} />
        <mesh geometry={land.fields} material={fieldMaterial()} receiveShadow raycast={() => null} />
        <InstanceSet geometry={nat.broadleaf} material={material} items={broadleaf} shadows />
        <InstanceSet geometry={nat.conifer} material={material} items={land.conifer} shadows />
        <InstanceSet geometry={nat.bush} material={material} items={bush} />
        <InstanceSet geometry={nat.hedge} material={material} items={land.hedge} shadows />
        <InstanceSet geometry={nat.reeds} material={material} items={lakes.reeds} />
        <InstanceSet geometry={nat.heap} material={material} items={pits.heaps} shadows />
        <InstanceSet geometry={nat.oilPad} material={material} items={land.oilPad} />
      </group>
      <InstanceSet geometry={nat.pumpjack} material={material} items={land.pumpjack} shadows />
      <InstanceSet geometry={nat.pumpBeam} material={rockingMaterial()} items={land.pumpBeam} />
      <InstanceSet geometry={nat.derrick} material={material} items={land.derrick} shadows />
    </group>
  );
}

/** Local offset (ox, oz) rotated by yaw `ry` (matching Object3D.rotation.y) and added to (wx, wz). */
function place(wx: number, wz: number, ox: number, oz: number, ry: number): [number, number] {
  const c = Math.cos(ry), s = Math.sin(ry);
  return [wx + ox * c + oz * s, wz - ox * s + oz * c];
}

/** Trunks stay this far (tile units) from a street axis: clear of asphalt and sidewalk. */
const TRUNK_CLEAR = 0.2;

/**
 * Deterministic scatter for undeveloped deposits. Woodland: jittered 5×5
 * candidates per forest tile kept by a blurred, domain-warped forest density,
 * so the canopy is dense inside, thins and breaks up across the forest's
 * edge (bushes at the fringe), leaves clearings, and drops a few outliers on
 * the verges of neighbouring open meadow; heights vary with density.
 * Farmland: the patchwork mesh + hedgerows from `farmland`. Oil: a pad with
 * a pumpjack (sometimes a derrick) per tile. Streets stay clear.
 */
function natural(tiles: Tile[], width: number, height: number, hasRoad: HasRoad) {
  const out = {
    broadleaf: [] as Inst[], conifer: [] as Inst[], bush: [] as Inst[], hedge: [] as Inst[],
    oilPad: [] as Inst[], pumpjack: [] as Inst[], pumpBeam: [] as Inst[], derrick: [] as Inst[],
  };
  const grid: (Tile | undefined)[] = new Array(width * height);
  for (const t of tiles) grid[t.y * width + t.x] = t;
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < width && y < height ? grid[y * width + x] : undefined);
  const isRes = (x: number, y: number, res: string) => { const t = at(x, y); return !!t && !t.building && t.res === res; };
  const forest = (x: number, y: number) => isRes(x, y, "forest");
  const meadowFree = (x: number, y: number) => { const t = at(x, y); return !!t && !t.building && !t.owner && !t.res; };

  const tree = (u: number, v: number, density: number, salt: number) => {
    const [x, z] = cornerToWorld(u, v, width, height);
    const iu = Math.round(u * 61), iv = Math.round(v * 61);
    const h = hash2(iu, iv, salt), ry = h * 6.28;
    if (density < 0.55 && h < 0.5) { out.bush.push({ x, z, ry, s: 0.8 + h * 0.9, color: BROAD_TINT[Math.floor(h * 6) % 3] }); return; }
    const s = 0.6 + density * 0.55 + hash2(iu, iv, salt + 1) * 0.35;
    const sy = 0.8 + hash2(iu, iv, salt + 2) * 0.55;
    if (hash2(iu, iv, salt + 3) < vnoise(u / 3.5, v / 3.5, 90) * 1.25 - 0.15) {
      out.conifer.push({ x, z, ry, s: s * 1.05, sy: sy * 1.15, color: CONIFER_TINT[Math.floor(hash2(iu, iv, salt + 4) * CONIFER_TINT.length)] });
    } else {
      out.broadleaf.push({ x, z, ry, s, sy, color: BROAD_TINT[hash2(iu, iv, salt + 5) < 0.04 ? 4 : Math.floor(hash2(iu, iv, salt + 6) * 4)] });
    }
  };
  const density = (u: number, v: number) => {
    const wu = u + (vnoise(u * 0.9, v * 0.9, 180) - 0.5) * 0.5, wv = v + (vnoise(u * 0.9, v * 0.9, 181) - 0.5) * 0.5;
    return blurTiles(forest, wu, wv, 0.3) - smoothstep(vnoise(u * 1.1, v * 1.1, 182), 0.72, 0.9) * 0.45;
  };

  const farmTiles: [number, number][] = [];
  for (const t of tiles) {
    if (t.building) continue;
    const [wx, wz] = tileToWorld(t.x, t.y, width, height);
    switch (t.res) {
      case "forest": {
        for (let k = 0; k < 25; k++) {
          const gx = k % 5, gy = (k - gx) / 5;
          const u = t.x + (gx + 0.5) / 5 + (hash2(t.x * 5 + gx, t.y * 5 + gy, 96) - 0.5) * 0.17;
          const v = t.y + (gy + 0.5) / 5 + (hash2(t.x * 5 + gx, t.y * 5 + gy, 97) - 0.5) * 0.17;
          if (roadDistance(hasRoad, width, height, u, v) < TRUNK_CLEAR) continue;
          const d = density(u, v);
          if (d < 0.3 + hash2(t.x * 5 + gx, t.y * 5 + gy, 98) * 0.4) continue;
          tree(u, v, d, 100);
        }
        // outliers onto the verges of open meadow next door (never across a street)
        const sides: [number, number, number, boolean][] = [[0, -1, t.y, true], [0, 1, t.y + 1, true], [-1, 0, t.x, false], [1, 0, t.x + 1, false]];
        for (const [dx, dy, line, horizontal] of sides) {
          if (!meadowFree(t.x + dx, t.y + dy) || hasRoad(horizontal ? t.x : line, horizontal ? line : t.y, horizontal)) continue;
          for (let k = 0; k < 3; k++) {
            const h = hash2(t.x * 4 + dx + 2, t.y * 4 + dy + 2, 110 + k);
            if (h > 0.4) continue;
            const along = (k + 0.2 + hash2(t.x, t.y, 120 + k + dx * 3 + dy * 7) * 0.6) / 3;
            const into = 0.01 + h * 0.15;
            const u = horizontal ? t.x + along : line + dx * into, v = horizontal ? line + dy * into : t.y + along;
            if (roadDistance(hasRoad, width, height, u, v) < TRUNK_CLEAR) continue;
            tree(u, v, 0.4, 130);
          }
        }
        break;
      }
      case "fertile":
        farmTiles.push([t.x, t.y]);
        break;
      case "oil": {
        const ry = Math.floor(hash2(t.x, t.y, 1) * 4) * (Math.PI / 2);
        out.oilPad.push({ x: wx, z: wz, ry, s: 1, color: WHITE });
        const paint = PUMP_PAINT[Math.floor(hash2(t.x, t.y, 106) * PUMP_PAINT.length)];
        const [px, pz] = place(wx, wz, 0.3, -0.22, ry);
        out.pumpjack.push({ x: px, z: pz, ry, s: 1, color: paint });
        out.pumpBeam.push({ x: px, z: pz, y: PUMP_PIVOT, ry, s: 1, color: paint });
        if (hash2(t.x, t.y, 3) > 0.55) {
          const [dx, dz] = place(wx, wz, -0.45, -0.38, ry);
          out.derrick.push({ x: dx, z: dz, ry, s: 0.9, color: WHITE });
        }
        break;
      }
    }
  }
  const farm = farmland((x, y) => isRes(x, y, "fertile"), farmTiles, width, height, hasRoad);
  out.hedge.push(...farm.hedges);
  out.broadleaf.push(...farm.trees);
  return { ...out, fields: farm.geo };
}

/**
 * One instanced draw for a list of placements. Capacity grows in powers of
 * two (remounting the mesh) so a tick that adds a few instances only
 * rewrites matrices.
 */
export function InstanceSet({ geometry, material, items, shadows = false }: { geometry: THREE.BufferGeometry; material: THREE.Material; items: readonly Inst[]; shadows?: boolean }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const cap = Math.max(16, 2 ** Math.ceil(Math.log2(Math.max(1, items.length))));

  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    items.forEach((it, i) => {
      dummy.position.set(it.x, it.y ?? 0, it.z);
      dummy.rotation.set(0, it.ry, 0);
      dummy.scale.set(it.s, it.s * (it.sy ?? 1), it.s * (it.sz ?? 1));
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
      m.setColorAt(i, it.color);
    });
    m.count = items.length;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere();
  }, [items, cap]);

  return <instancedMesh key={cap} ref={ref} args={[geometry, material, cap]} castShadow={shadows} receiveShadow raycast={() => null} />;
}
