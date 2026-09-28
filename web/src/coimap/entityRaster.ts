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
import { bottomZ } from './stack';
import { levelRgb } from './levelPalette';

/** What the buildings layer is coloured by. */
export type ColourBy = 'category' | 'height';

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
  /**
   * The topmost entity per tile. Where tiles are shared, only the one on top paints, so a
   * belt carried over a pipe shows as the belt; without it the last entity written wins.
   */
  top?: Int32Array,
  /**
   * Colour by level instead of category, given the ground's whole-tile Z per tile. Every
   * tile is drawn at full strength: the state dimming would read as a different level.
   */
  ground?: Int16Array,
): Rgba {
  const rgba = new Uint8ClampedArray(width * height * 4);
  if (ground) {
    paintLevels(rgba, entities, width, height, ground, top);
    return rgba;
  }

  for (let n = 0; n < entities.length; n++) {
    const e = entities[n]!;
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
      if (top && top[tile] !== n) return;
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

function paintLevels(
  rgba: Rgba, entities: Entity[], width: number, height: number, ground: Int16Array, top?: Int32Array,
): void {
  for (let n = 0; n < entities.length; n++) {
    const e = entities[n]!;
    forEachFootprintTile(e, width, height, (tile, isEdge, ordinal) => {
      if (top && top[tile] !== n) return;
      const [r, g, b] = levelRgb(bottomZ(e, ordinal) - ground[tile]!);
      const k = isEdge ? EDGE_DARKEN : 1;
      const o = tile * 4;
      rgba[o] = r * k;
      rgba[o + 1] = g * k;
      rgba[o + 2] = b * k;
      rgba[o + 3] = 255;
    });
  }
}
