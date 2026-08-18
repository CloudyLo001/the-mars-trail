/**
 * Headless harness for the flight model.
 *
 * Replays whole corridors at a fixed timestep with scripted pilots. The
 * assertion that matters is monotonicity: flying better must score better, or
 * the entire feature is decoration.
 *
 *   npx tsx tests/flight.model.ts
 */

import { FlightRun } from '../src/flight/model/FlightRun';
import { createAutopilot } from '../src/flight/model/autopilot';
import { SEQUENCES } from '../src/flight/model/sequences';
import type { FlightRunResult, FlightSequenceId } from '../src/flight/model/types';
import { createSeededRandom } from '../src/utils/random';

const STEP = 1 / 120;
const SEEDS = 24;

const SKILLS: Array<[string, number]> = [
  ['ace', 0.95],
  ['good', 0.7],
  ['sloppy', 0.35],
  ['drunk', 0.05],
];

let failures = 0;

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) return;
  failures += 1;
  console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
}

function fly(sequence: FlightSequenceId, skill: number, seed: number): FlightRunResult {
  const config = SEQUENCES[sequence];
  const run = new FlightRun(config, seed);
  const pilot = createAutopilot({ skill }, createSeededRandom(seed ^ 0x5f3a), config);

  let guard = 0;
  const maxSteps = Math.ceil((config.durationSeconds + 5) / STEP);
  while (!run.finished && guard < maxSteps) {
    guard += 1;
    run.step(STEP, pilot.sample(STEP, run.view));
  }
  return run.result();
}

console.log('THE MARS TRAIL — flight model harness\n');

const sequenceIds = Object.keys(SEQUENCES) as FlightSequenceId[];

for (const sequence of sequenceIds) {
  console.log(`── ${SEQUENCES[sequence].title}  (${sequence})`);
  const means: Array<[string, number]> = [];

  for (const [name, skill] of SKILLS) {
    const results = Array.from({ length: SEEDS }, (_, i) => fly(sequence, skill, 4000 + i * 131));

    const mean = results.reduce((s, r) => s + r.performance, 0) / results.length;
    const hits = results.reduce((s, r) => s + r.hits, 0) / results.length;
    means.push([name, mean]);

    console.log(
      `   ${name.padEnd(7)} performance ${mean.toFixed(3)}   hits ${hits.toFixed(1)}   ` +
        `grazes ${(results.reduce((s, r) => s + r.grazes, 0) / results.length).toFixed(1)}`,
    );

    // Every run must terminate and produce a legal scalar.
    for (const r of results) {
      check(`${sequence}/${name} completes`, r.completed, `seconds ${r.seconds.toFixed(1)}`);
      check(
        `${sequence}/${name} performance in range`,
        r.performance >= 0 && r.performance <= 1,
        String(r.performance),
      );
    }
  }

  // The load-bearing assertion: skill must order outcomes. Compared across
  // non-adjacent tiers — ace and good are close enough that seed noise can
  // legitimately invert them, and asserting otherwise would just be flaky.
  const byName = new Map(means);
  const ace = byName.get('ace')!;
  const good = byName.get('good')!;
  const sloppy = byName.get('sloppy')!;
  const drunk = byName.get('drunk')!;

  check(`${sequence}: ace beats sloppy`, ace > sloppy, `${ace.toFixed(3)} vs ${sloppy.toFixed(3)}`);
  check(`${sequence}: good beats drunk`, good > drunk, `${good.toFixed(3)} vs ${drunk.toFixed(3)}`);
  check(`${sequence}: sloppy beats drunk`, sloppy > drunk, `${sloppy.toFixed(3)} vs ${drunk.toFixed(3)}`);

  // The launch is deliberately forgiving — it is the player's first contact
  // with the controls — so it is held to a lower bar than the hazards.
  const minSpread = sequence === 'launch' ? 0.08 : 0.25;
  check(
    `${sequence}: skill spread is meaningful`,
    ace - drunk > minSpread,
    `spread ${(ace - drunk).toFixed(3)}, want > ${minSpread}`,
  );

  // A competent pilot should clear a hazard well, or nobody will ever choose
  // to fly instead of paying for a tug.
  check(`${sequence}: a good pilot scores well`, good > 0.55, `${good.toFixed(3)}`);

  console.log('');
}

// Determinism: the same seed and pilot must replay identically.
{
  const a = fly('kessler', 0.7, 99);
  const b = fly('kessler', 0.7, 99);
  check(
    'same seed replays identically',
    a.performance === b.performance && a.hits === b.hits && a.grazes === b.grazes,
    `${JSON.stringify(a)} vs ${JSON.stringify(b)}`,
  );
}

// Abandoning a run must be capped hard enough that quitting can never beat
// flying a hazard competently. Comparing one aborted run against one completed
// run would only compare their seeds, so assert the ceiling directly: no
// abandoned flight, however clean up to that point, can exceed the penalty.
{
  const config = SEQUENCES.kessler;
  for (const seed of [7, 21, 84]) {
    const run = new FlightRun(config, seed);
    const pilot = createAutopilot({ skill: 0.95 }, createSeededRandom(seed), config);
    for (let i = 0; i < 600; i += 1) run.step(STEP, pilot.sample(STEP, run.view));
    run.abort();
    const aborted = run.result();
    check(`abort seed ${seed} is capped`, aborted.performance <= 0.35, String(aborted.performance));
    check(`abort seed ${seed} is marked incomplete`, !aborted.completed);
  }
}

if (failures > 0) {
  console.error(`\n${failures} flight model check(s) failed.`);
  process.exit(1);
}
console.log('All flight model checks passed.');
