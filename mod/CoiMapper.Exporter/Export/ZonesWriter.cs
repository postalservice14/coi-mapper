using System;
using System.Collections.Generic;
using Mafi;
using Mafi.Core.Vehicles;
using CoiMapper.Schema;

namespace CoiMapper.Export {
    /// <summary>
    /// Reads the player's logistics zones: the polygon each one covers, and the identity the
    /// vehicle census counts by.
    ///
    /// This is its own writer rather than part of <see cref="VehicleCensusWriter"/> because
    /// two unrelated things need it — the map draws the areas, the vehicle panel groups by
    /// the ids — and the census was only the first of them to ask.
    ///
    /// As everywhere else on the save path, the manager is resolved defensively: a zone read
    /// that fails must cost the zone layer and the panel's zone grouping, not the export.
    /// </summary>
    internal static class ZonesWriter {
        /// <summary>
        /// What <see cref="Read"/> found: the table for the manifest, and the id an unmoved
        /// vehicle belongs to.
        ///
        /// The two are returned together because they are only meaningful together. A table
        /// without a known default id would file every unmoved vehicle under a zone that is
        /// not in it, so <see cref="Read"/> refuses to produce one without the other.
        /// </summary>
        public struct Result {
            public Zone[] Zones;
            public int DefaultZoneId;
        }

        /// <summary>
        /// The default zone first, then the rest in the game's own order. That order is the
        /// order consumers group in, so it is decided here rather than in the UI.
        /// </summary>
        public static Result Read(DependencyResolver resolver) {
            var rows = new List<Zone>();
            int defaultZoneId = VehicleTally.NoZone;

            var manager = TryResolve<ILogisticsZonesManager>(resolver);
            if (manager != null) {
                try {
                    var fallback = manager.DefaultZone;
                    if (fallback != null) {
                        defaultZoneId = fallback.Id.Value;
                        rows.Add(RowFor(fallback));
                    }

                    // As with the trains walk, IIndexable is Mafi's own type and needs the
                    // AsEnumerable() bridge.
                    foreach (var zone in manager.AllZones.AsEnumerable()) {
                        if (zone == null || zone.IsDestroyed) continue;
                        if (zone.Id.Value == defaultZoneId) continue;
                        rows.Add(RowFor(zone));
                    }
                } catch (Exception e) {
                    Log.Error("CoiMapper: logistics zones skipped — " + e);
                    rows.Clear();
                    defaultZoneId = VehicleTally.NoZone;
                }
            }

            // Holds the pairing described on Result: no known default, no usable table.
            if (defaultZoneId == VehicleTally.NoZone) rows.Clear();
            return new Result { Zones = rows.ToArray(), DefaultZoneId = defaultZoneId };
        }

        private static Zone RowFor(LogisticsZone zone) {
            return new Zone {
                Id = zone.Id.Value,
                Name = NameOf(zone),
                Color = ColorOf(zone),
                IsDefault = zone.IsDefaultZone,
                Area = AreaOf(zone),
            };
        }

        /// <summary>
        /// The zone boundary as flattened tile coordinates, the same encoding transports use.
        ///
        /// The ring is left open — the last vertex is not repeated to close it — because the
        /// game's own polygon is stored that way and every consumer closes it itself. An
        /// area with fewer than three vertices cannot be drawn, so it is exported as empty
        /// rather than as a line the renderer would have to special-case.
        /// </summary>
        private static int[] AreaOf(LogisticsZone zone) {
            try {
                var vertices = zone.Area.Polygon.Vertices;
                if (vertices.Length < 3) return new int[0];

                var flat = new int[vertices.Length * 2];
                for (int i = 0; i < vertices.Length; i++) {
                    flat[i * 2] = vertices[i].X;
                    flat[i * 2 + 1] = vertices[i].Y;
                }
                return flat;
            } catch (Exception) {
                // A zone whose area will not read is still worth listing for its identity.
                return new int[0];
            }
        }

        /// <summary>
        /// The zone's name as the game shows it, which already resolves to the player's own
        /// name where they set one. Falls back to the id so a zone with no name at all still
        /// reads as something rather than as a blank heading.
        /// </summary>
        private static string NameOf(LogisticsZone zone) {
            try {
                string name = zone.Name.Value;
                if (!string.IsNullOrEmpty(name)) return name;
            } catch (Exception) {
                // A zone with no string is not worth failing the export for.
            }
            return "Zone " + zone.Id.Value;
        }

        private static string ColorOf(LogisticsZone zone) {
            try {
                var rgba = zone.Color;
                return "#" + rgba.R.ToString("x2") + rgba.G.ToString("x2") + rgba.B.ToString("x2");
            } catch (Exception) {
                return "#8899aa";
            }
        }

        private static T TryResolve<T>(DependencyResolver resolver) where T : class {
            try {
                return (T)resolver.Resolve(typeof(T));
            } catch (Exception) {
                return null;
            }
        }
    }
}
