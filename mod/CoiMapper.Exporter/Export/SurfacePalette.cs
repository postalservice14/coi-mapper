using System;

namespace CoiMapper.Export {
    /// <summary>
    /// Map colours for player-placed surfaces — concrete, brick, metal flooring.
    ///
    /// These need their own table because <c>TerrainTileSurfaceProto.Gfx</c> carries no map
    /// colour at all: unlike a terrain material it exposes only a texture spec, an edge spec,
    /// a dust tint and an icon path. There is nothing to fall back to, so every colour here
    /// is chosen rather than read.
    ///
    /// Deliberately separate from <see cref="MaterialPalette"/> even though several ids
    /// coincide. "Cobblestone" and "Sand" exist in both and mean different things — natural
    /// ground versus something the player laid — and paving that borrowed the terrain tone
    /// would be invisible against the ground it covers, which is the whole point of the layer.
    ///
    /// Matching is on the prototype id, never the display name: display names are localised,
    /// so a player running the game in German would otherwise lose every colour.
    /// </summary>
    public static class SurfacePalette {
        /// <summary>
        /// Ordered id-prefix rules. Longest and most specific first, so "ConcreteReinforced"
        /// is not swallowed by "Concrete" and "Metal1" is not swallowed by "Metal".
        ///
        /// The metals descend in lightness in their numbered order, so a base that mixes them
        /// reads as deliberate banding rather than noise.
        /// </summary>
        private static readonly string[][] Surfaces = {
            new[] { "ConcreteReinforced", "#7f8288" },
            new[] { "DefaultConcrete",    "#9a9a95" },
            new[] { "Concrete",           "#9a9a95" },
            new[] { "Bricks",             "#a3583f" },
            new[] { "Cobblestone",        "#8b867c" },
            new[] { "Sand1",              "#cbb98f" },
            new[] { "Sand2",              "#bda87c" },
            new[] { "Sand",               "#c4b085" },
            new[] { "Metal1",             "#8e959c" },
            new[] { "Metal2",             "#7c848c" },
            new[] { "Metal3",             "#6b737b" },
            new[] { "Metal4",             "#5c646c" },
            new[] { "Metal",              "#79818a" },
            new[] { "Gold",               "#c9a227" },
            new[] { "SettlementPaths",    "#b4a68c" },
        };

        /// <summary>
        /// Colour for a surface prototype id, falling back to an id-derived colour so a
        /// modded surface is still visible and still the same colour on every export.
        /// </summary>
        public static string ColorFor(string surfaceId) {
            if (!string.IsNullOrEmpty(surfaceId)) {
                for (int i = 0; i < Surfaces.Length; i++) {
                    if (surfaceId.StartsWith(Surfaces[i][0], StringComparison.OrdinalIgnoreCase)) {
                        return Surfaces[i][1];
                    }
                }
            }
            return MaterialPalette.HashColor(surfaceId);
        }
    }
}
