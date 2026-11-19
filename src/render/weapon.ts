// First-person weapon view — three guns built from primitives (zero assets),
// recoil kick + a short-lived muzzle flash, and a pooled tracer line set.
// The group is attached to the camera; all colors come from palette.ts.

import * as THREE from 'three';
import { PALETTE } from './palette';
import type { WeaponSpec } from '../game/weapons';
import type { Vec3 } from '../game/player';

type GunId = WeaponSpec['id'];

const MAT = {
  body: new THREE.MeshLambertMaterial({ color: PALETTE.gun[0] }),
  mid: new THREE.MeshLambertMaterial({ color: PALETTE.gun[1] }),
  bright: new THREE.MeshLambertMaterial({ color: PALETTE.gun[2] }),
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

function box(w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  return mesh;
}

function cylinder(r: number, len: number, m: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 10), m);
  mesh.rotation.x = Math.PI / 2; // axis → z
  mesh.position.set(x, y, z);
  return mesh;
}

/** Build a gun model; returns the group and the muzzle-tip local z. */
function buildModel(id: GunId): { group: THREE.Group; muzzleZ: number } {
  const g = new THREE.Group();
  if (id === 'rifle') {
    g.add(box(0.055, 0.09, 0.4, MAT.body, 0, 0, -0.08)); // receiver
    g.add(cylinder(0.013, 0.3, MAT.mid, 0, 0.012, -0.42)); // barrel
    g.add(box(0.045, 0.13, 0.06, MAT.mid, 0, -0.1, -0.04)); // magazine
    g.add(box(0.05, 0.07, 0.18, MAT.body, 0, -0.005, 0.2)); // stock
    const grip = box(0.04, 0.1, 0.05, MAT.body, 0, -0.07, 0.08);
    grip.rotation.x = 0.35;
    g.add(grip);
    g.add(box(0.02, 0.03, 0.12, MAT.bright, 0, 0.06, -0.02)); // sight rib
    return { group: g, muzzleZ: -0.58 };
  }
  if (id === 'sniper') {
    g.add(box(0.05, 0.08, 0.5, MAT.body, 0, 0, -0.05)); // long receiver
    g.add(cylinder(0.011, 0.5, MAT.mid, 0, 0.008, -0.6)); // long barrel
    g.add(cylinder(0.024, 0.15, MAT.bright, 0, 0.065, -0.05)); // scope
    g.add(box(0.04, 0.11, 0.05, MAT.mid, 0, -0.09, 0.0)); // magazine
    g.add(box(0.05, 0.07, 0.17, MAT.body, 0, -0.005, 0.26)); // stock
    const grip = box(0.038, 0.09, 0.045, MAT.body, 0, -0.065, 0.13);
    grip.rotation.x = 0.3;
    g.add(grip);
    return { group: g, muzzleZ: -0.86 };
  }
  // shotgun: twin barrels + pump
  g.add(box(0.075, 0.09, 0.36, MAT.body, 0, 0, -0.06)); // wide receiver
  g.add(cylinder(0.016, 0.46, MAT.mid, -0.02, 0.012, -0.42)); // barrel L
  g.add(cylinder(0.016, 0.46, MAT.mid, 0.02, 0.012, -0.42)); // barrel R
  g.add(box(0.07, 0.045, 0.13, MAT.bright, 0, -0.045, -0.34)); // pump
  g.add(box(0.055, 0.07, 0.16, MAT.body, 0, -0.005, 0.22)); // stock
  const grip = box(0.04, 0.09, 0.05, MAT.body, 0, -0.065, 0.1);
  grip.rotation.x = 0.35;
  g.add(grip);
  return { group: g, muzzleZ: -0.66 };
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
  private readonly basePos = new THREE.Vector3(0.27, -0.25, -0.5);
  private readonly baseRot = new THREE.Euler(0, 0, 0); // models are built muzzle-forward (-z)

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
    this.group.position.set(
      this.basePos.x + sway,
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
