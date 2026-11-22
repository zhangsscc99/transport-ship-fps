// src/game/artillery.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE2 from "three";

// src/game/artillery.ts
import * as THREE from "three";

// src/game/collision.ts
var PLAYER_RADIUS = 0.35;
var STEP_HEIGHT = 0.35;
var AIR_WALL_SLIDE_DAMP = 0.35;
var EPS = 1e-4;
var MAX_SUBSTEP = 0.15;
var MAX_STEPS = 64;
var clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function circleHitsRect(x, z, r, b) {
  const qx = clamp(x, b.x - b.w / 2, b.x + b.w / 2);
  const qz = clamp(z, b.z - b.d / 2, b.z + b.d / 2);
  const dx = x - qx;
  const dz = z - qz;
  return dx * dx + dz * dz < r * r - EPS;
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
    const minDistSq = Math.max(0, radius - EPS) ** 2;
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
      } else if (dist < radius - EPS) {
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
      if (y + h <= b.y + EPS || y >= b.y + b.h - EPS) continue;
      if (circleHitsRect(x, z, r, b)) return true;
    }
    return false;
  }
  /** Collect every box the cylinder penetrates at (x,y,z). */
  blockers(x, y, z, r, h, out) {
    out.length = 0;
    for (const b of this.boxes) {
      if (y + h <= b.y + EPS || y >= b.y + b.h - EPS) continue;
      if (circleHitsRect(x, z, r, b)) out.push(b);
    }
  }
  /** Lowest blocker top reachable by an auto-step from feetY (Infinity if none). */
  stepCandidate(blockers, feetY) {
    let best = Infinity;
    for (const b of blockers) {
      const top = b.y + b.h;
      const rise = top - feetY;
      if (rise > -EPS && rise <= STEP_HEIGHT + EPS && top < best) best = top;
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
        } else if (top < Infinity && !this.hits(nx, top + EPS, p.z, radius, height)) {
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
        } else if (top < Infinity && !this.hits(p.x, top + EPS, nz, radius, height)) {
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
          if (top <= p.y + EPS && top >= ny && top > floor) floor = top;
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
          if (b.y >= head0 - EPS && b.y <= head1 && b.y < ceil) ceil = b.y;
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

// src/game/artillery.ts
var ARTILLERY_CONFIG = {
  /** Downward gravitational acceleration g (m/s²) in y(t) = y0 + vy*t - 0.5*g*t^2. */
  gravity: 16,
  /** Ground blast & warning indicator radius (m). Diameter = 6.4m for clear 390x844 readability. */
  blastRadius: 3.2,
  /** Direct AoE damage when player is within blastRadius at impact (player maxHp = 200). */
  damage: 40,
  /** Vertical tolerance (m) for blast hit check above/below impact surface. */
  blastVerticalTolerance: 3.2,
  /** Reference player max run/sprint speeds (m/s) used in the dodgeability inequality. */
  playerBaseMaxSpeed: 5.2,
  playerSprintSpeed: 8.6,
  dodgeSafetyFactor: 1.6,
  // 预警时长安全不等式（硬性约束，即使狂暴阶段 hpPct <= 0.35 也不得打破）：
  //   预警时长 × 5.2 > 标识半径 × 1.6
  //   minTelegraphSec (1.40s) × 5.2 = 7.28m > blastRadius (3.2m) × 1.6 = 5.12m  (满足且留 42% 余量)
  //   按游戏当前实机走速 4.2 m/s：1.40s × 4.2 = 5.88m > 5.12m  (玩家站在圆心不靠冲刺也能稳步跑出)
  minTelegraphSec: 1.4,
  phase1FlightBaseSec: 1.5,
  phase1FlightPerMeter: 8e-3,
  phase1FlightMaxSec: 1.85,
  enragedFlightBaseSec: 1.4,
  enragedFlightPerMeter: 5e-3,
  enragedFlightMaxSec: 1.65,
  /** Multi-shell salvo fan geometry (Phase 2: 2 shells, Enraged <=35%: 3 shells). */
  fanAngleDeg: 22,
  minFanSeparationMult: 2.1,
  /** Launch mount offsets relative to Boss root (upper shoulder/dorsal mortar pod). */
  muzzleHeightOffset: 3.55,
  muzzleForwardOffset: 0.65,
  muzzleSideOffset: 0.72,
  /** Visual lifetimes (s). */
  impactVfxDurationSec: 0.68,
  muzzleVfxDurationSec: 0.24,
  trailHistorySec: 1.25,
  /** Maximum allowed simultaneous triangles for all artillery meshes combined. */
  maxTriangleBudget: 1500
};
var EPS2 = 1e-6;
var DEG2RAD = Math.PI / 180;
var TRAIL_SEGMENTS = 16;
var SMOKE_PUFFS_PER_SHELL = 8;
function clamp2(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
function isTelegraphDodgeable(warningSec, radius = ARTILLERY_CONFIG.blastRadius) {
  return warningSec * ARTILLERY_CONFIG.playerBaseMaxSpeed > radius * ARTILLERY_CONFIG.dodgeSafetyFactor;
}
function computeFlightTimeSec(dist, enraged, blastRadius = ARTILLERY_CONFIG.blastRadius) {
  const safeDist = Number.isFinite(dist) && dist > 0 ? dist : 0;
  const inequalityFloor = blastRadius * ARTILLERY_CONFIG.dodgeSafetyFactor / ARTILLERY_CONFIG.playerBaseMaxSpeed + 0.25;
  const floorSec = Math.max(ARTILLERY_CONFIG.minTelegraphSec, inequalityFloor);
  const raw = enraged ? clamp2(
    ARTILLERY_CONFIG.enragedFlightBaseSec + safeDist * ARTILLERY_CONFIG.enragedFlightPerMeter,
    ARTILLERY_CONFIG.enragedFlightBaseSec,
    ARTILLERY_CONFIG.enragedFlightMaxSec
  ) : clamp2(
    ARTILLERY_CONFIG.phase1FlightBaseSec + safeDist * ARTILLERY_CONFIG.phase1FlightPerMeter,
    ARTILLERY_CONFIG.phase1FlightBaseSec,
    ARTILLERY_CONFIG.phase1FlightMaxSec
  );
  return Math.max(floorSec, raw);
}
function solveBallisticArc(origin, target, flightTime, gravity = ARTILLERY_CONFIG.gravity) {
  const T = Math.max(ARTILLERY_CONFIG.minTelegraphSec, flightTime);
  const g = Math.max(1, gravity);
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const dz = target.z - origin.z;
  const vx = dx / T;
  const vz = dz / T;
  const vy = dy / T + 0.5 * g * T;
  const vh = Math.hypot(vx, vz);
  const initialSpeed = Math.hypot(vh, vy);
  const elevationRad = Math.atan2(vy, vh);
  const apexTime = clamp2(vy / g, 0, T);
  const apexY = origin.y + vy * apexTime - 0.5 * g * apexTime * apexTime;
  return {
    origin: { x: origin.x, y: origin.y, z: origin.z },
    target: { x: target.x, y: target.y, z: target.z },
    vx,
    vy,
    vz,
    initialSpeed,
    elevationRad,
    flightTime: T,
    gravity: g,
    apexTime,
    apexY
  };
}
function sampleBallisticPos(sol, tSec) {
  const t = clamp2(tSec, 0, sol.flightTime);
  return {
    x: sol.origin.x + sol.vx * t,
    y: sol.origin.y + sol.vy * t - 0.5 * sol.gravity * t * t,
    z: sol.origin.z + sol.vz * t
  };
}
function sampleBallisticVel(sol, tSec) {
  const t = clamp2(tSec, 0, sol.flightTime);
  return {
    x: sol.vx,
    y: sol.vy - sol.gravity * t,
    z: sol.vz
  };
}
function computeArtilleryOrigin(bossPos, bossYaw, side) {
  const fwdX = -Math.sin(bossYaw);
  const fwdZ = -Math.cos(bossYaw);
  const rightX = Math.cos(bossYaw);
  const rightZ = -Math.sin(bossYaw);
  return {
    x: bossPos.x + fwdX * ARTILLERY_CONFIG.muzzleForwardOffset + rightX * (side * ARTILLERY_CONFIG.muzzleSideOffset),
    y: bossPos.y + ARTILLERY_CONFIG.muzzleHeightOffset,
    z: bossPos.z + fwdZ * ARTILLERY_CONFIG.muzzleForwardOffset + rightZ * (side * ARTILLERY_CONFIG.muzzleSideOffset)
  };
}
var deckWorld = new CollisionWorld(MAP.boxes, MAP.bounds, MAP.waterY, MAP.walkablePolygon);
function clampToDeck(x, z) {
  const maxX = MAP.bounds.w * 0.5 - 2.6;
  const maxZ = MAP.bounds.d * 0.5 - 2.4;
  let cx = clamp2(x, -maxX, maxX);
  let cz = clamp2(z, -maxZ, maxZ);
  if (deckWorld.isInsideWalkable(cx, cz, 0.8)) {
    return { x: cx, z: cz };
  }
  for (let i = 1; i <= 8; i++) {
    const k = 1 - i / 9;
    const tx = cx * k;
    const tz = cz * k;
    if (deckWorld.isInsideWalkable(tx, tz, 0.8)) {
      return { x: tx, z: tz };
    }
  }
  return { x: 0, z: 0 };
}
function planSalvoTargets(bossPos, playerPos, salvoCount, blastRadius, fanParity = 1) {
  const count = Math.max(1, Math.min(3, Math.round(salvoCount)));
  const groundY = playerPos.y > 0.12 ? playerPos.y : 0;
  const primary = { x: playerPos.x, y: groundY, z: playerPos.z };
  if (count === 1) return [primary];
  const dx = playerPos.x - bossPos.x;
  const dz = playerPos.z - bossPos.z;
  const dist = Math.hypot(dx, dz);
  const dirX = dist > EPS2 ? dx / dist : 0;
  const dirZ = dist > EPS2 ? dz / dist : 1;
  const perpX = -dirZ;
  const perpZ = dirX;
  const fanRad = ARTILLERY_CONFIG.fanAngleDeg * DEG2RAD;
  const minSep = blastRadius * ARTILLERY_CONFIG.minFanSeparationMult;
  const lateralOffset = Math.max(dist * Math.sin(fanRad), minSep);
  const axialPull = dist > 4 ? Math.min(1.6, dist * (1 - Math.cos(fanRad))) : 0;
  const makeWing = (sign) => {
    const rawX = primary.x + perpX * (sign * lateralOffset) - dirX * axialPull;
    const rawZ = primary.z + perpZ * (sign * lateralOffset) - dirZ * axialPull;
    const clamped = clampToDeck(rawX, rawZ);
    return { x: clamped.x, y: 0, z: clamped.z };
  };
  if (count === 2) {
    return [primary, makeWing(fanParity)];
  }
  return [primary, makeWing(-1), makeWing(1)];
}
function makeFallbackDataTex(r, g, b, a) {
  const tex = new THREE.DataTexture(new Uint8Array([r, g, b, a]), 1, 1);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
function makeProceduralTex(size, draw, fallbackRgba, repeatX = false) {
  if (typeof document === "undefined") {
    return makeFallbackDataTex(fallbackRgba[0], fallbackRgba[1], fallbackRgba[2], fallbackRgba[3]);
  }
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d");
  draw(ctx, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  if (repeatX) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
  }
  tex.needsUpdate = true;
  return tex;
}
function buildCrossedQuadGeo(w, h) {
  const hw = w * 0.5;
  const hh = h * 0.5;
  const positions = new Float32Array([
    // Plane 1 (XY)
    -hw,
    -hh,
    0,
    hw,
    -hh,
    0,
    hw,
    hh,
    0,
    -hw,
    -hh,
    0,
    hw,
    hh,
    0,
    -hw,
    hh,
    0,
    // Plane 2 (ZY)
    0,
    -hh,
    -hw,
    0,
    -hh,
    hw,
    0,
    hh,
    hw,
    0,
    -hh,
    -hw,
    0,
    hh,
    hw,
    0,
    hh,
    -hw
  ]);
  const uvs = new Float32Array([
    0,
    0,
    1,
    0,
    1,
    1,
    0,
    0,
    1,
    1,
    0,
    1,
    0,
    0,
    1,
    0,
    1,
    1,
    0,
    0,
    1,
    1,
    0,
    1
  ]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  return geo;
}
var sharedAssets = null;
function getSharedAssets() {
  if (sharedAssets) return sharedAssets;
  const outerRingTex = makeProceduralTex(
    256,
    (ctx, s) => {
      const cx = s * 0.5;
      const rOuter = s * 0.46;
      const bg = ctx.createRadialGradient(cx, cx, rOuter * 0.15, cx, cx, rOuter);
      bg.addColorStop(0, "rgba(255, 64, 24, 0.30)");
      bg.addColorStop(0.72, "rgba(255, 36, 18, 0.22)");
      bg.addColorStop(0.95, "rgba(255, 30, 14, 0.50)");
      bg.addColorStop(1, "rgba(255, 30, 14, 0)");
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.arc(cx, cx, rOuter, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(12, 4, 4, 0.88)";
      ctx.lineWidth = 15;
      ctx.beginPath();
      ctx.arc(cx, cx, rOuter - 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = "#FF2A16";
      ctx.lineWidth = 9;
      ctx.beginPath();
      ctx.arc(cx, cx, rOuter - 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = "#FFCC44";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(cx, cx, rOuter - 11, 0, Math.PI * 2);
      ctx.stroke();
      ctx.save();
      ctx.translate(cx, cx);
      for (let i = 0; i < 12; i++) {
        ctx.save();
        ctx.rotate(i / 12 * Math.PI * 2);
        const major = i % 3 === 0;
        ctx.fillStyle = major ? "#FFE878" : "rgba(255, 110, 48, 0.92)";
        const len = major ? 26 : 14;
        const wid = major ? 6 : 3.5;
        ctx.fillRect(rOuter - 14 - len, -wid * 0.5, len, wid);
        ctx.restore();
      }
      ctx.strokeStyle = "rgba(255, 232, 128, 0.88)";
      ctx.lineWidth = 3.5;
      for (const ang of [0, Math.PI * 0.5, Math.PI, Math.PI * 1.5]) {
        ctx.save();
        ctx.rotate(ang);
        ctx.beginPath();
        ctx.moveTo(18, 0);
        ctx.lineTo(rOuter - 46, 0);
        ctx.stroke();
        ctx.restore();
      }
      ctx.strokeStyle = "#FFF088";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(0, 0, 15, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "#FF381C";
      ctx.beginPath();
      ctx.arc(0, 0, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    },
    [255, 42, 22, 235]
  );
  const shrinkRingTex = makeProceduralTex(
    256,
    (ctx, s) => {
      const cx = s * 0.5;
      const r = s * 0.44;
      ctx.strokeStyle = "rgba(255, 140, 24, 0.55)";
      ctx.lineWidth = 18;
      ctx.beginPath();
      ctx.arc(cx, cx, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = "#FFF27A";
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.arc(cx, cx, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.save();
      ctx.translate(cx, cx);
      ctx.fillStyle = "#FFFFFF";
      for (let i = 0; i < 4; i++) {
        ctx.save();
        ctx.rotate(i * Math.PI / 2 + Math.PI / 4);
        ctx.beginPath();
        ctx.moveTo(r - 22, 0);
        ctx.lineTo(r - 5, -9);
        ctx.lineTo(r - 5, 9);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
      ctx.restore();
    },
    [255, 240, 110, 255]
  );
  const fillDiscTex = makeProceduralTex(
    128,
    (ctx, s) => {
      const cx = s * 0.5;
      const g = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx * 0.96);
      g.addColorStop(0, "rgba(255, 110, 36, 0.72)");
      g.addColorStop(0.7, "rgba(255, 42, 18, 0.58)");
      g.addColorStop(0.92, "rgba(255, 210, 90, 0.90)");
      g.addColorStop(1, "rgba(255, 42, 18, 0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cx, cx * 0.96, 0, Math.PI * 2);
      ctx.fill();
    },
    [255, 64, 24, 180]
  );
  const wallRimTex = makeProceduralTex(
    128,
    (ctx, s) => {
      const grad = ctx.createLinearGradient(0, s, 0, 0);
      grad.addColorStop(0, "rgba(255, 58, 22, 0.92)");
      grad.addColorStop(0.18, "rgba(255, 130, 32, 0.65)");
      grad.addColorStop(0.55, "rgba(255, 44, 18, 0.24)");
      grad.addColorStop(1, "rgba(255, 36, 14, 0.0)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, s, s);
      ctx.fillStyle = "rgba(255, 232, 110, 0.55)";
      for (let x = -s; x < s * 2; x += 28) {
        ctx.beginPath();
        ctx.moveTo(x, s);
        ctx.lineTo(x + 12, s);
        ctx.lineTo(x + 28, s * 0.62);
        ctx.lineTo(x + 16, s * 0.62);
        ctx.closePath();
        ctx.fill();
      }
    },
    [255, 72, 24, 200],
    true
  );
  const beaconTex = makeProceduralTex(
    128,
    (ctx, s) => {
      const cx = s * 0.5;
      const g = ctx.createLinearGradient(0, s, 0, 0);
      g.addColorStop(0, "rgba(255, 238, 136, 0.95)");
      g.addColorStop(0.28, "rgba(255, 96, 28, 0.65)");
      g.addColorStop(0.75, "rgba(255, 46, 18, 0.16)");
      g.addColorStop(1, "rgba(255, 46, 18, 0.0)");
      ctx.fillStyle = g;
      ctx.fillRect(cx - 8, 0, 16, s);
      const core = ctx.createLinearGradient(0, s, 0, 0);
      core.addColorStop(0, "rgba(255, 255, 255, 0.98)");
      core.addColorStop(0.5, "rgba(255, 210, 96, 0.52)");
      core.addColorStop(1, "rgba(255, 160, 48, 0.0)");
      ctx.fillStyle = core;
      ctx.fillRect(cx - 2.5, 0, 5, s);
    },
    [255, 180, 72, 220]
  );
  const shellGlowTex = makeProceduralTex(
    128,
    (ctx, s) => {
      const cx = s * 0.5;
      const g = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx);
      g.addColorStop(0, "rgba(255, 255, 235, 1.0)");
      g.addColorStop(0.22, "rgba(255, 218, 96, 0.95)");
      g.addColorStop(0.5, "rgba(255, 92, 20, 0.68)");
      g.addColorStop(0.8, "rgba(220, 32, 10, 0.22)");
      g.addColorStop(1, "rgba(180, 20, 8, 0.0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
    },
    [255, 160, 40, 255]
  );
  const smokeTex = makeProceduralTex(
    128,
    (ctx, s) => {
      const lobes = [
        [0.5, 0.5, 0.42, 0.78],
        [0.36, 0.44, 0.3, 0.56],
        [0.64, 0.48, 0.28, 0.54],
        [0.48, 0.34, 0.27, 0.48],
        [0.54, 0.64, 0.28, 0.46]
      ];
      for (const [lx, ly, lr, a] of lobes) {
        const g = ctx.createRadialGradient(lx * s, ly * s, 0, lx * s, ly * s, lr * s);
        g.addColorStop(0, `rgba(62, 48, 42, ${a})`);
        g.addColorStop(0.55, `rgba(48, 40, 38, ${a * 0.55})`);
        g.addColorStop(1, "rgba(36, 32, 34, 0)");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, s, s);
      }
    },
    [60, 48, 42, 190]
  );
  const explosionTex = makeProceduralTex(
    128,
    (ctx, s) => {
      const lobes = [
        [0.5, 0.5, 0.44, 0.92],
        [0.36, 0.44, 0.3, 0.78],
        [0.64, 0.46, 0.3, 0.76],
        [0.48, 0.34, 0.28, 0.72],
        [0.54, 0.62, 0.28, 0.68]
      ];
      for (const [lx, ly, lr, a] of lobes) {
        const g = ctx.createRadialGradient(lx * s, ly * s, 0, lx * s, ly * s, lr * s);
        g.addColorStop(0, `rgba(255, 236, 152, ${a})`);
        g.addColorStop(0.32, `rgba(255, 138, 32, ${a * 0.94})`);
        g.addColorStop(0.68, `rgba(218, 48, 12, ${a * 0.7})`);
        g.addColorStop(0.88, `rgba(88, 22, 10, ${a * 0.34})`);
        g.addColorStop(1, "rgba(42, 16, 12, 0.0)");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, s, s);
      }
    },
    [255, 138, 32, 240]
  );
  const shellBodyGeo = new THREE.CylinderGeometry(0.14, 0.22, 0.58, 8, 1);
  const shellNoseGeo = new THREE.ConeGeometry(0.14, 0.3, 8, 1);
  shellNoseGeo.translate(0, 0.44, 0);
  const shellBandGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.16, 8, 1, true);
  const shellFinGeo = buildCrossedQuadGeo(0.52, 0.28);
  shellFinGeo.translate(0, -0.22, 0);
  const unitQuadGeo = new THREE.PlaneGeometry(1, 1);
  const floorQuadGeo = new THREE.PlaneGeometry(2, 2);
  floorQuadGeo.rotateX(-Math.PI / 2);
  const wallCylGeo = new THREE.CylinderGeometry(1, 1, 0.58, 24, 1, true);
  wallCylGeo.translate(0, 0.29, 0);
  const beaconCrossGeo = buildCrossedQuadGeo(0.55, 2.2);
  beaconCrossGeo.translate(0, 1.1, 0);
  const fireballGeo = new THREE.IcosahedronGeometry(1, 1);
  const shockRingGeo = new THREE.RingGeometry(0.76, 1, 20, 1);
  shockRingGeo.rotateX(-Math.PI / 2);
  sharedAssets = {
    outerRingTex,
    shrinkRingTex,
    fillDiscTex,
    wallRimTex,
    beaconTex,
    shellGlowTex,
    smokeTex,
    explosionTex,
    shellBodyGeo,
    shellNoseGeo,
    shellBandGeo,
    shellFinGeo,
    unitQuadGeo,
    floorQuadGeo,
    wallCylGeo,
    beaconCrossGeo,
    fireballGeo,
    shockRingGeo
  };
  return sharedAssets;
}
function countObjectTriangles(root) {
  let total = 0;
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
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
var UP_VEC = new THREE.Vector3(0, 1, 0);
var tmpVel = new THREE.Vector3();
var tmpQuat = new THREE.Quaternion();
var tmpCamPos = new THREE.Vector3(0, 8, 20);
var tmpPt = new THREE.Vector3();
var tmpNext = new THREE.Vector3();
var tmpTan = new THREE.Vector3();
var tmpView = new THREE.Vector3();
var tmpSide = new THREE.Vector3();
function createTrailGeometry() {
  const vertCount = (TRAIL_SEGMENTS + 1) * 2;
  const positions = new Float32Array(vertCount * 3);
  const colors = new Float32Array(vertCount * 3);
  const indices = new Uint16Array(TRAIL_SEGMENTS * 6);
  for (let i = 0; i < TRAIL_SEGMENTS; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    const k = i * 6;
    indices[k] = a;
    indices[k + 1] = b;
    indices[k + 2] = c;
    indices[k + 3] = b;
    indices[k + 4] = d;
    indices[k + 5] = c;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  return geo;
}
var ArtillerySystem = class {
  root;
  blastRadius;
  damage;
  gravity;
  scene;
  opts;
  assets;
  shells = [];
  impacts = [];
  muzzles = [];
  sharedShellBodyMat;
  sharedShellGlowBandMat;
  sharedShellFinMat;
  nextShotId = 1;
  podParity = 1;
  fanParity = 1;
  disposed = false;
  _totalShotsFired = 0;
  _totalImpacts = 0;
  _totalHitsDealt = 0;
  _lastShot = null;
  _lastImpact = null;
  /** Persistent telemetry object mirrored onto window.__artillery (zero per-frame alloc). */
  telemetry;
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.opts = opts;
    this.assets = getSharedAssets();
    this.blastRadius = opts.blastRadius !== void 0 && Number.isFinite(opts.blastRadius) && opts.blastRadius > 0 ? opts.blastRadius : ARTILLERY_CONFIG.blastRadius;
    this.damage = opts.damage !== void 0 && Number.isFinite(opts.damage) && opts.damage >= 0 ? opts.damage : ARTILLERY_CONFIG.damage;
    this.gravity = opts.gravity !== void 0 && Number.isFinite(opts.gravity) && opts.gravity > 0 ? opts.gravity : ARTILLERY_CONFIG.gravity;
    this.root = new THREE.Group();
    this.root.name = "boss-artillery-root";
    this.scene.add(this.root);
    this.sharedShellBodyMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color("#4B3328"),
      toneMapped: false
    });
    this.sharedShellGlowBandMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color("#FFB238"),
      toneMapped: false
    });
    this.sharedShellFinMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color("#FF4B1A"),
      side: THREE.DoubleSide,
      toneMapped: false
    });
    this.telemetry = {
      lastShot: null,
      lastImpact: null,
      activeProjectiles: [],
      activeTelegraphs: [],
      activeImpacts: 0,
      totalShotsFired: 0,
      totalImpacts: 0,
      totalHitsDealt: 0,
      tris: 0,
      maxTrisBudget: ARTILLERY_CONFIG.maxTriangleBudget,
      blastRadius: this.blastRadius,
      minTelegraphSec: ARTILLERY_CONFIG.minTelegraphSec
    };
  }
  get totalShotsFired() {
    return this._totalShotsFired;
  }
  get totalImpacts() {
    return this._totalImpacts;
  }
  get totalHitsDealt() {
    return this._totalHitsDealt;
  }
  get lastShot() {
    return this._lastShot;
  }
  get lastImpact() {
    return this._lastImpact;
  }
  get activeProjectileCount() {
    return this.shells.length;
  }
  get triangleCount() {
    return countObjectTriangles(this.root);
  }
  /** Launch a 1..3 shell parabolic artillery salvo with instant ground telegraphs. */
  fireSalvo(params) {
    if (this.disposed) return [];
    const targets = planSalvoTargets(
      params.bossPos,
      params.playerPos,
      params.salvoCount,
      this.blastRadius,
      this.fanParity
    );
    this.fanParity = this.fanParity === 1 ? -1 : 1;
    const spawned = [];
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const side = i === 0 ? this.podParity : i === 1 ? -1 : 1;
      if (i === 0) this.podParity = this.podParity === 1 ? -1 : 1;
      const origin = computeArtilleryOrigin(params.bossPos, params.bossYaw, side);
      const horizDist = Math.hypot(target.x - origin.x, target.z - origin.z);
      const flightTime = computeFlightTimeSec(horizDist, params.enraged, this.blastRadius);
      const sol = solveBallisticArc(origin, target, flightTime, this.gravity);
      const id = this.nextShotId++;
      const impactAt = params.simNowMs + flightTime * 1e3;
      const shell = this.createActiveShell(
        id,
        i === 0,
        sol,
        this.blastRadius,
        this.damage,
        params.simNowMs,
        impactAt
      );
      this.shells.push(shell);
      this._totalShotsFired++;
      const record = {
        id,
        origin: { ...sol.origin },
        target: { ...sol.target },
        flightTime: Number(sol.flightTime.toFixed(4)),
        impactAt: Number(impactAt.toFixed(1)),
        launchedAt: Number(params.simNowMs.toFixed(1)),
        blastRadius: this.blastRadius,
        initialSpeed: Number(sol.initialSpeed.toFixed(3)),
        elevationDeg: Number((sol.elevationRad * 180 / Math.PI).toFixed(2)),
        apexY: Number(sol.apexY.toFixed(3))
      };
      spawned.push(record);
      if (i === 0) {
        this._lastShot = record;
      }
      if (i === 0 || i === 1) {
        this.spawnMuzzleFlash(origin);
      }
    }
    this.syncTelemetry();
    this.opts.onLaunch?.(spawned);
    return spawned;
  }
  /** Advance all flying shells, parabolic trails, ground telegraphs, and explosion VFX. */
  update(dtSec, playerPos, simNowMs, cameraPos) {
    if (this.disposed) return;
    const dt = Number.isFinite(dtSec) && dtSec > 0 ? dtSec : 0;
    if (cameraPos) {
      tmpCamPos.set(cameraPos.x, cameraPos.y, cameraPos.z);
    } else {
      tmpCamPos.set(playerPos.x, playerPos.y + 1.7, playerPos.z);
    }
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const s = this.shells[i];
      s.elapsedSec += dt;
      if (s.elapsedSec >= s.sol.flightTime) {
        const impactPos = sampleBallisticPos(s.sol, s.sol.flightTime);
        this.resolveImpact(s, impactPos, playerPos, simNowMs);
        this.destroyShell(s);
        this.shells.splice(i, 1);
        continue;
      }
      const pos = sampleBallisticPos(s.sol, s.elapsedSec);
      const vel = sampleBallisticVel(s.sol, s.elapsedSec);
      s.pos.x = pos.x;
      s.pos.y = pos.y;
      s.pos.z = pos.z;
      s.shellGroup.position.set(pos.x, pos.y, pos.z);
      tmpVel.set(vel.x, vel.y, vel.z);
      if (tmpVel.lengthSq() > EPS2) {
        tmpVel.normalize();
        tmpQuat.setFromUnitVectors(UP_VEC, tmpVel);
        s.shellGroup.quaternion.copy(tmpQuat);
      }
      s.haloMesh.lookAt(tmpCamPos);
      const pulse = 0.92 + 0.16 * Math.sin(s.elapsedSec * 28);
      s.haloMesh.scale.set(1.25 * pulse, 1.25 * pulse, 1);
      this.updateTrailRibbon(s);
      this.updateSmokePuffs(s);
      const progress = clamp2(s.elapsedSec / s.sol.flightTime, 0, 1);
      this.updateTelegraphVisual(s, progress);
    }
    for (let i = this.impacts.length - 1; i >= 0; i--) {
      const imp = this.impacts[i];
      imp.elapsedSec += dt;
      if (imp.elapsedSec >= imp.durationSec) {
        this.destroyImpact(imp);
        this.impacts.splice(i, 1);
        continue;
      }
      this.updateImpactVisual(imp);
    }
    for (let i = this.muzzles.length - 1; i >= 0; i--) {
      const m = this.muzzles[i];
      m.elapsedSec += dt;
      if (m.elapsedSec >= m.durationSec) {
        this.destroyMuzzleFlash(m);
        this.muzzles.splice(i, 1);
        continue;
      }
      this.updateMuzzleVisual(m);
    }
    this.syncTelemetry();
  }
  /** Clear all in-flight projectiles, ground telegraphs, and VFX (e.g. on round reset). */
  clear() {
    for (const s of this.shells) this.destroyShell(s);
    this.shells.length = 0;
    for (const imp of this.impacts) this.destroyImpact(imp);
    this.impacts.length = 0;
    for (const m of this.muzzles) this.destroyMuzzleFlash(m);
    this.muzzles.length = 0;
    this._totalShotsFired = 0;
    this._totalImpacts = 0;
    this._totalHitsDealt = 0;
    this._lastShot = null;
    this._lastImpact = null;
    this.podParity = 1;
    this.fanParity = 1;
    this.syncTelemetry();
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    this.scene.remove(this.root);
    this.sharedShellBodyMat.dispose();
    this.sharedShellGlowBandMat.dispose();
    this.sharedShellFinMat.dispose();
  }
  // ============================================================================
  // Internal Builders & Per-Frame Updaters
  // ============================================================================
  createActiveShell(id, isPrimary, sol, blastRadius, damage, launchedAtMs, impactAtMs) {
    const a = this.assets;
    const shellGroup = new THREE.Group();
    shellGroup.name = `artillery-projectile-${id}`;
    shellGroup.position.set(sol.origin.x, sol.origin.y, sol.origin.z);
    const bodyMesh = new THREE.Mesh(a.shellBodyGeo, this.sharedShellBodyMat);
    bodyMesh.name = `artillery-projectile-body-${id}`;
    const noseMesh = new THREE.Mesh(a.shellNoseGeo, this.sharedShellBodyMat);
    const bandMesh = new THREE.Mesh(a.shellBandGeo, this.sharedShellGlowBandMat);
    const finMesh = new THREE.Mesh(a.shellFinGeo, this.sharedShellFinMat);
    const haloMat = new THREE.MeshBasicMaterial({
      map: a.shellGlowTex,
      transparent: true,
      opacity: 0.96,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false
    });
    const haloMesh = new THREE.Mesh(a.unitQuadGeo, haloMat);
    haloMesh.scale.set(1.25, 1.25, 1);
    haloMesh.renderOrder = 14;
    shellGroup.add(bodyMesh, noseMesh, bandMesh, finMesh, haloMesh);
    this.root.add(shellGroup);
    const trailGeo = createTrailGeometry();
    const trailMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false
    });
    const trailMesh = new THREE.Mesh(trailGeo, trailMat);
    trailMesh.name = `artillery-trail-${id}`;
    trailMesh.frustumCulled = false;
    trailMesh.renderOrder = 12;
    this.root.add(trailMesh);
    const smokeMeshes = [];
    const smokeMats = [];
    for (let k = 0; k < SMOKE_PUFFS_PER_SHELL; k++) {
      const mat = new THREE.MeshBasicMaterial({
        map: a.smokeTex,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false
      });
      const m = new THREE.Mesh(a.unitQuadGeo, mat);
      m.position.set(sol.origin.x, sol.origin.y, sol.origin.z);
      m.renderOrder = 11;
      m.visible = false;
      this.root.add(m);
      smokeMeshes.push(m);
      smokeMats.push(mat);
    }
    const telegraphGroup = new THREE.Group();
    telegraphGroup.name = `artillery-telegraph-${id}`;
    telegraphGroup.position.set(sol.target.x, sol.target.y, sol.target.z);
    telegraphGroup.visible = true;
    const outerMat = new THREE.MeshBasicMaterial({
      map: a.outerRingTex,
      transparent: true,
      opacity: 0.96,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      toneMapped: false
    });
    const outerMesh = new THREE.Mesh(a.floorQuadGeo, outerMat);
    outerMesh.name = `artillery-telegraph-outer-${id}`;
    outerMesh.position.y = 0.045;
    outerMesh.scale.set(blastRadius, 1, blastRadius);
    outerMesh.renderOrder = 8;
    const fillMat = new THREE.MeshBasicMaterial({
      map: a.fillDiscTex,
      transparent: true,
      opacity: 0.24,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      toneMapped: false
    });
    const fillDiscMesh = new THREE.Mesh(a.floorQuadGeo, fillMat);
    fillDiscMesh.position.y = 0.052;
    fillDiscMesh.scale.set(blastRadius * 0.1, 1, blastRadius * 0.1);
    fillDiscMesh.renderOrder = 9;
    const shrinkMat = new THREE.MeshBasicMaterial({
      map: a.shrinkRingTex,
      color: new THREE.Color("#FFF066"),
      transparent: true,
      opacity: 0.98,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      toneMapped: false
    });
    const shrinkRingMesh = new THREE.Mesh(a.floorQuadGeo, shrinkMat);
    shrinkRingMesh.name = `artillery-telegraph-countdown-${id}`;
    shrinkRingMesh.position.y = 0.062;
    shrinkRingMesh.scale.set(blastRadius, 1, blastRadius);
    shrinkRingMesh.renderOrder = 10;
    const wallMat = new THREE.MeshBasicMaterial({
      map: a.wallRimTex,
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false
    });
    const wallMesh = new THREE.Mesh(a.wallCylGeo, wallMat);
    wallMesh.name = `artillery-telegraph-rim-${id}`;
    wallMesh.scale.set(blastRadius, 1, blastRadius);
    wallMesh.renderOrder = 10;
    const beaconMat = new THREE.MeshBasicMaterial({
      map: a.beaconTex,
      transparent: true,
      opacity: 0.84,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false
    });
    const beaconMesh = new THREE.Mesh(a.beaconCrossGeo, beaconMat);
    beaconMesh.position.y = 0.04;
    beaconMesh.renderOrder = 11;
    telegraphGroup.add(outerMesh, fillDiscMesh, shrinkRingMesh, wallMesh, beaconMesh);
    this.root.add(telegraphGroup);
    const active = {
      id,
      isPrimary,
      sol,
      blastRadius,
      damage,
      launchedAtMs,
      impactAtMs,
      elapsedSec: 0,
      pos: { ...sol.origin },
      shellGroup,
      haloMesh,
      haloMat,
      trailMesh,
      trailGeo,
      trailMat,
      smokeMeshes,
      smokeMats,
      telegraphGroup,
      outerMat,
      shrinkRingMesh,
      shrinkMat,
      fillDiscMesh,
      fillMat,
      wallMesh,
      wallMat,
      beaconMesh,
      beaconMat,
      ringScale: 1
    };
    const initVel = sampleBallisticVel(sol, 0);
    tmpVel.set(initVel.x, initVel.y, initVel.z);
    if (tmpVel.lengthSq() > EPS2) {
      tmpVel.normalize();
      tmpQuat.setFromUnitVectors(UP_VEC, tmpVel);
      shellGroup.quaternion.copy(tmpQuat);
    }
    this.updateTrailRibbon(active);
    return active;
  }
  updateTrailRibbon(s) {
    const posAttr = s.trailGeo.getAttribute("position");
    const colAttr = s.trailGeo.getAttribute("color");
    const pArr = posAttr.array;
    const cArr = colAttr.array;
    const tEnd = s.elapsedSec;
    const tStart = Math.max(0, tEnd - ARTILLERY_CONFIG.trailHistorySec);
    const span = tEnd - tStart;
    for (let i = 0; i <= TRAIL_SEGMENTS; i++) {
      const u = i / TRAIL_SEGMENTS;
      const t = tStart + span * u;
      const p = sampleBallisticPos(s.sol, t);
      const tNext = Math.min(s.sol.flightTime, t + 0.025);
      const pn = sampleBallisticPos(s.sol, tNext);
      tmpPt.set(p.x, p.y, p.z);
      tmpNext.set(pn.x, pn.y, pn.z);
      tmpTan.subVectors(tmpNext, tmpPt);
      if (tmpTan.lengthSq() <= EPS2) {
        const v = sampleBallisticVel(s.sol, t);
        tmpTan.set(v.x, v.y, v.z);
      }
      tmpTan.normalize();
      tmpView.subVectors(tmpCamPos, tmpPt).normalize();
      tmpSide.crossVectors(tmpTan, tmpView);
      if (tmpSide.lengthSq() <= EPS2) {
        tmpSide.set(1, 0, 0);
      } else {
        tmpSide.normalize();
      }
      const halfWidth = span < 0.01 ? 0.01 : 0.04 + 0.24 * Math.pow(u, 1.35);
      const vi = i * 2;
      const pIdx = vi * 3;
      pArr[pIdx] = p.x - tmpSide.x * halfWidth;
      pArr[pIdx + 1] = p.y - tmpSide.y * halfWidth;
      pArr[pIdx + 2] = p.z - tmpSide.z * halfWidth;
      pArr[pIdx + 3] = p.x + tmpSide.x * halfWidth;
      pArr[pIdx + 4] = p.y + tmpSide.y * halfWidth;
      pArr[pIdx + 5] = p.z + tmpSide.z * halfWidth;
      const fade = Math.pow(u, 1.2);
      const r = fade * 1;
      const g = fade * (0.24 + 0.72 * u * u);
      const b = fade * (0.04 + 0.56 * Math.pow(u, 3));
      cArr[pIdx] = r;
      cArr[pIdx + 1] = g;
      cArr[pIdx + 2] = b;
      cArr[pIdx + 3] = r;
      cArr[pIdx + 4] = g;
      cArr[pIdx + 5] = b;
    }
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
  }
  updateSmokePuffs(s) {
    for (let k = 0; k < SMOKE_PUFFS_PER_SHELL; k++) {
      const lag = (k + 1) * 0.125;
      const sampleT = s.elapsedSec - lag;
      const mesh = s.smokeMeshes[k];
      const mat = s.smokeMats[k];
      if (sampleT < 0) {
        mesh.visible = false;
        continue;
      }
      mesh.visible = true;
      const p = sampleBallisticPos(s.sol, sampleT);
      const ageFrac = clamp2(lag / (SMOKE_PUFFS_PER_SHELL * 0.125), 0, 1);
      mesh.position.set(p.x, p.y + ageFrac * 0.42, p.z);
      mesh.lookAt(tmpCamPos);
      const size = 0.42 + ageFrac * 0.92;
      mesh.scale.set(size, size, 1);
      mat.opacity = (1 - ageFrac * 0.82) * 0.74;
    }
  }
  updateTelegraphVisual(s, progress) {
    const ringScale = 1 - progress * 0.92;
    s.ringScale = ringScale;
    s.shrinkRingMesh.scale.set(s.blastRadius * ringScale, 1, s.blastRadius * ringScale);
    s.shrinkRingMesh.rotation.y = progress * Math.PI * 1.5;
    const urgent = clamp2((progress - 0.65) / 0.35, 0, 1);
    const pulseFreq = 6 + urgent * 14;
    const pulse = 0.5 + 0.5 * Math.sin(s.elapsedSec * pulseFreq * Math.PI * 2);
    s.shrinkMat.color.setRGB(
      1,
      0.92 - progress * 0.42 + urgent * 0.35 * pulse,
      0.32 - progress * 0.22 + urgent * 0.55 * pulse
    );
    s.shrinkMat.opacity = 0.92 + 0.08 * pulse;
    const fillFrac = 0.08 + progress * 0.9;
    s.fillDiscMesh.scale.set(s.blastRadius * fillFrac, 1, s.blastRadius * fillFrac);
    s.fillMat.opacity = 0.2 + progress * 0.42 + urgent * 0.14 * pulse;
    s.outerMat.opacity = 0.88 + 0.12 * pulse;
    s.wallMat.opacity = 0.58 + progress * 0.34 + urgent * 0.08 * pulse;
    s.wallMesh.scale.set(s.blastRadius, 0.95 + progress * 0.45, s.blastRadius);
    const beamW = 1.1 - progress * 0.45;
    s.beaconMesh.scale.set(beamW, 0.85 + progress * 0.4, beamW);
    s.beaconMat.opacity = 0.55 + progress * 0.4;
  }
  resolveImpact(s, impactPos, playerPos, simNowMs) {
    this._totalImpacts++;
    const horizDist = Math.hypot(playerPos.x - impactPos.x, playerPos.z - impactPos.z);
    const vertDist = Math.abs(playerPos.y - impactPos.y);
    const hitPlayer = horizDist <= s.blastRadius && vertDist <= ARTILLERY_CONFIG.blastVerticalTolerance;
    const dealtDamage = hitPlayer ? s.damage : 0;
    const record = {
      id: s.id,
      target: { ...s.sol.target },
      impactPos: { ...impactPos },
      impactAt: Number(simNowMs.toFixed(1)),
      playerDist: Number(horizDist.toFixed(3)),
      hitPlayer,
      damage: dealtDamage
    };
    this._lastImpact = record;
    this.spawnImpactVfx(impactPos, s.blastRadius);
    if (hitPlayer && dealtDamage > 0) {
      this._totalHitsDealt++;
      this.opts.onImpactHit?.({
        id: s.id,
        damage: dealtDamage,
        impactPos: { ...impactPos },
        dist: horizDist
      });
    }
    this.opts.onImpact?.(record);
  }
  spawnImpactVfx(pos, blastRadius) {
    const a = this.assets;
    const group = new THREE.Group();
    group.name = `artillery-impact-${this._totalImpacts}`;
    group.position.set(pos.x, pos.y, pos.z);
    const fireballMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color("#FF8C24"),
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
      toneMapped: false
    });
    const fireballMesh = new THREE.Mesh(a.fireballGeo, fireballMat);
    fireballMesh.position.y = 0.52;
    fireballMesh.scale.setScalar(0.35);
    fireballMesh.renderOrder = 14;
    const shockMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color("#FF5A16"),
      transparent: true,
      opacity: 0.94,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false
    });
    const shockMesh = new THREE.Mesh(a.shockRingGeo, shockMat);
    shockMesh.name = `artillery-shockwave-${this._totalImpacts}`;
    shockMesh.position.y = 0.09;
    shockMesh.scale.set(0.45, 1, 0.45);
    shockMesh.renderOrder = 13;
    const flashMat = new THREE.MeshBasicMaterial({
      map: a.explosionTex,
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false
    });
    const flashMesh = new THREE.Mesh(a.floorQuadGeo, flashMat);
    flashMesh.position.y = 0.07;
    flashMesh.scale.set(blastRadius * 0.92, 1, blastRadius * 0.92);
    flashMesh.renderOrder = 12;
    const plumeMeshes = [];
    const plumeMats = [];
    const plumeDirs = [];
    for (let k = 0; k < 6; k++) {
      const ang = k / 6 * Math.PI * 2 + 0.4;
      const isFire = k < 3;
      const mat = new THREE.MeshBasicMaterial({
        map: isFire ? a.explosionTex : a.smokeTex,
        transparent: true,
        opacity: isFire ? 0.92 : 0.8,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false
      });
      const m = new THREE.Mesh(a.unitQuadGeo, mat);
      const radial = k === 0 ? 0 : isFire ? 0.45 : 0.72;
      m.position.set(Math.cos(ang) * radial, 0.65 + k * 0.16, Math.sin(ang) * radial);
      m.scale.setScalar(isFire ? 1.55 : 1.35);
      m.renderOrder = isFire ? 15 : 14;
      group.add(m);
      plumeMeshes.push(m);
      plumeMats.push(mat);
      plumeDirs.push({
        x: Math.cos(ang) * (k === 0 ? 0.15 : isFire ? 1.05 : 1.85),
        y: (isFire ? 2.1 : 3.2) + k % 3 * 0.45,
        z: Math.sin(ang) * (k === 0 ? 0.15 : isFire ? 1.05 : 1.85)
      });
    }
    group.add(fireballMesh, shockMesh, flashMesh);
    this.root.add(group);
    this.impacts.push({
      group,
      elapsedSec: 0,
      durationSec: ARTILLERY_CONFIG.impactVfxDurationSec,
      blastRadius,
      fireballMesh,
      fireballMat,
      shockMesh,
      shockMat,
      flashMesh,
      flashMat,
      plumeMeshes,
      plumeMats,
      plumeDirs
    });
  }
  updateImpactVisual(imp) {
    const u = clamp2(imp.elapsedSec / imp.durationSec, 0, 1);
    const easeOut = 1 - Math.pow(1 - u, 3);
    const fbScale = 0.32 + easeOut * (imp.blastRadius * 0.32);
    imp.fireballMesh.scale.set(fbScale, fbScale * 0.85, fbScale);
    imp.fireballMesh.position.y = 0.48 + easeOut * 0.85;
    imp.fireballMat.color.setRGB(
      1,
      clamp2(0.68 - u * 0.75, 0.14, 0.8),
      clamp2(0.24 - u * 0.55, 0.03, 0.3)
    );
    imp.fireballMat.opacity = Math.max(0, 1 - u * 1.8) * 0.78;
    const shockR = 0.5 + easeOut * (imp.blastRadius * 1.15);
    imp.shockMesh.scale.set(shockR, 1, shockR);
    imp.shockMat.color.setRGB(1, clamp2(0.62 - u * 0.42, 0.18, 0.75), clamp2(0.18 - u * 0.16, 0.04, 0.25));
    imp.shockMat.opacity = Math.max(0, 1 - u * 1.05) * 0.94;
    const flashFade = clamp2(1 - u / 0.52, 0, 1);
    imp.flashMat.opacity = flashFade * 0.86;
    for (let k = 0; k < imp.plumeMeshes.length; k++) {
      const m = imp.plumeMeshes[k];
      const mat = imp.plumeMats[k];
      const d = imp.plumeDirs[k];
      const isFire = k < 3;
      m.position.set(d.x * easeOut, (isFire ? 0.65 : 0.45) + d.y * easeOut, d.z * easeOut);
      m.lookAt(tmpCamPos);
      const sz = isFire ? 1.7 + easeOut * 2.1 : 1.45 + easeOut * 2.4;
      m.scale.set(sz, sz, 1);
      mat.opacity = isFire ? Math.max(0, 1 - Math.pow(u, 1.15)) * 0.92 : Math.max(0, 1 - u * u) * 0.78;
    }
  }
  spawnMuzzleFlash(origin) {
    const a = this.assets;
    const group = new THREE.Group();
    group.name = "artillery-muzzle-flash";
    group.position.set(origin.x, origin.y, origin.z);
    const starMat = new THREE.MeshBasicMaterial({
      map: a.explosionTex,
      transparent: true,
      opacity: 0.98,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false
    });
    const starMesh = new THREE.Mesh(a.unitQuadGeo, starMat);
    starMesh.scale.set(1.6, 1.6, 1);
    starMesh.renderOrder = 15;
    group.add(starMesh);
    const puffMeshes = [];
    const puffMats = [];
    const puffDirs = [];
    for (let k = 0; k < 3; k++) {
      const ang = k / 3 * Math.PI * 2;
      const mat = new THREE.MeshBasicMaterial({
        map: a.smokeTex,
        transparent: true,
        opacity: 0.78,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false
      });
      const m = new THREE.Mesh(a.unitQuadGeo, mat);
      m.scale.set(0.7, 0.7, 1);
      m.renderOrder = 14;
      group.add(m);
      puffMeshes.push(m);
      puffMats.push(mat);
      puffDirs.push({ x: Math.cos(ang) * 0.7, y: 1.2 + k * 0.25, z: Math.sin(ang) * 0.7 });
    }
    this.root.add(group);
    this.muzzles.push({
      group,
      elapsedSec: 0,
      durationSec: ARTILLERY_CONFIG.muzzleVfxDurationSec,
      starMesh,
      starMat,
      puffMeshes,
      puffMats,
      puffDirs
    });
  }
  updateMuzzleVisual(m) {
    const u = clamp2(m.elapsedSec / m.durationSec, 0, 1);
    m.starMesh.lookAt(tmpCamPos);
    const s = 1.5 + u * 1.1;
    m.starMesh.scale.set(s, s, 1);
    m.starMat.opacity = Math.max(0, 1 - u * 1.25);
    for (let k = 0; k < m.puffMeshes.length; k++) {
      const pm = m.puffMeshes[k];
      const pd = m.puffDirs[k];
      pm.position.set(pd.x * u, pd.y * u, pd.z * u);
      pm.lookAt(tmpCamPos);
      const sz = 0.7 + u * 1.1;
      pm.scale.set(sz, sz, 1);
      m.puffMats[k].opacity = Math.max(0, (1 - u) * 0.75);
    }
  }
  destroyShell(s) {
    this.root.remove(s.shellGroup);
    s.haloMat.dispose();
    this.root.remove(s.trailMesh);
    s.trailGeo.dispose();
    s.trailMat.dispose();
    for (let i = 0; i < s.smokeMeshes.length; i++) {
      this.root.remove(s.smokeMeshes[i]);
      s.smokeMats[i].dispose();
    }
    this.root.remove(s.telegraphGroup);
    s.outerMat.dispose();
    s.shrinkMat.dispose();
    s.fillMat.dispose();
    s.wallMat.dispose();
    s.beaconMat.dispose();
  }
  destroyImpact(imp) {
    this.root.remove(imp.group);
    imp.fireballMat.dispose();
    imp.shockMat.dispose();
    imp.flashMat.dispose();
    for (const m of imp.plumeMats) m.dispose();
  }
  destroyMuzzleFlash(m) {
    this.root.remove(m.group);
    m.starMat.dispose();
    for (const pm of m.puffMats) pm.dispose();
  }
  syncTelemetry() {
    const t = this.telemetry;
    t.lastShot = this._lastShot;
    t.lastImpact = this._lastImpact;
    t.totalShotsFired = this._totalShotsFired;
    t.totalImpacts = this._totalImpacts;
    t.totalHitsDealt = this._totalHitsDealt;
    t.activeImpacts = this.impacts.length;
    t.tris = countObjectTriangles(this.root);
    t.activeProjectiles.length = 0;
    t.activeTelegraphs.length = 0;
    for (const s of this.shells) {
      const progress = clamp2(s.elapsedSec / s.sol.flightTime, 0, 1);
      const remainingMs = Math.max(0, (s.sol.flightTime - s.elapsedSec) * 1e3);
      t.activeProjectiles.push({
        id: s.id,
        origin: { ...s.sol.origin },
        target: { ...s.sol.target },
        pos: { x: s.pos.x, y: s.pos.y, z: s.pos.z },
        elapsedSec: Number(s.elapsedSec.toFixed(4)),
        flightTime: Number(s.sol.flightTime.toFixed(4)),
        impactAt: Number(s.impactAtMs.toFixed(1)),
        blastRadius: s.blastRadius,
        progress: Number(progress.toFixed(4))
      });
      t.activeTelegraphs.push({
        id: s.id,
        target: { ...s.sol.target },
        radius: s.blastRadius,
        progress: Number(progress.toFixed(4)),
        remainingMs: Number(remainingMs.toFixed(1)),
        visible: s.telegraphGroup.visible,
        inScene: s.telegraphGroup.parent === this.root,
        ringScale: Number(s.ringScale.toFixed(4))
      });
    }
  }
};

// src/game/artillery.test.ts
test("dodgeability inequality: warningSec * 5.2 > blastRadius * 1.6 across all distances & enraged phase", () => {
  assert.equal(
    isTelegraphDodgeable(ARTILLERY_CONFIG.minTelegraphSec, ARTILLERY_CONFIG.blastRadius),
    true,
    "minTelegraphSec must satisfy \u9884\u8B66\u65F6\u957F * 5.2 > \u6807\u8BC6\u534A\u5F84 * 1.6"
  );
  for (const enraged of [false, true]) {
    for (const dist of [1, 5, 10, 18, 22, 30, 45]) {
      const t = computeFlightTimeSec(dist, enraged, ARTILLERY_CONFIG.blastRadius);
      assert.ok(
        t * 5.2 > ARTILLERY_CONFIG.blastRadius * 1.6,
        `dist=${dist} enraged=${enraged}: ${t} * 5.2 <= ${ARTILLERY_CONFIG.blastRadius * 1.6}`
      );
      assert.ok(t >= ARTILLERY_CONFIG.minTelegraphSec);
    }
  }
});
test("parabolic trajectory: y rises then falls, x/z move at constant velocity, impact hits target within <0.01m", () => {
  const origin = { x: -10, y: 3.55, z: -6 };
  const target = { x: 8, y: 0, z: 14 };
  const flightTime = computeFlightTimeSec(Math.hypot(target.x - origin.x, target.z - origin.z), false);
  const sol = solveBallisticArc(origin, target, flightTime);
  assert.ok(sol.elevationRad > 0.25 && sol.elevationRad < Math.PI * 0.49, `unexpected elevation ${sol.elevationRad}`);
  assert.ok(sol.apexY > origin.y + 2, `parabolic apex (${sol.apexY}) should clearly rise above origin (${origin.y})`);
  assert.ok(sol.apexTime > 0.1 * flightTime && sol.apexTime < 0.7 * flightTime);
  const frac = [0.05, 0.25, 0.45, 0.72, 0.96];
  const pts = frac.map((f) => sampleBallisticPos(sol, f * flightTime));
  const peakIdx = pts.reduce((best, p, i) => p.y > pts[best].y ? i : best, 0);
  assert.ok(peakIdx > 0 && peakIdx < pts.length - 1, `peak should be interior, got index ${peakIdx}: ${pts.map((p) => p.y.toFixed(2))}`);
  assert.ok(pts[peakIdx].y > pts[0].y + 1, "y must rise before apex");
  assert.ok(pts[pts.length - 1].y < pts[peakIdx].y - 3, "y must fall after apex");
  for (let i = 1; i < pts.length; i++) {
    const dt = (frac[i] - frac[i - 1]) * flightTime;
    const vx = (pts[i].x - pts[i - 1].x) / dt;
    const vz = (pts[i].z - pts[i - 1].z) / dt;
    assert.ok(Math.abs(vx - sol.vx) < 1e-6);
    assert.ok(Math.abs(vz - sol.vz) < 1e-6);
  }
  const end = sampleBallisticPos(sol, flightTime);
  const err = Math.hypot(end.x - target.x, end.y - target.y, end.z - target.z);
  assert.ok(err < 1e-4, `impact error ${err}m too large`);
});
test("ArtillerySystem spawns projectile + visible ground telegraph immediately, damages center player, spares dodger", () => {
  const scene = new THREE2.Scene();
  const hits = [];
  const art = new ArtillerySystem(scene, {
    onImpactHit: (info) => hits.push({ damage: info.damage, dist: info.dist })
  });
  const bossPos = { x: -10, y: 0, z: -6 };
  const playerCenter = { x: 0, y: 0, z: 12 };
  art.fireSalvo({
    bossPos,
    bossYaw: Math.atan2(-(playerCenter.x - bossPos.x), -(playerCenter.z - bossPos.z)),
    playerPos: playerCenter,
    salvoCount: 1,
    enraged: false,
    simNowMs: 1e3
  });
  const shot1 = art.telemetry.lastShot;
  assert.ok(shot1, "lastShot must be populated");
  assert.equal(art.telemetry.activeProjectiles.length, 1);
  assert.equal(art.telemetry.activeTelegraphs.length, 1);
  assert.equal(art.telemetry.activeTelegraphs[0].visible, true);
  assert.equal(art.telemetry.activeTelegraphs[0].inScene, true);
  assert.ok(art.triangleCount <= ARTILLERY_CONFIG.maxTriangleBudget);
  let simMs = 1e3;
  let prevScale = 2;
  const ys = [];
  while (art.telemetry.activeProjectiles.length > 0 && simMs < 5e3) {
    simMs += 50;
    art.update(0.05, playerCenter, simMs);
    if (art.telemetry.activeProjectiles.length > 0) {
      ys.push(art.telemetry.activeProjectiles[0].pos.y);
      const tg = art.telemetry.activeTelegraphs[0];
      assert.equal(tg.visible, true);
      assert.ok(tg.ringScale <= prevScale + 1e-6, "countdown ring must shrink monotonically");
      prevScale = tg.ringScale;
    }
  }
  assert.ok(ys.length >= 10);
  const maxY = Math.max(...ys);
  assert.ok(maxY > ys[0] + 1 && maxY > ys[ys.length - 1] + 2, "sampled projectile y must rise then fall");
  assert.equal(hits.length, 1, "stationary center player must be hit");
  assert.equal(hits[0].damage, ARTILLERY_CONFIG.damage);
  assert.ok(art.telemetry.lastImpact.hitPlayer);
  assert.ok(art.telemetry.activeImpacts >= 1, "explosion VFX should spawn on impact");
  art.fireSalvo({
    bossPos,
    bossYaw: Math.atan2(-(playerCenter.x - bossPos.x), -(playerCenter.z - bossPos.z)),
    playerPos: playerCenter,
    salvoCount: 1,
    enraged: true,
    simNowMs: simMs
  });
  const escapedPos = { x: playerCenter.x + ARTILLERY_CONFIG.blastRadius + 1.2, y: 0, z: playerCenter.z };
  while (art.telemetry.activeProjectiles.length > 0 && simMs < 1e4) {
    simMs += 50;
    art.update(0.05, escapedPos, simMs);
  }
  assert.equal(hits.length, 1, "player outside blastRadius must take 0 damage");
  assert.equal(art.telemetry.lastImpact.hitPlayer, false);
  art.dispose();
  assert.equal(scene.children.includes(art.root), false);
});
test("3-shell enraged fan salvo separates blast rings and stays within <=1500 triangle budget", () => {
  const targets = planSalvoTargets({ x: 0, y: 0, z: -15 }, { x: 0, y: 0, z: 8 }, 3, ARTILLERY_CONFIG.blastRadius);
  assert.equal(targets.length, 3);
  const d01 = Math.hypot(targets[1].x - targets[0].x, targets[1].z - targets[0].z);
  const d02 = Math.hypot(targets[2].x - targets[0].x, targets[2].z - targets[0].z);
  assert.ok(d01 >= ARTILLERY_CONFIG.blastRadius * 1.9, `fan spacing d01=${d01} too tight`);
  assert.ok(d02 >= ARTILLERY_CONFIG.blastRadius * 1.9, `fan spacing d02=${d02} too tight`);
  const scene = new THREE2.Scene();
  const art = new ArtillerySystem(scene);
  art.fireSalvo({
    bossPos: { x: 0, y: 0, z: -15 },
    bossYaw: Math.PI,
    playerPos: { x: 0, y: 0, z: 8 },
    salvoCount: 3,
    enraged: true,
    simNowMs: 0
  });
  art.update(0.4, { x: 0, y: 0, z: 8 }, 400);
  const activeTris = art.triangleCount;
  assert.ok(activeTris > 0 && activeTris <= ARTILLERY_CONFIG.maxTriangleBudget, `3-shell tris ${activeTris} > ${ARTILLERY_CONFIG.maxTriangleBudget}`);
  art.update(1.5, { x: 0, y: 0, z: 8 }, 1900);
  art.fireSalvo({
    bossPos: { x: 0, y: 0, z: -15 },
    bossYaw: Math.PI,
    playerPos: { x: 0, y: 0, z: 8 },
    salvoCount: 3,
    enraged: true,
    simNowMs: 1950
  });
  const peakTris = art.triangleCount;
  assert.ok(peakTris <= ARTILLERY_CONFIG.maxTriangleBudget, `peak 3-shell+3-explosion tris ${peakTris} > ${ARTILLERY_CONFIG.maxTriangleBudget}`);
  art.dispose();
});
test("artillery.ts is 100% procedural with zero external asset URLs", () => {
  const source = readFileSync(new URL("./artillery.ts", import.meta.url), "utf8");
  assert.equal(/\.(glb|gltf|png|jpg|jpeg|webp|svg|mp3|ogg|wav)\b/i.test(source), false);
  assert.equal(/https?:\/\//i.test(source), false);
});
