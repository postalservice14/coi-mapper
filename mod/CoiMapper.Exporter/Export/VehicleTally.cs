using System;
using System.Collections.Generic;
using CoiMapper.Schema;

namespace CoiMapper.Export {
    /// <summary>
    /// Groups mobile machines by prototype and turns the result into a
    /// <see cref="VehicleCensus"/>.
    ///
    /// This class deliberately has no dependency on the game assemblies, so
    /// CoiMapper.SchemaCheck can link it and exercise the real aggregation and ordering
    /// rather than hand-rolling a plausible-looking census the exporter never produces.
    /// Everything that must touch a game manager lives in <see cref="VehicleCensusWriter"/>.
    /// </summary>
    internal sealed class VehicleTally {
        /// <summary>
        /// The zone id for a machine the game gives no zone at all. Train cars always; road
        /// vehicles only when the zone manager could not be read, in which case the census
        /// carries an empty zone table and the panel offers no zone grouping.
        /// </summary>
        public const int NoZone = -1;

        private readonly Dictionary<string, VehicleCount> m_rows = new Dictionary<string, VehicleCount>();
        private int m_vehicles;
        private int m_trainCars;

        /// <summary>
        /// Counts one machine.
        ///
        /// The key is the kind, the zone *and* the prototype id, not the id alone. One
        /// prototype should never be two kinds, but if the game ever makes it so, keying on
        /// all three surfaces that as separate visible rows instead of silently filing
        /// everything under whichever pass happened to run first.
        ///
        /// Keying on the zone as well is what gives the panel its second pivot: a row is one
        /// prototype in one zone, the finest grain there is, and totalling by kind or by zone
        /// is then just a sum over rows. Storing a pre-grouped shape instead would force a
        /// format change the first time the panel wanted to group the other way.
        ///
        /// <paramref name="zone"/> is the game's own zone id, or <see cref="NoZone"/> for a
        /// machine that has none. Every road vehicle belongs to a zone — the default one if
        /// the player never moved it — so in practice that means train cars, and exports
        /// whose zone manager would not resolve.
        ///
        /// <paramref name="isTrainCar"/> is passed rather than derived from
        /// <paramref name="kind"/> because the leftover pass tallies both road vehicles and
        /// rolling stock as <see cref="VehicleKind.Unknown"/>.
        /// </summary>
        public void Add(string protoId, string name, VehicleKind kind, bool isTrainCar, int zone) {
            if (string.IsNullOrEmpty(protoId)) return;

            string key = (int)kind + " " + zone + " " + protoId;
            VehicleCount row;
            if (!m_rows.TryGetValue(key, out row)) {
                row = new VehicleCount {
                    Proto = protoId,
                    Name = string.IsNullOrEmpty(name) ? protoId : name,
                    Kind = kind,
                    Zone = zone,
                    Count = 0,
                };
                m_rows.Add(key, row);
            }

            row.Count++;
            if (isTrainCar) m_trainCars++; else m_vehicles++;
        }

        /// <summary>
        /// <paramref name="zones"/> is what every row's zone id points into, and its order is
        /// the order the panel groups in. An empty list means zone data could not be read;
        /// it never means the world has none, since the game always has a default zone.
        /// </summary>
        public VehicleCensus ToCensus(IEnumerable<VehicleZone> zones, int trains, int limit, int limitLeft) {
            var rows = new List<VehicleCount>(m_rows.Values);
            // Dictionary iteration order is unspecified, so without an explicit sort two
            // exports of the same unchanged world would differ byte for byte.
            rows.Sort(Compare);
            Disambiguate(rows);

            return new VehicleCensus {
                Exported = true,
                Types = rows.ToArray(),
                Zones = zones == null ? new VehicleZone[0] : new List<VehicleZone>(zones).ToArray(),
                Vehicles = m_vehicles,
                TrainCars = m_trainCars,
                Trains = trains,
                Limit = limit,
                LimitLeft = limitLeft,
            };
        }

        /// <summary>
        /// Makes every prototype's name unique by falling back to the prototype id where two
        /// *different* prototypes would otherwise read the same.
        ///
        /// The exporter already separates the common case — fuel variants like the diesel
        /// and hydrogen "Haul truck (dump)" — by appending the fuel. This is the net under
        /// that: one label covering two prototypes is unreadable, and the panel gives no
        /// other way to tell them apart, so a name collision should degrade to an ugly row
        /// rather than an ambiguous one. Nothing should reach it today; a later game version
        /// or a mod might.
        ///
        /// It counts prototypes per name rather than rows, which matters now that rows are
        /// split by zone: one prototype parked across three zones is three rows sharing one
        /// label, which is correct. Counting rows would read that as a collision and append
        /// the prototype id to every truck in the fleet.
        /// </summary>
        private static void Disambiguate(List<VehicleCount> rows) {
            var protosByName = new Dictionary<string, HashSet<string>>();
            foreach (var row in rows) {
                HashSet<string> protos;
                if (!protosByName.TryGetValue(row.Name, out protos)) {
                    protos = new HashSet<string>();
                    protosByName.Add(row.Name, protos);
                }
                protos.Add(row.Proto);
            }

            // Safe to rewrite Name in place: each row is read once, before it is changed, and
            // no rewritten name is ever looked up again.
            foreach (var row in rows) {
                if (protosByName[row.Name].Count > 1) row.Name = row.Name + " (" + row.Proto + ")";
            }
        }

        /// <summary>
        /// Kind first, since that is the panel's default grouping; then zone, so the rows of
        /// one zone sit together for the other grouping; then the most numerous prototype;
        /// then the name, so equal counts still have one stable order.
        ///
        /// Zone sorts on the raw id rather than on the zone table's order. The panel takes
        /// its group order from that table, so all this has to do is be deterministic —
        /// which keeps the tally free of any need to know what the zones actually are.
        /// </summary>
        private static int Compare(VehicleCount a, VehicleCount b) {
            if (a.Kind != b.Kind) return ((int)a.Kind).CompareTo((int)b.Kind);
            if (a.Zone != b.Zone) return a.Zone.CompareTo(b.Zone);
            if (a.Count != b.Count) return b.Count.CompareTo(a.Count);
            return string.Compare(a.Name, b.Name, StringComparison.Ordinal);
        }

        /// <summary>
        /// The census for an export that could not read the vehicle managers at all. The web
        /// app renders this as "not exported" rather than as an empty garage: a world with no
        /// vehicles is a real answer, and a failed read is not.
        ///
        /// The generated VehicleCensus is sealed with public fields, so this factory lives
        /// here rather than on the type itself.
        /// </summary>
        public static VehicleCensus NotExported() {
            return new VehicleCensus {
                Exported = false,
                Types = new VehicleCount[0],
                Zones = new VehicleZone[0],
            };
        }
    }
}
