using System;
using System.Collections.Generic;
using Mafi;
using Mafi.Core;
using Mafi.Core.Map;
using Mafi.Core.Products;
using Mafi.Core.Prototypes;
using Mafi.Core.Terrain;
using Mafi.Core.Terrain.Designation;
using CoiMapper.Schema;

namespace CoiMapper.Export {
    /// <summary>
    /// Writes the optional overlay planes: virtual resource deposits, and the terrain
    /// designations the player has drawn.
    ///
    /// Every API used here was read off the decompiled game assemblies rather than guessed;
    /// see mod/README.md for the decompilation workflow.
    ///
    /// Both planes are optional in the format and the web app already draws a missing layer
    /// as "not exported", so each is written inside its own try/catch. A manager that a later
    /// game version renames then costs one layer rather than the entire export — which
    /// matters, because this runs on the save path.
    /// </summary>
    internal static class TerrainOverlays {
        private static T TryResolve<T>(DependencyResolver resolver) where T : class {
            try {
                return (T)resolver.Resolve(typeof(T));
            } catch (Exception) {
                return null;
            }
        }

        // ── deposits ──────────────────────────────────────────────────────────
        /// <summary>
        /// Writes the deposit and depositAmount planes, returning the legend for them.
        ///
        /// These are the game's *virtual* resources — the oil and water bodies a pump draws
        /// from. Ores are not among them: those are ordinary terrain materials, and the
        /// surface plane already carries them.
        ///
        /// A body knows only how to answer "am I under this tile?", so the walk is bounded by
        /// the body's own radius. Sweeping the map instead would be one call per tile per
        /// body, and a large map is over thirteen million tiles.
        /// </summary>
        public static List<Deposit> WriteDeposits(
            CoiMapArchive archive, DependencyResolver resolver, TerrainManager terrain, int width, int height) {
            var legend = new List<Deposit>();
            try {
                var manager = TryResolve<IVirtualResourceManager>(resolver) as VirtualResourceManager;
                var protos = TryResolve<ProtosDb>(resolver);
                if (manager == null || protos == null) return legend;

                int tiles = width * height;
                var idPlane = new byte[tiles];
                var thickness = new float[tiles];
                float maxThickness = 0f;
                int nextId = 1;

                foreach (var product in protos.All<VirtualResourceProductProto>()) {
                    // The plane is a byte and 0 already means "no deposit here".
                    if (nextId > 255) break;

                    var bodies = manager.GetAllResourcesFor(product);
                    if (bodies.Length == 0) continue;

                    byte id = (byte)nextId;
                    bool used = false;
                    string color = null;

                    foreach (var body in bodies) {
                        // Only this implementation says where it sits; without a position
                        // there is nothing to bound a search with.
                        var placed = body as SimpleVirtualResource;
                        if (placed == null) continue;
                        if (color == null) color = ColorOf(placed);

                        var centre = placed.Position.Xy;
                        int radius = placed.MaxRadius.Value;
                        int x0 = Math.Max(0, centre.X - radius);
                        int x1 = Math.Min(width - 1, centre.X + radius);
                        int y0 = Math.Max(0, centre.Y - radius);
                        int y1 = Math.Min(height - 1, centre.Y + radius);

                        for (int y = y0; y <= y1; y++) {
                            for (int x = x0; x <= x1; x++) {
                                var tile = new Tile2i(x, y);
                                if (!placed.IsAt(tile)) continue;

                                int i = y * width + x;
                                idPlane[i] = id;
                                // Bodies may overlap; the thicker one describes the tile.
                                float t = placed.GetApproxThicknessAt(tile).Value.ToFloat();
                                if (t > thickness[i]) thickness[i] = t;
                                if (t > maxThickness) maxThickness = t;
                                used = true;
                            }
                        }
                    }

                    if (!used) continue;
                    legend.Add(new Deposit {
                        Id = id,
                        Name = NameOf(product),
                        Color = color ?? "#7fb2d9",
                    });
                    nextId++;
                }

                if (legend.Count == 0) return legend;

                archive.WritePlaneU8("deposit", idPlane);
                archive.AddPlaneInfo("deposit", "u8");

                // The amount is explicitly relative, so the richest tile on this map is full
                // scale. An absolute quantity would mean nothing without the game's units.
                var amountPlane = new ushort[tiles];
                if (maxThickness > 0f) {
                    for (int i = 0; i < tiles; i++) {
                        amountPlane[i] = (ushort)Math.Round(
                            Math.Min(1f, thickness[i] / maxThickness) * 65535f);
                    }
                }
                archive.WritePlaneU16("depositAmount", amountPlane);
                archive.AddPlaneInfo("depositAmount", "u16");
            } catch (Exception e) {
                Log.Error("CoiMapper: deposit planes skipped — " + e);
                legend.Clear();
            }
            return legend;
        }

        private static string ColorOf(SimpleVirtualResource resource) {
            try {
                var rgba = resource.ResourceColor;
                return "#" + rgba.R.ToString("x2") + rgba.G.ToString("x2") + rgba.B.ToString("x2");
            } catch (Exception) {
                return null;
            }
        }

        private static string NameOf(VirtualResourceProductProto product) {
            try {
                string localised = product.Product.Strings.Name.TranslatedString;
                if (!string.IsNullOrEmpty(localised)) return localised;
            } catch (Exception) { }
            try {
                return product.Id.Value;
            } catch (Exception) {
                return "Deposit";
            }
        }

        // ── designations ──────────────────────────────────────────────────────
        /// <summary>
        /// Writes the designation plane: a bitmask per tile of what the player has marked.
        ///
        /// Forestry and unreachable have bits reserved in the format but are not written.
        /// Forestry is not a terrain designation in the game's model — it is the area a
        /// forestry tower manages — and "unreachable" is per-vehicle pathfinding state rather
        /// than anything the player drew on the map, so neither has a map-wide set to read.
        /// </summary>
        public static void WriteDesignations(
            CoiMapArchive archive, DependencyResolver resolver, TerrainManager terrain, int width, int height) {
            try {
                var plane = new byte[width * height];
                bool any = MarkTerrain(resolver, terrain, plane, width, height);
                any = MarkSurfaces(resolver, terrain, plane, width, height) || any;
                if (!any) return;

                archive.WritePlaneU8("designation", plane);
                archive.AddPlaneInfo("designation", "u8");
            } catch (Exception e) {
                Log.Error("CoiMapper: designation plane skipped — " + e);
            }
        }

        /// <summary>
        /// Mining and dumping.
        ///
        /// A designation carries a target height rather than a mine-or-dump flag: vehicles cut
        /// a tile down or fill it up depending on which side of that target the ground
        /// currently sits. So the two bits are decided per tile, and one designation spanning
        /// a slope legitimately produces both.
        /// </summary>
        private static bool MarkTerrain(
            DependencyResolver resolver, TerrainManager terrain, byte[] plane, int width, int height) {
            var manager = TryResolve<ITerrainDesignationsManager>(resolver);
            if (manager == null) return false;

            bool any = false;
            foreach (var designation in manager.Designations) {
                if (designation.IsDestroyed) continue;
                float target = designation.Data.CenterTargetHeight.Value.ToFloat();

                foreach (var tile in designation.Area.ClampToTerrainBounds(terrain).EnumerateTiles()) {
                    if (tile.X < 0 || tile.Y < 0 || tile.X >= width || tile.Y >= height) continue;
                    if (!designation.ContainsPosition(tile)) continue;

                    float ground = terrain.GetHeight(tile).Value.ToFloat();
                    byte bit = ground > target ? DesignationBits.Mine : DesignationBits.Dump;
                    int i = tile.Y * width + tile.X;
                    plane[i] = (byte)(plane[i] | bit);
                    any = true;
                }
            }
            return any;
        }

        /// <summary>
        /// Surfaces the player has asked for or asked to have cleared. Both are the same bit:
        /// the overlay answers "this tile is spoken for", not which way round.
        /// </summary>
        private static bool MarkSurfaces(
            DependencyResolver resolver, TerrainManager terrain, byte[] plane, int width, int height) {
            var manager = TryResolve<ISurfaceDesignationsManager>(resolver);
            if (manager == null) return false;

            bool any = Mark(manager.PlacingDesignations, terrain, plane, width, height);
            return Mark(manager.ClearingDesignations, terrain, plane, width, height) || any;
        }

        private static bool Mark(
            IEnumerable<SurfaceDesignation> designations, TerrainManager terrain,
            byte[] plane, int width, int height) {
            bool any = false;
            foreach (var designation in designations) {
                if (designation.IsDestroyed) continue;
                foreach (var tile in designation.Area.ClampToTerrainBounds(terrain).EnumerateTiles()) {
                    if (tile.X < 0 || tile.Y < 0 || tile.X >= width || tile.Y >= height) continue;
                    int i = tile.Y * width + tile.X;
                    plane[i] = (byte)(plane[i] | DesignationBits.Surface);
                    any = true;
                }
            }
            return any;
        }
    }
}
