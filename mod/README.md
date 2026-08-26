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

The game validates the manifest and **silently skips** a mod whose manifest is malformed —
no error, it simply never loads. The field list below is taken from `ModManifest` in
`Mafi.Core`, which is the code that actually parses it.

| Field | Notes |
| --- | --- |
| `id` | **Required.** `[a-zA-Z0-9][a-zA-Z0-9_-]*`, must not start with `COI-`. The mod's folder name must match it exactly. |
| `version` | **Required.** `major.minor[.patch[letter]]`, e.g. `0.2.0` or `1.1.0a`. |
| `primary_dlls` | **Required.** Array of DLL filenames, loaded in order. |
| `display_name` | Max 50 characters. Note the snake_case — `displayName` is silently ignored. |
| `description_short` | Max 180 characters. |
| `description_long` | Supports simple markup (`<b>`, `<i>`, `\n`) in the in-game mod browser. |
| `authors` | Array of strings. |
| `min_game_version` | Lowest game version the mod supports. |
| `max_verified_game_version` | Highest version it has been tested against. |
| `links` | Flat array of URLs. |
| `mod_dependencies` / `optional_mod_dependencies` | Other mods, with optional version constraints. |
| `incompatible_mods` | Mod ids that conflict. |
| `non_locking_dll_load` | Loads the DLL from memory so the file is not locked — lets you rebuild without closing the game. |
| `can_add_to_saved_game` | Required for the mod to be usable on an existing save. |
| `can_remove_from_saved_game` | Whether it can be taken back out. |
| `primary_mod_class_name` | Which `IMod` to use when the assembly has more than one. |

There is **no `license` or `changelog` field**. Both live in the repository and are surfaced
through `links`, alongside the source. A `thumbnail.png` beside the manifest is picked up as
the mod's image.

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
| `TerrainOverlays` — deposits, designations | ✅ Written against decompiled APIs |
| `WorldExporter` — networks, occupancy, thumbnail | 🚧 Next increment |

Everything above **compiles** against the real game assemblies. Terrain, buildings and
prototypes have been run in the game and their output renders. The deposit and designation
walks have **not yet been run inside the game** — that is the remaining unknown, and a manager
that fails to resolve there will log `deposit planes skipped` or `designation plane skipped`
and omit just that layer.

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
| Deposit bodies | `VirtualResourceManager.GetAllResourcesFor(VirtualResourceProductProto)` |
| Deposit extent | `SimpleVirtualResource.IsAt(tile)`, bounded by `.Position.Xy` and `.MaxRadius` |
| Deposit richness | `SimpleVirtualResource.GetApproxThicknessAt(tile).Value.ToFloat()` |
| Mine / dump | `ITerrainDesignationsManager.Designations`, each `.Area.EnumerateTiles()` |
| Mine vs dump | ground height against `TerrainDesignation.Data.CenterTargetHeight` — per tile |
| Surface designations | `ISurfaceDesignationsManager.PlacingDesignations` / `.ClearingDesignations` |

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

### A quicker probe, with no tool install

`ilspycmd` gives you whole source files, which is what you want when you need to read a method
body. When the question is only "what is this manager called and what does it expose", a
metadata walk answers in seconds and needs nothing beyond the SDK. It reads metadata only and
never executes game code, so it is safe to point at the assemblies.

```bash
mkdir -p /tmp/apiprobe && cd /tmp/apiprobe
cat > apiprobe.csproj <<'CSPROJ'
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="System.Reflection.MetadataLoadContext" Version="9.0.0" />
  </ItemGroup>
</Project>
CSPROJ
cat > Program.cs <<'PROGRAM'
using System.Reflection;

// usage: dotnet run -- types|members <needle-or-full-name> <path-to-mod/lib>
var lib = args[2];
var paths = Directory.GetFiles(lib, "*.dll").ToList();
paths.AddRange(Directory.GetFiles(Path.GetDirectoryName(typeof(object).Assembly.Location)!, "*.dll"));
var mlc = new MetadataLoadContext(new PathAssemblyResolver(paths));
var types = new[] { "Mafi", "Mafi.Core", "Mafi.Base" }
    .SelectMany(n => mlc.LoadFromAssemblyPath(Path.Combine(lib, n + ".dll")).GetTypes());

foreach (var t in types) {
    if (args[0] == "types") {
        if (t.IsPublic && t.FullName!.Contains(args[1], StringComparison.OrdinalIgnoreCase))
            Console.WriteLine(t.FullName);
        continue;
    }
    if (t.FullName != args[1]) continue;
    Console.WriteLine($"=== {t.FullName} : {t.BaseType?.Name}");
    foreach (var i in t.GetInterfaces()) Console.WriteLine($"  impl {i.Name}");
    foreach (var m in t.GetMembers(BindingFlags.Public | BindingFlags.Instance
                                 | BindingFlags.Static | BindingFlags.DeclaredOnly)) {
        if (m is MethodInfo mi && !mi.IsSpecialName)
            Console.WriteLine($"  M {mi.ReturnType.Name} {mi.Name}({string.Join(", ",
                mi.GetParameters().Select(p => p.ParameterType.Name + " " + p.Name))})");
        else if (m is PropertyInfo pi) Console.WriteLine($"  P {pi.PropertyType.Name} {pi.Name}");
        else if (m is FieldInfo fi) Console.WriteLine($"  F {fi.FieldType.Name} {fi.Name}");
    }
}
PROGRAM

LIB=~/Projects/personal/coi-mapper/mod/lib
dotnet run -- types Designation $LIB
dotnet run -- members Mafi.Core.Terrain.Designation.ITerrainDesignationsManager $LIB
```

Search by concept, not by the word you expect. The deposit planes were written against
`VirtualResourceManager` because `types Deposit` returned one unrelated result — the game
calls them *virtual resources*, and guessing the name would have found nothing.

List fields as well as properties. `Tile2i.X` and `.Y` are public **fields**, so a listing that
covers only properties will convince you they do not exist.

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
