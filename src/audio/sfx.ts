// Procedural WebAudio SFX — zero audio files, everything synthesized.
// Event set and duration caps per docs/ART-SPEC.md §4. The AudioContext
// is created lazily inside the first user gesture (pointerdown/keydown →
// unlock()); play() before that — or while muted — drops silently.
// Per-name concurrency ≤ 6, the oldest voice is stolen. The white-noise
// buffer is generated once and cached.

export type SfxName =
  | 'shotRifle'
  | 'shotGatling'
  | 'reload'
  | 'hit'
  | 'hurt'
  | 'footstep'
  | 'kill'
  | 'alarm';

export interface SfxPlayOpts {
  /** metres to the source; >25 is inaudible (ART-SPEC §4) */
  distance?: number;
  /** 0..1 multiplier on top of distance attenuation */
  volume?: number;
}

export interface Sfx {
  unlock(): Promise<void>;
  play(name: SfxName, opts?: SfxPlayOpts): void;
  setMuted(v: boolean): void;
  readonly muted: boolean;
  readonly unlocked: boolean;
  /** per-event play counts — `shot` aggregates all shot* events */
  readonly counts: Record<string, number>;
}

const MAX_VOICES = 6;
const HEAR_RANGE = 25;
const MUTE_KEY = 'tsf.muted';

interface Voice {
  name: SfxName;
  srcs: AudioScheduledSourceNode[];
  /** sources still running; voice is dropped when this reaches 0 */
  left: number;
}

interface NoiseFilter {
  type: BiquadFilterType;
  f0: number;
  f1?: number;
  q?: number;
}

export function createSfx(): Sfx {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let noiseBuf: AudioBuffer | null = null;
  let isUnlocked = false;
  let mutedFlag = readMuted();
  const live = new Map<SfxName, Voice[]>();
  const counts: Record<string, number> = {
    shot: 0,
    shotRifle: 0,
    shotGatling: 0,
    reload: 0,
    hit: 0,
    hurt: 0,
    footstep: 0,
    kill: 0,
    alarm: 0,
  };

  function readMuted(): boolean {
    try {
      return localStorage.getItem(MUTE_KEY) === '1';
    } catch {
      return false;
    }
  }

  function ensureCtx(): AudioContext {
    if (ctx) return ctx;
    const c = new AudioContext();
    const g = c.createGain();
    g.gain.value = mutedFlag ? 0 : 1;
    g.connect(c.destination);
    master = g;
    ctx = c;
    return c;
  }

  function noise(c: AudioContext): AudioBuffer {
    if (!noiseBuf) {
      noiseBuf = c.createBuffer(1, c.sampleRate, c.sampleRate); // 1s white noise
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    return noiseBuf;
  }

  function reg(v: Voice, s: AudioScheduledSourceNode): void {
    v.srcs.push(s);
    v.left++;
    s.onended = () => {
      if (--v.left !== 0) return;
      const l = live.get(v.name);
      if (!l) return;
      const i = l.indexOf(v);
      if (i >= 0) l.splice(i, 1);
    };
  }

  /** percussive envelope: 6ms attack, exponential decay over `dur` */
  function env(g: GainNode, t0: number, dur: number, peak: number): void {
    const p = g.gain;
    p.setValueAtTime(0.0001, t0);
    p.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t0 + 0.006);
    p.exponentialRampToValueAtTime(0.0001, t0 + dur);
  }

  /** filtered noise burst, optionally sweeping the filter frequency */
  function burst(v: Voice, t0: number, dur: number, peak: number, f: NoiseFilter): void {
    const c = ctx!;
    const s = c.createBufferSource();
    s.buffer = noise(c);
    const flt = c.createBiquadFilter();
    flt.type = f.type;
    flt.frequency.setValueAtTime(f.f0, t0);
    if (f.f1 !== undefined) flt.frequency.exponentialRampToValueAtTime(f.f1, t0 + dur);
    if (f.q !== undefined) flt.Q.value = f.q;
    const g = c.createGain();
    env(g, t0, dur, peak);
    s.connect(flt);
    flt.connect(g);
    g.connect(master!);
    s.start(t0);
    s.stop(t0 + dur + 0.02);
    reg(v, s);
  }

  /** oscillator blip, optionally sweeping f0 → f1 */
  function tone(
    v: Voice,
    type: OscillatorType,
    f0: number,
    f1: number,
    t0: number,
    dur: number,
    peak: number,
  ): void {
    const c = ctx!;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    const g = c.createGain();
    env(g, t0, dur, peak);
    o.connect(g);
    g.connect(master!);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
    reg(v, o);
  }

  /** stop the oldest live voice of `name` to make room for a new one */
  function steal(name: SfxName): void {
    const l = live.get(name);
    const v = l?.shift();
    if (!v) return;
    for (const s of v.srcs) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
  }

  // Recipes — procedural combat sound synthesis (rifle + gatling + hit/hurt/step/reload).
  const RECIPES: Record<SfxName, (v: Voice, t0: number, vol: number) => void> = {
    shotRifle(v, t0, vol) {
      burst(v, t0, 0.1, 0.5 * vol, { type: 'lowpass', f0: 1400, f1: 320 });
      tone(v, 'square', 190, 90, t0, 0.045, 0.1 * vol);
    },
    shotGatling(v, t0, vol) {
      burst(v, t0, 0.065, 0.42 * vol, { type: 'bandpass', f0: 1650, f1: 520, q: 0.9 });
      tone(v, 'sawtooth', 145, 68, t0, 0.045, 0.18 * vol);
      tone(v, 'square', 2400, 1100, t0, 0.018, 0.12 * vol);
    },
    reload(v, t0, vol) {
      tone(v, 'square', 1600, 1600, t0, 0.02, 0.16 * vol);
      tone(v, 'square', 2200, 2200, t0 + 0.085, 0.022, 0.16 * vol);
      burst(v, t0 + 0.085, 0.03, 0.08 * vol, { type: 'highpass', f0: 3200 });
    },
    hit(v, t0, vol) {
      tone(v, 'triangle', 1800, 1700, t0, 0.06, 0.3 * vol);
      burst(v, t0, 0.02, 0.1 * vol, { type: 'highpass', f0: 3400 });
    },
    hurt(v, t0, vol) {
      tone(v, 'sine', 120, 55, t0, 0.13, 0.5 * vol);
      burst(v, t0, 0.1, 0.18 * vol, { type: 'lowpass', f0: 500 });
    },
    footstep(v, t0, vol) {
      burst(v, t0, 0.05, 0.16 * vol, { type: 'bandpass', f0: 520, q: 1.1 });
    },
    kill(v, t0, vol) {
      tone(v, 'triangle', 520, 520, t0, 0.07, 0.28 * vol);
      tone(v, 'triangle', 780, 780, t0 + 0.09, 0.09, 0.28 * vol);
    },
    alarm(v, t0, vol) {
      tone(v, 'sawtooth', 620, 620, t0, 0.16, 0.2 * vol);
      tone(v, 'sawtooth', 470, 470, t0 + 0.22, 0.16, 0.2 * vol);
    },
  };

  async function unlock(): Promise<void> {
    try {
      ensureCtx();
    } catch {
      return; // no WebAudio available — play() stays a no-op
    }
    isUnlocked = true;
    if (ctx!.state !== 'running') {
      try {
        await ctx!.resume();
      } catch {
        /* device-less audio backend: scheduling still works, output is silent */
      }
    }
  }

  function play(name: SfxName, opts?: SfxPlayOpts): void {
    if (!isUnlocked || mutedFlag || !ctx || !master) return;
    const dist = opts?.distance ?? 0;
    if (dist > HEAR_RANGE) return;
    const vol = (opts?.volume ?? 1) * (1 - dist / HEAR_RANGE);
    if (vol <= 0.001) return;
    let list = live.get(name);
    if (!list) {
      list = [];
      live.set(name, list);
    }
    while (list.length >= MAX_VOICES) steal(name);
    const v: Voice = { name, srcs: [], left: 0 };
    list.push(v);
    RECIPES[name](v, ctx.currentTime + 0.001, vol);
    counts[name]++;
    if (name.startsWith('shot')) counts.shot++;
  }

  function setMuted(v: boolean): void {
    mutedFlag = v;
    try {
      localStorage.setItem(MUTE_KEY, v ? '1' : '0');
    } catch {
      /* private mode etc. — mute still applies for the session */
    }
    if (master && ctx) master.gain.setTargetAtTime(v ? 0 : 1, ctx.currentTime, 0.005);
  }

  // Self-unlock on the first real gesture — AudioContext creation must wait
  // for it (autoplay policy). main.ts calls unlock() on the same signal too;
  // both paths are idempotent.
  if (typeof window !== 'undefined') {
    const once = () => void unlock();
    window.addEventListener('pointerdown', once, { once: true, passive: true });
    window.addEventListener('keydown', once, { once: true });
  }

  return {
    unlock,
    play,
    setMuted,
    get muted() {
      return mutedFlag;
    },
    get unlocked() {
      return isUnlocked;
    },
    counts,
  };
}
