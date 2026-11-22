// Boss Controller — connects pure-logic BossAI with a 4.0m scaled placeholder
// procedural robot rig (reusing src/render/robotModel.ts), capsule+head raycast
// hit detection, part classification (head / core / body), melee state
// animations (windup / attack / charge / recover / death), and 0.15s hit recoil.
// Strictly melee-only: zero ranged weapons or projectiles.

import * as THREE from 'three';
import {
  BossAI,
  BOSS_DEFAULTS,
  type BossAIOptions,
  type BossEvent,
  type BossHitPart,
  type BossState,
  type BossTick,
} from './bossAI';
import { CollisionWorld } from './collision';
import { rayBoxT, type Ray } from './damage';
import { MAP, spawnPoint } from './map';
import type { Vec3 } from './player';
import { createRobot, type RobotInstance } from '../render/robotModel';

export const BOSS_TARGET_HEIGHT = 4.0;
export const BOSS_BODY_RADIUS = 0.68;
export const BOSS_HEAD_RATIO = 0.82;
export const BOSS_HEAD_SPHERE_RADIUS = 0.50;
export const BOSS_CORE_RADIUS = 0.50;
export const BOSS_CORE_HEIGHT_RATIO = 0.68;
export const BOSS_CORE_SURFACE_OFFSET = 0.45;
export const BOSS_SPAWN_MIN_DIST = 20;
export const BOSS_SPAWN_MAX_DIST = 25;
export const BOSS_MELEE_DAMAGE = 20;
export const BOSS_HIT_RECOIL_MS = 150;
export const BOSS_HIT_RECOIL_DIST = 0.08;

const EPS = 1e-6;
const HIT_FLASH_MS = 120;
const DEATH_COLLAPSE_SEC = 0.85;
const CORPSE_HOLD_SEC = 2.0;
const CORPSE_FADE_SEC = 0.7;
const CONTACT_SHADOW_DIAMETER = 2.8;
const CONTACT_SHADOW_Y = 0.015;
const CONTACT_SHADOW_OPACITY = 0.78;

export interface BossRayHit {
  dist: number;
  point: Vec3;
  part: BossHitPart;
}

export interface BossAttackHitInfo {
  damage: number;
  dist: number;
  bossPos: Vec3;
}

export interface BossControllerOptions {
  hpMax?: number;
  ai?: BossAIOptions;
  /** Player initial position used to pick a 20-25m Boss spawn from spawnPoint. */
  playerPos?: { x: number; z: number };
  /** Explicit Boss spawn position override. */
  spawnPos?: { x: number; y?: number; z: number };
  /** Melee damage dealt to player when attack_hit fires inside attackRange. */
  meleeDamage?: number;
  onAttackHit?: (info: BossAttackHitInfo) => void;
  onPhaseChange?: (phase: 1 | 2) => void;
  onDefeated?: () => void;
}

let sharedBossShadowTex: THREE.Texture | null = null;
let sharedBossShadowGeo: THREE.PlaneGeometry | null = null;

function makeBossShadowTex(): THREE.Texture {
  if (typeof document === 'undefined') {
    const tex = new THREE.DataTexture(new Uint8Array([12, 16, 24, 180]), 1, 1);
    tex.needsUpdate = true;
    return tex;
  }
  const size = 128;
  const half = size / 2;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(half, half, 0, half, half, half - 2);
  g.addColorStop(0.0, 'rgba(10, 14, 22, 0.76)');
  g.addColorStop(0.35, 'rgba(10, 14, 22, 0.56)');
  g.addColorStop(0.65, 'rgba(10, 14, 22, 0.24)');
  g.addColorStop(1.0, 'rgba(10, 14, 22, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function dampVal(cur: number, target: number, lambda: number, dt: number): number {
  if (dt <= 0) return target;
  return cur + (target - cur) * (1 - Math.exp(-lambda * dt));
}

function yawToTarget(fromX: number, fromZ: number, toX: number, toZ: number): number {
  const dx = toX - fromX;
  const dz = toZ - fromZ;
  if (Math.hypot(dx, dz) <= EPS) return 0;
  return Math.atan2(-dx, -dz);
}

/** Check whether a horizontal sightline from player eye to candidate Boss torso clears all boxes. */
function hasClearSightline(from: Vec3, to: Vec3): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dy, dz);
  if (len <= EPS) return true;
  const dir: Vec3 = { x: dx / len, y: dy / len, z: dz / len };
  for (const b of MAP.boxes) {
    if (b.kind === 'deck') continue;
    const t = rayBoxT(from, dir, b);
    if (t < len - 0.1) return false;
  }
  return true;
}

/**
 * Pick an initial Boss spawn position 20-25m from `playerPos` based on map `spawnPoint`s.
 * Prefers a raw `spawnPoint` if one falls in [20, 25]m; otherwise anchors along the nearest
 * opposite-side `spawnPoint` pulled to 22.5m with box-clearance & unobstructed sightline.
 */
export function selectBossSpawn(playerPos: { x: number; z: number }): Vec3 {
  const world = new CollisionWorld(MAP.boxes, MAP.bounds, MAP.waterY, MAP.walkablePolygon);
  const targetDist = (BOSS_SPAWN_MIN_DIST + BOSS_SPAWN_MAX_DIST) * 0.5;
  const clearanceR = 0.85;
  const eyeFrom: Vec3 = { x: playerPos.x, y: 1.65, z: playerPos.z };

  const isValidSpot = (x: number, y: number, z: number): boolean =>
    world.isInsideWalkable(x, z, clearanceR) &&
    !world.hits(x, y, z, clearanceR, BOSS_TARGET_HEIGHT);

  // 1. Check all raw spawnPoint entries (team B first, then team A) for one already in [20, 25]m
  const allSpawns: [number, number, number][] = [];
  for (let i = 0; i < MAP.spawns.teamB.length; i++) allSpawns.push(spawnPoint('B', i));
  for (let i = 0; i < MAP.spawns.teamA.length; i++) allSpawns.push(spawnPoint('A', i));

  let bestRaw: { pt: Vec3; score: number } | null = null;
  for (const [sx, sy, sz] of allSpawns) {
    const d = Math.hypot(sx - playerPos.x, sz - playerPos.z);
    if (d < BOSS_SPAWN_MIN_DIST || d > BOSS_SPAWN_MAX_DIST) continue;
    if (!isValidSpot(sx, sy, sz)) continue;
    const losBonus = hasClearSightline(eyeFrom, { x: sx, y: sy + 2.0, z: sz }) ? 0 : 10;
    const score = Math.abs(d - targetDist) + losBonus;
    if (!bestRaw || score < bestRaw.score) {
      bestRaw = { pt: { x: sx, y: sy, z: sz }, score };
    }
  }
  if (bestRaw) return bestRaw.pt;

  // 2. Anchor direction toward the nearest opposite-team spawnPoint and sample arc at 22.5m
  let anchor = spawnPoint('B', 4);
  let anchorBestDist = Infinity;
  for (let i = 0; i < MAP.spawns.teamB.length; i++) {
    const sp = spawnPoint('B', i);
    const d = Math.hypot(sp[0] - playerPos.x, sp[2] - playerPos.z);
    if (d > 1 && d < anchorBestDist) {
      anchorBestDist = d;
      anchor = sp;
    }
  }
  const baseAngle = Math.atan2(anchor[0] - playerPos.x, anchor[2] - playerPos.z);
  const angleOffsetsDeg = [0, -5, 5, -6, 6, -8, 8, -12, 12, -18, 18, -25, 25, -35, 35, -50, 50];
  const radii = [22.5, 22.0, 23.0, 21.0, 24.0, 20.5, 24.5];

  // First pass: require unobstructed sightline to chest + walkable + box-free
  for (const r of radii) {
    for (const deg of angleOffsetsDeg) {
      const a = baseAngle + (deg * Math.PI) / 180;
      const cx = playerPos.x + Math.sin(a) * r;
      const cz = playerPos.z + Math.cos(a) * r;
      if (!isValidSpot(cx, 0, cz)) continue;
      if (hasClearSightline(eyeFrom, { x: cx, y: 2.0, z: cz })) {
        return { x: Number(cx.toFixed(2)), y: 0, z: Number(cz.toFixed(2)) };
      }
    }
  }

  // Fallback pass: walkable + box-free without strict chest LOS
  for (const r of radii) {
    for (const deg of angleOffsetsDeg) {
      const a = baseAngle + (deg * Math.PI) / 180;
      const cx = playerPos.x + Math.sin(a) * r;
      const cz = playerPos.z + Math.cos(a) * r;
      if (isValidSpot(cx, 0, cz)) {
        return { x: Number(cx.toFixed(2)), y: 0, z: Number(cz.toFixed(2)) };
      }
    }
  }

  // Final deterministic fallback toward center deck
  return { x: -10.0, y: 0, z: -5.5 };
}

/** Nearest positive ray-vs-sphere intersection distance, or Infinity. */
function raySphereT(o: Vec3, d: Vec3, cx: number, cy: number, cz: number, r: number): number {
  const ox = o.x - cx;
  const oy = o.y - cy;
  const oz = o.z - cz;
  const a = d.x * d.x + d.y * d.y + d.z * d.z;
  if (a <= EPS) return Infinity;
  const b = 2 * (ox * d.x + oy * d.y + oz * d.z);
  const c = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return Infinity;
  const sq = Math.sqrt(disc);
  const t1 = (-b - sq) / (2 * a);
  if (t1 > EPS) return t1;
  const t2 = (-b + sq) / (2 * a);
  return t2 > EPS ? t2 : Infinity;
}

/** Nearest positive ray-vs-vertical-capsule intersection distance (feet at pos.y, top at pos.y + height). */
function rayVerticalCapsuleT(o: Vec3, d: Vec3, pos: Vec3, r: number, height: number): number {
  const yBot = pos.y + r;
  const yTop = Math.max(yBot, pos.y + height - r);
  let best = Infinity;

  // Cylindrical mid-section [yBot, yTop]
  const ox = o.x - pos.x;
  const oz = o.z - pos.z;
  const a = d.x * d.x + d.z * d.z;
  if (a > EPS) {
    const b = 2 * (ox * d.x + oz * d.z);
    const c = ox * ox + oz * oz - r * r;
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      for (const t of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) {
        if (t <= EPS || t >= best) continue;
        const y = o.y + t * d.y;
        if (y >= yBot && y <= yTop) best = t;
      }
    }
  }

  // Bottom and top hemisphere caps
  const tBot = raySphereT(o, d, pos.x, yBot, pos.z, r);
  if (tBot < best) best = tBot;
  const tTop = raySphereT(o, d, pos.x, yTop, pos.z, r);
  if (tTop < best) best = tTop;

  return best;
}

/**
 * Classify a Boss hit point into weakpoints or body:
 *   - hit height > height * 0.82 -> 'head'
 *   - hit inside chest/back core sphere (±0.5m radius) -> 'core'
 *   - otherwise -> 'body'
 */
export function classifyBossHitPart(
  hitPoint: Vec3,
  bossPos: Vec3,
  bossYaw: number,
  height = BOSS_TARGET_HEIGHT,
): BossHitPart {
  const relY = hitPoint.y - bossPos.y;
  if (relY > height * BOSS_HEAD_RATIO) {
    return 'head';
  }

  const coreY = bossPos.y + height * BOSS_CORE_HEIGHT_RATIO;
  const fwdX = -Math.sin(bossYaw);
  const fwdZ = -Math.cos(bossYaw);
  const rSq = BOSS_CORE_RADIUS * BOSS_CORE_RADIUS;

  // Front chest core & back energy core (each a ±0.5m radius sphere on torso front/back)
  const frontX = bossPos.x + fwdX * BOSS_CORE_SURFACE_OFFSET;
  const frontZ = bossPos.z + fwdZ * BOSS_CORE_SURFACE_OFFSET;
  const dfx = hitPoint.x - frontX;
  const dfy = hitPoint.y - coreY;
  const dfz = hitPoint.z - frontZ;
  if (dfx * dfx + dfy * dfy + dfz * dfz <= rSq) {
    return 'core';
  }

  const backX = bossPos.x - fwdX * BOSS_CORE_SURFACE_OFFSET;
  const backZ = bossPos.z - fwdZ * BOSS_CORE_SURFACE_OFFSET;
  const dbx = hitPoint.x - backX;
  const dbz = hitPoint.z - backZ;
  if (dbx * dbx + dfy * dfy + dbz * dbz <= rSq) {
    return 'core';
  }

  return 'body';
}

/**
 * Intersect a shot ray against the Boss's capsule + head sphere collider.
 * Returns null if dead or missed.
 */
export function raycastBoss(
  ray: Ray,
  bossPos: Vec3,
  bossYaw: number,
  alive: boolean,
  height = BOSS_TARGET_HEIGHT,
): BossRayHit | null {
  if (!alive) return null;

  const tCapsule = rayVerticalCapsuleT(ray.origin, ray.dir, bossPos, BOSS_BODY_RADIUS, height);
  const headCenterY = bossPos.y + height * 0.90;
  const tHead = raySphereT(
    ray.origin,
    ray.dir,
    bossPos.x,
    headCenterY,
    bossPos.z,
    BOSS_HEAD_SPHERE_RADIUS,
  );

  const bestT = Math.min(tCapsule, tHead);
  if (!Number.isFinite(bestT)) return null;

  const point: Vec3 = {
    x: ray.origin.x + ray.dir.x * bestT,
    y: ray.origin.y + ray.dir.y * bestT,
    z: ray.origin.z + ray.dir.z * bestT,
  };
  const part: BossHitPart =
    tHead <= tCapsule + EPS && point.y - bossPos.y > height * BOSS_HEAD_RATIO
      ? 'head'
      : classifyBossHitPart(point, bossPos, bossYaw, height);

  return { dist: bestT, point, part };
}

interface BossPose {
  bodyY: number;
  bodyPitch: number;
  bodyRoll: number;
  torsoPitch: number;
  torsoYaw: number;
  headY: number;
  headPitch: number;
  headYaw: number;
  shLX: number;
  shLY: number;
  shLZ: number;
  elLX: number;
  shRX: number;
  shRY: number;
  shRZ: number;
  elRX: number;
  hipLX: number;
  hipLZ: number;
  kneeLX: number;
  ankleLX: number;
  hipRX: number;
  hipRZ: number;
  kneeRX: number;
  ankleRX: number;
}

function defaultBossPose(): BossPose {
  return {
    bodyY: 0.96,
    bodyPitch: 0,
    bodyRoll: 0,
    torsoPitch: -0.04,
    torsoYaw: 0,
    headY: 0.56,
    headPitch: 0,
    headYaw: 0,
    shLX: 0.25,
    shLY: -0.15,
    shLZ: 0.22,
    elLX: 0.45,
    shRX: 0.25,
    shRY: 0.15,
    shRZ: -0.22,
    elRX: 0.45,
    hipLX: 0.06,
    hipLZ: 0.06,
    kneeLX: -0.12,
    ankleLX: 0.06,
    hipRX: -0.06,
    hipRZ: -0.06,
    kneeRX: -0.12,
    ankleRX: 0.14,
  };
}

export class BossController {
  readonly mesh: THREE.Group;
  readonly ai: BossAI;
  readonly height: number = BOSS_TARGET_HEIGHT;
  readonly attackRange: number;
  readonly meleeDamage: number;

  private readonly scene: THREE.Scene;
  private readonly opts: BossControllerOptions;
  private robot: RobotInstance;
  private readonly shadowMesh: THREE.Mesh;
  private readonly shadowMat: THREE.MeshBasicMaterial;
  private bossScale = 1;

  private origin: Vec3;
  private worldPos: Vec3;
  private currentYaw = 0;
  private cachedTick: BossTick;
  private lastEventsArr: BossEvent[] = [];

  private readonly pose: BossPose = defaultBossPose();
  private readonly targetPose: BossPose = defaultBossPose();
  private animTime = 0;
  private walkPhase = 0;
  private stateElapsedSec = 0;
  private prevState: BossState = 'idle';

  private hitRecoilTimerMs = 0;
  private hitFlashTimerMs = 0;
  private currentRecoilZ = 0;
  private deadStarted = false;
  private deadElapsedSec = 0;
  private deathFadeApplied = false;
  private disposed = false;

  private _hitsTaken = 0;
  private _meleeHitsDealt = 0;
  private _lastHitPart: BossHitPart | null = null;
  private _lastReportedPhase: 1 | 2 = 1;

  private readonly tmpSoleL = new THREE.Vector3();
  private readonly tmpSoleR = new THREE.Vector3();

  constructor(scene: THREE.Scene, opts: BossControllerOptions = {}) {
    this.scene = scene;
    this.opts = opts;
    this.ai = new BossAI(opts.hpMax ?? BOSS_DEFAULTS.hpMax, opts.ai);
    this.attackRange = opts.ai?.attackRange ?? BOSS_DEFAULTS.attackRange;
    this.meleeDamage = opts.meleeDamage ?? BOSS_MELEE_DAMAGE;

    const defaultPlayer = spawnPoint('A', 0);
    const pPos = opts.playerPos ?? { x: defaultPlayer[0], z: defaultPlayer[2] };
    const spawn = opts.spawnPos
      ? { x: opts.spawnPos.x, y: opts.spawnPos.y ?? 0, z: opts.spawnPos.z }
      : selectBossSpawn(pPos);

    this.origin = { x: spawn.x, y: spawn.y, z: spawn.z };
    this.worldPos = { x: spawn.x, y: spawn.y, z: spawn.z };
    this.currentYaw = yawToTarget(this.worldPos.x, this.worldPos.z, pPos.x, pPos.z);

    this.mesh = new THREE.Group();
    this.mesh.name = 'boss-root';
    this.mesh.position.set(this.worldPos.x, this.worldPos.y, this.worldPos.z);
    this.mesh.rotation.y = this.currentYaw;

    this.robot = this.buildPlaceholderRobot();
    this.mesh.add(this.robot.root);

    // Contact shadow disc under feet
    if (!sharedBossShadowTex) sharedBossShadowTex = makeBossShadowTex();
    if (!sharedBossShadowGeo) {
      sharedBossShadowGeo = new THREE.PlaneGeometry(CONTACT_SHADOW_DIAMETER, CONTACT_SHADOW_DIAMETER);
      sharedBossShadowGeo.rotateX(-Math.PI / 2);
    }
    this.shadowMat = new THREE.MeshBasicMaterial({
      map: sharedBossShadowTex,
      transparent: true,
      opacity: CONTACT_SHADOW_OPACITY,
      depthWrite: false,
    });
    this.shadowMesh = new THREE.Mesh(sharedBossShadowGeo, this.shadowMat);
    this.shadowMesh.name = 'boss-shadow';
    this.shadowMesh.position.set(0, CONTACT_SHADOW_Y, 0);
    this.shadowMesh.renderOrder = -1;
    this.shadowMesh.castShadow = false;
    this.shadowMesh.receiveShadow = false;
    this.shadowMesh.frustumCulled = false;
    this.mesh.add(this.shadowMesh);

    this.scene.add(this.mesh);

    this.cachedTick = this.ai.update(
      0,
      { x: pPos.x - this.origin.x, z: pPos.z - this.origin.z },
      Math.hypot(pPos.x - this.worldPos.x, pPos.z - this.worldPos.z),
    );
    this.applyJoints();
    this.groundFeet();
  }

  private buildPlaceholderRobot(): RobotInstance {
    const robot = createRobot('enemy');
    robot.root.name = 'boss-placeholder-robot';
    // Pure melee Boss: hide the pulse carbine & muzzle flash on placeholder robot
    robot.joints.weaponMount.visible = false;
    robot.muzzleMesh.visible = false;

    // Measure raw standing height and scale uniformly to BOSS_TARGET_HEIGHT (4.0m)
    robot.root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(robot.root);
    const rawH = !box.isEmpty() && Number.isFinite(box.max.y - box.min.y) ? box.max.y - box.min.y : 1.73;
    this.bossScale = BOSS_TARGET_HEIGHT / Math.max(0.5, rawH);
    robot.root.scale.setScalar(this.bossScale);
    return robot;
  }

  get hp(): number {
    return this.cachedTick.hp;
  }

  get hpMax(): number {
    return this.cachedTick.hpMax;
  }

  get phase(): 1 | 2 {
    return this.cachedTick.phase;
  }

  get alive(): boolean {
    return this.cachedTick.hp > 0;
  }

  get state(): BossState {
    return this.cachedTick.state;
  }

  get pos(): Vec3 {
    return { x: this.worldPos.x, y: this.worldPos.y, z: this.worldPos.z };
  }

  get yaw(): number {
    return this.currentYaw;
  }

  get triangleCount(): number {
    return this.robot.triangleCount;
  }

  get lastTick(): BossTick {
    return this.cachedTick;
  }

  get lastEvents(): readonly BossEvent[] {
    return this.lastEventsArr;
  }

  get hitsTaken(): number {
    return this._hitsTaken;
  }

  get meleeHitsDealt(): number {
    return this._meleeHitsDealt;
  }

  get lastHitPart(): BossHitPart | null {
    return this._lastHitPart;
  }

  get hitRecoilOffset(): number {
    return this.currentRecoilZ;
  }

  raycast(ray: Ray): BossRayHit | null {
    return raycastBoss(ray, this.worldPos, this.currentYaw, this.alive, this.height);
  }

  applyDamage(amount: number, part: BossHitPart): { dealt: number; dead: boolean } {
    if (this.disposed || !this.alive) return { dealt: 0, dead: false };
    const wasAlive = this.alive;
    const dealt = this.ai.applyDamage(amount, part);
    if (dealt <= 0) return { dealt: 0, dead: false };

    this._hitsTaken++;
    this._lastHitPart = part;
    this.hitRecoilTimerMs = BOSS_HIT_RECOIL_MS;
    this.hitFlashTimerMs = HIT_FLASH_MS;

    // Pull authoritative hp/phase snapshot (dt=0 has no movement/state side effects)
    const snap = this.ai.update(0, { x: 0, z: 0 }, 0);
    this.cachedTick = snap;

    if (snap.phase !== this._lastReportedPhase) {
      this._lastReportedPhase = snap.phase;
      this.opts.onPhaseChange?.(snap.phase);
    }

    const dead = wasAlive && snap.hp <= 0;
    if (dead) {
      this.opts.onDefeated?.();
    }
    return { dealt, dead };
  }

  /** Advance Boss AI + sync mesh transform + drive melee animations & hit recoil. */
  update(dtMs: number, player: { x: number; z: number }): void {
    if (this.disposed) return;
    const safeDtMs = Number.isFinite(dtMs) && dtMs > 0 ? dtMs : 0;
    const dtSec = safeDtMs / 1000;

    const prevX = this.worldPos.x;
    const prevZ = this.worldPos.z;
    const distBefore = Math.hypot(player.x - prevX, player.z - prevZ);

    const relPlayer = {
      x: player.x - this.origin.x,
      z: player.z - this.origin.z,
    };
    const tick = this.ai.update(safeDtMs, relPlayer, distBefore);
    this.cachedTick = tick;
    this.lastEventsArr = tick.events;

    this.worldPos.x = this.origin.x + tick.pos.x;
    this.worldPos.z = this.origin.z + tick.pos.z;

    const distAfter = Math.hypot(player.x - this.worldPos.x, player.z - this.worldPos.z);

    // Facing: use BossAI yaw during active states; keep facing player while alive & not charging
    if (tick.hp > 0) {
      if (tick.state === 'charge') {
        this.currentYaw = tick.yaw;
      } else if (distAfter > EPS) {
        this.currentYaw = yawToTarget(this.worldPos.x, this.worldPos.z, player.x, player.z);
      } else {
        this.currentYaw = tick.yaw;
      }
    }

    this.mesh.position.set(this.worldPos.x, this.worldPos.y, this.worldPos.z);
    this.mesh.rotation.y = this.currentYaw;

    // Dispatch events
    if (tick.phase !== this._lastReportedPhase) {
      this._lastReportedPhase = tick.phase;
      this.opts.onPhaseChange?.(tick.phase);
    }
    for (const ev of tick.events) {
      if (ev === 'phase2' && this._lastReportedPhase !== 2) {
        this._lastReportedPhase = 2;
        this.opts.onPhaseChange?.(2);
      }
      if (ev === 'attack_hit' && distAfter <= this.attackRange + EPS) {
        this._meleeHitsDealt++;
        this.opts.onAttackHit?.({
          damage: this.meleeDamage,
          dist: distAfter,
          bossPos: { x: this.worldPos.x, y: this.worldPos.y, z: this.worldPos.z },
        });
      }
    }

    // Locomotion phase from actual horizontal travel
    const moved = Math.hypot(this.worldPos.x - prevX, this.worldPos.z - prevZ);
    if (moved > 1e-4) {
      this.walkPhase += moved * (tick.state === 'charge' ? 2.1 : 1.5);
    }

    this.stepAnimation(dtSec, safeDtMs, tick.state, tick.hp <= 0);
  }

  /** Idle visual update during menu / pre-match countdown without running AI chase/attacks. */
  updateVisualOnly(dtMs: number, player?: { x: number; z: number }): void {
    if (this.disposed) return;
    const safeDtMs = Number.isFinite(dtMs) && dtMs > 0 ? dtMs : 0;
    if (player && this.alive) {
      this.currentYaw = yawToTarget(this.worldPos.x, this.worldPos.z, player.x, player.z);
    }
    this.mesh.position.set(this.worldPos.x, this.worldPos.y, this.worldPos.z);
    this.mesh.rotation.y = this.currentYaw;
    this.stepAnimation(safeDtMs / 1000, safeDtMs, this.alive ? 'idle' : 'recover', !this.alive);
  }

  /** Reset Boss back to full HP at a fresh 20-25m spawn relative to `playerPos`. */
  reset(playerPos?: { x: number; z: number }): void {
    if (this.disposed) return;
    this.ai.reset();
    const defaultPlayer = spawnPoint('A', 0);
    const pPos = playerPos ?? this.opts.playerPos ?? { x: defaultPlayer[0], z: defaultPlayer[2] };
    const spawn = this.opts.spawnPos
      ? { x: this.opts.spawnPos.x, y: this.opts.spawnPos.y ?? 0, z: this.opts.spawnPos.z }
      : selectBossSpawn(pPos);

    this.origin = { x: spawn.x, y: spawn.y, z: spawn.z };
    this.worldPos = { x: spawn.x, y: spawn.y, z: spawn.z };
    this.currentYaw = yawToTarget(this.worldPos.x, this.worldPos.z, pPos.x, pPos.z);

    if (this.deathFadeApplied) {
      this.mesh.remove(this.robot.root);
      this.robot.dispose();
      this.robot = this.buildPlaceholderRobot();
      this.mesh.add(this.robot.root);
      this.deathFadeApplied = false;
    } else {
      this.robot.setHitFlash(false);
    }

    this.shadowMesh.visible = true;
    this.shadowMat.opacity = CONTACT_SHADOW_OPACITY;
    this.hitRecoilTimerMs = 0;
    this.hitFlashTimerMs = 0;
    this.currentRecoilZ = 0;
    this.robot.root.position.z = 0;
    this.deadStarted = false;
    this.deadElapsedSec = 0;
    this.animTime = 0;
    this.walkPhase = 0;
    this.stateElapsedSec = 0;
    this.prevState = 'idle';
    this._hitsTaken = 0;
    this._meleeHitsDealt = 0;
    this._lastHitPart = null;
    this._lastReportedPhase = 1;
    this.lastEventsArr = [];

    Object.assign(this.pose, defaultBossPose());
    Object.assign(this.targetPose, defaultBossPose());

    this.mesh.position.set(this.worldPos.x, this.worldPos.y, this.worldPos.z);
    this.mesh.rotation.y = this.currentYaw;
    this.cachedTick = this.ai.update(
      0,
      { x: pPos.x - this.origin.x, z: pPos.z - this.origin.z },
      Math.hypot(pPos.x - this.worldPos.x, pPos.z - this.worldPos.z),
    );
    this.applyJoints();
    this.groundFeet();
  }

  setVisible(visible: boolean): void {
    this.robot.root.visible = visible;
  }

  getFeetWorldY(): number | null {
    this.mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.robot.root);
    if (box.isEmpty() || !Number.isFinite(box.min.y)) return null;
    return box.min.y;
  }

  projectScreenBounds(
    camera: THREE.Camera,
    vw: number,
    vh: number,
  ): { x0: number; y0: number; x1: number; y1: number; onScreen: boolean } | null {
    this.mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.robot.root);
    if (box.isEmpty()) return null;
    camera.updateMatrixWorld(true);
    const viewMat = camera.matrixWorldInverse;
    const projMat = camera.projectionMatrix;
    const vPt = new THREE.Vector3();
    const nearClip = -0.35;
    const xs = [box.min.x, box.max.x];
    const ys = [box.min.y, box.max.y];
    const zs = [box.min.z, box.max.z];
    let anyInFront = false;
    for (const x of xs) {
      for (const y of ys) {
        for (const z of zs) {
          vPt.set(x, y, z).applyMatrix4(viewMat);
          if (vPt.z < nearClip) anyInFront = true;
        }
      }
    }
    if (!anyInFront) {
      return { x0: -999, y0: -999, x1: -999, y1: -999, onScreen: false };
    }
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const x of xs) {
      for (const y of ys) {
        for (const z of zs) {
          vPt.set(x, y, z).applyMatrix4(viewMat);
          if (vPt.z > nearClip) vPt.z = nearClip;
          vPt.applyMatrix4(projMat);
          const sx = (vPt.x * 0.5 + 0.5) * vw;
          const sy = (-vPt.y * 0.5 + 0.5) * vh;
          if (sx < x0) x0 = sx;
          if (sx > x1) x1 = sx;
          if (sy < y0) y0 = sy;
          if (sy > y1) y1 = sy;
        }
      }
    }
    const onScreen = x1 > 0 && x0 < vw && y1 > 0 && y0 < vh;
    return {
      x0: Number(x0.toFixed(1)),
      y0: Number(y0.toFixed(1)),
      x1: Number(x1.toFixed(1)),
      y1: Number(y1.toFixed(1)),
      onScreen,
    };
  }

  private stepAnimation(dtSec: number, dtMs: number, state: BossState, isDead: boolean): void {
    if (state !== this.prevState) {
      this.prevState = state;
      this.stateElapsedSec = 0;
    } else {
      this.stateElapsedSec += dtSec;
    }

    // 0.15s hit knockback: mesh shifts +0.08m backward (local +Z) and rebounds cleanly
    if (this.hitRecoilTimerMs > 0) {
      this.hitRecoilTimerMs = Math.max(0, this.hitRecoilTimerMs - dtMs);
      if (this.hitRecoilTimerMs <= 0) {
        this.currentRecoilZ = 0;
      } else {
        const u = 1 - this.hitRecoilTimerMs / BOSS_HIT_RECOIL_MS;
        this.currentRecoilZ = Math.sin(u * Math.PI) * BOSS_HIT_RECOIL_DIST;
      }
    } else {
      this.currentRecoilZ = 0;
    }
    this.robot.root.position.z = this.currentRecoilZ;

    if (this.hitFlashTimerMs > 0 && !isDead) {
      this.hitFlashTimerMs = Math.max(0, this.hitFlashTimerMs - dtMs);
      this.robot.setHitFlash(this.hitFlashTimerMs > 0);
    } else if (!isDead) {
      this.robot.setHitFlash(false);
    }

    if (isDead) {
      this.advanceDeath(dtSec);
      return;
    }

    this.animTime += dtSec;
    this.computeTargetPose(state);

    const dampRate = state === 'attack' ? 32 : this.hitRecoilTimerMs > 0 ? 34 : 15;
    for (const k of Object.keys(this.pose) as (keyof BossPose)[]) {
      this.pose[k] = dampVal(this.pose[k], this.targetPose[k], dampRate, dtSec);
    }
    this.applyJoints();
    this.groundFeet();
  }

  private computeTargetPose(state: BossState): void {
    const t = this.targetPose;
    Object.assign(t, defaultBossPose());

    const idleT = this.animTime;
    const hoverBob = Math.sin(idleT * 2.8) * 0.014;
    t.headY = 0.56 + hoverBob;

    if (state === 'idle') {
      const breathe = Math.sin(idleT * 1.8) * 0.016;
      t.bodyY = 0.96 + breathe;
      t.torsoPitch = -0.04 + Math.sin(idleT * 1.4) * 0.02;
      t.shLX = 0.28;
      t.shLZ = 0.26;
      t.elLX = 0.52;
      t.shRX = 0.28;
      t.shRZ = -0.26;
      t.elRX = 0.52;
    } else if (state === 'chase') {
      // Heavy menacing bipedal march
      const s = Math.sin(this.walkPhase);
      const c = Math.cos(this.walkPhase);
      const p2Boost = this.phase === 2 ? 1.15 : 1.0;
      t.bodyY = 0.92 + Math.abs(c) * 0.04;
      t.torsoPitch = -0.15 * p2Boost;
      t.torsoYaw = -s * 0.15;
      t.headYaw = -t.torsoYaw * 0.7;
      t.headPitch = 0.1;

      t.hipLX = s * 0.54;
      t.kneeLX = -Math.max(0.08, -c * 0.65 + 0.16);
      t.ankleLX = -t.hipLX * 0.4 - t.kneeLX * 0.35;

      t.hipRX = -s * 0.54;
      t.kneeRX = -Math.max(0.08, c * 0.65 + 0.16);
      t.ankleRX = -t.hipRX * 0.4 - t.kneeRX * 0.35;

      // Counter-swinging armored gauntlets
      t.shLX = 0.35 - s * 0.45;
      t.shLZ = 0.28;
      t.elLX = 0.65;
      t.shRX = 0.35 + s * 0.45;
      t.shRZ = -0.28;
      t.elRX = 0.65;
    } else if (state === 'windup') {
      // 举臂预警: rear back & raise both massive arms high overhead
      const u = clamp01(this.stateElapsedSec / 0.55);
      const raise = 0.4 + 0.6 * u;
      t.bodyY = 0.92;
      t.torsoPitch = 0.26 * raise;
      t.torsoYaw = 0.14 * raise;
      t.headPitch = -0.14 * raise;
      t.shLX = 2.55 * raise;
      t.shLZ = 0.36;
      t.elLX = 0.42;
      t.shRX = 2.72 * raise;
      t.shRZ = -0.36;
      t.elRX = 0.42;
      t.hipLX = 0.24;
      t.hipLZ = 0.12;
      t.kneeLX = -0.34;
      t.hipRX = -0.20;
      t.hipRZ = -0.12;
      t.kneeRX = -0.28;
    } else if (state === 'attack') {
      // 挥击: violent downward/forward cleave slam
      t.bodyY = 0.86;
      t.torsoPitch = -0.44;
      t.torsoYaw = -0.38;
      t.headPitch = 0.26;
      t.headYaw = 0.28;
      t.shRX = 0.42;
      t.shRY = 0.42;
      t.shRZ = -0.12;
      t.elRX = 0.28;
      t.shLX = 0.62;
      t.shLY = -0.35;
      t.shLZ = 0.45;
      t.elLX = 0.40;
      t.hipLX = 0.38;
      t.kneeLX = -0.48;
      t.hipRX = -0.28;
      t.kneeRX = -0.24;
    } else if (state === 'charge') {
      // 前倾冲锋: deep bull-rush forward lean + driving sprint legs
      const s = Math.sin(this.walkPhase * 1.25);
      const c = Math.cos(this.walkPhase * 1.25);
      t.bodyY = 0.84 + Math.abs(c) * 0.05;
      t.bodyPitch = -0.12;
      t.torsoPitch = -0.46;
      t.torsoYaw = -s * 0.18;
      t.headPitch = 0.34;
      t.headYaw = -t.torsoYaw * 0.6;
      t.shLX = -0.52;
      t.shLZ = 0.44;
      t.elLX = 0.72;
      t.shRX = -0.52;
      t.shRZ = -0.44;
      t.elRX = 0.72;

      t.hipLX = s * 0.76;
      t.kneeLX = -Math.max(0.12, -c * 0.92 + 0.22);
      t.ankleLX = -t.hipLX * 0.45 - t.kneeLX * 0.35;

      t.hipRX = -s * 0.76;
      t.kneeRX = -Math.max(0.12, c * 0.92 + 0.22);
      t.ankleRX = -t.hipRX * 0.45 - t.kneeRX * 0.35;
    } else if (state === 'recover') {
      // Stagger / recovery breath after swing or charge
      const sway = Math.sin(idleT * 3.5) * 0.04;
      t.bodyY = 0.89;
      t.torsoPitch = -0.22;
      t.torsoYaw = sway;
      t.headPitch = -0.14;
      t.shLX = 0.12;
      t.shLZ = 0.32;
      t.elLX = 0.32;
      t.shRX = 0.12;
      t.shRZ = -0.32;
      t.elRX = 0.32;
      t.hipLX = 0.18;
      t.kneeLX = -0.32;
      t.hipRX = -0.14;
      t.kneeRX = -0.30;
    }

    // Overlay hit recoil torso pitch flinch (受击后仰)
    if (this.currentRecoilZ > 0) {
      const k = this.currentRecoilZ / BOSS_HIT_RECOIL_DIST;
      t.torsoPitch += k * 0.22;
      t.headPitch += k * 0.14;
      t.bodyY -= k * 0.05;
    }
  }

  private advanceDeath(dtSec: number): void {
    if (!this.deadStarted) {
      this.deadStarted = true;
      this.deadElapsedSec = 0;
      this.robot.setHitFlash(false);
    }
    this.deadElapsedSec += dtSec;
    const u = clamp01(this.deadElapsedSec / DEATH_COLLAPSE_SEC);
    const buckle = clamp01(u / 0.35);
    const fall = clamp01((u - 0.18) / 0.82);
    const fallEase = fall * fall * (3 - 2 * fall);

    const p = this.pose;
    p.bodyY = dampVal(p.bodyY, 0.96 - buckle * 0.28 - fallEase * 0.48, 20, dtSec);
    p.bodyPitch = dampVal(p.bodyPitch, fallEase * 1.44, 16, dtSec);
    p.bodyRoll = dampVal(p.bodyRoll, fallEase * 0.24, 16, dtSec);
    p.torsoPitch = dampVal(p.torsoPitch, 0.12 + fallEase * 0.16, 16, dtSec);
    p.headY = dampVal(p.headY, 0.56 - fallEase * 0.11, 18, dtSec);
    p.headPitch = dampVal(p.headPitch, -0.32 * fallEase, 16, dtSec);
    p.shLX = dampVal(p.shLX, -0.32 * fallEase, 14, dtSec);
    p.shLZ = dampVal(p.shLZ, 0.68 * fallEase, 14, dtSec);
    p.shRX = dampVal(p.shRX, -0.25 * fallEase, 14, dtSec);
    p.shRZ = dampVal(p.shRZ, -0.62 * fallEase, 14, dtSec);
    p.hipLX = dampVal(p.hipLX, 0.38 * buckle - 0.24 * fallEase, 16, dtSec);
    p.kneeLX = dampVal(p.kneeLX, -0.92 * buckle + 0.52 * fallEase, 16, dtSec);
    p.hipRX = dampVal(p.hipRX, 0.22 * buckle - 0.15 * fallEase, 16, dtSec);
    p.kneeRX = dampVal(p.kneeRX, -0.74 * buckle + 0.44 * fallEase, 16, dtSec);

    this.applyJoints();
    this.robot.root.position.y = dampVal(this.robot.root.position.y, 0, 12, dtSec);

    const fadeStart = DEATH_COLLAPSE_SEC + CORPSE_HOLD_SEC;
    if (this.deadElapsedSec >= fadeStart) {
      const fu = clamp01((this.deadElapsedSec - fadeStart) / CORPSE_FADE_SEC);
      const opacity = 1 - fu;
      this.deathFadeApplied = true;
      this.robot.setDeathFade(opacity);
      this.shadowMat.opacity = CONTACT_SHADOW_OPACITY * opacity;
      if (fu >= 1) {
        this.shadowMesh.visible = false;
      }
    }
  }

  private applyJoints(): void {
    const j = this.robot.joints;
    const p = this.pose;
    j.bodyPivot.position.set(0, p.bodyY, 0);
    j.bodyPivot.rotation.set(p.bodyPitch, 0, p.bodyRoll);
    j.torsoPivot.rotation.set(p.torsoPitch, p.torsoYaw, 0);
    j.headPivot.position.set(0, p.headY, 0);
    j.headPivot.rotation.set(p.headPitch, p.headYaw, 0);
    j.shoulderL.rotation.set(p.shLX, p.shLY, p.shLZ);
    j.elbowL.rotation.set(p.elLX, 0, 0);
    j.shoulderR.rotation.set(p.shRX, p.shRY, p.shRZ);
    j.elbowR.rotation.set(p.elRX, 0, 0);
    j.hipL.rotation.set(p.hipLX, 0, p.hipLZ);
    j.kneeL.rotation.set(p.kneeLX, 0, 0);
    j.ankleL.rotation.set(p.ankleLX, 0, 0);
    j.hipR.rotation.set(p.hipRX, 0, p.hipRZ);
    j.kneeR.rotation.set(p.kneeRX, 0, 0);
    j.ankleR.rotation.set(p.ankleRX, 0, 0);
  }

  private groundFeet(): void {
    this.robot.root.position.y = 0;
    this.mesh.updateMatrixWorld(true);
    this.robot.soleProbeL.getWorldPosition(this.tmpSoleL);
    this.robot.soleProbeR.getWorldPosition(this.tmpSoleR);
    const minWorldY = Math.min(this.tmpSoleL.y, this.tmpSoleR.y);
    const localMinY = minWorldY - this.mesh.position.y;
    if (Number.isFinite(localMinY)) {
      this.robot.root.position.y = -localMinY;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scene.remove(this.mesh);
    this.robot.dispose();
    this.shadowMat.dispose();
  }
}
