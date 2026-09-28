/**
 * Loads a `.coimap` off the main thread.
 *
 * Unzipping, decoding and rasterising a large map is tens of milliseconds of solid CPU.
 * Textures are converted to `ImageBitmap` here too — bitmaps are transferable and can be
 * uploaded to the GPU directly, so the main thread never touches raw pixels.
 */
import { parseCoiMap, CoiMapError } from './parse';
import { buildTileIndex, groundLevels } from './stack';
import { buildTextures } from './terrain';
import { buildEntityTexture } from './entityRaster';
import type { ColourBy } from './entityRaster';
import type { Entity, Proto } from './schema.gen';
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
 * and once for the GPU texture Pixi builds from it, so the real ceiling is twice this.
 *
 * Set generously: this exists as a backstop for genuinely enormous maps, not as a routine
 * quality trade. It was briefly much lower while a blank map was wrongly attributed to
 * memory pressure, which cost sharpness on maps that never needed it.
 */
const TEXTURE_BUDGET = 320 * 1024 * 1024;

/** Longest edge a single layer may have in safe mode, so each fits one chunk. */
const SAFE_MODE_EDGE = 1024;

/** Integer downsample factor needed to fit `layerCount` full-map layers in the budget. */
export function downsampleFactor(
  width: number,
  height: number,
  layerCount: number,
  safeMode = false,
): number {
  let factor = 1;
  if (safeMode) {
    while (Math.max(width, height) / factor > SAFE_MODE_EDGE) factor++;
    return factor;
  }
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

export interface LoadRequest {
  kind: 'load';
  archive: ArrayBuffer;
  /**
   * Forces the most conservative rendering the app can do: the whole map as one small
   * texture per layer. Slow to look at, but it isolates whether a failure is about scale.
   */
  safeMode?: boolean;
  /** Emit per-stage progress to the console. Set by ?debug=1 on the page. */
  debug?: boolean;
}

/** Re-bakes the buildings layer in another colouring, for the map that is loaded. */
export interface RecolourRequest {
  kind: 'recolour';
  /** Echoed back, so a reply to a request that has since been superseded can be dropped. */
  id: number;
  colourBy: ColourBy;
}

export type LoaderRequest = LoadRequest | RecolourRequest;

export type LoaderResponse =
  | { ok: true; doc: WorkerDoc }
  | { ok: false; error: string }
  | { progress: LoadProgress }
  | { recoloured: { id: number; chunks: LayerChunk[] } }
  | { recolourFailed: { id: number; error: string } };

/**
 * What a re-bake needs, kept after the load has handed everything else to the page.
 *
 * The worker outlives the load for this: rasterising belongs off the main thread, and a
 * second full-map layer would cost every layer its resolution on a large map — six layers
 * of a 3584x3840 export pass the texture budget where five fit. So colouring is a mode of
 * the one buildings layer, baked here on demand, rather than a layer of its own.
 *
 * The tile index is rebuilt per request rather than kept: it is 55 MB on that map and
 * 80 ms to recompute, and a recolour is a click, not a frame. `ground` is kept because the
 * height plane it comes from is transferred to the page with the rest of the document.
 */
let session: {
  entities: Entity[];
  protos: Record<string, Proto>;
  width: number;
  height: number;
  factor: number;
  ground: Int16Array | null;
} | null = null;

async function recolour({ id, colourBy }: RecolourRequest) {
  try {
    if (!session) throw new Error('No map is loaded.');
    const { entities, protos, width, height, factor, ground } = session;
    if (colourBy === 'height' && !ground) throw new Error('This export carries no heights.');
    const { top } = buildTileIndex(entities, width, height);
    const rgba = buildEntityTexture(entities, protos, width, height, top, colourBy === 'height' ? ground! : undefined);
    const chunks = await toChunks(rgba, width, height, factor);
    stage(`recoloured buildings by ${colourBy}: ${chunks.length} chunks`);
    self.postMessage({ recoloured: { id, chunks } } satisfies LoaderResponse, { transfer: chunks.map((c) => c.bitmap) });
  } catch (err) {
    self.postMessage({ recolourFailed: { id, error: (err as Error).message } } satisfies LoaderResponse);
  }
}

const report = (progress: LoadProgress) => self.postMessage({ progress } satisfies LoaderResponse);

/**
 * Stage logging that survives a blocked main thread.
 *
 * When the page hangs, React cannot paint, so the failure banner never appears. Console
 * output written before the hang still does — so the last line logged pinpoints where it
 * stopped.
 */
let debugEnabled = false;
const stage = (message: string) => {
  if (debugEnabled) console.info(`[coi-mapper] worker: ${message}`);
};

self.onmessage = async (event: MessageEvent<LoaderRequest>) => {
  if (event.data.kind === 'recolour') {
    await recolour(event.data);
    return;
  }
  const request = event.data;
  try {
    debugEnabled = request.debug === true;
    stage(`opening archive (${(request.archive.byteLength / 1e6).toFixed(1)} MB)`);
    report({ stage: 'unzipping' });
    const parsed = parseCoiMap(new Uint8Array(request.archive));
    const { width, height } = parsed.manifest.map;

    stage(`parsed: ${width}x${height} tiles, ${parsed.entities.length} entities`);
    report({ stage: 'indexing', detail: `${parsed.entities.length.toLocaleString()} entities` });
    const { top: tileToEntity, stacks: tileStacks } = buildTileIndex(parsed.entities, width, height);
    stage(`${tileStacks.size.toLocaleString()} tiles hold more than one entity`);

    stage('indexed; rasterising layers');
    report({ stage: 'rendering', detail: `${width}x${height} tiles` });
    const rasters = {
      ...buildTextures(parsed.planes, parsed.manifest),
      entities: buildEntityTexture(parsed.entities, parsed.protos, width, height, tileToEntity),
    };

    // Only upload layers that have something to draw; a null raster means the export
    // carried no plane for it.
    const present = Object.values(rasters).filter(Boolean).length;
    const safeMode = request.safeMode === true;
    if (safeMode) stage('SAFE MODE: one small texture per layer');
    const factor = downsampleFactor(width, height, present, safeMode);
    if (factor > 1) {
      report({ stage: 'rendering', detail: `downsampling ${factor}x to fit in GPU memory` });
    }

    const layers = {} as WorkerDoc['layers'];
    for (const [name, rgba] of Object.entries(rasters)) {
      if (!rgba) continue;
      layers[name as keyof WorkerDoc['layers']] = await toChunks(rgba, width, height, factor);
      stage(`layer "${name}": ${layers[name as keyof WorkerDoc['layers']]!.length} chunks at ${factor}x`);
    }

    const doc: WorkerDoc = {
      manifest: parsed.manifest,
      entities: parsed.entities,
      transports: parsed.transports,
      edges: parsed.edges,
      protos: parsed.protos,
      planes: parsed.planes,
      tileToEntity,
      tileStacks,
      hasLevels: parsed.hasLevels,
      layers,
      textureScale: factor,
      thumbnail: parsed.thumbnail,
    };

    session = {
      entities: parsed.entities,
      protos: parsed.protos,
      width,
      height,
      factor,
      ground: parsed.hasLevels && parsed.planes.height instanceof Uint16Array
        ? groundLevels(parsed.planes.height, parsed.manifest.map.minHeight, parsed.manifest.map.maxHeight)
        : null,
    };

    stage('handing off to the renderer');
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
