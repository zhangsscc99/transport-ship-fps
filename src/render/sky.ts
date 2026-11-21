// Sky dome + multi-layer volumetric cloud bands + additive sun halo sprite.
// Adapted from Saltline (saltline.games), used with project owner approval.
//
// Display dome uses view-space rotation + z=w so it sits at far depth with no
// per-frame follow; env-capture dome uses a regular sphere inside PMREMGenerator
// so it never clips on far-plane z==w under any driver or SwiftShader.

import * as THREE from 'three';
import { PALETTE } from './palette';
import { getNoiseTextures } from './noise';
import { SUN_DIR, SUN_COLOR } from './lighting';

const SKY_VERT_DISPLAY = /* glsl */ `
varying vec3 vDir;
void main(){
  vDir = position;
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
  gl_Position = p.xyww;
}
`;

// Regular sphere projection for PMREM capture (avoids z==w clipping in cubemap cameras).
const SKY_VERT_ENV = /* glsl */ `
varying vec3 vDir;
void main(){
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const UG = /* glsl */ `
uniform sampler2D tNoise;
float n2(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return texture2D(tNoise, (i + f + 0.5) / 256.0).r; }
float fbm5(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++){ s += a * n2(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p + 17.3; a *= 0.5; } return s / 0.96875; }
float fbm3(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 3; i++){ s += a * n2(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p + 17.3; a *= 0.5; } return s / 0.875; }
`;

const NG = /* glsl */ `
uniform vec3 uSunDir, uZen, uHor, uHorAway, uSunCol, uFogCol;
float skyToSun(vec3 d){ return clamp(dot(normalize(d.xz + vec2(1e-5)), normalize(uSunDir.xz)) * 0.5 + 0.5, 0.0, 1.0); }
vec3 horizonColor(vec3 d){
  float ts = skyToSun(d);
  // Base horizon anchored near uFogCol so sea & distant cranes fade with zero hard seam
  vec3 away = mix(uHorAway, uFogCol, 0.55);
  vec3 c = mix(away, away * 1.10 + vec3(0.05, 0.035, 0.015), smoothstep(0.18, 0.72, ts));
  c = mix(c, uHor * vec3(1.12, 0.94, 0.74), pow(ts, 4.5));
  c = mix(c, vec3(0.95, 0.72, 0.44) * 1.15, pow(ts, 22.0));
  return c;
}
`;

const SKY_FRAG = /* glsl */ `
precision highp float;
varying vec3 vDir;
uniform float uTime, uEnv;
${UG}
${NG}

void main(){
  vec3 d = normalize(vDir);
  float h = max(d.y, 0.0);
  float mu = dot(d, uSunDir);
  float s = max(mu, 0.0);
  float ts = skyToSun(d);

  // ---- 1. Gradient sky dome (horizon → mid maritime blue → zenith) ----
  vec3 hc = horizonColor(d);
  vec3 midC = mix(vec3(0.19, 0.30, 0.45), vec3(0.64, 0.47, 0.33), pow(ts, 3.0));
  vec3 clearC = mix(hc, midC, smoothstep(0.0, 0.18, h));
  clearC = mix(clearC, uZen, smoothstep(0.14, 0.62, h));

  // Mie forward-scattering aureole around low sun (filmic, keeps p95 in 150–230 without white-out)
  clearC += uSunCol * vec3(1.0, 0.85, 0.66) * (
    pow(s, 7.0) * 0.065 +
    pow(s, 52.0) * 0.16 +
    pow(s, 480.0) * 0.55 +
    pow(s, 5000.0) * 3.0
  );

  // ---- 2. Layer A: High wispy cirrus streaks (altitude high, soft warm glow) ----
  vec2 cuvHi = d.xz / (h + 0.24) * vec2(0.45, 1.35) + vec2(-0.005, 0.002) * uTime;
  float cirrusN = fbm3(cuvHi * 1.4 + fbm3(cuvHi * 0.6) * 0.8);
  float cirrus = smoothstep(0.50, 0.78, cirrusN) * smoothstep(0.06, 0.28, h) * (1.0 - smoothstep(0.55, 0.92, h));
  vec3 cirrusCol = mix(vec3(0.42, 0.52, 0.64), uSunCol * 1.05, 0.35 + 0.65 * pow(ts, 2.0));
  vec3 col = mix(clearC, cirrusCol, cirrus * 0.45);

  // ---- 3. Layer B: Mid volumetric cumulus cloud deck (self-shadowed underside relief) ----
  vec2 cuv = d.xz / (h + 0.11) * vec2(0.60, 0.92);
  vec2 wind = vec2(-0.011, 0.004) * uTime;
  vec2 q = cuv + wind;
  float warp = fbm3(q * 0.45 + 7.1);
  vec2 qq = q + (warp - 0.5) * 1.25;
  float dens = fbm5(qq);
  float ridg = 1.0 - abs(2.0 * fbm3(qq * 3.0 + 5.0) - 1.0);
  dens = dens * 0.86 + (ridg - 0.58) * 0.16 * smoothstep(0.04, 0.26, h);
  float big = n2(q * 0.20 + 3.7);
  float body = dens * 0.72 + big * 0.36;
  float cov = smoothstep(0.35, 0.56, body);

  // Open glowing horizon gap toward the sun so warm light pours across the water
  float edge = mix(0.045, 0.29, pow(ts, 1.8));
  float rag = (n2(q * 0.9 + 11.0) - 0.5) * 0.15 + (dens - 0.5) * 0.10;
  float deck = smoothstep(edge - 0.04, edge + 0.12, h + rag * (0.35 + ts));
  cov *= deck;
  float hole = smoothstep(0.968, 0.998, mu + (dens - 0.5) * 0.012);
  cov *= 1.0 - 0.92 * hole;

  // Volumetric self-shadowing along sun direction
  vec2 sd = normalize(uSunDir.xz);
  float densS = fbm5(qq + sd * 0.24);
  float relief = clamp((dens - densS) * 4.2 + 0.52, 0.0, 1.0);
  float thick = smoothstep(0.42, 0.74, body);
  vec3 coolCloud = mix(vec3(0.30, 0.38, 0.48), vec3(0.10, 0.13, 0.19), thick);
  coolCloud *= 0.62 + 0.85 * relief * relief;
  coolCloud += vec3(0.11, 0.15, 0.21) * pow(1.0 - thick, 2.5);

  float nearSun = pow(ts, 4.0) * exp(-max(h - edge, 0.0) * 4.2) * 0.56 + pow(s, 6.0) * 0.52;
  vec3 warmCloud = (uHor * vec3(0.96, 0.72, 0.50)) * nearSun * (0.10 + 1.25 * relief * relief * relief);
  float rim = cov * (1.0 - cov) * 4.0;
  warmCloud += uSunCol * rim * pow(ts, 3.0) * (0.30 + 0.72 * pow(s, 5.0)) * (1.0 - 0.8 * hole);

  vec3 cloudC = coolCloud + warmCloud;
  // Aerial perspective: far cloud melts into horizon mist
  cloudC = mix(cloudC, hc * 0.62 + cloudC * 0.38, exp(-h * 10.5));
  col = mix(col, cloudC, cov * 0.95);

  // ---- 4. Layer C: Low scud / marine mist ribbons near horizon ----
  vec2 cuvLow = d.xz / (h + 0.065) * vec2(0.42, 1.55) + vec2(-0.018, 0.006) * uTime;
  float scudN = fbm3(cuvLow + 31.0);
  float scud = smoothstep(0.52, 0.82, scudN) * (1.0 - deck * 0.7)
    * smoothstep(0.015, 0.085, h) * (1.0 - smoothstep(0.14, 0.28, h)) * 0.58 * (1.0 - 0.75 * hole);
  vec3 scudC = mix(vec3(0.24, 0.30, 0.38), uHor * 1.35, pow(ts, 2.6)) + uSunCol * pow(s, 20.0) * 1.6;
  col = mix(col, scudC, scud);

  // ---- 5. Sun disk (omitted from PMREM env capture to prevent specular fireflies) ----
  float veil = (1.0 - cov * 0.9) * (1.0 - scud * 0.6);
  float disk = smoothstep(0.99986, 0.99994, mu);
  col += vec3(1.0, 0.92, 0.76) * disk * 80.0 * veil * (1.0 - uEnv);

  // Horizon mist skirt: smooth blend into uFogCol at d.y -> 0 so sea horizon has no hard edge
  float mistBand = exp(-abs(d.y) * 26.0);
  col = mix(col, mix(uFogCol, hc, 0.45 + 0.45 * pow(ts, 3.0)), mistBand * 0.45);

  // Below horizon: sea/deck bounce for PMREM lower hemisphere
  if (d.y < 0.0) {
    float t = clamp(-d.y * 4.5, 0.0, 1.0);
    vec3 low = mix(uFogCol * 0.55, vec3(0.12, 0.14, 0.16), uEnv);
    low += uHor * 0.35 * pow(ts, 5.0) * exp(d.y * 6.0);
    col = mix(hc + uSunCol * pow(s, 40.0) * 1.1, low, smoothstep(0.0, 1.0, t));
  }

  // Clamp HDR peaks during PMREM capture so IBL reflections stay clean
  col = mix(col, min(col, vec3(5.5)), uEnv);
  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
__TAIL__}
`;

const FRAG_TAIL = /* glsl */ `
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
    uSunDir: { value: SUN_DIR.clone() },
    uZen: { value: new THREE.Color(...PALETTE.skyZen) },
    uHor: { value: new THREE.Color(...PALETTE.skyHor) },
    uHorAway: { value: new THREE.Color(...PALETTE.skyHorAway) },
    uSunCol: { value: SUN_COLOR.clone() },
    uFogCol: { value: new THREE.Color(PALETTE.fog) },
  };
}

function makeSkyMaterial(env: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: env ? 'saltline-sky-env' : 'saltline-sky',
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: !env,
    fog: false,
    toneMapped: false,
    uniforms: skyUniforms(env),
    vertexShader: env ? SKY_VERT_ENV : SKY_VERT_DISPLAY,
    fragmentShader: SKY_FRAG.replace('__TAIL__', env ? '' : FRAG_TAIL),
  });
}

/** Procedural soft radial sun halo texture (256² canvas, zero external files). */
function makeSunHaloTexture(): THREE.CanvasTexture {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const half = size / 2;
  const g = ctx.createRadialGradient(half, half, 0, half, half, half);
  g.addColorStop(0.0, 'rgba(255,250,238,1.0)');
  g.addColorStop(0.14, 'rgba(255,236,204,0.78)');
  g.addColorStop(0.38, 'rgba(255,212,158,0.34)');
  g.addColorStop(0.72, 'rgba(255,190,126,0.09)');
  g.addColorStop(1.0, 'rgba(255,175,110,0.0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export interface SkyDome {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  uniforms: SkyUniforms;
  sunHalo: THREE.Sprite;
  /** Keep the additive sun halo positioned along SUN_DIR at ~120px screen radius. */
  updateHalo(camPos: THREE.Vector3, fovDeg?: number): void;
}

const HALO_DIST = 215; // inside camera far=300, behind distant harbour cranes
const HALO_RADIUS_PX = 120;

export function createSkyDome(): SkyDome {
  const material = makeSkyMaterial(false);
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(240, 28, 16), material);
  mesh.name = 'sky';
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = false;

  // Additive sun halo sprite: radius ~120px on screen, opacity 0.10, fog-free
  const haloMat = new THREE.SpriteMaterial({
    map: makeSunHaloTexture(),
    color: PALETTE.sun,
    blending: THREE.AdditiveBlending,
    transparent: true,
    opacity: 0.10,
    depthWrite: false,
    depthTest: true,
    fog: false,
  });
  const sunHalo = new THREE.Sprite(haloMat);
  sunHalo.name = 'sun-halo';
  sunHalo.frustumCulled = false;
  sunHalo.renderOrder = -900;

  const updateHalo = (camPos: THREE.Vector3, fovDeg = 75): void => {
    sunHalo.position.copy(camPos).addScaledVector(SUN_DIR, HALO_DIST);
    const viewH = Math.max(window.innerHeight || 720, 360);
    const worldH = 2 * HALO_DIST * Math.tan(THREE.MathUtils.degToRad(fovDeg * 0.5));
    const diameterWorld = ((HALO_RADIUS_PX * 2) / viewH) * worldH;
    sunHalo.scale.set(diameterWorld, diameterWorld, 1);
  };

  return { mesh, material, uniforms: material.uniforms as SkyUniforms, sunHalo, updateHalo };
}

/**
 * One-shot PMREM of the sky dome (uEnv=1, standard sphere projection) so every
 * MeshStandardMaterial receives crisp, accurate sky/horizon IBL reflections.
 */
export function captureSkyEnv(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const envGeo = new THREE.SphereGeometry(40, 28, 16);
  const envMat = makeSkyMaterial(true);
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(envGeo, envMat));
  const rt = pmrem.fromScene(envScene, 0.01, 0.1, 200);
  envGeo.dispose();
  envMat.dispose();
  pmrem.dispose();
  return rt.texture;
}
