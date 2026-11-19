// Sky dome + exponential fog + hemisphere fill — the "air" of the scene.
// The dome is the Saltline sky port (see sky.ts); it is camera-centred in the
// vertex shader so it needs no per-frame follow. A PMREM capture of the same
// dome becomes scene.environment, so metals and wet surfaces pick up sky and
// cloud light instead of falling to black.

import * as THREE from 'three';
import { PALETTE } from './palette';
import { createSkyDome, captureSkyEnv } from './sky';

export interface Atmosphere {
  sky: THREE.Mesh;
  hemi: THREE.HemisphereLight;
  /** camPos kept for the call site's signature — the dome is camera-locked
   * by construction; the call drives cloud-drift time instead. */
  update(camPos: THREE.Vector3): void;
}

export function applyAtmosphere(scene: THREE.Scene, renderer: THREE.WebGLRenderer): Atmosphere {
  scene.fog = new THREE.FogExp2(PALETTE.fog, 0.009);

  const dome = createSkyDome();
  scene.add(dome.mesh);

  // IBL: a one-shot PMREM of the dome gives every standard material a sky to
  // reflect — puddles mirror the horizon, metals stop collapsing to black.
  scene.environment = captureSkyEnv(renderer, dome);

  // Hemisphere fill stays low — the env map now carries most of the ambient.
  const hemi = new THREE.HemisphereLight(PALETTE.sky[1], PALETTE.deck[1], 0.5);
  scene.add(hemi);

  return {
    sky: dome.mesh,
    hemi,
    update() {
      dome.uniforms.uTime.value = performance.now() * 0.001;
    },
  };
}
