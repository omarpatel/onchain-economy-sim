"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer, N8AO, Outline, Vignette } from "@react-three/postprocessing";
import { BlendFunction, Effect, EffectAttribute, EffectPass, KawaseBlurPass, KernelSize, Resolution } from "postprocessing";
import { SKY, SKY_GLSL } from "./Sky.tsx";
import { viewFocus } from "./DayNight.tsx";
import { TILE, TOWN_RING, MAP_MARGIN } from "./world-style.ts";
import { useUi } from "../../lib/store.ts";

/** Half-extent where the aerial haze becomes total: the landscape skirt + sea run on past MAP_MARGIN
 *  (ridges out to ring ~60), so everything beyond ~ring 90 is pure horizon haze. */
const HAZE_EDGE = (16 + MAP_MARGIN + 50) * TILE;
/** Fraction of the way to HAZE_EDGE (along the horizontal view ray) where the haze starts. */
const HAZE_START = 0.5;

/** Tilt-shift: screen-space half-height (0 = centre line, 1 = top/bottom edge) where the blur starts / is full. */
const DOF_SCREEN = [0.45, 0.95] as const;
/** Strongest blend toward the blurred frame (a soft miniature hint, never a smear). */
const DOF_MAX = 0.6;
/** Focus distances (camera → orbit target) over which the miniature blur ramps from nearly off to full. */
const DOF_NEAR = 16;
const DOF_FAR = 80;
const DOF_MIN = 0.06;

const atmosphereFrag = /* glsl */ `
${SKY_GLSL}
uniform sampler2D uBlur;
uniform mat4 uProjInv;
uniform mat4 uCamWorld;
uniform vec3 uCamPos;
uniform float uFocus;
uniform float uDof;
uniform float uEdge;

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  vec3 col = inputColor.rgb;
  if (depth >= 0.999999) {
    // Sky: the dome is already in the image. Left sharp: the blur buffer is pre-haze, so blending it
    // here would ring hazed silhouettes with their un-hazed colour.
    outputColor = inputColor;
    return;
  }
  vec4 v = uProjInv * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  v.xyz /= v.w;
  vec3 world = (uCamWorld * vec4(v.xyz, 1.0)).xyz;

  // Ring distance in tiles beyond the town (Chebyshev, like the layout contract): <= 0 inside map + town.
  float beyond = max(abs(world.x), abs(world.z)) / ${TILE.toFixed(3)} - ${(16 + TOWN_RING).toFixed(1)};

  // Tilt-shift miniature: only the top/bottom screen bands, and there only what lies beyond the town
  // ring or well in front of the focus plane, so the whole map + town stays crisp at any zoom.
  float ahead = (uFocus + v.z) / uFocus;
  float screenBand = smoothstep(${DOF_SCREEN[0].toFixed(3)}, ${DOF_SCREEN[1].toFixed(3)}, abs(uv.y * 2.0 - 1.0));
  float coc = screenBand * max(smoothstep(-2.0, 10.0, beyond), smoothstep(0.25, 0.6, ahead)) * uDof * ${DOF_MAX.toFixed(3)};
  if (coc > 0.002) col = mix(col, texture2D(uBlur, uv).rgb, coc);

  // Drifting cloud shadows: the cloud layer's coverage, projected down along the sun.
  if (uCloudShadow > 0.001) {
    vec2 cp = world.xz + uSunSky.xz / max(uSunSky.y, 0.3) * (CLOUD_H - world.y);
    col *= 1.0 - uCloudShadow * cloudShade(cp);
  }

  // Aerial perspective, by world position so the map and town stay clear however far the camera is:
  // none inside map + town, building up across the countryside (capped, so ridges read as blue-grey
  // silhouettes; high ground stands a little out of it), plus an edge term that becomes total where
  // the horizontal view ray leaves the HAZE_EDGE square, so the landscape never ends in a hard edge.
  vec2 d = world.xz - uCamPos.xz;
  float hd = length(d);
  vec2 dir = d / max(hd, 1e-4);
  vec2 s = vec2(dir.x >= 0.0 ? 1.0 : -1.0, dir.y >= 0.0 ? 1.0 : -1.0);
  vec2 t = (uEdge - s * uCamPos.xz) / max(abs(dir), vec2(1e-4));
  float r = clamp((hd / max(min(t.x, t.y), 1.0) - ${HAZE_START.toFixed(3)}) / ${(1 - HAZE_START).toFixed(3)}, 0.0, 1.0);
  float haze = (1.0 - exp(-max(beyond + 2.0, 0.0) * 0.03)) * 0.75 * (1.0 - 0.4 * smoothstep(4.0, 35.0, world.y));
  float fog = max(pow(r, 1.6), haze);
  col = mix(col, skyHorizon(vec3(dir.x, 0.0, dir.y)), fog);
  outputColor = vec4(col, inputColor.a);
}`;

/**
 * Depth-aware atmosphere in one fullscreen effect: tilt-shift (a half-res
 * Kawase blur mixed into the top/bottom screen bands, only for what lies beyond
 * the town ring or well in front of the focus), cloud shadows from the sky's
 * cloud layer, and aerial perspective into the sky dome's horizon colour that
 * leaves map + town clear. Reads the shared SKY uniforms.
 */
class AtmosphereEffect extends Effect {
  readonly blurPass: KawaseBlurPass;
  readonly blurTarget: THREE.WebGLRenderTarget;
  readonly resolution: Resolution;
  /** Smoothed tilt-shift strength; the blur pass is skipped while it is ~0 (walk mode, interiors). */
  dof = 0;
  private readonly camera: THREE.Camera;

  constructor(camera: THREE.Camera) {
    super("AtmosphereEffect", atmosphereFrag, {
      attributes: EffectAttribute.DEPTH,
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, THREE.Uniform>([
        ...Object.entries(SKY),
        ["uBlur", new THREE.Uniform(null)],
        ["uProjInv", new THREE.Uniform(new THREE.Matrix4())],
        ["uCamWorld", new THREE.Uniform(new THREE.Matrix4())],
        ["uCamPos", new THREE.Uniform(new THREE.Vector3())],
        ["uFocus", new THREE.Uniform(60)],
        ["uDof", new THREE.Uniform(0)],
        ["uEdge", new THREE.Uniform(HAZE_EDGE)],
      ]),
    });
    this.camera = camera;
    this.blurTarget = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
    this.blurTarget.texture.name = "Atmosphere.Blur";
    this.uniforms.get("uBlur")!.value = this.blurTarget.texture;
    this.blurPass = new KawaseBlurPass({ kernelSize: KernelSize.LARGE, resolutionScale: 0.5 });
    const resolution = (this.resolution = new Resolution(this, Resolution.AUTO_SIZE, Resolution.AUTO_SIZE, 0.5));
    resolution.addEventListener("change", () => this.setSize(resolution.baseWidth, resolution.baseHeight));
  }

  setFocus(distance: number, strength: number) {
    this.uniforms.get("uFocus")!.value = Math.max(distance, 1);
    this.dof = strength;
  }

  override update(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget) {
    const cam = this.camera;
    (this.uniforms.get("uProjInv")!.value as THREE.Matrix4).copy(cam.projectionMatrixInverse);
    (this.uniforms.get("uCamWorld")!.value as THREE.Matrix4).copy(cam.matrixWorld);
    (this.uniforms.get("uCamPos")!.value as THREE.Vector3).setFromMatrixPosition(cam.matrixWorld);
    const on = this.dof > 0.004;
    this.uniforms.get("uDof")!.value = on ? this.dof : 0;
    if (on) this.blurPass.render(renderer, inputBuffer, this.blurTarget);
  }

  override setSize(width: number, height: number) {
    const resolution = this.resolution;
    resolution.setBaseSize(width, height);
    this.blurTarget.setSize(resolution.width, resolution.height);
    this.blurPass.resolution.copy(resolution);
  }

  override initialize(renderer: THREE.WebGLRenderer, alpha: boolean, frameBufferType: number) {
    this.blurPass.initialize(renderer, alpha, frameBufferType);
    if (frameBufferType !== undefined) this.blurTarget.texture.type = frameBufferType as THREE.TextureDataType;
  }

  override dispose() {
    this.blurPass.dispose();
    this.blurTarget.dispose();
    super.dispose();
  }
}

const gradeFrag = /* glsl */ `
uniform vec3 uTint;

// Khronos PBR Neutral shoulder: identity below ~0.76, smooth roll-off above (no hue skew, no clipping).
vec3 neutralShoulder(vec3 c) {
  const float start = 0.76;
  const float desat = 0.15;
  float x = min(c.r, min(c.g, c.b));
  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  c -= offset;
  float peak = max(c.r, max(c.g, c.b));
  if (peak < start) return c + offset;
  float d = 1.0 - start;
  float np = 1.0 - d * d / (peak + d - start);
  c *= np / peak;
  float g = 1.0 - 1.0 / (desat * (peak - np) + 1.0);
  return mix(c, vec3(np), g) + offset;
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  // Time-of-day tint (golden hour / moonlight) before the shoulder, so it rolls off like light would.
  vec3 c = neutralShoulder(max(inputColor.rgb, 0.0) * uTint);
  // Work in a perceptual (gamma) space for the look curves.
  vec3 g = pow(c, vec3(1.0 / 2.2));
  // Filmic contrast: a gentle S around mid-grey.
  g = mix(g, g * g * (3.0 - 2.0 * g), 0.2);
  float l = dot(g, vec3(0.2126, 0.7152, 0.0722));
  // Split tone: faintly teal shadows, faintly warm highlights.
  g *= mix(vec3(0.975, 1.0, 1.03), vec3(1.025, 1.0, 0.97), smoothstep(0.2, 0.9, l));
  // Saturation lift, eased off in the deepest shadows so they stay clean.
  l = dot(g, vec3(0.2126, 0.7152, 0.0722));
  g = mix(vec3(l), g, 1.0 + 0.08 * smoothstep(0.05, 0.35, l));
  outputColor = vec4(pow(max(g, 0.0), vec3(2.2)), inputColor.a);
}`;

/** Colour grade: time-of-day tint, soft highlight shoulder, filmic contrast, split toning, saturation lift. */
class GradeEffect extends Effect {
  constructor() {
    super("GradeEffect", gradeFrag, { blendFunction: BlendFunction.SRC, uniforms: new Map([["uTint", SKY.uTint]]) });
  }
}

/**
 * Post stack: N8AO (contact shadows under buildings; warm-brown so sandstone
 * stays clean instead of muddy grey), the atmosphere pass (tilt-shift, cloud
 * shadows, aerial perspective into the sky), Bloom (only HDR > 1: status
 * lights, premium rims, beacons, the sun disc), Outline (selected building;
 * fed by `<Select>` in Overlays), the colour grade, and a faint Vignette.
 * 4× MSAA on the scene render. The atmosphere runs as its own pass so Bloom
 * sees the hazed, defocused frame (distant lit windows don't flare through the
 * haze). The tilt-shift focus follows the camera's orbit target: strongest at
 * overview, nearly off zoomed in, off in walk mode and building interiors.
 */
export function Effects() {
  const camera = useThree((s) => s.camera);
  const atmosphere = useMemo(() => new AtmosphereEffect(camera), [camera]);
  const atmospherePass = useMemo(() => new EffectPass(camera, atmosphere), [camera, atmosphere]);
  const grade = useMemo(() => new GradeEffect(), []);
  useEffect(() => () => atmospherePass.dispose(), [atmospherePass]);
  useEffect(() => () => grade.dispose(), [grade]);

  useFrame((state, dt) => {
    const dist = viewFocus(state.camera, state.controls, focus);
    const ui = useUi.getState();
    const want = ui.walkMode || ui.interiorTile ? 0 : DOF_MIN + (1 - DOF_MIN) * THREE.MathUtils.smoothstep(dist, DOF_NEAR, DOF_FAR);
    const k = 1 - Math.exp(-dt * 4);
    atmosphere.setFocus(dist, atmosphere.dof + (want - atmosphere.dof) * k);
  });

  return (
    <EffectComposer multisampling={4} enableNormalPass={false} autoClear={false}>
      <N8AO aoRadius={1.6} intensity={1.8} distanceFalloff={1} color="#3b2f22" quality="performance" halfRes />
      <primitive object={atmospherePass} dispose={null} />
      <Bloom luminanceThreshold={1} mipmapBlur intensity={0.8} levels={4} radius={0.6} />
      <Outline blur edgeStrength={5} visibleEdgeColor={0x38bdf8} hiddenEdgeColor={0x0b2230} width={1200} xRay={false} />
      <primitive object={grade} dispose={null} />
      <Vignette offset={0.32} darkness={0.4} />
    </EffectComposer>
  );
}

const focus = new THREE.Vector3();
