/**
 * Platform administration of the community — /api/admin/community/*.
 *
 * Mounted under /api/admin, which worker/index.ts serves ONLY on the apex
 * host. A merchant storefront cannot reach these routes at all, whatever it
 * puts in a request — that host guard is what makes wildcard subdomains and a
 * shared session cookie safe together (§53).
 *
 * TWO PRINCIPLES RUN THROUGH EVERY HANDLER:
 *
 *   Suspending is not deleting (§46). An abusive merchant loses the ability
 *   to trade, and keeps every order, payout row, review and dispute they are
 *   party to. Their customers keep their history too — punishing a merchant
 *   must not erase what someone else bought.
 *
 *   A settlement decision is a RECORD, not an edit. Releasing or refunding a
 *   disputed escrow appends events and ledger rows; it never rewrites the
 *   amounts. An admin can be asked, months later, exactly what they decided
 *   and on what day, and the answer comes from the data (§45).
 */

import { likePattern, sqlLikeClause } from '../lib/sqlLike';
import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAdmin, badRequest, conflict, notFound, str, int, oneOf, HttpError } from '../lib/http';
import { newId } from '../lib/crypto';
import { audit } from '../lib/audit';
import { getSetting } from '../lib/settings';
import { releaseEscrow, refundEscrow, escrowForOrder, getEscrow, merchantBalance, merchantAvailableSql } from '../lib/escrowOps';
import { badgeFor } from '../lib/merchantOps';
import {
  COMMUNITY_GATE_SETTING_KEY,
  readCommunityGate,
} from '../lib/communityGate';
import { canMoveOffer, type OfferState } from '../lib/communityStates';
import { offerCountStatement, requestMovedFence, revokeViewerTokensStatement } from '../lib/communityRequests';
import { isConstraintAbort } from '../lib/walletOps';
import { chunk } from '../lib/inventory';
import { notifyComplaintReply } from '../lib/engagementNotify';
import { headMediaObject, isSafeMediaKey } from '../lib/mediaStorage';
import { maskPhone, normalizePhone } from '../lib/phone';
import { refreshMerchantRating } from './merchantReviews';
import { COMPLAINT_AWAITS_DESK_SQL } from './adminChats';
import { requireFinancialScope } from '../lib/walletAdjust';
import { canViewFinancials } from '../lib/adminScope';
import { rootDomainFrom, storeUrl } from '../lib/hosts';

export const adminCommunityRoutes = new Hono<AppContext>();
adminCommunityRoutes.use('*', requireAdmin);

const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------- overview

/**
 * The marketplace at a glance.
 *
 * THE MONEY TILES COUNT MONEY THAT MOVED AND STAYED (audit 04 #22). «عمولة
 * المنصة» and «إجمالي المبيعات» summed every custom order ever created —
 * cancelled and refunded ones included, an accepted-but-never-funded one too —
 * and left out the commission on store sales altogether. Custom work is now
 * counted from funding onwards and never once cancelled or refunded, and store
 * sales are their own line (a cancelled store order is refunded in full).
 *
 * The platform's COMMISSION is its profit, which §11 reserves for the owner
 * and the financial role: an assistant-scope admin gets the counts and the
 * volume, and `fees` as null (the panel hides the tile).
 */
adminCommunityRoutes.get('/overview', async (c) => {
  const financial = canViewFinancials(c.env, c.get('user'));
  const [merchants, stores, products, requests, offers, orders, escrows, complaints, storeSales] = await Promise.all([
    c.env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN verified = 1 THEN 1 ELSE 0 END) AS verified,
              SUM(CASE WHEN status = 'suspended' THEN 1 ELSE 0 END) AS suspended
         FROM community_merchants`
    ).first<Record<string, number>>(),
    // «active» is open for business: the store's own status AND a merchant who
    // is not suspended — a merchant sanction no longer rewrites the store row.
    c.env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN s.status = 'active' AND m.status <> 'suspended' THEN 1 ELSE 0 END) AS active
         FROM merchant_stores s JOIN community_merchants m ON m.id = s.merchant_id`
    ).first<Record<string, number>>(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN lifecycle = 'active' THEN 1 ELSE 0 END) AS active
         FROM community_products`
    ).first<Record<string, number>>(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN state IN ('open','receiving_offers') THEN 1 ELSE 0 END) AS open
         FROM community_requests`
    ).first<Record<string, number>>(),
    c.env.DB.prepare('SELECT COUNT(*) AS total FROM community_offers').first<{ total: number }>(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN state NOT IN ('accepted','cancelled','refunded') THEN price_iqd ELSE 0 END), 0) AS gross,
              COALESCE(SUM(CASE WHEN state NOT IN ('accepted','cancelled','refunded') THEN platform_fee_iqd ELSE 0 END), 0) AS fees,
              SUM(CASE WHEN state = 'completed' THEN 1 ELSE 0 END) AS completed
         FROM community_orders`
    ).first<Record<string, number>>(),
    c.env.DB.prepare(
      `SELECT state, COUNT(*) AS n, COALESCE(SUM(gross_iqd), 0) AS total
         FROM community_escrows GROUP BY state`
    ).all<{ state: string; n: number; total: number }>(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status IN ('submitted','under_review') THEN 1 ELSE 0 END) AS open
         FROM community_complaints`
    ).first<Record<string, number>>(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(total_iqd), 0) AS gross,
              COALESCE(SUM(platform_fee_iqd), 0) AS fees
         FROM orders WHERE merchant_id IS NOT NULL AND status <> 'cancelled'`
    ).first<Record<string, number>>(),
  ]);

  return c.json({
    success: true,
    financial,
    merchants,
    stores,
    products,
    requests,
    offers,
    orders: { ...orders, fees: financial ? Number(orders?.fees ?? 0) : null },
    store_sales: {
      total: Number(storeSales?.total ?? 0),
      gross: Number(storeSales?.gross ?? 0),
      fees: financial ? Number(storeSales?.fees ?? 0) : null,
    },
    escrows: escrows.results,
    complaints,
  });
});

// ---------------------------------------------------------------- settings

const FEE_KEYS = [
  'communityFeeRequestPercentX100',
  'communityFeeStorePercentX100',
  'communityFeeMinIqd',
  'communityAutoCompleteDays',
  'communityRequestExpiryDays',
] as const;

adminCommunityRoutes.get('/settings', async (c) => {
  const out: Record<string, string> = {};
  for (const k of FEE_KEYS) out[k] = String((await getSetting(c.env.DB, k)) ?? '');
  return c.json({ success: true, settings: out });
});

/**
 * Change the platform's commission and lifecycle timings.
 *
 * A change applies to FUTURE transactions only. Every order and escrow
 * already created carries its own snapshot, and nothing here touches them —
 * retroactively recalculating what a merchant was owed for a sale that
 * already happened would be indefensible (§30, §75).
 */
adminCommunityRoutes.patch('/settings', requireFinancialScope, async (c) => {
  const admin = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const changed: Record<string, number> = {};

  for (const k of FEE_KEYS) {
    if (body[k] === undefined) continue;
    // A percentage over 100% would mean the platform takes more than the
    // customer paid. Bounded here, not just trusted from an admin form.
    const max = k.endsWith('PercentX100') ? 10_000 : 1_000_000;
    changed[k] = int(body[k], k, { min: 0, max });
  }
  if (!Object.keys(changed).length) throw badRequest('Nothing to update');

  await c.env.DB.batch(
    Object.entries(changed).map(([k, v]) =>
      c.env.DB.prepare(
        `INSERT INTO admin_settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).bind(k, String(v))
    )
  );

  await audit(c.env.DB, admin.id, 'admin.community_settings', 'community', changed);
  return c.json({ success: true, settings: changed, applies_to: 'future transactions only' });
});

// ------------------------------------------------------------ the gate

/**
 * «ليفو كوميونيتي تحت الصيانة، واسمح بالأعضاء من قائمة في الادارة» — the one
 * switch that decides whether customers may enter the community, and the list
 * of people who may enter anyway.
 *
 * Read and written HERE and nowhere else, so every flip carries an audit row
 * naming who did it and which way it went. It is deliberately NOT one of the
 * FEE_KEYS above and not reachable through the generic settings PATCH: those
 * are numbers with bounds, this is a door, and a door that can be opened by a
 * handler that does not audit is a door nobody can account for afterwards.
 *
 * The allow-list is USER IDS (see worker/lib/communityGate.ts for why it can
 * never be usernames or emails), and every id is checked against `users`
 * before it is stored — a typo saved silently is an owner believing they let
 * somebody in who is still locked out.
 */
/**
 * D1 refuses more than 100 bound parameters in one statement, and this
 * codebase chunks id lists at 90 so a caller can add a bound value of its own
 * without discovering the ceiling in production (worker/lib/customerNotify.ts
 * states the rule; worker/lib/stockAlerts.ts and four other call sites obey
 * it). The allow-list is capped at 200 entries below, which is TWICE the
 * ceiling — so both the read and the write of it are chunked, not trusted to
 * stay small.
 *
 * The unit tests cannot see this: they run node:sqlite, whose variable limit
 * is 999. Only D1 refuses, and only in production.
 */
const GATE_ID_CHUNK = 90;

adminCommunityRoutes.get('/gate', async (c) => {
  const gate = await readCommunityGate(c.env.DB);
  // The names beside the ids, so the panel can show people rather than
  // opaque strings. An id whose user has since been deleted still comes back
  // — it is in the stored list and the owner should be able to see and remove
  // it — with nulls where the row used to be.
  const members: Array<Record<string, unknown>> = [];
  if (gate.allowed.length) {
    const byId = new Map<string, Record<string, unknown>>();
    // CHUNKED, because the list this reads back is the list the PUT below
    // allows: up to 200 ids, and D1 refuses more than 100 bound parameters in
    // one statement (worker/lib/customerNotify.ts states the rule; five call
    // sites already chunk for it). Unchunked, the one thing that would break
    // is RENDERING a large allow-list — the panel would 500 on exactly the
    // list the owner needs to see in order to shorten it.
    for (const part of chunk(gate.allowed, GATE_ID_CHUNK)) {
      const marks = part.map(() => '?').join(',');
      const { results } = await c.env.DB.prepare(
        `SELECT id, username, name, email FROM users WHERE id IN (${marks})`
      ).bind(...part).all<Record<string, unknown>>();
      for (const u of results) byId.set(String(u.id), u);
    }
    for (const id of gate.allowed) members.push(byId.get(id) ?? { id, username: null, name: null, email: null });
  }
  return c.json({
    success: true,
    open: gate.open,
    closed: !gate.open,
    allowed_user_ids: gate.allowed,
    members,
    key: COMMUNITY_GATE_SETTING_KEY,
  });
});

/**
 * FIND THE TESTER — by name, username, email, PHONE or the exact user id.
 *
 * The panel used GET /api/admin/users?search=, which matches email, username
 * and name only. A phone-registered account carries a placeholder email and
 * keeps its number solely in `users.phone_e164`, so the one tester the owner
 * knows by phone number could not be found, and a pasted `usr_…` id matched
 * nothing either. This answers all of those in one bounded query: the typed
 * phone goes through the same normaliser sign-in uses (07xx…, +964…, 964…,
 * Arabic-Indic digits), and the number comes back MASKED — enough for the
 * owner to recognise the person, not a directory of phone numbers.
 */
adminCommunityRoutes.get('/gate/lookup', async (c) => {
  const q = (c.req.query('q') ?? '').trim().slice(0, 120);
  if (q.length < 2) return c.json({ success: true, users: [] });
  const phone = normalizePhone(q);
  const { results } = await c.env.DB.prepare(
    `SELECT id, username, name, email, phone_e164 FROM users
      WHERE id = ?1
         OR lower(email) = lower(?1)
         OR (?2 <> '' AND phone_e164 = ?2)
         OR ${sqlLikeClause(['email', 'username', 'name'], '?3')}
      ORDER BY (id = ?1) DESC, (?2 <> '' AND phone_e164 = ?2) DESC, created_at DESC
      LIMIT 20`
  )
    .bind(q, phone ?? '', likePattern(q))
    .all<{ id: string; username: string | null; name: string | null; email: string | null; phone_e164: string | null }>();
  return c.json({
    success: true,
    users: results.map((u) => ({
      id: u.id,
      username: u.username,
      name: u.name,
      email: u.email,
      phone_masked: u.phone_e164 ? maskPhone(u.phone_e164) : null,
    })),
  });
});

/**
 * One upsert, one audit row. `open` and `allowed_user_ids` are written
 * together because they are one decision — "shut, except these people" — and
 * writing them apart would leave a window where the community is closed with
 * yesterday's list, or open with tomorrow's.
 */
adminCommunityRoutes.put('/gate', async (c) => {
  const admin = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof body.open !== 'boolean') throw badRequest('open must be true or false', 'COMMUNITY_OPEN_REQUIRED');
  const open = body.open;

  const raw = body.allowed_user_ids;
  if (raw !== undefined && !Array.isArray(raw)) throw badRequest('allowed_user_ids must be an array of user ids');
  const asked = Array.isArray(raw) ? raw : [];
  // A list is a list of people, not a payload: 200 is far past any plausible
  // testing cohort and keeps the existence check to one bounded statement.
  if (asked.length > 200) throw badRequest('allowed_user_ids may not exceed 200 entries');
  const ids: string[] = [];
  for (const [i, v] of asked.entries()) {
    const id = str(v, `allowed_user_ids[${i}]`, { min: 1, max: 80 });
    if (!ids.includes(id)) ids.push(id);
  }

  if (ids.length) {
    const known = new Set<string>();
    // The same chunking, for the same ceiling: 200 ids is TWO HUNDRED bound
    // parameters in one `IN (…)`, and D1 stops at 100. Unchunked, an owner
    // allow-listing 101 beta members gets a 500, the gate is never written,
    // and the members stay locked out of a community the owner believes he
    // just let them into.
    for (const part of chunk(ids, GATE_ID_CHUNK)) {
      const marks = part.map(() => '?').join(',');
      const { results } = await c.env.DB.prepare(`SELECT id FROM users WHERE id IN (${marks})`)
        .bind(...part)
        .all<{ id: string }>();
      for (const r of results) known.add(String(r.id));
    }
    const missing = ids.filter((id) => !known.has(id));
    if (missing.length) {
      throw badRequest(
        `لا يوجد مستخدم بهذا المعرف / No such user: ${missing.slice(0, 5).join(', ')}`,
        'COMMUNITY_ALLOW_UNKNOWN_USER'
      );
    }
  }

  const before = await readCommunityGate(c.env.DB);
  const nowIso = new Date().toISOString();
  // The same upsert `setSetting` uses; the key is not a typed SETTING_DEFAULTS
  // entry because the generic settings PUT must not be able to open the
  // community without an audit row naming who opened it.
  await c.env.DB.prepare(
    'INSERT INTO admin_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  )
    .bind(
      COMMUNITY_GATE_SETTING_KEY,
      JSON.stringify({ open, allowed_user_ids: ids, updated_at: nowIso, by: admin.id })
    )
    .run();
  await audit(c.env.DB, admin.id, 'community.gate_update', COMMUNITY_GATE_SETTING_KEY, {
    before_open: before.open,
    after_open: open,
    before_allowed: before.allowed.length,
    after_allowed: ids.length,
  });
  return c.json({ success: true, open, closed: !open, allowed_user_ids: ids, changed: before.open !== open });
});

// --------------------------------------------------------------- merchants

adminCommunityRoutes.get('/merchants', async (c) => {
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 100, def: 50 });
  const q = c.req.query('q') || '';
  const { results } = await c.env.DB.prepare(
    `SELECT m.*, s.id AS store_id, s.slug AS store_slug, s.status AS store_status,
            s.name AS store_name, s.status_reason AS store_status_reason,
            u.email AS owner_email, u.name AS owner_name
       FROM community_merchants m
       LEFT JOIN merchant_stores s ON s.merchant_id = m.id
       JOIN users u ON u.id = m.user_id
      WHERE (?1 = '' OR ${sqlLikeClause(['m.name', 's.slug'], '?2')})
      ORDER BY m.created_at DESC LIMIT ?3`
  ).bind(q, likePattern(q), limit).all<Record<string, unknown>>();
  // The store's real address, from configuration — the panel used to print
  // `<slug>.levonis-iq.com` whatever domain it was running on (audit 04 #25).
  const root = rootDomainFrom(c.env);
  return c.json({
    success: true,
    merchants: results.map((m) => ({
      ...m,
      store_url: m.store_slug ? storeUrl(String(m.store_slug), root, String(m.store_id)) : null,
    })),
  });
});

/** Levonis verification — distinct from PLUS eligibility (§43). */
adminCommunityRoutes.post('/merchants/:id/verify', async (c) => {
  const admin = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const body = await c.req.json().catch(() => ({}));
  const verified = body.verified !== false;

  const res = await c.env.DB.prepare('UPDATE community_merchants SET verified = ? WHERE id = ?')
    .bind(verified ? 1 : 0, id)
    .run();
  if (!res.meta.changes) throw notFound('Merchant not found');

  // Verification is an input to the badge, so recompute it now rather than
  // waiting for the next review to arrive.
  await refreshMerchantRating(c.env.DB, id);
  await audit(c.env.DB, admin.id, 'admin.merchant_verified', id, { verified });
  return c.json({ success: true, verified });
});

/**
 * Suspend, restrict or restore a merchant.
 *
 * NOTHING IS DELETED. Products come off the storefront and the store stops
 * taking orders; every order, payout row, review and dispute stays exactly
 * where it is, and both the merchant and their customers keep access to their
 * own history (§46, §47).
 *
 * ONE ROW, AND IT IS THE MERCHANT'S (audit 04 B2 / audit 01 B8). This used to
 * write the STORE too — `suspended` for a suspended merchant and `active` for
 * anything else — so restricting a merchant lifted a store suspension the
 * admin had set for a bad banner, and restoring a merchant re-opened a shop
 * the merchant had paused themselves. The two sanctions are two rows now, and
 * neither decision writes the other's:
 *
 *   - the shop of a suspended merchant is shut by the MERCHANT row — every
 *     reader asks both (`storeIsOpen`, `storeIsSuspended` in
 *     worker/lib/merchantAuth.ts; the cart and checkout read `m.status`);
 *   - lifting the merchant sanction leaves the store exactly as it was: still
 *     suspended if an admin suspended it, still paused if its merchant paused
 *     it. Stores the old code had suspended ALONG WITH their merchant were
 *     handed back to their merchant as `paused` by migration 0118.
 *
 * The store's own state comes back in the answer so the panel can say so
 * («المتجر ما زال موقوفًا») rather than leave the admin believing the restore
 * re-opened it.
 */
adminCommunityRoutes.post('/merchants/:id/status', async (c) => {
  const admin = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const body = await c.req.json().catch(() => ({}));
  const status = oneOf(body.status, 'status', ['active', 'restricted', 'suspended'] as const);
  const reason = str(body.reason, 'reason', { min: 0, max: 500, required: false });

  const m = await c.env.DB.prepare('SELECT id, status FROM community_merchants WHERE id = ?')
    .bind(id)
    .first<{ id: string; status: string }>();
  if (!m) throw notFound('Merchant not found');

  await c.env.DB.prepare(
    'UPDATE community_merchants SET status = ?, status_reason = ?, status_changed_at = ? WHERE id = ?'
  ).bind(status, reason, nowIso(), id).run();

  await audit(c.env.DB, admin.id, 'admin.merchant_status', id, { status, reason, from: m.status });
  const store = await c.env.DB.prepare('SELECT status FROM merchant_stores WHERE merchant_id = ?')
    .bind(id)
    .first<{ status: string }>();
  return c.json({ success: true, status, store_status: store?.status ?? null });
});

/** Pin or clear a badge. A merchant can never set their own (§42). */
adminCommunityRoutes.post('/merchants/:id/badge', async (c) => {
  const admin = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const body = await c.req.json().catch(() => ({}));
  const badge = str(body.badge, 'badge', { min: 0, max: 30, required: false });

  await c.env.DB.prepare('UPDATE community_merchants SET badge_override = ? WHERE id = ?')
    .bind(badge, id)
    .run();
  // Clearing the override returns the merchant to the earned badge.
  await refreshMerchantRating(c.env.DB, id);
  await audit(c.env.DB, admin.id, 'admin.merchant_badge', id, { badge: badge || '(earned)' });
  return c.json({ success: true });
});

/**
 * Suspend or restore a STORE, without touching the merchant.
 *
 * The two are different sanctions and the mandate names them separately.
 * A storefront can be the problem on its own — a banner, a description, a
 * product listing — while the merchant is still fulfilling accepted work and
 * bidding honestly on the request board. Shutting the whole merchant for a
 * bad banner would cancel the work they owe other customers.
 *
 * `paused` is the merchant's own switch and is NOT reachable from here: an
 * admin decision must be distinguishable from a shopkeeper closing for the
 * afternoon, or "only an admin can lift an admin suspension" (§50) becomes
 * unenforceable the moment the merchant re-opens.
 */
adminCommunityRoutes.post('/stores/:id/status', async (c) => {
  const admin = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const body = await c.req.json().catch(() => ({}));
  const status = oneOf(body.status, 'status', ['active', 'suspended'] as const);
  const reason = str(body.reason, 'reason', { min: 0, max: 500, required: false });

  const store = await c.env.DB.prepare(
    'SELECT s.id, s.merchant_id, m.status AS merchant_status FROM merchant_stores s ' +
    'JOIN community_merchants m ON m.id = s.merchant_id WHERE s.id = ?'
  ).bind(id).first<{ id: string; merchant_id: string; merchant_status: string }>();
  if (!store) throw notFound('Store not found');

  // Re-opening a shop whose OWNER is suspended would contradict the merchant
  // sanction that is still in force, and the storefront would then have to
  // decide which of two admin decisions wins. Lift the merchant suspension
  // first, deliberately.
  if (status === 'active' && store.merchant_status === 'suspended') {
    throw conflict('That merchant is suspended — restore the merchant first');
  }

  await c.env.DB.prepare(
    'UPDATE merchant_stores SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?'
  ).bind(status, reason, nowIso(), id).run();

  await audit(c.env.DB, admin.id, 'admin.store_status', id, {
    status, reason, merchant: store.merchant_id,
  });
  return c.json({ success: true, status });
});

// -------------------------------------------------------------- moderation

/**
 * A merchant's products as moderation sees them — every lifecycle, with the
 * admin hide beside the merchant's own state, so the panel can offer «إخفاء»
 * and «إظهار» on the product in question (the hide had no control at all).
 */
adminCommunityRoutes.get('/merchants/:id/products', async (c) => {
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const { results } = await c.env.DB.prepare(
    `SELECT id, slug, name, name_ar, price_iqd, images, lifecycle, status,
            admin_hidden_at, admin_hidden_reason, created_at, updated_at
       FROM community_products WHERE merchant_id = ?
      ORDER BY created_at DESC, id DESC LIMIT 200`
  ).bind(id).all<Record<string, unknown>>();
  return c.json({
    success: true,
    products: results.map((p) => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
      name_ar: p.name_ar,
      price_iqd: p.price_iqd,
      image: (() => {
        try {
          const list = JSON.parse(String(p.images ?? '[]'));
          return Array.isArray(list) && typeof list[0] === 'string' ? list[0] : null;
        } catch {
          return null;
        }
      })(),
      lifecycle: p.lifecycle,
      live: p.status === 'active',
      admin_hidden: !!p.admin_hidden_at,
      admin_hidden_at: p.admin_hidden_at ?? null,
      admin_hidden_reason: p.admin_hidden_reason ?? '',
    })),
  });
});

/**
 * Hide a product — or lift the hide — as LEVONIS, not as its merchant.
 *
 * STICKY (audit 01 B9). The hide used to write `lifecycle`/`status`, the same
 * two columns the merchant's editor writes, so one «نشر» from the merchant put
 * the product straight back on the storefront. The decision now lives in its
 * own column (`admin_hidden_at`, migration 0118): the merchant route refuses
 * to publish while it is set and computes `status` as 'hidden' in SQL whatever
 * the merchant sends (worker/routes/merchant.ts). `lifecycle` is left as the
 * merchant chose it, so lifting the hide puts back exactly what they had.
 *
 * A REASON IS REQUIRED to hide: it is what the merchant is shown, and a hide
 * nobody can explain is one the merchant can only guess at.
 */
adminCommunityRoutes.post('/products/:id/hide', async (c) => {
  const admin = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const body = await c.req.json().catch(() => ({}));
  const hidden = body.hidden !== false;
  const reason = hidden
    ? str(body.reason, 'reason', { min: 3, max: 300 })
    : '';
  const ts = nowIso();

  const res = hidden
    ? await c.env.DB.prepare(
        `UPDATE community_products
            SET admin_hidden_at = ?, admin_hidden_reason = ?, status = 'hidden', updated_at = ?
          WHERE id = ?`
      ).bind(ts, reason, ts, id).run()
    : await c.env.DB.prepare(
        `UPDATE community_products
            SET admin_hidden_at = NULL, admin_hidden_reason = '',
                status = CASE WHEN lifecycle = 'active' THEN 'active' ELSE 'hidden' END,
                updated_at = ?
          WHERE id = ?`
      ).bind(ts, id).run();
  if (!res.meta.changes) throw notFound('Product not found');
  await audit(c.env.DB, admin.id, hidden ? 'admin.product_hidden' : 'admin.product_unhidden', id, { reason });
  return c.json({ success: true, hidden });
});

adminCommunityRoutes.post('/reviews/:id/hide', async (c) => {
  const admin = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const body = await c.req.json().catch(() => ({}));
  const hidden = body.hidden !== false;

  const r = await c.env.DB.prepare('SELECT merchant_id FROM merchant_reviews WHERE id = ?')
    .bind(id).first<{ merchant_id: string }>();
  if (!r) throw notFound('Review not found');

  await c.env.DB.prepare('UPDATE merchant_reviews SET hidden = ? WHERE id = ?').bind(hidden ? 1 : 0, id).run();
  // The rating must move with the moderation decision, or a hidden review
  // keeps counting toward a score nobody can see the basis for.
  await refreshMerchantRating(c.env.DB, r.merchant_id);
  await audit(c.env.DB, admin.id, 'admin.review_hidden', id, { hidden });
  return c.json({ success: true, hidden });
});

/**
 * Take a request off the board — moderation, not settlement.
 *
 * NOT WHILE MONEY IS IN IT (audit 04 B4, audit 03 §10 S). The guard used to
 * list only `completed`, `in_progress` and `delivered`, so a DISPUTED request —
 * or one whose acceptance was mid-flight — could be "removed": the request
 * read `cancelled` while its order stayed `disputed` and the customer's money
 * stayed frozen in escrow with nothing pointing at it. A request with a live
 * order or a held/disputed escrow is refused with `REQUEST_HAS_ESCROW`: decide
 * the dispute (or cancel the order) first, and the request closes with it.
 * Removal also rejects the pending offers, zeroes the count and kills every
 * preview link, in the same batch; removing an already-cancelled request is a
 * no-op, not an error.
 */
const ADMIN_REMOVABLE_STATES = ['draft', 'open', 'receiving_offers', 'offer_selected', 'expired'];
const LIVE_ORDER_OR_ESCROW = `EXISTS (SELECT 1 FROM community_orders o
                                LEFT JOIN community_escrows e ON e.community_order_id = o.id
                               WHERE o.request_id = ?1
                                 AND (o.state IN ('accepted','funded','in_progress','merchant_marked_delivered','disputed')
                                      OR e.state IN ('held','disputed')))`;

adminCommunityRoutes.post('/requests/:id/remove', async (c) => {
  const admin = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const reason = str((await c.req.json().catch(() => ({}))).reason, 'reason', { min: 0, max: 300, required: false });

  const r = await c.env.DB.prepare('SELECT state FROM community_requests WHERE id = ?').bind(id).first<{ state: string }>();
  if (!r) throw notFound('Request not found');
  if (r.state === 'cancelled') return c.json({ success: true, replayed: true });
  if (await c.env.DB.prepare(`SELECT ${LIVE_ORDER_OR_ESCROW} AS live`).bind(id).first<{ live: number }>().then((x) => !!x?.live)) {
    throw conflict(
      'This request has an order or money in escrow — resolve the dispute or cancel the order first',
      'REQUEST_HAS_ESCROW'
    );
  }
  if (!ADMIN_REMOVABLE_STATES.includes(r.state)) {
    throw conflict('That request is already settled or has work under way — resolve it as a dispute instead', 'REQUEST_NOT_REMOVABLE');
  }

  const ts = nowIso();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        // The same list as the check above, bound as ONE JSON value — no
        // list templated into the SQL (tests/d1ParameterCeilings.test.ts).
        `UPDATE community_requests SET state = 'cancelled', status = 'closed', updated_at = ?2
          WHERE id = ?1 AND state IN (SELECT value FROM json_each(?3))
            AND NOT ${LIVE_ORDER_OR_ESCROW}`
      ).bind(id, ts, JSON.stringify(ADMIN_REMOVABLE_STATES)),
      requestMovedFence(c.env.DB, id, 'cancelled', ts),
      c.env.DB.prepare(
        `UPDATE community_offers SET state = 'rejected', updated_at = ? WHERE request_id = ? AND state = 'pending'`
      ).bind(ts, id),
      offerCountStatement(c.env.DB, id),
      revokeViewerTokensStatement(c.env.DB, id, ts),
    ]);
  } catch (e) {
    if (!isConstraintAbort(e)) throw e;
    throw conflict('That request changed while you were deciding — reload it', 'REQUEST_CHANGED');
  }
  await audit(c.env.DB, admin.id, 'admin.request_removed', id, { reason, from: r.state });
  return c.json({ success: true });
});

// ------------------------------------------------------ requests & offers

/**
 * The request board as an admin sees it.
 *
 * The PUBLIC board deliberately withholds who is asking (§24) — a merchant
 * learns how to reach a customer when their offer is accepted, and not
 * before. That rule protects a customer from merchants; it was never a rule
 * against Levonis itself, which has to answer "who posted this and what
 * became of it" when a dispute lands on the desk. So the customer is named
 * here, in a route the host guard keeps on the apex, and nowhere else.
 */
adminCommunityRoutes.get('/requests', async (c) => {
  const state = c.req.query('state') || '';
  const q = c.req.query('q') || '';
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 100, def: 50 });

  const { results } = await c.env.DB.prepare(
    `SELECT r.id, r.title, r.state, r.status, r.category, r.quantity, r.budget_iqd,
            r.governorate, r.visibility, r.deadline, r.expires_at,
            r.accepted_offer_id, r.community_order_id, r.created_at,
            r.customer_id, u.name AS customer_name, u.email AS customer_email,
            (SELECT COUNT(*) FROM community_offers o WHERE o.request_id = r.id) AS offers_total,
            (SELECT COUNT(*) FROM community_offers o
              WHERE o.request_id = r.id AND o.state = 'pending') AS offers_pending
       FROM community_requests r
       JOIN users u ON u.id = r.customer_id
      WHERE (?1 = '' OR r.state = ?2)
        AND (?3 = '' OR r.title LIKE ?4 ESCAPE '\\' OR r.id = ?3)
      ORDER BY r.created_at DESC
      LIMIT ?5`
  ).bind(state, state, q, likePattern(q), limit).all();

  return c.json({ success: true, requests: results });
});

/**
 * One request with every offer on it.
 *
 * A merchant cannot read a rival's price (§25). An admin moderating the board
 * must be able to, or "this offer is abusive" is a claim they have no way to
 * check. Same table, different question, different caller.
 *
 * Attachments are listed WITHOUT their R2 keys (§22, §67). An admin sees that
 * three files exist and what they are; the key stays server-side so no
 * response anywhere in the platform teaches a reader how to address the
 * bucket directly.
 */
adminCommunityRoutes.get('/requests/:id', async (c) => {
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });

  const request = await c.env.DB.prepare(
    `SELECT r.*, u.name AS customer_name, u.email AS customer_email
       FROM community_requests r
       JOIN users u ON u.id = r.customer_id
      WHERE r.id = ?`
  ).bind(id).first<Record<string, unknown>>();
  if (!request) throw notFound('Request not found');

  const [offers, files, order] = await Promise.all([
    c.env.DB.prepare(
      `SELECT o.*, m.name AS merchant_name, m.status AS merchant_status,
              m.badge, m.verified, s.slug AS store_slug
         FROM community_offers o
         JOIN community_merchants m ON m.id = o.merchant_id
         LEFT JOIN merchant_stores s ON s.id = o.store_id
        WHERE o.request_id = ?
        ORDER BY o.created_at`
    ).bind(id).all(),
    c.env.DB.prepare(
      `SELECT id, file_name, content_type, size_bytes, kind, created_at
         FROM community_request_files WHERE request_id = ? ORDER BY created_at`
    ).bind(id).all<Record<string, unknown>>(),
    c.env.DB.prepare(
      `SELECT o.*, m.name AS merchant_name
         FROM community_orders o
         JOIN community_merchants m ON m.id = o.merchant_id
        WHERE o.request_id = ? ORDER BY o.created_at DESC LIMIT 1`
    ).bind(id).first<Record<string, unknown>>(),
  ]);

  // The money for this request, if it got that far — so the admin reading a
  // reported request sees immediately whether anything is at stake.
  const escrow = order ? await escrowForOrder(c.env.DB, String(order.id)) : null;

  return c.json({
    success: true,
    request,
    offers: offers.results,
    // A route, not a key. The marketplace download handler already grants
    // an admin access and re-checks it on every read, so moderation reuses
    // that one authorisation instead of adding a second way in.
    files: files.results.map((f) => ({
      ...f,
      url: `/api/marketplace/requests/${id}/files/${f.id}`,
    })),
    order: order ?? null,
    escrow,
  });
});

/**
 * Reject one abusive offer without touching the request.
 *
 * Only while it is PENDING. An accepted offer is the contract behind a
 * community order and an escrow (§26) — pulling it out from underneath them
 * would leave money held against a promise that no longer exists. Once work
 * is under way the answer is a dispute resolution, which moves the money
 * deliberately and leaves a record; `canMoveOffer` is what says so here
 * rather than a hand-written condition that could drift from the table.
 */
adminCommunityRoutes.post('/offers/:id/reject', async (c) => {
  const admin = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const reason = str((await c.req.json().catch(() => ({}))).reason, 'reason', { min: 3, max: 300 });

  const offer = await c.env.DB.prepare(
    'SELECT id, request_id, merchant_id, state FROM community_offers WHERE id = ?'
  ).bind(id).first<{ id: string; request_id: string; merchant_id: string; state: OfferState }>();
  if (!offer) throw notFound('Offer not found');

  if (!canMoveOffer(offer.state, 'rejected')) {
    throw conflict(
      offer.state === 'accepted'
        ? 'That offer has been accepted — settle it as a dispute instead of removing it'
        : `An offer that is ${offer.state} cannot be rejected`
    );
  }

  const res = await c.env.DB.prepare(
    `UPDATE community_offers SET state = 'rejected', updated_at = ? WHERE id = ? AND state = 'pending'`
  ).bind(nowIso(), id).run();
  if (!res.meta.changes) throw conflict('That offer changed while you were deciding — reload it');

  // offer_count is what the board shows; leaving it stale advertises offers
  // that are no longer there.
  await c.env.DB.prepare(
    `UPDATE community_requests
        SET offer_count = (SELECT COUNT(*) FROM community_offers
                            WHERE request_id = ? AND state IN ('pending','accepted')),
            updated_at = ?
      WHERE id = ?`
  ).bind(offer.request_id, nowIso(), offer.request_id).run();

  await audit(c.env.DB, admin.id, 'admin.offer_rejected', id, { reason, merchant: offer.merchant_id });
  return c.json({ success: true, state: 'rejected' });
});

// --------------------------------------------------- reviews & reputation

/**
 * Every review, for moderation.
 *
 * Hidden ones are included by default and marked, not filtered away: an admin
 * reviewing a moderation decision needs to see what was hidden as readily as
 * what is live, and a merchant appealing "you hid my review" cannot be
 * answered from a list that no longer contains it.
 */
adminCommunityRoutes.get('/reviews', async (c) => {
  const merchantId = c.req.query('merchant') || '';
  const hidden = c.req.query('hidden') || '';        // '' | '0' | '1'
  const maxRating = int(c.req.query('maxRating'), 'maxRating', { min: 1, max: 5, def: 5 });
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 100, def: 50 });

  const { results } = await c.env.DB.prepare(
    `SELECT rv.id, rv.merchant_id, rv.rating, rv.body, rv.hidden, rv.merchant_reply,
            rv.merchant_replied_at, rv.edited_count, rv.order_id, rv.community_order_id,
            rv.created_at, rv.updated_at,
            m.name AS merchant_name, m.rating_avg_x100, m.rating_count,
            u.name AS customer_name, u.email AS customer_email
       FROM merchant_reviews rv
       JOIN community_merchants m ON m.id = rv.merchant_id
       JOIN users u ON u.id = rv.customer_id
      WHERE (? = '' OR rv.merchant_id = ?)
        AND (? = '' OR rv.hidden = CAST(? AS INTEGER))
        AND rv.rating <= ?
      ORDER BY rv.created_at DESC
      LIMIT ?`
  ).bind(merchantId, merchantId, hidden, hidden, maxRating, limit).all();

  return c.json({ success: true, reviews: results });
});

/**
 * Why this merchant has the standing they have.
 *
 * The score and the badge are DERIVED (§41, §42), so this returns the inputs
 * rather than a number to be trusted: the raw events, the rating breakdown by
 * star, and — importantly — the badge the criteria actually earn alongside
 * any admin override. An admin about to pin a badge can see what they are
 * overriding, and an admin clearing an override can see what the merchant
 * will fall back to.
 */
adminCommunityRoutes.get('/merchants/:id/reputation', async (c) => {
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });

  const merchant = await c.env.DB.prepare(
    `SELECT id, name, verified, status, status_reason, badge, badge_override,
            rating_avg_x100, rating_count, completed_orders, reputation_score, created_at
       FROM community_merchants WHERE id = ?`
  ).bind(id).first<Record<string, number | string>>();
  if (!merchant) throw notFound('Merchant not found');

  const [events, breakdown, points] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, kind, points, note, order_id, community_order_id, review_id, created_at
         FROM merchant_reputation_events WHERE merchant_id = ?
        ORDER BY created_at DESC LIMIT 200`
    ).bind(id).all(),
    c.env.DB.prepare(
      `SELECT rating, COUNT(*) AS n FROM merchant_reviews
        WHERE merchant_id = ? AND hidden = 0 GROUP BY rating ORDER BY rating DESC`
    ).bind(id).all<{ rating: number; n: number }>(),
    c.env.DB.prepare(
      'SELECT COALESCE(SUM(points), 0) AS total FROM merchant_reputation_events WHERE merchant_id = ?'
    ).bind(id).first<{ total: number }>(),
  ]);

  const earned = badgeFor({
    completed_orders: Number(merchant.completed_orders ?? 0),
    rating_avg_x100: Number(merchant.rating_avg_x100 ?? 0),
    rating_count: Number(merchant.rating_count ?? 0),
    verified: Number(merchant.verified ?? 0),
  });

  return c.json({
    success: true,
    merchant,
    earned_badge: earned,
    badge_override: String(merchant.badge_override || ''),
    reputation_points: Number(points?.total ?? 0),
    breakdown: breakdown.results,
    events: events.results,
  });
});

/**
 * Correct the record by adding to it.
 *
 * A mistaken reputation event is answered by another event, never by editing
 * or deleting the first (§41). That is why this route only inserts: a
 * merchant can always be shown the full sequence of what happened to their
 * standing, including the correction and who made it.
 */
adminCommunityRoutes.post('/merchants/:id/reputation', async (c) => {
  const admin = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const body = await c.req.json().catch(() => ({}));
  const points = int(body.points, 'points', { min: -500, max: 500 });
  const note = str(body.note, 'note', { min: 3, max: 300 });

  const m = await c.env.DB.prepare('SELECT id FROM community_merchants WHERE id = ?').bind(id).first();
  if (!m) throw notFound('Merchant not found');

  await c.env.DB.prepare(
    `INSERT INTO merchant_reputation_events (id, merchant_id, kind, points, note)
     VALUES (?,?,'admin_adjustment',?,?)`
  ).bind(newId('rep'), id, points, note).run();

  await audit(c.env.DB, admin.id, 'admin.merchant_reputation', id, { points, note });
  return c.json({ success: true });
});

// -------------------------------------------------------------- complaints

/**
 * The address and the element a complaint attachment renders as, beside the
 * raw row. Staff may read every `complaints/` key (worker/routes/uploads.ts),
 * so the key itself stays on the admin payload; `file_url` and `kind` spare
 * the console from re-deriving what the reporter's thread is already told.
 */
function withComplaintFile(m: Record<string, unknown>): Record<string, unknown> {
  const key = typeof m.file_key === 'string' && m.file_key ? m.file_key : null;
  return {
    ...m,
    file_url: key ? `/files/${key}` : null,
    kind: !key ? 'text' : key.split('/')[2] === 'video' ? 'video' : 'image',
  };
}

adminCommunityRoutes.get('/complaints', async (c) => {
  const status = c.req.query('status') || '';
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 100, def: 50 });
  const { results } = await c.env.DB.prepare(
    `SELECT ct.*, r.name AS reporter_name, m.name AS merchant_name,
            CASE WHEN ${COMPLAINT_AWAITS_DESK_SQL} THEN 1 ELSE 0 END AS awaiting_reply
       FROM community_complaints ct
       JOIN users r ON r.id = ct.reporter_id
       LEFT JOIN community_merchants m ON m.id = ct.merchant_id
      WHERE (? = '' OR ct.status = ?)
      ORDER BY CASE ct.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
               ct.created_at DESC
      LIMIT ?`
  ).bind(status, status, limit).all();
  return c.json({ success: true, complaints: results });
});

adminCommunityRoutes.get('/complaints/:id', async (c) => {
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const complaint = await c.env.DB.prepare(
    `SELECT ct.*, r.name AS reporter_name, r.email AS reporter_email, m.name AS merchant_name
       FROM community_complaints ct
       JOIN users r ON r.id = ct.reporter_id
       LEFT JOIN community_merchants m ON m.id = ct.merchant_id
      WHERE ct.id = ?`
  ).bind(id).first<Record<string, unknown>>();
  if (!complaint) throw notFound('Complaint not found');

  const messages = await c.env.DB.prepare(
    `SELECT cm.*, u.name AS sender_name FROM community_complaint_messages cm
       JOIN users u ON u.id = cm.sender_id
      WHERE cm.complaint_id = ? ORDER BY cm.created_at`
  ).bind(id).all();

  // The whole financial picture for the transaction under dispute, so a
  // decision is made against the record rather than against a summary.
  const escrow = complaint.community_order_id
    ? await escrowForOrder(c.env.DB, String(complaint.community_order_id))
    : null;
  const events = escrow
    ? await c.env.DB.prepare(
        'SELECT * FROM community_escrow_events WHERE escrow_id = ? ORDER BY created_at'
      ).bind(escrow.id).all()
    : { results: [] };

  return c.json({
    success: true,
    complaint,
    messages: messages.results.map(withComplaintFile),
    escrow,
    escrow_events: events.results,
  });
});

adminCommunityRoutes.post('/complaints/:id/status', async (c) => {
  const admin = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const body = await c.req.json().catch(() => ({}));
  const status = oneOf(body.status, 'status', [
    'submitted', 'under_review', 'waiting_customer', 'waiting_merchant', 'resolved', 'rejected', 'closed',
  ] as const);
  const resolution = str(body.resolution, 'resolution', { min: 0, max: 2000, required: false });

  const res = await c.env.DB.prepare(
    `UPDATE community_complaints
        SET status = ?, resolution = ?, assigned_admin_id = ?,
            resolved_at = CASE WHEN ? IN ('resolved','rejected','closed') THEN ? ELSE resolved_at END,
            updated_at = ?
      WHERE id = ?`
  ).bind(status, resolution, admin.id, status, nowIso(), nowIso(), id).run();
  if (!res.meta.changes) throw notFound('Complaint not found');

  await audit(c.env.DB, admin.id, 'admin.complaint_status', id, { status });
  return c.json({ success: true, status });
});

/**
 * ANSWER THE PERSON. «الشكاوى» — the owner's own word for what was missing.
 *
 * WHAT WAS BROKEN. `GET /complaints/:id` has selected the thread from
 * `community_complaint_messages` since migration 0031, and the admin panel
 * could set a STATUS on a complaint — but there was no INSERT anywhere in the
 * repository, in any route, for that table. An admin could read a customer's
 * complaint, move it to «waiting_customer», and the customer would be waiting
 * on a reply the product had no way to send. A status is not an answer.
 *
 * `internal` IS THE HALF THAT MAKES THIS SAFE. The column has been on the
 * table since 0031 with the comment "admin-only note, never shown to parties",
 * and a dispute desk that cannot write a note to itself writes the note in the
 * reply instead — to the person it is about. Both kinds go in the same ordered
 * thread so the sequence of the case is one list, and the flag is what decides
 * who may read a row. It is explicit on every write: a note that becomes a
 * reply by omission is the failure mode worth designing against, so an absent
 * or unparseable `internal` means a PUBLIC reply, which is the thing the admin
 * meant to type, and a note has to say so.
 *
 * IT DOES NOT MOVE THE STATUS. Replying and deciding are two acts by two
 * different rules — `/status` writes `resolved_at` and the resolution text —
 * and fusing them would make every typed sentence a state transition. The
 * panel calls both when it means both.
 *
 * THE COMPLAINT MUST EXIST, checked before the insert rather than left to the
 * foreign key: a 404 naming the complaint is an answer an admin can act on,
 * and a raw FK violation is a 500.
 */
adminCommunityRoutes.post('/complaints/:id/messages', async (c) => {
  const admin = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  /**
   * A PHOTOGRAPH IS AN ANSWER TOO. `file_key` has been on this table since
   * migration 0031 and nothing ever wrote it, so the desk could not send back
   * the picture of the replacement part or the courier's receipt — the thing
   * that settles most disputes faster than a paragraph. The key must be THIS
   * complaint's (`complaints/<id>/…`, filed there by the upload route after
   * it checked the complaint exists) and actually stored; with a file the text
   * becomes optional, without one it is required as before.
   */
  const rawKey = body.fileKey;
  const hasFile = rawKey !== undefined && rawKey !== null && rawKey !== '';
  const text = str(body.body, 'body', { min: hasFile ? 0 : 1, max: 4000, required: !hasFile });
  const internal = body.internal === true;

  const complaint = await c.env.DB.prepare('SELECT id, status FROM community_complaints WHERE id = ?')
    .bind(id)
    .first<{ id: string; status: string }>();
  if (!complaint) throw notFound('Complaint not found');

  let fileKey: string | null = null;
  if (hasFile) {
    if (!isSafeMediaKey(rawKey) || !rawKey.startsWith(`complaints/${id}/`)) {
      throw badRequest('That file does not belong to this complaint');
    }
    const folder = rawKey.split('/')[2] ?? '';
    if (folder !== 'attachments' && folder !== 'video') throw badRequest('Invalid file reference');
    if (!(await headMediaObject(c.env, 'private', rawKey))) {
      throw badRequest('That attachment was not uploaded — attach it again', 'ATTACHMENT_NOT_FOUND');
    }
    fileKey = rawKey;
  }

  const messageId = newId('cmsg');
  await c.env.DB.prepare(
    `INSERT INTO community_complaint_messages (id, complaint_id, sender_id, sender_role, body, file_key, internal)
     VALUES (?,?,?,'admin',?,?,?)`
  )
    .bind(messageId, id, admin.id, text, fileKey, internal ? 1 : 0)
    .run();

  // The complaint itself moved in the sense that matters to a queue sorted by
  // activity: somebody worked it. `status` is deliberately untouched.
  await c.env.DB.prepare('UPDATE community_complaints SET updated_at = ? WHERE id = ?')
    .bind(nowIso(), id)
    .run();

  await audit(c.env.DB, admin.id, 'admin.complaint_message', id, { internal, length: text.length, file: !!fileKey });

  /**
   * AND THE PERSON IS TOLD — WHICH IS THE HALF THAT MAKES THIS A REPLY.
   *
   * Nothing in `src/` reads `community_complaint_messages` on the customer
   * side; the only customer touch on a complaint is the POST that files one
   * (worker/routes/marketplace.ts). So a row in this table, on its own, is a
   * sentence typed into a room with no door — an admin believing they have
   * answered while the reporter is still waiting. `notifyComplaintReply`
   * writes the answer into `user_notifications`, which the reporter reads
   * behind their own login, and sends a short "an answer arrived" line to
   * whatever outbound channel can reach them.
   *
   * ONLY FOR A PUBLIC REPLY. An internal note exists so this desk can write to
   * ITSELF; mailing it to the person it is about is the worst thing this
   * feature could do, so the guard is here as well as in the function's own
   * contract.
   *
   * `waitUntil` through the guarded accessor, and the function cannot throw:
   * the reply is recorded whether or not anything can be delivered.
   * `c.executionCtx` throws in Hono when there is no context, which is every
   * test in this suite, so it is reached inside the try.
   */
  if (!internal) {
    try {
      c.executionCtx.waitUntil(notifyComplaintReply(c.env, id, messageId, text));
    } catch {
      void notifyComplaintReply(c.env, id, messageId, text);
    }
  }

  const message = await c.env.DB.prepare(
    `SELECT cm.*, u.name AS sender_name FROM community_complaint_messages cm
       JOIN users u ON u.id = cm.sender_id
      WHERE cm.id = ?`
  )
    .bind(messageId)
    .first<Record<string, unknown>>();

  return c.json({ success: true, message: message ? withComplaintFile(message) : message });
});

// ------------------------------------------------------------- settlement

/**
 * Decide a disputed escrow.
 *
 * The four outcomes the mandate names (§45): pay the merchant in full, refund
 * the customer in full, or split it either way. All four go through the same
 * append-only escrow operations, so the decision, its amount, its reason and
 * the admin who made it are all on the record.
 *
 * The idempotency key is derived from the escrow and the decision, so a
 * double-submitted resolution settles once.
 */
adminCommunityRoutes.post('/escrows/:id/resolve', requireFinancialScope, async (c) => {
  const admin = c.get('user')!;
  const escrowId = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const body = await c.req.json().catch(() => ({}));
  const decision = oneOf(body.decision, 'decision', ['release', 'refund', 'partial_refund'] as const);
  const reason = str(body.reason, 'reason', { min: 3, max: 1000 });

  const esc = await getEscrow(c.env.DB, escrowId);
  if (!esc) throw notFound('Escrow not found');
  const order = await c.env.DB.prepare('SELECT request_id, state FROM community_orders WHERE id = ?')
    .bind(esc.community_order_id)
    .first<{ request_id: string; state: string }>();

  const key = `admin:${decision}:${escrowId}`;
  /**
   * ONLY A DISPUTE IS DECIDED HERE — unless this exact decision is already on
   * the record, in which case it is replayed (below) rather than refused. Any
   * `held` escrow used to be settleable, so an admin could pay a merchant for
   * work the customer never confirmed and nobody disputed (audit 03 §10 C).
   * An escrow a dispute left `held` while its order reads `disputed` (the old
   * dispute route flipped the two separately) still counts as disputed.
   */
  const recorded = await c.env.DB.prepare('SELECT 1 AS x FROM community_escrow_events WHERE idempotency_key = ?')
    .bind(key)
    .first();
  if (!recorded) {
    const disputed = esc.state === 'disputed' || (esc.state === 'held' && order?.state === 'disputed');
    if (!disputed) {
      throw conflict(
        esc.state === 'held'
          ? 'This escrow is not in dispute — it settles by the customer\'s confirmation'
          : 'This escrow is already settled',
        esc.state === 'held' ? 'ESCROW_NOT_DISPUTED' : 'ESCROW_SETTLED'
      );
    }
  }

  let result;
  if (decision === 'release') {
    result = await releaseEscrow(c.env.DB, {
      escrowId, actorId: admin.id, actorRole: 'admin', reason, idempotencyKey: key,
    });
  } else {
    const amount = decision === 'partial_refund'
      ? int(body.amount_iqd, 'amount_iqd', { min: 1, max: esc.gross_iqd })
      : undefined;
    result = await refundEscrow(c.env.DB, {
      escrowId, actorId: admin.id, actorRole: 'admin', reason, amountIqd: amount, idempotencyKey: key,
    });
  }
  if (!result.ok) {
    const why = (result as { reason: string }).reason;
    throw new HttpError(409, `Could not settle (${why})`, 'ESCROW_SETTLE_FAILED', { reason: why });
  }
  const replayed = (result as { replayed: boolean }).replayed;

  /**
   * THE DECISION'S CONSEQUENCES, EACH ONE ONCE (audit 04 B3, audit 03 §10 C).
   *
   * A replayed decision used to write another −20 reputation event and
   * rewrite the order, and the request stayed `disputed` for ever. Every
   * statement here is conditional, so running it again — a double submit, a
   * replay after a crash between the money and this batch — changes nothing
   * that already happened and finishes anything that did not:
   *   - the order leaves an ACTIVE state only (never rewrites a settled one);
   *   - the request leaves `disputed`: `completed` when the merchant was paid
   *     (in full or in part), `cancelled` on a full refund;
   *   - ONE dispute outcome per order on the merchant's reputation;
   *   - the complaint is resolved with the decision as its resolution;
   *   - the request's preview links stop working.
   */
  const ts = nowIso();
  const orderState = decision === 'release' ? 'completed' : 'refunded';
  const requestState = decision === 'refund' ? 'cancelled' : 'completed';
  const outcome = decision === 'release' ? 'dispute_won' : 'dispute_lost';
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE community_orders
          SET state = ?1, completed_at = CASE WHEN ?1 = 'completed' THEN ?2 ELSE completed_at END, updated_at = ?2
        WHERE id = ?3 AND state IN ('funded','in_progress','merchant_marked_delivered','disputed')`
    ).bind(orderState, ts, esc.community_order_id),
    c.env.DB.prepare(
      `UPDATE community_requests SET state = ?1, status = 'closed', updated_at = ?2
        WHERE id = ?3 AND state IN ('offer_selected','in_progress','delivered','disputed')`
    ).bind(requestState, ts, order?.request_id ?? ''),
    c.env.DB.prepare(
      `INSERT INTO merchant_reputation_events (id, merchant_id, kind, points, community_order_id, note)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6
        WHERE NOT EXISTS (SELECT 1 FROM merchant_reputation_events
                           WHERE community_order_id = ?5 AND kind IN ('dispute_won','dispute_lost'))`
    ).bind(newId('rep'), esc.merchant_id, outcome, outcome === 'dispute_lost' ? -20 : 0, esc.community_order_id, reason.slice(0, 200)),
    c.env.DB.prepare(
      `UPDATE community_complaints
          SET status = 'resolved', resolution = ?1, resolved_at = ?2, updated_at = ?2,
              assigned_admin_id = COALESCE(assigned_admin_id, ?3)
        WHERE community_order_id = ?4 AND status NOT IN ('resolved','rejected','closed')`
    ).bind(`${decision}: ${reason}`.slice(0, 2000), ts, admin.id, esc.community_order_id),
    revokeViewerTokensStatement(c.env.DB, order?.request_id ?? '', ts),
  ]);

  if (!replayed) {
    await audit(c.env.DB, admin.id, 'admin.escrow_resolved', escrowId, {
      decision,
      reason,
      amount: body.amount_iqd ?? esc.gross_iqd,
    });
  }
  return c.json({ success: true, decision, replayed });
});

/** A merchant's full financial timeline, for an admin answering a question. */
adminCommunityRoutes.get('/merchants/:id/finance', requireFinancialScope, async (c) => {
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const balance = await merchantBalance(c.env.DB, id);
  const { results: ledger } = await c.env.DB.prepare(
    `SELECT * FROM merchant_payout_ledger WHERE merchant_id = ? ORDER BY created_at DESC LIMIT 200`
  ).bind(id).all();
  const { results: escrows } = await c.env.DB.prepare(
    `SELECT * FROM community_escrows WHERE merchant_id = ? ORDER BY created_at DESC LIMIT 100`
  ).bind(id).all();
  return c.json({ success: true, balance, ledger, escrows });
});

/**
 * Record a payout to a merchant, or an adjustment.
 *
 * Append-only: paying a merchant writes a NEGATIVE ledger row rather than
 * reducing a balance, so the balance stays a SUM and the payment itself is
 * visible in the history (§76).
 *
 * NEVER MORE THAN AVAILABLE — DECIDED IN THE INSERT (audit 02 B3, audit 04
 * B1). "Available" used to be `SUM(state = 'available')` while payouts were
 * written `state = 'paid'`, so it never went down: two payouts of 10,000 from
 * a 10,000 balance both succeeded. The figure is now `merchantAvailableSql`
 * (payouts included), and the INSERT itself carries the comparison, so two
 * payouts racing on one balance cannot both land.
 *
 * A REPLAY IS THE SAME PAYOUT, AND NOTHING ELSE IS (B14). The old catch-all
 * answered EVERY failed insert — a foreign-key failure, a transient D1 error,
 * a key another merchant's payout already carried — with «already recorded»
 * while nothing had been written. Only this key, for this merchant and this
 * amount, is a replay; the same key for anything else is 409
 * IDEMPOTENCY_KEY_REUSED; every other error propagates as the failure it is.
 */
adminCommunityRoutes.post('/merchants/:id/payout', requireFinancialScope, async (c) => {
  const admin = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const body = await c.req.json().catch(() => ({}));
  const amount = int(body.amount_iqd, 'amount_iqd', { min: 1, max: 1_000_000_000 });
  const note = str(body.note, 'note', { min: 0, max: 300, required: false });
  const idempotencyKey = str(body.idempotencyKey, 'idempotencyKey', { min: 8, max: 80 });

  const priorUseOfKey = async (): Promise<'none' | 'this_payout' | 'another_row'> => {
    const row = await c.env.DB.prepare(
      'SELECT merchant_id, kind, amount_iqd FROM merchant_payout_ledger WHERE idempotency_key = ?'
    ).bind(idempotencyKey).first<{ merchant_id: string; kind: string; amount_iqd: number }>();
    if (!row) return 'none';
    return row.merchant_id === id && row.kind === 'payout' && Number(row.amount_iqd) === -amount
      ? 'this_payout'
      : 'another_row';
  };
  const replayed = async () =>
    c.json({ success: true, replayed: true, balance: await merchantBalance(c.env.DB, id) });
  const keyReused = () =>
    conflict('This payout key was already used for a different payout. Start again.', 'IDEMPOTENCY_KEY_REUSED');

  const prior = await priorUseOfKey();
  if (prior === 'this_payout') return replayed();
  if (prior === 'another_row') throw keyReused();

  const merchant = await c.env.DB.prepare('SELECT id FROM community_merchants WHERE id = ?')
    .bind(id)
    .first<{ id: string }>();
  if (!merchant) throw notFound('Merchant not found');

  let written = 0;
  try {
    const res = await c.env.DB.prepare(
      `INSERT INTO merchant_payout_ledger (id, merchant_id, kind, amount_iqd, state, note, admin_id, idempotency_key)
       SELECT ?1, ?2, 'payout', ?3, 'paid', ?4, ?5, ?6
        WHERE ${merchantAvailableSql('?2')} >= ?7`
    ).bind(newId('pay'), id, -amount, note, admin.id, idempotencyKey, amount).run();
    written = res.meta.changes ?? 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('UNIQUE') && msg.includes('idempotency_key')) {
      if ((await priorUseOfKey()) === 'this_payout') return replayed();
      throw keyReused();
    }
    throw e;
  }
  if (!written) {
    // A twin of this very request may have landed first and spent the balance.
    if ((await priorUseOfKey()) === 'this_payout') return replayed();
    const balance = await merchantBalance(c.env.DB, id);
    throw badRequest('That is more than the merchant has available', 'INSUFFICIENT_BALANCE', {
      available_iqd: balance.available_iqd,
    });
  }

  await audit(c.env.DB, admin.id, 'admin.merchant_payout', id, { amount, note, idempotency_key: idempotencyKey });
  return c.json({ success: true, replayed: false, balance: await merchantBalance(c.env.DB, id) });
});
