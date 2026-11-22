import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import {
  ARTILLERY_CONFIG,
  ArtillerySystem,
  computeFlightTimeSec,
  isTelegraphDodgeable,
  planSalvoTargets,
  sampleBallisticPos,
  solveBallisticArc,
} from './artillery.ts';

test('dodgeability inequality: warningSec * 5.2 > blastRadius * 1.6 across all distances & enraged phase', () => {
  assert.equal(
    isTelegraphDodgeable(ARTILLERY_CONFIG.minTelegraphSec, ARTILLERY_CONFIG.blastRadius),
    true,
    'minTelegraphSec must satisfy 预警时长 * 5.2 > 标识半径 * 1.6',
  );

  for (const enraged of [false, true]) {
    for (const dist of [1, 5, 10, 18, 22, 30, 45]) {
      const t = computeFlightTimeSec(dist, enraged, ARTILLERY_CONFIG.blastRadius);
      assert.ok(
        t * 5.2 > ARTILLERY_CONFIG.blastRadius * 1.6,
        `dist=${dist} enraged=${enraged}: ${t} * 5.2 <= ${ARTILLERY_CONFIG.blastRadius * 1.6}`,
      );
      assert.ok(t >= ARTILLERY_CONFIG.minTelegraphSec);
    }
  }
});

test('parabolic trajectory: y rises then falls, x/z move at constant velocity, impact hits target within <0.01m', () => {
  const origin = { x: -10, y: 3.55, z: -6 };
  const target = { x: 8, y: 0, z: 14 };
  const flightTime = computeFlightTimeSec(Math.hypot(target.x - origin.x, target.z - origin.z), false);
  const sol = solveBallisticArc(origin, target, flightTime);

  assert.ok(sol.elevationRad > 0.25 && sol.elevationRad < Math.PI * 0.49, `unexpected elevation ${sol.elevationRad}`);
  assert.ok(sol.apexY > origin.y + 2.0, `parabolic apex (${sol.apexY}) should clearly rise above origin (${origin.y})`);
  assert.ok(sol.apexTime > 0.1 * flightTime && sol.apexTime < 0.7 * flightTime);

  // Sample 5 evenly spaced points along flight
  const frac = [0.05, 0.25, 0.45, 0.72, 0.96];
  const pts = frac.map((f) => sampleBallisticPos(sol, f * flightTime));

  // Verify rise then fall
  const peakIdx = pts.reduce((best, p, i) => (p.y > pts[best].y ? i : best), 0);
  assert.ok(peakIdx > 0 && peakIdx < pts.length - 1, `peak should be interior, got index ${peakIdx}: ${pts.map((p) => p.y.toFixed(2))}`);
  assert.ok(pts[peakIdx].y > pts[0].y + 1.0, 'y must rise before apex');
  assert.ok(pts[pts.length - 1].y < pts[peakIdx].y - 3.0, 'y must fall after apex');

  // Verify constant horizontal velocity x/z
  for (let i = 1; i < pts.length; i++) {
    const dt = (frac[i] - frac[i - 1]) * flightTime;
    const vx = (pts[i].x - pts[i - 1].x) / dt;
    const vz = (pts[i].z - pts[i - 1].z) / dt;
    assert.ok(Math.abs(vx - sol.vx) < 1e-6);
    assert.ok(Math.abs(vz - sol.vz) < 1e-6);
  }

  // Exact impact landing accuracy (< 0.01m << 0.5m)
  const end = sampleBallisticPos(sol, flightTime);
  const err = Math.hypot(end.x - target.x, end.y - target.y, end.z - target.z);
  assert.ok(err < 1e-4, `impact error ${err}m too large`);
});

test('ArtillerySystem spawns projectile + visible ground telegraph immediately, damages center player, spares dodger', () => {
  const scene = new THREE.Scene();
  const hits: { damage: number; dist: number }[] = [];
  const art = new ArtillerySystem(scene, {
    onImpactHit: (info) => hits.push({ damage: info.damage, dist: info.dist }),
  });

  const bossPos = { x: -10, y: 0, z: -6 };
  const playerCenter = { x: 0, y: 0, z: 12 };

  // Shot 1: player stands dead center -> takes damage
  art.fireSalvo({
    bossPos,
    bossYaw: Math.atan2(-(playerCenter.x - bossPos.x), -(playerCenter.z - bossPos.z)),
    playerPos: playerCenter,
    salvoCount: 1,
    enraged: false,
    simNowMs: 1000,
  });

  const shot1 = art.telemetry.lastShot!;
  assert.ok(shot1, 'lastShot must be populated');
  assert.equal(art.telemetry.activeProjectiles.length, 1);
  assert.equal(art.telemetry.activeTelegraphs.length, 1);
  assert.equal(art.telemetry.activeTelegraphs[0].visible, true);
  assert.equal(art.telemetry.activeTelegraphs[0].inScene, true);
  assert.ok(art.triangleCount <= ARTILLERY_CONFIG.maxTriangleBudget);

  // Advance in 50ms steps; verify contracting ring shrinks monotonically and telegraph stays visible until impact
  let simMs = 1000;
  let prevScale = 2;
  const ys: number[] = [];
  while (art.telemetry.activeProjectiles.length > 0 && simMs < 5000) {
    simMs += 50;
    art.update(0.05, playerCenter, simMs);
    if (art.telemetry.activeProjectiles.length > 0) {
      ys.push(art.telemetry.activeProjectiles[0].pos.y);
      const tg = art.telemetry.activeTelegraphs[0];
      assert.equal(tg.visible, true);
      assert.ok(tg.ringScale <= prevScale + 1e-6, 'countdown ring must shrink monotonically');
      prevScale = tg.ringScale;
    }
  }
  assert.ok(ys.length >= 10);
  const maxY = Math.max(...ys);
  assert.ok(maxY > ys[0] + 1.0 && maxY > ys[ys.length - 1] + 2.0, 'sampled projectile y must rise then fall');
  assert.equal(hits.length, 1, 'stationary center player must be hit');
  assert.equal(hits[0].damage, ARTILLERY_CONFIG.damage);
  assert.ok(art.telemetry.lastImpact!.hitPlayer);
  assert.ok(art.telemetry.activeImpacts >= 1, 'explosion VFX should spawn on impact');

  // Shot 2: player sprints out of blastRadius during telegraph -> 0 damage
  art.fireSalvo({
    bossPos,
    bossYaw: Math.atan2(-(playerCenter.x - bossPos.x), -(playerCenter.z - bossPos.z)),
    playerPos: playerCenter,
    salvoCount: 1,
    enraged: true,
    simNowMs: simMs,
  });
  const escapedPos = { x: playerCenter.x + ARTILLERY_CONFIG.blastRadius + 1.2, y: 0, z: playerCenter.z };
  while (art.telemetry.activeProjectiles.length > 0 && simMs < 10000) {
    simMs += 50;
    art.update(0.05, escapedPos, simMs);
  }
  assert.equal(hits.length, 1, 'player outside blastRadius must take 0 damage');
  assert.equal(art.telemetry.lastImpact!.hitPlayer, false);

  art.dispose();
  assert.equal(scene.children.includes(art.root), false);
});

test('3-shell enraged fan salvo separates blast rings and stays within <=1500 triangle budget', () => {
  const targets = planSalvoTargets({ x: 0, y: 0, z: -15 }, { x: 0, y: 0, z: 8 }, 3, ARTILLERY_CONFIG.blastRadius);
  assert.equal(targets.length, 3);
  const d01 = Math.hypot(targets[1].x - targets[0].x, targets[1].z - targets[0].z);
  const d02 = Math.hypot(targets[2].x - targets[0].x, targets[2].z - targets[0].z);
  assert.ok(d01 >= ARTILLERY_CONFIG.blastRadius * 1.9, `fan spacing d01=${d01} too tight`);
  assert.ok(d02 >= ARTILLERY_CONFIG.blastRadius * 1.9, `fan spacing d02=${d02} too tight`);

  const scene = new THREE.Scene();
  const art = new ArtillerySystem(scene);
  art.fireSalvo({
    bossPos: { x: 0, y: 0, z: -15 },
    bossYaw: Math.PI,
    playerPos: { x: 0, y: 0, z: 8 },
    salvoCount: 3,
    enraged: true,
    simNowMs: 0,
  });
  art.update(0.4, { x: 0, y: 0, z: 8 }, 400);
  const activeTris = art.triangleCount;
  assert.ok(activeTris > 0 && activeTris <= ARTILLERY_CONFIG.maxTriangleBudget, `3-shell tris ${activeTris} > ${ARTILLERY_CONFIG.maxTriangleBudget}`);

  // Also test peak simultaneous tris: 3 explosions + 3 new shells in flight!
  art.update(1.5, { x: 0, y: 0, z: 8 }, 1900); // detonate first 3
  art.fireSalvo({
    bossPos: { x: 0, y: 0, z: -15 },
    bossYaw: Math.PI,
    playerPos: { x: 0, y: 0, z: 8 },
    salvoCount: 3,
    enraged: true,
    simNowMs: 1950,
  });
  const peakTris = art.triangleCount;
  assert.ok(peakTris <= ARTILLERY_CONFIG.maxTriangleBudget, `peak 3-shell+3-explosion tris ${peakTris} > ${ARTILLERY_CONFIG.maxTriangleBudget}`);
  art.dispose();
});

test('artillery.ts is 100% procedural with zero external asset URLs', () => {
  const source = readFileSync(new URL('./artillery.ts', import.meta.url), 'utf8');
  assert.equal(/\.(glb|gltf|png|jpg|jpeg|webp|svg|mp3|ogg|wav)\b/i.test(source), false);
  assert.equal(/https?:\/\//i.test(source), false);
});
