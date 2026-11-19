import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Weapon, WeaponRack, WEAPONS, SPREAD_RECOVER_MS } from './weapons.ts';
import type { Vec3 } from './player.ts';

const ORG: Vec3 = { x: 0, y: 1.7, z: 0 };
const DIR: Vec3 = { x: 0, y: 0, z: -1 };
const rng = () => 0.5; // deterministic mid-disc spread for deviation asserts

const angle = (a: Vec3, b: Vec3): number =>
  Math.acos(Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));

test('spec table matches SPEC: rifle / sniper / shotgun', () => {
  assert.equal(WEAPONS.length, 3);
  const [r, s, g] = WEAPONS;
  assert.deepEqual(
    { dmg: r.dmg, rpm: r.rpm, mag: r.mag, pellets: r.pellets },
    { dmg: 24, rpm: 700, mag: 30, pellets: 1 },
  );
  assert.deepEqual(
    { dmg: s.dmg, rpm: s.rpm, mag: s.mag, pellets: s.pellets, noFalloff: s.noFalloff },
    { dmg: 95, rpm: 45, mag: 5, pellets: 1, noFalloff: true },
  );
  assert.deepEqual(
    { dmg: g.dmg, rpm: g.rpm, mag: g.mag, pellets: g.pellets },
    { dmg: 12, rpm: 60, mag: 6, pellets: 8 },
  );
});

test('rpm throttle: shots inside the interval are rejected', () => {
  const w = new Weapon(WEAPONS[0], rng); // 700rpm → 85.7ms interval
  assert.ok(w.tryFire(0, ORG, DIR));
  assert.equal(w.tryFire(50, ORG, DIR), null);
  assert.equal(w.ammo, 29);
  assert.ok(w.tryFire(90, ORG, DIR)); // 90ms > 85.7ms
  assert.equal(w.ammo, 28);
});

test('sustained fire never exceeds the rpm cap', () => {
  const w = new Weapon(WEAPONS[0], rng);
  let shots = 0;
  for (let t = 0; t <= 1000; t += 16) {
    if (w.tryFire(t, ORG, DIR)) shots++;
  }
  const cap = Math.ceil(1000 / w.interval) + 1; // ~12.7
  assert.ok(shots <= cap, `${shots} shots beat the cap ${cap}`);
  assert.ok(shots >= 11, `only ${shots} shots`);
});

test('firing consumes ammo; empty mag auto-reloads and cannot fire', () => {
  const w = new Weapon(WEAPONS[0], rng);
  w.ammo = 1;
  assert.ok(w.tryFire(0, ORG, DIR));
  assert.equal(w.ammo, 0);
  assert.equal(w.tryFire(200, ORG, DIR), null);
  assert.equal(w.reloading, true);
});

test('reload refills the mag after reloadMs', () => {
  const w = new Weapon(WEAPONS[0], rng);
  w.ammo = 3;
  assert.equal(w.reload(0), true);
  assert.equal(w.reload(10), false, 'already reloading');
  assert.equal(w.reloading, true);
  assert.ok(w.tryFire(WEAPONS[0].reloadMs + 1, ORG, DIR));
  assert.equal(w.ammo, WEAPONS[0].mag - 1);
});

test('trigger press during reload interrupts it without firing', () => {
  const w = new Weapon(WEAPONS[0], rng);
  w.ammo = 5;
  w.reload(0);
  assert.equal(w.tryFire(100, ORG, DIR), null);
  assert.equal(w.reloading, false, 'reload was not interrupted');
  assert.equal(w.ammo, 5, 'lost the remaining ammo');
  // next press (past the rate interval) fires leftover ammo
  assert.ok(w.tryFire(300, ORG, DIR));
  assert.equal(w.ammo, 4);
});

test('reload on a full mag is a no-op', () => {
  const w = new Weapon(WEAPONS[0], rng);
  assert.equal(w.reload(0), false);
  assert.equal(w.reloading, false);
});

test('first shot is precise; consecutive shots spread more', () => {
  const w = new Weapon(WEAPONS[0], rng);
  const d1 = w.tryFire(0, ORG, DIR)![0].dir;
  const dev1 = angle(d1, DIR);
  assert.ok(dev1 <= WEAPONS[0].spread + 1e-6, `first shot dev ${dev1}`);
  const d2 = w.tryFire(100, ORG, DIR)![0].dir;
  const d3 = w.tryFire(200, ORG, DIR)![0].dir;
  const dev2 = angle(d2, DIR);
  const dev3 = angle(d3, DIR);
  assert.ok(dev2 > dev1, `dev2 ${dev2} !> dev1 ${dev1}`);
  assert.ok(dev3 > dev2, `dev3 ${dev3} !> dev2 ${dev2}`);
  // deviation ≈ 0.707·(spread + recoil·n) with rng()=0.5
  assert.ok(dev3 < WEAPONS[0].spread + WEAPONS[0].recoil * 2 + 1e-6);
});

test('spread decays back to base after 300ms without firing', () => {
  const w = new Weapon(WEAPONS[0], rng);
  w.tryFire(0, ORG, DIR);
  w.tryFire(100, ORG, DIR);
  const hot = w.spreadAt(100 + SPREAD_RECOVER_MS - 1);
  assert.ok(hot > WEAPONS[0].spread, `hot spread ${hot}`);
  const cool = w.spreadAt(100 + SPREAD_RECOVER_MS + 1);
  assert.ok(Math.abs(cool - WEAPONS[0].spread) < 1e-9, `cool spread ${cool}`);
  const d = w.tryFire(500, ORG, DIR)![0].dir;
  assert.ok(angle(d, DIR) <= WEAPONS[0].spread + 1e-6, 'shot after pause not precise');
});

test('shotgun fires all 8 pellets on one trigger pull', () => {
  const w = new Weapon(WEAPONS[2], rng);
  const shots = w.tryFire(0, ORG, DIR)!;
  assert.equal(shots.length, 8);
  assert.equal(w.ammo, 5, 'one shell per trigger, not per pellet');
  for (const s of shots) {
    assert.ok(angle(s.dir, DIR) <= WEAPONS[2].spread + 1e-6, 'pellet outside cone');
    assert.deepEqual(s.origin, ORG);
  }
});

test('WeaponRack cycles weapons and cancels the outgoing reload', () => {
  const rack = new WeaponRack(rng);
  rack.current.ammo = 2;
  rack.current.reload(0);
  assert.equal(rack.current.reloading, true);
  assert.equal(rack.swap().spec.id, 'sniper');
  assert.equal(rack.list[0].reloading, false, 'outgoing reload kept running');
  assert.equal(rack.swap().spec.id, 'shotgun');
  assert.equal(rack.swap().spec.id, 'rifle');
});
