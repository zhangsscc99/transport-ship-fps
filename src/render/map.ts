// Turns MAP's pure Box data into three.js geometry plus rich maritime props,
// harbour crane skyline, distant freighters, puddles, and decals.
// Same-kind geometry shares one InstancedMesh — high visual density at ~30 draw calls.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
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

/** Real slatted 3-stringer EUR wooden pallet geometry (merged into 1 draw call). */
function makePalletGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  // 3 bottom runner stringers (leaving forklift fork pockets underneath)
  for (const sz of [-0.39, 0, 0.39]) {
    addBoxPart(parts, 1.15, 0.082, 0.088, 0, -0.022, sz);
  }
  // 2 bottom end boards
  for (const sx of [-0.49, 0.49]) {
    addBoxPart(parts, 0.12, 0.02, 0.92, sx, -0.055, 0);
  }
  // 6 spaced top timber deck slats with real air gaps
  for (let k = 0; k < 6; k++) {
    const sx = -0.495 + k * 0.198;
    addBoxPart(parts, 0.145, 0.026, 0.92, sx, 0.052, 0);
  }
  return mergeGeometries(parts, false)!;
}

/** Wooden pallets ×36 (slatted 3-stringer EUR pallets) near containers & under platforms. */
function buildPallets(group: THREE.Group): void {
  const geo = makePalletGeo();
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
    // Under-platform industrial storage layers beneath all 4 elevated towers
    [-26.5, 0.065, 14.5, 0.08],
    [-26.5, 0.195, 14.5, 0.14],
    [-25.4, 0.065, 13.4, -0.18],
    [26.5, 0.065, 14.5, -0.1],
    [26.5, 0.195, 14.5, -0.04],
    [25.4, 0.065, 13.4, 0.2],
    [26.5, 0.065, -14.5, 0.12],
    [26.5, 0.195, -14.5, 0.06],
    [-26.5, 0.065, -14.5, -0.12],
    [-26.5, 0.195, -14.5, -0.18],
  ];
  const mesh = new THREE.InstancedMesh(geo, getMaterial('wood'), spots.length);
  mesh.name = 'pallets';
  spots.forEach(([x, y, z, ry], i) => setInst(mesh, i, x, y, z, 1, 1, 1, ry));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
}

/** Real 3D 55-gallon oil drum: body + 2 raised rolling hoops + chime rims + top bung plugs. */
function makeBarrelGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  // Main drum shell
  addCylPart(parts, 0.295, 0.295, 0.84, 14, 0, 0, 0);
  // 2 raised 3D rolling hoops (桶箍)
  for (const hy of [-0.145, 0.145]) {
    parts.push(prepGeo(new THREE.TorusGeometry(0.295, 0.017, 6, 14), 0, hy, 0, Math.PI / 2));
  }
  // Top & bottom raised chime rims forming a recessed lid
  for (const cy of [-0.42, 0.42]) {
    parts.push(prepGeo(new THREE.TorusGeometry(0.292, 0.015, 6, 14), 0, cy, 0, Math.PI / 2));
  }
  // Top lid 2" & 3/4" steel bung plugs (顶盖注油口与透气塞)
  addCylPart(parts, 0.036, 0.036, 0.028, 6, 0.13, 0.432, 0.04);
  addCylPart(parts, 0.019, 0.019, 0.024, 6, -0.14, 0.430, -0.05);
  return mergeGeometries(parts, false)!;
}

/** Metallic oil drums ×40 (3D hooped, rusted, hazmat-decaled) across deck & under platforms. */
function buildBarrels(group: THREE.Group): void {
  const geo = makeBarrelGeo();
  const spots: [number, number, number][] = [
    // Near Spawn A container flanks (clearly visible in vista & container shots)
    [-15.4, 11.1, 0.2],
    [-15.9, 10.4, 1.1],
    [-15.4, 9.7, 0.7],
    [1.4, 11.1, 0.4],
    [2.0, 10.5, 1.6],
    [1.5, 9.8, 0.9],
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
    // Under-platform oil drum clusters beneath all 4 elevated towers
    [-25.3, 14.7, 0.4],
    [-25.9, 15.1, 1.8],
    [-21.2, 15.3, 0.9],
    [25.3, 14.7, 1.2],
    [25.9, 15.1, 2.5],
    [21.2, 15.3, 0.3],
    [25.3, -14.7, 0.7],
    [25.9, -15.1, 1.9],
    [21.2, -15.3, 1.1],
    [-25.3, -14.7, 1.6],
    [-25.9, -15.1, 0.5],
    [-21.2, -15.3, 2.2],
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
    // Under-platform cable reels tucked inside each tower bay
    [-26.8, 13.1, 0.55],
    [26.8, 13.1, 1.15],
    [26.8, -13.1, 0.42],
    [-26.8, -13.1, 1.32],
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

/** 3D perimeter-framed wooden shipping crate (unit 1×1×1, merged into 1 draw call). */
let cachedCrateGeo: THREE.BufferGeometry | null = null;
function makeCrateGeo(): THREE.BufferGeometry {
  if (cachedCrateGeo) return cachedCrateGeo;
  const parts: THREE.BufferGeometry[] = [];
  // Slightly recessed inner plank core
  addBoxPart(parts, 0.94, 0.94, 0.94, 0, 0, 0);
  // 12 raised perimeter timber frame battens around all edges
  const b = 0.075;
  const e = 0.5 - b / 2;
  for (const sy of [-e, e]) {
    for (const sz of [-e, e]) addBoxPart(parts, 1.0, b, b, 0, sy, sz);
    for (const sx of [-e, e]) addBoxPart(parts, b, b, 1.0 - b * 2, sx, sy, 0);
  }
  for (const sx of [-e, e]) {
    for (const sz of [-e, e]) addBoxPart(parts, b, 1.0 - b * 2, b, sx, 0, sz);
  }
  cachedCrateGeo = mergeGeometries(parts, false)!;
  return cachedCrateGeo;
}

/** Braced wooden cargo crates ×24 (some stacked on pallets beside containers). */
function buildCrates(group: THREE.Group): void {
  const geo = makeCrateGeo();
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
      ((b.kind === 'container' && b.h >= 2.5 && b.w >= 1.5 && b.d >= 1.5) ||
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

  const skids = new THREE.InstancedMesh(new THREE.PlaneGeometry(4.4, 3.2), getMaterial('skid'), 8);
  skids.name = 'skid-marks';
  const spots: [number, number, number][] = [
    [-7.0, 4.5, 0.4],
    [9.0, -4.2, 2.2],
    [18.5, 2.5, -0.6],
    [-18.5, -4.5, 1.1],
    [-2.2, 13.8, 0.15],
    [3.6, -13.6, -0.2],
    [-14.5, 13.2, 1.35],
    [14.5, -13.0, -1.2],
  ];
  spots.forEach(([x, z, ry], i) => setInst(skids, i, x, 0.019, z, 1, 1, 1, ry, -Math.PI / 2));
  skids.renderOrder = 3;
  group.add(skids);

  // Glossy dark oil spill slicks (地面油渍) near barrels, lanes & under platforms
  const oils = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), getMaterial('oilStain'), 12);
  oils.name = 'oil-stains';
  const oilSpots: [number, number, number, number, number][] = [
    [-15.5, 10.6, 2.1, 1.7, 0.3],
    [1.7, 10.7, 1.9, 1.5, -0.6],
    [-9.4, -3.7, 2.0, 1.6, 1.1],
    [9.9, 3.8, 1.8, 1.5, 0.5],
    [-14.1, 3.9, 1.7, 1.4, -0.4],
    [14.3, -4.0, 1.8, 1.5, 0.8],
    [-25.6, 14.8, 2.2, 1.8, 0.2],
    [25.6, 14.8, 2.2, 1.8, -0.7],
    [25.6, -14.8, 2.2, 1.8, 0.9],
    [-25.6, -14.8, 2.2, 1.8, -0.3],
    [-3.8, 15.2, 1.6, 1.3, 0.45],
    [4.4, -15.0, 1.7, 1.4, -0.5],
  ];
  oilSpots.forEach(([x, z, sx, sz, ry], i) =>
    setInst(oils, i, x, 0.020, z, sx, sz, 1, 0, -Math.PI / 2, ry),
  );
  oils.receiveShadow = true;
  oils.renderOrder = 3;
  group.add(oils);
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
 * Detailed lattice-truss STS harbour gantry crane skyline (5 cranes with portal
 * X-bracing, Warren-truss booms, maintenance catwalks w/ handrails, machinery
 * houses, trolley & glazed reflective operator cabs) + detailed on-ship bow
 * mast & stern deck crane.
 */
function buildCranes(group: THREE.Group): void {
  const cranes: [number, number, number, number][] = [
    // (cx, cz, scale, ry)
    [-58, -104, 1.35, 0.25], // port-bow skyline crane
    [-12, -124, 1.48, -0.14], // central distant crane framed through the mid-deck gap
    [34, -108, 1.38, 0.42], // starboard-bow crane backlit near the sun horizon
    [84, -64, 1.24, 0.55], // starboard-flank harbour crane
    [-86, -34, 1.08, -0.62], // port-flank harbour crane
  ];

  // Build one canonical detailed STS gantry crane (base y=0, placed at y=-2)
  const steelParts: THREE.BufferGeometry[] = [];
  const glassParts: THREE.BufferGeometry[] = [];

  // 1. Sill bogie beams + 4 tapered portal legs + full portal X-bracing (桁架斜撑)
  for (const lz of [-2.4, 2.4]) {
    addBoxPart(steelParts, 12.2, 1.1, 1.2, 0, 0.55, lz); // rail bogie sill beam
    addBoxPart(steelParts, 1.15, 20.4, 1.15, -5.0, 10.2, lz); // rear leg
    addBoxPart(steelParts, 1.15, 20.4, 1.15, 5.0, 10.2, lz); // front leg
    // Mid portal beam + knee braces + upper portal cross-beam
    addBoxPart(steelParts, 10.6, 0.85, 0.85, 0, 9.5, lz);
    addSegmentPart(steelParts, [-5.0, 5.5, lz], [-2.2, 9.5, lz], 0.26, 4, true);
    addSegmentPart(steelParts, [5.0, 5.5, lz], [2.2, 9.5, lz], 0.26, 4, true);
    // Upper portal X-bracing
    addSegmentPart(steelParts, [-5.0, 9.5, lz], [5.0, 19.6, lz], 0.24, 4, true);
    addSegmentPart(steelParts, [5.0, 9.5, lz], [-5.0, 19.6, lz], 0.24, 4, true);
  }
  // End-frame X-bracing connecting front/rear legs across Z
  for (const lx of [-5.0, 5.0]) {
    addBoxPart(steelParts, 0.9, 0.9, 5.4, lx, 9.5, 0);
    addSegmentPart(steelParts, [lx, 1.2, -2.4], [lx, 9.5, 2.4], 0.24, 4, true);
    addSegmentPart(steelParts, [lx, 1.2, 2.4], [lx, 9.5, -2.4], 0.24, 4, true);
    addSegmentPart(steelParts, [lx, 9.5, -2.4], [lx, 19.8, 2.4], 0.24, 4, true);
    addSegmentPart(steelParts, [lx, 9.5, 2.4], [lx, 19.8, -2.4], 0.24, 4, true);
  }

  // 2. Main bridge box-girders + elevated maintenance catwalk/walkway (走台) w/ handrail
  addBoxPart(steelParts, 13.8, 1.6, 1.1, 0, 20.4, -2.4);
  addBoxPart(steelParts, 13.8, 1.6, 1.1, 0, 20.4, 2.4);
  addBoxPart(steelParts, 12.6, 0.45, 5.8, 0, 21.3, 0); // bridge deck walkway
  // Catwalk railing along bridge deck edge (z = +2.9)
  addBoxPart(steelParts, 12.6, 0.14, 0.14, 0, 22.35, 2.88);
  addBoxPart(steelParts, 12.6, 0.12, 0.12, 0, 21.85, 2.88);
  for (let rx = -6.0; rx <= 6.0; rx += 2.4) {
    addBoxPart(steelParts, 0.14, 1.1, 0.14, rx, 21.85, 2.88);
  }

  // 3. Warren-truss lattice boom/jib + counter-jib (桁架臂架 + 走台)
  const boomZ = 1.45;
  const B_X0 = -12.0; // counter-jib rear tip
  const B_X1 = 23.0; // waterside boom tip
  const boomY = (x: number) => 20.4 + Math.max(0, x - 4.0) * 0.22; // gentle upward waterside cant
  for (const bz of [-boomZ, boomZ]) {
    // Lower & upper boom chords
    addSegmentPart(steelParts, [B_X0, boomY(B_X0), bz], [4.0, boomY(4.0), bz], 0.26, 4, true);
    addSegmentPart(steelParts, [4.0, boomY(4.0), bz], [B_X1, boomY(B_X1), bz], 0.24, 4, true);
    addSegmentPart(steelParts, [B_X0, boomY(B_X0) + 1.9, bz], [4.0, boomY(4.0) + 2.1, bz], 0.20, 4, true);
    addSegmentPart(steelParts, [4.0, boomY(4.0) + 2.1, bz], [B_X1, boomY(B_X1) + 1.5, bz], 0.18, 4, true);
    // Triangular Warren-truss diagonal webs along the entire boom
    const BAYS = 10;
    for (let k = 0; k < BAYS; k++) {
      const x0 = B_X0 + ((B_X1 - B_X0) * k) / BAYS;
      const x1 = B_X0 + ((B_X1 - B_X0) * (k + 1)) / BAYS;
      const y0 = boomY(x0);
      const y1 = boomY(x1);
      const h0 = x0 < 4 ? 1.95 : 2.1 - ((x0 - 4) / (B_X1 - 4)) * 0.6;
      const h1 = x1 < 4 ? 1.95 : 2.1 - ((x1 - 4) / (B_X1 - 4)) * 0.6;
      addSegmentPart(steelParts, [x0, y0, bz], [x0, y0 + h0, bz], 0.14, 4, true);
      if (k % 2 === 0) {
        addSegmentPart(steelParts, [x0, y0, bz], [x1, y1 + h1, bz], 0.15, 4, true);
      } else {
        addSegmentPart(steelParts, [x0, y0 + h0, bz], [x1, y1, bz], 0.15, 4, true);
      }
    }
  }
  // Boom top cross-struts & boom maintenance catwalk + railing along front side
  for (let bx = B_X0; bx <= B_X1; bx += 3.5) {
    const by = boomY(bx);
    addBoxPart(steelParts, 0.28, 0.28, boomZ * 2, bx, by + 0.15, 0);
  }
  addSegmentPart(steelParts, [4.0, boomY(4.0) + 0.25, boomZ + 0.55], [B_X1 - 1.5, boomY(B_X1 - 1.5) + 0.25, boomZ + 0.55], 0.28, 4, true);
  addSegmentPart(steelParts, [4.0, boomY(4.0) + 1.25, boomZ + 0.85], [B_X1 - 1.5, boomY(B_X1 - 1.5) + 1.25, boomZ + 0.85], 0.08, 4, true);

  // 4. Machinery house on counter-jib + lattice A-frame apex tower + twin stay cables
  addBoxPart(steelParts, 6.2, 2.9, 4.4, -3.5, 22.8, 0); // machinery house
  for (const az of [-1.8, 1.8]) {
    addSegmentPart(steelParts, [-3.8, 21.4, az], [1.4, 34.0, az * 0.45], 0.34, 4, true); // rear A-leg
    addSegmentPart(steelParts, [4.6, 21.4, az], [1.4, 34.0, az * 0.45], 0.34, 4, true); // fore A-leg
    addSegmentPart(steelParts, [-2.2, 25.4, az * 0.85], [3.6, 25.4, az * 0.85], 0.20, 4, true);
    addSegmentPart(steelParts, [-0.8, 29.4, az * 0.68], [2.6, 29.4, az * 0.68], 0.18, 4, true);
    // Twin forestay & twin backstay tension tie-rods
    addSegmentPart(steelParts, [1.4, 34.0, az * 0.45], [20.5, boomY(20.5) + 1.4, az * 0.8], 0.14, 4, true);
    addSegmentPart(steelParts, [1.4, 34.0, az * 0.45], [12.5, boomY(12.5) + 1.6, az * 0.8], 0.12, 4, true);
    addSegmentPart(steelParts, [1.4, 34.0, az * 0.45], [-11.0, boomY(-11.0) + 1.8, az * 0.8], 0.14, 4, true);
  }
  addBoxPart(steelParts, 1.4, 0.8, 2.4, 1.4, 34.1, 0); // apex sheave head
  addSegmentPart(steelParts, [-3.8, 21.4, -1.8], [4.6, 21.4, 1.8], 0.20, 4, true);
  addSegmentPart(steelParts, [1.4, 34.0, -0.8], [-1.2, 26.0, 1.5], 0.16, 4, true);
  addSegmentPart(steelParts, [1.4, 34.0, 0.8], [-1.2, 26.0, -1.5], 0.16, 4, true);

  // 5. Suspended Trolley + Operator Cab (驾驶室) w/ Panoramic Reflective Glass (驾驶室玻璃) + Spreader
  const CAB_X = 9.5;
  const CAB_Y = boomY(CAB_X) - 2.3;
  addBoxPart(steelParts, 3.4, 0.7, 3.2, CAB_X, boomY(CAB_X) - 0.3, 0); // trolley carriage
  addBoxPart(steelParts, 2.6, 2.3, 2.4, CAB_X, CAB_Y, 1.2); // cab steel body
  addBoxPart(steelParts, 2.9, 0.25, 2.7, CAB_X, CAB_Y + 1.2, 1.2); // cab sun-visor roof
  // Panoramic tinted reflective glass panes wrapping front, bottom-lookout & sides of cab
  addBoxPart(glassParts, 2.2, 1.35, 0.14, CAB_X, CAB_Y + 0.05, 2.42); // front view window
  addBoxPart(glassParts, 2.2, 1.35, 0.14, CAB_X, CAB_Y + 0.05, -0.02); // rear view window
  addBoxPart(glassParts, 0.14, 1.35, 2.0, CAB_X + 1.32, CAB_Y + 0.05, 1.2); // starboard glass
  addBoxPart(glassParts, 0.14, 1.35, 2.0, CAB_X - 1.32, CAB_Y + 0.05, 1.2); // port glass
  // Suspended hoisting cables + container spreader frame hanging under trolley
  for (const sx of [-1.2, 1.2]) {
    for (const sz of [-0.9, 0.9]) {
      addSegmentPart(steelParts, [CAB_X + sx, boomY(CAB_X) - 0.5, sz], [CAB_X + sx, 13.8, sz], 0.06, 4, true);
    }
  }
  addBoxPart(steelParts, 4.6, 0.55, 2.4, CAB_X, 13.5, 0); // spreader beam

  const craneGeo = mergeGeometries(steelParts, false)!;
  const cabGlassGeo = mergeGeometries(glassParts, false)!;
  const distant = new THREE.InstancedMesh(craneGeo, getMaterial('crane'), cranes.length);
  const cabGlass = new THREE.InstancedMesh(cabGlassGeo, getMaterial('cabGlass'), cranes.length);
  distant.name = 'harbour-cranes';
  cabGlass.name = 'harbour-crane-glass';

  const beacons = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.45, 8, 6),
    getMaterial('lampRed'),
    cranes.length,
  );
  beacons.name = 'crane-beacons';

  cranes.forEach(([cx, cz, s, ry], idx) => {
    setInst(distant, idx, cx, -2, cz, s, s, s, ry);
    setInst(cabGlass, idx, cx, -2, cz, s, s, s, ry);
    const cos = Math.cos(ry);
    const sin = Math.sin(ry);
    const bx = cx + 1.4 * cos * s;
    const bz = cz - 1.4 * sin * s;
    setInst(beacons, idx, bx, -2 + 34.8 * s, bz, 1, 1, 1);
  });
  group.add(distant, cabGlass, beacons);

  // On-ship steel bow mast (+x tip) & detailed lattice stern deck crane (-x tip)
  const shipParts: THREE.BufferGeometry[] = [];
  const sternGlass: THREE.BufferGeometry[] = [];
  // Bow mast (+x)
  addBoxPart(shipParts, 0.4, 14, 0.4, 33.8, 5.5, 0);
  addBoxPart(shipParts, 0.22, 0.22, 3.4, 33.8, 8.2, 0);
  addBoxPart(shipParts, 0.08, 4.4, 0.08, 33.8, 10.6, 0);
  addBoxPart(shipParts, 1.3, 0.14, 1.3, 33.8, 7.2, 0); // watch platform
  // Stern deck crane (-x): pedestal, counterweight, glazed operator cab & lattice jib
  addCylPart(shipParts, 0.62, 0.72, 3.2, 10, -34.0, 0.9, 0);
  addBoxPart(shipParts, 1.7, 1.3, 1.5, -33.4, 2.35, 0); // counterweight & machinery housing
  addBoxPart(shipParts, 1.25, 1.45, 1.15, -34.1, 3.3, 0.95); // operator cab shell
  addBoxPart(sternGlass, 0.95, 0.85, 0.10, -34.1, 3.4, 1.54); // cab side window
  addBoxPart(sternGlass, 0.10, 0.85, 0.85, -33.46, 3.4, 0.95); // cab front window facing deck
  // Lattice jib chords + diagonal bracing extending up & toward bow
  for (const jz of [-0.32, 0.32]) {
    addSegmentPart(shipParts, [-34.0, 3.2, jz], [-30.0, 10.6, jz * 0.5], 0.11, 4, true);
    addSegmentPart(shipParts, [-34.6, 2.8, jz], [-30.6, 10.2, jz * 0.5], 0.11, 4, true);
  }
  for (let k = 0; k < 5; k++) {
    const t0 = k / 5;
    const t1 = (k + 1) / 5;
    const ax0 = -34.0 + 4.0 * t0, ay0 = 3.2 + 7.4 * t0;
    const ax1 = -34.0 + 4.0 * t1, ay1 = 3.2 + 7.4 * t1;
    const bx0 = -34.6 + 4.0 * t0, by0 = 2.8 + 7.4 * t0;
    const bx1 = -34.6 + 4.0 * t1, by1 = 2.8 + 7.4 * t1;
    addSegmentPart(shipParts, [ax0, ay0, -0.24], [bx1, by1, -0.24], 0.06, 4, true);
    addSegmentPart(shipParts, [ax0, ay0, 0.24], [bx1, by1, 0.24], 0.06, 4, true);
    addSegmentPart(shipParts, [ax0, ay0, -0.24], [ax0, ay0, 0.24], 0.06, 4, true);
  }
  // Hoist stay cable from apex back to counterweight
  addSegmentPart(shipParts, [-33.4, 3.0, 0], [-30.3, 10.4, 0], 0.045, 4, true);

  const onShip = new THREE.Mesh(mergeGeometries(shipParts, false)!, getMaterial('mast'));
  onShip.name = 'ship-masts';
  onShip.castShadow = true;
  onShip.receiveShadow = true;
  const onShipGlass = new THREE.Mesh(mergeGeometries(sternGlass, false)!, getMaterial('cabGlass'));
  onShipGlass.name = 'ship-crane-glass';
  group.add(onShip, onShipGlass);
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

/**
 * Geometry merge helpers for multi-part industrial assets (steel platforms,
 * staircases, hooped drums, slatted pallets, truss cranes). Every part is
 * converted to non-indexed geometry with uniform attributes so mergeGeometries
 * collapses hundreds of industrial details into one InstancedMesh draw call.
 */
function prepGeo(
  geo: THREE.BufferGeometry,
  x = 0,
  y = 0,
  z = 0,
  rx = 0,
  ry = 0,
  rz = 0,
  uvU = 1,
  uvV = 1,
): THREE.BufferGeometry {
  if (uvU !== 1 || uvV !== 1) {
    const uv = geo.getAttribute('uv');
    if (uv) {
      for (let i = 0; i < uv.count; i++) {
        uv.setXY(i, uv.getX(i) * uvU, uv.getY(i) * uvV);
      }
    }
  }
  if (rx) geo.rotateX(rx);
  if (ry) geo.rotateY(ry);
  if (rz) geo.rotateZ(rz);
  if (x || y || z) geo.translate(x, y, z);
  return geo.index ? geo.toNonIndexed() : geo;
}

function addBoxPart(
  list: THREE.BufferGeometry[],
  w: number,
  h: number,
  d: number,
  x = 0,
  y = 0,
  z = 0,
  rx = 0,
  ry = 0,
  rz = 0,
  uvU = 1,
  uvV = 1,
): void {
  list.push(prepGeo(new THREE.BoxGeometry(w, h, d), x, y, z, rx, ry, rz, uvU, uvV));
}

function addCylPart(
  list: THREE.BufferGeometry[],
  rTop: number,
  rBot: number,
  len: number,
  seg: number,
  x = 0,
  y = 0,
  z = 0,
  rx = 0,
  ry = 0,
  rz = 0,
): void {
  list.push(prepGeo(new THREE.CylinderGeometry(rTop, rBot, len, seg), x, y, z, rx, ry, rz));
}

/** Add a straight strut/pipe spanning from world/local point A to B. */
function addSegmentPart(
  list: THREE.BufferGeometry[],
  a: [number, number, number],
  b: [number, number, number],
  radius: number,
  radialSegs: number,
  square = false,
): void {
  const va = new THREE.Vector3(...a);
  const vb = new THREE.Vector3(...b);
  const dir = vb.clone().sub(va);
  const len = dir.length();
  if (len < 1e-4) return;
  const mid = va.clone().add(vb).multiplyScalar(0.5);
  const geo = square
    ? new THREE.BoxGeometry(radius * 2, len, radius * 2)
    : new THREE.CylinderGeometry(radius, radius, len, radialSegs);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  const m = new THREE.Matrix4().compose(mid, q, new THREE.Vector3(1, 1, 1));
  geo.applyMatrix4(m);
  list.push(geo.index ? geo.toNonIndexed() : geo);
}

/**
 * Rebuild all 4 elevated sniper platforms & staircases as open industrial
 * steelwork — completely replacing the raw unit-cube concrete blocks & solid
 * rail walls while staying 1:1 aligned with MAP.boxes colliders:
 *   - 4 true H-beam columns w/ baseplates, 16 hex anchor bolts & gussets
 *   - Multi-bay cross X-bracing & mid-height tie beams (open see-through bays)
 *   - Perimeter & cross I-beam main girders w/ underside AO shadow patches
 *   - Checker-plate steel deck (procedural normal/roughness) w/ drain scuppers
 *   - Tubular Ø48mm double-rail guardrails (posts ≤1.5m), 90° torus elbows &
 *     100mm rusted steel kickplates
 *   - Twin C-channel stair stringers, bolted top/bottom connection plates,
 *     mid-span steel support posts, 18 open-riser 5cm solid steel treads with
 *     yellow-black anti-slip nosing, and double-sided Ø42mm tubular handrails
 *   - Under-platform marine electrical distribution box + conduit & overhead
 *     industrial gooseneck work lamp casting warm light onto every platform.
 */
function buildSteelTowers(group: THREE.Group): {
  frameMesh: THREE.InstancedMesh;
  railMesh: THREE.InstancedMesh;
} {
  const TOWERS: [number, number, number][] = [
    [-26, 14, 0],
    [-26, -14, 0],
    [26, 14, Math.PI],
    [26, -14, Math.PI],
  ];

  const frameParts: THREE.BufferGeometry[] = [];
  const checkerParts: THREE.BufferGeometry[] = [];
  const railParts: THREE.BufferGeometry[] = [];
  const kickParts: THREE.BufferGeometry[] = [];
  const stripeParts: THREE.BufferGeometry[] = [];
  const elecParts: THREE.BufferGeometry[] = [];
  const lampParts: THREE.BufferGeometry[] = [];
  const aoParts: THREE.BufferGeometry[] = [];

  // ---- 1. Four H-beam columns (x=±1.62, z=±1.62, y=0..2.98) ----
  const COL = 1.62;
  for (const cx of [-COL, COL]) {
    for (const cz of [-COL, COL]) {
      // Base plate + 4 hex anchor bolts + welded gusset stiffeners
      addBoxPart(frameParts, 0.50, 0.045, 0.50, cx, 0.0225, cz);
      for (const bx of [-0.17, 0.17]) {
        for (const bz of [-0.17, 0.17]) {
          addCylPart(frameParts, 0.026, 0.026, 0.065, 6, cx + bx, 0.055, cz + bz);
          addBoxPart(frameParts, 0.075, 0.012, 0.075, cx + bx, 0.048, cz + bz);
        }
      }
      addBoxPart(frameParts, 0.36, 0.22, 0.024, cx, 0.15, cz);
      addBoxPart(frameParts, 0.024, 0.22, 0.36, cx, 0.15, cz);

      // True H-section column (2 flanges + center web)
      addBoxPart(frameParts, 0.26, 2.94, 0.036, cx, 1.51, cz - 0.112);
      addBoxPart(frameParts, 0.26, 2.94, 0.036, cx, 1.51, cz + 0.112);
      addBoxPart(frameParts, 0.036, 2.94, 0.20, cx, 1.51, cz);

      // Top column cap plate & knee gussets supporting perimeter I-beams
      addBoxPart(frameParts, 0.38, 0.036, 0.38, cx, 2.97, cz);
      addBoxPart(frameParts, 0.46, 0.20, 0.03, cx * 1.12, 2.86, cz);
      addBoxPart(frameParts, 0.03, 0.20, 0.46, cx, 2.86, cz * 1.12);
    }
  }

  // ---- 2. Mid-height horizontal tie beams + cross X-bracing on open bays ----
  // Horizontal tie beams at y = 1.50
  addBoxPart(frameParts, 0.10, 0.12, COL * 2, -COL, 1.50, 0);
  addBoxPart(frameParts, 0.10, 0.12, COL * 2, COL, 1.50, 0);
  addBoxPart(frameParts, COL * 2, 0.12, 0.10, 0, 1.50, -COL);
  addBoxPart(frameParts, COL * 2, 0.12, 0.10, 0, 1.50, COL);

  const addXBay = (
    p00: [number, number, number],
    p10: [number, number, number],
    p01: [number, number, number],
    p11: [number, number, number],
  ) => {
    addSegmentPart(frameParts, p00, p11, 0.032, 4, true);
    addSegmentPart(frameParts, p10, p01, 0.032, 4, true);
    // Bolted center gusset where diagonal struts cross
    const mx = (p00[0] + p11[0]) * 0.5;
    const my = (p00[1] + p11[1]) * 0.5;
    const mz = (p00[2] + p11[2]) * 0.5;
    addBoxPart(frameParts, 0.16, 0.16, 0.16, mx, my, mz);
  };
  // Back bay (x = -COL): lower + upper X-bracing
  addXBay([-COL, 0.12, -COL], [-COL, 0.12, COL], [-COL, 1.46, -COL], [-COL, 1.46, COL]);
  addXBay([-COL, 1.54, -COL], [-COL, 1.54, COL], [-COL, 2.92, -COL], [-COL, 2.92, COL]);
  // Left & Right side bays (z = ±COL): lower + upper X-bracing (clearly visible from front/side!)
  for (const sz of [-COL, COL]) {
    addXBay([-COL, 0.12, sz], [COL, 0.12, sz], [-COL, 1.46, sz], [COL, 1.46, sz]);
    addXBay([-COL, 1.54, sz], [COL, 1.54, sz], [-COL, 2.92, sz], [COL, 2.92, sz]);
  }
  // Front bay (x = +COL): upper X-bracing only, leaving lower arch open to view under-platform props
  addXBay([COL, 1.54, -COL], [COL, 1.54, COL], [COL, 2.92, -COL], [COL, 2.92, COL]);

  // ---- 3. Main I-Beam Girders (工字钢截面) at y = 2.96..3.24 ----
  const addIBeamX = (len: number, yMid: number, zPos: number) => {
    addBoxPart(frameParts, len, 0.03, 0.18, 0, yMid + 0.125, zPos); // top flange
    addBoxPart(frameParts, len, 0.22, 0.034, 0, yMid, zPos); // web
    addBoxPart(frameParts, len, 0.03, 0.18, 0, yMid - 0.125, zPos); // bottom flange
  };
  const addIBeamZ = (len: number, yMid: number, xPos: number) => {
    addBoxPart(frameParts, 0.18, 0.03, len, xPos, yMid + 0.125, 0); // top flange
    addBoxPart(frameParts, 0.034, 0.22, len, xPos, yMid, 0); // web
    addBoxPart(frameParts, 0.18, 0.03, len, xPos, yMid - 0.125, 0); // bottom flange
  };
  // Perimeter I-beams + 2 inner cross joists
  addIBeamX(4.38, 3.10, -2.06);
  addIBeamX(4.38, 3.10, 2.06);
  addIBeamZ(4.06, 3.10, -2.06);
  addIBeamZ(4.06, 3.10, 2.06);
  addIBeamZ(3.96, 3.10, -0.72);
  addIBeamZ(3.96, 3.10, 0.72);
  // Corner bolted splice gusset plates on outer beam corners
  for (const sx of [-2.16, 2.16]) {
    for (const sz of [-2.16, 2.16]) {
      addBoxPart(frameParts, 0.08, 0.28, 0.08, sx, 3.10, sz);
    }
  }

  // Underside beam & column-footplate AO shadow patches (soft dark ambient occlusion)
  aoParts.push(prepGeo(new THREE.PlaneGeometry(5.0, 5.0), 0, 0.011, 0, -Math.PI / 2));
  for (const cx of [-COL, COL]) {
    for (const cz of [-COL, COL]) {
      aoParts.push(prepGeo(new THREE.PlaneGeometry(1.15, 1.15), cx, 0.014, cz, -Math.PI / 2));
    }
  }
  aoParts.push(prepGeo(new THREE.PlaneGeometry(4.3, 4.3), 0, 2.94, 0, Math.PI / 2));

  // ---- 4. Checker-Plate Steel Deck (top at y = 3.30, 4.4×4.4m) ----
  addBoxPart(checkerParts, 4.40, 0.06, 4.40, 0, 3.27, 0, 0, 0, 0, 3.5, 3.5);
  // Corner drainage scupper collars (排水孔护圈)
  for (const dx of [-1.84, 1.84]) {
    for (const dz of [-1.84, 1.84]) {
      const ring = new THREE.TorusGeometry(0.065, 0.014, 6, 12);
      frameParts.push(prepGeo(ring, dx, 3.304, dz, Math.PI / 2));
    }
  }

  // ---- 5. Industrial Tubular Guardrails (Ø48mm, posts ≤1.5m, 90° corner elbows) ----
  const R_PIPE = 0.024; // Ø48mm
  const ELBOW_R = 0.085;
  const RAIL_XY = 2.05;
  const TOP_Y = 4.33;
  const MID_Y = 3.83;

  const postCoords: [number, number][] = [
    // Back side (x=-2.05): 4 posts, spacing 1.37m
    [-RAIL_XY, -RAIL_XY],
    [-RAIL_XY, -0.68],
    [-RAIL_XY, 0.68],
    [-RAIL_XY, RAIL_XY],
    // Left & right sides (z=±2.05): intermediate + front corner posts
    [-0.68, -RAIL_XY],
    [0.68, -RAIL_XY],
    [RAIL_XY, -RAIL_XY],
    [-0.68, RAIL_XY],
    [0.68, RAIL_XY],
    [RAIL_XY, RAIL_XY],
    // Front entry opening jamb posts (1.60m clear stair entry)
    [RAIL_XY, -0.80],
    [RAIL_XY, 0.80],
  ];
  for (const [px, pz] of postCoords) {
    addCylPart(railParts, R_PIPE, R_PIPE, 1.03, 8, px, 3.815, pz);
    addBoxPart(frameParts, 0.11, 0.016, 0.11, px, 3.308, pz); // welded base flange
  }

  // Double horizontal Ø48mm pipes + 90° curved corner elbows
  for (const ry of [TOP_Y, MID_Y]) {
    // Back rail (z ∈ [-2.05+E, +2.05-E])
    addSegmentPart(railParts, [-RAIL_XY, ry, -RAIL_XY + ELBOW_R], [-RAIL_XY, ry, RAIL_XY - ELBOW_R], R_PIPE, 8);
    // Left & right rails (x ∈ [-2.05+E, +2.05-E])
    addSegmentPart(railParts, [-RAIL_XY + ELBOW_R, ry, -RAIL_XY], [RAIL_XY - ELBOW_R, ry, -RAIL_XY], R_PIPE, 8);
    addSegmentPart(railParts, [-RAIL_XY + ELBOW_R, ry, RAIL_XY], [RAIL_XY - ELBOW_R, ry, RAIL_XY], R_PIPE, 8);
    // Front entry stubs (stopping at z = ±0.80)
    addSegmentPart(railParts, [RAIL_XY, ry, -RAIL_XY + ELBOW_R], [RAIL_XY, ry, -0.80], R_PIPE, 8);
    addSegmentPart(railParts, [RAIL_XY, ry, 0.80], [RAIL_XY, ry, RAIL_XY - ELBOW_R], R_PIPE, 8);

    // 4 curved 90° corner elbows (torus quarter-arcs)
    const corners: [number, number, number][] = [
      [RAIL_XY - ELBOW_R, RAIL_XY - ELBOW_R, 0],
      [RAIL_XY - ELBOW_R, -RAIL_XY + ELBOW_R, Math.PI / 2],
      [-RAIL_XY + ELBOW_R, -RAIL_XY + ELBOW_R, Math.PI],
      [-RAIL_XY + ELBOW_R, RAIL_XY - ELBOW_R, -Math.PI / 2],
    ];
    for (const [ex, ez, rotY] of corners) {
      const elbow = new THREE.TorusGeometry(ELBOW_R, R_PIPE, 6, 8, Math.PI / 2);
      railParts.push(prepGeo(elbow, ex, ry, ez, Math.PI / 2, rotY, 0));
    }
  }

  // 100mm steel kickplates (踢脚板, y=3.305..3.405) around all 5 rail runs
  addBoxPart(kickParts, 0.024, 0.10, 4.12, -RAIL_XY, 3.355, 0, 0, 0, 0, 3.2, 1);
  addBoxPart(kickParts, 4.12, 0.10, 0.024, 0, 3.355, -RAIL_XY, 0, 0, 0, 3.2, 1);
  addBoxPart(kickParts, 4.12, 0.10, 0.024, 0, 3.355, RAIL_XY, 0, 0, 0, 3.2, 1);
  addBoxPart(kickParts, 0.024, 0.10, 1.25, RAIL_XY, 3.355, -1.425, 0, 0, 0, 1.2, 1);
  addBoxPart(kickParts, 0.024, 0.10, 1.25, RAIL_XY, 3.355, 1.425, 0, 0, 0, 1.2, 1);

  // ---- 6. Open-Stringer Channel-Beam Staircase (x=2.20..8.20, y=3.30..0, w=1.60m) ----
  const ST_X0 = 2.16;
  const ST_Y0 = 3.16;
  const ST_X1 = 8.16;
  const ST_Y1 = 0.04;
  const ST_DX = ST_X1 - ST_X0; // 6.00
  const ST_DY = ST_Y1 - ST_Y0; // -3.12
  const ST_LEN = Math.hypot(ST_DX, ST_DY);
  const ST_ANG = Math.atan2(ST_DY, ST_DX); // -0.4795 rad
  const ST_MX = (ST_X0 + ST_X1) * 0.5;
  const ST_MY = (ST_Y0 + ST_Y1) * 0.5;
  const ST_Z = 0.80;

  const flNX = -Math.sin(ST_ANG) * 0.107;
  const flNY = Math.cos(ST_ANG) * 0.107;
  for (const sz of [-ST_Z, ST_Z]) {
    const inward = sz > 0 ? -0.032 : 0.032;
    // True C-channel side stringer (outer vertical web + flush upper & lower inward flanges)
    addBoxPart(frameParts, ST_LEN, 0.24, 0.024, ST_MX, ST_MY, sz, 0, 0, ST_ANG);
    addBoxPart(frameParts, ST_LEN, 0.026, 0.088, ST_MX + flNX, ST_MY + flNY, sz + inward, 0, 0, ST_ANG);
    addBoxPart(frameParts, ST_LEN, 0.026, 0.088, ST_MX - flNX, ST_MY - flNY, sz + inward, 0, 0, ST_ANG);

    // Top bolted steel connection plate (平台连接板) joining stringer to main I-beam
    addBoxPart(frameParts, 0.36, 0.34, 0.034, 2.16, 3.10, sz);
    for (const bx of [-0.10, 0.10]) {
      for (const by of [-0.10, 0.10]) {
        addCylPart(
          frameParts,
          0.020,
          0.020,
          0.06,
          6,
          2.16 + bx,
          3.10 + by,
          sz + (sz > 0 ? 0.015 : -0.015),
          Math.PI / 2,
        );
      }
    }

    // Bottom deck anchor footplate + anchor bolts
    addBoxPart(frameParts, 0.42, 0.04, 0.22, 8.16, 0.02, sz);
    addCylPart(frameParts, 0.022, 0.022, 0.06, 6, 8.28, 0.045, sz);
    addCylPart(frameParts, 0.022, 0.022, 0.06, 6, 8.02, 0.045, sz);

    // Mid-span structural support column bracing the 6m staircase to the deck
    addBoxPart(frameParts, 0.12, 1.54, 0.12, 5.20, 0.79, sz);
    addBoxPart(frameParts, 0.28, 0.035, 0.28, 5.20, 0.0175, sz);
  }
  // Cross tie beam between the two mid-span stair support posts
  addBoxPart(frameParts, 0.08, 0.09, ST_Z * 2, 5.20, 0.72, 0);

  // 18 solid 5cm checker-plate stair treads (open risers!) + anti-slip edge nosing
  const STEPS = 18;
  const RISE = 3.30 / (STEPS + 0.5); // ~17.8cm ergonomic industrial rise
  for (let k = 0; k < STEPS; k++) {
    const tx = 8.00 - k * 0.33;
    const tyTop = (k + 1) * RISE;
    // Solid 5cm steel tread plate
    addBoxPart(checkerParts, 0.31, 0.05, 1.54, tx, tyTop - 0.025, 0, 0, 0, 0, 0.45, 1.5);
    // Yellow-black anti-slip nosing strip along front edge of every step
    addBoxPart(stripeParts, 0.052, 0.010, 1.52, tx + 0.132, tyTop + 0.004, 0, 0, 0, 0, 0.25, 3.0);
  }

  // Platform entry landing hazard stripe + stair-foot approach hazard stripe
  addBoxPart(stripeParts, 0.34, 0.008, 1.62, 2.02, 3.304, 0, 0, 0, 0, 0.5, 2.4);
  addBoxPart(stripeParts, 0.40, 0.008, 1.70, 8.44, 0.018, 0, 0, 0, 0, 0.6, 2.6);

  // Double-sided stair handrails (Ø42mm round pipe + vertical stanchions on BOTH sides)
  const R_HAND = 0.021; // Ø42mm
  const R_KNEE = 0.016; // Ø32mm mid rail
  const H_HAND = 1.04;
  for (const sz of [-ST_Z, ST_Z]) {
    // 5 stanchion posts rising vertically from the C-channel stringer
    for (let p = 0; p < 5; p++) {
      const f = p / 4;
      const sx = ST_X1 - f * ST_DX;
      const sy = ST_Y1 - f * ST_DY;
      addCylPart(railParts, R_HAND, R_HAND, H_HAND, 8, sx, sy + H_HAND * 0.5, sz);
    }
    // Sloped top Ø42mm handrail + sloped mid knee-rail + smooth join into platform jamb post
    addSegmentPart(railParts, [ST_X1, ST_Y1 + H_HAND, sz], [ST_X0, ST_Y0 + H_HAND, sz], R_HAND, 8);
    addSegmentPart(railParts, [ST_X0, ST_Y0 + H_HAND, sz], [RAIL_XY, TOP_Y, sz], R_HAND, 8);
    addSegmentPart(
      railParts,
      [ST_X1, ST_Y1 + H_HAND * 0.52, sz],
      [ST_X0, ST_Y0 + H_HAND * 0.52, sz],
      R_KNEE,
      6,
    );
    addSegmentPart(railParts, [ST_X0, ST_Y0 + H_HAND * 0.52, sz], [RAIL_XY, MID_Y, sz], R_KNEE, 6);
  }

  // ---- 7. Under-Platform Marine Electrical Distribution Box (配电箱) + Conduit ----
  addBoxPart(elecParts, 0.28, 0.74, 0.56, COL + 0.06, 1.38, -1.16);
  // Steel mounting straps & vertical electrical conduit running up column to work lamp
  addBoxPart(frameParts, 0.16, 0.06, 0.62, COL - 0.05, 1.62, -1.16);
  addBoxPart(frameParts, 0.16, 0.06, 0.62, COL - 0.05, 1.14, -1.16);
  addCylPart(frameParts, 0.022, 0.022, 1.56, 6, COL - 0.02, 2.38, -1.42);

  // ---- 8. Overhead Platform Work Lamp (吊灯/工作灯) ----
  // Gooseneck steel mast rising from back-center guardrail post
  addCylPart(frameParts, 0.036, 0.042, 2.52, 8, -RAIL_XY, 4.56, 0);
  addSegmentPart(frameParts, [-RAIL_XY, 5.78, 0], [-0.82, 5.78, 0], 0.032, 8);
  addSegmentPart(frameParts, [-RAIL_XY, 5.15, 0], [-1.42, 5.78, 0], 0.022, 6); // angled brace
  addCylPart(frameParts, 0.024, 0.024, 0.22, 6, -0.82, 5.68, 0); // pendant stem
  // Flared industrial enamel lamp shade hood
  addCylPart(frameParts, 0.10, 0.32, 0.20, 12, -0.82, 5.52, 0);
  // Warm self-lit bulb inside hood
  lampParts.push(prepGeo(new THREE.SphereGeometry(0.11, 10, 8), -0.82, 5.42, 0));

  // ---- Merge each material group & instance across all 4 towers ----
  const mkInst = (
    parts: THREE.BufferGeometry[],
    mat: THREE.Material,
    name: string,
    cast: boolean,
    recv: boolean,
    renderOrder = 0,
  ): THREE.InstancedMesh => {
    const merged = mergeGeometries(parts, false);
    if (!merged) throw new Error(`failed to merge ${name}`);
    const mesh = new THREE.InstancedMesh(merged, mat, TOWERS.length);
    mesh.name = name;
    TOWERS.forEach(([tx, tz, ry], i) => setInst(mesh, i, tx, 0, tz, 1, 1, 1, ry));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = cast;
    mesh.receiveShadow = recv;
    if (renderOrder) mesh.renderOrder = renderOrder;
    group.add(mesh);
    return mesh;
  };

  const frameMesh = mkInst(frameParts, getMaterial('steelFrame'), 'tower-steel-frame', true, true);
  mkInst(checkerParts, getMaterial('checker'), 'tower-checker-deck', true, true);
  const railMesh = mkInst(railParts, getMaterial('rail'), 'tower-guardrails', true, true);
  mkInst(kickParts, getMaterial('kickplate'), 'tower-kickplates', true, true);
  mkInst(stripeParts, getMaterial('stripe'), 'tower-hazard-stripes', false, true);
  mkInst(elecParts, getMaterial('elecBox'), 'tower-elec-boxes', true, true);
  mkInst(lampParts, getMaterial('lamp'), 'tower-work-lamps', false, false);
  mkInst(aoParts, getMaterial('ao'), 'tower-beam-ao', false, false, 1);

  // Warm work-lamp PointLight hanging beneath each of the 4 platform hoods
  for (const [tx, tz, ry] of TOWERS) {
    const lx = tx + (ry === 0 ? -0.82 : 0.82);
    const l = new THREE.PointLight(PALETTE.lampWarm, 24, 17, 2);
    l.position.set(lx, 5.22, tz);
    group.add(l);
  }

  return { frameMesh, railMesh };
}

/**
 * Render MAP's crate-jump steps (w≤1, d≤1) and low central covers (h=0.55) as
 * stacked braced wooden supply crates & cargo skids instead of narrow
 * corrugated shipping-container slivers.
 */
function buildCrateJumpStairs(group: THREE.Group): void {
  const stepBoxes = MAP.boxes.filter(
    (b) => b.kind === 'container' && b.h < 2.5,
  );
  const instances: [number, number, number, number, number, number, number][] = [];
  for (const b of stepBoxes) {
    if (b.w <= 1.0 && b.d <= 1.0) {
      // Split vertical jump columns into stacked individual wooden crates (~0.6m each)
      const layers = Math.max(1, Math.round(b.h / 0.6));
      const lh = b.h / layers;
      for (let k = 0; k < layers; k++) {
        const shrink = k === layers - 1 ? 0.96 : 1.0;
        const yaw = ((Math.round(b.x * 3 + b.z * 5 + k * 7) % 5) - 2) * 0.025;
        instances.push([b.x, b.y + (k + 0.5) * lh, b.z, b.w * shrink, lh, b.d * shrink, yaw]);
      }
    } else {
      // Low central covers (2.4 × 0.55 × 1.2): two side-by-side timber cargo crates
      const hw = b.w * 0.49;
      instances.push([b.x - b.w * 0.25, b.y + b.h * 0.5, b.z, hw, b.h, b.d, 0.015]);
      instances.push([b.x + b.w * 0.25, b.y + b.h * 0.5, b.z, hw, b.h, b.d, -0.015]);
    }
  }
  const mesh = new THREE.InstancedMesh(
    makeCrateGeo(),
    getMaterial('crate'),
    instances.length,
  );
  mesh.name = 'crate-jump-stairs';
  instances.forEach(([x, y, z, sx, sy, sz, ry], i) =>
    setInst(mesh, i, x, y, z, sx, sy, sz, ry),
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
}

export function buildMap(scene: THREE.Scene): MapMeshes {
  const group = new THREE.Group();
  group.name = 'map';

  const unitCube = new THREE.BoxGeometry(1, 1, 1);
  const byKind = {} as Record<Box['kind'], THREE.InstancedMesh>;
  // Deck, full ISO containers (h≥2.5), and enclosed flank pipes keep box colliders;
  // towers & rails are built as open industrial steelwork by buildSteelTowers(),
  // and crate-stairs / low covers are built as stacked timber crates by buildCrateJumpStairs().
  const kinds: Box['kind'][] = ['deck', 'container', 'pipe'];

  for (const kind of kinds) {
    const boxes = MAP.boxes.filter((b) =>
      kind === 'container' ? b.kind === 'container' && b.h >= 2.5 : b.kind === kind,
    );
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

  const towers = buildSteelTowers(group);
  byKind.tower = towers.frameMesh;
  byKind.rail = towers.railMesh;
  buildCrateJumpStairs(group);

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
