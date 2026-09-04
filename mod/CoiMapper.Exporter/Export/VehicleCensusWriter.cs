using System;
using System.Collections.Generic;
using System.Linq;
using Mafi;
using Mafi.Core.Entities.Dynamic;
using Mafi.Core.Trains;
using Mafi.Core.Vehicles;
using Mafi.Core.Vehicles.RocketTransporters;
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

                // Zones are read first because the default zone's id is what a vehicle the
                // player never moved reports as its own. Failing to read them costs the
                // panel's zone grouping and nothing else, so it does not gate anyManager.
                int defaultZoneId;
                var zones = ReadZones(TryResolve<ILogisticsZonesManager>(resolver), out defaultZoneId);

                var fleet = TryResolve<IVehiclesManager>(resolver);
                if (fleet != null) {
                    anyManager = true;
                    limit = fleet.MaxVehiclesLimit;
                    limitLeft = fleet.VehiclesLimitLeft;
                    TallyRoadVehicles(tally, fleet, defaultZoneId);
                }

                var railway = TryResolve<TrainsManager>(resolver);
                if (railway != null) {
                    anyManager = true;
                    trains = TallyTrains(tally, railway);
                }

                return anyManager ? tally.ToCensus(zones, trains, limit, limitLeft) : VehicleTally.NotExported();
            } catch (Exception e) {
                Log.Error("CoiMapper: vehicle census skipped — " + e);
                return VehicleTally.NotExported();
            }
        }

        // ── logistics zones ───────────────────────────────────────────────────
        /// <summary>
        /// The player's zones: the default one the game always has, then the rest in the
        /// game's own order. That order is what the panel groups by, so it is decided here
        /// rather than in the UI.
        ///
        /// Returns an empty list, and <see cref="VehicleTally.NoZone"/> as the default id, if
        /// the zones cannot be read at all. The two travel together deliberately — a census
        /// with a zone table but no known default id would file every unmoved vehicle under a
        /// zone that is not in the table, which is worse than exporting no zones at all.
        /// </summary>
        private static List<VehicleZone> ReadZones(ILogisticsZonesManager manager, out int defaultZoneId) {
            var rows = new List<VehicleZone>();
            defaultZoneId = VehicleTally.NoZone;
            if (manager == null) return rows;

            try {
                var fallback = manager.DefaultZone;
                if (fallback != null) {
                    defaultZoneId = fallback.Id.Value;
                    rows.Add(RowFor(fallback));
                }

                // As with the trains walk, IIndexable is Mafi's own type and needs the bridge.
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

            // Holds the pairing above: no known default means no usable zone table.
            if (defaultZoneId == VehicleTally.NoZone) rows.Clear();
            return rows;
        }

        private static VehicleZone RowFor(LogisticsZone zone) {
            return new VehicleZone {
                Id = zone.Id.Value,
                Name = ZoneName(zone),
                Color = ZoneColor(zone),
                IsDefault = zone.IsDefaultZone,
            };
        }

        /// <summary>
        /// The zone's name as the game shows it, which already resolves to the player's own
        /// name where they set one. Falls back to the id so a zone with no name at all still
        /// reads as something rather than as a blank heading.
        /// </summary>
        private static string ZoneName(LogisticsZone zone) {
            try {
                string name = zone.Name.Value;
                if (!string.IsNullOrEmpty(name)) return name;
            } catch (Exception) {
                // A zone with no string is not worth failing the census for.
            }
            return "Zone " + zone.Id.Value;
        }

        private static string ZoneColor(LogisticsZone zone) {
            try {
                var rgba = zone.Color;
                return "#" + rgba.R.ToString("x2") + rgba.G.ToString("x2") + rgba.B.ToString("x2");
            } catch (Exception) {
                return "#8899aa";
            }
        }

        /// <summary>
        /// The zone a road vehicle belongs to. Every vehicle belongs to one; the option is
        /// empty for a vehicle the player never moved out of the default zone, which is why
        /// this resolves to the default id rather than to "none".
        /// </summary>
        private static int ZoneOf(Vehicle vehicle, int defaultZoneId) {
            try {
                var zone = vehicle.AssignedZone;
                return zone.HasValue ? zone.Value.Id.Value : defaultZoneId;
            } catch (Exception) {
                return VehicleTally.NoZone;
            }
        }

        // ── road vehicles ─────────────────────────────────────────────────────
        /// <summary>
        /// Walks the manager's typed sets, which is what makes the kind known without any
        /// type tests — and means those four concrete classes, each in its own sub-namespace
        /// (Mafi.Core.Vehicles.Trucks, .Excavators, and so on), never have to be named here.
        ///
        /// The rocket transporter is the exception: the manager keeps no set for it, so it
        /// takes a type filter. It earns its own kind rather than being left to the pass
        /// below because the panel hides it — it is campaign equipment rather than fleet, and
        /// it consumes no vehicle quota — and hiding it by kind keeps Unknown meaning
        /// "unrecognised", which must stay visible.
        ///
        /// AllVehicles is walked last as a leftover pass, so a vehicle class the game adds
        /// later, or one a mod introduces, is still counted — under Unknown — rather than
        /// silently vanishing from the total.
        /// </summary>
        private static void TallyRoadVehicles(VehicleTally tally, IVehiclesManager fleet, int defaultZoneId) {
            var seen = new HashSet<object>();
            // Every one of these sets holds a Vehicle subclass, so one selector covers them
            // all; Func is contravariant in its argument, which is what lets it be reused.
            Func<Vehicle, int> zoneOf = v => ZoneOf(v, defaultZoneId);
            Tally(tally, seen, fleet.Trucks, VehicleKind.Truck, false, v => v.Prototype, zoneOf);
            Tally(tally, seen, fleet.Excavators, VehicleKind.Excavator, false, v => v.Prototype, zoneOf);
            Tally(tally, seen, fleet.TreeHarvesters, VehicleKind.TreeHarvester, false, v => v.Prototype, zoneOf);
            Tally(tally, seen, fleet.TreePlanters, VehicleKind.TreePlanter, false, v => v.Prototype, zoneOf);
            Tally(tally, seen, fleet.AllVehicles.OfType<RocketTransporter>(),
                VehicleKind.RocketTransporter, false, v => v.Prototype, zoneOf);
            Tally(tally, seen, fleet.AllVehicles, VehicleKind.Unknown, false, v => v.Prototype, zoneOf);
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
                // Rolling stock has no zone: logistics zones are a road-fleet concept and
                // TrainCarBase carries nothing equivalent.
                Func<TrainCarBase, int> noZone = c => VehicleTally.NoZone;
                Tally(tally, seen, train.Locomotives.AsEnumerable(), VehicleKind.Locomotive, true, c => c.Prototype, noZone);
                Tally(tally, seen, train.CargoWagons.AsEnumerable(), VehicleKind.CargoWagon, true, c => c.Prototype, noZone);
                // As with AllVehicles: catch any car that is neither, rather than lose it.
                Tally(tally, seen, train.TrainCars.AsEnumerable(), VehicleKind.Unknown, true, c => c.Prototype, noZone);
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
            Func<T, DynamicEntityProto> protoOf,
            Func<T, int> zoneOf) where T : class {
            if (items == null) return;

            foreach (var item in items) {
                if (item == null || !seen.Add(item)) continue;
                var proto = protoOf(item);
                if (proto == null) continue;
                tally.Add(proto.Id.Value, NameOf(proto), kind, isTrainCar, zoneOf(item));
            }
        }

        /// <summary>
        /// The game's own localised name, with the fuel variant appended.
        ///
        /// The name alone is not unique. TruckT3Loose and TruckT3LooseH are separate
        /// prototypes both called "Haul truck (dump)", differing only in that one burns
        /// diesel and the other hydrogen — the game tells them apart by icon, which a list
        /// of names cannot borrow, so without the fuel the panel shows the same label twice
        /// with two different counts and no way to tell which is which. The game models the
        /// distinction explicitly: every fuel variant belongs to a VehicleGroupProto whose
        /// stated purpose is to aggregate them.
        ///
        /// Skipped where the name already says it, so "Diesel locomotive" does not become
        /// "Diesel locomotive (Diesel)".
        /// </summary>
        private static string NameOf(DynamicEntityProto proto) {
            string name = LocalisedName(proto);
            string fuel = FuelName(proto);
            if (fuel != null && name.IndexOf(fuel, StringComparison.OrdinalIgnoreCase) < 0) {
                return name + " (" + fuel + ")";
            }
            return name;
        }

        /// <summary>
        /// Falls back to a name derived from the id, as the terrain material legend does, if
        /// the string table has no entry.
        /// </summary>
        private static string LocalisedName(DynamicEntityProto proto) {
            try {
                string localised = proto.Strings.Name.TranslatedString;
                if (!string.IsNullOrEmpty(localised)) return localised;
            } catch (Exception) {
                // A prototype with no string table entry is not worth failing the export for.
            }
            return DisplayNames.FromId(proto.Id.Value);
        }

        /// <summary>
        /// The fuel product's name — "Diesel", "Hydrogen" — or null for anything that does
        /// not burn a fuel. Both road vehicles and locomotives reach it through
        /// IEntityWithFuelTankProto, so this needs no per-family branching.
        /// </summary>
        private static string FuelName(DynamicEntityProto proto) {
            try {
                var burner = proto as IEntityWithFuelTankProto;
                if (burner == null) return null;
                var tank = burner.FuelTankProto;
                if (!tank.HasValue) return null;
                string fuel = tank.Value.Product.Strings.Name.TranslatedString;
                return string.IsNullOrEmpty(fuel) ? null : fuel;
            } catch (Exception) {
                return null;
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
