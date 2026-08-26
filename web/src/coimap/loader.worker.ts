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

/** Slices a full-map raster into chunk-sized bitmaps. */
async function toChunks(rgba: Rgba, width: number, height: number): Promise<LayerChunk[]> {
  const chunks: LayerChunk[] = [];
  for (let y0 = 0; y0 < height; y0 += CHUNK) {
    for (let x0 = 0; x0 < width; x0 += CHUNK) {
      const w = Math.min(CHUNK, width - x0);
      const h = Math.min(CHUNK, height - y0);
      const sub = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) {
        const from = ((y0 + y) * width + x0) * 4;
        sub.set(rgba.subarray(from, from + w * 4), y * w * 4);
      }
      chunks.push({ x: x0, y: y0, w, h, bitmap: await createImageBitmap(new ImageData(sub, w, h)) });
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
    const layers = {} as WorkerDoc['layers'];
    for (const [name, rgba] of Object.entries(rasters)) {
      if (!rgba) continue;
      layers[name as keyof WorkerDoc['layers']] = await toChunks(rgba, width, height);
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
