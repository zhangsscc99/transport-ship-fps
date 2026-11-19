import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMatch } from './match.ts';

const FAST = { teamKillsToWin: 3, durationMs: 60_000, countdownMs: 1_000 };

test('a fresh match sits in menu with zeroed counters', () => {
  const m = createMatch();
  assert.equal(m.phase, 'menu');
  assert.equal(m.killsA, 0);
  assert.equal(m.killsB, 0);
  assert.equal(m.winner, null);
  assert.equal(m.timeLeftMs, 5 * 60_000);
  assert.equal(m.canAct(0), false);
});

test('start() enters the countdown; it is a no-op while running', () => {
  const m = createMatch(FAST);
  m.start(1_000);
  assert.equal(m.phase, 'countdown');
  assert.equal(m.countdownLeftMs, 1_000);
  m.start(1_500); // already counting — must not restart the timer
  m.tick(1_500);
  assert.equal(m.countdownLeftMs, 500);
});

test('the countdown rolls into playing after countdownMs', () => {
  const m = createMatch(FAST);
  m.start(0);
  m.tick(999);
  assert.equal(m.phase, 'countdown');
  m.tick(1_000);
  assert.equal(m.phase, 'playing');
  assert.equal(m.timeLeftMs, FAST.durationMs);
});

test('canAct is true during countdown and playing, false in menu and over', () => {
  const m = createMatch(FAST);
  assert.equal(m.canAct(0), false);
  m.start(0);
  m.tick(100);
  assert.equal(m.canAct(100), true);
  m.tick(FAST.countdownMs);
  assert.equal(m.canAct(FAST.countdownMs), true);
  for (let i = 0; i < FAST.teamKillsToWin; i++) m.registerKill('A', 1_100 + i);
  assert.equal(m.phase, 'over');
  assert.equal(m.canAct(9_999), false);
});

test('registerKill is ignored in menu and countdown', () => {
  const m = createMatch(FAST);
  assert.equal(m.registerKill('A', 0), false);
  m.start(0);
  assert.equal(m.registerKill('A', 500), false, 'countdown kill counted');
  assert.equal(m.killsA, 0);
  m.tick(FAST.countdownMs);
  assert.equal(m.registerKill('A', FAST.countdownMs), true);
  assert.equal(m.killsA, 1);
});

test('reaching teamKillsToWin ends the match with that team winning', () => {
  const m = createMatch(FAST);
  m.start(0);
  m.tick(FAST.countdownMs);
  m.registerKill('B', 1_100);
  m.registerKill('B', 1_200);
  assert.equal(m.phase, 'playing');
  m.registerKill('B', 1_300);
  assert.equal(m.phase, 'over');
  assert.equal(m.winner, 'B');
  assert.equal(m.killsB, 3);
});

test('time-up picks the higher-kill team', () => {
  const m = createMatch(FAST);
  m.start(0);
  m.tick(FAST.countdownMs);
  m.registerKill('A', 1_100);
  m.registerKill('A', 1_200);
  m.registerKill('B', 1_300);
  m.tick(FAST.countdownMs + FAST.durationMs);
  assert.equal(m.phase, 'over');
  assert.equal(m.winner, 'A');
});

test('a tie at time-up is a draw', () => {
  const m = createMatch(FAST);
  m.start(0);
  m.tick(FAST.countdownMs);
  m.registerKill('A', 1_100);
  m.registerKill('B', 1_200);
  m.tick(FAST.countdownMs + FAST.durationMs + 1);
  assert.equal(m.phase, 'over');
  assert.equal(m.winner, 'draw');
});

test('kills after over are ignored', () => {
  const m = createMatch(FAST);
  m.start(0);
  m.tick(FAST.countdownMs);
  for (let i = 0; i < FAST.teamKillsToWin; i++) m.registerKill('A', 1_100 + i);
  assert.equal(m.phase, 'over');
  assert.equal(m.registerKill('B', 2_000), false);
  assert.equal(m.killsB, 0);
});

test('timeLeftMs never goes negative', () => {
  const m = createMatch(FAST);
  m.start(0);
  m.tick(FAST.countdownMs + FAST.durationMs + 50_000);
  assert.equal(m.phase, 'over');
  assert.equal(m.timeLeftMs, 0);
});

test('repeated ticks at the same timestamp change nothing', () => {
  const m = createMatch(FAST);
  m.start(0);
  m.tick(500);
  m.tick(500);
  m.tick(500);
  assert.equal(m.phase, 'countdown');
  assert.equal(m.countdownLeftMs, 500);
  m.tick(FAST.countdownMs);
  assert.equal(m.phase, 'playing');
  m.tick(FAST.countdownMs);
  assert.equal(m.timeLeftMs, FAST.durationMs);
});

test('start() from over resets the counters and runs the countdown again', () => {
  const m = createMatch(FAST);
  m.start(0);
  m.tick(FAST.countdownMs);
  for (let i = 0; i < FAST.teamKillsToWin; i++) m.registerKill('A', 1_100 + i);
  assert.equal(m.phase, 'over');
  m.start(10_000);
  assert.equal(m.phase, 'countdown');
  assert.equal(m.killsA, 0);
  assert.equal(m.killsB, 0);
  assert.equal(m.winner, null);
  assert.equal(m.timeLeftMs, FAST.durationMs);
});
