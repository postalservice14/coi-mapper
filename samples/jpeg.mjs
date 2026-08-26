/**
 * Minimal baseline JPEG encoder — dev tooling, no dependencies.
 *
 * Enough of ITU-T T.81 to produce a valid baseline file: 4:4:4 (no chroma
 * subsampling), standard Annex K quantisation and Huffman tables. Kept dependency-free
 * so `npm run fixture` needs nothing installed.
 */

/** Zig-zag scan order: maps sequential coefficient index to natural 8x8 position. */
const ZIGZAG = [
   0,  1,  8, 16,  9,  2,  3, 10,
  17, 24, 32, 25, 18, 11,  4,  5,
  12, 19, 26, 33, 40, 48, 41, 34,
  27, 20, 13,  6,  7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36,
  29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46,
  53, 60, 61, 54, 47, 55, 62, 63,
];

const LUMA_QUANT = [
  16, 11, 10, 16, 24, 40, 51, 61,
  12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77,
  24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
];

const CHROMA_QUANT = [
  17, 18, 24, 47, 99, 99, 99, 99,
  18, 21, 26, 66, 99, 99, 99, 99,
  24, 26, 56, 99, 99, 99, 99, 99,
  47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
];

// Standard Huffman table specifications (T.81 Annex K).
const DC_LUMA_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_CHROMA_BITS = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const DC_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

const AC_LUMA_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_LUMA_VALUES = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];

const AC_CHROMA_BITS = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
const AC_CHROMA_VALUES = [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
  0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
  0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
  0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
  0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
  0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
  0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
  0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
  0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];

/** Precomputed cos((2x+1)·u·π/16) for the DCT. */
const COS = (() => {
  const t = [];
  for (let x = 0; x < 8; x++) {
    t[x] = [];
    for (let u = 0; u < 8; u++) t[x][u] = Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  }
  return t;
})();
const C = (u) => (u === 0 ? Math.SQRT1_2 : 1);

/** Builds {code, size} lookup arrays from a canonical Huffman specification. */
function buildHuffman(bits, values) {
  const codes = [];
  const sizes = [];
  let code = 0;
  let k = 0;
  for (let length = 1; length <= 16; length++) {
    for (let i = 0; i < bits[length - 1]; i++) {
      codes[values[k]] = code;
      sizes[values[k]] = length;
      code++;
      k++;
    }
    code <<= 1;
  }
  return { codes, sizes };
}

/** Scales a base quantisation table for the requested quality (1-100). */
function scaleQuant(base, quality) {
  const q = Math.max(1, Math.min(100, quality));
  const scale = q < 50 ? 5000 / q : 200 - q * 2;
  return base.map((v) => Math.max(1, Math.min(255, Math.floor((v * scale + 50) / 100))));
}

/** Number of bits needed to represent |v| — the JPEG "category" of a coefficient. */
function category(v) {
  let a = Math.abs(v);
  let n = 0;
  while (a) { a >>= 1; n++; }
  return n;
}

function forwardDct(block, out) {
  for (let v = 0; v < 8; v++) {
    for (let u = 0; u < 8; u++) {
      let sum = 0;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) sum += block[y * 8 + x] * COS[x][u] * COS[y][v];
      }
      out[v * 8 + u] = 0.25 * C(u) * C(v) * sum;
    }
  }
}

/**
 * @param {Uint8ClampedArray|Uint8Array} rgba width*height*4
 * @returns {Buffer} a baseline JPEG
 */
export function encodeJpeg(rgba, width, height, quality = 82) {
  const out = [];
  let bitBuffer = 0;
  let bitCount = 0;

  const byte = (b) => out.push(b & 0xff);
  const word = (w) => { byte(w >> 8); byte(w); };

  const writeBits = (code, size) => {
    for (let i = size - 1; i >= 0; i--) {
      bitBuffer = (bitBuffer << 1) | ((code >> i) & 1);
      if (++bitCount === 8) {
        const b = bitBuffer & 0xff;
        byte(b);
        // 0xFF in entropy-coded data must be followed by a stuffed zero byte.
        if (b === 0xff) byte(0x00);
        bitBuffer = 0;
        bitCount = 0;
      }
    }
  };

  const flushBits = () => {
    while (bitCount > 0) writeBits(1, 1);   // pad with 1s to a byte boundary
  };

  const lumaQuant = scaleQuant(LUMA_QUANT, quality);
  const chromaQuant = scaleQuant(CHROMA_QUANT, quality);
  const dcLuma = buildHuffman(DC_LUMA_BITS, DC_VALUES);
  const acLuma = buildHuffman(AC_LUMA_BITS, AC_LUMA_VALUES);
  const dcChroma = buildHuffman(DC_CHROMA_BITS, DC_VALUES);
  const acChroma = buildHuffman(AC_CHROMA_BITS, AC_CHROMA_VALUES);

  // ── headers ────────────────────────────────────────────────────────────────
  word(0xffd8);                                        // SOI

  word(0xffe0); word(16);                              // APP0 / JFIF
  for (const c of 'JFIF') byte(c.charCodeAt(0));
  byte(0);
  word(0x0101);                                        // version 1.1
  byte(0);                                             // units: none
  word(1); word(1);                                    // pixel aspect 1:1
  byte(0); byte(0);                                    // no thumbnail

  word(0xffdb); word(132);                             // DQT, both tables
  byte(0);
  for (let i = 0; i < 64; i++) byte(lumaQuant[ZIGZAG[i]]);
  byte(1);
  for (let i = 0; i < 64; i++) byte(chromaQuant[ZIGZAG[i]]);

  word(0xffc0); word(17);                              // SOF0, baseline, 3 components
  byte(8);
  word(height); word(width);
  byte(3);
  for (let id = 1; id <= 3; id++) {
    byte(id);
    byte(0x11);                                        // 4:4:4 — no subsampling
    byte(id === 1 ? 0 : 1);                            // quantisation table selector
  }

  const writeHuffmanTable = (classAndId, bits, values) => {
    word(0xffc4);
    word(2 + 1 + 16 + values.length);
    byte(classAndId);
    for (const b of bits) byte(b);
    for (const v of values) byte(v);
  };
  writeHuffmanTable(0x00, DC_LUMA_BITS, DC_VALUES);
  writeHuffmanTable(0x10, AC_LUMA_BITS, AC_LUMA_VALUES);
  writeHuffmanTable(0x01, DC_CHROMA_BITS, DC_VALUES);
  writeHuffmanTable(0x11, AC_CHROMA_BITS, AC_CHROMA_VALUES);

  word(0xffda); word(12);                              // SOS
  byte(3);
  byte(1); byte(0x00);
  byte(2); byte(0x11);
  byte(3); byte(0x11);
  byte(0); byte(63); byte(0);                          // spectral selection, baseline

  // ── entropy-coded scan ─────────────────────────────────────────────────────
  const block = new Float64Array(64);
  const dct = new Float64Array(64);
  const quantised = new Int32Array(64);
  const prevDc = [0, 0, 0];

  const encodeBlock = (componentIndex, quant, dcTable, acTable) => {
    forwardDct(block, dct);
    for (let i = 0; i < 64; i++) quantised[i] = Math.round(dct[i] / quant[i]);

    // DC: difference from the previous block of the same component.
    const diff = quantised[0] - prevDc[componentIndex];
    prevDc[componentIndex] = quantised[0];
    const dcCat = category(diff);
    writeBits(dcTable.codes[dcCat], dcTable.sizes[dcCat]);
    if (dcCat > 0) writeBits(diff < 0 ? diff + (1 << dcCat) - 1 : diff, dcCat);

    // AC: run-length of zeros plus magnitude category.
    let runLength = 0;
    for (let i = 1; i < 64; i++) {
      const value = quantised[ZIGZAG[i]];
      if (value === 0) { runLength++; continue; }
      // Runs longer than 15 need explicit ZRL (16 zeros) symbols first.
      while (runLength > 15) {
        writeBits(acTable.codes[0xf0], acTable.sizes[0xf0]);
        runLength -= 16;
      }
      const cat = category(value);
      const symbol = (runLength << 4) | cat;
      writeBits(acTable.codes[symbol], acTable.sizes[symbol]);
      writeBits(value < 0 ? value + (1 << cat) - 1 : value, cat);
      runLength = 0;
    }
    if (runLength > 0) writeBits(acTable.codes[0x00], acTable.sizes[0x00]);  // EOB
  };

  for (let by = 0; by < height; by += 8) {
    for (let bx = 0; bx < width; bx += 8) {
      for (let component = 0; component < 3; component++) {
        for (let y = 0; y < 8; y++) {
          // Edge blocks clamp to the last row/column rather than reading past the image.
          const sy = Math.min(height - 1, by + y);
          for (let x = 0; x < 8; x++) {
            const sx = Math.min(width - 1, bx + x);
            const o = (sy * width + sx) * 4;
            const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
            let value;
            if (component === 0) value = 0.299 * r + 0.587 * g + 0.114 * b;
            else if (component === 1) value = -0.168736 * r - 0.331264 * g + 0.5 * b + 128;
            else value = 0.5 * r - 0.418688 * g - 0.081312 * b + 128;
            block[y * 8 + x] = value - 128;            // level shift
          }
        }
        if (component === 0) encodeBlock(0, lumaQuant, dcLuma, acLuma);
        else encodeBlock(component, chromaQuant, dcChroma, acChroma);
      }
    }
  }

  flushBits();
  word(0xffd9);                                        // EOI
  return Buffer.from(out);
}
