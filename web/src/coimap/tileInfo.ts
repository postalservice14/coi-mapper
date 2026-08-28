/** Reads the human-meaningful values stored at a single tile. */
import { DESIGNATION_BITS } from './schema.gen';
import type { Surface, TileSurface, Deposit } from './schema.gen';
import type { WorkerDoc } from './types';

export interface TileInfo {
  tx: number;
  ty: number;
  /** Terrain height in world units, or null when the plane is absent. */
  height: number | null;
  /** Natural ground material. Named for the plane it comes from, not for paving. */
  surface: Surface | null;
  /** Paving the player has laid over the ground, or null where there is none. */
  tileSurface: TileSurface | null;
  deposit: Deposit | null;
  /** Deposit richness as a 0-1 fraction. */
  depositRichness: number | null;
  /** Names of every designation applied to this tile. */
  designations: string[];
}

export function readTile(doc: WorkerDoc, tx: number, ty: number): TileInfo {
  const { width, height: mapHeight, minHeight, maxHeight } = doc.manifest.map;
  const i = ty * width + tx;
  const info: TileInfo = {
    tx, ty, height: null, surface: null, tileSurface: null, deposit: null,
    depositRichness: null, designations: [],
  };
  if (tx < 0 || ty < 0 || tx >= width || ty >= mapHeight) return info;

  const raw = doc.planes.height?.[i];
  if (raw !== undefined) info.height = minHeight + (raw / 65535) * (maxHeight - minHeight);

  const surfaceId = doc.planes.surface?.[i];
  if (surfaceId !== undefined) info.surface = doc.manifest.surfaces.find((s) => s.id === surfaceId) ?? null;

  const tileSurfaceId = doc.planes.tileSurface?.[i];
  if (tileSurfaceId) info.tileSurface = doc.manifest.tileSurfaces.find((t) => t.id === tileSurfaceId) ?? null;

  const depositId = doc.planes.deposit?.[i];
  if (depositId) {
    info.deposit = doc.manifest.deposits.find((d) => d.id === depositId) ?? null;
    const amount = doc.planes.depositAmount?.[i];
    if (amount !== undefined) info.depositRichness = amount / 65535;
  }

  const bits = doc.planes.designation?.[i] ?? 0;
  for (const [name, bit] of Object.entries(DESIGNATION_BITS)) {
    if (bits & bit) info.designations.push(name);
  }
  return info;
}
