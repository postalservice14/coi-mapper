# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

Two version numbers matter here: the **mod version** in `mod/CoiMapper.Exporter/manifest.json`,
and the **`.coimap` schema version** in `schema/coimap.spec.mjs`. A schema bump means existing
`.coimap` files must be re-exported — the web app reports a version mismatch rather than
misrendering them.

## [Unreleased]

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
