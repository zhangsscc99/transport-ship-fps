// Turns MAP's pure Box data into three.js geometry.
// Same-kind boxes share one InstancedMesh (unit cube scaled per instance) and
// all decorative props are instanced too — the whole ship stays ~15 draw calls.
// ART-SPEC §5.

import * as THREE from 'three';
import { MAP, type Box } from '../game/map';
import { PALETTE } from './palette';
import { getMaterial } from './materials';
import type { MaterialKind } from './materials';

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

/** Wooden pallets ×10 scattered between the lanes. */
function buildPallets(group: THREE.Group): void {
  const geo = new THREE.BoxGeometry(1.1, 0.12, 0.9);
  const mesh = new THREE.InstancedMesh(geo, getMaterial('wood'), 10);
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
  ];
  spots.forEach(([x, z, ry], i) => setInst(mesh, i, x, 0.06, z, 1, 1, 1, ry));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
}

/** Two distant harbour-crane silhouettes across the water — fog does the rest. */
function buildCranes(group: THREE.Group): void {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mesh = new THREE.InstancedMesh(geo, getMaterial('crane'), 14);
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
  group.add(mesh);
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
    const mesh = new THREE.InstancedMesh(unitCube, mat, boxes.length);
    mesh.name = `map-${kind}`;
    const c = new THREE.Color();
    boxes.forEach((b, i) => {
      mat4.makeScale(b.w, b.h, b.d);
      mat4.setPosition(b.x, b.y + b.h / 2, b.z);
      mesh.setMatrixAt(i, mat4);
      if (kind === 'container') {
        mesh.setColorAt(i, c.set(PALETTE.container[i % PALETTE.container.length]));
      }
    });
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
  buildRails(group);
  buildCranes(group);

  // Sea — a standard material now so the sun leaves a glint on the swell.
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), getMaterial('sea'));
  sea.rotation.x = -Math.PI / 2;
  sea.position.y = MAP.waterY;
  sea.name = 'sea';
  group.add(sea);

  scene.add(group);
  return { group, byKind, sea };
}
