// Boss Controller — connects stationary turret BossAI with the procedural Heavy
// Armored Mech Boss model (src/render/bossModel.ts), capsule+head raycast hit
// detection, weakpoint classification (head / core / body), parabolic artillery
// launches & ground landing telegraphs (src/game/artillery.ts), death collapse,
// and 0.15s / 0.08m hit recoil. Strictly stationary ranged artillery: zero movement
// and zero melee damage.

import * as THREE from 'three';
import {
  ArtillerySystem,
  type ArtilleryHitInfo,
  type ArtilleryOptions,
  type ArtilleryShotRecord,
} from './artillery';
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
import { createBossModel, type BossAnim, type BossModel } from '../render/bossModel';

export const BOSS_TARGET_HEIGHT = 4.0;
export const BOSS_BODY_RADIUS = 0.68;
export const BOSS_HEAD_RATIO = 0.82;
export const BOSS_HEAD_SPHERE_RADIUS = 0.50;
export const BOSS_CORE_RADIUS = 0.50;
export const BOSS_CORE_HEIGHT_RATIO = 0.68;
export const BOSS_CORE_SURFACE_OFFSET = 0.45;
export const BOSS_SPAWN_MIN_DIST = 20;
export const BOSS_SPAWN_MAX_DIST = 25;
export const BOSS_HIT_RECOIL_MS = 150;
export const BOSS_HIT_RECOIL_DIST = 0.08;

const EPS = 1e-6;
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

export interface BossControllerOptions {
  hpMax?: number;
  ai?: BossAIOptions;
  artillery?: Omit<ArtilleryOptions, 'onImpactHit' | 'onLaunch'>;
  /** Player initial position used to pick a 20-25m Boss spawn from spawnPoint. */
  playerPos?: { x: number; z: number };
  /** Explicit Boss spawn position override. */
  spawnPos?: { x: number; y?: number; z: number };
  /** Invoked when a parabolic artillery shell explodes with player inside blastRadius. */
  onArtilleryHit?: (info: ArtilleryHitInfo) => void;
  /** Invoked when Boss fires an artillery salvo. */
  onArtilleryLaunch?: (shots: readonly ArtilleryShotRecord[]) => void;
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

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
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

function mapStateToAnim(state: BossState): BossAnim {
  return state;
}

function countObjectTriangles(root: THREE.Object3D): number {
  let total = 0;
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const geo = obj.geometry;
    if (!geo) return;
    const idx = geo.getIndex();
    if (idx) {
      total += Math.round(idx.count / 3);
    } else {
      const pos = geo.getAttribute('position');
      if (pos) total += Math.round(pos.count / 3);
    }
  });
  return total;
}

/** Check whether a sightline from `from` to `to` clears all non-deck MAP.boxes. */
export function hasClearSightline(from: Vec3, to: Vec3): boolean {
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
 *   - hit height > height * headRatio (default 0.82) -> 'head'
 *   - hit inside chest/back core sphere (±0.5m radius at height * coreHeightRatio) -> 'core'
 *   - otherwise -> 'body'
 */
export function classifyBossHitPart(
  hitPoint: Vec3,
  bossPos: Vec3,
  bossYaw: number,
  height = BOSS_TARGET_HEIGHT,
  headRatio = BOSS_HEAD_RATIO,
  coreHeightRatio = BOSS_CORE_HEIGHT_RATIO,
): BossHitPart {
  const relY = hitPoint.y - bossPos.y;
  if (relY > height * headRatio) {
    return 'head';
  }

  const coreY = bossPos.y + height * coreHeightRatio;
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
  headRatio = BOSS_HEAD_RATIO,
  coreHeightRatio = BOSS_CORE_HEIGHT_RATIO,
  headCenterRatio = 0.90,
): BossRayHit | null {
  if (!alive) return null;

  const tCapsule = rayVerticalCapsuleT(ray.origin, ray.dir, bossPos, BOSS_BODY_RADIUS, height);
  const headCenterY = bossPos.y + height * headCenterRatio;
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
    tHead <= tCapsule + EPS && point.y - bossPos.y > height * headRatio
      ? 'head'
      : classifyBossHitPart(point, bossPos, bossYaw, height, headRatio, coreHeightRatio);

  return { dist: bestT, point, part };
}

export class BossController {
  readonly mesh: THREE.Group;
  readonly ai: BossAI;
  readonly artillery: ArtillerySystem;
  readonly height: number;
  readonly headRatio: number;
  readonly headCenterRatio: number;
  readonly coreHeightRatio: number;

  private readonly scene: THREE.Scene;
  private readonly opts: BossControllerOptions;
  private readonly modelWrap: THREE.Group;
  private model: BossModel;
  private cachedTriangleCount = 0;
  private modelBaseY = 0;
  private readonly shadowMesh: THREE.Mesh;
  private readonly shadowMat: THREE.MeshBasicMaterial;

  private origin: Vec3;
  private worldPos: Vec3;
  private currentYaw = 0;
  private cachedTick: BossTick;
  private lastEventsArr: BossEvent[] = [];
  private simClockMs = 0;

  private hitRecoilTimerMs = 0;
  private currentRecoilZ = 0;
  private deadStarted = false;
  private deadElapsedSec = 0;
  private deathFadeApplied = false;
  private disposed = false;

  private _hitsTaken = 0;
  private _lastHitPart: BossHitPart | null = null;
  private _lastReportedPhase: 1 | 2 = 1;

  constructor(scene: THREE.Scene, opts: BossControllerOptions = {}) {
    this.scene = scene;
    this.opts = opts;
    this.ai = new BossAI(opts.hpMax ?? BOSS_DEFAULTS.hpMax, opts.ai);
    this.artillery = new ArtillerySystem(this.scene, {
      ...opts.artillery,
      onImpactHit: opts.onArtilleryHit,
      onLaunch: opts.onArtilleryLaunch,
    });

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

    this.modelWrap = new THREE.Group();
    this.modelWrap.name = 'boss-model-wrap';
    this.mesh.add(this.modelWrap);

    this.model = this.mountBossModel();

    // Measure actual standing height and weakpoint height ratios directly from the procedural Boss model
    this.model.parts.root.updateMatrixWorld(true);
    const rootBox = new THREE.Box3().setFromObject(this.model.parts.root);
    const measuredH =
      !rootBox.isEmpty() && Number.isFinite(rootBox.max.y - rootBox.min.y)
        ? rootBox.max.y - rootBox.min.y
        : BOSS_TARGET_HEIGHT;
    this.height = Number(measuredH.toFixed(4));
    this.modelBaseY = Number.isFinite(rootBox.min.y) ? -rootBox.min.y : 0;
    this.modelWrap.position.y = this.modelBaseY;

    const headBox = new THREE.Box3().setFromObject(this.model.parts.head);
    if (!headBox.isEmpty() && this.height > EPS) {
      this.headRatio = clamp((headBox.min.y - rootBox.min.y) / this.height, 0.72, 0.90);
      this.headCenterRatio = clamp(
        ((headBox.min.y + headBox.max.y) * 0.5 - rootBox.min.y) / this.height,
        0.78,
        0.96,
      );
    } else {
      this.headRatio = BOSS_HEAD_RATIO;
      this.headCenterRatio = 0.90;
    }

    const coreBox = new THREE.Box3().setFromObject(this.model.parts.core);
    if (!coreBox.isEmpty() && this.height > EPS) {
      this.coreHeightRatio = clamp(
        ((coreBox.min.y + coreBox.max.y) * 0.5 - rootBox.min.y) / this.height,
        0.52,
        0.82,
      );
    } else {
      this.coreHeightRatio = BOSS_CORE_HEIGHT_RATIO;
    }

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
  }

  private mountBossModel(): BossModel {
    const model = createBossModel();
    model.parts.root.name = 'boss-terminator-model';
    this.modelWrap.add(model.parts.root);
    this.cachedTriangleCount = countObjectTriangles(model.parts.root);
    return model;
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
    return this.cachedTriangleCount;
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
    return 0;
  }

  get artilleryTriangleCount(): number {
    return this.artillery.triangleCount;
  }

  get lastHitPart(): BossHitPart | null {
    return this._lastHitPart;
  }

  get hitRecoilOffset(): number {
    return this.currentRecoilZ;
  }

  raycast(ray: Ray): BossRayHit | null {
    return raycastBoss(
      ray,
      this.worldPos,
      this.currentYaw,
      this.alive,
      this.height,
      this.headRatio,
      this.coreHeightRatio,
      this.headCenterRatio,
    );
  }

  applyDamage(amount: number, part: BossHitPart): { dealt: number; dead: boolean } {
    if (this.disposed || !this.alive) return { dealt: 0, dead: false };
    const wasAlive = this.alive;
    const dealt = this.ai.applyDamage(amount, part);
    if (dealt <= 0) return { dealt: 0, dead: false };

    this._hitsTaken++;
    this._lastHitPart = part;
    this.hitRecoilTimerMs = BOSS_HIT_RECOIL_MS;

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

  /** Advance stationary BossAI + parabolic artillery shells + procedural mech animation & recoil. */
  update(
    dtMs: number,
    player: { x: number; y?: number; z: number },
    simNowMs?: number,
    cameraPos?: Vec3,
  ): void {
    if (this.disposed) return;
    const safeDtMs = Number.isFinite(dtMs) && dtMs > 0 ? dtMs : 0;
    const dtSec = safeDtMs / 1000;
    if (simNowMs !== undefined && Number.isFinite(simNowMs)) {
      this.simClockMs = simNowMs;
    } else {
      this.simClockMs += safeDtMs;
    }

    const playerVec: Vec3 = {
      x: player.x,
      y: player.y ?? 0,
      z: player.z,
    };

    // Boss is permanently pinned at its spawn origin (zero translation).
    this.worldPos.x = this.origin.x;
    this.worldPos.y = this.origin.y;
    this.worldPos.z = this.origin.z;

    const dist = Math.hypot(playerVec.x - this.worldPos.x, playerVec.z - this.worldPos.z);
    const relPlayer = {
      x: playerVec.x - this.origin.x,
      z: playerVec.z - this.origin.z,
    };
    const tick = this.ai.update(safeDtMs, relPlayer, dist);
    this.cachedTick = tick;
    this.lastEventsArr = tick.events;

    // Rotate in place to track player (yaw held briefly during firing impulse).
    if (tick.hp > 0) {
      if (tick.state === 'attack') {
        this.currentYaw = tick.yaw;
      } else if (dist > EPS) {
        this.currentYaw = yawToTarget(this.worldPos.x, this.worldPos.z, playerVec.x, playerVec.z);
      } else {
        this.currentYaw = tick.yaw;
      }
    }

    this.mesh.position.set(this.worldPos.x, this.worldPos.y, this.worldPos.z);
    this.mesh.rotation.y = this.currentYaw;

    // Dispatch phase & artillery launch events (melee hit logic completely removed).
    if (tick.phase !== this._lastReportedPhase) {
      this._lastReportedPhase = tick.phase;
      this.opts.onPhaseChange?.(tick.phase);
    }
    for (const ev of tick.events) {
      if (ev === 'phase2' && this._lastReportedPhase !== 2) {
        this._lastReportedPhase = 2;
        this.opts.onPhaseChange?.(2);
      }
      if (ev === 'attack_start' && tick.hp > 0) {
        this.artillery.fireSalvo({
          bossPos: this.worldPos,
          bossYaw: this.currentYaw,
          playerPos: playerVec,
          salvoCount: tick.salvoCount,
          enraged: tick.enraged,
          simNowMs: this.simClockMs,
        });
      }
    }

    this.artillery.update(dtSec, playerVec, this.simClockMs, cameraPos);
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
      this.modelWrap.remove(this.model.parts.root);
      this.model.dispose();
      this.model = this.mountBossModel();
      this.deathFadeApplied = false;
    }

    this.modelWrap.visible = true;
    this.shadowMesh.visible = true;
    this.shadowMat.opacity = CONTACT_SHADOW_OPACITY;
    this.hitRecoilTimerMs = 0;
    this.currentRecoilZ = 0;
    this.modelWrap.position.set(0, this.modelBaseY, 0);
    this.modelWrap.rotation.set(0, 0, 0);
    this.deadStarted = false;
    this.deadElapsedSec = 0;
    this._hitsTaken = 0;
    this._lastHitPart = null;
    this._lastReportedPhase = 1;
    this.lastEventsArr = [];
    this.simClockMs = 0;
    this.artillery.clear();

    this.mesh.position.set(this.worldPos.x, this.worldPos.y, this.worldPos.z);
    this.mesh.rotation.y = this.currentYaw;
    this.cachedTick = this.ai.update(
      0,
      { x: pPos.x - this.origin.x, z: pPos.z - this.origin.z },
      Math.hypot(pPos.x - this.worldPos.x, pPos.z - this.worldPos.z),
    );
    this.model.update(0, { hpPct: 1, phase: 1, anim: 'idle' });
  }

  setVisible(visible: boolean): void {
    this.modelWrap.visible = visible;
  }

  /** Relocate Boss on deck (e2e/test staging only); optionally resets BossAI to idle. */
  relocate(
    x: number,
    z: number,
    playerPos?: { x: number; z: number },
    resetAi = false,
  ): void {
    if (this.disposed) return;
    if (resetAi) {
      this.ai.reset();
      this.deadStarted = false;
      this.deadElapsedSec = 0;
      this.hitRecoilTimerMs = 0;
      this.currentRecoilZ = 0;
      this._hitsTaken = 0;
      this._lastHitPart = null;
      this._lastReportedPhase = 1;
      this.lastEventsArr = [];
      this.artillery.clear();
    }
    this.origin = { x, y: 0, z };
    this.worldPos = { x, y: 0, z };
    const pPos = playerPos ?? this.opts.playerPos ?? { x: 0, z: 15 };
    this.currentYaw = yawToTarget(this.worldPos.x, this.worldPos.z, pPos.x, pPos.z);
    this.modelWrap.visible = true;
    this.shadowMesh.visible = true;
    this.modelWrap.position.set(0, this.modelBaseY, 0);
    this.modelWrap.rotation.set(0, 0, 0);
    this.mesh.position.set(this.worldPos.x, this.worldPos.y, this.worldPos.z);
    this.mesh.rotation.y = this.currentYaw;
    this.cachedTick = this.ai.update(
      0,
      { x: pPos.x - this.origin.x, z: pPos.z - this.origin.z },
      Math.hypot(pPos.x - this.worldPos.x, pPos.z - this.worldPos.z),
    );
    const hpPct = this.cachedTick.hpMax > 0 ? this.cachedTick.hp / this.cachedTick.hpMax : 0;
    this.model.update(0, {
      hpPct,
      phase: this.cachedTick.phase,
      anim: mapStateToAnim(this.cachedTick.state),
    });
  }

  getFeetWorldY(): number | null {
    this.mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.model.parts.root);
    if (box.isEmpty() || !Number.isFinite(box.min.y)) return null;
    return box.min.y;
  }

  projectScreenBounds(
    camera: THREE.Camera,
    vw: number,
    vh: number,
  ): { x0: number; y0: number; x1: number; y1: number; onScreen: boolean } | null {
    this.mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.model.parts.root);
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
    // 0.15s / 0.08m hit knockback: wrapper shifts +0.08m backward (local +Z) and rebounds cleanly
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
    this.modelWrap.position.z = this.currentRecoilZ;

    if (isDead) {
      this.advanceDeath(dtSec);
      return;
    }

    // Subtle upper-body flinch tilt on hit recoil (rebounds cleanly to 0)
    const recoilFrac = this.currentRecoilZ / BOSS_HIT_RECOIL_DIST;
    this.modelWrap.rotation.x = recoilFrac * 0.06;
    this.modelWrap.rotation.z = 0;
    this.modelWrap.position.y = this.modelBaseY;

    const hpPct = this.cachedTick.hpMax > 0 ? this.cachedTick.hp / this.cachedTick.hpMax : 0;
    this.model.update(dtSec, {
      hpPct,
      phase: this.cachedTick.phase,
      anim: mapStateToAnim(state),
    });
  }

  private advanceDeath(dtSec: number): void {
    if (!this.deadStarted) {
      this.deadStarted = true;
      this.deadElapsedSec = 0;
    }
    this.deadElapsedSec += dtSec;
    const u = clamp01(this.deadElapsedSec / DEATH_COLLAPSE_SEC);
    const fallEase = u * u * (3 - 2 * u);

    this.modelWrap.rotation.x = dampVal(this.modelWrap.rotation.x, fallEase * 1.44, 14, dtSec);
    this.modelWrap.rotation.z = dampVal(this.modelWrap.rotation.z, fallEase * 0.18, 14, dtSec);
    this.modelWrap.position.y = dampVal(this.modelWrap.position.y, this.modelBaseY + fallEase * 0.42, 12, dtSec);
    this.model.update(dtSec, { hpPct: 0, phase: 2, anim: 'recover' });

    const fadeStart = DEATH_COLLAPSE_SEC + CORPSE_HOLD_SEC;
    if (this.deadElapsedSec >= fadeStart) {
      const fu = clamp01((this.deadElapsedSec - fadeStart) / CORPSE_FADE_SEC);
      const opacity = 1 - fu;
      this.deathFadeApplied = true;
      this.setModelFade(opacity);
      this.shadowMat.opacity = CONTACT_SHADOW_OPACITY * opacity;
      if (fu >= 1) {
        this.shadowMesh.visible = false;
      }
    }
  }

  private setModelFade(opacity: number): void {
    const mats = new Set<THREE.Material>();
    this.model.parts.root.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      if (Array.isArray(obj.material)) {
        for (const m of obj.material) mats.add(m);
      } else if (obj.material) {
        mats.add(obj.material);
      }
    });
    for (const m of mats) {
      m.transparent = true;
      m.opacity = opacity;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.artillery.dispose();
    this.scene.remove(this.mesh);
    this.model.dispose();
    this.shadowMat.dispose();
  }
}
