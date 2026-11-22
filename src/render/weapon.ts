// First-person weapon view — strictly 2 articulated weapons (ASSAULT RIFLE +
// M134 GATLING) paired with realistic 5-finger articulated low-poly human hands
// (src/render/hands.ts, <= 1200 tris/hand, 6 draw calls total for both hands).
//
// Rifle reload (1.10s, exact 6-stage Spec A choreography):
//   ① 0–140ms    Left hand opens fingers (0–12°) releasing handguard → moves below magwell
//   ② 140–340ms  Thumb presses mag release; old mag drops, left hand catches & sweeps out
//   ③ 340–520ms  Left hand draws fresh brass-topped mag from belt (open cupped palm in view)
//   ④ 520–740ms  Fresh mag aligns & pushes into magwell (palm follows) → thumb confirms seat
//   ⑤ 740–920ms  Left hand returns to handguard; RIGHT hand leaves grip (index off trigger,
//                palm turns sideways) to rack charging handle
//   ⑥ 920–1040ms Return to ready stance (+60ms settle tail in final-100ms fire window)
//
// Hand-gun minimum clearance is checked across all keyframes (>= 2cm).

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PALETTE } from './palette';
import { getMaterial } from './materials';
import type { MaterialKind } from './materials';
import type { ReloadSnapshot, WeaponId } from '../game/weapons';
import { MuzzleFlashRig, type VfxTelemetry } from './vfx';
import {
  HumanHand,
  HAND_POSES,
  lerpHandPose,
  minClearanceToGun,
  type HandPose,
  type LocalBox,
} from './hands';
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
type MatKey = 'metal' | 'poly' | 'mag' | 'edge' | 'brass' | 'accent';

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
  const body = new THREE.CylinderGeometry(0.068, 0.068, 0.125, 16);
  p.push({ mat: 'mag', geo: body });
  const topRim = new THREE.CylinderGeometry(0.072, 0.072, 0.014, 16);
  p.push({ mat: 'edge', geo: place(topRim, 0, 0.058, 0) });
  const botRim = new THREE.CylinderGeometry(0.072, 0.072, 0.014, 16);
  p.push({ mat: 'edge', geo: place(botRim, 0, -0.058, 0) });
  const stripe = new THREE.CylinderGeometry(0.0705, 0.0705, 0.022, 16);
  p.push({ mat: 'accent', geo: place(stripe, 0, 0.006, 0) });
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
  for (let i = 0; i < 4; i++) {
    const y = -0.006 - i * 0.012;
    cylZ(p, 'brass', 0.0048, 0.038, 0, y, 0.002, 8);
    cylZ(p, 'brass', 0.0045, 0.014, 0, y, -0.023, 8, 0.0014);
    box(p, 'mag', 0.012, 0.007, 0.014, 0, y, 0.004);
  }
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

/** Gun body AABBs used for non-clipping clearance checks (>= 2cm). */
const RIFLE_BODY_BOXES: readonly LocalBox[] = [
  { minX: -0.020, maxX: 0.020, minY: -0.022, maxY: 0.038, minZ: -0.106, maxZ: 0.140 }, // receiver
  { minX: -0.024, maxX: 0.024, minY: -0.022, maxY: 0.026, minZ: -0.395, maxZ: -0.105 }, // handguard
  { minX: -0.014, maxX: 0.014, minY: -0.106, maxY: -0.020, minZ: 0.060, maxZ: 0.106 }, // grip
  { minX: -0.016, maxX: 0.016, minY: -0.055, maxY: -0.020, minZ: -0.012, maxZ: 0.030 }, // magwell
];

const GATLING_BODY_BOXES: readonly LocalBox[] = [
  { minX: -0.056, maxX: 0.056, minY: -0.060, maxY: 0.050, minZ: -0.110, maxZ: 0.130 }, // drive housing
  { minX: -0.044, maxX: 0.044, minY: -0.048, maxY: 0.040, minZ: -0.650, maxZ: -0.110 }, // barrel cluster
];

interface TransformPose {
  x: number;
  y: number;
  z: number;
  rx: number;
  ry: number;
  rz: number;
}

interface ArticulatedGun {
  root: THREE.Group;
  muzzleZ: number;
  muzzleY: number;
  ejectPos: THREE.Vector3;
  baseOffset: THREE.Vector3;
  bodyBoxes: readonly LocalBox[];
  leftRest: TransformPose;
  rightRest: TransformPose;
  leftRestPose: HandPose;
  rightRestPose: HandPose;
  leftElbow: THREE.Vector3;
  rightElbow: THREE.Vector3;
  /** seated magazine / drum on receiver */
  mag: THREE.Group | null;
  magRestPos: THREE.Vector3;
  /** fading dropped magazine / drum */
  dropMag: THREE.Group | null;
  /** fresh magazine / drum moved cleanly in gun space synced to left hand */
  freshMag: THREE.Group | null;
  /** charging handle / bolt / feed tray cover */
  bolt: THREE.Group;
  boltRestPos: THREE.Vector3;
  /** Gatling 6-barrel rotating cluster */
  barrelCluster: THREE.Group | null;
  barrelBlurMesh: THREE.Mesh | null;
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
  mergeParts(body, root);

  // Charging handle + right-side bolt knob so right-hand rack (Stage ⑤) reads crisply
  const bolt = new THREE.Group();
  const boltParts: Parts = [];
  box(boltParts, 'metal', 0.038, 0.008, 0.024, 0, 0, 0);
  box(boltParts, 'edge', 0.022, 0.009, 0.014, 0.024, 0.002, 0.002); // right-side charging latch ear
  box(boltParts, 'edge', 0.005, 0.012, 0.042, 0.021, -0.022, -0.120); // chrome bolt carrier face
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

  const freshMag = buildMagGroup(0.115, true, false);
  freshMag.position.copy(magRestPos);
  freshMag.visible = false;
  root.add(freshMag);

  return {
    root,
    muzzleZ: -0.604,
    muzzleY: 0.012,
    ejectPos: new THREE.Vector3(0.028, 0.008, 0.012),
    baseOffset: new THREE.Vector3(0, 0, 0),
    bodyBoxes: RIFLE_BODY_BOXES,
    // Left palm cradles underside-left of handguard (dist to handguard >= 2.6cm)
    leftRest: { x: -0.038, y: -0.048, z: -0.250, rx: 0.18, ry: 0.24, rz: 1.95 },
    // Right palm holds right flank of pistol grip (dist to grip >= 2.4cm)
    rightRest: { x: 0.038, y: -0.064, z: 0.094, rx: 0.28, ry: -0.16, rz: -1.42 },
    leftRestPose: HAND_POSES.rifleLeftRest,
    rightRestPose: HAND_POSES.rifleRightRest,
    leftElbow: new THREE.Vector3(-0.34, -0.24, 0.28),
    rightElbow: new THREE.Vector3(0.24, -0.24, 0.42),
    mag,
    magRestPos,
    dropMag,
    freshMag,
    bolt,
    boltRestPos,
    barrelCluster: null,
    barrelBlurMesh: null,
    beltSegs: [],
    beltAnchor: null,
  };
}

function buildGatlingModel(): ArticulatedGun {
  const root = new THREE.Group();
  const body: Parts = [];

  cylZ(body, 'metal', 0.056, 0.24, 0, -0.005, 0.01, 14);
  cylZ(body, 'mag', 0.044, 0.14, 0, 0.042, 0.06, 12);
  box(body, 'edge', 0.008, 0.014, 0.13, -0.046, 0.042, 0.06);
  box(body, 'accent', 0.010, 0.016, 0.085, -0.056, 0.002, 0.01);

  // Left-side ammo feed chute
  box(body, 'metal', 0.042, 0.036, 0.072, -0.058, -0.018, -0.030, 0, 0, 0.22);
  box(body, 'edge', 0.044, 0.006, 0.074, -0.058, 0.002, -0.030, 0, 0, 0.22);
  // Right-side casing ejection chute
  box(body, 'mag', 0.024, 0.022, 0.058, 0.056, -0.012, -0.015);

  // Top chainsaw carry bar (positioned slightly forward so left arm never blocks the brass ammo belt!)
  box(body, 'metal', 0.012, 0.076, 0.018, -0.038, 0.062, -0.215, 0, 0, -0.16);
  box(body, 'metal', 0.012, 0.076, 0.018, 0.038, 0.062, -0.215, 0, 0, 0.16);
  cylX(body, 'poly', 0.013, 0.098, 0, 0.098, -0.215, 10);
  box(body, 'metal', 0.026, 0.012, 0.22, 0, 0.096, -0.105);
  box(body, 'edge', 0.006, 0.005, 0.21, -0.012, 0.103, -0.105);

  // Rear spade trigger handle + lower pistol grip
  box(body, 'metal', 0.014, 0.062, 0.018, -0.036, 0.005, 0.148);
  box(body, 'metal', 0.014, 0.062, 0.018, 0.036, 0.005, 0.148);
  cylX(body, 'poly', 0.013, 0.088, 0, 0.034, 0.148, 10);
  box(body, 'accent', 0.018, 0.012, 0.016, 0.014, 0.022, 0.148);
  addGrip(body, 0.132, -0.035);
  mergeParts(body, root);

  // --- 6 Rotating Barrels + 3 Clamp Rings (chunky iconic silhouette) ---
  const barrelCluster = new THREE.Group();
  barrelCluster.position.set(0, -0.004, -0.11);
  const bParts: Parts = [];
  const BARREL_RING_R = 0.038;
  const BARREL_LEN = 0.56;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const bx = Math.cos(a) * BARREL_RING_R;
    const by = Math.sin(a) * BARREL_RING_R;
    cylZ(bParts, 'metal', 0.0096, BARREL_LEN, bx, by, -BARREL_LEN * 0.5, 10);
    cylZ(bParts, 'edge', 0.0110, 0.016, bx, by, -BARREL_LEN + 0.008, 10);
    cylZ(bParts, 'mag', 0.0058, 0.006, bx, by, -BARREL_LEN - 0.001, 8);
  }
  cylZ(bParts, 'mag', 0.015, BARREL_LEN - 0.04, 0, 0, -BARREL_LEN * 0.48, 10);
  for (const cz of [-0.08, -0.29, -0.49]) {
    cylZ(bParts, 'metal', BARREL_RING_R + 0.014, 0.024, 0, 0, cz, 18);
    cylZ(bParts, 'edge', BARREL_RING_R + 0.0155, 0.006, 0, 0, cz - 0.009, 18);
  }
  cylZ(bParts, 'accent', BARREL_RING_R + 0.015, 0.009, 0, 0, -0.29, 18);
  mergeParts(bParts, barrelCluster);

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

  // Feed tray cover
  const bolt = new THREE.Group();
  const coverParts: Parts = [];
  box(coverParts, 'metal', 0.056, 0.012, 0.088, 0, 0, 0);
  box(coverParts, 'accent', 0.016, 0.006, 0.030, -0.016, 0.008, 0);
  mergeParts(coverParts, bolt);
  const boltRestPos = new THREE.Vector3(-0.045, 0.012, -0.032);
  bolt.position.copy(boltRestPos);
  root.add(bolt);

  // 300-round cylindrical drum (positioned forward-left so drum + gleaming brass belt sit unobscured in view!)
  const magRestPos = new THREE.Vector3(-0.125, -0.092, -0.145);
  const mag = buildGatlingDrumGroup(false);
  mag.position.copy(magRestPos);
  mag.rotation.set(0.08, 0.22, 0.16);
  root.add(mag);

  const dropMag = buildGatlingDrumGroup(true);
  dropMag.position.copy(magRestPos);
  dropMag.visible = false;
  root.add(dropMag);

  const freshMag = buildGatlingDrumGroup(false);
  freshMag.position.copy(magRestPos);
  freshMag.visible = false;
  root.add(freshMag);

  // 3-segment swinging brass ammo belt curving cleanly from feed chute down into the drum mouth
  const beltAnchor = new THREE.Group();
  beltAnchor.position.set(-0.074, 0.014, -0.095);
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

  return {
    root,
    muzzleZ: -0.685,
    muzzleY: -0.004,
    ejectPos: new THREE.Vector3(0.070, -0.012, -0.015),
    baseOffset: new THREE.Vector3(-0.018, -0.015, 0.055),
    bodyBoxes: GATLING_BODY_BOXES,
    // Left hand grips top chainsaw carry handle cleanly forward & clear of brass belt
    leftRest: { x: -0.014, y: 0.122, z: -0.205, rx: 0.14, ry: -0.18, rz: 0.16 },
    // Right hand holds rear pistol/spade grip
    rightRest: { x: 0.046, y: -0.068, z: 0.132, rx: 0.26, ry: -0.14, rz: -1.42 },
    leftRestPose: HAND_POSES.gatlingLeftRest,
    rightRestPose: HAND_POSES.gatlingRightRest,
    leftElbow: new THREE.Vector3(-0.46, -0.18, 0.14),
    rightElbow: new THREE.Vector3(0.26, -0.22, 0.44),
    mag,
    magRestPos,
    dropMag,
    freshMag,
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

function lerpTransform(a: TransformPose, b: TransformPose, t: number): TransformPose {
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    z: lerp(a.z, b.z, t),
    rx: lerp(a.rx, b.rx, t),
    ry: lerp(a.ry, b.ry, t),
    rz: lerp(a.rz, b.rz, t),
  };
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

export interface HandsTelemetry {
  leftTris: number;
  rightTris: number;
  totalTris: number;
  minClearanceM: number;
  leftIndexCurlDeg: number;
  rightIndexCurlDeg: number;
  reloadStage: number;
}

export interface ViewmodelScreenRect {
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
}

const BOX_FACES: readonly [number, number, number, number][] = [
  [0, 1, 2, 3],
  [4, 5, 6, 7],
  [0, 1, 5, 4],
  [2, 3, 7, 6],
  [0, 3, 7, 4],
  [1, 2, 6, 5],
];

const CLIP_PLANES: readonly ((v: THREE.Vector4) => number)[] = [
  (v) => v.x + v.w, // x >= -w
  (v) => v.w - v.x, // x <= w
  (v) => v.y + v.w, // y >= -w
  (v) => v.w - v.y, // y <= w
  (v) => v.z + v.w, // z >= -w
  (v) => v.w - v.z, // z <= w
];

function clipClipSpacePoly(verts: THREE.Vector4[]): THREE.Vector4[] {
  let poly = verts;
  for (const plane of CLIP_PLANES) {
    if (poly.length === 0) return [];
    const out: THREE.Vector4[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const da = plane(a);
      const db = plane(b);
      if (da >= 0) out.push(a);
      if ((da >= 0) !== (db >= 0)) {
        const t = da / (da - db);
        out.push(
          new THREE.Vector4(
            a.x + (b.x - a.x) * t,
            a.y + (b.y - a.y) * t,
            a.z + (b.z - a.z) * t,
            a.w + (b.w - a.w) * t,
          ),
        );
      }
    }
    poly = out;
  }
  return poly;
}

export class WeaponView {
  readonly group = new THREE.Group();
  readonly muzzleRig = new MuzzleFlashRig();
  readonly leftHand: HumanHand;
  readonly rightHand: HumanHand;

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

  // Reload visual blend
  private reloadBlend = 0;
  private reloadGunPos = new THREE.Vector3();
  private reloadGunRot = new THREE.Euler();
  private reloadSightDipRad = 0;

  // Scratch pose & vector objects (no per-frame GC churn)
  private leftPoseScratch: HandPose = lerpHandPose(HAND_POSES.rifleLeftRest, HAND_POSES.rifleLeftRest, 0);
  private rightPoseScratch: HandPose = lerpHandPose(HAND_POSES.rifleRightRest, HAND_POSES.rifleRightRest, 0);
  private clearanceVec = new THREE.Vector3();

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

  readonly handsTelemetry: HandsTelemetry;

  private readonly basePos = new THREE.Vector3(0.27, -0.265, -0.5);
  private readonly baseRot = new THREE.Euler(0.11, 0.075, 0);
  // Portrait (aspect < 1) viewmodel framing: scaled 0.76× (spec 0.74–0.80) and tucked
  // slightly inward/down/forward so the projected Box3 clears the right action buttons
  // (x+w ≤ 340), stays within 0.22–0.42× viewport height, and never intrudes on the
  // 120px crosshair center circle. Landscape stays fixed at scale 1.0 / basePos.
  private readonly portraitScale = 0.76;
  private readonly portraitBasePos = new THREE.Vector3(0.024, -0.326, -0.585);
  private readonly portraitBaseRot = new THREE.Euler(0.095, 0.025, 0);

  constructor() {
    this.leftHand = new HumanHand('left');
    this.rightHand = new HumanHand('right');
    this.handsTelemetry = {
      leftTris: this.leftHand.triangleCount,
      rightTris: this.rightHand.triangleCount,
      totalTris: this.leftHand.triangleCount + this.rightHand.triangleCount,
      minClearanceM: 0.025,
      leftIndexCurlDeg: HAND_POSES.rifleLeftRest.index.mcp,
      rightIndexCurlDeg: HAND_POSES.rifleRightRest.index.mcp,
      reloadStage: 0,
    };

    for (const id of ['rifle', 'gatling'] as GunId[]) {
      const gun = buildArticulated(id);
      gun.root.visible = id === this.current;
      this.guns.set(id, gun);
      this.group.add(gun.root);
    }
    // Shared articulated hands sit directly in weapon group space (only 6 draw calls total!)
    this.group.add(this.leftHand.root);
    this.group.add(this.rightHand.root);

    const g = this.guns.get(this.current)!;
    this.muzzleRig.group.position.set(0, g.muzzleY, g.muzzleZ);
    this.group.add(this.muzzleRig.group);
    this.applyHandTransforms(g, g.leftRest, g.rightRest, g.leftRestPose, g.rightRestPose);

    this.group.position.copy(this.basePos);
    this.group.rotation.copy(this.baseRot);
  }

  private applyHandTransforms(
    gun: ArticulatedGun,
    lt: TransformPose,
    rt: TransformPose,
    lp: HandPose,
    rp: HandPose,
  ): void {
    this.leftHand.root.position.set(lt.x, lt.y, lt.z);
    this.leftHand.root.rotation.set(lt.rx, lt.ry, lt.rz, 'YXZ');
    this.leftHand.setPose(lp);
    this.leftHand.aimForearmToward(gun.leftElbow);

    this.rightHand.root.position.set(rt.x, rt.y, rt.z);
    this.rightHand.root.rotation.set(rt.rx, rt.ry, rt.rz, 'YXZ');
    this.rightHand.setPose(rp);
    this.rightHand.aimForearmToward(gun.rightElbow);

    // Live hand-to-gun clearance telemetry (meters)
    this.clearanceVec.set(lt.x, lt.y, lt.z);
    const lc = minClearanceToGun(this.clearanceVec, gun.bodyBoxes);
    this.clearanceVec.set(rt.x, rt.y, rt.z);
    const rc = minClearanceToGun(this.clearanceVec, gun.bodyBoxes);
    this.handsTelemetry.minClearanceM = Math.min(lc, rc);
    this.handsTelemetry.leftIndexCurlDeg = lp.index.mcp;
    this.handsTelemetry.rightIndexCurlDeg = rp.index.mcp;
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
    this.applyHandTransforms(g, g.leftRest, g.rightRest, g.leftRestPose, g.rightRestPose);
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

  get reloadPitchDip(): number {
    return this.reloadSightDipRad;
  }

  onFire(id: GunId = this.current): void {
    this.kick = 1;
    this.kickDur = id === 'gatling' ? 0.055 : 0.11;
    this.kickDeg = id === 'gatling' ? 0.42 : 2.5;
    this.muzzleRig.trigger(id);
  }

  muzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    this.group.updateWorldMatrix(true, false);
    return this.muzzleRig.group.getWorldPosition(out);
  }

  ejectWorld(out: THREE.Vector3): THREE.Vector3 {
    const gun = this.guns.get(this.current)!;
    gun.root.updateWorldMatrix(true, false);
    out.copy(gun.ejectPos);
    return gun.root.localToWorld(out);
  }

  /**
   * Project the active weapon viewmodel's visible Box3 bounds (active gun +
   * articulated hands, excluding muzzle VFX and hidden meshes) onto CSS pixels,
   * clipped cleanly against the camera frustum.
   */
  screenRect(camera: THREE.PerspectiveCamera, vw: number, vh: number): ViewmodelScreenRect {
    const scale = Number(this.group.scale.x.toFixed(4));
    if (!this.group.visible || vw <= 0 || vh <= 0) {
      return { x: 0, y: 0, w: 0, h: 0, scale };
    }
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
    const viewProj = new THREE.Matrix4().multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    );
    const mvp = new THREE.Matrix4();

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    const gun = this.guns.get(this.current);
    const roots: THREE.Object3D[] = [this.leftHand.root, this.rightHand.root];
    if (gun) roots.unshift(gun.root);

    const projectLocalBox = (box: THREE.Box3, matWorld: THREE.Matrix4): void => {
      if (box.isEmpty()) return;
      mvp.multiplyMatrices(viewProj, matWorld);
      const { min, max } = box;
      const corners = [
        new THREE.Vector4(min.x, min.y, min.z, 1),
        new THREE.Vector4(max.x, min.y, min.z, 1),
        new THREE.Vector4(max.x, max.y, min.z, 1),
        new THREE.Vector4(min.x, max.y, min.z, 1),
        new THREE.Vector4(min.x, min.y, max.z, 1),
        new THREE.Vector4(max.x, min.y, max.z, 1),
        new THREE.Vector4(max.x, max.y, max.z, 1),
        new THREE.Vector4(min.x, max.y, max.z, 1),
      ];
      for (const c of corners) c.applyMatrix4(mvp);
      for (const [i0, i1, i2, i3] of BOX_FACES) {
        const clipped = clipClipSpacePoly([corners[i0], corners[i1], corners[i2], corners[i3]]);
        for (const v of clipped) {
          if (Math.abs(v.w) < 1e-6) continue;
          const sx = ((v.x / v.w) * 0.5 + 0.5) * vw;
          const sy = (-(v.y / v.w) * 0.5 + 0.5) * vh;
          if (sx < minX) minX = sx;
          if (sx > maxX) maxX = sx;
          if (sy < minY) minY = sy;
          if (sy > maxY) maxY = sy;
        }
      }
    };

    for (const r of roots) {
      r.traverseVisible((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh || !mesh.geometry) return;
        const skinned = mesh as unknown as THREE.SkinnedMesh;
        let box: THREE.Box3 | null = null;
        if (skinned.isSkinnedMesh) {
          skinned.skeleton?.update();
          skinned.computeBoundingBox();
          box = skinned.boundingBox;
        } else {
          if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
          box = mesh.geometry.boundingBox;
        }
        if (box) projectLocalBox(box, mesh.matrixWorld);
      });
    }

    if (!Number.isFinite(minX)) {
      return { x: 0, y: 0, w: 0, h: 0, scale };
    }
    const cx = Math.max(0, Math.min(vw, minX));
    const cy = Math.max(0, Math.min(vh, minY));
    const cr = Math.max(0, Math.min(vw, maxX));
    const cb = Math.max(0, Math.min(vh, maxY));
    return {
      x: Number(cx.toFixed(1)),
      y: Number(cy.toFixed(1)),
      w: Number(Math.max(0, cr - cx).toFixed(1)),
      h: Number(Math.max(0, cb - cy).toFixed(1)),
      scale,
    };
  }

  private resetReloadPose(gun: ArticulatedGun): void {
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
    if (gun.freshMag) {
      gun.freshMag.visible = false;
      gun.freshMag.position.copy(gun.magRestPos);
      gun.freshMag.rotation.set(0, 0, 0);
    }
    gun.bolt.position.copy(gun.boltRestPos);
    gun.bolt.rotation.set(0, 0, 0);
    MAT.dropMag.opacity = 1;
    MAT.dropEdge.opacity = 1;
    MAT.dropAccent.opacity = 1;
  }

  /**
   * Exact 6-stage Spec A rifle reload choreography (0..1040ms + 60ms settle = 1100ms):
   * ① 0–140ms    Left hand opens fingers straight (0–12°), clears handguard → below magwell
   * ② 140–340ms  Left thumb presses mag catch; old mag drops, left hand catches & sweeps down-left
   * ③ 340–520ms  Left hand draws fresh mag from belt/thigh into lower view (open cupped 5-finger grip)
   * ④ 520–740ms  Fresh mag aligns & pushes into magwell (palm follows base) → thumb presses to confirm
   * ⑤ 740–920ms  Left hand returns to handguard; RIGHT hand leaves trigger/grip, palm turns sideways, racks bolt
   * ⑥ 920–1040ms Right hand returns to grip & rifle levels back to ready
   */
  private applyRifleReload(gun: ArticulatedGun, elapsedMs: number): void {
    const t = elapsedMs;
    const enter = segment(t, 0, 140, easeInOutCubic);
    const exit = segment(t, 920, 1040, easeInOutCubic);
    const poseW = enter * (1 - exit);

    const magSeatKick = pulse(t, 610, 650, 710, easeOutCubic, easeInOutCubic);
    const boltKick = pulse(t, 830, 875, 920, easeOutCubic, easeOutCubic) * ((1.5 * Math.PI) / 180);

    // Lift & angle the rifle cleanly so BOTH hands, all 5 separated skin fingers & sleeve cuffs sit well inside frame
    this.reloadGunPos.set(
      lerp(0, -0.095, poseW),
      lerp(0, 0.105, poseW) + magSeatKick * 0.012,
      lerp(0, -0.065, poseW) + boltKick * 0.40,
    );
    this.reloadGunRot.set(
      lerp(0, -0.11, poseW) + boltKick + magSeatKick * 0.022,
      lerp(0, 0.32, poseW),
      lerp(0, -(3.5 * Math.PI) / 180, poseW) - boltKick * 0.35,
    );
    this.reloadSightDipRad = -(1.5 * Math.PI) / 180 * poseW;

    // --- Left Hand Keyframe Transforms (every point strictly >= 2.2cm clear of gun body!) ---
    const L_REST = gun.leftRest;
    const L_CLEAR_ARC: TransformPose = { x: -0.068, y: -0.095, z: -0.115, rx: 0.16, ry: 0.28, rz: 1.55 };
    const L_BELOW_WELL: TransformPose = { x: -0.048, y: -0.155, z: 0.014, rx: 0.24, ry: 0.24, rz: 1.15 };
    const L_CATCH_MAG: TransformPose = { x: -0.064, y: -0.188, z: 0.018, rx: 0.26, ry: 0.22, rz: 1.25 };
    const L_SWEEP_OUT: TransformPose = { x: -0.195, y: -0.275, z: 0.045, rx: 0.34, ry: 0.26, rz: 1.05 };
    const L_POUCH_UP: TransformPose = { x: -0.215, y: -0.285, z: 0.052, rx: 0.30, ry: 0.26, rz: 0.85 };
    const L_PRESENT_NEW: TransformPose = { x: -0.068, y: -0.196, z: 0.020, rx: 0.22, ry: 0.34, rz: 0.92 };
    const L_ALIGN_WELL: TransformPose = { x: -0.044, y: -0.192, z: 0.015, rx: 0.18, ry: 0.24, rz: 1.02 };
    const L_PUSH_SEAT: TransformPose = { x: -0.042, y: -0.138, z: 0.014, rx: 0.14, ry: 0.20, rz: 1.08 };
    const L_CONFIRM: TransformPose = { x: -0.046, y: -0.142, z: 0.012, rx: 0.12, ry: 0.22, rz: 1.16 };

    let lTrans: TransformPose = L_REST;
    let lPose: HandPose = gun.leftRestPose;
    let stage = 0;

    if (t < 140) {
      // ① 0–140ms: Left hand opens fingers straight & arcs outside handguard to below magwell
      stage = 1;
      if (t < 65) {
        const u = segment(t, 0, 65, easeOutCubic);
        lTrans = lerpTransform(L_REST, L_CLEAR_ARC, u);
        lPose = lerpHandPose(HAND_POSES.rifleLeftRest, HAND_POSES.leftOpenSpread, u, this.leftPoseScratch);
      } else {
        const u = segment(t, 65, 140, easeInOutCubic);
        lTrans = lerpTransform(L_CLEAR_ARC, L_BELOW_WELL, u);
        lPose = lerpHandPose(HAND_POSES.leftOpenSpread, HAND_POSES.leftOpenSpread, u, this.leftPoseScratch);
      }
    } else if (t < 340) {
      // ② 140–340ms: Thumb presses mag release (140–210ms); mag drops, left hand catches & sweeps out (210–340ms)
      stage = 2;
      if (t < 210) {
        const u = segment(t, 140, 210, easeInOutCubic);
        lTrans = lerpTransform(L_BELOW_WELL, L_CATCH_MAG, u * 0.5);
        lPose = lerpHandPose(HAND_POSES.leftOpenSpread, HAND_POSES.leftThumbRelease, u, this.leftPoseScratch);
      } else if (t < 265) {
        const u = segment(t, 210, 265, easeOutCubic);
        lTrans = lerpTransform(lerpTransform(L_BELOW_WELL, L_CATCH_MAG, 0.5), L_CATCH_MAG, u);
        lPose = lerpHandPose(HAND_POSES.leftThumbRelease, HAND_POSES.leftCatchMag, u, this.leftPoseScratch);
      } else {
        const u = segment(t, 265, 340, easeInCubic);
        lTrans = lerpTransform(L_CATCH_MAG, L_SWEEP_OUT, u);
        lPose = lerpHandPose(HAND_POSES.leftCatchMag, HAND_POSES.leftCatchMag, u, this.leftPoseScratch);
      }
    } else if (t < 520) {
      // ③ 340–520ms: Left hand draws fresh mag from belt/thigh up into view with open cupped grip
      stage = 3;
      const u = segment(t, 340, 520, easeInOutCubic);
      lTrans = lerpTransform(L_POUCH_UP, L_PRESENT_NEW, u);
      lPose = lerpHandPose(HAND_POSES.leftCatchMag, HAND_POSES.leftHoldFreshMag, segment(t, 340, 440, easeOutCubic), this.leftPoseScratch);
    } else if (t < 740) {
      // ④ 520–740ms: Align & push new mag into magwell (520–660ms) → thumb presses to confirm (660–740ms)
      stage = 4;
      if (t < 575) {
        const u = segment(t, 520, 575, easeInOutCubic);
        lTrans = lerpTransform(L_PRESENT_NEW, L_ALIGN_WELL, u);
        lPose = lerpHandPose(HAND_POSES.leftHoldFreshMag, HAND_POSES.leftPushMag, u, this.leftPoseScratch);
      } else if (t < 660) {
        const lin = segment(t, 575, 635, easeInOutCubic);
        const snap = t >= 635 ? easeOutBack(clamp01((t - 635) / 25), 2.1) : 0;
        const pushU = t < 635 ? lin * 0.85 : 0.85 + snap * 0.15;
        lTrans = lerpTransform(L_ALIGN_WELL, L_PUSH_SEAT, pushU);
        lPose = HAND_POSES.leftPushMag;
      } else {
        const u = segment(t, 660, 740, easeOutCubic);
        lTrans = lerpTransform(L_PUSH_SEAT, L_CONFIRM, u);
        lPose = lerpHandPose(HAND_POSES.leftPushMag, HAND_POSES.leftThumbConfirm, u, this.leftPoseScratch);
      }
    } else if (t < 920) {
      // ⑤ 740–920ms: Left hand returns cleanly around outside of receiver back onto handguard
      stage = 5;
      if (t < 820) {
        const u = segment(t, 740, 820, easeInOutCubic);
        lTrans = lerpTransform(L_CONFIRM, L_CLEAR_ARC, u);
        lPose = lerpHandPose(HAND_POSES.leftThumbConfirm, HAND_POSES.leftOpenSpread, u, this.leftPoseScratch);
      } else {
        const u = segment(t, 820, 920, easeInOutCubic);
        lTrans = lerpTransform(L_CLEAR_ARC, L_REST, u);
        lPose = lerpHandPose(HAND_POSES.leftOpenSpread, HAND_POSES.rifleLeftRest, u, this.leftPoseScratch);
      }
    } else {
      // ⑥ 920–1040ms+: Left hand settled on handguard
      stage = 6;
      lTrans = L_REST;
      lPose = HAND_POSES.rifleLeftRest;
    }

    // --- Right Hand Keyframe Transforms (stays on grip ①–④, RACKS BOLT in Stage ⑤, returns in Stage ⑥!) ---
    const R_REST = gun.rightRest;
    const R_LIFT_SIDE: TransformPose = { x: 0.056, y: 0.008, z: 0.124, rx: 0.08, ry: 0.34, rz: -0.68 };
    const R_BOLT_FWD: TransformPose = { x: 0.052, y: 0.044, z: 0.130, rx: -0.06, ry: 0.42, rz: -0.42 };
    const R_BOLT_BACK: TransformPose = { x: 0.052, y: 0.042, z: 0.198, rx: -0.04, ry: 0.42, rz: -0.42 };

    let rTrans: TransformPose = R_REST;
    let rPose: HandPose = gun.rightRestPose;

    if (t >= 740 && t < 920) {
      // ⑤ 740–920ms: Index leaves trigger, right palm rotates sideways, hooks & pulls charging handle!
      if (t < 800) {
        const u = segment(t, 740, 800, easeInOutCubic);
        const mid = u < 0.5 ? lerpTransform(R_REST, R_LIFT_SIDE, u * 2) : lerpTransform(R_LIFT_SIDE, R_BOLT_FWD, (u - 0.5) * 2);
        rTrans = mid;
        rPose = lerpHandPose(HAND_POSES.rifleRightRest, HAND_POSES.rightReleaseToBolt, u, this.rightPoseScratch);
      } else if (t < 870) {
        const u = segment(t, 800, 870, easeOutCubic);
        rTrans = lerpTransform(R_BOLT_FWD, R_BOLT_BACK, u);
        rPose = lerpHandPose(HAND_POSES.rightReleaseToBolt, HAND_POSES.rightRackBolt, segment(t, 800, 830, easeOutCubic), this.rightPoseScratch);
      } else {
        const u = segment(t, 870, 920, easeOutCubic);
        rTrans = lerpTransform(R_BOLT_BACK, R_BOLT_FWD, u);
        rPose = lerpHandPose(HAND_POSES.rightRackBolt, HAND_POSES.rightReleaseToBolt, u, this.rightPoseScratch);
      }
    } else if (t >= 920 && t < 1040) {
      // ⑥ 920–1040ms: Right hand returns smoothly onto pistol grip (index back on trigger)
      const u = segment(t, 920, 1040, easeInOutCubic);
      rTrans = u < 0.45 ? lerpTransform(R_BOLT_FWD, R_LIFT_SIDE, u / 0.45) : lerpTransform(R_LIFT_SIDE, R_REST, (u - 0.45) / 0.55);
      rPose = lerpHandPose(HAND_POSES.rightReleaseToBolt, HAND_POSES.rifleRightRest, u, this.rightPoseScratch);
    }

    this.applyHandTransforms(gun, lTrans, rTrans, lPose, rPose);
    this.handsTelemetry.reloadStage = stage;

    // --- Magazine visibility & motion synced cleanly with left hand ---
    const magSeated = t < 185 || t >= 660;
    if (gun.mag) {
      gun.mag.visible = magSeated;
      gun.mag.position.copy(gun.magRestPos);
      if (t >= 660 && t < 720) {
        const settle = segment(t, 660, 720, easeOutCubic);
        gun.mag.position.y = gun.magRestPos.y + (1 - settle) * 0.008;
      }
    }

    // Old mag drops at 185ms, caught by left hand (210–265ms) and swept down-left out of frame
    const dropVisible = t >= 185 && t < 350;
    if (gun.dropMag) {
      gun.dropMag.visible = dropVisible;
      if (dropVisible) {
        const dropInit = segment(t, 185, 245, easeInCubic);
        const sweep = segment(t, 245, 350, easeInCubic);
        gun.dropMag.position.set(
          gun.magRestPos.x - 0.025 * dropInit - 0.145 * sweep,
          gun.magRestPos.y - 0.055 * dropInit - 0.165 * sweep,
          gun.magRestPos.z + 0.015 * sweep,
        );
        gun.dropMag.rotation.set(0.14 * sweep, 0.10 * sweep, 0.28 * sweep);
        const fade = 1 - segment(t, 285, 350, easeInOutCubic);
        MAT.dropMag.opacity = fade;
        MAT.dropEdge.opacity = fade;
      }
    }

    // Fresh magazine carried up in left palm (340–660ms), pushing straight up into magwell in Stage ④!
    const carryingFresh = t >= 340 && t < 660;
    if (gun.freshMag) {
      gun.freshMag.visible = carryingFresh;
      if (carryingFresh) {
        if (t < 520) {
          // Stage ③: fresh mag rises cleanly in left cupped hand
          const u = segment(t, 340, 520, easeInOutCubic);
          gun.freshMag.position.set(
            lerp(-0.165, -0.022, u),
            lerp(-0.205, -0.118, u),
            lerp(0.042, 0.015, u),
          );
          gun.freshMag.rotation.set(lerp(0.18, 0.06, u), lerp(0.12, 0.04, u), lerp(0.24, 0.08, u));
        } else if (t < 575) {
          // Stage ④a: align straight beneath magwell
          const u = segment(t, 520, 575, easeInOutCubic);
          gun.freshMag.position.set(
            lerp(-0.022, gun.magRestPos.x, u),
            lerp(-0.118, gun.magRestPos.y - 0.062, u),
            lerp(0.015, gun.magRestPos.z, u),
          );
          gun.freshMag.rotation.set(lerp(0.06, 0, u), lerp(0.04, 0, u), lerp(0.08, 0, u));
        } else {
          // Stage ④b: push straight up into magwell with easeOutBack click!
          const lin = segment(t, 575, 635, easeInOutCubic);
          const snap = t >= 635 ? easeOutBack(clamp01((t - 635) / 25), 2.1) : 0;
          const pushU = t < 635 ? lin * 0.85 : 0.85 + snap * 0.15;
          gun.freshMag.position.set(
            gun.magRestPos.x,
            lerp(gun.magRestPos.y - 0.062, gun.magRestPos.y, pushU),
            gun.magRestPos.z,
          );
          gun.freshMag.rotation.set(0, 0, 0);
        }
      }
    }

    // Charging handle slide synced strictly to Stage ⑤ right-hand rack (800–920ms)
    const boltPull = pulse(t, 800, 870, 920, easeOutCubic, easeOutCubic);
    gun.bolt.position.set(gun.boltRestPos.x, gun.boltRestPos.y, gun.boltRestPos.z + boltPull * 0.068);

    this.animDebug.magDetached = !magSeated;
    this.animDebug.newMagInHand = carryingFresh;
  }

  /** Gatling 3.2s drum-swap reload with articulated human hands + dangling belt. */
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

    const coverOpen =
      segment(t, 180, 440, easeInOutCubic) * (1 - segment(t, 2480, 2700, easeOutBack));
    gun.bolt.rotation.z = coverOpen * 1.25;

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

    const L_REST = gun.leftRest;
    const L_DRUM: TransformPose = { x: -0.155, y: -0.155, z: -0.045, rx: 0.22, ry: 0.25, rz: 1.35 };
    const L_FETCH: TransformPose = { x: -0.265, y: -0.325, z: 0.045, rx: 0.30, ry: 0.25, rz: 1.05 };
    const L_ALIGN: TransformPose = { x: -0.155, y: -0.235, z: -0.055, rx: 0.18, ry: 0.22, rz: 1.15 };
    const L_SEAT: TransformPose = { x: -0.155, y: -0.165, z: -0.055, rx: 0.16, ry: 0.20, rz: 1.25 };
    const L_FEED: TransformPose = { x: -0.095, y: 0.032, z: -0.035, rx: 0.14, ry: 0.10, rz: 0.45 };

    let lTrans: TransformPose = L_REST;
    let lPose: HandPose = gun.leftRestPose;
    if (t < 480) {
      const u = segment(t, 0, 480, easeInOutCubic);
      lTrans = lerpTransform(L_REST, L_DRUM, u);
      lPose = lerpHandPose(HAND_POSES.gatlingLeftRest, HAND_POSES.leftOpenSpread, segment(t, 0, 200, easeOutCubic), this.leftPoseScratch);
    } else if (t < 1050) {
      const u = segment(t, 480, 1050, easeInOutCubic);
      lTrans = lerpTransform(L_DRUM, L_FETCH, u);
      lPose = HAND_POSES.leftCatchMag;
    } else if (t < 1850) {
      const u = segment(t, 1050, 1850, easeInOutCubic);
      lTrans = lerpTransform(L_FETCH, L_ALIGN, u);
      lPose = HAND_POSES.leftHoldFreshMag;
    } else if (t < 2220) {
      const u = easeOutBack(clamp01((t - 1850) / 370), 1.4);
      lTrans = lerpTransform(L_ALIGN, L_SEAT, u);
      lPose = HAND_POSES.leftPushMag;
    } else if (t < 2680) {
      const u = segment(t, 2220, 2680, easeInOutCubic);
      lTrans = lerpTransform(L_SEAT, L_FEED, u);
      lPose = lerpHandPose(HAND_POSES.leftPushMag, HAND_POSES.leftOpenSpread, u, this.leftPoseScratch);
    } else {
      const u = segment(t, 2680, 3150, easeInOutCubic);
      lTrans = lerpTransform(L_FEED, L_REST, u);
      lPose = lerpHandPose(HAND_POSES.leftOpenSpread, HAND_POSES.gatlingLeftRest, u, this.leftPoseScratch);
    }

    this.applyHandTransforms(gun, lTrans, gun.rightRest, lPose, gun.rightRestPose);
    this.handsTelemetry.reloadStage = t < 480 ? 1 : t < 1050 ? 2 : t < 1850 ? 3 : t < 2220 ? 4 : t < 2680 ? 5 : 6;

    const carryingFresh = t >= 1050 && t < 2220;
    if (gun.freshMag) {
      gun.freshMag.visible = carryingFresh;
      if (carryingFresh) {
        if (t < 1850) {
          const u = segment(t, 1050, 1850, easeInOutCubic);
          gun.freshMag.position.set(
            lerp(-0.22, gun.magRestPos.x, u),
            lerp(-0.28, gun.magRestPos.y - 0.08, u),
            lerp(0.03, gun.magRestPos.z, u),
          );
          gun.freshMag.rotation.set(0.08, 0.18, 0.16);
        } else {
          const u = easeOutBack(clamp01((t - 1850) / 370), 1.4);
          gun.freshMag.position.set(
            gun.magRestPos.x,
            lerp(gun.magRestPos.y - 0.08, gun.magRestPos.y, u),
            gun.magRestPos.z,
          );
          gun.freshMag.rotation.set(0.08, 0.18, 0.16);
        }
      }
    }

    this.animDebug.magDetached = !drumSeated;
    this.animDebug.newMagInHand = carryingFresh;

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
        this.applyHandTransforms(nextGun, nextGun.leftRest, nextGun.rightRest, nextGun.leftRestPose, nextGun.rightRestPose);
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
      this.handsTelemetry.reloadStage = 0;
      this.reloadBlend = damp(this.reloadBlend, 0, 18, dt);
      this.reloadSightDipRad = damp(this.reloadSightDipRad, 0, 18, dt);

      // Smoothly return both articulated hands to active weapon's rest grip
      const blendRate = 1 - Math.exp(-18 * dt);
      const lx = lerp(this.leftHand.root.position.x, gun.leftRest.x, blendRate);
      const ly = lerp(this.leftHand.root.position.y, gun.leftRest.y, blendRate);
      const lz = lerp(this.leftHand.root.position.z, gun.leftRest.z, blendRate);
      const lrx = lerp(this.leftHand.root.rotation.x, gun.leftRest.rx, blendRate);
      const lry = lerp(this.leftHand.root.rotation.y, gun.leftRest.ry, blendRate);
      const lrz = lerp(this.leftHand.root.rotation.z, gun.leftRest.rz, blendRate);

      const rx = lerp(this.rightHand.root.position.x, gun.rightRest.x, blendRate);
      const ry = lerp(this.rightHand.root.position.y, gun.rightRest.y, blendRate);
      const rz = lerp(this.rightHand.root.position.z, gun.rightRest.z, blendRate);
      const rrx = lerp(this.rightHand.root.rotation.x, gun.rightRest.rx, blendRate);
      const rry = lerp(this.rightHand.root.rotation.y, gun.rightRest.ry, blendRate);
      const rrz = lerp(this.rightHand.root.rotation.z, gun.rightRest.rz, blendRate);

      // Subtle trigger squeeze on right index finger when firing!
      const triggerPull = this.kick > 0.05 ? this.kick * 18 : 0;
      this.rightPoseScratch = lerpHandPose(gun.rightRestPose, gun.rightRestPose, 1, this.rightPoseScratch);
      this.rightPoseScratch.index = {
        mcp: Math.min(85, gun.rightRestPose.index.mcp + triggerPull),
        pip: Math.min(85, gun.rightRestPose.index.pip + triggerPull * 0.8),
        splay: gun.rightRestPose.index.splay,
      };

      this.applyHandTransforms(
        gun,
        { x: lx, y: ly, z: lz, rx: lrx, ry: lry, rz: lrz },
        { x: rx, y: ry, z: rz, rx: rrx, ry: rry, rz: rrz },
        gun.leftRestPose,
        this.rightPoseScratch,
      );

      gun.bolt.position.lerp(gun.boltRestPos, blendRate);
      gun.bolt.rotation.z = damp(gun.bolt.rotation.z, 0, 18, dt);
      if (gun.mag) {
        gun.mag.visible = true;
        gun.mag.position.lerp(gun.magRestPos, 1 - Math.exp(-22 * dt));
      }
      if (gun.dropMag) gun.dropMag.visible = false;
      if (gun.freshMag) gun.freshMag.visible = false;
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
      const dangleSway = beltDangle * Math.sin(this.time * 7.5) * 0.18;
      gun.beltSegs[0].rotation.z = lerp(-0.52, -0.08, beltDangle) + bobSwing * 0.35 + idleSway + fireChatter + dangleSway;
      gun.beltSegs[1].rotation.z = lerp(0.36, 0.06, beltDangle) + bobSwing * 0.55 - fireChatter * 1.25 + dangleSway * 1.3;
      gun.beltSegs[2].rotation.z = lerp(0.44, 0.04, beltDangle) + bobSwing * 0.75 + fireChatter * 1.4 - dangleSway * 0.9;
      gun.beltSegs[0].rotation.x = Math.sin(this.time * 3.1) * 0.04 + (gatFiring ? 0.06 : 0);
      gun.beltSegs[1].rotation.x = Math.cos(this.time * 3.1) * 0.05;
    }

    const breathe = Math.sin(this.time * 1.7) * 0.002;
    const sway = Math.sin(this.time * 1.15) * 0.0015;
    const gatVibX = gatFiring ? Math.sin(this.time * 52) * 0.0024 : spin > 0.1 ? Math.sin(this.time * 34) * 0.0008 * spin : 0;
    const gatVibY = gatFiring ? Math.cos(this.time * 47) * 0.0020 : 0;
    const cam = this.group.parent as THREE.PerspectiveCamera | null;
    const isPortrait = Boolean(cam?.isPerspectiveCamera && cam.aspect < 1);
    const vmScale = isPortrait ? this.portraitScale : 1;
    this.group.scale.setScalar(vmScale);

    const bPos = isPortrait ? this.portraitBasePos : this.basePos;
    const bRot = isPortrait ? this.portraitBaseRot : this.baseRot;
    let px = bPos.x + gun.baseOffset.x * vmScale;
    if (!isPortrait && cam?.isPerspectiveCamera) {
      const halfW =
        Math.tan((cam.fov * Math.PI) / 360) * Math.abs(this.basePos.z) * cam.aspect;
      px = Math.min(px, Math.max(0.11, halfW * 0.7));
    }
    const py = bPos.y + gun.baseOffset.y * vmScale;
    const pz = bPos.z + gun.baseOffset.z * vmScale;

    const rb = this.reloadBlend;
    this.group.position.set(
      px + sway + this.bobX + gatVibX + this.reloadGunPos.x * rb * vmScale,
      py - k * 0.018 * Math.min(2.2, kickScale) + breathe + this.bobY + gatVibY + this.swapDropY * vmScale + this.reloadGunPos.y * rb * vmScale,
      pz + k * 0.058 * Math.min(2.2, kickScale) + this.reloadGunPos.z * rb * vmScale,
    );
    this.group.rotation.set(
      bRot.x + k * 0.075 * Math.min(2.4, kickScale) + breathe * 0.6 + this.swapDropPitch + this.reloadGunRot.x * rb,
      bRot.y + sway * 0.5 + this.reloadGunRot.y * rb,
      bRot.z + this.reloadGunRot.z * rb,
    );

    this.muzzleRig.update(dt, telemetry);
  }
}
