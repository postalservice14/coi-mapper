using System;

namespace CoiMapper.Export {
    /// <summary>
    /// Colours for terrain materials.
    ///
    /// Material prototypes carry no map-friendly colour, so known materials get a hand-picked
    /// one and anything else (including modded materials) falls back to a colour derived from
    /// its id — stable across exports, and distinct enough to tell layers apart.
    /// </summary>
    public static class MaterialPalette {
        private static readonly string[][] Known = {
            new[] { "dirt",      "#6b5334" },
            new[] { "soil",      "#5f4a2e" },
            new[] { "grass",     "#5d7a3a" },
            new[] { "sand",      "#c9b083" },
            new[] { "gravel",    "#8d8a80" },
            new[] { "rock",      "#7a7469" },
            new[] { "stone",     "#807a70" },
            new[] { "coal",      "#2f2f33" },
            new[] { "iron",      "#a3542f" },
            new[] { "copper",    "#2f8f77" },
            new[] { "gold",      "#d4af37" },
            new[] { "limestone", "#cfc6ae" },
            new[] { "clay",      "#9b6b4f" },
            new[] { "snow",      "#dfe4e8" },
            new[] { "ice",       "#cfe6f0" },
            new[] { "ash",       "#57545" },
            new[] { "slag",      "#4a4038" },
        };

        public static string ColorFor(string materialId) {
            if (string.IsNullOrEmpty(materialId)) return "#8a8a8a";

            foreach (var entry in Known) {
                if (materialId.IndexOf(entry[0], StringComparison.OrdinalIgnoreCase) >= 0) return entry[1];
            }

            // Deterministic fallback: hash the id to a hue, then keep saturation and
            // lightness in an earthy band so it does not clash with the known colours.
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
