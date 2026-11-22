import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFootLift, sampleClipMinY } from './enemyFoot.ts';

test('computeFootLift negates finite minY to align boots with root y=0', () => {
  assert.equal(computeFootLift(-0.09), 0.09);
  assert.equal(computeFootLift(0.09), -0.09);
  assert.equal(computeFootLift(-0.0402), 0.0402);
  assert.equal(computeFootLift(0.052), -0.052);
});

test('computeFootLift returns positive +0 for zero and negative zero', () => {
  assert.equal(Object.is(computeFootLift(0), 0), true);
  assert.equal(Object.is(computeFootLift(-0), 0), true);
});

test('computeFootLift falls back to 0 on NaN, infinities, and missing values', () => {
  assert.equal(computeFootLift(Number.NaN), 0);
  assert.equal(computeFootLift(Number.POSITIVE_INFINITY), 0);
  assert.equal(computeFootLift(Number.NEGATIVE_INFINITY), 0);
  assert.equal(computeFootLift(undefined), 0);
  assert.equal(computeFootLift(null), 0);
  assert.equal(computeFootLift(), 0);
});

test('sampleClipMinY interpolates smoothly for looping and one-shot clips', () => {
  const table = new Float32Array([0.0, 0.04, 0.08, 0.04, 0.0]);
  assert.ok(Math.abs(sampleClipMinY(table, 1.0, 0.0, true) - 0.0) < 1e-6);
  assert.ok(Math.abs(sampleClipMinY(table, 1.0, 0.125, true) - 0.02) < 1e-6);
  assert.ok(Math.abs(sampleClipMinY(table, 1.0, 0.5, true) - 0.08) < 1e-6);
  // Looping wrap past duration and negative timestamps
  assert.ok(Math.abs(sampleClipMinY(table, 1.0, 1.5, true) - 0.08) < 1e-6);
  assert.ok(Math.abs(sampleClipMinY(table, 1.0, -0.5, true) - 0.08) < 1e-6);

  // One-shot clamps at boundaries
  const oneshot = [-0.01, -0.04, -0.02];
  assert.ok(Math.abs(sampleClipMinY(oneshot, 0.5, -0.2, false) - -0.01) < 1e-6);
  assert.ok(Math.abs(sampleClipMinY(oneshot, 0.5, 0.25, false) - -0.04) < 1e-6);
  assert.ok(Math.abs(sampleClipMinY(oneshot, 0.5, 2.0, false) - -0.02) < 1e-6);

  // Degenerate / invalid fallbacks
  assert.equal(sampleClipMinY([], 1.0, 0.5, true), 0);
  assert.equal(sampleClipMinY([Number.NaN, 0.02], 1.0, 0.5, true), 0);
  assert.equal(sampleClipMinY([0.05], 1.0, 0.5, true), 0.05);
  assert.equal(sampleClipMinY([0.05, 0.1], 0, 0.5, true), 0.05);
});
