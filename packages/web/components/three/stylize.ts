import * as THREE from "three";
import { NIGHT } from "./geometry.ts";
import { ROAD } from "./world-style.ts";

/**
 * Scene-wide style uniforms, shared by reference into every stylized material.
 * `uWind` is the wind clock (seconds; Effects advances it once per frame) and
 * `uWindStrength` scales sway (1 = breezy day); Vegetation reads both. `uWet`
 * (0 dry .. 1 soaked) is written by Weather and read by `stylize`.
 */
export const STYLE = {
  uWet: { value: 0 },
  uWind: { value: 0 },
  uWindStrength: { value: 1 },
};

/** Lamp-pool light map: street-lamp pools rasterised into a small world-aligned texture (see `setLampPools`). */
const LAMP_RES = 256;
const lampData = new Uint8Array(LAMP_RES * LAMP_RES);
const lampTex = new THREE.DataTexture(lampData, LAMP_RES, LAMP_RES, THREE.RedFormat, THREE.UnsignedByteType);
lampTex.magFilter = THREE.LinearFilter;
lampTex.minFilter = THREE.LinearFilter;
lampTex.needsUpdate = true;
/** World→texture transform: (origin x, origin z, 1/extent x, 1/extent z). Starts off-map so nothing is lit before lamps arrive. */
const LAMP_XF = { value: new THREE.Vector4(1e6, 1e6, 1e-6, 1e-6) };
const LAMP_TEX = { value: lampTex };
/** The lamp map and its world→uv transform (`uv = (world.xz - xf.xy) * xf.zw`; zero outside), for shaders with their own lighting (water reflections). */
export const LAMP_MAP = { uStyLamp: LAMP_TEX, uStyLampXf: LAMP_XF };
/** Radius (world units) of the warm pool under one in-map street lamp; the head (Features' `lamp`) overhangs the corner by ~0.16. */
const POOL_R = 2.3;
const POOL_IN = 0.16;
/** Lamps stand on the south-east corner sidewalk of their intersection (Features' CURB). */
const CURB = ROAD.asphalt / 2 + ROAD.walk / 2;

/**
 * Rasterises the street-lamp pools (one per `roads.lamps` intersection) into
 * the shared lamp map every stylized material samples at night. Called when
 * the road net changes, never per frame. The map has a zero border so
 * everything outside it stays unlit under clamp-to-edge sampling.
 */
export function setLampPools(lamps: readonly (readonly [number, number])[]): void {
  lampData.fill(0);
  if (lamps.length === 0) {
    LAMP_XF.value.set(1e6, 1e6, 1e-6, 1e-6);
    lampTex.needsUpdate = true;
    return;
  }
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of lamps) {
    const px = x + CURB - POOL_IN, pz = z + CURB - POOL_IN;
    x0 = Math.min(x0, px); z0 = Math.min(z0, pz); x1 = Math.max(x1, px); z1 = Math.max(z1, pz);
  }
  // pad by the pool radius plus two texels so the border row/column stays zero
  const ex = x1 - x0 + 2 * POOL_R, ez = z1 - z0 + 2 * POOL_R;
  const padX = (ex * 2) / (LAMP_RES - 4), padZ = (ez * 2) / (LAMP_RES - 4);
  const ox = x0 - POOL_R - padX, oz = z0 - POOL_R - padZ;
  const sx = ex + 2 * padX, sz = ez + 2 * padZ;
  const tx = sx / LAMP_RES, tz = sz / LAMP_RES;
  const rx = Math.ceil(POOL_R / tx), rz = Math.ceil(POOL_R / tz);
  for (const [x, z] of lamps) {
    const px = x + CURB - POOL_IN, pz = z + CURB - POOL_IN;
    const ci = Math.floor((px - ox) / tx), cj = Math.floor((pz - oz) / tz);
    for (let j = Math.max(1, cj - rz); j <= Math.min(LAMP_RES - 2, cj + rz); j++) {
      for (let i = Math.max(1, ci - rx); i <= Math.min(LAMP_RES - 2, ci + rx); i++) {
        const dx = ox + (i + 0.5) * tx - px, dz = oz + (j + 0.5) * tz - pz;
        const q = (dx * dx + dz * dz) / (POOL_R * POOL_R);
        if (q >= 1) continue;
        const k = j * LAMP_RES + i;
        lampData[k] = Math.min(255, lampData[k] + Math.round((1 - q) * (1 - q) * 255));
      }
    }
  }
  LAMP_XF.value.set(ox, oz, 1 / sx, 1 / sz);
  lampTex.needsUpdate = true;
}

export interface StylizeOptions {
  /** Height (world units) over which walls climb out of the ground-contact darkening; 0 disables it (terrain, water). Default 1.4. */
  aoHeight?: number;
  /** Rain darkening + puddle/streak gloss from `STYLE.uWet`. Default true; off for water. */
  wet?: boolean;
}

const VERT_HEAD = /* glsl */ `
varying vec3 vStyWorld;`;

/** World position without relying on three's optional `worldPosition` (only computed with shadows/envmaps). */
const VERT_BODY = /* glsl */ `
{
  vec4 styW = vec4( transformed, 1.0 );
  #ifdef USE_BATCHING
    styW = batchingMatrix * styW;
  #endif
  #ifdef USE_INSTANCING
    styW = instanceMatrix * styW;
  #endif
  vStyWorld = ( modelMatrix * styW ).xyz;
}`;

const FRAG_HEAD = /* glsl */ `
uniform float uStyWet;
uniform float uStyNight;
uniform sampler2D uStyLamp;
uniform vec4 uStyLampXf;
varying vec3 vStyWorld;
float styHash( vec2 p ) { vec3 q = fract( p.xyx * 0.1031 ); q += dot( q, q.yzx + 33.33 ); return fract( ( q.x + q.y ) * q.z ); }
float styNoise( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( styHash( i ), styHash( i + vec2( 1.0, 0.0 ) ), f.x ), mix( styHash( i + vec2( 0.0, 1.0 ) ), styHash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}`;

/** Before the PBR material is assembled: world normal + wet albedo/roughness (needs `normal`, so after normal_fragment). */
function fragSurface(wet: boolean): string {
  return /* glsl */ `
vec3 styN = inverseTransformDirection( normal, viewMatrix );
float styUp = smoothstep( 0.55, 0.95, styN.y );
float styGloss = 0.0;
${wet ? /* glsl */ `if ( uStyWet > 0.001 ) {
  // flat ground pools into puddles; walls carry rain streaks running down along the face
  float styPuddle = smoothstep( 0.42, 0.72, styNoise( vStyWorld.xz * 0.85 ) );
  float styAlong = dot( vStyWorld.xz, normalize( vec2( -styN.z, styN.x ) + 1e-5 ) );
  float styStreak = smoothstep( 0.5, 0.85, styNoise( vec2( styAlong * 7.0, vStyWorld.y * 0.45 + styHash( vec2( floor( styAlong * 7.0 ), 3.1 ) ) * 9.0 ) ) );
  styGloss = uStyWet * mix( styStreak * 0.85, 0.3 + 0.7 * styPuddle, styUp );
  diffuseColor.rgb *= 1.0 - uStyWet * ( 0.26 + 0.16 * styUp );
  roughnessFactor = mix( roughnessFactor, 0.1, styGloss );
}` : ""}`;
}

/**
 * After three's lights: soft terminator (a little unshadowed sun wraps past
 * the shadow line), warm bounce from sunlit ground onto walls turned away from
 * the sun, cool sky rim, wall darkening toward the ground, wet sky sheen, and
 * warm lamp pools at night. Colours come from the live lights, so DayNight's
 * palette drives every term.
 */
function fragLight(aoHeight: number): string {
  return /* glsl */ `
{
  vec3 styV = geometryViewDir;
  float styNdV = saturate( dot( geometryNormal, styV ) );
  float stySide = 1.0 - abs( styN.y );
  vec3 styAlbedo = BRDF_Lambert( material.diffuseColor );
  ${aoHeight > 0 ? /* glsl */ `
  float styAo = mix( 1.0, mix( 0.7, 1.0, smoothstep( 0.0, ${aoHeight.toFixed(3)}, vStyWorld.y ) ), stySide );
  reflectedLight.indirectDiffuse *= styAo;
  reflectedLight.directDiffuse *= mix( 1.0, styAo, 0.35 );` : ""}
  #if NUM_HEMI_LIGHTS > 0
    vec3 stySky = hemisphereLights[ 0 ].skyColor;
  #else
    vec3 stySky = vec3( 0.55, 0.65, 0.85 );
  #endif
  #if NUM_DIR_LIGHTS > 0
    vec3 styL = directionalLights[ 0 ].direction;
    vec3 stySun = directionalLights[ 0 ].color;
    float styNL = dot( geometryNormal, styL );
    float styWrap = saturate( 1.0 - abs( styNL ) / 0.4 );
    reflectedLight.directDiffuse += stySun * ( 0.18 * styWrap * styWrap ) * styAlbedo;
    vec3 styLw = inverseTransformDirection( styL, viewMatrix );
    float styBounce = saturate( -dot( styN.xz, normalize( styLw.xz + 1e-5 ) ) ) * stySide * saturate( styLw.y * 2.5 );
    reflectedLight.indirectDiffuse += stySun * vec3( 1.0, 0.84, 0.64 ) * ( 0.14 * styBounce ) * styAlbedo;
    float styBack = saturate( -dot( styV, styL ) );
  #else
    vec3 stySun = vec3( 0.0 );
    float styBack = 0.0;
  #endif
  float styRim = pow( 1.0 - styNdV, 4.0 ) * ( 0.5 + 0.5 * saturate( styN.y + 0.5 ) );
  reflectedLight.indirectDiffuse += ( stySky * 0.9 + stySun * styBack * 0.5 ) * styRim * styAlbedo;
  reflectedLight.indirectSpecular += stySky * styGloss * ( 0.06 + 0.5 * pow( 1.0 - styNdV, 3.0 ) );
  vec2 styLuv = ( vStyWorld.xz - uStyLampXf.xy ) * uStyLampXf.zw;
  float styPool = uStyNight > 0.001 ? texture2D( uStyLamp, styLuv ).r * uStyNight * ( 1.0 - smoothstep( 0.25, 1.4, vStyWorld.y ) ) : 0.0;
  reflectedLight.directDiffuse += vec3( 1.0, 0.64, 0.32 ) * ( styPool * ( 2.6 + 4.0 * styGloss ) * ( 0.45 + 0.55 * max( styN.y, 0.0 ) ) ) * styAlbedo * PI;
}`;
}

function inject(src: string, anchor: string, text: string, after: boolean): string {
  const at = src.indexOf(anchor);
  if (at < 0) throw new Error(`stylize: anchor ${anchor} missing (a patch replaced it, or three changed)`);
  return after ? src.slice(0, at + anchor.length) + text + src.slice(at + anchor.length) : src.slice(0, at) + text + "\n" + src.slice(at);
}

/**
 * Shared stylized lighting for any MeshStandardMaterial: call at the end of
 * its `onBeforeCompile(shader)`. Adds a wrapped soft terminator, warm
 * ground bounce + cool sky rim (tinted by the live sun/hemisphere lights, so
 * they follow the day), a subtle darkening of walls toward the ground so
 * buildings sit on it, rain darkening with puddles/streaks from
 * `STYLE.uWet`, and warm street-lamp pools at night. Idempotent, so a
 * material built on `tintedStandardMaterial` may call it again safely.
 */
const BASELINE = true;
export function stylize(shader: THREE.WebGLProgramParametersWithUniforms, opts: StylizeOptions = {}): void {
  if (shader.fragmentShader.includes("vStyWorld")) return;
  shader.uniforms.uStyWet = STYLE.uWet;
  shader.uniforms.uStyNight = NIGHT;
  shader.uniforms.uStyLamp = LAMP_TEX;
  shader.uniforms.uStyLampXf = LAMP_XF;
  if (BASELINE) return;
  let v = shader.vertexShader;
  v = inject(v, "#include <common>", VERT_HEAD, true);
  v = inject(v, "#include <project_vertex>", VERT_BODY, true);
  shader.vertexShader = v;
  let f = shader.fragmentShader;
  f = inject(f, "#include <common>", FRAG_HEAD, true);
  f = inject(f, "#include <lights_physical_fragment>", fragSurface(opts.wet ?? true), false);
  f = inject(f, "#include <aomap_fragment>", fragLight(opts.aoHeight ?? 1.4), false);
  shader.fragmentShader = f;
}
