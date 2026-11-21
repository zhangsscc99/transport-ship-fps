import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  traceHit,
  falloffFactor,
  applyDamage,
  updateRespawn,
  updatePlayerRegen,
  PLAYER_MAX_HP,
  PLAYER_REGEN_DELAY_MS,
  PLAYER_REGEN_PER_SEC,
  FALLOFF_FLOOR,
  HEADSHOT_MULT,
  type Ray,
} from './damage.ts';
import { createEntity, INVINCIBLE_MS, RESPAWN_MS, type Entity } from './entities.ts';
import { WEAPONS } from './weapons.ts';
import type { Box } from './map.ts';
import type { Vec3 } from './player.ts';

const NO_BOXES: Box[] = [];

function ray(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): Ray {
  const l = Math.hypot(dx, dy, dz);
  return { origin: { x: ox, y: oy, z: oz }, dir: { x: dx / l, y: dy / l, z: dz / l } };
}

function entAt(x: number, z: number, patch: Partial<Entity> = {}): Entity {
  return { ...createEntity('e', { x, y: 0, z }), ...patch };
}

test('a clear shot hits the entity at the surface distance', () => {
  const e = entAt(0, -10);
  const hit = traceHit(ray(0, 1.0, 0, 0, 0, -1), NO_BOXES, [e])!;
  assert.equal(hit.kind, 'entity');
  if (hit.kind !== 'entity') return;
  assert.equal(hit.entity, e);
  assert.ok(Math.abs(hit.dist - 9.65) < 1e-6, `dist ${hit.dist}`);
  assert.ok(Math.abs(hit.point.z + 9.65) < 1e-6);
});

test('a box between shooter and target occludes the entity', () => {
  const cover: Box = { x: 0, y: 0, z: -5, w: 2, h: 2, d: 2, kind: 'container' };
  const e = entAt(0, -10);
  const hit = traceHit(ray(0, 1.0, 0, 0, 0, -1), [cover], [e])!;
  assert.equal(hit.kind, 'box');
  if (hit.kind !== 'box') return;
  assert.equal(hit.box, cover);
  assert.ok(Math.abs(hit.dist - 4) < 1e-6, `dist ${hit.dist}`);
});

test('hits in the top 15% count as headshots (×2), lower hits do not', () => {
  const e = entAt(0, -10);
  const head = traceHit(ray(0, 1.6, 0, 0, 0, -1), NO_BOXES, [e])!;
  assert.equal(head.kind, 'entity');
  if (head.kind === 'entity') assert.equal(head.headshot, true);
  const torso = traceHit(ray(0, 1.3, 0, 0, 0, -1), NO_BOXES, [e])!;
  if (torso.kind === 'entity') assert.equal(torso.headshot, false);
  // boundary: exactly 0.85·h is NOT a headshot (zone is strictly above)
  const edge = traceHit(ray(0, 0.85 * 1.7, 0, 0, 0, -1), NO_BOXES, [e])!;
  if (edge.kind === 'entity') assert.equal(edge.headshot, false);
});

test('closer entity wins over one behind it', () => {
  const near = entAt(0, -8);
  const far = entAt(0, -12);
  const hit = traceHit(ray(0, 1.0, 0, 0, 0, -1), NO_BOXES, [far, near])!;
  assert.equal(hit.kind, 'entity');
  if (hit.kind === 'entity') assert.equal(hit.entity, near);
});

test('dead entities are ignored by traceHit', () => {
  const e = entAt(0, -10, { alive: false });
  assert.equal(traceHit(ray(0, 1.0, 0, 0, 0, -1), NO_BOXES, [e]), null);
});

test('damage falls off past 25m to a 0.6 floor', () => {
  const rifle = WEAPONS[0];
  const gatling = WEAPONS[1];
  assert.equal(falloffFactor(rifle, 20), 1);
  assert.equal(falloffFactor(rifle, 25), 1);
  const mid = falloffFactor(rifle, 37.5);
  assert.ok(Math.abs(mid - 0.8) < 1e-9, `mid ${mid}`);
  assert.equal(falloffFactor(rifle, 60), FALLOFF_FLOOR);
  assert.equal(falloffFactor(gatling, 60), FALLOFF_FLOOR);
});

test('applyDamage drains hp; lethal damage kills and starts the 3s timer', () => {
  const e = entAt(0, 0);
  assert.equal(applyDamage(e, 24, 0), false);
  assert.equal(e.hp, 76);
  assert.equal(applyDamage(e, 100, 1000), true);
  assert.equal(e.alive, false);
  assert.equal(e.hp, 0);
  assert.equal(e.deadUntil, 1000 + RESPAWN_MS);
  // further damage while dead is ignored
  assert.equal(applyDamage(e, 50, 1100), false);
  assert.equal(e.hp, 0);
});

test('respawn at deadUntil restores hp, teleports, grants 1.5s protection', () => {
  const e = entAt(0, 0);
  applyDamage(e, 200, 0);
  const spawn: Vec3 = { x: 5, y: 0, z: 7 };
  assert.equal(updateRespawn(e, RESPAWN_MS - 1, spawn), false);
  assert.equal(updateRespawn(e, RESPAWN_MS, spawn), true);
  assert.equal(e.alive, true);
  assert.equal(e.hp, e.maxHp);
  assert.deepEqual(e.pos, spawn);
  assert.equal(e.invincibleUntil, RESPAWN_MS + INVINCIBLE_MS);
  // spawn protection: damage inside the window is ignored
  assert.equal(applyDamage(e, 50, RESPAWN_MS + 100), false);
  assert.equal(e.hp, e.maxHp);
  // protection expired — a lethal hit lands normally
  assert.equal(applyDamage(e, 200, RESPAWN_MS + INVINCIBLE_MS), true);
});

test('headshot doubles the pellet damage end-to-end', () => {
  const e = entAt(0, -10);
  const hit = traceHit(ray(0, 1.6, 0, 0, 0, -1), NO_BOXES, [e])!;
  assert.equal(hit.kind, 'entity');
  if (hit.kind !== 'entity') return;
  const dmg = WEAPONS[0].dmg * falloffFactor(WEAPONS[0], hit.dist) * (hit.headshot ? HEADSHOT_MULT : 1);
  applyDamage(e, dmg, 0);
  assert.equal(e.hp, 100 - 48);
});

test('gatling rapid burst accumulates damage independently per round', () => {
  const e = entAt(0, -10);
  const shots: Ray[] = [
    ray(0, 1.0, 0, 0, 0, -1),
    ray(0, 1.0, 0, 0.02, 0, -1),
    ray(0, 1.6, 0, 0, 0, -1),
  ];
  let total = 0;
  for (const s of shots) {
    const h = traceHit(s, NO_BOXES, [e]);
    if (h?.kind === 'entity') {
      const dmg = WEAPONS[1].dmg * falloffFactor(WEAPONS[1], h.dist) * (h.headshot ? HEADSHOT_MULT : 1);
      applyDamage(e, dmg, 0);
      total += dmg;
    }
  }
  // 2 body hits (14+14) + 1 headshot (28) = 56
  assert.equal(total, 56);
  assert.equal(e.hp, 44);
});

test('player 200 max HP regenerates at 12 HP/s after 6s delay and returns to 200 within 10s of regen', () => {
  assert.equal(PLAYER_MAX_HP, 200);
  assert.equal(PLAYER_REGEN_DELAY_MS, 6000);
  assert.equal(PLAYER_REGEN_PER_SEC, 12);

  const p = createEntity('player', { x: 0, y: 0, z: 0 }, PLAYER_MAX_HP);
  assert.equal(p.hp, 200);

  // Hurt 100 at t=1000ms -> hp=100
  assert.equal(applyDamage(p, 100, 1000), false);
  assert.equal(p.hp, 100);
  let lastHurt = 1000;

  // For the first 5.95s, zero regeneration
  for (let t = 1100; t <= 6950; t += 50) {
    assert.equal(updatePlayerRegen(p, lastHurt, t, 0.05), false);
  }
  assert.equal(p.hp, 100);

  // Starting at t=7000ms (6s after hit), regens at 12 HP/s -> hits 200 in ~8.35s (<10s)
  let reachedFullAt = -1;
  for (let t = 7000; t <= 17000; t += 50) {
    updatePlayerRegen(p, lastHurt, t, 0.05);
    if (p.hp >= 200 && reachedFullAt < 0) reachedFullAt = t;
  }
  assert.equal(p.hp, 200);
  const regenDurationSec = (reachedFullAt - 7000) / 1000;
  assert.ok(regenDurationSec > 8.0 && regenDurationSec < 10.0, `regen duration ${regenDurationSec}s`);

  // Taking damage resets the 6s delay; lethal damage (hp<=0) never regenerates
  applyDamage(p, 50, 20000);
  lastHurt = 20000;
  assert.equal(updatePlayerRegen(p, lastHurt, 25000, 0.5), false);
  assert.equal(p.hp, 150);

  assert.equal(applyDamage(p, 150, 26000), true);
  assert.equal(p.alive, false);
  assert.equal(p.hp, 0);
  assert.equal(updatePlayerRegen(p, 26000, 40000, 1.0), false);
  assert.equal(p.hp, 0);
});
