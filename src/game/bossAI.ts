// Pure melee Boss AI state machine — zero three.js / DOM dependencies.
//
// State flow:
//   idle -> chase (tracks & walks toward player)
//        -> windup (>=600ms telegraph, stationary)
//        -> attack (180ms melee swing, hitWindowOpen during first 60%, hits only if <= attackRange)
//        -> recover (>=800ms stagger, stationary)
//        -> chase (cooldown timer before next windup/charge)
//
// Long-distance gap closer:
//   chase + distance > chargeTriggerDist (18m) -> charge (straight-line rush at 2.2x speed,
//   yaw locked so player can sidestep; single hit on contact -> recover).
//
// Phases:
//   Phase 1 (hp > 70%): base speed, base cooldown, base windup (>=600ms)
//   Phase 2 (hp <= 70%): +15% speed, -20% cooldown, -100ms windup (clamped >=600ms), emits 'phase2'
//   Phase 2 enraged (hp <= 35%): further -10% cooldown (-30% total from base)
//
// Defeated (hp <= 0): freezes in 'recover' and emits no attack events.

export type BossState = 'idle' | 'chase' | 'windup' | 'attack' | 'recover' | 'charge';

export type BossEvent =
  | 'windup_start'
  | 'attack_start'
  | 'attack_hit'
  | 'recover_end'
  | 'charge_start'
  | 'phase2';

export type BossHitPart = 'body' | 'head' | 'core';

export interface BossAIOptions {
  moveSpeed?: number;         // 默认 2.6 m/s（二阶段 +15%）
  attackRange?: number;       // 默认 3.2 m
  chargeTriggerDist?: number; // 玩家 >18m 时冲锋
  windupMs?: number;          // 默认 700（必须 ≥600）
  attackMs?: number;          // 默认 180
  recoverMs?: number;         // 默认 800
  cooldownMs?: number;        // 两次出招之间，默认 900
}

export interface BossTick {
  state: BossState;
  pos: { x: number; z: number };
  yaw: number;                // 朝向玩家（弧度，yaw=0 朝向 -Z）
  hp: number;
  hpMax: number;
  phase: 1 | 2;
  hitWindowOpen: boolean;     // 只有 attack 的前 60% 允许判定命中
  events: BossEvent[];
}

export const BOSS_DEFAULTS = {
  hpMax: 2000,
  moveSpeed: 2.6,
  attackRange: 3.2,
  chargeTriggerDist: 18,
  windupMs: 700,
  minWindupMs: 600,
  attackMs: 180,
  hitWindowRatio: 0.6,
  recoverMs: 800,
  minRecoverMs: 800,
  cooldownMs: 900,
  chargeSpeedMult: 2.2,
  chargeHitRadius: 1.8,
  chargeOvershootDist: 2.5,
  chargeMaxCapDist: 45,
  phase2HpRatio: 0.7,
  phase2EnrageHpRatio: 0.35,
  phase2SpeedMult: 1.15,
  phase2CooldownMult: 0.8,
  phase2EnrageCooldownMult: 0.7,
  phase2WindupDeltaMs: 100,
} as const;

export const BOSS_WEAKPOINT_MULT: Readonly<Record<BossHitPart, number>> = {
  body: 1.0,
  core: 2.0,
  head: 2.5,
};

const EPS = 1e-6;
const RATIO_EPS = 1e-9;

/** Yaw facing along (dx, dz), matching repo convention (yaw=0 -> -Z). */
function yawFromDir(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz);
}

/** Shortest 2D distance from point (px, pz) to line segment (ax, az)-(bx, bz). */
function pointToSegmentDist(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const vx = bx - ax;
  const vz = bz - az;
  const lenSq = vx * vx + vz * vz;
  if (lenSq <= EPS * EPS) {
    return Math.hypot(px - ax, pz - az);
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (pz - az) * vz) / lenSq));
  return Math.hypot(px - (ax + vx * t), pz - (az + vz * t));
}

export class BossAI {
  private readonly hpMax: number;
  private readonly baseMoveSpeed: number;
  private readonly attackRange: number;
  private readonly chargeTriggerDist: number;
  private readonly baseWindupMs: number;
  private readonly attackMs: number;
  private readonly recoverMs: number;
  private readonly baseCooldownMs: number;

  private state: BossState = 'idle';
  private pos: { x: number; z: number } = { x: 0, z: 0 };
  private yaw = 0;
  private hp: number;
  private phase: 1 | 2 = 1;

  private stateElapsedMs = 0;
  private cooldownRemainingMs = 0;
  private attackHitDealt = false;
  private pendingPhase2Event = false;

  // Straight-line charge lock (heading fixed on charge entry)
  private chargeDirX = 0;
  private chargeDirZ = -1;
  private chargeTraveled = 0;
  private chargeMaxDist = 0;
  private chargeHitDealt = false;

  constructor(hpMax?: number, opts?: BossAIOptions) {
    this.hpMax =
      hpMax !== undefined && Number.isFinite(hpMax) && hpMax > 0
        ? hpMax
        : BOSS_DEFAULTS.hpMax;
    this.hp = this.hpMax;

    this.baseMoveSpeed =
      opts?.moveSpeed !== undefined && Number.isFinite(opts.moveSpeed) && opts.moveSpeed > 0
        ? opts.moveSpeed
        : BOSS_DEFAULTS.moveSpeed;
    this.attackRange =
      opts?.attackRange !== undefined && Number.isFinite(opts.attackRange) && opts.attackRange > 0
        ? opts.attackRange
        : BOSS_DEFAULTS.attackRange;
    this.chargeTriggerDist =
      opts?.chargeTriggerDist !== undefined &&
      Number.isFinite(opts.chargeTriggerDist) &&
      opts.chargeTriggerDist > 0
        ? opts.chargeTriggerDist
        : BOSS_DEFAULTS.chargeTriggerDist;
    const rawWindup =
      opts?.windupMs !== undefined && Number.isFinite(opts.windupMs)
        ? opts.windupMs
        : BOSS_DEFAULTS.windupMs;
    this.baseWindupMs = Math.max(BOSS_DEFAULTS.minWindupMs, rawWindup);
    this.attackMs =
      opts?.attackMs !== undefined && Number.isFinite(opts.attackMs) && opts.attackMs > 0
        ? opts.attackMs
        : BOSS_DEFAULTS.attackMs;
    const rawRecover =
      opts?.recoverMs !== undefined && Number.isFinite(opts.recoverMs)
        ? opts.recoverMs
        : BOSS_DEFAULTS.recoverMs;
    this.recoverMs = Math.max(BOSS_DEFAULTS.minRecoverMs, rawRecover);
    this.baseCooldownMs =
      opts?.cooldownMs !== undefined && Number.isFinite(opts.cooldownMs) && opts.cooldownMs >= 0
        ? opts.cooldownMs
        : BOSS_DEFAULTS.cooldownMs;
  }

  reset(): void {
    this.state = 'idle';
    this.pos = { x: 0, z: 0 };
    this.yaw = 0;
    this.hp = this.hpMax;
    this.phase = 1;
    this.stateElapsedMs = 0;
    this.cooldownRemainingMs = 0;
    this.attackHitDealt = false;
    this.pendingPhase2Event = false;
    this.chargeDirX = 0;
    this.chargeDirZ = -1;
    this.chargeTraveled = 0;
    this.chargeMaxDist = 0;
    this.chargeHitDealt = false;
  }

  applyDamage(amount: number, hitPart: BossHitPart): number {
    if (this.hp <= 0) return 0;
    if (!Number.isFinite(amount) || amount <= 0) return 0;

    const mult = BOSS_WEAKPOINT_MULT[hitPart];
    const actualDamage = amount * mult;
    this.hp = Math.max(0, this.hp - actualDamage);

    if (this.hp <= 0) {
      this.hp = 0;
      this.state = 'recover';
      this.stateElapsedMs = 0;
      this.cooldownRemainingMs = 0;
      this.attackHitDealt = false;
      this.pendingPhase2Event = false;
      return actualDamage;
    }

    if (this.phase === 1 && this.hp <= this.hpMax * BOSS_DEFAULTS.phase2HpRatio + RATIO_EPS) {
      this.phase = 2;
      this.pendingPhase2Event = true;
    }

    if (this.cooldownRemainingMs > 0) {
      this.cooldownRemainingMs = Math.min(this.cooldownRemainingMs, this.currentCooldownMs());
    }

    return actualDamage;
  }

  update(dtMs: number, player: { x: number; z: number }, distance: number): BossTick {
    if (this.hp <= 0) {
      this.state = 'recover';
      this.pendingPhase2Event = false;
      return this.snapshot(false, []);
    }

    const events: BossEvent[] = [];
    if (this.pendingPhase2Event) {
      events.push('phase2');
      this.pendingPhase2Event = false;
    }

    const dt = Number.isFinite(dtMs) && dtMs > 0 ? dtMs : 0;
    if (dt === 0) {
      return this.snapshot(this.isHitWindowOpen(), events);
    }

    const dx = player.x - this.pos.x;
    const dz = player.z - this.pos.z;
    const actualDist = Math.hypot(dx, dz);
    const effectiveDist =
      Number.isFinite(distance) && distance >= 0 ? distance : actualDist;

    if (this.state === 'idle') {
      if (!Number.isFinite(effectiveDist)) {
        return this.snapshot(false, events);
      }
      this.state = 'chase';
      this.stateElapsedMs = 0;
    }

    switch (this.state) {
      case 'chase':
        this.stepChase(dt, dx, dz, actualDist, effectiveDist, events);
        break;
      case 'windup':
        this.stepWindup(dt, dx, dz, actualDist, effectiveDist, events);
        break;
      case 'attack':
        this.stepAttack(dt, effectiveDist, events);
        break;
      case 'recover':
        this.stepRecover(dt, events);
        break;
      case 'charge':
        this.stepCharge(dt, player, actualDist, effectiveDist, events);
        break;
    }

    return this.snapshot(this.isHitWindowOpen(), events);
  }

  private currentMoveSpeed(): number {
    return this.phase === 2
      ? this.baseMoveSpeed * BOSS_DEFAULTS.phase2SpeedMult
      : this.baseMoveSpeed;
  }

  private currentWindupMs(): number {
    if (this.phase === 2) {
      return Math.max(
        BOSS_DEFAULTS.minWindupMs,
        this.baseWindupMs - BOSS_DEFAULTS.phase2WindupDeltaMs,
      );
    }
    return this.baseWindupMs;
  }

  private currentCooldownMs(): number {
    if (this.phase === 2) {
      if (this.hp <= this.hpMax * BOSS_DEFAULTS.phase2EnrageHpRatio + RATIO_EPS) {
        return this.baseCooldownMs * BOSS_DEFAULTS.phase2EnrageCooldownMult;
      }
      return this.baseCooldownMs * BOSS_DEFAULTS.phase2CooldownMult;
    }
    return this.baseCooldownMs;
  }

  private isHitWindowOpen(): boolean {
    return (
      this.hp > 0 &&
      this.state === 'attack' &&
      this.stateElapsedMs < this.attackMs * BOSS_DEFAULTS.hitWindowRatio
    );
  }

  private facePlayer(dx: number, dz: number, len: number): void {
    if (len > EPS) {
      this.yaw = yawFromDir(dx, dz);
    }
  }

  private stepChase(
    dtMs: number,
    dx: number,
    dz: number,
    actualDist: number,
    effectiveDist: number,
    events: BossEvent[],
  ): void {
    this.facePlayer(dx, dz, actualDist);

    if (this.cooldownRemainingMs > 0) {
      this.cooldownRemainingMs = Math.max(0, this.cooldownRemainingMs - dtMs);
    }

    if (this.cooldownRemainingMs <= 0) {
      if (effectiveDist <= this.attackRange) {
        this.state = 'windup';
        this.stateElapsedMs = 0;
        events.push('windup_start');
        return;
      }

      if (effectiveDist > this.chargeTriggerDist) {
        this.enterCharge(dtMs, dx, dz, actualDist, effectiveDist, events);
        return;
      }
    }

    // Move toward player when outside melee range (hold ground if already within range on cooldown)
    if (effectiveDist > this.attackRange && actualDist > EPS) {
      const step = Math.min(this.currentMoveSpeed() * (dtMs / 1000), actualDist);
      this.pos.x += (dx / actualDist) * step;
      this.pos.z += (dz / actualDist) * step;
    }
  }

  private stepWindup(
    dtMs: number,
    dx: number,
    dz: number,
    actualDist: number,
    effectiveDist: number,
    events: BossEvent[],
  ): void {
    // Stationary during windup telegraph; keeps facing player
    this.facePlayer(dx, dz, actualDist);
    this.stateElapsedMs += dtMs;

    if (this.stateElapsedMs >= this.currentWindupMs()) {
      this.state = 'attack';
      this.stateElapsedMs = 0;
      this.attackHitDealt = false;
      events.push('attack_start');

      if (this.isHitWindowOpen() && effectiveDist <= this.attackRange) {
        this.attackHitDealt = true;
        events.push('attack_hit');
      }
    }
  }

  private stepAttack(dtMs: number, effectiveDist: number, events: BossEvent[]): void {
    this.stateElapsedMs += dtMs;

    if (this.stateElapsedMs >= this.attackMs) {
      this.state = 'recover';
      this.stateElapsedMs = 0;
      return;
    }

    if (!this.attackHitDealt && this.isHitWindowOpen() && effectiveDist <= this.attackRange) {
      this.attackHitDealt = true;
      events.push('attack_hit');
    }
  }

  private stepRecover(dtMs: number, events: BossEvent[]): void {
    // Stationary during recovery stagger
    this.stateElapsedMs += dtMs;
    if (this.stateElapsedMs >= this.recoverMs) {
      this.state = 'chase';
      this.stateElapsedMs = 0;
      this.cooldownRemainingMs = this.currentCooldownMs();
      events.push('recover_end');
    }
  }

  private enterCharge(
    dtMs: number,
    dx: number,
    dz: number,
    actualDist: number,
    effectiveDist: number,
    events: BossEvent[],
  ): void {
    if (actualDist > EPS) {
      this.chargeDirX = dx / actualDist;
      this.chargeDirZ = dz / actualDist;
      this.yaw = yawFromDir(dx, dz);
    } else {
      this.chargeDirX = -Math.sin(this.yaw);
      this.chargeDirZ = -Math.cos(this.yaw);
    }

    this.state = 'charge';
    this.stateElapsedMs = 0;
    this.chargeTraveled = 0;
    this.chargeMaxDist = Math.min(
      Math.max(
        effectiveDist + BOSS_DEFAULTS.chargeOvershootDist,
        this.chargeTriggerDist + BOSS_DEFAULTS.chargeOvershootDist,
      ),
      BOSS_DEFAULTS.chargeMaxCapDist,
    );
    this.chargeHitDealt = false;
    events.push('charge_start');

    // Begin straight-line rush immediately along locked heading
    const step = this.currentMoveSpeed() * BOSS_DEFAULTS.chargeSpeedMult * (dtMs / 1000);
    this.pos.x += this.chargeDirX * step;
    this.pos.z += this.chargeDirZ * step;
    this.chargeTraveled += step;
    this.stateElapsedMs += dtMs;
  }

  private stepCharge(
    dtMs: number,
    player: { x: number; z: number },
    prevActualDist: number,
    effectiveDist: number,
    events: BossEvent[],
  ): void {
    // Heading (yaw and chargeDir) is strictly locked during charge so player can sidestep
    const prevX = this.pos.x;
    const prevZ = this.pos.z;
    const speed = this.currentMoveSpeed() * BOSS_DEFAULTS.chargeSpeedMult;
    const step = speed * (dtMs / 1000);

    this.pos.x += this.chargeDirX * step;
    this.pos.z += this.chargeDirZ * step;
    this.chargeTraveled += step;
    this.stateElapsedMs += dtMs;

    const hitRadius = Math.min(this.attackRange, BOSS_DEFAULTS.chargeHitRadius);
    const distSynced = Math.abs(effectiveDist - prevActualDist) <= 0.5;
    const contactDist = distSynced
      ? pointToSegmentDist(player.x, player.z, prevX, prevZ, this.pos.x, this.pos.z)
      : effectiveDist;

    if (!this.chargeHitDealt && contactDist <= hitRadius) {
      this.chargeHitDealt = true;
      events.push('attack_hit');
      this.state = 'recover';
      this.stateElapsedMs = 0;
      return;
    }

    if (this.chargeTraveled >= this.chargeMaxDist) {
      this.state = 'recover';
      this.stateElapsedMs = 0;
    }
  }

  private snapshot(hitWindowOpen: boolean, events: BossEvent[]): BossTick {
    return {
      state: this.state,
      pos: { x: this.pos.x, z: this.pos.z },
      yaw: this.yaw,
      hp: this.hp,
      hpMax: this.hpMax,
      phase: this.phase,
      hitWindowOpen,
      events,
    };
  }
}
