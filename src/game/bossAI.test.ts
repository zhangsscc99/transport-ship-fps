import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BossAI, BOSS_DEFAULTS, type BossEvent } from './bossAI.ts';

test('stationary turret: 30s simulation keeps boss.pos within <0.05m of origin across all distances & phases', () => {
  const boss = new BossAI(2000);
  const start = boss.update(0, { x: 0, z: 22 }, 22);
  const initPos = { ...start.pos };

  let attackStarts = 0;
  let windupStarts = 0;
  let recoverEnds = 0;
  const seenStates = new Set<string>();

  // Simulate 30,000ms (1500 steps × 20ms) with orbiting player ranging from 1.5m to 25m
  for (let i = 0; i < 1500; i++) {
    if (i === 500) boss.applyDamage(700, 'body'); // 65% HP -> Phase 2
    if (i === 1000) boss.applyDamage(700, 'body'); // 30% HP -> Enraged (<=35%)
    const angle = i * 0.04;
    const radius = i % 3 === 0 ? 1.5 : i % 3 === 1 ? 12 : 24;
    const player = { x: Math.cos(angle) * radius, z: Math.sin(angle) * radius };

    const tick = boss.update(20, player, radius);
    seenStates.add(tick.state);
    assert.notEqual(tick.state, 'chase' as string, 'chase state must be disabled');
    assert.notEqual(tick.state, 'charge' as string, 'charge state must be disabled');
    assert.equal(tick.hitWindowOpen, false, 'melee hitWindowOpen must always be false');

    const disp = Math.hypot(tick.pos.x - initPos.x, tick.pos.z - initPos.z);
    assert.ok(disp < 0.05, `boss displaced ${disp.toFixed(4)}m at step ${i} (must be <0.05m)`);

    if (tick.events.includes('windup_start')) windupStarts++;
    if (tick.events.includes('attack_start')) attackStarts++;
    if (tick.events.includes('recover_end')) recoverEnds++;
  }

  assert.ok(windupStarts >= 8, `expected >=8 windups in 30s, got ${windupStarts}`);
  assert.ok(attackStarts >= 8, `expected >=8 artillery launches in 30s, got ${attackStarts}`);
  assert.ok(recoverEnds >= 7, `expected >=7 recover cycles in 30s, got ${recoverEnds}`);
  assert.deepEqual(
    [...seenStates].sort(),
    ['attack', 'idle', 'recover', 'windup'],
    'should cycle strictly through idle/windup/attack/recover',
  );
});

test('windup lasts >=600ms before attack_start in phase 1, phase 2, and clamped opts', () => {
  // Phase 1 default windup = 700ms
  const boss = new BossAI(2000);
  const player = { x: 0, z: 20 };

  const enter = boss.update(16, player, 20);
  assert.equal(enter.state, 'windup');
  assert.ok(enter.events.includes('windup_start'));
  assert.equal(enter.hitWindowOpen, false);
  const startPos = { ...enter.pos };

  let elapsed = 0;
  let attackStartAt = -1;
  while (elapsed < 1000) {
    const dt = 16;
    elapsed += dt;
    const tick = boss.update(dt, player, 20);
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

  // Phase 2 & explicit sub-600 option clamped to >=600ms
  const clamped = new BossAI(2000, { windupMs: 250 });
  clamped.applyDamage(700, 'body'); // 65% HP -> phase 2
  const w0 = clamped.update(10, player, 20);
  assert.equal(w0.state, 'windup');
  assert.equal(w0.phase, 2);

  let phase2Elapsed = 0;
  let phase2AttackAt = -1;
  while (phase2Elapsed < 1000) {
    phase2Elapsed += 10;
    const t = clamped.update(10, player, 20);
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

test('zero melee logic: player at point-blank (1.5m) never triggers melee hitWindowOpen or attack_hit', () => {
  const boss = new BossAI(2000);
  const player = { x: 0, z: 1.5 };
  let attackStarts = 0;

  for (let i = 0; i < 400; i++) {
    const tick = boss.update(20, player, 1.5);
    assert.equal(tick.hitWindowOpen, false);
    assert.ok(!(tick.events as readonly string[]).includes('attack_hit'));
    assert.ok(!(tick.events as readonly string[]).includes('charge_start'));
    if (tick.events.includes('attack_start')) attackStarts++;
  }
  assert.ok(attackStarts >= 2, `expected artillery attack_start even at close range, got ${attackStarts}`);
});

test('rotates yaw in place to face player without translating', () => {
  const boss = new BossAI(2000);
  const tNorth = boss.update(16, { x: 0, z: -20 }, 20);
  assert.ok(Math.abs(tNorth.yaw) < 1e-5, `facing -Z should yield yaw=0, got ${tNorth.yaw}`);
  assert.deepEqual(tNorth.pos, { x: 0, z: 0 });

  const tEast = boss.update(16, { x: 20, z: 0 }, 20);
  assert.ok(Math.abs(tEast.yaw - (-Math.PI / 2)) < 1e-5, `facing +X should yield yaw=-PI/2, got ${tEast.yaw}`);
  assert.deepEqual(tEast.pos, { x: 0, z: 0 });
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

  assert.equal(boss.applyDamage(0, 'head'), 0);
  assert.equal(boss.applyDamage(-10, 'core'), 0);
});

test('phase 2 (<=70%) and enraged (<=35%) increase salvoCount (1 -> 2 -> 3) and tighten cooldown', () => {
  const boss = new BossAI(1000);
  const p1 = boss.update(0, { x: 0, z: 20 }, 20);
  assert.equal(p1.phase, 1);
  assert.equal(p1.enraged, false);
  assert.equal(p1.salvoCount, BOSS_DEFAULTS.phase1SalvoCount);

  boss.applyDamage(300, 'body'); // 70% HP -> Phase 2
  const p2 = boss.update(16, { x: 0, z: 20 }, 20);
  assert.equal(p2.phase, 2);
  assert.equal(p2.enraged, false);
  assert.equal(p2.salvoCount, BOSS_DEFAULTS.phase2SalvoCount);
  assert.ok(p2.events.includes('phase2'));

  // Subsequent ticks must not repeat phase2 event
  const p2Next = boss.update(16, { x: 0, z: 20 }, 20);
  assert.ok(!p2Next.events.includes('phase2'));

  boss.applyDamage(350, 'body'); // 35% HP -> Enraged
  const p3 = boss.update(16, { x: 0, z: 20 }, 20);
  assert.equal(p3.phase, 2);
  assert.equal(p3.enraged, true);
  assert.equal(p3.salvoCount, BOSS_DEFAULTS.enragedSalvoCount);

  function measureCooldownMs(hpDamage: number): number {
    const b = new BossAI(1000);
    if (hpDamage > 0) b.applyDamage(hpDamage, 'body');
    const p = { x: 0, z: 20 };
    let seenRecoverEnd = false;
    for (let i = 0; i < 400; i++) {
      const t = b.update(10, p, 20);
      if (t.events.includes('recover_end')) {
        seenRecoverEnd = true;
        break;
      }
    }
    assert.equal(seenRecoverEnd, true);

    let cdMs = 0;
    while (cdMs < 3000) {
      cdMs += 10;
      const t = b.update(10, p, 20);
      if (t.events.includes('windup_start')) return cdMs;
    }
    throw new Error('windup_start never resumed after recover_end');
  }

  const cdPhase1 = measureCooldownMs(0);   // 100% HP
  const cdPhase2 = measureCooldownMs(350); // 65% HP
  const cdEnrage = measureCooldownMs(700); // 30% HP

  assert.ok(cdPhase2 < cdPhase1, `P2 cooldown (${cdPhase2}) should be < P1 (${cdPhase1})`);
  assert.ok(cdEnrage < cdPhase2, `Enraged cooldown (${cdEnrage}) should be < P2 (${cdPhase2})`);
});

test('recover lasts >=800ms stationary and death (hp <= 0) freezes state in recover with zero events', () => {
  const boss = new BossAI(1000, { recoverMs: 200 }); // clamped to >= 800ms
  const p = { x: 0, z: 18 };
  let cur = boss.update(10, p, 18);
  for (let i = 0; i < 200 && cur.state !== 'recover'; i++) {
    cur = boss.update(10, p, 18);
  }
  assert.equal(cur.state, 'recover');
  const recPos = { ...cur.pos };

  let recElapsed = 0;
  let recEndAt = -1;
  while (recElapsed < 1200) {
    recElapsed += 10;
    cur = boss.update(10, p, 18);
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

  // Kill boss -> stays in recover forever, zero attack events
  const dying = new BossAI(500);
  dying.update(16, p, 18);
  dying.applyDamage(500, 'body');
  assert.equal(dying.applyDamage(50, 'head'), 0);

  const forbidden = new Set<BossEvent>(['windup_start', 'attack_start', 'recover_end', 'phase2']);
  const frozenPos = dying.update(16, p, 18).pos;
  for (let i = 0; i < 200; i++) {
    const t = dying.update(50, p, 18);
    assert.equal(t.hp, 0);
    assert.equal(t.state, 'recover');
    assert.equal(t.hitWindowOpen, false);
    assert.deepEqual(t.pos, frozenPos);
    for (const ev of t.events) {
      assert.ok(!forbidden.has(ev), `dead boss emitted forbidden event ${ev}`);
    }
  }

  // reset() restores full alive state
  dying.reset();
  const fresh = dying.update(0, p, 18);
  assert.equal(fresh.state, 'idle');
  assert.equal(fresh.hp, 500);
  assert.equal(fresh.phase, 1);
  assert.deepEqual(fresh.pos, { x: 0, z: 0 });
});

test('pure logic: bossAI.ts has zero three.js or DOM imports/references', () => {
  const srcPath = new URL('./bossAI.ts', import.meta.url);
  const source = readFileSync(srcPath, 'utf8');
  assert.equal(/\bfrom\s+['"]three['"]/.test(source), false, 'bossAI.ts must not import three.js');
  assert.equal(/\b(window|document)\b/.test(source), false, 'bossAI.ts must not touch DOM');
});
