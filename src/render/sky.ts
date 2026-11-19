// Sky/sea shader adapted from Saltline (saltline.games), used with the project owner's approval.
//
// Ported sky dome: cloud-deck fbm, sun aureole (mie glow), burning horizon gap
// toward the sun azimuth, warm/cool horizon band via skyToSun. The two include
// strings (noise fbm + sun helpers) were recovered from the same source file.
//
// The dome uses Saltline's vertex trick — view-space rotation only + z=w — so
// the sphere is always centred on the camera at far-plane depth; no per-frame
// follow needed. `toneMapped:false` and raw HDR output keep the sky bright;
// the DISPLAY material then appends the standard tonemapping/colorspace tail
// so it goes through the same ACES + sRGB path as every lit surface, while the
// ENV-capture material stays raw linear for a correct PMREM.

import * as THREE from 'three';
import { PALETTE } from './palette';
import { getNoiseTextures } from './noise';
import { SUN_DIR, SUN_COLOR } from './lighting';

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main(){ vDir = position; vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0); gl_Position = p.xyww; }
`;

// Saltline Ug include — white-noise texture sampled value noise + 3/5 octave fbm.
const UG = /* glsl */ `
uniform sampler2D tNoise;
float n2(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return texture2D(tNoise, (i + f + 0.5) / 256.0).r; }
float fbm5(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++){ s += a * n2(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p + 17.3; a *= 0.5; } return s / 0.96875; }
float fbm3(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 3; i++){ s += a * n2(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p + 17.3; a *= 0.5; } return s / 0.875; }
`;

// Saltline Ng include — sun uniforms + azimuth helpers.
const NG = /* glsl */ `
uniform vec3 uSunDir, uZen, uHor, uHorAway, uSunCol;
float skyToSun(vec3 d){ return clamp(dot(normalize(d.xz + vec2(1e-5)), normalize(uSunDir.xz)) * 0.5 + 0.5, 0.0, 1.0); }
vec3 horizonColor(vec3 d){
  float ts = skyToSun(d);
  vec3 c = mix(uHorAway, uHorAway * 1.25 + vec3(0.05, 0.03, 0.02), smoothstep(0.2, 0.75, ts));
  c = mix(c, uHor * vec3(1.9, 1.55, 1.2), pow(ts, 6.0));
  c = mix(c, vec3(1.0, 0.60, 0.24) * 3.4, pow(ts, 34.0));
  return c;
}
`;

// Verbatim SALTLINE_SKY body; __TAIL__ expands to the tonemapping/colorspace
// chunks for on-screen rendering (env capture leaves it empty).
const SKY_FRAG = /* glsl */ `
// SALTLINE_SKY
precision highp float;
varying vec3 vDir;
uniform float uTime, uEnv, uFlash;
uniform vec3 uFlashDir;
${UG}
${NG}

void main(){
  vec3 d = normalize(vDir);
  float h = max(d.y, 0.0);
  float mu = dot(d, uSunDir);
  float s = max(mu, 0.0);
  float ts = skyToSun(d);

  // ---- clear sky behind / below the deck ----
  vec3 hc = horizonColor(d);
  vec3 midC = mix(vec3(0.15, 0.24, 0.36), vec3(0.72, 0.50, 0.34), pow(ts, 3.0));   // pale band above the fire
  vec3 clearC = mix(hc, midC, smoothstep(0.0, 0.17, h));
  clearC = mix(clearC, vec3(0.085, 0.145, 0.24), smoothstep(0.10, 0.5, h));
  // aureole (mie glow round the sun)
  clearC += uSunCol * vec3(1.0, 0.86, 0.68) * (pow(s, 8.0) * 0.14 + pow(s, 64.0) * 0.55 + pow(s, 600.0) * 2.2 + pow(s, 6000.0) * 14.0);

  // ---- cloud deck ----
  vec2 cuv = d.xz / (h + 0.10) * vec2(0.62, 0.95);          // rolls of cloud run roughly east-west
  vec2 wind = vec2(-0.012, 0.004) * uTime;
  vec2 q = cuv + wind;
  float warp = fbm3(q * 0.45 + 7.1);
  vec2 qq = q + (warp - 0.5) * 1.3;
  float dens = fbm5(qq);
  // rippled underside (ridged detail), fading with distance so the horizon does not alias
  float ridg = 1.0 - abs(2.0 * fbm3(qq * 3.1 + 5.0) - 1.0);
  dens = dens * 0.86 + (ridg - 0.6) * 0.16 * smoothstep(0.03, 0.25, h);
  float big = n2(q * 0.19 + 3.7);
  float body = dens * 0.74 + big * 0.36;
  float cov = smoothstep(0.31, 0.50, body);
  // the deck ends above the eastern horizon: clear, burning gap toward the sun; almost down to the sea elsewhere
  float edge = mix(0.030, 0.285, pow(ts, 1.7));
  float rag = (n2(q * 0.9 + 11.0) - 0.5) * 0.16 + (dens - 0.5) * 0.10;
  float deck = smoothstep(edge - 0.035, edge + 0.11, h + rag * (0.35 + ts));
  cov *= deck;
  // the sun always burns through a ragged hole in the gap, never sits behind solid cloud
  float hole = smoothstep(0.972, 0.9985, mu + (dens - 0.5) * 0.012);
  cov *= 1.0 - 0.93 * hole;
  // thin scud drifting in the gap (veils the sun a little, catches fire)
  float scud = smoothstep(0.55, 0.85, fbm3(q * vec2(0.55, 1.9) + 31.0)) * (1.0 - deck) * smoothstep(0.02, 0.10, h) * 0.55 * (1.0 - 0.8 * hole);

  // lighting: density gradient toward the sun = self shadowing of the underside relief
  vec2 sd = normalize(uSunDir.xz);
  float densS = fbm5(qq + sd * 0.22);
  float relief = clamp((dens - densS) * 4.5 + 0.5, 0.0, 1.0);
  float thick = smoothstep(0.40, 0.72, body);
  vec3 cool = mix(vec3(0.155, 0.195, 0.255), vec3(0.030, 0.042, 0.064), thick);       // slate, darker where the deck is thick
  cool *= 0.55 + 0.9 * relief * relief;
  cool += vec3(0.07, 0.10, 0.15) * pow(1.0 - thick, 3.0);                             // thin spots let cold light through
  // warm light raking the underside from the gap: strongest near the sun and near the deck edge
  float nearSun = pow(ts, 5.0) * exp(-max(h - edge, 0.0) * 4.5) * 0.9 + pow(s, 7.0) * 0.9;
  vec3 warm = (uHor * vec3(1.30, 0.66, 0.40)) * nearSun * (0.05 + 2.2 * relief * relief * relief) * 1.15;
  // burning rim where cloud thins at the edge of the gap
  float rim = cov * (1.0 - cov) * 4.0;
  warm += uSunCol * rim * pow(ts, 4.0) * (0.5 + 1.6 * pow(s, 6.0)) * (1.0 - 0.85 * hole);
  vec3 cloudC = cool + warm;
  // sheet lightning inside the deck
  float fl = uFlash * pow(max(dot(d, uFlashDir), 0.0), 5.0);
  cloudC += vec3(0.55, 0.68, 1.0) * fl * (0.4 + 2.2 * dens * dens);
  // aerial perspective: far cloud melts into the horizon colour
  cloudC = mix(cloudC, hc * 0.55 + cloudC * 0.45, exp(-h * 11.0));

  vec3 col = mix(clearC, cloudC, cov * 0.985);
  vec3 scudC = mix(vec3(0.10, 0.11, 0.14), uHor * 1.5, pow(ts, 3.0)) + uSunCol * pow(s, 24.0) * 2.0;
  col = mix(col, scudC, scud);

  // sun disk (not in the environment capture: the directional light is the sun there)
  float veil = (1.0 - cov * 0.92) * (1.0 - scud * 0.7);
  float disk = smoothstep(0.999905, 0.999955, mu);
  col += vec3(1.0, 0.80, 0.52) * disk * 110.0 * veil * (1.0 - uEnv);

  // below the horizon: sea haze / ground bounce (mostly hidden by geometry)
  if (d.y < 0.0) {
    float t = clamp(-d.y * 5.0, 0.0, 1.0);
    vec3 low = mix(uHorAway * 0.42, vec3(0.060, 0.064, 0.070), uEnv);
    low += uHor * 0.55 * pow(ts, 6.0) * exp(d.y * 7.0);
    col = mix(hc + uSunCol * pow(s, 48.0) * 1.5, low, smoothstep(0.0, 1.0, t));
  }
  // keep the PMREM free of fireflies
  col = mix(col, min(col, vec3(6.0)), uEnv);
  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
__TAIL__}
`;

const FRAG_TAIL = /* glsl */ `
  // display-only gain: Saltline runs its own post grade/exposure pass after
  // the scene; we have none, so lift the dome slightly before ACES — the env
  // capture skips this tail and stays raw linear.
  gl_FragColor.rgb *= 1.15;
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`;

type SkyUniforms = { [u: string]: THREE.IUniform };

function skyUniforms(env: boolean): SkyUniforms {
  const { tNoise } = getNoiseTextures();
  return {
    tNoise: { value: tNoise },
    uTime: { value: 0 },
    uEnv: { value: env ? 1 : 0 },
    uFlash: { value: 0 },
    uFlashDir: { value: new THREE.Vector3(-0.5, 0.5, -0.7).normalize() },
    uSunDir: { value: SUN_DIR.clone() },
    uZen: { value: new THREE.Color(...PALETTE.skyZen) },
    uHor: { value: new THREE.Color(...PALETTE.skyHor) },
    uHorAway: { value: new THREE.Color(...PALETTE.skyHorAway) },
    uSunCol: { value: SUN_COLOR.clone() },
  };
}

function makeSkyMaterial(env: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: env ? 'saltline-sky-env' : 'saltline-sky',
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    fog: false,
    toneMapped: false,
    uniforms: skyUniforms(env),
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG.replace('__TAIL__', env ? '' : FRAG_TAIL),
  });
}

export interface SkyDome {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  uniforms: SkyUniforms;
}

export function createSkyDome(): SkyDome {
  const material = makeSkyMaterial(false);
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(240, 24, 12), material);
  mesh.name = 'sky';
  mesh.frustumCulled = false; // dome must render even when the sphere origin is off-screen
  mesh.renderOrder = -1000;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = false;
  return { mesh, material, uniforms: material.uniforms as SkyUniforms };
}

/**
 * Saltline Vy — one-shot PMREM of the dome with uEnv=1 (sun disk out, colours
 * clamped to 6.0) so every standard material reflects the sky + cloud deck.
 */
export function captureSkyEnv(renderer: THREE.WebGLRenderer, dome: SkyDome): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envMat = makeSkyMaterial(true);
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(dome.mesh.geometry, envMat));
  const rt = pmrem.fromScene(envScene, 0, 0.1, 100);
  envMat.dispose();
  pmrem.dispose();
  return rt.texture;
}
