import type { Env } from './types';
import { isAnonymousPublicMediaKey, isSafeMediaKey, mediaBucket, type MediaDomain, type MediaVisibility } from './mediaStorage';

export type LegacyMediaAction = 'copy' | 'convert_webp' | 'orphan_candidate' | 'manual_review';

export interface LegacyMediaPlan {
  key: string;
  destinationKey: string;
  visibility: MediaVisibility;
  domain: MediaDomain;
  referenced: boolean;
  action: LegacyMediaAction;
}

function domainForKey(key: string): MediaDomain {
  const prefix = key.split('/')[0];
  const map: Record<string, MediaDomain> = {
    products: 'products',
    avatars: 'users',
    users: 'users',
    community: 'merchants',
    merchants: 'merchants',
    chat: 'chat',
    support: 'support',
    reviews: 'reviews',
    'reviews-evidence': 'reviews-evidence',
    orders: 'orders',
    warranty: 'warranty',
    claims: 'claims',
    receipts: 'receipts',
    imports: 'imports',
    ui: 'ui',
    UIUx: 'ui',
    brands: 'brands',
    services: 'services',
    kyc: 'kyc',
    requests: 'requests',
    'request-previews': 'print-requests',
  };
  return map[prefix] ?? 'support'; // unknown is private/manual-review below
}

export function planLegacyMediaKey(key: string, referenced: boolean): LegacyMediaPlan {
  if (!isSafeMediaKey(key)) {
    return { key, destinationKey: key, visibility: 'private', domain: 'support', referenced, action: 'manual_review' };
  }
  const visibility: MediaVisibility = isAnonymousPublicMediaKey(key) ? 'public' : 'private';
  const extension = key.split('.').pop()?.toLowerCase() ?? '';
  const domain = domainForKey(key);
  const knownPrefix = domain !== 'support' || key.startsWith('support/');
  const supportedUiExtension = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'].includes(extension);
  const action: LegacyMediaAction =
    !referenced ? 'orphan_candidate' :
    !knownPrefix ? 'manual_review' :
    key.startsWith('UIUx/') && !supportedUiExtension ? 'manual_review' :
    visibility === 'public' && domain === 'products' && ['png', 'jpg', 'jpeg'].includes(extension)
      ? 'convert_webp'
      : 'copy';
  let destinationKey = key;
  if (key.startsWith('UIUx/') && action === 'copy') {
    const parts = key.split('/');
    const sourceKind = (parts[1] || 'legacy').toLowerCase();
    const kind = sourceKind.startsWith('anim') ? 'animations' : sourceKind.startsWith('icon') ? 'icons' : sourceKind.startsWith('logo') ? 'logo' : 'legacy';
    const base = (parts.at(-1) || 'asset').replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 45) || 'asset';
    // Small deterministic FNV suffix prevents two old nested folders with the
    // same basename colliding in the canonical namespace.
    let hash = 0x811c9dc5;
    for (const char of key) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 0x01000193); }
    destinationKey = `ui/levonis/${kind}/${base}_${(hash >>> 0).toString(16)}.${extension}`;
  }
  return { key, destinationKey, visibility, domain, referenced, action };
}

function addReference(out: Set<string>, value: unknown): void {
  if (typeof value !== 'string') return;
  const raw = value.trim();
  if (!raw) return;
  if (raw.startsWith('/files/')) {
    const key = raw.slice('/files/'.length);
    if (isSafeMediaKey(key)) out.add(key);
    return;
  }
  if (isSafeMediaKey(raw) && raw.includes('/')) out.add(raw);
  if ((raw.startsWith('[') || raw.startsWith('{')) && raw.length <= 2_000_000) {
    try {
      const walk = (item: unknown) => {
        if (typeof item === 'string') addReference(out, item);
        else if (Array.isArray(item)) for (const child of item) walk(child);
        else if (item && typeof item === 'object') for (const child of Object.values(item as Record<string, unknown>)) walk(child);
      };
      walk(JSON.parse(raw));
    } catch {
      // A malformed legacy JSON field is an application data issue, not a
      // reason for the inventory to invent a reference.
    }
  }
}

/** Every known relational/JSON location that can keep an R2 object alive. */
export async function currentMediaReferences(db: D1Database): Promise<Set<string>> {
  const refs = new Set<string>();
  const queries = [
    'SELECT r2_key, url FROM product_images',
    'SELECT avatar_key FROM users',
    'SELECT receipt_key FROM wallet_transactions',
    'SELECT file_key FROM chat_messages',
    'SELECT file_key, preview_key FROM community_request_files',
    'SELECT file_key FROM community_complaint_messages',
    'SELECT file_key FROM claim_messages',
    'SELECT evidence FROM warranty_claims',
    'SELECT media FROM reviews',
    'SELECT instagram_evidence FROM review_rewards',
    'SELECT evidence_keys FROM kyc_cases',
    'SELECT image_snapshot FROM order_items',
    'SELECT value FROM settings',
  ];
  for (const sql of queries) {
    try {
      const { results } = await db.prepare(sql).all<Record<string, unknown>>();
      for (const row of results ?? []) for (const value of Object.values(row)) addReference(refs, value);
    } catch {
      // Supports a rolling migration and old local databases where a later
      // feature table may not exist yet. Other reference sources still count.
    }
  }
  return refs;
}

export interface MediaInventoryPage {
  objects: Array<LegacyMediaPlan & { size: number; uploaded: string }>;
  cursor: string | null;
  truncated: boolean;
}

/** Read-only, cursor-based inventory of the legacy mixed bucket. */
export async function inventoryLegacyMedia(env: Env, cursor?: string, limit = 250): Promise<MediaInventoryPage> {
  const references = await currentMediaReferences(env.DB);
  const page = await env.BUCKET.list({ cursor, limit: Math.min(500, Math.max(1, limit)), include: ['httpMetadata'] });
  return {
    objects: page.objects.map((object) => ({
      ...planLegacyMediaKey(object.key, references.has(object.key)),
      size: object.size,
      uploaded: object.uploaded.toISOString(),
    })),
    cursor: page.truncated ? page.cursor : null,
    truncated: page.truncated,
  };
}

export function hasDedicatedBucket(env: Env, visibility: MediaVisibility): boolean {
  return mediaBucket(env, visibility) !== env.BUCKET;
}
