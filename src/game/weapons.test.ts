import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Weapon,
  WeaponRack,
  WEAPONS,
  SPREAD_RECOVER_MS,
  EARLY_FIRE_WINDOW_MS,
} from './weapons.ts';
import type { Vec3 } from './player.ts';

const ORG: Vec3 = { x: 0, y: 1.7, z: 0 };
const DIR: Vec3 = { x: 0, y: 0, z: -1 };
const rng = () => 0.5;

const angle = (a: Vec3, b: Vec3): number =>
  Math.acos(Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));

test('spec table has strictly 2 weapons: rifle & gatling with exact Round 5 specs', () => {
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
      swapMs: r.swapMs,
    },
    {
      id: 'rifle',
      dmg: 24,
      rpm: 700,
      mag: 30,
      pellets: 1,
      reloadMs: 1100,
      moveSpeedMult: 1.0,
      swapMs: 350,
    },
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
      spinUpMs: g.spinUpMs,
    },
    {
      id: 'gatling',
      dmg: 14,
      rpm: 900,
      mag: 300,
      pellets: 1,
      reloadMs: 3200,
      moveSpeedMult: 0.82,
      swapMs: 450,
      spinUpMs: 250,
    },
  );
});

test('rpm throttle: shots inside the interval are rejected', () => {
  const w = new Weapon(WEAPONS[0], rng);
  assert.ok(w.tryFire(0, ORG, DIR));
  assert.equal(w.tryFire(50, ORG, DIR), null);
  assert.equal(w.ammo, 29);
  assert.ok(w.tryFire(90, ORG, DIR));
  assert.equal(w.ammo, 28);
});

test('sustained fire never exceeds the rpm cap', () => {
  const w = new Weapon(WEAPONS[0], rng);
  let shots = 0;
  for (let t = 0; t <= 1000; t += 16) {
    if (w.tryFire(t, ORG, DIR)) shots++;
  }
  const cap = Math.ceil(1000 / w.interval) + 1;
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
  w.tick(WEAPONS[0].reloadMs - 1);
  assert.equal(w.reloading, true);
  assert.equal(w.ammo, 3);
  w.tick(WEAPONS[0].reloadMs);
  assert.equal(w.reloading, false);
  assert.equal(w.ammo, WEAPONS[0].mag);
  assert.ok(w.tryFire(WEAPONS[0].reloadMs + 1, ORG, DIR));
  assert.equal(w.ammo, WEAPONS[0].mag - 1);
});

test('all weapons initialize with a full magazine (30 / 300)', () => {
  const rack = new WeaponRack(rng);
  assert.deepEqual(
    rack.list.map((w) => [w.spec.id, w.ammo, w.spec.mag]),
    [
      ['rifle', 30, 30],
      ['gatling', 300, 300],
    ],
  );
});

test('fire during 0..900ms of rifle reload does NOT cancel reload; last 100ms allows early fire', () => {
  const w = new Weapon(WEAPONS[0], rng);
  w.ammo = 10;
  assert.equal(w.reload(0), true);
  for (const t of [50, 200, 500, 900, 999]) {
    assert.equal(w.tryFire(t, ORG, DIR), null, `should not fire at ${t}ms`);
    assert.equal(w.reloading, true, `reload must stay active at ${t}ms`);
    assert.equal(w.ammo, 10, `ammo must not drop at ${t}ms`);
  }
  const shot = w.tryFire(1100 - EARLY_FIRE_WINDOW_MS + 10, ORG, DIR);
  assert.ok(shot, 'expected early fire in last 100ms');
  assert.equal(w.reloading, false);
  assert.equal(w.ammo, WEAPONS[0].mag - 1);
});

test('gatling requires 250ms spin-up before firing, shoots 300 rounds at 900rpm, blocks fire during 3.2s reload', () => {
  const g = new Weapon(WEAPONS[1], rng);
  assert.ok(g.ammo >= 200 && g.ammo === 300);

  // Spin up in 50ms steps: cannot fire before 250ms
  g.tick(0, true);
  assert.equal(g.tryFire(0, ORG, DIR), null);
  for (let t = 50; t < 250; t += 50) {
    g.tick(t, true);
    assert.equal(g.spinningUp, true, `should be spinningUp at ${t}ms`);
    assert.equal(g.tryFire(t, ORG, DIR), null, `must not fire during spin-up at ${t}ms`);
  }
  assert.equal(g.ammo, 300, 'zero ammo spent during 250ms pre-heat');

  // At 250ms spin-up finishes → firing begins at 900 RPM (66.67ms/rd)
  g.tick(250, true);
  assert.equal(g.spinLevel, 1);
  assert.ok(g.tryFire(250, ORG, DIR), 'should fire once spin-up completes');
  assert.equal(g.ammo, 299);

  // Fire continuously for 200 rounds — still NOT empty (99 left), empties at 300
  let t = 250;
  let shots = 1;
  while (shots < 200) {
    t += 70;
    g.tick(t, true);
    if (g.tryFire(t, ORG, DIR)) shots++;
  }
  assert.equal(g.ammo, 100, '100 rounds should remain after 200 shots');
  while (g.ammo > 0) {
    t += 70;
    g.tick(t, true);
    g.tryFire(t, ORG, DIR);
  }
  assert.equal(g.ammo, 0);
  // Next trigger pull auto-reloads for 3200ms
  t += 70;
  g.tick(t, true);
  assert.equal(g.tryFire(t, ORG, DIR), null);
  assert.equal(g.reloading, true);
  assert.equal(g.reloadRemaining(t), 3200);

  // Strictly blocked during ENTIRE 3.2s reload (even at 3150ms)
  g.tick(t + 3150, true);
  assert.equal(g.tryFire(t + 3150, ORG, DIR), null, 'gatling cannot fire during reload');
  assert.equal(g.reloading, true);
  g.tick(t + 3200, false);
  assert.equal(g.reloading, false);
  assert.equal(g.ammo, 300);
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

test('WeaponRack cycles strictly rifle <-> gatling with 0.45s gatling swap and buffers swap in rifle reload tail', () => {
  const rack = new WeaponRack(rng);
  assert.equal(rack.list.length, 2);
  rack.current.ammo = 2;
  rack.current.reload(0);
  assert.equal(rack.current.reloading, true);

  // Swap rifle -> gatling takes 450ms
  assert.equal(rack.swap(100).spec.id, 'gatling');
  assert.equal(rack.list[0].reloading, false, 'outgoing reload cancelled');
  assert.equal(rack.swapDurationMs, 450);
  assert.equal(rack.swapping(549), true);
  assert.equal(rack.swapping(550), false);

  // Swap gatling -> rifle takes 350ms
  assert.equal(rack.swap(1000).spec.id, 'rifle');
  assert.equal(rack.swapDurationMs, 350);
  assert.equal(rack.swapping(1349), true);
  assert.equal(rack.swapping(1350), false);

  // Swap requested inside final 100ms of rifle reload buffers until reload completes
  rack.current.ammo = 5;
  rack.current.reload(2000); // ends at 3100
  assert.equal(rack.requestSwap(3040), null, 'should buffer swap inside last 100ms');
  assert.equal(rack.current.spec.id, 'rifle');
  const swapped = rack.tick(3100);
  assert.ok(swapped, 'buffered swap should trigger when reload completes');
  assert.equal(swapped.spec.id, 'gatling');
  assert.equal(rack.list[0].ammo, WEAPONS[0].mag, 'rifle finished reloading before swap');
});
