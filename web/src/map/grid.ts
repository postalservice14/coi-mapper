/**
 * Tile grid overlay, matched to the game's own terrain grid.
 *
 * Three nested levels: a line per tile, a stronger one every 16 tiles, and the heavy dark one
 * every 128 — eight 16-cells — so zooming into one 16-cell shows the 16x16 tiles inside it.
 *
 * The steps are fixed. Nothing scales them with the camera; instead each level fades on its
 * own on-screen spacing, dropping the tile lines first, then the 16s, leaving the 128s.
 *
 * This module only strokes lines into a world rect it is handed. Working out which rect is
 * on screen is the scene's job, because that is a screen-to-tile conversion and the camera
 * keeps every one of those in one place.
 */
import type { Graphics } from 'pixi.js';

const GRID_TILE_TILES = 1;
const GRID_MINOR_TILES = 16;
const GRID_MAJOR_TILES = 128;
/**
 * Where the heavy grid starts, in tiles, relative to tile (0,0).
 *
 * Zero: the grid is aligned to the map origin. Map sizes are whole multiples of 128 — 3584 is
 * 28 and 3840 is 30 — so the heavy lines meet the map edges exactly. An earlier build drew
 * this level every 96 tiles, which does not divide 3584, and the resulting drift looked like a
 * misplaced grid rather than a wrong step; the knob is kept so that is cheap to test again.
 *
 * If it ever is non-zero, note that a negative Y moves lines *down* the screen: the map is
 * drawn mirrored (see the scene's setZoom).
 */
const GRID_MAJOR_OFFSET_TILES = 0;
/** Each level fades in across this band of on-screen spacing, in pixels. */
const GRID_TILE_FADE_PX = { from: 6, to: 14 };
const GRID_MINOR_FADE_PX = { from: 9, to: 26 };
const GRID_COLOR = 0x000000;
const GRID_TILE_ALPHA = 0.16;
const GRID_MINOR_ALPHA = 0.4;
const GRID_MAJOR_ALPHA = 0.8;
/**
 * Heavy lines thin out as they crowd, rather than changing step or disappearing.
 *
 * On a 3584x3840 export the 128-tile lines land about 26px apart when the whole map is on
 * screen, and at full strength that is a black mesh over the entire base. Fading them keeps
 * the steps the game's while leaving the map readable at any zoom.
 */
const GRID_MAJOR_TIGHT_SPACING_PX = 20;
const GRID_MAJOR_CLEAR_SPACING_PX = 60;
const GRID_MAJOR_FAINT_ALPHA = 0.18;

/** One level of the grid: how often its lines fall, and where they start. */
interface GridLevel {
  step: number;
  offset: number;
}

/** A rect of whole tiles, `x1`/`y1` exclusive, already clamped to the map. */
export interface TileRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Draws the grid over `view` at `zoom` screen pixels per tile, and returns the finest step
 * now on screen — `"1"`, `"16"` or `"128"` — so a test can tell the states apart.
 *
 * Only the lines inside the viewport are emitted. Spanning the whole map would be
 * thousands of segments on a large export — 7,400 on a 3584x3840 one — where culling
 * to the viewport caps it in the low hundreds, cheap enough to redraw on every pan.
 */
export function drawGrid(g: Graphics, view: TileRect, zoom: number): string {
  const { x0, y0, x1, y1 } = view;

  // Stroke widths are world units, so divide by zoom to pin them to screen pixels.
  const px = 1 / zoom;

  // Each level fades on its own on-screen spacing rather than on zoom: spacing is what
  // decides whether lines read as a grid or as a grey wash, and the same zoom means very
  // different spacing at each step.
  const fade = (spacing: number, band: { from: number; to: number }) =>
    Math.max(0, Math.min(1, (spacing - band.from) / (band.to - band.from)));

  const tileAlpha = GRID_TILE_ALPHA * fade(zoom, GRID_TILE_FADE_PX);
  const minorAlpha = GRID_MINOR_ALPHA * fade(GRID_MINOR_TILES * zoom, GRID_MINOR_FADE_PX);

  const tiles = { step: GRID_TILE_TILES, offset: 0 };
  const minor = { step: GRID_MINOR_TILES, offset: 0 };
  const major = { step: GRID_MAJOR_TILES, offset: GRID_MAJOR_OFFSET_TILES };

  // Every level skips the lines the level above already owns, so a shared line is drawn
  // once at its strongest weight instead of being painted over.
  if (tileAlpha > 0.01) strokeGridLines(g, tiles, minor, x0, y0, x1, y1, px, tileAlpha);
  if (minorAlpha > 0.01) strokeGridLines(g, minor, major, x0, y0, x1, y1, px, minorAlpha);

  const majorRamp = Math.max(0, Math.min(1,
    (GRID_MAJOR_TILES * zoom - GRID_MAJOR_TIGHT_SPACING_PX)
    / (GRID_MAJOR_CLEAR_SPACING_PX - GRID_MAJOR_TIGHT_SPACING_PX)));
  strokeGridLines(g, major, null, x0, y0, x1, y1, 2 * px,
    GRID_MAJOR_FAINT_ALPHA + (GRID_MAJOR_ALPHA - GRID_MAJOR_FAINT_ALPHA) * majorRamp);

  const finest = tileAlpha > 0.01 ? GRID_TILE_TILES
    : minorAlpha > 0.01 ? GRID_MINOR_TILES : GRID_MAJOR_TILES;
  return String(finest);
}

/**
 * Strokes one level of the grid across the visible rect.
 *
 * `owner` is the level above, whose lines this one leaves alone: a line belonging to the
 * heavy pass drawn twice would darken unevenly rather than cleanly. Both levels carry an
 * offset so the grid can be shifted off the map origin without the ownership test drifting
 * out of step with what is actually drawn.
 */
function strokeGridLines(
  g: Graphics,
  level: GridLevel, owner: GridLevel | null,
  x0: number, y0: number, x1: number, y1: number,
  width: number, alpha: number,
) {
  // First line of `level` at or after `v0`, and whether `v` is one of `owner`'s.
  const start = (v0: number) =>
    Math.ceil((v0 - level.offset) / level.step) * level.step + level.offset;
  const ownedBy = (v: number) =>
    owner !== null && (((v - owner.offset) % owner.step) + owner.step) % owner.step === 0;

  for (let x = start(x0); x <= x1; x += level.step) {
    if (ownedBy(x)) continue;
    g.moveTo(x, y0);
    g.lineTo(x, y1);
  }
  for (let y = start(y0); y <= y1; y += level.step) {
    if (ownedBy(y)) continue;
    g.moveTo(x0, y);
    g.lineTo(x1, y);
  }
  g.stroke({ width, color: GRID_COLOR, alpha, alignment: 0.5 });
}
