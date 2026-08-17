/**
 * Captures every ending the game can reach.
 *
 * Each case plays a complete run through the real simulation commands under a
 * named policy, then screenshots the score screen the player would see. No
 * outcome is written directly — the bot has to actually lose (or win) the run.
 */

import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OUT_DIR = path.resolve('endings');

type Page = import('@playwright/test').Page;

async function bootGame(page: Page) {
  await page.goto('/');
  await expect(page.locator('#game-canvas')).toBeVisible();
  await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10);
  // Hide the settings button so the captures show only the game.
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.hideDebugUi(true));
}

interface Case {
  style: string;
  seed: number;
  file: string;
  /** Outcomes this policy is allowed to produce. */
  expected: string[];
}

const CASES: Case[] = [
  { style: 'careful', seed: 1977, file: '1-arrived', expected: ['arrived'] },
  { style: 'reckless', seed: 4242, file: '2-adrift', expected: ['adrift'] },
  { style: 'starve', seed: 8123, file: '3-lost-crew', expected: ['lost-crew', 'adrift'] },
  { style: 'dawdle', seed: 3311, file: '4-window-closed', expected: ['window-closed', 'adrift'] },
];

test('captures every ending', async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  await mkdir(OUT_DIR, { recursive: true });

  const summary: string[] = [];

  for (const entry of CASES) {
    await bootGame(page);

    const result = await page.evaluate(
      ([style, seed]) => window.__THREE_GAME_TEST_HOOKS__?.playToEnd(style as string, seed as number),
      [entry.style, entry.seed] as const,
    );

    expect(result, `${entry.style} produced no result`).toBeTruthy();
    expect(entry.expected, `${entry.style} ended as ${result!.outcome}`).toContain(result!.outcome);

    // The score screen must actually be on screen, not just the state set.
    await expect(page.locator('.score-total')).toBeVisible();

    const headline = (await page.locator('.card-title').textContent())?.trim();
    const rating = (await page.locator('.score-rating').textContent())?.trim();
    const total = (await page.locator('.score-total span').last().textContent())?.trim();
    const memorial = await page.locator('.memorial-entry').allTextContents();

    // A losing run that kept its crew must not claim all hands were lost.
    if (result!.outcome !== 'arrived' && result!.survivors > 0) {
      expect(rating, `survivors ${result!.survivors} but rating "${rating}"`).not.toMatch(
        /lost with all hands/i,
      );
    }

    const shot = await page.screenshot({ fullPage: false });
    await writeFile(path.join(OUT_DIR, `${entry.file}.png`), shot);
    await testInfo.attach(entry.file, { body: shot, contentType: 'image/png' });

    summary.push(
      [
        `${entry.file}  (${entry.style}, seed ${entry.seed})`,
        `  outcome   ${result!.outcome}`,
        `  headline  ${headline}`,
        `  rating    ${rating}`,
        `  score     ${total}`,
        `  day       ${result!.day}, leg ${result!.leg} of 5`,
        `  survivors ${result!.survivors} of 5`,
        memorial.length ? `  memorial  ${memorial.join(' | ')}` : '  memorial  (none)',
      ].join('\n'),
    );
  }

  console.log(`\n${summary.join('\n\n')}\n`);
});
