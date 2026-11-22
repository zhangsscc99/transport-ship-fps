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

test('bossModel: triangle budget <= 20000, height in 3.5-4.5m, organic PBR skin bounds', () => {
  const boss = createBossModel();
  try {
    const tris = countSceneTriangles(boss.parts.root);
    assert.ok(tris > 2000 && tris <= 20000, `expected tris in (2000, 20000], got ${tris}`);

    boss.parts.root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(boss.parts.root);
    const height = box.max.y - box.min.y;
    assert.ok(
      height >= 3.5 && height <= 4.5,
      `expected standing boss height in [3.5, 4.5]m, got ${height.toFixed(3)}m (minY=${box.min.y.toFixed(3)}, maxY=${box.max.y.toFixed(3)})`,
    );
    assert.ok(
      Math.abs(box.min.y) <= 0.12,
      `expected feet grounded near y=0, got minY=${box.min.y.toFixed(3)}`,
    );

    const torsoSkin = boss.parts.root.getObjectByName('boss-torso-skin') as THREE.Mesh | undefined;
    assert.ok(torsoSkin, 'expected boss-torso-skin mesh');
    const skinMat = torsoSkin.material as THREE.MeshStandardMaterial;
    assert.ok(
      skinMat.roughness >= 0.75 && skinMat.roughness <= 0.9,
      `expected skin roughness in [0.75, 0.9], got ${skinMat.roughness}`,
    );
    assert.ok(
      Math.abs(skinMat.metalness - 0.05) < 1e-6,
      `expected skin metalness 0.05, got ${skinMat.metalness}`,
    );
    assert.equal(skinMat.color.getHex(), new THREE.Color('#3A3F38').getHex());
    assert.ok(skinMat.map && skinMat.normalMap && skinMat.roughnessMap, 'expected procedural skin textures');
  } finally {
    boss.dispose();
  }
});

test('bossModel: all 6 parts exist and belong to root skeleton hierarchy', () => {
  const boss = createBossModel();
  try {
    const { root, torso, head, core, leftArm, rightArm } = boss.parts;
    const partEntries: Array<[string, THREE.Object3D | undefined]> = [
      ['root', root],
      ['torso', torso],
      ['head', head],
      ['core', core],
      ['leftArm', leftArm],
      ['rightArm', rightArm],
    ];
    assert.equal(partEntries.length, 6);
    assert.ok(root instanceof THREE.Group, 'root must be a THREE.Group');
    for (const [name, obj] of partEntries) {
      assert.ok(obj instanceof THREE.Object3D, `part "${name}" must exist as THREE.Object3D`);
      assert.ok(isUnderRoot(root, obj), `part "${name}" must be attached under root`);
      if (name !== 'root') {
        assert.notEqual(obj.parent, null, `part "${name}" must have a parent inside root`);
      }
    }

    // Verify full articulated bone hierarchy (arms: shoulder -> elbow -> hand; legs: hips -> thigh -> shin -> foot)
    for (const boneName of [
      'boss-body',
      'boss-torso',
      'boss-head',
      'boss-core',
      'boss-shoulder-l',
      'boss-elbow-l',
      'boss-hand-l',
      'boss-shoulder-r',
      'boss-elbow-r',
      'boss-hand-r',
      'boss-hips',
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

test('bossModel: update() animates rightArm.rotation.x across all 6 anim states with expected kinematics', () => {
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

  // Targeted kinematic assertions: windup raises rightArm back ~1.2rad & torso back 15°, attack swings down in 0.18s, charge leans forward 25°
  const boss = createBossModel();
  try {
    const torso = boss.parts.torso!;
    const coreMat = getCoreMaterial(boss.parts.core);

    // Idle baseline
    for (let i = 0; i < 20; i++) boss.update(0.05, { hpPct: 1, phase: 1, anim: 'idle' });
    const idleCoreEmissive = coreMat.emissiveIntensity;
    assert.ok(
      torso.scale.y >= 0.999 && torso.scale.y <= 1.022,
      `idle torso breathing scaleY out of range: ${torso.scale.y}`,
    );

    // Windup: rightArm back ~-1.2rad, torso pitched back ~+15° (+0.262rad), core +40% warning glow
    for (let i = 0; i < 25; i++) boss.update(0.04, { hpPct: 1, phase: 1, anim: 'windup' });
    const windupArmX = boss.parts.rightArm.rotation.x;
    assert.ok(windupArmX < -0.95, `windup rightArm should raise backward (~-1.2rad), got ${windupArmX.toFixed(3)}`);
    assert.ok(torso.rotation.x > 0.2, `windup torso should lean backward (+15°), got ${torso.rotation.x.toFixed(3)}`);
    assert.ok(
      coreMat.emissiveIntensity > idleCoreEmissive * 1.2,
      `windup core should surge (~+40%), idle=${idleCoreEmissive.toFixed(2)}, windup=${coreMat.emissiveIntensity.toFixed(2)}`,
    );

    // Attack: explosive downward swing within 0.18s
    for (let i = 0; i < 9; i++) boss.update(0.02, { hpPct: 1, phase: 1, anim: 'attack' });
    const attackArmX = boss.parts.rightArm.rotation.x;
    assert.ok(
      attackArmX > 0.85,
      `attack rightArm should smash forward/down within 0.18s, got ${attackArmX.toFixed(3)}`,
    );
    assert.ok(torso.rotation.x < -0.18, `attack torso should pitch forward, got ${torso.rotation.x.toFixed(3)}`);

    // Charge: torso forward ~25° (-0.436rad), head lowered, both arms swept back
    for (let i = 0; i < 25; i++) boss.update(0.04, { hpPct: 1, phase: 1, anim: 'charge' });
    assert.ok(torso.rotation.x < -0.35, `charge torso should pitch forward ~25°, got ${torso.rotation.x.toFixed(3)}`);
    assert.ok(boss.parts.head.rotation.x < -0.3, `charge head should drop low, got ${boss.parts.head.rotation.x.toFixed(3)}`);
    assert.ok(boss.parts.leftArm.rotation.x < -0.5, `charge leftArm should sweep back, got ${boss.parts.leftArm.rotation.x.toFixed(3)}`);
    assert.ok(boss.parts.rightArm.rotation.x < -0.5, `charge rightArm should sweep back, got ${boss.parts.rightArm.rotation.x.toFixed(3)}`);
  } finally {
    boss.dispose();
  }
});

test('bossModel: phase 2 increases core emissiveIntensity, enlarges core exposure, and dark-reddens skin', () => {
  const boss = createBossModel();
  try {
    const coreMat = getCoreMaterial(boss.parts.core);
    const torsoSkin = boss.parts.root.getObjectByName('boss-torso-skin') as THREE.Mesh;
    const skinMat = torsoSkin.material as THREE.MeshStandardMaterial;

    for (let i = 0; i < 12; i++) boss.update(0.05, { hpPct: 0.8, phase: 1, anim: 'idle' });
    const p1Emissive = coreMat.emissiveIntensity;
    const p1Scale = boss.parts.core.scale.x;
    const p1Red = skinMat.color.r;

    for (let i = 0; i < 12; i++) boss.update(0.05, { hpPct: 0.35, phase: 2, anim: 'idle' });
    const p2Emissive = coreMat.emissiveIntensity;
    const p2Scale = boss.parts.core.scale.x;
    const p2Red = skinMat.color.r;

    assert.ok(
      p2Emissive > p1Emissive,
      `expected phase 2 core emissiveIntensity (${p2Emissive.toFixed(2)}) > phase 1 (${p1Emissive.toFixed(2)})`,
    );
    assert.ok(
      p2Scale > p1Scale + 0.08,
      `expected phase 2 core to enlarge (p1=${p1Scale.toFixed(3)}, p2=${p2Scale.toFixed(3)})`,
    );
    assert.ok(
      p2Red > p1Red,
      `expected phase 2 skin to shift toward dark crimson (p1R=${p1Red.toFixed(3)}, p2R=${p2Red.toFixed(3)})`,
    );
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
