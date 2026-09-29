/**
 * The vector layers the scene draws from data rather than from a baked raster: logistics
 * zones, transport lines, the power grid, and the hover and selection highlight.
 *
 * Everything here is in world units, which are tiles, and draws untransformed — rotation
 * and the vertical mirror are properties of the camera, applied to the whole world. The
 * ones redrawn per camera change take the zoom, because a stroke width is in world units
 * too: a fixed one is a hairline at whole-map zoom and a fat band close in, so they divide
 * by the zoom to pin the line to screen pixels.
 */
import { Graphics } from 'pixi.js';
import type { Entity, NetworkEdge, Transport, Zone } from '../coimap/schema.gen';
import { hasSparseFootprint } from '../coimap/footprint';
import { parseHex } from '../coimap/terrain';

/**
 * How heavily a zone washes the terrain under it, and how thick its boundary is in screen
 * pixels.
 *
 * The wash is deliberately light. Zones can be large and can overlap the deposit and
 * designation overlays, and the layer has to leave all of that readable — its job is to
 * say where a boundary falls, not to recolour the map.
 */
const ZONE_FILL_ALPHA = 0.16;
const ZONE_EDGE_PX = 2;

/** Packs "#rrggbb" into the 0xrrggbb Pixi wants, borrowing the raster parser's fallback. */
function zoneColor(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return (r << 16) | (g << 8) | b;
}

const TRANSPORT_STYLE: Record<string, { color: number; width: number }> = {
  Conveyor: { color: 0xf0d878, width: 0.55 },
  Pipe: { color: 0x63c8e0, width: 0.55 },
  Unknown: { color: 0xcccccc, width: 0.45 },
};

/**
 * Draws each zone the player drew: its own colour, washed over the area and drawn round
 * the boundary.
 *
 * Redrawn on every camera change rather than built once, for the outline — the fill would
 * not need it, but a Graphics is cleared and rebuilt as a whole, so they go together.
 *
 * Cheap enough to do that with: a world holds a handful of zones of a few vertices each,
 * which is why this needs none of the viewport culling the grid cannot do without.
 */
export function drawZones(g: Graphics, zones: readonly Zone[], zoom: number) {
  // Stroke width is world units; divide by zoom to pin it to screen pixels.
  const px = 1 / zoom;

  for (const zone of zones) {
    const pts = zone.area;
    // Fewer than three vertices is not an area. The exporter already collapses those to
    // an empty ring, so this is the net under a hand-made or future file.
    if (pts.length < 6) continue;

    const color = zoneColor(zone.color);
    g.moveTo(pts[0]!, pts[1]!);
    for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i]!, pts[i + 1]!);
    g.closePath();
    // The ring arrives open — the exporter does not repeat the first vertex — so the
    // path is closed here rather than in the data.
    g.fill({ color, alpha: ZONE_FILL_ALPHA });
    g.stroke({ width: ZONE_EDGE_PX * px, color, alpha: 0.9, join: 'round' });
  }
}

/** Conveyor and pipe runs as polylines through the centres of their tiles. Built once. */
export function buildTransports(transports: readonly Transport[]): Graphics {
  const g = new Graphics();
  for (const t of transports) {
    const pts = t.points;
    if (pts.length < 4) continue;
    g.moveTo(pts[0]! + 0.5, pts[1]! + 0.5);
    for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i]! + 0.5, pts[i + 1]! + 0.5);
    const style = TRANSPORT_STYLE[t.kind] ?? TRANSPORT_STYLE.Unknown!;
    g.stroke({ width: style.width, color: style.color, alpha: 0.95, cap: 'round', join: 'round' });
  }
  return g;
}

/** Power connections as straight lines between the centres of the entities they join. */
export function buildPower(entities: readonly Entity[], edges: readonly NetworkEdge[]): Graphics {
  const g = new Graphics();
  const byId = new Map<number, Entity>(entities.map((e) => [e.id, e]));
  const center = (e: Entity) => [e.x + e.w / 2, e.y + e.h / 2] as const;

  for (const edge of edges) {
    const a = byId.get(edge.a);
    const b = byId.get(edge.b);
    if (!a || !b) continue;
    const [ax, ay] = center(a);
    const [bx, by] = center(b);
    g.moveTo(ax, ay).lineTo(bx, by);
  }
  g.stroke({ width: 0.28, color: 0xffd76a, alpha: 0.5 });
  return g;
}

/** Draws the hover and selection outlines. Pass -1 for none. */
export function drawHighlight(g: Graphics, entities: readonly Entity[], hovered: number, selected: number, zoom: number) {
  g.clear();
  // Outline width is in world units, so divide by zoom to keep it constant on screen.
  const px = 1 / zoom;

  const draw = (index: number, color: number, widthPx: number, fillAlpha: number) => {
    const e = entities[index];
    if (!e) return;

    if (hasSparseFootprint(e)) {
      // A snaking conveyor's bounding box is mostly empty, so outlining it would flash a
      // huge rectangle over unrelated machines. Trace the tiles it actually covers.
      const tiles = e.tiles!;
      for (let i = 0; i + 1 < tiles.length; i += 2) {
        g.rect(e.x + tiles[i]!, e.y + tiles[i + 1]!, 1, 1);
      }
    } else {
      g.rect(e.x, e.y, e.w, e.h);
    }

    if (fillAlpha > 0) g.fill({ color, alpha: fillAlpha });
    g.stroke({ width: widthPx * px, color, alpha: 0.95, alignment: 0.5 });
  };

  if (hovered >= 0 && hovered !== selected) draw(hovered, 0xffffff, 1.5, 0.12);
  if (selected >= 0) draw(selected, 0x4fc3f7, 2.5, 0.2);
}
