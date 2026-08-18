/**
 * Chase camera for flight sequences.
 *
 * Sits behind and slightly above the ship, leads into turns, rolls with lateral
 * input, and pumps its field of view under boost. All damping is exponential in
 * delta so the feel is identical at 60 Hz and 144 Hz.
 */

import * as THREE from 'three';
import type { FlightRunView } from './model/types';

const BASE_FOV = 58;
const BOOST_FOV = 70;

/** Where the camera wants to sit relative to the ship. */
const OFFSET = new THREE.Vector3(0, 1.35, 8.2);

/** How far ahead of the ship the camera looks. */
const LOOK_AHEAD = 16;

/**
 * Camera position while flying: mounted on top of the vehicle near the nose,
 * so the tip is in shot at the bottom of the frame and everything above it is
 * corridor. Sitting back behind the tail put the whole body in the way.
 */
const FLYING_BACK = 0.4;
const FLYING_LIFT = 0.95;

/** Camera distance while watching the liftoff from beside the pad. */
const PAD_BACK = 15;

export class ChaseCamera {
  readonly camera = new THREE.PerspectiveCamera(BASE_FOV, 16 / 9, 0.1, 900);

  private readonly target = new THREE.Vector3();
  private readonly lookTarget = new THREE.Vector3();
  private shake = 0;
  private roll = 0;
  private fov = BASE_FOV;
  /** Upward tilt in world units added to the look target. */
  private pitch = 0;
  /** 1 = pad shot, 0 = tucked in behind. Only used in launch mode. */
  private launchFraming = 1;
  private launchMode = false;

  constructor() {
    this.camera.position.copy(OFFSET);
  }

  /**
   * Tilt the view upward. `amount` is in world units added to the height of
   * the look target, so 0 looks straight down the corridor and larger values
   * fill the frame with sky. The ascent uses this so the climb reads as going
   * up rather than flying forward.
   */
  setPitch(amount: number): void {
    this.pitch = amount;
  }

  /**
   * Blend between the two launch framings.
   *
   * 1 is the pad shot: the camera stands off to the side at ground level and
   * watches the vehicle climb away. 0 is the flying shot: mounted on top of the
   * vehicle by the nose, so its tip sits low in the frame and the rest is
   * corridor.
   */
  setLaunchFraming(padWeight: number): void {
    this.launchFraming = Math.max(0, Math.min(1, padWeight));
    this.launchMode = true;
  }

  clearLaunchFraming(): void {
    this.launchMode = false;
  }

  /** Kick the camera on a collision. Strength is roughly 0-1. */
  impulse(strength: number): void {
    this.shake = Math.min(1.2, this.shake + strength);
  }

  reset(): void {
    this.shake = 0;
    this.roll = 0;
    this.fov = BASE_FOV;
    this.pitch = 0;
    this.launchFraming = 1;
    this.launchMode = false;
    this.camera.position.copy(OFFSET);
    this.camera.rotation.set(0, 0, 0);
    this.camera.fov = BASE_FOV;
    this.camera.updateProjectionMatrix();
  }

  update(delta: number, view: FlightRunView, boosting: boolean, reducedMotion: boolean): void {
    // Follow with exponential damping rather than a fixed lerp factor, so the
    // camera lags by the same amount in wall-clock time at any frame rate.
    if (this.launchMode) {
      const w = this.launchFraming;

      // Pad shot stands off to the side and below. The flying shot sits on top
      // of the vehicle near the nose, so its tip is in shot and the body is not
      // in the way.
      this.target.set(
        view.shipX + w * 8.5,
        view.shipY + (1 - w) * FLYING_LIFT - w * 6.3,
        FLYING_BACK + w * (PAD_BACK - FLYING_BACK),
      );
      // Lag hard during the pad shot so the rocket visibly pulls away from the
      // camera, then track tightly once the player is flying it.
      const follow = 1 - Math.exp(-(2.2 + (1 - w) * 7) * delta);
      this.camera.position.lerp(this.target, follow);

      // Flying, look level from the nose mount so the tip sits low in frame and
      // the corridor fills the rest; angled up at the vehicle on the pad.
      this.lookTarget.set(
        view.shipX * (1 - w * 0.4) + view.shipVX * 0.25 * (1 - w),
        view.shipY + (1 - w) * FLYING_LIFT + w * 3.4,
        w * -2 + (1 - w) * -LOOK_AHEAD,
      );
      this.camera.lookAt(this.lookTarget);
    } else {
      this.target.set(view.shipX + OFFSET.x, view.shipY + OFFSET.y, OFFSET.z);
      const follow = 1 - Math.exp(-7 * delta);
      this.camera.position.lerp(this.target, follow);

      // Lead the turn slightly so hard steering reads as intent, not drift.
      this.lookTarget.set(
        view.shipX + view.shipVX * 0.25,
        view.shipY + view.shipVY * 0.2 + this.pitch,
        -LOOK_AHEAD,
      );
      this.camera.lookAt(this.lookTarget);
    }

    if (!reducedMotion) {
      const targetRoll = -Math.max(-1, Math.min(1, view.shipVX * 0.09)) * 0.3;
      this.roll += (targetRoll - this.roll) * (1 - Math.exp(-6 * delta));
      this.camera.rotateZ(this.roll);

      if (this.shake > 0.001) {
        this.shake *= Math.exp(-5 * delta);
        const amount = this.shake * 0.35;
        this.camera.position.x += (Math.random() - 0.5) * amount;
        this.camera.position.y += (Math.random() - 0.5) * amount;
      }
    }

    const targetFov = boosting ? BOOST_FOV : BASE_FOV;
    const nextFov = reducedMotion
      ? BASE_FOV
      : this.fov + (targetFov - this.fov) * (1 - Math.exp(-4 * delta));
    if (Math.abs(nextFov - this.fov) > 0.01) {
      this.fov = nextFov;
      this.camera.fov = nextFov;
      this.camera.updateProjectionMatrix();
    }
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
