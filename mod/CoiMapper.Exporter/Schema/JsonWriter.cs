using System;
using System.Globalization;
using System.IO;

namespace CoiMapper.Schema {
    /// <summary>
    /// Minimal streaming JSON writer.
    ///
    /// Hand-rolled rather than pulled from a package: mods are loaded into the game's own
    /// AppDomain, so an extra serializer dependency risks colliding with whatever version
    /// the game or another mod already loaded.
    /// </summary>
    public sealed class JsonWriter : IDisposable {
        private readonly TextWriter m_out;
        private bool m_needsComma;

        public JsonWriter(TextWriter output) {
            m_out = output;
        }

        private void Separate() {
            if (m_needsComma) m_out.Write(',');
            m_needsComma = false;
        }

        public JsonWriter BeginObject() { Separate(); m_out.Write('{'); return this; }
        public JsonWriter EndObject() { m_out.Write('}'); m_needsComma = true; return this; }
        public JsonWriter BeginArray() { Separate(); m_out.Write('['); return this; }
        public JsonWriter EndArray() { m_out.Write(']'); m_needsComma = true; return this; }

        public JsonWriter Name(string name) {
            Separate();
            WriteString(name);
            m_out.Write(':');
            return this;
        }

        public JsonWriter Value(string value) {
            Separate();
            if (value == null) m_out.Write("null"); else WriteString(value);
            m_needsComma = true;
            return this;
        }

        public JsonWriter Value(int value) {
            Separate();
            m_out.Write(value.ToString(CultureInfo.InvariantCulture));
            m_needsComma = true;
            return this;
        }

        public JsonWriter Value(bool value) {
            Separate();
            m_out.Write(value ? "true" : "false");
            m_needsComma = true;
            return this;
        }

        public JsonWriter Value(float value) {
            Separate();
            // "R" round-trips; invariant culture keeps a comma-decimal locale from
            // producing JSON that no parser will accept.
            m_out.Write(float.IsNaN(value) || float.IsInfinity(value)
                ? "null"
                : value.ToString("R", CultureInfo.InvariantCulture));
            m_needsComma = true;
            return this;
        }

        private void WriteString(string s) {
            m_out.Write('"');
            foreach (char c in s) {
                switch (c) {
                    case '"': m_out.Write("\\\""); break;
                    case '\\': m_out.Write("\\\\"); break;
                    case '\n': m_out.Write("\\n"); break;
                    case '\r': m_out.Write("\\r"); break;
                    case '\t': m_out.Write("\\t"); break;
                    case '\b': m_out.Write("\\b"); break;
                    case '\f': m_out.Write("\\f"); break;
                    default:
                        if (c < 0x20 || c > 0x7e) m_out.Write("\\u" + ((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else m_out.Write(c);
                        break;
                }
            }
            m_out.Write('"');
        }

        public void Dispose() {
            m_out.Flush();
        }
    }
}
