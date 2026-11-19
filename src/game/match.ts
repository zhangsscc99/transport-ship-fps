// Match state machine — pure logic, no three.js / DOM.
// Phases: menu → countdown → playing → over  (docs/SPEC.md §一局是什么样).
// Win: first team to `teamKillsToWin` kills, or the higher score when
// `durationMs` elapses (tie → 'draw'). All transitions run off an injected
// `now` (ms): tick() only compares absolute timestamps, so calling it every
// frame never accumulates drift. Per-entity respawn timing stays in
// entities.ts (RESPAWN_MS) — a kill feeds registerKill(), the victim's
// respawn is handled by damage.updateRespawn().

export type Phase = 'menu' | 'countdown' | 'playing' | 'over';
export type Team = 'A' | 'B';
export type Winner = Team | 'draw' | null;

export interface MatchOptions {
  teamKillsToWin?: number;
  durationMs?: number;
  countdownMs?: number;
}

export interface Match {
  readonly phase: Phase;
  readonly killsA: number;
  readonly killsB: number;
  readonly winner: Winner;
  /** ms of match time remaining; full duration before kickoff, freezes on 'over' */
  readonly timeLeftMs: number;
  /** ms left in the pre-match countdown (0 outside 'countdown') */
  readonly countdownLeftMs: number;
  /** menu → countdown; from 'over' it resets the counters and runs countdown again */
  start(now: number): void;
  /** drive phase transitions; safe to call every frame at any now */
  tick(now: number): Phase;
  /** record a kill for team 'A'|'B'; returns false unless phase is 'playing' */
  registerKill(team: Team, now: number): boolean;
  /** the player may move/fire during countdown and playing — never in menu or over */
  canAct(now: number): boolean;
}

export function createMatch(opts: MatchOptions = {}): Match {
  const killsToWin = opts.teamKillsToWin ?? 25;
  const duration = opts.durationMs ?? 5 * 60_000;
  const countdownLen = opts.countdownMs ?? 3_000;

  let phase: Phase = 'menu';
  let killsA = 0;
  let killsB = 0;
  let winner: Winner = null;
  let countdownStart = 0;
  let playStart = 0;
  let lastNow = 0;
  let timeLeft = duration;

  const judge = (): Winner => (killsA > killsB ? 'A' : killsB > killsA ? 'B' : 'draw');
  const finish = (): void => {
    phase = 'over';
    winner = judge();
  };

  return {
    get phase() {
      return phase;
    },
    get killsA() {
      return killsA;
    },
    get killsB() {
      return killsB;
    },
    get winner() {
      return winner;
    },
    get timeLeftMs() {
      return timeLeft;
    },
    get countdownLeftMs() {
      return phase === 'countdown'
        ? Math.max(0, countdownLen - (lastNow - countdownStart))
        : 0;
    },

    start(now: number): void {
      if (phase !== 'menu' && phase !== 'over') return;
      phase = 'countdown';
      countdownStart = now;
      lastNow = now;
      killsA = 0;
      killsB = 0;
      winner = null;
      timeLeft = duration;
    },

    tick(now: number): Phase {
      lastNow = now;
      if (phase === 'countdown' && now - countdownStart >= countdownLen) {
        phase = 'playing';
        playStart = countdownStart + countdownLen;
      }
      if (phase === 'playing') {
        timeLeft = Math.max(0, duration - (now - playStart));
        if (timeLeft === 0 || killsA >= killsToWin || killsB >= killsToWin) finish();
      }
      return phase;
    },

    registerKill(team: Team, now: number): boolean {
      if (phase !== 'playing') return false;
      lastNow = now;
      if (team === 'A') killsA++;
      else killsB++;
      if (killsA >= killsToWin || killsB >= killsToWin) {
        timeLeft = Math.max(0, duration - (now - playStart));
        finish();
      }
      return true;
    },

    canAct(): boolean {
      return phase === 'countdown' || phase === 'playing';
    },
  };
}
