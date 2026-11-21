// src/game/collision.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

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

// src/game/player.ts
var MOVE = {
  walkSpeed: 4.2,
  crouchSpeed: 1.9,
  jumpSpeed: 4.8,
  gravity: -18,
  eyeHeight: 1.7,
  crouchEyeHeight: 1.15,
  pitchLimit: 85 * Math.PI / 180
};
function emptyInput() {
  return {
    moveX: 0,
    moveZ: 0,
    crouch: false,
    jump: false,
    yawDelta: 0,
    pitchDelta: 0,
    fire: false,
    reload: false,
    swap: false
  };
}
function wrapPi(a) {
  let r = a % (2 * Math.PI);
  if (r <= -Math.PI) r += 2 * Math.PI;
  else if (r > Math.PI) r -= 2 * Math.PI;
  return r;
}
var Player = class {
  position;
  velocity;
  yaw = 0;
  pitch = 0;
  crouch = false;
  onGround = true;
  /** Set by the collider when the body falls below waterY. */
  drowned = false;
  /** True on frames where the player capsule slid against a dock-edge air wall. */
  hitAirWall = false;
  constructor(spawn = { x: 0, y: 0, z: 0 }, yaw = 0) {
    this.position = { ...spawn };
    this.velocity = { x: 0, y: 0, z: 0 };
    this.yaw = yaw;
  }
  get eyeHeight() {
    return this.crouch ? MOVE.crouchEyeHeight : MOVE.eyeHeight;
  }
  /** Forward unit vector on the XZ plane derived from yaw. */
  forward() {
    return { x: -Math.sin(this.yaw), z: -Math.cos(this.yaw) };
  }
  update(dt, input2, world2 = {}) {
    this.yaw = wrapPi(this.yaw + input2.yawDelta);
    this.pitch = Math.max(-MOVE.pitchLimit, Math.min(MOVE.pitchLimit, this.pitch + input2.pitchDelta));
    if (!input2.crouch && this.crouch && world2.collider) {
      const p2 = this.position;
      this.crouch = world2.collider.hits(p2.x, p2.y, p2.z, PLAYER_RADIUS, MOVE.eyeHeight);
    } else {
      this.crouch = input2.crouch;
    }
    const speed = this.crouch ? MOVE.crouchSpeed : MOVE.walkSpeed;
    const fwd = this.forward();
    const right = { x: -fwd.z, z: fwd.x };
    let wx = fwd.x * input2.moveZ + right.x * input2.moveX;
    let wz = fwd.z * input2.moveZ + right.z * input2.moveX;
    const len = Math.hypot(wx, wz);
    if (len > 1) {
      wx /= len;
      wz /= len;
    }
    this.velocity.x = wx * speed;
    this.velocity.z = wz * speed;
    if (input2.jump && this.onGround) {
      this.velocity.y = MOVE.jumpSpeed;
      this.onGround = false;
    }
    this.velocity.y += MOVE.gravity * dt;
    if (world2.collider) {
      const res = world2.collider.move(
        this.position,
        this.velocity,
        PLAYER_RADIUS,
        this.eyeHeight,
        dt,
        this.onGround
      );
      const p2 = this.position;
      p2.x = res.pos.x;
      p2.y = res.pos.y;
      p2.z = res.pos.z;
      this.velocity.x = res.vel.x;
      this.velocity.y = res.vel.y;
      this.velocity.z = res.vel.z;
      this.onGround = res.onGround;
      this.hitAirWall = Boolean(res.hitAirWall);
      if (res.drowned) this.drowned = true;
      return;
    }
    this.hitAirWall = false;
    const inside = world2.isInside ?? (() => true);
    const p = this.position;
    let nx = p.x + this.velocity.x * dt;
    let nz = p.z + this.velocity.z * dt;
    if (!inside(nx, nz)) {
      if (inside(nx, p.z)) {
        nz = p.z;
        this.velocity.z = 0;
      } else if (inside(p.x, nz)) {
        nx = p.x;
        this.velocity.x = 0;
      } else {
        nx = p.x;
        nz = p.z;
        this.velocity.x = 0;
        this.velocity.z = 0;
      }
    }
    const ground = world2.groundHeight?.(nx, nz) ?? 0;
    let ny = p.y + this.velocity.y * dt;
    if (ny <= ground && this.velocity.y <= 0) {
      ny = ground;
      this.velocity.y = 0;
      this.onGround = true;
    } else if (ny > ground + 1e-6) {
      this.onGround = false;
    }
    p.x = nx;
    p.y = ny;
    p.z = nz;
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

// src/game/damage.ts
var EPS2 = 1e-6;
var HEADSHOT_ZONE = 0.85;
function rayBoxT(o, d, b) {
  let tmin = 0;
  let tmax = Infinity;
  const axes = [
    [o.x, d.x, b.x - b.w / 2, b.x + b.w / 2],
    [o.y, d.y, b.y, b.y + b.h],
    [o.z, d.z, b.z - b.d / 2, b.z + b.d / 2]
  ];
  for (const [ov, dv, lo, hi] of axes) {
    if (Math.abs(dv) < EPS2) {
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
  return tmin > EPS2 ? tmin : tmax > EPS2 ? 0 : Infinity;
}
function rayCylinderT(o, d, pos, r, height) {
  const ox = o.x - pos.x;
  const oz = o.z - pos.z;
  const y0 = pos.y;
  const y1 = pos.y + height;
  let best = Infinity;
  const a = d.x * d.x + d.z * d.z;
  if (a > EPS2) {
    const b = 2 * (ox * d.x + oz * d.z);
    const c = ox * ox + oz * oz - r * r;
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      for (const t of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) {
        if (t <= EPS2) continue;
        const y = o.y + t * d.y;
        if (y >= y0 && y <= y1 && t < best) best = t;
      }
    }
  }
  if (Math.abs(d.y) > EPS2) {
    for (const cap of [y0, y1]) {
      const t = (cap - o.y) / d.y;
      if (t <= EPS2 || t >= best) continue;
      const x = o.x + t * d.x - pos.x;
      const z = o.z + t * d.z - pos.z;
      if (x * x + z * z <= r * r) best = t;
    }
  }
  return best;
}
var at = (o, d, t) => ({
  x: o.x + t * d.x,
  y: o.y + t * d.y,
  z: o.z + t * d.z
});
function boxFaceNormal(p, b) {
  const dxMin = Math.abs(p.x - (b.x - b.w / 2));
  const dxMax = Math.abs(p.x - (b.x + b.w / 2));
  const dyMin = Math.abs(p.y - b.y);
  const dyMax = Math.abs(p.y - (b.y + b.h));
  const dzMin = Math.abs(p.z - (b.z - b.d / 2));
  const dzMax = Math.abs(p.z - (b.z + b.d / 2));
  let best = dxMin;
  let nx = -1, ny = 0, nz = 0;
  if (dxMax < best) {
    best = dxMax;
    nx = 1;
    ny = 0;
    nz = 0;
  }
  if (dyMin < best) {
    best = dyMin;
    nx = 0;
    ny = -1;
    nz = 0;
  }
  if (dyMax < best) {
    best = dyMax;
    nx = 0;
    ny = 1;
    nz = 0;
  }
  if (dzMin < best) {
    best = dzMin;
    nx = 0;
    ny = 0;
    nz = -1;
  }
  if (dzMax < best) {
    nx = 0;
    ny = 0;
    nz = 1;
  }
  return { x: nx, y: ny, z: nz };
}
function traceHit(ray, boxes, entities) {
  let boxT = Infinity;
  let hitBox = null;
  for (const b of boxes) {
    const t = rayBoxT(ray.origin, ray.dir, b);
    if (t < boxT) {
      boxT = t;
      hitBox = b;
    }
  }
  let entT = boxT;
  let hitEnt = null;
  for (const e of entities) {
    if (!e.alive) continue;
    const t = rayCylinderT(ray.origin, ray.dir, e.pos, e.radius, e.height);
    if (t < entT) {
      entT = t;
      hitEnt = e;
    }
  }
  if (hitEnt) {
    const point = at(ray.origin, ray.dir, entT);
    return {
      kind: "entity",
      entity: hitEnt,
      point,
      dist: entT,
      headshot: point.y - hitEnt.pos.y > hitEnt.height * HEADSHOT_ZONE
    };
  }
  if (hitBox) {
    const point = at(ray.origin, ray.dir, boxT);
    return {
      kind: "box",
      box: hitBox,
      point,
      normal: boxFaceNormal(point, hitBox),
      dist: boxT
    };
  }
  return null;
}

// src/game/collision.test.ts
var DT = 1 / 120;
var world = new CollisionWorld(MAP.boxes, MAP.bounds, MAP.waterY, MAP.walkablePolygon);
var WQ = { collider: world };
function input(patch = {}) {
  return { ...emptyInput(), ...patch };
}
function step(p, inp, seconds) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) p.update(DT, inp, WQ);
}
test("head-on move into a container stops at its face and stays stable", () => {
  const p = new Player({ x: -6, y: 0, z: 0 });
  step(p, input({ moveZ: 1 }), 1.2);
  const face = -2.75 + PLAYER_RADIUS;
  assert.ok(Math.abs(p.position.z - face) < 0.02, `z ${p.position.z}`);
  assert.equal(p.velocity.z, 0);
  for (let i = 0; i < 60; i++) p.update(DT, input({ moveZ: 1 }), WQ);
  assert.ok(Math.abs(p.position.z - face) < 0.02, `drifted to ${p.position.z}`);
});
test("diagonal pressure slides along the wall (strafe keeps moving)", () => {
  const p = new Player({ x: -5, y: 0, z: -1.5 });
  step(p, input({ moveZ: 1, moveX: -1 }), 0.7);
  assert.ok(Math.abs(p.position.z - (-2.75 + PLAYER_RADIUS)) < 0.05, `z ${p.position.z}`);
  assert.ok(p.position.x < -6.5, `slid to x ${p.position.x}`);
});
test("walks up tower stairs via auto-step (no jump needed)", () => {
  const p = new Player({ x: -16, y: 0, z: 14 });
  step(p, input({ moveX: -1 }), 4);
  assert.ok(p.position.y > 2.9, `y ${p.position.y}`);
  assert.ok(p.position.x < -22.5, `x ${p.position.x}`);
  assert.ok(p.onGround);
});
test("jumping under a pipe roof bumps the head and lands back", () => {
  const p = new Player({ x: -30, y: 0, z: 5 });
  p.update(DT, input({ jump: true }), WQ);
  let maxY = 0;
  for (let i = 0; i < Math.round(1.4 / DT); i++) {
    p.update(DT, input(), WQ);
    maxY = Math.max(maxY, p.position.y);
  }
  assert.ok(maxY <= 0.31, `maxY ${maxY}`);
  assert.equal(p.position.y, 0);
  assert.ok(p.onGround);
});
test("dock-edge air wall blocks falling into sea and keeps capsule in walkable polygon", () => {
  const p = new Player({ x: -10, y: 0, z: 18 });
  step(p, input({ moveZ: -1 }), 3);
  assert.equal(p.drowned, false);
  assert.ok(p.position.y > -0.5, `fell off dock: y=${p.position.y}`);
  assert.ok(world.isInsideWalkable(p.position.x, p.position.z, PLAYER_RADIUS), "escaped walkable polygon");
  assert.equal(p.hitAirWall, true);
  const ps = new Player({ x: 0, y: 0, z: 19.25 });
  step(ps, input({ moveZ: -1, moveX: 1 }), 0.6);
  assert.ok(ps.position.x > 0.3, `failed to slide along air wall (x=${ps.position.x})`);
  assert.ok(
    Math.hypot(ps.velocity.x, ps.velocity.z) <= MOVE.walkSpeed * AIR_WALL_SLIDE_DAMP + 0.05,
    `slide speed not attenuated: ${Math.hypot(ps.velocity.x, ps.velocity.z)}`
  );
  assert.ok(world.isInsideWalkable(ps.position.x, ps.position.z, PLAYER_RADIUS));
});
test("walking down tower stairs from platform edge is NOT blocked by air walls", () => {
  const p = new Player({ x: -24.5, y: 3.3, z: 14 });
  let everHitWall = false;
  for (let i = 0; i < Math.round(3 / DT); i++) {
    p.update(DT, input({ moveX: 1 }), WQ);
    if (p.hitAirWall) everHitWall = true;
  }
  assert.equal(everHitWall, false, "air wall blocked stair descent");
  assert.ok(p.position.x > -18, `did not clear stairs: x=${p.position.x}`);
  assert.ok(Math.abs(p.position.y) < 0.05, `did not reach deck: y=${p.position.y}`);
});
test("air wall does NOT block bullets (rays pass freely out over the sea)", () => {
  const hit = traceHit(
    { origin: { x: -10, y: 1.5, z: 18 }, dir: { x: 0, y: 0, z: 1 } },
    MAP.boxes,
    []
  );
  assert.equal(hit, null, "bullet should pass over dock edge without hitting air wall");
});
test("sinking below waterY drowns (direct move call)", () => {
  const res = world.move(
    { x: 0, y: -2.6, z: 0 },
    { x: 0, y: -3, z: 0 },
    PLAYER_RADIUS,
    MOVE.eyeHeight,
    DT,
    false
  );
  assert.equal(res.drowned, true);
});
test("fast movement cannot tunnel through a 0.3m wall", () => {
  const res = world.move(
    { x: -28.5, y: 0, z: 5 },
    { x: -30, y: 0, z: 0 },
    PLAYER_RADIUS,
    MOVE.eyeHeight,
    1 / 20,
    true
  );
  assert.ok(res.pos.x >= -29.1 + PLAYER_RADIUS - 1e-3, `tunneled to x ${res.pos.x}`);
  assert.ok(!world.hits(res.pos.x, res.pos.y, res.pos.z, PLAYER_RADIUS, MOVE.eyeHeight));
});
function lowCeilingWorld() {
  const boxes = [
    { x: 0, y: -1, z: 0, w: 30, h: 1, d: 30, kind: "deck" },
    { x: 0, y: 1.4, z: -5, w: 8, h: 0.5, d: 6, kind: "pipe" }
    // 1.4m ceiling over z∈[-8,-2]
  ];
  const w = new CollisionWorld(boxes, { w: 30, d: 30 }, -2);
  return { world: w, wq: { collider: w } };
}
test("standing is blocked by a low ceiling but crouching passes under", () => {
  const { wq } = lowCeilingWorld();
  const p = new Player({ x: 0, y: 0, z: 2 });
  const n = Math.round(1.2 / DT);
  for (let i = 0; i < n; i++) p.update(DT, input({ moveZ: 1 }), wq);
  assert.ok(p.position.z >= -2 + PLAYER_RADIUS - 0.02, `standing reached z ${p.position.z}`);
  assert.ok(p.position.z > -2.4, `overshot to ${p.position.z}`);
  const c = new Player({ x: 0, y: 0, z: 2 });
  for (let i = 0; i < Math.round(4 / DT); i++) c.update(DT, input({ moveZ: 1, crouch: true }), wq);
  assert.ok(c.position.z < -5, `crouch only reached z ${c.position.z}`);
});
test("cannot stand back up under a low ceiling", () => {
  const { wq } = lowCeilingWorld();
  const p = new Player({ x: 0, y: 0, z: -5 });
  p.update(DT, input({ crouch: true }), wq);
  assert.equal(p.crouch, true);
  for (let i = 0; i < 30; i++) p.update(DT, input({ crouch: false }), wq);
  assert.equal(p.crouch, true, "stood up into the ceiling");
});
test("falls and lands on top of a container", () => {
  const p = new Player({ x: -12, y: 3.6, z: 11 });
  p.onGround = false;
  step(p, input(), 1.2);
  assert.ok(Math.abs(p.position.y - 2.6) < 1e-6, `y ${p.position.y}`);
  assert.ok(p.onGround);
});
test("a 0.55m cover is too tall for auto-step \u2014 it blocks", () => {
  const p = new Player({ x: -2, y: 0, z: 3 });
  step(p, input({ moveZ: 1 }), 1);
  assert.ok(p.position.z >= 1.6 + PLAYER_RADIUS - 0.02, `z ${p.position.z}`);
  assert.ok(p.position.z < 2.05, `overshot to ${p.position.z}`);
  assert.equal(p.position.y, 0);
});
