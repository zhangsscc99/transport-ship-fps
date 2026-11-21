// Difficulty configuration — pure data, shared by AI enemies, start menu, and death settlement.
// EASY / NORMAL / HARD tuned so the game feels punchy yet fair on mobile & desktop.

export type DifficultyId = 'easy' | 'normal' | 'hard';

export interface DifficultySpec {
  id: DifficultyId;
  label: 'EASY' | 'NORMAL' | 'HARD';
  subLabel: string;
  /** Enemy bullet damage per hit */
  enemyDmg: number;
  /** Base hit probability at close range (<=12m), attenuated with distance */
  hitRate: number;
  /** Reaction delay (ms) between spotting the player and firing the first shot */
  reactionMs: number;
  /** Enemy run/chase movement speed (m/s) */
  moveSpeed: number;
  /** Target squad pool size (EASY 3 / NORMAL 5 / HARD 7) */
  totalEnemies: number;
  /** Max simultaneous live bots on deck (strictly <= 5 for mobile performance) */
  maxSimultaneous: number;
  /** Whether wounded bots (<30% HP) retreat to cover */
  canTakeCover: boolean;
  /** Whether bots coordinate 2-by-2 flanking angles (HARD) */
  flankPairs: boolean;
  /** Replacement spawn delay (ms) after a bot dies */
  respawnDelayMs: number;
}

export const DIFFICULTIES: readonly DifficultySpec[] = [
  {
    id: 'easy',
    label: 'EASY',
    subLabel: '简单',
    enemyDmg: 8,
    hitRate: 0.25,
    reactionMs: 900,
    moveSpeed: 2.0,
    totalEnemies: 3,
    maxSimultaneous: 3,
    canTakeCover: false,
    flankPairs: false,
    respawnDelayMs: 3600,
  },
  {
    id: 'normal',
    label: 'NORMAL',
    subLabel: '普通',
    enemyDmg: 12,
    hitRate: 0.40,
    reactionMs: 600,
    moveSpeed: 2.6,
    totalEnemies: 5,
    maxSimultaneous: 5,
    canTakeCover: true,
    flankPairs: false,
    respawnDelayMs: 3000,
  },
  {
    id: 'hard',
    label: 'HARD',
    subLabel: '困难',
    enemyDmg: 16,
    hitRate: 0.55,
    reactionMs: 350,
    moveSpeed: 3.1,
    totalEnemies: 7,
    maxSimultaneous: 5,
    canTakeCover: true,
    flankPairs: true,
    respawnDelayMs: 1800,
  },
] as const;

export const DIFFICULTY_MAP: Record<DifficultyId, DifficultySpec> = {
  easy: DIFFICULTIES[0],
  normal: DIFFICULTIES[1],
  hard: DIFFICULTIES[2],
};

/** Normalize current or legacy ('recruit'|'veteran'|'elite') difficulty strings. */
export function parseDifficulty(raw: string | null | undefined): DifficultyId {
  if (!raw) return 'normal';
  const k = raw.toLowerCase().trim();
  if (k === 'easy' || k === 'recruit') return 'easy';
  if (k === 'hard' || k === 'elite') return 'hard';
  return 'normal';
}

export function getDifficultySpec(id: DifficultyId): DifficultySpec {
  return DIFFICULTY_MAP[id] ?? DIFFICULTY_MAP.normal;
}
