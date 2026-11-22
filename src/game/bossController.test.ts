import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ARTILLERY_CONFIG } from './artillery.ts';
import {
  BossController,
  BOSS_HIT_RECOIL_DIST,
  BOSS_SPAWN_MAX_DIST,
  BOSS_SPAWN_MIN_DIST,
  BOSS_TARGET_HEIGHT,
  classifyBossHitPart,
  raycastBoss,
  selectBossSpawn,
} from './bossController.ts';
import { CollisionWorld } from './collision.ts';
import { MAP, spawnPoint } from './map.ts';

test('selectBossSpawn picks a walkable, box-free point 20-25m from player spawn', () => {
  const [px, , pz] = spawnPoint('A', 0);
  const pos = selectBossSpawn({ x: px, z: pz });
  const dist = Math.hypot(pos.x - px, pos.z - pz);
  assert.ok(
    dist >= BOSS_SPAWN_MIN_DIST && dist <= BOSS_SPAWN_MAX_DIST,
    `expected spawn distance in [${BOSS_SPAWN_MIN_DIST}, ${BOSS_SPAWN_MAX_DIST}], got ${dist.toFixed(2)}m`,
  );

  const world = new CollisionWorld(MAP.boxes, MAP.bounds, MAP.waterY, MAP.walkablePolygon);
  assert.equal(world.isInsideWalkable(pos.x, pos.z, 0.8), true, 'boss spawn must lie inside walkable deck');
  assert.equal(world.hits(pos.x, pos.y, pos.z, 0.8, BOSS_TARGET_HEIGHT), false, 'boss spawn must not overlap boxes');
});

test('BossController mounts procedural Mech Boss model at 4.0-4.2m height with feet flush at y=0', () => {
  const scene = new THREE.Scene();
  const boss = new BossController(scene);
  assert.equal(scene.children.includes(boss.mesh), true);

  boss.mesh.updateMatrixWorld(true);
  const modelRoot = boss.mesh.getObjectByName('boss-terminator-model')!;
  assert.ok(modelRoot, 'procedural mech boss model should exist in mesh');
  assert.equal(boss.mesh.getObjectByName('boss-placeholder-robot'), undefined, 'placeholder robot must be removed');
  assert.equal(boss.mesh.getObjectByName('robot-weapon'), undefined);
  assert.ok(boss.triangleCount > 3000 && boss.triangleCount <= 20000, `expected tris <= 20000, got ${boss.triangleCount}`);

  const box = new THREE.Box3().setFromObject(modelRoot);
  const measuredHeight = box.max.y - box.min.y;
  assert.ok(
    measuredHeight >= 4.0 && measuredHeight <= 4.2,
    `expected Boss height in [4.0, 4.2]m, got ${measuredHeight.toFixed(3)}m`,
  );
  assert.ok(
    Math.abs(boss.height - measuredHeight) < 0.02,
    `expected boss.height (${boss.height}) to match measured model height (${measuredHeight.toFixed(3)})`,
  );
  assert.ok(Math.abs(box.min.y) < 0.05, `Boss feet should sit flush on deck y=0, got ${box.min.y.toFixed(3)}`);

  boss.dispose();
  assert.equal(scene.children.includes(boss.mesh), false);
});

test('raycastBoss + classifyBossHitPart distinguish head (>0.82H), core (chest/back +-0.5m), and body', () => {
  const bossPos = { x: 0, y: 0, z: -10 };
  const bossYaw = Math.PI; // facing +Z toward shooter at (0, *, 0)

  const headHit = raycastBoss(
    { origin: { x: 0, y: 3.65, z: 0 }, dir: { x: 0, y: 0, z: -1 } },
    bossPos,
    bossYaw,
    true,
  );
  assert.ok(headHit, 'head ray should hit');
  assert.equal(headHit.part, 'head');

  const coreHit = raycastBoss(
    { origin: { x: 0, y: 2.72, z: 0 }, dir: { x: 0, y: 0, z: -1 } },
    bossPos,
    bossYaw,
    true,
  );
  assert.ok(coreHit, 'chest core ray should hit');
  assert.equal(coreHit.part, 'core');

  const backCoreHit = raycastBoss(
    { origin: { x: 0, y: 2.72, z: -20 }, dir: { x: 0, y: 0, z: 1 } },
    bossPos,
    bossYaw,
    true,
  );
  assert.ok(backCoreHit, 'back core ray should hit');
  assert.equal(backCoreHit.part, 'core');

  const bodyHit = raycastBoss(
    { origin: { x: 0, y: 1.2, z: 0 }, dir: { x: 0, y: 0, z: -1 } },
    bossPos,
    bossYaw,
    true,
  );
  assert.ok(bodyHit, 'body ray should hit');
  assert.equal(bodyHit.part, 'body');

  assert.equal(
    raycastBoss({ origin: { x: 0, y: 2.72, z: 0 }, dir: { x: 0, y: 0, z: -1 } }, bossPos, bossYaw, false),
    null,
  );

  assert.equal(classifyBossHitPart({ x: 0, y: 3.30, z: -9.5 }, bossPos, bossYaw), 'head');
  assert.equal(classifyBossHitPart({ x: 0.65, y: 2.72, z: -10 }, bossPos, bossYaw), 'body');
});

test('BossController applies weakpoint damage, triggers 0.15s / 0.08m hit recoil, phase2, and death', () => {
  const scene = new THREE.Scene();
  const phases: number[] = [];
  let defeatedCount = 0;
  const boss = new BossController(scene, {
    hpMax: 1000,
    spawnPos: { x: 0, y: 0, z: -10 },
    playerPos: { x: 0, z: 0 },
    onPhaseChange: (p) => phases.push(p),
    onDefeated: () => defeatedCount++,
  });

  const r1 = boss.applyDamage(100, 'body');
  assert.equal(r1.dealt, 100);
  assert.equal(r1.dead, false);
  assert.equal(boss.hp, 900);
  assert.equal(boss.phase, 1);

  boss.updateVisualOnly(75, { x: 0, z: 0 });
  assert.ok(
    Math.abs(boss.hitRecoilOffset - BOSS_HIT_RECOIL_DIST) < 0.005,
    `expected recoil near ${BOSS_HIT_RECOIL_DIST}m at 75ms, got ${boss.hitRecoilOffset}`,
  );
  boss.updateVisualOnly(80, { x: 0, z: 0 });
  assert.equal(boss.hitRecoilOffset, 0, 'recoil must return to 0 after 150ms');

  const r2 = boss.applyDamage(100, 'core');
  assert.equal(r2.dealt, 200);
  assert.equal(boss.hp, 700);
  assert.equal(boss.phase, 2);
  assert.deepEqual(phases, [2]);

  const r3 = boss.applyDamage(300, 'head');
  assert.equal(r3.dealt, 750);
  assert.equal(r3.dead, true);
  assert.equal(boss.hp, 0);
  assert.equal(boss.alive, false);
  assert.equal(defeatedCount, 1);

  const r4 = boss.applyDamage(100, 'head');
  assert.equal(r4.dealt, 0);
  assert.equal(r4.dead, false);

  boss.dispose();
});

test('BossController stays stationary (<0.05m over 30s), deals 0 melee hits, and fires dodgeable parabolic artillery', () => {
  const scene = new THREE.Scene();
  const hits: { damage: number; dist: number }[] = [];
  const player = { x: -8, y: 0, z: 17 };
  const boss = new BossController(scene, {
    playerPos: player,
    onArtilleryHit: (info) => hits.push({ damage: info.damage, dist: info.dist }),
  });

  const initPos = { ...boss.pos };
  const startDist = Math.hypot(initPos.x - player.x, initPos.z - player.z);
  assert.ok(startDist >= 20 && startDist <= 25, `start dist ${startDist}`);

  let maxTris = 0;
  let sawProjectileInScene = false;
  // Simulate 30 seconds (1500 steps × 20ms) with stationary player at spawn -> should take artillery hits
  for (let i = 0; i < 1500; i++) {
    boss.update(20, player);
    const disp = Math.hypot(boss.pos.x - initPos.x, boss.pos.z - initPos.z);
    assert.ok(disp < 0.05, `Boss moved ${disp.toFixed(4)}m at step ${i}`);
    if (boss.artillery.activeProjectileCount > 0) sawProjectileInScene = true;
    const tris = boss.artilleryTriangleCount;
    if (tris > maxTris) maxTris = tris;
  }

  assert.equal(boss.meleeHitsDealt, 0, 'stationary artillery boss must deal 0 melee hits');
  assert.equal(sawProjectileInScene, true, 'must spawn active projectile entities');
  assert.ok(boss.artillery.totalShotsFired >= 8, `expected >=8 shots in 30s, got ${boss.artillery.totalShotsFired}`);
  assert.ok(hits.length >= 6, `stationary player should take >=6 artillery hits in 30s, got ${hits.length}`);
  assert.equal(hits[0].damage, ARTILLERY_CONFIG.damage);
  assert.ok(maxTris <= ARTILLERY_CONFIG.maxTriangleBudget, `artillery tris ${maxTris} exceeded ${ARTILLERY_CONFIG.maxTriangleBudget}`);

  // Enraged phase (hpPct <= 35%): verify 3-shell salvo stays within <=1500 tri budget & zero movement
  boss.applyDamage(1400, 'body'); // 600/2000 = 30% -> enraged
  const enragedHitsBefore = hits.length;
  for (let i = 0; i < 400; i++) {
    // Player keeps strafing far out of blast zones after launch -> dodges!
    const active = boss.artillery.telemetry.activeTelegraphs;
    const dodgePos = active.length > 0
      ? { x: active[0].target.x + 6.0, y: 0, z: active[0].target.z + 6.0 }
      : { x: 0, y: 0, z: 12 };
    boss.update(20, dodgePos);
    const disp = Math.hypot(boss.pos.x - initPos.x, boss.pos.z - initPos.z);
    assert.ok(disp < 0.05, `Enraged Boss moved ${disp.toFixed(4)}m`);
    assert.ok(
      boss.artilleryTriangleCount <= ARTILLERY_CONFIG.maxTriangleBudget,
      `Enraged artillery tris ${boss.artilleryTriangleCount} > ${ARTILLERY_CONFIG.maxTriangleBudget}`,
    );
  }
  assert.equal(hits.length, enragedHitsBefore, 'player dodging outside blastRadius must take 0 hits');

  boss.dispose();
});
