import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createBossModel, type BossAnim } from './bossModel.ts';

function countSceneTriangles(root: THREE.Object3D): number {
  let total = 0;
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const geo = obj.geometry;
    if (!geo) return;
    const idx = geo.getIndex();
    if (idx) {
      total += Math.round(idx.count / 3);
    } else {
      const pos = geo.getAttribute('position');
      if (pos) total += Math.round(pos.count / 3);
    }
  });
  return total;
}

function collectUniqueMaterials(root: THREE.Object3D): Set<THREE.Material> {
  const mats = new Set<THREE.Material>();
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    if (Array.isArray(obj.material)) {
      for (const m of obj.material) mats.add(m);
    } else if (obj.material) {
      mats.add(obj.material);
    }
  });
  return mats;
}

function isUnderRoot(root: THREE.Object3D, node: THREE.Object3D): boolean {
  let cur: THREE.Object3D | null = node;
  while (cur) {
    if (cur === root) return true;
    cur = cur.parent;
  }
  return false;
}

function getCoreMaterial(core: THREE.Object3D): THREE.MeshStandardMaterial {
  if (core instanceof THREE.Mesh && core.material instanceof THREE.MeshStandardMaterial) {
    return core.material;
  }
  let found: THREE.MeshStandardMaterial | null = null;
  core.traverse((obj) => {
    if (!found && obj instanceof THREE.Mesh && obj.material instanceof THREE.MeshStandardMaterial) {
      found = obj.material;
    }
  });
  assert.ok(found, 'expected core to have a MeshStandardMaterial');
  return found;
}

// Required verification test #1: triangle count <= 20,000 & material budget <= 6
test('bossModel: triangle count <= 20000 and material count <= 6 with lava-cracked PBR textures', () => {
  const boss = createBossModel();
  try {
    const tris = countSceneTriangles(boss.parts.root);
    assert.ok(tris > 3000 && tris <= 20000, `expected tris in (3000, 20000], got ${tris}`);

    const mats = collectUniqueMaterials(boss.parts.root);
    assert.ok(mats.size >= 2 && mats.size <= 6, `expected <= 6 materials, got ${mats.size}`);

    const torsoSkin = boss.parts.root.getObjectByName('boss-torso-skin') as THREE.Mesh | undefined;
    assert.ok(torsoSkin, 'expected boss-torso-skin mesh');
    const skinMat = torsoSkin.material as THREE.MeshStandardMaterial;
    assert.ok(skinMat.map && skinMat.emissiveMap && skinMat.normalMap, 'expected procedural lava atlas + emissiveMap + normalMap');
    assert.ok(skinMat.emissiveIntensity > 0.5, `expected lava fissures to self-glow in Phase 1, got ${skinMat.emissiveIntensity}`);
  } finally {
    boss.dispose();
  }
});

// Required verification test #2: standing height strictly within 4.0-4.2m with soles grounded at y=0
test('bossModel: standing height is within 4.0-4.2m with soles flush at y=0', () => {
  const boss = createBossModel();
  try {
    boss.parts.root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(boss.parts.root);
    const height = box.max.y - box.min.y;
    assert.ok(
      height >= 4.0 && height <= 4.2,
      `expected standing boss height in [4.0, 4.2]m, got ${height.toFixed(3)}m (minY=${box.min.y.toFixed(3)}, maxY=${box.max.y.toFixed(3)})`,
    );
    assert.ok(
      Math.abs(box.min.y) <= 0.02,
      `expected feet grounded flush at y=0, got minY=${box.min.y.toFixed(4)}`,
    );
  } finally {
    boss.dispose();
  }
});

// Required verification test #3: rightArm joint matrix must differ between windup and attack
test('bossModel: windup and attack produce distinct rightArm joint matrices', () => {
  const boss = createBossModel();
  try {
    for (let i = 0; i < 20; i++) boss.update(0.04, { hpPct: 1, phase: 1, anim: 'windup' });
    boss.parts.root.updateMatrixWorld(true);
    const windupLocal = boss.parts.rightArm.matrix.clone();
    const windupWorld = boss.parts.rightArm.matrixWorld.clone();

    for (let i = 0; i < 10; i++) boss.update(0.02, { hpPct: 1, phase: 1, anim: 'attack' });
    boss.parts.root.updateMatrixWorld(true);
    const attackLocal = boss.parts.rightArm.matrix.clone();
    const attackWorld = boss.parts.rightArm.matrixWorld.clone();

    let maxLocalDiff = 0;
    let maxWorldDiff = 0;
    for (let i = 0; i < 16; i++) {
      maxLocalDiff = Math.max(maxLocalDiff, Math.abs(windupLocal.elements[i] - attackLocal.elements[i]));
      maxWorldDiff = Math.max(maxWorldDiff, Math.abs(windupWorld.elements[i] - attackWorld.elements[i]));
    }
    assert.ok(
      maxLocalDiff > 0.4,
      `expected windup vs attack rightArm local matrix to differ significantly, maxDiff=${maxLocalDiff.toFixed(4)}`,
    );
    assert.ok(
      maxWorldDiff > 0.4,
      `expected windup vs attack rightArm world matrix to differ significantly, maxDiff=${maxWorldDiff.toFixed(4)}`,
    );
  } finally {
    boss.dispose();
  }
});

test('bossModel: all required parts + articulated 6-segment tail belong to root skeleton hierarchy', () => {
  const boss = createBossModel();
  try {
    const { root, torso, head, core, leftArm, rightArm, tail } = boss.parts;
    const partEntries: Array<[string, THREE.Object3D | undefined]> = [
      ['root', root],
      ['torso', torso],
      ['head', head],
      ['core', core],
      ['leftArm', leftArm],
      ['rightArm', rightArm],
      ['tail', tail],
    ];
    assert.ok(root instanceof THREE.Group, 'root must be a THREE.Group');
    for (const [name, obj] of partEntries) {
      assert.ok(obj instanceof THREE.Object3D, `part "${name}" must exist as THREE.Object3D`);
      assert.ok(isUnderRoot(root, obj), `part "${name}" must be attached under root`);
      if (name !== 'root') {
        assert.notEqual(obj.parent, null, `part "${name}" must have a parent inside root`);
      }
    }

    for (const boneName of [
      'boss-body',
      'boss-torso',
      'boss-torso-bone',
      'boss-head',
      'boss-core',
      'boss-shoulder-l',
      'boss-elbow-l',
      'boss-hand-l',
      'boss-shoulder-r',
      'boss-elbow-r',
      'boss-hand-r',
      'boss-hips',
      'boss-tail',
      'boss-tail-seg-0',
      'boss-tail-seg-1',
      'boss-tail-seg-2',
      'boss-tail-seg-3',
      'boss-tail-seg-4',
      'boss-tail-seg-5',
      'boss-thigh-l',
      'boss-shin-l',
      'boss-foot-l',
      'boss-thigh-r',
      'boss-shin-r',
      'boss-foot-r',
    ]) {
      const bone = root.getObjectByName(boneName);
      assert.ok(bone, `expected skeleton bone "${boneName}"`);
      assert.ok(isUnderRoot(root, bone), `bone "${boneName}" must be under root`);
    }
  } finally {
    boss.dispose();
  }
});

test('bossModel: update() animates arms, torso, and counter-phase tail across all 6 anim states', () => {
  const anims: BossAnim[] = ['idle', 'walk', 'windup', 'attack', 'recover', 'charge'];

  for (const anim of anims) {
    const boss = createBossModel();
    try {
      const initialRotX = boss.parts.rightArm.rotation.x;
      const steps = anim === 'attack' ? 9 : 16;
      const dt = anim === 'attack' ? 0.02 : 0.04;
      for (let i = 0; i < steps; i++) {
        boss.update(dt, { hpPct: 1, phase: 1, anim });
      }
      const afterRotX = boss.parts.rightArm.rotation.x;
      const delta = Math.abs(afterRotX - initialRotX);
      assert.ok(
        delta > 0.05,
        `anim "${anim}" must change rightArm.rotation.x (init=${initialRotX.toFixed(3)}, after=${afterRotX.toFixed(3)})`,
      );

      // Ensure root itself is never translated directly (joint-driven animation only)
      assert.equal(boss.parts.root.position.x, 0);
      assert.equal(boss.parts.root.position.y, 0);
      assert.equal(boss.parts.root.position.z, 0);
    } finally {
      boss.dispose();
    }
  }

  // Targeted kinematic assertions: windup, attack, charge, and walk tail counter-phase sway
  const boss = createBossModel();
  try {
    const torso = boss.parts.torso!;
    const coreMat = getCoreMaterial(boss.parts.core);
    const tailSeg2 = boss.parts.root.getObjectByName('boss-tail-seg-2')!;

    for (let i = 0; i < 20; i++) boss.update(0.05, { hpPct: 1, phase: 1, anim: 'idle' });
    const idleCoreEmissive = coreMat.emissiveIntensity;
    assert.ok(
      torso.scale.y >= 0.999 && torso.scale.y <= 1.022,
      `idle torso breathing scaleY out of range: ${torso.scale.y}`,
    );

    // Walk: tail segments actively sway counter-phase to arm swing
    let minTailYaw = Infinity;
    let maxTailYaw = -Infinity;
    for (let i = 0; i < 40; i++) {
      boss.update(0.05, { hpPct: 1, phase: 1, anim: 'walk' });
      minTailYaw = Math.min(minTailYaw, tailSeg2.rotation.y);
      maxTailYaw = Math.max(maxTailYaw, tailSeg2.rotation.y);
    }
    assert.ok(
      maxTailYaw - minTailYaw > 0.18,
      `walk tail should sway noticeably (range=${(maxTailYaw - minTailYaw).toFixed(3)})`,
    );

    // Windup: rightArm back ~-1.3rad, torso pitched back ~+16°, core warning glow
    for (let i = 0; i < 25; i++) boss.update(0.04, { hpPct: 1, phase: 1, anim: 'windup' });
    assert.ok(boss.parts.rightArm.rotation.x < -0.95, `windup rightArm should raise backward, got ${boss.parts.rightArm.rotation.x.toFixed(3)}`);
    assert.ok(torso.rotation.x > 0.2, `windup torso should lean backward, got ${torso.rotation.x.toFixed(3)}`);
    assert.ok(
      coreMat.emissiveIntensity > idleCoreEmissive * 1.2,
      `windup core should surge, idle=${idleCoreEmissive.toFixed(2)}, windup=${coreMat.emissiveIntensity.toFixed(2)}`,
    );

    // Attack: explosive downward/forward claw slash within 0.18s
    for (let i = 0; i < 9; i++) boss.update(0.02, { hpPct: 1, phase: 1, anim: 'attack' });
    assert.ok(boss.parts.rightArm.rotation.x > 0.85, `attack rightArm should slash forward, got ${boss.parts.rightArm.rotation.x.toFixed(3)}`);
    assert.ok(torso.rotation.x < -0.18, `attack torso should lunge forward, got ${torso.rotation.x.toFixed(3)}`);

    // Charge: deep forward lean, head lowered, both arms swept back
    for (let i = 0; i < 25; i++) boss.update(0.04, { hpPct: 1, phase: 1, anim: 'charge' });
    assert.ok(torso.rotation.x < -0.38, `charge torso should pitch forward steeply, got ${torso.rotation.x.toFixed(3)}`);
    assert.ok(boss.parts.head.rotation.x < -0.3, `charge head should drop low, got ${boss.parts.head.rotation.x.toFixed(3)}`);
    assert.ok(boss.parts.leftArm.rotation.x < -0.5, `charge leftArm should sweep back, got ${boss.parts.leftArm.rotation.x.toFixed(3)}`);
    assert.ok(boss.parts.rightArm.rotation.x < -0.5, `charge rightArm should sweep back, got ${boss.parts.rightArm.rotation.x.toFixed(3)}`);
  } finally {
    boss.dispose();
  }
});

test('bossModel: phase 2 (hpPct <= 0.35) heats lava cracks, core, and bone tips without flashing whole skin albedo', () => {
  const boss = createBossModel();
  try {
    const coreMat = getCoreMaterial(boss.parts.core);
    const torsoSkin = boss.parts.root.getObjectByName('boss-torso-skin') as THREE.Mesh;
    const torsoBone = boss.parts.root.getObjectByName('boss-torso-bone') as THREE.Mesh;
    const skinMat = torsoSkin.material as THREE.MeshStandardMaterial;
    const boneMat = torsoBone.material as THREE.MeshStandardMaterial;

    for (let i = 0; i < 15; i++) boss.update(0.05, { hpPct: 0.8, phase: 1, anim: 'idle' });
    const p1CoreEm = coreMat.emissiveIntensity;
    const p1SkinEm = skinMat.emissiveIntensity;
    const p1BoneEm = boneMat.emissiveIntensity;
    const p1ColorHex = skinMat.color.getHex();
    const p1Scale = boss.parts.core.scale.x;

    for (let i = 0; i < 20; i++) boss.update(0.05, { hpPct: 0.35, phase: 2, anim: 'idle' });
    const p2CoreEm = coreMat.emissiveIntensity;
    const p2SkinEm = skinMat.emissiveIntensity;
    const p2BoneEm = boneMat.emissiveIntensity;
    const p2ColorHex = skinMat.color.getHex();
    const p2Scale = boss.parts.core.scale.x;

    assert.ok(
      p2CoreEm > p1CoreEm * 1.4,
      `expected phase 2 core emissiveIntensity (${p2CoreEm.toFixed(2)}) >> phase 1 (${p1CoreEm.toFixed(2)})`,
    );
    assert.ok(
      p2SkinEm > p1SkinEm * 1.6,
      `expected phase 2 lava crack emissive (${p2SkinEm.toFixed(2)}) >> phase 1 (${p1SkinEm.toFixed(2)})`,
    );
    assert.ok(
      p2BoneEm > p1BoneEm * 5,
      `expected phase 2 bone-tip translucency glow (${p2BoneEm.toFixed(2)}) >> phase 1 (${p1BoneEm.toFixed(2)})`,
    );
    assert.ok(
      p2Scale > p1Scale + 0.08,
      `expected phase 2 core exposure to enlarge (p1=${p1Scale.toFixed(3)}, p2=${p2Scale.toFixed(3)})`,
    );
    // Must heat up via lava emissiveMap, NEVER flash the entire skin base color red!
    assert.equal(p2ColorHex, p1ColorHex, 'skin base albedo must stay steady (no whole-body red alarm flash)');
  } finally {
    boss.dispose();
  }
});

test('bossModel: dispose() detaches root from parent and disposes all geometries and materials', () => {
  const scene = new THREE.Scene();
  const boss = createBossModel();
  scene.add(boss.parts.root);
  assert.equal(boss.parts.root.parent, scene);

  const geos = new Set<THREE.BufferGeometry>();
  const mats = new Set<THREE.Material>();
  boss.parts.root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      geos.add(obj.geometry);
      if (Array.isArray(obj.material)) {
        for (const m of obj.material) mats.add(m);
      } else {
        mats.add(obj.material);
      }
    }
  });
  assert.ok(geos.size > 0, 'expected geometries to track');
  assert.ok(mats.size > 0, 'expected materials to track');

  let geoDisposed = 0;
  let matDisposed = 0;
  for (const g of geos) {
    const orig = g.dispose.bind(g);
    g.dispose = () => {
      geoDisposed++;
      orig();
    };
  }
  for (const m of mats) {
    const orig = m.dispose.bind(m);
    m.dispose = () => {
      matDisposed++;
      orig();
    };
  }

  boss.dispose();
  assert.equal(boss.parts.root.parent, null, 'root.parent must be null after dispose()');
  assert.equal(geoDisposed, geos.size, `expected all ${geos.size} geometries disposed, got ${geoDisposed}`);
  assert.equal(matDisposed, mats.size, `expected all ${mats.size} materials disposed, got ${matDisposed}`);

  // Calling dispose() a second time must be a safe no-op
  boss.dispose();
  assert.equal(geoDisposed, geos.size);
  assert.equal(matDisposed, mats.size);
});
