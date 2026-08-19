/**
 * The player's ship and its team of drive cores.
 *
 * This is the direct translation of the reference frames' wagon-and-oxen
 * composition: the hull sits right of centre and the drive cores string out
 * ahead of it like a team in harness. The core count is read from game state,
 * so a burned-out core visibly leaves the line — the same read the original
 * gives you when an ox dies.
 */

import * as THREE from 'three';
import { createGlowTexture } from './glow';

/** Spacing between drive cores along the tow line. */
const CORE_SPACING = 1.5;

/** Where the hull sits in world space. */
// Pushed back from the drive cores: the ascender hull is long once laid on its
// side, and at the old offset its nose sat on top of the nearest core.
const HULL_POSITION = new THREE.Vector3(5.4, -3.1, 0);

export class ShipRig {
  readonly group = new THREE.Group();

  private readonly hullHost = new THREE.Group();
  private readonly coreHost = new THREE.Group();
  private readonly plumeHost = new THREE.Group();

  private hullModel: THREE.Object3D | null = null;
  private coreModel: THREE.Object3D | null = null;
  private coreInstances: THREE.Object3D[] = [];
  private plumes: THREE.Sprite[] = [];
  private readonly plumeMaterial: THREE.SpriteMaterial;

  private visibleCores = 0;
  private bobTime = 0;

  constructor() {
    this.hullHost.position.copy(HULL_POSITION);
    this.group.add(this.hullHost);
    this.group.add(this.coreHost);
    this.group.add(this.plumeHost);

    // A soft glow at the engines rather than hard additive quads. The ship
    // coasts for most of the crossing, so this is a hint of power, not a
    // full exhaust plume; the old rectangles read as debris stuck to the hull.
    this.plumeMaterial = new THREE.SpriteMaterial({
      map: createGlowTexture(),
      color: '#9fe8ff',
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
  }

  /** Install the generated hull. Replaces any previous model. */
  setHullModel(model: THREE.Object3D): void {
    if (this.hullModel) this.hullHost.remove(this.hullModel);
    // The ascender is modelled nose-up for the pad. In the travel view it is
    // coasting, so lay it on its side with the nose pointing the way it is
    // going — otherwise it flies broadside across the whole crossing.
    model.rotation.set(0, 0, Math.PI / 2);
    this.hullModel = model;
    this.hullHost.add(model);
    this.buildPlumes();
  }

  /** Install the generated drive core. Cores are cloned from this source. */
  setCoreModel(model: THREE.Object3D): void {
    this.coreModel = model;
    // Force a rebuild so already-requested cores appear.
    const wanted = this.visibleCores;
    this.visibleCores = -1;
    this.setCoreCount(wanted);
  }

  get hasHull(): boolean {
    return this.hullModel !== null;
  }

  /**
   * Match the number of visible cores to game state. Cores are added at the
   * front of the line and removed from the back, so a failure reads as the
   * nearest core dropping out.
   */
  setCoreCount(count: number): void {
    const clamped = Math.max(0, Math.min(10, Math.round(count)));
    if (clamped === this.visibleCores) return;
    this.visibleCores = clamped;

    for (const instance of this.coreInstances) {
      this.coreHost.remove(instance);
      instance.clear();
    }
    this.coreInstances = [];

    if (!this.coreModel) return;

    for (let i = 0; i < clamped; i += 1) {
      const instance = this.coreModel.clone(true);
      instance.position.set(
        HULL_POSITION.x - 4.4 - i * CORE_SPACING,
        HULL_POSITION.y + 0.15,
        // Alternate slightly in depth so a long team reads as a team, not a wall.
        (i % 2 === 0 ? 0.22 : -0.22),
      );
      instance.rotation.y = Math.PI * 0.5;
      this.coreHost.add(instance);
      this.coreInstances.push(instance);
    }
  }

  private buildPlumes(): void {
    for (const plume of this.plumes) {
      this.plumeHost.remove(plume);
      // Sprites share one global geometry — disposing it here would break
      // every other sprite in the app, including the cloud deck.
    }
    this.plumes = [];

    for (let i = 0; i < 1; i += 1) {
      const plume = new THREE.Sprite(this.plumeMaterial);
      plume.scale.set(2.4, 1.5, 1);
      plume.position.set(
        HULL_POSITION.x + 2.5,
        HULL_POSITION.y + 0.05,
        0.2,
      );
      this.plumeHost.add(plume);
      this.plumes.push(plume);
    }
  }

  /**
   * @param burnFactor 0 for coasting, 1 for a hard burn. Drives plume length.
   */
  update(delta: number, elapsed: number, burnFactor: number): void {
    this.bobTime += delta;

    // A slow vertical bob sells thrust without animating the model itself.
    const bob = Math.sin(this.bobTime * 0.9) * 0.075;
    this.hullHost.position.y = HULL_POSITION.y + bob;
    this.hullHost.rotation.z = Math.sin(this.bobTime * 0.6) * 0.012;

    this.coreInstances.forEach((instance, index) => {
      instance.position.y =
        HULL_POSITION.y + 0.15 + Math.sin(this.bobTime * 1.1 + index * 0.7) * 0.055;
      instance.rotation.z = Math.sin(this.bobTime * 0.8 + index) * 0.03;
    });

    // The glow breathes with the burn rate rather than stretching into a
    // plume: a hint that the engines are lit, not a full exhaust.
    const size = 1.5 + burnFactor * 1.4;
    this.plumes.forEach((plume, index) => {
      const flicker = 0.9 + Math.sin(elapsed * 9 + index * 2.1) * 0.1;
      plume.scale.set(size * flicker, size * 0.75 * flicker, 1);
    });
    this.plumeMaterial.opacity = 0.22 + burnFactor * 0.38;
  }

  dispose(): void {
    this.plumeMaterial.dispose();
    for (const plume of this.plumes) plume.geometry.dispose();
    this.plumes = [];
  }
}
