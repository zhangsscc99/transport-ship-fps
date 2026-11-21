// CF-style AI enemy state machine — pure logic, zero three.js / DOM.
// Uses preset deck waypoints + raycast line-of-sight & whisker avoidance (no navmesh).
//
// States & strict glTF clip mapping:
//   IDLE   -> idle_rifle    (0 m/s)
//   PATROL -> walk_rifle    (1.4 m/s)
//   ALERT  -> aim_rifle     (0 m/s, 0.6s hold on NORMAL / sound alerts)
//   CHASE  -> run_rifle     (3.0 m/s scaled by difficulty)
//   ENGAGE -> aim_rifle loop + fire_rifle every 0.9s (0.35s clip, hit check at 0.18s)
//   RELOAD -> reload_rifle  (2.2s, no firing during reload)
//   COVER  -> crouch_rifle  (1.2 m/s lateral cover movement)
//   HIT    -> hit           (0.25s transient overlay, does not interrupt movement)
//   DEAD   -> die           (clamped on last frame, 2.5s later fades out in renderer)
//
// Strict rules:
//   - Never shoots through walls (raycast LOS re-verified at the 0.18s hit moment).
//   - Simultaneous cap <= 5 enemies on deck; dead enemies replenish (EASY 3 / NORMAL 5 / HARD 7 pool).
//   - Never spawns within 15m of player / player spawn.
//   - Maintains >= 1.5m pairwise spacing between all live enemies.

import { createEntity, type Entity } from './entities';
import { rayBoxT } from './damage';
import type { Box, Vec2 } from './map';
import type { CollisionWorld } from './collision';
import type { Vec3 } from './player';
import { getDifficultySpec, type DifficultyId, type DifficultySpec } from './difficulty';

export type Faction = 'bl' | 'gr'; // bl = 潜伏者 (Black List), gr = 保卫者 (Global Risk)

export type AiState =
  | 'IDLE'
  | 'PATROL'
  | 'ALERT'
  | 'CHASE'
  | 'ENGAGE'
  | 'RELOAD'
  | 'COVER'
  | 'DEAD';

export type EnemyClip =
  | 'idle_rifle'
  | 'walk_rifle'
  | 'run_rifle'
  | 'aim_rifle'
  | 'fire_rifle'
  | 'reload_rifle'
  | 'crouch_rifle'
  | 'hit'
  | 'die';

/** Backward-compatible alias for clip name type. */
export type EnemyAnim = EnemyClip;

export interface EnemyShotEvent {
  botId: string;
  faction: Faction;
  origin: Vec3;
  target: Vec3;
  hit: boolean;
  damage: number;
  dist: number;
}

export interface EnemyBot {
  id: string;
  slotIndex: number;
  faction: Faction;
  entity: Entity;
  state: AiState;
  yaw: number;
  /** horizontal velocity (m/s) */
  speed: number;
  ammo: number;
  mag: number;
  shotsFired: number;
  reloadingUntil: number;
  /** current patrol waypoint index */
  waypointIdx: number;
  /** state timer (ms timestamp) */
  stateUntil: number;
  /** timestamp when bot first acquired continuous LOS to player (-1 if none) */
  sightAcquiredAt: number;
  /** timestamp of first shot hit-check after spotting player (-1 if none yet) */
  firstShotAt: number;
  /** timestamp of first sight ever (for e2e reaction-delay verification) */
  firstSightAt: number;
  /** whether bot currently has unobstructed raycast LOS to player */
  hasLos: boolean;
  /** last known player position */
  lastSeenPos: Vec3 | null;
  lastSeenAt: number;
  /** ENGAGE fire_rifle animation & delayed 0.18s hit-check timing */
  fireAnimStartAt: number;
  fireAnimEndAt: number;
  fireHitAt: number;
  fireHitPending: boolean;
  nextFireCycleAt: number;
  /** strafe / flank side (+1 or -1) */
  flankSign: 1 | -1;
  strafeSwitchAt: number;
  /** cover target while in COVER state */
  coverTarget: Vec2 | null;
  /** animation timestamps (ms) */
  lastFireAt: number;
  lastHitAt: number;
  diedAt: number;
  /** corpse replacement timer (ms) */
  replaceAt: number;
  /** derived glTF animation clip name */
  anim: EnemyClip;
  /** walk stride phase (radians) */
  walkPhase: number;
}

export const BOT_RADIUS = 0.38;
export const BOT_HEIGHT = 1.8;
export const BOT_EYE_Y = 1.56;
export const BOT_MAG = 30;
export const BOT_RELOAD_MS = 2200; // exact reload_rifle duration (2.2s)
export const PATROL_SPEED = 1.4; // PATROL -> walk_rifle (1.4 m/s)
export const COVER_SPEED = 1.2; // COVER -> crouch_rifle lateral movement (1.2 m/s)
export const ALERT_HOLD_MS = 600; // ALERT -> aim_rifle (0.6s hold)
export const ENGAGE_FIRE_INTERVAL_MS = 900; // ENGAGE -> fire_rifle every 0.9s
export const FIRE_ANIM_MS = 350; // fire_rifle plays 0.35s then returns to aim_rifle
export const FIRE_HIT_DELAY_MS = 180; // hit判定 generated at 0.18s into fire_rifle
export const HIT_ANIM_MS = 250; // hit clip plays 0.25s without interrupting movement
export const BOT_TURN_RATE = 8.0; // model yaw interpolation speed (8 rad/s)
export const MIN_PLAYER_SPAWN_DIST = 15.0; // never spawn within 15m of player / player spawn
export const MIN_BOT_SEPARATION = 1.5; // enemies maintain >= 1.5m pairwise distance

export const VISION_FOV_DEG = 100;
export const VISION_COS_HALF = Math.cos(((VISION_FOV_DEG * 0.5) * Math.PI) / 180); // cos(50°)
export const VISION_RANGE = 40;
export const HEAR_SHOT_RANGE = 60;
export const HEAR_STEP_RANGE = 12;
export const ENGAGE_MIN_DIST = 8;
export const ENGAGE_MAX_DIST = 16;

/** Verified open-deck patrol waypoints on the 64×40m transport ship (all clear of boxes). */
export const PATROL_WAYPOINTS: readonly Vec2[] = [
  { x: -16, z: -15.5 }, // 0: NW deck
  { x: -4, z: -15.5 },  // 1: N-mid-W
  { x: 6, z: -15.5 },   // 2: N-mid-E
  { x: 18, z: -15.5 },  // 3: NE deck
  { x: -20, z: -7.5 },  // 4: W upper lane
  { x: -8, z: -8.0 },   // 5: mid-NW alley
  { x: 0, z: -7.5 },    // 6: center north
  { x: 18, z: -7.5 },   // 7: E upper lane
  { x: -21, z: 0 },     // 8: W flank mid
  { x: -11, z: 0 },     // 9: W mid deck
  { x: 0, z: 0 },       // 10: ship center
  { x: 11, z: 0 },      // 11: E mid deck
  { x: 21, z: 0 },      // 12: E flank mid
  { x: -18, z: 7.5 },   // 13: W lower lane
  { x: 0, z: 7.5 },     // 14: center south
  { x: 8, z: 8.0 },     // 15: mid-SE alley
  { x: 19, z: 7.5 },    // 16: E lower lane
  { x: -16, z: 15.5 },  // 17: SW deck
  { x: 14, z: 15.5 },   // 18: SE deck
];

/** Connected waypoint adjacency graph for smooth deck patrolling without navmesh. */
const WP_NEIGHBORS: readonly (readonly number[])[] = [
  [1, 4],           // 0
  [0, 2, 5, 6],     // 1
  [1, 3, 6],        // 2
  [2, 7],           // 3
  [0, 5, 8],        // 4
  [1, 4, 6, 9],     // 5
  [1, 2, 5, 10],    // 6
  [3, 12],          // 7
  [4, 9, 13],       // 8
  [5, 8, 10],       // 9
  [6, 9, 11, 14],   // 10
  [10, 12, 15],     // 11
  [7, 11, 16],      // 12
  [8, 17],          // 13
  [10, 15],         // 14
  [11, 14, 16, 18], // 15
  [12, 15, 18],     // 16
  [13],             // 17
  [15, 16],         // 18
];

/** Tactical cover positions tucked alongside deck containers (all verified box-free). */
export const COVER_SPOTS: readonly Vec2[] = [
  { x: -6, z: -6.8 },   // north behind container (-6,-4)
  { x: -6, z: -1.4 },   // south behind container (-6,-4)
  { x: 6, z: 1.4 },     // north behind container (6,4)
  { x: 6, z: 6.8 },     // south behind container (6,4)
  { x: -18.8, z: 2 },   // west behind container (-16,2)
  { x: -13.2, z: 2 },   // east behind container (-16,2)
  { x: 18.8, z: -2 },   // east behind container (16,-2)
  { x: 13.2, z: -2 },   // west behind container (16,-2)
  { x: 4, z: -13.8 },   // north behind container (4,-11)
  { x: 12, z: -13.8 },  // north behind container (12,-11)
  { x: -12, z: 13.8 },  // south behind container (-12,11)
  { x: -4, z: 13.8 },   // south behind container (-4,11)
];

/** Primary north-deck enemy spawns (all > 26m from Team A spawn at z=+17). */
export const ENEMY_SPAWNS: readonly Vec2[] = [
  { x: -14, z: -15.5 },
  { x: -4, z: -15.5 },
  { x: 6, z: -15.5 },
  { x: 16, z: -15.5 },
  { x: -20, z: -7.5 },
  { x: 18, z: -7.5 },
  { x: 0, z: -15.5 },
];

/** Backup flank/south spawns used only when the player pushes deep into north deck. */
const FALLBACK_SPAWNS: readonly Vec2[] = [
  { x: -21, z: 0 },
  { x: 21, z: 0 },
  { x: -18, z: 7.5 },
  { x: 19, z: 7.5 },
  { x: -16, z: 15.5 },
  { x: 14, z: 15.5 },
];

/** Raycast visibility check between two 3D points against MAP.boxes. */
export function hasLineOfSight(from: Vec3, to: Vec3, boxes: readonly Box[]): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-4) return true;
  const dir: Vec3 = { x: dx / dist, y: dy / dist, z: dz / dist };
  for (const b of boxes) {
    if (b.kind === 'deck') continue;
    const t = rayBoxT(from, dir, b);
    if (t < dist - 0.15) return false;
  }
  return true;
}

/** Normalize angle to (-PI, PI]. */
function wrapPi(a: number): number {
  let r = a % (2 * Math.PI);
  if (r <= -Math.PI) r += 2 * Math.PI;
  else if (r > Math.PI) r -= 2 * Math.PI;
  return r;
}

/** Smooth angular turn toward target yaw at maxTurnRate (rad/s). */
function turnToward(current: number, target: number, maxStep: number): number {
  const diff = wrapPi(target - current);
  if (Math.abs(diff) <= maxStep) return wrapPi(target);
  return wrapPi(current + Math.sign(diff) * maxStep);
}

/** Yaw facing along (dx, dz) using the same convention as Player (yaw=0 -> -Z). */
export function yawFromDir(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz);
}

/** Distance attenuation for enemy hit probability (1.0 within 12m, tapering to 0.35 at 50m). */
export function enemyHitAttenuation(dist: number): number {
  if (dist <= 12) return 1.0;
  return Math.max(0.35, 1 - (dist - 12) / 58);
}

export interface EnemyUpdateContext {
  dt: number;
  nowMs: number;
  playerPos: Vec3;
  playerEye: Vec3;
  playerAlive: boolean;
  /** True on frames where the player fired a weapon (60m hearing radius). */
  playerFired: boolean;
  /** Player horizontal speed (m/s) for 12m footstep hearing. */
  playerSpeed: number;
  playerOnGround: boolean;
  boxes: readonly Box[];
  collider: CollisionWorld;
}

export class EnemyManager {
  readonly bots: EnemyBot[] = [];
  readonly entities: Entity[] = [];
  difficulty: DifficultySpec;
  private rng: () => number;
  private nextBotSeq = 1;
  private factionBalance = 0;
  /** Remembered player spawn origin so initial/replacement spawns stay >= 15m away. */
  private playerSpawnOrigin: Vec2 = { x: -8, z: 17 };

  constructor(diffId: DifficultyId = 'normal', rng: () => number = Math.random) {
    this.difficulty = getDifficultySpec(diffId);
    this.rng = rng;
  }

  setDifficulty(diffId: DifficultyId): void {
    this.difficulty = getDifficultySpec(diffId);
  }

  /** Reset and spawn a fresh wave matching active difficulty (EASY 3 / NORMAL 5 / HARD 7 pool, <=5 live). */
  reset(nowMs: number, playerPos: Vec3): void {
    this.bots.length = 0;
    this.entities.length = 0;
    this.factionBalance = 0;
    this.playerSpawnOrigin = { x: playerPos.x, z: playerPos.z };
    const count = Math.min(5, this.difficulty.maxSimultaneous);
    for (let i = 0; i < count; i++) {
      this.spawnIntoSlot(i, nowMs, playerPos);
    }
  }

  /** Deterministic helper for e2e & unit tests: clear all bots. */
  clear(): void {
    this.bots.length = 0;
    this.entities.length = 0;
  }

  /** Deterministic helper for e2e & unit tests: spawn a specific bot at (x, z, yaw). */
  spawnManual(
    x: number,
    z: number,
    yaw = 0,
    faction?: Faction,
    nowMs = 0,
  ): EnemyBot {
    const f = faction ?? this.pickFaction();
    const slot = this.bots.length;
    const id = `bot-${this.nextBotSeq++}`;
    const ent = createEntity(id, { x, y: 0, z }, 100, BOT_RADIUS, BOT_HEIGHT);
    const bot: EnemyBot = {
      id,
      slotIndex: slot,
      faction: f,
      entity: ent,
      state: 'IDLE',
      yaw,
      speed: 0,
      ammo: BOT_MAG,
      mag: BOT_MAG,
      shotsFired: 0,
      reloadingUntil: 0,
      waypointIdx: this.nearestWaypoint(x, z),
      stateUntil: nowMs + 1600,
      sightAcquiredAt: -1,
      firstShotAt: -1,
      firstSightAt: -1,
      hasLos: false,
      lastSeenPos: null,
      lastSeenAt: 0,
      fireAnimStartAt: -10000,
      fireAnimEndAt: -10000,
      fireHitAt: -10000,
      fireHitPending: false,
      nextFireCycleAt: nowMs,
      flankSign: slot % 2 === 0 ? 1 : -1,
      strafeSwitchAt: nowMs + 1600,
      coverTarget: null,
      lastFireAt: -10000,
      lastHitAt: -10000,
      diedAt: -10000,
      replaceAt: -1,
      anim: 'idle_rifle',
      walkPhase: this.rng() * Math.PI * 2,
    };
    this.bots.push(bot);
    this.entities.push(ent);
    return bot;
  }

  /** Random CF faction assignment ('bl' 潜伏者 / 'gr' 保卫者), avoiding mono-faction streaks. */
  private pickFaction(): Faction {
    let f: Faction = this.rng() < 0.5 ? 'bl' : 'gr';
    if (this.factionBalance >= 2) f = 'gr';
    else if (this.factionBalance <= -2) f = 'bl';
    this.factionBalance += f === 'bl' ? 1 : -1;
    return f;
  }

  private nearestWaypoint(x: number, z: number): number {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < PATROL_WAYPOINTS.length; i++) {
      const wp = PATROL_WAYPOINTS[i];
      const d = (wp.x - x) ** 2 + (wp.z - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /**
   * Pick an enemy spawn point strictly >= 15m from playerPos (and player spawn
   * when possible) and >= 1.5m away from all live enemies.
   */
  private pickSpawn(playerPos: Vec3, slotIndex: number): Vec2 {
    const allCandidates: readonly Vec2[] = [...ENEMY_SPAWNS, ...FALLBACK_SPAWNS];
    const minBotDistAt = (sp: Vec2): number => {
      let minD = 99;
      for (const b of this.bots) {
        if (!b.entity.alive) continue;
        const db = Math.hypot(sp.x - b.entity.pos.x, sp.z - b.entity.pos.z);
        if (db < minD) minD = db;
      }
      return minD;
    };

    const pickFrom = (list: readonly Vec2[], requireSpawnDist: boolean): Vec2 | null => {
      let best: Vec2 | null = null;
      let bestScore = -Infinity;
      for (let i = 0; i < list.length; i++) {
        const sp = list[(i + slotIndex) % list.length];
        const dPlayer = Math.hypot(sp.x - playerPos.x, sp.z - playerPos.z);
        if (dPlayer < MIN_PLAYER_SPAWN_DIST) continue;
        if (requireSpawnDist) {
          const dOrigin = Math.hypot(sp.x - this.playerSpawnOrigin.x, sp.z - this.playerSpawnOrigin.z);
          if (dOrigin < MIN_PLAYER_SPAWN_DIST) continue;
        }
        const minBotD = minBotDistAt(sp);
        if (minBotD < MIN_BOT_SEPARATION + 0.5) continue;
        const score = Math.min(dPlayer, 36) + Math.min(minBotD, 14) * 2.5 + this.rng() * 3;
        if (score > bestScore) {
          bestScore = score;
          best = sp;
        }
      }
      return best;
    };

    // Pass 1: primary north spawns clear of player, player spawn, and live bots
    const p1 = pickFrom(ENEMY_SPAWNS, true);
    if (p1) return p1;
    // Pass 2: all candidates clear of player, player spawn, and live bots
    const p2 = pickFrom(allCandidates, true);
    if (p2) return p2;
    // Pass 3: all candidates clear of current player (>=15m) and live bots
    const p3 = pickFrom(allCandidates, false);
    if (p3) return p3;

    // Pass 4: farthest candidate from player & other bots (guarantees >= 15m on 64×40m deck)
    let fallback = ENEMY_SPAWNS[slotIndex % ENEMY_SPAWNS.length];
    let bestD = -Infinity;
    for (const sp of allCandidates) {
      const d = Math.hypot(sp.x - playerPos.x, sp.z - playerPos.z) + minBotDistAt(sp) * 2;
      if (d > bestD) {
        bestD = d;
        fallback = sp;
      }
    }
    return fallback;
  }

  private spawnIntoSlot(slotIndex: number, nowMs: number, playerPos: Vec3): EnemyBot {
    const sp = this.pickSpawn(playerPos, slotIndex);
    const id = `bot-${this.nextBotSeq++}`;
    const ent = createEntity(id, { x: sp.x, y: 0, z: sp.z }, 100, BOT_RADIUS, BOT_HEIGHT);
    const yaw = yawFromDir(playerPos.x - sp.x, playerPos.z - sp.z);
    const bot: EnemyBot = {
      id,
      slotIndex,
      faction: this.pickFaction(),
      entity: ent,
      state: 'PATROL',
      yaw,
      speed: 0,
      ammo: BOT_MAG,
      mag: BOT_MAG,
      shotsFired: 0,
      reloadingUntil: 0,
      waypointIdx: this.nearestWaypoint(sp.x, sp.z),
      stateUntil: nowMs + 600 + this.rng() * 800,
      sightAcquiredAt: -1,
      firstShotAt: -1,
      firstSightAt: -1,
      hasLos: false,
      lastSeenPos: null,
      lastSeenAt: 0,
      fireAnimStartAt: -10000,
      fireAnimEndAt: -10000,
      fireHitAt: -10000,
      fireHitPending: false,
      nextFireCycleAt: nowMs + 200,
      flankSign: slotIndex % 2 === 0 ? 1 : -1,
      strafeSwitchAt: nowMs + 1400 + this.rng() * 1200,
      coverTarget: null,
      lastFireAt: -10000,
      lastHitAt: -10000,
      diedAt: -10000,
      replaceAt: -1,
      anim: 'walk_rifle',
      walkPhase: this.rng() * Math.PI * 2,
    };
    if (slotIndex < this.bots.length) {
      this.bots[slotIndex] = bot;
      this.entities[slotIndex] = ent;
    } else {
      this.bots.push(bot);
      this.entities.push(ent);
    }
    return bot;
  }

  /** Alert hold before entering ENGAGE: 0.6s on NORMAL; aligns EASY/HARD first-shot delay with 0.18s fire windup. */
  private alertSightDelayMs(): number {
    if (this.difficulty.id === 'normal') return ALERT_HOLD_MS;
    return Math.max(150, this.difficulty.reactionMs - FIRE_HIT_DELAY_MS);
  }

  /** Notify bot that it was hit by the player (triggers 0.25s hit clip without interrupting movement, death, or alert). */
  onBotDamaged(entity: Entity, attackerPos: Vec3, nowMs: number): EnemyBot | null {
    const bot = this.bots.find((b) => b.entity === entity);
    if (!bot) return null;
    bot.lastHitAt = nowMs;
    if (!entity.alive) {
      bot.state = 'DEAD';
      bot.diedAt = nowMs;
      bot.replaceAt = nowMs + this.difficulty.respawnDelayMs;
      bot.fireHitPending = false;
      bot.speed = 0;
      bot.anim = 'die';
      return bot;
    }
    // Wounded bot knows attacker direction without interrupting movement
    bot.lastSeenPos = { x: attackerPos.x, y: attackerPos.y, z: attackerPos.z };
    bot.lastSeenAt = nowMs;
    if (bot.state === 'IDLE' || bot.state === 'PATROL') {
      bot.state = 'ALERT';
      bot.stateUntil = nowMs + ALERT_HOLD_MS;
    }
    // Retreat to cover when HP < 30% on NORMAL / HARD
    if (
      this.difficulty.canTakeCover &&
      entity.hp < entity.maxHp * 0.3 &&
      bot.state !== 'COVER' &&
      bot.state !== 'RELOAD'
    ) {
      bot.state = 'COVER';
      bot.coverTarget = null;
      bot.fireHitPending = false;
      bot.stateUntil = nowMs + 2800;
    }
    return bot;
  }

  /** Advance all AI bots one simulation step; returns shots fired at the 0.18s fire_rifle trigger. */
  update(ctx: EnemyUpdateContext): EnemyShotEvent[] {
    const shots: EnemyShotEvent[] = [];
    const { dt, nowMs, playerPos, playerEye, playerAlive, boxes, collider } = ctx;
    const diff = this.difficulty;
    const alertSightMs = this.alertSightDelayMs();

    for (let i = 0; i < this.bots.length; i++) {
      const bot = this.bots[i];
      const ent = bot.entity;

      // --- DEAD state & slot replenishment ---
      if (!ent.alive || bot.state === 'DEAD') {
        bot.state = 'DEAD';
        bot.speed = 0;
        bot.fireHitPending = false;
        bot.anim = 'die';
        if (bot.replaceAt > 0 && nowMs >= bot.replaceAt) {
          this.spawnIntoSlot(bot.slotIndex, nowMs, playerPos);
        }
        continue;
      }

      const botEye: Vec3 = { x: ent.pos.x, y: ent.pos.y + BOT_EYE_Y, z: ent.pos.z };
      const toPx = playerPos.x - ent.pos.x;
      const toPz = playerPos.z - ent.pos.z;
      const dist = Math.hypot(toPx, toPz);

      // --- Sensory Perception: 100°/40m vision cone + raycast LOS + hearing ---
      let canSee = false;
      let clearLos = false;
      if (playerAlive && dist <= VISION_RANGE) {
        clearLos = hasLineOfSight(botEye, playerEye, boxes);
        if (clearLos) {
          const fwdX = -Math.sin(bot.yaw);
          const fwdZ = -Math.cos(bot.yaw);
          const dot = dist > 1e-4 ? (toPx * fwdX + toPz * fwdZ) / dist : 1;
          const inCone = dot >= VISION_COS_HALF || dist < 3.5;
          const alreadyAware =
            bot.state === 'ALERT' ||
            bot.state === 'CHASE' ||
            bot.state === 'ENGAGE' ||
            bot.state === 'RELOAD';
          if (inCone || alreadyAware) canSee = true;
        }
      }

      const heardShot = playerAlive && ctx.playerFired && dist <= HEAR_SHOT_RANGE;
      const heardStep =
        playerAlive && ctx.playerOnGround && ctx.playerSpeed > 1.2 && dist <= HEAR_STEP_RANGE;

      bot.hasLos = canSee && clearLos;
      if (bot.hasLos) {
        if (bot.sightAcquiredAt < 0) bot.sightAcquiredAt = nowMs;
        if (bot.firstSightAt < 0) bot.firstSightAt = nowMs;
        bot.lastSeenPos = { x: playerPos.x, y: playerPos.y, z: playerPos.z };
        bot.lastSeenAt = nowMs;
      } else {
        bot.sightAcquiredAt = -1;
        bot.fireHitPending = false;
      }

      if ((heardShot || heardStep) && !bot.hasLos) {
        bot.lastSeenPos = { x: playerPos.x, y: playerPos.y, z: playerPos.z };
        bot.lastSeenAt = nowMs;
        if (bot.state === 'IDLE' || bot.state === 'PATROL') {
          bot.state = 'ALERT';
          bot.stateUntil = nowMs + ALERT_HOLD_MS;
        }
      }

      // Low HP cover trigger (NORMAL / HARD only)
      if (
        diff.canTakeCover &&
        ent.hp < ent.maxHp * 0.3 &&
        bot.state !== 'COVER' &&
        bot.state !== 'RELOAD' &&
        bot.state !== 'IDLE' &&
        bot.state !== 'PATROL'
      ) {
        bot.state = 'COVER';
        bot.coverTarget = this.pickCoverSpot(ent.pos, playerEye, boxes);
        bot.fireHitPending = false;
        bot.stateUntil = nowMs + 2600;
      }

      // --- State Transitions & Movement Intent ---
      let moveTargetX: number | null = null;
      let moveTargetZ: number | null = null;
      let desiredSpeed = 0;
      let lookTargetYaw = bot.yaw;

      if (!playerAlive && bot.state !== 'IDLE' && bot.state !== 'PATROL' && bot.state !== 'RELOAD') {
        bot.state = 'PATROL';
        bot.fireHitPending = false;
        bot.sightAcquiredAt = -1;
      }

      switch (bot.state) {
        case 'IDLE': {
          desiredSpeed = 0;
          if (bot.hasLos) {
            bot.state = 'ALERT';
            bot.stateUntil = nowMs + alertSightMs;
          } else if (nowMs >= bot.stateUntil) {
            bot.state = 'PATROL';
            bot.waypointIdx = this.pickNextWaypoint(bot.waypointIdx);
          }
          break;
        }

        case 'PATROL': {
          if (bot.hasLos) {
            bot.state = 'ALERT';
            bot.stateUntil = nowMs + alertSightMs;
            break;
          }
          const wp = PATROL_WAYPOINTS[bot.waypointIdx] ?? PATROL_WAYPOINTS[0];
          const wd = Math.hypot(wp.x - ent.pos.x, wp.z - ent.pos.z);
          if (wd < 1.1) {
            bot.state = 'IDLE';
            bot.stateUntil = nowMs + 700 + this.rng() * 900;
            desiredSpeed = 0;
          } else {
            moveTargetX = wp.x;
            moveTargetZ = wp.z;
            desiredSpeed = PATROL_SPEED; // strict 1.4 m/s walk_rifle
            lookTargetYaw = yawFromDir(wp.x - ent.pos.x, wp.z - ent.pos.z);
          }
          break;
        }

        case 'ALERT': {
          desiredSpeed = 0; // 原地据枪 aim_rifle
          const target = bot.hasLos ? playerPos : bot.lastSeenPos;
          if (target) {
            lookTargetYaw = yawFromDir(target.x - ent.pos.x, target.z - ent.pos.z);
          }
          if (bot.hasLos) {
            if (nowMs - bot.sightAcquiredAt >= alertSightMs) {
              bot.state = dist <= ENGAGE_MAX_DIST + 4 ? 'ENGAGE' : 'CHASE';
              bot.nextFireCycleAt = Math.min(bot.nextFireCycleAt, nowMs);
            }
          } else if (nowMs >= bot.stateUntil) {
            if (bot.lastSeenPos && nowMs - bot.lastSeenAt < 6500) {
              bot.state = 'CHASE';
            } else {
              bot.state = 'PATROL';
            }
          }
          break;
        }

        case 'CHASE': {
          if (bot.hasLos && dist <= ENGAGE_MAX_DIST && nowMs - bot.sightAcquiredAt >= alertSightMs) {
            bot.state = 'ENGAGE';
            bot.nextFireCycleAt = Math.min(bot.nextFireCycleAt, nowMs);
            break;
          }
          const goal = bot.hasLos ? playerPos : bot.lastSeenPos;
          if (!goal || (!bot.hasLos && nowMs - bot.lastSeenAt > 7500)) {
            bot.state = 'PATROL';
            bot.waypointIdx = this.nearestWaypoint(ent.pos.x, ent.pos.z);
            break;
          }
          let tx = goal.x;
          let tz = goal.z;
          // HARD pair flanking: approach from opposite ±38° wings around target
          if (diff.flankPairs && dist > 6) {
            const ang = Math.atan2(ent.pos.z - goal.z, ent.pos.x - goal.x) + bot.flankSign * 0.65;
            tx = goal.x + Math.cos(ang) * Math.max(8, dist * 0.65);
            tz = goal.z + Math.sin(ang) * Math.max(8, dist * 0.65);
          }
          const dGoal = Math.hypot(tx - ent.pos.x, tz - ent.pos.z);
          if (dGoal < 1.4 && !bot.hasLos) {
            bot.lastSeenPos = null;
            bot.state = 'PATROL';
            bot.waypointIdx = this.nearestWaypoint(ent.pos.x, ent.pos.z);
          } else {
            moveTargetX = tx;
            moveTargetZ = tz;
            desiredSpeed = diff.moveSpeed; // run_rifle: 3.0 m/s on NORMAL, scaled by difficulty
            lookTargetYaw = yawFromDir(goal.x - ent.pos.x, goal.z - ent.pos.z);
          }
          break;
        }

        case 'RELOAD': {
          // RELOAD -> reload_rifle (2.2s, never shoots while reloading)
          desiredSpeed = 0;
          bot.fireHitPending = false;
          const target = bot.hasLos ? playerPos : bot.lastSeenPos;
          if (target) {
            lookTargetYaw = yawFromDir(target.x - ent.pos.x, target.z - ent.pos.z);
          }
          if (nowMs >= bot.reloadingUntil) {
            bot.ammo = bot.mag;
            bot.reloadingUntil = 0;
            bot.state = bot.hasLos ? 'ENGAGE' : bot.lastSeenPos ? 'CHASE' : 'PATROL';
            bot.nextFireCycleAt = nowMs + 150;
          }
          break;
        }

        case 'ENGAGE': {
          if (!bot.hasLos) {
            bot.fireHitPending = false;
            bot.state = 'CHASE';
            break;
          }
          if (bot.ammo <= 0 && !bot.fireHitPending) {
            bot.state = 'RELOAD';
            bot.reloadingUntil = nowMs + BOT_RELOAD_MS;
            break;
          }
          lookTargetYaw = yawFromDir(toPx, toPz);

          // Hold tactical combat spacing (gentle shift only if too close/far; steady stance while firing)
          if (nowMs >= bot.strafeSwitchAt) {
            bot.flankSign = bot.flankSign === 1 ? -1 : 1;
            bot.strafeSwitchAt = nowMs + 1600 + this.rng() * 1000;
          }
          const inFireAnim = nowMs >= bot.fireAnimStartAt && nowMs < bot.fireAnimEndAt;
          if (!inFireAnim) {
            const ux = dist > 1e-4 ? toPx / dist : 0;
            const uz = dist > 1e-4 ? toPz / dist : -1;
            const rx = -uz * bot.flankSign;
            const rz = ux * bot.flankSign;
            let mx = rx * 0.45;
            let mz = rz * 0.45;
            if (dist > ENGAGE_MAX_DIST) {
              mx += ux * 0.85;
              mz += uz * 0.85;
            } else if (dist < ENGAGE_MIN_DIST) {
              mx -= ux * 0.7;
              mz -= uz * 0.7;
            }
            moveTargetX = ent.pos.x + mx * 2.5;
            moveTargetZ = ent.pos.z + mz * 2.5;
            desiredSpeed = 0.85;
          } else {
            desiredSpeed = 0;
          }

          // Start a new fire_rifle cycle every 0.9s (0.35s animation, hit判定 at +0.18s!)
          const reactionMet =
            bot.sightAcquiredAt >= 0 && nowMs - bot.sightAcquiredAt >= alertSightMs;
          if (
            reactionMet &&
            bot.ammo > 0 &&
            !bot.fireHitPending &&
            nowMs >= bot.nextFireCycleAt &&
            hasLineOfSight(botEye, playerEye, boxes)
          ) {
            bot.fireAnimStartAt = nowMs;
            bot.fireAnimEndAt = nowMs + FIRE_ANIM_MS;
            bot.fireHitAt = nowMs + FIRE_HIT_DELAY_MS;
            bot.fireHitPending = true;
            bot.nextFireCycleAt = nowMs + ENGAGE_FIRE_INTERVAL_MS;
          }

          // Generate hit判定 strictly at 0.18s into fire_rifle (never at clip start!)
          if (bot.fireHitPending && nowMs >= bot.fireHitAt) {
            bot.fireHitPending = false;
            if (bot.ammo > 0 && hasLineOfSight(botEye, playerEye, boxes)) {
              bot.ammo--;
              bot.shotsFired++;
              bot.lastFireAt = nowMs;
              if (bot.firstShotAt < 0) bot.firstShotAt = nowMs;

              const pHit = diff.hitRate * enemyHitAttenuation(dist);
              const hit = this.rng() < pHit;
              const fwdX = -Math.sin(bot.yaw);
              const fwdZ = -Math.cos(bot.yaw);
              const muzzle: Vec3 = {
                x: ent.pos.x + fwdX * 0.58 + -fwdZ * 0.14,
                y: ent.pos.y + 1.38,
                z: ent.pos.z + fwdZ * 0.58 + fwdX * 0.14,
              };
              const missSide = (this.rng() < 0.5 ? 1 : -1) * (0.45 + this.rng() * 0.55);
              const missUp = (this.rng() - 0.35) * 0.5;
              const target: Vec3 = hit
                ? { x: playerEye.x, y: playerEye.y - 0.25, z: playerEye.z }
                : {
                    x: playerEye.x + -fwdZ * missSide,
                    y: Math.max(0.25, playerEye.y - 0.15 + missUp),
                    z: playerEye.z + fwdX * missSide,
                  };

              shots.push({
                botId: bot.id,
                faction: bot.faction,
                origin: muzzle,
                target,
                hit,
                damage: hit ? diff.enemyDmg : 0,
                dist,
              });

              if (bot.ammo <= 0) {
                bot.state = 'RELOAD';
                bot.reloadingUntil = nowMs + BOT_RELOAD_MS;
              }
            }
          }
          break;
        }

        case 'COVER': {
          // COVER -> crouch_rifle (lateral cover movement at 1.2 m/s)
          if (!bot.coverTarget) {
            bot.coverTarget = this.pickCoverSpot(ent.pos, playerEye, boxes);
          }
          const c = bot.coverTarget;
          const dc = Math.hypot(c.x - ent.pos.x, c.z - ent.pos.z);
          if (nowMs >= bot.strafeSwitchAt) {
            bot.flankSign = bot.flankSign === 1 ? -1 : 1;
            bot.strafeSwitchAt = nowMs + 1100 + this.rng() * 800;
          }
          if (dc > 0.85) {
            moveTargetX = c.x;
            moveTargetZ = c.z;
            desiredSpeed = COVER_SPEED;
          } else {
            // Lateral crouch-strafe along cover axis perpendicular to threat
            const ref = bot.lastSeenPos ?? playerPos;
            const rdx = ref.x - ent.pos.x;
            const rdz = ref.z - ent.pos.z;
            const rlen = Math.hypot(rdx, rdz) || 1;
            const lx = (-rdz / rlen) * bot.flankSign;
            const lz = (rdx / rlen) * bot.flankSign;
            moveTargetX = ent.pos.x + lx * 2.0;
            moveTargetZ = ent.pos.z + lz * 2.0;
            desiredSpeed = COVER_SPEED;
          }
          const lookRef = bot.hasLos ? playerPos : bot.lastSeenPos;
          if (lookRef) {
            lookTargetYaw = yawFromDir(lookRef.x - ent.pos.x, lookRef.z - ent.pos.z);
          }
          if (bot.ammo <= 0) {
            bot.state = 'RELOAD';
            bot.reloadingUntil = nowMs + BOT_RELOAD_MS;
          } else if (nowMs >= bot.stateUntil) {
            bot.coverTarget = null;
            bot.state = bot.hasLos ? 'ENGAGE' : 'CHASE';
          }
          break;
        }
      }

      // --- Smooth Yaw (8 rad/s) + Box-Avoiding Steering via CollisionWorld ---
      bot.yaw = turnToward(bot.yaw, lookTargetYaw, BOT_TURN_RATE * dt);

      let vx = 0;
      let vz = 0;
      if (moveTargetX !== null && moveTargetZ !== null && desiredSpeed > 0.01) {
        let dirX = moveTargetX - ent.pos.x;
        let dirZ = moveTargetZ - ent.pos.z;
        const dLen = Math.hypot(dirX, dirZ) || 1;
        dirX /= dLen;
        dirZ /= dLen;

        // Lightweight raycast whisker steering around containers (no navmesh)
        const probePos: Vec3 = { x: ent.pos.x, y: 0.9, z: ent.pos.z };
        if (this.rayBlocked(probePos, dirX, dirZ, 1.5, boxes)) {
          const angles = [
            bot.flankSign * 0.78,
            -bot.flankSign * 0.78,
            bot.flankSign * 1.4,
            -bot.flankSign * 1.4,
          ];
          for (const a of angles) {
            const ca = Math.cos(a);
            const sa = Math.sin(a);
            const rx = dirX * ca - dirZ * sa;
            const rz = dirX * sa + dirZ * ca;
            if (!this.rayBlocked(probePos, rx, rz, 1.5, boxes)) {
              dirX = rx;
              dirZ = rz;
              break;
            }
          }
        }

        // Soft steering separation within 2.0m
        for (let j = 0; j < this.bots.length; j++) {
          if (j === i) continue;
          const other = this.bots[j];
          if (!other.entity.alive) continue;
          const sx = ent.pos.x - other.entity.pos.x;
          const sz = ent.pos.z - other.entity.pos.z;
          const sd = Math.hypot(sx, sz);
          if (sd > 0.001 && sd < 2.0) {
            const push = ((2.0 - sd) / 2.0) * 1.6;
            dirX += (sx / sd) * push;
            dirZ += (sz / sd) * push;
          }
        }
        const fl = Math.hypot(dirX, dirZ) || 1;
        vx = (dirX / fl) * desiredSpeed;
        vz = (dirZ / fl) * desiredSpeed;
      }

      const moved = collider.move(
        ent.pos,
        { x: vx, y: -4.0, z: vz },
        ent.radius,
        ent.height,
        dt,
        true,
      );
      const actualDisp = Math.hypot(moved.pos.x - ent.pos.x, moved.pos.z - ent.pos.z);
      ent.pos.x = moved.pos.x;
      ent.pos.y = Math.max(0, moved.pos.y);
      ent.pos.z = moved.pos.z;
      bot.speed = dt > 1e-4 ? actualDisp / dt : 0;
      bot.walkPhase += bot.speed * dt * 3.1;

      if (bot.state === 'PATROL' && desiredSpeed > 0.5 && bot.speed < 0.25) {
        bot.waypointIdx = this.pickNextWaypoint(bot.waypointIdx);
      }

      // --- Strict State -> glTF Clip Mapping (no reusing clips across states) ---
      if (nowMs - bot.lastHitAt >= 0 && nowMs - bot.lastHitAt < HIT_ANIM_MS) {
        bot.anim = 'hit';
      } else {
        switch (bot.state) {
          case 'IDLE':
            bot.anim = 'idle_rifle';
            break;
          case 'PATROL':
            bot.anim = 'walk_rifle';
            break;
          case 'ALERT':
            bot.anim = 'aim_rifle';
            break;
          case 'CHASE':
            bot.anim = 'run_rifle';
            break;
          case 'ENGAGE':
            bot.anim =
              nowMs >= bot.fireAnimStartAt && nowMs < bot.fireAnimEndAt
                ? 'fire_rifle'
                : 'aim_rifle';
            break;
          case 'RELOAD':
            bot.anim = 'reload_rifle';
            break;
          case 'COVER':
            bot.anim = 'crouch_rifle';
            break;
        }
      }
    }

    // --- Hard pairwise separation pass: guarantee >= 1.5m between all live enemies ---
    this.enforceMinSeparation(collider, dt);

    return shots;
  }

  private enforceMinSeparation(collider: CollisionWorld, dt: number): void {
    const stepDt = Math.max(dt, 1 / 60);
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < this.bots.length; i++) {
        const a = this.bots[i];
        if (!a.entity.alive) continue;
        for (let j = i + 1; j < this.bots.length; j++) {
          const b = this.bots[j];
          if (!b.entity.alive) continue;
          let dx = a.entity.pos.x - b.entity.pos.x;
          let dz = a.entity.pos.z - b.entity.pos.z;
          let d = Math.hypot(dx, dz);
          if (d >= MIN_BOT_SEPARATION) continue;
          if (d < 1e-4) {
            const ang = (i * 1.7 + j * 2.3) % (Math.PI * 2);
            dx = Math.cos(ang);
            dz = Math.sin(ang);
            d = 1;
          }
          const nx = dx / d;
          const nz = dz / d;
          const overlap = (MIN_BOT_SEPARATION - d) * 0.52;
          const pushSpeed = overlap / stepDt;
          const ma = collider.move(
            a.entity.pos,
            { x: nx * pushSpeed, y: -4.0, z: nz * pushSpeed },
            a.entity.radius,
            a.entity.height,
            stepDt,
            true,
          );
          a.entity.pos.x = ma.pos.x;
          a.entity.pos.y = Math.max(0, ma.pos.y);
          a.entity.pos.z = ma.pos.z;

          const mb = collider.move(
            b.entity.pos,
            { x: -nx * pushSpeed, y: -4.0, z: -nz * pushSpeed },
            b.entity.radius,
            b.entity.height,
            stepDt,
            true,
          );
          b.entity.pos.x = mb.pos.x;
          b.entity.pos.y = Math.max(0, mb.pos.y);
          b.entity.pos.z = mb.pos.z;
        }
      }
    }
  }

  private rayBlocked(origin: Vec3, dx: number, dz: number, maxDist: number, boxes: readonly Box[]): boolean {
    const dir: Vec3 = { x: dx, y: 0, z: dz };
    for (const b of boxes) {
      if (b.kind === 'deck') continue;
      if (rayBoxT(origin, dir, b) < maxDist) return true;
    }
    return false;
  }

  private pickNextWaypoint(currentIdx: number): number {
    const nbs = WP_NEIGHBORS[currentIdx];
    if (!nbs || nbs.length === 0) return Math.floor(this.rng() * PATROL_WAYPOINTS.length);
    return nbs[Math.floor(this.rng() * nbs.length)];
  }

  private pickCoverSpot(botPos: Vec3, playerEye: Vec3, boxes: readonly Box[]): Vec2 {
    let best = COVER_SPOTS[0];
    let bestScore = Infinity;
    for (const c of COVER_SPOTS) {
      const d = Math.hypot(c.x - botPos.x, c.z - botPos.z);
      const hidden = !hasLineOfSight({ x: c.x, y: 1.2, z: c.z }, playerEye, boxes);
      const score = d + (hidden ? 0 : 25);
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return best;
  }
}
