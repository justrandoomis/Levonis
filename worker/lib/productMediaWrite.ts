import type { Env } from './types';
import type { ProductDoc } from './productModel';
import { HttpError } from './http';
import {
  ProductMediaIngestError,
  verifyStoredProductMedia,
  type VerifiedProductMediaReference,
} from './productMediaIngest';

type MediaWriteEnv = Pick<Env, 'DB' | 'BUCKET' | 'R2_PUBLIC' | 'R2_PRIVATE' | 'IMAGES'>;

/** The relational image shape before `planRelationsWriteFrom` parses it. */
export type MutableProductRelationImage = Record<string, unknown> & {
  url?: unknown;
  key?: unknown;
  r2_key?: unknown;
};

/**
 * Prove every product-media claim against the bytes in public R2, then replace
 * every caller-supplied metadata field with the verifier's authoritative
 * values before a product plan serializes either the document or relation row.
 *
 * Keeping verification and normalization together matters: accepting real
 * bytes but persisting a spoofed width, byte count or key still leaves two
 * descriptions of the same object in the catalogue.
 */
export async function verifyAndNormalizeProductMedia(
  env: MediaWriteEnv,
  doc: ProductDoc,
  relationImages: MutableProductRelationImage[] = []
): Promise<VerifiedProductMediaReference[]> {
  const documentImages = doc.media as Array<
    ProductDoc['media'][number] & { bytes?: number | null; content_type?: string }
  >;
  const references = [...documentImages, ...relationImages];
  if (references.length === 0) return [];

  let verified: VerifiedProductMediaReference[];
  try {
    verified = await verifyStoredProductMedia(env, references);
  } catch (error) {
    if (error instanceof ProductMediaIngestError) {
      const unavailable = error.code === 'IMAGE_STORAGE_FAILED' || error.code === 'IMAGE_CONVERT_UNAVAILABLE';
      throw new HttpError(unavailable ? 503 : 400, error.message, error.code);
    }
    throw error;
  }

  const byUrl = new Map(verified.map((item) => [item.url, item] as const));
  const authoritative = (url: unknown): VerifiedProductMediaReference => {
    const item = typeof url === 'string' ? byUrl.get(url) : undefined;
    if (!item) {
      // Defensive invariant: the verifier either returns a canonical result
      // for every accepted URL or throws. Never continue with half-normalized
      // media if that contract changes.
      throw new HttpError(500, 'Verified product media result is incomplete', 'IMAGE_VERIFICATION_INCOMPLETE');
    }
    return item;
  };

  for (const image of documentImages) {
    const item = authoritative(image.url);
    image.url = item.url;
    image.key = item.key;
    image.content_type = item.content_type;
    image.bytes = item.bytes;
    image.width = item.width;
    image.height = item.height;
  }

  for (const image of relationImages) {
    const item = authoritative(image.url);
    image.url = item.url;
    image.r2_key = item.key;
    if (Object.prototype.hasOwnProperty.call(image, 'key')) image.key = item.key;
    image.content_type = item.content_type;
    image.bytes = item.bytes;
    image.width = item.width;
    image.height = item.height;
  }

  return verified;
}
