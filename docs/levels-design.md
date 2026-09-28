# Showing levels on a 2D map — design

Status: all three steps are implemented — exporter heights with stacked picking, colour by height, and the level filter.

## Problem

Conveyors and pipes stack. A pipe at level 1 under a flat conveyor at level 2 occupies
the same tile, and the map today can neither show which is on top nor let you pick the
lower one. The `.coimap` format has no vertical axis: `Entity` is `x, y, w, h, rot`, and
the web's hit-test index (`buildTileIndex` in `web/src/coimap/parse.ts`) stores one entity
per tile — the last one written wins.

## What the game actually stores

Verified against a decompile of `mod/lib/Mafi.Core.dll` (ilspycmd 11.0):

| Fact | Where |
|---|---|
| A transport's path is `ImmutableArray<Tile3i> Pivots` — absolute tile coordinates, Z included. | `TransportTrajectory.Pivots`, reached via `Transport.Trajectory` |
| `Tile3i.Z` is an `int` in tile units; `Tile3i.Height` wraps it as `HeightTilesI`. | `Mafi/Tile3i.cs` |
| Every static entity exposes `Tile3i CenterTile` on the interface. | `IStaticEntity.CenterTile` |
| Every `OccupiedTileRelative` carries a vertical extent: `FromHeightRel` (bottom, relative to `CenterTile.Height`) and `VerticalSize`, both `ThicknessTilesI`. | `OccupiedTileRelative` |
| For transports those per-tile extents are computed from the trajectory: `From - origin.Height`, one entry per occupied tile range. | `TransportHelper.ComputeOccupiedTilesRelative` |
| Terrain height (`TerrainManager.GetHeight`, already written to the `height` plane) is `HeightTilesF` — the same unit as `Tile3i.Z`. | `WorldExporter.WriteTerrain` |

**Important consequence:** transports are ordinary static entities. `WorldExporter.Describe`
already iterates their `OccupiedTiles` for the footprint and throws the height away (it
even de-duplicates "several entries per tile (different vertical extents)"). So per-tile
height is available *today*, for every entity, from the walk we already run. It does
**not** wait on `networks.json` being populated.

Not verified: what the in-game "Height: {0}" tooltip (`Tr.TransportHeightTooltip`) is
measured from. The builder UI lives in the Unity assembly we don't have. This design
reports height above terrain, which is what "level 1 / level 2" means to a player; confirm
against a real export by comparing a known-flat conveyor with the in-game tooltip.

## Format change

Add to `Entity` in `schema/coimap.spec.mjs`:

| Field | Type | Meaning |
|---|---|---|
| `z0` | int | Lowest occupied bottom, absolute tile Z: `CenterTile.Z + min(FromHeightRel)`. |
| `z1` | int | Highest occupied top, absolute, exclusive: `CenterTile.Z + max(FromHeightRel + VerticalSize)`. |
| `tz` | int[] | Per-tile bottom Z, absolute, one per `[dx,dy]` pair in `tiles`, in the same order. Empty when `tiles` is empty. Where a tile has several entries, the lowest bottom. |

The ranges are absolute, not relative to the ground. The browser subtracts the dequantised
`height` plane (`minHeight + v / 65535 * (maxHeight - minHeight)`), so the terrain lookup
happens in one place and an "absolute" view comes for free. `tz` is per tile because a
single belt ramps. A whole-entity level would put a ramp from 0 to 3 in one bucket.

`SCHEMA_VERSION` stays at 2. `parse.ts` already treats an *added* field as non-breaking —
the census and zones arrived the same way — because bumping would make every existing
export unreadable to gain nothing. An older export reads with `hasLevels: false`: stacks
fall back to write order and no level is shown, rather than a false "on the ground".

One exporter rule changed with it: an entity drops its `tiles` list only when it fills its
box *and* every tile sits at one height. A straight belt fills its 1×N box, and dropping
its list would have flattened its ramp to `z0`.

`Transport.points` stays as it is for now. When networks are exported, make the points
`[x,y,z,…]` triples from `Pivots` — that is a separate change.

## Web

In priority order. Each step ships on its own.

1. **Stacked picking.** Keep `tileToEntity` as the index of the *topmost* entity per tile
   (highest `tz`/`z1`, not the last written). Add a sparse `Map<tile, number[]>` for the few
   tiles with more than one occupant, sorted top-down. The sidebar lists the whole stack
   (`L2 Flat conveyor / L1 Pipe`). Clicking the same tile again cycles through it. This fixes
   the one-entity-per-tile bug on its own and needs only `tz`.
2. **Colour by height.** A mode of the buildings layer, not a layer: the worker stays
   alive after the load and re-bakes that one layer on request, and the scene swaps its
   chunks in place. A separate layer was the first plan and would have cost every layer
   its resolution on a large map (see *Rendering cost*). The scale is diverging around the
   ground — grey at 0, blue stepping lighter per level up to "+6 and up", red below — and
   applies to everything, not only transports, because the elevated rail is as much what
   the view is for as the belts. Over water the terrain is the sea floor, so a level there
   is height above the seabed; the export has no sea level to measure from instead.
3. **Level range filter + slice.** Two sliders, Lowest and Highest, over the legend's stops
   (below ground … +6 and up; the end stops are open, so the full range filters nothing).
   A transport tile shows when its one-level-thick span falls in the band; a building when
   `[z0, z1)` overlaps it. Everything outside is faded to ~15% rather than hidden — for the
   band as well as the slice, one behaviour instead of two. The filter outranks height in
   the tile index (`buildTileIndex`'s `prefer`), so what it shows is what is painted on top
   and what a click picks. The slice keys are `,` / `.`, not `[` / `]`: those already turn
   the map. `/` clears the filter.

### Rendering cost

Entity rasters are baked once, in the worker, into `ImageBitmap` chunks. The worker is
terminated after a load (`useCoiMap` spawns a fresh one per load), so filtering needs one of:

- **Re-bake on commit** (built for step 2, reused by step 3): keep the worker alive after the load, send
  it the range when the slider is *released* (not on every drag frame), and swap the
  returned bitmaps in. At 26,736 entities the rasterisation is cheap. The texture upload is
  the real cost, and the chunking already bounds it.
- **Bake per level**: one layer per distinct level, then toggle visibility. Instant, but
  multiplies texture memory against the 320 MB budget. Revisit only if re-bake feels slow.

Rotation is unaffected: all of this is data and colour, not geometry. `screenToWorld()`
still returns the tile, and the stack lookup is keyed by tile.

## Exporter

Two small changes in `WorldExporter.Describe`:

- Track `min(FromHeightRel.Value)` and `max(FromHeightRel.Value + VerticalSize.Value)`
  while it already loops over `occupied`. Add `CenterTile.Z` to get `z0` and `z1`.
- Change the de-dup of `covered` from a `HashSet<int>` to a `Dictionary<int, int>` of tile →
  lowest bottom, and emit `tz` alongside `tiles`.

The writer classes stay free of game types (`Schema/` only sees ints), so
`CoiMapper.SchemaCheck` and the contract test keep working. Extend `npm run fixture` so the
synthetic map has a crossing: a pipe at level 1 under a conveyor at level 2, plus one
ramp. That way `smoke` can assert the stack list and the filter.

## Open questions

- Is "level above terrain" what the tooltip shows, or absolute Z? This only changes the
  label and the default, not the format, because both are derivable.
- Should buildings be affected by the filter at all, or only transports? The proposal
  includes them, via `[z0, z1)`, because a filter that hides "things above level 2" should
  hide a tall building's upper floors too. But most people will use it for belts.
