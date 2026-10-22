/**
 * WHAT A PHOTO OR A FRAME MAY BE BEFORE IT LEAVES THE WORKER (push B plan
 * §5.2, §5.3, §6.8). Pure byte work, no I/O.
 *
 *   stripJpegMetadata  removes every APP1–APP15 and COM segment (EXIF, GPS,
 *                      XMP, ICC, comments) and keeps the image itself.
 *   checkJpeg          proves what is left is a plain baseline/progressive
 *                      JPEG of bounded size: SOI, a frame header, both sides
 *                      within the limit, the byte cap, and no APP1 at all.
 *
 * A malformed file is never "probably fine": `stripJpegMetadata` answers an
 * empty array, which `checkJpeg` refuses (`BAD_INPUT` upstream).
 */

const SOI = 0xd8;
const SOS = 0xda;
const EOI = 0xd9;
const COM = 0xfe;
const isAppN = (m: number) => m >= 0xe1 && m <= 0xef; // APP1–APP15 (APP0, the JFIF header, is kept)
/** Frame headers: C0–CF except DHT (C4), JPG (C8) and DAC (CC). */
const isSof = (m: number) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
/** Markers with no length field. */
const standalone = (m: number) => m === 0x01 || (m >= 0xd0 && m <= 0xd7);

interface Segment {
  marker: number;
  start: number;
  end: number;
}

/** The marker segments before the scan, or null when the structure does not hold. */
function segments(b: Uint8Array): { list: Segment[]; scanStart: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== SOI) return null;
  const list: Segment[] = [];
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) return null;
    // Fill bytes (FF FF …) before a marker are allowed.
    let j = i;
    while (j < b.length && b[j] === 0xff) j++;
    if (j >= b.length) return null;
    const marker = b[j]!;
    const start = j - 1;
    if (marker === EOI) return null; // an image must have a scan before its end
    if (standalone(marker)) {
      list.push({ marker, start, end: j + 1 });
      i = j + 1;
      continue;
    }
    if (j + 2 >= b.length) return null;
    const len = (b[j + 1]! << 8) | b[j + 2]!;
    if (len < 2) return null;
    const end = j + 1 + len;
    if (end > b.length) return null;
    list.push({ marker, start, end });
    if (marker === SOS) return { list, scanStart: end };
    i = end;
  }
  return null;
}

export function stripJpegMetadata(b: Uint8Array): Uint8Array {
  const s = segments(b);
  if (!s) return new Uint8Array(0);
  const keep = s.list.filter((seg) => !isAppN(seg.marker) && seg.marker !== COM);
  let size = 2 + (b.length - s.scanStart);
  for (const seg of keep) size += seg.end - seg.start;
  const out = new Uint8Array(size);
  out[0] = 0xff;
  out[1] = SOI;
  let at = 2;
  for (const seg of keep) {
    out.set(b.subarray(seg.start, seg.end), at);
    at += seg.end - seg.start;
  }
  out.set(b.subarray(s.scanStart), at);
  return out;
}

export function checkJpeg(b: Uint8Array, maxSide: number, maxBytes: number): { width: number; height: number } | null {
  if (b.length === 0 || b.length > maxBytes) return null;
  const s = segments(b);
  if (!s) return null;
  let dims: { width: number; height: number } | null = null;
  for (const seg of s.list) {
    if (seg.marker === 0xe1) return null; // EXIF/XMP survived: refused outright
    if (isSof(seg.marker) && !dims) {
      // FF Cn, length(2), precision(1), height(2), width(2)
      const p = seg.start + 2 + 2 + 1;
      if (p + 4 > seg.end) return null;
      const height = (b[p]! << 8) | b[p + 1]!;
      const width = (b[p + 2]! << 8) | b[p + 3]!;
      dims = { width, height };
    }
  }
  if (!dims || dims.width <= 0 || dims.height <= 0 || dims.width > maxSide || dims.height > maxSide) return null;
  return dims;
}

/** The provider's image-token estimate for one picture, capped as the plan's worst case says (§10). */
export function imageTokens(width: number, height: number): number {
  return Math.min(4784, Math.ceil(width / 28) * Math.ceil(height / 28));
}

/** Base64 without a library: chunked so a 1.5 MB picture never builds one giant argument list. */
export function bytesToBase64(b: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < b.length; i += CHUNK) bin += String.fromCharCode(...b.subarray(i, i + CHUNK));
  return btoa(bin);
}
