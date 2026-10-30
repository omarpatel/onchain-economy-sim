import * as THREE from "three";
import { C, box, boxUp, cone, cyl, merge, tintedStandardMaterial, tree, xf, type Part } from "./geometry.ts";
import { GRASS, GRASS_DRY, ROAD, TILE, cornerToWorld, hash2 } from "./world-style.ts";
import { GLSL_WIND, WIND_DIR, withFlex } from "./foliage.ts";
import { STYLE, stylize } from "./stylize.ts";

/**
 * Shared low-poly geometry for street pieces, street furniture, vehicles and
 * parcel outlines. Every one is rendered as a single instanced draw; parts
 * with `tint` take the per-instance colour. Natural landforms live below
 * (`natureGeometries`, `landforms`).
 */
export interface FeatureGeometries {
  tree: THREE.BufferGeometry;
  roadSeg: THREE.BufferGeometry;
  roadNode: THREE.BufferGeometry;
  roadCap: THREE.BufferGeometry;
  crossing: THREE.BufferGeometry;
  lamp: THREE.BufferGeometry;
  truck: THREE.BufferGeometry;
  ped: THREE.BufferGeometry;
  edge: THREE.BufferGeometry;
  frame: THREE.BufferGeometry;
}

/** Parcel outline geometry: strips are inset from the tile edge so they sit inside the sidewalk. */
export const EDGE = { inset: 0.3, width: 0.06 } as const;

let cache: FeatureGeometries | null = null;

export function featureGeometries(): FeatureGeometries {
  if (cache) return cache;
  const A = ROAD.asphalt;
  const W = ROAD.walk;
  const R = ROAD.width;

  // Kerb stones: a hair taller than the walk and nudged over the asphalt so their faces don't z-fight the walk's.
  const K = 0.022;
  const kerb = (w: number, d: number, x: number, z: number): Part => ({ geo: boxUp(w, 0.062, d, x, 0, z), color: ROAD.kerbColor, tint: false });
  const kz = A / 2 + K / 2 - 0.003;
  const seg = TILE - R;
  const segParts: Part[] = [
    { geo: boxUp(seg, 0.03, A, 0, 0, 0), color: "#fff", tint: true },
    { geo: boxUp(seg, 0.05, W, 0, 0, -(A / 2 + W / 2)), color: ROAD.walkColor, tint: false },
    { geo: boxUp(seg, 0.05, W, 0, 0, A / 2 + W / 2), color: ROAD.walkColor, tint: false },
    kerb(seg, K, 0, -kz),
    kerb(seg, K, 0, kz),
  ];
  // dashed centre line, kept clear of the crossings at both ends
  for (let k = -2; k <= 2; k++) segParts.push({ geo: boxUp(0.13, 0.004, 0.018, k * 0.26, 0.03, 0), color: ROAD.paintColor, tint: false });
  const roadSeg = merge(segParts);
  const nodeParts: Part[] = [{ geo: boxUp(R, 0.03, R, 0, 0, 0), color: "#fff", tint: true }];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      nodeParts.push({ geo: boxUp(W, 0.05, W, sx * (A / 2 + W / 2), 0, sz * (A / 2 + W / 2)), color: ROAD.walkColor, tint: false });
      nodeParts.push(kerb(W + K, K, sx * (A / 2 + W / 2 - K / 2), sz * kz));
      nodeParts.push(kerb(K, W, sx * kz, sz * (A / 2 + W / 2)));
    }
  }
  const roadNode = merge(nodeParts);
  // sidewalk cell closing the north side of a node with no street that way; rotated per side
  const roadCap = merge([
    { geo: boxUp(A, 0.05, W, 0, 0, -(A / 2 + W / 2)), color: ROAD.walkColor, tint: false },
    kerb(A, K, 0, -kz),
  ]);
  // zebra crossing over the +x arm of an intersection, just past the node; rotated per arm
  const crossing = merge([-2, -1, 0, 1, 2].map((k): Part => ({ geo: boxUp(0.12, 0.004, 0.032, R / 2 + 0.08, 0.03, k * 0.064), color: ROAD.paintColor, tint: false })));

  const lamp = merge([
    { geo: cyl(0.03, 0.045, 1.35, 0, 0, 0, 6), color: C.lampPost, tint: false },
    { geo: box(0.26, 0.03, 0.03, 0.11, 1.35, 0), color: C.lampPost, tint: false },
    { geo: box(0.14, 0.07, 0.12, 0.22, 1.32, 0), color: C.lampHead, tint: false, glow: true },
  ]);

  const truck = merge([
    { geo: boxUp(0.3, 0.26, 0.24, -0.08, 0.06, 0), color: "#fff", tint: true },
    { geo: boxUp(0.16, 0.2, 0.22, 0.16, 0.06, 0), color: "#e9e6df", tint: false },
    { geo: box(0.03, 0.09, 0.2, 0.245, 0.2, 0), color: C.glass, tint: false, glow: true },
    { geo: xf(new THREE.CylinderGeometry(0.05, 0.05, 0.05, 8), -0.14, 0.05, -0.12, Math.PI / 2, 0, 0), color: C.dark, tint: false },
    { geo: xf(new THREE.CylinderGeometry(0.05, 0.05, 0.05, 8), -0.14, 0.05, 0.12, Math.PI / 2, 0, 0), color: C.dark, tint: false },
    { geo: xf(new THREE.CylinderGeometry(0.05, 0.05, 0.05, 8), 0.14, 0.05, -0.12, Math.PI / 2, 0, 0), color: C.dark, tint: false },
    { geo: xf(new THREE.CylinderGeometry(0.05, 0.05, 0.05, 8), 0.14, 0.05, 0.12, Math.PI / 2, 0, 0), color: C.dark, tint: false },
  ]);

  const ped = merge([
    { geo: cyl(0.045, 0.055, 0.16, 0, 0, 0, 6), color: "#fff", tint: true },
    { geo: xf(new THREE.SphereGeometry(0.045, 6, 5), 0, 0.2, 0), color: "#e4d3b5", tint: false },
  ]);

  const strip = (rot: number, ox: number, oz: number): Part => ({ geo: xf(box(TILE - EDGE.inset * 2 + EDGE.width, 0.02, EDGE.width, 0, 0.03, 0), ox, 0, oz, 0, rot, 0), color: "#fff", tint: true });
  const half = TILE / 2 - EDGE.inset;
  const edge = merge([strip(0, 0, 0)]);
  const frame = merge([strip(0, 0, -half), strip(0, 0, half), strip(Math.PI / 2, -half, 0), strip(Math.PI / 2, half, 0)]);

  cache = {
    tree: merge(tree(0, 0, 1, true)),
    roadSeg,
    roadNode,
    roadCap,
    crossing,
    lamp,
    truck,
    ped,
    edge,
    frame,
  };
  return cache;
}

/* ───────────────────────── nature: shared noise, uniforms, materials ───────────────────────── */

const { smoothstep } = THREE.MathUtils;

/** Animated-world uniforms shared by water and pumpjacks: seconds, and the (linear) sky colour water reflects. Advanced each frame by `useLandClock`. */
export const LAND = { uTime: { value: 0 }, uSky: { value: new THREE.Color("#a9cfee") } };

/** Smooth value noise on the integer lattice → 0..1. */
export function vnoise(px: number, py: number, salt: number): number {
  const ix = Math.floor(px), iy = Math.floor(py);
  const fx = px - ix, fy = py - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, salt), b = hash2(ix + 1, iy, salt), c = hash2(ix, iy + 1, salt), d = hash2(ix + 1, iy + 1, salt);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/** Octaves of value noise (each double frequency, half weight) → 0..1. */
export function fbm(px: number, py: number, salt: number, octaves = 3): number {
  let sum = 0, norm = 0, amp = 1, f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += vnoise(px * f, py * f, salt + o * 17) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return sum / norm;
}

const grass = GRASS.map((c) => new THREE.Color(c));
const DRY = new THREE.Color(GRASS_DRY);

/**
 * Meadow colour at grid-corner coordinates (u, v) in tile units (fractional
 * is fine): 2-octave grass noise, dry straw patches on a broad noise field and
 * a faint speckle. The ground, carved landforms and the outer landscape all
 * sample it, so their shared edges meet without a seam.
 */
export function meadow(u: number, v: number, out: THREE.Color): THREE.Color {
  const n = vnoise(u / 5, v / 5, 1) * 0.65 + vnoise(u / 1.7, v / 1.7, 2) * 0.35;
  if (n < 0.5) out.copy(grass[0]).lerp(grass[1], n * 2); else out.copy(grass[1]).lerp(grass[2], (n - 0.5) * 2);
  const dry = smoothstep(vnoise(u / 7, v / 7, 3) * 0.7 + vnoise(u / 2.3, v / 2.3, 4) * 0.3, 0.52, 0.76);
  out.lerp(DRY, dry * 0.6);
  return out.multiplyScalar(0.96 + vnoise(u * 3.1, v * 3.1, 6) * 0.08);
}

/** GLSL value noise shared by the water and landscape shaders. */
const GLSL_NOISE = /* glsl */ `
float lnHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float lnNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(lnHash(i), lnHash(i + vec2(1.0, 0.0)), u.x), mix(lnHash(i + vec2(0.0, 1.0)), lnHash(i + vec2(1.0, 1.0)), u.x), u.y);
}`;

let waterMat: THREE.MeshStandardMaterial | null = null;

/**
 * Animated water for lakes and the sea. Geometry carries a `shore` attribute
 * (0 at the waterline → 1 in deep water): shallows are a clear turquoise that
 * shows the bed, deep water a saturated blue; a noisy foam band laps at the
 * shore; two scrolling ripple fields perturb the normal (sun glints) and a
 * fresnel term mixes in the live sky colour.
 */
export function waterMaterial(): THREE.MeshStandardMaterial {
  if (waterMat) return waterMat;
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.16, metalness: 0.02, transparent: true });
  m.onBeforeCompile = (s) => {
    s.uniforms.uTime = LAND.uTime;
    s.uniforms.uSky = LAND.uSky;
    s.vertexShader = s.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float shore;\nvarying float vShore;\nvarying vec3 vWorld;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvShore = shore;\nvWorld = (modelMatrix * vec4(position, 1.0)).xyz;");
    s.fragmentShader = s.fragmentShader
      .replace("#include <common>", `#include <common>\nuniform float uTime;\nuniform vec3 uSky;\nvarying float vShore;\nvarying vec3 vWorld;\n${GLSL_NOISE}`)
      .replace("#include <color_fragment>", /* glsl */ `#include <color_fragment>
        vec2 wp = vWorld.xz;
        float wn = lnNoise(wp * 1.3 + vec2(uTime * 0.21, uTime * 0.13)) * 0.6 + lnNoise(wp * 3.1 - vec2(uTime * 0.27, -uTime * 0.19)) * 0.4;
        float deep = smoothstep(0.0, 0.85, vShore);
        vec3 body = mix(vec3(0.07, 0.36, 0.40), vec3(0.015, 0.085, 0.18), deep);
        diffuseColor.rgb = body;
        float lap = 0.5 + 0.5 * sin(vShore * 34.0 - uTime * 1.6 + wn * 4.0);
        float foam = (1.0 - smoothstep(0.0, 0.16, vShore + (wn - 0.5) * 0.1)) * (0.55 + 0.45 * lap);
        foam = clamp(foam, 0.0, 1.0);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.95, 0.95), foam * 0.85);
        diffuseColor.a = max(mix(0.5, 0.94, smoothstep(0.0, 0.6, vShore)), foam);`)
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.85, foam);")
      .replace("#include <normal_fragment_maps>", /* glsl */ `#include <normal_fragment_maps>
        vec2 rg = vec2(
          sin(wp.x * 2.3 + wp.y * 0.7 + uTime * 1.4) + 0.6 * sin((wp.x + wp.y) * 3.7 - uTime * 1.9),
          cos(wp.y * 2.6 - wp.x * 0.5 - uTime * 1.2) + 0.6 * cos((wp.x - wp.y) * 3.1 + uTime * 1.6)) * 0.045
          + (vec2(lnNoise(wp * 2.2 + uTime * 0.3), lnNoise(wp.yx * 2.2 - uTime * 0.25)) - 0.5) * 0.16;
        normal = normalize(normal + (viewMatrix * vec4(rg.x, 0.0, rg.y, 0.0)).xyz * (1.0 - foam));`)
      .replace("#include <emissivemap_fragment>", /* glsl */ `#include <emissivemap_fragment>
        float fres = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 4.0);
        float glint = smoothstep(0.62, 0.95, lnNoise(wp * 5.0 + vec2(uTime * 0.9, -uTime * 0.7)) * lnNoise(wp * 3.3 - uTime * 0.5));
        totalEmissiveRadiance += (uSky * (0.04 + 0.55 * fres) + body * uSky * 0.35 + uSky * glint * 0.5 * deep) * (1.0 - foam);`);
  };
  m.customProgramCacheKey = () => "landWater";
  waterMat = m;
  return m;
}

let rockingMat: THREE.MeshStandardMaterial | null = null;

/** Tinted material whose instances nod about their local z axis (pumpjack walking beams), each on its own phase. */
export function rockingMaterial(): THREE.MeshStandardMaterial {
  if (rockingMat) return rockingMat;
  const m = tintedStandardMaterial({ roughness: 0.55, metalness: 0.25 });
  const base = m.onBeforeCompile;
  m.onBeforeCompile = (s, r) => {
    base.call(m, s, r);
    s.uniforms.uTime = LAND.uTime;
    s.vertexShader = s.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float uTime;")
      .replace("#include <beginnormal_vertex>", /* glsl */ `#include <beginnormal_vertex>
        float rkA = 0.3 * sin(uTime * 1.8 + instanceMatrix[3].x * 0.9 + instanceMatrix[3].z * 1.3);
        float rkC = cos(rkA), rkS = sin(rkA);
        objectNormal.xy = vec2(objectNormal.x * rkC - objectNormal.y * rkS, objectNormal.x * rkS + objectNormal.y * rkC);`)
      .replace("#include <begin_vertex>", "#include <begin_vertex>\ntransformed.xy = vec2(transformed.x * rkC - transformed.y * rkS, transformed.x * rkS + transformed.y * rkC);");
  };
  m.customProgramCacheKey = () => "tintMaskGlowRoof+rocking";
  rockingMat = m;
  return m;
}

/* ───────────────────────── nature: geometry ───────────────────────── */

export interface NatureGeometries {
  /** In-map woodland, close-up detail; canopies take the instance tint. Every foliage geometry carries `flex` for `foliageMaterial`. */
  broadleaf: THREE.BufferGeometry;
  /** Round deciduous with a three-tier layered crown. */
  round: THREE.BufferGeometry;
  /** Tall narrow column: field and lake edges. */
  poplar: THREE.BufferGeometry;
  /** White trunk with dark bands under a light, airy crown. */
  birch: THREE.BufferGeometry;
  /** Fruit-tree umbrella crown in blossom pink (tint nudges it white ↔ deep pink). */
  blossom: THREE.BufferGeometry;
  conifer: THREE.BufferGeometry;
  bush: THREE.BufferGeometry;
  /** Landscape LOD trees: a handful of triangles each. */
  farBroadleaf: THREE.BufferGeometry;
  farConifer: THREE.BufferGeometry;
  /** One clump of a hedgerow (hedges are rows of these along field borders). */
  hedge: THREE.BufferGeometry;
  reeds: THREE.BufferGeometry;
  /** Quarry spoil heap (tinted by ore). */
  heap: THREE.BufferGeometry;
  oilPad: THREE.BufferGeometry;
  pumpjack: THREE.BufferGeometry;
  /** Walking beam + horsehead, pivot at the origin (instance y = pivot height). */
  pumpBeam: THREE.BufferGeometry;
  derrick: THREE.BufferGeometry;
}

/** Pumpjack samson-post height: where the beam instance pivots. */
export const PUMP_PIVOT = 0.56;

/** Squashed low-poly blob (canopies, hedges, heaps). */
function blob(r: number, x: number, y: number, z: number, sy = 0.85, ry = 0): THREE.BufferGeometry {
  return xf(new THREE.IcosahedronGeometry(r, 0), x, y, z, 0, ry, 0, 1, sy, 1);
}

/** Box of thickness `t` spanning a → b (lattice struts, slanted legs). */
function strut(ax: number, ay: number, az: number, bx: number, by: number, bz: number, t: number): THREE.BufferGeometry {
  const dir = new THREE.Vector3(bx - ax, by - ay, bz - az);
  const len = dir.length();
  const g = new THREE.BoxGeometry(t, len, t);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()));
  g.translate((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
  return g;
}

let natureCache: NatureGeometries | null = null;

export function natureGeometries(): NatureGeometries {
  if (natureCache) return natureCache;
  const T = true, F = false;

  const broadleaf = withFlex(merge([
    { geo: cyl(0.04, 0.065, 0.42, 0, 0, 0, 5), color: C.trunk, tint: F },
    { geo: blob(0.33, 0, 0.66, 0, 0.82), color: C.leaf, tint: T },
    { geo: blob(0.23, 0.17, 0.84, 0.05, 0.85, 0.7), color: C.leafLight, tint: T },
    { geo: blob(0.22, -0.15, 0.55, -0.12, 0.8, 1.3), color: C.leafDark, tint: T },
  ]), 0.07);
  const round = withFlex(merge([
    { geo: cyl(0.045, 0.07, 0.5, 0, 0, 0, 5), color: C.trunk, tint: F },
    { geo: blob(0.37, 0, 0.62, 0, 0.55), color: C.leafDark, tint: T },
    { geo: blob(0.3, 0.03, 0.83, -0.02, 0.58, 0.6), color: C.leaf, tint: T },
    { geo: blob(0.2, -0.02, 1.01, 0.02, 0.62, 1.2), color: C.leafLight, tint: T },
  ]), 0.07);
  const poplar = withFlex(merge([
    { geo: cyl(0.03, 0.05, 0.42, 0, 0, 0, 5), color: C.trunk, tint: F },
    { geo: xf(new THREE.IcosahedronGeometry(0.17, 0), 0, 0.86, 0, 0, 0.3, 0, 1, 3, 1), color: C.leaf, tint: T },
    { geo: xf(new THREE.IcosahedronGeometry(0.12, 0), 0.07, 1.08, 0.04, 0, 1.1, 0, 1, 2.6, 1), color: C.leafLight, tint: T },
    { geo: xf(new THREE.IcosahedronGeometry(0.11, 0), -0.06, 0.7, -0.05, 0, 2, 0, 1, 2.4, 1), color: C.leafDark, tint: T },
  ]), 0.12);
  const birchParts: Part[] = [{ geo: cyl(0.024, 0.04, 0.78, 0, 0, 0, 6), color: "#ece8dc", tint: F }];
  for (const [y, h] of [[0.12, 0.025], [0.27, 0.018], [0.4, 0.03], [0.55, 0.016]]) {
    const r = 0.04 - 0.016 * (y / 0.78) + 0.003;
    birchParts.push({ geo: cyl(r, r, h, 0, y, 0, 6), color: "#3a3631", tint: F });
  }
  birchParts.push(
    { geo: blob(0.2, 0.04, 0.78, 0, 1.05, 0.4), color: "#8fbb52", tint: T },
    { geo: blob(0.15, -0.12, 0.66, 0.06, 1.1, 1.1), color: "#a3c862", tint: T },
    { geo: blob(0.14, 0.12, 0.98, -0.05, 1.05, 1.9), color: "#b2d070", tint: T },
    { geo: blob(0.12, -0.04, 1.08, -0.08, 1.1, 2.6), color: "#9cc25a", tint: T },
  );
  const birch = withFlex(merge(birchParts), 0.09);
  const blossom = withFlex(merge([
    { geo: cyl(0.04, 0.06, 0.38, 0, 0, 0, 5), color: "#5a4334", tint: F },
    { geo: blob(0.32, 0, 0.6, 0, 0.62), color: "#f0bccb", tint: T },
    { geo: blob(0.22, 0.18, 0.66, 0.08, 0.6, 0.7), color: "#f7d9e2", tint: T },
    { geo: blob(0.2, -0.16, 0.57, -0.1, 0.6, 1.3), color: "#e5a3b8", tint: T },
    { geo: blob(0.16, 0.02, 0.8, -0.04, 0.6, 2), color: "#fbe6ec", tint: T },
  ]), 0.06);
  const conifer = withFlex(merge([
    { geo: cyl(0.035, 0.055, 0.26, 0, 0, 0, 5), color: C.trunk, tint: F },
    { geo: cone(0.32, 0.52, 0, 0.18, 0, 7), color: "#3a6e3a", tint: T },
    { geo: cone(0.25, 0.46, 0, 0.44, 0, 7), color: "#447d40", tint: T },
    { geo: cone(0.16, 0.42, 0, 0.7, 0, 7), color: "#4f8a47", tint: T },
  ]), 0.05);
  const bush = withFlex(merge([
    { geo: blob(0.17, 0, 0.1, 0, 0.75), color: C.leafDark, tint: T },
    { geo: blob(0.13, 0.12, 0.13, 0.06, 0.8, 1), color: C.leaf, tint: T },
  ]), 0.03);
  const farBroadleaf = withFlex(merge([
    { geo: cone(0.07, 0.45, 0, 0, 0, 3), color: C.trunk, tint: F },
    { geo: blob(0.5, 0, 0.75, 0, 0.85), color: C.leaf, tint: T },
  ]), 0.08);
  const farConifer = withFlex(merge([{ geo: cone(0.42, 1.5, 0, 0.05, 0, 5), color: "#3f7a3c", tint: T }]), 0.06);

  const hedge = withFlex(merge([
    { geo: blob(0.16, 0, 0.1, 0, 0.72), color: "#3f6b35", tint: T },
    { geo: blob(0.12, 0.1, 0.15, 0.03, 0.8, 1), color: "#4a7a3c", tint: T },
    { geo: blob(0.11, -0.1, 0.13, -0.02, 0.8, 2), color: "#41703a", tint: T },
  ]), 0.02);

  const reedParts: Part[] = [];
  for (let k = 0; k < 6; k++) {
    const a = k * 2.4, r = 0.04 + (k % 3) * 0.035;
    reedParts.push({ geo: cone(0.022, 0.26 + (k % 3) * 0.08, Math.cos(a) * r, 0, Math.sin(a) * r, 3), color: k % 2 ? "#8a9a4a" : "#6f8a3e", tint: T });
  }

  const heap = merge([
    { geo: xf(new THREE.DodecahedronGeometry(0.36, 0), 0, 0.06, 0, 0, 0.3, 0, 1, 0.55, 1), color: "#fff", tint: T },
    { geo: xf(new THREE.DodecahedronGeometry(0.22, 0), 0.26, 0.03, 0.14, 0, 1.1, 0, 1, 0.5, 1), color: "#e8e8e8", tint: T },
  ]);

  const oilPad = merge([
    { geo: boxUp(1.62, 0.025, 1.3, 0, 0, 0), color: "#a39b88", tint: F },
    { geo: xf(new THREE.CircleGeometry(0.34, 9), 0.32, 0.03, -0.18, -Math.PI / 2), color: "#2a2430", tint: F },
    { geo: xf(new THREE.CircleGeometry(0.2, 7), -0.15, 0.03, -0.4, -Math.PI / 2), color: "#2a2430", tint: F },
    { geo: cyl(0.2, 0.2, 0.4, -0.5, 0.025, 0.36, 10), color: C.tank, tint: F },
    { geo: cyl(0.21, 0.21, 0.04, -0.5, 0.42, 0.36, 10), color: C.rust, tint: F },
    { geo: cyl(0.16, 0.16, 0.32, -0.04, 0.025, 0.42, 10), color: C.tank, tint: F },
    { geo: cyl(0.17, 0.17, 0.035, -0.04, 0.34, 0.42, 10), color: C.rust, tint: F },
    { geo: box(0.7, 0.035, 0.035, -0.02, 0.09, 0.12), color: C.pipe, tint: F },
    { geo: box(0.035, 0.035, 0.36, 0.33, 0.09, -0.06), color: C.pipe, tint: F },
  ]);

  const frame = "#4a4d52", paint = "#d4a63a";
  const pumpjack = merge([
    { geo: boxUp(1.05, 0.05, 0.22, -0.05, 0.025, 0), color: frame, tint: F },
    { geo: strut(-0.14, 0.05, -0.08, 0, PUMP_PIVOT, 0, 0.035), color: frame, tint: F },
    { geo: strut(-0.14, 0.05, 0.08, 0, PUMP_PIVOT, 0, 0.035), color: frame, tint: F },
    { geo: strut(0.14, 0.05, 0, 0, PUMP_PIVOT, 0, 0.035), color: frame, tint: F },
    { geo: boxUp(0.18, 0.16, 0.16, -0.46, 0.05, 0), color: paint, tint: T },
    { geo: boxUp(0.12, 0.1, 0.12, -0.6, 0.05, 0.02), color: C.dark, tint: F },
    { geo: xf(new THREE.CylinderGeometry(0.11, 0.11, 0.04, 10), -0.42, 0.2, 0.1, Math.PI / 2), color: frame, tint: F },
    { geo: xf(new THREE.CylinderGeometry(0.11, 0.11, 0.04, 10), -0.42, 0.2, -0.1, Math.PI / 2), color: frame, tint: F },
    { geo: cyl(0.04, 0.05, 0.12, 0.5, 0.05, 0, 6), color: C.steel, tint: F },
    { geo: cyl(0.01, 0.01, 0.3, 0.5, 0.15, 0, 4), color: C.steel, tint: F },
  ]);
  const pumpBeam = merge([
    { geo: box(0.92, 0.07, 0.07, 0.04, 0, 0), color: paint, tint: T },
    { geo: xf(new THREE.BoxGeometry(0.08, 0.24, 0.09), 0.52, -0.06, 0, 0, 0, 0.25), color: paint, tint: T },
    { geo: box(0.2, 0.06, 0.12, -0.38, 0, 0), color: frame, tint: F },
    { geo: strut(-0.38, 0, 0.07, -0.42, -0.34, 0.1, 0.02), color: frame, tint: F },
    { geo: strut(-0.38, 0, -0.07, -0.42, -0.34, -0.1, 0.02), color: frame, tint: F },
  ]);

  const legs: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const H = 1.55, B = 0.24, Tp = 0.06;
  const derrickParts: Part[] = [{ geo: boxUp(0.62, 0.16, 0.62, 0, 0, 0), color: C.concrete, tint: F }];
  for (const [sx, sz] of legs) derrickParts.push({ geo: strut(sx * B, 0.16, sz * B, sx * Tp, H, sz * Tp, 0.035), color: "#b5442f", tint: F });
  for (const y of [0.55, 0.95, 1.3]) {
    const r = B + (Tp - B) * ((y - 0.16) / (H - 0.16));
    for (let k = 0; k < 4; k++) {
      const [ax, az] = legs[k], [bx, bz] = legs[(k + 1) % 4];
      derrickParts.push({ geo: strut(ax * r, y, az * r, bx * r, y, bz * r, 0.022), color: "#e8e2d6", tint: F });
    }
  }
  derrickParts.push({ geo: boxUp(0.2, 0.08, 0.2, 0, H, 0), color: C.rust, tint: F });
  derrickParts.push({ geo: boxUp(0.32, 0.22, 0.24, 0.42, 0.0, 0.18), color: "#d6d0c2", tint: F });

  natureCache = {
    broadleaf, round, poplar, birch, blossom, conifer, bush, farBroadleaf, farConifer,
    hedge,
    reeds: withFlex(merge(reedParts), 0.09),
    heap,
    oilPad,
    pumpjack,
    pumpBeam,
    derrick: merge(derrickParts),
  };
  return natureCache;
}

/* ───────────────────────── nature: carved landforms (lakes, open pits) ───────────────────────── */

/** Lattice cells per tile edge for carved landforms. */
export const RES = 12;
/** Lattice offsets of each in-map tile's 3×3 ground sub-quads: a 1/12-tile verge rings every plot. */
export const SUB_I = [0, 1, RES - 1, RES] as const;
/** Carve kinds: undeveloped aquifer → lake, iron/coal → open pit. 0 = flat ground. */
export const CARVE_LAKE = 1, CARVE_IRON = 2, CARVE_COAL = 3;
/** Ground colour at the lip of each carve kind: the ground mesh paints carved-tile verges toward it and the landform mesh starts from it exactly. */
export const RIM_COLOR = ["#000000", "#6a984a", "#a9967c", "#78726b"] as const;
/** Lake surface height; beds dip to ~-0.45. */
export const WATER_Y = -0.07;
/** Open-pit bench depth and the smoothed-distance thresholds (tile units) of each bench wall. */
const PIT_STEP = 0.14;
const PIT_LEVELS = [0.045, 0.1, 0.155, 0.21, 0.265, 0.32, 0.375, 0.43, 0.485, 0.54];

/** Minimum inset (tile units) of a landform's dip from its carve boundary: keeps water and benches clear of street verges. */
const LIP = 0.06;

/** Abramowitz–Stegun 7.1.26 (|error| < 1.5e-7). */
function erf(x: number): number {
  const s = x < 0 ? -1 : 1;
  const a = Math.abs(x), t = 1 / (1 + 0.3275911 * a);
  return s * (1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a));
}

/**
 * The 0/1 mask of a tile set (`has(x, y)`; tile x spans grid-corner u ∈ [x, x+1]) blurred by a Gaussian
 * of `sigma` tiles, evaluated at (u, v): 1 deep inside, 0.5 on a straight boundary, rounded at corners.
 * Exact (separable erf per tile); sigma must stay ≤ ~0.33 for the 3×3 tile window to cover the kernel.
 */
export function blurTiles(has: (x: number, y: number) => boolean, u: number, v: number, sigma: number): number {
  const k = 1 / (sigma * Math.SQRT2);
  const x0 = Math.floor(u) - 1, y0 = Math.floor(v) - 1;
  let sum = 0;
  for (let dy = 0; dy < 3; dy++) {
    const y = y0 + dy;
    const cy = 0.5 * (erf((y + 1 - v) * k) - erf((y - v) * k));
    for (let dx = 0; dx < 3; dx++) {
      const x = x0 + dx;
      if (has(x, y)) sum += cy * 0.5 * (erf((x + 1 - u) * k) - erf((x - u) * k));
    }
  }
  return sum;
}

/** `RoadNet.hasRoad`: whether the grid edge from corner (i, j) going +x (horizontal) or +y carries a street. */
export type HasRoad = (i: number, j: number, horizontal: boolean) => boolean;

/** Distance (tile units) from grid-corner point (u, v) to the nearest street axis among the edges around its tile; capped at 1.5. */
export function roadDistance(hasRoad: HasRoad, width: number, height: number, u: number, v: number): number {
  const fx = Math.floor(u), fy = Math.floor(v);
  let best = 1.5;
  for (let j = fy - 1; j <= fy + 2; j++) {
    for (let i = fx - 1; i <= fx + 1; i++) {
      if (i >= 0 && i < width && j >= 0 && j <= height && hasRoad(i, j, true)) best = Math.min(best, Math.hypot(Math.max(0, i - u, u - i - 1), v - j));
    }
  }
  for (let i = fx - 1; i <= fx + 2; i++) {
    for (let j = fy - 1; j <= fy + 1; j++) {
      if (i >= 0 && i <= width && j >= 0 && j < height && hasRoad(i, j, false)) best = Math.min(best, Math.hypot(u - i, Math.max(0, j - v, v - j - 1)));
    }
  }
  return best;
}

interface LandTile { x: number; y: number; res: string | null; building: unknown }

/** Carve kind of a tile: deposits that become landforms until something is built on them. */
export function carveOf(t: LandTile): number {
  if (t.building) return 0;
  return t.res === "aquifer" ? CARVE_LAKE : t.res === "iron" ? CARVE_IRON : t.res === "coal" ? CARVE_COAL : 0;
}

export interface Landforms {
  width: number;
  height: number;
  /** Lattice nodes per row: width * RES + 1. */
  nx: number;
  /** Carve kind per tile (y * width + x). */
  kind: Int8Array;
  /** Carve kind of each lattice cell cut out of the flat ground (0 = ground stays); row length width * RES. */
  cell: Int8Array;
  /**
   * Per lattice node: organic signed depth into its landform, in tile units. Negative toward the lip
   * (≤ -LIP at the carve boundary), 0 at the shoreline / first bench, growing toward the middle.
   */
  field: Float32Array;
}

let lfCache: { key: string; lf: Landforms } | null = null;

/**
 * Which parts of the map are carved out of the flat ground, at RES lattice
 * cells per tile. A ground sub-quad is carved when every tile touching each
 * of its corners shares one carve kind, so neighbouring lake (or same-ore)
 * tiles merge into one body while unlike neighbours keep a strip of ground
 * between them. `field` is an organic signed depth (see Landforms) shared by
 * lake shorelines and pit benches.
 * Memoised on the carve layout (Terrain and Features both ask).
 */
export function landforms(tiles: readonly LandTile[], width: number, height: number): Landforms {
  const kind = new Int8Array(width * height);
  for (const t of tiles) kind[t.y * width + t.x] = carveOf(t);
  const key = `${width}x${height}:${kind.join("")}`;
  if (lfCache?.key === key) return lfCache.lf;

  const nx = width * RES + 1, ny = height * RES + 1, cw = width * RES;
  const nodeKind = (I: number, J: number): number => {
    const x0 = I % RES === 0 ? I / RES - 1 : Math.floor(I / RES), x1 = I % RES === 0 ? I / RES : x0;
    const y0 = J % RES === 0 ? J / RES - 1 : Math.floor(J / RES), y1 = J % RES === 0 ? J / RES : y0;
    let k = -1;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (x < 0 || y < 0 || x >= width || y >= height) return 0;
        const kk = kind[y * width + x];
        if (kk === 0 || (k !== -1 && kk !== k)) return 0;
        k = kk;
      }
    }
    return k;
  };

  const cell = new Int8Array(cw * height * RES);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const k = kind[y * width + x];
      if (!k) continue;
      for (let sy = 0; sy < 3; sy++) {
        for (let sx = 0; sx < 3; sx++) {
          const I0 = x * RES + SUB_I[sx], I1 = x * RES + SUB_I[sx + 1], J0 = y * RES + SUB_I[sy], J1 = y * RES + SUB_I[sy + 1];
          if (nodeKind(I0, J0) !== k || nodeKind(I1, J0) !== k || nodeKind(I0, J1) !== k || nodeKind(I1, J1) !== k) continue;
          for (let J = J0; J < J1; J++) for (let I = I0; I < I1; I++) cell[J * cw + I] = k;
        }
      }
    }
  }

  // Interior nodes: all four surrounding cells carved. Everything else is the lip (0).
  const dist = new Float32Array(nx * ny);
  const carvedAt = (I: number, J: number) => I >= 0 && J >= 0 && I < cw && J < height * RES && cell[J * cw + I] !== 0;
  const interior: number[] = [];
  for (let J = 1; J < ny - 1; J++) {
    for (let I = 1; I < nx - 1; I++) {
      if (carvedAt(I - 1, J - 1) && carvedAt(I, J - 1) && carvedAt(I - 1, J) && carvedAt(I, J)) { dist[J * nx + I] = 1e9; interior.push(J * nx + I); }
    }
  }
  const D = Math.SQRT2;
  for (const i of interior) {
    dist[i] = Math.min(dist[i], dist[i - 1] + 1, dist[i - nx] + 1, dist[i - nx - 1] + D, dist[i - nx + 1] + D);
  }
  for (let n = interior.length - 1; n >= 0; n--) {
    const i = interior[n];
    dist[i] = Math.min(dist[i], dist[i + 1] + 1, dist[i + nx] + 1, dist[i + nx + 1] + D, dist[i + nx - 1] + D);
  }
  for (let pass = 0; pass < 5; pass++) {
    for (const i of interior) {
      dist[i] = (dist[i] * 2 + dist[i - 1] + dist[i + 1] + dist[i - nx] + dist[i + nx] + (dist[i - nx - 1] + dist[i - nx + 1] + dist[i + nx - 1] + dist[i + nx + 1]) * 0.5) / 8;
    }
  }
  for (const i of interior) dist[i] /= RES;

  // Organic shape: a Gaussian-blurred (domain-warped) mask of the same-kind tiles thresholded at a noisy
  // level rounds corners off into bays and promontories instead of following tile edges; capped by the
  // chamfer distance so every landform lips out at y = 0 well inside its carve, and deepened by it so big
  // merged bodies keep going down in the middle. A small bump at each tile's centre guarantees every
  // deposit tile shows its water / pit, whatever the noise does.
  const field = new Float32Array(nx * ny).fill(-LIP);
  for (const i of interior) {
    const I = i % nx, J = (i - I) / nx;
    const k = cell[Math.min(J, height * RES - 1) * cw + Math.min(I, cw - 1)];
    const u = I / RES, v = J / RES;
    const wu = u + (vnoise(u * 0.8, v * 0.8, 140) - 0.5) * 0.6, wv = v + (vnoise(u * 0.8, v * 0.8, 141) - 0.5) * 0.6;
    const b = blurTiles((x, y) => x >= 0 && y >= 0 && x < width && y < height && kind[y * width + x] === k, wu, wv, 0.31);
    const t = 0.64 + (vnoise(u * 0.7, v * 0.7, 142) - 0.5) * 0.4 + (vnoise(u * 2.4, v * 2.4, 143) - 0.5) * 0.12;
    const centre = Math.hypot(u - Math.floor(u) - 0.5, v - Math.floor(v) - 0.5);
    const e = (b - t) * 0.63 + Math.max(0, dist[i] - 0.35) * 0.6;
    field[i] = Math.min(Math.max(e, 0.12 * (1 - centre / 0.3)), dist[i] - LIP);
  }

  const lf = { width, height, nx, kind, cell, field };
  lfCache = { key, lf };
  return lf;
}

/** Placement of a small natural prop (reeds, spoil heap): world XZ, yaw, scale, tint. */
export interface Prop { x: number; z: number; ry: number; s: number; color: THREE.Color }

const SAND = new THREE.Color("#c2b184");
const LAKE_BED = new THREE.Color("#47604f");
const LAKE_RIM = new THREE.Color(RIM_COLOR[CARVE_LAKE]);
const REED = [new THREE.Color(1, 1, 1), new THREE.Color(1.15, 1.05, 0.8), new THREE.Color(0.85, 0.95, 0.85)];
/** Canopy tints for bank and hedgerow greenery (multiply the leaf albedo). */
const BANK_TINT = [new THREE.Color(1.1, 1.14, 0.95), new THREE.Color(1, 1, 1), new THREE.Color(0.82, 0.92, 0.8), new THREE.Color(1.15, 1.1, 0.75)];

/**
 * Lakes: a heightfield bed over every carved lake cell (lip at y=0 in the
 * rim colour, grassy bank → sand → murky depths) and a flat water sheet at
 * WATER_Y over the same cells; the bed rising through the sheet draws the
 * shoreline along the organic field's zero contour, so merged tiles read as
 * one rounded lake with bays and spits. Reeds clump at the waterline; the odd
 * bush or tree stands on wide grassy banks (never near a tile edge, where
 * streets run).
 */
export function lakeGeometries(lf: Landforms): { bed: THREE.BufferGeometry; water: THREE.BufferGeometry; reeds: Prop[]; bushes: Prop[]; trees: Prop[] } {
  const { width, height, nx, cell, field } = lf;
  const cw = width * RES;
  const vid = new Int32Array(nx * (height * RES + 1)).fill(-1);
  const pos: number[] = [], wpos: number[] = [], col: number[] = [], shore: number[] = [], idx: number[] = [];
  const reeds: Prop[] = [], bushes: Prop[] = [], trees: Prop[] = [];
  const c = new THREE.Color();
  const node = (I: number, J: number): number => {
    const i = J * nx + I;
    if (vid[i] >= 0) return vid[i];
    const u = I / RES, v = J / RES;
    const [wx, wz] = cornerToWorld(u, v, width, height);
    const f = field[i];
    const y = f >= 0 ? WATER_Y - 0.39 * smoothstep(f, 0, 0.26) : WATER_Y * (1 - smoothstep(-f, 0, LIP));
    const depth = WATER_Y - y;
    if (depth < 0) c.copy(SAND).lerp(LAKE_RIM, Math.max(smoothstep(-f + (vnoise(u * 3, v * 3, 78) - 0.5) * 0.04, 0.012, 0.045), smoothstep(-f, LIP * 0.8, LIP)));
    else c.copy(SAND).lerp(LAKE_BED, smoothstep(depth, 0, 0.26));
    if (f > -LIP) c.multiplyScalar(0.94 + vnoise(u * 4, v * 4, 72) * 0.12);
    vid[i] = pos.length / 3;
    pos.push(wx, y, wz);
    wpos.push(wx, WATER_Y, wz);
    col.push(c.r, c.g, c.b);
    shore.push(Math.max(0, Math.min(1, depth / 0.32)));
    if (depth > -0.012 && depth < 0.035 && hash2(I, J, 73) < 0.09) {
      reeds.push({ x: wx, z: wz, ry: hash2(I, J, 74) * 6.28, s: 0.8 + hash2(I, J, 75) * 0.6, color: REED[Math.floor(hash2(I, J, 76) * REED.length)] });
    }
    const fu = (I % RES) / RES, fv = (J % RES) / RES;
    const h = hash2(I, J, 79);
    if (f < -0.1 && Math.min(fu, fv, 1 - fu, 1 - fv) > 0.2 && h < 0.06) {
      (h < 0.02 ? trees : bushes).push({ x: wx, z: wz, ry: h * 300, s: 0.8 + hash2(I, J, 80) * 0.5, color: BANK_TINT[Math.floor(hash2(I, J, 81) * BANK_TINT.length)] });
    }
    return vid[i];
  };
  for (let J = 0; J < height * RES; J++) {
    for (let I = 0; I < cw; I++) {
      if (cell[J * cw + I] !== CARVE_LAKE) continue;
      const a = node(I, J), b = node(I + 1, J), d = node(I + 1, J + 1), e = node(I, J + 1);
      idx.push(a, e, d, a, d, b);
    }
  }
  const bed = new THREE.BufferGeometry();
  bed.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  bed.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  bed.setIndex(idx);
  bed.computeVertexNormals();
  const water = new THREE.BufferGeometry();
  water.setAttribute("position", new THREE.Float32BufferAttribute(wpos, 3));
  water.setAttribute("normal", new THREE.Float32BufferAttribute(wpos.map((_, k) => (k % 3 === 1 ? 1 : 0)), 3));
  water.setAttribute("shore", new THREE.Float32BufferAttribute(shore, 1));
  water.setIndex(idx);
  bed.computeBoundingSphere();
  water.computeBoundingSphere();
  return { bed, water, reeds, bushes, trees };
}

/** Bench tops, bench walls and pit floor per ore, light → dark; index 0 of `bench` is never used (the lip is RIM_COLOR). */
const PIT_PALETTE: Record<number, { bench: string[]; wall: string[]; floor: string; heap: string }> = {
  [CARVE_IRON]: { bench: ["#b9a68a", "#ad9474", "#bba78c", "#a88c6c"], wall: ["#9b5d3a", "#86634c", "#a8704a", "#7d4f35"], floor: "#6e3f2b", heap: "#9a6246" },
  [CARVE_COAL]: { bench: ["#6f6a63", "#625d57", "#78726b", "#5a5651"], wall: ["#3a393c", "#2d2c2f", "#47444a", "#333236"], floor: "#1c1c1f", heap: "#2e2d30" },
};

type Pt = [number, number, number]; // x, z, field

/** Sutherland–Hodgman clip of a convex polygon against field ≥ L (or < L). */
function clipField(poly: Pt[], L: number, above: boolean): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ina = above ? a[2] >= L : a[2] < L, inb = above ? b[2] >= L : b[2] < L;
    if (ina) out.push(a);
    if (ina !== inb) {
      const t = (L - a[2]) / (b[2] - a[2]);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, L]);
    }
  }
  return out;
}

/**
 * Open-pit mines: every carved iron/coal cell is split into two triangles
 * whose organic field is cut into isobands; each band is a flat bench
 * PIT_STEP lower than the last, joined by vertical walls along the band
 * edges, so a lone deposit is a small rounded 3–4 bench pit and a merged
 * field a deep terraced crater with irregular benches. Spoil heaps sit on
 * the lip at the corner of each tile facing away from its neighbours.
 */
export function pitGeometry(lf: Landforms): { geo: THREE.BufferGeometry; heaps: Prop[] } {
  const { width, height, nx, kind, cell, field: depth } = lf;
  const cw = width * RES;
  const pos: number[] = [], nor: number[] = [], col: number[] = [];
  const c = new THREE.Color();
  const pal = (k: number) => PIT_PALETTE[k];
  const field = (I: number, J: number): Pt => {
    const [wx, wz] = cornerToWorld(I / RES, J / RES, width, height);
    return [wx, wz, depth[J * nx + I]];
  };
  const benchColor = (k: number, b: number, x: number, z: number) => {
    if (b === 0) return c.set(RIM_COLOR[k]);
    const p = pal(k);
    c.set(b >= PIT_LEVELS.length ? p.floor : p.bench[b % p.bench.length]);
    return c.multiplyScalar(0.93 + vnoise(x * 2.1, z * 2.1, 82) * 0.14);
  };
  const bandOf = (f: number) => { let b = 0; while (b < PIT_LEVELS.length && f >= PIT_LEVELS[b]) b++; return b; };
  const tri = (k: number, p: Pt[]) => {
    let fmin = Infinity, fmax = -Infinity;
    for (const q of p) { fmin = Math.min(fmin, q[2]); fmax = Math.max(fmax, q[2]); }
    const b0 = bandOf(fmin), b1 = bandOf(fmax);
    for (let b = b0; b <= b1; b++) {
      let poly = p;
      if (b > 0) poly = clipField(poly, PIT_LEVELS[b - 1], true);
      if (b < PIT_LEVELS.length) poly = clipField(poly, PIT_LEVELS[b], false);
      if (poly.length < 3) continue;
      const y = -b * PIT_STEP;
      benchColor(k, b, poly[0][0], poly[0][1]);
      for (let i = 1; i < poly.length - 1; i++) {
        for (const q of [poly[0], poly[i], poly[i + 1]]) { pos.push(q[0], y, q[1]); nor.push(0, 1, 0); col.push(c.r, c.g, c.b); }
      }
    }
    if (b0 === b1) return;
    // horizontal gradient of the field over the triangle: walls face up-field (into the pit)
    const [a, b, d] = p;
    const e1x = b[0] - a[0], e1z = b[1] - a[1], e1f = b[2] - a[2], e2x = d[0] - a[0], e2z = d[1] - a[1], e2f = d[2] - a[2];
    const nX = e1z * e2f - e1f * e2z, nF = e1x * e2z - e1z * e2x, nZ = e1f * e2x - e1x * e2f;
    let gx = -nX / nF, gz = -nZ / nF;
    const gl = Math.hypot(gx, gz) || 1;
    gx /= gl; gz /= gl;
    for (let lv = b0; lv < b1; lv++) {
      const L = PIT_LEVELS[lv];
      const hits: [number, number][] = [];
      for (let i = 0; i < 3; i++) {
        const s = p[i], t = p[(i + 1) % 3];
        if ((s[2] < L) === (t[2] < L)) continue;
        const u = (L - s[2]) / (t[2] - s[2]);
        hits.push([s[0] + (t[0] - s[0]) * u, s[1] + (t[1] - s[1]) * u]);
      }
      if (hits.length !== 2) continue;
      let [h0, h1] = hits;
      // the quad h0top → h1top → h1bot faces (dz, 0, -dx); flip so it faces up-field
      if ((h1[1] - h0[1]) * gx - (h1[0] - h0[0]) * gz < 0) [h0, h1] = [h1, h0];
      const top = -lv * PIT_STEP, bot = -(lv + 1) * PIT_STEP;
      const pl = pal(k);
      c.set(pl.wall[lv % pl.wall.length]).multiplyScalar(0.9 + vnoise(h0[0] * 3, h0[1] * 3, 83) * 0.2);
      for (const [qx, qy, qz] of [[h0[0], top, h0[1]], [h1[0], top, h1[1]], [h1[0], bot, h1[1]], [h0[0], top, h0[1]], [h1[0], bot, h1[1]], [h0[0], bot, h0[1]]]) {
        pos.push(qx, qy, qz); nor.push(gx, 0, gz); col.push(c.r, c.g, c.b);
      }
    }
  };
  for (let J = 0; J < height * RES; J++) {
    for (let I = 0; I < cw; I++) {
      const k = cell[J * cw + I];
      if (k !== CARVE_IRON && k !== CARVE_COAL) continue;
      const a = field(I, J), b = field(I + 1, J), d = field(I + 1, J + 1), e = field(I, J + 1);
      tri(k, [a, e, d]);
      tri(k, [a, d, b]);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  geo.computeBoundingSphere();

  const heaps: Prop[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const k = kind[y * width + x];
      if (k !== CARVE_IRON && k !== CARVE_COAL) continue;
      let best = -1, bestN = 9;
      for (let q = 0; q < 4; q++) {
        const cx = q & 1, cy = q >> 1;
        const ox = cx ? 1 : -1, oy = cy ? 1 : -1;
        let n = 0;
        for (const [dx, dy] of [[ox, 0], [0, oy], [ox, oy]]) {
          const tx = x + dx, ty = y + dy;
          if (tx >= 0 && ty >= 0 && tx < width && ty < height && kind[ty * width + tx] === k) n++;
        }
        if (n < bestN || (n === bestN && hash2(x, y, 84 + q) > 0.5)) { best = q; bestN = n; }
      }
      if (bestN > 1) continue;
      const fx = best & 1 ? 0.8 : 0.2, fy = best >> 1 ? 0.8 : 0.2;
      const I = Math.round((x + fx) * RES), J = Math.round((y + fy) * RES);
      if (depth[J * nx + I] > PIT_LEVELS[0] * 0.8) continue;
      const [wx, wz] = cornerToWorld(x + fx, y + fy, width, height);
      heaps.push({ x: wx, z: wz, ry: hash2(x, y, 85) * 6.28, s: 0.7 + hash2(x, y, 86) * 0.45, color: new THREE.Color(pal(k).heap) });
    }
  }
  return { geo, heaps };
}

/* ───────────────────────── nature: farmland patchwork ───────────────────────── */

/** Field patches are Voronoi cells of one jittered seed per FARM_CELL × FARM_CELL tiles, so fields span and cut across tiles. */
const FARM_CELL = 1.7;
/** Field-mesh lattice cells per tile (carries the irregular headland edge). */
const RF = 8;
const FARM_Y = 0.012;
/** Headland edge value (tile units inside the cropped area) where the outer hedgerow runs. */
const HEDGE_AT = 0.025;
/** Crop palette patches pick from: wheat, barley, young green, deep green, rapeseed, lavender, sunflower, beet. */
const CROP_HEX = ["#d6b44f", "#e3cf8a", "#8fbf55", "#4f8f3c", "#e6d33f", "#9884c4", "#e0a72e", "#6f8f3a"];
const HEDGE_TINT = [new THREE.Color(0.9, 0.95, 0.85), new THREE.Color(1, 1, 1), new THREE.Color(0.78, 0.86, 0.74), new THREE.Color(1.08, 1.06, 0.82)];

/** Mirrors `fh`/`fseed` in the field shader: seed of patch cell (cx, cy) in tile units. */
function farmSeed(cx: number, cy: number): [number, number] {
  return [(cx + 0.15 + 0.7 * hash2(cx, cy, 160)) * FARM_CELL, (cy + 0.15 + 0.7 * hash2(cx, cy, 161)) * FARM_CELL];
}

/** Nearest patch cell to (u, v), same search order as the shader. */
function farmPatch(u: number, v: number): [number, number] {
  const gx = Math.floor(u / FARM_CELL), gy = Math.floor(v / FARM_CELL);
  let best = Infinity, bx = 0, by = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const [sx, sy] = farmSeed(gx + i, gy + j);
      const d = (sx - u) ** 2 + (sy - v) ** 2;
      if (d < best) { best = d; bx = gx + i; by = gy + j; }
    }
  }
  return [bx, by];
}

/** Whether the border between two patches is a farm track (else a hedgerow); symmetric in the pair. */
function isTrack(ax: number, ay: number, bx: number, by: number): boolean {
  return hash2(ax + bx, ay + by, 167) < 0.3;
}

let fieldMat: THREE.MeshStandardMaterial | null = null;

/**
 * Crop patchwork, procedural per fragment from the field mesh's tile
 * coordinates (`tc`): the patch is the nearest jittered seed (mirrors
 * `farmPatch`), each with its own crop, row direction (square to the grid
 * ± ~13°) and shade; rows are shaded ridges; borders between patches are
 * dark hedge bases or dirt tracks with ruts. `edge` (headland distance,
 * noisy) discards outside the farmland and draws the outer hedge base and
 * a grass headland strip.
 */
export function fieldMaterial(): THREE.MeshStandardMaterial {
  if (fieldMat) return fieldMat;
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 });
  const crops = CROP_HEX.map((h) => new THREE.Color(h));
  m.onBeforeCompile = (s) => {
    s.uniforms.uCrops = { value: crops };
    s.uniforms.uWind = STYLE.uWind;
    s.uniforms.uWindStrength = STYLE.uWindStrength;
    s.vertexShader = s.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec2 tc;\nattribute float edge;\nvarying vec2 vTc;\nvarying float vEdge;\nvarying vec2 vFw;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvTc = tc;\nvEdge = edge;\nvFw = (modelMatrix * vec4(position, 1.0)).xz;");
    s.fragmentShader = s.fragmentShader
      .replace("#include <common>", /* glsl */ `#include <common>
        uniform vec3 uCrops[${CROP_HEX.length}];
        varying vec2 vTc;
        varying float vEdge;
        varying vec2 vFw;
        ${GLSL_NOISE}
        ${GLSL_WIND}
        float fh(ivec2 c, uint salt) {
          uint h = uint(c.x) * 374761393u + uint(c.y) * 668265263u + salt * 1274126177u;
          h = (h ^ (h >> 13u)) * 1274126177u;
          return float(h ^ (h >> 16u)) / 4294967296.0;
        }
        vec2 fseed(ivec2 c) { return (vec2(c) + 0.15 + 0.7 * vec2(fh(c, 160u), fh(c, 161u))) * ${FARM_CELL.toFixed(3)}; }`)
      .replace("#include <color_fragment>", /* glsl */ `#include <color_fragment>
        if (vEdge < 0.0) discard;
        vec2 p = vTc;
        ivec2 g = ivec2(floor(p / ${FARM_CELL.toFixed(3)}));
        float d1 = 1e9, d2 = 1e9;
        ivec2 ca = g, cb = g;
        vec2 sa = vec2(0.0), sb = vec2(1.0);
        for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
          ivec2 c = g + ivec2(i, j);
          vec2 sd = fseed(c);
          float dd = dot(sd - p, sd - p);
          if (dd < d1) { d2 = d1; cb = ca; sb = sa; d1 = dd; ca = c; sa = sd; }
          else if (dd < d2) { d2 = dd; cb = c; sb = sd; }
        }
        float border = abs(dot(p - 0.5 * (sa + sb), normalize(sb - sa)));
        bool track = fh(ca + cb, 167u) < 0.3;
        float kind = fh(ca, 165u);
        float ang = (fh(ca, 163u) < 0.5 ? 0.0 : 1.5708) + (fh(ca, 164u) - 0.5) * 0.45;
        vec2 dir = vec2(cos(ang), sin(ang));
        float t = dot(p, dir) / 0.109;
        float rowF = fract(t);
        float ridge = 1.0 - abs(rowF * 2.0 - 1.0);
        float mott = lnNoise(p * 9.0) * 0.5 + lnNoise(p * 23.0) * 0.5;
        vec3 soil = vec3(0.16, 0.085, 0.04) * (0.85 + 0.3 * mott);
        vec3 crop = uCrops[int(fh(ca, 162u) * ${CROP_HEX.length}.0)] * (0.86 + 0.24 * fh(ca, 166u));
        float relief = 1.0;
        // how much the patch bends in the wind: standing crops most, pasture some, stubble and bare soil not at all
        float bend = 1.0;
        vec3 col;
        if (kind < 0.1) { col = vec3(0.13, 0.27, 0.06) * (0.85 + 0.3 * mott); relief = 0.0; bend = 0.55; }
        else if (kind < 0.2) { col = soil * mix(0.7, 1.15, smoothstep(0.2, 0.8, ridge)); bend = 0.0; }
        else if (kind < 0.27) { col = vec3(0.62, 0.5, 0.24) * (0.9 + 0.2 * mott) * mix(0.88, 1.0, ridge); relief = 0.4; bend = 0.0; }
        else { col = mix(soil, crop * (0.9 + 0.2 * mott), smoothstep(0.3, 0.6, ridge)); bend *= smoothstep(0.3, 0.6, ridge); }
        // wind over standing crops: gust fronts roll downwind as pale sheen bands (stalks bending show their lighter sides)
        float wave = 0.5 + 0.5 * sin(dot(vFw, WIND_DIR) * 2.3 - uWind * 2.8 + lnNoise(vFw * 0.6) * 3.0);
        float ripple = windGust(vFw, uWind) * (0.35 + 0.65 * wave) * uWindStrength;
        // patch borders: dirt track with two ruts, or the dark base of a hedgerow
        if (track) {
          float tw = smoothstep(0.042, 0.03, border);
          vec3 dirt = vec3(0.36, 0.27, 0.16) * (0.9 + 0.2 * mott) * (1.0 - 0.25 * smoothstep(0.012, 0.0, abs(border - 0.014)));
          col = mix(col, dirt, tw);
          relief *= 1.0 - tw;
        } else {
          float hw = smoothstep(0.05, 0.035, border);
          col = mix(col, vec3(0.06, 0.11, 0.035), hw);
          relief *= 1.0 - hw;
        }
        // headland: hedge base on the outer edge, then a grass strip before the crop starts
        float head = smoothstep(0.1, 0.085, vEdge);
        col = mix(col, vec3(0.16, 0.27, 0.08) * (0.85 + 0.3 * mott), head);
        col = mix(col, vec3(0.06, 0.11, 0.035), smoothstep(0.05, 0.035, vEdge));
        relief *= 1.0 - head;
        bend *= 1.0 - head;
        col = mix(col, col * 1.35 + vec3(0.025, 0.022, 0.01), clamp(ripple * bend, 0.0, 1.0) * 0.55);
        diffuseColor.rgb = col;`)
      .replace("#include <normal_fragment_maps>", /* glsl */ `#include <normal_fragment_maps>
        float slope = (rowF < 0.5 ? 1.0 : -1.0) * relief * 0.55;
        vec2 lean = dir * slope + WIND_DIR * ripple * bend * 0.4;
        normal = normalize(normal + (viewMatrix * vec4(lean.x, 0.0, lean.y, 0.0)).xyz);`);
    stylize(s, { aoHeight: 0 });
  };
  m.customProgramCacheKey = () => "landField";
  fieldMat = m;
  return m;
}

/**
 * Farmland over the given tiles: a flat mesh (RF cells per tile) carrying
 * tile coordinates and a noisy headland `edge` — distance inside the farm
 * area's outer boundary, minus a wandering margin, and kept clear of
 * streets — so the patchwork ends in an irregular grassy verge instead of
 * at tile edges. Hedge clumps follow the outer headland and the hedged
 * patch borders (exact bisector crossings of the shader's Voronoi), with
 * gaps and the odd hedgerow tree; tracks stay open.
 */
export function farmland(isFarm: (x: number, y: number) => boolean, farmTiles: readonly [number, number][], width: number, height: number, hasRoad: HasRoad): { geo: THREE.BufferGeometry; hedges: Prop[]; trees: Prop[] } {
  const ln = width * RF + 1;
  const vid = new Int32Array(ln * (height * RF + 1)).fill(-1);
  const pos: number[] = [], tc: number[] = [], edgeA: number[] = [], idx: number[] = [];
  const nodeEdge: number[] = [], nodePatch: number[] = [];
  const boundaryDist = (u: number, v: number) => {
    const fx = Math.floor(u), fy = Math.floor(v);
    let best = 1.5;
    for (let y = fy - 1; y <= fy + 1; y++) {
      for (let x = fx - 1; x <= fx + 1; x++) {
        if (!isFarm(x, y)) continue;
        const dx = Math.max(0, x - u, u - x - 1), dy = Math.max(0, y - v, v - y - 1);
        if (!isFarm(x, y - 1)) best = Math.min(best, Math.hypot(dx, v - y));
        if (!isFarm(x, y + 1)) best = Math.min(best, Math.hypot(dx, y + 1 - v));
        if (!isFarm(x - 1, y)) best = Math.min(best, Math.hypot(u - x, dy));
        if (!isFarm(x + 1, y)) best = Math.min(best, Math.hypot(x + 1 - u, dy));
      }
    }
    return best;
  };
  const node = (I: number, J: number): number => {
    const k = J * ln + I;
    if (vid[k] >= 0) return vid[k];
    const u = I / RF, v = J / RF;
    const [wx, wz] = cornerToWorld(u, v, width, height);
    const margin = 0.05 + vnoise(u * 1.6, v * 1.6, 150) * 0.17 + (vnoise(u * 5, v * 5, 151) - 0.5) * 0.04;
    const e = Math.max(-0.3, Math.min(boundaryDist(u, v) - margin, roadDistance(hasRoad, width, height, u, v) - 0.2));
    const [px, py] = farmPatch(u, v);
    vid[k] = pos.length / 3;
    pos.push(wx, FARM_Y, wz);
    tc.push(u, v);
    edgeA.push(e);
    nodeEdge[vid[k]] = e;
    nodePatch[vid[k] * 2] = px;
    nodePatch[vid[k] * 2 + 1] = py;
    return vid[k];
  };
  for (const [x, y] of farmTiles) {
    for (let j = 0; j < RF; j++) {
      for (let i = 0; i < RF; i++) {
        const I = x * RF + i, J = y * RF + j;
        const a = node(I, J), b = node(I + 1, J), d = node(I + 1, J + 1), e = node(I, J + 1);
        idx.push(a, e, d, a, d, b);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(pos.map((_, k) => (k % 3 === 1 ? 1 : 0)), 3));
  geo.setAttribute("tc", new THREE.Float32BufferAttribute(tc, 2));
  geo.setAttribute("edge", new THREE.Float32BufferAttribute(edgeA, 1));
  geo.setIndex(idx);
  geo.computeBoundingSphere();

  // Hedgerows: walk each lattice edge once.
  const hedges: Prop[] = [], trees: Prop[] = [];
  const seen = new Uint8Array(ln * (height * RF + 1) * 2);
  const plant = (u: number, v: number, salt: number, treeChance: number) => {
    const h = hash2(Math.round(u * 97), Math.round(v * 97), salt);
    if (h < 0.1) return;
    const [wx, wz] = cornerToWorld(u, v, width, height);
    const tint = HEDGE_TINT[Math.floor(hash2(Math.round(u * 97), Math.round(v * 97), salt + 1) * HEDGE_TINT.length)];
    if (h > 1 - treeChance) trees.push({ x: wx, z: wz, ry: h * 40, s: 0.85 + (1 - h) * 6, color: tint });
    else hedges.push({ x: wx, z: wz, ry: h * 40, s: 0.95 + h * 0.35, color: tint });
  };
  const walk = (I0: number, J0: number, I1: number, J1: number, key: number) => {
    if (seen[key]) return;
    seen[key] = 1;
    const A = vid[J0 * ln + I0], B = vid[J1 * ln + I1];
    if (A < 0 || B < 0) return;
    const eA = nodeEdge[A], eB = nodeEdge[B];
    const ua = I0 / RF, va = J0 / RF, ub = I1 / RF, vb = J1 / RF;
    if ((eA - HEDGE_AT) * (eB - HEDGE_AT) < 0) {
      const t = (HEDGE_AT - eA) / (eB - eA);
      plant(ua + (ub - ua) * t, va + (vb - va) * t, 170, 0.05);
    }
    const pax = nodePatch[A * 2], pay = nodePatch[A * 2 + 1], pbx = nodePatch[B * 2], pby = nodePatch[B * 2 + 1];
    if ((pax === pbx && pay === pby) || isTrack(pax, pay, pbx, pby)) return;
    const [sax, say] = farmSeed(pax, pay), [sbx, sby] = farmSeed(pbx, pby);
    const nxp = sbx - sax, nyp = sby - say;
    const den = 2 * ((ub - ua) * nxp + (vb - va) * nyp);
    if (Math.abs(den) < 1e-9) return;
    const t = Math.max(0, Math.min(1, (sbx * sbx + sby * sby - sax * sax - say * say - 2 * (ua * nxp + va * nyp)) / den));
    if (eA + (eB - eA) * t < 0.09) return;
    plant(ua + (ub - ua) * t, va + (vb - va) * t, 172, 0.08);
  };
  for (const [x, y] of farmTiles) {
    for (let j = 0; j <= RF; j++) {
      for (let i = 0; i <= RF; i++) {
        const I = x * RF + i, J = y * RF + j;
        if (i < RF) walk(I, J, I + 1, J, (J * ln + I) * 2);
        if (j < RF) walk(I, J, I, J + 1, (J * ln + I) * 2 + 1);
      }
    }
  }
  return { geo, hedges, trees };
}
