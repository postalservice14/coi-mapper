using System;
using System.Collections.Generic;
using Mafi;
using Mafi.Core.Entities;
using Mafi.Core.Entities.Static;
using Mafi.Core.Prototypes;
using Mafi.Core.Terrain;
using CoiMapper.Schema;
// The game defines its own Entity and Proto; alias the schema types so both stay usable.
using SchemaEntity = CoiMapper.Schema.Entity;
using SchemaProto = CoiMapper.Schema.Proto;

namespace CoiMapper.Export {
    /// <summary>
    /// Walks the live simulation and writes a `.coimap`.
    ///
    /// Every API used here was read off the decompiled game assemblies rather than guessed;
    /// see mod/README.md for the decompilation workflow.
    /// </summary>
    public sealed class WorldExporter {
        private readonly DependencyResolver m_resolver;

        public WorldExporter(DependencyResolver resolver) {
            m_resolver = resolver;
        }

        private T Resolve<T>() where T : class {
            return (T)m_resolver.Resolve(typeof(T));
        }

        /// <param name="gameName">The save's name, used for the map label. May be null.</param>
        public void ExportTo(string path, string gameName = null) {
            var terrain = Resolve<TerrainManager>();
            var entities = Resolve<IEntitiesManager>();

            using (var archive = new CoiMapArchive(path)) {
                List<Surface> surfaces;
                var map = WriteTerrain(archive, terrain, out surfaces);

                var tileSurfaces = TerrainOverlays.WriteTileSurfaces(archive, terrain, map.Width, map.Height);
                var deposits = TerrainOverlays.WriteDeposits(archive, m_resolver, terrain, map.Width, map.Height);
                TerrainOverlays.WriteDesignations(archive, m_resolver, terrain, map.Width, map.Height);

                var usedProtos = new Dictionary<string, EntityProto>();
                int entityCount = WriteEntities(archive, entities, usedProtos);
                WriteProtos(archive, usedProtos);

                // TODO: TransportsManager, IElectricityManager, IShaftManager.
                archive.WriteJson(CoiMapSchema.Networks, w => {
                    w.BeginObject();
                    w.Name("transports").BeginArray().EndArray();
                    w.Name("edges").BeginArray().EndArray();
                    w.EndObject();
                });

                // Vehicles and trains are dynamic entities, so the static-entity walk above
                // cannot see them; they come from their own managers.
                var vehicles = VehicleCensusWriter.Build(m_resolver);

                var counts = new Counts {
                    Entities = entityCount, Transports = 0, Edges = 0, Protos = usedProtos.Count,
                };
                WriteManifest(archive, map, surfaces, tileSurfaces, deposits, vehicles, counts, gameName);
            }
        }

        // ── terrain ───────────────────────────────────────────────────────────
        /// <summary>
        /// Writes the height, surface and material planes.
        ///
        /// Note that <c>TileSurfaceData</c> covers only player-placed surfaces such as
        /// concrete; natural ground has none. The visible colour of untouched terrain comes
        /// from its topmost material layer, so that is what the surface plane records —
        /// with id 0 reserved for ocean.
        /// </summary>
        private MapInfo WriteTerrain(CoiMapArchive archive, TerrainManager terrain, out List<Surface> surfaces) {
            int width = terrain.TerrainWidth;
            int height = terrain.TerrainHeight;
            int tiles = width * height;

            var raw = new float[tiles];
            var surfacePlane = new byte[tiles];
            var materialPlane = new byte[tiles];

            float min = float.MaxValue;
            float max = float.MinValue;

            for (int y = 0; y < height; y++) {
                for (int x = 0; x < width; x++) {
                    int i = y * width + x;
                    var index = terrain.GetTileIndex(new Tile2i(x, y));

                    float h = terrain.GetHeight(index).Value.ToFloat();
                    raw[i] = h;
                    if (h < min) min = h;
                    if (h > max) max = h;

                    int materialId = terrain.GetFirstLayerSlim(index).SlimIdRaw;
                    materialPlane[i] = (byte)Math.Min(255, materialId);
                    // Surface ids are material ids shifted by one so 0 can mean ocean.
                    surfacePlane[i] = terrain.IsOcean(index) ? (byte)0 : (byte)Math.Min(255, materialId + 1);
                }
            }

            if (min > max) { min = 0f; max = 1f; }   // empty or unloaded terrain
            float span = max - min;
            if (span <= 0f) span = 1f;

            var heightPlane = new ushort[tiles];
            for (int i = 0; i < tiles; i++) {
                heightPlane[i] = (ushort)Math.Round(Math.Max(0f, Math.Min(1f, (raw[i] - min) / span)) * 65535f);
            }

            archive.WritePlaneU16("height", heightPlane);
            archive.AddPlaneInfo("height", "u16");
            archive.WritePlaneU8("surface", surfacePlane);
            archive.AddPlaneInfo("surface", "u8");
            archive.WritePlaneU8("material", materialPlane);
            archive.AddPlaneInfo("material", "u8");

            surfaces = BuildSurfaceLegend(terrain);
            return new MapInfo { Width = width, Height = height, MinHeight = min, MaxHeight = max };
        }

        /// <summary>
        /// Ocean plus one entry per terrain material, matching the shifted ids above.
        ///
        /// Colours come from each material's own graphics rather than being guessed from its
        /// name: the game already knows what dirt, bauxite and forest floor look like, and
        /// modded materials then work for free.
        /// </summary>
        private List<Surface> BuildSurfaceLegend(TerrainManager terrain) {
            var list = new List<Surface> {
                new Surface { Id = 0, Name = "Ocean", Color = "#1b4a6b", Water = true },
            };

            var materials = terrain.TerrainMaterials;
            for (int i = 0; i < materials.Length; i++) {
                var proto = materials[i];
                string id = proto.Id.Value;
                // The slim-id manager keeps a phantom entry as a lookup fallback; it is not
                // a real material and would show up in the legend as noise.
                if (id.IndexOf("PHANTOM", StringComparison.OrdinalIgnoreCase) >= 0) continue;

                list.Add(new Surface {
                    Id = proto.SlimId.Value + 1,
                    Name = DisplayName(proto, id),
                    Color = ColorOf(proto, id),
                    Water = false,
                });
            }
            return list;
        }

        /// <summary>
        /// Map colour for a material.
        ///
        /// Natural ground is coloured from our own palette, because the game's graphics colour
        /// is a particle tint that lumps grass, forest floor, every dirt and compost into one
        /// saddle brown. Ores and everything else keep the game's colour, which is distinct and
        /// correct for them, and means modded materials work without changes.
        /// </summary>
        private static string ColorOf(Mafi.Core.Products.TerrainMaterialProto proto, string id) {
            string natural;
            if (MaterialPalette.TryNaturalColor(id, out natural)) return natural;

            try {
                var rgba = proto.Graphics.Color.Rgba;
                return "#" + rgba.R.ToString("x2") + rgba.G.ToString("x2") + rgba.B.ToString("x2");
            } catch {
                return MaterialPalette.ColorFor(id);
            }
        }

        /// <summary>
        /// Localised name where there is one, else the proto id with the "_Terrain" suffix
        /// dropped and camel case split, so "GrassLush_Terrain" reads as "Grass Lush".
        /// </summary>
        private static string DisplayName(Mafi.Core.Products.TerrainMaterialProto proto, string id) {
            try {
                string localised = proto.Strings.Name.TranslatedString;
                if (!string.IsNullOrEmpty(localised)) return localised;
            } catch { }

            return DisplayNames.FromId(id, Mafi.Core.Products.TerrainMaterialProto.SUFFIX);
        }

        // ── entities ──────────────────────────────────────────────────────────
        private int WriteEntities(CoiMapArchive archive, IEntitiesManager entities, Dictionary<string, EntityProto> usedProtos) {
            int count = 0;
            archive.WriteJson(CoiMapSchema.Entities, w => {
                w.BeginArray();
                foreach (var entity in entities.GetAllEntitiesOfType<IStaticEntity>()) {
                    var record = Describe(entity);
                    if (record == null) continue;
                    record.WriteTo(w);
                    usedProtos[record.Proto] = entity.Prototype;
                    count++;
                }
                w.EndArray();
            });
            return count;
        }

        /// <summary>
        /// Builds one entity record. The footprint comes from the entity's own occupied
        /// tiles rather than its prototype layout, because those are already rotated.
        ///
        /// Machines fill their bounding box, so the box alone describes them. Conveyors and
        /// pipes do not: a belt that snakes across the factory has a bounding box hundreds
        /// of tiles wide that is almost entirely empty. Those get an explicit tile list, or
        /// the map would paint them as enormous solid rectangles.
        /// </summary>
        private static SchemaEntity Describe(IStaticEntity entity) {
            var occupied = entity.OccupiedTiles;
            if (occupied.Length == 0) return null;

            int minX = int.MaxValue, minY = int.MaxValue, maxX = int.MinValue, maxY = int.MinValue;
            for (int i = 0; i < occupied.Length; i++) {
                int rx = occupied[i].RelativeX;
                int ry = occupied[i].RelativeY;
                if (rx < minX) minX = rx;
                if (rx > maxX) maxX = rx;
                if (ry < minY) minY = ry;
                if (ry > maxY) maxY = ry;
            }

            int w = maxX - minX + 1;
            int h = maxY - minY + 1;

            // Distinct tiles, since a layout can list several entries per tile (different
            // vertical extents), and a duplicate would misreport a solid footprint.
            var covered = new HashSet<int>();
            for (int i = 0; i < occupied.Length; i++) {
                covered.Add((occupied[i].RelativeY - minY) * w + (occupied[i].RelativeX - minX));
            }

            int[] tiles;
            if (covered.Count >= w * h) {
                tiles = Empty;                      // fills its box: the box says it all
            } else {
                tiles = new int[covered.Count * 2];
                int t = 0;
                foreach (int cell in covered) {
                    tiles[t++] = cell % w;
                    tiles[t++] = cell / w;
                }
            }

            var centre = entity.CenterTile;
            return new SchemaEntity {
                Id = entity.Id.Value,
                Proto = entity.Prototype.Id.Value,
                X = centre.X + minX,
                Y = centre.Y + minY,
                W = w,
                H = h,
                // Occupied tiles already encode rotation, so the footprint is correct without
                // it; the raw angle is not exposed on IStaticEntity.
                Rot = 0,
                State = MapState(entity),
                Tiles = tiles,
            };
        }

        private static readonly int[] Empty = new int[0];

        private static EntityState MapState(IStaticEntity entity) {
            switch (entity.ConstructionState) {
                case ConstructionState.InConstruction:
                case ConstructionState.PreparingUpgrade:
                case ConstructionState.BeingUpgraded:
                    return EntityState.Constructing;
                case ConstructionState.PendingDeconstruction:
                case ConstructionState.InDeconstruction:
                    return EntityState.Deconstructing;
                case ConstructionState.Deconstructed:
                case ConstructionState.NotInitialized:
                    return EntityState.Unknown;
            }
            if (entity.IsPaused) return EntityState.Paused;
            if (!entity.IsEnabled) return EntityState.Disabled;
            return EntityState.Operating;
        }

        // ── prototypes ────────────────────────────────────────────────────────
        private void WriteProtos(CoiMapArchive archive, Dictionary<string, EntityProto> usedProtos) {
            archive.WriteJson(CoiMapSchema.Protos, w => {
                w.BeginArray();
                foreach (var pair in usedProtos) {
                    string category = ProtoCategory.Of(pair.Value);
                    new SchemaProto {
                        Id = pair.Key,
                        Name = pair.Value.Strings.Name.TranslatedString,
                        Category = category,
                        Color = CategoryColors.For(category),
                        // Footprint is carried per entity, since rotation changes it.
                        W = 0,
                        H = 0,
                    }.WriteTo(w);
                }
                w.EndArray();
            });
        }

        // ── manifest ──────────────────────────────────────────────────────────
        /// <param name="vehicles">
        /// Required rather than optional on purpose. The generated Manifest writes nested
        /// structs without a null guard, so an unset census would be a NullReferenceException
        /// on the save path that the compiler could not have caught.
        /// </param>
        private void WriteManifest(
            CoiMapArchive archive, MapInfo map, List<Surface> surfaces, List<TileSurface> tileSurfaces,
            List<Deposit> deposits, VehicleCensus vehicles,
            Counts counts, string gameName) {
            // The game's version is not exposed as a service, but the assembly this mod is
            // running against carries it, which is the version that actually produced the data.
            var gameVersion = typeof(TerrainManager).Assembly.GetName().Version;

            var manifest = new Manifest {
                SchemaVersion = CoiMapSchema.SchemaVersion,
                Generator = "CoiMapper " + typeof(WorldExporter).Assembly.GetName().Version,
                GeneratedAt = DateTime.UtcNow.ToString("o"),
                Game = new GameInfo {
                    Version = gameVersion.Major + "." + gameVersion.Minor + "." + gameVersion.Build,
                    SaveVersion = 0,
                    MapName = string.IsNullOrEmpty(gameName) ? "Captain of Industry" : gameName,
                },
                Map = map,
                Planes = archive.WrittenPlanes.ToArray(),
                Surfaces = surfaces.ToArray(),
                TileSurfaces = tileSurfaces.ToArray(),
                Deposits = deposits.ToArray(),
                Vehicles = vehicles,
                Counts = counts,
            };
            archive.WriteJson(CoiMapSchema.Manifest, manifest.WriteTo);
        }
    }
}
