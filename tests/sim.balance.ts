/**
 * Headless balance harness for THE MARS TRAIL.
 *
 * Plays complete missions across seeds and strategies with no browser, and
 * reports the outcome spread. This is the gate that proves the attrition model
 * is actually beatable-but-punishing rather than a coin flip or a walkover.
 *
 *   npx tsx tests/sim.balance.ts
 */

import { MarsTrailSim } from '../src/sim';
import { STORE_ITEMS } from '../src/sim/content';
import type { BurnRate, ProfessionId, RationLevel } from '../src/sim/types';

interface Strategy {
  name: string;
  profession: ProfessionId;
  burn: BurnRate;
  rations: RationLevel;
  /** Outfitting plan: item id -> number of purchase steps. */
  buy: Record<string, number>;
  /** Preferred hazard option, falling back down the list when unaffordable. */
  hazardPreference: Array<'escort' | 'creep' | 'hold' | 'burn' | 'fly'>;
  /** Take station services when affordable. */
  useStations: boolean;
}

const STRATEGIES: Strategy[] = [
  {
    name: 'Financier / cautious',
    profession: 'financier',
    burn: 'standard',
    rations: 'filling',
    buy: { driveCores: 5, rationsKg: 14, waterL: 12, propellantCells: 6, radSuits: 5, coolantPumps: 2, heatShield: 2, commsArray: 1, hullPlates: 2 },
    hazardPreference: ['escort', 'creep', 'hold', 'fly', 'burn'],
    useStations: true,
  },
  {
    name: 'Engineer / over-cautious',
    profession: 'engineer',
    burn: 'standard',
    rations: 'meager',
    buy: { driveCores: 4, rationsKg: 12, waterL: 10, propellantCells: 5, radSuits: 4, coolantPumps: 2, heatShield: 2, commsArray: 1, hullPlates: 1 },
    hazardPreference: ['creep', 'escort', 'hold', 'fly', 'burn'],
    useStations: true,
  },
  {
    name: 'Homesteader / desperate',
    profession: 'homesteader',
    burn: 'hard',
    rations: 'bare',
    buy: { driveCores: 3, rationsKg: 5, waterL: 6, propellantCells: 3, radSuits: 1, heatShield: 1 },
    hazardPreference: ['burn', 'fly', 'creep', 'hold', 'escort'],
    useStations: false,
  },
  {
    name: 'Reckless / hard burn',
    profession: 'financier',
    burn: 'hard',
    rations: 'bare',
    buy: { driveCores: 2, rationsKg: 6, waterL: 6, propellantCells: 2, radSuits: 0, heatShield: 1 },
    hazardPreference: ['burn', 'fly'],
    useStations: false,
  },
];

interface RunOutcome {
  /** True when the run never reached a terminal outcome — a state-machine stall. */
  stalled: boolean;
  outcome: string;
  days: number;
  survivors: number;
  score: number;
  finalLeg: number;
  note: string;
  causes: string[];
}

function playRun(strategy: Strategy, seed: number): RunOutcome {
  const sim = new MarsTrailSim(seed);
  sim.beginProfessionSelect();
  sim.chooseProfession(strategy.profession);
  sim.nameCrew([]);

  for (const [itemId, steps] of Object.entries(strategy.buy)) {
    for (let i = 0; i < steps; i += 1) sim.buy(itemId, false);
  }

  sim.setBurnRate(strategy.burn);
  sim.setRations(strategy.rations);

  const departure = sim.depart();
  if (!departure.ok) {
    return {
      outcome: 'no-departure',
      stalled: false,
      days: 0,
      survivors: 5,
      score: 0,
      finalLeg: 0,
      note: departure.reason ?? '',
      causes: [],
    };
  }

  // Hard iteration cap; a healthy run resolves in a few hundred steps.
  // Hitting it means the state machine can stall, so it is a reported failure
  // rather than a silent early exit.
  const GUARD_LIMIT = 4000;
  let guard = 0;
  while (sim.get().outcome === 'in-progress' && guard < GUARD_LIMIT) {
    guard += 1;
    const state = sim.get();

    switch (state.phase) {
      case 'leg-select': {
        const leg = sim.leg();
        // Prefer the station route when playing safe, the short one otherwise.
        const route = strategy.useStations
          ? (leg.routes.find((r) => r.hasStation) ?? leg.routes[0])
          : leg.routes.reduce((a, b) => (a.distanceMultiplier <= b.distanceMultiplier ? a : b));
        sim.chooseRoute(route.id);
        break;
      }
      case 'travel': {
        // Real players flex rations against how much food is aboard.
        const daysLeftEstimate = Math.max(1, Math.round(state.windowDaysLeft * 0.6));
        const perDayFilling = 2 * state.crew.filter((m) => m.alive).length;
        if (state.inventory.rationsKg > perDayFilling * daysLeftEstimate) {
          sim.setRations('filling');
        } else if (state.inventory.rationsKg > perDayFilling * daysLeftEstimate * 0.55) {
          sim.setRations('meager');
        } else {
          sim.setRations(strategy.rations);
        }

        const needsCamp =
          state.crew.some((m) => m.alive && (m.hygiene < 35 || m.energy < 30 || m.morale < 35)) ||
          (state.ship.hullIntegrity < 70 && state.ship.hullPlates > 0);
        // Only camp when the calendar can absorb it.
        if (needsCamp && state.windowDaysLeft > 60) sim.makeCamp();
        else sim.step();
        break;
      }
      case 'event': {
        const event = state.activeEvent;
        if (!event) break;
        // Always take the first available option, which is the "act" option.
        sim.chooseEventOption(event.choices[0]?.id ?? '');
        break;
      }
      case 'hazard': {
        const options = sim.hazardOptions();
        // Fall back to whatever the waypoint actually offers, since `burn` is
        // replaced by `fly` at flyable waypoints.
        let picked = options.find((o) => o.id === 'burn') ?? options[0];
        for (const preference of strategy.hazardPreference) {
          const match = options.find((o) => o.id === preference && o.available);
          if (match) {
            picked = match;
            break;
          }
        }
        sim.resolveHazard(picked?.id ?? 'burn');
        if (sim.get().outcome === 'in-progress') sim.leaveWaypoint();
        break;
      }
      case 'station': {
        if (strategy.useStations) {
          // Top up food and water, then buy a repair if it is clearly needed.
          const rations = STORE_ITEMS.find((i) => i.id === 'rationsKg');
          const water = STORE_ITEMS.find((i) => i.id === 'waterL');
          if (rations && state.inventory.rationsKg < 700) sim.buy('rationsKg', true);
          if (water && state.inventory.waterL < 600) sim.buy('waterL', true);
          if (state.ship.hullPlates < 2) sim.buy('hullPlates', true);
          // The heat shield is the one thing you cannot arrive without.
          if (state.ship.heatShield < 2) sim.buy('heatShield', true);
          if (state.crew.some((m) => m.alive && m.morale < 45)) sim.stationService('shore-leave');
          if (state.ship.hullIntegrity < 75) sim.stationService('hull-repair');
          if (state.crew.some((m) => m.alive && m.illness !== 'none')) sim.stationService('medical');
        }
        sim.leaveWaypoint();
        break;
      }
      case 'harvest':
        // Simulate a middling player at the aiming minigame.
        sim.harvest(0.55);
        sim.leaveWaypoint();
        break;
      case 'camp': {
        const worstHygiene = Math.min(...state.crew.filter((m) => m.alive).map((m) => m.hygiene));
        const worstEnergy = Math.min(...state.crew.filter((m) => m.alive).map((m) => m.energy));
        let option = 'hydroponics';
        if (state.ship.hullIntegrity < 70 && state.ship.hullPlates > 0) option = 'hull-patch';
        else if (worstHygiene < 45 && state.inventory.waterL >= 60) option = 'hygiene';
        else if (worstEnergy < 35) option = 'rest';
        else if (state.ship.driveCoreWear.some((w) => w > 55)) option = 'maintenance';
        sim.campOption(option);
        sim.leaveWaypoint();
        break;
      }
      default:
        // Terminal phase reached through a nested resolution.
        guard = GUARD_LIMIT;
        break;
    }
  }

  const finalState = sim.get();
  const report = sim.score();
  return {
    stalled: finalState.outcome === 'in-progress',
    outcome: finalState.outcome,
    days: finalState.day,
    survivors: finalState.crew.filter((m) => m.alive).length,
    score: report.total,
    finalLeg: finalState.legIndex + 1,
    note: report.rating,
    causes: finalState.crew.filter((m) => !m.alive).map((m) => m.causeOfDeath ?? 'unknown'),
  };
}

const RUNS_PER_STRATEGY = 40;
let failures = 0;

console.log('THE MARS TRAIL — balance harness');
console.log(`${RUNS_PER_STRATEGY} runs per strategy\n`);

for (const strategy of STRATEGIES) {
  const results: RunOutcome[] = [];
  for (let i = 0; i < RUNS_PER_STRATEGY; i += 1) {
    results.push(playRun(strategy, 1000 + i * 977));
  }

  const arrived = results.filter((r) => r.outcome === 'arrived');
  const lostCrew = results.filter((r) => r.outcome === 'lost-crew');
  const windowClosed = results.filter((r) => r.outcome === 'window-closed');
  const adrift = results.filter((r) => r.outcome === 'adrift');
  const noDeparture = results.filter((r) => r.outcome === 'no-departure');

  const causeCounts = new Map<string, number>();
  for (const result of results) {
    for (const cause of result.causes) {
      causeCounts.set(cause, (causeCounts.get(cause) ?? 0) + 1);
    }
  }
  const topCauses = [...causeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([cause, n]) => `${cause} x${n}`)
    .join(', ');

  const avg = (values: number[]) =>
    values.length === 0 ? 0 : Math.round(values.reduce((a, b) => a + b, 0) / values.length);

  console.log(`── ${strategy.name}`);
  console.log(`   arrived        ${arrived.length}/${results.length}`);
  console.log(`   lost crew      ${lostCrew.length}`);
  console.log(`   window closed  ${windowClosed.length}`);
  console.log(`   adrift         ${adrift.length}`);
  const stalled = results.filter((r) => r.stalled).length;
  if (stalled > 0) {
    console.error(`   STALLED        ${stalled} run(s) never reached a terminal outcome`);
    failures += 1;
  }
  if (noDeparture.length > 0) {
    console.log(`   NO DEPARTURE   ${noDeparture.length}  (${noDeparture[0].note})`);
    failures += 1;
  }
  console.log(`   avg days       ${avg(results.map((r) => r.days))}`);
  console.log(`   avg survivors  ${(results.reduce((a, b) => a + b.survivors, 0) / results.length).toFixed(1)}/5`);
  console.log(`   avg score      ${avg(results.map((r) => r.score))}`);
  console.log(`   avg leg reached ${(results.reduce((a, b) => a + b.finalLeg, 0) / results.length).toFixed(1)}/5`);
  if (arrived.length > 0) {
    console.log(`   arrival days   ${avg(arrived.map((r) => r.days))}`);
  }
  if (topCauses) console.log(`   top causes     ${topCauses}`);
  console.log('');
}

// Balance assertions: the cautious build should usually make it, and the
// reckless build should usually not. If either flips, the model is broken.
const cautious = Array.from({ length: RUNS_PER_STRATEGY }, (_, i) =>
  playRun(STRATEGIES[0], 1000 + i * 977),
);
const reckless = Array.from({ length: RUNS_PER_STRATEGY }, (_, i) =>
  playRun(STRATEGIES[3], 1000 + i * 977),
);

const cautiousRate = cautious.filter((r) => r.outcome === 'arrived').length / RUNS_PER_STRATEGY;
const recklessRate = reckless.filter((r) => r.outcome === 'arrived').length / RUNS_PER_STRATEGY;

console.log('── assertions');
console.log(`   cautious arrival rate  ${(cautiousRate * 100).toFixed(0)}%  (want 55-95%)`);
console.log(`   reckless arrival rate  ${(recklessRate * 100).toFixed(0)}%  (want 0-40%)`);

if (cautiousRate < 0.55 || cautiousRate > 0.95) {
  console.error('   FAIL cautious arrival rate outside target band');
  failures += 1;
}
if (recklessRate > 0.4) {
  console.error('   FAIL reckless play is too survivable');
  failures += 1;
}
if (cautiousRate <= recklessRate) {
  console.error('   FAIL preparation does not beat recklessness');
  failures += 1;
}

if (failures > 0) {
  console.error(`\n${failures} balance check(s) failed.`);
  process.exit(1);
}
console.log('\nAll balance checks passed.');
