using System;
using System.Collections.Generic;
using CoiMapper.Export;
using CoiMapper.Schema;

namespace CoiMapper.SchemaCheck {
    /// <summary>
    /// Writes a small but complete `.coimap` using the exporter's own writer classes.
    /// The TypeScript parser then reads it back; see web/scripts/schema-check.mjs.
    /// </summary>
    public static class Program {
        private const int Width = 64;
        private const int Height = 48;

        /// <summary>
        /// Natural ground, taken from Mafi.Base.Ids.TerrainMaterials plus the few defined in
        /// core. Every one of these MUST resolve to a curated colour: the game's own colour is
        /// a particle tint that renders most of them as the same saddle brown.
        /// </summary>
        private static readonly string[] NaturalGroundIds = {
            "Grass", "GrassLush", "GrassNoDetails",
            "ForestFloor", "ForestDirt", "ForestGrass",
            "FlowersPurpleLush", "FlowersRed", "FlowersWhite", "FlowersYellowLush",
            "Dirt", "DirtBare", "DirtLush", "DirtNoDetails",
            "DirtFlowersPurpleLush", "DirtFlowersRed", "DirtFlowersWhite", "DirtFlowersYellowLush",
            "Compost", "FarmGround", "LandfillOld",
            "Rock", "RockDisrupted", "RockNoGrassCover", "HardenedRock", "Bedrock",
            "Gravel", "Cobblestone",
            "Sand", "SandDisrupted", "ManufacturedSand",
        };

        /// <summary>
        /// Ores and processed materials. These must fall through to the game's colour, which
        /// is genuinely distinct for them, so modded materials work without a palette entry.
        /// </summary>
        private static readonly string[] DeferredIds = {
            "Bauxite", "BauxiteCrushed", "BauxiteDisrupted", "Coal", "CoalDisrupted",
            "CopperOre", "IronOre", "GoldOre", "Quartz", "TitaniumOre", "UraniumOre",
            "UraniumDepleted", "Limestone", "LimestoneDisrupted", "Slag", "SlagCrushed",
        };

        private static int DumpPalette() {
            const string suffix = "_Terrain";
            var failures = 0;

            Console.WriteLine("  natural ground — every one must be curated");
            foreach (var name in NaturalGroundIds) {
                string hex;
                bool ok = MaterialPalette.TryNaturalColor(name + suffix, out hex);
                if (!ok) failures++;
                Console.WriteLine($"    {(ok ? "ok  " : "FAIL")}  {name,-24}{hex ?? "(fell through to the game tint)"}");
            }

            Console.WriteLine("\n  ores and processed — must defer to the game");
            foreach (var name in DeferredIds) {
                string hex;
                bool curated = MaterialPalette.TryNaturalColor(name + suffix, out hex);
                if (curated) failures++;
                Console.WriteLine($"    {(curated ? "FAIL" : "ok  ")}  {name,-24}{(curated ? hex + " (should defer)" : "game colour")}");
            }

            Console.WriteLine($"\n  {NaturalGroundIds.Length + DeferredIds.Length - failures}/" +
                              $"{NaturalGroundIds.Length + DeferredIds.Length} palette checks passed");
            return failures == 0 ? 0 : 1;
        }

        public static int Main(string[] args) {
            if (args.Length > 0 && args[0] == "--palette") return DumpPalette();
            string path = args.Length > 0 ? args[0] : "schema-check.coimap";

            var surfaces = new List<Surface> {
                new Surface { Id = 0, Name = "Ocean", Color = "#1b4a6b", Water = true },
                new Surface { Id = 1, Name = "Dirt", Color = MaterialPalette.ColorFor("Dirt"), Water = false },
                new Surface { Id = 2, Name = "Rock", Color = MaterialPalette.ColorFor("Rock"), Water = false },
                // Exercises the deterministic fallback for unknown/modded materials.
                new Surface { Id = 3, Name = "Unobtainium", Color = MaterialPalette.ColorFor("Unobtainium"), Water = false },
            };

            var entities = new List<Entity> {
                new Entity { Id = 1, Proto = "Furnace", X = 4, Y = 4, W = 3, H = 3, Rot = 0, State = EntityState.Operating },
                new Entity { Id = 2, Proto = "Storage", X = 10, Y = 6, W = 4, H = 4, Rot = 1, State = EntityState.Constructing },
                // Non-ASCII and quote characters must survive JSON escaping.
                new Entity { Id = 3, Proto = "Pump \"A\" — ünïcode", X = 20, Y = 12, W = 2, H = 3, Rot = 3, State = EntityState.Broken },
                // A snaking conveyor: a large bounding box covering only an L-shaped path.
                // Emitting the box instead would paint a 10x8 slab over unrelated tiles.
                new Entity {
                    Id = 4, Proto = "ConveyorT2", X = 30, Y = 20, W = 10, H = 8, Rot = 0,
                    State = EntityState.Operating,
                    Tiles = new[] { 0, 0, 1, 0, 2, 0, 3, 0, 3, 1, 3, 2, 3, 3, 4, 3, 5, 3, 6, 3, 7, 3, 8, 3, 9, 3 },
                },
            };

            using (var archive = new CoiMapArchive(path)) {
                var height = new ushort[Width * Height];
                var surface = new byte[Width * Height];
                for (int y = 0; y < Height; y++) {
                    for (int x = 0; x < Width; x++) {
                        int i = y * Width + x;
                        height[i] = (ushort)(x * 1000 + y);           // asymmetric: catches row/column transposition
                        surface[i] = (byte)(x < 8 ? 0 : 1 + (x + y) % 3);
                    }
                }
                archive.WritePlaneU16("height", height);
                archive.AddPlaneInfo("height", "u16");
                archive.WritePlaneU8("surface", surface);
                archive.AddPlaneInfo("surface", "u8");

                archive.WriteJson(CoiMapSchema.Entities, w => {
                    w.BeginArray();
                    foreach (var e in entities) e.WriteTo(w);
                    w.EndArray();
                });

                archive.WriteJson(CoiMapSchema.Protos, w => {
                    w.BeginArray();
                    foreach (var e in entities) {
                        new Proto {
                            Id = e.Proto, Name = e.Proto, Category = "Smelting",
                            Color = CategoryColors.For("Smelting"), W = e.W, H = e.H,
                        }.WriteTo(w);
                    }
                    w.EndArray();
                });

                archive.WriteJson(CoiMapSchema.Networks, w => {
                    w.BeginObject();
                    w.Name("transports").BeginArray();
                    new Transport { Id = 9, Proto = "Conveyor", Kind = TransportKind.Conveyor, Points = new[] { 4, 7, 10, 7, 10, 10 } }.WriteTo(w);
                    w.EndArray();
                    w.Name("edges").BeginArray();
                    new NetworkEdge { Kind = NetworkKind.Electricity, A = 1, B = 2 }.WriteTo(w);
                    w.EndArray();
                    w.EndObject();
                });

                var manifest = new Manifest {
                    SchemaVersion = CoiMapSchema.SchemaVersion,
                    Generator = "CoiMapper.SchemaCheck",
                    GeneratedAt = "2026-01-01T00:00:00.0000000Z",
                    Game = new GameInfo { Version = "0.8.2c", SaveVersion = 287, MapName = "Schema Check" },
                    Map = new MapInfo { Width = Width, Height = Height, MinHeight = -12.5f, MaxHeight = 240.25f },
                    Planes = archive.WrittenPlanes.ToArray(),
                    Surfaces = surfaces.ToArray(),
                    Deposits = new Deposit[0],
                    Counts = new Counts { Entities = entities.Count, Transports = 1, Edges = 1, Protos = entities.Count },
                };
                archive.WriteJson(CoiMapSchema.Manifest, manifest.WriteTo);

                Console.WriteLine($"wrote {path}  ({Width}x{Height}, {entities.Count} entities)");
            }
            return 0;
        }
    }
}
