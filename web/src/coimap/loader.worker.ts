/**
 * Loads a `.coimap` off the main thread.
 *
 * Unzipping, decoding and rasterising a large map is tens of milliseconds of solid CPU.
 * Textures are converted to `ImageBitmap` here too — bitmaps are transferable and can be
 * uploaded to the GPU directly, so the main thread never touches raw pixels.
 */
import { parseCoiMap, buildTileIndex, CoiMapError } from './parse';
import { buildTextures } from './terrain';
import { buildEntityTexture } from './entityRaster';
import type { LayerChunk, LoadProgress, WorkerDoc } from './types';
import type { Rgba } from './terrain';

/**
 * Maximum edge of a single uploaded texture. Well under every GPU's limit, and small
 * enough that a driver can always find a contiguous block for it.
 */
const CHUNK = 1024;

/**
 * Texture budget across all layers, in bytes. Beyond this the rasters are downsampled.
 *
 * Every uploaded texture costs twice while it is being created: once for the ImageBitmap
 * and once for the GPU texture Pixi builds from it. A map large enough to exceed this is
 * better shown slightly soft than not shown at all.
 */
const TEXTURE_BUDGET = 96 * 1024 * 1024;

/** Integer downsample factor needed to fit `layerCount` full-map layers in the budget. */
export function downsampleFactor(width: number, height: number, layerCount: number): number {
  let factor = 1;
  while ((width / factor) * (height / factor) * 4 * layerCount > TEXTURE_BUDGET) factor++;
  return factor;
}

/**
 * Slices a raster into chunk-sized bitmaps, downsampling by `factor`.
 *
 * Downsampling picks the most opaque sample in each block rather than the top-left one.
 * Conveyors are a single tile wide, so plain decimation would drop most of them; taking
 * the strongest pixel keeps thin features visible. Chunk `w`/`h` stay in tile units so
 * sprite placement is unaffected by the factor.
 */
async function toChunks(rgba: Rgba, width: number, height: number, factor: number): Promise<LayerChunk[]> {
  const chunks: LayerChunk[] = [];
  const tilesPerChunk = CHUNK * factor;

  for (let ty0 = 0; ty0 < height; ty0 += tilesPerChunk) {
    for (let tx0 = 0; tx0 < width; tx0 += tilesPerChunk) {
      const tw = Math.min(tilesPerChunk, width - tx0);
      const th = Math.min(tilesPerChunk, height - ty0);
      const pw = Math.ceil(tw / factor);
      const ph = Math.ceil(th / factor);
      const sub = new Uint8ClampedArray(pw * ph * 4);

      for (let py = 0; py < ph; py++) {
        for (let px = 0; px < pw; px++) {
          let best = -1;
          let bestAlpha = -1;
          for (let dy = 0; dy < factor; dy++) {
            const sy = ty0 + py * factor + dy;
            if (sy >= height) break;
            for (let dx = 0; dx < factor; dx++) {
              const sx = tx0 + px * factor + dx;
              if (sx >= width) break;
              const at = (sy * width + sx) * 4;
              const alpha = rgba[at + 3]!;
              if (alpha > bestAlpha) { bestAlpha = alpha; best = at; }
            }
          }
          if (best < 0) continue;
          const to = (py * pw + px) * 4;
          sub[to] = rgba[best]!;
          sub[to + 1] = rgba[best + 1]!;
          sub[to + 2] = rgba[best + 2]!;
          sub[to + 3] = rgba[best + 3]!;
        }
      }

      chunks.push({ x: tx0, y: ty0, w: tw, h: th, bitmap: await createImageBitmap(new ImageData(sub, pw, ph)) });
    }
  }
  return chunks;
}

export interface LoaderRequest {
  archive: ArrayBuffer;
}

export type LoaderResponse =
  | { ok: true; doc: WorkerDoc }
  | { ok: false; error: string }
  | { progress: LoadProgress };

const report = (progress: LoadProgress) => self.postMessage({ progress } satisfies LoaderResponse);

self.onmessage = async (event: MessageEvent<LoaderRequest>) => {
  try {
    report({ stage: 'unzipping' });
    const parsed = parseCoiMap(new Uint8Array(event.data.archive));
    const { width, height } = parsed.manifest.map;

    report({ stage: 'indexing', detail: `${parsed.entities.length.toLocaleString()} entities` });
    const tileToEntity = buildTileIndex(parsed.entities, width, height);

    report({ stage: 'rendering', detail: `${width}x${height} tiles` });
    const rasters = {
      ...buildTextures(parsed.planes, parsed.manifest),
      entities: buildEntityTexture(parsed.entities, parsed.protos, width, height),
    };

    // Only upload layers that have something to draw; a null raster means the export
    // carried no plane for it.
    const present = Object.values(rasters).filter(Boolean).length;
    const factor = downsampleFactor(width, height, present);
    if (factor > 1) {
      report({ stage: 'rendering', detail: `downsampling ${factor}x to fit in GPU memory` });
    }

    const layers = {} as WorkerDoc['layers'];
    for (const [name, rgba] of Object.entries(rasters)) {
      if (!rgba) continue;
      layers[name as keyof WorkerDoc['layers']] = await toChunks(rgba, width, height, factor);
    }

    const doc: WorkerDoc = {
      manifest: parsed.manifest,
      entities: parsed.entities,
      transports: parsed.transports,
      edges: parsed.edges,
      protos: parsed.protos,
      planes: parsed.planes,
      tileToEntity,
      layers,
      textureScale: factor,
      thumbnail: parsed.thumbnail,
    };

    report({ stage: 'done' });
    // Hand the large buffers over rather than copying them.
    const transfer: Transferable[] = [
      tileToEntity.buffer,
      ...Object.values(layers).flat().map((c) => c.bitmap),
      ...Object.values(doc.planes).map((p) => p!.buffer),
    ];
    self.postMessage({ ok: true, doc } satisfies LoaderResponse, { transfer });
  } catch (err) {
    const message = err instanceof CoiMapError ? err.message : `Could not load map: ${(err as Error).message}`;
    self.postMessage({ ok: false, error: message } satisfies LoaderResponse);
  }
};
