// Weapon state machines — pure logic, no three.js / DOM.
// Spec numbers from docs/SPEC.md §武器. Rays are plain data
// ({origin, dir}); the render layer turns them into visuals.

import type { Vec3 } from './player';
import type { Ray } from './damage';

export interface WeaponSpec {
  id: 'rifle' | 'sniper' | 'shotgun';
  name: string;
  /** damage per bullet / per pellet */
  dmg: number;
  rpm: number;
  mag: number;
  reloadMs: number;
  /** base cone half-angle, radians — the first shot's accuracy */
  spread: number;
  /** extra cone per consecutive shot within the burst window */
  recoil: number;
  pellets: number;
  /** sniper keeps full damage at range (SPEC: 狙击除外) */
  noFalloff?: boolean;
}

export const WEAPONS: readonly WeaponSpec[] = [
  { id: 'rifle', name: 'ASSAULT RIFLE', dmg: 24, rpm: 700, mag: 30, reloadMs: 1900, spread: 0.006, recoil: 0.0045, pellets: 1 },
  { id: 'sniper', name: 'SNIPER RIFLE', dmg: 95, rpm: 45, mag: 5, reloadMs: 3200, spread: 0.0015, recoil: 0.09, pellets: 1, noFalloff: true },
  { id: 'shotgun', name: 'SHOTGUN', dmg: 12, rpm: 60, mag: 6, reloadMs: 2600, spread: 0.055, recoil: 0.02, pellets: 8 },
];

/** Consecutive shots closer than this keep the burst (and its spread) alive. */
export const SPREAD_RECOVER_MS = 300;

type V3 = { x: number; y: number; z: number };
const norm = (v: V3): V3 => {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
};
const cross = (a: V3, b: V3): V3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

export class Weapon {
  readonly spec: WeaponSpec;
  ammo: number;
  private lastShotAt = -Infinity;
  /** timestamp when the current reload finishes; -1 = not reloading */
  private reloadUntil = -1;
  /** consecutive shots inside the burst window — drives recoil spread */
  private burst = 0;
  private lastFireAt = -Infinity;
  private rng: () => number;

  constructor(spec: WeaponSpec, rng: () => number = Math.random) {
    this.spec = spec;
    this.ammo = spec.mag;
    this.rng = rng;
  }

  get interval(): number {
    return 60000 / this.spec.rpm;
  }

  get reloading(): boolean {
    return this.reloadUntil >= 0;
  }

  private finishReload(now: number): void {
    if (this.reloadUntil >= 0 && now >= this.reloadUntil) {
      this.ammo = this.spec.mag;
      this.reloadUntil = -1;
    }
  }

  /** Advance timed weapon state (completes an elapsed reload even while idle). */
  tick(now: number): void {
    this.finishReload(now);
  }

  /** Current cone half-angle — base spread plus accumulated burst recoil. */
  spreadAt(now: number): number {
    const b = now - this.lastFireAt > SPREAD_RECOVER_MS ? 0 : this.burst;
    return this.spec.spread + this.spec.recoil * b;
  }

  /** Start a reload. False when already reloading or the mag is full. */
  reload(now: number): boolean {
    this.finishReload(now);
    if (this.reloading || this.ammo >= this.spec.mag) return false;
    this.reloadUntil = now + this.spec.reloadMs;
    return true;
  }

  cancelReload(): void {
    this.reloadUntil = -1;
  }

  /**
   * Try to fire at `now` (ms) from `origin` along `dir`.
   * Returns one ray per pellet, or null when the shot is not allowed:
   * still within the rate limit, or mid-reload (which the trigger press
   * interrupts — the reload is reset, the shot does not happen).
   * An empty mag auto-starts a reload and also returns null.
   */
  tryFire(now: number, origin: Vec3, dir: Vec3): Ray[] | null {
    this.finishReload(now);
    if (this.reloading) {
      this.cancelReload();
      return null;
    }
    if (this.ammo <= 0) {
      this.reload(now);
      return null;
    }
    if (now - this.lastShotAt < this.interval - 1e-6) return null;
    this.lastShotAt = now;
    this.ammo--;

    // this shot's spread: base + recoil × consecutive shots before it
    const consecutive = now - this.lastFireAt <= SPREAD_RECOVER_MS ? this.burst : 0;
    const spread = this.spec.spread + this.spec.recoil * consecutive;
    this.burst = consecutive + 1;
    this.lastFireAt = now;

    const d = norm(dir);
    const shots: Ray[] = [];
    for (let i = 0; i < this.spec.pellets; i++) {
      shots.push({ origin: { x: origin.x, y: origin.y, z: origin.z }, dir: this.perturb(d, spread) });
    }
    return shots;
  }

  /** Rotate `d` by a random angle inside the `spread` cone (uniform in disc). */
  private perturb(d: V3, spread: number): V3 {
    const theta = this.rng() * 2 * Math.PI;
    const r = spread * Math.sqrt(this.rng());
    const up: V3 = Math.abs(d.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
    const u = norm(cross(d, up));
    const v = cross(d, u);
    return norm({
      x: d.x + (u.x * Math.cos(theta) + v.x * Math.sin(theta)) * r,
      y: d.y + (u.y * Math.cos(theta) + v.y * Math.sin(theta)) * r,
      z: d.z + (u.z * Math.cos(theta) + v.z * Math.sin(theta)) * r,
    });
  }
}

/** The player's three-weapon loadout; swap cycles, reloading weapon is cancelled. */
export class WeaponRack {
  readonly list: Weapon[];
  index = 0;

  constructor(rng?: () => number) {
    this.list = WEAPONS.map((s) => new Weapon(s, rng));
  }

  get current(): Weapon {
    return this.list[this.index];
  }

  swap(): Weapon {
    this.current.cancelReload();
    this.index = (this.index + 1) % this.list.length;
    return this.current;
  }

  tick(now: number): void {
    this.current.tick(now);
  }
}
