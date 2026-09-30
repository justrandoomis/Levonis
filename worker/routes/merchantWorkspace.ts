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
 * THE FIRST ROWS (merchant platform v2 §3.2, Today's sub-rows). The orders,
 * inbox and stock sources also carry `first[]` — at most FIRST_ROWS of what
 * the count counts, newest first, each with its own address — so the Command
 * Center can confirm an order or restock a product ON the row. They come from
 * the SAME read: the count and its first rows are ONE statement — the rows
 * ride as a JSON aggregate column beside the count — so the rule above («one
 * statement per source») still holds and there is no second wave. (Not a
 * `db.batch`: a batch is a transaction, and the sources run concurrently, so
 * two batches in flight would nest one transaction inside another.) The inbox
 * pairs its count helper with the rows in one `Promise.all`. A `returns`
 * source counts the return cases still open on this merchant's orders
 * (worker/routes/returns.ts writes them, the admin decides them — the field
 * is read-only here).
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
import { baghdadDay } from '../lib/baghdadTime';
import { ATTENTION_WINDOW_DAYS, readVitalsDays, speedAttention } from '../lib/storeSpeed';

export const merchantAttentionRoutes = new Hono<AppContext>();
merchantAttentionRoutes.use('*', requireAuth);

export const merchantSearchRoutes = new Hono<AppContext>();
merchantSearchRoutes.use('*', requireAuth);

/** The store-order states that wait on the MERCHANT (shipped waits on the customer). */
export const ACTION_STAGES = ['pending', 'confirmed', 'processing'] as const;
type ActionStage = (typeof ACTION_STAGES)[number];

/** Coupons ending within this many days are «ending soon». */
export const COUPON_ENDING_DAYS = 7;

/** How many of a ticket's rows Today shows under it (the rest are behind its door). */
export const FIRST_ROWS = 2;

/** A return case the customer is still waiting on (worker/routes/returns.ts `RETURN_STATES`). */
const OPEN_RETURN_SQL = `rc.state NOT IN ('rejected','resolved')`;

/** The `first` column of a source's statement, back into rows (a bad value is no rows). */
function firstRows<T>(v: unknown): T[] {
  const parsed = safeParse<unknown>(typeof v === 'string' ? v : '[]', []);
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

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

  const [orders, custom, inbox, notices, requests, stock, reviews, returns, money, payouts, coupons, problems, setup, speed] = await Promise.all([
    source('orders', async () => {
      // The counts by stage, and the first pending orders as a JSON column of
      // the same statement — one read, never a second wave.
      const row = await db
        .prepare(
          `SELECT
             (SELECT json_group_object(status, n) FROM (
                SELECT status, COUNT(*) AS n FROM orders
                 WHERE merchant_id = ?1 AND status IN (${ACTION_STAGES.map((_s, i) => `?${i + 3}`).join(',')})
                 GROUP BY status)) AS counts,
             (SELECT json_group_array(json_object('id', f.id, 'total_iqd', f.total_iqd, 'created_at', f.created_at,
                                                  'customer_name', f.customer_name, 'governorate', f.governorate)) FROM (
                SELECT o.id, o.total_iqd, o.created_at, u.name AS customer_name,
                       CASE WHEN json_valid(o.address_snapshot) THEN COALESCE(json_extract(o.address_snapshot, '$.governorate'), '') ELSE '' END AS governorate
                  FROM orders o JOIN users u ON u.id = o.user_id
                 WHERE o.merchant_id = ?1 AND o.status = 'pending'
                 ORDER BY o.created_at DESC, o.id DESC LIMIT ?2) f) AS first`
        )
        .bind(merchantId, FIRST_ROWS, ...ACTION_STAGES)
        .first<{ counts: string | null; first: string | null }>();
      const counted = safeParse<Record<string, unknown>>(row?.counts ?? '{}', {});
      const by_stage = Object.fromEntries(ACTION_STAGES.map((s) => [s, n(counted?.[s])])) as Record<ActionStage, number>;
      const total = ACTION_STAGES.reduce((sum, s) => sum + by_stage[s], 0);
      const first = firstRows<{ id: string; total_iqd: number; created_at: string; customer_name: string | null; governorate: string | null }>(row?.first)
        .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.id < b.id ? 1 : -1))
        .map((o) => ({
          id: String(o.id),
          customer_name: String(o.customer_name ?? ''),
          total_iqd: n(o.total_iqd),
          governorate: String(o.governorate ?? ''),
          created_at: String(o.created_at),
          link: merchantHref.order(String(o.id)),
        }));
      return {
        total,
        by_stage,
        first,
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
    source('inbox', async () => {
      // The count helper (worker/routes/merchantInbox.ts) and the first unread
      // threads, side by side — one wave. The preview is the latest message
      // FROM THE OTHER SIDE the owner has not read: the words that wait.
      const [counts, firstRows] = await Promise.all([
        inboxUnreadCounts(db, user.id, storeId),
        db
          .prepare(
            `SELECT * FROM (
               SELECT ch.id, ch.last_message_at,
                      (SELECT COUNT(*) FROM chat_messages m
                        WHERE m.chat_id = ch.id AND m.sender_id <> ?1
                          AND (cp.last_read_at IS NULL OR m.created_at > cp.last_read_at)) AS unread,
                      (SELECT substr(m.body, 1, 140) FROM chat_messages m
                        WHERE m.chat_id = ch.id AND m.sender_id <> ?1
                          AND (cp.last_read_at IS NULL OR m.created_at > cp.last_read_at)
                        ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message,
                      (SELECT u.name FROM chat_participants o JOIN users u ON u.id = o.user_id
                        WHERE o.chat_id = ch.id AND o.user_id <> ?1
                        ORDER BY CASE o.role WHEN 'customer' THEN 0 ELSE 1 END LIMIT 1) AS customer_name
                 FROM chats ch
                 JOIN chat_participants cp ON cp.chat_id = ch.id AND cp.user_id = ?1
                WHERE ch.store_id = ?2 AND ch.context_type IN ('store','store_order','request')
                  AND (cp.last_read_at IS NULL OR COALESCE(ch.last_message_at, '') > cp.last_read_at)
             ) t WHERE t.unread > 0
             ORDER BY COALESCE(t.last_message_at, '') DESC, t.id DESC LIMIT ?3`
          )
          .bind(user.id, storeId, FIRST_ROWS)
          .all<{ id: string; last_message_at: string | null; unread: number; last_message: string | null; customer_name: string | null }>(),
      ]);
      return {
        ...counts,
        first: (firstRows.results ?? []).map((t) => ({
          id: t.id,
          customer_name: String(t.customer_name ?? ''),
          last_message: String(t.last_message ?? ''),
          unread: n(t.unread),
          last_message_at: t.last_message_at,
          link: merchantHref.thread(t.id),
        })),
        link: merchantHref.inbox(),
      };
    }),
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
      // The catalogue list's own predicates, over what customers can see —
      // and the first sold-out products (for the restock sheet) as a JSON
      // column of the same statement.
      const row = await db
        .prepare(
          `SELECT SUM(CASE WHEN ${LOW_STOCK_SQL} THEN 1 ELSE 0 END) AS low,
                  SUM(CASE WHEN ${OUT_OF_STOCK_SQL} THEN 1 ELSE 0 END) AS out_n,
                  (SELECT json_group_array(json_object('id', f.id, 'name', f.name, 'name_ar', f.name_ar, 'stock', f.stock)) FROM (
                     SELECT p.id, p.name, p.name_ar, p.stock
                       FROM community_products p
                      WHERE p.merchant_id = ?1 AND p.publish_state = 'published' AND ${OUT_OF_STOCK_SQL}
                      ORDER BY p.updated_at DESC, p.id DESC LIMIT ?2) f) AS first
             FROM community_products p
            WHERE p.merchant_id = ?1 AND p.publish_state = 'published'`
        )
        .bind(merchantId, FIRST_ROWS)
        .first<{ low: number | null; out_n: number | null; first: string | null }>();
      return {
        low: n(row?.low),
        out: n(row?.out_n),
        first: firstRows<{ id: string; name: string | null; name_ar: string | null; stock: number }>(row?.first).map((p) => ({
          id: String(p.id),
          name: String(p.name ?? ''),
          name_ar: String(p.name_ar ?? ''),
          stock: n(p.stock),
          link: merchantHref.product(String(p.id)),
        })),
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
    source('returns', async () => {
      // Return cases the customer opened on THIS merchant's orders and Levonis
      // has not yet decided (worker/routes/returns.ts). Read-only: the
      // decision is the admin's; each row is a door to its order.
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS n,
                  (SELECT json_group_array(json_object('id', f.id, 'order_id', f.order_id, 'state', f.state, 'requested_at', f.requested_at)) FROM (
                     SELECT rc.id, rc.order_id, rc.state, rc.requested_at
                       FROM return_cases rc JOIN orders o ON o.id = rc.order_id
                      WHERE o.merchant_id = ?1 AND ${OPEN_RETURN_SQL}
                      ORDER BY rc.requested_at DESC, rc.id DESC LIMIT ?2) f) AS first
             FROM return_cases rc JOIN orders o ON o.id = rc.order_id
            WHERE o.merchant_id = ?1 AND ${OPEN_RETURN_SQL}`
        )
        .bind(merchantId, FIRST_ROWS)
        .first<{ n: number; first: string | null }>();
      return {
        open: n(row?.n),
        first: firstRows<{ id: string; order_id: string; state: string; requested_at: string }>(row?.first).map((r) => ({
          id: String(r.id),
          order_id: String(r.order_id),
          state: String(r.state),
          requested_at: String(r.requested_at),
          link: merchantHref.order(String(r.order_id)),
        })),
        link: merchantHref.orders(),
      };
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
    // «جهّز متجرك» (review of the merchant page, 2026-09-28): what a new store
    // still lacks, each with the screen where it is done. The store row
    // answers the first four; three counts the rest.
    source('setup', async () => {
      const row = await db
        .prepare(
          `SELECT (SELECT COUNT(*) FROM community_products p WHERE p.merchant_id = ?1 AND p.publish_state = 'published') AS products,
                  (SELECT COUNT(*) FROM merchant_delivery_profiles d WHERE d.store_id = ?2) AS delivery,
                  (SELECT COUNT(*) FROM store_layout_revisions r WHERE r.store_id = ?2) AS published`
        )
        .bind(merchantId, storeId)
        .first<{ products: number; delivery: number; published: number }>();
      return {
        logo: !!ctx.store.logo_key,
        banner: !!ctx.store.banner_key,
        about: !!String(ctx.store.description ?? '').trim(),
        phone: !!String(ctx.store.contact_phone ?? '').trim(),
        delivery: n(row?.delivery) > 0,
        products: n(row?.products),
        design: n(row?.published) > 0,
        links: {
          settings: merchantHref.storeSettings(),
          delivery: merchantHref.storeDelivery(),
          products: merchantHref.newProduct(),
          design: merchantHref.storeDesign(),
        },
      };
    }),
    // «سرعة متجري» (P4, worker/lib/storeSpeed.ts S6): a row ONLY when the
    // phone LCP p75 bucket has been poor on three consecutive days with at
    // least thirty samples each. «Nothing to say» is undefined, so the field is
    // absent exactly like a source that could not answer — the Pulse line and
    // the Command Center render no row. Not a member of EVERY_SOURCE.
    source('speed', async () => {
      const today = baghdadDay(now.getTime());
      const rows = await readVitalsDays(db, storeId, 'phone', baghdadDay(now.getTime(), -(ATTENTION_WINDOW_DAYS - 1)));
      const verdict = speedAttention(rows, today);
      return verdict ? { ...verdict, link: merchantHref.storeDesign() } : undefined;
    }),
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
    ...(returns ? { returns } : {}),
    ...(money ? { money } : {}),
    ...(payouts ? { payouts } : {}),
    ...(coupons ? { coupons } : {}),
    ...(problems ? { store: problems } : {}),
    ...(setup ? { setup } : {}),
    ...(speed ? { speed } : {}),
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
