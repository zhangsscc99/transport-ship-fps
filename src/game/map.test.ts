import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAP, isInsideBounds, isInWater, spawnPoint, pointInBox, type Box } from './map.ts';

const EPS = 1e-6;

function rangeOverlap(aMin: number, aMax: number, bMin: number, bMax: number): boolean {
  return Math.min(aMax, bMax) - Math.max(aMin, bMin) > EPS;
}

function boxesOverlap(a: Box, b: Box): boolean {
  return (
    rangeOverlap(a.x - a.w / 2, a.x + a.w / 2, b.x - b.w / 2, b.x + b.w / 2) &&
    rangeOverlap(a.y, a.y + a.h, b.y, b.y + b.h) &&
    rangeOverlap(a.z - a.d / 2, a.z + a.d / 2, b.z - b.d / 2, b.z + b.d / 2)
  );
}

test('collider inventory: deck, 8 containers, 4 towers w/ stairs, pipes, crates', () => {
  const by = (k: Box['kind']) => MAP.boxes.filter((b) => b.kind === k);
  assert.equal(by('deck').length, 1);
  assert.equal(by('container').filter((b) => b.h === 2.6).length, 8, 'full containers');
  assert.equal(by('container').filter((b) => b.h === 0.55).length, 2, 'low covers');
  assert.equal(by('pipe').length, 6, '2 walls + 1 roof per pipe');
  assert.equal(by('rail').length, 20, '5 rails per tower ×4');
  const steps = by('tower').filter((b) => b.w === 0.6);
  assert.equal(steps.length, 40, '10 stair steps per tower');
  assert.ok(by('tower').some((b) => b.h === 3.0 && b.w > 3), 'tower bases exist');
  assert.ok(MAP.boxes.length > 80);
});

test('all spawn points are inside bounds and not inside any collider', () => {
  for (const team of ['A', 'B'] as const) {
    assert.equal(MAP.spawns[team === 'A' ? 'teamA' : 'teamB'].length, 5);
    for (let i = 0; i < 5; i++) {
      const [x, y, z] = spawnPoint(team, i);
      assert.ok(isInsideBounds(x, z), `spawn ${team}${i} out of bounds`);
      assert.equal(y, 0);
      for (const b of MAP.boxes) {
        assert.ok(!pointInBox(x, y + 0.5, z, b), `spawn ${team}${i} inside ${b.kind}`);
      }
    }
  }
  // spawnPoint wraps around the list
  assert.deepEqual(spawnPoint('A', 7), MAP.spawns.teamA[2]);
});

test('two pipes connect own half to enemy flank, walkable and roofed', () => {
  assert.equal(MAP.pipes.length, 2);
  const pipes = MAP.boxes.filter((b) => b.kind === 'pipe');
  for (const p of MAP.pipes) {
    const [fx, fz] = p.from;
    const [tx, tz] = p.to;
    const dist = Math.hypot(tx - fx, tz - fz);
    assert.ok(dist >= 25, `pipe too short: ${dist}`);
    assert.ok(isInsideBounds(fx, fz) && isInsideBounds(tx, tz));
    // corridor centre line is clear of solid boxes at torso height
    for (let t = 0; t <= 1; t += 0.1) {
      const x = fx + (tx - fx) * t;
      const z = fz + (tz - fz) * t;
      for (const b of MAP.boxes) {
        assert.ok(!pointInBox(x, 1.0, z, b), `pipe blocked at ${x},${z} by ${b.kind}`);
      }
      // walls flank the corridor on both sides
      assert.ok(
        pipes.some((b) => pointInBox(x - 1.05, 1.0, z, b)),
        `missing west wall near ${x},${z}`,
      );
      assert.ok(
        pipes.some((b) => pointInBox(x + 1.05, 1.0, z, b)),
        `missing east wall near ${x},${z}`,
      );
      // roof overhead
      assert.ok(pipes.some((b) => pointInBox(x, 2.1, z, b)), `missing roof near ${x},${z}`);
    }
  }
});

test('no solid boxes overlap (touching faces allowed)', () => {
  const solid = MAP.boxes.filter((b) => b.kind !== 'deck');
  for (let i = 0; i < solid.length; i++) {
    for (let j = i + 1; j < solid.length; j++) {
      assert.ok(
        !boxesOverlap(solid[i], solid[j]),
        `overlap: ${JSON.stringify(solid[i])} vs ${JSON.stringify(solid[j])}`,
      );
    }
  }
});

test('bounds and water checks', () => {
  assert.ok(isInsideBounds(0, 0));
  assert.ok(isInsideBounds(-31.9, 19.9));
  assert.ok(!isInsideBounds(33, 0));
  assert.ok(!isInsideBounds(0, -21));
  assert.ok(isInWater(-2.5));
  assert.ok(!isInWater(-2));
  assert.ok(!isInWater(0));
});

test('every box lies inside the world bounds', () => {
  for (const b of MAP.boxes) {
    assert.ok(isInsideBounds(b.x - b.w / 2, b.z - b.d / 2), `${b.kind} sticks out of bounds`);
    assert.ok(isInsideBounds(b.x + b.w / 2, b.z + b.d / 2), `${b.kind} sticks out of bounds`);
  }
});
