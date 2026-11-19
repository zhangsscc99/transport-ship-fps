// Shared damageable entity structure — players and bots. Pure data + timers.
// Death → respawn 3s later; spawn protection 1.5s (docs/SPEC.md §一局是什么样).

import type { Vec3 } from './player';

export const RESPAWN_MS = 3000;
export const INVINCIBLE_MS = 1500;

export interface Entity {
  id: string;
  /** feet position — may alias a Player's position object */
  pos: Vec3;
  radius: number;
  height: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  /** when dead: timestamp the entity may respawn */
  deadUntil: number;
  /** spawn protection: damage ignored before this timestamp */
  invincibleUntil: number;
}

export function createEntity(id: string, pos: Vec3, maxHp = 100, radius = 0.35, height = 1.7): Entity {
  return {
    id,
    pos,
    radius,
    height,
    hp: maxHp,
    maxHp,
    alive: true,
    deadUntil: 0,
    invincibleUntil: 0,
  };
}
