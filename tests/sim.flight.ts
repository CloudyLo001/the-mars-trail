/**
 * How flight performance feeds the simulation.
 *
 * The flight model harness proves that flying better scores better. This proves
 * the other half: that a better score actually produces a better outcome, and
 * that the option cannot be gamed.
 *
 *   npx tsx tests/sim.flight.ts
 */

import { MarsTrailSim, flightGrade, flightSequenceFor, hazardOptions } from '../src/sim';
import { createSeededRandom } from '../src/utils/random';
import { resolveHazard } from '../src/sim/hazards';
import { LEGS } from '../src/sim/content';

let failures = 0;

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
}

function primed(leg = 1) {
  const sim = new MarsTrailSim(4242);
  sim.beginProfessionSelect();
  sim.chooseProfession('financier');
  sim.nameCrew([]);
  sim.primeForTravel(leg);
  return sim;
}

console.log('THE MARS TRAIL — flight integration checks\n');

// ---- which waypoints are flyable ----------------------------------------
{
  const flyable = LEGS.flatMap((leg) => leg.waypoints).filter(
    (wp) => flightSequenceFor(wp.id) !== null,
  );
  check('exactly four waypoints are flyable', flyable.length === 4, String(flyable.length));
  check(
    'the finale is one of them',
    flyable.some((wp) => wp.kind === 'finale'),
  );
  const pureCards = ['van-allen', 'flare-corridor', 'cosmic-deep', 'orbital-insertion'];
  for (const id of pureCards) {
    check(`${id} stays a decision card`, flightSequenceFor(id) === null);
  }
}

// ---- the option table ----------------------------------------------------
{
  const sim = primed(1);
  const kessler = LEGS[1].waypoints.find((wp) => wp.id === 'kessler-belt')!;
  const options = hazardOptions(sim.get(), kessler);

  check('fly is offered at a flyable waypoint', options.some((o) => o.id === 'fly'));
  check('burn is omitted there, not merely disabled', !options.some((o) => o.id === 'burn'));
  check('fly is listed first', options[0]?.id === 'fly', options[0]?.id);
  check('fly costs propellant', (options[0]?.propellantCells ?? 0) > 0);

  const vanAllen = LEGS[0].waypoints.find((wp) => wp.id === 'van-allen')!;
  const plain = hazardOptions(sim.get(), vanAllen);
  check('burn survives at a non-flyable waypoint', plain.some((o) => o.id === 'burn'));
  check('fly is absent there', !plain.some((o) => o.id === 'fly'));
}

// ---- grading -------------------------------------------------------------
{
  check('a clean flight grades clean', flightGrade(0.9) === 'clean');
  check('a scrappy flight grades setback', flightGrade(0.45) === 'setback');
  check('a botched flight grades disaster', flightGrade(0.1) === 'disaster');

  // Monotonic: performance must never grade worse as it improves.
  const order = { disaster: 0, setback: 1, clean: 2 };
  let previous = -1;
  let monotonic = true;
  for (let p = 0; p <= 1.0001; p += 0.05) {
    const value = order[flightGrade(Math.min(1, p))];
    if (value < previous) monotonic = false;
    previous = value;
  }
  check('grade never worsens as performance rises', monotonic);
}

// ---- performance actually changes the outcome ---------------------------
{
  const kessler = LEGS[1].waypoints.find((wp) => wp.id === 'kessler-belt')!;
  const grades = (performance: number | undefined) => {
    const counts = { clean: 0, setback: 0, disaster: 0 };
    for (let seed = 0; seed < 40; seed += 1) {
      const sim = primed(1);
      const rng = createSeededRandom(seed * 7919 + 3);
      const result = resolveHazard(sim.get(), kessler, 'fly', rng, performance);
      counts[result.grade] += 1;
    }
    return counts;
  };

  const ace = grades(0.9);
  const poor = grades(0.15);
  const undef = grades(undefined);

  console.log(`  ace  ${JSON.stringify(ace)}`);
  console.log(`  poor ${JSON.stringify(poor)}`);
  console.log(`  dice ${JSON.stringify(undef)}`);

  check('flying well is always clean', ace.clean === 40, JSON.stringify(ace));
  check('flying badly is always a disaster', poor.disaster === 40, JSON.stringify(poor));
  check(
    'undefined performance falls back to the dice',
    undef.clean > 0 && undef.clean < 40,
    JSON.stringify(undef),
  );
}

// ---- the unknown-option hole --------------------------------------------
{
  const kessler = LEGS[1].waypoints.find((wp) => wp.id === 'kessler-belt')!;
  const counts = { clean: 0, setback: 0, disaster: 0 };
  for (let seed = 0; seed < 40; seed += 1) {
    const sim = primed(1);
    const rng = createSeededRandom(seed * 104729 + 11);
    // 'burn' no longer exists at this waypoint. An older caller asking for it
    // must not be handed a free clean transit.
    counts[resolveHazard(sim.get(), kessler, 'burn', rng).grade] += 1;
  }
  check(
    'a removed option is not a free pass',
    counts.clean < 40,
    JSON.stringify(counts),
  );
}

if (failures > 0) {
  console.error(`\n${failures} flight integration check(s) failed.`);
  process.exit(1);
}
console.log('\nAll flight integration checks passed.');
