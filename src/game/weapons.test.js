// src/game/weapons.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

// src/game/weapons.ts
var WEAPONS = [
  {
    id: "rifle",
    name: "ASSAULT RIFLE",
    dmg: 24,
    rpm: 700,
    mag: 30,
    reloadMs: 1100,
    spread: 6e-3,
    recoil: 45e-4,
    maxSpread: 0.055,
    pellets: 1,
    moveSpeedMult: 1,
    swapMs: 350
  },
  {
    id: "gatling",
    name: "M134 GATLING",
    dmg: 14,
    rpm: 900,
    mag: 300,
    reloadMs: 3200,
    spread: 0.018,
    recoil: 12e-4,
    maxSpread: 0.045,
    pellets: 1,
    moveSpeedMult: 0.82,
    swapMs: 450,
    spinUpMs: 250,
    spinDownMs: 450,
    noEarlyFire: true
  }
];
var SPREAD_RECOVER_MS = 300;
var EARLY_FIRE_WINDOW_MS = 100;
var SWAP_DURATION_MS = 350;
var norm = (v) => {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
};
var cross = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x
});
var Weapon = class {
  spec;
  ammo;
  lastShotAt = -Infinity;
  /** timestamp when the current reload started; -1 = not reloading */
  reloadStartAt = -1;
  /** timestamp when the current reload finishes; -1 = not reloading */
  reloadUntil = -1;
  /** consecutive shots inside the burst window — drives recoil spread */
  burst = 0;
  lastFireAt = -Infinity;
  /** rotary barrel spin progress [0..1] for weapons with spinUpMs */
  _spin = 0;
  lastSpinAt = -Infinity;
  rng;
  constructor(spec, rng2 = Math.random) {
    this.spec = spec;
    this.ammo = spec.mag;
    this.rng = rng2;
  }
  get interval() {
    return 6e4 / this.spec.rpm;
  }
  get reloading() {
    return this.reloadUntil >= 0;
  }
  /** Normalized barrel spin-up [0..1]; always 1 for non-spin weapons. */
  get spinLevel() {
    return this.spec.spinUpMs ? this._spin : 1;
  }
  /** True when rotary barrels are spooling up (pre-heat) and not yet ready to fire. */
  get spinningUp() {
    return Boolean(this.spec.spinUpMs) && this._spin > 0 && this._spin < 1 - 1e-4;
  }
  reloadRemaining(now) {
    if (this.reloadUntil < 0) return 0;
    return Math.max(0, this.reloadUntil - now);
  }
  reloadSnapshot(now) {
    if (this.reloadUntil < 0 || this.reloadStartAt < 0) {
      return {
        active: false,
        elapsedMs: 0,
        durationMs: this.spec.reloadMs,
        progress: 0
      };
    }
    const durationMs = Math.max(1, this.reloadUntil - this.reloadStartAt);
    const elapsedMs = Math.max(0, Math.min(durationMs, now - this.reloadStartAt));
    return {
      active: true,
      elapsedMs,
      durationMs,
      progress: elapsedMs / durationMs
    };
  }
  inEarlyWindow(now) {
    if (this.spec.noEarlyFire) return false;
    return this.reloadUntil >= 0 && this.reloadUntil - now <= EARLY_FIRE_WINDOW_MS;
  }
  advanceReload(now) {
    if (this.reloadUntil < 0) return;
    if (now >= this.reloadUntil) {
      this.ammo = this.spec.mag;
      this.reloadStartAt = -1;
      this.reloadUntil = -1;
    }
  }
  /** Advance timed reload & barrel spin-up/down state. */
  tick(now, triggerHeld = false) {
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
  resetSpin() {
    this._spin = 0;
    this.lastSpinAt = -Infinity;
  }
  /** Current cone half-angle — base spread plus accumulated burst recoil. */
  spreadAt(now) {
    const b = now - this.lastFireAt > SPREAD_RECOVER_MS ? 0 : this.burst;
    const raw = this.spec.spread + this.spec.recoil * b;
    return this.spec.maxSpread !== void 0 ? Math.min(this.spec.maxSpread, raw) : raw;
  }
  /** Start a reload. False when already reloading or the mag is full. */
  reload(now) {
    this.advanceReload(now);
    if (this.reloading || this.ammo >= this.spec.mag) return false;
    this.reloadStartAt = now;
    this.reloadUntil = now + this.spec.reloadMs;
    if (this.spec.spinUpMs) this._spin = 0;
    return true;
  }
  cancelReload() {
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
  tryFire(now, origin, dir) {
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
    const spread = this.spec.maxSpread !== void 0 ? Math.min(this.spec.maxSpread, rawSpread) : rawSpread;
    this.burst = consecutive + 1;
    this.lastFireAt = now;
    const d = norm(dir);
    const shots = [];
    for (let i = 0; i < this.spec.pellets; i++) {
      shots.push({
        origin: { x: origin.x, y: origin.y, z: origin.z },
        dir: this.perturb(d, spread)
      });
    }
    return shots;
  }
  /** Rotate `d` by a random angle inside the `spread` cone (uniform in disc). */
  perturb(d, spread) {
    const theta = this.rng() * 2 * Math.PI;
    const r = spread * Math.sqrt(this.rng());
    const up = Math.abs(d.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
    const u = norm(cross(d, up));
    const v = cross(d, u);
    return norm({
      x: d.x + (u.x * Math.cos(theta) + v.x * Math.sin(theta)) * r,
      y: d.y + (u.y * Math.cos(theta) + v.y * Math.sin(theta)) * r,
      z: d.z + (u.z * Math.cos(theta) + v.z * Math.sin(theta)) * r
    });
  }
};
var WeaponRack = class {
  list;
  index = 0;
  swapUntil = -1;
  swapDurMs = SWAP_DURATION_MS;
  bufferedFireUntil = -1;
  bufferedSwapUntil = -1;
  constructor(rng2) {
    this.list = WEAPONS.map((s) => new Weapon(s, rng2));
  }
  get current() {
    return this.list[this.index];
  }
  get swapDurationMs() {
    return this.swapDurMs;
  }
  swapping(now) {
    return this.swapUntil >= 0 && now < this.swapUntil;
  }
  swapRemaining(now) {
    return this.swapUntil < 0 ? 0 : Math.max(0, this.swapUntil - now);
  }
  /** Queue a fire press if we are within the final 100ms of reload or swap. */
  noteFireIntent(now) {
    const inReloadTail = this.current.inEarlyWindow(now);
    const inSwapTail = this.swapping(now) && this.swapRemaining(now) <= EARLY_FIRE_WINDOW_MS;
    if (inReloadTail || inSwapTail) {
      this.bufferedFireUntil = now + EARLY_FIRE_WINDOW_MS + 50;
    }
  }
  /** True if a buffered fire press should fire now. */
  hasBufferedFire(now) {
    return this.bufferedFireUntil >= now;
  }
  clearBufferedFire() {
    this.bufferedFireUntil = -1;
  }
  /**
   * Request a weapon swap.
   * - If called during the final 100ms of a rifle reload, buffers the swap
   *   so the reload completes first and swaps immediately upon completion.
   * - Otherwise cancels any outgoing reload and swaps immediately.
   */
  requestSwap(now) {
    this.current.tick(now, false);
    if (this.current.inEarlyWindow(now)) {
      this.bufferedSwapUntil = now + EARLY_FIRE_WINDOW_MS + 50;
      return null;
    }
    return this.swap(now);
  }
  swap(now) {
    this.current.cancelReload();
    this.current.resetSpin();
    this.index = (this.index + 1) % this.list.length;
    this.bufferedSwapUntil = -1;
    this.bufferedFireUntil = -1;
    this.swapDurMs = this.current.spec.swapMs;
    if (now !== void 0) this.swapUntil = now + this.swapDurMs;
    return this.current;
  }
  resetSwap() {
    this.swapUntil = -1;
    this.swapDurMs = this.current.spec.swapMs;
    this.bufferedFireUntil = -1;
    this.bufferedSwapUntil = -1;
  }
  /**
   * Advance reload, spin, & swap timers. Returns the newly swapped Weapon if a
   * buffered swap triggered right after reload completion, else null.
   */
  tick(now, triggerHeld = false) {
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
};

// src/game/weapons.test.ts
var ORG = { x: 0, y: 1.7, z: 0 };
var DIR = { x: 0, y: 0, z: -1 };
var rng = () => 0.5;
var angle = (a, b) => Math.acos(Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));
test("spec table has strictly 2 weapons: rifle & gatling with exact Round 5 specs", () => {
  assert.equal(WEAPONS.length, 2);
  const [r, g] = WEAPONS;
  assert.deepEqual(
    {
      id: r.id,
      dmg: r.dmg,
      rpm: r.rpm,
      mag: r.mag,
      pellets: r.pellets,
      reloadMs: r.reloadMs,
      moveSpeedMult: r.moveSpeedMult,
      swapMs: r.swapMs
    },
    {
      id: "rifle",
      dmg: 24,
      rpm: 700,
      mag: 30,
      pellets: 1,
      reloadMs: 1100,
      moveSpeedMult: 1,
      swapMs: 350
    }
  );
  assert.deepEqual(
    {
      id: g.id,
      dmg: g.dmg,
      rpm: g.rpm,
      mag: g.mag,
      pellets: g.pellets,
      reloadMs: g.reloadMs,
      moveSpeedMult: g.moveSpeedMult,
      swapMs: g.swapMs,
      spinUpMs: g.spinUpMs
    },
    {
      id: "gatling",
      dmg: 14,
      rpm: 900,
      mag: 300,
      pellets: 1,
      reloadMs: 3200,
      moveSpeedMult: 0.82,
      swapMs: 450,
      spinUpMs: 250
    }
  );
});
test("rpm throttle: shots inside the interval are rejected", () => {
  const w = new Weapon(WEAPONS[0], rng);
  assert.ok(w.tryFire(0, ORG, DIR));
  assert.equal(w.tryFire(50, ORG, DIR), null);
  assert.equal(w.ammo, 29);
  assert.ok(w.tryFire(90, ORG, DIR));
  assert.equal(w.ammo, 28);
});
test("sustained fire never exceeds the rpm cap", () => {
  const w = new Weapon(WEAPONS[0], rng);
  let shots = 0;
  for (let t = 0; t <= 1e3; t += 16) {
    if (w.tryFire(t, ORG, DIR)) shots++;
  }
  const cap = Math.ceil(1e3 / w.interval) + 1;
  assert.ok(shots <= cap, `${shots} shots beat the cap ${cap}`);
  assert.ok(shots >= 11, `only ${shots} shots`);
});
test("firing consumes ammo; empty mag auto-reloads and cannot fire", () => {
  const w = new Weapon(WEAPONS[0], rng);
  w.ammo = 1;
  assert.ok(w.tryFire(0, ORG, DIR));
  assert.equal(w.ammo, 0);
  assert.equal(w.tryFire(200, ORG, DIR), null);
  assert.equal(w.reloading, true);
});
test("reload refills the mag after reloadMs", () => {
  const w = new Weapon(WEAPONS[0], rng);
  w.ammo = 3;
  assert.equal(w.reload(0), true);
  assert.equal(w.reload(10), false, "already reloading");
  assert.equal(w.reloading, true);
  w.tick(WEAPONS[0].reloadMs - 1);
  assert.equal(w.reloading, true);
  assert.equal(w.ammo, 3);
  w.tick(WEAPONS[0].reloadMs);
  assert.equal(w.reloading, false);
  assert.equal(w.ammo, WEAPONS[0].mag);
  assert.ok(w.tryFire(WEAPONS[0].reloadMs + 1, ORG, DIR));
  assert.equal(w.ammo, WEAPONS[0].mag - 1);
});
test("all weapons initialize with a full magazine (30 / 300)", () => {
  const rack = new WeaponRack(rng);
  assert.deepEqual(
    rack.list.map((w) => [w.spec.id, w.ammo, w.spec.mag]),
    [
      ["rifle", 30, 30],
      ["gatling", 300, 300]
    ]
  );
});
test("fire during 0..900ms of rifle reload does NOT cancel reload; last 100ms allows early fire", () => {
  const w = new Weapon(WEAPONS[0], rng);
  w.ammo = 10;
  assert.equal(w.reload(0), true);
  for (const t of [50, 200, 500, 900, 999]) {
    assert.equal(w.tryFire(t, ORG, DIR), null, `should not fire at ${t}ms`);
    assert.equal(w.reloading, true, `reload must stay active at ${t}ms`);
    assert.equal(w.ammo, 10, `ammo must not drop at ${t}ms`);
  }
  const shot = w.tryFire(1100 - EARLY_FIRE_WINDOW_MS + 10, ORG, DIR);
  assert.ok(shot, "expected early fire in last 100ms");
  assert.equal(w.reloading, false);
  assert.equal(w.ammo, WEAPONS[0].mag - 1);
});
test("gatling requires 250ms spin-up before firing, shoots 300 rounds at 900rpm, blocks fire during 3.2s reload", () => {
  const g = new Weapon(WEAPONS[1], rng);
  assert.ok(g.ammo >= 200 && g.ammo === 300);
  g.tick(0, true);
  assert.equal(g.tryFire(0, ORG, DIR), null);
  for (let t2 = 50; t2 < 250; t2 += 50) {
    g.tick(t2, true);
    assert.equal(g.spinningUp, true, `should be spinningUp at ${t2}ms`);
    assert.equal(g.tryFire(t2, ORG, DIR), null, `must not fire during spin-up at ${t2}ms`);
  }
  assert.equal(g.ammo, 300, "zero ammo spent during 250ms pre-heat");
  g.tick(250, true);
  assert.equal(g.spinLevel, 1);
  assert.ok(g.tryFire(250, ORG, DIR), "should fire once spin-up completes");
  assert.equal(g.ammo, 299);
  let t = 250;
  let shots = 1;
  while (shots < 200) {
    t += 70;
    g.tick(t, true);
    if (g.tryFire(t, ORG, DIR)) shots++;
  }
  assert.equal(g.ammo, 100, "100 rounds should remain after 200 shots");
  while (g.ammo > 0) {
    t += 70;
    g.tick(t, true);
    g.tryFire(t, ORG, DIR);
  }
  assert.equal(g.ammo, 0);
  t += 70;
  g.tick(t, true);
  assert.equal(g.tryFire(t, ORG, DIR), null);
  assert.equal(g.reloading, true);
  assert.equal(g.reloadRemaining(t), 3200);
  g.tick(t + 3150, true);
  assert.equal(g.tryFire(t + 3150, ORG, DIR), null, "gatling cannot fire during reload");
  assert.equal(g.reloading, true);
  g.tick(t + 3200, false);
  assert.equal(g.reloading, false);
  assert.equal(g.ammo, 300);
});
test("reload on a full mag is a no-op", () => {
  const w = new Weapon(WEAPONS[0], rng);
  assert.equal(w.reload(0), false);
  assert.equal(w.reloading, false);
});
test("first shot is precise; consecutive shots spread more", () => {
  const w = new Weapon(WEAPONS[0], rng);
  const d1 = w.tryFire(0, ORG, DIR)[0].dir;
  const dev1 = angle(d1, DIR);
  assert.ok(dev1 <= WEAPONS[0].spread + 1e-6, `first shot dev ${dev1}`);
  const d2 = w.tryFire(100, ORG, DIR)[0].dir;
  const d3 = w.tryFire(200, ORG, DIR)[0].dir;
  const dev2 = angle(d2, DIR);
  const dev3 = angle(d3, DIR);
  assert.ok(dev2 > dev1, `dev2 ${dev2} !> dev1 ${dev1}`);
  assert.ok(dev3 > dev2, `dev3 ${dev3} !> dev2 ${dev2}`);
  assert.ok(dev3 < WEAPONS[0].spread + WEAPONS[0].recoil * 2 + 1e-6);
});
test("spread decays back to base after 300ms without firing", () => {
  const w = new Weapon(WEAPONS[0], rng);
  w.tryFire(0, ORG, DIR);
  w.tryFire(100, ORG, DIR);
  const hot = w.spreadAt(100 + SPREAD_RECOVER_MS - 1);
  assert.ok(hot > WEAPONS[0].spread, `hot spread ${hot}`);
  const cool = w.spreadAt(100 + SPREAD_RECOVER_MS + 1);
  assert.ok(Math.abs(cool - WEAPONS[0].spread) < 1e-9, `cool spread ${cool}`);
  const d = w.tryFire(500, ORG, DIR)[0].dir;
  assert.ok(angle(d, DIR) <= WEAPONS[0].spread + 1e-6, "shot after pause not precise");
});
test("WeaponRack cycles strictly rifle <-> gatling with 0.45s gatling swap and buffers swap in rifle reload tail", () => {
  const rack = new WeaponRack(rng);
  assert.equal(rack.list.length, 2);
  rack.current.ammo = 2;
  rack.current.reload(0);
  assert.equal(rack.current.reloading, true);
  assert.equal(rack.swap(100).spec.id, "gatling");
  assert.equal(rack.list[0].reloading, false, "outgoing reload cancelled");
  assert.equal(rack.swapDurationMs, 450);
  assert.equal(rack.swapping(549), true);
  assert.equal(rack.swapping(550), false);
  assert.equal(rack.swap(1e3).spec.id, "rifle");
  assert.equal(rack.swapDurationMs, 350);
  assert.equal(rack.swapping(1349), true);
  assert.equal(rack.swapping(1350), false);
  rack.current.ammo = 5;
  rack.current.reload(2e3);
  assert.equal(rack.requestSwap(3040), null, "should buffer swap inside last 100ms");
  assert.equal(rack.current.spec.id, "rifle");
  const swapped = rack.tick(3100);
  assert.ok(swapped, "buffered swap should trigger when reload completes");
  assert.equal(swapped.spec.id, "gatling");
  assert.equal(rack.list[0].ammo, WEAPONS[0].mag, "rifle finished reloading before swap");
});
