// Cylinder-vs-AABB collision world — pure logic, no three.js / DOM.
// Player is a vertical cylinder (feet at pos.y); the world is MAP.boxes.
// Movement is resolved axis-separately (X, then Z, then Y) so wall sliding
// falls out naturally; low ledges (≤ STEP_HEIGHT) are auto-stepped while
// grounded; the Y pass handles landing and head bumps. Sub-stepping keeps
// fast motion from tunnelling through thin walls.

import type { Box } from './map';
import type { Vec3 } from './player';

export const PLAYER_RADIUS = 0.35;
export const STEP_HEIGHT = 0.35;
const EPS = 1e-4;
/** Max displacement along any axis per sub-step (≈ half the body radius). */
const MAX_SUBSTEP = 0.15;
const MAX_STEPS = 64;

export interface MoveResult {
  pos: Vec3;
  vel: Vec3;
  onGround: boolean;
  drowned: boolean;
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

export class CollisionWorld {
  constructor(
    readonly boxes: readonly Box[],
    readonly bounds: Bounds,
    readonly waterY: number,
  ) {}

  insideBounds(x: number, z: number): boolean {
    return Math.abs(x) <= this.bounds.w / 2 && Math.abs(z) <= this.bounds.d / 2;
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
   * Advance a cylinder by vel*dt with collision response.
   * `wasOnGround` gates auto-stepping (no stepping mid-air).
   * Returns the resolved position/velocity; `drowned` when the body left
   * the ship bounds or sank below waterY.
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

    for (let i = 0; i < steps; i++) {
      // --- X axis ---
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
          const face = v.x > 0
            ? Math.min(...scratch.map((b) => b.x - b.w / 2))
            : Math.max(...scratch.map((b) => b.x + b.w / 2));
          p.x = v.x > 0 ? Math.min(nx, face - radius) : Math.max(nx, face + radius);
          v.x = 0;
        }
      }
      // --- Z axis (identical pattern) ---
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
          const face = v.z > 0
            ? Math.min(...scratch.map((b) => b.z - b.d / 2))
            : Math.max(...scratch.map((b) => b.z + b.d / 2));
          p.z = v.z > 0 ? Math.min(nz, face - radius) : Math.max(nz, face + radius);
          v.z = 0;
        }
      }
      // --- Y axis ---
      const ny = p.y + v.y * h;
      if (v.y <= 0) {
        // falling / resting: land on the highest box top crossed this step
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
        // rising: clamp on the lowest box bottom the head crosses
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
      if (!this.insideBounds(p.x, p.z) || p.y < this.waterY) {
        drowned = true;
        break;
      }
    }
    return { pos: p, vel: v, onGround, drowned };
  }
}
