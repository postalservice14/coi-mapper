# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

Two version numbers matter here: the **mod version** in `mod/CoiMapper.Exporter/manifest.json`,
and the **`.coimap` schema version** in `schema/coimap.spec.mjs`. A schema bump means existing
`.coimap` files must be re-exported — the web app reports a version mismatch rather than
misrendering them.

## [Unreleased]

### Fixed

- **Terrain rendered saddle brown.** Colours were taken from
  `TerrainMaterialProto.Graphics.Color`, which turns out to be a coarse particle tint rather
  than how the ground looks: grass, lush grass, forest floor, every dirt variant and compost
  all share one brown, and sand is pure yellow. On a real map that is nearly 30% of the
  surface. Natural ground now uses a curated palette keyed on the prototype id, while ores
  and everything else keep the game's colour, which is distinct and correct for them.
- Palette matching is by id prefix rather than substring. `RockNoGrassCover` contains
  "Grass", so rock faces were coming out lawn green.
- The palette missed the bare `Flowers*` materials, which the game presents as grass in bloom
  ("Grass (red flowers)"), plus `FarmGround` and `LandfillOld`. All were falling through to
  the saddle brown particle tint.

- **A large map could render as a black rectangle.** Overlay layers were built even when the
  export contained no plane behind them, so a 13.8M-tile map uploaded 220 MB of texture of
  which 110 MB was fully transparent. Absent layers are now skipped entirely, and the
  renderer's device pixel ratio is capped at 2 so a high-DPI display cannot add a framebuffer
  several times the size of the map itself.
- A renderer failure now says so. `MapScene.create` had no rejection handler and nothing
  listened for `webglcontextlost`, so losing the GPU context left a black canvas and no
  explanation anywhere.
- Layer toggles for data an export does not contain are shown disabled and marked "not
  exported", rather than appearing to work and doing nothing.

- **Closing layer source bitmaps hung the page.** Freeing each `ImageBitmap` after upload
  looks like an easy way to halve GPU memory, but Pixi uploads lazily — on the first frame
  that actually draws a sprite — and the initial fit happens in a `ResizeObserver` callback
  that runs later. Closing the sources first left every texture permanently unuploadable and
  Pixi retrying forever: a black canvas pinned at 100% CPU with the tab unresponsive. The
  sources are kept; the texture budget below makes the doubled footprint affordable instead.
- The smoke test now checks the page stays responsive after a map loads, measuring
  main-thread latency and frame rate. A screenshot-only check cannot tell a rendered map
  from a renderer spinning on an impossible upload.
- Layer rasters are downsampled when a map exceeds a 96 MB texture budget, rather than
  failing to draw. Downsampling keeps the most opaque sample in each block so single-tile
  conveyors survive, and the status bar says when it is in effect.

- The renderer-failure banner reported the map's nominal texture size rather than the actual
  one, so a 2x downsampled map still claimed 110 MB when it was using 27.5 MB. It now reports
  measured figures — real texture bytes, chunk count, canvas backing store, the driver's
  renderer string and its texture and renderbuffer limits.
- The canvas backing store is capped at 4096 pixels on its longest edge. A renderbuffer larger
  than the driver's limit does not fail politely, it drops the context, and on a 2x display any
  window wider than 2048 CSS pixels crosses the smallest limit still in the wild.

- Loading now logs each stage to the console under a `[coi-mapper]` prefix, along with the
  renderer's name and limits. The failure banner cannot help when the page hangs, because a
  blocked main thread never paints it; console output written before the hang survives, so
  the last line logged shows where it stopped.
- Adds `?safe=1`, which renders the whole map as one small texture per layer at device pixel
  ratio 1. Deliberately low quality, but it isolates whether a rendering failure is about
  scale at all.

- **The initial fit depended on a `ResizeObserver` callback that could never arrive.** The
  camera was only ever positioned from inside that callback, and the callback resized the
  renderer synchronously — which rewrites the canvas's inline size, a layout change made
  from inside a resize observer, and so can re-enter it. When that happened the world was
  never positioned: left at scale 1 over the map's top-left corner, which on an
  ocean-cornered map is a black screen, with the main thread busy in the cycle.

  The scene now fits immediately on creation whenever the host is already laid out. The
  observer only handles later changes, ignores notifications that do not change the size,
  and defers its work to the next animation frame instead of mutating layout inline.

- **The map was blank in development only.** React StrictMode mounts every effect, tears it
  down and mounts it again — in development builds. The scene was built on a React-owned
  `<canvas>`, and a canvas element holds exactly one graphics context for its entire life, so
  the second mount inherited a dead one. Under WebGL that produced a correct frame in the
  drawing buffer that never reached the screen; under WebGPU `getContext` simply returned
  null. The scene now creates and owns its own canvas, so each mount starts clean.
- The browser test can run against the dev server (`npm run smoke:dev`). Every previous run
  used the production build, where StrictMode does not double-invoke, which is why this was
  invisible to the whole suite.

- Diagnostic logging is silent unless `?debug=1`, and the pixel readback it performs is
  skipped entirely otherwise.
- The texture budget is raised to 320 MB. It was set to 96 MB while a blank map was wrongly
  attributed to memory pressure, which downsampled maps that never needed it; the real cause
  was a reused canvas context. The budget stays as a backstop for genuinely enormous maps.

### Planned

- Conveyor and pipe polylines, and the electricity and mechanical power graphs
- Ore deposit and terrain designation planes
- Building icons extracted from the game's sprite atlas
- A hosted build of the web app, so viewing a map needs no local toolchain

## [0.2.0] — 2026-08-26

Mod version 0.2.0 · `.coimap` schema **2** (re-export required)

### Added

- Export now runs after **every save**, not just on world load, so refreshing the map no
  longer means reloading the world. There is deliberately no keyboard shortcut: key bindings
  live in `Mafi.Unity`, and the simulation layer this mod targets has no notion of them.
- Exports are named after the save rather than always `world.coimap`, so several bases no
  longer overwrite one another.
- The manifest now carries the repository, changelog and licence links, the game versions the
  mod is built and verified against, and a rich description for the in-game mod browser.

### Fixed

- **Conveyors and pipes were rendered as enormous solid rectangles.** Entities were exported
  as the bounding box of their occupied tiles, which describes a machine perfectly but not a
  belt that snakes across the factory — one `FlatConveyorT3` reported a 438×182 box while
  covering only a few hundred tiles. Entities now carry the tiles they really occupy whenever
  that differs from their box, and rasterising, hit-testing, highlighting and the inspector
  all read footprints through one shared helper.
- **Terrain rendered in teal and magenta.** Material colours were guessed from prototype
  names, which could not match the game's real ids (`ForestFloor_Terrain`,
  `BauxiteDisrupted_Terrain`). Colours now come from each material's own graphics, so modded
  materials work without changes.
- The slim-id manager's phantom material was listed in the legend as a real surface, and
  surfaces showed raw prototype ids instead of localised names.
- The mod manifest was missing the mandatory `primary_dlls` field and used `name`, `author`
  and `description` where the game expects `display_name`, `authors` and
  `description_short`/`description_long`. A malformed manifest is skipped silently, so the
  mod would never have loaded. `can_add_to_saved_game` was missing too, which would have
  restricted the mod to newly created worlds.
- The map canvas ignored its container resizing, leaving gutters and overlapping the
  inspector panel, and fitted itself against a stale layout size so the map was offset and
  clipped on load.
- The synthetic fixture embedded the thumbnail from a real save. It now renders its own.

### Changed

- The synthetic fixture grew snaking trunk conveyor runs. It previously modelled conveyors
  only as network polylines and so never exercised the sparse-footprint path — the very bug
  above shipped past a green test suite because of it.

## [0.1.0] — 2026-08-26

Mod version 0.1.0 · `.coimap` schema 1

### Added

- Web app: hillshaded terrain, rasterised building footprints, network and designation
  overlays, layer toggles, search, and a click-to-inspect panel. Parsing and texture building
  run in a worker; hit-testing is a flat array lookup.
- Exporter mod: terrain, buildings and prototypes, written against the decompiled game APIs.
- `.coimap` format: a ZIP of JSON metadata plus per-tile binary raster planes, defined by one
  spec that generates both the TypeScript and C# bindings.
- Cross-language contract test that runs the exporter's own writer classes off-game and reads
  the result with the real TypeScript parser.
- Save-format analysis in [`docs/save-format.md`](docs/save-format.md), explaining why saves
  cannot practically be parsed outside the game.

[Unreleased]: https://github.com/postalservice14/coi-mapper/compare/main...HEAD
[0.2.0]: https://github.com/postalservice14/coi-mapper/releases/tag/v0.2.0
[0.1.0]: https://github.com/postalservice14/coi-mapper/releases/tag/v0.1.0
