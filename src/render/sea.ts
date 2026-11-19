// Sky/sea shader adapted from Saltline (saltline.games), used with the project owner's approval.
//
// Ported sea: MeshStandardMaterial patched via onBeforeCompile (ART-SPEC rule:
// never a RawShaderMaterial where a standard patch suffices). The patch mirrors
// Saltline's water —
//   vertex:  Gerstner-ish swell displacement over 4 wave trains (B1), damped
//            with distance so the horizon stays still;
//   fragment: analytic slopes for the same trains + a second, finer train set
//            (Db) + three scrolling detail-normal taps off a shared noise tile;
//            foam/scum ring from a signed distance field to the hull;
//            cat's-paw gust patches + long-swell shading; contact-shadow AO
//            inside 8 m of the hull; sun-azimuth glitter; far-field haze.
// Only the distance field changed: Saltline's quay wall + moored-hull box is
// replaced by our deck footprint — a 64×40 rectangle centred on origin.

import * as THREE from 'three';
import { MAP } from '../game/map';
import { PALETTE } from './palette';
import { getNoiseTextures } from './noise';
import { SUN_DIR, SUN_COLOR } from './lighting';

// Saltline wave trains: [dirX, dirZ, wavelength, amplitude].
// B1 = swell (vertex displacement + fragment slopes), Db = short chop (slopes only).
const B1: number[][] = [
  [-0.92, 0.39, 9.5, 0.06],
  [-0.75, -0.66, 5.7, 0.04],
  [-0.99, 0.12, 3.3, 0.026],
  [-0.5, 0.87, 2, 0.016],
];
const DB: number[][] = [
  [-0.8, 0.6, 1.31, 0.02],
  [-0.95, -0.31, 0.83, 0.014],
  [-0.35, -0.94, 0.57, 0.01],
  [-0.6, 0.8, 0.39, 0.007],
  [-1, 0.05, 0.27, 0.005],
  [0.3, 0.95, 0.47, 0.006],
  [-0.86, -0.51, 0.21, 0.0035],
];

// Normalize direction; append k = 2π/λ and ω = √(g·k) deep-water dispersion.
const waves = (list: number[][]): number[][] =>
  list.map(([dx, dz, lam, amp]) => {
    const len = Math.hypot(dx, dz);
    const k = (2 * Math.PI) / lam;
    return [dx / len, dz / len, lam, amp, k, Math.sqrt(9.81 * k)];
  });
const W1 = waves(B1);
const W2 = waves(DB);

const fi = (i: number): string => (Number.isInteger(i) ? i.toFixed(1) : i.toFixed(5));

// CR — vertex displacement (Gerstner xz + y), Saltline CR block.
const CR = W1.map(
  (i) => `  { float ph = ${fi(i[4])} * dot(vec2(${fi(i[0])}, ${fi(i[1])}), swp.xz) - ${fi(i[5])} * uTime; sdisp.y += ${fi(i[3])} * sin(ph); sdisp.xz += vec2(${fi(i[0])}, ${fi(i[1])}) * (${fi(i[3] * 0.6)} * cos(ph)); }`,
).join('\n');

// PR — analytic slope of the B1 trains, Saltline PR block.
const PR = W1.map(
  (i) => `  slopeA += vec2(${fi(i[0])}, ${fi(i[1])}) * (${fi(i[3] * i[4])} * cos(${fi(i[4])} * dot(vec2(${fi(i[0])}, ${fi(i[1])}), sxz) - ${fi(i[5])} * uTime));`,
).join('\n');

// IR — analytic slope of the Db chop trains, Saltline IR block.
const IR = W2.map(
  (i) => `  slopeB += vec2(${fi(i[0])}, ${fi(i[1])}) * (${fi(i[3] * i[4])} * cos(${fi(i[4])} * dot(vec2(${fi(i[0])}, ${fi(i[1])}), sxz) - ${fi(i[5])} * uTime));`,
).join('\n');

// Saltline zR — shared declarations; uSunColW added for the glitter term.
const ZR = /* glsl */ `
uniform float uTime; uniform sampler2D uDetail, uDetailN; uniform vec3 uHazeA, uHazeB, uSunDirW, uSunColW;
varying vec3 vGWorld; varying float vSAmp;
float gRough; vec2 gNxz; float gOcc; float gSDist; float gSpark;
`;

// Saltline DR — injected at map_fragment so it runs before roughness/normal
// are consumed. The only edit vs the source: hull distance field is our deck
// rectangle (64×40 centred) instead of the quay wall + moored hull.
const DR = /* glsl */ `
{
  vec2 sxz = vGWorld.xz;
  float sd = length(cameraPosition - vGWorld); gSDist = sd;
  vec2 slopeA = vec2(0.0), slopeB = vec2(0.0);
${PR}
${IR}
  float nearB = 1.0 - smoothstep(25.0, 110.0, sd);
  vec2 t1 = texture2D(uDetailN, sxz * 0.113 + uTime * vec2(-0.021, 0.009)).ba - 0.5;
  vec2 t2 = texture2D(uDetailN, sxz * 0.031 + uTime * vec2(-0.007, -0.004)).ba - 0.5;
  vec2 t3 = texture2D(uDetailN, sxz.yx * 0.39 + uTime * vec2(0.031, -0.027)).ba - 0.5;
  gNxz = slopeA * vSAmp + slopeB * nearB + t1 * 0.2 + t2 * 0.24 + t3 * 0.1 * nearB;
  // foam / scum ring around the hull: deck slab is 64×40 centred on origin
  vec2 hq = abs(sxz) - vec2(32.0, 20.0);
  float de = length(max(hq, 0.0)) + min(max(hq.x, hq.y), 0.0);
  vec4 fn = texture2D(uDetail, sxz * 0.41 + uTime * vec2(-0.012, 0.007));
  vec4 fn2 = texture2D(uDetail, sxz * 0.093 + uTime * vec2(0.004, 0.003));
  float band = 1.0 - smoothstep(0.0, 0.2 + fn2.g * fn2.g * 2.2, de);
  float foam = clamp(band * smoothstep(0.5, 0.68, fn.a * 0.55 + fn.r * 0.25 + fn2.g * 0.3 + band * 0.2), 0.0, 1.0) * step(-0.3, de);
  float scum = (1.0 - smoothstep(0.0, 5.0, de)) * smoothstep(0.4, 0.7, fn2.g);
  vec3 alb = vec3(0.0045, 0.013, 0.017);
  alb = mix(alb, vec3(0.03, 0.04, 0.034), scum * 0.6);
  alb = mix(alb, vec3(0.3, 0.32, 0.3), foam * 0.7);
  diffuseColor.rgb *= alb;
  // wind structure: broad cat's-paw patches (ruffled, darker, duller) between calmer slicks, plus long swell shading
  vec4 fn3 = texture2D(uDetail, sxz * 0.0123 + uTime * vec2(0.0016, 0.0011));
  float gust = smoothstep(0.38, 0.62, fn2.g * 0.45 + fn3.g * 0.75 - 0.1);
  float swell = sin(dot(sxz, vec2(-0.118, 0.05)) - uTime * 0.55 + fn3.a * 5.0) * 0.5 + 0.5;
  gNxz = gNxz * mix(0.4, 1.35, gust) + vec2(-0.92, 0.39) * (swell - 0.5) * 0.07;
  gSpark = mix(0.55, 1.0, swell) * mix(1.0, 0.6, gust);
  diffuseColor.rgb *= mix(1.0, 0.6, gust);
  gRough = mix(mix(0.1, 0.32, smoothstep(12.0, 380.0, sd)) * mix(0.62, 1.5, gust), 0.65, max(foam, scum * 0.3));
  gNxz *= 1.0 - foam * 0.6;
  gOcc = mix(0.3, 1.0, smoothstep(0.0, 8.0, de)) * mix(0.8, 1.05, swell);
}
`;

// Saltline LR — far-field haze toward the horizon colour of that azimuth.
const LR = /* glsl */ `
{
  vec3 sdir = normalize(vGWorld - cameraPosition);
  float toSun = pow(max(dot(normalize(sdir.xz + vec2(1e-5)), normalize(uSunDirW.xz)), 0.0), 3.0);
  vec3 hz = mix(uHazeA, uHazeB, toSun);
  outgoingLight = mix(outgoingLight, hz, smoothstep(220.0, 860.0, gSDist) * 0.8);
}
`;

export function createSea(): THREE.Mesh {
  const { detail, detailN } = getNoiseTextures();
  const uniforms: { [u: string]: THREE.IUniform } = {
    uTime: { value: 0 },
    uDetail: { value: detail },
    uDetailN: { value: detailN },
    uHazeA: { value: new THREE.Color(...PALETTE.skyHorAway).multiplyScalar(0.85) },
    uHazeB: { value: new THREE.Color(...PALETTE.skyHor).multiplyScalar(0.8) },
    uSunDirW: { value: SUN_DIR.clone() },
    uSunColW: { value: SUN_COLOR.clone() },
  };

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.1,
    metalness: 0.0,
    envMapIntensity: 1.0,
  });
  mat.name = 'sea';
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader =
      `uniform float uTime; varying vec3 vGWorld; varying float vSAmp;\n` +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
  vec3 swp = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vSAmp = 1.0 - smoothstep(50.0, 220.0, distance(swp.xz, vec2(0.0, 0.0)));
  vec3 sdisp = vec3(0.0);
${CR}
  transformed += sdisp * vSAmp;
  vGWorld = swp;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n` + ZR)
      .replace('#include <map_fragment>', DR)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gRough;')
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
  normal = normalize(mat3(viewMatrix) * normalize(vec3(-gNxz.x, 1.0, -gNxz.y)));`,
      )
      .replace(
        '#include <lights_fragment_maps>',
        `#include <lights_fragment_maps>
  radiance *= gOcc; iblIrradiance *= gOcc;`,
      )
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
  { // sun glitter: strongest along the sun's azimuth, calmer to the sides; broken by swell and cat's paws
    vec3 sv = normalize(vGWorld - cameraPosition);
    float az = max(dot(normalize(sv.xz + vec2(1e-5)), normalize(uSunDirW.xz)), 0.0);
    reflectedLight.directSpecular = min(reflectedLight.directSpecular, vec3(40.0)) * gSpark * mix(0.3, 1.0, az * az * az);
    // tight sparkle riding the wave normal
    vec3 wn = normalize(vec3(-gNxz.x, 1.0, -gNxz.y));
    float glint = pow(max(dot(reflect(sv, wn), uSunDirW), 0.0), 300.0);
    reflectedLight.directSpecular += uSunColW * glint * 2.0 * gSpark;
  }`,
      )
      .replace('#include <opaque_fragment>', LR + `\n#include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => 'saltline-sea-1';

  // PlaneGeometry lives in XY — bake it into XZ so `transformed` is already
  // world-axis-aligned, then bake waterY in too (mesh stays at identity).
  const geo = new THREE.PlaneGeometry(600, 600, 160, 160).rotateX(-Math.PI / 2);
  geo.translate(0, MAP.waterY, 0);
  const sea = new THREE.Mesh(geo, mat);
  sea.name = 'sea';
  sea.receiveShadow = true;
  sea.castShadow = false;
  sea.frustumCulled = false;
  sea.matrixAutoUpdate = false;
  sea.onBeforeRender = () => {
    uniforms.uTime.value = performance.now() * 0.001;
  };
  return sea;
}
