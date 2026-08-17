/**
 * Opening-build evaluator.
 *
 * Answers a player question the balance harness does not: what should you
 * actually buy at the yard? Each candidate build is bought in priority order
 * (purchases that cannot be afforded simply fail), then played to completion
 * across many seeds.
 *
 *   npx tsx tests/sim.openings.ts
 */

import { MarsTrailSim, STORE_ITEMS } from '../src/sim';
import type { BurnRate, ProfessionId, RationLevel } from '../src/sim';

interface Build {
  name: string;
  profession: ProfessionId;
  burn: BurnRate;
  rations: RationLevel;
  /** Bought in listed order; later entries lose out when credits run short. */
  order: Array<[string, number]>;
  /**
   * Model a player who re-reads the hold against the calendar and flexes the
   * ration dial, instead of setting it once at departure and never looking.
   */
  adaptiveRations?: boolean;
}

const BUILDS: Build[] = [
  {
    name: 'Financier — cores+food, ADAPTIVE rations',
    profession: 'financier',
    burn: 'standard',
    rations: 'meager',
    adaptiveRations: true,
    order: [
      ['driveCores', 5],
      ['heatShield', 1],
      ['rationsKg', 12],
      ['waterL', 8],
      ['radSuits', 2],
    ],
  },
  {
    name: 'Financier — same build, FIXED filling rations',
    profession: 'financier',
    burn: 'standard',
    rations: 'filling',
    order: [
      ['driveCores', 5],
      ['heatShield', 1],
      ['rationsKg', 12],
      ['waterL', 8],
      ['radSuits', 2],
    ],
  },
  {
    name: 'Financier — buys propellant instead of food',
    profession: 'financier',
    burn: 'standard',
    rations: 'meager',
    adaptiveRations: true,
    order: [
      ['driveCores', 4],
      ['heatShield', 1],
      ['propellantCells', 2],
      ['rationsKg', 6],
      ['waterL', 6],
      ['radSuits', 2],
    ],
  },
  {
    name: 'Engineer — cores+food, ADAPTIVE rations',
    profession: 'engineer',
    burn: 'standard',
    rations: 'meager',
    adaptiveRations: true,
    order: [
      ['driveCores', 4],
      ['heatShield', 1],
      ['rationsKg', 8],
      ['waterL', 6],
      ['radSuits', 2],
    ],
  },
  {
    name: 'Homesteader — cores+food, ADAPTIVE rations',
    profession: 'homesteader',
    burn: 'standard',
    rations: 'meager',
    adaptiveRations: true,
    order: [
      ['driveCores', 2],
      ['heatShield', 1],
      ['rationsKg', 3],
      ['waterL', 4],
    ],
  },
  {
    name: 'Financier — recommended opening',
    profession: 'financier',
    burn: 'standard',
    rations: 'filling',
    order: [
      ['driveCores', 4],
      ['heatShield', 1],
      ['commsArray', 1],
      ['coolantPumps', 1],
      ['hullPlates', 2],
      ['radSuits', 5],
      ['rationsKg', 10],
      ['waterL', 10],
      ['propellantCells', 2],
      ['rationsKg', 4],
    ],
  },
  {
    name: 'Financier — cores-heavy',
    profession: 'financier',
    burn: 'standard',
    rations: 'filling',
    order: [
      ['driveCores', 6],
      ['heatShield', 1],
      ['rationsKg', 8],
      ['waterL', 8],
      ['radSuits', 3],
      ['propellantCells', 1],
    ],
  },
  {
    name: 'Financier — food-heavy, no spares',
    profession: 'financier',
    burn: 'standard',
    rations: 'filling',
    order: [
      ['driveCores', 3],
      ['rationsKg', 18],
      ['waterL', 14],
      ['heatShield', 1],
    ],
  },
  {
    name: 'Engineer — recommended opening',
    profession: 'engineer',
    burn: 'standard',
    rations: 'meager',
    order: [
      ['driveCores', 4],
      ['heatShield', 1],
      ['commsArray', 1],
      ['hullPlates', 1],
      ['radSuits', 4],
      ['rationsKg', 8],
      ['waterL', 8],
      ['propellantCells', 1],
    ],
  },
  {
    name: 'Homesteader — recommended opening',
    profession: 'homesteader',
    burn: 'standard',
    rations: 'meager',
    order: [
      ['driveCores', 2],
      ['heatShield', 1],
      ['rationsKg', 4],
      ['waterL', 5],
      ['radSuits', 2],
    ],
  },
];

function priceOf(itemId: string): number {
  const item = STORE_ITEMS.find((entry) => entry.id === itemId);
  return item ? item.basePrice * item.step : 0;
}

function playBuild(build: Build, seed: number) {
  const sim = new MarsTrailSim(seed);
  sim.beginProfessionSelect();
  sim.chooseProfession(build.profession);
  sim.nameCrew([]);

  let unaffordable = 0;
  for (const [itemId, steps] of build.order) {
    for (let i = 0; i < steps; i += 1) {
      const before = sim.get().inventory.credits;
      sim.buy(itemId, false);
      if (sim.get().inventory.credits === before) unaffordable += 1;
    }
  }

  const outfit = {
    cores: sim.get().ship.driveCores,
    rations: Math.round(sim.get().inventory.rationsKg),
    water: Math.round(sim.get().inventory.waterL),
    cells: Math.floor(sim.get().inventory.propellantCells),
    suits: sim.get().inventory.radSuits,
    shield: sim.get().ship.heatShield,
    creditsLeft: Math.round(sim.get().inventory.credits),
    unaffordable,
  };

  sim.setBurnRate(build.burn);
  sim.setRations(build.rations);
  if (!sim.depart().ok) return { outcome: 'no-departure', survivors: 5, score: 0, days: 0, outfit };

  let guard = 0;
  while (sim.get().outcome === 'in-progress' && guard < 4000) {
    guard += 1;
    const state = sim.get();
    switch (state.phase) {
      case 'leg-select': {
        const leg = sim.leg();
        sim.chooseRoute((leg.routes.find((r) => r.hasStation) ?? leg.routes[0]).id);
        break;
      }
      case 'travel': {
        if (build.adaptiveRations) {
          // Budget the remaining hold against a realistic remaining duration.
          const alive = state.crew.filter((m) => m.alive).length || 1;
          const daysAhead = Math.max(1, Math.round(state.windowDaysLeft * 0.6));
          const fillingNeed = 2 * alive * daysAhead;
          if (state.inventory.rationsKg > fillingNeed) sim.setRations('filling');
          else if (state.inventory.rationsKg > fillingNeed * 0.55) sim.setRations('meager');
          else sim.setRations('bare');
        }

        const needsCamp = state.crew.some(
          (m) => m.alive && (m.hygiene < 35 || m.energy < 30 || m.morale < 35),
        );
        // Servicing the cores before they fail is the single highest-value
        // camp action; without it a run reliably ends adrift.
        const coresWearing = state.ship.driveCoreWear.some((w) => w > 55);
        if (
          (needsCamp || coresWearing || (state.ship.hullIntegrity < 70 && state.ship.hullPlates > 0)) &&
          state.windowDaysLeft > 60
        ) {
          sim.makeCamp();
        } else {
          sim.step();
        }
        break;
      }
      case 'event':
        sim.chooseEventOption(state.activeEvent?.choices[0]?.id ?? '');
        break;
      case 'hazard': {
        const options = sim.hazardOptions();
        const pick =
          options.find((o) => o.id === 'escort' && o.available) ??
          options.find((o) => o.id === 'creep' && o.available) ??
          options.find((o) => o.id === 'hold' && o.available) ??
          options[0];
        sim.resolveHazard(pick.id);
        if (sim.get().outcome === 'in-progress') sim.leaveWaypoint();
        break;
      }
      case 'station':
        if (state.inventory.rationsKg < 700) sim.buy('rationsKg', true);
        if (state.ship.heatShield < 2) sim.buy('heatShield', true);
        if (state.ship.hullIntegrity < 75) sim.stationService('hull-repair');
        if (state.crew.some((m) => m.alive && m.illness !== 'none')) sim.stationService('medical');
        sim.leaveWaypoint();
        break;
      case 'harvest':
        sim.harvest(0.55);
        sim.leaveWaypoint();
        break;
      case 'camp': {
        const alive = state.crew.filter((m) => m.alive);
        const worstHygiene = Math.min(...alive.map((m) => m.hygiene));
        let option = 'hydroponics';
        if (state.ship.driveCoreWear.some((w) => w > 55)) option = 'maintenance';
        else if (state.ship.hullIntegrity < 70 && state.ship.hullPlates > 0) option = 'hull-patch';
        else if (worstHygiene < 45 && state.inventory.waterL >= 60) option = 'hygiene';
        sim.campOption(option);
        sim.leaveWaypoint();
        break;
      }
      default:
        guard = 4000;
        break;
    }
  }

  const final = sim.get();
  return {
    outcome: final.outcome,
    survivors: final.crew.filter((m) => m.alive).length,
    score: sim.score().total,
    days: final.day,
    outfit,
  };
}

const RUNS = 40;
console.log('THE MARS TRAIL — opening build evaluator\n');
console.log('Yard prices per purchase step:');
for (const item of STORE_ITEMS) {
  console.log(`  ${item.name.padEnd(20)} ${String(item.step).padStart(4)} ${item.unit.padEnd(6)} = ${priceOf(item.id)} cr`);
}
console.log('');

for (const build of BUILDS) {
  const results = Array.from({ length: RUNS }, (_, i) => playBuild(build, 1000 + i * 977));
  const arrived = results.filter((r) => r.outcome === 'arrived');
  const o = results[0].outfit;

  console.log(`── ${build.name}  (${build.burn}, ${build.rations})`);
  console.log(
    `   leaves with   ${o.cores} cores · ${o.rations} kg · ${o.water} L · ${o.cells} cells · ${o.suits} suits · ${o.shield} shield · ${o.creditsLeft} cr spare`,
  );
  if (o.unaffordable > 0) console.log(`   NOTE          ${o.unaffordable} purchase(s) could not be afforded`);
  console.log(`   arrives       ${arrived.length}/${RUNS}  (${Math.round((arrived.length / RUNS) * 100)}%)`);
  const byOutcome = new Map<string, number>();
  for (const r of results) byOutcome.set(r.outcome, (byOutcome.get(r.outcome) ?? 0) + 1);
  const lost = [...byOutcome.entries()].filter(([k]) => k !== 'arrived');
  if (lost.length) console.log(`   lost to       ${lost.map(([k, n]) => `${k} x${n}`).join(', ')}`);
  console.log(
    `   avg survivors ${(results.reduce((s, r) => s + r.survivors, 0) / RUNS).toFixed(1)}/5   avg score ${Math.round(results.reduce((s, r) => s + r.score, 0) / RUNS)}`,
  );
  if (arrived.length) console.log(`   arrival day   ${Math.round(arrived.reduce((s, r) => s + r.days, 0) / arrived.length)}`);
  console.log('');
}
