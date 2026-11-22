import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createRobot, disposeRobotCache, getRobotTriangleCount } from '../render/robotModel.ts';
import { EnemyRig } from '../render/enemies.ts';
import { PALETTE } from '../render/palette.ts';
import { createEntity } from './entities.ts';
import type { EnemyBot, EnemyClip } from './ai.ts';

function makeMockBot(overrides: Partial<EnemyBot> = {}): EnemyBot {
  const entity = createEntity('bot-test', { x: 0, y: 0, z: 0 }, 100, 0.35, 1.62);
  return {
    id: 'bot-test',
    slotIndex: 0,
    faction: 'enemy',
    entity,
    state: 'IDLE',
    yaw: 0,
    speed: 0,
    ammo: 30,
    mag: 30,
    shotsFired: 0,
    reloadingUntil: 0,
    waypointIdx: 0,
    stateUntil: 0,
    sightAcquiredAt: -1,
    firstShotAt: -1,
    firstSightAt: -1,
    hasLos: false,
    lastSeenPos: null,
    lastSeenAt: -10000,
    lastContactAt: -10000,
    advancing: false,
    fireAnimStartAt: -10000,
    fireAnimEndAt: 0,
    fireHitAt: 0,
    fireHitPending: false,
    nextFireCycleAt: 0,
    flankSign: 1,
    strafeSwitchAt: 0,
    coverTarget: null,
    lastFireAt: -10000,
    lastHitAt: -10000,
    diedAt: -1,
    replaceAt: -1,
    anim: 'idle_rifle',
    walkPhase: 0,
    ...overrides,
  };
}

test('robotModel: single robot <= 2500 tris, metallic PBR bounds, shared cache, emissive-only faction distinction', () => {
  disposeRobotCache();
  const enemy1 = createRobot('enemy');
  const enemy2 = createRobot('enemy');
  const ally = createRobot('ally');

  try {
    const tris = getRobotTriangleCount();
    assert.ok(tris > 400 && tris <= 2500, `expected single robot tris in (400, 2500], got ${tris}`);
    assert.equal(enemy1.triangleCount, tris);
    assert.equal(ally.triangleCount, tris, 'enemy and ally must share identical geometry');

    // Shared material & geometry cache across instances
    assert.equal(enemy1.bodyMeshes[0].material, enemy2.bodyMeshes[0].material, 'armor material must be cached');
    assert.equal(enemy1.bodyMeshes[0].geometry, ally.bodyMeshes[0].geometry, 'chassis geometry must be shared');
    assert.equal(enemy1.visorMesh.geometry, ally.visorMesh.geometry, 'visor geometry must be identical');
    assert.notEqual(enemy1.visorMesh.material, ally.visorMesh.material, 'faction glow material must differ');

    // Metallic PBR checks: metalness 0.85-0.95 / roughness 0.20-0.35
    const armorMat = enemy1.bodyMeshes[0].material as THREE.MeshStandardMaterial;
    const enemyGlow = enemy1.visorMesh.material as THREE.MeshStandardMaterial;
    const allyGlow = ally.visorMesh.material as THREE.MeshStandardMaterial;

    assert.ok(armorMat.metalness >= 0.85 && armorMat.metalness <= 0.95, `armor metalness=${armorMat.metalness}`);
    assert.ok(armorMat.roughness >= 0.2 && armorMat.roughness <= 0.35, `armor roughness=${armorMat.roughness}`);
    assert.equal(armorMat.color.getHex(), new THREE.Color(PALETTE.robotArmor).getHex());

    assert.ok(enemyGlow.metalness >= 0.85 && enemyGlow.metalness <= 0.95, `glow metalness=${enemyGlow.metalness}`);
    assert.ok(enemyGlow.roughness >= 0.2 && enemyGlow.roughness <= 0.35, `glow roughness=${enemyGlow.roughness}`);
    assert.equal(enemyGlow.emissive.getHex(), new THREE.Color(PALETTE.robotGlowEnemy).getHex());
    assert.equal(allyGlow.emissive.getHex(), new THREE.Color(PALETTE.robotGlowAlly).getHex());
    assert.ok(enemyGlow.emissiveIntensity >= 3, `strong emissive expected, got ${enemyGlow.emissiveIntensity}`);

    // Floating head sits cleanly above torso collar (y=0.56 with bottom at 0.455 > collar 0.405)
    assert.ok(enemy1.joints.headPivot.position.y >= 0.54, 'head must float above torso collar');

    // Hit flash toggles visor to white (#ffffff) and restores faction emissive cleanly
    enemy1.setHitFlash(true);
    const flashMat = enemy1.visorMesh.material as THREE.MeshStandardMaterial;
    assert.equal(flashMat.emissive.getHex(), new THREE.Color(PALETTE.robotHitFlash).getHex());
    enemy1.setHitFlash(false);
    assert.equal(enemy1.visorMesh.material, enemyGlow);
  } finally {
    enemy1.dispose();
    enemy2.dispose();
    ally.dispose();
    disposeRobotCache();
  }
});

test('EnemyRig: all 6 animation states (idle/walk/aim/fire/hit/death) articulate joints distinctly', () => {
  disposeRobotCache();
  const rig = new EnemyRig('enemy');
  const getJointSnap = () => {
    const r = rig.root.children[0];
    const body = r.getObjectByName('robot-body')!;
    const torso = r.getObjectByName('robot-torso')!;
    const head = r.getObjectByName('robot-head')!;
    const shR = r.getObjectByName('robot-shoulder-r')!;
    const hipL = r.getObjectByName('robot-hip-l')!;
    const kneeL = r.getObjectByName('robot-knee-l')!;
    const weapon = r.getObjectByName('robot-weapon')!;
    const visor = r.getObjectByName('robot-visor') as THREE.Mesh;
    return {
      bodyY: body.position.y,
      bodyPitch: body.rotation.x,
      torsoPitch: torso.rotation.x,
      torsoYaw: torso.rotation.y,
      headY: head.position.y,
      headYaw: head.rotation.y,
      shRX: shR.rotation.x,
      hipLX: hipL.rotation.x,
      kneeLX: kneeL.rotation.x,
      wpnPosZ: weapon.position.z,
      visorHex: (visor.material as THREE.MeshStandardMaterial).emissive.getHex(),
    };
  };

  try {
    const stepState = (anim: EnemyClip, patch: Partial<EnemyBot>, steps = 15, dt = 0.05, nowMs = 1000) => {
      const bot = makeMockBot({ anim, ...patch });
      for (let i = 0; i < steps; i++) {
        rig.sync(bot, dt, nowMs + i * dt * 1000);
      }
      return getJointSnap();
    };

    // 1. idle
    const idleA = stepState('idle_rifle', { state: 'IDLE' }, 5, 0.05, 1000);
    const idleB = stepState('idle_rifle', { state: 'IDLE' }, 20, 0.05, 1500);
    assert.ok(Math.abs(idleB.headYaw - idleA.headYaw) > 0.02, 'idle head should scan, not stay frozen');

    // 2. walk (alternating phase drives hip & knee articulation)
    const walkA = stepState('walk_rifle', { state: 'PATROL', walkPhase: Math.PI / 2, speed: 1.4 }, 18, 0.05, 3000);
    const walkB = stepState('walk_rifle', { state: 'PATROL', walkPhase: -Math.PI / 2, speed: 1.4 }, 18, 0.05, 4000);
    assert.ok(Math.abs(walkA.hipLX - walkB.hipLX) > 0.5, 'walk must articulate hip stride');

    // 3. aim (torso angles + head counter-turns + shoulder raises carbine)
    const aim = stepState('aim_rifle', { state: 'ENGAGE' }, 20, 0.05, 5000);
    assert.ok(Math.abs(aim.torsoYaw) > 0.15 && aim.shRX > 0.4, 'aim must articulate torso & weapon arms');

    // 4. fire (recoil kicks weapon +Z and raises shoulder/torso pitch)
    const fire = stepState(
      'fire_rifle',
      { state: 'ENGAGE', fireAnimStartAt: 6000, lastFireAt: 6000 },
      4,
      0.02,
      6040,
    );
    assert.ok(fire.wpnPosZ > aim.wpnPosZ + 0.015, 'fire must produce weapon recoil displacement');
    assert.ok(fire.shRX > aim.shRX + 0.05, 'fire must kick right shoulder');

    // 5. hit (0.12s armor compression + white visor flash)
    const hit = stepState('hit', { state: 'ENGAGE', lastHitAt: 7000 }, 3, 0.015, 7035);
    assert.ok(hit.bodyY < aim.bodyY - 0.04, 'hit must compress armor downward');
    assert.equal(hit.visorHex, new THREE.Color(PALETTE.robotHitFlash).getHex(), 'hit must flash visor white');

    // After 0.12s hit flash expires and visor restores to enemy magenta
    const postHit = stepState('aim_rifle', { state: 'ENGAGE', lastHitAt: 7000 }, 2, 0.016, 7200);
    assert.equal(postHit.visorHex, new THREE.Color(PALETTE.robotGlowEnemy).getHex(), 'visor must restore after 0.12s');

    // 6. death (articulated collapse: knees buckle, pelvis drops, body pitches onto deck, head drops)
    const deadBot = makeMockBot({ state: 'DEAD', anim: 'die' });
    deadBot.entity.alive = false;
    for (let i = 0; i < 30; i++) {
      rig.sync(deadBot, 0.03, 8000 + i * 30);
    }
    const dead = getJointSnap();
    assert.ok(dead.bodyPitch > 1.0, `death must topple chassis (bodyPitch=${dead.bodyPitch})`);
    assert.ok(dead.bodyY < 0.45, `death must drop pelvis onto deck (bodyY=${dead.bodyY})`);
    assert.ok(dead.headY < aim.headY - 0.06, 'death must drop floating head as magnetic power cuts');
  } finally {
    rig.dispose();
    disposeRobotCache();
  }
});
