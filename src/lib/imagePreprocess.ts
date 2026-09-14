export type ConvertibleRaster = 'png' | 'jpeg';

export const PRODUCT_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const PRODUCT_IMAGE_MAX_EDGE = 3_000;
export const PRODUCT_IMAGE_MAX_PIXELS = 48_000_000;

/** Detect bytes, never an extension or browser-declared MIME. */
export function detectConvertibleRaster(bytes: Uint8Array): ConvertibleRaster | null {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  return null;
}

function isMp4(bytes: Uint8Array): boolean {
  if (bytes.length < 12 || bytes[4] !== 0x66 || bytes[5] !== 0x74 || bytes[6] !== 0x79 || bytes[7] !== 0x70) return false;
  const brand = String.fromCharCode(...bytes.slice(8, 12));
  return brand !== 'avif' && brand !== 'avis';
}

export function webpFilename(name: string): string {
  const clean = name.split(/[\\/]/).pop()?.trim() || 'image';
  const stem = clean.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}._ -]/gu, '').trim() || 'image';
  return `${stem.slice(0, 120)}.webp`;
}

export interface WebpEncodeResult {
  blob: Blob;
  width: number;
  height: number;
}

export type WebpEncoder = (file: File) => Promise<WebpEncodeResult>;

async function loadImage(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; close?: () => void }> {
  if ('createImageBitmap' in window) {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    await image.decode();
    return { source: image, width: image.naturalWidth, height: image.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Browser codec shared by every admin product-image uploader. */
export async function encodeProductRasterAsWebp(file: File): Promise<WebpEncodeResult> {
  const decoded = await loadImage(file);
  try {
    if (
      decoded.width < 1 ||
      decoded.height < 1 ||
      decoded.width > 12_000 ||
      decoded.height > 12_000 ||
      decoded.width * decoded.height > PRODUCT_IMAGE_MAX_PIXELS
    ) {
      throw new Error('Image dimensions are unsupported');
    }
    const scale = Math.min(1, PRODUCT_IMAGE_MAX_EDGE / Math.max(decoded.width, decoded.height));
    const width = Math.max(1, Math.round(decoded.width * scale));
    const height = Math.max(1, Math.round(decoded.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('Image conversion is unavailable in this browser');
    // An untouched transparent canvas preserves PNG alpha. The browser's
    // decoded source has EXIF orientation applied before this draw.
    ctx.drawImage(decoded.source, 0, 0, width, height);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error('This browser could not encode WebP'))),
        'image/webp',
        0.87
      );
    });
    if (blob.type !== 'image/webp' || blob.size <= 0) throw new Error('WebP conversion produced an invalid file');
    if (blob.size > PRODUCT_IMAGE_MAX_BYTES) throw new Error('Converted WebP is still larger than 8 MB');
    return { blob, width, height };
  } finally {
    decoded.close?.();
  }
}

export interface PreparedProductImage {
  file: File;
  converted: boolean;
  width?: number;
  height?: number;
}

/**
 * PNG/JPEG become WebP before network upload. GIF/AVIF/video are deliberately
 * left alone because converting those blindly can destroy animation or media.
 */
export async function prepareProductImage(file: File, encoder: WebpEncoder = encodeProductRasterAsWebp): Promise<PreparedProductImage> {
  const signature = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  if (file.size > PRODUCT_IMAGE_MAX_BYTES && !isMp4(signature)) {
    throw new Error('Product images must be 8 MB or smaller');
  }
  if (!detectConvertibleRaster(signature)) return { file, converted: false };
  const result = await encoder(file);
  return {
    file: new File([result.blob], webpFilename(file.name), { type: 'image/webp', lastModified: file.lastModified }),
    converted: true,
    width: result.width,
    height: result.height,
  };
}
