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
        /// Real terrain material ids from Mafi.Base.Ids.TerrainMaterials, so the palette can be
        /// checked against what the game actually has rather than invented names.
        /// </summary>
        private static readonly string[] RealMaterialIds = {
            "Grass_Terrain", "GrassLush_Terrain", "GrassNoDetails_Terrain",
            "ForestFloor_Terrain", "ForestGrass_Terrain", "ForestDirt_Terrain",
            "Dirt_Terrain", "DirtBare_Terrain", "DirtLush_Terrain", "DirtNoDetails_Terrain",
            "DirtFlowersPurpleLush_Terrain", "DirtFlowersRed_Terrain", "DirtFlowersWhite_Terrain",
            "DirtFlowersYellowLush_Terrain", "Compost_Terrain",
            "Rock_Terrain", "RockDisrupted_Terrain", "RockNoGrassCover_Terrain",
            "HardenedRock_Terrain", "Bedrock_Terrain", "Gravel_Terrain", "Cobblestone_Terrain",
            "Sand_Terrain", "SandDisrupted_Terrain", "ManufacturedSand_Terrain",
            // Not natural ground: these must fall through to the game's own colour.
            "Bauxite_Terrain", "Coal_Terrain", "CopperOre_Terrain", "IronOre_Terrain",
            "GoldOre_Terrain", "Quartz_Terrain", "TitaniumOre_Terrain", "UraniumOre_Terrain",
            "Limestone_Terrain", "Slag_Terrain", "RedMud_Terrain", "Sulfur_Terrain",
        };

        private static int DumpPalette() {
            int natural = 0;
            Console.WriteLine("  id                                natural?  colour");
            foreach (var id in RealMaterialIds) {
                string hex;
                bool isNatural = MaterialPalette.TryNaturalColor(id, out hex);
                if (isNatural) natural++;
                Console.WriteLine($"  {id,-34}{(isNatural ? "yes" : "no "),-10}{hex ?? "(game colour)"}");
            }
            Console.WriteLine($"\n  {natural} curated, {RealMaterialIds.Length - natural} deferred to the game");
            return 0;
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
