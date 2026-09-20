import type { Env } from './types';
import {
  GuardedFetchError,
  guardedFetchBytes,
  type GuardedFetchBudget,
} from './fetchGuard';
import {
  IMAGE_OUTPUT_CAP,
  IMAGE_SOURCE_CAP,
  looksLikeMarkup,
  productImageToWebp,
  sniffImageBytes,
} from './imageConvert';
import {
  buildMediaKey,
  getMediaObject,
  headMediaObject,
  isSafeMediaKey,
  putMediaObjectIfAbsent,
} from './mediaStorage';
import { protectMediaObjectFromCleanup } from './productDeletion';
import { newId } from './crypto';

type ProductMediaEnv = Pick<Env, 'DB' | 'BUCKET' | 'R2_PUBLIC' | 'R2_PRIVATE' | 'IMAGES'>;

export type ProductMediaIngestErrorCode =
  | 'IMAGE_SOURCE_TOO_LARGE'
  | 'IMAGE_NOT_SUPPORTED'
  | 'IMAGE_ANIMATED_GIF'
  | 'IMAGE_CONVERT_UNAVAILABLE'
  | 'IMAGE_CONVERT_FAILED'
  | 'IMAGE_STORAGE_FAILED'
  | 'IMAGE_REFERENCE_INVALID'
  | 'IMAGE_REFERENCE_MISSING';

export class ProductMediaIngestError extends Error {
  readonly code: ProductMediaIngestErrorCode;

  constructor(code: ProductMediaIngestErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ProductMediaIngestError';
    this.code = code;
  }
}

export interface ProductMediaIngestResult {
  source_url: string;
  key: string;
  url: string;
  width: number;
  height: number;
  bytes: number;
  content_type: 'image/webp';
  /** True only if this call created the R2 object. Cleanup must honor it. */
  created_new: boolean;
}

export interface ProductMediaBytesInput {
  bytes: Uint8Array;
  source_url?: string;
  original_name?: string | null;
  owner_id?: string | null;
  /** `import` is the shared, content-addressed namespace used by TXT/URL ingest. */
  entity_id?: string;
  /** How long an unattached staged object must survive before cleanup may run. */
  cleanup_grace_minutes?: number;
}

export interface ProductMediaFetchOptions {
  fetcher?: typeof fetch;
  budget?: GuardedFetchBudget;
  timeout_ms?: number;
  max_redirects?: number;
  cleanup_grace_minutes?: number;
}

export interface StagedProductWebpInput {
  key: string;
  bytes: Uint8Array;
  entity_id: string;
  owner_id?: string | null;
  width: number;
  height: number;
  original_name?: string | null;
  cleanup_grace_minutes?: number;
}

/**
 * The duplicate key spellings used by ProductDoc (`key`) and relation rows
 * (`r2_key`). A write door may pass either shape, but the URL and key must
 * still describe exactly the same object.
 */
export interface ProductMediaReference {
  url?: unknown;
  key?: unknown;
  r2_key?: unknown;
}

export interface VerifiedProductMediaReference {
  key: string;
  url: string;
  width: number;
  height: number;
  bytes: number;
  content_type: 'image/webp';
}

/** A newly-created or newly-claimed object gets one full cleanup interval. */
export const PRODUCT_MEDIA_CLEANUP_GRACE_MINUTES = 15;
/** ProductForm uploads are user-paced; keep them through at least one day. */
export const PRODUCT_MEDIA_FORM_STAGING_GRACE_MINUTES = 24 * 60;
const PRODUCT_MEDIA_MAX_STAGING_GRACE_MINUTES = 7 * 24 * 60;

function productMediaCleanupGrace(value: number | undefined): number {
  const minutes = value ?? PRODUCT_MEDIA_CLEANUP_GRACE_MINUTES;
  if (
    !Number.isInteger(minutes) ||
    minutes < PRODUCT_MEDIA_CLEANUP_GRACE_MINUTES ||
    minutes > PRODUCT_MEDIA_MAX_STAGING_GRACE_MINUTES
  ) {
    throw new ProductMediaIngestError(
      'IMAGE_STORAGE_FAILED',
      'Product media cleanup grace is outside the supported range'
    );
  }
  return minutes;
}

/**
 * Before 0099, pendingMediaCleanup adds a fixed 15-minute age check to
 * created_at. Move that clock forward by the remainder so a 24-hour editor
 * lease remains 24 hours during a rolling deploy too.
 */
const legacyCleanupClockModifier = (minutes: number): string =>
  `+${minutes - PRODUCT_MEDIA_CLEANUP_GRACE_MINUTES} minutes`;

/**
 * Every product-media object which this pipeline may create has a cleanup row
 * BEFORE the conditional R2 put. That ordering is the recovery boundary when
 * R2 succeeds and every later D1 write fails: the scheduled guarded cleanup
 * already knows the key, so it can delete an unattached object or preserve a
 * concurrently attached/shared one after the grace period.
 */
const PRODUCT_MEDIA_STAGING_REASON = 'product_media_staging';

const missingCleanupGraceColumn = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /no such column:\s*(?:media_cleanup_jobs\.)?not_before/i.test(message) ||
    /media_cleanup_jobs has no column named not_before/i.test(message)
  );
};

/**
 * Persist (or renew) one delayed cleanup intent and read it back before the
 * caller is allowed to mutate R2. `INSERT OR IGNORE` deliberately cooperates
 * with the partial unique index on pending keys:
 *
 * - an existing pending delete is renewed rather than duplicated;
 * - terminal history does not block a new pending intent;
 * - concurrent creators converge on the same pending row;
 * - pre-0099 databases use `created_at` as the same grace clock.
 */
async function ensureProductMediaCleanupIntent(
  db: D1Database,
  key: string,
  reason: string,
  graceMinutes = PRODUCT_MEDIA_CLEANUP_GRACE_MINUTES
): Promise<void> {
  const id = newId('mcj');
  const detail = 'pre-write product-media cleanup intent; re-check all references before delete';
  const modifier = `+${graceMinutes} minutes`;
  const legacyModifier = legacyCleanupClockModifier(graceMinutes);

  const verifyPending = async (): Promise<void> => {
    const pending = await db.prepare(
      `SELECT id FROM media_cleanup_jobs
        WHERE object_key = ? AND state = 'pending' LIMIT 1`
    ).bind(key).first<{ id: string }>();
    if (!pending?.id) throw new Error('product-media cleanup intent was not persisted');
  };

  try {
    await db.prepare(
      `INSERT OR IGNORE INTO media_cleanup_jobs
         (id, object_key, visibility, reason, source_product_id, state, attempts, last_error, not_before)
       VALUES (?, ?, 'public', ?, '', 'pending', 0, ?,
               strftime('%Y-%m-%dT%H:%M:%fZ','now', ?))`
    ).bind(id, key, reason, detail, modifier).run();
    // The insert may have lost to an existing pending row. Give that row the
    // full staging grace and retry budget before any conditional R2 write.
    await db.prepare(
      `UPDATE media_cleanup_jobs
          SET not_before = max(not_before, strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)),
              attempts = 0,
              last_error = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE object_key = ? AND state = 'pending'`
    ).bind(modifier, detail, key).run();
    await verifyPending();
    return;
  } catch (error) {
    if (!missingCleanupGraceColumn(error)) {
      throw new ProductMediaIngestError(
        'IMAGE_STORAGE_FAILED',
        'Could not persist product image cleanup intent before storage',
        error
      );
    }
  }

  // Rolling deploy before migration 0099. The old queue has no `not_before`,
  // and pendingMediaCleanup adds a fixed 15-minute age threshold to created_at.
  // The shifted clock preserves the caller's complete contextual grace.
  // Missing table or an arbitrary D1 outage still fails closed.
  try {
    await db.prepare(
      `INSERT OR IGNORE INTO media_cleanup_jobs
         (id, object_key, visibility, reason, source_product_id, state, attempts, last_error)
       VALUES (?, ?, 'public', ?, '', 'pending', 0, ?)`
    ).bind(id, key, reason, detail).run();
    await db.prepare(
      `UPDATE media_cleanup_jobs
          SET created_at = max(created_at, strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)),
              attempts = 0,
              last_error = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE object_key = ? AND state = 'pending'`
    ).bind(legacyModifier, detail, key).run();
    await verifyPending();
  } catch (error) {
    throw new ProductMediaIngestError(
      'IMAGE_STORAGE_FAILED',
      'Could not persist product image cleanup intent before storage',
      error
    );
  }
}

/**
 * Verify caller-supplied product media against R2 before a product save.
 *
 * Structural validation alone only proves that `/files/x.webp` *looks* like
 * one of our addresses. It does not prove the object exists. This check is
 * deliberately separate from ingest: uploads already own their freshly
 * created object, while edit/import/template doors can receive an arbitrary
 * local-looking string from a client.
 */
export async function verifyStoredProductMedia(
  env: Pick<Env, 'DB' | 'BUCKET' | 'R2_PUBLIC' | 'R2_PRIVATE' | 'IMAGES'>,
  references: Iterable<ProductMediaReference>
): Promise<VerifiedProductMediaReference[]> {
  const unique = new Map<string, { key: string; url: string }>();
  let index = 0;
  for (const reference of references) {
    const url = typeof reference.url === 'string' ? reference.url : '';
    const key = url.startsWith('/files/') ? url.slice('/files/'.length) : '';
    const statedKeys = [reference.key, reference.r2_key]
      .filter((value): value is string => typeof value === 'string' && value !== '');
    if (
      !key ||
      !isSafeMediaKey(key) ||
      !key.endsWith('.webp') ||
      url !== `/files/${key}` ||
      statedKeys.some((stated) => stated !== key)
    ) {
      throw new ProductMediaIngestError(
        'IMAGE_REFERENCE_INVALID',
        `Product media reference ${index} must be an exact local WebP URL/key pair`
      );
    }
    unique.set(key, { key, url });
    index += 1;
  }

  const verified: VerifiedProductMediaReference[] = [];
  const verifiedHashes = new Map<string, string>();
  if (unique.size > 0 && !env.IMAGES) {
    throw new ProductMediaIngestError(
      'IMAGE_CONVERT_UNAVAILABLE',
      'Product media cannot be verified because the Cloudflare Images decoder binding is unavailable'
    );
  }
  for (const reference of unique.values()) {
    let object: R2ObjectBody | null;
    try {
      // HEAD and file metadata can both lie about what an object contains.
      // Fetch the body that `/files/<key>` would actually serve.
      object = await getMediaObject(env, 'public', reference.key);
    } catch (error) {
      throw new ProductMediaIngestError(
        'IMAGE_STORAGE_FAILED',
        `Product image could not be read from media storage: ${reference.url}`,
        error
      );
    }
    if (!object || Number(object.size ?? 0) <= 0) {
      throw new ProductMediaIngestError(
        'IMAGE_REFERENCE_MISSING',
        `Product image does not exist in media storage: ${reference.url}`
      );
    }
    if (Number(object.size) > IMAGE_OUTPUT_CAP) {
      throw new ProductMediaIngestError(
        'IMAGE_SOURCE_TOO_LARGE',
        `Stored product image exceeds the ${Math.round(IMAGE_OUTPUT_CAP / 1024 / 1024)} MB limit: ${reference.url}`
      );
    }
    const contentType = object.httpMetadata?.contentType?.toLowerCase() ?? null;
    // Missing metadata is allowed for pre-index objects, but an explicit MIME
    // contradiction would make `/files` serve the right bytes under the wrong
    // type and is therefore not a canonical product image.
    if (contentType && contentType !== 'image/webp') {
      throw new ProductMediaIngestError(
        'IMAGE_REFERENCE_INVALID',
        `Product image metadata is not image/webp: ${reference.url}`
      );
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await object.arrayBuffer());
    } catch (error) {
      throw new ProductMediaIngestError(
        'IMAGE_STORAGE_FAILED',
        `Product image bytes could not be read from media storage: ${reference.url}`,
        error
      );
    }
    if (bytes.byteLength === 0) {
      throw new ProductMediaIngestError(
        'IMAGE_REFERENCE_MISSING',
        `Product image is empty in media storage: ${reference.url}`
      );
    }
    if (bytes.byteLength > IMAGE_OUTPUT_CAP) {
      throw new ProductMediaIngestError(
        'IMAGE_SOURCE_TOO_LARGE',
        `Stored product image exceeds the ${Math.round(IMAGE_OUTPUT_CAP / 1024 / 1024)} MB limit: ${reference.url}`
      );
    }

    // Imported product media is content-addressed. If a key makes that
    // stronger claim, prove it too: replacing the object behind an existing
    // 64-hex name must not silently change what every referencing product
    // displays. Older/random upload keys have no embedded digest and continue
    // through the byte/decode checks below.
    const addressed = /(?:^|\/)([0-9a-f]{64})\.webp$/i.exec(reference.key);
    if (addressed && (await sha256(bytes)) !== addressed[1].toLowerCase()) {
      throw new ProductMediaIngestError(
        'IMAGE_REFERENCE_INVALID',
        `Product image checksum does not match its content-addressed key: ${reference.url}`
      );
    }

    // First judge the bytes, not the key suffix or R2 metadata. Then ask the
    // Images binding to decode the compressed pixels: a fabricated RIFF/WEBP
    // header passes the first test but fails this one.
    const sniffed = sniffImageBytes(bytes);
    if (sniffed?.mime !== 'image/webp') {
      throw new ProductMediaIngestError(
        'IMAGE_REFERENCE_INVALID',
        `Product image bytes are not WebP: ${reference.url}`
      );
    }
    const decoded = await productImageToWebp(env, bytes, 'image/webp');
    if (!decoded.ok) {
      if (decoded.reason === 'unavailable') {
        throw new ProductMediaIngestError(
          'IMAGE_CONVERT_UNAVAILABLE',
          'Product media cannot be verified because the Cloudflare Images decoder binding is unavailable'
        );
      }
      if (decoded.reason === 'too_large') {
        throw new ProductMediaIngestError(
          'IMAGE_SOURCE_TOO_LARGE',
          `Stored product image exceeds the ${Math.round(IMAGE_OUTPUT_CAP / 1024 / 1024)} MB limit: ${reference.url}`
        );
      }
      throw new ProductMediaIngestError(
        'IMAGE_REFERENCE_INVALID',
        `Product image is not a decodable WebP: ${reference.url}`,
        new Error(decoded.detail ?? decoded.reason)
      );
    }

    verified.push({
      ...reference,
      width: decoded.width,
      height: decoded.height,
      bytes: bytes.byteLength,
      // The decoded bytes, not nullable/stale object metadata, are authoritative.
      content_type: 'image/webp',
    });
    verifiedHashes.set(reference.key, await sha256(bytes));
  }

  // Validate the whole set before mutating cleanup state. Then acquire the
  // global guard and re-read the object: cleanup either loses the CAS, or it
  // wins and this request observes its claim/deletion instead of publishing a
  // reference to bytes that no longer exist.
  for (const reference of verified) {
    await protectProductMediaAttachment(env.DB, reference.key);
    let object: R2ObjectBody | null;
    try {
      object = await getMediaObject(env, 'public', reference.key);
    } catch (error) {
      throw new ProductMediaIngestError(
        'IMAGE_STORAGE_FAILED',
        `Product image could not be re-read after cleanup protection: ${reference.url}`,
        error
      );
    }
    if (!object || Number(object.size ?? 0) !== reference.bytes) {
      throw new ProductMediaIngestError(
        'IMAGE_REFERENCE_MISSING',
        `Product image changed while the save was being protected: ${reference.url}`
      );
    }
    const contentType = object.httpMetadata?.contentType?.toLowerCase() ?? null;
    if (contentType && contentType !== 'image/webp') {
      throw new ProductMediaIngestError(
        'IMAGE_REFERENCE_INVALID',
        `Product image metadata changed while the save was being protected: ${reference.url}`
      );
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await object.arrayBuffer());
    } catch (error) {
      throw new ProductMediaIngestError(
        'IMAGE_STORAGE_FAILED',
        `Product image bytes could not be re-read after cleanup protection: ${reference.url}`,
        error
      );
    }
    if (bytes.byteLength !== reference.bytes || await sha256(bytes) !== verifiedHashes.get(reference.key)) {
      throw new ProductMediaIngestError(
        'IMAGE_REFERENCE_INVALID',
        `Product image changed while the save was being protected: ${reference.url}`
      );
    }
  }
  return verified;
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

async function sha256(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource)));
}

/**
 * A deduplicated object can already have an old detach/rollback job waiting.
 * Renew its grace before this ingest advertises the key to a caller; otherwise
 * the cleanup cron could select the old job while the caller is still between
 * staging and committing its new `product_images` row.
 */
async function deferPendingCleanupClaim(
  db: D1Database,
  key: string,
  graceMinutes = PRODUCT_MEDIA_CLEANUP_GRACE_MINUTES
): Promise<void> {
  const legacyModifier = legacyCleanupClockModifier(graceMinutes);
  try {
    await db.prepare(
      `UPDATE media_cleanup_jobs
          SET not_before = max(not_before, strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE object_key = ? AND state = 'pending'`
    ).bind(`+${graceMinutes} minutes`, key).run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/not_before|no such (?:column|table)|has no column named/i.test(message)) {
      throw new ProductMediaIngestError(
        'IMAGE_STORAGE_FAILED',
        'Could not protect the product image from a pending cleanup job',
        error
      );
    }
    try {
      // Migration 0099 not installed yet: pendingMediaCleanup uses created_at
      // as the same grace clock on the old schema.
      await db.prepare(
        `UPDATE media_cleanup_jobs
            SET created_at = max(created_at, strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)),
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE object_key = ? AND state = 'pending'`
      ).bind(legacyModifier, key).run();
    } catch (fallbackError) {
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      // Before migration 0072 there cannot be a queued delete to race.
      if (/no such table|media_cleanup_jobs/i.test(`${message}; ${fallbackMessage}`)) return;
      throw new ProductMediaIngestError(
        'IMAGE_STORAGE_FAILED',
        'Could not protect the product image from a pending cleanup job',
        fallbackError
      );
    }
  }
}

/**
 * Acquire the per-key side of the attach/delete protocol before touching R2.
 * If cleanup won the atomic guard first, this request must not read bytes and
 * later publish a database reference to an object being deleted.
 */
async function protectProductMediaAttachment(
  db: D1Database,
  key: string,
  graceMinutes = PRODUCT_MEDIA_CLEANUP_GRACE_MINUTES
): Promise<void> {
  try {
    const protectedKey = await protectMediaObjectFromCleanup(
      db,
      key,
      graceMinutes
    );
    if (!protectedKey) {
      throw new ProductMediaIngestError(
        'IMAGE_STORAGE_FAILED',
        'Product image is temporarily locked by media cleanup; retry the save'
      );
    }
    // Keep old queued work out of the cron page too. The global guard above is
    // the safety boundary; this deferral is a durable efficiency/back-compat
    // hint for workers that understand the 0099 not_before column.
    await deferPendingCleanupClaim(db, key, graceMinutes);
  } catch (error) {
    if (error instanceof ProductMediaIngestError) throw error;
    throw new ProductMediaIngestError(
      'IMAGE_STORAGE_FAILED',
      'Product image cleanup protection could not be acquired',
      error
    );
  }
}

function conversionFailure(
  outcome: Exclude<Awaited<ReturnType<typeof productImageToWebp>>, { ok: true }>
): ProductMediaIngestError {
  if (outcome.reason === 'unavailable') {
    return new ProductMediaIngestError(
      'IMAGE_CONVERT_UNAVAILABLE',
      'Server-side WebP conversion is not enabled on this deployment (Cloudflare Images binding missing).'
    );
  }
  if (outcome.reason === 'too_large') {
    return new ProductMediaIngestError(
      'IMAGE_SOURCE_TOO_LARGE',
      `Image exceeds the ${Math.round(IMAGE_SOURCE_CAP / 1024 / 1024)} MB source/output limit`
    );
  }
  if (outcome.reason === 'animated_gif') {
    return new ProductMediaIngestError(
      'IMAGE_ANIMATED_GIF',
      'Animated GIF product images are not supported because conversion would discard animation.'
    );
  }
  if (outcome.reason === 'unsupported') {
    return new ProductMediaIngestError('IMAGE_NOT_SUPPORTED', outcome.detail ?? 'The bytes are not a supported image');
  }
  return new ProductMediaIngestError(
    'IMAGE_CONVERT_FAILED',
    outcome.detail ?? 'The image could not be converted to WebP'
  );
}

/**
 * The only product-WebP conditional put primitive.
 *
 * Callers may choose their own canonical product key (the legacy converter
 * retains its product-scoped key), but none may mutate R2 until a delayed,
 * read-back-verified cleanup intent exists in D1. A preexisting object is
 * never made rollback-owned and is never passed back through the writer.
 */
export async function putStagedProductWebp(
  env: ProductMediaEnv,
  input: StagedProductWebpInput
): Promise<{ created_new: boolean }> {
  const graceMinutes = productMediaCleanupGrace(input.cleanup_grace_minutes);
  if (
    !isSafeMediaKey(input.key) ||
    !input.key.endsWith('.webp') ||
    input.bytes.byteLength === 0 ||
    input.bytes.byteLength > IMAGE_OUTPUT_CAP ||
    sniffImageBytes(input.bytes)?.mime !== 'image/webp'
  ) {
    throw new ProductMediaIngestError(
      'IMAGE_STORAGE_FAILED',
      'Only a safe, non-empty WebP product object can be staged'
    );
  }

  await protectProductMediaAttachment(env.DB, input.key, graceMinutes);
  let existing: R2Object | null;
  try {
    existing = await headMediaObject(env, 'public', input.key);
  } catch (error) {
    throw new ProductMediaIngestError(
      'IMAGE_STORAGE_FAILED',
      'Product media storage could not be checked before upload',
      error
    );
  }
  if (existing) return { created_new: false };

  await ensureProductMediaCleanupIntent(env.DB, input.key, PRODUCT_MEDIA_STAGING_REASON, graceMinutes);
  return putMediaObjectIfAbsent(
    env,
    {
      key: input.key,
      visibility: 'public',
      domain: 'products',
      mime: 'image/webp',
      bytes: input.bytes.byteLength,
      ownerId: input.owner_id ?? null,
      entityId: input.entity_id,
      width: input.width,
      height: input.height,
      originalName: input.original_name ?? null,
    },
    input.bytes,
    {
      httpMetadata: {
        contentType: 'image/webp',
        cacheControl: 'public, max-age=31536000, immutable',
      },
      sha256: await crypto.subtle.digest('SHA-256', input.bytes as unknown as BufferSource),
    }
  );
}

/** Validate, convert, hash the FINAL WebP, and create it without overwriting. */
export async function ingestProductMediaBytes(
  env: ProductMediaEnv,
  input: ProductMediaBytesInput
): Promise<ProductMediaIngestResult> {
  if (input.bytes.byteLength === 0 || input.bytes.byteLength > IMAGE_SOURCE_CAP) {
    throw new ProductMediaIngestError(
      'IMAGE_SOURCE_TOO_LARGE',
      `Image exceeds the ${Math.round(IMAGE_SOURCE_CAP / 1024 / 1024)} MB source limit`
    );
  }
  if (looksLikeMarkup(input.bytes)) {
    throw new ProductMediaIngestError('IMAGE_NOT_SUPPORTED', 'HTML/XML content is not an image');
  }
  const sourceKind = sniffImageBytes(input.bytes);
  if (!sourceKind) {
    throw new ProductMediaIngestError(
      'IMAGE_NOT_SUPPORTED',
      'The source bytes are not a supported JPEG, PNG, WebP, GIF or AVIF image'
    );
  }

  const converted = await productImageToWebp(env, input.bytes, sourceKind.mime);
  if (!converted.ok) throw conversionFailure(converted);
  if (converted.bytes.byteLength > IMAGE_OUTPUT_CAP) {
    throw new ProductMediaIngestError(
      'IMAGE_SOURCE_TOO_LARGE',
      `Converted image exceeds the ${Math.round(IMAGE_OUTPUT_CAP / 1024 / 1024)} MB output limit`
    );
  }

  // Dedupe identity is the object which will be served, not the supplier's
  // source encoding. A PNG and JPEG that yield identical WebP share one key.
  const digest = await sha256(converted.bytes);
  const entityId = input.entity_id ?? 'import';
  const key = buildMediaKey({
    visibility: 'public',
    domain: 'products',
    entityId,
    kind: 'gallery',
    objectId: digest,
    extension: 'webp',
  });
  const write = await putStagedProductWebp(env, {
    key,
    bytes: converted.bytes,
    entity_id: entityId,
    owner_id: input.owner_id ?? null,
    width: converted.width,
    height: converted.height,
    original_name: input.original_name ?? null,
    cleanup_grace_minutes: input.cleanup_grace_minutes,
  });

  let authoritative = {
    width: converted.width,
    height: converted.height,
    bytes: converted.bytes.byteLength,
    content_type: 'image/webp' as const,
  };
  if (!write.created_new) {
    // A conditional-put loser and an object found by HEAD are preexisting.
    // Never publish the expected metadata until the stored bytes themselves
    // pass checksum, MIME and decoder validation.
    const [verified] = await verifyStoredProductMedia(env, [{ url: `/files/${key}`, key }]);
    if (!verified) {
      throw new ProductMediaIngestError('IMAGE_REFERENCE_MISSING', 'Deduplicated product image disappeared from storage');
    }
    authoritative = verified;
  }

  return {
    source_url: input.source_url ?? '',
    key,
    url: `/files/${key}`,
    width: authoritative.width,
    height: authoritative.height,
    bytes: authoritative.bytes,
    content_type: authoritative.content_type,
    created_new: write.created_new,
  };
}

/** The complete HTTP(S) -> guarded bytes -> verified WebP -> R2 pipeline. */
export async function ingestProductMediaUrl(
  env: ProductMediaEnv,
  sourceUrl: string,
  options: ProductMediaFetchOptions = {}
): Promise<ProductMediaIngestResult> {
  let fetched;
  try {
    fetched = await guardedFetchBytes(sourceUrl, {
      maxBytes: IMAGE_SOURCE_CAP,
      maxRedirects: options.max_redirects,
      timeoutMs: options.timeout_ms,
      budget: options.budget,
      fetcher: options.fetcher,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LevonisBot/1.0; +https://levonis-iq.com)' },
    });
  } catch (error) {
    if (error instanceof GuardedFetchError && error.code === 'SOURCE_TOO_LARGE') {
      throw new ProductMediaIngestError(
        'IMAGE_SOURCE_TOO_LARGE',
        `Image exceeds the ${Math.round(IMAGE_SOURCE_CAP / 1024 / 1024)} MB source limit`,
        error
      );
    }
    throw error;
  }

  let originalName: string | null = null;
  try {
    const segment = new URL(fetched.url).pathname.split('/').pop();
    originalName = segment ? decodeURIComponent(segment).slice(0, 180) : null;
  } catch {
    // The URL was already validated. A malformed percent escape is merely an
    // unusable display name and never a reason to reject valid image bytes.
  }
  return ingestProductMediaBytes(env, {
    bytes: fetched.bytes,
    source_url: sourceUrl,
    original_name: originalName,
    cleanup_grace_minutes: options.cleanup_grace_minutes,
  });
}

/**
 * Roll back only objects this operation created. Preexisting/deduplicated
 * objects carry `created_new:false` and are unconditionally preserved.
 *
 * This function NEVER deletes from R2 inline. A reference check followed by a
 * bucket delete is not atomic: another apply can attach the content-addressed
 * key in between. Instead, rollback writes a durable, delayed job. The guarded
 * cleanup worker re-scans every current media reference after the grace period
 * and either preserves a now-shared object or deletes a still-orphaned one.
 */
export async function cleanupCreatedProductMedia(
  env: Pick<Env, 'DB' | 'BUCKET' | 'R2_PUBLIC' | 'R2_PRIVATE'>,
  results: Iterable<Pick<ProductMediaIngestResult, 'key' | 'created_new'>>
): Promise<void> {
  const created = new Map<string, { key: string; created_new: true }>();
  for (const result of results) {
    if (result.created_new) created.set(result.key, { key: result.key, created_new: true });
  }
  const unqueued: Array<{ key: string; queue_error: string }> = [];
  const queue = async (key: string): Promise<void> => {
    try {
      // Ingest-created objects already have this row from before their R2 put.
      // Reusing the same primitive makes rollback an idempotent grace renewal;
      // safety never depends on this post-failure write succeeding.
      await ensureProductMediaCleanupIntent(env.DB, key, 'template_apply_rollback');
    } catch (error) {
      unqueued.push({
        key,
        queue_error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  for (const object of created.values()) {
    await queue(object.key);
  }
  if (unqueued.length > 0) {
    throw new AggregateError(
      unqueued.map((failure) => new Error(`${failure.key}: queue=${failure.queue_error}`)),
      'Product media rollback could not queue one or more newly created objects'
    );
  }
}
