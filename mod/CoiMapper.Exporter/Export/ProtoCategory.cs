using System;
using Mafi.Core.Entities;

namespace CoiMapper.Export {
    /// <summary>
    /// Groups prototypes into the categories the web map colours by.
    ///
    /// Derived from each prototype's .NET type and namespace rather than from game data:
    /// the game has no single "category" concept that covers every building, but its type
    /// hierarchy already sorts them (Mafi.Core.Buildings.Mine, .Factory.ElectricPower, …).
    /// This also means modded buildings land in a sensible bucket for free.
    /// </summary>
    public static class ProtoCategory {
        private static readonly string[][] Rules = {
            new[] { "Mining",     "Mine", "Excavat", "Crusher", "OreSort", "Quarry" },
            new[] { "Smelting",   "Smelt", "Furnace", "Foundry", "Caster", "Metallurg" },
            new[] { "Chemistry",  "Chemic", "Refin", "Distill", "Electroly", "Reactor", "Fermenter" },
            new[] { "Power",      "Power", "Generator", "Turbine", "Boiler", "Solar", "Nuclear", "Shaft", "Battery", "Pylon" },
            new[] { "Storage",    "Storage", "Silo", "Warehouse", "Container" },
            new[] { "Transport",  "Transport", "Conveyor", "Depot", "Cargo", "Truck", "Train", "Rail", "Dock", "Port", "Ship" },
            new[] { "Farming",    "Farm", "Forestry", "Greenhouse", "Orchard", "Crop", "Tree" },
            new[] { "Settlement", "Settlement", "Housing", "Hospital", "School", "Health", "Pops" },
            new[] { "Fluid",      "Fluid", "Pipe", "Pump", "Tank", "Water", "Steam" },
            new[] { "Manufacture", "Assembl", "Workshop", "MachineShop", "Maintenance", "Factory", "Machine" },
        };

        public static string Of(EntityProto proto) {
            if (proto == null) return "Other";
            var type = proto.GetType();
            // Namespace first, then type name: the namespace is the stronger signal, and
            // checking it first stops a generic name like "Machine" from winning.
            string haystack = (type.Namespace ?? string.Empty) + "|" + type.Name;

            foreach (var rule in Rules) {
                for (int i = 1; i < rule.Length; i++) {
                    if (haystack.IndexOf(rule[i], StringComparison.OrdinalIgnoreCase) >= 0) return rule[0];
                }
            }
            return "Other";
        }
    }
}
