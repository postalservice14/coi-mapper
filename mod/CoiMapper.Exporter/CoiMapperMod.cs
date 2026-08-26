using System;
using System.IO;
using System.Linq;
using Mafi;
using Mafi.Core;
using Mafi.Core.Game;
using Mafi.Core.Mods;
using Mafi.Core.Prototypes;
using Mafi.Core.SaveGame;
using Mafi.Collections;
using CoiMapper.Export;

namespace CoiMapper {
    /// <summary>
    /// Exports the loaded world to a `.coimap` file for the interactive web map.
    ///
    /// Exports run when a world is loaded and again after every save, so a fresh map is a
    /// keypress away without this assembly having to reference Mafi.Unity — keyboard input
    /// lives in the Unity layer, and the simulation layer this mod targets has no notion of
    /// key bindings.
    ///
    /// The member shapes below (notably <see cref="JsonConfig"/> and <see cref="ModConfig"/>)
    /// are version-sensitive and follow the working 0.8.x reference implementation in
    /// FelixZett/captain-of-industry-data-exporter.
    /// </summary>
    public sealed class CoiMapperMod : IMod {
        private readonly ModManifest m_manifest;
        private DependencyResolver m_resolver;
        private ISaveManager m_saveManager;
        /// <summary>Guards against a save completing while an export is still running.</summary>
        private bool m_isExporting;

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
            m_resolver = resolver;

            // Saving the game is the on-demand trigger: it needs no key binding, cannot
            // clash with the game's own shortcuts, and reads naturally as "save, then look
            // at the map". Hooking OnSaveDone rather than BeforeSave keeps the export off
            // the critical path, so a slow export never delays the save itself.
            try {
                m_saveManager = (ISaveManager)resolver.Resolve(typeof(ISaveManager));
                m_saveManager.OnSaveDone += onSaveDone;
            } catch (Exception e) {
                Log.Error("CoiMapper: could not subscribe to save events — " + e);
            }

            // A freshly generated map reaches Initialize before the player has built
            // anything, so only a loaded world is worth exporting up front.
            if (wasLoaded) exportNow("world load");
        }

        private void onSaveDone(SaveResult result) {
            // Do not export from a save that failed; the world may be mid-recovery.
            if (result.Exception.HasValue || result.Error.HasValue) return;
            exportNow("save");
        }

        private void exportNow(string trigger) {
            if (m_isExporting || m_resolver == null) return;
            m_isExporting = true;
            try {
                string gameName = m_saveManager != null ? m_saveManager.GameName : null;
                string path = Path.Combine(ExportDirectory(), FileNameFor(gameName));
                new WorldExporter(m_resolver).ExportTo(path, gameName);
                Log.Info("CoiMapper: exported map to " + path + " (after " + trigger + ")");
            } catch (Exception e) {
                // An export failure must never take the game down with it.
                Log.Error("CoiMapper: export failed after " + trigger + " — " + e);
            } finally {
                m_isExporting = false;
            }
        }

        /// <summary>
        /// Names the file after the save, so several bases do not overwrite one another.
        /// </summary>
        private static string FileNameFor(string gameName) {
            if (string.IsNullOrEmpty(gameName)) return "world.coimap";
            var invalid = Path.GetInvalidFileNameChars();
            string safe = new string(gameName.Select(c => invalid.Contains(c) ? '_' : c).ToArray()).Trim();
            return (safe.Length == 0 ? "world" : safe) + ".coimap";
        }

        private static string ExportDirectory() {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "Captain of Industry", "CoiMapper");
        }

        public void Dispose() {
            // A leaked handler would keep this mod, and the world it captured, alive.
            if (m_saveManager != null) {
                try { m_saveManager.OnSaveDone -= onSaveDone; } catch { }
                m_saveManager = null;
            }
            m_resolver = null;
        }
    }
}
