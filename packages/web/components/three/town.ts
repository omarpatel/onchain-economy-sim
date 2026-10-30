import * as THREE from "three";
import { C, NIGHT } from "./geometry.ts";
import { ROAD, ROOF, TILE, TOWN_RING, hash2 } from "./world-style.ts";

/**
 * The town around the playable district (ring 1..TOWN_RING tiles outside the
 * map): a street grid on the in-map rhythm, boulevards on the map's centre
 * lines, parks and plazas, a skyline toward the north-west, terraces and
 * villas fading into the countryside, and a harbour on the south shore.
 *
 * Everything static is generated once (deterministic from `hash2`) into
 * merged geometry: one ground mesh (streets, pavements, lawns, quay wall) and
 * per-chunk building meshes in two LODs (`hi` with balconies, awnings, rooftop
 * plant, street furniture, parked cars; `lo` with the bare volumes and blob
 * trees). Windows, pavers, road paint and water are drawn by `townMaterial`'s
 * shader from per-vertex facade coordinates, so a 30-storey tower costs ten
 * triangles and its windows still light up at night.
 */

/* ───────────────────────── shared constants ───────────────────────── */

/** Storey height of town buildings (the industrial district's window rows are 0.55 apart). */
export const STOREY = 0.42;

/** Surface kinds the town shader understands (vertex attribute `aWin.x`). */
export const KIND = {
  plain: 0,
  apartment: 1,
  office: 2,
  glass: 3,
  house: 4,
  shop: 5,
  shed: 6,
  glow: 7,
  church: 8,
  pavers: 9,
  lawn: 10,
  water: 11,
  parking: 12,
  pitch: 13,
  solar: 14,
  asphalt: 16,
  zebra: 17,
} as const;
const FACADE = new Set<number>([1, 2, 3, 4, 5, 6, 8]);

// heights of the flat layers (in-map streets sit a hair higher so they win where both overlap)
const Y_BASE = 0.012;
const Y_PATCH = 0.018;
const Y_FINE = 0.022;
const Y_ASPH = 0.028;
const Y_PAINT = 0.031;
const Y_WALK = 0.048;
const Y_KERB = 0.058;
const KERB = 0.022;
/** Standard street: same widths as the in-map streets. */
const SA = ROAD.asphalt / 2;
const SHW = ROAD.width / 2;
/** Boulevard: two carriageways (driving + parking lane) around a planted median. */
const BA = 0.59;
const BHW = 0.75;
const BM = 0.17;
/** Lane centre offsets from a street's axis (right-hand traffic). */
const LANE_STD = ROAD.laneOffset;
const LANE_BLVD = 0.3;
/** Shoreline drop: quay wall reaches below the sea surface (-0.35). */
const QUAY_FOOT = -0.6;
const SEA_Y = -0.35;

const PLASTER = ["#e8dfcc", "#ddd0b4", "#d9cfb8", "#c9bea4", "#e6d3b0", "#d9bf98", "#efe7d6", "#c8cfc9", "#d7c4a8", "#e3c9a0", "#cfd8d6", "#f0dcc0"] as const;
const BRICK = ["#a95b3e", "#b86b4a", "#8e4f3a", "#c27c5a", "#9b6a50", "#b0705a"] as const;
const PASTEL = ["#e9d7b7", "#d9e0d0", "#ecd2c0", "#d6dde6", "#efe2b8", "#e2cfe0", "#f2e6d4", "#cfe0d8", "#f0c9a8", "#c9d9e6"] as const;
const OFFICE = ["#c9c6be", "#b6b8b6", "#d2cfc6", "#a9b0b4", "#bfb4a2"] as const;
const GLASSY = ["#7d97ab", "#8fa8b8", "#6f8aa0", "#9bb0bb", "#7f9a9a", "#a3a9b8", "#9c937c", "#6f95a8"] as const;
const STONE = ["#d8cfbf", "#c9c2b4", "#b8b0a2", "#e0d6c2"] as const;
const FLAT_ROOF = ["#bdb6a6", "#a9a39a", "#c8c0ad", "#9c9a94", "#b3ab9b"] as const;
const AWNING = ["#c0392b", "#2e7d5b", "#d9a03a", "#2f6fa3", "#8e3b6e", "#e07a3c", "#3c8c8c", "#f0ece0"] as const;
const CAR = ["#c94a3a", "#e8e4dc", "#2f3b4a", "#4f6f8f", "#d6b24a", "#6b7b5a", "#9aa2aa", "#1f2a33", "#a83a52", "#3a7a6a", "#efefef", "#5a5f66"] as const;
const LEAF = ["#4f8f3e", "#5b9a45", "#3f7a35", "#6aa04c", "#7a9e3e", "#4a8a50", "#5e8c3a", "#3c6e3a"] as const;
const BLOSSOM = ["#d58fa0", "#e0a8b8", "#c98a3a", "#d4b04a", "#b8c24a"] as const;
const CONTAINER = ["#b5452f", "#2f6a9a", "#d3a03a", "#3d7a54", "#8a8d91", "#c56a2a", "#5b4f8a", "#e2dccf"] as const;
const LAWN = ["#6f9c4f", "#79a556", "#679448", "#82aa5c"] as const;
const SHED_WALL = ["#9aa3a8", "#b5735a", "#c9b48a", "#6f8a9a", "#a8a091", "#8c9a86"] as const;
const WALK = ROAD.walkColor;
const PAVE_WARM = "#d6c8aa";
const PAVE_COOL = "#c3bfb5";
const HEDGE = "#3f6b34";
const WOOD = "#8a6a4a";
const QUAY = "#8f8676";
const QUAY_CAP = "#cfc6b2";
const POOL = "#4fb3cf";
const POND = "#4b8fa6";

const rgbCache = new Map<string, THREE.Color>();
function rgb(hex: string): THREE.Color {
  let c = rgbCache.get(hex);
  if (!c) { c = new THREE.Color(hex); rgbCache.set(hex, c); }
  return c;
}

type Rng = () => number;
/** Mulberry32 seeded from a tile hash: deterministic per block. */
function rng(i: number, j: number, salt: number): Rng {
  let s = Math.floor(hash2(i, j, salt) * 4294967296) | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pick<T>(r: Rng, list: readonly T[]): T {
  return list[Math.floor(r() * list.length) % list.length];
}
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/* ───────────────────────── geometry builder ───────────────────────── */

interface Tpl { p: Float32Array; n: Float32Array }
function template(g: THREE.BufferGeometry, dy = 0): Tpl {
  const ng = g.index ? g.toNonIndexed() : g;
  ng.translate(0, dy, 0);
  ng.computeVertexNormals();
  const out = { p: new Float32Array(ng.getAttribute("position").array), n: new Float32Array(ng.getAttribute("normal").array) };
  ng.dispose();
  g.dispose();
  return out;
}
let tpls: { ico: Tpl; octa: Tpl; cone: Tpl; cone4: Tpl } | null = null;
function templates() {
  if (!tpls) {
    tpls = {
      ico: template(new THREE.IcosahedronGeometry(1, 0)),
      octa: template(new THREE.OctahedronGeometry(1, 0)),
      cone: template(new THREE.ConeGeometry(1, 1, 7, 1, true), 0.5),
      cone4: template(new THREE.ConeGeometry(1, 1, 4, 1, true), 0.5),
    };
  }
  return tpls;
}

/** One face of an axis-aligned footprint: origin A, run direction d, outward normal n, length L. */
interface Face { ax: number; az: number; dx: number; dz: number; nx: number; nz: number; L: number }
type Side = "n" | "e" | "s" | "w";
function faceOf(x0: number, z0: number, x1: number, z1: number, side: Side): Face {
  switch (side) {
    case "n": return { ax: x0, az: z0, dx: 1, dz: 0, nx: 0, nz: -1, L: x1 - x0 };
    case "e": return { ax: x1, az: z0, dx: 0, dz: 1, nx: 1, nz: 0, L: z1 - z0 };
    case "s": return { ax: x1, az: z1, dx: -1, dz: 0, nx: 0, nz: 1, L: x1 - x0 };
    default: return { ax: x0, az: z1, dx: 0, dz: -1, nx: -1, nz: 0, L: z1 - z0 };
  }
}
/** World AABB of a face-local rectangle: `s` along the face, `t` inward (negative = outside). */
function fl(f: Face, s0: number, s1: number, t0: number, t1: number): [number, number, number, number] {
  const ax = f.ax + f.dx * s0 - f.nx * t0, az = f.az + f.dz * s0 - f.nz * t0;
  const bx = f.ax + f.dx * s1 - f.nx * t1, bz = f.az + f.dz * s1 - f.nz * t1;
  return [Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz)];
}
const BIT: Record<Side, number> = { n: 1, e: 2, s: 4, w: 8 };

/**
 * Growable vertex soup with the town attributes: position, normal, colour,
 * `aFace` (facade u, v, face width, face height) and `aWin` (surface kind,
 * storey height, window column width, seed). Colour/kind are sticky state.
 */
class GB {
  private cap = 0;
  pos = new Float32Array(0);
  nrm = new Float32Array(0);
  col = new Float32Array(0);
  face = new Float32Array(0);
  win = new Float32Array(0);
  idx = new Uint32Array(1 << 14);
  nv = 0;
  ni = 0;
  private r = 1;
  private g = 1;
  private b = 1;
  private k = 0;
  private st = 0;
  private cw = 0;
  private sd = 0;

  constructor() { this.alloc(1 << 12); }

  private alloc(n: number) {
    const grow = (old: Float32Array, w: number) => { const a = new Float32Array(n * w); a.set(old.subarray(0, this.nv * w)); return a; };
    this.pos = grow(this.pos, 3);
    this.nrm = grow(this.nrm, 3);
    this.col = grow(this.col, 3);
    this.face = grow(this.face, 4);
    this.win = grow(this.win, 4);
    this.cap = n;
  }

  /** Set the colour (and reset to a plain surface). */
  c(hex: string, mul = 1): this {
    const c = rgb(hex);
    this.r = c.r * mul; this.g = c.g * mul; this.b = c.b * mul;
    this.k = 0; this.st = 0; this.cw = 0; this.sd = 0;
    return this;
  }

  kind(k: number, st = 0, cw = 0, sd = 0): this {
    this.k = k; this.st = st; this.cw = cw; this.sd = sd;
    return this;
  }

  private v(x: number, y: number, z: number, nx: number, ny: number, nz: number, fu: number, fv: number, fw: number, fh: number): number {
    if (this.nv >= this.cap) this.alloc(this.cap * 2);
    const i = this.nv++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.nrm[i * 3] = nx; this.nrm[i * 3 + 1] = ny; this.nrm[i * 3 + 2] = nz;
    this.col[i * 3] = this.r; this.col[i * 3 + 1] = this.g; this.col[i * 3 + 2] = this.b;
    this.face[i * 4] = fu; this.face[i * 4 + 1] = fv; this.face[i * 4 + 2] = fw; this.face[i * 4 + 3] = fh;
    this.win[i * 4] = this.k; this.win[i * 4 + 1] = this.st; this.win[i * 4 + 2] = this.cw; this.win[i * 4 + 3] = this.sd;
    return i;
  }

  private t(a: number, b: number, c: number) {
    if (this.ni + 3 > this.idx.length) { const n = new Uint32Array(this.idx.length * 2); n.set(this.idx); this.idx = n; }
    this.idx[this.ni++] = a; this.idx[this.ni++] = b; this.idx[this.ni++] = c;
  }

  /** Convex planar polygon (flat xyz list); winding is fixed up so the normal agrees with the hint. */
  poly(p: number[], hx: number, hy: number, hz: number, uv?: number[], fw = 0, fh = 0): this {
    const n = p.length / 3;
    const ax = p[3] - p[0], ay = p[4] - p[1], az = p[5] - p[2];
    const bx = p[6] - p[0], by = p[7] - p[1], bz = p[8] - p[2];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const flip = nx * hx + ny * hy + nz * hz < 0;
    if (flip) { nx = -nx; ny = -ny; nz = -nz; }
    const base = this.nv;
    for (let i = 0; i < n; i++) this.v(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], nx, ny, nz, uv ? uv[i * 2] : 0, uv ? uv[i * 2 + 1] : 0, fw, fh);
    for (let i = 1; i < n - 1; i++) {
      if (flip) this.t(base, base + i + 1, base + i);
      else this.t(base, base + i, base + i + 1);
    }
    return this;
  }

  /** Upward rect; local u runs along x (or z), v across from the rect's centre line. */
  rect(x0: number, z0: number, x1: number, z1: number, y: number, alongZ = false): this {
    const xc = (x0 + x1) / 2, zc = (z0 + z1) / 2;
    const uv = alongZ
      ? [0, x0 - xc, 0, x1 - xc, z1 - z0, x1 - xc, z1 - z0, x0 - xc]
      : [0, z0 - zc, x1 - x0, z0 - zc, x1 - x0, z1 - zc, 0, z1 - zc];
    return this.poly([x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1], 0, 1, 0, uv, alongZ ? z1 - z0 : x1 - x0, alongZ ? x1 - x0 : z1 - z0);
  }

  /** Vertical quad from a to b (outward = right of a→b seen from above), facade coords from `vb`. */
  wall(ax: number, az: number, bx: number, bz: number, y0: number, y1: number, vb = y0, fh = y1 - vb): this {
    const L = Math.hypot(bx - ax, bz - az);
    return this.poly(
      [ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y1, az],
      bz - az, 0, -(bx - ax),
      [0, y0 - vb, L, y0 - vb, L, y1 - vb, 0, y1 - vb],
      L, fh,
    );
  }

  /** Four walls of a footprint; `blank` bits (n e s w) drop windows on party walls. */
  walls(x0: number, z0: number, x1: number, z1: number, y0: number, y1: number, vb = y0, fh = y1 - vb, blank = 0): this {
    const k = this.k;
    const side = (s: Side, ax: number, az: number, bx: number, bz: number) => {
      this.k = blank & BIT[s] ? 0 : k;
      this.wall(ax, az, bx, bz, y0, y1, vb, fh);
    };
    side("n", x0, z0, x1, z0);
    side("e", x1, z0, x1, z1);
    side("s", x1, z1, x0, z1);
    side("w", x0, z1, x0, z0);
    this.k = k;
    return this;
  }

  /** Box without a bottom; facade kinds get a plain top (in `top` colour if given). */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, top?: string | null): this {
    this.walls(x0, z0, x1, z1, y0, y1);
    if (top === null) return this;
    const { r, g, b, k, st, cw, sd } = this;
    if (top) this.c(top);
    if (FACADE.has(k)) this.k = 0;
    this.rect(x0, z0, x1, z1, y1);
    this.r = r; this.g = g; this.b = b; this.k = k; this.st = st; this.cw = cw; this.sd = sd;
    return this;
  }

  /** Gabled roof on a footprint; ridge along x (`alongX`) or z, eaves overhang `oh`. */
  gable(x0: number, z0: number, x1: number, z1: number, y: number, h: number, alongX: boolean, roof: string, end: string, oh = 0.05): this {
    this.c(roof);
    if (alongX) {
      const zc = (z0 + z1) / 2;
      const ex = oh * 0.6;
      this.poly([x0 - ex, y, z0 - oh, x1 + ex, y, z0 - oh, x1 + ex, y + h, zc, x0 - ex, y + h, zc], 0, 1, -1);
      this.poly([x0 - ex, y, z1 + oh, x1 + ex, y, z1 + oh, x1 + ex, y + h, zc, x0 - ex, y + h, zc], 0, 1, 1);
      this.c(end);
      this.poly([x0, y, z0, x0, y, z1, x0, y + h, zc], -1, 0, 0);
      this.poly([x1, y, z0, x1, y, z1, x1, y + h, zc], 1, 0, 0);
    } else {
      const xc = (x0 + x1) / 2;
      const ez = oh * 0.6;
      this.poly([x0 - oh, y, z0 - ez, x0 - oh, y, z1 + ez, xc, y + h, z1 + ez, xc, y + h, z0 - ez], -1, 1, 0);
      this.poly([x1 + oh, y, z0 - ez, x1 + oh, y, z1 + ez, xc, y + h, z1 + ez, xc, y + h, z0 - ez], 1, 1, 0);
      this.c(end);
      this.poly([x0, y, z0, x1, y, z0, xc, y + h, z0], 0, 0, -1);
      this.poly([x0, y, z1, x1, y, z1, xc, y + h, z1], 0, 0, 1);
    }
    return this;
  }

  /** Hipped roof (pyramid when square); ridge along the longer axis. */
  hip(x0: number, z0: number, x1: number, z1: number, y: number, h: number, roof: string, oh = 0.05): this {
    this.c(roof);
    x0 -= oh; z0 -= oh; x1 += oh; z1 += oh;
    const w = x1 - x0, d = z1 - z0, t = y + h;
    if (w >= d) {
      const zc = (z0 + z1) / 2, i = d / 2;
      this.poly([x0, y, z0, x1, y, z0, x1 - i, t, zc, x0 + i, t, zc], 0, 1, -1);
      this.poly([x0, y, z1, x1, y, z1, x1 - i, t, zc, x0 + i, t, zc], 0, 1, 1);
      this.poly([x0, y, z0, x0, y, z1, x0 + i, t, zc], -1, 1, 0);
      this.poly([x1, y, z0, x1, y, z1, x1 - i, t, zc], 1, 1, 0);
    } else {
      const xc = (x0 + x1) / 2, i = w / 2;
      this.poly([x0, y, z0, x0, y, z1, xc, t, z1 - i, xc, t, z0 + i], -1, 1, 0);
      this.poly([x1, y, z0, x1, y, z1, xc, t, z1 - i, xc, t, z0 + i], 1, 1, 0);
      this.poly([x0, y, z0, x1, y, z0, xc, t, z0 + i], 0, 1, -1);
      this.poly([x0, y, z1, x1, y, z1, xc, t, z1 - i], 0, 1, 1);
    }
    return this;
  }

  /** Mansard: steep slate skirt up to an inset flat top. */
  mansard(x0: number, z0: number, x1: number, z1: number, y: number, h: number, ins: number, roof: string, top: string): this {
    this.c(roof);
    const t = y + h;
    this.poly([x0, y, z0, x1, y, z0, x1 - ins, t, z0 + ins, x0 + ins, t, z0 + ins], 0, 1, -1);
    this.poly([x0, y, z1, x1, y, z1, x1 - ins, t, z1 - ins, x0 + ins, t, z1 - ins], 0, 1, 1);
    this.poly([x0, y, z0, x0, y, z1, x0 + ins, t, z1 - ins, x0 + ins, t, z0 + ins], -1, 1, 0);
    this.poly([x1, y, z0, x1, y, z1, x1 - ins, t, z1 - ins, x1 - ins, t, z0 + ins], 1, 1, 0);
    this.c(top).rect(x0 + ins, z0 + ins, x1 - ins, z1 - ins, t);
    return this;
  }

  /** Facade cylinder (sides only): u runs around the circumference so window columns wrap. */
  tube(cx: number, cz: number, rad: number, y0: number, y1: number, seg: number, vb = y0, fh = y1 - vb): this {
    const L = 2 * rad * Math.sin(Math.PI / seg);
    for (let s = 0; s < seg; s++) {
      const a0 = (s / seg) * Math.PI * 2, a1 = ((s + 1) / seg) * Math.PI * 2, am = (a0 + a1) / 2;
      const x0 = cx + Math.cos(a0) * rad, z0 = cz + Math.sin(a0) * rad, x1 = cx + Math.cos(a1) * rad, z1 = cz + Math.sin(a1) * rad;
      this.poly([x0, y0, z0, x1, y0, z1, x1, y1, z1, x0, y1, z0], Math.cos(am), 0, Math.sin(am), [s * L, y0 - vb, (s + 1) * L, y0 - vb, (s + 1) * L, y1 - vb, s * L, y1 - vb], L * seg, fh);
    }
    return this;
  }

  /** Frustum with flat-shaded sides and an optional top cap. */
  cyl(cx: number, cz: number, rb: number, rt: number, y0: number, y1: number, seg = 8, cap = true, phase = 0): this {
    const pts: number[] = [];
    for (let s = 0; s < seg; s++) {
      const a0 = phase + (s / seg) * Math.PI * 2, a1 = phase + ((s + 1) / seg) * Math.PI * 2;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      const am = (a0 + a1) / 2;
      this.poly([cx + c0 * rb, y0, cz + s0 * rb, cx + c1 * rb, y0, cz + s1 * rb, cx + c1 * rt, y1, cz + s1 * rt, cx + c0 * rt, y1, cz + s0 * rt], Math.cos(am), 0, Math.sin(am));
      if (cap && rt > 0) pts.push(cx + c0 * rt, y1, cz + s0 * rt);
    }
    if (cap && rt > 0) this.poly(pts, 0, 1, 0);
    return this;
  }

  /** Append a unit template scaled, rotated about y and translated. */
  tpl(T: Tpl, x: number, y: number, z: number, sx: number, sy: number, sz: number, ry = 0): this {
    const c = Math.cos(ry), s = Math.sin(ry);
    const base = this.nv;
    const n = T.p.length / 3;
    for (let i = 0; i < n; i++) {
      const px = T.p[i * 3] * sx, py = T.p[i * 3 + 1] * sy, pz = T.p[i * 3 + 2] * sz;
      let nx = T.n[i * 3] / sx, ny = T.n[i * 3 + 1] / sy, nz = T.n[i * 3 + 2] / sz;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      this.v(x + px * c + pz * s, y + py, z - px * s + pz * c, nx * c + nz * s, ny, -nx * s + nz * c, 0, 0, 0, 0);
    }
    for (let i = 0; i < n; i += 3) this.t(base + i, base + i + 1, base + i + 2);
    return this;
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.pos.slice(0, this.nv * 3), 3));
    g.setAttribute("normal", new THREE.BufferAttribute(this.nrm.slice(0, this.nv * 3), 3));
    g.setAttribute("color", new THREE.BufferAttribute(this.col.slice(0, this.nv * 3), 3));
    g.setAttribute("aFace", new THREE.BufferAttribute(this.face.slice(0, this.nv * 4), 4));
    g.setAttribute("aWin", new THREE.BufferAttribute(this.win.slice(0, this.nv * 4), 4));
    g.setIndex(new THREE.BufferAttribute(this.idx.slice(0, this.ni), 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** Both LODs at once: every call goes to `hi` and `lo`. */
function fan(a: GB, b: GB): GB {
  const p: GB = new Proxy(a, {
    get(target, key) {
      const fa = Reflect.get(target, key) as unknown;
      if (typeof fa !== "function") return fa;
      const fb = Reflect.get(b, key) as (...args: unknown[]) => unknown;
      return (...args: unknown[]) => { (fa as (...args: unknown[]) => unknown).apply(a, args); fb.apply(b, args); return p; };
    },
  });
  return p;
}

/* ───────────────────────── output types ───────────────────────── */

export interface TownChunk {
  hi: THREE.BufferGeometry;
  lo: THREE.BufferGeometry;
  /** xz bounds for the LOD distance test */
  min: [number, number];
  max: [number, number];
}

/** One moving car: laps a lane rectangle (already offset into its lane) clockwise or not. */
export interface CarLap { x0: number; z0: number; x1: number; z1: number; cw: boolean; speed: number; phase: number; color: string }

export interface TownData { ground: THREE.BufferGeometry; chunks: TownChunk[]; cars: CarLap[] }

interface Chunk { hi: GB; lo: GB; F: GB }

interface Blk {
  i0: number;
  j0: number;
  /** interior (inside the sidewalks) */
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** which sides front a street */
  st: Record<Side, boolean>;
  k: number;
  down: number;
  r: Rng;
  c: Chunk;
  G: GB;
  seed: number;
}

/* ───────────────────────── small furniture ───────────────────────── */

function tree(c: Chunk, x: number, z: number, s: number, r: Rng, conifer = false, blossom = false) {
  const T = templates();
  const leaf = blossom ? pick(r, BLOSSOM) : pick(r, LEAF);
  const ry = r() * 6.28;
  if (conifer) {
    c.hi.c(C.trunk).cyl(x, z, 0.03 * s, 0.025 * s, 0, 0.14 * s, 5, false);
    c.hi.c(leaf, 0.85).tpl(T.cone, x, 0.1 * s, z, 0.2 * s, 0.62 * s, 0.2 * s, ry);
    c.lo.c(leaf, 0.85).tpl(T.cone4, x, 0.06 * s, z, 0.2 * s, 0.66 * s, 0.2 * s, ry);
    return;
  }
  c.hi.c(C.trunk).cyl(x, z, 0.032 * s, 0.024 * s, 0, 0.26 * s, 5, false);
  c.hi.c(leaf).tpl(T.ico, x, 0.42 * s, z, 0.24 * s, 0.21 * s, 0.24 * s, ry);
  c.hi.c(leaf, 1.18).tpl(T.ico, x + 0.07 * s, 0.53 * s, z - 0.05 * s, 0.15 * s, 0.13 * s, 0.15 * s, ry + 1);
  c.lo.c(leaf).tpl(T.octa, x, 0.42 * s, z, 0.25 * s, 0.24 * s, 0.25 * s, ry);
}

/** Street lamp: post, short arm toward (dx, dz), head that glows at night. */
function lamp(D: GB, x: number, z: number, dx: number, dz: number) {
  D.c(C.lampPost).cyl(x, z, 0.017, 0.012, 0, 0.72, 5, false);
  const hx = x + dx * 0.09, hz = z + dz * 0.09;
  D.box(Math.min(x, hx) - 0.008, 0.7, Math.min(z, hz) - 0.008, Math.max(x, hx) + 0.008, 0.716, Math.max(z, hz) + 0.008);
  D.c(C.lampHead).kind(KIND.glow).box(hx - 0.035, 0.66, hz - 0.035, hx + 0.035, 0.7, hz + 0.035);
}

function bench(D: GB, x: number, z: number, alongX: boolean) {
  const w = alongX ? 0.14 : 0.05, d = alongX ? 0.05 : 0.14;
  D.c(WOOD).box(x - w, 0.04, z - d, x + w, 0.06, z + d);
  D.c(C.lampPost).box(x - w * 0.8, 0, z - d * 0.8, x + w * 0.8, 0.04, z + d * 0.8, null);
}

/** Parked car: body + darker glasshouse. */
function pcar(D: GB, x: number, z: number, alongX: boolean, color: string) {
  const l = 0.17, w = 0.075;
  const hx = alongX ? l : w, hz = alongX ? w : l;
  D.c(color).box(x - hx, 0.025, z - hz, x + hx, 0.085, z + hz);
  const cx = alongX ? 0.1 : w * 0.85, cz = alongX ? w * 0.85 : 0.1;
  const off = 0.015;
  D.c("#2a3038").box(x - cx - (alongX ? off : 0), 0.085, z - cz - (alongX ? 0 : off), x + cx - (alongX ? off : 0), 0.135, z + cz - (alongX ? 0 : off), color);
}

function awning(D: GB, f: Face, s0: number, s1: number, color: string, y = 0.36) {
  const p = (s: number, o: number, yy: number) => [f.ax + f.dx * s + f.nx * o, yy, f.az + f.dz * s + f.nz * o];
  D.c(color).poly([...p(s0, 0, y), ...p(s1, 0, y), ...p(s1, 0.14, y - 0.08), ...p(s0, 0.14, y - 0.08)], f.nx, 1, f.nz);
  const a = p(s0, 0.14, 0), b = p(s1, 0.14, 0);
  D.c(color, 0.8).wall(a[0], a[2], b[0], b[2], y - 0.12, y - 0.08);
}

function rooftop(D: GB, x0: number, z0: number, x1: number, z1: number, h: number, r: Rng) {
  const w = x1 - x0, d = z1 - z0;
  const n = 1 + Math.floor(r() * 3);
  for (let i = 0; i < n; i++) {
    const sx = 0.08 + r() * 0.14, sz = 0.08 + r() * 0.14;
    if (w < sx * 2 + 0.2 || d < sz * 2 + 0.2) break;
    const x = lerp(x0 + 0.1 + sx, x1 - 0.1 - sx, r()), z = lerp(z0 + 0.1 + sz, z1 - 0.1 - sz, r());
    D.c(r() < 0.5 ? "#9fa3a6" : "#c6c3bb").box(x - sx, h, z - sz, x + sx, h + 0.06 + r() * 0.08, z + sz);
  }
  if (r() < 0.35 && w > 0.5 && d > 0.5) {
    const x = lerp(x0 + 0.2, x1 - 0.2, r()), z = lerp(z0 + 0.2, z1 - 0.2, r());
    D.c(WOOD).cyl(x, z, 0.07, 0.07, h + 0.05, h + 0.2, 7);
    D.c("#5a5f66").box(x - 0.06, h, z - 0.06, x + 0.06, h + 0.05, z + 0.06, null);
  }
}

/* ───────────────────────── buildings ───────────────────────── */

interface Vol {
  x0: number; z0: number; x1: number; z1: number;
  floors: number; wall: string; kind: number; colW: number; seed: number;
  blank?: number;
  roof: "flat" | "gable" | "hip" | "mansard";
  roofColor: string;
  /** ridge along x for gables */
  alongX?: boolean;
  base?: number;
}

/** A facade volume with its roof; rooftop plant on flat roofs goes to the detail LOD. */
function volume(c: Chunk, v: Vol, r: Rng): number {
  const y0 = v.base ?? 0;
  const h = y0 + v.floors * STOREY + 0.1;
  c.F.c(v.wall).kind(v.kind, STOREY, v.colW, v.seed).walls(v.x0, v.z0, v.x1, v.z1, y0, h, y0, h - y0, v.blank ?? 0);
  const w = v.x1 - v.x0, d = v.z1 - v.z0;
  const along = v.alongX ?? w >= d;
  switch (v.roof) {
    case "flat": {
      const roofKind = r();
      if (roofKind < 0.16 && w > 0.6 && d > 0.6) {
        // green roof
        c.F.c("#7f9a5a").kind(KIND.lawn).rect(v.x0, v.z0, v.x1, v.z1, h);
        break;
      }
      c.F.c(v.roofColor).rect(v.x0, v.z0, v.x1, v.z1, h);
      if (roofKind < 0.34 && w > 0.6 && d > 0.6) {
        const i = 0.1;
        c.F.c("#2c3d58").kind(KIND.solar).rect(v.x0 + i, v.z0 + i, v.x1 - i, v.z1 - i, h + 0.012);
      } else rooftop(c.hi, v.x0, v.z0, v.x1, v.z1, h, r);
      break;
    }
    case "gable":
      c.F.gable(v.x0, v.z0, v.x1, v.z1, h, Math.min(0.5, (along ? d : w) * 0.42), along, v.roofColor, v.wall, 0.05);
      break;
    case "hip":
      c.F.hip(v.x0, v.z0, v.x1, v.z1, h, Math.min(0.45, Math.min(w, d) * 0.45), v.roofColor, 0.05);
      break;
    case "mansard":
      c.F.mansard(v.x0 - 0.02, v.z0 - 0.02, v.x1 + 0.02, v.z1 + 0.02, h, 0.3, Math.min(0.16, Math.min(w, d) * 0.2), v.roofColor, pick(r, FLAT_ROOF));
      break;
  }
  return h;
}

/** Balcony slabs on a face, one per window column per upper floor. */
function balconies(D: GB, f: Face, floors: number, colW: number, color: string, base = 0) {
  const cols = Math.max(1, Math.floor(f.L / colW + 0.35));
  const cell = f.L / cols;
  for (let fl_ = 1; fl_ < floors; fl_++) {
    const y = base + fl_ * STOREY;
    for (let k = 0; k < cols; k++) {
      const s = (k + 0.5) * cell;
      const [x0, z0, x1, z1] = fl(f, s - cell * 0.32, s + cell * 0.32, -0.075, 0);
      D.c(color).box(x0, y, z0, x1, y + 0.08, z1);
    }
  }
}

function door(D: GB, f: Face, s: number, color = "#5b3d2a") {
  const [x0, z0, x1, z1] = fl(f, s - 0.055, s + 0.055, -0.015, 0);
  D.c(color).box(x0, 0, z0, x1, 0.27, z1);
}

/* ───────────────────────── block archetypes ───────────────────────── */

const SIDES: Side[] = ["n", "e", "s", "w"];

/** Split a run of length L into 1..max segments of at least `min`. */
function split(r: Rng, L: number, min: number, max: number): number[] {
  const n = Math.max(1, Math.min(max, Math.floor(L / min), 1 + Math.floor(r() * max)));
  const w = Array.from({ length: n }, () => 0.7 + r() * 0.6);
  const sum = w.reduce((a, b) => a + b, 0);
  return w.map((x) => (x / sum) * L);
}

/** Frontage band: paved sidewalk widening with street trees on tree-lined streets. */
function frontage(b: Blk, band: number, trees: boolean): void {
  for (const s of SIDES) {
    if (!b.st[s]) continue;
    const f = faceOf(b.x0, b.z0, b.x1, b.z1, s);
    const [x0, z0, x1, z1] = fl(f, 0, f.L, 0, band);
    b.G.c(WALK).rect(x0, z0, x1, z1, Y_PATCH);
    if (!trees) continue;
    const n = Math.floor(f.L / 0.75);
    for (let i = 0; i < n; i++) {
      const s0 = (i + 0.5) * (f.L / n);
      const [tx0, tz0, tx1, tz1] = fl(f, s0, s0, band * 0.5, band * 0.5);
      tree(b.c, (tx0 + tx1) / 2, (tz0 + tz1) / 2, 0.75 + b.r() * 0.2, b.r);
    }
  }
}

/** Shrink the block interior by `band` on every street side. */
function inset(b: Blk, band: number): [number, number, number, number] {
  return [b.x0 + (b.st.w ? band : 0), b.z0 + (b.st.n ? band : 0), b.x1 - (b.st.e ? band : 0), b.z1 - (b.st.s ? band : 0)];
}

/**
 * Perimeter block: rows of 2–6 storey buildings around a courtyard. Layout
 * varies per block (closed ring, U, two facing rows, corner L), rows break into
 * 1–3 buildings with their own height, colour and roof, a corner may rise as a
 * turret, and the courtyard holds gardens, parking, a playground or a hall.
 */
function perimeter(b: Blk, o: { fmin: number; fmax: number; shop: number; pitched: number; walls: readonly string[]; band: number; trees: boolean }) {
  const { r, c } = b;
  b.G.c(WALK).rect(b.x0, b.z0, b.x1, b.z1, Y_BASE);
  frontage(b, o.band, o.trees);
  const [x0, z0, x1, z1] = inset(b, o.band);
  const D = Math.min(0.85 + r() * 0.35, Math.min(x1 - x0, z1 - z0) / 2 - 0.3);
  const v = r();
  const has: Record<Side, boolean> = { n: true, e: true, s: true, w: true };
  if (v < 0.35) {
    // closed ring
  } else if (v < 0.55) {
    const open = SIDES.filter((s) => !b.st[s]);
    has[open.length ? open[0] : pick(r, SIDES)] = false;
  } else if (v < 0.78) {
    if ((b.st.n || b.st.s) && r() < 0.6) { has.e = false; has.w = false; } else { has.n = false; has.s = false; }
  } else {
    has[r() < 0.5 ? "n" : "s"] = false;
    has[r() < 0.5 ? "e" : "w"] = false;
  }
  const accent = r() < 0.35;
  const roofStyle = r();
  const segment = (sx0: number, sz0: number, sx1: number, sz1: number, side: Side, blank: number, turret: boolean) => {
    const floors = o.fmin + Math.floor(r() * (o.fmax - o.fmin + 1)) + (turret ? 2 : 0);
    const street = b.st[side];
    const shop = street && r() < o.shop;
    const wall = pick(r, o.walls);
    const colW = 0.36 + r() * 0.12;
    const pitched = turret || r() < o.pitched;
    const roof: Vol["roof"] = turret ? "hip" : pitched ? (roofStyle < 0.5 ? "gable" : "mansard") : "flat";
    const alongX = side === "n" || side === "s";
    const roofColor = turret ? pick(r, ["#5f8f7f", "#56606b", "#646c76", "#a3492b"]) : pitched ? pick(r, ROOF) : pick(r, FLAT_ROOF);
    const h = volume(c, { x0: sx0, z0: sz0, x1: sx1, z1: sz1, floors, wall, kind: shop ? KIND.shop : KIND.apartment, colW, seed: r() * 97, blank, roof, roofColor, alongX }, r);
    const f = faceOf(sx0, sz0, sx1, sz1, side);
    if (shop) awning(c.hi, f, 0.06, f.L - 0.06, pick(r, AWNING));
    else if (street) door(c.hi, f, f.L * (0.3 + r() * 0.4));
    if (!shop && floors >= 3 && r() < 0.4) balconies(c.hi, faceOf(sx0, sz0, sx1, sz1, ({ n: "s", s: "n", e: "w", w: "e" } as const)[side]), floors, colW, r() < 0.5 ? "#e9e6df" : wall);
    if (pitched && roof === "gable" && r() < 0.5) {
      const cx = lerp(sx0 + 0.15, sx1 - 0.15, r()), cz = lerp(sz0 + 0.15, sz1 - 0.15, r());
      c.hi.c("#8a5a48").box(cx - 0.04, h, cz - 0.04, cx + 0.04, h + 0.32, cz + 0.04);
    }
  };
  const runX = (zA: number, zB: number, side: Side) => {
    const ws = split(r, x1 - x0, 0.85, 3);
    const gap = ws.length === 3 && r() < 0.3;
    let x = x0;
    ws.forEach((w, i) => {
      if (!(gap && i === 1)) {
        const blank = (i > 0 && !(gap && i === 2) ? BIT.w : 0) | (i < ws.length - 1 && !(gap && i === 0) ? BIT.e : 0);
        const turret = accent && i === (side === "n" ? 0 : ws.length - 1) && ws.length > 1;
        segment(x, zA, x + w, zB, side, blank, turret);
      }
      x += w;
    });
  };
  const za = has.n ? z0 + D : z0, zb = has.s ? z1 - D : z1;
  const runZ = (xA: number, xB: number, side: Side) => {
    const ws = split(r, zb - za, 0.85, 2);
    let z = za;
    ws.forEach((w, i) => {
      segment(xA, z, xB, z + w, side, (i > 0 || has.n ? BIT.n : 0) | (i < ws.length - 1 || has.s ? BIT.s : 0), false);
      z += w;
    });
  };
  if (has.n) runX(z0, z0 + D, "n");
  if (has.s) runX(z1 - D, z1, "s");
  if (has.w) runZ(x0, x0 + D, "w");
  if (has.e) runZ(x1 - D, x1, "e");
  // courtyard
  const cx0 = has.w ? x0 + D : x0, cx1 = has.e ? x1 - D : x1, cz0 = za, cz1 = zb;
  const cw = cx1 - cx0, cd = cz1 - cz0;
  const fill = r();
  if (fill < 0.4 || cw < 0.9 || cd < 0.9) {
    b.G.c(pick(r, LAWN)).kind(KIND.lawn).rect(cx0, cz0, cx1, cz1, Y_PATCH);
    const n = 1 + Math.floor(r() * 3);
    for (let i = 0; i < n; i++) tree(c, lerp(cx0 + 0.25, cx1 - 0.25, r()), lerp(cz0 + 0.25, cz1 - 0.25, r()), 0.8 + r() * 0.35, r, false, r() < 0.1);
  } else if (fill < 0.65) {
    const alongX = cw >= cd;
    b.G.c("#5b5650").kind(KIND.parking).rect(cx0 + 0.08, cz0 + 0.08, cx1 - 0.08, cz1 - 0.08, Y_PATCH, !alongX);
    const len = (alongX ? cw : cd) - 0.3;
    for (let s = 0; s < len; s += 0.24) {
      if (r() < 0.4) continue;
      const side = r() < 0.5;
      if (alongX) pcar(c.hi, cx0 + 0.2 + s, side ? cz0 + 0.27 : cz1 - 0.27, false, pick(r, CAR));
      else pcar(c.hi, side ? cx0 + 0.27 : cx1 - 0.27, cz0 + 0.2 + s, true, pick(r, CAR));
    }
  } else if (fill < 0.8) {
    b.G.c(pick(r, LAWN)).kind(KIND.lawn).rect(cx0, cz0, cx1, cz1, Y_PATCH);
    const mx = (cx0 + cx1) / 2, mz = (cz0 + cz1) / 2;
    b.G.c("#d9c79a").rect(mx - 0.32, mz - 0.25, mx + 0.32, mz + 0.25, Y_FINE);
    c.hi.c("#d9483b").box(mx - 0.2, 0, mz - 0.12, mx - 0.08, 0.16, mz - 0.02);
    c.hi.c("#3b82c4").box(mx + 0.05, 0, mz + 0.02, mx + 0.22, 0.08, mz + 0.14);
    c.hi.c("#e2b33c").cyl(mx + 0.12, mz - 0.1, 0.07, 0.07, 0, 0.05, 8);
    tree(c, cx0 + 0.25, cz0 + 0.25, 0.9, r);
    tree(c, cx1 - 0.25, cz1 - 0.25, 0.9, r);
  } else {
    // low hall filling the court, green or gravel roof
    volume(c, { x0: cx0 + 0.12, z0: cz0 + 0.12, x1: cx1 - 0.12, z1: cz1 - 0.12, floors: 1, wall: pick(r, OFFICE), kind: KIND.shop, colW: 0.45, seed: r() * 97, roof: "flat", roofColor: r() < 0.5 ? "#7f9a5a" : pick(r, FLAT_ROOF) }, r);
  }
}

/** Two parallel modernist slabs with a parking court between. */
function slabs(b: Blk) {
  const { r, c } = b;
  b.G.c(PAVE_COOL).kind(KIND.pavers).rect(b.x0, b.z0, b.x1, b.z1, Y_BASE);
  frontage(b, 0.18, true);
  const [x0, z0, x1, z1] = inset(b, 0.22);
  const alongX = r() < 0.5;
  const D = 0.85 + r() * 0.15;
  const wall = pick(r, r() < 0.5 ? PLASTER : OFFICE);
  const parts = alongX
    ? [[x0 + 0.15, z0, x1 - 0.15, z0 + D], [x0 + 0.15, z1 - D, x1 - 0.15, z1]]
    : [[x0, z0 + 0.15, x0 + D, z1 - 0.15], [x1 - D, z0 + 0.15, x1, z1 - 0.15]];
  for (const [a, bb, cc, d] of parts) {
    const floors = 5 + Math.floor(r() * 4);
    volume(c, { x0: a, z0: bb, x1: cc, z1: d, floors, wall, kind: KIND.apartment, colW: 0.34, seed: r() * 97, roof: "flat", roofColor: pick(r, FLAT_ROOF) }, r);
    const f = faceOf(a, bb, cc, d, alongX ? (bb === z0 ? "s" : "n") : (a === x0 ? "e" : "w"));
    balconies(c.hi, f, floors, 0.34, "#ece8e0");
  }
  // parking court between the slabs
  const px0 = alongX ? x0 + 0.3 : x0 + D + 0.2, px1 = alongX ? x1 - 0.3 : x1 - D - 0.2;
  const pz0 = alongX ? z0 + D + 0.2 : z0 + 0.3, pz1 = alongX ? z1 - D - 0.2 : z1 - 0.3;
  b.G.c("#5b5650").kind(KIND.parking).rect(px0, pz0, px1, pz1, Y_PATCH, !alongX);
  const n = Math.floor(((alongX ? px1 - px0 : pz1 - pz0) - 0.1) / 0.24);
  for (let i = 0; i < n; i++) {
    if (r() < 0.35) continue;
    const s = (alongX ? px0 : pz0) + 0.12 + i * 0.24;
    const side = r() < 0.5;
    if (alongX) pcar(c.hi, s, side ? pz0 + 0.19 : pz1 - 0.19, false, pick(r, CAR));
    else pcar(c.hi, side ? px0 + 0.19 : px1 - 0.19, s, true, pick(r, CAR));
  }
}

/** Office slabs on a paved plaza. */
function offices(b: Blk) {
  const { r, c } = b;
  b.G.c(PAVE_COOL).kind(KIND.pavers).rect(b.x0, b.z0, b.x1, b.z1, Y_BASE);
  frontage(b, 0.2, true);
  const [x0, z0, x1, z1] = inset(b, 0.3);
  const w = x1 - x0, d = z1 - z0;
  const wall = pick(r, r() < 0.4 ? GLASSY : OFFICE);
  const kind = r() < 0.3 ? KIND.glass : KIND.office;
  if (r() < 0.5) {
    const sw = w * (0.7 + r() * 0.25), sd = 1.2 + r() * 0.35;
    const ox = x0 + (w - sw) * r(), oz = r() < 0.5 ? z0 : z1 - sd;
    volume(c, { x0: ox, z0: oz, x1: ox + sw, z1: oz + sd, floors: 6 + Math.floor(r() * 6), wall, kind, colW: 0.3, seed: r() * 97, roof: "flat", roofColor: pick(r, FLAT_ROOF) }, r);
    const lz = oz === z0 ? z1 - 0.9 : z0;
    volume(c, { x0: x0 + 0.1, z0: lz, x1: x0 + 1.3, z1: lz + 0.9, floors: 3 + Math.floor(r() * 3), wall: pick(r, OFFICE), kind: KIND.office, colW: 0.3, seed: r() * 97, roof: "flat", roofColor: pick(r, FLAT_ROOF) }, r);
  } else {
    const sw = 1.1 + r() * 0.3;
    volume(c, { x0, z0, x1: x0 + sw, z1, floors: 7 + Math.floor(r() * 5), wall, kind, colW: 0.3, seed: r() * 97, roof: "flat", roofColor: pick(r, FLAT_ROOF) }, r);
    volume(c, { x0: x0 + sw, z0, x1, z1: z0 + 1.0, floors: 4 + Math.floor(r() * 3), wall: pick(r, OFFICE), kind: KIND.office, colW: 0.3, seed: r() * 97, roof: "flat", roofColor: pick(r, FLAT_ROOF), blank: BIT.w }, r);
    for (let i = 0; i < 3; i++) tree(c, lerp(x0 + sw + 0.3, x1 - 0.2, r()), lerp(z0 + 1.3, z1 - 0.2, r()), 0.8, r);
  }
}

/** Downtown: a podium with one or two towers, setbacks and crowns. */
function towers(b: Blk, peak: boolean) {
  const { r, c, down } = b;
  b.G.c(PAVE_WARM).kind(KIND.pavers).rect(b.x0, b.z0, b.x1, b.z1, Y_BASE);
  frontage(b, 0.22, true);
  const [x0, z0, x1, z1] = inset(b, 0.32);
  const stone = pick(r, STONE);
  const podiumFloors = 2;
  const hp = volume(c, { x0, z0, x1, z1, floors: podiumFloors, wall: stone, kind: KIND.shop, colW: 0.4, seed: r() * 97, roof: "flat", roofColor: "#a8a296" }, r);
  for (const s of SIDES) if (b.st[s] && r() < 0.6) awning(c.hi, faceOf(x0, z0, x1, z1, s), 0.15, Math.min(1.4, (s === "n" || s === "s" ? x1 - x0 : z1 - z0) - 0.15), pick(r, AWNING));
  const two = !peak && r() < 0.35;
  const spots: [number, number, number][] = two
    ? [[x0 + 0.85, z0 + 0.85, 0.62], [x1 - 0.75, z1 - 0.75, 0.55]]
    : [[(x0 + x1) / 2 + (r() - 0.5) * 0.4, (z0 + z1) / 2 + (r() - 0.5) * 0.4, peak ? 0.95 : 0.7 + r() * 0.22]];
  for (const [tx, tz, half] of spots) {
    const floors = peak ? 36 : Math.round((10 + Math.pow(down, 1.4) * 20 + r() * 8) * (r() < 0.3 ? 0.65 : 1)) - (two ? 4 : 0);
    const glass = peak || r() < 0.62;
    const wall = glass ? pick(r, GLASSY) : pick(r, OFFICE);
    const kind = glass ? KIND.glass : KIND.office;
    const hx = half * (0.85 + r() * 0.3), hz = half * (0.85 + r() * 0.3);
    const seed = r() * 97;
    let top: number;
    let fx0 = tx - hx, fz0 = tz - hz, fx1 = tx + hx, fz1 = tz + hz;
    if (!peak && !two && r() < 0.28) {
      // round tower with a lit ring and a mast
      const rad = Math.min(hx, hz);
      top = hp + floors * STOREY + 0.1;
      c.F.c(wall).kind(kind, STOREY, 0.3, seed).tube(tx, tz, rad, hp, top, 14);
      c.F.c("#7f93ad").kind(KIND.glow, 1.2).tube(tx, tz, rad + 0.015, top - 0.08, top + 0.02, 14);
      c.F.c("#8d969e").cyl(tx, tz, rad, rad * 0.7, top + 0.02, top + 0.3, 14);
      c.hi.c("#c7ccd1").cyl(tx, tz, 0.02, 0.008, top + 0.3, top + 1.3, 4, false);
      continue;
    }
    if (floors > 18 && r() < 0.65) {
      const f1 = Math.round(floors * (0.55 + r() * 0.15));
      const mid = hp + f1 * STOREY;
      c.F.c(wall).kind(kind, STOREY, 0.3, seed).walls(fx0, fz0, fx1, fz1, hp, mid, hp);
      c.F.c(stone).rect(fx0, fz0, fx1, fz1, mid);
      const ins = 0.12 + r() * 0.12;
      fx0 += ins; fz0 += ins; fx1 -= ins; fz1 -= ins;
      top = mid + (floors - f1) * STOREY + 0.1;
      c.F.c(wall).kind(kind, STOREY, 0.3, seed + 1).walls(fx0, fz0, fx1, fz1, mid, top, hp);
    } else {
      top = hp + floors * STOREY + 0.1;
      c.F.c(wall).kind(kind, STOREY, 0.3, seed).walls(fx0, fz0, fx1, fz1, hp, top, hp);
    }
    const crown = peak ? 0 : r() * 0.88 + 0.12;
    if (crown < 0.24) {
      // spire on a lit crown
      c.F.c("#7f93ad").kind(KIND.glow, 1.2).box(fx0 - 0.02, top - 0.12, fz0 - 0.02, fx1 + 0.02, top, fz1 + 0.02, null);
      c.F.c("#8d969e").rect(fx0, fz0, fx1, fz1, top);
      c.F.hip(fx0 + 0.08, fz0 + 0.08, fx1 - 0.08, fz1 - 0.08, top, peak ? 2.2 : 0.9 + r() * 0.6, "#9aa6b0", 0);
      const sh = top + (peak ? 2.2 : 1.2);
      c.F.c("#c7ccd1").cyl((fx0 + fx1) / 2, (fz0 + fz1) / 2, 0.03, 0.01, sh - 0.3, sh + (peak ? 1.6 : 0.8), 4, false);
      c.hi.c("#ff6a5a").kind(KIND.glow).box((fx0 + fx1) / 2 - 0.025, sh + (peak ? 1.6 : 0.8), (fz0 + fz1) / 2 - 0.025, (fx0 + fx1) / 2 + 0.025, sh + (peak ? 1.65 : 0.85), (fz0 + fz1) / 2 + 0.025);
    } else if (crown < 0.55) {
      // stepped crown with mechanical penthouse
      c.F.c("#8d969e").rect(fx0, fz0, fx1, fz1, top);
      const i = 0.18;
      c.F.c(wall, 0.9).box(fx0 + i, top, fz0 + i, fx1 - i, top + 0.35, fz1 - i, "#7d858c");
      c.hi.c("#c7ccd1").cyl(fx1 - i - 0.06, fz0 + i + 0.06, 0.015, 0.008, top + 0.35, top + 1.1, 4, false);
    } else if (crown < 0.78) {
      // slanted glass top
      c.F.c(wall).poly([fx0, top, fz0, fx1, top, fz0, fx1, top + 0.7, fz1, fx0, top + 0.7, fz1], 0, 1, -1);
      c.F.c(wall, 0.85).poly([fx0, top, fz0, fx0, top, fz1, fx0, top + 0.7, fz1], -1, 0, 0);
      c.F.c(wall, 0.85).poly([fx1, top, fz0, fx1, top, fz1, fx1, top + 0.7, fz1], 1, 0, 0);
      c.F.c(wall, 0.9).wall(fx1, fz1, fx0, fz1, top, top + 0.7);
    } else {
      // flat roof with helipad
      c.F.c("#8d969e").rect(fx0, fz0, fx1, fz1, top);
      c.F.c("#7f93ad").kind(KIND.glow, 1.2).box(fx0 - 0.015, top - 0.06, fz0 - 0.015, fx1 + 0.015, top + 0.04, fz1 + 0.015, null);
      c.hi.c("#3c4148").cyl((fx0 + fx1) / 2, (fz0 + fz1) / 2, 0.36, 0.36, top, top + 0.02, 12);
      c.hi.c("#e9c74a").cyl((fx0 + fx1) / 2, (fz0 + fz1) / 2, 0.24, 0.24, top + 0.02, top + 0.025, 12);
      c.hi.c("#3c4148").cyl((fx0 + fx1) / 2, (fz0 + fz1) / 2, 0.21, 0.21, top + 0.025, top + 0.03, 12);
    }
  }
  rooftop(c.hi, x0, z0, x1, z1, hp, r);
}

/** Row houses along the street sides, back gardens behind. */
function terrace(b: Blk) {
  const { r, c } = b;
  b.G.c(pick(r, LAWN)).kind(KIND.lawn).rect(b.x0, b.z0, b.x1, b.z1, Y_BASE);
  const ns = b.st.n || b.st.s;
  const sides: Side[] = ns ? (["n", "s"] as Side[]).filter((s) => b.st[s]) : (["e", "w"] as Side[]).filter((s) => b.st[s]);
  const brick = r() < 0.45;
  for (const side of sides) {
    const f = faceOf(b.x0, b.z0, b.x1, b.z1, side);
    const setback = 0.1 + r() * 0.12;
    const depth = 0.72 + r() * 0.15;
    const gardenEnd = (ns ? b.z1 - b.z0 : b.x1 - b.x0) / sides.length;
    const floors = 2 + (r() < 0.4 ? 1 : 0);
    const roofBase = pick(r, ROOF);
    b.G.c(WALK).rect(...fl(f, 0, f.L, 0, setback), Y_PATCH);
    let s = 0.05;
    let first = true;
    while (s < f.L - 0.5) {
      const w = Math.min(0.48 + r() * 0.24, f.L - 0.05 - s);
      if (w < 0.4) break;
      const last = s + w > f.L - 0.5;
      const [x0, z0, x1, z1] = fl(f, s, s + w, setback, setback + depth);
      const blank = (side === "n" || side === "s")
        ? (first ? 0 : side === "n" ? BIT.w : BIT.e) | (last ? 0 : side === "n" ? BIT.e : BIT.w)
        : (first ? 0 : side === "e" ? BIT.n : BIT.s) | (last ? 0 : side === "e" ? BIT.s : BIT.n);
      const wall = brick ? (r() < 0.75 ? pick(r, BRICK) : pick(r, PASTEL)) : pick(r, PASTEL);
      const fh = floors + (r() < 0.2 ? 1 : 0);
      const h = volume(c, { x0, z0, x1, z1, floors: fh, wall, kind: KIND.house, colW: 0.26, seed: r() * 97, roof: "gable", roofColor: r() < 0.6 ? roofBase : pick(r, ROOF), alongX: side === "n" || side === "s", blank }, r);
      door(c.hi, faceOf(x0, z0, x1, z1, side), w * 0.3, pick(r, ["#5b3d2a", "#2f4a6a", "#6a2a2a", "#2f5a3a"]));
      if (r() < 0.6) {
        const [cx0, cz0, cx1, cz1] = fl(f, s + w - 0.04, s + w + 0.04, setback + depth * 0.5 - 0.04, setback + depth * 0.5 + 0.04);
        c.hi.c("#8a5a48").box(cx0, h, cz0, cx1, h + 0.38, cz1);
      }
      // back garden with fence
      const [gx0, gz0, gx1, gz1] = fl(f, s, s + w, setback + depth, gardenEnd);
      b.G.c(pick(r, LAWN), 0.95 + r() * 0.1).kind(KIND.lawn).rect(gx0, gz0, gx1, gz1, Y_PATCH);
      const [fx0, fz0, fx1, fz1] = fl(f, s - 0.008, s + 0.008, setback + depth, gardenEnd);
      if (!first) c.hi.c(WOOD).box(fx0, 0, fz0, fx1, 0.1, fz1);
      if (r() < 0.45) {
        const [tx0, tz0, tx1, tz1] = fl(f, s + w / 2, s + w / 2, setback + depth + 0.45, setback + depth + 0.45);
        tree(c, (tx0 + tx1) / 2, (tz0 + tz1) / 2, 0.75 + r() * 0.25, r, r() < 0.15);
      } else if (r() < 0.25) {
        const [sx0, sz0, sx1, sz1] = fl(f, s + 0.1, s + 0.3, setback + depth + 0.5, setback + depth + 0.68);
        c.hi.c(WOOD).box(sx0, 0, sz0, sx1, 0.16, sz1, "#6b5a4a");
      }
      s += w;
      first = false;
    }
  }
}

/** Detached houses with gardens, one per quarter of the block (or fewer at the town edge). */
function villas(b: Blk, edge: boolean) {
  const { r } = b;
  b.G.c(pick(r, LAWN)).kind(KIND.lawn).rect(b.x0, b.z0, b.x1, b.z1, Y_BASE);
  const mx = (b.x0 + b.x1) / 2, mz = (b.z0 + b.z1) / 2;
  const lots: [number, number, number, number, Side[]][] = [
    [b.x0, b.z0, mx, mz, ["n", "w"]],
    [mx, b.z0, b.x1, mz, ["n", "e"]],
    [b.x0, mz, mx, b.z1, ["s", "w"]],
    [mx, mz, b.x1, b.z1, ["s", "e"]],
  ];
  for (const [x0, z0, x1, z1, outer] of lots) {
    const fronts = outer.filter((s) => b.st[s]);
    if (!fronts.length) {
      backLot(b, x0, z0, x1, z1, edge);
      continue;
    }
    villa(b, x0, z0, x1, z1, fronts[Math.floor(r() * fronts.length)]);
  }
}

function villa(b: Blk, x0: number, z0: number, x1: number, z1: number, front: Side) {
  const { r, c } = b;
  const f = faceOf(x0, z0, x1, z1, front);
  const depthMax = front === "n" || front === "s" ? z1 - z0 : x1 - x0;
  b.G.c(pick(r, LAWN), 0.96 + r() * 0.1).kind(KIND.lawn).rect(x0 + 0.02, z0 + 0.02, x1 - 0.02, z1 - 0.02, Y_PATCH);
  const hw = 0.75 + r() * 0.3, hd = 0.6 + r() * 0.22;
  const setback = 0.26 + r() * 0.16;
  const driveLeft = r() < 0.5;
  const s0 = driveLeft ? f.L - hw - 0.12 : 0.12;
  const [hx0, hz0, hx1, hz1] = fl(f, s0, s0 + hw, setback, setback + hd);
  const floors = r() < 0.7 ? 2 : 1;
  const wall = r() < 0.25 ? pick(r, BRICK) : pick(r, r() < 0.5 ? PASTEL : PLASTER);
  const roofColor = pick(r, ROOF);
  const alongX = front === "n" || front === "s";
  const roof: Vol["roof"] = r() < 0.55 ? "gable" : "hip";
  const h = volume(c, { x0: hx0, z0: hz0, x1: hx1, z1: hz1, floors, wall, kind: KIND.house, colW: 0.3, seed: r() * 97, roof, roofColor, alongX }, r);
  door(c.hi, faceOf(hx0, hz0, hx1, hz1, front), hw * (0.35 + r() * 0.3));
  if (r() < 0.6) {
    const cx = lerp(hx0 + 0.12, hx1 - 0.12, r()), cz = lerp(hz0 + 0.12, hz1 - 0.12, r());
    c.hi.c("#8a5a48").box(cx - 0.035, h, cz - 0.035, cx + 0.035, h + 0.36, cz + 0.035);
  }
  // wing out the back
  if (r() < 0.4) {
    const ws = driveLeft ? s0 + hw * 0.45 : s0;
    const [wx0, wz0, wx1, wz1] = fl(f, ws, ws + hw * 0.55, setback + hd, setback + hd + 0.32);
    volume(c, { x0: wx0, z0: wz0, x1: wx1, z1: wz1, floors: 1, wall, kind: KIND.house, colW: 0.3, seed: r() * 97, roof: "gable", roofColor, alongX: !alongX }, r);
  }
  // driveway, garage or car
  const ds = driveLeft ? 0.06 : f.L - 0.34;
  b.G.c("#b9b2a2").kind(KIND.pavers, 0.11).rect(...fl(f, ds, ds + 0.26, 0, setback + 0.42), Y_FINE);
  if (r() < 0.3) {
    const [gx0, gz0, gx1, gz1] = fl(f, ds - 0.02, ds + 0.28, setback + 0.05, setback + 0.42);
    c.F.c(wall, 0.95).box(gx0, 0, gz0, gx1, 0.26, gz1, "#8d8a84");
  }
  if (r() < 0.6) {
    const [cx0, cz0, cx1, cz1] = fl(f, ds + 0.13, ds + 0.13, 0.2, 0.2);
    pcar(c.hi, (cx0 + cx1) / 2, (cz0 + cz1) / 2, !alongX, pick(r, CAR));
  }
  // hedge along the front
  if (r() < 0.55) {
    const hs0 = driveLeft ? 0.34 : 0.02, hs1 = driveLeft ? f.L - 0.02 : f.L - 0.36;
    c.hi.c(HEDGE).box(...boxArgs(fl(f, hs0, hs1, 0.02, 0.08), 0, 0.09));
  }
  // back garden: trees, pool, fence
  const back = setback + hd + 0.35;
  if (r() < 0.16 && depthMax - back > 0.35) {
    const [px0, pz0, px1, pz1] = fl(f, f.L * 0.3, f.L * 0.3 + 0.42, back, back + 0.26);
    b.G.c("#e9e6df").rect(px0 - 0.03, pz0 - 0.03, px1 + 0.03, pz1 + 0.03, Y_FINE);
    b.G.c(POOL).kind(KIND.water).rect(px0, pz0, px1, pz1, Y_FINE + 0.002);
  }
  const nt = 1 + Math.floor(r() * 2.6);
  for (let i = 0; i < nt; i++) {
    const s = lerp(0.2, f.L - 0.2, r()), t = lerp(Math.min(back, depthMax - 0.2), depthMax - 0.18, r());
    const [tx0, tz0, tx1, tz1] = fl(f, s, s, t, t);
    tree(c, (tx0 + tx1) / 2, (tz0 + tz1) / 2, 0.8 + r() * 0.35, r, r() < 0.25, r() < 0.08);
  }
  if (r() < 0.4) c.hi.c(WOOD).box(...boxArgs(fl(f, 0.02, f.L - 0.02, depthMax - 0.03, depthMax - 0.01), 0, 0.1));
}

function boxArgs(a: [number, number, number, number], y0: number, y1: number): [number, number, number, number, number, number] {
  return [a[0], y0, a[1], a[2], y1, a[3]];
}

/** Lots with no street frontage: orchards, kitchen gardens, a barn or greenhouse, or open meadow. */
function backLot(b: Blk, x0: number, z0: number, x1: number, z1: number, edge: boolean) {
  const { r, c } = b;
  const p = r();
  if (p < 0.3) {
    b.G.c("#7d9a52").rect(x0, z0, x1, z1, Y_PATCH);
    for (let ix = 0; ix < 3; ix++) for (let iz = 0; iz < 3; iz++) tree(c, lerp(x0 + 0.3, x1 - 0.3, ix / 2), lerp(z0 + 0.3, z1 - 0.3, iz / 2), 0.62 + r() * 0.15, r, false, r() < 0.2);
  } else if (p < 0.5) {
    for (let i = 0; i < 5; i++) {
      const zz = lerp(z0 + 0.15, z1 - 0.15, i / 5);
      b.G.c(i % 2 ? "#7a5a3a" : "#5f8a3e").rect(x0 + 0.15, zz, x1 - 0.15, zz + (z1 - z0 - 0.3) / 5 - 0.04, Y_PATCH);
    }
  } else if (p < 0.65) {
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    if (edge && r() < 0.6) {
      c.F.c("#9b3b2e").box(cx - 0.55, 0, cz - 0.35, cx + 0.55, 0.55, cz + 0.35, null);
      c.F.gable(cx - 0.55, cz - 0.35, cx + 0.55, cz + 0.35, 0.55, 0.38, true, "#5c5f63", "#9b3b2e", 0.06);
      c.F.c("#c9c6be").cyl(cx + 0.75, cz, 0.16, 0.16, 0, 0.9, 8);
      c.F.c("#7d858c").tpl(templates().cone, cx + 0.75, 0.9, cz, 0.17, 0.16, 0.17);
    } else {
      c.F.c("#d6e6e2").box(cx - 0.45, 0, cz - 0.2, cx + 0.45, 0.22, cz + 0.2, null);
      c.F.gable(cx - 0.45, cz - 0.2, cx + 0.45, cz + 0.2, 0.22, 0.14, true, "#e3efec", "#d6e6e2", 0.01);
    }
  } else {
    b.G.c(pick(r, LAWN), 1.04).rect(x0, z0, x1, z1, Y_PATCH);
    if (r() < 0.5) tree(c, lerp(x0 + 0.3, x1 - 0.3, r()), lerp(z0 + 0.3, z1 - 0.3, r()), 1 + r() * 0.3, r);
  }
}

/** Parks: mown lawns, crossing paths, a pond, a bandstand, lots of trees. */
function park(b: Blk, big: boolean) {
  const { r, c } = b;
  const { x0, z0, x1, z1 } = b;
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  b.G.c("#6fa04e").kind(KIND.lawn).rect(x0, z0, x1, z1, Y_BASE);
  const pw = big ? 0.16 : 0.11;
  const path = "#d8c9a5";
  b.G.c(path).rect(cx - pw, z0, cx + pw, z1, Y_PATCH);
  b.G.c(path).rect(x0, cz - pw, x1, cz + pw, Y_PATCH);
  const ring = Math.min(x1 - x0, z1 - z0) * 0.32;
  if (big) {
    for (const [a, bb, cc, d] of [[cx - ring, cz - ring - pw, cx + ring, cz - ring + pw], [cx - ring, cz + ring - pw, cx + ring, cz + ring + pw], [cx - ring - pw, cz - ring, cx - ring + pw, cz + ring], [cx + ring - pw, cz - ring, cx + ring + pw, cz + ring]]) b.G.c(path).rect(a, bb, cc, d, Y_PATCH + 0.001);
    // bandstand at the crossing
    b.G.c(path).poly(circle(cx, cz, 0.55, 12, Y_PATCH + 0.002), 0, 1, 0);
    c.F.c("#e9e4d8").cyl(cx, cz, 0.36, 0.36, 0, 0.08, 8);
    for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; c.hi.c("#f2efe8").cyl(cx + Math.cos(a) * 0.3, cz + Math.sin(a) * 0.3, 0.018, 0.018, 0.08, 0.4, 4, false); }
    c.F.c("#3f6f63").tpl(templates().cone, cx, 0.4, cz, 0.44, 0.26, 0.44);
    // lake in one quadrant
    const lr = Math.min(0.9, ring * 0.36);
    lake(b, cx + (r() < 0.5 ? -1 : 1) * ring * 0.5, cz - ring * 0.5, lr);
  } else if (r() < 0.6) {
    lake(b, lerp(x0 + 0.9, cx - 0.4, r()), lerp(cz + 0.6, z1 - 0.8, r()), 0.5);
  }
  const n = big ? 70 : 16;
  for (let i = 0; i < n; i++) {
    const x = lerp(x0 + 0.2, x1 - 0.2, r()), z = lerp(z0 + 0.2, z1 - 0.2, r());
    if (Math.abs(x - cx) < pw + 0.15 || Math.abs(z - cz) < pw + 0.15) continue;
    if (big && Math.abs(Math.max(Math.abs(x - cx), Math.abs(z - cz)) - ring) < pw + 0.15) continue;
    if (big && Math.hypot(x - cx, z - cz) < 0.7) continue;
    if (lakeHit(x, z)) continue;
    tree(c, x, z, 0.85 + r() * 0.5, r, r() < 0.2, r() < 0.12);
  }
  for (let i = 0; i < (big ? 10 : 4); i++) {
    const along = r() < 0.5;
    const t = lerp(0.3, 0.9, r()) * (r() < 0.5 ? -1 : 1);
    if (along) bench(c.hi, cx + t * (x1 - cx), cz + pw + 0.08, true);
    else bench(c.hi, cx + pw + 0.08, cz + t * (z1 - cz), false);
  }
}

let lakes: [number, number, number][] = [];
function lakeHit(x: number, z: number): boolean {
  for (const [lx, lz, lr] of lakes) if (Math.hypot(x - lx, z - lz) < lr + 0.25) return true;
  return false;
}
function circle(cx: number, cz: number, rad: number, seg: number, y: number, wob = 0, seed = 0): number[] {
  const p: number[] = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const rr = rad * (1 + wob * (hash2(i, seed, 41) - 0.5));
    p.push(cx + Math.cos(a) * rr, y, cz + Math.sin(a) * rr);
  }
  return p;
}
function lake(b: Blk, x: number, z: number, rad: number) {
  lakes.push([x, z, rad]);
  b.G.c("#cdbf98").poly(circle(x, z, rad + 0.08, 14, Y_PATCH + 0.001, 0.25, b.seed), 0, 1, 0);
  b.G.c(POND).kind(KIND.water).poly(circle(x, z, rad, 14, Y_FINE, 0.25, b.seed), 0, 1, 0);
}

/** Paved square with a fountain or an obelisk, planters, café umbrellas and flower beds. */
function plaza(b: Blk, fountain: boolean) {
  const { r, c } = b;
  const { x0, z0, x1, z1 } = b;
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  b.G.c(PAVE_WARM).kind(KIND.pavers, 0.2).rect(x0, z0, x1, z1, Y_BASE);
  b.G.c("#cdb894").poly(circle(cx, cz, 1.25, 20, Y_PATCH), 0, 1, 0);
  if (fountain) {
    c.F.c("#d9d2c2").cyl(cx, cz, 0.78, 0.78, 0, 0.12, 16);
    c.F.c("#58a9c4").kind(KIND.water).poly(circle(cx, cz, 0.7, 16, 0.125), 0, 1, 0);
    c.F.c("#d9d2c2").cyl(cx, cz, 0.1, 0.08, 0.12, 0.5, 8);
    c.F.c("#d9d2c2").cyl(cx, cz, 0.18, 0.34, 0.5, 0.58, 10);
    c.F.c("#7cc3dc").kind(KIND.water).poly(circle(cx, cz, 0.31, 10, 0.585), 0, 1, 0);
    c.F.c("#d9d2c2").cyl(cx, cz, 0.05, 0.04, 0.58, 0.8, 6);
    c.hi.c("#e6f6ff").tpl(templates().cone, cx, 0.8, cz, 0.06, 0.28, 0.06);
    c.hi.c("#e6f6ff").cyl(cx, cz, 0.36, 0.5, 0.13, 0.2, 10, false);
  } else {
    c.F.c("#cfc6b2").box(cx - 0.42, 0, cz - 0.42, cx + 0.42, 0.12, cz + 0.42);
    c.F.c("#bfb5a0").box(cx - 0.26, 0.12, cz - 0.26, cx + 0.26, 0.42, cz + 0.26);
    c.F.c("#d7cfbf").cyl(cx, cz, 0.15, 0.08, 0.42, 2.6, 4, false, Math.PI / 4);
    c.F.c("#d7cfbf").tpl(templates().cone4, cx, 2.6, cz, 0.08, 0.2, 0.08, 0);
    c.hi.c("#b08a3c").box(cx - 0.12, 0.42, cz - 0.27, cx + 0.12, 0.6, cz - 0.26);
  }
  // flower beds at the corners of the circle, planters with trees on the outer ring
  const beds = ["#c74a5a", "#e2b33c", "#b65dad", "#e07a3c"];
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2;
    const bx = cx + Math.cos(a) * 1.0, bz = cz + Math.sin(a) * 1.0;
    c.F.c("#9b8f7a").box(bx - 0.2, 0, bz - 0.2, bx + 0.2, 0.06, bz + 0.2, beds[i]);
  }
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    for (const [px, pz] of [[cx + sx * 1.55, cz + sz * 1.55], [cx + sx * 0.75, cz + sz * 1.6]]) {
      c.hi.c("#a89f8c").box(px - 0.1, 0, pz - 0.1, px + 0.1, 0.07, pz + 0.1);
      tree(c, px, pz, 0.85, r);
    }
  }
  for (let i = 0; i < 6; i++) {
    const a = r() * Math.PI * 2;
    const ux = cx + Math.cos(a) * 1.45, uz = cz + Math.sin(a) * 1.45;
    if (Math.abs(ux - cx) > 1.5 || Math.abs(uz - cz) > 1.5) continue;
    c.hi.c("#5a5f66").cyl(ux, uz, 0.008, 0.008, 0, 0.26, 4, false);
    c.hi.c(pick(r, AWNING)).tpl(templates().cone, ux, 0.22, uz, 0.16, 0.08, 0.16, r());
  }
  for (const s of SIDES) {
    const f = faceOf(x0, z0, x1, z1, s);
    for (const t of [0.25, 0.75]) {
      const [lx, lz] = fl(f, f.L * t, f.L * t, 0.12, 0.12);
      lamp(c.hi, lx, lz, -f.nx, -f.nz);
    }
  }
}

/** Church with a clock tower and spire on a small square. */
function church(b: Blk) {
  const { r, c } = b;
  const { x0, z0, x1, z1 } = b;
  b.G.c(PAVE_WARM).kind(KIND.pavers, 0.2).rect(x0, z0, x1, z1, Y_BASE);
  b.G.c(pick(r, LAWN)).kind(KIND.lawn).rect(x0 + 0.2, z0 + 0.2, x1 - 0.2, (z0 + z1) / 2 - 0.5, Y_PATCH);
  const stone = "#d6ccb6";
  const nx0 = x0 + 1.1, nx1 = x1 - 0.5, nz0 = (z0 + z1) / 2 - 0.5, nz1 = nz0 + 1.05;
  const h = 1.25;
  c.F.c(stone).kind(KIND.church, 0.95, 0.42, 3).walls(nx0, nz0, nx1, nz1, 0, h, 0, h);
  c.F.gable(nx0, nz0, nx1, nz1, h, 0.75, true, "#56606b", stone, 0.06);
  // apse
  c.F.c(stone).cyl(nx1, (nz0 + nz1) / 2, 0.45, 0.45, 0, h * 0.85, 10, false);
  c.F.c("#56606b").tpl(templates().cone, nx1, h * 0.85, (nz0 + nz1) / 2, 0.5, 0.5, 0.5);
  // tower with clock faces, belfry and spire
  const tx0 = nx0 - 0.62, tx1 = nx0 + 0.02, tz0 = (nz0 + nz1) / 2 - 0.32, tz1 = tz0 + 0.64;
  const th = 3.0;
  c.F.c(stone).kind(KIND.church, 0.8, 0.3, 5).walls(tx0, tz0, tx1, tz1, 0, th, 0, th);
  c.F.c("#bfb49c").box(tx0 - 0.04, th, tz0 - 0.04, tx1 + 0.04, th + 0.08, tz1 + 0.04);
  c.F.hip(tx0 + 0.02, tz0 + 0.02, tx1 - 0.02, tz1 - 0.02, th + 0.08, 1.9, "#5f8f7f", 0);
  c.hi.c("#c9a64a").cyl((tx0 + tx1) / 2, (tz0 + tz1) / 2, 0.012, 0.012, th + 1.95, th + 2.25, 4, false);
  for (const s of SIDES) {
    const f = faceOf(tx0, tz0, tx1, tz1, s);
    const [a0, b0, a1, b1] = fl(f, f.L / 2 - 0.16, f.L / 2 + 0.16, -0.02, 0);
    c.hi.c("#f3eee0").kind(KIND.glow, 0.9).box(a0, th - 0.62, b0, a1, th - 0.3, b1, null);
    const [h0, k0, h1, k1] = fl(f, f.L / 2 - 0.015, f.L / 2 + 0.015, -0.03, -0.02);
    c.hi.c("#2a2a2a").box(h0, th - 0.47, k0, h1, th - 0.34, k1, null);
  }
  door(c.hi, faceOf(tx0, tz0, tx1, tz1, "w"), 0.32, "#4a2f22");
  for (let i = 0; i < 6; i++) tree(c, lerp(x0 + 0.3, x1 - 0.3, r()), lerp(z0 + 0.3, nz0 - 0.4, r()), 0.9 + r() * 0.3, r, r() < 0.4);
  for (let i = 0; i < 4; i++) bench(c.hi, lerp(x0 + 0.4, x1 - 0.4, i / 3), nz1 + 0.35, true);
}

/** Sports ground: track, pitch with markings, a small stand. */
function pitch(b: Blk) {
  const { c, r } = b;
  const { x0, z0, x1, z1 } = b;
  b.G.c(pick(r, LAWN)).rect(x0, z0, x1, z1, Y_BASE);
  b.G.c("#b5553c").rect(x0 + 0.15, z0 + 0.3, x1 - 0.15, z1 - 0.3, Y_PATCH);
  b.G.c("#5f9c45").kind(KIND.pitch).rect(x0 + 0.4, z0 + 0.55, x1 - 0.4, z1 - 0.55, Y_FINE);
  c.F.c("#c9c6be").box(x0 + 0.6, 0, z0 + 0.02, x1 - 0.6, 0.18, z0 + 0.26, "#9aa2aa");
  c.hi.c("#2f6fa3").poly([x0 + 0.6, 0.18, z0 + 0.26, x1 - 0.6, 0.18, z0 + 0.26, x1 - 0.6, 0.36, z0 + 0.04, x0 + 0.6, 0.36, z0 + 0.04], 0, 1, 1);
  for (const [px, pz] of [[x0 + 0.1, z0 + 0.1], [x1 - 0.1, z0 + 0.1], [x0 + 0.1, z1 - 0.1], [x1 - 0.1, z1 - 0.1]]) {
    c.hi.c(C.lampPost).cyl(px, pz, 0.02, 0.014, 0, 1.4, 4, false);
    c.hi.c("#fff6dc").kind(KIND.glow).box(px - 0.07, 1.38, pz - 0.03, px + 0.07, 1.48, pz + 0.03);
  }
}

/** Harbour warehouses: long sheds with sawtooth or gable roofs, a yard with containers and trucks. */
function warehouses(b: Blk) {
  const { r, c } = b;
  const { x0, z0, x1, z1 } = b;
  b.G.c("#8f8c86").kind(KIND.pavers, 0.4).rect(x0, z0, x1, z1, Y_BASE);
  const two = r() < 0.6;
  const sheds: [number, number, number, number][] = two
    ? [[x0 + 0.1, z0 + 0.1, x1 - 0.1, z0 + 1.55], [x0 + 0.1, z1 - 1.5, x1 - 1.3, z1 - 0.15]]
    : [[x0 + 0.1, z0 + 0.1, x1 - 0.1, z0 + 2.1]];
  for (const [a, bb, cc, d] of sheds) {
    const h = 0.85 + r() * 0.45;
    const wall = pick(r, SHED_WALL);
    c.F.c(wall).kind(KIND.shed, h * 0.5, 0.42, r() * 97).walls(a, bb, cc, d, 0, h, 0, h);
    const roof = r();
    if (roof < 0.4) {
      const n = Math.max(2, Math.round((cc - a) / 0.6));
      const w = (cc - a) / n;
      for (let i = 0; i < n; i++) {
        const sx = a + i * w;
        c.F.c("#8d9196").poly([sx, h, bb, sx, h, d, sx + w, h + 0.3, d, sx + w, h + 0.3, bb], -0.5, 1, 0);
        c.F.c("#9fb4c0").poly([sx + w, h, bb, sx + w, h, d, sx + w, h + 0.3, d, sx + w, h + 0.3, bb], 1, 0, 0);
        c.F.c(wall).poly([sx, h, bb, sx + w, h, bb, sx + w, h + 0.3, bb], 0, 0, -1);
        c.F.c(wall).poly([sx, h, d, sx + w, h, d, sx + w, h + 0.3, d], 0, 0, 1);
      }
    } else if (roof < 0.75) {
      c.F.gable(a, bb, cc, d, h, 0.28, true, pick(r, ["#7b858d", "#8c6a52", "#646c76"]), wall, 0.04);
    } else {
      c.F.c("#9c9a94").rect(a, bb, cc, d, h);
      rooftop(c.hi, a, bb, cc, d, h, r);
    }
    const f = faceOf(a, bb, cc, d, d < z1 - 0.5 ? "s" : "n");
    for (let s = 0.3; s < f.L - 0.3; s += 0.7) {
      const [dx0, dz0, dx1, dz1] = fl(f, s, s + 0.4, -0.12, 0);
      c.hi.c("#6b6e72").box(dx0, 0, dz0, dx1, 0.12, dz1);
    }
  }
  // yard: container stacks and a truck
  const yz0 = two ? z0 + 1.7 : z0 + 2.25, yz1 = two ? z1 - 1.6 : z1 - 0.15;
  if (yz1 - yz0 > 0.3) {
    for (let x = x0 + 0.2; x < x1 - 0.6; x += 0.56) {
      const n = 1 + Math.floor(r() * 3);
      for (let k = 0; k < n; k++) c.F.c(pick(r, CONTAINER)).box(x, k * 0.2, yz0 + 0.02, x + 0.5, k * 0.2 + 0.19, yz0 + 0.22);
    }
  }
  if (two) for (let i = 0; i < 2; i++) pcar(c.hi, x1 - 0.7 + i * 0.3, z1 - 0.9, false, pick(r, CONTAINER));
}

/** School: an L of brick classrooms around a playground with court markings. */
function school(b: Blk) {
  const { r, c } = b;
  const { x0, z0, x1, z1 } = b;
  b.G.c(pick(r, LAWN)).kind(KIND.lawn).rect(x0, z0, x1, z1, Y_BASE);
  const wall = pick(r, ["#b86b4a", "#c27c5a", "#d9bf98", "#e3c9a0"]);
  const roofColor = pick(r, ROOF);
  const floors = 2 + (r() < 0.5 ? 1 : 0);
  const north = b.st.n || !b.st.s;
  const rz0 = north ? z0 + 0.15 : z1 - 1.0, rz1 = rz0 + 0.85;
  const h = volume(c, { x0: x0 + 0.15, z0: rz0, x1: x1 - 0.15, z1: rz1, floors, wall, kind: KIND.apartment, colW: 0.42, seed: r() * 97, roof: "hip", roofColor }, r);
  const wz0 = north ? rz1 : z0 + 0.3, wz1 = north ? z1 - 0.3 : rz0;
  volume(c, { x0: x0 + 0.15, z0: wz0, x1: x0 + 0.95, z1: wz1, floors: floors - 1, wall, kind: KIND.apartment, colW: 0.42, seed: r() * 97, roof: "hip", roofColor, blank: north ? BIT.n : BIT.s }, r);
  c.hi.c("#e9e4d8").cyl(x1 - 0.4, (rz0 + rz1) / 2, 0.02, 0.02, h, h + 0.5, 4, false);
  c.hi.c(pick(r, ["#2f6fa3", "#c0392b", "#2e7d5b"])).box(x1 - 0.48, h + 0.32, (rz0 + rz1) / 2 - 0.08, x1 - 0.32, h + 0.48, (rz0 + rz1) / 2 + 0.08);
  const yz0 = north ? rz1 + 0.2 : z0 + 0.25, yz1 = north ? z1 - 0.25 : rz0 - 0.2;
  if (yz1 - yz0 > 0.8) {
    b.G.c("#9a948a").rect(x0 + 1.1, yz0, x1 - 0.2, yz1, Y_PATCH);
    b.G.c("#3f7f8a").kind(KIND.pitch).rect(x0 + 1.25, yz0 + 0.12, x1 - 0.35, yz1 - 0.12, Y_FINE);
  }
  for (let i = 0; i < 4; i++) tree(c, lerp(x0 + 0.3, x1 - 0.3, r()), north ? z1 - 0.12 : z0 + 0.12, 0.85, r);
}

/** Market hall / supermarket: a big low box with a lit sign, its car park and a few trees. */
function hall(b: Blk) {
  const { r, c } = b;
  const { x0, z0, x1, z1 } = b;
  b.G.c(PAVE_COOL).kind(KIND.pavers, 0.3).rect(x0, z0, x1, z1, Y_BASE);
  const west = r() < 0.5;
  const hx0 = west ? x0 + 0.15 : x0 + 1.55, hx1 = west ? x1 - 1.55 : x1 - 0.15;
  const wall = pick(r, ["#d2cfc6", "#c9c6be", "#e0d6c2", "#b6b8b6"]);
  const h = volume(c, { x0: hx0, z0: z0 + 0.2, x1: hx1, z1: z1 - 0.2, floors: 2, wall, kind: KIND.shop, colW: 0.55, seed: r() * 97, roof: "flat", roofColor: pick(r, FLAT_ROOF) }, r);
  const front = b.st.s ? "s" : "n";
  const f = faceOf(hx0, z0 + 0.2, hx1, z1 - 0.2, front);
  awning(c.hi, f, 0.1, f.L - 0.1, pick(r, AWNING), 0.4);
  const [sx0, sz0, sx1, sz1] = fl(f, f.L / 2 - 0.4, f.L / 2 + 0.4, -0.03, 0);
  c.F.c(pick(r, ["#e04a3a", "#2f8f5b", "#2f6fa3", "#e0a03a"])).kind(KIND.glow, 1.4).box(sx0, h - 0.18, sz0, sx1, h - 0.04, sz1, null);
  const px0 = west ? hx1 + 0.12 : x0 + 0.12, px1 = west ? x1 - 0.12 : hx0 - 0.12;
  b.G.c("#5b5650").kind(KIND.parking).rect(px0, z0 + 0.15, px1, z1 - 0.15, Y_PATCH, true);
  for (let z = z0 + 0.3; z < z1 - 0.3; z += 0.24) {
    if (r() < 0.3) pcar(c.hi, px0 + 0.22, z, true, pick(r, CAR));
    if (r() < 0.3) pcar(c.hi, px1 - 0.22, z, true, pick(r, CAR));
  }
  for (let z = z0 + 0.5; z < z1 - 0.3; z += 1.1) tree(c, (px0 + px1) / 2, z, 0.8, r);
}

/* ───────────────────────── harbour row ───────────────────────── */

function boat(c: Chunk, x: number, z: number, len: number, wid: number, alongZ: boolean, hull: string, sail: boolean, r: Rng) {
  const F = c.F;
  const top = SEA_Y + 0.12, bot = SEA_Y - 0.02;
  const h = len / 2, w = wid / 2;
  // pentagon deck: square stern, pointed bow (toward +x local)
  const local = [[-h, -w], [h * 0.45, -w], [h, 0], [h * 0.45, w], [-h, w]];
  const P = (lx: number, lz: number, y: number): [number, number, number] => alongZ ? [x - lz, y, z + lx] : [x + lx, y, z + lz];
  const deck: number[] = [];
  for (const [lx, lz] of local) deck.push(...P(lx, lz, top));
  F.c("#e9e4d8").poly(deck, 0, 1, 0);
  for (let i = 0; i < 5; i++) {
    const [ax, az] = local[i], [bx, bz] = local[(i + 1) % 5];
    const a = P(ax, az, 0), b = P(bx, bz, 0);
    // local outline is clockwise from above; wall() wants outward on the right of a→b
    F.c(hull).wall(a[0], a[2], b[0], b[2], bot, top);
  }
  const cab = P(-h * 0.2, 0, 0);
  const cl = len * 0.18, cw = w * 0.6;
  const [cx0, cz0, cx1, cz1] = alongZ ? [cab[0] - cw, cab[2] - cl, cab[0] + cw, cab[2] + cl] : [cab[0] - cl, cab[2] - cw, cab[0] + cl, cab[2] + cw];
  F.c("#f2efe8").kind(KIND.apartment, 0.12, 0.12, r() * 50).box(cx0, top, cz0, cx1, top + 0.1, cz1, "#d9d4c8");
  if (sail) {
    const m = P(h * 0.15, 0, 0);
    c.hi.c("#d9d4c8").cyl(m[0], m[2], 0.012, 0.008, top, top + len * 1.1, 4, false);
    const s0 = P(h * 0.13, 0, top + 0.08), s1 = P(-h * 0.7, 0, top + 0.08), s2 = P(h * 0.13, 0, top + len * 1.05);
    F.c("#f6f3ea").poly([...s0, ...s1, ...s2], alongZ ? 1 : 0, 0.1, alongZ ? 0 : 1);
    F.c("#f6f3ea").poly([...s0, ...s2, ...s1], alongZ ? -1 : 0, 0.1, alongZ ? 0 : -1);
  }
}

function quayRow(b: Blk, W: number, shoreZ: number, pierX: number) {
  const { r, c, i0 } = b;
  const { x0, z0, x1 } = b;
  const z1 = shoreZ;
  const mid = W / 2;
  const isPier = i0 === mid - 2 || i0 === mid;
  const isPort = i0 >= mid + 6;
  const isMarina = i0 <= mid - 8;
  // quay cap stones along the water
  b.G.c(QUAY_CAP).box(x0, 0, z1 - 0.12, x1, 0.05, z1);
  if (isPort) {
    b.G.c("#8f8c86").kind(KIND.pavers, 0.45).rect(x0, z0, x1, z1 - 0.12, Y_BASE);
    // container stacks inland, gantry crane at the edge
    for (let row = 0; row < 3; row++) {
      const zz = z0 + 0.35 + row * 0.42;
      for (let x = x0 + 0.15; x < x1 - 0.55; x += 0.54) {
        if (r() < 0.15) continue;
        const n = 1 + Math.floor(r() * 4);
        for (let k = 0; k < n; k++) c.F.c(pick(r, CONTAINER)).box(x, k * 0.2, zz, x + 0.5, k * 0.2 + 0.19, zz + 0.2, k === n - 1 ? undefined : null);
      }
    }
    const crane = i0 % 4 === 0;
    if (crane) {
      const cxm = (x0 + x1) / 2;
      const col = (i0 / 4) % 2 ? "#d9a43a" : "#c94b3a";
      for (const dx of [-0.55, 0.55]) {
        for (const zz of [z1 - 0.2, z1 - 1.4]) c.F.c(col).box(cxm + dx - 0.05, 0, zz - 0.05, cxm + dx + 0.05, 2.1, zz + 0.05);
        c.F.c(col).box(cxm + dx - 0.05, 1.0, z1 - 1.4, cxm + dx + 0.05, 1.08, z1 - 0.2);
      }
      c.F.c(col).box(cxm - 0.62, 2.1, z1 - 2.2, cxm + 0.62, 2.28, z1 + 2.4);
      c.F.c("#e9e4d8").kind(KIND.apartment, 0.2, 0.15, 7).box(cxm - 0.2, 1.88, z1 + 0.3, cxm + 0.2, 2.1, z1 + 0.6, "#e9e4d8");
      c.F.c("#5a5f66").box(cxm - 0.3, 2.28, z1 - 2.2, cxm + 0.3, 2.5, z1 - 1.6, "#5a5f66");
      c.hi.c("#ff5a4a").kind(KIND.glow).box(cxm - 0.03, 2.28, z1 + 2.3, cxm + 0.03, 2.33, z1 + 2.36);
    }
    for (let x = x0 + 0.3; x < x1; x += 0.9) c.hi.c("#3b3d40").cyl(x, z1 - 0.06, 0.03, 0.025, 0.05, 0.11, 6);
    return;
  }
  b.G.c(PAVE_WARM).kind(KIND.pavers, 0.2).rect(x0, z0, x1, z1 - 0.12, Y_BASE);
  // promenade: double row of trees, lamps along the water, benches facing the sea
  b.G.c(pick(r, LAWN)).kind(KIND.lawn).rect(x0, z0 + 0.35, x1, z0 + 0.95, Y_PATCH);
  for (let x = x0 + 0.35; x < x1 - 0.1; x += 0.72) {
    tree(c, x, z0 + 0.65, 1 + r() * 0.2, r, false, r() < 0.06);
    if (r() < 0.5) tree(c, x + 0.36, z0 + 1.6, 0.9, r);
  }
  for (let x = x0 + 0.5; x < x1; x += 1.45) lamp(c.hi, x, z1 - 0.3, 0, 1);
  for (let x = x0 + 1.1; x < x1; x += 1.45) bench(c.hi, x, z1 - 0.42, true);
  for (let x = x0 + 0.2; x < x1; x += 0.7) c.hi.c("#3b3d40").cyl(x, z1 - 0.06, 0.03, 0.025, 0.05, 0.11, 6);
  for (let x = x0 + 0.85; x < x1 - 0.2; x += 1.45) tree(c, x, z1 - 0.85, 0.85 + r() * 0.15, r);
  if (!isPier) {
    const mx = lerp(x0 + 1.2, x1 - 1.2, r()), mz = (z0 + z1) / 2 + 0.15;
    const what = r();
    if (what < 0.45) {
      // café terrace: kiosk and umbrellas over tables
      c.F.c(pick(r, PASTEL)).kind(KIND.shop, 0.3, 0.2, r() * 50).box(mx - 0.22, 0, mz - 0.5, mx + 0.22, 0.32, mz - 0.18, "#a9a39a");
      awning(c.hi, faceOf(mx - 0.22, mz - 0.5, mx + 0.22, mz - 0.18, "s"), 0.02, 0.42, pick(r, AWNING), 0.3);
      const umb = pick(r, AWNING);
      for (let k = 0; k < 6; k++) {
        const ux = mx - 0.55 + (k % 3) * 0.55, uz = mz + 0.05 + Math.floor(k / 3) * 0.45;
        c.hi.c("#e9e4d8").cyl(ux, uz, 0.06, 0.06, 0.07, 0.085, 6);
        c.hi.c("#5a5f66").cyl(ux, uz, 0.008, 0.008, 0, 0.27, 4, false);
        c.hi.c(umb).tpl(templates().cone, ux, 0.22, uz, 0.17, 0.08, 0.17, k);
      }
    } else if (what < 0.75) {
      // flower parterre round a small basin
      b.G.c("#6fa04e").kind(KIND.lawn).rect(mx - 0.9, mz - 0.45, mx + 0.9, mz + 0.45, Y_PATCH);
      const beds = ["#c74a5a", "#e2b33c", "#b65dad", "#e07a3c", "#f0ece0"];
      for (let k = 0; k < 4; k++) c.F.c("#9b8f7a").box(mx - 0.8 + k * 0.45, 0, mz - 0.32, mx - 0.5 + k * 0.45, 0.05, mz - 0.12, pick(r, beds));
      c.F.c("#d9d2c2").cyl(mx, mz + 0.18, 0.24, 0.24, 0, 0.07, 12);
      c.F.c("#58a9c4").kind(KIND.water).poly(circle(mx, mz + 0.18, 0.2, 12, 0.072), 0, 1, 0);
    } else {
      // sculpture on a plinth with benches around
      c.F.c("#bfb5a0").box(mx - 0.16, 0, mz - 0.16, mx + 0.16, 0.18, mz + 0.16);
      c.F.c("#5f8f7f").tpl(templates().ico, mx, 0.42, mz, 0.16, 0.24, 0.12, r() * 3);
      for (const [dx, dz] of [[-0.45, 0], [0.45, 0]]) bench(c.hi, mx + dx, mz + dz, false);
    }
  }
  if (isPier && i0 === mid) {
    // pier out to a lighthouse on the map's centre line
    const px = pierX;
    const pz1 = z1 + 7;
    c.F.c(WOOD).box(px - 0.55, -0.06, z1 - 0.1, px + 0.55, 0.04, pz1, "#a48460");
    for (let z = z1 + 0.6; z < pz1; z += 0.9) for (const dx of [-0.5, 0.5]) c.hi.c("#5c4a38").cyl(px + dx, z, 0.04, 0.04, QUAY_FOOT, -0.06, 5, false);
    for (const dx of [-0.53, 0.53]) c.hi.c("#e9e4d8").box(px + dx - 0.012, 0.04, z1 + 0.2, px + dx + 0.012, 0.16, pz1 - 0.2);
    for (let z = z1 + 1.2; z < pz1 - 1; z += 1.6) lamp(c.hi, px + 0.45, z, -1, 0);
    c.F.c("#d9d2c2").cyl(px, pz1 - 0.2, 0.75, 0.75, -0.06, 0.12, 12);
    const lz = pz1 - 0.2;
    const bands = ["#f2efe8", "#c0392b", "#f2efe8", "#c0392b", "#f2efe8"];
    for (let i = 0; i < bands.length; i++) c.F.c(bands[i]).cyl(px, lz, 0.34 - i * 0.03, 0.34 - (i + 1) * 0.03, 0.12 + i * 0.5, 0.12 + (i + 1) * 0.5, 10, i === bands.length - 1);
    const lt = 0.12 + bands.length * 0.5;
    c.F.c("#3b3d40").cyl(px, lz, 0.28, 0.28, lt, lt + 0.05, 10);
    c.F.c("#fff1c0").kind(KIND.glow).cyl(px, lz, 0.15, 0.15, lt + 0.05, lt + 0.32, 8, false);
    c.F.c("#c0392b").tpl(templates().cone, px, lt + 0.32, lz, 0.22, 0.3, 0.22);
    boat(c, px + 1.3, z1 + 3.2, 1.0, 0.36, true, "#2f4a6a", false, r);
    boat(c, px - 1.4, z1 + 4.6, 0.8, 0.3, true, "#c0392b", true, r);
  }
  if (isMarina) {
    // pontoon with finger piers and moored boats
    const px = (x0 + x1) / 2;
    const len = 2.6;
    c.F.c("#a48460").box(px - 0.1, SEA_Y + 0.02, z1, px + 0.1, SEA_Y + 0.1, z1 + len, null);
    c.F.c("#a48460").rect(px - 0.1, z1, px + 0.1, z1 + len, SEA_Y + 0.1);
    for (let k = 0; k < 4; k++) {
      const zz = z1 + 0.5 + k * 0.6;
      for (const side of [-1, 1]) {
        c.F.c("#a48460").rect(side < 0 ? px - 0.6 : px + 0.1, zz - 0.04, side < 0 ? px - 0.1 : px + 0.6, zz + 0.04, SEA_Y + 0.1);
        if (r() < 0.75) {
          const sx = px + side * 0.36;
          boat(c, sx, zz + 0.27, 0.46 + r() * 0.2, 0.18, false, pick(r, ["#f2efe8", "#2f4a6a", "#c0392b", "#e9e4d8", "#3d7a54"]), r() < 0.6, r);
        }
      }
    }
  }
}

/** A long cargo ship moored along the container quay. */
function freighter(c: Chunk, xA: number, xB: number, shoreZ: number) {
  const F = c.F;
  const z0 = shoreZ + 0.7, z1 = shoreZ + 2.3, zc = (z0 + z1) / 2;
  const top = 0.35, bot = SEA_Y - 0.05;
  const bow = xA, stern = xB;
  // hull: box body with a pointed bow
  F.c("#2b2f36").wall(bow, zc, bow + 1.2, z0, bot, top);
  F.c("#2b2f36").wall(bow + 1.2, z0, stern, z0, bot, top);
  F.c("#2b2f36").wall(stern, z0, stern, z1, bot, top);
  F.c("#2b2f36").wall(stern, z1, bow + 1.2, z1, bot, top);
  F.c("#2b2f36").wall(bow + 1.2, z1, bow, zc, bot, top);
  F.c("#7a2e2a").wall(bow + 1.2, z0 - 0.003, stern, z0 - 0.003, bot, bot + 0.12);
  F.c("#7a2e2a").wall(stern, z1 + 0.003, bow + 1.2, z1 + 0.003, bot, bot + 0.12);
  F.c("#6b6e72").poly([stern, top, z0, bow + 1.2, top, z0, bow, top, zc, bow + 1.2, top, z1, stern, top, z1], 0, 1, 0);
  // containers on deck
  const r = rng(Math.round(xA), 7, 77);
  for (let x = bow + 1.4; x < stern - 2.2; x += 0.54) {
    for (let row = 0; row < 3; row++) {
      const n = 1 + Math.floor(r() * 3);
      for (let k = 0; k < n; k++) F.c(pick(r, CONTAINER)).box(x, top + k * 0.2, z0 + 0.15 + row * 0.44, x + 0.5, top + k * 0.2 + 0.19, z0 + 0.15 + row * 0.44 + 0.42, k === n - 1 ? undefined : null);
    }
  }
  // bridge superstructure at the stern
  F.c("#f2efe8").kind(KIND.apartment, 0.3, 0.26, 11).box(stern - 1.6, top, z0 + 0.1, stern - 0.4, top + 1.3, z1 - 0.1, "#d9d4c8");
  F.c("#f2efe8").box(stern - 1.75, top + 1.15, z0 - 0.05, stern - 1.3, top + 1.25, z1 + 0.05, "#d9d4c8");
  F.c("#c0392b").cyl(stern - 0.8, zc, 0.16, 0.16, top + 1.3, top + 1.8, 8);
  F.c("#2b2f36").cyl(stern - 0.8, zc, 0.165, 0.165, top + 1.8, top + 1.9, 8);
}

/* ───────────────────────── the town ───────────────────────── */

type Zone = "tower" | "office" | "apartment" | "slabs" | "highstreet" | "terrace" | "villa" | "edge" | "farm" | "park" | "bigpark" | "fountain" | "monument" | "church" | "pitch" | "warehouse" | "waterfront" | "quay" | "school" | "hall";

/** Weighted choice by a [0,1) hash; weights need not sum to 1 (the last entry absorbs the rest). */
function weighted<T>(h: number, table: [T, number][]): T {
  let acc = 0;
  for (const [v, w] of table) { acc += w; if (h < acc) return v; }
  return table[table.length - 1][0];
}

const cache = new Map<string, TownData>();

/** Deterministic town for a `width`×`height` map; cached per size. */
export function buildTown(W: number, H: number): TownData {
  const key = `${W}x${H}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const data = generate(W, H);
  cache.set(key, data);
  return data;
}

function generate(W: number, H: number): TownData {
  lakes = [];
  const RING = TOWN_RING;
  const I0 = -RING, I1 = W + RING, J0 = -RING, J1 = H + RING;
  const cxw = (i: number) => (i - W / 2) * TILE - TILE / 2;
  const czw = (j: number) => (j - H / 2) * TILE - TILE / 2;
  const BI = W / 2, BJ = H / 2;
  const blvdV = (i: number) => i === BI;
  const blvdH = (j: number) => j === BJ;
  const hwV = (i: number) => (blvdV(i) ? BHW : SHW);
  const hwH = (j: number) => (blvdH(j) ? BHW : SHW);
  const shoreZ = czw(J1);

  // big park spans 2×2 blocks: drop the streets inside it
  const parkI = W + 4, parkJ = 6;
  const removed: Record<string, true> = { [`v${parkI + 2},${parkJ}`]: true, [`v${parkI + 2},${parkJ + 2}`]: true, [`h${parkI},${parkJ + 2}`]: true, [`h${parkI + 2},${parkJ + 2}`]: true };
  /** vertical street segment (i, j)→(i, j+2) */
  const vPresent = (i: number, j: number): boolean => {
    if (i % 2 || j % 2) return false;
    if (i <= I0 || i >= I1 || j < J0 || j + 2 > J1) return false;
    if (i > 0 && i < W && j >= 0 && j + 2 <= H) return false;
    if (j + 2 === J1) return false;
    if (j === J0 && !blvdV(i)) return false;
    return !removed[`v${i},${j}`];
  };
  /** horizontal street segment (i, j)→(i+2, j) */
  const hPresent = (i: number, j: number): boolean => {
    if (i % 2 || j % 2) return false;
    if (j <= J0 || j >= J1 || i < I0 || i + 2 > I1) return false;
    if (j > 0 && j < H && i >= 0 && i + 2 <= W) return false;
    if ((i === I0 || i + 2 === I1) && !blvdH(j)) return false;
    return !removed[`h${i},${j}`];
  };

  const G = new GB();
  const chunks = new Map<number, Chunk>();
  const chunkAt = (x: number, z: number): Chunk => {
    const tx = Math.floor((x + TILE / 2) / TILE + W / 2), ty = Math.floor((z + TILE / 2) / TILE + H / 2);
    let ci = tx < 0 ? 0 : tx < W / 2 ? 1 : tx < W ? 2 : 3;
    let cj = ty < 0 ? 0 : ty < H / 2 ? 1 : ty < H ? 2 : 3;
    if ((ci === 1 || ci === 2) && (cj === 1 || cj === 2)) {
      const dx = Math.min(tx, W - 1 - tx), dy = Math.min(ty, H - 1 - ty);
      if (dy <= dx) cj = ty < H / 2 ? 0 : 3;
      else ci = tx < W / 2 ? 0 : 3;
    }
    const k = cj * 4 + ci;
    let c = chunks.get(k);
    if (!c) {
      const hi = new GB(), lo = new GB();
      c = { hi, lo, F: fan(hi, lo) };
      chunks.set(k, c);
    }
    return c;
  };

  /* streets */
  const ASPH = ROAD.asphaltColor;
  /** rect in street space: s along the street, t across from its axis */
  const rectST = (vert: boolean, axis: number, s0: number, s1: number, t0: number, t1: number, y: number) =>
    vert ? G.rect(axis + t0, s0, axis + t1, s1, y, true) : G.rect(s0, axis + t0, s1, axis + t1, y, false);
  const boxST = (g: GB, vert: boolean, axis: number, s0: number, s1: number, t0: number, t1: number, y0: number, y1: number, top?: string | null) =>
    vert ? g.box(axis + t0, y0, s0, axis + t1, y1, s1, top) : g.box(s0, y0, axis + t0, s1, y1, axis + t1, top);

  const edge = (vert: boolean, i: number, j: number) => {
    const axis = vert ? cxw(i) : czw(j);
    const blvd = vert ? blvdV(i) : blvdH(j);
    const s0 = vert ? czw(j) + hwH(j) : cxw(i) + hwV(i);
    const s1 = vert ? czw(j + 2) - hwH(j + 2) : cxw(i + 2) - hwV(i + 2);
    const a = blvd ? BA : SA, hw = blvd ? BHW : SHW;
    if (blvd) {
      G.c(ASPH).kind(KIND.asphalt, 0);
      rectST(vert, axis, s0, s1, -a, -BM, Y_ASPH);
      G.c(ASPH).kind(KIND.asphalt, 0);
      rectST(vert, axis, s0, s1, BM, a, Y_ASPH);
      G.c(ROAD.kerbColor);
      boxST(G, vert, axis, s0 + 0.25, s1 - 0.25, -BM, BM, 0.02, Y_KERB, "#6f9a4f");
      const c = chunkAt(vert ? axis : (s0 + s1) / 2, vert ? (s0 + s1) / 2 : axis);
      const r = rng(i, j, vert ? 61 : 62);
      for (let s = s0 + 0.55; s < s1 - 0.4; s += 0.8) tree(c, vert ? axis : s, vert ? s : axis, 0.95 + r() * 0.2, r);
      for (let s = s0 + 0.95; s < s1 - 0.4; s += 1.6) {
        lamp(c.hi, vert ? axis : s, vert ? s : axis, vert ? 1 : 0, vert ? 0 : 1);
        lamp(c.hi, vert ? axis : s + 0.01, vert ? s + 0.01 : axis, vert ? -1 : 0, vert ? 0 : -1);
      }
      // parked cars along the outer kerbs
      for (let s = s0 + 0.3; s < s1 - 0.3; s += 0.42) {
        if (r() < 0.45) continue;
        const side = r() < 0.5 ? -1 : 1;
        const t = side * (a - 0.085);
        pcar(c.hi, vert ? axis + t : s, vert ? s : axis + t, !vert, pick(r, CAR));
      }
    } else {
      G.c(ASPH).kind(KIND.asphalt, 1);
      rectST(vert, axis, s0, s1, -a, a, Y_ASPH);
    }
    G.c(WALK);
    rectST(vert, axis, s0, s1, -hw, -a, Y_WALK);
    rectST(vert, axis, s0, s1, a, hw, Y_WALK);
    G.c(ROAD.kerbColor);
    boxST(G, vert, axis, s0, s1, -a - KERB + 0.003, -a + 0.003, 0.02, Y_KERB);
    boxST(G, vert, axis, s0, s1, a - 0.003, a + KERB - 0.003, 0.02, Y_KERB);
  };

  const nodes: { i: number; j: number; n: boolean; s: boolean; e: boolean; w: boolean }[] = [];
  for (let i = I0; i <= I1; i += 2) {
    for (let j = J0; j <= J1; j += 2) {
      if (vPresent(i, j)) edge(true, i, j);
      if (hPresent(i, j)) edge(false, i, j);
      const realN = vPresent(i, j - 2), realS = vPresent(i, j), realW = hPresent(i - 2, j), realE = hPresent(i, j);
      if (!(realN || realS || realW || realE)) continue;
      nodes.push({ i, j, n: realN, s: realS, w: realW, e: realE });
      // nodes on the map boundary open toward the map so in-map streets meet them cleanly
      const n = realN || (j === H && i >= 0 && i <= W);
      const s = realS || (j === 0 && i >= 0 && i <= W);
      const e = realE || (i === 0 && j >= 0 && j <= H);
      const w = realW || (i === W && j >= 0 && j <= H);
      const X = cxw(i), Z = czw(j);
      const aV = blvdV(i) && (j <= 0 || j >= H) ? BA : SA, hV = hwV(i);
      const aH = blvdH(j) && (i <= 0 || i >= W) ? BA : SA, hH = hwH(j);
      G.c(ASPH).kind(KIND.asphalt, 0).rect(X - aV, Z - aH, X + aV, Z + aH, Y_ASPH);
      const arm = (on: boolean, x0: number, z0: number, x1: number, z1: number) => (on ? G.c(ASPH).kind(KIND.asphalt, 0) : G.c(WALK)).rect(x0, z0, x1, z1, on ? Y_ASPH : Y_WALK);
      arm(e, X + aV, Z - aH, X + hV, Z + aH);
      arm(w, X - hV, Z - aH, X - aV, Z + aH);
      arm(n, X - aV, Z - hH, X + aV, Z - aH);
      arm(s, X - aV, Z + aH, X + aV, Z + hH);
      G.c(WALK);
      G.rect(X + aV, Z + aH, X + hV, Z + hH, Y_WALK).rect(X - hV, Z + aH, X - aV, Z + hH, Y_WALK).rect(X + aV, Z - hH, X + hV, Z - aH, Y_WALK).rect(X - hV, Z - hH, X - aV, Z - aH, Y_WALK);
      G.c(ROAD.kerbColor);
      const kx = (x0: number, x1: number, z: number, dir: number) => G.box(x0, 0.02, dir < 0 ? z - KERB + 0.003 : z - 0.003, x1, Y_KERB, dir < 0 ? z + 0.003 : z + KERB - 0.003);
      const kz = (z0: number, z1: number, x: number, dir: number) => G.box(dir < 0 ? x - KERB + 0.003 : x - 0.003, 0.02, z0, dir < 0 ? x + 0.003 : x + KERB - 0.003, Y_KERB, z1);
      // north kerb line z = Z - aH (walk lies north, dir -1), south line (walk south, dir +1)
      if (w) { kx(X - hV, X - aV, Z - aH, -1); kx(X - hV, X - aV, Z + aH, 1); }
      if (e) { kx(X + aV, X + hV, Z - aH, -1); kx(X + aV, X + hV, Z + aH, 1); }
      if (!n) kx(X - aV, X + aV, Z - aH, -1);
      if (!s) kx(X - aV, X + aV, Z + aH, 1);
      if (n) { kz(Z - hH, Z - aH, X - aV, -1); kz(Z - hH, Z - aH, X + aV, 1); }
      if (s) { kz(Z + aH, Z + hH, X - aV, -1); kz(Z + aH, Z + hH, X + aV, 1); }
      if (!w) kz(Z - aH, Z + aH, X - aV, -1);
      if (!e) kz(Z - aH, Z + aH, X + aV, 1);
      const arms = +realN + +realS + +realE + +realW;
      if (arms >= 3) {
        G.c(ASPH).kind(KIND.zebra);
        if (realE) G.rect(X + hV + 0.03, Z - aH, X + hV + 0.17, Z + aH, Y_PAINT);
        if (realW) G.rect(X - hV - 0.17, Z - aH, X - hV - 0.03, Z + aH, Y_PAINT);
        G.c(ASPH).kind(KIND.zebra);
        if (realN) G.rect(X - aV, Z - hH - 0.17, X + aV, Z - hH - 0.03, Y_PAINT, true);
        if (realS) G.rect(X - aV, Z + hH + 0.03, X + aV, Z + hH + 0.17, Y_PAINT, true);
      }
      if (arms >= 2) {
        const h = hash2(i, j, 71);
        const sx = h < 0.5 ? 1 : -1, sz = (h * 4) % 1 < 0.5 ? 1 : -1;
        const lx = X + sx * (aV + hV) / 2, lz = Z + sz * (aH + hH) / 2;
        const inside = lx > cxw(0) && lx < cxw(W) && lz > czw(0) && lz < czw(H);
        if (!inside) lamp(chunkAt(lx, lz).hi, lx, lz, -sx * 0.7, -sz * 0.7);
      }
    }
  }

  /* blocks */
  const sc = { x: 2, y: -7 };
  const special: Record<string, Zone> = Object.fromEntries([
    [`${BI - 2},-4`, "fountain"],
    [`${BI},-4`, "monument"],
    [`-6,${BJ - 2}`, "church"],
    [`${parkI},${parkJ}`, "bigpark"],
    [`-8,${H + 2}`, "park"],
    [`${W + 2},${H + 6}`, "park"],
    [`${W + 8},${BJ + 4}`, "pitch"],
    [`${BI - 10},-6`, "park"],
  ]);
  const skipBlocks: Record<string, true> = { [`${parkI + 2},${parkJ}`]: true, [`${parkI},${parkJ + 2}`]: true, [`${parkI + 2},${parkJ + 2}`]: true };
  let peakDone = false;
  let peakBlock = "";
  {
    // the skyline's peak: the downtown block nearest the focal point
    let best = Infinity;
    for (let i0 = I0; i0 < I1; i0 += 2) for (let j0 = J0; j0 < J1; j0 += 2) {
      if ((i0 >= 0 && i0 < W && j0 >= 0 && j0 < H) || special[`${i0},${j0}`]) continue;
      const d = Math.hypot(i0 + 1 - sc.x, j0 + 1 - sc.y);
      if (d < best) { best = d; peakBlock = `${i0},${j0}`; }
    }
  }

  for (let i0 = I0; i0 < I1; i0 += 2) {
    for (let j0 = J0; j0 < J1; j0 += 2) {
      if (i0 >= 0 && i0 < W && j0 >= 0 && j0 < H) continue;
      const id = `${i0},${j0}`;
      if (skipBlocks[id]) continue;
      const dx = i0 < 0 ? -i0 : i0 >= W ? i0 + 2 - W : 0;
      const dy = j0 < 0 ? -j0 : j0 >= H ? j0 + 2 - H : 0;
      const k = Math.max(dx, dy) / 2;
      const st = { n: hPresent(i0, j0), s: hPresent(i0, j0 + 2), w: vPresent(i0, j0), e: vPresent(i0 + 2, j0) };
      let zone: Zone | undefined = special[id];
      const big = zone === "bigpark";
      const ie = big ? i0 + 4 : i0 + 2, je = big ? j0 + 4 : j0 + 2;
      if (big) { st.e = vPresent(ie, j0); st.s = hPresent(i0, je); }
      const x0 = cxw(i0) + (st.w ? hwV(i0) : 0);
      const x1 = cxw(ie) - (st.e ? hwV(ie) : 0);
      const z0 = czw(j0) + (st.n ? hwH(j0) : 0);
      const z1 = je === J1 ? shoreZ : czw(je) - (st.s ? hwH(je) : 0);
      const down = Math.max(0, 1 - Math.hypot(i0 + 1 - sc.x, j0 + 1 - sc.y) / 13);
      const h = hash2(i0, j0, 17);
      if (!zone) {
        if (j0 === J1 - 2) zone = "quay";
        else if (j0 === J1 - 4) zone = i0 >= W * 0.6 ? "warehouse" : "waterfront";
        else if (k === 7) zone = st.n || st.s || st.e || st.w ? "edge" : "farm";
        else if (id === peakBlock || down > 0.62) zone = "tower";
        else if (down > 0.3) zone = h < 0.55 ? "office" : h < 0.85 ? "tower" : "apartment";
        else {
          const nearBlvd = blvdV(i0) || blvdV(i0 + 2) || blvdH(j0) || blvdH(j0 + 2);
          const kk = nearBlvd ? Math.max(1, k - 2) : k;
          if (kk <= 1) zone = weighted<Zone>(h, [["office", 0.14], ["slabs", 0.12], ["highstreet", 0.16], ["hall", 0.07], ["school", 0.04], ["apartment", 1]]);
          else if (kk <= 2) zone = weighted<Zone>(h, [["park", 0.04], ["highstreet", 0.25], ["slabs", 0.1], ["terrace", 0.15], ["hall", 0.06], ["school", 0.05], ["office", 0.04], ["apartment", 1]]);
          else if (kk <= 3) zone = weighted<Zone>(h, [["park", 0.05], ["highstreet", 0.25], ["apartment", 0.15], ["villa", 0.1], ["school", 0.05], ["hall", 0.04], ["terrace", 1]]);
          else if (kk <= 4) zone = weighted<Zone>(h, [["park", 0.05], ["villa", 0.35], ["highstreet", 0.14], ["school", 0.04], ["terrace", 1]]);
          else if (kk <= 5) zone = weighted<Zone>(h, [["park", 0.04], ["terrace", 0.3], ["villa", 1]]);
          else zone = "villa";
        }
      }
      const b: Blk = { i0, j0, x0, z0, x1, z1, st, k, down, r: rng(i0, j0, 29), c: chunkAt((x0 + x1) / 2, (z0 + z1) / 2), G, seed: Math.floor(h * 1000) };
      switch (zone) {
        case "tower": {
          const peak = id === peakBlock && !peakDone;
          if (peak) peakDone = true;
          towers(b, peak);
          break;
        }
        case "office": offices(b); break;
        case "apartment": perimeter(b, { fmin: 3 + Math.floor(hash2(i0, j0, 4) * 2), fmax: k <= 1 ? 6 : 5, shop: 0.5, pitched: 0.4, walls: weighted<readonly string[]>(hash2(i0, j0, 5), [[BRICK, 0.3], [PASTEL, 0.25], [PLASTER, 1]]), band: 0.2, trees: hash2(i0, j0, 3) < 0.6 }); break;
        case "waterfront": perimeter(b, { fmin: 3, fmax: 5, shop: 0.6, pitched: 0.85, walls: PASTEL, band: 0.2, trees: true }); break;
        case "highstreet": perimeter(b, { fmin: 2, fmax: 4, shop: 0.85, pitched: 0.7, walls: weighted<readonly string[]>(hash2(i0, j0, 5), [[BRICK, 0.4], [PASTEL, 0.3], [PLASTER, 1]]), band: 0.16, trees: hash2(i0, j0, 3) < 0.35 }); break;
        case "school": school(b); break;
        case "hall": hall(b); break;
        case "slabs": slabs(b); break;
        case "terrace": terrace(b); break;
        case "villa": villas(b, false); break;
        case "edge": villas(b, true); break;
        case "farm": {
          const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
          b.G.c(pick(b.r, LAWN), 1.02).rect(x0, z0, x1, z1, Y_BASE);
          for (const [a, bb, cc, d] of [[x0, z0, mx, mz], [mx, z0, x1, mz], [x0, mz, mx, z1], [mx, mz, x1, z1]]) backLot(b, a, bb, cc, d, true);
          break;
        }
        case "park": park(b, false); break;
        case "bigpark": park(b, true); break;
        case "fountain": plaza(b, true); break;
        case "monument": plaza(b, false); break;
        case "church": church(b); break;
        case "pitch": pitch(b); break;
        case "warehouse": warehouses(b); break;
        case "quay": quayRow(b, W, shoreZ, cxw(BI)); break;
      }
    }
  }

  // quay wall along the whole shore, and the freighter at the container quay
  G.c(QUAY).wall(cxw(I1), shoreZ, cxw(I0), shoreZ, QUAY_FOOT, 0.05);
  G.c(QUAY, 0.8).wall(cxw(I1), shoreZ + 0.001, cxw(I0), shoreZ + 0.001, QUAY_FOOT, SEA_Y + 0.08);
  freighter(chunkAt(cxw(W + 1), shoreZ - 1), cxw(W - 2), cxw(W + 4), shoreZ);

  /* moving cars: laps around 1–3 × 1–3 block rectangles of existing streets */
  const LANE = (blvd: boolean) => (blvd ? LANE_BLVD : LANE_STD);
  const cars: CarLap[] = [];
  const cr = rng(W, H, 91);
  let tries = 0;
  while (cars.length < 240 && tries < 6000) {
    tries++;
    const nd = nodes[Math.floor(cr() * nodes.length)];
    const a = 1 + Math.floor(cr() * 3), bb = 1 + Math.floor(cr() * 3);
    const i0 = nd.i, j0 = nd.j, i1 = i0 + a * 2, j1 = j0 + bb * 2;
    let ok = true;
    for (let i = i0; i < i1 && ok; i += 2) ok = hPresent(i, j0) && hPresent(i, j1);
    for (let j = j0; j < j1 && ok; j += 2) ok = vPresent(i0, j) && vPresent(i1, j);
    if (!ok) continue;
    const cw = cr() < 0.5;
    const sg = cw ? 1 : -1;
    const lap = {
      x0: cxw(i0) + sg * LANE(blvdV(i0)), x1: cxw(i1) - sg * LANE(blvdV(i1)),
      z0: czw(j0) + sg * LANE(blvdH(j0)), z1: czw(j1) - sg * LANE(blvdH(j1)),
    };
    const n = 1 + Math.floor(cr() * 3);
    const per = 2 * (lap.x1 - lap.x0 + lap.z1 - lap.z0);
    const base = cr() * per;
    for (let q = 0; q < n; q++) cars.push({ ...lap, cw, speed: 1.1 + cr() * 0.7, phase: base + (q * per) / n, color: pick(cr, CAR) });
  }

  const out: TownChunk[] = [];
  for (const c of chunks.values()) {
    const hi = c.hi.geometry(), lo = c.lo.geometry();
    const bb = hi.boundingBox!;
    out.push({ hi, lo, min: [bb.min.x, bb.min.z], max: [bb.max.x, bb.max.z] });
  }
  return { ground: G.geometry(), chunks: out, cars };
}

/* ───────────────────────── material ───────────────────────── */

/** Seconds, written by `<Town>` each frame (water shimmer). */
export const TOWN_TIME = { value: 0 };

const glsl = (hex: string) => { const c = new THREE.Color(hex); return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`; };

/**
 * Standard material that draws the town's surface detail procedurally:
 * window grids (punched, ribbon, curtain wall, shopfronts, house, shed,
 * church), cornices and plinths, pavers, mown lawn stripes, sports-pitch
 * lines, parking bays, road dashes and zebras, rippling water. Windows fade
 * to their average colour once a cell gets smaller than a few pixels (no
 * moiré), and a hashed subset lights warm/cool after dusk via NIGHT.
 */
export function townMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0.0 });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = NIGHT;
    shader.uniforms.uTime = TOWN_TIME;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec4 aFace;\nattribute vec4 aWin;\nvarying vec4 vFace;\nvarying vec4 vWin;\nvarying vec3 vTPos;")
      .replace("#include <project_vertex>", "#include <project_vertex>\nvFace = aFace;\nvWin = aWin;\nvTPos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
uniform float uNight;
uniform float uTime;
varying vec4 vFace;
varying vec4 vWin;
varying vec3 vTPos;
float tHash(vec3 p) { p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.x + p.y) * p.z); }
float tBox(vec2 f, vec2 h, vec2 aa) { vec2 d = (h - abs(f - 0.5)) / max(aa, vec2(1e-4)); vec2 s = clamp(d + 0.5, 0.0, 1.0); return s.x * s.y; }
float tLine(float x, float w, float aa) { return clamp((w - abs(x)) / max(aa, 1e-4) + 0.5, 0.0, 1.0); }
`)
      .replace("#include <color_fragment>", `#include <color_fragment>
float tGlass = 0.0;
vec3 tEmit = vec3(0.0);
{
  float kind = floor(vWin.x + 0.5);
  vec3 base = diffuseColor.rgb;
  if (kind == 7.0) {
    tEmit = base * uNight * (vWin.y > 0.0 ? vWin.y : 2.6);
  } else if (kind >= 1.0 && kind <= 8.0 && vFace.z > 0.001 && vWin.z > 0.001 && vWin.y > 0.001) {
    float u = vFace.x, v = vFace.y, fw = vFace.z, fh = vFace.w;
    float st = vWin.y, cw = vWin.z, seed = vWin.w;
    float cols = max(1.0, floor(fw / cw + 0.35));
    vec2 cell = vec2(u / (fw / cols), v / st);
    vec2 ic = floor(cell);
    vec2 fc = cell - ic;
    vec2 aa = fwidth(cell);
    float floors = max(1.0, floor((fh - 0.04) / st + 0.1));
    vec2 wsz = vec2(0.46, 0.5);
    float lit = 0.42;
    vec3 lc = vec3(1.0, 0.66, 0.34);
    vec3 glassC = ${glsl("#3f4d5e")};
    vec3 wallC = base;
    float rowOk = step(0.0, ic.y) * step(ic.y, floors - 1.0);
    float doorM = 0.0;
    if (kind == 2.0) { wsz = vec2(0.94, 0.5); lit = 0.34; lc = vec3(0.72, 0.78, 0.86); glassC = ${glsl("#40505f")}; }
    else if (kind == 3.0) { wsz = vec2(0.88, 0.82); lit = 0.24; lc = vec3(0.66, 0.72, 0.8); glassC = base * 0.72 + ${glsl("#26343f")}; wallC = mix(base, vec3(0.7), 0.5); }
    else if (kind == 4.0) { wsz = vec2(0.42, 0.44); lit = 0.5; }
    else if (kind == 5.0 && ic.y < 0.5) { wsz = vec2(0.9, 0.66); lit = 0.92; lc = vec3(1.0, 0.82, 0.55); fc.y = fc.y + 0.12; }
    else if (kind == 6.0) {
      wsz = vec2(0.7, 0.22); lit = 0.25;
      doorM = step(ic.y, 0.5) * step(0.5, mod(ic.x, 3.0)) * step(mod(ic.x, 3.0), 1.5) * tBox(vec2(fc.x, fc.y * 0.5 + 0.2), vec2(0.38, 0.3), aa);
      rowOk *= step(floors - 1.0, ic.y);
    }
    else if (kind == 8.0) { wsz = vec2(0.3, 0.7); lit = 0.75; lc = vec3(1.0, 0.72, 0.42); }
    float win = tBox(fc, wsz * 0.5, aa) * rowOk;
    float frame = clamp(tBox(fc, wsz * 0.5 + vec2(0.06, 0.06), aa) * rowOk - win, 0.0, 1.0);
    float h = tHash(vec3(ic, seed));
    float cornice = (kind == 4.0 || kind == 6.0 || kind == 8.0) ? 0.0 : step(fh - 0.075, v);
    float plinth = 1.0 - step(0.05, v);
    wallC *= (1.0 - 0.16 * cornice) * (1.0 - 0.22 * plinth) * (0.9 + 0.1 * clamp(v / 2.5, 0.0, 1.0));
    // string course at each floor line and a pale sill under each window (masonry kinds)
    float masonry = (kind == 1.0 || kind == 4.0 || kind == 5.0 || kind == 8.0) ? 1.0 : 0.0;
    float course = masonry * tLine(fc.y - 0.015, 0.02, aa.y) * step(0.5, ic.y) * rowOk;
    float sill = masonry * rowOk * tBox(vec2(fc.x, (fc.y - (0.5 - wsz.y * 0.5 - 0.03)) * 16.0 + 0.5), vec2(wsz.x * 0.5 + 0.05, 0.5), vec2(aa.x, aa.y * 16.0));
    wallC = mix(wallC, wallC * 0.86, course);
    wallC = mix(wallC, min(wallC * 1.18 + 0.03, vec3(1.0)), sill);
    // panes go dark after dusk so only the lit ones read
    glassC *= mix(1.0, 0.3, uNight);
    vec3 gl = glassC * (0.7 + 0.55 * fc.y) * (0.82 + 0.36 * h);
    float px = max(aa.x, aa.y);
    float far = smoothstep(0.22, 0.55, px);
    float area = wsz.x * wsz.y * (kind == 6.0 ? 1.0 / max(floors, 1.0) : 1.0);
    vec3 nearC = mix(mix(wallC, wallC * 0.7, frame * (kind == 3.0 ? 0.0 : 1.0)), gl, win);
    nearC = mix(nearC, ${glsl("#4a4c50")}, doorM);
    vec3 farC = mix(wallC, glassC * 1.05, area * 0.85);
    diffuseColor.rgb = mix(nearC, farC, far);
    tGlass = mix(win, area, far);
    // mostly below the bloom threshold; a rare window burns brighter as an accent
    float on = step(h, lit) * (0.45 + 0.6 * fract(h * 7.31)) * (fract(h * 13.7) > 0.94 ? 1.7 : 1.0);
    // office floors mix cool and warm light so towers don't read as uniform white grids
    if (kind == 2.0 || kind == 3.0) lc = mix(lc, vec3(0.78, 0.56, 0.32), step(0.5, fract(h * 3.7)));
    tEmit = uNight * mix(win * on * lc * 0.85, area * lit * lc * 0.4, far);
  } else if (kind == 9.0) {
    float sz = vWin.y > 0.0 ? vWin.y : 0.16;
    vec2 p = vTPos.xz / sz;
    vec2 ip = floor(p);
    vec2 aa = fwidth(p);
    float joint = 1.0 - tBox(p - ip, vec2(0.45), aa);
    float n = tHash(vec3(ip, 3.0));
    float fade = smoothstep(0.2, 0.5, max(aa.x, aa.y));
    diffuseColor.rgb = base * mix((1.0 - 0.16 * joint) * (0.93 + 0.12 * n), 0.96, fade);
  } else if (kind == 10.0) {
    float s = step(0.5, fract(vTPos.x / 0.45));
    float n = tHash(vec3(floor(vTPos.xz / 1.3), 9.0));
    diffuseColor.rgb = base * (0.96 + 0.07 * s) * (0.95 + 0.1 * n);
  } else if (kind == 11.0) {
    float w = sin(vTPos.x * 7.0 + uTime * 1.3) * sin(vTPos.z * 6.0 - uTime * 1.1);
    diffuseColor.rgb = base * (0.92 + 0.12 * w);
    tGlass = 1.0;
    tEmit = base * uNight * 0.05;
  } else if (kind == 12.0) {
    float aa = fwidth(vFace.x / 0.24);
    float bay = tLine(fract(vFace.x / 0.24 + 0.5) - 0.5, 0.04, aa) * step(0.04, abs(vFace.y)) * step(abs(vFace.y), vFace.w * 0.5 - 0.02);
    diffuseColor.rgb = mix(base, ${glsl(ROAD.paintColor)}, bay * 0.85);
  } else if (kind == 14.0) {
    vec2 p = vTPos.xz / vec2(0.16, 0.11);
    vec2 aa = fwidth(p);
    float cellIn = tBox(fract(p), vec2(0.44), aa);
    float fade = smoothstep(0.25, 0.6, max(aa.x, aa.y));
    diffuseColor.rgb = mix(mix(base * 1.9, base, cellIn), base * 1.15, fade);
    tGlass = 0.7;
  } else if (kind == 13.0) {
    float u = vFace.x, v = vFace.y, fw = vFace.z, fh = vFace.w;
    float aa = fwidth(u);
    float border = max(tLine(min(u, fw - u), 0.03, aa), tLine(fh * 0.5 - abs(v), 0.03, aa));
    float half_ = tLine(u - fw * 0.5, 0.015, aa);
    float ring = tLine(length(vec2(u - fw * 0.5, v)) - 0.32, 0.015, aa);
    float boxL = tLine(abs(v) - 0.42, 0.015, aa) * step(min(u, fw - u), 0.45) + tLine(min(u, fw - u) - 0.45, 0.015, aa) * step(abs(v), 0.42);
    float lines = max(max(border, half_), max(ring, boxL));
    diffuseColor.rgb = mix(base * (0.95 + 0.08 * step(0.5, fract(u / 0.4))), vec3(0.92), lines);
  } else if (kind == 16.0) {
    float n = tHash(vec3(floor(vTPos.xz / 0.9), 5.0));
    diffuseColor.rgb = base * (0.95 + 0.08 * n);
    if (vWin.y > 0.5) {
      float aa = fwidth(vFace.x);
      float dash = tLine(fract(vFace.x / 0.34) - 0.25, 0.2, aa / 0.34) * tLine(vFace.y, 0.009, fwidth(vFace.y));
      diffuseColor.rgb = mix(diffuseColor.rgb, ${glsl(ROAD.paintColor)}, dash * (1.0 - smoothstep(0.02, 0.05, aa)));
    }
  } else if (kind == 17.0) {
    float aa = fwidth(vFace.y / 0.064);
    float z = tLine(fract(vFace.y / 0.064) - 0.5, 0.25, aa) * step(abs(vFace.y), vFace.w * 0.5 - 0.02);
    diffuseColor.rgb = mix(base, ${glsl(ROAD.paintColor)}, z * (1.0 - smoothstep(0.3, 0.6, aa)));
  }
}`)
      // glass glints by day; at night it goes matte so the moon doesn't light every pane on a face
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, mix(0.18, 0.6, uNight), tGlass);")
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance += tEmit;");
  };
  m.customProgramCacheKey = () => "townSurface";
  return m;
}
