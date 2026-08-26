/** Renders a large map's composited layers to a downscaled PNG for eyeballing. */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseCoiMap } from '../src/coimap/parse.ts';
import { buildTextures } from '../src/coimap/terrain.ts';
import { buildEntityTexture } from '../src/coimap/entityRaster.ts';
// @ts-expect-error - plain JS dev tool
import { encodePng } from '../../samples/png.mjs';

const [input, out = '/tmp/big.png', maxDimStr = '1400'] = process.argv.slice(2);
const maxDim = Number(maxDimStr);

const doc = parseCoiMap(new Uint8Array(readFileSync(input!)));
const { width, height } = doc.manifest.map;
const terrain = buildTextures(doc.planes, doc.manifest).terrain;
const entities = buildEntityTexture(doc.entities, doc.protos, width, height);

const step = Math.max(1, Math.ceil(Math.max(width, height) / maxDim));
const ow = Math.floor(width / step);
const oh = Math.floor(height / step);
const outPx = new Uint8ClampedArray(ow * oh * 4);

for (let y = 0; y < oh; y++) {
  for (let x = 0; x < ow; x++) {
    const src = (y * step * width + x * step) * 4;
    const dst = (y * ow + x) * 4;
    // Entities composite over terrain, same as the app stacks its layers.
    const a = entities[src + 3]! / 255;
    for (let c = 0; c < 3; c++) {
      outPx[dst + c] = terrain[src + c]! * (1 - a) + entities[src + c]! * a;
    }
    outPx[dst + 3] = 255;
  }
}

writeFileSync(out, encodePng(outPx, ow, oh));
console.log(`  ${width}x${height} → ${ow}x${oh} (1/${step})  wrote ${out}`);
