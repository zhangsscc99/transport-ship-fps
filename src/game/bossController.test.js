// src/game/bossController.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE3 from "three";

// src/game/bossController.ts
import * as THREE2 from "three";

// src/game/bossAI.ts
var BOSS_DEFAULTS = {
  hpMax: 2e3,
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

// src/render/robotModel.ts
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

// src/render/palette.ts
var PALETTE = {
  deck: ["#22282e", "#2c333b", "#3d4651"],
  // 甲板钢板：深海冷钢 3 档，拉出湿反光与明暗层次
  deckLine: "#d1a82e",
  // 甲板警示黄线
  container: ["#8f3b2e", "#2b4d6f", "#3f5940", "#7d6138"],
  // 集装箱 4 主色：锈红 / 深蓝 / 橄榄绿 / 赭黄
  containerTop: "#6e7378",
  rust: "#7a3f22",
  tower: ["#5d656d", "#6e7780"],
  // 混凝土哨塔（中性偏冷灰）
  steelFrame: "#4a5764",
  // 平台 H 型钢 / 工字钢 / 槽钢工业钢构（蓝灰漆钢）
  checker: "#535e69",
  // 花纹钢板台面与踏板
  kickplate: "#5b6570",
  // 护栏踢脚板（带锈迹流痕底色）
  elecBox: "#6a7580",
  // 配电箱工业灰漆箱体
  cabGlass: "#7fa8c4",
  // 吊机驾驶室反光玻璃
  oilStain: "#1a2028",
  // 地面油渍暗泽
  pipe: "#485460",
  // 管件/系缆桩——金属高光吃 IBL
  sea: ["#152430", "#1c2f3e", "#2c465a"],
  sky: ["#384c63", "#6f8db3"],
  // [0] 天顶，[1] 半球光天光色
  skyGround: "#2a2622",
  // 半球光地面反弹色（暖暗甲板）
  skyHorizon: "#7c93aa",
  // 地平线雾霾灰蓝 — 与雾色贴合
  // Saltline-inspired dusk/maritime sky — linear-space RGB triples
  skyZen: [0.065, 0.11, 0.185],
  skyHor: [0.86, 0.58, 0.34],
  skyHorAway: [0.19, 0.27, 0.38],
  fill: "#5b7fb3",
  // 冷色反方向补光
  fog: "#6c8298",
  // 指数雾色：取地平线灰蓝，与远景吊机/海面自然融出
  sun: "#ffe6c4",
  // 主方向光：低角度暖白太阳（15° 仰角）
  teamA: "#4fa4f1",
  // 我方：蓝
  teamB: "#ff4655",
  // 敌方：红
  hpFull: "#ece8e1",
  // VALORANT 灰白血条（非饱和色块）
  hpSeg2: "#b8e0ff",
  // 第二段 100–200 护甲级战术亮蓝白
  hpMid: "#d5d1ca",
  hpLow: "#ff4655",
  // 仅低血量/危险使用 Valorant 红
  uiPanel: "rgba(8,12,18,0.55)",
  uiBtnPanel: "rgba(14,19,27,0.90)",
  uiBtnGradTop: "rgba(188,208,230,0.048)",
  uiBtnGradMid: "rgba(14,19,27,0.00)",
  uiBtnGradBot: "rgba(2,5,10,0.14)",
  uiBtnHiTop: "rgba(255,255,255,0.28)",
  uiBtnHiInnerBot: "rgba(0,0,0,0.45)",
  uiBtnPressedTop: "rgba(255,255,255,0.24)",
  uiBtnPressedMid: "rgba(255,255,255,0.14)",
  uiBtnPressedBot: "rgba(255,255,255,0.08)",
  uiBtnPressedGlow: "rgba(255,255,255,0.22)",
  uiBtnActiveTop: "rgba(255,70,85,0.18)",
  uiBtnActiveMid: "rgba(255,70,85,0.12)",
  uiBtnActiveBot: "rgba(255,70,85,0.08)",
  uiBtnBorder: "rgba(236,232,225,0.48)",
  uiBtnBorderDisabled: "rgba(154,164,176,0.42)",
  uiBtnFgDisabled: "rgba(176,184,194,0.58)",
  uiBtnFireInnerRing: "rgba(255,70,85,0.34)",
  uiBtnReloadTrack: "rgba(236,232,225,0.18)",
  uiBtnReloadSweep: "rgba(255,70,85,0.22)",
  uiBtnShadow: "rgba(4,7,12,0.58)",
  uiBorder: "rgba(255,255,255,0.18)",
  uiBorderActive: "rgba(236,232,225,0.72)",
  uiText: "#ece8e1",
  uiDim: "rgba(236,232,225,0.60)",
  uiEmpty: "rgba(255,255,255,0.14)",
  accent: "#ff4655",
  // Valorant 红 — 仅用于危险/开火/低血量
  gun: ["#2e343b", "#3a4149", "#67727f"],
  // 枪体：暗/中/亮
  gunDark: "#252b32",
  // 弹匣/小件：偏暗哑光
  gunHi: "#8ea0b0",
  // 枪身高光条 emissive
  glove: "#5d6167",
  // 手臂——比枪身亮，分出层次
  skinBase: "#d49d7a",
  // 真人肤色基色（暖自然肤）
  skinWarm: "#c27958",
  // 肤色指节/皮下暖散射近似色
  skinNail: "#e4c2ae",
  // 指甲盖浅暖色
  tacGlove: "#2d333b",
  // 战术露指手套主料
  tacKnuckle: "#1d2228",
  // 手背护骨甲
  tacSleeve: "#2b3b4e",
  // 战术服袖子（海军灰蓝）
  tacCuff: "#212d3b",
  // 袖口加厚翻边
  tacVelcro: "#171c22",
  // 袖口魔术贴
  tacStitch: "#6c7c8e",
  // 袖口双排缝线
  // 赛博朋克机器人（全程序化金属 PBR，阵营仅靠发光色区分）
  robotArmor: "#2e3542",
  // 深灰蓝金属装甲漆面（避开 ACES 暗部死黑压暗，兼顾明暗背景对比）
  robotFrame: "#171a21",
  // 机械骨架与关节暗金属
  robotGun: "#2b303a",
  // 机器人脉冲步枪机匣
  robotEdge: "#6c7a92",
  // 装甲边缘 1px 弱发光亮边
  robotGlowEnemy: "#ff2d95",
  // 敌方强发光：品红
  robotGlowAlly: "#22e0ff",
  // 我方/AI 友军强发光：青
  robotHitFlash: "#ffffff",
  // 受击 0.12s 视带闪白
  // 敌人头顶距离牌 & 极简血条
  tagGlassBg: "rgba(8,12,20,0.62)",
  // 深色半透明玻璃底
  tagBorderCyan: "rgba(120,255,255,0.35)",
  // 1px 常规冷青内发光描边
  tagBorderWarm: "#ffb454",
  // <10m 暖色警示描边与 4px 圆点
  tagGlowCyan: "rgba(120,255,255,0.22)",
  // 常规 1px 内发光
  tagGlowWarm: "rgba(255,180,84,0.32)",
  // <10m 暖色内发光
  tagText: "#eef4fa",
  // 距离牌等宽数字色
  tagHpTrack: "rgba(255,255,255,0.14)",
  // 血条轨道底色
  tagHpHigh: "#22e0ff",
  // 血量 >60%：青
  tagHpMid: "#ffd166",
  // 血量 30%–60%：黄
  tagHpLow: "#ff4655",
  // 血量 <=30%：红
  bootDark: "#17191d",
  // 战术军靴
  brass: "#d8b054",
  // 弹壳 / 弹匣顶弹 / 加特林弹链黄铜
  gatlingAccent: "#f5b041",
  // 加特林重武 HUD 琥珀橙
  gatlingReady: "#5ee39a",
  // 加特林预热就绪绿
  gatlingBlur: "#9ab4cc",
  // 加特林枪管高速旋转残影
  flashCore: "#fffdf2",
  // 枪口白热星形核心
  flashMid: "#ff9626",
  // 枪口中层橙黄锥形火焰
  flashOuter: "#ff4812",
  // 枪口火焰外缘灼橙
  muzzleSmoke: "#cfe8f5",
  // 枪口外层淡青白短烟
  muzzleLight: "#ffb066",
  // 枪口 PointLight 暖光
  spark: "#ffd26a",
  // 命中火花
  dust: "#a6b0b8",
  // 命中微尘
  bulletHole: "#14171c",
  // 弹孔中心焦黑
  tracer: "#ffd670",
  // 曳光亮条
  crosshair: "#f2f6fa",
  crosshairHit: "#ff4655",
  crosshairEdge: "rgba(4,8,12,0.85)",
  deadVeil: "rgba(8,12,18,0.76)",
  hurtVeil: "rgba(255,70,85,0.72)",
  // 受击/低血 屏幕边缘红晕外缘
  lampRed: "#e4553f",
  // 船头红色警示灯
  lampWarm: "#ffc27a",
  // 哨塔暖黄工作灯 / 亮窗
  wood: "#785e3c",
  // 木托盘/木箱
  crane: "#354352",
  // 远处港口吊机剪影（靠指数雾自然淡入地平线）
  hull: "#353e47",
  // 船体外板——深海灰钢，吃金属 IBL 反光
  hullBand: "#7a3222",
  // 水线防污漆——氧化红
  cone: "#d66d22",
  // 警示锥——安全橙
  rope: "#917a55"
  // 缆绳卷——麻色
};

// src/render/robotModel.ts
var ARMOR_FRESNEL_CACHE_KEY = "robot-armor-fresnel-v1";
var ARMOR_EMISSIVE_INTENSITY = 0.16;
var ARMOR_FRESNEL_K = {
  enemy: 2.6,
  ally: 2
};
var ARMOR_HIT_FRESNEL_K = 3.6;
var VISOR_HALO_OPACITY = 0.9;
var cachedMaterials = null;
var cachedGeometries = null;
function countGeoTris(g) {
  const idx = g.getIndex();
  if (idx) return Math.round(idx.count / 3);
  const pos = g.getAttribute("position");
  return pos ? Math.round(pos.count / 3) : 0;
}
function makePart(geo, pos, rot = [0, 0, 0], tint = [1, 1, 1]) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  geo.dispose();
  if (rot[0] !== 0 || rot[1] !== 0 || rot[2] !== 0) {
    const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rot[0], rot[1], rot[2]));
    g.applyMatrix4(m);
  }
  if (pos[0] !== 0 || pos[1] !== 0 || pos[2] !== 0) {
    g.translate(pos[0], pos[1], pos[2]);
  }
  for (const name of Object.keys(g.attributes)) {
    if (name !== "position" && name !== "normal") {
      g.deleteAttribute(name);
    }
  }
  if (!g.getAttribute("normal")) g.computeVertexNormals();
  const count = g.getAttribute("position").count;
  const cols = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    cols[i * 3] = tint[0];
    cols[i * 3 + 1] = tint[1];
    cols[i * 3 + 2] = tint[2];
  }
  g.setAttribute("color", new THREE.BufferAttribute(cols, 3));
  return g;
}
function mergeStrict(parts) {
  const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
  if (!merged) throw new Error("robotModel: mergeGeometries failed");
  if (parts.length > 1) {
    for (const p of parts) p.dispose();
  }
  return merged;
}
function createFlashTexture() {
  if (typeof document === "undefined") {
    const tex2 = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    tex2.needsUpdate = true;
    return tex2;
  }
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 30);
  g.addColorStop(0, PALETTE.robotHitFlash);
  g.addColorStop(0.32, PALETTE.flashCore);
  g.addColorStop(0.68, PALETTE.flashMid);
  g.addColorStop(1, "rgba(255, 80, 18, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
function createVisorGlowTexture() {
  if (typeof document === "undefined") {
    const tex2 = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    tex2.needsUpdate = true;
    return tex2;
  }
  const size = 64;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const half = (size - 1) * 0.5;
  for (let y = 0; y < size; y++) {
    const ny = (y - half) / half;
    for (let x = 0; x < size; x++) {
      const nx = (x - half) / half;
      const barDx = Math.max(0, Math.abs(nx) - 0.32) / 0.68;
      const barR = Math.hypot(barDx, ny * 1.45);
      const core = Math.exp(-barR * barR * 6.5);
      const outerR = Math.hypot(nx, ny);
      const halo = outerR < 1 ? Math.pow(1 - outerR, 2.2) : 0;
      const edgeFade = outerR < 1 ? Math.min(1, (1 - outerR) * 4.5) : 0;
      const alpha = Math.max(0, Math.min(1, (core * 0.85 + halo * 0.72) * edgeFade));
      const idx = (y * size + x) * 4;
      d[idx] = 255;
      d[idx + 1] = 255;
      d[idx + 2] = 255;
      d[idx + 3] = Math.round(alpha * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
function applyArmorFresnel(mat, rimHex, rimStrength) {
  const rimColor = new THREE.Color(rimHex);
  mat.userData.fresnelRimColor = rimHex;
  mat.userData.fresnelRimStrength = rimStrength;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uRimColor = { value: rimColor };
    shader.uniforms.uRimStrength = rimStrength;
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <common>",
      "#include <common>\nuniform vec3 uRimColor;\nuniform float uRimStrength;"
    ).replace(
      "#include <emissivemap_fragment>",
      `#include <emissivemap_fragment>
{
	float rimNdotV = clamp( dot( normalize( normal ), normalize( vViewPosition ) ), 0.0, 1.0 );
	float rimFactor = pow( 1.0 - rimNdotV, 3.0 );
	totalEmissiveRadiance += uRimColor * rimFactor * uRimStrength;
}`
    );
  };
  mat.customProgramCacheKey = () => ARMOR_FRESNEL_CACHE_KEY;
}
function getMaterials() {
  if (cachedMaterials) return cachedMaterials;
  const makeArmor = (rimHex, rimK, emissiveHex = PALETTE.robotEdge, emissiveInt = ARMOR_EMISSIVE_INTENSITY) => {
    const mat = new THREE.MeshStandardMaterial({
      color: PALETTE.robotArmor,
      emissive: emissiveHex,
      emissiveIntensity: emissiveInt,
      metalness: 0.86,
      roughness: 0.26,
      envMapIntensity: 2.9,
      vertexColors: true
    });
    applyArmorFresnel(mat, rimHex, { value: rimK });
    return mat;
  };
  const makeGlow = (hex) => new THREE.MeshStandardMaterial({
    color: hex,
    emissive: hex,
    emissiveIntensity: 4.4,
    metalness: 0.85,
    roughness: 0.2,
    envMapIntensity: 1.4
  });
  const makeEdgeTrim = (hex) => new THREE.MeshStandardMaterial({
    color: PALETTE.robotEdge,
    emissive: hex,
    emissiveIntensity: 0.55,
    metalness: 0.92,
    roughness: 0.22,
    envMapIntensity: 2.2
  });
  const makeEdgeLine = (hex) => {
    const col = new THREE.Color(PALETTE.robotEdge).lerp(new THREE.Color(hex), 0.48);
    return new THREE.LineBasicMaterial({
      color: col,
      transparent: true,
      opacity: 0.82
    });
  };
  const visorGlowTex = createVisorGlowTexture();
  const makeVisorHalo = (hex, opacity) => new THREE.SpriteMaterial({
    map: visorGlowTex,
    color: hex,
    blending: THREE.AdditiveBlending,
    transparent: true,
    opacity,
    depthWrite: false,
    depthTest: true,
    fog: false,
    toneMapped: false
  });
  const visorFlash = new THREE.MeshStandardMaterial({
    color: PALETTE.robotHitFlash,
    emissive: PALETTE.robotHitFlash,
    emissiveIntensity: 4.8,
    metalness: 0.85,
    roughness: 0.2
  });
  cachedMaterials = {
    armor: {
      enemy: makeArmor(PALETTE.robotGlowEnemy, ARMOR_FRESNEL_K.enemy),
      ally: makeArmor(PALETTE.robotGlowAlly, ARMOR_FRESNEL_K.ally)
    },
    armorHitFlash: makeArmor(PALETTE.robotHitFlash, ARMOR_HIT_FRESNEL_K, PALETTE.robotHitFlash, 0.42),
    glow: {
      enemy: makeGlow(PALETTE.robotGlowEnemy),
      ally: makeGlow(PALETTE.robotGlowAlly)
    },
    edgeTrim: {
      enemy: makeEdgeTrim(PALETTE.robotGlowEnemy),
      ally: makeEdgeTrim(PALETTE.robotGlowAlly)
    },
    edgeLine: {
      enemy: makeEdgeLine(PALETTE.robotGlowEnemy),
      ally: makeEdgeLine(PALETTE.robotGlowAlly)
    },
    visorFlash,
    visorHalo: {
      enemy: makeVisorHalo(PALETTE.robotGlowEnemy, VISOR_HALO_OPACITY),
      ally: makeVisorHalo(PALETTE.robotGlowAlly, VISOR_HALO_OPACITY)
    },
    visorHaloFlash: makeVisorHalo(PALETTE.robotHitFlash, 0.98),
    visorGlowTex,
    flashTex: createFlashTexture()
  };
  return cachedMaterials;
}
var TINT_ARMOR = [1, 1, 1];
var TINT_ARMOR_HI = [1.75, 1.82, 1.95];
var TINT_FRAME = [0.62, 0.66, 0.74];
var TINT_GUN = [1.35, 1.42, 1.52];
function buildUpperArm(side) {
  const pauldronMain = makePart(
    new THREE.BoxGeometry(0.15, 0.125, 0.21),
    [side * 0.045, 0.025, 0],
    [0, 0, -side * 0.32],
    TINT_ARMOR
  );
  const pauldronWing = makePart(
    new THREE.BoxGeometry(0.06, 0.14, 0.175),
    [side * 0.105, -0.025, 5e-3],
    [0, 0, -side * 0.14],
    TINT_ARMOR_HI
  );
  const pauldronCap = makePart(
    new THREE.BoxGeometry(0.12, 0.032, 0.16),
    [side * 0.03, 0.092, 0],
    [0, 0, -side * 0.28],
    TINT_ARMOR_HI
  );
  const armorPlates = mergeStrict([pauldronMain.clone(), pauldronWing.clone(), pauldronCap.clone()]);
  const edgeLine = new THREE.EdgesGeometry(armorPlates, 26);
  armorPlates.dispose();
  const armor = mergeStrict([
    pauldronMain,
    pauldronWing,
    pauldronCap,
    // Mechanical shoulder ball joint
    makePart(new THREE.CylinderGeometry(0.052, 0.052, 0.1, 8), [0, -0.01, 0], [0, 0, Math.PI / 2], TINT_FRAME),
    // Inner hydraulic bicep strut
    makePart(new THREE.CylinderGeometry(0.036, 0.032, 0.22, 8), [side * 0.01, -0.14, 0], [0, 0, 0], TINT_FRAME),
    // Outer split bicep guard
    makePart(new THREE.BoxGeometry(0.068, 0.15, 0.095), [side * 0.042, -0.145, 0], [0, 0, -side * 0.08], TINT_ARMOR),
    // Elbow hinge drum
    makePart(new THREE.CylinderGeometry(0.038, 0.038, 0.085, 8), [side * 0.01, -0.25, 0], [0, 0, Math.PI / 2], TINT_FRAME)
  ]);
  const glow = makePart(
    new THREE.BoxGeometry(0.02, 0.016, 0.165),
    [side * 0.085, 0.062, 0],
    [0, 0, -side * 0.28],
    TINT_ARMOR
  );
  return { armor, edgeLine, glow };
}
function buildForearm(side) {
  return mergeStrict([
    // Inner mechanical wrist strut
    makePart(new THREE.CylinderGeometry(0.032, 0.026, 0.23, 8), [0, -0.125, 0], [0, 0, 0], TINT_FRAME),
    // Split outer cyber gauntlet plate
    makePart(new THREE.BoxGeometry(0.072, 0.19, 0.098), [side * 0.022, -0.125, -8e-3], [0, 0, -side * 0.06], TINT_ARMOR),
    // Dorsal knuckle/cuff armor ridge
    makePart(new THREE.BoxGeometry(0.056, 0.12, 0.042), [side * 0.016, -0.14, -0.052], [0.08, 0, 0], TINT_ARMOR_HI),
    // Cyber mechanical hand clamp
    makePart(new THREE.BoxGeometry(0.058, 0.072, 0.068), [0, -0.255, -0.012], [0, 0, 0], TINT_FRAME)
  ]);
}
function buildThigh(side) {
  return mergeStrict([
    // Inner structural femur actuator
    makePart(new THREE.CylinderGeometry(0.052, 0.042, 0.41, 8), [0, -0.21, 0], [0, 0, 0], TINT_FRAME),
    // Front split thigh armor plate
    makePart(new THREE.BoxGeometry(0.115, 0.3, 0.105), [side * 0.012, -0.2, -0.028], [-0.06, 0, 0], TINT_ARMOR),
    // Outer angled thigh side-plate
    makePart(new THREE.BoxGeometry(0.052, 0.26, 0.13), [side * 0.068, -0.19, 5e-3], [0, 0, -side * 0.08], TINT_ARMOR_HI),
    // Rear hydraulic thigh guard
    makePart(new THREE.BoxGeometry(0.088, 0.22, 0.065), [0, -0.2, 0.055], [0.06, 0, 0], TINT_ARMOR)
  ]);
}
function buildShin(side) {
  const kneeCap = makePart(
    new THREE.BoxGeometry(0.096, 0.11, 0.075),
    [0, -0.015, -0.062],
    [0.22, 0, 0],
    TINT_ARMOR_HI
  );
  const greaveFront = makePart(
    new THREE.BoxGeometry(0.105, 0.31, 0.095),
    [side * 8e-3, -0.22, -0.032],
    [0.06, 0, 0],
    TINT_ARMOR
  );
  const greaveSide = makePart(
    new THREE.BoxGeometry(0.044, 0.27, 0.11),
    [side * 0.058, -0.215, 4e-3],
    [0, 0, -side * 0.05],
    TINT_ARMOR_HI
  );
  const plateBundle = mergeStrict([kneeCap.clone(), greaveFront.clone(), greaveSide.clone()]);
  const edgeLine = new THREE.EdgesGeometry(plateBundle, 26);
  plateBundle.dispose();
  const armor = mergeStrict([
    kneeCap,
    greaveFront,
    greaveSide,
    // Knee rotary drum
    makePart(new THREE.CylinderGeometry(0.046, 0.046, 0.1, 8), [0, 0, 0], [0, 0, Math.PI / 2], TINT_FRAME),
    // Inner shin strut & rear piston
    makePart(new THREE.CylinderGeometry(0.038, 0.032, 0.4, 8), [0, -0.21, 0.012], [0, 0, 0], TINT_FRAME),
    makePart(new THREE.CylinderGeometry(0.018, 0.016, 0.3, 6), [0, -0.22, 0.068], [-0.08, 0, 0], TINT_FRAME)
  ]);
  return { armor, edgeLine };
}
function getGeometries() {
  if (cachedGeometries) return cachedGeometries;
  const pelvis = mergeStrict([
    makePart(new THREE.BoxGeometry(0.26, 0.11, 0.18), [0, 0, 0], [0, 0, 0], TINT_FRAME),
    // Split front/rear waist armor skirts
    makePart(new THREE.BoxGeometry(0.15, 0.125, 0.055), [0, -0.01, -0.098], [0.16, 0, 0], TINT_ARMOR),
    makePart(new THREE.BoxGeometry(0.16, 0.1, 0.05), [0, 5e-3, 0.095], [-0.14, 0, 0], TINT_ARMOR),
    // Hip flank guards
    makePart(new THREE.BoxGeometry(0.045, 0.09, 0.15), [-0.145, 0.01, 0], [0, 0, 0.18], TINT_ARMOR_HI),
    makePart(new THREE.BoxGeometry(0.045, 0.09, 0.15), [0.145, 0.01, 0], [0, 0, -0.18], TINT_ARMOR_HI),
    // Hip axle cylinders
    makePart(new THREE.CylinderGeometry(0.044, 0.044, 0.29, 8), [0, -0.02, 0], [0, 0, Math.PI / 2], TINT_FRAME)
  ]);
  const chestL = makePart(
    new THREE.BoxGeometry(0.175, 0.21, 0.13),
    [-0.102, 0.27, -0.082],
    [-0.14, 0.22, 0.06],
    TINT_ARMOR
  );
  const chestR = makePart(
    new THREE.BoxGeometry(0.175, 0.21, 0.13),
    [0.102, 0.27, -0.082],
    [-0.14, -0.22, -0.06],
    TINT_ARMOR
  );
  const chestUpperL = makePart(
    new THREE.BoxGeometry(0.16, 0.075, 0.16),
    [-0.105, 0.375, -0.02],
    [0.18, 0.12, 0.12],
    TINT_ARMOR_HI
  );
  const chestUpperR = makePart(
    new THREE.BoxGeometry(0.16, 0.075, 0.16),
    [0.105, 0.375, -0.02],
    [0.18, -0.12, -0.12],
    TINT_ARMOR_HI
  );
  const ribL = makePart(
    new THREE.BoxGeometry(0.085, 0.16, 0.18),
    [-0.155, 0.145, -0.01],
    [0, 0.08, -0.1],
    TINT_ARMOR
  );
  const ribR = makePart(
    new THREE.BoxGeometry(0.085, 0.16, 0.18),
    [0.155, 0.145, -0.01],
    [0, -0.08, 0.1],
    TINT_ARMOR
  );
  const collarL = makePart(new THREE.BoxGeometry(0.045, 0.065, 0.17), [-0.105, 0.425, 0.01], [0, 0, -0.22], TINT_ARMOR_HI);
  const collarR = makePart(new THREE.BoxGeometry(0.045, 0.065, 0.17), [0.105, 0.425, 0.01], [0, 0, 0.22], TINT_ARMOR_HI);
  const collarRear = makePart(new THREE.BoxGeometry(0.19, 0.078, 0.045), [0, 0.435, 0.095], [0.22, 0, 0], TINT_ARMOR_HI);
  const packTop = makePart(new THREE.BoxGeometry(0.24, 0.065, 0.14), [0, 0.375, 0.16], [-0.18, 0, 0], TINT_ARMOR);
  const packBot = makePart(new THREE.BoxGeometry(0.2, 0.06, 0.12), [0, 0.115, 0.145], [0.2, 0, 0], TINT_ARMOR);
  const packFinL = makePart(new THREE.BoxGeometry(0.042, 0.24, 0.135), [-0.115, 0.245, 0.175], [0, -0.18, -0.06], TINT_ARMOR_HI);
  const packFinR = makePart(new THREE.BoxGeometry(0.042, 0.24, 0.135), [0.115, 0.245, 0.175], [0, 0.18, 0.06], TINT_ARMOR_HI);
  const torsoArmorPlates = mergeStrict([
    chestL.clone(),
    chestR.clone(),
    chestUpperL.clone(),
    chestUpperR.clone(),
    ribL.clone(),
    ribR.clone(),
    collarL.clone(),
    collarR.clone(),
    collarRear.clone(),
    packTop.clone(),
    packBot.clone(),
    packFinL.clone(),
    packFinR.clone()
  ]);
  const torsoEdgeLine = new THREE.EdgesGeometry(torsoArmorPlates, 26);
  torsoArmorPlates.dispose();
  const torsoArmor = mergeStrict([
    chestL,
    chestR,
    chestUpperL,
    chestUpperR,
    ribL,
    ribR,
    collarL,
    collarR,
    collarRear,
    packTop,
    packBot,
    packFinL,
    packFinR,
    // Inner mechanical spine & core block
    makePart(new THREE.BoxGeometry(0.22, 0.34, 0.18), [0, 0.21, 0.01], [0, 0, 0], TINT_FRAME),
    // Segmented abdomen hydraulic plates
    makePart(new THREE.BoxGeometry(0.16, 0.055, 0.08), [0, 0.06, -0.075], [0.08, 0, 0], TINT_FRAME),
    makePart(new THREE.BoxGeometry(0.18, 0.055, 0.09), [0, 0.125, -0.085], [0.04, 0, 0], TINT_ARMOR),
    // Back core containment rings (dark metallic bands around glowing cylinder)
    makePart(new THREE.CylinderGeometry(0.074, 0.074, 0.022, 10), [0, 0.3, 0.195], [0, 0, 0], TINT_FRAME),
    makePart(new THREE.CylinderGeometry(0.074, 0.074, 0.022, 10), [0, 0.245, 0.195], [0, 0, 0], TINT_FRAME),
    makePart(new THREE.CylinderGeometry(0.074, 0.074, 0.022, 10), [0, 0.19, 0.195], [0, 0, 0], TINT_FRAME)
  ]);
  const torsoEdgeTrim = mergeStrict([
    makePart(new THREE.BoxGeometry(0.155, 0.012, 0.014), [-0.105, 0.365, -0.145], [0, 0.22, 0.06], TINT_ARMOR),
    makePart(new THREE.BoxGeometry(0.155, 0.012, 0.014), [0.105, 0.365, -0.145], [0, -0.22, -0.06], TINT_ARMOR),
    makePart(new THREE.BoxGeometry(0.014, 0.22, 0.014), [-0.135, 0.245, 0.238], [0, 0, -0.06], TINT_ARMOR),
    makePart(new THREE.BoxGeometry(0.014, 0.22, 0.014), [0.135, 0.245, 0.238], [0, 0, 0.06], TINT_ARMOR)
  ]);
  const torsoGlow = mergeStrict([
    // Main back energy core cylinder (bold & unmistakable from rear & 3/4 angles!)
    makePart(new THREE.CylinderGeometry(0.074, 0.074, 0.26, 12), [0, 0.245, 0.205], [0, 0, 0], TINT_ARMOR),
    // Dual exposed side core conduit vents (visible from side & 3/4 front angles!)
    makePart(new THREE.BoxGeometry(0.028, 0.185, 0.048), [-0.148, 0.255, 0.148], [0, 0, -0.08], TINT_ARMOR),
    makePart(new THREE.BoxGeometry(0.028, 0.185, 0.048), [0.148, 0.255, 0.148], [0, 0, 0.08], TINT_ARMOR),
    // Front sternum vertical power slit between split chest plates
    makePart(new THREE.BoxGeometry(0.026, 0.15, 0.03), [0, 0.275, -0.128], [-0.12, 0, 0], TINT_ARMOR),
    // Magnetic levitation emitter ring inside neck collar (reinforces floating head!)
    makePart(new THREE.CylinderGeometry(0.07, 0.074, 0.02, 12, 1, true), [0, 0.408, 0], [0, 0, 0], TINT_ARMOR)
  ]);
  const helmCrown = makePart(new THREE.BoxGeometry(0.165, 0.085, 0.22), [0, 0.075, 8e-3], [0.12, 0, 0], TINT_ARMOR_HI);
  const helmFace = makePart(new THREE.BoxGeometry(0.17, 0.095, 0.19), [0, -0.015, 5e-3], [0, 0, 0], TINT_ARMOR);
  const helmJaw = makePart(new THREE.BoxGeometry(0.125, 0.055, 0.155), [0, -0.075, -5e-3], [-0.14, 0, 0], TINT_ARMOR);
  const helmBack = makePart(new THREE.BoxGeometry(0.13, 0.11, 0.09), [0, 0.04, 0.115], [-0.32, 0, 0], TINT_ARMOR_HI);
  const earFinL = makePart(new THREE.BoxGeometry(0.022, 0.105, 0.08), [-0.096, 0.035, 0.035], [-0.35, 0, 0.12], TINT_ARMOR_HI);
  const earFinR = makePart(new THREE.BoxGeometry(0.022, 0.105, 0.08), [0.096, 0.035, 0.035], [-0.35, 0, -0.12], TINT_ARMOR_HI);
  const headPlates = mergeStrict([
    helmCrown.clone(),
    helmFace.clone(),
    helmJaw.clone(),
    helmBack.clone(),
    earFinL.clone(),
    earFinR.clone()
  ]);
  const headEdgeLine = new THREE.EdgesGeometry(headPlates, 26);
  headPlates.dispose();
  const headArmor = mergeStrict([
    helmCrown,
    helmFace,
    helmJaw,
    helmBack,
    earFinL,
    earFinR,
    // Dark recessed visor channel behind glowing horizontal band
    makePart(new THREE.BoxGeometry(0.178, 0.052, 0.05), [0, 8e-3, -0.076], [0, 0, 0], TINT_FRAME),
    // Underside magnetic hover base plate (floating gap visible below this!)
    makePart(new THREE.CylinderGeometry(0.048, 0.038, 0.018, 10), [0, -0.105, 0], [0, 0, 0], TINT_FRAME)
  ]);
  const headVisor = mergeStrict([
    makePart(new THREE.BoxGeometry(0.186, 0.042, 0.026), [0, 8e-3, -0.1], [0, 0, 0], TINT_ARMOR),
    // Wraparound temple light accents
    makePart(new THREE.BoxGeometry(0.02, 0.032, 0.074), [-0.09, 8e-3, -0.062], [0, 0, 0], TINT_ARMOR),
    makePart(new THREE.BoxGeometry(0.02, 0.032, 0.074), [0.09, 8e-3, -0.062], [0, 0, 0], TINT_ARMOR)
  ]);
  const upperL = buildUpperArm(-1);
  const upperR = buildUpperArm(1);
  upperL.edgeLine.dispose();
  upperR.edgeLine.dispose();
  upperL.glow.dispose();
  upperR.glow.dispose();
  const forearmL = buildForearm(-1);
  const forearmR = buildForearm(1);
  const weaponBody = mergeStrict([
    // Main angular receiver
    makePart(new THREE.BoxGeometry(0.058, 0.095, 0.42), [0, 0.01, -0.22], [0, 0, 0], TINT_GUN),
    // Forward rail barrel shroud
    makePart(new THREE.BoxGeometry(0.046, 0.068, 0.28), [0, 0.018, -0.52], [0, 0, 0], TINT_ARMOR_HI),
    // Inner barrel cylinder
    makePart(new THREE.CylinderGeometry(0.015, 0.015, 0.24, 8), [0, 0.02, -0.62], [Math.PI / 2, 0, 0], TINT_FRAME),
    // Buttstock
    makePart(new THREE.BoxGeometry(0.046, 0.082, 0.18), [0, -5e-3, 0.05], [0, 0, 0], TINT_ARMOR),
    // Slanted energy magazine
    makePart(new THREE.BoxGeometry(0.036, 0.15, 0.062), [0, -0.09, -0.26], [0.2, 0, 0], TINT_FRAME),
    // Pistol grip
    makePart(new THREE.BoxGeometry(0.034, 0.095, 0.045), [0, -0.068, -0.07], [-0.26, 0, 0], TINT_FRAME),
    // Holographic sight hood
    makePart(new THREE.BoxGeometry(0.042, 0.038, 0.095), [0, 0.074, -0.18], [0, 0, 0], TINT_ARMOR_HI)
  ]);
  const weaponGlow = mergeStrict([
    // Glowing faction plasma rails along left & right sides of barrel shroud
    makePart(new THREE.BoxGeometry(0.054, 0.013, 0.34), [0, 0.025, -0.44], [0, 0, 0], TINT_ARMOR),
    // Sight reticle emitter
    makePart(new THREE.BoxGeometry(0.024, 0.014, 0.016), [0, 0.076, -0.18], [0, 0, 0], TINT_ARMOR)
  ]);
  const thighL = buildThigh(-1);
  const thighR = buildThigh(1);
  const shinL = buildShin(-1);
  const shinR = buildShin(1);
  shinL.edgeLine.dispose();
  shinR.edgeLine.dispose();
  const foot = mergeStrict([
    // Main cyber sole (bottom at y = -0.080)
    makePart(new THREE.BoxGeometry(0.11, 0.042, 0.24), [0, -0.059, -0.035], [0, 0, 0], TINT_FRAME),
    // Split armored toe hood
    makePart(new THREE.BoxGeometry(0.105, 0.052, 0.135), [0, -0.028, -0.078], [0.2, 0, 0], TINT_ARMOR),
    // Heel stabilizer spur
    makePart(new THREE.BoxGeometry(0.088, 0.058, 0.085), [0, -0.036, 0.055], [-0.14, 0, 0], TINT_ARMOR_HI)
  ]);
  const muzzleQuad = new THREE.PlaneGeometry(0.38, 0.38);
  const totalTris = countGeoTris(pelvis) + countGeoTris(torsoArmor) + countGeoTris(torsoEdgeTrim) + countGeoTris(torsoGlow) + countGeoTris(headArmor) + countGeoTris(headVisor) + countGeoTris(upperL.armor) + countGeoTris(upperR.armor) + countGeoTris(forearmL) + countGeoTris(forearmR) + countGeoTris(weaponBody) + countGeoTris(weaponGlow) + countGeoTris(thighL) + countGeoTris(thighR) + countGeoTris(shinL.armor) + countGeoTris(shinR.armor) + countGeoTris(foot) * 2 + 2;
  cachedGeometries = {
    pelvis,
    torsoArmor,
    torsoEdgeTrim,
    torsoEdgeLine,
    torsoGlow,
    headArmor,
    headEdgeLine,
    headVisor,
    upperArmL: upperL.armor,
    upperArmR: upperR.armor,
    forearmL,
    forearmR,
    weaponBody,
    weaponGlow,
    thighL,
    thighR,
    shinL: shinL.armor,
    shinR: shinR.armor,
    foot,
    muzzleQuad,
    totalTris
  };
  return cachedGeometries;
}
function createRobot(faction = "enemy") {
  const mats = getMaterials();
  const geos = getGeometries();
  const armorMat = mats.armor[faction];
  const glowMat = mats.glow[faction];
  const edgeTrimMat = mats.edgeTrim[faction];
  const edgeLineMat = mats.edgeLine[faction];
  const visorHaloMat = mats.visorHalo[faction];
  const factionGlowHex = faction === "enemy" ? PALETTE.robotGlowEnemy : PALETTE.robotGlowAlly;
  const root = new THREE.Group();
  root.name = `cyber-robot-${faction}`;
  const bodyMeshes = [];
  const armorMeshes = [];
  const glowMeshes = [];
  const edgeLines = [];
  const addMesh = (parent, geo, mat, isGlow = false, castShadow = true) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = castShadow;
    m.receiveShadow = true;
    m.frustumCulled = false;
    parent.add(m);
    if (isGlow) glowMeshes.push(m);
    else {
      bodyMeshes.push(m);
      if (mat === armorMat) armorMeshes.push(m);
    }
    return m;
  };
  const addEdge = (parent, geo) => {
    const ls = new THREE.LineSegments(geo, edgeLineMat);
    ls.frustumCulled = false;
    parent.add(ls);
    edgeLines.push(ls);
  };
  const bodyPivot = new THREE.Group();
  bodyPivot.name = "robot-body";
  bodyPivot.position.set(0, 0.96, 0);
  root.add(bodyPivot);
  addMesh(bodyPivot, geos.pelvis, armorMat);
  const torsoPivot = new THREE.Group();
  torsoPivot.name = "robot-torso";
  torsoPivot.position.set(0, 0.08, 0);
  bodyPivot.add(torsoPivot);
  addMesh(torsoPivot, geos.torsoArmor, armorMat);
  addMesh(torsoPivot, geos.torsoEdgeTrim, edgeTrimMat, false, false);
  addMesh(torsoPivot, geos.torsoGlow, glowMat, true, false);
  addEdge(torsoPivot, geos.torsoEdgeLine);
  const headPivot = new THREE.Group();
  headPivot.name = "robot-head";
  headPivot.position.set(0, 0.56, 0);
  torsoPivot.add(headPivot);
  addMesh(headPivot, geos.headArmor, armorMat);
  addEdge(headPivot, geos.headEdgeLine);
  const visorMesh = addMesh(headPivot, geos.headVisor, glowMat, true, false);
  visorMesh.name = "robot-visor";
  const visorHalo = new THREE.Sprite(visorHaloMat);
  visorHalo.name = "robot-visor-halo";
  visorHalo.position.set(0, 8e-3, -0.124);
  visorHalo.scale.set(0.46, 0.24, 1);
  visorHalo.frustumCulled = false;
  visorHalo.renderOrder = 2;
  headPivot.add(visorHalo);
  const headTopAnchor = new THREE.Object3D();
  headTopAnchor.position.set(0, 0.16, 0);
  headPivot.add(headTopAnchor);
  const shoulderL = new THREE.Group();
  shoulderL.name = "robot-shoulder-l";
  shoulderL.position.set(-0.245, 0.34, 0);
  torsoPivot.add(shoulderL);
  addMesh(shoulderL, geos.upperArmL, armorMat, false, false);
  const elbowL = new THREE.Group();
  elbowL.name = "robot-elbow-l";
  elbowL.position.set(-0.01, -0.25, 0);
  shoulderL.add(elbowL);
  addMesh(elbowL, geos.forearmL, armorMat, false, false);
  const shoulderR = new THREE.Group();
  shoulderR.name = "robot-shoulder-r";
  shoulderR.position.set(0.245, 0.34, 0);
  torsoPivot.add(shoulderR);
  addMesh(shoulderR, geos.upperArmR, armorMat, false, false);
  const elbowR = new THREE.Group();
  elbowR.name = "robot-elbow-r";
  elbowR.position.set(0.01, -0.25, 0);
  shoulderR.add(elbowR);
  addMesh(elbowR, geos.forearmR, armorMat, false, false);
  const weaponMount = new THREE.Group();
  weaponMount.name = "robot-weapon";
  weaponMount.position.set(-0.01, -0.24, -0.02);
  elbowR.add(weaponMount);
  addMesh(weaponMount, geos.weaponBody, armorMat, false, false);
  addMesh(weaponMount, geos.weaponGlow, glowMat, true, false);
  const muzzleAnchor = new THREE.Object3D();
  muzzleAnchor.position.set(0, 0.02, -0.76);
  weaponMount.add(muzzleAnchor);
  const muzzleMat = new THREE.MeshBasicMaterial({
    map: mats.flashTex,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide
  });
  const muzzleMesh = new THREE.Mesh(geos.muzzleQuad, muzzleMat);
  muzzleMesh.position.set(0, 0.02, -0.78);
  muzzleMesh.visible = false;
  muzzleMesh.frustumCulled = false;
  weaponMount.add(muzzleMesh);
  const hipL = new THREE.Group();
  hipL.name = "robot-hip-l";
  hipL.position.set(-0.115, -0.02, 0);
  bodyPivot.add(hipL);
  addMesh(hipL, geos.thighL, armorMat, false, true);
  const kneeL = new THREE.Group();
  kneeL.name = "robot-knee-l";
  kneeL.position.set(0, -0.44, 0);
  hipL.add(kneeL);
  addMesh(kneeL, geos.shinL, armorMat, false, false);
  const ankleL = new THREE.Group();
  ankleL.name = "robot-ankle-l";
  ankleL.position.set(0, -0.42, 0);
  kneeL.add(ankleL);
  addMesh(ankleL, geos.foot, armorMat, false, false);
  const soleProbeL = new THREE.Object3D();
  soleProbeL.position.set(0, -0.08, -0.02);
  ankleL.add(soleProbeL);
  const hipR = new THREE.Group();
  hipR.name = "robot-hip-r";
  hipR.position.set(0.115, -0.02, 0);
  bodyPivot.add(hipR);
  addMesh(hipR, geos.thighR, armorMat, false, true);
  const kneeR = new THREE.Group();
  kneeR.name = "robot-knee-r";
  kneeR.position.set(0, -0.44, 0);
  hipR.add(kneeR);
  addMesh(kneeR, geos.shinR, armorMat, false, false);
  const ankleR = new THREE.Group();
  ankleR.name = "robot-ankle-r";
  ankleR.position.set(0, -0.42, 0);
  kneeR.add(ankleR);
  addMesh(ankleR, geos.foot, armorMat, false, false);
  const soleProbeR = new THREE.Object3D();
  soleProbeR.position.set(0, -0.08, -0.02);
  ankleR.add(soleProbeR);
  let hitFlashOn = false;
  let fadeClones = null;
  let fadeRimStrength = null;
  const setHitFlash = (active) => {
    if (fadeClones) return;
    if (active === hitFlashOn) return;
    hitFlashOn = active;
    visorMesh.material = active ? mats.visorFlash : glowMat;
    visorHalo.material = active ? mats.visorHaloFlash : visorHaloMat;
    const targetArmor = active ? mats.armorHitFlash : armorMat;
    for (const m of armorMeshes) {
      m.material = targetArmor;
    }
  };
  const setDeathFade = (opacity) => {
    const a = Math.max(0, Math.min(1, opacity));
    if (!fadeClones) {
      hitFlashOn = false;
      const fArmor2 = armorMat.clone();
      fArmor2.transparent = true;
      fArmor2.depthWrite = false;
      const fRimStrength = { value: ARMOR_FRESNEL_K[faction] };
      applyArmorFresnel(fArmor2, factionGlowHex, fRimStrength);
      const fTrim2 = edgeTrimMat.clone();
      fTrim2.transparent = true;
      fTrim2.depthWrite = false;
      const fGlow2 = glowMat.clone();
      fGlow2.transparent = true;
      fGlow2.depthWrite = false;
      const fLine2 = edgeLineMat.clone();
      fLine2.transparent = true;
      const fHalo2 = visorHaloMat.clone();
      fHalo2.transparent = true;
      fHalo2.depthWrite = false;
      fadeClones = [fArmor2, fTrim2, fGlow2, fLine2, fHalo2];
      fadeRimStrength = fRimStrength;
      for (const m of bodyMeshes) {
        m.material = m.material === edgeTrimMat ? fTrim2 : fArmor2;
      }
      for (const m of glowMeshes) {
        m.material = fGlow2;
      }
      for (const ls of edgeLines) {
        ls.material = fLine2;
      }
      visorHalo.material = fHalo2;
    }
    const [fArmor, fTrim, fGlow, fLine, fHalo] = fadeClones;
    fArmor.opacity = a;
    fArmor.emissiveIntensity = ARMOR_EMISSIVE_INTENSITY * a;
    if (fadeRimStrength) fadeRimStrength.value = ARMOR_FRESNEL_K[faction] * a;
    fTrim.opacity = a;
    fTrim.emissiveIntensity = 0.55 * a;
    fGlow.opacity = a;
    fGlow.emissiveIntensity = 0.45 * a;
    fLine.opacity = 0.62 * a;
    fHalo.opacity = VISOR_HALO_OPACITY * a;
  };
  const dispose = () => {
    muzzleMat.dispose();
    if (fadeClones) {
      for (const m of fadeClones) m.dispose();
      fadeClones = null;
      fadeRimStrength = null;
    }
  };
  return {
    root,
    faction,
    joints: {
      bodyPivot,
      torsoPivot,
      headPivot,
      shoulderL,
      elbowL,
      shoulderR,
      elbowR,
      weaponMount,
      hipL,
      kneeL,
      ankleL,
      hipR,
      kneeR,
      ankleR
    },
    visorMesh,
    visorHalo,
    glowMeshes,
    edgeLines,
    bodyMeshes,
    headTopAnchor,
    muzzleAnchor,
    muzzleMesh,
    muzzleMat,
    soleProbeL,
    soleProbeR,
    triangleCount: geos.totalTris,
    setHitFlash,
    setDeathFade,
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
var HIT_FLASH_MS = 120;
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
function clamp01(v) {
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
function classifyBossHitPart(hitPoint, bossPos, bossYaw, height = BOSS_TARGET_HEIGHT) {
  const relY = hitPoint.y - bossPos.y;
  if (relY > height * BOSS_HEAD_RATIO) {
    return "head";
  }
  const coreY = bossPos.y + height * BOSS_CORE_HEIGHT_RATIO;
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
function raycastBoss(ray, bossPos, bossYaw, alive, height = BOSS_TARGET_HEIGHT) {
  if (!alive) return null;
  const tCapsule = rayVerticalCapsuleT(ray.origin, ray.dir, bossPos, BOSS_BODY_RADIUS, height);
  const headCenterY = bossPos.y + height * 0.9;
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
  const part = tHead <= tCapsule + EPS4 && point.y - bossPos.y > height * BOSS_HEAD_RATIO ? "head" : classifyBossHitPart(point, bossPos, bossYaw, height);
  return { dist: bestT, point, part };
}
function defaultBossPose() {
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
    ankleRX: 0.14
  };
}
var BossController = class {
  mesh;
  ai;
  height = BOSS_TARGET_HEIGHT;
  attackRange;
  meleeDamage;
  scene;
  opts;
  robot;
  shadowMesh;
  shadowMat;
  bossScale = 1;
  origin;
  worldPos;
  currentYaw = 0;
  cachedTick;
  lastEventsArr = [];
  pose = defaultBossPose();
  targetPose = defaultBossPose();
  animTime = 0;
  walkPhase = 0;
  stateElapsedSec = 0;
  prevState = "idle";
  hitRecoilTimerMs = 0;
  hitFlashTimerMs = 0;
  currentRecoilZ = 0;
  deadStarted = false;
  deadElapsedSec = 0;
  deathFadeApplied = false;
  disposed = false;
  _hitsTaken = 0;
  _meleeHitsDealt = 0;
  _lastHitPart = null;
  _lastReportedPhase = 1;
  tmpSoleL = new THREE2.Vector3();
  tmpSoleR = new THREE2.Vector3();
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
    this.robot = this.buildPlaceholderRobot();
    this.mesh.add(this.robot.root);
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
    this.applyJoints();
    this.groundFeet();
  }
  buildPlaceholderRobot() {
    const robot = createRobot("enemy");
    robot.root.name = "boss-placeholder-robot";
    robot.joints.weaponMount.visible = false;
    robot.muzzleMesh.visible = false;
    robot.root.updateMatrixWorld(true);
    const box2 = new THREE2.Box3().setFromObject(robot.root);
    const rawH = !box2.isEmpty() && Number.isFinite(box2.max.y - box2.min.y) ? box2.max.y - box2.min.y : 1.73;
    this.bossScale = BOSS_TARGET_HEIGHT / Math.max(0.5, rawH);
    robot.root.scale.setScalar(this.bossScale);
    return robot;
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
    return this.robot.triangleCount;
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
    return raycastBoss(ray, this.worldPos, this.currentYaw, this.alive, this.height);
  }
  applyDamage(amount, part) {
    if (this.disposed || !this.alive) return { dealt: 0, dead: false };
    const wasAlive = this.alive;
    const dealt = this.ai.applyDamage(amount, part);
    if (dealt <= 0) return { dealt: 0, dead: false };
    this._hitsTaken++;
    this._lastHitPart = part;
    this.hitRecoilTimerMs = BOSS_HIT_RECOIL_MS;
    this.hitFlashTimerMs = HIT_FLASH_MS;
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
    const moved = Math.hypot(this.worldPos.x - prevX, this.worldPos.z - prevZ);
    if (moved > 1e-4) {
      this.walkPhase += moved * (tick.state === "charge" ? 2.1 : 1.5);
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
    this.prevState = "idle";
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
      Math.hypot(pPos.x - this.worldPos.x, pPos.z - this.worldPos.z)
    );
    this.applyJoints();
    this.groundFeet();
  }
  setVisible(visible) {
    this.robot.root.visible = visible;
  }
  getFeetWorldY() {
    this.mesh.updateMatrixWorld(true);
    const box2 = new THREE2.Box3().setFromObject(this.robot.root);
    if (box2.isEmpty() || !Number.isFinite(box2.min.y)) return null;
    return box2.min.y;
  }
  projectScreenBounds(camera, vw, vh) {
    this.mesh.updateMatrixWorld(true);
    const box2 = new THREE2.Box3().setFromObject(this.robot.root);
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
    if (state !== this.prevState) {
      this.prevState = state;
      this.stateElapsedSec = 0;
    } else {
      this.stateElapsedSec += dtSec;
    }
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
    const dampRate = state === "attack" ? 32 : this.hitRecoilTimerMs > 0 ? 34 : 15;
    for (const k of Object.keys(this.pose)) {
      this.pose[k] = dampVal(this.pose[k], this.targetPose[k], dampRate, dtSec);
    }
    this.applyJoints();
    this.groundFeet();
  }
  computeTargetPose(state) {
    const t = this.targetPose;
    Object.assign(t, defaultBossPose());
    const idleT = this.animTime;
    const hoverBob = Math.sin(idleT * 2.8) * 0.014;
    t.headY = 0.56 + hoverBob;
    if (state === "idle") {
      const breathe = Math.sin(idleT * 1.8) * 0.016;
      t.bodyY = 0.96 + breathe;
      t.torsoPitch = -0.04 + Math.sin(idleT * 1.4) * 0.02;
      t.shLX = 0.28;
      t.shLZ = 0.26;
      t.elLX = 0.52;
      t.shRX = 0.28;
      t.shRZ = -0.26;
      t.elRX = 0.52;
    } else if (state === "chase") {
      const s = Math.sin(this.walkPhase);
      const c = Math.cos(this.walkPhase);
      const p2Boost = this.phase === 2 ? 1.15 : 1;
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
      t.shLX = 0.35 - s * 0.45;
      t.shLZ = 0.28;
      t.elLX = 0.65;
      t.shRX = 0.35 + s * 0.45;
      t.shRZ = -0.28;
      t.elRX = 0.65;
    } else if (state === "windup") {
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
      t.hipRX = -0.2;
      t.hipRZ = -0.12;
      t.kneeRX = -0.28;
    } else if (state === "attack") {
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
      t.elLX = 0.4;
      t.hipLX = 0.38;
      t.kneeLX = -0.48;
      t.hipRX = -0.28;
      t.kneeRX = -0.24;
    } else if (state === "charge") {
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
    } else if (state === "recover") {
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
      t.kneeRX = -0.3;
    }
    if (this.currentRecoilZ > 0) {
      const k = this.currentRecoilZ / BOSS_HIT_RECOIL_DIST;
      t.torsoPitch += k * 0.22;
      t.headPitch += k * 0.14;
      t.bodyY -= k * 0.05;
    }
  }
  advanceDeath(dtSec) {
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
  applyJoints() {
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
  groundFeet() {
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
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.scene.remove(this.mesh);
    this.robot.dispose();
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
test("BossController scales placeholder robot to ~4.0m height and hides ranged weaponMount", () => {
  const scene = new THREE3.Scene();
  const boss = new BossController(scene);
  assert.equal(scene.children.includes(boss.mesh), true);
  boss.mesh.updateMatrixWorld(true);
  const robotRoot = boss.mesh.getObjectByName("boss-placeholder-robot");
  assert.ok(robotRoot, "placeholder robot should exist in mesh");
  const weapon = robotRoot.getObjectByName("robot-weapon");
  assert.ok(weapon, "weaponMount node exists on placeholder");
  assert.equal(weapon.visible, false, "melee Boss must hide placeholder rifle");
  const box2 = new THREE3.Box3().setFromObject(robotRoot);
  const measuredHeight = box2.max.y - box2.min.y;
  assert.ok(
    Math.abs(measuredHeight - BOSS_TARGET_HEIGHT) < 0.25,
    `expected Boss height ~${BOSS_TARGET_HEIGHT}m, got ${measuredHeight.toFixed(2)}m`
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
