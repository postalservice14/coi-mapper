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
        private readonly Dictionary<string, VehicleCount> m_rows = new Dictionary<string, VehicleCount>();
        private int m_vehicles;
        private int m_trainCars;

        /// <summary>
        /// Counts one machine.
        ///
        /// The key is the kind *and* the prototype id, not the id alone. One prototype should
        /// never be two kinds, but if the game ever makes it so, keying on both surfaces that
        /// as two visible rows instead of silently filing everything under whichever pass
        /// happened to run first.
        ///
        /// <paramref name="isTrainCar"/> is passed rather than derived from
        /// <paramref name="kind"/> because the leftover pass tallies both road vehicles and
        /// rolling stock as <see cref="VehicleKind.Unknown"/>.
        /// </summary>
        public void Add(string protoId, string name, VehicleKind kind, bool isTrainCar) {
            if (string.IsNullOrEmpty(protoId)) return;

            string key = (int)kind + " " + protoId;
            VehicleCount row;
            if (!m_rows.TryGetValue(key, out row)) {
                row = new VehicleCount {
                    Proto = protoId,
                    Name = string.IsNullOrEmpty(name) ? protoId : name,
                    Kind = kind,
                    Count = 0,
                };
                m_rows.Add(key, row);
            }

            row.Count++;
            if (isTrainCar) m_trainCars++; else m_vehicles++;
        }

        public VehicleCensus ToCensus(int trains, int limit, int limitLeft) {
            var rows = new List<VehicleCount>(m_rows.Values);
            // Dictionary iteration order is unspecified, so without an explicit sort two
            // exports of the same unchanged world would differ byte for byte.
            rows.Sort(Compare);
            Disambiguate(rows);

            return new VehicleCensus {
                Exported = true,
                Types = rows.ToArray(),
                Vehicles = m_vehicles,
                TrainCars = m_trainCars,
                Trains = trains,
                Limit = limit,
                LimitLeft = limitLeft,
            };
        }

        /// <summary>
        /// Makes every row's name unique by falling back to the prototype id where two rows
        /// would otherwise read the same.
        ///
        /// The exporter already separates the common case — fuel variants like the diesel
        /// and hydrogen "Haul truck (dump)" — by appending the fuel. This is the net under
        /// that: two rows with one label and two counts is unreadable, and the panel gives
        /// no other way to tell them apart, so a name collision should degrade to an ugly
        /// row rather than an ambiguous one. Nothing should reach it today; a later game
        /// version or a mod might.
        /// </summary>
        private static void Disambiguate(List<VehicleCount> rows) {
            var byName = new Dictionary<string, int>();
            foreach (var row in rows) {
                int seen;
                byName.TryGetValue(row.Name, out seen);
                byName[row.Name] = seen + 1;
            }

            foreach (var row in rows) {
                if (byName[row.Name] > 1) row.Name = row.Name + " (" + row.Proto + ")";
            }
        }

        /// <summary>
        /// Kind first, since that grouping is what the panel renders; then the most numerous
        /// prototype; then the name, so equal counts still have one stable order.
        /// </summary>
        private static int Compare(VehicleCount a, VehicleCount b) {
            if (a.Kind != b.Kind) return ((int)a.Kind).CompareTo((int)b.Kind);
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
            return new VehicleCensus { Exported = false, Types = new VehicleCount[0] };
        }
    }
}
