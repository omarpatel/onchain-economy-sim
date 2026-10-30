"use client";

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { ThreeEvent } from "@react-three/fiber";
import type { EconomySnapshot } from "@econ-sim/sim/snapshot";
import { GRASS, HEAT, OUTLINE, TILE, TOWN_RING, MAP_MARGIN, cornerToWorld, ringDist, tileToWorld, worldToTile } from "./world-style.ts";
import { RES, RIM_COLOR, SUB_I, featureGeometries, landforms, meadow } from "./features.ts";
import { companyColor } from "../../lib/palette.ts";
import { useUi, type Layer } from "../../lib/store.ts";

type Tile = EconomySnapshot["world"]["tiles"][number];

/** Tiles of ground beyond the map edge on every side (town ring + landscape). */
export const MARGIN = MAP_MARGIN;

const dummy = new THREE.Object3D();
const color = new THREE.Color();
const tmp = new THREE.Color();
const grass = GRASS.map((c) => new THREE.Color(c));
const heatStops = HEAT.map((c) => new THREE.Color(c));
const MINE = new THREE.Color(OUTLINE.mine);
const DIM = new THREE.Color("#5e6b52");
const RIM = RIM_COLOR.map((c) => new THREE.Color(c));
/** World-view ground tints: built yards, graded empty lots, woodland floor, ploughed soil, oil-field dust, fresh unclaimed meadow. */
const YARD = new THREE.Color("#bdb4a0");
const LOT = new THREE.Color("#b9a47f");
const FOREST_FLOOR = new THREE.Color("#4a6e3c");
/** Grass headland showing around the irregular edge of the crop patchwork. */
const HEADLAND = new THREE.Color("#86a75a");
const OIL_GROUND = new THREE.Color("#8d8574");
const FRESH = new THREE.Color("#9cc06a");
/** Lattice fraction of each in-map tile's 4×4 vertex grid (outer verge, inner plot). */
const SUB_F = SUB_I.map((i) => i / RES);

/** Green → yellow → red. */
export function heat(t: number, out: THREE.Color): THREE.Color {
  const k = Math.max(0, Math.min(1, t));
  return k < 0.5 ? out.copy(heatStops[0]).lerp(heatStops[1], k * 2) : out.copy(heatStops[1]).lerp(heatStops[2], (k - 0.5) * 2);
}

/**
 * The flat ground of the map and the town ring (the landscape beyond is
 * `Landscape`). Each in-map tile is a 3×3 grid of quads: a thin verge whose
 * colour is shared with the neighbours (so plots blend instead of tiling)
 * around the plot itself, which takes the parcel's state — fresh meadow if
 * unclaimed, graded earth once owned, a paved yard once built. Undeveloped
 * lakes and open pits are cut out of the mesh and filled by their landform
 * meshes. Heat layers recolour whole tiles with a darker grout. Your parcels
 * get a glowing mint outline; other owners' outlines only show in the
 * ownership layer. Picking uses a separate flat quad.
 */
export function Terrain({ snap, youCompany, onTileClick }: { snap: EconomySnapshot; youCompany: string | null; onTileClick: (t: Tile) => void }) {
  const { width, height, tiles } = snap.world;
  const layer = useUi((s) => s.layer);
  const setHover = useUi((s) => s.setHover);
  const edgesRef = useRef<THREE.InstancedMesh>(null);
  const premiumRef = useRef<THREE.InstancedMesh>(null);
  const hoverRef = useRef<THREE.Mesh>(null);
  const geos = featureGeometries();
  const lf = landforms(tiles, width, height);

  // Static vertex layout + the meadow under every layer: 16 vertices per in-map tile, 4 per town-ring tile.
  const ground = useMemo(() => {
    const ring: [number, number][] = [];
    for (let y = -TOWN_RING; y < height + TOWN_RING; y++) {
      for (let x = -TOWN_RING; x < width + TOWN_RING; x++) if (ringDist(x, y, width, height) > 0) ring.push([x, y]);
    }
    const verts = width * height * 16 + ring.length * 4;
    const pos = new Float32Array(verts * 3);
    const base = new Float32Array(verts * 3);
    let p = 0;
    const put = (u: number, v: number) => {
      const [wx, wz] = cornerToWorld(u, v, width, height);
      meadow(u, v, tmp);
      base[p] = tmp.r; base[p + 1] = tmp.g; base[p + 2] = tmp.b;
      pos[p++] = wx; pos[p++] = 0; pos[p++] = wz;
    };
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let b = 0; b < 4; b++) for (let a = 0; a < 4; a++) put(x + SUB_F[a], y + SUB_F[b]);
    for (const [x, y] of ring) { put(x, y); put(x + 1, y); put(x + 1, y + 1); put(x, y + 1); }
    const normals = new Float32Array(verts * 3);
    for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    g.setAttribute("color", new THREE.BufferAttribute(base.slice(), 3));
    g.computeBoundingSphere();
    return { g, base, ringCount: ring.length };
  }, [width, height]);

  useEffect(() => () => ground.g.dispose(), [ground]);

  // Carved landforms leave holes in the world view; analysis layers paint every tile.
  const carve = layer === "world";
  useEffect(() => {
    const idx: number[] = [];
    const cw = width * RES;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v0 = (y * width + x) * 16;
        for (let sy = 0; sy < 3; sy++) {
          for (let sx = 0; sx < 3; sx++) {
            if (carve && lf.cell[(y * RES + SUB_I[sy]) * cw + x * RES + SUB_I[sx]] !== 0) continue;
            const a = v0 + sy * 4 + sx;
            idx.push(a, a + 4, a + 5, a, a + 5, a + 1);
          }
        }
      }
    }
    const r0 = width * height * 16;
    for (let k = 0; k < ground.ringCount; k++) {
      const v = r0 + k * 4;
      idx.push(v, v + 3, v + 2, v, v + 2, v + 1);
    }
    ground.g.setIndex(idx);
  }, [ground, lf, carve, width, height]);

  // Per-vertex colours: parcel state over the meadow, or the active heat layer.
  useEffect(() => {
    const attr = ground.g.getAttribute("color") as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const { base } = ground;
    arr.set(base);
    const n = width * height;
    const ov = new Float32Array(n * 4);
    let maxPrice = 1;
    if (layer === "price") for (const t of tiles) maxPrice = Math.max(maxPrice, t.priceCr);
    for (const t of tiles) {
      const w = layer === "world" ? worldTint(t, lf.kind[t.y * width + t.x], color) : (tileOverride(t, layer, youCompany, maxPrice, color), 1);
      const o = (t.y * width + t.x) * 4;
      ov[o] = color.r * w; ov[o + 1] = color.g * w; ov[o + 2] = color.b * w; ov[o + 3] = w;
    }

    if (layer === "world") {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          for (let b = 0; b < 4; b++) {
            const ys = b === 0 ? [y - 1, y] : b === 3 ? [y, y + 1] : [y];
            for (let a = 0; a < 4; a++) {
              const xs = a === 0 ? [x - 1, x] : a === 3 ? [x, x + 1] : [x];
              let r = 0, g = 0, bl = 0, wsum = 0, slots = 0, k = -1;
              for (const ty of ys) {
                for (const tx of xs) {
                  slots++;
                  if (tx < 0 || ty < 0 || tx >= width || ty >= height) { k = 0; continue; }
                  const ti = ty * width + tx, o = ti * 4;
                  r += ov[o]; g += ov[o + 1]; bl += ov[o + 2]; wsum += ov[o + 3];
                  const kk = lf.kind[ti];
                  k = k === -1 ? kk : k === kk ? k : 0;
                }
              }
              const i = ((y * width + x) * 16 + b * 4 + a) * 3;
              if (k > 0) { arr[i] = RIM[k].r; arr[i + 1] = RIM[k].g; arr[i + 2] = RIM[k].b; continue; }
              const keep = 1 - wsum / slots;
              arr[i] = arr[i] * keep + r / slots;
              arr[i + 1] = arr[i + 1] * keep + g / slots;
              arr[i + 2] = arr[i + 2] * keep + bl / slots;
            }
          }
        }
      }
    } else {
      for (let ti = 0; ti < n; ti++) {
        const o = ti * 4;
        for (let v = 0; v < 16; v++) {
          const a = v & 3, b = v >> 2;
          const grout = a === 0 || a === 3 || b === 0 || b === 3 ? 0.8 : 1;
          const i = (ti * 16 + v) * 3;
          arr[i] = ov[o] * grout; arr[i + 1] = ov[o + 1] * grout; arr[i + 2] = ov[o + 2] * grout;
        }
      }
      // fade the town ring so the analysed map stands out
      for (let i = n * 16 * 3; i < arr.length; i += 3) {
        tmp.setRGB(arr[i], arr[i + 1], arr[i + 2]).lerp(DIM, 0.45);
        arr[i] = tmp.r; arr[i + 1] = tmp.g; arr[i + 2] = tmp.b;
      }
    }
    attr.needsUpdate = true;
  }, [tiles, layer, youCompany, ground, lf, width, height]);

  // Parcel outlines: one strip per owned tile edge that isn't shared with the same owner.
  const grid = useMemo(() => {
    const m: (Tile | undefined)[] = new Array(width * height);
    for (const t of tiles) m[t.y * width + t.x] = t;
    return m;
  }, [tiles, width, height]);

  useEffect(() => {
    const m = edgesRef.current;
    if (!m) return;
    const half = TILE / 2 - 0.3;
    let n = 0;
    const ownership = layer === "ownership";
    for (const t of tiles) {
      if (!t.owner) continue;
      const mine = t.owner === youCompany;
      // the world (and heat) views outline only your land; everyone's shows in the ownership layer
      if (!mine && !ownership) continue;
      const [wx, wz] = tileToWorld(t.x, t.y, width, height);
      if (mine) color.copy(MINE).multiplyScalar(ownership ? 2.4 : layer === "world" ? 1.9 : 1.2);
      else color.set(companyColor(t.owner)).multiplyScalar(1.3);
      const sides: [number, number, number, number][] = [
        [t.x, t.y - 1, 0, -half], [t.x, t.y + 1, 0, half], [t.x - 1, t.y, Math.PI / 2, -half], [t.x + 1, t.y, Math.PI / 2, half],
      ];
      for (const [nx, ny, rot, off] of sides) {
        const inside = nx >= 0 && ny >= 0 && nx < width && ny < height;
        if (inside && grid[ny * width + nx]?.owner === t.owner) continue;
        if (n >= m.instanceMatrix.count) break;
        dummy.position.set(wx + (rot === 0 ? 0 : off), 0, wz + (rot === 0 ? off : 0));
        dummy.rotation.set(0, rot, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        m.setMatrixAt(n, dummy.matrix);
        m.setColorAt(n, color);
        n++;
      }
    }
    m.count = n;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere();

    const pm = premiumRef.current;
    if (pm) {
      let k = 0;
      color.set(OUTLINE.premium);
      for (const t of tiles) {
        if (!t.premium || k >= pm.instanceMatrix.count) continue;
        const [wx, wz] = tileToWorld(t.x, t.y, width, height);
        dummy.position.set(wx, 0.005, wz);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(0.9, 1, 0.9);
        dummy.updateMatrix();
        pm.setMatrixAt(k, dummy.matrix);
        pm.setColorAt(k, color);
        k++;
      }
      pm.count = k;
      pm.instanceMatrix.needsUpdate = true;
      if (pm.instanceColor) pm.instanceColor.needsUpdate = true;
      pm.computeBoundingSphere();
    }
  }, [tiles, grid, width, height, youCompany, layer]);

  // Hover frame follows the store without re-rendering React.
  useEffect(() => useUi.subscribe((s, prev) => {
    if (s.hoverTile === prev.hoverTile || !hoverRef.current) return;
    const h = hoverRef.current;
    const t = s.hoverTile ? tiles.find((x) => x.id === s.hoverTile) : undefined;
    if (!t) { h.visible = false; return; }
    const [wx, wz] = tileToWorld(t.x, t.y, width, height);
    h.position.set(wx, 0.01, wz);
    h.visible = true;
  }), [tiles, width, height]);

  const pick = (e: ThreeEvent<PointerEvent | MouseEvent>): Tile | undefined => {
    const [tx, ty] = worldToTile(e.point.x, e.point.z, width, height);
    if (tx < 0 || ty < 0 || tx >= width || ty >= height) return undefined;
    return grid[ty * width + tx];
  };

  const extent = (Math.max(width, height) + 2) * TILE;

  return (
    <group>
      <mesh geometry={ground.g} receiveShadow raycast={() => null}>
        <meshStandardMaterial vertexColors roughness={1} metalness={0} />
      </mesh>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[-TILE / 2, 0, -TILE / 2]}
        visible={false}
        onPointerMove={(e) => { e.stopPropagation(); const t = pick(e); setHover(t ? t.id : null); }}
        onPointerOut={() => setHover(null)}
        onClick={(e) => { e.stopPropagation(); const t = pick(e); if (t) onTileClick(t); }}
      >
        <planeGeometry args={[extent, extent]} />
        <meshBasicMaterial />
      </mesh>

      <instancedMesh ref={edgesRef} args={[geos.edge, undefined, tiles.length * 2]} frustumCulled={false} raycast={() => null}>
        <meshBasicMaterial vertexColors toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={premiumRef} args={[geos.frame, undefined, 128]} frustumCulled={false} raycast={() => null}>
        <meshBasicMaterial vertexColors toneMapped={false} />
      </instancedMesh>
      <mesh ref={hoverRef} geometry={geos.frame} visible={false} raycast={() => null} scale={[1.04, 1, 1.04]}>
        <meshBasicMaterial color={[2.2, 2.2, 2.2]} toneMapped={false} />
      </mesh>
    </group>
  );
}

/**
 * World-view tint of a tile's plot into `out`; returns its weight (0..1).
 * Natural features keep their ground even when owned; otherwise ownership
 * shows as a graded lot and development as a paved yard.
 */
function worldTint(t: Tile, carve: number, out: THREE.Color): number {
  if (carve) { out.copy(RIM[carve]); return 1; }
  if (t.building) { out.copy(YARD); return 0.85; }
  // soft tints only: woodland and fields draw their own feathered/irregular edges over the plot
  if (t.res === "forest") { out.copy(FOREST_FLOOR); return 0.4; }
  if (t.res === "fertile") { out.copy(HEADLAND); return 0.35; }
  if (t.res === "oil") { out.copy(OIL_GROUND); return 0.45; }
  if (t.owner) { out.copy(LOT); return 0.82; }
  out.copy(FRESH);
  return 0.14;
}

/** Colour a tile takes under an analysis layer (heat layers replace the ground outright). */
function tileOverride(t: Tile, layer: Layer, you: string | null, maxPrice: number, out: THREE.Color): void {
  switch (layer) {
    case "world":
    case "ownership":
      if (t.owner) out.set(t.owner === you ? OUTLINE.mine : companyColor(t.owner)).lerp(DIM, 0.35);
      else out.copy(DIM).lerp(grass[0], 0.5);
      return;
    case "price":
      heat(Math.sqrt(t.priceCr / maxPrice), out);
      return;
    case "richness":
      if (t.res) heat(Math.min(1, t.rich / 2), out); else out.copy(DIM);
      return;
    case "utilization":
      if (t.building?.live) heat(t.building.utilization, out); else out.copy(DIM).lerp(grass[0], 0.4);
      return;
    case "traffic":
    case "logistics":
      out.copy(DIM).lerp(grass[0], 0.5);
      return;
  }
}
