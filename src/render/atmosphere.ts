// Sky dome + exponential fog + hemisphere fill — the "air" of the scene.
// The dome follows the camera on XZ so the horizon band never parallaxes.

import * as THREE from 'three';
import { PALETTE } from './palette';

export interface Atmosphere {
  sky: THREE.Mesh;
  hemi: THREE.HemisphereLight;
  /** Keeps the dome centred under the camera. */
  update(camPos: THREE.Vector3): void;
}

// Why ShaderMaterial: the dome needs a *world-direction* gradient
// (zenith → horizon blend per fragment). MeshBasicMaterial has no
// per-pixel direction input and MeshStandardMaterial would be lit/fogged;
// a generated equirect texture would cost a canvas + sampling for what is
// a two-stop lerp. Cost on mobile: 1 draw call, trivially cheap fragment.
const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SKY_FRAG = /* glsl */ `
varying vec3 vDir;
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uBelow;
void main() {
  float h = normalize(vDir).y;
  vec3 c = h >= 0.0
    ? mix(uHorizon, uTop, smoothstep(0.02, 0.5, h))
    : mix(uHorizon, uBelow, smoothstep(0.0, 0.22, -h));
  gl_FragColor = vec4(c, 1.0);
}
`;

export function applyAtmosphere(scene: THREE.Scene): Atmosphere {
  scene.fog = new THREE.FogExp2(PALETTE.fog, 0.012);

  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(240, 24, 12),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uTop: { value: new THREE.Color(PALETTE.sky[0]) },
        uHorizon: { value: new THREE.Color(PALETTE.skyHorizon) },
        uBelow: { value: new THREE.Color(PALETTE.sea[0]) },
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
    }),
  );
  sky.name = 'sky';
  sky.frustumCulled = false; // dome must render even when the sphere origin is off-screen
  scene.add(sky);

  const hemi = new THREE.HemisphereLight(PALETTE.sky[1], PALETTE.sea[0], 0.6);
  scene.add(hemi);

  return {
    sky,
    hemi,
    update(camPos) {
      sky.position.set(camPos.x, 0, camPos.z);
    },
  };
}
