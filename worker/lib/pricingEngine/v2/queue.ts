/**
 * PRICING V2 — THE «يحتاج تسعيرًا» QUEUE (the clean start, the owner's answer
 * Q6, DECISIONS row 222; spec addendum A.8). It replaces V2-5's «نقل الأسعار إلى
 * الدولار»: no proposal, no "keep current prices", no bulk publish — every
 * product is opened, reviewed in the one sheet and published.
 *
 * A product is NEEDS-PRICING while it is not V2-published (worker/lib/listing.ts):
 * no V2 method, or a method and no complete V2 write yet («محفوظ، غير مكتمل»).
 * Every such product is hidden from every customer surface; it reappears the
 * instant its first complete V2 write commits.
 *
 * Reads only. Codes, counts, names and field NAMES — never a figure; a price
 * editor never sees a cost code's name (`dto` projection in the route).
 */
import type { Context } from 'hono';
import { loadAuthoritativeProductImages } from '../../productSelectionImage';
import type { AppContext } from '../../types';
import { loadPreviewContext, loadProducts } from '../load';
import { loadPricingRates } from '../rates';
import { priceImagesEach } from '../engineWrite';
import { defaultMethodOf, desiredFor, evaluateDesired, loadV2Stores, storedMethodOf, v2ViewerOf, type V2Read } from './api';
import { v2EditorAnswer } from './dto';
import type { V2Method } from '@levonis/pricing/priceV2';
import { PRICE_REQUEST_ADMIN_TEXT } from '@levonis/contracts/priceRequests';
import { selectionLabel } from '../../priceRequests';
import { loadShelves } from './shelf';


/**
 * How many products are V2-published, and how many still need pricing (codes and counts only). Bundles and
 * mystery boxes are priced like ordinary products (DECISIONS row 251) and counted with them; `compositions`
 * is how many of those still need pricing.
 */
export async function v2PublicationCounts(db: D1Database): Promise<{ published: number; needs_pricing: number; saved: number; compositions: number }> {
  try {
    const row = await db
      .prepare(
        `SELECT
           SUM(CASE WHEN pub.ok = 1 THEN 1 ELSE 0 END) AS published,
           SUM(CASE WHEN pub.ok = 0 THEN 1 ELSE 0 END) AS needs_pricing,
           SUM(CASE WHEN pub.ok = 0 AND pub.method = 1 THEN 1 ELSE 0 END) AS saved,
           SUM(CASE WHEN COALESCE(p.composition, '') <> '' AND pub.ok = 0 THEN 1 ELSE 0 END) AS compositions
         FROM products p
         JOIN (SELECT q.id AS id,
                      EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id = q.id AND s.mode = 'engine' AND s.pricing_method IS NOT NULL
                                AND EXISTS (SELECT 1 FROM pricing_v2_sku_results r WHERE r.product_id = q.id)) AS ok,
                      EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id = q.id AND s.mode = 'engine' AND s.pricing_method IS NOT NULL) AS method
                 FROM products q) pub ON pub.id = p.id`
      )
      .first<{ published: number | null; needs_pricing: number | null; saved: number | null; compositions: number | null }>();
    return {
      published: Number(row?.published ?? 0),
      needs_pricing: Number(row?.needs_pricing ?? 0),
      saved: Number(row?.saved ?? 0),
      compositions: Number(row?.compositions ?? 0),
    };
  } catch (e) {
    // A database before 0189: nothing is published, everything needs pricing.
    if (!/no such (table|column)/i.test(e instanceof Error ? e.message : String(e))) throw e;
    const row = await db
      .prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN COALESCE(composition, '') <> '' THEN 1 ELSE 0 END) AS c FROM products")
      .first<{ n: number | null; c: number | null }>();
    return { published: 0, needs_pricing: Number(row?.n ?? 0), saved: 0, compositions: Number(row?.c ?? 0) };
  }
}

/* ----------------------------------------------------------- the queue -- */

/** How many published products still carry a price of the old 1,000 step (row 245); 0 before 0189. One statement. */
export async function roundingPendingCount(db: D1Database): Promise<number> {
  const rows = await softAll(() =>
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM products p
          WHERE EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id = p.id AND s.mode = 'engine' AND s.pricing_method IS NOT NULL)
            AND ${ROUNDING_PENDING_SQL}`
      )
      .all<{ n: number }>()
  );
  return Number(rows?.[0]?.n ?? 0);
}

/** The queue reads at most this many products per request (the statement budget: one load per kind, chunked). */
export const QUEUE_LIST_MAX = 200;
export const QUEUE_PAGE_SIZE = 20;
export const QUEUE_FILTERS = ['all', 'ready', 'saved', 'usd', 'cost', 'below_min_profit', 'purchase_review', 'most_requested', 'rounding'] as const;
export type QueueFilter = (typeof QUEUE_FILTERS)[number];
/** Filters only the owner may ask for (they name cost-derived facts, or prices only the owner moves). */
const OWNER_FILTERS: ReadonlySet<QueueFilter> = new Set(['cost', 'below_min_profit', 'purchase_review', 'rounding']);

/**
 * «بانتظار التقريب الجديد» (DECISIONS row 245): a PUBLISHED product with a stored result that is not the
 * rounding rule's (`roundPriceIqd`) rounding of its own exact figure — a price published under the 1,000
 * step. Its customers still see that price; re-publishing it through the review sheet («راجع الأسعار التي
 * ستتغيّر») moves it, old → new, after the owner sees it. A FILTER, not a figure: the comparison is in SQL
 * over the stored text (REAL is exact enough to tell a gap of ≥ 250 or ≥ 1 from none), and nothing is
 * written. `p` is the products alias.
 */
export const ROUNDING_PENDING_SQL = `EXISTS (SELECT 1 FROM pricing_v2_sku_results rr WHERE rr.product_id = p.id
  AND rr.final_price_iqd - CAST(rr.exact_iqd AS REAL) >= CASE WHEN CAST(rr.exact_iqd AS REAL) > 1000 THEN 250 ELSE 1 END)`;

/** `published`: only on the owner's below-minimum-profit and purchase-review filters (a listed product). */
export type QueueState = 'needs_pricing' | 'saved' | 'ready' | 'published';

/** Several products' V2 reads in a bounded number of statements: one load per kind, chunked (never two batches at once). */
export async function loadQueueReads(db: D1Database, ids: readonly string[]): Promise<Map<string, V2Read>> {
  const out = new Map<string, V2Read>();
  if (!ids.length) return out;
  const loaded = await loadProducts(db, ids);
  const { stored, v2, control } = await loadV2Stores(db, ids);
  const ctx = await loadPreviewContext(db);
  const rates = await loadPricingRates(db);
  const images = await priceImagesEach(db, ids);
  // Row 244: the shelves, so a cost-first product with stock reads as it would publish.
  const shelves = await loadShelves(db, ids);
  for (const id of ids) {
    const l = loaded.get(id);
    if (!l) continue;
    out.set(id, { loaded: l, stored: stored.get(id)!, v2: v2.get(id) ?? null, ctx, rates, control, image: images.get(id) ?? '', shelf: shelves.get(id) ?? null });
  }
  return out;
}

interface Candidate {
  id: string;
  slug: string;
  status: string;
  composition: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  method: V2Method | null;
  published: boolean;
  below_min_profit: boolean;
  purchase_review: boolean;
  /** Published under the old 1,000 step (row 245); only read on the owner's «rounding» filter. */
  rounding_pending: boolean;
  /** Distinct people with an open «طلب السعر» (migration 0193); null without the table. */
  requesters: number | null;
  last_request_at: string | null;
}

const softAll = async <T>(run: () => Promise<{ results?: T[] }>): Promise<T[] | null> => {
  try {
    return (await run()).results ?? [];
  } catch (e) {
    if (/no such (table|column)/i.test(e instanceof Error ? e.message : String(e))) return null;
    throw e;
  }
};

/**
 * THE CANDIDATES, MOST REQUESTED FIRST (DECISIONS row 240): the order is in
 * SQL — distinct requesters, then the latest request, then the last edit — so
 * the 200-row cap always keeps the products customers asked about, among ~1,100
 * unpriced ones. Which products are listed is unchanged; `mostRequested` keeps
 * only those with an open request. Without 0193 the order is today's.
 */
async function queueCandidates(
  db: D1Database,
  owner: boolean,
  mostRequested = false,
  rounding = false
): Promise<{ rows: Candidate[]; truncated: boolean; requestsInstalled: boolean }> {
  const published = `EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id = p.id AND s.mode = 'engine' AND s.pricing_method IS NOT NULL
                       AND EXISTS (SELECT 1 FROM pricing_v2_sku_results r WHERE r.product_id = p.id))`;
  const below = `EXISTS (SELECT 1 FROM pricing_v2_sku_results b WHERE b.product_id = p.id AND b.below_min_profit = 1)`;
  const head = `SELECT p.id, p.slug, p.status, COALESCE(p.composition, '') AS composition,
                       COALESCE(p.name_ar, '') AS name_ar, COALESCE(p.name, '') AS name_en, COALESCE(p.name_ku, '') AS name_ckb`;
  type Row = Omit<Candidate, 'method' | 'published' | 'below_min_profit' | 'purchase_review' | 'rounding_pending' | 'requesters' | 'last_request_at'> & {
    method: string | null;
    published: number;
    below: number;
    review: number;
    requesters: number | null;
    last_request_at: string | null;
  };
  const review = `EXISTS (SELECT 1 FROM pricing_v2_purchase_reviews pr WHERE pr.product_id = p.id AND pr.state = 'pending')`;
  const requesters = '(SELECT st.requesters FROM product_price_request_stats st WHERE st.product_id = p.id)';
  const lastRequest = '(SELECT st.last_request_at FROM product_price_request_stats st WHERE st.product_id = p.id)';
  const sql = (withReview: boolean, withRequests: boolean) =>
    `${head},
            (SELECT s.pricing_method FROM product_pricing_state s WHERE s.product_id = p.id AND s.mode = 'engine') AS method,
            ${published} AS published,
            ${owner ? below : '0'} AS below,
            ${owner && withReview ? review : '0'} AS review,
            ${withRequests ? requesters : 'NULL'} AS requesters,
            ${withRequests ? lastRequest : 'NULL'} AS last_request_at
       FROM products p
      WHERE (NOT ${published}${owner ? ` OR ${below}${withReview ? ` OR ${review}` : ''}` : ''})${mostRequested && withRequests ? ` AND NOT ${published} AND COALESCE(${requesters}, 0) > 0` : ''}
      ORDER BY ${withRequests ? `COALESCE(${requesters}, 0) DESC, COALESCE(${lastRequest}, '') DESC, ` : ''}p.updated_at DESC, p.id
      LIMIT ${QUEUE_LIST_MAX + 1}`;
  let requestsInstalled = true;
  // Row 245: the owner's «rounding» list is published products only — its own short read, so the
  // needs-pricing order and its 200-row cap never meet it.
  if (rounding) {
    const list =
      (await softAll(() =>
        db
          .prepare(
            `${head},
                    (SELECT s.pricing_method FROM product_pricing_state s WHERE s.product_id = p.id AND s.mode = 'engine') AS method,
                    1 AS published, ${below} AS below, 0 AS review, NULL AS requesters, NULL AS last_request_at
               FROM products p
              WHERE ${published} AND ${ROUNDING_PENDING_SQL}
              ORDER BY p.updated_at DESC, p.id
              LIMIT ${QUEUE_LIST_MAX + 1}`
          )
          .all<Row>()
      )) ?? [];
    return {
      truncated: list.length > QUEUE_LIST_MAX,
      requestsInstalled: false,
      rows: list.slice(0, QUEUE_LIST_MAX).map((r) => ({
        id: String(r.id),
        slug: String(r.slug ?? ''),
        status: String(r.status ?? ''),
        composition: String(r.composition ?? ''),
        name_ar: String(r.name_ar ?? ''),
        name_en: String(r.name_en ?? ''),
        name_ckb: String(r.name_ckb ?? ''),
        method: r.method === 'cost' || r.method === 'usd' ? r.method : null,
        published: true,
        below_min_profit: Number(r.below) === 1,
        purchase_review: false,
        rounding_pending: true,
        requesters: null,
        last_request_at: null,
      })),
    };
  }
  let rows = await softAll(() => db.prepare(sql(true, true)).all<Row>());
  // A database before 0193 has no request stats: today's order (and no most-requested list).
  if (rows === null) {
    requestsInstalled = false;
    if (mostRequested) return { rows: [], truncated: false, requestsInstalled };
    rows = await softAll(() => db.prepare(sql(true, false)).all<Row>());
  }
  // A database before 0190 has no purchase reviews: the rest of the queue still answers.
  if (rows === null) rows = await softAll(() => db.prepare(sql(false, false)).all<Row>());
  if (rows === null) {
    // Before 0189: nothing is published; every product needs pricing.
    rows = ((await db.prepare(`${head}, NULL AS method, 0 AS published, 0 AS below, 0 AS review, NULL AS requesters, NULL AS last_request_at FROM products p ORDER BY p.updated_at DESC, p.id LIMIT ${QUEUE_LIST_MAX + 1}`).all<Row>()).results ?? []);
  }
  const truncated = rows.length > QUEUE_LIST_MAX;
  return {
    truncated,
    requestsInstalled,
    rows: rows.slice(0, QUEUE_LIST_MAX).map((r) => ({
      id: String(r.id),
      slug: String(r.slug ?? ''),
      status: String(r.status ?? ''),
      composition: String(r.composition ?? ''),
      name_ar: String(r.name_ar ?? ''),
      name_en: String(r.name_en ?? ''),
      name_ckb: String(r.name_ckb ?? ''),
      method: r.method === 'cost' || r.method === 'usd' ? r.method : null,
      published: Number(r.published) === 1,
      below_min_profit: Number(r.below) === 1,
      purchase_review: Number(r.review) === 1,
      rounding_pending: false,
      requesters: requestsInstalled ? Number(r.requesters ?? 0) : null,
      last_request_at: requestsInstalled && r.last_request_at ? String(r.last_request_at) : null,
    })),
  };
}

/** One product's open requests in the queue: distinct people, the latest, and the per-selection breakdown. */
export interface QueueRequests {
  people: number;
  last_at: string | null;
  selections: Array<{ selection: string; label: { ar: string; en: string; ckb: string }; people: number; last_at: string }>;
}

/** A missing item as the queue lists it (codes and field NAMES, never a value). */
export interface QueueMissing {
  code: string;
  field: string | null;
  level: string | null;
  count: number;
  first_name: { ar: string; en: string; ckb: string } | null;
}

export interface QueueRow {
  id: string;
  slug: string;
  names: { ar: string; en: string; ckb: string };
  image: string;
  status: string;
  composition: string;
  state: QueueState;
  method: V2Method | null;
  default_method: V2Method;
  can_finish: boolean;
  sellable_skus: number;
  channels: string[];
  missing: QueueMissing[];
  below_min_profit?: boolean;
  purchase_review?: boolean;
  /** Owner only: published under the old 1,000 step, waiting for the review sheet (row 245). */
  rounding_pending?: boolean;
  /** «طلب السعر» (DECISIONS row 240): counts only, never who. Null without 0193. */
  requests: QueueRequests | null;
  link: string;
}

/**
 * GET /api/admin/products-v2/needs-pricing (addendum A.8): every product that
 * is not V2-published, plus — for the owner — published products with a price
 * below cost + minimum profit or a pending purchase review (those filters
 * only). Codes, counts, names and field names; a price editor never reads a
 * cost code's name (a cost-first product's gaps are one OWNER_DATA item) nor
 * the owner-only filters. No bulk publish exists.
 */
export async function needsPricingAnswer(c: Context<AppContext>, q: { page: number; filter: QueueFilter }): Promise<Record<string, unknown>> {
  const db = c.env.DB;
  const user = c.get('user')!;
  const viewer = v2ViewerOf(c.env, user);
  const owner = viewer === 'owner';
  const filter: QueueFilter = !owner && OWNER_FILTERS.has(q.filter) ? 'all' : q.filter;
  const requestsOf = (cand: Candidate): QueueRequests | null =>
    cand.requesters === null ? null : { people: cand.requesters, last_at: cand.last_request_at, selections: [] };
  const { rows: candidates, truncated, requestsInstalled } = await queueCandidates(db, owner, filter === 'most_requested', filter === 'rounding');
  const reads = await loadQueueReads(db, candidates.map((r) => r.id));
  const rates = reads.values().next().value?.rates ?? (await loadPricingRates(db));
  const now = new Date().toISOString();
  const o = { viewer, env: c.env, user, now };

  const rows: QueueRow[] = [];
  for (const cand of candidates) {
    // A bundle or a mystery box is priced like an ordinary product (DECISIONS row 251), in the bundles panel's
    // own section ٣ (the product form never opens one).
    const link =
      cand.composition !== ''
        ? `/admin?tab=bundles&edit=${encodeURIComponent(cand.id)}&section=3`
        : `/admin?tab=products&edit=${encodeURIComponent(cand.id)}&section=3`;
    const names = { ar: cand.name_ar, en: cand.name_en, ckb: cand.name_ckb };
    const read = reads.get(cand.id);
    if (!read) continue;
    const stored = storedMethodOf(read);
    const method: V2Method = stored ?? (await defaultMethodOf(read, viewer, o));
    let ev;
    try {
      ev = await evaluateDesired(read, desiredFor(read, owner && !stored ? { method, sent: ['method'] } : { sent: [] }, o));
    } catch {
      // A product the engine cannot read yet (a malformed legacy row) is still listed, with nothing to say but its name.
      rows.push({ id: cand.id, slug: cand.slug, names, image: '', status: cand.status, composition: cand.composition, state: stored ? 'saved' : 'needs_pricing', method: stored, default_method: method, can_finish: owner || method === 'usd', sellable_skus: 0, channels: [], missing: [], requests: requestsOf(cand), link });
      continue;
    }
    const answer = v2EditorAnswer(ev);
    const costFirstForEditor = !owner && method === 'cost';
    const missing: QueueMissing[] = costFirstForEditor
      ? answer.missing.length
        ? [{ code: 'OWNER_DATA', field: null, level: null, count: answer.missing.reduce((n, m) => n + (m.count ?? 1), 0), first_name: null }]
        : []
      : answer.missing.map((m) => ({ code: m.code, field: m.field ?? null, level: m.level ?? null, count: m.count ?? 1, first_name: m.first_name ?? null }));
    const state: QueueState = cand.published ? 'published' : stored && !ev.complete ? 'saved' : ev.complete ? 'ready' : stored ? 'saved' : 'needs_pricing';
    rows.push({
      id: cand.id,
      slug: cand.slug,
      names,
      // The picture is read for the page shown (below). NEVER `read.image`: that is the engine's price image —
      // a fingerprint of every old dinar price of the product — not a picture (review 2026-10-14).
      image: '',
      status: cand.status,
      composition: cand.composition,
      state,
      method: stored,
      default_method: method,
      can_finish: owner || method === 'usd',
      sellable_skus: new Set(ev.rows.map((r) => r.combo_key)).size,
      channels: [...new Set(ev.rows.map((r) => r.channel))],
      missing,
      ...(owner ? { below_min_profit: cand.below_min_profit, purchase_review: cand.purchase_review, rounding_pending: cand.rounding_pending } : {}),
      requests: requestsOf(cand),
      link,
    });
  }

  const hiddenRows = rows.filter((r) => !candidates.find((cand) => cand.id === r.id)?.published);
  const counts: Record<string, number> = {
    hidden: hiddenRows.length,
    ready: hiddenRows.filter((r) => r.state === 'ready').length,
    saved: hiddenRows.filter((r) => r.state === 'saved').length,
    editor_can_finish: hiddenRows.filter((r) => (r.method ?? 'usd') === 'usd').length,
    owner_only: hiddenRows.filter((r) => r.method === 'cost').length,
  };
  if (owner) {
    counts.below_min_profit = rows.filter((r) => r.below_min_profit).length;
    counts.purchase_review = rows.filter((r) => r.purchase_review).length;
    counts.rounding = await roundingPendingCount(db);
  }
  // Unpublished products with an open «طلب السعر» (not owner-only: counts, never who).
  counts.most_requested = hiddenRows.filter((r) => (r.requests?.people ?? 0) > 0).length;
  // The «rounding» list read published products only: the other counts were not read, so none is said
  // (never a «0» beside «الكل» that only means «not counted here»).
  if (filter === 'rounding') for (const k of Object.keys(counts)) if (k !== 'rounding') delete counts[k];

  const published = new Set(candidates.filter((cand) => cand.published).map((cand) => cand.id));
  const pick = (r: QueueRow): boolean => {
    switch (filter) {
      case 'all':
        return !published.has(r.id);
      case 'ready':
        return !published.has(r.id) && r.state === 'ready';
      case 'saved':
        return !published.has(r.id) && r.state === 'saved';
      case 'usd':
        return !published.has(r.id) && (r.method ?? r.default_method) === 'usd';
      case 'cost':
        return !published.has(r.id) && (r.method ?? r.default_method) === 'cost';
      case 'below_min_profit':
        return r.below_min_profit === true;
      case 'purchase_review':
        return r.purchase_review === true;
      case 'most_requested':
        return !published.has(r.id) && (r.requests?.people ?? 0) > 0;
      case 'rounding':
        return r.rounding_pending === true;
    }
  };
  const listed = rows.filter(pick);
  const pages = Math.max(1, Math.ceil(listed.length / QUEUE_PAGE_SIZE));
  const page = Math.min(Math.max(1, q.page), pages);
  const shown = listed.slice((page - 1) * QUEUE_PAGE_SIZE, page * QUEUE_PAGE_SIZE);
  // The product's real picture, from the one authority the products list reads (product_images).
  const pictures = await loadAuthoritativeProductImages(db, shown.map((r) => r.id));
  for (const r of shown) r.image = pictures.get(r.id) ?? '';
  // The page's per-selection breakdown: ONE grouped read for the shown ids, labelled from the docs this
  // queue already loaded (the UNIQUE (user, product, selection) index makes COUNT(*) a count of people).
  const requested = shown.filter((r) => (r.requests?.people ?? 0) > 0);
  if (requestsInstalled && requested.length) {
    const grouped = await softAll(() =>
      db
        .prepare(
          `SELECT product_id, selection, COUNT(*) AS people, MAX(requested_at) AS last_at FROM product_price_requests
            WHERE product_id IN (SELECT value FROM json_each(?)) AND state = 'open'
            GROUP BY product_id, selection ORDER BY people DESC, last_at DESC`
        )
        .bind(JSON.stringify(requested.map((r) => r.id)))
        .all<{ product_id: string; selection: string; people: number; last_at: string }>()
    );
    for (const g of grouped ?? []) {
      const row = requested.find((r) => r.id === g.product_id);
      const doc = reads.get(g.product_id)?.loaded.doc;
      if (!row?.requests) continue;
      const label = doc ? selectionLabel(doc, String(g.selection)) : { ...PRICE_REQUEST_ADMIN_TEXT.whole_product };
      row.requests.selections.push({ selection: String(g.selection), label, people: Number(g.people) || 0, last_at: String(g.last_at ?? '') });
    }
  }
  return {
    success: true,
    rate_ready: !!rates?.usd_iqd,
    filter,
    counts,
    products: shown,
    page,
    pages,
    truncated,
    ...(filter === 'most_requested' && !requestsInstalled ? { requests_unavailable: true } : {}),
  };
}
