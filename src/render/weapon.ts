// First-person weapon view — strictly 2 articulated weapons:
//   1. ASSAULT RIFLE (primary): 30-rd curved mag, charging handle, 1.10s reload, 0.35s swap
//   2. M134 GATLING (swap): 6-barrel rotating cluster w/ high-speed spin blur,
//      300-rd cylindrical drum + 3-segment swinging brass ammo belt, 3.2s drum-swap
//      reload with dangling belt, 0.45s heavy swap.
// All motions run frame-rate independently through src/render/tween.ts.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PALETTE } from './palette';
import { getMaterial } from './materials';
import type { MaterialKind } from './materials';
import type { ReloadSnapshot, WeaponId } from '../game/weapons';
import { MuzzleFlashRig, type VfxTelemetry } from './vfx';
import {
  clamp01,
  damp,
  easeInCubic,
  easeInOutCubic,
  easeOutBack,
  easeOutCubic,
  lerp,
  pulse,
  segment,
} from './tween';

type GunId = WeaponId;
type MatKey = 'metal' | 'poly' | 'mag' | 'edge' | 'glove' | 'cuff' | 'brass' | 'accent';

const std = (kind: MaterialKind, emissiveIntensity: number): THREE.MeshStandardMaterial => {
  const m = (getMaterial(kind) as THREE.MeshStandardMaterial).clone();
  m.emissive.copy(m.color);
  m.emissiveIntensity = emissiveIntensity;
  return m;
};

const MAT: Record<MatKey, THREE.Material> & {
  dropMag: THREE.MeshStandardMaterial;
  dropEdge: THREE.MeshBasicMaterial;
  dropAccent: THREE.MeshStandardMaterial;
  barrelBlur: THREE.MeshBasicMaterial;
} = {
  metal: (() => {
    const m = std('gunMetal', 0.10);
    m.metalness = 0.82;
    m.roughness = 0.30;
    m.envMapIntensity = 1.65;
    return m;
  })(),
  poly: std('gunPoly', 0.12),
  mag: std('gunMag', 0.16),
  edge: getMaterial('gunEdge'),
  glove: std('glove', 0.16),
  cuff: std('rail', 0.12),
  brass: new THREE.MeshStandardMaterial({
    color: PALETTE.brass,
    emissive: PALETTE.brass,
    emissiveIntensity: 0.20,
    metalness: 0.88,
    roughness: 0.24,
  }),
  accent: new THREE.MeshStandardMaterial({
    color: PALETTE.gatlingAccent,
    emissive: PALETTE.gatlingAccent,
    emissiveIntensity: 0.22,
    metalness: 0.35,
    roughness: 0.45,
  }),
  dropMag: (() => {
    const m = std('gunMag', 0.16);
    m.transparent = true;
    m.opacity = 1;
    return m;
  })(),
  dropEdge: new THREE.MeshBasicMaterial({
    color: PALETTE.gunHi,
    transparent: true,
    opacity: 1,
  }),
  dropAccent: new THREE.MeshStandardMaterial({
    color: PALETTE.gatlingAccent,
    emissive: PALETTE.gatlingAccent,
    emissiveIntensity: 0.22,
    metalness: 0.35,
    roughness: 0.45,
    transparent: true,
    opacity: 1,
  }),
  barrelBlur: new THREE.MeshBasicMaterial({
    color: PALETTE.gatlingBlur,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  }),
};

interface Part {
  mat: MatKey;
  geo: THREE.BufferGeometry;
}

type Parts = Part[];

const place = (
  geo: THREE.BufferGeometry,
  x = 0,
  y = 0,
  z = 0,
  rx = 0,
  ry = 0,
  rz = 0,
): THREE.BufferGeometry => {
  if (rx) geo.rotateX(rx);
  if (ry) geo.rotateY(ry);
  if (rz) geo.rotateZ(rz);
  geo.translate(x, y, z);
  return geo;
};

const box = (
  p: Parts,
  mat: MatKey,
  w: number,
  h: number,
  d: number,
  x = 0,
  y = 0,
  z = 0,
  rx = 0,
  ry = 0,
  rz = 0,
): void => {
  p.push({ mat, geo: place(new THREE.BoxGeometry(w, h, d), x, y, z, rx, ry, rz) });
};

/** Cylinder with its axis along the gun (z). rTop is at the rear (+z). */
const cylZ = (
  p: Parts,
  mat: MatKey,
  r: number,
  len: number,
  x = 0,
  y = 0,
  z = 0,
  seg = 12,
  rBottom = r,
): void => {
  const geo = new THREE.CylinderGeometry(r, rBottom, len, seg);
  geo.rotateX(Math.PI / 2);
  p.push({ mat, geo: place(geo, x, y, z) });
};

/** Cylinder with its axis along X (e.g. horizontal drum / carry bar). */
const cylX = (
  p: Parts,
  mat: MatKey,
  r: number,
  len: number,
  x = 0,
  y = 0,
  z = 0,
  seg = 12,
): void => {
  const geo = new THREE.CylinderGeometry(r, r, len, seg);
  geo.rotateZ(Math.PI / 2);
  p.push({ mat, geo: place(geo, x, y, z) });
};

const extrudeZY = (
  p: Parts,
  mat: MatKey,
  pts: [number, number][],
  thickness: number,
  bevel = 0.0015,
): void => {
  const shape = new THREE.Shape();
  pts.forEach(([z, y], i) => {
    if (i === 0) shape.moveTo(-z, y);
    else shape.lineTo(-z, y);
  });
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
  });
  geo.rotateY(Math.PI / 2);
  geo.translate(-thickness / 2, 0, 0);
  p.push({ mat, geo });
};

function mergeParts(
  parts: Parts,
  group: THREE.Group,
  matOverride?: Partial<Record<MatKey, THREE.Material>>,
): void {
  const byMat = new Map<MatKey, THREE.BufferGeometry[]>();
  for (const { mat, geo } of parts) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const list = byMat.get(mat);
    if (list) list.push(g);
    else byMat.set(mat, [g]);
  }
  for (const [mat, geos] of byMat) {
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, matOverride?.[mat] ?? MAT[mat]);
    mesh.frustumCulled = false;
    group.add(mesh);
  }
}

function addRail(p: Parts, z0: number, z1: number, y: number): void {
  const len = z1 - z0;
  box(p, 'metal', 0.034, 0.007, len, 0, y, (z0 + z1) / 2);
  const n = Math.floor(len / 0.023);
  for (let i = 0; i <= n; i++) {
    box(p, 'metal', 0.036, 0.005, 0.006, 0, y + 0.0055, z0 + 0.012 + i * 0.023);
  }
  box(p, 'edge', 0.0035, 0.0035, len - 0.01, -0.0165, y + 0.0055, (z0 + z1) / 2);
}

function addHandguard(p: Parts, zFront: number, zRear: number, r: number, y = 0): void {
  const len = zRear - zFront;
  const geo = new THREE.CylinderGeometry(r, r, len, 8);
  geo.rotateX(Math.PI / 2);
  geo.rotateZ(Math.PI / 8);
  p.push({ mat: 'poly', geo: place(geo, 0, y, (zFront + zRear) / 2) });
  const n = Math.floor((len - 0.06) / 0.038);
  for (let i = 0; i < n; i++) {
    box(
      p,
      'mag',
      0.003,
      0.010,
      0.020,
      -0.0168,
      y + 0.0168,
      zRear - 0.05 - i * 0.038,
      0,
      0,
      Math.PI / 4,
    );
  }
  cylZ(p, 'metal', r + 0.002, 0.009, 0, y, zFront + 0.005, 8);
}

function addMuzzleDevice(p: Parts, z: number): void {
  cylZ(p, 'metal', 0.0115, 0.048, 0, 0, z, 12);
  for (let i = 0; i < 3; i++) cylZ(p, 'metal', 0.0132, 0.005, 0, 0, z + 0.014 - i * 0.014, 12);
}

function addSights(p: Parts, rearZ: number, frontZ: number, railTop: number): void {
  box(p, 'metal', 0.028, 0.011, 0.028, 0, railTop + 0.007, rearZ);
  box(p, 'metal', 0.004, 0.020, 0.006, -0.011, railTop + 0.02, rearZ - 0.004);
  box(p, 'metal', 0.004, 0.020, 0.006, 0.011, railTop + 0.02, rearZ - 0.004);
  box(p, 'metal', 0.026, 0.004, 0.005, 0, railTop + 0.028, rearZ - 0.004);
  box(p, 'metal', 0.026, 0.011, 0.026, 0, railTop + 0.007, frontZ);
  box(p, 'metal', 0.004, 0.016, 0.005, 0, railTop + 0.02, frontZ);
  box(p, 'metal', 0.004, 0.012, 0.012, -0.0105, railTop + 0.016, frontZ);
  box(p, 'metal', 0.004, 0.012, 0.012, 0.0105, railTop + 0.016, frontZ);
}

function addTriggerGroup(p: Parts, z: number, yBase: number): void {
  box(p, 'metal', 0.0025, 0.014, 0.034, -0.009, yBase - 0.014, z);
  box(p, 'metal', 0.0025, 0.014, 0.034, 0.009, yBase - 0.014, z);
  box(p, 'metal', 0.018, 0.003, 0.034, 0, yBase - 0.022, z);
  box(p, 'mag', 0.005, 0.017, 0.006, 0, yBase - 0.009, z + 0.006, -0.18, 0, 0);
}

function addGrip(p: Parts, zRear: number, yTop: number): void {
  extrudeZY(
    p,
    'poly',
    [
      [zRear - 0.038, yTop],
      [zRear, yTop],
      [zRear + 0.008, yTop - 0.078],
      [zRear - 0.022, yTop - 0.086],
      [zRear - 0.036, yTop - 0.03],
    ],
    0.028,
  );
}

/** Curved box magazine built around local origin (top seated face at y=0, z=0). */
function buildMagGroup(
  depth = 0.115,
  withTopRound = false,
  fadeable = false,
): THREE.Group {
  const g = new THREE.Group();
  const p: Parts = [];
  extrudeZY(
    p,
    'mag',
    [
      [0.020, 0.015],
      [-0.024, 0.015],
      [-0.042, -depth * 0.55],
      [-0.034, -depth],
      [0.004, -depth - 0.008],
      [0.026, -depth * 0.7],
    ],
    0.027,
    0.0014,
  );
  box(p, 'mag', 0.031, 0.010, 0.056, 0, -depth - 0.006, -0.010, -0.16, 0, 0);
  box(p, 'edge', 0.032, 0.004, 0.056, 0, -depth - 0.010, -0.010, -0.16, 0, 0);
  box(p, 'edge', 0.003, depth * 0.72, 0.008, -0.0145, -depth * 0.45, -0.016, 0.16, 0, 0);
  if (withTopRound) {
    cylZ(p, 'brass', 0.0055, 0.038, -0.004, 0.018, -0.002, 8);
    cylZ(p, 'brass', 0.0055, 0.038, 0.005, 0.015, -0.002, 8);
  }
  mergeParts(
    p,
    g,
    fadeable ? { mag: MAT.dropMag, edge: MAT.dropEdge } : undefined,
  );
  return g;
}

/** 300-round heavy Gatling cylindrical ammo drum (local origin at drum center). */
function buildGatlingDrumGroup(fadeable = false): THREE.Group {
  const g = new THREE.Group();
  const p: Parts = [];
  // Main ribbed steel drum cylinder oriented vertically/slightly angled
  const body = new THREE.CylinderGeometry(0.068, 0.068, 0.125, 16);
  p.push({ mat: 'mag', geo: body });
  // Top & bottom reinforcement rims
  const topRim = new THREE.CylinderGeometry(0.072, 0.072, 0.014, 16);
  p.push({ mat: 'edge', geo: place(topRim, 0, 0.058, 0) });
  const botRim = new THREE.CylinderGeometry(0.072, 0.072, 0.014, 16);
  p.push({ mat: 'edge', geo: place(botRim, 0, -0.058, 0) });
  // Amber 300-RD tactical caution stripe band around mid drum
  const stripe = new THREE.CylinderGeometry(0.0705, 0.0705, 0.022, 16);
  p.push({ mat: 'accent', geo: place(stripe, 0, 0.006, 0) });
  // Top brass feed mouth
  box(p, 'metal', 0.036, 0.022, 0.044, 0.024, 0.070, 0);
  cylZ(p, 'brass', 0.0055, 0.042, 0.018, 0.076, 0, 8);
  cylZ(p, 'brass', 0.0055, 0.042, 0.030, 0.076, 0, 8);
  mergeParts(
    p,
    g,
    fadeable
      ? { mag: MAT.dropMag, edge: MAT.dropEdge, accent: MAT.dropAccent, metal: MAT.dropMag }
      : undefined,
  );
  return g;
}

/** One articulated 4-round brass cartridge segment for the Gatling hanging ammo belt. */
function buildBeltSegment(): THREE.Group {
  const g = new THREE.Group();
  const p: Parts = [];
  // Segment extends from y = 0 downward to y = -0.048 (4 linked 7.62 rounds)
  for (let i = 0; i < 4; i++) {
    const y = -0.006 - i * 0.012;
    // Brass cartridge body + tapered bullet tip pointing forward (-Z)
    cylZ(p, 'brass', 0.0048, 0.038, 0, y, 0.002, 8);
    cylZ(p, 'brass', 0.0045, 0.014, 0, y, -0.023, 8, 0.0014);
    // Dark disintegrating steel belt link clasp
    box(p, 'mag', 0.012, 0.007, 0.014, 0, y, 0.004);
  }
  mergeParts(p, g);
  return g;
}

/** Temporary right/left arm placeholders (replaced by realistic 5-finger hands in next commit). */
function addRightArm(p: Parts): void {
  box(p, 'glove', 0.024, 0.060, 0.038, 0.024, -0.060, 0.106, 0.28, 0, 0);
  box(p, 'glove', 0.032, 0.018, 0.034, 0.007, -0.028, 0.096);
  for (let i = 0; i < 3; i++) {
    box(p, 'glove', 0.017, 0.014, 0.016, -0.009, -0.043 - i * 0.018, 0.076 + i * 0.003, 0.45, 0, 0);
  }
  box(p, 'glove', 0.013, 0.010, 0.026, -0.008, -0.031, 0.084, 0, 0.3, 0);
  box(p, 'glove', 0.008, 0.010, 0.022, -0.005, -0.036, 0.060);
  box(p, 'cuff', 0.058, 0.052, 0.030, 0.042, -0.096, 0.128, 0.5, 0.42, 0);
  box(p, 'glove', 0.058, 0.052, 0.20, 0.075, -0.155, 0.225, 0.62, 0.45, 0);
}

function buildLeftArmGroup(): THREE.Group {
  const g = new THREE.Group();
  const p: Parts = [];
  box(p, 'glove', 0.050, 0.026, 0.076, -0.002, -0.010, 0);
  box(p, 'glove', 0.016, 0.032, 0.072, -0.022, 0.009, 0);
  box(p, 'edge', 0.0035, 0.007, 0.058, -0.030, 0.020, 0);
  for (let i = 0; i < 4; i++) {
    box(p, 'glove', 0.025, 0.010, 0.014, -0.007, 0.029, 0.025 - i * 0.017, 0, 0, 0.22);
  }
  box(p, 'glove', 0.013, 0.011, 0.030, 0.018, 0.006, 0.010, 0, -0.15, 0);

  const addLimb = (
    mat: MatKey,
    a: [number, number, number],
    b: [number, number, number],
    w: number,
    h: number,
  ) => {
    const va = new THREE.Vector3(...a);
    const vb = new THREE.Vector3(...b);
    const dir = vb.clone().sub(va);
    const len = dir.length();
    const mid = va.clone().add(vb).multiplyScalar(0.5);
    const geo = new THREE.BoxGeometry(w, h, len);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.normalize());
    geo.applyMatrix4(new THREE.Matrix4().compose(mid, q, new THREE.Vector3(1, 1, 1)));
    p.push({ mat, geo });
  };
  addLimb('cuff', [-0.016, -0.016, 0.040], [-0.046, -0.032, 0.072], 0.054, 0.048);
  addLimb('glove', [-0.044, -0.031, 0.070], [-0.265, -0.145, 0.285], 0.054, 0.048);

  mergeParts(p, g);
  return g;
}

// --- shared silhouette pieces -------------------------------------------------

const RECEIVER_PROFILE: [number, number][] = [
  [0.14, 0.032],
  [-0.09, 0.032],
  [-0.106, 0.02],
  [-0.106, -0.02],
  [-0.012, -0.02],
  [-0.008, -0.055],
  [0.03, -0.055],
  [0.042, -0.022],
  [0.1, -0.022],
  [0.14, -0.014],
];

const STOCK_PROFILE: [number, number][] = [
  [0.142, 0.028],
  [0.3, 0.011],
  [0.336, -0.005],
  [0.336, -0.062],
  [0.296, -0.052],
  [0.236, -0.026],
  [0.166, -0.02],
  [0.142, -0.006],
];

function addReceiver(p: Parts): void {
  extrudeZY(p, 'metal', RECEIVER_PROFILE, 0.04, 0.002);
  box(p, 'mag', 0.002, 0.013, 0.048, 0.0208, 0.006, 0.012);
  box(p, 'mag', 0.002, 0.01, 0.016, -0.0208, -0.002, 0.034);
}

function addStock(p: Parts, cheek = 0.012): void {
  extrudeZY(p, 'poly', STOCK_PROFILE, 0.036, 0.002);
  box(p, 'poly', 0.03, cheek, 0.085, 0, 0.03 + cheek * 0.4, 0.19, -0.05, 0, 0);
  box(p, 'poly', 0.039, 0.072, 0.01, 0, -0.028, 0.341, -0.05, 0, 0);
}

interface ArticulatedGun {
  root: THREE.Group;
  muzzleZ: number;
  muzzleY: number;
  ejectPos: THREE.Vector3;
  baseOffset: THREE.Vector3;
  leftArm: THREE.Group;
  leftRestPos: THREE.Vector3;
  /** seated magazine / drum on receiver */
  mag: THREE.Group | null;
  magRestPos: THREE.Vector3;
  /** fading dropped magazine / drum */
  dropMag: THREE.Group | null;
  /** fresh magazine / drum carried by leftArm during insert */
  heldMag: THREE.Group | null;
  /** charging handle / bolt / feed tray cover */
  bolt: THREE.Group;
  boltRestPos: THREE.Vector3;
  /** Gatling 6-barrel rotating cluster */
  barrelCluster: THREE.Group | null;
  /** Gatling translucent motion-blur cylinder for high-RPM spin */
  barrelBlurMesh: THREE.Mesh | null;
  /** Gatling 3-segment hanging brass ammo belt (chained parent->child) */
  beltSegs: THREE.Group[];
  beltAnchor: THREE.Group | null;
}

function buildRifleModel(): ArticulatedGun {
  const root = new THREE.Group();
  const body: Parts = [];
  addReceiver(body);
  addRail(body, -0.385, 0.115, 0.036);
  addHandguard(body, -0.395, -0.105, 0.024, 0.002);
  cylZ(body, 'metal', 0.0085, 0.16, 0, 0.002, -0.477);
  box(body, 'metal', 0.02, 0.02, 0.026, 0, 0.008, -0.46);
  cylZ(body, 'metal', 0.0035, 0.055, 0, 0.0175, -0.435, 6);
  addMuzzleDevice(body, -0.578);
  addStock(body);
  addGrip(body, 0.098, -0.02);
  addTriggerGroup(body, 0.058, -0.024);
  addSights(body, 0.098, -0.385, 0.044);
  addRightArm(body);
  mergeParts(body, root);

  const bolt = new THREE.Group();
  const boltParts: Parts = [];
  box(boltParts, 'metal', 0.036, 0.008, 0.024, 0, 0, 0);
  box(boltParts, 'edge', 0.018, 0.009, 0.012, -0.024, -0.012, -0.115);
  box(boltParts, 'edge', 0.005, 0.012, 0.042, 0.021, -0.022, -0.120);
  mergeParts(boltParts, bolt);
  const boltRestPos = new THREE.Vector3(0, 0.030, 0.132);
  bolt.position.copy(boltRestPos);
  root.add(bolt);

  const magRestPos = new THREE.Vector3(0, -0.052, 0.011);
  const mag = buildMagGroup(0.115, false, false);
  mag.position.copy(magRestPos);
  root.add(mag);

  const dropMag = buildMagGroup(0.115, false, true);
  dropMag.position.copy(magRestPos);
  dropMag.visible = false;
  root.add(dropMag);

  const leftArm = buildLeftArmGroup();
  const leftRestPos = new THREE.Vector3(0, -0.024, -0.26);
  leftArm.position.copy(leftRestPos);
  const heldMag = buildMagGroup(0.115, true, false);
  heldMag.position.set(0.016, 0.082, -0.008);
  heldMag.visible = false;
  leftArm.add(heldMag);
  root.add(leftArm);

  return {
    root,
    muzzleZ: -0.604,
    muzzleY: 0.012,
    ejectPos: new THREE.Vector3(0.028, 0.008, 0.012),
    baseOffset: new THREE.Vector3(0, 0, 0),
    leftArm,
    leftRestPos,
    mag,
    magRestPos,
    dropMag,
    heldMag,
    bolt,
    boltRestPos,
    barrelCluster: null,
    barrelBlurMesh: null,
    beltSegs: [],
    beltAnchor: null,
  };
}

/**
 * M134 Gatling Minigun:
 * - 6 rotating steel barrels arranged in a 60° hex cluster + 3 barrel clamp rings
 * - Additive high-RPM radial spin blur sleeve around the barrel ring
 * - Heavy electric drive motor housing + top chainsaw support bar + rear spade grip
 * - Visible lower-left 300-round cylindrical drum + 3-segment swinging brass ammo belt
 */
function buildGatlingModel(): ArticulatedGun {
  const root = new THREE.Group();
  const body: Parts = [];

  // Heavy cylindrical breech housing & drive motor
  cylZ(body, 'metal', 0.056, 0.24, 0, -0.005, 0.01, 14);
  cylZ(body, 'mag', 0.044, 0.14, 0, 0.042, 0.06, 12); // top electric motor pod
  box(body, 'edge', 0.008, 0.014, 0.13, -0.046, 0.042, 0.06); // motor cooling rib highlight
  box(body, 'accent', 0.010, 0.016, 0.085, -0.056, 0.002, 0.01); // amber hazard badge on housing

  // Left-side ammo feed chute housing (receives the swinging brass belt!)
  box(body, 'metal', 0.042, 0.036, 0.072, -0.058, -0.018, -0.030, 0, 0, 0.22);
  box(body, 'edge', 0.044, 0.006, 0.074, -0.058, 0.002, -0.030, 0, 0, 0.22);

  // Right-side brass casing ejection chute
  box(body, 'mag', 0.024, 0.022, 0.058, 0.056, -0.012, -0.015);

  // Top chainsaw-style carry & support bar (front & rear stanchions + knurled cross-bar)
  box(body, 'metal', 0.012, 0.076, 0.018, -0.038, 0.062, -0.155, 0, 0, -0.16);
  box(body, 'metal', 0.012, 0.076, 0.018, 0.038, 0.062, -0.155, 0, 0, 0.16);
  cylX(body, 'poly', 0.013, 0.098, 0, 0.098, -0.155, 10);
  // Support bridge rail running back to motor housing
  box(body, 'metal', 0.026, 0.012, 0.17, 0, 0.096, -0.075);
  box(body, 'edge', 0.006, 0.005, 0.16, -0.012, 0.103, -0.075);

  // Rear spade trigger handle + safety guard
  box(body, 'metal', 0.014, 0.062, 0.018, -0.036, 0.005, 0.148);
  box(body, 'metal', 0.014, 0.062, 0.018, 0.036, 0.005, 0.148);
  cylX(body, 'poly', 0.013, 0.088, 0, 0.034, 0.148, 10);
  box(body, 'accent', 0.018, 0.012, 0.016, 0.014, 0.022, 0.148); // red-amber rotary trigger button
  // Lower rear grip frame
  addGrip(body, 0.132, -0.035);
  addRightArm(body);
  mergeParts(body, root);

  // --- 6 Rotating Barrels + 3 Perforated Clamp Rings ---
  const barrelCluster = new THREE.Group();
  barrelCluster.position.set(0, -0.006, -0.11);
  const bParts: Parts = [];
  const BARREL_RING_R = 0.034;
  const BARREL_LEN = 0.54;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const bx = Math.cos(a) * BARREL_RING_R;
    const by = Math.sin(a) * BARREL_RING_R;
    // Steel barrel tube
    cylZ(bParts, 'metal', 0.0085, BARREL_LEN, bx, by, -BARREL_LEN * 0.5, 10);
    // Bright chamfered muzzle crown ring on every single barrel so all 6 count cleanly
    cylZ(bParts, 'edge', 0.0098, 0.014, bx, by, -BARREL_LEN + 0.007, 10);
    // Dark bore hole plug at tip
    cylZ(bParts, 'mag', 0.0052, 0.006, bx, by, -BARREL_LEN - 0.001, 8);
  }
  // Central drive rotor shaft
  cylZ(bParts, 'mag', 0.014, BARREL_LEN - 0.04, 0, 0, -BARREL_LEN * 0.48, 10);
  // 3 Heavy Barrel Clamp Rings (rear, middle, front flash clamp)
  for (const cz of [-0.07, -0.27, -0.47]) {
    cylZ(bParts, 'metal', BARREL_RING_R + 0.013, 0.022, 0, 0, cz, 18);
    cylZ(bParts, 'edge', BARREL_RING_R + 0.0145, 0.006, 0, 0, cz - 0.009, 18);
  }
  // Amber heat-warning band on mid clamp
  cylZ(bParts, 'accent', BARREL_RING_R + 0.014, 0.008, 0, 0, -0.27, 18);
  mergeParts(bParts, barrelCluster);

  // Translucent radial spin-blur cylinder (becomes visible as barrel RPM climbs)
  const blurGeo = new THREE.CylinderGeometry(
    BARREL_RING_R + 0.012,
    BARREL_RING_R + 0.012,
    BARREL_LEN * 0.88,
    20,
    1,
    true,
  );
  blurGeo.rotateX(Math.PI / 2);
  blurGeo.translate(0, 0, -BARREL_LEN * 0.5);
  const barrelBlurMesh = new THREE.Mesh(blurGeo, MAT.barrelBlur);
  barrelBlurMesh.frustumCulled = false;
  barrelBlurMesh.visible = false;
  barrelCluster.add(barrelBlurMesh);
  root.add(barrelCluster);

  // Hinged top feed-tray cover (flips open during 3.2s drum reload!)
  const bolt = new THREE.Group();
  const coverParts: Parts = [];
  box(coverParts, 'metal', 0.056, 0.012, 0.088, 0, 0, 0);
  box(coverParts, 'accent', 0.016, 0.006, 0.030, -0.016, 0.008, 0);
  mergeParts(coverParts, bolt);
  const boltRestPos = new THREE.Vector3(-0.045, 0.012, -0.032);
  bolt.position.copy(boltRestPos);
  root.add(bolt);

  // --- 300-Round Cylindrical Ammo Drum (mounted visibly on lower-left flank!) ---
  const magRestPos = new THREE.Vector3(-0.115, -0.105, -0.055);
  const mag = buildGatlingDrumGroup(false);
  mag.position.copy(magRestPos);
  mag.rotation.set(0.08, 0.18, 0.16);
  root.add(mag);

  const dropMag = buildGatlingDrumGroup(true);
  dropMag.position.copy(magRestPos);
  dropMag.visible = false;
  root.add(dropMag);

  // --- 3-Segment Articulated Hanging Brass Ammo Belt (sways & feeds continuously!) ---
  const beltAnchor = new THREE.Group();
  beltAnchor.position.set(-0.072, -0.014, -0.034);
  root.add(beltAnchor);

  const beltSegs: THREE.Group[] = [];
  let beltParent: THREE.Group = beltAnchor;
  for (let i = 0; i < 3; i++) {
    const seg = buildBeltSegment();
    if (i > 0) seg.position.set(0, -0.046, 0);
    beltParent.add(seg);
    beltSegs.push(seg);
    beltParent = seg;
  }

  // Left support hand gripping the top chainsaw carry bar
  const leftArm = buildLeftArmGroup();
  const leftRestPos = new THREE.Vector3(-0.012, 0.076, -0.155);
  leftArm.position.copy(leftRestPos);
  const heldMag = buildGatlingDrumGroup(false);
  heldMag.position.set(0.025, 0.085, -0.010);
  heldMag.visible = false;
  leftArm.add(heldMag);
  root.add(leftArm);

  return {
    root,
    muzzleZ: -0.665,
    muzzleY: -0.006,
    ejectPos: new THREE.Vector3(0.070, -0.012, -0.015),
    baseOffset: new THREE.Vector3(-0.025, -0.045, 0.035),
    leftArm,
    leftRestPos,
    mag,
    magRestPos,
    dropMag,
    heldMag,
    bolt,
    boltRestPos,
    barrelCluster,
    barrelBlurMesh,
    beltSegs,
    beltAnchor,
  };
}

function buildArticulated(id: GunId): ArticulatedGun {
  return id === 'rifle' ? buildRifleModel() : buildGatlingModel();
}

export interface WeaponAnimDebug {
  reloadActive: boolean;
  reloadElapsedMs: number;
  reloadDurationMs: number;
  magDetached: boolean;
  newMagInHand: boolean;
  swapActive: boolean;
  gatlingSpin: number;
  gatlingBarrelAngle: number;
}

export class WeaponView {
  readonly group = new THREE.Group();
  readonly muzzleRig = new MuzzleFlashRig();
  private guns = new Map<GunId, ArticulatedGun>();
  private kick = 0;
  private kickDur = 0.11;
  private kickDeg = 2.5;
  private time = 0;
  private current: GunId = 'rifle';

  // Weight-aware weapon swap state (0.35s rifle / 0.45s gatling)
  private swapActive = false;
  private swapElapsed = 0;
  private swapDuration = 0.35;
  private swapPending: GunId | null = null;
  private swapDropY = 0;
  private swapDropPitch = 0;
  private bobX = 0;
  private bobY = 0;

  // Gatling rotary state
  private barrelAngle = 0;
  private beltSwayPhase = 0;

  // Reload visual blend (smoothly decays back to 0 if reload ends early — zero snap)
  private reloadBlend = 0;
  private reloadGunPos = new THREE.Vector3();
  private reloadGunRot = new THREE.Euler();
  private reloadSightDipRad = 0;

  /** Read-only telemetry for e2e & screenshot inspection */
  readonly animDebug: WeaponAnimDebug = {
    reloadActive: false,
    reloadElapsedMs: 0,
    reloadDurationMs: 0,
    magDetached: false,
    newMagInHand: false,
    swapActive: false,
    gatlingSpin: 0,
    gatlingBarrelAngle: 0,
  };

  private readonly basePos = new THREE.Vector3(0.27, -0.265, -0.5);
  private readonly baseRot = new THREE.Euler(0.11, 0.075, 0);

  constructor() {
    for (const id of ['rifle', 'gatling'] as GunId[]) {
      const gun = buildArticulated(id);
      gun.root.visible = id === this.current;
      this.guns.set(id, gun);
      this.group.add(gun.root);
    }
    const g = this.guns.get(this.current)!;
    this.muzzleRig.group.position.set(0, g.muzzleY, g.muzzleZ);
    this.group.add(this.muzzleRig.group);

    this.group.position.copy(this.basePos);
    this.group.rotation.copy(this.baseRot);
  }

  /** Instant switch (match start / respawn). */
  setWeapon(id: GunId): void {
    this.swapActive = false;
    this.swapPending = null;
    this.swapElapsed = 0;
    this.swapDropY = 0;
    this.swapDropPitch = 0;
    this.resetReloadPose(this.guns.get(this.current)!);
    if (id !== this.current) {
      this.guns.get(this.current)!.root.visible = false;
      this.guns.get(id)!.root.visible = true;
      this.current = id;
    }
    const g = this.guns.get(this.current)!;
    this.resetReloadPose(g);
    this.muzzleRig.group.position.set(0, g.muzzleY, g.muzzleZ);
    this.kick = 0;
    this.reloadBlend = 0;
    this.reloadSightDipRad = 0;
  }

  /** Smooth swap: rifle = 0.35s, gatling = 0.45s (heavier draw feel). */
  startSwap(id: GunId, durationSec?: number): void {
    if (id === this.current && !this.swapActive) return;
    this.swapPending = id;
    const dur = durationSec ?? (id === 'gatling' ? 0.45 : 0.35);
    if (!this.swapActive) {
      this.swapDuration = dur;
      this.swapActive = true;
      this.swapElapsed = 0;
    } else if (this.swapElapsed >= this.swapDuration * 0.5) {
      const remainingRise =
        1 - (this.swapElapsed - this.swapDuration * 0.5) / (this.swapDuration * 0.5);
      this.swapDuration = dur;
      this.swapElapsed = remainingRise * this.swapDuration * 0.5;
    }
  }

  get swapBlurAmount(): number {
    if (!this.swapActive) return 0;
    const u = clamp01(this.swapElapsed / this.swapDuration);
    return Math.sin(u * Math.PI) * 0.65;
  }

  /** Subtle additive camera pitch dip during reload (never locks player look). */
  get reloadPitchDip(): number {
    return this.reloadSightDipRad;
  }

  onFire(id: GunId = this.current): void {
    this.kick = 1;
    this.kickDur = id === 'gatling' ? 0.055 : 0.11;
    this.kickDeg = id === 'gatling' ? 0.42 : 2.5;
    this.muzzleRig.trigger(id);
  }

  /** World-space muzzle tip. */
  muzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    this.group.updateWorldMatrix(true, false);
    return this.muzzleRig.group.getWorldPosition(out);
  }

  /** World-space ejection port position for brass shell spawning. */
  ejectWorld(out: THREE.Vector3): THREE.Vector3 {
    const gun = this.guns.get(this.current)!;
    gun.root.updateWorldMatrix(true, false);
    out.copy(gun.ejectPos);
    return gun.root.localToWorld(out);
  }

  private resetReloadPose(gun: ArticulatedGun): void {
    gun.leftArm.position.copy(gun.leftRestPos);
    gun.leftArm.rotation.set(0, 0, 0);
    if (gun.mag) {
      gun.mag.visible = true;
      gun.mag.position.copy(gun.magRestPos);
      if (this.current === 'gatling') gun.mag.rotation.set(0.08, 0.18, 0.16);
      else gun.mag.rotation.set(0, 0, 0);
    }
    if (gun.dropMag) {
      gun.dropMag.visible = false;
      gun.dropMag.position.copy(gun.magRestPos);
      gun.dropMag.rotation.set(0, 0, 0);
    }
    if (gun.heldMag) gun.heldMag.visible = false;
    gun.bolt.position.copy(gun.boltRestPos);
    gun.bolt.rotation.set(0, 0, 0);
    MAT.dropMag.opacity = 1;
    MAT.dropEdge.opacity = 1;
    MAT.dropAccent.opacity = 1;
  }

  /** Rifle reload timeline (1.10s total). */
  private applyRifleReload(gun: ArticulatedGun, elapsedMs: number): void {
    const t = elapsedMs;
    const enter = segment(t, 0, 140, easeInOutCubic);
    const exit = segment(t, 760, 960, easeInOutCubic);
    const poseW = enter * (1 - exit);

    const slapKick =
      pulse(t, 660, 700, 760, easeOutCubic, easeOutCubic) * ((1.5 * Math.PI) / 180);
    const magBump = pulse(t, 510, 545, 600, easeOutCubic, easeInOutCubic);

    this.reloadGunPos.set(
      lerp(0, -0.075, poseW),
      lerp(0, 0.058, poseW) + magBump * 0.014,
      lerp(0, -0.105, poseW) + slapKick * 0.45,
    );
    this.reloadGunRot.set(
      lerp(0, -0.16, poseW) + slapKick + magBump * 0.022,
      lerp(0, 0.30, poseW),
      lerp(0, -(2.2 * Math.PI) / 180, poseW) - slapKick * 0.35,
    );
    this.reloadSightDipRad = -(1.6 * Math.PI) / 180 * poseW;

    const magSeated = t < 100 || t >= 560;
    if (gun.mag) {
      gun.mag.visible = magSeated;
      gun.mag.position.copy(gun.magRestPos);
      if (t >= 560 && t < 610) {
        const settle = segment(t, 560, 610, easeOutCubic);
        gun.mag.position.y = gun.magRestPos.y + (1 - settle) * 0.008;
      }
    }

    const dropVisible = t >= 100 && t < 275;
    if (gun.dropMag) {
      gun.dropMag.visible = dropVisible;
      if (dropVisible) {
        const u = clamp01((t - 100) / 165);
        const dropEase = easeInCubic(u);
        const pullInitial = segment(t, 100, 155, easeOutCubic);
        gun.dropMag.position.set(
          gun.magRestPos.x - 0.16 * dropEase,
          gun.magRestPos.y - 0.065 * pullInitial - 0.24 * dropEase,
          gun.magRestPos.z + 0.025 * u,
        );
        const sway = Math.sin(u * Math.PI * 2.1) * 0.22;
        gun.dropMag.rotation.set(0.28 * dropEase, 0.12 * u, 0.32 * dropEase + sway);
        const fade = 1 - segment(t, 175, 275, easeInOutCubic);
        MAT.dropMag.opacity = fade;
        MAT.dropEdge.opacity = fade;
      }
    }

    const rest = gun.leftRestPos;
    const gripMag = { x: -0.026, y: -0.145, z: 0.008, rx: 0.18, ry: 0.12, rz: 0.24 };
    const stripMag = { x: -0.075, y: -0.215, z: 0.015, rx: 0.24, ry: 0.18, rz: 0.32 };
    const pouchLow = { x: -0.255, y: -0.275, z: 0.045, rx: 0.32, ry: 0.25, rz: 0.38 };
    const readyNew = { x: -0.072, y: -0.195, z: 0.018, rx: 0.14, ry: 0.14, rz: 0.18 };
    const alignWell = { x: -0.016, y: -0.175, z: 0.019, rx: 0.06, ry: 0.05, rz: 0.10 };
    const seatWell = { x: -0.016, y: -0.134, z: 0.019, rx: 0.04, ry: 0.02, rz: 0.08 };
    const boltFwd = { x: -0.055, y: 0.012, z: -0.005, rx: -0.18, ry: 0.22, rz: -0.14 };
    const boltBack = { x: -0.055, y: 0.010, z: 0.065, rx: -0.14, ry: 0.20, rz: -0.10 };

    let hx = rest.x, hy = rest.y, hz = rest.z, hrx = 0, hry = 0, hrz = 0;

    if (t < 110) {
      const u = segment(t, 0, 110, easeInOutCubic);
      hx = lerp(rest.x, gripMag.x, u); hy = lerp(rest.y, gripMag.y, u); hz = lerp(rest.z, gripMag.z, u);
      hrx = lerp(0, gripMag.rx, u); hry = lerp(0, gripMag.ry, u); hrz = lerp(0, gripMag.rz, u);
    } else if (t < 200) {
      const u = segment(t, 110, 200, easeOutCubic);
      hx = lerp(gripMag.x, stripMag.x, u); hy = lerp(gripMag.y, stripMag.y, u); hz = lerp(gripMag.z, stripMag.z, u);
      hrx = lerp(gripMag.rx, stripMag.rx, u); hry = lerp(gripMag.ry, stripMag.ry, u); hrz = lerp(gripMag.rz, stripMag.rz, u);
    } else if (t < 250) {
      const u = segment(t, 200, 250, easeInOutCubic);
      hx = lerp(stripMag.x, pouchLow.x, u); hy = lerp(stripMag.y, pouchLow.y, u); hz = lerp(stripMag.z, pouchLow.z, u);
      hrx = lerp(stripMag.rx, pouchLow.rx, u); hry = lerp(stripMag.ry, pouchLow.ry, u); hrz = lerp(stripMag.rz, pouchLow.rz, u);
    } else if (t < 330) {
      const u = segment(t, 250, 330, easeInOutCubic);
      hx = lerp(pouchLow.x, readyNew.x, u); hy = lerp(pouchLow.y, readyNew.y, u); hz = lerp(pouchLow.z, readyNew.z, u);
      hrx = lerp(pouchLow.rx, readyNew.rx, u); hry = lerp(pouchLow.ry, readyNew.ry, u); hrz = lerp(pouchLow.rz, readyNew.rz, u);
    } else if (t < 430) {
      const u = segment(t, 330, 430, easeInOutCubic);
      hx = lerp(readyNew.x, alignWell.x, u); hy = lerp(readyNew.y, alignWell.y, u); hz = lerp(readyNew.z, alignWell.z, u);
      hrx = lerp(readyNew.rx, alignWell.rx, u); hry = lerp(readyNew.ry, alignWell.ry, u); hrz = lerp(readyNew.rz, alignWell.rz, u);
    } else if (t < 560) {
      const pushU = segment(t, 430, 520, easeInOutCubic);
      const seatBack = t >= 520 ? easeOutBack(clamp01((t - 520) / 40), 2.4) : 0;
      const pushTotal = t < 520 ? pushU * 0.85 : 0.85 + seatBack * 0.15;
      hx = lerp(alignWell.x, seatWell.x, pushTotal); hy = lerp(alignWell.y, seatWell.y, pushTotal); hz = lerp(alignWell.z, seatWell.z, pushTotal);
      hrx = lerp(alignWell.rx, seatWell.rx, clamp01(pushTotal)); hry = lerp(alignWell.ry, seatWell.ry, clamp01(pushTotal)); hrz = lerp(alignWell.rz, seatWell.rz, clamp01(pushTotal));
    } else if (t < 630) {
      const u = segment(t, 560, 630, easeInOutCubic);
      hx = lerp(seatWell.x, boltFwd.x, u); hy = lerp(seatWell.y, boltFwd.y, u); hz = lerp(seatWell.z, boltFwd.z, u);
      hrx = lerp(seatWell.rx, boltFwd.rx, u); hry = lerp(seatWell.ry, boltFwd.ry, u); hrz = lerp(seatWell.rz, boltFwd.rz, u);
    } else if (t < 700) {
      const u = segment(t, 630, 700, easeOutCubic);
      hx = lerp(boltFwd.x, boltBack.x, u); hy = lerp(boltFwd.y, boltBack.y, u); hz = lerp(boltFwd.z, boltBack.z, u);
      hrx = lerp(boltFwd.rx, boltBack.rx, u); hry = lerp(boltFwd.ry, boltBack.ry, u); hrz = lerp(boltFwd.rz, boltBack.rz, u);
    } else if (t < 760) {
      const u = segment(t, 700, 760, easeOutCubic);
      hx = lerp(boltBack.x, boltFwd.x, u); hy = lerp(boltBack.y, boltFwd.y, u); hz = lerp(boltBack.z, boltFwd.z, u);
      hrx = lerp(boltBack.rx, boltFwd.rx, u); hry = lerp(boltBack.ry, boltFwd.ry, u); hrz = lerp(boltBack.rz, boltFwd.rz, u);
    } else {
      const u = segment(t, 760, 960, easeInOutCubic);
      hx = lerp(boltFwd.x, rest.x, u); hy = lerp(boltFwd.y, rest.y, u); hz = lerp(boltFwd.z, rest.z, u);
      hrx = lerp(boltFwd.rx, 0, u); hry = lerp(boltFwd.ry, 0, u); hrz = lerp(boltFwd.rz, 0, u);
    }

    gun.leftArm.position.set(hx, hy, hz);
    gun.leftArm.rotation.set(hrx, hry, hrz);

    const carryingFresh = t >= 250 && t < 560;
    if (gun.heldMag) gun.heldMag.visible = carryingFresh;

    const boltPull = pulse(t, 630, 700, 760, easeOutCubic, easeOutCubic);
    gun.bolt.position.set(gun.boltRestPos.x, gun.boltRestPos.y, gun.boltRestPos.z + boltPull * 0.068);

    this.animDebug.magDetached = !magSeated;
    this.animDebug.newMagInHand = carryingFresh;
  }

  /**
   * Gatling 3.2s drum-swap reload with dangling ammo belt:
   * - 0..450ms: tilt right, flip open feed-tray cover, left hand leaves carry bar → drum latch; belt unhooks & dangles
   * - 450..1050ms: old 300-round drum unlocks & drops downward-left fading out
   * - 1050..1850ms: left hand hauls fresh heavy drum up from lower-left
   * - 1850..2400ms: slam drum home (easeOutBack) + thread fresh brass ammo belt into feed chute
   * - 2400..2850ms: close feed-tray cover & quick barrel index
   * - 2850..3200ms: left hand returns to top carry bar, gun levels
   */
  private applyGatlingReload(gun: ArticulatedGun, elapsedMs: number): number {
    const t = elapsedMs;
    const enter = segment(t, 0, 420, easeInOutCubic);
    const exit = segment(t, 2820, 3200, easeInOutCubic);
    const poseW = enter * (1 - exit);

    const drumSlam = pulse(t, 2120, 2240, 2400, easeOutCubic, easeInOutCubic);
    const coverSlap = pulse(t, 2550, 2650, 2820, easeOutCubic, easeOutCubic);

    this.reloadGunPos.set(
      lerp(0, 0.035, poseW),
      lerp(0, -0.025, poseW) + drumSlam * 0.018 - coverSlap * 0.010,
      lerp(0, -0.045, poseW),
    );
    this.reloadGunRot.set(
      lerp(0, -0.11, poseW) + drumSlam * 0.035 - coverSlap * 0.025,
      lerp(0, 0.24, poseW),
      lerp(0, -0.22, poseW),
    );
    this.reloadSightDipRad = -(2.0 * Math.PI) / 180 * poseW;

    // Feed-tray cover opens 200..2650ms
    const coverOpen =
      segment(t, 180, 440, easeInOutCubic) * (1 - segment(t, 2480, 2700, easeOutBack));
    gun.bolt.rotation.z = coverOpen * 1.25;

    // Old drum seated before 480ms and fresh drum seated after 2220ms
    const drumSeated = t < 480 || t >= 2220;
    if (gun.mag) {
      gun.mag.visible = drumSeated;
      gun.mag.position.copy(gun.magRestPos);
      if (t >= 2220 && t < 2360) {
        const s = segment(t, 2220, 2360, easeOutCubic);
        gun.mag.position.y = gun.magRestPos.y + (1 - s) * 0.014;
      }
    }

    const dropVisible = t >= 480 && t < 1100;
    if (gun.dropMag) {
      gun.dropMag.visible = dropVisible;
      if (dropVisible) {
        const u = clamp01((t - 480) / 620);
        const dropE = easeInCubic(u);
        gun.dropMag.position.set(
          gun.magRestPos.x - 0.14 * dropE,
          gun.magRestPos.y - 0.34 * dropE,
          gun.magRestPos.z + 0.04 * u,
        );
        gun.dropMag.rotation.set(0.08 + 0.4 * dropE, 0.18, 0.16 + 0.55 * dropE);
        const fade = 1 - segment(t, 760, 1100, easeInOutCubic);
        MAT.dropMag.opacity = fade;
        MAT.dropEdge.opacity = fade;
        MAT.dropAccent.opacity = fade;
      }
    }

    // Left arm path for heavy drum swap
    const rest = gun.leftRestPos;
    const drumGrip = { x: -0.14, y: -0.14, z: -0.04 };
    const lowFetch = { x: -0.28, y: -0.34, z: 0.05 };
    const alignDrum = { x: -0.14, y: -0.23, z: -0.05 };
    const seatDrum = { x: -0.14, y: -0.155, z: -0.05 };
    const feedBelt = { x: -0.08, y: 0.025, z: -0.03 };

    let hx = rest.x, hy = rest.y, hz = rest.z;
    if (t < 480) {
      const u = segment(t, 0, 480, easeInOutCubic);
      hx = lerp(rest.x, drumGrip.x, u); hy = lerp(rest.y, drumGrip.y, u); hz = lerp(rest.z, drumGrip.z, u);
    } else if (t < 1050) {
      const u = segment(t, 480, 1050, easeInOutCubic);
      hx = lerp(drumGrip.x, lowFetch.x, u); hy = lerp(drumGrip.y, lowFetch.y, u); hz = lerp(drumGrip.z, lowFetch.z, u);
    } else if (t < 1850) {
      const u = segment(t, 1050, 1850, easeInOutCubic);
      hx = lerp(lowFetch.x, alignDrum.x, u); hy = lerp(lowFetch.y, alignDrum.y, u); hz = lerp(lowFetch.z, alignDrum.z, u);
    } else if (t < 2220) {
      const u = easeOutBack(clamp01((t - 1850) / 370), 1.5);
      hx = lerp(alignDrum.x, seatDrum.x, u); hy = lerp(alignDrum.y, seatDrum.y, u); hz = lerp(alignDrum.z, seatDrum.z, u);
    } else if (t < 2680) {
      const u = segment(t, 2220, 2680, easeInOutCubic);
      hx = lerp(seatDrum.x, feedBelt.x, u); hy = lerp(seatDrum.y, feedBelt.y, u); hz = lerp(seatDrum.z, feedBelt.z, u);
    } else {
      const u = segment(t, 2680, 3150, easeInOutCubic);
      hx = lerp(feedBelt.x, rest.x, u); hy = lerp(feedBelt.y, rest.y, u); hz = lerp(feedBelt.z, rest.z, u);
    }
    gun.leftArm.position.set(hx, hy, hz);
    gun.leftArm.rotation.set(poseW * 0.14, 0, poseW * 0.18);

    const carryingFresh = t >= 1050 && t < 2220;
    if (gun.heldMag) gun.heldMag.visible = carryingFresh;

    this.animDebug.magDetached = !drumSeated;
    this.animDebug.newMagInHand = carryingFresh;

    // Return belt dangle factor [0..1] (dangles loose while drum is out 350..2350ms!)
    return segment(t, 320, 560, easeOutCubic) * (1 - segment(t, 2180, 2500, easeInOutCubic));
  }

  update(
    dt: number,
    bob?: { x: number; y: number },
    reload?: ReloadSnapshot,
    telemetry?: VfxTelemetry,
    gatlingState?: { spinLevel: number; firing: boolean },
  ): void {
    this.time += dt;
    if (this.kick > 0) this.kick = Math.max(0, this.kick - dt / Math.max(0.03, this.kickDur));
    const k = easeOutCubic(this.kick);
    const kickScale = this.kickDeg / 2.5;

    this.bobX = damp(this.bobX, (bob?.x ?? 0) * 0.85, 14, dt);
    this.bobY = damp(this.bobY, (bob?.y ?? 0) * 0.75, 14, dt);

    // Weight-aware weapon swap arc (0.35s rifle / 0.45s gatling)
    if (this.swapActive) {
      const half = this.swapDuration * 0.5;
      const prev = this.swapElapsed;
      this.swapElapsed = Math.min(this.swapDuration, this.swapElapsed + dt);
      if (prev < half && this.swapElapsed >= half && this.swapPending) {
        this.resetReloadPose(this.guns.get(this.current)!);
        this.guns.get(this.current)!.root.visible = false;
        this.current = this.swapPending;
        const nextGun = this.guns.get(this.current)!;
        nextGun.root.visible = true;
        this.resetReloadPose(nextGun);
        this.muzzleRig.group.position.set(0, nextGun.muzzleY, nextGun.muzzleZ);
        this.kick = 0;
        this.reloadBlend = 0;
        this.swapPending = null;
      }
      const dropAmp = this.current === 'gatling' || this.swapPending === 'gatling' ? 0.42 : 0.36;
      if (this.swapElapsed < half) {
        const u = easeInCubic(this.swapElapsed / half);
        this.swapDropY = -dropAmp * u;
        this.swapDropPitch = -0.52 * u;
      } else {
        const u = clamp01((this.swapElapsed - half) / half);
        const rise = 1 - easeOutBack(u, 0.85);
        this.swapDropY = -dropAmp * rise;
        this.swapDropPitch = -0.52 * rise;
      }
      if (this.swapElapsed >= this.swapDuration) {
        this.swapActive = false;
        this.swapDropY = 0;
        this.swapDropPitch = 0;
      }
    }

    const gun = this.guns.get(this.current)!;
    const isReloading = Boolean(reload?.active) && !this.swapActive;
    this.animDebug.reloadActive = isReloading;
    this.animDebug.reloadElapsedMs = isReloading ? reload!.elapsedMs : 0;
    this.animDebug.reloadDurationMs = isReloading ? reload!.durationMs : 0;
    this.animDebug.swapActive = this.swapActive;

    let beltDangle = 0;
    if (isReloading && reload) {
      this.reloadBlend = damp(this.reloadBlend, 1, 28, dt);
      if (this.current === 'rifle') {
        this.applyRifleReload(gun, reload.elapsedMs);
      } else {
        beltDangle = this.applyGatlingReload(gun, reload.elapsedMs);
      }
    } else {
      this.animDebug.magDetached = false;
      this.animDebug.newMagInHand = false;
      this.reloadBlend = damp(this.reloadBlend, 0, 18, dt);
      this.reloadSightDipRad = damp(this.reloadSightDipRad, 0, 18, dt);
      gun.leftArm.position.lerp(gun.leftRestPos, 1 - Math.exp(-18 * dt));
      gun.leftArm.rotation.x = damp(gun.leftArm.rotation.x, 0, 18, dt);
      gun.leftArm.rotation.y = damp(gun.leftArm.rotation.y, 0, 18, dt);
      gun.leftArm.rotation.z = damp(gun.leftArm.rotation.z, 0, 18, dt);
      gun.bolt.position.lerp(gun.boltRestPos, 1 - Math.exp(-18 * dt));
      gun.bolt.rotation.z = damp(gun.bolt.rotation.z, 0, 18, dt);
      if (gun.mag) {
        gun.mag.visible = true;
        gun.mag.position.lerp(gun.magRestPos, 1 - Math.exp(-22 * dt));
      }
      if (gun.dropMag) gun.dropMag.visible = false;
      if (gun.heldMag) gun.heldMag.visible = false;
      if (this.reloadBlend < 0.002) {
        this.reloadBlend = 0;
        this.reloadGunPos.set(0, 0, 0);
        this.reloadGunRot.set(0, 0, 0);
      }
    }

    // --- Gatling 6-barrel rotation, spin blur, & 3-segment swinging brass ammo belt ---
    const spin = this.current === 'gatling' ? clamp01(gatlingState?.spinLevel ?? 0) : 0;
    const gatFiring = this.current === 'gatling' && Boolean(gatlingState?.firing);
    this.animDebug.gatlingSpin = spin;
    if (gun.barrelCluster) {
      // Spin speed climbs smoothly to ~40 rad/s at full 900 RPM
      const omega = spin * (gatFiring ? 42 : 28);
      this.barrelAngle = (this.barrelAngle + omega * dt) % (Math.PI * 2);
      gun.barrelCluster.rotation.z = this.barrelAngle;
      this.animDebug.gatlingBarrelAngle = this.barrelAngle;
      if (gun.barrelBlurMesh) {
        const blurAlpha = spin > 0.25 ? clamp01((spin - 0.25) / 0.75) * (gatFiring ? 0.36 : 0.22) : 0;
        gun.barrelBlurMesh.visible = blurAlpha > 0.01;
        MAT.barrelBlur.opacity = blurAlpha;
      }
    }

    if (gun.beltSegs.length === 3) {
      this.beltSwayPhase += dt * (gatFiring ? 26 : 3.8);
      const bobSwing = (bob?.x ?? 0) * 18;
      const fireChatter = gatFiring ? Math.sin(this.beltSwayPhase) * 0.09 : 0;
      const idleSway = Math.sin(this.time * 2.4) * 0.045;
      // Normal catenary loop from feed chute down & curving into the drum mouth:
      // During reload (beltDangle→1), unhooks and hangs straight down swinging loosely!
      const s0Rest = -0.52;
      const s1Rest = 0.36;
      const s2Rest = 0.44;
      const dangleSway = beltDangle * Math.sin(this.time * 7.5) * 0.18;
      gun.beltSegs[0].rotation.z = lerp(s0Rest, -0.08, beltDangle) + bobSwing * 0.35 + idleSway + fireChatter + dangleSway;
      gun.beltSegs[1].rotation.z = lerp(s1Rest, 0.06, beltDangle) + bobSwing * 0.55 - fireChatter * 1.25 + dangleSway * 1.3;
      gun.beltSegs[2].rotation.z = lerp(s2Rest, 0.04, beltDangle) + bobSwing * 0.75 + fireChatter * 1.4 - dangleSway * 0.9;
      gun.beltSegs[0].rotation.x = Math.sin(this.time * 3.1) * 0.04 + (gatFiring ? 0.06 : 0);
      gun.beltSegs[1].rotation.x = Math.cos(this.time * 3.1) * 0.05;
    }

    const breathe = Math.sin(this.time * 1.7) * 0.002;
    const sway = Math.sin(this.time * 1.15) * 0.0015;
    // High-frequency chassis vibration while gatling fires
    const gatVibX = gatFiring ? Math.sin(this.time * 52) * 0.0024 : spin > 0.1 ? Math.sin(this.time * 34) * 0.0008 * spin : 0;
    const gatVibY = gatFiring ? Math.cos(this.time * 47) * 0.0020 : 0;
    let px = this.basePos.x + gun.baseOffset.x;
    const cam = this.group.parent as THREE.PerspectiveCamera | null;
    if (cam?.isPerspectiveCamera) {
      const halfW =
        Math.tan((cam.fov * Math.PI) / 360) * Math.abs(this.basePos.z) * cam.aspect;
      px = Math.min(px, Math.max(0.11, halfW * 0.7));
    }

    const rb = this.reloadBlend;
    this.group.position.set(
      px + sway + this.bobX + gatVibX + this.reloadGunPos.x * rb,
      this.basePos.y + gun.baseOffset.y - k * 0.018 * Math.min(2.2, kickScale) + breathe + this.bobY + gatVibY + this.swapDropY + this.reloadGunPos.y * rb,
      this.basePos.z + gun.baseOffset.z + k * 0.058 * Math.min(2.2, kickScale) + this.reloadGunPos.z * rb,
    );
    this.group.rotation.set(
      this.baseRot.x + k * 0.075 * Math.min(2.4, kickScale) + breathe * 0.6 + this.swapDropPitch + this.reloadGunRot.x * rb,
      this.baseRot.y + sway * 0.5 + this.reloadGunRot.y * rb,
      this.baseRot.z + this.reloadGunRot.z * rb,
    );

    this.muzzleRig.update(dt, telemetry);
  }
}
