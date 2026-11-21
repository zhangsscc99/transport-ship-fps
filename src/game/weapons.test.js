// src/game/weapons.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

// src/game/weapons.ts
var WEAPONS = [
  { id: "rifle", name: "ASSAULT RIFLE", dmg: 24, rpm: 700, mag: 30, reloadMs: 1900, spread: 6e-3, recoil: 45e-4, pellets: 1 },
  { id: "sniper", name: "SNIPER RIFLE", dmg: 95, rpm: 45, mag: 5, reloadMs: 3200, spread: 15e-4, recoil: 0.09, pellets: 1, noFalloff: true },
  { id: "shotgun", name: "SHOTGUN", dmg: 12, rpm: 60, mag: 6, reloadMs: 2600, spread: 0.055, recoil: 0.02, pellets: 8 }
];
var SPREAD_RECOVER_MS = 300;
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
  /** timestamp when the current reload finishes; -1 = not reloading */
  reloadUntil = -1;
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
  finishReload(now) {
    if (this.reloadUntil >= 0 && now >= this.reloadUntil) {
      this.ammo = this.spec.mag;
      this.reloadUntil = -1;
    }
  }
  /** Advance timed weapon state (completes an elapsed reload even while idle). */
  tick(now) {
    this.finishReload(now);
  }
  /** Current cone half-angle — base spread plus accumulated burst recoil. */
  spreadAt(now) {
    const b = now - this.lastFireAt > SPREAD_RECOVER_MS ? 0 : this.burst;
    return this.spec.spread + this.spec.recoil * b;
  }
  /** Start a reload. False when already reloading or the mag is full. */
  reload(now) {
    this.finishReload(now);
    if (this.reloading || this.ammo >= this.spec.mag) return false;
    this.reloadUntil = now + this.spec.reloadMs;
    return true;
  }
  cancelReload() {
    this.reloadUntil = -1;
  }
  /**
   * Try to fire at `now` (ms) from `origin` along `dir`.
   * Returns one ray per pellet, or null when the shot is not allowed:
   * still within the rate limit, or mid-reload (which the trigger press
   * interrupts — the reload is reset, the shot does not happen).
   * An empty mag auto-starts a reload and also returns null.
   */
  tryFire(now, origin, dir) {
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
    const consecutive = now - this.lastFireAt <= SPREAD_RECOVER_MS ? this.burst : 0;
    const spread = this.spec.spread + this.spec.recoil * consecutive;
    this.burst = consecutive + 1;
    this.lastFireAt = now;
    const d = norm(dir);
    const shots = [];
    for (let i = 0; i < this.spec.pellets; i++) {
      shots.push({ origin: { x: origin.x, y: origin.y, z: origin.z }, dir: this.perturb(d, spread) });
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
  constructor(rng2) {
    this.list = WEAPONS.map((s) => new Weapon(s, rng2));
  }
  get current() {
    return this.list[this.index];
  }
  swap() {
    this.current.cancelReload();
    this.index = (this.index + 1) % this.list.length;
    return this.current;
  }
  tick(now) {
    this.current.tick(now);
  }
};

// src/game/weapons.test.ts
var ORG = { x: 0, y: 1.7, z: 0 };
var DIR = { x: 0, y: 0, z: -1 };
var rng = () => 0.5;
var angle = (a, b) => Math.acos(Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));
test("spec table matches SPEC: rifle / sniper / shotgun", () => {
  assert.equal(WEAPONS.length, 3);
  const [r, s, g] = WEAPONS;
  assert.deepEqual(
    { dmg: r.dmg, rpm: r.rpm, mag: r.mag, pellets: r.pellets },
    { dmg: 24, rpm: 700, mag: 30, pellets: 1 }
  );
  assert.deepEqual(
    { dmg: s.dmg, rpm: s.rpm, mag: s.mag, pellets: s.pellets, noFalloff: s.noFalloff },
    { dmg: 95, rpm: 45, mag: 5, pellets: 1, noFalloff: true }
  );
  assert.deepEqual(
    { dmg: g.dmg, rpm: g.rpm, mag: g.mag, pellets: g.pellets },
    { dmg: 12, rpm: 60, mag: 6, pellets: 8 }
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
test("trigger press during reload interrupts it without firing", () => {
  const w = new Weapon(WEAPONS[0], rng);
  w.ammo = 5;
  w.reload(0);
  assert.equal(w.tryFire(100, ORG, DIR), null);
  assert.equal(w.reloading, false, "reload was not interrupted");
  assert.equal(w.ammo, 5, "lost the remaining ammo");
  assert.ok(w.tryFire(300, ORG, DIR));
  assert.equal(w.ammo, 4);
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
test("WeaponRack cycles weapons and cancels the outgoing reload", () => {
  const rack = new WeaponRack(rng);
  rack.current.ammo = 2;
  rack.current.reload(0);
  assert.equal(rack.current.reloading, true);
  assert.equal(rack.swap().spec.id, "sniper");
  assert.equal(rack.list[0].reloading, false, "outgoing reload kept running");
  assert.equal(rack.swap().spec.id, "shotgun");
  assert.equal(rack.swap().spec.id, "rifle");
});
