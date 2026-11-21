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
  | 'skid'
  | 'checker'
  | 'steelFrame'
  | 'kickplate'
  | 'elecBox';

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
        normalScale: new THREE.Vector2(0.55, 0.55),
        roughness: 1.0,
        metalness: 0.36,
        envMapIntensity: 1.15,
      });
      // Per-instance tiling + vertical rust gradient + distinct top-face grime:
      // aSize = world dims so ribs repeat cleanly per metre, aUvOffset decorrelates
      // wear/rust patterns between boxes, and vIsTop flags upward-facing roofs for
      // accumulated maritime grime & water-stain patina.
      m.onBeforeCompile = (shader) => {
        shader.uniforms.uWear = { value: getTexture('containerWear') };
        shader.vertexShader = shader.vertexShader
          .replace(
            '#include <common>',
            '#include <common>\nattribute vec3 aSize;\nattribute vec2 aUvOffset;\nvarying vec2 vWearUv;\nvarying float vFaceV;\nvarying float vIsTop;',
          )
          .replace(
            '#include <uv_vertex>',
            `#include <uv_vertex>
{
	vec2 cFace = abs( normal.x ) > 0.5 ? aSize.zy : ( abs( normal.z ) > 0.5 ? aSize.xy : aSize.xz );
	vec2 cUv = vec2( uv.x * ( cFace.x / 2.4 ) + aUvOffset.x, uv.y );
	if ( abs( normal.y ) > 0.5 ) {
		cUv = uv * ( cFace / 2.4 ) + aUvOffset;
	}
	cUv.x += dot( normal, vec3( 0.31, 0.71, 0.53 ) );
	vMapUv = cUv;
	vRoughnessMapUv = cUv;
	vNormalMapUv = cUv;
	vWearUv = uv * ( cFace / 5.5 ) + aUvOffset * vec2( 13.73, 9.17 );
	vFaceV = uv.y; // 0 bottom → 1 top of vertical face
	vIsTop = step( 0.5, normal.y );
}`,
          );
        shader.fragmentShader = shader.fragmentShader
          .replace(
            '#include <common>',
            '#include <common>\nuniform sampler2D uWear;\nvarying vec2 vWearUv;\nvarying float vFaceV;\nvarying float vIsTop;',
          )
          .replace(
            '#include <map_fragment>',
            `#include <map_fragment>
{
	float wear = smoothstep( 0.28, 0.72, texture2D( uWear, vWearUv ).r );
	diffuseColor.rgb *= mix( vec3( 1.0 ), vec3( 0.78, 0.73, 0.68 ), wear * 0.75 );
}`,
          )
          .replace(
            '#include <color_fragment>',
            `#include <color_fragment>
// Vertical rust gradient + mottled oxide scabs (applied AFTER per-instance
// paint tint so rust reads warm oxide across red, blue, olive & ochre boxes).
float rustG1 = texture2D( uWear, vWearUv ).g;
float rustG2 = texture2D( uWear, vMapUv * 0.9 + vec2( 0.37, 0.61 ) ).g;
float rustNoise = smoothstep( 0.28, 0.72, rustG1 ) * ( 0.65 + 0.35 * smoothstep( 0.25, 0.75, rustG2 ) );
// Strongest oxidation near bottom deck-splash zone & top rain-weep lip
float botGrad = 1.0 - smoothstep( 0.0, 0.34, vFaceV );
float topGrad = smoothstep( 0.74, 0.98, vFaceV );
float gradBias = clamp( 0.28 + botGrad * 0.85 + topGrad * 0.55, 0.0, 1.2 );
float rustMask = clamp( rustNoise * gradBias, 0.0, 1.0 );
float rustRib = abs( fract( ( vMapUv.x * 256.0 - 16.0 ) / 32.0 + 0.5 ) - 0.5 ) * 32.0;
rustMask *= 0.8 + 0.2 * smoothstep( 8.0, 2.5, rustRib );
float rustBlend = rustMask * ( 0.42 + 0.48 * rustMask ) * 0.68;
diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.34, 0.16, 0.07 ), rustBlend );

// Top-face accumulated grime, dust & weathered roof patina
float topDirt = vIsTop * ( 0.45 + 0.50 * smoothstep( 0.20, 0.75, texture2D( uWear, vWearUv * 1.15 ).r ) );
diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.24, 0.23, 0.22 ), topDirt * 0.65 );`,
          )
          .replace(
            '#include <roughnessmap_fragment>',
            `#include <roughnessmap_fragment>
	roughnessFactor = mix( roughnessFactor, 0.94, max( rustMask * 0.85, topDirt ) );`,
          )
          .replace(
            '#include <metalnessmap_fragment>',
            `#include <metalnessmap_fragment>
	metalnessFactor = mix( metalnessFactor, 0.04, max( rustMask * 0.9, topDirt ) );`,
          );
      };
      m.customProgramCacheKey = () => 'container-tiled-v2';
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
      // Standing water on wet steel deck: crystal-clear dark-backed rainwater
      // mirroring the sky PMREM via Fresnel + gentle capillary wind ripples
      // (zero milky diffuse wash).
      const ripple = getTexture('puddleNormal');
      ripple.repeat.set(2, 2);
      const m = new THREE.MeshStandardMaterial({
        color: PALETTE.sea[0],
        metalness: 0.35,
        roughness: 0.03,
        envMapIntensity: 2.2,
        alphaMap: getTexture('puddleAlpha'),
        transparent: true,
        opacity: 0.92,
        depthWrite: false,
        side: THREE.FrontSide,
        normalMap: ripple,
        normalScale: new THREE.Vector2(0.09, 0.09),
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
	float depth = smoothstep( 0.30, 0.90, shore );
	float fres = pow( 1.0 - clamp( dot( normal, normalize( vViewPosition ) ), 0.0, 1.0 ), 3.0 );
	// Dark wet-steel floor beneath clear water; smoothstep shoreline darkens damp rim
	diffuseColor.rgb *= mix( 0.72, 0.38, depth );`,
          )
          .replace(
            '#include <opaque_fragment>',
            `{
	vec3 pV = normalize( vViewPosition );
	vec3 pSun = normalize( ( viewMatrix * vec4( uSunDirW, 0.0 ) ).xyz );
	vec3 pR = reflect( -pV, normal );
	float pGlint = pow( clamp( dot( pR, pSun ), 0.0, 1.0 ), 260.0 ) * 2.2;
	float pBroad = pow( clamp( dot( pR, pSun ), 0.0, 1.0 ), 28.0 ) * 0.16;
	float pRefl = smoothstep( 0.18, 0.62, shore );
	outgoingLight += mix( uSkyTint, uSunCol, 0.75 ) * ( pBroad + pGlint ) * pRefl;
	outgoingLight += mix( vec3( 0.14, 0.24, 0.36 ), uSkyTint, fres ) * ( fres * 0.28 ) * depth * pRefl;
	}
	#include <opaque_fragment>`,
          );
      };
      m.customProgramCacheKey = () => 'puddle-water-v3';
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
    case 'checker':
      // Industrial diamond checker-plate steel deck & stair treads
      return new THREE.MeshStandardMaterial({
        color: PALETTE.checker,
        map: getTexture('checker'),
        roughnessMap: getTexture('checkerRough'),
        normalMap: getTexture('checkerNormal'),
        normalScale: new THREE.Vector2(0.85, 0.85),
        roughness: 1.0,
        metalness: 0.68,
        envMapIntensity: 1.45,
      });
    case 'steelFrame':
      // Structural H-beams, I-beams, C-channel stringers & diagonal X-bracing
      return new THREE.MeshStandardMaterial({
        color: PALETTE.steelFrame,
        map: getTexture('steelFrame'),
        normalMap: getTexture('steelFrameNormal'),
        normalScale: new THREE.Vector2(0.55, 0.55),
        roughness: 0.42,
        metalness: 0.72,
        envMapIntensity: 1.35,
      });
    case 'kickplate':
      // Guardrail 100mm toe-board with rust weeping streaks
      return new THREE.MeshStandardMaterial({
        color: PALETTE.kickplate,
        map: getTexture('kickplate'),
        roughness: 0.58,
        metalness: 0.52,
        envMapIntensity: 1.1,
      });
    case 'elecBox':
      // Marine electrical distribution box mounted beneath elevated platforms
      return new THREE.MeshStandardMaterial({
        color: PALETTE.elecBox,
        map: getTexture('elecBox'),
        roughness: 0.46,
        metalness: 0.48,
        envMapIntensity: 1.15,
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
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.repeat.set(0.242, 1);
    tex.offset.set(i * 0.25 + 0.004, 0);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    m = new THREE.MeshStandardMaterial({
      map: tex,
      transparent: true,
      roughness: 0.88,
      metalness: 0.02,
      envMapIntensity: 0.9,
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
