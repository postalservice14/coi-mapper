using System;
using System.Text;

namespace CoiMapper.Export {
    /// <summary>
    /// Readable names for prototypes whose localised string is missing.
    ///
    /// Deliberately free of any game dependency so the schema check can link it, and so the
    /// same fallback is used for terrain materials and player surfaces alike.
    /// </summary>
    public static class DisplayNames {
        /// <summary>
        /// Turns a prototype id into something readable: drops a known suffix and splits camel
        /// case, so "GrassLush_Terrain" reads as "Grass Lush" and "ConcreteReinforced" as
        /// "Concrete Reinforced".
        /// </summary>
        /// <param name="suffix">Suffix to strip first, or null when the ids carry none.</param>
        public static string FromId(string id, string suffix = null) {
            if (string.IsNullOrEmpty(id)) return string.Empty;

            string name = suffix != null && id.EndsWith(suffix, StringComparison.Ordinal)
                ? id.Substring(0, id.Length - suffix.Length)
                : id;

            var sb = new StringBuilder(name.Length + 4);
            for (int i = 0; i < name.Length; i++) {
                if (i > 0 && char.IsUpper(name[i]) && !char.IsUpper(name[i - 1])) sb.Append(' ');
                sb.Append(name[i]);
            }
            return sb.ToString();
        }
    }
}
