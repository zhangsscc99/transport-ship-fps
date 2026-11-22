// Three-layer Saltline-calibrated lighting rig:
//   1. Environment layer (PMREM sky IBL) — captured in atmosphere.ts, intensity
//      lifted toward Saltline's outdoor IBL (2.0) so metals & wet deck gleam.
//   2. Sun layer — low-angle warm-white directional light (~15.5° elevation,
//      direction preserved), 2048² PCFSoft shadow map tightly following a 40m box
//      around the player with texel-grid snapping to prevent shadow shimmer.
//   3. Fill layer — bright maritime HemisphereLight + counter-directional cool
//      fill + soft sea-bounce cross-fill (both castShadow=false) to lift backlit
//      surfaces while preserving crisp sun/shadow contrast.
// Plus local ship beacons (blinking bow beacon, warm tower work lamp).

import * as THREE from 'three';
import { PALETTE } from './palette';

// Low-angle maritime sun: ~15.5° elevation (within 12–18°), azimuth ~34° right
// of -Z so it sits in the upper-right vista sky, casts long diagonal raking
// shadows across the deck, and reflects directly off wet deck & puddles.
export const SUN_DIR = new THREE.Vector3(0.54, 0.267, -0.80).normalize();
/** Sun colour (linear) — shared by directional light, sky aureole, halo & sea glint. */
export const SUN_COLOR = new THREE.Color(PALETTE.sun);

const SHADOW_RANGE = 40; // 40m coverage box centered around the player
const SHADOW_HALF = SHADOW_RANGE * 0.5;
const SHADOW_MAP_SIZE = 2048;
const SUN_DIST = 55;

export interface Lights {
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  fill: THREE.DirectionalLight;
  backFill: THREE.DirectionalLight;
  bow: THREE.PointLight;
  tower: THREE.PointLight;
  /** t = elapsed seconds; focusPos = player/camera world pos for 40m shadow follow. */
  update(t: number, focusPos?: THREE.Vector3): void;
}

export function configureRenderer(renderer: THREE.WebGLRenderer): void {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.45;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function addLights(scene: THREE.Scene): Lights {
  // --- Layer 1 tuning: Match Saltline's strong outdoor PMREM IBL (Jy=2.0) ---
  // Keeps metallic gun/rail/wet-deck reflections crisp instead of greying out.
  if (scene.environment) {
    scene.environmentIntensity = 1.9;
  }

  // --- Layer 2: Sun key light (warm daylight #ffecd2, intensity 4.8, 15.5° elev) ---
  // Direction & elevation strictly preserved so cast shadow angles stay identical.
  const sunTint = SUN_COLOR.clone().lerp(new THREE.Color(0xfff2de), 0.35);
  const sun = new THREE.DirectionalLight(sunTint, 4.8);
  sun.name = 'sun-key';
  sun.position.copy(SUN_DIR).multiplyScalar(SUN_DIST);
  sun.castShadow = true;
  sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
  const cam = sun.shadow.camera;
  cam.left = -SHADOW_HALF;
  cam.right = SHADOW_HALF;
  cam.top = SHADOW_HALF;
  cam.bottom = -SHADOW_HALF;
  cam.near = 1;
  cam.far = 115;
  cam.updateProjectionMatrix();
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  scene.add(sun);
  scene.add(sun.target);

  // --- Layer 3a: Sky/ground hemisphere fill (sky #c4dcf5 / ground #5e5850, 0.92) ---
  // Bright pale blue-white zenith with lifted warm-neutral deck bounce.
  const hemiSky = new THREE.Color(PALETTE.sky[1]).lerp(new THREE.Color(0xe6f2ff), 0.58);
  const hemiGround = new THREE.Color(PALETTE.skyGround).lerp(new THREE.Color(0x7a736a), 0.55);
  const hemi = new THREE.HemisphereLight(hemiSky, hemiGround, 0.92);
  hemi.name = 'sky-hemi';
  scene.add(hemi);

  // --- Layer 3b: Cool counter-directional fill (#90b8e6, 0.90, castShadow=false) ---
  // Lifts opposite shadowed faces into legible maritime blue without flattening shadows.
  const fillColor = new THREE.Color(PALETTE.fill).lerp(new THREE.Color(0xc8e0ff), 0.45);
  const fill = new THREE.DirectionalLight(fillColor, 0.9);
  fill.name = 'cool-fill';
  fill.castShadow = false;
  fill.position.set(-SUN_DIR.x * 40, 22, -SUN_DIR.z * 40);
  scene.add(fill);
  scene.add(fill.target);

  // --- Layer 3c: Soft sea-bounce cross-fill (#c2d6ea, 0.55, castShadow=false) ---
  // Single extra non-shadow light lifting backlit vertical walls & weapon bevels.
  const backFillColor = new THREE.Color(PALETTE.skyHorizon).lerp(new THREE.Color(0xe8f2fc), 0.52);
  const backFill = new THREE.DirectionalLight(backFillColor, 0.55);
  backFill.name = 'sea-bounce-fill';
  backFill.castShadow = false;
  backFill.position.set(28, 14, 28);
  scene.add(backFill);
  scene.add(backFill.target);

  // --- Local ship lights ---
  const bow = new THREE.PointLight(PALETTE.lampRed, 22, 28, 2);
  bow.position.set(33.5, 5.4, 0);
  scene.add(bow);

  const tower = new THREE.PointLight(PALETTE.lampWarm, 18, 22, 2);
  tower.position.set(26, 5.4, -14);
  scene.add(tower);

  // Texel-grid snapping helpers (no per-frame alloc)
  const texel = SHADOW_RANGE / SHADOW_MAP_SIZE;
  const lightRight = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), SUN_DIR).normalize();
  const lightUp = new THREE.Vector3().crossVectors(SUN_DIR, lightRight).normalize();
  const snappedTarget = new THREE.Vector3();

  const bowBase = bow.intensity;
  return {
    sun,
    hemi,
    fill,
    backFill,
    bow,
    tower,
    update(t, focusPos) {
      // slow rotating bow beacon
      const p = 0.5 + 0.5 * Math.sin(t * 1.5);
      bow.intensity = bowBase * (0.15 + 0.85 * p * p);

      // Keep the 40m shadow frustum centered around the player, snapped to
      // shadow-map texel steps along the sun's basis axes so edges never swim.
      if (focusPos) {
        const rx = Math.round(focusPos.dot(lightRight) / texel) * texel;
        const ry = Math.round(focusPos.dot(lightUp) / texel) * texel;
        const rz = focusPos.dot(SUN_DIR);
        snappedTarget
          .copy(lightRight)
          .multiplyScalar(rx)
          .addScaledVector(lightUp, ry)
          .addScaledVector(SUN_DIR, rz);
        snappedTarget.y = 0; // anchor vertically at deck plane
        sun.target.position.copy(snappedTarget);
        sun.position.copy(snappedTarget).addScaledVector(SUN_DIR, SUN_DIST);
        sun.target.updateMatrixWorld();
      }
    },
  };
}
