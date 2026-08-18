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
  private plumes: THREE.Mesh[] = [];
  private readonly plumeMaterial: THREE.MeshBasicMaterial;

  private visibleCores = 0;
  private bobTime = 0;

  constructor() {
    this.hullHost.position.copy(HULL_POSITION);
    this.group.add(this.hullHost);
    this.group.add(this.coreHost);
    this.group.add(this.plumeHost);

    // Thruster plumes are additive unlit quads: cheap, and they posterise into
    // hard bands which is exactly the look the reference VFX has.
    this.plumeMaterial = new THREE.MeshBasicMaterial({
      color: '#8fe4ff',
      transparent: true,
      opacity: 0.75,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
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
      plume.geometry.dispose();
    }
    this.plumes = [];

    for (let i = 0; i < 4; i += 1) {
      const plume = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.28), this.plumeMaterial);
      plume.position.set(
        // The ascender is fitted to 4.2 units long, so its tail sits about 2.1
        // behind the hull centre. At the old offset the quads were buried in
        // the body with only their tips showing past the nose.
        HULL_POSITION.x + 2.95,
        HULL_POSITION.y - 0.35 + i * 0.24,
        0.05 + i * 0.01,
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

    // Plumes flicker per-frame and scale with the burn rate.
    const base = 0.35 + burnFactor * 1.5;
    this.plumes.forEach((plume, index) => {
      const flicker = 0.82 + Math.sin(elapsed * 22 + index * 2.1) * 0.18;
      plume.scale.set(base * flicker, 0.7 + burnFactor * 0.5, 1);
      plume.position.x = HULL_POSITION.x + 1.2 + (base * flicker) / 2;
    });
    this.plumeMaterial.opacity = 0.32 + burnFactor * 0.5;
  }

  dispose(): void {
    this.plumeMaterial.dispose();
    for (const plume of this.plumes) plume.geometry.dispose();
    this.plumes = [];
  }
}
