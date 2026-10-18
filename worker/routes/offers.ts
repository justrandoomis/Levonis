/**
 * SPECIAL OFFERS — the admin panel for the ONE promotion model.
 * docs/BUNDLES_MYSTERY.md §9 (eligibility), §10 (API), §11 (admin), §12.
 *
 * THE POINT OF THIS FILE IS THAT IT ADDS NOTHING.
 *
 * A scheduled, tier-gated, limited, DISCOUNTED special offer on an ORDINARY
 * product is `offer_windows` + `offer_limits` — the same pair of rows a bundle
 * and a mystery offer already use, keyed on the same subject
 * `('product', productId)`. No new table, no second discount code path, no
 * second eligibility rule and no second price resolver: `resolveOfferPrice` is
 * the one that answers for all three. That is the strongest dividend of having
 * put bundles in `products`, and this router is where an owner collects it.
 *
 * TWO THINGS IT REFUSES RATHER THAN REPAIRS (§4.7, §11.3):
 *
 *  - a typed dinar `fixed` offer price or PLUS price, on an ordinary product
 *    and — since DECISIONS row 251, a composition being priced like one — on a
 *    bundle or a mystery box too (`PRICING_V2_MANAGED`);
 *  - a schedule whose end precedes its start (`SCHEDULE_INVERTED`).
 *
 * AND IT WRITES ITS AUDIT ROW INSIDE THE BATCH. A tier gate and an offer price
 * are disclosure- and money-changing writes; auditing them AFTER their batch
 * means a crash between the two leaves an unaudited change to who may buy a
 * thing and for how much (§10, §15.1 rule 10).
 *
 * THE PRODUCT FORM'S «تخفيض السعر» CARD WRITES THROUGH THIS SAME DOOR
 * (docs/ux/PRODUCT-DISCOUNT.md §5): a dollar sale price (`fixed_usd`, migration
 * 0197) is a mode of the same row, its prices a child set of the same subject,
 * checked here and previewed here (`POST /:productId/preview`, which writes
 * nothing) with the one resolver. A save may carry `expected_updated_at`: the
 * tab and the card edit one row, and a lost update is refused
 * (`SPECIAL_OFFER_CHANGED`). Every write purges the catalogue it reprices.
 *
 * `requireAdmin` IS ATTACHED HERE. `requireMainHost` on `/api/admin/*` is a
 * HOST check and never a role check, so a router mounted without its own guard
 * is an open admin API guarded only by hostname.
 */

import { likePattern, sqlLikeClause } from '../lib/sqlLike';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { HttpError, int, notFound, requireAdmin, str } from '../lib/http';
import { auditStatements } from '../lib/audit';
import { v2Managed } from '../lib/engineInstalled';
import { COST_REFUSALS, serverMessage } from '@levonis/contracts/costRefusals';
import { purgeCatalogueAfterWrite } from '../lib/edgePolicy';
import { fence, isFenceMiss } from '../lib/operations';
import {
  cleanStartAt,
  INHERITS,
  isOfferPriceMode,
  normalizeUtc,
  offerWindowStatements,
  parseRequiredTiers,
  scheduleState,
  subjectOf,
  suspendedByCleanStart,
  type OfferWindow,
} from '../lib/offers';
import type { Tier } from '../lib/pricing';
import {
  centsOfUsdText,
  loadOfferUsdPrices,
  offerUsdInstalled,
  offerUsdStatements,
  usdTextOfCents,
  type OfferUsdPrice,
} from '../lib/offerUsd';
import {
  discountPublished,
  discountRead,
  loadDiscountContext,
  previewRows,
  usdSetRefusal,
  type DiscountContext,
  type PreviewRow,
} from '../lib/offerDiscount';
import { offerBelowCostBell, productNameOf } from '../lib/pricingEngine/v2/bell';
import { v2ViewerOf } from '../lib/pricingEngine/v2/api';
import { OFFER_DISCOUNT_REFUSALS, OFFER_DISCOUNT_WARNINGS } from '@levonis/contracts/offerRefusals';

export const adminOffersRoutes = new Hono<AppContext>();
adminOffersRoutes.use('*', requireAdmin);
// F3 (docs/ux/PRODUCT-DISCOUNT.md §5.5): an offer reprices the catalogue a guest reads from the edge
// cache, so every successful write purges it — the listing, the home and the product page (the
// handlers record the slug). The preview writes nothing and is skipped by the middleware.
adminOffersRoutes.use('*', purgeCatalogueAfterWrite);

const PRICE_MODES = ['', 'fixed', 'discount_percent', 'discount_iqd', 'fixed_usd'];

interface OfferInput {
  starts_at: string | null;
  ends_at: string | null;
  required_tiers: string[];
  offer_price_mode: string;
  offer_price_iqd: number | null;
  discount_percent: number | null;
  discount_iqd: number | null;
  plus_price_iqd: number | null;
  locked_preview: boolean;
  active: boolean;
  max_per_user: number | null;
  max_global: number | null;
  /** `fixed_usd` (0197): absent = keep the stored set (the mode stays `fixed_usd`); present = replace it. */
  offer_usd_prices: unknown;
  /** D12: absent = no check; null = "I saw no row"; a string = "I saw this stamp". */
  expected_updated_at: string | null | undefined;
}

const money = (v: unknown): number | null =>
  v === null || v === undefined || v === '' ? null : Math.max(0, Math.trunc(Number(v) || 0));

const truthy = (v: unknown) => v === true || v === 1 || v === '1';

function readOffer(b: Record<string, unknown>): OfferInput {
  const mode = String(b.offer_price_mode ?? '');
  return {
    starts_at: normalizeUtc(typeof b.starts_at === 'string' ? b.starts_at : null),
    ends_at: normalizeUtc(typeof b.ends_at === 'string' ? b.ends_at : null),
    required_tiers: parseRequiredTiers(b.required_tiers),
    offer_price_mode: PRICE_MODES.includes(mode) ? mode : '',
    offer_price_iqd: money(b.offer_price_iqd),
    discount_percent: b.discount_percent === null || b.discount_percent === undefined || b.discount_percent === ''
      ? null
      : int(b.discount_percent, 'discount_percent', { min: 1, max: 90 }),
    discount_iqd: money(b.discount_iqd),
    plus_price_iqd: money(b.plus_price_iqd),
    locked_preview: b.locked_preview === undefined ? true : truthy(b.locked_preview),
    active: b.active === undefined ? true : truthy(b.active),
    max_per_user: money(b.max_per_user),
    max_global: money(b.max_global),
    offer_usd_prices: 'offer_usd_prices' in b ? b.offer_usd_prices : undefined,
    expected_updated_at:
      !('expected_updated_at' in b) ? undefined : typeof b.expected_updated_at === 'string' ? b.expected_updated_at : null,
  };
}

/**
 * Every refusal this panel can produce, said verbatim and never repaired. The
 * shape is the `{ code, message, ar, en, ckb }` both existing admin decoders
 * already understand (§11.3) — `message` is not decoration: `refusalIssues`
 * renders it, and an entry without one prints the literal string "undefined".
 */
const ISSUES = {
  OFFER_PRICE_CONFLICT: {
    ar: 'لا يمكن ضبط سعر للعرض مع وضع تسعير محسوب على نفس المنتج — اختر واحدًا',
    en: 'an offer price cannot sit beside a derived bundle price mode on the same subject — choose one',
    ckb: 'نرخی ئۆفەر ناتوانێت لەگەڵ دۆخی نرخی دەرهێنراودا بێت لەسەر هەمان بەرهەم — یەکێکیان هەڵبژێرە',
  },
  SCHEDULE_INVERTED: {
    ar: 'تاريخ انتهاء العرض قبل تاريخ بدايته',
    en: 'the offer ends before it starts',
    ckb: 'ئۆفەرەکە پێش دەستپێکردنی کۆتایی دێت',
  },
  OFFER_SUBJECT_NOT_FOUND: {
    ar: 'المنتج المطلوب غير موجود',
    en: 'the subject product does not exist',
    ckb: 'بەرهەمی داواکراو بوونی نییە',
  },
  OFFER_PRICE_INCOMPLETE: {
    ar: 'وضع سعر العرض يحتاج قيمة',
    en: 'this offer price mode needs a value',
    ckb: 'ئەم دۆخەی نرخی ئۆفەر پێویستی بە بەهایەکە',
  },
  OFFER_PRICE_BELOW_FLOOR: {
    ar: 'سعر العرض الثابت يجب أن يكون ١ دينار على الأقل — لا يُنشر عرض مجاني',
    en: 'a fixed offer price must be at least 1 IQD — a free offer is never published',
    ckb: 'نرخی جێگیری ئۆفەر دەبێت لانیکەم ١ دینار بێت — ئۆفەری بێبەرامبەر بڵاو ناکرێتەوە',
  },
  BUNDLE_DISCOUNT_EXCEEDS_TOTAL: {
    ar: 'الخصم يساوي سعر المنتج أو يتجاوزه — صفر واحد زائد لا يجوز أن ينشر عرضًا مجانيًا',
    en: 'the discount is at or above the subject price — one typed zero too many must not publish a free offer',
    ckb: 'داشکاندنەکە یەکسانە بە نرخی بەرهەمەکە یان زیاترە — یەک سفری زیادە نابێت ئۆفەری خۆڕایی بڵاو بکاتەوە',
  },
  // ---- the dollar sale price and the lost update (docs/ux/PRODUCT-DISCOUNT.md §5.8) ----
  ...OFFER_DISCOUNT_REFUSALS,
} as const;

type IssueCode = keyof typeof ISSUES;

/** The status of a refusal that is not a plain 400 (a missing table, an unpriced product, a lost update). */
const STATUS: Partial<Record<IssueCode, number>> = {
  OFFER_USD_NOT_INSTALLED: 409,
  OFFER_USD_NOT_PRICED: 409,
  SPECIAL_OFFER_CHANGED: 409,
};

const issue = (code: IssueCode) => ({ code, message: ISSUES[code].en, ...ISSUES[code] });

const refuse = (code: IssueCode): never => {
  throw new HttpError(STATUS[code] ?? 400, ISSUES[code].en, code, { errors: [issue(code)] });
};

/**
 * A PRICING-PROGRAMME REFUSAL SAID THE WAY THIS DOOR SAYS ITS OWN (review): `{ code, message, ar, en,
 * ckb }` in `details.errors`, which both clients render — the card and the «العروض الخاصة» tab read
 * `details.errors` and otherwise fall back to `message`, the Arabic/English pair alone, which left a
 * Sorani editor without their sentence (DECISIONS row 183). The extra details (`section`, `v2`) stay.
 */
function costRefusal(status: number, code: 'PRICING_V2_OWNER_ONLY' | 'PRICING_V2_MANAGED', details: Record<string, unknown>): HttpError {
  const entry = COST_REFUSALS[code];
  return new HttpError(status, serverMessage(code), code, {
    ...details,
    errors: [{ code, message: entry.en, ar: entry.ar, en: entry.en, ckb: entry.ckb }],
  });
}

/** The two warnings of a sale the preview found (§5.8), said and never repaired. */
const WARNINGS = OFFER_DISCOUNT_WARNINGS;

const warning = (code: keyof typeof WARNINGS) => ({ code, message: WARNINGS[code].en, ...WARNINGS[code] });

/** The ISSUES and WARNINGS this door can answer, for the client sentence tables and their test. */
export const OFFER_DOOR_SENTENCES = { ...ISSUES, ...WARNINGS } as const;

// --------------------------------------------------------------- the list

/**
 * Every subject that has a window, with the product it belongs to and its live
 * schedule state — the one screen an owner uses to see what is running now,
 * what starts later and what has ended.
 */
adminOffersRoutes.get('/', async (c) => {
  const search = str(c.req.query('search'), 'search', { max: 100, required: false });
  const kind = str(c.req.query('kind'), 'kind', { max: 20, required: false });
  const params: unknown[] = [];
  let where = "w.subject_type = 'product'";
  if (search) {
    where += ` AND (${sqlLikeClause(['p.name', 'p.name_ar', 'p.slug'])})`;
    const like = likePattern(search);
    params.push(like, like, like);
  }
  if (kind === 'product') where += " AND COALESCE(p.composition, '') = ''";
  else if (kind === 'bundle' || kind === 'mystery') {
    where += ' AND p.composition = ?';
    params.push(kind);
  }
  // The dollar set of each row, in the same statement (0197) — the second variant without it.
  const usdSet = (await offerUsdInstalled(c.env.DB))
    ? `(SELECT json_group_array(json_object('model_id', u.model_id, 'cents', u.price_usd_cents)) FROM offer_usd_prices u
          WHERE u.subject_type = w.subject_type AND u.subject_id = w.subject_id) AS usd_set,`
    : '';
  const { results } = await c.env.DB
    .prepare(
      `SELECT w.*, ${usdSet} l.max_per_user AS max_per_user, l.max_global AS max_global,
              p.name AS product_name, p.slug AS product_slug, COALESCE(p.composition,'') AS composition,
              p.status AS product_status,
              -- ACTIVE only, because that is what the limit counts since 0065.
              -- Summing released rows too made an offer read as sold out while
              -- the trigger was still selling it.
              (SELECT COALESCE(SUM(r.qty), 0) FROM offer_redemptions r
                WHERE r.subject_type = w.subject_type AND r.subject_id = w.subject_id
                  AND r.state = 'active') AS redeemed,
              -- Kept beside it rather than hidden: a released slot is real
              -- history, and an owner comparing sales with redemptions needs it.
              (SELECT COALESCE(SUM(r.qty), 0) FROM offer_redemptions r
                WHERE r.subject_type = w.subject_type AND r.subject_id = w.subject_id
                  AND r.state = 'released') AS released
         FROM offer_windows w
         LEFT JOIN offer_limits l ON l.subject_type = w.subject_type AND l.subject_id = w.subject_id
         LEFT JOIN products p ON p.id = w.subject_id
        WHERE ${where}
        ORDER BY w.updated_at DESC
        LIMIT 200`
    )
    .bind(...params)
    .all<Record<string, unknown>>();
  const now = Date.now();
  const cleanStart = await cleanStartAt(c.env.DB);
  const sets = (results ?? []).map((r) => usdSetOf(r.usd_set));
  const names = await modelNamesOf(c.env.DB, sets.flat().map((p) => p.model_id));
  // D7: on a cost-first product a dollar sale price is the owner's — the tab does not offer it to an editor.
  const ownerOnly = v2ViewerOf(c.env, c.get('user')) === 'editor' ? await costFirstIds(c.env.DB, (results ?? []).map((r) => String(r.subject_id))) : new Set<string>();
  return c.json({
    success: true,
    offers: (results ?? []).map((r, i) => ({
      ...windowView(r, cleanStart, named(sets[i]!, names)),
      usd_allowed: !ownerOnly.has(String(r.subject_id)),
      product: {
        id: String(r.subject_id),
        name: r.product_name ?? '',
        slug: r.product_slug ?? '',
        composition: String(r.composition ?? ''),
        status: r.product_status ?? '',
      },
      redeemed: Number(r.redeemed ?? 0),
      released: Number(r.released ?? 0),
      schedule_state: scheduleState(
        (r.starts_at as string | null) ?? null,
        (r.ends_at as string | null) ?? null,
        now
      ),
    })),
  });
});

/** `cleanStart` = the clean start's instant (`cleanStartAt`): a window last saved before it is
 *  suspended (addendum A.5) — «موقوف: أُنشئ قبل التسعير الجديد» until it is saved again. */
function windowView(r: Record<string, unknown>, cleanStart: string | null = null, usd: readonly UsdEntry[] = []) {
  return {
    subject_type: String(r.subject_type ?? 'product'),
    subject_id: String(r.subject_id ?? ''),
    offer_id: String(r.id ?? ''),
    starts_at: (r.starts_at as string | null) ?? null,
    ends_at: (r.ends_at as string | null) ?? null,
    required_tiers: parseRequiredTiers(r.required_tiers),
    offer_price_mode: String(r.offer_price_mode ?? ''),
    offer_price_iqd: (r.offer_price_iqd as number | null) ?? null,
    discount_percent: (r.discount_percent as number | null) ?? null,
    discount_iqd: (r.discount_iqd as number | null) ?? null,
    plus_price_iqd: (r.plus_price_iqd as number | null) ?? null,
    locked_preview: Number(r.locked_preview ?? 1) === 1,
    active: Number(r.active ?? 1) === 1,
    max_per_user: (r.max_per_user as number | null) ?? null,
    max_global: (r.max_global as number | null) ?? null,
    updated_at: (r.updated_at as string | null) ?? null,
    suspended: suspendedByCleanStart(r.updated_at, cleanStart),
    // The dollar sale prices (0197) as typed text, "500.00"; [] for every other mode. Typed prices,
    // not cost: whoever may open this tab may read them (§5.6). A model row carries its model's names
    // (§7: «P1S $500.00 · P1S Combo $640.00»), in the product's model order.
    offer_usd_prices: usd.map((p) => ({ model_id: p.model_id, usd: usdTextOfCents(p.cents), ...(p.names ? { names: p.names } : {}) })),
  };
}

/** One stored dollar row, with its model's names when it names a model. */
type UsdEntry = OfferUsdPrice & { names?: { ar: string; en: string; ckb: string } };

/**
 * The names and the order of the models a dollar set names, in one read (`product_option_values`). The
 * same fallbacks the product form's read model uses: Arabic ← English, Sorani ← Arabic ← English.
 */
async function modelNamesOf(db: D1Database, modelIds: readonly string[]): Promise<Map<string, { names: { ar: string; en: string; ckb: string }; sort: number }>> {
  const ids = [...new Set(modelIds.filter((id) => id !== ''))];
  const out = new Map<string, { names: { ar: string; en: string; ckb: string }; sort: number }>();
  if (!ids.length) return out;
  const { results } = await db
    .prepare('SELECT id, name_ar, name_en, name_ckb, sort FROM product_option_values WHERE id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(ids))
    .all<{ id: string; name_ar: string | null; name_en: string | null; name_ckb: string | null; sort: number | null }>();
  for (const v of results ?? []) {
    const ar = v.name_ar || v.name_en || '';
    const en = v.name_en || v.name_ar || '';
    const ckb = v.name_ckb || v.name_ar || v.name_en || '';
    out.set(String(v.id), { names: { ar, en, ckb }, sort: Number(v.sort ?? 0) });
  }
  return out;
}

/** The set in the product's model order (the whole-product row first), each model row with its names. */
function named(set: readonly OfferUsdPrice[], names: Map<string, { names: { ar: string; en: string; ckb: string }; sort: number }>): UsdEntry[] {
  const rank = (p: OfferUsdPrice) => (p.model_id === '' ? -1 : (names.get(p.model_id)?.sort ?? Number.MAX_SAFE_INTEGER));
  return [...set]
    .sort((a, b) => rank(a) - rank(b) || (a.model_id < b.model_id ? -1 : a.model_id > b.model_id ? 1 : 0))
    .map((p) => {
      const n = p.model_id ? names.get(p.model_id) : undefined;
      return n ? { ...p, names: n.names } : { ...p };
    });
}

/** The cost-first products among these (an editor may not type their dollar sale price, D7). Without 0189: none. */
async function costFirstIds(db: D1Database, productIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(productIds)];
  if (!ids.length) return new Set();
  try {
    const { results } = await db
      .prepare(
        "SELECT product_id FROM product_pricing_state WHERE mode = 'engine' AND pricing_method = 'cost' AND product_id IN (SELECT value FROM json_each(?))"
      )
      .bind(JSON.stringify(ids))
      .all<{ product_id: string }>();
    return new Set((results ?? []).map((r) => String(r.product_id)));
  } catch (e) {
    if (/no such (table|column)/i.test(String((e as Error)?.message ?? e))) return new Set();
    throw e;
  }
}

/** One subject's stored dollar set, named and ordered for the tab ([] without 0197). */
async function namedUsdSet(db: D1Database, productId: string): Promise<UsdEntry[]> {
  const set = await storedUsdSet(db, productId);
  return named(set, await modelNamesOf(db, set.map((p) => p.model_id)));
}

/** The list's `usd_set` column (a JSON array of {model_id, cents}), or []. */
function usdSetOf(raw: unknown): OfferUsdPrice[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const list = JSON.parse(raw) as Array<{ model_id?: unknown; cents?: unknown }>;
    return (Array.isArray(list) ? list : [])
      .map((x) => ({ model_id: String(x?.model_id ?? ''), cents: Number(x?.cents) }))
      .filter((x) => Number.isSafeInteger(x.cents) && x.cents > 0);
  } catch {
    return [];
  }
}

/** One subject's stored dollar set ([] without 0197). */
async function storedUsdSet(db: D1Database, productId: string): Promise<OfferUsdPrice[]> {
  return (await loadOfferUsdPrices(db, [productId])).get(productId) ?? [];
}

/** The tier vocabulary the panel offers, from the ONE membership map — never a
 *  second list a screen can let drift. */
adminOffersRoutes.get('/tiers', (c) => c.json({ success: true, tiers: Object.keys(INHERITS), inherits: INHERITS }));

adminOffersRoutes.get('/:productId', async (c) => {
  const productId = c.req.param('productId');
  const product = await c.env.DB
    .prepare("SELECT id, name, name_ar, slug, status, COALESCE(composition,'') AS composition, price_iqd FROM products WHERE id = ?")
    .bind(productId)
    .first<Record<string, unknown>>();
  if (!product) throw notFound('product');
  const [w, l, redeemed] = await Promise.all([
    c.env.DB
      .prepare("SELECT * FROM offer_windows WHERE subject_type = 'product' AND subject_id = ?")
      .bind(productId)
      .first<Record<string, unknown>>(),
    c.env.DB
      .prepare("SELECT * FROM offer_limits WHERE subject_type = 'product' AND subject_id = ?")
      .bind(productId)
      .first<Record<string, unknown>>(),
    c.env.DB
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN state = 'active' THEN qty ELSE 0 END), 0) AS n,
                COALESCE(SUM(CASE WHEN state = 'released' THEN qty ELSE 0 END), 0) AS released
           FROM offer_redemptions WHERE subject_type = 'product' AND subject_id = ?`
      )
      .bind(productId)
      .first<{ n: number; released: number }>(),
  ]);
  const usd = w ? await namedUsdSet(c.env.DB, productId) : [];
  const discount = discountRead(await loadDiscountContext(c.env, productId, c.get('user')));
  return c.json({
    success: true,
    product,
    offer: w ? { ...windowView({ ...w, ...(l ?? {}) }, await cleanStartAt(c.env.DB), usd) } : null,
    // THE PRODUCT FORM CARD'S READ MODEL (docs/ux/PRODUCT-DISCOUNT.md §5.1): IQD for everyone, dollars
    // by role, never the rate, an exact IQD, R, T or a `v2_*` key.
    discount,
    redeemed: Number(redeemed?.n ?? 0),
    released: Number(redeemed?.released ?? 0),
    schedule_state: w
      ? scheduleState((w.starts_at as string | null) ?? null, (w.ends_at as string | null) ?? null, Date.now())
      : null,
  });
});

// --------------------------------------------------------------- the write

interface OfferPlan {
  input: OfferInput;
  product: { id: string; composition: string; slug: string | null; name: string | null };
  /** The effective dollar set (`fixed_usd`), else []. */
  usd: OfferUsdPrice[];
  /** Every published SKU × channel priced with this draft (with the owner's flags, stripped by role). */
  rows: PreviewRow[];
  /** Step 7's refusals, collected instead of thrown (the preview). */
  issues: Array<Record<string, unknown>>;
  warnings: Array<Record<string, unknown>>;
}

/** The answer's rows for this viewer: the owner's flags reach the owner only (D6). */
const rowsFor = (d: DiscountContext, rows: readonly PreviewRow[]): PreviewRow[] =>
  d.viewer === 'owner' ? [...rows] : rows.map(({ owner: _owner, ...rest }) => rest);

/** The draft as a window the one resolver reads. */
function draftWindow(input: OfferInput, usd: readonly OfferUsdPrice[]): OfferWindow {
  const mode = isOfferPriceMode(input.offer_price_mode) ? input.offer_price_mode : '';
  return {
    id: 'draft',
    starts_at: input.starts_at,
    ends_at: input.ends_at,
    required_tiers: input.required_tiers as Tier[],
    offer_price_mode: mode,
    offer_price_iqd: mode === 'fixed' ? input.offer_price_iqd : null,
    discount_percent: mode === 'discount_percent' ? input.discount_percent : null,
    discount_iqd: mode === 'discount_iqd' ? input.discount_iqd : null,
    plus_price_iqd: input.plus_price_iqd,
    locked_preview: input.locked_preview,
    active: input.active,
    usd_prices: mode === 'fixed_usd' ? [...usd] : [],
  };
}

/** The typed dollar set → whole cents, by the V2 grammar; a JSON number (a float) is refused too. */
function parseUsdSet(raw: unknown): OfferUsdPrice[] {
  if (!Array.isArray(raw) || raw.length > 200) return refuse('OFFER_USD_PRICE_SHAPE');
  return raw.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return refuse('OFFER_USD_PRICE_SHAPE');
    const x = item as Record<string, unknown>;
    const modelId = x.model_id === undefined || x.model_id === null ? '' : x.model_id;
    if (typeof modelId !== 'string' || modelId.length > 120) return refuse('OFFER_USD_MODEL_UNKNOWN');
    let cents: number | null = null;
    try {
      cents = centsOfUsdText(x.usd);
    } catch {
      cents = null; // a fractional JSON number: already a binary float
    }
    if (cents === null) return refuse('OFFER_USD_PRICE_SHAPE');
    return { model_id: modelId, cents };
  });
}

/**
 * CHECKS 1–7 OF §5.3, IN ORDER — the PUT and the preview run the same ones. A refusal throws; the
 * preview's step 7 collects its two refusals as `issues` so the owner still sees every row.
 */
async function planOffer(
  c: Context<AppContext>,
  productId: string,
  body: Record<string, unknown>,
  d: DiscountContext,
  mode: 'save' | 'preview'
): Promise<OfferPlan> {
  const input = readOffer(body);

  // 1. The subject.
  const product = await c.env.DB
    .prepare("SELECT id, COALESCE(composition,'') AS composition, slug, name, name_ar FROM products WHERE id = ?")
    .bind(productId)
    .first<{ id: string; composition: string; slug: string | null; name: string | null; name_ar: string | null }>();
  if (!product) refuse('OFFER_SUBJECT_NOT_FOUND');
  const p = product!;

  // 2. The schedule.
  if (input.starts_at && input.ends_at && Date.parse(input.ends_at) < Date.parse(input.starts_at)) {
    refuse('SCHEDULE_INVERTED');
  }
  // 3. The clean start (addendum A.6, DECISIONS row 222): an ordinary product's price is its V2 write's.
  // A typed DINAR offer price (or PLUS price) on one is refused; its dollar sale price is `fixed_usd`
  // (below); percent and amount discounts stay. A composition too (DECISIONS row 251: priced like an ordinary product).
  if (input.offer_price_mode === 'fixed' || (input.plus_price_iqd ?? null) !== null) {
    const managed = v2Managed(3);
    throw costRefusal(managed.status, 'PRICING_V2_MANAGED', { ...(managed.details ?? {}) });
  }

  // 4. The dollar sale price (§5.3 step 4).
  let usd: OfferUsdPrice[] = [];
  if (input.offer_price_mode === 'fixed_usd') {
    if (!d.usdSupported) refuse('OFFER_USD_NOT_INSTALLED');
    if (p.composition !== '') refuse('OFFER_USD_ORDINARY_ONLY');
    if (!discountPublished(d)) refuse('OFFER_USD_NOT_PRICED');
    // D7: on a cost-first product every V2 price write is the owner's — the editor never sees dollars there.
    if (d.method === 'cost' && d.viewer === 'editor') throw costRefusal(403, 'PRICING_V2_OWNER_ONLY', { section: 3 });
    usd = input.offer_usd_prices === undefined ? await storedUsdSet(c.env.DB, productId) : parseUsdSet(input.offer_usd_prices);
    if (!usd.length) refuse('OFFER_PRICE_INCOMPLETE');
    const setRefusal = usdSetRefusal(d, usd);
    if (setRefusal) refuse(setRefusal);
  }

  // 5. Percent and amount off: a value, and the floors (§4.3).
  if (input.offer_price_mode === 'fixed' && input.offer_price_iqd === null) refuse('OFFER_PRICE_INCOMPLETE');
  if (input.offer_price_mode === 'discount_percent' && input.discount_percent === null) refuse('OFFER_PRICE_INCOMPLETE');
  if (input.offer_price_mode === 'discount_iqd' && !input.discount_iqd) refuse('OFFER_PRICE_INCOMPLETE');

  /**
   * THE OFFER PRICE HAS THE SAME TWO FLOORS THE DERIVED BUNDLE PRICE HAS (§4.3).
   *
   * §4.3 commits to a hard admin refusal AND a read-time rule that a price
   * below the floor "does not clamp and does not sell", and states the intent in
   * as many words: one typed zero too many must not publish a free offer. Both
   * floors lived only on the `bundle_config.price_mode` branch, while §4.6 made
   * a live window the SOLE price source — so `offer_price_iqd = 0`, and a
   * `discount_iqd` far larger than the price, both published a 0 IQD sale on an
   * ordinary product as well as on a bundle. This is the first floor; the
   * second is in `resolveOfferPrice` and in the bundle mirror of it.
   *
   * The anchor is `products.price_iqd`, which is the subject's regular ladder
   * price — and for a composition subject it is also the only anchor that can
   * reach here, since a derived `bundle_config.price_mode` prices nothing
   * (DECISIONS row 251) and a typed dinar `fixed` price is refused above.
   */
  if (input.offer_price_mode === 'fixed' && (input.offer_price_iqd ?? 0) < 1) {
    refuse('OFFER_PRICE_BELOW_FLOOR');
  }
  if (input.offer_price_mode === 'discount_iqd') {
    const anchor = await c.env.DB
      .prepare('SELECT price_iqd FROM products WHERE id = ?')
      .bind(productId)
      .first<{ price_iqd: number }>();
    const regular = Math.max(0, Number(anchor?.price_iqd ?? 0));
    if ((input.discount_iqd ?? 0) >= regular) refuse('BUNDLE_DISCOUNT_EXCEEDS_TOTAL');
  }

  // 6. (Retired by DECISIONS row 251.) A composition is priced like an ordinary product: a derived
  // `bundle_config.price_mode` prices nothing any more, so a window beside one is no longer two price
  // sources — the window is the only one, exactly as on an ordinary product.

  // 7. THE PREVIEW ON THE STORED PUBLISHED ROWS (§5.2) — a dollar price and a percent alike. A sale
  // that lowers nothing is refused, a route at 0 or below is refused; a model it does not lower and a
  // sale below cost are said (the latter to the owner alone, D6), never refused.
  const rows = p.composition === '' && discountPublished(d) ? previewRows(d, draftWindow(input, usd)) : [];
  const issues: Array<Record<string, unknown>> = [];
  const warnings = warningsFor(input, p.composition);
  if (rows.length && input.offer_price_mode !== '') {
    const stepRefusal: IssueCode | null = !rows.some((r) => r.state === 'lowered')
      ? 'OFFER_NOT_LOWER'
      : rows.some((r) => r.state === 'below_floor')
        ? 'OFFER_ROUTE_BELOW_FLOOR'
        : null;
    if (stepRefusal) {
      if (mode === 'save') refuse(stepRefusal);
      issues.push(issue(stepRefusal));
    }
    if (rows.some((r) => r.state === 'not_lower')) warnings.push(warning('OFFER_PARTLY_NOT_LOWER'));
    if (d.viewer === 'owner' && rows.some((r) => r.owner?.below_cost || r.owner?.below_min_profit)) warnings.push(warning('OFFER_BELOW_COST'));
  }
  return {
    input,
    product: { id: p.id, composition: p.composition, slug: p.slug, name: productNameOf(p as unknown as Record<string, unknown>) },
    usd,
    rows,
    issues,
    warnings,
  };
}

async function writeOffer(c: Context<AppContext>, productId: string) {
  const admin = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const d = await loadDiscountContext(c.env, productId, admin);
  const plan = await planOffer(c, productId, body, d, 'save');
  const { input } = plan;
  if (plan.product.slug) c.set('catalogueSlug', plan.product.slug);

  const before = await c.env.DB
    .prepare("SELECT * FROM offer_windows WHERE subject_type = 'product' AND subject_id = ?")
    .bind(productId)
    .first<Record<string, unknown>>();
  const usdInstalled = d.usdSupported;
  const beforeUsd = before && usdInstalled ? await storedUsdSet(c.env.DB, productId) : [];
  const savedAt = new Date().toISOString();

  // D12: a lost update is refused INSIDE the batch — the tab and the card edit one row. NULL = "no row".
  const guard =
    input.expected_updated_at === undefined
      ? []
      : fence(
          c.env.DB,
          "(SELECT updated_at FROM offer_windows WHERE subject_type = 'product' AND subject_id = ?) IS ?",
          [productId, input.expected_updated_at]
        );
  const statements = offerWindowStatements(c.env.DB, subjectOf(productId), input);
  // The dollar set is rewritten whole (DELETE, then the INSERTs); any other mode leaves it empty.
  const usdStatements = usdInstalled ? offerUsdStatements(c.env.DB, productId, input.offer_price_mode === 'fixed_usd' ? plan.usd : []) : [];
  // INSIDE the batch: this write changes who may buy a thing and for how much.
  const { statements: auditStmts } = await auditStatements(
    c.env.DB,
    admin.id,
    'offer.update',
    productId,
    {
      before: before ? windowView(before, null, beforeUsd) : null,
      after: {
        starts_at: input.starts_at,
        ends_at: input.ends_at,
        required_tiers: input.required_tiers,
        offer_price_mode: input.offer_price_mode,
        offer_price_iqd: input.offer_price_iqd,
        discount_percent: input.discount_percent,
        discount_iqd: input.discount_iqd,
        plus_price_iqd: input.plus_price_iqd,
        active: input.active,
        max_per_user: input.max_per_user,
        max_global: input.max_global,
        offer_usd_prices:
          input.offer_price_mode === 'fixed_usd' ? plan.usd.map((p) => ({ model_id: p.model_id, usd: usdTextOfCents(p.cents) })) : [],
      },
    }
  );
  // D6: an EDITOR's save that sells below cost rings the owner's bell — never refused, never said to them.
  const belowCost = plan.rows.some((r) => r.owner?.below_cost);
  const bell = belowCost ? await offerBelowCostBell(c.env, d.viewer, productId, plan.product.name, savedAt) : [];
  try {
    await c.env.DB.batch([...guard, ...statements, ...usdStatements, ...auditStmts, ...bell]);
  } catch (e) {
    if (isFenceMiss(e)) refuse('SPECIAL_OFFER_CHANGED');
    throw e;
  }

  const stored = await c.env.DB
    .prepare(
      `SELECT w.*, l.max_per_user AS max_per_user, l.max_global AS max_global
         FROM offer_windows w
         LEFT JOIN offer_limits l ON l.subject_type = w.subject_type AND l.subject_id = w.subject_id
        WHERE w.subject_type = 'product' AND w.subject_id = ?`
    )
    .bind(productId)
    .first<Record<string, unknown>>();

  return c.json({
    success: true,
    offer: stored ? windowView(stored, await cleanStartAt(c.env.DB), usdInstalled ? await namedUsdSet(c.env.DB, productId) : []) : null,
    // Kept visible after a successful save, the `ProductForm` pattern (§11.3).
    warnings: plan.warnings,
    rows: rowsFor(d, plan.rows),
  });
}

/**
 * Said, never repaired. A gate an admin may not have meant is a warning rather
 * than a refusal, because both configurations are legitimate — but silence
 * about them is not.
 */
function warningsFor(input: OfferInput, composition: string) {
  const out: Array<Record<string, unknown>> = [];
  if (input.required_tiers.length > 0 && composition === '') {
    out.push({
      code: 'OFFER_GATES_ORDINARY_PRODUCT',
      message: 'this gate makes an ordinary catalogue product members-only while the window is live',
      ar: 'هذا الشرط يجعل منتجًا عاديًا حصريًا للمشتركين طوال مدة العرض',
      en: 'this gate makes an ordinary catalogue product members-only while the window is live',
      ckb: 'ئەم مەرجە بەرهەمێکی ئاسایی دەکاتە تایبەت بە ئەندامان لە ماوەی ئۆفەرەکەدا',
    });
  }
  if (!input.starts_at && !input.ends_at && input.offer_price_mode !== '') {
    out.push({
      code: 'OFFER_PRICE_NEVER_ENDS',
      message: 'this offer price has no end date and will run until it is switched off by hand',
      ar: 'سعر هذا العرض بلا تاريخ انتهاء وسيستمر حتى يُوقف يدويًا',
      en: 'this offer price has no end date and will run until it is switched off by hand',
      ckb: 'نرخی ئەم ئۆفەرە بەرواری کۆتایی نییە و بەردەوام دەبێت تا بە دەست ڕادەگیرێت',
    });
  }
  return out;
}

adminOffersRoutes.post('/', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const productId = str(body.subject_id ?? body.product_id, 'subject_id', { min: 1, max: 60 });
  return writeOffer(c, productId);
});

adminOffersRoutes.put('/:productId', async (c) => writeOffer(c, c.req.param('productId')));

/**
 * THE PREVIEW (docs/ux/PRODUCT-DISCOUNT.md §5.2): the PUT body, the same checks 1–7, and every
 * published SKU × channel priced by the one resolver with the draft — the card computes nothing.
 * WRITES NOTHING: no row, no audit, no purge (the middleware skips `/preview`). A refusal of checks
 * 1–6 answers the rows with no after price, so the card still shows the before column; step 7's two
 * refusals ride beside the priced rows.
 */
adminOffersRoutes.post('/:productId/preview', async (c) => {
  const productId = c.req.param('productId');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const d = await loadDiscountContext(c.env, productId, c.get('user'));
  try {
    const plan = await planOffer(c, productId, body, d, 'preview');
    return c.json({ success: true, rows: rowsFor(d, plan.rows), issues: plan.issues, warnings: plan.warnings });
  } catch (e) {
    if (!(e instanceof HttpError) || e.status >= 500 || e.status === 404) throw e;
    const listed = Array.isArray(e.details?.errors) ? (e.details!.errors as Array<Record<string, unknown>>) : [{ code: e.code ?? 'VALIDATION', message: e.message }];
    const rows: PreviewRow[] = discountRead(d).rows.map((r) => ({ ...r, after_iqd: null, after_usd: null, offer_saving_percent: null, state: 'not_covered' }));
    // `refused`: the draft prices nothing — the card shows the before column and «—», and says the sentence.
    return c.json({ success: true, rows, issues: listed, warnings: [], refused: true });
  }
});

/**
 * Removing a window UN-GATES and UN-SCHEDULES the subject, which is a
 * disclosure change of its own, so it is audited inside its batch too. The
 * redemptions are NOT deleted: they are the history of what was actually sold
 * under the offer, and a per-user limit re-created later must still see them.
 */
adminOffersRoutes.delete('/:productId', async (c) => {
  const admin = c.get('user')!;
  const productId = c.req.param('productId');
  const before = await c.env.DB
    .prepare("SELECT * FROM offer_windows WHERE subject_type = 'product' AND subject_id = ?")
    .bind(productId)
    .first<Record<string, unknown>>();
  if (!before) throw notFound('offer');
  const slug = await c.env.DB.prepare('SELECT slug FROM products WHERE id = ?').bind(productId).first<{ slug: string | null }>();
  if (slug?.slug) c.set('catalogueSlug', slug.slug); // its cached page goes with the window (F3)
  const usdInstalled = await offerUsdInstalled(c.env.DB);
  const beforeUsd = usdInstalled ? await storedUsdSet(c.env.DB, productId) : [];
  const { statements: auditStmts } = await auditStatements(c.env.DB, admin.id, 'offer.update', productId, {
    before: windowView(before, null, beforeUsd),
    after: null,
  });
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM offer_windows WHERE subject_type = 'product' AND subject_id = ?").bind(productId),
    c.env.DB.prepare("DELETE FROM offer_limits WHERE subject_type = 'product' AND subject_id = ?").bind(productId),
    // The dollar sale prices go with their window (0197, §5.4); the redemptions stay.
    ...(usdInstalled ? offerUsdStatements(c.env.DB, productId, []) : []),
    ...auditStmts,
  ]);
  return c.json({ success: true, removed: true });
});
