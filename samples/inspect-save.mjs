#!/usr/bin/env node
/**
 * Inspect a Captain of Industry `.save` file without any game assemblies.
 *
 * Reads the outer header, verifies both CRC32s, walks the chunk table, decodes
 * `ModTypes` fully, and pulls game version / map name / thumbnail out of `SaveInfo`.
 *
 * It deliberately does NOT try to decode the `Resolver` chunk — see docs/save-format.md
 * for why that requires the game's own assemblies.
 *
 *   node samples/inspect-save.mjs samples/YT21e.save [--thumb out.jpg]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const HEADER_BYTES = 40;

/** Chunk tags are ASCII reversed, then read as a little-endian uint64. */
const chunkTag = (name) => Buffer.from([...name].reverse().join(''), 'ascii');

const CHUNKS = ['ModTypes', 'SaveInfo', 'GlobConf', 'GlobCfV2', 'Resolver', 'SaveStop'];

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Minimal reader for MaFi's BlobWriter encoding (LEB128 varints, length-prefixed UTF-8). */
class BlobReader {
  constructor(buf, pos = 0) { this.buf = buf; this.pos = pos; }
  u64() { const v = this.buf.readBigUInt64LE(this.pos); this.pos += 8; return v; }
  varint() {
    let result = 0, shift = 0, b;
    do {
      b = this.buf[this.pos++];
      result += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b & 0x80);
    return result;
  }
  utf8(len) { const s = this.buf.toString('utf8', this.pos, this.pos + len); this.pos += len; return s; }
}

/** VersionSlim packs four ushorts: major<<48 | minor<<32 | patch<<16 | hotfix. */
function formatVersion(v) {
  const part = (shift) => Number((v >> BigInt(shift)) & 0xffffn);
  const [hotfix, patch, minor, major] = [0, 16, 32, 48].map(part);
  let s = `${major}.${minor}.${patch}`;
  if (hotfix > 0 && hotfix <= 26) s += String.fromCharCode(96 + hotfix); // 1='a', 2='b', ...
  else if (hotfix > 26) s += `.${hotfix}`;
  return s;
}

export function parseSave(fileBytes) {
  if (fileBytes.length < HEADER_BYTES) throw new Error('Too small to be a COI save.');

  const magic = chunkTag('MaFiSave');
  if (!fileBytes.subarray(0, 8).equals(magic)) {
    throw new Error('Missing "MaFiSave" magic — not a Captain of Industry save file.');
  }

  const header = {
    saveVersion: fileBytes.readUInt32LE(8),
    compression: fileBytes.readUInt32LE(12),
    compressedSize: Number(fileBytes.readBigUInt64LE(16)),
    crcCompressed: fileBytes.readUInt32LE(24),
    uncompressedSize: Number(fileBytes.readBigUInt64LE(28)),
    crcUncompressed: fileBytes.readUInt32LE(36),
  };
  if (header.compression !== 1) throw new Error(`Unsupported compression ${header.compression} (expected 1 = gzip).`);

  const compressed = fileBytes.subarray(HEADER_BYTES);
  const payload = gunzipSync(compressed);

  const checks = {
    compressedSize: compressed.length === header.compressedSize,
    uncompressedSize: payload.length === header.uncompressedSize,
    crcCompressed: crc32(compressed) === header.crcCompressed,
    crcUncompressed: crc32(payload) === header.crcUncompressed,
  };

  // Locate chunks by scanning for their reversed tags.
  const chunks = CHUNKS
    .map((name) => ({ name, offset: payload.indexOf(chunkTag(name)) }))
    .filter((c) => c.offset >= 0)
    .sort((a, b) => a.offset - b.offset);
  chunks.forEach((c, i) => {
    c.size = (i + 1 < chunks.length ? chunks[i + 1].offset : payload.length) - c.offset;
  });

  const modTypes = chunks.find((c) => c.name === 'ModTypes');
  const saveInfo = chunks.find((c) => c.name === 'SaveInfo');

  return {
    header,
    checks,
    chunks,
    mods: modTypes ? readModTypes(payload, modTypes.offset + 8) : [],
    ...(saveInfo ? readSaveInfo(payload, saveInfo.offset + 8, saveInfo.offset + saveInfo.size) : {}),
  };
}

/** `[count][ per mod: [stringId][len][utf8 id][uint64 VersionSlim] ]` */
function readModTypes(payload, pos) {
  const r = new BlobReader(payload, pos);
  const count = r.varint();
  const mods = [];
  for (let i = 0; i < count; i++) {
    r.varint();                       // interned string id
    const id = r.utf8(r.varint());
    mods.push({ id, version: formatVersion(r.u64()) });
  }
  return mods;
}

/**
 * `SaveInfo` holds a `GameSaveInfo` whose exact field layout needs the game's schema.
 * We extract only the three things that are unambiguous without it: the two
 * length-prefixed display strings after the type name, and the JPEG thumbnail —
 * whose byte length is the varint immediately preceding the `FFD8FF` marker.
 */
function readSaveInfo(payload, pos, end) {
  const r = new BlobReader(payload, pos);
  r.varint();                          // object id
  r.varint();                          // type id
  const typeName = r.utf8(r.varint());

  const jpegStart = payload.indexOf(Buffer.from([0xff, 0xd8, 0xff]), r.pos);
  const region = payload.subarray(r.pos, jpegStart < 0 ? end : jpegStart);

  // Length-prefixed ASCII runs: a byte N followed by N printable chars.
  const strings = [];
  for (let i = 0; i < region.length; i++) {
    const len = region[i];
    if (len < 3 || i + 1 + len > region.length) continue;
    const slice = region.subarray(i + 1, i + 1 + len);
    if (slice.every((b) => b >= 0x20 && b < 0x7f)) {
      strings.push(slice.toString('ascii'));
      i += len;
    }
  }

  let thumbnail = null;
  if (jpegStart >= 0) {
    // Back up over the LEB128 length preceding the JPEG. The final byte of a varint
    // has its high bit clear, so walk back while the *previous* byte still has it set.
    let start = jpegStart - 1;
    while (start > r.pos && payload[start - 1] & 0x80) start--;
    let len = 0, shift = 0;
    for (let q = start; q < jpegStart; q++, shift += 7) len += (payload[q] & 0x7f) * 2 ** shift;
    thumbnail = payload.subarray(jpegStart, jpegStart + len);
  }

  const [gameVersion, mapName] = strings;
  return { typeName, gameVersion, mapName, otherStrings: strings.slice(2), thumbnail };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const [path] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!path) {
    console.error('usage: node samples/inspect-save.mjs <file.save> [--thumb out.jpg]');
    process.exit(1);
  }
  const save = parseSave(readFileSync(path));
  const mb = (n) => `${(n / 1e6).toFixed(2)} MB`;

  console.log(`\n  ${path}\n`);
  console.log(`  save version    ${save.header.saveVersion}`);
  console.log(`  game version    ${save.gameVersion ?? '?'}`);
  console.log(`  map             ${save.mapName ?? '?'}`);
  console.log(`  compressed      ${mb(save.header.compressedSize)}`);
  console.log(`  uncompressed    ${mb(save.header.uncompressedSize)}`);
  console.log(`  thumbnail       ${save.thumbnail ? `${(save.thumbnail.length / 1024).toFixed(0)} KB JPEG` : 'none'}`);

  console.log('\n  integrity');
  for (const [k, ok] of Object.entries(save.checks)) console.log(`    ${ok ? 'ok  ' : 'FAIL'}  ${k}`);

  console.log('\n  mods');
  for (const m of save.mods) console.log(`    ${m.id.padEnd(20)} ${m.version}`);

  console.log('\n  chunks');
  for (const c of save.chunks) {
    const pct = ((c.size / save.header.uncompressedSize) * 100).toFixed(1);
    console.log(`    ${c.name.padEnd(9)} @${String(c.offset).padStart(9)}  ${String(c.size).padStart(10)} B  ${pct.padStart(5)}%`);
  }

  const thumbFlag = process.argv.indexOf('--thumb');
  if (thumbFlag >= 0 && save.thumbnail) {
    const out = process.argv[thumbFlag + 1] ?? 'thumbnail.jpg';
    writeFileSync(out, save.thumbnail);
    console.log(`\n  wrote ${out}`);
  }
  console.log();
}
