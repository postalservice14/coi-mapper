using System;

namespace CoiMapper.Export {
    /// <summary>
    /// Map colours for terrain materials.
    ///
    /// The game exposes <c>TerrainMaterialProto.Graphics.Color</c>, but that is a coarse
    /// particle/dust tint rather than how the ground renders: grass, lush grass, forest floor,
    /// every dirt variant and compost all share one saddle brown, and sand is pure yellow. On
    /// a real map that is nearly 30% of the surface, so the island would come out brown.
    ///
    /// Natural ground therefore gets a curated colour here, and everything else — ores in
    /// particular, whose graphics colours are genuinely distinct — falls back to the game's.
    ///
    /// Matching is on the prototype id, never the display name: display names are localised,
    /// so a player running the game in German would otherwise lose every colour.
    /// </summary>
    public static class MaterialPalette {
        /// <summary>
        /// Ordered id-prefix rules. Longest and most specific first, so "GrassLush" is not
        /// swallowed by "Grass" and "RockDisrupted" is not swallowed by "Rock".
        ///
        /// Disrupted and crushed variants are deliberately kept slightly distinct: they mark
        /// ground that has been mined or dumped, which is worth seeing on the map.
        /// </summary>
        private static readonly string[][] NaturalGround = {
            // Vegetation. The bare "Flowers*" materials are grass in bloom — the game calls
            // them "Grass (red flowers)" and so on — so they stay green with a hint of the
            // bloom colour rather than reading as bare soil.
            new[] { "GrassLush",           "#6f9440" },
            new[] { "GrassNoDetails",      "#5f7f38" },
            new[] { "ForestFloor",         "#4a5c30" },
            new[] { "ForestGrass",         "#5c7a38" },
            new[] { "ForestDirt",          "#5a4a30" },
            new[] { "FlowersPurpleLush",   "#6d8f52" },
            new[] { "FlowersYellowLush",   "#7b9a44" },
            new[] { "FlowersRed",          "#6c8340" },
            new[] { "FlowersWhite",        "#6b8a4c" },
            new[] { "Flowers",             "#688540" },
            new[] { "Grass",               "#5d7a3a" },

            // Soils
            new[] { "DirtFlowersPurple", "#7a6250" },
            new[] { "DirtFlowersRed",    "#7d5c4c" },
            new[] { "DirtFlowersWhite",  "#7e6a5c" },
            new[] { "DirtFlowersYellow", "#7f6a48" },
            new[] { "DirtNoDetails",     "#6b5334" },
            new[] { "DirtLush",          "#6a5738" },
            new[] { "DirtBare",          "#7a6242" },
            new[] { "Dirt",              "#6b5334" },
            new[] { "Compost",           "#4c3a24" },
            new[] { "FarmGround",        "#7d6136" },   // tilled, distinct from bare dirt
            new[] { "LandfillOld",       "#6a6152" },

            // Rock and aggregate
            new[] { "RockNoGrassCover", "#847d70" },
            new[] { "RockDisrupted",    "#8a8276" },
            new[] { "HardenedRock",     "#6e6a63" },
            new[] { "Bedrock",          "#5f5c57" },
            new[] { "Cobblestone",      "#7e7a74" },
            new[] { "Gravel",           "#9a958b" },
            new[] { "Rock",             "#7a7469" },

            // Sand
            new[] { "ManufacturedSand", "#cdbb93" },
            new[] { "SandDisrupted",    "#d0bb90" },
            new[] { "Sand",             "#c9b083" },
        };

        /// <summary>
        /// True when the id names natural ground we colour ourselves.
        ///
        /// Matches on a prefix, not a substring. Ids take the form "<c>Name_Terrain</c>", and a
        /// substring match silently mis-colours anything whose name contains another material's:
        /// "RockNoGrassCover" contains "Grass", so it came out lawn green rather than stone.
        /// </summary>
        public static bool TryNaturalColor(string materialId, out string hex) {
            hex = null;
            if (string.IsNullOrEmpty(materialId)) return false;

            for (int i = 0; i < NaturalGround.Length; i++) {
                if (materialId.StartsWith(NaturalGround[i][0], StringComparison.OrdinalIgnoreCase)) {
                    hex = NaturalGround[i][1];
                    return true;
                }
            }
            return false;
        }

        /// <summary>
        /// Last-resort colour when a material has neither a curated entry nor usable graphics.
        /// Derived from the id so it is at least stable across exports.
        /// </summary>
        public static string ColorFor(string materialId) {
            string natural;
            if (TryNaturalColor(materialId, out natural)) return natural;
            if (string.IsNullOrEmpty(materialId)) return "#8a8a8a";

            int hash = 0;
            foreach (char c in materialId) hash = unchecked(hash * 31 + c);
            return HslToHex(Math.Abs(hash) % 360, 0.28, 0.42);
        }

        private static string HslToHex(double h, double s, double l) {
            double c = (1 - Math.Abs(2 * l - 1)) * s;
            double x = c * (1 - Math.Abs(h / 60.0 % 2 - 1));
            double m = l - c / 2;
            double r = 0, g = 0, b = 0;
            if (h < 60) { r = c; g = x; }
            else if (h < 120) { r = x; g = c; }
            else if (h < 180) { g = c; b = x; }
            else if (h < 240) { g = x; b = c; }
            else if (h < 300) { r = x; b = c; }
            else { r = c; b = x; }
            return "#" + Byte(r + m) + Byte(g + m) + Byte(b + m);
        }

        private static string Byte(double v) {
            return ((int)Math.Round(Math.Max(0, Math.Min(1, v)) * 255)).ToString("x2");
        }
    }
}
