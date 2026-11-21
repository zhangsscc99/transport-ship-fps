// Maps pure Player state onto a PerspectiveCamera.
// Eye height 1.7 standing / 1.15 crouched; pitch clamped to ±85° in Player.
// View bob is decoupled from reload animation via a smooth weighted blend
// (0.3 weight during reload). Additive pitch/yaw offsets (reload sight dip,
// easeOutQuad camera recoil, air-wall bump) never lock player look input.

import * as THREE from 'three';
import type { Player } from '../game/player';
import { clamp01, damp, easeOutQuad } from './tween';

export interface CameraMotionState {
  reloading: boolean;
  /** subtle downward sight dip (radians, typically negative) during reload */
  reloadPitchDip?: number;
}

export class PlayerCamera {
  readonly camera: THREE.PerspectiveCamera;
  private eyeY = 0;
  private bobPhase = 0;
  private bobAmp = 0;
  private bobWeight = 1;
  private reloadDipSmooth = 0;
  private readonly baseFov: number;

  // Camera recoil recovery (easeOutQuad): separate from weapon visual kick.
  // The permanent 20% climb is committed to player.pitch; the remaining 80%
  // transient climb eases back to 0 here via easeOutQuad.
  private recoilPeakPitch = 0;
  private recoilPeakYaw = 0;
  private recoilElapsed = 0;
  private recoilDuration = 0.11;
  private recoilPitch = 0;
  private recoilYaw = 0;

  // Tactile air-wall forward pitch bump (0.5° over 80ms)
  private wallBumpElapsed = 1;
  private readonly wallBumpDur = 0.08;
  private readonly wallBumpPeak = -(0.5 * Math.PI) / 180;

  /** weighted walk bob exposed so WeaponView shares the exact same decoupled rhythm */
  readonly bob = { x: 0, y: 0, weight: 1 };

  constructor(aspect: number, fov = 75) {
    this.baseFov = fov;
    this.camera = new THREE.PerspectiveCamera(fov, aspect, 0.05, 300);
    this.camera.rotation.order = 'YXZ';
    this.applyFov();
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.applyFov();
  }

  /** Portrait keeps a tighter FOV so enemies aren't pushed out of frame. */
  private applyFov(): void {
    this.camera.fov = this.camera.aspect < 1 ? this.baseFov * 0.85 : this.baseFov;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Apply camera recoil for one shot:
   * `pitchRad` is the total kick (rifle 2.5° / sniper 8° / shotgun 6°);
   * 20% stays permanently in `player.pitch`, 80% recovers via easeOutQuad over `durationSec`.
   */
  addRecoil(player: Player, pitchRad: number, durationSec: number, yawRad = 0): void {
    const keepFrac = 0.2;
    const transientFrac = 1 - keepFrac;
    player.pitch = Math.max(
      -(85 * Math.PI) / 180,
      Math.min((85 * Math.PI) / 180, player.pitch + pitchRad * keepFrac),
    );
    this.recoilPeakPitch = Math.min(0.26, this.recoilPitch + pitchRad * transientFrac);
    this.recoilPeakYaw = this.recoilYaw + yawRad * transientFrac;
    this.recoilElapsed = 0;
    this.recoilDuration = Math.max(0.04, durationSec);
    this.recoilPitch = this.recoilPeakPitch;
    this.recoilYaw = this.recoilPeakYaw;
  }

  /** Subtle 0.5° forward camera nudge recovering in 80ms on air-wall contact. */
  triggerWallBump(): void {
    if (this.wallBumpElapsed < this.wallBumpDur * 0.75) return;
    this.wallBumpElapsed = 0;
  }

  update(player: Player, dt: number, motion?: CameraMotionState): void {
    const p = player.position;
    const targetEye = player.eyeHeight;
    // Critically-damped smoothing so crouching doesn't snap.
    this.eyeY = damp(this.eyeY, p.y + targetEye, 18, dt);

    // Decoupled bob weight: 0.3 while reloading, 1.0 otherwise (smoothly blended)
    const targetWeight = motion?.reloading ? 0.3 : 1.0;
    this.bobWeight = damp(this.bobWeight, targetWeight, 14, dt);

    // Reload sight dip (additive — never locks player look)
    const targetDip = motion?.reloadPitchDip ?? 0;
    this.reloadDipSmooth = damp(this.reloadDipSmooth, targetDip, 18, dt);

    // Camera recoil recovery using easeOutQuad
    if (this.recoilPeakPitch !== 0 || this.recoilPeakYaw !== 0) {
      this.recoilElapsed += dt;
      const t = clamp01(this.recoilElapsed / this.recoilDuration);
      const rem = 1 - easeOutQuad(t);
      this.recoilPitch = this.recoilPeakPitch * rem;
      this.recoilYaw = this.recoilPeakYaw * rem;
      if (t >= 1) {
        this.recoilPeakPitch = 0;
        this.recoilPeakYaw = 0;
        this.recoilPitch = 0;
        this.recoilYaw = 0;
      }
    }

    // Air-wall bump (0.5° forward dip, 80ms bounce back via easeOutQuad)
    let wallPitch = 0;
    if (this.wallBumpElapsed < this.wallBumpDur) {
      this.wallBumpElapsed += dt;
      const u = clamp01(this.wallBumpElapsed / this.wallBumpDur);
      // Peak quickly at 25% (20ms), spring back smoothly via easeOutQuad
      const env = u < 0.25 ? u / 0.25 : 1 - easeOutQuad((u - 0.25) / 0.75);
      wallPitch = this.wallBumpPeak * env;
    }

    // Walk bob: phase advances with distance travelled, scaled by bobWeight
    const hSpeed = Math.hypot(player.velocity.x, player.velocity.z);
    this.bobPhase += hSpeed * dt * 2.2;
    const targetAmp = player.onGround ? Math.min(0.02, hSpeed * 0.0032) : 0;
    this.bobAmp = damp(this.bobAmp, targetAmp, 8, dt);
    const weightedAmp = this.bobAmp * this.bobWeight;
    const bobY = Math.sin(this.bobPhase) * weightedAmp;
    const bobX = Math.cos(this.bobPhase * 0.5) * weightedAmp * 0.5;
    const roll = Math.sin(this.bobPhase * 0.5) * weightedAmp * 0.12;

    this.bob.x = bobX;
    this.bob.y = bobY;
    this.bob.weight = this.bobWeight;

    const finalPitch = Math.max(
      -(87 * Math.PI) / 180,
      Math.min((87 * Math.PI) / 180, player.pitch + this.reloadDipSmooth + this.recoilPitch + wallPitch),
    );
    this.camera.position.set(p.x, this.eyeY + bobY, p.z);
    this.camera.rotation.set(finalPitch, player.yaw + this.recoilYaw, roll);
  }

  /** Snap to the player (used on spawn/respawn, no lerp). */
  snap(player: Player): void {
    this.eyeY = player.position.y + player.eyeHeight;
    this.bobAmp = 0;
    this.bobWeight = 1;
    this.reloadDipSmooth = 0;
    this.recoilPeakPitch = 0;
    this.recoilPeakYaw = 0;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.wallBumpElapsed = 1;
    this.update(player, 0);
  }
}
