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
const EXTENSION = /^(?:avif|csv|gif|jpg|jpeg|json|mp4|pdf|png|stl|3mf|webp)$/i;

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

export function mediaBucket(env: Pick<Env, 'BUCKET' | 'R2_PUBLIC' | 'R2_PRIVATE'>, visibility: MediaVisibility): R2Bucket {
  return visibility === 'public' ? env.R2_PUBLIC ?? env.BUCKET : env.R2_PRIVATE ?? env.BUCKET;
}

/**
 * Read new storage first and the legacy bucket second. This is the compatibility
 * bridge that lets bindings be provisioned before old DB references migrate.
 */
export async function getMediaObject(
  env: Pick<Env, 'BUCKET' | 'R2_PUBLIC' | 'R2_PRIVATE'>,
  visibility: MediaVisibility,
  key: string
): Promise<R2ObjectBody | null> {
  if (!isSafeMediaKey(key)) return null;
  const primary = mediaBucket(env, visibility);
  const object = await primary.get(key);
  if (object || primary === env.BUCKET) return object;
  return env.BUCKET.get(key);
}

export async function headMediaObject(
  env: Pick<Env, 'BUCKET' | 'R2_PUBLIC' | 'R2_PRIVATE'>,
  visibility: MediaVisibility,
  key: string
): Promise<R2Object | null> {
  if (!isSafeMediaKey(key)) return null;
  const primary = mediaBucket(env, visibility);
  const object = await primary.head(key);
  if (object || primary === env.BUCKET) return object;
  return env.BUCKET.head(key);
}

export async function deleteMediaObject(
  env: Pick<Env, 'BUCKET' | 'R2_PUBLIC' | 'R2_PRIVATE'>,
  visibility: MediaVisibility,
  key: string
): Promise<void> {
  if (!isSafeMediaKey(key)) return;
  const primary = mediaBucket(env, visibility);
  await primary.delete(key);
  // During migration either location may hold this stable key. Removing both
  // prevents a deleted attachment from reappearing through legacy fallback.
  if (primary !== env.BUCKET) await env.BUCKET.delete(key);
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

export async function putMediaObject(
  env: Pick<Env, 'DB' | 'BUCKET' | 'R2_PUBLIC' | 'R2_PRIVATE'>,
  meta: StoredMediaMetadata,
  value: ArrayBuffer | ArrayBufferView | ReadableStream,
  options?: R2PutOptions
): Promise<void> {
  if (!isSafeMediaKey(meta.key)) throw new Error('Unsafe media key');
  await mediaBucket(env, meta.visibility).put(meta.key, value, options);
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
    key.startsWith('ui/') ||
    key.startsWith('UIUx/') ||
    key.startsWith('brands/') ||
    key.startsWith('services/')
  );
}
