/**
 * Turns raster planes into RGBA textures. Pure and DOM-free so it runs in a worker.
 *
 * Separate textures rather than one composite: the overlays can then be toggled and
 * re-tinted without recomputing the (expensive) terrain hillshade — which is itself baked
 * once into a shared buffer, since paving is lit by the same light as the ground it covers.
 */
import { DESIGNATION_BITS } from './schema.gen';
import type { Manifest, TileSurface } from './schema.gen';
import type { Planes } from './types';

/**
 * Light direction for hillshading: from the north-west, 45° above the horizon.
 *
 * Positive Y is north here, because the rows count northward in the game's tile space —
 * and the map is drawn mirrored for that reason. Lighting from -Y would put the sun at
 * the bottom of the screen, where shading reads inside out and hills look like valleys.
 */
const LIGHT = (() => {
  const [x, y, z] = [-0.6, 0.6, 0.75];
  const len = Math.hypot(x, y, z);
  return { x: x / len, y: y / len, z: z / len };
})();

/** Fraction of a surface's colour that shows regardless of slope. */
const AMBIENT = 0.55;

/** Undoes the 0-255 quantisation of the shared shade buffer. */
const SHADE_SCALE = 1 / 255;

/**
 * Opacity of player-placed paving. Just short of opaque: concrete genuinely replaces the
 * ground in game rather than tinting it, but leaving a trace of the terrain through keeps
 * the map's relief readable across a large paved base.
 */
const PAVING_ALPHA = 245;

/**
 * Target gradient magnitude for a *typical* land tile after scaling. Relief is then
 * derived per map so the median slope always lands here — a fixed constant would look
 * flat on a gentle map and blown out on a mountainous one.
 */
const TARGET_SLOPE = 0.8;

const DESIGNATION_COLORS: [number, string][] = [
  [DESIGNATION_BITS.Mine, '#e0873a'],
  [DESIGNATION_BITS.Dump, '#a4623a'],
  [DESIGNATION_BITS.Forestry, '#54b35a'],
  [DESIGNATION_BITS.Surface, '#9ccc65'],
  [DESIGNATION_BITS.Unreachable, '#e04a4a'],
];

/** Parses "#rrggbb" into an [r, g, b] triple. Falls back to mid-grey. */
export function parseHex(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
  if (!m) return [128, 128, 128];
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * RGBA pixel buffer. The buffer type is pinned to `ArrayBuffer` (not `ArrayBufferLike`)
 * so these can be handed straight to `ImageData`, which rejects shared buffers.
 */
export type Rgba = Uint8ClampedArray<ArrayBuffer>;

/**
 * Overlay layers are `null` when the export has no plane to draw them from, rather than a
 * fully transparent buffer. On a large map each layer is tens of megabytes of texture, and
 * uploading empty ones wastes GPU memory that a big base cannot spare.
 */
export interface TerrainTextures {
  terrain: Rgba;
  surfaces: Rgba | null;
  deposits: Rgba | null;
  designations: Rgba | null;
}

export function buildTextures(planes: Planes, manifest: Manifest): TerrainTextures {
  const { width, height } = manifest.map;
  const tiles = width * height;

  const heights = planes.height!;
  const surface = planes.surface!;
  const deposit = planes.deposit;
  const depositAmount = planes.depositAmount;
  const designation = planes.designation;

  // Surface legend → flat lookup tables, so the hot loop does no object access.
  const maxSurfaceId = manifest.surfaces.reduce((m, s) => Math.max(m, s.id), 0);
  const surfR = new Uint8Array(maxSurfaceId + 1).fill(128);
  const surfG = new Uint8Array(maxSurfaceId + 1).fill(128);
  const surfB = new Uint8Array(maxSurfaceId + 1).fill(128);
  const isWater = new Uint8Array(maxSurfaceId + 1);
  for (const s of manifest.surfaces) {
    const [r, g, b] = parseHex(s.color);
    surfR[s.id] = r; surfG[s.id] = g; surfB[s.id] = b;
    isWater[s.id] = s.water ? 1 : 0;
  }

  const relief = computeRelief(heights, surface, isWater, width, height);
  const shading = computeShade(heights, width, height, relief);
  const terrain = new Uint8ClampedArray(tiles * 4);

  // Water depth is shaded against the shallowest water on the map, not absolute zero,
  // so coastlines read clearly whatever the map's height range happens to be.
  let maxWaterHeight = 0;
  for (let i = 0; i < tiles; i++) {
    if (isWater[surface[i]!]) maxWaterHeight = Math.max(maxWaterHeight, heights[i]!);
  }

  for (let i = 0; i < tiles; i++) {
    const s = surface[i]!;
    const o = i * 4;

    if (isWater[s]) {
      // Deeper water is darker and slightly bluer.
      const depth = maxWaterHeight > 0 ? 1 - heights[i]! / maxWaterHeight : 0;
      const k = 1 - Math.min(0.6, depth * 1.4);
      terrain[o] = surfR[s]! * k;
      terrain[o + 1] = surfG[s]! * k;
      terrain[o + 2] = surfB[s]! * (k * 0.85 + 0.15);
      terrain[o + 3] = 255;
      continue;
    }

    const shade = shading[i]! * SHADE_SCALE;
    terrain[o] = surfR[s]! * shade;
    terrain[o + 1] = surfG[s]! * shade;
    terrain[o + 2] = surfB[s]! * shade;
    terrain[o + 3] = 255;
  }

  return {
    terrain,
    surfaces: buildTileSurfaceOverlay(manifest, tiles, shading, planes.tileSurface),
    deposits: buildDepositOverlay(manifest, tiles, deposit, depositAmount),
    designations: buildDesignationOverlay(tiles, designation),
  };
}

/**
 * Per-tile hillshade, quantised to 0-255.
 *
 * Baked once and shared by every layer that sits on the ground, so terrain and paving are
 * lit identically and the gradient maths lives in one place. 256 levels is plenty: the
 * textures it feeds are 8-bit anyway.
 */
function computeShade(
  heights: Uint8Array | Uint16Array,
  width: number,
  height: number,
  relief: number,
): Uint8ClampedArray {
  // Clamped rather than plain Uint8: it rounds on assignment where Uint8Array truncates,
  // which would darken every tile by up to a level for nothing.
  const shade = new Uint8ClampedArray(width * height);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    // Clamp gradient sampling at the borders rather than wrapping to the far edge.
    const up = y > 0 ? -width : 0;
    const down = y < height - 1 ? width : 0;

    for (let x = 0; x < width; x++) {
      const i = row + x;
      const left = x > 0 ? -1 : 0;
      const right = x < width - 1 ? 1 : 0;
      const dzdx = (heights[i + right]! - heights[i + left]!) * relief;
      const dzdy = (heights[i + down]! - heights[i + up]!) * relief;

      // Surface normal is (-dz/dx, -dz/dy, 1); shade by its dot with the light.
      const nlen = Math.hypot(dzdx, dzdy, 1);
      const dot = (-dzdx * LIGHT.x - dzdy * LIGHT.y + LIGHT.z) / nlen;
      shade[i] = (AMBIENT + (1 - AMBIENT) * Math.max(0, dot)) * 255;
    }
  }
  return shade;
}

/**
 * Chooses a vertical exaggeration from the map's own relief.
 *
 * Samples gradient magnitudes across land tiles and scales so the median tile reaches
 * `TARGET_SLOPE`. The median (rather than the mean) keeps a handful of cliffs from
 * flattening everything else.
 */
function computeRelief(
  heights: Uint8Array | Uint16Array,
  surface: Uint8Array | Uint16Array,
  isWater: Uint8Array,
  width: number,
  height: number,
): number {
  const samples: number[] = [];
  // Stride by a prime so the sample pattern does not align with map features.
  const stride = Math.max(1, Math.floor((width * height) / 20000)) * 7 + 1;
  for (let i = width + 1; i < width * (height - 1) - 1; i += stride) {
    if (isWater[surface[i]!]) continue;
    const dx = heights[i + 1]! - heights[i - 1]!;
    const dy = heights[i + width]! - heights[i - width]!;
    samples.push(Math.hypot(dx, dy));
  }
  if (samples.length === 0) return 1 / 4096;

  samples.sort((a, b) => a - b);
  const median = samples[samples.length >> 1]!;
  // A perfectly flat map has no slope to normalise against; any value renders the same.
  return median > 0 ? TARGET_SLOPE / median : 1 / 4096;
}

/**
 * Player-placed paving — concrete, brick, metal flooring.
 *
 * Unlike the deposit and designation overlays this is not a tint: it is drawn near-opaque
 * and shaded with the same hillshade as the terrain underneath, because paving replaces
 * the ground rather than marking it. Without the shading a large paved base reads as a
 * flat grey hole punched through the relief.
 */
function buildTileSurfaceOverlay(
  manifest: Manifest,
  tiles: number,
  shading: Uint8ClampedArray,
  tileSurface?: Uint8Array | Uint16Array,
): Rgba | null {
  if (!tileSurface) return null;

  const legend: TileSurface[] = manifest.tileSurfaces ?? [];
  const maxId = legend.reduce((m, t) => Math.max(m, t.id), 0);
  if (maxId === 0) return null;

  const [r, g, b] = [new Uint8Array(maxId + 1), new Uint8Array(maxId + 1), new Uint8Array(maxId + 1)];
  for (const t of legend) {
    const [tr, tg, tb] = parseHex(t.color);
    r[t.id] = tr; g[t.id] = tg; b[t.id] = tb;
  }

  const rgba = new Uint8ClampedArray(tiles * 4);
  for (let i = 0; i < tiles; i++) {
    const id = tileSurface[i]!;
    // 0 is the game's phantom surface id and already means "unpaved"; no shift is applied
    // to these ids, unlike the natural-ground `surface` plane.
    if (id === 0 || id > maxId) continue;

    const shade = shading[i]! * SHADE_SCALE;
    const o = i * 4;
    rgba[o] = r[id]! * shade;
    rgba[o + 1] = g[id]! * shade;
    rgba[o + 2] = b[id]! * shade;
    rgba[o + 3] = PAVING_ALPHA;
  }
  return rgba;
}

function buildDepositOverlay(
  manifest: Manifest,
  tiles: number,
  deposit?: Uint8Array | Uint16Array,
  amount?: Uint8Array | Uint16Array,
): Rgba | null {
  if (!deposit) return null;
  const rgba = new Uint8ClampedArray(tiles * 4);

  const maxId = manifest.deposits.reduce((m, d) => Math.max(m, d.id), 0);
  const [r, g, b] = [new Uint8Array(maxId + 1), new Uint8Array(maxId + 1), new Uint8Array(maxId + 1)];
  for (const d of manifest.deposits) {
    const [dr, dg, db] = parseHex(d.color);
    r[d.id] = dr; g[d.id] = dg; b[d.id] = db;
  }

  for (let i = 0; i < tiles; i++) {
    const id = deposit[i]!;
    if (id === 0 || id > maxId) continue;
    const o = i * 4;
    // Richer deposits read as more opaque, with a floor so thin seams stay visible.
    const strength = amount ? amount[i]! / 65535 : 1;
    rgba[o] = r[id]!;
    rgba[o + 1] = g[id]!;
    rgba[o + 2] = b[id]!;
    rgba[o + 3] = 90 + strength * 130;
  }
  return rgba;
}

function buildDesignationOverlay(tiles: number, designation?: Uint8Array | Uint16Array): Rgba | null {
  if (!designation) return null;
  const rgba = new Uint8ClampedArray(tiles * 4);

  const colors = DESIGNATION_COLORS.map(([bit, hex]) => ({ bit, rgb: parseHex(hex) }));
  for (let i = 0; i < tiles; i++) {
    const bits = designation[i]!;
    if (bits === 0) continue;
    // Average the colours of every designation on the tile so overlaps stay legible.
    let r = 0, g = 0, b = 0, n = 0;
    for (const c of colors) {
      if (bits & c.bit) { r += c.rgb[0]; g += c.rgb[1]; b += c.rgb[2]; n++; }
    }
    if (n === 0) continue;
    const o = i * 4;
    rgba[o] = r / n;
    rgba[o + 1] = g / n;
    rgba[o + 2] = b / n;
    rgba[o + 3] = 110;
  }
  return rgba;
}
