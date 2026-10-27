/**
 * THE PURCHASE SCREEN FOLLOWS ITS CURRENT RATE, FREIGHT AND QUANTITY, AND
 * «السعر بعد الخصم» (owner request 2026-10-27).
 *
 * 1. Every IQD cost of a purchase line is derived from the document as it is
 *    now: its exchange rate, freight rate and quantity. A figure derived at
 *    entry time (the line total of a unit price, the unit average of an
 *    invoice total) follows a new quantity; «reload route rates» starts the
 *    rate at the approved central rate, never the route's last saved one; an
 *    edit at a new rate re-costs the stored line and the lot it is received as.
 * 2. An optional unit price after the supplier discount: when typed, the line
 *    is costed from it (screen and server alike), the raw supplier price stays
 *    recorded as the before-discount price, and an edit restores both.
 *
 * Run: node --import tsx --test tests/procurementDiscountAndRates.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { get, json, post, put } from './fixtures/app';
import { AMS, AMS_MODEL, pricingWorld } from './fixtures/procurementPricing';
import { ROOT } from './fixtures/d1';
import { purchaseEstimate } from '../src/components/adminOperations/purchaseEstimate';
import { changeLineCostProfile, changeLineQuantity, discountProblem, restoreLineDiscounts, type ProcurementDraftLine } from '../src/components/adminOperations/procurementCostDraft';
import { procurementCostSource } from '../packages/contracts/src/procurementCost';
import { COST_REFUSALS } from '../packages/contracts/src/costRefusals';

const line = (extra: Partial<ProcurementDraftLine> = {}) => ({
  product_id: AMS, scope: 'option', scope_id: AMS_MODEL, label: 'AMS', sku: '', stock: null, reserved: 0,
  qty_ordered: 2, invoiced_qty: 2, purchase_cost_mode: 'unit', source_unit_amount: 450, source_total_amount: 900,
  selling_price_iqd: null, weight_g: 2500, volume_mm3: 0, ...extra,
}) as unknown as ProcurementDraftLine;

const shipping = (rate: number) => ({ basis: 'weight' as const, rate });

test('the estimate is re-derived from the current rate and freight: nothing is kept from an earlier rate', () => {
  const at = (rate: number, freight: number) => purchaseEstimate([line()], [], rate, 0, undefined, shipping(freight))[0];
  assert.equal(at(1760, 5000).purchase_iqd, 1_584_000);
  assert.equal(at(1760, 5000).auto_shipping_iqd, 25_000);
  assert.equal(at(1700, 5000).purchase_iqd, 1_530_000);
  assert.equal(at(1700, 6000).auto_shipping_iqd, 30_000);
  assert.equal(at(1700, 6000).unit_iqd, (1_530_000 + 30_000) / 2);
});

test('«السعر بعد الخصم» is the price the estimate costs, in unit and total input alike', () => {
  const discounted = purchaseEstimate([line({ discounted_unit_amount: 400 })], [], 1760, 0, undefined, shipping(5000))[0];
  assert.equal(discounted.purchase_iqd, 1_408_000);
  const fromTotal = purchaseEstimate([line({ purchase_cost_mode: 'total', source_total_amount: 900, discounted_unit_amount: 400 })], [], 1760, 0)[0];
  assert.equal(fromTotal.purchase_iqd, 1_408_000);
  // Blank: the raw input, as before.
  assert.equal(purchaseEstimate([line({ discounted_unit_amount: '' })], [], 1760, 0)[0].purchase_iqd, 1_584_000);
  assert.deepEqual(procurementCostSource({ purchase_cost_mode: 'total', source_total_amount: 900 }), { mode: 'total', amount: 900, discounted: false });
});

test('a new quantity re-derives the line total of a unit price and the unit average of an invoice total', () => {
  const unit = changeLineQuantity(line(), 3);
  assert.equal(unit.qty_ordered, 3);
  assert.equal(unit.invoiced_qty, 3);
  assert.equal(unit.source_unit_amount, 450);
  assert.equal(unit.source_total_amount, 1350);
  const total = changeLineQuantity(line({ purchase_cost_mode: 'total', source_total_amount: 900, source_unit_amount: 450 }), 4);
  assert.equal(total.source_total_amount, 900);
  assert.equal(total.source_unit_amount, 225);
  // A cleared quantity no longer strands the invoice quantity.
  const cleared = changeLineQuantity(line(), NaN);
  assert.equal(changeLineQuantity(cleared, 5).invoiced_qty, 5);
  // A distinct invoice quantity is the owner's own.
  assert.equal(changeLineQuantity(line({ invoiced_qty: 1 }), 3).invoiced_qty, 1);
});

test('a discount above the raw price is refused on screen; a route change clears it', () => {
  assert.equal(discountProblem(line({ discounted_unit_amount: 400 }), 'EUR'), null);
  assert.equal(discountProblem(line({ discounted_unit_amount: 451 }), 'EUR'), 'above');
  assert.equal(discountProblem(line({ purchase_cost_mode: 'total', source_total_amount: 900, discounted_unit_amount: 450 }), 'EUR'), null);
  assert.equal(discountProblem(line({ discounted_unit_amount: 1.5, source_unit_amount: 5 }), 'IQD'), 'invalid');
  assert.equal(discountProblem(line({ discounted_unit_amount: NaN }), 'EUR'), 'invalid');
  assert.equal(changeLineCostProfile(line({ discounted_unit_amount: 400 }), null).discounted_unit_amount, '');
});

test('the discount is saved as the cost, the raw price stays recorded, an edit restores both and a new rate re-costs the lot', async () => {
  const w = pricingWorld();
  const body = w.draft({ lines: [{ ...w.draft().lines[0], discounted_unit_amount: 400 }] });
  const id = await w.save(body);
  const stored = w.raw.prepare(`SELECT l.source_unit_amount, l.purchase_cost_mode, l.source_total_amount, i.purchase_total_iqd, l.charges_iqd
    FROM purchase_lines l JOIN incoming_inventory i ON i.id = l.incoming_id WHERE l.purchase_id = ?`).get(id) as Record<string, number | string | null>;
  assert.equal(stored.source_unit_amount, 400);
  assert.equal(stored.purchase_cost_mode, 'unit');
  assert.equal(stored.purchase_total_iqd, 400 * 1760 * 2);
  assert.equal(stored.charges_iqd, 25_000);
  // The next purchase's prefill is the raw supplier price, not this purchase's discount.
  assert.equal((w.raw.prepare('SELECT source_unit_amount FROM procurement_selection_cost_defaults WHERE product_id = ?').get(AMS) as { source_unit_amount: number }).source_unit_amount, 450);
  // An edit restores the raw price and the discount from the saved request.
  const doc = await json(await get(w.app, `/api/admin/procurement/documents/${id}`));
  const restored = restoreLineDiscounts(doc.lines as ProcurementDraftLine[], doc.purchase.request_json as string);
  assert.equal(restored[0].source_unit_amount, 450);
  assert.equal(restored[0].discounted_unit_amount, 400);
  // The edit at a new rate and freight re-costs the stored line, and the lot is received at it.
  const edit = await put(w.app, `/api/admin/procurement/documents/${id}`, {
    ...w.draft({ exchange_rate: 1700, shipping_rate_iqd: 6000, cost_profile_version: w.profileVersion() }),
    lines: [{ ...body.lines[0], source_unit_amount: restored[0].source_unit_amount, discounted_unit_amount: restored[0].discounted_unit_amount }],
    version: doc.purchase.version,
  });
  assert.equal(edit.status, 200, JSON.stringify(await json(edit)));
  const after = w.raw.prepare('SELECT i.purchase_total_iqd, l.charges_iqd FROM purchase_lines l JOIN incoming_inventory i ON i.id = l.incoming_id WHERE l.purchase_id = ?').get(id) as { purchase_total_iqd: number; charges_iqd: number };
  assert.deepEqual({ ...after }, { purchase_total_iqd: 400 * 1700 * 2, charges_iqd: 30_000 });
  const received = await w.receive(id, `rcv_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`);
  assert.equal(received.status, 200, JSON.stringify(received.body));
  const lots = w.raw.prepare('SELECT unit_cost_iqd FROM inventory_lots').all() as Array<{ unit_cost_iqd: number }>;
  assert.ok(lots.length > 0);
  for (const lot of lots) assert.equal(lot.unit_cost_iqd, (400 * 1700 * 2 + 30_000) / 2);
});

test('the server refuses a discount above the raw price, in three languages, and the preview costs the discount', async () => {
  const w = pricingWorld();
  const res = await post(w.app, '/api/admin/procurement/documents', w.draft({ lines: [{ ...w.draft().lines[0], discounted_unit_amount: 451 }] }));
  assert.equal(res.status, 400);
  assert.equal((await json(res)).code, 'PURCHASE_DISCOUNT_ABOVE_PRICE');
  assert.equal(Number((w.raw.prepare('SELECT COUNT(*) AS n FROM purchase_orders').get() as { n: number }).n), 0);
  const s = COST_REFUSALS.PURCHASE_DISCOUNT_ABOVE_PRICE;
  assert.ok(s.ar && s.en && s.ckb && (s.ckb as string) !== s.ar);
  // The pricing card reads the draft through the same parser: the discounted price is the one it sees.
  const full = await w.preview({ draft: w.draft() });
  const cut = await w.preview({ draft: w.draft({ lines: [{ ...w.draft().lines[0], discounted_unit_amount: 300 }] }) });
  assert.equal(full.status, 200, JSON.stringify(full.body));
  assert.equal(cut.status, 200, JSON.stringify(cut.body));
  assert.notDeepEqual(cut.body.lines, full.body.lines);
});

const panel = readFileSync(join(ROOT, 'src/components/adminOperations/ProcurementPanel.tsx'), 'utf8');

test('the panel: route rates reload at the approved rate, quantity re-derives, the discount field in three languages', () => {
  assert.doesNotMatch(panel, /exchange_rate: profile\.exchange_rate \?\? NaN/, 'reloading route rates never brings back the route\'s old saved rate');
  assert.match(panel, /exchange_rate: prefillRate\(cfg\.approved_rates \?\? \[\], profile\.currency\)/);
  assert.match(panel, /changeLineQuantity\(x, v === '' \? NaN : Number\(v\)\)/);
  assert.match(panel, /loc\('السعر بعد الخصم', 'Price after discount', 'نرخ دوای داشکاندن'\)/);
  assert.match(panel, /discountProblem\(l, header\.currency\) === null/, 'a refused discount blocks the save');
  assert.match(panel, /restoreLineDiscounts\(/);
  assert.match(panel, /discounted_unit_amount: '', cost_source: 'unknown'/, 'a currency switch clears the discount with the raw price');
});
