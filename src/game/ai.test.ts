import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EnemyManager,
  PATROL_WAYPOINTS,
  COVER_SPOTS,
  ENEMY_SPAWNS,
  BOT_RADIUS,
  BOT_HEIGHT,
  BOT_RELOAD_MS,
  PATROL_SPEED,
  COVER_SPEED,
  FIRE_HIT_DELAY_MS,
  MIN_PLAYER_SPAWN_DIST,
  MIN_BOT_SEPARATION,
  ENGAGE_MAX_DIST,
  TEAM_INTEL_TTL_MS,
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
  assert.deepEqual([e.enemyDmg, e.hitRate, e.reactionMs, e.moveSpeed, e.totalEnemies, e.canTakeCover], [8, 0.25, 900, 2.4, 3, false]);
  assert.deepEqual([n.enemyDmg, n.hitRate, n.reactionMs, n.moveSpeed, n.totalEnemies, n.canTakeCover], [12, 0.40, 600, 3.0, 5, true]);
  assert.deepEqual([h.enemyDmg, h.hitRate, h.reactionMs, h.moveSpeed, h.totalEnemies, h.flankPairs], [16, 0.55, 350, 3.4, 7, true]);

  const mgr = new EnemyManager('hard', () => 0.4);
  mgr.reset(0, { x: -8, y: 0, z: 17 });
  assert.equal(mgr.bots.length, 5, 'HARD caps simultaneous live enemies at 5');
});

test('spawns never land within 15m of player spawn and bots stay >= 1.5m apart', () => {
  const playerSpawn = { x: -8, y: 0, z: 17 };
  const mgr = new EnemyManager('normal', () => 0.35);
  mgr.reset(0, playerSpawn);
  assert.equal(mgr.bots.length, 5);

  for (const b of mgr.bots) {
    const dp = Math.hypot(b.entity.pos.x - playerSpawn.x, b.entity.pos.z - playerSpawn.z);
    assert.ok(dp >= MIN_PLAYER_SPAWN_DIST, `bot spawned ${dp.toFixed(2)}m < 15m from player`);
  }
  for (let i = 0; i < mgr.bots.length; i++) {
    for (let j = i + 1; j < mgr.bots.length; j++) {
      const d = Math.hypot(
        mgr.bots[i].entity.pos.x - mgr.bots[j].entity.pos.x,
        mgr.bots[i].entity.pos.z - mgr.bots[j].entity.pos.z,
      );
      assert.ok(d >= MIN_BOT_SEPARATION - 1e-4, `bots ${i}&${j} too close: ${d.toFixed(2)}m`);
    }
  }

  // Even if two bots are manually placed 0.2m apart, pairwise separation pushes them >= 1.5m apart
  mgr.clear();
  const a = mgr.spawnManual(0, -10, 0, 'bl', 0);
  const b = mgr.spawnManual(0.2, -10, 0, 'gr', 0);
  for (let t = 50; t <= 300; t += 50) {
    mgr.update({
      dt: 0.05,
      nowMs: t,
      playerPos: playerSpawn,
      playerEye: { x: playerSpawn.x, y: 1.7, z: playerSpawn.z },
      playerAlive: false,
      playerFired: false,
      playerSpeed: 0,
      playerOnGround: true,
      boxes: MAP.boxes,
      collider: world,
    });
  }
  const sep = Math.hypot(a.entity.pos.x - b.entity.pos.x, a.entity.pos.z - b.entity.pos.z);
  assert.ok(sep >= MIN_BOT_SEPARATION - 0.02, `pairwise separation failed: ${sep.toFixed(3)}m`);
});

test('reaction delay & 0.18s fire_rifle hit trigger: EASY > 700ms; HARD < 500ms', () => {
  const runFirstFireDelay = (diff: 'easy' | 'hard'): { delay: number; hitOffset: number } => {
    const mgr = new EnemyManager(diff, () => 0.1);
    const playerPos = { x: 0, y: 0, z: 0 };
    const playerEye = { x: 0, y: 1.7, z: 0 };
    const bot = mgr.spawnManual(0, -10, yawFromDir(0, 10), 'bl', 0);
    for (let t = 20; t <= 2000; t += 20) {
      const shots = mgr.update({
        dt: 0.02,
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
        return {
          delay: bot.firstShotAt - bot.firstSightAt,
          hitOffset: t - bot.fireAnimStartAt,
        };
      }
    }
    return { delay: -1, hitOffset: -1 };
  };

  const easy = runFirstFireDelay('easy');
  const hard = runFirstFireDelay('hard');
  assert.ok(easy.delay >= 850 && easy.delay <= 1100, `EASY delay ${easy.delay}ms expected ~900ms`);
  assert.ok(hard.delay >= 300 && hard.delay <= 450, `HARD delay ${hard.delay}ms expected ~350ms`);
  assert.ok(easy.hitOffset >= FIRE_HIT_DELAY_MS && easy.hitOffset <= FIRE_HIT_DELAY_MS + 40, `hit offset ${easy.hitOffset}ms expected ~180ms`);
  assert.ok(hard.hitOffset >= FIRE_HIT_DELAY_MS && hard.hitOffset <= FIRE_HIT_DELAY_MS + 40, `hit offset ${hard.hitOffset}ms expected ~180ms`);
});

test('strict glTF clip state machine: IDLE->idle_rifle, PATROL->walk_rifle (1.4m/s), ENGAGE->aim_rifle/fire_rifle, RELOAD->reload_rifle (2.2s), COVER->crouch_rifle (1.2m/s)', () => {
  const mgr = new EnemyManager('normal', () => 0.2);
  const bot = mgr.spawnManual(0, -15.5, 0, 'bl', 0); // facing -Z (away from player at +17)
  assert.equal(bot.state, 'IDLE');
  assert.equal(bot.anim, 'idle_rifle');

  // After idle pause -> PATROL with walk_rifle at ~1.4 m/s
  let sawPatrol = false;
  for (let t = 50; t <= 2200; t += 50) {
    mgr.update({
      dt: 0.05,
      nowMs: t,
      playerPos: { x: 0, y: 0, z: 17 },
      playerEye: { x: 0, y: 1.7, z: 17 },
      playerAlive: false,
      playerFired: false,
      playerSpeed: 0,
      playerOnGround: true,
      boxes: MAP.boxes,
      collider: world,
    });
    if ((bot.state as string) === 'PATROL' && bot.speed > 0.5) {
      sawPatrol = true;
      assert.equal(bot.anim, 'walk_rifle');
      assert.ok(Math.abs(bot.speed - PATROL_SPEED) < 0.2, `patrol speed ${bot.speed} != ${PATROL_SPEED}`);
      break;
    }
  }
  assert.equal(sawPatrol, true, 'bot never entered PATROL');

  // Empty ammo in ENGAGE -> RELOAD (reload_rifle, 2.2s, 0 shots during reload)
  mgr.clear();
  const rbot = mgr.spawnManual(0, -10, yawFromDir(0, 10), 'gr', 0);
  rbot.ammo = 1;
  let sawFireClip = false;
  let sawReloadClip = false;
  let shotsDuringReload = 0;
  for (let t = 20; t <= 3600; t += 20) {
    const wasReloading = rbot.state === 'RELOAD';
    const shots = mgr.update({
      dt: 0.02,
      nowMs: t,
      playerPos: { x: 0, y: 0, z: 0 },
      playerEye: { x: 0, y: 1.7, z: 0 },
      playerAlive: true,
      playerFired: false,
      playerSpeed: 0,
      playerOnGround: true,
      boxes: MAP.boxes,
      collider: world,
    });
    if (rbot.anim === 'fire_rifle') sawFireClip = true;
    if (rbot.state === 'RELOAD') {
      sawReloadClip = true;
      assert.equal(rbot.anim, 'reload_rifle');
    }
    if (wasReloading) shotsDuringReload += shots.length;
  }
  assert.equal(sawFireClip, true, 'never played fire_rifle in ENGAGE');
  assert.equal(sawReloadClip, true, 'never entered RELOAD when ammo hit 0');
  assert.equal(shotsDuringReload, 0, 'bot fired during RELOAD!');
  assert.equal(BOT_RELOAD_MS, 2200);
  assert.equal(COVER_SPEED, 1.2);
});

test('enemies NEVER shoot through walls: 3s behind container consumes 0 ammo', () => {
  const mgr = new EnemyManager('hard', () => 0.1);
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
    bot.entity.pos.x = -6;
    bot.entity.pos.z = -7.2;
    const shots = mgr.update({
      dt: 0.05,
      nowMs: t,
      playerPos,
      playerEye,
      playerAlive: true,
      playerFired: true,
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

test('wounded bot (<30% HP) enters COVER (crouch_rifle) on NORMAL, stays aggressive on EASY', () => {
  const mgrNorm = new EnemyManager('normal', () => 0.3);
  const bNorm = mgrNorm.spawnManual(0, -10, yawFromDir(0, 10), 'bl', 0);
  applyDamage(bNorm.entity, 75, 100);
  mgrNorm.onBotDamaged(bNorm.entity, { x: 0, y: 0, z: 0 }, 100);
  assert.equal(bNorm.state, 'COVER');

  const mgrEasy = new EnemyManager('easy', () => 0.3);
  const bEasy = mgrEasy.spawnManual(0, -10, yawFromDir(0, 10), 'gr', 0);
  applyDamage(bEasy.entity, 75, 100);
  mgrEasy.onBotDamaged(bEasy.entity, { x: 0, y: 0, z: 0 }, 100);
  assert.notEqual(bEasy.state, 'COVER');
});

test('killed bot collapses to DEAD (die) and replenishes a replacement after respawnDelayMs', () => {
  const mgr = new EnemyManager('hard', () => 0.5);
  mgr.reset(0, { x: -8, y: 0, z: 17 });
  const victim = mgr.bots[0];
  const oldId = victim.id;
  applyDamage(victim.entity, 200, 100);
  mgr.onBotDamaged(victim.entity, { x: -8, y: 0, z: 17 }, 100);
  assert.equal(victim.state, 'DEAD');
  assert.equal(victim.anim, 'die');

  mgr.update({
    dt: 0.05,
    nowMs: 100 + mgr.difficulty.respawnDelayMs + 50,
    playerPos: { x: -8, y: 0, z: 17 },
    playerEye: { x: -8, y: 1.7, z: 17 },
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

/** Deterministic LCG PRNG for reproducible AI simulations (no Math.random / wall-clock). */
function makeRng(seed = 1337): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

test('difficulty advance thresholds match EASY 18s / NORMAL 14s / HARD 10s', () => {
  assert.equal(getDifficultySpec('easy').advanceAfterMs, 18000);
  assert.equal(getDifficultySpec('normal').advanceAfterMs, 14000);
  assert.equal(getDifficultySpec('hard').advanceAfterMs, 10000);
});

test('stationary player >30m with no LOS: bot advances to <25m within 20s and acquires LOS + fires within 45s', () => {
  const playerPos = { x: -8, y: 0, z: 17 };
  const playerEye = { x: playerPos.x, y: 1.7, z: playerPos.z };
  const mgr = new EnemyManager('normal', makeRng(42));
  mgr.reset(0, playerPos);

  // Place all 5 bots cleanly at >30m north-deck spawns with zero initial LOS
  mgr.clear();
  const starts: readonly [number, number][] = [
    [-14, -15.5],
    [-4, -15.5],
    [6, -15.5],
    [16, -15.5],
    [0, -15.5],
  ];
  for (let i = 0; i < starts.length; i++) {
    const [sx, sz] = starts[i];
    const b = mgr.spawnManual(sx, sz, 0, i % 2 === 0 ? 'bl' : 'gr', 0);
    const d0 = Math.hypot(sx - playerPos.x, sz - playerPos.z);
    assert.ok(d0 > 30, `initial bot ${i} dist ${d0.toFixed(2)}m must be >30m`);
    assert.equal(
      hasLineOfSight({ x: sx, y: 1.56, z: sz }, playerEye, MAP.boxes),
      false,
      `initial bot ${i} must have no LOS`,
    );
    assert.equal(b.lastContactAt, 0);
    assert.equal(b.advancing, false);
  }

  let playerHp = 200;
  let minDistWithin20s = Infinity;
  let sawAdvanceAtMoveSpeed = false;
  let advancingBotIdWithin20s: string | null = null;
  let firstLosAtMs = -1;
  let firstFireAtMs = -1;
  let fireBotIds = new Set<string>();

  for (let t = 50; t <= 45000; t += 50) {
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
    for (const s of shots) {
      if (firstFireAtMs < 0) firstFireAtMs = t;
      fireBotIds.add(s.botId);
      if (s.hit) playerHp -= s.damage;
    }
    for (const b of mgr.bots) {
      if (!b.entity.alive) continue;
      const d = Math.hypot(b.entity.pos.x - playerPos.x, b.entity.pos.z - playerPos.z);
      if (b.advancing && b.speed >= mgr.difficulty.moveSpeed - 0.35) {
        sawAdvanceAtMoveSpeed = true;
      }
      if (t <= 20000 && d < minDistWithin20s) {
        minDistWithin20s = d;
        if (d < 25) advancingBotIdWithin20s = b.id;
      }
      if (b.hasLos && firstLosAtMs < 0) firstLosAtMs = t;
    }
  }

  assert.equal(sawAdvanceAtMoveSpeed, true, 'advancing bot must move at diff.moveSpeed (not 1.4)');
  assert.ok(
    minDistWithin20s < 25,
    `expected at least 1 bot <25m within 20s, got minDist=${minDistWithin20s.toFixed(2)}m`,
  );
  assert.ok(advancingBotIdWithin20s !== null, 'no bot closed below 25m within 20s');
  assert.ok(firstLosAtMs > 0 && firstLosAtMs <= 45000, `no bot acquired LOS within 45s (got ${firstLosAtMs}ms)`);
  assert.ok(
    firstFireAtMs > 0 && firstFireAtMs <= 45000,
    `no bot fired within 45s (got ${firstFireAtMs}ms)`,
  );
  assert.ok(
    mgr.totalShotsFired > 0 || playerHp < 200,
    `expected shotsFired>0 or playerHp<200 (shots=${mgr.totalShotsFired}, hp=${playerHp})`,
  );
  // Confirm the bot that closed in within 20s also acquired LOS & fired
  const closer = mgr.bots.find((b) => b.id === advancingBotIdWithin20s);
  assert.ok(
    closer && (closer.firstSightAt > 0 || fireBotIds.has(closer.id)),
    'closing bot should acquire LOS / engage',
  );
});

test('advancing bot with clearLos within ENGAGE_MAX_DIST+8 enters ENGAGE directly', () => {
  const mgr = new EnemyManager('hard', makeRng(7));
  // Player at (0, 17); bot at (0, -3) -> dist = 20m (> ENGAGE_MAX_DIST 16m, <= 24m), clear center corridor
  const playerPos = { x: 0, y: 0, z: 17 };
  const playerEye = { x: 0, y: 1.7, z: 17 };
  const bot = mgr.spawnManual(0, -3, 0, 'bl', 0); // facing -Z (away from player), no initial vision cone
  assert.equal(hasLineOfSight({ x: 0, y: 1.56, z: -3 }, playerEye, MAP.boxes), true);

  // Force advancing past HARD 10000ms threshold at t=10100ms
  bot.advancing = true;
  bot.state = 'PATROL';
  mgr.update({
    dt: 0.05,
    nowMs: 10100,
    playerPos,
    playerEye,
    playerAlive: true,
    playerFired: false,
    playerSpeed: 0,
    playerOnGround: true,
    boxes: MAP.boxes,
    collider: world,
  });

  const dist = Math.hypot(bot.entity.pos.x - playerPos.x, bot.entity.pos.z - playerPos.z);
  assert.ok(dist > ENGAGE_MAX_DIST && dist <= ENGAGE_MAX_DIST + 8, `expected 16<dist<=24, got ${dist.toFixed(2)}`);
  assert.equal(bot.advancing, false, 'advancing must clear upon acquiring LOS');
  assert.equal(bot.hasLos, true, 'advancing bot with clearLos <= ENGAGE_MAX_DIST+8 must acquire LOS');
  assert.equal(bot.state, 'ENGAGE', 'advancing bot with clearLos <= 24m must enter ENGAGE directly');
});

test('teammate callout shares LOS position for 3000ms and redirects advancing teammate', () => {
  const mgr = new EnemyManager('normal', makeRng(99));
  mgr.clear();

  // Spotter on east lane (14, 7.5) facing due south (+Z) sees (14, 15.5) but not west spawn (-8, 17)
  const playerSpawn = { x: -8, y: 0, z: 17 };
  const spottedPos = { x: 14, y: 0, z: 15.5 };
  const spottedEye = { x: 14, y: 1.7, z: 15.5 };
  const spotter = mgr.spawnManual(14, 7.5, yawFromDir(0, 1), 'bl', 0);
  const mate = mgr.spawnManual(6, -15.5, 0, 'gr', 0);

  // Tick 1 with player at west spawn (-8, 17) — neither bot has LOS; locks playerSpawnOrigin = (-8, 17)
  mgr.update({
    dt: 0.02,
    nowMs: 20,
    playerPos: playerSpawn,
    playerEye: { x: playerSpawn.x, y: 1.7, z: playerSpawn.z },
    playerAlive: true,
    playerFired: false,
    playerSpeed: 0,
    playerOnGround: true,
    boxes: MAP.boxes,
    collider: world,
  });
  assert.equal(spotter.hasLos, false);
  assert.equal(mate.hasLos, false);

  // Now player is on the east side (14, 15.5) where spotter has LOS -> writes 3000ms squad intel
  mgr.update({
    dt: 0.05,
    nowMs: 70,
    playerPos: spottedPos,
    playerEye: spottedEye,
    playerAlive: true,
    playerFired: false,
    playerSpeed: 0,
    playerOnGround: true,
    boxes: MAP.boxes,
    collider: world,
  });

  assert.equal(spotter.hasLos, true, 'spotter should have LOS to player');
  assert.equal(mate.hasLos, false, 'teammate at north deck should not have LOS');
  const intel = mgr.getTeamIntel(70);
  assert.ok(intel !== null, 'team intel must be written when any bot gains LOS');
  assert.equal(intel.pos.x, spottedPos.x);
  assert.equal(intel.pos.z, spottedPos.z);
  assert.equal(mate.advancing, true, 'teammate must advance toward shared callout intel');

  // Mate must advance EAST toward callout (14,15.5) rather than WEST toward playerSpawnOrigin (-8,17)
  const startX = mate.entity.pos.x;
  for (let t = 120; t <= 1520; t += 50) {
    mgr.update({
      dt: 0.05,
      nowMs: t,
      playerPos: spottedPos,
      playerEye: spottedEye,
      playerAlive: true,
      playerFired: false,
      playerSpeed: 0,
      playerOnGround: true,
      boxes: MAP.boxes,
      collider: world,
    });
  }
  assert.ok(
    mate.entity.pos.x > startX + 2,
    `mate should advance east toward callout (14,15.5), x moved ${startX.toFixed(2)} -> ${mate.entity.pos.x.toFixed(2)}`,
  );

  // Kill spotter so no one refreshes intel; after > TEAM_INTEL_TTL_MS (3000ms), intel expires
  applyDamage(spotter.entity, 200, 1570);
  mgr.onBotDamaged(spotter.entity, spottedPos, 1570);
  assert.ok(mgr.getTeamIntel(1520 + TEAM_INTEL_TTL_MS) !== null, 'intel still valid at exact 3000ms');
  assert.equal(mgr.getTeamIntel(1520 + TEAM_INTEL_TTL_MS + 1), null, 'intel must expire after 3000ms');
});

test('after player dies, bots exit advancing and return to PATROL', () => {
  const playerPos = { x: -8, y: 0, z: 17 };
  const playerEye = { x: -8, y: 1.7, z: 17 };
  const mgr = new EnemyManager('hard', makeRng(21));
  mgr.clear();
  const bot = mgr.spawnManual(-14, -15.5, 0, 'bl', 0);

  // Advance past HARD 10000ms threshold so bot enters advancing
  for (let t = 50; t <= 11500; t += 50) {
    mgr.update({
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
  }
  assert.equal(bot.advancing, true, 'bot should be advancing after 10s without contact on HARD');

  // Player dies -> bot must NOT stay in advancing and must return to PATROL
  mgr.update({
    dt: 0.05,
    nowMs: 11550,
    playerPos,
    playerEye,
    playerAlive: false,
    playerFired: false,
    playerSpeed: 0,
    playerOnGround: true,
    boxes: MAP.boxes,
    collider: world,
  });
  assert.equal(bot.advancing, false, 'bot must exit advancing when player dies');
  assert.equal(bot.state, 'PATROL', 'bot must return to PATROL when player dies');

  // Even after 15s more with dead player, bot never re-enters advancing
  for (let t = 11600; t <= 26600; t += 100) {
    mgr.update({
      dt: 0.1,
      nowMs: t,
      playerPos,
      playerEye,
      playerAlive: false,
      playerFired: false,
      playerSpeed: 0,
      playerOnGround: true,
      boxes: MAP.boxes,
      collider: world,
    });
    assert.equal(bot.advancing, false, `bot re-entered advancing while player dead at t=${t}`);
  }
});
