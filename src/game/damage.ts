// Hit tracing & damage — pure logic, no three.js / DOM.
// traceHit resolves a shot ray against map boxes (occlusion first) and
// entity cylinders (side + caps). Headshots = hits in the top 15% of the
// body ×2. Damage falls off linearly past 25m to a 0.6 floor (sniper exempt).
// applyDamage drives hp / death; updateRespawn handles the 3s respawn with
// 1.5s spawn protection.

import type { Box } from './map';
import type { Vec3 } from './player';
import type { WeaponSpec } from './weapons';
import { INVINCIBLE_MS, RESPAWN_MS, type Entity } from './entities';

export interface Ray {
  origin: Vec3;
  dir: Vec3;
}

export type Hit =
  | { kind: 'entity'; entity: Entity; point: Vec3; dist: number; headshot: boolean }
  | { kind: 'box'; box: Box; point: Vec3; normal: Vec3; dist: number };

const EPS = 1e-6;
/** Fraction of body height above which a hit counts as a headshot. */
export const HEADSHOT_ZONE = 0.85;
export const HEADSHOT_MULT = 2;
/** Falloff: full damage to FALLOFF_START, linear to FALLOFF_FLOOR at FALLOFF_END. */
export const FALLOFF_START = 25;
export const FALLOFF_END = 50;
export const FALLOFF_FLOOR = 0.6;

/** Nearest ray-vs-AABB entry distance, or Infinity (0 when origin inside). */
export function rayBoxT(o: Vec3, d: Vec3, b: Box): number {
  let tmin = 0;
  let tmax = Infinity;
  const axes: [number, number, number, number][] = [
    [o.x, d.x, b.x - b.w / 2, b.x + b.w / 2],
    [o.y, d.y, b.y, b.y + b.h],
    [o.z, d.z, b.z - b.d / 2, b.z + b.d / 2],
  ];
  for (const [ov, dv, lo, hi] of axes) {
    if (Math.abs(dv) < EPS) {
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
  return tmin > EPS ? tmin : tmax > EPS ? 0 : Infinity;
}

/** Nearest ray-vs-vertical-cylinder distance (feet at pos, top at pos+height). */
export function rayCylinderT(o: Vec3, d: Vec3, pos: Vec3, r: number, height: number): number {
  const ox = o.x - pos.x;
  const oz = o.z - pos.z;
  const y0 = pos.y;
  const y1 = pos.y + height;
  let best = Infinity;

  // side surface: solve |(o+td)xz - c|² = r² in the XZ plane
  const a = d.x * d.x + d.z * d.z;
  if (a > EPS) {
    const b = 2 * (ox * d.x + oz * d.z);
    const c = ox * ox + oz * oz - r * r;
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      for (const t of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) {
        if (t <= EPS) continue;
        const y = o.y + t * d.y;
        if (y >= y0 && y <= y1 && t < best) best = t;
      }
    }
  }
  // caps (feet disc / head disc)
  if (Math.abs(d.y) > EPS) {
    for (const cap of [y0, y1]) {
      const t = (cap - o.y) / d.y;
      if (t <= EPS || t >= best) continue;
      const x = o.x + t * d.x - pos.x;
      const z = o.z + t * d.z - pos.z;
      if (x * x + z * z <= r * r) best = t;
    }
  }
  return best;
}

const at = (o: Vec3, d: Vec3, t: number): Vec3 => ({
  x: o.x + t * d.x,
  y: o.y + t * d.y,
  z: o.z + t * d.z,
});

/** Outward unit normal of the box face closest to surface `point`. */
function boxFaceNormal(p: Vec3, b: Box): Vec3 {
  const dxMin = Math.abs(p.x - (b.x - b.w / 2));
  const dxMax = Math.abs(p.x - (b.x + b.w / 2));
  const dyMin = Math.abs(p.y - b.y);
  const dyMax = Math.abs(p.y - (b.y + b.h));
  const dzMin = Math.abs(p.z - (b.z - b.d / 2));
  const dzMax = Math.abs(p.z - (b.z + b.d / 2));
  let best = dxMin;
  let nx = -1, ny = 0, nz = 0;
  if (dxMax < best) { best = dxMax; nx = 1; ny = 0; nz = 0; }
  if (dyMin < best) { best = dyMin; nx = 0; ny = -1; nz = 0; }
  if (dyMax < best) { best = dyMax; nx = 0; ny = 1; nz = 0; }
  if (dzMin < best) { best = dzMin; nx = 0; ny = 0; nz = -1; }
  if (dzMax < best) { nx = 0; ny = 0; nz = 1; }
  return { x: nx, y: ny, z: nz };
}

/**
 * Nearest thing a shot ray hits: a box (cover/occluder) or a living entity.
 * Entities behind a nearer box are occluded — boxes win ties by distance.
 */
export function traceHit(ray: Ray, boxes: readonly Box[], entities: readonly Entity[]): Hit | null {
  let boxT = Infinity;
  let hitBox: Box | null = null;
  for (const b of boxes) {
    const t = rayBoxT(ray.origin, ray.dir, b);
    if (t < boxT) {
      boxT = t;
      hitBox = b;
    }
  }
  let entT = boxT;
  let hitEnt: Entity | null = null;
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
      kind: 'entity',
      entity: hitEnt,
      point,
      dist: entT,
      headshot: point.y - hitEnt.pos.y > hitEnt.height * HEADSHOT_ZONE,
    };
  }
  if (hitBox) {
    const point = at(ray.origin, ray.dir, boxT);
    return {
      kind: 'box',
      box: hitBox,
      point,
      normal: boxFaceNormal(point, hitBox),
      dist: boxT,
    };
  }
  return null;
}

/** Damage multiplier for range. Sniper (noFalloff) is exempt. */
export function falloffFactor(spec: Pick<WeaponSpec, 'noFalloff'>, dist: number): number {
  if (spec.noFalloff || dist <= FALLOFF_START) return 1;
  if (dist >= FALLOFF_END) return FALLOFF_FLOOR;
  const t = (dist - FALLOFF_START) / (FALLOFF_END - FALLOFF_START);
  return 1 - t * (1 - FALLOFF_FLOOR);
}

/**
 * Damage one entity. Ignored while invincible or already dead.
 * Returns true when this call kills the entity.
 */
export function applyDamage(e: Entity, dmg: number, now: number): boolean {
  if (!e.alive || now < e.invincibleUntil) return false;
  e.hp = Math.max(0, e.hp - dmg);
  if (e.hp > 0) return false;
  e.alive = false;
  e.deadUntil = now + RESPAWN_MS;
  return true;
}

/**
 * Respawn a dead entity once its timer elapses: teleports to `spawn`,
 * restores hp, grants INVINCIBLE_MS of spawn protection. Returns true on respawn.
 */
export function updateRespawn(e: Entity, now: number, spawn: Vec3): boolean {
  if (e.alive || now < e.deadUntil) return false;
  e.alive = true;
  e.hp = e.maxHp;
  e.pos.x = spawn.x;
  e.pos.y = spawn.y;
  e.pos.z = spawn.z;
  e.invincibleUntil = now + INVINCIBLE_MS;
  return true;
}
