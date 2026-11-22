// src/game/bossController.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE3 from "three";

// src/game/bossController.ts
import * as THREE2 from "three";

// src/game/bossAI.ts
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

// src/game/collision.ts
var PLAYER_RADIUS = 0.35;
var STEP_HEIGHT = 0.35;
var AIR_WALL_SLIDE_DAMP = 0.35;
var EPS2 = 1e-4;
var MAX_SUBSTEP = 0.15;
var MAX_STEPS = 64;
var clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function circleHitsRect(x, z, r, b) {
  const qx = clamp(x, b.x - b.w / 2, b.x + b.w / 2);
  const qz = clamp(z, b.z - b.d / 2, b.z + b.d / 2);
  const dx = x - qx;
  const dz = z - qz;
  return dx * dx + dz * dz < r * r - EPS2;
}
function pointInPolygon(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const zi = poly[i].z;
    const xj = poly[j].x;
    const zj = poly[j].z;
    if (zi > z !== zj > z && x < (xj - xi) * (z - zi) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}
function closestOnSegment(x, z, ax, az, bx, bz) {
  const abx = bx - ax;
  const abz = bz - az;
  const lenSq = abx * abx + abz * abz;
  const t = lenSq > 1e-12 ? clamp(((x - ax) * abx + (z - az) * abz) / lenSq, 0, 1) : 0;
  const qx = ax + abx * t;
  const qz = az + abz * t;
  const dx = x - qx;
  const dz = z - qz;
  return { qx, qz, t, distSq: dx * dx + dz * dz };
}
function defaultRectPolygon(bounds) {
  const hw = bounds.w / 2 - 0.15;
  const hd = bounds.d / 2 - 0.15;
  return [
    { x: -hw, z: -hd },
    { x: hw, z: -hd },
    { x: hw, z: hd },
    { x: -hw, z: hd }
  ];
}
var CollisionWorld = class {
  constructor(boxes, bounds, waterY, polygon) {
    this.boxes = boxes;
    this.bounds = bounds;
    this.waterY = waterY;
    this.polygon = polygon && polygon.length >= 3 ? polygon : defaultRectPolygon(bounds);
  }
  polygon;
  insideBounds(x, z) {
    return Math.abs(x) <= this.bounds.w / 2 && Math.abs(z) <= this.bounds.d / 2;
  }
  /** True when a capsule of `radius` at (x,z) lies completely within the walkable polygon. */
  isInsideWalkable(x, z, radius = PLAYER_RADIUS) {
    if (!pointInPolygon(x, z, this.polygon)) return false;
    const minDistSq = Math.max(0, radius - EPS2) ** 2;
    const n = this.polygon.length;
    for (let i = 0; i < n; i++) {
      const a = this.polygon[i];
      const b = this.polygon[(i + 1) % n];
      const c = closestOnSegment(x, z, a.x, a.z, b.x, b.z);
      if (c.distSq < minDistSq) return false;
    }
    return true;
  }
  /**
   * Constrain candidate `(x, z)` so a capsule of `radius` remains inside the
   * CCW walkable polygon. Returns resolved `(x, z)`, unit inward push normal
   * `(nx, nz)`, and `hit: true` when an air-wall boundary constrained motion.
   */
  constrainToPolygon(candX, candZ, radius) {
    let x = candX;
    let z = candZ;
    let hit = false;
    const poly = this.polygon;
    const n = poly.length;
    for (let iter = 0; iter < 4; iter++) {
      const inside = pointInPolygon(x, z, poly);
      let bestDistSq = Infinity;
      let bestQx = x;
      let bestQz = z;
      let bestT = 0.5;
      let bestNx = 0;
      let bestNz = 0;
      for (let i = 0; i < n; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % n];
        const seg = closestOnSegment(x, z, a.x, a.z, b.x, b.z);
        if (seg.distSq < bestDistSq) {
          bestDistSq = seg.distSq;
          bestQx = seg.qx;
          bestQz = seg.qz;
          bestT = seg.t;
          const ex = b.x - a.x;
          const ez = b.z - a.z;
          const el = Math.hypot(ex, ez) || 1;
          bestNx = -ez / el;
          bestNz = ex / el;
        }
      }
      const dist = Math.sqrt(bestDistSq);
      if (!inside) {
        hit = true;
        x = bestQx + bestNx * radius;
        z = bestQz + bestNz * radius;
      } else if (dist < radius - EPS2) {
        hit = true;
        const push = radius - dist;
        if (bestT > 1e-4 && bestT < 1 - 1e-4) {
          x += bestNx * push;
          z += bestNz * push;
        } else if (dist > 1e-6) {
          x += (x - bestQx) / dist * push;
          z += (z - bestQz) / dist * push;
        } else {
          x += bestNx * push;
          z += bestNz * push;
        }
      } else {
        break;
      }
    }
    if (!hit) return { x, z, nx: 0, nz: 0, hit: false };
    const px = x - candX;
    const pz = z - candZ;
    const pl = Math.hypot(px, pz);
    if (pl < 1e-7) return { x, z, nx: 0, nz: 0, hit: true };
    return { x, z, nx: px / pl, nz: pz / pl, hit: true };
  }
  /**
   * Does a cylinder with feet at y and top at y+h overlap any box?
   * Exact face contact (standing on a top, head brushing a ceiling) does
   * not count — only real penetration does.
   */
  hits(x, y, z, r, h) {
    for (const b of this.boxes) {
      if (y + h <= b.y + EPS2 || y >= b.y + b.h - EPS2) continue;
      if (circleHitsRect(x, z, r, b)) return true;
    }
    return false;
  }
  /** Collect every box the cylinder penetrates at (x,y,z). */
  blockers(x, y, z, r, h, out) {
    out.length = 0;
    for (const b of this.boxes) {
      if (y + h <= b.y + EPS2 || y >= b.y + b.h - EPS2) continue;
      if (circleHitsRect(x, z, r, b)) out.push(b);
    }
  }
  /** Lowest blocker top reachable by an auto-step from feetY (Infinity if none). */
  stepCandidate(blockers, feetY) {
    let best = Infinity;
    for (const b of blockers) {
      const top = b.y + b.h;
      const rise = top - feetY;
      if (rise > -EPS2 && rise <= STEP_HEIGHT + EPS2 && top < best) best = top;
    }
    return best;
  }
  /**
   * Advance a cylinder by vel*dt with box collision + walkable-polygon air walls.
   * `wasOnGround` gates auto-stepping (no stepping mid-air).
   * Air walls project candidate positions onto the nearest inward edge normal,
   * preserve wall sliding at 35% horizontal speed, and never block stairs/ramps.
   * `drowned` only triggers as a fallback when `pos.y < waterY`.
   */
  move(pos, vel, radius, height, dt, wasOnGround) {
    const p = { x: pos.x, y: pos.y, z: pos.z };
    const v = { x: vel.x, y: vel.y, z: vel.z };
    const disp = Math.max(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)) * dt;
    const steps = Math.min(MAX_STEPS, Math.max(1, Math.ceil(disp / MAX_SUBSTEP)));
    const h = dt / steps;
    const scratch = [];
    let onGround = wasOnGround;
    let drowned = false;
    let hitAirWall = false;
    let airWallDamped = false;
    for (let i = 0; i < steps; i++) {
      const prevX = p.x;
      const prevZ = p.z;
      if (v.x !== 0) {
        const nx = p.x + v.x * h;
        this.blockers(nx, p.y, p.z, radius, height, scratch);
        const top = onGround ? this.stepCandidate(scratch, p.y) : Infinity;
        if (scratch.length === 0) {
          p.x = nx;
        } else if (top < Infinity && !this.hits(nx, top + EPS2, p.z, radius, height)) {
          p.x = nx;
          p.y = top;
        } else {
          const face = v.x > 0 ? Math.min(...scratch.map((b) => b.x - b.w / 2)) : Math.max(...scratch.map((b) => b.x + b.w / 2));
          p.x = v.x > 0 ? Math.min(nx, face - radius) : Math.max(nx, face + radius);
          v.x = 0;
        }
      }
      if (v.z !== 0) {
        const nz = p.z + v.z * h;
        this.blockers(p.x, p.y, nz, radius, height, scratch);
        const top = onGround ? this.stepCandidate(scratch, p.y) : Infinity;
        if (scratch.length === 0) {
          p.z = nz;
        } else if (top < Infinity && !this.hits(p.x, top + EPS2, nz, radius, height)) {
          p.z = nz;
          p.y = top;
        } else {
          const face = v.z > 0 ? Math.min(...scratch.map((b) => b.z - b.d / 2)) : Math.max(...scratch.map((b) => b.z + b.d / 2));
          p.z = v.z > 0 ? Math.min(nz, face - radius) : Math.max(nz, face + radius);
          v.z = 0;
        }
      }
      const wall = this.constrainToPolygon(p.x, p.z, radius);
      if (wall.hit) {
        hitAirWall = true;
        const slideDx = wall.x - prevX;
        const slideDz = wall.z - prevZ;
        if (!airWallDamped) {
          airWallDamped = true;
          const dampX = prevX + slideDx * AIR_WALL_SLIDE_DAMP;
          const dampZ = prevZ + slideDz * AIR_WALL_SLIDE_DAMP;
          const recheck = this.constrainToPolygon(dampX, dampZ, radius);
          p.x = recheck.x;
          p.z = recheck.z;
          const vn = v.x * wall.nx + v.z * wall.nz;
          if (vn < 0) {
            v.x = (v.x - vn * wall.nx) * AIR_WALL_SLIDE_DAMP;
            v.z = (v.z - vn * wall.nz) * AIR_WALL_SLIDE_DAMP;
          } else {
            v.x *= AIR_WALL_SLIDE_DAMP;
            v.z *= AIR_WALL_SLIDE_DAMP;
          }
        } else {
          p.x = wall.x;
          p.z = wall.z;
          const vn = v.x * wall.nx + v.z * wall.nz;
          if (vn < 0) {
            v.x -= vn * wall.nx;
            v.z -= vn * wall.nz;
          }
        }
        if (this.hits(p.x, p.y, p.z, radius, height)) {
          p.x = prevX;
          p.z = prevZ;
          v.x = 0;
          v.z = 0;
        }
      }
      const ny = p.y + v.y * h;
      if (v.y <= 0) {
        let floor = -Infinity;
        for (const b of this.boxes) {
          if (!circleHitsRect(p.x, p.z, radius, b)) continue;
          const top = b.y + b.h;
          if (top <= p.y + EPS2 && top >= ny && top > floor) floor = top;
        }
        if (floor > -Infinity) {
          p.y = floor;
          v.y = 0;
          onGround = true;
        } else {
          p.y = ny;
          onGround = false;
        }
      } else {
        let ceil = Infinity;
        const head0 = p.y + height;
        const head1 = ny + height;
        for (const b of this.boxes) {
          if (!circleHitsRect(p.x, p.z, radius, b)) continue;
          if (b.y >= head0 - EPS2 && b.y <= head1 && b.y < ceil) ceil = b.y;
        }
        if (ceil < Infinity) {
          p.y = ceil - height;
          v.y = 0;
        } else {
          p.y = ny;
        }
        onGround = false;
      }
      if (p.y < this.waterY) {
        drowned = true;
        break;
      }
    }
    return { pos: p, vel: v, onGround, drowned, hitAirWall };
  }
};

// src/game/damage.ts
var EPS3 = 1e-6;
function rayBoxT(o, d, b) {
  let tmin = 0;
  let tmax = Infinity;
  const axes = [
    [o.x, d.x, b.x - b.w / 2, b.x + b.w / 2],
    [o.y, d.y, b.y, b.y + b.h],
    [o.z, d.z, b.z - b.d / 2, b.z + b.d / 2]
  ];
  for (const [ov, dv, lo, hi] of axes) {
    if (Math.abs(dv) < EPS3) {
      if (ov <= lo || ov >= hi) return Infinity;
      continue;
    }
    let t1 = (lo - ov) / dv;
    let t2 = (hi - ov) / dv;
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return Infinity;
  }
  return tmin > EPS3 ? tmin : tmax > EPS3 ? 0 : Infinity;
}

// src/game/map.ts
var BOXES = [];
var box = (x, y, z, w, h, d, kind) => {
  BOXES.push({ x, y, z, w, h, d, kind });
};
box(0, -1, 0, 64, 1, 40, "deck");
var CONTAINER_H = 2.6;
box(-12, 0, 11, 6, CONTAINER_H, 2.5, "container");
box(-4, 0, 11, 6, CONTAINER_H, 2.5, "container");
box(-16, 0, 2, 2.5, CONTAINER_H, 6, "container");
box(-6, 0, -4, 6, CONTAINER_H, 2.5, "container");
box(6, 0, 4, 6, CONTAINER_H, 2.5, "container");
box(16, 0, -2, 2.5, CONTAINER_H, 6, "container");
box(4, 0, -11, 6, CONTAINER_H, 2.5, "container");
box(12, 0, -11, 6, CONTAINER_H, 2.5, "container");
box(-2, 0, 1, 2.4, 0.55, 1.2, "container");
box(2, 0, -1, 2.4, 0.55, 1.2, "container");
var CRATE_H = [0.6, 1.2, 1.8, 2];
function crateStairs(cx, faceZ, dir) {
  for (let i = 0; i < CRATE_H.length; i++) {
    box(cx, 0, faceZ + dir * (0.6 + (CRATE_H.length - 1 - i) * 0.95), 0.9, CRATE_H[i], 0.9, "container");
  }
}
crateStairs(-12, 9.75, -1);
crateStairs(-4, 9.75, -1);
crateStairs(12, -9.75, 1);
crateStairs(4, -9.75, 1);
function tower(tx, tz) {
  const s = tx > 0 ? -1 : 1;
  box(tx, 0, tz, 3.4, 3, 3.4, "tower");
  box(tx, 3, tz, 4.4, 0.3, 4.4, "tower");
  box(tx, 3.3, tz - 2.05, 3.8, 1.05, 0.3, "rail");
  box(tx, 3.3, tz + 2.05, 3.8, 1.05, 0.3, "rail");
  box(tx - s * 2.05, 3.3, tz, 0.3, 1.05, 4.4, "rail");
  box(tx + s * 2.05, 3.3, tz - 1.5, 0.3, 1.05, 1.4, "rail");
  box(tx + s * 2.05, 3.3, tz + 1.5, 0.3, 1.05, 1.4, "rail");
  const edgeX = tx + s * 2.2;
  for (let i = 0; i < 10; i++) {
    box(edgeX + s * (9.5 - i) * 0.6, 0, tz, 0.6, (i + 1) * 0.3, 1.6, "tower");
  }
}
tower(-26, 14);
tower(26, 14);
tower(26, -14);
tower(-26, -14);
function pipe(cx, cz, len) {
  box(cx - 1.05, 0, cz, 0.3, 2, len, "pipe");
  box(cx + 1.05, 0, cz, 0.3, 2, len, "pipe");
  box(cx, 2, cz, 2.7, 0.4, len, "pipe");
}
pipe(-30, 1, 32);
pipe(30, -1, 32);
var WALKABLE_POLYGON = [
  { x: -27.8, z: -19.65 },
  { x: 31.85, z: -19.65 },
  { x: 31.85, z: 16.9 },
  { x: 27.8, z: 16.9 },
  { x: 27.8, z: 19.65 },
  { x: -31.85, z: 19.65 },
  { x: -31.85, z: -16.9 },
  { x: -27.8, z: -16.9 }
];
var MAP = {
  bounds: { w: 64, d: 40 },
  walkablePolygon: WALKABLE_POLYGON,
  boxes: BOXES,
  spawns: {
    teamA: [
      [-8, 0, 17],
      [-4, 0, 17],
      [0, 0, 17],
      [4, 0, 17],
      [8, 0, 17]
    ],
    teamB: [
      [8, 0, -17],
      [4, 0, -17],
      [0, 0, -17],
      [-4, 0, -17],
      [-8, 0, -17]
    ]
  },
  waterY: -2,
  pipes: [
    { from: [-30, 15], to: [-30, -13] },
    { from: [30, -15], to: [30, 13] }
  ],
  jumpSpots: [
    [-12, 6.3],
    [-4, 6.3],
    [12, -6.3],
    [4, -6.3]
  ]
};
function spawnPoint(team, index) {
  const list = team === "A" ? MAP.spawns.teamA : MAP.spawns.teamB;
  return list[(index % list.length + list.length) % list.length];
}

// src/render/bossModel.ts
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
var DEG2RAD = Math.PI / 180;
function clamp2(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function lerp(a, b, t) {
  return a + (b - a) * t;
}
function smoothstep(t) {
  const u = clamp01(t);
  return u * u * (3 - 2 * u);
}
function mechSnap(t, power = 3.2) {
  const u = clamp01(t);
  return 1 - Math.pow(1 - u, power);
}
function steppedServoWave(phase, holdFrac = 0.6) {
  const cyc = (phase % 1 + 1) % 1;
  const moveFrac = (1 - holdFrac) * 0.5;
  if (cyc < moveFrac) {
    return lerp(-1, 1, mechSnap(cyc / moveFrac, 2.6));
  }
  if (cyc < moveFrac + holdFrac * 0.5) {
    return 1;
  }
  const mid = moveFrac + holdFrac * 0.5;
  if (cyc < mid + moveFrac) {
    return lerp(1, -1, mechSnap((cyc - mid) / moveFrac, 2.6));
  }
  return -1;
}
function hash3(ix, iy, iz, seed) {
  let n = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(iz | 0, 1274126177) ^ Math.imul(seed | 0, 2246822519);
  n = Math.imul(n ^ n >>> 13, 1274126177);
  return ((n ^ n >>> 16) >>> 0) / 4294967296;
}
function hash2Tile(ix, iy, periodX, periodY, seed) {
  const wx = (ix % periodX + periodX) % periodX;
  const wy = (iy % periodY + periodY) % periodY;
  return hash3(wx, wy, 0, seed);
}
function noise2Tile(x, y, periodX, periodY, seed) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2Tile(ix, iy, periodX, periodY, seed);
  const b = hash2Tile(ix + 1, iy, periodX, periodY, seed);
  const c = hash2Tile(ix, iy + 1, periodX, periodY, seed);
  const d = hash2Tile(ix + 1, iy + 1, periodX, periodY, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
function fbm2Tile(u, v, periodX, periodY, seed, octaves = 4) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let px = periodX;
  let py = periodY;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2Tile(u * px, v * py, px, py, seed + i * 23);
    norm += amp;
    px *= 2;
    py *= 2;
    amp *= 0.5;
  }
  return sum / norm;
}
var UV_BAND_ARMOR = [0.555, 0.965];
var UV_BAND_HAZARD = [0.375, 0.495];
var UV_BAND_MECH = [0.205, 0.315];
var UV_BAND_ENERGY = [0.03, 0.15];
function makeFallbackTex(r, g, b, srgb) {
  const data = new Uint8Array([
    r,
    g,
    b,
    255,
    r,
    g,
    b,
    255,
    r,
    g,
    b,
    255,
    r,
    g,
    b,
    255
  ]);
  const tex = new THREE.DataTexture(data, 2, 2);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}
function buildNormalCanvasFromHeight(height, size, strength) {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const wrapX = (i) => (i % size + size) % size;
  const clampY = (i) => clamp2(i, 0, size - 1);
  for (let y = 0; y < size; y++) {
    const ym = clampY(y - 1);
    const yp = clampY(y + 1);
    for (let x = 0; x < size; x++) {
      const xm = wrapX(x - 1);
      const xp = wrapX(x + 1);
      const tl = height[ym * size + xm];
      const t = height[ym * size + x];
      const tr = height[ym * size + xp];
      const l = height[y * size + xm];
      const r = height[y * size + xp];
      const bl = height[yp * size + xm];
      const b = height[yp * size + x];
      const br = height[yp * size + xp];
      const dx = (tr + 2 * r + br - (tl + 2 * l + bl)) * 0.25 * strength;
      const dy = (bl + 2 * b + br - (tl + 2 * t + tr)) * 0.25 * strength;
      const invLen = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const nx = -dx * invLen;
      const ny = -dy * invLen;
      const nz = invLen;
      const idx = (y * size + x) * 4;
      d[idx] = Math.round(clamp01(nx * 0.5 + 0.5) * 255);
      d[idx + 1] = Math.round(clamp01(ny * 0.5 + 0.5) * 255);
      d[idx + 2] = Math.round(clamp01(nz * 0.5 + 0.5) * 255);
      d[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
function createMechAtlas() {
  if (typeof document === "undefined") {
    const albedoMap2 = makeFallbackTex(150, 158, 168, true);
    const emissiveMap2 = makeFallbackTex(190, 96, 26, true);
    const normalMap2 = makeFallbackTex(128, 128, 255, false);
    return { albedoMap: albedoMap2, emissiveMap: emissiveMap2, normalMap: normalMap2, all: [albedoMap2, emissiveMap2, normalMap2] };
  }
  const S = 512;
  const albedoCanvas = document.createElement("canvas");
  albedoCanvas.width = albedoCanvas.height = S;
  const albedoCtx = albedoCanvas.getContext("2d");
  const albedoImg = albedoCtx.createImageData(S, S);
  const ad = albedoImg.data;
  const emCanvas = document.createElement("canvas");
  emCanvas.width = emCanvas.height = S;
  const emCtx = emCanvas.getContext("2d");
  const emImg = emCtx.createImageData(S, S);
  const ed = emImg.data;
  const height = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    const v = 1 - (y + 0.5) / S;
    for (let x = 0; x < S; x++) {
      const u = (x + 0.5) / S;
      const idx = y * S + x;
      const p4 = idx * 4;
      if (v >= 0.53) {
        const bv = clamp01((v - 0.53) / 0.47);
        const edgeU = Math.min(u, 1 - u);
        const edgeV = Math.min(bv, 1 - bv);
        const borderDist = Math.min(edgeU, edgeV);
        const outerSeam = smoothstep((0.022 - borderDist) / 0.015);
        const innerInset = Math.max(Math.abs(u - 0.5) - 0.43, Math.abs(bv - 0.5) - 0.41);
        const panelGroove = smoothstep((8e-3 - Math.abs(innerInset)) / 6e-3) * 0.65;
        let bolt = 0;
        const bolts = [
          [0.09, 0.1],
          [0.91, 0.1],
          [0.09, 0.9],
          [0.91, 0.9]
        ];
        for (let k = 0; k < bolts.length; k++) {
          const d = Math.hypot(u - bolts[k][0], bv - bolts[k][1]);
          if (d < 0.026) {
            bolt = Math.max(bolt, d < 0.014 ? 0.72 : -0.42);
          }
        }
        const brush = fbm2Tile(u * 2, bv * 20, 6, 32, 109, 3);
        const weather = fbm2Tile(u, bv, 4, 3, 223, 4);
        const streak = fbm2Tile(u * 6, bv * 2, 14, 4, 331, 3);
        const edgeChip = smoothstep((0.055 - borderDist) / 0.04) * smoothstep((streak - 0.52) * 3.8);
        const fineScratch = smoothstep((fbm2Tile(u * 5, bv * 5, 22, 16, 409, 2) - 0.8) * 6.5) * 0.35;
        const h = 0.66 - outerSeam * 0.36 - panelGroove * 0.18 + bolt * 0.18 + (brush - 0.5) * 0.05 + (weather - 0.5) * 0.04;
        height[idx] = clamp01(h);
        const grimeMod = lerp(0.86, 1.04, weather) * lerp(0.95, 1.04, brush);
        const seamAO = 1 - outerSeam * 0.44 - panelGroove * 0.22;
        const baseLum = clamp2(184 * grimeMod * seamAO + edgeChip * 38 + fineScratch * 24 + bolt * 14, 58, 228);
        ad[p4] = Math.round(baseLum * 0.96);
        ad[p4 + 1] = Math.round(baseLum * 0.99);
        ad[p4 + 2] = Math.round(clamp2(baseLum * 1.04, 58, 232));
        ad[p4 + 3] = 255;
        const seamHeat = smoothstep((0.015 - borderDist) / 0.011) * (0.75 + 0.25 * weather);
        ed[p4] = Math.round(clamp01(seamHeat * 1) * 255);
        ed[p4 + 1] = Math.round(clamp01(seamHeat * 0.42) * 255);
        ed[p4 + 2] = Math.round(clamp01(seamHeat * 0.08) * 255);
        ed[p4 + 3] = 255;
      } else if (v >= 0.35) {
        const bv = clamp01((v - 0.35) / 0.18);
        const border = bv < 0.11 || bv > 0.89;
        const diag = ((u * 7 + bv * 1.55) % 1 + 1) % 1;
        const isYellow = diag < 0.5;
        const stripeDist = Math.min(Math.abs(diag - 0.5), Math.min(diag, 1 - diag));
        const chipNoise = fbm2Tile(u * 2, bv, 14, 4, 521, 3);
        const chipped = smoothstep((chipNoise - 0.72) * 5) * smoothstep((0.12 - stripeDist) / 0.12);
        const wear = fbm2Tile(u, bv, 8, 4, 607, 3);
        height[idx] = border ? 0.42 : 0.64 - chipped * 0.16 + (wear - 0.5) * 0.08;
        if (border) {
          const lum = 44 + wear * 18;
          ad[p4] = Math.round(lum * 0.94);
          ad[p4 + 1] = Math.round(lum * 0.98);
          ad[p4 + 2] = Math.round(lum * 1.05);
        } else if (isYellow && chipped < 0.55) {
          const sh = 0.8 + wear * 0.22;
          ad[p4] = Math.round(clamp2(182 * sh, 110, 194));
          ad[p4 + 1] = Math.round(clamp2(124 * sh, 74, 138));
          ad[p4 + 2] = Math.round(clamp2(28 * sh, 16, 44));
        } else {
          const lum = chipped >= 0.55 ? 116 + wear * 24 : 34 + wear * 16;
          ad[p4] = Math.round(lum * 0.95);
          ad[p4 + 1] = Math.round(lum * 0.98);
          ad[p4 + 2] = Math.round(lum * 1.04);
        }
        ad[p4 + 3] = 255;
        ed[p4] = 0;
        ed[p4 + 1] = 0;
        ed[p4 + 2] = 0;
        ed[p4 + 3] = 255;
      } else if (v >= 0.18) {
        const bv = clamp01((v - 0.18) / 0.17);
        const ribPhase = bv * 8 % 1;
        const rib = smoothstep(Math.min(ribPhase, 1 - ribPhase) / 0.24);
        const lathe = fbm2Tile(u * 4, bv * 2, 16, 4, 733, 3);
        height[idx] = clamp01(0.28 + rib * 0.56 + (lathe - 0.5) * 0.08);
        const lum = clamp2(102 + rib * 84 + (lathe - 0.5) * 24, 46, 208);
        ad[p4] = Math.round(lum * 0.96);
        ad[p4 + 1] = Math.round(lum * 0.99);
        ad[p4 + 2] = Math.round(lum * 1.04);
        ad[p4 + 3] = 255;
        const ventEm = Math.pow(1 - rib, 1.35);
        ed[p4] = Math.round(clamp01(ventEm * 1) * 255);
        ed[p4 + 1] = Math.round(clamp01(ventEm * 0.45) * 255);
        ed[p4 + 2] = Math.round(clamp01(ventEm * 0.08) * 255);
        ed[p4 + 3] = 255;
      } else {
        const bv = clamp01(v / 0.18);
        const flow = fbm2Tile(u * 2, bv, 10, 4, 881, 4);
        const streak = 0.5 + 0.5 * Math.sin((u * 12 + flow * 2.2) * Math.PI * 2);
        const edgeHeat = smoothstep((bv - 0.14) / 0.78);
        const hotCore = clamp01(edgeHeat * 0.82 + streak * 0.14 + flow * 0.12);
        height[idx] = clamp01(0.42 + streak * 0.18);
        const r = lerp(70, 224, hotCore);
        const g = lerp(22, 152, Math.pow(hotCore, 1.3));
        const b = lerp(8, 62, Math.pow(hotCore, 2.1));
        ad[p4] = Math.round(clamp2(r, 24, 232));
        ad[p4 + 1] = Math.round(clamp2(g, 10, 180));
        ad[p4 + 2] = Math.round(clamp2(b, 6, 98));
        ad[p4 + 3] = 255;
        const em = clamp01(0.22 + edgeHeat * 0.78) * (0.86 + 0.14 * streak);
        ed[p4] = Math.round(clamp01(em * 1) * 255);
        ed[p4 + 1] = Math.round(clamp01(em * lerp(0.32, 0.82, edgeHeat)) * 255);
        ed[p4 + 2] = Math.round(clamp01(em * lerp(0.05, 0.36, Math.pow(edgeHeat, 1.8))) * 255);
        ed[p4 + 3] = 255;
      }
    }
  }
  albedoCtx.putImageData(albedoImg, 0, 0);
  emCtx.putImageData(emImg, 0, 0);
  const normalCanvas = buildNormalCanvasFromHeight(height, S, 2.8);
  const wrapTex = (c, srgb) => {
    const t = new THREE.CanvasTexture(c);
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.anisotropy = 4;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  };
  const albedoMap = wrapTex(albedoCanvas, true);
  const emissiveMap = wrapTex(emCanvas, true);
  const normalMap = wrapTex(normalCanvas, false);
  return { albedoMap, emissiveMap, normalMap, all: [albedoMap, emissiveMap, normalMap] };
}
var TINT_ARMOR_MAIN = [0.22, 0.26, 0.32];
var TINT_ARMOR_DARK = [0.13, 0.16, 0.2];
var TINT_ARMOR_LIGHT = [0.54, 0.6, 0.67];
var TINT_ARMOR_CRIMSON = [0.52, 0.15, 0.12];
var TINT_ARMOR_TRIM = [0.36, 0.41, 0.48];
var TINT_HAZARD = [0.88, 0.86, 0.82];
var TINT_FRAME_DARK = [0.12, 0.14, 0.18];
var TINT_FRAME_MID = [0.26, 0.3, 0.36];
var TINT_PISTON_CHROME = [0.76, 0.81, 0.88];
var TINT_PISTON_BRASS = [0.82, 0.64, 0.34];
var TINT_CORE_HOT = [1, 0.9, 0.78];
function applyBoxBandUV(geo, band, uvScale = 1) {
  const pos = geo.getAttribute("position");
  const norm = geo.getAttribute("normal");
  const [vMin, vMax] = band;
  const uvs = new Float32Array(pos.count * 2);
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const sx = Math.max(0.05, bb.max.x - bb.min.x);
  const sy = Math.max(0.05, bb.max.y - bb.min.y);
  const sz = Math.max(0.05, bb.max.z - bb.min.z);
  for (let i = 0; i < pos.count; i++) {
    const px = pos.getX(i);
    const py = pos.getY(i);
    const pz = pos.getZ(i);
    const ax = norm ? Math.abs(norm.getX(i)) : 0;
    const ay = norm ? Math.abs(norm.getY(i)) : 1;
    const az = norm ? Math.abs(norm.getZ(i)) : 0;
    let lu;
    let lv;
    if (ax >= ay && ax >= az) {
      lu = (pz - bb.min.z) / sz * uvScale;
      lv = clamp01((py - bb.min.y) / sy);
    } else if (ay >= ax && ay >= az) {
      lu = (px - bb.min.x) / sx * uvScale;
      lv = clamp01((pz - bb.min.z) / sz);
    } else {
      lu = (px - bb.min.x) / sx * uvScale;
      lv = clamp01((py - bb.min.y) / sy);
    }
    uvs[i * 2] = lu;
    uvs[i * 2 + 1] = lerp(vMin, vMax, lv);
  }
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
}
function finalizePart(geo, opts = {}) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  geo.dispose();
  if (opts.faceted) {
    g.computeVertexNormals();
  } else if (!g.getAttribute("normal")) {
    g.computeVertexNormals();
  }
  applyBoxBandUV(g, opts.band ?? UV_BAND_ARMOR, opts.uvScale ?? 1);
  const pos = g.getAttribute("position");
  const norm = g.getAttribute("normal");
  g.computeBoundingBox();
  const bb = g.boundingBox;
  const spanY = Math.max(1e-3, bb.max.y - bb.min.y);
  const tint = opts.tint ?? TINT_ARMOR_MAIN;
  const aoBot = opts.aoBottom ?? 0.22;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const uy = clamp01((pos.getY(i) - bb.min.y) / spanY);
    const ny = norm ? norm.getY(i) : 0;
    const bevelBoost = 0.94 + ny * 0.14;
    const shade = lerp(1 - aoBot, 1.08, uy) * bevelBoost;
    colors[i * 3] = clamp2(tint[0] * shade, 0.04, 1.2);
    colors[i * 3 + 1] = clamp2(tint[1] * shade, 0.04, 1.2);
    colors[i * 3 + 2] = clamp2(tint[2] * shade, 0.04, 1.2);
  }
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  if (opts.rot && (opts.rot[0] || opts.rot[1] || opts.rot[2])) {
    g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(opts.rot[0], opts.rot[1], opts.rot[2])));
  }
  if (opts.pos && (opts.pos[0] || opts.pos[1] || opts.pos[2])) {
    g.translate(opts.pos[0], opts.pos[1], opts.pos[2]);
  }
  return g;
}
function normalizeForMerge(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  geo.dispose();
  if (!g.getAttribute("normal")) g.computeVertexNormals();
  const pos = g.getAttribute("position");
  if (!g.getAttribute("uv")) {
    const uvs = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      uvs[i * 2] = 0.5;
      uvs[i * 2 + 1] = lerp(UV_BAND_ARMOR[0], UV_BAND_ARMOR[1], 0.5);
    }
    g.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  }
  if (!g.getAttribute("color")) {
    const colors = new Float32Array(pos.count * 3).fill(1);
    g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  }
  for (const key of Object.keys(g.attributes)) {
    if (key !== "position" && key !== "normal" && key !== "uv" && key !== "color") {
      g.deleteAttribute(key);
    }
  }
  return g;
}
function mergeStrict(geos) {
  const normalized = geos.map((g) => normalizeForMerge(g));
  const merged = mergeGeometries(normalized, false);
  for (const g of normalized) g.dispose();
  if (!merged) throw new Error("bossModel: mergeGeometries failed");
  return merged;
}
function buildChamferBox(w, h, d, bevel = 0.026, opts = {}) {
  const b = Math.min(bevel, w * 0.34, h * 0.34, d * 0.34);
  const hw = Math.max(4e-3, w * 0.5 - b);
  const hh = Math.max(4e-3, h * 0.5 - b);
  const coreD = Math.max(4e-3, d - 2 * b);
  const shape = new THREE.Shape();
  shape.moveTo(-hw, -hh);
  shape.lineTo(hw, -hh);
  shape.lineTo(hw, hh);
  shape.lineTo(-hw, hh);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: coreD,
    bevelEnabled: b > 1e-3,
    bevelThickness: b,
    bevelSize: b,
    bevelSegments: 1,
    curveSegments: 1
  });
  geo.translate(0, 0, -coreD * 0.5);
  return finalizePart(geo, { faceted: true, ...opts });
}
function buildSlopedPlate(pts, depth, bevel = 0.024, opts = {}) {
  const b = Math.min(bevel, depth * 0.36);
  const coreD = Math.max(4e-3, depth - 2 * b);
  const shape = new THREE.Shape();
  shape.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) {
    shape.lineTo(pts[i][0], pts[i][1]);
  }
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: coreD,
    bevelEnabled: b > 1e-3,
    bevelThickness: b,
    bevelSize: b,
    bevelSegments: 1,
    curveSegments: 1
  });
  geo.translate(0, 0, -coreD * 0.5);
  return finalizePart(geo, { faceted: true, ...opts });
}
function buildArmoredFrustum(wBot, dBot, wTop, dTop, h, skewZ = 0, skewX = 0, opts = {}) {
  const geo = new THREE.CylinderGeometry(1, 1, 1, 8, 1, false);
  geo.rotateY(Math.PI / 8);
  const scaleNorm = 1 / Math.cos(Math.PI / 8);
  const pos = geo.getAttribute("position");
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) * scaleNorm * 0.5;
    const y = pos.getY(i);
    const z = pos.getZ(i) * scaleNorm * 0.5;
    const isTop = y > 0;
    const w = isTop ? wTop : wBot;
    const d = isTop ? dTop : dBot;
    const ox = isTop ? skewX * 0.5 : -skewX * 0.5;
    const oz = isTop ? skewZ * 0.5 : -skewZ * 0.5;
    pos.setXYZ(i, x * w + ox, y * h, z * d + oz);
  }
  return finalizePart(geo, { faceted: true, ...opts });
}
function buildCylinder(rTop, rBot, len, segs = 12, opts = {}) {
  const geo = new THREE.CylinderGeometry(rTop, rBot, len, segs, 1, false);
  return finalizePart(geo, { faceted: false, band: UV_BAND_MECH, ...opts });
}
function buildHydraulicPiston(a, b, barrelR, rodR, rodTint = TINT_PISTON_CHROME, barrelTint = TINT_FRAME_DARK) {
  const va = new THREE.Vector3(a[0], a[1], a[2]);
  const vb = new THREE.Vector3(b[0], b[1], b[2]);
  const dir = vb.clone().sub(va);
  const len = dir.length();
  if (len < 0.02) return [];
  const unitDir = dir.clone().divideScalar(len);
  const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), unitDir);
  const euler = new THREE.Euler().setFromQuaternion(quat, "XYZ");
  const rot = [euler.x, euler.y, euler.z];
  const barrelLen = len * 0.54;
  const barrelMid = va.clone().addScaledVector(unitDir, barrelLen * 0.5);
  const collarPos = va.clone().addScaledVector(unitDir, barrelLen);
  const rodLen = len * 0.56;
  const rodMid = va.clone().addScaledVector(unitDir, len - rodLen * 0.5);
  return [
    buildCylinder(barrelR, barrelR * 1.04, barrelLen, 10, {
      pos: [barrelMid.x, barrelMid.y, barrelMid.z],
      rot,
      tint: barrelTint,
      band: UV_BAND_MECH
    }),
    buildCylinder(barrelR * 1.26, barrelR * 1.26, Math.min(0.044, len * 0.1), 10, {
      pos: [collarPos.x, collarPos.y, collarPos.z],
      rot,
      tint: TINT_FRAME_MID,
      band: UV_BAND_MECH
    }),
    buildCylinder(rodR, rodR, rodLen, 10, {
      pos: [rodMid.x, rodMid.y, rodMid.z],
      rot,
      tint: rodTint,
      band: UV_BAND_MECH,
      aoBottom: 0.04
    }),
    buildCylinder(barrelR * 1.15, barrelR * 1.15, barrelR * 1.8, 8, {
      pos: a,
      rot: [0, 0, Math.PI * 0.5],
      tint: TINT_FRAME_MID,
      band: UV_BAND_MECH
    }),
    buildCylinder(rodR * 1.45, rodR * 1.45, rodR * 2.3, 8, {
      pos: b,
      rot: [0, 0, Math.PI * 0.5],
      tint: TINT_FRAME_MID,
      band: UV_BAND_MECH
    })
  ];
}
function buildArmoredConduit(pts, radius, tubularSegs = 12, radialSegs = 7, tint = TINT_FRAME_DARK) {
  const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(p[0], p[1], p[2])));
  const geo = new THREE.TubeGeometry(curve, tubularSegs, radius, radialSegs, false);
  return finalizePart(geo, { faceted: false, band: UV_BAND_MECH, tint, uvScale: 2 });
}
function buildLouverBank(w, h, d, slats, pos, rot = [0, 0, 0], tint = TINT_FRAME_MID) {
  const out = [];
  const stepY = h / Math.max(1, slats);
  const slatH = stepY * 0.42;
  const mat = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rot[0], rot[1], rot[2]));
  const v = new THREE.Vector3();
  for (let i = 0; i < slats; i++) {
    const ly = -h * 0.5 + (i + 0.5) * stepY;
    v.set(0, ly, 0).applyMatrix4(mat);
    out.push(
      buildChamferBox(w, slatH, d, 5e-3, {
        pos: [pos[0] + v.x, pos[1] + v.y, pos[2] + v.z],
        rot: [rot[0] + 0.36, rot[1], rot[2]],
        tint,
        band: UV_BAND_MECH
      })
    );
  }
  return out;
}
function buildPlasmaBladeGeometry(length, width, thickness) {
  const shape = new THREE.Shape();
  shape.moveTo(width * 0.14, 0.05);
  shape.lineTo(-width * 0.42, -0.02);
  shape.lineTo(-width * 0.58, -length * 0.12);
  shape.lineTo(-width * 0.56, -length * 0.78);
  shape.lineTo(width * 0.12, -length);
  shape.lineTo(width * 0.16, -length * 0.88);
  shape.lineTo(width * 0.16, 0.05);
  shape.closePath();
  const raw = new THREE.ExtrudeGeometry(shape, {
    depth: thickness * 0.24,
    bevelEnabled: true,
    bevelThickness: thickness * 0.38,
    bevelSize: 8e-3,
    bevelSegments: 1,
    curveSegments: 1
  });
  raw.translate(0, 0, -thickness * 0.12);
  raw.rotateY(-Math.PI * 0.5);
  const g = raw.index ? raw.toNonIndexed() : raw;
  g.computeVertexNormals();
  const pos = g.getAttribute("position");
  const uvs = new Float32Array(pos.count * 2);
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const py = pos.getY(i);
    const pz = pos.getZ(i);
    const along = clamp01(-py / length);
    const edgeFactor = clamp01((-pz + width * 0.14) / (width * 0.72));
    const heat = clamp01(edgeFactor * 0.86 + along * 0.2);
    uvs[i * 2] = along * 2.4;
    uvs[i * 2 + 1] = lerp(UV_BAND_ENERGY[0], UV_BAND_ENERGY[1], heat);
    const c = lerp(0.84, 1.18, heat);
    colors[i * 3] = c;
    colors[i * 3 + 1] = c;
    colors[i * 3 + 2] = c;
  }
  g.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return g;
}
var BASE_HIP_Y = 1.96;
var THIGH_LEN = 0.88;
var SHIN_LEN = 0.8;
var FOOT_SOLE_Y = -0.24;
var ATTACK_LOCK_SEC = 0.075;
var ATTACK_SWEEP_SEC = 0.095;
var RECOVER_DURATION = 0.78;
function buildTorsoParts() {
  const armor = [];
  const frame = [];
  const core = [];
  const vent = [];
  frame.push(
    buildCylinder(0.24, 0.26, 0.56, 12, { pos: [0, 0.34, 0.02], tint: TINT_FRAME_DARK }),
    buildCylinder(0.32, 0.32, 0.08, 12, { pos: [0, 0.24, 0.02], tint: TINT_FRAME_MID }),
    buildCylinder(0.31, 0.31, 0.08, 12, { pos: [0, 0.44, 0.02], tint: TINT_FRAME_MID })
  );
  armor.push(
    buildArmoredFrustum(0.54, 0.42, 0.62, 0.46, 0.2, -0.02, 0, { pos: [0, 0.28, -0.06], tint: TINT_ARMOR_DARK }),
    buildArmoredFrustum(0.62, 0.46, 0.76, 0.52, 0.22, -0.04, 0, { pos: [0, 0.48, -0.08], tint: TINT_ARMOR_MAIN })
  );
  frame.push(
    ...buildHydraulicPiston([-0.32, 0.08, -0.14], [-0.46, 0.66, -0.22], 0.052, 0.03, TINT_PISTON_CHROME),
    ...buildHydraulicPiston([0.32, 0.08, -0.14], [0.46, 0.66, -0.22], 0.052, 0.03, TINT_PISTON_CHROME),
    ...buildHydraulicPiston([-0.3, 0.08, 0.24], [-0.42, 0.68, 0.3], 0.056, 0.032, TINT_PISTON_BRASS),
    ...buildHydraulicPiston([0.3, 0.08, 0.24], [0.42, 0.68, 0.3], 0.056, 0.032, TINT_PISTON_BRASS)
  );
  frame.push(
    buildArmoredFrustum(0.92, 0.72, 1.38, 0.86, 0.84, -0.06, 0, { pos: [0, 1, 0.02], tint: TINT_FRAME_DARK })
  );
  for (const s of [-1, 1]) {
    const mainPec = [
      [-0.18, -0.32],
      [0.34, -0.26],
      [0.44, 0.26],
      [-0.12, 0.34]
    ];
    armor.push(
      buildSlopedPlate(
        s === 1 ? mainPec : mainPec.map(([x, y]) => [-x, y]).reverse(),
        0.26,
        0.032,
        {
          pos: [s * 0.44, 1.02, -0.34],
          rot: [-0.18, s * 0.28, s * -0.06],
          tint: TINT_ARMOR_MAIN
        }
      )
    );
    const upperPec = [
      [-0.18, -0.14],
      [0.3, -0.1],
      [0.34, 0.16],
      [-0.1, 0.2]
    ];
    armor.push(
      buildSlopedPlate(
        s === 1 ? upperPec : upperPec.map(([x, y]) => [-x, y]).reverse(),
        0.14,
        0.024,
        {
          pos: [s * 0.48, 1.18, -0.46],
          rot: [-0.26, s * 0.3, s * -0.06],
          tint: TINT_ARMOR_LIGHT
        }
      )
    );
    armor.push(
      buildChamferBox(0.38, 0.08, 0.12, 0.012, {
        pos: [s * 0.46, 0.96, -0.49],
        rot: [-0.16, s * 0.28, s * 0.14],
        tint: TINT_ARMOR_CRIMSON
      }),
      // Weathered hazard caution trim on lower chest chin
      buildChamferBox(0.28, 0.075, 0.12, 0.01, {
        pos: [s * 0.4, 0.72, -0.46],
        rot: [-0.14, s * 0.24, 0],
        tint: TINT_HAZARD,
        band: UV_BAND_HAZARD,
        uvScale: 0.75
      })
    );
    vent.push(
      buildChamferBox(0.24, 0.045, 0.06, 6e-3, {
        pos: [s * 0.46, 1.06, -0.49],
        rot: [-0.2, s * 0.28, s * 0.16],
        tint: TINT_CORE_HOT,
        band: UV_BAND_ENERGY
      })
    );
    armor.push(
      buildChamferBox(0.22, 0.56, 0.68, 0.026, {
        pos: [s * 0.72, 1.02, 0.04],
        rot: [0, 0, s * -0.18],
        tint: TINT_ARMOR_DARK
      })
    );
    frame.push(
      ...buildLouverBank(0.08, 0.34, 0.34, 5, [s * 0.82, 1, 0.04], [0, 0, s * -0.18], TINT_FRAME_MID)
    );
    vent.push(
      buildChamferBox(0.05, 0.32, 0.26, 8e-3, {
        pos: [s * 0.77, 1, 0.04],
        rot: [0, 0, s * -0.18],
        tint: TINT_CORE_HOT,
        band: UV_BAND_MECH
      })
    );
    armor.push(
      buildChamferBox(0.46, 0.2, 0.48, 0.026, {
        pos: [s * 0.62, 1.38, -0.04],
        rot: [0.06, s * 0.08, s * -0.16],
        tint: TINT_ARMOR_TRIM
      })
    );
    frame.push(
      buildCylinder(0.23, 0.23, 0.38, 12, {
        pos: [s * 0.8, 1.3, 0],
        rot: [0, 0, Math.PI * 0.5],
        tint: TINT_FRAME_MID
      }),
      ...buildHydraulicPiston(
        [s * 0.34, 1.4, -0.14],
        [s * 0.76, 1.44, 0],
        0.046,
        0.026,
        TINT_PISTON_BRASS
      )
    );
  }
  armor.push(
    // Heavy protruding central upper sternal prow hood overhanging reactor recess
    buildChamferBox(0.56, 0.22, 0.34, 0.028, { pos: [0, 1.24, -0.44], rot: [-0.28, 0, 0], tint: TINT_ARMOR_LIGHT }),
    // Crimson command badge stripe across upper sternal brow
    buildChamferBox(0.32, 0.08, 0.14, 0.012, { pos: [0, 1.31, -0.54], rot: [-0.28, 0, 0], tint: TINT_ARMOR_CRIMSON }),
    // Lower sternal armored keel block
    buildChamferBox(0.46, 0.2, 0.3, 0.026, { pos: [0, 0.66, -0.42], rot: [0.24, 0, 0], tint: TINT_ARMOR_MAIN })
  );
  frame.push(
    // Thick recessed outer armored octagonal turbine bezel framing front core
    buildCylinder(0.25, 0.28, 0.18, 8, {
      pos: [0, 0.96, -0.42],
      rot: [Math.PI * 0.5, Math.PI / 8, 0],
      tint: TINT_FRAME_DARK
    }),
    // Diagonal X-brace turbine blast cage + central machined reactor hub cap (exposes 4 glowing quadrants!)
    buildChamferBox(0.42, 0.044, 0.09, 7e-3, { pos: [0, 0.96, -0.51], rot: [0, 0, Math.PI * 0.25], tint: TINT_FRAME_MID }),
    buildChamferBox(0.42, 0.044, 0.09, 7e-3, { pos: [0, 0.96, -0.51], rot: [0, 0, -Math.PI * 0.25], tint: TINT_FRAME_MID }),
    buildCylinder(0.072, 0.082, 0.11, 8, {
      pos: [0, 0.96, -0.5],
      rot: [Math.PI * 0.5, Math.PI / 8, 0],
      tint: TINT_ARMOR_LIGHT
    })
  );
  armor.push(
    // Rear sloped armored bunker cowl behind head
    buildChamferBox(0.74, 0.36, 0.3, 0.03, { pos: [0, 1.54, 0.22], rot: [-0.16, 0, 0], tint: TINT_ARMOR_MAIN }),
    buildChamferBox(0.62, 0.14, 0.34, 0.022, { pos: [0, 1.68, 0.16], rot: [0.2, 0, 0], tint: TINT_ARMOR_LIGHT }),
    // Low angled front gorget chin-shield (never blocks mono-eye!)
    buildChamferBox(0.44, 0.14, 0.2, 0.018, { pos: [0, 1.4, -0.36], rot: [-0.26, 0, 0], tint: TINT_ARMOR_DARK })
  );
  for (const s of [-1, 1]) {
    armor.push(
      buildChamferBox(0.16, 0.3, 0.46, 0.022, {
        pos: [s * 0.36, 1.52, -0.02],
        rot: [0.06, s * -0.16, s * 0.14],
        tint: TINT_ARMOR_MAIN
      })
    );
    frame.push(
      buildArmoredConduit(
        [
          [s * 0.34, 1.38, -0.32],
          [s * 0.44, 1.58, -0.26],
          [s * 0.44, 1.68, 0.06],
          [s * 0.36, 1.6, 0.26]
        ],
        0.028,
        10,
        6,
        TINT_FRAME_MID
      )
    );
  }
  armor.push(
    buildChamferBox(0.7, 0.86, 0.36, 0.032, { pos: [0, 1.02, 0.44], tint: TINT_ARMOR_DARK })
  );
  frame.push(
    buildCylinder(0.24, 0.27, 0.18, 8, {
      pos: [0, 0.98, 0.56],
      rot: [Math.PI * 0.5, Math.PI / 8, 0],
      tint: TINT_FRAME_DARK
    }),
    buildChamferBox(0.4, 0.055, 0.1, 8e-3, { pos: [0, 1.05, 0.65], tint: TINT_FRAME_MID }),
    buildChamferBox(0.4, 0.055, 0.1, 8e-3, { pos: [0, 0.91, 0.65], tint: TINT_FRAME_MID }),
    buildChamferBox(0.06, 0.36, 0.1, 8e-3, { pos: [0, 0.98, 0.65], tint: TINT_FRAME_MID })
  );
  for (const s of [-1, 1]) {
    armor.push(
      buildArmoredFrustum(0.36, 0.46, 0.42, 0.44, 0.94, 0.06, s * 0.04, {
        pos: [s * 0.48, 1.18, 0.5],
        tint: TINT_ARMOR_MAIN
      }),
      // Titanium upper heat-sink cowl cap + crimson command tip
      buildChamferBox(0.36, 0.24, 0.42, 0.026, {
        pos: [s * 0.5, 1.66, 0.48],
        rot: [0.16, s * -0.12, s * -0.1],
        tint: TINT_ARMOR_LIGHT
      }),
      // Swept dorsal stabilizer wing-fin (breaks up upper back silhouette cleanly!)
      buildSlopedPlate(
        [
          [-0.08, -0.22],
          [0.1, -0.22],
          [0.26, 0.32],
          [0.04, 0.38]
        ],
        0.09,
        0.016,
        {
          pos: [s * 0.62, 1.68, 0.6],
          rot: [0.22, s * -0.24, s * -0.26],
          tint: TINT_ARMOR_CRIMSON
        }
      )
    );
    frame.push(
      buildCylinder(0.082, 0.102, 0.44, 10, {
        pos: [s * 0.44, 1.82, 0.54],
        rot: [0.14, 0, s * -0.1],
        tint: TINT_FRAME_DARK
      }),
      buildCylinder(0.112, 0.112, 0.07, 10, {
        pos: [s * 0.46, 2, 0.57],
        rot: [0.14, 0, s * -0.1],
        tint: TINT_FRAME_MID
      }),
      // Lower thruster exhaust nozzle bell
      buildCylinder(0.11, 0.17, 0.24, 10, {
        pos: [s * 0.46, 0.68, 0.56],
        rot: [0.26, 0, s * -0.06],
        tint: TINT_FRAME_MID
      }),
      // Ribbed armored power conduit arching from backpack over shoulder drum
      buildArmoredConduit(
        [
          [s * 0.5, 1.54, 0.34],
          [s * 0.68, 1.5, 0.14],
          [s * 0.8, 1.38, 0.02]
        ],
        0.048,
        10,
        7,
        TINT_FRAME_DARK
      )
    );
    frame.push(
      ...buildLouverBank(0.26, 0.44, 0.1, 5, [s * 0.48, 1.24, 0.72], [0.06, s * -0.1, 0], TINT_FRAME_MID)
    );
    vent.push(
      buildChamferBox(0.22, 0.42, 0.05, 8e-3, {
        pos: [s * 0.48, 1.24, 0.69],
        rot: [0.06, s * -0.1, 0],
        tint: TINT_CORE_HOT,
        band: UV_BAND_MECH
      }),
      buildCylinder(0.09, 0.11, 0.07, 10, {
        pos: [s * 0.46, 0.62, 0.58],
        rot: [0.26, 0, s * -0.06],
        tint: TINT_CORE_HOT,
        band: UV_BAND_ENERGY
      })
    );
  }
  core.push(
    // Front deeply recessed inner reactor turbine drum (behind armored cage bars!)
    buildCylinder(0.2, 0.2, 0.12, 14, {
      pos: [0, 0, -0.45],
      rot: [Math.PI * 0.5, 0, 0],
      tint: TINT_CORE_HOT,
      band: UV_BAND_ENERGY
    }),
    // Rear deeply recessed dorsal reactor turbine drum (matches back-core weakpoint!)
    buildCylinder(0.19, 0.19, 0.12, 14, {
      pos: [0, 0.02, 0.6],
      rot: [Math.PI * 0.5, 0, 0],
      tint: TINT_CORE_HOT,
      band: UV_BAND_ENERGY
    })
  );
  return {
    armor: mergeStrict(armor),
    frame: mergeStrict(frame),
    core: mergeStrict(core),
    vent: mergeStrict(vent)
  };
}
function buildHeadParts() {
  const armor = [];
  const frame = [];
  frame.push(
    buildCylinder(0.13, 0.16, 0.2, 10, { pos: [0, 0.04, 0.02], tint: TINT_FRAME_DARK }),
    ...buildHydraulicPiston([-0.12, -0.04, -0.02], [-0.13, 0.15, -0.06], 0.028, 0.016, TINT_PISTON_CHROME),
    ...buildHydraulicPiston([0.12, -0.04, -0.02], [0.13, 0.15, -0.06], 0.028, 0.016, TINT_PISTON_CHROME)
  );
  frame.push(
    buildCylinder(0.185, 0.185, 0.12, 14, { pos: [0, 0.26, -0.03], tint: [0.05, 0.06, 0.08] }),
    // Thin vertical center visor pillar framing the cyclops bay
    buildChamferBox(0.036, 0.12, 0.06, 6e-3, { pos: [0, 0.14, -0.21], tint: TINT_FRAME_MID })
  );
  armor.push(
    // Sloped titanium top helmet dome angled forward-down over visor slit
    buildArmoredFrustum(0.44, 0.48, 0.34, 0.4, 0.18, -0.04, 0, {
      pos: [0, 0.4, -0.01],
      rot: [0.14, 0, 0],
      tint: TINT_ARMOR_LIGHT
    }),
    // Sharp angled V-brow crimson visor wings (menacing heavy combat mech scowl!)
    buildChamferBox(0.22, 0.075, 0.2, 0.012, {
      pos: [-0.11, 0.345, -0.17],
      rot: [0.22, 0.1, -0.16],
      tint: TINT_ARMOR_CRIMSON
    }),
    buildChamferBox(0.22, 0.075, 0.2, 0.012, {
      pos: [0.11, 0.345, -0.17],
      rot: [0.22, -0.1, 0.16],
      tint: TINT_ARMOR_CRIMSON
    }),
    // Rear heavy helmet occiput armor shell
    buildArmoredFrustum(0.42, 0.28, 0.36, 0.24, 0.28, 0.02, 0, {
      pos: [0, 0.26, 0.12],
      tint: TINT_ARMOR_MAIN
    }),
    // Angular armored lower jaw / muzzle breathing grille block
    buildArmoredFrustum(0.3, 0.28, 0.36, 0.32, 0.15, -0.04, 0, {
      pos: [0, 0.12, -0.09],
      tint: TINT_ARMOR_MAIN
    }),
    buildChamferBox(0.18, 0.085, 0.14, 0.014, { pos: [0, 0.11, -0.22], tint: TINT_ARMOR_LIGHT }),
    // Swept-back tactical commander sensor crest fin reaching local y = +0.62 (world y = 4.10m!)
    buildSlopedPlate(
      [
        [-0.2, 0],
        [0.14, 0],
        [0.2, 0.15],
        [-0.08, 0.18]
      ],
      0.08,
      0.014,
      {
        pos: [0, 0.44, 0.04],
        rot: [0, Math.PI * 0.5, 0],
        tint: TINT_ARMOR_CRIMSON
      }
    )
  );
  for (const s of [-1, 1]) {
    armor.push(
      buildChamferBox(0.1, 0.22, 0.36, 0.018, {
        pos: [s * 0.21, 0.22, -0.02],
        rot: [0.06, s * -0.14, s * 0.1],
        tint: TINT_ARMOR_MAIN
      })
    );
    frame.push(
      buildCylinder(0.072, 0.072, 0.1, 10, {
        pos: [s * 0.25, 0.26, 0.04],
        rot: [0, 0, Math.PI * 0.5],
        tint: TINT_FRAME_MID
      }),
      ...s === 1 ? [
        buildCylinder(0.014, 0.022, 0.22, 6, {
          pos: [0.25, 0.42, 0.08],
          rot: [-0.18, 0, -0.08],
          tint: TINT_FRAME_MID
        })
      ] : []
    );
  }
  const lensSphere = new THREE.SphereGeometry(0.052, 12, 10);
  lensSphere.scale(1, 0.94, 0.62);
  lensSphere.translate(0, 0, -0.194);
  const monoEye = mergeStrict([
    finalizePart(lensSphere, { faceted: false, band: UV_BAND_ENERGY, tint: [1, 1, 1] }),
    // Tight precision laser-rangefinder optical slit flanking the cyclops lens
    buildChamferBox(0.15, 0.02, 0.028, 4e-3, {
      pos: [0, 0, -0.182],
      tint: [0.78, 0.78, 0.78],
      band: UV_BAND_ENERGY
    })
  ]);
  const monoEyeBezel = buildCylinder(0.068, 0.072, 0.045, 12, {
    pos: [0, 0, -0.184],
    rot: [Math.PI * 0.5, 0, 0],
    tint: TINT_FRAME_MID
  });
  return {
    armor: mergeStrict(armor),
    frame: mergeStrict(frame),
    monoEye,
    monoEyeBezel
  };
}
function buildShoulderPauldron(side) {
  const armor = [];
  const frame = [];
  const vent = [];
  frame.push(
    buildCylinder(0.2, 0.2, 0.28, 12, {
      pos: [side * 0.04, 0, 0],
      rot: [0, 0, Math.PI * 0.5],
      tint: TINT_FRAME_DARK
    }),
    buildChamferBox(0.36, 0.2, 0.52, 0.02, {
      pos: [side * 0.14, 0.16, 0],
      rot: [0, 0, side * -0.18],
      tint: TINT_FRAME_MID
    })
  );
  if (side === -1) {
    armor.push(
      // Sweeping deep-gunmetal armored shoulder hood wrapping seamlessly over shoulder drum
      buildArmoredFrustum(0.58, 0.8, 0.46, 0.66, 0.46, 0, -0.06, {
        pos: [-0.14, 0.18, 0],
        rot: [0, 0, 0.2],
        tint: TINT_ARMOR_MAIN
      }),
      // Cold titanium upper armored cap
      buildChamferBox(0.44, 0.14, 0.64, 0.026, {
        pos: [-0.14, 0.4, 0],
        rot: [0, 0, 0.26],
        tint: TINT_ARMOR_LIGHT
      }),
      // Tall angled fortress buckler riot-shield slab bolted tightly to outer pauldron
      buildSlopedPlate(
        [
          [-0.38, -0.44],
          [0.38, -0.44],
          [0.3, 0.48],
          [-0.3, 0.48]
        ],
        0.15,
        0.026,
        {
          pos: [-0.42, 0.02, 0],
          rot: [0, Math.PI * 0.5, 0.14],
          tint: TINT_ARMOR_LIGHT
        }
      ),
      // Matte crimson-oxide command stripe boss down center of shield
      buildChamferBox(0.09, 0.56, 0.3, 0.018, {
        pos: [-0.49, 0.04, 0],
        rot: [0, 0, 0.14],
        tint: TINT_ARMOR_CRIMSON
      }),
      // Bolted ERA reactive dark gunmetal edge guards
      buildChamferBox(0.09, 0.2, 0.52, 0.016, {
        pos: [-0.48, 0.34, 0],
        rot: [0, 0, 0.14],
        tint: TINT_ARMOR_DARK
      }),
      // Caution hazard band across lower shield lip
      buildChamferBox(0.09, 0.12, 0.6, 0.012, {
        pos: [-0.47, -0.28, 0],
        rot: [0, 0, 0.14],
        tint: TINT_HAZARD,
        band: UV_BAND_HAZARD,
        uvScale: 1
      })
    );
    frame.push(
      buildChamferBox(0.24, 0.12, 0.18, 0.014, { pos: [-0.3, 0.16, -0.18], tint: TINT_FRAME_MID }),
      buildChamferBox(0.24, 0.12, 0.18, 0.014, { pos: [-0.3, 0.16, 0.18], tint: TINT_FRAME_MID }),
      ...buildLouverBank(0.24, 0.18, 0.08, 3, [-0.18, 0.2, -0.38], [0, 0, 0.2], TINT_FRAME_MID),
      ...buildLouverBank(0.24, 0.18, 0.08, 3, [-0.18, 0.2, 0.38], [0, 0, 0.2], TINT_FRAME_MID)
    );
    vent.push(
      buildChamferBox(0.2, 0.14, 0.05, 8e-3, { pos: [-0.18, 0.2, -0.35], rot: [0, 0, 0.2], tint: TINT_CORE_HOT, band: UV_BAND_MECH }),
      buildChamferBox(0.2, 0.14, 0.05, 8e-3, { pos: [-0.18, 0.2, 0.35], rot: [0, 0, 0.2], tint: TINT_CORE_HOT, band: UV_BAND_MECH })
    );
  } else {
    armor.push(
      buildArmoredFrustum(0.6, 0.76, 0.46, 0.62, 0.42, 0, 0.08, {
        pos: [0.14, 0.16, 0],
        rot: [0, 0, -0.24],
        tint: TINT_ARMOR_MAIN
      }),
      // Swept crimson-oxide upper vanguard ridge
      buildChamferBox(0.46, 0.14, 0.58, 0.024, {
        pos: [0.18, 0.37, 0],
        rot: [0, 0, -0.3],
        tint: TINT_ARMOR_CRIMSON
      }),
      // Angled titanium outer shoulder winglet fairing (clear of high blade arc!)
      buildSlopedPlate(
        [
          [-0.3, -0.26],
          [0.3, -0.26],
          [0.24, 0.26],
          [-0.24, 0.26]
        ],
        0.14,
        0.024,
        {
          pos: [0.42, 0, 0],
          rot: [0, Math.PI * 0.5, -0.4],
          tint: TINT_ARMOR_LIGHT
        }
      ),
      buildChamferBox(0.28, 0.1, 0.52, 0.012, {
        pos: [0.4, 0.2, 0],
        rot: [0, 0, -0.32],
        tint: TINT_HAZARD,
        band: UV_BAND_HAZARD,
        uvScale: 0.9
      })
    );
    frame.push(
      ...buildHydraulicPiston([0.04, 0.32, -0.22], [0.4, 0.12, -0.24], 0.042, 0.024, TINT_PISTON_BRASS),
      ...buildHydraulicPiston([0.04, 0.32, 0.22], [0.4, 0.12, 0.24], 0.042, 0.024, TINT_PISTON_BRASS),
      ...buildLouverBank(0.22, 0.16, 0.08, 3, [0.18, 0.18, -0.36], [0, 0, -0.24], TINT_FRAME_MID),
      ...buildLouverBank(0.22, 0.16, 0.08, 3, [0.18, 0.18, 0.36], [0, 0, -0.24], TINT_FRAME_MID)
    );
    vent.push(
      buildChamferBox(0.2, 0.13, 0.05, 8e-3, { pos: [0.18, 0.18, -0.33], rot: [0, 0, -0.24], tint: TINT_CORE_HOT, band: UV_BAND_MECH }),
      buildChamferBox(0.2, 0.13, 0.05, 8e-3, { pos: [0.18, 0.18, 0.33], rot: [0, 0, -0.24], tint: TINT_CORE_HOT, band: UV_BAND_MECH })
    );
  }
  return {
    armor: mergeStrict(armor),
    frame: mergeStrict(frame),
    vent: mergeStrict(vent)
  };
}
function buildUpperArmParts(side) {
  const armor = [];
  const frame = [];
  frame.push(
    buildCylinder(0.145, 0.135, 0.78, 12, { pos: [side * 0.05, -0.39, 0], tint: TINT_FRAME_DARK }),
    ...buildHydraulicPiston(
      [side * 0.04, -0.06, -0.16],
      [side * 0.08, -0.7, -0.14],
      0.048,
      0.028,
      TINT_PISTON_CHROME
    ),
    ...buildHydraulicPiston(
      [side * 0.04, -0.08, 0.16],
      [side * 0.08, -0.7, 0.14],
      0.044,
      0.026,
      TINT_PISTON_BRASS
    ),
    buildCylinder(0.17, 0.17, 0.36, 12, {
      pos: [side * 0.08, -0.78, 0],
      rot: [0, 0, Math.PI * 0.5],
      tint: TINT_FRAME_MID
    })
  );
  armor.push(
    buildArmoredFrustum(0.32, 0.34, 0.38, 0.38, 0.48, 0, 0, {
      pos: [side * 0.08, -0.38, 0],
      tint: TINT_ARMOR_MAIN
    }),
    buildChamferBox(0.1, 0.42, 0.24, 0.018, {
      pos: [side * 0.25, -0.38, 0],
      tint: TINT_ARMOR_LIGHT
    })
  );
  return {
    armor: mergeStrict(armor),
    frame: mergeStrict(frame)
  };
}
function buildLeftForearmParts() {
  const armor = [];
  const frame = [];
  const vent = [];
  frame.push(
    buildCylinder(0.13, 0.15, 0.72, 12, { pos: [0, -0.36, 0], tint: TINT_FRAME_DARK }),
    ...buildHydraulicPiston([-0.14, -0.06, -0.12], [-0.16, -0.68, -0.14], 0.046, 0.026, TINT_PISTON_CHROME),
    ...buildHydraulicPiston([0.1, -0.06, 0.12], [0.12, -0.68, 0.12], 0.042, 0.024, TINT_PISTON_BRASS),
    buildCylinder(0.15, 0.15, 0.12, 12, { pos: [0, -0.76, 0], tint: TINT_FRAME_MID })
  );
  armor.push(
    buildChamferBox(0.34, 0.24, 0.3, 0.024, { pos: [-0.02, -0.08, 0.14], rot: [0.22, 0, 0], tint: TINT_ARMOR_DARK }),
    buildArmoredFrustum(0.42, 0.44, 0.36, 0.38, 0.66, 0, 0, { pos: [-0.02, -0.4, 0], tint: TINT_ARMOR_MAIN }),
    // Heavy outer forearm buckler ram-shield
    buildSlopedPlate(
      [
        [-0.24, -0.44],
        [0.24, -0.36],
        [0.24, 0.34],
        [-0.22, 0.42]
      ],
      0.12,
      0.022,
      {
        pos: [-0.24, -0.42, -0.04],
        rot: [0, Math.PI * 0.5, 0],
        tint: TINT_ARMOR_LIGHT
      }
    ),
    buildChamferBox(0.08, 0.42, 0.18, 0.014, { pos: [-0.3, -0.42, -0.04], tint: TINT_ARMOR_CRIMSON }),
    buildChamferBox(0.42, 0.11, 0.46, 0.014, {
      pos: [-0.02, -0.66, 0],
      tint: TINT_HAZARD,
      band: UV_BAND_HAZARD,
      uvScale: 0.9
    })
  );
  vent.push(
    buildChamferBox(0.06, 0.26, 0.16, 8e-3, {
      pos: [-0.19, -0.34, 0.14],
      tint: TINT_CORE_HOT,
      band: UV_BAND_MECH
    })
  );
  armor.push(
    buildChamferBox(0.28, 0.22, 0.34, 0.022, { pos: [0, -0.88, -0.02], tint: TINT_ARMOR_MAIN }),
    buildChamferBox(0.32, 0.1, 0.38, 0.016, { pos: [-0.02, -0.96, -0.04], tint: TINT_ARMOR_LIGHT })
  );
  for (let i = 0; i < 3; i++) {
    const fz = -0.12 + i * 0.11;
    frame.push(
      buildChamferBox(0.09, 0.16, 0.085, 0.012, { pos: [-0.09, -1.04, fz], rot: [0, 0, 0.22], tint: TINT_FRAME_MID }),
      buildChamferBox(0.085, 0.14, 0.08, 0.01, { pos: [-0.02, -1.14, fz], rot: [0, 0, 0.85], tint: TINT_FRAME_DARK })
    );
  }
  frame.push(
    buildChamferBox(0.11, 0.15, 0.1, 0.014, { pos: [0.11, -0.96, -0.16], rot: [0.3, 0, -0.45], tint: TINT_FRAME_MID }),
    buildChamferBox(0.09, 0.12, 0.09, 0.01, { pos: [0.06, -1.06, -0.2], rot: [0.45, 0, -0.95], tint: TINT_FRAME_DARK })
  );
  return {
    armor: mergeStrict(armor),
    frame: mergeStrict(frame),
    vent: mergeStrict(vent)
  };
}
function buildRightForearmAndBladeParts() {
  const armor = [];
  const frame = [];
  const vent = [];
  frame.push(
    buildCylinder(0.14, 0.16, 0.78, 12, { pos: [0, -0.39, 0], tint: TINT_FRAME_DARK }),
    ...buildHydraulicPiston([0.16, -0.06, 0.12], [0.18, -0.74, 0.12], 0.048, 0.028, TINT_PISTON_BRASS),
    ...buildHydraulicPiston([-0.12, -0.08, -0.1], [-0.14, -0.72, -0.12], 0.044, 0.026, TINT_PISTON_CHROME),
    buildArmoredConduit(
      [
        [0.14, -0.04, 0.16],
        [0.24, -0.26, 0.18],
        [0.22, -0.52, 0.02],
        [0.16, -0.72, -0.16]
      ],
      0.038,
      10,
      7,
      TINT_FRAME_DARK
    )
  );
  armor.push(
    buildChamferBox(0.36, 0.28, 0.34, 0.026, { pos: [0.02, -0.08, 0.14], rot: [0.2, 0, 0], tint: TINT_ARMOR_DARK }),
    buildArmoredFrustum(0.44, 0.48, 0.38, 0.4, 0.74, -0.02, 0, { pos: [0.02, -0.42, -0.02], tint: TINT_ARMOR_MAIN }),
    // Sleek crimson-oxide + titanium emitter cowling plates
    buildChamferBox(0.13, 0.64, 0.36, 0.022, { pos: [0.22, -0.44, -0.04], tint: TINT_ARMOR_CRIMSON }),
    buildChamferBox(0.28, 0.48, 0.1, 0.018, { pos: [0.02, -0.36, -0.25], tint: TINT_ARMOR_LIGHT }),
    buildChamferBox(0.44, 0.11, 0.5, 0.014, {
      pos: [0.02, -0.73, -0.04],
      tint: TINT_HAZARD,
      band: UV_BAND_HAZARD,
      uvScale: 0.9
    })
  );
  frame.push(
    ...buildLouverBank(0.08, 0.34, 0.18, 5, [0.24, -0.42, 0.12], [0, 0, 0], TINT_FRAME_MID)
  );
  vent.push(
    buildChamferBox(0.06, 0.34, 0.16, 8e-3, { pos: [0.2, -0.42, 0.12], tint: TINT_CORE_HOT, band: UV_BAND_MECH }),
    buildChamferBox(0.2, 0.14, 0.06, 8e-3, { pos: [0.02, -0.58, -0.24], tint: TINT_CORE_HOT, band: UV_BAND_ENERGY })
  );
  const spineParts = [
    // Tapered emitter muzzle housing clamping the plasma blade root
    buildChamferBox(0.24, 0.24, 0.3, 0.022, { pos: [0, -0.04, 0.02], tint: TINT_ARMOR_DARK }),
    // Forward & rear angular emitter focus prongs
    buildChamferBox(0.14, 0.3, 0.09, 0.014, { pos: [0, -0.22, 0.1], tint: TINT_ARMOR_LIGHT }),
    buildChamferBox(0.12, 0.2, 0.08, 0.012, { pos: [0, -0.16, -0.12], tint: TINT_ARMOR_CRIMSON }),
    // Sleek notched dark-gunmetal mechanical blade spine extending cleanly down back edge
    buildChamferBox(0.056, 1.24, 0.075, 0.01, { pos: [0, -0.66, 0.06], tint: TINT_ARMOR_MAIN }),
    // 4 sharp cooling fin teeth along mechanical blade spine
    buildChamferBox(0.082, 0.1, 0.05, 8e-3, { pos: [0, -0.4, 0.1], tint: TINT_ARMOR_LIGHT }),
    buildChamferBox(0.082, 0.1, 0.05, 8e-3, { pos: [0, -0.64, 0.1], tint: TINT_ARMOR_LIGHT }),
    buildChamferBox(0.078, 0.1, 0.05, 8e-3, { pos: [0, -0.88, 0.1], tint: TINT_ARMOR_LIGHT }),
    buildChamferBox(0.07, 0.09, 0.04, 7e-3, { pos: [0, -1.1, 0.09], tint: TINT_ARMOR_LIGHT }),
    // Twin slim machined brass plasma containment rails flanking blade spine
    buildCylinder(0.013, 0.01, 1.02, 8, { pos: [0.036, -0.58, 0.02], tint: TINT_PISTON_BRASS }),
    buildCylinder(0.013, 0.01, 1.02, 8, { pos: [-0.036, -0.58, 0.02], tint: TINT_PISTON_BRASS })
  ];
  const bladePlasma = buildPlasmaBladeGeometry(1.54, 0.21, 0.03);
  return {
    armor: mergeStrict(armor),
    frame: mergeStrict(frame),
    vent: mergeStrict(vent),
    bladeSpine: mergeStrict(spineParts),
    bladePlasma
  };
}
function buildPelvisParts() {
  const armor = [];
  const frame = [];
  frame.push(
    buildCylinder(0.17, 0.17, 1.12, 12, {
      pos: [0, -0.04, 0],
      rot: [0, 0, Math.PI * 0.5],
      tint: TINT_FRAME_DARK
    }),
    buildChamferBox(0.72, 0.28, 0.52, 0.024, { pos: [0, 0.04, 0], tint: TINT_FRAME_DARK })
  );
  armor.push(
    buildArmoredFrustum(0.32, 0.38, 0.44, 0.48, 0.44, -0.06, 0, { pos: [0, -0.04, -0.14], tint: TINT_ARMOR_MAIN }),
    buildChamferBox(0.28, 0.26, 0.14, 0.022, { pos: [0, 0.02, -0.36], rot: [0.18, 0, 0], tint: TINT_ARMOR_LIGHT }),
    buildChamferBox(0.22, 0.08, 0.1, 0.01, {
      pos: [0, -0.16, -0.35],
      rot: [0.18, 0, 0],
      tint: TINT_HAZARD,
      band: UV_BAND_HAZARD,
      uvScale: 0.7
    }),
    // Rear heavy armored bustle bumper (pure hard-surface mech, zero tail)
    buildArmoredFrustum(0.46, 0.34, 0.58, 0.38, 0.36, 0.06, 0, { pos: [0, 0.02, 0.26], tint: TINT_ARMOR_DARK }),
    buildChamferBox(0.4, 0.14, 0.14, 0.02, { pos: [0, 0.1, 0.44], rot: [-0.16, 0, 0], tint: TINT_ARMOR_LIGHT })
  );
  for (const s of [-1, 1]) {
    armor.push(
      buildSlopedPlate(
        [
          [-0.17, -0.18],
          [0.17, -0.14],
          [0.16, 0.18],
          [-0.16, 0.18]
        ],
        0.1,
        0.018,
        {
          pos: [s * 0.42, -0.01, -0.39],
          rot: [-0.36, s * 0.2, s * -0.12],
          tint: TINT_ARMOR_MAIN
        }
      ),
      buildChamferBox(0.14, 0.4, 0.52, 0.022, {
        pos: [s * 0.64, -0.01, 0.02],
        rot: [0, 0, s * -0.22],
        tint: TINT_ARMOR_TRIM
      }),
      buildChamferBox(0.32, 0.36, 0.11, 0.02, {
        pos: [s * 0.38, -0.04, 0.37],
        rot: [0.24, s * -0.14, s * -0.08],
        tint: TINT_ARMOR_MAIN
      })
    );
  }
  return {
    armor: mergeStrict(armor),
    frame: mergeStrict(frame)
  };
}
function buildThighParts(side) {
  const armor = [];
  const frame = [];
  frame.push(
    buildCylinder(0.16, 0.15, 0.86, 12, { pos: [0, -0.44, 0], tint: TINT_FRAME_DARK }),
    ...buildHydraulicPiston([0, -0.06, -0.22], [0, -0.8, -0.2], 0.054, 0.03, TINT_PISTON_CHROME),
    ...buildHydraulicPiston([0, -0.08, 0.22], [0, -0.8, 0.2], 0.052, 0.03, TINT_PISTON_BRASS),
    // Prominent rotary knee hub drum
    buildCylinder(0.19, 0.19, 0.46, 14, {
      pos: [0, -THIGH_LEN, 0],
      rot: [0, 0, Math.PI * 0.5],
      tint: TINT_FRAME_MID
    }),
    buildCylinder(0.11, 0.12, 0.52, 10, {
      pos: [0, -THIGH_LEN, 0],
      rot: [0, 0, Math.PI * 0.5],
      tint: TINT_PISTON_BRASS
    })
  );
  armor.push(
    buildArmoredFrustum(0.36, 0.38, 0.48, 0.5, 0.72, -0.05, side * 0.04, {
      pos: [0, -0.42, -0.02],
      tint: TINT_ARMOR_MAIN
    }),
    // High-contrast cold titanium sloped front thigh glacis
    buildChamferBox(0.3, 0.54, 0.14, 0.024, {
      pos: [0, -0.42, -0.25],
      rot: [-0.1, 0, 0],
      tint: TINT_ARMOR_LIGHT
    }),
    // Outer armored thigh shield plate with crimson trim stripe
    buildChamferBox(0.14, 0.6, 0.42, 0.024, {
      pos: [side * 0.24, -0.44, 0.02],
      rot: [0, 0, side * -0.1],
      tint: TINT_ARMOR_TRIM
    }),
    buildChamferBox(0.08, 0.32, 0.22, 0.014, {
      pos: [side * 0.29, -0.34, 0.02],
      rot: [0, 0, side * -0.1],
      tint: TINT_ARMOR_CRIMSON
    }),
    buildChamferBox(0.34, 0.56, 0.14, 0.022, {
      pos: [0, -0.42, 0.22],
      tint: TINT_ARMOR_DARK
    })
  );
  return {
    armor: mergeStrict(armor),
    frame: mergeStrict(frame)
  };
}
function buildShinParts(side) {
  const armor = [];
  const frame = [];
  const vent = [];
  frame.push(
    buildCylinder(0.15, 0.14, 0.78, 12, { pos: [0, -0.4, 0.02], tint: TINT_FRAME_DARK }),
    ...buildHydraulicPiston([side * 0.24, -0.04, 0.04], [side * 0.27, -0.74, 0.02], 0.05, 0.028, TINT_PISTON_CHROME),
    ...buildHydraulicPiston([0, -0.1, 0.28], [0, -0.76, 0.22], 0.058, 0.034, TINT_PISTON_BRASS),
    buildCylinder(0.155, 0.155, 0.44, 12, {
      pos: [0, -SHIN_LEN, 0],
      rot: [0, 0, Math.PI * 0.5],
      tint: TINT_FRAME_MID
    })
  );
  armor.push(
    buildSlopedPlate(
      [
        [-0.2, -0.2],
        [0.2, -0.2],
        [0.26, 0.08],
        [0.14, 0.28],
        [-0.14, 0.28],
        [-0.26, 0.08]
      ],
      0.16,
      0.026,
      {
        pos: [0, 0.04, -0.28],
        rot: [0.16, 0, 0],
        tint: TINT_ARMOR_LIGHT
      }
    ),
    buildChamferBox(0.22, 0.16, 0.1, 0.016, { pos: [0, 0.06, -0.36], rot: [0.16, 0, 0], tint: TINT_ARMOR_CRIMSON })
  );
  armor.push(
    buildArmoredFrustum(0.54, 0.54, 0.36, 0.38, 0.66, 0.06, side * -0.04, {
      pos: [0, -0.45, -0.03],
      tint: TINT_ARMOR_MAIN
    }),
    // Sloped forward titanium shin glacis apron
    buildSlopedPlate(
      [
        [-0.22, -0.28],
        [0.22, -0.28],
        [0.15, 0.28],
        [-0.15, 0.28]
      ],
      0.14,
      0.024,
      {
        pos: [0, -0.44, -0.26],
        rot: [0.14, 0, 0],
        tint: TINT_ARMOR_LIGHT
      }
    ),
    // Weathered hazard band across flared ankle cuff
    buildChamferBox(0.52, 0.1, 0.52, 0.014, {
      pos: [0, -0.68, -0.04],
      tint: TINT_HAZARD,
      band: UV_BAND_HAZARD,
      uvScale: 1
    }),
    // Angled outer calf thruster housing
    buildChamferBox(0.14, 0.46, 0.38, 0.022, {
      pos: [side * 0.28, -0.42, 0.1],
      rot: [0, 0, side * -0.14],
      tint: TINT_ARMOR_TRIM
    }),
    // Heavy rear calf armored bumper shroud
    buildChamferBox(0.38, 0.44, 0.16, 0.022, {
      pos: [0, -0.38, 0.28],
      rot: [-0.14, 0, 0],
      tint: TINT_ARMOR_DARK
    })
  );
  frame.push(
    ...buildLouverBank(0.24, 0.22, 0.07, 4, [0, -0.36, 0.36], [-0.14, 0, 0], TINT_FRAME_MID)
  );
  vent.push(
    buildChamferBox(0.2, 0.2, 0.05, 8e-3, {
      pos: [0, -0.36, 0.34],
      rot: [-0.14, 0, 0],
      tint: TINT_CORE_HOT,
      band: UV_BAND_MECH
    })
  );
  return {
    armor: mergeStrict(armor),
    frame: mergeStrict(frame),
    vent: mergeStrict(vent)
  };
}
function buildFootParts(side) {
  const armor = [];
  const frame = [];
  frame.push(
    buildChamferBox(0.54, 0.08, 0.78, 0.012, { pos: [0, FOOT_SOLE_Y + 0.04, -0.08], tint: TINT_FRAME_DARK }),
    ...buildHydraulicPiston([-0.15, 0.02, -0.14], [-0.17, -0.14, -0.34], 0.038, 0.022, TINT_PISTON_CHROME),
    ...buildHydraulicPiston([0.15, 0.02, -0.14], [0.17, -0.14, -0.34], 0.038, 0.022, TINT_PISTON_CHROME),
    ...buildHydraulicPiston([0, 0.02, 0.16], [0, -0.14, 0.28], 0.042, 0.024, TINT_PISTON_BRASS)
  );
  armor.push(
    buildChamferBox(0.48, 0.14, 0.46, 0.022, { pos: [0, FOOT_SOLE_Y + 0.14, -0.06], rot: [0.14, 0, 0], tint: TINT_ARMOR_MAIN }),
    // Twin wide armored mechanical front toe-clamps (strictly flush at y = -0.24!)
    buildChamferBox(0.24, 0.13, 0.38, 0.02, { pos: [-0.15, FOOT_SOLE_Y + 0.065, -0.34], tint: TINT_ARMOR_LIGHT }),
    buildChamferBox(0.24, 0.13, 0.38, 0.02, { pos: [0.15, FOOT_SOLE_Y + 0.065, -0.34], tint: TINT_ARMOR_LIGHT }),
    // Heavy rear armored heel anchor spur (strictly flush at y = -0.24!)
    buildChamferBox(0.4, 0.14, 0.26, 0.02, { pos: [0, FOOT_SOLE_Y + 0.07, 0.26], tint: TINT_ARMOR_DARK }),
    // Outer ankle armored fender guard
    buildChamferBox(0.11, 0.18, 0.36, 0.016, { pos: [side * 0.27, FOOT_SOLE_Y + 0.16, -0.04], tint: TINT_ARMOR_TRIM })
  );
  return {
    armor: mergeStrict(armor),
    frame: mergeStrict(frame)
  };
}
function makeNeutralPose() {
  return {
    torso: [0, 0, 0],
    head: [0, 0, 0],
    leftShoulder: [0, 0, 0],
    rightShoulder: [0, 0, 0],
    leftArm: [0, 0, 0],
    elbowL: [0, 0, 0],
    rightArm: [0, 0, 0],
    elbowR: [0, 0, 0],
    hips: [0, 0, 0],
    thighL: [0, 0, 0],
    shinL: [0, 0, 0],
    footL: [0, 0, 0],
    thighR: [0, 0, 0],
    shinR: [0, 0, 0],
    footR: [0, 0, 0]
  };
}
var SEAM_EMISSIVE_P1 = new THREE.Color("#CC4610");
var SEAM_EMISSIVE_P2 = new THREE.Color("#FF7C1C");
var CORE_EMISSIVE_P1 = new THREE.Color("#FF5212");
var CORE_EMISSIVE_P2 = new THREE.Color("#FF9B2E");
var EYE_EMISSIVE_P1 = new THREE.Color("#FF280C");
var EYE_EMISSIVE_P2 = new THREE.Color("#FF6A1C");
var BLADE_EMISSIVE_P1 = new THREE.Color("#FF6016");
var BLADE_EMISSIVE_P2 = new THREE.Color("#FFB842");
function createBossModel() {
  const atlas = createMechAtlas();
  const ownedGeometries = [];
  const ownedMaterials = [];
  const trackGeo = (g) => {
    ownedGeometries.push(g);
    return g;
  };
  const trackMat = (m) => {
    ownedMaterials.push(m);
    return m;
  };
  const armorMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: new THREE.Color("#CFD6DF"),
      map: atlas.albedoMap,
      normalMap: atlas.normalMap,
      normalScale: new THREE.Vector2(0.85, 0.85),
      emissive: SEAM_EMISSIVE_P1.clone(),
      emissiveMap: atlas.emissiveMap,
      emissiveIntensity: 0.03,
      metalness: 0.72,
      roughness: 0.36,
      vertexColors: true
    })
  );
  const frameMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: new THREE.Color("#C8D0DA"),
      map: atlas.albedoMap,
      normalMap: atlas.normalMap,
      normalScale: new THREE.Vector2(0.8, 0.8),
      metalness: 0.88,
      roughness: 0.24,
      vertexColors: true
    })
  );
  const coreMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: new THREE.Color("#280E05"),
      map: atlas.albedoMap,
      emissive: CORE_EMISSIVE_P1.clone(),
      emissiveMap: atlas.emissiveMap,
      emissiveIntensity: 1.38,
      normalMap: atlas.normalMap,
      normalScale: new THREE.Vector2(0.75, 0.75),
      metalness: 0.25,
      roughness: 0.4,
      vertexColors: true
    })
  );
  const eyeMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: new THREE.Color("#2A0503"),
      emissive: EYE_EMISSIVE_P1.clone(),
      emissiveIntensity: 2.55,
      metalness: 0.12,
      roughness: 0.18
    })
  );
  const bladeMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: new THREE.Color("#381408"),
      map: atlas.albedoMap,
      emissive: BLADE_EMISSIVE_P1.clone(),
      emissiveMap: atlas.emissiveMap,
      emissiveIntensity: 1.65,
      metalness: 0.15,
      roughness: 0.22,
      vertexColors: true
    })
  );
  const makeMesh = (geo, mat, name, castShadow = true) => {
    const mesh = new THREE.Mesh(trackGeo(geo), mat);
    mesh.name = name;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    return mesh;
  };
  const root = new THREE.Group();
  root.name = "boss-root";
  const body = new THREE.Group();
  body.name = "boss-body";
  body.position.set(0, BASE_HIP_Y, 0);
  root.add(body);
  const torso = new THREE.Group();
  torso.name = "boss-torso";
  body.add(torso);
  const torsoParts = buildTorsoParts();
  torso.add(makeMesh(torsoParts.armor, armorMat, "boss-torso-armor"));
  torso.add(makeMesh(torsoParts.frame, frameMat, "boss-torso-frame"));
  const ventGlow = new THREE.Group();
  ventGlow.name = "boss-vent-glow";
  ventGlow.add(makeMesh(torsoParts.vent, coreMat, "boss-torso-vents", false));
  torso.add(ventGlow);
  const core = makeMesh(torsoParts.core, coreMat, "boss-core", false);
  core.position.set(0, 0.96, 0);
  torso.add(core);
  const head = new THREE.Group();
  head.name = "boss-head";
  head.position.set(0, 1.52, -0.12);
  torso.add(head);
  const headParts = buildHeadParts();
  head.add(makeMesh(headParts.armor, armorMat, "boss-head-armor"));
  head.add(makeMesh(headParts.frame, frameMat, "boss-head-frame"));
  const monoEye = new THREE.Group();
  monoEye.name = "boss-mono-eye";
  monoEye.position.set(0, 0.26, -0.03);
  monoEye.add(makeMesh(headParts.monoEyeBezel, frameMat, "boss-mono-eye-bezel", false));
  monoEye.add(makeMesh(headParts.monoEye, eyeMat, "boss-mono-eye-lens", false));
  head.add(monoEye);
  const leftShoulder = new THREE.Group();
  leftShoulder.name = "boss-pauldron-l";
  leftShoulder.position.set(-0.82, 1.28, 0);
  torso.add(leftShoulder);
  const pauldronL = buildShoulderPauldron(-1);
  leftShoulder.add(makeMesh(pauldronL.armor, armorMat, "boss-pauldron-armor-l"));
  leftShoulder.add(makeMesh(pauldronL.frame, frameMat, "boss-pauldron-frame-l"));
  leftShoulder.add(makeMesh(pauldronL.vent, coreMat, "boss-pauldron-vent-l", false));
  const rightShoulder = new THREE.Group();
  rightShoulder.name = "boss-pauldron-r";
  rightShoulder.position.set(0.82, 1.28, 0);
  torso.add(rightShoulder);
  const pauldronR = buildShoulderPauldron(1);
  rightShoulder.add(makeMesh(pauldronR.armor, armorMat, "boss-pauldron-armor-r"));
  rightShoulder.add(makeMesh(pauldronR.frame, frameMat, "boss-pauldron-frame-r"));
  rightShoulder.add(makeMesh(pauldronR.vent, coreMat, "boss-pauldron-vent-r", false));
  const leftArm = new THREE.Group();
  leftArm.name = "boss-shoulder-l";
  leftArm.position.set(-0.92, 1.28, 0);
  torso.add(leftArm);
  const upperArmL = buildUpperArmParts(-1);
  leftArm.add(makeMesh(upperArmL.armor, armorMat, "boss-upper-arm-armor-l"));
  leftArm.add(makeMesh(upperArmL.frame, frameMat, "boss-upper-arm-frame-l"));
  const elbowL = new THREE.Group();
  elbowL.name = "boss-elbow-l";
  elbowL.position.set(-0.08, -0.78, 0);
  elbowL.rotation.set(0.32, 0, 0);
  leftArm.add(elbowL);
  const foreArmL = buildLeftForearmParts();
  elbowL.add(makeMesh(foreArmL.armor, armorMat, "boss-forearm-armor-l"));
  elbowL.add(makeMesh(foreArmL.frame, frameMat, "boss-forearm-frame-l"));
  elbowL.add(makeMesh(foreArmL.vent, coreMat, "boss-forearm-vent-l", false));
  const rightArm = new THREE.Group();
  rightArm.name = "boss-shoulder-r";
  rightArm.position.set(0.92, 1.28, 0);
  torso.add(rightArm);
  const upperArmR = buildUpperArmParts(1);
  rightArm.add(makeMesh(upperArmR.armor, armorMat, "boss-upper-arm-armor-r"));
  rightArm.add(makeMesh(upperArmR.frame, frameMat, "boss-upper-arm-frame-r"));
  const elbowR = new THREE.Group();
  elbowR.name = "boss-elbow-r";
  elbowR.position.set(0.08, -0.78, 0);
  elbowR.rotation.set(0.38, 0, 0);
  rightArm.add(elbowR);
  const foreArmR = buildRightForearmAndBladeParts();
  elbowR.add(makeMesh(foreArmR.armor, armorMat, "boss-forearm-armor-r"));
  elbowR.add(makeMesh(foreArmR.frame, frameMat, "boss-forearm-frame-r"));
  elbowR.add(makeMesh(foreArmR.vent, coreMat, "boss-forearm-vent-r", false));
  const rightBlade = new THREE.Group();
  rightBlade.name = "boss-right-blade";
  rightBlade.position.set(0.04, -0.68, -0.06);
  rightBlade.rotation.set(0.34, 0, 0);
  rightBlade.add(makeMesh(foreArmR.bladeSpine, armorMat, "boss-blade-spine"));
  rightBlade.add(makeMesh(foreArmR.bladePlasma, bladeMat, "boss-blade-plasma", false));
  elbowR.add(rightBlade);
  const hips = new THREE.Group();
  hips.name = "boss-hips";
  body.add(hips);
  const pelvisParts = buildPelvisParts();
  hips.add(makeMesh(pelvisParts.armor, armorMat, "boss-pelvis-armor"));
  hips.add(makeMesh(pelvisParts.frame, frameMat, "boss-pelvis-frame"));
  const buildLegChain = (side, tag) => {
    const thigh = new THREE.Group();
    thigh.name = `boss-thigh-${tag}`;
    thigh.position.set(side * 0.5, -0.04, 0);
    hips.add(thigh);
    const thighParts = buildThighParts(side);
    thigh.add(makeMesh(thighParts.armor, armorMat, `boss-thigh-armor-${tag}`));
    thigh.add(makeMesh(thighParts.frame, frameMat, `boss-thigh-frame-${tag}`));
    const shin = new THREE.Group();
    shin.name = `boss-shin-${tag}`;
    shin.position.set(0, -THIGH_LEN, 0);
    thigh.add(shin);
    const shinParts = buildShinParts(side);
    shin.add(makeMesh(shinParts.armor, armorMat, `boss-shin-armor-${tag}`));
    shin.add(makeMesh(shinParts.frame, frameMat, `boss-shin-frame-${tag}`));
    shin.add(makeMesh(shinParts.vent, coreMat, `boss-shin-vent-${tag}`, false));
    const foot = new THREE.Group();
    foot.name = `boss-foot-${tag}`;
    foot.position.set(0, -SHIN_LEN, 0);
    shin.add(foot);
    const footParts = buildFootParts(side);
    foot.add(makeMesh(footParts.armor, armorMat, `boss-foot-armor-${tag}`));
    foot.add(makeMesh(footParts.frame, frameMat, `boss-foot-frame-${tag}`));
    return { thigh, shin, foot };
  };
  const legL = buildLegChain(-1, "l");
  const legR = buildLegChain(1, "r");
  root.updateMatrixWorld(true);
  const initBox = new THREE.Box3().setFromObject(root);
  const baseHipOffsetY = Number.isFinite(initBox.min.y) ? BASE_HIP_Y - initBox.min.y : BASE_HIP_Y;
  body.position.y = baseHipOffsetY;
  const jointNodes = {
    torso,
    head,
    leftShoulder,
    rightShoulder,
    leftArm,
    elbowL,
    rightArm,
    elbowR,
    hips,
    thighL: legL.thigh,
    shinL: legL.shin,
    footL: legL.foot,
    thighR: legR.thigh,
    shinR: legR.shin,
    footR: legR.foot
  };
  const jointKeys = Object.keys(jointNodes);
  const targetPose = makeNeutralPose();
  const tmpEuler = new THREE.Euler(0, 0, 0, "XYZ");
  const tmpQuat = new THREE.Quaternion();
  let elapsed = 0;
  let animElapsed = 0;
  let lastAnim = null;
  let overloadHeat = 0;
  let bodyDropCur = 0;
  let bladeSurgeCur = 0;
  let monoEyeYawCur = 0;
  let disposed = false;
  const setPose = (key, x, y, z) => {
    targetPose[key][0] = x;
    targetPose[key][1] = y;
    targetPose[key][2] = z;
  };
  const update = (dt, state) => {
    if (disposed) return;
    const step = Math.max(0, Math.min(dt, 0.25));
    const hpPct = clamp01(state.hpPct);
    const isOverload = hpPct <= 0.35;
    const heatTarget = isOverload ? 1 : state.phase === 2 ? 0.32 : 0;
    if (state.anim !== lastAnim) {
      lastAnim = state.anim;
      animElapsed = 0;
    }
    elapsed += step;
    animElapsed += step;
    const heatAlpha = step > 0 ? 1 - Math.exp(-6.5 * step) : 1;
    overloadHeat += (heatTarget - overloadHeat) * heatAlpha;
    let targetBodyDrop = 0;
    let slerpRate = 18;
    let targetBladeSurge = 0;
    let coreWarnMult = 1;
    let targetMonoEyeYaw = 0;
    setPose("hips", 0, 0, 0);
    setPose("thighL", 0.08, 0.11, 0.095);
    setPose("shinL", -0.14, 0, 0);
    setPose("footL", 0.06, 0.04, -0.095);
    setPose("thighR", -0.06, -0.11, -0.095);
    setPose("shinR", -0.1, 0, 0);
    setPose("footR", 0.16, -0.04, 0.095);
    const ventFlare = overloadHeat * 0.11;
    setPose("leftShoulder", 0, 0, ventFlare);
    setPose("rightShoulder", 0, 0, -ventFlare);
    if (state.anim === "idle") {
      const scanWave = steppedServoWave(elapsed * 0.32, 0.64);
      const hydroCycle = steppedServoWave(elapsed * 0.55 + 0.15, 0.52);
      const microServo = steppedServoWave(elapsed * 0.85, 0.72);
      targetBodyDrop = 0.018 * (0.5 + 0.5 * hydroCycle);
      targetMonoEyeYaw = scanWave * 0.36;
      setPose("hips", 0, scanWave * 0.02, 0);
      setPose("torso", -0.05 - 0.015 * hydroCycle, scanWave * 0.04, 0);
      setPose("head", 0.03, scanWave * 0.14, 0);
      setPose("leftShoulder", 0, 0, ventFlare + 0.02 * hydroCycle);
      setPose("rightShoulder", 0, 0, -ventFlare - 0.02 * hydroCycle);
      setPose("leftArm", 0.18 + microServo * 0.03, -0.08, 0.14);
      setPose("elbowL", 0.52 + hydroCycle * 0.04, 0, -0.06);
      setPose("rightArm", 0.18 - microServo * 0.04, 0.1, -0.22);
      setPose("elbowR", 0.5 + microServo * 0.05, 0, 0.08);
      slerpRate = 16;
    } else if (state.anim === "walk") {
      const walkFreq = 2.9 * (1 + overloadHeat * 0.14);
      const w = animElapsed * walkFreq + 0.35;
      const rawS = Math.sin(w);
      const s = Math.sign(rawS) * Math.pow(Math.abs(rawS), 0.78);
      const c = Math.cos(w);
      const impact = Math.pow(Math.max(0, -Math.cos(w * 2)), 3.2);
      const midLift = Math.max(0, Math.cos(w * 2)) * 0.018;
      targetBodyDrop = 0.115 * impact - midLift;
      setPose("hips", 0.05 * impact, -s * 0.11, s * 0.055);
      setPose("torso", -0.12 - 0.06 * impact, s * 0.16, -s * 0.07);
      setPose("head", 0.08 + 0.05 * impact, -s * 0.12, s * 0.03);
      targetMonoEyeYaw = -s * 0.08;
      setPose("leftShoulder", -s * 0.16 - 0.06 * impact, 0, ventFlare + 0.05 * impact);
      setPose("rightShoulder", s * 0.16 - 0.06 * impact, 0, -ventFlare - 0.05 * impact);
      const kneeLiftL = Math.pow(Math.max(0, -c), 0.75);
      const kneeLiftR = Math.pow(Math.max(0, c), 0.75);
      setPose("thighL", s * 0.48 + 0.06, 0.05, 0.07);
      setPose("shinL", -0.14 - kneeLiftL * 0.56 - impact * 0.14, 0, 0);
      setPose("footL", -s * 0.24 + 0.08 + impact * 0.08, 0, -0.07);
      setPose("thighR", -s * 0.48 + 0.06, -0.05, -0.07);
      setPose("shinR", -0.14 - kneeLiftR * 0.56 - impact * 0.14, 0, 0);
      setPose("footR", s * 0.24 + 0.08 + impact * 0.08, 0, 0.07);
      setPose("leftArm", -s * 0.44 + 0.18, -0.08, 0.18);
      setPose("elbowL", 0.52 + Math.max(0, -s) * 0.18, 0, -0.05);
      setPose("rightArm", s * 0.46 + 0.16, 0.08, -0.24);
      setPose("elbowR", 0.46 + Math.max(0, s) * 0.18, 0, 0.06);
      slerpRate = 20;
    } else if (state.anim === "windup") {
      const cock = mechSnap(animElapsed / 0.28, 3);
      const clampShudder = animElapsed > 0.28 ? Math.sin(animElapsed * 44) * 8e-3 : 0;
      coreWarnMult = 1.44;
      targetBladeSurge = 0.76 * cock;
      targetBodyDrop = 0.048 * cock;
      targetMonoEyeYaw = 0.16 * cock;
      setPose("hips", 0.06 * cock, -0.18 * cock, 0.04 * cock);
      setPose("torso", 0.24 * cock, -0.38 * cock, 0.08 * cock);
      setPose("head", -0.14 * cock, 0.32 * cock, -0.04 * cock);
      setPose("leftShoulder", 0.16 * cock, 0, ventFlare + 0.08 * cock);
      setPose("rightShoulder", -0.26 * cock, 0, -ventFlare - 0.18 * cock);
      setPose("leftArm", lerp(0.18, 0.64, cock), -0.18 * cock, lerp(0.14, 0.32, cock));
      setPose("elbowL", lerp(0.52, 0.86, cock), 0, -0.1);
      setPose("rightArm", lerp(0.18, -1.58, cock) + clampShudder, 0.26 * cock, lerp(-0.22, -0.78, cock));
      setPose("elbowR", lerp(0.5, 0.96, cock), 0, 0.18 * cock);
      setPose("thighL", 0.26 * cock + 0.08, 0.1, 0.075);
      setPose("shinL", -0.38 * cock - 0.12, 0, 0);
      setPose("footL", 0.12 * cock + 0.04, 0, -0.075);
      setPose("thighR", -0.22 * cock - 0.06, -0.1, -0.075);
      setPose("shinR", -0.24 * cock - 0.1, 0, 0);
      setPose("footR", 0.36 * cock + 0.12, 0, 0.075);
      slerpRate = 24;
    } else if (state.anim === "attack") {
      const inLock = animElapsed < ATTACK_LOCK_SEC;
      const sweepU = inLock ? 0 : mechSnap((animElapsed - ATTACK_LOCK_SEC) / ATTACK_SWEEP_SEC, 3.8);
      const lockTremor = inLock ? Math.sin(animElapsed * 95) * 0.01 : 0;
      coreWarnMult = inLock ? 1.65 : lerp(1.6, 1.2, sweepU);
      targetBladeSurge = inLock ? 1 : lerp(1, 0.78, sweepU);
      targetBodyDrop = inLock ? 0.055 : lerp(0.055, 0.13, sweepU);
      targetMonoEyeYaw = lerp(0.16, -0.22, sweepU);
      setPose("hips", lerp(0.06, -0.1, sweepU), lerp(-0.18, 0.28, sweepU), lerp(0.04, -0.06, sweepU));
      setPose("torso", lerp(0.25, -0.34, sweepU), lerp(-0.38, 0.48, sweepU), lerp(0.08, -0.11, sweepU));
      setPose("head", lerp(-0.14, 0.24, sweepU), lerp(0.32, -0.38, sweepU), lerp(-0.04, 0.06, sweepU));
      setPose("leftShoulder", lerp(0.16, -0.2, sweepU), 0, ventFlare + 0.1);
      setPose("rightShoulder", lerp(-0.28, 0.24, sweepU), 0, -ventFlare - lerp(0.2, 0.04, sweepU));
      setPose("leftArm", lerp(0.64, -0.62, sweepU), -0.18, lerp(0.32, 0.36, sweepU));
      setPose("elbowL", lerp(0.86, 0.36, sweepU), 0, -0.08);
      setPose(
        "rightArm",
        lerp(-1.58, 1.15, sweepU) + lockTremor,
        lerp(0.26, -0.34, sweepU),
        lerp(-0.78, -0.44, sweepU)
      );
      setPose("elbowR", lerp(0.96, 0.32, sweepU), lerp(0, -0.42, sweepU), lerp(0.18, 0.82, sweepU));
      setPose("thighL", lerp(0.32, 0.48, sweepU), 0.1, 0.075);
      setPose("shinL", lerp(-0.48, -0.64, sweepU), 0, 0);
      setPose("footL", lerp(0.16, 0.18, sweepU), 0, -0.075);
      setPose("thighR", lerp(-0.26, -0.34, sweepU), -0.1, -0.075);
      setPose("shinR", -0.32, 0, 0);
      setPose("footR", lerp(0.46, 0.56, sweepU), 0, 0.075);
      slerpRate = inLock ? 42 : 48;
    } else if (state.anim === "recover") {
      const u = animElapsed < 0.14 ? 0 : mechSnap((animElapsed - 0.14) / (RECOVER_DURATION - 0.14), 2.2);
      targetBodyDrop = lerp(0.12, 0.018, u);
      targetBladeSurge = lerp(0.55, 0, u);
      targetMonoEyeYaw = lerp(-0.2, 0, u);
      setPose("hips", lerp(-0.08, 0, u), lerp(0.22, 0, u), lerp(-0.04, 0, u));
      setPose("torso", lerp(-0.3, -0.05, u), lerp(0.4, 0, u), lerp(-0.09, 0, u));
      setPose("head", lerp(0.2, 0.03, u), lerp(-0.3, 0, u), 0);
      setPose("leftShoulder", lerp(-0.16, 0, u), 0, ventFlare);
      setPose("rightShoulder", lerp(0.18, 0, u), 0, -ventFlare);
      setPose("leftArm", lerp(-0.46, 0.18, u), -0.08, lerp(0.3, 0.14, u));
      setPose("elbowL", lerp(0.36, 0.52, u), 0, -0.06);
      setPose("rightArm", lerp(0.98, 0.18, u), lerp(0.3, 0.1, u), lerp(-0.3, -0.22, u));
      setPose("elbowR", lerp(0.24, 0.5, u), lerp(0.32, 0, u), lerp(-0.2, 0.08, u));
      setPose("thighL", lerp(0.42, 0.08, u), 0.08, 0.075);
      setPose("shinL", lerp(-0.56, -0.14, u), 0, 0);
      setPose("footL", lerp(0.18, 0.06, u), 0, -0.075);
      setPose("thighR", lerp(-0.28, -0.06, u), -0.08, -0.075);
      setPose("shinR", lerp(-0.28, -0.1, u), 0, 0);
      setPose("footR", lerp(0.48, 0.16, u), 0, 0.075);
      slerpRate = 12;
    } else if (state.anim === "charge") {
      const fwdPitch = -27 * DEG2RAD;
      const runW = animElapsed * 6 + 0.4;
      const rawS = Math.sin(runW);
      const s = Math.sign(rawS) * Math.pow(Math.abs(rawS), 0.78);
      const c = Math.cos(runW);
      const stomp = Math.pow(Math.max(0, -Math.cos(runW * 2)), 2.8);
      coreWarnMult = 1.38;
      targetBladeSurge = 0.68;
      targetBodyDrop = 0.055 + 0.095 * stomp;
      targetMonoEyeYaw = -s * 0.06;
      setPose("hips", -0.12, -s * 0.14, s * 0.06);
      setPose("torso", fwdPitch - 0.05 * stomp, s * 0.14 + 0.18, -s * 0.07);
      setPose("head", -0.34, -0.16 - s * 0.08, 0);
      setPose("leftShoulder", 0.2, 0, ventFlare + 0.08);
      setPose("rightShoulder", -0.24, 0, -ventFlare - 0.14);
      setPose("leftArm", 0.68 - s * 0.12, -0.24, 0.22);
      setPose("elbowL", 0.96, 0, -0.12);
      setPose("rightArm", -0.96 + s * 0.14, 0.22, -0.44);
      setPose("elbowR", 0.34, 0, 0.08);
      setPose("thighL", s * 0.62 + 0.14, 0.06, 0.07);
      setPose("shinL", -0.16 - Math.max(0, -c) * 0.7 - stomp * 0.14, 0, 0);
      setPose("footL", -s * 0.28 + 0.14, 0, -0.07);
      setPose("thighR", -s * 0.62 + 0.14, -0.06, -0.07);
      setPose("shinR", -0.16 - Math.max(0, c) * 0.7 - stomp * 0.14, 0, 0);
      setPose("footR", s * 0.28 + 0.14, 0, 0.07);
      slerpRate = 24;
    }
    const qAlpha = step > 0 ? 1 - Math.exp(-slerpRate * step) : 1;
    for (let i = 0; i < jointKeys.length; i++) {
      const key = jointKeys[i];
      const [rx, ry, rz] = targetPose[key];
      tmpEuler.set(rx, ry, rz, "XYZ");
      tmpQuat.setFromEuler(tmpEuler);
      jointNodes[key].quaternion.slerp(tmpQuat, qAlpha);
    }
    const scalarAlpha = step > 0 ? 1 - Math.exp(-22 * step) : 1;
    bodyDropCur += (targetBodyDrop - bodyDropCur) * scalarAlpha;
    body.position.y = baseHipOffsetY - bodyDropCur;
    bladeSurgeCur += (targetBladeSurge - bladeSurgeCur) * scalarAlpha;
    monoEyeYawCur += (targetMonoEyeYaw - monoEyeYawCur) * scalarAlpha;
    monoEye.rotation.y = monoEyeYawCur;
    const humFreq = 3.2 + (1 - hpPct) * 1.8 + overloadHeat * 2.4;
    const hum = 0.5 + 0.5 * Math.sin(elapsed * humFreq);
    armorMat.emissive.copy(SEAM_EMISSIVE_P1).lerp(SEAM_EMISSIVE_P2, overloadHeat);
    armorMat.emissiveIntensity = 0.03 + overloadHeat * (0.92 + hum * 0.16);
    coreMat.emissive.copy(CORE_EMISSIVE_P1).lerp(CORE_EMISSIVE_P2, overloadHeat);
    coreMat.emissiveIntensity = (1.38 + overloadHeat * 1.45 + hum * (0.08 + overloadHeat * 0.18)) * coreWarnMult;
    eyeMat.emissive.copy(EYE_EMISSIVE_P1).lerp(EYE_EMISSIVE_P2, overloadHeat);
    eyeMat.emissiveIntensity = (2.55 + overloadHeat * 1.75 + hum * (0.1 + overloadHeat * 0.22)) * (coreWarnMult > 1.25 ? 1.18 : 1);
    bladeMat.emissive.copy(BLADE_EMISSIVE_P1).lerp(BLADE_EMISSIVE_P2, clamp01(overloadHeat + bladeSurgeCur * 0.45));
    bladeMat.emissiveIntensity = 1.65 + overloadHeat * 1.65 + bladeSurgeCur * 1.15 + hum * (0.08 + overloadHeat * 0.16);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    root.removeFromParent();
    const geoSet = new Set(ownedGeometries);
    const matSet = new Set(ownedMaterials);
    root.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        if (obj.geometry) geoSet.add(obj.geometry);
        if (Array.isArray(obj.material)) {
          for (const m of obj.material) matSet.add(m);
        } else if (obj.material) {
          matSet.add(obj.material);
        }
      }
    });
    for (const g of geoSet) g.dispose();
    for (const m of matSet) m.dispose();
    for (const t of atlas.all) t.dispose();
  };
  return {
    parts: {
      root,
      torso,
      head,
      core,
      leftArm,
      rightArm,
      leftShoulder,
      rightShoulder,
      rightBlade,
      ventGlow,
      monoEye
    },
    update,
    dispose
  };
}

// src/game/bossController.ts
var BOSS_TARGET_HEIGHT = 4;
var BOSS_BODY_RADIUS = 0.68;
var BOSS_HEAD_RATIO = 0.82;
var BOSS_HEAD_SPHERE_RADIUS = 0.5;
var BOSS_CORE_RADIUS = 0.5;
var BOSS_CORE_HEIGHT_RATIO = 0.68;
var BOSS_CORE_SURFACE_OFFSET = 0.45;
var BOSS_SPAWN_MIN_DIST = 20;
var BOSS_SPAWN_MAX_DIST = 25;
var BOSS_MELEE_DAMAGE = 20;
var BOSS_HIT_RECOIL_MS = 150;
var BOSS_HIT_RECOIL_DIST = 0.08;
var EPS4 = 1e-6;
var DEATH_COLLAPSE_SEC = 0.85;
var CORPSE_HOLD_SEC = 2;
var CORPSE_FADE_SEC = 0.7;
var CONTACT_SHADOW_DIAMETER = 2.8;
var CONTACT_SHADOW_Y = 0.015;
var CONTACT_SHADOW_OPACITY = 0.78;
var sharedBossShadowTex = null;
var sharedBossShadowGeo = null;
function makeBossShadowTex() {
  if (typeof document === "undefined") {
    const tex2 = new THREE2.DataTexture(new Uint8Array([12, 16, 24, 180]), 1, 1);
    tex2.needsUpdate = true;
    return tex2;
  }
  const size = 128;
  const half = size / 2;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(half, half, 0, half, half, half - 2);
  g.addColorStop(0, "rgba(10, 14, 22, 0.76)");
  g.addColorStop(0.35, "rgba(10, 14, 22, 0.56)");
  g.addColorStop(0.65, "rgba(10, 14, 22, 0.24)");
  g.addColorStop(1, "rgba(10, 14, 22, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE2.CanvasTexture(c);
  tex.colorSpace = THREE2.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
function clamp3(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
function clamp012(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function dampVal(cur, target, lambda, dt) {
  if (dt <= 0) return target;
  return cur + (target - cur) * (1 - Math.exp(-lambda * dt));
}
function yawToTarget(fromX, fromZ, toX, toZ) {
  const dx = toX - fromX;
  const dz = toZ - fromZ;
  if (Math.hypot(dx, dz) <= EPS4) return 0;
  return Math.atan2(-dx, -dz);
}
function mapStateToAnim(state) {
  return state === "chase" ? "walk" : state;
}
function countObjectTriangles(root) {
  let total = 0;
  root.traverse((obj) => {
    if (!(obj instanceof THREE2.Mesh)) return;
    const geo = obj.geometry;
    if (!geo) return;
    const idx = geo.getIndex();
    if (idx) {
      total += Math.round(idx.count / 3);
    } else {
      const pos = geo.getAttribute("position");
      if (pos) total += Math.round(pos.count / 3);
    }
  });
  return total;
}
function hasClearSightline(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dy, dz);
  if (len <= EPS4) return true;
  const dir = { x: dx / len, y: dy / len, z: dz / len };
  for (const b of MAP.boxes) {
    if (b.kind === "deck") continue;
    const t = rayBoxT(from, dir, b);
    if (t < len - 0.1) return false;
  }
  return true;
}
function selectBossSpawn(playerPos) {
  const world = new CollisionWorld(MAP.boxes, MAP.bounds, MAP.waterY, MAP.walkablePolygon);
  const targetDist = (BOSS_SPAWN_MIN_DIST + BOSS_SPAWN_MAX_DIST) * 0.5;
  const clearanceR = 0.85;
  const eyeFrom = { x: playerPos.x, y: 1.65, z: playerPos.z };
  const isValidSpot = (x, y, z) => world.isInsideWalkable(x, z, clearanceR) && !world.hits(x, y, z, clearanceR, BOSS_TARGET_HEIGHT);
  const allSpawns = [];
  for (let i = 0; i < MAP.spawns.teamB.length; i++) allSpawns.push(spawnPoint("B", i));
  for (let i = 0; i < MAP.spawns.teamA.length; i++) allSpawns.push(spawnPoint("A", i));
  let bestRaw = null;
  for (const [sx, sy, sz] of allSpawns) {
    const d = Math.hypot(sx - playerPos.x, sz - playerPos.z);
    if (d < BOSS_SPAWN_MIN_DIST || d > BOSS_SPAWN_MAX_DIST) continue;
    if (!isValidSpot(sx, sy, sz)) continue;
    const losBonus = hasClearSightline(eyeFrom, { x: sx, y: sy + 2, z: sz }) ? 0 : 10;
    const score = Math.abs(d - targetDist) + losBonus;
    if (!bestRaw || score < bestRaw.score) {
      bestRaw = { pt: { x: sx, y: sy, z: sz }, score };
    }
  }
  if (bestRaw) return bestRaw.pt;
  let anchor = spawnPoint("B", 4);
  let anchorBestDist = Infinity;
  for (let i = 0; i < MAP.spawns.teamB.length; i++) {
    const sp = spawnPoint("B", i);
    const d = Math.hypot(sp[0] - playerPos.x, sp[2] - playerPos.z);
    if (d > 1 && d < anchorBestDist) {
      anchorBestDist = d;
      anchor = sp;
    }
  }
  const baseAngle = Math.atan2(anchor[0] - playerPos.x, anchor[2] - playerPos.z);
  const angleOffsetsDeg = [0, -5, 5, -6, 6, -8, 8, -12, 12, -18, 18, -25, 25, -35, 35, -50, 50];
  const radii = [22.5, 22, 23, 21, 24, 20.5, 24.5];
  for (const r of radii) {
    for (const deg of angleOffsetsDeg) {
      const a = baseAngle + deg * Math.PI / 180;
      const cx = playerPos.x + Math.sin(a) * r;
      const cz = playerPos.z + Math.cos(a) * r;
      if (!isValidSpot(cx, 0, cz)) continue;
      if (hasClearSightline(eyeFrom, { x: cx, y: 2, z: cz })) {
        return { x: Number(cx.toFixed(2)), y: 0, z: Number(cz.toFixed(2)) };
      }
    }
  }
  for (const r of radii) {
    for (const deg of angleOffsetsDeg) {
      const a = baseAngle + deg * Math.PI / 180;
      const cx = playerPos.x + Math.sin(a) * r;
      const cz = playerPos.z + Math.cos(a) * r;
      if (isValidSpot(cx, 0, cz)) {
        return { x: Number(cx.toFixed(2)), y: 0, z: Number(cz.toFixed(2)) };
      }
    }
  }
  return { x: -10, y: 0, z: -5.5 };
}
function raySphereT(o, d, cx, cy, cz, r) {
  const ox = o.x - cx;
  const oy = o.y - cy;
  const oz = o.z - cz;
  const a = d.x * d.x + d.y * d.y + d.z * d.z;
  if (a <= EPS4) return Infinity;
  const b = 2 * (ox * d.x + oy * d.y + oz * d.z);
  const c = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return Infinity;
  const sq = Math.sqrt(disc);
  const t1 = (-b - sq) / (2 * a);
  if (t1 > EPS4) return t1;
  const t2 = (-b + sq) / (2 * a);
  return t2 > EPS4 ? t2 : Infinity;
}
function rayVerticalCapsuleT(o, d, pos, r, height) {
  const yBot = pos.y + r;
  const yTop = Math.max(yBot, pos.y + height - r);
  let best = Infinity;
  const ox = o.x - pos.x;
  const oz = o.z - pos.z;
  const a = d.x * d.x + d.z * d.z;
  if (a > EPS4) {
    const b = 2 * (ox * d.x + oz * d.z);
    const c = ox * ox + oz * oz - r * r;
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      for (const t of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) {
        if (t <= EPS4 || t >= best) continue;
        const y = o.y + t * d.y;
        if (y >= yBot && y <= yTop) best = t;
      }
    }
  }
  const tBot = raySphereT(o, d, pos.x, yBot, pos.z, r);
  if (tBot < best) best = tBot;
  const tTop = raySphereT(o, d, pos.x, yTop, pos.z, r);
  if (tTop < best) best = tTop;
  return best;
}
function classifyBossHitPart(hitPoint, bossPos, bossYaw, height = BOSS_TARGET_HEIGHT, headRatio = BOSS_HEAD_RATIO, coreHeightRatio = BOSS_CORE_HEIGHT_RATIO) {
  const relY = hitPoint.y - bossPos.y;
  if (relY > height * headRatio) {
    return "head";
  }
  const coreY = bossPos.y + height * coreHeightRatio;
  const fwdX = -Math.sin(bossYaw);
  const fwdZ = -Math.cos(bossYaw);
  const rSq = BOSS_CORE_RADIUS * BOSS_CORE_RADIUS;
  const frontX = bossPos.x + fwdX * BOSS_CORE_SURFACE_OFFSET;
  const frontZ = bossPos.z + fwdZ * BOSS_CORE_SURFACE_OFFSET;
  const dfx = hitPoint.x - frontX;
  const dfy = hitPoint.y - coreY;
  const dfz = hitPoint.z - frontZ;
  if (dfx * dfx + dfy * dfy + dfz * dfz <= rSq) {
    return "core";
  }
  const backX = bossPos.x - fwdX * BOSS_CORE_SURFACE_OFFSET;
  const backZ = bossPos.z - fwdZ * BOSS_CORE_SURFACE_OFFSET;
  const dbx = hitPoint.x - backX;
  const dbz = hitPoint.z - backZ;
  if (dbx * dbx + dfy * dfy + dbz * dbz <= rSq) {
    return "core";
  }
  return "body";
}
function raycastBoss(ray, bossPos, bossYaw, alive, height = BOSS_TARGET_HEIGHT, headRatio = BOSS_HEAD_RATIO, coreHeightRatio = BOSS_CORE_HEIGHT_RATIO, headCenterRatio = 0.9) {
  if (!alive) return null;
  const tCapsule = rayVerticalCapsuleT(ray.origin, ray.dir, bossPos, BOSS_BODY_RADIUS, height);
  const headCenterY = bossPos.y + height * headCenterRatio;
  const tHead = raySphereT(
    ray.origin,
    ray.dir,
    bossPos.x,
    headCenterY,
    bossPos.z,
    BOSS_HEAD_SPHERE_RADIUS
  );
  const bestT = Math.min(tCapsule, tHead);
  if (!Number.isFinite(bestT)) return null;
  const point = {
    x: ray.origin.x + ray.dir.x * bestT,
    y: ray.origin.y + ray.dir.y * bestT,
    z: ray.origin.z + ray.dir.z * bestT
  };
  const part = tHead <= tCapsule + EPS4 && point.y - bossPos.y > height * headRatio ? "head" : classifyBossHitPart(point, bossPos, bossYaw, height, headRatio, coreHeightRatio);
  return { dist: bestT, point, part };
}
var BossController = class {
  mesh;
  ai;
  height;
  headRatio;
  headCenterRatio;
  coreHeightRatio;
  attackRange;
  meleeDamage;
  scene;
  opts;
  modelWrap;
  model;
  cachedTriangleCount = 0;
  modelBaseY = 0;
  shadowMesh;
  shadowMat;
  origin;
  worldPos;
  currentYaw = 0;
  cachedTick;
  lastEventsArr = [];
  hitRecoilTimerMs = 0;
  currentRecoilZ = 0;
  deadStarted = false;
  deadElapsedSec = 0;
  deathFadeApplied = false;
  disposed = false;
  _hitsTaken = 0;
  _meleeHitsDealt = 0;
  _lastHitPart = null;
  _lastReportedPhase = 1;
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.opts = opts;
    this.ai = new BossAI(opts.hpMax ?? BOSS_DEFAULTS.hpMax, opts.ai);
    this.attackRange = opts.ai?.attackRange ?? BOSS_DEFAULTS.attackRange;
    this.meleeDamage = opts.meleeDamage ?? BOSS_MELEE_DAMAGE;
    const defaultPlayer = spawnPoint("A", 0);
    const pPos = opts.playerPos ?? { x: defaultPlayer[0], z: defaultPlayer[2] };
    const spawn = opts.spawnPos ? { x: opts.spawnPos.x, y: opts.spawnPos.y ?? 0, z: opts.spawnPos.z } : selectBossSpawn(pPos);
    this.origin = { x: spawn.x, y: spawn.y, z: spawn.z };
    this.worldPos = { x: spawn.x, y: spawn.y, z: spawn.z };
    this.currentYaw = yawToTarget(this.worldPos.x, this.worldPos.z, pPos.x, pPos.z);
    this.mesh = new THREE2.Group();
    this.mesh.name = "boss-root";
    this.mesh.position.set(this.worldPos.x, this.worldPos.y, this.worldPos.z);
    this.mesh.rotation.y = this.currentYaw;
    this.modelWrap = new THREE2.Group();
    this.modelWrap.name = "boss-model-wrap";
    this.mesh.add(this.modelWrap);
    this.model = this.mountBossModel();
    this.model.parts.root.updateMatrixWorld(true);
    const rootBox = new THREE2.Box3().setFromObject(this.model.parts.root);
    const measuredH = !rootBox.isEmpty() && Number.isFinite(rootBox.max.y - rootBox.min.y) ? rootBox.max.y - rootBox.min.y : BOSS_TARGET_HEIGHT;
    this.height = Number(measuredH.toFixed(4));
    this.modelBaseY = Number.isFinite(rootBox.min.y) ? -rootBox.min.y : 0;
    this.modelWrap.position.y = this.modelBaseY;
    const headBox = new THREE2.Box3().setFromObject(this.model.parts.head);
    if (!headBox.isEmpty() && this.height > EPS4) {
      this.headRatio = clamp3((headBox.min.y - rootBox.min.y) / this.height, 0.72, 0.9);
      this.headCenterRatio = clamp3(
        ((headBox.min.y + headBox.max.y) * 0.5 - rootBox.min.y) / this.height,
        0.78,
        0.96
      );
    } else {
      this.headRatio = BOSS_HEAD_RATIO;
      this.headCenterRatio = 0.9;
    }
    const coreBox = new THREE2.Box3().setFromObject(this.model.parts.core);
    if (!coreBox.isEmpty() && this.height > EPS4) {
      this.coreHeightRatio = clamp3(
        ((coreBox.min.y + coreBox.max.y) * 0.5 - rootBox.min.y) / this.height,
        0.52,
        0.82
      );
    } else {
      this.coreHeightRatio = BOSS_CORE_HEIGHT_RATIO;
    }
    if (!sharedBossShadowTex) sharedBossShadowTex = makeBossShadowTex();
    if (!sharedBossShadowGeo) {
      sharedBossShadowGeo = new THREE2.PlaneGeometry(CONTACT_SHADOW_DIAMETER, CONTACT_SHADOW_DIAMETER);
      sharedBossShadowGeo.rotateX(-Math.PI / 2);
    }
    this.shadowMat = new THREE2.MeshBasicMaterial({
      map: sharedBossShadowTex,
      transparent: true,
      opacity: CONTACT_SHADOW_OPACITY,
      depthWrite: false
    });
    this.shadowMesh = new THREE2.Mesh(sharedBossShadowGeo, this.shadowMat);
    this.shadowMesh.name = "boss-shadow";
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
      Math.hypot(pPos.x - this.worldPos.x, pPos.z - this.worldPos.z)
    );
  }
  mountBossModel() {
    const model = createBossModel();
    model.parts.root.name = "boss-terminator-model";
    this.modelWrap.add(model.parts.root);
    this.cachedTriangleCount = countObjectTriangles(model.parts.root);
    return model;
  }
  get hp() {
    return this.cachedTick.hp;
  }
  get hpMax() {
    return this.cachedTick.hpMax;
  }
  get phase() {
    return this.cachedTick.phase;
  }
  get alive() {
    return this.cachedTick.hp > 0;
  }
  get state() {
    return this.cachedTick.state;
  }
  get pos() {
    return { x: this.worldPos.x, y: this.worldPos.y, z: this.worldPos.z };
  }
  get yaw() {
    return this.currentYaw;
  }
  get triangleCount() {
    return this.cachedTriangleCount;
  }
  get lastTick() {
    return this.cachedTick;
  }
  get lastEvents() {
    return this.lastEventsArr;
  }
  get hitsTaken() {
    return this._hitsTaken;
  }
  get meleeHitsDealt() {
    return this._meleeHitsDealt;
  }
  get lastHitPart() {
    return this._lastHitPart;
  }
  get hitRecoilOffset() {
    return this.currentRecoilZ;
  }
  raycast(ray) {
    return raycastBoss(
      ray,
      this.worldPos,
      this.currentYaw,
      this.alive,
      this.height,
      this.headRatio,
      this.coreHeightRatio,
      this.headCenterRatio
    );
  }
  applyDamage(amount, part) {
    if (this.disposed || !this.alive) return { dealt: 0, dead: false };
    const wasAlive = this.alive;
    const dealt = this.ai.applyDamage(amount, part);
    if (dealt <= 0) return { dealt: 0, dead: false };
    this._hitsTaken++;
    this._lastHitPart = part;
    this.hitRecoilTimerMs = BOSS_HIT_RECOIL_MS;
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
  /** Advance Boss AI + sync mesh transform + drive procedural Terminator animation & hit recoil. */
  update(dtMs, player) {
    if (this.disposed) return;
    const safeDtMs = Number.isFinite(dtMs) && dtMs > 0 ? dtMs : 0;
    const dtSec = safeDtMs / 1e3;
    const prevX = this.worldPos.x;
    const prevZ = this.worldPos.z;
    const distBefore = Math.hypot(player.x - prevX, player.z - prevZ);
    const relPlayer = {
      x: player.x - this.origin.x,
      z: player.z - this.origin.z
    };
    const tick = this.ai.update(safeDtMs, relPlayer, distBefore);
    this.cachedTick = tick;
    this.lastEventsArr = tick.events;
    this.worldPos.x = this.origin.x + tick.pos.x;
    this.worldPos.z = this.origin.z + tick.pos.z;
    const distAfter = Math.hypot(player.x - this.worldPos.x, player.z - this.worldPos.z);
    if (tick.hp > 0) {
      if (tick.state === "charge") {
        this.currentYaw = tick.yaw;
      } else if (distAfter > EPS4) {
        this.currentYaw = yawToTarget(this.worldPos.x, this.worldPos.z, player.x, player.z);
      } else {
        this.currentYaw = tick.yaw;
      }
    }
    this.mesh.position.set(this.worldPos.x, this.worldPos.y, this.worldPos.z);
    this.mesh.rotation.y = this.currentYaw;
    if (tick.phase !== this._lastReportedPhase) {
      this._lastReportedPhase = tick.phase;
      this.opts.onPhaseChange?.(tick.phase);
    }
    for (const ev of tick.events) {
      if (ev === "phase2" && this._lastReportedPhase !== 2) {
        this._lastReportedPhase = 2;
        this.opts.onPhaseChange?.(2);
      }
      if (ev === "attack_hit" && distAfter <= this.attackRange + EPS4) {
        this._meleeHitsDealt++;
        this.opts.onAttackHit?.({
          damage: this.meleeDamage,
          dist: distAfter,
          bossPos: { x: this.worldPos.x, y: this.worldPos.y, z: this.worldPos.z }
        });
      }
    }
    this.stepAnimation(dtSec, safeDtMs, tick.state, tick.hp <= 0);
  }
  /** Idle visual update during menu / pre-match countdown without running AI chase/attacks. */
  updateVisualOnly(dtMs, player) {
    if (this.disposed) return;
    const safeDtMs = Number.isFinite(dtMs) && dtMs > 0 ? dtMs : 0;
    if (player && this.alive) {
      this.currentYaw = yawToTarget(this.worldPos.x, this.worldPos.z, player.x, player.z);
    }
    this.mesh.position.set(this.worldPos.x, this.worldPos.y, this.worldPos.z);
    this.mesh.rotation.y = this.currentYaw;
    this.stepAnimation(safeDtMs / 1e3, safeDtMs, this.alive ? "idle" : "recover", !this.alive);
  }
  /** Reset Boss back to full HP at a fresh 20-25m spawn relative to `playerPos`. */
  reset(playerPos) {
    if (this.disposed) return;
    this.ai.reset();
    const defaultPlayer = spawnPoint("A", 0);
    const pPos = playerPos ?? this.opts.playerPos ?? { x: defaultPlayer[0], z: defaultPlayer[2] };
    const spawn = this.opts.spawnPos ? { x: this.opts.spawnPos.x, y: this.opts.spawnPos.y ?? 0, z: this.opts.spawnPos.z } : selectBossSpawn(pPos);
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
    this._meleeHitsDealt = 0;
    this._lastHitPart = null;
    this._lastReportedPhase = 1;
    this.lastEventsArr = [];
    this.mesh.position.set(this.worldPos.x, this.worldPos.y, this.worldPos.z);
    this.mesh.rotation.y = this.currentYaw;
    this.cachedTick = this.ai.update(
      0,
      { x: pPos.x - this.origin.x, z: pPos.z - this.origin.z },
      Math.hypot(pPos.x - this.worldPos.x, pPos.z - this.worldPos.z)
    );
    this.model.update(0, { hpPct: 1, phase: 1, anim: "idle" });
  }
  setVisible(visible) {
    this.modelWrap.visible = visible;
  }
  /** Relocate Boss on deck (e2e/test staging only); optionally resets BossAI to idle. */
  relocate(x, z, playerPos, resetAi = false) {
    if (this.disposed) return;
    if (resetAi) {
      this.ai.reset();
      this.deadStarted = false;
      this.deadElapsedSec = 0;
      this.hitRecoilTimerMs = 0;
      this.currentRecoilZ = 0;
      this._hitsTaken = 0;
      this._meleeHitsDealt = 0;
      this._lastHitPart = null;
      this._lastReportedPhase = 1;
      this.lastEventsArr = [];
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
      Math.hypot(pPos.x - this.worldPos.x, pPos.z - this.worldPos.z)
    );
    const hpPct = this.cachedTick.hpMax > 0 ? this.cachedTick.hp / this.cachedTick.hpMax : 0;
    this.model.update(0, {
      hpPct,
      phase: this.cachedTick.phase,
      anim: mapStateToAnim(this.cachedTick.state)
    });
  }
  getFeetWorldY() {
    this.mesh.updateMatrixWorld(true);
    const box2 = new THREE2.Box3().setFromObject(this.model.parts.root);
    if (box2.isEmpty() || !Number.isFinite(box2.min.y)) return null;
    return box2.min.y;
  }
  projectScreenBounds(camera, vw, vh) {
    this.mesh.updateMatrixWorld(true);
    const box2 = new THREE2.Box3().setFromObject(this.model.parts.root);
    if (box2.isEmpty()) return null;
    camera.updateMatrixWorld(true);
    const viewMat = camera.matrixWorldInverse;
    const projMat = camera.projectionMatrix;
    const vPt = new THREE2.Vector3();
    const nearClip = -0.35;
    const xs = [box2.min.x, box2.max.x];
    const ys = [box2.min.y, box2.max.y];
    const zs = [box2.min.z, box2.max.z];
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
      onScreen
    };
  }
  stepAnimation(dtSec, dtMs, state, isDead) {
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
    const recoilFrac = this.currentRecoilZ / BOSS_HIT_RECOIL_DIST;
    this.modelWrap.rotation.x = recoilFrac * 0.06;
    this.modelWrap.rotation.z = 0;
    this.modelWrap.position.y = this.modelBaseY;
    const hpPct = this.cachedTick.hpMax > 0 ? this.cachedTick.hp / this.cachedTick.hpMax : 0;
    this.model.update(dtSec, {
      hpPct,
      phase: this.cachedTick.phase,
      anim: mapStateToAnim(state)
    });
  }
  advanceDeath(dtSec) {
    if (!this.deadStarted) {
      this.deadStarted = true;
      this.deadElapsedSec = 0;
    }
    this.deadElapsedSec += dtSec;
    const u = clamp012(this.deadElapsedSec / DEATH_COLLAPSE_SEC);
    const fallEase = u * u * (3 - 2 * u);
    this.modelWrap.rotation.x = dampVal(this.modelWrap.rotation.x, fallEase * 1.44, 14, dtSec);
    this.modelWrap.rotation.z = dampVal(this.modelWrap.rotation.z, fallEase * 0.18, 14, dtSec);
    this.modelWrap.position.y = dampVal(this.modelWrap.position.y, this.modelBaseY + fallEase * 0.42, 12, dtSec);
    this.model.update(dtSec, { hpPct: 0, phase: 2, anim: "recover" });
    const fadeStart = DEATH_COLLAPSE_SEC + CORPSE_HOLD_SEC;
    if (this.deadElapsedSec >= fadeStart) {
      const fu = clamp012((this.deadElapsedSec - fadeStart) / CORPSE_FADE_SEC);
      const opacity = 1 - fu;
      this.deathFadeApplied = true;
      this.setModelFade(opacity);
      this.shadowMat.opacity = CONTACT_SHADOW_OPACITY * opacity;
      if (fu >= 1) {
        this.shadowMesh.visible = false;
      }
    }
  }
  setModelFade(opacity) {
    const mats = /* @__PURE__ */ new Set();
    this.model.parts.root.traverse((obj) => {
      if (!(obj instanceof THREE2.Mesh)) return;
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
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.scene.remove(this.mesh);
    this.model.dispose();
    this.shadowMat.dispose();
  }
};

// src/game/bossController.test.ts
test("selectBossSpawn picks a walkable, box-free point 20-25m from player spawn", () => {
  const [px, , pz] = spawnPoint("A", 0);
  const pos = selectBossSpawn({ x: px, z: pz });
  const dist = Math.hypot(pos.x - px, pos.z - pz);
  assert.ok(
    dist >= BOSS_SPAWN_MIN_DIST && dist <= BOSS_SPAWN_MAX_DIST,
    `expected spawn distance in [${BOSS_SPAWN_MIN_DIST}, ${BOSS_SPAWN_MAX_DIST}], got ${dist.toFixed(2)}m`
  );
  const world = new CollisionWorld(MAP.boxes, MAP.bounds, MAP.waterY, MAP.walkablePolygon);
  assert.equal(world.isInsideWalkable(pos.x, pos.z, 0.8), true, "boss spawn must lie inside walkable deck");
  assert.equal(world.hits(pos.x, pos.y, pos.z, 0.8, BOSS_TARGET_HEIGHT), false, "boss spawn must not overlap boxes");
});
test("BossController mounts procedural Terminator Boss model at 4.0-4.2m height with feet flush at y=0", () => {
  const scene = new THREE3.Scene();
  const boss = new BossController(scene);
  assert.equal(scene.children.includes(boss.mesh), true);
  boss.mesh.updateMatrixWorld(true);
  const modelRoot = boss.mesh.getObjectByName("boss-terminator-model");
  assert.ok(modelRoot, "procedural Terminator boss model should exist in mesh");
  assert.equal(boss.mesh.getObjectByName("boss-placeholder-robot"), void 0, "placeholder robot must be removed");
  assert.equal(boss.mesh.getObjectByName("robot-weapon"), void 0, "melee Boss must have no ranged weapon");
  assert.ok(boss.triangleCount > 3e3 && boss.triangleCount <= 2e4, `expected tris <= 20000, got ${boss.triangleCount}`);
  const box2 = new THREE3.Box3().setFromObject(modelRoot);
  const measuredHeight = box2.max.y - box2.min.y;
  assert.ok(
    measuredHeight >= 4 && measuredHeight <= 4.2,
    `expected Boss height in [4.0, 4.2]m, got ${measuredHeight.toFixed(3)}m`
  );
  assert.ok(
    Math.abs(boss.height - measuredHeight) < 0.02,
    `expected boss.height (${boss.height}) to match measured model height (${measuredHeight.toFixed(3)})`
  );
  assert.ok(Math.abs(box2.min.y) < 0.05, `Boss feet should sit flush on deck y=0, got ${box2.min.y.toFixed(3)}`);
  boss.dispose();
  assert.equal(scene.children.includes(boss.mesh), false);
});
test("raycastBoss + classifyBossHitPart distinguish head (>0.82H), core (chest/back +-0.5m), and body", () => {
  const bossPos = { x: 0, y: 0, z: -10 };
  const bossYaw = Math.PI;
  const headHit = raycastBoss(
    { origin: { x: 0, y: 3.65, z: 0 }, dir: { x: 0, y: 0, z: -1 } },
    bossPos,
    bossYaw,
    true
  );
  assert.ok(headHit, "head ray should hit");
  assert.equal(headHit.part, "head");
  const coreHit = raycastBoss(
    { origin: { x: 0, y: 2.72, z: 0 }, dir: { x: 0, y: 0, z: -1 } },
    bossPos,
    bossYaw,
    true
  );
  assert.ok(coreHit, "chest core ray should hit");
  assert.equal(coreHit.part, "core");
  const backCoreHit = raycastBoss(
    { origin: { x: 0, y: 2.72, z: -20 }, dir: { x: 0, y: 0, z: 1 } },
    bossPos,
    bossYaw,
    true
  );
  assert.ok(backCoreHit, "back core ray should hit");
  assert.equal(backCoreHit.part, "core");
  const bodyHit = raycastBoss(
    { origin: { x: 0, y: 1.2, z: 0 }, dir: { x: 0, y: 0, z: -1 } },
    bossPos,
    bossYaw,
    true
  );
  assert.ok(bodyHit, "body ray should hit");
  assert.equal(bodyHit.part, "body");
  assert.equal(
    raycastBoss({ origin: { x: 0, y: 2.72, z: 0 }, dir: { x: 0, y: 0, z: -1 } }, bossPos, bossYaw, false),
    null
  );
  assert.equal(classifyBossHitPart({ x: 0, y: 3.3, z: -9.5 }, bossPos, bossYaw), "head");
  assert.equal(classifyBossHitPart({ x: 0.65, y: 2.72, z: -10 }, bossPos, bossYaw), "body");
});
test("BossController applies weakpoint damage, triggers 0.15s / 0.08m hit recoil, phase2, and death", () => {
  const scene = new THREE3.Scene();
  const phases = [];
  let defeatedCount = 0;
  const boss = new BossController(scene, {
    hpMax: 1e3,
    spawnPos: { x: 0, y: 0, z: -10 },
    playerPos: { x: 0, z: 0 },
    onPhaseChange: (p) => phases.push(p),
    onDefeated: () => defeatedCount++
  });
  const r1 = boss.applyDamage(100, "body");
  assert.equal(r1.dealt, 100);
  assert.equal(r1.dead, false);
  assert.equal(boss.hp, 900);
  assert.equal(boss.phase, 1);
  boss.updateVisualOnly(75, { x: 0, z: 0 });
  assert.ok(
    Math.abs(boss.hitRecoilOffset - BOSS_HIT_RECOIL_DIST) < 5e-3,
    `expected recoil near ${BOSS_HIT_RECOIL_DIST}m at 75ms, got ${boss.hitRecoilOffset}`
  );
  boss.updateVisualOnly(80, { x: 0, z: 0 });
  assert.equal(boss.hitRecoilOffset, 0, "recoil must return to 0 after 150ms");
  const r2 = boss.applyDamage(100, "core");
  assert.equal(r2.dealt, 200);
  assert.equal(boss.hp, 700);
  assert.equal(boss.phase, 2);
  assert.deepEqual(phases, [2]);
  const r3 = boss.applyDamage(300, "head");
  assert.equal(r3.dealt, 750);
  assert.equal(r3.dead, true);
  assert.equal(boss.hp, 0);
  assert.equal(boss.alive, false);
  assert.equal(defeatedCount, 1);
  const r4 = boss.applyDamage(100, "head");
  assert.equal(r4.dealt, 0);
  assert.equal(r4.dead, false);
  boss.dispose();
});
test("BossController chases player from 22m and triggers melee onAttackHit inside attackRange", () => {
  const scene = new THREE3.Scene();
  const hits = [];
  const player = { x: -8, z: 17 };
  const boss = new BossController(scene, {
    playerPos: player,
    meleeDamage: 20,
    onAttackHit: (info) => hits.push({ damage: info.damage, dist: info.dist })
  });
  const startDist = Math.hypot(boss.pos.x - player.x, boss.pos.z - player.z);
  assert.ok(startDist >= 20 && startDist <= 25, `start dist ${startDist}`);
  for (let i = 0; i < 500; i++) {
    boss.update(20, player);
  }
  const endDist = Math.hypot(boss.pos.x - player.x, boss.pos.z - player.z);
  assert.ok(endDist <= boss.attackRange + 0.1, `expected Boss within melee range, got ${endDist.toFixed(2)}m`);
  assert.ok(hits.length >= 2, `expected >=2 melee hits in 10s, got ${hits.length}`);
  assert.equal(hits[0].damage, 20);
  assert.ok(hits[0].dist <= boss.attackRange + 1e-4);
  boss.dispose();
});
