/**
 * Decodes a `.coimap` archive. Pure and DOM-free so it can run inside a worker.
 */
import { unzipSync } from 'fflate';
import { MEMBERS, PLANES, SCHEMA_VERSION } from './schema.gen';
import type { Manifest, Entity, Transport, NetworkEdge, Proto, PlaneName, Networks } from './schema.gen';
import type { Planes } from './types';

const decoder = new TextDecoder();
const json = <T>(bytes: Uint8Array): T => JSON.parse(decoder.decode(bytes)) as T;

export class CoiMapError extends Error {}

/**
 * Views a plane's bytes as its declared type.
 *
 * fflate hands back a `Uint8Array` that may sit at any byte offset in a larger buffer,
 * which a `Uint16Array` view cannot straddle — so the 16-bit case copies into a fresh,
 * correctly aligned buffer.
 */
function viewPlane(bytes: Uint8Array, dtype: string, expected: number): Uint8Array | Uint16Array {
  if (dtype === 'u8') {
    if (bytes.length !== expected) throw new CoiMapError(`Plane length ${bytes.length}, expected ${expected}.`);
    return bytes;
  }
  if (dtype === 'u16') {
    if (bytes.length !== expected * 2) throw new CoiMapError(`Plane length ${bytes.length}, expected ${expected * 2}.`);
    const aligned = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return new Uint16Array(aligned);
  }
  throw new CoiMapError(`Unsupported plane dtype "${dtype}".`);
}

export interface ParsedArchive {
  manifest: Manifest;
  entities: Entity[];
  transports: Transport[];
  edges: NetworkEdge[];
  protos: Record<string, Proto>;
  planes: Planes;
  thumbnail?: Uint8Array;
}

export function parseCoiMap(archive: Uint8Array): ParsedArchive {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(archive);
  } catch {
    throw new CoiMapError('Not a readable .coimap archive (ZIP could not be opened).');
  }

  const manifestBytes = files[MEMBERS.manifest];
  if (!manifestBytes) {
    throw new CoiMapError(
      `Archive has no ${MEMBERS.manifest}. If you selected a Captain of Industry ".save" file, ` +
        'export a .coimap from inside the game with the CoiMapper mod first.',
    );
  }

  const manifest = json<Manifest>(manifestBytes);
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    throw new CoiMapError(
      `This file uses .coimap schema v${manifest.schemaVersion}, but this app reads v${SCHEMA_VERSION}. ` +
        'Update the exporter mod or the app so they match.',
    );
  }

  const { width, height } = manifest.map;
  if (!(width > 0 && height > 0)) throw new CoiMapError(`Invalid map size ${width}×${height}.`);
  const tiles = width * height;

  const planes: Planes = {};
  for (const info of manifest.planes) {
    const bytes = files[info.file];
    if (!bytes) throw new CoiMapError(`Manifest lists plane "${info.name}" but ${info.file} is missing.`);
    planes[info.name as PlaneName] = viewPlane(bytes, info.dtype, tiles);
  }
  for (const [name, def] of Object.entries(PLANES)) {
    if (!def.optional && !planes[name as PlaneName]) {
      throw new CoiMapError(`Required plane "${name}" is missing.`);
    }
  }

  const networks = files[MEMBERS.networks]
    ? json<Networks>(files[MEMBERS.networks]!)
    : { transports: [], edges: [] };

  const protoList = files[MEMBERS.protos] ? json<Proto[]>(files[MEMBERS.protos]!) : [];

  return {
    manifest,
    entities: files[MEMBERS.entities] ? json<Entity[]>(files[MEMBERS.entities]!) : [],
    transports: networks.transports ?? [],
    edges: networks.edges ?? [],
    protos: Object.fromEntries(protoList.map((p) => [p.id, p])),
    planes,
    thumbnail: files[MEMBERS.thumbnail],
  };
}

/**
 * Builds the tile → entity lookup used for hit-testing.
 * Values are indices into `entities`; -1 means the tile is empty.
 */
export function buildTileIndex(entities: Entity[], width: number, height: number): Int32Array {
  const index = new Int32Array(width * height).fill(-1);
  for (let e = 0; e < entities.length; e++) {
    const { x, y, w, h } = entities[e]!;
    const x1 = Math.min(width, x + w);
    const y1 = Math.min(height, y + h);
    for (let ty = Math.max(0, y); ty < y1; ty++) {
      const row = ty * width;
      for (let tx = Math.max(0, x); tx < x1; tx++) index[row + tx] = e;
    }
  }
  return index;
}
