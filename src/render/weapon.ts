// First-person weapon view — three guns built from primitives (zero assets),
// recoil kick + a short-lived muzzle flash, and a pooled tracer line set.
// The group is attached to the camera; all colors come from palette.ts.
//
// Construction follows the Saltline PAC-9 viewmodel approach: a real gun is a
// stack of purpose-built parts, not a few big boxes. Receiver/stock/magazine/
// grip are extruded side-profiles (like Saltline's xr()); the handguard is a
// faceted tube with spaced vent slots; sight, rail, muzzle device, trigger and
// two gloves are separate pieces. Parts are merged per-material so each gun
// stays a handful of draw calls. Proportions follow a real carbine
// (length ≈ 4.5× height).

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PALETTE } from './palette';
import { getMaterial } from './materials';
import type { WeaponSpec } from '../game/weapons';
import type { Vec3 } from '../game/player';

type GunId = WeaponSpec['id'];
type MatKey = 'metal' | 'poly' | 'mag' | 'edge' | 'glove' | 'cuff';

const MAT: Record<MatKey, THREE.Material> & {
  flash: THREE.MeshBasicMaterial;
  flashCore: THREE.MeshBasicMaterial;
} = {
  metal: getMaterial('gunMetal'), // receiver / barrel / rail / sights / muzzle
  poly: getMaterial('gunPoly'), // handguard / stock / grip / pump
  mag: getMaterial('gunMag'), // magazine + small dark fittings
  edge: getMaterial('gunEdge'), // 1–2px highlight strip along the top edge
  glove: getMaterial('glove'), // hands — a step brighter than the gun
  cuff: getMaterial('rail'), // wrist cuff — small bright accent
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

/** Sphere (sight beads, bolt knobs). */
const sph = (
  p: Parts,
  mat: MatKey,
  r: number,
  x = 0,
  y = 0,
  z = 0,
): void => {
  p.push({ mat, geo: place(new THREE.SphereGeometry(r, 8, 6), x, y, z) });
};

/**
 * Extruded side-profile — Saltline's xr(): the gun's silhouette drawn in the
 * (z, y) plane (-z is the muzzle direction) and thickened across x with a
 * small chamfer so edges catch light instead of reading as raw boxes.
 */
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
  geo.rotateY(Math.PI / 2); // shape x (-z) → -z; extrusion dir → +x
  geo.translate(-thickness / 2, 0, 0);
  p.push({ mat, geo });
};

function mergeParts(parts: Parts, group: THREE.Group): void {
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
    const mesh = new THREE.Mesh(merged, MAT[mat]);
    mesh.frustumCulled = false;
    group.add(mesh);
  }
}

/** Full-length top rail + transverse ridges (picatinny look). */
function addRail(p: Parts, z0: number, z1: number, y: number): void {
  const len = z1 - z0;
  box(p, 'metal', 0.034, 0.007, len, 0, y, (z0 + z1) / 2);
  const n = Math.floor(len / 0.023);
  for (let i = 0; i <= n; i++) {
    box(p, 'metal', 0.036, 0.005, 0.006, 0, y + 0.0055, z0 + 0.012 + i * 0.023);
  }
  // 1–2px bright arris along the rail's top-left edge — reads as worn metal
  box(p, 'edge', 0.0035, 0.0035, len - 0.01, -0.0165, y + 0.0055, (z0 + z1) / 2);
}

/** Faceted handguard tube + spaced vent slots on the upper-left face. */
function addHandguard(p: Parts, zFront: number, zRear: number, r: number, y = 0): void {
  const len = zRear - zFront;
  const geo = new THREE.CylinderGeometry(r, r, len, 8);
  geo.rotateX(Math.PI / 2);
  geo.rotateZ(Math.PI / 8); // flat faces land on the diagonals
  p.push({ mat: 'poly', geo: place(geo, 0, y, (zFront + zRear) / 2) });
  // vent slots punched along the visible upper-left flat
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
  // front cap ring
  cylZ(p, 'metal', r + 0.002, 0.009, 0, y, zFront + 0.005, 8);
}

/** Compensator / muzzle device: body + ring grooves. */
function addMuzzleDevice(p: Parts, z: number): void {
  cylZ(p, 'metal', 0.0115, 0.048, 0, 0, z, 12);
  for (let i = 0; i < 3; i++) cylZ(p, 'metal', 0.0132, 0.005, 0, 0, z + 0.014 - i * 0.014, 12);
}

/** Flip-up iron sights: rear aperture + front post, both on the rail line. */
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

/** Trigger + guard loop under the receiver, just ahead of the grip. */
function addTriggerGroup(p: Parts, z: number, yBase: number): void {
  box(p, 'metal', 0.0025, 0.014, 0.034, -0.009, yBase - 0.014, z);
  box(p, 'metal', 0.0025, 0.014, 0.034, 0.009, yBase - 0.014, z);
  box(p, 'metal', 0.018, 0.003, 0.034, 0, yBase - 0.022, z);
  box(p, 'mag', 0.005, 0.017, 0.006, 0, yBase - 0.009, z + 0.006, -0.18, 0, 0);
}

/** Raked pistol grip as an extruded profile (Saltline does the same). */
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

/** Curved box magazine: extruded profile bowing toward the muzzle. */
function addMagazine(p: Parts, z: number, yTop: number, depth = 0.1): void {
  extrudeZY(
    p,
    'mag',
    [
      [z + 0.018, yTop],
      [z - 0.022, yTop],
      [z - 0.038, yTop - depth * 0.55],
      [z - 0.03, yTop - depth],
      [z + 0.002, yTop - depth - 0.008],
      [z + 0.024, yTop - depth * 0.7],
    ],
    0.024,
    0.0012,
  );
  box(p, 'mag', 0.026, 0.007, 0.052, 0, yTop - depth - 0.006, z - 0.008, -0.16, 0, 0);
}

/**
 * Two low-poly gloves so the gun isn't floating: palm + thumb + finger blocks
 * wrap the grip (rear hand) and the handguard/pump (support hand); forearm
 * stubs and bright cuffs trail down-right toward the screen edge.
 */
function addArms(p: Parts, supportZ: number, supportUnder = -0.024): void {
  // ---- support hand: cups the handguard/pump from below ----
  const sz = supportZ;
  box(p, 'glove', 0.048, 0.026, 0.076, -0.002, supportUnder - 0.012, sz); // palm
  box(p, 'glove', 0.014, 0.030, 0.070, -0.021, supportUnder + 0.008, sz); // hand back, left side
  // fingers over the top of the tube — four angled blocks
  for (let i = 0; i < 4; i++) {
    box(
      p,
      'glove',
      0.024,
      0.009,
      0.013,
      -0.007,
      supportUnder + 0.030,
      sz + 0.024 - i * 0.016,
      0,
      0,
      0.22,
    );
  }
  // thumb curled onto the far (right) side
  box(p, 'glove', 0.013, 0.011, 0.030, 0.0175, supportUnder + 0.006, sz + 0.01, 0, -0.15, 0);
  // forearm stub + cuff trailing toward the bottom-right corner
  box(p, 'glove', 0.054, 0.048, 0.15, 0.035, supportUnder - 0.052, sz + 0.11, 0.5, -0.35, 0);
  box(p, 'cuff', 0.058, 0.052, 0.028, 0.024, supportUnder - 0.032, sz + 0.062, 0.5, -0.35, 0);

  // ---- rear hand: grips the pistol grip ----
  box(p, 'glove', 0.022, 0.062, 0.036, 0.022, -0.062, 0.104, 0.28, 0, 0); // hand back on the right
  box(p, 'glove', 0.030, 0.017, 0.032, 0.006, -0.028, 0.094); // knuckle bridge over the grip
  for (let i = 0; i < 3; i++) {
    box(p, 'glove', 0.017, 0.0135, 0.015, -0.009, -0.043 - i * 0.0175, 0.075 + i * 0.003, 0.45, 0, 0);
  }
  // thumb across the grip's left shoulder + index onto the trigger
  box(p, 'glove', 0.013, 0.010, 0.026, -0.008, -0.031, 0.082, 0, 0.3, 0);
  box(p, 'glove', 0.008, 0.010, 0.022, -0.005, -0.036, 0.060);
  // forearm stub + cuff
  box(p, 'glove', 0.056, 0.050, 0.16, 0.048, -0.138, 0.20, 0.55, -0.3, 0);
  box(p, 'cuff', 0.060, 0.054, 0.028, 0.033, -0.108, 0.142, 0.55, -0.3, 0);
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
  // ejection port + bolt catch read as dark insets on the flanks
  box(p, 'mag', 0.002, 0.013, 0.048, 0.0208, 0.006, 0.012);
  box(p, 'mag', 0.002, 0.01, 0.016, -0.0208, -0.002, 0.034);
  box(p, 'metal', 0.03, 0.007, 0.022, 0, 0.03, 0.132); // charging handle
}

function addStock(p: Parts, cheek = 0.012): void {
  extrudeZY(p, 'poly', STOCK_PROFILE, 0.036, 0.002);
  box(p, 'poly', 0.03, cheek, 0.085, 0, 0.03 + cheek * 0.4, 0.19, -0.05, 0, 0); // cheek riser
  box(p, 'poly', 0.039, 0.072, 0.01, 0, -0.028, 0.341, -0.05, 0, 0); // butt pad
}

// --- the three guns -----------------------------------------------------------

function buildRifle(p: Parts): number {
  addReceiver(p);
  addRail(p, -0.385, 0.115, 0.036); // rail top y≈0.043
  addHandguard(p, -0.395, -0.105, 0.024, 0.002);
  cylZ(p, 'metal', 0.0085, 0.16, 0, 0.002, -0.477); // barrel
  box(p, 'metal', 0.02, 0.02, 0.026, 0, 0.008, -0.46); // gas block
  cylZ(p, 'metal', 0.0035, 0.055, 0, 0.0175, -0.435, 6); // gas tube line
  addMuzzleDevice(p, -0.578);
  addMagazine(p, 0.011, -0.052);
  addStock(p);
  addGrip(p, 0.098, -0.02);
  addTriggerGroup(p, 0.058, -0.024);
  addSights(p, 0.098, -0.385, 0.044);
  addArms(p, -0.26);
  return -0.604;
}

function buildSniper(p: Parts): number {
  addReceiver(p);
  addRail(p, -0.10, 0.115, 0.036);
  addHandguard(p, -0.415, -0.105, 0.021, 0.0);
  cylZ(p, 'metal', 0.007, 0.42, 0, 0.002, -0.62, 12); // long barrel
  // muzzle brake: wider body + two baffle rings
  cylZ(p, 'metal', 0.0135, 0.055, 0, 0.002, -0.838, 12);
  cylZ(p, 'metal', 0.0152, 0.006, 0, 0.002, -0.826, 12);
  cylZ(p, 'metal', 0.0152, 0.006, 0, 0.002, -0.848, 12);
  // scope: tube + objective bell + eyepiece + two ring mounts
  cylZ(p, 'metal', 0.017, 0.17, 0, 0.068, -0.01, 12);
  cylZ(p, 'metal', 0.0225, 0.038, 0, 0.068, -0.105, 12, 0.017);
  cylZ(p, 'metal', 0.0195, 0.03, 0, 0.068, 0.085, 12);
  box(p, 'metal', 0.009, 0.022, 0.014, 0, 0.049, -0.048);
  box(p, 'metal', 0.009, 0.022, 0.014, 0, 0.049, 0.052);
  cylZ(p, 'edge', 0.019, 0.0015, 0, 0.068, -0.125, 12); // lens glint
  // bolt handle on the right flank + short mag
  const bolt = new THREE.CylinderGeometry(0.004, 0.004, 0.02, 6);
  bolt.rotateZ(Math.PI / 2); // axis → +x
  p.push({ mat: 'metal', geo: place(bolt, 0.026, 0.008, 0.055) });
  sph(p, 'metal', 0.0085, 0.036, 0.008, 0.055);
  addMagazine(p, 0.008, -0.05, 0.062);
  addStock(p, 0.022);
  addGrip(p, 0.098, -0.02);
  addTriggerGroup(p, 0.058, -0.024);
  // folded bipod legs flush under the handguard
  box(p, 'metal', 0.006, 0.012, 0.11, -0.016, -0.028, -0.36);
  box(p, 'metal', 0.006, 0.012, 0.11, 0.016, -0.028, -0.36);
  addArms(p, -0.30, -0.021);
  return -0.87;
}

function buildShotgun(p: Parts): number {
  // receiver without a magwell — the mag is a tube under the barrel
  extrudeZY(
    p,
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
  box(p, 'mag', 0.002, 0.014, 0.055, 0.0218, 0.004, -0.01); // loading gate
  box(p, 'metal', 0.03, 0.007, 0.022, 0, 0.03, 0.132); // charging handle
  // barrel + underbarrel mag tube
  cylZ(p, 'metal', 0.012, 0.27, 0, 0.004, -0.525, 12);
  cylZ(p, 'metal', 0.0095, 0.42, 0, -0.03, -0.39, 10);
  cylZ(p, 'metal', 0.0115, 0.012, 0, -0.03, -0.595, 10); // tube cap
  // heat shield over the barrel with top vent slots
  box(p, 'metal', 0.034, 0.011, 0.3, 0, 0.02, -0.42);
  for (let i = 0; i < 5; i++) {
    box(p, 'mag', 0.024, 0.004, 0.018, 0, 0.0262, -0.475 + i * 0.046);
  }
  sph(p, 'edge', 0.0045, 0, 0.0295, -0.645); // brass bead
  // pump — the support hand works this, not a fixed handguard
  box(p, 'poly', 0.046, 0.044, 0.115, 0, -0.024, -0.335);
  for (let i = 0; i < 3; i++) {
    box(p, 'mag', 0.048, 0.004, 0.006, 0, -0.024, -0.365 + i * 0.03);
  }
  addStock(p);
  addGrip(p, 0.098, -0.02);
  addTriggerGroup(p, 0.058, -0.024);
  addArms(p, -0.335, -0.046);
  return -0.662;
}

/** Build a gun model; returns the group and the muzzle-tip local z. */
function buildModel(id: GunId): { group: THREE.Group; muzzleZ: number } {
  const g = new THREE.Group();
  const parts: Parts = [];
  const muzzleZ =
    id === 'rifle' ? buildRifle(parts) : id === 'sniper' ? buildSniper(parts) : buildShotgun(parts);
  mergeParts(parts, g);
  return { group: g, muzzleZ };
}

export class WeaponView {
  readonly group = new THREE.Group();
  private models = new Map<GunId, THREE.Group>();
  private muzzles = new Map<GunId, number>();
  private flash = new THREE.Group();
  private kick = 0;
  private flashT = 0;
  private time = 0;
  private current: GunId = 'rifle';
  // pushed right/down so the muzzle never covers the crosshair's lower half;
  // muzzle cants up ~7° like the Saltline viewmodel, yaw turns the ejection
  // side toward the camera so the body reads as a gun, not a stick
  private readonly basePos = new THREE.Vector3(0.27, -0.265, -0.5);
  private readonly baseRot = new THREE.Euler(0.11, 0.075, 0); // models are built muzzle-forward (-z)

  constructor() {
    for (const id of ['rifle', 'sniper', 'shotgun'] as GunId[]) {
      const { group, muzzleZ } = buildModel(id);
      group.visible = id === this.current;
      this.models.set(id, group);
      this.muzzles.set(id, muzzleZ);
      this.group.add(group);
    }
    // crossed additive planes = cheap flash star, plus a bright core
    const plane = new THREE.PlaneGeometry(0.2, 0.2);
    const p1 = new THREE.Mesh(plane, MAT.flash);
    const p2 = new THREE.Mesh(plane, MAT.flash);
    p2.rotation.z = Math.PI / 4;
    const core = new THREE.Mesh(new THREE.PlaneGeometry(0.09, 0.09), MAT.flashCore);
    this.flash.add(p1, p2, core);
    this.flash.visible = false;
    this.group.add(this.flash);
    this.flash.position.set(0, 0.012, this.muzzles.get(this.current)!);

    this.group.position.copy(this.basePos);
    this.group.rotation.copy(this.baseRot);
  }

  setWeapon(id: GunId): void {
    if (id === this.current) return;
    this.models.get(this.current)!.visible = false;
    this.models.get(id)!.visible = true;
    this.current = id;
    this.flash.position.z = this.muzzles.get(id)!;
    this.kick = 0;
  }

  onFire(): void {
    this.kick = 1;
    this.flashT = 0.055;
    this.flash.rotation.z = Math.random() * Math.PI;
    const s = 0.85 + Math.random() * 0.5;
    this.flash.scale.set(s, s, s);
  }

  /** World-space muzzle tip (for tracer origins). */
  muzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    return this.flash.getWorldPosition(out);
  }

  update(dt: number): void {
    this.time += dt;
    if (this.kick > 0) this.kick = Math.max(0, this.kick - dt * 7);
    const k = this.kick * this.kick; // ease-out feel
    // idle breathing — a few mm of drift so the gun doesn't look frozen
    const breathe = Math.sin(this.time * 1.7) * 0.002;
    const sway = Math.sin(this.time * 1.15) * 0.0015;
    // narrow (portrait) screens pull the gun inward so it stays in frame
    let px = this.basePos.x;
    const cam = this.group.parent as THREE.PerspectiveCamera | null;
    if (cam?.isPerspectiveCamera) {
      const halfW =
        Math.tan((cam.fov * Math.PI) / 360) * Math.abs(this.basePos.z) * cam.aspect;
      px = Math.min(px, Math.max(0.11, halfW * 0.7));
    }
    this.group.position.set(
      px + sway,
      this.basePos.y - k * 0.02 + breathe,
      this.basePos.z + k * 0.07,
    );
    this.group.rotation.set(
      this.baseRot.x + k * 0.09 + breathe * 0.6,
      this.baseRot.y + sway * 0.5,
      this.baseRot.z,
    ); // muzzle rises
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

/** Pooled world-space tracer lines (no per-frame allocation, ART-SPEC §5). */
export class TracerPool {
  private pool: { line: THREE.Line; mat: THREE.LineBasicMaterial; life: number }[] = [];
  private next = 0;
  private static readonly LIFE = 0.09;

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
