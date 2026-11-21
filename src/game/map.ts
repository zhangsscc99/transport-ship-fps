// Transport ship map — pure data & helpers, no three.js / DOM.
// Layout follows docs/SPEC.md §地图: symmetric ~64×40m deck, 8 containers,
// 4 sniper towers with stairs, 2 enclosed flank pipes, 4 crate-jump spots.
//
// Conventions:
//   - X is the long axis (bounds w=64), Z the short axis (d=40).
//   - Box.y is the BOTTOM face height; the box occupies [y, y+h].
//   - Deck top is y=0; the layout is 180°-rotation symmetric: team A spawns
//     at +z, team B at -z, and every structure at (x,z) has a mirror at (-x,-z).

export interface Vec2 {
  x: number;
  z: number;
}

export interface Box {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  kind: 'deck' | 'container' | 'tower' | 'rail' | 'pipe';
}

export type Team = 'A' | 'B';

const BOXES: Box[] = [];

const box = (
  x: number,
  y: number,
  z: number,
  w: number,
  h: number,
  d: number,
  kind: Box['kind'],
): void => {
  BOXES.push({ x, y, z, w, h, d, kind });
};

// --- deck slab (top at y=0, 1m thick → freeboard above water) ---
box(0, -1, 0, 64, 1, 40, 'deck');

// --- containers: 8 total, 2.6m tall (cannot be jumped onto from ground) ---
const CONTAINER_H = 2.6;
box(-12, 0, 11, 6, CONTAINER_H, 2.5, 'container');
box(-4, 0, 11, 6, CONTAINER_H, 2.5, 'container');
box(-16, 0, 2, 2.5, CONTAINER_H, 6, 'container');
box(-6, 0, -4, 6, CONTAINER_H, 2.5, 'container');
box(6, 0, 4, 6, CONTAINER_H, 2.5, 'container');
box(16, 0, -2, 2.5, CONTAINER_H, 6, 'container');
box(4, 0, -11, 6, CONTAINER_H, 2.5, 'container');
box(12, 0, -11, 6, CONTAINER_H, 2.5, 'container');

// --- 2 low central covers (crouchable / jumpable, h=0.55) ---
box(-2, 0, 1, 2.4, 0.55, 1.2, 'container');
box(2, 0, -1, 2.4, 0.55, 1.2, 'container');

// --- crate stairs: 4 jump-up spots onto the spawn-side containers ---
// Each spot is a 4-crate staircase (0.6 / 1.2 / 1.8 / 2.0m tops — each step is
// reachable with the 0.64m jump apex, then a small hop onto the 2.6m box).
const CRATE_H = [0.6, 1.2, 1.8, 2.0];
function crateStairs(cx: number, faceZ: number, dir: -1 | 1): void {
  for (let i = 0; i < CRATE_H.length; i++) {
    box(cx, 0, faceZ + dir * (0.6 + (CRATE_H.length - 1 - i) * 0.95), 0.9, CRATE_H[i], 0.9, 'container');
  }
}
crateStairs(-12, 9.75, -1); // onto container (-12, 11) from the -z side
crateStairs(-4, 9.75, -1);
crateStairs(12, -9.75, 1); // mirrored onto container (12, -11)
crateStairs(4, -9.75, 1);

// --- 4 sniper towers at (±26, ±14), stairs facing map centre ---
function tower(tx: number, tz: number): void {
  const s = tx > 0 ? -1 : 1; // stairs descend toward x = sign * centre
  box(tx, 0, tz, 3.4, 3.0, 3.4, 'tower'); // solid base
  box(tx, 3.0, tz, 4.4, 0.3, 4.4, 'tower'); // platform, top at 3.3
  // guard rails on the platform (top y = 3.3, half-height 1.05)
  // z-side rails sit between the far rail's and entry stubs' inner faces.
  box(tx, 3.3, tz - 2.05, 3.8, 1.05, 0.3, 'rail');
  box(tx, 3.3, tz + 2.05, 3.8, 1.05, 0.3, 'rail');
  box(tx - s * 2.05, 3.3, tz, 0.3, 1.05, 4.4, 'rail'); // far side
  // entry-side stubs flanking the 1.6m stair opening
  box(tx + s * 2.05, 3.3, tz - 1.5, 0.3, 1.05, 1.4, 'rail');
  box(tx + s * 2.05, 3.3, tz + 1.5, 0.3, 1.05, 1.4, 'rail');
  // stairs: 10 steps × 0.3m rise, 0.6m tread, 1.6m wide — auto-step compatible
  const edgeX = tx + s * 2.2; // platform edge on the stair side
  for (let i = 0; i < 10; i++) {
    box(edgeX + s * (9.5 - i) * 0.6, 0, tz, 0.6, (i + 1) * 0.3, 1.6, 'tower');
  }
}
tower(-26, 14);
tower(26, 14);
tower(26, -14);
tower(-26, -14);

// --- 2 enclosed flank pipes along the x edges (roofed corridors, 1.8m wide) ---
function pipe(cx: number, cz: number, len: number): void {
  box(cx - 1.05, 0, cz, 0.3, 2.0, len, 'pipe'); // west wall
  box(cx + 1.05, 0, cz, 0.3, 2.0, len, 'pipe'); // east wall
  box(cx, 2.0, cz, 2.7, 0.4, len, 'pipe'); // roof slab
}
pipe(-30, 1, 32); // interior x∈[-30.9,-29.1], open ends z=-15 & z=17
pipe(30, -1, 32); // mirrored: interior x∈[29.1,30.9], ends z=15 & z=-17

/**
 * CCW walkable deck polygon in XZ (inset cleanly inside the 64×40m dock edges,
 * mooring rails, bow/stern crane bases, and corner visual containers).
 * Air walls enforce player capsule (r=0.35m) containment within this polygon
 * without entering MAP.boxes, so bullets and raycasts pass freely over water.
 */
export const WALKABLE_POLYGON: readonly Vec2[] = [
  { x: -27.8, z: -19.65 },
  { x: 31.85, z: -19.65 },
  { x: 31.85, z: 16.9 },
  { x: 27.8, z: 16.9 },
  { x: 27.8, z: 19.65 },
  { x: -31.85, z: 19.65 },
  { x: -31.85, z: -16.9 },
  { x: -27.8, z: -16.9 },
];

export const MAP = {
  bounds: { w: 64, d: 40 },
  walkablePolygon: WALKABLE_POLYGON,
  boxes: BOXES,
  spawns: {
    teamA: [
      [-8, 0, 17],
      [-4, 0, 17],
      [0, 0, 17],
      [4, 0, 17],
      [8, 0, 17],
    ] as [number, number, number][],
    teamB: [
      [8, 0, -17],
      [4, 0, -17],
      [0, 0, -17],
      [-4, 0, -17],
      [-8, 0, -17],
    ] as [number, number, number][],
  },
  waterY: -2,
  pipes: [
    { from: [-30, 15], to: [-30, -13] },
    { from: [30, -15], to: [30, 13] },
  ] as { from: [number, number]; to: [number, number] }[],
  jumpSpots: [
    [-12, 6.3],
    [-4, 6.3],
    [12, -6.3],
    [4, -6.3],
  ] as [number, number][],
} as const;

export function isInsideBounds(x: number, z: number): boolean {
  return Math.abs(x) <= MAP.bounds.w / 2 && Math.abs(z) <= MAP.bounds.d / 2;
}

/** y below waterY means the player fell in the sea. */
export function isInWater(y: number): boolean {
  return y < MAP.waterY;
}

export function spawnPoint(team: Team, index: number): [number, number, number] {
  const list = team === 'A' ? MAP.spawns.teamA : MAP.spawns.teamB;
  return list[((index % list.length) + list.length) % list.length];
}

/** True when point (x,y,z) lies strictly inside box b (touching faces count as outside). */
export function pointInBox(x: number, y: number, z: number, b: Box): boolean {
  return (
    x > b.x - b.w / 2 &&
    x < b.x + b.w / 2 &&
    y > b.y &&
    y < b.y + b.h &&
    z > b.z - b.d / 2 &&
    z < b.z + b.d / 2
  );
}
