"use client";

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { RECIPES, type Good } from "@econ-sim/sim/goods";
import type { CompanyView } from "@econ-sim/sim/protocol";
import type { EconomySnapshot } from "@econ-sim/sim/snapshot";
import { GOOD_TINT } from "../ui/GoodIcon.tsx";
import { compact, fmtCr, titleCase } from "../../lib/format.ts";
import { sound } from "../../lib/sound.ts";
import { useWorld } from "../../lib/world.ts";
import { BUILDING_STYLE, OUTLINE, TILE } from "./world-style.ts";

/** Pooled DOM popups; never more exist, whatever the company size. */
const CAP = 16;
/** New popups per tick: ticks (800 ms) outpace LIFE, so two generations overlap without starving. */
const PER_TICK = CAP / 2;
const LIFE = 1.6;
const RISE = 1.2;
/** Production popups beyond this camera distance are skipped (matches the label LOD). */
const RANGE = 110;
/** Your HQ's P&L survives further out, like your own name label. */
const HQ_RANGE = 160;
const GAIN = OUTLINE.mine;
const LOSS = "#fb7185";

const PILL = "flex items-center gap-1 whitespace-nowrap rounded-full bg-black/70 px-2 py-0.5 text-[11px] font-semibold leading-tight shadow-md";
const PILL_BIG = "flex items-center gap-1 whitespace-nowrap rounded-full bg-black/75 px-2.5 py-0.5 text-[13px] font-bold leading-tight shadow-lg";

type Tile = EconomySnapshot["world"]["tiles"][number];

interface Props {
  snap: EconomySnapshot;
  /** `you.company`; null while spectating or before founding. */
  youCompany: CompanyView | null;
}

/**
 * The economy made visible: every tick your producing buildings float what
 * they just made, your HQ floats the tick's net P&L, and a building going
 * live fires a burst. Everything is pooled and animated imperatively — no
 * React renders after mount.
 */
export function Popups({ snap, youCompany }: Props) {
  return (
    <>
      <TickPopups snap={snap} youCompany={youCompany} />
      <CompletionBursts snap={snap} youCompany={youCompany} />
    </>
  );
}

// ───────────────────────────── Tick popups ─────────────────────────────

interface Slot {
  el: HTMLDivElement;
  dot: HTMLSpanElement;
  value: HTMLSpanElement;
  label: HTMLSpanElement;
  active: boolean;
  /** Clock time the rise starts; NaN = schedule on the next frame (`delay` later). */
  t0: number;
  delay: number;
  x: number;
  y: number;
  z: number;
  /** CSS offset from the projected point; constant strings so the frame loop never builds them. */
  anchor: string;
}

/** Pill sits centered above its point, or beside it (HQ: P&L to the west, the HQ building's goods to the east). */
const CENTER = "translate(-50%,-100%)";
const WEST = "translate(calc(-100% - 3px),-100%)";
const EAST = "translate(3px,-100%)";

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _frustum = new THREE.Frustum();

function inView(camera: THREE.Camera, x: number, y: number, z: number, range: number): boolean {
  _v.set(x, y, z);
  return _v.distanceTo(camera.position) <= range && _frustum.containsPoint(_v);
}

function freeSlot(slots: Slot[]): Slot | null {
  for (const s of slots) if (!s.active) return s;
  return null;
}

/** Fill a pooled pill; content is written once here, the frame loop only moves and fades it. */
function launch(s: Slot, x: number, y: number, z: number, anchor: string, delay: number, value: string, color: string, label: string, dot: string | null, big: boolean): void {
  s.active = true;
  s.t0 = Number.NaN;
  s.delay = delay;
  s.x = x;
  s.y = y;
  s.z = z;
  s.anchor = anchor;
  s.el.className = big ? PILL_BIG : PILL;
  s.el.style.display = "none";
  s.value.textContent = value;
  s.value.style.color = color;
  s.label.textContent = label;
  s.label.style.display = label ? "" : "none";
  s.dot.style.display = dot ? "" : "none";
  if (dot) s.dot.style.background = dot;
}

/** Back-out overshoot for the pop-in. */
function backOut(t: number): number {
  const c = 1.7;
  const u = t - 1;
  return 1 + (c + 1) * u * u * u + c * u * u;
}

/**
 * Per-tick production and P&L popups. Quantities are exactly what the sim
 * produced: `Company.produceTick` sets `lastUtilization = units / baseThroughput`
 * and adds `outputs[g] * units` to inventory, so `round(utilization *
 * baseThroughput) * outputs[g]` recovers this tick's output per building.
 */
function TickPopups({ snap, youCompany }: Props) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const connected = useThree((s) => s.events.connected as HTMLElement | undefined);
  const slots = useRef<Slot[]>([]);
  const busy = useRef(false);
  const lastTick = useRef<number | null>(null);

  useEffect(() => {
    const target = connected ?? (gl.domElement.parentNode as HTMLElement | null);
    if (!target) return;
    // One overlay above the name labels (their z-range tops out at 10).
    const root = document.createElement("div");
    root.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:11;";
    const pool: Slot[] = [];
    for (let i = 0; i < CAP; i++) {
      const el = document.createElement("div");
      el.style.cssText = "position:absolute;left:0;top:0;display:none;will-change:transform,opacity;";
      const dot = document.createElement("span");
      dot.className = "inline-block h-2 w-2 shrink-0 rounded-full ring-1 ring-white/40";
      const value = document.createElement("span");
      value.className = "tabular-nums";
      const label = document.createElement("span");
      label.className = "font-medium text-white/75";
      el.append(dot, value, label);
      root.append(el);
      pool.push({ el, dot, value, label, active: false, t0: Number.NaN, delay: 0, x: 0, y: 0, z: 0, anchor: CENTER });
    }
    target.append(root);
    slots.current = pool;
    return () => {
      root.remove();
      slots.current = [];
    };
  }, [gl, connected]);

  useEffect(() => {
    const prev = lastTick.current;
    lastTick.current = snap.tick;
    // First paint (or a reconnect replay) never fires: popups mean "just now".
    if (prev === null || snap.tick <= prev || !youCompany || youCompany.bankrupt) return;
    const pool = slots.current;
    if (pool.length === 0) return;

    camera.updateMatrixWorld();
    _m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_m);
    const { width, height } = snap.world;
    const hub: Tile | undefined = snap.world.tiles.find((t) => t.id === youCompany.hubTileId);
    const hubH = hub?.building ? BUILDING_STYLE[hub.building.type].height : 0.4;
    let budget = PER_TICK;

    const net = youCompany.lastPnl.net;
    if (net !== 0 && hub) {
      const x = (hub.x - width / 2) * TILE;
      const z = (hub.y - height / 2) * TILE;
      // Above the HQ name pill (hubH + 0.7); beside the HQ building's goods popup when the tile produces.
      const y = hubH + (hub.building ? 1.3 : 1.6);
      const s = inView(camera, x, y, z, HQ_RANGE) ? freeSlot(pool) : null;
      if (s) {
        launch(s, x, y, z, hub.building ? WEST : CENTER, 0, fmtCr(net, { sign: true }), net > 0 ? GAIN : LOSS, "", null, true);
        budget--;
      }
    }

    // Nearest producers first so a big company still shows what's on screen.
    const cands: { x: number; y: number; z: number; d: number; anchor: string; good: Good; qty: number }[] = [];
    for (const b of youCompany.buildings) {
      if (!b.live || b.utilization <= 0) continue;
      const r = RECIPES[b.type];
      const units = Math.round(b.utilization * r.baseThroughput);
      if (units <= 0) continue;
      const x = (b.x - width / 2) * TILE;
      const z = (b.y - height / 2) * TILE;
      const hq = b.tileId === youCompany.hubTileId;
      const y = BUILDING_STYLE[b.type].height + (hq ? 1.3 : 0.3);
      if (!inView(camera, x, y, z, RANGE)) continue;
      const d = _v.distanceTo(camera.position);
      let stack = 0;
      for (const g in r.outputs) {
        const qty = (r.outputs[g as Good] ?? 0) * units;
        if (qty > 0) cands.push({ x, y: y + stack++ * 0.9, z, d, anchor: hq ? EAST : CENTER, good: g as Good, qty });
      }
    }
    cands.sort((a, z) => a.d - z.d);
    for (let i = 0; i < cands.length && budget > 0; i++) {
      const s = freeSlot(pool);
      if (!s) break;
      const c = cands[i];
      // Near-to-far cascade with a little jitter reads as a living city, not a strobe.
      launch(s, c.x, c.y, c.z, c.anchor, 0.06 * i + Math.random() * 0.12, `+${compact(c.qty, 0)}`, GAIN, titleCase(c.good), GOOD_TINT[c.good], false);
      budget--;
    }
    busy.current = true;
  }, [snap, youCompany, camera]);

  useFrame((state) => {
    if (!busy.current) return;
    const now = state.clock.elapsedTime;
    const { width, height } = state.size;
    let any = false;
    for (const s of slots.current) {
      if (!s.active) continue;
      any = true;
      if (Number.isNaN(s.t0)) s.t0 = now + s.delay;
      const t = (now - s.t0) / LIFE;
      if (t < 0) continue;
      if (t >= 1) {
        s.active = false;
        s.el.style.display = "none";
        continue;
      }
      const rise = 1 - (1 - t) * (1 - t) * (1 - t);
      _v.set(s.x, s.y + RISE * rise, s.z).project(state.camera);
      if (_v.z > 1) {
        s.el.style.display = "none";
        continue;
      }
      const sx = (_v.x * 0.5 + 0.5) * width;
      const sy = (-_v.y * 0.5 + 0.5) * height;
      const scale = t < 0.14 ? 0.6 + 0.4 * backOut(t / 0.14) : 1;
      const alpha = t < 0.08 ? t / 0.08 : t > 0.55 ? (1 - t) / 0.45 : 1;
      s.el.style.display = "";
      s.el.style.opacity = alpha.toFixed(3);
      s.el.style.transform = `translate3d(${sx.toFixed(1)}px,${sy.toFixed(1)}px,0) ${s.anchor} scale(${scale.toFixed(3)})`;
    }
    busy.current = any;
  });

  return null;
}

// ─────────────────────────── Completion bursts ───────────────────────────

const BURSTS = 4;
const PER_BURST = 48;
const PARTICLES = BURSTS * PER_BURST;
const BURST_LIFE = 1.4;
const GRAVITY = 9;
/** Burst start sentinel: armed by an event, stamped with clock time on the next frame. */
const ARMED = -1;

/** Gold, mint and white sparks; > 1 so they catch the bloom pass (threshold 1). */
const SPARKS = [new THREE.Color("#ffd27a").multiplyScalar(2.6), new THREE.Color(GAIN).multiplyScalar(2.4), new THREE.Color("#ffffff").multiplyScalar(2.2)];
const RING_COLOR = new THREE.Color(GAIN).multiplyScalar(2.2);

/** Soft round sprite so points read as glowing sparks, not squares. */
function sparkTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.35, "rgba(255,255,255,0.7)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Construction-complete celebration for YOUR buildings: a spark fountain off
 * the roof, a halo ring rising up the facade and a ground shockwave, plus the
 * `complete` cue. Fixed pool of BURSTS (one Points draw + 2 rings each);
 * a fifth simultaneous completion recycles the oldest.
 */
function CompletionBursts({ snap, youCompany }: Props) {
  const { events } = useWorld();
  const seen = useRef<number | null>(null);
  const busy = useRef(false);

  const fx = useMemo(() => {
    const pos = new Float32Array(PARTICLES * 3);
    const col = new Float32Array(PARTICLES * 3);
    const geom = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    const colAttr = new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute("position", posAttr);
    geom.setAttribute("color", colAttr);
    const map = sparkTexture();
    const mat = new THREE.PointsMaterial({
      size: 0.34, map, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    });
    const points = new THREE.Points(geom, mat);
    points.frustumCulled = false;
    points.visible = false;
    points.renderOrder = 10;

    const ringGeom = new THREE.RingGeometry(0.86, 1, 64).rotateX(-Math.PI / 2);
    const rings: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>[] = [];
    for (let i = 0; i < BURSTS * 2; i++) {
      const m = new THREE.MeshBasicMaterial({
        color: RING_COLOR, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
      });
      const ring = new THREE.Mesh(ringGeom, m);
      ring.visible = false;
      ring.renderOrder = 10;
      rings.push(ring);
    }
    return {
      pos, col, posAttr, colAttr, geom, mat, map, points, ringGeom, rings,
      vel: new Float32Array(PARTICLES * 3),
      tint: new Float32Array(PARTICLES * 3),
      start: new Float64Array(BURSTS).fill(Number.NaN),
      origin: new Float32Array(BURSTS * 3), // x, z, building height
    };
  }, []);

  useEffect(() => () => {
    fx.geom.dispose();
    fx.mat.dispose();
    fx.map.dispose();
    fx.ringGeom.dispose();
    for (const r of fx.rings) r.material.dispose();
  }, [fx]);

  useEffect(() => {
    if (events.length === 0) return;
    const newest = events[events.length - 1].tick;
    const since = seen.current;
    seen.current = since === null ? newest : Math.max(since, newest);
    if (since === null || !youCompany) return; // first paint: don't replay history
    let fired = false;
    for (const e of events) {
      if (e.tick <= since || e.kind !== "build_live" || e.companyId !== youCompany.id) continue;
      const b = youCompany.buildings.find((x) => x.id === e.buildingId);
      if (!b) continue;
      const h = BUILDING_STYLE[b.type].height;
      fire(fx, (b.x - snap.world.width / 2) * TILE, h, (b.y - snap.world.height / 2) * TILE);
      fired = true;
    }
    if (fired) {
      sound.play("complete");
      busy.current = true;
    }
  }, [events, youCompany, snap.world.width, snap.world.height, fx]);

  useFrame((state, delta) => {
    if (!busy.current) return;
    const now = state.clock.elapsedTime;
    const dt = Math.min(delta, 0.05);
    const { pos, col, vel, tint, start, origin, rings } = fx;
    const drag = Math.exp(-1.6 * dt);
    let any = false;
    for (let b = 0; b < BURSTS; b++) {
      if (start[b] === ARMED) start[b] = now;
      const s0 = start[b];
      if (Number.isNaN(s0)) continue;
      const t = (now - s0) / BURST_LIFE;
      const p0 = b * PER_BURST * 3;
      const p1 = p0 + PER_BURST * 3;
      const halo = rings[b * 2];
      const wave = rings[b * 2 + 1];
      if (t >= 1) {
        start[b] = Number.NaN;
        col.fill(0, p0, p1);
        halo.visible = wave.visible = false;
        continue;
      }
      any = true;
      const fade = (1 - t) ** 1.6;
      for (let i = p0; i < p1; i += 3) {
        vel[i + 1] -= GRAVITY * dt;
        vel[i] *= drag;
        vel[i + 2] *= drag;
        pos[i] += vel[i] * dt;
        pos[i + 1] += vel[i + 1] * dt;
        pos[i + 2] += vel[i + 2] * dt;
        if (pos[i + 1] < 0.08) {
          pos[i + 1] = 0.08;
          vel[i + 1] *= -0.3;
        }
        col[i] = tint[i] * fade;
        col[i + 1] = tint[i + 1] * fade;
        col[i + 2] = tint[i + 2] * fade;
      }
      const ox = origin[b * 3];
      const oz = origin[b * 3 + 1];
      const h = origin[b * 3 + 2];
      // Halo: climbs from the ground to just above the roof, narrowing as it fades.
      const ta = Math.min(1, t / 0.85);
      const ea = 1 - (1 - ta) ** 3;
      halo.visible = ta < 1;
      halo.position.set(ox, 0.2 + (h + 0.8) * ea, oz);
      halo.scale.setScalar(TILE * (0.62 - 0.18 * ea));
      halo.material.opacity = (1 - ta) * (1 - ta);
      // Shockwave: a fast ground ring spreading over the neighbouring parcels.
      const tb = Math.min(1, t / 0.6);
      wave.visible = tb < 1;
      wave.position.set(ox, 0.06, oz);
      wave.scale.setScalar(TILE * (0.4 + 1.1 * (1 - (1 - tb) ** 3)));
      wave.material.opacity = 0.6 * (1 - tb) * (1 - tb);
    }
    fx.posAttr.needsUpdate = true;
    fx.colAttr.needsUpdate = true;
    fx.points.visible = any;
    busy.current = any;
  });

  return (
    <>
      <primitive object={fx.points} />
      {fx.rings.map((r, i) => <primitive key={i} object={r} />)}
    </>
  );
}

type Fx = {
  pos: Float32Array; vel: Float32Array; tint: Float32Array; col: Float32Array;
  start: Float64Array; origin: Float32Array; points: THREE.Points;
};

/** Arm a burst slot (free one, else the oldest) and seed its sparks on the roof. */
function fire(fx: Fx, x: number, h: number, z: number): void {
  let slot = 0;
  let oldest = Infinity;
  for (let b = 0; b < BURSTS; b++) {
    const s = fx.start[b];
    if (Number.isNaN(s)) { slot = b; break; }
    if (s < oldest) { oldest = s; slot = b; }
  }
  fx.start[slot] = ARMED;
  fx.origin[slot * 3] = x;
  fx.origin[slot * 3 + 1] = z;
  fx.origin[slot * 3 + 2] = h;
  const roof = h * 0.9;
  for (let p = 0; p < PER_BURST; p++) {
    const i = (slot * PER_BURST + p) * 3;
    const a = Math.random() * Math.PI * 2;
    const out = 1.2 + Math.random() * 2.8;
    fx.pos[i] = x + Math.cos(a) * 0.3;
    fx.pos[i + 1] = roof;
    fx.pos[i + 2] = z + Math.sin(a) * 0.3;
    fx.vel[i] = Math.cos(a) * out;
    fx.vel[i + 1] = 4 + Math.random() * 4.5;
    fx.vel[i + 2] = Math.sin(a) * out;
    const c = SPARKS[p % SPARKS.length];
    fx.tint[i] = c.r;
    fx.tint[i + 1] = c.g;
    fx.tint[i + 2] = c.b;
    fx.col[i] = fx.col[i + 1] = fx.col[i + 2] = 0;
  }
  fx.points.visible = true;
}
