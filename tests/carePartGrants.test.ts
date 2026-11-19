/**
 * PRINTER SERVICES PHASE 5 — THE LEVO CARE PART OFFER (owner request 2026-11-18; DECISIONS row 358;
 * migration 0243).
 *
 * Staff answer a Care claim with a discount on ONE store part; the customer orders it like any part and the
 * discount applies by itself. Pinned here: who may issue and every refusal; the product card the claim thread
 * draws; the discount is the same figure in the cart, the quote and the order, on ONE unit, on the line's own
 * coupon discount; another account, another product, a second unit and a second order get nothing; a cancel
 * gives the offer back; revoke; expiry; the caps (the money ceiling as the offer's ceiling, the claim limit,
 * a used offer counted in the device's Care caps); a typed code and a Care offer together; and a database
 * without 0243 answers as before.
 *
 * Run: node --import tsx --test tests/carePartGrants.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, dbThrough, asD1, stubApp, get, post, patch, json, row, all, type StubUser } from './fixtures/app';
import { deviceRoutes } from '../worker/routes/devices';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';
import { adminRoutes } from '../worker/routes/admin';
import { CARE_REFUSALS } from '../worker/lib/careClaims';
import { allocateCareOffers, grantState, isCareCouponId, liveCareOffers, type LiveCareOffer } from '../worker/lib/carePartGrants';
import { blockingReferences } from '../worker/lib/productDeletion';
import { serviceClaimsSummary } from '../worker/lib/printerFinance';
import { baghdadDay } from '../worker/lib/operations';
import { resetPolicyCorpusMemo } from '../worker/lib/policySync';
import { REFUSAL_STRINGS } from '../src/lib/refusalStrings';
import { DEFAULT_PRINTER_SERVICES, type CareTerms } from '../packages/pricing/src/printerServices';
import { acceptedPolicies } from './lib/policies';

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

const BUYER: StubUser = { id: 'buyer', role: 'customer', email: 'sara@x.co' };
const OTHER: StubUser = { id: 'omar', role: 'customer', email: 'omar@x.co' };
const OWNER: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co' };
const FINANCE: StubUser = { id: 'staff', role: 'admin', email: 'staff@x.co', admin_scope: 'full' };
const ASSISTANT: StubUser = { id: 'helper', role: 'admin', email: 'helper@x.co', admin_scope: 'assistant' };

const TERMS: CareTerms = {
  eligible_parts: [{ key: 'nozzle', label: { ar: 'الفوهة', en: 'Nozzle', ckb: 'نۆزڵ' } }],
  discount_pct: 50,
  max_claims: 2,
  max_benefit_iqd: 30_000,
  labor: 'discounted',
  shipping: 'full_price',
  exclusions: [],
};
const care = (warranty: 0 | 12 | 24) =>
  JSON.stringify({
    lines: [{ service: 'care', choice: 'c12', fee_iqd: 19_000, policy_version: 1 }],
    fee_iqd: 19_000, package_discount_iqd: 0, warranty_months: warranty, care_months: 12, care_total_months: warranty + 12, revision: 1,
  });

/**
 * u1: Care only (no warranty) — an offer needs no misuse tick; u2: Care with a 12-month warranty in force —
 * misuse only; u3: no Care. Parts on sale: a nozzle (40,000) and a fan (20,000); a hidden part; a bundle.
 */
function seed(raw: DatabaseSync = freshDb(), opts: { maxPct?: number } = {}): DatabaseSync {
  resetPolicyCorpusMemo();
  const delivered = iso(Date.now() - 60 * DAY);
  const end = iso(Date.now() + 300 * DAY);
  raw.exec(`
    INSERT INTO users (id,name,email,username,password_hash,role,email_verified_at,locale,admin_scope) VALUES
      ('buyer','Sara','sara@x.co','sara','h','customer','2026-01-01T00:00:00.000Z','ar',NULL),
      ('omar','Omar','omar@x.co','omar','h','customer','2026-01-01T00:00:00.000Z','ar',NULL),
      ('boss','Owner','boss@x.co','boss','h','admin','2026-01-01T00:00:00.000Z','ar',NULL),
      ('staff','Staff','staff@x.co','staff','h','admin','2026-01-01T00:00:00.000Z','ar','full'),
      ('helper','Helper','helper@x.co','helper','h','admin','2026-01-01T00:00:00.000Z','ar','assistant');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default) VALUES
      ('addr_b','buyer','Home','Sara','+9647701234567','Baghdad, Karrada 12','',1),
      ('addr_o','omar','Home','Omar','+9647701234568','Baghdad, Mansour 3','',1);
    INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,selling_type,sale_types,warranty_plans,ops_policy,images) VALUES
      ('p_a1','a1-printer','Printer A1','طابعة A1','چاپکەری A1',840000,'active',5,'[]','[]','direct_sale','["direct_sale"]','[]','{}','[]'),
      ('p_nozzle','nozzle-04','Nozzle 0.4','فوهة 0.4','نۆزڵی 0.4',40000,'active',50,'[]','[]','direct_sale','["direct_sale"]','[]','{}','["/files/products/nozzle.webp"]'),
      ('p_fan','fan-5015','Fan 5015','مروحة 5015','پانکەی 5015',20000,'active',50,'[]','[]','direct_sale','["direct_sale"]','[]','{}','[]'),
      ('p_hidden','old-part','Old part','قطعة قديمة','پارچەی کۆن',15000,'hidden',5,'[]','[]','direct_sale','["direct_sale"]','[]','{}','[]');
    INSERT INTO catalogs (id, slug, name_ar, is_printer_catalog) VALUES ('cat_p','test-cpg-printers','طابعات',1), ('cat_s','test-cpg-spares','قطع',0);
    INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES ('p_a1','cat_p',0), ('p_nozzle','cat_s',0), ('p_fan','cat_s',1);
    INSERT INTO orders (id, user_id, status, address_snapshot, delivery_method_id, delivery_method_snapshot,
       payment_method_id, subtotal_iqd, shipping_iqd, exchange_rate, total_iqd, due_on_delivery_iqd, delivered_at)
     VALUES ('ORD-1','buyer','delivered','{}','standard','{}','cash',2720000,0,1400,2720000,0,'${delivered}');
    INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_iqd, line_total_iqd) VALUES
      ('oi1','ORD-1','p_a1','Printer A1',1,859000,859000), ('oi2','ORD-1','p_a1','Printer A1',1,840000,840000),
      ('oi3','ORD-1','p_a1','Printer A1',1,884000,884000);
    INSERT INTO order_item_units (id, order_id, order_item_id, product_id, owner_user_id, unit_index,
       delivered_at, warranty_base_months, warranty_start_at, warranty_end_at) VALUES
      ('u1','ORD-1','oi1','p_a1','buyer',1,'${delivered}',0,'${delivered}','${delivered}'),
      ('u2','ORD-1','oi3','p_a1','buyer',1,'${delivered}',12,'${delivered}','${end}'),
      ('u3','ORD-1','oi2','p_a1','buyer',1,'${delivered}',0,'${delivered}','${delivered}');
    INSERT INTO device_registrations (unit_id, user_id) VALUES ('u1','buyer'), ('u2','buyer'), ('u3','buyer');
  `);
  raw.prepare('UPDATE order_items SET services_snapshot = ? WHERE id = ?').run(care(0), 'oi1');
  raw.prepare('UPDATE order_items SET services_snapshot = ? WHERE id = ?').run(care(12), 'oi3');
  raw.prepare('INSERT INTO printer_care_policies (policy_version, terms, published_at, published_by) VALUES (1, ?, ?, ?)').run(JSON.stringify(TERMS), iso(Date.now()), 'boss');
  if (opts.maxPct !== undefined) {
    const live = { ...DEFAULT_PRINTER_SERVICES, revision: 1, care: { ...DEFAULT_PRINTER_SERVICES.care, max_discount_pct: opts.maxPct } };
    raw.prepare('INSERT INTO admin_settings (key, value) VALUES (?, ?)').run(
      'printerServices', JSON.stringify({ draft: live, published: live, published_at: '2026-11-17T00:00:00.000Z', published_by: 'boss' })
    );
  }
  return raw;
}

const as = (raw: DatabaseSync, who: StubUser) =>
  stubApp(asD1(raw), who, (a) => {
    a.route('/api/devices', deviceRoutes);
    a.route('/api/cart', cartRoutes);
    a.route('/api/orders', orderRoutes);
    a.route('/api/admin', adminRoutes);
  }, { env: { APP_ORIGIN: 'https://levonis-iq.com', STORE_ROOT_DOMAIN: 'levonis-iq.com' } });

let seq = 0;
async function file(raw: DatabaseSync, unit = 'u1', kind?: 'care') {
  const res = await json(await post(as(raw, BUYER), `/api/devices/units/${unit}/claims`, {
    subject: 'Bent nozzle', description: 'I dropped the hotend and the nozzle bent.', idempotencyKey: `cpg-claim-${unit}-${++seq}`, ...(kind ? { kind } : {}),
  }));
  assert.equal(res.success, true, JSON.stringify(res));
  return res.id as string;
}
const offer = (raw: DatabaseSync, who: StubUser, claim: string, body: Record<string, unknown>) => post(as(raw, who), `/api/devices/admin/claims/${claim}/part-grants`, body);
async function issue(raw: DatabaseSync, claim: string, body: Record<string, unknown> = { product_id: 'p_nozzle', discount_pct: 50 }) {
  const res = await json(await offer(raw, FINANCE, claim, body));
  assert.equal(res.success, true, JSON.stringify(res));
  return res;
}
const orderBody = (who: StubUser, over: Record<string, unknown> = {}) => ({
  addressId: who.id === 'buyer' ? 'addr_b' : 'addr_o',
  deliveryMethodId: 'standard',
  paymentMethodId: 'cash',
  useWallet: false,
  usePoints: false,
  itemIds: [],
  idempotencyKey: `cpg-order-${++seq}-${Math.random().toString(36).slice(2, 8)}`,
  policyAcceptance: acceptedPolicies(),
  ...over,
});
async function add(raw: DatabaseSync, who: StubUser, productId: string, qty = 1) {
  const res = await post(as(raw, who), '/api/cart/items', { productId, qty });
  assert.equal(res.status, 200, JSON.stringify(await json(res.clone())));
  return json(res);
}
const cart = async (raw: DatabaseSync, who: StubUser) => json(await get(as(raw, who), '/api/cart'));
const quote = async (raw: DatabaseSync, who: StubUser, over: Record<string, unknown> = {}) => {
  const res = await json(await post(as(raw, who), '/api/orders/quote', orderBody(who, over)));
  // The quote itself, with the envelope's verdict beside it (a refusal has no quote).
  return { ...(res.quote ?? {}), success: res.success, code: res.code } as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
};
async function order(raw: DatabaseSync, who: StubUser, over: Record<string, unknown> = {}) {
  const res = await json(await post(as(raw, who), '/api/orders', orderBody(who, over)));
  assert.equal(res.success, true, JSON.stringify(res));
  return res;
}
const orderIdOf = (res: Record<string, unknown>) => String((res.order as { id?: unknown } | undefined)?.id ?? res.id ?? res.order_id);

// ------------------------------------------------------------------ the pure arithmetic

test('one offer takes its percent off ONE unit, never more than its ceiling or what the line has left', () => {
  const o = (over: Partial<LiveCareOffer> = {}): LiveCareOffer => ({
    grant_id: 'g1', claim_id: 'c1', product_id: 'p', coupon_id: 'cpc_1', discount_pct: 50, max_discount_iqd: null, expires_at: '2099-01-01T00:00:00.000Z', ...over,
  });
  const line = (over: Record<string, unknown> = {}) => ({ line_id: 'l1', tie_key: 'ci1', product_id: 'p', qty: 3, unit_goods_iqd: 40_000, taken_iqd: 0, ...over });
  assert.deepEqual(allocateCareOffers([o()], [line()]).map((a) => [a.line_id, a.discount_iqd]), [['l1', 20_000]], 'one unit of three');
  assert.equal(allocateCareOffers([o({ max_discount_iqd: 7_000 })], [line()])[0].discount_iqd, 7_000, 'the ceiling');
  assert.equal(allocateCareOffers([o({ discount_pct: 33 })], [line({ unit_goods_iqd: 999 })])[0].discount_iqd, 329, 'floors');
  assert.deepEqual(allocateCareOffers([o()], [line({ product_id: 'other' })]), [], 'another product gets nothing');
  assert.deepEqual(allocateCareOffers([o({ max_discount_iqd: 0 })], [line()]), [], 'a spent ceiling applies nothing');
  // A typed code already took its share of the unit: the percent is of what the unit costs AFTER it.
  assert.equal(allocateCareOffers([o()], [line({ qty: 1, taken_iqd: 30_000 })])[0].discount_iqd, 5_000);
  assert.equal(allocateCareOffers([o()], [line({ qty: 1, taken_iqd: 24_000 })])[0].discount_iqd, 8_000, '60% code + 50% Care on 40,000 = 24,000 + 8,000');
  assert.equal(allocateCareOffers([o()], [line({ qty: 3, taken_iqd: 72_000 })])[0].discount_iqd, 8_000, 'the code’s share of ONE unit');
  assert.deepEqual(allocateCareOffers([o({ discount_pct: 90 })], [line({ qty: 1, taken_iqd: 40_000 })]), [], 'nothing left of the unit: nothing applied');
  // THE DEVICE'S CAPS TODAY: its money ceiling across every offer of the order, and its claim limit.
  const dev = { entitlement_unit_id: 'u1', root_left_iqd: 25_000, root_claims_left: 1, claim_counted: false };
  const capped = allocateCareOffers(
    [o({ ...dev }), o({ ...dev, grant_id: 'g2', coupon_id: 'cpc_2', product_id: 'q' })],
    [line({ qty: 1 }), line({ line_id: 'l2', tie_key: 'ci2', product_id: 'q', qty: 1 })]
  );
  assert.deepEqual(capped.map((a) => a.discount_iqd), [20_000, 5_000], 'two offers of one device never pass its ceiling');
  assert.deepEqual(allocateCareOffers([o({ ...dev, root_left_iqd: 0 })], [line()]), [], 'a spent device ceiling applies nothing');
  const twoClaims = allocateCareOffers(
    [o({ ...dev, root_left_iqd: null }), o({ ...dev, root_left_iqd: null, grant_id: 'g2', coupon_id: 'cpc_2', claim_id: 'c2', product_id: 'q' })],
    [line({ qty: 1 }), line({ line_id: 'l2', tie_key: 'ci2', product_id: 'q', qty: 1 })]
  );
  assert.deepEqual(twoClaims.map((a) => a.grant_id), ['g1'], 'one claim left: the second claim’s offer waits');
  assert.equal(allocateCareOffers([o({ ...dev, root_claims_left: 0, claim_counted: true })], [line()]).length, 1, 'a claim already counted is not a new claim');
  assert.deepEqual(allocateCareOffers([o({ ...dev, root_claims_left: 0 })], [line()]), [], 'no claim left for a new claim');
  // Two offers on one product: one unit each, the first line in cart order first.
  const two = allocateCareOffers([o(), o({ grant_id: 'g2', coupon_id: 'cpc_2' })], [line({ line_id: 'l2', tie_key: 'ci2', qty: 1 }), line({ qty: 1 })]);
  assert.deepEqual(two.map((a) => [a.grant_id, a.line_id]), [['g1', 'l1'], ['g2', 'l2']]);
  assert.equal(allocateCareOffers([o(), o({ grant_id: 'g2', coupon_id: 'cpc_2' })], [line({ qty: 1 })]).length, 1, 'no second unit, no second discount');
  assert.equal(grantState({ used_order_id: null, revoked_at: null, expires_at: iso(Date.now() - 1) }), 'expired');
  assert.equal(grantState({ used_order_id: 'O1', revoked_at: null, expires_at: iso(Date.now() - 1) }), 'used');
  assert.equal(grantState({ used_order_id: null, revoked_at: iso(Date.now()), expires_at: iso(Date.now() + DAY) }), 'revoked');
});

test('every new refusal has a real ar / en / ckb sentence on the server and on the screens', () => {
  for (const code of ['CARE_PART_INVALID', 'CARE_PART_PCT_INVALID', 'CARE_PART_ALREADY_OFFERED', 'CARE_PART_LIMIT', 'CARE_PART_USED', 'CARE_CLAIM_LIMIT'] as const) {
    const t = CARE_REFUSALS[code];
    const screen = REFUSAL_STRINGS[code];
    assert.ok(t && screen, code);
    for (const lang of ['ar', 'en', 'ckb'] as const) assert.equal(screen[lang], t[lang], `${code}.${lang}`);
    assert.notEqual(t.ckb, t.ar);
    assert.notEqual(t.ckb, t.en);
  }
  assert.ok(!/year|سنة|ساڵ/.test(Object.values(CARE_REFUSALS.CARE_CLAIM_LIMIT).join(' ')), 'the Care period, not a year');
  const managed = REFUSAL_STRINGS.CARE_PART_COUPON_MANAGED;
  assert.ok(managed && managed.ar && managed.en && managed.ckb && managed.ckb !== managed.ar);
});

// ------------------------------------------------------------------ issuing

test('issuing: a financial admin offers a part; the claim becomes a Care claim; the thread carries the offer as a product card', async () => {
  const raw = seed();
  try {
    const id = await file(raw);
    // An assistant is refused at the door; nothing is written.
    const helper = await offer(raw, ASSISTANT, id, { product_id: 'p_nozzle', discount_pct: 50 });
    assert.equal(helper.status, 403);
    assert.equal((await json(helper)).code, 'FINANCIAL_SCOPE_REQUIRED');
    assert.equal(row<{ n: number }>(raw, 'SELECT COUNT(*) AS n FROM care_part_grants')!.n, 0);

    const res = await issue(raw, id, { product_id: 'p_nozzle', discount_pct: 50, note: 'Dropped hotend' });
    const g = res.grant;
    // Its ceiling is what it is worth at today's price (20,000 of the device's 30,000), not the whole remainder.
    assert.deepEqual([g.state, g.discount_pct, g.price_iqd, g.discount_iqd, g.after_iqd, g.max_discount_iqd], ['live', 50, 40_000, 20_000, 20_000, 20_000]);
    assert.deepEqual([g.product.id, g.product.slug, g.product.name_ar, g.product.name_ku, g.product.needs_choices, g.product.available], ['p_nozzle', 'nozzle-04', 'فوهة 0.4', 'نۆزڵی 0.4', false, true]);
    assert.ok(String(g.product.image).includes('nozzle.webp'), g.product.image);
    assert.deepEqual([g.misuse, g.note, g.created_by, g.revoked_at, g.used_order_id], [false, 'Dropped hotend', 'staff', null, null]);
    assert.ok(Math.abs(Date.parse(g.expires_at) - (Date.now() + 14 * DAY)) < 60_000, '14 days');
    assert.equal(res.claim.claim_kind, 'care');
    assert.deepEqual(res.part_grants.map((x: { id: string }) => x.id), [g.id]);
    assert.deepEqual(res.part_rules, { default_pct: 50, max_pct: 90, valid_days: 14, max_live: 5 });

    // The carrier: one personal coupon, this product, one unit, one use, never a typed code.
    const c = row<Record<string, unknown>>(raw, 'SELECT * FROM coupons WHERE id = ?', g.coupon_id)!;
    assert.ok(isCareCouponId(c.id));
    assert.deepEqual(
      [c.kind, c.value, c.scope, c.product_id, c.assigned_user_id, c.max_per_user, c.max_global, c.max_quantity, c.stacks, c.max_discount_iqd, c.active, c.ends_at],
      ['percent', 50, 'product', 'p_nozzle', 'buyer', 1, 1, 1, 1, 20_000, 1, g.expires_at]
    );
    assert.ok(row(raw, "SELECT 1 AS x FROM audit_log WHERE action = 'warranty.care_part_offered' AND target = ?", id) ?? row(raw, "SELECT 1 AS x FROM audit_log WHERE action = 'warranty.care_part_offered'"));

    // The customer: the offer on the claim, the staff message carrying it, the list's count. Never who issued it.
    const mine = await json(await get(as(raw, BUYER), `/api/devices/claims/${id}`));
    assert.equal(mine.claim.claim_kind, 'care');
    assert.equal(mine.care.part_grants.length, 1);
    const pub = mine.care.part_grants[0];
    assert.deepEqual([pub.id, pub.state, pub.price_iqd, pub.discount_iqd, pub.after_iqd, pub.product.slug], [g.id, 'live', 40_000, 20_000, 20_000, 'nozzle-04']);
    for (const k of ['created_by', 'note', 'coupon_id', 'misuse', 'revoked_by']) assert.equal(k in pub, false, `${k} is the desk's`);
    const carrying = mine.messages.filter((m: { part_grant_id: string | null }) => m.part_grant_id);
    assert.deepEqual(carrying.map((m: { part_grant_id: string; is_staff: boolean }) => [m.part_grant_id, m.is_staff]), [[g.id, true]]);
    assert.ok(carrying[0].body.includes('50%') && carrying[0].body.includes('نۆزڵی 0.4'), carrying[0].body);
    assert.ok(!JSON.stringify(mine).includes(String(c.code)), 'the code is never shown');
    const list = await json(await get(as(raw, BUYER), '/api/devices/claims'));
    assert.equal(list.claims.find((x: { id: string }) => x.id === id).part_offers_live, 1);
    // Someone else's claim is not there.
    assert.equal((await get(as(raw, OTHER), `/api/devices/claims/${id}`)).status, 404);
    // The promo-code list does not show the carrier, and it cannot be edited there.
    const coupons = await json(await get(as(raw, OWNER), '/api/admin/coupons'));
    assert.equal(coupons.coupons.some((x: { id: string }) => x.id === c.id), false);
  } finally {
    raw.close();
  }
});

test('issuing: every refusal', async () => {
  const raw = seed(undefined, { maxPct: 60 });
  try {
    const id = await file(raw);
    const code = async (who: StubUser, claim: string, body: Record<string, unknown>) => {
      const res = await offer(raw, who, claim, body);
      const j = await json(res);
      return [res.status, j.code, j.details ?? null];
    };
    // The percent: whole, 1..the PUBLISHED list's ceiling (60 here).
    for (const bad of [0, 61, 12.5, '50', undefined]) {
      assert.deepEqual(await code(FINANCE, id, { product_id: 'p_nozzle', discount_pct: bad }), [400, 'CARE_PART_PCT_INVALID', { max_pct: 60 }], String(bad));
    }
    // The product: unknown, hidden, a printer, a bundle.
    raw.exec("INSERT INTO products (id,slug,name,price_iqd,status,composition) VALUES ('p_bundle','starter-bundle','Starter bundle',90000,'active','bundle')");
    for (const bad of ['nope', 'p_hidden', 'p_a1', 'p_bundle']) {
      assert.deepEqual((await code(FINANCE, id, { product_id: bad, discount_pct: 50 })).slice(0, 2), [400, 'CARE_PART_INVALID'], bad);
    }
    assert.equal((await offer(raw, FINANCE, id, { product_id: 'p_nozzle', discount_pct: 50, note: 'x'.repeat(301) })).status, 400);
    assert.equal((await offer(raw, FINANCE, 'wc_nope', { product_id: 'p_nozzle', discount_pct: 50 })).status, 404);
    // The warranty in force at filing: Care only for misuse.
    const covered = await file(raw, 'u2');
    assert.deepEqual((await code(FINANCE, covered, { product_id: 'p_nozzle', discount_pct: 50 })).slice(0, 2), [409, 'CARE_NOT_WARRANTY']);
    const misuse = await issue(raw, covered, { product_id: 'p_nozzle', discount_pct: 50, misuse: true });
    assert.equal(misuse.grant.misuse, true);
    // No Care on the device.
    const bare = await file(raw, 'u3');
    assert.deepEqual(await code(FINANCE, bare, { product_id: 'p_nozzle', discount_pct: 50 }), [409, 'CARE_NOT_ACTIVE', { state: 'none' }]);
    // One live offer per (claim, product); at most five live offers on a claim.
    await issue(raw, id);
    assert.deepEqual((await code(FINANCE, id, { product_id: 'p_nozzle', discount_pct: 40 })).slice(0, 2), [409, 'CARE_PART_ALREADY_OFFERED']);
    for (let i = 0; i < 4; i++) {
      raw.exec(`INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,sale_types) VALUES ('p_x${i}','part-x${i}','Part ${i}','قطعة ${i}',10000,'active',5,'["direct_sale"]')`);
      await issue(raw, id, { product_id: `p_x${i}`, discount_pct: 10 });
    }
    assert.deepEqual((await code(FINANCE, id, { product_id: 'p_fan', discount_pct: 50 })).slice(0, 2), [409, 'CARE_PART_LIMIT']);
    // The database decides the same two, inside the write (two clicks at once).
    assert.throws(() => raw.exec(`INSERT INTO care_part_grants (id, claim_id, user_id, entitlement_unit_id, product_id, coupon_id, discount_pct, expires_at, created_by, created_at)
      VALUES ('cpg_race','${id}','buyer','u1','p_nozzle','cpc_race',50,'${iso(Date.now() + DAY)}','staff','${iso(Date.now())}')`), /CARE_PART_ALREADY_OFFERED/);
    assert.throws(() => raw.exec(`INSERT INTO care_part_grants (id, claim_id, user_id, entitlement_unit_id, product_id, coupon_id, discount_pct, expires_at, created_by, created_at)
      VALUES ('cpg_race','${id}','buyer','u1','p_fan','cpc_race',50,'${iso(Date.now() + DAY)}','staff','${iso(Date.now())}')`), /CARE_PART_LIMIT/);
    // A closed claim takes no offer.
    raw.exec(`UPDATE warranty_claims SET stage = 'resolved', status = 'approved' WHERE id = '${bare}'`);
    assert.deepEqual((await code(FINANCE, bare, { product_id: 'p_fan', discount_pct: 50 })).slice(0, 2), [409, 'CARE_CLAIM_NOT_OPEN']);
    // Terms never published.
    const raw2 = seed();
    try {
      raw2.exec('DROP TRIGGER trg_printer_care_policies_kept; DELETE FROM printer_care_policies;');
      const c2 = await file(raw2);
      const res = await json(await offer(raw2, FINANCE, c2, { product_id: 'p_nozzle', discount_pct: 50 }));
      assert.equal(res.code, 'CARE_TERMS_MISSING');
    } finally {
      raw2.close();
    }
  } finally {
    raw.close();
  }
});

test('the staff picker lists store parts that may be offered — never a printer, a bundle or a hidden product', async () => {
  const raw = seed();
  try {
    const all_ = await json(await get(as(raw, ASSISTANT), '/api/devices/admin/part-products'));
    assert.equal(all_.success, true, JSON.stringify(all_));
    assert.deepEqual(all_.products.map((p: { id: string }) => p.id).sort(), ['p_fan', 'p_nozzle']);
    const hit = await json(await get(as(raw, FINANCE), `/api/devices/admin/part-products?q=${encodeURIComponent('فوهة')}`));
    assert.deepEqual(hit.products.map((p: { id: string; price_iqd: number; slug: string }) => [p.id, p.price_iqd, p.slug]), [['p_nozzle', 40_000, 'nozzle-04']]);
    assert.equal((await get(as(raw, BUYER), '/api/devices/admin/part-products')).status, 403);
  } finally {
    raw.close();
  }
});

test('the staff picker never answers 500 because of ONE product the card builder cannot project (live: ?q=hotend)', async () => {
  const raw = seed();
  // A row whose stored pictures are not a list: the storefront's card builder throws on it (upgradeMedia).
  raw.exec(`INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,selling_type,sale_types,warranty_plans,ops_policy,images) VALUES
    ('p_hot_bad','hotends-combo','Hotends Combo','هوت إند','هۆتێند',0,'active',5,'[]','[]','direct_sale','["direct_sale"]','[]','{}','{"not":"a list"}'),
    ('p_hot_ok','hotend-04','Hotend 0.4','هوت إند 0.4','هۆتێندی 0.4',30000,'active',9,'[]','[]','direct_sale','["direct_sale"]','[]','{}','[]');
    INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES ('p_hot_bad','cat_s',5), ('p_hot_ok','cat_s',6);`);
  const logged: unknown[][] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => { logged.push(a); };
  try {
    for (const q of ['hotend', 'hot end', 'hot']) {
      const res = await get(as(raw, FINANCE), `/api/devices/admin/part-products?q=${encodeURIComponent(q)}`);
      assert.equal(res.status, 200, q);
    }
    const hit = await json(await get(as(raw, FINANCE), '/api/devices/admin/part-products?q=hotend'));
    const byId = new Map<string, { price_iqd: number | null; available: boolean; name: string }>(hit.products.map((p: { id: string }) => [p.id, p]));
    assert.deepEqual([byId.get('p_hot_bad')?.price_iqd, byId.get('p_hot_bad')?.available, byId.get('p_hot_bad')?.name], [null, false, 'Hotends Combo'], 'listed, not offerable');
    // The healthy neighbour is priced exactly as it is without the broken row beside it.
    const alone = (await json(await get(as(raw, FINANCE), '/api/devices/admin/part-products?q=hotend-04'))).products[0];
    assert.ok(alone, 'the healthy product answers alone');
    assert.deepEqual(byId.get('p_hot_ok'), alone);
    assert.ok(logged.some((l) => l.includes('p_hot_bad')), 'the log names the product');
    // The same guard serves the offer itself: the broken product reads as not on sale, never a 500.
    const id = await file(raw, 'u1', 'care');
    const refused = await offer(raw, FINANCE, id, { product_id: 'p_hot_bad', discount_pct: 50 });
    assert.ok(refused.status < 500, String(refused.status));
  } finally {
    console.error = realError;
    raw.close();
  }
});

// ------------------------------------------------------------------ the automatic discount

test('the discount applies by itself: cart = quote = order, on ONE unit, on the line; then never again', async () => {
  const raw = seed();
  try {
    const id = await file(raw, 'u1', 'care');
    const g = (await issue(raw, id)).grant;
    await add(raw, BUYER, 'p_nozzle', 2);
    await add(raw, BUYER, 'p_fan', 1);

    // The cart names the offer on its line (display only: the quote is the authority).
    const c = await cart(raw, BUYER);
    const nozzleLine = c.items.find((it: { productId: string }) => it.productId === 'p_nozzle');
    assert.deepEqual(c.care_offers, [{
      grant_id: g.id, claim_id: id, product_id: 'p_nozzle', cart_item_id: nozzleLine.id, discount_pct: 50, discount_iqd: 20_000, expires_at: g.expires_at,
    }]);

    // The quote: the same figure, inside the totals, reported like a coupon discount. The client sent nothing.
    const plain = await quote(raw, OTHER);
    assert.equal(plain.success, false, 'an empty cart has no quote');
    const q = await quote(raw, BUYER);
    assert.equal(q.success, true, JSON.stringify(q));
    assert.equal(q.care_offer_discount_iqd, 20_000);
    assert.deepEqual(q.care_offers.map((o: Record<string, unknown>) => [o.grant_id, o.product_id, o.cart_item_id, o.discount_iqd]), [[g.id, 'p_nozzle', nozzleLine.id, 20_000]]);
    assert.equal(q.coupon.discount_iqd, 20_000);
    assert.equal(q.coupon.coupon_id, null, 'no code of the order’s own');
    const goods = 2 * 40_000 + 20_000;
    assert.equal(q.total_iqd, goods - 20_000 + q.shipping.total_iqd);

    // The order: the same total; the line carries the discount; the use is recorded once.
    const o = await order(raw, BUYER);
    const orderId = orderIdOf(o);
    const stored = row<Record<string, unknown>>(raw, 'SELECT * FROM orders WHERE id = ?', orderId)!;
    assert.equal(stored.total_iqd, q.total_iqd, 'quote = order');
    const lines = all<{ product_id: string; qty: number; coupon_discount_iqd: number; line_total_iqd: number; id: string }>(raw, 'SELECT id, product_id, qty, coupon_discount_iqd, line_total_iqd FROM order_items WHERE order_id = ? ORDER BY product_id', orderId);
    assert.deepEqual(lines.map((l) => [l.product_id, l.qty, l.coupon_discount_iqd, l.line_total_iqd]), [['p_fan', 1, 0, 20_000], ['p_nozzle', 2, 20_000, 80_000]], 'one unit of two, on the part’s own line');
    const snap = JSON.parse(String(stored.coupon_snapshot));
    assert.deepEqual([snap.coupon_id, snap.discount_iqd, snap.merchandise_iqd, snap.delivery_iqd, snap.care_offer_discount_iqd], [null, 20_000, 20_000, 0, 20_000]);
    assert.deepEqual(snap.care_offers.map((x: Record<string, unknown>) => [x.grant_id, x.order_item_id, x.discount_iqd]), [[g.id, lines[1].id, 20_000]]);
    assert.equal(row<{ n: number }>(raw, 'SELECT COUNT(*) AS n FROM coupon_redemptions WHERE order_id = ?', orderId)!.n, 0, 'never the order’s own coupon');
    assert.deepEqual(all(raw, 'SELECT coupon_id, user_id, amount_iqd, state FROM coupon_redemption_extras WHERE order_id = ?', orderId), [{ coupon_id: g.coupon_id, user_id: 'buyer', amount_iqd: 20_000, state: 'active' }]);

    // The order views name it on its line; the claim shows the offer used, with what it gave.
    const view = await json(await get(as(raw, BUYER), `/api/orders/${orderId}`));
    const viewLines = (view.order?.items ?? view.items) as Array<{ product_id?: string; care_offer: unknown }>;
    assert.deepEqual(viewLines.map((l) => l.care_offer).filter(Boolean), [{ grant_id: g.id, discount_iqd: 20_000 }]);
    const mine = await json(await get(as(raw, BUYER), `/api/devices/claims/${id}`));
    assert.deepEqual([mine.care.part_grants[0].state, mine.care.part_grants[0].used_order_id, mine.care.part_grants[0].discount_given_iqd], ['used', orderId, 20_000]);
    assert.equal((await json(await get(as(raw, BUYER), '/api/devices/claims'))).claims.find((x: { id: string }) => x.id === id).part_offers_live, 0);

    // A second order gets nothing: the cart, the quote and the order are all at full price.
    await add(raw, BUYER, 'p_nozzle', 1);
    assert.deepEqual((await cart(raw, BUYER)).care_offers, []);
    const q2 = await quote(raw, BUYER);
    assert.deepEqual([q2.care_offers, q2.care_offer_discount_iqd, q2.coupon], [[], 0, null]);
    const o2 = await order(raw, BUYER);
    assert.deepEqual(all(raw, 'SELECT coupon_discount_iqd FROM order_items WHERE order_id = ?', orderIdOf(o2)), [{ coupon_discount_iqd: 0 }]);
    assert.equal(row<{ n: number }>(raw, 'SELECT COUNT(*) AS n FROM coupon_redemption_extras')!.n, 1);
    // The database refuses a second use whatever the code above it did.
    assert.throws(() => raw.exec(`INSERT INTO coupon_redemption_extras (id, coupon_id, user_id, order_id, amount_iqd) VALUES ('crx_again','${g.coupon_id}','buyer','${orderIdOf(o2)}',20000)`), /COUPON_GLOBAL_LIMIT/);
    assert.throws(() => raw.exec(`INSERT INTO coupon_redemptions (id, coupon_id, user_id, order_id, amount_iqd) VALUES ('crd_never','${g.coupon_id}','buyer','${orderIdOf(o2)}',20000)`), /COUPON_INACTIVE/);

    // A used offer is not revoked.
    const revoke = await post(as(raw, FINANCE), `/api/devices/admin/claims/${id}/part-grants/${g.id}/revoke`, { reason: 'Changed our mind' });
    assert.deepEqual([revoke.status, (await json(revoke)).code], [409, 'CARE_PART_USED']);

    // D5: the used offer counts in the device's Care caps — one claim, 20,000 of the 30,000 ceiling.
    const panel = await json(await get(as(raw, OWNER), `/api/devices/admin/claims/${id}/care`));
    assert.deepEqual([panel.care.used_claims, panel.care.used_benefit_iqd, panel.care.claims_left, panel.care.benefit_left_iqd], [1, 20_000, 1, 10_000]);
    assert.deepEqual(panel.care.used_excluding_this_claim, { claims: 0, benefit_iqd: 0 });
    // …and in the period's report, informational.
    const day = baghdadDay();
    const sum = (await serviceClaimsSummary(asD1(raw), { from: day, to: day }, { laborIqd: null }))!;
    assert.equal(sum.care_part_discount_iqd, 20_000);
  } finally {
    raw.close();
  }
});

test('never for another account, another product, or a line that is not an ordinary part line', async () => {
  const raw = seed();
  try {
    const id = await file(raw);
    const g = (await issue(raw, id)).grant;
    // Another account buys the same part: nothing, at any door.
    await add(raw, OTHER, 'p_nozzle', 1);
    assert.deepEqual((await cart(raw, OTHER)).care_offers, []);
    const qo = await quote(raw, OTHER);
    assert.deepEqual([qo.care_offers, qo.care_offer_discount_iqd], [[], 0]);
    const oo = await order(raw, OTHER);
    assert.deepEqual(all(raw, 'SELECT coupon_discount_iqd FROM order_items WHERE order_id = ?', orderIdOf(oo)), [{ coupon_discount_iqd: 0 }]);
    assert.deepEqual(await liveCareOffers(asD1(raw), 'omar'), []);
    assert.throws(() => raw.exec(`INSERT INTO coupon_redemption_extras (id, coupon_id, user_id, order_id, amount_iqd) VALUES ('crx_omar','${g.coupon_id}','omar','${orderIdOf(oo)}',20000)`), /COUPON_NOT_YOURS/);
    // The code itself, typed — by a stranger or by its own customer — is an unknown code.
    const code = row<{ code: string }>(raw, 'SELECT code FROM coupons WHERE id = ?', g.coupon_id)!.code;
    await add(raw, OTHER, 'p_nozzle', 1);
    for (const who of [OTHER, BUYER]) {
      if (who === BUYER) await add(raw, BUYER, 'p_fan', 1);
      const typed = await json(await post(as(raw, who), '/api/cart/coupon-check', { code }));
      assert.deepEqual([typed.valid, typed.reason], [false, 'CODE_NOT_FOUND'], JSON.stringify(typed));
    }
    // Its own customer with ANOTHER product in the cart: nothing (the offer stays live).
    assert.deepEqual((await cart(raw, BUYER)).care_offers, []);
    const qb = await quote(raw, BUYER);
    assert.deepEqual([qb.care_offers, qb.care_offer_discount_iqd], [[], 0]);
    assert.equal((await liveCareOffers(asD1(raw), 'buyer')).length, 1);
    // A line attached to a printer (a kit / add-on line) never takes it: the cart leaves it out.
    const fanLine = (await cart(raw, BUYER)).items[0].id;
    raw.exec(`INSERT INTO cart_items (id, user_id, product_id, qty, kit_parent_id, kit_id, kit_unit_qty, shipping_method_id) VALUES ('ci_kit','buyer','p_nozzle',1,'${fanLine}','kit_x',1,'kit:${fanLine}')`);
    const withKit = await cart(raw, BUYER);
    assert.ok(withKit.items.some((it: { id: string; kit_line?: unknown }) => it.id === 'ci_kit' && it.kit_line), 'the attached line is in the cart');
    assert.deepEqual(withKit.care_offers, [], 'and takes no Care offer');
  } finally {
    raw.close();
  }
});

test('a cancel before delivery gives the offer back; revoke and expiry end it', async () => {
  const raw = seed();
  try {
    const id = await file(raw);
    const g = (await issue(raw, id)).grant;
    await add(raw, BUYER, 'p_nozzle', 1);
    const o = await order(raw, BUYER);
    const orderId = orderIdOf(o);
    assert.equal((await liveCareOffers(asD1(raw), 'buyer')).length, 0);
    // Cancelled before delivery: the existing trigger releases the use and the offer is live again.
    raw.exec(`UPDATE orders SET status = 'cancelled', cancelled_at = '${iso(Date.now())}' WHERE id = '${orderId}'`);
    assert.deepEqual(all(raw, 'SELECT state FROM coupon_redemption_extras WHERE order_id = ?', orderId), [{ state: 'released' }]);
    const back = await json(await get(as(raw, BUYER), `/api/devices/claims/${id}`));
    assert.deepEqual([back.care.part_grants[0].state, back.care.part_grants[0].used_order_id], ['live', null]);
    const panel = await json(await get(as(raw, OWNER), `/api/devices/admin/claims/${id}/care`));
    assert.deepEqual([panel.care.used_claims, panel.care.used_benefit_iqd], [0, 0], 'the caps are given back too');
    // …and it applies again.
    await add(raw, BUYER, 'p_nozzle', 1);
    assert.equal((await quote(raw, BUYER)).care_offer_discount_iqd, 20_000);

    // Revoked: gone from every door; the coupon is switched off in the same write; a second revoke is quiet.
    assert.equal((await post(as(raw, ASSISTANT), `/api/devices/admin/claims/${id}/part-grants/${g.id}/revoke`, { reason: 'Wrong part' })).status, 403);
    assert.equal((await post(as(raw, FINANCE), `/api/devices/admin/claims/${id}/part-grants/${g.id}/revoke`, { reason: 'no' })).status, 400);
    const revoked = await json(await post(as(raw, FINANCE), `/api/devices/admin/claims/${id}/part-grants/${g.id}/revoke`, { reason: 'Wrong part offered' }));
    assert.equal(revoked.success, true, JSON.stringify(revoked));
    assert.deepEqual([revoked.part_grants[0].state, revoked.part_grants[0].revoked_by, revoked.part_grants[0].revoke_reason], ['revoked', 'staff', 'Wrong part offered']);
    assert.equal(row<{ active: number }>(raw, 'SELECT active FROM coupons WHERE id = ?', g.coupon_id)!.active, 0);
    assert.equal((await json(await post(as(raw, FINANCE), `/api/devices/admin/claims/${id}/part-grants/${g.id}/revoke`, { reason: 'Wrong part offered' }))).already, true);
    assert.deepEqual((await cart(raw, BUYER)).care_offers, []);
    assert.equal((await quote(raw, BUYER)).care_offer_discount_iqd, 0);
    assert.equal((await post(as(raw, FINANCE), `/api/devices/admin/claims/${id}/part-grants/cpg_nope/revoke`, { reason: 'Wrong part offered' })).status, 404);
    // A revoked offer frees its product: the same part may be offered again.
    const again = (await issue(raw, id, { product_id: 'p_nozzle', discount_pct: 25 })).grant;
    assert.equal((await quote(raw, BUYER)).care_offer_discount_iqd, 10_000);

    // Expired: «انتهى» — nothing applies, and the database refuses the use too.
    raw.exec('DROP TRIGGER trg_care_part_grant_frozen');
    raw.exec(`UPDATE care_part_grants SET expires_at = '${iso(Date.now() - 1000)}' WHERE id = '${again.id}'`);
    const ended = await json(await get(as(raw, BUYER), `/api/devices/claims/${id}`));
    assert.equal(ended.care.part_grants.find((x: { id: string }) => x.id === again.id).state, 'expired');
    assert.deepEqual((await cart(raw, BUYER)).care_offers, []);
    assert.equal((await quote(raw, BUYER)).care_offer_discount_iqd, 0);
    assert.throws(() => raw.exec(`INSERT INTO coupon_redemption_extras (id, coupon_id, user_id, order_id, amount_iqd) VALUES ('crx_late','${again.coupon_id}','buyer','${orderId}',10000)`), /COUPON_INACTIVE/);
  } finally {
    raw.close();
  }
});

test('the caps: the money left on the device is the offer’s ceiling; no claim left refuses the offer', async () => {
  const raw = seed();
  try {
    // An older Care claim on the device already used 22,000 of the 30,000 ceiling: 8,000 is left.
    raw.exec(`INSERT INTO warranty_claims (id, user_id, order_item_id, product_name, description, unit_id, stage, status, claim_kind)
              VALUES ('wc_old','buyer','oi1','Printer A1','old claim','u1','resolved','approved','care')`);
    raw.prepare(`INSERT INTO care_claim_benefits (id, claim_id, entitlement_unit_id, order_item_id, policy_version, quote_json, list_iqd, eligible_iqd,
                   discount_pct, benefit_iqd, copay_iqd, state, quoted_at, decided_at) VALUES ('ccb_old','wc_old','u1','oi1',1,'{}',44000,44000,50,22000,22000,'approved',?,?)`)
      .run(iso(Date.now() - 5 * DAY), iso(Date.now() - 4 * DAY));
    const id = await file(raw);
    const g = (await issue(raw, id)).grant;
    assert.deepEqual([g.max_discount_iqd, g.price_iqd, g.discount_iqd, g.after_iqd], [8_000, 40_000, 8_000, 32_000], '50% would be 20,000; 8,000 is left');
    await add(raw, BUYER, 'p_nozzle', 1);
    assert.equal((await cart(raw, BUYER)).care_offers[0].discount_iqd, 8_000);
    const q = await quote(raw, BUYER);
    assert.equal(q.care_offer_discount_iqd, 8_000);
    const o = await order(raw, BUYER);
    assert.deepEqual(all(raw, 'SELECT coupon_discount_iqd FROM order_items WHERE order_id = ?', orderIdOf(o)), [{ coupon_discount_iqd: 8_000 }]);
    const panel = await json(await get(as(raw, OWNER), `/api/devices/admin/claims/${id}/care`));
    assert.deepEqual([panel.care.used_claims, panel.care.used_benefit_iqd, panel.care.claims_left, panel.care.benefit_left_iqd], [2, 30_000, 0, 0]);
    assert.deepEqual(panel.care.used_excluding_this_claim, { claims: 1, benefit_iqd: 22_000 });
    // The same claim is not a new claim — but the device's money ceiling is used up: nothing is left to offer.
    const spent = await offer(raw, FINANCE, id, { product_id: 'p_fan', discount_pct: 50 });
    const spentBody = await json(spent);
    assert.deepEqual([spent.status, spentBody.code, spentBody.details], [409, 'CARE_CLAIM_LIMIT', { reason: 'money_ceiling', benefit_left_iqd: 0, reserved_iqd: 0 }]);
    // A NEW claim on the device: both claims are used — refused.
    raw.exec(`UPDATE warranty_claims SET stage = 'resolved', status = 'approved' WHERE id = '${id}'`);
    const third = await file(raw);
    const refused = await offer(raw, FINANCE, third, { product_id: 'p_fan', discount_pct: 50 });
    assert.deepEqual([refused.status, (await json(refused)).code], [409, 'CARE_CLAIM_LIMIT']);
  } finally {
    raw.close();
  }
});

test('a typed code and a Care offer together: each takes its own part; the code stays the order’s coupon', async () => {
  const raw = seed();
  try {
    raw.exec(`INSERT INTO coupons (id, code, kind, value, min_total_iqd, max_per_user, active) VALUES ('cp_ten','TEN','percent',10,0,5,1)`);
    const id = await file(raw);
    const g = (await issue(raw, id)).grant;
    await add(raw, BUYER, 'p_nozzle', 1);
    await add(raw, BUYER, 'p_fan', 1);
    const q = await quote(raw, BUYER, { couponCode: 'TEN' });
    assert.equal(q.success, true, JSON.stringify(q));
    // TEN: 10% of 60,000 = 6,000 (4,000 on the nozzle, 2,000 on the fan). Care: 50% of what the nozzle costs
    // AFTER the code (36,000) = 18,000 — the two never multiply into more than the unit.
    assert.deepEqual([q.coupon.coupon_id, q.coupon.code, q.coupon.discount_iqd, q.care_offer_discount_iqd], ['cp_ten', 'TEN', 24_000, 18_000]);
    assert.equal(q.total_iqd, 60_000 - 24_000 + q.shipping.total_iqd);
    const o = await order(raw, BUYER, { couponCode: 'TEN' });
    const orderId = orderIdOf(o);
    assert.equal(row<{ t: number }>(raw, 'SELECT total_iqd AS t FROM orders WHERE id = ?', orderId)!.t, q.total_iqd);
    assert.deepEqual(
      all(raw, 'SELECT product_id, coupon_discount_iqd FROM order_items WHERE order_id = ? ORDER BY product_id', orderId),
      [{ product_id: 'p_fan', coupon_discount_iqd: 2_000 }, { product_id: 'p_nozzle', coupon_discount_iqd: 22_000 }]
    );
    assert.deepEqual(all(raw, 'SELECT coupon_id, amount_iqd, state FROM coupon_redemptions WHERE order_id = ?', orderId), [{ coupon_id: 'cp_ten', amount_iqd: 6_000, state: 'active' }]);
    assert.deepEqual(all(raw, 'SELECT coupon_id, amount_iqd, state FROM coupon_redemption_extras WHERE order_id = ?', orderId), [{ coupon_id: g.coupon_id, amount_iqd: 18_000, state: 'active' }]);
    // The order's coupon figure and its lines agree: nothing is left as an order-level residual.
    const snap = JSON.parse(String(row<{ s: string }>(raw, 'SELECT coupon_snapshot AS s FROM orders WHERE id = ?', orderId)!.s));
    assert.deepEqual([snap.coupon_id, snap.discount_iqd, snap.merchandise_iqd, snap.care_offer_discount_iqd], ['cp_ten', 24_000, 24_000, 18_000]);
    assert.equal(row<{ s: number }>(raw, 'SELECT SUM(coupon_discount_iqd) AS s FROM order_items WHERE order_id = ?', orderId)!.s, snap.discount_iqd);
  } finally {
    raw.close();
  }
});

test('deleting the product: blocked while an offer on it is live, free once it is used, revoked or ended', async () => {
  const raw = seed();
  try {
    const id = await file(raw);
    const g = (await issue(raw, id)).grant;
    const blocked = await blockingReferences(asD1(raw) as never, 'p_nozzle');
    assert.equal(blocked?.code, 'PRODUCT_IN_CARE_PART_OFFER', JSON.stringify(blocked));
    assert.equal(await blockingReferences(asD1(raw) as never, 'p_fan'), null);
    await post(as(raw, FINANCE), `/api/devices/admin/claims/${id}/part-grants/${g.id}/revoke`, { reason: 'Product is leaving the shop' });
    assert.equal(await blockingReferences(asD1(raw) as never, 'p_nozzle'), null, 'a revoked offer (and its switched-off coupon) pins nothing');
    // An ended offer keeps an ACTIVE coupon: it must not pin the product either.
    const g2 = (await issue(raw, id)).grant;
    raw.exec('DROP TRIGGER trg_care_part_grant_frozen');
    raw.exec(`UPDATE care_part_grants SET expires_at = '${iso(Date.now() - 1000)}' WHERE id = '${g2.id}'`);
    assert.equal(row<{ active: number }>(raw, 'SELECT active FROM coupons WHERE id = ?', g2.coupon_id)!.active, 1);
    assert.equal(await blockingReferences(asD1(raw) as never, 'p_nozzle'), null);
    // The offer of a product deleted since is still shown, without a product.
    raw.exec("DELETE FROM product_catalogs WHERE product_id = 'p_nozzle'; DELETE FROM products WHERE id = 'p_nozzle';");
    const mine = await json(await get(as(raw, BUYER), `/api/devices/claims/${id}`));
    assert.deepEqual(mine.care.part_grants.map((x: { product: unknown; price_iqd: unknown }) => [x.product, x.price_iqd]), [[null, null], [null, null]]);
  } finally {
    raw.close();
  }
});

test('rejecting the claim takes back the offers the customer has not used; a used one stays', async () => {
  const raw = seed();
  try {
    const id = await file(raw);
    const used = (await issue(raw, id)).grant;
    await add(raw, BUYER, 'p_nozzle', 1);
    await order(raw, BUYER);
    const waiting = (await issue(raw, id, { product_id: 'p_fan', discount_pct: 50 })).grant;
    await add(raw, BUYER, 'p_fan', 1);
    assert.equal((await cart(raw, BUYER)).care_offers.length, 1);
    const res = await patch(as(raw, OWNER), `/api/devices/admin/claims/${id}`, { stage: 'rejected', decision: 'misuse', reason: 'Not a Care case after all' });
    assert.equal(res.status, 200, JSON.stringify(await json(res.clone())));
    const panel = await json(await get(as(raw, OWNER), `/api/devices/admin/claims/${id}/care`));
    const state = (g: string) => panel.part_grants.find((x: { id: string }) => x.id === g).state;
    assert.deepEqual([state(used.id), state(waiting.id)], ['used', 'revoked']);
    assert.deepEqual(all(raw, 'SELECT id, active FROM coupons WHERE id IN (?, ?) ORDER BY active', used.coupon_id, waiting.coupon_id), [{ id: waiting.coupon_id, active: 0 }, { id: used.coupon_id, active: 1 }]);
    assert.deepEqual((await cart(raw, BUYER)).care_offers, [], 'nothing waits in the cart of a rejected claim');
  } finally {
    raw.close();
  }
});

// ------------------------------------------------------------------ review 2026-11-18: the three defects

test('the money ceiling holds across offers: issuing reserves it, and one order can never take more than the device has left', async () => {
  const raw = seed();
  try {
    raw.exec("UPDATE products SET price_iqd = 60000 WHERE id = 'p_fan'");
    const id = await file(raw);
    // Ceiling 30,000. The nozzle offer holds 20,000 of it; the fan offer (50% of 60,000 = 30,000) gets the 10,000 left.
    const first = (await issue(raw, id)).grant;
    const second = (await issue(raw, id, { product_id: 'p_fan', discount_pct: 50 })).grant;
    assert.deepEqual([first.max_discount_iqd, second.max_discount_iqd, second.discount_iqd, second.after_iqd], [20_000, 10_000, 10_000, 50_000]);
    // Nothing is left to promise: a third offer — on this claim or on another claim of the device — is refused.
    raw.exec("INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,sale_types) VALUES ('p_belt','belt','Belt','سير',30000,'active',5,'[\"direct_sale\"]')");
    const third = await offer(raw, FINANCE, id, { product_id: 'p_belt', discount_pct: 50 });
    const thirdBody = await json(third);
    assert.deepEqual([third.status, thirdBody.code, thirdBody.details], [409, 'CARE_CLAIM_LIMIT', { reason: 'money_ceiling', benefit_left_iqd: 30_000, reserved_iqd: 30_000 }]);
    // Both parts in ONE order: 20,000 + 10,000 = the ceiling exactly, never 46,000.
    await add(raw, BUYER, 'p_nozzle', 1);
    await add(raw, BUYER, 'p_fan', 1);
    const q = await quote(raw, BUYER);
    assert.equal(q.care_offer_discount_iqd, 30_000);
    // AN ODD STATE (a ceiling written before the reservation existed, a hand edit): each offer says 30,000.
    raw.exec('DROP TRIGGER trg_care_part_grant_frozen');
    raw.exec('UPDATE care_part_grants SET max_discount_iqd = 30000; UPDATE coupons SET max_discount_iqd = 30000 WHERE id IN (SELECT coupon_id FROM care_part_grants)');
    const odd = await quote(raw, BUYER);
    assert.equal(odd.care_offer_discount_iqd, 30_000, 'the allocation holds the device to its ceiling whatever the offers say');
    assert.deepEqual((await cart(raw, BUYER)).care_offers.map((o: { discount_iqd: number }) => o.discount_iqd).reduce((a: number, b: number) => a + b, 0), 30_000);
    const o = await order(raw, BUYER);
    assert.equal(row<{ s: number }>(raw, 'SELECT SUM(coupon_discount_iqd) AS s FROM order_items WHERE order_id = ?', orderIdOf(o))!.s, 30_000);
    const panel = await json(await get(as(raw, OWNER), `/api/devices/admin/claims/${id}/care`));
    assert.deepEqual([panel.care.used_benefit_iqd, panel.care.benefit_left_iqd, panel.care.used_claims], [30_000, 0, 1]);
    // An approved Care benefit elsewhere eats the ceiling AFTER an offer was issued: the offer is worth what is left.
    const raw2 = seed();
    try {
      const c2 = await file(raw2);
      await issue(raw2, c2);
      raw2.exec(`INSERT INTO warranty_claims (id, user_id, order_item_id, product_name, description, unit_id, stage, status, claim_kind)
                 VALUES ('wc_old','buyer','oi1','Printer A1','old claim','u1','resolved','approved','care')`);
      raw2.prepare(`INSERT INTO care_claim_benefits (id, claim_id, entitlement_unit_id, order_item_id, policy_version, quote_json, list_iqd, eligible_iqd,
                     discount_pct, benefit_iqd, copay_iqd, state, quoted_at, decided_at) VALUES ('ccb_old','wc_old','u1','oi1',1,'{}',50000,50000,50,25000,25000,'approved',?,?)`)
        .run(iso(Date.now()), iso(Date.now()));
      await add(raw2, BUYER, 'p_nozzle', 1);
      assert.equal((await quote(raw2, BUYER)).care_offer_discount_iqd, 5_000);
    } finally {
      raw2.close();
    }
  } finally {
    raw.close();
  }
});

test('an offer that is gone between the quote and the order is never charged quietly: 409 CARE_OFFER_CHANGED, nothing placed', async () => {
  const raw = seed();
  try {
    const id = await file(raw);
    const g = (await issue(raw, id)).grant;
    await add(raw, BUYER, 'p_nozzle', 1);
    const q = await quote(raw, BUYER);
    assert.equal(q.care_offer_discount_iqd, 20_000);
    const seen = { careOffersSeen: q.care_offers.map((o: { grant_id: string }) => o.grant_id), careOfferDiscountSeen: q.care_offer_discount_iqd };
    // Staff revoke it while the page is open.
    await post(as(raw, FINANCE), `/api/devices/admin/claims/${id}/part-grants/${g.id}/revoke`, { reason: 'Wrong part offered' });
    const before = row<{ n: number }>(raw, "SELECT COUNT(*) AS n FROM orders WHERE user_id = 'buyer'")!.n;
    const refused = await post(as(raw, BUYER), '/api/orders', orderBody(BUYER, seen));
    const body = await json(refused);
    assert.deepEqual([refused.status, body.code], [409, 'CARE_OFFER_CHANGED'], JSON.stringify(body).slice(0, 300));
    assert.deepEqual([body.details.care_offers, body.details.care_offer_discount_iqd], [[], 0]);
    assert.equal(body.details.quote.total_iqd, q.total_iqd + 20_000, 'the fresh quote carries the full price');
    assert.equal(row<{ n: number }>(raw, "SELECT COUNT(*) AS n FROM orders WHERE user_id = 'buyer'")!.n, before, 'nothing was placed');
    assert.equal(row<{ n: number }>(raw, "SELECT COUNT(*) AS n FROM cart_items WHERE user_id = 'buyer'")!.n, 1, 'the cart is untouched');
    // Pressing again with what the fresh quote shows goes through, at the price now on the screen.
    const again = await order(raw, BUYER, { careOffersSeen: [], careOfferDiscountSeen: 0 });
    assert.equal(row<{ t: number }>(raw, 'SELECT total_iqd AS t FROM orders WHERE id = ?', orderIdOf(again))!.t, q.total_iqd + 20_000);
    // The other directions: less off than shown is refused; a NEW offer the screen never showed is refused too
    // (the total moved); the same offers with the same total pass; a page that sends nothing is not guarded.
    const g2 = (await issue(raw, id, { product_id: 'p_fan', discount_pct: 50 })).grant;
    await add(raw, BUYER, 'p_fan', 1);
    const lower = await json(await post(as(raw, BUYER), '/api/orders', orderBody(BUYER, { careOffersSeen: [g2.id], careOfferDiscountSeen: 12_000 })));
    assert.equal(lower.code, 'CARE_OFFER_CHANGED');
    const unseen = await json(await post(as(raw, BUYER), '/api/orders', orderBody(BUYER, { careOffersSeen: [], careOfferDiscountSeen: 0 })));
    assert.equal(unseen.code, 'CARE_OFFER_CHANGED');
    assert.deepEqual(unseen.details.care_offers.map((o: { grant_id: string }) => o.grant_id), [g2.id]);
    const ok = await order(raw, BUYER, { careOffersSeen: [g2.id], careOfferDiscountSeen: 10_000 });
    assert.equal(row<{ s: number }>(raw, 'SELECT SUM(coupon_discount_iqd) AS s FROM order_items WHERE order_id = ?', orderIdOf(ok))!.s, 10_000);
    const t = REFUSAL_STRINGS.CARE_OFFER_CHANGED;
    assert.ok(t && t.ckb !== t.ar && t.ar === CARE_REFUSALS.CARE_OFFER_CHANGED.ar);
  } finally {
    raw.close();
  }
});

test('a typed code and a Care offer never multiply into the whole price: 60% + 50% on a 40,000 part = 24,000 + 8,000', async () => {
  const raw = seed();
  try {
    raw.exec(`INSERT INTO coupons (id, code, kind, value, min_total_iqd, max_per_user, active) VALUES ('cp_sixty','SIXTY','percent',60,0,5,1)`);
    const id = await file(raw);
    await issue(raw, id);
    await add(raw, BUYER, 'p_nozzle', 1);
    // The cart knows no code: its figure is the upper bound, the quote is the authority.
    assert.equal((await cart(raw, BUYER)).care_offers[0].discount_iqd, 20_000);
    const q = await quote(raw, BUYER, { couponCode: 'SIXTY' });
    assert.deepEqual([q.coupon.discount_iqd, q.care_offer_discount_iqd], [32_000, 8_000]);
    assert.equal(q.total_iqd, 8_000 + q.shipping.total_iqd, 'the goods still cost 8,000');
    const o = await order(raw, BUYER, { couponCode: 'SIXTY', careOffersSeen: q.care_offers.map((x: { grant_id: string }) => x.grant_id), careOfferDiscountSeen: 8_000 });
    const orderId = orderIdOf(o);
    assert.deepEqual(all(raw, 'SELECT coupon_discount_iqd, line_total_iqd FROM order_items WHERE order_id = ?', orderId), [{ coupon_discount_iqd: 32_000, line_total_iqd: 40_000 }]);
    assert.deepEqual(all(raw, 'SELECT amount_iqd FROM coupon_redemptions WHERE order_id = ?', orderId), [{ amount_iqd: 24_000 }]);
    assert.deepEqual(all(raw, 'SELECT amount_iqd FROM coupon_redemption_extras WHERE order_id = ?', orderId), [{ amount_iqd: 8_000 }]);
  } finally {
    raw.close();
  }
});

test('the cart fails OPEN: a Care read that breaks never breaks the cart', async () => {
  const raw = seed();
  try {
    const id = await file(raw);
    await issue(raw, id);
    await add(raw, BUYER, 'p_nozzle', 1);
    assert.equal((await cart(raw, BUYER)).care_offers.length, 1);
    // The Care read fails with something that is NOT «the table is missing» (a transient database error).
    const real = asD1(raw);
    const broken = new Proxy(real as object, {
      get(target, key, receiver) {
        if (key === 'prepare') {
          return (sql: string) => {
            if (/care_part_grants/.test(sql)) throw new Error('D1_ERROR: internal error (injected by the test)');
            return (target as D1Database).prepare(sql);
          };
        }
        const v = Reflect.get(target, key, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as D1Database;
    const app = stubApp(broken, BUYER, (a) => a.route('/api/cart', cartRoutes));
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args[0]); };
    try {
      const c = await json(await get(app, '/api/cart'));
      assert.equal(c.success, true, JSON.stringify(c).slice(0, 200));
      assert.equal(c.items.length, 1);
      assert.deepEqual(c.care_offers, []);
    } finally {
      console.error = original;
    }
    assert.ok(errors.some((e) => String(e).includes('Levo Care part offers')), 'and it is logged');
  } finally {
    raw.close();
  }
});

// ------------------------------------------------------------------ deploy-ahead

test('a database without 0243: the doors answer 503, every read answers as before, and an order is priced without offers', async () => {
  const raw = seed(dbThrough('0242_printer_offers.sql'));
  try {
    const id = await file(raw);
    const refused = await offer(raw, FINANCE, id, { product_id: 'p_nozzle', discount_pct: 50 });
    assert.deepEqual([refused.status, (await json(refused)).code], [503, 'CARE_NOT_INSTALLED']);
    const rev = await post(as(raw, FINANCE), `/api/devices/admin/claims/${id}/part-grants/cpg_x/revoke`, { reason: 'Nothing to revoke' });
    assert.deepEqual([rev.status, (await json(rev)).code], [503, 'CARE_NOT_INSTALLED']);
    const panel = await json(await get(as(raw, OWNER), `/api/devices/admin/claims/${id}/care`));
    assert.deepEqual([panel.success, panel.part_grants, panel.care.total_months], [true, [], 12]);
    const mine = await json(await get(as(raw, BUYER), `/api/devices/claims/${id}`));
    assert.deepEqual(mine.care.part_grants, []);
    assert.equal((await json(await get(as(raw, BUYER), '/api/devices/claims'))).claims[0].part_offers_live, 0);
    await add(raw, BUYER, 'p_nozzle', 1);
    assert.deepEqual((await cart(raw, BUYER)).care_offers, []);
    const q = await quote(raw, BUYER);
    assert.deepEqual([q.success, q.care_offers, q.care_offer_discount_iqd], [true, [], 0]);
    const o = await order(raw, BUYER);
    assert.equal(o.success, true);
    const day = baghdadDay();
    assert.equal((await serviceClaimsSummary(asD1(raw), { from: day, to: day }, { laborIqd: null }))!.care_part_discount_iqd, 0);
  } finally {
    raw.close();
  }
});
