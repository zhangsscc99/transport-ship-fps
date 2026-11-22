import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as bossAIMod from './bossAI.ts';
import { BossAI, BOSS_DEFAULTS, type BossEvent } from './bossAI.ts';

test('windup lasts >=600ms: no attack_start within 600ms in phase 1, phase 2, or clamped opts', () => {
  // Phase 1 default windup = 700ms
  const boss = new BossAI(2000);
  const player = { x: 0, z: 2.5 };

  const enter = boss.update(16, player, 2.5);
  assert.equal(enter.state, 'windup');
  assert.ok(enter.events.includes('windup_start'));
  assert.equal(enter.hitWindowOpen, false);
  const startPos = { ...enter.pos };

  let elapsed = 0;
  let attackStartAt = -1;
  while (elapsed < 1000) {
    const dt = 16;
    elapsed += dt;
    const tick = boss.update(dt, player, 2.5);
    if (elapsed < 600) {
      assert.equal(tick.state, 'windup', `left windup too early at ${elapsed}ms`);
      assert.ok(!tick.events.includes('attack_start'), `attack_start fired early at ${elapsed}ms`);
      assert.deepEqual(tick.pos, startPos, 'boss moved during windup');
    }
    if (tick.events.includes('attack_start')) {
      attackStartAt = elapsed;
      break;
    }
  }
  assert.ok(attackStartAt >= 700, `phase 1 attack_start should be >=700ms, got ${attackStartAt}ms`);

  // Phase 2 (700 - 100 = 600ms) & explicit sub-600 option clamped to >=600ms
  const clamped = new BossAI(2000, { windupMs: 250 });
  clamped.applyDamage(700, 'body'); // 65% HP -> phase 2
  const w0 = clamped.update(10, player, 2.5);
  assert.equal(w0.state, 'windup');
  assert.equal(w0.phase, 2);

  let phase2Elapsed = 0;
  let phase2AttackAt = -1;
  while (phase2Elapsed < 1000) {
    phase2Elapsed += 10;
    const t = clamped.update(10, player, 2.5);
    if (phase2Elapsed < 600) {
      assert.equal(t.state, 'windup');
      assert.ok(!t.events.includes('attack_start'), `phase 2 attack_start early at ${phase2Elapsed}ms`);
    }
    if (t.events.includes('attack_start')) {
      phase2AttackAt = phase2Elapsed;
      break;
    }
  }
  assert.equal(phase2AttackAt, 600, `clamped phase 2 windup must be 600ms, got ${phase2AttackAt}ms`);
});

test('melee only: player at distance 10m never triggers attack_hit (chase or post-windup retreat)', () => {
  // Case A: player held at 10m for 10 seconds
  const boss = new BossAI(2000);
  for (let i = 0; i < 600; i++) {
    const tick = boss.update(16, { x: 0, z: 10 }, 10);
    assert.ok(!tick.events.includes('attack_hit'), `unexpected attack_hit at frame ${i}`);
    assert.ok(!tick.events.includes('attack_start'));
    assert.equal(tick.hitWindowOpen, false);
  }

  // Case B: player baits windup at 2.5m, then retreats to 10m before swing lands
  const boss2 = new BossAI(2000);
  boss2.update(16, { x: 0, z: 2.5 }, 2.5); // enters windup
  let sawAttackStart = false;
  for (let i = 0; i < 80; i++) {
    const tick = boss2.update(16, { x: 0, z: 10 }, 10);
    if (tick.events.includes('attack_start')) sawAttackStart = true;
    assert.ok(!tick.events.includes('attack_hit'), 'retreated player at 10m must not be hit');
  }
  assert.equal(sawAttackStart, true);
});

test('attack hitWindowOpen covers only first 60% of 180ms and emits attack_hit at most once', () => {
  const boss = new BossAI(2000);
  const player = { x: 0, z: 2.0 };

  // Enter windup then advance to attack_start with 10ms steps
  boss.update(10, player, 2.0);
  for (let t = 10; t < 700; t += 10) {
    const tick = boss.update(10, player, 2.0);
    assert.equal(tick.state, 'windup');
  }

  // 700ms tick triggers attack_start (t=0 inside attack -> hitWindowOpen=true -> hits once)
  const atk0 = boss.update(10, player, 2.0);
  assert.equal(atk0.state, 'attack');
  assert.ok(atk0.events.includes('attack_start'));
  assert.ok(atk0.events.includes('attack_hit'));
  assert.equal(atk0.hitWindowOpen, true);

  // Step through remaining 180ms in 18ms (10%) increments
  let extraHits = 0;
  for (let pct = 10; pct < 100; pct += 10) {
    const tick = boss.update(18, player, 2.0);
    assert.equal(tick.state, 'attack');
    assert.equal(
      tick.hitWindowOpen,
      pct < 60,
      `hitWindowOpen at ${pct}% should be ${pct < 60}`,
    );
    if (tick.events.includes('attack_hit')) extraHits++;
  }
  assert.equal(extraHits, 0, 'single swing must not emit attack_hit more than once');

  // Final 18ms -> 180ms transitions to recover
  const rec0 = boss.update(18, player, 2.0);
  assert.equal(rec0.state, 'recover');
  assert.equal(rec0.hitWindowOpen, false);

  // Also verify late entry into melee range during last 40% cannot hit
  const bossLate = new BossAI(2000);
  bossLate.update(10, { x: 0, z: 2.0 }, 2.0);
  for (let t = 10; t < 700; t += 10) bossLate.update(10, { x: 0, z: 2.0 }, 2.0);
  const lateAtk0 = bossLate.update(10, { x: 0, z: 6.0 }, 6.0); // out of range at start
  assert.equal(lateAtk0.state, 'attack');
  assert.ok(!lateAtk0.events.includes('attack_hit'));
  // Advance past 60% (108ms) while still out of range, then step into 2m during closed window
  bossLate.update(108, { x: 0, z: 6.0 }, 6.0);
  const lateClosed = bossLate.update(20, { x: 0, z: 2.0 }, 2.0);
  assert.equal(lateClosed.state, 'attack');
  assert.equal(lateClosed.hitWindowOpen, false);
  assert.ok(!lateClosed.events.includes('attack_hit'));
});

test('weakpoint multipliers: head = 2.5x, core = 2.0x, body = 1.0x', () => {
  const boss = new BossAI(2000);
  const baseDmg = 40;

  const bodyDmg = boss.applyDamage(baseDmg, 'body');
  const coreDmg = boss.applyDamage(baseDmg, 'core');
  const headDmg = boss.applyDamage(baseDmg, 'head');

  assert.equal(bodyDmg, baseDmg);
  assert.equal(coreDmg, bodyDmg * 2.0);
  assert.equal(headDmg, bodyDmg * 2.5);

  const tick = boss.update(0, { x: 0, z: 10 }, 10);
  assert.equal(tick.hp, 2000 - (40 + 80 + 100));

  // Non-positive damage is ignored
  assert.equal(boss.applyDamage(0, 'head'), 0);
  assert.equal(boss.applyDamage(-10, 'core'), 0);
});

test('phase 2 at <=70% HP emits phase2 once, boosts speed +15%, cuts cooldown -20% and -10% more at <=35%', () => {
  const boss = new BossAI(1000);

  // Measure phase 1 chase speed
  const p1Start = boss.update(0, { x: 0, z: 10 }, 10);
  assert.equal(p1Start.state, 'idle');
  assert.equal(p1Start.phase, 1);
  const p1Moved = boss.update(1000, { x: 0, z: 10 }, 10);
  const p1Speed = Math.hypot(p1Moved.pos.x - p1Start.pos.x, p1Moved.pos.z - p1Start.pos.z);
  assert.ok(Math.abs(p1Speed - BOSS_DEFAULTS.moveSpeed) < 1e-6, `phase 1 speed ${p1Speed}`);

  // Drop HP to 70% (700/1000) -> triggers phase 2
  boss.applyDamage(300, 'body');
  const p2Tick = boss.update(1000, { x: 0, z: 15 }, 10);
  assert.equal(p2Tick.phase, 2);
  assert.ok(p2Tick.events.includes('phase2'), 'must emit phase2 event on threshold');
  const p2Speed = Math.hypot(p2Tick.pos.x - p1Moved.pos.x, p2Tick.pos.z - p1Moved.pos.z);
  assert.ok(
    Math.abs(p2Speed - BOSS_DEFAULTS.moveSpeed * 1.15) < 1e-6,
    `phase 2 speed ${p2Speed} should be ${BOSS_DEFAULTS.moveSpeed * 1.15}`,
  );

  // Subsequent ticks must not repeat phase2 event
  const p2Next = boss.update(16, { x: 0, z: 15 }, 10);
  assert.ok(!p2Next.events.includes('phase2'));

  // Helper to measure cooldown duration after recover_end at a given HP ratio
  function measureCooldownMs(hpDamage: number): number {
    const b = new BossAI(1000);
    if (hpDamage > 0) b.applyDamage(hpDamage, 'body');
    const p = { x: 0, z: 2.0 };
    // Trigger windup -> attack -> recover -> recover_end
    let seenRecoverEnd = false;
    for (let i = 0; i < 400; i++) {
      const t = b.update(10, p, 2.0);
      if (t.events.includes('recover_end')) {
        seenRecoverEnd = true;
        break;
      }
    }
    assert.equal(seenRecoverEnd, true);

    // Count ms until next windup_start
    let cdMs = 0;
    while (cdMs < 2000) {
      cdMs += 10;
      const t = b.update(10, p, 2.0);
      if (t.events.includes('windup_start')) return cdMs;
    }
    throw new Error('windup_start never resumed after recover_end');
  }

  const cdPhase1 = measureCooldownMs(0);   // 100% HP -> 900ms
  const cdPhase2 = measureCooldownMs(350); // 65% HP  -> 720ms (-20%)
  const cdEnrage = measureCooldownMs(700); // 30% HP  -> 630ms (additional -10%)

  assert.equal(cdPhase1, 900);
  assert.equal(cdPhase2, 720);
  assert.equal(cdEnrage, 630);
});

test('charge triggers at distance >18m, locks yaw (dodgeable by sidestep), and hits once on direct impact', () => {
  // Scenario 1: Player sidesteps -> yaw stays locked and charge misses cleanly into recover
  const bossDodge = new BossAI(2000);
  const start = bossDodge.update(16, { x: 0, z: 20 }, 20);
  assert.equal(start.state, 'charge');
  assert.ok(start.events.includes('charge_start'));
  const lockedYaw = start.yaw;

  // Verify speed during charge is 2.2x moveSpeed
  const after100 = bossDodge.update(100, { x: 6, z: 20 }, Math.hypot(6 - start.pos.x, 20 - start.pos.z));
  assert.equal(after100.state, 'charge');
  assert.equal(after100.yaw, lockedYaw, 'yaw must NOT follow sidestepping player during charge');
  const stepDist = Math.hypot(after100.pos.x - start.pos.x, after100.pos.z - start.pos.z);
  const expectedDist = BOSS_DEFAULTS.moveSpeed * BOSS_DEFAULTS.chargeSpeedMult * 0.1;
  assert.ok(Math.abs(stepDist - expectedDist) < 1e-5, `charge speed dist ${stepDist} vs ${expectedDist}`);
  assert.ok(Math.abs(after100.pos.x) < 1e-6, 'charge must stay on straight line (x=0)');

  // Keep player sidestepped at x=4, z=20 until charge ends
  let pos = after100.pos;
  let reachedRecover = false;
  for (let i = 0; i < 400; i++) {
    const dist = Math.hypot(4 - pos.x, 20 - pos.z);
    const t = bossDodge.update(20, { x: 4, z: 20 }, dist);
    pos = t.pos;
    assert.ok(!t.events.includes('attack_hit'), 'sidestepped charge must not hit player');
    if (t.state === 'charge') {
      assert.equal(t.yaw, lockedYaw, 'yaw must remain locked throughout charge');
    } else if (t.state === 'recover') {
      reachedRecover = true;
      break;
    }
  }
  assert.equal(reachedRecover, true, 'missed charge should end in recover');

  // Scenario 2: Stationary player at (0, 20) gets hit once and boss enters recover
  const bossHit = new BossAI(2000);
  let cur = bossHit.update(16, { x: 0, z: 20 }, 20);
  assert.equal(cur.state, 'charge');
  const hitYaw = cur.yaw;
  let hitCount = 0;
  let enteredRecoverOnHit = false;
  for (let i = 0; i < 400; i++) {
    const dist = Math.hypot(0 - cur.pos.x, 20 - cur.pos.z);
    cur = bossHit.update(16, { x: 0, z: 20 }, dist);
    if (cur.events.includes('attack_hit')) {
      hitCount++;
      assert.equal(cur.state, 'recover', 'charge hit must transition immediately to recover');
      enteredRecoverOnHit = true;
      break;
    }
    assert.equal(cur.yaw, hitYaw);
  }
  assert.equal(hitCount, 1);
  assert.equal(enteredRecoverOnHit, true);
});

test('recover lasts >=800ms stationary and death (hp <= 0) freezes state in recover with zero attack events', () => {
  // Verify recover duration >= 800ms and stationary
  const boss = new BossAI(1000, { recoverMs: 200 }); // clamped to >= 800ms
  const p = { x: 0, z: 2.0 };
  let cur = boss.update(10, p, 2.0);
  for (let i = 0; i < 200 && cur.state !== 'recover'; i++) {
    cur = boss.update(10, p, 2.0);
  }
  assert.equal(cur.state, 'recover');
  const recPos = { ...cur.pos };

  let recElapsed = 0;
  let recEndAt = -1;
  while (recElapsed < 1200) {
    recElapsed += 10;
    cur = boss.update(10, p, 2.0);
    if (recElapsed < 800) {
      assert.equal(cur.state, 'recover');
      assert.ok(!cur.events.includes('recover_end'));
      assert.deepEqual(cur.pos, recPos);
    }
    if (cur.events.includes('recover_end')) {
      recEndAt = recElapsed;
      break;
    }
  }
  assert.equal(recEndAt, 800);

  // Kill boss during windup/attack -> stays in recover forever, zero attack events
  const dying = new BossAI(500);
  dying.update(16, p, 2.0); // windup
  dying.applyDamage(500, 'body');
  assert.equal(dying.applyDamage(50, 'head'), 0, 'dead boss takes no further damage');

  const attackEvents = new Set<BossEvent>([
    'windup_start',
    'attack_start',
    'attack_hit',
    'charge_start',
    'recover_end',
  ]);
  const frozenPos = dying.update(16, p, 2.0).pos;
  for (let i = 0; i < 200; i++) {
    const t = dying.update(50, p, 2.0);
    assert.equal(t.hp, 0);
    assert.equal(t.state, 'recover');
    assert.equal(t.hitWindowOpen, false);
    assert.deepEqual(t.pos, frozenPos);
    for (const ev of t.events) {
      assert.ok(!attackEvents.has(ev), `dead boss emitted forbidden event ${ev}`);
    }
  }

  // reset() restores full alive state
  dying.reset();
  const fresh = dying.update(0, p, 10);
  assert.equal(fresh.state, 'idle');
  assert.equal(fresh.hp, 500);
  assert.equal(fresh.phase, 1);
  assert.deepEqual(fresh.pos, { x: 0, z: 0 });
});

test('pure melee & pure logic: source and exports contain no ranged/projectile or DOM/three.js references', () => {
  const srcPath = new URL('./bossAI.ts', import.meta.url);
  const source = readFileSync(srcPath, 'utf8');

  const rangedPattern = /\b(projectile|bullet|missile|fireball|laser|ranged|shoot)\b/i;
  assert.equal(rangedPattern.test(source), false, 'bossAI.ts must not contain ranged/projectile logic');

  for (const exportName of Object.keys(bossAIMod)) {
    assert.equal(
      rangedPattern.test(exportName),
      false,
      `unexpected ranged export: ${exportName}`,
    );
  }

  assert.equal(/\bfrom\s+['"]three['"]/.test(source), false, 'bossAI.ts must not import three.js');
  assert.equal(/\b(window|document)\b/.test(source), false, 'bossAI.ts must not touch DOM');
});
