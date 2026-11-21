import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EnemyManager,
  PATROL_WAYPOINTS,
  COVER_SPOTS,
  ENEMY_SPAWNS,
  BOT_RADIUS,
  BOT_HEIGHT,
  hasLineOfSight,
  yawFromDir,
} from './ai.ts';
import { MAP } from './map.ts';
import { CollisionWorld } from './collision.ts';
import { applyDamage } from './damage.ts';
import { getDifficultySpec } from './difficulty.ts';

const world = new CollisionWorld(MAP.boxes, MAP.bounds, MAP.waterY, MAP.walkablePolygon);

test('all patrol waypoints, cover spots, and enemy spawns lie cleanly inside deck & outside boxes', () => {
  for (const [label, pts] of [
    ['waypoint', PATROL_WAYPOINTS],
    ['cover', COVER_SPOTS],
    ['spawn', ENEMY_SPAWNS],
  ] as const) {
    for (const p of pts) {
      assert.equal(
        world.isInsideWalkable(p.x, p.z, BOT_RADIUS),
        true,
        `${label} (${p.x},${p.z}) outside walkable polygon`,
      );
      assert.equal(
        world.hits(p.x, 0, p.z, BOT_RADIUS, BOT_HEIGHT),
        false,
        `${label} (${p.x},${p.z}) overlaps a map box`,
      );
    }
  }
});

test('difficulty specs match EASY / NORMAL / HARD table and cap simultaneous enemies <= 5', () => {
  const e = getDifficultySpec('easy');
  const n = getDifficultySpec('normal');
  const h = getDifficultySpec('hard');
  assert.deepEqual([e.enemyDmg, e.hitRate, e.reactionMs, e.moveSpeed, e.totalEnemies, e.canTakeCover], [8, 0.25, 900, 2.0, 3, false]);
  assert.deepEqual([n.enemyDmg, n.hitRate, n.reactionMs, n.moveSpeed, n.totalEnemies, n.canTakeCover], [12, 0.40, 600, 2.6, 5, true]);
  assert.deepEqual([h.enemyDmg, h.hitRate, h.reactionMs, h.moveSpeed, h.totalEnemies, h.flankPairs], [16, 0.55, 350, 3.1, 7, true]);

  const mgr = new EnemyManager('hard', () => 0.4);
  mgr.reset(0, { x: 0, y: 0, z: 17 });
  assert.equal(mgr.bots.length, 5, 'HARD caps simultaneous live enemies at 5');
});

test('reaction delay: EASY first shot > 700ms (900ms); HARD first shot < 500ms (350ms)', () => {
  const runFirstFireDelay = (diff: 'easy' | 'hard'): number => {
    const mgr = new EnemyManager(diff, () => 0.1);
    const playerPos = { x: 0, y: 0, z: 0 };
    const playerEye = { x: 0, y: 1.7, z: 0 };
    // Place enemy 10m directly north facing south (+Z) toward player in open center
    const bot = mgr.spawnManual(0, -10, yawFromDir(0, 10), 'bl', 0);
    for (let t = 50; t <= 2000; t += 50) {
      const shots = mgr.update({
        dt: 0.05,
        nowMs: t,
        playerPos,
        playerEye,
        playerAlive: true,
        playerFired: false,
        playerSpeed: 0,
        playerOnGround: true,
        boxes: MAP.boxes,
        collider: world,
      });
      if (shots.length > 0) {
        return bot.firstShotAt - bot.firstSightAt;
      }
    }
    return -1;
  };

  const easyDelay = runFirstFireDelay('easy');
  const hardDelay = runFirstFireDelay('hard');
  assert.ok(easyDelay >= 850 && easyDelay <= 1100, `EASY delay ${easyDelay}ms expected ~900ms (>700ms)`);
  assert.ok(hardDelay >= 300 && hardDelay <= 450, `HARD delay ${hardDelay}ms expected ~350ms (<500ms)`);
});

test('enemies NEVER shoot through walls: 3s behind container consumes 0 ammo', () => {
  const mgr = new EnemyManager('hard', () => 0.1);
  // Container sits at (-6, 0, -4) w=6, h=2.6, d=2.5 (z in [-5.25, -2.75])
  // Bot north at (-6, -7.2) facing south (+Z); player south at (-6, -0.8) -> fully occluded!
  const bot = mgr.spawnManual(-6, -7.2, yawFromDir(0, 6.4), 'gr', 0);
  const playerPos = { x: -6, y: 0, z: -0.8 };
  const playerEye = { x: -6, y: 1.7, z: -0.8 };

  assert.equal(
    hasLineOfSight({ x: -6, y: 1.56, z: -7.2 }, playerEye, MAP.boxes),
    false,
    'test setup should be occluded by container',
  );

  let totalShots = 0;
  for (let t = 50; t <= 3000; t += 50) {
    // Keep bot pinned behind the container (simulating continuous occlusion)
    bot.entity.pos.x = -6;
    bot.entity.pos.z = -7.2;
    const shots = mgr.update({
      dt: 0.05,
      nowMs: t,
      playerPos,
      playerEye,
      playerAlive: true,
      playerFired: true, // even when alerted by gunfire!
      playerSpeed: 0,
      playerOnGround: true,
      boxes: MAP.boxes,
      collider: world,
    });
    totalShots += shots.length;
  }
  assert.equal(totalShots, 0, 'occluded bot fired through cover!');
  assert.equal(bot.ammo, bot.mag, 'occluded bot consumed ammo');
});

test('wounded bot (<30% HP) enters COVER on NORMAL, stays aggressive on EASY', () => {
  const mgrNorm = new EnemyManager('normal', () => 0.3);
  const bNorm = mgrNorm.spawnManual(0, -10, yawFromDir(0, 10), 'bl', 0);
  applyDamage(bNorm.entity, 75, 100); // 25 HP < 30%
  mgrNorm.onBotDamaged(bNorm.entity, { x: 0, y: 0, z: 0 }, 100);
  assert.equal(bNorm.state, 'COVER');

  const mgrEasy = new EnemyManager('easy', () => 0.3);
  const bEasy = mgrEasy.spawnManual(0, -10, yawFromDir(0, 10), 'gr', 0);
  applyDamage(bEasy.entity, 75, 100);
  mgrEasy.onBotDamaged(bEasy.entity, { x: 0, y: 0, z: 0 }, 100);
  assert.notEqual(bEasy.state, 'COVER');
});

test('killed bot collapses to DEAD and replenishes a replacement after respawnDelayMs', () => {
  const mgr = new EnemyManager('hard', () => 0.5);
  mgr.reset(0, { x: 0, y: 0, z: 17 });
  const victim = mgr.bots[0];
  const oldId = victim.id;
  applyDamage(victim.entity, 200, 100);
  mgr.onBotDamaged(victim.entity, { x: 0, y: 0, z: 17 }, 100);
  assert.equal(victim.state, 'DEAD');
  assert.equal(victim.anim, 'dead');

  // After HARD respawnDelayMs (1800ms), replacement spawns into slot 0
  mgr.update({
    dt: 0.05,
    nowMs: 100 + mgr.difficulty.respawnDelayMs + 50,
    playerPos: { x: 0, y: 0, z: 17 },
    playerEye: { x: 0, y: 1.7, z: 17 },
    playerAlive: true,
    playerFired: false,
    playerSpeed: 0,
    playerOnGround: true,
    boxes: MAP.boxes,
    collider: world,
  });
  assert.notEqual(mgr.bots[0].id, oldId);
  assert.equal(mgr.bots[0].entity.alive, true);
  assert.equal(mgr.bots.length, 5);
});
