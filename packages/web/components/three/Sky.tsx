"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

/**
 * Shared sky state. DayNight writes it every frame; the sky dome below and the
 * post-process atmosphere (fog colour, cloud shadows in Effects) read the same
 * uniform objects, so the horizon haze, the dome and the drifting cloud shadows
 * always agree. Colours are linear (THREE.Color colour management).
 */
export const SKY = {
  uZenith: new THREE.Uniform(new THREE.Color("#3f7fcf")),
  uHorizon: new THREE.Uniform(new THREE.Color("#bcdcf0")),
  /** Warm scatter around the sun (halo + horizon glow); strong at dusk, faint at noon. */
  uGlow: new THREE.Uniform(new THREE.Color("#fff1d6")),
  /** Where the sun disc sits (sinks below the horizon at dusk, unlike the light, which turns into the moon). */
  uSunSky: new THREE.Uniform(new THREE.Vector3(0, 1, 0)),
  uSunColor: new THREE.Uniform(new THREE.Color("#fff3dc")),
  /** 0..1 visibility of the sun disc and its halo. */
  uSunVis: new THREE.Uniform(1),
  uMoonDir: new THREE.Uniform(new THREE.Vector3(0.45, 0.82, -0.36).normalize()),
  /** 0..1 star + moon visibility. */
  uStars: new THREE.Uniform(0),
  uCloudLit: new THREE.Uniform(new THREE.Color("#ffffff")),
  uCloudShade: new THREE.Uniform(new THREE.Color("#b9c8dc")),
  /** Max darkening of the ground under a cloud (0 at night). */
  uCloudShadow: new THREE.Uniform(0.2),
  /** Cloud deck thickness from the weather: 0 fair-weather cumulus .. 1 overcast (Weather writes it). */
  uCloudCover: new THREE.Uniform(0),
  uSkyTime: new THREE.Uniform(0),
  /** Whole-frame grade tint: golden at dusk, moon-blue at night, neutral by day (read by the colour grade). */
  uTint: new THREE.Uniform(new THREE.Color(1, 1, 1)),
};

export type WeatherKind = "clear" | "cloudy" | "rain" | "mist";

/**
 * Live weather blend (all 0..1), written by `<Weather>` each frame and read by
 * DayNight (light and sky tones) and the HUD (`weatherState()`). Lives here
 * with the other shared sky state so DayNight and Weather don't import each
 * other. `kind` is the dominant condition, for labels.
 */
export const WEATHER = { kind: "clear" as WeatherKind, cloud: 0, rain: 0, mist: 0, wet: 0 };

/** Height of the cloud layer the dome shows and the ground shadows (and god-ray gaps) are cast from. */
export const CLOUD_H = 140;

/**
 * GLSL shared by the dome and the post atmosphere: uniform declarations, the
 * cloud coverage field (world XZ on the cloud layer), and the sky colour
 * functions. `skyHorizon(d)` equals `skyBase(d)` for any d at or below the
 * horizon, so terrain fogged with skyHorizon melts seamlessly into the dome.
 */
export const SKY_GLSL = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGlow;
uniform vec3 uSunSky;
uniform vec3 uSunColor;
uniform float uSunVis;
uniform vec3 uMoonDir;
uniform float uStars;
uniform vec3 uCloudLit;
uniform vec3 uCloudShade;
uniform float uCloudShadow;
uniform float uCloudCover;
uniform float uSkyTime;

#define CLOUD_H ${CLOUD_H.toFixed(1)}

float skyHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
vec2 skyGrad(vec2 i) { float a = skyHash(i) * 6.2831853; return vec2(cos(a), sin(a)); }
/** Gradient noise in about -0.7..0.7 (no value-noise grid blockiness). */
float skyNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(skyGrad(i), f), b = dot(skyGrad(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
  float c = dot(skyGrad(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0)), d = dot(skyGrad(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
/** Cloud density field (~-1..1) at a world XZ on the cloud layer, drifting with the wind; octaves rotated so no grid shows. */
float cloudField(vec2 p) {
  p = p * 0.014 + vec2(uSkyTime * 0.016, uSkyTime * 0.006);
  const mat2 R = mat2(0.8, -0.6, 0.6, 0.8);
  float n = skyNoise(p);
  p = R * p * 2.07 + 3.1;
  n += skyNoise(p) * 0.45;
  p = R * p * 2.11 + 7.7;
  n += skyNoise(p) * 0.2;
  return n;
}
/** Coverage 0..1 of a cloudField value: thresholds drop as the weather thickens the deck, merging the puffs into overcast. */
float cloudCoverage(float n) { return smoothstep(0.12 - uCloudCover * 0.5, 0.24 - uCloudCover * 0.42, n); }
/** Softer coverage for the ground shadows (a cloud's shadow is blurrier than its outline). */
float cloudShade(vec2 p) { return smoothstep(0.06 - uCloudCover * 0.5, 0.24 - uCloudCover * 0.42, cloudField(p)); }
/** Sun halo, evaluated for a direction at or above the horizon. */
vec3 skyHalo(vec3 d) {
  float s = max(dot(d, uSunSky), 0.0);
  return uGlow * (pow(s, 6.0) * 0.32 + pow(s, 60.0) * 0.55) * uSunVis;
}
/** Haze colour toward the horizon in d's azimuth (what distant terrain fades into). */
vec3 skyHorizon(vec3 d) {
  vec3 h = normalize(vec3(d.x, 0.0, d.z) + vec3(1e-5, 0.0, 0.0));
  return uHorizon + skyHalo(h);
}
/** Sky gradient + halo (no disc, stars or clouds). */
vec3 skyBase(vec3 d) {
  float up = max(d.y, 0.0);
  vec3 dd = normalize(vec3(d.x, up, d.z) + vec3(1e-5, 0.0, 0.0));
  float t = 1.0 - pow(1.0 - up, 4.5);
  return mix(uHorizon, uZenith, t) + skyHalo(dd);
}
`;

const vertexShader = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const fragmentShader = /* glsl */ `
${SKY_GLSL}
uniform vec2 uCamXZ;
varying vec3 vDir;

void main() {
  vec3 d = normalize(vDir);
  float up = d.y;
  vec3 col = skyBase(d);

  // Stars: one jittered point per small cell of the sphere, twinkling.
  if (uStars > 0.001 && up > 0.0) {
    vec3 sp = d * 210.0;
    vec3 cell = floor(sp);
    float h = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    vec3 c = cell + 0.5 + (vec3(fract(h * 13.1), fract(h * 71.7), fract(h * 37.3)) - 0.5) * 0.5;
    float star = smoothstep(0.32, 0.0, length(sp - c)) * step(0.982, h);
    col += vec3(0.9, 0.95, 1.0) * star * uStars * (0.55 + 0.45 * sin(uSkyTime * 1.7 + h * 91.0)) * smoothstep(0.0, 0.25, up) * 2.2;
    float md = dot(d, uMoonDir);
    col += vec3(0.85, 0.9, 1.0) * uStars * (smoothstep(0.99955, 0.99975, md) * 2.4 + pow(max(md, 0.0), 300.0) * 0.25);
  }

  // Sun disc: HDR so the bloom pass gives it a soft corona.
  float sd = dot(d, uSunSky);
  col += uSunColor * uSunVis * smoothstep(0.99935, 0.99965, sd) * 9.0;

  // Cartoon clouds on a flat layer CLOUD_H above the ground (same field the ground shadows use).
  if (up > 0.0) {
    vec2 p = uCamXZ + d.xz / (up + 0.06) * CLOUD_H;
    float n = cloudField(p);
    float cov = cloudCoverage(n);
    if (cov > 0.0) {
      // Self-shadowing: denser cloud toward the sun means this side faces away from it.
      float toward = cloudField(p + normalize(uSunSky.xz + vec2(1e-4)) * 14.0);
      float lit = clamp(0.85 - (toward - n) * 2.2, 0.0, 1.0);
      vec3 cc = mix(uCloudShade, uCloudLit, lit) + skyHalo(d) * 0.35;
      // Distant clouds sink into the horizon haze.
      cc = mix(cc, skyHorizon(d), (1.0 - smoothstep(0.0, 0.18, up)) * 0.5);
      col = mix(col, cc, cov * smoothstep(0.015, 0.08, up) * 0.95);
    }
  }
  gl_FragColor = vec4(col, 1.0);
}`;

/**
 * Sky dome: zenith→horizon gradient, sun disc and halo, drifting cartoon
 * clouds, and stars + moon at night. A unit sphere that follows the camera,
 * drawn first with no depth test/write so it never occludes the city and AO /
 * depth-of-field treat it as infinitely far. One draw call.
 */
export function Sky() {
  const mesh = useRef<THREE.Mesh>(null);
  const geometry = useMemo(() => new THREE.SphereGeometry(1, 32, 16), []);
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        name: "SkyDome",
        uniforms: { ...SKY, uCamXZ: new THREE.Uniform(new THREE.Vector2()) },
        vertexShader,
        fragmentShader,
        side: THREE.BackSide,
        depthTest: false,
        depthWrite: false,
        fog: false,
      }),
    [],
  );
  useEffect(() => () => { geometry.dispose(); material.dispose(); }, [geometry, material]);

  useFrame(({ camera }) => {
    const m = mesh.current;
    if (!m) return;
    m.position.copy(camera.position);
    const far = (camera as THREE.PerspectiveCamera).far ?? 400;
    m.scale.setScalar(far * 0.5);
    (material.uniforms.uCamXZ.value as THREE.Vector2).set(camera.position.x, camera.position.z);
  });

  return <mesh ref={mesh} geometry={geometry} material={material} renderOrder={-1000} frustumCulled={false} raycast={noRaycast} />;
}

function noRaycast() {}
