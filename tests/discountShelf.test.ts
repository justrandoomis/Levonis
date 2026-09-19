/**
 * THE «المخفَّضة» SHELF THAT WAS EMPTY WHILE THE STORE HAD REAL DISCOUNTS.
 *
 * The owner saw it from their phone: the home page's offers strip showed
 * nothing, «عرض الكل» behind it listed nothing, and the store's only product
 * carried TWO live membership discounts at the same moment. The live API said
 * both things at once:
 *
 *   GET /api/products/bambu-lab-a1
 *     product.pro_price_iqd   = null
 *     product.prime_price_iqd = null
 *     membership_preview      = { prime: { unit_iqd 660000, saving 15000, … },
 *                                 pro:   { unit_iqd 607500, saving 67500, … } }
 *
 * Two surfaces decided the word «مخفّض» — the home strip and
 * `/api/products?type=discounted` — and both asked only whether a TYPED
 * `pro_price_iqd` / `prime_price_iqd` sat below the regular price. This shop
 * types neither: since migration 0074 it states both memberships as rules in
 * `membership_benefit_rules`, written once against a section. So the question
 * was answered honestly and was the wrong question, and a customer opening the
 * shop concluded it runs no offers.
 *
 * WHAT THESE TESTS PIN, and why each one is here rather than assumed:
 *
 *   1. THE REGRESSION — a rule-only discount reaches BOTH surfaces, and they
 *      return the same product. A fix to one of them leaves the strip and the
 *      listing behind its own «عرض الكل» disagreeing about what the word
 *      means, which is worse than being consistently wrong.
 *   2. THE OLD QUESTION SURVIVES — a typed tier price below the regular one
 *      keeps its place. The owner asked for the union, not a replacement.
 *   3. THE SCHEDULE IS HONOURED — a rule that ended last week is not a
 *      discount today, and one that starts next month is not one yet.
 *   4. THE BRANCH IS HONOURED — a rule on «الطابعات» reaches a product filed
 *      under «الطابعات ← FDM», because `scopeMatches` matches the whole
 *      ancestry and not the id on the row.
 *   5. THE AMOUNT DOES NOT LIE — a guest on the shelf is shown the PRIME and
 *      PRO prices the resolver would actually charge those members, as
 *      tier-labelled teasers, while their OWN price stays the regular price
 *      and their own tier stays 'regular'.
 *   6. IT IS NOT N+1 — the shelf costs the same number of D1 statements with
 *      twelve products on it as with one. The rules are already in memory from
 *      `pricingCtx`; asking D1 per card would be a per-product query on the
 *      shop's first screen.
 *
 * Run: node --import tsx --test tests/discountShelf.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { APEX, asD1, ctx, freshDb, json, stubApp } from './fixtures/app';
import { discountedWhere, homeRoutes, productRoutes, shelfDiscountRules } from '../worker/routes/products';
import type { PricingCtx } from '../worker/routes/products';

type Raw = DatabaseSync;

/* ------------------------------------------------------------- the fixture */

/** A product filed the way the ADMIN FORM files one: the classification
 *  columns are written, `product_catalogs` is not — the shape the live
 *  database is actually in. */
function product(
  raw: Raw,
  id: string,
  opts: {
    price?: number;
    pro?: number | null;
    prime?: number | null;
    category?: string | null;
    sub?: string | null;
  } = {}
): void {
  raw
    .prepare(
      `INSERT INTO products (id, slug, name, description, price_iqd, pro_price_iqd, prime_price_iqd,
                             status, category_id, sub_category_id, composition)
       VALUES (?, ?, ?, '', ?, ?, ?, 'active', ?, ?, '')`
    )
    .run(
      id,
      id,
      id,
      opts.price ?? 675_000,
      opts.pro ?? null,
      opts.prime ?? null,
      opts.category ?? null,
      opts.sub ?? null
    );
}

function catalog(raw: Raw, id: string, parent: string | null): void {
  raw
    .prepare('INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, sort) VALUES (?, ?, ?, ?, ?, 0)')
    .run(id, parent, id, id, id);
}

/** One `membership_benefit_rules` row, with only the columns a discount uses. */
function rule(
  raw: Raw,
  id: string,
  opts: {
    tier?: 'prime' | 'pro' | 'plus';
    scope?: 'global' | 'category' | 'sub_category' | 'product';
    category_id?: string | null;
    sub_category_id?: string | null;
    product_id?: string | null;
    mode?: 'percent' | 'fixed';
    percent?: number | null;
    fixed?: number | null;
    min_subtotal?: number | null;
    max_quantity?: number | null;
    from?: string | null;
    until?: string | null;
    enabled?: 0 | 1;
  } = {}
): void {
  raw
    .prepare(
      `INSERT INTO membership_benefit_rules
         (id, tier, benefit_type, scope, category_id, sub_category_id, product_id,
          discount_mode, percent, fixed_iqd, min_subtotal_iqd, max_quantity,
          valid_from, valid_until, enabled, priority, label)
       VALUES (?, ?, 'product_discount', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
    )
    .run(
      id,
      opts.tier ?? 'pro',
      opts.scope ?? 'global',
      opts.category_id ?? null,
      opts.sub_category_id ?? null,
      opts.product_id ?? null,
      opts.mode ?? 'percent',
      opts.percent === undefined ? 10 : opts.percent,
      opts.fixed ?? null,
      opts.min_subtotal ?? null,
      opts.max_quantity ?? null,
      opts.from ?? null,
      opts.until ?? null,
      opts.enabled ?? 1,
      id
    );
}

const app = (raw: Raw) => {
  const db = asD1(raw);
  return stubApp(db as never, null, (a) => a.route('/api/home', homeRoutes).route('/api/products', productRoutes), {
    host: APEX,
    env: { DB: db, INITIAL_ADMIN_EMAIL: 'boss@x.co', EXTRA_ALLOWED_ORIGINS: '' },
  });
};
const get = (a: ReturnType<typeof app>, path: string) =>
  a.request(path, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }, undefined, ctx);

const ids = (rows: Array<Record<string, unknown>>) => rows.map((r) => String(r.id)).sort();

/** Both surfaces, as one answer, so a test cannot accidentally check only one. */
async function shelves(raw: Raw): Promise<{ home: string[]; listing: string[] }> {
  const a = app(raw);
  const home = await json(await get(a, '/api/home'));
  const listing = await json(await get(a, '/api/products?type=discounted&limit=50'));
  assert.equal(home.success, true);
  assert.equal(listing.success, true);
  return { home: ids(home.discounted), listing: ids(listing.products) };
}

/* ====================================================================== 1 */
/* THE REGRESSION                                                           */
/* ====================================================================== */

test('a discount that exists ONLY as a benefit rule reaches both shelves', async () => {
  const raw = freshDb();
  // Exactly the live shape: no typed tier price anywhere on the row.
  product(raw, 'bambu-lab-a1');
  rule(raw, 'pro-10pct', { tier: 'pro', scope: 'global', percent: 10 });

  const { home, listing } = await shelves(raw);
  assert.deepEqual(home, ['bambu-lab-a1'], 'the home «المخفَّضة» strip is empty while the store has a real discount');
  assert.deepEqual(listing, ['bambu-lab-a1'], '«عرض الكل» disagrees with the strip it belongs to');
});

test('with no rule and no typed price the shelves stay empty — the fix invents nothing', async () => {
  const raw = freshDb();
  product(raw, 'plain');

  const { home, listing } = await shelves(raw);
  assert.deepEqual(home, []);
  assert.deepEqual(listing, []);
});

/* ====================================================================== 2 */
/* THE OLD QUESTION IS KEPT, NOT REPLACED                                   */
/* ====================================================================== */

test('a TYPED tier price below the regular one keeps its badge with no rules at all', async () => {
  const raw = freshDb();
  // The owner's own number on one product — it outranks any rule and must
  // never have been traded away for them.
  product(raw, 'typed-pro', { price: 100_000, pro: 90_000 });
  product(raw, 'typed-prime', { price: 100_000, prime: 95_000 });
  product(raw, 'typed-but-not-lower', { price: 100_000, pro: 100_000 });

  const { home, listing } = await shelves(raw);
  assert.deepEqual(home, ['typed-pro', 'typed-prime'].sort());
  assert.deepEqual(listing, ['typed-pro', 'typed-prime'].sort());
});

test('the predicate is a UNION — typed prices and rules both land on the shelf', async () => {
  const raw = freshDb();
  catalog(raw, 't_printers', null);
  catalog(raw, 't_toys', null);
  product(raw, 'typed', { price: 100_000, pro: 90_000 });
  product(raw, 'ruled', { price: 100_000, category: 't_printers' });
  product(raw, 'neither', { price: 100_000, category: 't_toys' });
  rule(raw, 'printers', { tier: 'prime', scope: 'category', category_id: 't_printers', percent: 5 });

  const { home, listing } = await shelves(raw);
  assert.deepEqual(home, ['ruled', 'typed']);
  assert.deepEqual(listing, ['ruled', 'typed']);
});

/* ====================================================================== 3 */
/* THE SCHEDULE                                                             */
/* ====================================================================== */

test('a rule that has ended is not a discount today, and one that has not started is not one yet', async () => {
  const raw = freshDb();
  product(raw, 'expired-only');
  product(raw, 'future-only');
  product(raw, 'live-only');
  rule(raw, 'ended', { scope: 'product', product_id: 'expired-only', until: '2020-01-01T00:00:00.000Z' });
  rule(raw, 'upcoming', { scope: 'product', product_id: 'future-only', from: '2999-01-01T00:00:00.000Z' });
  rule(raw, 'live', { scope: 'product', product_id: 'live-only' });

  const { home, listing } = await shelves(raw);
  assert.deepEqual(home, ['live-only']);
  assert.deepEqual(listing, ['live-only']);
});

test('a disabled rule badges nothing', async () => {
  const raw = freshDb();
  product(raw, 'p1');
  rule(raw, 'off', { scope: 'product', product_id: 'p1', enabled: 0 });

  assert.deepEqual((await shelves(raw)).home, []);
});

/* ====================================================================== 4 */
/* THE BRANCH                                                               */
/* ====================================================================== */

test('a rule on a main section reaches a product filed under a sub-section of it', async () => {
  const raw = freshDb();
  // «الطابعات ← FDM ← Bambu» — the depth an admin can build and a flat
  // `category_id = ?` test would silently skip.
  catalog(raw, 't_printers', null);
  catalog(raw, 't_fdm', 't_printers');
  catalog(raw, 't_bambu', 't_fdm');
  catalog(raw, 't_resin', 't_printers');
  catalog(raw, 't_toys', null);
  product(raw, 'deep', { category: 't_printers', sub: 't_bambu' });
  product(raw, 'shallow', { category: 't_printers', sub: 't_resin' });
  product(raw, 'elsewhere', { category: 't_toys', sub: null });
  rule(raw, 'printers', { scope: 'category', category_id: 't_printers', percent: 10 });

  const { home, listing } = await shelves(raw);
  assert.deepEqual(home, ['deep', 'shallow']);
  assert.deepEqual(listing, ['deep', 'shallow']);
});

test('a sub-section rule does not reach its siblings', async () => {
  const raw = freshDb();
  catalog(raw, 't_printers', null);
  catalog(raw, 't_fdm', 't_printers');
  catalog(raw, 't_resin', 't_printers');
  product(raw, 'fdm', { category: 't_printers', sub: 't_fdm' });
  product(raw, 'resin', { category: 't_printers', sub: 't_resin' });
  rule(raw, 'fdm-only', { scope: 'sub_category', sub_category_id: 't_fdm', percent: 10 });

  assert.deepEqual((await shelves(raw)).home, ['fdm']);
});

test('a product-scoped rule badges that product and nothing else', async () => {
  const raw = freshDb();
  product(raw, 'chosen');
  product(raw, 'other');
  rule(raw, 'one', { scope: 'product', product_id: 'chosen' });

  assert.deepEqual((await shelves(raw)).home, ['chosen']);
});

/* ====================================================================== 5 */
/* THE AMOUNT MUST NOT LIE                                                  */
/* ====================================================================== */

test('a signed-out visitor is shown the MEMBERSHIP prices, not a member price of their own', async () => {
  const raw = freshDb();
  product(raw, 'a1', { price: 675_000 });
  // The live shape: PREMIUM a flat 15,000 off, PRO 10% — neither typed on the
  // product, both stated once as a rule.
  rule(raw, 'prime-fixed', { tier: 'prime', scope: 'global', mode: 'fixed', percent: null, fixed: 15_000 });
  rule(raw, 'pro-pct', { tier: 'pro', scope: 'global', mode: 'percent', percent: 10 });

  const body = await json(await get(app(raw), '/api/home'));
  const card = body.discounted[0] as Record<string, unknown>;

  // WHAT THE GUEST PAYS is untouched: the regular price, at the regular tier.
  assert.equal(card.display_price_iqd, 675_000, 'a guest was quoted a member price');
  assert.equal(card.display_applied_tier, 'regular');
  assert.equal(card.display_regular_iqd, 675_000);

  // WHAT THE MEMBERSHIP IS WORTH, labelled as the tier's and equal to what the
  // resolver would charge that member — the same figures
  // `/api/products/:slug` already publishes as `membership_preview`.
  assert.equal(card.display_prime_iqd, 660_000);
  assert.equal(card.display_pro_iqd, 607_500);
});

test('the card and the product page quote the SAME membership numbers', async () => {
  const raw = freshDb();
  product(raw, 'a1', { price: 675_000 });
  rule(raw, 'prime-fixed', { tier: 'prime', scope: 'global', mode: 'fixed', percent: null, fixed: 15_000 });
  rule(raw, 'pro-pct', { tier: 'pro', scope: 'global', mode: 'percent', percent: 10 });

  const a = app(raw);
  const card = (await json(await get(a, '/api/home'))).discounted[0] as Record<string, unknown>;
  const page = await json(await get(a, '/api/products/a1'));

  assert.equal(page.membership_preview.prime.unit_iqd, card.display_prime_iqd);
  assert.equal(page.membership_preview.pro.unit_iqd, card.display_pro_iqd);
});

test('a TYPED member price is never overwritten by a rule-derived teaser', async () => {
  const raw = freshDb();
  // The owner typed 600,000 for PRO on this product. A global 10% rule would
  // compute 607,500 — the typed number wins, here as in `memberPrice`.
  product(raw, 'a1', { price: 675_000, pro: 600_000 });
  rule(raw, 'pro-pct', { tier: 'pro', scope: 'global', percent: 10 });

  const card = (await json(await get(app(raw), '/api/home'))).discounted[0] as Record<string, unknown>;
  assert.equal(card.display_pro_iqd, 600_000);
});

test('an order-conditional rule cannot badge a product, because no card could quote it', async () => {
  const raw = freshDb();
  // «خصم 10% على الطلبات فوق 500,000» is a real benefit and a real discount,
  // but `isUnitExpressible` keeps it out of the unit price on purpose, so the
  // card has no number to print. A badge over an unchanged price is the same
  // empty promise this whole round is about.
  product(raw, 'min-subtotal');
  product(raw, 'max-qty');
  rule(raw, 'min', { scope: 'product', product_id: 'min-subtotal', min_subtotal: 500_000 });
  rule(raw, 'qty', { scope: 'product', product_id: 'max-qty', max_quantity: 2 });

  assert.deepEqual((await shelves(raw)).home, []);
});

test('a rule configured to zero is not a discount', async () => {
  const raw = freshDb();
  product(raw, 'zero-pct');
  product(raw, 'zero-fixed');
  rule(raw, 'zp', { scope: 'product', product_id: 'zero-pct', percent: 0 });
  rule(raw, 'zf', { scope: 'product', product_id: 'zero-fixed', mode: 'fixed', percent: null, fixed: 0 });

  assert.deepEqual((await shelves(raw)).home, []);
});

/**
 * A RULE BIGGER THAN THE PRODUCT MUST NOT PRINT «PRO 0 (للمشتركين)».
 *
 * `quotableDiscount` checks the RULE — a percent above zero, a fixed amount
 * above zero — and nothing can check it against a price it has not met yet. A
 * fixed 50,000 reaching a 20,000 product makes `unitDiscountIqd` clamp the
 * discount at the price, so the rung comes back 0: strictly below the regular
 * price, and therefore printable, on every card surface this teaser feeds.
 * Before the teaser existed such a misconfiguration was visible only to the
 * member it affected; it is now published store-wide, so it is guarded here.
 */
test('a rule that would zero a product prints no free price', async () => {
  const raw = freshDb();
  product(raw, 'cheap', { price: 20_000 });
  rule(raw, 'toobig', { tier: 'pro', scope: 'global', mode: 'fixed', percent: null, fixed: 50_000 });

  const a = app(raw);
  const listing = await json(await get(a, '/api/products?limit=50'));
  const card = (listing.products as Array<Record<string, unknown>>).find((p) => p.id === 'cheap')!;
  assert.equal(card.display_pro_iqd, null, 'a card may not advertise a price of zero');
  assert.equal(card.display_prime_iqd, null);
});

test("a PLUS rule shows nothing, because no ordinary product's card has a PLUS rung", async () => {
  const raw = freshDb();
  product(raw, 'p1');
  rule(raw, 'plus', { tier: 'plus', scope: 'product', product_id: 'p1' });

  assert.deepEqual((await shelves(raw)).home, []);
});

/* ====================================================================== 6 */
/* THE COST                                                                 */
/* ====================================================================== */

/** Counts the D1 statements one request prepares. */
function counting(raw: Raw): { db: unknown; n: () => number } {
  let n = 0;
  const inner = asD1(raw) as unknown as { prepare: (s: string) => unknown };
  return {
    db: {
      prepare: (sql: string) => {
        n += 1;
        return inner.prepare(sql);
      },
      batch: (s: unknown[]) => (inner as unknown as { batch: (x: unknown[]) => unknown }).batch(s),
    },
    n: () => n,
  };
}

test('the shelf costs the same number of statements with twelve products as with one', async () => {
  const build = (count: number) => {
    const raw = freshDb();
    catalog(raw, 't_printers', null);
    rule(raw, 'printers', { scope: 'category', category_id: 't_printers', percent: 10 });
    for (let i = 0; i < count; i += 1) product(raw, `p${i}`, { category: 't_printers' });
    return raw;
  };
  const run = async (count: number) => {
    const c = counting(build(count));
    const a = stubApp(c.db as never, null, (x) => x.route('/api/home', homeRoutes), {
      host: APEX,
      env: { DB: c.db, INITIAL_ADMIN_EMAIL: 'boss@x.co', EXTRA_ALLOWED_ORIGINS: '' },
    });
    const body = await json(await get(a as never, '/api/home'));
    return { statements: c.n(), shelf: (body.discounted as unknown[]).length };
  };

  const one = await run(1);
  const twelve = await run(12);
  assert.equal(one.shelf, 1);
  assert.equal(twelve.shelf, 10, 'the strip is capped at ten');
  assert.equal(
    twelve.statements,
    one.statements,
    'the discounted shelf grew a query per product — that is N+1 on the shop\'s first screen'
  );
});

test('the rules become at most TWO bound parameters, however many of them there are', () => {
  // D1 refuses a statement with more than 100 bound parameters, and the
  // taxonomy is the owner's to grow. Expanding a section rule into one
  // parameter per descendant catalog would start failing with the shop's
  // growth rather than with this change, so the branch walk happens inside
  // SQLite and the whole set costs one JSON array.
  const rules = [] as Array<Record<string, unknown>>;
  for (let i = 0; i < 60; i += 1) {
    rules.push({
      id: `r${i}`,
      tier: i % 2 ? 'pro' : 'prime',
      benefit_type: 'product_discount',
      scope: i % 3 === 0 ? 'product' : i % 3 === 1 ? 'category' : 'sub_category',
      category_id: `cat${i}`,
      sub_category_id: `sub${i}`,
      product_id: `p${i}`,
      discount_mode: 'percent',
      percent: 10,
      fixed_iqd: null,
      max_discount_iqd: null,
      cap_scope: null,
      max_quantity: null,
      min_subtotal_iqd: null,
      free_shipping_threshold_iqd: null,
      shipping_methods: null,
      max_shipping_subsidy_iqd: null,
      cod_tax_exempt: null,
      enabled: true,
      priority: 0,
      valid_from: null,
      valid_until: null,
      label: null,
    });
  }
  const ctxWith = {
    benefitRules: rules,
    catalogAncestry: null,
    benefitNowIso: '2026-09-19T00:00:00.000Z',
  } as unknown as PricingCtx;

  assert.equal(shelfDiscountRules(ctxWith).length, 60);
  const where = discountedWhere(ctxWith);
  assert.equal(where.params.length, 2, 'the predicate binds one parameter per id — D1 refuses past 100');
  assert.ok(where.sql.includes('pro_price_iqd'), 'the typed half of the union was dropped');
});

test('a GLOBAL rule means every product, and says so without binding anything', () => {
  const ctxWith = {
    benefitRules: [
      {
        id: 'g',
        tier: 'pro',
        benefit_type: 'product_discount',
        scope: 'global',
        category_id: null,
        sub_category_id: null,
        product_id: null,
        discount_mode: 'percent',
        percent: 10,
        fixed_iqd: null,
        max_discount_iqd: null,
        cap_scope: null,
        max_quantity: null,
        min_subtotal_iqd: null,
        free_shipping_threshold_iqd: null,
        shipping_methods: null,
        max_shipping_subsidy_iqd: null,
        cod_tax_exempt: null,
        enabled: true,
        priority: 0,
        valid_from: null,
        valid_until: null,
        label: null,
      },
    ],
    catalogAncestry: null,
    benefitNowIso: '2026-09-19T00:00:00.000Z',
  } as unknown as PricingCtx;

  const where = discountedWhere(ctxWith);
  assert.deepEqual(where.params, []);
  assert.equal(where.sql, '(1 = 1)');
});

test('with no rules the predicate is exactly the question the shelves asked before', () => {
  const ctxWith = {
    benefitRules: [],
    catalogAncestry: null,
    benefitNowIso: '2026-09-19T00:00:00.000Z',
  } as unknown as PricingCtx;

  const where = discountedWhere(ctxWith);
  assert.deepEqual(where.params, []);
  assert.equal(
    where.sql.replace(/\s+/g, ' '),
    '((products.pro_price_iqd IS NOT NULL AND products.pro_price_iqd < products.price_iqd)' +
      ' OR (products.prime_price_iqd IS NOT NULL AND products.prime_price_iqd < products.price_iqd))'
  );
});

/* ====================================================================== 7 */
/* THE SHELVES STILL EXCLUDE WHAT THEY ALWAYS EXCLUDED                      */
/* ====================================================================== */

test('a draft product is never on the shelf, however generous the rule', async () => {
  const raw = freshDb();
  product(raw, 'live');
  product(raw, 'draft');
  raw.prepare("UPDATE products SET status = 'draft' WHERE id = 'draft'").run();
  rule(raw, 'all', { scope: 'global', percent: 10 });

  assert.deepEqual((await shelves(raw)).home, ['live']);
});
