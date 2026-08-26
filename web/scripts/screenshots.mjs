#!/usr/bin/env node
/**
 * Captures the README screenshots from the running app, so the images always reflect
 * what the code actually renders.
 *
 *   npm run screenshots
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 5601;
const URL = `http://localhost:${PORT}/`;
const FIXTURE = '../samples/fixture.coimap';
const OUT = '../docs';

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try { up = (await fetch(URL)).ok; } catch { await sleep(250); }
}
if (!up) { server.kill(); throw new Error('preview server did not start'); }

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2 });

try {
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.setInputFiles('input[type=file]', FIXTURE);
  await page.waitForSelector('canvas.map-canvas');
  await page.waitForTimeout(1500);

  // Hero: the whole map with the default layers on.
  await page.screenshot({ path: `${OUT}/screenshot.png` });
  console.log(`wrote ${OUT}/screenshot.png`);

  // Detail: zoomed in with a building selected so the overlays, conveyor runs and
  // inspector are all legible. The power grid stays off here — the synthetic fixture
  // wires clusters at random across the whole island, which reads as noise rather than
  // as a real base's local distribution.
  for (const label of ['Deposits', 'Designations']) {
    await page.locator('label.toggle').filter({ hasText: label }).click();
  }
  await page.locator('input.search').fill('Furnace');
  await page.waitForTimeout(300);
  await page.locator('.results li button').first().click();
  await page.waitForSelector('.inspector');

  const box = await page.locator('canvas.map-canvas').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 12; i++) await page.mouse.wheel(0, -120);
  await page.waitForTimeout(900);

  await page.screenshot({ path: `${OUT}/screenshot-detail.png` });
  console.log(`wrote ${OUT}/screenshot-detail.png`);
} finally {
  await browser.close();
  server.kill();
}
