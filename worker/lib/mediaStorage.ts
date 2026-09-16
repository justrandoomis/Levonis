import type { Env } from './types';

export type MediaVisibility = 'public' | 'private';
export type MediaDomain =
  | 'products'
  | 'community'
  | 'merchants'
  | 'users'
  | 'chat'
  | 'support'
  | 'reviews'
  | 'reviews-evidence'
  | 'orders'
  | 'warranty'
  | 'claims'
  | 'receipts'
  | 'imports'
  | 'ui'
  | 'brands'
  | 'services'
  | 'kyc'
  | 'requests'
  | 'print-requests';

export interface MediaKeyInput {
  visibility: MediaVisibility;
  domain: MediaDomain;
  entityId: string;
  kind: string;
  extension: string;
  objectId: string;
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
/**
 * WHAT MAY BE STORED, BY EXTENSION.
 *
 * The 3D formats beyond STL and 3MF were missing, and the gap was inert only
 * because no print-request path calls `buildMediaKey` — marketplace.ts and
 * printRequests.ts hand-build their keys, so `putMediaObject` (which validates
 * only `isSafeMediaKey`) accepted a .step quietly. `worker/lib/attachments.ts`
 * has always ACCEPTED these formats by magic bytes; the moment anything routes
 * a model through the canonical key builder, an allowlist that stops at 3MF
 * turns a working upload into `Invalid media extension`.
 *
 * `lvm` is the derived preview mesh the 3D viewer serves, and it is on the same
 * footing: a real object with a real key that the taxonomy has to admit exists.
 */
const EXTENSION = /^(?:3mf|amf|avif|csv|gif|glb|gltf|jpg|jpeg|json|lvm|mp4|obj|pdf|png|step|stl|stp|webp)$/i;

function safeSegment(value: string, field: string): string {
  const v = value.trim();
  if (!SEGMENT.test(v)) throw new Error(`Invalid media ${field}`);
  return v;
}

/**
 * The only constructor for new media keys. Visibility selects a bucket and is
 * intentionally not encoded into the path; the key itself remains a stable DB
 * reference if a bucket name changes between staging and production.
 */
export function buildMediaKey(input: MediaKeyInput): string {
  const domain = safeSegment(input.domain, 'domain');
  const entity = safeSegment(input.entityId, 'entity id');
  const kind = safeSegment(input.kind, 'kind');
  const object = safeSegment(input.objectId, 'object id');
  const extension = input.extension.trim().toLowerCase().replace(/^\./, '');
  if (!EXTENSION.test(extension)) throw new Error('Invalid media extension');
  return `${domain}/${entity}/${kind}/${object}.${extension}`;
}

/** Strict validation for stored/requested keys; percent escapes are refused. */
export function isSafeMediaKey(key: unknown): key is string {
  if (typeof key !== 'string' || key.length < 5 || key.length > 500) return false;
  if (key.startsWith('/') || key.endsWith('/') || key.includes('\\') || key.includes('%')) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(key)) return false;
  return key.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

export type MediaBindingName = 'R2_PUBLIC' | 'R2_PRIVATE' | 'BUCKET';

type MediaEnv = Pick<Env, 'BUCKET' | 'R2_PUBLIC' | 'R2_PRIVATE'>;

/** Which binding a visibility actually resolves to. Logs say this, not "public". */
export function mediaBindingName(env: MediaEnv, visibility: MediaVisibility): MediaBindingName {
  if (visibility === 'public') return env.R2_PUBLIC ? 'R2_PUBLIC' : 'BUCKET';
  return env.R2_PRIVATE ? 'R2_PRIVATE' : 'BUCKET';
}

/**
 * The dedicated bucket for a visibility; the legacy one only when the binding
 * is genuinely ABSENT (local dev, unit tests, a Worker deployed before the
 * media bindings existed).
 *
 * `??` answers ONE question — "is there a binding?" — and it is not the
 * question that bites. A binding that names a bucket which does not exist on
 * the account is a perfectly ordinary `R2Bucket` object here: not null, not
 * undefined, so `??` never fires and the legacy bucket is never consulted.
 * The failure surfaces at the first `get`/`put`, per request, at runtime.
 * `readThroughLegacy` below is what handles that case; this function cannot.
 */
export function mediaBucket(env: MediaEnv, visibility: MediaVisibility): R2Bucket {
  return visibility === 'public' ? env.R2_PUBLIC ?? env.BUCKET : env.R2_PRIVATE ?? env.BUCKET;
}

/** One structured line per legacy read. See `reportMediaFallback`. */
export interface MediaFallbackEvent {
  /**
   * `legacy_hit` — the dedicated bucket did not have it and the legacy bucket
   * did. This is migration residue: while these lines appear, the move is NOT
   * finished, and when they stop appearing it is.
   *
   * `primary_unavailable` — the dedicated binding itself threw. The usual
   * cause is a binding that names a bucket nobody created.
   */
  reason: 'legacy_hit' | 'primary_unavailable';
  operation: 'get' | 'head' | 'put' | 'delete';
  visibility: MediaVisibility;
  binding: MediaBindingName;
  key: string;
  error?: string;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 300);
  return String(error).slice(0, 300);
}

/**
 * The migration's own progress meter, and it is deliberately a LOG rather than
 * a counter: the owner needs to know when the legacy bucket has stopped being
 * read, and a log line that stops appearing says that without anything having
 * to be polled. Two distinct markers so they can be alerted on separately.
 */
function reportMediaFallback(event: MediaFallbackEvent): void {
  if (event.reason === 'primary_unavailable') {
    console.error('media_primary_bucket_unavailable', JSON.stringify(event));
    return;
  }
  console.warn('media_legacy_fallback', JSON.stringify(event));
}

/**
 * Dedicated bucket first, legacy bucket second — for reads only.
 *
 * Both ways the primary can fail to produce the object are handled, and they
 * are NOT the same thing:
 *
 *   - the primary answered and does not have it  -> the object has not been
 *     copied yet; read legacy, and log that the legacy copy was needed;
 *   - the primary THREW                          -> the binding is unusable
 *     (typically bound to a bucket that does not exist); log it as an error
 *     and still serve the customer from legacy.
 *
 * Before this, the second case propagated out of `getMediaObject` and every
 * image on the page became a 500 — with a perfectly good legacy copy sitting
 * one line further down, unreachable.
 */
async function readThroughLegacy<T>(
  env: MediaEnv,
  visibility: MediaVisibility,
  key: string,
  operation: 'get' | 'head',
  run: (bucket: R2Bucket) => Promise<T | null>
): Promise<T | null> {
  const primary = mediaBucket(env, visibility);
  const binding = mediaBindingName(env, visibility);
  // No dedicated binding at all: there is nothing to fall back FROM, and a
  // failure here is a real failure that must not be swallowed.
  if (primary === env.BUCKET) return run(primary);

  try {
    const object = await run(primary);
    if (object) return object;
  } catch (error) {
    reportMediaFallback({ reason: 'primary_unavailable', operation, visibility, binding, key, error: describeError(error) });
    // A legacy failure now is genuine and propagates: the object is reachable
    // through neither bucket, and pretending otherwise would hide an outage.
    return run(env.BUCKET);
  }

  const legacy = await run(env.BUCKET);
  // Only a legacy HIT is residue. A miss in both buckets is simply an object
  // that does not exist and says nothing about the migration.
  if (legacy) reportMediaFallback({ reason: 'legacy_hit', operation, visibility, binding, key });
  return legacy;
}

export async function getMediaObject(
  env: MediaEnv,
  visibility: MediaVisibility,
  key: string
): Promise<R2ObjectBody | null> {
  if (!isSafeMediaKey(key)) return null;
  return readThroughLegacy(env, visibility, key, 'get', (bucket) => bucket.get(key));
}

export async function headMediaObject(
  env: MediaEnv,
  visibility: MediaVisibility,
  key: string
): Promise<R2Object | null> {
  if (!isSafeMediaKey(key)) return null;
  return readThroughLegacy(env, visibility, key, 'head', (bucket) => bucket.head(key));
}

/** Raised when a bound media bucket cannot be written to at all. */
export class MediaBucketUnavailableError extends Error {
  readonly binding: MediaBindingName;
  constructor(binding: MediaBindingName, cause: unknown) {
    super(`Media bucket binding ${binding} is bound but not usable: ${describeError(cause)}`, { cause });
    this.name = 'MediaBucketUnavailableError';
    this.binding = binding;
  }
}

export async function deleteMediaObject(
  env: MediaEnv,
  visibility: MediaVisibility,
  key: string
): Promise<void> {
  if (!isSafeMediaKey(key)) return;
  const primary = mediaBucket(env, visibility);
  const targets: Array<{ binding: MediaBindingName; bucket: R2Bucket }> = [
    { binding: mediaBindingName(env, visibility), bucket: primary },
  ];
  // During migration either location may hold this stable key. Removing both
  // prevents a deleted attachment from reappearing through legacy fallback —
  // and BOTH are attempted even when the first rejects, because stopping at a
  // broken primary binding left the legacy copy in place, which is precisely
  // the copy `readThroughLegacy` would then serve back to the world.
  if (primary !== env.BUCKET) targets.push({ binding: 'BUCKET', bucket: env.BUCKET });

  const outcomes = await Promise.allSettled(targets.map((target) => target.bucket.delete(key)));
  let failure: { reason: unknown } | null = null;
  for (let i = 0; i < outcomes.length; i++) {
    const outcome = outcomes[i];
    if (outcome.status !== 'rejected') continue;
    reportMediaFallback({
      reason: 'primary_unavailable',
      operation: 'delete',
      visibility,
      binding: targets[i].binding,
      key,
      error: describeError(outcome.reason),
    });
    failure ??= { reason: outcome.reason };
  }
  // No fake success. A caller told the object is gone has to be right about it.
  if (failure) throw failure.reason;
}

export interface MediaBucketProbe {
  visibility: MediaVisibility;
  binding: MediaBindingName;
  /** False when this visibility is still resolving to the legacy bucket. */
  dedicated: boolean;
  /** True when the bucket the binding NAMES exists and answered. */
  reachable: boolean;
  error: string | null;
}

/**
 * Does the bucket this binding names actually exist?
 *
 * A HEAD for a key that cannot exist is the cheapest question R2 answers: a
 * real bucket replies "no such object" (null), a bucket that was never created
 * rejects. Nothing in a wrangler config can tell those apart — a bucket name
 * is not validated against the account at deploy time — so this is the only
 * way to find out other than by serving a customer a 500.
 */
export async function probeMediaBucket(env: MediaEnv, visibility: MediaVisibility): Promise<MediaBucketProbe> {
  const binding = mediaBindingName(env, visibility);
  const dedicated = binding !== 'BUCKET';
  try {
    await mediaBucket(env, visibility).head('health/bucket-probe/never-written.json');
    return { visibility, binding, dedicated, reachable: true, error: null };
  } catch (error) {
    return { visibility, binding, dedicated, reachable: false, error: describeError(error) };
  }
}

export interface StoredMediaMetadata {
  key: string;
  visibility: MediaVisibility;
  domain: MediaDomain;
  mime: string;
  bytes: number;
  ownerId?: string | null;
  entityId?: string | null;
  width?: number | null;
  height?: number | null;
  originalName?: string | null;
}

async function recordMediaObject(db: D1Database | undefined, meta: StoredMediaMetadata): Promise<void> {
  if (!db) return;
  const originalName = meta.originalName
    ? meta.originalName.split(/[\\/]/).pop()?.replace(/[^\p{L}\p{N}._ -]/gu, '').slice(0, 180) || null
    : null;
  try {
    await db
      .prepare(
        `INSERT INTO file_objects
          (object_key, visibility, domain, owner_id, entity_id, mime_type, byte_size, width, height, original_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(object_key) DO UPDATE SET
           visibility = excluded.visibility,
           domain = excluded.domain,
           mime_type = excluded.mime_type,
           byte_size = excluded.byte_size,
           width = excluded.width,
           height = excluded.height`
      )
      .bind(
        meta.key,
        meta.visibility,
        meta.domain,
        meta.ownerId ?? null,
        meta.entityId ?? null,
        meta.mime,
        meta.bytes,
        meta.width ?? null,
        meta.height ?? null,
        originalName
      )
      .run();
  } catch (error) {
    // Safe rolling deployment: the Worker may reach an edge before migration
    // 0068 reaches D1. Media remains usable and the migration inventory can
    // backfill it; never delete a successful upload because metadata lagged.
    console.warn('media_metadata_write_skipped', error instanceof Error ? error.name : 'unknown');
  }
}

/**
 * WRITES NEVER FALL BACK. The legacy bucket is a READ-through bridge and
 * nothing else: quietly writing a new object into it because the dedicated
 * bucket was unreachable would keep refilling the very bucket this migration
 * exists to empty, and the fallback log would never go quiet.
 *
 * So a broken dedicated binding fails the upload — loudly, naming the binding,
 * because "the specified bucket does not exist" with no binding name is a
 * message the owner cannot act on.
 */
export async function putMediaObject(
  env: Pick<Env, 'DB' | 'BUCKET' | 'R2_PUBLIC' | 'R2_PRIVATE'>,
  meta: StoredMediaMetadata,
  value: ArrayBuffer | ArrayBufferView | ReadableStream,
  options?: R2PutOptions
): Promise<void> {
  if (!isSafeMediaKey(meta.key)) throw new Error('Unsafe media key');
  const binding = mediaBindingName(env, meta.visibility);
  try {
    await mediaBucket(env, meta.visibility).put(meta.key, value, options);
  } catch (error) {
    reportMediaFallback({
      reason: 'primary_unavailable',
      operation: 'put',
      visibility: meta.visibility,
      binding,
      key: meta.key,
      error: describeError(error),
    });
    throw new MediaBucketUnavailableError(binding, error);
  }
  await recordMediaObject(env.DB, meta);
}

/**
 * Public classification for the anonymous `/files/*` compatibility route.
 * Anything ambiguous is private. `reviews/` is intentionally absent because
 * publication is decided by its authorized API route, not its prefix.
 */
export function isAnonymousPublicMediaKey(key: string): boolean {
  if (!isSafeMediaKey(key)) return false;
  return (
    key.startsWith('products/') ||
    key.startsWith('avatars/') ||
    key.startsWith('community/') ||
    /^users\/[^/]+\/(?:avatar|public-avatars)\//.test(key) ||
    /^merchants\/[^/]+\/(?:public|logos|covers)\//.test(key) ||
    /**
     * THE BRAND FOLDER, WHATEVER CASE IT WAS UPLOADED IN.
     *
     * This directory has been spelled `ui/`, `UIUx/` and `UiUx/` across code,
     * imports and hand uploads, and an exact match on two of those three sent
     * the real object — `UiUx/Logo/Logo.webp` — to the PRIVATE bucket, where an
     * anonymous visitor cannot fetch the site's own logo. A brand asset that
     * only signed-in users can load is not a private asset, it is a broken one.
     *
     * Case-insensitive HERE and nowhere else: this folder holds fixed brand
     * files an admin controls and never user content, so widening it exposes
     * nothing. The user-scoped prefixes above stay exact on purpose — matching
     * `Users/` as loosely as `users/` would be a way to reach someone's data
     * by changing a letter.
     */
    /^ui(?:ux)?\//i.test(key) ||
    key.startsWith('brands/') ||
    key.startsWith('services/')
  );
}
