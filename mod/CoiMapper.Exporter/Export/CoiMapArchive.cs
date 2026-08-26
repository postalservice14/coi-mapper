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
    /// </summary>
    public sealed class CoiMapArchive : IDisposable {
        private readonly ZipArchive m_zip;
        private readonly FileStream m_file;

        public CoiMapArchive(string path) {
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            m_file = new FileStream(path, FileMode.Create, FileAccess.Write);
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

        public void Dispose() {
            m_zip.Dispose();
            m_file.Dispose();
        }
    }
}
