// Unified frame-rate-independent tween & easing toolkit for all weapon and
// camera motions (reload, swap, recoil, bob blending, air-wall bump).
// Pure math driven strictly by accumulated delta time (seconds) — zero frame
// counting, zero setTimeout/sleep jumps.

export type EasingFn = (t: number) => number;

export const clamp01 = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const linear: EasingFn = (t) => clamp01(t);

export const easeInCubic: EasingFn = (t) => {
  const u = clamp01(t);
  return u * u * u;
};

export const easeOutCubic: EasingFn = (t) => {
  const u = 1 - clamp01(t);
  return 1 - u * u * u;
};

export const easeInOutCubic: EasingFn = (t) => {
  const u = clamp01(t);
  return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
};

export const easeOutQuad: EasingFn = (t) => {
  const u = clamp01(t);
  return 1 - (1 - u) * (1 - u);
};

export const easeInOutSine: EasingFn = (t) => -(Math.cos(Math.PI * clamp01(t)) - 1) / 2;

/**
 * Overshooting spring-like ease-out (ideal for magazine seating bounce).
 * `s` controls overshoot amplitude (1.70158 ≈ 10% overshoot; 2.2 ≈ 15%).
 */
export function easeOutBack(t: number, s = 1.70158): number {
  const u = clamp01(t) - 1;
  return 1 + (s + 1) * u * u * u + s * u * u;
}

/**
 * Eased 0..1 progress of `elapsed` within time window `[start, end]`.
 * Returns 0 before `start`, 1 after `end`.
 */
export function segment(
  elapsed: number,
  start: number,
  end: number,
  ease: EasingFn = easeInOutCubic,
): number {
  if (end <= start) return elapsed >= end ? 1 : 0;
  return ease(clamp01((elapsed - start) / (end - start)));
}

/**
 * Smooth rise 0→1 on `[start, peak]` followed by fall 1→0 on `[peak, end]`.
 * Guaranteed C0 continuous with zero jumps.
 */
export function pulse(
  elapsed: number,
  start: number,
  peak: number,
  end: number,
  easeIn: EasingFn = easeOutCubic,
  easeOut: EasingFn = easeInOutCubic,
): number {
  if (elapsed <= start || elapsed >= end) return 0;
  if (elapsed <= peak) return segment(elapsed, start, peak, easeIn);
  return 1 - segment(elapsed, peak, end, easeOut);
}

/**
 * Frame-rate-independent exponential damp toward a target scalar.
 * `lambda` is the decay rate (1/s); higher = snappier, never overshoots.
 */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * Math.max(0, dt)));
}

/**
 * Retargetable scalar tween. Starting a new target captures the live value as
 * `from` so interrupting mid-motion never teleports.
 */
export class TweenScalar {
  value: number;
  private from: number;
  private to: number;
  private elapsed = 0;
  private duration = 0;
  private ease: EasingFn = easeInOutCubic;

  constructor(initial = 0) {
    this.value = initial;
    this.from = initial;
    this.to = initial;
  }

  get active(): boolean {
    return this.duration > 0 && this.elapsed < this.duration;
  }

  start(to: number, duration: number, ease: EasingFn = easeInOutCubic): void {
    this.from = this.value;
    this.to = to;
    this.elapsed = 0;
    this.duration = Math.max(0, duration);
    this.ease = ease;
    if (this.duration === 0) this.value = to;
  }

  update(dt: number): number {
    if (this.duration <= 0) return this.value;
    this.elapsed = Math.min(this.duration, this.elapsed + Math.max(0, dt));
    const u = this.elapsed / this.duration;
    this.value = lerp(this.from, this.to, this.ease(u));
    return this.value;
  }

  snap(v: number): void {
    this.value = v;
    this.from = v;
    this.to = v;
    this.elapsed = 0;
    this.duration = 0;
  }
}
