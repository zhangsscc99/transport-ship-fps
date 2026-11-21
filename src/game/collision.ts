// Cylinder-vs-AABB collision world + walkable polygon air walls — pure logic,
// no three.js / DOM.
// Player is a vertical cylinder (feet at pos.y, radius 0.35m); solid obstacles
// are MAP.boxes; dock-edge sea barriers are enforced by a 2D walkable polygon
// (invisible, non-raycast-blocking) with closest-edge normal slide projection
// and 35% horizontal speed damping on contact.

import type { Box, Vec2 } from './map';
import type { Vec3 } from './player';

export const PLAYER_RADIUS = 0.35;
export const STEP_HEIGHT = 0.35;
/** Horizontal slide velocity multiplier when contacting a dock-edge air wall. */
export const AIR_WALL_SLIDE_DAMP = 0.35;
const EPS = 1e-4;
/** Max displacement along any axis per sub-step (≈ half the body radius). */
const MAX_SUBSTEP = 0.15;
const MAX_STEPS = 64;

export interface MoveResult {
  pos: Vec3;
  vel: Vec3;
  onGround: boolean;
  drowned: boolean;
  hitAirWall: boolean;
}

export interface Bounds {
  w: number;
  d: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Circle (x,z,r) strictly overlaps the box's XZ rect. */
function circleHitsRect(x: number, z: number, r: number, b: Box): boolean {
  const qx = clamp(x, b.x - b.w / 2, b.x + b.w / 2);
  const qz = clamp(z, b.z - b.d / 2, b.z + b.d / 2);
  const dx = x - qx;
  const dz = z - qz;
  return dx * dx + dz * dz < r * r - EPS;
}

/** Standard ray-casting point-in-polygon test in the XZ plane. */
export function pointInPolygon(x: number, z: number, poly: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const zi = poly[i].z;
    const xj = poly[j].x;
    const zj = poly[j].z;
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Closest point Q on segment A→B to P=(x,z), plus parameter t∈[0,1] and squared dist. */
function closestOnSegment(
  x: number,
  z: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): { qx: number; qz: number; t: number; distSq: number } {
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

function defaultRectPolygon(bounds: Bounds): readonly Vec2[] {
  const hw = bounds.w / 2 - 0.15;
  const hd = bounds.d / 2 - 0.15;
  return [
    { x: -hw, z: -hd },
    { x: hw, z: -hd },
    { x: hw, z: hd },
    { x: -hw, z: hd },
  ];
}

export class CollisionWorld {
  readonly polygon: readonly Vec2[];

  constructor(
    readonly boxes: readonly Box[],
    readonly bounds: Bounds,
    readonly waterY: number,
    polygon?: readonly Vec2[],
  ) {
    this.polygon = polygon && polygon.length >= 3 ? polygon : defaultRectPolygon(bounds);
  }

  insideBounds(x: number, z: number): boolean {
    return Math.abs(x) <= this.bounds.w / 2 && Math.abs(z) <= this.bounds.d / 2;
  }

  /** True when a capsule of `radius` at (x,z) lies completely within the walkable polygon. */
  isInsideWalkable(x: number, z: number, radius = PLAYER_RADIUS): boolean {
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
  private constrainToPolygon(
    candX: number,
    candZ: number,
    radius: number,
  ): { x: number; z: number; nx: number; nz: number; hit: boolean } {
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
          // CCW polygon in (x,z): inward normal is (-ez/L, +ex/L)
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
          // Reflex / convex corner vertex: push radially away from vertex (no snag)
          x += ((x - bestQx) / dist) * push;
          z += ((z - bestQz) / dist) * push;
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
  hits(x: number, y: number, z: number, r: number, h: number): boolean {
    for (const b of this.boxes) {
      if (y + h <= b.y + EPS || y >= b.y + b.h - EPS) continue;
      if (circleHitsRect(x, z, r, b)) return true;
    }
    return false;
  }

  /** Collect every box the cylinder penetrates at (x,y,z). */
  private blockers(x: number, y: number, z: number, r: number, h: number, out: Box[]): void {
    out.length = 0;
    for (const b of this.boxes) {
      if (y + h <= b.y + EPS || y >= b.y + b.h - EPS) continue;
      if (circleHitsRect(x, z, r, b)) out.push(b);
    }
  }

  /** Lowest blocker top reachable by an auto-step from feetY (Infinity if none). */
  private stepCandidate(blockers: Box[], feetY: number): number {
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
  move(
    pos: Vec3,
    vel: Vec3,
    radius: number,
    height: number,
    dt: number,
    wasOnGround: boolean,
  ): MoveResult {
    const p = { x: pos.x, y: pos.y, z: pos.z };
    const v = { x: vel.x, y: vel.y, z: vel.z };
    const disp = Math.max(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)) * dt;
    const steps = Math.min(MAX_STEPS, Math.max(1, Math.ceil(disp / MAX_SUBSTEP)));
    const h = dt / steps;
    const scratch: Box[] = [];
    let onGround = wasOnGround;
    let drowned = false;
    let hitAirWall = false;
    let airWallDamped = false;

    for (let i = 0; i < steps; i++) {
      const prevX = p.x;
      const prevZ = p.z;

      // --- X axis (box colliders) ---
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
          const face =
            v.x > 0
              ? Math.min(...scratch.map((b) => b.x - b.w / 2))
              : Math.max(...scratch.map((b) => b.x + b.w / 2));
          p.x = v.x > 0 ? Math.min(nx, face - radius) : Math.max(nx, face + radius);
          v.x = 0;
        }
      }
      // --- Z axis (box colliders) ---
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
          const face =
            v.z > 0
              ? Math.min(...scratch.map((b) => b.z - b.d / 2))
              : Math.max(...scratch.map((b) => b.z + b.d / 2));
          p.z = v.z > 0 ? Math.min(nz, face - radius) : Math.max(nz, face + radius);
          v.z = 0;
        }
      }

      // --- Dock-edge air walls: walkable polygon containment + normal slide projection ---
      const wall = this.constrainToPolygon(p.x, p.z, radius);
      if (wall.hit) {
        hitAirWall = true;
        // Slide tangential displacement along the wall with 35% horizontal attenuation
        // (applied once per move() call so sub-stepping doesn't over-damp).
        const slideDx = wall.x - prevX;
        const slideDz = wall.z - prevZ;
        if (!airWallDamped) {
          airWallDamped = true;
          const dampX = prevX + slideDx * AIR_WALL_SLIDE_DAMP;
          const dampZ = prevZ + slideDz * AIR_WALL_SLIDE_DAMP;
          const recheck = this.constrainToPolygon(dampX, dampZ, radius);
          p.x = recheck.x;
          p.z = recheck.z;
          // Project horizontal velocity onto tangent and damp to 35%
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
        // Make sure air-wall slide never pushes player into an adjacent solid box
        if (this.hits(p.x, p.y, p.z, radius, height)) {
          p.x = prevX;
          p.z = prevZ;
          v.x = 0;
          v.z = 0;
        }
      }

      // --- Y axis ---
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
}
