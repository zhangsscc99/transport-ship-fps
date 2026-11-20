// Turns MAP's pure Box data into three.js geometry.
// Same-kind boxes share one InstancedMesh (unit cube scaled per instance) and
// all decorative props are instanced too — the whole ship stays ~15 draw calls.
// ART-SPEC §5.

import * as THREE from 'three';
import { MAP, type Box } from '../game/map';
import { PALETTE } from './palette';
import { getMaterial } from './materials';
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
 * aSize = world dims so the shader repeats the skin every ~2.4 m per face,
 * aUvOffset = golden-ratio walk so no two boxes share the same tile phase.
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

/** Guard-rail runs along the deck edges: [x0, x1] at fixed z. Gaps = mooring bays. */
const RAIL_RUNS: { x0: number; x1: number; z: number }[] = [
  { x0: -32, x1: -14, z: 19.65 },
  { x0: -6, x1: 32, z: 19.65 },
  { x0: -32, x1: 6, z: -19.65 },
  { x0: 14, x1: 32, z: -19.65 },
];
const RAIL_H = 1.05;

function buildRails(group: THREE.Group): void {
  const postGeo = new THREE.CylinderGeometry(0.035, 0.035, RAIL_H, 6);
  const barGeo = new THREE.BoxGeometry(1, 1, 1);
  const mat = getMaterial('rail');

  // count posts: both ends of every ~3m segment
  const spacings = RAIL_RUNS.map((r) => Math.max(1, Math.round((r.x1 - r.x0) / 3)));
  const postCount = spacings.reduce((n, s) => n + s + 1, 0);

  const posts = new THREE.InstancedMesh(postGeo, mat, postCount);
  const bars = new THREE.InstancedMesh(barGeo, mat, RAIL_RUNS.length * 2);
  posts.name = 'rail-posts';
  bars.name = 'rail-bars';

  let pi = 0;
  let bi = 0;
  RAIL_RUNS.forEach((r, ri) => {
    const n = spacings[ri];
    for (let i = 0; i <= n; i++) {
      const x = r.x0 + ((r.x1 - r.x0) * i) / n;
      setInst(posts, pi++, x, RAIL_H / 2, r.z, 1, 1, 1);
    }
    const len = r.x1 - r.x0;
    const cx = (r.x0 + r.x1) / 2;
    setInst(bars, bi++, cx, RAIL_H - 0.05, r.z, len, 0.045, 0.045);
    setInst(bars, bi++, cx, 0.55, r.z, len, 0.045, 0.045);
  });

  posts.castShadow = bars.castShadow = true;
  posts.receiveShadow = bars.receiveShadow = true;
  group.add(posts, bars);
}

/** Mooring bollards ×8 along both long deck edges. */
function buildBollards(group: THREE.Group): void {
  const geo = new THREE.CylinderGeometry(0.16, 0.22, 0.55, 10);
  const mesh = new THREE.InstancedMesh(geo, getMaterial('pipe'), 8);
  mesh.name = 'bollards';
  let i = 0;
  for (const z of [19.3, -19.3]) {
    for (const x of [-24, -8, 8, 24]) setInst(mesh, i++, x, 0.275, z, 1, 1, 1);
  }
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
}

/** Painted warning lines ×4 — thin planes just above the deck. */
function buildDeckLines(group: THREE.Group): void {
  const geo = new THREE.PlaneGeometry(1, 1);
  const mesh = new THREE.InstancedMesh(geo, getMaterial('paint'), 4);
  mesh.name = 'deck-lines';
  // (cx, cz, length, alongX)
  const lines: [number, number, number, boolean][] = [
    [0, 15.5, 14, true], // behind team-A spawn lane
    [0, -15.5, 14, true], // behind team-B spawn lane
    [-20, 0, 9, false],
    [20, 0, 9, false],
  ];
  lines.forEach(([x, z, len, alongX], i) => {
    // plane lies in XY before rotation; after rotX -90° its Y axis runs along -Z
    if (alongX) setInst(mesh, i, x, 0.02, z, len, 0.4, 1, 0, -Math.PI / 2);
    else setInst(mesh, i, x, 0.02, z, 0.4, len, 1, 0, -Math.PI / 2);
  });
  mesh.receiveShadow = true;
  group.add(mesh);
}

/** Wooden pallets ×14 scattered between the lanes. */
function buildPallets(group: THREE.Group): void {
  const geo = new THREE.BoxGeometry(1.1, 0.12, 0.9);
  const mesh = new THREE.InstancedMesh(geo, getMaterial('wood'), 14);
  mesh.name = 'pallets';
  const spots: [number, number, number][] = [
    [-18, 6, 0.4],
    [-9, -8, 1.2],
    [-2, 14, 0.1],
    [7, -7, 0.8],
    [14, 8, 2.2],
    [20, -5, 0.3],
    [-22, -12, 1.7],
    [22, 10, 0.9],
    [0, -15, 0.5],
    [10, 1, 1.9],
    [-14, -13, 0.7],
    [24, 4, 1.5],
    [-24, -6, 0.9],
    [16, 16.5, 0.2],
  ];
  spots.forEach(([x, z, ry], i) => setInst(mesh, i, x, 0.06, z, 1, 1, 1, ry));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
}

/** Oil drums ×12 in small clusters, per-instance rust/paint tints. */
function buildBarrels(group: THREE.Group): void {
  const geo = new THREE.CylinderGeometry(0.3, 0.3, 0.85, 12);
  const mesh = new THREE.InstancedMesh(geo, getMaterial('barrel'), 12);
  mesh.name = 'barrels';
  const spots: [number, number, number][] = [
    [-24, 4, 0.2],
    [-24.6, 3.1, 1.1],
    [-23.4, 3.4, 0.7],
    [24, -6, 0.4],
    [24.7, -5.3, 1.5],
    [23.3, -5.5, 0.9],
    [10, 9.4, 0.1],
    [10.8, 10, 1.9],
    [-12.4, -0.6, 0.5],
    [-11.8, -1.4, 1.2],
    [26, 10.6, 0.3],
    [26.8, 10, 1.4],
  ];
  const tints = [PALETTE.rust, PALETTE.rust, PALETTE.container[0], PALETTE.container[3], PALETTE.tower[1]];
  const c = new THREE.Color();
  spots.forEach(([x, z, ry], i) => {
    setInst(mesh, i, x, 0.425, z, 1, 1, 1, ry);
    mesh.setColorAt(i, c.set(tints[i % tints.length]));
  });
  mesh.instanceColor!.needsUpdate = true;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
}

/** Cable reels ×4 — fat drum on its side + a protruding steel axle. */
function buildReels(group: THREE.Group): void {
  const drum = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.55, 0.55, 0.5, 14),
    getMaterial('wood'),
    4,
  );
  const hub = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.15, 0.15, 0.66, 10),
    getMaterial('pipe'),
    4,
  );
  drum.name = 'reel-drums';
  hub.name = 'reel-hubs';
  const spots: [number, number, number][] = [
    [-20, -2.5, 0.3],
    [21, 12, 1.2],
    [13.5, -14.5, 0.8],
    [-13.5, 17, 0.5],
  ];
  // rz 90° lays the cylinder's Y axis onto X; ry spins the drum's facing
  spots.forEach(([x, z, ry], i) => {
    setInst(drum, i, x, 0.55, z, 1, 1, 1, ry, 0, Math.PI / 2);
    setInst(hub, i, x, 0.55, z, 1, 1, 1, ry, 0, Math.PI / 2);
  });
  drum.castShadow = hub.castShadow = true;
  drum.receiveShadow = hub.receiveShadow = true;
  group.add(drum, hub);
}

/** Wooden crates ×10, varied footprints — unit cube scaled per instance. */
function buildCrates(group: THREE.Group): void {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mesh = new THREE.InstancedMesh(geo, getMaterial('wood'), 10);
  mesh.name = 'crates';
  // (x, z, sx, sy, sz, ry)
  const spots: [number, number, number, number, number, number][] = [
    [-19, 9.5, 0.9, 0.9, 0.9, 0.2],
    [-18.5, 8.6, 0.55, 0.55, 0.55, 0.9],
    [13, -4, 0.8, 0.7, 0.8, 0.4],
    [-3, -12.5, 0.7, 0.7, 0.7, 1.1],
    [17, 6.5, 1.0, 0.8, 0.7, 0.6],
    [23, -12, 0.75, 0.75, 0.75, 0.2],
    [-25, -9, 0.85, 0.6, 0.85, 0.8],
    [8, 14.5, 0.7, 0.7, 0.7, 1.4],
    [-15, -6.5, 0.9, 0.55, 0.9, 0.3],
    [3, 8.5, 0.65, 0.65, 0.65, 1.8],
  ];
  spots.forEach(([x, z, sx, sy, sz, ry], i) =>
    setInst(mesh, i, x, sy / 2, z, sx, sy, sz, ry),
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
}

/**
 * Extra containers beyond MAP's colliders — visual only. Three second-layer
 * stacks sit on the inner containers (their tops are unreachable, so nobody
 * can clip into these); one of them is askew. Two more squat at the deck ends.
 */
function buildStackedContainers(group: THREE.Group): void {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mesh = new THREE.InstancedMesh(geo, getMaterial('container'), 5);
  mesh.name = 'containers-stacked';
  const c = new THREE.Color();
  // (x, yCenter, z, sx, sy, sz, ry, rz, paletteIdx)
  const boxes: [number, number, number, number, number, number, number, number, number][] = [
    [-6, 3.9, -4, 6, 2.6, 2.5, 0.05, 0, 2], // level stack on (-6,-4)
    [6, 3.9, 4, 6, 2.6, 2.5, -0.04, 0, 0], // level stack on (6,4)
    [16, 4.0, -2, 6, 2.6, 2.5, 0.62, 0.1, 3], // askew on the (16,-2) top
    [29.8, 1.3, 18, 4, 2.6, 2.2, 0.1, 0, 1], // bow-side ground box
    [-29.8, 1.3, -18, 4, 2.6, 2.2, -0.08, 0, 0], // stern-side ground box
  ];
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

/** Deck drainage grates ×2 — flat textured planes just above the deck. */
function buildGrates(group: THREE.Group): void {
  const geo = new THREE.PlaneGeometry(1.4, 1.4);
  const mesh = new THREE.InstancedMesh(geo, getMaterial('grate'), 2);
  mesh.name = 'grates';
  setInst(mesh, 0, 1, 0.015, 7.5, 1, 1, 1, 0, -Math.PI / 2);
  setInst(mesh, 1, -9, 0.015, -6.5, 1, 1, 1, 0, -Math.PI / 2);
  mesh.receiveShadow = true;
  group.add(mesh);
}

/**
 * Fake contact shadows — unlit alpha blobs tucked under every tall collider.
 * One instanced draw call; cheap stand-in for baked AO.
 */
function buildAoBlobs(group: THREE.Group): void {
  const geo = new THREE.PlaneGeometry(1, 1);
  // grounded big boxes only — skips stair steps, crate stairs and platforms;
  // pipe walls count too (their long bases get a shadow strip)
  const list = MAP.boxes.filter(
    (b) =>
      b.y === 0 &&
      ((b.w >= 1.5 && b.d >= 1.5 && (b.kind === 'container' || b.kind === 'tower')) ||
        b.kind === 'pipe'),
  );
  // one blob per collider, footprint padded outward so the rim reads
  const mesh = new THREE.InstancedMesh(geo, getMaterial('ao'), list.length);
  mesh.name = 'ao-blobs';
  list.forEach((b, i) =>
    setInst(mesh, i, b.x, 0.012, b.z, b.w + 1.1, b.d + 1.1, 1, 0, -Math.PI / 2),
  );
  mesh.renderOrder = 1; // over the deck, under nothing transparent
  group.add(mesh);
}

/**
 * Contact-shadow band — a crisp 0.85m alpha-gradient strip hugging each side
 * of every grounded collider's base (four instances per box, one draw call).
 * Sits above the soft ao blob: the rim where hull meets deck.
 */
function buildAoEdges(group: THREE.Group): void {
  // plane baked flat: normal +y, texture's dark edge along local -z
  const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const BAND = 0.85;
  const list = MAP.boxes.filter(
    (b) =>
      b.y === 0 &&
      (((b.kind === 'container' || b.kind === 'tower') && b.w >= 1.5 && b.d >= 1.5) ||
        b.kind === 'pipe'),
  );
  // the two ground-level decorative containers (not in MAP.boxes)
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
    // each strip: length covers the side + both corners; gradient dark edge
    // faces the box. ry turns the baked -z dark edge toward the box.
    setInst(mesh, i++, b.x + hw + BAND / 2, 0.016, b.z, b.d + 2 * BAND, 1, BAND, Math.PI / 2);
    setInst(mesh, i++, b.x - hw - BAND / 2, 0.016, b.z, b.d + 2 * BAND, 1, BAND, -Math.PI / 2);
    setInst(mesh, i++, b.x, 0.016, b.z + hd + BAND / 2, b.w + 2 * BAND, 1, BAND, 0);
    setInst(mesh, i++, b.x, 0.016, b.z - hd - BAND / 2, b.w + 2 * BAND, 1, BAND, Math.PI);
  }
  mesh.renderOrder = 2;
  group.add(mesh);
}

/**
 * Silhouette layer: two distant harbour cranes across the water, a bow mast
 * on the +x tip and a stern crane arm on -x. All share one unlit material —
 * fog fades them into the sky. 14 + 4 + 3 = 21 instances, one draw call.
 */
function buildCranes(group: THREE.Group): void {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mesh = new THREE.InstancedMesh(geo, getMaterial('crane'), 21);
  mesh.name = 'cranes';

  const crane = (base: number, cx: number, cz: number, s: number, ry: number): number => {
    let i = base;
    const cos = Math.cos(ry);
    const sin = Math.sin(ry);
    const P = (x: number, y: number, z: number, sx: number, sy: number, sz: number, rz = 0): void => {
      const wx = cx + (x * cos + z * sin) * s;
      const wz = cz + (-x * sin + z * cos) * s;
      setInst(mesh, i++, wx, -2 + y * s, wz, sx * s, sy * s, sz * s, ry, 0, rz);
    };
    P(-4.5, 9, 0, 1.2, 18, 1.2); // leg L
    P(4.5, 9, 0, 1.2, 18, 1.2); // leg R
    P(0, 18.6, 0, 12, 1.6, 1.6); // top beam
    P(9, 20.2, 0, 20, 0.9, 0.9, 0.42); // jib (slopes down over the water)
    P(-7, 19.4, 0, 5.5, 1.3, 1.3); // counter-jib
    P(0, 16.6, 1.4, 2.4, 2.0, 1.8); // cab
    P(3, 24.5, 0, 1.4, 10, 0.5, -0.32); // apex tower / tie bar
    return i;
  };
  crane(0, 74, -46, 1.25, 0.35);
  crane(7, -82, 28, 0.9, -0.7);

  // bow mast on the +x tip: pole + yard + antenna whip + platform
  setInst(mesh, 14, 33.8, 5.5, 0, 0.4, 14, 0.4); // pole, base sinks below deck edge
  setInst(mesh, 15, 33.8, 8.2, 0, 0.22, 0.22, 3.4); // yard (horizontal, along z)
  setInst(mesh, 16, 33.8, 10.6, 0, 0.08, 4.4, 0.08); // antenna whip
  setInst(mesh, 17, 33.8, 7.2, 0, 1.2, 0.14, 1.2); // watch platform

  // stern crane arm on the -x tip: pedestal + tilted jib + counterweight
  setInst(mesh, 18, -34, 0.8, 0, 0.9, 3.2, 0.9); // pedestal
  setInst(mesh, 19, -34.6, 4.6, 0, 0.45, 8.5, 0.45, 0.2, 0, -0.52); // jib, leaning outboard
  setInst(mesh, 20, -33.4, 2.2, 0, 1.5, 1.2, 1.2); // counterweight block
  group.add(mesh);
}

/**
 * Self-lit anchors so the frame always has bright reference points:
 * red bow beacons ×2 on the mast yard ends, warm work lamps ×2 under tower
 * platforms, small corner markers ×2 on the spawn-side containers. Every bulb
 * pairs with a modest point light (1.5–3 / 8–15m) so it pools on geometry
 * instead of floating as a sprite.
 */
function buildLightAnchors(group: THREE.Group): void {
  const bulbGeo = new THREE.SphereGeometry(0.13, 8, 6);
  const warm = new THREE.InstancedMesh(bulbGeo, getMaterial('lamp'), 4);
  warm.name = 'anchor-warm';
  const warmSpots: [number, number, number][] = [
    [23.65, 2.9, -11.65], // under the SE tower platform lip
    [-23.65, 2.9, 11.65], // NW tower, 180° mirror
    [3.05, 2.72, 5.32], // container (6,4) top corner facing spawn A
    [-3.05, 2.72, -5.32], // container (-6,-4) mirror corner
  ];
  warmSpots.forEach(([x, y, z], i) => setInst(warm, i, x, y, z, 1, 1, 1));
  group.add(warm);
  const warmLight: [number, number, number, number][] = [
    // x, y, z, intensity — distance folded in below
    [23.65, 2.8, -11.65, 2.6],
    [-23.65, 2.8, 11.65, 2.6],
    [3.05, 2.72, 5.45, 1.8],
    [-3.05, 2.72, -5.45, 1.8],
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

/** Standing-water films — thin mirror planes that catch the sky env map. */
function buildPuddles(group: THREE.Group): void {
  const geo = new THREE.PlaneGeometry(1, 1);
  const mesh = new THREE.InstancedMesh(geo, getMaterial('puddle'), 4);
  mesh.name = 'puddles';
  // (x, z, sx, sz, in-plane yaw) — rz spins the flat plane about its own normal
  const spots: [number, number, number, number, number][] = [
    [-8.5, 12.8, 2.4, 3.4, 0.35],
    [-0.5, 8.2, 2.0, 2.8, -0.5],
    [7.0, 13.8, 2.8, 2.0, 0.9],
    [-14.5, 5.5, 2.2, 3.0, 0.2],
  ];
  spots.forEach(([x, z, sx, sz, yaw], i) =>
    setInst(mesh, i, x, 0.025, z, sx, sz, 1, 0, -Math.PI / 2, yaw),
  );
  mesh.receiveShadow = true;
  group.add(mesh);
}

/** Two lit openings far off — stern-pedestal hatch + a harbour-crane cab. */
function buildWindows(group: THREE.Group): void {
  const geo = new THREE.PlaneGeometry(1, 1);
  const mesh = new THREE.InstancedMesh(geo, getMaterial('window'), 2);
  mesh.name = 'windows';
  setInst(mesh, 0, -33.52, 0.95, 0, 0.55, 1.35, 1, Math.PI / 2); // hatch faces +x
  setInst(mesh, 1, 73.55, 18.7, -43.75, 1.5, 1.05, 1, -1.03); // cab faces the map
  group.add(mesh);
}

/** Two work lamps — point light + a small self-lit bulb at each mast. */
function buildWorkLamps(group: THREE.Group): void {
  const geo = new THREE.SphereGeometry(0.22, 8, 6);
  const bulbs = new THREE.InstancedMesh(geo, getMaterial('lamp'), 2);
  bulbs.name = 'lamp-bulbs';
  const heads: [number, number, number][] = [
    [33.6, 8.6, 0.5], // bow mast head
    [-34.4, 7.6, -0.4], // stern crane head
  ];
  heads.forEach(([x, y, z], i) => setInst(bulbs, i, x, y, z, 1, 1, 1));
  group.add(bulbs);

  for (const [x, y, z] of heads) {
    const l = new THREE.PointLight(PALETTE.lampWarm, 40, 30, 2);
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
    // containers get a private clone — the shared cube must not carry the
    // per-instance aSize/aUvOffset attributes their material now expects
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

  // Sea — Saltline water port (see sea.ts): swell + foam ring + sun glitter.
  const sea = createSea();
  group.add(sea);

  scene.add(group);
  return { group, byKind, sea };
}
