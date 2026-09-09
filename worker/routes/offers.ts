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
 *  - a window price beside a non-`fixed` `bundle_config.price_mode` on the
 *    same subject — two live price sources on one product, never summed and
 *    never resolved by whichever branch happened to run first
 *    (`OFFER_PRICE_CONFLICT`);
 *  - a schedule whose end precedes its start (`SCHEDULE_INVERTED`).
 *
 * AND IT WRITES ITS AUDIT ROW INSIDE THE BATCH. A tier gate and an offer price
 * are disclosure- and money-changing writes; auditing them AFTER their batch
 * means a crash between the two leaves an unaudited change to who may buy a
 * thing and for how much (§10, §15.1 rule 10).
 *
 * `requireAdmin` IS ATTACHED HERE. `requireMainHost` on `/api/admin/*` is a
 * HOST check and never a role check, so a router mounted without its own guard
 * is an open admin API guarded only by hostname.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { badRequest, int, notFound, requireAdmin, str } from '../lib/http';
import { auditStatements } from '../lib/audit';
import {
  INHERITS,
  normalizeUtc,
  offerWindowStatements,
  parseRequiredTiers,
  scheduleState,
  subjectOf,
} from '../lib/offers';

export const adminOffersRoutes = new Hono<AppContext>();
adminOffersRoutes.use('*', requireAdmin);

const PRICE_MODES = ['', 'fixed', 'discount_percent', 'discount_iqd'];

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
} as const;

type IssueCode = keyof typeof ISSUES;

const issue = (code: IssueCode) => ({ code, message: ISSUES[code].en, ...ISSUES[code] });

const refuse = (code: IssueCode): never => {
  throw badRequest(ISSUES[code].en, code, { errors: [issue(code)] });
};

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
    where += ' AND (p.name LIKE ? OR p.name_ar LIKE ? OR p.slug LIKE ?)';
    const like = `%${search}%`;
    params.push(like, like, like);
  }
  if (kind === 'product') where += " AND COALESCE(p.composition, '') = ''";
  else if (kind === 'bundle' || kind === 'mystery') {
    where += ' AND p.composition = ?';
    params.push(kind);
  }
  const { results } = await c.env.DB
    .prepare(
      `SELECT w.*, l.max_per_user AS max_per_user, l.max_global AS max_global,
              p.name AS product_name, p.slug AS product_slug, COALESCE(p.composition,'') AS composition,
              p.status AS product_status,
              (SELECT COALESCE(SUM(r.qty), 0) FROM offer_redemptions r
                WHERE r.subject_type = w.subject_type AND r.subject_id = w.subject_id) AS redeemed
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
  return c.json({
    success: true,
    offers: (results ?? []).map((r) => ({
      ...windowView(r),
      product: {
        id: String(r.subject_id),
        name: r.product_name ?? '',
        slug: r.product_slug ?? '',
        composition: String(r.composition ?? ''),
        status: r.product_status ?? '',
      },
      redeemed: Number(r.redeemed ?? 0),
      schedule_state: scheduleState(
        (r.starts_at as string | null) ?? null,
        (r.ends_at as string | null) ?? null,
        now
      ),
    })),
  });
});

function windowView(r: Record<string, unknown>) {
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
  };
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
      .prepare("SELECT COALESCE(SUM(qty), 0) AS n FROM offer_redemptions WHERE subject_type = 'product' AND subject_id = ?")
      .bind(productId)
      .first<{ n: number }>(),
  ]);
  return c.json({
    success: true,
    product,
    offer: w ? { ...windowView({ ...w, ...(l ?? {}) }) } : null,
    redeemed: Number(redeemed?.n ?? 0),
    schedule_state: w
      ? scheduleState((w.starts_at as string | null) ?? null, (w.ends_at as string | null) ?? null, Date.now())
      : null,
  });
});

// --------------------------------------------------------------- the write

async function writeOffer(c: Context<AppContext>, productId: string) {
  const admin = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const input = readOffer(body);

  const product = await c.env.DB
    .prepare("SELECT id, COALESCE(composition,'') AS composition FROM products WHERE id = ?")
    .bind(productId)
    .first<{ id: string; composition: string }>();
  if (!product) refuse('OFFER_SUBJECT_NOT_FOUND');

  if (input.starts_at && input.ends_at && Date.parse(input.ends_at) < Date.parse(input.starts_at)) {
    refuse('SCHEDULE_INVERTED');
  }
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
   * reach here, since a derived `bundle_config.price_mode` beside a window
   * price is already refused as `OFFER_PRICE_CONFLICT` just below.
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

  // TWO PRICE SOURCES ON ONE SUBJECT ARE REFUSED, NEVER SUMMED (§4.5, §4.6).
  // `resolveOfferPrice` is the only price a live window contributes, and a
  // derived `bundle_config.price_mode` is the only price its own mode
  // contributes; a subject carrying both does not sell rather than being
  // priced by whichever branch ran first.
  if (input.offer_price_mode !== '') {
    const cfg = await c.env.DB
      .prepare('SELECT price_mode FROM bundle_config WHERE product_id = ?')
      .bind(productId)
      .first<{ price_mode: string }>();
    if (cfg && cfg.price_mode && cfg.price_mode !== 'fixed') refuse('OFFER_PRICE_CONFLICT');
  }

  const before = await c.env.DB
    .prepare("SELECT * FROM offer_windows WHERE subject_type = 'product' AND subject_id = ?")
    .bind(productId)
    .first<Record<string, unknown>>();

  const statements = offerWindowStatements(c.env.DB, subjectOf(productId), input);
  // INSIDE the batch: this write changes who may buy a thing and for how much.
  const { statements: auditStmts } = await auditStatements(
    c.env.DB,
    admin.id,
    'offer.update',
    productId,
    {
      before: before ? windowView(before) : null,
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
      },
    }
  );
  await c.env.DB.batch([...statements, ...auditStmts]);

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
    offer: stored ? windowView(stored) : null,
    // Kept visible after a successful save, the `ProductForm` pattern (§11.3).
    warnings: warningsFor(input, product ? product.composition : ''),
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
  const { statements: auditStmts } = await auditStatements(c.env.DB, admin.id, 'offer.update', productId, {
    before: windowView(before),
    after: null,
  });
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM offer_windows WHERE subject_type = 'product' AND subject_id = ?").bind(productId),
    c.env.DB.prepare("DELETE FROM offer_limits WHERE subject_type = 'product' AND subject_id = ?").bind(productId),
    ...auditStmts,
  ]);
  return c.json({ success: true, removed: true });
});
