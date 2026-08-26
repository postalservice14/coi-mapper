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
import type { LoadProgress, WorkerDoc } from './types';

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

    const layers = {} as WorkerDoc['layers'];
    for (const [name, rgba] of Object.entries(rasters)) {
      layers[name as keyof WorkerDoc['layers']] = await createImageBitmap(new ImageData(rgba, width, height));
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
      ...Object.values(layers),
      ...Object.values(doc.planes).map((p) => p!.buffer),
    ];
    self.postMessage({ ok: true, doc } satisfies LoaderResponse, { transfer });
  } catch (err) {
    const message = err instanceof CoiMapError ? err.message : `Could not load map: ${(err as Error).message}`;
    self.postMessage({ ok: false, error: message } satisfies LoaderResponse);
  }
};
