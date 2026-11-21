// Weapon state machines — pure logic, no three.js / DOM.
// Exactly 2 weapons: ASSAULT RIFLE (primary, 30rd, 1.10s reload, 0.35s swap)
// and M134 GATLING (swap, 300rd, 900rpm, 250ms spin-up, 3.2s reload, 0.45s swap,
// 0.82x movement speed).
// Rifle allows early-fire / input-buffer in the final 100ms of reload;
// Gatling strictly blocks firing for the entire 3.2s drum reload and 250ms spin-up.

import type { Vec3 } from './player';
import type { Ray } from './damage';

export type WeaponId = 'rifle' | 'gatling';

export interface WeaponSpec {
  id: WeaponId;
  name: string;
  /** damage per bullet */
  dmg: number;
  rpm: number;
  mag: number;
  /** reload time in ms */
  reloadMs: number;
  /** base cone half-angle, radians — first shot accuracy */
  spread: number;
  /** extra cone per consecutive shot within burst window */
  recoil: number;
  /** optional ceiling on accumulated burst spread (radians) */
  maxSpread?: number;
  pellets: number;
  /** player movement speed multiplier while carrying this weapon */
  moveSpeedMult: number;
  /** duration (ms) to equip this weapon on swap */
  swapMs: number;
  /** barrel pre-heat / spin-up time (ms) before first bullet exits */
  spinUpMs?: number;
  /** barrel spin-down coast time (ms) after releasing trigger */
  spinDownMs?: number;
  /** when true, firing is strictly blocked until reload reaches 100% */
  noEarlyFire?: boolean;
  /** optional falloff exemption */
  noFalloff?: boolean;
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
    maxSpread: 0.055,
    pellets: 1,
    moveSpeedMult: 1.0,
    swapMs: 350,
  },
  {
    id: 'gatling',
    name: 'M134 GATLING',
    dmg: 14,
    rpm: 900,
    mag: 300,
    reloadMs: 3200,
    spread: 0.018,
    recoil: 0.0012,
    maxSpread: 0.045,
    pellets: 1,
    moveSpeedMult: 0.82,
    swapMs: 450,
    spinUpMs: 250,
    spinDownMs: 450,
    noEarlyFire: true,
  },
];

/** Consecutive shots closer than this keep the burst (and its spread) alive. */
export const SPREAD_RECOVER_MS = 300;
/** Final 100ms of rifle reload / swap allows input buffering & early fire. */
export const EARLY_FIRE_WINDOW_MS = 100;
/** Default weapon swap duration (rifle = 350ms; gatling overrides via spec.swapMs = 450ms). */
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
}

export class Weapon {
  readonly spec: WeaponSpec;
  ammo: number;
  private lastShotAt = -Infinity;
  /** timestamp when the current reload started; -1 = not reloading */
  private reloadStartAt = -1;
  /** timestamp when the current reload finishes; -1 = not reloading */
  private reloadUntil = -1;
  /** consecutive shots inside the burst window — drives recoil spread */
  private burst = 0;
  private lastFireAt = -Infinity;
  /** rotary barrel spin progress [0..1] for weapons with spinUpMs */
  private _spin = 0;
  private lastSpinAt = -Infinity;
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

  /** Normalized barrel spin-up [0..1]; always 1 for non-spin weapons. */
  get spinLevel(): number {
    return this.spec.spinUpMs ? this._spin : 1;
  }

  /** True when rotary barrels are spooling up (pre-heat) and not yet ready to fire. */
  get spinningUp(): boolean {
    return Boolean(this.spec.spinUpMs) && this._spin > 0 && this._spin < 1 - 1e-4;
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
      };
    }
    const durationMs = Math.max(1, this.reloadUntil - this.reloadStartAt);
    const elapsedMs = Math.max(0, Math.min(durationMs, now - this.reloadStartAt));
    return {
      active: true,
      elapsedMs,
      durationMs,
      progress: elapsedMs / durationMs,
    };
  }

  inEarlyWindow(now: number): boolean {
    if (this.spec.noEarlyFire) return false;
    return this.reloadUntil >= 0 && this.reloadUntil - now <= EARLY_FIRE_WINDOW_MS;
  }

  private advanceReload(now: number): void {
    if (this.reloadUntil < 0) return;
    if (now >= this.reloadUntil) {
      this.ammo = this.spec.mag;
      this.reloadStartAt = -1;
      this.reloadUntil = -1;
    }
  }

  /** Advance timed reload & barrel spin-up/down state. */
  tick(now: number, triggerHeld = false): void {
    this.advanceReload(now);
    const upMs = this.spec.spinUpMs;
    if (upMs && upMs > 0) {
      const downMs = this.spec.spinDownMs ?? 450;
      const dtMs = this.lastSpinAt === -Infinity ? 0 : Math.max(0, Math.min(120, now - this.lastSpinAt));
      this.lastSpinAt = now;
      const canSpin = triggerHeld && !this.reloading && this.ammo > 0;
      if (canSpin) {
        this._spin = Math.min(1, this._spin + dtMs / upMs);
      } else {
        this._spin = Math.max(0, this._spin - dtMs / downMs);
      }
    }
  }

  resetSpin(): void {
    this._spin = 0;
    this.lastSpinAt = -Infinity;
  }

  /** Current cone half-angle — base spread plus accumulated burst recoil. */
  spreadAt(now: number): number {
    const b = now - this.lastFireAt > SPREAD_RECOVER_MS ? 0 : this.burst;
    const raw = this.spec.spread + this.spec.recoil * b;
    return this.spec.maxSpread !== undefined ? Math.min(this.spec.maxSpread, raw) : raw;
  }

  /** Start a reload. False when already reloading or the mag is full. */
  reload(now: number): boolean {
    this.advanceReload(now);
    if (this.reloading || this.ammo >= this.spec.mag) return false;
    this.reloadStartAt = now;
    this.reloadUntil = now + this.spec.reloadMs;
    if (this.spec.spinUpMs) this._spin = 0;
    return true;
  }

  cancelReload(): void {
    this.reloadStartAt = -1;
    this.reloadUntil = -1;
  }

  /**
   * Try to fire at `now` (ms) from `origin` along `dir`.
   * - During reload: blocked cleanly (rifle allows early-fire in last 100ms;
   *   gatling blocks for the full 3.2s reload).
   * - For rotary weapons (spinUpMs > 0): blocked during the 250ms pre-heat
   *   until spinLevel reaches 1.0.
   * - An empty mag auto-starts a reload and returns null.
   */
  tryFire(now: number, origin: Vec3, dir: Vec3): Ray[] | null {
    this.advanceReload(now);
    if (this.reloading) {
      if (!this.spec.noEarlyFire && this.reloadUntil - now <= EARLY_FIRE_WINDOW_MS) {
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
    if (this.spec.spinUpMs && this._spin < 1 - 1e-4) {
      return null;
    }
    if (now - this.lastShotAt < this.interval - 1e-6) return null;
    this.lastShotAt = now;
    this.ammo--;

    const consecutive = now - this.lastFireAt <= SPREAD_RECOVER_MS ? this.burst : 0;
    const rawSpread = this.spec.spread + this.spec.recoil * consecutive;
    const spread =
      this.spec.maxSpread !== undefined ? Math.min(this.spec.maxSpread, rawSpread) : rawSpread;
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
 * The player's two-weapon loadout (rifle + gatling) with weight-aware swap
 * timing (350ms rifle, 450ms gatling) and final-100ms input buffering.
 */
export class WeaponRack {
  readonly list: Weapon[];
  index = 0;
  private swapUntil = -1;
  private swapDurMs = SWAP_DURATION_MS;
  private bufferedFireUntil = -1;
  private bufferedSwapUntil = -1;

  constructor(rng?: () => number) {
    this.list = WEAPONS.map((s) => new Weapon(s, rng));
  }

  get current(): Weapon {
    return this.list[this.index];
  }

  get swapDurationMs(): number {
    return this.swapDurMs;
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
   * - If called during the final 100ms of a rifle reload, buffers the swap
   *   so the reload completes first and swaps immediately upon completion.
   * - Otherwise cancels any outgoing reload and swaps immediately.
   */
  requestSwap(now: number): Weapon | null {
    this.current.tick(now, false);
    if (this.current.inEarlyWindow(now)) {
      this.bufferedSwapUntil = now + EARLY_FIRE_WINDOW_MS + 50;
      return null;
    }
    return this.swap(now);
  }

  swap(now?: number): Weapon {
    this.current.cancelReload();
    this.current.resetSpin();
    this.index = (this.index + 1) % this.list.length;
    this.bufferedSwapUntil = -1;
    this.bufferedFireUntil = -1;
    this.swapDurMs = this.current.spec.swapMs;
    if (now !== undefined) this.swapUntil = now + this.swapDurMs;
    return this.current;
  }

  resetSwap(): void {
    this.swapUntil = -1;
    this.swapDurMs = this.current.spec.swapMs;
    this.bufferedFireUntil = -1;
    this.bufferedSwapUntil = -1;
  }

  /**
   * Advance reload, spin, & swap timers. Returns the newly swapped Weapon if a
   * buffered swap triggered right after reload completion, else null.
   */
  tick(now: number, triggerHeld = false): Weapon | null {
    const spinTrigger = triggerHeld && !this.swapping(now);
    this.current.tick(now, spinTrigger);
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
