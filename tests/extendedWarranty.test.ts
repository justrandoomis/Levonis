/**
 * Extended warranty for PRINTERS — the owner's mandate, run end to end.
 *
 *   «For printers, add extended warranty plans … optional and can only be
 *    added before the product is ordered … 12 additional months, making the
 *    total 24; 24 additional months, making the total 36 … on the printer
 *    product page before adding to the cart, or inside the cart … a small
 *    expandable "Extended Warranty" option … a percentage-based price, for
 *    example between 7.5% and 10% of the printer price … cannot be added
 *    after the order has been completed … This system applies to printers
 *    only.»
 *
 * Only the session is stubbed. The cart, product, checkout and policy routes
 * run against the real migrations through the SQLite adapter; the resolver,
 * the printer-identity query, the write-path guard, the delivery hook and
 * the TXT/CSV importers all execute for real.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { ROOT, SqliteD1 } from './fixtures/d1';
import type { AppContext, Env } from '../worker/lib/types';
import { HttpError } from '../worker/lib/http';
import { cartRoutes, CART_WARRANTY_CONFLICT } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';
import { productRoutes } from '../worker/routes/products';
import { policiesRoutes } from '../worker/routes/policies';
import { adminRoutes } from '../worker/routes/admin';
import { deviceRoutes } from '../worker/routes/devices';
import { classifyHost } from '../worker/lib/hosts';
import { resolveUnitPrice } from '../worker/lib/pricing';
import type { WarrantyPlanV2 } from '../worker/lib/pricing';
import {
  PRINTER_BASE_MONTHS,
  PRINTER_EXTENSION_MONTHS,
  FEE_PERCENT_HINT,
  WARRANTY_NOT_PRINTER,
  WARRANTY_PLAN_INVALID,
  planFee,
  planTotalMonths,
  parseFeePercent,
  isValidFeePercent,
  printerWarrantyRules,
  applyPrinterWarrantyRules,
  refuseNonPrinterWarranty,
  pricedPlans,
  mergeOpsPolicy,
  readOpsWarranty,
  effectiveDevicePolicy,
  effectiveBaseMonths,
} from '../worker/lib/warrantyPlans';
import { computeCoverage, createUnitsOnDelivery } from '../worker/lib/deviceOps';
import { addMonths } from '../worker/lib/membershipOps';
import { parseProductRow, validateProductDoc } from '../worker/lib/productModel';
import { exportProduct, parseTemplate, toDocBody } from '../worker/lib/template';
import { buildExampleTemplate } from '../worker/routes/template';
import { templateShape, parseImport, blankTemplate, exampleRows, readmeFor } from '../worker/lib/importCsv';
import { normKey, resolveProduct } from '../worker/lib/importApply';
import type { CatalogRef, ImportMaps } from '../worker/lib/importApply';
import { PRODUCT_TYPES } from '../worker/lib/templateFamilies';
import { POLICY_DRAFTS, POLICY_KEYS, POLICY_LANGS } from '../worker/lib/policyOps';
import {
  warrantyFee as formWarrantyFee,
  isValidFeePercent as formIsValidFeePercent,
  PRINTER_BASE_MONTHS as FORM_BASE_MONTHS,
  PRINTER_EXTENSION_MONTHS as FORM_EXTENSION_MONTHS,
  FEE_PERCENT_HINT as FORM_FEE_HINT,
} from '../src/components/adminProducts/form/model';

// ------------------------------------------------------------------ fixture

const plan = (over: Partial<WarrantyPlanV2>): WarrantyPlanV2 => ({
  id: 'wp_ext12',
  title_ar: 'ضمان ممدد +12 شهرًا',
  title_en: 'Extended warranty +12 months',
  title_ckb: '',
  terms_ar: '',
  terms_en: '',
  terms_ckb: '',
  duration_months: 12,
  duration_kind: 'extension',
  fee_iqd: 0,
  fee_percent: 7.5,
  order: 0,
  active: true,
  ...over,
});
const EXT12 = plan({});
const EXT24 = plan({ id: 'wp_ext24', title_ar: 'ضمان ممدد +24 شهرًا', title_en: 'Extended warranty +24 months', duration_months: 24, fee_percent: 10, order: 1 });
/** A plan stored on a NON-printer before the rule existed. */
const LEGACY = plan({ id: 'wp_old', title_ar: 'سنة', title_en: 'One year', duration_months: 12, duration_kind: 'total', fee_iqd: 5_000, fee_percent: null });
const PRINTER_PLANS = JSON.stringify([EXT12, EXT24]);
const OPS = JSON.stringify({ serialized: true, warranty_base_months: 12 });

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) raw.exec(readFileSync(join(dir, f), 'utf8'));
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','s@x.co','h','customer'),
      ('adm','Admin','a@x.co','h','admin');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default) VALUES
      ('addr_b','buyer','Home','Sara','+9647701234567','Baghdad, Karrada 12','',1);
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status) VALUES
      ('dep_b','buyer','deposit','USD',200000,'approved');
  `);
  raw
    .prepare(
      `INSERT INTO products (id,slug,name,name_ar,price_iqd,prime_price_iqd,pro_price_iqd,status,stock,options,colors,selling_type,sale_types,warranty_plans,ops_policy,images)
       VALUES ('p_x1','x1-printer','Printer X1','طابعة X1',899000,885000,799000,'active',5,'[]','[]','direct_sale','["direct_sale"]',?,?,'[]'),
              ('p_pla','pla-basic','PLA Basic','PLA أساسي',25000,NULL,NULL,'active',50,'[]','[]','direct_sale','["direct_sale"]',?,'{}','[]')`
    )
    .run(PRINTER_PLANS, OPS, JSON.stringify([LEGACY]));
  raw.exec(`
    INSERT INTO catalogs (id, slug, name_ar, is_printer_catalog) VALUES
      ('cat_test_printers','test-printers','طابعات',1),
      ('cat_test_fil','test-filaments','خيوط',0);
    INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES
      ('p_x1','cat_test_printers',0),
      ('p_pla','cat_test_fil',0);
  `);
  return { raw, db: new SqliteD1(raw) as unknown as D1Database };
}

function appAs(db: D1Database, userId: string, role: 'customer' | 'admin' = 'customer') {
  const a = new Hono<AppContext>();
  a.use('*', async (c, next) => {
    c.set('user', { id: userId, role, email: `${userId}@x.co`, username: userId } as never);
    // The main host, as worker/index.ts classifies it — the admin device
    // routes answer only there.
    c.set('host', classifyHost('levonis-iq.com', 'levonis-iq.com'));
    c.env = { DB: db, APP_ORIGIN: 'https://levonis-iq.com', STORE_ROOT_DOMAIN: 'levonis-iq.com' } as never;
    await next();
  });
  a.route('/api/cart', cartRoutes);
  a.route('/api/orders', orderRoutes);
  a.route('/api/products', productRoutes);
  a.route('/api/policies', policiesRoutes);
  a.route('/api/admin', adminRoutes);
  a.route('/api/devices', deviceRoutes);
  a.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ success: false, error: err.message, code: err.code, details: err.details ?? null }, err.status as 400);
    }
    throw err;
  });
  return a;
}

const pending: Promise<unknown>[] = [];
const ctx = {
  waitUntil: (p: Promise<unknown>) => {
    pending.push(p.catch(() => undefined));
  },
  passThroughOnException() {},
} as unknown as ExecutionContext;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response) => (await res.json()) as Record<string, any>;
const send = (a: ReturnType<typeof appAs>, method: string, path: string, body?: unknown) =>
  a.request(
    path,
    { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) },
    undefined,
    ctx
  );
const post = (a: ReturnType<typeof appAs>, path: string, body: unknown) => send(a, 'POST', path, body);
const patch = (a: ReturnType<typeof appAs>, path: string, body: unknown) => send(a, 'PATCH', path, body);
const get = (a: ReturnType<typeof appAs>, path: string) => send(a, 'GET', path);

let seq = 0;
const orderBody = (paymentMethodId: string, over: Record<string, unknown> = {}) => ({
  addressId: 'addr_b',
  deliveryMethodId: 'standard',
  paymentMethodId,
  useWallet: false,
  usePoints: false,
  itemIds: [],
  idempotencyKey: `ew-${Date.now()}-${++seq}`,
  ...over,
});

const noCostKey = (v: unknown, label: string) =>
  assert.ok(!/"[^"]*cost[^"]*"\s*:/i.test(JSON.stringify(v)), `${label}: no key containing "cost" may reach the customer`);

// ---------------------------------------------------------------- the rules

test('the constants and the fee: round(regular × pct) in integer IQD, fixed fee when no percent', () => {
  assert.equal(PRINTER_BASE_MONTHS, 12);
  assert.deepEqual([...PRINTER_EXTENSION_MONTHS], [12, 24]);
  assert.deepEqual(FEE_PERCENT_HINT, { min: 7.5, max: 10 });
  assert.equal(planFee(EXT12, 899_000), 67_425, '7.5% of 899,000');
  assert.equal(planFee(EXT24, 899_000), 89_900, '10% of 899,000');
  assert.equal(planFee(EXT12, 1_099_000), 82_425, 'the option surcharge moves the basis');
  assert.equal(planFee(EXT12, 100_001), 7_500, '7500.075 rounds to the dinar');
  assert.equal(planFee(plan({ fee_percent: 0.01 }), 3), 0, 'never a fraction of a dinar');
  assert.equal(planFee(LEGACY, 899_000), 5_000, 'no percent → the fixed fee, verbatim');
  assert.equal(planFee(plan({ fee_percent: null, fee_iqd: -5 }), 899_000), 0, 'a broken fixed fee charges nothing rather than a negative');
  assert.equal(planTotalMonths(EXT12, 12), 24);
  assert.equal(planTotalMonths(EXT24, 12), 36);
  assert.equal(planTotalMonths(EXT12, null), null, 'an extension with no base is not a total');
  assert.equal(planTotalMonths(LEGACY, 12), 12, "a legacy 'total' plan IS the total");
});

test('percent parsing: two decimals, 0.01..100, a leading plus tolerated', () => {
  assert.equal(parseFeePercent('7.5'), 7.5);
  assert.equal(parseFeePercent('+7.5'), 7.5);
  assert.equal(parseFeePercent('10'), 10);
  assert.equal(parseFeePercent(7.55), 7.55);
  assert.equal(parseFeePercent('7.555'), null);
  assert.equal(parseFeePercent('150'), null);
  assert.equal(parseFeePercent('0'), null);
  assert.equal(parseFeePercent('abc'), null);
  assert.equal(isValidFeePercent(100), true);
  assert.equal(isValidFeePercent(100.01), false);
  assert.equal(isValidFeePercent(Number.NaN), false);
});

test('the admin form runs the SAME arithmetic and constants as the server', () => {
  assert.equal(FORM_BASE_MONTHS, PRINTER_BASE_MONTHS);
  assert.deepEqual([...FORM_EXTENSION_MONTHS], [...PRINTER_EXTENSION_MONTHS]);
  assert.deepEqual(FORM_FEE_HINT, FEE_PERCENT_HINT);
  for (const basis of [1, 3, 25_000, 100_001, 899_000, 1_099_000, 2_000_000_000]) {
    for (const pct of [null, 0.01, 7.5, 7.55, 10, 33.33, 100]) {
      const p = { fee_iqd: 45_000, fee_percent: pct };
      assert.equal(formWarrantyFee(p, basis), planFee({ ...EXT12, ...p }, basis), `basis ${basis} × ${pct}%`);
    }
  }
  for (const v of [7.5, 10, 0.01, 100, 0, 100.01, 7.555, Number.NaN, '7.5']) {
    assert.equal(formIsValidFeePercent(v), isValidFeePercent(v), `isValidFeePercent(${String(v)})`);
  }
});

test('resolver: the percent fee is identical for free, PRIME and PRO; the totals ride in the resolved warranty', () => {
  const doc = parseProductRow({
    id: 'p_x1', slug: 'x1', name: 'X1', name_ar: 'X1', price_iqd: 899_000, prime_price_iqd: 885_000, pro_price_iqd: 799_000,
    options: '[]', colors: '[]', selling_type: 'direct_sale', warranty_plans: PRINTER_PLANS, ops_policy: OPS,
  });
  assert.equal(doc.warranty_base_months, 12, 'ops_policy is read onto the document');
  assert.equal(doc.serialized, true);
  const tiers = [
    { tier: 'free' as const, tierActive: false, applied: 899_000 },
    { tier: 'prime' as const, tierActive: true, applied: 885_000 },
    { tier: 'pro' as const, tierActive: true, applied: 799_000 },
  ];
  for (const t of tiers) {
    const r = resolveUnitPrice({ product: doc, warrantyPlanId: 'wp_ext12', tier: t.tier, tierActive: t.tierActive });
    assert.deepEqual(r.errors, []);
    assert.equal(r.applied_iqd, t.applied);
    assert.equal(r.warranty?.fee_iqd, 67_425, `${t.tier} pays the same warranty dinar`);
    assert.equal(r.warranty?.basis_iqd, 899_000);
    assert.equal(r.warranty?.base_months, 12);
    assert.equal(r.warranty?.total_months, 24);
    assert.equal(r.warranty?.title_en, 'Extended warranty +12 months');
    assert.equal(r.unit_subtotal_iqd, t.applied + 67_425);
  }
  const b = resolveUnitPrice({ product: doc, warrantyPlanId: 'wp_ext24', tier: 'free', tierActive: false });
  assert.deepEqual([b.warranty?.fee_iqd, b.warranty?.duration_months, b.warranty?.total_months], [89_900, 24, 36]);
});

test('pricedPlans: a printer gets every active plan priced for the selection; a non-printer gets none', () => {
  const priced = pricedPlans([EXT12, EXT24, plan({ id: 'off', active: false })], 899_000, 12, true);
  assert.deepEqual(
    priced.map((w) => [w.id, w.fee_iqd, w.basis_iqd, w.base_months, w.total_months]),
    [['wp_ext12', 67_425, 899_000, 12, 24], ['wp_ext24', 89_900, 899_000, 12, 36]]
  );
  assert.deepEqual(pricedPlans([LEGACY], 25_000, null, false), []);
  noCostKey(priced, 'pricedPlans');
});

test('ops_policy: one writer for the device keys, other keys untouched; both legacy spellings read', () => {
  const merged = mergeOpsPolicy({ size_class: 'large', warranty_months: 6 }, { serialized: true, warranty_base_months: 12 });
  assert.deepEqual(merged, { size_class: 'large', serialized: true, warranty_base_months: 12 });
  assert.deepEqual(mergeOpsPolicy(merged, { warranty_base_months: null }), { size_class: 'large', serialized: true });
  assert.deepEqual(mergeOpsPolicy(merged, { serialized: null }), merged, 'null serialized = leave the stored answer');
  assert.deepEqual(readOpsWarranty('{"warranty_months":18}').warranty_base_months, 18);
  assert.deepEqual(readOpsWarranty('not json'), { serialized: null, warranty_base_months: null, policy: {} });
});

// ------------------------------------------------------- the write-path guard

test('printerWarrantyRules: non-printer refused; printer plans must be +12/+24 extensions, one per duration, serialized', () => {
  const guard = (plans: Array<Partial<WarrantyPlanV2> & { id: string }>, serialized: boolean | null = null) => ({
    warranty_plans: plans.map((p) => ({ ...plan({}), ...p })),
    serialized,
    warranty_base_months: null as number | null,
  });
  // Not a printer: plans are refused; no plans is fine.
  assert.match(printerWarrantyRules(guard([{ id: 'a' }]), false)[0], /WARRANTY_NOT_PRINTER/);
  assert.deepEqual(printerWarrantyRules(guard([]), false), []);
  // A printer: defaults filled, valid shape accepted.
  const ok = guard([{ id: 'a' }, { id: 'b', duration_months: 24 }]);
  assert.deepEqual(printerWarrantyRules(ok, true), []);
  assert.equal(ok.serialized, true, 'a printer is serialized by default');
  assert.equal(ok.warranty_base_months, 12, 'a printer has the 12-month base by default');
  // The refusals.
  assert.match(printerWarrantyRules(guard([{ id: 'x', duration_months: 6 }]), true).join(' '), /12 or 24/);
  assert.match(printerWarrantyRules(guard([{ id: 'x', duration_kind: 'total' }]), true).join(' '), /"extension"/);
  assert.match(printerWarrantyRules(guard([{ id: 'a' }, { id: 'b' }]), true).join(' '), /only one plan per duration/);
  assert.match(printerWarrantyRules(guard([{ id: 'a' }], false), true).join(' '), /serialized/);
  // A stored `false` with no active plan is left alone — not every printer sells an extension.
  const noPlans = guard([], false);
  assert.deepEqual(printerWarrantyRules(noPlans, true), []);
  assert.equal(noPlans.serialized, false);
});

test('applyPrinterWarrantyRules against the database: catalog flag decides, 400 codes, defaults written onto the doc', async () => {
  const { db } = setup();
  const body = (catalogId: string, plans: unknown[]) => ({
    name_ar: 'طابعة', name_en: 'Printer', price_iqd: 899_000, status: 'draft',
    category_id: catalogId, warranty_plans: plans,
  });
  // A filament carrying plans.
  const fil = validateProductDoc(body('cat_test_fil', [EXT12]));
  await assert.rejects(
    applyPrinterWarrantyRules(db, fil, ['cat_test_fil']),
    (e: unknown) => e instanceof HttpError && e.status === 400 && e.code === WARRANTY_NOT_PRINTER
  );
  // A printer with a 6-month plan.
  const odd = validateProductDoc(body('cat_test_printers', [plan({ duration_months: 6 })]));
  await assert.rejects(
    applyPrinterWarrantyRules(db, odd, ['cat_test_printers']),
    (e: unknown) => e instanceof HttpError && e.status === 400 && e.code === WARRANTY_PLAN_INVALID
  );
  // A printer with the two plans: accepted, defaults filled.
  const good = validateProductDoc(body('cat_test_printers', [EXT12, EXT24]));
  assert.equal(good.serialized, null, 'the client said nothing about serialization');
  const res = await applyPrinterWarrantyRules(db, good, ['cat_test_printers']);
  assert.equal(res.is_printer, true);
  assert.equal(good.serialized, true);
  assert.equal(good.warranty_base_months, 12);
  // With no explicit catalog list the STORED placement decides (p_x1 is a printer).
  const stored = validateProductDoc({ ...body('', [EXT12]), id: 'p_x1', category_id: null });
  stored.id = 'p_x1';
  assert.equal((await applyPrinterWarrantyRules(db, stored, undefined)).is_printer, true);
  // A filament with NO plans is simply fine.
  await applyPrinterWarrantyRules(db, validateProductDoc(body('cat_test_fil', [])), ['cat_test_fil']);
  // A percent outside the rules is refused by the document validator itself.
  assert.throws(() => validateProductDoc(body('cat_test_printers', [plan({ fee_percent: 150 })])), (e: unknown) => e instanceof HttpError && /fee_percent/.test(e.message));
  assert.throws(() => validateProductDoc(body('cat_test_printers', [plan({ fee_percent: 7.555 })])), (e: unknown) => e instanceof HttpError && /fee_percent/.test(e.message));
});

test('refuseNonPrinterWarranty is the runtime half: a plan on a non-printer is a 400, no plan or a printer passes', () => {
  assert.throws(
    () => refuseNonPrinterWarranty(false, 'wp_ext12', 'PLA'),
    (e: unknown) => e instanceof HttpError && e.status === 400 && e.code === WARRANTY_NOT_PRINTER && e.message.startsWith('"PLA"')
  );
  assert.doesNotThrow(() => refuseNonPrinterWarranty(false, ''));
  assert.doesNotThrow(() => refuseNonPrinterWarranty(false, null));
  assert.doesNotThrow(() => refuseNonPrinterWarranty(true, 'wp_ext12'));
});

// ------------------------------------------------------------- the cart

test('cart: a printer line takes a plan, is priced with it, and PATCH sets, changes and clears it', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'buyer');

  const added = await post(a, '/api/cart/items', { productId: 'p_x1', qty: 2, warrantyPlanId: 'wp_ext12' });
  const body = await json(added);
  assert.equal(added.status, 200, JSON.stringify(body));
  const line = body.items[0];
  assert.equal(line.is_printer, true);
  assert.equal(line.warranty_plan_id, 'wp_ext12');
  assert.equal(line.unit_price_iqd, 899_000 + 67_425, 'the fee sits on every unit of the line');
  assert.equal(line.breakdown.warranty.fee_iqd, 67_425);
  assert.equal(line.breakdown.warranty.fee_percent, 7.5);
  assert.equal(line.breakdown.warranty.basis_iqd, 899_000);
  assert.equal(line.breakdown.warranty.total_months, 24);
  // The disclosure's options: every plan priced for THIS line, with its total.
  assert.deepEqual(
    line.warranty_plans.map((w: Record<string, unknown>) => [w.id, w.fee_iqd, w.total_months]),
    [['wp_ext12', 67_425, 24], ['wp_ext24', 89_900, 36]]
  );
  noCostKey(body, 'GET /api/cart');

  const id = (raw.prepare("SELECT id FROM cart_items WHERE user_id = 'buyer'").get() as { id: string }).id;
  const changed = await json(await patch(a, `/api/cart/items/${id}`, { warrantyPlanId: 'wp_ext24' }));
  assert.equal(changed.items[0].warranty_plan_id, 'wp_ext24');
  assert.equal(changed.items[0].breakdown.warranty.fee_iqd, 89_900);
  assert.equal(changed.items[0].breakdown.warranty.total_months, 36);
  assert.equal(changed.items[0].unit_price_iqd, 899_000 + 89_900);

  const cleared = await json(await patch(a, `/api/cart/items/${id}`, { warrantyPlanId: '' }));
  assert.equal(cleared.items[0].warranty_plan_id, '');
  assert.equal(cleared.items[0].breakdown.warranty, null);
  assert.equal(cleared.items[0].unit_price_iqd, 899_000);
  assert.equal((raw.prepare('SELECT warranty_plan_id FROM cart_items WHERE id = ?').get(id) as { warranty_plan_id: string }).warranty_plan_id, '');

  // A plan the product does not offer is still refused by the resolver.
  const gone = await patch(a, `/api/cart/items/${id}`, { warrantyPlanId: 'wp_nope' });
  assert.equal(gone.status, 400);
  assert.match((await json(gone)).error, /WARRANTY_PLAN_NOT_FOUND/);

  // Adding the same printer again WITH a plan the line does not hold is
  // refused — a merge must never silently give both units a plan the
  // customer chose for one of them. The line is untouched; the fix is named.
  const again = await post(a, '/api/cart/items', { productId: 'p_x1', qty: 1, warrantyPlanId: 'wp_ext12' });
  assert.equal(again.status, 409);
  const refusal = await json(again);
  assert.equal(refusal.code, CART_WARRANTY_CONFLICT);
  assert.match(refusal.error, /change it from the cart/);
  const line2 = raw.prepare('SELECT qty, warranty_plan_id FROM cart_items WHERE id = ?').get(id) as { qty: number; warranty_plan_id: string };
  assert.deepEqual([line2.qty, line2.warranty_plan_id], [2, '']);
});

test('cart merge: a second add of the same printer never rewrites its extended-warranty choice', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'buyer');
  const line = () =>
    (raw.prepare("SELECT qty, warranty_plan_id FROM cart_items WHERE user_id = 'buyer'").all() as Array<{ qty: number; warranty_plan_id: string }>).map(
      (r) => [r.qty, r.warranty_plan_id]
    );

  // +24 chosen, then the same printer added plainly: the plan stays, qty grows.
  assert.equal((await post(a, '/api/cart/items', { productId: 'p_x1', qty: 1, warrantyPlanId: 'wp_ext24' })).status, 200);
  const plain = await json(await post(a, '/api/cart/items', { productId: 'p_x1', qty: 1 }));
  assert.equal(plain.items.length, 1);
  assert.equal(plain.items[0].qty, 2);
  assert.equal(plain.items[0].warranty_plan_id, 'wp_ext24', 'a plain re-add kept the chosen plan');
  assert.equal(plain.items[0].breakdown.warranty.fee_iqd, 89_900);
  // The same plan again: merged.
  const same = await json(await post(a, '/api/cart/items', { productId: 'p_x1', qty: 1, warrantyPlanId: 'wp_ext24' }));
  assert.equal(same.items.length, 1);
  assert.equal(same.items[0].qty, 3);
  assert.equal(same.items[0].warranty_plan_id, 'wp_ext24');
  // A DIFFERENT plan: refused, line unchanged.
  const other = await post(a, '/api/cart/items', { productId: 'p_x1', qty: 1, warrantyPlanId: 'wp_ext12' });
  assert.equal(other.status, 409);
  assert.equal((await json(other)).code, CART_WARRANTY_CONFLICT);
  assert.deepEqual(line(), [[3, 'wp_ext24']]);

  // A line WITHOUT a plan, then an add naming one: refused too — the customer
  // decides from the cart which units get the extension.
  raw.exec("DELETE FROM cart_items WHERE user_id = 'buyer'");
  assert.equal((await post(a, '/api/cart/items', { productId: 'p_x1', qty: 1 })).status, 200);
  const onto = await post(a, '/api/cart/items', { productId: 'p_x1', qty: 1, warrantyPlanId: 'wp_ext12' });
  assert.equal(onto.status, 409);
  assert.equal((await json(onto)).code, CART_WARRANTY_CONFLICT);
  assert.deepEqual(line(), [[1, '']]);
  // …and the cart's own PATCH is the way to change it.
  const id = (raw.prepare("SELECT id FROM cart_items WHERE user_id = 'buyer'").get() as { id: string }).id;
  const changed = await json(await patch(a, `/api/cart/items/${id}`, { warrantyPlanId: 'wp_ext12' }));
  assert.equal(changed.items[0].warranty_plan_id, 'wp_ext12');
  // A non-printer add never trips the guard (it has no plan to conflict with).
  assert.equal((await post(a, '/api/cart/items', { productId: 'p_pla', qty: 1 })).status, 200);
  assert.equal((await post(a, '/api/cart/items', { productId: 'p_pla', qty: 1 })).status, 200);
});

test('cart: a non-printer is refused a plan on add and on update (WARRANTY_NOT_PRINTER), and its legacy plan is not offered', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'buyer');

  const refused = await post(a, '/api/cart/items', { productId: 'p_pla', qty: 1, warrantyPlanId: 'wp_old' });
  assert.equal(refused.status, 400);
  assert.equal((await json(refused)).code, WARRANTY_NOT_PRINTER);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM cart_items').get()!.n, 0, 'nothing was written');

  const plain = await json(await post(a, '/api/cart/items', { productId: 'p_pla', qty: 1 }));
  assert.equal(plain.items[0].is_printer, false);
  assert.deepEqual(plain.items[0].warranty_plans, [], 'the stored legacy plan is not offered to the customer');
  const id = (raw.prepare("SELECT id FROM cart_items WHERE user_id = 'buyer'").get() as { id: string }).id;
  const upd = await patch(a, `/api/cart/items/${id}`, { warrantyPlanId: 'wp_old' });
  assert.equal(upd.status, 400);
  assert.equal((await json(upd)).code, WARRANTY_NOT_PRINTER);
  // …while an ordinary update of the same line is fine.
  assert.equal((await patch(a, `/api/cart/items/${id}`, { qty: 2 })).status, 200);
});

// ----------------------------------------------------------- the product page

test('product page: the plans arrive priced for the selection, with the base and the totals; the quote re-prices and reports the gate', async () => {
  const { db } = setup();
  const a = appAs(db, 'buyer');

  const detail = await json(await get(a, '/api/products/x1-printer'));
  assert.equal(detail.product.is_printer, true);
  assert.equal(detail.product.warranty_base_months, 12);
  assert.deepEqual(
    detail.product.warranty_plans.map((w: Record<string, unknown>) => [w.id, w.fee_iqd, w.basis_iqd, w.total_months]),
    [['wp_ext12', 67_425, 899_000, 24], ['wp_ext24', 89_900, 899_000, 36]]
  );
  noCostKey(detail, 'GET /api/products/:slug');

  const quoted = await json(await post(a, '/api/products/x1-printer/quote', { qty: 2, warrantyPlanId: 'wp_ext24' }));
  assert.deepEqual(quoted.quote.errors, []);
  assert.equal(quoted.quote.warranty.fee_iqd, 89_900);
  assert.equal(quoted.quote.warranty.total_months, 36);
  assert.equal(quoted.quote.line_total_iqd, (899_000 + 89_900) * 2);
  assert.deepEqual(quoted.warranty_plans.map((w: Record<string, unknown>) => w.fee_iqd), [67_425, 89_900]);

  const pla = await json(await get(a, '/api/products/pla-basic'));
  assert.deepEqual(pla.product.warranty_plans, [], 'a non-printer offers no extended warranty, whatever it stores');
  const plaQuote = await json(await post(a, '/api/products/pla-basic/quote', { qty: 1, warrantyPlanId: 'wp_old' }));
  assert.ok(plaQuote.quote.errors.includes(WARRANTY_NOT_PRINTER), JSON.stringify(plaQuote.quote.errors));
});

// -------------------------------------------------------------- the checkout

test('checkout freezes the plan (percent, basis, 24 total) into the snapshot; nothing afterwards can change it; delivery records 24 months', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'buyer');
  assert.equal((await post(a, '/api/cart/items', { productId: 'p_x1', qty: 2, warrantyPlanId: 'wp_ext12' })).status, 200);

  const placed = await post(a, '/api/orders', orderBody('cash'));
  const body = await json(placed);
  assert.equal(placed.status, 200, JSON.stringify(body));
  const order = body.order;
  const item = order.items[0];
  assert.equal(item.unit_price_iqd, 966_425);
  assert.equal(item.line_total_iqd, 1_932_850);
  assert.deepEqual(item.warranty, {
    plan_id: 'wp_ext12',
    title_ar: 'ضمان ممدد +12 شهرًا',
    title_en: 'Extended warranty +12 months',
    fee_iqd: 67_425,
    duration_months: 12,
    duration_kind: 'extension',
    fee_percent: 7.5,
    basis_iqd: 899_000,
    base_months: 12,
    total_months: 24,
  });
  assert.equal(order.financial.merchandise_iqd, 1_798_000, 'goods without the warranty fee');
  assert.equal(order.financial.fees_iqd, 134_850, 'the warranty fee is a fee, for every unit');
  noCostKey(body, 'POST /api/orders');

  const snapshotOf = () =>
    (raw.prepare('SELECT warranty_snapshot FROM order_items WHERE order_id = ?').get(order.id) as { warranty_snapshot: string }).warranty_snapshot;
  const frozen = snapshotOf();
  assert.deepEqual(JSON.parse(frozen), item.warranty);

  // The customer view reads the frozen promise back.
  const view = await json(await get(a, `/api/orders/${order.id}`));
  assert.equal(view.order.items[0].warranty.total_months, 24);

  // EVERY customer route that touches an order: none may write the snapshot.
  // A plan id riding on any of them is ignored or refused — never attached.
  const attempts: Array<[string, string, unknown]> = [
    ['PATCH', `/api/orders/${order.id}`, { warrantyPlanId: 'wp_ext24' }],
    ['PUT', `/api/orders/${order.id}`, { warrantyPlanId: 'wp_ext24' }],
    ['POST', `/api/orders/${order.id}/items/${item.id}/warranty`, { warrantyPlanId: 'wp_ext24' }],
    ['PATCH', `/api/orders/${order.id}/items/${item.id}`, { warrantyPlanId: 'wp_ext24' }],
    ['POST', `/api/orders/${order.id}/settlement`, { warrantyPlanId: 'wp_ext24' }],
    ['POST', `/api/orders/${order.id}/cancel`, { reason: 'changed my mind', warrantyPlanId: 'wp_ext24' }],
  ];
  for (const [method, path, payload] of attempts) {
    const res = await send(a, method, path, payload);
    assert.ok(res.status === 404 || res.status === 400 || res.status === 200, `${method} ${path} → ${res.status}`);
    assert.equal(snapshotOf(), frozen, `${method} ${path} must not touch order_items.warranty_snapshot`);
  }
  // The cancel above may have succeeded — the frozen plan is still the record.
  assert.deepEqual(JSON.parse(snapshotOf()).total_months, 24);

  // The other direction: the cart is the LAST moment. A cart row for a
  // non-printer carrying a plan (written before the rule) is refused at
  // checkout too, so the door is shut on both sides.
  raw
    .prepare(
      `INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty)
       VALUES ('ci_old','buyer','p_pla','','[]','','','','wp_old',1)`
    )
    .run();
  const quote = await post(a, '/api/orders/quote', orderBody('cash'));
  assert.equal(quote.status, 400);
  assert.equal((await json(quote)).code, WARRANTY_NOT_PRINTER);
  await Promise.allSettled(pending);
});

test('delivery: the units record base 12 + extension 12/24 → 24/36 months from delivery, from the frozen snapshot', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'buyer');
  assert.equal((await post(a, '/api/cart/items', { productId: 'p_x1', qty: 2, warrantyPlanId: 'wp_ext24' })).status, 200);
  const order = (await json(await post(a, '/api/orders', orderBody('cash')))).order;
  const delivered = '2026-09-05T10:00:00.000Z';
  const env = { DB: db } as unknown as Env;
  const res = await createUnitsOnDelivery(env, order.id, delivered);
  assert.deepEqual(res, { serialized_items: 1, planned_units: 2, created: 2 });
  const units = raw
    .prepare('SELECT warranty_base_months, warranty_ext_months, warranty_start_at, warranty_end_at, policy_version FROM order_item_units WHERE order_id = ? ORDER BY unit_index')
    .all(order.id) as Array<Record<string, unknown>>;
  assert.equal(units.length, 2, 'one unit per physical printer');
  for (const u of units) {
    assert.equal(u.warranty_base_months, 12);
    assert.equal(u.warranty_ext_months, 24);
    assert.equal(u.warranty_start_at, delivered);
    assert.equal(u.warranty_end_at, addMonths(delivered, 36));
    assert.equal(JSON.parse(String(u.policy_version)).total, 36);
  }
  // Replaying the delivery event never duplicates units or restarts clocks.
  assert.deepEqual(await createUnitsOnDelivery(env, order.id, '2027-01-01T00:00:00.000Z'), { serialized_items: 1, planned_units: 2, created: 0 });
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM order_item_units WHERE order_id = ?').get(order.id)!.n, 2);
  await Promise.allSettled(pending);
});

// ------------------------------------ read-time defaults for an older printer

test('effectiveDevicePolicy: a printer is serialized with a 12-month base unless the owner said otherwise; a non-printer gets what is stored', () => {
  assert.deepEqual(effectiveDevicePolicy('{}', true), { serialized: true, warranty_base_months: 12 });
  assert.deepEqual(effectiveDevicePolicy(null, true), { serialized: true, warranty_base_months: 12 });
  assert.deepEqual(effectiveDevicePolicy('{"warranty_base_months":24}', true), { serialized: true, warranty_base_months: 24 });
  assert.deepEqual(effectiveDevicePolicy('{"serialized":false}', true), { serialized: false, warranty_base_months: 12 }, 'an explicit false is the owner’s word');
  assert.deepEqual(effectiveDevicePolicy({ serialized: null, warranty_base_months: null }, true), { serialized: true, warranty_base_months: 12 }, 'the document’s own pair reads the same');
  assert.deepEqual(effectiveDevicePolicy('{}', false), { serialized: false, warranty_base_months: null }, 'nothing is invented for a non-printer');
  assert.deepEqual(effectiveDevicePolicy('{"serialized":true,"warranty_months":18}', false), { serialized: true, warranty_base_months: 18 });
  assert.equal(effectiveBaseMonths(null, true), 12);
  assert.equal(effectiveBaseMonths(null, false), null);
  assert.equal(effectiveBaseMonths(6, true), 6);
  // pricedPlans hands the storefront the same default.
  assert.deepEqual(pricedPlans([EXT12], 899_000, null, true).map((w) => [w.base_months, w.total_months]), [[12, 24]]);
});

test('a printer stored before the rules (ops_policy "{}") still promises AND records 24/36 months: cart, product, checkout, delivery', async () => {
  const { db, raw } = setup();
  raw.exec("UPDATE products SET ops_policy = '{}' WHERE id = 'p_x1'");
  const a = appAs(db, 'buyer');

  // The product page and its quote say "+12 → 24 total".
  const detail = await json(await get(a, '/api/products/x1-printer'));
  assert.deepEqual(detail.product.warranty_plans.map((w: Record<string, unknown>) => [w.base_months, w.total_months]), [[12, 24], [12, 36]]);
  const quoted = await json(await post(a, '/api/products/x1-printer/quote', { qty: 1, warrantyPlanId: 'wp_ext12' }));
  assert.equal(quoted.quote.warranty.base_months, 12);
  assert.equal(quoted.quote.warranty.total_months, 24);

  // The cart prices and describes it the same way.
  const added = await json(await post(a, '/api/cart/items', { productId: 'p_x1', qty: 2, warrantyPlanId: 'wp_ext12' }));
  assert.equal(added.items[0].breakdown.warranty.base_months, 12);
  assert.equal(added.items[0].breakdown.warranty.total_months, 24);
  assert.deepEqual(added.items[0].warranty_plans.map((w: Record<string, unknown>) => w.total_months), [24, 36]);

  // The checkout freezes the promise…
  const placed = await json(await post(a, '/api/orders', orderBody('cash')));
  assert.equal(placed.success, true, JSON.stringify(placed));
  const order = placed.order;
  assert.equal(order.items[0].unit_price_iqd, 966_425);
  assert.equal(order.items[0].warranty.base_months, 12);
  assert.equal(order.items[0].warranty.total_months, 24);

  // …and the delivery creates the units that carry it — the fee was charged
  // for coverage a unit actually records.
  const delivered = '2026-09-05T10:00:00.000Z';
  const env = { DB: db } as unknown as Env;
  assert.deepEqual(await createUnitsOnDelivery(env, order.id, delivered), { serialized_items: 1, planned_units: 2, created: 2 });
  const units = raw
    .prepare('SELECT warranty_base_months, warranty_ext_months, warranty_end_at, policy_version FROM order_item_units WHERE order_id = ? ORDER BY unit_index')
    .all(order.id) as Array<Record<string, unknown>>;
  assert.equal(units.length, 2);
  for (const u of units) {
    assert.equal(u.warranty_base_months, 12);
    assert.equal(u.warranty_ext_months, 12);
    assert.equal(u.warranty_end_at, addMonths(delivered, 24));
    assert.equal(JSON.parse(String(u.policy_version)).total, 24);
  }
  // The admin's view of the order agrees with the hook.
  const adminView = await json(await get(appAs(db, 'adm', 'admin'), `/api/devices/admin/orders/${order.id}/units`));
  assert.equal(adminView.items[0].serialized, true);
  assert.equal(adminView.items[0].base_months, 12);

  // The owner's explicit `false` is still the owner's word: no units.
  raw.exec("UPDATE products SET ops_policy = '{\"serialized\":false}' WHERE id = 'p_x1'");
  assert.equal((await post(a, '/api/cart/items', { productId: 'p_x1', qty: 1 })).status, 200);
  const second = (await json(await post(a, '/api/orders', orderBody('cash')))).order;
  assert.deepEqual(await createUnitsOnDelivery(env, second.id, delivered), { serialized_items: 0, planned_units: 0, created: 0 });
  await Promise.allSettled(pending);
});

// ------------------------------------------- the legacy admin route (M2)

test('the legacy POST /api/admin/products runs the printer guard: a filament with a plan is refused, a printer with +12 saves, a 6-month plan is refused', async () => {
  const { db, raw } = setup();
  const admin = appAs(db, 'adm', 'admin');
  const before = (raw.prepare("SELECT warranty_plans FROM products WHERE id = 'p_pla'").get() as { warranty_plans: string }).warranty_plans;

  const fil = await post(admin, '/api/admin/products', { id: 'p_pla', slug: 'pla-basic', name: 'PLA Basic', price_iqd: 25_000, warranty_plans: [EXT12] });
  assert.equal(fil.status, 400);
  assert.equal((await json(fil)).code, WARRANTY_NOT_PRINTER);
  assert.equal((raw.prepare("SELECT warranty_plans FROM products WHERE id = 'p_pla'").get() as { warranty_plans: string }).warranty_plans, before, 'nothing was written');

  // A brand-new product is filed under no printer catalog yet: refused too.
  const fresh = await post(admin, '/api/admin/products', { slug: 'new-thing', name: 'New Thing', price_iqd: 10_000, warranty_plans: [EXT12] });
  assert.equal(fresh.status, 400);
  assert.equal((await json(fresh)).code, WARRANTY_NOT_PRINTER);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM products WHERE slug = 'new-thing'").get()!.n, 0);

  const odd = await post(admin, '/api/admin/products', { id: 'p_x1', slug: 'x1-printer', name: 'Printer X1', price_iqd: 899_000, warranty_plans: [plan({ duration_months: 6 })] });
  assert.equal(odd.status, 400);
  assert.equal((await json(odd)).code, WARRANTY_PLAN_INVALID);

  const ok = await post(admin, '/api/admin/products', { id: 'p_x1', slug: 'x1-printer', name: 'Printer X1', price_iqd: 899_000, warranty_plans: [EXT12] });
  assert.equal(ok.status, 200, JSON.stringify(await ok.clone().json()));
  const stored = JSON.parse((raw.prepare("SELECT warranty_plans FROM products WHERE id = 'p_x1'").get() as { warranty_plans: string }).warranty_plans);
  assert.deepEqual(stored.map((w: { id: string }) => w.id), ['wp_ext12']);
  // …and a printer save WITHOUT plans is simply fine.
  assert.equal((await post(admin, '/api/admin/products', { id: 'p_x1', slug: 'x1-printer', name: 'Printer X1', price_iqd: 899_000 })).status, 200);
  // A customer cannot reach the route at all.
  assert.equal((await post(appAs(db, 'buyer'), '/api/admin/products', { id: 'p_x1', name: 'X', price_iqd: 1 })).status, 403);
});

// ------------------------------------------- the ops-policy route (LOW)

test('POST /api/devices/admin/products/:id/ops-policy cannot switch off serialization on a printer with active plans', async () => {
  const { db, raw } = setup();
  const admin = appAs(db, 'adm', 'admin');
  const opsOf = (id: string) => JSON.parse((raw.prepare('SELECT ops_policy FROM products WHERE id = ?').get(id) as { ops_policy: string }).ops_policy);

  const off = await post(admin, '/api/devices/admin/products/p_x1/ops-policy', { serialized: false });
  assert.equal(off.status, 400);
  const body = await json(off);
  assert.equal(body.code, WARRANTY_PLAN_INVALID);
  assert.match(body.error, /serialized/);
  assert.equal(opsOf('p_x1').serialized, true, 'the stored policy is untouched');

  // Other changes to the same printer pass, and are written through the one writer.
  const base = await json(await post(admin, '/api/devices/admin/products/p_x1/ops-policy', { warranty_base_months: 24 }));
  assert.deepEqual(base.ops_policy, { serialized: true, warranty_base_months: 24 });
  assert.equal(opsOf('p_x1').warranty_base_months, 24);

  // A non-printer's device keys are its own business — its legacy plan does not block them.
  assert.equal((await post(admin, '/api/devices/admin/products/p_pla/ops-policy', { serialized: false })).status, 200);

  // With every plan switched off, the printer may stop being serialized.
  raw.prepare("UPDATE products SET warranty_plans = ? WHERE id = 'p_x1'").run(JSON.stringify([{ ...EXT12, active: false }, { ...EXT24, active: false }]));
  const now = await json(await post(admin, '/api/devices/admin/products/p_x1/ops-policy', { serialized: false }));
  assert.equal(now.ops_policy.serialized, false);
});

test('computeCoverage: the frozen total wins over a later product edit; legacy shapes still resolve; no base → needs_config', () => {
  const d = '2026-09-05T10:00:00.000Z';
  const ext12 = { plan_id: 'wp_ext12', duration_kind: 'extension', duration_months: 12 };
  // The printer's ops_policy base + the extension.
  assert.deepEqual(computeCoverage(12, ext12, d), { base_months: 12, ext_months: 12, total_months: 24, end_at: addMonths(d, 24) });
  assert.deepEqual(computeCoverage(12, { ...ext12, duration_months: 24 }, d).total_months, 36);
  // The product's base was changed (or never configured) AFTER the sale: the
  // snapshot's promise is what the unit records.
  assert.deepEqual(computeCoverage(null, { ...ext12, base_months: 12, total_months: 24 }, d), {
    base_months: 12, ext_months: 12, total_months: 24, end_at: addMonths(d, 24),
  });
  assert.deepEqual(computeCoverage(6, { ...ext12, base_months: 12, total_months: 24 }, d).total_months, 24);
  // An old snapshot (no total) on a printer whose base was never configured: honest null.
  assert.deepEqual(computeCoverage(null, ext12, d), { base_months: null, ext_months: 12, total_months: null, end_at: null });
  // Legacy 'total' plan: the total IS the plan; the extension is what exceeds the base.
  assert.deepEqual(computeCoverage(12, { duration_kind: 'total', duration_months: 24 }, d), { base_months: 12, ext_months: 12, total_months: 24, end_at: addMonths(d, 24) });
  // No plan: the base alone.
  assert.deepEqual(computeCoverage(12, null, d), { base_months: 12, ext_months: 0, total_months: 12, end_at: addMonths(d, 12) });
});

// ---------------------------------------------------------------- the policy

test('the extended_warranty policy: LEVONIS\'s own draft, in three languages, structured as the mandate asked', () => {
  assert.ok((POLICY_KEYS as readonly string[]).includes('extended_warranty'));
  const draft = POLICY_DRAFTS.find((d) => d.key === 'extended_warranty');
  assert.ok(draft, 'a draft exists for the key');
  for (const lang of POLICY_LANGS) {
    const body = draft!.body[lang];
    assert.ok(body.length >= 200);
    assert.ok(body.includes('⚠️'), `${lang}: the draft banner`);
    // Sorani writes its numerals in Arabic-Indic digits (٢٤ / ٣٦); Arabic and English in Latin.
    assert.ok(/24|٢٤/.test(body) && /36|٣٦/.test(body), `${lang}: names the 24 and 36 month totals`);
    assert.ok((body.match(/^## /gm) ?? []).length >= 8, `${lang}: eligibility, options, window, price, coverage, exclusions, claims, transfer`);
    assert.ok(!/bambu/i.test(body) && !/bambulab\.com/i.test(body), `${lang}: not copied from any manufacturer`);
    assert.ok(body.includes('PRO') && body.includes('PRIME'), `${lang}: says membership does not change the fee`);
  }
  const en = draft!.body.en;
  for (const phrase of ['printers only', '+12 months', '+24 months', 'Before the order is placed', 'percentage of the printer', 'nozzles', 'PTFE', 'warranty centre', 'follows the device']) {
    assert.ok(en.includes(phrase), `en draft mentions "${phrase}"`);
  }
  assert.ok(draft!.body.ar.includes('الفوهات') && draft!.body.ar.includes('قبل إتمام الطلب فقط'));
  assert.ok(draft!.body.ckb.includes('نۆزڵ'));
});

test('the policy is seeded, published and served like every other document', async () => {
  const { db } = setup();
  const admin = appAs(db, 'adm', 'admin');
  const seeded = await json(await post(admin, '/api/policies/admin/seed-drafts', {}));
  assert.ok(seeded.seeded.includes('extended_warranty'));
  const published = await post(admin, '/api/policies/admin/publish', {
    key: 'extended_warranty', version: 1, confirm: 'PUBLISH extended_warranty v1',
  });
  assert.equal(published.status, 200, JSON.stringify(await published.clone().json()));

  const customer = appAs(db, 'buyer');
  const en = await json(await get(customer, '/api/policies/extended_warranty?lang=en'));
  assert.equal(en.policy.title, 'Extended Warranty Policy (Printers)');
  assert.ok(en.policy.body.includes('36 months in total'));
  const list = await json(await get(customer, '/api/policies'));
  const row = list.policies.find((p: { key: string }) => p.key === 'extended_warranty');
  assert.ok(row, 'listed for the storefront link /policies/extended_warranty');
  assert.equal(row.required_for_checkout, false, 'reading the terms is not a checkout gate');
});

// --------------------------------------------------------- the TXT template

test('TXT template: fee_percent, warranty_base_months and serialized survive export → parse → document', () => {
  const doc = parseProductRow({
    id: 'p_x1', slug: 'x1-printer', name: 'Printer X1', name_ar: 'طابعة X1', price_iqd: 899_000,
    options: '[]', colors: '[]', selling_type: 'direct_sale', warranty_plans: PRINTER_PLANS, ops_policy: OPS,
  });
  const text = exportProduct(doc);
  for (const line of ['warranty_base_months=12', 'serialized=true', 'warranty_plans.1.fee_percent=7.5', 'warranty_plans.2.fee_percent=10', 'warranty_plans.1.duration_kind=extension']) {
    assert.ok(text.includes(`\n${line}\n`), `export writes ${line}`);
  }
  const parsed = parseTemplate(text);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.unknown_keys, []);
  const merged = toDocBody(parsed, null, { brand_id: null, catalog_ids: [] });
  const built = validateProductDoc(merged.body);
  assert.deepEqual(
    built.warranty_plans.map((w) => [w.id, w.duration_months, w.duration_kind, w.fee_percent, w.fee_iqd]),
    [['wp_ext12', 12, 'extension', 7.5, 0], ['wp_ext24', 24, 'extension', 10, 0]]
  );
  assert.equal(built.warranty_base_months, 12);
  assert.equal(built.serialized, true);
  // The example the download serves parses too (it documents the two plans as comments).
  const example = parseTemplate(buildExampleTemplate());
  assert.deepEqual(example.errors, []);
  assert.ok(buildExampleTemplate().includes('fee_percent=7.5'));
});

test('TXT template: a percent is 0.01..100 with two decimals; __NULL__ means the fixed fee; a plus is tolerated', () => {
  const head = 'template_version=2\nname_ar=طابعة\nprice_iqd=899000\nwarranty_plans.1.title_ar=ضمان\nwarranty_plans.1.duration_months=12\nwarranty_plans.1.duration_kind=extension\nwarranty_plans.1.fee_iqd=0\n';
  const percentOf = (v: string) => parseTemplate(`${head}warranty_plans.1.fee_percent=${v}\n`);
  for (const bad of ['150', '7.555', '0', 'abc', '']) {
    const p = percentOf(bad);
    assert.ok(p.errors.some((e) => e.key === 'warranty_plans.1.fee_percent'), `"${bad}" is refused with its key`);
  }
  for (const [ok, want] of [['7.5', 7.5], ['+7.5', 7.5], ['10', 10], ['__NULL__', null]] as Array<[string, number | null]>) {
    const p = percentOf(ok);
    assert.deepEqual(p.errors, [], `"${ok}" parses`);
    const body = toDocBody(p, null, { brand_id: null, catalog_ids: [] }).body;
    const plans = body.warranty_plans as Array<{ fee_percent: number | null }>;
    assert.equal(plans[0].fee_percent, want, `"${ok}" → ${String(want)}`);
  }
});

// ------------------------------------------------------------- the CSV sheet

test('CSV: the printer example carries the two plans (7.5 / 10) and its coverage; a percent cell is validated; the README says so', () => {
  const shape = templateShape('printer', [], { includeCost: true });
  const rows = exampleRows(shape);
  assert.equal(rows[0].warranty_base_months, '12');
  assert.equal(rows[0].serialized, 'yes');
  assert.deepEqual(
    rows.filter((r) => r.row_type === 'warranty').map((r) => [r.duration_months, r.kind, r.percent, r.price_iqd]),
    [['12', 'extension', '7.5', '0'], ['24', 'extension', '10', '0']]
  );
  for (const type of PRODUCT_TYPES) {
    if (type.id === 'printer') continue;
    const other = exampleRows(templateShape(type.id, [], { includeCost: true }));
    assert.equal(other.filter((r) => r.row_type === 'warranty').length, 0, `${type.id} example offers no extended warranty`);
  }
  const text = blankTemplate(shape, true);
  const parsed = parseImport(text, shape);
  assert.deepEqual(parsed.issues.filter((i) => i.severity === 'error'), []);
  const p = parsed.products[0];
  assert.deepEqual(p.warranty_plans?.map((w) => [w.duration_months, w.duration_kind, w.fee_percent]), [[12, 'extension', 7.5], [24, 'extension', 10]]);
  assert.equal(p.warranty_base_months, 12);
  assert.equal(p.serialized, true);
  // A percent outside the rules is refused on its own line, naming the column.
  const broken = text
    .split('\n')
    .map((line) => (line.includes('Extended warranty +12 months') ? line.replace(',7.5,', ',150,') : line))
    .join('\n');
  assert.notEqual(broken, text, 'the fixture line was found');
  const issue = parseImport(broken, shape).issues.find((i) => i.message.startsWith('percent'));
  assert.ok(issue, 'the percent cell is refused with its column name');
  const readme = readmeFor(shape);
  assert.ok(readme.includes('percent') && readme.includes('warranty_base_months') && readme.includes('serialized'));
  assert.ok(readme.includes('للطابعات فقط'));
});

test('CSV resolver: a warranty row on a non-printer section is refused in the PREVIEW; on a printer it lands with its percent and coverage', () => {
  const shape = templateShape('printer', [], { includeCost: true });
  const parsed = parseImport(blankTemplate(shape, true), shape).products[0];
  const filaments: CatalogRef = {
    id: 'cat_fil', parent_id: null, slug: 'filaments', name_en: 'Filaments', name_ar: 'خيوط', template_family: 'materials', is_printer_catalog: false,
  };
  const printers: CatalogRef = {
    id: 'cat_printers', parent_id: null, slug: 'printers', name_en: 'Printers', name_ar: 'الطابعات', template_family: 'devices', is_printer_catalog: true,
  };
  const maps: ImportMaps = {
    brands: new Map(),
    catalogs: new Map([[normKey('Filaments'), filaments], [normKey('Printers'), printers]]),
    facets: new Map(),
    familyOf: new Map([['cat_fil', 'materials'], ['cat_printers', 'devices']]),
    images: new Map(),
    productSlugs: new Map(),
  };
  const newId = () => {
    let n = 0;
    return (prefix: string) => `${prefix}_${++n}`;
  };
  const refused = resolveProduct({ ...parsed, category: 'Filaments' }, null, maps, { newId: newId(), money: true });
  const warrantyIssues = refused.issues.filter((i) => /warranty/i.test(i.message));
  assert.equal(warrantyIssues.length, 1, JSON.stringify(refused.issues));
  assert.equal(warrantyIssues[0].severity, 'error');
  assert.match(warrantyIssues[0].message, /WARRANTY_NOT_PRINTER/);
  assert.equal(warrantyIssues[0].line, parsed.warranty_plans![0].line, 'reported on the first warranty row');

  const ok = resolveProduct({ ...parsed, category: 'Printers' }, null, maps, { newId: newId(), money: true });
  assert.deepEqual(ok.issues.filter((i) => /warranty/i.test(i.message)), []);
  assert.deepEqual(
    (ok.doc.warranty_plans as Array<{ duration_months: number; fee_percent: number | null }>).map((w) => [w.duration_months, w.fee_percent]),
    [[12, 7.5], [24, 10]]
  );
  assert.equal(ok.doc.warranty_base_months, 12);
  assert.equal(ok.doc.serialized, true);
});

// ------------------------------------------------ structural: after the order

test('no route in the worker writes order_items.warranty_snapshot after the checkout INSERT', () => {
  const files: string[] = [];
  for (const dir of ['worker/routes', 'worker/lib']) {
    for (const f of readdirSync(join(ROOT, dir)).filter((x) => x.endsWith('.ts'))) files.push(join(dir, f));
  }
  const inserts: string[] = [];
  for (const rel of files) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    assert.ok(!/UPDATE\s+order_items[^`]*warranty_snapshot/s.test(src), `${rel} updates warranty_snapshot`);
    assert.ok(!/UPDATE\s+order_items\s+SET\s+[^`]*warranty/s.test(src), `${rel} rewrites a warranty column on an order item`);
    if (/INSERT\s+INTO\s+order_items[^`]*warranty_snapshot/s.test(src)) inserts.push(rel);
  }
  assert.deepEqual(inserts, ['worker/routes/orders.ts'], 'the checkout is the only writer of the snapshot');
});
