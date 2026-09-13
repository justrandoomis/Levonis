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

