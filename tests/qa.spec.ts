/**
 * Full-playthrough QA for THE MARS TRAIL.
 *
 * Drives the real UI from the title screen to a terminal score screen, clicking
 * only what a player could click. The central assertion is that the game is
 * never a dead end: every state reached must offer at least one enabled action.
 * Along the way it asserts the rules the game claims to enforce.
 */

import { expect, test } from '@playwright/test';
import { PNG } from 'pngjs';

type Page = import('@playwright/test').Page;

async function bootGame(page: Page) {
  await page.goto('/');
  await expect(page.locator('#game-canvas')).toBeVisible();
  await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10);
}

/** Mean luminance of the rendered canvas, 0-255. */
async function canvasLuminance(page: Page): Promise<number> {
  const buffer = await page.locator('#game-canvas').screenshot();
  const png = PNG.sync.read(buffer);
  let total = 0;
  let count = 0;
  const stride = Math.max(1, Math.floor((png.width * png.height) / 8192));
  for (let pixel = 0; pixel < png.width * png.height; pixel += stride) {
    const o = pixel * 4;
    total += 0.2126 * png.data[o] + 0.7152 * png.data[o + 1] + 0.0722 * png.data[o + 2];
    count += 1;
  }
  return total / Math.max(1, count);
}

/**
 * Bounded UI sweep.
 *
 * A whole crossing is ~270 in-game days and each day is a real click, which runs
 * at about a second per step under a software rasterizer — far too slow to drive
 * to completion in a browser. So this proves the half a browser is needed for:
 * the interface is navigable, never dead-ends, and never breaks a game rule.
 * That runs terminate at all is proven far more cheaply by the headless
 * harness in tests/sim.balance.ts, which plays 160 complete missions.
 */
test('sweeps the UI without dead ends or rule violations', async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  const MAX_STEPS = 220;

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await bootGame(page);
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.seed(31337));

  // --- Setup ------------------------------------------------------------
  await page.getByRole('button', { name: /begin the crossing/i }).click();
  await page.getByRole('button', { name: /corporate financier/i }).click();
  await page.getByRole('button', { name: /to the outfitters/i }).click();
  await expect(page.locator('.card-title')).toHaveText(/yard requisition/i);

  // Rule: the yard must refuse an unflyable ship.
  await page.getByRole('button', { name: /leave the yard/i }).click();
  await expect(page.locator('.store-warning')).toContainText(/two drive cores/i);
  expect(await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.phase)).toBe('outfitting');

  // The tested opening build.
  const buyStep = async (item: string, times: number) => {
    const row = page.locator('.store-row').filter({ hasText: item });
    for (let i = 0; i < times; i += 1) await row.getByRole('button', { name: /^Buy /i }).click();
  };
  await buyStep('Drive Cores', 5);
  await buyStep('Heat-Shield Tiles', 1);
  await buyStep('Rations', 12);
  await buyStep('Water', 8);
  await buyStep('Rad Suits', 2);

  await page.getByRole('button', { name: /leave the yard/i }).click();
  await expect(page.locator('.card-title')).toContainText(/earth departure/i);

  // --- Playthrough ------------------------------------------------------
  const visitedPhases = new Set<string>();
  let deadEnds = 0;
  let lastDay = 0;
  let lastWindow = Number.POSITIVE_INFINITY;
  let ruleViolations: string[] = [];
  let steps = 0;

  while (steps < MAX_STEPS) {
    steps += 1;

    // One round trip per step instead of four: diagnostics, overlay visibility,
    // and the enabled-action count all come back together.
    const snapshot = await page.evaluate(() => {
      const overlay = document.querySelector<HTMLElement>('#overlay');
      const visible = Boolean(overlay && !overlay.hidden);
      return {
        d: window.__THREE_GAME_DIAGNOSTICS__,
        overlayVisible: visible,
        enabled: visible
          ? overlay!.querySelectorAll('button:not([disabled])').length
          : 0,
      };
    });

    const d = snapshot.d;
    if (!d) break;
    visitedPhases.add(d.phase);

    // Rules that must hold at every single step of a run.
    if (d.mission.day < lastDay) ruleViolations.push(`day went backwards: ${lastDay} -> ${d.mission.day}`);
    if (d.mission.windowDaysLeft > lastWindow)
      ruleViolations.push(`window grew: ${lastWindow} -> ${d.mission.windowDaysLeft}`);
    if (d.mission.rationsKg < 0) ruleViolations.push(`negative rations: ${d.mission.rationsKg}`);
    if (d.mission.driveCores < 0) ruleViolations.push(`negative cores: ${d.mission.driveCores}`);
    if (d.mission.livingCrew < 0 || d.mission.livingCrew > 5)
      ruleViolations.push(`impossible crew count: ${d.mission.livingCrew}`);
    lastDay = d.mission.day;
    lastWindow = d.mission.windowDaysLeft;

    if (d.outcome !== 'in-progress') break;

    // Prefer the travel HUD when it is live; otherwise take an overlay action.
    if (!snapshot.overlayVisible) {
      const advance = page.locator('#btn-advance');
      if (await advance.isEnabled()) {
        await advance.click();
        continue;
      }
      deadEnds += 1;
      break;
    }

    // Any enabled button inside the overlay counts as a way forward.
    const count = snapshot.enabled;
    if (count === 0) {
      deadEnds += 1;
      const title = await page.locator('.card-title').textContent();
      ruleViolations.push(`dead end on card "${title}" in phase ${d.phase}`);
      break;
    }

    // Pick the last enabled button: the "continue / leave / resume" action sits
    // at the end of every card, which keeps the run moving rather than looping
    // on a store row.
    await page.locator('#overlay button:not([disabled])').nth(count - 1).click();
  }

  const final = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__);

  const shot = await page.screenshot({ fullPage: false });
  await testInfo.attach(`${testInfo.project.name}-final-state`, {
    body: shot,
    contentType: 'image/png',
  });

  console.log('QA UI sweep:', {
    steps,
    outcome: final?.outcome,
    day: final?.mission.day,
    leg: final?.mission.leg,
    survivors: final?.mission.livingCrew,
    driveCores: final?.mission.driveCores,
    phasesVisited: [...visitedPhases].sort().join(', '),
  });

  expect(ruleViolations, ruleViolations.join(' | ')).toEqual([]);
  expect(deadEnds, 'the run hit a state with no enabled action').toBe(0);

  // Real forward progress, not a UI that merely refuses to break.
  expect(final?.mission.day ?? 0).toBeGreaterThan(30);
  expect(visitedPhases.size, `only saw: ${[...visitedPhases].join(', ')}`).toBeGreaterThan(2);

  // If the sweep did happen to finish a run, the score screen must be up.
  if (final?.outcome !== 'in-progress') {
    expect(await page.locator('.score-total').isVisible()).toBe(true);
  }

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('the ship travels the way its drive cores lead', async ({ page }) => {
  await bootGame(page);
  await page.evaluate(() => {
    window.__THREE_GAME_TEST_HOOKS__?.seed(5);
    window.__THREE_GAME_TEST_HOOKS__?.setState('active-play');
  });

  const before = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.pipeline.scrollX ?? 0);
  await page.waitForTimeout(700);
  const after = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.pipeline.scrollX ?? 0);

  // The world must scroll toward +x. The hull sits right of centre with its
  // drive cores to the left and its exhaust plumes to the right, so a world
  // moving +x reads as the ship travelling left — cores leading, plumes
  // trailing. Scrolling the other way flew the ship backwards.
  expect(after, `scrollX ${before} -> ${after}`).toBeGreaterThan(before);
});

test('scene brightness is in a readable band across every leg', async ({ page }, testInfo) => {
  await bootGame(page);

  const legs: Array<[string, string]> = [
    ['active-play', 'earth-orbit'],
    ['deep-space', 'deep-quiet'],
    ['mars-approach', 'mars-approach'],
  ];

  const readings: Record<string, number> = {};

  for (const [state, label] of legs) {
    await page.evaluate((s) => {
      window.__THREE_GAME_TEST_HOOKS__?.seed(12);
      window.__THREE_GAME_TEST_HOOKS__?.setState(s);
      window.__THREE_GAME_TEST_HOOKS__?.setReducedMotion(true);
    }, state);
    // Let the palette cross-fade settle before sampling.
    await page.waitForTimeout(2600);

    const luma = await canvasLuminance(page);
    readings[label] = Math.round(luma);

    const shot = await page.locator('#game-canvas').screenshot();
    await testInfo.attach(`${testInfo.project.name}-${label}`, {
      body: shot,
      contentType: 'image/png',
    });
  }

  console.log('mean canvas luminance (0-255):', readings);

  // Floor: below this the scene reads as an unlit black frame, which is the
  // problem this band exists to catch. Ceiling: the posterised look depends on
  // real shadow, so a washed-out frame is a regression too.
  for (const [label, value] of Object.entries(readings)) {
    expect(value, `${label} luminance ${value}`).toBeGreaterThan(28);
    expect(value, `${label} luminance ${value}`).toBeLessThan(190);
  }
});
