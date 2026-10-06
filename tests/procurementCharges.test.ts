/**
 * «تكاليف إضافية للقطعة» — extra purchase costs are only what the buyer typed
 * for this shipment. Landed unit cost = raw supplier price after currency
 * conversion + route freight by packed weight + those extra costs, each with a
 * name, a positive amount, a scope and an exact share on every line it covers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asD1, stubApp, post, put, get, json, count } from './fixtures/app';
import { adminProcurementRoutes } from '../worker/routes/adminProcurement';
import { allocateProcurementCharges, procurementSelectionKey, type ProcurementCharge } from '../packages/contracts/src/procurementCost';
import { purchaseEstimate } from '../src/components/adminOperations/purchaseEstimate';
import { chargeDraft, chargeProblems, chargesAfterRouteChange, chargeWire, looksLikeFreight, newChargeDraft } from '../src/components/adminOperations/procurementCharges';
import { cloneCostProfileSnapshot, restoreCostProfileSnapshot } from '../src/components/adminOperations/procurementCostDraft';
import type { CostProfile } from '../packages/contracts/src/procurementCost';

const PRINTER = 'printer:option:combo', PART = 'part:base:';
const shipment = (amount_iqd: number, basis: ProcurementCharge['basis'] = 'quantity', applies_to: string[] | null = null): ProcurementCharge => ({ scope: 'shipment', amount_iqd, unit_amount_iqd: null, basis, applies_to });
const perPiece = (unit_amount_iqd: number, applies_to: string[] | null = null): ProcurementCharge => ({ scope: 'unit', amount_iqd: 0, unit_amount_iqd, basis: 'quantity', applies_to });
const twoLines = [
  { key: PRINTER, qty: 5, value: 6912162, weight_g: 22300, volume_mm3: 0 },
  { key: PART, qty: 10, value: 161688, weight_g: 1000, volume_mm3: 0 },
];

test('the shared allocator splits every dinar of a shipment cost by its basis, and nothing more', () => {
  const [byQty, byValue, byWeight] = allocateProcurementCharges([shipment(30000), shipment(100001, 'value'), shipment(1000, 'weight')], twoLines);
  assert.deepEqual(byQty, [10000, 20000]);
  assert.equal(byValue[0] + byValue[1], 100001);
  assert.deepEqual(byValue, [97715, 2286]);
  assert.deepEqual(byWeight, [918, 82], '5 × 22.3 kg against 10 × 1 kg');
  assert.throws(() => allocateProcurementCharges([shipment(500, 'volume')], twoLines), /allocation basis/, 'no measurement, no silent zero');
});

test('a per-piece cost is its amount times the pieces it covers; an uncovered line receives exactly 0', () => {
  const [packaging, customs] = allocateProcurementCharges([perPiece(1000, [PART]), shipment(100000, 'value', [PRINTER])], twoLines);
  assert.deepEqual(packaging, [0, 10000]);
  assert.deepEqual(customs, [100000, 0]);
  assert.deepEqual(allocateProcurementCharges([perPiece(2000)], twoLines), [[10000, 20000]]);
  assert.throws(() => allocateProcurementCharges([shipment(10, 'quantity', ['ghost:base:'])], twoLines), /covers no line/);
  assert.equal(procurementSelectionKey({ product_id: 'part', scope: 'base', scope_id: null }), PART);
});

const line = (qty: number, extra: Record<string, unknown> = {}) => ({ product_id: 'printer', scope: 'option', scope_id: 'combo', label: 'X2D Combo', qty_ordered: qty, source_unit_amount: 855, selling_price_iqd: 2000000, weight_g: 22300, volume_mm3: 0, ...extra });
const route = (rate = 5944) => ({ basis: 'weight' as const, rate });

test('with no extra expense entered, extras are 0 and the landed unit is raw + freight only', () => {
  // The owner's screen: X2D Combo × 5, 855 EUR, 22.3 kg packed.
  const [e] = purchaseEstimate([line(5)], [], 1616.88, 0, undefined, route());
  assert.equal(e.purchase_iqd / 5, 1382432.4);
  assert.equal(e.auto_shipping_iqd / 5, 132551.2);
  assert.equal(e.extras_iqd, 0);
  assert.deepEqual(e.charge_shares, []);
  assert.equal(e.total_iqd, 6912162 + 662756);
  assert.equal(e.unit_iqd, 7574918 / 5, '1,382,432.4 + 132,551.2 = 1,514,983.6');
  assert.equal(e.freight_iqd, e.auto_shipping_iqd, 'freight is counted once, in its own row');
});

test('only typed extra expenses are added, and changing one recomputes the landed cost at once', () => {
  const charges = [{ ...newChargeDraft(), title: 'توصيل محلي', amount_iqd: 50000 }, { ...newChargeDraft(), title: 'تغليف', scope: 'unit' as const, unit_amount_iqd: 2000 }];
  const [e] = purchaseEstimate([line(5)], charges, 1616.88, 0, undefined, route());
  assert.deepEqual(e.charge_shares, [50000, 10000]);
  assert.equal(e.extras_iqd / 5, 12000);
  assert.equal(e.unit_iqd, (6912162 + 662756 + 60000) / 5);
  const [cheaper] = purchaseEstimate([line(5)], [{ ...charges[0], amount_iqd: 25000 }, charges[1]], 1616.88, 0, undefined, route());
  assert.equal(cheaper.unit_iqd, (6912162 + 662756 + 35000) / 5);
  const [more] = purchaseEstimate([line(10)], charges, 1616.88, 0, undefined, route());
  assert.deepEqual(more.charge_shares, [50000, 20000], 'per-piece follows quantity, the shipment amount does not grow');
});

test('a charge carried from manual entry into a route counts nothing until confirmed', () => {
  const manual = [{ ...newChargeDraft(), title: 'شحن', amount_iqd: 466330 }];
  assert.deepEqual(chargesAfterRouteChange(manual, null, null), manual);
  const carried = chargesAfterRouteChange(manual, null, 'germany_land');
  assert.equal(carried[0].review, true);
  assert.deepEqual(chargesAfterRouteChange(carried, 'germany_land', 'china_air'), carried, 'route to route keeps decisions');
  const [e] = purchaseEstimate([line(5)], carried, 1616.88, 0, undefined, route());
  assert.equal(e.extras_iqd, 0, 'the 93,266 IQD per piece of the stale freight is not charged');
  assert.equal(e.unit_iqd, 7574918 / 5);
  assert.deepEqual(chargeProblems(carried[0], [PRINTER], true), ['review']);
  assert.deepEqual(chargeProblems({ ...carried[0], review: false }, [PRINTER], true), []);
});

test('a charge is complete only with a name, a positive amount and lines of this shipment', () => {
  const keys = [PRINTER, PART];
  assert.deepEqual(chargeProblems(newChargeDraft(), keys, true), ['title', 'amount']);
  assert.deepEqual(chargeProblems({ ...newChargeDraft(), title: 'جمارك', amount_iqd: 0 }, keys, true), ['amount']);
  assert.deepEqual(chargeProblems({ ...newChargeDraft(), title: 'تغليف', scope: 'unit', amount_iqd: 5000, unit_amount_iqd: NaN }, keys, true), ['amount'], 'the shipment field never stands in for the per-piece amount');
  assert.deepEqual(chargeProblems({ ...newChargeDraft(), title: 'جمارك', amount_iqd: 10, applies_to: [] }, keys, true), ['lines']);
  assert.deepEqual(chargeProblems({ ...newChargeDraft(), title: 'جمارك', amount_iqd: 10, applies_to: ['removed:base:'] }, keys, true), ['lines']);
  assert.deepEqual(chargeProblems({ ...newChargeDraft(), title: 'جمارك', amount_iqd: 10, basis: 'volume' }, keys, false), ['basis']);
  const byVolume = { ...newChargeDraft(), title: 'جمارك', amount_iqd: 10, basis: 'volume' as const };
  const [missing] = purchaseEstimate([line(1)], [byVolume], 1616.88, 0, undefined, route());
  assert.ok(Number.isNaN(missing.unit_iqd), 'an unallocatable charge blocks the total instead of vanishing');
});

test('saved rows and older drafts read back as typed; the request carries only the active amount', () => {
  assert.deepEqual(chargeDraft({ title: 'شحن', amount_iqd: 466330, basis: 'quantity' }), { title: 'شحن', scope: 'shipment', amount_iqd: 466330, unit_amount_iqd: NaN, basis: 'quantity', applies_to: null });
  const saved = chargeDraft({ id: 'pch_1', title: 'تغليف', scope: 'unit', amount_iqd: 10000, unit_amount_iqd: 2000, basis: 'quantity', applies_to: [PRINTER], allocations: [] });
  assert.equal(saved.unit_amount_iqd, 2000);
  assert.ok(Number.isNaN(saved.amount_iqd));
  assert.deepEqual(chargeWire(saved), { title: 'تغليف', scope: 'unit', basis: 'quantity', amount_iqd: null, unit_amount_iqd: 2000, applies_to: [PRINTER] });
  assert.deepEqual(chargeWire({ ...newChargeDraft(), title: ' جمارك ', amount_iqd: 7000, unit_amount_iqd: 9, basis: 'value' }), { title: 'جمارك', scope: 'shipment', basis: 'value', amount_iqd: 7000, unit_amount_iqd: null, applies_to: null });
  assert.equal(chargeDraft({ title: 'x', basis: 'pallets', review: true }).basis, 'quantity');
  assert.equal(chargeDraft({ title: 'x', review: true }).review, true);
});

test('a freight-like name is flagged for a second look, local costs are not', () => {
  for (const title of ['شحن', 'الشحن الدولي', 'Shipping', 'freight', 'بارکردن']) assert.equal(looksLikeFreight(title), true, title);
  for (const title of ['توصيل محلي', 'تخليص الشحنة', 'جمارك', 'رسوم تحويل', 'تغليف', 'Transshipment fee']) assert.equal(looksLikeFreight(title), false, title);
});

test('a copied purchase is priced at the route’s current rates; editing keeps the document’s own', () => {
  const germany: CostProfile = { id: 'germany_land', name_ar: 'ألمانيا', name_en: 'Germany', currency: 'EUR', shipping_basis: 'weight', exchange_rate: 1616.88, shipping_rate_iqd: 5944, version: 9 };
  const old = { cost_profile_id: 'germany_land', cost_profile_version: 3, currency: 'EUR', exchange_rate: 1500, shipping_rate_iqd: 5000, shipping_basis: 'weight' as const };
  const copy = cloneCostProfileSnapshot(old, [germany]);
  assert.equal(copy.exchange_rate, 1616.88);
  assert.equal(copy.shipping_rate_iqd, 5944);
  assert.equal(copy.cost_profile_version, 9);
  const edit = restoreCostProfileSnapshot(old, [germany]);
  assert.equal(edit.exchange_rate, 1500);
  assert.equal(edit.shipping_rate_iqd, 5000);
  const unsaved = cloneCostProfileSnapshot(old, [{ ...germany, exchange_rate: null }]);
  assert.ok(Number.isNaN(unsaved.exchange_rate), 'no saved route rate: the buyer types it, the old one is not reused');
  assert.equal(cloneCostProfileSnapshot({ currency: 'IQD', exchange_rate: 1 }, [germany]).cost_profile_id, null);
});

function setup() {
  const raw = freshDb();
  raw.exec(`INSERT INTO users(id,email,role,admin_scope) VALUES ('owner','boss@x.co','admin','full');
    INSERT INTO products(id,name,slug,price_iqd,product_cost_iqd,stock,inventory_mode,net_weight_g,package_weight_g)
    VALUES ('printer','X2D','charges-x2d',2000000,0,0,'OPTION',20000,22300),('part','Part','charges-part',20000,0,0,'BASE',1000,1000);
    INSERT INTO product_option_groups(id,product_id,name_en) VALUES('model','printer','Model');
    INSERT INTO product_option_values(id,product_id,group_id,name_en,stock) VALUES('combo','printer','model','Combo',0);`);
  const app = stubApp(asD1(raw), { id: 'owner', email: 'boss@x.co', role: 'admin', admin_scope: 'full' }, (a) => a.route('/p', adminProcurementRoutes));
  const payload = (extra: Record<string, unknown> = {}) => ({ operation_id: crypto.randomUUID(), currency: 'EUR', exchange_rate: 1616.88,
    cost_profile_id: 'germany_land', cost_profile_version: 1, shipping_rate_iqd: 5944, status: 'ordered', cost_state: 'final',
    lines: [{ product_id: 'printer', scope: 'option', scope_id: 'combo', qty_ordered: 5, source_unit_amount: 855, weight_g: 22300 }], charges: [], ...extra });
  return { raw, app, payload };
}

test('server: no extra expense saves 0 extras — the line carries route freight only', async () => {
  const x = setup(), res = await post(x.app, '/p/documents', x.payload()), created = await json(res);
  assert.equal(res.status, 200, JSON.stringify(created));
  const d = await json(await get(x.app, `/p/documents/${created.id}`));
  assert.equal(d.lines[0].purchase_total_iqd, 6912162);
  assert.equal(d.lines[0].auto_shipping_iqd, 662756);
  assert.equal(d.lines[0].charges_iqd, 662756);
  assert.equal(d.ordered_total_iqd, 7574918);
  assert.deepEqual(d.charges, []);
});

test('server: each extra expense is saved with its scope, coverage and exact share on every line', async () => {
  const x = setup();
  const body = x.payload({
    lines: [
      { product_id: 'printer', scope: 'option', scope_id: 'combo', qty_ordered: 5, source_unit_amount: 855, weight_g: 22300 },
      { product_id: 'part', scope: 'base', scope_id: '', qty_ordered: 10, source_unit_amount: 10, weight_g: 1000 },
    ],
    charges: [
      { title: 'توصيل محلي', scope: 'shipment', amount_iqd: 30000, basis: 'quantity' },
      { title: 'جمارك الطابعة', scope: 'shipment', amount_iqd: 100000, basis: 'value', applies_to: [PRINTER] },
      { title: 'تغليف القطع', scope: 'unit', unit_amount_iqd: 1000, applies_to: [PART] },
    ],
  });
  const res = await post(x.app, '/p/documents', body), id = (await json(res)).id;
  assert.equal(res.status, 200);
  const d = await json(await get(x.app, `/p/documents/${id}`));
  const printer = d.lines.find((l: { product_id: string }) => l.product_id === 'printer'), part = d.lines.find((l: { product_id: string }) => l.product_id === 'part');
  assert.equal(printer.auto_shipping_iqd, 662756);
  assert.equal(part.auto_shipping_iqd, 59440);
  assert.equal(printer.charges_iqd, 662756 + 10000 + 100000);
  assert.equal(part.charges_iqd, 59440 + 20000 + 10000);
  assert.deepEqual(d.charges.map((c: Record<string, unknown>) => [c.title, c.scope, c.amount_iqd, c.unit_amount_iqd, c.basis, c.applies_to]), [
    ['توصيل محلي', 'shipment', 30000, null, 'quantity', null],
    ['جمارك الطابعة', 'shipment', 100000, null, 'value', [PRINTER]],
    ['تغليف القطع', 'unit', 10000, 1000, 'quantity', [PART]],
  ]);
  const share = (c: { allocations: { line_id: string; amount_iqd: number }[] }, l: { line_id: string }) => c.allocations.find((a) => a.line_id === l.line_id)?.amount_iqd;
  assert.deepEqual(d.charges.map((c: never) => [share(c, printer), share(c, part)]), [[10000, 20000], [100000, undefined], [undefined, 10000]]);
  for (const l of [printer, part]) assert.equal(d.charges.reduce((n: number, c: never) => n + (share(c, l) ?? 0), 0), l.charges_iqd - l.auto_shipping_iqd, 'shares explain every extra dinar');
  // Reopening and saving the document as it reads back changes nothing.
  const edit = await put(x.app, `/p/documents/${id}`, { ...body, version: 1, cost_profile_version: 2, lines: d.lines, charges: d.charges });
  assert.equal(edit.status, 200, JSON.stringify(await json(edit)));
  const again = await json(await get(x.app, `/p/documents/${id}`));
  assert.equal(again.ordered_total_iqd, d.ordered_total_iqd);
  assert.deepEqual(again.charges.map((c: Record<string, unknown>) => [c.title, c.amount_iqd, c.unit_amount_iqd]), d.charges.map((c: Record<string, unknown>) => [c.title, c.amount_iqd, c.unit_amount_iqd]));
});

test('server: refuses an extra expense with no clear source instead of saving it', async () => {
  const x = setup();
  const cases: Array<[unknown, string]> = [
    [{ title: '', amount_iqd: 5000 }, 'BAD_CHARGE'],
    [{ title: 'رسوم إضافية', amount_iqd: 0 }, 'BAD_CHARGE'],
    [{ title: 'تغليف', scope: 'unit', unit_amount_iqd: 0 }, 'BAD_CHARGE'],
    [{ title: 'تغليف', scope: 'unit', amount_iqd: 5000 }, 'BAD_NUMBER'],
    [{ title: 'جمارك', amount_iqd: 5000, applies_to: [] }, 'BAD_CHARGE'],
    [{ title: 'جمارك', amount_iqd: 5000, applies_to: ['ghost:base:'] }, 'BAD_CHARGE'],
    [{ title: 'جمارك', scope: 'pallet', amount_iqd: 5000 }, 'BAD_CHARGE'],
    [{ title: 'جمارك', amount_iqd: 5000, basis: 'volume' }, 'BAD_ALLOCATION'],
  ];
  for (const [charge, code] of cases) {
    const res = await post(x.app, '/p/documents', x.payload({ charges: [charge] }));
    assert.equal(res.status, 400, JSON.stringify(charge));
    assert.equal((await json(res)).code, code, JSON.stringify(charge));
  }
  const many = await post(x.app, '/p/documents', x.payload({ charges: Array.from({ length: 16 }, (_, i) => ({ title: `رسم ${i}`, amount_iqd: 1 })) }));
  assert.equal((await json(many)).code, 'BAD_CHARGE');
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM purchase_orders'), 0, 'nothing refused was written');
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM purchase_charges'), 0);
});

test('server: a document saved before shares were stored shows them only when they reproduce its lines exactly', async () => {
  const x = setup();
  const body = x.payload({ lines: [line(5), line(2, { product_id: 'part', scope: 'base', scope_id: '', source_unit_amount: 10, weight_g: 1000 })], charges: [{ title: 'توصيل', amount_iqd: 1001, basis: 'quantity' }] });
  const id = (await json(await post(x.app, '/p/documents', body))).id;
  const fresh = await json(await get(x.app, `/p/documents/${id}`));
  x.raw.exec(`UPDATE purchase_charges SET allocation_json=NULL, position=NULL WHERE purchase_id='${id}'`);
  const legacy = await json(await get(x.app, `/p/documents/${id}`));
  const byLine = (shares: { line_id: string; amount_iqd: number }[]) => Object.fromEntries(shares.map((a) => [a.line_id, a.amount_iqd]));
  assert.deepEqual(byLine(legacy.charges[0].allocations), byLine(fresh.charges[0].allocations));
  x.raw.exec(`UPDATE purchase_lines SET charges_iqd=charges_iqd+1 WHERE purchase_id='${id}' AND label LIKE 'X2D%'`);
  const drifted = await json(await get(x.app, `/p/documents/${id}`));
  assert.equal(drifted.charges[0].allocations, null, 'an unreproducible split is shown as unknown, never guessed');
});
