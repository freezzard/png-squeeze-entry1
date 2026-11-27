// png-squeeze-01 entry 1: a lossless screenshot squeezer.
// It decodes each 1280x720 RGBA screenshot, picks the tightest lossless form
// (palette when at most 256 colours, grey or grey-plus-alpha when every pixel
// is grey, a transparent key when one transparent value stands alone, RGB or
// RGBA otherwise), chooses each row's PNG filter by the screen the kit ships
// (fixed filters, minimum-sum, fewest-pairs, weighed by zlib), then writes
// the winner with a hand-rolled optimal-parse DEFLATE encoder: a greedy pass
// seeds Huffman costs, a shortest-path parse picks every match and literal,
// and one dynamic block is emitted. A zlib level-9 stream is also built and
// the smaller of the two is kept, so no image ever does worse than zlib.
// Deterministic: fixed work per image, no clock, no environment value steers
// any output byte.
import { inflateSync, deflateSync, constants } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INK = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTK = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const WIDE = 1280;
const TALL = 720;

// ---- PNG framing: CRC-32, chunk assembly, IHDR -----------------------------
const krakenTable = (() => {
  const tab = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tab[n] = c;
  }
  return tab;
})();

function krakenCrc(bytes, from, to) {
  let c = -1;
  for (let i = from; i < to; i++) c = krakenTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngAssemble(chunks) {
  let size = 8;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  let at = 8;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    for (let i = 0; i < 4; i++) out[at + 4 + i] = type.charCodeAt(i);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, krakenCrc(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrBytes(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

// ---- PNG decoding: chunks, inflate, unfilter ------------------------------
function paethGuess(left, above, upLeft) {
  const p = left + above - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - above);
  const pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) return left;
  if (pb <= pc) return above;
  return upLeft;
}

function unfilterRow(type, row, prev, bpp, out) {
  const n = row.length;
  if (type === 0) {
    out.set(row);
    return;
  }
  if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = (row[i] + (i >= bpp ? out[i - bpp] : 0)) & 0xff;
    return;
  }
  if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = (row[i] + (prev === null ? 0 : prev[i])) & 0xff;
    return;
  }
  if (type === 3) {
    for (let i = 0; i < n; i++) {
      const left = i >= bpp ? out[i - bpp] : 0;
      const above = prev === null ? 0 : prev[i];
      out[i] = (row[i] + ((left + above) >> 1)) & 0xff;
    }
    return;
  }
  for (let i = 0; i < n; i++) {
    const left = i >= bpp ? out[i - bpp] : 0;
    const above = prev === null ? 0 : prev[i];
    const upLeft = i >= bpp && prev !== null ? prev[i - bpp] : 0;
    out[i] = (row[i] + paethGuess(left, above, upLeft)) & 0xff;
  }
}

function decodePng(bytes) {
  let at = 8;
  let width = 0;
  let height = 0;
  let colourType = 6;
  let plte = null;
  let trns = null;
  const idatParts = [];
  while (at + 8 <= bytes.length) {
    const len = new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      const v = new DataView(data.buffer, data.byteOffset, 13);
      width = v.getUint32(0);
      height = v.getUint32(4);
      colourType = data[9];
    }
    if (type === 'PLTE') plte = data;
    if (type === 'tRNS') trns = data;
    if (type === 'IDAT') idatParts.push(data);
    if (type === 'IEND') break;
    at += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colourType];
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idatParts.map((p) => Buffer.from(p))));
  const samples = new Uint8Array(height * stride);
  let prev = null;
  for (let y = 0; y < height; y++) {
    const filterType = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = samples.subarray(y * stride, (y + 1) * stride);
    unfilterRow(filterType, row, prev, channels, out);
    prev = out;
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) {
    rgba.set(samples);
    return { rgba, width, height };
  }
  for (let i = 0, s = 0, d = 0; i < n; i++, d += 4) {
    if (colourType === 0) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s];
      rgba[d + 2] = samples[s];
      rgba[d + 3] = 255;
      s += 1;
    }
    if (colourType === 2) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = 255;
      s += 3;
    }
    if (colourType === 3) {
      const idx = samples[s];
      rgba[d] = plte[idx * 3];
      rgba[d + 1] = plte[idx * 3 + 1];
      rgba[d + 2] = plte[idx * 3 + 2];
      rgba[d + 3] = trns !== null && idx < trns.length ? trns[idx] : 255;
      s += 1;
    }
    if (colourType === 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s];
      rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
      s += 2;
    }
  }
  return { rgba, width, height };
}

// ---- PNG filtering: the five filters, minimum-sum cost --------------------
function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
    return;
  }
  if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
    return;
  }
  if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
    return;
  }
  if (type === 3) {
    for (let i = 0; i < n; i++) {
      const left = i >= bpp ? cur[i - bpp] : 0;
      const above = prev === null ? 0 : prev[i];
      out[i] = cur[i] - ((left + above) >> 1);
    }
    return;
  }
  for (let i = 0; i < n; i++) {
    const left = i >= bpp ? cur[i - bpp] : 0;
    const above = prev === null ? 0 : prev[i];
    const upLeft = i >= bpp && prev !== null ? prev[i - bpp] : 0;
    out[i] = cur[i] - paethGuess(left, above, upLeft);
  }
}

function signedSum(row) {
  let sum = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    sum += v < 128 ? v : 256 - v;
  }
  return sum;
}

function pairsCost(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

// ---- Image analysis: opacity, greyness, colour census --------------------
function analyseImage(rgba) {
  const n = rgba.length >>> 2;
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (many === false) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined && counts.size === 256) many = true;
      if (k === undefined && many === false) counts.set(c, 1);
      if (k !== undefined) counts.set(c, k + 1);
    }
  }
  let colours = null;
  if (many === false) {
    colours = [...counts.keys()].map((c) => {
      const b = new Uint8Array(Uint32Array.of(c).buffer);
      return { rgba: [b[0], b[1], b[2], b[3]], word: c, count: counts.get(c) };
    });
  }
  return { opaque, grey, colours };
}

function transparentKeyOf(rgba, grey) {
  let key = -1;
  let valid = true;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a !== 255 && valid) {
      if (a !== 0) valid = false;
      if (a === 0) {
        const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
        if (key === -1) key = v;
        if (key !== v) valid = false;
      }
    }
  }
  if (key === -1) valid = false;
  if (valid) {
    for (let d = 0; d < rgba.length; d += 4) {
      if (rgba[d + 3] === 255) {
        const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
        if (v === key) valid = false;
      }
    }
  }
  if (valid === false) return -1;
  return key;
}

function samplesFor(rgba, colourType) {
  const n = rgba.length >>> 2;
  if (colourType === 6) return rgba;
  const ch = colourType === 0 ? 1 : colourType === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (colourType === 0) out[s] = rgba[d];
    if (colourType === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    }
    if (colourType === 2) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

function paletteFormOf(rgba, colours, order) {
  const lum = (c) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  const entries = [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0];
    plte[i * 3 + 1] = c.rgba[1];
    plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]);
  return { plte, trns, indices };
}

function formsFor(rgba) {
  const { opaque, grey, colours } = analyseImage(rgba);
  const forms = [];
  if (colours !== null) {
    for (const order of ['count', 'luminance']) {
      const p = paletteFormOf(rgba, colours, order);
      const filters = order === 'count' ? [0] : [0, 'minsum'];
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns, filters });
    }
    if (grey === false) return forms;
  }
  const key = opaque ? -1 : transparentKeyOf(rgba, grey);
  let colourType = 6;
  let trns = null;
  if (grey) {
    colourType = opaque || key !== -1 ? 0 : 4;
    if (key !== -1) trns = Uint8Array.of(0, key);
  }
  if (grey === false) {
    colourType = opaque || key !== -1 ? 2 : 6;
    if (key !== -1) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[colourType];
  forms.push({ colourType, bpp, samples: samplesFor(rgba, colourType), plte: null, trns, filters: [0, 1, 2, 4, 'minsum', 'pairs'] });
  return forms;
}

// ---- Filtering a whole image under one choice -----------------------------
function filteredImage(samples, width, height, bpp, choice) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial = Array.from({ length: 5 }, (_, t) => {
    const row = new Uint8Array(stride + 1);
    row[0] = t;
    return row;
  });
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
    }
    if (typeof choice !== 'number') {
      let type = 0;
      let best = Infinity;
      for (let t = 0; t < 5; t++) {
        filterRow(t, cur, prev, bpp, trial[t].subarray(1));
        let cost = 0;
        if (choice === 'minsum') cost = signedSum(trial[t].subarray(1));
        if (choice === 'pairs') cost = pairsCost(trial[t].subarray(1), seen, ++stamp);
        if (cost < best) {
          best = cost;
          type = t;
        }
      }
      raw.set(trial[type], at);
    }
  }
  return raw;
}

// ---- Screening: smallest zlib level-6 stream wins --------------------------
const SCREEN = { level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY };

function chunkOverhead(form) {
  return (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);
}

// ---- Optimal-parse DEFLATE: tables, Huffman, matcher, shortest path ------
// Length and distance code tables from the DEFLATE format (RFC 1951).
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
// Every length where the length symbol or its extra-bit count changes.
const BOUNDARY = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];

function lenSymbol(len) {
  if (len <= 10) return 257 + len - 3;
  let lo = 0;
  let hi = 28;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (LEN_BASE[mid] <= len) lo = mid;
    if (LEN_BASE[mid] > len) hi = mid - 1;
  }
  return 257 + lo;
}

function distSymbol(dist) {
  let lo = 0;
  let hi = 29;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (DIST_BASE[mid] <= dist) lo = mid;
    if (DIST_BASE[mid] > dist) hi = mid - 1;
  }
  return lo;
}

// Package-merge code-length assignment (Moffat and Turpin), capped at maxLen.
function squeezeLengths(freq, maxLen) {
  const n = freq.length;
  const lengths = new Int32Array(n);
  const syms = [];
  for (let i = 0; i < n; i++) if (freq[i] > 0) syms.push(i);
  const m = syms.length;
  if (m === 0) return lengths;
  if (m === 1) {
    lengths[syms[0]] = 1;
    return lengths;
  }
  const sorted = syms.slice().sort((a, b) => freq[a] - freq[b] || a - b)
    .map((s) => ({ f: freq[s], members: [s] }));
  const keep = 2 * m - 2;
  let cur = sorted;
  for (let round = 0; round < maxLen - 1; round++) {
    const packaged = [];
    for (let i = 0; i + 1 < cur.length; i += 2) {
      packaged.push({ f: cur[i].f + cur[i + 1].f, members: cur[i].members.concat(cur[i + 1].members) });
    }
    const merged = [];
    let a = 0;
    let b = 0;
    while (merged.length < keep && (a < packaged.length || b < sorted.length)) {
      const takePackaged = b >= sorted.length || (a < packaged.length && packaged[a].f <= sorted[b].f);
      if (takePackaged) merged.push(packaged[a++]);
      if (takePackaged === false) merged.push(sorted[b++]);
    }
    cur = merged;
  }
  for (const item of cur) for (const s of item.members) lengths[s]++;
  return lengths;
}

function canonicalSqueezeCodes(lengths) {
  const n = lengths.length;
  let maxLen = 0;
  for (let i = 0; i < n; i++) if (lengths[i] > maxLen) maxLen = lengths[i];
  const blCount = new Int32Array(maxLen + 1);
  for (let i = 0; i < n; i++) if (lengths[i] > 0) blCount[lengths[i]]++;
  const codes = new Int32Array(n);
  let code = 0;
  const nextCode = new Int32Array(maxLen + 1);
  for (let b = 1; b <= maxLen; b++) {
    code = (code + blCount[b - 1]) << 1;
    nextCode[b] = code;
  }
  for (let i = 0; i < n; i++) if (lengths[i] > 0) codes[i] = nextCode[lengths[i]]++;
  return { codes, maxLen };
}

function revBits(code, len) {
  let r = 0;
  for (let b = 0; b < len; b++) r = (r << 1) | ((code >> b) & 1);
  return r;
}

class SqueezeBitSink {
  constructor() {
    this.bytes = [];
    this.acc = 0;
    this.nbits = 0;
  }
  write(code, len) {
    this.acc |= code << this.nbits;
    this.nbits += len;
    while (this.nbits >= 8) {
      this.bytes.push(this.acc & 0xff);
      this.acc >>>= 8;
      this.nbits -= 8;
    }
  }
  flush() {
    if (this.nbits > 0) {
      this.bytes.push(this.acc & 0xff);
      this.acc = 0;
      this.nbits = 0;
    }
  }
  result() {
    return Uint8Array.from(this.bytes);
  }
}

function squeezeAdler(bytes) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) {
      a += bytes[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const HASH_BITS = 16;
const HASH_SIZE = 1 << HASH_BITS;
const HASH_MASK = HASH_SIZE - 1;

function hash3(d, i) {
  const x = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
  return ((x * 2654435761) >>> (32 - HASH_BITS)) & HASH_MASK;
}

class SqueezeMatcher {
  constructor(data) {
    this.d = data;
    this.n = data.length;
    this.head = new Int32Array(HASH_SIZE).fill(-1);
    this.prev = new Int32Array(this.n).fill(-1);
  }
  insert(pos) {
    if (pos + 2 >= this.n) return;
    const h = hash3(this.d, pos);
    this.prev[pos] = this.head[h];
    this.head[h] = pos;
  }
  // Longest match at pos, walking at most maxChain hash-chain links.
  longestFlat(pos, maxChain) {
    const d = this.d;
    const n = this.n;
    if (pos + 3 > n) return { len: 0, dist: 0 };
    const h = hash3(d, pos);
    let cand = this.head[h];
    let bestLen = 2;
    let bestDist = 0;
    const maxLen = Math.min(258, n - pos);
    const limit = Math.max(0, pos - 32768);
    let chain = maxChain;
    while (cand >= limit && chain-- > 0) {
      if (d[cand + bestLen] === d[pos + bestLen]) {
        let len = 0;
        while (len < maxLen && d[cand + len] === d[pos + len]) len++;
        if (len > bestLen) {
          bestLen = len;
          bestDist = pos - cand;
          if (len >= maxLen) break;
        }
      }
      cand = this.prev[cand];
    }
    return { len: bestLen > 2 ? bestLen : 0, dist: bestDist };
  }
}

function costsFromSqueezeLengths(lengths) {
  const c = new Float64Array(lengths.length);
  for (let i = 0; i < lengths.length; i++) c[i] = lengths[i] > 0 ? lengths[i] : 15;
  return c;
}

// Greedy first pass: seeds the Huffman statistics for the optimal parse.
// Short chain, single walk per position; statistics only, never emitted.
function greedySqueezeStats(data, present) {
  const n = data.length;
  const m = new SqueezeMatcher(data);
  const litFreq = new Int32Array(288);
  for (let b = 0; b < 256; b++) litFreq[b] = present[b];
  for (let s = 256; s < 286; s++) litFreq[s] = 1;
  const distFreq = new Int32Array(30).fill(1);
  let pos = 0;
  while (pos < n) {
    const cur = m.longestFlat(pos, 128);
    const take = cur.len >= 3;
    if (take === false) {
      litFreq[data[pos]]++;
      m.insert(pos);
      pos++;
    }
    if (take) {
      litFreq[lenSymbol(cur.len)]++;
      distFreq[distSymbol(cur.dist)]++;
      const end = pos + cur.len;
      for (let p = pos; p < end; p++) m.insert(p);
      pos = end;
    }
  }
  litFreq[256]++;
  return { litFreq, distFreq };
}

// Shortest-path parse: at each position the cheapest way to reach every
// later position, using the (length, distance) knees of the hash chain.
function optimalSqueezeParse(data, litCost, lenCostBySym, distCost) {
  const n = data.length;
  const m = new SqueezeMatcher(data);
  const lenPart = new Float64Array(259);
  for (let L = 3; L <= 258; L++) {
    const sym = lenSymbol(L);
    lenPart[L] = lenCostBySym[sym] + LEN_EXTRA[sym - 257];
  }
  const distPart = new Float64Array(30);
  for (let s = 0; s < 30; s++) distPart[s] = distCost[s] + DIST_EXTRA[s];
  const distSymFor = new Int32Array(32769);
  for (let d = 1; d <= 32768; d++) distSymFor[d] = distSymbol(d);
  const dp = new Float64Array(n + 1).fill(Infinity);
  dp[0] = 0;
  const prevLen = new Int16Array(n + 1);
  const prevDist = new Int32Array(n + 1);
  const distForLen = new Float64Array(259);
  const kneeLen = new Int32Array(64);
  const kneeDist = new Int32Array(64);
  const chainCap = data.length <= 1500000 ? 512 : 192;
  for (let i = 0; i < n; i++) {
    const base = dp[i];
    if (base !== Infinity) {
      const lc = base + litCost[data[i]];
      if (lc < dp[i + 1]) {
        dp[i + 1] = lc;
        prevLen[i + 1] = 0;
      }
      let nk = 0;
      if (i + 3 <= n) {
        const d = data;
        const h = hash3(d, i);
        let cand = m.head[h];
        let bestLen = 2;
        const maxLen = Math.min(258, n - i);
        const limit = Math.max(0, i - 32768);
        let chain = chainCap;
        while (cand >= limit && chain-- > 0) {
          if (d[cand + bestLen] === d[i + bestLen]) {
            let len = 0;
            while (len < maxLen && d[cand + len] === d[i + len]) len++;
            if (len > bestLen) {
              bestLen = len;
              if (nk < 64) {
                kneeLen[nk] = len;
                kneeDist[nk] = i - cand;
                nk++;
              }
              if (len >= maxLen) break;
            }
          }
          cand = m.prev[cand];
        }
      }
      if (nk > 0) {
        const lenMax = kneeLen[nk - 1];
        let bestD = Infinity;
        let ki = nk - 1;
        for (let bi = BOUNDARY.length - 1; bi >= 0; bi--) {
          const L = BOUNDARY[bi];
          while (ki >= 0 && kneeLen[ki] >= L) {
            if (kneeDist[ki] < bestD) bestD = kneeDist[ki];
            ki--;
          }
          distForLen[L] = bestD;
        }
        for (let bi = 0; bi < BOUNDARY.length; bi++) {
          const L = BOUNDARY[bi];
          if (L > lenMax) break;
          const dist = distForLen[L];
          if (dist !== Infinity) {
            const cost = base + lenPart[L] + distPart[distSymFor[dist]];
            if (cost < dp[i + L]) {
              dp[i + L] = cost;
              prevLen[i + L] = L;
              prevDist[i + L] = dist;
            }
          }
        }
        if (BOUNDARY.indexOf(lenMax) === -1) {
          const L = lenMax;
          const dist = kneeDist[nk - 1];
          const cost = base + lenPart[L] + distPart[distSymFor[dist]];
          if (cost < dp[i + L]) {
            dp[i + L] = cost;
            prevLen[i + L] = L;
            prevDist[i + L] = dist;
          }
        }
      }
    }
    m.insert(i);
  }
  const litTok = [];
  const lenTok = [];
  const distTok = [];
  const litFreq = new Int32Array(288);
  const distFreq = new Int32Array(30).fill(1);
  let j = n;
  const rev = [];
  while (j > 0) {
    const L = prevLen[j];
    if (L === 0) {
      rev.push([data[j - 1], 0, 0]);
      j -= 1;
    }
    if (L !== 0) {
      rev.push([-1, L, prevDist[j]]);
      j -= L;
    }
  }
  rev.reverse();
  for (const [lit, len, dist] of rev) {
    litTok.push(lit);
    lenTok.push(len);
    distTok.push(dist);
    if (len === 0) litFreq[lit]++;
    if (len !== 0) {
      litFreq[lenSymbol(len)]++;
      distFreq[distSymbol(dist)]++;
    }
  }
  litTok.push(256);
  lenTok.push(0);
  distTok.push(0);
  litFreq[256]++;
  return { litTok, lenTok, distTok, litFreq, distFreq };
}

// Emits one dynamic-Huffman DEFLATE block (final) wrapped as a zlib stream.
function emitSqueezeBlock(data, toks, litLen, distLen) {
  let hlit = 286;
  while (hlit > 257 && litLen[hlit - 1] === 0) hlit--;
  let hdist = 30;
  while (hdist > 1 && distLen[hdist - 1] === 0) hdist--;
  const seq = [];
  for (let i = 0; i < hlit; i++) seq.push(litLen[i]);
  for (let i = 0; i < hdist; i++) seq.push(distLen[i]);
  const clFreq = new Int32Array(19);
  const clItems = [];
  {
    let i = 0;
    while (i < seq.length) {
      const v = seq[i];
      let run = 1;
      while (i + run < seq.length && seq[i + run] === v) run++;
      if (v === 0) {
        let r = run;
        while (r >= 11) {
          const take = Math.min(r, 138);
          clItems.push([18, take - 11, 7]);
          clFreq[18]++;
          r -= take;
        }
        if (r >= 3) {
          clItems.push([17, r - 3, 3]);
          clFreq[17]++;
          r = 0;
        }
        while (r > 0) {
          clItems.push([0, 0, 0]);
          clFreq[0]++;
          r--;
        }
      }
      if (v !== 0) {
        clItems.push([v, 0, 0]);
        clFreq[v]++;
        let r = run - 1;
        while (r >= 3) {
          const take = Math.min(r, 6);
          clItems.push([16, take - 3, 2]);
          clFreq[16]++;
          r -= take;
        }
        while (r > 0) {
          clItems.push([v, 0, 0]);
          clFreq[v]++;
          r--;
        }
      }
      i += run;
    }
  }
  const clLen = squeezeLengths(clFreq, 7);
  let hclen = 19;
  while (hclen > 4 && clLen[CL_ORDER[hclen - 1]] === 0) hclen--;
  const litCodes = canonicalSqueezeCodes(litLen);
  const distCodes = canonicalSqueezeCodes(distLen);
  const clCodes = canonicalSqueezeCodes(clLen);
  const w = new SqueezeBitSink();
  w.write(1, 1);
  w.write(2, 2);
  w.write(hlit - 257, 5);
  w.write(hdist - 1, 5);
  w.write(hclen - 4, 4);
  for (let k = 0; k < hclen; k++) w.write(clLen[CL_ORDER[k]], 3);
  for (const [sym, extra, bits] of clItems) {
    w.write(revBits(clCodes.codes[sym], clLen[sym]), clLen[sym]);
    if (bits > 0) w.write(extra, bits);
  }
  const { litTok, lenTok, distTok } = toks;
  for (let t = 0; t < litTok.length; t++) {
    if (lenTok[t] === 0) {
      const s = litTok[t];
      w.write(revBits(litCodes.codes[s], litLen[s]), litLen[s]);
    }
    if (lenTok[t] !== 0) {
      const len = lenTok[t];
      const sym = lenSymbol(len);
      w.write(revBits(litCodes.codes[sym], litLen[sym]), litLen[sym]);
      const eb = LEN_EXTRA[sym - 257];
      if (eb > 0) w.write(len - LEN_BASE[sym - 257], eb);
      const dsym = distSymbol(distTok[t]);
      w.write(revBits(distCodes.codes[dsym], distLen[dsym]), distLen[dsym]);
      const ed = DIST_EXTRA[dsym];
      if (ed > 0) w.write(distTok[t] - DIST_BASE[dsym], ed);
    }
  }
  w.flush();
  const body = w.result();
  const out = new Uint8Array(2 + body.length + 4);
  out[0] = 0x78;
  out[1] = 0xda;
  out.set(body, 2);
  const ad = squeezeAdler(data);
  out[out.length - 4] = (ad >>> 24) & 0xff;
  out[out.length - 3] = (ad >>> 16) & 0xff;
  out[out.length - 2] = (ad >>> 8) & 0xff;
  out[out.length - 1] = ad & 0xff;
  return out;
}

// Full optimal-parse DEFLATE of one filtered image. Returns a zlib stream.
function squeezeDeflate(data) {
  const present = new Uint8Array(256);
  for (let i = 0; i < data.length; i++) present[data[i]] = 1;
  const stats = greedySqueezeStats(data, present);
  const litLen1 = squeezeLengths(stats.litFreq, 15);
  const distLen1 = squeezeLengths(stats.distFreq, 15);
  const litCost = costsFromSqueezeLengths(litLen1);
  const lenCostBySym = new Float64Array(288);
  for (let s = 257; s < 286; s++) lenCostBySym[s] = litLen1[s] > 0 ? litLen1[s] : 15;
  const distCost = costsFromSqueezeLengths(distLen1);
  const toks = optimalSqueezeParse(data, litCost, lenCostBySym, distCost);
  const litLen = squeezeLengths(toks.litFreq, 15);
  const distLen = squeezeLengths(toks.distFreq, 15);
  return emitSqueezeBlock(data, toks, litLen, distLen);
}

// ---- Squeeze: screen forms, optimal-parse the winner, keep the smaller -----
function squeezePng(rgba, width, height) {
  let winner = null;
  for (const form of formsFor(rgba)) {
    const overhead = chunkOverhead(form);
    for (const choice of form.filters) {
      const data = filteredImage(form.samples, width, height, form.bpp, choice);
      const zlib = deflateSync(data, SCREEN);
      const bytes = zlib.length + overhead;
      if (winner === null || bytes < winner.bytes) {
        winner = { form, choice, data, bytes };
      }
    }
  }
  const optimal = squeezeDeflate(winner.data);
  const plain = deflateSync(winner.data, { level: 9, memLevel: 9, strategy: constants.Z_DEFAULT_STRATEGY });
  const sifted = deflateSync(winner.data, { level: 9, memLevel: 9, strategy: constants.Z_FILTERED });
  let idat = optimal;
  if (plain.length < idat.length) idat = plain;
  if (sifted.length < idat.length) idat = sifted;
  const chunks = [['IHDR', ihdrBytes(width, height, winner.form.colourType)]];
  if (winner.form.plte !== null) chunks.push(['PLTE', winner.form.plte]);
  if (winner.form.trns !== null) chunks.push(['tRNS', winner.form.trns]);
  chunks.push(['IDAT', new Uint8Array(idat)]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngAssemble(chunks);
}

// ---- Driver: one run answers every instance of the set --------------------
for (const id of readdirSync(INK).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(INK, id, 'image.png'))));
  mkdirSync(join(OUTK, id), { recursive: true });
  writeFileSync(join(OUTK, id, 'image.png'), squeezePng(image.rgba, image.width, image.height));
}
