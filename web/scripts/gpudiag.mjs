#!/usr/bin/env node
/** Reproduces a map load under GPU-ish conditions and reports WebGL limits and failures. */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const [file = '../samples/fixture.coimap', scaleStr = '2', wStr = '1520', hStr = '1900'] = process.argv.slice(2);
const PORT = 5603, URL = `http://localhost:${PORT}/`;

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
let up = false;
for (let i = 0; i < 60 && !up; i++) { try { up = (await fetch(URL)).ok; } catch { await sleep(250); } }
if (!up) { server.kill(); throw new Error('server did not start'); }

const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
});
const page = await browser.newPage({
  viewport: { width: Number(wStr), height: Number(hStr) },
  deviceScaleFactor: Number(scaleStr),
});

const events = [];
page.on('console', (m) => events.push(`console.${m.type()}: ${m.text().slice(0, 200)}`));
page.on('pageerror', (e) => events.push(`pageerror: ${e.message.slice(0, 200)}`));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.evaluate(() => {
  const c = document.createElement('canvas');
  window.__lost = [];
  c.addEventListener('webglcontextlost', () => window.__lost.push('probe'));
});
await page.setInputFiles('input[type=file]', file);
await page.waitForSelector('canvas.map-canvas', { timeout: 30000 });
await page.waitForTimeout(3000);

const diag = await page.evaluate(() => {
  const c = document.querySelector('canvas.map-canvas');
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
  return {
    cssSize: [c.getBoundingClientRect().width, c.getBoundingClientRect().height].map(Math.round),
    backingSize: [c.width, c.height],
    dpr: window.devicePixelRatio,
    hasContext: !!gl,
    contextLost: gl ? gl.isContextLost() : null,
    maxTexture: gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : null,
    maxRenderbuffer: gl ? gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) : null,
    renderer: dbg && gl ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'n/a',
    glError: gl ? gl.getError() : null,
    zoom: c.dataset.zoom,
    mapSpan: c.dataset.mapSpan,
  };
});

const shot = await page.locator('canvas.map-canvas').screenshot();
console.log('  file           ', file);
console.log('  css size       ', diag.cssSize.join(' x '), ' dpr', diag.dpr);
console.log('  backing buffer ', diag.backingSize.join(' x '));
console.log('  renderer       ', diag.renderer);
console.log('  MAX_TEXTURE    ', diag.maxTexture, ' MAX_RENDERBUFFER', diag.maxRenderbuffer);
console.log('  context lost   ', diag.contextLost, ' glError', diag.glError);
console.log('  camera zoom    ', diag.zoom, ' map span', diag.mapSpan);
console.log('  canvas png     ', `${(shot.length / 1024).toFixed(0)} KB`, shot.length < 40000 ? '  <-- LIKELY BLANK' : '');
if (events.length) { console.log('  events:'); for (const e of events.slice(0, 8)) console.log('   ', e); }

await browser.close();
server.kill();
