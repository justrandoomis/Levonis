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
 * The kind is durable on the item: `discovery_sources` carries `delta_new`, or `media_retry:<from run>`. Those
 * markers are reserved: /manifest refuses them, and only /delta/manifest writes them — into a run that holds
 * nothing but delta items. Counts, source ids and public store handles only; never a name, a URL or a price.
 */
import { H } from '@levonis/catalog/bambuImport/hash';
import { productTypeOf } from '@levonis/catalog/bambuImport/registry/types';
import { matchCandidates, type SnapshotTables } from '@levonis/catalog/bambuImport/matchSignals';
import { NOW_SQL, OpsRefusal, type ImportRun } from './auth';
import { packedInserts } from './budget';
import { taxonomyOfRow, type ManifestRow, type ReviewedBundle } from './reviewed';

export const DELTA_NEW = 'delta_new';
export const MEDIA_RETRY = 'media_retry:';
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

export type DeltaKind = 'new' | 'media';
export interface DeltaMark {
  kind: DeltaKind;
  /** The closed run a media item retries (empty for a new product). */
  fromRun: string;
}

/** The discovery sources a delta item is born with. */
export function deltaSources(kind: DeltaKind, fromRun = ''): string[] {
  return kind === 'new' ? ['sitemap', DELTA_NEW] : [`${MEDIA_RETRY}${fromRun}`];
}

/** A reserved discovery source: only /delta/manifest writes one. */
export const isReservedSource = (s: unknown): boolean => typeof s === 'string' && (s === DELTA_NEW || s.startsWith(MEDIA_RETRY));

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
  }
  return list.includes(DELTA_NEW) ? { kind: 'new', fromRun: '' } : null;
}

// ---------------------------------------------------------------- the queue (pure)

/** An item of an earlier run, as the queue construction reads it. */
export interface PriorItem {
  run_id: string;
  source_product_id: string;
  handle: string;
  state: string;
  queue_position: number;
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
  };
}

/**
 * The delta queue: (a) the listed handles absent from every earlier run's items, (b) the COMPLETE items of the closed
 * run whose media failed. A withdrawn or blocked item is neither new nor retried; a completed one without failures
 * is not touched.
 */
export function deltaQueue(input: DeltaQueueInput): DeltaQueue {
  const listed = new Set(input.listedHandles);
  const knownHandles = new Set(input.prior.map((p) => p.handle));
  const fresh = [...listed].filter((h) => !knownHandles.has(h));
  const usable = fresh.filter((h) => DELTA_HANDLE.test(h)).sort();
  const fromItems = input.prior.filter((p) => p.run_id === input.fromRun);
  const media = fromItems
    .filter((p) => p.state === 'COMPLETE' && (input.failedBySid.get(p.source_product_id) ?? 0) > 0)
    .sort((a, b) => a.queue_position - b.queue_position)
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
export const DELTA_ITEM_SQL = `(discovery_sources LIKE '%"${DELTA_NEW}"%' OR discovery_sources LIKE '%"${MEDIA_RETRY}%')`;
const DELTA_LIKE = DELTA_ITEM_SQL;

// ---------------------------------------------------------------- /delta/plan

/**
 * POST /delta/plan `{from_run, sitemap_handles}`: what the delta queue would hold. Reads only. The handles answered
 * are the runner's own sitemap read, the media items source ids of the closed run (public store products).
 */
export async function deltaPlan(
  db: D1Database,
  run: ImportRun,
  body: Record<string, unknown>,
  bundle: Pick<ReviewedBundle, 'manifest'>
): Promise<{ from_run: string; new_handles: string[]; media: DeltaQueue['media']; counts: DeltaQueue['counts'] & { media_not_reviewed: number } }> {
  const fromRun = await assertFromRun(db, run, body.from_run);
  const raw = body.sitemap_handles;
  if (!Array.isArray(raw) || raw.length > SITEMAP_HANDLES_MAX || !raw.every((h) => typeof h === 'string' && h.length > 0 && h.length <= 300)) {
    throw new OpsRefusal(400, 'IMPORT_BAD_REQUEST');
  }
  const { results: prior } = await db
    .prepare('SELECT run_id, source_product_id, handle, processing_state AS state, queue_position FROM catalog_import_items WHERE run_id <> ?')
    .bind(run.id)
    .all<PriorItem>();
  const { results: failed } = await db
    .prepare("SELECT source_product_id AS sid, COUNT(*) AS n FROM catalog_import_media WHERE run_id = ? AND status = 'failed' GROUP BY source_product_id")
    .bind(fromRun)
    .all<{ sid: string; n: number }>();
  const q = deltaQueue({
    listedHandles: raw as string[],
    prior: (prior ?? []).map((p) => ({ ...p, source_product_id: String(p.source_product_id), queue_position: Number(p.queue_position) })),
    fromRun,
    failedBySid: new Map((failed ?? []).map((f) => [String(f.sid), Number(f.n)])),
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

/**
 * POST /delta/manifest `{from_run, rows}` (≤ 100 rows). Each row is checked against D1 and the bundle, or the whole
 * call is refused (IMPORT_DELTA_REFUSED; the answer names no input):
 *
 *   media  a COMPLETE item of `from_run` with a product and at least one failed medium, in the reviewed manifest;
 *   new    a well-formed handle and route, a source id and a handle that no earlier run's item holds, that no
 *          product carries as its source, that the reviewed manifest does not name; at most DELTA_NEW_MAX a run.
 *
 * The run must hold nothing but delta items (of the same closed run). A row already registered keeps its position;
 * a new one takes the next. Discovery fields change only while the item is DISCOVERED.
 */
export async function acceptDeltaRows(db: D1Database, run: ImportRun, bundle: ReviewedBundle, body: Record<string, unknown>): Promise<{ accepted: number; new: number; media: number }> {
  const fromRun = await assertFromRun(db, run, body.from_run);
  const rows = body.rows;
  if (!Array.isArray(rows) || rows.length > 100) throw new OpsRefusal(400, 'IMPORT_BAD_REQUEST');
  const refuse = () => new OpsRefusal(409, 'IMPORT_DELTA_REFUSED', [run.id]);
  const parsed: DeltaRowIn[] = rows.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new OpsRefusal(400, 'IMPORT_BAD_REQUEST');
    const r = raw as Record<string, unknown>;
    const kind = r.kind === 'new' || r.kind === 'media' ? r.kind : null;
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
  if (!parsed.length) return { accepted: 0, new: 0, media: 0 };

  // The run: delta items only, all of this closed run.
  const { results: mine } = await db
    .prepare('SELECT source_product_id, queue_position, processing_state, discovery_sources FROM catalog_import_items WHERE run_id = ?')
    .bind(run.id)
    .all<{ source_product_id: string; queue_position: number; processing_state: string; discovery_sources: string }>();
  const own = new Map<string, { position: number; state: string; mark: DeltaMark | null }>();
  for (const m of mine ?? []) {
    const mark = deltaMarkOf(m.discovery_sources);
    if (!mark || (mark.kind === 'media' && mark.fromRun !== fromRun)) throw refuse();
    own.set(String(m.source_product_id), { position: Number(m.queue_position), state: m.processing_state, mark });
  }
  const sids = parsed.map((r) => r.source_product_id);
  const handles = parsed.flatMap((r) => (r.handle ? [r.handle] : []));
  // Earlier runs: the closed run's own items (media rows), and whether any run ever held a new row's id or handle.
  const { results: earlier } = await db
    .prepare(
      `SELECT run_id, source_product_id, handle, processing_state, levonis_product_id FROM catalog_import_items
        WHERE run_id <> ?1 AND (source_product_id IN (SELECT value FROM json_each(?2)) OR handle IN (SELECT value FROM json_each(?3)))`
    )
    .bind(run.id, JSON.stringify(sids), JSON.stringify(handles))
    .all<{ run_id: string; source_product_id: string; handle: string; processing_state: string; levonis_product_id: string }>();
  const { results: failed } = await db
    .prepare(
      `SELECT source_product_id AS sid, COUNT(*) AS n FROM catalog_import_media
        WHERE run_id = ? AND status = 'failed' AND source_product_id IN (SELECT value FROM json_each(?)) GROUP BY source_product_id`
    )
    .bind(fromRun, JSON.stringify(sids))
    .all<{ sid: string; n: number }>();
  const failedBy = new Map((failed ?? []).map((f) => [String(f.sid), Number(f.n)]));
  const { results: refs } = await db
    .prepare(
      `SELECT source_product_id, source_handle FROM product_source_refs
        WHERE source = 'bambu_us' AND (source_product_id IN (SELECT value FROM json_each(?1)) OR source_handle IN (SELECT value FROM json_each(?2)))`
    )
    .bind(JSON.stringify(sids), JSON.stringify(handles))
    .all<{ source_product_id: string; source_handle: string }>();

  const values: unknown[][] = [];
  let next = Math.max(0, ...[...own.values()].map((o) => o.position)) + 1;
  let newCount = [...own.values()].filter((o) => o.mark?.kind === 'new').length;
  let nNew = 0;
  let nMedia = 0;
  for (const r of parsed) {
    const sid = r.source_product_id;
    const mineNow = own.get(sid);
    if (mineNow && mineNow.mark?.kind !== r.kind) throw refuse();
    let handle: string;
    let canonical: string;
    let type: string;
    let route = '';
    if (r.kind === 'media') {
      const from = (earlier ?? []).find((e) => e.run_id === fromRun && String(e.source_product_id) === sid);
      const reviewed = bundle.manifest.bySourceId.get(sid);
      if (!from || from.processing_state !== 'COMPLETE' || !from.levonis_product_id || (failedBy.get(sid) ?? 0) <= 0 || !reviewed) throw refuse();
      handle = reviewed.handle;
      canonical = reviewed.canonical_url;
      type = reviewed.type;
      nMedia++;
    } else {
      handle = r.handle!;
      route = r.route!;
      const seen = (earlier ?? []).some((e) => String(e.source_product_id) === sid || e.handle === handle);
      const carried = (refs ?? []).some((x) => String(x.source_product_id) === sid || x.source_handle === handle);
      if (seen || carried || bundle.manifest.bySourceId.has(sid) || bundle.manifest.byHandle.has(handle)) throw refuse();
      if (!mineNow && ++newCount > DELTA_NEW_MAX) throw refuse();
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
  return { accepted: values.length, new: nNew, media: nMedia };
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
      route: mark.kind === 'new' ? r.breadcrumbs : '',
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
    const tax = r.kind === 'new' ? taxonomyOfRow(bundle, { handle: r.handle, currentAllIdRoute: r.route }) : null;
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
