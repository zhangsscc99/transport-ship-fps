// Entry point: engine + lighting + ship + collision-driven FPS controller +
// weapons (fire/reload/swap) + HUD + touch controls. Pure game state lives in
// src/game/**; this file only wires it into the renderer.

import * as THREE from 'three';
import { Engine } from './render/engine';
import { addLights, configureRenderer } from './render/lighting';
import { applyAtmosphere } from './render/atmosphere';
import { setAnisotropyCap } from './render/textures';
import { buildMap } from './render/map';
import { updateWater } from './render/materials';
import { PlayerCamera } from './render/camera';
import { WeaponView, type HandsTelemetry } from './render/weapon';
import { WorldVfx, type VfxTelemetry } from './render/vfx';
import { easeInOutCubic } from './render/tween';
import { Hud } from './render/hud';
import { Player, MOVE, type Vec3 } from './game/player';
import { MAP, spawnPoint } from './game/map';
import { CollisionWorld, PLAYER_RADIUS } from './game/collision';
import { KeyboardMouseInput, mergeInputs } from './game/input';
import { TouchControls } from './input/touch';
import { WeaponRack } from './game/weapons';
import { createEntity } from './game/entities';
import {
  traceHit,
  falloffFactor,
  applyDamage,
  updatePlayerRegen,
  PLAYER_MAX_HP,
  LOW_HP_THRESHOLD,
  CRITICAL_HP_THRESHOLD,
  HEADSHOT_MULT,
  type Ray,
} from './game/damage';
import { createMatch } from './game/match';
import { EnemyManager, type Faction } from './game/ai';
import { parseDifficulty, type DifficultyId } from './game/difficulty';
import { EnemyRenderer } from './render/enemies';
import { EnemyTagOverlay, type EnemyTagTelemetry } from './render/enemyTags';
import { Menu } from './render/menu';
import { PALETTE } from './render/palette';
import { createSfx } from './audio/sfx';
import { BgmController, type BgmTelemetry } from './audio/bgm';

declare global {
  interface Window {
    __state: {
      x: number;
      y: number;
      z: number;
      hp: number;
      maxHp: number;
      ammo: number;
      mag: number;
      weapon: string;
      weapons: string[];
      spinLevel: number;
      reloading: boolean;
      dead: boolean;
      difficulty: DifficultyId;
      kills: number;
      survivalMs: number;
      deathPanelVisible: boolean;
      yaw: number;
      pitch: number;
      firing: boolean;
    };
    __sfx: { counts: Record<string, number>; muted: boolean; unlocked: boolean };
    __bgm: BgmTelemetry;
    __fx: { hits: number; kills: number; flashOpacity: number; lowHpPulse: number; desat: number };
    __anim: {
      reloadActive: boolean;
      reloadElapsedMs: number;
      reloadDurationMs: number;
      magDetached: boolean;
      newMagInHand: boolean;
      swapActive: boolean;
      simTimeMs: number;
    };
    __vfx: VfxTelemetry;
    __hands: HandsTelemetry;
    __enemies: {
      id: string;
      faction: Faction;
      state: string;
      anim: string;
      clip: string;
      clipsPlayed: string[];
      modelSource: string;
      modelLoaded: boolean;
      hp: number;
      maxHp: number;
      ammo: number;
      shotsFired: number;
      hasLos: boolean;
      firstSightAt: number;
      firstShotAt: number;
      x: number;
      y: number;
      z: number;
      tris: number;
    }[];
    __enemyTags: EnemyTagTelemetry[];
    __test: {
      hurt(dmg: number): void;
      teleport(x: number, z: number, yawDeg: number, pitchDeg: number, y?: number): void;
      isInsideWalkable(x: number, z: number): boolean;
      setPaused(paused: boolean): void;
      spawnEnemyAt(x: number, z: number, yawDeg: number, faction?: Faction): string;
      clearEnemies(): void;
      setDifficulty(diff: DifficultyId): void;
      damageEnemy(id: string, dmg: number): void;
    };
    __match: {
      phase: string;
      killsA: number;
      killsB: number;
      timeLeftMs: number;
      winner: string | null;
    };
    __renderInfo: {
      calls: number;
      triangles: number;
      points: number;
      lines: number;
      geometries: number;
      textures: number;
    };
  }
}

const canvas = document.getElementById('game') as HTMLCanvasElement;

const engine = new Engine(canvas);
configureRenderer(engine.renderer);
const atmo = applyAtmosphere(engine.scene, engine.renderer);
const lights = addLights(engine.scene);
buildMap(engine.scene);
setAnisotropyCap(engine.renderer.capabilities.getMaxAnisotropy());

const world = new CollisionWorld(MAP.boxes, MAP.bounds, MAP.waterY, MAP.walkablePolygon);
const [sx, sy, sz] = spawnPoint('A', 0);
const player = new Player({ x: sx, y: sy, z: sz });
const lastSafePos: Vec3 = { x: sx, y: sy, z: sz };
let fallRespawnPhase: 'none' | 'fadeIn' | 'fadeOut' = 'none';
let fallRespawnStartAt = 0;
const FALL_FADE_IN_MS = 400;
const FALL_FADE_OUT_MS = 300;
const FALL_INVINCIBLE_MS = 1000;
const kb = new KeyboardMouseInput(canvas);
const touch = new TouchControls(document.body);
const view = new PlayerCamera(window.innerWidth / window.innerHeight);

const rack = new WeaponRack();
const weaponView = new WeaponView();
view.camera.add(weaponView.group);
engine.scene.add(view.camera);
const worldVfx = new WorldVfx(engine.scene, MAP.boxes);
const hud = new Hud(document.body, touch.enabled);

const RECOIL_SPEC = {
  rifle: { deg: 2.5, sec: 0.11 },
  gatling: { deg: 0.28, sec: 0.06 },
} as const;

const sfx = createSfx();
const bgm = new BgmController(document.body);
worldVfx.onShellBounce = (spd) => {
  if (spd > 0.6) sfx.play('shellClink', { volume: Math.min(1, spd * 0.25) });
};
hud.setMuted(sfx.muted);
bgm.setMuted(sfx.muted);
// AudioContext + BGM unlock must happen inside a real user gesture (autoplay policy)
const onFirstGesture = () => {
  void sfx.unlock();
  bgm.unlock();
};
window.addEventListener('pointerdown', onFirstGesture, { once: true });
window.addEventListener('keydown', onFirstGesture, { once: true });

const SHOT_SFX = { rifle: 'shotRifle', gatling: 'shotGatling' } as const;
/** stride length per footstep — interval scales with move speed via distance */
const STEP_STRIDE = 2.1;
let stepAcc = 0;
let lastHeartbeatMs = 0;
let lastReloadStageSfx = 0;
/** Accumulated delta-time simulation clock (ms) for frame-rate-independent weapon/reload timers. */
let simNowMs = 0;

const playerEnt = createEntity('player', player.position, PLAYER_MAX_HP, PLAYER_RADIUS, MOVE.eyeHeight);
let lastHurtSimMs = -1e9;
let desatActive = false;
const enemyMgr = new EnemyManager('normal');
const enemyRenderer = new EnemyRenderer(engine.scene);
const enemyTags = new EnemyTagOverlay(document.body);

const DEATH_FALL_MS = 600;
let playerDeathSimAt = -1;
let deathPanelShown = false;
let roundStartSimAt = 0;
let roundKills = 0;
let currentDifficulty: DifficultyId = 'normal';

const match = createMatch();
const startRound = (settings: { difficulty: DifficultyId; muted: boolean; musicEnabled: boolean }) => {
  currentDifficulty = parseDifficulty(settings.difficulty);
  enemyMgr.setDifficulty(currentDifficulty);
  sfx.setMuted(settings.muted);
  bgm.setMuted(settings.muted);
  bgm.setEnabled(settings.musicEnabled);
  bgm.unlock();
  bgm.setTrack('battle');
  hud.setMuted(settings.muted);
  match.resetToMenu();
  match.start(simNowMs);
  menu.hide();
  menu.hideDeath();
  // fresh round: revive and re-arm the player at spawn
  const [rx, ry, rz] = spawnPoint('A', 0);
  playerEnt.alive = true;
  playerEnt.hp = playerEnt.maxHp;
  playerEnt.deadUntil = 0;
  playerEnt.invincibleUntil = 0;
  lastHurtSimMs = -1e9;
  if (desatActive) {
    desatActive = false;
    canvas.style.filter = '';
  }
  playerDeathSimAt = -1;
  deathPanelShown = false;
  roundStartSimAt = simNowMs;
  roundKills = 0;
  player.position.x = rx;
  player.position.y = ry;
  player.position.z = rz;
  player.velocity.x = 0;
  player.velocity.y = 0;
  player.velocity.z = 0;
  player.drowned = false;
  player.hitAirWall = false;
  player.yaw = 0;
  player.pitch = 0;
  lastSafePos.x = rx;
  lastSafePos.y = ry;
  lastSafePos.z = rz;
  fallRespawnPhase = 'none';
  fallRespawnStartAt = 0;
  hud.setFallFade(0);
  hud.setDeathVeil(0);
  view.snap(player);
  rack.index = 0;
  rack.resetSwap();
  weaponView.setWeapon(rack.current.spec.id);
  for (const w of rack.list) {
    w.ammo = w.spec.mag;
    w.cancelReload();
    w.resetSpin();
  }
  enemyRenderer.clearAll();
  enemyTags.clearAll();
  enemyMgr.reset(simNowMs, player.position);
};

const menu = new Menu(document.body, {
  onStart: startRound,
  onRetry: startRound,
  onReturnMenu: () => {
    match.resetToMenu();
    bgm.setTrack('menu');
    sfx.setGatlingMotor(0, false);
    playerEnt.alive = true;
    playerEnt.hp = playerEnt.maxHp;
    lastHurtSimMs = -1e9;
    if (desatActive) {
      desatActive = false;
      canvas.style.filter = '';
    }
    playerDeathSimAt = -1;
    deathPanelShown = false;
    hud.setDeathVeil(0);
    enemyMgr.clear();
    enemyRenderer.clearAll();
    enemyTags.clearAll();
    const [rx, ry, rz] = spawnPoint('A', 0);
    player.position.x = rx;
    player.position.y = ry;
    player.position.z = rz;
    player.yaw = 0;
    player.pitch = 0;
    view.snap(player);
  },
  onSettingsChange: (s) => {
    currentDifficulty = parseDifficulty(s.difficulty);
    enemyMgr.setDifficulty(currentDifficulty);
    sfx.setMuted(s.muted);
    bgm.setMuted(s.muted);
    bgm.setEnabled(s.musicEnabled);
    hud.setMuted(s.muted);
  },
});
currentDifficulty = menu.settings.difficulty;
enemyMgr.setDifficulty(currentDifficulty);
bgm.setEnabled(menu.settings.musicEnabled);
bgm.setMuted(menu.settings.muted);
hud.onMuteToggle = (m) => {
  sfx.setMuted(m);
  bgm.setMuted(m);
  menu.syncMuted(m);
};
menu.show();

const scratchMuzzle = new THREE.Vector3();
const scratchEject = new THREE.Vector3();
const scratchRight = new THREE.Vector3();
const scratchFwd = new THREE.Vector3();
const rayEnd = (ray: Ray, dist: number): Vec3 => ({
  x: ray.origin.x + ray.dir.x * dist,
  y: ray.origin.y + ray.dir.y * dist,
  z: ray.origin.z + ray.dir.z * dist,
});

/** camera-space aim direction derived from yaw/pitch (matches Player.forward) */
function aimDir(): Vec3 {
  const cp = Math.cos(player.pitch);
  return {
    x: -Math.sin(player.yaw) * cp,
    y: Math.sin(player.pitch),
    z: -Math.cos(player.yaw) * cp,
  };
}

/**
 * Shared hurt path — real damage events and window.__test.hurt() both go
 * through here: damage → edge flash + direction arc + hurt sfx.
 * `angleRad` is the attacker's screen-relative bearing (0 = ahead).
 */
function hurtPlayer(dmg: number, angleRad?: number): void {
  const now = performance.now();
  if (!playerEnt.alive || now < playerEnt.invincibleUntil) return;
  if (dmg > 0) lastHurtSimMs = simNowMs;
  const killed = applyDamage(playerEnt, dmg, now);
  hud.hitFrom(angleRad ?? Math.random() * Math.PI * 2, now);
  sfx.play('hurt');
  if (killed) {
    playerDeathSimAt = simNowMs;
    deathPanelShown = false;
    sfx.play('death');
    sfx.setGatlingMotor(0, false);
    document.exitPointerLock?.();
  }
}

engine.camera = view.camera;
engine.onResize = (w, h) => view.setAspect(w / h);
engine.onFrame = (dt) => {
  const now = performance.now();
  simNowMs += dt * 1000;
  const prevPhase = match.phase;
  match.tick(simNowMs);
  const acting = match.canAct(simNowMs);
  const inp = mergeInputs(kb.snapshot(), touch.snapshot());

  menu.setCountdown(match.phase === 'countdown' ? match.countdownLeftMs : null);
  if (match.phase === 'over' && prevPhase !== 'over') {
    bgm.setTrack('menu');
    sfx.setGatlingMotor(0, false);
    menu.showResult({ winner: match.winner, killsA: match.killsA, killsB: match.killsB });
  }
  bgm.update(dt);

  if (acting && playerEnt.alive) {
    // Fallback safety recovery if player ever drops below y < -2:
    // 0.4s black vignette fade-in → teleport to last safe grounded point
    // (or spawn), reset velocity, interrupt reload ONLY, 1s invincibility → 0.3s fade-out.
    if (fallRespawnPhase === 'none' && player.position.y < MAP.waterY) {
      fallRespawnPhase = 'fadeIn';
      fallRespawnStartAt = now;
      player.velocity.x = 0;
      player.velocity.y = 0;
      player.velocity.z = 0;
      player.drowned = false;
      rack.current.cancelReload();
      playerEnt.invincibleUntil = Math.max(playerEnt.invincibleUntil, now + FALL_INVINCIBLE_MS);
    }

    if (fallRespawnPhase === 'fadeIn') {
      const fadeInMs = now - fallRespawnStartAt;
      hud.setFallFade(easeInOutCubic(Math.min(1, fadeInMs / FALL_FADE_IN_MS)));
      if (fadeInMs >= FALL_FADE_IN_MS) {
        const safeOk =
          lastSafePos.y >= -0.05 &&
          world.isInsideWalkable(lastSafePos.x, lastSafePos.z, PLAYER_RADIUS) &&
          !world.hits(lastSafePos.x, lastSafePos.y, lastSafePos.z, PLAYER_RADIUS, MOVE.eyeHeight);
        const [fx, fy, fz] = safeOk
          ? [lastSafePos.x, lastSafePos.y, lastSafePos.z]
          : spawnPoint('A', 0);
        player.position.x = fx;
        player.position.y = fy;
        player.position.z = fz;
        player.velocity.x = 0;
        player.velocity.y = 0;
        player.velocity.z = 0;
        player.onGround = true;
        player.drowned = false;
        player.hitAirWall = false;
        rack.current.cancelReload();
        playerEnt.invincibleUntil = Math.max(playerEnt.invincibleUntil, now + FALL_INVINCIBLE_MS);
        view.snap(player);
        fallRespawnPhase = 'fadeOut';
        fallRespawnStartAt = now;
      }
    } else {
      if (fallRespawnPhase === 'fadeOut') {
        const fadeOutMs = now - fallRespawnStartAt;
        const remain = 1 - easeInOutCubic(Math.min(1, fadeOutMs / FALL_FADE_OUT_MS));
        hud.setFallFade(remain);
        if (fadeOutMs >= FALL_FADE_OUT_MS) {
          fallRespawnPhase = 'none';
          hud.setFallFade(0);
        }
      }

      player.update(dt, inp, {
        collider: world,
        speedMult: rack.current.spec.moveSpeedMult,
      });
      if (player.hitAirWall) view.triggerWallBump();

      // Record latest valid grounded position for fall-respawn fallback
      if (
        player.onGround &&
        player.position.y >= -0.05 &&
        world.isInsideWalkable(player.position.x, player.position.z, PLAYER_RADIUS) &&
        !world.hits(
          player.position.x,
          player.position.y,
          player.position.z,
          PLAYER_RADIUS,
          MOVE.eyeHeight,
        )
      ) {
        lastSafePos.x = player.position.x;
        lastSafePos.y = player.position.y;
        lastSafePos.z = player.position.z;
      }

      // footsteps — throttled by distance travelled; differentiate metal deck vs wooden crates
      const hSpeed = Math.hypot(player.velocity.x, player.velocity.z);
      if (player.onGround && hSpeed > 0.5) {
        stepAcc += hSpeed * dt;
        if (stepAcc >= STEP_STRIDE) {
          stepAcc = 0;
          const onWoodCrate = player.position.y > 0.15 && player.position.y < 2.25;
          sfx.play(onWoodCrate ? 'footstepWood' : 'footstepMetal');
        }
      } else {
        stepAcc = 0;
      }

      // Low-HP heartbeat pulse when 0 < hp < 40
      if (playerEnt.hp > 0 && playerEnt.hp < LOW_HP_THRESHOLD && simNowMs - lastHeartbeatMs > 950) {
        lastHeartbeatMs = simNowMs;
        sfx.play('heartbeat', { volume: 0.75 });
      }
    }
  }

  // Out-of-combat player HP regen: starts 6s after last hit, 12 HP/s back to 200
  const isRegenerating =
    acting && playerEnt.alive
      ? updatePlayerRegen(playerEnt, lastHurtSimMs, simNowMs, dt)
      : false;

  // Subtle screen desaturation when critical HP (< 20)
  const wantsDesat = playerEnt.alive && playerEnt.hp > 0 && playerEnt.hp < CRITICAL_HP_THRESHOLD;
  if (wantsDesat !== desatActive) {
    desatActive = wantsDesat;
    canvas.style.filter = wantsDesat ? 'saturate(0.48) contrast(1.04)' : '';
  }
  // Player death sequence: 0.6s fall-down camera → settlement panel (kills / survival / difficulty)
  let deathFallProgress = 0;
  if (!playerEnt.alive && playerDeathSimAt >= 0) {
    deathFallProgress = Math.min(1, Math.max(0, (simNowMs - playerDeathSimAt) / DEATH_FALL_MS));
    hud.setDeathVeil(deathFallProgress * 0.78);
    if (deathFallProgress >= 1 && !deathPanelShown) {
      deathPanelShown = true;
      menu.showDeath({
        kills: roundKills,
        survivalMs: Math.max(0, playerDeathSimAt - roundStartSimAt),
        difficulty: currentDifficulty,
      });
    }
  }

  const activeTriggerHeld = acting && playerEnt.alive && inp.fire && player.onGround;
  const bufferedSwapped = rack.tick(simNowMs, activeTriggerHeld);
  if (bufferedSwapped) {
    weaponView.startSwap(bufferedSwapped.spec.id, bufferedSwapped.spec.swapMs / 1000);
  }
  if (acting && playerEnt.alive && inp.swap) {
    const nextW = rack.requestSwap(simNowMs);
    if (nextW) weaponView.startSwap(nextW.spec.id, nextW.spec.swapMs / 1000);
  }
  const w = rack.current;

  const gatlingActivelyFiring =
    acting &&
    playerEnt.alive &&
    w.spec.id === 'gatling' &&
    !rack.swapping(simNowMs) &&
    !w.reloading &&
    w.ammo > 0 &&
    inp.fire &&
    player.onGround &&
    w.spinLevel >= 0.99;

  view.update(player, dt, {
    reloading: w.reloading,
    reloadPitchDip: weaponView.reloadPitchDip,
    gatlingFireShake: gatlingActivelyFiring ? 1 : 0,
    deathFallProgress,
  });
  lights.update(now * 0.001, view.camera.position);
  updateWater(now * 0.001);
  atmo.update(view.camera.position, view.camera.fov);

  sfx.setGatlingMotor(
    acting && playerEnt.alive && w.spec.id === 'gatling' && !rack.swapping(simNowMs) ? w.spinLevel : 0,
    gatlingActivelyFiring,
  );

  // Trigger reload mechanical audio cues cleanly on stage transitions
  const curStage = weaponView.handsTelemetry.reloadStage;
  if (curStage !== lastReloadStageSfx) {
    if (curStage === 2) sfx.play('reloadMagOut');
    else if (curStage === 4) sfx.play('reloadMagIn');
    else if (curStage === 5) sfx.play('reloadBolt');
    lastReloadStageSfx = curStage;
  }

  let playerFiredThisFrame = false;
  if (acting && playerEnt.alive) {
    if (inp.reload && !rack.swapping(simNowMs) && w.reload(simNowMs)) sfx.play('reload');
    if (inp.fire) rack.noteFireIntent(simNowMs);
    const wantsFire = inp.fire || rack.hasBufferedFire(simNowMs);
    if (wantsFire && player.onGround && !rack.swapping(simNowMs)) {
      const eye: Vec3 = {
        x: player.position.x,
        y: player.position.y + player.eyeHeight,
        z: player.position.z,
      };
      // Frame-rate-independent micro-stepping so 900 RPM Gatling sustains true cadence even at low FPS
      const prevSimMs = Math.max(0, simNowMs - dt * 1000);
      const dtMs = dt * 1000;
      const maxSubShots = w.spec.id === 'gatling' ? Math.min(10, Math.max(1, Math.ceil(dtMs / 10))) : 1;
      let firedInFrame = false;
      for (let sub = 0; sub < maxSubShots; sub++) {
        const subT = maxSubShots === 1 ? simNowMs : prevSimMs + ((sub + 1) / maxSubShots) * dtMs;
        const shots = w.tryFire(subT, eye, aimDir());
        if (!shots) continue;
        playerFiredThisFrame = true;
        rack.clearBufferedFire();
        if (!firedInFrame) {
          firedInFrame = true;
          weaponView.onFire(w.spec.id);
          touch.pulseFire();
          sfx.play(SHOT_SFX[w.spec.id]);
          bgm.notifyFire();
        }
        // Camera recoil separated from visual gun kick (20% kept, 80% easeOutQuad recovery)
        const rc = RECOIL_SPEC[w.spec.id];
        const pitchRad = (rc.deg * Math.PI) / 180;
        const yawJitter = (Math.random() - 0.5) * pitchRad * 0.24;
        view.addRecoil(player, pitchRad, rc.sec, yawJitter);

        const dir = aimDir();
        weaponView.muzzleWorld(scratchMuzzle);
        weaponView.ejectWorld(scratchEject);
        scratchRight.set(1, 0, 0).applyQuaternion(view.camera.quaternion).normalize();
        scratchFwd.set(0, 0, -1).applyQuaternion(view.camera.quaternion).normalize();
        if (sub === 0) {
          worldVfx.spawnMuzzleSmoke(scratchMuzzle, dir);
          worldVfx.spawnShell(scratchEject, scratchRight, scratchFwd, player.velocity, w.spec.id);
        }

        for (const ray of shots) {
          const hit = traceHit(ray, MAP.boxes, enemyMgr.entities);
          worldVfx.spawnTracer(scratchMuzzle, hit ? hit.point : rayEnd(ray, 80));
          if (hit) hud.notifyHit(now);
          if (hit?.kind === 'box') {
            worldVfx.spawnImpact(hit.point, hit.normal);
          } else if (hit?.kind === 'entity') {
            const dmg =
              w.spec.dmg *
              falloffFactor(w.spec, hit.dist) *
              (hit.headshot ? HEADSHOT_MULT : 1);
            sfx.play(hit.headshot ? 'headshot' : 'hit');
            const killed = applyDamage(hit.entity, dmg, simNowMs);
            enemyMgr.onBotDamaged(hit.entity, player.position, simNowMs);
            if (killed) {
              roundKills++;
              match.registerKill('A', simNowMs);
              sfx.play('kill');
              hud.notifyKill(now);
            }
          }
        }
      }
    }
  }

  // --- CF-style AI Enemies update & combat ---
  if (match.phase === 'playing') {
    const pEye: Vec3 = {
      x: player.position.x,
      y: player.position.y + player.eyeHeight,
      z: player.position.z,
    };
    const pSpeed = Math.hypot(player.velocity.x, player.velocity.z);
    const enemyShots = enemyMgr.update({
      dt,
      nowMs: simNowMs,
      playerPos: player.position,
      playerEye: pEye,
      playerAlive: playerEnt.alive,
      playerFired: playerFiredThisFrame,
      playerSpeed: pSpeed,
      playerOnGround: player.onGround,
      boxes: MAP.boxes,
      collider: world,
    });
    const fwd = player.forward();
    const rightX = -fwd.z;
    const rightZ = fwd.x;
    for (const es of enemyShots) {
      const origin = enemyRenderer.getMuzzleWorld(es.botId, scratchMuzzle)
        ? { x: scratchMuzzle.x, y: scratchMuzzle.y, z: scratchMuzzle.z }
        : es.origin;
      worldVfx.spawnTracer(origin, es.target);
      const dx = origin.x - player.position.x;
      const dz = origin.z - player.position.z;
      const dLen = Math.hypot(dx, dz) || 1;
      const stereoPan = Math.max(-1, Math.min(1, (dx * rightX + dz * rightZ) / dLen));
      sfx.play('shotEnemy', { distance: es.dist, maxRange: 60, pan: stereoPan, volume: 0.78 });
      if (es.hit && playerEnt.alive) {
        const localF = dx * fwd.x + dz * fwd.z;
        const localR = dx * rightX + dz * rightZ;
        const angleRad = Math.atan2(localR, localF);
        hurtPlayer(es.damage, angleRad);
      }
    }
  }
  enemyRenderer.sync(enemyMgr.bots, dt, simNowMs, view.camera.position);
  enemyTags.update(
    enemyMgr.bots,
    enemyRenderer,
    view.camera,
    MAP.boxes,
    simNowMs,
    match.phase === 'playing' || match.phase === 'countdown',
  );

  weaponView.group.visible = playerEnt.alive;
  weaponView.update(dt, view.bob, w.reloadSnapshot(simNowMs), vfxDbg, {
    spinLevel: w.spinLevel,
    firing: gatlingActivelyFiring,
  });
  hud.setSwapBlur(weaponView.swapBlurAmount);
  worldVfx.update(dt, view.camera, vfxDbg);

  const focalPx = window.innerHeight / 2 / Math.tan((view.camera.fov / 2) * (Math.PI / 180));
  hud.update({
    hp: playerEnt.hp,
    maxHp: playerEnt.maxHp,
    regenerating: isRegenerating,
    ammo: w.ammo,
    mag: w.spec.mag,
    reloading: w.reloading,
    weaponId: w.spec.id,
    weaponName: w.spec.name,
    spinLevel: w.spinLevel,
    spreadPx: Math.tan(w.spreadAt(simNowMs)) * focalPx,
    fps: window.__fps,
    dead: !playerEnt.alive,
    respawnIn: 0,
  });

  const ri = engine.renderer.info;
  rinfo.calls = ri.render.calls;
  rinfo.triangles = ri.render.triangles;
  rinfo.points = ri.render.points;
  rinfo.lines = ri.render.lines;
  rinfo.geometries = ri.memory.geometries;
  rinfo.textures = ri.memory.textures;

  dbg.x = player.position.x;
  dbg.y = player.position.y;
  dbg.z = player.position.z;
  dbg.hp = playerEnt.hp;
  dbg.maxHp = playerEnt.maxHp;
  dbg.ammo = w.ammo;
  dbg.mag = w.spec.mag;
  dbg.weapon = w.spec.id;
  dbg.spinLevel = w.spinLevel;
  dbg.reloading = w.reloading;
  dbg.dead = !playerEnt.alive;
  dbg.difficulty = currentDifficulty;
  dbg.kills = roundKills;
  dbg.survivalMs =
    playerDeathSimAt >= 0
      ? Math.max(0, playerDeathSimAt - roundStartSimAt)
      : acting
        ? Math.max(0, simNowMs - roundStartSimAt)
        : 0;
  dbg.deathPanelVisible = deathPanelShown;
  dbg.yaw = player.yaw;
  dbg.pitch = player.pitch;
  dbg.firing = inp.fire;
  dbgSfx.muted = sfx.muted;
  dbgSfx.unlocked = sfx.unlocked;

  animDbg.reloadActive = weaponView.animDebug.reloadActive;
  animDbg.reloadElapsedMs = weaponView.animDebug.reloadElapsedMs;
  animDbg.reloadDurationMs = weaponView.animDebug.reloadDurationMs;
  animDbg.magDetached = weaponView.animDebug.magDetached;
  animDbg.newMagInHand = weaponView.animDebug.newMagInHand;
  animDbg.swapActive = weaponView.animDebug.swapActive;
  animDbg.simTimeMs = simNowMs;

  mdbg.phase = match.phase;
  mdbg.killsA = match.killsA;
  mdbg.killsB = match.killsB;
  mdbg.timeLeftMs = match.timeLeftMs;
  mdbg.winner = match.winner;

  enemiesDbg.length = 0;
  for (const b of enemyMgr.bots) {
    enemiesDbg.push({
      id: b.id,
      faction: b.faction,
      state: b.state,
      anim: b.anim,
      clip: enemyRenderer.getActiveClip(b.id),
      clipsPlayed: enemyRenderer.getClipsPlayed(b.id),
      modelSource: enemyRenderer.modelSource,
      modelLoaded: enemyRenderer.isModelLoaded,
      hp: b.entity.hp,
      maxHp: b.entity.maxHp,
      ammo: b.ammo,
      shotsFired: b.shotsFired,
      hasLos: b.hasLos,
      firstSightAt: b.firstSightAt,
      firstShotAt: b.firstShotAt,
      x: b.entity.pos.x,
      y: b.entity.pos.y,
      z: b.entity.pos.z,
      tris: enemyRenderer.getRigTris(b.id),
    });
  }
};

/** persistent debug handles (no per-frame alloc) — e2e tests read these */
const dbg = {
  x: sx,
  y: sy,
  z: sz,
  hp: playerEnt.hp,
  maxHp: playerEnt.maxHp,
  ammo: rack.current.ammo,
  mag: rack.current.spec.mag,
  weapon: rack.current.spec.id as string,
  weapons: rack.list.map((w) => w.spec.id) as string[],
  spinLevel: 0,
  reloading: false,
  dead: false,
  difficulty: currentDifficulty,
  kills: 0,
  survivalMs: 0,
  deathPanelVisible: false,
  yaw: 0,
  pitch: 0,
  firing: false,
};
window.__state = dbg;
const dbgSfx = { counts: sfx.counts, muted: false, unlocked: false };
window.__sfx = dbgSfx;
window.__bgm = bgm.telemetry;
window.__fx = hud.fx;
const animDbg = {
  reloadActive: false,
  reloadElapsedMs: 0,
  reloadDurationMs: 0,
  magDetached: false,
  newMagInHand: false,
  swapActive: false,
  simTimeMs: 0,
};
window.__anim = animDbg;
const vfxDbg: VfxTelemetry = {
  muzzleParticles: 0,
  muzzleFlashSlots: 0,
  muzzleLightsActive: 0,
  muzzleLightMaxIntensity: 0,
  shellsActive: 0,
  shellsGrounded: 0,
  tracersActive: 0,
  sparksActive: 0,
  decalsCount: 0,
};
window.__vfx = vfxDbg;
window.__hands = weaponView.handsTelemetry;
const enemiesDbg: Window['__enemies'] = [];
window.__enemies = enemiesDbg;
window.__enemyTags = enemyTags.telemetry;
window.__test = {
  hurt: (dmg: number) => hurtPlayer(dmg),
  // e2e-only camera placement: drop the player at (x,z[,y]) facing yaw/pitch
  teleport: (x: number, z: number, yawDeg: number, pitchDeg: number, y?: number) => {
    player.position.x = x;
    if (y !== undefined) {
      player.position.y = y;
      player.velocity.y = 0;
      player.onGround = y >= -0.05;
    }
    player.position.z = z;
    player.yaw = (yawDeg * Math.PI) / 180;
    player.pitch = (pitchDeg * Math.PI) / 180;
    view.snap(player);
  },
  isInsideWalkable: (x: number, z: number) => world.isInsideWalkable(x, z, PLAYER_RADIUS),
  setPaused: (paused: boolean) => {
    if (paused) engine.pause();
    else engine.resume();
  },
  spawnEnemyAt: (x: number, z: number, yawDeg: number, faction?: Faction) => {
    const b = enemyMgr.spawnManual(x, z, (yawDeg * Math.PI) / 180, faction, simNowMs);
    enemyRenderer.sync(enemyMgr.bots, 0, simNowMs, view.camera.position);
    return b.id;
  },
  clearEnemies: () => {
    enemyMgr.clear();
    enemyRenderer.clearAll();
    enemyTags.clearAll();
  },
  setDifficulty: (diff: DifficultyId) => {
    currentDifficulty = diff;
    menu.setDifficulty(diff);
    enemyMgr.setDifficulty(diff);
  },
  damageEnemy: (id: string, dmg: number) => {
    const b = enemyMgr.bots.find((e) => e.id === id);
    if (!b) return;
    applyDamage(b.entity, dmg, simNowMs);
    enemyMgr.onBotDamaged(b.entity, player.position, simNowMs);
  },
};
const mdbg = {
  phase: 'menu',
  killsA: 0,
  killsB: 0,
  timeLeftMs: 0,
  winner: null as string | null,
};
window.__match = mdbg;
const rinfo = { calls: 0, triangles: 0, points: 0, lines: 0, geometries: 0, textures: 0 };
window.__renderInfo = rinfo;

// Seed HUD immediately with full initial mag so frame 0 never shows 0 / empty bars
hud.update({
  hp: playerEnt.hp,
  maxHp: playerEnt.maxHp,
  ammo: rack.current.ammo,
  mag: rack.current.spec.mag,
  reloading: rack.current.reloading,
  weaponId: rack.current.spec.id,
  weaponName: rack.current.spec.name,
  spinLevel: rack.current.spinLevel,
  spreadPx: 0,
  fps: 60,
  dead: false,
  respawnIn: 0,
});

view.snap(player);
engine.start();
