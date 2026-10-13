/**
 * PRICING V2, STEP V2-0 — THE CUSTOMER ITEMS C2, C3 AND C5 (DECISIONS row 225).
 *
 *   C2  A live offer prices the product page's opening price, its quote, the
 *       pills (`pricing_modes`) and the public API `purchase` block exactly as
 *       the cart and the checkout charge it. The page never shows a higher
 *       number than the cart.
 *   C3  The public API's per-option and per-colour prices of a product priced
 *       per SKU follow the "from lowest" rule of row 202 (the card's and the
 *       comparison's), with a `from` flag on each entry.
 *   C5  Customer payloads carry final numbers only: no `components`,
 *       `price_source`, `member_rule`, fee by name or raw ladder — except the
 *       three facts a customer screen still renders (DEFERRED to V2-7).
 *
 * The C2/C5 fixture is the payment suite's: one product sold both ways (base
 * 100,000; sea commission 15,000; direct premium 50,000), here with a live
 * offer of 10,000 off for everyone. The C3 fixture is the engine's census
 * product `bambu-lab-pla-matte-1kg` (2 models × 25 colours), saved through the
 * owner's real pricing door with one colour costing more.
 *
 * Run: node --import tsx --test tests/customerFinalPrices.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import worker from '../worker/index';
import { ROOT, SqliteD1 } from './fixtures/d1';
import { APEX, ctx as workerCtx } from './fixtures/app';
import type { AppContext } from '../worker/lib/types';
import { HttpError } from '../worker/lib/http';
import { orderRoutes, orderPublic } from '../worker/routes/orders';
import { cartRoutes, resolveCartLine } from '../worker/routes/cart';
import { productRoutes } from '../worker/routes/products';
import { acceptedPolicies } from './lib/policies';
import { resetPolicyCorpusMemo } from '../worker/lib/policySync';
import { arithmeticLeaks } from './fixtures/costlyProduct';
import { pricingWorld } from './fixtures/procurementPricing';
import { legacyProductId } from './fixtures/legacyCatalogue';
import { loadPreviewContext, loadProducts } from '../worker/lib/pricingEngine/load';
import { REFUSAL_STRINGS } from '../src/lib/refusalStrings';

// ------------------------------------------------------------------ fixture

const SEA = JSON.stringify([{ method: 'sea', commission_iqd: 15_000, active: true }]);
const OFF = 10_000;

function setup(offer: { required_tiers?: string[]; discount_iqd?: number } | null = {}) {
  resetPolicyCorpusMemo();
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) raw.exec(readFileSync(join(dir, f), 'utf8'));
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','s@x.co','h','customer'),
      ('sea','Noor','n@x.co','h','customer');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default) VALUES
      ('addr_b','buyer','Home','Sara','+9647701234567','Baghdad, Karrada 12','',1),
      ('addr_s','sea','Home','Noor','+9647704445556','Mosul, Zuhur 3','',1);
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status) VALUES
      ('dep_b','buyer','deposit','USD',100000,'approved'),
      ('dep_s','sea','deposit','USD',100000,'approved');
  `);
  raw
    .prepare(
      `INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,direct_surcharge_iqd,images)
       VALUES ('p_a1','a1','Bambu A1','بامبو A1',100000,'active',10,'[]','[]','direct_sale','["direct_sale","pre_order"]',?,50000,'[]')`
    )
    .run(SEA);
  if (offer) {
    raw
      .prepare(
        `INSERT INTO offer_windows (subject_type,subject_id,id,starts_at,ends_at,required_tiers,offer_price_mode,offer_price_iqd,
                                    discount_percent,discount_iqd,plus_price_iqd,locked_preview,active)
         VALUES ('product','p_a1','ofw_a1',NULL,NULL,?,'discount_iqd',NULL,NULL,?,NULL,1,1)`
      )
      .run(JSON.stringify(offer.required_tiers ?? []), offer.discount_iqd ?? OFF);
  }
  return { raw, db: new SqliteD1(raw) as unknown as D1Database };
}

function cartLine(raw: DatabaseSync, id: string, user: string, transport: '' | 'sea') {
  raw
    .prepare(
      `INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty,fulfillment_type)
       VALUES (?,?,'p_a1','','[]','','',?,'',1,?)`
    )
    .run(id, user, transport, transport ? 'pre_order' : 'direct_sale');
}

const pending: Promise<unknown>[] = [];
const ctx = {
  waitUntil: (p: Promise<unknown>) => {
    pending.push(p.catch(() => undefined));
  },
  passThroughOnException() {},
} as unknown as ExecutionContext;

function appAs(db: D1Database, userId: string | null) {
  const a = new Hono<AppContext>();
  a.use('*', async (c, next) => {
    if (userId) c.set('user', { id: userId, role: 'customer', email: `${userId}@x.co`, username: userId } as never);
    c.env = { DB: db } as never;
    await next();
  });
  a.route('/api/orders', orderRoutes);
  a.route('/api/cart', cartRoutes);
  a.route('/api/products', productRoutes);
  a.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ success: false, error: err.message, code: err.code }, err.status as 400);
    throw err;
  });
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = Record<string, any>;
const json = async (res: Response) => (await res.json()) as J;
const post = (a: ReturnType<typeof appAs>, path: string, body: unknown) =>
  a.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, undefined, ctx);
const quoteBody = (addressId: string, paymentMethodId: string) => ({
  addressId,
  deliveryMethodId: 'standard',
  paymentMethodId,
  useWallet: false,
  usePoints: false,
  itemIds: [],
});
let seq = 0;
const orderBody = (addressId: string, paymentMethodId: string) => ({
  ...quoteBody(addressId, paymentMethodId),
  idempotencyKey: `v20-${Date.now()}-${++seq}`,
  policyAcceptance: acceptedPolicies(),
});

/** The public API v1 product, as an anonymous agent reads it. */
async function publicProduct(db: D1Database, slug: string): Promise<J> {
  const env = { DB: db, STORE_ROOT_DOMAIN: APEX, APP_ORIGIN: `https://${APEX}`, INITIAL_ADMIN_EMAIL: 'boss@x.co', EXTRA_ALLOWED_ORIGINS: '', ASSETS: { fetch: async () => new Response('spa') } };
  const res = await worker.fetch(
    new Request(`https://${APEX}/api/public/v1/products/${slug}`, { headers: { Host: APEX, 'CF-Connecting-IP': '9.9.9.9' } }),
    env as never,
    workerCtx
  );
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body).slice(0, 300));
  return body.data as J;
}

type Mode = { method: string; prepaid: { unit_subtotal_iqd: number } | null; cod: { unit_subtotal_iqd: number } | null; cod_reprices: boolean };
const modesOf = (m: J) => ({
  direct: m.direct?.unit_subtotal_iqd ?? null,
  routes: (m.preorder as Mode[]).map((r) => [r.method, r.prepaid?.unit_subtotal_iqd ?? null, r.cod?.unit_subtotal_iqd ?? null]),
});

// With the offer: goods 90,000; direct = 90,000 + 50,000 premium; sea prepaid = 90,000 + 15,000; sea cash = priced as direct.
const DIRECT = 100_000 - OFF + 50_000;
const SEA_PREPAID = 100_000 - OFF + 15_000;
const SEA_COD = DIRECT;

// ------------------------------------------------------------------- C2

test('C2: a live offer prices the opening price, the quote, the pills and the public API purchase block exactly as the cart and the checkout charge it', async () => {
  const { db, raw } = setup();
  const buyer = appAs(db, 'buyer');

  // The product page, as it opens: its seeded quote and its pills.
  const detail = await json(await buyer.request('/api/products/a1'));
  assert.equal(detail.product.offer.price_source, 'offer', 'the window is live for this viewer');
  assert.equal(detail.pricing.unit_subtotal_iqd, DIRECT, 'the opening price carries the offer the cart will charge');
  assert.equal(detail.pricing.regular_iqd, 100_000 - OFF);
  assert.equal(detail.price_levels.base.unit_subtotal_iqd, DIRECT, 'the level grid and the opening price agree');
  assert.deepEqual(modesOf(detail.pricing_modes), { direct: DIRECT, routes: [['sea', SEA_PREPAID, SEA_COD]] });

  // The quote, on a direct selection and on the sea journey.
  const direct = await json(await post(buyer, '/api/products/a1/quote', { qty: 2, fulfillmentType: 'direct_sale' }));
  assert.equal(direct.quote.unit_subtotal_iqd, DIRECT, 'the quote no longer lands HIGHER than the grid (it ignored the offer)');
  assert.equal(direct.quote.line_total_iqd, DIRECT * 2);
  assert.deepEqual(modesOf(direct.pricing_modes), { direct: DIRECT, routes: [['sea', SEA_PREPAID, SEA_COD]] });
  const sea = await json(await post(buyer, '/api/products/a1/quote', { qty: 1, fulfillmentType: 'pre_order', transportMethod: 'sea' }));
  assert.equal(sea.quote.unit_subtotal_iqd, SEA_PREPAID);

  // The cart and the checkout: the same numbers, line for line.
  cartLine(raw, 'ci_d', 'buyer', '');
  cartLine(raw, 'ci_s', 'sea', 'sea');
  const cartDirect = await json(await buyer.request('/api/cart'));
  assert.equal(cartDirect.items[0].unit_price_iqd, DIRECT);
  const seaApp = appAs(db, 'sea');
  const cartSea = await json(await seaApp.request('/api/cart'));
  assert.equal(cartSea.items[0].unit_price_iqd, SEA_PREPAID);
  const doorDirect = (await json(await post(buyer, '/api/orders/quote', quoteBody('addr_b', 'cash')))).quote;
  assert.equal(doorDirect.lines[0].unit_price_iqd, DIRECT);
  const doorWallet = (await json(await post(seaApp, '/api/orders/quote', quoteBody('addr_s', 'wallet')))).quote;
  assert.equal(doorWallet.lines[0].unit_price_iqd, SEA_PREPAID);
  const doorCash = (await json(await post(seaApp, '/api/orders/quote', quoteBody('addr_s', 'cash')))).quote;
  assert.equal(doorCash.lines[0].unit_price_iqd, SEA_COD, 'the cash pill is the cash door');

  // The public API: the same offer, the same three numbers.
  const api = await publicProduct(db, 'a1');
  assert.deepEqual(api.purchase, { direct_sale: DIRECT, pre_order: [{ method: 'sea', prepaid: SEA_PREPAID, cash_on_delivery: SEA_COD }] });
  await Promise.allSettled(pending);
});

test('C2: the gate gates the quote too — a members-only window is not priced for a viewer the door would refuse, so the quote equals the cart', async () => {
  const { db, raw } = setup({ required_tiers: ['pro'] });
  const buyer = appAs(db, 'buyer');
  const quote = await json(await post(buyer, '/api/products/a1/quote', { qty: 1, fulfillmentType: 'direct_sale' }));
  assert.equal(quote.quote.unit_subtotal_iqd, 150_000, 'the ladder price: this viewer may not take the window');
  assert.equal(quote.pricing_modes.direct.unit_subtotal_iqd, 150_000);
  cartLine(raw, 'ci_d', 'buyer', '');
  assert.equal((await json(await buyer.request('/api/cart'))).items[0].unit_price_iqd, 150_000);
});

test('C2: with no window the figures are the ladder ones, unchanged (no price moves)', async () => {
  const { db } = setup(null);
  const buyer = appAs(db, 'buyer');
  const quote = await json(await post(buyer, '/api/products/a1/quote', { qty: 1, fulfillmentType: 'direct_sale' }));
  assert.equal(quote.quote.unit_subtotal_iqd, 150_000);
  assert.deepEqual(modesOf(quote.pricing_modes), { direct: 150_000, routes: [['sea', 115_000, 150_000]] });
});

test('C2: a window priced below its floor reaches the customer as the cart\'s own refusal (OFFER_INACTIVE), never as the floor\'s internal code', async () => {
  // 150,000 off a 100,000 product: `applyOfferToResolved` refuses the window
  // (DERIVED_PRICE_BELOW_FLOOR + OFFER_INACTIVE). The page prints every code
  // its opening price and its quote carry, so only the one the door refuses
  // with — and the page has a sentence for — may reach it.
  const { db } = setup({ discount_iqd: 150_000 });
  const buyer = appAs(db, 'buyer');
  const detail = await json(await buyer.request('/api/products/a1'));
  assert.deepEqual(detail.pricing.errors, ['OFFER_INACTIVE'], 'the opening price');
  const quote = await json(await post(buyer, '/api/products/a1/quote', { qty: 1, fulfillmentType: 'direct_sale' }));
  assert.deepEqual(quote.quote.errors, ['OFFER_INACTIVE'], 'the quote');
  assert.equal(JSON.stringify([detail, quote]).includes('DERIVED_PRICE_BELOW_FLOOR'), false);
  // The door says the same thing.
  const added = await json(await post(buyer, '/api/cart/items', { productId: 'p_a1', qty: 1, fulfillmentType: 'direct_sale' }));
  assert.equal(added.code, 'OFFER_INACTIVE', JSON.stringify(added).slice(0, 300));
  // …and the product page has the sentence in all three languages (the
  // refusal table's own wording), so `reasonText` never prints the code.
  const page = readFileSync(join(ROOT, 'src/pages/Product.tsx'), 'utf8');
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    assert.ok(page.includes(`OFFER_INACTIVE: '${REFUSAL_STRINGS.OFFER_INACTIVE[lang]}'`), `Product.tsx STRINGS.${lang}.OFFER_INACTIVE`);
  }
  assert.equal(page.match(/^\s+OFFER_INACTIVE: '/gm)?.length, 3, 'one sentence per language');
  assert.notEqual(REFUSAL_STRINGS.OFFER_INACTIVE.ckb, REFUSAL_STRINGS.OFFER_INACTIVE.ar);
  await Promise.allSettled(pending);
});

test('C2: the public API says which figure the cart charges — `price` is the item price, `purchase` the price of each way to buy', async () => {
  const { db } = setup();
  // The fixture is the case the wording must survive: item 90,000, cart 140,000 direct / 105,000 by sea.
  const api = await publicProduct(db, 'a1');
  assert.equal(api.price.amount, 100_000 - OFF);
  assert.equal(api.purchase.direct_sale, DIRECT);
  const env = { DB: db, STORE_ROOT_DOMAIN: APEX, APP_ORIGIN: `https://${APEX}`, INITIAL_ADMIN_EMAIL: 'boss@x.co', EXTRA_ALLOWED_ORIGINS: '', ASSETS: { fetch: async () => new Response('spa') } };
  const res = await worker.fetch(
    new Request(`https://${APEX}/api/public/v1/context`, { headers: { Host: APEX, 'CF-Connecting-IP': '9.9.9.9' } }),
    env as never,
    workerCtx
  );
  const prices = String(((await json(res)) as J).conventions.prices);
  assert.doesNotMatch(prices, /same number the cart charges/, 'the item price is not what the cart charges for every way to buy');
  assert.match(prices, /item price/);
  assert.match(prices, /`purchase`[^.]*what the cart charges/);
  const doc = readFileSync(join(ROOT, 'docs/PUBLIC_API.md'), 'utf8');
  assert.doesNotMatch(doc, /Every price is the final\s+price the cart charges/);
  assert.match(doc, /`purchase` block carries what the cart charges/);
});

// ------------------------------------------------------------------- C5

test('C5: the page, the quote, the cart, the checkout and the order carry final numbers only; the three rendered facts are kept for V2-7', async () => {
  const { db, raw } = setup();
  cartLine(raw, 'ci_s', 'sea', 'sea');
  const seaApp = appAs(db, 'sea');
  const guest = appAs(db, null);

  const answers: Array<[string, unknown]> = [
    ['GET /api/products/a1', await json(await guest.request('/api/products/a1'))],
    ['GET /api/products', await json(await guest.request('/api/products'))],
    ['POST quote direct', await json(await post(guest, '/api/products/a1/quote', { qty: 1, fulfillmentType: 'direct_sale' }))],
    ['POST quote sea', await json(await post(seaApp, '/api/products/a1/quote', { qty: 1, fulfillmentType: 'pre_order', transportMethod: 'sea' }))],
    ['GET /api/cart', await json(await seaApp.request('/api/cart'))],
    ['POST /api/orders/quote wallet', await json(await post(seaApp, '/api/orders/quote', quoteBody('addr_s', 'wallet')))],
    ['POST /api/orders/quote cash', await json(await post(seaApp, '/api/orders/quote', quoteBody('addr_s', 'cash')))],
  ];
  const placed = await json(await post(seaApp, '/api/orders', orderBody('addr_s', 'cash')));
  assert.equal(placed.success, true, JSON.stringify(placed).slice(0, 400));
  answers.push(['POST /api/orders', placed]);
  answers.push(['GET /api/orders/:id', await json(await seaApp.request(`/api/orders/${placed.order.id}`))]);
  answers.push(['GET /api/orders', await json(await seaApp.request('/api/orders'))]);

  const problems = answers.flatMap(([at, body]) => arithmeticLeaks(body).map((l) => `${at}: ${l}`));
  assert.deepEqual(problems, []);

  // Not vacuous: the stored snapshot still holds the whole resolver answer
  // (the order row is never rewritten), and the admin view still reads it.
  const item = raw.prepare('SELECT * FROM order_items WHERE order_id = ?').get(placed.order.id) as Record<string, unknown>;
  const stored = JSON.parse(String(item.pricing_snapshot)) as J;
  assert.ok(stored.components && stored.member_rule && stored.price_source, 'the stored snapshot keeps the working');
  assert.ok(stored.offer?.offer_id, 'and the offer that priced it');
  const orderRow = raw.prepare('SELECT * FROM orders WHERE id = ?').get(placed.order.id) as Record<string, unknown>;
  const adminView = orderPublic(orderRow, [item], undefined, undefined, 'admin') as J;
  assert.ok(adminView.items[0].pricing.components, 'the admin order view is out of scope and unchanged');

  // The DEFERRED facts, still served because OrderDetail and PaymentBreakdown render them (V2-7).
  const line = placed.order.items[0];
  assert.equal(line.pricing.pricing_basis, 'direct', '«سُعِّر كبيع مباشر (الدفع عند الاستلام)»');
  assert.deepEqual(line.pricing.direct, { surcharge_iqd: 50_000, waived: false }, 'PaymentBreakdown names the fee');
  assert.deepEqual(line.transport, { method: 'sea', commission_iqd: 15_000, waived: true, waived_by: 'cod_direct_pricing' });
  // …and the final figures a customer reads.
  assert.equal(line.pricing.unit_subtotal_iqd, SEA_COD);
  assert.equal(line.pricing.regular_iqd, 100_000 - OFF);
  assert.equal('offer' in line.pricing, false, 'the offer arithmetic stays on the stored row');

  // The product JSON: the routes by name, no premium, no ladder on any level.
  const detail = answers[0][1] as J;
  assert.deepEqual(detail.product.preorder_transports, [{ method: 'sea', active: true }]);
  assert.equal('direct_surcharge_iqd' in detail.product, false);
  assert.deepEqual(detail.availability.preorder.transports, [{ method: 'sea', configured: true }]);
  await Promise.allSettled(pending);
});

// ------------------------------------------------------------------- C3

const PID = legacyProductId('bambu-lab-pla-matte-1kg');
const SLUG = 'bambu-lab-pla-matte-1kg';
const M = [`${PID}_o0`, `${PID}_o1`];
const C = (k: number) => `${PID}_c${k}`;

test('C3: the public API prices each option and each colour of a per-SKU product «from» its lowest SKU, with a `from` flag (row 202)', async () => {
  const w = pricingWorld();
  // The owner's real save: base $10 by sea, $3 minimum profit, 2,000 IQD direct-sale extra, colour 0 at $12.
  const draft = {
    inputs: [
      { scope: 'base', supplier_cost_amount: '10', supplier_cost_currency: 'USD', shipping_profile: 'CHINA_SEA', manual_cbm: '0.005' },
      { scope: 'color', scope_id: C(0), supplier_cost_amount: '12', supplier_cost_currency: 'USD' },
    ],
    rules: [
      { kind: 'target_profit', scope: 'product', amount_usd: '3' },
      { kind: 'direct_sale_extra', scope: 'product', amount_iqd: 2000 },
    ],
  };
  const seqOf = () => (w.raw.prepare('SELECT inputs_seq AS s FROM product_pricing_state WHERE product_id = ?').get(PID) as { s: number } | undefined)?.s ?? 0;
  const first = await w.putInputs(PID, { inputs_seq: seqOf(), ...draft });
  assert.equal(first.status, 409, JSON.stringify(first.body).slice(0, 300));
  const saved = await w.putInputs(PID, { inputs_seq: seqOf(), ...draft, preview_hash: first.body.details.preview.preview_hash, confirm_large_change: true });
  assert.equal(saved.status, 200, JSON.stringify(saved.body).slice(0, 300));

  // What the cart charges a guest for a direct line of each SKU.
  const loaded = (await loadProducts(w.db, [PID])).get(PID)!;
  const pctx = await loadPreviewContext(w.db);
  const charge = (model: string, colour: string) =>
    resolveCartLine(
      loaded.row,
      { optionId: model, optionValueIds: [model], colorId: colour, transportMethod: '', fulfillmentType: 'direct_sale', warrantyPlanId: '' },
      'free',
      false,
      pctx,
      loaded.view,
      'prepaid'
    ).resolved.applied_iqd;
  const dear = charge(M[0], C(0));
  const cheap = charge(M[0], C(1));
  assert.ok(dear > cheap, `colour 0 costs more (${dear} > ${cheap})`);
  assert.equal(charge(M[1], C(0)), dear);
  assert.equal(charge(M[1], C(1)), cheap);

  const api = await publicProduct(w.db, SLUG);
  // Every model: «from» its cheapest SKU — never the model's highest, which the ladder beneath the rung holds.
  assert.equal(api.options.length, 2);
  for (const o of api.options) {
    assert.equal(o.price, cheap, `${o.name.en}: its lowest SKU`);
    assert.equal(o.from, true, `${o.name.en}: its SKUs differ`);
  }
  // Every colour: its own lowest SKU — never the product's global minimum (another colour's pre-order price).
  const byName = new Map((api.colors as J[]).map((c) => [c.name.en, c]));
  const colourName = (k: number) => String((w.raw.prepare('SELECT name_en FROM product_colors WHERE id = ?').get(C(k)) as { name_en: string }).name_en);
  assert.equal(byName.get(colourName(0))!.price, dear, 'the dear colour reads its own price');
  assert.equal(byName.get(colourName(0))!.from, false, 'both models cost the same in it');
  assert.equal(byName.get(colourName(1))!.price, cheap);
  assert.equal(byName.get(colourName(1))!.from, false);
  for (const c of api.colors as J[]) assert.ok(c.price === dear || c.price === cheap, `${c.name.en}: ${c.price} is a price the cart charges`);
  // The combinations were already exact; they agree.
  const combo = (api.combinations as J[]).find((x) => x.color.en === colourName(0))!;
  assert.equal(combo.price, dear);
  w.raw.close();
});
