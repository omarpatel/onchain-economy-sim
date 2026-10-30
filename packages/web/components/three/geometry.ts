import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { BuildingType } from "@econ-sim/sim/goods";
import { ALL_BUILDINGS } from "@econ-sim/sim/goods";
import { BUILDING_STYLE, hash2 } from "./world-style.ts";
import { stylize } from "./stylize.ts";

/**
 * Procedural low-poly compound geometry: every building variant and every
 * lot-dressing kind is one merged, non-indexed BufferGeometry so the whole
 * city draws from two BatchedMeshes.
 *
 * Four vertex attributes drive coloring:
 *  - `color`    the part's own albedo (cladding, steel, glass…)
 *  - `tintMask` 0 fixed colour; 1 multiplied by the per-instance rgb (wall
 *               shade/dim, car paint); 2 roof and 3 accent: on a BatchedMesh
 *               they take the roof / company colour packed into the
 *               instance colour's alpha (see `packPaint`)
 *  - `glow`     1 for windows/lamp heads: warm emissive at night (uNight)
 * `tintedStandardMaterial()` patches the instancing shader to honor them.
 */

export const C = {
  roof: "#e6dfcc",
  parapet: "#a89f8c",
  gable: "#c9b995",
  concrete: "#b9b2a2",
  dark: "#3d3f44",
  steel: "#b7bcc2",
  wood: "#8a5a3a",
  stack: "#6a6c70",
  stackTop: "#7f2d2d",
  glass: "#5c6a78",
  crop: "#c49a4a",
  cropDark: "#7a5a3a",
  leaf: "#4f8f3e",
  leafLight: "#6fb14c",
  leafDark: "#3b7a33",
  trunk: "#5a3a1e",
  water: "#3aa4c8",
  grain: "#e0d1a0",
  coal: "#2a2b2e",
  ore: "#8f7a5a",
  rust: "#a3552b",
  scaffold: "#c4bfb4",
  crane: "#e0b23a",
  pipe: "#7c8794",
  pallet: "#a97a4a",
  tank: "#d6d2c8",
  lampHead: "#ffe6b0",
  lampPost: "#4a4d52",
} as const;

/** Industrial claddings and trims; walls carry their own cladding colour, the instance only shades it. */
const K = {
  plinth: "#857f74",
  dock: "#a7a194",
  rollup: "#c6cace",
  frame: "#464b52",
  canopy: "#5b6168",
  hvac: "#c9cdd1",
  fan: "#33373d",
  brick: "#a65d45",
  brickDark: "#86493a",
  sand: "#d9cfb8",
  cream: "#e7dfcd",
  panel: "#e2e0da",
  blue: "#8797ab",
  steelClad: "#aab1b8",
  slate: "#69717b",
  sage: "#93a28b",
  timber: "#93643f",
  rustClad: "#8b5a45",
  glassHouse: "#b9d4d2",
  glassRoof: "#d3e6e3",
  silo: "#d8d3c6",
  grainBin: "#c2c7cc",
  sign: "#2a2e34",
  letters: "#f3efe4",
  earth: "#6f5a43",
  hay: "#d7b865",
  field: "#7ea24c",
  primer: "#9a5a3c",
  white: "#ece9e2",
  flame: "#ff8a3a",
} as const;

/** `tint` takes the per-instance rgb; `roof`/`accent` take the packed roof / company colour (see `packPaint`). */
export interface Part { geo: THREE.BufferGeometry; color: string; tint: boolean; glow?: boolean; roof?: boolean; accent?: boolean }

type V3 = [number, number, number];

const tmpM = new THREE.Matrix4();
const tmpE = new THREE.Euler();
const tmpQ = new THREE.Quaternion();
const tmpP = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const tmpD = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** Translate/rotate/scale a geometry in place. */
export function xf(geo: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): THREE.BufferGeometry {
  tmpE.set(rx, ry, rz);
  tmpQ.setFromEuler(tmpE);
  tmpP.set(x, y, z);
  tmpS.set(sx, sy, sz);
  tmpM.compose(tmpP, tmpQ, tmpS);
  geo.applyMatrix4(tmpM);
  return geo;
}

/** Box centered at (x, y, z). */
export function box(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  return xf(new THREE.BoxGeometry(w, h, d), x, y, z);
}

/** Box whose base sits at `y` (buildings on the ground). */
export function boxUp(w: number, h: number, d: number, x: number, y: number, z: number, ry = 0): THREE.BufferGeometry {
  return xf(new THREE.BoxGeometry(w, h, d), x, y + h / 2, z, 0, ry, 0);
}

export function cyl(rTop: number, rBot: number, h: number, x: number, y: number, z: number, seg = 10, rx = 0, rz = 0): THREE.BufferGeometry {
  return xf(new THREE.CylinderGeometry(rTop, rBot, h, seg), x, y + (rx === 0 && rz === 0 ? h / 2 : 0), z, rx, 0, rz);
}

export function cone(r: number, h: number, x: number, y: number, z: number, seg = 8): THREE.BufferGeometry {
  return xf(new THREE.ConeGeometry(r, h, seg), x, y + h / 2, z);
}

/** Orient a y-aligned, origin-centred geometry so it spans a → b. */
function span(g: THREE.BufferGeometry, a: V3, b: V3): THREE.BufferGeometry {
  tmpD.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
  tmpQ.setFromUnitVectors(UP, tmpD);
  tmpP.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  tmpS.set(1, 1, 1);
  g.applyMatrix4(tmpM.compose(tmpP, tmpQ, tmpS));
  return g;
}

const dist = (a: V3, b: V3) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
/** Square-section strut from a to b. */
const beam = (a: V3, b: V3, t: number) => span(new THREE.BoxGeometry(t, dist(a, b), t), a, b);
/** Round pipe from a to b. */
const tube = (a: V3, b: V3, r: number, seg = 6) => span(new THREE.CylinderGeometry(r, r, dist(a, b), seg, 1, true), a, b);

/**
 * Extruded convex 2D profile (CCW, in the XY plane) along Z. Used for gabled
 * and sawtooth roofs. Non-indexed with outward normals.
 */
function prism(profile: [number, number][], depth: number): THREE.BufferGeometry {
  const n = profile.length;
  const pos: number[] = [];
  const push = (a: [number, number, number], b: [number, number, number], c: [number, number, number]) => pos.push(...a, ...b, ...c);
  const hz = depth / 2;
  // caps (fan) — front (+z) CCW, back (-z) CW
  for (let i = 1; i < n - 1; i++) {
    push([profile[0][0], profile[0][1], hz], [profile[i][0], profile[i][1], hz], [profile[i + 1][0], profile[i + 1][1], hz]);
    push([profile[0][0], profile[0][1], -hz], [profile[i + 1][0], profile[i + 1][1], -hz], [profile[i][0], profile[i][1], -hz]);
  }
  // sides
  for (let i = 0; i < n; i++) {
    const [ax, ay] = profile[i];
    const [bx, by] = profile[(i + 1) % n];
    push([ax, ay, hz], [ax, ay, -hz], [bx, by, -hz]);
    push([ax, ay, hz], [bx, by, -hz], [bx, by, hz]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** Two-tone canopy on a trunk; `s` scales the whole tree. Canopy takes the instance tint on instanced meshes. */
export function tree(x: number, z: number, s = 1, tintCanopy = false): Part[] {
  return [
    { geo: cyl(0.06 * s, 0.09 * s, 0.4 * s, x, 0, z, 5), color: C.trunk, tint: false },
    { geo: cone(0.34 * s, 0.62 * s, x, 0.32 * s, z, 6), color: C.leaf, tint: tintCanopy },
    { geo: cone(0.26 * s, 0.5 * s, x, 0.66 * s, z, 6), color: C.leafLight, tint: tintCanopy },
  ];
}

/* ───────────────────────── part kit ───────────────────────── */

const wallP = (geo: THREE.BufferGeometry, color: string): Part => ({ geo, color, tint: true });
const fix = (geo: THREE.BufferGeometry, color: string): Part => ({ geo, color, tint: false });
const roofP = (geo: THREE.BufferGeometry): Part => ({ geo, color: C.roof, tint: false, roof: true });
const glass = (geo: THREE.BufferGeometry, color: string = C.glass): Part => ({ geo, color, tint: false, glow: true });
/** Company-colour part; `fallback` shows where no packed accent exists (ghost preview). */
const accentP = (geo: THREE.BufferGeometry, fallback: string): Part => ({ geo, color: fallback, tint: false, accent: true });

function shade(hex: string, k: number): string {
  return `#${new THREE.Color(hex).multiplyScalar(k).getHexString()}`;
}

/** Rotate a set of parts about the y axis through (cx, cz). */
function turn(parts: Part[], ry: number, cx = 0, cz = 0): Part[] {
  for (const p of parts) {
    p.geo.translate(-cx, 0, -cz);
    p.geo.rotateY(ry);
    p.geo.translate(cx, 0, cz);
  }
  return parts;
}

type RoofKind = "flat" | "gable" | "gableZ" | "saw" | "barrel" | "monitor" | "none";

function parapet(w: number, d: number, h: number, x: number, z: number, color: string = C.parapet): Part[] {
  const r = 0.045;
  return [
    fix(boxUp(w + 0.02, 0.07, r, x, h - 0.01, z - d / 2 + r / 2), color),
    fix(boxUp(w + 0.02, 0.07, r, x, h - 0.01, z + d / 2 - r / 2), color),
    fix(boxUp(r, 0.07, d - r * 2, x - w / 2 + r / 2, h - 0.01, z), color),
    fix(boxUp(r, 0.07, d - r * 2, x + w / 2 - r / 2, h - 0.01, z), color),
  ];
}

function roofOf(kind: RoofKind, w: number, d: number, h: number, x: number, z: number, clad: string, pitch?: number, roofColor?: string): Part[] {
  const R = (g: THREE.BufferGeometry): Part => (roofColor ? fix(g, roofColor) : roofP(g));
  switch (kind) {
    case "none":
      return [];
    case "flat":
      return [R(boxUp(w - 0.06, 0.035, d - 0.06, x, h, z)), ...parapet(w, d, h, x, z)];
    case "gable": {
      // ridge along x, slopes face ±z; the gable infill keeps the wall cladding
      const r = pitch ?? Math.min(0.3, d * 0.3);
      const a = Math.atan2(r, d / 2);
      const L = Math.hypot(d / 2, r) + 0.07;
      return [
        wallP(xf(prism([[-d / 2, 0], [d / 2, 0], [0, r]], w), x, h, z, 0, Math.PI / 2, 0), clad),
        R(xf(new THREE.BoxGeometry(w + 0.08, 0.035, L), x, h + r / 2 + 0.018, z + d / 4 + 0.012, a, 0, 0)),
        R(xf(new THREE.BoxGeometry(w + 0.08, 0.035, L), x, h + r / 2 + 0.018, z - d / 4 - 0.012, -a, 0, 0)),
      ];
    }
    case "gableZ": {
      const r = pitch ?? Math.min(0.3, w * 0.3);
      const a = Math.atan2(r, w / 2);
      const L = Math.hypot(w / 2, r) + 0.07;
      return [
        wallP(xf(prism([[-w / 2, 0], [w / 2, 0], [0, r]], d), x, h, z), clad),
        R(xf(new THREE.BoxGeometry(L, 0.035, d + 0.08), x + w / 4 + 0.012, h + r / 2 + 0.018, z, 0, 0, -a)),
        R(xf(new THREE.BoxGeometry(L, 0.035, d + 0.08), x - w / 4 - 0.012, h + r / 2 + 0.018, z, 0, 0, a)),
      ];
    }
    case "saw": {
      const n = Math.max(2, Math.round(w / 0.36));
      const tw = w / n;
      const th = Math.min(0.24, tw * 0.62);
      const out: Part[] = [];
      for (let i = 0; i < n; i++) {
        const cx = x - w / 2 + tw * (i + 0.5);
        out.push(R(xf(prism([[-tw / 2, 0], [tw / 2, 0], [-tw / 2, th]], d), cx, h, z)));
        out.push(glass(boxUp(0.014, th * 0.78, d - 0.1, cx - tw / 2 - 0.004, h + 0.02, z)));
      }
      return out;
    }
    case "barrel": {
      const rise = pitch ?? Math.min(0.26, d * 0.24);
      return [R(xf(new THREE.CylinderGeometry(1, 1, w + 0.04, 12, 1, false, 0, Math.PI), x, h, z, 0, 0, Math.PI / 2, rise, 1, d / 2 + 0.03))];
    }
    case "monitor":
      return [
        R(boxUp(w - 0.06, 0.035, d - 0.06, x, h, z)),
        ...parapet(w, d, h, x, z),
        wallP(boxUp(w * 0.84, 0.16, d * 0.3, x, h, z), clad),
        glass(box(w * 0.78, 0.08, 0.014, x, h + 0.09, z + d * 0.15 + 0.004)),
        glass(box(w * 0.78, 0.08, 0.014, x, h + 0.09, z - d * 0.15 - 0.004)),
        R(boxUp(w * 0.9, 0.03, d * 0.38, x, h + 0.16, z)),
      ];
  }
}

interface HallOpts {
  w: number; d: number; h: number; x?: number; z?: number; clad: string;
  roof?: RoofKind; pitch?: number; roofColor?: string;
  /** window band height; false for none */
  band?: number | false;
  /** pilaster rhythm on the long faces */
  pil?: boolean;
  plinth?: boolean;
}

/** An industrial hall: clad walls, concrete plinth, optional pilasters and glazed band, and a roof. */
function hall(o: HallOpts): Part[] {
  const { w, d, h, clad } = o;
  const x = o.x ?? 0, z = o.z ?? 0;
  const out: Part[] = [wallP(boxUp(w, h, d, x, 0, z), clad)];
  if (o.plinth !== false) out.push(fix(boxUp(w + 0.022, 0.08, d + 0.022, x, 0, z), K.plinth));
  if (o.band !== false) {
    const by = o.band ?? Math.max(0.3, h * 0.6);
    const bh = Math.min(0.12, h * 0.16);
    out.push(glass(box(w - 0.16, bh, 0.016, x, by, z + d / 2 + 0.004)), glass(box(w - 0.16, bh, 0.016, x, by, z - d / 2 - 0.004)));
    if (d > 0.5) out.push(glass(box(0.016, bh, d - 0.16, x + w / 2 + 0.004, by, z)), glass(box(0.016, bh, d - 0.16, x - w / 2 - 0.004, by, z)));
  }
  if (o.pil) {
    const pc = shade(clad, 0.82);
    const n = Math.max(2, Math.round(w / 0.34));
    for (let i = 1; i < n; i++) {
      const px = x - w / 2 + (i * w) / n;
      out.push(wallP(boxUp(0.04, h - 0.08, 0.022, px, 0.08, z + d / 2 + 0.009), pc), wallP(boxUp(0.04, h - 0.08, 0.022, px, 0.08, z - d / 2 - 0.009), pc));
    }
  }
  out.push(...roofOf(o.roof ?? "flat", w, d, h, x, z, clad, o.pitch, o.roofColor));
  return out;
}

/** Multi-storey office/admin block with glazed bands on every floor. Returns the parts and its height. */
function office(o: { w: number; d: number; floors: number; x: number; z: number; clad: string; glassy?: boolean; roof?: RoofKind }): Part[] {
  const fh = 0.27;
  const h = o.floors * fh + 0.06;
  const { w, d, x, z } = o;
  const out: Part[] = [wallP(boxUp(w, h, d, x, 0, z), o.clad), fix(boxUp(w + 0.02, 0.05, d + 0.02, x, 0, z), K.plinth)];
  const bh = o.glassy ? 0.2 : 0.12;
  for (let f = 0; f < o.floors; f++) {
    const by = 0.05 + f * fh + 0.14;
    out.push(
      glass(box(w - 0.06, bh, 0.014, x, by, z + d / 2 + 0.004)),
      glass(box(w - 0.06, bh, 0.014, x, by, z - d / 2 - 0.004)),
      glass(box(0.014, bh, d - 0.06, x + w / 2 + 0.004, by, z)),
      glass(box(0.014, bh, d - 0.06, x - w / 2 - 0.004, by, z)),
    );
  }
  out.push(...roofOf(o.roof ?? "flat", w, d, h, x, z, o.clad));
  return out;
}

/** Loading docks: raised platform, roll-up doors in frames and a steel canopy, facing +z at (x, z), turned by `ry`. */
function docks(x: number, z: number, n: number, door: string = K.rollup, ry = 0): Part[] {
  const sp = 0.29;
  const len = n * sp + 0.06;
  const out: Part[] = [
    fix(boxUp(len, 0.09, 0.14, 0, 0, 0.07), K.dock),
    fix(boxUp(len + 0.06, 0.02, 0.2, 0, 0.47, 0.1), K.canopy),
  ];
  for (let i = 0; i < n; i++) {
    const cx = -((n - 1) * sp) / 2 + i * sp;
    out.push(fix(box(0.24, 0.31, 0.012, cx, 0.25, 0.004), K.frame));
    out.push(fix(box(0.2, 0.27, 0.014, cx, 0.235, 0.01), door));
  }
  for (const p of out) xf(p.geo, x, 0, z, 0, ry, 0);
  return out;
}

/** A personnel door with a small hood. */
function entry(x: number, z: number, ry = 0): Part[] {
  const out = [fix(box(0.1, 0.18, 0.012, 0, 0.09, 0.006), K.frame), fix(boxUp(0.16, 0.015, 0.07, 0, 0.21, 0.035), K.canopy)];
  for (const p of out) xf(p.geo, x, 0, z, 0, ry, 0);
  return out;
}

/** Facade sign board in the owner's colour with a light "lettering" strip, facing +z (turned by `ry`). */
function sign(x: number, y: number, z: number, w: number, h: number, fallback: string, ry = 0): Part[] {
  const out = [
    fix(box(w + 0.03, h + 0.03, 0.012, 0, 0, 0.006), K.sign),
    accentP(box(w, h, 0.012, 0, 0, 0.014), fallback),
    fix(box(w * 0.66, h * 0.3, 0.006, 0, 0, 0.022), K.letters),
  ];
  for (const p of out) xf(p.geo, x, y, z, 0, ry, 0);
  return out;
}

/** Rooftop sign on two legs. */
function roofSign(x: number, y: number, z: number, w: number, fallback: string, ry = 0): Part[] {
  const out = [
    fix(boxUp(0.025, 0.1, 0.025, -w / 2 + 0.06, 0, 0), K.frame),
    fix(boxUp(0.025, 0.1, 0.025, w / 2 - 0.06, 0, 0), K.frame),
    ...sign(0, 0.17, 0, w, 0.13, fallback),
  ];
  for (const p of out) xf(p.geo, x, y, z, 0, ry, 0);
  return out;
}

/** Rooftop HVAC unit with two fan discs. */
function hvac(x: number, y: number, z: number, ry = 0): Part[] {
  const out = [
    fix(boxUp(0.22, 0.09, 0.14, 0, 0, 0), K.hvac),
    fix(cyl(0.042, 0.042, 0.012, -0.05, 0.09, 0, 7), K.fan),
    fix(cyl(0.042, 0.042, 0.012, 0.05, 0.09, 0, 7), K.fan),
  ];
  for (const p of out) xf(p.geo, x, y, z, 0, ry, 0);
  return out;
}

/** Tapered chimney with a dark band and lip. Smoke leaves at (x, y + h, z). */
function chimney(x: number, z: number, r: number, h: number, color: string = K.brickDark, y = 0): Part[] {
  return [
    fix(cyl(r * 0.78, r, h, x, y, z, 10), color),
    fix(cyl(r * 0.84, r * 0.84, 0.07, x, y + h - 0.2, z, 10), K.fan),
    fix(cyl(r * 0.86, r * 0.86, 0.05, x, y + h - 0.05, z, 10), "#2a2b2e"),
  ];
}

/** Silo with a conical (or flat) cap, a mid band and a ladder on the +z side. */
function silo(x: number, z: number, r: number, h: number, color: string = K.silo, capCone = true): Part[] {
  const out: Part[] = [
    fix(cyl(r, r, h, x, 0, z, 12), color),
    fix(cyl(r + 0.01, r + 0.01, 0.035, x, h * 0.55, z, 12), shade(color, 0.85)),
    fix(boxUp(0.03, h, 0.014, x, 0, z + r + 0.004), K.frame),
  ];
  out.push(capCone ? fix(cone(r * 1.05, r * 0.5, x, h, z, 12), shade(color, 0.88)) : fix(cyl(r * 1.02, r * 1.02, 0.04, x, h, z, 12), shade(color, 0.88)));
  return out;
}

/** Vertical storage tank with a shallow cone roof and a stair strut. */
function tankV(x: number, z: number, r: number, h: number, color: string = C.tank, band?: string): Part[] {
  const out: Part[] = [
    fix(cyl(r, r, h, x, 0, z, 14), color),
    fix(cone(r * 1.02, r * 0.2, x, h, z, 14), shade(color, 0.9)),
    fix(beam([x + r + 0.02, 0, z - r * 0.5], [x + r * 0.75, h, z + r * 0.75], 0.03), K.frame),
  ];
  if (band) out.push(fix(cyl(r + 0.006, r + 0.006, 0.06, x, h * 0.62, z, 14), band));
  return out;
}

/** Spherical pressure tank on four legs. */
function sphereTank(x: number, z: number, r: number): Part[] {
  const out: Part[] = [fix(xf(new THREE.SphereGeometry(r, 12, 8), x, r + 0.12, z), C.tank)];
  for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) out.push(fix(boxUp(0.03, r + 0.12, 0.03, x + ox * r * 0.6, 0, z + oz * r * 0.6), K.frame));
  return out;
}

/** Process column with service platforms and a ladder. */
function column(x: number, z: number, r: number, h: number): Part[] {
  const out: Part[] = [
    fix(cyl(r, r, h, x, 0, z, 10), C.steel),
    fix(cone(r * 1.02, r * 0.6, x, h, z, 10), shade(C.steel, 0.85)),
    fix(boxUp(0.025, h, 0.012, x + r + 0.008, 0, z), K.frame),
  ];
  for (let y = 0.5; y < h - 0.2; y += 0.6) out.push(fix(cyl(r + 0.055, r + 0.055, 0.018, x, y, z, 10), K.frame));
  return out;
}

/** Horizontal pipe run on T-supports, along x (or z) at height y. */
function pipeRun(a: V3, b: V3, r = 0.026, color: string = C.pipe): Part[] {
  const out: Part[] = [fix(tube(a, b, r), color)];
  const n = Math.max(1, Math.round(dist(a, b) / 0.4));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const px = a[0] + (b[0] - a[0]) * t, pz = a[2] + (b[2] - a[2]) * t, py = a[1] + (b[1] - a[1]) * t;
    if (py > 0.12) out.push(fix(boxUp(0.025, py - r, 0.025, px, 0, pz), K.frame));
  }
  return out;
}

/** Enclosed conveyor gallery from a to b with trestles every ~0.45. */
function conveyor(a: V3, b: V3, color: string = K.steelClad): Part[] {
  const out: Part[] = [fix(beam(a, b, 0.1), color)];
  const n = Math.max(1, Math.floor(dist(a, b) / 0.45));
  for (let i = 1; i <= n; i++) {
    const t = i / (n + 1);
    const py = a[1] + (b[1] - a[1]) * t;
    if (py > 0.15) out.push(fix(boxUp(0.03, py - 0.05, 0.08, a[0] + (b[0] - a[0]) * t, 0, a[2] + (b[2] - a[2]) * t), K.frame));
  }
  return out;
}

/** Bulk heap (ore, coal, chips). */
function heap(x: number, z: number, r: number, h: number, color: string, ry = 0): Part {
  return fix(xf(new THREE.ConeGeometry(r, h * 0.8, 10, 1, true), x, h * 0.4, z, 0, ry, 0, 1.25, 1, 0.9), color);
}

/** Log stack along x. */
function logPile(x: number, z: number, ry = 0, len = 0.6): Part[] {
  const out: Part[] = [];
  const rows: [number, number][] = [[-0.12, 0.055], [0, 0.055], [0.12, 0.055], [-0.06, 0.155], [0.06, 0.155]];
  for (const [oz, oy] of rows) out.push(fix(xf(new THREE.CylinderGeometry(0.055, 0.055, len, 6), 0, oy, oz, 0, 0, Math.PI / 2), C.wood));
  return turn(out.map((p) => (xf(p.geo, x, 0, z), p)), ry, x, z);
}

/** Steel stilt legs under a box at height y. */
function legs(x: number, z: number, w: number, d: number, y: number): Part[] {
  const out: Part[] = [];
  for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) out.push(fix(boxUp(0.035, y, 0.035, x + ox * (w / 2 - 0.03), 0, z + oz * (d / 2 - 0.03)), K.frame));
  return out;
}

/** Inverted-cone hopper box on legs (ore bin, baghouse, cyclone base). */
function bin(x: number, z: number, w: number, d: number, h: number, y: number, clad: string): Part[] {
  return [
    ...legs(x, z, w, d, y),
    wallP(boxUp(w, h, d, x, y, z), clad),
    fix(xf(new THREE.ConeGeometry(Math.min(w, d) * 0.62, 0.18, 4), x, y - 0.09, z, Math.PI, Math.PI / 4, 0), shade(clad, 0.8)),
    fix(boxUp(w + 0.02, 0.03, d + 0.02, x, y + h, z), K.frame),
  ];
}

/** Dust cyclone: cylinder over a cone on a stand, with a duct. */
function cyclone(x: number, z: number, y: number): Part[] {
  return [
    ...legs(x, z, 0.22, 0.22, y),
    fix(cyl(0.11, 0.11, 0.2, x, y + 0.2, z, 10), K.steelClad),
    fix(xf(new THREE.ConeGeometry(0.11, 0.2, 10), x, y + 0.1, z, Math.PI, 0, 0), K.steelClad),
    fix(cyl(0.035, 0.035, 0.12, x, y + 0.4, z, 6), K.frame),
  ];
}

/** Lattice mast/derrick: four tapered legs with ring braces. */
function lattice(x: number, z: number, base: number, top: number, h: number, color: string = K.frame): Part[] {
  const out: Part[] = [];
  for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) out.push(fix(beam([x + ox * base / 2, 0, z + oz * base / 2], [x + ox * top / 2, h, z + oz * top / 2], 0.035), color));
  for (let y = h * 0.28; y < h; y += h * 0.26) {
    const s = base + (top - base) * (y / h);
    out.push(fix(box(s, 0.025, 0.025, x, y, z - s / 2), color), fix(box(s, 0.025, 0.025, x, y, z + s / 2), color));
    out.push(fix(box(0.025, 0.025, s, x - s / 2, y, z), color), fix(box(0.025, 0.025, s, x + s / 2, y, z), color));
  }
  out.push(fix(boxUp(top + 0.08, 0.04, top + 0.08, x, h, z), color));
  return out;
}

/** Static pumpjack (the animated one is a rotor): A-frame, beam, horsehead and motor; beam along z. */
function pumpjackFrame(x: number, z: number, accent: string): Part[] {
  return [
    fix(boxUp(0.2, 0.04, 0.95, x, 0, z), K.plinth),
    fix(beam([x - 0.08, 0.04, z - 0.14], [x, 0.58, z], 0.035), K.frame),
    fix(beam([x + 0.08, 0.04, z - 0.14], [x, 0.58, z], 0.035), K.frame),
    fix(beam([x - 0.08, 0.04, z + 0.14], [x, 0.58, z], 0.035), K.frame),
    fix(beam([x + 0.08, 0.04, z + 0.14], [x, 0.58, z], 0.035), K.frame),
    fix(boxUp(0.15, 0.13, 0.18, x, 0.04, z - 0.38), accent),
    fix(cyl(0.04, 0.05, 0.16, x, 0.04, z + 0.42, 6), C.steel),
    fix(boxUp(0.1, 0.03, 0.06, x, 0.18, z + 0.42), C.rust),
  ];
}

/** Rows of crops (or anything flat) filling a rect, rows along x. */
function rows(x0: number, z0: number, x1: number, z1: number, colors: string[], h = 0.06): Part[] {
  const out: Part[] = [];
  const n = Math.max(2, Math.round((z1 - z0) / 0.13));
  const step = (z1 - z0) / n;
  for (let i = 0; i < n; i++) out.push(fix(boxUp(x1 - x0, h, step * 0.62, (x0 + x1) / 2, 0.01, z0 + step * (i + 0.5)), colors[i % colors.length]));
  return out;
}

/** Hay bales or drums: short cylinders lying in a row along x. */
function bales(x: number, z: number, n: number, color: string = K.hay): Part[] {
  const out: Part[] = [];
  for (let i = 0; i < n; i++) out.push(fix(xf(new THREE.CylinderGeometry(0.06, 0.06, 0.09, 8), x + i * 0.1, 0.06, z, Math.PI / 2, 0, 0), color));
  return out;
}

/** Small farm tractor facing +x. */
function tractor(x: number, z: number, ry: number, color: string): Part[] {
  const out = [
    fix(boxUp(0.18, 0.07, 0.09, 0.02, 0.05, 0), color),
    fix(boxUp(0.08, 0.1, 0.09, -0.04, 0.12, 0), "#33373d"),
    fix(xf(new THREE.CylinderGeometry(0.06, 0.06, 0.13, 8), -0.05, 0.06, 0, Math.PI / 2, 0, 0), "#26282c"),
    fix(xf(new THREE.CylinderGeometry(0.035, 0.035, 0.12, 8), 0.08, 0.035, 0, Math.PI / 2, 0, 0), "#26282c"),
  ];
  for (const p of out) xf(p.geo, x, 0, z, 0, ry, 0);
  return out;
}

/** Hyperboloid cooling tower with a dark throat. */
function coolingTower(x: number, z: number, r: number, h: number): Part[] {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    pts.push(new THREE.Vector2(r * (0.62 + 0.38 * Math.pow(2 * Math.abs(t - 0.62), 1.6)), t * h));
  }
  return [fix(xf(new THREE.LatheGeometry(pts, 14), x, 0, z), "#cfcac0"), fix(cyl(r * 0.6, r * 0.6, 0.01, x, h * 0.8, z, 12), "#3a3c40")];
}

/* ───────────────────────── lot slots ───────────────────────── */

/**
 * Lot-local frame shared by every variant: the tile centre is the origin,
 * +z faces the street the building fronts, +x the other street; −x/−z are
 * the edges shared with the neighbouring parcels in the 2×2 block. Usable
 * lot (inside the sidewalks) is [−1.08, 0.83] on both axes.
 */
export const LOT = { min: -1.08, max: 0.83 } as const;

export type SlotKind = "car" | "truck" | "stuff" | "tree";
export interface Slot { k: SlotKind; x: number; z: number; ry: number }

const carS = (x: number, z: number, ry = Math.PI): Slot => ({ k: "car", x, z, ry });
const truckS = (x: number, z: number, ry = -Math.PI / 2): Slot => ({ k: "truck", x, z, ry });
const stuffS = (x: number, z: number, ry = 0): Slot => ({ k: "stuff", x, z, ry });
const treeS = (x: number, z: number): Slot => ({ k: "tree", x, z, ry: 0 });
/** Nose-in parking along the +x street. */
const sidePark = (n = 5, z0 = -0.86): Slot[] => Array.from({ length: n }, (_, i) => carS(0.66, z0 + i * 0.22));
/** Nose-in parking along the +z street. */
const frontPark = (n: number, x0: number): Slot[] => Array.from({ length: n }, (_, i) => carS(x0 + i * 0.22, 0.66, Math.PI / 2));
/** A truck backed onto a dock whose wall face is at z. */
const atDock = (x: number, zFace: number): Slot => truckS(x, zFace + 0.15 + 0.26);

export type PadKind = "concrete" | "gravel";

export interface VariantDef {
  build: (accent: string) => Part[];
  /** ground cover rects [x0, z0, x1, z1] in lot coords */
  pad: { kind: PadKind; rect: [number, number, number, number] }[];
  /** construction footprint: centre x, z, width, depth, height */
  frame: [number, number, number, number, number];
  /** rotor hub in lot coords + extra yaw of the rotor */
  rotor?: [number, number, number, number];
  /** stack tops that emit smoke */
  smoke?: V3[];
  slots: Slot[];
  /** what the "stuff" slots may hold */
  stuff?: LotKind[];
}

const FULL: [number, number, number, number] = [LOT.min, LOT.min, LOT.max, LOT.max];
const concrete = [{ kind: "concrete" as const, rect: FULL }];
const gravel = [{ kind: "gravel" as const, rect: FULL }];
const TIMBER: LotKind[] = ["lumber", "logs", "pallets", "lumber"];
const BULK: LotKind[] = ["drums", "container", "crates", "drums"];

/* ───────────────────────── building variants ───────────────────────── */

const VARIANTS: Record<BuildingType, VariantDef[]> = {
  mine: [
    {
      // open steel headframe over the shaft, brick winding house, ore bin over the truck lane
      build: (T) => [
        ...hall({ w: 0.6, d: 0.75, h: 0.55, x: -0.72, z: -0.5, clad: K.brick, roof: "gableZ", band: 0.32 }),
        ...entry(-0.72, -0.125),
        ...[[0.0, -0.55], [0.3, -0.55], [0.0, -0.15], [0.3, -0.15]].map(([x, z]) => fix(boxUp(0.06, 1.6, 0.06, x, 0, z), K.frame)),
        ...[0.5, 1.05].flatMap((y) => [fix(box(0.36, 0.035, 0.035, 0.15, y, -0.55), K.frame), fix(box(0.36, 0.035, 0.035, 0.15, y, -0.15), K.frame), fix(box(0.035, 0.035, 0.44, 0.0, y, -0.35), K.frame), fix(box(0.035, 0.035, 0.44, 0.3, y, -0.35), K.frame)]),
        fix(beam([-0.42, 0.55, -0.5], [0.02, 1.55, -0.5], 0.05), K.frame),
        fix(beam([-0.42, 0.55, -0.2], [0.02, 1.55, -0.2], 0.05), K.frame),
        fix(boxUp(0.44, 0.05, 0.52, 0.15, 1.6, -0.35), C.rust),
        fix(beam([-0.48, 0.62, -0.42], [0.15, 1.95, -0.35], 0.012), "#222"),
        ...bin(0.22, 0.12, 0.34, 0.34, 0.28, 0.36, K.rustClad),
        ...conveyor([0.2, 0.7, 0.05], [0.15, 1.15, -0.2]),
        heap(-0.55, 0.32, 0.28, 0.24, C.ore, 0.4),
        heap(-0.82, 0.08, 0.16, 0.14, C.ore, 1.2),
        ...sign(-0.72, 0.42, -0.115, 0.32, 0.08, T),
      ],
      pad: gravel,
      frame: [-0.25, -0.35, 1.35, 1.0, 1.6],
      rotor: [0.15, 1.88, -0.35, 0],
      slots: [truckS(0.22, 0.5), ...sidePark(4), stuffS(-0.88, 0.62, Math.PI / 2), treeS(0.66, 0.38), treeS(-0.95, -0.98)],
      stuff: BULK,
    },
    {
      // enclosed shaft tower with exposed sheaves, processing plant, conveyor to a loadout silo
      build: (T) => [
        ...hall({ w: 0.42, d: 0.42, h: 1.55, x: 0.18, z: -0.62, clad: K.blue, band: 1.2, plinth: true }),
        fix(box(0.39, 0.1, 0.016, 0.18, 0.85, -0.405), C.glass),
        fix(boxUp(0.06, 0.32, 0.06, 0.05, 1.55, -0.62), K.frame),
        fix(boxUp(0.06, 0.32, 0.06, 0.31, 1.55, -0.62), K.frame),
        ...hall({ w: 0.78, d: 1.0, h: 0.72, x: -0.6, z: -0.48, clad: K.steelClad, roof: "monitor", pil: true, band: 0.46 }),
        ...docks(-0.6, 0.02, 1, T),
        ...conveyor([0.18, 1.2, -0.4], [0.25, 0.85, 0.02]),
        ...legs(0.25, 0.1, 0.3, 0.3, 0.3),
        ...silo(0.25, 0.1, 0.16, 0.55, K.grainBin, false).map((p) => (xf(p.geo, 0, 0.3, 0), p)),
        heap(-0.75, 0.48, 0.24, 0.2, C.ore, 0.9),
        ...sign(-0.6, 0.62, 0.02, 0.4, 0.09, T),
        ...hvac(-0.8, 0.72, -0.8),
      ],
      pad: gravel,
      frame: [-0.25, -0.45, 1.3, 1.0, 1.5],
      rotor: [0.18, 1.9, -0.62, 0],
      slots: [truckS(0.25, 0.52), atDock(-0.6, 0.02), ...sidePark(4), treeS(0.66, 0.4), stuffS(-0.95, 0.66, Math.PI / 2)],
      stuff: BULK,
    },
  ],
  coal_mine: [
    {
      // drift portal shed, inclined conveyor to a tipple on stilts, coal heaps
      build: (T) => [
        ...hall({ w: 0.72, d: 0.6, h: 0.5, x: -0.62, z: -0.65, clad: K.slate, roof: "gable", band: 0.3 }),
        ...docks(-0.62, -0.35, 1, T),
        ...conveyor([-0.3, 0.42, -0.6], [0.18, 1.05, -0.38]),
        ...bin(0.28, -0.38, 0.4, 0.38, 0.42, 0.5, K.rustClad),
        ...roofOf("gable", 0.4, 0.38, 0.92, 0.28, -0.38, K.rustClad),
        heap(-0.62, 0.3, 0.3, 0.26, C.coal, 0.2),
        heap(-0.2, 0.5, 0.2, 0.18, C.coal, 1.4),
        heap(-0.95, -0.1, 0.13, 0.12, C.coal, 0.7),
        ...hall({ w: 0.32, d: 0.26, h: 0.3, x: -0.15, z: -0.88, clad: K.brick, roof: "gableZ", band: false }),
        ...sign(-0.62, 0.62, -0.35, 0.36, 0.08, T),
      ],
      pad: gravel,
      frame: [-0.3, -0.5, 1.25, 0.9, 1.0],
      slots: [truckS(0.28, 0.3), ...sidePark(4), stuffS(-0.9, 0.66, Math.PI / 2), treeS(0.66, 0.4)],
      stuff: BULK,
    },
    {
      // coal preparation plant with monitor roof, twin bunkers and gallery, stockpiles out front
      build: (T) => [
        ...hall({ w: 1.05, d: 0.8, h: 0.82, x: -0.42, z: -0.55, clad: K.slate, roof: "monitor", pil: true, band: 0.5 }),
        ...silo(0.32, -0.82, 0.15, 1.05, K.silo, false),
        ...silo(0.32, -0.46, 0.15, 1.05, K.silo, false),
        ...conveyor([-0.2, 0.98, -0.55], [0.32, 1.12, -0.64]),
        heap(-0.6, 0.38, 0.32, 0.28, C.coal, 0.3),
        heap(-0.1, 0.42, 0.2, 0.18, C.coal, 2.1),
        ...docks(-0.75, -0.15, 1, T),
        ...sign(-0.2, 0.7, -0.15, 0.4, 0.1, T),
        ...hvac(-0.75, 0.82, -0.85),
      ],
      pad: gravel,
      frame: [-0.3, -0.55, 1.35, 0.85, 1.0],
      slots: [atDock(-0.75, -0.15), truckS(0.32, 0.0), ...sidePark(3, -0.2), treeS(0.66, -0.75)],
      stuff: BULK,
    },
  ],
  oil_well: [
    {
      // pumpjack on its skid, tank battery with catwalk, separator and a small control shed
      build: (T) => [
        ...pumpjackFrame(-0.3, -0.15, T),
        ...tankV(0.22, -0.8, 0.17, 0.52, C.tank, T),
        ...tankV(0.22, -0.4, 0.17, 0.52, C.tank),
        fix(boxUp(0.06, 0.02, 0.4, 0.22, 0.53, -0.6), K.frame),
        fix(xf(new THREE.CylinderGeometry(0.08, 0.08, 0.38, 10), -0.72, 0.16, -0.78, 0, 0, Math.PI / 2), K.white),
        fix(boxUp(0.05, 0.08, 0.14, -0.84, 0, -0.78), K.frame),
        fix(boxUp(0.05, 0.08, 0.14, -0.6, 0, -0.78), K.frame),
        ...pipeRun([-0.3, 0.12, 0.27], [-0.3, 0.12, 0.45]),
        ...pipeRun([-0.55, 0.15, -0.78], [0.05, 0.15, -0.6]),
        ...hall({ w: 0.36, d: 0.26, h: 0.3, x: -0.75, z: 0.3, clad: K.panel, band: 0.18 }),
        ...sign(-0.75, 0.22, 0.43, 0.2, 0.06, T),
      ],
      pad: gravel,
      frame: [-0.25, -0.35, 1.1, 1.1, 0.9],
      rotor: [-0.3, 0.6, -0.15, 0],
      slots: [carS(0.66, -0.2), carS(0.66, 0.02), stuffS(-0.2, 0.62), treeS(0.66, 0.42), treeS(-0.95, -0.98)],
      stuff: ["drums", "drums", "container"],
    },
    {
      // workover derrick beside the well, pipe rack, mud pit and site cabin
      build: (T) => [
        ...lattice(-0.62, -0.62, 0.48, 0.16, 2.0),
        fix(boxUp(0.62, 0.05, 0.62, -0.62, 0.24, -0.62), K.frame),
        ...legs(-0.62, -0.62, 0.62, 0.62, 0.24),
        fix(boxUp(0.24, 0.16, 0.2, -0.62, 0.29, -0.62), T),
        ...pumpjackFrame(-0.15, 0.15, T),
        ...[0, 1, 2, 3, 4].map((i) => fix(xf(new THREE.CylinderGeometry(0.025, 0.025, 0.8, 6), 0.1, 0.05 + (i % 2) * 0.04, -0.92 + i * 0.05, 0, 0, Math.PI / 2), C.rust)),
        fix(boxUp(0.5, 0.012, 0.32, 0.12, 0, -0.45), "#2c2630"),
        fix(boxUp(0.56, 0.03, 0.38, 0.12, 0, -0.45), K.earth),
        ...hall({ w: 0.48, d: 0.22, h: 0.26, x: 0.2, z: 0.32, clad: K.white, band: 0.15 }),
        ...sign(0.2, 0.2, 0.43, 0.22, 0.05, T),
      ],
      pad: gravel,
      frame: [-0.3, -0.45, 1.2, 1.0, 1.6],
      rotor: [-0.15, 0.6, 0.15, 0],
      slots: [carS(0.66, -0.86), carS(0.66, -0.64), stuffS(-0.88, 0.5, Math.PI / 2), stuffS(0.62, -0.2, Math.PI / 2), treeS(0.66, 0.6)],
      stuff: ["drums", "container", "crates"],
    },
    {
      // two pumpjacks (one idle), three-tank battery and a small flare
      build: (T) => [
        ...pumpjackFrame(0.05, -0.4, T),
        ...pumpjackFrame(-0.62, -0.5, T),
        fix(xf(box(0.07, 0.07, 0.9, 0, 0, 0), -0.62, 0.62, -0.5, 0.18, 0, 0), C.steel),
        fix(xf(box(0.1, 0.22, 0.08, 0, -0.06, 0.45), -0.62, 0.62, -0.5, 0.18, 0, 0), C.rust),
        ...tankV(-0.75, 0.35, 0.15, 0.45),
        ...tankV(-0.4, 0.35, 0.15, 0.45, C.tank, T),
        ...tankV(-0.05, 0.35, 0.15, 0.45),
        ...pipeRun([-0.75, 0.5, 0.15], [0.05, 0.5, 0.15], 0.02),
        fix(cyl(0.03, 0.035, 1.1, 0.35, 0, -0.9, 6), K.steelClad),
        glass(cyl(0.05, 0.04, 0.06, 0.35, 1.1, -0.9, 6), K.flame),
      ],
      pad: gravel,
      frame: [-0.3, -0.3, 1.2, 1.2, 0.8],
      rotor: [0.05, 0.6, -0.4, 0],
      slots: [carS(0.66, -0.4), carS(0.66, -0.18), stuffS(0.32, 0.62), treeS(-0.95, -0.98), treeS(0.66, 0.5)],
      stuff: ["drums", "drums", "crates"],
    },
  ],
  farm: [
    {
      // red barn, domed silo, farmhouse, crop rows out front
      build: (T) => [
        ...hall({ w: 0.78, d: 0.55, h: 0.48, x: -0.6, z: -0.72, clad: T, roof: "gable", band: false, plinth: false }),
        fix(box(0.24, 0.3, 0.014, -0.6, 0.15, -0.44), "#6d3424"),
        fix(xf(box(0.36, 0.025, 0.012, -0.6, 0.15, -0.432), 0, 0, 0, 0, 0, 0.9), K.white),
        fix(xf(box(0.36, 0.025, 0.012, -0.6, 0.15, -0.432), 0, 0, 0, 0, 0, -0.9), K.white),
        ...silo(-0.05, -0.8, 0.15, 0.95, K.silo),
        ...hall({ w: 0.36, d: 0.32, h: 0.34, x: 0.32, z: -0.78, clad: K.cream, roof: "gableZ", band: 0.2, plinth: false }),
        ...chimney(0.4, -0.7, 0.03, 0.2, K.brickDark, 0.48),
        ...rows(-1.0, -0.25, 0.45, 0.78, [C.crop, K.field, C.crop, "#a08640"]),
        ...tractor(0.2, -0.38, 0.3, T),
        ...bales(-0.3, -0.32, 3),
      ],
      pad: [{ kind: "gravel", rect: [LOT.min, LOT.min, LOT.max, -0.3] }],
      frame: [-0.3, -0.7, 1.3, 0.6, 0.9],
      slots: [carS(0.66, -0.2), treeS(0.66, 0.15), treeS(0.68, 0.45), treeS(-0.98, -0.35)],
      stuff: ["crates"],
    },
    {
      // market garden: three glasshouses, packing shed, water tank
      build: (T) => [
        ...[-0.82, -0.4, 0.02].flatMap((x) => [
          ...hall({ w: 0.36, d: 1.0, h: 0.26, x, z: -0.48, clad: K.glassHouse, roof: "gableZ", roofColor: K.glassRoof, band: false, plinth: false }),
          fix(boxUp(0.37, 0.04, 1.01, x, 0, -0.48), K.white),
        ]),
        ...hall({ w: 0.55, d: 0.34, h: 0.36, x: -0.6, z: 0.32, clad: K.timber, roof: "gable", band: false }),
        ...docks(-0.6, 0.49, 1, T),
        ...tankV(0.35, -0.85, 0.12, 0.38, K.grainBin),
        ...rows(0.25, -0.62, 0.45, 0.1, [K.field, "#5f8a3a"]),
        ...sign(-0.6, 0.4, 0.49, 0.3, 0.07, T).map((p) => (xf(p.geo, 0, 0.12, 0), p)),
      ],
      pad: [{ kind: "gravel", rect: [LOT.min, 0.06, LOT.max, LOT.max] }],
      frame: [-0.4, -0.45, 1.3, 1.05, 0.4],
      slots: [carS(0.0, 0.66, Math.PI / 2), carS(0.22, 0.66, Math.PI / 2), treeS(0.66, -0.2), treeS(0.66, 0.15), stuffS(-0.15, 0.3)],
      stuff: ["crates", "pallets"],
    },
    {
      // grain farm: barrel-roof machine shed, three corrugated bins and an auger, wheat strips
      build: (T) => [
        ...hall({ w: 0.72, d: 0.5, h: 0.42, x: -0.62, z: -0.75, clad: K.steelClad, roof: "barrel", band: false }),
        fix(box(0.3, 0.3, 0.014, -0.62, 0.15, -0.495), "#4a4e55"),
        ...[[-0.02, -0.82], [0.3, -0.82], [0.14, -0.5]].flatMap(([x, z]) => [
          fix(cyl(0.15, 0.15, 0.32, x, 0, z, 12), K.grainBin),
          fix(cone(0.16, 0.14, x, 0.32, z, 12), shade(K.grainBin, 0.88)),
        ]),
        fix(beam([0.14, 0.05, -0.2], [0.14, 0.62, -0.5], 0.03), K.frame),
        ...rows(-1.0, -0.3, 0.45, 0.78, [C.crop, "#d9b862", C.crop, K.field]),
        ...tractor(-0.25, -0.38, 2.6, T),
        ...bales(-0.95, -0.36, 2),
      ],
      pad: [{ kind: "gravel", rect: [LOT.min, LOT.min, LOT.max, -0.32] }],
      frame: [-0.3, -0.7, 1.3, 0.6, 0.7],
      slots: [carS(0.66, -0.2), treeS(0.66, 0.2), treeS(0.68, 0.5), treeS(-0.98, -0.98)],
      stuff: ["crates"],
    },
  ],
  forestry: [
    {
      // timber shed, log decks, a log loader
      build: (T) => [
        ...hall({ w: 0.72, d: 0.52, h: 0.48, x: -0.66, z: -0.75, clad: K.timber, roof: "gable", band: 0.3 }),
        ...docks(-0.66, -0.49, 1, T),
        ...logPile(-0.05, -0.75, 0, 0.65),
        ...logPile(0.25, -0.35, Math.PI / 2, 0.6),
        ...logPile(-0.25, -0.2, 0, 0.6),
        fix(boxUp(0.2, 0.14, 0.16, -0.65, 0, 0.1), "#d29a2a"),
        fix(boxUp(0.12, 0.1, 0.14, -0.7, 0.14, 0.1), "#33373d"),
        fix(beam([-0.6, 0.22, 0.1], [-0.2, 0.62, 0.1], 0.04), "#d29a2a"),
        fix(beam([-0.2, 0.62, 0.1], [-0.12, 0.35, 0.1], 0.03), "#d29a2a"),
        ...sign(-0.66, 0.6, -0.49, 0.3, 0.07, T),
      ],
      pad: gravel,
      frame: [-0.35, -0.55, 1.2, 0.9, 0.8],
      slots: [truckS(0.15, 0.55), ...sidePark(3, -0.86), treeS(-0.95, 0.65), treeS(-0.95, 0.3), treeS(0.66, 0.5)],
      stuff: TIMBER,
    },
    {
      // open pole barn full of logs, chip pile fed by a conveyor, site cabin
      build: (T) => [
        ...[-0.92, -0.45, 0.02].flatMap((x) => [fix(boxUp(0.05, 0.55, 0.05, x, 0, -0.92), C.wood), fix(boxUp(0.05, 0.55, 0.05, x, 0, -0.38), C.wood)]),
        ...roofOf("gable", 1.0, 0.6, 0.55, -0.45, -0.65, C.wood),
        ...logPile(-0.68, -0.65, 0, 0.42),
        ...logPile(-0.22, -0.65, 0, 0.42),
        heap(0.3, -0.62, 0.26, 0.3, "#caa46a", 0.5),
        ...conveyor([0.05, 0.12, -0.25], [0.28, 0.42, -0.58], K.frame),
        ...hall({ w: 0.46, d: 0.22, h: 0.26, x: -0.55, z: 0.22, clad: K.panel, band: 0.15 }),
        ...sign(-0.55, 0.2, 0.33, 0.22, 0.05, T),
      ],
      pad: gravel,
      frame: [-0.35, -0.55, 1.2, 0.9, 0.7],
      slots: [truckS(0.1, 0.5), carS(0.66, -0.2), carS(0.66, 0.02), treeS(-0.95, 0.66), treeS(0.66, 0.45), stuffS(-0.85, 0.6, Math.PI / 2)],
      stuff: TIMBER,
    },
  ],
  waterworks: [
    {
      // two round clarifiers with bridges, brick pump house and a wheel in the outfall channel
      build: (T) => [
        ...[[-0.55, -0.55, 0.4], [0.15, -0.68, 0.3]].flatMap(([x, z, r]) => [
          fix(cyl(r, r, 0.2, x, 0, z, 18), C.concrete),
          fix(cyl(r - 0.04, r - 0.04, 0.012, x, 0.19, z, 18), C.water),
          fix(box(r * 2, 0.03, 0.06, x, 0.24, z), K.frame),
          fix(cyl(0.05, 0.05, 0.08, x, 0.2, z, 8), K.frame),
        ]),
        ...hall({ w: 0.5, d: 0.36, h: 0.42, x: -0.6, z: 0.25, clad: K.brick, roof: "gable", band: 0.25 }),
        ...entry(-0.6, 0.43),
        fix(boxUp(0.7, 0.04, 0.24, 0.12, 0, -0.02), C.concrete),
        fix(boxUp(0.62, 0.01, 0.18, 0.12, 0.03, -0.02), C.water),
        ...pipeRun([-0.6, 0.12, 0.05], [-0.6, 0.12, -0.2], 0.04, T),
        ...pipeRun([-0.15, 0.1, -0.55], [0.15, 0.1, -0.4], 0.035, T),
        ...sign(-0.6, 0.35, 0.43, 0.26, 0.06, T),
      ],
      pad: concrete,
      frame: [-0.25, -0.4, 1.3, 1.1, 0.5],
      rotor: [0.2, 0.2, -0.02, 0],
      slots: [...sidePark(3, -0.2), treeS(0.66, -0.86), treeS(0.62, 0.55), treeS(-0.95, 0.66), stuffS(-0.05, 0.55)],
      stuff: ["drums", "crates"],
    },
    {
      // water tower, filter beds, pump hall with an aerator wheel
      build: (T) => [
        ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([ox, oz]) => fix(beam([0.25 + ox * 0.18, 0, -0.62 + oz * 0.18], [0.25 + ox * 0.12, 1.05, -0.62 + oz * 0.12], 0.04), K.frame)),
        fix(cyl(0.25, 0.25, 0.3, 0.25, 1.05, -0.62, 14), K.steelClad),
        fix(cyl(0.255, 0.255, 0.07, 0.25, 1.2, -0.62, 14), T),
        fix(cone(0.27, 0.14, 0.25, 1.35, -0.62, 14), shade(K.steelClad, 0.85)),
        ...[[-0.78, -0.75], [-0.4, -0.75], [-0.78, -0.35], [-0.4, -0.35]].flatMap(([x, z]) => [
          fix(boxUp(0.34, 0.12, 0.34, x, 0, z), C.concrete),
          fix(boxUp(0.28, 0.01, 0.28, x, 0.11, z), C.water),
        ]),
        ...hall({ w: 0.62, d: 0.4, h: 0.48, x: -0.45, z: 0.18, clad: K.cream, roof: "flat", band: 0.3, pil: true }),
        ...hvac(-0.6, 0.48, 0.18),
        fix(boxUp(0.5, 0.06, 0.24, 0.15, 0, 0.05), C.concrete),
        fix(boxUp(0.44, 0.01, 0.18, 0.15, 0.05, 0.05), C.water),
        ...sign(-0.45, 0.38, 0.38, 0.32, 0.07, T),
      ],
      pad: concrete,
      frame: [-0.3, -0.4, 1.3, 1.1, 0.6],
      rotor: [0.15, 0.2, 0.05, 0],
      slots: [...sidePark(2, -0.1), carS(0.0, 0.66, Math.PI / 2), treeS(0.66, -0.86), treeS(-0.95, 0.66), treeS(0.62, 0.6)],
      stuff: ["drums"],
    },
  ],
  smelter: [
    {
      // furnace hall with monitor roof, two brick stacks, ore bunker and conveyor, slag heap
      build: (T) => [
        ...hall({ w: 1.2, d: 0.85, h: 1.05, x: -0.38, z: -0.55, clad: K.rustClad, roof: "monitor", pil: true, band: 0.7 }),
        glass(box(0.3, 0.24, 0.02, -0.72, 0.2, -0.12), K.flame),
        ...docks(-0.2, -0.125, 1),
        ...chimney(0.25, -0.86, 0.09, 1.9),
        ...chimney(0.38, -0.55, 0.07, 1.55),
        ...bin(0.3, -0.12, 0.3, 0.3, 0.3, 0.38, K.slate),
        ...conveyor([0.2, 0.72, -0.12], [-0.05, 1.08, -0.35]),
        heap(-0.82, 0.45, 0.22, 0.12, "#77716a", 0.6),
        ...sign(0.05, 0.85, -0.115, 0.36, 0.1, T),
      ],
      pad: concrete,
      frame: [-0.3, -0.55, 1.3, 0.9, 1.15],
      smoke: [[0.25, 1.9, -0.86], [0.38, 1.55, -0.55]],
      slots: [atDock(-0.2, -0.125), ...sidePark(4, -0.86), stuffS(-0.55, 0.62), treeS(0.66, 0.45)],
      stuff: BULK,
    },
    {
      // blast furnace with bustle pipe, three hot stoves, cast house, one stack
      build: (T) => [
        fix(cyl(0.3, 0.32, 0.3, -0.45, 0, -0.4, 14), C.concrete),
        fix(cyl(0.18, 0.27, 1.25, -0.45, 0.3, -0.4, 12), "#5a5d63"),
        fix(cone(0.19, 0.18, -0.45, 1.55, -0.4, 12), "#4a4d52"),
        fix(xf(new THREE.TorusGeometry(0.33, 0.035, 6, 16), -0.45, 0.55, -0.4, Math.PI / 2, 0, 0), C.rust),
        ...[0, 1, 2, 3].map((i) => fix(beam([-0.45 + Math.cos(i * 1.57 + 0.78) * 0.14, 1.6, -0.4 + Math.sin(i * 1.57 + 0.78) * 0.14], [-0.45, 1.95, -0.4], 0.028), C.rust)),
        fix(beam([-0.45, 1.9, -0.4], [0.05, 0.75, -0.85], 0.04), C.rust),
        fix(cyl(0.12, 0.12, 0.5, 0.05, 0.25, -0.85, 10), K.steelClad),
        fix(xf(new THREE.ConeGeometry(0.12, 0.25, 10), 0.05, 0.12, -0.85, Math.PI, 0, 0), K.steelClad),
        ...[-0.92, -0.62].flatMap((x) => [fix(cyl(0.13, 0.13, 1.05, x, 0, -0.9, 10), "#8d9196"), fix(xf(new THREE.SphereGeometry(0.13, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2), x, 1.05, -0.9), "#8d9196")]),
        ...hall({ w: 0.8, d: 0.34, h: 0.5, x: -0.45, z: 0.06, clad: K.rustClad, roof: "gable", band: false }),
        glass(box(0.26, 0.2, 0.02, -0.45, 0.16, 0.235), K.flame),
        ...chimney(0.32, -0.45, 0.085, 1.95),
        ...sign(-0.45, 0.4, 0.235, 0.36, 0.08, T),
      ],
      pad: concrete,
      frame: [-0.35, -0.4, 1.3, 1.2, 1.2],
      smoke: [[0.32, 1.95, -0.45]],
      slots: [truckS(-0.45, 0.6), ...sidePark(4, -0.86), stuffS(0.2, 0.62), treeS(0.66, 0.45)],
      stuff: BULK,
    },
    {
      // electric arc shop: sawtooth hall, baghouse, short steel stack, small cooling tower
      build: (T) => [
        ...hall({ w: 1.25, d: 0.9, h: 0.92, x: -0.35, z: -0.52, clad: K.slate, roof: "saw", pil: true, band: 0.55 }),
        ...docks(-0.55, -0.07, 2),
        ...chimney(0.38, -0.88, 0.075, 1.45, K.steelClad),
        ...bin(0.36, -0.45, 0.26, 0.26, 0.32, 0.36, K.steelClad),
        ...pipeRun([0.36, 0.86, -0.45], [0.38, 0.86, -0.82], 0.035),
        ...coolingTower(-0.75, 0.48, 0.24, 0.7),
        ...sign(0.0, 0.75, -0.07, 0.4, 0.1, T),
      ],
      pad: concrete,
      frame: [-0.3, -0.5, 1.35, 0.95, 1.1],
      smoke: [[0.38, 1.45, -0.88]],
      slots: [atDock(-0.69, -0.07), atDock(-0.4, -0.07), ...sidePark(4, -0.2).slice(1), stuffS(0.15, 0.62), treeS(0.66, -0.2)],
      stuff: BULK,
    },
  ],
  refinery: [
    {
      // three distillation columns, fired heater, pipe rack, spheres, flare
      build: (T) => [
        ...column(-0.82, -0.82, 0.11, 2.0),
        ...column(-0.52, -0.85, 0.085, 1.55),
        ...column(-0.22, -0.82, 0.12, 1.75),
        ...hall({ w: 0.55, d: 0.32, h: 0.45, x: -0.55, z: -0.3, clad: K.slate, band: false, plinth: false }),
        ...chimney(-0.35, -0.3, 0.06, 0.65, K.steelClad, 0.45),
        ...pipeRun([0.1, 0.55, -0.95], [0.1, 0.55, 0.15], 0.03, C.pipe),
        ...pipeRun([0.06, 0.48, -0.95], [0.06, 0.48, 0.15], 0.025, T),
        fix(box(0.03, 0.02, 1.05, 0.08, 0.6, -0.4), K.frame),
        ...sphereTank(0.32, -0.72, 0.16),
        ...sphereTank(0.32, -0.3, 0.14),
        ...office({ w: 0.42, d: 0.26, floors: 1, x: -0.55, z: 0.3, clad: K.panel }),
        fix(cyl(0.025, 0.03, 1.6, -0.95, 0, 0.6, 6), K.steelClad),
        glass(cyl(0.045, 0.035, 0.05, -0.95, 1.6, 0.6, 6), K.flame),
        ...sign(-0.55, 0.2, 0.43, 0.3, 0.06, T),
      ],
      pad: concrete,
      frame: [-0.35, -0.45, 1.3, 1.1, 1.3],
      smoke: [[-0.35, 1.1, -0.3]],
      slots: [...sidePark(4, -0.2), stuffS(0.1, 0.62), treeS(0.66, -0.86), treeS(0.66, -0.6)],
      stuff: ["drums", "drums", "container"],
    },
    {
      // tank farm inside a bund wall, one column, pump house
      build: (T) => [
        fix(boxUp(1.4, 0.08, 0.04, -0.3, 0, -1.0), C.concrete),
        fix(boxUp(1.4, 0.08, 0.04, -0.3, 0, 0.12), C.concrete),
        fix(boxUp(0.04, 0.08, 1.12, -1.0, 0, -0.44), C.concrete),
        fix(boxUp(0.04, 0.08, 1.12, 0.4, 0, -0.44), C.concrete),
        ...tankV(-0.7, -0.7, 0.25, 0.42, C.tank, T),
        ...tankV(-0.08, -0.7, 0.25, 0.42),
        ...tankV(-0.7, -0.17, 0.22, 0.36),
        ...tankV(-0.12, -0.17, 0.2, 0.5, C.tank, T),
        ...column(0.25, -0.8, 0.1, 1.6),
        ...hall({ w: 0.36, d: 0.26, h: 0.3, x: 0.2, z: -0.3, clad: K.cream, band: 0.18 }),
        ...pipeRun([-0.45, 0.48, -0.44], [0.12, 0.48, -0.44], 0.025),
        ...chimney(0.3, 0.45, 0.05, 1.0, K.steelClad),
        ...sign(0.2, 0.22, -0.17, 0.24, 0.06, T),
      ],
      pad: concrete,
      frame: [-0.3, -0.45, 1.4, 1.1, 0.9],
      smoke: [[0.3, 1.0, 0.45]],
      slots: [truckS(-0.4, 0.5), truckS(-0.05, 0.5), ...sidePark(3, -0.86), treeS(0.66, -0.15), treeS(-0.95, 0.6)],
      stuff: ["drums"],
    },
    {
      // cracking unit: reactor, two columns, furnace with stack, control building
      build: (T) => [
        fix(cyl(0.2, 0.2, 1.25, -0.6, 0, -0.68, 12), K.white),
        fix(xf(new THREE.SphereGeometry(0.2, 12, 5, 0, Math.PI * 2, 0, Math.PI / 2), -0.6, 1.25, -0.68), K.white),
        fix(cyl(0.21, 0.21, 0.06, -0.6, 0.85, -0.68, 12), T),
        ...column(-0.12, -0.85, 0.1, 1.85),
        ...column(0.18, -0.82, 0.08, 1.4),
        ...hall({ w: 0.62, d: 0.3, h: 0.42, x: -0.52, z: -0.18, clad: K.rustClad, band: false }),
        ...chimney(-0.25, -0.18, 0.07, 1.5),
        ...pipeRun([-0.95, 0.5, -0.42], [0.32, 0.5, -0.42], 0.03),
        ...pipeRun([-0.95, 0.42, -0.45], [0.32, 0.42, -0.45], 0.025, T),
        ...office({ w: 0.42, d: 0.32, floors: 2, x: 0.18, z: 0.2, clad: K.panel }),
        ...roofSign(0.18, 0.6, 0.25, 0.32, T),
      ],
      pad: concrete,
      frame: [-0.35, -0.5, 1.3, 1.0, 1.2],
      smoke: [[-0.25, 1.5, -0.18]],
      slots: [...sidePark(3, -0.86), stuffS(-0.7, 0.55), stuffS(-0.35, 0.6), treeS(0.66, -0.15), treeS(-0.95, 0.25)],
      stuff: ["drums", "container"],
    },
  ],
  sawmill: [
    {
      // long timber mill hall, open saw shed with the blade, log deck, cyclone on the roof
      build: (T) => [
        ...hall({ w: 1.35, d: 0.58, h: 0.6, x: -0.35, z: -0.73, clad: K.timber, roof: "gable", band: 0.38, pil: true }),
        ...[-0.6, -0.05].flatMap((x) => [fix(boxUp(0.05, 0.5, 0.05, x, 0, -0.38), C.wood), fix(boxUp(0.05, 0.5, 0.05, x, 0, 0.12), C.wood)]),
        roofP(xf(new THREE.BoxGeometry(0.66, 0.03, 0.6), -0.32, 0.53, -0.13, 0.12, 0, 0)),
        fix(boxUp(0.16, 0.2, 0.5, -0.32, 0, -0.13), K.frame),
        ...logPile(0.25, -0.05, Math.PI / 2, 0.55),
        ...logPile(-0.85, 0.15, Math.PI / 2, 0.5),
        ...cyclone(0.12, -0.85, 0.62),
        ...sign(-0.75, 0.48, -0.44, 0.34, 0.08, T),
      ],
      pad: gravel,
      frame: [-0.35, -0.55, 1.35, 0.9, 0.8],
      rotor: [-0.32, 0.27, -0.13, 0],
      slots: [truckS(0.2, 0.55), ...sidePark(4, -0.86), stuffS(-0.55, 0.6), stuffS(-0.2, 0.62), treeS(0.66, 0.42)],
      stuff: TIMBER,
    },
    {
      // brick mill with drying kilns in a row and a covered saw table out front
      build: (T) => [
        ...hall({ w: 0.85, d: 0.78, h: 0.62, x: -0.58, z: -0.58, clad: K.brick, roof: "gableZ", band: 0.38, pil: true }),
        ...[-0.86, -0.56, -0.26].flatMap((z) => [
          wallP(boxUp(0.4, 0.4, 0.26, 0.2, 0, z), K.panel),
          fix(boxUp(0.42, 0.03, 0.28, 0.2, 0.4, z), K.frame),
          fix(cyl(0.035, 0.035, 0.1, 0.32, 0.4, z, 6), K.frame),
          fix(box(0.012, 0.3, 0.2, 0.405, 0.16, z), K.rollup),
        ]),
        ...[-0.75, -0.2].flatMap((x) => [fix(boxUp(0.04, 0.45, 0.04, x, 0, 0.05), C.wood), fix(boxUp(0.04, 0.45, 0.04, x, 0, 0.45), C.wood)]),
        roofP(boxUp(0.65, 0.03, 0.5, -0.47, 0.45, 0.25)),
        fix(boxUp(0.5, 0.2, 0.16, -0.47, 0, 0.25), K.frame),
        ...logPile(-0.5, 0.66, 0, 0.55),
        ...sign(-0.58, 0.48, -0.19, 0.36, 0.08, T),
      ],
      pad: gravel,
      frame: [-0.35, -0.55, 1.3, 0.95, 0.75],
      rotor: [-0.47, 0.27, 0.25, Math.PI / 2],
      slots: [...sidePark(5, -0.86), stuffS(0.15, 0.25), stuffS(0.15, 0.6), treeS(-0.95, 0.66)],
      stuff: TIMBER,
    },
  ],
  mill: [
    {
      // five-storey mill tower, silo row with elevator leg, low warehouse with docks
      build: (T) => [
        ...office({ w: 0.5, d: 0.5, floors: 5, x: -0.68, z: -0.7, clad: K.cream, roof: "gableZ" }),
        ...silo(-0.18, -0.82, 0.16, 1.35, K.silo),
        ...silo(0.17, -0.82, 0.16, 1.35, K.silo),
        ...silo(0.17, -0.47, 0.16, 1.2, K.silo),
        fix(boxUp(0.12, 1.75, 0.12, -0.2, 0, -0.5), K.steelClad),
        fix(boxUp(0.18, 0.12, 0.16, -0.2, 1.75, -0.5), K.steelClad),
        fix(beam([-0.2, 1.72, -0.5], [0.17, 1.42, -0.75], 0.07), K.steelClad),
        fix(beam([-0.2, 1.65, -0.5], [-0.43, 1.25, -0.65], 0.05), K.steelClad),
        ...hall({ w: 0.95, d: 0.4, h: 0.5, x: -0.5, z: -0.08, clad: K.sand, roof: "gable", band: false }),
        ...docks(-0.6, 0.12, 2, T),
        ...sign(-0.68, 1.2, -0.445, 0.36, 0.1, T),
      ],
      pad: concrete,
      frame: [-0.3, -0.45, 1.3, 1.05, 1.4],
      slots: [atDock(-0.745, 0.12), atDock(-0.455, 0.12), ...sidePark(4, -0.2).slice(1), treeS(0.66, -0.75), treeS(0.12, 0.62)],
      stuff: ["pallets", "pallets", "crates"],
    },
    {
      // 2×2 concrete silo battery under a head house, elevator leg, flour hall with docks
      build: (T) => [
        ...[[-0.78, -0.78], [-0.46, -0.78], [-0.78, -0.46], [-0.46, -0.46]].flatMap(([x, z]) => silo(x, z, 0.16, 1.4, "#cbc5b6", false)),
        ...hall({ w: 0.66, d: 0.66, h: 0.22, x: -0.62, z: -0.62, clad: K.cream, roof: "gable", band: 0.12, plinth: false }).map((p) => (xf(p.geo, 0, 1.42, 0), p)),
        fix(boxUp(0.12, 1.85, 0.12, -0.2, 0, -0.25), K.steelClad),
        fix(beam([-0.2, 1.8, -0.25], [-0.45, 1.55, -0.45], 0.06), K.steelClad),
        ...hall({ w: 0.68, d: 0.8, h: 0.7, x: 0.1, z: -0.55, clad: K.panel, roof: "flat", band: 0.45, pil: true }),
        ...docks(0.1, -0.15, 2, T),
        ...hvac(0.2, 0.7, -0.75),
        ...sign(0.1, 0.62, -0.15, 0.4, 0.08, T),
      ],
      pad: concrete,
      frame: [-0.35, -0.5, 1.3, 0.95, 1.45],
      slots: [atDock(-0.045, -0.15), atDock(0.245, -0.15), ...sidePark(3, -0.86), stuffS(-0.7, 0.4, Math.PI / 2), treeS(-0.95, 0.66), treeS(0.66, -0.15)],
      stuff: ["pallets", "crates"],
    },
  ],
  machine_factory: [
    {
      // sawtooth assembly shop, plant annex with roof fan, two-storey office on the corner
      build: (T) => [
        ...hall({ w: 1.05, d: 1.0, h: 0.92, x: -0.43, z: -0.45, clad: K.blue, roof: "saw", pil: true, band: 0.55 }),
        ...hall({ w: 0.38, d: 0.6, h: 0.7, x: 0.28, z: -0.62, clad: K.steelClad, band: 0.45 }),
        fix(cyl(0.19, 0.19, 0.08, 0.28, 0.7, -0.62, 12), K.fan),
        ...hvac(0.28, 0.7, -0.83),
        ...docks(-0.6, 0.05, 2, T),
        ...office({ w: 0.52, d: 0.38, floors: 2, x: 0.18, z: 0.25, clad: K.panel, glassy: true }),
        ...roofSign(0.18, 0.6, 0.3, 0.42, T),
        ...hvac(0.1, 0.6, 0.15),
        ...sign(-0.28, 0.82, 0.05, 0.3, 0.08, T),
      ],
      pad: concrete,
      frame: [-0.25, -0.4, 1.4, 1.0, 1.0],
      rotor: [0.28, 0.82, -0.62, 0],
      slots: [atDock(-0.745, 0.05), atDock(-0.455, 0.05), ...sidePark(4, -0.86), treeS(0.66, 0.0), stuffS(-0.98, 0.5, Math.PI / 2), treeS(0.68, 0.55)],
      stuff: ["container", "pallets", "crates", "container"],
    },
    {
      // barrel-roof assembly hall with a glazed office lean-to and a roof fan
      build: (T) => [
        ...hall({ w: 1.42, d: 0.82, h: 0.85, x: -0.28, z: -0.58, clad: K.steelClad, roof: "barrel", pil: true, band: 0.55 }),
        ...docks(-0.68, -0.17, 2, T),
        ...office({ w: 0.62, d: 0.3, floors: 1, x: 0.1, z: -0.02, clad: K.white, glassy: true }),
        fix(cyl(0.17, 0.17, 0.06, 0.25, 0.33, -0.02, 12), K.fan),
        ...hvac(-0.05, 0.33, -0.02),
        ...sign(-0.2, 0.7, -0.165, 0.4, 0.1, T),
        fix(boxUp(0.05, 0.75, 0.05, -0.98, 0, 0.18), C.crane),
        fix(boxUp(0.05, 0.75, 0.05, -0.98, 0, 0.72), C.crane),
        fix(boxUp(0.06, 0.06, 0.62, -0.98, 0.72, 0.45), C.crane),
      ],
      pad: concrete,
      frame: [-0.25, -0.45, 1.45, 0.95, 1.0],
      rotor: [0.25, 0.42, -0.02, 0],
      slots: [atDock(-0.825, -0.17), atDock(-0.535, -0.17), ...sidePark(4, -0.86), stuffS(-0.25, 0.62), stuffS(0.15, 0.62), treeS(0.66, 0.45)],
      stuff: ["container", "pallets", "crates"],
    },
    {
      // twin gabled brick sheds, boiler-house chimney, flat annex with the fan
      build: (T) => [
        ...hall({ w: 0.6, d: 1.05, h: 0.8, x: -0.67, z: -0.42, clad: K.brick, roof: "gableZ", pil: true, band: 0.5 }),
        ...hall({ w: 0.6, d: 1.05, h: 0.8, x: -0.05, z: -0.42, clad: K.brick, roof: "gableZ", pil: true, band: 0.5 }),
        ...docks(-0.67, 0.105, 1, T),
        ...docks(-0.05, 0.105, 1, T),
        ...hall({ w: 0.2, d: 0.4, h: 0.58, x: 0.38, z: -0.62, clad: K.cream, band: false }),
        fix(cyl(0.12, 0.12, 0.06, 0.38, 0.58, -0.62, 10), K.fan),
        ...chimney(0.36, -0.9, 0.07, 1.35),
        ...sign(-0.67, 0.7, 0.105, 0.3, 0.09, T),
        ...hvac(-0.05, 0.92, -0.75, Math.PI / 2),
      ],
      pad: concrete,
      frame: [-0.3, -0.4, 1.35, 1.1, 1.0],
      rotor: [0.38, 0.68, -0.62, 0],
      slots: [atDock(-0.67, 0.105), atDock(-0.05, 0.105), ...sidePark(4, -0.86).slice(2), carS(0.66, -0.2), carS(0.66, 0.02), treeS(0.66, 0.42)],
      stuff: ["container", "pallets"],
    },
  ],
  toolworks: [
    {
      // brick sawtooth works with a three-storey office front and a roof fan
      build: (T) => [
        ...hall({ w: 1.2, d: 0.92, h: 0.78, x: -0.38, z: -0.53, clad: K.brick, roof: "saw", pil: true, band: 0.48 }),
        ...docks(-0.7, -0.07, 2, T),
        ...office({ w: 0.44, d: 0.38, floors: 3, x: 0.02, z: 0.15, clad: K.cream }),
        fix(cyl(0.14, 0.14, 0.06, 0.02, 0.87, 0.06, 10), K.fan),
        ...roofSign(0.02, 0.87, 0.28, 0.34, T),
        ...hvac(0.32, 0.0, -0.75),
      ],
      pad: concrete,
      frame: [-0.3, -0.45, 1.3, 1.05, 1.0],
      rotor: [0.02, 0.95, 0.06, 0],
      slots: [atDock(-0.845, -0.07), atDock(-0.555, -0.07), ...sidePark(5, -0.86), treeS(0.4, 0.62), stuffS(-0.98, 0.58, Math.PI / 2)],
      stuff: ["pallets", "crates", "container"],
    },
    {
      // modern panel hall, glazed corner office, three docks, rooftop plant and fan
      build: (T) => [
        ...hall({ w: 1.38, d: 0.98, h: 0.82, x: -0.28, z: -0.45, clad: K.panel, roof: "flat", band: 0.55 }),
        fix(boxUp(1.38, 0.05, 0.01, -0.28, 0.66, 0.045), T),
        ...docks(-0.5, 0.04, 3),
        ...office({ w: 0.36, d: 0.3, floors: 3, x: 0.27, z: 0.19, clad: K.slate, glassy: true }),
        fix(cyl(0.15, 0.15, 0.06, -0.7, 0.82, -0.7, 12), K.fan),
        ...hvac(-0.2, 0.82, -0.7),
        ...hvac(0.15, 0.82, -0.7),
        ...hvac(0.15, 0.82, -0.3),
        ...roofSign(-0.25, 0.82, -0.05, 0.5, T),
      ],
      pad: concrete,
      frame: [-0.25, -0.4, 1.4, 1.05, 1.0],
      rotor: [-0.7, 0.9, -0.7, 0],
      slots: [atDock(-0.79, 0.04), atDock(-0.5, 0.04), atDock(-0.21, 0.04), ...sidePark(4, -0.86), treeS(0.66, 0.0), treeS(0.68, 0.5)],
      stuff: ["pallets", "crates"],
    },
    {
      // sage-clad gabled hall with a flat lean-to carrying the fan
      build: (T) => [
        ...hall({ w: 1.25, d: 0.82, h: 0.75, x: -0.35, z: -0.56, clad: K.sage, roof: "gable", pil: true, band: 0.45 }),
        ...hall({ w: 0.58, d: 0.32, h: 0.46, x: -0.68, z: 0.01, clad: K.panel, band: 0.28 }),
        fix(cyl(0.13, 0.13, 0.05, -0.68, 0.46, 0.01, 10), K.fan),
        ...docks(0.02, -0.15, 1, T),
        ...sign(0.02, 0.6, -0.15, 0.34, 0.08, T),
        ...entry(-0.68, 0.17),
      ],
      pad: concrete,
      frame: [-0.3, -0.45, 1.3, 1.0, 1.0],
      rotor: [-0.68, 0.53, 0.01, 0],
      slots: [atDock(0.02, -0.15), ...sidePark(4, -0.86), carS(-0.6, 0.66, Math.PI / 2), carS(-0.38, 0.66, Math.PI / 2), treeS(-0.95, 0.66), treeS(0.66, 0.5)],
      stuff: ["pallets", "crates"],
    },
  ],
  bakery: [
    {
      // brick bakehouse with chimney, gabled shopfront with a striped awning, flour silo
      build: (T) => [
        ...hall({ w: 1.0, d: 0.7, h: 0.62, x: -0.5, z: -0.65, clad: K.brick, roof: "gable", band: 0.4 }),
        ...chimney(-0.85, -0.78, 0.06, 0.55, K.brickDark, 0.72),
        ...hall({ w: 0.62, d: 0.38, h: 0.5, x: -0.2, z: 0.0, clad: K.cream, roof: "gableZ", band: 0.32 }),
        glass(box(0.44, 0.16, 0.014, -0.2, 0.14, 0.195)),
        ...[0, 1, 2, 3, 4, 5].map((i) => fix(xf(box(0.09, 0.012, 0.16, -0.425 + i * 0.09, 0.27, 0.26), 0, 0, 0, 0.45, 0, 0), i % 2 ? K.white : T)),
        ...sign(-0.2, 0.42, 0.195, 0.4, 0.08, T),
        ...silo(0.25, -0.75, 0.13, 0.95, K.white),
        ...docks(0.18, -0.3, 1, T, Math.PI / 2),
      ],
      pad: concrete,
      frame: [-0.35, -0.45, 1.25, 1.0, 0.95],
      smoke: [[-0.85, 1.27, -0.78]],
      slots: [carS(0.66, -0.2), carS(0.66, 0.02), carS(0.66, 0.24), stuffS(-0.8, 0.45, Math.PI / 2), treeS(0.42, 0.6), treeS(-0.95, 0.66), treeS(0.66, -0.86)],
      stuff: ["crates", "pallets"],
    },
    {
      // white food plant: flat roof full of plant, flour silos, docks, vent stack
      build: (T) => [
        ...hall({ w: 1.3, d: 0.92, h: 0.72, x: -0.3, z: -0.53, clad: K.panel, roof: "flat", band: 0.48 }),
        fix(boxUp(1.3, 0.04, 0.01, -0.3, 0.6, -0.065), T),
        ...silo(-0.8, 0.22, 0.13, 1.05, K.white),
        ...silo(-0.5, 0.22, 0.13, 1.05, K.white),
        ...pipeRun([-0.65, 1.0, 0.22], [-0.65, 0.95, -0.2], 0.025),
        ...docks(0.05, -0.07, 2, T),
        ...hvac(-0.6, 0.72, -0.75),
        ...hvac(-0.2, 0.72, -0.75),
        ...hvac(0.15, 0.72, -0.45),
        fix(cyl(0.035, 0.035, 0.45, 0.05, 0.72, -0.85, 6), K.steelClad),
        ...sign(-0.3, 0.86, -0.065, 0.42, 0.1, T).map((p) => (xf(p.geo, 0.1, -0.14, 0), p)),
      ],
      pad: concrete,
      frame: [-0.3, -0.45, 1.35, 1.0, 0.9],
      smoke: [[0.05, 1.17, -0.85]],
      slots: [atDock(-0.095, -0.07), atDock(0.195, -0.07), ...sidePark(4, -0.86), treeS(0.66, 0.0), treeS(0.68, 0.55)],
      stuff: ["pallets", "crates"],
    },
  ],
  furniture_factory: [
    {
      // timber-clad warehouse with three docks, dust cyclone, lumber yard
      build: (T) => [
        ...hall({ w: 1.35, d: 0.92, h: 0.75, x: -0.32, z: -0.52, clad: K.timber, roof: "gable", pil: true, band: 0.5 }),
        ...docks(-0.4, -0.06, 3, T),
        ...cyclone(0.42, -0.82, 0.55),
        fix(beam([0.42, 0.98, -0.82], [0.2, 0.98, -0.75], 0.05), K.steelClad),
        ...sign(0.2, 0.62, -0.06, 0.3, 0.08, T),
      ],
      pad: concrete,
      frame: [-0.3, -0.5, 1.4, 0.95, 0.95],
      slots: [atDock(-0.69, -0.06), atDock(-0.4, -0.06), atDock(-0.11, -0.06), ...sidePark(3, -0.42), stuffS(0.5, 0.62), treeS(0.66, -0.86), treeS(-0.98, 0.66)],
      stuff: TIMBER,
    },
    {
      // old brick sawtooth works, two-storey office wing, tall boiler chimney
      build: (T) => [
        ...hall({ w: 1.12, d: 0.95, h: 0.8, x: -0.42, z: -0.5, clad: K.brick, roof: "saw", pil: true, band: 0.5 }),
        ...office({ w: 0.32, d: 0.62, floors: 2, x: 0.3, z: -0.62, clad: K.cream }),
        ...sign(0.3, 0.45, -0.31, 0.24, 0.07, T),
        ...chimney(0.28, -0.12, 0.07, 1.4),
        ...docks(-0.6, -0.025, 2, T),
        ...hvac(0.3, 0.6, -0.75),
      ],
      pad: concrete,
      frame: [-0.3, -0.5, 1.35, 1.0, 1.0],
      slots: [atDock(-0.745, -0.025), atDock(-0.455, -0.025), ...sidePark(4, -0.86).slice(2), carS(0.66, -0.2), carS(0.66, 0.02), stuffS(0.1, 0.62), treeS(0.66, 0.45)],
      stuff: TIMBER,
    },
  ],
};

/* ───────────────────────── variant geometry + pose ───────────────────────── */

function toColored(p: Part): THREE.BufferGeometry {
  const g = p.geo.index ? p.geo.toNonIndexed() : p.geo;
  g.deleteAttribute("uv");
  const n = g.getAttribute("position").count;
  const c = new THREE.Color(p.color);
  const colors = new Float32Array(n * 3);
  const mask = new Float32Array(n);
  const glow = new Float32Array(n);
  const m = p.accent ? 3 : p.roof ? 2 : p.tint ? 1 : 0;
  for (let i = 0; i < n; i++) { colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b; mask[i] = m; glow[i] = p.glow ? 1 : 0; }
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  g.setAttribute("tintMask", new THREE.BufferAttribute(mask, 1));
  g.setAttribute("glow", new THREE.BufferAttribute(glow, 1));
  if (g !== p.geo) p.geo.dispose();
  return g;
}

export function merge(list: Part[]): THREE.BufferGeometry {
  const colored = list.map(toColored);
  const merged = mergeGeometries(colored, false);
  for (const g of colored) g.dispose();
  merged.computeBoundingSphere();
  merged.computeBoundingBox();
  return merged;
}

export function variantCount(type: BuildingType): number {
  return VARIANTS[type].length;
}

export function variantDef(type: BuildingType, variant: number): VariantDef {
  return VARIANTS[type][variant];
}

const variantCache = new Map<string, THREE.BufferGeometry>();

/** Lazily-built, module-cached geometry of one building variant (origin = tile centre, lot frame). */
export function variantGeometry(type: BuildingType, variant: number): THREE.BufferGeometry {
  const key = `${type}:${variant}`;
  let g = variantCache.get(key);
  if (!g) {
    g = merge(VARIANTS[type][variant].build(BUILDING_STYLE[type].color));
    variantCache.set(key, g);
  }
  return g;
}

/** Every type × variant, for registering in one BatchedMesh. */
export function allVariants(): { type: BuildingType; variant: number; geo: THREE.BufferGeometry }[] {
  return ALL_BUILDINGS.flatMap((type) => VARIANTS[type].map((_, variant) => ({ type, variant, geo: variantGeometry(type, variant) })));
}

export interface BuildingPose {
  variant: number;
  /** yaw that turns the lot frame's +z/+x onto the tile's two street sides */
  yaw: number;
  /** footprint scale (x and z) and height scale */
  sxz: number;
  sy: number;
}

/**
 * Deterministic per-tile pose. Streets run on even grid lines, so a tile's
 * street sides follow from the parity of its coordinates; the yaw faces the
 * building's front (+z) and side (+x) onto them.
 */
export function buildingPose(type: BuildingType, x: number, y: number): BuildingPose {
  const sx = x % 2 === 0 ? -1 : 1;
  const sz = y % 2 === 0 ? -1 : 1;
  const yaw = sx > 0 ? (sz > 0 ? 0 : Math.PI / 2) : sz > 0 ? -Math.PI / 2 : Math.PI;
  return {
    variant: Math.floor(hash2(x, y, 21) * VARIANTS[type].length),
    yaw,
    sxz: 0.95 + hash2(x, y, 22) * 0.05,
    sy: 0.92 + hash2(x, y, 23) * 0.16,
  };
}

/** Geometry + transform of the building on tile (x, y) for a `<mesh>` (selection outline, build ghost). */
export function buildingMeshProps(type: BuildingType, x: number, y: number): { geometry: THREE.BufferGeometry; rotation: [number, number, number]; scale: [number, number, number] } {
  const p = buildingPose(type, x, y);
  return { geometry: variantGeometry(type, p.variant), rotation: [0, p.yaw, 0], scale: [p.sxz, p.sy, p.sxz] };
}

/** Top of the building's silhouette on tile (x, y), for labels. */
export function buildingHeight(type: BuildingType, x: number, y: number): number {
  const p = buildingPose(type, x, y);
  return (variantGeometry(type, p.variant).boundingBox?.max.y ?? BUILDING_STYLE[type].height) * p.sy;
}

/* ───────────────────────── rotors (animated per instance) ───────────────────────── */

export type RotorKind = NonNullable<(typeof BUILDING_STYLE)[BuildingType]["rotor"]>;

export interface RotorSpec {
  /** rotation axis in the lot frame */
  axis: "x" | "y" | "z";
  /** radians/sec at full utilization */
  speed: number;
  /** pumpjacks rock instead of spin */
  rock: boolean;
}

export const ROTOR_SPEC: Record<RotorKind, RotorSpec> = {
  blade: { axis: "x", speed: 9, rock: false },
  pumpjack: { axis: "x", speed: 1.6, rock: true },
  wheel: { axis: "z", speed: 2.2, rock: false },
  fan: { axis: "y", speed: 6, rock: false },
};

let rotorCache: Record<RotorKind, THREE.BufferGeometry> | null = null;

export function rotorGeometries(): Record<RotorKind, THREE.BufferGeometry> {
  if (rotorCache) return rotorCache;
  const blade = merge([
    { geo: xf(new THREE.CylinderGeometry(0.22, 0.22, 0.02, 18), 0, 0, 0, 0, 0, Math.PI / 2), color: C.steel, tint: false },
    { geo: xf(new THREE.CylinderGeometry(0.05, 0.05, 0.06, 8), 0, 0, 0, 0, 0, Math.PI / 2), color: C.dark, tint: false },
  ]);
  const pumpjack = merge([
    { geo: box(0.07, 0.07, 0.9, 0, 0, 0), color: C.steel, tint: false },
    { geo: box(0.1, 0.22, 0.08, 0, -0.06, 0.45), color: C.rust, tint: false },
    { geo: box(0.16, 0.14, 0.12, 0, -0.02, -0.42), color: C.dark, tint: false },
  ]);
  const wheelParts: Part[] = [{ geo: new THREE.TorusGeometry(0.22, 0.03, 6, 18), color: C.wood, tint: false }];
  for (let i = 0; i < 4; i++) wheelParts.push({ geo: xf(new THREE.BoxGeometry(0.035, 0.44, 0.03), 0, 0, 0, 0, 0, (i * Math.PI) / 4), color: C.wood, tint: false });
  const wheel = merge(wheelParts);
  const fanParts: Part[] = [{ geo: new THREE.CylinderGeometry(0.035, 0.035, 0.06, 8), color: C.dark, tint: false }];
  for (let i = 0; i < 4; i++) fanParts.push({ geo: xf(new THREE.BoxGeometry(0.28, 0.02, 0.07), 0, 0, 0, 0, (i * Math.PI) / 2, 0.35), color: C.steel, tint: false });
  const fan = merge(fanParts);
  rotorCache = { blade, pumpjack, wheel, fan };
  return rotorCache;
}

/* ───────────────────────── lot dressing ───────────────────────── */

export type LotKind =
  | "concrete" | "gravel" | "fence" | "hedge" | "wall" | "pylon" | "stall"
  | "car" | "van" | "truck" | "container" | "pallets" | "crates" | "drums" | "lumber" | "logs"
  | "tree" | "treeRound" | "bush" | "pit" | "frame" | "scaffold" | "mast";

let lotCache: Record<LotKind, THREE.BufferGeometry> | null = null;

/**
 * Everything dressing a built lot, each kind one geometry in the lots
 * BatchedMesh. Unit-sized where instances stretch them (pads, fences, the
 * construction frame/scaffold/pit); vehicles face +x with paint on mask 1.
 */
export function lotGeometries(): Record<LotKind, THREE.BufferGeometry> {
  if (lotCache) return lotCache;
  // flat paint/joint lines are bare quads: two triangles each
  const line = (w: number, d: number, x: number, y: number, z: number) => xf(new THREE.PlaneGeometry(w, d), x, y, z, -Math.PI / 2);
  const pad = (color: string, joint: string): Part[] => {
    const out: Part[] = [wallP(boxUp(1, 0.014, 1, 0, 0, 0), color)];
    for (const t of [-0.25, 0, 0.25]) out.push(fix(line(1, 0.006, 0, 0.0155, t), joint), fix(line(0.006, 1, t, 0.0155, 0), joint));
    return out;
  };
  const paint = "#ffffff";
  const wheels = (xs: number[], w: number, r: number): Part[] => xs.map((x) => fix(box(r * 2, r * 2, w, x, r, 0), "#1f2124"));
  const lots: Record<LotKind, Part[]> = {
    concrete: pad("#bfb8a8", "#9d968a"),
    gravel: [wallP(boxUp(1, 0.012, 1, 0, 0, 0), "#a39b89"), fix(boxUp(0.6, 0.002, 0.08, 0.1, 0.012, 0.2), "#8f8775"), fix(boxUp(0.08, 0.002, 0.5, -0.2, 0.012, -0.1), "#8f8775")],
    fence: [fix(boxUp(1, 0.16, 0.006, 0, 0.03, 0), "#8d9792"), fix(boxUp(1, 0.018, 0.018, 0, 0.19, 0), "#555b60"), fix(boxUp(1, 0.03, 0.02, 0, 0, 0), "#7a766d")],
    hedge: [fix(boxUp(1, 0.17, 0.13, 0, 0, 0), "#45713a"), fix(boxUp(0.98, 0.04, 0.1, 0, 0.17, 0), "#558543")],
    wall: [fix(boxUp(1, 0.15, 0.05, 0, 0, 0), K.brick), fix(boxUp(1, 0.02, 0.07, 0, 0.15, 0), "#c9c1b0")],
    pylon: [fix(boxUp(0.12, 0.04, 0.22, 0, 0, 0), C.concrete), accentP(boxUp(0.04, 0.3, 0.18, 0, 0.04, 0), "#3fb68b"), fix(box(0.046, 0.05, 0.12, 0, 0.27, 0), K.letters)],
    stall: [fix(line(0.3, 0.012, 0, 0.016, -0.105), "#eeeae0"), fix(line(0.3, 0.012, 0, 0.016, 0.105), "#eeeae0")],
    car: [
      wallP(boxUp(0.32, 0.07, 0.15, 0, 0.03, 0), paint),
      wallP(boxUp(0.16, 0.055, 0.13, -0.02, 0.1, 0), paint),
      fix(boxUp(0.168, 0.036, 0.136, -0.02, 0.106, 0), "#2b333c"),
      ...wheels([-0.1, 0.1], 0.155, 0.032),
    ],
    van: [
      wallP(boxUp(0.36, 0.15, 0.16, 0, 0.03, 0), paint),
      fix(box(0.012, 0.06, 0.13, 0.181, 0.14, 0), "#2b333c"),
      ...wheels([-0.11, 0.12], 0.165, 0.034),
    ],
    truck: [
      fix(boxUp(0.36, 0.2, 0.17, -0.07, 0.06, 0), "#e7e4dc"),
      wallP(boxUp(0.12, 0.17, 0.17, 0.18, 0.05, 0), paint),
      fix(box(0.012, 0.06, 0.15, 0.241, 0.17, 0), "#2b333c"),
      ...wheels([-0.18, -0.06, 0.18], 0.18, 0.04),
    ],
    container: [wallP(boxUp(0.42, 0.17, 0.17, 0, 0, 0), paint), ...[-0.14, 0, 0.14].map((x) => wallP(boxUp(0.012, 0.17, 0.176, x, 0, 0), "#b4b4b4")), fix(box(0.006, 0.15, 0.15, 0.212, 0.085, 0), "#3a3d42")],
    pallets: [
      fix(boxUp(0.16, 0.03, 0.16, -0.09, 0, 0), C.pallet), fix(boxUp(0.13, 0.12, 0.13, -0.09, 0.03, 0), "#bf9a68"),
      fix(boxUp(0.16, 0.03, 0.16, 0.09, 0, 0), C.pallet), fix(boxUp(0.13, 0.08, 0.13, 0.09, 0.03, 0), "#d8d2c4"),
      fix(boxUp(0.16, 0.03, 0.16, -0.09, 0.15, 0), C.pallet), fix(boxUp(0.13, 0.09, 0.13, -0.09, 0.18, 0), "#bf9a68"),
    ],
    crates: [fix(boxUp(0.14, 0.12, 0.14, -0.08, 0, 0), "#9b7347"), fix(boxUp(0.14, 0.12, 0.14, 0.08, 0, 0.02), "#a8814f"), fix(boxUp(0.13, 0.11, 0.13, -0.06, 0.12, 0.01), "#9b7347")],
    drums: [0, 1, 2, 3].map((i) => wallP(cyl(0.035, 0.035, 0.1, -0.04 + (i % 2) * 0.08, 0, i < 2 ? -0.04 : 0.04, 6), paint)),
    lumber: [fix(boxUp(0.4, 0.07, 0.2, 0, 0, 0), "#d0a872"), fix(boxUp(0.03, 0.012, 0.21, -0.12, 0.07, 0), "#6d4c30"), fix(boxUp(0.03, 0.012, 0.21, 0.12, 0.07, 0), "#6d4c30"), fix(boxUp(0.4, 0.06, 0.2, 0, 0.082, 0), "#c79d66")],
    logs: logPile(0, 0, 0, 0.45),
    tree: [
      fix(cyl(0.025, 0.035, 0.18, 0, 0, 0, 5), C.trunk),
      fix(cone(0.15, 0.3, 0, 0.12, 0, 6), C.leaf),
      fix(cone(0.11, 0.24, 0, 0.3, 0, 6), C.leafLight),
    ],
    treeRound: [
      fix(cyl(0.025, 0.035, 0.2, 0, 0, 0, 5), C.trunk),
      fix(xf(new THREE.IcosahedronGeometry(0.15, 0), 0, 0.3, 0, 0, 0, 0, 1, 0.9, 1), "#5a9443"),
      fix(xf(new THREE.IcosahedronGeometry(0.1, 0), 0.05, 0.4, 0.03), "#6ea950"),
    ],
    bush: [fix(xf(new THREE.IcosahedronGeometry(0.09, 0), 0, 0.06, 0, 0, 0, 0, 1.3, 0.8, 1), "#4c7d3b")],
    pit: [
      fix(boxUp(1, 0.016, 1, 0, 0, 0), K.earth),
      fix(boxUp(0.86, 0.03, 0.86, 0, 0, 0), "#a9a396"),
      ...[-0.3, -0.1, 0.1, 0.3].map((t) => fix(boxUp(0.86, 0.008, 0.01, 0, 0.03, t), C.rust)),
    ],
    frame: (() => {
      const out: Part[] = [];
      const g = [-0.5, -0.17, 0.17, 0.5];
      for (const x of g) for (const z of g) if (Math.abs(x) === 0.5 || Math.abs(z) === 0.5) out.push(fix(boxUp(0.03, 1, 0.03, x, 0, z), K.primer));
      for (const y of [0.33, 0.66, 0.98]) {
        for (const t of [-0.5, 0.5]) out.push(fix(box(1, 0.025, 0.025, 0, y, t), K.primer), fix(box(0.025, 0.025, 1, t, y, 0), K.primer));
        out.push(fix(boxUp(0.96, 0.012, 0.3, 0, y - 0.02, -0.3), "#b0aa9c"));
      }
      return out;
    })(),
    scaffold: (() => {
      const out: Part[] = [];
      for (const [x, z] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5], [0, -0.5], [0, 0.5]] as const) out.push(fix(boxUp(0.02, 1, 0.02, x, 0, z), C.scaffold));
      for (const y of [0.34, 0.67, 1]) {
        out.push(fix(boxUp(1.02, 0.012, 0.012, 0, y - 0.012, -0.5), C.scaffold), fix(boxUp(1.02, 0.012, 0.012, 0, y - 0.012, 0.5), C.scaffold));
        out.push(fix(boxUp(0.012, 0.012, 1.02, -0.5, y - 0.012, 0), C.scaffold), fix(boxUp(0.012, 0.012, 1.02, 0.5, y - 0.012, 0), C.scaffold));
        out.push(fix(boxUp(1.0, 0.008, 0.07, 0, y - 0.03, 0.47), C.wood), fix(boxUp(0.07, 0.008, 0.9, 0.47, y - 0.03, 0), C.wood));
      }
      return out;
    })(),
    mast: [fix(boxUp(0.36, 0.08, 0.36, 0, 0, 0), K.frame), ...lattice(0, 0, 0.14, 0.14, 2.4, C.crane)],
  };
  const out = {} as Record<LotKind, THREE.BufferGeometry>;
  for (const k of Object.keys(lots) as LotKind[]) out[k] = merge(lots[k]);
  lotCache = out;
  return out;
}

let jibCache: THREE.BufferGeometry | null = null;

/** Tower-crane jib; origin = top of the mast, arm along +x, counter-jib along −x, hook line down. */
export function craneJibGeometry(): THREE.BufferGeometry {
  if (jibCache) return jibCache;
  jibCache = merge([
    { geo: boxUp(0.2, 0.22, 0.2, 0, 0, 0), color: C.dark, tint: false },
    { geo: box(2.0, 0.07, 0.07, 0.95, 0.2, 0), color: C.crane, tint: false },
    { geo: beam([0, 0.45, 0], [1.6, 0.24, 0], 0.012), color: C.dark, tint: false },
    { geo: boxUp(0.05, 0.25, 0.05, 0, 0.2, 0), color: C.crane, tint: false },
    { geo: box(0.7, 0.07, 0.07, -0.4, 0.2, 0), color: C.crane, tint: false },
    { geo: box(0.24, 0.18, 0.18, -0.68, 0.14, 0), color: "#8a8f96", tint: false },
    { geo: box(0.012, 1.4, 0.012, 1.4, -0.5, 0), color: C.dark, tint: false },
    { geo: box(0.12, 0.08, 0.12, 1.4, -1.22, 0), color: C.rust, tint: false },
  ]);
  return jibCache;
}

/* ───────────────────────── materials ───────────────────────── */

/** 0 by day, 1 at night; DayNight writes it, every tinted material reads it for window/lamp glow. */
export const NIGHT = { value: 0 };

const srgb = new THREE.Color();

/**
 * Packs a roof and an accent colour (4-bit sRGB per channel, roof in the
 * high 12 bits) into one float — exact in float32 — for the alpha of a
 * BatchedMesh instance colour, so one batch carries three tints per
 * building (shade in rgb, roof and company colour in alpha).
 */
export function packPaint(roof: THREE.Color, accent: THREE.Color): number {
  const q = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 15);
  const pack = (c: THREE.Color) => {
    srgb.copy(c).convertLinearToSRGB();
    return (q(srgb.r) * 16 + q(srgb.g)) * 16 + q(srgb.b);
  };
  return pack(roof) * 4096 + pack(accent);
}

/**
 * Standard material whose instancing/batching shader multiplies the
 * per-instance color only into vertices with `tintMask == 1` (detail parts
 * keep their vertex color). On a BatchedMesh, `tintMask` 2 (roof) and 3
 * (accent) vertices take the colours packed into the instance alpha (alpha
 * ≤ 1 = three's unset default → roof follows the rgb, accent keeps its
 * vertex colour). `glow == 1` vertices get a warm emissive scaled by NIGHT.
 */
export function tintedStandardMaterial(opts: { roughness?: number; metalness?: number } = {}): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: opts.roughness ?? 0.85, metalness: opts.metalness ?? 0.02 });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = NIGHT;
    shader.vertexShader = shader.vertexShader
      .replace("#include <color_pars_vertex>", "#include <color_pars_vertex>\nattribute float tintMask;\nattribute float glow;\nvarying float vGlow;")
      .replace("#include <color_vertex>", colorVertex());
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vGlow;\nuniform float uNight;")
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance += vGlow * uNight * vec3( 1.0, 0.72, 0.38 ) * 2.4;");
    stylize(shader);
  };
  m.customProgramCacheKey = () => "tintMaskGlowRoofAccent";
  return m;
}

let colorVertexCache: string | null = null;

/**
 * three's `color_vertex` chunk with the tint mask, roof and accent channels
 * spliced in. Inlined rather than string-replaced in the shader because
 * `onBeforeCompile` sees `#include`s unresolved; throws if a three upgrade
 * moves the anchors.
 */
function colorVertex(): string {
  if (colorVertexCache) return colorVertexCache;
  const src = THREE.ShaderChunk.color_vertex;
  const instanceLine = "vColor.xyz *= instanceColor.xyz;";
  const batchLine = "vColor.xyz *= batchingColor.xyz;";
  if (!src.includes(instanceLine) || !src.includes(batchLine)) throw new Error("three color_vertex chunk changed: update tintedStandardMaterial");
  colorVertexCache = src
    .replace(instanceLine, "vColor.xyz *= mix( vec3( 1.0 ), instanceColor.xyz, min( tintMask, 1.0 ) );")
    .replace(batchLine, /* glsl */`
      if ( tintMask > 1.5 ) {
        int bSize = textureSize( batchingColorTexture, 0 ).x;
        int bJ = int( getIndirectIndex( gl_DrawID ) );
        float packed = texelFetch( batchingColorTexture, ivec2( bJ % bSize, bJ / bSize ), 0 ).a;
        if ( packed > 1.5 ) {
          float hi = floor( packed / 4096.0 );
          float v = tintMask > 2.5 ? packed - hi * 4096.0 : hi;
          vColor.xyz = pow( vec3( floor( v / 256.0 ), mod( floor( v / 16.0 ), 16.0 ), mod( v, 16.0 ) ) / 15.0, vec3( 2.2 ) );
        } else if ( tintMask < 2.5 ) {
          vColor.xyz = batchingColor.xyz;
        }
      } else {
        vColor.xyz *= mix( vec3( 1.0 ), batchingColor.xyz, tintMask );
      }`) + "\nvGlow = glow;";
  return colorVertexCache;
}
