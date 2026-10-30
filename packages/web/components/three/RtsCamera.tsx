"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { CameraControls, useKeyboardControls } from "@react-three/drei";
import CameraControlsImpl from "camera-controls";
import { TILE, tileToWorld } from "./world-style.ts";
import { useUi } from "../../lib/store.ts";

const { ACTION } = CameraControlsImpl;
const PAN_SPEED = 26; // world units / s with WASD in RTS mode
/** Long lens for the near-orthographic RTS read; walk mode's follow camera gets a natural FOV back. */
const RTS_FOV = 30;
const WALK_FOV = 48;

/**
 * RTS camera: left-drag pans, right-drag orbits, wheel dollies toward the
 * cursor, WASD/arrows pan. The orbit target is clamped to the map so the
 * player can never lose the city. `focus` requests from the store glide the
 * target onto a tile while keeping the current zoom/pitch; a new `stepOut`
 * nonce (Esc with nothing to dismiss) flies back to the overview pose. Entering
 * a building interior glides in low and close; leaving restores the pose from
 * before (re-centred on the newest focus if one arrived meanwhile).
 */
export function RtsCamera({ width, height, enabled }: { width: number; height: number; enabled: boolean }) {
  const ref = useRef<CameraControlsImpl>(null);
  const camera = useThree((s) => s.camera);
  const [, getKeys] = useKeyboardControls();
  const focus = useUi((s) => s.focus);
  const stepOut = useUi((s) => s.stepOut);
  const saved = useRef<{ pos: THREE.Vector3; target: THREE.Vector3 }>({ pos: OVERVIEW.pos.clone(), target: OVERVIEW.target.clone() });
  const handledStepOut = useRef(stepOut);
  const interiorTile = useUi((s) => s.interiorTile);
  const inside = useRef<string | null>(null);
  const before = useRef({ pos: new THREE.Vector3(), target: new THREE.Vector3(), focus: 0 });

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.mouseButtons.left = ACTION.TRUCK;
    c.mouseButtons.right = ACTION.ROTATE;
    c.mouseButtons.middle = ACTION.DOLLY;
    c.mouseButtons.wheel = ACTION.DOLLY;
    c.touches.one = ACTION.TOUCH_TRUCK;
    c.touches.two = ACTION.TOUCH_DOLLY_ROTATE;
    c.minDistance = MIN_DISTANCE;
    c.maxDistance = 160;
    c.minPolarAngle = 0.25;
    c.maxPolarAngle = 1.32;
    c.dollyToCursor = true;
    c.smoothTime = 0.22;
    c.draggingSmoothTime = 0.08;
    c.truckSpeed = 2.4;
    c.boundaryFriction = 0.15;
    const hx = (width / 2) * TILE + TILE;
    const hz = (height / 2) * TILE + TILE;
    c.setBoundary(new THREE.Box3(new THREE.Vector3(-hx, 0, -hz), new THREE.Vector3(hx, 6, hz)));
    const { pos, target } = saved.current;
    c.setLookAt(pos.x, pos.y, pos.z, target.x, target.y, target.z, false);
  }, [width, height, enabled]);

  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera;
    if (!cam.isPerspectiveCamera) return;
    cam.fov = enabled ? RTS_FOV : WALK_FOV;
    cam.updateProjectionMatrix();
  }, [camera, enabled]);

  // Walk mode unmounts the controls (camera-controls writes the camera every
  // update even when disabled) and the avatar drives the camera; the last RTS
  // pose is kept in `saved` and re-applied by the setup effect on return.

  useEffect(() => {
    const c = ref.current;
    if (!c || !focus || !enabled) return;
    const [wx, wz] = tileToWorld(focus.x, focus.y, width, height);
    void c.moveTo(wx, 0.5, wz, true);
  }, [focus, width, height, enabled]);

  useEffect(() => {
    const c = ref.current;
    if (!c || !enabled || stepOut === handledStepOut.current) return;
    handledStepOut.current = stepOut;
    const { pos, target } = OVERVIEW;
    void c.setLookAt(pos.x, pos.y, pos.z, target.x, target.y, target.z, true);
  }, [stepOut, enabled]);

  useEffect(() => {
    const c = ref.current;
    if (!c || !enabled) return;
    const prev = inside.current;
    inside.current = interiorTile;
    if (interiorTile === prev) return;
    if (interiorTile) {
      if (!prev) {
        c.getPosition(before.current.pos);
        c.getTarget(before.current.target);
        before.current.focus = useUi.getState().focus?.nonce ?? 0;
      }
      // tile ids are "x,y" grid coords (sim map.ts)
      const [tx, ty] = interiorTile.split(",").map(Number);
      const [wx, wz] = tileToWorld(tx, ty, width, height);
      const az = c.azimuthAngle;
      const r = Math.sin(INTERIOR.polar) * INTERIOR.distance;
      c.minDistance = INTERIOR.minDistance;
      void c.setLookAt(wx + r * Math.sin(az), INTERIOR.y + Math.cos(INTERIOR.polar) * INTERIOR.distance, wz + r * Math.cos(az), wx, INTERIOR.y, wz, true);
    } else {
      c.minDistance = MIN_DISTANCE;
      const { pos, target, focus: focusAtEntry } = before.current;
      // a focus request since entering (clicked another tile) wins the target; zoom/pitch/yaw come back either way
      const t = (useUi.getState().focus?.nonce ?? 0) !== focusAtEntry ? c.getTarget(tmpTarget) : target;
      void c.setLookAt(t.x + pos.x - target.x, t.y + pos.y - target.y, t.z + pos.z - target.z, t.x, t.y, t.z, true);
    }
  }, [interiorTile, enabled, width, height]);

  useFrame((_, dt) => {
    const c = ref.current;
    if (!c || !enabled) return;
    c.getPosition(saved.current.pos);
    c.getTarget(saved.current.target);
    const k = getKeys();
    let fx = 0, fz = 0;
    if (k.forward) fz -= 1;
    if (k.back) fz += 1;
    if (k.left) fx -= 1;
    if (k.right) fx += 1;
    if (fx === 0 && fz === 0) return;
    const speed = PAN_SPEED * dt * (k.run ? 2 : 1);
    // pan relative to the camera's yaw so "forward" is always "up the screen"
    const t = c.getTarget(tmpTarget);
    const yaw = Math.atan2(camera.position.x - t.x, camera.position.z - t.z);
    const dx = (fx * Math.cos(yaw) + fz * Math.sin(yaw)) * speed;
    const dz = (-fx * Math.sin(yaw) + fz * Math.cos(yaw)) * speed;
    void c.moveTo(t.x + dx, t.y, t.z + dz, false);
  });

  return enabled ? <CameraControls ref={ref} makeDefault /> : null;
}

const tmpTarget = new THREE.Vector3();
/** ~55° pitch at ~78 units: with the 30° lens this frames the city like the old 48° lens at ~50. */
const OVERVIEW = { pos: new THREE.Vector3(0, 64, 49), target: new THREE.Vector3(0, 0, 4) };
const MIN_DISTANCE = 11;
/** Interior close-up: steep (~64° elevation) so neighbouring stacks rarely block the open roof; 10 units frames cutaway + side card at the 30° lens. */
const INTERIOR = { distance: 10, polar: 0.45, y: 0.5, minDistance: 6 } as const;
