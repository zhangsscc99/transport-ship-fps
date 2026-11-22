// Stationary Artillery Boss AI state machine — zero three.js / DOM dependencies.
//
// Stationary Turret Design:
//   - Boss NEVER translates (chase / charge states and all movement are disabled).
//   - Rotates yaw in place to track the player while alive.
//   - Retains the classic windup -> attack -> recover cadence for artillery cannon fire:
//       idle (cooldown, stationary tracking)
//         -> windup (>=600ms cannon charge telegraph, stationary tracking)
//         -> attack (260ms firing impulse, emits 'attack_start' once to launch salvo; ZERO melee hits)
//         -> recover (>=800ms vent/reload stagger, stationary)
//         -> idle (cooldown timer before next windup)
//
// Phases:
//   Phase 1 (hp > 70%):          1 shell/salvo, base cooldown (1390ms), windup 700ms (~3.20s cycle)
//   Phase 2 (35% < hp <= 70%):   2 shells/salvo (fan), -25% cooldown (1040ms), windup 600ms (~2.70s cycle), emits 'phase2'
//   Phase 2 enraged (hp <= 35%): 3 shells/salvo (fan), -47% cooldown (740ms), windup 600ms (~2.40s cycle)
//
// Defeated (hp <= 0): freezes in 'recover' and emits no attack events.

export type BossState = 'idle' | 'windup' | 'attack' | 'recover';

export type BossEvent =
  | 'windup_start'
  | 'attack_start'
  | 'recover_end'
  | 'phase2';

export type BossHitPart = 'body' | 'head' | 'core';

export interface BossAIOptions {
  windupMs?: number;   // 默认 700（必须 ≥600）
  attackMs?: number;   // 默认 260（开炮发射硬直）
  recoverMs?: number;  // 默认 800（必须 ≥800）
  cooldownMs?: number; // 两次齐射之间，默认 1390
}

export interface BossTick {
  state: BossState;
  pos: { x: number; z: number };
  yaw: number;                // 原地朝向玩家（弧度，yaw=0 朝向 -Z）
  hp: number;
  hpMax: number;
  phase: 1 | 2;
  enraged: boolean;           // hpPct <= 0.35（狂暴多发阶段）
  salvoCount: number;         // 本轮炮击枚数（P1=1 / P2=2 / 狂暴=3）
  hitWindowOpen: boolean;     // 始终 false（近战判伤已彻底停用）
  events: BossEvent[];
}

export const BOSS_DEFAULTS = {
  hpMax: 2000,
  windupMs: 700,
  minWindupMs: 600,
  attackMs: 260,
  recoverMs: 800,
  minRecoverMs: 800,
  cooldownMs: 1390,
  phase2HpRatio: 0.7,
  phase2EnrageHpRatio: 0.35,
  phase2CooldownMult: 0.75,
  phase2EnrageCooldownMult: 0.53,
  phase2WindupDeltaMs: 100,
  phase1SalvoCount: 1,
  phase2SalvoCount: 2,
  enragedSalvoCount: 3,
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

export class BossAI {
  private readonly hpMax: number;
  private readonly baseWindupMs: number;
  private readonly attackMs: number;
  private readonly recoverMs: number;
  private readonly baseCooldownMs: number;

  // Permanently fixed at origin (0, 0) — Boss never moves across the entire fight.
  private readonly pos: Readonly<{ x: number; z: number }> = { x: 0, z: 0 };
  private state: BossState = 'idle';
  private yaw = 0;
  private hp: number;
  private phase: 1 | 2 = 1;

  private stateElapsedMs = 0;
  private cooldownRemainingMs = 0;
  private pendingPhase2Event = false;

  constructor(hpMax?: number, opts?: BossAIOptions) {
    this.hpMax =
      hpMax !== undefined && Number.isFinite(hpMax) && hpMax > 0
        ? hpMax
        : BOSS_DEFAULTS.hpMax;
    this.hp = this.hpMax;

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
    this.yaw = 0;
    this.hp = this.hpMax;
    this.phase = 1;
    this.stateElapsedMs = 0;
    this.cooldownRemainingMs = 0;
    this.pendingPhase2Event = false;
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

  update(dtMs: number, player: { x: number; z: number }, distance?: number): BossTick {
    if (this.hp <= 0) {
      this.state = 'recover';
      this.pendingPhase2Event = false;
      return this.snapshot([]);
    }

    const events: BossEvent[] = [];
    if (this.pendingPhase2Event) {
      events.push('phase2');
      this.pendingPhase2Event = false;
    }

    const dt = Number.isFinite(dtMs) && dtMs > 0 ? dtMs : 0;
    const dx = player.x - this.pos.x;
    const dz = player.z - this.pos.z;
    const actualDist = Math.hypot(dx, dz);

    if (dt === 0) {
      if (actualDist > EPS && this.state !== 'attack') {
        this.facePlayer(dx, dz, actualDist);
      }
      return this.snapshot(events);
    }

    // Distance parameter is accepted for interface parity; artillery fires at any valid range.
    const validTarget =
      Number.isFinite(player.x) &&
      Number.isFinite(player.z) &&
      (distance === undefined || Number.isFinite(distance));
    if (!validTarget) {
      return this.snapshot(events);
    }

    switch (this.state) {
      case 'idle':
        this.stepIdle(dt, dx, dz, actualDist, events);
        break;
      case 'windup':
        this.stepWindup(dt, dx, dz, actualDist, events);
        break;
      case 'attack':
        this.stepAttack(dt);
        break;
      case 'recover':
        this.stepRecover(dt, dx, dz, actualDist, events);
        break;
    }

    return this.snapshot(events);
  }

  private isEnraged(): boolean {
    return this.hp > 0 && this.hp <= this.hpMax * BOSS_DEFAULTS.phase2EnrageHpRatio + RATIO_EPS;
  }

  private currentSalvoCount(): number {
    if (this.isEnraged()) return BOSS_DEFAULTS.enragedSalvoCount;
    if (this.phase === 2) return BOSS_DEFAULTS.phase2SalvoCount;
    return BOSS_DEFAULTS.phase1SalvoCount;
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
    if (this.isEnraged()) {
      return Math.round(this.baseCooldownMs * BOSS_DEFAULTS.phase2EnrageCooldownMult);
    }
    if (this.phase === 2) {
      return Math.round(this.baseCooldownMs * BOSS_DEFAULTS.phase2CooldownMult);
    }
    return this.baseCooldownMs;
  }

  private facePlayer(dx: number, dz: number, len: number): void {
    if (len > EPS) {
      this.yaw = yawFromDir(dx, dz);
    }
  }

  private stepIdle(
    dtMs: number,
    dx: number,
    dz: number,
    actualDist: number,
    events: BossEvent[],
  ): void {
    // Rotate in place to track player; zero translation.
    this.facePlayer(dx, dz, actualDist);

    if (this.cooldownRemainingMs > 0) {
      this.cooldownRemainingMs = Math.max(0, this.cooldownRemainingMs - dtMs);
    }

    if (this.cooldownRemainingMs <= 0) {
      this.state = 'windup';
      this.stateElapsedMs = 0;
      events.push('windup_start');
    }
  }

  private stepWindup(
    dtMs: number,
    dx: number,
    dz: number,
    actualDist: number,
    events: BossEvent[],
  ): void {
    // Stationary cannon charge; keeps rotating in place to lock onto player.
    this.facePlayer(dx, dz, actualDist);
    this.stateElapsedMs += dtMs;

    if (this.stateElapsedMs >= this.currentWindupMs()) {
      this.state = 'attack';
      this.stateElapsedMs = 0;
      events.push('attack_start');
    }
  }

  private stepAttack(dtMs: number): void {
    // Yaw locked during firing impulse; zero melee hits, zero translation.
    this.stateElapsedMs += dtMs;
    if (this.stateElapsedMs >= this.attackMs) {
      this.state = 'recover';
      this.stateElapsedMs = 0;
    }
  }

  private stepRecover(
    dtMs: number,
    dx: number,
    dz: number,
    actualDist: number,
    events: BossEvent[],
  ): void {
    // Stationary venting / reload; tracks player slowly ready for next cycle.
    this.facePlayer(dx, dz, actualDist);
    this.stateElapsedMs += dtMs;
    if (this.stateElapsedMs >= this.recoverMs) {
      this.state = 'idle';
      this.stateElapsedMs = 0;
      this.cooldownRemainingMs = this.currentCooldownMs();
      events.push('recover_end');
    }
  }

  private snapshot(events: BossEvent[]): BossTick {
    return {
      state: this.state,
      pos: { x: this.pos.x, z: this.pos.z },
      yaw: this.yaw,
      hp: this.hp,
      hpMax: this.hpMax,
      phase: this.phase,
      enraged: this.isEnraged(),
      salvoCount: this.currentSalvoCount(),
      hitWindowOpen: false,
      events,
    };
  }
}
