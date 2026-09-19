/**
 * THE RANDOM FILAMENT IS PUBLIC, AND IT HAS A COST — the two owner rulings of
 * this track, asserted against the real routers on a real migrated database.
 *
 *   «الباقات والفيلم العشوائي الذي قلنا عليه سابقا انه خاص بالعضوية اجعله الان
 *    عام لكل المستخدمين لا تجعله خاصا»
 *
 *   «عندما يشتري المستخدم الفيلمنت الهدية فإن النظام سوف يسحب مخزونا من منتج
 *    فعلي ويعتبر كمُباع … يعني له تكلفة»
 *
 * WHY THIS SUITE EXISTS BESIDE `bundlesMysteryIntegration.test.ts` RATHER THAN
 * INSIDE IT. That file proves the mandate as it was BUILT; this one proves the
 * two things the owner CHANGED afterwards, and the second of them —
 * a cost on a mystery spool — is a number that did not exist at all before
 * migration 0096. The two claims share one journey because they are the same
 * journey: an offer nobody is gated out of, bought by somebody who holds no
 * membership, whose filament leaves the shelf and therefore costs money.
 *
 * THE THREE THINGS THAT WOULD BE CATASTROPHIC AND ARE THEREFORE ASSERTED
 * DIRECTLY, not inferred:
 *
 *   1. A NON-MEMBER CAN BUY. Not "the card is not locked" — the order is
 *      actually placed, because the card, the cart and the checkout door each
 *      re-ask the eligibility question independently and any one of them can
 *      refuse.
 *   2. THE COST NEVER REACHES THE CUSTOMER. A cost is a fingerprint: the pool
 *      here is priced so that every candidate's cost is a DISTINCT, unusual
 *      integer, so a cost appearing anywhere in a pre-reveal customer payload
 *      identifies the pick. The walk looks for the literal digits.
 *   3. THE COST IS FROZEN. The supplier price is edited AFTER the sale and the
 *      recorded cost must not move — docs/FINANCE-DECISIONS.md is the
 *      specification and this is the sentence it is built on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, stubApp, post, get, json, all, row, count, type App, type StubUser } from './fixtures/app';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';
import { productRoutes } from '../worker/routes/products';
import { bundlesRoutes } from '../worker/routes/bundles';
import { adminMysteryRoutes } from '../worker/routes/mystery';
import { adminFinanceReportRoutes, resetFinanceSchemaMemo } from '../worker/routes/adminFinanceReport';
import { moveOrderStage } from '../worker/lib/orderStageOps';
import { baghdadDay } from '../worker/lib/baghdadTime';
import { seedCatalogue, orderBody } from './lib/bundles';
import { POOL_PRODUCTS } from './lib/mysteryOffer';

const boss: StubUser = { id: 'boss', role: 'admin', email: 'a@x.co' };
/** NO MEMBERSHIP ROW ANYWHERE. `seedCatalogue` gives 'buyer' none, which is
 *  the entire point: every assertion below is made by somebody who has never
 *  paid for a tier. */
const buyer: StubUser = { id: 'buyer', role: 'customer', email: 's@x.co' };

const appAs = (db: unknown, user: StubUser | null) =>
  stubApp(db, user, (a) => {
    a.route('/api/cart', cartRoutes);
    a.route('/api/orders', orderRoutes);
    a.route('/api/products', productRoutes);
    a.route('/api/bundles', bundlesRoutes);
    a.route('/api/admin/mystery', adminMysteryRoutes);
  });

const financeApp = (db: unknown) => {
  // The probe memoises a POSITIVE answer per isolate, and one test process is
  // one isolate holding many databases (see `probeSchema`).
  resetFinanceSchemaMemo();
  return stubApp(db, boss, (a) => a.route('/api/admin/finance/report', adminFinanceReportRoutes));
};

const put = (a: App, path: string, body: unknown) =>
  a.request(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/**
 * THE COST OF EVERY FILAMENT IN THE POOL, hand-written and deliberately odd.
 *
 * Distinct, because the whole suite turns on "which one was drawn"; odd and
 * five-digit, because the leak walk searches customer payloads for the literal
 * digits and a round number like 20,000 would collide with a price, a fee or a
 * subtotal and make the walk pass for the wrong reason. Each is comfortably
 * below its product's selling price, which `validateProductDoc` requires.
 */
const COST_OF: Record<string, number> = {
  mp_a: 13_137,
  mp_b: 17_173,
  mp_c: 19_191,
  mp_d: 23_237,
};

/** The four filament products the pool draws from, WITH a supplier cost each. */
function seedFilaments(raw: DatabaseSync): void {
  for (const p of POOL_PRODUCTS) {
    raw
      .prepare(
        `INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,
                               selling_type,sale_types,preorder_transports,images,inventory_mode,ops_policy,
                               product_cost_iqd)
         VALUES (?,?,?,?,?,?,'active',?,'[]','[]','direct_sale','["direct_sale"]','[]',?,'BASE','{"is_spool":true}',?)`
      )
      .run(
        p.id,
        p.slug,
        p.name,
        `${p.name} AR`,
        `${p.name} KU`,
        p.price,
        p.stock,
        JSON.stringify([`https://cdn/${p.slug}.png`]),
        COST_OF[p.id]
      );
  }
}

/** Pool + offer, created ONLY through the admin router — so what the panel
 *  writes is what the shop sells and what the report later counts. */
async function composeOffer(db: unknown, over: Record<string, unknown> = {}) {
  const adminApp = appAs(db, boss);
  const pool = await json(
    await post(adminApp, '/api/admin/mystery/pools', { name: 'Filament pool', kind: 'direct', min_available: 1 })
  );
  assert.equal(pool.success, true, JSON.stringify(pool));
  const poolId = String(pool.pool.id);
  const generated = await json(
    await post(adminApp, `/api/admin/mystery/pools/${poolId}/entries/generate`, {
      product_ids: POOL_PRODUCTS.map((p) => p.id),
      weight: 1,
    })
  );
  assert.equal(generated.inserted, POOL_PRODUCTS.length, JSON.stringify(generated));

  const offer = await json(
    await post(adminApp, '/api/admin/mystery/offers', {
      name_en: 'Mystery Filament Box',
      name_ar: 'صندوق فتيل عشوائي',
      name_ku: 'سندووقی نهێنی',
      price_iqd: 60_000,
      status: 'active',
      direct_pool_id: poolId,
      spool_qty: 2,
      allow_direct: true,
      duplicate_policy: 'allow',
      reveal_stage: 'delivered',
      offer: { required_tiers: [], active: true },
      ...over,
    })
  );
  assert.equal(offer.success, true, JSON.stringify(offer).slice(0, 400));
  return { poolId, offerId: String(offer.product.id), offerSlug: String(offer.product.slug), saveResponse: offer };
}

// ===========================================================================
//  C1 — PUBLIC, NOT MEMBERS-ONLY
// ===========================================================================

test('a signed-out visitor and a non-member both see the random filament, and the non-member buys it', async () => {
  const raw = seedCatalogue();
  seedFilaments(raw);
  const db = asD1(raw);
  const { offerId, offerSlug } = await composeOffer(db);

  // The viewer who holds nothing at all. `entitled` is still reported — its
  // 0034 meaning survives — but it no longer decides whether the list has rows.
  const anon = await json(await get(appAs(db, null), '/api/bundles?kind=mystery'));
  assert.equal(anon.entitled, false, 'nobody is signed in, so nobody is entitled');
  assert.equal(anon.signed_in, false);
  const anonCard = (anon.bundles as Record<string, unknown>[]).find((b) => b.id === offerId);
  assert.ok(anonCard, 'the random filament is on the public list for a signed-out visitor');
  assert.equal(anonCard!.locked, false, 'and it is not locked');

  // A signed-in customer with no membership row of any kind.
  const list = await json(await get(appAs(db, buyer), '/api/bundles?kind=mystery'));
  assert.equal(list.entitled, false, 'this buyer has never paid for a tier');
  const card = (list.bundles as Record<string, unknown>[]).find((b) => b.id === offerId)!;
  assert.equal(card.locked, false);
  assert.deepEqual(
    ((card.offer ?? {}) as Record<string, unknown>).required_tiers ?? [],
    [],
    'no tier is required of anyone'
  );

  const detail = await json(await get(appAs(db, null), `/api/bundles/${offerSlug}`));
  assert.equal(detail.success, true, 'the detail page answers a guest');
  assert.equal(detail.bundle.mystery.spool_qty, 2, 'and it is the real offer, not a lock panel');

  // THE ONLY ASSERTION THAT PROVES IT. The card, the cart and the checkout
  // door each re-ask eligibility independently (§15.1 rule 6), so "not locked"
  // is three claims and only the purchase tests all three.
  const added = await json(await post(appAs(db, buyer), '/api/cart/items', { productId: offerId, qty: 1 }));
  assert.equal(added.success, true, JSON.stringify(added));
  const placed = await json(await post(appAs(db, buyer), '/api/orders', orderBody()));
  assert.equal(placed.success, true, JSON.stringify(placed).slice(0, 400));
  assert.equal(
    count(raw, 'SELECT COUNT(*) AS n FROM mystery_allocations WHERE order_id = ?', String(placed.order.id)),
    2,
    'a non-member drew two real spools'
  );
});

test('a per-offer restriction the owner sets deliberately still refuses a non-member', async () => {
  const raw = seedCatalogue();
  seedFilaments(raw);
  const db = asD1(raw);
  const { offerId, offerSlug } = await composeOffer(db);

  // The owner keeps the ability to run a members-only promotion: the column is
  // an optional per-offer restriction, not a dead switch.
  const restricted = await json(
    await put(appAs(db, boss), `/api/admin/mystery/offers/${offerId}`, {
      name_en: 'Mystery Filament Box',
      name_ar: 'صندوق فتيل عشوائي',
      name_ku: 'سندووقی نهێنی',
      price_iqd: 60_000,
      status: 'active',
      direct_pool_id: String(row<{ id: string }>(raw, 'SELECT id FROM mystery_pools LIMIT 1')!.id),
      spool_qty: 2,
      allow_direct: true,
      duplicate_policy: 'allow',
      reveal_stage: 'delivered',
      offer: { required_tiers: ['plus'], active: true },
    })
  );
  assert.equal(restricted.success, true, JSON.stringify(restricted).slice(0, 400));
  assert.equal(
    row<{ required_tiers: string }>(raw, "SELECT required_tiers FROM offer_windows WHERE subject_id = ?", offerId)!
      .required_tiers,
    '["plus"]',
    'the restriction is stored, not quietly discarded'
  );

  // …AND THE SAVE SAYS SO, in all three languages. The owner's ruling is that
  // the feature is general, so a restriction is now an exception that has to
  // announce itself rather than sit silently in one edit form.
  const notice = (restricted.warning_details as Record<string, unknown>[]).find(
    (w) => w.code === 'MYSTERY_MEMBERS_ONLY_RESTRICTION'
  );
  assert.ok(notice, `the save discloses the restriction: ${JSON.stringify(restricted.warnings)}`);
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    assert.ok(String(notice![lang]).length > 10, `the notice has a real ${lang} sentence`);
  }
  assert.notEqual(notice!.ar, notice!.ckb, 'ckb is a language here, not a copy of Arabic');

  // The list the owner actually opens now names it, instead of hiding it two
  // clicks deep in one offer's eligibility tab.
  const offers = await json(await get(appAs(db, boss), '/api/admin/mystery/offers'));
  const listed = (offers.offers as Record<string, unknown>[]).find((o) => o.id === offerId)!;
  assert.equal(listed.members_only, true);
  assert.deepEqual(listed.required_tiers, ['plus']);

  // And the detail read repeats it, for the admin who came to change a pool.
  const detailAdmin = await json(await get(appAs(db, boss), `/api/admin/mystery/offers/${offerId}`));
  assert.equal(detailAdmin.members_only, true);
  assert.ok(
    (detailAdmin.warning_details as Record<string, unknown>[]).some(
      (w) => w.code === 'MYSTERY_MEMBERS_ONLY_RESTRICTION'
    ),
    'opening the offer says it is restricted'
  );

  // THE RESTRICTION STILL BITES. A non-member sees a locked card and, more
  // importantly, cannot get past the door.
  const card = (
    (await json(await get(appAs(db, buyer), '/api/bundles?kind=mystery'))).bundles as Record<string, unknown>[]
  ).find((b) => b.id === offerId)!;
  assert.equal(card.locked, true, 'a deliberately restricted offer is still locked to a non-member');

  const detail = await json(await get(appAs(db, buyer), `/api/bundles/${offerSlug}`));
  assert.equal(detail.bundle.locked, true);

  const added = await post(appAs(db, buyer), '/api/cart/items', { productId: offerId, qty: 1 });
  const addedBody = await json(added);
  if (addedBody.success === true) {
    // If the cart lets the line in, the DOOR is the one that must refuse — and
    // it must refuse by NAME, so the storefront can offer the subscription
    // instead of a generic failure.
    const placed = await json(await post(appAs(db, buyer), '/api/orders', orderBody()));
    assert.equal(placed.success, undefined, JSON.stringify(placed).slice(0, 300));
    assert.equal(placed.code, 'MEMBERSHIP_REQUIRED', JSON.stringify(placed).slice(0, 300));
  } else {
    assert.equal(addedBody.code, 'MEMBERSHIP_REQUIRED', JSON.stringify(addedBody).slice(0, 300));
  }
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM mystery_allocations'), 0, 'nothing was drawn for a non-member');
});

test('a public offer carries no restriction notice, so the warning means something when it appears', async () => {
  const raw = seedCatalogue();
  seedFilaments(raw);
  const db = asD1(raw);
  const { offerId, saveResponse } = await composeOffer(db);

  assert.ok(
    !(saveResponse.warning_details as Record<string, unknown>[]).some(
      (w) => w.code === 'MYSTERY_MEMBERS_ONLY_RESTRICTION'
    ),
    'a public save says nothing about membership'
  );
  const offers = await json(await get(appAs(db, boss), '/api/admin/mystery/offers'));
  const listed = (offers.offers as Record<string, unknown>[]).find((o) => o.id === offerId)!;
  assert.equal(listed.members_only, false);
  assert.deepEqual(listed.required_tiers, []);
});

// ===========================================================================
//  C2 — THE GIFT FILAMENT HAS A REAL COST
// ===========================================================================

/** Buys one box as a non-member and returns what the draw produced. */
async function buyOneBox(raw: DatabaseSync, db: unknown, offerId: string) {
  await json(await post(appAs(db, buyer), '/api/cart/items', { productId: offerId, qty: 1 }));
  const placed = await json(await post(appAs(db, buyer), '/api/orders', orderBody()));
  assert.equal(placed.success, true, JSON.stringify(placed).slice(0, 400));
  const orderId = String(placed.order.id);
  const allocations = all<Record<string, unknown>>(
    raw,
    'SELECT * FROM mystery_allocations WHERE order_id = ? ORDER BY spool_index',
    orderId
  );
  const spools = all<Record<string, unknown>>(
    raw,
    'SELECT * FROM order_items WHERE order_id = ? AND bundle_parent_item_id IS NOT NULL ORDER BY rowid',
    orderId
  );
  return { orderId, allocations, spools, drawn: allocations.map((a) => String(a.product_id)) };
}

test('the draw records the cost of what it took off the shelf, on the spool row, at the instant of the draw', async () => {
  const raw = seedCatalogue();
  seedFilaments(raw);
  const db = asD1(raw);
  const { offerId } = await composeOffer(db);
  const { orderId, allocations, spools, drawn } = await buyOneBox(raw, db, offerId);

  assert.equal(allocations.length, 2, 'two spools, two draws');
  assert.equal(spools.length, 2, 'two spools, two order lines');

  // Each spool row names the cost of the filament THAT ROW drew — not an
  // average, not the offer's price, not zero.
  for (const s of spools) {
    const alloc = allocations.find((a) => a.order_item_id === s.id)!;
    const expected = COST_OF[String(alloc.product_id)];
    assert.equal(s.cost_basis, 'snapshot', 'a measured cost, not an estimate and not a gap');
    assert.equal(
      Number(s.cost_iqd),
      expected,
      `the spool drawn from ${String(alloc.product_id)} is costed at that product's own supplier price`
    );
    assert.equal(s.product_id, null, 'and the identity is STILL not on the order row (§7.7 is untouched)');
    assert.equal(s.pricing_snapshot, null);
  }

  // The parent holds the money and no cost of its own: its goods are the spool
  // rows, and charging a cost here as well would count the same filament twice.
  const parent = row<Record<string, unknown>>(
    raw,
    'SELECT * FROM order_items WHERE order_id = ? AND bundle_parent_item_id IS NULL',
    orderId
  )!;
  assert.equal(parent.cost_basis, 'composed');
  assert.equal(parent.cost_iqd, null);
  assert.equal(Number(parent.line_total_iqd), 60_000);

  // ------------------------------------------------- AND IT IS FROZEN
  //
  // docs/FINANCE-DECISIONS.md: «تغيير سعر التكلفة للمنتج لاحقًا — المنتجات
  // القديمة التي بيعت لا تتأثر». The supplier doubles his price tomorrow; last
  // month's profit must not move behind the owner.
  const before = spools.map((s) => Number(s.cost_iqd));
  for (const id of drawn) {
    raw.prepare('UPDATE products SET product_cost_iqd = ? WHERE id = ?').run(COST_OF[id] * 4, id);
  }
  const after = all<Record<string, unknown>>(
    raw,
    'SELECT cost_iqd FROM order_items WHERE order_id = ? AND bundle_parent_item_id IS NOT NULL ORDER BY rowid',
    orderId
  ).map((s) => Number(s.cost_iqd));
  assert.deepEqual(after, before, 'a later supplier-price edit cannot rewrite a sale that already happened');
});

test('a pool nobody has priced is recorded as UNKNOWN, and never as free goods', async () => {
  const raw = seedCatalogue();
  seedFilaments(raw);
  // The owner never typed a cost for any of these filaments.
  raw.exec('UPDATE products SET product_cost_iqd = NULL WHERE id LIKE \'mp_%\'');
  const db = asD1(raw);
  const { offerId } = await composeOffer(db);
  const { spools } = await buyOneBox(raw, db, offerId);

  for (const s of spools) {
    assert.equal(s.cost_iqd, null);
    assert.equal(
      s.cost_basis,
      'unpriced',
      'we looked at every rung and found nothing — a RECORDED FACT, which 0095 forbids estimating away later'
    );
  }
  // 'unpriced' is what stops the box reporting as pure profit: the roll-up
  // reads it as unknown, so the parent's revenue lands in `uncosted_revenue`.
  const totals = await mysteryTotals(raw, db);
  assert.equal(totals.cogs_iqd, 0);
  assert.equal(totals.uncosted_revenue_iqd, 60_000, 'unknown is said out loud; free is never said');
  assert.equal(totals.costed_revenue_iqd, 0);
  assert.equal(totals.gross_margin_percent, null, 'no margin can be computed from goods nobody priced');
});

test('the cost of the drawn filament never reaches the customer, before the reveal or after it', async () => {
  const raw = seedCatalogue();
  seedFilaments(raw);
  const db = asD1(raw);
  const { offerId } = await composeOffer(db);
  const { orderId, drawn } = await buyOneBox(raw, db, offerId);

  // EVERY cost in the pool is forbidden, not only the drawn ones: a payload
  // that carried the whole cost table would be just as complete a leak, and a
  // walk that only looked for the winners would pass.
  const forbidden = Object.values(COST_OF).map(String);
  assert.equal(new Set(forbidden).size, forbidden.length, 'the costs are distinct, so a hit names one filament');

  const surfaces = async (label: string) => {
    const payloads: Array<[string, unknown]> = [
      [`${label}: order detail`, await json(await get(appAs(db, buyer), `/api/orders/${orderId}`))],
      [`${label}: order list`, await json(await get(appAs(db, buyer), '/api/orders'))],
      [`${label}: units`, await json(await get(appAs(db, buyer), `/api/orders/${orderId}/units`))],
      [`${label}: tracking`, await json(await get(appAs(db, buyer), `/api/orders/${orderId}/tracking`))],
      [`${label}: cart`, await json(await get(appAs(db, buyer), '/api/cart'))],
      [`${label}: listing`, await json(await get(appAs(db, null), '/api/bundles?kind=mystery'))],
    ];
    for (const [where, payload] of payloads) {
      const text = JSON.stringify(payload);
      for (const cost of forbidden) {
        assert.ok(!text.includes(cost), `${where} leaked the cost ${cost}`);
      }
    }
  };

  await surfaces('before the reveal');

  // AND AFTER THE REVEAL TOO. At `delivered` the customer is told which
  // filament they received — that is the promise — but what the shop PAID for
  // it is never part of that promise.
  const env = { DB: db } as never;
  for (const stage of ['confirmed', 'preparing', 'out_for_delivery', 'delivered'] as const) {
    await moveOrderStage(env, { orderId, to: stage, source: 'manual', changedBy: boss.id, note: '' });
  }
  const revealed = JSON.stringify(await json(await get(appAs(db, buyer), `/api/orders/${orderId}`)));
  for (const id of drawn) {
    assert.ok(revealed.includes(id), 'the reveal still happens — this is not a test that hides the pick');
  }
  await surfaces('after the reveal');
});

// ---------------------------------------------------------------- the report

/** Delivers today's mystery order and returns the period totals for today. */
async function mysteryTotals(raw: DatabaseSync, db: unknown) {
  const orderId = String(row<{ id: string }>(raw, 'SELECT id FROM orders LIMIT 1')!.id);
  const env = { DB: db } as never;
  for (const stage of ['confirmed', 'preparing', 'out_for_delivery', 'delivered'] as const) {
    await moveOrderStage(env, { orderId, to: stage, source: 'manual', changedBy: boss.id, note: '' });
  }
  const day = baghdadDay(Date.now());
  const r = await json(
    await get(financeApp(db), `/api/admin/finance/report/summary?from=${day}&to=${day}&granularity=range`)
  );
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 300));
  return r.totals as Record<string, number | null>;
}

test('the finance report stops treating mystery revenue as costless, and files the cost under the offer that earned it', async () => {
  const raw = seedCatalogue();
  seedFilaments(raw);
  const db = asD1(raw);
  const { offerId } = await composeOffer(db);
  const { drawn } = await buyOneBox(raw, db, offerId);

  // The expectation is HAND-COMPUTED from the map at the top of this file and
  // the ids the draw actually produced — never re-derived through the same
  // join the report uses, which would only prove the code agrees with itself.
  const expectedCogs = drawn.reduce((sum, id) => sum + COST_OF[id], 0);
  assert.ok(expectedCogs > 0);

  const t = await mysteryTotals(raw, db);
  assert.equal(t.gross_revenue_iqd, 60_000, 'the box is the only sale in the period');
  assert.equal(t.cogs_iqd, expectedCogs, 'the filament that left the shelf is charged against the box');
  assert.equal(t.uncosted_revenue_iqd, 0, 'a costed mystery box is no longer an "unknown cost" disclosure');
  assert.equal(t.costed_revenue_iqd, 60_000);
  assert.equal(t.gross_profit_iqd, 60_000 - expectedCogs);
  assert.ok(
    (t.gross_margin_percent as number) < 100,
    `a mystery box must never report 100% margin again — got ${t.gross_margin_percent}%`
  );
  assert.equal(t.estimated, false, 'the cost was measured at the draw, so nothing here is an estimate');

  // PER PRODUCT, which is where the lie used to live: the offer's revenue in
  // its own row and every mystery cost the shop ever paid in a nameless NULL
  // bucket beside it, so the box read as 100% margin one screen down.
  const day = baghdadDay(Date.now());
  const products = await json(await get(financeApp(db), `/api/admin/finance/report/products?from=${day}&to=${day}`));
  const rows = products.products as Array<{ id: string | null; totals: Record<string, number | null> }>;
  const boxRow = rows.find((r) => r.id === offerId);
  assert.ok(boxRow, `the mystery offer has a row of its own: ${JSON.stringify(rows).slice(0, 400)}`);
  assert.equal(boxRow!.totals.revenue_iqd, 60_000);
  assert.equal(boxRow!.totals.cogs_iqd, expectedCogs, 'revenue and cost meet in ONE product row');
  assert.equal(boxRow!.totals.gross_profit_iqd, 60_000 - expectedCogs);
  assert.equal(boxRow!.totals.uncosted_revenue_iqd, 0);

  const nameless = rows.find((r) => r.id === null);
  assert.equal(
    nameless === undefined || nameless.totals.cogs_iqd === 0,
    true,
    `no cost is left stranded in the nameless NULL-product group: ${JSON.stringify(nameless)}`
  );

  // The drawn filaments are NOT products that sold in their own right: their
  // money is on the box, so a row for them would be revenue counted twice.
  for (const id of drawn) {
    assert.equal(rows.find((r) => r.id === id), undefined, 'a spool is not a sale of the filament product');
  }

  // The same rule one rung up. The box's cost must land in the box's CATEGORY,
  // or the per-category screen repeats the per-product lie.
  const cats = await json(
    await get(financeApp(db), `/api/admin/finance/report/categories?from=${day}&to=${day}&level=main`)
  );
  const catRows = cats.categories as Array<{ id: string | null; totals: Record<string, number | null> }>;
  const totalCogs = catRows.reduce((n, x) => n + Number(x.totals.cogs_iqd ?? 0), 0);
  const totalRevenue = catRows.reduce((n, x) => n + Number(x.totals.revenue_iqd ?? 0), 0);
  assert.equal(totalCogs, expectedCogs, 'the category column adds up to the period COGS');
  assert.equal(totalRevenue, 60_000, 'and to the period revenue');
  for (const r of catRows) {
    const revenue = Number(r.totals.revenue_iqd ?? 0);
    const cogs = Number(r.totals.cogs_iqd ?? 0);
    assert.ok(
      !(revenue > 0 && cogs === 0) || Number(r.totals.uncosted_revenue_iqd ?? 0) === revenue,
      `a category with revenue and no cost must say its revenue is uncosted, not imply 100% margin: ${JSON.stringify(r)}`
    );
  }
});
