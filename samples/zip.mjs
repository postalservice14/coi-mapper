/**
 * Minimal deflate ZIP writer — no external dependencies.
 *
 * Only what a `.coimap` needs: stored-or-deflated entries, no ZIP64, no encryption.
 * Files above 4 GB are out of scope (a full COI map is a few MB).
 */
import { deflateRawSync } from 'node:zlib';
import { crc32 } from './crc32.mjs';

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const METHOD_DEFLATE = 8;
const VERSION = 20;

/**
 * @param {{name: string, data: Buffer|Uint8Array}[]} entries
 * @returns {Buffer} the complete archive
 */
export function createZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const { name } of entries) {
    if (name.length > 0xffff) throw new Error(`Entry name too long: ${name}`);
  }

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.from(entry.data.buffer ?? entry.data, entry.data.byteOffset ?? 0, entry.data.byteLength ?? entry.data.length);
    const deflated = deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(0, 6);                    // flags
    local.writeUInt16LE(METHOD_DEFLATE, 8);
    local.writeUInt16LE(0, 10);                   // mod time — fixed for reproducible output
    local.writeUInt16LE(0x2821, 12);              // mod date — 2000-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);                   // extra field length

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(CENTRAL_SIG, 0);
    dir.writeUInt16LE(VERSION, 4);
    dir.writeUInt16LE(VERSION, 6);
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(METHOD_DEFLATE, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0x2821, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(deflated.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(nameBytes.length, 28);
    dir.writeUInt16LE(0, 30);                     // extra
    dir.writeUInt16LE(0, 32);                     // comment
    dir.writeUInt16LE(0, 34);                     // disk number start
    dir.writeUInt16LE(0, 36);                     // internal attrs
    dir.writeUInt32LE(0, 38);                     // external attrs
    dir.writeUInt32LE(offset, 42);

    parts.push(local, nameBytes, deflated);
    central.push(dir, nameBytes);
    offset += local.length + nameBytes.length + deflated.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...parts, centralBuf, eocd]);
}
