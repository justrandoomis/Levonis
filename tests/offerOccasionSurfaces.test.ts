/**
 * THE SALE'S OCCASION ON THE CUSTOMER SURFACES, AND «العروض» (DECISIONS row 294; docs/ux/PRODUCT-DISCOUNT.md
 * §16.4–§16.6).
 *
 *   - the card's offer block names the occasion ONLY while its sale is live, active, unsuspended, priced,
 *     eligible for this viewer and lowers the card's «from» (`price_source: 'offer'`) — never before it
 *     starts, after it ends, switched off, suspended by the clean start, as a countdown with no price, or
 *     to a guest locked out of a members-only sale — and names it to the member that sale covers;
 *   - the product page names it when the sale lowers ANY selection for this viewer: a Combo-only sale
 *     above the card's «from» is labelled on the page and never on the card;
 *   - an explicit allow-list: the key, and the owner's name for `custom`, inside the existing `offer`
 *     block — no new top-level key, no preset's words, and the leak scanners stay clean;
 *   - `/api/products?type=offers` («العروض») lists exactly the products a live sale lowers for this
 *     viewer, narrowed IN SQL so a candidate cap can hide none; ordinary products only (never a bundle's
 *     sale); `occasions` counts each occasion before `occasion=` narrows the list; an unknown occasion
 *     lists nothing;
 *   - an occasion save purges the cached listing «العروض» reads.
 *
 * Run: node --import tsx --test tests/offerOccasionSurfaces.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discountWorld, COST_PID, M1, M2, PID, SHAPES, SLUG, off, seedShapes, type DiscountWorld } from './fixtures/productDiscount';
import { seedOptionless, writeV2 } from './fixtures/pricingV2';
import { listCatalogProducts, pricingCtxForUser } from '../worker/routes/products';

const percent = (p: number, extra: Record<string, unknown> = {}) => ({ offer_price_mode: 'discount_percent', discount_percent: p, ends_at: '2099-01-01T00:00', ...extra });

async function listing(w: DiscountWorld, query = 'limit=50', app = w.guest) {
  const res = await w.call(app, 'GET', `/api/products?${query}`);
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
  return res.body as { products: Array<Record<string, unknown>>; occasions?: Array<Record<string, unknown>>; total?: number; has_more?: boolean; partial_order?: boolean };
}
const cardOf = (body: { products: Array<Record<string, unknown>> }, id = PID) => body.products.find((p) => p.id === id);
const offerOf = (card: Record<string, unknown> | undefined) => (card?.offer ?? null) as Record<string, unknown> | null;

/* ----------------------------------------------------------------- the card -- */

test('the card names the occasion only while its sale is live, active, unsuspended, priced, eligible and lowers its «from»', async () => {
  const w = await discountWorld({ costFirst: false });
  assert.equal((await w.saveOffer(w.owner, percent(10, { badge: 'black_friday' }))).status, 200);
  const live = offerOf(cardOf(await listing(w)))!;
  assert.equal(live.price_source, 'offer');
  assert.equal(live.badge, 'black_friday');
  assert.equal('badge_text' in live, false, 'a preset carries its key alone — its words are the client’s');

  const states: Array<[string, string]> = [
    ['upcoming', "UPDATE offer_windows SET starts_at = '2099-01-01T00:00:00.000Z'"],
    ['ended', "UPDATE offer_windows SET starts_at = NULL, ends_at = '2020-01-01T00:00:00.000Z'"],
    ['switched off', "UPDATE offer_windows SET ends_at = '2099-01-01T00:00:00.000Z', active = 0"],
    ['suspended by the clean start', "UPDATE offer_windows SET active = 1, updated_at = '2020-01-01T00:00:00.000Z'"],
    ['a countdown with no price', "UPDATE offer_windows SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 second'), offer_price_mode = '', discount_percent = NULL"],
  ];
  for (const [why, sql] of states) {
    w.raw.exec(sql);
    const offer = offerOf(cardOf(await listing(w)));
    assert.ok(offer, `${why}: the product still has its offer block`);
    assert.equal('badge' in offer!, false, `${why}: no occasion`);
    const page = (await w.call(w.guest, 'GET', `/api/products/${SLUG}`)).body.product.offer;
    assert.equal('badge' in page, false, `${why}: none on the page either`);
  }
});

test('a members-only sale names no occasion to whoever it does not cover — the lock shows instead', async () => {
  const w = await discountWorld({ costFirst: false });
  assert.equal((await w.saveOffer(w.owner, percent(20, { required_tiers: ['plus'], badge: 'ramadan' }))).status, 200);
  for (const app of [w.guest, w.buyer]) {
    const offer = offerOf(cardOf(await listing(w, 'limit=50', app)))!;
    assert.deepEqual([offer.locked, offer.price_source, 'badge' in offer], [true, 'ladder', false]);
    assert.equal('badge' in (await w.call(app, 'GET', `/api/products/${SLUG}`)).body.product.offer, false);
    assert.equal(cardOf(await listing(w, 'type=offers', app)), undefined, '«العروض» does not list a sale this viewer may not take');
  }
});

test('…and names it to the member it covers: on the card, the page and «العروض», with its chip', async () => {
  const w = await discountWorld({ costFirst: false });
  w.raw.exec(`INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,starts_at,expires_at)
    VALUES ('m_plus','u_buyer','plus_12mo','plus','active',12,99000,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z');`);
  assert.equal((await w.saveOffer(w.owner, percent(20, { required_tiers: ['plus'], badge: 'ramadan' }))).status, 200);
  const offer = offerOf(cardOf(await listing(w, 'limit=50', w.buyer)))!;
  assert.deepEqual([offer.locked, offer.price_source, offer.badge], [false, 'offer', 'ramadan']);
  assert.equal((await w.call(w.buyer, 'GET', `/api/products/${SLUG}`)).body.product.offer.badge, 'ramadan');
  const offers = await listing(w, 'type=offers', w.buyer);
  assert.deepEqual(offers.products.map((p) => p.id), [PID]);
  assert.deepEqual(offers.occasions, [{ key: 'ramadan', count: 1 }]);
  assert.deepEqual((await listing(w, 'type=offers&occasion=ramadan', w.buyer)).products.map((p) => p.id), [PID]);
  // The guest beside them: the same sale, locked, unnamed, unlisted, no chip.
  const guest = await listing(w, 'type=offers');
  assert.deepEqual([guest.products.length, guest.occasions], [0, []]);
});

test('the page names it when the sale lowers ANY selection: a Combo-only sale is labelled on the page, never on the card', async () => {
  const w = await discountWorld({ costFirst: false });
  // The Combo 1,125,000 → 1,050,000 ($700): its land route 975,000 stays above the P1S's 825,000 «from».
  const saved = await w.saveOffer(w.owner, { offer_price_mode: 'fixed_usd', offer_usd_prices: [{ model_id: M2, usd: '700' }], ends_at: '2099-01-01T00:00', badge: 'white_friday' });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const card = cardOf(await listing(w))!;
  assert.equal(offerOf(card)!.price_source, 'ladder');
  assert.equal('badge' in offerOf(card)!, false, 'the card strikes nothing, so it names nothing');
  const page = (await w.call(w.guest, 'GET', `/api/products/${SLUG}`)).body;
  assert.equal(page.product.offer.badge, 'white_friday', 'the page names it: the Combo is on sale');
  assert.ok(page.price_levels.option[M2].offer_before_iqd > page.price_levels.option[M2].applied_iqd, 'the Combo’s level is the lowered one');
  assert.equal(page.price_levels.option[M1].offer_before_iqd ?? null, null, 'the P1S’s is not — the page shows the tag on the Combo only (offerBefore)');
  assert.equal(cardOf(await listing(w, 'type=offers')), undefined, '«العروض» lists what a card shows on sale');
});

test('an explicit allow-list: the key (and a custom name) inside the existing offer block; no new top-level key; the scanners stay clean', async () => {
  const { arithmeticLeaks, leaks } = await import('./fixtures/costlyProduct');
  const w = await discountWorld({ costFirst: false });
  const plainKeys = Object.keys(cardOf(await listing(w))!).sort();
  assert.equal((await w.saveOffer(w.owner, percent(10))).status, 200);
  const saleKeys = Object.keys(cardOf(await listing(w))!).sort();
  const saleOffer = Object.keys(offerOf(cardOf(await listing(w)))!).sort();
  assert.equal((await w.saveOffer(w.owner, percent(10, { badge: 'custom', badge_text: { ar: 'عيد الحب', en: 'Valentine' } }))).status, 200);
  const card = cardOf(await listing(w))!;
  assert.deepEqual(Object.keys(card).sort(), saleKeys, 'no new top-level card key');
  assert.deepEqual(Object.keys(offerOf(card)!).sort(), [...saleOffer, 'badge', 'badge_text'].sort(), 'two keys, inside the offer block');
  assert.deepEqual(offerOf(card)!.badge_text, { ar: 'عيد الحب', en: 'Valentine' });
  assert.ok(saleKeys.length >= plainKeys.length);
  const answers: Array<[string, unknown]> = [
    ['listing', await listing(w)],
    ['offers', await listing(w, 'type=offers')],
    ['page', (await w.call(w.guest, 'GET', `/api/products/${SLUG}`)).body],
    ['home', (await w.call(w.guest, 'GET', '/api/home/sections')).body],
  ];
  for (const [name, body] of answers) {
    assert.deepEqual(arithmeticLeaks(body), [], `${name}: arithmetic`);
    assert.deepEqual(leaks(body), [], `${name}: cost`);
    assert.doesNotMatch(JSON.stringify(body), /"(usd_iqd_rate|price_usd_cents|cents|badge_ar|occasion_words)"/, name);
  }
  // A preset's words never travel: the payload says «black_friday», the client draws «بلاك فرايدي».
  assert.equal((await w.saveOffer(w.owner, percent(10, { badge: 'black_friday' }))).status, 200);
  assert.doesNotMatch(JSON.stringify(await listing(w)), /بلاك فرايدي|Black Friday/);
});

/* ------------------------------------------------------------- «العروض» -- */

test('type=offers lists exactly the products a live sale lowers for this viewer, by occasion, with the occasions counted first', async () => {
  const w = await discountWorld();
  // Nothing on sale: an empty list, no chips.
  const none = await listing(w, 'type=offers');
  assert.deepEqual([none.products.length, none.total, none.occasions], [0, 0, []]);
  assert.equal((await w.saveOffer(w.owner, percent(10, { badge: 'black_friday' }))).status, 200);
  assert.equal((await w.saveOffer(w.owner, percent(10), COST_PID)).status, 200);
  const all = await listing(w, 'type=offers');
  assert.deepEqual(all.products.map((p) => p.id).sort(), [PID, COST_PID].sort());
  assert.equal(all.total, 2);
  assert.equal(all.has_more, false);
  assert.deepEqual(all.occasions, [{ key: 'black_friday', count: 1 }], 'a sale with no occasion is in «الكل» only');
  for (const p of all.products) assert.equal(offerOf(p)!.price_source, 'offer', 'every card shows its sale');
  const friday = await listing(w, 'type=offers&occasion=black_friday');
  assert.deepEqual(friday.products.map((p) => p.id), [PID]);
  assert.deepEqual(friday.occasions, all.occasions, 'the chips stay while one is chosen');
  assert.deepEqual((await listing(w, 'type=offers&occasion=ramadan')).products, []);
  assert.deepEqual((await listing(w, 'type=offers&occasion=not_an_occasion')).products, [], 'a stale link lists nothing — never the catalogue');
  // Two custom names: one «custom» chip without a name; one name: the chip carries it.
  assert.equal((await w.saveOffer(w.owner, percent(10, { badge: 'custom', badge_text: { ar: 'عيد الحب' } }), COST_PID)).status, 200);
  assert.deepEqual((await listing(w, 'type=offers')).occasions, [
    { key: 'black_friday', count: 1 },
    { key: 'custom', count: 1, badge_text: { ar: 'عيد الحب' } },
  ]);
  // An ended sale leaves the list; the plain listing is untouched by the new type.
  w.raw.exec(`UPDATE offer_windows SET ends_at = '2020-01-01T00:00:00.000Z' WHERE subject_id = '${COST_PID}'`);
  assert.deepEqual((await listing(w, 'type=offers')).products.map((p) => p.id), [PID]);
  assert.ok(cardOf(await listing(w), COST_PID), 'still in the catalogue');
  // Paged like every listing: limit and offset, `has_more`.
  const paged = await listing(w, 'type=offers&limit=1');
  assert.deepEqual([paged.products.length, paged.has_more], [1, false]);
});

test('«العروض» lists ordinary products only: a composition with a live, priced sale is not on it', async () => {
  const w = await discountWorld({ costFirst: false });
  await seedShapes(w);
  assert.equal((await w.saveOffer(w.owner, percent(10, { badge: 'black_friday' }))).status, 200);
  // A bundle's own live sale (its editors write the same table; no occasion — the door refuses one there).
  w.raw.exec(`INSERT INTO offer_windows (subject_type, subject_id, id, starts_at, ends_at, offer_price_mode, discount_percent, active)
    VALUES ('product', '${SHAPES.bundle}', 'ofw_bundle', NULL, '2099-01-01T00:00:00.000Z', 'discount_percent', 10, 1)`);
  const offers = await listing(w, 'type=offers');
  assert.deepEqual(offers.products.map((p) => p.id), [PID], 'the sale on the ordinary product, never the bundle’s');
  assert.deepEqual(offers.occasions, [{ key: 'black_friday', count: 1 }]);
});

test('the SQL narrowing: a candidate cap cannot hide a sale behind the rest of the catalogue', async () => {
  const w = await discountWorld({ costFirst: false });
  // Three sellable products AHEAD of the sale in the shelf order.
  for (const id of ['p_a', 'p_b', 'p_c']) {
    seedOptionless(w.raw, id, { routes: ['land'] });
    await writeV2(w.db, id, { method: 'usd', points: [{ scope: 'product', scope_id: '', kind: 'fixed', usd: '100' }], discounts: [off('10')] });
  }
  w.raw.exec("UPDATE products SET display_order = -1 WHERE id IN ('p_a','p_b','p_c')");
  assert.equal((await w.saveOffer(w.owner, percent(10, { badge: 'black_friday' }))).status, 200);
  const caps = { candidates: 2 };
  // The in-memory «عليها عرض» filter over the whole catalogue resolves the first two — and misses the sale.
  const filtered = (await listCatalogProducts(w.db, { offer: '1', limit: '20' }, pricingCtxForUser(w.db, null), { caps })).body as { products: Array<{ id: string }>; partial_order?: boolean };
  assert.equal(filtered.partial_order, true);
  assert.equal(filtered.products.some((p) => p.id === PID), false, 'the cap hid the sale there');
  // «العروض» narrows in SQL first: the only candidate is the sale.
  const offers = (await listCatalogProducts(w.db, { type: 'offers', limit: '20' }, pricingCtxForUser(w.db, null), { caps })).body as { products: Array<{ id: string }>; partial_order?: boolean };
  assert.deepEqual(offers.products.map((p) => p.id), [PID]);
  assert.equal(offers.partial_order, false);
});

test('an occasion save purges the cached listing «العروض» reads, and the product page', async () => {
  const w = await discountWorld({ costFirst: false });
  const g = globalThis as { caches?: unknown };
  const before = g.caches;
  const paths: string[] = [];
  g.caches = { default: { delete: async (req: Request) => (paths.push(new URL(req.url).pathname), true), match: async () => undefined, put: async () => undefined } };
  try {
    assert.equal((await w.saveOffer(w.owner, percent(10, { badge: 'christmas' }))).status, 200);
  } finally {
    if (before === undefined) delete g.caches;
    else g.caches = before;
  }
  for (const path of ['/api/products', '/api/home', `/api/products/${SLUG}`]) assert.ok(paths.includes(path), `purged ${path}`);
});
