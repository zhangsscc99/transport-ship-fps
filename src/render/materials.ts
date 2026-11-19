// MeshStandardMaterial factories fed by textures.ts. One material per kind,
// cached and shared by every InstancedMesh of that kind. ART-SPEC §2/§5.

import * as THREE from 'three';
import { PALETTE } from './palette';
import { getTexture } from './textures';

export type MaterialKind =
  | 'deck'
  | 'container'
  | 'tower'
  | 'rail'
  | 'pipe'
  | 'paint'
  | 'wood'
  | 'crane'
  | 'barrel'
  | 'grate'
  | 'ao'
  | 'lamp'
  | 'gunMetal'
  | 'gunPoly'
  | 'gunEdge'
  | 'glove'
  | 'puddle'
  | 'lampRed'
  | 'window';

const cache = new Map<MaterialKind, THREE.Material>();

function buildDeck(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    map: getTexture('deck'),
    roughnessMap: getTexture('deckRough'),
    roughness: 1,
    metalness: 0.15,
  });
  // Wet-deck patch: uWet scales a puddle mask that locally drops roughness and
  // adds metalness — standing water without a second material or render pass.
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uWet = { value: 0.6 };
    shader.uniforms.uPuddle = { value: getTexture('puddle') };
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform float uWet;\nuniform sampler2D uPuddle;',
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
	float wetDeck = uWet * smoothstep(0.35, 0.75, texture2D(uPuddle, vMapUv).r);
	roughnessFactor = mix(roughnessFactor, 0.1, wetDeck);`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>
	metalnessFactor = mix(metalnessFactor, 0.35, wetDeck);`,
      );
  };
  m.customProgramCacheKey = () => 'wet-deck'; // distinct program from unpatched standards
  return m;
}

function build(kind: Exclude<MaterialKind, 'deck'>): THREE.Material {
  switch (kind) {
    case 'container':
      return new THREE.MeshStandardMaterial({
        map: getTexture('container'),
        roughnessMap: getTexture('containerRough'),
        roughness: 1,
        metalness: 0.25,
      });
    case 'tower':
      return new THREE.MeshStandardMaterial({
        color: PALETTE.tower[0],
        map: getTexture('metal'),
        roughness: 0.85,
        metalness: 0.2,
      });
    case 'rail':
      return new THREE.MeshStandardMaterial({
        color: PALETTE.tower[1],
        map: getTexture('metal'),
        roughness: 0.8,
        metalness: 0.3,
      });
    case 'pipe':
      return new THREE.MeshStandardMaterial({
        color: PALETTE.pipe,
        map: getTexture('metal'),
        roughness: 0.9,
        metalness: 0.2,
      });
    case 'paint':
      // deck markings — slight emissive so the warning lines stay readable in gloom
      return new THREE.MeshStandardMaterial({
        color: PALETTE.deckLine,
        emissive: PALETTE.deckLine,
        emissiveIntensity: 0.35,
        roughness: 0.6,
        metalness: 0,
      });
    case 'wood':
      return new THREE.MeshStandardMaterial({
        color: PALETTE.wood,
        map: getTexture('metal'),
        roughness: 0.95,
        metalness: 0,
      });
    case 'crane':
      // distant silhouette — unlit on purpose, fog still fades it into the sky
      return new THREE.MeshBasicMaterial({ color: PALETTE.crane });
    case 'barrel':
      // oil drums — white base so per-instance rust/paint tints stay true
      return new THREE.MeshStandardMaterial({
        map: getTexture('metal'),
        roughness: 0.55,
        metalness: 0.45,
      });
    case 'grate':
      return new THREE.MeshStandardMaterial({
        map: getTexture('grate'),
        roughness: 0.9,
        metalness: 0.25,
      });
    case 'ao':
      // fake contact shadow — unlit alpha blob, never writes depth
      return new THREE.MeshBasicMaterial({
        map: getTexture('ao'),
        transparent: true,
        depthWrite: false,
      });
    case 'lamp':
      // work-light bulb — self-lit dot at the lamp head
      return new THREE.MeshBasicMaterial({ color: PALETTE.lampWarm });
    case 'gunMetal':
      // receiver / barrel — mid-metal that catches the sky env so the outline
      // separates from dark cover without glowing
      return new THREE.MeshStandardMaterial({
        color: PALETTE.gun[1],
        map: getTexture('metal'),
        metalness: 0.8,
        roughness: 0.35,
        envMapIntensity: 1.2,
      });
    case 'gunPoly':
      return new THREE.MeshStandardMaterial({
        color: PALETTE.gun[0],
        map: getTexture('metal'),
        metalness: 0.05,
        roughness: 0.7,
      });
    case 'gunEdge':
      // highlight band — emissive strip keeps the silhouette readable in gloom
      return new THREE.MeshStandardMaterial({
        color: PALETTE.gun[2],
        emissive: PALETTE.gunHi,
        emissiveIntensity: 0.55,
        metalness: 0.6,
        roughness: 0.4,
      });
    case 'glove':
      // hands/forearms — a step brighter than the receiver so the two read apart
      return new THREE.MeshStandardMaterial({
        color: PALETTE.glove,
        map: getTexture('metal'),
        metalness: 0.05,
        roughness: 0.9,
      });
    case 'puddle':
      // standing water film — near-mirror that steals the sky from the env map
      return new THREE.MeshStandardMaterial({
        color: PALETTE.skyHorizon,
        metalness: 0.9,
        roughness: 0.05,
        envMapIntensity: 1.4,
      });
    case 'lampRed':
      // warning-beacon bulb — self-lit dot
      return new THREE.MeshBasicMaterial({ color: PALETTE.lampRed });
    case 'window': {
      // lit cabin window / hatch — stays crisp through the mist
      const m = new THREE.MeshBasicMaterial({ color: PALETTE.lampWarm });
      m.fog = false;
      return m;
    }
  }
}

export function getMaterial(kind: MaterialKind): THREE.Material {
  let m = cache.get(kind);
  if (m) return m;
  m = kind === 'deck' ? buildDeck() : build(kind);
  m.name = `mat-${kind}`;
  cache.set(kind, m);
  return m;
}
