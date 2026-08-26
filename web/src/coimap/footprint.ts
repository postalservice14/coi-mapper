import type { Entity } from './schema.gen';

/**
 * Visits every tile an entity actually occupies.
 *
 * Most entities fill their `w`×`h` box and carry no explicit tile list. Conveyors and
 * pipes do not: a belt snaking across the factory has a bounding box hundreds of tiles
 * wide that is almost entirely empty, so it ships the tiles it really covers. Treating
 * the box as the footprint would paint those as vast solid rectangles.
 *
 * `isEdge` marks the border of a filled box, used to outline adjacent machines. Explicit
 * tile lists are already thin, so nothing is treated as an edge there.
 */
export function forEachFootprintTile(
  entity: Entity,
  width: number,
  height: number,
  visit: (tileIndex: number, isEdge: boolean) => void,
): void {
  const tiles = entity.tiles;

  if (tiles && tiles.length >= 2) {
    for (let i = 0; i + 1 < tiles.length; i += 2) {
      const tx = entity.x + tiles[i]!;
      const ty = entity.y + tiles[i + 1]!;
      if (tx < 0 || ty < 0 || tx >= width || ty >= height) continue;
      visit(ty * width + tx, false);
    }
    return;
  }

  const x1 = Math.min(width, entity.x + entity.w);
  const y1 = Math.min(height, entity.y + entity.h);
  for (let ty = Math.max(0, entity.y); ty < y1; ty++) {
    const onEdgeY = ty === entity.y || ty === y1 - 1;
    const row = ty * width;
    for (let tx = Math.max(0, entity.x); tx < x1; tx++) {
      visit(row + tx, onEdgeY || tx === entity.x || tx === x1 - 1);
    }
  }
}

/** True when the entity ships an explicit tile list rather than filling its box. */
export const hasSparseFootprint = (entity: Entity): boolean =>
  Boolean(entity.tiles && entity.tiles.length >= 2);
