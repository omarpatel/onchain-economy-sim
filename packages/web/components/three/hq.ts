import * as THREE from "three";
import { CR_MINOR } from "@econ-sim/sim/units";
import { C, box, boxUp, cone, cyl, merge, xf, type Part } from "./geometry.ts";
import { hash2 } from "./world-style.ts";

/**
 * Company headquarters landmarks for HQ tiles without a building: four
 * archetypes × four valuation tiers, each a merged vertex-coloured geometry
 * in the lot frame (origin = tile centre, front street on +z, side street on
 * +x — the same frame as the building kit, turned by the street yaw).
 * Accent parts take the company colour packed into the batch instance colour.
 */

export const HQ_ARCHETYPES = 4;
export const HQ_TIERS = 4;

/** Valuation (CR) at which a company's HQ steps up a tier; log-spaced so growth keeps showing. */
const TIER_CR = [12_000, 50_000, 200_000] as const;

export function hqTier(valuationMinor: number): number {
  const v = valuationMinor / CR_MINOR;
  let t = 0;
  while (t < TIER_CR.length && v >= TIER_CR[t]) t++;
  return t;
}

/** Archetype is a stable property of the tile, so a firm keeps its architecture as it grows. */
export function hqArchetype(x: number, y: number): number {
  return Math.floor(hash2(x, y, 41) * HQ_ARCHETYPES);
}

type V3 = [number, number, number];

export interface HqModel {
  geo: THREE.BufferGeometry;
  /** beacon / crown tip in the lot frame */
  top: V3;
  /** flag hoist points (top of each pole) in the lot frame; the first flies the company colour */
  flags: V3[];
  /** parked cars [x, z, ry] in the lot frame (lot-kit cars face +x) */
  cars: [number, number, number][];
}

/* ───────────────────────── palette ───────────────────────── */

const P = {
  pave: "#d6cfbf",
  paveLight: "#e6e0d2",
  curb: "#a9a294",
  planter: "#9d978b",
  bush: "#4e8a3c",
  bushLight: "#67a34a",
  pole: "#d9dcdf",
  gold: "#d9a836",
  dark: "#33373d",
  frame: "#464b52",
  stone: "#d3d6d8",
  curtain: "#86a0b0",
  glass: "#5c7486",
  brick: "#a65d45",
  cream: "#ece6d6",
  slate: "#5f6873",
  panel: "#ebe8e1",
  sage: "#7f9c63",
  atrium: "#b9d4d6",
  deco: "#d6c49c",
  decoRib: "#efe6cf",
  water: "#4fb3d6",
  solar: "#2d3e5c",
} as const;

/* ───────────────────────── part kit ───────────────────────── */

const wall = (geo: THREE.BufferGeometry, color: string): Part => ({ geo, color, tint: true });
const fix = (geo: THREE.BufferGeometry, color: string): Part => ({ geo, color, tint: false });
const glass = (geo: THREE.BufferGeometry, color: string = P.glass): Part => ({ geo, color, tint: false, glow: true });
const roof = (geo: THREE.BufferGeometry): Part => ({ geo, color: C.roof, tint: false, roof: true });
/** Company-colour part; the fallback shows only where no packed accent exists. */
const accent = (geo: THREE.BufferGeometry): Part => ({ geo, color: "#3fb68b", tint: false, accent: true });

/** Glazed band per floor on the chosen faces of a w×d block centred at (x, z). */
function floorBands(out: Part[], w: number, d: number, x: number, z: number, y0: number, floors: number, fh: number, bh: number, color: string = P.glass): void {
  for (let f = 0; f < floors; f++) {
    const y = y0 + f * fh + fh * 0.55;
    out.push(
      glass(box(w - 0.05, bh, 0.012, x, y, z + d / 2 + 0.004), color),
      glass(box(w - 0.05, bh, 0.012, x, y, z - d / 2 - 0.004), color),
      glass(box(0.012, bh, d - 0.05, x + w / 2 + 0.004, y, z), color),
      glass(box(0.012, bh, d - 0.05, x - w / 2 - 0.004, y, z), color),
    );
  }
}

/** Punched windows in a grid on the +z face (and ±x faces when `sides`). */
function punched(out: Part[], w: number, d: number, x: number, z: number, y0: number, floors: number, fh: number, step: number, sides: boolean): void {
  const ww = step * 0.48, wh = fh * 0.5;
  for (let f = 0; f < floors; f++) {
    const y = y0 + f * fh + fh * 0.52;
    const nx = Math.max(1, Math.floor((w - 0.1) / step));
    for (let i = 0; i < nx; i++) {
      const px = x - ((nx - 1) * step) / 2 + i * step;
      out.push(glass(box(ww, wh, 0.012, px, y, z + d / 2 + 0.004)));
    }
    if (!sides) continue;
    const nz = Math.max(1, Math.floor((d - 0.1) / step));
    for (let i = 0; i < nz; i++) {
      const pz = z - ((nz - 1) * step) / 2 + i * step;
      out.push(glass(box(0.012, wh, ww, x + w / 2 + 0.004, y, pz)), glass(box(0.012, wh, ww, x - w / 2 - 0.004, y, pz)));
    }
  }
}

/** Flat roof cap with a thin parapet. */
function flatRoof(out: Part[], w: number, d: number, x: number, h: number, z: number, color: string = P.curb): void {
  out.push(fix(boxUp(w + 0.03, 0.05, d + 0.03, x, h, z), color));
}

/** Concrete planter with a clipped shrub. */
function planter(out: Part[], x: number, z: number, s = 1): void {
  out.push(
    fix(boxUp(0.2 * s, 0.1, 0.2 * s, x, 0.04, z), P.planter),
    fix(xf(new THREE.IcosahedronGeometry(0.105 * s, 0), x, 0.19, z, 0, 0, 0, 1, 0.75, 1), P.bush),
    fix(xf(new THREE.IcosahedronGeometry(0.07 * s, 0), x + 0.03, 0.25, z - 0.02), P.bushLight),
  );
}

/** Plaza lamp: post with a head that glows at night. */
function lamp(out: Part[], x: number, z: number): void {
  out.push(fix(cyl(0.011, 0.014, 0.36, x, 0.04, z, 6), P.dark), glass(box(0.05, 0.035, 0.05, x, 0.42, z), C.lampHead));
}

/** Flagpole on a plinth; returns the hoist point (just under the finial). */
function flagpole(out: Part[], x: number, z: number, h: number): V3 {
  out.push(
    fix(boxUp(0.09, 0.04, 0.09, x, 0.04, z), P.curb),
    fix(cyl(0.012, 0.016, h, x, 0.08, z, 6), P.pole),
    fix(xf(new THREE.SphereGeometry(0.026, 8, 6), x, 0.08 + h + 0.02, z), P.gold),
  );
  return [x, 0.08 + h - 0.01, z];
}

/** Entrance canopy in the company colour on two posts, facing +z at (x, z). */
function canopy(out: Part[], x: number, z: number, w: number, y: number): void {
  out.push(
    accent(boxUp(w, 0.035, 0.3, x, y, z + 0.15)),
    fix(cyl(0.012, 0.012, y, x - w / 2 + 0.03, 0.04, z + 0.27, 6), P.frame),
    fix(cyl(0.012, 0.012, y, x + w / 2 - 0.03, 0.04, z + 0.27, 6), P.frame),
    fix(box(w * 0.5, y * 0.85, 0.012, x, 0.04 + (y * 0.85) / 2, z + 0.004), P.dark),
  );
}

/** Logo board in the company colour with a light lettering strip, facing +z (turned by `ry`). */
function logo(out: Part[], x: number, y: number, z: number, w: number, h: number, ry = 0): void {
  const parts = [
    fix(box(w + 0.03, h + 0.03, 0.014, 0, 0, 0), P.dark),
    accent(box(w, h, 0.014, 0, 0, 0.01)),
    fix(box(w * 0.62, h * 0.26, 0.006, 0, -h * 0.12, 0.02), "#f6f2e8"),
    fix(box(h * 0.36, h * 0.36, 0.006, -w * 0.32, h * 0.12, 0.02), "#f6f2e8"),
  ];
  for (const p of parts) xf(p.geo, x, y, z, 0, ry, 0);
  out.push(...parts);
}

/** Paved plaza over the whole lot with a lighter forecourt and curbs. */
function plaza(out: Part[]): void {
  out.push(
    fix(boxUp(1.92, 0.04, 1.92, -0.125, 0, -0.125), P.curb),
    fix(boxUp(1.86, 0.006, 1.86, -0.125, 0.04, -0.125), P.pave),
    fix(boxUp(1.5, 0.004, 0.62, -0.25, 0.046, 0.48), P.paveLight),
  );
  for (const t of [-0.6, -0.2, 0.2]) out.push(fix(boxUp(0.006, 0.002, 0.62, t, 0.05, 0.48), P.curb));
}

/** Parking row along the side street: stall lines baked in, cars are separate instances. */
function parking(out: Part[], n: number): [number, number, number][] {
  const cars: [number, number, number][] = [];
  for (let i = 0; i < n; i++) {
    const z = -0.88 + i * 0.24;
    out.push(fix(boxUp(0.34, 0.002, 0.012, 0.62, 0.046, z - 0.12), "#f1ede4"));
    cars.push([0.62, z, Math.PI]);
  }
  out.push(fix(boxUp(0.34, 0.002, 0.012, 0.62, 0.046, -0.88 + n * 0.24 - 0.12), "#f1ede4"));
  return cars;
}

/** Ornamental fountain: basin, water disc and a jet column. */
function fountain(out: Part[], x: number, z: number): void {
  out.push(
    fix(cyl(0.2, 0.22, 0.07, x, 0.04, z, 14), P.stone),
    glass(cyl(0.18, 0.18, 0.01, x, 0.1, z, 14), P.water),
    fix(cyl(0.03, 0.04, 0.16, x, 0.1, z, 8), P.stone),
    fix(cyl(0.07, 0.03, 0.03, x, 0.26, z, 10), P.stone),
  );
}

/* ───────────────────────── archetypes ───────────────────────── */

/** Glass office tower on a stone podium, setback crown with a company band and spire. */
function tower(tier: number): Omit<HqModel, "geo"> & { parts: Part[] } {
  const out: Part[] = [];
  const floors = [4, 7, 11, 15][tier];
  const fh = 0.26;
  const px = -0.33, pz = -0.43;
  // podium
  const ph = 0.5;
  out.push(wall(boxUp(1.34, ph, 1.12, px, 0.04, pz), P.stone));
  out.push(glass(box(1.24, 0.3, 0.012, px, 0.04 + 0.2, pz + 0.564), P.glass), glass(box(0.012, 0.3, 1.0, px + 0.674, 0.24, pz), P.glass));
  flatRoof(out, 1.34, 1.12, px, ph + 0.04, pz);
  // shaft
  const sw = tier >= 2 ? 0.92 : 0.84;
  const y0 = ph + 0.09;
  const sh = floors * fh;
  out.push(wall(boxUp(sw, sh, sw, px - 0.04, y0, pz - 0.04), P.curtain));
  floorBands(out, sw, sw, px - 0.04, pz - 0.04, y0, floors, fh, fh * 0.62);
  for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    out.push(fix(boxUp(0.05, sh + 0.04, 0.05, px - 0.04 + (ox * sw) / 2, y0, pz - 0.04 + (oz * sw) / 2), "#eef0f1"));
  }
  // crown: setbacks, company band, spire
  let y = y0 + sh;
  let w = sw * 0.8;
  const steps = tier >= 3 ? 2 : 1;
  for (let s = 0; s < steps; s++) {
    out.push(fix(boxUp(w + 0.06, 0.04, w + 0.06, px - 0.04, y, pz - 0.04), "#eef0f1"));
    out.push(wall(boxUp(w, 0.32, w, px - 0.04, y + 0.04, pz - 0.04), P.curtain));
    floorBands(out, w, w, px - 0.04, pz - 0.04, y + 0.04, 1, 0.32, 0.18);
    y += 0.36;
    w *= 0.72;
  }
  out.push(accent(boxUp(w + 0.12, 0.08, w + 0.12, px - 0.04, y, pz - 0.04)));
  y += 0.08;
  const spire = 0.35 + tier * 0.25;
  out.push(fix(cyl(0.012, 0.04, spire, px - 0.04, y, pz - 0.04, 6), P.pole));
  const top: V3 = [px - 0.04, y + spire + 0.03, pz - 0.04];
  // logo on the shaft's street face near the top
  logo(out, px - 0.04, y0 + sh - 0.28, pz - 0.04 + sw / 2 + 0.012, sw * 0.62, 0.24);
  canopy(out, px + 0.1, pz + 0.56, 0.5, 0.3);
  planter(out, -0.85, 0.42); planter(out, 0.22, 0.42);
  lamp(out, -0.55, 0.72); lamp(out, 0.05, 0.72);
  if (tier >= 2) fountain(out, -0.3, 0.52);
  const flags: V3[] = [flagpole(out, 0.42, 0.66, 1.1 + tier * 0.15)];
  if (tier >= 2) flags.push(flagpole(out, 0.22, 0.7, 0.95 + tier * 0.15), flagpole(out, 0.62, 0.62 - 0.02, 0.95 + tier * 0.15));
  return { parts: out, top, flags, cars: parking(out, 3) };
}

/** Brick corporate hall: columned portico, banners and a clock tower. */
function hall(tier: number): Omit<HqModel, "geo"> & { parts: Part[] } {
  const out: Part[] = [];
  const floors = [2, 2, 3, 3][tier];
  const fh = 0.32;
  const w = tier >= 1 ? 1.62 : 1.36, d = 0.82;
  const hx = -0.3, hz = -0.5;
  const h = floors * fh + 0.04;
  out.push(wall(boxUp(w, h, d, hx, 0.04, hz), P.brick));
  out.push(fix(boxUp(w + 0.03, 0.08, d + 0.03, hx, 0.04, hz), P.stone));
  punched(out, w, d, hx, hz, 0.1, floors, fh, 0.18, true);
  // cornice + slate mansard
  out.push(fix(boxUp(w + 0.06, 0.04, d + 0.06, hx, h, hz), P.cream));
  out.push(roof(xf(new THREE.CylinderGeometry(0.5, 0.707, 0.22, 4, 1), hx, h + 0.15, hz, 0, Math.PI / 4, 0, (w - 0.02) / 1, 1, (d - 0.02) / 1)));
  // pavilion wings rise at tier 3
  if (tier >= 3) {
    for (const s of [-1, 1]) {
      const wx = hx + s * (w / 2 - 0.2);
      out.push(wall(boxUp(0.42, h + 0.3, d + 0.08, wx, 0.04, hz), P.brick));
      punched(out, 0.42, d + 0.08, wx, hz, 0.1 + floors * fh, 1, 0.3, 0.14, false);
      out.push(fix(boxUp(0.46, 0.04, d + 0.12, wx, h + 0.34, hz), P.cream));
      out.push(roof(xf(new THREE.ConeGeometry(0.42, 0.24, 4), wx, h + 0.5, hz, 0, Math.PI / 4, 0, 0.78, 1, 1.4)));
    }
  }
  // portico: stylobate steps, columns, pediment
  const cw = 0.78, cz = hz + d / 2 + 0.17;
  out.push(fix(boxUp(cw + 0.16, 0.04, 0.42, hx, 0.04, cz - 0.04), P.cream), fix(boxUp(cw + 0.06, 0.04, 0.34, hx, 0.08, cz - 0.04), P.cream));
  const ch = Math.min(h - 0.08, 0.62);
  const nCol = tier >= 2 ? 6 : 4;
  for (let i = 0; i < nCol; i++) {
    const x = hx - cw / 2 + 0.05 + (i * (cw - 0.1)) / (nCol - 1);
    out.push(fix(cyl(0.028, 0.032, ch, x, 0.12, cz + 0.05, 8), P.cream));
  }
  out.push(fix(boxUp(cw + 0.04, 0.06, 0.32, hx, 0.12 + ch, cz - 0.03), P.cream));
  out.push(fix(xf(new THREE.CylinderGeometry(0.0001, 0.5, 1, 3, 1), hx, 0.12 + ch + 0.06 + 0.09, cz - 0.03, Math.PI / 2, 0, 0, cw * 0.98, 0.32, 0.36), P.cream));
  out.push(accent(boxUp(cw * 0.7, 0.05, 0.012, hx, 0.12 + ch - 0.02, cz + 0.13)));
  // banners either side of the portico
  for (const s of [-1, 1]) out.push(accent(box(0.09, 0.32, 0.012, hx + s * (cw / 2 + 0.16), 0.1 + h * 0.55, hz + d / 2 + 0.012)));
  // clock tower behind the portico
  const tw = 0.34, th = h + [0.55, 0.75, 1.05, 1.45][tier];
  const tx = hx, tz = hz - 0.05;
  out.push(wall(boxUp(tw, th, tw, tx, 0.04, tz), P.brick));
  out.push(fix(boxUp(tw + 0.06, 0.34, tw + 0.06, tx, th, tz), P.cream));
  for (let k = 0; k < 4; k++) {
    const ry = (k * Math.PI) / 2;
    const face = [
      fix(xf(new THREE.CylinderGeometry(0.11, 0.11, 0.012, 16), 0, th + 0.17, (tw + 0.06) / 2 + 0.006, Math.PI / 2, 0, 0), "#f8f5ec"),
      fix(box(0.012, 0.08, 0.006, 0, th + 0.2, (tw + 0.06) / 2 + 0.014), P.dark),
      fix(xf(new THREE.BoxGeometry(0.012, 0.06, 0.006), 0.02, th + 0.16, (tw + 0.06) / 2 + 0.014, 0, 0, -1.1), P.dark),
    ];
    for (const p of face) { p.geo.translate(-tx, 0, -tz); p.geo.rotateY(ry); p.geo.translate(tx, 0, tz); }
    out.push(...face);
  }
  out.push(fix(boxUp(tw + 0.1, 0.03, tw + 0.1, tx, th + 0.34, tz), P.cream));
  out.push(roof(xf(new THREE.ConeGeometry(0.29, 0.5, 4), tx, th + 0.37 + 0.25, tz, 0, Math.PI / 4, 0)));
  out.push(fix(cyl(0.008, 0.012, 0.22, tx, th + 0.87, tz, 6), P.gold));
  const top: V3 = [tx, th + 1.1, tz];
  planter(out, -1.0, 0.5); planter(out, 0.35, 0.5);
  lamp(out, hx - cw / 2 - 0.08, 0.35); lamp(out, hx + cw / 2 + 0.08, 0.35);
  if (tier >= 2) fountain(out, -0.3, 0.6);
  const flags: V3[] = [flagpole(out, 0.42, 0.68, 1.0 + tier * 0.12)];
  if (tier >= 1) flags.push(flagpole(out, -0.98, 0.68, 0.9 + tier * 0.12));
  return { parts: out, top, flags, cars: parking(out, tier >= 2 ? 3 : 2) };
}

/** Modern low campus: white ribbon-window wings, a glazed atrium, green roof, monolith logo. */
function campus(tier: number): Omit<HqModel, "geo"> & { parts: Part[] } {
  const out: Part[] = [];
  const fh = 0.3;
  const fa = [1, 2, 2, 3][tier];
  const fb = [1, 1, 2, 3][tier];
  // wing A along x at the back
  const ax = -0.25, az = -0.78, aw = 1.6, ad = 0.46;
  const ah = fa * fh + 0.04;
  out.push(wall(boxUp(aw, ah, ad, ax, 0.04, az), P.panel));
  floorBands(out, aw, ad, ax, az, 0.04, fa, fh, fh * 0.5, "#6b8597");
  out.push(fix(boxUp(aw + 0.03, 0.04, ad + 0.03, ax, ah + 0.04, az), "#d8d5ce"), fix(boxUp(aw - 0.12, 0.02, ad - 0.1, ax, ah + 0.08, az), P.sage));
  out.push(accent(boxUp(aw + 0.035, 0.035, 0.012, ax, ah, az + ad / 2 + 0.008)));
  // wing B along z on the west
  const bx = -0.82, bz = -0.12, bw = 0.42, bd = 0.9;
  const bh = fb * fh + 0.04;
  out.push(wall(boxUp(bw, bh, bd, bx, 0.04, bz), P.panel));
  floorBands(out, bw, bd, bx, bz, 0.04, fb, fh, fh * 0.5, "#6b8597");
  out.push(fix(boxUp(bw + 0.03, 0.04, bd + 0.03, bx, bh + 0.04, bz), "#d8d5ce"));
  // solar on wing B from tier 2
  if (tier >= 2) for (let i = 0; i < 3; i++) out.push(fix(xf(new THREE.BoxGeometry(0.3, 0.012, 0.2), bx, bh + 0.13, bz - 0.28 + i * 0.28, -0.35, 0, 0), P.solar));
  // glazed atrium in the crook of the L, tallest element
  const ih = Math.max(ah, bh) + 0.22;
  const ix = -0.42, iz = -0.36;
  out.push(glass(boxUp(0.52, ih, 0.48, ix, 0.04, iz), P.atrium));
  for (const t of [-0.17, 0, 0.17]) out.push(fix(boxUp(0.012, ih, 0.012, ix + t, 0.04, iz + 0.245), "#e8eaeb"));
  out.push(fix(xf(new THREE.BoxGeometry(0.56, 0.02, 0.56), ix, ih + 0.1, iz, 0.3, 0, 0), "#e8eaeb"));
  out.push(glass(xf(new THREE.BoxGeometry(0.52, 0.012, 0.5), ix, ih + 0.115, iz, 0.3, 0, 0), P.atrium));
  // tier 3: a second, taller block linked by a sky bridge
  let top: V3 = [ix, ih + 0.2, iz];
  if (tier >= 3) {
    const cx = 0.2, cz = -0.18, cf = 5;
    const chh = cf * fh + 0.04;
    out.push(wall(boxUp(0.5, chh, 0.5, cx, 0.04, cz), P.panel));
    floorBands(out, 0.5, 0.5, cx, cz, 0.04, cf, fh, fh * 0.5, "#6b8597");
    out.push(fix(boxUp(0.53, 0.04, 0.53, cx, chh + 0.04, cz), "#d8d5ce"), accent(boxUp(0.3, 0.12, 0.3, cx, chh + 0.08, cz)));
    out.push(glass(box(0.34, 0.14, 0.18, (ix + cx) / 2 + 0.08, ah + 0.02, -0.4), P.atrium));
    top = [cx, chh + 0.24, cz];
  }
  canopy(out, ix, iz + 0.24, 0.42, 0.26);
  // monolith logo totem on the forecourt
  out.push(fix(boxUp(0.3, 0.04, 0.12, 0.05, 0.04, 0.55), P.curb));
  logo(out, 0.05, 0.08 + 0.2 + tier * 0.04, 0.55, 0.24, 0.36 + tier * 0.08);
  planter(out, -0.62, 0.48, 1.1); planter(out, -0.32, 0.6); planter(out, -1.0, 0.62);
  lamp(out, -0.15, 0.3); lamp(out, 0.3, 0.3);
  if (tier >= 1) for (const [x, z] of [[-0.95, 0.25], [-0.8, 0.7]] as const) out.push(fix(cyl(0.02, 0.03, 0.2, x, 0.04, z, 5), C.trunk), fix(xf(new THREE.IcosahedronGeometry(0.15, 0), x, 0.36, z, 0, 0, 0, 1, 0.9, 1), "#5a9443"));
  const flags: V3[] = [flagpole(out, 0.42, 0.68, 0.95 + tier * 0.12)];
  return { parts: out, top, flags, cars: parking(out, tier >= 3 ? 2 : 3) };
}

/** Art-deco block: stepped setbacks, vertical ribs, gold bands and a finned spire. */
function deco(tier: number): Omit<HqModel, "geo"> & { parts: Part[] } {
  const out: Part[] = [];
  const cx = -0.32, cz = -0.42;
  // [width, storey height] per setback; grander firms stack more of them
  const levels = ([[1.3, 0.9], [1.0, 0.75], [0.72, 0.7], [0.5, 0.65]] as const).slice(0, [2, 2, 3, 4][tier]);
  let y = 0.04;
  let lastW = 1.3;
  levels.forEach(([w, hgt], i) => {
    const h = hgt * (1 + tier * 0.12);
    const d = w * (i === 0 ? 0.92 : 1);
    out.push(wall(boxUp(w, h, d, cx, y, cz), P.deco));
    // ribs + slit windows on the street faces
    const n = Math.max(3, Math.round(w / 0.13));
    for (let k = 0; k <= n; k++) {
      const t = -w / 2 + (k * w) / n;
      out.push(fix(boxUp(0.03, h, 0.02, cx + t, y, cz + d / 2 + 0.006), P.decoRib));
      out.push(fix(boxUp(0.02, h, 0.03, cx + w / 2 + 0.006, y, cz + (k * d) / n - d / 2), P.decoRib));
      if (k < n) {
        out.push(glass(boxUp((w / n) * 0.5, h - 0.14, 0.012, cx + t + w / n / 2, y + 0.06, cz + d / 2 + 0.003)));
        out.push(glass(boxUp(0.012, h - 0.14, (d / n) * 0.5, cx + w / 2 + 0.003, y + 0.06, cz - d / 2 + (k + 0.5) * (d / n))));
      }
    }
    y += h;
    out.push(fix(boxUp(w + 0.04, 0.04, d + 0.04, cx, y, cz), i === 0 ? P.decoRib : P.gold));
    if (i === 0) out.push(accent(boxUp(w + 0.045, 0.05, d + 0.045, cx, y - 0.1, cz)));
    y += 0.04;
    lastW = w;
  });
  // finned spire
  const sp = 0.4 + tier * 0.3;
  for (let k = 0; k < 4; k++) out.push(fix(xf(new THREE.BoxGeometry(lastW * 0.5, 0.012, 0.02), cx, y + 0.02, cz, 0, (k * Math.PI) / 4, Math.PI / 2, 1, 1, 1), P.gold));
  out.push(fix(cone(lastW * 0.22, sp, cx, y, cz, 8), P.decoRib), fix(cyl(0.006, 0.012, 0.25, cx, y + sp - 0.02, cz, 5), P.gold));
  const top: V3 = [cx, y + sp + 0.25, cz];
  // sunburst entrance: half-disc in the company colour over a dark doorway
  const fz = cz + 1.3 * 0.46 + 0.01;
  out.push(fix(box(0.3, 0.34, 0.014, cx, 0.21, fz), P.dark));
  out.push(accent(xf(new THREE.CylinderGeometry(0.2, 0.2, 0.016, 12, 1, false, -Math.PI / 2, Math.PI), cx, 0.38, fz + 0.002, Math.PI / 2, 0, 0)));
  out.push(fix(xf(new THREE.CylinderGeometry(0.12, 0.12, 0.02, 10, 1, false, -Math.PI / 2, Math.PI), cx, 0.38, fz + 0.006, Math.PI / 2, 0, 0), P.gold));
  logo(out, cx, Math.min(y - 0.4, 1.2), fz - 0.004, 0.5, 0.14);
  planter(out, cx - 0.45, 0.42); planter(out, cx + 0.45, 0.42);
  lamp(out, -0.95, 0.72); lamp(out, 0.25, 0.72);
  if (tier >= 1) fountain(out, -0.32, 0.6);
  const flags: V3[] = [flagpole(out, 0.42, 0.68, 1.1 + tier * 0.12)];
  if (tier >= 3) flags.push(flagpole(out, -0.98, 0.68, 1.0 + tier * 0.12));
  return { parts: out, top, flags, cars: parking(out, 3) };
}

const BUILDERS = [tower, hall, campus, deco];
const cache = new Map<number, HqModel>();

/** Module-cached model for an archetype × tier (plaza + building merged into one geometry). */
export function hqModel(archetype: number, tier: number): HqModel {
  const key = archetype * HQ_TIERS + tier;
  let m = cache.get(key);
  if (!m) {
    const { parts, ...rest } = BUILDERS[archetype](tier);
    plaza(parts);
    m = { geo: merge(parts), ...rest };
    cache.set(key, m);
  }
  return m;
}

/** Height of a company's HQ landmark (for labels and popups over an empty HQ tile). */
export function hqHeight(x: number, y: number, valuationMinor: number): number {
  return hqModel(hqArchetype(x, y), hqTier(valuationMinor)).top[1];
}
