"use client";

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import type { BuildingType, Good } from "@econ-sim/sim/goods";
import { GOODS, RECIPES } from "@econ-sim/sim/goods";
import type { EconomySnapshot } from "@econ-sim/sim/snapshot";
import { BUILDING_STYLE, RES_LABEL, WALL, hash2, tileToWorld } from "./world-style.ts";
import { C, box, boxUp, cone, cyl, merge, tintedStandardMaterial, xf, type Part } from "./geometry.ts";
import { GOOD_TINT, GoodIcon } from "../ui/GoodIcon.tsx";
import { titleCase } from "../../lib/format.ts";
import { useUi } from "../../lib/store.ts";

type Tile = EconomySnapshot["world"]["tiles"][number];
type Line = "extractor" | "processor" | "factory";

/** Footprint half-size: building bodies span ~1.8 of the 2.2 tile. */
const HALF = 0.9;
const WALL_T = 0.08;
const FLOOR = 0.04;
/** Belt top surface; crates ride on it. */
const BELT_Y = 0.27;
const BELT_X1 = 0.66;
/** Walls facing the camera drop to sill height so the floor always reads (dollhouse cut). */
const LOW_WALL = 0.2;
const CRATES = 7;
const MAX_WORKERS = 4;
const ENTER_S = 0.4;
const ROOF_S = 0.6;
/** Belt loops per second at full speed (fraction of its length). */
const BELT_RATE = 0.22;
/** Worker shuttle cycles per second at full speed. */
const WALK_RATE = 0.16;

const FLOOR_COLOR = "#b5ad9a";
const CUT_COLOR = "#efe8d6";
const GLOW: Record<Line, string> = { extractor: "#ffb547", processor: "#ff6a1f", factory: "#8fe3ff" };
const VESTS = ["#ff8a1f", "#c6f24e", "#ffd23f", "#ff8a1f"].map((c) => new THREE.Color(c));
const LIQUID: Partial<Record<Good, true>> = { crude_oil: true, water: true, fuel: true };

/** Wall slabs, outward normal in xz; the ±x walls are shortened to butt into the ±z ones. */
const WALLS = [
  { x: 0, z: -HALF + WALL_T / 2, sx: HALF * 2, sz: WALL_T, nx: 0, nz: -1 },
  { x: 0, z: HALF - WALL_T / 2, sx: HALF * 2, sz: WALL_T, nx: 0, nz: 1 },
  { x: -HALF + WALL_T / 2, z: 0, sx: WALL_T, sz: HALF * 2 - WALL_T * 2, nx: -1, nz: 0 },
  { x: HALF - WALL_T / 2, z: 0, sx: WALL_T, sz: HALF * 2 - WALL_T * 2, nx: 1, nz: 0 },
] as const;

/** Worker shuttles: aisle (z) and the two stations (x) they walk between. */
const ROUTES = [
  { z: 0.55, a: -0.42, b: 0.02 },
  { z: -0.55, a: -0.02, b: 0.42 },
  { z: 0.55, a: 0.12, b: 0.42 },
  { z: -0.55, a: -0.42, b: -0.12 },
] as const;
const WALK_START = [0, 0.3, 0.55, 0.8];

const dummy = new THREE.Object3D();

function lineOf(type: BuildingType): Line {
  const r = RECIPES[type];
  if (Object.keys(r.inputs).length === 0) return "extractor";
  const out = Object.keys(r.outputs)[0] as Good;
  return GOODS[out].category === "finished" ? "factory" : "processor";
}

const easeOut = (k: number) => 1 - (1 - k) ** 3;
const clamp01 = (k: number) => (k < 0 ? 0 : k > 1 ? 1 : k);

/* ───────────────────────── procedural kit ───────────────────────── */

interface MoverSpec { geo: THREE.BufferGeometry; at: [number, number, number]; ry: number; kind: "drill" | "stamp" | "swing"; phase: number }

interface Kit {
  line: Line;
  /** static machinery + stock, vertex coloured */
  body: THREE.BufferGeometry;
  /** emissive parts (furnace mouths, beacons, bench lamps): one material, intensity follows utilization */
  glow: THREE.BufferGeometry;
  movers: MoverSpec[];
  beltX0: number;
  /** belt x where crates change from input to output colour (−∞: extractors carry output only) */
  swapX: number;
  inColors: THREE.Color[];
  outColor: THREE.Color;
}

/** Input/output stock: bins with a heap for bulk raws, barrels for liquids, crate stacks for parts. */
function stock(parts: Part[], good: Good, x: number, z: number) {
  const tint = GOOD_TINT[good];
  parts.push({ geo: boxUp(0.32, 0.04, 0.3, x, FLOOR, z), color: C.pallet, tint: false });
  const y = FLOOR + 0.04;
  if (LIQUID[good]) {
    for (const [dx, dz] of [[-0.07, -0.07], [0.07, -0.07], [-0.07, 0.07], [0.07, 0.07]]) {
      parts.push({ geo: cyl(0.06, 0.06, 0.16, x + dx, y, z + dz, 10), color: tint, tint: false });
      parts.push({ geo: cyl(0.062, 0.062, 0.015, x + dx, y + 0.11, z + dz, 10), color: C.dark, tint: false });
    }
  } else if (GOODS[good].category === "raw") {
    parts.push({ geo: boxUp(0.3, 0.12, 0.02, x, y, z - 0.13), color: C.pipe, tint: false });
    parts.push({ geo: boxUp(0.3, 0.12, 0.02, x, y, z + 0.13), color: C.pipe, tint: false });
    parts.push({ geo: boxUp(0.02, 0.12, 0.24, x - 0.14, y, z), color: C.pipe, tint: false });
    parts.push({ geo: boxUp(0.02, 0.12, 0.24, x + 0.14, y, z), color: C.pipe, tint: false });
    parts.push({ geo: boxUp(0.26, 0.1, 0.24, x, y, z), color: tint, tint: false });
    parts.push({ geo: cone(0.13, 0.09, x, y + 0.1, z, 7), color: tint, tint: false });
  } else {
    for (const [dx, dz] of [[-0.07, -0.065], [0.07, -0.065], [-0.07, 0.065], [0.07, 0.065]]) {
      parts.push({ geo: boxUp(0.12, 0.1, 0.11, x + dx, y, z + dz), color: tint, tint: false });
    }
    parts.push({ geo: boxUp(0.12, 0.1, 0.11, x - 0.07, y + 0.1, z - 0.065), color: tint, tint: false });
    parts.push({ geo: boxUp(0.12, 0.1, 0.11, x + 0.07, y + 0.1, z + 0.02, 0.3), color: tint, tint: false });
  }
}

function conveyor(parts: Part[], x0: number, x1: number) {
  const len = x1 - x0, mid = (x0 + x1) / 2;
  parts.push({ geo: boxUp(len, 0.03, 0.22, mid, BELT_Y - 0.03, 0), color: "#2b2d31", tint: false });
  for (const z of [-0.12, 0.12]) {
    parts.push({ geo: boxUp(len, 0.05, 0.02, mid, BELT_Y - 0.035, z), color: C.steel, tint: false });
    for (const x of [x0 + 0.05, mid, x1 - 0.05]) parts.push({ geo: boxUp(0.025, BELT_Y - 0.03 - FLOOR, 0.025, x, FLOOR, z * 0.85), color: C.pipe, tint: false });
  }
  for (const x of [x0, x1]) parts.push({ geo: xf(new THREE.CylinderGeometry(0.03, 0.03, 0.22, 8), x, BELT_Y - 0.025, 0, Math.PI / 2), color: C.steel, tint: false });
}

/**
 * One production line per building category, laid out along +x: stock →
 * machine(s) → belt → output pallets, aisles at z = ±0.55 for the workers.
 * Extractors drill a pit and feed a hopper + crusher; processors run a furnace
 * and a drop press; factories have robot arms over the belt at two benches.
 */
function buildKit(type: BuildingType): Kit {
  const recipe = RECIPES[type];
  const inputs = Object.keys(recipe.inputs) as Good[];
  const output = Object.keys(recipe.outputs)[0] as Good;
  const line = lineOf(type);
  const accent = BUILDING_STYLE[type].color;
  const wallH = wallHeight(type);
  const body: Part[] = [];
  const glow: Part[] = [];
  const movers: MoverSpec[] = [];
  const add = (geo: THREE.BufferGeometry, color: string) => body.push({ geo, color, tint: false });
  const lit = (geo: THREE.BufferGeometry) => glow.push({ geo, color: "#ffffff", tint: false });

  const beltX0 = line === "extractor" ? -0.22 : -0.48;
  conveyor(body, beltX0, BELT_X1);
  stock(body, output, 0.64, 0.52);
  stock(body, output, 0.64, -0.52);
  let swapX = -Infinity;

  if (line === "extractor") {
    const rigH = Math.min(1.5, wallH + 0.3);
    const px = -0.55;
    // pit + spoil heap
    add(cyl(0.25, 0.25, 0.012, px, FLOOR, 0, 16), C.concrete);
    add(cyl(0.2, 0.2, 0.014, px, FLOOR, 0, 16), C.coal);
    add(cone(0.15, 0.12, -0.64, FLOOR, 0.55, 7), GOOD_TINT[output]);
    add(cone(0.1, 0.08, -0.7, FLOOR, -0.5, 7), GOOD_TINT[output]);
    // derrick: four legs, mid braces, top deck, motor
    for (const [dx, dz] of [[-0.18, -0.18], [0.18, -0.18], [-0.18, 0.18], [0.18, 0.18]]) add(boxUp(0.04, rigH, 0.04, px + dx, FLOOR, dz), C.dark);
    for (const dz of [-0.18, 0.18]) add(box(0.36, 0.025, 0.025, px, FLOOR + rigH * 0.5, dz), C.dark);
    for (const dx of [-0.18, 0.18]) add(box(0.025, 0.025, 0.36, px + dx, FLOOR + rigH * 0.5, 0), C.dark);
    // open crown frame (a solid deck would hide the drill from the steep interior camera) + motor on a crossbeam
    for (const dz of [-0.19, 0.19]) add(boxUp(0.44, 0.05, 0.06, px, FLOOR + rigH, dz), accent);
    for (const dx of [-0.19, 0.19]) add(boxUp(0.06, 0.05, 0.32, px + dx, FLOOR + rigH, 0), accent);
    add(boxUp(0.06, 0.04, 0.32, px, FLOOR + rigH - 0.05, 0), C.dark);
    add(boxUp(0.14, 0.12, 0.14, px, FLOOR + rigH - 0.19, 0), accent);
    for (const [dx, dz] of [[-0.19, -0.19], [0.19, -0.19], [-0.19, 0.19], [0.19, 0.19]]) lit(box(0.05, 0.05, 0.05, px + dx, FLOOR + rigH + 0.08, dz));
    const drill = merge([
      { geo: cyl(0.022, 0.022, rigH - 0.3, 0, 0.12, 0, 6), color: C.steel, tint: false },
      { geo: xf(new THREE.ConeGeometry(0.07, 0.16, 8), 0, 0.08, 0, Math.PI), color: C.rust, tint: false },
      { geo: box(0.15, 0.018, 0.03, 0, 0.28, 0), color: C.steel, tint: false },
      { geo: xf(new THREE.BoxGeometry(0.15, 0.018, 0.03), 0, 0.42, 0, 0, Math.PI / 2), color: C.steel, tint: false },
    ]);
    movers.push({ geo: drill, at: [px, FLOOR, 0], ry: 0, kind: "drill", phase: 0 });
    // incline from the pit up onto the belt
    add(xf(new THREE.BoxGeometry(0.28, 0.025, 0.16), -0.31, (FLOOR + 0.03 + BELT_Y) / 2, 0, 0, 0, 0.8), C.dark);
    // hopper over the belt, filled with the yield
    add(cyl(0.2, 0.07, 0.24, 0, BELT_Y + 0.06, 0, 10), C.steel);
    add(cone(0.17, 0.07, 0, BELT_Y + 0.3, 0, 10), GOOD_TINT[output]);
    for (const [dx, dz] of [[-0.15, -0.18], [0.15, -0.18], [-0.15, 0.18], [0.15, 0.18]]) add(boxUp(0.025, BELT_Y + 0.12 - FLOOR, 0.025, dx, FLOOR, dz), C.dark);
    // crusher tunnel
    for (const dz of [-0.16, 0.16]) add(boxUp(0.26, 0.24, 0.04, 0.32, FLOOR, dz), C.steel);
    add(boxUp(0.3, 0.07, 0.38, 0.32, FLOOR + 0.24, 0), accent);
    for (const dz of [-0.193, 0.193]) lit(box(0.2, 0.02, 0.01, 0.32, FLOOR + 0.27, dz));
  } else {
    for (const [k, z] of [-0.52, 0.52].entries()) stock(body, inputs[k % inputs.length], -0.64, z);
    // feed hopper at the head of the belt
    add(cyl(0.12, 0.05, 0.14, beltX0 + 0.08, BELT_Y + 0.04, 0, 8), C.steel);
  }

  if (line === "processor") {
    const fx = -0.12;
    swapX = fx;
    add(boxUp(0.34, 0.4, 0.44, fx, FLOOR, 0), C.rust);
    add(boxUp(0.36, 0.04, 0.46, fx, FLOOR + 0.28, 0), accent);
    add(boxUp(0.38, 0.05, 0.48, fx, FLOOR + 0.4, 0), C.dark);
    const chH = Math.max(0.45, wallH - 0.05);
    add(cyl(0.05, 0.06, chH, fx - 0.08, FLOOR + 0.45, -0.1, 8), C.stack);
    add(cyl(0.065, 0.065, 0.04, fx - 0.08, FLOOR + 0.45 + chH, -0.1, 8), C.stackTop);
    for (const dz of [-0.226, 0.226]) lit(box(0.18, 0.1, 0.012, fx, FLOOR + 0.14, dz));
    for (const dx of [-0.176, 0.176]) lit(box(0.012, 0.09, 0.2, fx + dx, BELT_Y + 0.03, 0));
    // drop press: posts + crossbar, the head is a mover
    const pxp = 0.34;
    for (const dz of [-0.17, 0.17]) add(boxUp(0.05, 0.62, 0.05, pxp, FLOOR, dz), C.dark);
    add(boxUp(0.16, 0.08, 0.42, pxp, FLOOR + 0.6, 0), accent);
    const head = merge([
      { geo: boxUp(0.13, 0.07, 0.22, 0, 0, 0), color: C.steel, tint: false },
      { geo: cyl(0.025, 0.025, 0.3, 0, 0.07, 0, 6), color: C.pipe, tint: false },
    ]);
    movers.push({ geo: head, at: [pxp, BELT_Y + 0.085, 0], ry: 0, kind: "stamp", phase: 0 });
  }

  if (line === "factory") {
    swapX = 0.3;
    const arm = () => merge([
      { geo: cyl(0.055, 0.065, 0.05, 0, 0, 0, 10), color: C.dark, tint: false },
      { geo: boxUp(0.045, 0.41, 0.045, 0, 0.05, 0), color: accent, tint: false },
      { geo: box(0.28, 0.04, 0.04, 0.12, 0.46, 0), color: accent, tint: false },
      { geo: boxUp(0.025, 0.08, 0.025, 0.24, 0.37, 0), color: C.steel, tint: false },
      { geo: box(0.06, 0.015, 0.045, 0.24, 0.37, 0), color: C.dark, tint: false },
    ]);
    for (const [k, [bx, side]] of ([[-0.12, -1], [0.3, 1]] as const).entries()) {
      const bz = side * 0.4;
      add(boxUp(0.42, 0.03, 0.14, bx, FLOOR + 0.17, bz), C.steel);
      for (const [dx, dz] of [[-0.19, -0.055], [0.19, -0.055], [-0.19, 0.055], [0.19, 0.055]]) add(boxUp(0.025, 0.17, 0.025, bx + dx, FLOOR, bz + dz), C.dark);
      add(boxUp(0.06, 0.05, 0.06, bx - 0.1, FLOOR + 0.2, bz), GOOD_TINT[inputs[k % inputs.length]]);
      add(boxUp(0.08, 0.045, 0.06, bx + 0.05, FLOOR + 0.2, bz), GOOD_TINT[output]);
      // bench lamp on a post at the aisle edge
      add(boxUp(0.02, 0.37, 0.02, bx + 0.19, FLOOR + 0.2, bz + side * 0.05), C.dark);
      add(box(0.24, 0.03, 0.07, bx + 0.02, FLOOR + 0.58, bz), C.dark);
      lit(box(0.22, 0.012, 0.05, bx + 0.02, FLOOR + 0.56, bz));
      // arm sits between bench and belt, sweeping over the belt
      movers.push({ geo: arm(), at: [bx, FLOOR, side * 0.22], ry: side * Math.PI / 2, kind: "swing", phase: k * 1.7 });
    }
  }

  return {
    line,
    body: merge(body),
    glow: merge(glow.length ? glow : [{ geo: box(0.001, 0.001, 0.001, 0, -1, 0), color: "#000", tint: false }]),
    movers,
    beltX0,
    swapX,
    inColors: (inputs.length ? inputs : [output]).map((g) => new THREE.Color(GOOD_TINT[g])),
    outColor: new THREE.Color(GOOD_TINT[output]),
  };
}

/** Cut walls stand at half the building's silhouette height, capped so tall types don't become a well that hides the line. */
function wallHeight(type: BuildingType): number {
  return Math.min(1.1, Math.max(0.75, BUILDING_STYLE[type].height * 0.5));
}

let shared: { unit: THREE.BufferGeometry; floor: THREE.BufferGeometry; roof: THREE.BufferGeometry; crate: THREE.BufferGeometry; worker: THREE.BufferGeometry } | null = null;

/** Geometry every cutaway uses; built once and kept for the session. */
function sharedGeometries() {
  if (shared) return shared;
  const unit = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const floor = merge([
    { geo: boxUp(HALF * 2 - 0.02, FLOOR, HALF * 2 - 0.02, 0, 0, 0), color: FLOOR_COLOR, tint: false },
    { geo: box(1.2, 0.004, 0.025, 0.02, FLOOR + 0.002, -0.4), color: C.crane, tint: false },
    { geo: box(1.2, 0.004, 0.025, 0.02, FLOOR + 0.002, 0.4), color: C.crane, tint: false },
  ]);
  const roof = boxUp(HALF * 2, 0.08, HALF * 2, 0, 0, 0);
  const crate = new THREE.BoxGeometry(0.09, 0.075, 0.09).translate(0, 0.0375, 0);
  // hi-vis vest takes the instance colour; hard-hat brim marks the facing (+z)
  const worker = merge([
    { geo: boxUp(0.06, 0.09, 0.04, 0, 0, 0), color: "#3b4252", tint: false },
    { geo: cyl(0.038, 0.048, 0.1, 0, 0.09, 0, 6), color: "#ffffff", tint: true },
    { geo: xf(new THREE.SphereGeometry(0.034, 7, 5), 0, 0.225, 0), color: "#e4c9a5", tint: false },
    { geo: cyl(0.036, 0.04, 0.025, 0, 0.24, 0, 8), color: C.crane, tint: false },
    { geo: box(0.05, 0.008, 0.03, 0, 0.243, 0.04), color: C.crane, tint: false },
  ]);
  shared = { unit, floor, roof, crate, worker };
  return shared;
}

/* ───────────────────────── components ───────────────────────── */

/**
 * Building cutaway (Capital Rift's "rooms" view, but alive): when
 * `useUi.interiorTile` points at a building, its roof lifts off and an open
 * interior rises in its place: cut sandstone walls, a production line themed by
 * category, crates riding the belt that change from input to output colour as
 * they pass the machine, and hard-hat workers shuttling between stations.
 * Belt, machines, workers and glow scale with utilization; idle stops and dims.
 * `I` toggles it for the selected building; selecting another tile steps out.
 */
export function Interior({ snap }: { snap: EconomySnapshot }) {
  const interiorTile = useUi((s) => s.interiorTile);
  const snapRef = useRef(snap);
  snapRef.current = snap;

  const tile = useMemo<Tile | null>(
    () => (interiorTile ? snap.world.tiles.find((t) => t.id === interiorTile) ?? null : null),
    [snap.world.tiles, interiorTile],
  );

  // The building vanished (demolished / bankrupt): step out instead of zooming at an empty lot.
  useEffect(() => {
    if (interiorTile && !tile?.building) useUi.getState().setInterior(null);
  }, [interiorTile, tile]);

  // Interior follows selection: picking another tile steps out.
  useEffect(() => useUi.subscribe((s, prev) => {
    if (s.selectedTile !== prev.selectedTile && s.interiorTile && s.interiorTile !== s.selectedTile) s.setInterior(null);
  }), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "KeyI" || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el instanceof HTMLElement && el.isContentEditable)) return;
      const ui = useUi.getState();
      if (ui.interiorTile) { ui.setInterior(null); return; }
      const id = ui.selectedTile;
      if (id && snapRef.current.world.tiles.find((t) => t.id === id)?.building) ui.setInterior(id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!tile?.building) return null;
  const [wx, wz] = tileToWorld(tile.x, tile.y, snap.world.width, snap.world.height);
  const b = tile.building;
  return <Cutaway key={tile.id} type={b.type} x={tile.x} y={tile.y} wx={wx} wz={wz} live={b.live} utilization={b.utilization} />;
}

interface CutawayProps { type: BuildingType; x: number; y: number; wx: number; wz: number; live: boolean; utilization: number }

function Cutaway({ type, x, y, wx, wz, live, utilization }: CutawayProps) {
  const geos = sharedGeometries();
  const kit = useMemo(() => buildKit(type), [type]);
  useEffect(() => () => {
    kit.body.dispose();
    kit.glow.dispose();
    for (const m of kit.movers) m.geo.dispose();
  }, [kit]);

  const mats = useMemo(() => {
    const wallColor = new THREE.Color(WALL[0]).lerp(new THREE.Color(WALL[1]), hash2(x, y, 7));
    return {
      wall: new THREE.MeshStandardMaterial({ color: wallColor, roughness: 0.85 }),
      cap: new THREE.MeshStandardMaterial({ color: CUT_COLOR, roughness: 0.9 }),
      floor: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }),
      roof: new THREE.MeshStandardMaterial({ color: C.roof, roughness: 0.8, transparent: true, depthWrite: false }),
      body: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.15 }),
      glow: new THREE.MeshStandardMaterial({ color: "#2a2420", emissive: GLOW[kit.line], emissiveIntensity: 0, roughness: 0.4 }),
      crate: new THREE.MeshStandardMaterial({ roughness: 0.7 }),
      worker: tintedStandardMaterial({ roughness: 0.7 }),
    };
  }, [x, y, kit.line]);
  useEffect(() => () => { for (const m of Object.values(mats)) m.dispose(); }, [mats]);

  const wallsRef = useRef<THREE.InstancedMesh>(null);
  const capsRef = useRef<THREE.InstancedMesh>(null);
  const roofRef = useRef<THREE.Mesh>(null);
  const contentsRef = useRef<THREE.Group>(null);
  const cratesRef = useRef<THREE.InstancedMesh>(null);
  const workersRef = useRef<THREE.InstancedMesh>(null);
  const moverRefs = useRef<(THREE.Group | null)[]>([]);
  const cardRef = useRef<THREE.Group>(null);
  const st = useRef({ t: 0, on: 0, speed: 0, ph: 0, belt: 0, walls: new Float32Array(4), init: false, walk: Float32Array.from(WALK_START) });

  useLayoutEffect(() => {
    const w = workersRef.current;
    if (!w) return;
    for (let i = 0; i < MAX_WORKERS; i++) w.setColorAt(i, VESTS[i]);
    if (w.instanceColor) w.instanceColor.needsUpdate = true;
  }, []);

  const wallH = wallHeight(type);
  const roofY = BUILDING_STYLE[type].height;
  const running = live && utilization > 0;
  const util = clamp01(utilization);

  useFrame(({ camera }, delta) => {
    const s = st.current;
    const d = Math.min(delta, 0.1);
    s.t += d;
    const k = 1 - Math.exp(-d * 2.5);
    s.on += ((running ? 1 : 0) - s.on) * k;
    s.speed += ((running ? 0.3 + 0.7 * util : 0) - s.speed) * k;
    s.ph += d * s.speed;
    const enter = easeOut(clamp01(s.t / ENTER_S));

    // walls: the ones facing the camera drop to sill height, the far ones stay at half height
    const walls = wallsRef.current, caps = capsRef.current;
    if (walls && caps) {
      const vx = camera.position.x - wx, vz = camera.position.z - wz;
      const vl = Math.hypot(vx, vz) || 1;
      const kw = 1 - Math.exp(-d * 8);
      for (let j = 0; j < 4; j++) {
        const W = WALLS[j];
        const target = (W.nx * vx + W.nz * vz) / vl > 0.35 ? LOW_WALL : wallH;
        s.walls[j] = s.init ? s.walls[j] + (target - s.walls[j]) * kw : target;
        const h = Math.max(0.001, s.walls[j] * enter);
        dummy.rotation.set(0, 0, 0);
        dummy.position.set(W.x, 0, W.z);
        dummy.scale.set(W.sx, h, W.sz);
        dummy.updateMatrix();
        walls.setMatrixAt(j, dummy.matrix);
        dummy.position.y = h;
        dummy.scale.set(W.sx + 0.02, 0.035, W.sz + 0.02);
        dummy.updateMatrix();
        caps.setMatrixAt(j, dummy.matrix);
      }
      s.init = true;
      walls.instanceMatrix.needsUpdate = true;
      caps.instanceMatrix.needsUpdate = true;
    }

    // roof lifts off and fades
    const roof = roofRef.current;
    if (roof) {
      const r = clamp01(s.t / ROOF_S);
      roof.visible = r < 1;
      roof.position.y = roofY + easeOut(r) * 1.6;
      mats.roof.opacity = 1 - r;
    }

    const contents = contentsRef.current;
    if (contents) contents.scale.y = Math.max(0.001, easeOut(clamp01((s.t - 0.08) / ENTER_S)));

    // card hugs the cutaway's screen-right edge whatever the orbit (camera right axis = matrixWorld column 0)
    const card = cardRef.current;
    if (card) {
      const m = camera.matrixWorld.elements;
      const rl = Math.hypot(m[0], m[2]) || 1;
      card.position.set((m[0] / rl) * HALF * 1.2, wallH * 0.6, (m[2] / rl) * HALF * 1.2);
    }

    const dim = 0.42 + 0.58 * s.on;
    mats.body.color.setScalar(dim);
    mats.crate.color.setScalar(dim);
    const flicker = kit.line === "processor" ? 0.85 + 0.15 * Math.sin(s.t * 13) * Math.sin(s.t * 7.3) : kit.line === "extractor" ? 0.6 + 0.4 * Math.max(0, Math.sin(s.t * 5)) : 1;
    mats.glow.emissiveIntensity = s.on * (0.6 + 2.4 * util) * flicker;

    for (let i = 0; i < kit.movers.length; i++) {
      const g = moverRefs.current[i];
      if (!g) continue;
      const m = kit.movers[i];
      if (m.kind === "drill") {
        g.rotation.y = s.ph * 14;
        g.position.y = m.at[1] + (0.5 - 0.5 * Math.cos(s.ph * 5)) * 0.05;
      } else if (m.kind === "stamp") {
        g.position.y = m.at[1] + 0.1 * (0.5 + 0.5 * Math.cos(s.ph * 9 + m.phase));
      } else {
        g.rotation.y = m.ry + Math.sin(s.ph * 4 + m.phase) * 0.75;
      }
    }

    const crates = cratesRef.current;
    if (crates) {
      s.belt = (s.belt + d * s.speed * BELT_RATE) % 1;
      const len = BELT_X1 - kit.beltX0;
      dummy.rotation.set(0, 0, 0);
      for (let i = 0; i < CRATES; i++) {
        const u = (s.belt + i / CRATES) % 1;
        const cx = kit.beltX0 + u * len;
        dummy.position.set(cx, BELT_Y, 0);
        dummy.scale.setScalar(Math.max(0.001, Math.min(1, u / 0.06, (1 - u) / 0.06)));
        dummy.updateMatrix();
        crates.setMatrixAt(i, dummy.matrix);
        crates.setColorAt(i, cx < kit.swapX ? kit.inColors[i % kit.inColors.length] : kit.outColor);
      }
      crates.instanceMatrix.needsUpdate = true;
      if (crates.instanceColor) crates.instanceColor.needsUpdate = true;
    }

    const workers = workersRef.current;
    if (workers) {
      const n = s.on > 0.5 ? 2 + Math.round(util * 2) : 2;
      workers.count = n;
      for (let i = 0; i < n; i++) {
        const R = ROUTES[i];
        s.walk[i] += d * s.speed * WALK_RATE;
        const c = s.walk[i] % 1;
        let px: number, fx = 0, fz = -Math.sign(R.z), walking = false;
        if (c < 0.15) px = R.a;
        else if (c < 0.5) { px = R.a + (R.b - R.a) * smooth((c - 0.15) / 0.35); fx = Math.sign(R.b - R.a); fz = 0; walking = true; }
        else if (c < 0.65) px = R.b;
        else { px = R.b + (R.a - R.b) * smooth((c - 0.65) / 0.35); fx = Math.sign(R.a - R.b); fz = 0; walking = true; }
        dummy.position.set(px, FLOOR + (walking ? Math.abs(Math.sin(s.walk[i] * 90)) * 0.012 : 0), R.z);
        dummy.rotation.set(0, Math.atan2(fx, fz), 0);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        workers.setMatrixAt(i, dummy.matrix);
      }
      workers.instanceMatrix.needsUpdate = true;
    }
  });

  return (
    <group position={[wx, 0, wz]}>
      <mesh geometry={geos.floor} material={mats.floor} receiveShadow />
      <instancedMesh ref={wallsRef} args={[geos.unit, mats.wall, 4]} castShadow receiveShadow frustumCulled={false} />
      <instancedMesh ref={capsRef} args={[geos.unit, mats.cap, 4]} frustumCulled={false} />
      <mesh ref={roofRef} geometry={geos.roof} material={mats.roof} position-y={roofY} />
      <group ref={contentsRef}>
        <mesh geometry={kit.body} material={mats.body} castShadow receiveShadow />
        <mesh geometry={kit.glow} material={mats.glow} />
        {kit.movers.map((m, i) => (
          <group key={i} ref={(g) => { moverRefs.current[i] = g; }} position={m.at} rotation-y={m.ry}>
            <mesh geometry={m.geo} material={mats.body} castShadow />
          </group>
        ))}
        <instancedMesh ref={cratesRef} args={[geos.crate, mats.crate, CRATES]} castShadow frustumCulled={false} />
        <instancedMesh ref={workersRef} args={[geos.worker, mats.worker, MAX_WORKERS]} castShadow frustumCulled={false} />
      </group>
      <group ref={cardRef}>
        <Html zIndexRange={[20, 0]} style={{ pointerEvents: "none" }}>
          <InteriorCard type={type} live={live} utilization={utilization} />
        </Html>
      </group>
    </group>
  );
}

function smooth(k: number): number {
  return k * k * (3 - 2 * k);
}

function GoodChip({ good, qty }: { good: Good; qty: number }) {
  return (
    <span className="flex items-center gap-1 rounded-md bg-white/[0.06] py-0.5 pl-0.5 pr-1.5 text-[11px] text-slate-200">
      <GoodIcon good={good} size={18} />
      <span className="font-mono text-muted">{qty}×</span>
      {titleCase(good)}
    </span>
  );
}

/** Dark-glass status card floating above the cutaway (drawer styling, never intercepts the pointer). */
function InteriorCard({ type, live, utilization }: { type: BuildingType; live: boolean; utilization: number }) {
  const style = BUILDING_STYLE[type];
  const recipe = RECIPES[type];
  const inputs = Object.entries(recipe.inputs) as [Good, number][];
  const outputs = Object.entries(recipe.outputs) as [Good, number][];
  // utilization is units / base throughput, so rich deposits run past 100%; the bar caps, the number doesn't
  const pct = Math.round(utilization * 100);
  const status = !live ? { text: "Building", cls: "bg-gold/15 text-gold" } : utilization > 0 ? { text: "Running", cls: "bg-mint/15 text-mint" } : { text: "Idle", cls: "bg-rose/15 text-rose-400" };
  return (
    <div className="min-w-[230px] translate-x-4 -translate-y-1/2 whitespace-nowrap rounded-lg border border-edge bg-[rgba(22,22,24,.92)] p-3 text-slate-200 shadow-xl backdrop-blur-md">
      <div className="flex items-center gap-2">
        <span className="h-2.5 w-2.5 rounded-sm" style={{ background: style.color }} />
        <span className="text-sm font-bold">{style.label}</span>
        <span className={`ml-auto rounded-full px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide ${status.cls}`}>{status.text}</span>
      </div>
      <div className="mt-2.5 flex items-center justify-between text-[10px] uppercase tracking-wider text-muted">
        <span>Utilization</span>
        <span className="font-mono text-xs text-slate-100">{pct}%</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full bg-mint transition-[width] duration-500" style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      <div className="mt-2.5 flex items-center gap-1.5">
        {inputs.length > 0
          ? inputs.map(([g, q]) => <GoodChip key={g} good={g} qty={q} />)
          : <span className="rounded-md bg-white/[0.06] px-1.5 py-1 text-[11px] text-muted">{recipe.requiresResource ? RES_LABEL[recipe.requiresResource] : "Ground"}</span>}
        <span className="text-muted">→</span>
        {outputs.map(([g, q]) => <GoodChip key={g} good={g} qty={q} />)}
      </div>
      <div className="mt-2.5 flex items-center gap-1.5 border-t border-edge pt-2 text-[10px] text-muted">
        <kbd className="rounded border border-white/15 bg-white/5 px-1 font-mono text-[10px] text-slate-300">Esc</kbd>
        to step out
      </div>
    </div>
  );
}
