/** Reads the human-meaningful values stored at a single tile. */
import { DESIGNATION_BITS } from './schema.gen';
import type { Surface, Deposit } from './schema.gen';
import type { WorkerDoc } from './types';

export interface TileInfo {
  tx: number;
  ty: number;
  /** Terrain height in world units, or null when the plane is absent. */
  height: number | null;
  surface: Surface | null;
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
    tx, ty, height: null, surface: null, deposit: null, depositRichness: null, designations: [],
  };
  if (tx < 0 || ty < 0 || tx >= width || ty >= mapHeight) return info;

  const raw = doc.planes.height?.[i];
  if (raw !== undefined) info.height = minHeight + (raw / 65535) * (maxHeight - minHeight);

  const surfaceId = doc.planes.surface?.[i];
  if (surfaceId !== undefined) info.surface = doc.manifest.surfaces.find((s) => s.id === surfaceId) ?? null;

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
