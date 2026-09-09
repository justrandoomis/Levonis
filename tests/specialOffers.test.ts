/**
 * SPECIAL OFFERS ON AN ORDINARY PRODUCT — docs/BUNDLES_MYSTERY.md §9, §10, §12.
 *
 * THE DIVIDEND, ASSERTED. A scheduled, tier-gated, limited AND discounted
 * offer on an ordinary catalogue product uses `offer_windows` + `offer_limits`
 * and NOTHING ELSE: no new table, no second discount code path, no second
 * eligibility rule and no second price resolver. That is the strongest
 * consequence of having put bundles in `products`, and it is worth a test of
 * its own because it is the kind of claim that quietly becomes false the first
 * time someone adds a `product_discounts` table.
 *
 * THE PROPERTY THAT MATTERS IS AGREEMENT. The card, the cart line and the door
 * must quote the SAME number, and the number must move together with the
 * schedule. A page that shows a discount the checkout does not honour is worse
 * than no discount at all, so every assertion here is a three-way comparison
 * rather than a check that one surface looks right.
 *
 * AND THE GATE MUST GATE THE PRICE, NOT ONLY THE PURCHASE. Showing an
 * ineligible viewer the members-only offer price and then refusing them at the
 * door is exactly the page/cart/door disagreement §15.4 case 9 exists to
 * prevent — so an ineligible viewer sees the LADDER price on the card.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, stubApp, post, get, json, all, count, row, type StubUser } from './fixtures/app';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';
import { productRoutes } from '../worker/routes/products';
import { adminOffersRoutes } from '../worker/routes/offers';
import { seedCatalogue, orderBody, FUTURE, PAST } from './lib/bundles';

const buyer: StubUser = { id: 'buyer', role: 'customer', email: 's@x.co' };
const plusUser: StubUser = { id: 'u_plus', role: 'customer', email: 'z@x.co' };
const proUser: StubUser = { id: 'u_pro', role: 'customer', email: 'r@x.co' };
const primeUser: StubUser = { id: 'u_prime', role: 'customer', email: 'n@x.co' };
const boss: StubUser = { id: 'boss', role: 'admin', email: 'a@x.co' };

const appFor = (db: unknown, user: StubUser | null = buyer, host?: string) =>
  stubApp(
    db,
    user,
    (a) => {
      a.route('/api/cart', cartRoutes);
      a.route('/api/orders', orderRoutes);
      a.route('/api/products', productRoutes);
      a.route('/api/admin/offers', adminOffersRoutes);
    },
    host ? { host } : {}
  );

/** `p_pla` — an ORDINARY catalogue product, 25 000 IQD, six in stock. */
const SUBJECT = 'p_pla';
const LADDER = 25000;

function window_(raw: DatabaseSync, over: Record<string, unknown> = {}): void {
  const w = {
    starts_at: null,
    ends_at: null,
    required_tiers: '[]',
    offer_price_mode: 'discount_percent',
    offer_price_iqd: null,
    discount_percent: 20,
    discount_iqd: null,
    plus_price_iqd: null,
    locked_preview: 1,
    active: 1,
    ...over,
  };
  raw
    .prepare(
      `INSERT INTO offer_windows (subject_type,subject_id,id,starts_at,ends_at,required_tiers,
                                  offer_price_mode,offer_price_iqd,discount_percent,discount_iqd,
                                  plus_price_iqd,locked_preview,active)
       VALUES ('product',?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      SUBJECT,
      'ofw_pla',
      w.starts_at,
      w.ends_at,
      w.required_tiers,
      w.offer_price_mode,
      w.offer_price_iqd,
      w.discount_percent,
      w.discount_iqd,
      w.plus_price_iqd,
      w.locked_preview,
      w.active
    );
}

const cardPrice = async (db: unknown, user: StubUser | null) =>
  (await json(await get(appFor(db, user), `/api/products/pla`))).product.display_price_iqd as number;

const cartPrice = async (db: unknown, user: StubUser) => {
  const app = appFor(db, user);
  await post(app, '/api/cart/items', { productId: SUBJECT, qty: 1 });
  const cart = await json(await get(app, '/api/cart'));
  return cart.items[0].unit_price_iqd as number;
};

// -------------------------------------------------------------- the price

test('a live window prices the card, the cart and the door with ONE number', async () => {
  const raw = seedCatalogue();
  window_(raw, { discount_percent: 20 });
  const db = asD1(raw);
  const expected = Math.floor((LADDER * 80) / 100); // 20 000

  assert.equal(await cardPrice(db, buyer), expected, 'the card did not quote the offer price');
  assert.equal(await cartPrice(db, buyer), expected, 'the cart did not quote the offer price');

  const placed = await json(await post(appFor(db), '/api/orders', orderBody()));
  assert.equal(placed.success, true, JSON.stringify(placed).slice(0, 300));
  const item = all<Record<string, unknown>>(raw, 'SELECT * FROM order_items WHERE order_id = ?', String(placed.order.id))[0];
  assert.equal(Number(item.unit_price_iqd), expected, 'the door charged the ladder price');
  assert.equal(Number(placed.order.subtotal_iqd), expected);

  // §12: WHICH OFFER produced this price is frozen with its figures, so the
  // question is answerable years later even after the window is edited away.
  const snap = JSON.parse(String(item.pricing_snapshot)) as { offer?: Record<string, unknown> };
  assert.ok(snap.offer, 'the order snapshot does not name the offer that priced it');
  assert.equal(snap.offer.offer_id, 'ofw_pla');
  assert.equal(snap.offer.offer_applied_iqd, expected);
  assert.equal(snap.offer.offer_discount_percent, 20);
  raw.prepare("DELETE FROM offer_windows WHERE subject_id = ?").run(SUBJECT);
  const after = JSON.parse(
    String(row<{ v: string }>(raw, 'SELECT pricing_snapshot AS v FROM order_items WHERE id = ?', String(item.id))!.v)
  ) as { offer?: { offer_id?: string } };
  assert.equal(after.offer!.offer_id, 'ofw_pla', 'the snapshot moved when the window was deleted');
});

test('an upcoming or ended window changes no price at all', async () => {
  for (const [label, over] of [
    ['upcoming', { starts_at: FUTURE }],
    ['ended', { ends_at: PAST }],
    ['switched off', { active: 0 }],
  ] as const) {
    const raw = seedCatalogue();
    window_(raw, over);
    const db = asD1(raw);
    assert.equal(await cardPrice(db, buyer), LADDER, `a ${label} window moved the card price`);
    assert.equal(await cartPrice(db, buyer), LADDER, `a ${label} window moved the cart price`);
  }
});

test('a fixed offer price and an amount-off price both replace the ladder', async () => {
  for (const [over, expected] of [
    [{ offer_price_mode: 'fixed', offer_price_iqd: 19000, discount_percent: null }, 19000],
    [{ offer_price_mode: 'discount_iqd', discount_iqd: 4000, discount_percent: null }, LADDER - 4000],
  ] as const) {
    const raw = seedCatalogue();
    window_(raw, over as Record<string, unknown>);
    const db = asD1(raw);
    assert.equal(await cardPrice(db, buyer), expected);
    assert.equal(await cartPrice(db, buyer), expected);
  }
});

test('a pure schedule with no price is a countdown and nothing else', async () => {
  const raw = seedCatalogue();
  window_(raw, { offer_price_mode: '', discount_percent: null, ends_at: FUTURE });
  const db = asD1(raw);
  assert.equal(await cardPrice(db, buyer), LADDER);
  const card = await json(await get(appFor(db, buyer), '/api/products/pla'));
  assert.equal(card.product.offer.schedule_state, 'live');
  assert.equal(card.product.offer.ends_at, FUTURE);
  assert.equal(card.product.offer.price_source, 'ladder');
});

// --------------------------------------------------------------- the gate

test('the gate decides the PRICE as well as the purchase, and PRO inherits PLUS', async () => {
  const raw = seedCatalogue();
  window_(raw, { required_tiers: '["plus"]', discount_percent: 20 });
  const db = asD1(raw);
  const offerPrice = 20000;

  // An ungated viewer is not offered the members-only price on the card…
  assert.equal(await cardPrice(db, buyer), LADDER);
  assert.equal(await cardPrice(db, null), LADDER, 'a signed-out visitor was shown a members-only price');
  // …and is refused at the door with the named code, not a silent fallback.
  const refused = await json(await post(appFor(db, buyer), '/api/cart/items', { productId: SUBJECT, qty: 1 }));
  assert.equal(refused.success, false);
  assert.equal(refused.code, 'MEMBERSHIP_REQUIRED');

  // PLUS gets it; PRO inherits PLUS; PRIME is a delivery tier and does NOT.
  assert.equal(await cardPrice(db, plusUser), offerPrice);
  assert.equal(await cardPrice(db, proUser), offerPrice);
  assert.equal(await cardPrice(db, primeUser), LADDER, 'PRIME was handed a PLUS-exclusive price');
  assert.equal(
    (await json(await post(appFor(db, primeUser), '/api/cart/items', { productId: SUBJECT, qty: 1 }))).code,
    'MEMBERSHIP_REQUIRED'
  );

  // And the member's own cart charges the same number the card showed.
  assert.equal(await cartPrice(db, plusUser), offerPrice);
});

test('an UNGATED window is public — guests and free accounts buy it', async () => {
  const raw = seedCatalogue();
  window_(raw, { required_tiers: '[]', discount_percent: 10 });
  const db = asD1(raw);
  const expected = Math.floor((LADDER * 90) / 100);
  assert.equal(await cardPrice(db, null), expected, 'attaching a window made an ordinary product subscriber-only');
  assert.equal(await cardPrice(db, buyer), expected);
  const placed = await json(await post(appFor(db), '/api/orders', orderBody({ itemIds: [] })));
  // The cart is empty until something is added; add first, then buy.
  if (!placed.success) {
    await post(appFor(db), '/api/cart/items', { productId: SUBJECT, qty: 1 });
    const second = await json(await post(appFor(db), '/api/orders', orderBody()));
    assert.equal(second.success, true, JSON.stringify(second).slice(0, 300));
  }
});

// ------------------------------------------------------------- the limits

test('offer_limits works on an ordinary product with no new machinery', async () => {
  const raw = seedCatalogue();
  window_(raw, { offer_price_mode: '', discount_percent: null });
  raw
    .prepare("INSERT INTO offer_limits (subject_type,subject_id,max_per_user,max_global) VALUES ('product',?,1,NULL)")
    .run(SUBJECT);
  const db = asD1(raw);

  const app = appFor(db);
  await post(app, '/api/cart/items', { productId: SUBJECT, qty: 1 });
  const first = await json(await post(app, '/api/orders', orderBody()));
  assert.equal(first.success, true, JSON.stringify(first).slice(0, 300));
  // ONE redemption row per (subject, order) — the same row a bundle writes.
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM offer_redemptions WHERE subject_id = ?', SUBJECT), 1);

  await post(app, '/api/cart/items', { productId: SUBJECT, qty: 1 });
  const second = await json(await post(app, '/api/orders', orderBody()));
  assert.equal(second.success, false, 'the per-user limit did not bite');
  assert.equal(second.code, 'PER_USER_LIMIT_REACHED');
  // The trigger is the DECISION and it aborts the whole batch: no second order.
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM orders'), 1);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM offer_redemptions WHERE subject_id = ?', SUBJECT), 1);
});

test('no second discount table exists: the whole feature is offer_windows + offer_limits', () => {
  const raw = seedCatalogue();
  const tables = all<{ name: string }>(
    raw,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
  ).map((t) => t.name);
  for (const invented of ['product_discounts', 'product_offers', 'special_offers', 'discount_rules', 'promotions']) {
    assert.ok(!tables.includes(invented), `a second promotion mechanism appeared: ${invented}`);
  }
  assert.ok(tables.includes('offer_windows'));
  assert.ok(tables.includes('offer_limits'));
  assert.ok(tables.includes('offer_redemptions'));
});

// -------------------------------------------------------------- the panel

test('the offers panel refuses the two dishonest configurations, verbatim', async () => {
  const raw = seedCatalogue();
  // A derived-price BUNDLE cannot also carry a window price: two live sources
  // on one subject, never summed and never resolved by whichever ran first.
  raw
    .prepare(
      "INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images,inventory_mode,composition) VALUES ('p_derived','derived','D','د',0,'active',NULL,'[]','[]','bundle','[\"bundle\"]','[]','[]','BASE','bundle')"
    )
    .run();
  raw
    .prepare(
      "INSERT INTO bundle_config (product_id, price_mode, discount_percent, min_price_iqd) VALUES ('p_derived','discount_percent',15,1)"
    )
    .run();
  const db = asD1(raw);
  const admin = appFor(db, boss);

  const conflict = await json(
    await stubApp(db, boss, (a) => a.route('/api/admin/offers', adminOffersRoutes)).request('/api/admin/offers/p_derived', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ offer_price_mode: 'fixed', offer_price_iqd: 1000 }),
    })
  );
  assert.equal(conflict.success, false);
  assert.equal(conflict.code, 'OFFER_PRICE_CONFLICT');
  // Trilingual and with a `message`, so both existing admin decoders render it
  // rather than printing the literal string "undefined" (§11.3).
  const issue = conflict.details.errors[0];
  for (const k of ['code', 'message', 'ar', 'en', 'ckb']) {
    assert.equal(typeof issue[k], 'string', `the refusal has no ${k}`);
    assert.ok(issue[k].length > 0);
  }
  assert.ok(!JSON.stringify(conflict).includes('undefined'));

  const inverted = await json(
    await post(admin, '/api/admin/offers', {
      subject_id: SUBJECT,
      starts_at: FUTURE,
      ends_at: PAST,
    })
  );
  assert.equal(inverted.code, 'SCHEDULE_INVERTED');
});

test('the panel writes its audit row INSIDE the batch, and is admin-only', async () => {
  const raw = seedCatalogue();
  const db = asD1(raw);
  const before = count(raw, 'SELECT COUNT(*) AS n FROM audit_log');
  const saved = await json(
    await stubApp(db, boss, (a) => a.route('/api/admin/offers', adminOffersRoutes)).request(
      `/api/admin/offers/${SUBJECT}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ required_tiers: ['plus'], offer_price_mode: 'discount_percent', discount_percent: 25 }),
      }
    )
  );
  assert.equal(saved.success, true, JSON.stringify(saved).slice(0, 300));
  assert.equal(saved.offer.discount_percent, 25);
  assert.deepEqual(saved.offer.required_tiers, ['plus']);
  assert.ok(count(raw, 'SELECT COUNT(*) AS n FROM audit_log') > before, 'a tier-gate change went unaudited');
  // The warning about gating an ordinary product survives a successful save.
  assert.ok(saved.warnings.some((w: { code: string }) => w.code === 'OFFER_GATES_ORDINARY_PRODUCT'));

  // And the router carries its OWN requireAdmin: requireMainHost is a host
  // check and would let any signed-in customer straight in.
  assert.equal((await get(appFor(db, buyer), `/api/admin/offers/${SUBJECT}`)).status, 403);
  assert.equal(
    (await get(appFor(db, boss, 'somestore.levonis-iq.com'), `/api/admin/offers/${SUBJECT}`)).status,
    404,
    'the offers panel is reachable from a merchant subdomain'
  );
});
