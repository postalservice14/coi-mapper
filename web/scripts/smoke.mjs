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

  // ── the logistics zone layer ────────────────────────────────────────────────
  // A vector layer rather than a baked raster, so what is worth proving is that turning it
  // on reaches the canvas at all. Comparing the canvas screenshot before and after is the
  // only way to see that from out here: the WebGL drawing buffer cannot be read back.
  const zoneRow = page.locator('label.toggle').filter({ hasText: 'Logistics zones' });
  check('zone layer is offered for an export that has zones',
    (await zoneRow.locator('input:disabled').count()) === 0, 'enabled');

  const beforeZones = await page.locator('canvas.map-canvas').screenshot();
  await zoneRow.click();
  await page.waitForTimeout(500);
  const afterZones = await page.locator('canvas.map-canvas').screenshot();
  check('enabling zones changes what is drawn',
    !beforeZones.equals(afterZones),
    `${(beforeZones.length / 1024).toFixed(0)} KB -> ${(afterZones.length / 1024).toFixed(0)} KB`);

  // The map carries no zone labels, so the legend is the only thing that turns a colour
  // into a zone name. It must list every zone the export holds.
  const zoneLegend = await page.locator('.sidebar .legend-group')
    .filter({ hasText: 'Logistics zones' }).locator('.legend-row').allTextContents();
  check('legend names every zone',
    zoneLegend.map((t) => t.trim()).join(' | ') === 'Default | Mining north | Smelter yard',
    zoneLegend.map((t) => t.trim()).join(' | '));

  // Off again, and the canvas must return to what it was. A layer that cannot be turned
  // back off is the failure this catches — drawZones() skips a hidden layer, so a stale
  // Graphics would keep the wash on screen.
  await zoneRow.click();
  await page.waitForTimeout(500);
  const offZones = await page.locator('canvas.map-canvas').screenshot();
  check('disabling zones puts the map back', offZones.equals(beforeZones),
    offZones.equals(beforeZones) ? 'identical' : 'canvas still differs');

  // The grid is drawn straight into the canvas, so there is no DOM node to assert on.
  // The scene publishes its chosen tile step as a data attribute for exactly this.
  const gridStep = () => page.evaluate(() => document.querySelector('canvas.map-canvas').dataset.gridStep);
  const gridOn = await gridStep();
  await page.locator('label.toggle').filter({ hasText: /^Grid$/ }).click();
  await page.waitForTimeout(200);
  const gridOff = await gridStep();
  check(
    'grid overlay toggles',
    /^\d+$/.test(gridOn ?? '') && gridOff === 'off',
    `on=${gridOn} off=${gridOff}`,
  );

  // Like the grid, the camera's orientation only exists inside the canvas, so the scene
  // publishes it as a data attribute too.
  const rotation = () => page.evaluate(() => document.querySelector('canvas.map-canvas').dataset.rotation);
  const tileAt = async (dx, dy) => {
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy);
    await page.waitForTimeout(150);
    return (await page.locator('.statusbar .mono').textContent().catch(() => null))?.trim() ?? null;
  };

  const rotBefore = await rotation();
  const above = await tileAt(0, -120);
  await page.locator('.map-controls button').nth(1).click();
  await page.waitForTimeout(250);
  const rotAfter = await rotation();
  check('rotate right turns the view 90 degrees', rotBefore === '0' && rotAfter === '90', `${rotBefore} -> ${rotAfter}`);

  // A clockwise turn about the middle of the view carries whatever sat above the centre
  // round to its right, so the same tile has to answer from there afterwards. This is the
  // check that catches a reflected inverse in hitTest, which otherwise looks plausible.
  const toTheRight = await tileAt(120, 0);
  check('picking follows the rotation', !!above && above === toTheRight, `tile ${above} moved above -> right`);
  await page.screenshot({ path: `${outDir}/5-rotated.png` });

  await page.locator('.map-controls button').nth(0).click();
  await page.waitForTimeout(250);
  const rotBack = await rotation();
  check('rotate left undoes rotate right', rotBack === '0', `back to ${rotBack}`);

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

  // ── the vehicle census dialog ───────────────────────────────────────────────
  // Sequenced after the rotation checks on purpose: MapView listens for keys on the window,
  // and an open dialog must not let f, [ or ] reach it.
  await page.locator('.topbar button', { hasText: 'Vehicles' }).click();
  await page.waitForSelector('dialog.fleet[open]', { timeout: 5000 });
  await page.waitForTimeout(200);

  const fleetRows = await page.locator('dialog.fleet .counts li').count();
  const fleetGroups = await page.locator('dialog.fleet .legend-group').count();
  check('vehicle dialog lists the fleet', fleetRows === 9 && fleetGroups === 6,
    `${fleetRows} rows in ${fleetGroups} groups`);

  // The fixture's totals are derived from its rows, so an exact match proves the census
  // survived the round trip rather than being recomputed in the UI. The separators are
  // spaced by CSS margins, so textContent has no whitespace around them.
  const fleetSummary = (await page.locator('dialog.fleet header p').textContent())?.replace(/\s+/g, ' ').trim();
  check('vehicle dialog summarises the totals',
    fleetSummary === '215 vehicles·49 cars in 9 trains·limit 260, 45 free', fleetSummary ?? '');

  const firstRow = (await page.locator('dialog.fleet .counts li').first().textContent())?.trim();
  check('rows carry the game\'s own names', firstRow === 'Haul truck (dump) (Diesel)97', firstRow ?? '');

  // The fixture carries the diesel and hydrogen "Haul truck (dump)", which are separate
  // prototypes the game distinguishes only by icon. Two rows reading the same is the bug
  // this guards: a count you cannot attribute to anything is worse than no count.
  const labels = await page.locator('dialog.fleet .counts li .grow').allTextContents();
  check('every row is distinguishable', new Set(labels).size === labels.length,
    `${new Set(labels).size} distinct of ${labels.length}`);

  // The fixture carries a rocket transporter, which the census exports but the panel hides:
  // campaign equipment rather than fleet, and it consumes no vehicle quota. The header is
  // derived from the visible rows, so it must exclude it too rather than out-count the list.
  const shownTotal = (await page.locator('dialog.fleet .legend-group h4 .muted').allTextContents())
    .reduce((n, t) => n + Number(t.replace(/[^0-9]/g, '')), 0);
  check('hidden kinds reach neither the rows nor the total',
    !labels.some((l) => /rocket/i.test(l)) && shownTotal === 215 + 49,
    `${labels.length} rows summing to ${shownTotal}`);
  await page.screenshot({ path: `${outDir}/6-vehicles.png` });

  // ── the same rows, cut by zone ──────────────────────────────────────────────
  // The file stores one row per prototype per zone, so the two groupings are two sums over
  // the same rows. What is worth proving is that they agree: the split prototype appears
  // twice here and once by kind, but the fleet is the same size either way.
  await page.locator('dialog.fleet .groupby button', { hasText: 'Zone' }).click();
  await page.waitForTimeout(200);

  const zoneHeads = (await page.locator('dialog.fleet .legend-group h4').allTextContents())
    .map((t) => t.replace(/\s+/g, ' ').trim());
  check('zone view groups in the file\'s zone order, trains last',
    zoneHeads.join(' | ') === 'Default 22 | Mining north 156 | Smelter yard 37 | Trains 49',
    zoneHeads.join(' | '));

  const zoneRows = await page.locator('dialog.fleet .counts li').count();
  check('a prototype in two zones is two rows here', zoneRows === 10, `${zoneRows} rows`);

  const zoneSummary = (await page.locator('dialog.fleet header p').textContent())?.replace(/\s+/g, ' ').trim();
  check('regrouping does not change the totals', zoneSummary === fleetSummary, zoneSummary ?? '');

  // Rolling stock has no zone, so its group is the one without a colour.
  const swatches = await page.locator('dialog.fleet .legend-group h4 .swatch').count();
  check('zone groups carry the game\'s own zone colour', swatches === 3, `${swatches} swatches`);

  await page.screenshot({ path: `${outDir}/7-vehicles-by-zone.png` });

  // Back to kind. The counts must be identical to the first time round: the panel sums
  // rows into fresh objects, and a version that added them up in place would double the
  // split prototype here rather than anywhere a single render could show.
  await page.locator('dialog.fleet .groupby button', { hasText: 'Kind' }).click();
  await page.waitForTimeout(200);
  const backFirst = (await page.locator('dialog.fleet .counts li').first().textContent())?.trim();
  const backRows = await page.locator('dialog.fleet .counts li').count();
  check('regrouping leaves the census unchanged',
    backFirst === firstRow && backRows === fleetRows, `${backFirst} in ${backRows} rows`);

  // Escape must close the dialog without also clearing the map selection behind it.
  const selectedBefore = await page.locator('.inspector').count();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  const stillOpen = await page.locator('dialog.fleet[open]').count();
  const selectedAfter = await page.locator('.inspector').count();
  check('escape closes the dialog only', stillOpen === 0 && selectedAfter === selectedBefore,
    `dialog ${stillOpen ? 'open' : 'closed'}, inspector ${selectedBefore} -> ${selectedAfter}`);

  // A dialog that stole layout or pointer events shows up here rather than as a mystery later.
  const afterFleet = await page.evaluate(() => {
    const c = document.querySelector('canvas.map-canvas');
    return Math.abs(c.getBoundingClientRect().width - c.parentElement.getBoundingClientRect().width);
  });
  check('canvas is unaffected by the dialog', afterFleet <= 1, `off by ${afterFleet.toFixed(0)} px`);
  const liveTile = await tileAt(40, 40);
  check('map still responds after the dialog closes', !!liveTile, liveTile ?? 'no tile reported');

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
