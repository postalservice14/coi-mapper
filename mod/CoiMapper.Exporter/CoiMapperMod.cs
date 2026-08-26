using System;
using System.IO;
using Mafi;
using Mafi.Core;
using Mafi.Core.Game;
using Mafi.Core.Mods;
using Mafi.Core.Prototypes;
using Mafi.Collections;
using CoiMapper.Export;

namespace CoiMapper {
    /// <summary>
    /// Exports the loaded world to a `.coimap` file for the interactive web map.
    ///
    /// The member shapes below (notably <see cref="JsonConfig"/> and <see cref="ModConfig"/>)
    /// are version-sensitive and follow the working 0.8.x reference implementation in
    /// FelixZett/captain-of-industry-data-exporter.
    /// </summary>
    public sealed class CoiMapperMod : IMod {
        private readonly ModManifest m_manifest;

        public CoiMapperMod(ModManifest manifest) {
            m_manifest = manifest;
        }

        public string Name { get { return m_manifest.Id; } }
        public int Version { get { return 1; } }
        public bool IsUiOnly { get { return false; } }
        public ModManifest Manifest { get { return m_manifest; } }

        public ModJsonConfig JsonConfig { get { return new ModJsonConfig(this); } }
        public Option<IConfig> ModConfig { get { return Option<IConfig>.None; } }

        public void RegisterDependencies(DependencyResolverBuilder builder, ProtosDb protosDb, bool wasLoaded) { }
        public void EarlyInit(DependencyResolver resolver) { }
        public void RegisterPrototypes(ProtoRegistrator registrator) { }

        // Typed as `object` so this assembly never needs a reference to Mafi.Unity.
        public void RegisterWorld(object worldBuilder, ProtosDb protosDb) { }

        public void MigrateJsonConfig(VersionSlim oldVersion, Dict<string, object> dict) { }

        public void Initialize(DependencyResolver resolver, bool wasLoaded) {
            // Only a loaded world has terrain and entities worth exporting; a freshly
            // generated map reaches Initialize before the player has built anything.
            if (!wasLoaded) return;

            try {
                string path = Path.Combine(ExportDirectory(), "world.coimap");
                new WorldExporter(resolver).ExportTo(path);
                Log.Info("CoiMapper: exported map to " + path);
            } catch (Exception e) {
                // An export failure must never take the game down with it.
                Log.Error("CoiMapper: export failed — " + e);
            }
        }

        private static string ExportDirectory() {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "Captain of Industry", "CoiMapper");
        }

        public void Dispose() { }
    }
}
