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
 * 2. DECISIONS row 273: «السعر بعد الخصم» is the product's sale price (the
 *    purchase card writes «تخفيض السعر»), never a supplier discount. A retired
 *    `discounted_unit_amount` an older draft carries is ignored: the line is
 *    costed from its raw supplier price, and an old saved line restores it.
 *
 * Run: node --import tsx --test tests/procurementDiscountAndRates.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { get, json, put } from './fixtures/app';
import { AMS, AMS_MODEL, pricingWorld } from './fixtures/procurementPricing';
import { ROOT } from './fixtures/d1';
import { purchaseEstimate } from '../src/components/adminOperations/purchaseEstimate';
import { changeLineQuantity, restoreLineDiscounts, type ProcurementDraftLine } from '../src/components/adminOperations/procurementCostDraft';
import { procurementCostSource } from '../packages/contracts/src/procurementCost';

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

test('a retired supplier discount on a line is ignored: the raw price is the cost, in unit and total input alike', () => {
  assert.equal(purchaseEstimate([line({ discounted_unit_amount: 400 })], [], 1760, 0, undefined, shipping(5000))[0].purchase_iqd, 1_584_000);
  assert.equal(purchaseEstimate([line({ purchase_cost_mode: 'total', source_total_amount: 900, discounted_unit_amount: 400 })], [], 1760, 0)[0].purchase_iqd, 1_584_000);
  assert.deepEqual(procurementCostSource({ purchase_cost_mode: 'unit', source_unit_amount: 450, discounted_unit_amount: 400 }), { mode: 'unit', amount: 450, discounted: false });
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

test('an old draft with a supplier discount still saves at its raw price; an old saved line restores it; a new rate re-costs the lot', async () => {
  const w = pricingWorld();
  const body = w.draft({ lines: [{ ...w.draft().lines[0], discounted_unit_amount: 451 }] });
  const id = await w.save(body);
  const stored = w.raw.prepare(`SELECT l.source_unit_amount, l.purchase_cost_mode, i.purchase_total_iqd, l.charges_iqd
    FROM purchase_lines l JOIN incoming_inventory i ON i.id = l.incoming_id WHERE l.purchase_id = ?`).get(id) as Record<string, number | string | null>;
  assert.equal(stored.source_unit_amount, 450);
  assert.equal(stored.purchase_total_iqd, 450 * 1760 * 2);
  assert.equal(stored.charges_iqd, 25_000);
  // A line the older screen saved at its discounted price restores the raw price from the saved request.
  const doc = await json(await get(w.app, `/api/admin/procurement/documents/${id}`));
  const lines = (doc.lines as ProcurementDraftLine[]).map((l) => ({ ...l, source_unit_amount: 400 }));
  const request = JSON.stringify({ lines: [{ ...body.lines[0], source_unit_amount: 450, discounted_unit_amount: 400 }] });
  assert.equal(restoreLineDiscounts(lines, request)[0].source_unit_amount, 450);
  // The edit at a new rate and freight re-costs the stored line, and the lot is received at it.
  const edit = await put(w.app, `/api/admin/procurement/documents/${id}`, {
    ...w.draft({ exchange_rate: 1700, shipping_rate_iqd: 6000, cost_profile_version: w.profileVersion() }),
    lines: [{ ...body.lines[0], discounted_unit_amount: 400 }],
    version: doc.purchase.version,
  });
  assert.equal(edit.status, 200, JSON.stringify(await json(edit)));
  const after = w.raw.prepare('SELECT i.purchase_total_iqd, l.charges_iqd FROM purchase_lines l JOIN incoming_inventory i ON i.id = l.incoming_id WHERE l.purchase_id = ?').get(id) as { purchase_total_iqd: number; charges_iqd: number };
  assert.deepEqual({ ...after }, { purchase_total_iqd: 450 * 1700 * 2, charges_iqd: 30_000 });
  const received = await w.receive(id, `rcv_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`);
  assert.equal(received.status, 200, JSON.stringify(received.body));
  const lots = w.raw.prepare('SELECT unit_cost_iqd FROM inventory_lots').all() as Array<{ unit_cost_iqd: number }>;
  assert.ok(lots.length > 0);
  for (const lot of lots) assert.equal(lot.unit_cost_iqd, (450 * 1700 * 2 + 30_000) / 2);
  // The pricing card reads the same parser: the retired discount changes nothing.
  const full = await w.preview({ draft: w.draft() });
  const cut = await w.preview({ draft: w.draft({ lines: [{ ...w.draft().lines[0], discounted_unit_amount: 300 }] }) });
  assert.equal(cut.status, 200, JSON.stringify(cut.body));
  assert.deepEqual(cut.body.lines, full.body.lines);
});

const panel = readFileSync(join(ROOT, 'src/components/adminOperations/ProcurementPanel.tsx'), 'utf8');

test('the panel: route rates reload at the approved rate, quantity re-derives, no supplier discount field; the sale price sits in the line card', () => {
  assert.doesNotMatch(panel, /exchange_rate: profile\.exchange_rate \?\? NaN/, 'reloading route rates never brings back the old saved rate of the route');
  assert.match(panel, /exchange_rate: prefillRate\(cfg\.approved_rates \?\? \[\], profile\.currency\)/);
  assert.match(panel, /changeLineQuantity\(x, v === '' \? NaN : Number\(v\)\)/);
  assert.doesNotMatch(panel, /loc\('السعر بعد الخصم'/, 'no supplier discount input on the purchase line');
  assert.match(panel, /discounted_unit_amount: _retired/, 'a retired discount is never sent');
  assert.match(panel, /restoreLineDiscounts\(/);
  const card = readFileSync(join(ROOT, 'src/components/adminOperations/InlineProcurementPricing.tsx'), 'utf8');
  assert.match(card, /<InlineSaleDiscount /);
  const sale = readFileSync(join(ROOT, 'src/components/adminOperations/InlineSaleDiscount.tsx'), 'utf8');
  assert.match(sale, /loc\('السعر بعد الخصم \(\$\)', 'Price after discount \(\$\)', 'نرخ دوای داشکاندن \(\$\)'\)/);
  assert.match(sale, /\/api\/admin\/offers\/\$\{encodeURIComponent\(productId\)\}/, 'the same door as «تخفيض السعر»');
});
