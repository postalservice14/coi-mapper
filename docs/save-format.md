# Captain of Industry `.save` format

Findings from reverse-engineering `samples/YT21e.save` (game 0.8.2c, save version 287).
This document explains **why this project uses an in-game exporter mod** rather than parsing
saves directly in the browser.

## Container

```
┌──────────────── 40-byte header (little-endian) ────────────────┐
 0..7    magic      "MaFiSave", byte-reversed  → on disk: 65 76 61 53 69 46 61 4D
 8..11   uint32     save version               → 287
12..15   uint32     compression                → 1 = gzip
16..23   uint64     compressed size            → 24,792,955
24..27   uint32     CRC32 of compressed bytes
28..35   uint64     uncompressed size          → 42,743,002
36..39   uint32     CRC32 of uncompressed bytes
└────────────────────────────────────────────────────────────────┘
40..EOF  gzip stream
```

Both sizes were verified against the sample: `filesize - 40 == 24,792,955` and the gzip stream
inflates to exactly `42,743,002` bytes.

## Chunks

The decompressed payload is a flat sequence of `[8-byte tag][data]`. Tags are ASCII **reversed**
and read as a little-endian `uint64`. Observed in the sample:

| Tag | Offset | Size | Contents |
| --- | ---: | ---: | --- |
| `ModTypes` | 0 | 98 B | Loaded mods + versions: `COI-Core`, `COI-CoreData`, `COI-CoreUnity`, `COI-SupporterDlc` |
| `SaveInfo` | 98 | 85,577 B | `Mafi.Core.SaveGame.GameSaveInfo` — game version `0.8.2c`, map name `Shattered Isles`, embedded JPEG thumbnail |
| `GlobConf` | 85,675 | 1,431 B | Global config |
| `Resolver` | 87,106 | **42,655,888 B** | The entire simulation object graph |
| `SaveStop` | 42,742,994 | 8 B | Terminator |

All chunks share **one cumulative `BlobReader` stream** — the string, type, and object ID tables
carry across chunk boundaries, so chunks cannot be parsed independently.

`GlobCfV2` is an alternate configs tag written by some modded builds; it does not appear here.

## The `Resolver` chunk

99.8% of the save. It is a serialized C# object graph.

Entries take the form:

```
[objectId varint][typeId varint][stringTableId varint][strLen varint][UTF-8 assembly-qualified name]
```

with all three IDs incrementing in lockstep as new objects/types/strings are first encountered.
Subsequent uses reference the interned ID instead of repeating the string.

### Type inventory

- **1,471** distinct type names, **1,019** concrete `Mafi.*` types.
- Assemblies referenced: `Mafi.Core` (1,781 occurrences) and `Mafi.Base` (98).
- **Zero `Mafi.Unity` types.**

That last point matters: Captain of Industry keeps its deterministic simulation (`Mafi.Core`)
strictly separate from rendering (`Mafi.Unity`). The save graph never touches the rendering layer,
which is what makes the game's saves and replays deterministic — and what makes a headless or
in-game export of the full world state possible.

### Type interning is lazy, not front-loaded

Distribution of type-name registrations across the payload:

```
  0-  5%   826   ████████████████████████████████████████
  5- 70%     0   (pure data — ~28 MB, no type names)
 70- 80%   821   ████████████████████████████████████████
 80- 90%     0
 90-100%   232   ███████████
```

There is no type table to read up front. Types are interned as the writer first encounters them,
so decoding is strictly sequential — you cannot seek to an object of interest.

The type-free 5%–70% band is a dense stream of LEB128 varints with a repeating record shape,
almost certainly the terrain grid.

## Why we do not parse this in the browser

MaFi serializes via a Roslyn source generator that emits per-type serializers writing fields
**back-to-back, with no field tags and no per-object length prefixes**.

Consequences:

1. **Nothing is skippable.** In JSON or Protobuf an unknown field carries enough structure to step
   over. Here, misreading one field by one byte desynchronizes the rest of the stream.
2. **Full coverage or nothing.** Rendering entities means decoding every type reachable from the
   root — all 1,471 — in exact field order.
3. **Patch-fragile.** Field order is whatever the source generator emitted for that build. Any
   game update can silently reorder it.

Prior art reaches the same conclusion.
[`richietherich78/COI-Save-Editor-Ultimate`](https://github.com/richietherich78/COI-Save-Editor-Ultimate)
uses byte-pattern replacement for trivial edits, and for anything structural its "Deep Edit" mode
*"loads the actual game and mod DLLs and fully deserialises every chunk using the game's own
serialization engine."*

The game's own assemblies are the only practical schema. We therefore run **inside the game**
(see [`mod/`](../mod)) and export a purpose-built [`.coimap`](../schema/coimap.md) document.

## What the save is still useful for

Header and `SaveInfo` parsing needs no game DLLs, and yields map name, game version, and the
thumbnail. See `samples/inspect-save.mjs`.

## Reproducing

```bash
node samples/inspect-save.mjs samples/YT21e.save
```
