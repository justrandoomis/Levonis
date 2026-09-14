/**
 * THE PUBLIC READ PATH — docs/BUNDLES_MYSTERY.md §9, §10, §13, §14 and case 9
 * of §15.4, run through the REAL routers against real migrations.
 *
 * What is proved here, and why each one is worth a test of its own:
 *
 *  - THE LISTING LEAKS NOTHING. The assertion is on the SERIALIZED JSON, not on
 *    a field-by-field read: a card that grew a `blocking[]`, a `max_bundles` or
 *    a component list would pass a property check written before it existed.
 *    The whole payload is searched for the numbers that must not be in it.
 *
 *  - A LOCKED CARD IS A 200 WITH AN ALLOW-LIST. The test asserts the STRIPPED
 *    KEY LIST — `display_price_iqd`, `display_prime_iqd`, `display_pro_iqd`,
 *    `display_applied_tier`, `composition.*`, `saving_percent`, every count —
 *    rather than the absence of one number, because the failure this guards
 *    against is the NEXT field somebody adds to the card.
 *
 *  - AN UNGATED BUNDLE IS PUBLIC. A signed-out visitor and a `free` account
 *    both see it and can open it; only a gated one locks. Without this the
 *    one-promotion-model dividend of §10 is silently lost and every bundle
 *    becomes subscriber-only again.
 *
 *  - THE CARD QUOTES THE NUMBER THE DOOR WILL CHARGE. A PLUS member is shown
 *    the PLUS rung; a derived-mode bundle is shown the FRESHLY DERIVED price
 *    and never the cached `products.price_iqd` the admin save wrote.
 *
 *  - THE COOKIE NEVER SHARES A CACHE ENTRY. A request carrying a session
 *    cookie never receives `Cache-Control: public`; the anonymous variant
 *    carries `Vary: Cookie`.
 *
 *  - ONE PAGE OF 24 BUNDLES COSTS FOUR READS. Asserted as a count of prepared
 *    statements against the composition tables AND as "the same number for 24
 *    bundles as for 2" — a fixed budget catches a regression that a per-page
 *    number would not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SqliteD1, SqliteStatement } from './fixtures/d1';
import { freshDb, stubApp, get, post, json, type StubUser } from './fixtures/app';
import { bundlesRoutes } from '../worker/routes/bundles';
import { productRoutes } from '../worker/routes/products';
import { addMysteryOffer, seedMysteryPool } from './lib/mysteryOffer';

// ------------------------------------------------------------------ fixture

const FUTURE = '2099-01-01T00:00:00.000Z';

/** Counts every prepared statement, so the four-round-trip budget of §14 is a
 *  measurement rather than a claim. Everything else is the real adapter. */
class CountingD1 {
  public sql: string[] = [];
  constructor(private readonly inner: SqliteD1) {}
  prepare(sql: string): SqliteStatement {
    this.sql.push(sql.replace(/\s+/g, ' ').trim());
    return this.inner.prepare(sql);
  }
  batch(statements: SqliteStatement[]) {
    return this.inner.batch(statements);
  }
}

function seed() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('u_free','Sara','s@x.co','h','customer'),
      ('u_plus','Zed','z@x.co','h','customer'),
      ('u_prime','Noor','n@x.co','h','customer');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,starts_at,expires_at) VALUES
      ('m_plus','u_plus','plus_12mo','plus','active',12,49000,'2026-01-01T00:00:00.000Z','${FUTURE}'),
      ('m_prime','u_prime','prime_12mo','prime','active',12,99000,'2026-01-01T00:00:00.000Z','${FUTURE}');
  `);
  // The owner's worked example: printer 5, filament 6 (needs 2), nozzle 20.
  raw.exec(`
    INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,selling_type,sale_types,images,inventory_mode)
    VALUES
      ('p_printer','printer','Printer X1','طابعة','پرینتەر',400000,'active',5,'[]','[]','direct_sale','["direct_sale"]','["https://cdn/x1.png"]','BASE'),
      ('p_pla','pla','PLA Basic','بي إل إيه','پی ئێل ئەی',25000,'active',6,'[]','[]','direct_sale','["direct_sale"]','["https://cdn/pla.png"]','BASE'),
      ('p_nozzle','nozzle','Nozzle 0.4','فوهة','لوولە',5000,'active',20,'[]','[]','direct_sale','["direct_sale"]','["https://cdn/nz.png"]','BASE'),
      ('p_solo','solo-lamp','Solo Lamp','مصباح','چرا',9000,'active',3,'[]','[]','direct_sale','["direct_sale"]','[]','BASE');
  `);
  return raw;
}

interface BundleOpts {
  id: string;
  slug: string;
  name?: string;
  priceIqd?: number;
  primeIqd?: number | null;
  proIqd?: number | null;
  featured?: boolean;
  family?: string;
  config?: Partial<{
    price_mode: string;
    discount_percent: number | null;
    discount_iqd: number | null;
    min_price_iqd: number;
    plus_price_iqd: number | null;
    max_qty_per_order: number;
  }>;
  window?: Partial<{
    starts_at: string | null;
    ends_at: string | null;
    required_tiers: string;
    offer_price_mode: string;
    offer_price_iqd: number | null;
    plus_price_iqd: number | null;
    locked_preview: number;
    active: number;
  }>;
  components?: Array<{ id: string; product: string; qty: number }>;
}

function addBundle(raw: DatabaseSync, o: BundleOpts) {
  raw
    .prepare(
      `INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,prime_price_iqd,pro_price_iqd,status,stock,
                             options,colors,selling_type,sale_types,images,inventory_mode,composition,is_featured,template_family)
       VALUES (?,?,?,?,?,?,?,?,'active',NULL,'[]','[]','bundle','["bundle"]','["https://cdn/bundle.png"]','BASE','bundle',?,?)`
    )
    .run(
      o.id,
      o.slug,
      o.name ?? 'Starter Bundle',
      'حزمة البداية',
      'پاکێجی دەستپێک',
      o.priceIqd ?? 400_000,
      o.primeIqd ?? null,
      o.proIqd ?? null,
      o.featured ? 1 : 0,
      o.family ?? null
    );
  const cfg = {
    price_mode: 'fixed',
    discount_percent: null as number | null,
    discount_iqd: null as number | null,
    min_price_iqd: 1,
    plus_price_iqd: null as number | null,
    max_qty_per_order: 5,
    ...(o.config ?? {}),
  };
  raw
    .prepare(
      `INSERT INTO bundle_config (product_id,price_mode,discount_percent,discount_iqd,min_price_iqd,plus_price_iqd,max_qty_per_order)
       VALUES (?,?,?,?,?,?,?)`
    )
    .run(o.id, cfg.price_mode, cfg.discount_percent, cfg.discount_iqd, cfg.min_price_iqd, cfg.plus_price_iqd, cfg.max_qty_per_order);
  if (o.window) {
    const w = {
      starts_at: null as string | null,
      ends_at: null as string | null,
      required_tiers: '[]',
      offer_price_mode: '',
      offer_price_iqd: null as number | null,
      plus_price_iqd: null as number | null,
      locked_preview: 1,
      active: 1,
      ...o.window,
    };
    raw
      .prepare(
        `INSERT INTO offer_windows (subject_type,subject_id,id,starts_at,ends_at,required_tiers,
                                    offer_price_mode,offer_price_iqd,plus_price_iqd,locked_preview,active)
         VALUES ('product',?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        o.id,
        `ofw_${o.id}`,
        w.starts_at,
        w.ends_at,
        w.required_tiers,
        w.offer_price_mode,
        w.offer_price_iqd,
        w.plus_price_iqd,
        w.locked_preview,
        w.active
      );
  }
  const comps = o.components ?? [
    { id: `${o.id}_c1`, product: 'p_printer', qty: 1 },
    { id: `${o.id}_c2`, product: 'p_pla', qty: 2 },
    { id: `${o.id}_c3`, product: 'p_nozzle', qty: 1 },
  ];
  comps.forEach((c, i) =>
    raw
      .prepare(
        `INSERT INTO bundle_components (id,bundle_product_id,member_product_id,qty,optional,option_value_ids,color_id,
                                        customer_picks_option,customer_picks_color,sort)
         VALUES (?,?,?,?,0,'[]','',0,0,?)`
      )
      .run(c.id, o.id, c.product, c.qty, i)
  );
}

const appFor = (db: unknown, user: StubUser | null) =>
  stubApp(db, user, (a) => {
    a.route('/api/bundles', bundlesRoutes);
    a.route('/api/products', productRoutes);
  });

const FREE: StubUser = { id: 'u_free', role: 'customer', email: 's@x.co' };
const PLUS: StubUser = { id: 'u_plus', role: 'customer', email: 'z@x.co' };
const PRIME: StubUser = { id: 'u_prime', role: 'customer', email: 'n@x.co' };

// ------------------------------------------------------- the listing payload

test('the listing carries the card facts of §10 and preserves the 0034 response keys', async () => {
  const raw = seed();
  addBundle(raw, { id: 'b1', slug: 'starter', priceIqd: 400_000 });
  const res = await get(appFor(new SqliteD1(raw) as unknown as D1Database, null), '/api/bundles');
  assert.equal(res.status, 200);
  const body = await json(res);

  assert.deepEqual(Object.keys(body).sort(), ['bundles', 'entitled', 'signed_in']);
  assert.equal(body.entitled, false); // a signed-out visitor holds no membership
  assert.equal(body.signed_in, false);
  assert.equal(body.bundles.length, 1);

  const card = body.bundles[0];
  assert.equal(card.product_slug, 'starter');
  assert.equal(card.name, 'Starter Bundle');
  assert.equal(card.name_ar, 'حزمة البداية');
  assert.equal(card.name_ku, 'پاکێجی دەستپێک');
  assert.equal(card.image, 'https://cdn/bundle.png');
  assert.equal(card.locked, false);
  // printer 400,000 + 2 × PLA 25,000 + nozzle 5,000 = 455,000, sold at 400,000.
  assert.equal(card.display_price_iqd, 400_000);
  assert.equal(card.composition.component_total_iqd, 455_000);
  assert.equal(card.composition.saving_percent, 12);
  // printer 5 / 1, PLA 6 / 2 = 3, nozzle 20 / 1 → 3 bundles, which is `low`.
  assert.equal(card.availability_state, 'low');
  assert.equal(card.composition.availability_state, 'low');
  assert.deepEqual(card.offer, { offer_id: null, required_tiers: [], starts_at: null, ends_at: null });

  // Up to three main items — a name and a thumbnail, nothing else (§14).
  assert.equal(card.composition.main_items.length, 3);
  assert.deepEqual(
    card.composition.main_items.map((m: { name: string; qty: number }) => [m.name, m.qty]),
    [['Printer X1', 1], ['PLA Basic', 2], ['Nozzle 0.4', 1]]
  );
});

test('the listing leaks no count, no component list, no pool and no weight — asserted on the serialized JSON', async () => {
  const raw = seed();
  addBundle(raw, { id: 'b1', slug: 'starter' });
  const res = await get(appFor(new SqliteD1(raw) as unknown as D1Database, null), '/api/bundles');
  const body = await json(res);
  const wire = JSON.stringify(body);

  for (const forbidden of [
    'max_bundles',
    'blocking',
    'components', // the full list belongs to the detail, never a card
    'available',
    'reserved',
    'on_hand',
    'stock_reserved',
    'low_stock_threshold',
    'weight',
    'pool',
    'entries',
    'cost_iqd',
    'product_cost_iqd',
    'draw_salt',
    'seed',
  ]) {
    assert.equal(wire.includes(forbidden), false, `the listing payload contains "${forbidden}"`);
  }
  // The member stock numbers themselves, which no card may imply.
  const card = JSON.stringify(body.bundles[0].composition);
  for (const n of [':5', ':6', ':20', ':3']) {
    assert.equal(card.includes(n), false, `a raw availability count (${n}) reached the composition block`);
  }
});

// ------------------------------------------------------------ eligibility §9

test('an ungated bundle is public: a signed-out visitor and a free account both see it and can open it', async () => {
  const raw = seed();
  addBundle(raw, { id: 'b1', slug: 'starter', window: { required_tiers: '[]' } });
  const db = new SqliteD1(raw) as unknown as D1Database;

  for (const user of [null, FREE]) {
    const list = await json(await get(appFor(db, user), '/api/bundles'));
    assert.equal(list.bundles.length, 1, 'an ungated bundle disappeared for a viewer who may buy it');
    assert.equal(list.bundles[0].locked, false);
    assert.equal(typeof list.bundles[0].display_price_iqd, 'number');

    const detail = await get(appFor(db, user), '/api/bundles/starter');
    assert.equal(detail.status, 200);
    const body = await json(detail);
    assert.equal(body.bundle.locked, false);
    assert.equal(body.bundle.composition.components.length, 3);
  }
});

test('a gated bundle locks with a 200 and the §9 ALLOW-LIST — the stripped key list is what is asserted', async () => {
  const raw = seed();
  addBundle(raw, {
    id: 'b1',
    slug: 'plus-only',
    priceIqd: 400_000,
    window: { required_tiers: '["plus"]', ends_at: FUTURE },
  });
  const db = new SqliteD1(raw) as unknown as D1Database;

  const res = await get(appFor(db, FREE), '/api/bundles');
  assert.equal(res.status, 200, 'a locked card must be a 200, never a 403');
  const body = await json(res);
  assert.equal(body.entitled, false);
  const card = body.bundles[0];

  assert.deepEqual(
    Object.keys(card).sort(),
    ['availability_state', 'display_regular_iqd', 'id', 'image', 'locked', 'name', 'name_ar', 'name_ku', 'offer', 'product_slug']
  );
  assert.equal(card.locked, true);
  assert.equal(card.availability_state, 'locked');
  assert.deepEqual(card.offer.required_tiers, ['plus']);

  for (const stripped of [
    'display_price_iqd',
    'display_prime_iqd',
    'display_pro_iqd',
    'display_applied_tier',
    'display_from',
    'composition',
    'saving_percent',
    'component_total_iqd',
    'main_items',
    'max_qty',
    'max_bundles',
  ]) {
    assert.equal(stripped in card, false, `the locked card still carries "${stripped}"`);
  }
  assert.equal(JSON.stringify(card).includes('455000'), false, 'the component total reached a locked viewer');

  // The detail page locks identically — no components, no counts, no prices
  // the caller cannot pay.
  const detail = await json(await get(appFor(db, FREE), '/api/bundles/plus-only'));
  assert.equal(detail.bundle.locked, true);
  assert.equal('composition' in detail.bundle, false);
  assert.equal('availability' in detail.bundle, false);
});

/**
 * §9's LOCKED ALLOW-LIST IS A PROPERTY OF THE SUBJECT, NOT OF ONE ROUTE.
 *
 * `GET /api/bundles/:slug` stripped the member rungs correctly while
 * `GET /api/products?type=bundle`, the search branch and
 * `POST /api/products/:slug/quote` served the same gated row's full price
 * ladder — `price_iqd`, `display_price_iqd`, `display_prime_iqd`,
 * `display_pro_iqd` — to a viewer who cannot buy it. §9 names the last two
 * explicitly: "never the member price a non-member cannot get". So the
 * stripped-key assertion is made against every door, not one.
 */
test('§15.4 case 9: the product listing, search and quote strip the same keys as the bundles route', async () => {
  const raw = seed();
  addBundle(raw, {
    id: 'b1',
    slug: 'plus-only',
    priceIqd: 400_000,
    primeIqd: 380_000,
    window: { required_tiers: '["plus"]', ends_at: FUTURE },
  });
  const db = new SqliteD1(raw) as unknown as D1Database;
  const app = appFor(db, FREE);

  const STRIPPED = [
    'price_iqd',
    'prime_price_iqd',
    'pro_price_iqd',
    'display_price_iqd',
    'display_prime_iqd',
    'display_pro_iqd',
    'display_applied_tier',
    'composition',
  ];

  for (const path of ['/api/products?type=bundle', '/api/products?search=Starter']) {
    const body = await json(await get(app, path));
    assert.equal(body.success, true, `${path}: ${JSON.stringify(body).slice(0, 200)}`);
    const card = (body.products as Array<Record<string, unknown>>).find((p) => p.product_slug === 'plus-only' || p.slug === 'plus-only');
    assert.ok(card, `${path} did not return the gated bundle at all`);
    assert.equal(card.locked, true, `${path} served the gated bundle unlocked`);
    for (const key of STRIPPED) {
      assert.equal(key in card, false, `${path} still carries "${key}" for a viewer who may not buy it`);
    }
    assert.equal(JSON.stringify(card).includes('380000'), false, `${path} published the PRIME price to a free account`);
  }

  // The quote is a door too: it re-checks eligibility and answers with the
  // lock rather than a price (§6.1).
  const quote = await json(await post(app, '/api/products/plus-only/quote', { qty: 1 }));
  assert.equal(quote.success, true, JSON.stringify(quote).slice(0, 200));
  assert.equal(quote.quote, null, 'the quote priced a bundle the viewer may not buy');
  assert.equal(quote.product.locked, true);
  for (const key of STRIPPED) {
    assert.equal(key in quote.product, false, `the quote still carries "${key}"`);
  }
  assert.equal(JSON.stringify(quote).includes('380000'), false);
});

test('an ENTITLED viewer still gets a real composition quote from the product quote door', async () => {
  const raw = seed();
  addBundle(raw, {
    id: 'b1',
    slug: 'plus-only',
    priceIqd: 400_000,
    window: { required_tiers: '["plus"]', ends_at: FUTURE },
  });
  const db = new SqliteD1(raw) as unknown as D1Database;
  const quote = await json(await post(appFor(db, PLUS), '/api/products/plus-only/quote', { qty: 2 }));
  assert.equal(quote.success, true, JSON.stringify(quote).slice(0, 300));
  assert.equal(quote.product.locked, false);
  assert.equal(quote.quote.applied_iqd, 400_000);
  assert.equal(quote.quote.line_total_iqd, 800_000);
  assert.equal(quote.quote.component_total_iqd, 455_000, 'the composition figures come from the same pass the card used');
  // And it draws nothing and reserves nothing (§7.4).
  assert.equal(
    (raw.prepare('SELECT COUNT(*) AS n FROM inventory_ledger').get() as { n: number }).n,
    0
  );
});

/**
 * §8.2 ROW 13 AND §10: A MYSTERY OFFER REPORTS A STATE, NEVER A COUNT.
 *
 * `publicAvailability` correctly drops every count from the `composition`
 * block, but the `availability` block beside it published
 * `{ on_hand: 18, available: 18 }` — `floor(Σ eligible available ÷ spool_qty)`,
 * the live sellable supply of the whole pool — to an anonymous caller, with
 * `Cache-Control: public, max-age=60`, moving with every mystery purchase.
 * `max_qty` stays, because §10 requires it so the stepper disables at the
 * limit, and it is clamped by `bundle_config.max_qty_per_order`.
 */
test('§8.2 row 13: the mystery detail publishes no pool supply count', async () => {
  const raw = seed();
  seedMysteryPool(raw);
  addMysteryOffer(raw, { spoolQty: 2, maxQtyPerOrder: 5 });
  const db = new SqliteD1(raw) as unknown as D1Database;

  for (const path of ['/api/bundles/mystery-box', '/api/products/mystery-box']) {
    const body = await json(await get(appFor(db, null), path));
    assert.equal(body.success, true, `${path}: ${JSON.stringify(body).slice(0, 200)}`);
    const card = (body.bundle ?? body.product) as Record<string, Record<string, unknown>>;
    const stock = card.availability.stock as Record<string, unknown>;
    assert.equal(stock.on_hand, null, `${path} published the pool's on-hand supply`);
    assert.equal(stock.available, null, `${path} published the pool's sellable supply`);
    assert.equal(stock.reserved, 0);
    assert.equal(stock.max_qty, 5, 'the per-order cap survives, so the stepper still disables at the limit');
    assert.equal(JSON.stringify(card.availability).includes('18'), false, 'a pool count reached the payload');
  }
});

test('a locked card carries a price teaser ONLY when locked_preview is on', async () => {
  const raw = seed();
  addBundle(raw, { id: 'b1', slug: 'plus-only', window: { required_tiers: '["plus"]', locked_preview: 0 } });
  const body = await json(await get(appFor(new SqliteD1(raw) as unknown as D1Database, FREE), '/api/bundles'));
  assert.equal('display_regular_iqd' in body.bundles[0], false);
  assert.equal(body.bundles[0].locked, true);
});

test('PREMIUM inherits a PLUS gate — the same verdict on card and detail', async () => {
  const raw = seed();
  addBundle(raw, { id: 'b1', slug: 'plus-only', window: { required_tiers: '["plus"]' } });
  const db = new SqliteD1(raw) as unknown as D1Database;

  const prime = await json(await get(appFor(db, PRIME), '/api/bundles'));
  assert.equal(prime.bundles[0].locked, false, 'PREMIUM did not inherit the PLUS offer');
  const primeDetail = await json(await get(appFor(db, PRIME), '/api/bundles/plus-only'));
  assert.equal(primeDetail.bundle.locked, false, 'the card and the detail page disagreed about PREMIUM');

  const plus = await json(await get(appFor(db, PLUS), '/api/bundles'));
  assert.equal(plus.bundles[0].locked, false);
  assert.equal(plus.entitled, true);
});

// ------------------------------------------------------------------ pricing

test('a PLUS member sees the PLUS rung on the card and the same number on the detail', async () => {
  const raw = seed();
  addBundle(raw, { id: 'b1', slug: 'starter', priceIqd: 400_000, config: { plus_price_iqd: 360_000 } });
  const db = new SqliteD1(raw) as unknown as D1Database;

  const free = await json(await get(appFor(db, FREE), '/api/bundles'));
  assert.equal(free.bundles[0].display_price_iqd, 400_000);
  assert.equal(free.bundles[0].display_applied_tier, 'regular');

  const plus = await json(await get(appFor(db, PLUS), '/api/bundles'));
  assert.equal(plus.bundles[0].display_price_iqd, 360_000);
  assert.equal(plus.bundles[0].display_applied_tier, 'plus');
  assert.equal(plus.bundles[0].display_regular_iqd, 400_000);

  const detail = await json(await get(appFor(db, PLUS), '/api/bundles/starter'));
  assert.equal(
    detail.bundle.display_price_iqd,
    plus.bundles[0].display_price_iqd,
    'the card and the page quoted a PLUS member two different prices'
  );
});

test('a derived-mode bundle serves the FRESHLY derived price, not the cached products.price_iqd', async () => {
  const raw = seed();
  // The cached row price is deliberately stale: the admin save wrote 999,999.
  addBundle(raw, {
    id: 'b1',
    slug: 'ten-off',
    priceIqd: 999_999,
    config: { price_mode: 'discount_percent', discount_percent: 10 },
  });
  const db = new SqliteD1(raw) as unknown as D1Database;

  const card = (await json(await get(appFor(db, null), '/api/bundles'))).bundles[0];
  assert.equal(card.display_price_iqd, Math.floor((455_000 * 90) / 100));
  assert.equal(card.display_regular_iqd, card.display_price_iqd);
  assert.notEqual(card.display_price_iqd, 999_999);
  assert.equal(card.composition.saving_percent, 10);

  // A component gets cheaper: the next read follows it, with no admin action.
  raw.prepare('UPDATE products SET price_iqd = ? WHERE id = ?').run(10_000, 'p_pla');
  const after = (await json(await get(appFor(db, null), '/api/bundles'))).bundles[0];
  assert.equal(after.composition.component_total_iqd, 425_000);
  assert.equal(after.display_price_iqd, Math.floor((425_000 * 90) / 100));
});

test('a derived price below its floor does not clamp and does not sell', async () => {
  const raw = seed();
  addBundle(raw, {
    id: 'b1',
    slug: 'free-bundle',
    config: { price_mode: 'discount_iqd', discount_iqd: 500_000, min_price_iqd: 1000 },
  });
  const card = (await json(await get(appFor(new SqliteD1(raw) as unknown as D1Database, null), '/api/bundles'))).bundles[0];
  assert.equal(card.availability_state, 'ended', 'a bundle whose derived price fell through the floor was still on sale');
});

// ------------------------------------------------------------- availability

test('the coarse state follows the scarcest component, and a dead component sells nothing', async () => {
  const raw = seed();
  addBundle(raw, { id: 'b1', slug: 'starter' });
  const db = new SqliteD1(raw) as unknown as D1Database;

  raw.prepare('UPDATE products SET stock = 40 WHERE id IN (?,?,?)').run('p_printer', 'p_pla', 'p_nozzle');
  assert.equal((await json(await get(appFor(db, null), '/api/bundles'))).bundles[0].availability_state, 'in_stock');

  raw.prepare('UPDATE products SET stock = 1 WHERE id = ?').run('p_pla');
  assert.equal((await json(await get(appFor(db, null), '/api/bundles'))).bundles[0].availability_state, 'sold_out');

  // A member that went draft cannot be packed, whatever its stock row says.
  raw.prepare('UPDATE products SET stock = 40 WHERE id = ?').run('p_pla');
  raw.prepare("UPDATE products SET status = 'draft' WHERE id = ?").run('p_nozzle');
  assert.equal((await json(await get(appFor(db, null), '/api/bundles'))).bundles[0].availability_state, 'sold_out');
});

test('the detail exposes max_qty for the stepper and never a raw component count', async () => {
  const raw = seed();
  addBundle(raw, { id: 'b1', slug: 'starter', config: { max_qty_per_order: 9 } });
  const body = await json(await get(appFor(new SqliteD1(raw) as unknown as D1Database, null), '/api/bundles/starter'));
  // min(max_bundles 3, max_qty_per_order 9, ceiling 99)
  assert.equal(body.bundle.composition.max_qty, 3);
  assert.equal(body.bundle.availability.stock.max_qty, 3);
  assert.equal(body.bundle.availability.stock.scope, 'composition');
  for (const c of body.bundle.composition.components) {
    assert.equal('available' in c, false);
    assert.equal('reserved' in c, false);
    assert.ok(['in_stock', 'low', 'sold_out', 'preorder'].includes(c.state));
  }
});

test('an upcoming and an ended window produce their own card states, with the schedule but no price change', async () => {
  const raw = seed();
  addBundle(raw, { id: 'b_up', slug: 'soon', window: { starts_at: FUTURE } });
  addBundle(raw, { id: 'b_gone', slug: 'gone', window: { ends_at: '2020-01-01T00:00:00.000Z' } });
  const body = await json(await get(appFor(new SqliteD1(raw) as unknown as D1Database, null), '/api/bundles'));
  const by = new Map(body.bundles.map((b: { product_slug: string }) => [b.product_slug, b]));
  assert.equal((by.get('soon') as { availability_state: string }).availability_state, 'upcoming');
  assert.equal((by.get('gone') as { availability_state: string }).availability_state, 'ended');
  assert.equal((by.get('soon') as { offer: { starts_at: string } }).offer.starts_at, FUTURE);
});

// ----------------------------------------------------------------- filtering

test('kind, search, category, family and featured all filter the listing', async () => {
  const raw = seed();
  addBundle(raw, { id: 'b1', slug: 'starter', name: 'Starter Bundle', featured: true, family: 'printers' });
  addBundle(raw, { id: 'b2', slug: 'pro-kit', name: 'Pro Kit' });
  const db = new SqliteD1(raw) as unknown as D1Database;
  const slugs = async (qs: string) =>
    (await json(await get(appFor(db, null), `/api/bundles${qs}`))).bundles.map((b: { product_slug: string }) => b.product_slug);

  assert.deepEqual((await slugs('')).sort(), ['pro-kit', 'starter']);
  assert.deepEqual(await slugs('?featured=1'), ['starter']);
  assert.deepEqual(await slugs('?family=printers'), ['starter']);
  assert.deepEqual(await slugs('?search=Pro%20Kit'), ['pro-kit']);
  assert.deepEqual(await slugs('?kind=mystery'), []);
  assert.deepEqual((await slugs('?kind=bundle')).sort(), ['pro-kit', 'starter']);
});

test('a composition row with no components is not advertised at all', async () => {
  const raw = seed();
  addBundle(raw, { id: 'b1', slug: 'empty', components: [] });
  const body = await json(await get(appFor(new SqliteD1(raw) as unknown as D1Database, null), '/api/bundles'));
  assert.deepEqual(body.bundles, []);
});

// ---------------------------------------------------- the product endpoints

test('the default product listing hides bundles, type=bundle shows them, and search still finds them', async () => {
  const raw = seed();
  addBundle(raw, { id: 'b1', slug: 'starter', name: 'Starter Bundle' });
  const db = new SqliteD1(raw) as unknown as D1Database;
  const ids = async (qs: string) =>
    (await json(await get(appFor(db, null), `/api/products${qs}`))).products.map((p: { id: string }) => p.id);

  assert.equal((await ids('')).includes('b1'), false, 'a bundle appeared as an ordinary product with no stock');
  assert.ok((await ids('')).includes('p_printer'));
  assert.ok((await ids('?type=bundle')).includes('b1'));
  assert.ok((await ids('?search=Starter')).includes('b1'), 'search stopped finding bundles');
});

test('an old /product/<slug> link to a bundle answers with the bundle payload and its canonical location', async () => {
  const raw = seed();
  addBundle(raw, { id: 'b1', slug: 'starter' });
  const res = await get(appFor(new SqliteD1(raw) as unknown as D1Database, null), '/api/products/starter');
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.redirect, '/bundles/starter');
  assert.equal(body.bundle.product_slug, 'starter');
  assert.equal(body.bundle.composition.components.length, 3);
  // The ordinary product shape's own stock claim never appears for a bundle.
  assert.equal(body.bundle.availability.stock.scope, 'composition');
});

test('an unknown bundle slug is a 404, not an empty 200', async () => {
  const raw = seed();
  const res = await get(appFor(new SqliteD1(raw) as unknown as D1Database, null), '/api/bundles/nope');
  assert.equal(res.status, 404);
});

// -------------------------------------------------------------- the caching

test('a request carrying a session cookie is never publicly cacheable; the anonymous variant varies on Cookie', async () => {
  const raw = seed();
  addBundle(raw, { id: 'b1', slug: 'starter' });
  const db = new SqliteD1(raw) as unknown as D1Database;

  const anon = await get(appFor(db, null), '/api/bundles');
  assert.equal(anon.headers.get('Cache-Control'), 'public, max-age=60');
  assert.equal(anon.headers.get('Vary'), 'Cookie');

  for (const path of ['/api/bundles', '/api/bundles/starter']) {
    const withCookie = await get(appFor(db, PLUS), path, { Cookie: 'levonis_session=abc123' });
    assert.equal(
      (withCookie.headers.get('Cache-Control') ?? '').includes('public'),
      false,
      `${path} offered a shared cache entry to a request carrying a session cookie`
    );
    assert.equal(withCookie.headers.get('Cache-Control'), 'private, no-store');
  }

  // Even an EXPIRED cookie that resolves to no user must not be cached: the
  // body was still computed for a request that carried one.
  const stale = await get(appFor(db, null), '/api/bundles', { Cookie: 'levonis_session=expired' });
  assert.equal(stale.headers.get('Cache-Control'), 'private, no-store');
});

// ------------------------------------------------------------- the four reads

test('one page of 24 bundles costs the same four composition reads as a page of two', async () => {
  const measure = async (count: number) => {
    const raw = seed();
    for (let i = 0; i < count; i += 1) addBundle(raw, { id: `b${i}`, slug: `bundle-${i}` });
    const counting = new CountingD1(new SqliteD1(raw));
    const res = await get(appFor(counting as unknown as D1Database, null), '/api/bundles?limit=48');
    assert.equal((await json(res)).bundles.length, count);
    return counting.sql;
  };

  const small = await measure(2);
  const page = await measure(24);

  // §14's four: the composition products (with config and window joined on),
  // the components with their allow-lists, the member products, and ONE
  // relations pass over those members.
  const composition = (sql: string[]) => ({
    products: sql.filter((s) => /FROM products/i.test(s)).length,
    components: sql.filter((s) => /FROM bundle_components/i.test(s)).length,
    choices: sql.filter((s) => /FROM bundle_component_choices/i.test(s)).length,
    windows: sql.filter((s) => /FROM offer_windows/i.test(s)).length,
    config: sql.filter((s) => /FROM bundle_config/i.test(s)).length,
  });
  const seen = composition(page);
  assert.equal(seen.products, 2, 'the page read products more than twice — that is an N+1');
  assert.equal(seen.components, 1);
  assert.equal(seen.choices, 0, 'the allow-lists cost a second round trip');
  assert.equal(seen.windows, 0, 'the offer windows were read separately instead of joined');
  assert.equal(seen.config, 0, 'bundle_config was read separately instead of joined');

  assert.equal(
    page.length,
    small.length,
    `24 bundles cost ${page.length} statements and 2 cost ${small.length} — the read grows with the page:\n${page.join('\n')}`
  );
});
