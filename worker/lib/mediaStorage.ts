import type { Env } from './types';
import { convertToWebp, extensionFor, isConvertibleToWebp } from './imageConvert';

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

/**
 * IS THIS REFERENCE AN OBJECT THIS SHOP ISSUED?
 *
 * `/files/<key>` is how the Worker serves R2, and it is the ONLY shape a
 * stored product picture may have. Anything absolute — a vendor's CDN, an
 * imgur link — is somebody else's file: it is fetched by the VISITOR's
 * browser, from a host nobody here controls, it disappears when that host
 * decides it should, and no cleanup, no conversion and no backup in this
 * project can reach it. The live catalogue still carries three of them.
 *
 * It lives HERE, beside `isSafeMediaKey`, because there are at least two doors
 * a product image comes through — the import and the ordinary admin save — and
 * a rule that only one door enforces is not a rule. It is a check on a
 * DISPLAY URL, not a key validator: the key itself is still built and checked
 * by `buildMediaKey` / `isSafeMediaKey` below.
 */
export function isOwnedMediaUrl(url: string): boolean {
  if (!url.startsWith('/files/')) return false;
  return isSafeMediaKey(url.slice('/files/'.length));
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
  // Metadata is an index over an already-successful R2 write, never part of
  // its commit. This function is deliberately total: a rolling migration or
  // transient D1 failure cannot turn a created object into an unreported
  // orphan by throwing before the writer returns `created_new` to its caller.
  try {
    const originalName = meta.originalName
      ? meta.originalName.split(/[\\/]/).pop()?.replace(/[^\p{L}\p{N}._ -]/gu, '').slice(0, 180) || null
      : null;
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
/**
 * THE ONE DOOR EVERY STORED FILE GOES THROUGH.
 *
 * WHY IT EXISTS. Two rules were true of this codebase and enforced nowhere:
 * every raster image is converted to WebP on the server, and every object key
 * is `domain/entityId/kind/objectId.ext`. Both were enforced by whoever
 * remembered them. An audit of all twenty-nine files that write to R2 found
 * that only `routes/uploads.ts` did:
 *
 *   reviews/<userId>/<id>.jpg           a customer's review photo, unconverted
 *   reviews-evidence/<userId>/<id>.png  the Instagram capture behind it
 *   kyc/<userId>/<id>.jpg               a photograph of someone's identity card
 *   claims/<userId>/<id>.jpg            a warranty claim's evidence
 *   products/import/<sha256>.jpg        a vendor photo pulled in at import
 *
 * Five key shapes with three segments where the rule says four, and five paths
 * storing whatever arrived. The owner found the consequence in their own
 * bucket — `users/.../avatar/<id>.png`, 316 KB — and asked for both rules to
 * hold everywhere: «تتحول في السيرفر ... وكل شيء له ترتيب مضبوط ومرتب».
 *
 * A COMMENT CANNOT ENFORCE A RULE, AND A CODE REVIEW ONLY CATCHES WHAT IT
 * READS. So this function does not accept a key at all. It accepts the four
 * PARTS of one, and builds it — which makes a hand-rolled layout not
 * discouraged but unrepresentable. The extension is not an input either: it is
 * whatever the bytes turn out to be after conversion, so a key can no longer
 * claim `.jpg` over WebP bytes or the reverse.
 *
 * WHAT IT REFUSES TO CONVERT, as decisions rather than omissions:
 *   - an animated GIF, because a transform keeps ONE frame and the animation
 *     is the content;
 *   - AVIF, which is already smaller than the WebP it would become;
 *   - a video, a 3D model, a PDF, a CSV — a receipt PDF is evidence, and
 *     re-encoding evidence destroys it;
 *   - anything at all when `env.IMAGES` is absent, where the caller decides
 *     between refusing and storing honestly under the true extension. This
 *     function never silently stores an unconverted image as if it had been
 *     converted — that is the lie the whole change exists to remove.
 */
export interface MediaPlacement {
  visibility: MediaVisibility;
  domain: MediaDomain;
  /** The thing this file belongs to: a chat id, a review id, a user id. */
  entityId: string;
  /** What KIND of file it is within that entity — the segment that was missing. */
  kind: string;
  /** The object's own id. The extension is decided here, never passed in. */
  objectId: string;
}

export interface StoreMediaInput {
  placement: MediaPlacement;
  bytes: Uint8Array;
  /** The MIME the bytes were sniffed as — never the one the browser claimed. */
  mime: string;
  ownerId?: string | null;
  width?: number | null;
  height?: number | null;
  originalName?: string | null;
  /** Cache-Control for the stored object; the caller knows if it is public. */
  cacheControl?: string;
}

export interface StoreMediaResult {
  key: string;
  mime: string;
  bytes: number;
  /** False when the key existed before this storage call. */
  created_new: boolean;
  /** True when these bytes were re-encoded here rather than stored as they arrived. */
  converted: boolean;
}

export async function storeMedia(
  env: Pick<Env, 'DB' | 'BUCKET' | 'R2_PUBLIC' | 'R2_PRIVATE' | 'IMAGES'>,
  input: StoreMediaInput
): Promise<StoreMediaResult> {
  let bytes = input.bytes;
  let mime = input.mime;
  let converted = false;

  if (isConvertibleToWebp(mime)) {
    const out = await convertToWebp(env, bytes, mime);
    if (out.ok) {
      bytes = out.bytes;
      mime = out.mime;
      converted = true;
    } else if (out.reason === 'unavailable') {
      // The binding is absent on this deployment. Storing the original under
      // its TRUE extension is honest; storing it under `.webp` would not be.
      // The caller is told, and decides whether that is acceptable for its
      // purpose — `routes/uploads.ts` refuses, because a catalogue photo that
      // is silently a JPEG is the defect this all began with.
      console.error('storeMedia: the Images binding is absent — stored without conversion', input.placement.domain);
    } else if (out.reason === 'too_large') {
      throw new Error('IMAGE_TOO_LARGE_TO_CONVERT');
    } else if (out.reason === 'failed') {
      throw new Error(`IMAGE_CONVERT_FAILED: ${out.detail}`);
    }
    // `not_convertible` cannot be reached — `isConvertibleToWebp` guards this
    // whole branch — and it is left unhandled rather than thrown on, so the
    // bytes fall through and are stored under their true type if the set of
    // convertible formats ever widens without this call site being told.

  }

  const key = buildMediaKey({
    visibility: input.placement.visibility,
    domain: input.placement.domain,
    entityId: input.placement.entityId,
    kind: input.placement.kind,
    objectId: input.placement.objectId,
    extension: extensionFor(mime),
  });

  const write = await putMediaObject(
    env,
    {
      key,
      visibility: input.placement.visibility,
      domain: input.placement.domain,
      mime,
      bytes: bytes.byteLength,
      ownerId: input.ownerId ?? null,
      entityId: input.placement.entityId,
      width: input.width ?? null,
      height: input.height ?? null,
      originalName: input.originalName ?? null,
    },
    bytes,
    {
      httpMetadata: {
        contentType: mime,
        cacheControl:
          input.cacheControl ??
          (input.placement.visibility === 'public'
            ? 'public, max-age=31536000, immutable'
            : 'private, max-age=300'),
      },
    }
  );

  return { key, mime, bytes: bytes.byteLength, created_new: write.created_new, converted };
}

export interface MediaWriteResult {
  /** True only when this call created a key which did not exist beforehand. */
  created_new: boolean;
}

export async function putMediaObject(
  env: Pick<Env, 'DB' | 'BUCKET' | 'R2_PUBLIC' | 'R2_PRIVATE'>,
  meta: StoredMediaMetadata,
  value: ArrayBuffer | ArrayBufferView | ReadableStream,
  options?: R2PutOptions
): Promise<MediaWriteResult> {
  if (!isSafeMediaKey(meta.key)) throw new Error('Unsafe media key');
  const binding = mediaBindingName(env, meta.visibility);
  const bucket = mediaBucket(env, meta.visibility);
  try {
    const existed = (await bucket.head(meta.key)) !== null;
    await bucket.put(meta.key, value, options);
    await recordMediaObject(env.DB, meta);
    return { created_new: !existed };
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
}

/**
 * Content-addressed write: never replaces bytes already stored under `key`.
 * R2's conditional put closes the HEAD/PUT race; `null` means another writer
 * won and therefore this caller must not delete the shared object on rollback.
 */
export async function putMediaObjectIfAbsent(
  env: Pick<Env, 'DB' | 'BUCKET' | 'R2_PUBLIC' | 'R2_PRIVATE'>,
  meta: StoredMediaMetadata,
  value: ArrayBuffer | ArrayBufferView | ReadableStream,
  options?: Omit<R2PutOptions, 'onlyIf'>
): Promise<MediaWriteResult> {
  if (!isSafeMediaKey(meta.key)) throw new Error('Unsafe media key');

  // Include legacy during the migration: an object already reachable by this
  // stable key is preexisting even if it has not yet moved buckets.
  const existing = await headMediaObject(env, meta.visibility, meta.key);
  if (existing) {
    // `meta` describes the bytes the caller hoped to create, not the object
    // HEAD found. Recording it here could bless a corrupted/pre-seeded key as
    // valid WebP without ever reading the stored body. The product pipeline
    // verifies existing bytes separately; generic callers leave existing
    // ledger metadata untouched.
    return { created_new: false };
  }

  const binding = mediaBindingName(env, meta.visibility);
  try {
    const created = await mediaBucket(env, meta.visibility).put(meta.key, value, {
      ...options,
      onlyIf: { etagDoesNotMatch: '*' },
    });
    // Real R2 returns null when the precondition lost. Lightweight test
    // buckets often return void after a successful put, which is still a
    // successful create and must not be mistaken for the null sentinel.
    const createdNew = created !== null;
    if (createdNew) await recordMediaObject(env.DB, meta);
    return { created_new: createdNew };
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
}

/** Rollback helper whose type forces callers to carry creation provenance. */
export async function deleteMediaObjectIfCreated(
  env: MediaEnv,
  visibility: MediaVisibility,
  object: { key: string; created_new: boolean }
): Promise<boolean> {
  if (!object.created_new) return false;
  await deleteMediaObject(env, visibility, object.key);
  return true;
}

/**
 * Public classification for the anonymous `/files/*` compatibility route.
 * Anything ambiguous is private. `reviews/` is intentionally absent because
 * publication is decided by its authorized API route, not its prefix.
 */
/**
 * IS THIS KEY ONE A HUMAN REPLACES IN PLACE?
 *
 * Every key this application MINTS is unique to its upload — a content digest
 * (`products/import/gallery/<sha>.webp`) or a request token
 * (`mintSiteMediaObject`, which yields `logo-a1b2c3.webp`). For those, a URL's
 * bytes genuinely never change and `immutable` is an honest promise.
 *
 * The brand folder is the exception, and it is the only one. `ui/`, `UIUx/`,
 * `UiUx/` hold FIXED NAMES — `UiUx/Logo/Logo.webp`, `UiUx/MainPage/Bundle.webp`
 * — that the owner replaces by hand in the R2 dashboard, keeping the name so
 * every reference to it keeps working. The bytes at one URL therefore DO
 * change, which is the whole point of the folder.
 *
 * THE FAILURE THIS EXISTS TO END. `/files/*` answered every public key with
 * `max-age=31536000, immutable`, under a comment asserting that media keys are
 * content-addressed. True for the minted ones, false for these — and
 * `immutable` does not merely cache, it tells the browser and the edge never to
 * ASK again. So the owner uploaded a new logo, and every visitor kept the old
 * one: measured on the live site as `cf-cache-status: HIT`, `age: 45821`, with
 * the cached body 70,084 bytes against the 51,518 actually in R2. A year of
 * that, on the site's own mark, with nothing to do but rename the file.
 *
 * `brands/` and `services/` are here for the same reason: fixed names an admin
 * curates, not per-upload keys.
 */
export function isRewritableMediaKey(key: string): boolean {
  return /^ui(?:ux)?\//i.test(key) || key.startsWith('brands/') || key.startsWith('services/');
}

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
