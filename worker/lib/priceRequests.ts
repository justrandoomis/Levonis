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
  DIGEST_STEPS,
  PRICE_REQUEST_ADMIN_TEXT,
  crossedDigestThreshold,
  priceAvailableMessage,
  requestersText,
  type PriceRequestText,
} from '@levonis/contracts/priceRequests';
import type { Env } from './types';
import type { ProductDoc } from './productModel';
import { applyRelations, loadRelationsView, loadRelationsViews } from './productOverlay';
import { parseProductRow } from './productModel';
import { unitNamesOf } from './pricingEngine/legacy';
import { listing } from './listing';
import { checkSelection, skuPriced } from './commercialState';
import { quoteOptionValueIds } from '../routes/products';
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
 * statement, appended to every batch that writes requests. The digest's
 * high-water mark follows the count DOWN (never up: only the digest's claim
 * raises it), so demand that returns after the open rows were told or
 * withdrawn is announced again from its new start.
 */
const STATS_SQL = `INSERT INTO product_price_request_stats (product_id, requesters, selections, clicks, last_request_at, updated_at)
SELECT ?1, COUNT(DISTINCT user_id), COUNT(DISTINCT selection), COALESCE(SUM(click_count), 0), COALESCE(MAX(requested_at), ''), ?2
  FROM product_price_requests WHERE product_id = ?1 AND state = 'open'
ON CONFLICT(product_id) DO UPDATE SET requesters = excluded.requesters, selections = excluded.selections,
  clicks = excluded.clicks, last_request_at = excluded.last_request_at, updated_at = excluded.updated_at,
  digest_requesters = MIN(product_price_request_stats.digest_requesters, excluded.requesters)`;

export const statsRecompute = (db: D1Database, productId: string, now: string): D1PreparedStatement =>
  db.prepare(STATS_SQL).bind(productId, now);

// ------------------------------------------------------------- the selection, validated

/** What a request asks about, as the door receives it: the option values and colour chosen (none: the product itself). */
export interface PriceRequestSelectionInput {
  option_value_ids?: readonly unknown[] | null;
  color_id?: unknown;
}

/** The longest id a selection may name (the door's own bound). */
const SELECTION_ID_MAX = 60;

export type PriceRequestSelectionVerdict =
  | { ok: true; product_id: string; key: string; option_value_ids: string[]; color_id: string | null; sellable: boolean }
  /** Not VISIBLE: an invented id, a draft and a product hidden for a catalogue gap answer the same. */
  | { ok: false; status: 404; code: 'PRODUCT_NOT_FOUND' }
  | { ok: false; status: 400; code: 'PRICE_REQUEST_SELECTION_INVALID' | 'PRICE_REQUEST_SELECTION_REQUIRED' }
  | { ok: false; status: 409; code: 'PRICE_REQUEST_ALREADY_PRICED'; key: string };

/**
 * IS THIS A SELECTION A CUSTOMER MAY ASK THE PRICE OF? (DECISIONS row 240; spec
 * §4.3 steps 3–6; the Bambu import spec §K.1 D-5.) The pure validation of
 * `POST /api/price-requests`, shared by the door and by the import's
 * `/complete`, which checks each product's default selection the same way:
 *
 *   3. the product is VISIBLE (an ordinary product, not a composition) — else
 *      404, the same for an invented id, a draft and a hidden product;
 *   4. its document and relations are loaded;
 *   5. the selection is parsed with the quote's own parser and checked against
 *      the product's real options, colours and SKUs: a required group or
 *      colour missing is SELECTION_REQUIRED, anything else that is not one of
 *      its SKUs (another product's value, a retired colour, a colour not sold
 *      with that model, a merged value, a non-text id) SELECTION_INVALID;
 *   6. a sellable product whose SKU has a price is ALREADY_PRICED.
 *
 * READS ONLY: no row is created, no counter moves, and the 0193 tables are
 * not touched (a database without them validates the same).
 */
export async function validatePriceRequestSelection(
  db: D1Database,
  productId: string,
  selection: PriceRequestSelectionInput = {}
): Promise<PriceRequestSelectionVerdict> {
  const invalid = { ok: false, status: 400, code: 'PRICE_REQUEST_SELECTION_INVALID' } as const;
  const raw = selection.option_value_ids;
  const values = Array.isArray(raw)
    ? raw.filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= SELECTION_ID_MAX)
    : [];
  if (Array.isArray(raw) && values.length !== raw.length) return invalid;
  const colorRaw = selection.color_id;
  if (colorRaw !== undefined && colorRaw !== null && typeof colorRaw !== 'string') return invalid;
  const color = typeof colorRaw === 'string' ? colorRaw.trim() : '';
  if (color.length > SELECTION_ID_MAX) return invalid;

  // 3. VISIBLE only, with the SELLABLE flag in the same read.
  const L = await listing(db);
  const row = await db
    .prepare(`SELECT *, ${L.sellableFlag('products')} AS sellable_now FROM products WHERE id = ? AND ${L.visible('products')} AND composition = ''`)
    .bind(productId)
    .first<Record<string, unknown>>();
  if (!row) return { ok: false, status: 404, code: 'PRODUCT_NOT_FOUND' };

  // 4–5. The selection, checked on the server against the product's real options, colours and combinations.
  const view = await loadRelationsView(db, productId, row.inventory_mode);
  const doc = applyRelations(parseProductRow(row), view);
  const checked = checkSelection(doc, view, quoteOptionValueIds(values, null, view), color || null);
  if (!checked.ok) return { ok: false, status: 400, code: checked.code };

  // 6. Already priced and sellable: there is nothing to ask — the page refreshes and sells it.
  const sellable = Number(row.sellable_now) === 1;
  if (sellable && skuPriced(doc, checked.key)) return { ok: false, status: 409, code: 'PRICE_REQUEST_ALREADY_PRICED', key: checked.key };
  return { ok: true, product_id: productId, key: checked.key, option_value_ids: checked.optionValueIds, color_id: checked.colorId, sellable };
}

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

/** Products a pass looks at, and the rows it reads for each (10 × 20: the read stays one bounded statement). */
const SWEEP_PRODUCTS = 10;
const ROWS_PER_PRODUCT = 20;
/** The cursor and the stats recompute closing every write batch of the sweep. */
const SWEEP_TAIL = 2;
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
 * least recently checked first, and up to 20 rows of each. A request is
 * priced iff its product is SELLABLE and its selection has a live SKU price
 * (`skuPriced`; a sellable product that is not strict prices every
 * selection). Every statement is charged before it is sent. PROGRESS PER ROW:
 * the cursor (`checked_at`) moves only for the rows a pass actually decided,
 * so a row the budget could not carry is first in line next tick, and a
 * product with many people to tell takes a fair share of the pass and never
 * blocks the products after it. Never throws.
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

    // 4. The rows: at most ROWS_PER_PRODUCT of each product, its least recently checked first (one statement).
    //    A per-product bound, so a product with hundreds of open rows never crowds the others out of the read.
    if (!spend(1)) return report;
    const { results: rowResults } = await db
      .prepare(
        `SELECT id, user_id, product_id, selection, state, notify, cycle FROM (
           SELECT id, user_id, product_id, selection, state, notify, cycle,
                  ROW_NUMBER() OVER (PARTITION BY product_id ORDER BY checked_at, requested_at, id) AS rn
             FROM product_price_requests
            WHERE product_id IN (SELECT value FROM json_each(?)) AND state IN ('open','priced'))
          WHERE rn <= ${ROWS_PER_PRODUCT}
          ORDER BY product_id, rn`
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

    // 6a. Each row's own writes (a unit: self-contained, so units of one product may go in different batches).
    interface Unit {
      id: string;
      stmts: D1PreparedStatement[];
      kind: 'notified' | 'closed' | 'priced' | 'reopened';
    }
    const waiting: string[] = [];
    const work = new Map<string, Unit[]>();
    for (const r of rows) {
      const doc = docs.get(r.product_id) ?? null;
      let unit: Unit | null = null;
      if (!isPriced(r)) {
        // A delivery-pending row whose product is no longer priced waits again as an open request.
        if (r.state === 'priced') {
          unit = {
            id: r.id,
            kind: 'reopened',
            stmts: [db.prepare("UPDATE product_price_requests SET state = 'open', priced_at = '' WHERE id = ? AND state = 'priced'").bind(r.id)],
          };
        }
      } else if (Number(r.notify) !== 1) {
        unit = {
          id: r.id,
          kind: 'closed',
          stmts: [
            db
              .prepare(
                "UPDATE product_price_requests SET state = 'closed', close_reason = 'priced', priced_at = ?, closed_at = ? WHERE id = ? AND state IN ('open','priced')"
              )
              .bind(now, now, r.id),
          ],
        };
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
        unit = {
          id: r.id,
          kind: 'notified',
          stmts: [
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
              entity_id: r.product_id,
              meta: { request_id: r.id, selection: r.selection, title_ckb: title.ckb, body_ckb: body.ckb },
              eventKey,
            }).stmt,
            ...plan.statements,
          ],
        };
      } else {
        // The delivery plan cannot be built this tick (the reach read failed or was not affordable): flip to
        // `priced` only — the next tick builds it.
        unit = {
          id: r.id,
          kind: 'priced',
          stmts: [db.prepare("UPDATE product_price_requests SET state = 'priced', priced_at = ? WHERE id = ? AND state = 'open'").bind(now, r.id)],
        };
      }
      if (unit) {
        const list = work.get(r.product_id) ?? [];
        list.push(unit);
        work.set(r.product_id, list);
      } else {
        waiting.push(r.id);
      }
    }

    // 6b. The rows that only wait (nothing to write): their cursor moves in ONE statement, first, so a product
    //     with nothing to do rotates out of the next pick whatever the rest of the pass can afford.
    if (waiting.length) {
      if (!spend(1)) return report;
      await db
        .prepare("UPDATE product_price_requests SET checked_at = ? WHERE id IN (SELECT value FROM json_each(?)) AND state IN ('open','priced')")
        .bind(now, JSON.stringify(waiting))
        .run();
    }

    // 6c. The rows with writes, product by product, each product taking a fair share of what is left (never less
    //     than its first row and the tail). A batch carries its rows' writes, THEIR cursor and the stats
    //     recompute (the tail, 2 statements), and is charged before it is sent. A row that does not fit waits
    //     with its cursor unmoved, so the next tick starts there; a product never blocks the ones after it.
    const busy = ids.filter((id) => work.has(id));
    for (let i = 0; i < busy.length; i++) {
      const productId = busy[i];
      const units = work.get(productId) ?? [];
      const remaining = budget.remaining();
      const first = units[0] ? units[0].stmts.length + SWEEP_TAIL : SWEEP_TAIL;
      if (first > remaining) continue;
      const allowance = Math.min(remaining, Math.max(Math.floor(remaining / (busy.length - i)), first));
      let used = 0;
      let current: Unit[] = [];
      let size = 0;
      const send = async (): Promise<boolean> => {
        if (!current.length) return true;
        const stmts = current.flatMap((u) => u.stmts);
        stmts.push(
          db
            .prepare("UPDATE product_price_requests SET checked_at = ? WHERE id IN (SELECT value FROM json_each(?)) AND state IN ('open','priced')")
            .bind(now, JSON.stringify(current.map((u) => u.id))),
          statsRecompute(db, productId, now)
        );
        if (!spend(stmts.length)) return false;
        await db.batch(stmts);
        for (const u of current) report[u.kind] += 1;
        used += stmts.length;
        current = [];
        size = 0;
        return true;
      };
      let stop = false;
      for (const u of units) {
        const need = u.stmts.length;
        // A batch stays within BATCH_MAX with its tail.
        if (current.length && size + need + SWEEP_TAIL > BATCH_MAX) {
          if (!(await send())) {
            stop = true;
            break;
          }
        }
        // The product's share: the rows planned so far, this one, and the open batch's tail.
        if (used + size + need + SWEEP_TAIL > allowance) break;
        current.push(u);
        size += need;
      }
      if (stop || !(await send())) break;
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
/** The reads the admin routing makes before it sends (worker/lib/telegramAdmin.ts: the bound group and its topics). */
const ANNOUNCE_READS = 2;

const COLUMN = /^(?:[a-z]+\.)?[a-z_]+$/;

/**
 * `digestThreshold` (packages/contracts/src/priceRequests.ts) as SQL over the
 * integer column `col`: the highest step at or below it, every further 100
 * past the last. A constant built from the contract's steps, never from input.
 */
export function digestThresholdSql(col: string): string {
  if (!COLUMN.test(col)) throw new Error(`PRICE_REQUEST_INVARIANT: bad column ${JSON.stringify(col)}`);
  const top = DIGEST_STEPS[DIGEST_STEPS.length - 1];
  const steps = [...DIGEST_STEPS].reverse().filter((s) => s !== top);
  return `(CASE WHEN ${col} >= ${top} THEN (${col} / ${top}) * ${top}${steps.map((s) => ` WHEN ${col} >= ${s} THEN ${s}`).join('')} ELSE 0 END)`;
}

/** «crossed a threshold since its last announcement», as SQL over a stats row (alias optional). */
const crossedSql = (alias = ''): string => {
  const a = alias ? `${alias}.` : '';
  return `${digestThresholdSql(`${a}requesters`)} > ${digestThresholdSql(`${a}digest_requesters`)}`;
};

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
          WHERE ${crossedSql('st')}
          ORDER BY st.requesters DESC, st.last_request_at DESC
          LIMIT ${DIGEST_CANDIDATES}`
      )
      .all<{ product_id: string; requesters: number; digest_requesters: number; last_request_at: string; name: string; name_ar: string }>();
    const crossing = (results ?? []).filter((r) => crossedDigestThreshold(Number(r.requesters), Number(r.digest_requesters)));
    if (!crossing.length) return report;

    // The claim and the routing's own reads before the send, charged together: no claim the send cannot follow.
    if (!spend(1 + ANNOUNCE_READS)) return report;
    const nowIso = new Date(nowMs).toISOString();
    const claim = await db
      .prepare(
        `UPDATE product_price_request_stats SET digest_requesters = requesters, digest_at = ?
          WHERE product_id IN (SELECT value FROM json_each(?)) AND ${crossedSql()}`
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
