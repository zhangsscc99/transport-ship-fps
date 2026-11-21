// Match objective helpers — pure logic shared by main.ts (scoring) and the
// HUD objective bar (formatting). No three.js / DOM.

import type { Match, Phase } from './match';

/** below this many ms of match time the HUD clock turns red and pulses */
export const URGENT_MS = 30_000;

/** match time → "M:SS" (seconds rounded up so kickoff reads 5:00 and only true zero reads 0:00) */
export function formatClock(ms: number): string {
  const totalSec = Math.max(0, Math.ceil((Number.isFinite(ms) ? ms : 0) / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

/** clock is red while under URGENT_MS in a live or finished match (never in menu/countdown) */
export function isClockUrgent(timeLeftMs: number, phase: Phase): boolean {
  return (phase === 'playing' || phase === 'over') && timeLeftMs < URGENT_MS;
}

/** the clock pulses only while it is still running */
export function isClockPulsing(timeLeftMs: number, phase: Phase): boolean {
  return phase === 'playing' && timeLeftMs < URGENT_MS;
}

/**
 * Score the player's death for the enemy team. `killed` must be the return
 * value of the applyDamage() call that just ran: it is true exactly once per
 * life (applyDamage ignores already-dead entities), so a corpse taking more
 * hits can never score twice. match.registerKill already rejects anything
 * outside 'playing'.
 */
export function scorePlayerDeath(match: Match, killed: boolean, now: number): boolean {
  if (!killed || match.phase !== 'playing') return false;
  return match.registerKill('B', now);
}
