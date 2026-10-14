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


/** How many ordinary products are V2-published, and how many still need pricing (codes and counts only). */
export async function v2PublicationCounts(db: D1Database): Promise<{ published: number; needs_pricing: number; saved: number; compositions: number }> {
  try {
    const row = await db
      .prepare(
        `SELECT
           SUM(CASE WHEN COALESCE(p.composition, '') = '' AND pub.ok = 1 THEN 1 ELSE 0 END) AS published,
           SUM(CASE WHEN COALESCE(p.composition, '') = '' AND pub.ok = 0 THEN 1 ELSE 0 END) AS needs_pricing,
           SUM(CASE WHEN COALESCE(p.composition, '') = '' AND pub.ok = 0 AND pub.method = 1 THEN 1 ELSE 0 END) AS saved,
           SUM(CASE WHEN COALESCE(p.composition, '') <> '' THEN 1 ELSE 0 END) AS compositions
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
      .prepare("SELECT SUM(CASE WHEN COALESCE(composition, '') = '' THEN 1 ELSE 0 END) AS n, SUM(CASE WHEN COALESCE(composition, '') <> '' THEN 1 ELSE 0 END) AS c FROM products")
      .first<{ n: number | null; c: number | null }>();
    return { published: 0, needs_pricing: Number(row?.n ?? 0), saved: 0, compositions: Number(row?.c ?? 0) };
  }
}

/* ----------------------------------------------------------- the queue -- */

/** The queue reads at most this many products per request (the statement budget: one load per kind, chunked). */
export const QUEUE_LIST_MAX = 200;
export const QUEUE_PAGE_SIZE = 20;
export const QUEUE_FILTERS = ['all', 'ready', 'saved', 'usd', 'cost', 'below_min_profit', 'purchase_review'] as const;
export type QueueFilter = (typeof QUEUE_FILTERS)[number];
/** Filters only the owner may ask for (they name cost-derived facts). */
const OWNER_FILTERS: ReadonlySet<QueueFilter> = new Set(['cost', 'below_min_profit', 'purchase_review']);

/** `published`: only on the owner's below-minimum-profit and purchase-review filters (a listed product). */
export type QueueState = 'needs_pricing' | 'saved' | 'ready' | 'composition_pending' | 'published';

/** Several products' V2 reads in a bounded number of statements: one load per kind, chunked (never two batches at once). */
export async function loadQueueReads(db: D1Database, ids: readonly string[]): Promise<Map<string, V2Read>> {
  const out = new Map<string, V2Read>();
  if (!ids.length) return out;
  const loaded = await loadProducts(db, ids);
  const { stored, v2, control } = await loadV2Stores(db, ids);
  const ctx = await loadPreviewContext(db);
  const rates = await loadPricingRates(db);
  const images = await priceImagesEach(db, ids);
  for (const id of ids) {
    const l = loaded.get(id);
    if (!l) continue;
    out.set(id, { loaded: l, stored: stored.get(id)!, v2: v2.get(id) ?? null, ctx, rates, control, image: images.get(id) ?? '' });
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
}

const softAll = async <T>(run: () => Promise<{ results?: T[] }>): Promise<T[] | null> => {
  try {
    return (await run()).results ?? [];
  } catch (e) {
    if (/no such (table|column)/i.test(e instanceof Error ? e.message : String(e))) return null;
    throw e;
  }
};

async function queueCandidates(db: D1Database, owner: boolean): Promise<{ rows: Candidate[]; truncated: boolean }> {
  const published = `EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id = p.id AND s.mode = 'engine' AND s.pricing_method IS NOT NULL
                       AND EXISTS (SELECT 1 FROM pricing_v2_sku_results r WHERE r.product_id = p.id))`;
  const below = `EXISTS (SELECT 1 FROM pricing_v2_sku_results b WHERE b.product_id = p.id AND b.below_min_profit = 1)`;
  const head = `SELECT p.id, p.slug, p.status, COALESCE(p.composition, '') AS composition,
                       COALESCE(p.name_ar, '') AS name_ar, COALESCE(p.name, '') AS name_en, COALESCE(p.name_ku, '') AS name_ckb`;
  type Row = Omit<Candidate, 'method' | 'published' | 'below_min_profit' | 'purchase_review'> & { method: string | null; published: number; below: number; review: number };
  const review = `EXISTS (SELECT 1 FROM pricing_v2_purchase_reviews pr WHERE pr.product_id = p.id AND pr.state = 'pending')`;
  const sql = (withReview: boolean) =>
    `${head},
            (SELECT s.pricing_method FROM product_pricing_state s WHERE s.product_id = p.id AND s.mode = 'engine') AS method,
            ${published} AS published,
            ${owner ? below : '0'} AS below,
            ${owner && withReview ? review : '0'} AS review
       FROM products p
      WHERE NOT ${published}${owner ? ` OR ${below}${withReview ? ` OR ${review}` : ''}` : ''}
      ORDER BY p.updated_at DESC, p.id
      LIMIT ${QUEUE_LIST_MAX + 1}`;
  let rows = await softAll(() => db.prepare(sql(true)).all<Row>());
  // A database before 0190 has no purchase reviews: the rest of the queue still answers.
  if (rows === null) rows = await softAll(() => db.prepare(sql(false)).all<Row>());
  if (rows === null) {
    // Before 0189: nothing is published; every product needs pricing.
    rows = ((await db.prepare(`${head}, NULL AS method, 0 AS published, 0 AS below, 0 AS review FROM products p ORDER BY p.updated_at DESC, p.id LIMIT ${QUEUE_LIST_MAX + 1}`).all<Row>()).results ?? []);
  }
  const truncated = rows.length > QUEUE_LIST_MAX;
  return {
    truncated,
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
    })),
  };
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
  const { rows: candidates, truncated } = await queueCandidates(db, owner);
  const reads = await loadQueueReads(db, candidates.filter((r) => r.composition === '').map((r) => r.id));
  const rates = reads.values().next().value?.rates ?? (await loadPricingRates(db));
  const now = new Date().toISOString();
  const o = { viewer, env: c.env, user, now };

  const rows: QueueRow[] = [];
  for (const cand of candidates) {
    const link = `/admin?tab=products&edit=${encodeURIComponent(cand.id)}&section=3`;
    const names = { ar: cand.name_ar, en: cand.name_en, ckb: cand.name_ckb };
    if (cand.composition !== '') {
      rows.push({ id: cand.id, slug: cand.slug, names, image: '', status: cand.status, composition: cand.composition, state: 'composition_pending', method: null, default_method: 'usd', can_finish: false, sellable_skus: 0, channels: [], missing: [], link });
      continue;
    }
    const read = reads.get(cand.id);
    if (!read) continue;
    const stored = storedMethodOf(read);
    const method: V2Method = stored ?? (await defaultMethodOf(read, viewer, o));
    let ev;
    try {
      ev = await evaluateDesired(read, desiredFor(read, owner && !stored ? { method, sent: ['method'] } : { sent: [] }, o));
    } catch {
      // A product the engine cannot read yet (a malformed legacy row) is still listed, with nothing to say but its name.
      rows.push({ id: cand.id, slug: cand.slug, names, image: '', status: cand.status, composition: '', state: stored ? 'saved' : 'needs_pricing', method: stored, default_method: method, can_finish: owner || method === 'usd', sellable_skus: 0, channels: [], missing: [], link });
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
      composition: '',
      state,
      method: stored,
      default_method: method,
      can_finish: owner || method === 'usd',
      sellable_skus: new Set(ev.rows.map((r) => r.combo_key)).size,
      channels: [...new Set(ev.rows.map((r) => r.channel))],
      missing,
      ...(owner ? { below_min_profit: cand.below_min_profit, purchase_review: cand.purchase_review } : {}),
      link,
    });
  }

  const hiddenRows = rows.filter((r) => !candidates.find((cand) => cand.id === r.id)?.published);
  const counts: Record<string, number> = {
    hidden: hiddenRows.length,
    ready: hiddenRows.filter((r) => r.state === 'ready').length,
    saved: hiddenRows.filter((r) => r.state === 'saved').length,
    editor_can_finish: hiddenRows.filter((r) => r.composition === '' && (r.method ?? 'usd') === 'usd').length,
    owner_only: hiddenRows.filter((r) => r.method === 'cost').length,
  };
  if (owner) {
    counts.below_min_profit = rows.filter((r) => r.below_min_profit).length;
    counts.purchase_review = rows.filter((r) => r.purchase_review).length;
  }

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
        return !published.has(r.id) && r.composition === '' && (r.method ?? r.default_method) === 'usd';
      case 'cost':
        return !published.has(r.id) && (r.method ?? r.default_method) === 'cost';
      case 'below_min_profit':
        return r.below_min_profit === true;
      case 'purchase_review':
        return r.purchase_review === true;
    }
  };
  const listed = rows.filter(pick);
  const pages = Math.max(1, Math.ceil(listed.length / QUEUE_PAGE_SIZE));
  const page = Math.min(Math.max(1, q.page), pages);
  const shown = listed.slice((page - 1) * QUEUE_PAGE_SIZE, page * QUEUE_PAGE_SIZE);
  // The product's real picture, from the one authority the products list reads (product_images).
  const pictures = await loadAuthoritativeProductImages(db, shown.map((r) => r.id));
  for (const r of shown) r.image = pictures.get(r.id) ?? '';
  return {
    success: true,
    rate_ready: !!rates?.usd_iqd,
    filter,
    counts,
    products: shown,
    page,
    pages,
    truncated,
  };
}
