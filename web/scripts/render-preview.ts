/**
 * Renders the map textures to PNGs using the real production code path, so the
 * hillshade and overlays can be checked without opening a browser.
 *
 *   cd web && node scripts/render-preview.ts ../samples/fixture.coimap /tmp/preview
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseCoiMap, buildTileIndex } from '../src/coimap/parse.ts';
import { buildTextures } from '../src/coimap/terrain.ts';
// @ts-expect-error - plain JS dev tool, no type declarations
import { encodePng } from '../../samples/png.mjs';

const [input = '../samples/fixture.coimap', outPrefix = '/tmp/preview'] = process.argv.slice(2);

const parsed = parseCoiMap(new Uint8Array(readFileSync(input)));
const { width, height } = parsed.manifest.map;

console.log(`  ${parsed.manifest.game.mapName}  ${width}x${height}`);
console.log(`  entities ${parsed.entities.length}  transports ${parsed.transports.length}`);

const t0 = performance.now();
const textures = buildTextures(parsed.planes, parsed.manifest);
const t1 = performance.now();
const index = buildTileIndex(parsed.entities, width, height);
const t2 = performance.now();

console.log(`  buildTextures  ${(t1 - t0).toFixed(1)} ms`);
console.log(`  buildTileIndex ${(t2 - t1).toFixed(1)} ms`);
console.log(`  occupied tiles ${index.reduce((n, v) => n + (v >= 0 ? 1 : 0), 0).toLocaleString()}`);

for (const [name, rgba] of Object.entries(textures)) {
  const path = `${outPrefix}-${name}.png`;
  writeFileSync(path, encodePng(rgba, width, height));
  console.log(`  wrote ${path}`);
}

// Composite view: terrain with both overlays alpha-blended over it, as the app shows it.
const composite = new Uint8ClampedArray(textures.terrain);
for (const overlay of [textures.deposits, textures.designations]) {
  for (let i = 0; i < composite.length; i += 4) {
    const a = overlay[i + 3]! / 255;
    if (a === 0) continue;
    for (let c = 0; c < 3; c++) composite[i + c] = composite[i + c]! * (1 - a) + overlay[i + c]! * a;
  }
}
writeFileSync(`${outPrefix}-composite.png`, encodePng(composite, width, height));
console.log(`  wrote ${outPrefix}-composite.png`);
