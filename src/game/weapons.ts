// Weapon state machines — pure logic, no three.js / DOM.
// Timings: rifle 1.10s / sniper 1.55s / shotgun 0.95s.
// Shotgun & sniper support shell-by-shell reload (350ms/shell + 400ms final slap).
// Firing is blocked during reload until the last 100ms early-fire/input-buffer
// window so reload cannot be accidentally cancelled mid-animation.
// Weapon swap takes 350ms with an input buffer in the final 100ms.

import type { Vec3 } from './player';
import type { Ray } from './damage';

export interface WeaponSpec {
  id: 'rifle' | 'sniper' | 'shotgun';
  name: string;
  /** damage per bullet / per pellet */
  dmg: number;
  rpm: number;
  mag: number;
  /** base reload time in ms (rifle full mag; shotgun/sniper 1-shell reload) */
  reloadMs: number;
  /** base cone half-angle, radians — the first shot's accuracy */
  spread: number;
  /** extra cone per consecutive shot within the burst window */
  recoil: number;
  pellets: number;
  /** sniper keeps full damage at range (SPEC: 狙击除外) */
  noFalloff?: boolean;
  /** shell-by-shell reload parameters (shotgun / sniper) */
  shellByShell?: {
    leadMs: number;
    perShellMs: number;
    slapMs: number;
    settleMs: number;
  };
}

export const WEAPONS: readonly WeaponSpec[] = [
  {
    id: 'rifle',
    name: 'ASSAULT RIFLE',
    dmg: 24,
    rpm: 700,
    mag: 30,
    reloadMs: 1100,
    spread: 0.006,
    recoil: 0.0045,
    pellets: 1,
  },
  {
    id: 'sniper',
    name: 'SNIPER RIFLE',
    dmg: 95,
    rpm: 45,
    mag: 5,
    reloadMs: 1550,
    spread: 0.0015,
    recoil: 0.09,
    pellets: 1,
    noFalloff: true,
    // 400ms bolt open + 350ms/shell + 400ms bolt slap + 400ms return = 1550ms for 1 round
    shellByShell: { leadMs: 400, perShellMs: 350, slapMs: 400, settleMs: 400 },
  },
  {
    id: 'shotgun',
    name: 'SHOTGUN',
    dmg: 12,
    rpm: 60,
    mag: 6,
    reloadMs: 950,
    spread: 0.055,
    recoil: 0.02,
    pellets: 8,
    // 100ms tilt + 350ms/shell + 400ms pump slap + 100ms return = 950ms for 1 shell
    shellByShell: { leadMs: 100, perShellMs: 350, slapMs: 400, settleMs: 100 },
  },
];

/** Consecutive shots closer than this keep the burst (and its spread) alive. */
export const SPREAD_RECOVER_MS = 300;
/** Final 100ms of reload/swap allows input buffering & early fire. */
export const EARLY_FIRE_WINDOW_MS = 100;
/** Continuous weapon swap duration (old gun drops 0–175ms, new rises 175–350ms). */
export const SWAP_DURATION_MS = 350;

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

export interface ReloadSnapshot {
  active: boolean;
  elapsedMs: number;
  durationMs: number;
  progress: number;
  shellsTotal: number;
  shellsLoaded: number;
}

export class Weapon {
  readonly spec: WeaponSpec;
  ammo: number;
  private lastShotAt = -Infinity;
  /** timestamp when the current reload started; -1 = not reloading */
  private reloadStartAt = -1;
  /** timestamp when the current reload finishes; -1 = not reloading */
  private reloadUntil = -1;
  private reloadAmmoStart = 0;
  private reloadShellsTotal = 0;
  private reloadShellsLoaded = 0;
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

  reloadRemaining(now: number): number {
    if (this.reloadUntil < 0) return 0;
    return Math.max(0, this.reloadUntil - now);
  }

  reloadSnapshot(now: number): ReloadSnapshot {
    if (this.reloadUntil < 0 || this.reloadStartAt < 0) {
      return {
        active: false,
        elapsedMs: 0,
        durationMs: this.spec.reloadMs,
        progress: 0,
        shellsTotal: 0,
        shellsLoaded: 0,
      };
    }
    const durationMs = Math.max(1, this.reloadUntil - this.reloadStartAt);
    const elapsedMs = Math.max(0, Math.min(durationMs, now - this.reloadStartAt));
    return {
      active: true,
      elapsedMs,
      durationMs,
      progress: elapsedMs / durationMs,
      shellsTotal: this.reloadShellsTotal,
      shellsLoaded: this.reloadShellsLoaded,
    };
  }

  inEarlyWindow(now: number): boolean {
    return this.reloadUntil >= 0 && this.reloadUntil - now <= EARLY_FIRE_WINDOW_MS;
  }

  private advanceReload(now: number): void {
    if (this.reloadUntil < 0) return;
    const sb = this.spec.shellByShell;
    if (sb && this.reloadShellsTotal > 0) {
      const elapsed = now - this.reloadStartAt;
      if (elapsed >= sb.leadMs) {
        const loaded = Math.min(
          this.reloadShellsTotal,
          Math.floor((elapsed - sb.leadMs) / sb.perShellMs + 1e-6),
        );
        if (loaded > this.reloadShellsLoaded) {
          this.reloadShellsLoaded = loaded;
          this.ammo = Math.min(this.spec.mag, this.reloadAmmoStart + loaded);
        }
      }
    }
    if (now >= this.reloadUntil) {
      this.ammo = this.spec.mag;
      this.reloadStartAt = -1;
      this.reloadUntil = -1;
      this.reloadShellsTotal = 0;
      this.reloadShellsLoaded = 0;
    }
  }

  /** Advance timed weapon state (completes shells & elapsed reload even while idle). */
  tick(now: number): void {
    this.advanceReload(now);
  }

  /** Current cone half-angle — base spread plus accumulated burst recoil. */
  spreadAt(now: number): number {
    const b = now - this.lastFireAt > SPREAD_RECOVER_MS ? 0 : this.burst;
    return this.spec.spread + this.spec.recoil * b;
  }

  /** Start a reload. False when already reloading or the mag is full. */
  reload(now: number): boolean {
    this.advanceReload(now);
    if (this.reloading || this.ammo >= this.spec.mag) return false;
    const missing = this.spec.mag - this.ammo;
    this.reloadStartAt = now;
    this.reloadAmmoStart = this.ammo;
    this.reloadShellsLoaded = 0;
    const sb = this.spec.shellByShell;
    if (sb) {
      this.reloadShellsTotal = missing;
      const totalMs = sb.leadMs + missing * sb.perShellMs + sb.slapMs + sb.settleMs;
      this.reloadUntil = now + totalMs;
    } else {
      this.reloadShellsTotal = 0;
      this.reloadUntil = now + this.spec.reloadMs;
    }
    return true;
  }

  cancelReload(): void {
    this.reloadStartAt = -1;
    this.reloadUntil = -1;
    this.reloadShellsTotal = 0;
    this.reloadShellsLoaded = 0;
  }

  /**
   * Try to fire at `now` (ms) from `origin` along `dir`.
   * - During reload with >100ms remaining: blocked cleanly (does NOT cancel reload,
   *   does NOT consume ammo).
   * - During the final 100ms of reload: magazine is seated & chambered, so the
   *   reload finishes immediately and the shot fires (no waiting for tail settle).
   * - An empty mag auto-starts a reload and returns null.
   */
  tryFire(now: number, origin: Vec3, dir: Vec3): Ray[] | null {
    this.advanceReload(now);
    if (this.reloading) {
      if (this.reloadUntil - now <= EARLY_FIRE_WINDOW_MS) {
        // Final 100ms early-fire window: finish reload & allow immediate shot
        this.ammo = this.spec.mag;
        this.cancelReload();
      } else {
        return null;
      }
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
      shots.push({
        origin: { x: origin.x, y: origin.y, z: origin.z },
        dir: this.perturb(d, spread),
      });
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

/**
 * The player's three-weapon loadout with smooth swap timing (350ms) and
 * final-100ms input buffering for fire & swap actions.
 */
export class WeaponRack {
  readonly list: Weapon[];
  index = 0;
  private swapUntil = -1;
  private bufferedFireUntil = -1;
  private bufferedSwapUntil = -1;

  constructor(rng?: () => number) {
    this.list = WEAPONS.map((s) => new Weapon(s, rng));
  }

  get current(): Weapon {
    return this.list[this.index];
  }

  swapping(now: number): boolean {
    return this.swapUntil >= 0 && now < this.swapUntil;
  }

  swapRemaining(now: number): number {
    return this.swapUntil < 0 ? 0 : Math.max(0, this.swapUntil - now);
  }

  /** Queue a fire press if we are within the final 100ms of reload or swap. */
  noteFireIntent(now: number): void {
    const inReloadTail = this.current.inEarlyWindow(now);
    const inSwapTail =
      this.swapping(now) && this.swapRemaining(now) <= EARLY_FIRE_WINDOW_MS;
    if (inReloadTail || inSwapTail) {
      this.bufferedFireUntil = now + EARLY_FIRE_WINDOW_MS + 50;
    }
  }

  /** True if a buffered fire press should fire now. */
  hasBufferedFire(now: number): boolean {
    return this.bufferedFireUntil >= now;
  }

  clearBufferedFire(): void {
    this.bufferedFireUntil = -1;
  }

  /**
   * Request a weapon swap.
   * - If called with `now` during the final 100ms of a reload, buffers the swap
   *   so the reload completes first and swaps immediately upon completion.
   * - Otherwise cancels any outgoing reload and swaps immediately.
   */
  requestSwap(now: number): Weapon | null {
    this.current.tick(now);
    if (this.current.inEarlyWindow(now)) {
      this.bufferedSwapUntil = now + EARLY_FIRE_WINDOW_MS + 50;
      return null;
    }
    return this.swap(now);
  }

  swap(now?: number): Weapon {
    this.current.cancelReload();
    this.index = (this.index + 1) % this.list.length;
    this.bufferedSwapUntil = -1;
    this.bufferedFireUntil = -1;
    if (now !== undefined) this.swapUntil = now + SWAP_DURATION_MS;
    return this.current;
  }

  resetSwap(): void {
    this.swapUntil = -1;
    this.bufferedFireUntil = -1;
    this.bufferedSwapUntil = -1;
  }

  /**
   * Advance reload & swap timers. Returns the newly swapped Weapon if a
   * buffered swap triggered right after reload completion, else null.
   */
  tick(now: number): Weapon | null {
    this.current.tick(now);
    if (this.swapUntil >= 0 && now >= this.swapUntil) {
      this.swapUntil = -1;
    }
    if (this.bufferedFireUntil >= 0 && now > this.bufferedFireUntil) {
      this.bufferedFireUntil = -1;
    }
    if (this.bufferedSwapUntil >= 0) {
      if (now > this.bufferedSwapUntil) {
        this.bufferedSwapUntil = -1;
      } else if (!this.current.reloading) {
        return this.swap(now);
      }
    }
    return null;
  }
}
