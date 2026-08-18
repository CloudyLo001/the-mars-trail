/**
 * Turns a flown corridor into the single 0-1 scalar the simulation consumes.
 *
 * The shape matters more than the constants: it has to be continuous, so that
 * flying slightly better is always slightly better, rather than only mattering
 * at the two grade thresholds.
 */

import type { FlightConfig, FlightRunResult, FlightStats } from './types';

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** Multiplier applied when a run is abandoned rather than completed. */
const ABORT_PENALTY = 0.35;

export function scoreFlight(stats: FlightStats, config: FlightConfig): FlightRunResult {
  const damage = stats.hitSeverity / config.hitBudget;
  const drift = stats.offCorridorSeconds * 0.06;

  // Grazes are reported but deliberately NOT scored. They were originally a
  // bonus for threading gaps tightly, but the headless harness showed the
  // opposite: undisciplined pilots wander near more obstacles and so collected
  // more of them, which inverted the skill signal the score exists to measure.
  let performance = clamp01(1 - damage - drift);
  if (!stats.completed) performance *= ABORT_PENALTY;

  return {
    sequence: config.id,
    completed: stats.completed,
    performance,
    hits: stats.hits,
    grazes: stats.grazes,
    offCorridorSeconds: stats.offCorridorSeconds,
    seconds: stats.seconds,
  };
}
