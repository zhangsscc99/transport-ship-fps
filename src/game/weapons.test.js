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
    pellets: 1
  },
  {
    id: "sniper",
    name: "SNIPER RIFLE",
    dmg: 95,
    rpm: 45,
    mag: 5,
    reloadMs: 1550,
    spread: 15e-4,
    recoil: 0.09,
    pellets: 1,
    noFalloff: true,
    // 400ms bolt open + 350ms/shell + 400ms bolt slap + 400ms return = 1550ms for 1 round
    shellByShell: { leadMs: 400, perShellMs: 350, slapMs: 400, settleMs: 400 }
  },
  {
    id: "shotgun",
    name: "SHOTGUN",
    dmg: 12,
    rpm: 60,
    mag: 6,
    reloadMs: 950,
    spread: 0.055,
    recoil: 0.02,
    pellets: 8,
    // 100ms tilt + 350ms/shell + 400ms pump slap + 100ms return = 950ms for 1 shell
    shellByShell: { leadMs: 100, perShellMs: 350, slapMs: 400, settleMs: 100 }
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
  reloadAmmoStart = 0;
  reloadShellsTotal = 0;
  reloadShellsLoaded = 0;
  /** consecutive shots inside the burst window — drives recoil spread */
  burst = 0;
  lastFireAt = -Infinity;
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
        progress: 0,
        shellsTotal: 0,
        shellsLoaded: 0
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
      shellsLoaded: this.reloadShellsLoaded
    };
  }
  inEarlyWindow(now) {
    return this.reloadUntil >= 0 && this.reloadUntil - now <= EARLY_FIRE_WINDOW_MS;
  }
  advanceReload(now) {
    if (this.reloadUntil < 0) return;
    const sb = this.spec.shellByShell;
    if (sb && this.reloadShellsTotal > 0) {
      const elapsed = now - this.reloadStartAt;
      if (elapsed >= sb.leadMs) {
        const loaded = Math.min(
          this.reloadShellsTotal,
          Math.floor((elapsed - sb.leadMs) / sb.perShellMs + 1e-6)
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
  tick(now) {
    this.advanceReload(now);
  }
  /** Current cone half-angle — base spread plus accumulated burst recoil. */
  spreadAt(now) {
    const b = now - this.lastFireAt > SPREAD_RECOVER_MS ? 0 : this.burst;
    return this.spec.spread + this.spec.recoil * b;
  }
  /** Start a reload. False when already reloading or the mag is full. */
  reload(now) {
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
  cancelReload() {
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
  tryFire(now, origin, dir) {
    this.advanceReload(now);
    if (this.reloading) {
      if (this.reloadUntil - now <= EARLY_FIRE_WINDOW_MS) {
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
    const consecutive = now - this.lastFireAt <= SPREAD_RECOVER_MS ? this.burst : 0;
    const spread = this.spec.spread + this.spec.recoil * consecutive;
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
  bufferedFireUntil = -1;
  bufferedSwapUntil = -1;
  constructor(rng2) {
    this.list = WEAPONS.map((s) => new Weapon(s, rng2));
  }
  get current() {
    return this.list[this.index];
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
   * - If called with `now` during the final 100ms of a reload, buffers the swap
   *   so the reload completes first and swaps immediately upon completion.
   * - Otherwise cancels any outgoing reload and swaps immediately.
   */
  requestSwap(now) {
    this.current.tick(now);
    if (this.current.inEarlyWindow(now)) {
      this.bufferedSwapUntil = now + EARLY_FIRE_WINDOW_MS + 50;
      return null;
    }
    return this.swap(now);
  }
  swap(now) {
    this.current.cancelReload();
    this.index = (this.index + 1) % this.list.length;
    this.bufferedSwapUntil = -1;
    this.bufferedFireUntil = -1;
    if (now !== void 0) this.swapUntil = now + SWAP_DURATION_MS;
    return this.current;
  }
  resetSwap() {
    this.swapUntil = -1;
    this.bufferedFireUntil = -1;
    this.bufferedSwapUntil = -1;
  }
  /**
   * Advance reload & swap timers. Returns the newly swapped Weapon if a
   * buffered swap triggered right after reload completion, else null.
   */
  tick(now) {
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
};

// src/game/weapons.test.ts
var ORG = { x: 0, y: 1.7, z: 0 };
var DIR = { x: 0, y: 0, z: -1 };
var rng = () => 0.5;
var angle = (a, b) => Math.acos(Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));
test("spec table matches SPEC: rifle / sniper / shotgun & reload timings", () => {
  assert.equal(WEAPONS.length, 3);
  const [r, s, g] = WEAPONS;
  assert.deepEqual(
    { dmg: r.dmg, rpm: r.rpm, mag: r.mag, pellets: r.pellets, reloadMs: r.reloadMs },
    { dmg: 24, rpm: 700, mag: 30, pellets: 1, reloadMs: 1100 }
  );
  assert.deepEqual(
    { dmg: s.dmg, rpm: s.rpm, mag: s.mag, pellets: s.pellets, noFalloff: s.noFalloff, reloadMs: s.reloadMs },
    { dmg: 95, rpm: 45, mag: 5, pellets: 1, noFalloff: true, reloadMs: 1550 }
  );
  assert.deepEqual(
    { dmg: g.dmg, rpm: g.rpm, mag: g.mag, pellets: g.pellets, reloadMs: g.reloadMs },
    { dmg: 12, rpm: 60, mag: 6, pellets: 8, reloadMs: 950 }
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
test("reload refills the mag after reloadMs (both via tick and via tryFire)", () => {
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
test("all weapons initialize with a full magazine (30 / 5 / 6)", () => {
  const rack = new WeaponRack(rng);
  assert.deepEqual(
    rack.list.map((w) => [w.spec.id, w.ammo, w.spec.mag]),
    [
      ["rifle", 30, 30],
      ["sniper", 5, 5],
      ["shotgun", 6, 6]
    ]
  );
});
test("fire during 0..900ms of rifle reload does NOT cancel reload or consume ammo; last 100ms allows early fire", () => {
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
test("shotgun & sniper reload shell-by-shell (350ms/shell + 400ms slap)", () => {
  const sg = new Weapon(WEAPONS[2], rng);
  sg.ammo = 4;
  assert.equal(sg.reload(0), true);
  sg.tick(450);
  assert.equal(sg.ammo, 5);
  assert.equal(sg.reloading, true);
  sg.tick(800);
  assert.equal(sg.ammo, 6);
  assert.equal(sg.reloading, true);
  sg.tick(1300);
  assert.equal(sg.reloading, false);
  assert.equal(sg.ammo, 6);
  sg.ammo = 5;
  sg.reload(2e3);
  assert.equal(sg.reloadRemaining(2e3), 950);
  const sn = new Weapon(WEAPONS[1], rng);
  sn.ammo = 4;
  sn.reload(0);
  assert.equal(sn.reloadRemaining(0), 1550);
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
test("shotgun fires all 8 pellets on one trigger pull", () => {
  const w = new Weapon(WEAPONS[2], rng);
  const shots = w.tryFire(0, ORG, DIR);
  assert.equal(shots.length, 8);
  assert.equal(w.ammo, 5, "one shell per trigger, not per pellet");
  for (const s of shots) {
    assert.ok(angle(s.dir, DIR) <= WEAPONS[2].spread + 1e-6, "pellet outside cone");
    assert.deepEqual(s.origin, ORG);
  }
});
test("WeaponRack cycles weapons, cancels early reload, and buffers swap in last 100ms", () => {
  const rack = new WeaponRack(rng);
  rack.current.ammo = 2;
  rack.current.reload(0);
  assert.equal(rack.current.reloading, true);
  assert.equal(rack.swap().spec.id, "sniper");
  assert.equal(rack.list[0].reloading, false, "outgoing reload kept running");
  assert.equal(rack.swap().spec.id, "shotgun");
  assert.equal(rack.swap(1e3).spec.id, "rifle");
  assert.equal(rack.swapping(1e3), true);
  assert.equal(rack.swapping(1e3 + SWAP_DURATION_MS), false);
  rack.current.ammo = 5;
  rack.current.reload(2e3);
  assert.equal(rack.requestSwap(3040), null, "should buffer swap inside last 100ms");
  assert.equal(rack.current.spec.id, "rifle");
  const swapped = rack.tick(3100);
  assert.ok(swapped, "buffered swap should trigger when reload completes");
  assert.equal(swapped.spec.id, "sniper");
  assert.equal(rack.list[0].ammo, WEAPONS[0].mag, "rifle finished reloading before swap");
});
