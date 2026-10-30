"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useKeyboardControls, Html } from "@react-three/drei";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { TILE, worldToTile, type PlayerPos } from "./world-style.ts";

/**
 * Player rig with two modes:
 *   walk  — articulated avatar, WASD relative to mouse-look, limb animation.
 *   drive — hop into the delivery truck (press F when near), arcade steering.
 * Both use grid collision (can't pass through buildings) and a follow camera.
 */
export function Player({
  blocked, width, height, bound, playerPos,
}: {
  blocked: Set<string>;
  width: number;
  height: number;
  bound: number;
  playerPos: { current: PlayerPos };
}) {
  const char = useRef<THREE.Group>(null);
  const truck = useRef<THREE.Group>(null);
  const legL = useRef<THREE.Group>(null);
  const legR = useRef<THREE.Group>(null);
  const armL = useRef<THREE.Group>(null);
  const armR = useRef<THREE.Group>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [, get] = useKeyboardControls();

  const mode = useRef<"walk" | "drive">("walk");
  const drive = useRef({ speed: 0, heading: 0 });
  const yaw = useRef(0);
  const pitch = useRef(0.35);
  const stride = useRef(0);
  const prevEnter = useRef(false);
  const { gl } = useThree();
  const tmp = new THREE.Vector3();
  const camTarget = new THREE.Vector3();

  // Right-drag mouse-look. requestPointerLock resolves asynchronously, so a quick click can be released
  // before the lock lands: track intent and drop a lock that arrives after the button is already up.
  useEffect(() => {
    const el = gl.domElement;
    let wantLock = false;
    const onDown = (e: MouseEvent) => { if (e.button === 2) { wantLock = true; el.requestPointerLock?.(); } };
    const onUp = (e: MouseEvent) => { if (e.button === 2) { wantLock = false; if (document.pointerLockElement === el) document.exitPointerLock(); } };
    const onLockChange = () => { if (document.pointerLockElement === el && !wantLock) document.exitPointerLock(); };
    const onMove = (e: MouseEvent) => {
      if (document.pointerLockElement !== el) return;
      yaw.current -= e.movementX * 0.0025;
      pitch.current = Math.max(0.05, Math.min(1.2, pitch.current - e.movementY * 0.0025));
    };
    const onCtx = (e: Event) => e.preventDefault();
    el.addEventListener("mousedown", onDown);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("mousemove", onMove);
    document.addEventListener("pointerlockchange", onLockChange);
    el.addEventListener("contextmenu", onCtx);
    return () => {
      el.removeEventListener("mousedown", onDown);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("mousemove", onMove);
      document.removeEventListener("pointerlockchange", onLockChange);
      el.removeEventListener("contextmenu", onCtx);
      if (document.pointerLockElement === el) document.exitPointerLock();
    };
  }, [gl]);

  const walkable = (wx: number, wz: number): boolean => {
    const [tx, ty] = worldToTile(wx, wz, width, height);
    if (tx < 0 || ty < 0 || tx >= width || ty >= height) return false;
    return !blocked.has(`${tx},${ty}`);
  };

  useFrame((state, delta) => {
    const c = char.current;
    const tk = truck.current;
    if (!c || !tk) return;
    const k = get();
    const near = c.position.distanceTo(tk.position) < 3.8;

    // Enter / exit vehicle on F edge.
    if (k.enter && !prevEnter.current) {
      if (mode.current === "walk" && near) {
        mode.current = "drive";
        c.visible = false;
      } else if (mode.current === "drive") {
        mode.current = "walk";
        c.visible = true;
        const fx = Math.cos(drive.current.heading);
        const fz = -Math.sin(drive.current.heading);
        const ox = tk.position.x + fx * 2.2;
        const oz = tk.position.z + fz * 2.2;
        c.position.set(walkable(ox, oz) ? ox : tk.position.x, 0.65, walkable(ox, oz) ? oz : tk.position.z);
      }
    }
    prevEnter.current = k.enter;
    if (mode.current === "walk") {
      if (k.turnL) yaw.current += delta * 1.6;
      if (k.turnR) yaw.current -= delta * 1.6;
      const speed = (k.run ? 15 : 7.5) * delta;
      const sin = Math.sin(yaw.current);
      const cos = Math.cos(yaw.current);
      let dx = 0;
      let dz = 0;
      if (k.forward) { dx -= sin; dz -= cos; }
      if (k.back) { dx += sin; dz += cos; }
      if (k.left) { dx -= cos; dz += sin; }
      if (k.right) { dx += cos; dz -= sin; }
      const len = Math.hypot(dx, dz);
      const moving = len > 0;
      if (moving) {
        dx = (dx / len) * speed;
        dz = (dz / len) * speed;
        const nx = THREE.MathUtils.clamp(c.position.x + dx, -bound, bound);
        if (walkable(nx, c.position.z)) c.position.x = nx;
        const nz = THREE.MathUtils.clamp(c.position.z + dz, -bound, bound);
        if (walkable(c.position.x, nz)) c.position.z = nz;
        c.rotation.y = Math.atan2(dx, dz);
        stride.current += delta * (k.run ? 16 : 11);
      } else {
        stride.current *= 0.8;
      }
      const swing = Math.sin(stride.current) * (moving ? 0.7 : 0.05 * Math.sin(state.clock.elapsedTime * 2));
      if (legL.current) legL.current.rotation.x = swing;
      if (legR.current) legR.current.rotation.x = -swing;
      if (armL.current) armL.current.rotation.x = -swing;
      if (armR.current) armR.current.rotation.x = swing;

      playerPos.current.x = c.position.x;
      playerPos.current.z = c.position.z;
      playerPos.current.heading = yaw.current;

      const dist = 11;
      tmp.set(
        c.position.x + Math.sin(yaw.current) * Math.cos(pitch.current) * dist,
        c.position.y + 2 + Math.sin(pitch.current) * dist,
        c.position.z + Math.cos(yaw.current) * Math.cos(pitch.current) * dist,
      );
      state.camera.position.lerp(tmp, 0.15);
      camTarget.set(c.position.x, c.position.y + 1.4, c.position.z);
      state.camera.lookAt(camTarget);
    } else {
      // DRIVE
      const d = drive.current;
      const accel = (k.run ? 26 : 16) * delta;
      if (k.forward) d.speed += accel;
      if (k.back) d.speed -= accel;
      d.speed *= 0.94; // friction
      d.speed = THREE.MathUtils.clamp(d.speed, -8, k.run ? 24 : 15);
      const turn = 1.6 * delta * Math.sign(d.speed) * Math.min(1, Math.abs(d.speed) / 4);
      if (k.left) d.heading += turn;
      if (k.right) d.heading -= turn;

      const fx = Math.cos(d.heading);
      const fz = -Math.sin(d.heading);
      const step = d.speed * delta;
      const nx = THREE.MathUtils.clamp(tk.position.x + fx * step, -bound, bound);
      if (walkable(nx, tk.position.z)) tk.position.x = nx; else d.speed *= 0.3;
      const nz = THREE.MathUtils.clamp(tk.position.z + fz * step, -bound, bound);
      if (walkable(tk.position.x, nz)) tk.position.z = nz; else d.speed *= 0.3;
      tk.rotation.y = d.heading;

      playerPos.current.x = tk.position.x;
      playerPos.current.z = tk.position.z;
      playerPos.current.heading = -d.heading + Math.PI / 2;

      const camDist = 15;
      tmp.set(tk.position.x - fx * camDist, tk.position.y + 8, tk.position.z - fz * camDist);
      state.camera.position.lerp(tmp, 0.12);
      camTarget.set(tk.position.x, tk.position.y + 1.5, tk.position.z);
      state.camera.lookAt(camTarget);
    }

    const promptOn = mode.current === "walk" && near;
    if (promptOn !== showPrompt) setShowPrompt(promptOn);
  });

  return (
    <group>
      {/* character */}
      <group ref={char} position={[0, 0.65, 0]}>
        <mesh castShadow position={[0, 1.05, 0]}><boxGeometry args={[0.6, 0.8, 0.35]} /><meshStandardMaterial color="#fbbf24" roughness={0.4} metalness={0.2} /></mesh>
        <mesh castShadow position={[0, 1.75, 0]}><boxGeometry args={[0.42, 0.42, 0.42]} /><meshStandardMaterial color="#f5deb3" roughness={0.6} /></mesh>
        <group ref={armL} position={[-0.42, 1.35, 0]}><mesh castShadow position={[0, -0.35, 0]}><boxGeometry args={[0.18, 0.7, 0.18]} /><meshStandardMaterial color="#e0a020" /></mesh></group>
        <group ref={armR} position={[0.42, 1.35, 0]}><mesh castShadow position={[0, -0.35, 0]}><boxGeometry args={[0.18, 0.7, 0.18]} /><meshStandardMaterial color="#e0a020" /></mesh></group>
        <group ref={legL} position={[-0.16, 0.65, 0]}><mesh castShadow position={[0, -0.35, 0]}><boxGeometry args={[0.22, 0.7, 0.22]} /><meshStandardMaterial color="#1f2937" /></mesh></group>
        <group ref={legR} position={[0.16, 0.65, 0]}><mesh castShadow position={[0, -0.35, 0]}><boxGeometry args={[0.22, 0.7, 0.22]} /><meshStandardMaterial color="#1f2937" /></mesh></group>
      </group>

      {/* drivable delivery truck */}
      <group ref={truck} position={[TILE * 3, 0.35, 0]}>
        <mesh castShadow position={[0, 0.9, 0.5]}><boxGeometry args={[1.3, 1.1, 2.2]} /><meshStandardMaterial color="#e2e8f0" metalness={0.3} roughness={0.5} /></mesh>
        <mesh castShadow position={[0, 0.8, -1.3]}><boxGeometry args={[1.25, 0.9, 1.0]} /><meshStandardMaterial color="#38bdf8" metalness={0.4} roughness={0.4} /></mesh>
        {[[-0.7, -0.8], [0.7, -0.8], [-0.7, 1.1], [0.7, 1.1]].map(([x, z], i) => (
          <mesh key={i} position={[x, 0.35, z]} rotation={[0, 0, Math.PI / 2]}><cylinderGeometry args={[0.35, 0.35, 0.25, 12]} /><meshStandardMaterial color="#0f172a" /></mesh>
        ))}
        {showPrompt && (
          <Html position={[0, 2.6, 0]} center style={{ pointerEvents: "none" }}>
            <div className="whitespace-nowrap rounded border border-amber-500/50 bg-black/75 px-2 py-0.5 font-mono text-[11px] font-semibold text-amber-300">F — DRIVE</div>
          </Html>
        )}
      </group>
    </group>
  );
}
