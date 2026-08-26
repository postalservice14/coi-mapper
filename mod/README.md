# CoiMapper exporter mod

Runs inside Captain of Industry and writes a `.coimap` for the web map.

## Phase 0 — game assemblies (required)

The mod compiles against the game's own assemblies, which cannot be redistributed. Copy
them from a Windows install:

```
<Steam>/steamapps/common/Captain of Industry/Captain of Industry_Data/Managed/
    Mafi.dll
    Mafi.Core.dll
    Mafi.Base.dll
```

into `mod/lib/`. That directory is gitignored — **never commit these files.**

They serve two purposes:

1. **Building.** With them present, `dotnet build` works on macOS and Linux too — the
   `Microsoft.NETFramework.ReferenceAssemblies` package supplies the `net48` targeting
   pack, so no .NET Framework install is needed. Only *running* the mod requires Windows.
2. **Discovering the API.** There is no published documentation for `TerrainManager`,
   `TransportsManager` and friends. Decompile `Mafi.Core.dll` with
   [ILSpy](https://github.com/icsharpcode/ILSpy) and read the real signatures. Every
   property access in `WorldExporter` must be verified against that source rather than
   guessed — a wrong name is a compile error at best, and silently wrong data at worst.

## Build and install

```powershell
dotnet build mod\CoiMapper.Exporter -c Release
```

Copy **both** files from `mod\CoiMapper.Exporter\bin\Release\` into a folder whose name
matches the `id` in `manifest.json` exactly:

```
%APPDATA%\Captain of Industry\Mods\CoiMapper\
    CoiMapper.Exporter.dll
    manifest.json
```

PowerShell one-liner:

```powershell
$dst = "$env:APPDATA\Captain of Industry\Mods\CoiMapper"
New-Item -ItemType Directory -Force -Path $dst
Copy-Item mod\CoiMapper.Exporter\bin\Release\CoiMapper.Exporter.dll, `
          mod\CoiMapper.Exporter\manifest.json -Destination $dst
```

### Enabling it

Captain of Industry picks mods at **world creation**, so an existing save needs the mod
added to it. That is what `"can_add_to_saved_game": true` in the manifest allows — load the
save, accept the prompt to add the mod, and it will run.

The mod registers no prototypes and changes no gameplay, so removing it later is safe too
(`"can_remove_from_saved_game": true`).

### Manifest fields

The game validates the manifest and will silently skip a mod whose manifest is malformed.
Three fields are mandatory: `id` (must not start with `COI-`), `version`
(`major.minor[.patch[letter]]`), and `primary_dlls` — the DLL filenames to load, in order.

### When it exports

Two triggers, both in the simulation layer:

| Trigger | When |
| --- | --- |
| World loaded | Once, on loading an existing save |
| **Game saved** | After every save completes |

Saving is the on-demand trigger: build something, hit save, and the map is refreshed. It
needs no key binding, cannot clash with the game's own shortcuts, and reads naturally.

There is deliberately **no keyboard shortcut**. Key bindings live in `Mafi.Unity`, the
rendering layer — `Mafi.Core` has no notion of them. Binding a key would mean referencing
the Unity assembly from a mod that otherwise needs only the simulation layer, for a trigger
that saving already provides. If a real hotkey is wanted later, that is the trade to make.

The export hooks `OnSaveDone` rather than `BeforeSave`, so a slow export never delays the
save itself, and a failed save never produces a map from a half-written world.

### Output

```
%APPDATA%\Captain of Industry\CoiMapper\<save name>.coimap
```

Named after the save so several bases do not overwrite one another.

### When nothing happens

The game logs mod loading in detail:

```
%APPDATA%\Captain of Industry\Logs\
```

Search there for `CoiMapper`. The mod logs its output path on success and the full
exception on failure — export errors are caught so a failure can never take the game down.

## What is implemented

| Piece | State |
| --- | --- |
| `CoiMapperMod` — `IMod` lifecycle, export trigger | ✅ |
| `JsonWriter` — dependency-free JSON emission | ✅ |
| `CoiMapArchive` — ZIP layout, binary plane writing | ✅ |
| `Schema/CoiMapSchema.gen.cs` — generated data model | ✅ |
| `WorldExporter` — terrain, buildings, prototypes | ✅ Written against decompiled APIs |
| `WorldExporter` — networks, deposits, designations | 🚧 Next increment |

Everything above **compiles** against the real game assemblies. It has **not yet been run
inside the game** — that is the remaining unknown.

### APIs it depends on

Read off the decompiled assemblies, not guessed:

| Need | API |
| --- | --- |
| Map size | `TerrainManager.TerrainWidth` / `.TerrainHeight` |
| Height | `TerrainManager.GetHeight(GetTileIndex(new Tile2i(x, y))).Value.ToFloat()` |
| Natural ground colour | `TerrainManager.GetFirstLayerSlim(index).SlimIdRaw` |
| Material legend | `TerrainManager.TerrainMaterials`, each proto's own `SlimId` |
| Ocean | `TerrainManager.IsOcean(index)` |
| Buildings | `IEntitiesManager.GetAllEntitiesOfType<IStaticEntity>()` |
| Footprint | `IStaticEntity.OccupiedTiles` (already rotated) + `.CenterTile` |
| State | `IStaticEntity.ConstructionState`, `.IsPaused`, `.IsEnabled` |
| Display name | `EntityProto.Strings.Name.TranslatedString` |

Note that `TileSurfaceData` covers only **player-placed** surfaces such as concrete. Natural
terrain has none, so the surface plane records the topmost *material* layer instead — reading
`TryGetTileSurface` alone would render blank ground everywhere the player had not paved.

## Decompiling

```bash
export DOTNET_ROOT="$HOME/.dotnet"; export PATH="$DOTNET_ROOT:$DOTNET_ROOT/tools:$PATH"
dotnet tool install -g ilspycmd

ilspycmd -l class -l interface -l struct -l enum mod/lib/Mafi.Core.dll   # index all types
ilspycmd -t Mafi.Core.Terrain.TerrainManager mod/lib/Mafi.Core.dll -r mod/lib
```

Two traps worth knowing: many `Mafi.*` types (`Tile2i`, `HeightTilesF`) actually live in
**Mafi.Core.dll**, not Mafi.dll — namespace does not imply assembly. And interface members
decompile without access modifiers, so grepping for `public` silently hides them.

## Off-game contract test

`CoiMapper.SchemaCheck` links the exporter's writer sources — which have no dependency on the
game — into a net10 console app, so the archive format can be exercised on any machine:

```bash
dotnet run --project mod/CoiMapper.SchemaCheck -c Release -- /tmp/check.coimap
cd web && npm run schema-check -- /tmp/check.coimap
```

The TypeScript parser then asserts the values survive: JSON escaping, unicode, float
formatting, enum names, booleans, and row-major plane byte order.

## Verifying an export

Beyond "a file appeared":

- Entity count matches the in-game statistics panel.
- Terrain dimensions match the map's known size.
- Spot-check five known buildings against the in-game map overlay.
- Compare the rendered web map with that overlay to confirm axis orientation — a flipped
  or transposed Y axis renders a plausible map that is entirely wrong.
