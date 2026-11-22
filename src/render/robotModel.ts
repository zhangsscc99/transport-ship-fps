// Procedural Cyberpunk Combat Robot Factory (zero external models/textures).
//   - Split armored mecha chassis: pectoral chest plates, floating shoulder pauldrons,
//     segmented forearms, articulated leg greaves & split cyber boots.
//   - Floating faceless helmet with horizontal strong-emissive visor band.
//   - Exposed cylindrical back energy core + glowing containment conduits.
//   - Metallic PBR MeshStandardMaterial (metalness 0.85-0.95 / roughness 0.20-0.35),
//     base paint PALETTE.robotArmor (#23262E), weak-emissive 1px bright armor edges,
//     strong-emissive visor & energy core.
//   - Faction distinction STRICTLY by emissive glow color only (identical geometry!):
//       enemy = magenta (#FF2D95) | ally = cyan (#22E0FF)
//   - Shared geometry & material cache across all instances; single robot strictly <= 2500 tris.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PALETTE } from './palette';
import type { Faction } from '../game/ai';

export type RobotFaction = Faction;

export interface RobotJoints {
  bodyPivot: THREE.Group;
  torsoPivot: THREE.Group;
  headPivot: THREE.Group;
  shoulderL: THREE.Group;
  elbowL: THREE.Group;
  shoulderR: THREE.Group;
  elbowR: THREE.Group;
  weaponMount: THREE.Group;
  hipL: THREE.Group;
  kneeL: THREE.Group;
  ankleL: THREE.Group;
  hipR: THREE.Group;
  kneeR: THREE.Group;
  ankleR: THREE.Group;
}

export interface RobotInstance {
  readonly root: THREE.Group;
  readonly faction: RobotFaction;
  readonly joints: RobotJoints;
  readonly visorMesh: THREE.Mesh;
  readonly visorHalo: THREE.Sprite;
  readonly glowMeshes: readonly THREE.Mesh[];
  readonly edgeLines: readonly THREE.LineSegments[];
  readonly bodyMeshes: readonly THREE.Mesh[];
  readonly headTopAnchor: THREE.Object3D;
  readonly muzzleAnchor: THREE.Object3D;
  readonly muzzleMesh: THREE.Mesh;
  readonly muzzleMat: THREE.MeshBasicMaterial;
  readonly soleProbeL: THREE.Object3D;
  readonly soleProbeR: THREE.Object3D;
  readonly triangleCount: number;
  /** Toggle 0.12s hit visor white flash using cached materials (zero per-frame alloc). */
  setHitFlash(active: boolean): void;
  /** Prepare & apply opacity [0..1] only during death dissolve fade-out. */
  setDeathFade(opacity: number): void;
  /** Release per-instance resources (never disposes shared cache). */
  dispose(): void;
}

interface MaterialCache {
  armor: Record<RobotFaction, THREE.MeshStandardMaterial>;
  armorHitFlash: THREE.MeshStandardMaterial;
  glow: Record<RobotFaction, THREE.MeshStandardMaterial>;
  edgeTrim: Record<RobotFaction, THREE.MeshStandardMaterial>;
  edgeLine: Record<RobotFaction, THREE.LineBasicMaterial>;
  visorFlash: THREE.MeshStandardMaterial;
  visorHalo: Record<RobotFaction, THREE.SpriteMaterial>;
  visorHaloFlash: THREE.SpriteMaterial;
  visorGlowTex: THREE.Texture;
  flashTex: THREE.Texture;
}

export const ARMOR_FRESNEL_CACHE_KEY = 'robot-armor-fresnel-v1';
const ARMOR_EMISSIVE_INTENSITY = 0.16;
const ARMOR_FRESNEL_K: Record<RobotFaction, number> = {
  enemy: 2.6,
  ally: 2.0,
};
const ARMOR_HIT_FRESNEL_K = 3.6;
const VISOR_HALO_OPACITY = 0.90;

interface GeometryCache {
  pelvis: THREE.BufferGeometry;
  torsoArmor: THREE.BufferGeometry;
  torsoEdgeTrim: THREE.BufferGeometry;
  torsoEdgeLine: THREE.BufferGeometry;
  torsoGlow: THREE.BufferGeometry;
  headArmor: THREE.BufferGeometry;
  headEdgeLine: THREE.BufferGeometry;
  headVisor: THREE.BufferGeometry;
  upperArmL: THREE.BufferGeometry;
  upperArmR: THREE.BufferGeometry;
  forearmL: THREE.BufferGeometry;
  forearmR: THREE.BufferGeometry;
  weaponBody: THREE.BufferGeometry;
  weaponGlow: THREE.BufferGeometry;
  thighL: THREE.BufferGeometry;
  thighR: THREE.BufferGeometry;
  shinL: THREE.BufferGeometry;
  shinR: THREE.BufferGeometry;
  foot: THREE.BufferGeometry;
  muzzleQuad: THREE.BufferGeometry;
  totalTris: number;
}

let cachedMaterials: MaterialCache | null = null;
let cachedGeometries: GeometryCache | null = null;

function countGeoTris(g: THREE.BufferGeometry): number {
  const idx = g.getIndex();
  if (idx) return Math.round(idx.count / 3);
  const pos = g.getAttribute('position');
  return pos ? Math.round(pos.count / 3) : 0;
}

/** Bake normalized per-vertex tint (1,1,1 = exact PALETTE.robotArmor #23262E) and transform. */
function makePart(
  geo: THREE.BufferGeometry,
  pos: [number, number, number],
  rot: [number, number, number] = [0, 0, 0],
  tint: [number, number, number] = [1, 1, 1],
): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  geo.dispose();
  if (rot[0] !== 0 || rot[1] !== 0 || rot[2] !== 0) {
    const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rot[0], rot[1], rot[2]));
    g.applyMatrix4(m);
  }
  if (pos[0] !== 0 || pos[1] !== 0 || pos[2] !== 0) {
    g.translate(pos[0], pos[1], pos[2]);
  }
  // Keep only position + normal + vertex color so mergeGeometries always succeeds cleanly
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal') {
      g.deleteAttribute(name);
    }
  }
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  const count = g.getAttribute('position').count;
  const cols = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    cols[i * 3] = tint[0];
    cols[i * 3 + 1] = tint[1];
    cols[i * 3 + 2] = tint[2];
  }
  g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  return g;
}

function mergeStrict(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
  if (!merged) throw new Error('robotModel: mergeGeometries failed');
  if (parts.length > 1) {
    for (const p of parts) p.dispose();
  }
  return merged;
}

/** Create procedural additive muzzle-flash sprite texture (no external assets). */
function createFlashTexture(): THREE.Texture {
  if (typeof document === 'undefined') {
    const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    tex.needsUpdate = true;
    return tex;
  }
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 30);
  g.addColorStop(0.0, PALETTE.robotHitFlash);
  g.addColorStop(0.32, PALETTE.flashCore);
  g.addColorStop(0.68, PALETTE.flashMid);
  g.addColorStop(1.0, 'rgba(255, 80, 18, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Create procedural additive horizontal visor bloom sprite texture (zero external assets). */
function createVisorGlowTexture(): THREE.Texture {
  if (typeof document === 'undefined') {
    const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    tex.needsUpdate = true;
    return tex;
  }
  const size = 64;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const half = (size - 1) * 0.5;
  for (let y = 0; y < size; y++) {
    const ny = (y - half) / half;
    for (let x = 0; x < size; x++) {
      const nx = (x - half) / half;
      // Wide horizontal visor capsule core + smooth radial outer bloom fading cleanly to 0 at border
      const barDx = Math.max(0, Math.abs(nx) - 0.32) / 0.68;
      const barR = Math.hypot(barDx, ny * 1.45);
      const core = Math.exp(-barR * barR * 6.5);
      const outerR = Math.hypot(nx, ny);
      const halo = outerR < 1 ? Math.pow(1 - outerR, 2.2) : 0;
      const edgeFade = outerR < 1 ? Math.min(1, (1 - outerR) * 4.5) : 0;
      const alpha = Math.max(0, Math.min(1, (core * 0.85 + halo * 0.72) * edgeFade));
      const idx = (y * size + x) * 4;
      d[idx] = 255;
      d[idx + 1] = 255;
      d[idx + 2] = 255;
      d[idx + 3] = Math.round(alpha * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Inject view-dependent Fresnel silhouette rim glow into a MeshStandardMaterial:
 *   totalEmissiveRadiance += rimColor * pow(1.0 - dot(N, V), 3.0) * k
 * Uses uniform uRimColor + uRimStrength so enemy/ally/hit/death-fade clones share one program.
 */
function applyArmorFresnel(
  mat: THREE.MeshStandardMaterial,
  rimHex: string,
  rimStrength: { value: number },
): void {
  const rimColor = new THREE.Color(rimHex);
  mat.userData.fresnelRimColor = rimHex;
  mat.userData.fresnelRimStrength = rimStrength;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uRimColor = { value: rimColor };
    shader.uniforms.uRimStrength = rimStrength;
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform vec3 uRimColor;\nuniform float uRimStrength;',
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
{
	float rimNdotV = clamp( dot( normalize( normal ), normalize( vViewPosition ) ), 0.0, 1.0 );
	float rimFactor = pow( 1.0 - rimNdotV, 3.0 );
	totalEmissiveRadiance += uRimColor * rimFactor * uRimStrength;
}`,
      );
  };
  mat.customProgramCacheKey = () => ARMOR_FRESNEL_CACHE_KEY;
}

function getMaterials(): MaterialCache {
  if (cachedMaterials) return cachedMaterials;

  const makeArmor = (rimHex: string, rimK: number, emissiveHex: string = PALETTE.robotEdge, emissiveInt = ARMOR_EMISSIVE_INTENSITY): THREE.MeshStandardMaterial => {
    const mat = new THREE.MeshStandardMaterial({
      color: PALETTE.robotArmor,
      emissive: emissiveHex,
      emissiveIntensity: emissiveInt,
      metalness: 0.86,
      roughness: 0.26,
      envMapIntensity: 2.9,
      vertexColors: true,
    });
    applyArmorFresnel(mat, rimHex, { value: rimK });
    return mat;
  };

  const makeGlow = (hex: string): THREE.MeshStandardMaterial =>
    new THREE.MeshStandardMaterial({
      color: hex,
      emissive: hex,
      emissiveIntensity: 4.4,
      metalness: 0.85,
      roughness: 0.20,
      envMapIntensity: 1.4,
    });

  const makeEdgeTrim = (hex: string): THREE.MeshStandardMaterial =>
    new THREE.MeshStandardMaterial({
      color: PALETTE.robotEdge,
      emissive: hex,
      emissiveIntensity: 0.55,
      metalness: 0.92,
      roughness: 0.22,
      envMapIntensity: 2.2,
    });

  const makeEdgeLine = (hex: string): THREE.LineBasicMaterial => {
    const col = new THREE.Color(PALETTE.robotEdge).lerp(new THREE.Color(hex), 0.48);
    return new THREE.LineBasicMaterial({
      color: col,
      transparent: true,
      opacity: 0.82,
    });
  };

  const visorGlowTex = createVisorGlowTexture();
  const makeVisorHalo = (hex: string, opacity: number): THREE.SpriteMaterial =>
    new THREE.SpriteMaterial({
      map: visorGlowTex,
      color: hex,
      blending: THREE.AdditiveBlending,
      transparent: true,
      opacity,
      depthWrite: false,
      depthTest: true,
      fog: false,
      toneMapped: false,
    });

  const visorFlash = new THREE.MeshStandardMaterial({
    color: PALETTE.robotHitFlash,
    emissive: PALETTE.robotHitFlash,
    emissiveIntensity: 4.8,
    metalness: 0.85,
    roughness: 0.20,
  });

  cachedMaterials = {
    armor: {
      enemy: makeArmor(PALETTE.robotGlowEnemy, ARMOR_FRESNEL_K.enemy),
      ally: makeArmor(PALETTE.robotGlowAlly, ARMOR_FRESNEL_K.ally),
    },
    armorHitFlash: makeArmor(PALETTE.robotHitFlash, ARMOR_HIT_FRESNEL_K, PALETTE.robotHitFlash, 0.42),
    glow: {
      enemy: makeGlow(PALETTE.robotGlowEnemy),
      ally: makeGlow(PALETTE.robotGlowAlly),
    },
    edgeTrim: {
      enemy: makeEdgeTrim(PALETTE.robotGlowEnemy),
      ally: makeEdgeTrim(PALETTE.robotGlowAlly),
    },
    edgeLine: {
      enemy: makeEdgeLine(PALETTE.robotGlowEnemy),
      ally: makeEdgeLine(PALETTE.robotGlowAlly),
    },
    visorFlash,
    visorHalo: {
      enemy: makeVisorHalo(PALETTE.robotGlowEnemy, VISOR_HALO_OPACITY),
      ally: makeVisorHalo(PALETTE.robotGlowAlly, VISOR_HALO_OPACITY),
    },
    visorHaloFlash: makeVisorHalo(PALETTE.robotHitFlash, 0.98),
    visorGlowTex,
    flashTex: createFlashTexture(),
  };
  return cachedMaterials;
}

// Vertex tint multipliers against PALETTE.robotArmor
const TINT_ARMOR: [number, number, number] = [1.0, 1.0, 1.0];
const TINT_ARMOR_HI: [number, number, number] = [1.75, 1.82, 1.95]; // machined bright chamfer panels
const TINT_FRAME: [number, number, number] = [0.62, 0.66, 0.74]; // inner hydraulic dark gunmetal
const TINT_GUN: [number, number, number] = [1.35, 1.42, 1.52]; // machined pulse carbine steel

function buildUpperArm(side: -1 | 1): {
  armor: THREE.BufferGeometry;
  edgeLine: THREE.BufferGeometry;
  glow: THREE.BufferGeometry;
} {
  // Split floating pauldron + dark shoulder actuator + segmented bicep armor
  const pauldronMain = makePart(
    new THREE.BoxGeometry(0.15, 0.125, 0.21),
    [side * 0.045, 0.025, 0],
    [0, 0, -side * 0.32],
    TINT_ARMOR,
  );
  const pauldronWing = makePart(
    new THREE.BoxGeometry(0.06, 0.14, 0.175),
    [side * 0.105, -0.025, 0.005],
    [0, 0, -side * 0.14],
    TINT_ARMOR_HI,
  );
  const pauldronCap = makePart(
    new THREE.BoxGeometry(0.12, 0.032, 0.16),
    [side * 0.03, 0.092, 0],
    [0, 0, -side * 0.28],
    TINT_ARMOR_HI,
  );
  const armorPlates = mergeStrict([pauldronMain.clone(), pauldronWing.clone(), pauldronCap.clone()]);
  const edgeLine = new THREE.EdgesGeometry(armorPlates, 26);
  armorPlates.dispose();

  const armor = mergeStrict([
    pauldronMain,
    pauldronWing,
    pauldronCap,
    // Mechanical shoulder ball joint
    makePart(new THREE.CylinderGeometry(0.052, 0.052, 0.10, 8), [0, -0.01, 0], [0, 0, Math.PI / 2], TINT_FRAME),
    // Inner hydraulic bicep strut
    makePart(new THREE.CylinderGeometry(0.036, 0.032, 0.22, 8), [side * 0.01, -0.14, 0], [0, 0, 0], TINT_FRAME),
    // Outer split bicep guard
    makePart(new THREE.BoxGeometry(0.068, 0.15, 0.095), [side * 0.042, -0.145, 0], [0, 0, -side * 0.08], TINT_ARMOR),
    // Elbow hinge drum
    makePart(new THREE.CylinderGeometry(0.038, 0.038, 0.085, 8), [side * 0.01, -0.25, 0], [0, 0, Math.PI / 2], TINT_FRAME),
  ]);

  // Subtle glowing seam strip along the top edge of the pauldron
  const glow = makePart(
    new THREE.BoxGeometry(0.02, 0.016, 0.165),
    [side * 0.085, 0.062, 0],
    [0, 0, -side * 0.28],
    TINT_ARMOR,
  );

  return { armor, edgeLine, glow };
}

function buildForearm(side: -1 | 1): THREE.BufferGeometry {
  return mergeStrict([
    // Inner mechanical wrist strut
    makePart(new THREE.CylinderGeometry(0.032, 0.026, 0.23, 8), [0, -0.125, 0], [0, 0, 0], TINT_FRAME),
    // Split outer cyber gauntlet plate
    makePart(new THREE.BoxGeometry(0.072, 0.19, 0.098), [side * 0.022, -0.125, -0.008], [0, 0, -side * 0.06], TINT_ARMOR),
    // Dorsal knuckle/cuff armor ridge
    makePart(new THREE.BoxGeometry(0.056, 0.12, 0.042), [side * 0.016, -0.14, -0.052], [0.08, 0, 0], TINT_ARMOR_HI),
    // Cyber mechanical hand clamp
    makePart(new THREE.BoxGeometry(0.058, 0.072, 0.068), [0, -0.255, -0.012], [0, 0, 0], TINT_FRAME),
  ]);
}

function buildThigh(side: -1 | 1): THREE.BufferGeometry {
  return mergeStrict([
    // Inner structural femur actuator
    makePart(new THREE.CylinderGeometry(0.052, 0.042, 0.41, 8), [0, -0.21, 0], [0, 0, 0], TINT_FRAME),
    // Front split thigh armor plate
    makePart(new THREE.BoxGeometry(0.115, 0.30, 0.105), [side * 0.012, -0.20, -0.028], [-0.06, 0, 0], TINT_ARMOR),
    // Outer angled thigh side-plate
    makePart(new THREE.BoxGeometry(0.052, 0.26, 0.13), [side * 0.068, -0.19, 0.005], [0, 0, -side * 0.08], TINT_ARMOR_HI),
    // Rear hydraulic thigh guard
    makePart(new THREE.BoxGeometry(0.088, 0.22, 0.065), [0, -0.20, 0.055], [0.06, 0, 0], TINT_ARMOR),
  ]);
}

function buildShin(side: -1 | 1): { armor: THREE.BufferGeometry; edgeLine: THREE.BufferGeometry } {
  const kneeCap = makePart(
    new THREE.BoxGeometry(0.096, 0.11, 0.075),
    [0, -0.015, -0.062],
    [0.22, 0, 0],
    TINT_ARMOR_HI,
  );
  const greaveFront = makePart(
    new THREE.BoxGeometry(0.105, 0.31, 0.095),
    [side * 0.008, -0.22, -0.032],
    [0.06, 0, 0],
    TINT_ARMOR,
  );
  const greaveSide = makePart(
    new THREE.BoxGeometry(0.044, 0.27, 0.11),
    [side * 0.058, -0.215, 0.004],
    [0, 0, -side * 0.05],
    TINT_ARMOR_HI,
  );
  const plateBundle = mergeStrict([kneeCap.clone(), greaveFront.clone(), greaveSide.clone()]);
  const edgeLine = new THREE.EdgesGeometry(plateBundle, 26);
  plateBundle.dispose();

  const armor = mergeStrict([
    kneeCap,
    greaveFront,
    greaveSide,
    // Knee rotary drum
    makePart(new THREE.CylinderGeometry(0.046, 0.046, 0.10, 8), [0, 0, 0], [0, 0, Math.PI / 2], TINT_FRAME),
    // Inner shin strut & rear piston
    makePart(new THREE.CylinderGeometry(0.038, 0.032, 0.40, 8), [0, -0.21, 0.012], [0, 0, 0], TINT_FRAME),
    makePart(new THREE.CylinderGeometry(0.018, 0.016, 0.30, 6), [0, -0.22, 0.068], [-0.08, 0, 0], TINT_FRAME),
  ]);
  return { armor, edgeLine };
}

function getGeometries(): GeometryCache {
  if (cachedGeometries) return cachedGeometries;

  // --- Pelvis (centered at bodyPivot y=0.96) ---
  const pelvis = mergeStrict([
    makePart(new THREE.BoxGeometry(0.26, 0.11, 0.18), [0, 0.0, 0], [0, 0, 0], TINT_FRAME),
    // Split front/rear waist armor skirts
    makePart(new THREE.BoxGeometry(0.15, 0.125, 0.055), [0, -0.01, -0.098], [0.16, 0, 0], TINT_ARMOR),
    makePart(new THREE.BoxGeometry(0.16, 0.10, 0.05), [0, 0.005, 0.095], [-0.14, 0, 0], TINT_ARMOR),
    // Hip flank guards
    makePart(new THREE.BoxGeometry(0.045, 0.09, 0.15), [-0.145, 0.01, 0], [0, 0, 0.18], TINT_ARMOR_HI),
    makePart(new THREE.BoxGeometry(0.045, 0.09, 0.15), [0.145, 0.01, 0], [0, 0, -0.18], TINT_ARMOR_HI),
    // Hip axle cylinders
    makePart(new THREE.CylinderGeometry(0.044, 0.044, 0.29, 8), [0, -0.02, 0], [0, 0, Math.PI / 2], TINT_FRAME),
  ]);

  // --- Torso: Split Chest Armor + Collar + Exposed Back Energy Core ---
  const chestL = makePart(
    new THREE.BoxGeometry(0.175, 0.21, 0.13),
    [-0.102, 0.27, -0.082],
    [-0.14, 0.22, 0.06],
    TINT_ARMOR,
  );
  const chestR = makePart(
    new THREE.BoxGeometry(0.175, 0.21, 0.13),
    [0.102, 0.27, -0.082],
    [-0.14, -0.22, -0.06],
    TINT_ARMOR,
  );
  const chestUpperL = makePart(
    new THREE.BoxGeometry(0.16, 0.075, 0.16),
    [-0.105, 0.375, -0.02],
    [0.18, 0.12, 0.12],
    TINT_ARMOR_HI,
  );
  const chestUpperR = makePart(
    new THREE.BoxGeometry(0.16, 0.075, 0.16),
    [0.105, 0.375, -0.02],
    [0.18, -0.12, -0.12],
    TINT_ARMOR_HI,
  );
  const ribL = makePart(
    new THREE.BoxGeometry(0.085, 0.16, 0.18),
    [-0.155, 0.145, -0.01],
    [0, 0.08, -0.10],
    TINT_ARMOR,
  );
  const ribR = makePart(
    new THREE.BoxGeometry(0.085, 0.16, 0.18),
    [0.155, 0.145, -0.01],
    [0, -0.08, 0.10],
    TINT_ARMOR,
  );
  // Armored collar rim surrounding open magnetic hover well (NO neck pillar!)
  const collarL = makePart(new THREE.BoxGeometry(0.045, 0.065, 0.17), [-0.105, 0.425, 0.01], [0, 0, -0.22], TINT_ARMOR_HI);
  const collarR = makePart(new THREE.BoxGeometry(0.045, 0.065, 0.17), [0.105, 0.425, 0.01], [0, 0, 0.22], TINT_ARMOR_HI);
  const collarRear = makePart(new THREE.BoxGeometry(0.19, 0.078, 0.045), [0, 0.435, 0.095], [0.22, 0, 0], TINT_ARMOR_HI);

  // Back Energy Core armored housing (split cowling leaving central glowing cylinder clearly exposed)
  const packTop = makePart(new THREE.BoxGeometry(0.24, 0.065, 0.14), [0, 0.375, 0.16], [-0.18, 0, 0], TINT_ARMOR);
  const packBot = makePart(new THREE.BoxGeometry(0.20, 0.06, 0.12), [0, 0.115, 0.145], [0.20, 0, 0], TINT_ARMOR);
  const packFinL = makePart(new THREE.BoxGeometry(0.042, 0.24, 0.135), [-0.115, 0.245, 0.175], [0, -0.18, -0.06], TINT_ARMOR_HI);
  const packFinR = makePart(new THREE.BoxGeometry(0.042, 0.24, 0.135), [0.115, 0.245, 0.175], [0, 0.18, 0.06], TINT_ARMOR_HI);

  const torsoArmorPlates = mergeStrict([
    chestL.clone(),
    chestR.clone(),
    chestUpperL.clone(),
    chestUpperR.clone(),
    ribL.clone(),
    ribR.clone(),
    collarL.clone(),
    collarR.clone(),
    collarRear.clone(),
    packTop.clone(),
    packBot.clone(),
    packFinL.clone(),
    packFinR.clone(),
  ]);
  const torsoEdgeLine = new THREE.EdgesGeometry(torsoArmorPlates, 26);
  torsoArmorPlates.dispose();

  const torsoArmor = mergeStrict([
    chestL,
    chestR,
    chestUpperL,
    chestUpperR,
    ribL,
    ribR,
    collarL,
    collarR,
    collarRear,
    packTop,
    packBot,
    packFinL,
    packFinR,
    // Inner mechanical spine & core block
    makePart(new THREE.BoxGeometry(0.22, 0.34, 0.18), [0, 0.21, 0.01], [0, 0, 0], TINT_FRAME),
    // Segmented abdomen hydraulic plates
    makePart(new THREE.BoxGeometry(0.16, 0.055, 0.08), [0, 0.06, -0.075], [0.08, 0, 0], TINT_FRAME),
    makePart(new THREE.BoxGeometry(0.18, 0.055, 0.09), [0, 0.125, -0.085], [0.04, 0, 0], TINT_ARMOR),
    // Back core containment rings (dark metallic bands around glowing cylinder)
    makePart(new THREE.CylinderGeometry(0.074, 0.074, 0.022, 10), [0, 0.30, 0.195], [0, 0, 0], TINT_FRAME),
    makePart(new THREE.CylinderGeometry(0.074, 0.074, 0.022, 10), [0, 0.245, 0.195], [0, 0, 0], TINT_FRAME),
    makePart(new THREE.CylinderGeometry(0.074, 0.074, 0.022, 10), [0, 0.19, 0.195], [0, 0, 0], TINT_FRAME),
  ]);

  // Subtle weak-emissive chamfer accent strips on chest & backpack edges
  const torsoEdgeTrim = mergeStrict([
    makePart(new THREE.BoxGeometry(0.155, 0.012, 0.014), [-0.105, 0.365, -0.145], [0, 0.22, 0.06], TINT_ARMOR),
    makePart(new THREE.BoxGeometry(0.155, 0.012, 0.014), [0.105, 0.365, -0.145], [0, -0.22, -0.06], TINT_ARMOR),
    makePart(new THREE.BoxGeometry(0.014, 0.22, 0.014), [-0.135, 0.245, 0.238], [0, 0, -0.06], TINT_ARMOR),
    makePart(new THREE.BoxGeometry(0.014, 0.22, 0.014), [0.135, 0.245, 0.238], [0, 0, 0.06], TINT_ARMOR),
  ]);

  // Strong-emissive Back Energy Core + side energy conduits + chest sternum slit + magnetic hover collar ring
  const torsoGlow = mergeStrict([
    // Main back energy core cylinder (bold & unmistakable from rear & 3/4 angles!)
    makePart(new THREE.CylinderGeometry(0.074, 0.074, 0.26, 12), [0, 0.245, 0.205], [0, 0, 0], TINT_ARMOR),
    // Dual exposed side core conduit vents (visible from side & 3/4 front angles!)
    makePart(new THREE.BoxGeometry(0.028, 0.185, 0.048), [-0.148, 0.255, 0.148], [0, 0, -0.08], TINT_ARMOR),
    makePart(new THREE.BoxGeometry(0.028, 0.185, 0.048), [0.148, 0.255, 0.148], [0, 0, 0.08], TINT_ARMOR),
    // Front sternum vertical power slit between split chest plates
    makePart(new THREE.BoxGeometry(0.026, 0.15, 0.03), [0, 0.275, -0.128], [-0.12, 0, 0], TINT_ARMOR),
    // Magnetic levitation emitter ring inside neck collar (reinforces floating head!)
    makePart(new THREE.CylinderGeometry(0.07, 0.074, 0.02, 12, 1, true), [0, 0.408, 0.0], [0, 0, 0], TINT_ARMOR),
  ]);

  // --- Floating Faceless Head (local origin at center of floating helmet, hovers cleanly above torso collar!) ---
  const helmCrown = makePart(new THREE.BoxGeometry(0.165, 0.085, 0.22), [0, 0.075, 0.008], [0.12, 0, 0], TINT_ARMOR_HI);
  const helmFace = makePart(new THREE.BoxGeometry(0.17, 0.095, 0.19), [0, -0.015, 0.005], [0, 0, 0], TINT_ARMOR);
  const helmJaw = makePart(new THREE.BoxGeometry(0.125, 0.055, 0.155), [0, -0.075, -0.005], [-0.14, 0, 0], TINT_ARMOR);
  const helmBack = makePart(new THREE.BoxGeometry(0.13, 0.11, 0.09), [0, 0.04, 0.115], [-0.32, 0, 0], TINT_ARMOR_HI);
  const earFinL = makePart(new THREE.BoxGeometry(0.022, 0.105, 0.08), [-0.096, 0.035, 0.035], [-0.35, 0, 0.12], TINT_ARMOR_HI);
  const earFinR = makePart(new THREE.BoxGeometry(0.022, 0.105, 0.08), [0.096, 0.035, 0.035], [-0.35, 0, -0.12], TINT_ARMOR_HI);
  const headPlates = mergeStrict([
    helmCrown.clone(),
    helmFace.clone(),
    helmJaw.clone(),
    helmBack.clone(),
    earFinL.clone(),
    earFinR.clone(),
  ]);
  const headEdgeLine = new THREE.EdgesGeometry(headPlates, 26);
  headPlates.dispose();

  const headArmor = mergeStrict([
    helmCrown,
    helmFace,
    helmJaw,
    helmBack,
    earFinL,
    earFinR,
    // Dark recessed visor channel behind glowing horizontal band
    makePart(new THREE.BoxGeometry(0.178, 0.052, 0.05), [0, 0.008, -0.076], [0, 0, 0], TINT_FRAME),
    // Underside magnetic hover base plate (floating gap visible below this!)
    makePart(new THREE.CylinderGeometry(0.048, 0.038, 0.018, 10), [0, -0.105, 0.0], [0, 0, 0], TINT_FRAME),
  ]);

  // Single razor-sharp horizontal glowing visor strip wrapping across the faceless front (-Z)
  const headVisor = mergeStrict([
    makePart(new THREE.BoxGeometry(0.186, 0.042, 0.026), [0, 0.008, -0.10], [0, 0, 0], TINT_ARMOR),
    // Wraparound temple light accents
    makePart(new THREE.BoxGeometry(0.02, 0.032, 0.074), [-0.09, 0.008, -0.062], [0, 0, 0], TINT_ARMOR),
    makePart(new THREE.BoxGeometry(0.02, 0.032, 0.074), [0.09, 0.008, -0.062], [0, 0, 0], TINT_ARMOR),
  ]);

  // --- Arms ---
  const upperL = buildUpperArm(-1);
  const upperR = buildUpperArm(1);
  upperL.edgeLine.dispose();
  upperR.edgeLine.dispose();
  upperL.glow.dispose();
  upperR.glow.dispose();
  const forearmL = buildForearm(-1);
  const forearmR = buildForearm(1);

  // --- Procedural Cyber Pulse Carbine (aligned along -Z in weaponMount local space) ---
  const weaponBody = mergeStrict([
    // Main angular receiver
    makePart(new THREE.BoxGeometry(0.058, 0.095, 0.42), [0, 0.01, -0.22], [0, 0, 0], TINT_GUN),
    // Forward rail barrel shroud
    makePart(new THREE.BoxGeometry(0.046, 0.068, 0.28), [0, 0.018, -0.52], [0, 0, 0], TINT_ARMOR_HI),
    // Inner barrel cylinder
    makePart(new THREE.CylinderGeometry(0.015, 0.015, 0.24, 8), [0, 0.02, -0.62], [Math.PI / 2, 0, 0], TINT_FRAME),
    // Buttstock
    makePart(new THREE.BoxGeometry(0.046, 0.082, 0.18), [0, -0.005, 0.05], [0, 0, 0], TINT_ARMOR),
    // Slanted energy magazine
    makePart(new THREE.BoxGeometry(0.036, 0.15, 0.062), [0, -0.09, -0.26], [0.20, 0, 0], TINT_FRAME),
    // Pistol grip
    makePart(new THREE.BoxGeometry(0.034, 0.095, 0.045), [0, -0.068, -0.07], [-0.26, 0, 0], TINT_FRAME),
    // Holographic sight hood
    makePart(new THREE.BoxGeometry(0.042, 0.038, 0.095), [0, 0.074, -0.18], [0, 0, 0], TINT_ARMOR_HI),
  ]);
  const weaponGlow = mergeStrict([
    // Glowing faction plasma rails along left & right sides of barrel shroud
    makePart(new THREE.BoxGeometry(0.054, 0.013, 0.34), [0, 0.025, -0.44], [0, 0, 0], TINT_ARMOR),
    // Sight reticle emitter
    makePart(new THREE.BoxGeometry(0.024, 0.014, 0.016), [0, 0.076, -0.18], [0, 0, 0], TINT_ARMOR),
  ]);

  // --- Legs & Split Cyber Boots (sole strictly at ankle local y = -0.08 -> standing y = 0.000) ---
  const thighL = buildThigh(-1);
  const thighR = buildThigh(1);
  const shinL = buildShin(-1);
  const shinR = buildShin(1);
  shinL.edgeLine.dispose();
  shinR.edgeLine.dispose();
  const foot = mergeStrict([
    // Main cyber sole (bottom at y = -0.080)
    makePart(new THREE.BoxGeometry(0.11, 0.042, 0.24), [0, -0.059, -0.035], [0, 0, 0], TINT_FRAME),
    // Split armored toe hood
    makePart(new THREE.BoxGeometry(0.105, 0.052, 0.135), [0, -0.028, -0.078], [0.20, 0, 0], TINT_ARMOR),
    // Heel stabilizer spur
    makePart(new THREE.BoxGeometry(0.088, 0.058, 0.085), [0, -0.036, 0.055], [-0.14, 0, 0], TINT_ARMOR_HI),
  ]);

  const muzzleQuad = new THREE.PlaneGeometry(0.38, 0.38);

  const totalTris =
    countGeoTris(pelvis) +
    countGeoTris(torsoArmor) +
    countGeoTris(torsoEdgeTrim) +
    countGeoTris(torsoGlow) +
    countGeoTris(headArmor) +
    countGeoTris(headVisor) +
    countGeoTris(upperL.armor) +
    countGeoTris(upperR.armor) +
    countGeoTris(forearmL) +
    countGeoTris(forearmR) +
    countGeoTris(weaponBody) +
    countGeoTris(weaponGlow) +
    countGeoTris(thighL) +
    countGeoTris(thighR) +
    countGeoTris(shinL.armor) +
    countGeoTris(shinR.armor) +
    countGeoTris(foot) * 2 +
    2; // visor additive fake-bloom sprite (2 tris)

  cachedGeometries = {
    pelvis,
    torsoArmor,
    torsoEdgeTrim,
    torsoEdgeLine,
    torsoGlow,
    headArmor,
    headEdgeLine,
    headVisor,
    upperArmL: upperL.armor,
    upperArmR: upperR.armor,
    forearmL,
    forearmR,
    weaponBody,
    weaponGlow,
    thighL,
    thighR,
    shinL: shinL.armor,
    shinR: shinR.armor,
    foot,
    muzzleQuad,
    totalTris,
  };
  return cachedGeometries;
}

/** Create a procedural cyberpunk combat robot (shared geometry & cached PBR materials). */
export function createRobot(faction: RobotFaction = 'enemy'): RobotInstance {
  const mats = getMaterials();
  const geos = getGeometries();
  const armorMat = mats.armor[faction];
  const glowMat = mats.glow[faction];
  const edgeTrimMat = mats.edgeTrim[faction];
  const edgeLineMat = mats.edgeLine[faction];
  const visorHaloMat = mats.visorHalo[faction];
  const factionGlowHex = faction === 'enemy' ? PALETTE.robotGlowEnemy : PALETTE.robotGlowAlly;

  const root = new THREE.Group();
  root.name = `cyber-robot-${faction}`;

  const bodyMeshes: THREE.Mesh[] = [];
  const armorMeshes: THREE.Mesh[] = [];
  const glowMeshes: THREE.Mesh[] = [];
  const edgeLines: THREE.LineSegments[] = [];

  const addMesh = (
    parent: THREE.Object3D,
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    isGlow = false,
    castShadow = true,
  ): THREE.Mesh => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = castShadow;
    m.receiveShadow = true;
    m.frustumCulled = false;
    parent.add(m);
    if (isGlow) glowMeshes.push(m);
    else {
      bodyMeshes.push(m);
      if (mat === armorMat) armorMeshes.push(m);
    }
    return m;
  };

  const addEdge = (parent: THREE.Object3D, geo: THREE.BufferGeometry): void => {
    const ls = new THREE.LineSegments(geo, edgeLineMat);
    ls.frustumCulled = false;
    parent.add(ls);
    edgeLines.push(ls);
  };

  // Pelvis / root body pivot (standing height y = 0.96 -> boots sit flush on y = 0.000)
  const bodyPivot = new THREE.Group();
  bodyPivot.name = 'robot-body';
  bodyPivot.position.set(0, 0.96, 0);
  root.add(bodyPivot);
  addMesh(bodyPivot, geos.pelvis, armorMat);

  // Torso
  const torsoPivot = new THREE.Group();
  torsoPivot.name = 'robot-torso';
  torsoPivot.position.set(0, 0.08, 0);
  bodyPivot.add(torsoPivot);
  addMesh(torsoPivot, geos.torsoArmor, armorMat);
  addMesh(torsoPivot, geos.torsoEdgeTrim, edgeTrimMat, false, false);
  addMesh(torsoPivot, geos.torsoGlow, glowMat, true, false);
  addEdge(torsoPivot, geos.torsoEdgeLine);

  // Floating detached head (magnetic hover gap above collar at y = 0.405 -> head bottom at 0.56 - 0.105 = 0.455 -> 5cm clear gap!)
  const headPivot = new THREE.Group();
  headPivot.name = 'robot-head';
  headPivot.position.set(0, 0.56, 0);
  torsoPivot.add(headPivot);
  addMesh(headPivot, geos.headArmor, armorMat);
  addEdge(headPivot, geos.headEdgeLine);
  const visorMesh = addMesh(headPivot, geos.headVisor, glowMat, true, false);
  visorMesh.name = 'robot-visor';

  // Low-cost procedural additive fake-bloom halo over visor (zero post-processing):
  // reads as a bright luminous point at 12-35m instead of a sub-pixel hairline.
  const visorHalo = new THREE.Sprite(visorHaloMat);
  visorHalo.name = 'robot-visor-halo';
  visorHalo.position.set(0, 0.008, -0.124);
  visorHalo.scale.set(0.46, 0.24, 1);
  visorHalo.frustumCulled = false;
  visorHalo.renderOrder = 2;
  headPivot.add(visorHalo);

  const headTopAnchor = new THREE.Object3D();
  headTopAnchor.position.set(0, 0.16, 0);
  headPivot.add(headTopAnchor);

  // Left arm
  const shoulderL = new THREE.Group();
  shoulderL.name = 'robot-shoulder-l';
  shoulderL.position.set(-0.245, 0.34, 0);
  torsoPivot.add(shoulderL);
  addMesh(shoulderL, geos.upperArmL, armorMat, false, false);

  const elbowL = new THREE.Group();
  elbowL.name = 'robot-elbow-l';
  elbowL.position.set(-0.01, -0.25, 0);
  shoulderL.add(elbowL);
  addMesh(elbowL, geos.forearmL, armorMat, false, false);

  // Right arm + Cyber Pulse Carbine
  const shoulderR = new THREE.Group();
  shoulderR.name = 'robot-shoulder-r';
  shoulderR.position.set(0.245, 0.34, 0);
  torsoPivot.add(shoulderR);
  addMesh(shoulderR, geos.upperArmR, armorMat, false, false);

  const elbowR = new THREE.Group();
  elbowR.name = 'robot-elbow-r';
  elbowR.position.set(0.01, -0.25, 0);
  shoulderR.add(elbowR);
  addMesh(elbowR, geos.forearmR, armorMat, false, false);

  const weaponMount = new THREE.Group();
  weaponMount.name = 'robot-weapon';
  weaponMount.position.set(-0.01, -0.24, -0.02);
  elbowR.add(weaponMount);
  addMesh(weaponMount, geos.weaponBody, armorMat, false, false);
  addMesh(weaponMount, geos.weaponGlow, glowMat, true, false);

  const muzzleAnchor = new THREE.Object3D();
  muzzleAnchor.position.set(0, 0.02, -0.76);
  weaponMount.add(muzzleAnchor);

  const muzzleMat = new THREE.MeshBasicMaterial({
    map: mats.flashTex,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const muzzleMesh = new THREE.Mesh(geos.muzzleQuad, muzzleMat);
  muzzleMesh.position.set(0, 0.02, -0.78);
  muzzleMesh.visible = false;
  muzzleMesh.frustumCulled = false;
  weaponMount.add(muzzleMesh);

  // Left leg
  const hipL = new THREE.Group();
  hipL.name = 'robot-hip-l';
  hipL.position.set(-0.115, -0.02, 0);
  bodyPivot.add(hipL);
  addMesh(hipL, geos.thighL, armorMat, false, true);

  const kneeL = new THREE.Group();
  kneeL.name = 'robot-knee-l';
  kneeL.position.set(0, -0.44, 0);
  hipL.add(kneeL);
  addMesh(kneeL, geos.shinL, armorMat, false, false);

  const ankleL = new THREE.Group();
  ankleL.name = 'robot-ankle-l';
  ankleL.position.set(0, -0.42, 0);
  kneeL.add(ankleL);
  addMesh(ankleL, geos.foot, armorMat, false, false);

  const soleProbeL = new THREE.Object3D();
  soleProbeL.position.set(0, -0.08, -0.02);
  ankleL.add(soleProbeL);

  // Right leg
  const hipR = new THREE.Group();
  hipR.name = 'robot-hip-r';
  hipR.position.set(0.115, -0.02, 0);
  bodyPivot.add(hipR);
  addMesh(hipR, geos.thighR, armorMat, false, true);

  const kneeR = new THREE.Group();
  kneeR.name = 'robot-knee-r';
  kneeR.position.set(0, -0.44, 0);
  hipR.add(kneeR);
  addMesh(kneeR, geos.shinR, armorMat, false, false);

  const ankleR = new THREE.Group();
  ankleR.name = 'robot-ankle-r';
  ankleR.position.set(0, -0.42, 0);
  kneeR.add(ankleR);
  addMesh(ankleR, geos.foot, armorMat, false, false);

  const soleProbeR = new THREE.Object3D();
  soleProbeR.position.set(0, -0.08, -0.02);
  ankleR.add(soleProbeR);

  let hitFlashOn = false;
  let fadeClones: THREE.Material[] | null = null;
  let fadeRimStrength: { value: number } | null = null;

  const setHitFlash = (active: boolean): void => {
    if (fadeClones) return;
    if (active === hitFlashOn) return;
    hitFlashOn = active;
    visorMesh.material = active ? mats.visorFlash : glowMat;
    visorHalo.material = active ? mats.visorHaloFlash : visorHaloMat;
    const targetArmor = active ? mats.armorHitFlash : armorMat;
    for (const m of armorMeshes) {
      m.material = targetArmor;
    }
  };

  const setDeathFade = (opacity: number): void => {
    const a = Math.max(0, Math.min(1, opacity));
    if (!fadeClones) {
      hitFlashOn = false;
      const fArmor = armorMat.clone();
      fArmor.transparent = true;
      fArmor.depthWrite = false;
      const fRimStrength = { value: ARMOR_FRESNEL_K[faction] };
      applyArmorFresnel(fArmor, factionGlowHex, fRimStrength);
      const fTrim = edgeTrimMat.clone();
      fTrim.transparent = true;
      fTrim.depthWrite = false;
      const fGlow = glowMat.clone();
      fGlow.transparent = true;
      fGlow.depthWrite = false;
      const fLine = edgeLineMat.clone();
      fLine.transparent = true;
      const fHalo = visorHaloMat.clone();
      fHalo.transparent = true;
      fHalo.depthWrite = false;
      fadeClones = [fArmor, fTrim, fGlow, fLine, fHalo];
      fadeRimStrength = fRimStrength;

      for (const m of bodyMeshes) {
        m.material = m.material === edgeTrimMat ? fTrim : fArmor;
      }
      for (const m of glowMeshes) {
        m.material = fGlow;
      }
      for (const ls of edgeLines) {
        ls.material = fLine;
      }
      visorHalo.material = fHalo;
    }
    const [fArmor, fTrim, fGlow, fLine, fHalo] = fadeClones as [
      THREE.MeshStandardMaterial,
      THREE.MeshStandardMaterial,
      THREE.MeshStandardMaterial,
      THREE.LineBasicMaterial,
      THREE.SpriteMaterial,
    ];
    fArmor.opacity = a;
    fArmor.emissiveIntensity = ARMOR_EMISSIVE_INTENSITY * a;
    if (fadeRimStrength) fadeRimStrength.value = ARMOR_FRESNEL_K[faction] * a;
    fTrim.opacity = a;
    fTrim.emissiveIntensity = 0.55 * a;
    fGlow.opacity = a;
    fGlow.emissiveIntensity = 0.45 * a;
    fLine.opacity = 0.62 * a;
    fHalo.opacity = VISOR_HALO_OPACITY * a;
  };

  const dispose = (): void => {
    muzzleMat.dispose();
    if (fadeClones) {
      for (const m of fadeClones) m.dispose();
      fadeClones = null;
      fadeRimStrength = null;
    }
  };

  return {
    root,
    faction,
    joints: {
      bodyPivot,
      torsoPivot,
      headPivot,
      shoulderL,
      elbowL,
      shoulderR,
      elbowR,
      weaponMount,
      hipL,
      kneeL,
      ankleL,
      hipR,
      kneeR,
      ankleR,
    },
    visorMesh,
    visorHalo,
    glowMeshes,
    edgeLines,
    bodyMeshes,
    headTopAnchor,
    muzzleAnchor,
    muzzleMesh,
    muzzleMat,
    soleProbeL,
    soleProbeR,
    triangleCount: geos.totalTris,
    setHitFlash,
    setDeathFade,
    dispose,
  };
}

/** Dispose all cached shared robot geometries and materials (used on full engine teardown). */
export function disposeRobotCache(): void {
  if (cachedGeometries) {
    const g = cachedGeometries;
    g.pelvis.dispose();
    g.torsoArmor.dispose();
    g.torsoEdgeTrim.dispose();
    g.torsoEdgeLine.dispose();
    g.torsoGlow.dispose();
    g.headArmor.dispose();
    g.headEdgeLine.dispose();
    g.headVisor.dispose();
    g.upperArmL.dispose();
    g.upperArmR.dispose();
    g.forearmL.dispose();
    g.forearmR.dispose();
    g.weaponBody.dispose();
    g.weaponGlow.dispose();
    g.thighL.dispose();
    g.thighR.dispose();
    g.shinL.dispose();
    g.shinR.dispose();
    g.foot.dispose();
    g.muzzleQuad.dispose();
    cachedGeometries = null;
  }
  if (cachedMaterials) {
    const m = cachedMaterials;
    m.armor.enemy.dispose();
    m.armor.ally.dispose();
    m.armorHitFlash.dispose();
    m.glow.enemy.dispose();
    m.glow.ally.dispose();
    m.edgeTrim.enemy.dispose();
    m.edgeTrim.ally.dispose();
    m.edgeLine.enemy.dispose();
    m.edgeLine.ally.dispose();
    m.visorFlash.dispose();
    m.visorHalo.enemy.dispose();
    m.visorHalo.ally.dispose();
    m.visorHaloFlash.dispose();
    m.visorGlowTex.dispose();
    m.flashTex.dispose();
    cachedMaterials = null;
  }
}

/** Export exact single-robot triangle count for diagnostics/tests. */
export function getRobotTriangleCount(): number {
  return getGeometries().totalTris;
}
