// Turns MAP's pure Box data into three.js geometry plus rich maritime props,
// harbour crane skyline, distant freighters, puddles, and decals.
// Same-kind geometry shares one InstancedMesh — high visual density at ~30 draw calls.

import * as THREE from 'three';
import { MAP, type Box } from '../game/map';
import { PALETTE } from './palette';
import { getMaterial, getStencilMaterial } from './materials';
import type { MaterialKind } from './materials';
import { createSea } from './sea';

export interface MapMeshes {
  group: THREE.Group;
  byKind: Record<Box['kind'], THREE.InstancedMesh>;
  sea: THREE.Mesh;
}

const mat4 = new THREE.Matrix4();
const quat = new THREE.Quaternion();
const euler = new THREE.Euler();
const vpos = new THREE.Vector3();
const vscl = new THREE.Vector3();

/** Write one TRS instance: full scale, y-rotation, optional x/z tilt. */
function setInst(
  mesh: THREE.InstancedMesh,
  i: number,
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
  ry = 0,
  rx = 0,
  rz = 0,
): void {
  euler.set(rx, ry, rz);
  quat.setFromEuler(euler);
  vpos.set(x, y, z);
  vscl.set(sx, sy, sz);
  mat4.compose(vpos, quat, vscl);
  mesh.setMatrixAt(i, mat4);
}

/**
 * Per-instance tiling data for the patched container material:
 * aSize = world dims so ribs repeat every ~2.4 m per face,
 * aUvOffset = golden-ratio walk so neighbouring boxes never share tile phase.
 */
function addContainerUvs(
  geo: THREE.BufferGeometry,
  dims: readonly (readonly [number, number, number])[],
  salt: number,
): void {
  const size = new Float32Array(dims.length * 3);
  const off = new Float32Array(dims.length * 2);
  dims.forEach(([w, h, d], i) => {
    size[i * 3] = w;
    size[i * 3 + 1] = h;
    size[i * 3 + 2] = d;
    off[i * 2] = ((i + salt) * 0.618034) % 1;
    off[i * 2 + 1] = ((i + salt) * 0.414214) % 1;
  });
  geo.setAttribute('aSize', new THREE.InstancedBufferAttribute(size, 3));
  geo.setAttribute('aUvOffset', new THREE.InstancedBufferAttribute(off, 2));
}

/** Deterministic ±8% brightness jitter so neighbouring boxes never match. */
function tintJitter(i: number): number {
  return 0.92 + (0.16 * (((i * 2654435761) >>> 8) % 1024)) / 1023;
}

/** Guard-rail runs along deck edges: [x0, x1] at fixed z. Gaps = mooring bays. */
const RAIL_RUNS: { x0: number; x1: number; z: number }[] = [
  { x0: -32, x1: -14, z: 19.65 },
  { x0: -6, x1: 32, z: 19.65 },
  { x0: -32, x1: 6, z: -19.65 },
  { x0: 14, x1: 32, z: -19.65 },
];
const RAIL_H = 1.05;

function buildRails(group: THREE.Group): void {
  const postGeo = new THREE.CylinderGeometry(0.036, 0.036, RAIL_H, 6);
  const baseGeo = new THREE.BoxGeometry(0.14, 0.04, 0.14);
  const barGeo = new THREE.BoxGeometry(1, 1, 1);
  const mat = getMaterial('rail');

  const spacings = RAIL_RUNS.map((r) => Math.max(1, Math.round((r.x1 - r.x0) / 2.6)));
  const postCount = spacings.reduce((n, s) => n + s + 1, 0);

  const posts = new THREE.InstancedMesh(postGeo, mat, postCount);
  const bases = new THREE.InstancedMesh(baseGeo, mat, postCount);
  const bars = new THREE.InstancedMesh(barGeo, mat, RAIL_RUNS.length * 2);
  posts.name = 'rail-posts';
  bases.name = 'rail-bases';
  bars.name = 'rail-bars';

  let pi = 0;
  let bi = 0;
  RAIL_RUNS.forEach((r, ri) => {
    const n = spacings[ri];
    for (let i = 0; i <= n; i++) {
      const x = r.x0 + ((r.x1 - r.x0) * i) / n;
      setInst(posts, pi, x, RAIL_H / 2, r.z, 1, 1, 1);
      setInst(bases, pi, x, 0.02, r.z, 1, 1, 1);
      pi++;
    }
    const len = r.x1 - r.x0;
    const cx = (r.x0 + r.x1) / 2;
    setInst(bars, bi++, cx, RAIL_H - 0.05, r.z, len, 0.045, 0.045);
    setInst(bars, bi++, cx, 0.55, r.z, len, 0.045, 0.045);
  });

  posts.castShadow = bars.castShadow = true;
  posts.receiveShadow = bases.receiveShadow = bars.receiveShadow = true;
  group.add(posts, bases, bars);
}

/** Double-bitt cast-steel mooring bollards ×16 along deck perimeters. */
function buildBollards(group: THREE.Group): void {
  const mat = getMaterial('bollard');
  const postGeo = new THREE.CylinderGeometry(0.14, 0.18, 0.56, 10);
  const capGeo = new THREE.CylinderGeometry(0.17, 0.14, 0.08, 10);
  const baseGeo = new THREE.BoxGeometry(0.95, 0.08, 0.44);

  const spots: [number, number, number][] = [];
  for (const z of [19.2, -19.2]) {
    for (const x of [-26, -18, -10.5, -5.5, 4, 11.5, 19, 26]) {
      spots.push([x, z, 0]);
    }
  }

  const posts = new THREE.InstancedMesh(postGeo, mat, spots.length * 2);
  const caps = new THREE.InstancedMesh(capGeo, mat, spots.length * 2);
  const bases = new THREE.InstancedMesh(baseGeo, mat, spots.length);
  posts.name = 'bollard-posts';
  caps.name = 'bollard-caps';
  bases.name = 'bollard-bases';

  let pi = 0;
  spots.forEach(([x, z, ry], i) => {
    setInst(bases, i, x, 0.04, z, 1, 1, 1, ry);
    for (const dx of [-0.24, 0.24]) {
      setInst(posts, pi, x + dx, 0.32, z, 1, 1, 1, ry);
      setInst(caps, pi, x + dx, 0.62, z, 1, 1, 1, ry);
      pi++;
    }
  });
  posts.castShadow = caps.castShadow = true;
  posts.receiveShadow = caps.receiveShadow = bases.receiveShadow = true;
  group.add(posts, caps, bases);
}

/** Painted warning lines ×4 — scuffed yellow planes just above the deck. */
function buildDeckLines(group: THREE.Group): void {
  const geo = new THREE.PlaneGeometry(1, 1);
  const mesh = new THREE.InstancedMesh(geo, getMaterial('paint'), 4);
  mesh.name = 'deck-lines';
  const lines: [number, number, number, boolean][] = [
    [0, 15.5, 14, true],
    [0, -15.5, 14, true],
    [-20, 0, 9, false],
    [20, 0, 9, false],
  ];
  lines.forEach(([x, z, len, alongX], i) => {
    if (alongX) setInst(mesh, i, x, 0.018, z, len, 0.4, 1, 0, -Math.PI / 2);
    else setInst(mesh, i, x, 0.018, z, 0.4, len, 1, 0, -Math.PI / 2);
  });
  mesh.receiveShadow = true;
  group.add(mesh);
}

/** Wooden pallets ×26 (including 2-high stacks) tucked near containers & aprons. */
function buildPallets(group: THREE.Group): void {
  const geo = new THREE.BoxGeometry(1.15, 0.13, 0.92);
  const spots: [number, number, number, number][] = [
    // (x, yCenter, z, ry) — foreground & mid-deck clusters visible from spawn
    [-15.6, 0.065, 12.8, 0.12],
    [-15.6, 0.195, 12.8, 0.18],
    [-0.3, 0.065, 12.8, -0.22],
    [-0.3, 0.195, 12.8, -0.15],
    [-10.2, 0.065, 12.9, 0.05],
    [-1.8, 0.065, 14.2, 0.35],
    [-14.2, 0.065, 7.2, 0.4],
    [-10.5, 0.065, 5.2, 0.85],
    [-3.2, 0.065, 5.8, -0.3],
    [2.4, 0.065, 9.6, 0.6],
    [9.8, 0.065, 5.6, 0.15],
    [9.8, 0.195, 5.6, 0.22],
    [13.6, 0.065, 8.2, 1.9],
    [-9.4, 0.065, -5.8, 1.2],
    [-9.4, 0.195, -5.8, 1.15],
    [-2.0, 0.065, -8.5, 0.2],
    [6.8, 0.065, -7.2, 0.8],
    [14.2, 0.065, -6.4, 0.45],
    [19.5, 0.065, -4.8, 0.3],
    [-19.2, 0.065, 6.2, 0.5],
    [-22.0, 0.065, -12.0, 1.7],
    [21.8, 0.065, 10.2, 0.9],
    [0.4, 0.065, -14.8, 0.5],
    [10.2, 0.065, 1.2, 1.9],
    [-14.2, 0.065, -13.0, 0.7],
    [16.2, 0.065, 16.5, 0.2],
  ];
  const mesh = new THREE.InstancedMesh(geo, getMaterial('wood'), spots.length);
  mesh.name = 'pallets';
  spots.forEach(([x, y, z, ry], i) => setInst(mesh, i, x, y, z, 1, 1, 1, ry));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
}

/** Metallic oil drums ×28 in industrial 2–4 drum clusters across the deck. */
function buildBarrels(group: THREE.Group): void {
  const geo = new THREE.CylinderGeometry(0.3, 0.3, 0.86, 12);
  const spots: [number, number, number][] = [
    // Near Spawn A container flanks (clearly visible in vista & container shots)
    [-15.4, 11.1, 0.2],
    [-15.9, 10.4, 1.1],
    [-15.4, 9.7, 0.7],
    [-0.4, 11.2, 0.4],
    [0.2, 10.6, 1.6],
    [-0.3, 9.9, 0.9],
    // Mid-deck container corners
    [-14.1, 4.2, 0.3],
    [-14.3, 3.4, 1.8],
    [-9.5, -3.4, 0.5],
    [-9.8, -4.2, 1.2],
    [2.5, 4.8, 0.6],
    [2.3, 4.0, 2.1],
    [9.6, 3.6, 0.2],
    [10.2, 4.1, 1.5],
    // Far-deck / B-side clusters
    [14.2, -4.4, 0.8],
    [14.4, -3.6, 1.9],
    [0.4, -10.8, 0.4],
    [1.0, -11.4, 1.3],
    [15.6, -10.6, 0.9],
    [15.8, -11.4, 2.2],
    // Perimeter clusters
    [-24.0, 4.0, 0.2],
    [-24.6, 3.1, 1.1],
    [-23.4, 3.4, 0.7],
    [24.0, -6.0, 0.4],
    [24.7, -5.3, 1.5],
    [23.3, -5.5, 0.9],
    [10.0, 9.4, 0.1],
    [10.8, 10.0, 1.9],
  ];
  const mesh = new THREE.InstancedMesh(geo, getMaterial('barrel'), spots.length);
  mesh.name = 'barrels';
  const tints = [
    PALETTE.rust,
    PALETTE.container[0],
    PALETTE.container[1],
    PALETTE.container[2],
    PALETTE.container[3],
    PALETTE.tower[1],
  ];
  const c = new THREE.Color();
  spots.forEach(([x, z, ry], i) => {
    setInst(mesh, i, x, 0.43, z, 1, 1, 1, ry);
    mesh.setColorAt(i, c.set(tints[i % tints.length]).multiplyScalar(tintJitter(i + 5)));
  });
  mesh.instanceColor!.needsUpdate = true;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
}

/** Wooden-flange cable reels ×8 with metallic steel axles. */
function buildReels(group: THREE.Group): void {
  const spots: [number, number, number][] = [
    [-16.2, 8.2, 0.35],
    [1.4, 12.6, 1.05],
    [-11.8, -4.6, 0.7],
    [11.4, 4.6, 1.35],
    [-20.0, -2.5, 0.3],
    [21.0, 12.0, 1.2],
    [13.5, -14.5, 0.8],
    [-13.5, 17.0, 0.5],
  ];
  const drum = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.55, 0.55, 0.5, 14),
    getMaterial('wood'),
    spots.length,
  );
  const hub = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.15, 0.15, 0.68, 10),
    getMaterial('pipe'),
    spots.length,
  );
  drum.name = 'reel-drums';
  hub.name = 'reel-hubs';
  spots.forEach(([x, z, ry], i) => {
    setInst(drum, i, x, 0.55, z, 1, 1, 1, ry, 0, Math.PI / 2);
    setInst(hub, i, x, 0.55, z, 1, 1, 1, ry, 0, Math.PI / 2);
  });
  drum.castShadow = hub.castShadow = true;
  drum.receiveShadow = hub.receiveShadow = true;
  group.add(drum, hub);
}

/** Braced wooden cargo crates ×24 (some stacked on pallets beside containers). */
function buildCrates(group: THREE.Group): void {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  // (x, yBase, z, sx, sy, sz, ry)
  const spots: [number, number, number, number, number, number, number][] = [
    // Tucked near A-side containers & pallets (immediately readable from spawn)
    [-15.6, 0.26, 12.8, 0.72, 0.68, 0.72, 0.15],
    [-14.3, 0, 12.7, 0.78, 0.64, 0.72, -0.18],
    [-0.3, 0.26, 12.8, 0.68, 0.62, 0.68, -0.2],
    [0.7, 0, 12.9, 0.74, 0.56, 0.74, 0.45],
    [-10.3, 0.13, 12.9, 0.58, 0.52, 0.58, 0.12],
    // Mid-deck container flanks
    [-14.1, 0, 5.4, 0.82, 0.72, 0.76, 0.25],
    [-14.1, 0.72, 5.4, 0.52, 0.48, 0.52, 0.65],
    [-9.5, 0, -2.3, 0.76, 0.68, 0.76, 0.3],
    [2.5, 0, 5.9, 0.72, 0.64, 0.72, 1.1],
    [9.8, 0.26, 5.6, 0.75, 0.66, 0.72, 0.2],
    [3.0, 0, 8.6, 0.66, 0.64, 0.66, 1.8],
    [-3.0, 0, -12.5, 0.72, 0.70, 0.72, 1.1],
    // Outer lanes & B-side
    [-19.0, 0, 9.5, 0.9, 0.9, 0.9, 0.2],
    [-18.5, 0, 8.6, 0.55, 0.55, 0.55, 0.9],
    [13.0, 0, -4.0, 0.8, 0.7, 0.8, 0.4],
    [17.0, 0, 6.5, 1.0, 0.8, 0.7, 0.6],
    [23.0, 0, -12.0, 0.75, 0.75, 0.75, 0.2],
    [-25.0, 0, -9.0, 0.85, 0.6, 0.85, 0.8],
    [8.0, 0, 14.5, 0.7, 0.7, 0.7, 1.4],
    [-15.0, 0, -6.5, 0.9, 0.55, 0.9, 0.3],
    [15.4, 0, -12.5, 0.82, 0.74, 0.78, 0.35],
    [0.5, 0, -12.4, 0.68, 0.62, 0.68, -0.5],
    [-9.4, 0.26, -5.8, 0.7, 0.64, 0.7, 1.18],
    [18.8, 0, -9.2, 0.78, 0.66, 0.78, 0.5],
  ];
  const mesh = new THREE.InstancedMesh(geo, getMaterial('crate'), spots.length);
  mesh.name = 'crates';
  spots.forEach(([x, yBase, z, sx, sy, sz, ry], i) =>
    setInst(mesh, i, x, yBase + sy / 2, z, sx, sy, sz, ry),
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
}

/**
 * Extra containers beyond MAP's colliders — visual only. Three second-layer
 * stacks sit on inner containers; two more squat at the deck ends.
 */
function buildStackedContainers(group: THREE.Group): void {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  // (x, yCenter, z, sx, sy, sz, ry, rz, paletteIdx)
  // paletteIdx: 0=rust red, 1=deep blue, 2=olive green, 3=ochre
  const boxes: [number, number, number, number, number, number, number, number, number][] = [
    [-6, 3.9, -4, 6, 2.6, 2.5, 0.04, 0, 2], // olive stack on ochre (-6,-4)
    [6, 3.9, 4, 6, 2.6, 2.5, -0.04, 0, 1], // deep blue stack on red (6,4)
    [16, 4.0, -2, 6, 2.6, 2.5, 0.55, 0.08, 0], // askew rust-red on blue (16,-2)
    [29.8, 1.3, 18, 4, 2.6, 2.2, 0.1, 0, 2], // bow-side olive box
    [-29.8, 1.3, -18, 4, 2.6, 2.2, -0.08, 0, 0], // stern-side red box
  ];
  const mesh = new THREE.InstancedMesh(geo, getMaterial('container'), boxes.length);
  mesh.name = 'containers-stacked';
  const c = new THREE.Color();
  boxes.forEach(([x, y, z, sx, sy, sz, ry, rz, ci], i) => {
    setInst(mesh, i, x, y, z, sx, sy, sz, ry, 0, rz);
    mesh.setColorAt(i, c.set(PALETTE.container[ci]).multiplyScalar(tintJitter(i + 29)));
  });
  addContainerUvs(geo, boxes.map((b) => [b[3], b[4], b[5]] as [number, number, number]), 7);
  mesh.instanceColor!.needsUpdate = true;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
}

/** Metallic deck drainage grates ×6 along the deck drainage runs. */
function buildGrates(group: THREE.Group): void {
  const geo = new THREE.PlaneGeometry(1.35, 1.35);
  const spots: [number, number][] = [
    [1.0, 7.5],
    [-9.0, -6.5],
    [-8.0, 7.2],
    [8.0, -7.2],
    [-2.5, 14.2],
    [2.5, -14.2],
  ];
  const mesh = new THREE.InstancedMesh(geo, getMaterial('grate'), spots.length);
  mesh.name = 'grates';
  spots.forEach(([x, z], i) => setInst(mesh, i, x, 0.014, z, 1, 1, 1, 0, -Math.PI / 2));
  mesh.receiveShadow = true;
  group.add(mesh);
}

/** Soft contact shadows tucked under grounded colliders (renderOrder=1). */
function buildAoBlobs(group: THREE.Group): void {
  const geo = new THREE.PlaneGeometry(1, 1);
  const list = MAP.boxes.filter(
    (b) =>
      b.y === 0 &&
      ((b.w >= 1.5 && b.d >= 1.5 && (b.kind === 'container' || b.kind === 'tower')) ||
        b.kind === 'pipe'),
  );
  const mesh = new THREE.InstancedMesh(geo, getMaterial('ao'), list.length);
  mesh.name = 'ao-blobs';
  list.forEach((b, i) =>
    setInst(mesh, i, b.x, 0.010, b.z, b.w + 0.9, b.d + 0.9, 1, 0, -Math.PI / 2),
  );
  mesh.renderOrder = 1;
  group.add(mesh);
}

/** Contact-shadow feather strips hugging grounded collider bases (renderOrder=2). */
function buildAoEdges(group: THREE.Group): void {
  const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const BAND = 0.65;
  const list = MAP.boxes.filter(
    (b) =>
      b.y === 0 &&
      (((b.kind === 'container' || b.kind === 'tower') && b.w >= 1.5 && b.d >= 1.5) ||
        b.kind === 'pipe'),
  );
  const spots: { x: number; z: number; w: number; d: number }[] = list.map((b) => ({
    x: b.x,
    z: b.z,
    w: b.w,
    d: b.d,
  }));
  spots.push({ x: 29.8, z: 18, w: 4, d: 2.2 }, { x: -29.8, z: -18, w: 4, d: 2.2 });

  const mesh = new THREE.InstancedMesh(geo, getMaterial('aoEdge'), spots.length * 4);
  mesh.name = 'ao-edges';
  let i = 0;
  for (const b of spots) {
    const hw = b.w / 2;
    const hd = b.d / 2;
    setInst(mesh, i++, b.x + hw + BAND / 2, 0.012, b.z, b.d + 2 * BAND, 1, BAND, Math.PI / 2);
    setInst(mesh, i++, b.x - hw - BAND / 2, 0.012, b.z, b.d + 2 * BAND, 1, BAND, -Math.PI / 2);
    setInst(mesh, i++, b.x, 0.012, b.z + hd + BAND / 2, b.w + 2 * BAND, 1, BAND, 0);
    setInst(mesh, i++, b.x, 0.012, b.z - hd - BAND / 2, b.w + 2 * BAND, 1, BAND, Math.PI);
  }
  mesh.renderOrder = 2;
  group.add(mesh);
}

/** Hull topsides: four steel side plates + antifouling waterline band. */
function buildHull(group: THREE.Group): void {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const steel = new THREE.InstancedMesh(geo, getMaterial('hull'), 4);
  const band = new THREE.InstancedMesh(geo, getMaterial('hullBand'), 4);
  steel.name = 'hull-sides';
  band.name = 'hull-band';
  const TOP = 0.06;
  const BOT = -2.55;
  const HY = (TOP + BOT) / 2;
  const HH = TOP - BOT;
  const BTOP = -1.55;
  const BY = (BTOP + BOT) / 2;
  const BH = BTOP - BOT;
  let i = 0;
  for (const s of [1, -1]) {
    setInst(steel, i, 0, HY, s * 20.07, 64.6, HH, 0.14);
    setInst(band, i, 0, BY, s * 20.09, 64.6, BH, 0.16);
    i++;
  }
  for (const s of [1, -1]) {
    setInst(steel, i, s * 32.07, HY, 0, 0.14, HH, 40.4);
    setInst(band, i, s * 32.09, BY, 0, 0.16, BH, 40.4);
    i++;
  }
  steel.castShadow = false;
  band.castShadow = false;
  steel.receiveShadow = band.receiveShadow = true;
  group.add(steel, band);
}

/**
 * Distant maritime silhouettes: two freighters anchored along the misty
 * horizon (starboard-bow & port-bow) with warm glowing bridge windows.
 */
function buildDistantShips(group: THREE.Group): void {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const ships: [number, number, number, number][] = [
    // (cx, cz, ry, scale)
    [104, -56, -0.45, 1.0], // starboard-bow freighter near sun horizon
    [-92, -108, 0.24, 1.15], // port-bow freighter across main vista
  ];
  const mesh = new THREE.InstancedMesh(geo, getMaterial('crane'), ships.length * 9);
  mesh.name = 'distant-ships';
  const win = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), getMaterial('window'), ships.length * 3);
  win.name = 'distant-windows';

  let i = 0;
  let wi = 0;
  for (const [cx, cz, ry, s] of ships) {
    const cos = Math.cos(ry);
    const sin = Math.sin(ry);
    const P = (x: number, y: number, z: number, sx: number, sy: number, sz: number): void => {
      const wx = cx + (x * cos + z * sin) * s;
      const wz = cz + (-x * sin + z * cos) * s;
      setInst(mesh, i++, wx, -2 + y * s, wz, sx * s, sy * s, sz * s, ry);
    };
    P(0, 2.2, 0, 50, 5.0, 8.8); // hull
    P(25.5, 3.5, 0, 6.5, 2.8, 6.6); // raised bow
    P(-18.5, 7.4, 0, 9.2, 9.4, 7.8); // aft superstructure
    P(-18.5, 12.6, 0, 3.2, 2.6, 3.0); // funnel
    P(-18.5, 15.6, 0, 0.5, 4.4, 0.5); // mast
    P(4.0, 5.2, 0, 14, 3.0, 7.2); // mid container stack
    P(15.0, 4.6, 0, 7.5, 2.0, 6.4); // fore container stack
    P(-6.5, 5.2, 0, 9.5, 2.8, 7.0); // aft container stack
    P(-18.5, 6.0, 0, 10.8, 0.9, 8.2); // bridge wing overhang

    // bridge windows facing origin
    const bx = cx + -13.6 * cos * s;
    const bz = cz + 13.6 * sin * s;
    const wyaw = Math.atan2(-bx, -bz);
    for (let k = 0; k < 3; k++) {
      const off = (k - 1) * 1.9 * s;
      setInst(win, wi++, bx + off * Math.cos(wyaw), -2 + 8.0 * s, bz - off * Math.sin(wyaw), 1.15 * s, 0.72 * s, 1, wyaw);
    }
  }
  group.add(mesh, win);
}

/** Metallic pipe bundles ×8 (24 pipes) near deck flanks & corridors. */
function buildPipeBundles(group: THREE.Group): void {
  const geo = new THREE.CylinderGeometry(0.13, 0.13, 3.6, 10);
  geo.rotateZ(Math.PI / 2);
  const spots: [number, number, number][] = [
    [-27, 12, 0.15],
    [27, -12, -0.1],
    [-22, -15, 1.62],
    [22, 15, 1.55],
    [-9, 18.2, 0.05],
    [9, -18.2, -0.08],
    [-19.5, 13.2, 0.06],
    [19.5, -13.2, -0.06],
  ];
  const mesh = new THREE.InstancedMesh(geo, getMaterial('pipe'), spots.length * 3);
  mesh.name = 'pipe-bundles';
  let i = 0;
  for (const [x, z, ry] of spots) {
    const dx = Math.sin(ry) * 0.23;
    const dz = Math.cos(ry) * 0.23;
    setInst(mesh, i++, x - dx, 0.13, z - dz, 1, 1, 1, ry);
    setInst(mesh, i++, x + dx, 0.13, z + dz, 1, 1, 1, ry);
    setInst(mesh, i++, x, 0.36, z, 1, 1, 1, ry);
  }
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
}

/** Braided mooring-line rope coils ×14 flaked near bollards & container bases. */
function buildCoils(group: THREE.Group): void {
  const geo = new THREE.TorusGeometry(0.32, 0.1, 8, 18);
  geo.rotateX(-Math.PI / 2);
  const spots: [number, number][] = [
    [-10.6, 18.2],
    [-5.4, 18.2],
    [-1.4, 13.2],
    [-14.6, 9.2],
    [-6.2, 6.2],
    [4.4, 18.2],
    [11.2, 12.6],
    [10.4, -18.2],
    [-7.0, -18.4],
    [-24.0, 18.3],
    [25.5, 6.8],
    [-16.5, -3.4],
    [18.6, -9.8],
    [1.4, -13.2],
  ];
  const mesh = new THREE.InstancedMesh(geo, getMaterial('rope'), spots.length);
  mesh.name = 'rope-coils';
  spots.forEach(([x, z], i) => setInst(mesh, i, x, 0.1, z, 1, 1, 1, i * 0.7));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
}

/** Reflective-collared safety cones ×14 marking lane corners & work areas. */
function buildCones(group: THREE.Group): void {
  const geo = new THREE.ConeGeometry(0.16, 0.52, 10);
  const spots: [number, number][] = [
    [-9.2, 12.55],
    [-6.8, 12.55],
    [-13.5, 8.2],
    [-4.0, 7.4],
    [2.6, 7.6],
    [10.8, -7.6],
    [4.6, -7.9],
    [9.2, -12.55],
    [6.8, -12.55],
    [-21.5, 12.3],
    [21.8, -12.4],
    [0.5, 16.9],
    [-0.6, -16.8],
    [-15.2, 14.0],
  ];
  const mesh = new THREE.InstancedMesh(geo, getMaterial('cone'), spots.length);
  mesh.name = 'cones';
  spots.forEach(([x, z], i) => setInst(mesh, i, x, 0.26, z, 1, 1, 1, i * 0.9));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
}

/** Painted hazard stripes + tyre scuffs (renderOrder=3, below puddles). */
function buildMarkings(group: THREE.Group): void {
  const stripeGeo = new THREE.PlaneGeometry(1, 1);
  const stripes = new THREE.InstancedMesh(stripeGeo, getMaterial('stripe'), 6);
  stripes.name = 'hazard-stripes';
  const bands: [number, number, number, number, number][] = [
    [-10, 19.15, 8, 1.1, 0],
    [10, -19.15, 8, 1.1, 0],
    [-27.6, 7.5, 1.2, 5, Math.PI / 2],
    [27.6, -7.5, 1.2, 5, Math.PI / 2],
    [-14.2, -1.8, 2.6, 1.0, 0.12],
    [14.2, 1.8, 2.6, 1.0, -0.12],
  ];
  bands.forEach(([x, z, w, d, ry], i) =>
    setInst(stripes, i, x, 0.017, z, w, d, 1, ry, -Math.PI / 2),
  );
  stripes.receiveShadow = true;
  group.add(stripes);

  const skids = new THREE.InstancedMesh(new THREE.PlaneGeometry(4.2, 3.4), getMaterial('skid'), 4);
  skids.name = 'skid-marks';
  const spots: [number, number, number][] = [
    [-7, 4.5, 0.4],
    [9, -4.2, 2.2],
    [18.5, 2.5, -0.6],
    [-18.5, -4.5, 1.1],
  ];
  spots.forEach(([x, z, ry], i) => setInst(skids, i, x, 0.019, z, 1, 1, 1, ry, -Math.PI / 2));
  skids.renderOrder = 3;
  group.add(skids);
}

/**
 * Clean unclipped shipping-number stencils on ground + stacked containers.
 * Four InstancedMeshes (one per atlas cell).
 */
function buildStencils(group: THREE.Group): void {
  const geo = new THREE.PlaneGeometry(1.42, 1.08);
  const cells: THREE.InstancedMesh[] = [];
  const used: number[] = [];
  for (let k = 0; k < 4; k++) {
    const m = new THREE.InstancedMesh(geo, getStencilMaterial(k), 10);
    m.name = `stencil-${k}`;
    cells.push(m);
    used.push(0);
  }
  const list: { x: number; z: number; w: number; h: number; d: number; y: number }[] = [];
  for (const b of MAP.boxes) {
    if (b.kind === 'container' && b.h >= 2.5 && Math.max(b.w, b.d) >= 4) {
      list.push({ x: b.x, z: b.z, w: b.w, h: b.h, d: b.d, y: b.y });
    }
  }
  // decorative end & level stacked containers
  list.push(
    { x: 29.8, z: 18, w: 4, h: 2.6, d: 2.2, y: 0 },
    { x: -29.8, z: -18, w: 4, h: 2.6, d: 2.2, y: 0 },
    { x: -6, z: -4, w: 6, h: 2.6, d: 2.5, y: 2.6 },
    { x: 6, z: 4, w: 6, h: 2.6, d: 2.5, y: 2.6 },
  );
  let n = 0;
  for (const b of list) {
    const y = b.y + b.h * 0.56;
    const outs =
      b.w >= b.d
        ? ([[0, b.d / 2 + 0.025, 0], [0, -b.d / 2 - 0.025, Math.PI]] as const)
        : ([[b.w / 2 + 0.025, 0, Math.PI / 2], [-b.w / 2 - 0.025, 0, -Math.PI / 2]] as const);
    for (const [ox, oz, ry] of outs) {
      const k = n % 4;
      setInst(cells[k], used[k]++, b.x + ox, y, b.z + oz, 1, 1, 1, ry);
      n++;
    }
  }
  cells.forEach((m, k) => {
    m.count = used[k];
    m.instanceMatrix.needsUpdate = true;
    m.renderOrder = 5;
    group.add(m);
  });
}

/**
 * Distant harbour crane skyline (5 gantry cranes fading smoothly into FogExp2)
 * + lit metallic on-ship bow mast & stern deck crane.
 */
function buildCranes(group: THREE.Group): void {
  const geo = new THREE.BoxGeometry(1, 1, 1);

  // 5 distant harbour gantry cranes arranged across the horizon (3–4 visible in main vista)
  const cranes: [number, number, number, number][] = [
    // (cx, cz, scale, ry)
    [-58, -104, 1.35, 0.25], // port-bow skyline crane
    [-12, -124, 1.48, -0.14], // central distant crane framed through the mid-deck gap
    [34, -108, 1.38, 0.42], // starboard-bow crane backlit near the sun horizon
    [84, -64, 1.24, 0.55], // starboard-flank harbour crane
    [-86, -34, 1.08, -0.62], // port-flank harbour crane
  ];
  const PARTS_PER_CRANE = 11;
  const distant = new THREE.InstancedMesh(geo, getMaterial('crane'), cranes.length * PARTS_PER_CRANE);
  distant.name = 'harbour-cranes';

  const beacons = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.45, 8, 6),
    getMaterial('lampRed'),
    cranes.length,
  );
  beacons.name = 'crane-beacons';

  let ci = 0;
  cranes.forEach(([cx, cz, s, ry], idx) => {
    const cos = Math.cos(ry);
    const sin = Math.sin(ry);
    const P = (x: number, y: number, z: number, sx: number, sy: number, sz: number, rz = 0): void => {
      const wx = cx + (x * cos + z * sin) * s;
      const wz = cz + (-x * sin + z * cos) * s;
      setInst(distant, ci++, wx, -2 + y * s, wz, sx * s, sy * s, sz * s, ry, 0, rz);
    };
    P(-5.0, 10.0, -2.2, 1.2, 20, 1.2); // front-left leg
    P(5.0, 10.0, -2.2, 1.2, 20, 1.2); // front-right leg
    P(-5.0, 10.0, 2.2, 1.2, 20, 1.2); // rear-left leg
    P(5.0, 10.0, 2.2, 1.2, 20, 1.2); // rear-right leg
    P(0.0, 9.5, 0.0, 11.2, 1.1, 4.8); // mid portal cross-bracing
    P(0.0, 20.4, 0.0, 13.5, 1.8, 5.2); // top bridge girder
    P(11.5, 22.8, 0.0, 24.0, 1.1, 1.6, 0.28); // long harbour boom/jib
    P(-8.5, 21.0, 0.0, 7.5, 1.5, 2.2); // counter-jib + machinery house
    P(0.0, 18.0, 2.8, 2.6, 2.2, 2.2); // operator cab
    P(1.5, 27.5, 0.0, 1.4, 13.5, 1.4, -0.06); // apex A-frame tower
    P(10.5, 29.5, 0.0, 21.0, 0.45, 0.45, -0.34); // forestay tie-rod

    // red aviation obstruction light at crane apex
    const bx = cx + 1.5 * cos * s;
    const bz = cz - 1.5 * sin * s;
    setInst(beacons, idx, bx, -2 + 34.4 * s, bz, 1, 1, 1);
  });
  group.add(distant, beacons);

  // On-ship steel bow mast (+x tip) & stern deck crane (-x tip): lit metallic PBR
  const onShip = new THREE.InstancedMesh(geo, getMaterial('mast'), 7);
  onShip.name = 'ship-masts';
  setInst(onShip, 0, 33.8, 5.5, 0, 0.4, 14, 0.4); // bow mast pole
  setInst(onShip, 1, 33.8, 8.2, 0, 0.22, 0.22, 3.4); // bow mast yard
  setInst(onShip, 2, 33.8, 10.6, 0, 0.08, 4.4, 0.08); // antenna whip
  setInst(onShip, 3, 33.8, 7.2, 0, 1.2, 0.14, 1.2); // watch platform
  setInst(onShip, 4, -34.0, 0.8, 0, 0.9, 3.2, 0.9); // stern pedestal
  setInst(onShip, 5, -34.6, 4.6, 0, 0.45, 8.5, 0.45, 0.2, 0, -0.52); // stern crane jib
  setInst(onShip, 6, -33.4, 2.2, 0, 1.5, 1.2, 1.2); // stern counterweight
  onShip.castShadow = true;
  onShip.receiveShadow = true;
  group.add(onShip);
}

/** Self-lit local light anchors + subtle point pools. */
function buildLightAnchors(group: THREE.Group): void {
  const bulbGeo = new THREE.SphereGeometry(0.13, 8, 6);
  const warm = new THREE.InstancedMesh(bulbGeo, getMaterial('lamp'), 4);
  warm.name = 'anchor-warm';
  const warmSpots: [number, number, number][] = [
    [23.65, 2.9, -11.65],
    [-23.65, 2.9, 11.65],
    [3.05, 2.72, 5.32],
    [-3.05, 2.72, -5.32],
  ];
  warmSpots.forEach(([x, y, z], i) => setInst(warm, i, x, y, z, 1, 1, 1));
  group.add(warm);
  const warmLight: [number, number, number, number][] = [
    [23.65, 2.8, -11.65, 2.4],
    [-23.65, 2.8, 11.65, 2.4],
    [3.05, 2.72, 5.45, 1.6],
    [-3.05, 2.72, -5.45, 1.6],
  ];
  for (const [x, y, z, i] of warmLight) {
    const l = new THREE.PointLight(PALETTE.lampWarm, i, 13, 2);
    l.position.set(x, y, z);
    group.add(l);
  }

  const red = new THREE.InstancedMesh(bulbGeo, getMaterial('lampRed'), 2);
  red.name = 'anchor-red';
  for (const z of [1.6, -1.6]) {
    setInst(red, z > 0 ? 0 : 1, 33.8, 8.2, z, 1, 1, 1);
    const l = new THREE.PointLight(PALETTE.lampRed, 2, 10, 2);
    l.position.set(33.8, 8.2, z);
    group.add(l);
  }
  group.add(red);
}

/**
 * Standing-water films ×7 — organic multi-lobe alpha puddles reflecting the
 * PMREM sky. renderOrder = 4 sits cleanly above AO blobs/edges and skids.
 */
function buildPuddles(group: THREE.Group): void {
  const geo = new THREE.PlaneGeometry(1, 1);
  // (x, z, sx, sz, in-plane yaw) — kept in open deck patches away from container bases
  const spots: [number, number, number, number, number][] = [
    [-8.0, 14.1, 3.2, 2.6, 0.28], // foreground Spawn A vista reflection
    [-0.5, 8.2, 2.6, 3.2, -0.45], // central deck puddle (also puddle-check target)
    [6.6, 13.6, 3.0, 2.2, 0.85], // A-side right apron
    [-12.8, 5.6, 2.5, 3.1, 0.18], // west lane
    [0.6, 2.6, 2.8, 2.3, -0.7], // mid-ship lane
    [-4.8, -8.2, 2.7, 2.4, 0.55], // B-side central
    [7.8, -13.6, 3.0, 2.4, -0.32], // B-side apron
  ];
  const mesh = new THREE.InstancedMesh(geo, getMaterial('puddle'), spots.length);
  mesh.name = 'puddles';
  spots.forEach(([x, z, sx, sz, yaw], i) =>
    setInst(mesh, i, x, 0.024, z, sx, sz, 1, 0, -Math.PI / 2, yaw),
  );
  mesh.receiveShadow = true;
  mesh.renderOrder = 4;
  group.add(mesh);
}

/** Lit openings — stern hatch + harbour-crane operator cabs. */
function buildWindows(group: THREE.Group): void {
  const geo = new THREE.PlaneGeometry(1, 1);
  const mesh = new THREE.InstancedMesh(geo, getMaterial('window'), 4);
  mesh.name = 'windows';
  setInst(mesh, 0, -33.52, 0.95, 0, 0.55, 1.35, 1, Math.PI / 2);
  setInst(mesh, 1, 82.8, 20.5, -60.6, 1.8, 1.15, 1, -0.9);
  setInst(mesh, 2, -12.0, 24.5, -120.2, 2.0, 1.2, 1, 0.14);
  setInst(mesh, 3, 33.2, 22.8, -104.2, 1.9, 1.2, 1, -0.32);
  group.add(mesh);
}

/** Pipe-corridor warm ceiling lamps inside each enclosed flank tunnel. */
function buildPipeLamps(group: THREE.Group): void {
  const geo = new THREE.SphereGeometry(0.09, 8, 6);
  const bulbs = new THREE.InstancedMesh(geo, getMaterial('lamp'), 4);
  bulbs.name = 'pipe-lamps';
  const heads: [number, number, number][] = [
    [-30, 1.82, -9],
    [-30, 1.82, 9],
    [30, 1.82, 9],
    [30, 1.82, -9],
  ];
  heads.forEach(([x, y, z], i) => setInst(bulbs, i, x, y, z, 1, 1, 1));
  group.add(bulbs);
  for (const [x, y, z] of heads) {
    const l = new THREE.PointLight(PALETTE.lampWarm, 5, 9, 2);
    l.position.set(x, y - 0.15, z);
    group.add(l);
  }
}

/** Two mast work lamps. */
function buildWorkLamps(group: THREE.Group): void {
  const geo = new THREE.SphereGeometry(0.22, 8, 6);
  const bulbs = new THREE.InstancedMesh(geo, getMaterial('lamp'), 2);
  bulbs.name = 'lamp-bulbs';
  const heads: [number, number, number][] = [
    [33.6, 8.6, 0.5],
    [-34.4, 7.6, -0.4],
  ];
  heads.forEach(([x, y, z], i) => setInst(bulbs, i, x, y, z, 1, 1, 1));
  group.add(bulbs);

  for (const [x, y, z] of heads) {
    const l = new THREE.PointLight(PALETTE.lampWarm, 36, 28, 2);
    l.position.set(x, y, z);
    group.add(l);
  }
}

export function buildMap(scene: THREE.Scene): MapMeshes {
  const group = new THREE.Group();
  group.name = 'map';

  const unitCube = new THREE.BoxGeometry(1, 1, 1);
  const byKind = {} as Record<Box['kind'], THREE.InstancedMesh>;
  const kinds: Box['kind'][] = ['deck', 'container', 'tower', 'rail', 'pipe'];

  for (const kind of kinds) {
    const boxes = MAP.boxes.filter((b) => b.kind === kind);
    if (boxes.length === 0) continue;
    const mat = getMaterial(kind as MaterialKind);
    const geo = kind === 'container' ? unitCube.clone() : unitCube;
    const mesh = new THREE.InstancedMesh(geo, mat, boxes.length);
    mesh.name = `map-${kind}`;
    const c = new THREE.Color();
    boxes.forEach((b, i) => {
      mat4.makeScale(b.w, b.h, b.d);
      mat4.setPosition(b.x, b.y + b.h / 2, b.z);
      mesh.setMatrixAt(i, mat4);
      if (kind === 'container') {
        mesh.setColorAt(
          i,
          c.set(PALETTE.container[i % PALETTE.container.length]).multiplyScalar(tintJitter(i)),
        );
      }
    });
    if (kind === 'container') {
      addContainerUvs(geo, boxes.map((b) => [b.w, b.h, b.d] as [number, number, number]), 0);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = kind !== 'deck';
    mesh.receiveShadow = true;
    group.add(mesh);
    byKind[kind] = mesh;
  }

  buildBollards(group);
  buildDeckLines(group);
  buildPallets(group);
  buildBarrels(group);
  buildReels(group);
  buildCrates(group);
  buildStackedContainers(group);
  buildGrates(group);
  buildAoBlobs(group);
  buildAoEdges(group);
  buildRails(group);
  buildCranes(group);
  buildWorkLamps(group);
  buildLightAnchors(group);
  buildPuddles(group);
  buildWindows(group);
  buildHull(group);
  buildDistantShips(group);
  buildPipeBundles(group);
  buildCoils(group);
  buildCones(group);
  buildMarkings(group);
  buildStencils(group);
  buildPipeLamps(group);

  const sea = createSea();
  group.add(sea);

  scene.add(group);
  return { group, byKind, sea };
}
