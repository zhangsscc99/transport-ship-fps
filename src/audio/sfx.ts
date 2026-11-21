// Procedural WebAudio SFX — zero external SFX files, everything synthesized.
//   - Rifle: 3-layer shot (crack burst + low-frequency body punch + deck tail echo)
//   - Gatling: continuous looping rotary motor/roar + crisp per-round metallic snap
//   - Enemy gunshot: distance-attenuated up to 60m + left/right StereoPanner positioning
//   - Footsteps: metal deck clank vs wooden crate hollow thud
//   - Shell casing bounce clink, multi-stage reload mechanical sounds
//   - Hit feedback: crisp "叮" (body) / brighter harmonic "叮!" (headshot)
//   - Player hurt: muffled thud + low-HP heartbeat pulse
//
// AudioContext is lazily created inside the first user gesture (autoplay policy).

export type SfxName =
  | 'shotRifle'
  | 'shotGatling'
  | 'shotEnemy'
  | 'reload'
  | 'reloadMagOut'
  | 'reloadMagIn'
  | 'reloadBolt'
  | 'hit'
  | 'headshot'
  | 'hurt'
  | 'heartbeat'
  | 'footstep'
  | 'footstepMetal'
  | 'footstepWood'
  | 'shellClink'
  | 'kill'
  | 'death'
  | 'alarm';

export interface SfxPlayOpts {
  /** metres to the source; default hearing cap 25m (60m for enemy gunshots) */
  distance?: number;
  /** override hearing range (metres) */
  maxRange?: number;
  /** stereo pan [-1 (left) .. +1 (right)] via StereoPannerNode */
  pan?: number;
  /** 0..1 multiplier on top of distance attenuation */
  volume?: number;
}

export interface Sfx {
  unlock(): Promise<void>;
  play(name: SfxName, opts?: SfxPlayOpts): void;
  /** Drive the continuous looping Gatling motor hum & firing roar. */
  setGatlingMotor(spinLevel: number, firing: boolean): void;
  setMuted(v: boolean): void;
  readonly muted: boolean;
  readonly unlocked: boolean;
  /** per-event play counts — `shot` aggregates all shot* events */
  readonly counts: Record<string, number>;
}

const MAX_VOICES = 8;
const DEFAULT_HEAR_RANGE = 25;
const MUTE_KEY = 'tsf.muted';

interface Voice {
  name: SfxName;
  srcs: AudioScheduledSourceNode[];
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

  // Persistent Gatling rotary motor loop nodes (lazy initialized on unlock)
  let gatOsc: OscillatorNode | null = null;
  let gatSubOsc: OscillatorNode | null = null;
  let gatNoise: AudioBufferSourceNode | null = null;
  let gatFilter: BiquadFilterNode | null = null;
  let gatGain: GainNode | null = null;

  const live = new Map<SfxName, Voice[]>();
  const counts: Record<string, number> = {
    shot: 0,
    shotRifle: 0,
    shotGatling: 0,
    shotEnemy: 0,
    reload: 0,
    reloadMagOut: 0,
    reloadMagIn: 0,
    reloadBolt: 0,
    hit: 0,
    headshot: 0,
    hurt: 0,
    heartbeat: 0,
    footstep: 0,
    footstepMetal: 0,
    footstepWood: 0,
    shellClink: 0,
    kill: 0,
    death: 0,
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
      noiseBuf = c.createBuffer(1, c.sampleRate, c.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    return noiseBuf;
  }

  function ensureGatlingLoop(): void {
    if (gatGain || !ctx || !master) return;
    try {
      const c = ctx;
      const gain = c.createGain();
      gain.gain.value = 0;
      const flt = c.createBiquadFilter();
      flt.type = 'lowpass';
      flt.frequency.value = 220;
      flt.Q.value = 1.6;

      const osc = c.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = 54;
      const sub = c.createOscillator();
      sub.type = 'triangle';
      sub.frequency.value = 28;
      const subG = c.createGain();
      subG.gain.value = 0.55;

      const ns = c.createBufferSource();
      ns.buffer = noise(c);
      ns.loop = true;
      const nsG = c.createGain();
      nsG.gain.value = 0.42;

      osc.connect(flt);
      sub.connect(subG);
      subG.connect(flt);
      ns.connect(nsG);
      nsG.connect(flt);
      flt.connect(gain);
      gain.connect(master);

      osc.start();
      sub.start();
      ns.start();
      gatOsc = osc;
      gatSubOsc = sub;
      gatNoise = ns;
      gatFilter = flt;
      gatGain = gain;
    } catch {
      /* ignore if WebAudio backend unavailable */
    }
  }

  function makeDest(pan?: number): AudioNode {
    if (!ctx || !master) return master!;
    if (pan !== undefined && Math.abs(pan) > 0.01 && typeof ctx.createStereoPanner === 'function') {
      const sp = ctx.createStereoPanner();
      sp.pan.value = Math.max(-1, Math.min(1, pan));
      sp.connect(master);
      return sp;
    }
    return master;
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

  function env(g: GainNode, t0: number, dur: number, peak: number, attack = 0.005): void {
    const p = g.gain;
    p.setValueAtTime(0.0001, t0);
    p.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t0 + attack);
    p.exponentialRampToValueAtTime(0.0001, t0 + Math.max(attack + 0.005, dur));
  }

  function burst(
    v: Voice,
    dest: AudioNode,
    t0: number,
    dur: number,
    peak: number,
    f: NoiseFilter,
    attack = 0.004,
  ): void {
    const c = ctx!;
    const s = c.createBufferSource();
    s.buffer = noise(c);
    const flt = c.createBiquadFilter();
    flt.type = f.type;
    flt.frequency.setValueAtTime(f.f0, t0);
    if (f.f1 !== undefined) flt.frequency.exponentialRampToValueAtTime(f.f1, t0 + dur);
    if (f.q !== undefined) flt.Q.value = f.q;
    const g = c.createGain();
    env(g, t0, dur, peak, attack);
    s.connect(flt);
    flt.connect(g);
    g.connect(dest);
    s.start(t0);
    s.stop(t0 + dur + 0.02);
    reg(v, s);
  }

  function tone(
    v: Voice,
    dest: AudioNode,
    type: OscillatorType,
    f0: number,
    f1: number,
    t0: number,
    dur: number,
    peak: number,
    attack = 0.004,
  ): void {
    const c = ctx!;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    const g = c.createGain();
    env(g, t0, dur, peak, attack);
    o.connect(g);
    g.connect(dest);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
    reg(v, o);
  }

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

  const RECIPES: Record<SfxName, (v: Voice, dest: AudioNode, t0: number, vol: number) => void> = {
    // 3-layer Assault Rifle shot: (1) supersonic crack + (2) low body punch + (3) ship-deck echo tail
    shotRifle(v, d, t0, vol) {
      // Layer 1: crisp supersonic crack burst
      burst(v, d, t0, 0.032, 0.52 * vol, { type: 'bandpass', f0: 2900, f1: 1100, q: 0.7 }, 0.002);
      // Layer 2: low-frequency chest body punch
      burst(v, d, t0, 0.105, 0.48 * vol, { type: 'lowpass', f0: 920, f1: 210 });
      tone(v, d, 'triangle', 175, 48, t0, 0.075, 0.28 * vol);
      // Layer 3: metallic container-deck reflection tail echo
      burst(v, d, t0 + 0.055, 0.11, 0.14 * vol, { type: 'bandpass', f0: 1150, f1: 420, q: 1.2 }, 0.012);
      burst(v, d, t0 + 0.125, 0.13, 0.07 * vol, { type: 'lowpass', f0: 680, f1: 240 }, 0.015);
    },
    // Gatling per-round metallic snap (layered on top of continuous looping rotary motor roar!)
    shotGatling(v, d, t0, vol) {
      burst(v, d, t0, 0.055, 0.36 * vol, { type: 'bandpass', f0: 2100, f1: 620, q: 0.9 }, 0.002);
      tone(v, d, 'sawtooth', 148, 62, t0, 0.042, 0.22 * vol, 0.002);
      // Distinct rapid metallic rotary bolt clack per bullet
      tone(v, d, 'square', 2850, 1320, t0, 0.016, 0.14 * vol, 0.001);
    },
    // Spatialized enemy rifle report (attenuated across 60m + StereoPanner)
    shotEnemy(v, d, t0, vol) {
      burst(v, d, t0, 0.09, 0.44 * vol, { type: 'lowpass', f0: 1650, f1: 360 });
      tone(v, d, 'square', 165, 72, t0, 0.05, 0.14 * vol);
      burst(v, d, t0 + 0.06, 0.11, 0.11 * vol, { type: 'bandpass', f0: 880, q: 1.0 }, 0.01);
    },
    // Reload mechanical sounds
    reload(v, d, t0, vol) {
      tone(v, d, 'square', 1500, 1200, t0, 0.022, 0.16 * vol);
      burst(v, d, t0 + 0.012, 0.028, 0.10 * vol, { type: 'highpass', f0: 2800 });
    },
    reloadMagOut(v, d, t0, vol) {
      tone(v, d, 'square', 1200, 740, t0, 0.032, 0.18 * vol);
      burst(v, d, t0 + 0.01, 0.045, 0.14 * vol, { type: 'bandpass', f0: 1900, f1: 900, q: 1.4 });
    },
    reloadMagIn(v, d, t0, vol) {
      tone(v, d, 'triangle', 260, 110, t0, 0.048, 0.28 * vol);
      tone(v, d, 'square', 2100, 1650, t0 + 0.018, 0.024, 0.18 * vol);
      burst(v, d, t0 + 0.015, 0.032, 0.12 * vol, { type: 'highpass', f0: 3000 });
    },
    reloadBolt(v, d, t0, vol) {
      burst(v, d, t0, 0.055, 0.18 * vol, { type: 'bandpass', f0: 2600, f1: 1400, q: 1.8 });
      tone(v, d, 'square', 2400, 1800, t0 + 0.045, 0.025, 0.20 * vol);
    },
    // Crisp "叮" hit confirmation
    hit(v, d, t0, vol) {
      tone(v, d, 'triangle', 1980, 1920, t0, 0.075, 0.34 * vol, 0.002);
      burst(v, d, t0, 0.018, 0.11 * vol, { type: 'highpass', f0: 3600 }, 0.001);
    },
    // Brighter dual-harmonic "叮!" headshot confirmation
    headshot(v, d, t0, vol) {
      tone(v, d, 'sine', 2680, 2600, t0, 0.11, 0.40 * vol, 0.002);
      tone(v, d, 'triangle', 4020, 3860, t0 + 0.005, 0.09, 0.24 * vol, 0.002);
      burst(v, d, t0, 0.022, 0.14 * vol, { type: 'highpass', f0: 4200 }, 0.001);
    },
    // Player hurt: deep muffled thud + immediate heartbeat thump
    hurt(v, d, t0, vol) {
      tone(v, d, 'sine', 118, 42, t0, 0.14, 0.56 * vol);
      burst(v, d, t0, 0.10, 0.22 * vol, { type: 'lowpass', f0: 460 });
      tone(v, d, 'sine', 64, 46, t0 + 0.09, 0.12, 0.32 * vol, 0.012);
    },
    // Low-HP double heartbeat pulse (lub-dub)
    heartbeat(v, d, t0, vol) {
      tone(v, d, 'sine', 64, 44, t0, 0.11, 0.36 * vol, 0.012);
      tone(v, d, 'sine', 54, 38, t0 + 0.165, 0.13, 0.28 * vol, 0.012);
    },
    // Footsteps: metallic ship deck vs hollow wooden crate
    footstep(v, d, t0, vol) {
      RECIPES.footstepMetal(v, d, t0, vol);
    },
    footstepMetal(v, d, t0, vol) {
      burst(v, d, t0, 0.045, 0.16 * vol, { type: 'bandpass', f0: 880, q: 1.8 });
      tone(v, d, 'triangle', 170, 95, t0, 0.035, 0.11 * vol);
    },
    footstepWood(v, d, t0, vol) {
      tone(v, d, 'sine', 240, 115, t0, 0.055, 0.22 * vol);
      burst(v, d, t0, 0.04, 0.12 * vol, { type: 'lowpass', f0: 620 });
    },
    // Brass shell casing landing metallic tink
    shellClink(v, d, t0, vol) {
      const pitch = 4100 + Math.random() * 900;
      tone(v, d, 'sine', pitch, pitch * 0.96, t0, 0.042, 0.08 * vol, 0.001);
      tone(v, d, 'triangle', pitch * 1.48, pitch * 1.42, t0 + 0.004, 0.030, 0.045 * vol, 0.001);
    },
    kill(v, d, t0, vol) {
      tone(v, d, 'triangle', 540, 540, t0, 0.07, 0.28 * vol);
      tone(v, d, 'triangle', 810, 810, t0 + 0.085, 0.095, 0.30 * vol);
    },
    death(v, d, t0, vol) {
      tone(v, d, 'sine', 110, 32, t0, 0.45, 0.55 * vol, 0.01);
      burst(v, d, t0, 0.28, 0.22 * vol, { type: 'lowpass', f0: 360, f1: 120 });
    },
    alarm(v, d, t0, vol) {
      tone(v, d, 'sawtooth', 620, 620, t0, 0.16, 0.2 * vol);
      tone(v, d, 'sawtooth', 470, 470, t0 + 0.22, 0.16, 0.2 * vol);
    },
  };

  async function unlock(): Promise<void> {
    try {
      ensureCtx();
      ensureGatlingLoop();
    } catch {
      return;
    }
    isUnlocked = true;
    if (ctx!.state !== 'running') {
      try {
        await ctx!.resume();
      } catch {
        /* device-less audio backend */
      }
    }
  }

  function play(name: SfxName, opts?: SfxPlayOpts): void {
    if (!isUnlocked || mutedFlag || !ctx || !master) return;
    const dist = opts?.distance ?? 0;
    const range = opts?.maxRange ?? (name === 'shotEnemy' ? 60 : DEFAULT_HEAR_RANGE);
    if (dist > range) return;
    const atten = Math.max(0, 1 - dist / range);
    // Smooth perceptual curve so mid-range shots remain audible
    const vol = (opts?.volume ?? 1) * (atten * atten * 0.5 + atten * 0.5);
    if (vol <= 0.002) return;
    let list = live.get(name);
    if (!list) {
      list = [];
      live.set(name, list);
    }
    while (list.length >= MAX_VOICES) steal(name);
    const v: Voice = { name, srcs: [], left: 0 };
    list.push(v);
    const dest = makeDest(opts?.pan);
    RECIPES[name](v, dest, ctx.currentTime + 0.001, vol);
    counts[name] = (counts[name] ?? 0) + 1;
    if (name.startsWith('shot')) counts.shot++;
    if (name.startsWith('footstep')) counts.footstep++;
  }

  function setGatlingMotor(spinLevel: number, firing: boolean): void {
    if (!isUnlocked || !ctx || !gatGain || !gatOsc || !gatSubOsc || !gatFilter) return;
    const s = mutedFlag ? 0 : Math.max(0, Math.min(1, spinLevel));
    const now = ctx.currentTime;
    const targetGain = s <= 0.02 ? 0 : (0.04 + s * 0.14 + (firing ? 0.10 : 0));
    const targetFreq = 48 + s * 78 + (firing ? 24 : 0);
    const targetCut = 180 + s * 360 + (firing ? 280 : 0);
    gatGain.gain.setTargetAtTime(targetGain, now, 0.03);
    gatOsc.frequency.setTargetAtTime(targetFreq, now, 0.03);
    gatSubOsc.frequency.setTargetAtTime(targetFreq * 0.5, now, 0.03);
    gatFilter.frequency.setTargetAtTime(targetCut, now, 0.03);
  }

  function setMuted(v: boolean): void {
    mutedFlag = v;
    try {
      localStorage.setItem(MUTE_KEY, v ? '1' : '0');
    } catch {
      /* private mode */
    }
    if (master && ctx) master.gain.setTargetAtTime(v ? 0 : 1, ctx.currentTime, 0.005);
    if (v && gatGain && ctx) gatGain.gain.setTargetAtTime(0, ctx.currentTime, 0.01);
  }

  if (typeof window !== 'undefined') {
    const once = () => void unlock();
    window.addEventListener('pointerdown', once, { once: true, passive: true });
    window.addEventListener('keydown', once, { once: true });
  }

  return {
    unlock,
    play,
    setGatlingMotor,
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
