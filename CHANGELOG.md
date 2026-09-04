# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

Two version numbers matter here: the **mod version** in `mod/CoiMapper.Exporter/manifest.json`,
and the **`.coimap` schema version** in `schema/coimap.spec.mjs`. A schema bump means existing
`.coimap` files must be re-exported — the web app reports a version mismatch rather than
misrendering them.

## [Unreleased]

### Added

- **A count of every vehicle and train car, behind a "Vehicles" button in the header.** The
  export had no fleet data at all: vehicles are *dynamic* entities, and the exporter's walk
  is over `IStaticEntity`, so trucks and excavators were invisible to it by construction —
  the only truck-shaped things in an export were buildings like the vehicle depot and ramps.
  The mod now reads the vehicles manager and the trains manager and counts machines per
  prototype, and appends the fuel each one burns: "97 Haul truck (dump) (Diesel)". That last
  part is not decoration. `TruckT3Loose` and `TruckT3LooseH` are separate prototypes with the
  same name, differing only in diesel versus hydrogen, and the game tells them apart by icon —
  which a list of names cannot borrow. Locomotives and cargo wagons are counted the same way, with the
  number of assembled trains reported alongside rather than as a row of its own. The panel
  also shows the vehicle quota, which is the one figure that can be checked against the
  game's own screen.

  The panel also groups by **logistics zone**, the way the game partitions the road fleet.
  A "Group by: Kind / Zone" switch in the header repivots the same list, so a zone that is
  short of haul trucks is one click away rather than something to work out from the game's
  own screens. The census stores one row per prototype *per zone* — the finest grain there
  is — and each view totals up from it, which is why the switch changes no numbers: the same
  fleet, cut two ways. Zones carry the colour and name the player gave them in game. Train
  cars have no zone at all — logistics zones are a road-fleet concept — so they collect into
  a trailing "Trains" section instead of being forced into one. The switch appears only where
  there is more than one zone to separate.

  Counts only — no positions — so this does not put vehicles on the map, which would need a
  further format change. Zones are exported as identity only, not as the map areas they
  actually are; drawing them would need the zone polygon.

  The schema version is deliberately **not** bumped, for the census or for the zones added
  to it. Both are added fields, and an added field is not a breaking change: exports written
  before them still load, reporting the fleet as not counted and offering no zone grouping. Bumping would have made every existing export unreadable to gain
  nothing. That "not counted" state is an explicit flag rather than an empty list, because an
  empty list is a real answer for a world with no vehicles.

  Rocket transporters are counted and exported but not listed: they are campaign
  equipment rather than fleet, and they consume no vehicle quota, so including one made
  the panel's total disagree with the game's own. They carry their own kind rather than
  falling into "Other", which keeps that group meaning "the exporter did not recognise
  this" — something that should always be shown.

  Cargo ships are not counted; they have no equivalent fleet manager.

  Like the deposit, designation and paving layers, this is compile-verified against the real
  game assemblies and covered by the cross-language contract test, but has **not yet been run
  in the game** — that is still the real check. The zone read adds one more manager to that
  list: a vehicle whose zone the game reports as unset is filed under the default zone, which
  is what the game means by it, and failing to resolve the zones manager costs the grouping
  and nothing else.

- **A "Surfaces" layer for player-placed paving** — concrete, brick, metal flooring — in a new
  optional `tileSurface` plane with its own legend. This is a genuinely new read: the existing
  `surface` plane is a misnomer that carries the *natural ground material*, so nothing on the
  map previously showed what had been paved. Paving is drawn near-opaque and hillshaded with
  the same relief as the terrain under it, so turning the layer on makes the base read as
  actually paved rather than tinted, and the status bar and inspector now report ground and
  surface as separate values.

  The schema version is deliberately **not** bumped. The plane is optional and a missing
  legend defaults to empty, so exports written before this change still load and simply show
  "Surfaces — not exported", the same as any other absent overlay.

  A surface prototype carries no map colour — unlike a terrain material, its graphics hold only
  a texture and an icon — so the colours come from a new curated `SurfacePalette`, kept separate
  from `MaterialPalette` because ids like `Cobblestone` and `Sand` exist in both and mean
  different things.

- **The exporter now writes deposits and designations.** Deposits are the game's *virtual*
  resources — the oil and water bodies a pump draws from, not ores, which are ordinary terrain
  materials the surface plane already carries — and come with a legend and a per-tile richness
  taken from each body's thickness. Designations carry mining and dumping, decided per tile:
  a designation holds a target height rather than a mine-or-dump flag, so one drawn across a
  slope correctly produces both. Player-placed surface designations are included as well.
  Forestry and unreachable keep their bits reserved but are not written — forestry is a
  tower's managed area rather than a terrain designation, and unreachable is per-vehicle
  pathfinding state, so neither has a map-wide set to read. Each plane is written inside its
  own guard: they are optional in the format, so a manager renamed by a future game version
  costs one layer instead of the whole export.

- **Rotate the map in 90° steps**, from a pair of buttons floated over the bottom-right of the
  map or with the `[` and `]` keys. A base is rarely built to suit north-up, and the in-game
  camera turns freely, so this makes the two easier to line up. Only the view turns: tile
  coordinates stay in map space everywhere they are reported, nothing is re-parsed, and no
  texture is re-baked, so a turn is instant on any size of map. The view turns about the
  middle of the screen, so whatever you are looking at stays put, and fitting to the map
  (`F`) accounts for the orientation — a tall map fits differently once it is lying on its
  side. One known limitation: hillshading is baked into the terrain lit from the north-west,
  so the apparent sun turns with the map, and at 180° hills can read as valleys. This is the
  same effect as turning a printed map round.

- **Tile grid overlay**, replicating the game's own terrain grid: a line per tile, a stronger
  one every 16 tiles, and a heavy one every 128. It is on by default and toggles from the
  sidebar like any other layer. Each level fades out as you zoom away from it, so the grid
  stays readable at every zoom. The grid draws over buildings, as it does in the game, so you
  can see how a machine sits within a cell.

### Fixed

- **The grid used the wrong steps.** The heavy step was picked per frame by doubling until the
  lines were far enough apart, so it landed on 256 or 1024 as readily as on anything meaningful
  — the grid changed shape as you zoomed instead of describing the map. It is now three fixed,
  nested levels matching the game: a line per tile, a stronger one every 16, and the heavy dark
  one every 128 — eight 16-cells — so zooming into one 16-cell shows the 16x16 tiles inside it,
  and the heavy lines meet the edges of a map whose size is a whole multiple of 128. Each level
  fades on its own on-screen spacing rather than on zoom, and the heavy lines thin as they
  crowd instead of changing step, which keeps a whole-map view of a large export from turning
  into a black mesh.

- **The map was drawn upside down.** Tile rows count northward in the game, while an image's
  rows count downward, so drawing row 0 at the top laid every map out mirrored top to bottom
  against what the game shows. The scene now mirrors the world as it draws, which flips
  terrain, buildings and overlays together and leaves the tile coordinates we report as the
  ones the game would show for that spot. Hillshading moved with it — the sun was lighting
  from what turned out to be the south, which is the direction that makes hills read as
  valleys — and `npm run preview:png` mirrors its output too, so it still shows what the app
  shows.

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
