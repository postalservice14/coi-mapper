using System;
using System.Collections.Generic;
using Mafi;
using Mafi.Core.Entities.Dynamic;
using Mafi.Core.Trains;
using Mafi.Core.Vehicles;
using CoiMapper.Schema;

namespace CoiMapper.Export {
    /// <summary>
    /// Counts the world's mobile machines: road vehicles from the vehicles manager, and
    /// locomotives and cargo wagons from the trains manager.
    ///
    /// These are not static entities, so the main entity walk in <see cref="WorldExporter"/>
    /// never sees them — <c>GetAllEntitiesOfType&lt;IStaticEntity&gt;()</c> excludes them by
    /// construction. They need their own managers, which is what this file is for.
    ///
    /// Every API used here was read off the decompiled game assemblies rather than guessed;
    /// see mod/README.md for the decompilation workflow. As in
    /// <see cref="TerrainOverlays"/>, each manager is resolved defensively: this runs on the
    /// save path, so a manager a later game version renames must cost the census rather than
    /// the player's entire export.
    ///
    /// Cargo ships are deliberately not counted. They have no equivalent fleet manager, and
    /// the panel is titled to make their absence read as scope rather than as a bug.
    /// </summary>
    internal static class VehicleCensusWriter {
        public static VehicleCensus Build(DependencyResolver resolver) {
            try {
                var tally = new VehicleTally();
                int trains = 0, limit = 0, limitLeft = 0;
                bool anyManager = false;

                var fleet = TryResolve<IVehiclesManager>(resolver);
                if (fleet != null) {
                    anyManager = true;
                    limit = fleet.MaxVehiclesLimit;
                    limitLeft = fleet.VehiclesLimitLeft;
                    TallyRoadVehicles(tally, fleet);
                }

                var railway = TryResolve<TrainsManager>(resolver);
                if (railway != null) {
                    anyManager = true;
                    trains = TallyTrains(tally, railway);
                }

                return anyManager ? tally.ToCensus(trains, limit, limitLeft) : VehicleTally.NotExported();
            } catch (Exception e) {
                Log.Error("CoiMapper: vehicle census skipped — " + e);
                return VehicleTally.NotExported();
            }
        }

        // ── road vehicles ─────────────────────────────────────────────────────
        /// <summary>
        /// Walks the manager's typed sets, which is what makes the kind known without any
        /// type tests — and means the four concrete classes, each in its own sub-namespace
        /// (Mafi.Core.Vehicles.Trucks, .Excavators, and so on), never have to be named here.
        ///
        /// AllVehicles is walked last as a leftover pass, so a vehicle class the game adds
        /// later, or one a mod introduces, is still counted — under Unknown — rather than
        /// silently vanishing from the total.
        /// </summary>
        private static void TallyRoadVehicles(VehicleTally tally, IVehiclesManager fleet) {
            var seen = new HashSet<object>();
            Tally(tally, seen, fleet.Trucks, VehicleKind.Truck, false, v => v.Prototype);
            Tally(tally, seen, fleet.Excavators, VehicleKind.Excavator, false, v => v.Prototype);
            Tally(tally, seen, fleet.TreeHarvesters, VehicleKind.TreeHarvester, false, v => v.Prototype);
            Tally(tally, seen, fleet.TreePlanters, VehicleKind.TreePlanter, false, v => v.Prototype);
            Tally(tally, seen, fleet.AllVehicles, VehicleKind.Unknown, false, v => v.Prototype);
        }

        // ── trains ────────────────────────────────────────────────────────────
        /// <summary>
        /// Counts rolling stock per prototype and returns the number of assembled trains.
        ///
        /// The train total is a header figure rather than a census row on purpose: a row
        /// claims to be "one prototype", so a synthetic "trains" row would break any sum
        /// over the counts.
        ///
        /// A train still being assembled in a depot has IsSpawned false; it is counted
        /// anyway, since the player has already paid for it and the game lists it. Destroyed
        /// trains are skipped — the export runs from the save callback, where one destroyed
        /// this tick can still be present in the collection.
        /// </summary>
        private static int TallyTrains(VehicleTally tally, TrainsManager railway) {
            int trains = 0;

            // Mafi's IIndexable and ImmutableArray are its own types and do not implement
            // IEnumerable<T>; AsEnumerable() is the bridge. (Its IReadOnlySet, used for the
            // road vehicles above, does implement it — hence the difference.)
            foreach (var train in railway.Trains.AsEnumerable()) {
                if (train == null || train.IsDestroyed) continue;
                trains++;

                var seen = new HashSet<object>();
                Tally(tally, seen, train.Locomotives.AsEnumerable(), VehicleKind.Locomotive, true, c => c.Prototype);
                Tally(tally, seen, train.CargoWagons.AsEnumerable(), VehicleKind.CargoWagon, true, c => c.Prototype);
                // As with AllVehicles: catch any car that is neither, rather than lose it.
                Tally(tally, seen, train.TrainCars.AsEnumerable(), VehicleKind.Unknown, true, c => c.Prototype);
            }

            return trains;
        }

        // ── shared ────────────────────────────────────────────────────────────
        /// <summary>
        /// Counts one collection of machines.
        ///
        /// DrivingEntityProto (road vehicles) and TrainCarBaseProto (locomotives, wagons)
        /// both derive from DynamicEntityProto, so a single selector covers both families.
        ///
        /// Entity equality is by id, so a HashSet of the machines themselves is a correct
        /// identity dedupe between the typed passes and the leftover pass.
        /// </summary>
        private static void Tally<T>(
            VehicleTally tally,
            HashSet<object> seen,
            IEnumerable<T> items,
            VehicleKind kind,
            bool isTrainCar,
            Func<T, DynamicEntityProto> protoOf) where T : class {
            if (items == null) return;

            foreach (var item in items) {
                if (item == null || !seen.Add(item)) continue;
                var proto = protoOf(item);
                if (proto == null) continue;
                tally.Add(proto.Id.Value, NameOf(proto), kind, isTrainCar);
            }
        }

        /// <summary>
        /// The game's own localised name, which already carries the fuel variant — "Haul
        /// truck (dump) (Diesel)". Falls back to a name derived from the id, as the terrain
        /// material legend does, if the string table has no entry.
        /// </summary>
        private static string NameOf(DynamicEntityProto proto) {
            try {
                string localised = proto.Strings.Name.TranslatedString;
                if (!string.IsNullOrEmpty(localised)) return localised;
            } catch (Exception) {
                // A prototype with no string table entry is not worth failing the export for.
            }
            return DisplayNames.FromId(proto.Id.Value);
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
