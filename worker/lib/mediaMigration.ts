import type { Env } from './types';
import { isAnonymousPublicMediaKey, isSafeMediaKey, mediaBucket, type MediaDomain, type MediaVisibility } from './mediaStorage';
import { isSiteMediaObject, siteMediaKey } from './siteMedia';

export type LegacyMediaAction = 'copy' | 'convert_webp' | 'orphan_candidate' | 'manual_review';

/**
 * THE BRAND FOLDER, IN EVERY CASE IT HAS EVER BEEN SPELLED.
 *
 * `ui/`, `UIUx/` and `UiUx/` are the same directory of admin-controlled brand
 * assets, written differently by code, imports and hand uploads at different
 * times. `isAnonymousPublicMediaKey` already matches all three — so when the
 * checks in this file matched only the exact string `UIUx/`, the REAL object
 * (`UiUx/Logo/Logo.webp`) came out of `planLegacyMediaKey` classified public
 * but labelled `domain: 'support'` and `action: 'manual_review'`: a file the
 * serving path treats as the site's logo and the migration path refuses to
 * touch. One rule, one spelling-insensitive test, used by both.
 *
 * Deliberately scoped to THIS folder. Every other prefix below stays an exact
 * match, because they are user-scoped: matching `Users/` as loosely as
 * `users/` would make a letter of case a way to reach someone else's data.
 */
const BRAND_FOLDER_PREFIX = /^ui(?:ux)?$/i;

/**
 * The LEGACY spelling only, and this one is NOT the same rule.
 *
 * `uiux/*` in any case is the old hand-made directory, and it is the only
 * thing the canonical rename (`ui/levonis/<kind>/<name>_<hash>`) may touch.
 * `ui/*` is already the canonical namespace: renaming it again would file an
 * object that had ALREADY been migrated into `ui/levonis/legacy/`, and the
 * apply endpoint would rewrite the settings row to follow it — a migration
 * that moves its own output every time it is re-run. Matching only the legacy
 * spelling keeps the rename idempotent.
 */
const LEGACY_BRAND_FOLDER_KEY = /^uiux\//i;

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
  // The brand folder answers first, in any case. Below it the map is exact.
  if (BRAND_FOLDER_PREFIX.test(prefix)) return 'ui';
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
    brands: 'brands',
    services: 'services',
    kyc: 'kyc',
    requests: 'requests',
    'request-previews': 'print-requests',
    // The quote engine's own namespace. Absent from this map a key classifies
    // as domain 'support' and action 'manual_review' — which is the exact
    // silent misfiling the ui/uiux note at the top of this file describes.
    'print-requests': 'print-requests',
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
    LEGACY_BRAND_FOLDER_KEY.test(key) && !supportedUiExtension ? 'manual_review' :
    visibility === 'public' && domain === 'products' && ['png', 'jpg', 'jpeg'].includes(extension)
      ? 'convert_webp'
      : 'copy';
  let destinationKey = key;
  if (LEGACY_BRAND_FOLDER_KEY.test(key) && action === 'copy') {
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

/**
 * THE SETTINGS STORE IS CALLED `admin_settings`, AND IT ALWAYS HAS BEEN.
 *
 * This list read `SELECT value FROM settings` — a table that has never existed
 * in this schema. `migrations/0001_init.sql:332` creates `admin_settings(key
 * TEXT PRIMARY KEY, value TEXT NOT NULL)` and no migration has ever created a
 * bare `settings`. SQLite answered `no such table: settings`, the catch below
 * swallowed it, and the inventory silently carried on with one whole source
 * missing — the one holding `homeBanners`, `homeSectionItems` and
 * `mainPageMedia`, i.e. every picture the owner put on the front page.
 *
 * `worker/lib/mediaRefs.ts` reads the same store correctly (`{ table:
 * 'admin_settings', column: 'value' }`) and its header records why it had to:
 * the orphan sweeper had already called the home banners orphans once.
 *
 * AND THE KEY IS PART OF THE ANSWER, NOT DECORATION. `mainPageMedia` stores a
 * BARE OBJECT NAME (`banner-1-a1b2.webp`), not a key; the object is
 * `UiUx/MainPage/` + that name. `addReference` rejects it on purpose (no `/`,
 * so it cannot be a key), so read value-only the site's own logo, its service
 * icons and its hero banners all stay unreferenced. That is why this source is
 * read `SELECT key, value` and resolved through `siteMediaKey` — the same step
 * `resolveSiteMediaKeys` in mediaRefs.ts takes, for the same reason.
 */
const SETTINGS_REFERENCE_SQL = 'SELECT key, value FROM admin_settings';

/** Value-only sources: every column in the row is walked for a media key. */
const MEDIA_REFERENCE_QUERIES = [
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
];

/** `mainPageMedia`: slot id -> bare object name under `UiUx/MainPage/`. */
function addSiteMediaReferences(out: Set<string>, value: unknown): void {
  if (typeof value !== 'string' || !value.trim()) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
  // Every value is checked, not only the slots `normalizeSiteMedia` knows: a
  // slot id that has since been renamed still has a real object behind it, and
  // a reference scan that drops it is the one that calls that object an orphan.
  for (const object of Object.values(parsed as Record<string, unknown>)) {
    if (isSiteMediaObject(object)) out.add(siteMediaKey(object));
  }
}

/**
 * A FAILED READ IS NOT AN EMPTY TABLE.
 *
 * The catch here used to return nothing and say nothing, and that is how the
 * `settings` typo above survived: a query naming a table that does not exist
 * fails identically to a table a rolling migration has not created yet, and
 * both looked like "this source contributes no references". The original
 * reason for the tolerance is real — a Worker reaches an edge before its
 * migration reaches D1 — so the tolerance stays. What changes is that the
 * failure is now RECORDED and LOGGED instead of vanishing.
 *
 * This is `soft()` from worker/lib/stockAlertResolve.ts, and this caller is
 * NOT different — it is the same failure class stated in the same words. There
 * the missing rows turn a live sellable option into «ما عاد موجود» and the
 * sweep writes it dead. Here the missing rows turn a referenced object into
 * `orphan_candidate`, which is this module's word for «nothing points at this
 * any more». An inventory is a claim about ABSENCE, and absence is the one
 * claim a failed read can never support.
 *
 * It is a local copy rather than an import because `soft()` is not exported
 * and stockAlertResolve.ts is another track's file; the contract, not the
 * function, is what is being reused.
 */
async function soft(
  label: string,
  failed: string[],
  run: () => Promise<{ results?: Record<string, unknown>[] | null }>
): Promise<Record<string, unknown>[]> {
  try {
    return (await run()).results ?? [];
  } catch (e) {
    console.error(`media reference source unavailable (${label}): ${e instanceof Error ? e.message : String(e)}`);
    failed.push(label);
    return [];
  }
}

/**
 * Named `Inventory…` and not `MediaReferenceScan`, which is taken.
 *
 * worker/lib/mediaRefs.ts already exports a `MediaReferenceScan` of a DIFFERENT
 * shape, used by `collectMediaReferences` — the scanner that guards the
 * destructive sweep and is, by design, the better of the two. Nothing imports
 * both today, so a collision would compile; it would simply mean that every
 * reviewer reading the name in a diff has to find out which module it came
 * from first, and that the eventual convergence of the two scanners (see this
 * file's header) has to begin by renaming a type. A local name costs nothing
 * now and keeps that merge a merge.
 */
export interface InventoryReferenceScan {
  /** Every key some row still points at, as far as the reads that WORKED say. */
  refs: Set<string>;
  /**
   * The SQL of every source whose read threw. Non-empty means `refs` is
   * INCOMPLETE and no object may be called unreferenced on the strength of it.
   */
  failed: string[];
}

/** Every known relational/JSON location that can keep an R2 object alive,
 *  plus which of those reads did not happen. */
export async function scanMediaReferences(db: D1Database): Promise<InventoryReferenceScan> {
  const refs = new Set<string>();
  const failed: string[] = [];
  for (const sql of MEDIA_REFERENCE_QUERIES) {
    for (const row of await soft(sql, failed, () => db.prepare(sql).all<Record<string, unknown>>())) {
      for (const value of Object.values(row)) addReference(refs, value);
    }
  }
  for (const row of await soft(SETTINGS_REFERENCE_SQL, failed, () =>
    db.prepare(SETTINGS_REFERENCE_SQL).all<Record<string, unknown>>()
  )) {
    addReference(refs, row.value);
    if (row.key === 'mainPageMedia') addSiteMediaReferences(refs, row.value);
  }
  return { refs, failed };
}

/**
 * Every known relational/JSON location that can keep an R2 object alive.
 *
 * Kept as-is for callers that only ever act on a POSITIVE answer — the apply
 * endpoint asks «is this key referenced?» and a `false` there refuses the
 * migration, which is the safe direction on a degraded read. Anything that
 * reports absence to a human must use `scanMediaReferences` and carry the
 * `failed` channel with it.
 */
export async function currentMediaReferences(db: D1Database): Promise<Set<string>> {
  return (await scanMediaReferences(db)).refs;
}

export interface MediaInventoryPage {
  objects: Array<LegacyMediaPlan & { size: number; uploaded: string }>;
  cursor: string | null;
  truncated: boolean;
  /** True when at least one reference source could not be read, so «nothing
   *  points at this» was not provable for any object on this page. */
  degraded: boolean;
  /** The SQL of each source that failed, so the admin sees WHICH one. */
  failed_sources: string[];
}

/** Read-only, cursor-based inventory of the legacy mixed bucket. */
export async function inventoryLegacyMedia(env: Env, cursor?: string, limit = 250): Promise<MediaInventoryPage> {
  const { refs, failed } = await scanMediaReferences(env.DB);
  const degraded = failed.length > 0;
  const page = await env.BUCKET.list({ cursor, limit: Math.min(500, Math.max(1, limit)), include: ['httpMetadata'] });
  return {
    objects: page.objects.map((object) => {
      const plan = planLegacyMediaKey(object.key, refs.has(object.key));
      return {
        ...plan,
        // A DEGRADED SCAN MAY NOT NAME ORPHANS. `orphan_candidate` is the one
        // verdict here that rests on a reference set being COMPLETE, and this
        // page is what an admin reads before deciding what to clean up. With a
        // source missing it becomes `manual_review`: still listed, still
        // visible, but no longer presented as safe to discard. Every other
        // action stands, because they rest on the key itself, not on absence.
        action: degraded && plan.action === 'orphan_candidate' ? 'manual_review' : plan.action,
        size: object.size,
        uploaded: object.uploaded.toISOString(),
      };
    }),
    cursor: page.truncated ? page.cursor : null,
    truncated: page.truncated,
    degraded,
    failed_sources: failed,
  };
}

export function hasDedicatedBucket(env: Env, visibility: MediaVisibility): boolean {
  return mediaBucket(env, visibility) !== env.BUCKET;
}
