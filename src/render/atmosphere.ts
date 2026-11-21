// Atmosphere: sky dome + additive sun halo + PMREM IBL environment + FogExp2.
// Hemisphere and directional fills live in lighting.ts so the 3-layer rig stays
// in one place.

import * as THREE from 'three';
import { PALETTE } from './palette';
import { createSkyDome, captureSkyEnv } from './sky';

export interface Atmosphere {
  sky: THREE.Mesh;
  sunHalo: THREE.Sprite;
  /** Drives cloud drift and keeps the sun halo aligned with the camera. */
  update(camPos: THREE.Vector3, fovDeg?: number): void;
}

export function applyAtmosphere(scene: THREE.Scene, renderer: THREE.WebGLRenderer): Atmosphere {
  // Exponential fog matched to the sky horizon colour (density 0.0095 in [0.008, 0.012])
  scene.fog = new THREE.FogExp2(PALETTE.fog, 0.0095);

  const dome = createSkyDome();
  scene.add(dome.mesh);
  scene.add(dome.sunHalo);

  // Layer 1: Environment IBL from PMREM of the procedural sky dome.
  // High-metalness surfaces and wet deck clearly mirror sky & warm horizon.
  scene.environment = captureSkyEnv(renderer);
  scene.environmentIntensity = 1.6;

  return {
    sky: dome.mesh,
    sunHalo: dome.sunHalo,
    update(camPos: THREE.Vector3, fovDeg?: number) {
      dome.uniforms.uTime.value = performance.now() * 0.001;
      dome.updateHalo(camPos, fovDeg);
    },
  };
}
