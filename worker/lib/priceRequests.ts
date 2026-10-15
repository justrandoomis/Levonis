/**
 * «طلب السعر» — SIGNED-IN PRICE REQUESTS (DECISIONS rows 239 (4) and 240;
 * migration 0193).
 *
 * A customer who sees a product with no price yet («السعر غير متوفر حالياً»)
 * may ask for it — for the product, or for the exact option/colour/variant
 * they chose. One row per (person, product, selection): a repeat tap raises
 * that row's `click_count` and never the count of people. The per-product
 * aggregates (`product_price_request_stats`) are RECOMPUTED FROM SOURCE inside
 * the same batch as every write, never incremented, so they are exact under
 * concurrency (D1 serialises batches).
 *
 * NO MONEY. A request touches `product_price_requests` and its stats only
 * (plus `rate_limits` and the fence's `ops_guards` scratch rows): never an
 * order, a cart, a wallet, an inventory reservation or any price.
 *
 * THE SWEEP IS THE ONE AUTHORITY for "this is now priced": a selection becomes
 * sellable through many doors (the first V2 write, a later V2 write adding SKU
 * rows, FX-5, the completeness hold lifting, the owner's switch turning off),
 * and a hook on one door would miss the others. It runs in the quarter-hour
 * tick after the completeness sweep, within its own budget, and moves a
 * request to `notified` (the in-app row and the outbox rows in the SAME batch)
 * or `closed(priced)` when the customer did not ask to be told.
 *
 * THE ADMIN HEARS IN A DIGEST, never once per request: at most one Telegram
 * message an hour, in the existing «البلاغات» topic (default D8), naming the
 * products whose distinct requesters crossed a threshold (1, 3, 10, 25, 50,
 * 100, then every 100). Claim, then send: two concurrent digests send once.
 *
 * DEPLOY-AHEAD (CLAUDE.md rule 2): without 0193 every customer door answers
 * 503 PRICE_REQUESTS_UNAVAILABLE, the sweep and the digest return at once, and
 * the admin reads fall back (no column, today's order).
 */
import { parseSkuComboKey } from '@levonis/pricing/skuChannel';
import {
  PRICE_REQUEST_ADMIN_TEXT,
  crossedDigestThreshold,
  priceAvailableMessage,
  requestersText,
  type PriceRequestText,
} from '@levonis/contracts/priceRequests';
import type { Env } from './types';
import type { ProductDoc } from './productModel';
import { applyRelations, loadRelationsViews } from './productOverlay';
import { parseProductRow } from './productModel';
import { unitNamesOf } from './pricingEngine/legacy';
import { listing } from './listing';
import { skuPriced } from './commercialState';
import { notifyStatement } from './notifications';
import { planNotifyCustomer, reachForMany, type CustomerMessage, type CustomerReach } from './customerNotify';
import { channelsLive } from './channelReadiness';
import { announceToAdmins } from './adminTopicRouting';

// ------------------------------------------------------------- installed?

const PRESENT = new WeakMap<object, true>();
const ABSENT_UNTIL = new WeakMap<object, number>();
const ABSENT_RECHECK_MS = 60_000;

/** "no such table: product_price_request…" — the deploy-ahead answer. */
export function isMissingPriceRequestTable(err: unknown): boolean {
  return /no such table:?\s*product_price_request/i.test(String((err as { message?: unknown })?.message ?? err));
}

/** Migration 0193's tables are on this database. One probe per binding while unknown, none once present. */
export async function priceRequestsInstalled(db: D1Database): Promise<boolean> {
  if (PRESENT.has(db)) return true;
  if ((ABSENT_UNTIL.get(db) ?? 0) > Date.now()) return false;
  try {
    await db.prepare('SELECT 1 AS x FROM product_price_request_stats LIMIT 1').first<{ x: number }>();
    PRESENT.set(db, true);
    return true;
  } catch (e) {
    if (isMissingPriceRequestTable(e)) ABSENT_UNTIL.set(db, Date.now() + ABSENT_RECHECK_MS);
    return false;
  }
}

/** Whether this database is known to carry 0193 without asking (a read that just succeeded proves it). */
export function rememberPriceRequestsPresent(db: object): void {
  PRESENT.set(db, true);
}

// ------------------------------------------------------------- the stats

/**
 * The per-product aggregates, RECOMPUTED FROM SOURCE over the open rows — one
 * statement, appended to every batch that writes requests.
 */
const STATS_SQL = `INSERT INTO product_price_request_stats (product_id, requesters, selections, clicks, last_request_at, updated_at)
SELECT ?1, COUNT(DISTINCT user_id), COUNT(DISTINCT selection), COALESCE(SUM(click_count), 0), COALESCE(MAX(requested_at), ''), ?2
  FROM product_price_requests WHERE product_id = ?1 AND state = 'open'
ON CONFLICT(product_id) DO UPDATE SET requesters = excluded.requesters, selections = excluded.selections,
  clicks = excluded.clicks, last_request_at = excluded.last_request_at, updated_at = excluded.updated_at`;

export const statsRecompute = (db: D1Database, productId: string, now: string): D1PreparedStatement =>
  db.prepare(STATS_SQL).bind(productId, now);

// ------------------------------------------------------------- the selection's words

/** The selection's name in three languages (« · » between parts); the whole product when the key is ''. */
export function selectionLabel(doc: ProductDoc, key: string): PriceRequestText {
  const sel = parseSkuComboKey(key);
  if (!sel || (!sel.option_value_ids.length && !sel.color_id)) return { ...PRICE_REQUEST_ADMIN_TEXT.whole_product };
  const color = sel.color_id ? (doc.colors.find((c) => c.id === sel.color_id) ?? null) : null;
  const names = unitNamesOf(doc, sel.option_value_ids, color);
  const fallback = PRICE_REQUEST_ADMIN_TEXT.whole_product;
  return { ar: names.name_ar || fallback.ar, en: names.name_en || fallback.en, ckb: names.name_ckb || fallback.ckb };
}

/** The product's own name in three languages (the English one is required and the fallback). */
export function productNames(doc: ProductDoc): PriceRequestText {
  const en = doc.name_en || doc.name_ar || '';
  return { ar: doc.name_ar || en, en, ckb: doc.name_ckb || doc.name_ar || en };
}

// ------------------------------------------------------------- the sweep

/** Products a pass looks at, and rows it reads for them. */
const SWEEP_PRODUCTS = 10;
const SWEEP_ROWS = 200;
/** Statements per batch: well under D1's per-invocation ceiling, small enough to retry. */
const BATCH_MAX = 50;
/** What the relations loader sends for a page of products (worker/lib/productOverlay.ts `loadRelationsViews`). */
const RELATIONS_READ_COST = 11;

export interface PriceRequestBudget {
  canSpend(n: number): boolean;
  spend(n: number): boolean;
  remaining(): number;
}

export interface PriceRequestSweepReport {
  products: number;
  notified: number;
  closed: number;
  /** Flipped to `priced` only: the delivery plan could not be built; the next tick retries. */
  priced: number;
  reopened: number;
  statements: number;
}

interface RequestRow {
  id: string;
  user_id: string;
  product_id: string;
  selection: string;
  state: string;
  notify: number;
  cycle: number;
}

/** The notification's identity: one per request and reopening cycle (user_notifications.event_key is unique per user, 0045). */
export const priceAvailableEventKey = (requestId: string, cycle: number) => `price_available:${requestId}:${cycle}`;

/**
 * ONE PASS: up to 10 products with open (or delivery-pending) requests, the
 * least recently checked first. A request is priced iff its product is
 * SELLABLE and its selection has a live SKU price (`skuPriced`; a sellable
 * product that is not strict prices every selection). Every statement is
 * charged before it is sent; a pass that cannot afford a step stops there and
 * the cursor (`checked_at`) carries the rest to the next tick. Never throws.
 */
export async function sweepPriceRequests(
  env: Env,
  budget: PriceRequestBudget,
  opts: { productIds?: readonly string[]; now?: string } = {}
): Promise<PriceRequestSweepReport> {
  const report: PriceRequestSweepReport = { products: 0, notified: 0, closed: 0, priced: 0, reopened: 0, statements: 0 };
  const db = env.DB;
  const spend = (n: number) => {
    if (!budget.spend(n)) return false;
    report.statements += n;
    return true;
  };
  try {
    if (!spend(1)) return report;
    if (!(await priceRequestsInstalled(db))) return report;
    const now = opts.now ?? new Date().toISOString();

    // 1. The products to look at (one statement).
    if (!spend(1)) return report;
    const only = opts.productIds && opts.productIds.length ? JSON.stringify([...new Set(opts.productIds)].slice(0, SWEEP_PRODUCTS)) : null;
    const picked = await db
      .prepare(
        `SELECT product_id FROM product_price_requests
          WHERE state IN ('open','priced')${only ? ' AND product_id IN (SELECT value FROM json_each(?))' : ''}
          GROUP BY product_id ORDER BY MIN(checked_at), product_id LIMIT ${SWEEP_PRODUCTS}`
      )
      .bind(...(only ? [only] : []))
      .all<{ product_id: string }>();
    const ids = (picked.results ?? []).map((r) => String(r.product_id));
    if (!ids.length) return report;
    report.products = ids.length;

    // 2. Their states (the listing probes are charged as two, the read as one).
    if (!spend(3)) return report;
    const states = await (await listing(db)).statesOf(ids);
    const sellableIds = ids.filter((id) => states.get(id) === 'sellable');

    // 3. The sellable products' documents with their SKU rows (the listing's own loader).
    const docs = new Map<string, ProductDoc>();
    if (sellableIds.length) {
      if (!spend(1 + RELATIONS_READ_COST)) return report;
      const { results: productRows } = await db
        .prepare('SELECT * FROM products WHERE id IN (SELECT value FROM json_each(?))')
        .bind(JSON.stringify(sellableIds))
        .all<Record<string, unknown>>();
      const views = await loadRelationsViews(db, (productRows ?? []).map((r) => ({ id: String(r.id), inventory_mode: r.inventory_mode })));
      for (const r of productRows ?? []) {
        const view = views.get(String(r.id));
        // A failed read of the SKU rows is not "nothing priced": that product waits for the next tick.
        if (view?.sku_prices_unread) continue;
        docs.set(String(r.id), view ? applyRelations(parseProductRow(r), view) : parseProductRow(r));
      }
    }

    // 4. The rows (one statement, bounded).
    if (!spend(1)) return report;
    const { results: rowResults } = await db
      .prepare(
        `SELECT id, user_id, product_id, selection, state, notify, cycle FROM product_price_requests
          WHERE product_id IN (SELECT value FROM json_each(?)) AND state IN ('open','priced')
          ORDER BY product_id, requested_at, id LIMIT ${SWEEP_ROWS}`
      )
      .bind(JSON.stringify(ids))
      .all<RequestRow>();
    const rows = rowResults ?? [];

    const isPriced = (r: RequestRow): boolean => {
      const doc = docs.get(r.product_id);
      return !!doc && skuPriced(doc, r.selection);
    };
    const toNotify = rows.filter((r) => isPriced(r) && Number(r.notify) === 1);

    // 5. One reach read for every customer to tell, and one deployment check.
    let reaches: Map<string, CustomerReach> | null = null;
    let live: Awaited<ReturnType<typeof channelsLive>> | null = null;
    if (toNotify.length) {
      const reachCost = Math.ceil(new Set(toNotify.map((r) => r.user_id)).size / 90) + 1;
      if (spend(reachCost)) {
        try {
          [reaches, live] = await Promise.all([reachForMany(env, toNotify.map((r) => r.user_id)), channelsLive(env)]);
        } catch (e) {
          console.error('price request sweep: reach read failed:', e instanceof Error ? e.name : 'unknown');
          reaches = null;
        }
      }
    }

    // 6. One batch (or a few, ≤ 50 statements) per product, the stats recomputed in each.
    for (const productId of ids) {
      const mine = rows.filter((r) => r.product_id === productId);
      const doc = docs.get(productId) ?? null;
      const groups: D1PreparedStatement[][] = [];
      let current: D1PreparedStatement[] = [];
      const counts = { notified: 0, closed: 0, priced: 0, reopened: 0 };
      const flush = () => {
        if (current.length) groups.push(current);
        current = [];
      };
      for (const r of mine) {
        const stmts: D1PreparedStatement[] = [];
        if (!isPriced(r)) {
          // A delivery-pending row whose product is no longer priced waits again as an open request.
          if (r.state === 'priced') {
            stmts.push(
              db.prepare("UPDATE product_price_requests SET state = 'open', priced_at = '' WHERE id = ? AND state = 'priced'").bind(r.id)
            );
            counts.reopened += 1;
          }
        } else if (Number(r.notify) !== 1) {
          stmts.push(
            db
              .prepare(
                "UPDATE product_price_requests SET state = 'closed', close_reason = 'priced', priced_at = ?, closed_at = ? WHERE id = ? AND state IN ('open','priced')"
              )
              .bind(now, now, r.id)
          );
          counts.closed += 1;
        } else if (reaches && live && doc) {
          const name = productNames(doc);
          const label = r.selection ? selectionLabel(doc, r.selection) : null;
          const full: PriceRequestText = label
            ? { ar: `${name.ar} — ${label.ar}`, en: `${name.en} — ${label.en}`, ckb: `${name.ckb} — ${label.ckb}` }
            : name;
          const { title, body } = priceAvailableMessage(full);
          const reach = reaches.get(r.user_id);
          const lang = reach?.lang ?? 'ar';
          const slug = String(doc.slug ?? '');
          const link = slug ? `/product/${slug}` : '/';
          const eventKey = priceAvailableEventKey(r.id, Number(r.cycle) || 1);
          const msg: CustomerMessage = { subject: title[lang], body: `${title[lang]}\n${body[lang]}` };
          // No reach row (an account gone since it asked): the in-app row alone, never a second read here.
          const plan = reach ? await planNotifyCustomer(env, r.user_id, eventKey, msg, { reach, live }) : { statements: [] as D1PreparedStatement[] };
          stmts.push(
            db
              .prepare(
                "UPDATE product_price_requests SET state = 'notified', priced_at = ?, notified_at = ? WHERE id = ? AND state IN ('open','priced')"
              )
              .bind(now, now, r.id),
            notifyStatement(db, {
              userId: r.user_id,
              kind: 'price_available',
              title_ar: title.ar,
              title_en: title.en,
              body_ar: body.ar,
              body_en: body.en,
              link,
              entity_type: 'product',
              entity_id: productId,
              meta: { request_id: r.id, selection: r.selection, title_ckb: title.ckb, body_ckb: body.ckb },
              eventKey,
            }).stmt,
            ...plan.statements
          );
          counts.notified += 1;
        } else {
          // The delivery plan cannot be built this tick (the reach read failed or was not affordable): flip to
          // `priced` only — the next tick builds it.
          stmts.push(
            db.prepare("UPDATE product_price_requests SET state = 'priced', priced_at = ? WHERE id = ? AND state = 'open'").bind(now, r.id)
          );
          counts.priced += 1;
        }
        if (current.length + stmts.length > BATCH_MAX - 2) flush();
        current.push(...stmts);
      }
      // The cursor moves for every row still waiting, and the stats follow the source.
      current.push(
        db.prepare("UPDATE product_price_requests SET checked_at = ? WHERE product_id = ? AND state IN ('open','priced')").bind(now, productId),
        statsRecompute(db, productId, now)
      );
      flush();
      const cost = groups.reduce((n, g) => n + g.length, 0);
      if (!spend(cost)) break;
      for (const g of groups) await db.batch(g);
      report.notified += counts.notified;
      report.closed += counts.closed;
      report.priced += counts.priced;
      report.reopened += counts.reopened;
    }
  } catch (error) {
    console.error('price request sweep failed:', error instanceof Error ? error.name : 'unknown');
  }
  return report;
}

// ------------------------------------------------------------- the admin digest

/** At most one digest an hour (default D8). */
export const DIGEST_INTERVAL_MS = 60 * 60 * 1000;
const DIGEST_CANDIDATES = 20;
const DIGEST_LINES = 10;

export interface PriceRequestDigestReport {
  sent: boolean;
  products: number;
  statements: number;
}

const adminFocusLink = (env: Env, productId: string): string => {
  const origin = (env.APP_ORIGIN || '').trim().replace(/\/+$/, '');
  const path = `/admin?tab=products&pricing=needs&focus=${encodeURIComponent(productId)}`;
  return origin.startsWith('https://') ? `${origin}${path}` : path;
};

/** «2026-10-15 09:30 UTC» — the time of a request, never the person. */
const shortTime = (iso: string): string => (iso && iso.length >= 16 ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : '');

/**
 * THE ADMIN'S DIGEST: the products whose distinct requesters crossed a
 * threshold since their last announcement, in one Arabic message to the
 * «البلاغات» topic, at most once an hour. CLAIM, THEN SEND: the claim moves
 * `digest_requesters` up to `requesters` for exactly the announced products
 * and only a claim that changed rows sends — two concurrent digests send once,
 * and a lost send is logged and never retried (no spam). Counts and names
 * only: no user name, id or contact. Never throws.
 */
export async function digestPriceRequests(env: Env, budget: PriceRequestBudget, nowMs = Date.now()): Promise<PriceRequestDigestReport> {
  const report: PriceRequestDigestReport = { sent: false, products: 0, statements: 0 };
  const db = env.DB;
  const spend = (n: number) => {
    if (!budget.spend(n)) return false;
    report.statements += n;
    return true;
  };
  try {
    if (!spend(1)) return report;
    if (!(await priceRequestsInstalled(db))) return report;
    if (!spend(1)) return report;
    const last = await db.prepare("SELECT COALESCE(MAX(digest_at), '') AS at FROM product_price_request_stats").first<{ at: string }>();
    const lastMs = last?.at ? Date.parse(last.at) : NaN;
    if (Number.isFinite(lastMs) && nowMs - lastMs < DIGEST_INTERVAL_MS) return report;

    if (!spend(1)) return report;
    const { results } = await db
      .prepare(
        `SELECT st.product_id, st.requesters, st.digest_requesters, st.last_request_at, p.name, p.name_ar
           FROM product_price_request_stats st JOIN products p ON p.id = st.product_id
          WHERE st.requesters > st.digest_requesters
          ORDER BY st.requesters DESC, st.last_request_at DESC
          LIMIT ${DIGEST_CANDIDATES}`
      )
      .all<{ product_id: string; requesters: number; digest_requesters: number; last_request_at: string; name: string; name_ar: string }>();
    const crossing = (results ?? []).filter((r) => crossedDigestThreshold(Number(r.requesters), Number(r.digest_requesters)));
    if (!crossing.length) return report;

    if (!spend(1)) return report;
    const nowIso = new Date(nowMs).toISOString();
    const claim = await db
      .prepare(
        `UPDATE product_price_request_stats SET digest_requesters = requesters, digest_at = ?
          WHERE product_id IN (SELECT value FROM json_each(?)) AND requesters > digest_requesters`
      )
      .bind(nowIso, JSON.stringify(crossing.map((r) => r.product_id)))
      .run();
    if (!(Number(claim.meta?.changes ?? 0) > 0)) return report;

    const shown = crossing.slice(0, DIGEST_LINES);
    const lines = shown.map((r) => {
      const name = String(r.name_ar || r.name || r.product_id);
      const when = shortTime(String(r.last_request_at ?? ''));
      return `• ${name}: ${requestersText(Number(r.requesters), 'ar')}${when ? ` — آخر طلب ${when}` : ''}\n${adminFocusLink(env, r.product_id)}`;
    });
    const more = crossing.length - shown.length;
    const text = `🔔 طلبات السعر\n${lines.join('\n')}${more > 0 ? `\n(+${more} منتجات أخرى)` : ''}`;
    const sent = await announceToAdmins(env, 'report', text);
    report.sent = true;
    report.products = crossing.length;
    void sent;
  } catch (error) {
    console.error('price request digest failed:', error instanceof Error ? error.name : 'unknown');
  }
  return report;
}

/** Best-effort nudge after a V2 write (sub-minute latency); the quarter-hour tick stays the authority. */
export async function sweepPriceRequestsFor(env: Env, productId: string, opts: { budget?: number } = {}): Promise<PriceRequestSweepReport> {
  let used = 0;
  const limit = opts.budget ?? 30;
  return sweepPriceRequests(
    env,
    {
      canSpend: (n) => used + n <= limit,
      spend: (n) => (used + n > limit ? false : ((used += n), true)),
      remaining: () => limit - used,
    },
    { productIds: [productId] }
  );
}
