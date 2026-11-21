import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Player, MOVE, emptyInput, wrapPi, type InputState } from './player.ts';
import { isInsideBounds, MAP } from './map.ts';

const DT = 1 / 120;

function input(patch: Partial<InputState> = {}): InputState {
  return { ...emptyInput(), ...patch };
}

function step(p: Player, inp: InputState, seconds: number, world = {}): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) p.update(DT, inp, world);
}

test('walk speed is 4.2 m/s and moves forward', () => {
  const p = new Player({ x: 0, y: 0, z: 0 });
  step(p, input({ moveZ: 1 }), 0.5);
  const speed = Math.hypot(p.velocity.x, p.velocity.z);
  assert.ok(Math.abs(speed - MOVE.walkSpeed) < 1e-6, `speed ${speed}`);
  // yaw=0 faces -z
  assert.ok(p.position.z < -1.5, `z ${p.position.z}`);
});

test('speed scales linearly with stick magnitude; crouch is 1.9 and sets the flag', () => {
  const p = new Player({ x: 0, y: 0, z: 0 });
  step(p, input({ moveZ: 0.5 }), 0.3);
  assert.ok(Math.abs(Math.hypot(p.velocity.x, p.velocity.z) - MOVE.walkSpeed * 0.5) < 1e-6);
  step(p, input({ moveZ: 1.0 }), 0.3);
  assert.ok(Math.abs(Math.hypot(p.velocity.x, p.velocity.z) - MOVE.walkSpeed) < 1e-6);
  step(p, input({ moveZ: 1, crouch: true }), 0.3);
  assert.ok(Math.abs(Math.hypot(p.velocity.x, p.velocity.z) - MOVE.crouchSpeed) < 1e-6);
  assert.equal(p.crouch, true);
  assert.equal(p.eyeHeight, MOVE.crouchEyeHeight);
});

test('diagonal movement is normalized to walk speed', () => {
  const p = new Player({ x: 0, y: 0, z: 0 });
  step(p, input({ moveZ: 1, moveX: 1 }), 0.3);
  const speed = Math.hypot(p.velocity.x, p.velocity.z);
  assert.ok(speed <= MOVE.walkSpeed + 1e-6, `speed ${speed}`);
  assert.ok(speed > 3.5, `speed ${speed} too low`);
});

test('jump apex ≈ v²/2g ≈ 0.64m then lands on ground', () => {
  const p = new Player({ x: 0, y: 0, z: 0 });
  const air = input({ jump: true });
  p.update(DT, air); // consume jump edge
  assert.equal(p.onGround, false);
  let apex = 0;
  const steps = Math.round(1.2 / DT);
  let landedAt = -1;
  for (let i = 0; i < steps; i++) {
    p.update(DT, input());
    apex = Math.max(apex, p.position.y);
    if (p.onGround && landedAt < 0) landedAt = (i + 1) * DT;
  }
  const expectedApex = (MOVE.jumpSpeed * MOVE.jumpSpeed) / (2 * -MOVE.gravity);
  assert.ok(Math.abs(apex - expectedApex) < 0.03, `apex ${apex}`);
  const expectedAir = (2 * MOVE.jumpSpeed) / -MOVE.gravity;
  assert.ok(landedAt > 0 && Math.abs(landedAt - expectedAir) < 0.05, `airtime ${landedAt}`);
  assert.equal(p.position.y, 0);
  assert.equal(p.onGround, true);
});

test('yaw wraps into (-π, π]', () => {
  const p = new Player({ x: 0, y: 0, z: 0 });
  p.update(DT, input({ yawDelta: 7 }));
  assert.ok(p.yaw > -Math.PI && p.yaw <= Math.PI, `yaw ${p.yaw}`);
  p.update(DT, input({ yawDelta: -15 }));
  assert.ok(p.yaw > -Math.PI && p.yaw <= Math.PI, `yaw ${p.yaw}`);
  assert.equal(wrapPi(Math.PI), Math.PI);
  assert.equal(wrapPi(-Math.PI), Math.PI);
});

test('pitch clamps to ±85°', () => {
  const p = new Player({ x: 0, y: 0, z: 0 });
  p.update(DT, input({ pitchDelta: 2 }));
  assert.ok(Math.abs(p.pitch - MOVE.pitchLimit) < 1e-9);
  p.update(DT, input({ pitchDelta: -4 }));
  assert.ok(Math.abs(p.pitch + MOVE.pitchLimit) < 1e-9);
});

test('cannot leave map bounds (slides along the edge)', () => {
  const p = new Player({ x: 31.8, y: 0, z: 0 });
  const world = { isInside: isInsideBounds };
  step(p, input({ moveX: 1 }), 0.5, world); // strafe toward +x edge
  assert.ok(p.position.x <= MAP.bounds.w / 2, `x ${p.position.x}`);
  const p2 = new Player({ x: 0, y: 0, z: -19.8 });
  step(p2, input({ moveZ: 1 }), 0.5, world); // forward -z edge
  assert.ok(p2.position.z >= -MAP.bounds.d / 2, `z ${p2.position.z}`);
});

test('falls back to ground height when airborne', () => {
  const p = new Player({ x: 0, y: 3, z: 0 });
  p.onGround = false;
  step(p, input(), 1.0);
  assert.equal(p.position.y, 0);
  assert.equal(p.onGround, true);
  assert.equal(p.velocity.y, 0);
});

test('weapon speedMult (0.82 for gatling) scales walk speed proportionally', () => {
  const p = new Player({ x: 0, y: 0, z: 0 });
  step(p, input({ moveZ: 1 }), 0.3, { speedMult: 0.82 });
  const speed = Math.hypot(p.velocity.x, p.velocity.z);
  assert.ok(Math.abs(speed - MOVE.walkSpeed * 0.82) < 1e-6, `gatling speed ${speed}`);
});
