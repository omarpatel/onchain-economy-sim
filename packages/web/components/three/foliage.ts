import * as THREE from "three";
import { merge, tintedStandardMaterial, type Part } from "./geometry.ts";
import { STYLE } from "./stylize.ts";

/**
 * Wind and ground cover. Every swaying mesh carries a per-vertex `flex`
 * attribute: how far (world units, at instance scale 1 and full wind) that
 * vertex may travel. Trunks and stems stay planted at 0, canopy tops and
 * blade tips get the most. The sway itself is a vertex-shader lean into the
 * wind plus an oscillation phased by instance position, scaled by a gust
 * field that rolls across the map downwind, plus a fast leaf flutter.
 * `STYLE.uWind` (seconds) and `STYLE.uWindStrength` drive it all.
 */

/** Prevailing wind direction (xz, normalised) shared by foliage, crops and anything else that leans. */
export const WIND_DIR = new THREE.Vector2(0.86, 0.51);

/**
 * GLSL gust field: two octaves of value noise scrolled downwind, so bright
 * gust fronts (≈1) sweep across the map every few seconds between calmer
 * troughs (≈0). Self-contained (own hash) so any shader may include it.
 */
export const GLSL_WIND = /* glsl */ `
uniform float uWind;
uniform float uWindStrength;
const vec2 WIND_DIR = vec2(${WIND_DIR.x.toFixed(3)}, ${WIND_DIR.y.toFixed(3)});
float wnHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float wnNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(wnHash(i), wnHash(i + vec2(1.0, 0.0)), u.x), mix(wnHash(i + vec2(0.0, 1.0)), wnHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float windGust(vec2 p, float t) {
  vec2 q = p * 0.05 - WIND_DIR * t * 0.32;
  return smoothstep(0.3, 0.85, wnNoise(q) * 0.7 + wnNoise(q * 2.7 + 5.3) * 0.3);
}`;

/** Vertex displacement: lean + gust + oscillation + flutter, in the instance's object space so yaw and scale carry it correctly. */
const SWAY_VERTEX = /* glsl */ `
  vec3 fBase = instanceMatrix[3].xyz;
  float fScale = length(instanceMatrix[0].xyz);
  float fPhase = wnHash(fBase.xz) * 6.2832;
  float fGust = windGust(fBase.xz, uWind);
  float fSway = (0.25 + 0.95 * fGust) * (0.55 + 0.45 * sin(uWind * (1.3 + 0.5 * fGust) + fPhase + dot(fBase.xz, WIND_DIR) * 0.35));
  vec2 fWorld = WIND_DIR * fSway + vec2(-WIND_DIR.y, WIND_DIR.x) * 0.18 * sin(uWind * 0.9 + fPhase * 1.7);
  float fFlutter = sin(uWind * 7.3 + fPhase * 3.0 + dot(position, vec3(11.0, 7.0, 13.0))) * (0.15 + 0.25 * fGust);
  vec3 fObj = transpose(mat3(instanceMatrix)) * vec3(fWorld.x, 0.0, fWorld.y) / max(fScale * fScale, 1e-4);
  float fAmt = flex * uWindStrength * fScale;
  transformed += fObj * fAmt + vec3(0.0, fFlutter * 0.35, 0.0) * flex * uWindStrength;`;

/** Scale each instance into the ground between 78% and 100% of `uFar` from the camera (scatter LOD). */
const FADE_VERTEX = /* glsl */ `
  float fFade = 1.0 - smoothstep(uFar * 0.78, uFar, distance(cameraPosition, instanceMatrix[3].xyz));
  transformed *= fFade;`;

function patchVertex(s: THREE.WebGLProgramParametersWithUniforms, fade: number | null): void {
  s.uniforms.uWind = STYLE.uWind;
  s.uniforms.uWindStrength = STYLE.uWindStrength;
  if (fade !== null) s.uniforms.uFar = { value: fade };
  s.vertexShader = s.vertexShader
    .replace("#include <common>", `#include <common>\nattribute float flex;\n${fade !== null ? "uniform float uFar;" : ""}\n${GLSL_WIND}`)
    .replace("#include <begin_vertex>", `#include <begin_vertex>\n${fade !== null ? FADE_VERTEX : ""}\n${SWAY_VERTEX}`);
}

let foliageMat: THREE.MeshStandardMaterial | null = null;
let foliageDepth: THREE.MeshDepthMaterial | null = null;

/**
 * Tinted foliage (trees, bushes, hedges, reeds): `tintedStandardMaterial`
 * plus wind sway. Needs `flex` on the geometry. Shadow casters pair it with
 * `foliageDepthMaterial` so shadows sway with the leaves.
 */
export function foliageMaterial(): THREE.MeshStandardMaterial {
  if (foliageMat) return foliageMat;
  const m = tintedStandardMaterial({ roughness: 0.88 });
  const base = m.onBeforeCompile;
  m.onBeforeCompile = (s, r) => {
    base.call(m, s, r);
    patchVertex(s, null);
  };
  m.customProgramCacheKey = () => "tintMaskGlowRoofAccent+foliage";
  foliageMat = m;
  return m;
}

/** Shadow-pass twin of `foliageMaterial`: same displacement, so shadows move with the canopy. */
export function foliageDepthMaterial(): THREE.MeshDepthMaterial {
  if (foliageDepth) return foliageDepth;
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  m.onBeforeCompile = (s) => patchVertex(s, null);
  m.customProgramCacheKey = () => "foliageDepth";
  foliageDepth = m;
  return m;
}

const scatterMats = new Map<number, THREE.MeshStandardMaterial>();

/**
 * Ground cover (grass tufts, flowers, clover, stones): foliage sway plus a
 * distance fade that sinks instances into the ground approaching `far`
 * units from the camera. Double-sided because blades are single triangles.
 */
export function scatterMaterial(far: number): THREE.MeshStandardMaterial {
  let m = scatterMats.get(far);
  if (m) return m;
  const mat = tintedStandardMaterial({ roughness: 0.95 });
  mat.side = THREE.DoubleSide;
  const base = mat.onBeforeCompile;
  mat.onBeforeCompile = (s, r) => {
    base.call(mat, s, r);
    patchVertex(s, far);
  };
  mat.customProgramCacheKey = () => `tintMaskGlowRoofAccent+scatter${far}`;
  scatterMats.set(far, mat);
  return mat;
}

/**
 * Adds `flex` to a geometry: `amp` × ((y − y0) / (top − y0))^1.6, 0 below
 * `y0`. Trunks bend gently from the root, canopy tops travel furthest.
 */
export function withFlex(geo: THREE.BufferGeometry, amp: number, y0 = 0): THREE.BufferGeometry {
  const pos = geo.getAttribute("position");
  if (!geo.boundingBox) geo.computeBoundingBox();
  const top = geo.boundingBox!.max.y;
  const flex = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) flex[i] = amp * Math.pow(Math.max(0, (pos.getY(i) - y0) / Math.max(1e-4, top - y0)), 1.6);
  geo.setAttribute("flex", new THREE.BufferAttribute(flex, 1));
  return geo;
}

/* ───────────────────────── ground cover geometry ───────────────────────── */

export interface ScatterGeometries {
  /** Crossed grass blades shading dark → light toward the tips; whole tuft takes the instance tint. */
  tuft: THREE.BufferGeometry;
  /** A clump of wildflowers on stems; heads take the instance tint (petal colour). */
  flowers: THREE.BufferGeometry;
  /** Low clover patch with a few white heads; leaves take the tint. */
  clover: THREE.BufferGeometry;
  /** Half-sunk field stone and a pebble; tinted grey/ochre per instance. */
  rock: THREE.BufferGeometry;
  /** 'Sold' stake: post + pennant (pennant takes the owner colour). */
  stake: THREE.BufferGeometry;
}

let scatterCache: ScatterGeometries | null = null;

/** Hand-built blade tuft: `n` single-triangle blades fanned round the base, vertex colour ramped base → tip, normals straight up so blades light like the turf they grow from. */
function bladeTuft(n: number): THREE.BufferGeometry {
  const pos: number[] = [], col: number[] = [];
  const base = new THREE.Color("#4f7a34"), tip = new THREE.Color("#a6c46a");
  for (let k = 0; k < n; k++) {
    const a = k * 2.399 + 0.3, r = 0.012 + (k % 3) * 0.012;
    const h = 0.09 + ((k * 7) % 5) * 0.022, lean = 0.025 + (k % 4) * 0.012, w = 0.011;
    const cx = Math.cos(a) * r, cz = Math.sin(a) * r;
    const tx = -Math.sin(a), tz = Math.cos(a);
    pos.push(cx - tx * w, 0, cz - tz * w, cx + tx * w, 0, cz + tz * w, cx + Math.cos(a) * lean, h, cz + Math.sin(a) * lean);
    for (const c of [base, base, tip]) col.push(c.r, c.g, c.b);
  }
  const g = new THREE.BufferGeometry();
  const count = pos.length / 3;
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(new Array(count).fill(0).flatMap(() => [0, 1, 0]), 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute("tintMask", new THREE.Float32BufferAttribute(new Array(count).fill(1), 1));
  g.setAttribute("glow", new THREE.Float32BufferAttribute(new Array(count).fill(0), 1));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/** Thin stem (3-sided prism) from the ground to (x, h, z), leaning by (lx, lz). */
function stem(x: number, z: number, h: number, lx: number, lz: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(0.004, 0.006, h, 3, 1, true);
  g.translate(0, h / 2, 0);
  const p = g.getAttribute("position");
  for (let i = 0; i < p.count; i++) {
    const t = p.getY(i) / h;
    p.setXYZ(i, p.getX(i) + x + lx * t, p.getY(i), p.getZ(i) + z + lz * t);
  }
  return g;
}

export function scatterGeometries(): ScatterGeometries {
  if (scatterCache) return scatterCache;
  const T = true, F = false;

  const flowerParts: Part[] = [];
  for (let k = 0; k < 7; k++) {
    const a = k * 2.399, r = 0.02 + (k % 3) * 0.028, h = 0.08 + ((k * 5) % 4) * 0.025;
    const x = Math.cos(a) * r, z = Math.sin(a) * r, lx = Math.cos(a) * 0.015, lz = Math.sin(a) * 0.015;
    flowerParts.push({ geo: stem(x, z, h, lx, lz), color: "#5d8a3a", tint: F });
    const head = new THREE.OctahedronGeometry(0.022 + (k % 2) * 0.006, 0);
    head.scale(1, 0.55, 1);
    head.translate(x + lx, h + 0.006, z + lz);
    flowerParts.push({ geo: head, color: "#ffffff", tint: T });
    if (k % 2 === 0) {
      const eye = new THREE.OctahedronGeometry(0.009, 0);
      eye.translate(x + lx, h + 0.016, z + lz);
      flowerParts.push({ geo: eye, color: "#e9b632", tint: F });
    }
  }
  const flowers = withFlex(merge(flowerParts), 0.05);

  const cloverParts: Part[] = [];
  for (let k = 0; k < 7; k++) {
    const a = k * 2.399, r = 0.015 + (k % 3) * 0.03;
    const leaf = new THREE.IcosahedronGeometry(0.034, 0);
    leaf.scale(1, 0.38, 1);
    leaf.translate(Math.cos(a) * r, 0.012 + (k % 2) * 0.008, Math.sin(a) * r);
    cloverParts.push({ geo: leaf, color: k % 2 ? "#4f8a3c" : "#5f9a46", tint: T });
  }
  for (let k = 0; k < 3; k++) {
    const head = new THREE.IcosahedronGeometry(0.013, 0);
    head.translate(Math.cos(k * 2.1 + 0.5) * 0.04, 0.045, Math.sin(k * 2.1 + 0.5) * 0.04);
    cloverParts.push({ geo: head, color: k === 1 ? "#e6c6dc" : "#f1efe6", tint: F });
  }
  const clover = withFlex(merge(cloverParts), 0.012);

  const big = new THREE.DodecahedronGeometry(0.075, 0);
  big.scale(1.2, 0.62, 0.95);
  big.rotateY(0.5);
  big.translate(0, 0.012, 0);
  const pebble = new THREE.DodecahedronGeometry(0.035, 0);
  pebble.scale(1, 0.6, 1.1);
  pebble.translate(0.085, 0.004, 0.03);
  const rock = withFlex(merge([{ geo: big, color: "#ffffff", tint: T }, { geo: pebble, color: "#e9e6de", tint: T }]), 0);

  const pole = new THREE.BoxGeometry(0.025, 0.36, 0.025);
  pole.translate(0, 0.18, 0);
  const tipCap = new THREE.BoxGeometry(0.035, 0.02, 0.035);
  tipCap.translate(0, 0.37, 0);
  const pennant = new THREE.BufferGeometry();
  pennant.setAttribute("position", new THREE.Float32BufferAttribute([0.012, 0.35, 0, 0.012, 0.24, 0, 0.17, 0.3, 0, 0.012, 0.35, 0, 0.17, 0.3, 0, 0.012, 0.24, 0], 3));
  pennant.computeVertexNormals();
  const stake = merge([
    { geo: pole, color: "#9a7a52", tint: F },
    { geo: tipCap, color: "#e8e2d4", tint: F },
    { geo: pennant, color: "#ffffff", tint: T },
  ]);
  // only the pennant's free corner flutters; the post stays rigid
  const sp = stake.getAttribute("position");
  const flex = new Float32Array(sp.count);
  for (let i = 0; i < sp.count; i++) flex[i] = Math.max(0, sp.getX(i) - 0.02) * 0.45;
  stake.setAttribute("flex", new THREE.BufferAttribute(flex, 1));

  scatterCache = { tuft: withFlex(bladeTuft(9), 0.055), flowers, clover, rock, stake };
  return scatterCache;
}

/* ───────────────────────── chunked scatter (CPU-side LOD) ───────────────────────── */

/** One scatter placement: world position, yaw, uniform scale, vertical stretch, tint. */
export interface ScatterItem { x: number; z: number; ry: number; s: number; sy: number; color: THREE.Color }

/** World-unit size of a scatter chunk: the unit of CPU culling. */
export const CHUNK = 8.8;

/**
 * Scatter grouped by chunk, matrices and colours pre-packed so a frame that
 * re-culls only block-copies the chunks in range into the instance buffers
 * (via per-chunk subarray views made once here, so culling allocates nothing).
 */
export interface Chunked {
  count: number;
  chunks: { cx: number; cz: number; m: Float32Array; c: Float32Array; n: number }[];
}

const dummy = new THREE.Object3D();

export function chunkScatter(items: readonly ScatterItem[]): Chunked {
  const byKey = new Map<number, ScatterItem[]>();
  for (const it of items) {
    const k = Math.floor(it.x / CHUNK) * 4096 + Math.floor(it.z / CHUNK);
    let list = byKey.get(k);
    if (!list) byKey.set(k, (list = []));
    list.push(it);
  }
  const m = new Float32Array(items.length * 16), c = new Float32Array(items.length * 3);
  const chunks: Chunked["chunks"] = [];
  let n = 0;
  for (const list of byKey.values()) {
    const start = n;
    for (const it of list) {
      dummy.position.set(it.x, 0, it.z);
      dummy.rotation.set(0, it.ry, 0);
      dummy.scale.set(it.s, it.s * it.sy, it.s);
      dummy.updateMatrix();
      dummy.matrix.toArray(m, n * 16);
      c[n * 3] = it.color.r; c[n * 3 + 1] = it.color.g; c[n * 3 + 2] = it.color.b;
      n++;
    }
    const cx = (Math.floor(list[0].x / CHUNK) + 0.5) * CHUNK, cz = (Math.floor(list[0].z / CHUNK) + 0.5) * CHUNK;
    chunks.push({ cx, cz, m: m.subarray(start * 16, n * 16), c: c.subarray(start * 3, n * 3), n: n - start });
  }
  return { count: items.length, chunks };
}
