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
  | 'paint'
  | 'wood'
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
  const m = new THREE.MeshStandardMaterial({
    map: getTexture('deck'),
    roughnessMap: getTexture('deckRough'),
    normalMap: getTexture('deckNormal'),
    normalScale: new THREE.Vector2(0.7, 0.7),
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
    case 'aoEdge':
      // crisp contact-shadow band at a prop's base — fades outward, no depth
      return new THREE.MeshBasicMaterial({
        map: getTexture('aoEdge'),
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
        metalness: 0.85,
        roughness: 0.3,
        envMapIntensity: 1.2,
      });
    case 'gunPoly':
      return new THREE.MeshStandardMaterial({
        color: PALETTE.gun[0],
        map: getTexture('metal'),
        metalness: 0.05,
        roughness: 0.75,
      });
    case 'gunMag':
      // magazine + small dark fittings — darker, near-matte
      return new THREE.MeshStandardMaterial({
        color: PALETTE.gunDark,
        map: getTexture('metal'),
        metalness: 0.5,
        roughness: 0.62,
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
    case 'puddle': {
      // standing water — a dielectric film, NOT a metal: metalness .85 was
      // what collapsed it to an oil stain at nadir view. Now it mirrors the
      // bright PMREM dusk sky (envMapIntensity ≥2), carries a faint cool
      // Blinn-Phong sun-glint through the perturbed ripple normals (F212c:
      // sun term ×0.45 + skylight-weighted tint killed the lava glare, and
      // the shore-band rim light is gone — no decal outline), darkens ~12%
      // toward its centre on a uv-radius gradient, and reflects at 0.55 in
      // the thin film just inside the feathered alpha edge so the junction
      // reads damp-dark — all on the scrolled dual-sample ripples from F212.
      const ripple = getTexture('puddleNormal');
      ripple.repeat.set(3, 3); // F212c: finer ripples — no colour-block patches
      const m = new THREE.MeshStandardMaterial({
        color: PALETTE.sea[1],
        metalness: 0.1,
        roughness: 0.08,
        envMapIntensity: 2.6,
        alphaMap: getTexture('puddleAlpha'),
        transparent: true,
        depthWrite: false,
        side: THREE.FrontSide,
        normalMap: ripple,
        normalScale: new THREE.Vector2(0.3, 0.3),
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
            `vec3 mapN = texture2D( normalMap, vNormalMapUv + uTime * vec2( 0.021, 0.013 ) ).xyz * 2.0 - 1.0;
	vec3 mapN2 = texture2D( normalMap, vNormalMapUv * 1.83 + uTime * vec2( -0.016, 0.024 ) ).xyz * 2.0 - 1.0;
	mapN = normalize( vec3( mapN.xy + mapN2.xy, mapN.z * mapN2.z ) );
	mapN.xy *= normalScale;
	normal = normalize( tbn * mapN );
	float shore = texture2D( alphaMap, vAlphaMapUv ).g; // 1 open water → 0 feathered rim
	float depth = smoothstep( 0.5, 0.95, shore ); // deeper water toward the middle
	float pRad = smoothstep( 0.0, 1.0, length( vAlphaMapUv - 0.5 ) * 2.0 ); // 0 centre → 1 quad edge
	float fres = pow( 1.0 - clamp( dot( normal, normalize( vViewPosition ) ), 0.0, 1.0 ), 4.0 );
	diffuseColor.rgb *= mix( 1.0, 0.55, depth ); // deep centre a shade darker
	diffuseColor.rgb *= mix( 0.88, 1.0, pRad ); // volume: centre ~12% deeper than the rim
	diffuseColor.rgb = mix( diffuseColor.rgb, uSkyTint, fres * 0.7 ); // grazing → sky mirror`,
          )
          .replace(
            '#include <opaque_fragment>',
            `{
	vec3 pV = normalize( vViewPosition );
	vec3 pSun = normalize( ( viewMatrix * vec4( uSunDirW, 0.0 ) ).xyz );
	vec3 pH = normalize( pV + pSun ); // Blinn half-vector — wave facets tilted
	vec3 pR = reflect( -pV, normal ); // toward it light up along the sun azimuth
	float pSpec = pow( clamp( dot( normal, pH ), 0.0, 1.0 ), 10.0 ) * 1.17; // F212c: ×0.45
	float pGlint = pow( clamp( dot( pR, pSun ), 0.0, 1.0 ), 160.0 ) * 2.25; // ×0.45 — no lava
	float pThin = 1.0 - smoothstep( 0.35, 0.41, shore ); // ~6% band inside the alpha edge
	float pRefl = mix( 1.0, 0.55, pThin ); // thin film: weak reflection, deck shows through
	vec3 pSpecCol = mix( uSkyTint, uSunCol, 0.35 ); // skylight leads, warm sun only tints
	outgoingLight += pSpecCol * ( pSpec + pGlint ) * pRefl;
	outgoingLight += uSkyTint * ( 0.14 + fres * 0.5 ) * mix( 1.0, 0.55, depth ) * pRefl;
	}
	#include <opaque_fragment>`,
          );
      };
      m.customProgramCacheKey = () => 'puddle-water'; // distinct program from unpatched standards
      return m;
    }
    case 'lampRed':
      // warning-beacon bulb — self-lit dot
      return new THREE.MeshBasicMaterial({ color: PALETTE.lampRed });
    case 'window': {
      // lit cabin window / hatch — stays crisp through the mist
      const m = new THREE.MeshBasicMaterial({ color: PALETTE.lampWarm });
      m.fog = false;
      return m;
    }
    case 'hull':
      // topsides — painted steel above the waterline
      return new THREE.MeshStandardMaterial({
        color: PALETTE.hull,
        map: getTexture('metal'),
        roughness: 0.62,
        metalness: 0.45,
      });
    case 'hullBand':
      // antifouling band at the waterline — dull oxide red
      return new THREE.MeshStandardMaterial({
        color: PALETTE.hullBand,
        map: getTexture('metal'),
        roughness: 0.85,
        metalness: 0.1,
      });
    case 'stripe':
      // painted hazard band on the deck — matte, still picks up light
      return new THREE.MeshStandardMaterial({
        map: getTexture('stripe'),
        roughness: 0.85,
        metalness: 0.05,
      });
    case 'cone':
      return new THREE.MeshStandardMaterial({
        color: PALETTE.cone,
        map: getTexture('metal'),
        roughness: 0.7,
        metalness: 0,
      });
    case 'rope':
      return new THREE.MeshStandardMaterial({
        color: PALETTE.rope,
        roughness: 0.95,
        metalness: 0,
      });
    case 'skid':
      // tyre scuffs — transparent decal sheet, never writes depth
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
