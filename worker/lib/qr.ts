/**
 * Minimal, dependency-free QR code encoder (byte mode, EC level M,
 * versions 1–10 → up to 213 UTF-8 bytes). Implements the standard
 * ISO/IEC 18004 pipeline: segment encoding, Reed–Solomon EC over
 * GF(256)/0x11D, block interleaving, function patterns, all 8 masks with
 * penalty-score selection, format info BCH(15,5) and version info
 * BCH(18,6) for v7+.
 *
 * Exists because the profile QR modal must not pull an npm package for a
 * single icon-sized code (project rule: no new dependencies). Pure and
 * synchronous so it is unit-testable under tsx --test.
 */

export interface QrMatrix {
  /** Modules per side (17 + 4·version). Quiet zone NOT included. */
  size: number;
  version: number;
  mask: number;
  /** modules[row][col] === true → dark module. */
  modules: boolean[][];
}

// ---------------------------------------------------------------- tables

/** Byte-mode character capacity at EC level M, versions 1..10. */
const CAPACITY_M = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];

/**
 * EC level M block structure per version 1..10:
 * [ecPerBlock, group1Blocks, group1Data, group2Blocks, group2Data]
 */
const BLOCKS_M: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [10, 1, 16, 0, 0],
  [16, 1, 28, 0, 0],
  [26, 1, 44, 0, 0],
  [18, 2, 32, 0, 0],
  [24, 2, 43, 0, 0],
  [16, 4, 27, 0, 0],
  [18, 4, 31, 0, 0],
  [22, 2, 38, 2, 39],
  [22, 3, 36, 2, 37],
  [26, 4, 43, 1, 44],
];

/** Alignment pattern center coordinates per version 1..10. */
const ALIGNMENT: ReadonlyArray<readonly number[]> = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 52],
];

/** Remainder bits after the final codeword, per version 1..10. */
const REMAINDER_BITS = [0, 7, 7, 7, 7, 7, 0, 0, 0, 0];

// ------------------------------------------------------------- GF(256)

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gmul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** Reed–Solomon generator polynomial, highest-degree coefficient first. */
function rsGenPoly(ecLen: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < ecLen; i++) {
    const factor = new Uint8Array([1, EXP[i]]); // (x + α^i)
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      for (let k = 0; k < factor.length; k++) {
        next[j + k] ^= gmul(poly[j], factor[k]);
      }
    }
    poly = next;
  }
  return poly;
}

/**
 * EC codewords for one data block (polynomial long division remainder).
 * Exported for tests only — the RS property "data‖EC evaluates to zero at
 * every generator root α^0..α^(ecLen-1)" is verified there.
 */
export function rsRemainder(data: Uint8Array, ecLen: number): Uint8Array {
  const gen = rsGenPoly(ecLen);
  const buf = new Uint8Array(data.length + ecLen);
  buf.set(data);
  for (let i = 0; i < data.length; i++) {
    const factor = buf[i];
    if (factor === 0) continue;
    for (let j = 0; j < gen.length; j++) {
      buf[i + j] ^= gmul(gen[j], factor);
    }
  }
  return buf.slice(data.length);
}

// ------------------------------------------------------------ bit utils

class BitBuffer {
  bits: number[] = [];
  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
}

function getBit(x: number, i: number): boolean {
  return ((x >>> i) & 1) !== 0;
}

// ------------------------------------------------------------ encoding

function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function buildCodewords(bytes: Uint8Array, version: number): Uint8Array {
  const b = BLOCKS_M[version - 1];
  const dataCapacity = b[1] * b[2] + b[3] * b[4];
  const bb = new BitBuffer();
  bb.push(0b0100, 4); // byte mode
  bb.push(bytes.length, version >= 10 ? 16 : 8); // char count indicator
  for (const byte of bytes) bb.push(byte, 8);
  // Terminator (up to 4 zero bits), then pad to a byte boundary.
  const capacityBits = dataCapacity * 8;
  const terminator = Math.min(4, capacityBits - bb.bits.length);
  bb.push(0, terminator);
  if (bb.bits.length % 8 !== 0) bb.push(0, 8 - (bb.bits.length % 8));
  // Alternating pad codewords.
  const pads = [0xec, 0x11];
  let p = 0;
  while (bb.bits.length < capacityBits) bb.push(pads[p++ % 2], 8);

  const codewords = new Uint8Array(dataCapacity);
  for (let i = 0; i < dataCapacity; i++) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bb.bits[i * 8 + j];
    codewords[i] = v;
  }
  return codewords;
}

/** Split into blocks, compute EC, interleave data then EC codewords. */
function interleave(codewords: Uint8Array, version: number): Uint8Array {
  const [ecLen, g1n, g1d, g2n, g2d] = BLOCKS_M[version - 1];
  const blocks: Uint8Array[] = [];
  const ecs: Uint8Array[] = [];
  let off = 0;
  for (let i = 0; i < g1n + g2n; i++) {
    const len = i < g1n ? g1d : g2d;
    const block = codewords.slice(off, off + len);
    off += len;
    blocks.push(block);
    ecs.push(rsRemainder(block, ecLen));
  }
  const total = codewords.length + ecLen * (g1n + g2n);
  const out = new Uint8Array(total);
  let k = 0;
  const maxData = Math.max(g1d, g2d);
  for (let i = 0; i < maxData; i++) {
    for (const block of blocks) if (i < block.length) out[k++] = block[i];
  }
  for (let i = 0; i < ecLen; i++) {
    for (const ec of ecs) out[k++] = ec[i];
  }
  return out;
}

// -------------------------------------------------------------- matrix

interface Grid {
  size: number;
  /** true → dark */
  modules: boolean[][];
  /** true → reserved function module (never masked, never data). */
  func: boolean[][];
}

function setFunc(g: Grid, col: number, row: number, dark: boolean): void {
  g.modules[row][col] = dark;
  g.func[row][col] = true;
}

function drawFinder(g: Grid, cx: number, cy: number): void {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= g.size || y >= g.size) continue;
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      setFunc(g, x, y, dist !== 2 && dist !== 4);
    }
  }
}

function drawAlignment(g: Grid, cx: number, cy: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      setFunc(g, cx + dx, cy + dy, dist !== 1);
    }
  }
}

function drawFormatBits(g: Grid, mask: number): void {
  // EC level M = 0b00.
  const data = (0b00 << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;

  // First copy (around the top-left finder).
  for (let i = 0; i <= 5; i++) setFunc(g, 8, i, getBit(bits, i));
  setFunc(g, 8, 7, getBit(bits, 6));
  setFunc(g, 8, 8, getBit(bits, 7));
  setFunc(g, 7, 8, getBit(bits, 8));
  for (let i = 9; i < 15; i++) setFunc(g, 14 - i, 8, getBit(bits, i));
  // Second copy (split between the other two finders).
  for (let i = 0; i < 8; i++) setFunc(g, g.size - 1 - i, 8, getBit(bits, i));
  for (let i = 8; i < 15; i++) setFunc(g, 8, g.size - 15 + i, getBit(bits, i));
  setFunc(g, 8, g.size - 8, true); // dark module
}

function drawVersionBits(g: Grid, version: number): void {
  if (version < 7) return;
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (version << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const bit = getBit(bits, i);
    const a = g.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    setFunc(g, a, b, bit);
    setFunc(g, b, a, bit);
  }
}

function drawFunctionPatterns(g: Grid, version: number): void {
  // Timing patterns.
  for (let i = 0; i < g.size; i++) {
    setFunc(g, 6, i, i % 2 === 0);
    setFunc(g, i, 6, i % 2 === 0);
  }
  // Finders (overwrite timing where they meet) + separators.
  drawFinder(g, 3, 3);
  drawFinder(g, g.size - 4, 3);
  drawFinder(g, 3, g.size - 4);
  // Alignment patterns (skip the three finder corners).
  const pos = ALIGNMENT[version - 1];
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      const isCorner =
        (i === 0 && j === 0) ||
        (i === 0 && j === pos.length - 1) ||
        (i === pos.length - 1 && j === 0);
      if (!isCorner) drawAlignment(g, pos[i], pos[j]);
    }
  }
  // Reserve format/version areas so data placement skips them; real bits
  // are written per-mask afterwards.
  drawFormatBits(g, 0);
  drawVersionBits(g, version);
}

function placeData(g: Grid, codewords: Uint8Array, remainderBits: number): void {
  const totalBits = codewords.length * 8 + remainderBits;
  let bitIndex = 0;
  for (let right = g.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < g.size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? g.size - 1 - vert : vert;
        if (g.func[y][x]) continue;
        let dark = false;
        if (bitIndex < codewords.length * 8) {
          dark = getBit(codewords[bitIndex >>> 3], 7 - (bitIndex & 7));
        }
        // Remainder bits stay light (0).
        if (bitIndex < totalBits) bitIndex++;
        g.modules[y][x] = dark;
      }
    }
  }
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function applyMask(g: Grid, mask: number): void {
  for (let y = 0; y < g.size; y++) {
    for (let x = 0; x < g.size; x++) {
      if (!g.func[y][x] && maskBit(mask, x, y)) {
        g.modules[y][x] = !g.modules[y][x];
      }
    }
  }
}

/** Standard 4-rule penalty score used to pick the best mask. */
function penalty(g: Grid): number {
  const n = g.size;
  let score = 0;

  // Rule 1: runs of ≥5 same-colored modules in rows and columns.
  for (let y = 0; y < n; y++) {
    let runColor = g.modules[y][0];
    let run = 1;
    for (let x = 1; x <= n; x++) {
      const c = x < n ? g.modules[y][x] : !runColor;
      if (c === runColor) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        runColor = c;
        run = 1;
      }
    }
  }
  for (let x = 0; x < n; x++) {
    let runColor = g.modules[0][x];
    let run = 1;
    for (let y = 1; y <= n; y++) {
      const c = y < n ? g.modules[y][x] : !runColor;
      if (c === runColor) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        runColor = c;
        run = 1;
      }
    }
  }

  // Rule 2: 2×2 blocks of one color.
  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) {
      const c = g.modules[y][x];
      if (c === g.modules[y][x + 1] && c === g.modules[y + 1][x] && c === g.modules[y + 1][x + 1]) {
        score += 3;
      }
    }
  }

  // Rule 3: finder-like 1:1:3:1:1 pattern with 4 light modules on a side.
  const P1 = [true, false, true, true, true, false, true, false, false, false, false];
  const P2 = [...P1].reverse();
  const matches = (get: (i: number) => boolean, start: number, pat: boolean[]) => {
    for (let i = 0; i < pat.length; i++) if (get(start + i) !== pat[i]) return false;
    return true;
  };
  for (let y = 0; y < n; y++) {
    const row = (i: number) => g.modules[y][i];
    for (let x = 0; x <= n - 11; x++) {
      if (matches(row, x, P1) || matches(row, x, P2)) score += 40;
    }
  }
  for (let x = 0; x < n; x++) {
    const col = (i: number) => g.modules[i][x];
    for (let y = 0; y <= n - 11; y++) {
      if (matches(col, y, P1) || matches(col, y, P2)) score += 40;
    }
  }

  // Rule 4: dark-module proportion deviation from 50%.
  let dark = 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (g.modules[y][x]) dark++;
  const k = Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5);
  score += k * 10;

  return score;
}

// ---------------------------------------------------------------- API

/** Max UTF-8 bytes this encoder accepts (version 10, EC level M). */
export const QR_MAX_BYTES = CAPACITY_M[CAPACITY_M.length - 1];

/**
 * Encode `text` as a QR symbol (byte mode, EC level M). Throws when the
 * UTF-8 form exceeds QR_MAX_BYTES — callers must handle that honestly
 * rather than truncating the payload.
 */
export function qrEncode(text: string): QrMatrix {
  const bytes = utf8Bytes(text);
  if (bytes.length === 0) throw new Error('QR payload is empty');
  const vIdx = CAPACITY_M.findIndex((cap) => bytes.length <= cap);
  if (vIdx === -1) {
    throw new Error(`QR payload too long: ${bytes.length} bytes (max ${QR_MAX_BYTES})`);
  }
  const version = vIdx + 1;
  const size = 17 + 4 * version;

  const codewords = interleave(buildCodewords(bytes, version), version);

  const base: Grid = {
    size,
    modules: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
    func: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
  };
  drawFunctionPatterns(base, version);
  placeData(base, codewords, REMAINDER_BITS[version - 1]);

  let best: Grid | null = null;
  let bestMask = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const g: Grid = {
      size,
      modules: base.modules.map((r) => [...r]),
      func: base.func, // shared read-only reservation map
    };
    applyMask(g, mask);
    drawFormatBits(g, mask);
    const s = penalty(g);
    if (s < bestScore) {
      bestScore = s;
      best = g;
      bestMask = mask;
    }
  }

  return { size, version, mask: bestMask, modules: best!.modules };
}

/**
 * Render a matrix as a single SVG path string (`d` attribute), one unit per
 * module, offset by the given quiet zone (also in modules).
 */
export function qrToSvgPath(matrix: QrMatrix, quietZone = 4): string {
  const parts: string[] = [];
  for (let y = 0; y < matrix.size; y++) {
    for (let x = 0; x < matrix.size; x++) {
      if (matrix.modules[y][x]) {
        parts.push(`M${x + quietZone} ${y + quietZone}h1v1h-1z`);
      }
    }
  }
  return parts.join('');
}
