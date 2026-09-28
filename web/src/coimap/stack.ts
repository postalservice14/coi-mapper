/**
 * What sits on each tile, and at what level.
 *
 * A pipe can run under a flat conveyor on the same tile, so one tile can hold several
 * entities. The index keeps the topmost of each for the common case — a single array
 * lookup per hover — and a sparse map of the few tiles that hold more than one, listed
 * top-down, for picking and the inspector's stack list.
 *
 * "Top" is the highest bottom Z on that very tile, not over the whole entity: a belt that
 * ramps over a pipe is above it only where it has climbed.
 *
 * At one height, a support loses to whatever it shares the tile with. The game foots a
 * pipe on the ground with a one-tile pillar occupying the very same volume, and writes the
 * pillar after the pipe, so without this a click on a ground pipe picked its pillar — on
 * about 2,200 tiles of a real export. Beyond that, ties go to the entity written last,
 * which is what the index did before it knew about height at all, so an export with no
 * levels behaves as it used to.
 */
import type { Entity } from './schema.gen';
import type { WorkerDoc } from './types';
import { forEachFootprintTile } from './footprint';
import { readTile } from './tileInfo';

export interface TileIndex {
  /** Tile → index into `entities` of the topmost occupant, or -1 when the tile is empty. */
  top: Int32Array;
  /** Tile → every occupant, topmost first. Only tiles holding two or more appear. */
  stacks: Map<number, Int32Array>;
}

/** Bottom Z of one footprint tile, by its ordinal in `tiles`; -1 means a filled box. */
export const bottomZ = (entity: Entity, ordinal: number): number =>
  ordinal >= 0 && ordinal < entity.tz.length ? entity.tz[ordinal]! : entity.z0;

/**
 * Prototypes that exist to hold something else up. Named rather than matched by category:
 * the game files pillars under Transport, alongside the belts they carry.
 */
const SUPPORT_PROTOS = new Set(['TransportsPillar', 'TrainTracksPillar']);

export function buildTileIndex(entities: Entity[], width: number, height: number): TileIndex {
  const support = Uint8Array.from(entities, (e) => (SUPPORT_PROTOS.has(e.proto) ? 1 : 0));
  const top = new Int32Array(width * height).fill(-1);
  const topZ = new Int32Array(width * height);            // meaningful only where top >= 0
  const shared = new Map<number, number[]>();             // tile → flat [entity, z, entity, z, …]

  for (let e = 0; e < entities.length; e++) {
    const entity = entities[e]!;
    forEachFootprintTile(entity, width, height, (tile, _isEdge, ordinal) => {
      const z = bottomZ(entity, ordinal);
      const prev = top[tile]!;
      if (prev >= 0 && prev !== e) {
        let list = shared.get(tile);
        if (!list) shared.set(tile, (list = [prev, topZ[tile]!]));
        list.push(e, z);
        if (z < topZ[tile]! || (z === topZ[tile] && support[e]! > support[prev]!)) return;
      }
      top[tile] = e;
      topZ[tile] = z;
    });
  }

  const stacks = new Map<number, Int32Array>();
  for (const [tile, flat] of shared) {
    const order: number[] = [];
    for (let i = 0; i < flat.length; i += 2) order.push(i);
    // Same rule as `top`: higher first, then anything over a support, then the later-written.
    order.sort((a, b) =>
      flat[b + 1]! - flat[a + 1]! || support[flat[a]!]! - support[flat[b]!]! || flat[b]! - flat[a]!);
    stacks.set(tile, Int32Array.from(order, (i) => flat[i]!));
  }
  return { top, stacks };
}

/** Every entity on a tile, topmost first; empty for bare terrain. */
export function stackAt(doc: WorkerDoc, tile: number): number[] {
  const shared = doc.tileStacks.get(tile);
  if (shared) return Array.from(shared);
  const top = doc.tileToEntity[tile] ?? -1;
  return top >= 0 ? [top] : [];
}

/**
 * The entity a click on a tile selects.
 *
 * A first click takes the topmost. Clicking the same tile again steps down through the
 * stack and wraps, which is how the pipe under a conveyor gets picked at all.
 */
export function nextInStack(stack: readonly number[], selected: number, sameTile: boolean): number {
  const at = sameTile ? stack.indexOf(selected) : -1;
  if (at >= 0) return stack[(at + 1) % stack.length]!;
  return stack[0] ?? -1;
}

/** Bottom Z of an entity at one map tile, or its `z0` where it has no per-tile heights. */
function bottomAt(entity: Entity, tx: number, ty: number): number {
  const tiles = entity.tiles;
  if (entity.tz.length > 0 && tiles) {
    const dx = tx - entity.x, dy = ty - entity.y;
    for (let i = 0; i + 1 < tiles.length; i += 2) {
      if (tiles[i] === dx && tiles[i + 1] === dy) return bottomZ(entity, i >> 1);
    }
  }
  return entity.z0;
}

/**
 * Level above the terrain: a pipe on the ground is 0, one lifted over it is 1.
 *
 * The game grounds a transport at the ceiling of the tile's highest corner less a small
 * penetration allowance (`TransportHelper.GetLowestNonCollidingHeight`). Rounding the
 * sampled tile height lands on the same whole tile for ordinary slopes; a steep cliff
 * edge can read one level off. Null when the export carries no levels or no heights.
 */
export function levelAt(doc: WorkerDoc, entityIndex: number, tx: number, ty: number): number | null {
  const entity = doc.entities[entityIndex];
  if (!entity || !doc.hasLevels) return null;
  const ground = readTile(doc, tx, ty).height;
  if (ground === null) return null;
  return bottomAt(entity, tx, ty) - Math.round(ground);
}

/** The lowest and highest level an entity reaches over its footprint. */
export function levelSpan(doc: WorkerDoc, entityIndex: number): { min: number; max: number } | null {
  const entity = doc.entities[entityIndex];
  if (!entity || !doc.hasLevels) return null;
  const { width, height } = doc.manifest.map;
  let min = Infinity, max = -Infinity;
  if (entity.tz.length === 0) {
    const level = levelAt(doc, entityIndex, entity.x, entity.y);
    return level === null ? null : { min: level, max: level };
  }
  forEachFootprintTile(entity, width, height, (tile, _isEdge, ordinal) => {
    const ground = readTile(doc, tile % width, Math.floor(tile / width)).height;
    if (ground === null) return;
    const level = bottomZ(entity, ordinal) - Math.round(ground);
    if (level < min) min = level;
    if (level > max) max = level;
  });
  return min <= max ? { min, max } : null;
}

/**
 * The ground under every tile as a whole-tile Z, by the rounding `levelAt` uses, so a
 * level baked into the map and a level shown in the inspector cannot disagree.
 */
export function groundLevels(height: Uint16Array, minHeight: number, maxHeight: number): Int16Array {
  const span = maxHeight - minHeight;
  return Int16Array.from(height, (v) => Math.round(minHeight + (v / 65535) * span));
}

/** "+2", "0", "-1": a level reads as an offset from the ground. */
export const formatLevel = (level: number): string => (level > 0 ? `+${level}` : `${level}`);
