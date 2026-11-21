import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMatch } from './match.ts';
import { createEntity } from './entities.ts';
import { applyDamage } from './damage.ts';
import {
  formatClock,
  isClockUrgent,
  isClockPulsing,
  scorePlayerDeath,
  URGENT_MS,
} from './objective.ts';

const FAST = { teamKillsToWin: 3, durationMs: 60_000, countdownMs: 1_000 };

test('formatClock renders M:SS, rounding seconds up', () => {
  assert.equal(formatClock(5 * 60_000), '5:00');
  assert.equal(formatClock(299_001), '5:00');
  assert.equal(formatClock(299_000), '4:59');
  assert.equal(formatClock(61_000), '1:01');
  assert.equal(formatClock(9_500), '0:10');
  assert.equal(formatClock(1), '0:01');
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatClock(-500), '0:00');
  assert.equal(formatClock(Number.NaN), '0:00');
  for (const ms of [0, 1, 999, 29_999, 60_000, 299_999, 300_000]) {
    assert.match(formatClock(ms), /^\d:\d\d$/);
  }
});

test('clock is urgent under 30s only in playing/over, and pulses only while playing', () => {
  assert.equal(isClockUrgent(URGENT_MS, 'playing'), false);
  assert.equal(isClockUrgent(URGENT_MS - 1, 'playing'), true);
  assert.equal(isClockUrgent(0, 'over'), true);
  assert.equal(isClockUrgent(10_000, 'countdown'), false);
  assert.equal(isClockUrgent(10_000, 'menu'), false);
  assert.equal(isClockPulsing(10_000, 'playing'), true);
  assert.equal(isClockPulsing(10_000, 'over'), false);
  assert.equal(isClockPulsing(URGENT_MS + 1, 'playing'), false);
});

test('a lethal hit scores exactly one kill for team B; hits on the corpse never add more', () => {
  const m = createMatch(FAST);
  m.start(0);
  m.tick(FAST.countdownMs);
  const p = createEntity('player', { x: 0, y: 0, z: 0 }, 200, 0.4, 1.6);

  const k1 = applyDamage(p, 50, 1_100);
  assert.equal(scorePlayerDeath(m, k1, 1_100), false, 'non-lethal hit scored');
  assert.equal(m.killsB, 0);

  const k2 = applyDamage(p, 999, 1_200);
  assert.equal(k2, true);
  assert.equal(scorePlayerDeath(m, k2, 1_200), true);
  assert.equal(m.killsB, 1);

  for (let i = 0; i < 5; i++) {
    const again = applyDamage(p, 999, 1_300 + i);
    assert.equal(again, false);
    scorePlayerDeath(m, again, 1_300 + i);
  }
  assert.equal(m.killsB, 1, 'dead player scored again');
});

test('player death outside playing never scores', () => {
  const m = createMatch(FAST);
  assert.equal(scorePlayerDeath(m, true, 0), false, 'menu death scored');
  m.start(0);
  assert.equal(scorePlayerDeath(m, true, 500), false, 'countdown death scored');
  m.tick(FAST.countdownMs + FAST.durationMs);
  assert.equal(m.phase, 'over');
  assert.equal(scorePlayerDeath(m, true, FAST.countdownMs + FAST.durationMs + 1), false);
  assert.equal(m.killsB, 0);
});
