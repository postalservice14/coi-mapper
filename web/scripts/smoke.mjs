#!/usr/bin/env node
/**
 * End-to-end smoke test: serves the production build, drops a .coimap into the app,
 * and verifies the map actually renders — then captures screenshots for review.
 *
 *   node scripts/smoke.mjs [fixture] [outDir]
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const [fixture = '../samples/fixture.coimap', outDir = '/tmp/coi-smoke'] = process.argv.slice(2);
const PORT = 5599;
const URL = `http://localhost:${PORT}/`;

mkdirSync(outDir, { recursive: true });

// DEV=1 runs against the dev server instead of the production build. That matters:
// StrictMode double-invokes effects only in development, so bugs that appear when a scene
// is mounted, torn down and mounted again are invisible to a production-only test.
const useDevServer = process.env.DEV === '1';
const server = spawn(
  'npx',
  useDevServer
    ? ['vite', '--port', String(PORT), '--strictPort']
    : ['vite', 'preview', '--port', String(PORT), '--strictPort'],
  { stdio: 'ignore', detached: false },
);

const fail = (msg) => { console.error(`\n  FAIL  ${msg}\n`); server.kill(); process.exit(1); };

// Wait for the preview server to accept connections.
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try { up = (await fetch(URL)).ok; } catch { await sleep(250); }
}
if (!up) fail(`preview server did not start on ${URL}`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

try {
  await page.goto(URL, { waitUntil: 'networkidle' });
  check('landing page renders', await page.locator('h1').first().isVisible());
  await page.screenshot({ path: `${outDir}/1-landing.png` });

  // Load the fixture through the real file input.
  await page.setInputFiles('input[type=file]', fixture);
  await page.waitForSelector('canvas.map-canvas', { timeout: 20000 });
  await page.waitForTimeout(1200); // let WebGL present a frame

  check('map canvas mounted', await page.locator('canvas.map-canvas').isVisible());

  const title = await page.locator('.topbar h1').textContent();
  check('map name in header', !!title?.includes('Synthetic Isles'), title ?? '(none)');

  // Verify the canvas actually drew something. Reading pixels back out of the WebGL
  // context does not work here: the drawing buffer is swapped after each frame unless
  // `preserveDrawingBuffer` is set, which costs performance. A compositor screenshot
  // captures the real frame, and a uniform image compresses far smaller than a map.
  const shot = await page.locator('canvas.map-canvas').screenshot();
  check('canvas has rendered content', shot.length > 40000, `${(shot.length / 1024).toFixed(0)} KB canvas PNG`);

  // The canvas must actually fill its container — a renderer that ignores container
  // resizes leaves gutters and can overlap neighbouring panels.
  const fit = await page.evaluate(() => {
    const c = document.querySelector('canvas.map-canvas');
    const host = c.parentElement;
    return {
      dx: Math.abs(c.getBoundingClientRect().width - host.getBoundingClientRect().width),
      dy: Math.abs(c.getBoundingClientRect().height - host.getBoundingClientRect().height),
    };
  });
  check('canvas fills its container', fit.dx <= 1 && fit.dy <= 1, `off by ${fit.dx.toFixed(0)}x${fit.dy.toFixed(0)} px`);

  // The fitted map should very nearly fill the viewport in its constrained axis.
  // Fitting against a stale layout size shows up here as a span that is too big or small.
  const span = await page.evaluate(() => {
    const c = document.querySelector('canvas.map-canvas');
    const [w, h] = c.dataset.mapSpan.split('x').map(Number);
    const r = c.getBoundingClientRect();
    return { fill: Math.max(w / r.width, h / r.height) };
  });
  check('map is fitted to the viewport', span.fill > 0.9 && span.fill <= 1.0, `fills ${(span.fill * 100).toFixed(0)}% of the constrained axis`);

  // The renderer must also leave the page usable. A texture that can never finish
  // uploading makes Pixi retry every frame: pixels appear, but the main thread pins at
  // 100% CPU and the tab goes unresponsive — invisible to a screenshot-only check.
  const responsive = await (async () => {
    const started = Date.now();
    await page.evaluate(() => 1);
    const latency = Date.now() - started;
    const frames = await page.evaluate(
      () => new Promise((resolve) => {
        let n = 0;
        const t0 = performance.now();
        const tick = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(tick); else resolve(n); };
        requestAnimationFrame(tick);
      }),
    );
    return { latency, frames };
  })();
  check(
    'page stays responsive',
    responsive.latency < 500 && responsive.frames >= 20,
    `main thread replied in ${responsive.latency} ms, ${responsive.frames} frames in 1 s`,
  );

  await page.screenshot({ path: `${outDir}/2-map.png` });

  // Hovering should populate the status bar with tile data.
  const box = await page.locator('canvas.map-canvas').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(250);
  const status = await page.locator('.statusbar').textContent();
  check('status bar reports tile', /\d+,\s*\d+/.test(status ?? ''), status?.slice(0, 70) ?? '');

  // Toggle every optional layer that this export actually contains. Layers with no data
  // are rendered disabled on purpose, so clicking them would (correctly) never succeed.
  let toggled = 0, unavailable = 0;
  for (const label of ['Deposits', 'Designations', 'Power grid']) {
    const row = page.locator('label.toggle').filter({ hasText: label });
    if (await row.locator('input:disabled').count()) { unavailable++; continue; }
    await row.click();
    toggled++;
  }
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${outDir}/3-all-layers.png` });
  check('optional layers toggle', true, `${toggled} toggled, ${unavailable} absent from this export`);

  // Search then select a building, which should open the inspector.
  await page.locator('input.search').fill('Furnace');
  await page.waitForTimeout(200);
  const results = page.locator('.results li button');
  const n = await results.count();
  check('search returns results', n > 0, `${n} matches for "Furnace"`);
  if (n > 0) {
    await results.first().click();
    await page.waitForSelector('.inspector', { timeout: 5000 });
    await page.waitForTimeout(400);
    const heading = await page.locator('.inspector h2').textContent();
    check('inspector opens on selection', !!heading, heading ?? '');
    // Opening the inspector narrows the stage; the canvas must follow.
    const refit = await page.evaluate(() => {
      const c = document.querySelector('canvas.map-canvas');
      return Math.abs(c.getBoundingClientRect().width - c.parentElement.getBoundingClientRect().width);
    });
    check('canvas re-fits when inspector opens', refit <= 1, `off by ${refit.toFixed(0)} px`);
    await page.screenshot({ path: `${outDir}/4-inspector.png` });
  }

  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
} catch (err) {
  await page.screenshot({ path: `${outDir}/error.png` }).catch(() => {});
  check('run completed without throwing', false, err.message);
} finally {
  await browser.close();
  server.kill();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n  ${checks.length - failed.length}/${checks.length} checks passed (${useDevServer ? 'dev server' : 'production build'}) · screenshots in ${outDir}\n`);
process.exit(failed.length ? 1 : 0);
