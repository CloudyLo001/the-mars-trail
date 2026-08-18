/**
 * The scene for playable flight sequences.
 *
 * Deliberately separate from `TravelScene`. Every layout assumption there is
 * inverted here: the camera moves, the ship steers, and the world flows toward
 * the viewer in +z rather than scrolling sideways in +x.
 *
 * What it does reuse: the loaded Mint prop families, the per-leg palettes, and
 * the same render pipeline via `setSceneAndCamera`.
 */

import * as THREE from 'three';
import { ChaseCamera } from './ChaseCamera';
import { CloudLayer } from './CloudLayer';
import { ObstacleField } from './ObstacleField';
import { paletteFor, type ScenePalette } from '../scene/palettes';
import type { FlightConfig, FlightRunView } from './model/types';

/** Distance the ground plane spans on launch and descent. */
const GROUND_SIZE = 900;

/** Star count. Fewer than the travel backdrop; the eye is busy here. */
const STAR_COUNT = 600;

/** How long the camera takes to swing from the pad shot to the flying shot. */
const HANDOVER_SECONDS = 2;

/** Reused rather than allocated per frame when tinting the cloud deck. */
const WHITE = new THREE.Color('#ffffff');

/**
 * Ascent sky, as flat opaque bands rather than a gradient.
 *
 * Each band is a single solid colour held until the next altitude threshold,
 * so climbing reads as passing through distinct layers of atmosphere. A smooth
 * gradient would blend them into mush and lose that.
 */
const ASCENT_SKY: Array<{ upTo: number; color: string; ground: string }> = [
  { upTo: 0.14, color: '#5f93bb', ground: '#a8875c' },
  { upTo: 0.3, color: '#427ba8', ground: '#8f7049' },
  { upTo: 0.46, color: '#2f5f8e', ground: '#75593c' },
  { upTo: 0.62, color: '#2b5a97', ground: '#7d6446' },
  { upTo: 0.78, color: '#173463', ground: '#5a4832' },
  { upTo: 0.9, color: '#0a1733', ground: '#332a1e' },
  { upTo: 1.01, color: '#05070f', ground: '#14110c' },
];

function ascentBand(progress: number) {
  for (const band of ASCENT_SKY) if (progress < band.upTo) return band;
  return ASCENT_SKY[ASCENT_SKY.length - 1];
}

export class FlightScene {
  readonly scene = new THREE.Scene();
  readonly chase = new ChaseCamera();
  readonly obstacles = new ObstacleField();
  readonly clouds: CloudLayer;

  private readonly sun: THREE.DirectionalLight;
  private readonly hemi: THREE.HemisphereLight;
  private readonly rim: THREE.DirectionalLight;

  private readonly shipHost = new THREE.Group();
  private shipModel: THREE.Object3D | null = null;

  private readonly stars: THREE.Points;
  private readonly starMaterial: THREE.PointsMaterial;

  private readonly ground: THREE.Mesh;
  private readonly groundMaterial: THREE.MeshStandardMaterial;

  private palette: ScenePalette = paletteFor('debris-belt');
  private config: FlightConfig | null = null;

  /** The launch complex: pad, gantry, tanks, berm, and the mesa horizon. */
  private readonly padHost = new THREE.Group();
  private readonly cloudTint = new THREE.Color('#ffffff');

  constructor(private readonly rng: () => number) {
    this.clouds = new CloudLayer(rng);
    this.scene.add(this.clouds.group);

    this.hemi = new THREE.HemisphereLight('#8fc7e8', '#123048', 2);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight('#fff4d6', 3.4);
    this.sun.position.set(8, 10, 6);
    this.scene.add(this.sun);

    // Keeps the shadowed side of the hull off pure black as it banks.
    this.rim = new THREE.DirectionalLight('#7fb6e0', 0.9);
    this.rim.position.set(-7, 2, 5);
    this.scene.add(this.rim);

    this.scene.add(this.shipHost);
    this.scene.add(this.obstacles.group);
    this.scene.add(this.padHost);

    // --- starfield -------------------------------------------------------
    const positions = new Float32Array(STAR_COUNT * 3);
    for (let i = 0; i < STAR_COUNT; i += 1) {
      positions[i * 3] = (rng() - 0.5) * 500;
      positions[i * 3 + 1] = (rng() - 0.5) * 320;
      positions[i * 3 + 2] = -rng() * 700;
    }
    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.starMaterial = new THREE.PointsMaterial({
      color: '#ffffff',
      size: 1.1,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
    });
    this.stars = new THREE.Points(starGeometry, this.starMaterial);
    this.scene.add(this.stars);

    // --- ground ----------------------------------------------------------
    // Used by the launch (falls away beneath you) and the descent (rises to
    // meet you). Hidden entirely in deep space.
    this.groundMaterial = new THREE.MeshStandardMaterial({
      color: '#6d6350',
      roughness: 1,
      metalness: 0,
      flatShading: true,
    });
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE, 24, 24),
      this.groundMaterial,
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.visible = false;
    this.scene.add(this.ground);
  }

  /**
   * Install the vehicle. It is the one object that steers.
   *
   * The launch rocket is modelled standing upright, which is correct on the pad
   * but perpendicular to its own direction of travel once it is flying. It is
   * therefore pitched over during the handover — a gravity turn — rather than
   * being fixed at either extreme.
   */
  setShipModel(model: THREE.Object3D): void {
    if (this.shipModel) this.shipHost.remove(this.shipModel);
    this.shipModel = model;
    // Nose along the corridor by default. The launch overrides this each frame
    // so the vehicle can stand upright on the pad and pitch over on handover.
    model.rotation.set(-Math.PI / 2, 0, 0);
    this.shipHost.add(model);
  }

  /**
   * Prepare for a sequence. Called once, before the first step.
   *
   * @param props loaded GLBs for this sequence's family; may be empty if the
   *   family is still streaming, in which case placeholders stand in.
   */
  begin(config: FlightConfig, props: THREE.Object3D[], padProps: THREE.Object3D[] = []): void {
    this.config = config;
    this.palette = paletteFor(config.sceneKey);
    this.applyPalette(this.palette);
    this.obstacles.populate(props, config.capacity, this.rng);
    this.clouds.reset(this.rng, config.spawnDepth);
    this.chase.reset();

    const grounded = config.id === 'launch' || config.id === 'mars-descent';
    this.ground.visible = grounded;
    if (grounded) {
      this.groundMaterial.color.set(config.id === 'launch' ? '#c9a978' : '#a2542a');
    }

    this.clearPad();
    if (config.id === 'launch') this.buildPad(padProps);
  }

  /** Replace the obstacle models once their family has streamed in. */
  rebuildObstacles(props: THREE.Object3D[]): void {
    if (!this.config || props.length === 0) return;
    this.obstacles.populate(props, this.config.capacity, this.rng);
  }

  /** Replace the launch complex once its assets have streamed in. */
  rebuildPad(props: THREE.Object3D[]): void {
    if (this.config?.id !== 'launch') return;
    this.clearPad();
    this.buildPad(props);
  }

  /**
   * Lay out the launch complex around the vehicle.
   *
   * Placement is by index rather than by name so it degrades gracefully: with
   * no generated props the ascent still runs, just over open desert.
   */
  private buildPad(props: THREE.Object3D[]): void {
    if (props.length === 0) return;

    // desert-01..06 in key order. Index 2 is the tileable ground slab and is
    // deliberately unused: the scene already has a ground plane, and dropping a
    // second slab in leaves a plate hanging in the sky.
    const PAD = 0;
    const GANTRY = 1;
    const MESA = 3;
    const TANKS = 4;
    const BERM = 5;

    const layout: Array<{ index: number; pos: [number, number, number]; scale: number; rotY?: number }> = [
      { index: PAD, pos: [0, -5.6, 0], scale: 4.5 },
      { index: GANTRY, pos: [-6.5, -3.4, -1], scale: 5.5 },
      { index: TANKS, pos: [13, -5, -14], scale: 4 },
      { index: BERM, pos: [-15, -5.2, -22], scale: 6, rotY: 0.2 },
      { index: MESA, pos: [0, -6, -150], scale: 46 },
      { index: MESA, pos: [-90, -6, -190], scale: 52, rotY: 0.6 },
      { index: MESA, pos: [95, -6, -175], scale: 44, rotY: -0.4 },
    ];

    for (const entry of layout) {
      // No fallback: a missing slot leaves that piece out rather than standing
      // the wrong model in its place.
      const source = props[entry.index];
      if (!source) continue;
      const object = source.clone(true);
      object.position.set(...entry.pos);
      object.scale.setScalar(entry.scale);
      if (entry.rotY) object.rotation.y = entry.rotY;
      this.padHost.add(object);
    }
  }

  private clearPad(): void {
    for (const child of [...this.padHost.children]) {
      this.padHost.remove(child);
      child.clear();
    }
  }

  private applyPalette(palette: ScenePalette): void {
    this.scene.background = new THREE.Color(palette.skyBottom);
    this.scene.fog = new THREE.Fog(palette.fog, palette.fogNear, palette.fogFar);

    this.sun.color.set(palette.sunColor);
    this.sun.intensity = palette.sunIntensity;
    this.sun.position.set(...palette.sunPosition);
    this.hemi.color.set(palette.hemiSky);
    this.hemi.groundColor.set(palette.hemiGround);
    this.hemi.intensity = palette.hemiIntensity;

    this.starMaterial.opacity = 0.15 + palette.starDensity * 0.8;
    this.stars.visible = palette.starDensity > 0.02;
  }

  update(delta: number, view: FlightRunView, boosting: boolean, reducedMotion: boolean): void {
    const config = this.config;
    if (!config) return;

    // The launch climbs out of the atmosphere: cross-fade the daylight palette
    // toward space as altitude builds. This is the whole point of the sequence,
    // so it is driven by progress rather than being a fixed backdrop.
    if (config.id === 'launch') {
      const climbed = Math.min(1, view.progress * 1.1);
      const leadIn = config.leadInSeconds ?? 0;
      // The camera swings from the pad shot to the flying shot over two
      // seconds either side of the handover, so control arriving is felt as a
      // move rather than announced by a cut.
      const swing = Math.max(0, Math.min(1, (view.seconds - leadIn) / HANDOVER_SECONDS));
      const padWeight = 1 - swing;

      // Flat opaque bands: the sky steps through solid colours as altitude
      // builds rather than blending, which is the stylisation asked for and
      // also makes the climb legible at a glance.
      const band = ascentBand(climbed);
      this.scene.background = new THREE.Color(band.color);
      this.scene.fog = null;
      this.groundMaterial.color.set(band.ground);

      this.sun.intensity = 4.6 - climbed * 2.2;
      this.hemi.intensity = 2.6 - climbed * 1.9;
      this.starMaterial.opacity = Math.max(0, (climbed - 0.55) * 2);
      this.stars.visible = climbed > 0.55;

      // Ground and pad exist only for the liftoff. Once the camera is looking
      // up the corridor there is deliberately nothing below — no horizon means
      // no cue that you are flying sideways.
      const drop = (1 - padWeight) * 90 + climbed * climbed * 300;
      this.ground.position.y = -6 - drop;
      this.ground.visible = padWeight > 0.02;
      this.padHost.position.y = -drop;
      this.padHost.visible = padWeight > 0.02;

      // Pitch the vehicle from standing on the pad to pointing up its own
      // line of travel. This is the gravity turn, and it is what stops the
      // rocket flying sideways through the sky.
      if (this.shipModel) {
        this.shipModel.rotation.x = -Math.PI / 2 + padWeight * (Math.PI / 2);
      }

      // The cloud deck is the first thing you fly through: thick as you leave
      // the pad, thinning to nothing by the time the debris arrives. It is
      // scenery, so it spreads far wider than the corridor and simply washes
      // over you rather than being something to avoid.
      // Nothing at ground level: the pad, gantry and desert have to read
      // cleanly before the deck arrives. It builds once you are climbing and
      // thins out again above the weather.
      const deck =
        climbed < 0.09 ? 0 : Math.max(0, Math.min(1, 1 - Math.abs(climbed - 0.26) / 0.19));
      this.cloudTint.set(band.color).lerp(WHITE, 0.72);
      this.clouds.update(delta, view.speed * 1.25, deck, this.cloudTint);

      this.chase.setLaunchFraming(padWeight);
    } else if (config.id === 'mars-descent') {
      this.chase.clearLaunchFraming();
      this.clouds.update(delta, view.speed, 0, this.cloudTint);
      // The surface rises to meet you.
      this.ground.position.y = -150 + view.progress * 142;
    }

    this.shipHost.position.set(view.shipX, view.shipY, 0);
    // Bank into the turn and pitch with vertical input.
    const bank = Math.max(-1, Math.min(1, view.shipVX * 0.055));
    this.shipHost.rotation.z = -bank * 0.55;
    this.shipHost.rotation.x = Math.max(-0.3, Math.min(0.3, -view.shipVY * 0.03));

    // A hit makes the hull flash and kicks the camera.
    if (this.shipModel) {
      this.shipModel.visible = !view.invulnerable || Math.floor(view.seconds * 18) % 2 === 0;
    }


    this.obstacles.syncFrom(view.bodies);

    // Stars drift very slowly so deep space still reads as motion.
    if (!reducedMotion) {
      this.stars.position.z = (view.seconds * view.speed * 0.05) % 200;
    }

    this.chase.update(delta, view, boosting, reducedMotion);
  }

  resize(aspect: number): void {
    this.chase.resize(aspect);
  }

  dispose(): void {
    this.obstacles.dispose();
    this.clouds.dispose();
    this.starMaterial.dispose();
    this.stars.geometry.dispose();
    this.groundMaterial.dispose();
    this.ground.geometry.dispose();
  }
}
