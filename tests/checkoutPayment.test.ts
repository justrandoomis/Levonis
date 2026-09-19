/**
 * Payment method × availability pricing × order type — the owner's mandate,
 * run through the REAL quote and checkout routes against real migrations.
 *
 *   «For Pre-Order only, the customer can choose between: Pay in advance /
 *    Cash on Delivery. If the customer pays in advance, the price remains
 *    exactly as currently configured. If the customer chooses Cash on
 *    Delivery, the price must follow the same pricing rules as Direct Sale.
 *    … However, the order itself must still follow the Pre-Order order stages
 *    and must remain identified as a Pre-Order. The difference is only the
 *    commission/pricing logic.»
 *
 *   «Pro Card users are exempt from this additional shipping-type cost.»
 *
 *   «For printers, show a note stating that 50,000 IQD must be paid when
 *    requesting home delivery — only as a note.»
 *
 * The fixture is one product sold both ways (base 100,000; sea commission
 * 15,000; direct premium 50,000), one printer in a printer catalog, a
 * regular buyer and an active PRO at their approved address. Only the session
 * is stubbed; pricing, the cart rule, the shipping engine, the wallet guard,
 * the stage machine and the invoice all run for real.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ROOT, SqliteD1 } from './fixtures/d1';
import type { AppContext } from '../worker/lib/types';
import { HttpError } from '../worker/lib/http';
import { orderRoutes } from '../worker/routes/orders';
import { cartRoutes } from '../worker/routes/cart';
import { productRoutes } from '../worker/routes/products';
import { stagesFor } from '../worker/lib/orderStages';
import {
  allowedPaymentMethods,
  isCod,
  isPaymentMethodAllowed,
  isPrepaid,
  preorderPricingFor,
  PAYMENT_METHOD_NOT_ALLOWED,
} from '../worker/lib/paymentPolicy';
import { printerProductIds, isPrinterProduct } from '../worker/lib/printerIdentity';
import { SETTING_DEFAULTS, PUBLIC_SETTING_KEYS, printerNoteIqdFrom } from '../worker/lib/settings';
import { acceptedPolicies } from './lib/policies';
import { resetPolicyCorpusMemo } from '../worker/lib/policySync';

// ------------------------------------------------------------------ fixture

const SEA = JSON.stringify([{ method: 'sea', commission_iqd: 15_000, active: true }]);

function setup() {
  // A NEW DATABASE IS A NEW ARCHIVE. `ensurePolicyCorpus` memoises a COMPLETED
  // mirror per isolate, and one test process is one isolate holding many
  // databases: without this, the first database in the run gets the policy
  // rows and every later one is skipped as already-synced, so checkout refuses
  // consent it cannot bind to a row. tests/fixtures/app.ts#dbThrough does the
  // same for the fixtures it builds; this file builds its own.
  resetPolicyCorpusMemo();
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) raw.exec(readFileSync(join(dir, f), 'utf8'));
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','s@x.co','h','customer'),
      ('pro','Omar','o@x.co','h','customer'),
      ('pro2','Ali','a2@x.co','h','customer'),
      ('thin','Noor','n@x.co','h','customer');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default) VALUES
      ('addr_b','buyer','Home','Sara','+9647701234567','Baghdad, Karrada 12','',1),
      ('addr_p','pro','Home','Omar','+9647709876543','Erbil, Ankawa 4','',1),
      ('addr_p2','pro2','Home','Ali','+9647701112223','Basra, Ashar 9','',1),
      ('addr_t','thin','Home','Noor','+9647704445556','Mosul, Zuhur 3','',1);
    -- The PRO's approved default address — the gate every PRO purchase benefit hangs on.
    -- pro2 is an active PRO with NO approved address: priced as ordinary everywhere.
    INSERT INTO approved_addresses (id,user_id,version,name,phone_e164,address,landmark,state)
      VALUES ('ap1','pro',1,'Omar','+9647709876543','Erbil, Ankawa 4','','approved');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,starts_at,expires_at) VALUES
      ('m_pro','pro','pro_12mo','pro','active',12,499000,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z'),
      ('m_pro2','pro2','pro_12mo','pro','active',12,499000,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z');
    -- Three wallets hold $1,000 (100,000 cents) — plenty at 1,400 IQD/USD;
    -- 'thin' holds $50 (70,000 IQD), enough for part of an order, never all of it.
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status) VALUES
      ('dep_b','buyer','deposit','USD',100000,'approved'),
      ('dep_p','pro','deposit','USD',100000,'approved'),
      ('dep_p2','pro2','deposit','USD',100000,'approved'),
      ('dep_t','thin','deposit','USD',5000,'approved');
  `);
  raw
    .prepare(
      `INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,direct_surcharge_iqd,images)
       VALUES ('p_a1','a1','Bambu A1','بامبو A1',100000,'active',10,'[]','[]','direct_sale','["direct_sale","pre_order"]',?,50000,'[]'),
              ('p_po','po-only','Pre-order Only','طلب مسبق فقط',100000,'active',NULL,'[]','[]','pre_order','["pre_order"]',?,NULL,'[]'),
              ('p_x1','x1-printer','Printer X1','طابعة X1',899000,'active',5,'[]','[]','direct_sale','["direct_sale"]','[]',NULL,'[]'),
              ('p_pla','pla-basic','PLA Basic','PLA أساسي',25000,'active',50,'[]','[]','direct_sale','["direct_sale"]','[]',NULL,'[]')`
    )
    .run(SEA, SEA);
  raw.exec(`
    INSERT INTO catalogs (id, slug, name_ar, is_printer_catalog) VALUES ('cat_test_printers','test-printers','طابعات',1);
    INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES ('p_x1','cat_test_printers',0);
  `);
  return { raw, db: new SqliteD1(raw) as unknown as D1Database };
}

/** One cart line; '' = a direct line, air/sea/land = a pre-order line. */
function cartLine(raw: DatabaseSync, id: string, user: string, productId: string, transport: '' | 'sea', qty = 1) {
  raw
    .prepare(
      `INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty)
       VALUES (?,?,?,'','[]','','',?,'',?)`
    )
    .run(id, user, productId, transport, qty);
}

function appAs(db: D1Database, userId: string) {
  const a = new Hono<AppContext>();
  a.use('*', async (c, next) => {
    c.set('user', { id: userId, role: 'customer', email: `${userId}@x.co`, username: userId } as never);
    c.env = { DB: db } as never;
    await next();
  });
  a.route('/api/orders', orderRoutes);
  a.route('/api/cart', cartRoutes);
  a.route('/api/products', productRoutes);
  a.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ success: false, error: err.message, code: err.code, details: err.details ?? null }, err.status as 400);
    }
    throw err;
  });
  return a;
}

// POST /api/orders schedules background work through c.executionCtx; the
// stub collects those promises so a test can let them settle.
const pending: Promise<unknown>[] = [];
const ctx = {
  waitUntil: (p: Promise<unknown>) => {
    pending.push(p.catch(() => undefined));
  },
  passThroughOnException() {},
} as unknown as ExecutionContext;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response) => (await res.json()) as Record<string, any>;
/** One pre-order journey of the product quote's `pricing_modes` (worker/routes/products.ts). */
interface QuoteMode {
  method: string;
  prepaid: { unit_subtotal_iqd: number } | null;
  cod: { unit_subtotal_iqd: number } | null;
  cod_reprices: boolean;
}
const post = (a: ReturnType<typeof appAs>, path: string, body: unknown) =>
  a.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, undefined, ctx);

const quoteBody = (addressId: string, paymentMethodId: string | undefined, over: Record<string, unknown> = {}) => ({
  addressId,
  deliveryMethodId: 'standard',
  paymentMethodId,
  useWallet: false,
  usePoints: false,
  itemIds: [],
  ...over,
});
let seq = 0;
const orderBody = (addressId: string, paymentMethodId: string, over: Record<string, unknown> = {}) => ({
  ...quoteBody(addressId, paymentMethodId, over),
  idempotencyKey: `chk-${Date.now()}-${++seq}`,
  policyAcceptance: acceptedPolicies(),
});

// -------------------------------------------------------------- the policy

test('the payment policy: wallet and cash for every shipping type; half_advance refused; full_advance tolerated', () => {
  for (const t of ['direct', 'preorder_air', 'preorder_sea', 'preorder_land'] as const) {
    assert.deepEqual(allowedPaymentMethods(t), ['wallet', 'cash']);
    assert.equal(isPaymentMethodAllowed('wallet', t), true);
    assert.equal(isPaymentMethodAllowed('cash', t), true);
    assert.equal(isPaymentMethodAllowed('full_advance', t), true, 'alias of wallet, kept for stored orders and scripts');
    assert.equal(isPaymentMethodAllowed('half_advance', t), false);
    assert.equal(isPaymentMethodAllowed('card', t), false);
  }
  assert.equal(isCod('cash'), true);
  assert.equal(isCod('cod'), false, "the merchant storefront's 'cod' is a different vocabulary");
  assert.equal(isPrepaid('wallet'), true);
  assert.equal(isPrepaid('full_advance'), true);
  assert.equal(isPrepaid('cash'), false);
  assert.equal(preorderPricingFor('cash'), 'cod');
  assert.equal(preorderPricingFor('wallet'), 'prepaid');
  assert.equal(preorderPricingFor(''), 'prepaid', 'quote mode with no choice yet prices as configured');
});

test('the printer note is a public setting with the owner’s 50,000 default, read defensively', () => {
  assert.equal(SETTING_DEFAULTS.printerHomeDeliveryNoteIqd, 50_000);
  assert.ok(PUBLIC_SETTING_KEYS.includes('printerHomeDeliveryNoteIqd'));
  assert.equal(printerNoteIqdFrom(50_000), 50_000);
  assert.equal(printerNoteIqdFrom('50000'), 50_000);
  assert.equal(printerNoteIqdFrom(0), null);
  assert.equal(printerNoteIqdFrom(-1), null);
  assert.equal(printerNoteIqdFrom(''), null);
  assert.equal(printerNoteIqdFrom(null), null);
  assert.equal(printerNoteIqdFrom('lots'), null);
});

// ---------------------------------------------------------- printer identity

test('printer identity comes from the catalog flag, batched, never from ops_policy', async () => {
  const { db } = setup();
  const ids = await printerProductIds(db, ['p_a1', 'p_x1', 'p_pla', 'nope', '']);
  assert.deepEqual([...ids], ['p_x1']);
  assert.equal(await isPrinterProduct(db, 'p_x1'), true);
  assert.equal(await isPrinterProduct(db, 'p_a1'), false);
  assert.deepEqual([...(await printerProductIds(db, []))], []);
  // …and it reaches the public product and the cart line.
  const a = appAs(db, 'buyer');
  assert.equal((await json(await a.request('/api/products/x1-printer'))).product.is_printer, true);
  assert.equal((await json(await a.request('/api/products/a1'))).product.is_printer, false);
});

// ------------------------------------------- pre-order: prepaid vs cash

test('a pre-order cart quotes the configured price with no method or the wallet, and the direct-sale price with cash', async () => {
  const { db, raw } = setup();
  cartLine(raw, 'ci1', 'buyer', 'p_a1', 'sea');
  const a = appAs(db, 'buyer');

  // The cart itself prices PREPAID and names the fee that applies.
  const cart = await json(await a.request('/api/cart'));
  assert.equal(cart.shipping_type, 'preorder_sea');
  assert.equal(cart.items[0].unit_price_iqd, 115_000);
  assert.equal(cart.items[0].breakdown.pricing_basis, 'preorder');
  assert.equal(cart.items[0].breakdown.direct, null);
  assert.equal(cart.items[0].is_printer, false);

  // No method chosen yet: prepaid pricing, and the two methods on offer.
  const open = (await json(await post(a, '/api/orders/quote', quoteBody('addr_b', undefined)))).quote;
  assert.equal(open.lines[0].unit_price_iqd, 115_000);
  assert.equal(open.pricing_basis, 'preorder');
  assert.equal(open.shipping_type, 'preorder_sea');
  assert.deepEqual(open.allowed_payment_methods, ['wallet', 'cash']);

  // Wallet = pay in advance: the pre-order price exactly as configured.
  const wallet = (await json(await post(a, '/api/orders/quote', quoteBody('addr_b', 'wallet')))).quote;
  assert.equal(wallet.lines[0].unit_price_iqd, 115_000);
  assert.equal(wallet.subtotal_iqd, 115_000);
  assert.equal(wallet.pricing_basis, 'preorder');
  assert.deepEqual(wallet.lines[0].breakdown.transport, { method: 'sea', commission_iqd: 15_000, waived: false });
  assert.equal(wallet.lines[0].breakdown.direct, null);
  assert.equal(wallet.wallet.required_advance_iqd, 120_000, 'the whole payable total, 115,000 + 5,000 delivery');
  assert.equal(wallet.due_on_delivery_iqd, 0);

  // Cash on delivery: base + direct premium, commission stepped aside, the
  // journey kept — and the quote's lines, not the cart's, carry the number.
  const cash = (await json(await post(a, '/api/orders/quote', quoteBody('addr_b', 'cash')))).quote;
  assert.equal(cash.lines[0].unit_price_iqd, 150_000);
  assert.equal(cash.subtotal_iqd, 150_000);
  assert.equal(cash.pricing_basis, 'direct');
  assert.equal(cash.shipping_type, 'preorder_sea', 'priced as direct, still a pre-order');
  assert.deepEqual(cash.lines[0].breakdown.direct, { surcharge_iqd: 50_000, waived: false });
  assert.deepEqual(cash.lines[0].breakdown.transport, {
    method: 'sea',
    commission_iqd: 15_000,
    waived: true,
    waived_by: 'cod_direct_pricing',
  });
  assert.equal(cash.total_iqd, 155_000);
  assert.equal(cash.due_on_delivery_iqd, 155_000);
  assert.equal(cash.wallet.required_advance_iqd, 0);
  assert.equal(cash.notes.printer_home_delivery_iqd, null, 'no printer in this cart, no note');
  // The quote says cash on delivery moves the number on THIS cart, and that
  // nothing was re-priced as prepaid — whichever method is being quoted.
  assert.equal(wallet.cod_reprices, true);
  assert.equal(cash.cod_reprices, true);
  assert.equal(wallet.prepaid_by_wallet, false);
  assert.equal(cash.prepaid_by_wallet, false);
});

// ------------------------- H1: no direct premium → the commission stays

test('a pre-order with NO direct premium keeps its commission under cash on delivery: prepaid and cash are the same 115,000', async () => {
  const { db, raw } = setup();
  cartLine(raw, 'ci1', 'buyer', 'p_po', 'sea');
  const a = appAs(db, 'buyer');

  const wallet = (await json(await post(a, '/api/orders/quote', quoteBody('addr_b', 'wallet')))).quote;
  const cash = (await json(await post(a, '/api/orders/quote', quoteBody('addr_b', 'cash')))).quote;
  for (const q of [wallet, cash]) {
    assert.equal(q.lines[0].unit_price_iqd, 115_000);
    assert.equal(q.subtotal_iqd, 115_000);
    assert.equal(q.total_iqd, 120_000);
    assert.equal(q.pricing_basis, 'preorder', '"priced as a direct sale" needs a direct premium to price with');
    assert.equal(q.shipping_type, 'preorder_sea');
    assert.deepEqual(q.lines[0].breakdown.transport, { method: 'sea', commission_iqd: 15_000, waived: false });
    assert.equal(q.lines[0].breakdown.direct, null);
    assert.equal(q.cod_reprices, false, 'nothing to explain: the method changes no dinar here');
  }
  assert.equal(cash.due_on_delivery_iqd, 120_000, 'the door is never cheaper than the wallet');
  assert.equal(wallet.due_on_delivery_iqd, 0);

  // The cart line says the same: no COD hint for this product.
  const cart = await json(await a.request('/api/cart'));
  assert.equal(cart.items[0].cod_reprices, false);
  // …and the product quote's modes agree.
  const pq = await json(await post(a, '/api/products/po-only/quote', { qty: 1, transportMethod: 'sea' }));
  assert.equal(pq.pricing_modes.direct, null, 'a pre-order-only product has no direct pill');
  assert.deepEqual(
    pq.pricing_modes.preorder.map((m: QuoteMode) => [m.method, m.prepaid!.unit_subtotal_iqd, m.cod!.unit_subtotal_iqd, m.cod_reprices]),
    [['sea', 115_000, 115_000, false]]
  );
  assert.equal(pq.pricing_modes.cod_reprices, false);

  // Placed cash on delivery: the commission is the fee, and the invoice says so.
  const placed = await json(await post(a, '/api/orders', orderBody('addr_b', 'cash')));
  assert.equal(placed.success, true, JSON.stringify(placed));
  assert.equal(placed.order.subtotal_iqd, 115_000);
  assert.equal(placed.order.due_on_delivery_iqd, 120_000);
  assert.equal(placed.order.items[0].pricing.pricing_basis, 'preorder');
  assert.equal(placed.order.financial.fees_iqd, 15_000);
  const inv = raw.prepare('SELECT snapshot FROM invoices WHERE order_id = ? AND revision = 1').get(placed.order.id) as { snapshot: string };
  assert.equal(JSON.parse(inv.snapshot).lines[0].transport_commission_iqd, 15_000);

  // A PRO at the approved address: the commission is waived by PRO, cash or wallet.
  cartLine(raw, 'ci2', 'pro', 'p_po', 'sea');
  const proCash = (await json(await post(appAs(db, 'pro'), '/api/orders/quote', quoteBody('addr_p', 'cash')))).quote;
  assert.equal(proCash.lines[0].unit_price_iqd, 100_000);
  assert.equal(proCash.pricing_basis, 'preorder');
  assert.equal(proCash.lines[0].breakdown.transport.waived_by, 'pro');
  await Promise.allSettled(pending);
});

// ------------------- H2: a cash order the wallet settles in full is prepaid

test('cash + a wallet that covers the whole total is a PREPAID pre-order: pre-order pricing, due 0, prepaid_by_wallet; a partial wallet stays COD-priced', async () => {
  const { db, raw } = setup();
  cartLine(raw, 'ci1', 'buyer', 'p_a1', 'sea');
  const a = appAs(db, 'buyer');

  const wallet = (await json(await post(a, '/api/orders/quote', quoteBody('addr_b', 'wallet', { useWallet: true })))).quote;
  const cashAll = (await json(await post(a, '/api/orders/quote', quoteBody('addr_b', 'cash', { useWallet: true })))).quote;
  assert.equal(cashAll.due_on_delivery_iqd, 0, 'nothing is left to collect at the door');
  assert.equal(cashAll.pricing_basis, 'preorder', 'so it is a prepaid order, whatever button was pressed');
  assert.equal(cashAll.lines[0].unit_price_iqd, 115_000);
  assert.equal(cashAll.subtotal_iqd, wallet.subtotal_iqd);
  assert.equal(cashAll.total_iqd, wallet.total_iqd, 'the wallet quote and the cash-settled-by-wallet quote are one price');
  assert.equal(cashAll.total_iqd, 120_000);
  assert.equal(cashAll.wallet.applied_iqd, 120_000);
  assert.equal(cashAll.prepaid_by_wallet, true, 'the note the checkout renders');
  assert.deepEqual(cashAll.lines[0].breakdown.transport, { method: 'sea', commission_iqd: 15_000, waived: false });
  assert.equal(cashAll.lines[0].breakdown.direct, null);
  assert.equal(cashAll.shipping_type, 'preorder_sea');
  // The plain wallet quote is what it always was.
  assert.equal(wallet.pricing_basis, 'preorder');
  assert.equal(wallet.prepaid_by_wallet, false);

  // Placing it: the order is stored as the prepaid pre-order it is, with the
  // button that was pressed kept on record.
  const placed = await json(await post(a, '/api/orders', orderBody('addr_b', 'cash', { useWallet: true })));
  assert.equal(placed.success, true, JSON.stringify(placed));
  assert.equal(placed.order.payment_method_id, 'cash');
  assert.equal(placed.order.subtotal_iqd, 115_000);
  assert.equal(placed.order.total_iqd, 120_000);
  assert.equal(placed.order.wallet_applied_iqd, 120_000);
  assert.equal(placed.order.due_on_delivery_iqd, 0);
  assert.equal(placed.order.shipping_type, 'preorder_sea');
  assert.equal(placed.order.items[0].pricing.pricing_basis, 'preorder');
  assert.equal(placed.order.items[0].unit_price_iqd, 115_000);
  assert.equal(placed.order.financial.payment_state, 'paid');
  assert.equal(placed.order.financial.fees_iqd, 15_000, 'the commission is the fee — never the premium the wallet did not pay');

  // A wallet that covers only PART of the total: money is collected at the
  // door, so the cash rule stands — direct pricing, the premium, the rest due.
  cartLine(raw, 'ci2', 'thin', 'p_a1', 'sea');
  const partial = (await json(await post(appAs(db, 'thin'), '/api/orders/quote', quoteBody('addr_t', 'cash', { useWallet: true })))).quote;
  assert.equal(partial.pricing_basis, 'direct');
  assert.equal(partial.lines[0].unit_price_iqd, 150_000);
  assert.equal(partial.total_iqd, 155_000);
  assert.equal(partial.wallet.applied_iqd, 70_000);
  assert.equal(partial.due_on_delivery_iqd, 85_000);
  assert.equal(partial.prepaid_by_wallet, false);
  assert.deepEqual(partial.lines[0].breakdown.direct, { surcharge_iqd: 50_000, waived: false });
  await Promise.allSettled(pending);
});

// ------------- M3: one PRO purchase context on the product, the cart, the door

test('an active PRO whose default address is NOT approved pays the surcharge on the product quote, the cart and the checkout alike', async () => {
  const { db, raw } = setup();
  cartLine(raw, 'ci1', 'pro2', 'p_a1', '');
  const a = appAs(db, 'pro2');

  // The product page: detail, quote and the per-mode figures.
  const detail = await json(await a.request('/api/products/a1'));
  assert.equal(detail.pricing.unit_subtotal_iqd, 150_000);
  assert.deepEqual(detail.pricing.direct, { surcharge_iqd: 50_000, waived: false });
  assert.deepEqual(detail.viewer_tier, { tier: 'pro', active: true, pricing_active: false, pro_benefits_context: false });
  assert.equal(detail.pricing_modes.direct.unit_subtotal_iqd, 150_000);
  const pq = await json(await post(a, '/api/products/a1/quote', { qty: 1 }));
  assert.equal(pq.quote.unit_subtotal_iqd, 150_000);
  assert.deepEqual(
    pq.pricing_modes.preorder.map((m: QuoteMode) => [m.method, m.prepaid!.unit_subtotal_iqd, m.cod!.unit_subtotal_iqd, m.cod_reprices]),
    [['sea', 115_000, 150_000, true]]
  );
  assert.equal(pq.pricing_modes.cod_reprices, true);
  // The cart.
  const cart = await json(await a.request('/api/cart'));
  assert.equal(cart.items[0].unit_price_iqd, 150_000);
  assert.deepEqual(cart.items[0].breakdown.direct, { surcharge_iqd: 50_000, waived: false });
  assert.equal(cart.tierActive, false, 'PRO, but not for pricing');
  // The checkout, at that very address.
  const quote = (await json(await post(a, '/api/orders/quote', quoteBody('addr_p2', 'cash')))).quote;
  assert.equal(quote.lines[0].unit_price_iqd, 150_000);
  assert.equal(quote.tier.pro_benefits_context, false);
  assert.equal(quote.tier.active, true);

  // The PRO at the approved default address: all three surfaces waive it.
  cartLine(raw, 'ci2', 'pro', 'p_a1', '');
  const p = appAs(db, 'pro');
  const pDetail = await json(await p.request('/api/products/a1'));
  assert.equal(pDetail.pricing.unit_subtotal_iqd, 100_000);
  assert.deepEqual(pDetail.viewer_tier, { tier: 'pro', active: true, pricing_active: true, pro_benefits_context: true });
  assert.deepEqual(pDetail.pricing_modes.direct, { unit_subtotal_iqd: 100_000, direct: { surcharge_iqd: 50_000, waived: true } });
  const pModes = (await json(await post(p, '/api/products/a1/quote', { qty: 1 }))).pricing_modes;
  assert.deepEqual(
    pModes.preorder.map((m: QuoteMode) => [m.prepaid!.unit_subtotal_iqd, m.cod!.unit_subtotal_iqd, m.cod_reprices]),
    [[100_000, 100_000, false]],
    'exempt from both fees, cash changes nothing for a PRO — so no hint'
  );
  assert.equal((await json(await p.request('/api/cart'))).items[0].unit_price_iqd, 100_000);
  assert.equal((await json(await post(p, '/api/orders/quote', quoteBody('addr_p', 'cash')))).quote.lines[0].unit_price_iqd, 100_000);
});

test('POST /api/orders — a pre-order paid cash on delivery: direct pricing, still preorder_sea with fourteen stages, no gift', async () => {
  const { db, raw } = setup();
  cartLine(raw, 'ci1', 'buyer', 'p_a1', 'sea');
  const a = appAs(db, 'buyer');

  const res = await post(a, '/api/orders', orderBody('addr_b', 'cash'));
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  const order = body.order;
  assert.equal(order.shipping_type, 'preorder_sea');
  assert.equal(order.payment_method_id, 'cash');
  assert.equal(order.subtotal_iqd, 150_000);
  assert.equal(order.total_iqd, 155_000);
  assert.equal(order.due_on_delivery_iqd, 155_000);
  assert.equal(order.membership_gift, null, 'a COD pre-order earns no prepaid gift');
  assert.equal(order.financial.merchandise_iqd, 100_000);
  assert.equal(order.financial.fees_iqd, 50_000, 'the direct premium is the fee, not the commission');

  const item = order.items[0];
  assert.equal(item.unit_price_iqd, 150_000);
  assert.equal(item.is_printer, false);
  assert.equal(item.pricing.pricing_basis, 'direct');
  assert.deepEqual(item.pricing.direct, { surcharge_iqd: 50_000, waived: false });
  assert.deepEqual(item.transport, { method: 'sea', commission_iqd: 15_000, waived: true, waived_by: 'cod_direct_pricing' });
  assert.equal(item.selection.transport_method, 'sea', '"buy again" repeats the pre-order line');
  assert.ok(!JSON.stringify(body).toLowerCase().includes('cost'), 'no cost field reaches the buyer');

  // The stored row and the stage machine agree: a pre-order journey.
  const row = raw.prepare('SELECT shipping_type, stage FROM orders WHERE id = ?').get(order.id) as { shipping_type: string; stage: string };
  assert.equal(row.shipping_type, 'preorder_sea');
  assert.equal(row.stage, 'received');
  assert.equal(stagesFor('preorder_sea').length, 14);
  const tracking = await json(await a.request(`/api/orders/${order.id}/tracking?lang=en`));
  assert.equal(tracking.shipping_type, 'preorder_sea');
  assert.equal(tracking.steps.length, 14);

  // The invoice explains the line the same way.
  const inv = raw.prepare('SELECT snapshot FROM invoices WHERE order_id = ? AND revision = 1').get(order.id) as { snapshot: string } | undefined;
  assert.ok(inv, 'an invoice was issued');
  const line = JSON.parse(inv!.snapshot).lines[0];
  assert.equal(line.transport_commission_iqd, 0);
  assert.equal(line.direct_surcharge_iqd, 50_000);
  assert.equal(line.unit_price_iqd, 150_000);
  await Promise.allSettled(pending);
});

test('POST /api/orders — a pre-order paid from the wallet keeps the commission pricing', async () => {
  const { db, raw } = setup();
  cartLine(raw, 'ci1', 'buyer', 'p_a1', 'sea');
  const a = appAs(db, 'buyer');
  const res = await post(a, '/api/orders', orderBody('addr_b', 'wallet', { useWallet: true }));
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  const order = body.order;
  assert.equal(order.shipping_type, 'preorder_sea');
  assert.equal(order.subtotal_iqd, 115_000);
  assert.equal(order.total_iqd, 120_000);
  assert.equal(order.wallet_applied_iqd, 120_000);
  assert.equal(order.due_on_delivery_iqd, 0);
  assert.equal(order.items[0].pricing.pricing_basis, 'preorder');
  assert.equal(order.items[0].pricing.direct, null);
  assert.deepEqual(order.items[0].transport, { method: 'sea', commission_iqd: 15_000, waived: false });
  assert.equal(order.financial.fees_iqd, 15_000, 'the commission is the fee');
  // No PRO context → no gift, whatever the payment method.
  assert.equal(order.membership_gift, null);
  await Promise.allSettled(pending);
});

// -------------------------------------------------------------- PRO context

test('PRO at the approved address: prepaid pre-order waives the commission and earns the gift; cash waives the premium and earns none', async () => {
  const { db, raw } = setup();
  raw.exec(
    `INSERT INTO admin_settings (key, value) VALUES ('preorderGiftConfig', '{"enabled":true,"product_id":"p_pla","label_ar":"بكرة PLA","qty":1}')`
  );
  cartLine(raw, 'ci1', 'pro', 'p_a1', 'sea');
  const a = appAs(db, 'pro');

  // Prepaid: 100,000 + 0 (commission waived by PRO); delivery waived (merchandise > 75,000 at the approved address).
  const prepaid = (await json(await post(a, '/api/orders/quote', quoteBody('addr_p', 'wallet', { useWallet: true })))).quote;
  assert.equal(prepaid.tier.pro_benefits_context, true);
  assert.equal(prepaid.lines[0].unit_price_iqd, 100_000);
  assert.equal(prepaid.pricing_basis, 'preorder');
  assert.deepEqual(prepaid.lines[0].breakdown.transport, { method: 'sea', commission_iqd: 15_000, waived: true, waived_by: 'pro' });
  assert.equal(prepaid.shipping.total_iqd, 0);

  // Cash: priced as direct → the premium APPLIES but PRO is exempt → base only.
  const cash = (await json(await post(a, '/api/orders/quote', quoteBody('addr_p', 'cash')))).quote;
  assert.equal(cash.lines[0].unit_price_iqd, 100_000);
  assert.equal(cash.pricing_basis, 'direct');
  assert.deepEqual(cash.lines[0].breakdown.direct, { surcharge_iqd: 50_000, waived: true });
  assert.equal(cash.lines[0].breakdown.transport.waived_by, 'cod_direct_pricing');

  // Place the prepaid one: the gift is frozen on the order.
  const placed = await json(await post(a, '/api/orders', orderBody('addr_p', 'wallet', { useWallet: true })));
  assert.equal(placed.success, true, JSON.stringify(placed));
  assert.equal(placed.order.shipping_type, 'preorder_sea');
  assert.equal(placed.order.due_on_delivery_iqd, 0);
  assert.equal(placed.order.membership_gift?.reason, 'pro_prepaid_preorder');
  assert.equal(placed.order.membership_gift?.value_iqd, 0);

  // A second pre-order, cash this time: same journey, no gift (money is due at the door).
  cartLine(raw, 'ci2', 'pro', 'p_a1', 'sea');
  const cod = await json(await post(a, '/api/orders', orderBody('addr_p', 'cash')));
  assert.equal(cod.success, true, JSON.stringify(cod));
  assert.equal(cod.order.shipping_type, 'preorder_sea');
  assert.equal(cod.order.subtotal_iqd, 100_000);
  assert.equal(cod.order.due_on_delivery_iqd, 100_000);
  assert.equal(cod.order.membership_gift, null);
  assert.equal(cod.order.items[0].pricing.pricing_basis, 'direct');
  assert.equal(cod.order.items[0].pricing.direct.waived, true);
  await Promise.allSettled(pending);
});

// ------------------------------------------------------------ refused ids

test('half_advance is refused with 400 PAYMENT_METHOD_NOT_ALLOWED and the offered list; full_advance is tolerated', async () => {
  const { db, raw } = setup();
  cartLine(raw, 'ci1', 'buyer', 'p_a1', 'sea');
  const a = appAs(db, 'buyer');

  const q = await post(a, '/api/orders/quote', quoteBody('addr_b', 'half_advance'));
  assert.equal(q.status, 400);
  const qb = await json(q);
  assert.equal(qb.code, PAYMENT_METHOD_NOT_ALLOWED);
  assert.deepEqual(qb.details.allowed_payment_methods, ['wallet', 'cash']);
  assert.equal(qb.details.shipping_type, 'preorder_sea');

  const o = await post(a, '/api/orders', orderBody('addr_b', 'half_advance', { useWallet: true }));
  assert.equal(o.status, 400);
  assert.equal((await json(o)).code, PAYMENT_METHOD_NOT_ALLOWED);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM orders WHERE user_id = 'buyer'").get()!.n, 0, 'nothing was written');

  // The legacy alias still prices as pay-in-advance.
  const fa = (await json(await post(a, '/api/orders/quote', quoteBody('addr_b', 'full_advance')))).quote;
  assert.equal(fa.pricing_basis, 'preorder');
  assert.equal(fa.wallet.required_advance_iqd, 120_000);
  // An id the settings do not list at all is still the old refusal.
  assert.equal((await post(a, '/api/orders/quote', quoteBody('addr_b', 'bitcoin'))).status, 400);
});

// ------------------------------------------------------------- direct cart

test('a direct cart: cash and wallet are both allowed, the premium is charged (not for PRO), five stages', async () => {
  const { db, raw } = setup();
  cartLine(raw, 'ci1', 'buyer', 'p_a1', '');
  cartLine(raw, 'ci2', 'pro', 'p_a1', '');
  const buyer = appAs(db, 'buyer');

  const cash = (await json(await post(buyer, '/api/orders/quote', quoteBody('addr_b', 'cash')))).quote;
  assert.equal(cash.shipping_type, 'direct');
  assert.equal(cash.pricing_basis, 'direct');
  assert.equal(cash.lines[0].unit_price_iqd, 150_000);
  assert.equal(cash.lines[0].breakdown.transport, null);
  assert.deepEqual(cash.lines[0].breakdown.direct, { surcharge_iqd: 50_000, waived: false });
  assert.deepEqual(cash.allowed_payment_methods, ['wallet', 'cash']);

  const wallet = (await json(await post(buyer, '/api/orders/quote', quoteBody('addr_b', 'wallet', { useWallet: true })))).quote;
  assert.equal(wallet.lines[0].unit_price_iqd, 150_000, 'the payment method never changes a direct line');
  assert.equal(wallet.due_on_delivery_iqd, 0);

  const placed = await json(await post(buyer, '/api/orders', orderBody('addr_b', 'cash')));
  assert.equal(placed.success, true, JSON.stringify(placed));
  assert.equal(placed.order.shipping_type, 'direct');
  assert.equal(placed.order.items[0].transport, null);
  assert.equal(stagesFor('direct').length, 5);
  const tracking = await json(await buyer.request(`/api/orders/${placed.order.id}/tracking?lang=en`));
  assert.equal(tracking.steps.length, 5);

  // PRO: exempt from the premium on a direct line too.
  const pro = (await json(await post(appAs(db, 'pro'), '/api/orders/quote', quoteBody('addr_p', 'cash')))).quote;
  assert.equal(pro.lines[0].unit_price_iqd, 100_000);
  assert.deepEqual(pro.lines[0].breakdown.direct, { surcharge_iqd: 50_000, waived: true });
  await Promise.allSettled(pending);
});

test('an eligible PRO checkout finances with BNPL and freezes the 12-hour fulfilment SLA on the order', async () => {
  const { db, raw } = setup();
  raw.exec(`
    INSERT INTO kyc_cases (id,user_id,state,decided_at)
      VALUES ('kyc_pro','pro','verified','2026-01-01T00:00:00.000Z');
    INSERT INTO bnpl_accounts (user_id,state,credit_limit_iqd,approved_by)
      VALUES ('pro','approved',300000,'boss');
  `);
  cartLine(raw, 'ci_pro_bnpl', 'pro', 'p_a1', '');
  const pro = appAs(db, 'pro');
  const quote = (await json(await post(
    pro,
    '/api/orders/quote',
    quoteBody('addr_p', 'bnpl', { deliveryMethodId: 'personal' })
  ))).quote;
  assert.deepEqual(quote.allowed_payment_methods, ['wallet', 'cash', 'bnpl']);
  assert.equal(quote.bnpl.eligible, true);
  assert.equal(quote.bnpl.financed_iqd, 100_000);
  assert.equal(quote.due_on_delivery_iqd, 0);
  assert.equal(quote.shipping.total_iqd, 0, 'eligible PRO delivery is waived at the approved address');
  assert.equal(quote.priority_delivery.eligible, true);
  assert.equal(quote.priority_delivery.max_hours, 12);

  const placed = await json(await post(
    pro,
    '/api/orders',
    orderBody('addr_p', 'bnpl', { deliveryMethodId: 'personal' })
  ));
  assert.equal(placed.success, true, JSON.stringify(placed));
  assert.equal(placed.order.payment_method_id, 'bnpl');
  assert.equal(placed.order.fulfillment_service, 'pro_priority_12h');
  assert.equal(placed.order.priority, 1);
  assert.ok(placed.order.priority_due_at);
  assert.equal(placed.order.bnpl_due_iqd, 100_000);
  assert.ok(placed.order.bnpl_due_at);
  assert.equal(placed.order.due_on_delivery_iqd, 0);
  assert.equal(placed.order.financial.payment_state, 'bnpl_due');
  assert.equal(
    (raw.prepare("SELECT amount_iqd FROM bnpl_ledger WHERE order_id=? AND kind='charge'").get(placed.order.id) as { amount_iqd: number }).amount_iqd,
    100_000
  );
  const stored = raw.prepare('SELECT fulfillment_service, priority_due_at, bnpl_due_iqd FROM orders WHERE id=?')
    .get(placed.order.id) as { fulfillment_service: string; priority_due_at: string; bnpl_due_iqd: number };
  assert.equal(stored.fulfillment_service, 'pro_priority_12h');
  assert.ok(stored.priority_due_at);
  assert.equal(stored.bnpl_due_iqd, 100_000);
  await Promise.allSettled(pending);
});

test('forged BNPL payment ids are rejected for PLUS and PREMIUM even with approval records', async () => {
  const { db, raw } = setup();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash) VALUES
      ('plus_bnpl','Plus','plus-bnpl@x.co','h'),
      ('premium_bnpl','Premium','premium-bnpl@x.co','h');
    INSERT INTO addresses (id,user_id,label,name,phone,address,is_default) VALUES
      ('addr_plus_bnpl','plus_bnpl','Home','Plus','+9647700000001','Baghdad Plus',1),
      ('addr_premium_bnpl','premium_bnpl','Home','Premium','+9647700000002','Baghdad Premium',1);
    INSERT INTO approved_addresses
      (id,user_id,version,name,phone_e164,address,state,source_address_id,approved_by,approved_at) VALUES
      ('ap_plus_bnpl','plus_bnpl',1,'Plus','+9647700000001','Baghdad Plus','approved','addr_plus_bnpl','boss','2026-01-01T00:00:00.000Z'),
      ('ap_premium_bnpl','premium_bnpl',1,'Premium','+9647700000002','Baghdad Premium','approved','addr_premium_bnpl','boss','2026-01-01T00:00:00.000Z');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at) VALUES
      ('m_plus_bnpl','plus_bnpl','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z'),
      ('m_premium_bnpl','premium_bnpl','prime_12mo','prime','active',12,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z');
    INSERT INTO kyc_cases (id,user_id,state,decided_at) VALUES
      ('kyc_plus_bnpl','plus_bnpl','verified','2026-01-01T00:00:00.000Z'),
      ('kyc_premium_bnpl','premium_bnpl','verified','2026-01-01T00:00:00.000Z');
    INSERT INTO bnpl_accounts (user_id,state,credit_limit_iqd,approved_by) VALUES
      ('plus_bnpl','approved',300000,'boss'),
      ('premium_bnpl','approved',300000,'boss');
  `);
  cartLine(raw, 'ci_plus_bnpl', 'plus_bnpl', 'p_a1', '');
  cartLine(raw, 'ci_premium_bnpl', 'premium_bnpl', 'p_a1', '');

  for (const [user, addressId] of [['plus_bnpl', 'addr_plus_bnpl'], ['premium_bnpl', 'addr_premium_bnpl']] as const) {
    const a = appAs(db, user);
    const open = (await json(await post(a, '/api/orders/quote', quoteBody(addressId, undefined)))).quote;
    assert.deepEqual(open.allowed_payment_methods, ['wallet', 'cash']);
    const refused = await post(a, '/api/orders', orderBody(addressId, 'bnpl'));
    const body = await json(refused);
    assert.equal(refused.status, 400);
    assert.equal(body.code, 'PRO_REQUIRED');
  }
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM orders WHERE payment_method_id='bnpl'").get() as { n: number }).n, 0);
});

// ------------------------------------------------------------ printer note

test('the printer note: is_printer on the quote lines and the order items, the amount echoed only for a home delivery', async () => {
  const { db, raw } = setup();
  cartLine(raw, 'ci1', 'buyer', 'p_x1', '');
  const a = appAs(db, 'buyer');

  const cart = await json(await a.request('/api/cart'));
  assert.equal(cart.items[0].is_printer, true);

  const home = (await json(await post(a, '/api/orders/quote', quoteBody('addr_b', 'cash')))).quote;
  assert.equal(home.lines[0].is_printer, true);
  assert.equal(home.notes.printer_home_delivery_iqd, 50_000, 'the owner’s default, from settings');
  assert.equal(home.cod_tax_iqd, 6_000, 'COD delivery tax is a separate server-calculated line');
  assert.equal(home.total_iqd, 899_000 + 5_000 + 6_000, 'the printer note is NOT added to the total');

  const pickup = (await json(await post(a, '/api/orders/quote', quoteBody('addr_b', 'cash', { deliveryMethodId: 'pickup' })))).quote;
  assert.equal(pickup.lines[0].is_printer, true);
  assert.equal(pickup.notes.printer_home_delivery_iqd, null, 'no home delivery, no note');

  const placed = await json(await post(a, '/api/orders', orderBody('addr_b', 'cash')));
  assert.equal(placed.success, true, JSON.stringify(placed));
  assert.equal(placed.order.items[0].is_printer, true);
  assert.equal(placed.order.cod_tax_iqd, 6_000);
  assert.equal(placed.order.total_iqd, 910_000);
  const detail = await json(await a.request(`/api/orders/${placed.order.id}`));
  assert.equal(detail.order.items[0].is_printer, true);
  assert.equal(detail.order.cod_tax_iqd, 6_000, 'persisted order details use the COD tax snapshot');

  // The owner can change or clear the amount; a cleared amount means no note.
  raw.exec("INSERT INTO admin_settings (key, value) VALUES ('printerHomeDeliveryNoteIqd', '75000')");
  cartLine(raw, 'ci2', 'buyer', 'p_x1', '');
  const changed = (await json(await post(a, '/api/orders/quote', quoteBody('addr_b', 'cash')))).quote;
  assert.equal(changed.notes.printer_home_delivery_iqd, 75_000);
  raw.exec("UPDATE admin_settings SET value = '0' WHERE key = 'printerHomeDeliveryNoteIqd'");
  const cleared = (await json(await post(a, '/api/orders/quote', quoteBody('addr_b', 'cash')))).quote;
  assert.equal(cleared.notes.printer_home_delivery_iqd, null);
  await Promise.allSettled(pending);
});

test('a non-printer cart never carries the note, and the public settings expose the amount', async () => {
  const { db, raw } = setup();
  cartLine(raw, 'ci1', 'buyer', 'p_pla', '');
  const a = appAs(db, 'buyer');
  const q = (await json(await post(a, '/api/orders/quote', quoteBody('addr_b', 'cash')))).quote;
  assert.equal(q.lines[0].is_printer, false);
  assert.equal(q.notes.printer_home_delivery_iqd, null);
});
