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

test('the ascent always reaches orbit, however badly it is flown', async ({ page }) => {
  test.setTimeout(240_000);
  await bootGame(page);

  // This has to go through the real departure path: the raw startFlight hook
  // skips the launch's own outcome handling, which is the thing under test.
  await page.getByRole('button', { name: /begin the crossing/i }).click();
  await page.getByRole('button', { name: /corporate financier/i }).click();
  await page.getByRole('button', { name: /to the outfitters/i }).click();
  const buy = async (item: string, times: number) => {
    const row = page.locator('.store-row').filter({ hasText: item });
    for (let i = 0; i < times; i += 1) await row.getByRole('button', { name: /^Buy /i }).click();
  };
  await buy('Drive Cores', 2);
  await buy('Rations', 2);
  await buy('Water', 1);
  await page.getByRole('button', { name: /leave the yard/i }).click();

  await expect(page.locator('#flight-hud')).toBeVisible();

  // Fly it as badly as the harness can. The ascent must still hand the player
  // to the crossing rather than bouncing them back to the pad.
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setFlightAutopilot(0.02));
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.fastForwardFlight(75));

  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.flightSnapshot()))?.active,
      { timeout: 30_000, intervals: [250] },
    )
    .toBe(false);

  await expect(page.locator('.card-title')).toHaveText(/orbit achieved/i);

  // And it leads into the crossing rather than another ascent.
  await page.getByRole('button', { name: /continue|onward|proceed|▸/i }).first().click();
  await expect
    .poll(async () => page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.phase))
    .toBe('leg-select');
});

test('the ship responds to real keyboard input', async ({ page }) => {
  // Booting plus a corridor of ~48 cloned models renders slowly without a GPU.
  test.setTimeout(240_000);
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
  test.setTimeout(180_000);
  await bootGame(page);

  await page.evaluate(() => {
    window.__THREE_GAME_TEST_HOOKS__?.seed(31);
    window.__THREE_GAME_TEST_HOOKS__?.startFlight('kessler', 77);
    // Fly it well, without needing a human.
    window.__THREE_GAME_TEST_HOOKS__?.setFlightAutopilot(0.95);
  });

  await expect(page.locator('#flight-hud')).toBeVisible();

  // Let it render a little in real time first, so this still covers the live
  // update path, then fast-forward the rest rather than waiting minutes.
  await page.waitForTimeout(1500);
  const midway = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.flightSnapshot());
  expect(midway?.progress ?? 0, 'the flight must advance while rendering').toBeGreaterThan(0);

  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.fastForwardFlight(45));

  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.flightSnapshot()))?.active,
      { timeout: 30_000, intervals: [250] },
    )
    .toBe(false);

  // The turn-based scene must be restored and the HUD handed back.
  await expect(page.locator('#flight-hud')).toBeHidden();
  const diagnostics = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__);
  expect(diagnostics?.flight.active).toBe(false);
});

test('escape abandons a sequence and returns control', async ({ page }) => {
  test.setTimeout(240_000);
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
