/**
 * Browser coverage for the playable flight sequences.
 *
 * The headless harness already proves the model. This proves the wiring: that a
 * sequence takes over the screen, responds to real input, renders, and hands a
 * result back to the simulation.
 */

import { expect, test } from '@playwright/test';
import { PNG } from 'pngjs';

type Page = import('@playwright/test').Page;

async function bootGame(page: Page) {
  await page.goto('/');
  await expect(page.locator('#game-canvas')).toBeVisible();
  await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10);
}

async function canvasIsLive(page: Page): Promise<boolean> {
  const buffer = await page.locator('#game-canvas').screenshot();
  const png = PNG.sync.read(buffer);
  const buckets = new Set<string>();
  const stride = Math.max(1, Math.floor((png.width * png.height) / 4096));
  for (let pixel = 0; pixel < png.width * png.height; pixel += stride) {
    const o = pixel * 4;
    buckets.add(`${png.data[o] >> 4},${png.data[o + 1] >> 4},${png.data[o + 2] >> 4}`);
  }
  return buckets.size > 3;
}

test('the crossing begins on Earth with a playable ascent', async ({ page }, testInfo) => {
  // Each store click rebuilds the whole panel; under a software rasterizer a
  // full outfit is slow, so buy only what the departure gate requires.
  test.setTimeout(240_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await bootGame(page);

  // Outfit a viable ship and leave the yard.
  await page.getByRole('button', { name: /begin the crossing/i }).click();
  await page.getByRole('button', { name: /corporate financier/i }).click();
  await page.getByRole('button', { name: /to the outfitters/i }).click();

  const buy = async (item: string, times: number) => {
    const row = page.locator('.store-row').filter({ hasText: item });
    for (let i = 0; i < times; i += 1) await row.getByRole('button', { name: /^Buy /i }).click();
  };
  // The departure gate needs two cores, 100 kg of rations, and 100 L of water.
  await buy('Drive Cores', 2);
  await buy('Rations', 2);
  await buy('Water', 1);

  await page.getByRole('button', { name: /leave the yard/i }).click();

  // Departing must drop straight into the ascent, not the star chart.
  await expect(page.locator('#flight-hud')).toBeVisible();
  await expect(page.locator('#hud')).toBeHidden();
  await expect(page.locator('#overlay')).toBeHidden();
  await expect(page.locator('#flight-title')).toHaveText(/ascent/i);

  const snapshot = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.flightSnapshot());
  expect(snapshot?.active).toBe(true);
  expect(snapshot?.sequence).toBe('launch');

  expect(await canvasIsLive(page), 'the launch scene must render').toBe(true);

  const shot = await page.screenshot({ fullPage: false });
  await testInfo.attach(`${testInfo.project.name}-launch`, { body: shot, contentType: 'image/png' });

  expect(pageErrors).toEqual([]);
});

test('the liftoff is scripted, then control hands over', async ({ page }) => {
  test.setTimeout(240_000);
  await bootGame(page);
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.startFlight('launch', 2091));
  await expect(page.locator('#flight-hud')).toBeVisible();

  // During the scripted liftoff the player has no control at all.
  const beforeX = (await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.flightSnapshot()))
    ?.shipX;
  await page.keyboard.down('KeyD');
  await page.waitForTimeout(1500);
  const duringX = (await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.flightSnapshot()))
    ?.shipX;
  await page.keyboard.up('KeyD');
  expect(
    Math.abs(duringX! - beforeX!),
    `ship must not steer during the cutscene (${beforeX} -> ${duringX})`,
  ).toBeLessThan(0.05);

  // Once the lead-in elapses, the same input must move the ship.
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.flightSnapshot()))?.cinematic,
      { timeout: 90_000, intervals: [500] },
    )
    .toBe(false);

  const handoverX = (await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.flightSnapshot()))
    ?.shipX;
  await page.keyboard.down('KeyD');
  await page.waitForTimeout(1200);
  await page.keyboard.up('KeyD');
  const afterX = (await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.flightSnapshot()))
    ?.shipX;
  expect(afterX!, `ship should steer after handover (${handoverX} -> ${afterX})`).toBeGreaterThan(
    handoverX! + 0.3,
  );
});

test('the ship responds to real keyboard input', async ({ page }) => {
  await bootGame(page);
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.startFlight('kessler', 4242));
  await expect(page.locator('#flight-hud')).toBeVisible();

  const startX = (await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.flightSnapshot()))
    ?.shipX;

  // Hold right for long enough that the smoothing ramp cannot hide the result.
  await page.keyboard.down('KeyD');
  await page.waitForTimeout(700);
  await page.keyboard.up('KeyD');

  const movedX = (await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.flightSnapshot()))
    ?.shipX;

  expect(movedX!, `ship moved ${startX} -> ${movedX}`).toBeGreaterThan(startX! + 0.3);

  // And the other way.
  await page.keyboard.down('KeyA');
  await page.waitForTimeout(700);
  await page.keyboard.up('KeyA');
  const backX = (await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.flightSnapshot()))
    ?.shipX;
  expect(backX!).toBeLessThan(movedX!);
});

test('a flown hazard resolves through the simulation', async ({ page }) => {
  // A corridor is ~30 s of simulated time, and the fixed-step loop advances at
  // roughly half real time under a software rasterizer, so this needs headroom.
  test.setTimeout(300_000);
  await bootGame(page);

  await page.evaluate(() => {
    window.__THREE_GAME_TEST_HOOKS__?.seed(31);
    window.__THREE_GAME_TEST_HOOKS__?.startFlight('kessler', 77);
    // Fly it well, without needing a human.
    window.__THREE_GAME_TEST_HOOKS__?.setFlightAutopilot(0.95);
  });

  await expect(page.locator('#flight-hud')).toBeVisible();

  // The corridor is 30 s of simulated time but advances well under real time
  // on a software rasterizer, so this waits generously. It also watches
  // progress rather than only the finished flag, so a genuinely stalled run
  // fails with a useful message instead of an anonymous timeout.
  let lastProgress = -1;
  let stalledPolls = 0;
  await expect
    .poll(
      async () => {
        const snap = await page.evaluate(() =>
          window.__THREE_GAME_TEST_HOOKS__?.flightSnapshot(),
        );
        const progress = snap?.progress ?? 0;
        if (progress <= lastProgress) stalledPolls += 1;
        else stalledPolls = 0;
        lastProgress = progress;
        expect(
          stalledPolls,
          `flight stopped advancing at progress ${progress.toFixed(3)}`,
        ).toBeLessThan(8);
        return snap?.active;
      },
      { timeout: 420_000, intervals: [1000] },
    )
    .toBe(false);

  // The turn-based scene must be restored and the HUD handed back.
  await expect(page.locator('#flight-hud')).toBeHidden();
  const diagnostics = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__);
  expect(diagnostics?.flight.active).toBe(false);
});

test('escape abandons a sequence and returns control', async ({ page }) => {
  await bootGame(page);
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.startFlight('asteroid-fringe', 5));
  await expect(page.locator('#flight-hud')).toBeVisible();

  await page.keyboard.press('Escape');

  await expect
    .poll(async () =>
      page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.flight.active),
    )
    .toBe(false);
  await expect(page.locator('#flight-hud')).toBeHidden();
});
