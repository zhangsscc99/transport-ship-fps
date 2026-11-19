// Scene lighting: one shadow-casting directional sun (2048, PCFSoft, frustum
// tightened to the ship) + two local point lights — red bow beacon with a slow
// blink, warm work lamp over the SE tower platform.
// configureRenderer() owns shadow map type + filmic tone mapping.

import * as THREE from 'three';
import { PALETTE } from './palette';

export interface Lights {
  sun: THREE.DirectionalLight;
  bow: THREE.PointLight;
  tower: THREE.PointLight;
  /** t = elapsed seconds; drives the beacon's slow blink. */
  update(t: number): void;
}

export function configureRenderer(renderer: THREE.WebGLRenderer): void {
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.42;
}

export function addLights(scene: THREE.Scene): Lights {
  const sun = new THREE.DirectionalLight(PALETTE.sun, 1.5);
  sun.position.set(24, 38, 18);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const cam = sun.shadow.camera;
  cam.left = -45;
  cam.right = 45;
  cam.top = 30;
  cam.bottom = -30;
  cam.near = 1;
  cam.far = 120;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.02;
  scene.add(sun);
  scene.add(sun.target);

  // weak counter-fill from the opposite azimuth — lifts the shadowed faces
  // out of pure black without flattening the sun's key
  const fill = new THREE.DirectionalLight(PALETTE.fill, 0.4);
  fill.position.set(-24, 18, -16);
  scene.add(fill);
  scene.add(fill.target);

  // bow warning beacon over the +x tip of the hull
  const bow = new THREE.PointLight(PALETTE.lampRed, 24, 30, 2);
  bow.position.set(33.5, 5.4, 0);
  scene.add(bow);

  // warm work lamp above the SE tower platform
  const tower = new THREE.PointLight(PALETTE.lampWarm, 45, 24, 2);
  tower.position.set(26, 5.6, -14);
  scene.add(tower);

  const bowBase = bow.intensity;
  return {
    sun,
    bow,
    tower,
    update(t) {
      // slow beacon: eases up, snaps back — reads as a rotating lamp
      const p = 0.5 + 0.5 * Math.sin(t * 1.5);
      bow.intensity = bowBase * (0.15 + 0.85 * p * p);
    },
  };
}
