"use client";

import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { EconomySnapshot } from "@econ-sim/sim/snapshot";
import type { CompanyView, PlayerView } from "@econ-sim/sim/protocol";
import { GOODS, RECIPES, type BuildingType, type Good } from "@econ-sim/sim/goods";
import { buildingHeight } from "./geometry.ts";
import type { RoadNet } from "./roads.ts";
import { OUTLINE, TILE, hash2, tileToWorld } from "./world-style.ts";
import { GOOD_TINT, GoodIcon } from "../ui/GoodIcon.tsx";
import { companyColor } from "../../lib/palette.ts";
import { num } from "../../lib/format.ts";
import { useUi } from "../../lib/store.ts";

type Tile = EconomySnapshot["world"]["tiles"][number];

/** Cargo pellet pitch along an arc and chevron pitch along a haul ribbon, world units. */
const SPACING_ARC = 1.15;
const SPACING_RIB = 0.8;
const ARC_SEGS = 28;
/** Arc landing height over your HQ parcel (the HQ model is low and wide). */
const HQ_TOP = 1.6;
/** Haul ribbons float just above truck roofs so traffic never hides them. */
const RIB_Y = 0.28;
/** Units per tick that read as a full-speed flow; rates above saturate. */
const RATE_FULL = 30;
/** Good badges: nearest few within range, re-picked at 4 Hz. */
const MAX_BADGES = 28;
const BADGE_DIST = 120;
const BADGE_TICK = 0.25;

/** Shared clock for both flow materials; the dash offset is `s - uTime * speed`. */
const TIME = { value: 0 };

const VERT = /* glsl */ `
attribute vec3 aDir;
attribute vec4 aRib;   // s (world units from the start), side -1|1, half width, speed (units/s, sign = direction)
attribute vec3 aMisc;  // phase (cycles), activity 0..1, ribbon length
attribute vec3 aColor;
uniform float uTime;
uniform float uSpacing;
varying vec3 vColor;
varying float vFlow;
varying float vAcross;
varying float vW;
varying float vS;
varying float vLen;
varying float vAct;
varying float vSign;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  float w = aRib.z;
#ifdef FLAT
  vec3 side = vec3(-aDir.z, 0.0, aDir.x);
#else
  // camera-facing ribbon so an arc reads the same from overview and street level
  vec3 toCam = cameraPosition - wp.xyz;
  vec3 side = normalize(cross(aDir, toCam));
  w *= clamp(length(toCam) / 45.0, 1.0, 2.0);
#endif
  wp.xyz += side * aRib.y * w;
  vColor = aColor;
  vAcross = aRib.y;
  vW = w;
  vS = aRib.x;
  vLen = aMisc.z;
  vAct = aMisc.y;
  vSign = aRib.w < 0.0 ? -1.0 : 1.0;
  vFlow = (aRib.x - uTime * aRib.w) / uSpacing + aMisc.x;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const FRAG = /* glsl */ `
uniform float uSpacing;
uniform float uLine;
uniform float uGlow;
varying vec3 vColor;
varying float vFlow;
varying float vAcross;
varying float vW;
varying float vS;
varying float vLen;
varying float vAct;
varying float vSign;
void main() {
  float a = abs(vAcross);
#ifdef FLAT
  // chevrons pointing along the flow, over a soft glowing band
  float g = fract(vFlow + vSign * a * 0.6);
  float aa = fwidth(vFlow) * 1.5;
  float dash = (smoothstep(0.0, aa, g) - smoothstep(0.42, 0.42 + aa, g)) * vAct;
  float body = 1.0 - smoothstep(0.55, 1.0, a);
  vec3 col = vColor * mix(0.9, uGlow, dash);
  float alpha = body * mix(uLine, 1.0, dash);
#else
  // round cargo pellets with a light rim riding a thin core line
  float along = (fract(vFlow) - 0.5) * uSpacing;
  float d = length(vec2(along, vAcross * vW)) / vW;
  float px = fwidth(d);
  float pellet = (1.0 - smoothstep(0.82 - px, 0.82 + px, d)) * vAct;
  float core = 1.0 - smoothstep(0.12, 0.3 + fwidth(vAcross), a);
  float ends = smoothstep(0.0, 0.9, vS) * smoothstep(0.0, 0.9, vLen - vS);
  vec3 rim = mix(vColor, vec3(1.0), 0.55);
  vec3 col = mix(vColor * 1.1, mix(vColor, rim, smoothstep(0.35, 0.8, d)) * uGlow, pellet);
  float alpha = max(core * uLine, pellet) * ends;
#endif
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(col, alpha);
}`;

function flowMaterial(flat: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    defines: flat ? { FLAT: "" } : {},
    uniforms: {
      uTime: TIME,
      uSpacing: { value: flat ? SPACING_RIB : SPACING_ARC },
      uLine: { value: flat ? 0.4 : 0.32 },
      uGlow: { value: flat ? 2.2 : 1.35 },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    // additive ribbons glow over the dimmed analysis ground; arcs blend normally so dark goods (coal, crude) still read on grass
    blending: flat ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
}

/** Plain-array accumulator for one ribbon batch: rebuilt per snapshot, never per frame. */
class Batch {
  readonly pos: number[] = [];
  readonly dir: number[] = [];
  readonly rib: number[] = [];
  readonly misc: number[] = [];
  readonly col: number[] = [];
  readonly idx: number[] = [];

  /** Both side vertices (−1/+1) of one ribbon cross-section; `join` links it to the previous pair. */
  pair(x: number, y: number, z: number, dx: number, dy: number, dz: number, s: number, hw: number, speed: number, phase: number, act: number, len: number, c: THREE.Color, join: boolean): void {
    const v = this.pos.length / 3;
    for (let side = -1; side <= 1; side += 2) {
      this.pos.push(x, y, z);
      this.dir.push(dx, dy, dz);
      this.rib.push(s, side, hw, speed);
      this.misc.push(phase, act, len);
      this.col.push(c.r, c.g, c.b);
    }
    if (join) this.idx.push(v - 2, v - 1, v, v - 1, v + 1, v);
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("aDir", new THREE.Float32BufferAttribute(this.dir, 3));
    g.setAttribute("aRib", new THREE.Float32BufferAttribute(this.rib, 4));
    g.setAttribute("aMisc", new THREE.Float32BufferAttribute(this.misc, 3));
    g.setAttribute("aColor", new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    return g;
  }
}

interface Motion { speed: number; phase: number }

/**
 * Phase that keeps a dash pattern still at time `t` when its speed changes, so
 * a utilization change on a new tick doesn't teleport the cargo. Reads the
 * previous snapshot's motions and records into the next map (stale keys drop).
 */
function continuous(prev: Map<string, Motion>, next: Map<string, Motion>, key: string, speed: number, spacing: number, t: number, seed: number): number {
  const p = prev.get(key);
  const phase = p ? (p.phase + (t * (speed - p.speed)) / spacing) % 1 : seed;
  next.set(key, { speed, phase });
  return phase;
}

/** Units/tick → 0..1 visual intensity (sqrt so small producers still visibly move). */
const intensity = (rate: number) => Math.sqrt(Math.min(1, rate / RATE_FULL));

interface Flow {
  key: string;
  good: Good;
  rate: number;
  p0: THREE.Vector3;
  p1: THREE.Vector3;
  p2: THREE.Vector3;
}

/**
 * Your company's goods movement this tick, straight from the sim's numbers:
 * `utilization × baseThroughput` units of throughput, times each recipe leg.
 * Outputs arc from the plant to the HQ warehouse; inputs arc back out to the
 * consuming plant, bowed to the other side so the two directions never overlap.
 */
function ownFlows(snap: EconomySnapshot, co: CompanyView, hub: Tile): Flow[] {
  const { width, height } = snap.world;
  const [hx, hz] = tileToWorld(hub.x, hub.y, width, height);
  const out: Flow[] = [];
  for (const b of co.buildings) {
    if (!b.live || b.tileId === co.hubTileId) continue;
    const r = RECIPES[b.type];
    const units = b.utilization * r.baseThroughput;
    const [bx, bz] = tileToWorld(b.x, b.y, width, height);
    const top = buildingHeight(b.type, b.x, b.y) * 0.85;
    const dx = hx - bx;
    const dz = hz - bz;
    const dist = Math.hypot(dx, dz) || 1;
    // perpendicular of plant → HQ: outputs bow one way, inputs the other
    const px = -dz / dist;
    const pz = dx / dist;
    const lift = Math.max(top, HQ_TOP) + 0.8 + dist * 0.3;
    const ins = Object.entries(r.inputs) as [Good, number][];
    const arc = (good: Good, q: number, lateral: number, outbound: boolean) => {
      const plant = new THREE.Vector3(bx, top, bz);
      const hq = new THREE.Vector3(hx, HQ_TOP, hz);
      const p1 = new THREE.Vector3((bx + hx) / 2 + px * lateral, lift, (bz + hz) / 2 + pz * lateral);
      out.push({ key: `${b.id}:${good}`, good, rate: units * q, p0: outbound ? plant : hq, p1, p2: outbound ? hq : plant });
    };
    for (const [g, q] of Object.entries(r.outputs) as [Good, number][]) arc(g, q, ins.length ? 0.7 : 0, true);
    ins.forEach(([g, q], k) => arc(g, q, -0.7 - k * 0.6, false));
  }
  return out;
}

const bez = new THREE.Vector3();
const tan = new THREE.Vector3();

function arcGeometry(flows: Flow[], prev: Map<string, Motion>, next: Map<string, Motion>, t: number): THREE.BufferGeometry {
  const batch = new Batch();
  const color = new THREE.Color();
  const pts: THREE.Vector3[] = [];
  const cum: number[] = [];
  for (let k = 0; k <= ARC_SEGS; k++) pts.push(new THREE.Vector3());
  flows.forEach((f, n) => {
    const v = intensity(f.rate);
    const speed = f.rate > 0 ? 0.5 + 2.5 * v : 0;
    const phase = continuous(prev, next, f.key, speed, SPACING_ARC, t, hash2(n, f.good.length, 23));
    const act = f.rate > 0 ? 0.55 + 0.45 * v : 0;
    const hw = 0.085 + 0.04 * v;
    color.set(GOOD_TINT[f.good]);
    let len = 0;
    for (let k = 0; k <= ARC_SEGS; k++) {
      const u = k / ARC_SEGS;
      const a = (1 - u) * (1 - u);
      const b = 2 * (1 - u) * u;
      const c = u * u;
      pts[k].set(a * f.p0.x + b * f.p1.x + c * f.p2.x, a * f.p0.y + b * f.p1.y + c * f.p2.y, a * f.p0.z + b * f.p1.z + c * f.p2.z);
      if (k) len += pts[k].distanceTo(pts[k - 1]);
      cum[k] = len;
    }
    for (let k = 0; k <= ARC_SEGS; k++) {
      const u = k / ARC_SEGS;
      // dB/du = 2(1-u)(p1-p0) + 2u(p2-p1)
      tan.subVectors(f.p1, f.p0).multiplyScalar(2 * (1 - u)).add(bez.subVectors(f.p2, f.p1).multiplyScalar(2 * u)).normalize();
      const p = pts[k];
      batch.pair(p.x, p.y, p.z, tan.x, tan.y, tan.z, cum[k], hw, speed, phase, act, len, color, k > 0);
    }
  });
  return batch.geometry();
}

/** Freight weight per tick a building moves at full utilization: every recipe leg in and out. */
function haulPerTick(type: BuildingType): number {
  const r = RECIPES[type];
  let w = 0;
  for (const [g, q] of Object.entries(r.outputs) as [Good, number][]) w += q * GOODS[g].weight;
  for (const [g, q] of Object.entries(r.inputs) as [Good, number][]) w += q * GOODS[g].weight;
  return w * r.baseThroughput;
}

/** Stable lane slot −2..2 so companies sharing a street run side by side like metro lines. */
function laneOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
  return ((h >>> 0) % 5) - 2;
}

interface Step { company: string; x0: number; z0: number; x1: number; z1: number; s0: number; haul: number }

/**
 * Every company's haul network as street-hugging ribbons: each route's
 * tile-length street steps deduplicated per company (all of a company's
 * routes leave the same HQ corner along L-paths, so a shared step has the
 * same distance-from-HQ for every route through it and the chevrons stay
 * continuous). Width follows the real freight weight on that step this tick;
 * chevrons stream toward the HQ at a speed set by the company's total haul.
 */
function ribbonGeometry(snap: EconomySnapshot, roads: RoadNet, youCompany: string | null, prev: Map<string, Motion>, next: Map<string, Motion>, t: number): THREE.BufferGeometry {
  const tileById = new Map(snap.world.tiles.map((x) => [x.id, x] as const));
  const steps = new Map<string, Step>();
  const companyHaul = new Map<string, number>();
  for (const r of roads.routes) {
    const b = tileById.get(r.tileId)?.building;
    const haul = b?.live ? haulPerTick(b.type) * b.utilization : 0;
    companyHaul.set(r.companyId, (companyHaul.get(r.companyId) ?? 0) + haul);
    let s = 0;
    for (let k = 1; k < r.points.length; k++) {
      const [ax, az] = r.points[k - 1];
      const [bx, bz] = r.points[k];
      const len = Math.hypot(bx - ax, bz - az);
      const n = Math.max(1, Math.round(len / TILE));
      for (let m = 0; m < n; m++) {
        const x0 = ax + ((bx - ax) * m) / n, z0 = az + ((bz - az) * m) / n;
        const x1 = ax + ((bx - ax) * (m + 1)) / n, z1 = az + ((bz - az) * (m + 1)) / n;
        const key = `${r.companyId}:${Math.round((x0 + x1) * 5)}:${Math.round((z0 + z1) * 5)}`;
        let st = steps.get(key);
        if (!st) { st = { company: r.companyId, x0, z0, x1, z1, s0: s + (len * m) / n, haul: 0 }; steps.set(key, st); }
        st.haul += haul;
      }
      s += len;
    }
  }
  let maxStep = 1e-6;
  for (const st of steps.values()) maxStep = Math.max(maxStep, st.haul);
  let maxCo = 1e-6;
  for (const h of companyHaul.values()) maxCo = Math.max(maxCo, h);

  const colors = new Map<string, THREE.Color>();
  const speeds = new Map<string, { speed: number; phase: number }>();
  for (const [id, h] of companyHaul) {
    colors.set(id, new THREE.Color(id === youCompany ? OUTLINE.mine : companyColor(id)));
    // negative: chevrons stream toward the HQ, where the output lands
    const speed = h > 0 ? -(0.5 + 1.6 * Math.sqrt(h / maxCo)) : 0;
    speeds.set(id, { speed, phase: continuous(prev, next, id, speed, SPACING_RIB, t, 0) });
  }

  const batch = new Batch();
  for (const st of steps.values()) {
    const len = Math.hypot(st.x1 - st.x0, st.z1 - st.z0) || 1;
    const dx = (st.x1 - st.x0) / len;
    const dz = (st.z1 - st.z0) / len;
    const w = Math.sqrt(st.haul / maxStep);
    const hw = 0.035 + 0.11 * w;
    const lane = laneOf(st.company);
    // world-fixed offset axis (not direction-relative) so opposite-running companies never land in the same lane
    const off = lane * 0.11;
    const ox = Math.abs(dx) > 0.5 ? 0 : off;
    const oz = Math.abs(dx) > 0.5 ? off : 0;
    const y = RIB_Y + lane * 0.002;
    const { speed, phase } = speeds.get(st.company)!;
    const c = colors.get(st.company)!;
    const act = st.haul > 0 ? 1 : 0;
    // square caps (extend by the half width) close the joint at street corners
    batch.pair(st.x0 - dx * hw + ox, y, st.z0 - dz * hw + oz, dx, 0, dz, st.s0 - hw, hw, speed, phase, act, 0, c, false);
    batch.pair(st.x1 + dx * hw + ox, y, st.z1 + dz * hw + oz, dx, 0, dz, st.s0 + len + hw, hw, speed, phase, act, 0, c, true);
  }
  return batch.geometry();
}

function OwnArcs({ snap, co }: { snap: EconomySnapshot; co: CompanyView }) {
  const material = useMemo(() => flowMaterial(false), []);
  const motion = useRef(new Map<string, Motion>());
  const hub = useMemo(() => snap.world.tiles.find((t) => t.id === co.hubTileId) ?? null, [snap.world.tiles, co.hubTileId]);
  const geometry = useMemo(() => {
    const next = new Map<string, Motion>();
    const g = arcGeometry(hub ? ownFlows(snap, co, hub) : [], motion.current, next, TIME.value);
    motion.current = next;
    return g;
  }, [snap, co, hub]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);
  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={5} raycast={() => null} />;
}

function HaulRibbons({ snap, roads, youCompany }: { snap: EconomySnapshot; roads: RoadNet; youCompany: string | null }) {
  const material = useMemo(() => flowMaterial(true), []);
  const motion = useRef(new Map<string, Motion>());
  const geometry = useMemo(() => {
    const next = new Map<string, Motion>();
    const g = ribbonGeometry(snap, roads, youCompany, motion.current, next, TIME.value);
    motion.current = next;
    return g;
  }, [snap, roads, youCompany]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);
  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={4} raycast={() => null} />;
}

interface Badge { id: string; good: Good; rate: number; color: string; pos: THREE.Vector3 }

/**
 * Floating good icons over every live plant: what it makes and how many
 * units it turned out this tick (sim utilization × base throughput). A 4 Hz
 * camera-distance pass keeps only the nearest few as DOM (as Labels does).
 */
function GoodBadges({ snap, youCompany }: { snap: EconomySnapshot; youCompany: string | null }) {
  const badges = useMemo(() => {
    const { width, height } = snap.world;
    const out: Badge[] = [];
    for (const t of snap.world.tiles) {
      const b = t.building;
      if (!b?.live || t.hq) continue;
      const r = RECIPES[b.type];
      const [good, q] = Object.entries(r.outputs)[0] as [Good, number];
      const [wx, wz] = tileToWorld(t.x, t.y, width, height);
      out.push({
        id: t.id, good, rate: b.utilization * r.baseThroughput * q,
        color: b.companyId === youCompany ? OUTLINE.mine : companyColor(b.companyId),
        pos: new THREE.Vector3(wx, buildingHeight(b.type, t.x, t.y) + 0.9, wz),
      });
    }
    return out;
  }, [snap.world, youCompany]);

  const scores = useMemo(() => new Float32Array(badges.length), [badges]);
  const order = useMemo(() => badges.map((_, i) => i), [badges]);
  const byId = useMemo(() => new Map(badges.map((b) => [b.id, b] as const)), [badges]);
  const [shown, setShown] = useState<readonly string[]>([]);
  const shownKey = useRef("");
  const acc = useRef(BADGE_TICK);

  useFrame(({ camera }, dt) => {
    acc.current += dt;
    if (acc.current < BADGE_TICK) return;
    acc.current = 0;
    for (let i = 0; i < badges.length; i++) {
      const d = camera.position.distanceTo(badges[i].pos);
      scores[i] = d > BADGE_DIST ? Infinity : d;
    }
    order.sort((a, b) => scores[a] - scores[b]);
    let n = 0;
    while (n < order.length && n < MAX_BADGES && scores[order[n]] !== Infinity) n++;
    let key = "";
    for (let i = 0; i < n; i++) key += `${badges[order[i]].id},`;
    if (key === shownKey.current) return;
    shownKey.current = key;
    setShown(order.slice(0, n).map((i) => badges[i].id));
  });

  return (
    <>
      {shown.map((id) => {
        const b = byId.get(id);
        if (!b) return null;
        return (
          <Html key={b.id} position={b.pos} center zIndexRange={[9, 0]} style={{ pointerEvents: "none" }}>
            <div
              className="flex items-center gap-1 whitespace-nowrap rounded-full bg-black/70 py-0.5 pl-0.5 pr-2 text-[10px] font-semibold tabular-nums text-white shadow-md backdrop-blur-sm"
              style={{ boxShadow: `0 0 0 1px ${b.color}`, opacity: b.rate > 0 ? 1 : 0.55 }}
            >
              <GoodIcon good={b.good} size={18} />
              {b.rate > 0 ? `${num(b.rate, b.rate < 10 ? 1 : 0)}/t` : "idle"}
            </div>
          </Html>
        );
      })}
    </>
  );
}

/**
 * The economy drawn on the map. Always on (world view): your company's
 * goods arcing between plants and HQ, cargo pellets tinted by good and
 * moving at a speed set by this tick's volume. Logistics layer: every
 * company's haul routes as glowing street ribbons sized by freight weight,
 * plus what each plant makes. Two draws total; all motion is in the shader.
 */
export function Flows({ snap, you, roads }: { snap: EconomySnapshot; you: PlayerView | null; roads: RoadNet }) {
  const layer = useUi((s) => s.layer);
  const interior = useUi((s) => s.interiorTile);
  const co = you?.company ?? null;
  useFrame((state) => { TIME.value = state.clock.elapsedTime; });
  const logistics = layer === "logistics";
  return (
    <group>
      {co && !interior && (layer === "world" || logistics) && <OwnArcs snap={snap} co={co} />}
      {logistics && <HaulRibbons snap={snap} roads={roads} youCompany={co?.id ?? null} />}
      {logistics && <GoodBadges snap={snap} youCompany={co?.id ?? null} />}
    </group>
  );
}
