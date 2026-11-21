// First-person weapon view — three articulated guns built from primitives
// (zero external assets) with full delta-time reload animations (magazine eject
// with fade, visible left hand + forearm inserting fresh mag w/ easeOutBack
// overshoot, charging handle/bolt rack w/ 1.5° recoil kick, shell-by-shell
// loading for shotgun & sniper), continuous 0.35s weapon swap, and decoupled
// walk bob. All motions run through src/render/tween.ts.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PALETTE } from './palette';
import { getMaterial } from './materials';
import type { MaterialKind } from './materials';
import type { ReloadSnapshot, WeaponSpec } from '../game/weapons';
import type { Vec3 } from '../game/player';
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

type GunId = WeaponSpec['id'];
type MatKey = 'metal' | 'poly' | 'mag' | 'edge' | 'glove' | 'cuff' | 'brass' | 'shellRed';

const std = (kind: MaterialKind, emissiveIntensity: number): THREE.MeshStandardMaterial => {
  const m = (getMaterial(kind) as THREE.MeshStandardMaterial).clone();
  m.emissive.copy(m.color);
  m.emissiveIntensity = emissiveIntensity;
  return m;
};

const MAT: Record<MatKey, THREE.Material> & {
  flash: THREE.MeshBasicMaterial;
  flashCore: THREE.MeshBasicMaterial;
  dropMag: THREE.MeshStandardMaterial;
  dropEdge: THREE.MeshBasicMaterial;
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
    emissiveIntensity: 0.18,
    metalness: 0.88,
    roughness: 0.24,
  }),
  shellRed: new THREE.MeshStandardMaterial({
    color: PALETTE.shellRed,
    emissive: PALETTE.shellRed,
    emissiveIntensity: 0.14,
    metalness: 0.15,
    roughness: 0.55,
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
  flash: new THREE.MeshBasicMaterial({
    color: PALETTE.accent,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }),
  flashCore: new THREE.MeshBasicMaterial({
    color: PALETTE.flashCore,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
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

const sph = (p: Parts, mat: MatKey, r: number, x = 0, y = 0, z = 0): void => {
  p.push({ mat, geo: place(new THREE.SphereGeometry(r, 8, 6), x, y, z) });
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
  // Floorplate + crisp metallic highlight rib along left flank so mag silhouettes pop
  box(p, 'mag', 0.031, 0.010, 0.056, 0, -depth - 0.006, -0.010, -0.16, 0, 0);
  box(p, 'edge', 0.032, 0.004, 0.056, 0, -depth - 0.010, -0.010, -0.16, 0, 0);
  box(p, 'edge', 0.003, depth * 0.72, 0.008, -0.0145, -depth * 0.45, -0.016, 0.16, 0, 0);
  if (withTopRound) {
    // Gleaming brass cartridge peeking at feed lips of fresh mag
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

/** Right (trigger) hand & forearm merged into the weapon body. */
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

/**
 * Articulated left (support) hand + wrist cuff + forearm rooted at palm center (0,0,0).
 * Forearm extends naturally down-left-back (-X, -Y, +Z) toward bottom-left of screen
 * so bringing a fresh magazine or shell up from bottom-left shows the full hand & forearm.
 */
function buildLeftArmGroup(): THREE.Group {
  const g = new THREE.Group();
  const p: Parts = [];
  // Palm cupping from below
  box(p, 'glove', 0.052, 0.028, 0.078, -0.002, -0.010, 0);
  // Hand back on left flank + crisp knuckle edge highlight
  box(p, 'glove', 0.016, 0.034, 0.074, -0.023, 0.010, 0);
  box(p, 'edge', 0.004, 0.008, 0.062, -0.031, 0.022, 0);
  // Four fingers curling over top
  for (let i = 0; i < 4; i++) {
    box(p, 'glove', 0.026, 0.011, 0.014, -0.007, 0.031, 0.026 - i * 0.017, 0, 0, 0.22);
  }
  // Thumb along right side
  box(p, 'glove', 0.014, 0.012, 0.032, 0.019, 0.007, 0.010, 0, -0.15, 0);
  // Bright wrist cuff + substantial forearm angled down-left (-X, -Y, +Z)
  box(p, 'cuff', 0.060, 0.054, 0.034, -0.036, -0.036, 0.068, 0.55, -0.45, 0);
  box(p, 'glove', 0.058, 0.052, 0.26, -0.095, -0.125, 0.178, 0.58, -0.48, 0);
  mergeParts(p, g);
  return g;
}

/** 12-gauge shotgun shell (red hull + brass base) for shell-by-shell reload. */
function buildShotgunShell(): THREE.Group {
  const g = new THREE.Group();
  const p: Parts = [];
  cylZ(p, 'shellRed', 0.011, 0.052, 0, 0, -0.010, 10);
  cylZ(p, 'brass', 0.0115, 0.018, 0, 0, 0.025, 10);
  mergeParts(p, g);
  return g;
}

/** Brass rifle cartridge (sniper single-round reload). */
function buildSniperRound(): THREE.Group {
  const g = new THREE.Group();
  const p: Parts = [];
  cylZ(p, 'brass', 0.0085, 0.054, 0, 0, 0.006, 10);
  cylZ(p, 'brass', 0.0055, 0.024, 0, 0, -0.030, 8, 0.0015);
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
  ejectPos: THREE.Vector3;
  leftArm: THREE.Group;
  leftRestPos: THREE.Vector3;
  /** seated magazine on receiver (rifle & sniper) */
  mag: THREE.Group | null;
  magRestPos: THREE.Vector3;
  /** fading dropped magazine (rifle) */
  dropMag: THREE.Group | null;
  /** fresh magazine carried by leftArm during insert (rifle) */
  heldMag: THREE.Group | null;
  /** single shell / cartridge carried by leftArm (shotgun / sniper) */
  heldShell: THREE.Group | null;
  /** charging handle / bolt assembly */
  bolt: THREE.Group;
  boltRestPos: THREE.Vector3;
  /** sliding ejection / loading port cover */
  portCover: THREE.Group | null;
  /** shotgun pump forend */
  pump: THREE.Group | null;
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

  // Articulated charging handle + left-side side-charger tab so pulling it is unmistakable
  const bolt = new THREE.Group();
  const boltParts: Parts = [];
  box(boltParts, 'metal', 0.036, 0.008, 0.024, 0, 0, 0);
  box(boltParts, 'edge', 0.018, 0.009, 0.012, -0.024, -0.012, -0.115); // left-side tactical charging knob
  box(boltParts, 'edge', 0.005, 0.012, 0.042, 0.021, -0.022, -0.120); // chrome bolt carrier face
  mergeParts(boltParts, bolt);
  const boltRestPos = new THREE.Vector3(0, 0.030, 0.132);
  bolt.position.copy(boltRestPos);
  root.add(bolt);

  // Seated magazine
  const magRestPos = new THREE.Vector3(0, -0.052, 0.011);
  const mag = buildMagGroup(0.115, false, false);
  mag.position.copy(magRestPos);
  root.add(mag);

  // Fading drop magazine
  const dropMag = buildMagGroup(0.115, false, true);
  dropMag.position.copy(magRestPos);
  dropMag.visible = false;
  root.add(dropMag);

  // Articulated left arm + held fresh magazine
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
    ejectPos: new THREE.Vector3(0.028, 0.008, 0.012),
    leftArm,
    leftRestPos,
    mag,
    magRestPos,
    dropMag,
    heldMag,
    heldShell: null,
    bolt,
    boltRestPos,
    portCover: null,
    pump: null,
  };
}

function buildSniperModel(): ArticulatedGun {
  const root = new THREE.Group();
  const body: Parts = [];
  addReceiver(body);
  addRail(body, -0.10, 0.115, 0.036);
  addHandguard(body, -0.415, -0.105, 0.021, 0.0);
  cylZ(body, 'metal', 0.007, 0.42, 0, 0.002, -0.62, 12);
  cylZ(body, 'metal', 0.0135, 0.055, 0, 0.002, -0.838, 12);
  cylZ(body, 'metal', 0.0152, 0.006, 0, 0.002, -0.826, 12);
  cylZ(body, 'metal', 0.0152, 0.006, 0, 0.002, -0.848, 12);
  // Scope
  cylZ(body, 'metal', 0.017, 0.17, 0, 0.068, -0.01, 12);
  cylZ(body, 'metal', 0.0225, 0.038, 0, 0.068, -0.105, 12, 0.017);
  cylZ(body, 'metal', 0.0195, 0.03, 0, 0.068, 0.085, 12);
  box(body, 'metal', 0.009, 0.022, 0.014, 0, 0.049, -0.048);
  box(body, 'metal', 0.009, 0.022, 0.014, 0, 0.049, 0.052);
  cylZ(body, 'edge', 0.019, 0.0015, 0, 0.068, -0.125, 12);
  addStock(body, 0.022);
  addGrip(body, 0.098, -0.02);
  addTriggerGroup(body, 0.058, -0.024);
  box(body, 'metal', 0.006, 0.012, 0.11, -0.016, -0.028, -0.36);
  box(body, 'metal', 0.006, 0.012, 0.11, 0.016, -0.028, -0.36);
  addRightArm(body);
  mergeParts(body, root);

  // Articulated bolt handle + bolt body
  const bolt = new THREE.Group();
  const boltParts: Parts = [];
  cylZ(boltParts, 'edge', 0.010, 0.065, 0, 0, -0.022, 10);
  const stem = new THREE.CylinderGeometry(0.0045, 0.0045, 0.026, 6);
  stem.rotateZ(Math.PI / 2);
  boltParts.push({ mat: 'metal', geo: place(stem, 0.018, 0, 0) });
  sph(boltParts, 'edge', 0.0095, 0.032, 0, 0);
  mergeParts(boltParts, bolt);
  const boltRestPos = new THREE.Vector3(0.008, 0.010, 0.055);
  bolt.position.copy(boltRestPos);
  root.add(bolt);

  // Sliding breech port cover
  const portCover = new THREE.Group();
  const portParts: Parts = [];
  box(portParts, 'edge', 0.005, 0.016, 0.052, 0.0215, 0.009, 0.010);
  mergeParts(portParts, portCover);
  root.add(portCover);

  // Fixed sniper box mag
  const magRestPos = new THREE.Vector3(0, -0.050, 0.008);
  const mag = buildMagGroup(0.068, false, false);
  mag.position.copy(magRestPos);
  root.add(mag);

  const leftArm = buildLeftArmGroup();
  const leftRestPos = new THREE.Vector3(0, -0.021, -0.30);
  leftArm.position.copy(leftRestPos);
  const heldShell = buildSniperRound();
  heldShell.position.set(0.015, 0.028, -0.016);
  heldShell.rotation.set(0, 0.25, 0);
  heldShell.visible = false;
  leftArm.add(heldShell);
  root.add(leftArm);

  return {
    root,
    muzzleZ: -0.87,
    ejectPos: new THREE.Vector3(0.028, 0.012, 0.015),
    leftArm,
    leftRestPos,
    mag,
    magRestPos,
    dropMag: null,
    heldMag: null,
    heldShell,
    bolt,
    boltRestPos,
    portCover,
    pump: null,
  };
}

function buildShotgunModel(): ArticulatedGun {
  const root = new THREE.Group();
  const body: Parts = [];
  extrudeZY(
    body,
    'metal',
    [
      [0.14, 0.032],
      [-0.09, 0.032],
      [-0.106, 0.02],
      [-0.106, -0.022],
      [0.1, -0.022],
      [0.14, -0.014],
    ],
    0.042,
    0.002,
  );
  box(body, 'mag', 0.003, 0.016, 0.058, 0.0218, 0.004, -0.01);
  cylZ(body, 'metal', 0.012, 0.27, 0, 0.004, -0.525, 12);
  cylZ(body, 'metal', 0.0095, 0.42, 0, -0.03, -0.39, 10);
  cylZ(body, 'metal', 0.0115, 0.012, 0, -0.03, -0.595, 10);
  box(body, 'metal', 0.034, 0.011, 0.3, 0, 0.02, -0.42);
  for (let i = 0; i < 5; i++) {
    box(body, 'mag', 0.024, 0.004, 0.018, 0, 0.0262, -0.475 + i * 0.046);
  }
  sph(body, 'edge', 0.0045, 0, 0.0295, -0.645);
  addStock(body);
  addGrip(body, 0.098, -0.02);
  addTriggerGroup(body, 0.058, -0.024);
  addRightArm(body);
  mergeParts(body, root);

  // Articulated pump forend
  const pump = new THREE.Group();
  const pumpParts: Parts = [];
  box(pumpParts, 'poly', 0.046, 0.044, 0.115, 0, -0.024, -0.335);
  for (let i = 0; i < 3; i++) {
    box(pumpParts, 'mag', 0.048, 0.004, 0.006, 0, -0.024, -0.365 + i * 0.03);
  }
  mergeParts(pumpParts, pump);
  root.add(pump);

  // Sliding ejection bolt / port cover
  const portCover = new THREE.Group();
  const portParts: Parts = [];
  box(portParts, 'edge', 0.004, 0.015, 0.054, 0.0225, 0.004, -0.010);
  mergeParts(portParts, portCover);
  root.add(portCover);

  // Charging handle
  const bolt = new THREE.Group();
  const boltParts: Parts = [];
  box(boltParts, 'metal', 0.03, 0.007, 0.022, 0, 0, 0);
  mergeParts(boltParts, bolt);
  const boltRestPos = new THREE.Vector3(0, 0.03, 0.132);
  bolt.position.copy(boltRestPos);
  root.add(bolt);

  // Articulated left arm + held shotgun shell
  const leftArm = buildLeftArmGroup();
  const leftRestPos = new THREE.Vector3(0, -0.046, -0.335);
  leftArm.position.copy(leftRestPos);
  const heldShell = buildShotgunShell();
  heldShell.position.set(0.016, 0.026, -0.014);
  heldShell.visible = false;
  leftArm.add(heldShell);
  root.add(leftArm);

  return {
    root,
    muzzleZ: -0.662,
    ejectPos: new THREE.Vector3(0.028, 0.006, -0.010),
    leftArm,
    leftRestPos,
    mag: null,
    magRestPos: new THREE.Vector3(),
    dropMag: null,
    heldMag: null,
    heldShell,
    bolt,
    boltRestPos,
    portCover,
    pump,
  };
}

function buildArticulated(id: GunId): ArticulatedGun {
  return id === 'rifle'
    ? buildRifleModel()
    : id === 'sniper'
      ? buildSniperModel()
      : buildShotgunModel();
}

export interface WeaponAnimDebug {
  reloadActive: boolean;
  reloadElapsedMs: number;
  reloadDurationMs: number;
  magDetached: boolean;
  newMagInHand: boolean;
  swapActive: boolean;
}

export class WeaponView {
  readonly group = new THREE.Group();
  private guns = new Map<GunId, ArticulatedGun>();
  private flash = new THREE.Group();
  private kick = 0;
  private kickDur = 0.11;
  private kickDeg = 2.5;
  private flashT = 0;
  private time = 0;
  private current: GunId = 'rifle';

  // Continuous 0.35s weapon swap state
  private swapActive = false;
  private swapElapsed = 0;
  private readonly swapDuration = 0.35;
  private swapPending: GunId | null = null;
  private swapDropY = 0;
  private swapDropPitch = 0;
  private bobX = 0;
  private bobY = 0;

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
  };

  private readonly basePos = new THREE.Vector3(0.27, -0.265, -0.5);
  private readonly baseRot = new THREE.Euler(0.11, 0.075, 0);

  constructor() {
    for (const id of ['rifle', 'sniper', 'shotgun'] as GunId[]) {
      const gun = buildArticulated(id);
      gun.root.visible = id === this.current;
      this.guns.set(id, gun);
      this.group.add(gun.root);
    }
    const plane = new THREE.PlaneGeometry(0.2, 0.2);
    const p1 = new THREE.Mesh(plane, MAT.flash);
    const p2 = new THREE.Mesh(plane, MAT.flash);
    p2.rotation.z = Math.PI / 4;
    const core = new THREE.Mesh(new THREE.PlaneGeometry(0.09, 0.09), MAT.flashCore);
    this.flash.add(p1, p2, core);
    this.flash.visible = false;
    this.group.add(this.flash);
    this.flash.position.set(0, 0.012, this.guns.get(this.current)!.muzzleZ);

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
    this.resetReloadPose(this.guns.get(this.current)!);
    this.flash.position.z = this.guns.get(id)!.muzzleZ;
    this.kick = 0;
    this.reloadBlend = 0;
    this.reloadSightDipRad = 0;
  }

  /** Continuous 0.35s swap: old gun drops out → new gun rises seamlessly. */
  startSwap(id: GunId): void {
    if (id === this.current && !this.swapActive) return;
    this.swapPending = id;
    if (!this.swapActive) {
      this.swapActive = true;
      this.swapElapsed = 0;
    } else if (this.swapElapsed >= this.swapDuration * 0.5) {
      const remainingRise =
        1 - (this.swapElapsed - this.swapDuration * 0.5) / (this.swapDuration * 0.5);
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
    this.kickDur = id === 'sniper' ? 0.26 : id === 'shotgun' ? 0.20 : 0.11;
    this.kickDeg = id === 'sniper' ? 8 : id === 'shotgun' ? 6 : 2.5;
    this.flashT = 0.055;
    this.flash.rotation.z = Math.random() * Math.PI;
    const s = 0.85 + Math.random() * 0.5;
    this.flash.scale.set(s, s, s);
  }

  /** World-space muzzle tip. */
  muzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    this.group.updateWorldMatrix(true, false);
    return this.flash.getWorldPosition(out);
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
      gun.mag.rotation.set(0, 0, 0);
    }
    if (gun.dropMag) {
      gun.dropMag.visible = false;
      gun.dropMag.position.copy(gun.magRestPos);
      gun.dropMag.rotation.set(0, 0, 0);
    }
    if (gun.heldMag) gun.heldMag.visible = false;
    if (gun.heldShell) gun.heldShell.visible = false;
    gun.bolt.position.copy(gun.boltRestPos);
    gun.bolt.rotation.set(0, 0, 0);
    if (gun.portCover) gun.portCover.position.set(0, 0, 0);
    if (gun.pump) gun.pump.position.set(0, 0, 0);
    MAT.dropMag.opacity = 1;
    MAT.dropEdge.opacity = 1;
  }

  /**
   * Rifle reload timeline (1.10s total, strictly delta-time / elapsedMs driven):
   * ① 0–140ms   Gun nose dips + tilts right 2°, magwell elevates slightly into frame, sight dips softly
   * ② 100–250ms Old mag detaches along gun -Y, drops toward bottom-left with gentle sway & fades out
   * ③ 250–330ms Left hand + forearm rise from bottom-left carrying fresh magazine into frame
   * ④ 330–560ms New mag pushes up into magwell; final 40ms (520–560ms) uses easeOutBack overshoot bounce
   * ⑤ 560–760ms Left hand racks charging handle / slaps receiver (1.5° kick recovering over 60ms)
   * ⑥ 760–960ms Left hand returns to handguard, gun returns smoothly to tactical ready, sight levels
   * ⑦ 960–1100ms Settle & last-100ms fire window
   */
  private applyRifleReload(gun: ArticulatedGun, elapsedMs: number): void {
    const t = elapsedMs;
    const enter = segment(t, 0, 140, easeInOutCubic);
    const exit = segment(t, 760, 960, easeInOutCubic);
    const poseW = enter * (1 - exit);

    // Gun body pose: nose dips down, tilts right ~2° (-0.038 rad), turns left flank toward view
    // and shifts slightly back/up at receiver so magwell + hand + mag sit comfortably inside frame!
    const slapKick =
      pulse(t, 660, 700, 760, easeOutCubic, easeOutCubic) * ((1.5 * Math.PI) / 180);
    const magBump = pulse(t, 510, 545, 600, easeOutCubic, easeInOutCubic);

    this.reloadGunPos.set(
      lerp(0, -0.075, poseW),
      lerp(0, 0.058, poseW) + magBump * 0.014,
      lerp(0, -0.105, poseW) + slapKick * 0.45,
    );
    this.reloadGunRot.set(
      lerp(0, -0.16, poseW) + slapKick + magBump * 0.022, // nose dips down; bolt slap kicks 1.5°
      lerp(0, 0.30, poseW), // angle receiver left flank so magwell & charging knob face viewer
      lerp(0, -(2.2 * Math.PI) / 180, poseW) - slapKick * 0.35, // right tilt ~2°
    );
    this.reloadSightDipRad = -(1.6 * Math.PI) / 180 * poseW;

    // --- Stage ②: Old magazine detaches along -Y and drops to bottom-left fading out ---
    const magSeated = t < 100 || t >= 560;
    if (gun.mag) {
      gun.mag.visible = magSeated;
      gun.mag.position.copy(gun.magRestPos);
      // Slight easeOutBack seating bounce right when handed off at 560ms
      if (t >= 560 && t < 610) {
        const settle = segment(t, 560, 610, easeOutCubic);
        gun.mag.position.y = gun.magRestPos.y + (1 - settle) * 0.008;
      }
    }

    const dropVisible = t >= 100 && t < 275;
    if (gun.dropMag) {
      gun.dropMag.visible = dropVisible;
      if (dropVisible) {
        // 100–250ms primary drop + 25ms tail fade so it's unmistakable
        const u = clamp01((t - 100) / 165);
        const dropEase = easeInCubic(u);
        const pullInitial = segment(t, 100, 155, easeOutCubic);
        // Moves straight down along -Y first, then arcs toward bottom-left with gentle pendulum sway
        gun.dropMag.position.set(
          gun.magRestPos.x - 0.16 * dropEase,
          gun.magRestPos.y - 0.065 * pullInitial - 0.24 * dropEase,
          gun.magRestPos.z + 0.025 * u,
        );
        const sway = Math.sin(u * Math.PI * 2.1) * 0.22;
        gun.dropMag.rotation.set(0.28 * dropEase, 0.12 * u, 0.32 * dropEase + sway);
        // Smooth opacity fade: solid at 100–175ms (so reload-1 shot is crisp!), fades 175–275ms
        const fade = 1 - segment(t, 175, 275, easeInOutCubic);
        MAT.dropMag.opacity = fade;
        MAT.dropEdge.opacity = fade;
      }
    }

    // --- Left hand + forearm continuous spline through all 6 stages (ZERO teleports) ---
    // Keyframes in gun local space:
    const rest = gun.leftRestPos; // (0, -0.024, -0.26) on handguard
    const gripMag = { x: -0.026, y: -0.145, z: 0.008, rx: 0.18, ry: 0.12, rz: 0.24 };
    const stripMag = { x: -0.075, y: -0.215, z: 0.015, rx: 0.24, ry: 0.18, rz: 0.32 };
    const pouchLow = { x: -0.255, y: -0.275, z: 0.045, rx: 0.32, ry: 0.25, rz: 0.38 };
    const readyNew = { x: -0.072, y: -0.195, z: 0.018, rx: 0.14, ry: 0.14, rz: 0.18 };
    const alignWell = { x: -0.016, y: -0.175, z: 0.019, rx: 0.06, ry: 0.05, rz: 0.10 };
    const seatWell = { x: -0.016, y: -0.134, z: 0.019, rx: 0.04, ry: 0.02, rz: 0.08 };
    const boltFwd = { x: -0.055, y: 0.012, z: -0.005, rx: -0.18, ry: 0.22, rz: -0.14 };
    const boltBack = { x: -0.055, y: 0.010, z: 0.065, rx: -0.14, ry: 0.20, rz: -0.10 };

    let hx = rest.x;
    let hy = rest.y;
    let hz = rest.z;
    let hrx = 0;
    let hry = 0;
    let hrz = 0;

    if (t < 110) {
      // Stage ①: left hand moves smoothly from handguard to magazine base
      const u = segment(t, 0, 110, easeInOutCubic);
      hx = lerp(rest.x, gripMag.x, u);
      hy = lerp(rest.y, gripMag.y, u);
      hz = lerp(rest.z, gripMag.z, u);
      hrx = lerp(0, gripMag.rx, u);
      hry = lerp(0, gripMag.ry, u);
      hrz = lerp(0, gripMag.rz, u);
    } else if (t < 200) {
      // Stage ②a: hand strips old mag downward (visible right beside detached mag!)
      const u = segment(t, 110, 200, easeOutCubic);
      hx = lerp(gripMag.x, stripMag.x, u);
      hy = lerp(gripMag.y, stripMag.y, u);
      hz = lerp(gripMag.z, stripMag.z, u);
      hrx = lerp(gripMag.rx, stripMag.rx, u);
      hry = lerp(gripMag.ry, stripMag.ry, u);
      hrz = lerp(gripMag.rz, stripMag.rz, u);
    } else if (t < 250) {
      // Stage ②b: hand dips down-left to grab fresh magazine from pouch
      const u = segment(t, 200, 250, easeInOutCubic);
      hx = lerp(stripMag.x, pouchLow.x, u);
      hy = lerp(stripMag.y, pouchLow.y, u);
      hz = lerp(stripMag.z, pouchLow.z, u);
      hrx = lerp(stripMag.rx, pouchLow.rx, u);
      hry = lerp(stripMag.ry, pouchLow.ry, u);
      hrz = lerp(stripMag.rz, pouchLow.rz, u);
    } else if (t < 330) {
      // Stage ③: hand rises from bottom-left carrying fresh magazine visibly into frame
      const u = segment(t, 250, 330, easeInOutCubic);
      hx = lerp(pouchLow.x, readyNew.x, u);
      hy = lerp(pouchLow.y, readyNew.y, u);
      hz = lerp(pouchLow.z, readyNew.z, u);
      hrx = lerp(pouchLow.rx, readyNew.rx, u);
      hry = lerp(pouchLow.ry, readyNew.ry, u);
      hrz = lerp(pouchLow.rz, readyNew.rz, u);
    } else if (t < 430) {
      // Stage ④a: align fresh magazine directly beneath magwell
      const u = segment(t, 330, 430, easeInOutCubic);
      hx = lerp(readyNew.x, alignWell.x, u);
      hy = lerp(readyNew.y, alignWell.y, u);
      hz = lerp(readyNew.z, alignWell.z, u);
      hrx = lerp(readyNew.rx, alignWell.rx, u);
      hry = lerp(readyNew.ry, alignWell.ry, u);
      hrz = lerp(readyNew.rz, alignWell.rz, u);
    } else if (t < 560) {
      // Stage ④b: push new mag into magwell; final 40ms (520–560ms) has easeOutBack overshoot bounce!
      const pushU = segment(t, 430, 520, easeInOutCubic);
      const seatBack = t >= 520 ? easeOutBack(clamp01((t - 520) / 40), 2.4) : 0;
      const pushTotal = t < 520 ? pushU * 0.85 : 0.85 + seatBack * 0.15;
      hx = lerp(alignWell.x, seatWell.x, pushTotal);
      hy = lerp(alignWell.y, seatWell.y, pushTotal);
      hz = lerp(alignWell.z, seatWell.z, pushTotal);
      hrx = lerp(alignWell.rx, seatWell.rx, clamp01(pushTotal));
      hry = lerp(alignWell.ry, seatWell.ry, clamp01(pushTotal));
      hrz = lerp(alignWell.rz, seatWell.rz, clamp01(pushTotal));
    } else if (t < 630) {
      // Stage ⑤a: left hand moves up to left-side charging handle
      const u = segment(t, 560, 630, easeInOutCubic);
      hx = lerp(seatWell.x, boltFwd.x, u);
      hy = lerp(seatWell.y, boltFwd.y, u);
      hz = lerp(seatWell.z, boltFwd.z, u);
      hrx = lerp(seatWell.rx, boltFwd.rx, u);
      hry = lerp(seatWell.ry, boltFwd.ry, u);
      hrz = lerp(seatWell.rz, boltFwd.rz, u);
    } else if (t < 700) {
      // Stage ⑤b: pull charging handle rearward
      const u = segment(t, 630, 700, easeOutCubic);
      hx = lerp(boltFwd.x, boltBack.x, u);
      hy = lerp(boltFwd.y, boltBack.y, u);
      hz = lerp(boltFwd.z, boltBack.z, u);
      hrx = lerp(boltFwd.rx, boltBack.rx, u);
      hry = lerp(boltFwd.ry, boltBack.ry, u);
      hrz = lerp(boltFwd.rz, boltBack.rz, u);
    } else if (t < 760) {
      // Stage ⑤c: release charging handle forward
      const u = segment(t, 700, 760, easeOutCubic);
      hx = lerp(boltBack.x, boltFwd.x, u);
      hy = lerp(boltBack.y, boltFwd.y, u);
      hz = lerp(boltBack.z, boltFwd.z, u);
      hrx = lerp(boltBack.rx, boltFwd.rx, u);
      hry = lerp(boltBack.ry, boltFwd.ry, u);
      hrz = lerp(boltBack.rz, boltFwd.rz, u);
    } else {
      // Stage ⑥: glide smoothly back onto handguard
      const u = segment(t, 760, 960, easeInOutCubic);
      hx = lerp(boltFwd.x, rest.x, u);
      hy = lerp(boltFwd.y, rest.y, u);
      hz = lerp(boltFwd.z, rest.z, u);
      hrx = lerp(boltFwd.rx, 0, u);
      hry = lerp(boltFwd.ry, 0, u);
      hrz = lerp(boltFwd.rz, 0, u);
    }

    gun.leftArm.position.set(hx, hy, hz);
    gun.leftArm.rotation.set(hrx, hry, hrz);

    // Fresh magazine held in left hand from 250ms until seated at 560ms
    const carryingFresh = t >= 250 && t < 560;
    if (gun.heldMag) {
      gun.heldMag.visible = carryingFresh;
    }

    // Charging handle slide synced to stage ⑤ (630–760ms)
    const boltPull = pulse(t, 630, 700, 760, easeOutCubic, easeOutCubic);
    gun.bolt.position.set(
      gun.boltRestPos.x,
      gun.boltRestPos.y,
      gun.boltRestPos.z + boltPull * 0.068,
    );

    this.animDebug.magDetached = !magSeated;
    this.animDebug.newMagInHand = carryingFresh;
  }

  /**
   * Shell-by-shell reload (Shotgun & Sniper):
   * - Lead tilt / bolt open
   * - Each shell (350ms): port opens → left hand lifts shell from bottom-left & pushes in
   *   with easeOutBack → subtle barrel tremor
   * - Final 400ms after last shell: pump rack / bolt close & receiver slap (1.5° kick)
   * - Smooth settle return to tactical ready
   */
  private applyShellReload(
    gun: ArticulatedGun,
    id: 'shotgun' | 'sniper',
    snap: ReloadSnapshot,
  ): void {
    const t = snap.elapsedMs;
    const isSniper = id === 'sniper';
    const leadMs = isSniper ? 400 : 100;
    const perShellMs = 350;
    const slapMs = 400;
    const shells = Math.max(1, snap.shellsTotal);
    const shellsEnd = leadMs + shells * perShellMs;
    const slapEnd = shellsEnd + slapMs;
    const totalEnd = snap.durationMs;

    const enter = segment(t, 0, leadMs, easeInOutCubic);
    const exit = segment(t, slapEnd, totalEnd, easeInOutCubic);
    const poseW = enter * (1 - exit);

    // Per-shell cycle
    let shellTremor = 0;
    let portOpen = 0;
    let shellVisible = false;

    const rest = gun.leftRestPos;
    const lowPouch = { x: -0.22, y: -0.24, z: 0.04 };
    const gateApproach = { x: -0.06, y: -0.075, z: 0.01 };
    const gateInsert = { x: 0.008, y: -0.015, z: -0.008 };

    let hx = rest.x;
    let hy = rest.y;
    let hz = rest.z;
    let hrx = 0;
    let hry = 0;
    let hrz = 0;

    if (t < leadMs) {
      const u = segment(t, 0, leadMs, easeInOutCubic);
      hx = lerp(rest.x, lowPouch.x, u);
      hy = lerp(rest.y, lowPouch.y, u);
      hz = lerp(rest.z, lowPouch.z, u);
      hrx = lerp(0, 0.24, u);
      hrz = lerp(0, 0.25, u);
      portOpen = u;
    } else if (t < shellsEnd) {
      const st = (t - leadMs) % perShellMs; // 0..350ms per shell
      portOpen = 1;
      shellVisible = st < 285;
      if (st < 130) {
        // Lift shell from bottom-left up to loading port
        const u = segment(st, 0, 130, easeInOutCubic);
        hx = lerp(lowPouch.x, gateApproach.x, u);
        hy = lerp(lowPouch.y, gateApproach.y, u);
        hz = lerp(lowPouch.z, gateApproach.z, u);
        hrx = lerp(0.24, 0.08, u);
        hrz = lerp(0.25, 0.12, u);
      } else if (st < 280) {
        // Push shell into port with easeOutBack finish
        const u = easeOutBack(clamp01((st - 130) / 150), 1.6);
        hx = lerp(gateApproach.x, gateInsert.x, u);
        hy = lerp(gateApproach.y, gateInsert.y, u);
        hz = lerp(gateApproach.z, gateInsert.z, u);
        hrx = 0.08;
        hrz = 0.12;
      } else {
        // Withdraw hand down-left for next shell
        const u = segment(st, 280, 350, easeInOutCubic);
        hx = lerp(gateInsert.x, lowPouch.x, u);
        hy = lerp(gateInsert.y, lowPouch.y, u);
        hz = lerp(gateInsert.z, lowPouch.z, u);
        hrx = lerp(0.08, 0.24, u);
        hrz = lerp(0.12, 0.25, u);
      }
      // Subtle barrel tremor right as shell clicks home (220–320ms)
      shellTremor = pulse(st, 220, 260, 325, easeOutCubic, easeOutCubic);
    } else if (t < slapEnd) {
      // Final 400ms: pump rack (shotgun) or bolt close & slap (sniper)
      const st = t - shellsEnd;
      portOpen = 1 - segment(st, 180, 320, easeInOutCubic);
      if (!isSniper && gun.pump) {
        // Shotgun: left hand returns to pump (0..120ms), pulls pump back (120..240ms), slams forward (240..360ms)
        const toPump = segment(st, 0, 120, easeInOutCubic);
        const rack = pulse(st, 120, 240, 360, easeInOutCubic, easeOutBack);
        hx = lerp(lowPouch.x, rest.x, toPump);
        hy = lerp(lowPouch.y, rest.y, toPump);
        hz = lerp(lowPouch.z, rest.z, toPump) + rack * 0.085;
        gun.pump.position.z = rack * 0.085;
        shellTremor = pulse(st, 280, 325, 395, easeOutCubic, easeOutCubic) * 1.4;
      } else {
        // Sniper: slap bolt closed + return hand toward handguard
        const toRest = segment(st, 160, 400, easeInOutCubic);
        hx = lerp(gateInsert.x, rest.x, toRest);
        hy = lerp(gateInsert.y, rest.y, toRest);
        hz = lerp(gateInsert.z, rest.z, toRest);
        shellTremor = pulse(st, 200, 250, 340, easeOutCubic, easeOutCubic) * 1.5;
      }
    } else {
      const u = segment(t, slapEnd, totalEnd, easeInOutCubic);
      hx = rest.x;
      hy = rest.y;
      hz = rest.z;
      portOpen = 0;
      if (gun.pump) gun.pump.position.z = lerp(gun.pump.position.z, 0, u);
    }

    gun.leftArm.position.set(hx, hy, hz);
    gun.leftArm.rotation.set(hrx, hry, hrz);
    if (gun.heldShell) gun.heldShell.visible = shellVisible;
    if (gun.portCover) gun.portCover.position.z = portOpen * 0.052;

    if (isSniper) {
      // Sniper bolt lifts up 55° & slides rearward while breech is open
      const boltOpen =
        segment(t, 40, 260, easeInOutCubic) *
        (1 - segment(t, shellsEnd + 80, shellsEnd + 280, easeInOutCubic));
      const lift =
        segment(t, 0, 140, easeInOutCubic) *
        (1 - segment(t, shellsEnd + 200, shellsEnd + 360, easeInOutCubic));
      gun.bolt.position.set(
        gun.boltRestPos.x,
        gun.boltRestPos.y,
        gun.boltRestPos.z + boltOpen * 0.068,
      );
      gun.bolt.rotation.z = lift * 0.95;
    }

    const slapKick =
      pulse(t, slapEnd - 150, slapEnd - 90, slapEnd, easeOutCubic, easeOutCubic) *
      ((1.5 * Math.PI) / 180);

    this.reloadGunPos.set(
      lerp(0, -0.055, poseW),
      lerp(0, 0.032, poseW) + shellTremor * 0.008,
      lerp(0, -0.075, poseW) + slapKick * 0.35,
    );
    this.reloadGunRot.set(
      lerp(0, -0.10, poseW) + shellTremor * 0.025 + slapKick,
      lerp(0, 0.24, poseW),
      lerp(0, -0.18, poseW), // cant right to display breech/loading gate clearly
    );
    this.reloadSightDipRad = -(1.4 * Math.PI) / 180 * poseW;

    this.animDebug.magDetached = portOpen > 0.3;
    this.animDebug.newMagInHand = shellVisible;
  }

  update(dt: number, bob?: { x: number; y: number }, reload?: ReloadSnapshot): void {
    this.time += dt;
    if (this.kick > 0) this.kick = Math.max(0, this.kick - dt / Math.max(0.04, this.kickDur));
    const k = easeOutCubic(this.kick);
    const kickScale = this.kickDeg / 2.5;

    this.bobX = damp(this.bobX, (bob?.x ?? 0) * 0.85, 14, dt);
    this.bobY = damp(this.bobY, (bob?.y ?? 0) * 0.75, 14, dt);

    // Continuous 0.35s weapon swap arc
    if (this.swapActive) {
      const half = this.swapDuration * 0.5;
      const prev = this.swapElapsed;
      this.swapElapsed = Math.min(this.swapDuration, this.swapElapsed + dt);
      if (prev < half && this.swapElapsed >= half && this.swapPending) {
        this.resetReloadPose(this.guns.get(this.current)!);
        this.guns.get(this.current)!.root.visible = false;
        this.current = this.swapPending;
        this.guns.get(this.current)!.root.visible = true;
        this.resetReloadPose(this.guns.get(this.current)!);
        this.flash.position.z = this.guns.get(this.current)!.muzzleZ;
        this.kick = 0;
        this.reloadBlend = 0;
        this.swapPending = null;
      }
      if (this.swapElapsed < half) {
        const u = easeInCubic(this.swapElapsed / half);
        this.swapDropY = -0.36 * u;
        this.swapDropPitch = -0.48 * u;
      } else {
        const u = clamp01((this.swapElapsed - half) / half);
        const rise = 1 - easeOutBack(u, 0.9);
        this.swapDropY = -0.36 * rise;
        this.swapDropPitch = -0.48 * rise;
      }
      if (this.swapElapsed >= this.swapDuration) {
        this.swapActive = false;
        this.swapDropY = 0;
        this.swapDropPitch = 0;
      }
    }

    // Articulated reload animation (blended smoothly so early-fire cancel never snaps)
    const gun = this.guns.get(this.current)!;
    const isReloading = Boolean(reload?.active) && !this.swapActive;
    this.animDebug.reloadActive = isReloading;
    this.animDebug.reloadElapsedMs = isReloading ? reload!.elapsedMs : 0;
    this.animDebug.reloadDurationMs = isReloading ? reload!.durationMs : 0;
    this.animDebug.swapActive = this.swapActive;

    if (isReloading && reload) {
      this.reloadBlend = damp(this.reloadBlend, 1, 28, dt);
      if (this.current === 'rifle') {
        this.applyRifleReload(gun, reload.elapsedMs);
      } else {
        this.applyShellReload(gun, this.current, reload);
      }
    } else {
      this.animDebug.magDetached = false;
      this.animDebug.newMagInHand = false;
      this.reloadBlend = damp(this.reloadBlend, 0, 18, dt);
      this.reloadSightDipRad = damp(this.reloadSightDipRad, 0, 18, dt);
      // Smoothly ease parts back to rest if reload ended early
      gun.leftArm.position.lerp(gun.leftRestPos, 1 - Math.exp(-18 * dt));
      gun.leftArm.rotation.x = damp(gun.leftArm.rotation.x, 0, 18, dt);
      gun.leftArm.rotation.y = damp(gun.leftArm.rotation.y, 0, 18, dt);
      gun.leftArm.rotation.z = damp(gun.leftArm.rotation.z, 0, 18, dt);
      gun.bolt.position.lerp(gun.boltRestPos, 1 - Math.exp(-18 * dt));
      gun.bolt.rotation.z = damp(gun.bolt.rotation.z, 0, 18, dt);
      if (gun.portCover) gun.portCover.position.z = damp(gun.portCover.position.z, 0, 18, dt);
      if (gun.pump) gun.pump.position.z = damp(gun.pump.position.z, 0, 18, dt);
      if (gun.mag) {
        gun.mag.visible = true;
        gun.mag.position.lerp(gun.magRestPos, 1 - Math.exp(-22 * dt));
      }
      if (gun.dropMag) gun.dropMag.visible = false;
      if (gun.heldMag) gun.heldMag.visible = false;
      if (gun.heldShell) gun.heldShell.visible = false;
      if (this.reloadBlend < 0.002) {
        this.reloadBlend = 0;
        this.reloadGunPos.set(0, 0, 0);
        this.reloadGunRot.set(0, 0, 0);
      }
    }

    const breathe = Math.sin(this.time * 1.7) * 0.002;
    const sway = Math.sin(this.time * 1.15) * 0.0015;
    let px = this.basePos.x;
    const cam = this.group.parent as THREE.PerspectiveCamera | null;
    if (cam?.isPerspectiveCamera) {
      const halfW =
        Math.tan((cam.fov * Math.PI) / 360) * Math.abs(this.basePos.z) * cam.aspect;
      px = Math.min(px, Math.max(0.11, halfW * 0.7));
    }

    const rb = this.reloadBlend;
    this.group.position.set(
      px + sway + this.bobX + this.reloadGunPos.x * rb,
      this.basePos.y - k * 0.018 * Math.min(2.2, kickScale) + breathe + this.bobY + this.swapDropY + this.reloadGunPos.y * rb,
      this.basePos.z + k * 0.058 * Math.min(2.2, kickScale) + this.reloadGunPos.z * rb,
    );
    this.group.rotation.set(
      this.baseRot.x + k * 0.075 * Math.min(2.4, kickScale) + breathe * 0.6 + this.swapDropPitch + this.reloadGunRot.x * rb,
      this.baseRot.y + sway * 0.5 + this.reloadGunRot.y * rb,
      this.baseRot.z + this.reloadGunRot.z * rb,
    );

    if (this.flashT > 0) {
      this.flashT -= dt;
      const t = Math.max(0, this.flashT / 0.055);
      MAT.flash.opacity = t;
      MAT.flashCore.opacity = t;
      this.flash.visible = t > 0;
    } else {
      this.flash.visible = false;
    }
  }
}

/** Pooled world-space tracer lines (replaced/upgraded in vfx pass). */
export class TracerPool {
  private pool: { line: THREE.Line; mat: THREE.LineBasicMaterial; life: number }[] = [];
  private next = 0;
  private static readonly LIFE = 0.05;

  constructor(scene: THREE.Scene, count = 12) {
    for (let i = 0; i < count; i++) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      const mat = new THREE.LineBasicMaterial({
        color: PALETTE.tracer,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const line = new THREE.Line(geo, mat);
      line.frustumCulled = false;
      line.visible = false;
      scene.add(line);
      this.pool.push({ line, mat, life: 0 });
    }
  }

  fire(from: Vec3 | THREE.Vector3, to: Vec3 | THREE.Vector3): void {
    const slot = this.pool[this.next];
    this.next = (this.next + 1) % this.pool.length;
    const pos = slot.line.geometry.getAttribute('position') as THREE.BufferAttribute;
    pos.setXYZ(0, from.x, from.y, from.z);
    pos.setXYZ(1, to.x, to.y, to.z);
    pos.needsUpdate = true;
    slot.life = TracerPool.LIFE;
    slot.line.visible = true;
  }

  update(dt: number): void {
    for (const s of this.pool) {
      if (s.life <= 0) continue;
      s.life -= dt;
      const t = Math.max(0, s.life / TracerPool.LIFE);
      s.mat.opacity = t * 0.9;
      if (s.life <= 0) s.line.visible = false;
    }
  }
}
