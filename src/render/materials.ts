// MeshStandardMaterial factories fed by textures.ts. One material per kind,
// cached and shared by every InstancedMesh of that kind. ART-SPEC §2/§5.

import * as THREE from 'three';
import { PALETTE } from './palette';
import { getTexture } from './textures';
import { SUN_COLOR, SUN_DIR } from './lighting';

export type MaterialKind =
  | 'deck'
  | 'container'
  | 'tower'
  | 'rail'
  | 'pipe'
  | 'bollard'
  | 'mast'
  | 'paint'
  | 'wood'
  | 'crate'
  | 'crane'
  | 'barrel'
  | 'grate'
  | 'ao'
  | 'aoEdge'
  | 'lamp'
  | 'gunMetal'
  | 'gunPoly'
  | 'gunMag'
  | 'gunEdge'
  | 'glove'
  | 'puddle'
  | 'lampRed'
  | 'window'
  | 'hull'
  | 'hullBand'
  | 'stripe'
  | 'cone'
  | 'rope'
  | 'skid';

const cache = new Map<MaterialKind, THREE.Material>();

// Shared ripple clock for the puddle shader. The same object is handed to
// shader.uniforms.uTime inside onBeforeCompile, so writes made before the
// program compiles are simply the value the first frame already reads.
const waterTime = { value: 0 };

/** Advance the puddle ripple clock (seconds) — called once per frame. */
export function updateWater(tSec: number): void {
  waterTime.value = tSec;
}

function buildDeck(): THREE.MeshStandardMaterial {
  // Wet steel deck: roughnessMap averages ~0.34 (in [0.25, 0.40]),
  // envMapIntensity = 1.25 so the rain-slicked deck reflects the sky dome.
  const m = new THREE.MeshStandardMaterial({
    map: getTexture('deck'),
    roughnessMap: getTexture('deckRough'),
    normalMap: getTexture('deckNormal'),
    normalScale: new THREE.Vector2(0.45, 0.45),
    roughness: 1.0,
    metalness: 0.28,
    envMapIntensity: 1.25,
  });
  // Wet-deck patch: uWet smoothly drops local roughness toward 0.12 and nudges
  // specular response on pooled patches without harsh edges.
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uWet = { value: 0.65 };
    shader.uniforms.uPuddle = { value: getTexture('puddle') };
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform float uWet;\nuniform sampler2D uPuddle;',
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
	float wetDeck = uWet * smoothstep(0.32, 0.78, texture2D(uPuddle, vMapUv).r);
	roughnessFactor = mix(roughnessFactor, 0.12, wetDeck);`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>
	metalnessFactor = mix(metalnessFactor, 0.42, wetDeck);`,
      );
  };
  m.customProgramCacheKey = () => 'wet-deck-v2';
  return m;
}

function build(kind: Exclude<MaterialKind, 'deck'>): THREE.Material {
  switch (kind) {
    case 'container': {
      const m = new THREE.MeshStandardMaterial({
        map: getTexture('container'),
        roughnessMap: getTexture('containerRough'),
        normalMap: getTexture('containerNormal'),
        normalScale: new THREE.Vector2(1, 1),
        roughness: 1,
        metalness: 0.25,
      });
      // Per-instance tiling: aSize = the box's world dims, so the skin repeats
      // every ~2.4 m on each face (a 6 m side gets more rib columns instead of
      // one stretched tile); aUvOffset decorrelates instances, and a
      // normal-keyed phase keeps the six faces of one box from lining up.
      m.onBeforeCompile = (shader) => {
        shader.uniforms.uWear = { value: getTexture('containerWear') };
        shader.vertexShader = shader.vertexShader
          .replace(
            '#include <common>',
            '#include <common>\nattribute vec3 aSize;\nattribute vec2 aUvOffset;\nvarying vec2 vWearUv;\nvarying float vFaceV;',
          )
          .replace(
            '#include <uv_vertex>',
            `#include <uv_vertex>
{
	vec2 cFace = abs( normal.x ) > 0.5 ? aSize.zy : ( abs( normal.z ) > 0.5 ? aSize.xy : aSize.xz );
	vec2 cUv = uv * ( cFace / 2.4 ) + aUvOffset;
	cUv += vec2( dot( normal, vec3( 0.31, 0.71, 0.53 ) ), dot( normal, vec3( 0.17, 0.43, 0.29 ) ) );
	vMapUv = cUv;
	vRoughnessMapUv = cUv;
	vNormalMapUv = cUv;
	// wear mask: ~6 skin tiles per repeat + a big per-instance phase, so the
	// metre-scale grime shapes differ between adjacent boxes
	vWearUv = cUv * ( 1.0 / 6.0 ) + aUvOffset * vec2( 13.73, 9.17 );
	vFaceV = uv.y; // 0 bottom → 1 top of the face, before any tiling offset
}`,
          );
        shader.fragmentShader = shader.fragmentShader
          .replace(
            '#include <common>',
            '#include <common>\nuniform sampler2D uWear;\nvarying vec2 vWearUv;\nvarying float vFaceV;',
          )
          .replace(
            '#include <map_fragment>',
            `#include <map_fragment>
{
	float wear = smoothstep( 0.26, 0.68, texture2D( uWear, vWearUv ).r );
	diffuseColor.rgb *= mix( vec3( 1.0 ), vec3( 0.7, 0.62, 0.56 ), wear ); // damp grime darkens ~0.75
	diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.28, 0.17, 0.1 ), wear * 0.72 ); // rust-wash staining
}`,
          )
          .replace(
            '#include <color_fragment>',
            `#include <color_fragment>
// rust mask (.g of the wear map) applied AFTER the per-instance tint — oxide
// painted into the colour map was being multiplied by instanceColor, so it
// never read warm. Two scales of the same channel keep the scabs mottled,
// and a soft gate biases rust toward the corrugation roots (skin-tex
// troughs at x = 19.5 + 26k).
float rustG2 = texture2D( uWear, vMapUv * 0.83 + vec2( 0.37, 0.61 ) ).g;
float rustMask = smoothstep( 0.30, 0.70, texture2D( uWear, vWearUv ).g );
rustMask *= 0.75 + 0.25 * smoothstep( 0.3, 0.75, rustG2 );
float rustRib = abs( fract( ( vMapUv.x * 256.0 - 19.5 ) / 26.0 + 0.5 ) - 0.5 ) * 26.0;
rustMask *= 0.75 + 0.25 * smoothstep( 7.0, 2.5, rustRib );
// oxide hue kept saturated — a flatter brown washes out warm once blended
// onto green/blue paint, and a brighter tone reads lighter than the paint
// around it instead of as staining. Pitted cores run a shade deeper than
// the stained halo, and rust gathers in the run-off band just under the
// top lip of the face where the weep starts
float rustM = rustMask * ( 0.45 + 0.55 * rustMask ) * 0.88; // strong cores, faint halo
float rustBand = smoothstep( 0.30, 0.62, vFaceV ) * ( 1.0 - smoothstep( 0.82, 0.97, vFaceV ) );
rustM *= 0.55 + 0.45 * rustBand;
diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.30, 0.15, 0.05 ) * 0.95, rustM );`,
          )
          .replace(
            '#include <roughnessmap_fragment>',
            `#include <roughnessmap_fragment>
	roughnessFactor = mix( roughnessFactor, 0.95, rustMask ); // rust is matte`,
          )
          .replace(
            '#include <metalnessmap_fragment>',
            `#include <metalnessmap_fragment>
	metalnessFactor = mix( metalnessFactor, 0.0, rustMask ); // oxide, not steel`,
          );
      };
      m.customProgramCacheKey = () => 'container-tiled';
      return m;
    }
    case 'tower':
      // Weathered poured concrete: roughness 0.90 (within 0.85–0.95)
      return new THREE.MeshStandardMaterial({
        color: PALETTE.tower[0],
        map: getTexture('concrete'),
        roughness: 0.9,
        metalness: 0.02,
        envMapIntensity: 0.85,
      });
    case 'rail':
      // Galvanized steel guard rails: metallic IBL catches sky highlights
      return new THREE.MeshStandardMaterial({
        color: PALETTE.tower[1],
        map: getTexture('metal'),
        roughness: 0.28,
        metalness: 0.84,
        envMapIntensity: 1.45,
      });
    case 'pipe':
      // Industrial steel pipe corridors & pipe bundles
      return new THREE.MeshStandardMaterial({
        color: PALETTE.pipe,
        map: getTexture('metal'),
        roughness: 0.3,
        metalness: 0.82,
        envMapIntensity: 1.4,
      });
    case 'bollard':
      // Heavy cast-steel mooring bollards
      return new THREE.MeshStandardMaterial({
        color: PALETTE.pipe,
        map: getTexture('metal'),
        roughness: 0.28,
        metalness: 0.86,
        envMapIntensity: 1.5,
      });
    case 'mast':
      // On-ship steel masts & stern deck crane: lit metallic PBR (not flat silhouette)
      return new THREE.MeshStandardMaterial({
        color: PALETTE.tower[1],
        map: getTexture('metal'),
        roughness: 0.3,
        metalness: 0.85,
        envMapIntensity: 1.5,
      });
    case 'paint':
      // Scuffed deck warning lines — textured, slight emissive for readability
      return new THREE.MeshStandardMaterial({
        color: PALETTE.deckLine,
        map: getTexture('paint'),
        emissive: PALETTE.deckLine,
        emissiveIntensity: 0.22,
        roughness: 0.52,
        metalness: 0.04,
        envMapIntensity: 0.85,
      });
    case 'wood':
      return new THREE.MeshStandardMaterial({
        color: PALETTE.wood,
        map: getTexture('wood'),
        roughness: 0.86,
        metalness: 0.0,
        envMapIntensity: 0.7,
      });
    case 'crate':
      return new THREE.MeshStandardMaterial({
        color: PALETTE.wood,
        map: getTexture('crate'),
        roughness: 0.84,
        metalness: 0.0,
        envMapIntensity: 0.72,
      });
    case 'crane':
      // Distant harbour cranes & freighters — subtly textured, naturally faded by FogExp2
      return new THREE.MeshStandardMaterial({
        color: PALETTE.crane,
        map: getTexture('craneTex'),
        roughness: 0.82,
        metalness: 0.25,
        envMapIntensity: 0.65,
      });
    case 'barrel':
      // Steel oil drums — rolling-hoop texture, white base tinted per-instance
      return new THREE.MeshStandardMaterial({
        map: getTexture('barrel'),
        roughness: 0.32,
        metalness: 0.8,
        envMapIntensity: 1.4,
      });
    case 'grate':
      return new THREE.MeshStandardMaterial({
        map: getTexture('grate'),
        roughness: 0.34,
        metalness: 0.78,
        envMapIntensity: 1.3,
      });
    case 'ao':
      // Soft contact shadow under grounded colliders
      return new THREE.MeshBasicMaterial({
        map: getTexture('ao'),
        transparent: true,
        depthWrite: false,
      });
    case 'aoEdge':
      // Contact-shadow feather hugging collider bases
      return new THREE.MeshBasicMaterial({
        map: getTexture('aoEdge'),
        transparent: true,
        depthWrite: false,
      });
    case 'lamp':
      // Self-lit warm bulb
      return new THREE.MeshStandardMaterial({
        color: PALETTE.lampWarm,
        map: getTexture('paint'),
        emissive: PALETTE.lampWarm,
        emissiveIntensity: 1.8,
        roughness: 0.25,
        metalness: 0.0,
        envMapIntensity: 0.8,
      });
    case 'gunMetal':
      // Receiver / barrel — high-metal steel catching real PMREM sky reflections
      return new THREE.MeshStandardMaterial({
        color: PALETTE.gun[1],
        map: getTexture('metal'),
        metalness: 0.85,
        roughness: 0.28,
        envMapIntensity: 1.5,
      });
    case 'gunPoly':
      return new THREE.MeshStandardMaterial({
        color: PALETTE.gun[0],
        map: getTexture('metal'),
        metalness: 0.08,
        roughness: 0.72,
        envMapIntensity: 0.9,
      });
    case 'gunMag':
      return new THREE.MeshStandardMaterial({
        color: PALETTE.gunDark,
        map: getTexture('metal'),
        metalness: 0.76,
        roughness: 0.34,
        envMapIntensity: 1.25,
      });
    case 'gunEdge':
      return new THREE.MeshStandardMaterial({
        color: PALETTE.gun[2],
        map: getTexture('metal'),
        emissive: PALETTE.gunHi,
        emissiveIntensity: 0.4,
        metalness: 0.84,
        roughness: 0.26,
        envMapIntensity: 1.5,
      });
    case 'glove':
      return new THREE.MeshStandardMaterial({
        color: PALETTE.glove,
        map: getTexture('metal'),
        metalness: 0.05,
        roughness: 0.86,
        envMapIntensity: 0.75,
      });
    case 'puddle': {
      // Standing water on steel deck: low-roughness sky mirror with organic
      // multi-lobe alpha shoreline & gentle scrolling wind ripples. Relies on
      // the PMREM sky IBL + Fresnel + crisp sun glint rather than a flat blue tint.
      const ripple = getTexture('puddleNormal');
      ripple.repeat.set(2, 2);
      const m = new THREE.MeshStandardMaterial({
        color: PALETTE.sea[0],
        metalness: 0.14,
        roughness: 0.04,
        envMapIntensity: 2.35,
        alphaMap: getTexture('puddleAlpha'),
        transparent: true,
        depthWrite: false,
        side: THREE.FrontSide,
        normalMap: ripple,
        normalScale: new THREE.Vector2(0.12, 0.12),
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      });
      m.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = waterTime;
        shader.uniforms.uSkyTint = { value: new THREE.Color(PALETTE.skyHorizon) };
        shader.uniforms.uSunDirW = { value: SUN_DIR.clone() };
        shader.uniforms.uSunCol = { value: SUN_COLOR.clone() };
        shader.fragmentShader = shader.fragmentShader
          .replace(
            '#include <common>',
            `#include <common>
uniform float uTime;
uniform vec3 uSkyTint;
uniform vec3 uSunDirW;
uniform vec3 uSunCol;`,
          )
          .replace(
            '#include <normal_fragment_maps>',
            `vec3 mapN = texture2D( normalMap, vNormalMapUv + uTime * vec2( 0.014, 0.009 ) ).xyz * 2.0 - 1.0;
	vec3 mapN2 = texture2D( normalMap, vNormalMapUv * 1.67 + uTime * vec2( -0.011, 0.016 ) ).xyz * 2.0 - 1.0;
	mapN = normalize( vec3( mapN.xy + mapN2.xy, mapN.z * mapN2.z ) );
	mapN.xy *= normalScale;
	normal = normalize( tbn * mapN );
	float shore = texture2D( alphaMap, vAlphaMapUv ).g;
	float depth = smoothstep( 0.35, 0.92, shore );
	float fres = pow( 1.0 - clamp( dot( normal, normalize( vViewPosition ) ), 0.0, 1.0 ), 3.5 );
	// Dark wet-steel base underneath; grazing angles mirror sky via PMREM + subtle Fresnel
	diffuseColor.rgb *= mix( 0.9, 0.55, depth );`,
          )
          .replace(
            '#include <opaque_fragment>',
            `{
	vec3 pV = normalize( vViewPosition );
	vec3 pSun = normalize( ( viewMatrix * vec4( uSunDirW, 0.0 ) ).xyz );
	vec3 pR = reflect( -pV, normal );
	float pGlint = pow( clamp( dot( pR, pSun ), 0.0, 1.0 ), 220.0 ) * 2.4;
	float pBroad = pow( clamp( dot( pR, pSun ), 0.0, 1.0 ), 18.0 ) * 0.45;
	float pRefl = smoothstep( 0.15, 0.65, shore );
	outgoingLight += mix( uSkyTint, uSunCol, 0.65 ) * ( pBroad + pGlint ) * pRefl;
	outgoingLight += uSkyTint * ( 0.04 + fres * 0.32 ) * depth * pRefl;
	}
	#include <opaque_fragment>`,
          );
      };
      m.customProgramCacheKey = () => 'puddle-water-v2';
      return m;
    }
    case 'lampRed':
      return new THREE.MeshStandardMaterial({
        color: PALETTE.lampRed,
        map: getTexture('paint'),
        emissive: PALETTE.lampRed,
        emissiveIntensity: 2.0,
        roughness: 0.25,
        metalness: 0.0,
        envMapIntensity: 0.8,
      });
    case 'window': {
      const m = new THREE.MeshStandardMaterial({
        color: PALETTE.lampWarm,
        map: getTexture('paint'),
        emissive: PALETTE.lampWarm,
        emissiveIntensity: 1.5,
        roughness: 0.2,
        metalness: 0.1,
        envMapIntensity: 0.9,
      });
      m.fog = false;
      return m;
    }
    case 'hull':
      // Ship topsides — painted maritime steel catching sky IBL
      return new THREE.MeshStandardMaterial({
        color: PALETTE.hull,
        map: getTexture('metal'),
        roughness: 0.34,
        metalness: 0.78,
        envMapIntensity: 1.35,
      });
    case 'hullBand':
      // Antifouling waterline band
      return new THREE.MeshStandardMaterial({
        color: PALETTE.hullBand,
        map: getTexture('metal'),
        roughness: 0.78,
        metalness: 0.15,
        envMapIntensity: 0.85,
      });
    case 'stripe':
      return new THREE.MeshStandardMaterial({
        map: getTexture('stripe'),
        roughness: 0.78,
        metalness: 0.05,
        envMapIntensity: 0.85,
      });
    case 'cone':
      return new THREE.MeshStandardMaterial({
        color: PALETTE.cone,
        map: getTexture('coneTex'),
        roughness: 0.45,
        metalness: 0.04,
        envMapIntensity: 1.0,
      });
    case 'rope':
      return new THREE.MeshStandardMaterial({
        color: PALETTE.rope,
        map: getTexture('rope'),
        roughness: 0.92,
        metalness: 0.0,
        envMapIntensity: 0.65,
      });
    case 'skid':
      return new THREE.MeshBasicMaterial({
        map: getTexture('skid'),
        transparent: true,
        depthWrite: false,
      });
  }
}

/** Container stencil decals — one material per atlas cell (4 cells across x).
 * Texture clones share the canvas; offset/repeat crop to the cell. */
const stencilMats: THREE.MeshStandardMaterial[] = [];
export function getStencilMaterial(cell: number): THREE.MeshStandardMaterial {
  const i = ((cell % 4) + 4) % 4;
  let m = stencilMats[i];
  if (!m) {
    const tex = getTexture('stencil').clone();
    tex.repeat.set(0.25, 1);
    tex.offset.set(i * 0.25, 0);
    tex.needsUpdate = true;
    m = new THREE.MeshStandardMaterial({
      map: tex,
      transparent: true,
      roughness: 0.9,
      metalness: 0,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    m.name = `mat-stencil-${i}`;
    stencilMats[i] = m;
  }
  return m;
}

export function getMaterial(kind: MaterialKind): THREE.Material {
  let m = cache.get(kind);
  if (m) return m;
  m = kind === 'deck' ? buildDeck() : build(kind);
  m.name = `mat-${kind}`;
  cache.set(kind, m);
  return m;
}
