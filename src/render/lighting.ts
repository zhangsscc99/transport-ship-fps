// Three-layer Saltline-inspired lighting rig:
//   1. Environment layer (PMREM sky IBL) — wired in atmosphere.ts
//   2. Sun layer — low-angle warm-white directional light (~15.5° elevation),
//      2048² PCFSoft shadow map tightly following a 40m box around the player
//      with texel-grid snapping to prevent shadow shimmer.
//   3. Fill layer — sky/ground HemisphereLight + cool counter-directional fill
//      so shadowed faces keep a rich cool mid-tone without flattening contrast.
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
  bow: THREE.PointLight;
  tower: THREE.PointLight;
  /** t = elapsed seconds; focusPos = player/camera world pos for 40m shadow follow. */
  update(t: number, focusPos?: THREE.Vector3): void;
}

export function configureRenderer(renderer: THREE.WebGLRenderer): void {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.14;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function addLights(scene: THREE.Scene): Lights {
  // --- Layer 2: Sun key light (warm-white #ffe6c4, intensity 2.45, 15.5° elev) ---
  const sun = new THREE.DirectionalLight(SUN_COLOR.clone(), 2.45);
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

  // --- Layer 3a: Sky/ground hemisphere fill (sky #6f8db3 / ground #2a2622, 0.35) ---
  const hemi = new THREE.HemisphereLight(PALETTE.sky[1], PALETTE.skyGround, 0.35);
  hemi.name = 'sky-hemi';
  scene.add(hemi);

  // --- Layer 3b: Cool counter-directional fill (#5b7fb3, 0.25) ---
  // Lifts opposite shadowed faces into crisp maritime blue without bleaching contrast.
  const fill = new THREE.DirectionalLight(PALETTE.fill, 0.25);
  fill.name = 'cool-fill';
  fill.position.set(-SUN_DIR.x * 40, 22, -SUN_DIR.z * 40);
  scene.add(fill);
  scene.add(fill.target);

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
