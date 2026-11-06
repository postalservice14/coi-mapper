using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Text;
using CoiMapper.Schema;

namespace CoiMapper.Export {
    /// <summary>
    /// Assembles a `.coimap` ZIP: JSON members plus the per-tile raster planes.
    ///
    /// Planes are written as raw little-endian typed arrays rather than JSON. A 512x512
    /// map is 262,144 tiles; as JSON that is tens of megabytes to parse in the browser,
    /// where the binary form drops straight into a typed array.
    ///
    /// The archive is built beside its destination and only moved there by <see cref="Commit"/>.
    /// An export that throws part way would otherwise replace the last good map for that save
    /// with a truncated one, which has planes but no manifest and cannot be opened.
    /// </summary>
    public sealed class CoiMapArchive : IDisposable {
        private readonly string m_path;
        private readonly string m_tempPath;
        private readonly ZipArchive m_zip;
        private readonly FileStream m_file;
        private bool m_committed;

        public CoiMapArchive(string path) {
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path)));
            m_path = path;
            m_tempPath = path + ".tmp";
            m_file = new FileStream(m_tempPath, FileMode.Create, FileAccess.Write);
            m_zip = new ZipArchive(m_file, ZipArchiveMode.Create);
        }

        private Stream OpenEntry(string name) {
            return m_zip.CreateEntry(name, CompressionLevel.Optimal).Open();
        }

        /// <summary>Writes a JSON member using the schema-generated <c>WriteTo</c> methods.</summary>
        public void WriteJson(string name, Action<JsonWriter> body) {
            using (var stream = OpenEntry(name))
            using (var text = new StreamWriter(stream, new UTF8Encoding(false)))
            using (var json = new JsonWriter(text)) {
                body(json);
            }
        }

        public void WriteBytes(string name, byte[] data) {
            using (var stream = OpenEntry(name)) {
                stream.Write(data, 0, data.Length);
            }
        }

        /// <summary>Writes a `u8` plane: one byte per tile, row-major.</summary>
        public void WritePlaneU8(string planeName, byte[] values) {
            WriteBytes(CoiMapSchema.PlaneDir + planeName + ".u8", values);
        }

        /// <summary>Writes a `u16` plane: two little-endian bytes per tile, row-major.</summary>
        public void WritePlaneU16(string planeName, ushort[] values) {
            var bytes = new byte[values.Length * 2];
            Buffer.BlockCopy(values, 0, bytes, 0, bytes.Length);
            if (!BitConverter.IsLittleEndian) {
                // The format is defined as little-endian; every realistic target already is,
                // but do not silently emit the wrong byte order if that ever changes.
                for (int i = 0; i < bytes.Length; i += 2) {
                    byte t = bytes[i]; bytes[i] = bytes[i + 1]; bytes[i + 1] = t;
                }
            }
            WriteBytes(CoiMapSchema.PlaneDir + planeName + ".u16", bytes);
        }

        /// <summary>Members actually written, so the manifest can list only what exists.</summary>
        public readonly List<PlaneInfo> WrittenPlanes = new List<PlaneInfo>();

        public void AddPlaneInfo(string name, string dtype) {
            WrittenPlanes.Add(new PlaneInfo {
                Name = name,
                Dtype = dtype,
                File = CoiMapSchema.PlaneDir + name + "." + dtype,
            });
        }

        /// <summary>
        /// Finishes the archive and moves it to its destination, replacing any earlier export.
        /// Call this last: an archive disposed without it leaves the destination untouched.
        /// </summary>
        public void Commit() {
            m_zip.Dispose();     // writes the ZIP's central directory
            m_file.Dispose();
            // Delete and move rather than File.Replace, whose behaviour under the game's Mono
            // runtime cannot be exercised off-game. The worst case is a missing file, not a
            // corrupt one, and the next export puts it back.
            if (File.Exists(m_path)) File.Delete(m_path);
            File.Move(m_tempPath, m_path);
            m_committed = true;
        }

        /// <summary>Discards the temporary file unless <see cref="Commit"/> completed.</summary>
        public void Dispose() {
            if (m_committed) return;
            // Running during an exception's unwind, so nothing here may replace that exception.
            try { m_zip.Dispose(); } catch (Exception) { }
            try { m_file.Dispose(); } catch (Exception) { }
            try { File.Delete(m_tempPath); } catch (Exception) { }
        }
    }
}
