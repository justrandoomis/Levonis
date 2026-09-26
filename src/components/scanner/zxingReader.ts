/**
 * THE 1-D BARCODE READER FOR BROWSERS WITHOUT `BarcodeDetector` — iOS Safari
 * above all, which has never shipped it.
 *
 * `@zxing/library` (Apache-2.0, pure JavaScript, no WebAssembly) — chosen over
 * a WASM reader because WASM needs `'wasm-unsafe-eval'` in the site-wide
 * script-src (worker/lib/securityPolicy.ts), and a scanner is not worth
 * loosening the policy every page runs under. Only the 1-D readers are
 * imported, by deep path, so this chunk carries Code 128 / Code 39 / EAN /
 * UPC and nothing else (QR codes are still read by jsQR, already a
 * dependency). It is imported ONLY from `decodeEngine.ts` through a dynamic
 * `import()`, so it is its own lazy chunk that a visitor downloads only by
 * opening a scanner (tests/bundleBudget.test.ts keeps it out of the entry).
 *
 * Pure: pixels in, text out. That is also what lets tests/serialScanner.test.ts
 * run a generated Code 128 label through it in Node.
 */
import MultiFormatOneDReader from '@zxing/library/esm/core/oned/MultiFormatOneDReader';
import BinaryBitmap from '@zxing/library/esm/core/BinaryBitmap';
import HybridBinarizer from '@zxing/library/esm/core/common/HybridBinarizer';
import RGBLuminanceSource from '@zxing/library/esm/core/RGBLuminanceSource';
import DecodeHintType from '@zxing/library/esm/core/DecodeHintType';
import BarcodeFormat from '@zxing/library/esm/core/BarcodeFormat';

const hints = new Map<DecodeHintType, unknown>([
  [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128, BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.CODE_39]],
  [DecodeHintType.TRY_HARDER, true],
]);
const reader = new MultiFormatOneDReader(hints);

export interface OneDHit {
  text: string;
  /** BarcodeDetector-style name: `code_128`, `ean_13`, … */
  format: string;
  /** The row the code was read on, in the luminance image's pixels. */
  y: number;
}

/**
 * Reads ONE 1-D barcode from a grayscale image (one byte per pixel), or
 * returns null. A label carries three; the caller reads regions of the frame
 * in turn and lets `classifyLabel` sort out which is which.
 */
export function decodeLuminance(luma: Uint8ClampedArray, width: number, height: number): OneDHit | null {
  if (width < 8 || height < 8 || luma.length < width * height) return null;
  try {
    const source = new RGBLuminanceSource(luma, width, height);
    const result = reader.decode(new BinaryBitmap(new HybridBinarizer(source)), hints);
    const text = result.getText();
    if (!text) return null;
    const points = result.getResultPoints() ?? [];
    const y = points.length ? points.reduce((s, p) => s + p.getY(), 0) / points.length : height / 2;
    return { text, format: String(BarcodeFormat[result.getBarcodeFormat()] ?? '').toLowerCase(), y };
  } catch {
    // NotFound / Checksum / Format exceptions: nothing readable in this image.
    return null;
  } finally {
    reader.reset();
  }
}

/** RGBA pixels (canvas ImageData) → one luminance byte per pixel. */
export function rgbaToLuminance(rgba: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height);
  for (let i = 0, j = 0; j < out.length; i += 4, j++) {
    // Rec. 601 weights in integer arithmetic.
    out[j] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
  }
  return out;
}
