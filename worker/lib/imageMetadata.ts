export interface RasterDimensions {
  width: number;
  height: number;
}

const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u24le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;

/** Header-only dimensions. No untrusted compressed image is decoded here. */
export function rasterDimensions(bytes: Uint8Array, mime: string): RasterDimensions | null {
  if (mime === 'image/png' && bytes.length >= 24) {
    return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
  }
  if (mime === 'image/gif' && bytes.length >= 10) {
    return { width: u16le(bytes, 6), height: u16le(bytes, 8) };
  }
  if (mime === 'image/webp' && bytes.length >= 30) {
    const tag = String.fromCharCode(...bytes.slice(12, 16));
    if (tag === 'VP8X') return { width: 1 + u24le(bytes, 24), height: 1 + u24le(bytes, 27) };
    if (tag === 'VP8 ' && bytes.length >= 30) return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
    if (tag === 'VP8L' && bytes.length >= 25) {
      const bits = (bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)) >>> 0;
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
  }
  if (mime === 'image/jpeg' && bytes.length >= 4) {
    let i = 2;
    while (i + 8 < bytes.length) {
      if (bytes[i] !== 0xff) { i += 1; continue; }
      const marker = bytes[i + 1];
      if (marker === 0xd8 || marker === 0xd9) { i += 2; continue; }
      const length = u16be(bytes, i + 2);
      if (length < 2 || i + 2 + length > bytes.length) return null;
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { width: u16be(bytes, i + 7), height: u16be(bytes, i + 5) };
      }
      i += 2 + length;
    }
  }
  return null;
}

export function validRasterDimensions(dimensions: RasterDimensions | null): dimensions is RasterDimensions {
  if (!dimensions) return false;
  const { width, height } = dimensions;
  return Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1 && width <= 12_000 && height <= 12_000 && width * height <= 48_000_000;
}

/**
 * An AVIF's canvas size, read from its `ispe` (image spatial extents)
 * properties — header-only, like `rasterDimensions`, and kept apart from it so
 * no existing caller starts measuring AVIF uploads it never measured before.
 *
 * Layout of one property: u32 size, `ispe`, u8 version + u24 flags, u32 width,
 * u32 height. A picture with an alpha plane or a grid carries several; the
 * widest is the canvas. Only the header is scanned (the `meta` box sits before
 * the pixel data), so a truncated or lying file reads as null, never as a
 * megabyte of pixels taken for boxes.
 */
export function avifDimensions(bytes: Uint8Array): RasterDimensions | null {
  const end = Math.min(bytes.length, 16 * 1024) - 16;
  let best: RasterDimensions | null = null;
  for (let i = 4; i <= end; i++) {
    if (bytes[i] !== 0x69 || bytes[i + 1] !== 0x73 || bytes[i + 2] !== 0x70 || bytes[i + 3] !== 0x65) continue; // 'ispe'
    const width = u32be(bytes, i + 8);
    const height = u32be(bytes, i + 12);
    if (width >= 1 && height >= 1 && (!best || width > best.width)) best = { width, height };
  }
  return best;
}


const u32le = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const fourcc = (b: Uint8Array, i: number) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);

/**
 * A PUBLIC WEBP SAYS NOTHING ABOUT WHERE IT WAS TAKEN.
 *
 * A WebP that arrives as WebP is stored byte for byte (the converter never
 * sees it), and an extended WebP (`VP8X`) may carry an `EXIF` chunk — a
 * phone's GPS position, its make and serial, the time — and an `XMP ` chunk.
 * Served at `/files/<key>` (and by `?w=` whenever it falls back to the
 * original) to anyone, that is a customer's home address on a public post.
 *
 * This returns the same picture without those two chunks — the RIFF size and
 * the VP8X flags (EXIF 0x08, XMP 0x04) corrected — and every other chunk
 * untouched, in order: the bitstream, alpha, the colour profile, animation.
 * Anything that is not a well-formed extended WebP (a simple `VP8 `/`VP8L`
 * file cannot carry either chunk) comes back as it was. Pure; no binding.
 */
export function stripWebpMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength < 30 || fourcc(bytes, 0) !== 'RIFF' || fourcc(bytes, 8) !== 'WEBP' || fourcc(bytes, 12) !== 'VP8X') return bytes;
  const end = Math.min(bytes.byteLength, 8 + u32le(bytes, 4));
  const keep: Array<[number, number]> = [];
  let dropped = false;
  for (let at = 12; at < end; ) {
    if (at + 8 > end) return bytes;
    const size = u32le(bytes, at + 4);
    const next = at + 8 + size + (size & 1);
    if (next > end + (size & 1)) return bytes;
    const tag = fourcc(bytes, at);
    if (tag === 'EXIF' || tag === 'XMP ') dropped = true;
    else keep.push([at, Math.min(next, end)]);
    at = next;
  }
  if (!dropped) return bytes;
  const length = keep.reduce((sum, [a, b]) => sum + (b - a), 12);
  const out = new Uint8Array(length);
  out.set(bytes.subarray(0, 12));
  let w = 12;
  for (const [a, b] of keep) {
    out.set(bytes.subarray(a, b), w);
    w += b - a;
  }
  const riff = length - 8;
  out[4] = riff & 255;
  out[5] = (riff >>> 8) & 255;
  out[6] = (riff >>> 16) & 255;
  out[7] = (riff >>> 24) & 255;
  // The VP8X flags byte (first byte of its payload): clear EXIF and XMP.
  out[20] &= ~(0x08 | 0x04);
  return out;
}
