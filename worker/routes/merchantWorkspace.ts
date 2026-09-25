/**
 * THE MERCHANT WORKSPACE'S TWO READS — «what needs me now» and «find it».
 *
 *   GET /api/merchant/attention    every count the Command Center and the
 *                                  workspace's badges show, each with the
 *                                  workspace address that explains it
 *   GET /api/merchant/search?q=    the command palette's server results:
 *                                  orders by number, products by name or SKU,
 *                                  customers by name or phone
 *
 * Two routers, two mounts in worker/index.ts (the routing design names each:
 * services/gateway/src/routes.ts), like finance/payouts.
 *
 * OWNER-ISOLATED BY CONSTRUCTION. Both resolve the caller's store from the
 * SESSION (`requireStoreOwner`) and read nothing from the request that could
 * name another store: there is no store, merchant or user id parameter to
 * swap. Every statement carries the owner's merchant id, store id or user id
 * in its WHERE clause — never the hostname (a store's subdomain says which
 * shop is being VIEWED, not who may read it). A signed-in owner of store A who
 * calls these on store B's host reads store A, which is what the workspace on
 * B's host then refuses to show (the own-host rule, audit 01 B16).
 *
 * ABSENT, NEVER ZERO. Each attention field comes from one source that already
 * exists — the orders, the custom-order jobs, the inbox (W2-E), the
 * notification centre (W2-E), the matcher's decisions, the catalogue's own
 * stock predicate (W2-F), the reviews, the ledger's buckets and payout
 * requests (W2-B), the coupons, the store's sanctions and its page draft
 * (W2-C). A source that cannot answer (a table a database has not been
 * migrated to, a failed read) leaves its field OUT of the answer — a «0
 * orders need you» that is really «we could not count» is the one lie this
 * screen must not tell. The requests field is also absent while Levo
 * Community is shut to this merchant (the board it links to would refuse).
 *
 * BATCHED. One statement per source, all in parallel; no statement per row.
 * The search runs three capped statements (5 rows each) with at most four
 * bound parameters apiece — far under D1's 100.
 *
 * RATE-LIMITED like the other merchant reads that a client may call often:
 * the attention read 120/min (the shell refreshes it on focus and every 90s),
 * the search 60/min (the palette debounces it).
 *
 * REFUSALS (stable codes): 401 UNAUTHORIZED · 404 NOT_FOUND (no store) ·
 * 429 RATE_LIMITED · search only: 400 SEARCH_QUERY_TOO_SHORT (under 2
 * characters) · 400 SEARCH_QUERY_TOO_LONG (over 60).
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { safeParse } from '../lib/types';
import { HttpError, requireAuth } from '../lib/http';
import { rateLimit } from '../lib/ratelimit';
import { requireStoreOwner, type StoreContext } from '../lib/merchantAuth';
import { getTierStatus, benefits } from '../lib/entitlements';
import { communityMayEnter, readCommunityGate } from '../lib/communityGate';
import { merchantUnreadCounts } from '../lib/merchantNotify';
import { merchantBuckets } from '../lib/merchantLedger';
import { publishedLayout } from '../lib/storeLayout';
import { likePattern, sqlLikeClause } from '../lib/sqlLike';
import { normalizeLayout } from '@levonis/storeLayout/normalize';
import { inboxUnreadCounts } from './merchantInbox';
import { LOW_STOCK_SQL, OUT_OF_STOCK_SQL } from './merchantCatalog';
import { merchantHref } from '@levonis/contracts/merchantRoutes';

export const merchantAttentionRoutes = new Hono<AppContext>();
merchantAttentionRoutes.use('*', requireAuth);

export const merchantSearchRoutes = new Hono<AppContext>();
merchantSearchRoutes.use('*', requireAuth);

/** The store-order states that wait on the MERCHANT (shipped waits on the customer). */
export const ACTION_STAGES = ['pending', 'confirmed', 'processing'] as const;
type ActionStage = (typeof ACTION_STAGES)[number];

/** Coupons ending within this many days are «ending soon». */
export const COUPON_ENDING_DAYS = 7;

/** The store problems the Command Center names, each with where it is fixed. */
export type StoreProblem =
  | 'store_suspended'
  | 'merchant_suspended'
  | 'merchant_restricted'
  | 'store_paused'
  | 'subscription_inactive'
  | 'benefit_restricted'
  | 'layout_unpublished';

/**
 * One source, or nothing. A failure is logged and the field is left out —
 * the caller spreads the result, so an absent source is an absent key.
 */
async function source<T>(name: string, read: () => Promise<T | undefined>): Promise<T | undefined> {
  try {
    return await read();
  } catch (e) {
    console.error(`workspace attention: ${name} could not be counted`, e instanceof Error ? e.message : String(e));
    return undefined;
  }
}

const n = (v: unknown) => Number(v) || 0;

/** Does the draft of the store page differ from what visitors see? Null: no draft to compare. */
async function layoutUnpublished(db: D1Database, ctx: StoreContext): Promise<boolean> {
  const draft = await db
    .prepare('SELECT layout_json FROM store_layout_drafts WHERE store_id = ?')
    .bind(ctx.store.id)
    .first<{ layout_json: string }>();
  if (!draft) return false;
  const published = await publishedLayout(db, ctx);
  const draftLayout = normalizeLayout(safeParse<unknown>(draft.layout_json, null), { ownerUserId: ctx.store.user_id }).layout;
  // The same comparison the design panel's own read makes (worker/routes/storeLayout.ts `dirty`).
  return JSON.stringify(draftLayout) !== JSON.stringify(published.layout);
}

async function storeProblems(c: Context<AppContext>, ctx: StoreContext): Promise<Array<{ code: StoreProblem; link: string }>> {
  const out: Array<{ code: StoreProblem; link: string }> = [];
  const settings = merchantHref.storeSettings();
  // The two sanctions are separate rows and are named separately (worker/lib/merchantAuth.ts).
  if (ctx.store.status === 'suspended') out.push({ code: 'store_suspended', link: settings });
  if (ctx.merchant.status === 'suspended') out.push({ code: 'merchant_suspended', link: settings });
  else if (ctx.merchant.status !== 'active') out.push({ code: 'merchant_restricted', link: settings });
  if (ctx.store.status === 'paused') out.push({ code: 'store_paused', link: settings });
  const tier = await getTierStatus(c.env.DB, ctx.store.user_id);
  // The same order `sellingVerdict` asks it in: a restricted benefit is not a lapse.
  if ((tier.gated_benefits ?? []).includes('merchantStore')) out.push({ code: 'benefit_restricted', link: '/support' });
  else if (!benefits.merchantStore(tier)) out.push({ code: 'subscription_inactive', link: '/subscription' });
  const draft = await source('layout draft', () => layoutUnpublished(c.env.DB, ctx));
  if (draft) out.push({ code: 'layout_unpublished', link: merchantHref.storeDesign() });
  return out;
}

merchantAttentionRoutes.get('/', async (c) => {
  await rateLimit(c, 'merchant-attention', 120, 60);
  const ctx = await requireStoreOwner(c);
  const user = c.get('user')!;
  const db = c.env.DB;
  const merchantId = ctx.merchant.id;
  const storeId = ctx.store.id;
  const now = new Date();
  const nowIso = now.toISOString();

  const [orders, custom, inbox, notices, requests, stock, reviews, money, payouts, coupons, problems] = await Promise.all([
    source('orders', async () => {
      const { results } = await db
        .prepare(
          `SELECT status, COUNT(*) AS n FROM orders
            WHERE merchant_id = ? AND status IN (${ACTION_STAGES.map(() => '?').join(',')})
            GROUP BY status`
        )
        .bind(merchantId, ...ACTION_STAGES)
        .all<{ status: ActionStage; n: number }>();
      const by_stage = Object.fromEntries(ACTION_STAGES.map((s) => [s, 0])) as Record<ActionStage, number>;
      for (const r of results ?? []) if (r.status in by_stage) by_stage[r.status] = n(r.n);
      const total = ACTION_STAGES.reduce((sum, s) => sum + by_stage[s], 0);
      return {
        total,
        by_stage,
        link: merchantHref.orders(),
        links: Object.fromEntries(ACTION_STAGES.map((s) => [s, merchantHref.ordersInStatus(s)])) as Record<ActionStage, string>,
      };
    }),
    source('custom orders', async () => {
      const row = await db
        .prepare(
          `SELECT SUM(CASE WHEN state = 'funded' THEN 1 ELSE 0 END) AS to_start,
                  SUM(CASE WHEN state = 'in_progress' THEN 1 ELSE 0 END) AS in_progress
             FROM community_orders WHERE merchant_id = ?`
        )
        .bind(merchantId)
        .first<{ to_start: number | null; in_progress: number | null }>();
      const to_start = n(row?.to_start);
      const in_progress = n(row?.in_progress);
      return { to_start, in_progress, total: to_start + in_progress, link: merchantHref.customOrders() };
    }),
    source('inbox', async () => ({ ...(await inboxUnreadCounts(db, user.id, storeId)), link: merchantHref.inbox() })),
    source('notifications', () => merchantUnreadCounts(db, user.id)),
    source('matching requests', async () => {
      // The board is Levo Community: while it is shut to this merchant, the
      // count would point at a door that refuses — so the field is absent.
      if (!communityMayEnter(await readCommunityGate(db), user)) return undefined;
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS n
             FROM community_request_matches m
             JOIN community_requests r ON r.id = m.request_id
            WHERE m.merchant_id = ?1 AND m.eligible = 1 AND m.revision = r.revision
              AND r.state IN ('open','receiving_offers') AND r.visibility = 'public'
              AND (r.expires_at IS NULL OR r.expires_at > ?2)
              AND NOT EXISTS (SELECT 1 FROM community_offers o WHERE o.request_id = r.id AND o.merchant_id = ?1)`
        )
        .bind(merchantId, nowIso)
        .first<{ n: number }>();
      return { matching: n(row?.n), link: merchantHref.requests() };
    }),
    source('stock', async () => {
      // The catalogue list's own predicates, over what customers can see.
      const row = await db
        .prepare(
          `SELECT SUM(CASE WHEN ${LOW_STOCK_SQL} THEN 1 ELSE 0 END) AS low,
                  SUM(CASE WHEN ${OUT_OF_STOCK_SQL} THEN 1 ELSE 0 END) AS out_n
             FROM community_products p
            WHERE p.merchant_id = ? AND p.publish_state = 'published'`
        )
        .bind(merchantId)
        .first<{ low: number | null; out_n: number | null }>();
      return {
        low: n(row?.low),
        out: n(row?.out_n),
        link_low: merchantHref.productsInStock('low'),
        link_out: merchantHref.productsInStock('out'),
      };
    }),
    source('reviews', async () => {
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS n FROM merchant_reviews
            WHERE merchant_id = ? AND merchant_reply = '' AND hidden = 0`
        )
        .bind(merchantId)
        .first<{ n: number }>();
      return { unanswered: n(row?.n) };
    }),
    source('money', async () => {
      const b = await merchantBuckets(db, merchantId);
      return { available_iqd: b.available, pending_iqd: b.pending, link: merchantHref.money() };
    }),
    source('payouts', async () => {
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS n, COALESCE(SUM(amount_iqd), 0) AS amount
             FROM merchant_payouts WHERE merchant_id = ? AND state IN ('requested','approved')`
        )
        .bind(merchantId)
        .first<{ n: number; amount: number }>();
      return { in_flight: n(row?.n), amount_iqd: n(row?.amount), link: merchantHref.money() };
    }),
    source('coupons', async () => {
      const until = new Date(now.getTime() + COUPON_ENDING_DAYS * 86_400_000).toISOString();
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS n, MIN(ends_at) AS first_ends_at FROM merchant_coupons
            WHERE store_id = ? AND active = 1 AND ends_at IS NOT NULL AND ends_at > ? AND ends_at <= ?`
        )
        .bind(storeId, nowIso, until)
        .first<{ n: number; first_ends_at: string | null }>();
      return { ending_soon: n(row?.n), first_ends_at: row?.first_ends_at ?? null, within_days: COUPON_ENDING_DAYS, link: merchantHref.coupons() };
    }),
    source('store', async () => ({ problems: await storeProblems(c, ctx) })),
  ]);

  const attention: Record<string, unknown> = {
    ...(orders ? { orders } : {}),
    ...(custom ? { custom_orders: custom } : {}),
    ...(inbox ? { inbox } : {}),
    ...(notices ? { notifications: { unread: notices.total, link: merchantHref.notifications() } } : {}),
    ...(requests ? { requests } : {}),
    ...(stock ? { stock } : {}),
    // «New since you last looked» is the review notices still unread in the
    // centre — the only record of what the owner has seen. Both halves are
    // needed for the field; either missing leaves the other alone.
    ...(reviews || notices
      ? {
          reviews: {
            ...(notices ? { new: n(notices.by_kind.new_review) } : {}),
            ...(reviews ?? {}),
            link: merchantHref.reviews(),
          },
        }
      : {}),
    ...(money ? { money } : {}),
    ...(payouts ? { payouts } : {}),
    ...(coupons ? { coupons } : {}),
    ...(problems ? { store: problems } : {}),
  };

  c.header('Cache-Control', 'private, no-store');
  return c.json({ success: true, generated_at: nowIso, attention });
});

// ----------------------------------------------------------------- search

/** Rows per kind — a palette shows a handful, and a merchant types more to narrow. */
export const SEARCH_LIMIT = 5;
export const SEARCH_MIN = 2;
export const SEARCH_MAX = 60;

/** Arabic-Indic and Persian digits to ASCII, everything but digits dropped. */
export function phoneDigits(raw: string): string {
  const ascii = raw.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  const digits = ascii.replace(/\D/g, '');
  // The national trunk 0 and the country code are how the same number is
  // written two ways (07701234567 / +9647701234567); the rest is what matches.
  return digits.replace(/^(00964|964|0)/, '');
}

merchantSearchRoutes.get('/', async (c) => {
  await rateLimit(c, 'merchant-search', 60, 60);
  const ctx = await requireStoreOwner(c);
  const q = String(c.req.query('q') ?? '').trim();
  if ([...q].length < SEARCH_MIN) throw new HttpError(400, `Type at least ${SEARCH_MIN} characters`, 'SEARCH_QUERY_TOO_SHORT');
  if ([...q].length > SEARCH_MAX) throw new HttpError(400, `At most ${SEARCH_MAX} characters`, 'SEARCH_QUERY_TOO_LONG');
  const db = c.env.DB;
  const merchantId = ctx.merchant.id;
  const pattern = likePattern(q);
  const digits = phoneDigits(q);
  // A phone is searched only from 4 digits up: fewer match half the book.
  const phone = digits.length >= 4 ? likePattern(digits) : '';

  const [orders, products, customers] = await Promise.all([
    db
      .prepare(
        `SELECT o.id, o.status, o.total_iqd, o.created_at
           FROM orders o
          WHERE o.merchant_id = ?1 AND ${sqlLikeClause(['o.id'], '?2')}
          ORDER BY o.created_at DESC, o.id DESC LIMIT ?3`
      )
      .bind(merchantId, pattern, SEARCH_LIMIT)
      .all<{ id: string; status: string; total_iqd: number; created_at: string }>(),
    db
      .prepare(
        `SELECT p.id, p.name, p.name_ar, p.publish_state, p.price_iqd
           FROM community_products p
          WHERE p.merchant_id = ?1
            AND (${sqlLikeClause(['p.name', 'p.name_ar', 'p.sku'], '?2')}
                 OR EXISTS (SELECT 1 FROM community_product_variants v WHERE v.product_id = p.id AND ${sqlLikeClause(['v.sku'], '?2')}))
          ORDER BY p.created_at DESC, p.id DESC LIMIT ?3`
      )
      .bind(merchantId, pattern, SEARCH_LIMIT)
      .all<{ id: string; name: string; name_ar: string; publish_state: string; price_iqd: number }>(),
    // Only people who have ordered from THIS store (never a user directory,
    // §60); each leads to their latest order with this store. No user id and
    // no phone number leave the server — the phone is matched, not returned.
    // Only the phones this store was already GIVEN on its own orders (the
    // address snapshot): the ACCOUNT phone (users.phone_e164) is never matched,
    // or a merchant could rebuild it digit by digit from the result list
    // (review W2-5 p7).
    db
      .prepare(
        `SELECT u.name AS name, COUNT(o.id) AS order_count, MAX(o.created_at) AS last_order_at,
                (SELECT o2.id FROM orders o2 WHERE o2.merchant_id = ?1 AND o2.user_id = u.id
                  ORDER BY o2.created_at DESC, o2.id DESC LIMIT 1) AS last_order_id
           FROM orders o JOIN users u ON u.id = o.user_id
          WHERE o.merchant_id = ?1
            AND (${sqlLikeClause(['u.name'], '?2')}
                 OR (?3 <> '' AND
                   ${sqlLikeClause(["replace(replace(replace(CASE WHEN json_valid(o.address_snapshot) THEN COALESCE(json_extract(o.address_snapshot, '$.phone'), '') ELSE '' END, ' ', ''), '-', ''), '+', '')"], '?3')}))
          GROUP BY u.id, u.name
          ORDER BY last_order_at DESC LIMIT ?4`
      )
      .bind(merchantId, pattern, phone, SEARCH_LIMIT)
      .all<{ name: string | null; order_count: number; last_order_at: string; last_order_id: string }>(),
  ]);

  c.header('Cache-Control', 'private, no-store');
  return c.json({
    success: true,
    q,
    orders: (orders.results ?? []).map((o) => ({
      id: o.id,
      status: o.status,
      total_iqd: n(o.total_iqd),
      created_at: o.created_at,
      link: merchantHref.order(o.id),
    })),
    products: (products.results ?? []).map((p) => ({
      id: p.id,
      name: p.name ?? '',
      name_ar: p.name_ar ?? '',
      publish_state: p.publish_state,
      price_iqd: n(p.price_iqd),
      link: merchantHref.product(p.id),
    })),
    customers: (customers.results ?? []).map((r) => ({
      name: r.name ?? '',
      order_count: n(r.order_count),
      last_order_at: r.last_order_at,
      link: merchantHref.order(r.last_order_id),
    })),
  });
});
