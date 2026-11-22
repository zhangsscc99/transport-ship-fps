// Procedural Cyberpunk Robot Enemy Renderer (zero external models/GLBs):
//   - Built from src/render/robotModel.ts (shared geometry & PBR material cache, <= 2500 tris/unit).
//   - Faction distinction strictly by emissive glow color: enemy (#FF2D95) / ally (#22E0FF).
//   - Smooth damped joint-rotation + translation animation across all 6+ states:
//       idle / walk (run) / aim (crouch / reload) / fire / hit (0.12s armor compress + white visor flash) / death
//   - Real-time sole-to-deck grounding so boots stay flush on deck y=0.
//   - Death: articulated robotic collapse, 2.5s hold on deck, then 0.6s clean dissolve.

import * as THREE from 'three';
import { PALETTE } from './palette';
import { BOT_TURN_RATE, type EnemyBot, type EnemyClip, type Faction } from '../game/ai';
import { createRobot, type RobotInstance } from './robotModel';

export const ROBOT_MODEL_SOURCE = 'procedural:cyberpunk-robot';

const HIT_FLASH_MS = 120; // exact 0.12s armor compression + white visor flash
const FIRE_RECOIL_MS = 220;
const DEATH_COLLAPSE_SEC = 0.72;
const CORPSE_HOLD_SEC = 2.5;
const CORPSE_FADE_SEC = 0.6;

/** Grounded contact shadow disc anchored directly under each robot's feet. */
const CONTACT_SHADOW_DIAMETER = 1.05;
const CONTACT_SHADOW_Y = 0.012;
const CONTACT_SHADOW_OPACITY = 0.82;
const CONTACT_SHADOW_RENDER_ORDER = -1;

let sharedShadowTex: THREE.CanvasTexture | null = null;
let sharedShadowGeo: THREE.PlaneGeometry | null = null;

/** Local procedural 128² radial-gradient contact shadow texture (created once). */
function makeContactShadowTex(): THREE.CanvasTexture {
  const size = 128;
  const half = size / 2;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(half, half, 0, half, half, half - 2);
  g.addColorStop(0.0, 'rgba(12, 16, 24, 0.74)');
  g.addColorStop(0.32, 'rgba(12, 16, 24, 0.56)');
  g.addColorStop(0.58, 'rgba(12, 16, 24, 0.26)');
  g.addColorStop(0.82, 'rgba(12, 16, 24, 0.07)');
  g.addColorStop(1.0, 'rgba(12, 16, 24, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function wrapPi(a: number): number {
  let r = a % (2 * Math.PI);
  if (r <= -Math.PI) r += 2 * Math.PI;
  else if (r > Math.PI) r -= 2 * Math.PI;
  return r;
}

function turnAngleToward(current: number, target: number, maxStep: number): number {
  const diff = wrapPi(target - current);
  if (Math.abs(diff) <= maxStep) return wrapPi(target);
  return wrapPi(current + Math.sign(diff) * maxStep);
}

function dampVal(cur: number, target: number, lambda: number, dt: number): number {
  if (dt <= 0) return target;
  return cur + (target - cur) * (1 - Math.exp(-lambda * dt));
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

interface JointTargets {
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
  elLY: number;
  shRX: number;
  shRY: number;
  shRZ: number;
  elRX: number;
  elRZ: number;
  wpnX: number;
  wpnY: number;
  wpnZ: number;
  wpnPosZ: number;
  hipLX: number;
  hipLZ: number;
  kneeLX: number;
  ankleLX: number;
  hipRX: number;
  hipRZ: number;
  kneeRX: number;
  ankleRX: number;
}

function defaultTargets(): JointTargets {
  return {
    bodyY: 0.96,
    bodyPitch: 0,
    bodyRoll: 0,
    torsoPitch: 0,
    torsoYaw: 0,
    headY: 0.56,
    headPitch: 0,
    headYaw: 0,
    shLX: 0.34,
    shLY: -0.22,
    shLZ: 0.14,
    elLX: 0.62,
    elLY: 0.18,
    shRX: 0.24,
    shRY: 0.18,
    shRZ: -0.06,
    elRX: 0.66,
    elRZ: 0.04,
    wpnX: -1.10,
    wpnY: -0.24,
    wpnZ: -0.06,
    wpnPosZ: -0.02,
    hipLX: 0.04,
    hipLZ: 0.04,
    kneeLX: -0.08,
    ankleLX: 0.04,
    hipRX: -0.04,
    hipRZ: -0.04,
    kneeRX: -0.08,
    ankleRX: 0.12,
  };
}

export class EnemyRig {
  readonly root = new THREE.Group();
  readonly faction: Faction;

  private readonly robot: RobotInstance;
  private readonly shadowMesh: THREE.Mesh;
  private readonly shadowMat: THREE.MeshBasicMaterial;
  private readonly pose: JointTargets = defaultTargets();
  private readonly targetPose: JointTargets = defaultTargets();

  private activeClip: EnemyClip = 'idle_rifle';
  private modelYaw = 0;
  private yawInitialized = false;
  private animTime = 0;
  private reloadStartMs = -10000;
  private wasReloading = false;
  private deadStarted = false;
  private deadElapsedSec = 0;
  private deathSideSign = 1;
  private disposed = false;

  private readonly tmpSoleL = new THREE.Vector3();
  private readonly tmpSoleR = new THREE.Vector3();

  /** Clips played by this enemy instance (diagnostic telemetry for e2e). */
  readonly clipsPlayed = new Set<EnemyClip>();

  constructor(faction: Faction) {
    this.faction = faction;
    this.root.name = `enemy-rig-${faction}`;

    this.robot = createRobot(faction);
    this.root.add(this.robot.root);

    // Contact shadow disc under feet
    if (!sharedShadowTex) sharedShadowTex = makeContactShadowTex();
    if (!sharedShadowGeo) {
      sharedShadowGeo = new THREE.PlaneGeometry(CONTACT_SHADOW_DIAMETER, CONTACT_SHADOW_DIAMETER);
      sharedShadowGeo.rotateX(-Math.PI / 2);
    }
    this.shadowMat = new THREE.MeshBasicMaterial({
      map: sharedShadowTex,
      transparent: true,
      opacity: CONTACT_SHADOW_OPACITY,
      depthWrite: false,
    });
    this.shadowMesh = new THREE.Mesh(sharedShadowGeo, this.shadowMat);
    this.shadowMesh.name = `enemy-shadow-${faction}`;
    this.shadowMesh.position.set(0, CONTACT_SHADOW_Y, 0);
    this.shadowMesh.renderOrder = CONTACT_SHADOW_RENDER_ORDER;
    this.shadowMesh.castShadow = false;
    this.shadowMesh.receiveShadow = false;
    this.shadowMesh.frustumCulled = false;
    this.root.add(this.shadowMesh);

    this.applyJointsToRig();
    this.groundFeet();
  }

  get triangleCount(): number {
    return this.robot.triangleCount;
  }

  get isLoaded(): boolean {
    return true;
  }

  get currentClip(): EnemyClip {
    return this.activeClip;
  }

  get isFinishedCorpse(): boolean {
    return this.disposed;
  }

  /** Real-time world-space Box3 lowest Y of the robot chassis (excludes contact shadow). */
  measureFeetWorldY(): number | null {
    this.root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.robot.root);
    if (box.isEmpty() || !Number.isFinite(box.min.y)) return null;
    return box.min.y;
  }

  /** Read actual world-space head top (top of floating helmet) for overhead distance tags. */
  getHeadTopWorld(out: THREE.Vector3): THREE.Vector3 {
    this.root.updateMatrixWorld(true);
    this.robot.headTopAnchor.getWorldPosition(out);
    return out;
  }

  /** Read actual pulse carbine muzzle world position for enemy tracers. */
  getMuzzleWorld(out: THREE.Vector3): boolean {
    this.root.updateMatrixWorld(true);
    this.robot.muzzleAnchor.getWorldPosition(out);
    return true;
  }

  private applyJointsToRig(): void {
    const j = this.robot.joints;
    const p = this.pose;
    j.bodyPivot.position.set(0, p.bodyY, 0);
    j.bodyPivot.rotation.set(p.bodyPitch, 0, p.bodyRoll);
    j.torsoPivot.rotation.set(p.torsoPitch, p.torsoYaw, 0);
    j.headPivot.position.set(0, p.headY, 0);
    j.headPivot.rotation.set(p.headPitch, p.headYaw, 0);
    j.shoulderL.rotation.set(p.shLX, p.shLY, p.shLZ);
    j.elbowL.rotation.set(p.elLX, p.elLY, 0);
    j.shoulderR.rotation.set(p.shRX, p.shRY, p.shRZ);
    j.elbowR.rotation.set(p.elRX, 0, p.elRZ);
    j.weaponMount.rotation.set(p.wpnX, p.wpnY, p.wpnZ);
    j.weaponMount.position.set(-0.01, -0.24, p.wpnPosZ);
    j.hipL.rotation.set(p.hipLX, 0, p.hipLZ);
    j.kneeL.rotation.set(p.kneeLX, 0, 0);
    j.ankleL.rotation.set(p.ankleLX, 0, 0);
    j.hipR.rotation.set(p.hipRX, 0, p.hipRZ);
    j.kneeR.rotation.set(p.kneeRX, 0, 0);
    j.ankleR.rotation.set(p.ankleRX, 0, 0);
  }

  /** Keep the supporting boot sole flush with root.position.y (deck y=0) across all live poses. */
  private groundFeet(): void {
    this.robot.root.position.y = 0;
    this.root.updateMatrixWorld(true);
    this.robot.soleProbeL.getWorldPosition(this.tmpSoleL);
    this.robot.soleProbeR.getWorldPosition(this.tmpSoleR);
    const minWorldY = Math.min(this.tmpSoleL.y, this.tmpSoleR.y);
    const localMinY = minWorldY - this.root.position.y;
    if (Number.isFinite(localMinY)) {
      this.robot.root.position.y = -localMinY;
    }
  }

  private computeTargetPose(bot: EnemyBot, nowMs: number): void {
    const t = this.targetPose;
    const base = defaultTargets();
    Object.assign(t, base);

    const clip = bot.anim;
    const phase = bot.walkPhase;
    const idleT = this.animTime;
    const hoverBob = Math.sin(idleT * 3.1 + bot.slotIndex * 1.3) * 0.016;
    t.headY = 0.56 + hoverBob;

    // Derive primary locomotion/combat posture (note: 'hit' overlays onto movement/combat!)
    const baseClip: EnemyClip =
      clip === 'hit'
        ? bot.state === 'PATROL'
          ? bot.advancing
            ? 'run_rifle'
            : 'walk_rifle'
          : bot.state === 'CHASE'
            ? 'run_rifle'
            : bot.state === 'COVER'
              ? 'crouch_rifle'
              : bot.state === 'RELOAD'
                ? 'reload_rifle'
                : bot.state === 'ENGAGE' || bot.state === 'ALERT'
                  ? 'aim_rifle'
                  : 'idle_rifle'
        : clip;

    if (baseClip === 'idle_rifle') {
      // Tactical cyber idle: gentle chassis breathing + floating head scan + low-ready carbine
      const breathe = Math.sin(idleT * 2.1 + bot.slotIndex) * 0.012;
      t.bodyY = 0.96 + breathe;
      t.torsoPitch = -0.03 + Math.sin(idleT * 1.6) * 0.018;
      t.torsoYaw = Math.sin(idleT * 0.9 + bot.slotIndex) * 0.07;
      t.headYaw = Math.sin(idleT * 1.35 + bot.slotIndex * 1.7) * 0.24;
      t.headPitch = Math.sin(idleT * 0.8) * 0.04;
      t.shLX = 0.36;
      t.shLY = -0.26;
      t.shLZ = 0.14;
      t.elLX = 0.68;
      t.elLY = 0.22;
      t.shRX = 0.24;
      t.shRY = 0.16;
      t.shRZ = -0.06;
      t.elRX = 0.66;
      t.wpnX = -1.10;
      t.wpnY = -0.24;
      t.hipLX = 0.08;
      t.hipLZ = 0.05;
      t.kneeLX = -0.14;
      t.ankleLX = 0.06;
      t.hipRX = -0.06;
      t.hipRZ = -0.05;
      t.kneeRX = -0.12;
      t.ankleRX = 0.18;
    } else if (baseClip === 'walk_rifle' || baseClip === 'run_rifle') {
      // Articulated bipedal mechanical gait (hip swing + knee lift + counter-torso twist + weapon carry)
      const isRun = baseClip === 'run_rifle';
      const amp = isRun ? 0.68 : 0.44;
      const s = Math.sin(phase);
      const c = Math.cos(phase);
      const bounce = Math.abs(c) * (isRun ? 0.045 : 0.025);

      t.bodyY = (isRun ? 0.91 : 0.945) + bounce;
      t.torsoPitch = isRun ? -0.22 : -0.10;
      t.torsoYaw = -s * (isRun ? 0.16 : 0.10);
      t.headYaw = -t.torsoYaw * 0.65;
      t.headPitch = isRun ? 0.14 : 0.06;

      // Left leg stride
      t.hipLX = s * amp;
      t.kneeLX = -Math.max(0.08, -c * (isRun ? 0.85 : 0.55) + 0.18);
      t.ankleLX = -t.hipLX * 0.45 - t.kneeLX * 0.4;

      // Right leg opposite phase
      t.hipRX = -s * amp;
      t.kneeRX = -Math.max(0.08, c * (isRun ? 0.85 : 0.55) + 0.18);
      t.ankleRX = -t.hipRX * 0.45 - t.kneeRX * 0.4;

      // Arms carry carbine across torso while pumping slightly with stride
      const armSway = s * (isRun ? 0.14 : 0.07);
      t.shRX = (isRun ? 0.42 : 0.34) - armSway;
      t.shRY = 0.24;
      t.shRZ = -0.08;
      t.elRX = isRun ? 0.88 : 0.76;
      t.wpnX = -(t.shRX + t.elRX) - (isRun ? 0.12 : 0.06);
      t.wpnY = -0.34;
      t.wpnZ = -0.10;

      t.shLX = (isRun ? 0.58 : 0.46) + armSway;
      t.shLY = -0.44;
      t.shLZ = 0.18;
      t.elLX = isRun ? 0.92 : 0.78;
      t.elLY = 0.28;
    } else if (baseClip === 'aim_rifle' || baseClip === 'fire_rifle') {
      // Planted firing stance: angled shoulders, carbine leveled dead ahead (-Z), head locked on target
      const strafeS = bot.speed > 0.15 ? Math.sin(phase) * 0.22 : 0;
      t.bodyY = 0.91;
      t.torsoPitch = -0.07;
      t.torsoYaw = 0.26;
      t.headYaw = -0.26; // head counter-turns so horizontal visor locks straight onto player!
      t.headPitch = 0.04;

      // Right arm shoulders pulse carbine dead level along -Z
      t.shRX = 0.48;
      t.shRY = 0.08;
      t.shRZ = -0.08;
      t.elRX = 0.96;
      t.elRZ = 0.08;
      t.wpnX = -(t.shRX + t.elRX);
      t.wpnY = -0.32;
      t.wpnZ = 0;

      // Left arm cradles forward shroud
      t.shLX = 0.86;
      t.shLY = -0.52;
      t.shLZ = 0.22;
      t.elLX = 0.84;
      t.elLY = 0.32;

      // Wide combat stance legs
      t.hipLX = 0.22 + strafeS;
      t.hipLZ = 0.08;
      t.kneeLX = -0.36;
      t.ankleLX = 0.14;
      t.hipRX = -0.18 - strafeS;
      t.hipRZ = -0.08;
      t.kneeRX = -0.28;
      t.ankleRX = 0.42;

      // Punchy mechanical recoil kick during fire_rifle
      if (baseClip === 'fire_rifle') {
        const sinceStart = Math.max(0, nowMs - bot.fireAnimStartAt);
        const kickU = clamp01(1 - sinceStart / FIRE_RECOIL_MS);
        const kick = Math.sin(kickU * Math.PI);
        t.torsoPitch += kick * 0.09;
        t.shRX += kick * 0.20;
        t.elRX -= kick * 0.08;
        t.wpnX = -(t.shRX + t.elRX) + kick * 0.14;
        t.wpnPosZ = -0.02 + kick * 0.065;
        t.headPitch += kick * 0.04;
      }
    } else if (baseClip === 'crouch_rifle') {
      // Deep tactical crouch + lateral cover shuffle
      const strafeS = bot.speed > 0.15 ? Math.sin(phase) * 0.32 : 0;
      t.bodyY = 0.68;
      t.torsoPitch = -0.20;
      t.torsoYaw = 0.22;
      t.headYaw = -0.22;
      t.headPitch = 0.15;

      t.shRX = 0.56;
      t.shRY = 0.10;
      t.shRZ = -0.08;
      t.elRX = 0.94;
      t.wpnX = -(t.shRX + t.elRX) + 0.12;
      t.wpnY = -0.28;

      t.shLX = 0.88;
      t.shLY = -0.48;
      t.shLZ = 0.22;
      t.elLX = 0.86;
      t.elLY = 0.28;

      t.hipLX = 0.72 + strafeS;
      t.hipLZ = 0.10;
      t.kneeLX = -1.12;
      t.ankleLX = 0.40;
      t.hipRX = 0.48 - strafeS;
      t.hipRZ = -0.10;
      t.kneeRX = -1.04;
      t.ankleRX = 0.56;
    } else if (baseClip === 'reload_rifle') {
      // Articulated 2.2s energy-cell swap animation
      const elapsed = Math.max(0, nowMs - this.reloadStartMs);
      const u = clamp01(elapsed / 2200);
      const dip = Math.sin(u * Math.PI);
      const magReach = u > 0.18 && u < 0.72 ? Math.sin(((u - 0.18) / 0.54) * Math.PI) : 0;

      t.bodyY = 0.91 - dip * 0.03;
      t.torsoPitch = -0.14 - dip * 0.08;
      t.torsoYaw = 0.18;
      t.headYaw = -0.10;
      t.headPitch = -0.18 * dip;

      // Right arm tilts weapon inward so magazine well is accessible
      t.shRX = 0.42;
      t.shRY = 0.24;
      t.shRZ = -0.12;
      t.elRX = 0.92;
      t.wpnX = -(t.shRX + t.elRX) + 0.22 * dip;
      t.wpnY = -0.42;
      t.wpnZ = 0.35 * dip;

      // Left arm drops to hip cell pouch and slaps fresh energy cell into receiver
      t.shLX = 0.78 - magReach * 0.58;
      t.shLY = -0.42 + magReach * 0.28;
      t.shLZ = 0.18 + magReach * 0.12;
      t.elLX = 0.86 - magReach * 0.32;
      t.elLY = 0.25;

      t.hipLX = 0.16;
      t.kneeLX = -0.24;
      t.ankleLX = 0.08;
      t.hipRX = -0.12;
      t.kneeRX = -0.22;
      t.ankleRX = 0.34;
    }

    // --- Hit feedback: exact 0.12s armor compression + white visor flash ---
    const sinceHit = nowMs - bot.lastHitAt;
    const hitFlashActive = sinceHit >= 0 && sinceHit < HIT_FLASH_MS;
    this.robot.setHitFlash(hitFlashActive);
    if (hitFlashActive) {
      // Sharp initial impact compression easing cleanly back within 120ms
      const hu = sinceHit / HIT_FLASH_MS;
      const compress = Math.sin(Math.pow(hu, 0.55) * Math.PI);
      t.bodyY -= compress * 0.12;
      t.torsoPitch += compress * 0.22;
      t.headY -= compress * 0.055;
      t.headPitch += compress * 0.14;
      t.shLZ -= compress * 0.18; // pauldrons hunch inward under impact
      t.shRZ += compress * 0.18;
      t.kneeLX -= compress * 0.26;
      t.kneeRX -= compress * 0.26;
    }
  }

  /** Synchronize position, yaw, procedural joint animation, hit flash, muzzle flash & death collapse. */
  sync(bot: EnemyBot, dt: number, nowMs: number): void {
    const p = bot.entity.pos;
    this.root.position.set(p.x, p.y, p.z);

    // Robot faces -Z in local space matching ai.ts yaw convention directly!
    const targetModelYaw = wrapPi(bot.yaw);
    if (!this.yawInitialized) {
      this.modelYaw = targetModelYaw;
      this.yawInitialized = true;
    } else if (bot.state !== 'DEAD' && bot.entity.alive) {
      this.modelYaw = turnAngleToward(this.modelYaw, targetModelYaw, BOT_TURN_RATE * dt);
    }
    this.robot.root.rotation.y = this.modelYaw;

    // --- DEAD state ---
    if (bot.state === 'DEAD' || !bot.entity.alive) {
      this.activeClip = 'die';
      this.clipsPlayed.add('die');
      this.advanceDeath(dt);
      return;
    }

    this.animTime += dt;
    this.activeClip = bot.anim;
    this.clipsPlayed.add(bot.anim);

    if (bot.anim === 'reload_rifle' && !this.wasReloading) {
      this.reloadStartMs = nowMs;
      this.wasReloading = true;
    } else if (bot.anim !== 'reload_rifle') {
      this.wasReloading = false;
    }

    this.computeTargetPose(bot, nowMs);

    // Fast damping on hit compression (38/s) so 0.12s flinch is crisp; smooth 16/s for locomotion/aim
    const sinceHit = nowMs - bot.lastHitAt;
    const dampRate = sinceHit >= 0 && sinceHit < HIT_FLASH_MS + 40 ? 40 : 16;
    for (const key of Object.keys(this.pose) as (keyof JointTargets)[]) {
      this.pose[key] = dampVal(this.pose[key], this.targetPose[key], dampRate, dt);
    }
    this.applyJointsToRig();
    this.groundFeet();

    // Muzzle flash quad briefly visible on shot
    const sinceFire = nowMs - bot.lastFireAt;
    const flashOn = sinceFire >= 0 && sinceFire < 75;
    this.robot.muzzleMesh.visible = flashOn;
    if (flashOn) {
      this.robot.muzzleMat.opacity = 1 - sinceFire / 75;
      this.robot.muzzleMesh.rotation.z = (nowMs * 0.13) % (Math.PI * 2);
      const sc = 0.85 + 0.35 * (1 - sinceFire / 75);
      this.robot.muzzleMesh.scale.set(sc, sc, 1);
    }
  }

  /** Articulated robotic collapse, 2.5s deck hold, and 0.6s clean dissolve. */
  advanceDeath(dt: number): void {
    if (!this.deadStarted) {
      this.deadStarted = true;
      this.deadElapsedSec = 0;
      this.deathSideSign = Math.sin(this.modelYaw * 3.1) >= 0 ? 1 : -1;
      this.robot.muzzleMesh.visible = false;
      this.robot.setHitFlash(false);
    }

    this.deadElapsedSec += dt;
    const u = clamp01(this.deadElapsedSec / DEATH_COLLAPSE_SEC);
    // Ease-in-out collapse: buckle knees first, then topple chassis onto steel deck
    const buckle = clamp01(u / 0.35);
    const fall = clamp01((u - 0.18) / 0.82);
    const fallEase = fall * fall * (3 - 2 * fall);

    const p = this.pose;
    p.bodyY = dampVal(p.bodyY, 0.96 - buckle * 0.28 - fallEase * 0.48, 22, dt);
    p.bodyPitch = dampVal(p.bodyPitch, fallEase * 1.44, 18, dt); // pitches backwards onto deck
    p.bodyRoll = dampVal(p.bodyRoll, fallEase * 0.28 * this.deathSideSign, 18, dt);
    p.torsoPitch = dampVal(p.torsoPitch, 0.12 + fallEase * 0.14, 16, dt);
    p.torsoYaw = dampVal(p.torsoYaw, 0.15 * this.deathSideSign, 16, dt);
    // Floating head loses magnetic power and drops onto collar/deck
    p.headY = dampVal(p.headY, 0.56 - fallEase * 0.11, 20, dt);
    p.headPitch = dampVal(p.headPitch, -0.35 * fallEase, 16, dt);
    p.headYaw = dampVal(p.headYaw, 0.45 * this.deathSideSign * fallEase, 16, dt);
    // Limbs splay out limp
    p.shLX = dampVal(p.shLX, -0.35 * fallEase, 14, dt);
    p.shLZ = dampVal(p.shLZ, 0.68 * fallEase, 14, dt);
    p.elLX = dampVal(p.elLX, 0.25, 14, dt);
    p.shRX = dampVal(p.shRX, -0.25 * fallEase, 14, dt);
    p.shRZ = dampVal(p.shRZ, -0.62 * fallEase, 14, dt);
    p.elRX = dampVal(p.elRX, 0.22, 14, dt);
    p.hipLX = dampVal(p.hipLX, 0.38 * buckle - 0.25 * fallEase, 16, dt);
    p.kneeLX = dampVal(p.kneeLX, -0.95 * buckle + 0.55 * fallEase, 16, dt);
    p.hipRX = dampVal(p.hipRX, 0.22 * buckle - 0.15 * fallEase, 16, dt);
    p.kneeRX = dampVal(p.kneeRX, -0.75 * buckle + 0.45 * fallEase, 16, dt);

    this.applyJointsToRig();
    this.robot.root.position.y = dampVal(this.robot.root.position.y, 0, 12, dt);

    const fadeStartSec = DEATH_COLLAPSE_SEC + CORPSE_HOLD_SEC;
    if (this.deadElapsedSec >= fadeStartSec) {
      const fu = clamp01((this.deadElapsedSec - fadeStartSec) / CORPSE_FADE_SEC);
      const opacity = 1 - fu;
      this.robot.setDeathFade(opacity);
      this.shadowMat.opacity = CONTACT_SHADOW_OPACITY * opacity;
      if (fu >= 1) {
        this.shadowMesh.visible = false;
        this.disposed = true;
      }
    }
  }

  dispose(): void {
    this.robot.dispose();
    this.shadowMat.dispose();
  }
}

export class EnemyRenderer {
  private readonly scene: THREE.Scene;
  private rigs = new Map<string, EnemyRig>();
  /** Corpses detached from active bot slots so collapse + 2.5s hold + dissolve always completes. */
  private dyingCorpses: EnemyRig[] = [];

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    void PALETTE.robotArmor; // keep explicit palette link
  }

  get isModelLoaded(): boolean {
    return true;
  }

  get modelSource(): string {
    return ROBOT_MODEL_SOURCE;
  }

  /** Synchronize rendered EnemyRigs with active EnemyBots (creates rigs & preserves dissolving corpses). */
  sync(bots: readonly EnemyBot[], dt: number, nowMs: number, _cameraPos?: THREE.Vector3): void {
    const aliveIds = new Set<string>();
    for (const bot of bots) {
      aliveIds.add(bot.id);
      let rig = this.rigs.get(bot.id);
      if (!rig) {
        rig = new EnemyRig(bot.faction);
        this.rigs.set(bot.id, rig);
        this.scene.add(rig.root);
      }
      rig.sync(bot, dt, nowMs);
    }

    for (const [id, rig] of this.rigs) {
      if (!aliveIds.has(id)) {
        this.rigs.delete(id);
        if (rig.currentClip === 'die' && !rig.isFinishedCorpse) {
          this.dyingCorpses.push(rig);
        } else {
          this.scene.remove(rig.root);
          rig.dispose();
        }
      }
    }

    // Advance detached dying corpses through collapse, hold & dissolve
    for (let i = this.dyingCorpses.length - 1; i >= 0; i--) {
      const c = this.dyingCorpses[i];
      c.advanceDeath(dt);
      if (c.isFinishedCorpse) {
        this.scene.remove(c.root);
        c.dispose();
        this.dyingCorpses.splice(i, 1);
      }
    }
  }

  /** Immediately remove all live rigs and dissolving corpses (menu reset / e2e clearEnemies). */
  clearAll(): void {
    for (const rig of this.rigs.values()) {
      this.scene.remove(rig.root);
      rig.dispose();
    }
    this.rigs.clear();
    for (const c of this.dyingCorpses) {
      this.scene.remove(c.root);
      c.dispose();
    }
    this.dyingCorpses.length = 0;
  }

  getRigTris(botId: string): number {
    return this.rigs.get(botId)?.triangleCount ?? 0;
  }

  getActiveClip(botId: string): EnemyClip {
    return this.rigs.get(botId)?.currentClip ?? 'idle_rifle';
  }

  getClipsPlayed(botId: string): EnemyClip[] {
    const rig = this.rigs.get(botId);
    return rig ? Array.from(rig.clipsPlayed) : [];
  }

  getHeadTopWorld(botId: string, out: THREE.Vector3): boolean {
    const rig = this.rigs.get(botId);
    if (!rig) return false;
    rig.getHeadTopWorld(out);
    return true;
  }

  getMuzzleWorld(botId: string, out: THREE.Vector3): boolean {
    const rig = this.rigs.get(botId);
    if (!rig) return false;
    return rig.getMuzzleWorld(out);
  }

  getMaxBotTris(): number {
    let mx = 0;
    for (const r of this.rigs.values()) {
      if (r.triangleCount > mx) mx = r.triangleCount;
    }
    return mx;
  }

  measureFeetWorldY(botId: string): number | null {
    return this.rigs.get(botId)?.measureFeetWorldY() ?? null;
  }
}
