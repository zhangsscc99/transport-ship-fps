// Turns MAP's pure Box data into three.js geometry.
// Same-kind boxes share one InstancedMesh (unit cube scaled per instance) —
// 5 draw calls for all map geometry plus the sea plane. ART-SPEC §5.

import * as THREE from 'three';
import { MAP, type Box } from '../game/map';
import { PALETTE } from './palette';

const KIND_COLOR: Record<Box['kind'], string> = {
  deck: PALETTE.deck[1],
  container: '#ffffff', // per-instance colors below
  tower: PALETTE.tower[0],
  rail: PALETTE.tower[1],
  pipe: PALETTE.pipe,
};

export interface MapMeshes {
  group: THREE.Group;
  byKind: Record<Box['kind'], THREE.InstancedMesh>;
  sea: THREE.Mesh;
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
    const mat = new THREE.MeshLambertMaterial({ color: KIND_COLOR[kind] });
    const mesh = new THREE.InstancedMesh(unitCube, mat, boxes.length);
    mesh.name = `map-${kind}`;
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    boxes.forEach((b, i) => {
      m.makeScale(b.w, b.h, b.d);
      m.setPosition(b.x, b.y + b.h / 2, b.z);
      mesh.setMatrixAt(i, m);
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

  // Dark sea plane — falls away to the horizon under the fog.
  const sea = new THREE.Mesh(
    new THREE.PlaneGeometry(600, 600),
    new THREE.MeshLambertMaterial({ color: PALETTE.sea[1] }),
  );
  sea.rotation.x = -Math.PI / 2;
  sea.position.y = MAP.waterY;
  sea.name = 'sea';
  group.add(sea);

  scene.add(group);
  return { group, byKind, sea };
}
