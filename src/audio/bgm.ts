// Dual-track looping BGM controller using real HTMLAudioElements:
//   - Menu track:   /audio/bgm-menu.mp3    (Five Armies, loop, target volume 0.50)
//   - Battle track: /audio/bgm-tension.mp3 (Volatile Reaction, loop, target volume 0.35,
//                   ducks to 0.20 while firing, recovers smoothly over 0.30s)
//   - Crossfade between menu & battle over 1.2s
//   - Strictly respects browser autoplay policy (plays only after first user gesture)
//   - User can toggle music ON/OFF in menu settings (default ON, persisted in tsf.music)
//
// Music credit: Kevin MacLeod (incompetech.com) — CC BY 4.0

export type BgmTrack = 'menu' | 'battle';

export interface BgmTelemetry {
  unlocked: boolean;
  track: BgmTrack;
  enabled: boolean;
  muted: boolean;
  menuPaused: boolean;
  battlePaused: boolean;
  menuVolume: number;
  battleVolume: number;
}

const MENU_VOL = 0.50;
const BATTLE_VOL = 0.35;
const BATTLE_DUCK_VOL = 0.20;
const CROSSFADE_SEC = 1.2;
const DUCK_HOLD_SEC = 0.12;
const DUCK_RECOVER_SEC = 0.30;
const MUSIC_KEY = 'tsf.music';

export class BgmController {
  readonly menuEl: HTMLAudioElement;
  readonly battleEl: HTMLAudioElement;
  readonly telemetry: BgmTelemetry;

  private unlocked = false;
  private activeTrack: BgmTrack = 'menu';
  private enabled = true;
  private muted = false;
  /** Crossfade mix: 0 = 100% menu, 1 = 100% battle */
  private mix = 0;
  /** Smoothly fades master BGM in after unlock */
  private masterEnv = 0;
  /** Ducking state [0 = normal 0.35, 1 = ducked 0.20] */
  private duckAmount = 0;
  private sinceFireSec = 10;

  constructor(parent: HTMLElement = document.body) {
    const base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/transport/';
    this.enabled = this.readEnabled();

    this.menuEl = document.createElement('audio');
    this.menuEl.dataset.bgm = 'menu';
    this.menuEl.src = `${base}audio/bgm-menu.mp3`;
    this.menuEl.loop = true;
    this.menuEl.preload = 'auto';
    this.menuEl.volume = 0;
    this.menuEl.style.display = 'none';

    this.battleEl = document.createElement('audio');
    this.battleEl.dataset.bgm = 'battle';
    this.battleEl.src = `${base}audio/bgm-tension.mp3`;
    this.battleEl.loop = true;
    this.battleEl.preload = 'auto';
    this.battleEl.volume = 0;
    this.battleEl.style.display = 'none';

    parent.append(this.menuEl, this.battleEl);

    this.telemetry = {
      unlocked: false,
      track: this.activeTrack,
      enabled: this.enabled,
      muted: this.muted,
      menuPaused: true,
      battlePaused: true,
      menuVolume: 0,
      battleVolume: 0,
    };

    if (typeof window !== 'undefined') {
      const once = () => this.unlock();
      window.addEventListener('pointerdown', once, { once: true, capture: true, passive: true });
      window.addEventListener('keydown', once, { once: true, capture: true });
      window.addEventListener('click', once, { once: true, capture: true, passive: true });
    }
  }

  private readEnabled(): boolean {
    try {
      const v = localStorage.getItem(MUSIC_KEY);
      return v === null ? true : v !== '0';
    } catch {
      return true;
    }
  }

  /** Unlock BGM on first real user gesture & start active track immediately. */
  unlock(): void {
    this.unlocked = true;
    this.telemetry.unlocked = true;
    if (!this.enabled || this.muted) return;
    const el = this.activeTrack === 'battle' ? this.battleEl : this.menuEl;
    // Start audible immediately on first gesture and ramp smoothly to full target
    if (this.masterEnv < 0.2) this.masterEnv = 0.2;
    this.applyVolumes();
    this.safePlay(el);
  }

  /** Crossfade to 'menu' or 'battle' over 1.2s. */
  setTrack(track: BgmTrack): void {
    const changed = this.activeTrack !== track;
    this.activeTrack = track;
    this.telemetry.track = track;
    if (!this.unlocked) {
      // Snap mix so when first click happens right on Start Game, battle starts cleanly
      this.mix = track === 'battle' ? 1 : 0;
      return;
    }
    if (!this.enabled || this.muted) return;
    const targetEl = track === 'battle' ? this.battleEl : this.menuEl;
    if (changed || targetEl.paused) {
      this.safePlay(targetEl);
    }
  }

  /** Called on every player gunshot to duck battle BGM (0.35 -> 0.20, 0.3s recovery). */
  notifyFire(): void {
    this.sinceFireSec = 0;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.telemetry.enabled = on;
    try {
      localStorage.setItem(MUSIC_KEY, on ? '1' : '0');
    } catch {
      /* ignore storage errors */
    }
    this.syncPlaybackState();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.telemetry.muted = m;
    this.syncPlaybackState();
  }

  private syncPlaybackState(): void {
    if (!this.enabled || this.muted) {
      this.menuEl.volume = 0;
      this.battleEl.volume = 0;
      this.menuEl.pause();
      this.battleEl.pause();
      this.syncTelemetry();
      return;
    }
    if (this.unlocked) {
      const targetEl = this.activeTrack === 'battle' ? this.battleEl : this.menuEl;
      this.safePlay(targetEl);
    }
  }

  private safePlay(el: HTMLAudioElement): void {
    try {
      const p = el.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* headless / autoplay edge case */
    }
  }

  update(dt: number): void {
    if (!this.unlocked || !this.enabled || this.muted) {
      this.syncTelemetry();
      return;
    }

    // Gentle fade-in on initial unlock
    this.masterEnv = Math.min(1, this.masterEnv + dt / 0.6);

    // 1.2s linear crossfade between menu (0) and battle (1)
    const targetMix = this.activeTrack === 'battle' ? 1 : 0;
    const step = dt / CROSSFADE_SEC;
    if (this.mix < targetMix) this.mix = Math.min(targetMix, this.mix + step);
    else if (this.mix > targetMix) this.mix = Math.max(targetMix, this.mix - step);

    // Combat firing ducking: fast dip to 0.20 on fire, smooth 0.30s recovery back to 0.35
    this.sinceFireSec += dt;
    if (this.sinceFireSec <= DUCK_HOLD_SEC) {
      this.duckAmount = Math.min(1, this.duckAmount + dt / 0.04);
    } else {
      this.duckAmount = Math.max(0, this.duckAmount - dt / DUCK_RECOVER_SEC);
    }

    this.applyVolumes();

    // Pause fully faded-out track to save decode CPU
    if (this.mix >= 0.999 && !this.menuEl.paused) this.menuEl.pause();
    if (this.mix <= 0.001 && !this.battleEl.paused) this.battleEl.pause();

    this.syncTelemetry();
  }

  private applyVolumes(): void {
    const battleTarget = BATTLE_VOL + (BATTLE_DUCK_VOL - BATTLE_VOL) * this.duckAmount;
    const mv = Math.max(0, Math.min(1, MENU_VOL * (1 - this.mix) * this.masterEnv));
    const bv = Math.max(0, Math.min(1, battleTarget * this.mix * this.masterEnv));
    this.menuEl.volume = mv;
    this.battleEl.volume = bv;
  }

  private syncTelemetry(): void {
    this.telemetry.menuPaused = this.menuEl.paused;
    this.telemetry.battlePaused = this.battleEl.paused;
    this.telemetry.menuVolume = this.menuEl.volume;
    this.telemetry.battleVolume = this.battleEl.volume;
  }
}
