/**
 * Merchant store administration — /api/merchant/*.
 *
 * This is NOT the platform admin API. It is deliberately a different mount
 * with a different name, because the two must never be confused: every route
 * here resolves the caller's OWN store from their session
 * (`requireStoreOwner`) and constrains every query by that store's id. There
 * is no store id in a path or a body for a caller to swap (§54, §72).
 *
 * Reading and selling are separated throughout. When PLUS lapses or an admin
 * suspends a store, the merchant keeps every read — orders, money, disputes,
 * chats — and keeps finishing work already accepted. Only NEW commitments
 * stop (§47, §48). That is why the read routes take `requireStoreOwner` and
 * the write routes that create obligations take `requireSellingPrivileges`.
 */

import { Hono } from 'hono';
import { rematchNow } from '../lib/printMatchingStore';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { safeParse } from '../lib/types';
import { requireAuth, badRequest, forbidden, notFound, conflict, str, int, oneOf, HttpError } from '../lib/http';
import { communityClosedRefusal, communityMayEnter, readCommunityGate } from '../lib/communityGate';
import { newId } from '../lib/crypto';
import { rateLimit } from '../lib/ratelimit';
import { audit, auditStatements } from '../lib/audit';
import { ownedMediaKey } from '../lib/mediaRefs';
import { getTierStatus, benefits } from '../lib/entitlements';
import { rootDomainFrom, storeUrl } from '../lib/hosts';
import {
  requireStoreOwner,
  requireSellingPrivileges,
  sellingStatus,
  merchantForUser,
  storeForUser,
  type StoreContext,
} from '../lib/merchantAuth';
import { checkSlug, suggestSlug, SLUG_RESERVATION_DAYS } from '../lib/merchantOps';
import { merchantBalance } from '../lib/escrowOps';
import { orderCreditStateSql } from '../lib/merchantLedger';
import { normalizeGovernorate } from '../lib/iraqGovernorates';
import { announceAfterResponse } from '../lib/adminTopicRouting';
import { notifyOrderStatus } from '../lib/orderNotify';
import { cancelStoreOrder, STORE_RELEASE_DAYS } from '../lib/storeOrderOps';
import { stageForLegacyStatus } from '../lib/orderStages';
import { newHistoryId } from '../lib/orderStageOps';
import { scheduleStoreIconRefresh } from '../lib/storeIcons';
import { storeShareKit } from '../lib/storeShareKit';
import { FORCED_PREFS, NOTIFICATION_PREF_KEYS, WIRED_PREFS, preferenceShape } from '../lib/merchantNotify';
import {
  deliveryConfigShape,
  isDeliveryVersionAbort,
  legacyDoorStatements,
  loadDeliveryConfig,
  merchantDeliveryFeeMax,
  saveDeliveryStatements,
} from '../lib/merchantDelivery';
import { deliveryCoverage, validateDeliveryConfig } from '@levonis/shipping/merchantDelivery';
import { CUSTOM_ORDER_EARNED_SQL, CUSTOM_ORDER_KEPT_RECEIVABLE_SQL } from '../lib/communityStates';

export const merchantRoutes = new Hono<AppContext>();

merchantRoutes.use('*', requireAuth);

const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------- shapes

function storePublicShape(ctx: StoreContext, rootDomain: string | null) {
  const { store: s, merchant: m } = ctx;
  return {
    id: s.id,
    merchant_id: s.merchant_id,
    slug: s.slug,
    url: storeUrl(s.slug, rootDomain, s.id),
    name: s.name,
    tagline: s.tagline,
    description: s.description,
    logoUrl: s.logo_key ? `/files/${s.logo_key}` : null,
    bannerUrl: s.banner_key ? `/files/${s.banner_key}` : null,
    accent: s.accent,
    categories: safeParse(s.categories, []),
    governorate: s.governorate,
    service_areas: safeParse(s.service_areas, []),
    contact_phone: s.contact_phone,
    contact_phone_public: !!s.contact_phone_public,
    business_hours: safeParse(s.business_hours, []),
    policies: safeParse(s.policies, {}),
    delivery_settings: safeParse(s.delivery_settings, {}),
    social_links: safeParse(s.social_links, {}),
    profile_links: safeParse(s.profile_links, []),
    profile_facts: safeParse(s.profile_facts, []),
    accepts_custom_requests: !!s.accepts_custom_requests,
    sells_direct_products: !!s.sells_direct_products,
    status: s.status,
    status_reason: s.status_reason,
    created_at: s.created_at,
    merchant: {
      id: m.id,
      name: m.name,
      verified: !!m.verified,
      status: m.status,
      badge: m.badge_override || m.badge,
      rating: m.rating_count ? m.rating_avg_x100 / 100 : null,
      rating_count: m.rating_count,
      completed_orders: m.completed_orders,
    },
  };
}

// ------------------------------------------------------------- onboarding

/** A UNIQUE / PRIMARY KEY refusal from D1 (or SQLite in the tests). */
function isUniqueViolation(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes('UNIQUE') || msg.includes('PRIMARY KEY');
}

/**
 * WHAT A LOST ONBOARDING RACE MEANS (audit 01 B24). The slug check and the
 * insert are two steps, so two people can pass the check for one slug — or
 * one person can double-tap «افتح متجري» — and the loser's batch hits a
 * UNIQUE. That used to surface as a raw 500. The batch is one transaction, so
 * nothing half-landed; the only question is which race was lost.
 */
async function onboardRace(db: D1Database, userId: string, e: unknown): Promise<unknown> {
  if (!isUniqueViolation(e)) return e;
  if (await storeForUser(db, userId)) return conflict('You already have a store', 'STORE_EXISTS');
  return conflict('That store address was just taken — choose another', 'SLUG_UNAVAILABLE');
}

/**
 * Is this slug free? Called as the merchant types, so it is rate-limited and
 * returns a REASON rather than a bare boolean — "taken" and "reserved" need
 * different words in the UI, and "recently_released" needs an explanation.
 */
merchantRoutes.get('/slug-check', async (c) => {
  await rateLimit(c, 'merchant-slug-check', 60, 60);
  const raw = str(c.req.query('slug'), 'slug', { min: 1, max: 64 });
  const store = await storeForUser(c.env.DB, c.get('user')!.id);
  const result = await checkSlug(c.env.DB, raw, store?.store.id ?? null);
  return c.json({ success: true, ...result });
});

/** What the current user may do in the community, and what they have. */
merchantRoutes.get('/me', async (c) => {
  const user = c.get('user')!;
  const tier = await getTierStatus(c.env.DB, user.id);
  const root = rootDomainFrom(c.env);
  const ctx = await storeForUser(c.env.DB, user.id);

  return c.json({
    success: true,
    eligible: benefits.merchantStore(tier),
    tier: tier.tier,
    tier_active: tier.active,
    expires_at: tier.expires_at,
    gated_benefits: tier.gated_benefits,
    // Every merchant benefit, resolved server-side. The UI renders from this
    // and never from a tier string it decided for itself.
    can: {
      store: benefits.merchantStore(tier),
      products: benefits.merchantProducts(tier),
      orders: benefits.merchantOrders(tier),
      offers: benefits.communityOffers(tier),
      analytics: benefits.merchantAnalytics(tier),
      subdomain: benefits.merchantSubdomain(tier),
    },
    store: ctx ? storePublicShape(ctx, root) : null,
    selling: ctx ? await sellingStatus(c, ctx) : { canSell: false, reason: 'no_store' },
    suggested_slug: ctx ? null : suggestSlug(String(user.name ?? '')),
    // The domain a store address lives under, from configuration — so
    // onboarding previews `<slug>.<this>` instead of a hard-coded domain
    // (audit 01 B19). Null when none is configured.
    root_domain: root,
  });
});

/**
 * Create the merchant and the store, once.
 *
 * The eligibility check is server-side and reads the memberships ledger — a
 * client claiming to be PLUS gets nothing. The slug is re-validated here even
 * though /slug-check exists, because /slug-check is advice and this is the
 * decision.
 */
merchantRoutes.post('/onboard', async (c) => {
  await rateLimit(c, 'merchant-onboard', 5, 3600);
  const user = c.get('user')!;
  // A NEW store is a new community merchant — a way INTO Levo Community — so
  // it waits while the community is under maintenance, exactly like a new
  // merchant from /api/community/my-store (owner, 2026-09-23; DECISIONS 110).
  // A store that already exists is untouched: it runs on its own address.
  if (!communityMayEnter(await readCommunityGate(c.env.DB), user)) throw communityClosedRefusal();
  const tier = await getTierStatus(c.env.DB, user.id);
  if (!benefits.merchantStore(tier)) {
    throw forbidden('An active LEVO PLUS subscription is required to open a store');
  }

  const existing = await storeForUser(c.env.DB, user.id);
  if (existing) throw conflict('You already have a store');

  const body = await c.req.json().catch(() => ({}));
  const name = str(body.name, 'name', { min: 2, max: 60 });
  const slugCheck = await checkSlug(c.env.DB, String(body.slug ?? ''));
  if (!slugCheck.ok) {
    throw badRequest('That store address is not available', 'SLUG_UNAVAILABLE', { reason: slugCheck.reason });
  }
  const slug = slugCheck.slug;

  const tagline = str(body.tagline, 'tagline', { min: 0, max: 140, required: false });
  const description = str(body.description, 'description', { min: 0, max: 4000, required: false });
  const governorate = governorateId(body.governorate, '');

  const merchantId = (await merchantForUser(c.env.DB, user.id))?.id ?? newId('mch');
  const storeId = newId('str');
  const ts = nowIso();

  // One batch: a store without its merchant, or a slug reservation without
  // its store, is a broken half-state a retry would then trip over.
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO community_merchants (id, user_id, name, bio, governorate, status)
         VALUES (?, ?, ?, ?, ?, 'active')
         ON CONFLICT(user_id) DO UPDATE SET name = excluded.name`
      ).bind(merchantId, user.id, name, tagline, governorate),
      c.env.DB.prepare(
        `INSERT INTO merchant_stores
           (id, merchant_id, user_id, slug, name, tagline, description, governorate, created_at, updated_at)
         VALUES (?, (SELECT id FROM community_merchants WHERE user_id = ?), ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(storeId, user.id, user.id, slug, name, tagline, description, governorate, ts, ts),
      // An UPSERT, as the rename below does: a slug whose 180-day parking has
      // lapsed is free for `checkSlug` but still has its history row, and a
      // plain INSERT on that primary key was a raw 500 for a slug the page had
      // just shown as available.
      c.env.DB.prepare(
        `INSERT INTO merchant_store_slugs (slug, store_id, active) VALUES (?, ?, 1)
         ON CONFLICT(slug) DO UPDATE SET active = 1, reserved_until = NULL, store_id = excluded.store_id`
      ).bind(slug, storeId),
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO merchant_notification_preferences (merchant_id)
         VALUES ((SELECT id FROM community_merchants WHERE user_id = ?))`
      ).bind(user.id),
    ]);
  } catch (e) {
    throw await onboardRace(c.env.DB, user.id, e);
  }

  await audit(c.env.DB, user.id, 'merchant.store_created', storeId, { slug, name });
  /**
   * A STORE OPENING IS THE OTHER HALF OF «⚡ Merchants verification».
   *
   * community.ts announces the bare merchant profile; this batch creates the
   * merchant AND a public storefront on its own address, which is the version
   * a customer will actually land on. Nobody was told either. The slug is
   * included because it is the public URL and because a slug is the one field
   * of a new store an admin ever has to refuse — an impersonating address is
   * caught by reading it, not by opening the record.
   */
  announceAfterResponse(
    c,
    'merchant_verification',
    `⚡ New store awaiting verification` +
      `\nStore: ${storeId}` +
      `\nName: ${name.slice(0, 80)}` +
      `\nAddress: /${slug}`
  );
  const ctx = await storeForUser(c.env.DB, user.id);
  return c.json({ success: true, store: storePublicShape(ctx!, rootDomainFrom(c.env)) }, 201);
});

// ---------------------------------------------------------- store settings

merchantRoutes.patch('/store', async (c) => {
  await rateLimit(c, 'merchant-store-update', 30, 300);
  const ctx = await requireStoreOwner(c);
  const body = await c.req.json().catch(() => ({}));

  // An allowlist, field by field. A merchant may describe their shop; they
  // may not set `status` (that is the platform's and their own pause switch,
  // handled separately), `slug` (a controlled change, below), or anything
  // that carries authority.
  const sets: string[] = [];
  const vals: unknown[] = [];
  const put = (col: string, v: unknown) => { sets.push(`${col} = ?`); vals.push(v); };

  if (body.name !== undefined) put('name', str(body.name, 'name', { min: 2, max: 60 }));
  if (body.tagline !== undefined) put('tagline', str(body.tagline, 'tagline', { min: 0, max: 140, required: false }));
  if (body.description !== undefined)
    put('description', str(body.description, 'description', { min: 0, max: 4000, required: false }));
  if (body.governorate !== undefined) {
    // An id from the closed list, never free text (audit 02 B27). A legacy
    // store still holding free text gets it back from the form on every save;
    // that echo is left as it is — readable, untouched — rather than refusing
    // the merchant's whole save over a field they did not change.
    const gov = governorateId(body.governorate, ctx.store.governorate);
    if (gov !== ctx.store.governorate) put('governorate', gov);
  }
  if (body.contact_phone !== undefined)
    put('contact_phone', str(body.contact_phone, 'contact_phone', { min: 0, max: 32, required: false }));
  if (body.contact_phone_public !== undefined) put('contact_phone_public', body.contact_phone_public ? 1 : 0);
  if (body.accepts_custom_requests !== undefined)
    put('accepts_custom_requests', body.accepts_custom_requests ? 1 : 0);
  if (body.sells_direct_products !== undefined)
    put('sells_direct_products', body.sells_direct_products ? 1 : 0);
  // Logo and banner must address an object THIS platform issued to THIS
  // merchant. An arbitrary string here would put a URL the merchant chose
  // into every visitor's browser — an off-platform tracking pixel wearing a
  // shop's logo. Clearing is `''`; anything else that is not theirs is a 400
  // rather than a silent drop, because a merchant who uploaded a logo and got
  // no logo deserves to be told why.
  for (const [field, col] of [['logo_key', 'logo_key'], ['banner_key', 'banner_key']] as const) {
    if (body[field] === undefined) continue;
    const raw = str(body[field], field, { min: 0, max: 200, required: false });
    if (!raw) { put(col, null); continue; }
    const key = ownedMediaKey(raw, ctx.store.user_id);
    if (!key) throw badRequest(`${field} must be a file you uploaded to this store`);
    put(col, key);
  }

  // A PRESET NAME, never a colour value and never CSS. §12: nothing a
  // merchant types may become a style rule on the page.
  if (body.accent !== undefined) put('accent', oneOf(body.accent, 'accent', ACCENTS));

  for (const [key, col] of [
    ['categories', 'categories'],
    ['service_areas', 'service_areas'],
  ] as const) {
    if (body[key] !== undefined) put(col, JSON.stringify(sanitizeList(body[key], 40, 60)));
  }
  // Hours are {day, open, close} rows, not bare strings — the old string
  // sanitizer silently dropped every structured row the editor sent, so a
  // merchant who filled their hours saved an empty list.
  if (body.business_hours !== undefined) put('business_hours', JSON.stringify(sanitizeHours(body.business_hours)));
  if (body.policies !== undefined) put('policies', JSON.stringify(sanitizeMap(body.policies, 12, 2000)));
  if (body.social_links !== undefined) put('social_links', JSON.stringify(sanitizeLinks(body.social_links)));
  // The two profile-header rows: three link pills, three info cards. Icon is
  // a NAME from a fixed set the frontend maps to its own components; the url
  // is http(s) or dropped. Order is the array order the merchant saved.
  if (body.profile_links !== undefined) put('profile_links', JSON.stringify(sanitizeWidgets(body.profile_links, 'link')));
  if (body.profile_facts !== undefined) put('profile_facts', JSON.stringify(sanitizeWidgets(body.profile_facts, 'fact')));
  // The wave-1 flat delivery settings, kept for a cached build of the form and
  // for rollback: the checkout now prices from the delivery profile
  // (GET/PUT /delivery below, W2-A), which a real edit here also reaches.
  if (body.delivery_settings !== undefined) put('delivery_settings', JSON.stringify(sanitizeDelivery(body.delivery_settings)));

  // The merchant's own pause switch. It can never lift an admin suspension:
  // that state is not reachable from here at all.
  if (body.open !== undefined) {
    const wantOpen = body.open === true;
    if (ctx.store.status === 'suspended') {
      /*
       * A SUSPENDED STORE STILL SAVES ITS SETTINGS (audit 01 B4). Any `open` in
       * the body — and the settings form always sent one — used to 403 the
       * WHOLE save, so a merchant suspended for a bad banner could not fix the
       * banner. Now only the open/closed state is Levonis's while the
       * suspension lasts: asking to OPEN is refused with a stable code, and
       * «closed» is what the store already is, so it is not written at all —
       * writing 'paused' over 'suspended' would hand the merchant the key to
       * the admin's lock (they re-open a paused store themselves).
       */
      if (wantOpen) {
        throw new HttpError(403, 'This store is suspended by Levonis and cannot be re-opened from here', 'STORE_SUSPENDED');
      }
    } else if (wantOpen) {
      // Re-opening is taking on new orders, so it asks what selling asks
      // (worker/lib/merchantAuth.ts `requireSellingPrivileges`): a suspended
      // merchant, or one whose store entitlement has lapsed (audit 01 B3), may
      // pause and edit their shop but not re-open it.
      if (ctx.merchant.status === 'suspended') {
        throw new HttpError(403, 'This merchant account is suspended. Contact support.', 'MERCHANT_SUSPENDED');
      }
      if (!benefits.merchantStore(await getTierStatus(c.env.DB, ctx.store.user_id))) {
        throw new HttpError(
          403,
          'Your store subscription is not active. Renew it to re-open the store.',
          'SUBSCRIPTION_INACTIVE'
        );
      }
      // An open store must be able to deliver somewhere, or offer pickup
      // (W2-A): re-opening a shop whose delivery is switched off everywhere
      // would take orders nobody can receive.
      if (ctx.store.status !== 'active') {
        const cfg = await loadDeliveryConfig(c.env.DB, ctx.store);
        if (!deliveryCoverage(cfg.profile, cfg.rules).serviceable) {
          throw new HttpError(409, 'Choose where you deliver, or offer pickup, before opening the store', 'DELIVERY_NO_COVERAGE');
        }
      }
      put('status', 'active');
    } else {
      put('status', 'paused');
    }
  }

  if (!sets.length) return c.json({ success: true, store: storePublicShape(ctx, rootDomainFrom(c.env)) });

  const ts = nowIso();
  put('updated_at', ts);
  vals.push(ctx.store.id, ctx.store.user_id);
  // THE WAVE-1 DELIVERY FIELD, FROM A CACHED BUILD OF THIS FORM (W2-A): an
  // unchanged echo moves nothing; a real edit reaches the delivery profile in
  // the same batch (worker/lib/merchantDelivery.ts `legacyDoorStatements`).
  // The legacy door honours the platform's maximum fee too (owner decision 2026-09-25).
  if (body.delivery_settings !== undefined) {
    const legacyFee = Number(sanitizeDelivery(body.delivery_settings).fee_iqd ?? 0);
    const maxFee = await merchantDeliveryFeeMax(c.env.DB);
    if (legacyFee > maxFee) {
      throw badRequest(`A delivery fee may be at most ${maxFee} IQD`, 'DELIVERY_FEE_ABOVE_MAX', {
        max_fee_iqd: maxFee,
        offending: [{ scope: 'profile', governorate_id: null, field: 'fee_iqd', fee_iqd: legacyFee }],
      });
    }
  }
  const legacyDelivery =
    body.delivery_settings !== undefined
      ? legacyDoorStatements(c.env.DB, {
          storeId: ctx.store.id,
          storedJson: ctx.store.delivery_settings,
          incoming: sanitizeDelivery(body.delivery_settings),
          userId: ctx.store.user_id,
          ts,
        })
      : [];
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE merchant_stores SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).bind(...vals),
    ...legacyDelivery,
  ]);

  await audit(c.env.DB, ctx.store.user_id, 'merchant.store_updated', ctx.store.id, {
    fields: sets.map((s) => s.split(' = ')[0]),
  });
  const fresh = await storeForUser(c.env.DB, ctx.store.user_id);
  // THE APP ICON FOLLOWS THE LOGO (merchant platform W2-D). A new logo — or a
  // preset whose ground the icons are padded on — is cut into the store's PNG
  // renditions AFTER this response (worker/lib/storeIcons.ts); a removed logo
  // clears them. Never in front of the save, and never able to fail it.
  if (fresh && (fresh.store.logo_key !== ctx.store.logo_key || fresh.store.accent !== ctx.store.accent)) {
    scheduleStoreIconRefresh(c, fresh.store);
  }
  return c.json({ success: true, store: storePublicShape(fresh!, rootDomainFrom(c.env)) });
});

// ------------------------------------------------------------- delivery (W2-A)
//
// THE MERCHANT SETS THEIR STORE'S DELIVERY (docs/MERCHANT_PLATFORM.md §2
// decision 3, §4.2): a default (fee / free / off), a free-delivery threshold,
// pickup, preparation days, a note — and the eighteen governorates where they
// depart from the default. The OWNER's store only, from the session; every
// value is checked by the one validator the editor also runs
// (packages/shipping/src/merchantDelivery.ts `validateDeliveryConfig`), and
// every save bumps the profile's version, which the checkout's quote
// fingerprint binds.

/**
 * The fees a save put above the platform's cap, named (review F13): the
 * profile's default (`scope: 'profile'`) or one governorate's rule, with the
 * fee that was sent. Read from the validator's own issue paths —
 * `profile.<field>` / `rules.<governorate>.<field>` (`rules[<i>]` unnamed).
 */
function feesAboveMax(
  issues: ReadonlyArray<{ path: string; code: string }>,
  body: { profile?: unknown; rules?: unknown }
): Array<{ scope: 'profile' | 'rule'; governorate_id: string | null; field: string; fee_iqd: number | null }> {
  const profile = (body.profile && typeof body.profile === 'object' ? body.profile : {}) as Record<string, unknown>;
  const rules = Array.isArray(body.rules) ? (body.rules as Array<Record<string, unknown>>) : [];
  const fee = (v: unknown) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : null);
  return issues
    .filter((i) => i.code === 'fee_above_max')
    .map((i) => {
      const named = /^rules\.([^.[\]]+)\.(\w+)$/.exec(i.path);
      if (named) {
        const rule = rules.find((r) => r && r.governorate_id === named[1]);
        return { scope: 'rule' as const, governorate_id: named[1], field: named[2], fee_iqd: fee(rule?.[named[2]]) };
      }
      const indexed = /^rules\[(\d+)\]\.?(\w*)$/.exec(i.path);
      if (indexed) {
        const rule = rules[Number(indexed[1])];
        const field = indexed[2] || 'fee_iqd';
        return { scope: 'rule' as const, governorate_id: null, field, fee_iqd: fee(rule?.[field]) };
      }
      const field = i.path.replace(/^profile\./, '');
      return { scope: 'profile' as const, governorate_id: null, field, fee_iqd: fee(profile[field]) };
    });
}

merchantRoutes.get('/delivery', async (c) => {
  const ctx = await requireStoreOwner(c);
  const cfg = await loadDeliveryConfig(c.env.DB, ctx.store);
  return c.json({ success: true, ...deliveryConfigShape(cfg, ctx.store.status === 'active') });
});

/**
 * PUT /api/merchant/delivery `{version, profile, rules[]}` — the whole
 * configuration, replacing the stored one.
 *   400 DELIVERY_INVALID {issues:[{path, code}]}  a value outside the rules
 *   409 DELIVERY_NO_COVERAGE                      the store is open and would
 *                                                 deliver nowhere, with no pickup
 *   409 DELIVERY_VERSION_CONFLICT {config}        saved elsewhere since this
 *                                                 editor loaded (two tabs)
 * One batch: the version fence, the profile, the rules, the rollback mirror
 * and the audit row — all or nothing.
 */
merchantRoutes.put('/delivery', async (c) => {
  await rateLimit(c, 'merchant-delivery-update', 30, 300);
  const ctx = await requireStoreOwner(c);
  const body = await c.req.json().catch(() => ({}));
  const expected = body?.version;
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) {
    throw badRequest('Send the version you loaded', 'DELIVERY_INVALID', { issues: [{ path: 'version', code: 'not_integer' }] });
  }
  // The platform's maximum fee (owner decision 2026-09-25): the SAME validator,
  // given the cap, names every fee above it; such a save is refused whole.
  const maxFee = await merchantDeliveryFeeMax(c.env.DB);
  const checked = validateDeliveryConfig({ profile: body?.profile, rules: body?.rules }, { maxFeeIqd: maxFee });
  if (!checked.ok) {
    if (checked.issues.some((i) => i.code === 'fee_above_max')) {
      throw badRequest(`A delivery fee may be at most ${maxFee} IQD`, 'DELIVERY_FEE_ABOVE_MAX', {
        max_fee_iqd: maxFee,
        issues: checked.issues,
        // WHICH fee is over the cap (review F13): the default, or the rule for
        // a named governorate — so the editor can point at the row to lower.
        offending: feesAboveMax(checked.issues, body),
      });
    }
    throw badRequest('The delivery settings are not valid', 'DELIVERY_INVALID', { issues: checked.issues });
  }

  const open = ctx.store.status === 'active';
  if (open && !deliveryCoverage({ ...checked.profile, version: expected }, checked.rules).serviceable) {
    throw new HttpError(
      409,
      'An open store must deliver to at least one governorate or offer pickup',
      'DELIVERY_NO_COVERAGE'
    );
  }

  const db = c.env.DB;
  const ts = nowIso();
  const { statements: auditRows } = await auditStatements(db, ctx.store.user_id, 'merchant.delivery_updated', ctx.store.id, {
    version: expected + 1,
    default_mode: checked.profile.default_mode,
    default_fee_iqd: checked.profile.default_fee_iqd,
    free_over_iqd: checked.profile.free_over_iqd,
    pickup: checked.profile.pickup_enabled,
    rules: checked.rules.map((r) => `${r.governorate_id}:${r.mode}${r.mode === 'fee' ? `:${r.fee_iqd}` : ''}`),
  });
  try {
    await db.batch([
      ...saveDeliveryStatements(db, {
        storeId: ctx.store.id,
        expectedVersion: expected,
        profile: checked.profile,
        rules: checked.rules,
        userId: ctx.store.user_id,
        ts,
      }),
      ...auditRows,
    ]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!isDeliveryVersionAbort(msg)) throw e;
    const fresh = await loadDeliveryConfig(db, ctx.store);
    throw new HttpError(409, 'These delivery settings were changed elsewhere. Review them and save again.', 'DELIVERY_VERSION_CONFLICT', {
      config: deliveryConfigShape(fresh, open),
    });
  }
  const fresh = await loadDeliveryConfig(db, ctx.store);
  // Delivery reach is a dimension of request eligibility (W5-B): re-match this workshop.
  await rematchNow(c.env, 'merchant', ctx.merchant.id, 'delivery');
  return c.json({ success: true, ...deliveryConfigShape(fresh, open) });
});

// GET /store/share — the share kit (W2-D): the store's absolute link, the
// card that link unfurls as and the app icon a customer installs, all read
// from the functions the crawler and the installer themselves use
// (worker/lib/storeShareKit.ts). The OWNER's store only — from the session.
merchantRoutes.get('/store/share', async (c) => {
  await rateLimit(c, 'merchant-store-share', 60, 300);
  const ctx = await requireStoreOwner(c);
  return c.json({ success: true, ...(await storeShareKit(c, ctx)) });
});

const ACCENTS = ['default', 'olive', 'gold', 'slate', 'plum', 'teal', 'blue'] as const;

/**
 * A store's governorate, as the closed-list id couriers and the delivery rules
 * route on (`normalizeGovernorate`: the id, or its name in any of the three
 * languages). Empty clears it. Anything else is refused with a stable code —
 * EXCEPT the value already stored, which is a legacy free-text row being
 * echoed back by the settings form and is kept exactly as it was.
 */
function governorateId(raw: unknown, stored: string): string {
  const text = str(raw, 'governorate', { min: 0, max: 60, required: false }).trim();
  if (!text) return '';
  const id = normalizeGovernorate(text);
  if (id) return id;
  if (text === (stored ?? '').trim()) return stored;
  throw badRequest('Choose a governorate from the list', 'GOVERNORATE_INVALID');
}

function sanitizeList(v: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim().slice(0, maxLen))
    .filter(Boolean)
    .slice(0, maxItems);
}

function sanitizeMap(v: unknown, maxKeys: number, maxLen: number): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  let n = 0;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (n++ >= maxKeys) break;
    if (typeof val === 'string') out[k.slice(0, 40)] = val.slice(0, maxLen);
  }
  return out;
}

/**
 * The icon vocabulary of the profile widgets. A closed list, because an icon
 * name reaches the DOM as a component choice — an open string would be a
 * component-injection vector waiting for a clever payload.
 */
export const WIDGET_ICONS = [
  'link', 'globe', 'instagram', 'facebook', 'youtube', 'tiktok', 'telegram', 'whatsapp',
  'phone', 'map-pin', 'clock', 'package', 'truck', 'shield', 'star', 'printer',
  'layers', 'hammer', 'zap', 'award',
] as const;

interface ProfileWidget {
  icon: string;
  title: string;
  subtitle?: string;
  url?: string;
  visible: boolean;
}

function sanitizeWidgets(v: unknown, kind: 'link' | 'fact'): ProfileWidget[] {
  if (!Array.isArray(v)) return [];
  const out: ProfileWidget[] = [];
  for (const raw of v) {
    if (out.length >= 3) break;
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const icon = typeof r.icon === 'string' && (WIDGET_ICONS as readonly string[]).includes(r.icon) ? r.icon : 'link';
    const title = typeof r.title === 'string' ? r.title.trim().slice(0, 30) : '';
    if (!title) continue;
    const item: ProfileWidget = { icon, title, visible: r.visible !== false };
    if (kind === 'fact') {
      item.subtitle = typeof r.subtitle === 'string' ? r.subtitle.trim().slice(0, 40) : '';
    } else {
      try {
        const u = new URL(String(r.url ?? ''));
        const href = u.toString();
        // Same 300-char ceiling as sanitizeLinks: an uncapped stored URL is
        // replayed to every visitor of a public, unauthenticated endpoint.
        if ((u.protocol === 'http:' || u.protocol === 'https:') && href.length <= 300) item.url = href;
      } catch {
        /* not a URL — the item is kept for the editor; the public page skips
           url-less pills entirely until the merchant fixes it */
      }
    }
    out.push(item);
  }
  return out;
}

function sanitizeHours(v: unknown): Array<{ day: string; open: string; close: string }> {
  if (!Array.isArray(v)) return [];
  const time = (x: unknown) => (typeof x === 'string' && /^\d{1,2}:\d{2}$/.test(x.trim()) ? x.trim() : '');
  return v
    .map((row) => {
      if (typeof row === 'string') return { day: row.trim().slice(0, 60), open: '', close: '' };
      if (!row || typeof row !== 'object') return null;
      const r = row as Record<string, unknown>;
      const day = typeof r.day === 'string' ? r.day.trim().slice(0, 60) : '';
      return day ? { day, open: time(r.open), close: time(r.close) } : null;
    })
    .filter((r): r is { day: string; open: string; close: string } => !!r && !!r.day)
    .slice(0, 14);
}

function sanitizeDelivery(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const raw = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const fee = Number(raw.fee_iqd);
  const freeOver = Number(raw.free_over_iqd);
  if (Number.isFinite(fee) && fee >= 0) out.fee_iqd = Math.floor(Math.min(fee, 1_000_000));
  if (Number.isFinite(freeOver) && freeOver > 0) out.free_over_iqd = Math.floor(Math.min(freeOver, 1_000_000_000));
  if (typeof raw.note === 'string' && raw.note.trim()) out.note = raw.note.trim().slice(0, 200);
  return out;
}

/**
 * Social links, reduced to http(s) URLs only.
 * A `javascript:` or `data:` href in a store profile is a stored XSS against
 * every visitor of that storefront, so the scheme is checked on the way IN —
 * not left to the renderer to remember.
 */
function sanitizeLinks(v: unknown): Record<string, string> {
  const raw = sanitizeMap(v, 10, 300);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(raw)) {
    try {
      const u = new URL(val);
      if (u.protocol === 'http:' || u.protocol === 'https:') out[k] = u.toString();
    } catch {
      /* not a URL — dropped */
    }
  }
  return out;
}

/**
 * Change the store address. Controlled, audited, and the old name is parked
 * rather than released (§68): every link and QR code already printed on a box
 * keeps meaning something, and a competitor cannot capture the traffic.
 */
merchantRoutes.post('/store/slug', async (c) => {
  await rateLimit(c, 'merchant-slug-change', 3, 86_400);
  const ctx = await requireSellingPrivileges(c);
  const body = await c.req.json().catch(() => ({}));

  const check = await checkSlug(c.env.DB, String(body.slug ?? ''), ctx.store.id);
  if (!check.ok) throw badRequest('That store address is not available', 'SLUG_UNAVAILABLE', { reason: check.reason });
  if (check.slug === ctx.store.slug) return c.json({ success: true, slug: ctx.store.slug, changed: false });

  const reservedUntil = new Date(Date.now() + SLUG_RESERVATION_DAYS * 86_400_000).toISOString();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE merchant_store_slugs SET active = 0, reserved_until = ? WHERE store_id = ? AND active = 1`
      ).bind(reservedUntil, ctx.store.id),
      c.env.DB.prepare(
        `INSERT INTO merchant_store_slugs (slug, store_id, active) VALUES (?, ?, 1)
         ON CONFLICT(slug) DO UPDATE SET active = 1, reserved_until = NULL, store_id = excluded.store_id`
      ).bind(check.slug, ctx.store.id),
      c.env.DB.prepare(`UPDATE merchant_stores SET slug = ?, updated_at = ? WHERE id = ? AND user_id = ?`)
        .bind(check.slug, nowIso(), ctx.store.id, ctx.store.user_id),
    ]);
  } catch (e) {
    // Another store took the name between the check and this batch: the
    // UNIQUE on `merchant_stores.slug` rolled the whole rename back, so the
    // old address is still this store's. A stable 409, not a raw 500.
    if (!isUniqueViolation(e)) throw e;
    throw conflict('That store address was just taken — choose another', 'SLUG_UNAVAILABLE');
  }

  await audit(c.env.DB, ctx.store.user_id, 'merchant.slug_changed', ctx.store.id, {
    from: ctx.store.slug,
    to: check.slug,
  });
  return c.json({ success: true, slug: check.slug, changed: true, previous: ctx.store.slug });
});

// ----------------------------------------------------------------- products

/**
 * KEYSET CURSORS THAT NEVER SKIP A ROW (audit 01 B5).
 *
 * A cursor that is only the last row's `created_at`, read back as
 * `created_at < cursor`, drops every other row that shares that instant —
 * exactly what a CSV import produced, one timestamp for up to 200 rows. The
 * cursor is `<created_at>|<id>` and every list orders by both, so a tie is
 * broken by the id. A bare timestamp (a cursor an older client still holds)
 * reads as `(timestamp, '')`, which is the old predicate unchanged.
 */
function keysetCursor(raw: string | undefined): { at: string; id: string } {
  const v = (raw ?? '').slice(0, 200);
  const bar = v.lastIndexOf('|');
  return bar === -1 ? { at: v, id: '' } : { at: v.slice(0, bar), id: v.slice(bar + 1) };
}

function nextKeyset(
  rows: Array<Record<string, unknown>>,
  limit: number,
  atKey: string,
  idKey: string
): string | null {
  if (rows.length !== limit) return null;
  const last = rows[rows.length - 1];
  return `${String(last[atKey])}|${String(last[idKey])}`;
}

// The products themselves — list, create, edit, duplicate, bulk, variants,
// media, insights, import/export — and the store's collections live in
// worker/routes/merchantCatalog.ts (merchant platform W2-F), mounted beside
// this router in worker/index.ts under the same /api/merchant prefix, so every
// URL is the one it always was.

// ------------------------------------------------------------ notifications

merchantRoutes.get('/notifications', async (c) => {
  const ctx = await requireStoreOwner(c);
  const row = await c.env.DB.prepare(
    'SELECT * FROM merchant_notification_preferences WHERE merchant_id = ?'
  ).bind(ctx.merchant.id).first<Record<string, unknown>>();
  return c.json({ success: true, preferences: notificationShape(row), forced: FORCED_NOTIFICATIONS, wired: WIRED_NOTIFICATIONS });
});

/**
 * THE SWITCHES, AND WHAT EACH ONE CONTROLS (audit 04 #19) — defined once, with
 * the notification kinds that read them, in worker/lib/merchantNotify.ts:
 *   - the in-app notice is always written (the store's notification centre);
 *     a switch decides whether the same news also goes to the merchant's
 *     outside channels (Telegram / WhatsApp / email);
 *   - `wired` lists the switches some notification kind reads — the panel
 *     shows the rest as «قريبًا» rather than as a control that does nothing;
 *   - `forced` cannot be switched off (§61): a dispute, the subscription, a
 *     sanction on the store — those decide money and standing.
 */
const WIRED_NOTIFICATIONS = WIRED_PREFS;
const FORCED_NOTIFICATIONS = FORCED_PREFS;
const NOTIFICATION_KEYS = NOTIFICATION_PREF_KEYS;
const notificationShape = preferenceShape;

merchantRoutes.patch('/notifications', async (c) => {
  await rateLimit(c, 'merchant-notifications', 30, 300);
  const ctx = await requireStoreOwner(c);
  const body = await c.req.json().catch(() => ({}));

  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const k of NOTIFICATION_KEYS) {
    if (body[k] === undefined) continue;
    // Accepted and stored, but forced back on: the merchant's preference is
    // remembered for the day policy changes, and today it does not apply.
    const on = (FORCED_NOTIFICATIONS as readonly string[]).includes(k) ? 1 : body[k] ? 1 : 0;
    sets.push(`${k} = ?`);
    vals.push(on);
  }
  if (!sets.length) throw badRequest('Nothing to update');

  await c.env.DB.prepare(
    `INSERT INTO merchant_notification_preferences (merchant_id) VALUES (?)
     ON CONFLICT(merchant_id) DO NOTHING`
  ).bind(ctx.merchant.id).run();

  sets.push('updated_at = ?');
  vals.push(nowIso(), ctx.merchant.id);
  await c.env.DB.prepare(
    `UPDATE merchant_notification_preferences SET ${sets.join(', ')} WHERE merchant_id = ?`
  ).bind(...vals).run();

  const row = await c.env.DB.prepare(
    'SELECT * FROM merchant_notification_preferences WHERE merchant_id = ?'
  ).bind(ctx.merchant.id).first<Record<string, unknown>>();
  return c.json({ success: true, preferences: notificationShape(row), forced: FORCED_NOTIFICATIONS, wired: WIRED_NOTIFICATIONS });
});

// -------------------------------------------------------------- subscription

merchantRoutes.get('/subscription', async (c) => {
  const ctx = await requireStoreOwner(c);
  const user = c.get('user')!;
  const tier = await getTierStatus(c.env.DB, user.id);

  const { results: history } = await c.env.DB.prepare(
    `SELECT m.id, m.plan_id, m.tier, m.state, m.duration_months, m.starts_at, m.expires_at, m.source,
            p.price_iqd
       FROM memberships m LEFT JOIN membership_plans p ON p.id = m.plan_id
      WHERE m.user_id = ? ORDER BY m.created_at DESC LIMIT 20`
  ).bind(user.id).all();

  const daysLeft = tier.expires_at
    ? Math.max(0, Math.ceil((new Date(tier.expires_at).getTime() - Date.now()) / 86_400_000))
    : null;

  return c.json({
    success: true,
    tier: tier.tier,
    active: tier.active,
    expires_at: tier.expires_at,
    days_remaining: daysLeft,
    history,
    // Benefit by benefit, with the restricted ones named. §84: a merchant
    // whose capability was paused over a complaint should be able to see
    // WHICH one, not just find a button missing.
    benefits: {
      store: benefits.merchantStore(tier),
      products: benefits.merchantProducts(tier),
      orders: benefits.merchantOrders(tier),
      offers: benefits.communityOffers(tier),
      analytics: benefits.merchantAnalytics(tier),
      subdomain: benefits.merchantSubdomain(tier),
    },
    restricted: tier.gated_benefits,
    store_status: ctx.store.status,
    store_status_reason: ctx.store.status_reason,
    selling: await sellingStatus(c, ctx),
  });
});

// ---------------------------------------------------------------- followers

merchantRoutes.get('/followers', async (c) => {
  const ctx = await requireStoreOwner(c);
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 100, def: 50 });
  const cursor = c.req.query('cursor') || '';
  // Display name only. A follower list is not a customer directory, and a
  // merchant has no legitimate need for the email or phone of someone who
  // merely followed their shop (§51).
  // Keyset on (created_at, user id): a follower list page never drops the
  // followers who share the boundary row's timestamp (audit 01 B5).
  const key = keysetCursor(cursor);
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.username, f.created_at
       FROM follows f JOIN users u ON u.id = f.user_id
      WHERE f.merchant_id = ?1
        AND (?2 = '' OR f.created_at < ?2 OR (f.created_at = ?2 AND f.user_id < ?3))
      ORDER BY f.created_at DESC, f.user_id DESC LIMIT ?4`
  ).bind(ctx.merchant.id, key.at, key.id, limit).all();

  const total = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM follows WHERE merchant_id = ?'
  ).bind(ctx.merchant.id).first<{ n: number }>();

  return c.json({
    success: true,
    total: total?.n ?? 0,
    followers: results,
    next_cursor: nextKeyset(results, limit, 'created_at', 'id'),
  });
});

// ---------------------------------------------------------------- orders
//
// The section the old dashboard left empty with "no merchant-order backend
// exists yet". Every query is scoped to the caller's own merchant id, so a
// merchant sees their orders and nobody else's — the isolation is the WHERE
// clause, not a filter the client could drop.

/**
 * When a store sale's money becomes the merchant's, if nobody acts first:
 * three days after delivery (worker/lib/storeOrderOps.ts). Null once the
 * credit has moved, or before there is a delivery to count from.
 */
function releaseAfter(o: Record<string, unknown>): string | null {
  if (o.status !== 'delivered' || o.credit_state !== 'pending' || o.receipt_confirmed_at) return null;
  const at = Date.parse(String(o.delivered_at ?? ''));
  return Number.isFinite(at) ? new Date(at + STORE_RELEASE_DAYS * 86_400_000).toISOString() : null;
}

/** The merchant's credit for an order, as a column any order read can add. */
// From the merchant ledger (worker/lib/merchantLedger.ts): pending / available / reversed.
const CREDIT_STATE_SQL = orderCreditStateSql('o.id');

/**
 * Both commerce paths in one list, with an origin filter (§74).
 *
 * PAGED BY (created_at, id), like the product and follower lists (`keysetCursor`
 * above): the orders tab used to read the first 30 and never ask for more
 * (B26), and a timestamp-only cursor would skip orders sharing its instant.
 */
merchantRoutes.get('/orders', async (c) => {
  const ctx = await requireStoreOwner(c);
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 100, def: 30 });
  const cursor = keysetCursor(c.req.query('cursor'));
  const status = c.req.query('status') || '';

  const { results } = await c.env.DB.prepare(
    `SELECT o.id, o.status, o.stage, o.origin, o.total_iqd, o.subtotal_iqd, o.shipping_iqd,
            o.platform_fee_iqd, o.merchant_receivable_iqd, o.payment_method_id,
            o.created_at, o.updated_at, o.delivered_at, o.receipt_confirmed_at,
            u.name AS customer_name,
            (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) AS item_count,
            ${CREDIT_STATE_SQL} AS credit_state
       FROM orders o JOIN users u ON u.id = o.user_id
      WHERE o.merchant_id = ?1
        AND (?2 = '' OR o.status = ?2)
        AND (?3 = '' OR o.created_at < ?3 OR (o.created_at = ?3 AND o.id < ?4))
      ORDER BY o.created_at DESC, o.id DESC LIMIT ?5`
  ).bind(ctx.merchant.id, status, cursor.at, cursor.id, limit).all<Record<string, unknown>>();

  return c.json({
    success: true,
    orders: results.map((o) => ({ ...o, release_after: releaseAfter(o) })),
    next_cursor: nextKeyset(results, limit, 'created_at', 'id'),
  });
});

/**
 * One order, in full — including what the merchant needs to actually deliver
 * it.
 *
 * The customer's delivery address and phone ARE shown here, because a
 * merchant who cannot reach the buyer cannot fulfil the order. What is not
 * shown is anything unrelated to this transaction: no wallet balance, no
 * other purchases, no account metadata, no other store's history (§51, §60).
 */
merchantRoutes.get('/orders/:id', async (c) => {
  const ctx = await requireStoreOwner(c);
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });

  // u.phone_e164, not u.phone — 0013 renamed the account's own number, and
  // this endpoint had never been called by a UI until now, so the stale
  // column name sat here unnoticed and 500'd on first real use.
  const order = await c.env.DB.prepare(
    `SELECT o.*, u.name AS customer_name, u.phone_e164 AS customer_phone, ${CREDIT_STATE_SQL} AS credit_state
       FROM orders o JOIN users u ON u.id = o.user_id
      WHERE o.id = ? AND o.merchant_id = ?`
  ).bind(id, ctx.merchant.id).first<Record<string, unknown>>();
  if (!order) throw notFound('Order not found');

  /**
   * NAMED COLUMNS, NOT `SELECT *` — because this table now carries COST.
   *
   * Migration 0095 added `order_items.cost_iqd` and `cost_basis`, and this was
   * the last serializer in the codebase that returned every column of the
   * table straight to a third party. It happens to be safe today: the order is
   * fenced by `o.merchant_id = ?`, LEVONIS's own checkout never writes
   * `merchant_id`, and worker/routes/storeOrders.ts never writes a cost — so a
   * merchant would see NULL / 'unrecorded' on their own goods.
   *
   * That is a chain of three facts in three other files, and the day the owner
   * asks for gross margin on marketplace sales (0095's own note says they
   * might), writing a cost in storeOrders.ts would publish this shop's cost
   * base to an outside merchant with no code change here and no review. §11 is
   * «لا يراها في API» — the field list is how that stays true by construction
   * rather than by the next author noticing.
   */
  const items = await c.env.DB.prepare(
    `SELECT id, product_id, community_product_id, name_snapshot, image_snapshot, option_snapshot,
            qty, unit_price_iqd, line_total_iqd
       FROM order_items WHERE order_id = ?`
  ).bind(id).all();

  return c.json({
    success: true,
    order: {
      id: order.id,
      status: order.status,
      stage: order.stage,
      origin: order.origin,
      created_at: order.created_at,
      delivered_at: order.delivered_at ?? null,
      receipt_confirmed_at: order.receipt_confirmed_at ?? null,
      // The money's own state, beside the order's: `pending` until the
      // customer confirms or three days pass after delivery, then `available`.
      credit_state: order.credit_state ?? null,
      release_after: releaseAfter(order),
      subtotal_iqd: order.subtotal_iqd,
      shipping_iqd: order.shipping_iqd,
      total_iqd: order.total_iqd,
      platform_fee_iqd: order.platform_fee_iqd,
      merchant_receivable_iqd: order.merchant_receivable_iqd,
      coupon_code: order.coupon_code ?? '',
      coupon_discount_iqd: order.coupon_discount_iqd ?? 0,
      payment_method_id: order.payment_method_id,
      due_on_delivery_iqd: order.due_on_delivery_iqd,
      customer_name: order.customer_name,
      // The number to call for THIS delivery: the one on the address the
      // customer chose at checkout, falling back to their account phone.
      customer_phone:
        (safeParse<Record<string, unknown>>(order.address_snapshot, {}).phone as string | undefined) ||
        order.customer_phone,
      address: safeParse(order.address_snapshot, {}),
    },
    items: items.results,
  });
});

/** The states a merchant may move their own order through. */
const MERCHANT_ORDER_FLOW: Record<string, readonly string[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['processing', 'cancelled'],
  processing: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  // Terminal for the merchant. Delivered is NOT money: the credit waits for the
  // customer's confirmation, or three days (worker/lib/storeOrderOps.ts).
  delivered: [],
  cancelled: [],
};

/**
 * Move an order forward — or cancel it, which REFUNDS the customer.
 *
 * WHAT A MOVE WRITES, ALL IN ONE CONDITIONAL BATCH (B9): the status, the
 * customer-facing `stage` beside it (the tracker used to say «تم استلام
 * الطلب» for ever), an `order_status_history` row, and on delivery
 * `delivered_at` — stamped on EVERY move into delivered, because it starts
 * the customer's three days (review F5). It used to be stamped once
 * (COALESCE): a delivery an admin walked back («I never got it» → shipped)
 * kept its old date, so the merchant's next «تم التسليم» released the money
 * the same minute, with no window after the delivery that really happened.
 *
 * «تم التسليم» NO LONGER RELEASES MONEY (B10, owner decision 2026-09-24). This
 * route used to flip the sale credit to `available` on the merchant's own
 * word; it now stays `pending` until the customer confirms receipt or three
 * days pass with no open complaint.
 *
 * A CANCEL IS THE ONE STORE CANCELLATION (B2, worker/lib/storeOrderOps.ts):
 * the buyer is refunded, stock and `sold_count` and the coupon use come back,
 * and the merchant's credit is reversed — the old cancel reversed the credit
 * and kept the customer's money.
 */
merchantRoutes.post('/orders/:id/status', async (c) => {
  await rateLimit(c, 'merchant-order-status', 120, 3600);
  const ctx = await requireStoreOwner(c);
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const body = await c.req.json().catch(() => ({}));
  const to = str(body.status, 'status', { min: 1, max: 30 });
  const reason = str(body.reason, 'reason', { max: 300, required: false });

  const order = await c.env.DB.prepare(
    'SELECT * FROM orders WHERE id = ? AND merchant_id = ?'
  ).bind(id, ctx.merchant.id).first<Record<string, unknown>>();
  if (!order) throw notFound('Order not found');
  const from = String(order.status);

  const allowed = MERCHANT_ORDER_FLOW[from] ?? [];
  if (!allowed.includes(to)) {
    throw conflict(`An order that is ${from} cannot become ${to}`, 'ORDER_TRANSITION_INVALID');
  }

  const tellCustomer = () => {
    try {
      c.executionCtx.waitUntil(
        notifyOrderStatus(c.env, id, to, { defer: (work) => c.executionCtx.waitUntil(work) })
      );
    } catch {
      // No ExecutionContext on this call path (a test harness): the notice is
      // still queued, just not kept alive past the response.
      void notifyOrderStatus(c.env, id, to);
    }
  };

  if (to === 'cancelled') {
    const res = await cancelStoreOrder(c.env, {
      order,
      actor: 'merchant',
      actorUserId: ctx.store.user_id,
      reason: reason || undefined,
    });
    if (!res.ok) throw conflict('The order changed while you were editing — reload and retry', 'ORDER_CHANGED');
    tellCustomer();
    return c.json({ success: true, status: 'cancelled', refunded_usd_cents: res.refundedUsdCents });
  }

  const ts = nowIso();
  const stage = stageForLegacyStatus(to, 'direct');
  const stmts = [
    c.env.DB.prepare(
      `UPDATE orders SET status = ?1, stage = ?2, stage_changed_at = ?3, stage_source = 'manual',
              next_stage = '', next_stage_at = NULL,
              delivered_at = CASE WHEN ?1 = 'delivered' THEN ?3 ELSE delivered_at END,
              updated_at = ?3
        WHERE id = ?4 AND merchant_id = ?5 AND status = ?6`
    ).bind(to, stage, ts, id, ctx.merchant.id, from),
    // The customer's tracker reads this table. Written only by the batch whose
    // flip landed: the row must be at THIS status with THIS batch's timestamp.
    c.env.DB.prepare(
      `INSERT OR IGNORE INTO order_status_history (id, order_id, stage, status, source, changed_at, changed_by, note)
       SELECT ?1, ?2, ?3, ?4, 'manual', ?5, ?6, 'Moved by the store'
        WHERE EXISTS (SELECT 1 FROM orders WHERE id = ?2 AND status = ?4 AND stage_changed_at = ?5)`
    // The status in the id: two moves of one order inside one millisecond
    // (a fast double step) must not collide into one silently ignored row.
    ).bind(`${newHistoryId(id, ts)}_${to}`, id, stage, to, ts, ctx.store.user_id),
  ];

  if (to === 'delivered') {
    /*
     * THE COMPLETION IS COUNTED ONCE, EVEN WHEN TWO TAPS BOTH READ `shipped`.
     *
     * Both taps pass the flow check above on the same stale read. The flip is
     * conditional on that status, so the second one matches zero rows — but
     * these two statements used to be unconditional, and the loser still
     * inserted a second «order_completed» reputation row and added a second
     * completed order.
     *
     * Both are now fenced on the one fact this batch establishes: the order IS
     * delivered and no completion has been recorded for it yet. The counter
     * runs FIRST because its guard reads the reputation row the next statement
     * writes; in the losing batch both guards see the winner's row and both
     * statements change nothing. One transaction, so there is no window between
     * them.
     */
    const notYetCounted = `EXISTS (SELECT 1 FROM orders WHERE id = ? AND merchant_id = ? AND status = 'delivered')
           AND NOT EXISTS (SELECT 1 FROM merchant_reputation_events
                            WHERE order_id = ? AND merchant_id = ? AND kind = 'order_completed')`;
    stmts.push(
      c.env.DB.prepare(
        `UPDATE community_merchants SET completed_orders = completed_orders + 1
          WHERE id = ? AND ${notYetCounted}`
      ).bind(ctx.merchant.id, id, ctx.merchant.id, id, ctx.merchant.id)
    );
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO merchant_reputation_events (id, merchant_id, kind, points, order_id)
         SELECT ?, ?, 'order_completed', 10, ?
          WHERE ${notYetCounted}`
      ).bind(newId('rep'), ctx.merchant.id, id, id, ctx.merchant.id, id, ctx.merchant.id)
    );
  }

  const results = await c.env.DB.batch(stmts);
  // A double tap is a lost race, and the loser says so rather than reporting a
  // transition it did not make — and, above all, rather than telling the
  // customer twice. Nothing else in its batch changed anything (see above).
  if ((results[0]?.meta?.changes ?? 0) === 0) {
    throw conflict('The order changed while you were editing — reload and retry', 'ORDER_CHANGED');
  }
  await audit(c.env.DB, ctx.store.user_id, 'merchant.order_status', id, { from, to });
  /*
   * THE BUYER IS TOLD, AS THE PLATFORM'S OWN DOORS TELL THEM.
   *
   * This route flipped a store order's status and notified nobody, so a
   * customer who bought from a community store heard nothing between «تم
   * استلام طلبك» and the parcel at the door. `notifyOrderStatus` is the one
   * writer the admin doors use: the same copy, the in-app row, the same event
   * key (so a replay is silent), and nothing for `processing`. After the
   * response, and flushed straight away rather than at the next cron.
   */
  tellCustomer();
  return c.json({ success: true, status: to });
});

// ---------------------------------------------------------------- payouts
//
// `GET /payouts` and the payout requests live in worker/routes/merchantFinance.ts
// (mounted at /api/merchant/payouts and /api/merchant/finance), beside the
// ledger they read.

// ---------------------------------------------------------------- reviews

merchantRoutes.get('/reviews', async (c) => {
  const ctx = await requireStoreOwner(c);
  const { results } = await c.env.DB.prepare(
    `SELECT r.*, u.name AS customer_name
       FROM merchant_reviews r JOIN users u ON u.id = r.customer_id
      WHERE r.merchant_id = ? ORDER BY r.created_at DESC LIMIT 100`
  ).bind(ctx.merchant.id).all<Record<string, unknown>>();
  return c.json({
    success: true,
    reviews: results.map((r) => ({
      id: r.id,
      rating: r.rating,
      body: r.body,
      images: safeParse(r.images, []),
      customer_name: r.customer_name,
      merchant_reply: r.merchant_reply || null,
      merchant_replied_at: r.merchant_replied_at,
      hidden: !!r.hidden,
      order_id: r.order_id,
      community_order_id: r.community_order_id,
      created_at: r.created_at,
    })),
  });
});

/**
 * Reply to a review. Once.
 *
 * A merchant may answer a customer publicly, which is fair. They may not edit
 * that answer repeatedly after the fact, and they cannot touch the review
 * itself — hiding one is an admin moderation decision, never the reviewed
 * party's (§39).
 */
merchantRoutes.post('/reviews/:id/reply', async (c) => {
  await rateLimit(c, 'merchant-review-reply', 30, 3600);
  const ctx = await requireStoreOwner(c);
  const body = await c.req.json().catch(() => ({}));
  const reply = str(body.reply, 'reply', { min: 1, max: 1500 });

  const res = await c.env.DB.prepare(
    `UPDATE merchant_reviews SET merchant_reply = ?, merchant_replied_at = ?, updated_at = ?
      WHERE id = ? AND merchant_id = ? AND merchant_reply = ''`
  ).bind(reply, nowIso(), nowIso(), str(c.req.param('id'), 'id', { min: 1, max: 60 }), ctx.merchant.id).run();
  if (!res.meta.changes) throw conflict('That review is not yours, or you have already replied');

  return c.json({ success: true });
});

// -------------------------------------------------------------- customers
// The store's customers are served by worker/routes/merchantCustomers.ts
// (W3-B: paged, searchable, mounted at /api/merchant/customers). The old
// unpaged handler that lived here is gone (review W2-5 #8).

/**
 * WHICH STORE ORDERS ARE SALES — one predicate for every figure below.
 *
 * A cancelled store order is refunded in full, so its total is not revenue,
 * its fee was never earned and its receivable is never owed. Counting it made
 * «إجمالي المبيعات», «أرباحك», the average order and the customer list all
 * report money that was handed back (audit 04 #12, audit 01 B12, audit 02
 * B19). A store order has no separate "refunded" status: the refund IS the
 * cancellation. Orders still in flight (pending → delivered) are sales and
 * are counted.
 */
const COUNTED_STORE_ORDER = `o.status <> 'cancelled'`;

// -------------------------------------------------------------- analytics

/**
 * Real numbers, from this store's own rows (§50).
 *
 * Computed on read rather than from the pre-aggregated daily table, because
 * a store's lifetime volume is small enough to sum directly and a figure a
 * merchant can reconcile against their own order list is worth more than a
 * faster one they cannot.
 */
merchantRoutes.get('/analytics', async (c) => {
  const ctx = await requireStoreOwner(c);
  const user = c.get('user')!;
  const tier = await getTierStatus(c.env.DB, user.id);
  if (!benefits.merchantAnalytics(tier)) {
    throw forbidden('Analytics are part of LEVO PLUS. Renew to see them again.');
  }

  // Gross, fees, receivable and the average are over SALES only
  // (`COUNTED_STORE_ORDER`); the cancelled count is reported beside them.
  const orders = await c.env.DB.prepare(
    `SELECT SUM(CASE WHEN ${COUNTED_STORE_ORDER} THEN 1 ELSE 0 END) AS orders,
            COALESCE(SUM(CASE WHEN ${COUNTED_STORE_ORDER} THEN o.total_iqd ELSE 0 END), 0) AS gross,
            COALESCE(SUM(CASE WHEN ${COUNTED_STORE_ORDER} THEN o.platform_fee_iqd ELSE 0 END), 0) AS fees,
            COALESCE(SUM(CASE WHEN ${COUNTED_STORE_ORDER} THEN o.merchant_receivable_iqd ELSE 0 END), 0) AS receivable,
            SUM(CASE WHEN o.status = 'delivered' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN o.status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled
       FROM orders o WHERE o.merchant_id = ?`
  ).bind(ctx.merchant.id).first<Record<string, number>>();

  // Units from the order lines of real sales, not `sold_count`: that counter
  // was added at checkout and never taken back when an order was cancelled.
  const products = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN lifecycle = 'active' THEN 1 ELSE 0 END) AS active,
            COALESCE(SUM(view_count), 0) AS views,
            (SELECT COALESCE(SUM(i.qty), 0) FROM order_items i JOIN orders o ON o.id = i.order_id
              WHERE o.merchant_id = ?1 AND ${COUNTED_STORE_ORDER}) AS sold
       FROM community_products WHERE merchant_id = ?1`
  ).bind(ctx.merchant.id).first<Record<string, number>>();

  const top = await c.env.DB.prepare(
    `SELECT p.id, p.name, p.view_count, p.price_iqd,
            SUM(i.qty) AS sold_count, SUM(i.line_total_iqd) AS revenue_iqd
       FROM order_items i
       JOIN orders o ON o.id = i.order_id
       JOIN community_products p ON p.id = i.community_product_id AND p.merchant_id = o.merchant_id
      WHERE o.merchant_id = ? AND ${COUNTED_STORE_ORDER}
      GROUP BY p.id, p.name, p.view_count, p.price_iqd
      ORDER BY sold_count DESC, revenue_iqd DESC LIMIT 5`
  ).bind(ctx.merchant.id).all();

  // Custom (request) orders are a second, separate series: finished work only
  // — a cancelled or fully refunded one earned the merchant nothing to report;
  // one settled by a partial refund counts at the part they kept (review F9).
  const custom = await c.env.DB.prepare(
    `SELECT COUNT(*) AS completed, COALESCE(SUM(${CUSTOM_ORDER_KEPT_RECEIVABLE_SQL}), 0) AS receivable
       FROM community_orders o
       LEFT JOIN community_escrows e ON e.community_order_id = o.id
      WHERE o.merchant_id = ? AND ${CUSTOM_ORDER_EARNED_SQL}`
  ).bind(ctx.merchant.id).first<Record<string, number>>();

  const offers = await c.env.DB.prepare(
    `SELECT COUNT(*) AS sent, SUM(CASE WHEN state = 'accepted' THEN 1 ELSE 0 END) AS accepted
       FROM community_offers WHERE merchant_id = ?`
  ).bind(ctx.merchant.id).first<Record<string, number>>();

  const followers = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM follows WHERE merchant_id = ?'
  ).bind(ctx.merchant.id).first<{ n: number }>();

  const repeat = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM (
       SELECT o.user_id FROM orders o WHERE o.merchant_id = ? AND ${COUNTED_STORE_ORDER}
        GROUP BY o.user_id HAVING COUNT(*) > 1
     )`
  ).bind(ctx.merchant.id).first<{ n: number }>();

  const orderCount = Number(orders?.orders ?? 0);
  const sent = Number(offers?.sent ?? 0);

  return c.json({
    success: true,
    orders: {
      total: orderCount,
      completed: Number(orders?.completed ?? 0),
      cancelled: Number(orders?.cancelled ?? 0),
      gross_iqd: Number(orders?.gross ?? 0),
      platform_fees_iqd: Number(orders?.fees ?? 0),
      receivable_iqd: Number(orders?.receivable ?? 0),
      // Guarded: an average over zero orders is not 0, it is "no data".
      average_order_iqd: orderCount ? Math.round(Number(orders?.gross ?? 0) / orderCount) : null,
    },
    products: {
      total: Number(products?.total ?? 0),
      active: Number(products?.active ?? 0),
      views: Number(products?.views ?? 0),
      sold: Number(products?.sold ?? 0),
    },
    top_products: top.results,
    custom_orders: {
      completed: Number(custom?.completed ?? 0),
      receivable_iqd: Number(custom?.receivable ?? 0),
    },
    offers: {
      sent,
      accepted: Number(offers?.accepted ?? 0),
      win_rate: sent ? Math.round((Number(offers?.accepted ?? 0) / sent) * 100) : null,
    },
    followers: followers?.n ?? 0,
    repeat_customers: repeat?.n ?? 0,
    rating: ctx.merchant.rating_count ? ctx.merchant.rating_avg_x100 / 100 : null,
    rating_count: ctx.merchant.rating_count,
    balance: await merchantBalance(c.env.DB, ctx.merchant.id),
  });
});

// ---------------------------------------------------------------- services
//
// Advertising a service invites new work, so CREATING or re-activating one
// requires selling privileges; editing words or switching one off does not.

function serviceShape(s: Record<string, unknown>) {
  return {
    id: s.id,
    title: s.title,
    description: s.description,
    kind: s.kind,
    price_from_iqd: s.price_from_iqd,
    price_unit: s.price_unit,
    materials: safeParse(s.materials, []),
    imageUrl: s.image_key ? `/files/${s.image_key}` : null,
    active: !!s.active,
    sort_order: s.sort_order,
    created_at: s.created_at,
  };
}

const SERVICE_KINDS = ['print_service', 'design', 'finishing', 'scanning', 'repair', 'other'] as const;

async function readServiceBody(c: Context<AppContext>, userId: string, partial: boolean) {
  const body = await c.req.json().catch(() => ({}));
  const out: Record<string, unknown> = {};
  const has = (k: string) => body[k] !== undefined;
  if (!partial || has('title')) out.title = str(body.title, 'title', { min: 2, max: 90 });
  if (has('description')) out.description = str(body.description, 'description', { min: 0, max: 2000, required: false });
  if (has('kind')) out.kind = oneOf(body.kind, 'kind', SERVICE_KINDS);
  if (has('price_from_iqd'))
    out.price_from_iqd = body.price_from_iqd === null || body.price_from_iqd === ''
      ? null
      : int(body.price_from_iqd, 'price_from_iqd', { min: 0, max: 1_000_000_000 });
  if (has('price_unit')) out.price_unit = str(body.price_unit, 'price_unit', { min: 0, max: 40, required: false });
  if (has('materials')) out.materials = JSON.stringify(sanitizeList(body.materials, 20, 40));
  if (has('sort_order')) out.sort_order = int(body.sort_order, 'sort_order', { min: 0, max: 999 });
  if (has('active')) out.active = body.active ? 1 : 0;
  if (has('image_key')) {
    const raw = str(body.image_key, 'image_key', { min: 0, max: 200, required: false });
    if (!raw) out.image_key = null;
    else {
      const key = ownedMediaKey(raw, userId);
      if (!key) throw badRequest('image_key must be a file you uploaded to this store');
      out.image_key = key;
    }
  }
  return out;
}

merchantRoutes.get('/services', async (c) => {
  const ctx = await requireStoreOwner(c);
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM merchant_services WHERE store_id = ? ORDER BY sort_order, created_at'
  ).bind(ctx.store.id).all<Record<string, unknown>>();
  return c.json({ success: true, services: results.map(serviceShape) });
});

merchantRoutes.post('/services', async (c) => {
  await rateLimit(c, 'merchant-service', 60, 3600);
  const ctx = await requireSellingPrivileges(c);
  const count = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM merchant_services WHERE store_id = ?'
  ).bind(ctx.store.id).first<{ n: number }>();
  if ((count?.n ?? 0) >= 40) throw badRequest('A store can list at most 40 services');

  const f = await readServiceBody(c, ctx.store.user_id, false);
  const id = newId('svc');
  const ts = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO merchant_services
       (id, store_id, merchant_id, title, description, kind, price_from_iqd, price_unit,
        materials, image_key, active, sort_order, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, ctx.store.id, ctx.merchant.id,
    f.title, f.description ?? '', f.kind ?? 'print_service',
    f.price_from_iqd ?? null, f.price_unit ?? '', f.materials ?? '[]',
    f.image_key ?? null, f.active ?? 1, f.sort_order ?? 0, ts, ts
  ).run();
  await audit(c.env.DB, ctx.store.user_id, 'merchant.service_created', id, { store: ctx.store.id });
  const row = await c.env.DB.prepare('SELECT * FROM merchant_services WHERE id = ?').bind(id).first();
  return c.json({ success: true, service: serviceShape(row as Record<string, unknown>) }, 201);
});

merchantRoutes.patch('/services/:id', async (c) => {
  const ctx = await requireStoreOwner(c);
  const f = await readServiceBody(c, ctx.store.user_id, true);
  if (!Object.keys(f).length) throw badRequest('Nothing to update');
  // Switching a service back ON is a new invitation to the public — that one
  // transition needs selling privileges, the rest is bookkeeping.
  if (f.active === 1) await requireSellingPrivileges(c);
  const sets = Object.keys(f).map((k) => `${k} = ?`);
  const vals = Object.values(f);
  sets.push('updated_at = ?');
  vals.push(nowIso(), c.req.param('id'), ctx.store.id);
  const res = await c.env.DB.prepare(
    `UPDATE merchant_services SET ${sets.join(', ')} WHERE id = ? AND store_id = ?`
  ).bind(...vals).run();
  if (!res.meta.changes) throw notFound('Service not found');
  return c.json({ success: true });
});

merchantRoutes.delete('/services/:id', async (c) => {
  const ctx = await requireStoreOwner(c);
  const res = await c.env.DB.prepare(
    'DELETE FROM merchant_services WHERE id = ? AND store_id = ?'
  ).bind(c.req.param('id'), ctx.store.id).run();
  if (!res.meta.changes) throw notFound('Service not found');
  return c.json({ success: true });
});

// ---------------------------------------------------------------- showcase
//
// The workshop wall: printers, materials, finished works. Pure content.

function showcaseShape(s: Record<string, unknown>) {
  return {
    id: s.id,
    kind: s.kind,
    title: s.title,
    details: s.details,
    imageUrl: s.image_key ? `/files/${s.image_key}` : null,
    sort_order: s.sort_order,
    active: !!s.active,
    created_at: s.created_at,
  };
}

merchantRoutes.get('/showcase', async (c) => {
  const ctx = await requireStoreOwner(c);
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM merchant_showcase WHERE store_id = ? ORDER BY kind, sort_order, created_at'
  ).bind(ctx.store.id).all<Record<string, unknown>>();
  return c.json({ success: true, items: results.map(showcaseShape) });
});

merchantRoutes.post('/showcase', async (c) => {
  await rateLimit(c, 'merchant-showcase', 120, 3600);
  const ctx = await requireStoreOwner(c);
  const body = await c.req.json().catch(() => ({}));
  const count = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM merchant_showcase WHERE store_id = ?'
  ).bind(ctx.store.id).first<{ n: number }>();
  if ((count?.n ?? 0) >= 60) throw badRequest('A store can show at most 60 showcase items');

  let imageKey: string | null = null;
  if (body.image_key) {
    imageKey = ownedMediaKey(String(body.image_key), ctx.store.user_id);
    if (!imageKey) throw badRequest('image_key must be a file you uploaded to this store');
  }
  const id = newId('shw');
  await c.env.DB.prepare(
    `INSERT INTO merchant_showcase (id, store_id, kind, title, details, image_key, sort_order, active)
     VALUES (?,?,?,?,?,?,?,1)`
  ).bind(
    id, ctx.store.id,
    oneOf(body.kind, 'kind', ['printer', 'material', 'work'] as const),
    str(body.title, 'title', { min: 1, max: 90 }),
    str(body.details, 'details', { min: 0, max: 1000, required: false }),
    imageKey,
    int(body.sort_order, 'sort_order', { min: 0, max: 999, def: 0 })
  ).run();
  const row = await c.env.DB.prepare('SELECT * FROM merchant_showcase WHERE id = ?').bind(id).first();
  return c.json({ success: true, item: showcaseShape(row as Record<string, unknown>) }, 201);
});

merchantRoutes.patch('/showcase/:id', async (c) => {
  const ctx = await requireStoreOwner(c);
  const body = await c.req.json().catch(() => ({}));
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (body.title !== undefined) { sets.push('title = ?'); vals.push(str(body.title, 'title', { min: 1, max: 90 })); }
  if (body.details !== undefined) { sets.push('details = ?'); vals.push(str(body.details, 'details', { min: 0, max: 1000, required: false })); }
  if (body.kind !== undefined) { sets.push('kind = ?'); vals.push(oneOf(body.kind, 'kind', ['printer', 'material', 'work'] as const)); }
  if (body.sort_order !== undefined) { sets.push('sort_order = ?'); vals.push(int(body.sort_order, 'sort_order', { min: 0, max: 999 })); }
  if (body.active !== undefined) { sets.push('active = ?'); vals.push(body.active ? 1 : 0); }
  if (body.image_key !== undefined) {
    const raw = String(body.image_key ?? '');
    if (!raw) { sets.push('image_key = ?'); vals.push(null); }
    else {
      const key = ownedMediaKey(raw, ctx.store.user_id);
      if (!key) throw badRequest('image_key must be a file you uploaded to this store');
      sets.push('image_key = ?');
      vals.push(key);
    }
  }
  if (!sets.length) throw badRequest('Nothing to update');
  vals.push(c.req.param('id'), ctx.store.id);
  const res = await c.env.DB.prepare(
    `UPDATE merchant_showcase SET ${sets.join(', ')} WHERE id = ? AND store_id = ?`
  ).bind(...vals).run();
  if (!res.meta.changes) throw notFound('Showcase item not found');
  return c.json({ success: true });
});

merchantRoutes.delete('/showcase/:id', async (c) => {
  const ctx = await requireStoreOwner(c);
  const res = await c.env.DB.prepare(
    'DELETE FROM merchant_showcase WHERE id = ? AND store_id = ?'
  ).bind(c.req.param('id'), ctx.store.id).run();
  if (!res.meta.changes) throw notFound('Showcase item not found');
  return c.json({ success: true });
});

// ---------------------------------------------------------------- coupons
//
// The merchant's own discount codes. A coupon changes what customers pay, so
// creating or re-activating one needs selling privileges; pausing one never
// does. The codes are validated ONLY inside the store checkout — nothing here
// touches the platform's membership coupons.

function couponShape(cp: Record<string, unknown>) {
  return {
    id: cp.id,
    code: cp.code,
    kind: cp.kind,
    value: cp.value,
    min_total_iqd: cp.min_total_iqd,
    max_uses: cp.max_uses,
    used_count: cp.used_count,
    active: !!cp.active,
    starts_at: cp.starts_at,
    ends_at: cp.ends_at,
    created_at: cp.created_at,
  };
}

function normalizeCouponCode(v: unknown): string {
  const code = String(v ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{2,29}$/.test(code)) {
    throw badRequest('A code is 3–30 characters: letters, numbers and hyphens', 'BAD_COUPON_CODE');
  }
  return code;
}

function couponDates(body: Record<string, unknown>) {
  const out: { starts_at: string | null; ends_at: string | null } = { starts_at: null, ends_at: null };
  for (const k of ['starts_at', 'ends_at'] as const) {
    const v = body[k];
    if (typeof v === 'string' && v) {
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) throw badRequest(`${k} is not a valid date`);
      out[k] = d.toISOString();
    }
  }
  return out;
}

merchantRoutes.get('/coupons', async (c) => {
  const ctx = await requireStoreOwner(c);
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM merchant_coupons WHERE store_id = ? ORDER BY created_at DESC LIMIT 100'
  ).bind(ctx.store.id).all<Record<string, unknown>>();
  return c.json({ success: true, coupons: results.map(couponShape) });
});

merchantRoutes.post('/coupons', async (c) => {
  await rateLimit(c, 'merchant-coupon', 30, 3600);
  const ctx = await requireSellingPrivileges(c);
  const body = await c.req.json().catch(() => ({}));

  const code = normalizeCouponCode(body.code);
  const kind = oneOf(body.kind, 'kind', ['fixed_iqd', 'percent'] as const);
  const value = int(body.value, 'value', { min: 1, max: kind === 'percent' ? 90 : 100_000_000 });
  const dates = couponDates(body);

  const id = newId('mcp');
  const ts = nowIso();
  try {
    await c.env.DB.prepare(
      `INSERT INTO merchant_coupons
         (id, store_id, merchant_id, code, kind, value, min_total_iqd, max_uses,
          active, starts_at, ends_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?)`
    ).bind(
      id, ctx.store.id, ctx.merchant.id, code, kind, value,
      int(body.min_total_iqd, 'min_total_iqd', { min: 0, max: 1_000_000_000, def: 0 }),
      body.max_uses ? int(body.max_uses, 'max_uses', { min: 1, max: 1_000_000 }) : null,
      dates.starts_at, dates.ends_at, ts, ts
    ).run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw conflict('You already have a coupon with that code', 'COUPON_CODE_TAKEN');
    throw e;
  }
  await audit(c.env.DB, ctx.store.user_id, 'merchant.coupon_created', id, { code, kind, value });
  const row = await c.env.DB.prepare('SELECT * FROM merchant_coupons WHERE id = ?').bind(id).first();
  return c.json({ success: true, coupon: couponShape(row as Record<string, unknown>) }, 201);
});

merchantRoutes.patch('/coupons/:id', async (c) => {
  const ctx = await requireStoreOwner(c);
  const body = await c.req.json().catch(() => ({}));
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (body.active !== undefined) {
    if (body.active) await requireSellingPrivileges(c);
    sets.push('active = ?');
    vals.push(body.active ? 1 : 0);
  }
  if (body.min_total_iqd !== undefined) {
    sets.push('min_total_iqd = ?');
    vals.push(int(body.min_total_iqd, 'min_total_iqd', { min: 0, max: 1_000_000_000 }));
  }
  if (body.max_uses !== undefined) {
    sets.push('max_uses = ?');
    vals.push(body.max_uses ? int(body.max_uses, 'max_uses', { min: 1, max: 1_000_000 }) : null);
  }
  if (body.starts_at !== undefined || body.ends_at !== undefined) {
    const dates = couponDates(body);
    if (body.starts_at !== undefined) { sets.push('starts_at = ?'); vals.push(dates.starts_at); }
    if (body.ends_at !== undefined) { sets.push('ends_at = ?'); vals.push(dates.ends_at); }
  }
  // Code, kind and value are immutable: a coupon someone saved to use later
  // must still mean what it said. Wrong terms → deactivate, make a new one.
  if (!sets.length) throw badRequest('Nothing to update');
  sets.push('updated_at = ?');
  vals.push(nowIso(), c.req.param('id'), ctx.store.id);
  const res = await c.env.DB.prepare(
    `UPDATE merchant_coupons SET ${sets.join(', ')} WHERE id = ? AND store_id = ?`
  ).bind(...vals).run();
  if (!res.meta.changes) throw notFound('Coupon not found');
  return c.json({ success: true });
});

merchantRoutes.delete('/coupons/:id', async (c) => {
  const ctx = await requireStoreOwner(c);
  // A used coupon is deactivated, not erased: orders reference its code.
  const used = await c.env.DB.prepare(
    'SELECT used_count FROM merchant_coupons WHERE id = ? AND store_id = ?'
  ).bind(c.req.param('id'), ctx.store.id).first<{ used_count: number }>();
  if (!used) throw notFound('Coupon not found');
  if (used.used_count > 0) {
    await c.env.DB.prepare(
      'UPDATE merchant_coupons SET active = 0, updated_at = ? WHERE id = ? AND store_id = ?'
    ).bind(nowIso(), c.req.param('id'), ctx.store.id).run();
    return c.json({ success: true, deactivated: true });
  }
  await c.env.DB.prepare(
    'DELETE FROM merchant_coupons WHERE id = ? AND store_id = ?'
  ).bind(c.req.param('id'), ctx.store.id).run();
  return c.json({ success: true, deactivated: false });
});

// ------------------------------------------------------------ custom orders
//
// The community-order side of the dashboard reads /api/marketplace/orders
// directly — the lifecycle lives there. What the dashboard needs from HERE is
// only the count of actionable ones, for the overview badge.
merchantRoutes.get('/custom-orders/summary', async (c) => {
  const ctx = await requireStoreOwner(c);
  const row = await c.env.DB.prepare(
    `SELECT
       SUM(CASE WHEN state = 'funded' THEN 1 ELSE 0 END) AS to_start,
       SUM(CASE WHEN state = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
       SUM(CASE WHEN state = 'merchant_marked_delivered' THEN 1 ELSE 0 END) AS awaiting_customer
       FROM community_orders WHERE merchant_id = ?`
  ).bind(ctx.merchant.id).first<Record<string, number>>();
  return c.json({
    success: true,
    to_start: Number(row?.to_start ?? 0),
    in_progress: Number(row?.in_progress ?? 0),
    awaiting_customer: Number(row?.awaiting_customer ?? 0),
  });
});
