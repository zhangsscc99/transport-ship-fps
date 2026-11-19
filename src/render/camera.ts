// Maps pure Player state onto a PerspectiveCamera.
// Eye height 1.7 standing / 1.15 crouched (SPEC §移动); pitch already
// clamped to ±85° inside Player.update. Portrait screens get a narrower
// FOV, and walking adds a speed-scaled bob (amplitude ≤ 2cm).

import * as THREE from 'three';
import type { Player } from '../game/player';

export class PlayerCamera {
  readonly camera: THREE.PerspectiveCamera;
  private eyeY = 0;
  private bobPhase = 0;
  private bobAmp = 0;
  private readonly baseFov: number;

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

  update(player: Player, dt: number): void {
    const p = player.position;
    const targetEye = player.eyeHeight;
    // Critically-damped-ish smoothing so crouching doesn't snap.
    const k = 1 - Math.exp(-18 * dt);
    this.eyeY += (p.y + targetEye - this.eyeY) * k;

    // Walk bob: phase advances with distance travelled (frequency ∝ speed),
    // amplitude eases toward a speed-scaled cap of 0.02 and dies in the air.
    const hSpeed = Math.hypot(player.velocity.x, player.velocity.z);
    this.bobPhase += hSpeed * dt * 2.2;
    const targetAmp = player.onGround ? Math.min(0.02, hSpeed * 0.0032) : 0;
    this.bobAmp += (targetAmp - this.bobAmp) * Math.min(1, dt * 8);
    const bobY = Math.sin(this.bobPhase) * this.bobAmp;
    const roll = Math.sin(this.bobPhase * 0.5) * this.bobAmp * 0.12;

    this.camera.position.set(p.x, this.eyeY + bobY, p.z);
    this.camera.rotation.set(player.pitch, player.yaw, roll);
  }

  /** Snap to the player (used on spawn/respawn, no lerp). */
  snap(player: Player): void {
    this.eyeY = player.position.y + player.eyeHeight;
    this.bobAmp = 0;
    this.update(player, 0);
  }
}
