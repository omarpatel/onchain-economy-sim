"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { natureGeometries, fbm, meadow, vnoise, waterMaterial } from "./features.ts";
import { BROAD_TINT, CONIFER_TINT, InstanceSet, useLandClock, type Inst } from "./Features.tsx";
import { tintedStandardMaterial } from "./geometry.ts";
import { ROAD, SEA_LEVEL, SEA_START, TILE, TOWN_RING, MAP_MARGIN, cornerToWorld, hash2 } from "./world-style.ts";

const { smoothstep } = THREE.MathUtils;

/** Grid-line offsets (tiles) of the coarse skirt beyond MAP_MARGIN, reaching the camera's far plane so fog, not an edge, ends the world. */
const SKIRT = [3, 7, 12, 19, 28, 40, 56, 78, 106, 145, 200, 275];
/** Town boulevards leave the ring on the map's centre lines; country roads carry them on toward the mountains. */
const ROAD_HALF = { exit: 0.75, country: 0.42 } as const;

const FOREST_FLOOR = new THREE.Color("#3d6234");
const ROCK = new THREE.Color("#8b8274");
const ROCK_DARK = new THREE.Color("#6d665c");
const SNOW = new THREE.Color("#eef2f5");
const SAND = new THREE.Color("#e2cd98");
const WET_SAND = new THREE.Color("#b9a678");
const SEABED = new THREE.Color("#5f8a86");
const ROAD_COLOR = new THREE.Color("#5d5850");
const VERGE = new THREE.Color(ROAD.walkColor);
const PORTAL = new THREE.Color("#9c9384");
const PORTAL_DARK = new THREE.Color("#1d1b19");
const CROPS = ["#d4b65a", "#e0cc88", "#8fbd57", "#6aa34a", "#e4d24c", "#a08bc6", "#93704c", "#b8c46a"].map((c) => new THREE.Color(c));

interface Built {
  ground: THREE.BufferGeometry;
  sea: THREE.BufferGeometry;
  broadleaf: Inst[];
  conifer: Inst[];
}

/**
 * Everything beyond the town ring (ring distance > TOWN_RING): meadows and
 * patchwork farmland that roll into wooded hills, ridged mountains with
 * rock and snow toward the horizon, country roads that carry the town's
 * boulevards up valleys into tunnel portals, and to the south the sea —
 * sandy beaches either side of the harbour, islets offshore — out to the far
 * plane where fog dissolves it into the sky. One faceted ground mesh (roads
 * and portals merged in), one animated water sheet and two LOD tree sets.
 */
export function Landscape({ width, height }: { width: number; height: number }) {
  const nat = natureGeometries();
  const built = useMemo(() => buildLandscape(width, height), [width, height]);
  useEffect(() => () => { built.ground.dispose(); built.sea.dispose(); }, [built]);
  const groundMat = useMemo(() => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0, flatShading: true }), []);
  const treeMat = useMemo(() => tintedStandardMaterial({ roughness: 0.9 }), []);
  useEffect(() => () => { groundMat.dispose(); treeMat.dispose(); }, [groundMat, treeMat]);
  useLandClock();

  return (
    <group>
      <mesh geometry={built.ground} material={groundMat} receiveShadow raycast={() => null} />
      <mesh geometry={built.sea} material={waterMaterial()} raycast={() => null} />
      <InstanceSet geometry={nat.farBroadleaf} material={treeMat} items={built.broadleaf} />
      <InstanceSet geometry={nat.farConifer} material={treeMat} items={built.conifer} />
    </group>
  );
}

/** A polyline in grid-corner coordinates (tiles). */
type Path = [number, number][];

/** Squared distance from (u, v) to the nearest point of any path, in tiles². */
function pathDist2(paths: readonly Path[], u: number, v: number): number {
  let best = Infinity;
  for (const p of paths) {
    for (let k = 0; k < p.length - 1; k++) {
      const [ax, ay] = p[k], [bx, by] = p[k + 1];
      const dx = bx - ax, dy = by - ay;
      const t = Math.max(0, Math.min(1, ((u - ax) * dx + (v - ay) * dy) / (dx * dx + dy * dy)));
      const ex = ax + dx * t - u, ey = ay + dy * t - v;
      best = Math.min(best, ex * ex + ey * ey);
    }
  }
  return best;
}

function buildLandscape(W: number, Hh: number): Built {
  const M = MAP_MARGIN;
  const dOut = (u: number, v: number) => Math.max(0, -u, u - W, -v, v - Hh);
  const quay = Hh + SEA_START - 1;
  const spanLo = -TOWN_RING, spanHi = W + TOWN_RING;

  // Country roads from the three boulevard exits (north, west, east), meandering after a straight run-out.
  const roads: Path[] = [];
  const legs = M - TOWN_RING;
  const meander = (k: number, salt: number) => (fbm(k / 9, 0.37, salt, 2) - 0.5) * 18 * smoothstep(k, 3, 12);
  const north: Path = [], west: Path = [], east: Path = [];
  for (let k = 0; k <= legs; k++) {
    north.push([W / 2 + meander(k, 610), -TOWN_RING - k]);
    west.push([-TOWN_RING - k, Hh / 2 + meander(k, 620)]);
    east.push([W + TOWN_RING + k, Hh / 2 + meander(k, 630)]);
  }
  roads.push(north, west, east);

  /** South-coast waterline (corner v) at column u: the quay across the town, wandering beaches beyond. */
  const coastV = (u: number) => {
    const out = u < spanLo ? spanLo - u : u > spanHi ? u - spanHi : 0;
    return quay + smoothstep(out, 0, 9) * ((fbm(u / 11, 0.5, 200, 3) - 0.5) * 16 - 2.5);
  };

  const heightAt = (u: number, v: number): number => {
    const d = dOut(u, v);
    const s = v - coastV(u);
    const inSpan = u >= spanLo && u <= spanHi;
    if (s > 0) {
      const bed = inSpan ? -0.6 - Math.min(s, 6) * 0.4 : SEA_LEVEL - 0.08 - Math.min(s, 9) * 0.28;
      // rocky islets well offshore
      const isle = smoothstep(fbm(u / 9, v / 9, 700, 3), 0.62, 0.8) * smoothstep(s, 7, 12) * (1 - smoothstep(d, 60, 80));
      return bed + isle * (Math.abs(bed) + 1.5 + fbm(u / 3, v / 3, 710, 2) * 5);
    }
    const inland = -s;
    const beach = inSpan ? 0 : 1 - smoothstep(inland, 0, 2.4);
    const shore = (SEA_LEVEL - 0.08) * beach;
    const hills = Math.max(0, fbm(u / 7, v / 7, 300, 3) - 0.32) * 5.5 * smoothstep(d, 17, 26);
    const ridge = 1 - Math.abs(fbm(u / 12, v / 12, 310, 4) * 2 - 1);
    const mountains = (Math.pow(ridge, 1.7) * 30 + fbm(u / 4, v / 4, 320, 2) * 7) * smoothstep(d, 25, 40) * (1 - 0.55 * smoothstep(d, 90, 220));
    let h = (hills + mountains) * smoothstep(inland, 2.4, 9 + 10 * smoothstep(d, 25, 40));
    // roads keep a valley floor until the portal at the margin
    if (d < M + 1.2 && h > 0.05) {
      const valley = 1 - smoothstep(Math.sqrt(pathDist2(roads, u, v)), 0.7, 5);
      h *= 1 - valley * 0.94 * (1 - smoothstep(d, M - 0.4, M + 1.1));
    }
    return shore + h;
  };

  // Tensor grid: tile resolution out to the margin, then the expanding skirt.
  const axis = (n: number) => {
    const lines: number[] = [];
    for (let k = SKIRT.length - 1; k >= 0; k--) lines.push(-M - SKIRT[k]);
    for (let i = -M; i <= n + M; i++) lines.push(i);
    for (const k of SKIRT) lines.push(n + M + k);
    return lines;
  };
  const U = axis(W), V = axis(Hh);
  const NU = U.length, NV = V.length;
  const hgt = new Float32Array(NU * NV);
  const col = new Float32Array(NU * NV * 3);
  const c = new THREE.Color();
  const forestAt = (u: number, v: number) => fbm(u / 8, v / 8, 500, 3) + smoothstep(dOut(u, v), 22, 34) * 0.08;
  for (let j = 0; j < NV; j++) {
    for (let i = 0; i < NU; i++) {
      const u = U[i], v = V[j];
      const h = heightAt(u, v);
      hgt[j * NU + i] = h;
      meadow(u, v, c);
      const d = dOut(u, v);
      if (d > TOWN_RING + 0.5) {
        if (forestAt(u, v) > 0.53 && h < 17) c.lerp(FOREST_FLOOR, 0.7);
        const rough = vnoise(u / 2.5, v / 2.5, 520);
        c.lerp(rough > 0.5 ? ROCK : ROCK_DARK, smoothstep(h + (rough - 0.5) * 5, 7, 15) * 0.92);
        c.lerp(SNOW, smoothstep(h + (vnoise(u / 3, v / 3, 530) - 0.5) * 7, 21, 25));
      }
      const s = v - coastV(u);
      if (s > -2.6 && (u < spanLo || u > spanHi || s > 0)) {
        if (h < SEA_LEVEL) c.copy(WET_SAND).lerp(SEABED, smoothstep(SEA_LEVEL - h, 0.1, 2.2));
        else c.lerp(h < SEA_LEVEL + 0.25 ? WET_SAND : SAND, smoothstep(s, -2.6, -1.6));
      }
      col.set([c.r, c.g, c.b], (j * NU + i) * 3);
    }
  }

  const pos: number[] = [], colors: number[] = [];
  const seaPos: number[] = [], seaShore: number[] = [];
  const broadleaf: Inst[] = [], conifer: Inst[] = [];
  const world = (u: number, v: number) => cornerToWorld(u, v, W, Hh);
  const vert = (n: number, cc?: THREE.Color) => {
    const [x, z] = world(U[n % NU], V[Math.floor(n / NU)]);
    pos.push(x, hgt[n], z);
    if (cc) colors.push(cc.r, cc.g, cc.b); else colors.push(col[n * 3], col[n * 3 + 1], col[n * 3 + 2]);
  };
  const patch = (u: number, v: number) => Math.floor((u + vnoise(u / 4, v / 4, 410) * 2.5) / 3) * 7919 + Math.floor((v + vnoise(v / 4, u / 4, 411) * 2.5) / 2);
  const fieldCell = (u: number, v: number, hs: number) => {
    const d = dOut(u + 0.5, v + 0.5);
    return d > TOWN_RING + 1 && d < 33 && hs < 2.2 && v + 0.5 - coastV(u + 0.5) < -3 && fbm(u / 6, v / 6, 400, 2) > 0.5 && forestAt(u + 0.5, v + 0.5) <= 0.53
      && pathDist2(roads, u + 0.5, v + 0.5) > 1.2;
  };
  const roadClear = (u: number, v: number) => pathDist2(roads, u, v) > 1.1;

  for (let j = 0; j < NV - 1; j++) {
    for (let i = 0; i < NU - 1; i++) {
      const u0 = U[i], v0 = V[j], u1 = U[i + 1], v1 = V[j + 1];
      if (dOut((u0 + u1) / 2, (v0 + v1) / 2) < TOWN_RING) continue;
      const a = j * NU + i, b = a + 1, e = a + NU, dd = e + 1;
      const hs = Math.max(hgt[a], hgt[b], hgt[e], hgt[dd]);
      const tile = u1 - u0 === 1 && v1 - v0 === 1;
      let face: THREE.Color | undefined;
      if (tile && fieldCell(u0, v0, hs)) {
        const p = patch(u0, v0);
        face = c.copy(CROPS[Math.floor(hash2(p, 3, 412) * CROPS.length)]).multiplyScalar(0.93 + hash2(u0, v0, 413) * 0.12);
        // hedgerow trees where the patch changes
        if (patch(u0 + 1, v0) !== p && hash2(u0, v0, 414) < 0.55) pushTree(broadleaf, u1, v0 + hash2(u0, v0, 415), hgt[b], 0.9);
        if (patch(u0, v0 + 1) !== p && hash2(u0, v0, 416) < 0.55) pushTree(broadleaf, u0 + hash2(u0, v0, 417), v1, hgt[e], 0.9);
      }
      vert(a, face); vert(e, face); vert(dd, face);
      vert(a, face); vert(dd, face); vert(b, face);

      if (Math.min(hgt[a], hgt[b], hgt[e], hgt[dd]) < SEA_LEVEL + 0.02) {
        for (const n of [a, e, dd, a, dd, b]) {
          const nu = U[n % NU], nv = V[Math.floor(n / NU)];
          const [x, z] = world(nu, nv);
          seaPos.push(x, SEA_LEVEL, z);
          // the harbour is dredged deep right up to the quay: no surf against the wall
          const harbour = nu >= spanLo && nu <= spanHi && nv >= quay ? 0.4 : 0;
          seaShore.push(Math.max(harbour, Math.min(1, (SEA_LEVEL - hgt[n]) / 1.6)));
        }
      }

      // woodland and the odd field tree, on tile cells inside the margin
      if (!tile || face) continue;
      const dense = forestAt(u0 + 0.5, v0 + 0.5) > 0.53;
      const tries = dense ? 6 : 1;
      for (let k = 0; k < tries; k++) {
        const r = hash2(u0 * 7 + k, v0 * 13 + k, 420);
        if (!dense && r > 0.05) continue;
        const fx = (k % 3 + 0.5) / 3 + (hash2(u0, v0, 421 + k) - 0.5) * 0.3;
        const fy = (Math.floor(k / 3) * 2 + 0.5) / 4 + (hash2(u0, v0, 431 + k) - 0.5) * 0.4;
        const u = u0 + fx, v = v0 + fy;
        if (dOut(u, v) < TOWN_RING + 0.7 || !roadClear(u, v)) continue;
        // height on the cell's triangle (a, e, dd) or (a, dd, b), so trunks sit on the facet
        const h = fy > fx ? hgt[a] + fy * (hgt[e] - hgt[a]) + fx * (hgt[dd] - hgt[e]) : hgt[a] + fx * (hgt[b] - hgt[a]) + fy * (hgt[dd] - hgt[b]);
        if (h < 0.08 || h > 17.5 || v - coastV(u) > -1.8) continue;
        const coniferish = h > 5 || vnoise(u / 5, v / 5, 440) > 0.6;
        if (coniferish) pushTree(conifer, u, v, h, 1.05 + hash2(u0, v0, 450 + k) * 0.6);
        else pushTree(broadleaf, u, v, h, 1 + hash2(u0, v0, 460 + k) * 0.6);
      }
    }
  }

  // Roads: a ribbon over the valley floor, widening to the boulevard at the town exit; a tunnel portal where each meets the mountain.
  for (const p of roads) {
    for (let k = 0; k < p.length - 1; k++) {
      const [ax, ay] = p[k], [bx, by] = p[k + 1];
      const len = Math.hypot(bx - ax, by - ay);
      const nxp = -(by - ay) / len, nyp = (bx - ax) / len;
      const hwA = (ROAD_HALF.country + (ROAD_HALF.exit - ROAD_HALF.country) * (1 - smoothstep(k, 0, 3))) / TILE;
      const hwB = (ROAD_HALF.country + (ROAD_HALF.exit - ROAD_HALF.country) * (1 - smoothstep(k + 1, 0, 3))) / TILE;
      const ha = heightAt(ax, ay) + 0.06, hb = heightAt(bx, by) + 0.06;
      ribbon(pos, colors, world, [ax, ay, ha, hwA * 1.35], [bx, by, hb, hwB * 1.35], nxp, nyp, VERGE, -0.012);
      ribbon(pos, colors, world, [ax, ay, ha, hwA], [bx, by, hb, hwB], nxp, nyp, ROAD_COLOR, 0);
    }
    const [ex, ey] = p[p.length - 1], [px, py] = p[p.length - 2];
    portal(pos, colors, world, ex, ey, heightAt(ex, ey) + 0.06, Math.atan2(ey - py, ex - px));
  }

  const ground = new THREE.BufferGeometry();
  ground.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  ground.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  ground.computeVertexNormals();
  ground.computeBoundingSphere();
  const sea = new THREE.BufferGeometry();
  sea.setAttribute("position", new THREE.Float32BufferAttribute(seaPos, 3));
  sea.setAttribute("normal", new THREE.Float32BufferAttribute(seaPos.map((_, k) => (k % 3 === 1 ? 1 : 0)), 3));
  sea.setAttribute("shore", new THREE.Float32BufferAttribute(seaShore, 1));
  sea.computeBoundingSphere();
  return { ground, sea, broadleaf, conifer };

  function pushTree(list: Inst[], u: number, v: number, h: number, s: number) {
    const [x, z] = world(u, v);
    const r = hash2(Math.floor(u * 31), Math.floor(v * 31), 470);
    const tints = list === conifer ? CONIFER_TINT : BROAD_TINT;
    list.push({ x, z, y: h - 0.05, ry: r * 6.28, s, color: tints[Math.floor(r * 7919) % (list === conifer ? tints.length : 4)] });
  }
}

/** Flat quad strip from end A to end B (each [u, v, y, halfWidth]) across normal (nx, ny), in grid-corner tiles. */
function ribbon(pos: number[], colors: number[], world: (u: number, v: number) => [number, number], A: number[], B: number[], nx: number, ny: number, color: THREE.Color, dy: number): void {
  const pts = [
    [A[0] + nx * A[3], A[1] + ny * A[3], A[2]], [A[0] - nx * A[3], A[1] - ny * A[3], A[2]],
    [B[0] - nx * B[3], B[1] - ny * B[3], B[2]], [B[0] + nx * B[3], B[1] + ny * B[3], B[2]],
  ];
  for (const k of [0, 1, 2, 0, 2, 3]) {
    const [x, z] = world(pts[k][0], pts[k][1]);
    pos.push(x, pts[k][2] + dy, z);
    colors.push(color.r, color.g, color.b);
  }
}

/** Stone tunnel portal facing back down the road (heading `ang` in grid space), its dark mouth swallowing the lane. */
function portal(pos: number[], colors: number[], world: (u: number, v: number) => [number, number], u: number, v: number, y: number, ang: number): void {
  const [cx, cz] = world(u, v);
  const parts: [THREE.BufferGeometry, THREE.Color][] = [
    [new THREE.BoxGeometry(2.4, 1.9, 0.9).translate(0, 0.95, 0.15), PORTAL],
    [new THREE.CylinderGeometry(0.62, 0.62, 0.04, 10, 1, false, 0, Math.PI).rotateX(Math.PI / 2).rotateZ(Math.PI / 2).translate(0, 0.85, -0.31), PORTAL_DARK],
    [new THREE.BoxGeometry(1.24, 0.85, 0.04).translate(0, 0.42, -0.31), PORTAL_DARK],
    [new THREE.BoxGeometry(2.7, 0.18, 1.05).translate(0, 1.95, 0.15), ROCK_DARK],
  ];
  // local -z (the mouth) turned to face back along the road: θ = π/2 − heading
  const m = new THREE.Matrix4().makeRotationY(Math.PI / 2 - ang).setPosition(cx, y, cz);
  for (const [g, color] of parts) {
    const ng = g.toNonIndexed().applyMatrix4(m);
    const p = ng.getAttribute("position");
    for (let i = 0; i < p.count; i++) { pos.push(p.getX(i), p.getY(i), p.getZ(i)); colors.push(color.r, color.g, color.b); }
    g.dispose();
    ng.dispose();
  }
}
