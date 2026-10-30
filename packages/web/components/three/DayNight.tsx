"use client";

import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { NIGHT } from "./geometry.ts";
import { SKY, WEATHER } from "./Sky.tsx";

/** Seconds for a full cycle; the first DAY_SHARE of it is daylight, the rest moonlit night. */
const DAY_LEN = 360;
const DAY_SHARE = 0.75;
/** Fraction of the daylight arc spent fading in/out (dawn/dusk ≈ 20 s each). */
const TWILIGHT = 0.08;
/** Cycle phase at load: mid-morning, so a session opens in full daylight. */
const START = 0.2;
/** Sun peaks at ~46° from the screen-left, swung toward the camera (+z) so the faces we look at stay
 *  lit sandstone instead of shadowed khaki; sweeps ±25° of azimuth, shadows fall long to the upper right. */
const SUN_PEAK = THREE.MathUtils.degToRad(46);
const SUN_LOW = THREE.MathUtils.degToRad(10);
const SUN_AZ = THREE.MathUtils.degToRad(140);
const SUN_SWEEP = THREE.MathUtils.degToRad(50);
/** How far the visible sun disc sinks below the light's lowest elevation as day fades (it sets; the light turns into the moon). */
const SUN_SET = THREE.MathUtils.degToRad(16);

const DAY_SUN = new THREE.Color("#fff0d6");
const DUSK_SUN = new THREE.Color("#ffb27a");
const MOON = new THREE.Color("#9fb8ff");
const DAY_HEMI_SKY = new THREE.Color("#d2e6ff");
const NIGHT_HEMI_SKY = new THREE.Color("#5f7fc4");
const DAY_HEMI_GROUND = new THREE.Color("#8c8466");
const NIGHT_HEMI_GROUND = new THREE.Color("#1e2638");

/** Sky palette: day / dusk / night for zenith, horizon haze, sun glow and the two cloud tones. */
const ZENITH = [new THREE.Color("#3b7bd0"), new THREE.Color("#4b5d96"), new THREE.Color("#060c1d")] as const;
const HORIZON = [new THREE.Color("#c4def0"), new THREE.Color("#f2b893"), new THREE.Color("#1a2745")] as const;
const GLOW = [new THREE.Color("#fff0d0"), new THREE.Color("#ff8a4a")] as const;
const CLOUD_LIT = [new THREE.Color("#ffffff"), new THREE.Color("#ffc7a1"), new THREE.Color("#35415f")] as const;
const CLOUD_SHADE = [new THREE.Color("#b3c4da"), new THREE.Color("#8f7f9c"), new THREE.Color("#141b30")] as const;
/** Grade tints (linear multipliers): golden hour while the light changes, cool moonlight at night. */
const DUSK_TINT = new THREE.Color().setRGB(1.1, 0.97, 0.85);
const NIGHT_TINT = new THREE.Color().setRGB(0.9, 0.97, 1.1);
/** Grade under rain: a touch dim and cool. */
const RAIN_TINT = new THREE.Color().setRGB(0.9, 0.95, 1.02);
/** Morning mist lifts the horizon toward this pale, faintly warm white. */
const MIST_HAZE = new THREE.Color("#dfe3e2");

/** Fixed moon direction (high, from top-right) so night shadows stay readable and still. */
const MOON_DIR = new THREE.Vector3(0.45, 0.82, -0.36).normalize();

/**
 * Time of day, written by DayNight each frame for Weather and Life: `phase`
 * 0..1 within the cycle (0 = sunrise, DAY_SHARE = sunset), `cycle` the whole
 * cycles elapsed (a day number), and the light ramps `day` (0 night .. 1 full
 * day) and `dusk` (bump while the light changes: the golden hours).
 */
export const DAYTIME = { phase: START, cycle: 0, day: 1, dusk: 0 };

/** The sun/moon light, for passes that sample its shadow map (Weather's light shafts). */
export const SUN_LIGHT: { current: THREE.DirectionalLight | null } = { current: null };

/** Shadow-map texels per side, and how far (horizontally, beyond the camera's focus distance) shadows are kept. */
const SHADOW_RES = 2048;
const SHADOW_REACH = 1.5;
const SHADOW_REACH_MAX = 230;
/** Light-space padding so casters just outside the view still throw shadows into it. */
const SHADOW_PAD = 10;
/** Constant depth / normal bias in world units (the normalised bias is derived from the fitted depth range). */
const BIAS_UNITS = 0.085;
const NORMAL_BIAS_TEXELS = 0.65;

const sunDir = new THREE.Vector3();
const skySun = new THREE.Vector3();
const focus = new THREE.Vector3();
const tmp = new THREE.Vector3();
const ray = new THREE.Vector3();
const lx = new THREE.Vector3();
const ly = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const CORNERS = [-1, -1, 1, -1, 1, 1, -1, 1] as const;

type Controls = { getTarget?: (out: THREE.Vector3) => THREE.Vector3 } | null;

/**
 * The point the camera is looking at and its distance: the RTS controls' orbit
 * target when present, else where the view axis meets the ground (walk mode,
 * the landing orbit) — but never past the axis point nearest the map centre,
 * so a showcase camera aimed above the horizon still focuses on the city.
 */
export function viewFocus(camera: THREE.Camera, controls: unknown, out: THREE.Vector3): number {
  const c = controls as Controls;
  if (c && typeof c.getTarget === "function") {
    c.getTarget(out);
    return camera.position.distanceTo(out);
  }
  camera.getWorldDirection(tmp);
  const ground = tmp.y < -0.02 ? -camera.position.y / tmp.y : Infinity;
  const nearCentre = Math.max(-camera.position.dot(tmp), 20);
  const t = Math.min(ground, nearCentre, 200);
  out.copy(camera.position).addScaledVector(tmp, t);
  return t;
}

/** Animated day/night: a long bright day with the sun high at top-left, short
 *  dawn/dusk, and a blue moonlit night that keeps the city readable. Drives the
 *  shared NIGHT uniform (window/lamp glow from dusk) and the SKY uniforms (dome,
 *  horizon haze, cloud shadows). The sun's shadow map is refitted every frame to
 *  the ground the camera actually sees (texel-snapped, so panning doesn't
 *  shimmer): crisp up close, still covering the whole town at overview.
 *  Cheap — mutates refs/uniforms in the render loop, no re-renders or allocation.
 *  `start` is the cycle phase at load. */
export function DayNight({ start = START }: { start?: number }) {
  const sun = SUN_LIGHT;
  const hemi = useRef<THREE.HemisphereLight>(null);
  const amb = useRef<THREE.AmbientLight>(null);
  const bg = useMemo(() => new THREE.Color(), []);

  useFrame((state) => {
    const { scene, camera, controls } = state;
    const clock = state.clock.elapsedTime / DAY_LEN + start;
    const p = clock % 1;
    // u: progress along the daylight arc (clamped at the ends through the night)
    const u = Math.min(1, p / DAY_SHARE);
    const arc = p < DAY_SHARE ? Math.sin(u * Math.PI) : 0;
    const day = Math.min(1, arc / Math.sin(TWILIGHT * Math.PI)); // 0 night .. 1 full day
    const dusk = 4 * day * (1 - day); // bump while the light is changing
    const night = 1 - day;
    NIGHT.value = Math.max(0, Math.min(1, (0.7 - day) / 0.5));
    DAYTIME.phase = p;
    DAYTIME.cycle = Math.floor(clock);
    DAYTIME.day = day;
    DAYTIME.dusk = dusk;
    // Weather: `cover` thickens the deck (dims the sun, greys the sky), `wet` is the rain itself.
    const cover = WEATHER.cloud, rain = WEATHER.rain, mist = WEATHER.mist;
    const overcast = cover * cover;

    const elev = SUN_LOW + (SUN_PEAK - SUN_LOW) * Math.sqrt(arc);
    const az = SUN_AZ + (u - 0.5) * SUN_SWEEP;
    sunDir.set(Math.cos(elev) * Math.cos(az), Math.sin(elev), Math.cos(elev) * Math.sin(az));
    const skyElev = elev - SUN_SET * night;
    skySun.set(Math.cos(skyElev) * Math.cos(az), Math.sin(skyElev), Math.cos(skyElev) * Math.sin(az));
    sunDir.lerp(MOON_DIR, night).normalize();

    // Sky + haze
    const zDay = dusk * 0.55;
    SKY.uZenith.value.copy(ZENITH[2]).lerp(ZENITH[0], day).lerp(ZENITH[1], zDay);
    SKY.uHorizon.value.copy(HORIZON[2]).lerp(HORIZON[0], day).lerp(HORIZON[1], dusk * 0.9);
    SKY.uGlow.value.copy(GLOW[0]).lerp(GLOW[1], Math.min(1, dusk * 1.4)).multiplyScalar((0.3 + dusk * 1.1) * (1 - 0.8 * overcast));
    SKY.uSunSky.value.copy(skySun);
    SKY.uSunColor.value.copy(DUSK_SUN).lerp(DAY_SUN, day * day);
    SKY.uSunVis.value = Math.min(1, day * 1.6) * (1 - 0.85 * overcast);
    SKY.uStars.value = Math.max(0, Math.min(1, (0.55 - day) / 0.45)) * (1 - overcast);
    SKY.uCloudLit.value.copy(CLOUD_LIT[2]).lerp(CLOUD_LIT[0], day).lerp(CLOUD_LIT[1], dusk * 0.8);
    SKY.uCloudShade.value.copy(CLOUD_SHADE[2]).lerp(CLOUD_SHADE[0], day).lerp(CLOUD_SHADE[1], dusk * 0.8);
    // Weather greys: the deck desaturates and darkens the whole sky; mist pales the horizon by day.
    grey(SKY.uZenith.value, cover * 0.8, 0.3 * overcast);
    grey(SKY.uHorizon.value, cover * 0.6, 0.15 * overcast);
    SKY.uHorizon.value.lerp(MIST_HAZE, mist * day * 0.45);
    grey(SKY.uCloudLit.value, cover * 0.7, 0.3 * overcast);
    grey(SKY.uCloudShade.value, cover * 0.6, 0.35 * overcast);
    // Broken cloud throws the most distinct shadows; a closed deck just dims the sun (below) instead.
    SKY.uCloudShadow.value = 0.28 * day * day * (1 + 0.6 * 4 * cover * (1 - cover)) * (1 - 0.75 * overcast);
    SKY.uTint.value.setRGB(1, 1, 1).lerp(NIGHT_TINT, night).lerp(DUSK_TINT, dusk * 0.9 * (1 - 0.6 * overcast)).lerp(RAIN_TINT, rain * 0.8);
    SKY.uSkyTime.value = state.clock.elapsedTime;

    const light = sun.current;
    if (light) {
      light.intensity = (0.55 + day * 2.25) * (1 - 0.6 * overcast);
      light.color.copy(MOON).lerp(DUSK_SUN, Math.min(1, day * 2)).lerp(DAY_SUN, day * day);
      fitShadow(light, sunDir, camera, viewFocus(camera, controls, focus));
    }
    if (hemi.current) {
      // overcast light is the sky's: the hemisphere fill takes over from the dimmed sun
      hemi.current.intensity = 0.75 + day * 0.05 + overcast * day * 0.35;
      hemi.current.color.copy(NIGHT_HEMI_SKY).lerp(DAY_HEMI_SKY, day);
      hemi.current.groundColor.copy(NIGHT_HEMI_GROUND).lerp(DAY_HEMI_GROUND, day);
      grey(hemi.current.color, cover * 0.6, 0);
    }
    if (amb.current) amb.current.intensity = 0.18 - day * 0.08;
  });

  return (
    <>
      <hemisphereLight ref={hemi} args={["#d2e6ff", "#8c8466", 0.8]} />
      <ambientLight ref={amb} intensity={0.1} />
      <directionalLight ref={sun} position={[-50, 65, 42]} intensity={2.8} castShadow shadow-mapSize={[SHADOW_RES, SHADOW_RES]} />
    </>
  );
}

/** Pulls `c` toward its own luminance by `desat` and darkens it by `dim` (weather greying that works by day and night alike). */
function grey(c: THREE.Color, desat: number, dim: number) {
  const l = c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
  const k = 1 - dim;
  c.setRGB((c.r + (l - c.r) * desat) * k, (c.g + (l - c.g) * desat) * k, (c.b + (l * 1.04 - c.b) * desat) * k);
}

/**
 * Fits the directional shadow camera to the ground footprint of the view: the
 * four screen-corner rays hit y=0 (clamped to a reach that grows with the zoom
 * distance), their light-space bounding box (+ padding) becomes the ortho
 * frustum, size quantised and centre snapped to whole texels so a moving camera
 * doesn't make shadow edges crawl.
 */
function fitShadow(light: THREE.DirectionalLight, dir: THREE.Vector3, camera: THREE.Camera, dist: number) {
  lx.crossVectors(UP, dir).normalize();
  ly.crossVectors(dir, lx);
  const reach = Math.min(dist * SHADOW_REACH + 40, SHADOW_REACH_MAX);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const cam = camera.position;
  for (let i = 0; i < 4; i++) {
    ray.set(CORNERS[i * 2], CORNERS[i * 2 + 1], 0.5).unproject(camera).sub(cam);
    const h = Math.hypot(ray.x, ray.z) || 1e-6;
    let t = ray.y < -1e-4 ? -cam.y / ray.y : Infinity;
    if (t * h > reach) t = reach / h;
    tmp.copy(cam).addScaledVector(ray, t).setY(0);
    const px = tmp.dot(lx), py = tmp.dot(ly), pz = tmp.dot(dir);
    if (px < minX) minX = px; if (px > maxX) maxX = px;
    if (py < minY) minY = py; if (py > maxY) maxY = py;
    if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
  }
  // Size quantised to 4-unit steps (stable texel size while panning), then centre snapped to a texel.
  const w = Math.ceil((maxX - minX + SHADOW_PAD * 2) / 4) * 4;
  const hgt = Math.ceil((maxY - minY + SHADOW_PAD * 2) / 4) * 4;
  const tx = w / SHADOW_RES, ty = hgt / SHADOW_RES;
  const cx = Math.round((minX + maxX) / 2 / tx) * tx;
  const cy = Math.round((minY + maxY) / 2 / ty) * ty;
  const cz = (minZ + maxZ) / 2;
  // Depth range: the footprint's spread along the light plus room for tall casters.
  const range = (maxZ - minZ) / 2 + 45;

  const target = light.target;
  target.position.set(0, 0, 0).addScaledVector(lx, cx).addScaledVector(ly, cy).addScaledVector(dir, cz);
  target.updateMatrixWorld();
  light.position.copy(target.position).addScaledVector(dir, range + 5);

  const sc = light.shadow.camera;
  sc.left = -w / 2;
  sc.right = w / 2;
  sc.top = hgt / 2;
  sc.bottom = -hgt / 2;
  sc.near = 1;
  sc.far = range * 2 + 10;
  sc.updateProjectionMatrix();
  light.shadow.bias = -BIAS_UNITS / (sc.far - sc.near);
  light.shadow.normalBias = Math.max(0.015, Math.max(tx, ty) * NORMAL_BIAS_TEXELS);
}
