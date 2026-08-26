import type { Manifest, Entity, Transport, NetworkEdge, Proto, PlaneName } from './schema.gen';

/** Raster planes, decoded into typed arrays. Optional planes may be absent. */
export type Planes = Partial<Record<PlaneName, Uint8Array | Uint16Array>>;

/** One piece of a layer's raster, positioned in tile coordinates. */
export interface LayerChunk {
  x: number;
  y: number;
  w: number;
  h: number;
  bitmap: ImageBitmap;
}

/**
 * Rendered map layers, as GPU-ready bitmaps.
 *
 * Each layer is split into chunks rather than uploaded as one image. A 3584x3840 map is a
 * single 55 MB texture per layer, and drivers lose the WebGL context trying to allocate
 * that in one contiguous block even with memory to spare. Chunks keep every allocation
 * small and each upload short enough not to trip a driver watchdog.
 *
 * Overlay layers are absent entirely when the export has no plane behind them.
 */
export interface MapLayers {
  terrain: LayerChunk[];
  entities: LayerChunk[];
  deposits?: LayerChunk[];
  designations?: LayerChunk[];
}

export type LayerName = keyof MapLayers | 'transports' | 'power' | 'grid';

/** Everything the renderer needs, produced by the loader worker. */
export interface WorkerDoc {
  manifest: Manifest;
  entities: Entity[];
  transports: Transport[];
  edges: NetworkEdge[];
  /** Prototype metadata keyed by proto id. */
  protos: Record<string, Proto>;
  planes: Planes;
  /**
   * Tile index → index into `entities`, or -1 when the tile is empty.
   * The grid makes hit-testing a single array lookup; no spatial tree is needed.
   */
  tileToEntity: Int32Array;
  layers: MapLayers;
  /** 1 when rasters are full resolution; higher when downsampled to fit GPU memory. */
  textureScale: number;
  thumbnail?: Uint8Array;
}

/** Progress reported by the loader while it works. */
export interface LoadProgress {
  stage: 'reading' | 'unzipping' | 'decoding' | 'indexing' | 'rendering' | 'done';
  detail?: string;
}
