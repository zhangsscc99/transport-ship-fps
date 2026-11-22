import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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

function getMeshMaterial(node: THREE.Object3D): THREE.MeshStandardMaterial {
  if (node instanceof THREE.Mesh && node.material instanceof THREE.MeshStandardMaterial) {
    return node.material;
  }
  let found: THREE.MeshStandardMaterial | null = null;
  node.traverse((obj) => {
    if (!found && obj instanceof THREE.Mesh && obj.material instanceof THREE.MeshStandardMaterial) {
      found = obj.material;
    }
  });
  assert.ok(found, `expected ${node.name || 'object'} to have a MeshStandardMaterial`);
  return found;
}

function resolveBossModelSource(): string {
  const candidates = [
    new URL('./bossModel.ts', import.meta.url),
    new URL('../render/bossModel.ts', import.meta.url),
  ];
  for (const url of candidates) {
    if (existsSync(url)) return readFileSync(url, 'utf8');
  }
  throw new Error('Could not locate src/render/bossModel.ts for external-asset audit');
}

// Required verification test #1: triangle count <= 20,000 & material budget <= 6
test('bossModel: triangle count <= 20000 and material count <= 6 with procedural hard-surface PBR atlas', () => {
  const boss = createBossModel();
  try {
    const tris = countSceneTriangles(boss.parts.root);
    assert.ok(tris > 3000 && tris <= 20000, `expected tris in (3000, 20000], got ${tris}`);

    const mats = collectUniqueMaterials(boss.parts.root);
    assert.ok(mats.size >= 3 && mats.size <= 6, `expected 3..6 materials, got ${mats.size}`);

    const torsoArmor = boss.parts.root.getObjectByName('boss-torso-armor') as THREE.Mesh | undefined;
    assert.ok(torsoArmor, 'expected boss-torso-armor mesh');
    const armorMat = torsoArmor.material as THREE.MeshStandardMaterial;
    assert.ok(
      armorMat.map && armorMat.normalMap && armorMat.emissiveMap,
      'expected procedural metal atlas + normalMap + seam emissiveMap',
    );
    assert.ok(armorMat.metalness >= 0.5, `expected metallic armor PBR, got metalness=${armorMat.metalness}`);
    // Phase 1 armor seams should stay understated so steel reads cold and industrial
    assert.ok(
      armorMat.emissiveIntensity < 0.2,
      `expected subtle Phase 1 armor seam glow, got ${armorMat.emissiveIntensity}`,
    );
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
      `expected armored boots grounded flush at y=0, got minY=${box.min.y.toFixed(4)}`,
    );
  } finally {
    boss.dispose();
  }
});

// Required verification test #3: rightArm joint matrix must differ between windup and attack
// plus verify the 60-100ms hydraulic lock hold before attack release!
test('bossModel: windup and attack produce distinct rightArm joint matrices with brief hydraulic lock', () => {
  const boss = createBossModel();
  try {
    for (let i = 0; i < 20; i++) boss.update(0.04, { hpPct: 1, phase: 1, anim: 'windup' });
    boss.parts.root.updateMatrixWorld(true);
    const windupLocal = boss.parts.rightArm.matrix.clone();
    const windupWorld = boss.parts.rightArm.matrixWorld.clone();
    const windupArmX = boss.parts.rightArm.rotation.x;

    // 40ms into attack (inside 75ms hydraulic lock): arm remains tightly clamped in coiled lock
    boss.update(0.02, { hpPct: 1, phase: 1, anim: 'attack' });
    boss.update(0.02, { hpPct: 1, phase: 1, anim: 'attack' });
    const lockedArmX = boss.parts.rightArm.rotation.x;
    assert.ok(
      Math.abs(lockedArmX - windupArmX) < 0.25 && lockedArmX < -1.1,
      `expected rightArm to hold rigid hydraulic lock during first ~75ms of attack (windup=${windupArmX.toFixed(3)}, locked=${lockedArmX.toFixed(3)})`,
    );

    // Advance past hydraulic release through cleave follow-through (total 0.18s)
    for (let i = 0; i < 7; i++) boss.update(0.02, { hpPct: 1, phase: 1, anim: 'attack' });
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
      maxLocalDiff > 0.6,
      `expected windup vs attack rightArm local matrix to differ significantly, maxDiff=${maxLocalDiff.toFixed(4)}`,
    );
    assert.ok(
      maxWorldDiff > 0.6,
      `expected windup vs attack rightArm world matrix to differ significantly, maxDiff=${maxWorldDiff.toFixed(4)}`,
    );
  } finally {
    boss.dispose();
  }
});

// Required verification test #4: strictly zero external model/texture/image references
test('bossModel: zero external model/texture/image asset references (100% procedural)', () => {
  const source = resolveBossModelSource();
  const forbiddenAssetPatterns: Array<[string, RegExp]> = [
    ['3D model extension (.glb/.gltf/.fbx/.obj)', /\.(glb|gltf|fbx|obj)\b/gi],
    ['image texture extension (.png/.jpg/.jpeg/.webp/.ktx2/.dds)', /\.(png|jpe?g|webp|ktx2|dds|bmp|tga)\b/gi],
    ['Three.js external loader', /\b(GLTFLoader|FBXLoader|OBJLoader|TextureLoader|ImageLoader|KTX2Loader)\b/g],
    ['network/data fetch or Image element', /\b(fetch\s*\(|new\s+Image\s*\(|XMLHttpRequest)\b/g],
  ];

  let externalRefCount = 0;
  const hits: string[] = [];
  for (const [label, re] of forbiddenAssetPatterns) {
    const matches = source.match(re);
    if (matches && matches.length > 0) {
      externalRefCount += matches.length;
      hits.push(`${label}: ${matches.join(', ')}`);
    }
  }
  assert.equal(
    externalRefCount,
    0,
    `expected 0 external asset references in bossModel.ts, found ${externalRefCount} (${hits.join('; ')})`,
  );
});

test('bossModel: all required parts + heavy mech assemblies belong to root skeleton hierarchy', () => {
  const boss = createBossModel();
  try {
    const {
      root,
      torso,
      head,
      core,
      leftArm,
      rightArm,
      leftShoulder,
      rightShoulder,
      rightBlade,
      ventGlow,
      monoEye,
    } = boss.parts;

    const partEntries: Array<[string, THREE.Object3D | undefined]> = [
      ['root', root],
      ['torso', torso],
      ['head', head],
      ['core', core],
      ['leftArm', leftArm],
      ['rightArm', rightArm],
      ['leftShoulder', leftShoulder],
      ['rightShoulder', rightShoulder],
      ['rightBlade', rightBlade],
      ['ventGlow', ventGlow],
      ['monoEye', monoEye],
    ];
    assert.ok(root instanceof THREE.Group, 'root must be a THREE.Group');
    for (const [name, obj] of partEntries) {
      assert.ok(obj instanceof THREE.Object3D, `part "${name}" must exist as THREE.Object3D`);
      assert.ok(isUnderRoot(root, obj), `part "${name}" must be attached under root`);
      if (name !== 'root') {
        assert.notEqual(obj.parent, null, `part "${name}" must have a parent inside root`);
      }
    }

    // Pure heavy mech — zero organic tail or organic skin/bone meshes
    assert.equal(root.getObjectByName('boss-tail'), undefined, 'heavy mech must not have an organic tail');
    assert.equal(root.getObjectByName('boss-torso-skin'), undefined, 'heavy mech must not have organic skin');
    assert.equal(root.getObjectByName('boss-torso-bone'), undefined, 'heavy mech must not have organic bone');

    for (const boneName of [
      'boss-body',
      'boss-torso',
      'boss-torso-armor',
      'boss-torso-frame',
      'boss-head',
      'boss-mono-eye',
      'boss-core',
      'boss-pauldron-l',
      'boss-pauldron-r',
      'boss-shoulder-l',
      'boss-elbow-l',
      'boss-shoulder-r',
      'boss-elbow-r',
      'boss-right-blade',
      'boss-blade-plasma',
      'boss-hips',
      'boss-thigh-l',
      'boss-shin-l',
      'boss-foot-l',
      'boss-thigh-r',
      'boss-shin-r',
      'boss-foot-r',
    ]) {
      const bone = root.getObjectByName(boneName);
      assert.ok(bone, `expected mech skeleton node "${boneName}"`);
      assert.ok(isUnderRoot(root, bone), `node "${boneName}" must be under root`);
    }
  } finally {
    boss.dispose();
  }
});

test('bossModel: update() drives heavy mechanical motion across all 6 anim states', () => {
  const anims: BossAnim[] = ['idle', 'walk', 'windup', 'attack', 'recover', 'charge'];

  for (const anim of anims) {
    const boss = createBossModel();
    try {
      const initialRotX = boss.parts.rightArm.rotation.x;
      const steps = anim === 'attack' ? 10 : 16;
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

      // Root itself is never translated directly (joint-driven animation only)
      assert.equal(boss.parts.root.position.x, 0);
      assert.equal(boss.parts.root.position.y, 0);
      assert.equal(boss.parts.root.position.z, 0);
    } finally {
      boss.dispose();
    }
  }

  // Targeted mechanical kinematics assertions
  const boss = createBossModel();
  try {
    const torso = boss.parts.torso!;
    const body = boss.parts.root.getObjectByName('boss-body')!;
    const thighL = boss.parts.root.getObjectByName('boss-thigh-l')!;
    const thighR = boss.parts.root.getObjectByName('boss-thigh-r')!;
    const coreMat = getMeshMaterial(boss.parts.core);

    // Idle: mono-eye performs mechanical scan sweep
    let minEyeY = Infinity;
    let maxEyeY = -Infinity;
    for (let i = 0; i < 60; i++) {
      boss.update(0.05, { hpPct: 1, phase: 1, anim: 'idle' });
      const ey = boss.parts.monoEye!.rotation.y;
      minEyeY = Math.min(minEyeY, ey);
      maxEyeY = Math.max(maxEyeY, ey);
    }
    const idleCoreEmissive = coreMat.emissiveIntensity;
    assert.ok(
      maxEyeY - minEyeY > 0.30,
      `idle mono-eye should perform mechanical scan sweep (range=${(maxEyeY - minEyeY).toFixed(3)})`,
    );

    // Walk: heavy stomping chassis vertical displacement + stride + counter-swinging shoulders
    let minBodyY = Infinity;
    let maxBodyY = -Infinity;
    let maxStrideDiff = 0;
    let sawCounterShoulders = false;
    for (let i = 0; i < 48; i++) {
      boss.update(0.05, { hpPct: 1, phase: 1, anim: 'walk' });
      minBodyY = Math.min(minBodyY, body.position.y);
      maxBodyY = Math.max(maxBodyY, body.position.y);
      maxStrideDiff = Math.max(maxStrideDiff, Math.abs(thighL.rotation.x - thighR.rotation.x));
      const ls = boss.parts.leftShoulder!.rotation.x;
      const rs = boss.parts.rightShoulder!.rotation.x;
      if (ls * rs < -0.004) sawCounterShoulders = true;
    }
    assert.ok(
      maxBodyY - minBodyY > 0.06,
      `walk should show pronounced heavy mechanical vertical chassis drop (range=${(maxBodyY - minBodyY).toFixed(3)}m)`,
    );
    assert.ok(maxStrideDiff > 0.55, `walk legs should stride distinctly (diff=${maxStrideDiff.toFixed(3)})`);
    assert.ok(sawCounterShoulders, 'walk shoulders should counter-swing opposite each other');

    // Windup: right blade-arm raised high/back, torso leans back, reactor core surges
    for (let i = 0; i < 20; i++) boss.update(0.04, { hpPct: 1, phase: 1, anim: 'windup' });
    assert.ok(
      boss.parts.rightArm.rotation.x < -1.2,
      `windup rightArm should raise backward/high, got ${boss.parts.rightArm.rotation.x.toFixed(3)}`,
    );
    assert.ok(torso.rotation.x > 0.18, `windup torso should lean back, got ${torso.rotation.x.toFixed(3)}`);
    assert.ok(
      coreMat.emissiveIntensity > idleCoreEmissive * 1.25,
      `windup core should surge (idle=${idleCoreEmissive.toFixed(2)}, windup=${coreMat.emissiveIntensity.toFixed(2)})`,
    );

    // Attack: explosive forward lunge & cross-cleave by 0.18s (after 75ms hydraulic lock)
    for (let i = 0; i < 9; i++) boss.update(0.02, { hpPct: 1, phase: 1, anim: 'attack' });
    assert.ok(
      boss.parts.rightArm.rotation.x > 0.90,
      `attack rightArm should cleave forward after lock, got ${boss.parts.rightArm.rotation.x.toFixed(3)}`,
    );
    assert.ok(torso.rotation.x < -0.22, `attack torso should lunge forward, got ${torso.rotation.x.toFixed(3)}`);

    // Charge: steep forward pitch, left buckler shield locked ahead, right blade swept back
    for (let i = 0; i < 25; i++) boss.update(0.04, { hpPct: 1, phase: 1, anim: 'charge' });
    assert.ok(torso.rotation.x < -0.38, `charge torso should pitch forward steeply, got ${torso.rotation.x.toFixed(3)}`);
    assert.ok(boss.parts.head.rotation.x < -0.25, `charge head should hunker down, got ${boss.parts.head.rotation.x.toFixed(3)}`);
    assert.ok(boss.parts.leftArm.rotation.x > 0.40, `charge left buckler arm should brace ahead, got ${boss.parts.leftArm.rotation.x.toFixed(3)}`);
    assert.ok(boss.parts.rightArm.rotation.x < -0.60, `charge right blade arm should sweep back, got ${boss.parts.rightArm.rotation.x.toFixed(3)}`);
  } finally {
    boss.dispose();
  }
});

test('bossModel: phase 2 (hpPct <= 0.35) overloads blade, mono-eye, core, and armor seams without whole-body red flash', () => {
  const boss = createBossModel();
  try {
    const torsoArmor = boss.parts.root.getObjectByName('boss-torso-armor') as THREE.Mesh;
    const bladePlasma = boss.parts.root.getObjectByName('boss-blade-plasma') as THREE.Mesh;
    const monoEyeLens = boss.parts.root.getObjectByName('boss-mono-eye-lens') as THREE.Mesh;

    const armorMat = torsoArmor.material as THREE.MeshStandardMaterial;
    const coreMat = getMeshMaterial(boss.parts.core);
    const bladeMat = bladePlasma.material as THREE.MeshStandardMaterial;
    const eyeMat = monoEyeLens.material as THREE.MeshStandardMaterial;

    for (let i = 0; i < 16; i++) boss.update(0.05, { hpPct: 0.85, phase: 1, anim: 'idle' });
    const p1ArmorHex = armorMat.color.getHex();
    const p1SeamEm = armorMat.emissiveIntensity;
    const p1CoreEm = coreMat.emissiveIntensity;
    const p1BladeEm = bladeMat.emissiveIntensity;
    const p1EyeEm = eyeMat.emissiveIntensity;

    for (let i = 0; i < 22; i++) boss.update(0.05, { hpPct: 0.35, phase: 2, anim: 'idle' });
    const p2ArmorHex = armorMat.color.getHex();
    const p2SeamEm = armorMat.emissiveIntensity;
    const p2CoreEm = coreMat.emissiveIntensity;
    const p2BladeEm = bladeMat.emissiveIntensity;
    const p2EyeEm = eyeMat.emissiveIntensity;

    assert.ok(
      p2BladeEm > p1BladeEm * 1.6,
      `expected phase 2 thermal blade emissive (${p2BladeEm.toFixed(2)}) >> phase 1 (${p1BladeEm.toFixed(2)})`,
    );
    assert.ok(
      p2EyeEm > p1EyeEm * 1.5,
      `expected phase 2 mono-eye emissive (${p2EyeEm.toFixed(2)}) >> phase 1 (${p1EyeEm.toFixed(2)})`,
    );
    assert.ok(
      p2CoreEm > p1CoreEm * 1.6,
      `expected phase 2 reactor core emissive (${p2CoreEm.toFixed(2)}) >> phase 1 (${p1CoreEm.toFixed(2)})`,
    );
    assert.ok(
      p2SeamEm > p1SeamEm * 8,
      `expected phase 2 armor seam bleed (${p2SeamEm.toFixed(2)}) >> phase 1 (${p1SeamEm.toFixed(2)})`,
    );
    // Reactor overload ONLY — armor steel base albedo NEVER flashes red!
    assert.equal(p2ArmorHex, p1ArmorHex, 'armor base albedo must stay steady (no whole-body red alarm flash)');
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
