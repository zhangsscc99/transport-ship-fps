// src/game/enemyFoot.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

// src/game/enemyFoot.ts
function computeFootLift(minY) {
  if (typeof minY !== "number" || !Number.isFinite(minY)) return 0;
  const lift = -minY;
  return lift === 0 ? 0 : lift;
}
function sampleClipMinY(samples, durationSec, timeSec, loop) {
  const n = samples.length;
  if (n === 0) return 0;
  if (n === 1 || !Number.isFinite(durationSec) || durationSec <= 0 || !Number.isFinite(timeSec)) {
    const v = samples[0];
    return Number.isFinite(v) ? v : 0;
  }
  let u;
  if (loop) {
    const wrapped = (timeSec % durationSec + durationSec) % durationSec;
    u = wrapped / durationSec;
  } else {
    u = Math.max(0, Math.min(1, timeSec / durationSec));
  }
  const f = u * (n - 1);
  const i0 = Math.min(n - 2, Math.floor(f));
  const frac = f - i0;
  const a = samples[i0];
  const b = samples[i0 + 1];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  const val = a + (b - a) * frac;
  return val === 0 ? 0 : val;
}

// src/game/enemyFoot.test.ts
test("computeFootLift negates finite minY to align boots with root y=0", () => {
  assert.equal(computeFootLift(-0.09), 0.09);
  assert.equal(computeFootLift(0.09), -0.09);
  assert.equal(computeFootLift(-0.0402), 0.0402);
  assert.equal(computeFootLift(0.052), -0.052);
});
test("computeFootLift returns positive +0 for zero and negative zero", () => {
  assert.equal(Object.is(computeFootLift(0), 0), true);
  assert.equal(Object.is(computeFootLift(-0), 0), true);
});
test("computeFootLift falls back to 0 on NaN, infinities, and missing values", () => {
  assert.equal(computeFootLift(Number.NaN), 0);
  assert.equal(computeFootLift(Number.POSITIVE_INFINITY), 0);
  assert.equal(computeFootLift(Number.NEGATIVE_INFINITY), 0);
  assert.equal(computeFootLift(void 0), 0);
  assert.equal(computeFootLift(null), 0);
  assert.equal(computeFootLift(), 0);
});
test("sampleClipMinY interpolates smoothly for looping and one-shot clips", () => {
  const table = new Float32Array([0, 0.04, 0.08, 0.04, 0]);
  assert.ok(Math.abs(sampleClipMinY(table, 1, 0, true) - 0) < 1e-6);
  assert.ok(Math.abs(sampleClipMinY(table, 1, 0.125, true) - 0.02) < 1e-6);
  assert.ok(Math.abs(sampleClipMinY(table, 1, 0.5, true) - 0.08) < 1e-6);
  assert.ok(Math.abs(sampleClipMinY(table, 1, 1.5, true) - 0.08) < 1e-6);
  assert.ok(Math.abs(sampleClipMinY(table, 1, -0.5, true) - 0.08) < 1e-6);
  const oneshot = [-0.01, -0.04, -0.02];
  assert.ok(Math.abs(sampleClipMinY(oneshot, 0.5, -0.2, false) - -0.01) < 1e-6);
  assert.ok(Math.abs(sampleClipMinY(oneshot, 0.5, 0.25, false) - -0.04) < 1e-6);
  assert.ok(Math.abs(sampleClipMinY(oneshot, 0.5, 2, false) - -0.02) < 1e-6);
  assert.equal(sampleClipMinY([], 1, 0.5, true), 0);
  assert.equal(sampleClipMinY([Number.NaN, 0.02], 1, 0.5, true), 0);
  assert.equal(sampleClipMinY([0.05], 1, 0.5, true), 0.05);
  assert.equal(sampleClipMinY([0.05, 0.1], 0, 0.5, true), 0.05);
});
