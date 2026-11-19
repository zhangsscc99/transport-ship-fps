import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Player, MOVE, emptyInput, type InputState, type Vec3 } from './player.ts';
import { CollisionWorld, PLAYER_RADIUS } from './collision.ts';
import { MAP, type Box } from './map.ts';

const DT = 1 / 120;
const world = new CollisionWorld(MAP.boxes, MAP.bounds, MAP.waterY);
const WQ = { collider: world };

function input(patch: Partial<InputState> = {}): InputState {
  return { ...emptyInput(), ...patch };
}

function step(p: Player, inp: InputState, seconds: number): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) p.update(DT, inp, WQ);
}

test('head-on sprint into a container stops at its face and stays stable', () => {
  // container (-6,0,-4) spans z∈[-5.25,-2.75], x∈[-9,-3]
  const p = new Player({ x: -6, y: 0, z: 0 });
  step(p, input({ moveZ: 1, run: true }), 1.2);
  const face = -2.75 + PLAYER_RADIUS;
  assert.ok(Math.abs(p.position.z - face) < 0.02, `z ${p.position.z}`);
  assert.equal(p.velocity.z, 0);
  // keep pressing for 60 more frames — must not creep or jitter through
  for (let i = 0; i < 60; i++) p.update(DT, input({ moveZ: 1, run: true }), WQ);
  assert.ok(Math.abs(p.position.z - face) < 0.02, `drifted to ${p.position.z}`);
});

test('diagonal pressure slides along the wall (strafe keeps moving)', () => {
  const p = new Player({ x: -5, y: 0, z: -1.5 });
  step(p, input({ moveZ: 1, moveX: -1, run: true }), 0.5);
  assert.ok(Math.abs(p.position.z - (-2.75 + PLAYER_RADIUS)) < 0.05, `z ${p.position.z}`);
  assert.ok(p.position.x < -6.5, `slid to x ${p.position.x}`);
});

test('walks up tower stairs via auto-step (no jump needed)', () => {
  // tower(-26,14) staircase ascends -x from x≈-18.1 to the 3.3m platform
  const p = new Player({ x: -16, y: 0, z: 14 });
  step(p, input({ moveX: -1, run: true }), 4);
  assert.ok(p.position.y > 2.9, `y ${p.position.y}`);
  assert.ok(p.position.x < -22.5, `x ${p.position.x}`);
  assert.ok(p.onGround);
});

test('jumping under a pipe roof bumps the head and lands back', () => {
  const p = new Player({ x: -30, y: 0, z: 5 }); // inside west pipe, roof bottom y=2.0
  p.update(DT, input({ jump: true }), WQ);
  let maxY = 0;
  for (let i = 0; i < Math.round(1.4 / DT); i++) {
    p.update(DT, input(), WQ);
    maxY = Math.max(maxY, p.position.y);
  }
  // free apex would be 0.64; the roof caps feet at 2.0 - 1.7 = 0.30
  assert.ok(maxY <= 0.31, `maxY ${maxY}`);
  assert.equal(p.position.y, 0);
  assert.ok(p.onGround);
});

test('leaving the ship bounds drowns', () => {
  const p = new Player({ x: 31, y: 0, z: 19 }); // clear of the east pipe (z∈[-17,15])
  step(p, input({ moveX: 1, run: true }), 1.0);
  assert.equal(p.drowned, true);
});

test('sinking below waterY drowns (direct move call)', () => {
  const res = world.move(
    { x: 0, y: -2.6, z: 0 },
    { x: 0, y: -3, z: 0 },
    PLAYER_RADIUS,
    MOVE.eyeHeight,
    DT,
    false,
  );
  assert.equal(res.drowned, true);
});

test('fast movement cannot tunnel through a 0.3m wall', () => {
  // pipe east wall x∈[-29.1,-28.8]; approach from outside at -30 m/s
  const res = world.move(
    { x: -28.5, y: 0, z: 5 },
    { x: -30, y: 0, z: 0 },
    PLAYER_RADIUS,
    MOVE.eyeHeight,
    1 / 20,
    true,
  );
  assert.ok(res.pos.x >= -29.1 + PLAYER_RADIUS - 1e-3, `tunneled to x ${res.pos.x}`);
  assert.ok(!world.hits(res.pos.x, res.pos.y, res.pos.z, PLAYER_RADIUS, MOVE.eyeHeight));
});

function lowCeilingWorld(): { world: CollisionWorld; wq: { collider: CollisionWorld } } {
  const boxes: Box[] = [
    { x: 0, y: -1, z: 0, w: 30, h: 1, d: 30, kind: 'deck' },
    { x: 0, y: 1.4, z: -5, w: 8, h: 0.5, d: 6, kind: 'pipe' }, // 1.4m ceiling over z∈[-8,-2]
  ];
  const w = new CollisionWorld(boxes, { w: 30, d: 30 }, -2);
  return { world: w, wq: { collider: w } };
}

test('standing is blocked by a low ceiling but crouching passes under', () => {
  const { wq } = lowCeilingWorld();
  const p = new Player({ x: 0, y: 0, z: 2 });
  const n = Math.round(1.2 / DT);
  for (let i = 0; i < n; i++) p.update(DT, input({ moveZ: 1 }), wq);
  assert.ok(p.position.z >= -2 + PLAYER_RADIUS - 0.02, `standing reached z ${p.position.z}`);
  assert.ok(p.position.z > -2.4, `overshot to ${p.position.z}`);

  const c = new Player({ x: 0, y: 0, z: 2 });
  for (let i = 0; i < Math.round(4 / DT); i++) c.update(DT, input({ moveZ: 1, crouch: true }), wq);
  assert.ok(c.position.z < -5, `crouch only reached z ${c.position.z}`);
});

test('cannot stand back up under a low ceiling', () => {
  const { wq } = lowCeilingWorld();
  const p = new Player({ x: 0, y: 0, z: -5 });
  p.update(DT, input({ crouch: true }), wq);
  assert.equal(p.crouch, true);
  for (let i = 0; i < 30; i++) p.update(DT, input({ crouch: false }), wq);
  assert.equal(p.crouch, true, 'stood up into the ceiling');
});

test('falls and lands on top of a container', () => {
  const p = new Player({ x: -12, y: 3.6, z: 11 }); // above container top 2.6
  p.onGround = false;
  step(p, input(), 1.2);
  assert.ok(Math.abs(p.position.y - 2.6) < 1e-6, `y ${p.position.y}`);
  assert.ok(p.onGround);
});

test('a 0.55m cover is too tall for auto-step — it blocks', () => {
  // low cover (-2,0,1): top 0.55 > STEP_HEIGHT 0.35 — jump-only terrain
  const p = new Player({ x: -2, y: 0, z: 3 });
  step(p, input({ moveZ: 1, run: true }), 1.0);
  assert.ok(p.position.z >= 1.6 + PLAYER_RADIUS - 0.02, `z ${p.position.z}`);
  assert.ok(p.position.z < 2.05, `overshot to ${p.position.z}`);
  assert.equal(p.position.y, 0);
});
