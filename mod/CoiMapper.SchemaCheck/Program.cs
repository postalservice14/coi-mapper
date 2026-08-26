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

        public static int Main(string[] args) {
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
