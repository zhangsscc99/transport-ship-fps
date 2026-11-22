var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/game/bossAI.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// src/game/bossAI.ts
var bossAI_exports = {};
__export(bossAI_exports, {
  BOSS_DEFAULTS: () => BOSS_DEFAULTS,
  BOSS_WEAKPOINT_MULT: () => BOSS_WEAKPOINT_MULT,
  BossAI: () => BossAI
});
var BOSS_DEFAULTS = {
  hpMax: 2e3,
  moveSpeed: 1.75,
  attackRange: 3.2,
  chargeTriggerDist: 18,
  windupMs: 700,
  minWindupMs: 600,
  attackMs: 180,
  hitWindowRatio: 0.6,
  recoverMs: 800,
  minRecoverMs: 800,
  cooldownMs: 900,
  chargeSpeedMult: 1.85,
  chargeHitRadius: 1.8,
  chargeOvershootDist: 2.5,
  chargeMaxCapDist: 45,
  phase2HpRatio: 0.7,
  phase2EnrageHpRatio: 0.35,
  phase2SpeedMult: 1.08,
  phase2CooldownMult: 0.8,
  phase2EnrageCooldownMult: 0.7,
  phase2WindupDeltaMs: 100
};
var BOSS_WEAKPOINT_MULT = {
  body: 1,
  core: 2,
  head: 2.5
};
var EPS = 1e-6;
var RATIO_EPS = 1e-9;
function yawFromDir(dx, dz) {
  return Math.atan2(-dx, -dz);
}
function pointToSegmentDist(px, pz, ax, az, bx, bz) {
  const vx = bx - ax;
  const vz = bz - az;
  const lenSq = vx * vx + vz * vz;
  if (lenSq <= EPS * EPS) {
    return Math.hypot(px - ax, pz - az);
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (pz - az) * vz) / lenSq));
  return Math.hypot(px - (ax + vx * t), pz - (az + vz * t));
}
var BossAI = class {
  hpMax;
  baseMoveSpeed;
  attackRange;
  chargeTriggerDist;
  baseWindupMs;
  attackMs;
  recoverMs;
  baseCooldownMs;
  state = "idle";
  pos = { x: 0, z: 0 };
  yaw = 0;
  hp;
  phase = 1;
  stateElapsedMs = 0;
  cooldownRemainingMs = 0;
  attackHitDealt = false;
  pendingPhase2Event = false;
  // Straight-line charge lock (heading fixed on charge entry)
  chargeDirX = 0;
  chargeDirZ = -1;
  chargeTraveled = 0;
  chargeMaxDist = 0;
  chargeHitDealt = false;
  constructor(hpMax, opts) {
    this.hpMax = hpMax !== void 0 && Number.isFinite(hpMax) && hpMax > 0 ? hpMax : BOSS_DEFAULTS.hpMax;
    this.hp = this.hpMax;
    this.baseMoveSpeed = opts?.moveSpeed !== void 0 && Number.isFinite(opts.moveSpeed) && opts.moveSpeed > 0 ? opts.moveSpeed : BOSS_DEFAULTS.moveSpeed;
    this.attackRange = opts?.attackRange !== void 0 && Number.isFinite(opts.attackRange) && opts.attackRange > 0 ? opts.attackRange : BOSS_DEFAULTS.attackRange;
    this.chargeTriggerDist = opts?.chargeTriggerDist !== void 0 && Number.isFinite(opts.chargeTriggerDist) && opts.chargeTriggerDist > 0 ? opts.chargeTriggerDist : BOSS_DEFAULTS.chargeTriggerDist;
    const rawWindup = opts?.windupMs !== void 0 && Number.isFinite(opts.windupMs) ? opts.windupMs : BOSS_DEFAULTS.windupMs;
    this.baseWindupMs = Math.max(BOSS_DEFAULTS.minWindupMs, rawWindup);
    this.attackMs = opts?.attackMs !== void 0 && Number.isFinite(opts.attackMs) && opts.attackMs > 0 ? opts.attackMs : BOSS_DEFAULTS.attackMs;
    const rawRecover = opts?.recoverMs !== void 0 && Number.isFinite(opts.recoverMs) ? opts.recoverMs : BOSS_DEFAULTS.recoverMs;
    this.recoverMs = Math.max(BOSS_DEFAULTS.minRecoverMs, rawRecover);
    this.baseCooldownMs = opts?.cooldownMs !== void 0 && Number.isFinite(opts.cooldownMs) && opts.cooldownMs >= 0 ? opts.cooldownMs : BOSS_DEFAULTS.cooldownMs;
  }
  reset() {
    this.state = "idle";
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
  applyDamage(amount, hitPart) {
    if (this.hp <= 0) return 0;
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    const mult = BOSS_WEAKPOINT_MULT[hitPart];
    const actualDamage = amount * mult;
    this.hp = Math.max(0, this.hp - actualDamage);
    if (this.hp <= 0) {
      this.hp = 0;
      this.state = "recover";
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
  update(dtMs, player, distance) {
    if (this.hp <= 0) {
      this.state = "recover";
      this.pendingPhase2Event = false;
      return this.snapshot(false, []);
    }
    const events = [];
    if (this.pendingPhase2Event) {
      events.push("phase2");
      this.pendingPhase2Event = false;
    }
    const dt = Number.isFinite(dtMs) && dtMs > 0 ? dtMs : 0;
    if (dt === 0) {
      return this.snapshot(this.isHitWindowOpen(), events);
    }
    const dx = player.x - this.pos.x;
    const dz = player.z - this.pos.z;
    const actualDist = Math.hypot(dx, dz);
    const effectiveDist = Number.isFinite(distance) && distance >= 0 ? distance : actualDist;
    if (this.state === "idle") {
      if (!Number.isFinite(effectiveDist)) {
        return this.snapshot(false, events);
      }
      this.state = "chase";
      this.stateElapsedMs = 0;
    }
    switch (this.state) {
      case "chase":
        this.stepChase(dt, dx, dz, actualDist, effectiveDist, events);
        break;
      case "windup":
        this.stepWindup(dt, dx, dz, actualDist, effectiveDist, events);
        break;
      case "attack":
        this.stepAttack(dt, effectiveDist, events);
        break;
      case "recover":
        this.stepRecover(dt, events);
        break;
      case "charge":
        this.stepCharge(dt, player, actualDist, effectiveDist, events);
        break;
    }
    return this.snapshot(this.isHitWindowOpen(), events);
  }
  currentMoveSpeed() {
    return this.phase === 2 ? this.baseMoveSpeed * BOSS_DEFAULTS.phase2SpeedMult : this.baseMoveSpeed;
  }
  currentWindupMs() {
    if (this.phase === 2) {
      return Math.max(
        BOSS_DEFAULTS.minWindupMs,
        this.baseWindupMs - BOSS_DEFAULTS.phase2WindupDeltaMs
      );
    }
    return this.baseWindupMs;
  }
  currentCooldownMs() {
    if (this.phase === 2) {
      if (this.hp <= this.hpMax * BOSS_DEFAULTS.phase2EnrageHpRatio + RATIO_EPS) {
        return this.baseCooldownMs * BOSS_DEFAULTS.phase2EnrageCooldownMult;
      }
      return this.baseCooldownMs * BOSS_DEFAULTS.phase2CooldownMult;
    }
    return this.baseCooldownMs;
  }
  isHitWindowOpen() {
    return this.hp > 0 && this.state === "attack" && this.stateElapsedMs < this.attackMs * BOSS_DEFAULTS.hitWindowRatio;
  }
  facePlayer(dx, dz, len) {
    if (len > EPS) {
      this.yaw = yawFromDir(dx, dz);
    }
  }
  stepChase(dtMs, dx, dz, actualDist, effectiveDist, events) {
    this.facePlayer(dx, dz, actualDist);
    if (this.cooldownRemainingMs > 0) {
      this.cooldownRemainingMs = Math.max(0, this.cooldownRemainingMs - dtMs);
    }
    if (this.cooldownRemainingMs <= 0) {
      if (effectiveDist <= this.attackRange) {
        this.state = "windup";
        this.stateElapsedMs = 0;
        events.push("windup_start");
        return;
      }
      if (effectiveDist > this.chargeTriggerDist) {
        this.enterCharge(dtMs, dx, dz, actualDist, effectiveDist, events);
        return;
      }
    }
    if (effectiveDist > this.attackRange && actualDist > EPS) {
      const step = Math.min(this.currentMoveSpeed() * (dtMs / 1e3), actualDist);
      this.pos.x += dx / actualDist * step;
      this.pos.z += dz / actualDist * step;
    }
  }
  stepWindup(dtMs, dx, dz, actualDist, effectiveDist, events) {
    this.facePlayer(dx, dz, actualDist);
    this.stateElapsedMs += dtMs;
    if (this.stateElapsedMs >= this.currentWindupMs()) {
      this.state = "attack";
      this.stateElapsedMs = 0;
      this.attackHitDealt = false;
      events.push("attack_start");
      if (this.isHitWindowOpen() && effectiveDist <= this.attackRange) {
        this.attackHitDealt = true;
        events.push("attack_hit");
      }
    }
  }
  stepAttack(dtMs, effectiveDist, events) {
    this.stateElapsedMs += dtMs;
    if (this.stateElapsedMs >= this.attackMs) {
      this.state = "recover";
      this.stateElapsedMs = 0;
      return;
    }
    if (!this.attackHitDealt && this.isHitWindowOpen() && effectiveDist <= this.attackRange) {
      this.attackHitDealt = true;
      events.push("attack_hit");
    }
  }
  stepRecover(dtMs, events) {
    this.stateElapsedMs += dtMs;
    if (this.stateElapsedMs >= this.recoverMs) {
      this.state = "chase";
      this.stateElapsedMs = 0;
      this.cooldownRemainingMs = this.currentCooldownMs();
      events.push("recover_end");
    }
  }
  enterCharge(dtMs, dx, dz, actualDist, effectiveDist, events) {
    if (actualDist > EPS) {
      this.chargeDirX = dx / actualDist;
      this.chargeDirZ = dz / actualDist;
      this.yaw = yawFromDir(dx, dz);
    } else {
      this.chargeDirX = -Math.sin(this.yaw);
      this.chargeDirZ = -Math.cos(this.yaw);
    }
    this.state = "charge";
    this.stateElapsedMs = 0;
    this.chargeTraveled = 0;
    this.chargeMaxDist = Math.min(
      Math.max(
        effectiveDist + BOSS_DEFAULTS.chargeOvershootDist,
        this.chargeTriggerDist + BOSS_DEFAULTS.chargeOvershootDist
      ),
      BOSS_DEFAULTS.chargeMaxCapDist
    );
    this.chargeHitDealt = false;
    events.push("charge_start");
    const step = this.currentMoveSpeed() * BOSS_DEFAULTS.chargeSpeedMult * (dtMs / 1e3);
    this.pos.x += this.chargeDirX * step;
    this.pos.z += this.chargeDirZ * step;
    this.chargeTraveled += step;
    this.stateElapsedMs += dtMs;
  }
  stepCharge(dtMs, player, prevActualDist, effectiveDist, events) {
    const prevX = this.pos.x;
    const prevZ = this.pos.z;
    const speed = this.currentMoveSpeed() * BOSS_DEFAULTS.chargeSpeedMult;
    const step = speed * (dtMs / 1e3);
    this.pos.x += this.chargeDirX * step;
    this.pos.z += this.chargeDirZ * step;
    this.chargeTraveled += step;
    this.stateElapsedMs += dtMs;
    const hitRadius = Math.min(this.attackRange, BOSS_DEFAULTS.chargeHitRadius);
    const distSynced = Math.abs(effectiveDist - prevActualDist) <= 0.5;
    const contactDist = distSynced ? pointToSegmentDist(player.x, player.z, prevX, prevZ, this.pos.x, this.pos.z) : effectiveDist;
    if (!this.chargeHitDealt && contactDist <= hitRadius) {
      this.chargeHitDealt = true;
      events.push("attack_hit");
      this.state = "recover";
      this.stateElapsedMs = 0;
      return;
    }
    if (this.chargeTraveled >= this.chargeMaxDist) {
      this.state = "recover";
      this.stateElapsedMs = 0;
    }
  }
  snapshot(hitWindowOpen, events) {
    return {
      state: this.state,
      pos: { x: this.pos.x, z: this.pos.z },
      yaw: this.yaw,
      hp: this.hp,
      hpMax: this.hpMax,
      phase: this.phase,
      hitWindowOpen,
      events
    };
  }
};

// src/game/bossAI.test.ts
test("windup lasts >=600ms: no attack_start within 600ms in phase 1, phase 2, or clamped opts", () => {
  const boss = new BossAI(2e3);
  const player = { x: 0, z: 2.5 };
  const enter = boss.update(16, player, 2.5);
  assert.equal(enter.state, "windup");
  assert.ok(enter.events.includes("windup_start"));
  assert.equal(enter.hitWindowOpen, false);
  const startPos = { ...enter.pos };
  let elapsed = 0;
  let attackStartAt = -1;
  while (elapsed < 1e3) {
    const dt = 16;
    elapsed += dt;
    const tick = boss.update(dt, player, 2.5);
    if (elapsed < 600) {
      assert.equal(tick.state, "windup", `left windup too early at ${elapsed}ms`);
      assert.ok(!tick.events.includes("attack_start"), `attack_start fired early at ${elapsed}ms`);
      assert.deepEqual(tick.pos, startPos, "boss moved during windup");
    }
    if (tick.events.includes("attack_start")) {
      attackStartAt = elapsed;
      break;
    }
  }
  assert.ok(attackStartAt >= 700, `phase 1 attack_start should be >=700ms, got ${attackStartAt}ms`);
  const clamped = new BossAI(2e3, { windupMs: 250 });
  clamped.applyDamage(700, "body");
  const w0 = clamped.update(10, player, 2.5);
  assert.equal(w0.state, "windup");
  assert.equal(w0.phase, 2);
  let phase2Elapsed = 0;
  let phase2AttackAt = -1;
  while (phase2Elapsed < 1e3) {
    phase2Elapsed += 10;
    const t = clamped.update(10, player, 2.5);
    if (phase2Elapsed < 600) {
      assert.equal(t.state, "windup");
      assert.ok(!t.events.includes("attack_start"), `phase 2 attack_start early at ${phase2Elapsed}ms`);
    }
    if (t.events.includes("attack_start")) {
      phase2AttackAt = phase2Elapsed;
      break;
    }
  }
  assert.equal(phase2AttackAt, 600, `clamped phase 2 windup must be 600ms, got ${phase2AttackAt}ms`);
});
test("melee only: player at distance 10m never triggers attack_hit (chase or post-windup retreat)", () => {
  const boss = new BossAI(2e3);
  for (let i = 0; i < 600; i++) {
    const tick = boss.update(16, { x: 0, z: 10 }, 10);
    assert.ok(!tick.events.includes("attack_hit"), `unexpected attack_hit at frame ${i}`);
    assert.ok(!tick.events.includes("attack_start"));
    assert.equal(tick.hitWindowOpen, false);
  }
  const boss2 = new BossAI(2e3);
  boss2.update(16, { x: 0, z: 2.5 }, 2.5);
  let sawAttackStart = false;
  for (let i = 0; i < 80; i++) {
    const tick = boss2.update(16, { x: 0, z: 10 }, 10);
    if (tick.events.includes("attack_start")) sawAttackStart = true;
    assert.ok(!tick.events.includes("attack_hit"), "retreated player at 10m must not be hit");
  }
  assert.equal(sawAttackStart, true);
});
test("attack hitWindowOpen covers only first 60% of 180ms and emits attack_hit at most once", () => {
  const boss = new BossAI(2e3);
  const player = { x: 0, z: 2 };
  boss.update(10, player, 2);
  for (let t = 10; t < 700; t += 10) {
    const tick = boss.update(10, player, 2);
    assert.equal(tick.state, "windup");
  }
  const atk0 = boss.update(10, player, 2);
  assert.equal(atk0.state, "attack");
  assert.ok(atk0.events.includes("attack_start"));
  assert.ok(atk0.events.includes("attack_hit"));
  assert.equal(atk0.hitWindowOpen, true);
  let extraHits = 0;
  for (let pct = 10; pct < 100; pct += 10) {
    const tick = boss.update(18, player, 2);
    assert.equal(tick.state, "attack");
    assert.equal(
      tick.hitWindowOpen,
      pct < 60,
      `hitWindowOpen at ${pct}% should be ${pct < 60}`
    );
    if (tick.events.includes("attack_hit")) extraHits++;
  }
  assert.equal(extraHits, 0, "single swing must not emit attack_hit more than once");
  const rec0 = boss.update(18, player, 2);
  assert.equal(rec0.state, "recover");
  assert.equal(rec0.hitWindowOpen, false);
  const bossLate = new BossAI(2e3);
  bossLate.update(10, { x: 0, z: 2 }, 2);
  for (let t = 10; t < 700; t += 10) bossLate.update(10, { x: 0, z: 2 }, 2);
  const lateAtk0 = bossLate.update(10, { x: 0, z: 6 }, 6);
  assert.equal(lateAtk0.state, "attack");
  assert.ok(!lateAtk0.events.includes("attack_hit"));
  bossLate.update(108, { x: 0, z: 6 }, 6);
  const lateClosed = bossLate.update(20, { x: 0, z: 2 }, 2);
  assert.equal(lateClosed.state, "attack");
  assert.equal(lateClosed.hitWindowOpen, false);
  assert.ok(!lateClosed.events.includes("attack_hit"));
});
test("weakpoint multipliers: head = 2.5x, core = 2.0x, body = 1.0x", () => {
  const boss = new BossAI(2e3);
  const baseDmg = 40;
  const bodyDmg = boss.applyDamage(baseDmg, "body");
  const coreDmg = boss.applyDamage(baseDmg, "core");
  const headDmg = boss.applyDamage(baseDmg, "head");
  assert.equal(bodyDmg, baseDmg);
  assert.equal(coreDmg, bodyDmg * 2);
  assert.equal(headDmg, bodyDmg * 2.5);
  const tick = boss.update(0, { x: 0, z: 10 }, 10);
  assert.equal(tick.hp, 2e3 - (40 + 80 + 100));
  assert.equal(boss.applyDamage(0, "head"), 0);
  assert.equal(boss.applyDamage(-10, "core"), 0);
});
test("phase 2 at <=70% HP emits phase2 once, boosts speed by phase2SpeedMult (+8%), cuts cooldown -20% and -10% more at <=35%", () => {
  const boss = new BossAI(1e3);
  const p1Start = boss.update(0, { x: 0, z: 10 }, 10);
  assert.equal(p1Start.state, "idle");
  assert.equal(p1Start.phase, 1);
  const p1Moved = boss.update(1e3, { x: 0, z: 10 }, 10);
  const p1Speed = Math.hypot(p1Moved.pos.x - p1Start.pos.x, p1Moved.pos.z - p1Start.pos.z);
  assert.ok(Math.abs(p1Speed - BOSS_DEFAULTS.moveSpeed) < 1e-6, `phase 1 speed ${p1Speed}`);
  boss.applyDamage(300, "body");
  const p2Tick = boss.update(1e3, { x: 0, z: 15 }, 10);
  assert.equal(p2Tick.phase, 2);
  assert.ok(p2Tick.events.includes("phase2"), "must emit phase2 event on threshold");
  const p2Speed = Math.hypot(p2Tick.pos.x - p1Moved.pos.x, p2Tick.pos.z - p1Moved.pos.z);
  assert.ok(
    Math.abs(p2Speed - BOSS_DEFAULTS.moveSpeed * BOSS_DEFAULTS.phase2SpeedMult) < 1e-6,
    `phase 2 speed ${p2Speed} should be ${BOSS_DEFAULTS.moveSpeed * BOSS_DEFAULTS.phase2SpeedMult}`
  );
  const p2Next = boss.update(16, { x: 0, z: 15 }, 10);
  assert.ok(!p2Next.events.includes("phase2"));
  function measureCooldownMs(hpDamage) {
    const b = new BossAI(1e3);
    if (hpDamage > 0) b.applyDamage(hpDamage, "body");
    const p = { x: 0, z: 2 };
    let seenRecoverEnd = false;
    for (let i = 0; i < 400; i++) {
      const t = b.update(10, p, 2);
      if (t.events.includes("recover_end")) {
        seenRecoverEnd = true;
        break;
      }
    }
    assert.equal(seenRecoverEnd, true);
    let cdMs = 0;
    while (cdMs < 2e3) {
      cdMs += 10;
      const t = b.update(10, p, 2);
      if (t.events.includes("windup_start")) return cdMs;
    }
    throw new Error("windup_start never resumed after recover_end");
  }
  const cdPhase1 = measureCooldownMs(0);
  const cdPhase2 = measureCooldownMs(350);
  const cdEnrage = measureCooldownMs(700);
  assert.equal(cdPhase1, 900);
  assert.equal(cdPhase2, 720);
  assert.equal(cdEnrage, 630);
});
test("charge triggers at distance >18m, locks yaw (dodgeable by sidestep), and hits once on direct impact", () => {
  const bossDodge = new BossAI(2e3);
  const start = bossDodge.update(16, { x: 0, z: 20 }, 20);
  assert.equal(start.state, "charge");
  assert.ok(start.events.includes("charge_start"));
  const lockedYaw = start.yaw;
  const after100 = bossDodge.update(100, { x: 6, z: 20 }, Math.hypot(6 - start.pos.x, 20 - start.pos.z));
  assert.equal(after100.state, "charge");
  assert.equal(after100.yaw, lockedYaw, "yaw must NOT follow sidestepping player during charge");
  const stepDist = Math.hypot(after100.pos.x - start.pos.x, after100.pos.z - start.pos.z);
  const expectedDist = BOSS_DEFAULTS.moveSpeed * BOSS_DEFAULTS.chargeSpeedMult * 0.1;
  assert.ok(Math.abs(stepDist - expectedDist) < 1e-5, `charge speed dist ${stepDist} vs ${expectedDist}`);
  assert.ok(Math.abs(after100.pos.x) < 1e-6, "charge must stay on straight line (x=0)");
  let pos = after100.pos;
  let reachedRecover = false;
  for (let i = 0; i < 400; i++) {
    const dist = Math.hypot(4 - pos.x, 20 - pos.z);
    const t = bossDodge.update(20, { x: 4, z: 20 }, dist);
    pos = t.pos;
    assert.ok(!t.events.includes("attack_hit"), "sidestepped charge must not hit player");
    if (t.state === "charge") {
      assert.equal(t.yaw, lockedYaw, "yaw must remain locked throughout charge");
    } else if (t.state === "recover") {
      reachedRecover = true;
      break;
    }
  }
  assert.equal(reachedRecover, true, "missed charge should end in recover");
  const bossHit = new BossAI(2e3);
  let cur = bossHit.update(16, { x: 0, z: 20 }, 20);
  assert.equal(cur.state, "charge");
  const hitYaw = cur.yaw;
  let hitCount = 0;
  let enteredRecoverOnHit = false;
  for (let i = 0; i < 400; i++) {
    const dist = Math.hypot(0 - cur.pos.x, 20 - cur.pos.z);
    cur = bossHit.update(16, { x: 0, z: 20 }, dist);
    if (cur.events.includes("attack_hit")) {
      hitCount++;
      assert.equal(cur.state, "recover", "charge hit must transition immediately to recover");
      enteredRecoverOnHit = true;
      break;
    }
    assert.equal(cur.yaw, hitYaw);
  }
  assert.equal(hitCount, 1);
  assert.equal(enteredRecoverOnHit, true);
});
test("recover lasts >=800ms stationary and death (hp <= 0) freezes state in recover with zero attack events", () => {
  const boss = new BossAI(1e3, { recoverMs: 200 });
  const p = { x: 0, z: 2 };
  let cur = boss.update(10, p, 2);
  for (let i = 0; i < 200 && cur.state !== "recover"; i++) {
    cur = boss.update(10, p, 2);
  }
  assert.equal(cur.state, "recover");
  const recPos = { ...cur.pos };
  let recElapsed = 0;
  let recEndAt = -1;
  while (recElapsed < 1200) {
    recElapsed += 10;
    cur = boss.update(10, p, 2);
    if (recElapsed < 800) {
      assert.equal(cur.state, "recover");
      assert.ok(!cur.events.includes("recover_end"));
      assert.deepEqual(cur.pos, recPos);
    }
    if (cur.events.includes("recover_end")) {
      recEndAt = recElapsed;
      break;
    }
  }
  assert.equal(recEndAt, 800);
  const dying = new BossAI(500);
  dying.update(16, p, 2);
  dying.applyDamage(500, "body");
  assert.equal(dying.applyDamage(50, "head"), 0, "dead boss takes no further damage");
  const attackEvents = /* @__PURE__ */ new Set([
    "windup_start",
    "attack_start",
    "attack_hit",
    "charge_start",
    "recover_end"
  ]);
  const frozenPos = dying.update(16, p, 2).pos;
  for (let i = 0; i < 200; i++) {
    const t = dying.update(50, p, 2);
    assert.equal(t.hp, 0);
    assert.equal(t.state, "recover");
    assert.equal(t.hitWindowOpen, false);
    assert.deepEqual(t.pos, frozenPos);
    for (const ev of t.events) {
      assert.ok(!attackEvents.has(ev), `dead boss emitted forbidden event ${ev}`);
    }
  }
  dying.reset();
  const fresh = dying.update(0, p, 10);
  assert.equal(fresh.state, "idle");
  assert.equal(fresh.hp, 500);
  assert.equal(fresh.phase, 1);
  assert.deepEqual(fresh.pos, { x: 0, z: 0 });
});
test("pure melee & pure logic: source and exports contain no ranged/projectile or DOM/three.js references", () => {
  const srcPath = new URL("./bossAI.ts", import.meta.url);
  const source = readFileSync(srcPath, "utf8");
  const rangedPattern = /\b(projectile|bullet|missile|fireball|laser|ranged|shoot)\b/i;
  assert.equal(rangedPattern.test(source), false, "bossAI.ts must not contain ranged/projectile logic");
  for (const exportName of Object.keys(bossAI_exports)) {
    assert.equal(
      rangedPattern.test(exportName),
      false,
      `unexpected ranged export: ${exportName}`
    );
  }
  assert.equal(/\bfrom\s+['"]three['"]/.test(source), false, "bossAI.ts must not import three.js");
  assert.equal(/\b(window|document)\b/.test(source), false, "bossAI.ts must not touch DOM");
});
test("default chase speed: 3s chase displacement stays within 4.5-6.0m", () => {
  const boss = new BossAI(2e3);
  const player = { x: 0, z: 15 };
  let pos = { x: 0, z: 0 };
  for (let i = 0; i < 150; i++) {
    const dist = Math.hypot(player.x - pos.x, player.z - pos.z);
    const tick = boss.update(20, player, dist);
    assert.equal(tick.state, "chase", `expected chase at step ${i}, got ${tick.state}`);
    pos = tick.pos;
  }
  const displacement = Math.hypot(pos.x, pos.z);
  assert.ok(
    displacement >= 4.5 && displacement <= 6,
    `3s chase displacement should be within [4.5, 6.0]m, got ${displacement.toFixed(3)}m`
  );
});
