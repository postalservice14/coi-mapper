import type { Manifest, Entity, Transport, NetworkEdge, Proto, PlaneName } from './schema.gen';

/** Raster planes, decoded into typed arrays. Optional planes may be absent. */
export type Planes = Partial<Record<PlaneName, Uint8Array | Uint16Array>>;

/**
 * Rendered map layers, as GPU-ready bitmaps.
 *
 * Overlay layers are absent when the export has no plane behind them. On a 13.8M-tile map
 * each layer is 55 MB of texture, so uploading empty ones is memory a large base cannot
 * spare — and on real hardware that is the difference between a map and a black rectangle.
 */
export interface MapLayers {
  terrain: ImageBitmap;
  entities: ImageBitmap;
  deposits?: ImageBitmap;
  designations?: ImageBitmap;
}

export type LayerName = keyof MapLayers | 'transports' | 'power';

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
  thumbnail?: Uint8Array;
}

/** Progress reported by the loader while it works. */
export interface LoadProgress {
  stage: 'reading' | 'unzipping' | 'decoding' | 'indexing' | 'rendering' | 'done';
  detail?: string;
}
