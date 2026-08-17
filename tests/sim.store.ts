/**
 * Focused checks for the outfitting and station store, including sell-back.
 *
 * Money bugs are the easiest kind to ship and the hardest to notice, so these
 * assert the exact credit arithmetic rather than just that the buttons work.
 *
 *   npx tsx tests/sim.store.ts
 */

import { MarsTrailSim, STATION_REFUND_RATE, ownedCount } from '../src/sim';

let failures = 0;

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function freshSim(): MarsTrailSim {
  const sim = new MarsTrailSim(7);
  sim.beginProfessionSelect();
  sim.chooseProfession('financier');
  sim.nameCrew([]);
  return sim;
}

console.log('THE MARS TRAIL — store checks\n');

// ---- Yard: buying then selling back must be exactly reversible ------------
{
  const sim = freshSim();
  const start = sim.get().inventory.credits;

  sim.buy('driveCores', false);
  sim.buy('driveCores', false);
  sim.buy('rationsKg', false);
  const afterBuy = sim.get().inventory.credits;
  check('yard purchase deducts credits', afterBuy < start, `${start} -> ${afterBuy}`);

  sim.refund('driveCores', false);
  sim.refund('driveCores', false);
  sim.refund('rationsKg', false);
  const afterRefund = sim.get().inventory.credits;

  check(
    'yard sell-back is fully reversible',
    Math.abs(afterRefund - start) < 0.001,
    `${start} -> ${afterBuy} -> ${afterRefund}`,
  );
  check('yard sell-back removes the goods', sim.get().ship.driveCores === 0);
  check(
    'rations return to the starting amount',
    Math.abs(ownedCount(sim.get(), 'rationsKg') - 0) < 0.001,
    String(ownedCount(sim.get(), 'rationsKg')),
  );
}

// ---- Nothing to sell back ------------------------------------------------
{
  const sim = freshSim();
  const start = sim.get().inventory.credits;
  check('cannot refund an empty hold', !sim.canRefund('heatShield', false));
  sim.refund('heatShield', false);
  check('a refused refund pays nothing', sim.get().inventory.credits === start);
  check('a refused refund cannot go negative', sim.get().ship.heatShield === 0);
}

// ---- Partial step ---------------------------------------------------------
{
  const sim = freshSim();
  sim.buy('rationsKg', false); // +100 kg, the full step
  // Spend most of it so a full step is no longer available to sell back.
  sim.get().inventory.rationsKg = 40;
  const before = sim.get().inventory.credits;
  sim.refund('rationsKg', false);

  check('partial hold sells back what is there', ownedCount(sim.get(), 'rationsKg') === 0);
  const paid = sim.get().inventory.credits - before;
  // 40 kg at the yard price of 0.30 per kg.
  check('partial refund is proportional', Math.abs(paid - 12) < 0.01, `paid ${paid}`);
}

// ---- Station: sell-back is a loss, never an arbitrage -------------------
{
  const sim = freshSim();
  sim.primeForTravel(1);
  const state = sim.get();

  const before = state.inventory.credits;
  const coresBefore = state.ship.driveCores;
  sim.refund('driveCores', true);
  const gained = sim.get().inventory.credits - before;

  check('station sell-back removes a core', sim.get().ship.driveCores === coresBefore - 1);
  check('station sell-back pays something', gained > 0, `gained ${gained}`);

  // The critical property: selling back must cost less than rebuying, or a
  // player could farm credits off the station markup forever.
  const rebuyCost = sim.get().inventory.credits;
  sim.buy('driveCores', true);
  const spent = rebuyCost - sim.get().inventory.credits;
  check('station buy/sell round trip loses money', spent > gained, `gained ${gained}, spent ${spent}`);
  check(
    'station refund rate is applied',
    Math.abs(gained / spent - STATION_REFUND_RATE) < 0.02,
    `ratio ${(gained / spent).toFixed(3)}`,
  );
}

// ---- Station: the ship must stay flyable ---------------------------------
{
  const sim = freshSim();
  sim.primeForTravel(1);
  sim.get().ship.driveCores = 2;
  sim.get().ship.driveCoreWear = [10, 20];

  check('cannot sell below two cores underway', !sim.canRefund('driveCores', true));
  const before = sim.get().inventory.credits;
  sim.refund('driveCores', true);
  check('the floor is enforced', sim.get().ship.driveCores === 2);
  check('a blocked core sale pays nothing', sim.get().inventory.credits === before);
}

// ---- Core wear bookkeeping stays consistent ------------------------------
{
  const sim = freshSim();
  for (let i = 0; i < 4; i += 1) sim.buy('driveCores', false);
  sim.get().ship.driveCoreWear = [80, 10, 60, 30];

  sim.refund('driveCores', false);
  const state = sim.get();
  check(
    'wear array length tracks the core count',
    state.ship.driveCoreWear.length === state.ship.driveCores,
    `${state.ship.driveCoreWear.length} vs ${state.ship.driveCores}`,
  );
  check(
    'the most worn core is the one sold',
    !state.ship.driveCoreWear.includes(80),
    JSON.stringify(state.ship.driveCoreWear),
  );
}

if (failures > 0) {
  console.error(`\n${failures} store check(s) failed.`);
  process.exit(1);
}
console.log('\nAll store checks passed.');
