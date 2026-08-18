/**
 * THE MARS TRAIL — flight model types.
 *
 * `src/flight/model` is pure TypeScript with no Three.js and no DOM, exactly
 * like `src/sim`. That is what lets a whole flight be replayed headlessly at a
 * fixed timestep and asserted on, and it is what keeps the renderer a dumb
 * observer rather than a second owner of gameplay state.
 */

export type FlightSequenceId = 'launch' | 'kessler' | 'asteroid-fringe' | 'mars-descent';

/** Normalised player intent for a single step. */
export interface FlightInput {
  /** Lateral steering, -1 (left) to 1 (right). */
  x: number;
  /** Vertical steering, -1 (down) to 1 (up). */
  y: number;
  boost: boolean;
  brake: boolean;
}

export const NEUTRAL_INPUT: FlightInput = { x: 0, y: 0, boost: false, brake: false };

/**
 * One obstacle. Plain numbers so the whole field can be stepped, serialised,
 * and compared without touching a scene graph.
 */
export interface FlightBody {
  id: number;
  active: boolean;
  x: number;
  y: number;
  z: number;
  /** Collision radius, also used to scale the rendered clone. */
  r: number;
  spinX: number;
  spinY: number;
  spinZ: number;
  /** Index into the sequence's asset family, so the renderer knows what to draw. */
  kind: number;
}

export interface FlightConfig {
  id: FlightSequenceId;
  title: string;
  /** Shown on the pre-flight card. */
  brief: string;
  /** Scene palette key, reused from src/scene/palettes.ts. */
  sceneKey: string;
  /** Which loaded prop family the obstacles are drawn from. */
  family: 'debris' | 'asteroid' | 'launch' | 'mars-surface';
  /** How long the corridor lasts, in seconds. Includes the lead-in. */
  durationSeconds: number;
  /**
   * Opening seconds during which the player has no control and no obstacles
   * spawn: the scripted liftoff. Zero for sequences that start mid-flight.
   */
  leadInSeconds?: number;
  /** Forward speed in world units per second. */
  speed: number;
  /** Extra speed available on boost. */
  boostSpeed: number;
  /** How far ahead bodies spawn. */
  spawnDepth: number;
  /** Fixed pool size. Never allocates mid-run. */
  capacity: number;
  /** Obstacle radius range. */
  radius: [number, number];
  /** Soft corridor half-extents. */
  corridorX: number;
  corridorY: number;
  /** How much accumulated hit severity equals a total loss of performance. */
  hitBudget: number;
  /** Lateral acceleration. Higher is twitchier. */
  agility: number;
}

/** Read-only view the renderer and the autopilot both consume. */
export interface FlightRunView {
  shipX: number;
  shipY: number;
  shipVX: number;
  shipVY: number;
  /** 0-1 through the corridor. */
  progress: number;
  seconds: number;
  speed: number;
  bodies: readonly FlightBody[];
  hits: number;
  /** True while the ship is intangible after a hit. */
  invulnerable: boolean;
  /** True while outside the soft corridor bounds. */
  offCorridor: boolean;
  /** True during the scripted opening, before control hands over. */
  cinematic: boolean;
  /** 0-1 through the scripted opening. 1 once the player has control. */
  liftoff: number;
  finished: boolean;
}

export interface FlightStats {
  hits: number;
  hitSeverity: number;
  /** Near-misses. Rewards flying tight rather than hugging the corridor edge. */
  grazes: number;
  offCorridorSeconds: number;
  seconds: number;
  completed: boolean;
}

export interface FlightRunResult {
  sequence: FlightSequenceId;
  completed: boolean;
  /**
   * The single 0-1 scalar the simulation consumes. This is the entire seam
   * between real-time flying and the turn-based rules.
   */
  performance: number;
  hits: number;
  grazes: number;
  offCorridorSeconds: number;
  seconds: number;
}

/** Anything that can drive a flight: the player, or a scripted autopilot. */
export interface FlightInputSource {
  sample(delta: number, view: FlightRunView): FlightInput;
}
