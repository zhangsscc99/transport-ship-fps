// Pure enemy foot-grounding math — no three.js / DOM dependencies so it can be
// unit-tested directly under Node.

/**
 * Given a character model's lowest vertical coordinate `minY` in model space,
 * return the vertical offset to apply to the model so its soles sit flush on
 * `root.position.y` (local y = 0).
 *
 * Examples:
 *   minY = -0.09 (boots sink 9 cm below origin) -> +0.09 (lift model up 9 cm)
 *   minY = +0.09 (boots float 9 cm above origin) -> -0.09 (lower model 9 cm)
 *   minY = 0     -> 0
 *   NaN / Infinity / missing -> 0 (safe fallback)
 */
export function computeFootLift(minY?: number | null): number {
  if (typeof minY !== 'number' || !Number.isFinite(minY)) return 0;
  const lift = -minY;
  return lift === 0 ? 0 : lift;
}

/**
 * Linearly interpolate a pre-measured per-clip `minY` lookup table at playback
 * timestamp `timeSec`. Returns 0 on degenerate or non-finite inputs.
 */
export function sampleClipMinY(
  samples: readonly number[] | Float32Array,
  durationSec: number,
  timeSec: number,
  loop: boolean,
): number {
  const n = samples.length;
  if (n === 0) return 0;
  if (n === 1 || !Number.isFinite(durationSec) || durationSec <= 0 || !Number.isFinite(timeSec)) {
    const v = samples[0];
    return Number.isFinite(v) ? v : 0;
  }

  let u: number;
  if (loop) {
    const wrapped = ((timeSec % durationSec) + durationSec) % durationSec;
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
