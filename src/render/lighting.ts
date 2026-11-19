// Scene lighting: one shadow-casting directional sun + hemisphere fill.
// ART-SPEC §5: only the main light casts, shadow map 1024.

import * as THREE from 'three';
import { PALETTE } from './palette';

export function addLights(scene: THREE.Scene): { sun: THREE.DirectionalLight; hemi: THREE.HemisphereLight } {
  const sun = new THREE.DirectionalLight(PALETTE.uiText, 2.6);
  sun.position.set(24, 38, 18);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  const cam = sun.shadow.camera;
  cam.left = -45;
  cam.right = 45;
  cam.top = 35;
  cam.bottom = -35;
  cam.near = 1;
  cam.far = 120;
  sun.shadow.bias = -0.0015;
  scene.add(sun);
  scene.add(sun.target);

  const hemi = new THREE.HemisphereLight(PALETTE.sky[1], PALETTE.sea[0], 0.9);
  scene.add(hemi);

  return { sun, hemi };
}
