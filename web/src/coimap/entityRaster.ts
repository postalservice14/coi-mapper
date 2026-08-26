/**
 * Rasterises entity footprints into an RGBA layer, one pixel per tile.
 *
 * Drawing tens of thousands of individual rectangles would swamp the renderer; baking
 * them into a texture keeps it at one draw call no matter how large the base grows.
 * Vector detail (outlines, labels) is layered on top only for what is on screen.
 */
import { CATEGORY_COLORS } from './schema.gen';
import type { Entity, Proto } from './schema.gen';
import { parseHex } from './terrain';
import type { Rgba } from './terrain';
import { forEachFootprintTile } from './footprint';

/** Per-state appearance: how much the footprint is dimmed, and any tint applied. */
const STATE_STYLE: Record<string, { alpha: number; tint?: [number, number, number] }> = {
  Operating: { alpha: 1 },
  Idle: { alpha: 0.85 },
  Paused: { alpha: 0.7 },
  Disabled: { alpha: 0.55 },
  Constructing: { alpha: 0.5, tint: [120, 190, 255] },
  Deconstructing: { alpha: 0.5, tint: [255, 170, 90] },
  Broken: { alpha: 1, tint: [235, 70, 70] },
  Unknown: { alpha: 0.8 },
};

const DEFAULT_STYLE = { alpha: 0.9 };
/** How much the one-tile border of each footprint is darkened, to separate neighbours. */
const EDGE_DARKEN = 0.6;

export function buildEntityTexture(
  entities: Entity[],
  protos: Record<string, Proto>,
  width: number,
  height: number,
): Rgba {
  const rgba = new Uint8ClampedArray(width * height * 4);

  for (const e of entities) {
    const proto = protos[e.proto];
    const base = parseHex(proto?.color ?? CATEGORY_COLORS.Other!);
    const style = STATE_STYLE[e.state] ?? DEFAULT_STYLE;

    let [r, g, b] = base;
    if (style.tint) {
      // Blend halfway to the state tint so the category is still readable.
      r = (r + style.tint[0]) / 2;
      g = (g + style.tint[1]) / 2;
      b = (b + style.tint[2]) / 2;
    }
    const alpha = Math.round(style.alpha * 255);

    forEachFootprintTile(e, width, height, (tile, isEdge) => {
      const k = isEdge ? EDGE_DARKEN : 1;
      const o = tile * 4;
      rgba[o] = r * k;
      rgba[o + 1] = g * k;
      rgba[o + 2] = b * k;
      rgba[o + 3] = alpha;
    });
  }

  return rgba;
}
