/**
 * THE DELTA RUN (workflow 60 `mode=delta`; Bambu import spec §O).
 *
 * After a run has closed, a NEW run takes exactly two kinds of item, and nothing else:
 *
 *   new    a product the store's sitemap lists that no run has ever held (by handle and by source id), that no
 *          Levonis product carries as its source (`product_source_refs`), and that the reviewed manifest does not
 *          name. It goes through the normal per-product pipeline. Its manifest row is not reviewed in the
 *          repository (the repository is public and carries no new store data): the Worker builds it from the
 *          item it registered — the source id, the handle, the store's own route (`breadcrumbs`), the type the
 *          route gives — and the reviewed taxonomy map places it by that route like any other row. Before a
 *          create, the §E.1 candidate rule (packages/catalog matchSignals.ts, the rule the original run's P0 review
 *          used) runs over the live catalogue: a candidate the reviewed existing-matches.json does not settle stops
 *          the create (REVIEWED_SCOPE_REFUSED, §E.1 item 4) until the owner's reviewed decision is committed.
 *   media  a COMPLETE item of the closed run (`from_run`) whose media failed: a media-only stage re-fetches ONLY
 *          those media (./mediaRetry.ts) and attaches them where the original write would have put them. It never
 *          writes a product, so /stage, /write and /complete refuse it.
 *
 * And, in a run of its own (workflow 60 `mode=delta item=content`, spec §O.6), a third:
 *
 *   content  a COMPLETE item of the closed run whose DESCRIPTION or IN-THE-BOX pictures failed: the content pass
 *          (./contentMedia.ts) puts each into the exact field the import wrote — an image block of
 *          `products.content_blocks`, the `media_key` of an item of a `package.contents` row — only where that field
 *          is still byte for byte what the import wrote, compare-and-set. /stage, /write, /complete refuse it too.
 *
 * The kind is durable on the item: `discovery_sources` carries `delta_new`, `media_retry:<from run>` or
 * `content_media:<from run>`. Those markers are reserved: /manifest refuses them, and only /delta/manifest writes
 * them — into a run that holds nothing but delta items (a content run: content items only). Counts, source ids and
 * public store handles only; never a name, a URL or a price.
 */
import { H } from '@levonis/catalog/bambuImport/hash';
import { productTypeOf } from '@levonis/catalog/bambuImport/registry/types';
import { matchCandidates, type SnapshotTables } from '@levonis/catalog/bambuImport/matchSignals';
import { NOW_SQL, OpsRefusal, type ImportRun } from './auth';
import { packedInserts } from './budget';
import { taxonomyOfRow, type ManifestRow, type ReviewedBundle } from './reviewed';

export const DELTA_NEW = 'delta_new';
export const MEDIA_RETRY = 'media_retry:';
export const CONTENT_MEDIA = 'content_media:';
/** At most this many new products in one delta run: a sitemap that suddenly lists many is a review, not a delta. */
export const DELTA_NEW_MAX = 20;
/** At most this many sitemap handles in one /delta/plan call. */
export const SITEMAP_HANDLES_MAX = 6000;
export const STORE_PRODUCTS = 'https://us.store.bambulab.com/products/';

const RUN_ID = /^cir_[0-9a-f]{24}$/;
const SID = /^[0-9]{1,24}$/;
/** A store handle as the logger prints it (scripts/bambu-import/log.ts HANDLE): lower-case words, digits, dashes. */
export const DELTA_HANDLE = /^[\p{Ll}\p{Nd}][\p{Ll}\p{Nd}\p{M}._-]{0,159}$/u;
/** The store's route: category source ids joined by `>` (reviewed.ts taxonomy routes have the same shape). */
export const DELTA_ROUTE = /^[0-9]{1,24}(?:>[0-9]{1,24}){0,7}$/;
const ISOISH = /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?$/;

export type DeltaKind = 'new' | 'media' | 'content';
export interface DeltaMark {
  kind: DeltaKind;
  /** The closed run a media or content item takes its failed media from (empty for a new product). */
  fromRun: string;
}

/** The discovery sources a delta item is born with. */
export function deltaSources(kind: DeltaKind, fromRun = ''): string[] {
  if (kind === 'new') return ['sitemap', DELTA_NEW];
  return [`${kind === 'content' ? CONTENT_MEDIA : MEDIA_RETRY}${fromRun}`];
}

/** A reserved discovery source: only /delta/manifest writes one. */
export const isReservedSource = (s: unknown): boolean =>
  typeof s === 'string' && (s === DELTA_NEW || s.startsWith(MEDIA_RETRY) || s.startsWith(CONTENT_MEDIA));

/** The delta kind of an item, from its stored `discovery_sources` (a JSON array); null for an ordinary item. */
export function deltaMarkOf(discoverySources: unknown): DeltaMark | null {
  let list: unknown;
  try {
    list = typeof discoverySources === 'string' ? JSON.parse(discoverySources || '[]') : discoverySources;
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  for (const s of list) {
    if (typeof s !== 'string') continue;
    if (s.startsWith(MEDIA_RETRY)) {
      const from = s.slice(MEDIA_RETRY.length);
      if (RUN_ID.test(from)) return { kind: 'media', fromRun: from };
    }
    if (s.startsWith(CONTENT_MEDIA)) {
      const from = s.slice(CONTENT_MEDIA.length);
      if (RUN_ID.test(from)) return { kind: 'content', fromRun: from };
    }
  }
  return list.includes(DELTA_NEW) ? { kind: 'new', fromRun: '' } : null;
}

/**
 * What an item's `discovery_sources` makes of it for the doors that write a product (/stage, /write, /complete) and
 * for the unrestricted /media: `none` (an ordinary item), `new` (a delta's new product: the normal pipeline), the
 * media-only and content kinds — and `unknown`, a reserved marker this code does not read (a later kind, a malformed
 * run id). FAIL CLOSED: every door but the ones of the kinds it knows refuses an `unknown` item.
 */
export type DeltaDoorKind = 'none' | DeltaKind | 'unknown';
export function deltaDoorKindOf(discoverySources: unknown): DeltaDoorKind {
  const mark = deltaMarkOf(discoverySources);
  let list: unknown;
  try {
    list = typeof discoverySources === 'string' ? JSON.parse(discoverySources || '[]') : discoverySources;
  } catch {
    return 'unknown';
  }
  if (!Array.isArray(list)) return 'unknown';
  const reserved = list.filter(isReservedSource);
  if (!reserved.length) return 'none';
  if (!mark) return 'unknown';
  // Exactly one marker, and the one the mark names: two kinds on one item (never written) read as unknown.
  const markers = reserved.filter((s) => s !== DELTA_NEW);
  if (mark.kind === 'new') return markers.length ? 'unknown' : 'new';
  return markers.length === 1 && !reserved.includes(DELTA_NEW) ? mark.kind : 'unknown';
}

// ---------------------------------------------------------------- the queue (pure)

/** An item of an earlier run, as the queue construction reads it. */
export interface PriorItem {
  run_id: string;
  source_product_id: string;
  handle: string;
  state: string;
  queue_position: number;
  /** The product the item wrote (a COMPLETE item always names one). */
  levonis_product_id?: string;
}

export interface DeltaQueueInput {
  /** The product handles the store's sitemaps list now (decoded, NFC). */
  listedHandles: readonly string[];
  /** Every item of every earlier run. */
  prior: readonly PriorItem[];
  /** The closed run whose failed media are retried. */
  fromRun: string;
  /** Failed media of `fromRun`, by source product id. */
  failedBySid: ReadonlyMap<string, number>;
  /**
   * Handles held elsewhere than by an earlier run's item: the `source_handle` of a `product_source_refs` row, a handle
   * the reviewed manifest names. Never new.
   */
  knownHandles?: Iterable<string>;
  /**
   * The product each source id is carried by NOW (`product_source_refs` joined to a `products` row that exists). When
   * given, a media item is queued only while its source is still carried by the product the closed run wrote: one the
   * owner deleted since (or whose source ref went with it) is counted `media_product_gone`, never queued.
   */
  liveProductBySid?: ReadonlyMap<string, string>;
  /** Source ids an earlier delta run already settled as a media item of `fromRun` (`retrySettled`): counted, never queued again. */
  alreadyRetried?: ReadonlySet<string>;
}

export interface DeltaQueue {
  /** Listed handles no earlier run ever held, sorted: the new products (each still checked by source id). */
  newHandles: string[];
  /** COMPLETE items of `fromRun` with failed media, in their queue order: the media-only stage. */
  media: Array<{ source_product_id: string; handle: string; failed: number }>;
  counts: {
    listed: number;
    known: number;
    new: number;
    unusable_handles: number;
    media_items: number;
    media_failed: number;
    /** Failed media of items that are not COMPLETE (withdrawn, blocked): never retried. */
    failed_not_complete: number;
    /** Items withdrawn at the source that the sitemap lists again: reported, never queued (the owner decides). */
    withdrawn_listed: number;
    /** COMPLETE items with failed media whose product is gone (deleted, or no longer carrying the source): not queued. */
    media_product_gone: number;
    /** COMPLETE items with failed media that an earlier delta already settled (`retrySettled`): not queued again. */
    media_already_retried: number;
  };
}

/**
 * The delta queue: (a) the listed handles absent from every earlier run's items (and from every other handle known:
 * a source ref's, the reviewed manifest's), (b) the COMPLETE items of the closed run whose media failed, whose product
 * still carries the source and that no earlier delta already settled. A withdrawn or blocked item is neither new nor
 * retried; a completed one without failures is not touched.
 */
export function deltaQueue(input: DeltaQueueInput): DeltaQueue {
  const listed = new Set(input.listedHandles);
  const knownHandles = new Set([...input.prior.map((p) => p.handle), ...(input.knownHandles ?? [])]);
  const fresh = [...listed].filter((h) => !knownHandles.has(h));
  const usable = fresh.filter((h) => DELTA_HANDLE.test(h)).sort();
  const fromItems = input.prior.filter((p) => p.run_id === input.fromRun);
  const withFailures = fromItems
    .filter((p) => p.state === 'COMPLETE' && (input.failedBySid.get(p.source_product_id) ?? 0) > 0)
    .sort((a, b) => a.queue_position - b.queue_position);
  // The product the closed run wrote must still exist and still carry the source (the test /media-plan applies):
  // a media item for a product the owner deleted would be refused at its turn and stop the queue for good.
  const live = input.liveProductBySid;
  const carried = withFailures.filter((p) => !live || (!!p.levonis_product_id && live.get(p.source_product_id) === p.levonis_product_id));
  const retried = input.alreadyRetried;
  const media = carried
    .filter((p) => !retried?.has(p.source_product_id))
    .map((p) => ({ source_product_id: p.source_product_id, handle: p.handle, failed: input.failedBySid.get(p.source_product_id) ?? 0 }));
  const failedNotComplete = fromItems.filter((p) => p.state !== 'COMPLETE').reduce((n, p) => n + (input.failedBySid.get(p.source_product_id) ?? 0), 0);
  return {
    newHandles: usable,
    media,
    counts: {
      listed: listed.size,
      known: [...listed].filter((h) => knownHandles.has(h)).length,
      new: usable.length,
      unusable_handles: fresh.length - usable.length,
      media_items: media.length,
      media_failed: media.reduce((n, m) => n + m.failed, 0),
      failed_not_complete: failedNotComplete,
      withdrawn_listed: fromItems.filter((p) => p.state === 'WITHDRAWN_AT_SOURCE' && listed.has(p.handle)).length,
      media_product_gone: withFailures.length - carried.length,
      media_already_retried: carried.length - media.length,
    },
  };
}

// ---------------------------------------------------------------- the run checks

/** The closed run a delta reads: an earlier run, closed or partial (never the delta itself, never an open one). */
export async function assertFromRun(db: D1Database, run: ImportRun, fromRun: unknown): Promise<string> {
  if (typeof fromRun !== 'string' || !RUN_ID.test(fromRun) || fromRun === run.id) throw new OpsRefusal(409, 'IMPORT_DELTA_REFUSED', [run.id]);
  const row = await db.prepare('SELECT state FROM catalog_import_runs WHERE id = ?').bind(fromRun).first<{ state: string }>();
  if (!row || (row.state !== 'closed' && row.state !== 'partial')) throw new OpsRefusal(409, 'IMPORT_DELTA_REFUSED', [run.id]);
  return fromRun;
}

/** The SQL condition of a delta item (its reserved discovery source); a superset that deltaMarkOf narrows. */
export const DELTA_ITEM_SQL = `(discovery_sources LIKE '%"${DELTA_NEW}"%' OR discovery_sources LIKE '%"${MEDIA_RETRY}%' OR discovery_sources LIKE '%"${CONTENT_MEDIA}%')`;
const DELTA_LIKE = DELTA_ITEM_SQL;

/** Outcomes a later delta may do better on: the product was hidden, a fetch failed again, the page read as another product. */
const PASSING_OUTCOMES = ['product_not_public', 'not_stored', 'identity_changed'] as const;

/**
 * Pure: whether an earlier delta's media item settled what it retried, from its state and the checkpoint its attach
 * batch wrote (`stage_data.media_retry`: counts and the rows and swatches it attached).
 *
 *   - It attached something: settled, COMPLETE or not (BLOCKED at VERIFY, its run closed partial). Its pictures went
 *     in; one the owner removed since must never come back, and a removed swatch leaves no trace to tell (an image
 *     row leaves its source ref: mediaRetry.ts counts that one `owner_removed` all the same).
 *   - It attached nothing and completed: settled unless a medium was left for a passing reason (the product hidden,
 *     a fetch failed again, the page read as another product) — those a later delta takes again.
 *   - Anything else (never reached its attach, or attached nothing and stopped): not settled.
 */
export function retrySettled(state: string, stageData: unknown): boolean {
  let data: unknown;
  try {
    data = typeof stageData === 'string' ? JSON.parse(stageData || '{}') : stageData;
  } catch {
    return false;
  }
  const m = data && typeof data === 'object' ? (data as Record<string, unknown>).media_retry : null;
  if (!m || typeof m !== 'object') return false;
  const rec = m as Record<string, unknown>;
  const attached = (Array.isArray(rec.rows) ? rec.rows.length : 0) + (Array.isArray(rec.swatches) ? rec.swatches.length : 0);
  if (attached > 0) return true;
  if (state !== 'COMPLETE') return false;
  const counts = rec.counts && typeof rec.counts === 'object' ? (rec.counts as Record<string, unknown>) : {};
  return PASSING_OUTCOMES.every((k) => !(Number(counts[k]) > 0));
}

/**
 * The source ids an earlier delta run (any run but `runId`) already settled as a media item of `fromRun`
 * (`retrySettled`): a later delta from the same closed run never queues them again. A media item such a run left
 * before its attach (BLOCKED, never reached), or one that attached nothing for a passing reason, is not here: a later
 * delta retries it.
 */
async function retriedElsewhere(db: D1Database, runId: string, fromRun: string, sids?: readonly string[]): Promise<Set<string>> {
  const { results } = await db
    .prepare(
      `SELECT source_product_id, discovery_sources, processing_state, stage_data FROM catalog_import_items
        WHERE run_id <> ?1 AND discovery_sources LIKE ?2
          AND (?3 IS NULL OR source_product_id IN (SELECT value FROM json_each(?3)))`
    )
    .bind(runId, `%"${MEDIA_RETRY}${fromRun}"%`, sids ? JSON.stringify(sids) : null)
    .all<{ source_product_id: string; discovery_sources: string; processing_state: string; stage_data: string }>();
  const out = new Set<string>();
  for (const r of results ?? []) {
    const mark = deltaMarkOf(r.discovery_sources);
    if (mark?.kind === 'media' && mark.fromRun === fromRun && retrySettled(r.processing_state, r.stage_data)) out.add(String(r.source_product_id));
  }
  return out;
}

// ---------------------------------------------------------------- the content pass: settlement and queue (pure)

/** The roles of the content pass (§O.6): a picture of the description, a picture of an in-the-box item. */
export const CONTENT_ROLES: ReadonlySet<string> = new Set(['description', 'in_the_box']);

/** What became of one failed description or in-the-box picture (contentMedia.ts; counts in answers, events, reports). */
export const CONTENT_OUTCOMES = [
  /** The block was inserted, or at least one occurrence of the box item got its key. */
  'attached',
  /** The block id or the key is already where the import meant it. */
  'already_present',
  /** An earlier content pass put it in and the field no longer holds it: never put back. */
  'owner_removed',
  /** The field is not as the import wrote it (any language, its translation records, its meta): left untouched. */
  'owner_edited',
  /** The import never wrote that field or row (a merge that kept the owner's own; a curated or unmerged box row). */
  'not_imported',
  /** The store page changed since the import: nothing proves the positions. */
  'source_changed',
  /** The rebuilt payload no longer shows it. */
  'not_on_page',
  /** The fetch failed again, or R2 does not hold the object as WebP at the attach. */
  'not_stored',
  /** The product is hidden or gone. */
  'product_not_public',
  /** The page no longer reads as this product (moot). */
  'identity_changed',
  /** The store page is gone (moot): nothing written, a later pass takes it again. */
  'source_gone',
] as const;
export type ContentOutcome = (typeof CONTENT_OUTCOMES)[number];

/** Outcomes a later content pass takes again (a passing condition). */
export const CONTENT_PASSING: ReadonlySet<string> = new Set(['not_stored', 'product_not_public', 'identity_changed', 'source_gone']);
/** Outcomes that wrote, found, or must never be undone: settled under every rule. */
export const CONTENT_FINAL: ReadonlySet<string> = new Set(['attached', 'already_present', 'owner_removed']);
/**
 * The rule by which the content pass proves a field "as the import wrote it" (recorded in every checkpoint). A
 * non-writing terminal outcome (owner_edited, not_imported, source_changed, not_on_page) recorded under an OLDER rule
 * settles nothing: a corrected proof may take it again. CONTENT_FINAL outcomes are settled whatever the rule.
 */
export const CONTENT_RULE = 1;

/**
 * Pure: the media ids an earlier content item settled, from its checkpoint (`stage_data.content_media`: `rule`, and
 * `media`, outcome by medium id). A passing outcome settles nothing; an outcome this code does not know is settled
 * (never taken again: the safe direction).
 */
export function contentSettledIds(stageData: unknown, rule = CONTENT_RULE): Set<string> {
  let data: unknown;
  try {
    data = typeof stageData === 'string' ? JSON.parse(stageData || '{}') : stageData;
  } catch {
    return new Set();
  }
  const c = data && typeof data === 'object' ? (data as Record<string, unknown>).content_media : null;
  if (!c || typeof c !== 'object' || Array.isArray(c)) return new Set();
  const rec = c as Record<string, unknown>;
  const media = rec.media && typeof rec.media === 'object' && !Array.isArray(rec.media) ? (rec.media as Record<string, unknown>) : {};
  const at = Number(rec.rule) || 0;
  const out = new Set<string>();
  for (const [id, o] of Object.entries(media)) {
    const outcome = typeof o === 'string' ? o : '';
    if (CONTENT_PASSING.has(outcome)) continue;
    // A known non-writing outcome of an older rule is taken again; a code this rule does not know stays settled.
    if (at < rule && !CONTENT_FINAL.has(outcome) && (CONTENT_OUTCOMES as readonly string[]).includes(outcome)) continue;
    out.add(id);
  }
  return out;
}

/**
 * The media ids of each source product that content items of OTHER runs (`content_media:<fromRun>`, in any state)
 * settled. An item that stopped before its attach has no checkpoint and settles nothing.
 */
export async function contentSettledElsewhere(db: D1Database, runId: string, fromRun: string, sids?: readonly string[]): Promise<Map<string, Set<string>>> {
  const { results } = await db
    .prepare(
      `SELECT source_product_id, discovery_sources, stage_data FROM catalog_import_items
        WHERE run_id <> ?1 AND discovery_sources LIKE ?2
          AND (?3 IS NULL OR source_product_id IN (SELECT value FROM json_each(?3)))`
    )
    .bind(runId, `%"${CONTENT_MEDIA}${fromRun}"%`, sids ? JSON.stringify(sids) : null)
    .all<{ source_product_id: string; discovery_sources: string; stage_data: string }>();
  const out = new Map<string, Set<string>>();
  for (const r of results ?? []) {
    const mark = deltaMarkOf(r.discovery_sources);
    if (mark?.kind !== 'content' || mark.fromRun !== fromRun) continue;
    const sid = String(r.source_product_id);
    const set = out.get(sid) ?? new Set<string>();
    for (const id of contentSettledIds(r.stage_data)) set.add(id);
    out.set(sid, set);
  }
  return out;
}

/** An item of the closed run, as the content queue reads it. */
export interface ContentFromItem {
  source_product_id: string;
  handle: string;
  state: string;
  queue_position: number;
  levonis_product_id: string;
  /** `none`: an ordinary item; `new`: a delta's new product (it wrote its product); anything else wrote none. */
  kind: DeltaDoorKind;
  /** stage_data.written.content_blocks is recorded (the count the write's description held). */
  written_recorded: boolean;
}

export interface ContentFailed {
  source_product_id: string;
  source_media_id: string;
  role: string;
  error_code: string;
}

export interface ContentQueueInput {
  items: readonly ContentFromItem[];
  /** The closed run's failed media of the two content roles. */
  failed: readonly ContentFailed[];
  /** The product each source id is carried by NOW (product_source_refs joined to an existing product). */
  liveProductBySid: ReadonlyMap<string, string>;
  /** Media ids earlier content items settled, by source id (contentSettledElsewhere). */
  settled: ReadonlyMap<string, ReadonlySet<string>>;
  /** The reviewed manifest holds the source id (a delta's new product needs none: the Worker registered its row). */
  reviewed: (sid: string) => boolean;
}

export interface ContentQueue {
  content: Array<{ source_product_id: string; handle: string; failed: number }>;
  counts: {
    /** Every failed description and in-the-box medium of the closed run: the sum of the five parts below. */
    content_failed_total: number;
    content_items: number;
    /** Failed media queued (unsettled, of queued items), and their split by role. */
    content_failed: number;
    content_failed_description: number;
    content_failed_in_the_box: number;
    /** Of items that are not COMPLETE, or that wrote no product (an earlier delta's media or content items). */
    content_failed_not_complete: number;
    /** Of COMPLETE items whose product is gone (deleted, or no longer carrying the source): items and media. */
    media_product_gone: number;
    content_failed_product_gone: number;
    /** Of items the reviewed manifest does not hold: items and media. */
    content_not_reviewed: number;
    content_failed_not_reviewed: number;
    /** Media an earlier content item settled; items with nothing left. */
    content_failed_settled: number;
    content_already_settled: number;
    /** Queued items whose closed item did not record its description's count (their description gets a non-writing code). */
    content_items_unrecorded: number;
  };
  /** The queued failures by error code (codes only). */
  failed_by_error: Record<string, number>;
}

/**
 * Pure: the content queue — the closed run's COMPLETE items that wrote a product (an ordinary item, or a delta's new
 * product), carried by that product, in the reviewed manifest (a new product is registered, not reviewed), with at
 * least one failed description or in-the-box medium no earlier content item settled. Every failed medium is counted
 * in exactly one part (the open report reconciles them against `content_failed_total`).
 */
export function contentQueue(input: ContentQueueInput): ContentQueue {
  const bySid = new Map<string, ContentFailed[]>();
  for (const f of input.failed) {
    if (!CONTENT_ROLES.has(f.role)) continue;
    bySid.set(f.source_product_id, [...(bySid.get(f.source_product_id) ?? []), f]);
  }
  const counts: ContentQueue['counts'] = {
    content_failed_total: [...bySid.values()].reduce((n, l) => n + l.length, 0),
    content_items: 0,
    content_failed: 0,
    content_failed_description: 0,
    content_failed_in_the_box: 0,
    content_failed_not_complete: 0,
    media_product_gone: 0,
    content_failed_product_gone: 0,
    content_not_reviewed: 0,
    content_failed_not_reviewed: 0,
    content_failed_settled: 0,
    content_already_settled: 0,
    content_items_unrecorded: 0,
  };
  const failedByError: Record<string, number> = {};
  const content: ContentQueue['content'] = [];
  const itemOf = new Map(input.items.map((i) => [i.source_product_id, i]));
  const ordered = [...bySid.keys()].sort((a, b) => (itemOf.get(a)?.queue_position ?? Infinity) - (itemOf.get(b)?.queue_position ?? Infinity) || (a < b ? -1 : 1));
  for (const sid of ordered) {
    const list = bySid.get(sid)!;
    const item = itemOf.get(sid);
    if (!item || item.state !== 'COMPLETE' || (item.kind !== 'none' && item.kind !== 'new') || !item.levonis_product_id) {
      counts.content_failed_not_complete += list.length;
      continue;
    }
    if (input.liveProductBySid.get(sid) !== item.levonis_product_id) {
      counts.media_product_gone++;
      counts.content_failed_product_gone += list.length;
      continue;
    }
    if (item.kind === 'none' && !input.reviewed(sid)) {
      counts.content_not_reviewed++;
      counts.content_failed_not_reviewed += list.length;
      continue;
    }
    const settled = input.settled.get(sid);
    const open = list.filter((f) => !settled?.has(f.source_media_id));
    counts.content_failed_settled += list.length - open.length;
    if (!open.length) {
      counts.content_already_settled++;
      continue;
    }
    content.push({ source_product_id: sid, handle: item.handle, failed: open.length });
    counts.content_items++;
    counts.content_failed += open.length;
    if (!item.written_recorded) counts.content_items_unrecorded++;
    for (const f of open) {
      if (f.role === 'description') counts.content_failed_description++;
      else counts.content_failed_in_the_box++;
      const code = /^[A-Z][A-Z0-9_]{1,63}$/.test(f.error_code) ? f.error_code : 'UNCLASSIFIED';
      failedByError[code] = (failedByError[code] ?? 0) + 1;
    }
  }
  return { content, counts, failed_by_error: failedByError };
}

/** The parts of a content queue's failures (every failed medium in exactly one): their sum is `content_failed_total`. */
export const contentPartsOf = (c: ContentQueue['counts']): number =>
  c.content_failed + c.content_failed_not_complete + c.content_failed_product_gone + c.content_failed_not_reviewed + c.content_failed_settled;

// ---------------------------------------------------------------- /delta/plan

export interface ContentPlanAnswer {
  from_run: string;
  pass: 'content';
  new_handles: string[];
  media: DeltaQueue['media'];
  content: ContentQueue['content'];
  counts: ContentQueue['counts'];
  failed_by_error: Record<string, number>;
}

/**
 * POST /delta/plan `{from_run, pass: 'content'}` (§O.6): the content queue. Reads only; no sitemap (`sitemap_handles`
 * absent or empty). Source ids and public store handles of the closed run, counts and error codes.
 */
export async function contentDeltaPlan(db: D1Database, run: ImportRun, body: Record<string, unknown>, bundle: Pick<ReviewedBundle, 'manifest'>): Promise<ContentPlanAnswer> {
  const fromRun = await assertFromRun(db, run, body.from_run);
  if (body.sitemap_handles !== undefined && !(Array.isArray(body.sitemap_handles) && body.sitemap_handles.length === 0)) throw new OpsRefusal(400, 'IMPORT_BAD_REQUEST');
  const { results: items } = await db
    .prepare(
      `SELECT source_product_id, handle, processing_state AS state, queue_position, levonis_product_id, discovery_sources,
              json_type(CASE WHEN json_valid(stage_data) THEN stage_data ELSE '{}' END, '$.written.content_blocks') AS written_type
         FROM catalog_import_items WHERE run_id = ?`
    )
    .bind(fromRun)
    .all<{ source_product_id: string; handle: string; state: string; queue_position: number; levonis_product_id: string; discovery_sources: string; written_type: string | null }>();
  const { results: failed } = await db
    .prepare(
      `SELECT source_product_id, source_media_id, role, error_code FROM catalog_import_media
        WHERE run_id = ? AND status = 'failed' AND role IN ('description','in_the_box')`
    )
    .bind(fromRun)
    .all<ContentFailed>();
  const { results: live } = await db
    .prepare(
      `SELECT r.source_product_id, r.product_id FROM product_source_refs r JOIN products p ON p.id = r.product_id
        WHERE r.source = 'bambu_us' AND r.match_kind IN ('created','merged')
          AND r.source_product_id IN (SELECT source_product_id FROM catalog_import_items WHERE run_id = ? AND processing_state = 'COMPLETE')`
    )
    .bind(fromRun)
    .all<{ source_product_id: string; product_id: string }>();
  const q = contentQueue({
    items: (items ?? []).map((i) => ({
      source_product_id: String(i.source_product_id),
      handle: i.handle,
      state: i.state,
      queue_position: Number(i.queue_position),
      levonis_product_id: String(i.levonis_product_id ?? ''),
      kind: deltaDoorKindOf(i.discovery_sources),
      written_recorded: i.written_type === 'integer' || i.written_type === 'real',
    })),
    failed: (failed ?? []).map((f) => ({ ...f, source_product_id: String(f.source_product_id) })),
    liveProductBySid: new Map((live ?? []).map((r) => [String(r.source_product_id), String(r.product_id)])),
    settled: await contentSettledElsewhere(db, run.id, fromRun),
    reviewed: (sid) => bundle.manifest.bySourceId.has(sid),
  });
  return { from_run: fromRun, pass: 'content', new_handles: [], media: [], content: q.content, counts: q.counts, failed_by_error: q.failed_by_error };
}

/**
 * POST /delta/plan `{from_run, sitemap_handles}`: what the delta queue would hold. Reads only. The handles answered
 * are the runner's own sitemap read, the media items source ids of the closed run (public store products). The
 * content pass (`pass: 'content'`) is contentDeltaPlan's.
 */
export async function deltaPlan(
  db: D1Database,
  run: ImportRun,
  body: Record<string, unknown>,
  bundle: Pick<ReviewedBundle, 'manifest'>
): Promise<{ from_run: string; new_handles: string[]; media: DeltaQueue['media']; counts: DeltaQueue['counts'] & { media_not_reviewed: number } }> {
  // The content pass has its own plan (the route sends `pass: 'content'` to contentDeltaPlan); nothing else is a pass.
  if (body.pass !== undefined) throw new OpsRefusal(400, 'IMPORT_BAD_REQUEST');
  const fromRun = await assertFromRun(db, run, body.from_run);
  const raw = body.sitemap_handles;
  if (!Array.isArray(raw) || raw.length > SITEMAP_HANDLES_MAX || !raw.every((h) => typeof h === 'string' && h.length > 0 && h.length <= 300)) {
    throw new OpsRefusal(400, 'IMPORT_BAD_REQUEST');
  }
  const { results: prior } = await db
    .prepare('SELECT run_id, source_product_id, handle, processing_state AS state, queue_position, levonis_product_id FROM catalog_import_items WHERE run_id <> ?')
    .bind(run.id)
    .all<PriorItem>();
  const { results: failed } = await db
    .prepare("SELECT source_product_id AS sid, COUNT(*) AS n FROM catalog_import_media WHERE run_id = ? AND status = 'failed' GROUP BY source_product_id")
    .bind(fromRun)
    .all<{ sid: string; n: number }>();
  const { results: refHandles } = await db
    .prepare("SELECT source_handle FROM product_source_refs WHERE source = 'bambu_us' AND source_handle <> ''")
    .all<{ source_handle: string }>();
  const { results: live } = await db
    .prepare(
      `SELECT r.source_product_id, r.product_id FROM product_source_refs r JOIN products p ON p.id = r.product_id
        WHERE r.source = 'bambu_us' AND r.match_kind IN ('created','merged')
          AND r.source_product_id IN (SELECT source_product_id FROM catalog_import_items WHERE run_id = ? AND processing_state = 'COMPLETE')`
    )
    .bind(fromRun)
    .all<{ source_product_id: string; product_id: string }>();
  const q = deltaQueue({
    listedHandles: raw as string[],
    prior: (prior ?? []).map((p) => ({ ...p, source_product_id: String(p.source_product_id), queue_position: Number(p.queue_position), levonis_product_id: String(p.levonis_product_id ?? '') })),
    fromRun,
    failedBySid: new Map((failed ?? []).map((f) => [String(f.sid), Number(f.n)])),
    knownHandles: [...(refHandles ?? []).map((r) => String(r.source_handle)), ...bundle.manifest.byHandle.keys()],
    liveProductBySid: new Map((live ?? []).map((r) => [String(r.source_product_id), String(r.product_id)])),
    alreadyRetried: await retriedElsewhere(db, run.id, fromRun),
  });
  // A media item is rebuilt from its REVIEWED manifest row (/delta/manifest refuses any other): one the bundle does
  // not hold (a new product of an earlier delta) is counted, not queued.
  const media = q.media.filter((m) => bundle.manifest.bySourceId.has(m.source_product_id));
  return { from_run: fromRun, new_handles: q.newHandles, media, counts: { ...q.counts, media_items: media.length, media_failed: media.reduce((n, m) => n + m.failed, 0), media_not_reviewed: q.media.length - media.length } };
}

// ---------------------------------------------------------------- /delta/manifest

export interface DeltaRowIn {
  kind: DeltaKind;
  source_product_id: string;
  handle?: string;
  route?: string;
  discovered_at: string;
}

/** The rows /delta/manifest leaves out, by reason (counts only). */
export interface DeltaSkipped {
  /** A new row whose source id or handle an earlier run's item holds, a product carries or the reviewed manifest names
   *  (a store handle renamed: the new handle reads as new, the page gives the source id an earlier run held). */
  known: number;
  /** A media row whose product is gone: deleted since the closed run, or no longer carrying the source. */
  media_product_gone: number;
  /** A media row an earlier delta run already settled (`retrySettled`). */
  media_already_retried: number;
  /** A content row whose every failed description and in-the-box medium an earlier content item settled. */
  content_already_settled: number;
}

/**
 * POST /delta/manifest `{from_run, rows}` (≤ 100 rows). Each row is checked against D1 and the bundle:
 *
 *   media  a COMPLETE item of `from_run` with a product and at least one failed medium, in the reviewed manifest;
 *   new    a well-formed handle and route; at most DELTA_NEW_MAX a run.
 *
 *   content  a COMPLETE item of `from_run` that wrote its product (an ordinary item, or a delta's new product) with at
 *          least one failed description or in-the-box medium, in the reviewed manifest (a new product: its registered
 *          row, copied from the closed item);
 *
 * A row that breaks one of those, or a run that holds anything but delta items (of the same closed run), refuses the
 * whole call (IMPORT_DELTA_REFUSED; the answer names no input). A run that holds content items takes content rows of
 * the same closed run only, and a run that holds anything else takes none (§O.6). A row the store or the owner made moot since the plan
 * is LEFT OUT and counted (`skipped`), never refused — a refusal would take every other row of the call with it and
 * stop every later delta the same way: a new row whose source id or handle is already held (an earlier run's item, a
 * product's source ref, the reviewed manifest: spec §O.2 "by handle; then by source id"), a media row whose product
 * is gone, or that an earlier delta already settled. A row already registered keeps its position; a new one takes
 * the next. Discovery fields change only while the item is DISCOVERED.
 */
export async function acceptDeltaRows(
  db: D1Database,
  run: ImportRun,
  bundle: ReviewedBundle,
  body: Record<string, unknown>
): Promise<{ accepted: number; new: number; media: number; content: number; skipped: DeltaSkipped }> {
  const fromRun = await assertFromRun(db, run, body.from_run);
  const rows = body.rows;
  if (!Array.isArray(rows) || rows.length > 100) throw new OpsRefusal(400, 'IMPORT_BAD_REQUEST');
  const refuse = () => new OpsRefusal(409, 'IMPORT_DELTA_REFUSED', [run.id]);
  const parsed: DeltaRowIn[] = rows.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new OpsRefusal(400, 'IMPORT_BAD_REQUEST');
    const r = raw as Record<string, unknown>;
    const kind = r.kind === 'new' || r.kind === 'media' || r.kind === 'content' ? r.kind : null;
    const sid = typeof r.source_product_id === 'string' && SID.test(r.source_product_id) ? r.source_product_id : '';
    const at = typeof r.discovered_at === 'string' && ISOISH.test(r.discovered_at) ? r.discovered_at : '';
    if (!kind || !sid || !at) throw new OpsRefusal(400, 'IMPORT_BAD_REQUEST');
    if (kind === 'new') {
      const handle = typeof r.handle === 'string' ? r.handle.normalize('NFC') : '';
      const route = typeof r.route === 'string' ? r.route : '';
      if (!DELTA_HANDLE.test(handle) || !DELTA_ROUTE.test(route)) throw new OpsRefusal(400, 'IMPORT_BAD_REQUEST');
      return { kind, source_product_id: sid, handle, route, discovered_at: at };
    }
    return { kind, source_product_id: sid, discovered_at: at };
  });
  if (new Set(parsed.map((r) => r.source_product_id)).size !== parsed.length) throw new OpsRefusal(400, 'IMPORT_BAD_REQUEST');
  const skipped: DeltaSkipped = { known: 0, media_product_gone: 0, media_already_retried: 0, content_already_settled: 0 };
  if (!parsed.length) return { accepted: 0, new: 0, media: 0, content: 0, skipped };

  // The run: delta items only, all of this closed run.
  const { results: mine } = await db
    .prepare('SELECT source_product_id, queue_position, processing_state, discovery_sources FROM catalog_import_items WHERE run_id = ?')
    .bind(run.id)
    .all<{ source_product_id: string; queue_position: number; processing_state: string; discovery_sources: string }>();
  const own = new Map<string, { position: number; state: string; mark: DeltaMark | null }>();
  for (const m of mine ?? []) {
    const mark = deltaMarkOf(m.discovery_sources);
    if (!mark || deltaDoorKindOf(m.discovery_sources) === 'unknown' || (mark.kind !== 'new' && mark.fromRun !== fromRun)) throw refuse();
    own.set(String(m.source_product_id), { position: Number(m.queue_position), state: m.processing_state, mark });
  }
  // A content run is a run of its own: content items only, of one closed run (the kinds never mix in one run).
  const ownContent = [...own.values()].some((o) => o.mark?.kind === 'content');
  const ownOther = [...own.values()].some((o) => o.mark?.kind !== 'content');
  const rowsContent = parsed.some((r) => r.kind === 'content');
  const rowsOther = parsed.some((r) => r.kind !== 'content');
  if ((rowsContent && (rowsOther || ownOther)) || (rowsOther && ownContent)) throw refuse();
  const sids = parsed.map((r) => r.source_product_id);
  const handles = parsed.flatMap((r) => (r.handle ? [r.handle] : []));
  // Earlier runs: the closed run's own items (media rows), and whether any run ever held a new row's id or handle.
  const { results: earlier } = await db
    .prepare(
      `SELECT run_id, source_product_id, handle, processing_state, levonis_product_id, canonical_url, product_type, breadcrumbs, discovery_sources FROM catalog_import_items
        WHERE run_id <> ?1 AND (source_product_id IN (SELECT value FROM json_each(?2)) OR handle IN (SELECT value FROM json_each(?3)))`
    )
    .bind(run.id, JSON.stringify(sids), JSON.stringify(handles))
    .all<{
      run_id: string;
      source_product_id: string;
      handle: string;
      processing_state: string;
      levonis_product_id: string;
      canonical_url: string;
      product_type: string;
      breadcrumbs: string;
      discovery_sources: string;
    }>();
  const { results: failed } = await db
    .prepare(
      `SELECT source_product_id AS sid, COUNT(*) AS n FROM catalog_import_media
        WHERE run_id = ? AND status = 'failed' AND source_product_id IN (SELECT value FROM json_each(?)) GROUP BY source_product_id`
    )
    .bind(fromRun, JSON.stringify(sids))
    .all<{ sid: string; n: number }>();
  const failedBy = new Map((failed ?? []).map((f) => [String(f.sid), Number(f.n)]));
  // A content row's failed media of the two content roles (each id, for the settlement test).
  const contentSids = parsed.filter((r) => r.kind === 'content').map((r) => r.source_product_id);
  const contentFailed = new Map<string, string[]>();
  if (contentSids.length) {
    const { results } = await db
      .prepare(
        `SELECT source_product_id AS sid, source_media_id FROM catalog_import_media
          WHERE run_id = ? AND status = 'failed' AND role IN ('description','in_the_box') AND source_product_id IN (SELECT value FROM json_each(?))`
      )
      .bind(fromRun, JSON.stringify(contentSids))
      .all<{ sid: string; source_media_id: string }>();
    for (const f of results ?? []) contentFailed.set(String(f.sid), [...(contentFailed.get(String(f.sid)) ?? []), String(f.source_media_id)]);
  }
  // The source refs: whether a product carries a new row's id or handle, and whether a media row's product (the one
  // the closed run wrote) still exists and still carries its source — /media-plan's own test (mediaRetry.ts).
  const { results: refs } = await db
    .prepare(
      `SELECT r.source_product_id, r.source_handle, r.product_id, r.match_kind, p.id AS live_id FROM product_source_refs r LEFT JOIN products p ON p.id = r.product_id
        WHERE r.source = 'bambu_us' AND (r.source_product_id IN (SELECT value FROM json_each(?1)) OR r.source_handle IN (SELECT value FROM json_each(?2)))`
    )
    .bind(JSON.stringify(sids), JSON.stringify(handles))
    .all<{ source_product_id: string; source_handle: string; product_id: string; match_kind: string; live_id: string | null }>();
  const mediaSids = parsed.filter((r) => r.kind === 'media' && !own.has(r.source_product_id)).map((r) => r.source_product_id);
  const retried = mediaSids.length ? await retriedElsewhere(db, run.id, fromRun, mediaSids) : new Set<string>();
  const freshContent = contentSids.filter((sid) => !own.has(sid));
  const contentSettled = freshContent.length ? await contentSettledElsewhere(db, run.id, fromRun, freshContent) : new Map<string, Set<string>>();

  const values: unknown[][] = [];
  let next = Math.max(0, ...[...own.values()].map((o) => o.position)) + 1;
  let newCount = [...own.values()].filter((o) => o.mark?.kind === 'new').length;
  let nNew = 0;
  let nMedia = 0;
  let nContent = 0;
  for (const r of parsed) {
    const sid = r.source_product_id;
    const mineNow = own.get(sid);
    if (mineNow && mineNow.mark?.kind !== r.kind) throw refuse();
    let handle: string;
    let canonical: string;
    let type: string;
    let route = '';
    if (r.kind === 'content') {
      // The closed run's item that WROTE the product: an ordinary item (its reviewed row), or a delta's new product
      // (its registered row, copied: handle, address, type and the store route its manifest row was built from).
      const from = (earlier ?? []).find((e) => e.run_id === fromRun && String(e.source_product_id) === sid);
      const fromKind = from ? deltaDoorKindOf(from.discovery_sources) : 'unknown';
      const reviewed = bundle.manifest.bySourceId.get(sid);
      if (
        !from ||
        from.processing_state !== 'COMPLETE' ||
        !from.levonis_product_id ||
        !(contentFailed.get(sid) ?? []).length ||
        !((fromKind === 'none' && reviewed) || fromKind === 'new')
      ) {
        throw refuse();
      }
      if (!mineNow) {
        const carried = (refs ?? []).some(
          (x) => String(x.source_product_id) === sid && !!x.live_id && x.product_id === from.levonis_product_id && (x.match_kind === 'created' || x.match_kind === 'merged')
        );
        if (!carried) {
          skipped.media_product_gone++;
          continue;
        }
        const settled = contentSettled.get(sid);
        if ((contentFailed.get(sid) ?? []).every((id) => settled?.has(id))) {
          skipped.content_already_settled++;
          continue;
        }
      }
      if (reviewed && fromKind === 'none') {
        handle = reviewed.handle;
        canonical = reviewed.canonical_url;
        type = reviewed.type;
      } else {
        handle = from.handle;
        canonical = from.canonical_url;
        type = from.product_type;
        route = DELTA_ROUTE.test(from.breadcrumbs) ? from.breadcrumbs : '';
        if (!DELTA_HANDLE.test(handle) || !route) throw refuse();
      }
      nContent++;
    } else if (r.kind === 'media') {
      const from = (earlier ?? []).find((e) => e.run_id === fromRun && String(e.source_product_id) === sid);
      const reviewed = bundle.manifest.bySourceId.get(sid);
      if (!from || from.processing_state !== 'COMPLETE' || !from.levonis_product_id || (failedBy.get(sid) ?? 0) <= 0 || !reviewed) throw refuse();
      if (!mineNow) {
        const carried = (refs ?? []).some(
          (x) => String(x.source_product_id) === sid && !!x.live_id && x.product_id === from.levonis_product_id && (x.match_kind === 'created' || x.match_kind === 'merged')
        );
        if (!carried) {
          skipped.media_product_gone++;
          continue;
        }
        if (retried.has(sid)) {
          skipped.media_already_retried++;
          continue;
        }
      }
      handle = reviewed.handle;
      canonical = reviewed.canonical_url;
      type = reviewed.type;
      nMedia++;
    } else {
      handle = r.handle!;
      route = r.route!;
      if (!mineNow) {
        const seen = (earlier ?? []).some((e) => String(e.source_product_id) === sid || e.handle === handle);
        const carried = (refs ?? []).some((x) => String(x.source_product_id) === sid || x.source_handle === handle);
        if (seen || carried || bundle.manifest.bySourceId.has(sid) || bundle.manifest.byHandle.has(handle)) {
          skipped.known++;
          continue;
        }
        if (++newCount > DELTA_NEW_MAX) throw refuse();
      }
      canonical = `${STORE_PRODUCTS}${encodeURIComponent(handle)}`;
      type = productTypeOf(route);
      nNew++;
    }
    const position = mineNow ? mineNow.position : next++;
    values.push([
      `cii_${H(`${run.id}:bambu_us:${sid}`)}`, run.id, sid, handle, canonical, type, position, 0, '',
      '[]', route, JSON.stringify(deltaSources(r.kind, fromRun)), r.discovered_at,
    ]);
  }
  // An item that already left DISCOVERED is not written again (trg_cii_insert refuses an insert over it).
  const fresh = values.filter((v) => (own.get(String(v[2]))?.state ?? 'DISCOVERED') === 'DISCOVERED');
  if (fresh.length) {
    await db.batch(
      packedInserts(
        db,
        `INSERT INTO catalog_import_items (id, run_id, source, source_product_id, handle, canonical_url, product_type, queue_position, curated_scope, hold_code,
            source_collections, breadcrumbs, discovery_sources, discovered_at)`,
        "(?, ?, 'bambu_us', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        fresh,
        `ON CONFLICT (run_id, source, source_product_id) DO UPDATE SET discovered_at = excluded.discovered_at, updated_at = ${NOW_SQL}
          WHERE catalog_import_items.processing_state = 'DISCOVERED'`
      )
    );
  }
  return { accepted: values.length, new: nNew, media: nMedia, content: nContent, skipped };
}

// ---------------------------------------------------------------- the run's delta rows and the bundle they extend

export interface DeltaRow {
  kind: DeltaKind;
  from_run: string;
  source_product_id: string;
  handle: string;
  canonical_url: string;
  type: string;
  route: string;
  queue_position: number;
}

/** The delta items of a run (none for an ordinary run). One statement. */
export async function deltaRowsOf(db: D1Database, runId: string): Promise<DeltaRow[]> {
  const { results } = await db
    .prepare(
      `SELECT source_product_id, handle, canonical_url, product_type, queue_position, breadcrumbs, discovery_sources
         FROM catalog_import_items WHERE run_id = ? AND ${DELTA_LIKE} ORDER BY queue_position`
    )
    .bind(runId)
    .all<{ source_product_id: string; handle: string; canonical_url: string; product_type: string; queue_position: number; breadcrumbs: string; discovery_sources: string }>();
  const out: DeltaRow[] = [];
  for (const r of results ?? []) {
    const mark = deltaMarkOf(r.discovery_sources);
    if (!mark) continue;
    out.push({
      kind: mark.kind,
      from_run: mark.fromRun,
      source_product_id: String(r.source_product_id),
      handle: r.handle,
      canonical_url: r.canonical_url,
      type: r.product_type,
      // A new product's store route; a content item of a delta's new product carries the one its row was built from.
      route: mark.kind === 'new' || mark.kind === 'content' ? r.breadcrumbs : '',
      queue_position: Number(r.queue_position),
    });
  }
  return out;
}

/**
 * GET /delta/rows: the run's delta items as the runner reads them, a new product's section the reviewed map's
 * resolution of its route (catalog ids: what VERIFY's listing check expects it filed under).
 */
export async function deltaRowsView(db: D1Database, runId: string, bundle: ReviewedBundle): Promise<Array<DeltaRow & { leaf: string; also: string[] }>> {
  return (await deltaRowsOf(db, runId)).map((r) => {
    const tax = r.kind === 'new' || (r.kind === 'content' && r.route) ? taxonomyOfRow(bundle, { handle: r.handle, currentAllIdRoute: r.route }) : null;
    return { ...r, leaf: tax?.primary ?? '', also: tax?.secondaries ?? [] };
  });
}

/** The manifest row of a new product: what the item registered, nothing reviewed beyond the taxonomy map. */
export function deltaManifestRow(r: Pick<DeltaRow, 'source_product_id' | 'handle' | 'canonical_url' | 'type' | 'route' | 'queue_position'>): ManifestRow {
  return {
    queue_position: r.queue_position,
    source: 'bambu_us',
    source_product_id: r.source_product_id,
    handle: r.handle,
    canonical_url: r.canonical_url,
    title: '',
    type: r.type,
    currentAllIdRoute: r.route,
    leaf: '',
    also: [],
    curated: false,
    hold_code: '',
    sku_codes: {},
    value_labels: {},
  };
}

/**
 * The bundle a delta run's calls read: the reviewed bundle plus a manifest row per NEW product of the run. A
 * reviewed row is never replaced; every other reviewed file (the taxonomy map, the matches, the compat targets, the
 * identity map) is the bundled one, untouched.
 */
export function withDeltaRows(bundle: ReviewedBundle, rows: readonly DeltaRow[]): ReviewedBundle {
  const added = rows.filter((r) => r.kind === 'new' && !bundle.manifest.bySourceId.has(r.source_product_id) && !bundle.manifest.byHandle.has(r.handle)).map(deltaManifestRow);
  if (!added.length) return bundle;
  const all = [...bundle.manifest.rows, ...added];
  return {
    ...bundle,
    manifest: {
      rows: all,
      bySourceId: new Map(all.map((r) => [r.source_product_id, r])),
      byHandle: new Map(all.map((r) => [r.handle, r])),
    },
  };
}

/** The run's delta rows read and folded into the bundle (an ordinary run reads one statement and gets the bundle back). */
export async function runBundle(db: D1Database, runId: string, bundle: ReviewedBundle): Promise<ReviewedBundle> {
  return withDeltaRows(bundle, await deltaRowsOf(db, runId));
}

/** What one item of the run is for the doors (`deltaDoorKindOf`: fail closed on a marker this code does not read). */
export async function itemDoorKind(db: D1Database, itemId: string): Promise<DeltaDoorKind> {
  const row = await db.prepare('SELECT discovery_sources FROM catalog_import_items WHERE id = ?').bind(itemId).first<{ discovery_sources: string }>();
  return row ? deltaDoorKindOf(row.discovery_sources) : 'unknown';
}

/** The delta mark of one item of the run (null for an ordinary item). */
export async function itemMark(db: D1Database, itemId: string): Promise<DeltaMark | null> {
  const row = await db.prepare('SELECT discovery_sources FROM catalog_import_items WHERE id = ?').bind(itemId).first<{ discovery_sources: string }>();
  return row ? deltaMarkOf(row.discovery_sources) : null;
}

// ---------------------------------------------------------------- the §E.1 gate for a new product

/**
 * How many Levonis products the §E.1 candidate rule flags for this source product (the rule of the original run's
 * P0 review, matchSignals.ts), over the live catalogue as the original run met it: every product but the ones an
 * import CREATED (each of those carries its own, different source id, and product_source_refs makes a second create
 * of a source impossible). A count only; the candidates themselves stay in D1.
 */
export async function matchCandidateCount(db: D1Database, entry: { source_product_id: string; handle: string; title: string }): Promise<number> {
  const created = `SELECT 1 FROM product_source_refs r WHERE r.product_id = p.id AND r.source = 'bambu_us' AND r.match_kind = 'created'`;
  const { results: products } = await db
    .prepare(`SELECT p.id, p.slug, p.status, p.name, p.brand_id, p.brand FROM products p WHERE NOT EXISTS (${created})`)
    .all<Record<string, unknown>>();
  const { results: brands } = await db.prepare('SELECT id, slug, name_en FROM brands').all<Record<string, unknown>>();
  const { results: sources } = await db
    .prepare(
      `SELECT p.id AS product_id, COUNT(*) AS n FROM product_images i JOIN products p ON p.id = i.product_id
        WHERE (i.source_url LIKE 'https://store.bblcdn.com/%' OR i.source_url LIKE 'https://cdn.shopify.com/%') AND NOT EXISTS (${created})
        GROUP BY p.id`
    )
    .all<{ product_id: string; n: number }>();
  const tables: SnapshotTables = {
    products: products ?? [],
    brands: brands ?? [],
    image_sources: (sources ?? []).map((s) => ({ product_id: s.product_id, source_url: 'https://store.bblcdn.com/' })),
    option_values: [],
    colors: [],
  };
  return matchCandidates(tables, [{ source_product_id: entry.source_product_id, handle: entry.handle, title: entry.title, type: '' }]).filter((p) => p.candidates.length > 0).length;
}

/**
 * §E.1 item 4 for a new product of a delta run: a candidate the reviewed matches file does not list stops the create
 * (REVIEWED_SCOPE_REFUSED) until the owner's reviewed decision (merge, merge_publish, distinct or not_bambu) is
 * committed and deployed. A listed source passes here; the writer's reviewed-scope rules decide the rest.
 */
export async function deltaMatchGate(db: D1Database, bundle: ReviewedBundle, itemId: string, payload: unknown): Promise<void> {
  const p = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const sid = typeof p.source_product_id === 'string' ? p.source_product_id : '';
  const handle = typeof p.handle === 'string' ? p.handle : '';
  const product = p.product && typeof p.product === 'object' ? (p.product as Record<string, unknown>) : {};
  const title = typeof product.title_en === 'string' ? product.title_en : '';
  if (!sid || bundle.matches.bySourceId.has(sid)) return;
  if ((await matchCandidateCount(db, { source_product_id: sid, handle, title })) > 0) {
    throw new OpsRefusal(409, 'IMPORT_REVIEWED_SCOPE_REFUSED', [itemId, 'match_review_needed']);
  }
}
