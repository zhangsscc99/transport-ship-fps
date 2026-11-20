// Scene lighting: one shadow-casting directional sun (2048, PCFSoft, frustum
// tightened to the ship) + two local point lights — red bow beacon with a slow
// blink, warm work lamp over the SE tower platform.
// configureRenderer() owns shadow map type + filmic tone mapping.

import * as THREE from 'three';
import { PALETTE } from './palette';

// Dusk sun like Saltline's: ~10° above the horizon, azimuth ~20° off +x
// toward +z, so it rakes along the deck's long axis and sits inside the
// cloud deck's burning gap (see sky.ts).
const SUN_POS = new THREE.Vector3(46.3, 8.7, 16.75);
/** Direction toward the sun in world space — shared by the sky dome and the
 * sea glitter so the visuals and the light stay aligned. */
export const SUN_DIR = SUN_POS.clone().normalize();
/** Sun colour (linear) — shared by the directional light, sky aureole and sea
 * glint. Clone it; don't mutate the shared constant. */
export const SUN_COLOR = new THREE.Color(PALETTE.sun);

export interface Lights {
  sun: THREE.DirectionalLight;
  bow: THREE.PointLight;
  tower: THREE.PointLight;
  /** Camera-follow fill — repositioned each frame from main.ts so the
   * viewmodel's camera-facing surfaces and backlit props never hit luma 0. */
  camFill: THREE.DirectionalLight;
  /** t = elapsed seconds; drives the beacon's slow blink. */
  update(t: number): void;
}

export function configureRenderer(renderer: THREE.WebGLRenderer): void {
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.48;
}

export function addLights(scene: THREE.Scene): Lights {
  // grazing incidence on the deck (~sin 10°) needs more raw intensity
  const sun = new THREE.DirectionalLight(SUN_COLOR.clone(), 3.0);
  sun.position.copy(SUN_POS);
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

  // counter-fill from the opposite azimuth — lifts shadowed faces (guard
  // rails, bollards, pipe walls) out of pure black without flattening the key
  const fill = new THREE.DirectionalLight(PALETTE.fill, 0.85);
  fill.position.set(-24, 18, -16);
  scene.add(fill);
  scene.add(fill.target);

  // camera-follow fill: main.ts re-aims it every frame so it always shines
  // down the view axis — the face of the gun and any prop right in front of
  // the lens keep a readable mid-tone even in full backlight
  const camFill = new THREE.DirectionalLight(PALETTE.fill, 0.6);
  scene.add(camFill);
  scene.add(camFill.target);

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
    camFill,
    update(t) {
      // slow beacon: eases up, snaps back — reads as a rotating lamp
      const p = 0.5 + 0.5 * Math.sin(t * 1.5);
      bow.intensity = bowBase * (0.15 + 0.85 * p * p);
    },
  };
}
