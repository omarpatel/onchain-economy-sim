"use client";

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { BUILDING_STYLE, ROOF, hash2 } from "./world-style.ts";
import {
  LOT, ROTOR_SPEC, allVariants, craneJibGeometry, lotGeometries, packPaint, rotorGeometries, tintedStandardMaterial, variantDef,
  type LotKind, type RotorKind,
} from "./geometry.ts";
import type { BuildInfo } from "./builds.ts";
import { companyColor } from "../../lib/palette.ts";
import { useUi } from "../../lib/store.ts";

const MAX_PER_TYPE = 160; // rotor instance capacity per kind
const MAX_BUILDINGS = 576;
/** Lot dressing instances: pads, fences, pylon, vehicles, yard stock, trees, construction kit. */
const MAX_LOT = 12000;
const MAX_CRANES = 64;

const dummy = new THREE.Object3D();
const color = new THREE.Color();
const roof = new THREE.Color();
const accent = new THREE.Color();
/** Instance colour: shade/paint in rgb, packed roof + accent colours in alpha (see `packPaint`). */
const paint = new THREE.Vector4();
const ROOFS = ROOF.map((c) => new THREE.Color(c));
const GREY = new THREE.Color("#8a8f96");
const CAR_PAINTS = ["#e8e6e1", "#2b2d31", "#9aa0a8", "#7d1f1f", "#24406b", "#c9c3b5", "#3e5c46", "#b5462f", "#d8d4cb", "#55595f"].map((c) => new THREE.Color(c));
const CONTAINER_PAINTS = ["#b5462f", "#2f6b8f", "#c98f2a", "#3e7a4c", "#8a8f96", "#6b3d5a"].map((c) => new THREE.Color(c));
const DRUM_PAINTS = ["#2f5f9e", "#c9a227", "#9e2f2f", "#3b7a52"].map((c) => new THREE.Color(c));
const LAMP: [number, number, number] = [0.72, 0.42, 0.72];
const MAST: [number, number] = [0.66, -0.86];
/** top of the lot kit's crane mast (lattice height + cap) */
const MAST_TOP = 2.44;

/** Status lamp on your own buildings only (green running · amber building · red idle); other firms' state is the utilization layer's job. */
const LIGHT = {
  live: new THREE.Color(0.2, 3.2, 1.0),
  building: new THREE.Color(3.4, 1.7, 0.2),
  idle: new THREE.Color(3.6, 0.3, 0.35),
};

/** Lot frame → world: rotate by the building's yaw, then offset to the tile centre. */
function lotToWorld(b: BuildInfo, lx: number, lz: number, out: THREE.Vector3, ly = 0): THREE.Vector3 {
  const c = Math.cos(b.pose.yaw), s = Math.sin(b.pose.yaw);
  return out.set(b.wx + lx * c + lz * s, ly, b.wz - lx * s + lz * c);
}

/** Building paint: walls keep their cladding with a stable per-tile shade, roof from the palette by
 *  tile hash, signage in the owner's colour; dimmer when idle or under a heat layer. */
function paintFor(b: BuildInfo, dim: boolean): THREE.Vector4 {
  const k = (b.live && b.utilization === 0 ? 0.82 : 1) * (dim ? 0.45 : 1);
  const shade = (0.93 + hash2(b.x, b.y, 7) * 0.12) * k;
  const warm = hash2(b.x, b.y, 10) - 0.5;
  roof.copy(ROOFS[Math.floor(hash2(b.x, b.y, 8) * ROOFS.length)]).multiplyScalar((0.92 + hash2(b.x, b.y, 9) * 0.16) * k);
  accent.set(companyColor(b.companyId)).multiplyScalar(k);
  return paint.set(shade * (1 + warm * 0.05), shade, shade * (1 - warm * 0.05), packPaint(roof, accent));
}

interface Crane { x: number; z: number; phase: number }

/** Writes lot-dressing instances into a pooled BatchedMesh; instances past the last write are hidden. */
class LotWriter {
  n = 0;
  constructor(readonly mesh: THREE.BatchedMesh, readonly geo: Record<LotKind, number>, readonly used: { count: number }) {}

  put(b: BuildInfo, kind: LotKind, lx: number, lz: number, ry: number, sx: number, sy: number, sz: number, col: THREE.Vector4, ly = 0) {
    if (this.n >= MAX_LOT) return;
    const id = this.n++;
    if (id >= this.used.count) { this.mesh.addInstance(this.geo[kind]); this.used.count++; }
    else { this.mesh.setGeometryIdAt(id, this.geo[kind]); this.mesh.setVisibleAt(id, true); }
    lotToWorld(b, lx, lz, dummy.position, ly);
    dummy.rotation.set(0, b.pose.yaw + ry, 0);
    dummy.scale.set(sx, sy, sz);
    dummy.updateMatrix();
    this.mesh.setMatrixAt(id, dummy.matrix);
    // three's setColorAt writes `color.toArray()` into an RGBA texel, so a Vector4 fills the alpha too (typed as Color)
    this.mesh.setColorAt(id, col as unknown as THREE.Color);
  }

  finish() {
    for (let i = this.n; i < this.used.count; i++) this.mesh.setVisibleAt(i, false);
  }
}

const lotPaint = new THREE.Vector4();
function rgb(c: THREE.Color, k: number, packed = 1): THREE.Vector4 {
  return lotPaint.set(c.r * k, c.g * k, c.b * k, packed);
}

/**
 * Dresses one built lot: ground pads, fences/hedges toward neighbouring
 * parcels, the owner's entrance pylon and the variant's slots (parked cars,
 * trucks at the docks, yard stock, trees) — or, while building, a dug pit,
 * a rising steel frame in scaffolding and a tower crane. Everything is
 * picked from tile hashes so the lot looks the same on every reload.
 */
function dressLot(w: LotWriter, b: BuildInfo, built: Map<string, string>, dim: boolean, interior: boolean, cranes: Crane[]) {
  const def = variantDef(b.type, b.pose.variant);
  const k = dim ? 0.45 : 1;
  const h = (salt: number) => hash2(b.x, b.y, salt);

  if (!dim) {
    for (const p of def.pad) {
      const [x0, z0, x1, z1] = p.rect;
      const kind = b.live ? p.kind : "gravel";
      color.setScalar(0.94 + h(30) * 0.1);
      w.put(b, kind, (x0 + x1) / 2, (z0 + z1) / 2, 0, x1 - x0, 1, z1 - z0, rgb(color, 1));
    }
  }

  // Back edges (lot −x / −z) face the block's other parcels: fence them off unless the neighbour is the same firm.
  const c = Math.cos(b.pose.yaw), s = Math.sin(b.pose.yaw);
  for (const [ax, az] of [[-1, 0], [0, -1]] as const) {
    const nx = b.x + Math.round(ax * c + az * s), ny = b.y + Math.round(-ax * s + az * c);
    const owner = built.get(`${nx},${ny}`);
    if (owner === b.companyId) continue;
    if (owner !== undefined && (nx < b.x || ny < b.y)) continue; // the neighbour draws the shared fence
    const edge = owner === undefined ? -1.06 : -1.1;
    const r = hash2(Math.min(nx, b.x), Math.min(ny, b.y), nx !== b.x ? 31 : 32);
    const kind: LotKind = r < 0.5 ? "fence" : r < 0.8 ? "hedge" : "wall";
    const len = LOT.max - LOT.min;
    const mid = (LOT.max + LOT.min) / 2;
    if (ax !== 0) w.put(b, kind, edge, mid, Math.PI / 2, len, 1, 1, rgb(color.setScalar(1), k));
    else w.put(b, kind, mid, edge, 0, len, 1, 1, rgb(color.setScalar(1), k));
  }
  if (interior) return;

  const white = color.setScalar(1);
  if (!b.live) {
    const [fx, fz, fw, fd, fh] = def.frame;
    const rise = Math.min(1, 0.12 + b.progress);
    w.put(b, "pit", fx, fz, 0, fw + 0.16, 1, fd + 0.16, rgb(white, k));
    w.put(b, "frame", fx, fz, 0, fw, fh * rise, fd, rgb(white, k));
    w.put(b, "scaffold", fx, fz, 0, fw + 0.12, fh * rise + 0.06, fd + 0.12, rgb(white, k));
    w.put(b, "mast", MAST[0], MAST[1], 0, 1, 1, 1, rgb(white, k));
    w.put(b, "pallets", -0.9, 0.62, h(50) * 3, 1, 1, 1, rgb(white, k));
    w.put(b, "lumber", -0.6, 0.66, 0, 1, 1, 1, rgb(white, k));
    if (cranes.length < MAX_CRANES) {
      const p = lotToWorld(b, MAST[0], MAST[1], dummy.position);
      cranes.push({ x: p.x, z: p.z, phase: h(51) * Math.PI * 2 });
    }
    return;
  }

  accent.set(companyColor(b.companyId));
  w.put(b, "pylon", LAMP[0], LAMP[2], 0, 1, 1, 1, rgb(white, k, packPaint(GREY, accent)));

  const stuff = def.stuff ?? ["pallets", "crates", "container", "drums"];
  def.slots.forEach((slot, i) => {
    const r = h(40 + i);
    switch (slot.k) {
      case "car":
        w.put(b, "stall", slot.x, slot.z, slot.ry, 1, 1, 1, rgb(white, k));
        if (r < 0.6) w.put(b, "car", slot.x, slot.z, slot.ry, 1, 1, 1, rgb(CAR_PAINTS[Math.floor(h(60 + i) * CAR_PAINTS.length)], k));
        else if (r < 0.78) w.put(b, "van", slot.x, slot.z, slot.ry, 1, 1, 1, rgb(h(60 + i) < 0.25 ? accent : CAR_PAINTS[0], k));
        break;
      case "truck":
        // fleet livery on some cabs, plain white/grey on the rest so the yards don't turn to confetti
        if (r < 0.72) w.put(b, "truck", slot.x, slot.z, slot.ry, 1, 1, 1, rgb(h(60 + i) < 0.35 ? accent : CAR_PAINTS[h(70 + i) < 0.6 ? 0 : 2], k));
        break;
      case "stuff": {
        if (r > 0.85) break;
        const kind = stuff[Math.floor(h(60 + i) * stuff.length)];
        const col = kind === "container" ? CONTAINER_PAINTS[Math.floor(h(70 + i) * CONTAINER_PAINTS.length)] : kind === "drums" ? DRUM_PAINTS[Math.floor(h(70 + i) * DRUM_PAINTS.length)] : white;
        w.put(b, kind, slot.x, slot.z, slot.ry + (h(80 + i) - 0.5) * 0.3, 1, 1, 1, rgb(col, k));
        break;
      }
      case "tree": {
        if (r > 0.9) break;
        const sc = 0.8 + h(60 + i) * 0.5;
        const kind: LotKind = r < 0.15 ? "bush" : h(70 + i) < 0.5 ? "tree" : "treeRound";
        w.put(b, kind, slot.x, slot.z, h(80 + i) * 6, sc, sc, sc, rgb(white, k));
        break;
      }
    }
  });
}

/**
 * Bodies (every type × variant in ONE BatchedMesh → one draw + one shadow
 * draw), lot dressing (a second BatchedMesh), status lights and tower-crane
 * jibs. Buffers are rewritten only when the derived build list changes
 * (once per tick); per frame only the crane jibs slew.
 */
export function Buildings({ builds, youCompany, onTileClick }: { builds: BuildInfo[]; youCompany: string | null; onTileClick: (tileId: string) => void }) {
  const lightsRef = useRef<THREE.InstancedMesh>(null);
  const jibRef = useRef<THREE.InstancedMesh>(null);
  const cranes = useRef<Crane[]>([]);
  const setHover = useUi((s) => s.setHover);
  const dim = useUi((s) => s.layer !== "world");
  // the cutaway interior draws this building itself
  const interior = useUi((s) => s.interiorTile);
  const jib = craneJibGeometry();

  // BatchedMesh with every variant geometry registered once; instances map to buildings by id.
  const batch = useMemo(() => {
    const variants = allVariants();
    let verts = 0;
    for (const v of variants) verts += v.geo.getAttribute("position").count;
    const mesh = new THREE.BatchedMesh(MAX_BUILDINGS, verts, 0, tintedStandardMaterial({ roughness: 0.7, metalness: 0.08 }));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.perObjectFrustumCulled = false;
    mesh.sortObjects = false;
    const geoId: Record<string, number> = {};
    for (const v of variants) geoId[`${v.type}:${v.variant}`] = mesh.addGeometry(v.geo);
    return { mesh, geoId, slot: new Map<string, number>(), byInstance: new Map<number, BuildInfo>() };
  }, []);

  const lots = useMemo(() => {
    const geos = lotGeometries();
    const kinds = Object.keys(geos) as LotKind[];
    let verts = 0;
    for (const kind of kinds) verts += geos[kind].getAttribute("position").count;
    const mesh = new THREE.BatchedMesh(MAX_LOT, verts, 0, tintedStandardMaterial({ roughness: 0.8, metalness: 0.05 }));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.perObjectFrustumCulled = false;
    mesh.sortObjects = false;
    mesh.raycast = () => {};
    const geo = {} as Record<LotKind, number>;
    for (const kind of kinds) geo[kind] = mesh.addGeometry(geos[kind]);
    return { mesh, geo, used: { count: 0 } };
  }, []);

  useEffect(() => {
    const { mesh, geoId, slot, byInstance } = batch;
    const alive = new Set<string>();
    byInstance.clear();
    for (const b of builds) {
      alive.add(b.id);
      let id = slot.get(b.id);
      if (id === undefined) { id = mesh.addInstance(geoId[`${b.type}:${b.pose.variant}`]); slot.set(b.id, id); }
      byInstance.set(id, b);
      dummy.position.set(b.wx, 0, b.wz);
      dummy.rotation.set(0, b.pose.yaw, 0);
      dummy.scale.set(b.pose.sxz, b.pose.sy, b.pose.sxz);
      dummy.updateMatrix();
      mesh.setMatrixAt(id, dummy.matrix);
      mesh.setColorAt(id, paintFor(b, dim) as unknown as THREE.Color);
      mesh.setVisibleAt(id, b.live && b.tileId !== interior);
    }
    for (const [bid, id] of slot) {
      if (alive.has(bid)) continue;
      mesh.deleteInstance(id);
      slot.delete(bid);
    }

    const built = new Map<string, string>();
    for (const b of builds) built.set(`${b.x},${b.y}`, b.companyId);
    const writer = new LotWriter(lots.mesh, lots.geo, lots.used);
    const sites: Crane[] = [];
    for (const b of builds) dressLot(writer, b, built, dim, b.tileId === interior, sites);
    writer.finish();
    cranes.current = sites;
    const jibs = jibRef.current;
    if (jibs) jibs.count = sites.length;

    const lights = lightsRef.current;
    if (lights) {
      let n = 0;
      for (const b of builds) {
        if (b.companyId !== youCompany || b.tileId === interior) continue;
        lotToWorld(b, LAMP[0], LAMP[2], dummy.position, LAMP[1]);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        lights.setMatrixAt(n, dummy.matrix);
        lights.setColorAt(n, !b.live ? LIGHT.building : b.utilization > 0 ? LIGHT.live : LIGHT.idle);
        n++;
      }
      lights.count = n;
      lights.instanceMatrix.needsUpdate = true;
      if (lights.instanceColor) lights.instanceColor.needsUpdate = true;
      lights.computeBoundingSphere();
    }
  }, [builds, batch, lots, dim, youCompany, interior]);

  // Jibs slew slowly back and forth over their sites.
  useFrame((state) => {
    const jibs = jibRef.current;
    const sites = cranes.current;
    if (!jibs || sites.length === 0) return;
    const t = state.clock.elapsedTime;
    for (let i = 0; i < sites.length; i++) {
      const c = sites[i];
      dummy.position.set(c.x, MAST_TOP, c.z);
      dummy.rotation.set(0, c.phase + Math.sin(t * 0.18 + c.phase) * 1.3, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      jibs.setMatrixAt(i, dummy.matrix);
    }
    jibs.instanceMatrix.needsUpdate = true;
  });

  const pick = (e: ThreeEvent<PointerEvent | MouseEvent>) => (e.batchId !== undefined ? batch.byInstance.get(e.batchId) : undefined);

  return (
    <group>
      <primitive
        object={batch.mesh}
        onPointerMove={(e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); const b = pick(e); if (b) setHover(b.tileId); }}
        onPointerOut={() => setHover(null)}
        onClick={(e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); const b = pick(e); if (b) onTileClick(b.tileId); }}
      />
      <primitive object={lots.mesh} />
      <instancedMesh ref={lightsRef} args={[undefined, undefined, MAX_BUILDINGS]} frustumCulled={false} raycast={() => null}>
        <sphereGeometry args={[0.07, 8, 6]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={jibRef} args={[jib, undefined, MAX_CRANES]} frustumCulled={false} castShadow raycast={() => null}>
        <meshStandardMaterial vertexColors roughness={0.6} metalness={0.2} />
      </instancedMesh>
    </group>
  );
}

/* ───────────────────────── rotors ───────────────────────── */

const AXIS = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
const qSpin = new THREE.Quaternion();
const qYaw = new THREE.Quaternion();
const hub = new THREE.Vector3();

interface RotorSite { b: BuildInfo; x: number; y: number; z: number; yaw: number }

/** One instanced mesh per rotor kind; matrices are recomposed every frame from
 *  a per-instance angle that advances with the building's utilization. */
export function Rotors({ builds }: { builds: BuildInfo[] }) {
  const geos = rotorGeometries();
  const material = useMemo(() => tintedStandardMaterial({ roughness: 0.5, metalness: 0.4 }), []);
  const interior = useUi((s) => s.interiorTile);
  const refs = useRef<Partial<Record<RotorKind, THREE.InstancedMesh>>>({});
  const angles = useRef<Record<RotorKind, Float32Array>>({
    blade: new Float32Array(MAX_PER_TYPE), pumpjack: new Float32Array(MAX_PER_TYPE), wheel: new Float32Array(MAX_PER_TYPE), fan: new Float32Array(MAX_PER_TYPE),
  });

  const byKind = useMemo(() => {
    const m: Record<RotorKind, RotorSite[]> = { blade: [], pumpjack: [], wheel: [], fan: [] };
    for (const b of builds) {
      const k = BUILDING_STYLE[b.type].rotor;
      const r = variantDef(b.type, b.pose.variant).rotor;
      if (!k || !r || !b.live || b.tileId === interior || m[k].length >= MAX_PER_TYPE) continue;
      lotToWorld(b, r[0] * b.pose.sxz, r[2] * b.pose.sxz, hub, r[1] * b.pose.sy);
      m[k].push({ b, x: hub.x, y: hub.y, z: hub.z, yaw: b.pose.yaw + r[3] });
    }
    return m;
  }, [builds, interior]);

  useEffect(() => {
    for (const k of Object.keys(byKind) as RotorKind[]) {
      const mesh = refs.current[k];
      if (mesh) mesh.count = byKind[k].length;
    }
  }, [byKind]);

  useFrame((state, dt) => {
    const t = state.clock.elapsedTime;
    for (const k of Object.keys(byKind) as RotorKind[]) {
      const mesh = refs.current[k];
      if (!mesh) continue;
      const spec = ROTOR_SPEC[k];
      const arr = angles.current[k];
      const sites = byKind[k];
      for (let i = 0; i < sites.length; i++) {
        const { b } = sites[i];
        let a: number;
        if (spec.rock) a = Math.sin(t * spec.speed * (0.4 + b.utilization)) * 0.22 * Math.min(1, b.utilization * 3 + 0.05);
        else { arr[i] += dt * spec.speed * b.utilization; a = arr[i]; }
        qYaw.setFromAxisAngle(AXIS.y, sites[i].yaw);
        qSpin.setFromAxisAngle(AXIS[spec.axis], a);
        dummy.position.set(sites[i].x, sites[i].y, sites[i].z);
        dummy.quaternion.copy(qYaw).multiply(qSpin);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
  });

  return (
    <group>
      {(Object.keys(geos) as RotorKind[]).map((k) => (
        <instancedMesh key={k} ref={(m) => { refs.current[k] = m ?? undefined; }} args={[geos[k], material, MAX_PER_TYPE]} frustumCulled={false} raycast={() => null} />
      ))}
    </group>
  );
}

/* ───────────────────────── smoke ───────────────────────── */

const SMOKE_PER = 8;
const SMOKE_MAX = 96 * SMOKE_PER;
const SMOKE_LIFE = 2.4;

const smokeVert = /* glsl */`
  attribute float aAge;
  varying float vAlpha;
  void main() {
    float life = ${SMOKE_LIFE.toFixed(2)};
    float k = clamp(aAge / life, 0.0, 1.0);
    vAlpha = (1.0 - k) * smoothstep(0.0, 0.2, k) * 0.2;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = (2.4 + k * 6.0) * (90.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }`;
const smokeFrag = /* glsl */`
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = (1.0 - smoothstep(0.0, 0.5, d)) * vAlpha;
    gl_FragColor = vec4(0.62, 0.63, 0.66, a);
  }`;

interface SmokeSource { b: BuildInfo; x: number; y: number; z: number }

/** Single `Points` draw for every smoking stack (the variant knows where its stacks are); emission scales with utilization. */
export function Smoke({ builds }: { builds: BuildInfo[] }) {
  const ref = useRef<THREE.Points>(null);
  const interior = useUi((s) => s.interiorTile);
  const sources = useMemo(() => {
    const out: SmokeSource[] = [];
    for (const b of builds) {
      if (!b.live || !BUILDING_STYLE[b.type].smoke || b.tileId === interior) continue;
      for (const [x, y, z] of variantDef(b.type, b.pose.variant).smoke ?? []) {
        if (out.length >= SMOKE_MAX / SMOKE_PER) break;
        lotToWorld(b, x * b.pose.sxz, z * b.pose.sxz, hub, y * b.pose.sy);
        out.push({ b, x: hub.x, y: hub.y, z: hub.z });
      }
    }
    return out;
  }, [builds, interior]);
  const buffers = useMemo(() => ({
    pos: new Float32Array(SMOKE_MAX * 3),
    age: new Float32Array(SMOKE_MAX).map((_, i) => (i % SMOKE_PER) / SMOKE_PER * SMOKE_LIFE),
    vel: new Float32Array(SMOKE_MAX * 3),
  }), []);
  const material = useMemo(() => new THREE.ShaderMaterial({ vertexShader: smokeVert, fragmentShader: smokeFrag, transparent: true, depthWrite: false }), []);

  useFrame((_, dt) => {
    const p = ref.current;
    if (!p) return;
    const { pos, age, vel } = buffers;
    const n = sources.length * SMOKE_PER;
    for (let s = 0; s < sources.length; s++) {
      const src = sources[s];
      const u = src.b.utilization;
      const active = Math.round(SMOKE_PER * Math.min(1, u * 1.2));
      for (let j = 0; j < SMOKE_PER; j++) {
        const i = s * SMOKE_PER + j;
        if (j >= active) { pos[i * 3 + 1] = -50; age[i] = SMOKE_LIFE; continue; }
        age[i] += dt * (0.7 + u * 0.6);
        if (age[i] >= SMOKE_LIFE) {
          age[i] = 0;
          pos[i * 3] = src.x + (Math.random() - 0.5) * 0.06;
          pos[i * 3 + 1] = src.y;
          pos[i * 3 + 2] = src.z + (Math.random() - 0.5) * 0.06;
          vel[i * 3] = (Math.random() - 0.5) * 0.25 + 0.18;
          vel[i * 3 + 1] = 0.55 + Math.random() * 0.3;
          vel[i * 3 + 2] = (Math.random() - 0.5) * 0.25;
        } else {
          pos[i * 3] += vel[i * 3] * dt;
          pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
          pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
        }
      }
    }
    const g = p.geometry;
    g.setDrawRange(0, n);
    g.attributes.position.needsUpdate = true;
    g.attributes.aAge.needsUpdate = true;
  });

  return (
    <points ref={ref} material={material} frustumCulled={false} raycast={() => null}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[buffers.pos, 3]} />
        <bufferAttribute attach="attributes-aAge" args={[buffers.age, 1]} />
      </bufferGeometry>
    </points>
  );
}
