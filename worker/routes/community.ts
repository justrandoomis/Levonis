import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { safeParse } from '../lib/types';
import { requireAuth, notFound, forbidden, str, HttpError } from '../lib/http';
import { newId } from '../lib/crypto';
import { rateLimit } from '../lib/ratelimit';
import { getTierStatus, benefits, usersWithEntitlement } from '../lib/entitlements';
import { rootDomainFrom, storeUrl } from '../lib/hosts';
import { announceAfterResponse } from '../lib/adminTopicRouting';
import { communityAdminDoor, communityClosedRefusal, communityGate, communityMayEnter, readCommunityGate } from '../lib/communityGate';
import { audit } from '../lib/audit';
import { publishRequest } from './printRequests';

export const communityRoutes = new Hono<AppContext>();

/**
 * PRO STATUS BADGE — deliberately separate from verification.
 *
 * `community_merchants.verified` remains an administrator's independent
 * moderation mark. `pro_badge` is an ACTIVE PRO membership status and is
 * never described as identity/KYC verification. PRO lapses → only the PRO
 * badge disappears; the admin mark is unchanged.
 *
 * Resolved for a whole page of merchants in two queries rather than one
 * getTierStatus per row, but through the SAME `benefits.proMerchantBadge`
 * check so the rule cannot drift from entitlements.ts.
 */
function merchantPublic(m: Record<string, unknown>, proBadges: Set<string>) {
  return {
    id: m.id,
    // The account behind the store, so a customer can open a conversation
    // with them. It is an opaque id — no email, no phone, nothing that
    // identifies the person beyond what the store page already shows — and
    // POST /api/chats/open is the only thing that accepts it.
    user_id: m.user_id,
    name: m.name,
    bio: m.bio,
    avatarUrl: m.avatar_key ? `/files/${m.avatar_key}` : null,
    verified: !!m.verified,
    pro_badge: proBadges.has(String(m.user_id)),
    created_at: m.created_at,
  };
}

function communityProductPublic(p: Record<string, unknown>) {
  return {
    id: p.id,
    slug: p.slug,
    merchant_id: p.merchant_id,
    name: p.name,
    name_ar: p.name_ar,
    description: p.description,
    description_ar: p.description_ar,
    images: safeParse(p.images, []),
    price_iqd: p.price_iqd,
    original_price_iqd: p.original_price_iqd,
    created_at: p.created_at,
  };
}

// ------------------------------------------------- the maintenance gate

/**
 * PUBLIC, AND ALWAYS ANSWERS. Registered BEFORE the gate — and named in
 * COMMUNITY_GATE_OPEN_PATHS so the order can never be the only thing keeping
 * it alive — so the app can ask "is the community open to me?" without being
 * refused, and can then say «تحت الصيانة» because the SERVER said so. That is
 * what lets the owner open the community, or add one member to the list, with
 * one settings write and no deploy.
 *
 * `may_enter` folds the admin door and the allow-list in, so an admin's own
 * phone shows the working community while a customer's shows the notice, and
 * an allow-listed member's shows the community without being told they are on
 * a list. `closed` is what the CARD says; `may_enter` is what this viewer may
 * do about it. They differ for exactly those two people.
 */
communityRoutes.get('/access', async (c) => {
  const gate = await readCommunityGate(c.env.DB);
  const user = c.get('user');
  // Never cached: this is the answer that decides whether a page is shown,
  // and it is per-user — a shared cache would hand one visitor's verdict to
  // the next one through it.
  c.header('Cache-Control', 'no-store');
  return c.json({
    success: true,
    closed: !gate.open,
    admin: communityAdminDoor(user),
    may_enter: communityMayEnter(gate, user),
  });
});

/**
 * The wall. See worker/lib/communityGate.ts for which handlers sit inside it
 * and which few answer with it up — that enumeration was traced to its
 * callers, because closing a merchant out of their own live shop is the one
 * way this change could cost somebody real money.
 */
communityRoutes.use('*', communityGate());

communityRoutes.get('/products', async (c) => {
  // Nothing of a SANCTIONED shop — a suspended merchant, or a suspended store —
  // is served anywhere (owner decision 2026-09-24). The merchant suspension no
  // longer rewrites the store row, so both are asked here.
  const { results } = await c.env.DB.prepare(
    `SELECT p.* FROM community_products p
       JOIN community_merchants m ON m.id = p.merchant_id
       LEFT JOIN merchant_stores s ON s.id = p.store_id
      WHERE p.status = 'active' AND m.status <> 'suspended' AND COALESCE(s.status, '') <> 'suspended'
      ORDER BY p.created_at DESC LIMIT 20`
  ).all();
  return c.json({ success: true, products: results.map(communityProductPublic) });
});

communityRoutes.get('/merchants', async (c) => {
  const root = rootDomainFrom(c.env);
  // The storefront half rides along so a directory card can send the visitor
  // straight to the shop's own address; a profile-only merchant has neither
  // slug nor URL and keeps the in-site page.
  // NOTHING OF A SANCTIONED SHOP (review S5, owner decision 2026-09-24): a
  // suspended merchant or a suspended store is not in the directory at all —
  // its name, bio and avatar are exactly what the storefront no longer serves,
  // and a card linking to the in-site page would advertise them anyway.
  const { results } = await c.env.DB.prepare(
    `SELECT cm.*, s.id AS store_id, s.slug AS store_slug, s.status AS store_status
       FROM community_merchants cm LEFT JOIN merchant_stores s ON s.merchant_id = cm.id
      WHERE cm.status <> 'suspended' AND COALESCE(s.status, '') <> 'suspended'
      ORDER BY cm.created_at DESC LIMIT 20`
  ).all<Record<string, unknown>>();
  const proBadges = await usersWithEntitlement(c.env.DB, results.map((m) => m.user_id), 'proMerchantBadge');
  return c.json({
    success: true,
    merchants: results.map((m) => ({
      ...merchantPublic(m, proBadges),
      store_slug: m.store_slug ?? null,
      // A suspended store — or a suspended merchant's store — is not
      // advertised as a destination; the card falls back to the in-site page.
      // Paused shops keep their address — the page itself says they are closed.
      store_url:
        m.store_slug && m.store_status !== 'suspended' && m.status !== 'suspended'
          ? storeUrl(String(m.store_slug), root, String(m.store_id))
          : null,
    })),
  });
});

/**
 * The community page's short list of requests — the SAME rows the board shows
 * (`GET /api/marketplace/requests`): published, still taking offers, public
 * and not expired. The coarse `status = 'open'` alone also listed a request
 * its customer had made PRIVATE, and one whose expiry had passed.
 */
communityRoutes.get('/requests', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT cr.*, u.username AS customer_username FROM community_requests cr
       LEFT JOIN users u ON u.id = cr.customer_id
      WHERE cr.state IN ('open','receiving_offers') AND cr.visibility = 'public'
        AND (cr.expires_at IS NULL OR cr.expires_at > ?)
      ORDER BY cr.created_at DESC LIMIT 20`
  ).bind(new Date().toISOString()).all<Record<string, unknown>>();
  return c.json({
    success: true,
    requests: results.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      status: r.status,
      customer_username: r.customer_username,
      created_at: r.created_at,
    })),
  });
});

/**
 * A REQUEST FROM THE COMMUNITY PAGE TAKES THE ONE ROAD ONTO THE BOARD
 * (audit 03 §10 E).
 *
 * This used to INSERT with the table's defaults — `open` (0031), public, no
 * expiry — so the request was live on the board at once: no draft, no
 * estimate, no matching, no merchant told, and an expiry sweep with nothing to
 * expire. It is now born a DRAFT exactly as `POST /api/marketplace/requests`
 * makes one, and made public by `publishRequest` (worker/routes/printRequests.ts),
 * the only transition to `open`: it starts the expiry clock, prices what it
 * can and runs the matching. The answer keeps the shape the page that sends
 * it reads (`{ success, id }`, src/pages/Community.tsx), plus what the publish
 * decided. A publish that fails leaves an invisible draft in the customer's
 * own «طلباتي» and answers with the publish's own stable code.
 */
communityRoutes.post('/requests', requireAuth, async (c) => {
  await rateLimit(c, 'community-request', 10, 3600);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const title = str(body.title, 'title', { min: 3, max: 150 });
  const description = str(body.description, 'description', { max: 2000, required: false });
  const id = newId('req');
  const ts = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO community_requests (id, customer_id, title, description, status, state, visibility, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'closed', 'draft', 'public', ?, ?)`
  )
    .bind(id, user.id, title, description, ts, ts)
    .run();
  await audit(c.env.DB, user.id, 'community.request_created', id, { title, state: 'draft', via: 'community' });

  const out = await publishRequest(c.env, user.id, id, {});
  return c.json({ success: true, id, published: true, completeness: out.completeness, matching: out.matching });
});

/**
 * RETIRED onto the request state machine. This set `status = 'closed'` on any
 * of the customer's requests in any state — a paid `in_progress` one included —
 * without touching `state`, so the request stayed on the board and its pending
 * offers were never told. `POST /api/marketplace/requests/:id/cancel` is the
 * customer's one cancel (a draft or a request still taking offers; a paid one
 * is `REQUEST_HAS_ORDER`), and a 307 hands it the same request.
 */
communityRoutes.post('/requests/:id/close', requireAuth, (c) =>
  c.redirect(`/api/marketplace/requests/${encodeURIComponent(c.req.param('id') ?? '')}/cancel`, 307)
);

// Merchant storefront ---------------------------------------------------------

communityRoutes.get('/store/:id', async (c) => {
  const id = c.req.param('id');
  const merchant = await c.env.DB.prepare(
    `SELECT m.*, (SELECT s.status FROM merchant_stores s WHERE s.merchant_id = m.id) AS store_status
       FROM community_merchants m WHERE m.id = ?`
  )
    .bind(id)
    .first<Record<string, unknown>>();
  if (!merchant) throw notFound('Store not found');
  // The in-site profile of a sanctioned shop answers what its storefront does:
  // «المتجر غير متاح حاليًا», and nothing of the shop (worker/routes/storefront.ts).
  if (merchant.status === 'suspended' || merchant.store_status === 'suspended') {
    throw new HttpError(404, 'This store is not available right now', 'STORE_UNAVAILABLE');
  }
  const [{ results: products }, followers] = await Promise.all([
    c.env.DB.prepare(
      "SELECT * FROM community_products WHERE merchant_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 100"
    )
      .bind(id)
      .all(),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM follows WHERE merchant_id = ?').bind(id).first<{ n: number }>(),
  ]);
  const user = c.get('user');
  let following = false;
  if (user) {
    const f = await c.env.DB.prepare('SELECT 1 AS x FROM follows WHERE user_id = ? AND merchant_id = ?')
      .bind(user.id, id)
      .first();
    following = !!f;
  }
  const proBadges = await usersWithEntitlement(c.env.DB, [merchant.user_id], 'proMerchantBadge');
  return c.json({
    success: true,
    merchant: merchantPublic(merchant, proBadges),
    products: products.map(communityProductPublic),
    followers: followers?.n ?? 0,
    following,
  });
});

communityRoutes.post('/store/:id/follow', requireAuth, async (c) => {
  const user = c.get('user')!;
  const id = c.req.param('id');
  const merchant = await c.env.DB.prepare('SELECT id FROM community_merchants WHERE id = ?').bind(id).first();
  if (!merchant) throw notFound('Store not found');
  await c.env.DB.prepare(
    'INSERT INTO follows (user_id, merchant_id) VALUES (?, ?) ON CONFLICT DO NOTHING'
  )
    .bind(user.id, id)
    .run();
  return c.json({ success: true, following: true });
});

communityRoutes.delete('/store/:id/follow', requireAuth, async (c) => {
  const user = c.get('user')!;
  await c.env.DB.prepare('DELETE FROM follows WHERE user_id = ? AND merchant_id = ?')
    .bind(user.id, c.req.param('id'))
    .run();
  return c.json({ success: true, following: false });
});

communityRoutes.get('/followed', requireAuth, async (c) => {
  const user = c.get('user')!;
  const root = rootDomainFrom(c.env);
  const { results } = await c.env.DB.prepare(
    `SELECT cm.*, s.id AS store_id, s.slug AS store_slug, s.status AS store_status
       FROM follows f
       JOIN community_merchants cm ON cm.id = f.merchant_id
       LEFT JOIN merchant_stores s ON s.merchant_id = cm.id
      WHERE f.user_id = ? ORDER BY f.created_at DESC`
  )
    .bind(user.id)
    .all<Record<string, unknown>>();
  const proBadges = await usersWithEntitlement(c.env.DB, results.map((m) => m.user_id), 'proMerchantBadge');
  return c.json({
    success: true,
    merchants: results.map((m) =>
      // A shop the customer follows that Levonis has since SANCTIONED stays
      // in their list — so they can unfollow it — as a neutral card (review
      // S5): its id and `unavailable`, and not one field the merchant wrote.
      m.status === 'suspended' || m.store_status === 'suspended'
        ? {
            id: m.id,
            unavailable: true,
            name: null,
            bio: null,
            avatarUrl: null,
            verified: false,
            pro_badge: false,
            created_at: m.created_at,
            store_slug: null,
            store_url: null,
          }
        : {
            ...merchantPublic(m, proBadges),
            unavailable: false,
            store_slug: m.store_slug ?? null,
            store_url: m.store_slug ? storeUrl(String(m.store_slug), root, String(m.store_id)) : null,
          }
    ),
  });
});

// Merchant self-service -------------------------------------------------------

/** The signed-in user's merchant profile (creates none; explicit setup). */
communityRoutes.get('/my-store', requireAuth, async (c) => {
  const user = c.get('user')!;
  const merchant = await c.env.DB.prepare('SELECT * FROM community_merchants WHERE user_id = ?')
    .bind(user.id)
    .first<Record<string, unknown>>();
  if (!merchant) return c.json({ success: true, merchant: null, products: [] });
  const { results: products } = await c.env.DB.prepare(
    'SELECT * FROM community_products WHERE merchant_id = ? ORDER BY created_at DESC'
  )
    .bind(merchant.id)
    .all();
  const proBadges = await usersWithEntitlement(c.env.DB, [user.id], 'proMerchantBadge');
  return c.json({ success: true, merchant: merchantPublic(merchant, proBadges), products: products.map(communityProductPublic) });
});

communityRoutes.post('/my-store', requireAuth, async (c) => {
  await rateLimit(c, 'store-save', 30, 3600);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const name = str(body.name, 'name', { min: 2, max: 100 });
  const bio = str(body.bio, 'bio', { max: 500, required: false });

  const existing = await c.env.DB.prepare('SELECT id FROM community_merchants WHERE user_id = ?')
    .bind(user.id)
    .first<{ id: string }>();
  if (existing) {
    await c.env.DB.prepare('UPDATE community_merchants SET name = ?, bio = ? WHERE id = ?')
      .bind(name, bio, existing.id)
      .run();
    return c.json({ success: true, id: existing.id });
  }
  // A NEW community merchant is a way INTO the community, so it waits while
  // the community is under maintenance (owner, 2026-09-23 — docs/DECISIONS.md).
  // The branch above is untouched: an existing merchant keeps editing theirs.
  if (!communityMayEnter(await readCommunityGate(c.env.DB), user)) throw communityClosedRefusal();
  // Creating a NEW merchant profile is a PLUS benefit inherited by PREMIUM
  // and PRO — server-side tier check, never a client flag.
  // server-side tier check, never a client flag. Existing merchants above
  // are grandfathered for updates and product management.
  const status = await getTierStatus(c.env.DB, user.id);
  if (!benefits.merchantProfile(status)) {
    throw forbidden('يتطلب عضوية LEVO PLUS أو PREMIUM أو PRO / Requires an active LEVO PLUS, PREMIUM, or PRO membership');
  }

  const id = newId('cm');
  // verified stays 0 — the stored flag is the admin's mark. A PRO owner's
  // badge is resolved from the memberships ledger on every read instead
  // (proBadgeOwners), so it follows the membership and never goes stale.
  await c.env.DB.prepare('INSERT INTO community_merchants (id, user_id, name, bio) VALUES (?, ?, ?, ?)')
    .bind(id, user.id, name, bio)
    .run();
  /**
   * «⚡ Merchants verification» GETS ITS TRAFFIC.
   *
   * `verified` stays 0 above — the flag is the admin's mark, deliberately — so
   * this row is a person WAITING on a human. Nothing told that human. A new
   * merchant sat unverified for as long as it took somebody to notice, and an
   * unverified merchant is one whose customers see no badge on a store they
   * are being asked to pay.
   *
   * The name is a shopfront the merchant chose to publish, so it is the one
   * customer-supplied string that belongs here; the bio is not, because it is
   * 500 characters of prose and the id opens all of it in the admin panel.
   */
  announceAfterResponse(
    c,
    'merchant_verification',
    `⚡ New merchant profile awaiting verification` +
      `\nMerchant: ${id}` +
      `\nName: ${name.slice(0, 80)}`
  );
  return c.json({ success: true, id });
});

/**
 * RETIRED — the store API is the one door for a merchant's products (audit 01
 * B10).
 *
 * These two wrote products with none of the store rules: no store (the row had
 * `store_id` NULL), no selling entitlement or suspension check, any image URL
 * at all (an off-platform tracking pixel on the community pages), and a hard
 * DELETE that took ordered products out from under their order lines. They
 * stay reachable while the community is closed, so they were the way around
 * every rule `/api/merchant/products` enforces.
 *
 * A 307 hands the SAME request — method and body — to the store route, so an
 * old client still works, under the rules: `requireSellingPrivileges`, owned
 * media only, archive-not-delete for anything ever ordered. The legacy editor
 * in /edit-profile now sends merchants to /merchant.
 */
communityRoutes.post('/my-store/products', requireAuth, (c) => c.redirect('/api/merchant/products', 307));

communityRoutes.delete('/my-store/products/:id', requireAuth, (c) =>
  c.redirect(`/api/merchant/products/${encodeURIComponent(c.req.param('id') ?? '')}`, 307)
);

// Community profile completeness (used by the /community route guard).
communityRoutes.get('/profile-status', requireAuth, async (c) => {
  const user = c.get('user')!;
  const merchant = await c.env.DB.prepare('SELECT id FROM community_merchants WHERE user_id = ?')
    .bind(user.id)
    .first();
  // merchant_allowed: existing merchants are grandfathered; new stores need
  // an active paid membership (server-side inherited entitlement check).
  const status = await getTierStatus(c.env.DB, user.id);
  return c.json({
    success: true,
    complete: !!(user.username && user.name),
    hasStore: !!merchant,
    merchant_allowed: !!merchant || benefits.merchantProfile(status),
  });
});
