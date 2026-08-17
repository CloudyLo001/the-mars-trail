import { expect, test } from '@playwright/test';
import { PNG } from 'pngjs';

type CanvasSample = {
  ok: boolean;
  reason: string;
  variance?: number;
  colorBuckets?: number;
};

async function sampleCanvas(page: import('@playwright/test').Page): Promise<CanvasSample> {
  const canvas = page.locator('#game-canvas');
  const box = await canvas.boundingBox();
  if (!box || box.width < 32 || box.height < 32) {
    return { ok: false, reason: 'canvas-too-small' };
  }

  const buffer = await canvas.screenshot();
  const png = PNG.sync.read(buffer);
  let min = 255;
  let max = 0;
  let alphaPixels = 0;
  const buckets = new Set<string>();
  const stride = Math.max(1, Math.floor((png.width * png.height) / 4096));

  for (let pixel = 0; pixel < png.width * png.height; pixel += stride) {
    const offset = pixel * 4;
    const r = png.data[offset];
    const g = png.data[offset + 1];
    const b = png.data[offset + 2];
    const a = png.data[offset + 3];
    min = Math.min(min, r, g, b);
    max = Math.max(max, r, g, b);
    if (a > 0) alphaPixels += 1;
    buckets.add(`${r >> 4},${g >> 4},${b >> 4},${a >> 6}`);
  }

  const variance = max - min;
  return {
    ok: alphaPixels > 256 && (variance > 8 || buckets.size > 3),
    reason: 'sampled',
    variance,
    colorBuckets: buckets.size,
  };
}

async function bootGame(page: import('@playwright/test').Page) {
  await page.goto('/');
  await expect(page.locator('#game-canvas')).toBeVisible();
  await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10);
}

test('renders a nonblank canvas through the low-resolution pixel pipeline', async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await bootGame(page);

  const sample = await sampleCanvas(page);
  expect(sample, JSON.stringify(sample)).toMatchObject({ ok: true });

  // The pipeline must actually be rendering small and upscaling; a full-res
  // buffer would mean the pixel look silently regressed to plain 3D.
  const pipeline = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.pipeline);
  expect(pipeline?.internalHeight).toBe(270);
  expect(pipeline?.internalWidth).toBeLessThanOrEqual(768);

  const screenshot = await page.screenshot({ fullPage: false });
  await testInfo.attach(`${testInfo.project.name}-title`, {
    body: screenshot,
    contentType: 'image/png',
  });

  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('advances the mission and progresses toward the next waypoint', async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await bootGame(page);

  // Jump straight into a viable travelling ship rather than replaying setup.
  await page.evaluate(() => {
    window.__THREE_GAME_TEST_HOOKS__?.seed(4242);
    window.__THREE_GAME_TEST_HOOKS__?.setState('active-play');
  });

  await expect(page.locator('#hud')).toBeVisible();
  await expect(page.locator('#ticker-name')).not.toHaveText('—');

  const before = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.mission.day ?? 0);

  // Advance several days. Any of them may raise a modal, which is itself
  // progress, so the assertion is on the mission clock rather than the button.
  for (let i = 0; i < 6; i += 1) {
    const advance = page.locator('#btn-advance');
    if (await advance.isEnabled()) {
      await advance.click();
      await page.waitForTimeout(90);
    }
  }

  const after = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.mission.day ?? 0);
  expect(after).toBeGreaterThan(before);

  const distance = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.mission.kmTotal ?? 0);
  expect(distance).toBeGreaterThan(0);

  const screenshot = await page.screenshot({ fullPage: false });
  await testInfo.attach(`${testInfo.project.name}-travel`, {
    body: screenshot,
    contentType: 'image/png',
  });

  expect(pageErrors).toEqual([]);
});

test('renders the monochrome retro filter', async ({ page }, testInfo) => {
  await bootGame(page);

  await page.evaluate(() => {
    window.__THREE_GAME_TEST_HOOKS__?.seed(7);
    window.__THREE_GAME_TEST_HOOKS__?.setState('deep-space');
    window.__THREE_GAME_TEST_HOOKS__?.setReducedMotion(true);
    window.__THREE_GAME_TEST_HOOKS__?.setPhosphor(true);
  });
  await page.waitForTimeout(250);

  const phosphor = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.pipeline.phosphor);
  expect(phosphor).toBe(true);

  const sample = await sampleCanvas(page);
  expect(sample, JSON.stringify(sample)).toMatchObject({ ok: true });

  const screenshot = await page.screenshot({ fullPage: false });
  await testInfo.attach(`${testInfo.project.name}-retro-filter`, {
    body: screenshot,
    contentType: 'image/png',
  });
});

test('shows how-to-play on the home page and opens the full briefing', async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await bootGame(page);

  // The primer is on the home page itself, not behind a click.
  await expect(page.locator('.howto-heading')).toHaveText(/how to play/i);
  await expect(page.locator('.howto-card')).toHaveCount(3);
  await expect(page.locator('.howto-footnote')).toContainText('Ares Basin');

  const home = await page.screenshot({ fullPage: false });
  await testInfo.attach(`${testInfo.project.name}-home-howto`, {
    body: home,
    contentType: 'image/png',
  });

  await page.getByRole('button', { name: /full briefing/i }).click();
  await expect(page.locator('.tutorial-heading').first()).toBeVisible();
  // Every authored briefing section must actually render.
  await expect(page.locator('.tutorial-section')).toHaveCount(6);
  await expect(page.locator('.card-title')).toHaveText(/how to play/i);

  const briefing = await page.screenshot({ fullPage: false });
  await testInfo.attach(`${testInfo.project.name}-briefing`, {
    body: briefing,
    contentType: 'image/png',
  });

  // Closing returns to the home page rather than starting a run.
  await page.getByRole('button', { name: /got it/i }).click();
  await expect(page.locator('.title-mark')).toBeVisible();
  await expect(page.locator('.howto-card')).toHaveCount(3);

  expect(pageErrors).toEqual([]);
});

test('reopens the briefing from the travel HUD', async ({ page }) => {
  await bootGame(page);

  await page.evaluate(() => {
    window.__THREE_GAME_TEST_HOOKS__?.seed(99);
    window.__THREE_GAME_TEST_HOOKS__?.setState('active-play');
  });

  await expect(page.locator('#hud')).toBeVisible();
  await page.locator('#btn-help').click();
  await expect(page.locator('.tutorial-section').first()).toBeVisible();

  // Dismissing must return to travel, not to the title screen.
  await page.getByRole('button', { name: /got it/i }).click();
  await expect(page.locator('#overlay')).toBeHidden();
  const phase = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.phase);
  expect(phase).toBe('travel');
});

test('buys and sells back stock in the yard requisition', async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await bootGame(page);

  await page.getByRole('button', { name: /begin the crossing/i }).click();
  await page.getByRole('button', { name: /ship's engineer/i }).click();
  await page.getByRole('button', { name: /to the outfitters/i }).click();

  await expect(page.locator('.card-title')).toHaveText(/yard requisition/i);

  const coreRow = page.locator('.store-row').filter({ hasText: 'Drive Cores' });
  const buy = coreRow.getByRole('button', { name: /^Buy /i });
  const sell = coreRow.getByRole('button', { name: /^Sell back /i });
  const owned = coreRow.locator('.store-owned');

  // Engineer starts with 800 credits and no cores.
  await expect(sell).toBeDisabled();
  await expect(owned).toHaveText('0 core');

  await buy.click();
  await buy.click();
  await expect(owned).toHaveText('2 core');
  await expect(sell).toBeEnabled();

  // The credit arithmetic itself is asserted exactly in tests/sim.store.ts;
  // this spec is here to prove the stepper is wired to it.
  await sell.click();
  await expect(owned).toHaveText('1 core');
  await sell.click();
  await expect(owned).toHaveText('0 core');
  await expect(sell).toBeDisabled();

  const store = await page.screenshot({ fullPage: false });
  await testInfo.attach(`${testInfo.project.name}-yard-store`, {
    body: store,
    contentType: 'image/png',
  });

  expect(pageErrors).toEqual([]);
});

test('keeps scroll position while shopping', async ({ page }) => {
  await bootGame(page);

  await page.getByRole('button', { name: /begin the crossing/i }).click();
  await page.getByRole('button', { name: /corporate financier/i }).click();
  await page.getByRole('button', { name: /to the outfitters/i }).click();
  await expect(page.locator('.card-title')).toHaveText(/yard requisition/i);

  // Either the overlay or the card can be the scrolling container depending on
  // content height, so drive and measure whichever one actually scrolls.
  const scrollToBottom = () =>
    page.evaluate(() => {
      const overlay = document.querySelector<HTMLElement>('#overlay')!;
      const card = document.querySelector<HTMLElement>('.overlay-card')!;
      overlay.scrollTop = overlay.scrollHeight;
      card.scrollTop = card.scrollHeight;
      return { overlay: overlay.scrollTop, card: card.scrollTop };
    });
  const readScroll = () =>
    page.evaluate(() => ({
      overlay: document.querySelector<HTMLElement>('#overlay')!.scrollTop,
      card: document.querySelector<HTMLElement>('.overlay-card')!.scrollTop,
    }));

  const before = await scrollToBottom();
  expect(
    Math.max(before.overlay, before.card),
    'the store must be tall enough to scroll',
  ).toBeGreaterThan(40);

  const row = page.locator('.store-row').filter({ hasText: 'Hull Plates' });
  await row.getByRole('button', { name: /^Buy /i }).click();

  // The panel is rebuilt on every purchase; the view must not jump to the top.
  const after = await readScroll();
  expect(
    Math.abs(Math.max(after.overlay, after.card) - Math.max(before.overlay, before.card)),
    `scroll moved ${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
  ).toBeLessThan(8);

  // Focus should survive the rebuild too, so repeat clicks stay on the same row.
  const focusedAction = await page.evaluate(
    () => (document.activeElement as HTMLElement | null)?.dataset.actionId,
  );
  expect(focusedAction).toBe('buy:hullPlates');
});

test('adjusts pixelation from display settings', async ({ page }) => {
  await bootGame(page);

  // Classic is the default and must stay so.
  expect(await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.pipeline.internalHeight)).toBe(
    270,
  );

  await page.locator('#btn-settings').click();
  await expect(page.locator('.card-title')).toHaveText(/settings/i);

  await page.getByRole('button', { name: /^HD/i }).click();
  await expect
    .poll(async () =>
      page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.pipeline.internalHeight),
    )
    .toBe(540);

  await page.getByRole('button', { name: /^Chunky/i }).click();
  await expect
    .poll(async () =>
      page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.pipeline.internalHeight),
    )
    .toBe(180);

  // Buffer width must track the new height rather than staying at the old cap.
  const buffer = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.pipeline);
  expect(buffer!.internalWidth).toBeGreaterThan(180);
  expect(buffer!.internalWidth).toBeLessThan(180 * 3);

  // The choice must survive a reload.
  await page.reload();
  await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 5);
  expect(await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.pipeline.internalHeight)).toBe(
    180,
  );

  // Leave storage clean for the other specs.
  await page.evaluate(() => localStorage.clear());
});

test('reaches a terminal score screen', async ({ page }) => {
  await bootGame(page);

  await page.evaluate(() => {
    window.__THREE_GAME_TEST_HOOKS__?.seed(11);
    window.__THREE_GAME_TEST_HOOKS__?.setState('complete');
  });

  await expect(page.locator('.score-total')).toBeVisible();
  const outcome = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.outcome);
  expect(outcome).toBe('arrived');
});
