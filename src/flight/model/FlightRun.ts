/**
 * The arcade flight simulation.
 *
 * Pure and fixed-step: `step(dt, input)` must always be called with the same
 * dt, so the same seed and the same input source produce a bit-identical run in
 * Node and in the browser. That is what makes the headless autopilot harness
 * meaningful.
 *
 * Convention matches the rest of the game: the ship stays at the origin and the
 * world flows past it. Bodies travel toward +z and recycle when they pass the
 * camera, which keeps float precision bounded and makes pooling trivial.
 */

import { createSeededRandom } from '../../utils/random';
import { scoreFlight } from './scoring';
import type {
  FlightBody,
  FlightConfig,
  FlightInput,
  FlightRunResult,
  FlightRunView,
  FlightStats,
} from './types';

/** Collision radius of the ship itself. */
const SHIP_RADIUS = 0.55;

/**
 * Intangibility window after a hit, in seconds.
 *
 * Without this a single obstacle resting inside the sphere test registers a
 * hit on every one of the 120 steps per second it overlaps, and one clumsy
 * graze scores as a catastrophe.
 */
const INVULNERABLE_SECONDS = 1.1;

/** A body is counted as a graze inside this multiple of the touching distance. */
const GRAZE_FACTOR = 1.7;

/** Bodies further away than this in z are skipped by the collision test. */
const COLLISION_Z_WINDOW = 4;

/**
 * Exponent controlling how strongly obstacles cluster toward the corridor.
 * 1 is a uniform spread; higher pulls more of them into the middle.
 */
const SPREAD_BIAS = 1.25;

/** Map a 0-1 sample to -1..1, weighted toward zero. */
function biasedSpread(sample: number): number {
  const t = sample * 2 - 1;
  return Math.sign(t) * Math.abs(t) ** SPREAD_BIAS;
}

/** Where a body is recycled once it has passed the camera. */
const RECYCLE_Z = 14;

export class FlightRun {
  private readonly rng: () => number;
  private readonly bodies: FlightBody[] = [];

  private shipX = 0;
  private shipY = 0;
  private shipVX = 0;
  private shipVY = 0;

  private elapsed = 0;
  private distance = 0;
  private currentSpeed: number;
  private invulnerableFor = 0;
  private grazeCooldown = new Map<number, number>();

  private stats: FlightStats = {
    hits: 0,
    hitSeverity: 0,
    grazes: 0,
    offCorridorSeconds: 0,
    seconds: 0,
    completed: false,
  };

  private done = false;

  constructor(
    readonly config: FlightConfig,
    seed: number,
  ) {
    this.rng = createSeededRandom(seed);
    this.currentSpeed = config.speed;

    for (let i = 0; i < config.capacity; i += 1) {
      const body: FlightBody = {
        id: i,
        active: false,
        x: 0,
        y: 0,
        z: 0,
        r: 1,
        spinX: 0,
        spinY: 0,
        spinZ: 0,
        kind: 0,
      };
      this.bodies.push(body);
      // Stagger the initial field across the whole spawn depth so the corridor
      // is already populated on the first frame rather than filling in.
      this.respawn(body, -this.rng() * config.spawnDepth);
    }
  }

  private respawn(body: FlightBody, z: number): void {
    const c = this.config;
    body.active = true;
    body.z = z;
    body.r = c.radius[0] + this.rng() * (c.radius[1] - c.radius[0]);
    // Scatter across the full frame, but bias the distribution toward the
    // middle. A uniform spread fills the screen at the cost of emptying the
    // corridor, which makes flying well and flying badly score the same; this
    // keeps the threat where the player is while still filling the edges.
    const spread = c.spreadFactor ?? 1;
    body.x = biasedSpread(this.rng()) * (c.corridorX * spread + body.r * 0.6);
    body.y = biasedSpread(this.rng()) * (c.corridorY * spread + body.r * 0.4);
    body.spinX = (this.rng() - 0.5) * 1.4;
    body.spinY = (this.rng() - 0.5) * 1.6;
    body.spinZ = (this.rng() - 0.5) * 1.2;
    body.kind = Math.floor(this.rng() * 6);
    this.grazeCooldown.delete(body.id);
  }

  /** Advance one fixed step. */
  step(dt: number, input: FlightInput): void {
    if (this.done) return;

    const c = this.config;
    this.elapsed += dt;

    // --- scripted liftoff -------------------------------------------------
    // During the lead-in the player has no control and nothing is in the way:
    // the vehicle simply climbs off the pad. Input is discarded rather than
    // merely ignored downstream, so a player mashing keys through the cutscene
    // cannot bank the ship before they are meant to have it.
    const leadIn = c.leadInSeconds ?? 0;
    const cinematic = this.elapsed < leadIn;
    this.cinematic = cinematic;
    this.liftoff = leadIn > 0 ? Math.min(1, this.elapsed / leadIn) : 1;

    if (cinematic) {
      input = { x: 0, y: 0, boost: false, brake: false };
    }

    // --- speed -----------------------------------------------------------
    // Thrust builds from rest over the lead-in rather than starting at cruise.
    const cruise = c.speed + (input.boost ? c.boostSpeed : 0) - (input.brake ? c.speed * 0.3 : 0);
    const target = cinematic ? cruise * (0.12 + 0.88 * this.liftoff * this.liftoff) : cruise;
    this.currentSpeed += (target - this.currentSpeed) * (1 - Math.exp(-3 * dt));
    this.distance += this.currentSpeed * dt;

    // --- steering --------------------------------------------------------
    // Acceleration toward the input with drag, so the ship carries momentum
    // rather than snapping. Drag is exponential so it is frame-rate stable.
    this.shipVX += input.x * c.agility * dt;
    this.shipVY += input.y * c.agility * dt;
    const drag = Math.exp(-4.5 * dt);
    this.shipVX *= drag;
    this.shipVY *= drag;
    this.shipX += this.shipVX * dt;
    this.shipY += this.shipVY * dt;

    // --- soft corridor ---------------------------------------------------
    // A spring rather than a clamp: drifting out costs performance and pushes
    // back, but never yanks control away from the player.
    let offCorridor = false;
    this.driftX = 0;
    this.driftY = 0;
    if (Math.abs(this.shipX) > c.corridorX) {
      offCorridor = true;
      this.driftX = Math.sign(this.shipX);
      const overshoot = Math.abs(this.shipX) - c.corridorX;
      this.shipVX -= Math.sign(this.shipX) * overshoot * 16 * dt;
    }
    if (Math.abs(this.shipY) > c.corridorY) {
      offCorridor = true;
      this.driftY = Math.sign(this.shipY);
      const overshoot = Math.abs(this.shipY) - c.corridorY;
      this.shipVY -= Math.sign(this.shipY) * overshoot * 16 * dt;
    }
    if (offCorridor) this.stats.offCorridorSeconds += dt;
    this.offCorridor = offCorridor;

    // --- field -----------------------------------------------------------
    if (this.invulnerableFor > 0) this.invulnerableFor -= dt;

    // Nothing is in the way until the player has the controls. The field is
    // then seeded once, spread across the spawn depth, so the first obstacle
    // arrives a beat after handover rather than all of them at once.
    // Progress through the corridor, used to hold the field back while the
    // opening cloud deck plays.
    const progressNow = Math.min(1, this.elapsed / c.durationSeconds);
    const stillClear = progressNow < (c.clearUntil ?? 0);

    if (cinematic || stillClear) {
      for (const body of this.bodies) body.active = false;
    } else if (!this.fieldSeeded) {
      this.fieldSeeded = true;
      this.bodies.forEach((body, index) => {
        this.respawn(body, -c.spawnDepth * (0.25 + (0.75 * index) / this.bodies.length));
      });
    }

    for (const body of this.bodies) {
      if (!body.active) continue;
      body.z += this.currentSpeed * dt;
      if (body.z > RECYCLE_Z) {
        this.respawn(body, -c.spawnDepth + (body.z - RECYCLE_Z));
        continue;
      }
      this.testBody(body, dt);
    }

    // --- completion ------------------------------------------------------
    if (this.elapsed >= c.durationSeconds) {
      this.done = true;
      this.stats.completed = true;
      this.stats.seconds = this.elapsed;
    }
  }

  private offCorridor = false;
  private driftX = 0;
  private driftY = 0;
  private cinematic = false;
  private liftoff = 0;
  /** True once the corridor has been seeded at the end of the lead-in. */
  private fieldSeeded = false;

  private testBody(body: FlightBody, dt: number): void {
    // Only bodies near the ship's z-plane can touch it; this keeps the test at
    // a handful of comparisons per step without needing a spatial structure.
    if (Math.abs(body.z) > COLLISION_Z_WINDOW) return;

    const dx = body.x - this.shipX;
    const dy = body.y - this.shipY;
    const dz = body.z;
    const distanceSq = dx * dx + dy * dy + dz * dz;
    const touching = body.r + SHIP_RADIUS;

    if (distanceSq <= touching * touching) {
      if (this.invulnerableFor > 0) return;
      this.invulnerableFor = INVULNERABLE_SECONDS;
      this.stats.hits += 1;
      // Severity scales with how fast and how big — clipping a boulder at boost
      // should cost more than brushing a bolt while braking.
      this.stats.hitSeverity += (this.currentSpeed / this.config.speed) * body.r * 2.2;

      // Knock the ship off line so a hit is felt, not just counted.
      const push = 1 / Math.max(0.3, Math.sqrt(distanceSq));
      this.shipVX -= dx * push * 6;
      this.shipVY -= dy * push * 6;
      return;
    }

    // Graze: rewards threading gaps instead of flying the empty edges.
    const grazeRange = touching * GRAZE_FACTOR;
    if (distanceSq <= grazeRange * grazeRange) {
      const until = this.grazeCooldown.get(body.id) ?? 0;
      if (this.elapsed >= until) {
        this.stats.grazes += 1;
        this.grazeCooldown.set(body.id, this.elapsed + 1.2);
      }
    }
    void dt;
  }

  /** Abandon the run early. Scores whatever was achieved, marked incomplete. */
  abort(): void {
    if (this.done) return;
    this.done = true;
    this.stats.completed = false;
    this.stats.seconds = this.elapsed;
  }

  get finished(): boolean {
    return this.done;
  }

  get view(): FlightRunView {
    return {
      shipX: this.shipX,
      shipY: this.shipY,
      shipVX: this.shipVX,
      shipVY: this.shipVY,
      progress: Math.min(1, this.elapsed / this.config.durationSeconds),
      seconds: this.elapsed,
      speed: this.currentSpeed,
      bodies: this.bodies,
      hits: this.stats.hits,
      invulnerable: this.invulnerableFor > 0,
      offCorridor: this.offCorridor,
      driftX: this.driftX,
      driftY: this.driftY,
      cinematic: this.cinematic,
      liftoff: this.liftoff,
      finished: this.done,
    };
  }

  result(): FlightRunResult {
    return scoreFlight({ ...this.stats, seconds: this.elapsed }, this.config);
  }
}
