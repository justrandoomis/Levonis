/**
 * LEVONIS PRINT CLOUD — review fixes, cluster «reports»: the owner's profit,
 * the cost of stock received without one, the customer's paged history and
 * the reconciliation's per-lot and per-printer proofs (docs/PRINT_CLOUD.md
 * §5.3, §10, §11).
 *
 *   c16  a refund of unused, prepaid value is no loss: it gives back what was
 *        never recognised as revenue;
 *   c17  stock received without a cost is cost PENDING, never a free zero —
 *        the profit report says so, the owner states the cost once, and the
 *        units already used are valued from it;
 *   c18  /me/transactions pages on a strict (time, ledger, id) cursor, so rows
 *        written by one batch at one instant are never skipped;
 *   p0   reconciliation proves every lot against its own draws and one active
 *        assignment per printer and per job, as §11 says.
 *
 * Run: node --import tsx --import ./scripts/test-no-network.mjs --test tests/printCloudFixes-reports.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN,
  API,
  buy,
  call,
  estimatedJob,
  idem,
  ok,
  pcWorld,
  reconcileClean,
  refused,
  row,
  rows,
  runToPrinting,
  seedCatalog,
  type Json,
  type World,
} from './fixtures/printCloud';

const H = 3600;
const RANGE = 'from=2000-01-01T00:00:00Z&to=2100-01-01T00:00:00Z';

const profit = (w: World) => ok(w.owner, 'GET', `${ADMIN}/reports/profit?${RANGE}`);
const failingChecks = async (w: World): Promise<string[]> =>
  (await ok(w.owner, 'GET', `${ADMIN}/reconcile`)).checks.filter((c: Json) => !c.ok && c.name !== 'payments_needing_refund').map((c: Json) => c.name).sort();

// ------------------------------------------------------------------ c16

test('c16: refunding unused prepaid hours and grams costs no profit; paying back more than the unused value, or a recognised delivery fee, does', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const first = await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h24 }, { kind: 'material', variant_id: cat.white, quantity: 500 }]);
  const before = await profit(w);
  assert.deepEqual([before.recognised_revenue, before.net_profit], [0, 0]);
  const [hours, pla] = (await ok(w.full, 'GET', `${ADMIN}/orders/${first}`)).lines;
  assert.equal((await ok(w.full, 'POST', `${ADMIN}/orders/${first}/refunds`, { line_id: hours.id, reason: 'never used' }, idem('r1'))).amount_iqd, 36000);
  assert.equal((await ok(w.full, 'POST', `${ADMIN}/orders/${first}/refunds`, { line_id: pla.id, reason: 'never used' }, idem('r2'))).amount_iqd, 14500);
  const untouched = await profit(w);
  assert.equal(untouched.recognised_revenue, 0);
  assert.equal(untouched.net_profit, 0, 'giving back value that was never revenue is no loss');
  assert.equal(untouched.refunds_recorded, 50500, 'the cash returned is still reported');
  assert.equal(untouched.refunds_of_unused_value, 50500);

  // 1 h of a 6 h lot bought for 10,500 is worth 1,750 unused; paying 3,000 back loses 1,250.
  const second = await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h6 }, { kind: 'material', variant_id: cat.white, quantity: 250 }]);
  const h6 = (await ok(w.full, 'GET', `${ADMIN}/orders/${second}`)).lines[0];
  await ok(w.full, 'POST', `${ADMIN}/orders/${second}/refunds`, { line_id: h6.id, quantity: H, amount_iqd: 3000, reason: 'goodwill' }, idem('r3'));
  // A delivery fee is revenue once paid; refunding it takes that revenue back.
  const ship = await ok(w.a, 'POST', `${API}/shipments`, {
    kind: 'delivery',
    items: [{ variant_id: cat.white, qty: 100 }],
    payment_method: 'dev',
    delivery_address: { recipient_name: 'Ali', phone: '07700000000', governorate: 'erbil', city: 'Erbil', address_line: '100m road' },
  }, idem('d'));
  await ok(w.a, 'POST', `${API}/orders/${ship.fee_order_id}/dev-pay`, {});
  const fee = (await ok(w.full, 'GET', `${ADMIN}/orders/${ship.fee_order_id}`)).lines[0];
  assert.equal(fee.kind, 'shipping_fee');
  assert.equal((await profit(w)).recognised_revenue, 5000);
  await ok(w.full, 'POST', `${ADMIN}/orders/${ship.fee_order_id}/refunds`, { line_id: fee.id, reason: 'courier never came' }, idem('r4'));

  const after = await profit(w);
  assert.equal(after.recognised_revenue, 5000);
  assert.equal(after.net_profit, 5000 - 1250 - 5000);
  assert.equal(after.refunds_recorded, 50500 + 3000 + 5000);
  assert.equal(after.refunds_of_unused_value, 50500 + 1750);
  assert.equal(after.refunds_profit_effect, (1750 - 3000) - 5000);
  const revenue = await ok(w.full, 'GET', `${ADMIN}/reports/revenue?${RANGE}`);
  assert.deepEqual([revenue.refunds_recorded, revenue.refunds_of_unused_value], [58500, 52250], 'the money report carries the same split');
  await reconcileClean(w);
});

// ------------------------------------------------------------------ c17

/** A filament the workshop has never stocked: no lot of it carries a cost yet. */
async function newFilament(w: World): Promise<string> {
  const product = await ok(w.owner, 'POST', `${ADMIN}/catalog/products`, {
    category_code: 'filaments',
    name_en: 'PLA Matte',
    name_ar: 'PLA مطفي',
    name_ckb: 'PLA ی مات',
    material: 'PLA',
    grade: 'Matte',
  });
  const variant = await ok(w.owner, 'POST', `${ADMIN}/catalog/variants`, {
    product_id: product.id,
    sku: 'PLA-MATTE-GREEN',
    name_en: 'PLA Matte Green',
    name_ar: 'PLA أخضر مطفي',
    name_ckb: 'PLA ی سەوزی مات',
    unit_code: 'g',
    min_purchase_qty: 100,
    purchase_step_qty: 10,
    max_purchase_qty: 5000,
    diameter_um: 1750,
    color_name: 'Green',
    color_hex: '#2E7D32',
  });
  await ok(w.owner, 'PUT', `${ADMIN}/variants/${variant.id}/price-tiers`, { tiers: [{ mode: 'bracket', min_qty: 100, unit_price_milli_iqd: 35000 }] });
  return variant.id as string;
}

test('c17: a lot received without a cost is cost-pending; the profit report flags its use, and the owner states the cost once to value it', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const green = await newFilament(w);
  // The operator receives the delivery; the cost is the owner's to state.
  const received = await ok(w.assistant, 'POST', `${ADMIN}/stock/receive`, { variant_id: green, qty: 1000, supplier: 'Bambu Lab' }, idem('stock'));
  const lot = (await ok(w.owner, 'GET', `${ADMIN}/stock/lots?variant_id=${green}`)).find((l: Json) => l.id === received.lot_id);
  assert.deepEqual([lot.cost_known, lot.total_cost_iqd], [0, 0], 'pending, not free');

  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h6 }, { kind: 'material', variant_id: green, quantity: 200 }]);
  const { jobId } = await estimatedJob(w, w.a, cat, { seconds: H, materials: [{ variant_id: green, model_grams: 100 }] });
  await runToPrinting(w, w.a, jobId, cat.printers[0]);
  await ok(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/complete`, { printed_seconds: H, materials: [{ variant_id: green, qty: 100 }] });
  await ok(w.assistant, 'POST', `${ADMIN}/stock/waste`, { variant_id: green, qty: 50, reason: 'tangled spool end' }, idem('stock'));

  const pending = await profit(w);
  assert.equal(pending.cost_complete, false, 'the report never presents an unknown cost as a recorded zero');
  assert.deepEqual(
    pending.cost_pending.map((p: Json) => [p.variant_id, p.entry_type, p.qty]).sort(),
    [[green, 'consume_customer', 100], [green, 'waste', 50]]
  );
  assert.deepEqual(pending.lots_cost_pending.map((l: Json) => l.lot_id), [received.lot_id]);
  assert.equal(pending.cost_of_material_used, 0);

  // Only the owner states a cost, through its own door.
  await refused(w.full, 'POST', `${ADMIN}/stock/lots/${received.lot_id}/cost`, { total_cost_iqd: 25000 }, 'COST_ACCESS_DENIED');
  await refused(w.assistant, 'POST', `${ADMIN}/stock/lots/${received.lot_id}/cost`, { total_cost_iqd: 25000 }, 'COST_ACCESS_DENIED');
  await refused(w.owner, 'POST', `${ADMIN}/stock/lots/pcsl_none/cost`, { total_cost_iqd: 25000 }, 'NOT_FOUND');
  const stated = await ok(w.owner, 'POST', `${ADMIN}/stock/lots/${received.lot_id}/cost`, { total_cost_iqd: 25000 });
  assert.deepEqual([stated.total_cost_iqd, stated.unit_cost_milli_iqd, stated.cost_known], [25000, 25000, true]);
  await refused(w.owner, 'POST', `${ADMIN}/stock/lots/${received.lot_id}/cost`, { total_cost_iqd: 1 }, 'INVALID_TRANSITION');
  const audit = row<{ detail: string }>(w, "SELECT detail FROM audit_log WHERE action = 'print_cloud.stock.lot_cost'");
  assert.ok(audit && !audit.detail.includes('25000'), 'the audit trail full admins read names the act, never the cost');

  // The 150 g already gone are valued from the stated cost, in the period they left: 100 g → 2,500, 50 g → 1,250.
  const valued = await profit(w);
  assert.equal(valued.cost_complete, true);
  assert.deepEqual(valued.cost_pending, []);
  assert.equal(valued.cost_of_material_used, 2500);
  assert.equal(valued.operating_costs.material_waste_and_workshop_use, 1250);
  assert.equal(valued.material_cost_stated_after_use, 3750);
  assert.equal(valued.gross_profit, valued.recognised_revenue - 2500);

  // Later use is valued as it happens, continuing the lot: the next 50 g cost 1,250.
  await ok(w.assistant, 'POST', `${ADMIN}/stock/waste`, { variant_id: green, qty: 50, reason: 'calibration' }, idem('stock'));
  assert.equal((await profit(w)).operating_costs.material_waste_and_workshop_use, 2500);

  // A count that finds more than the books is an adjustment lot of unknown cost too.
  await ok(w.assistant, 'POST', `${ADMIN}/stock/adjust`, { variant_id: green, qty_delta: 5, reason: 'found a sample' }, idem('stock'));
  const adjustment = rows<{ cost_known: number }>(w, "SELECT cost_known FROM pc_stock_lots WHERE variant_id = ? AND lot_code = 'ADJUSTMENT'", green);
  assert.deepEqual(adjustment.map((l) => l.cost_known), [0]);
  await reconcileClean(w);
});

test('c17: a print settled while the owner states the lot cost is valued from that cost, never recorded as a known zero', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const green = await newFilament(w);
  const received = await ok(w.assistant, 'POST', `${ADMIN}/stock/receive`, { variant_id: green, qty: 1000 }, idem('stock'));
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h6 }, { kind: 'material', variant_id: green, quantity: 200 }]);
  const { jobId } = await estimatedJob(w, w.a, cat, { seconds: H, materials: [{ variant_id: green, model_grams: 100 }] });
  await runToPrinting(w, w.a, jobId, cat.printers[0]);
  // The completion planned against a pending lot; the owner's cost lands just before its batch.
  w.race.when = (sqls) => sqls.some((s) => s.includes('INSERT INTO pc_stock_lot_draws'));
  w.race.hook = async () => {
    await ok(w.owner, 'POST', `${ADMIN}/stock/lots/${received.lot_id}/cost`, { total_cost_iqd: 25000 });
  };
  await ok(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/complete`, { printed_seconds: H, materials: [{ variant_id: green, qty: 100 }] });
  assert.equal(w.race.hook, null, 'the race ran');
  const report = await profit(w);
  assert.equal(report.cost_complete, true);
  assert.equal(report.cost_of_material_used, 2500);
  await reconcileClean(w);
});

// ------------------------------------------------------------------ c18

test('c18: /me/transactions pages through rows that share one instant without losing any', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  // One payment batch writes the credit and the inventory purchase at the same instant.
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h6 }, { kind: 'material', variant_id: cat.white, quantity: 250 }]);
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h24 }, { kind: 'material', variant_id: cat.black, quantity: 250 }, { kind: 'material', variant_id: cat.red, quantity: 100 }]);
  const all: Json[] = (await ok(w.a, 'GET', `${API}/me/transactions?limit=200`)).items;
  assert.equal(all.length, 7);
  assert.ok(new Set(all.map((t) => t.created_at)).size < all.length, 'some rows share their instant');
  for (const size of [1, 2, 3]) {
    const paged: Json[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 20; i++) {
      const page: Json = await ok(w.a, 'GET', `${API}/me/transactions?limit=${size}${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`);
      paged.push(...page.items);
      cursor = page.next_before;
      if (!cursor) break;
    }
    assert.deepEqual(paged, all, `pages of ${size}`);
  }
  // A bare timestamp still means «strictly before»: the clients that sent one keep their answer.
  const newest = all[0].created_at as string;
  const older: Json[] = (await ok(w.a, 'GET', `${API}/me/transactions?limit=200&before=${encodeURIComponent(newest)}`)).items;
  assert.deepEqual(older, all.filter((t) => t.created_at < newest));
  assert.equal((await call(w.b, 'GET', `${API}/me/transactions?limit=200`)).json.data.items.length, 0, 'only the caller own rows');
});

// ------------------------------------------------------------------ p0

test('p0: reconciliation proves every credit, inventory and stock lot against its own draws, not only their totals', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  // Two lots of each kind in one account, the older one partly drawn by a print.
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h6 }, { kind: 'material', variant_id: cat.white, quantity: 250 }]);
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h6 }, { kind: 'material', variant_id: cat.white, quantity: 250 }]);
  await ok(w.owner, 'POST', `${ADMIN}/stock/receive`, { variant_id: cat.white, qty: 1000, total_cost_iqd: 20000 }, idem('stock'));
  const { jobId } = await estimatedJob(w, w.a, cat, { seconds: H, materials: [{ variant_id: cat.white, model_grams: 100 }] });
  await runToPrinting(w, w.a, jobId, cat.printers[0]);
  await ok(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/complete`, { printed_seconds: H, materials: [{ variant_id: cat.white, qty: 100 }] });
  await reconcileClean(w);
  const two = <T>(sql: string) => rows<T & { id: string }>(w, sql);

  // Remainders moved between two lots: every total still agrees, only the lots' own draws tell.
  const [c1, c2] = two('SELECT id FROM pc_credit_lots ORDER BY created_at, id');
  w.raw.prepare('UPDATE pc_credit_lots SET seconds_remaining = seconds_remaining + 600 WHERE id = ?').run(c1.id);
  w.raw.prepare('UPDATE pc_credit_lots SET seconds_remaining = seconds_remaining - 600 WHERE id = ?').run(c2.id);
  const [i1, i2] = two('SELECT id FROM pc_inventory_lots ORDER BY created_at, id');
  w.raw.prepare('UPDATE pc_inventory_lots SET qty_remaining = qty_remaining + 50 WHERE id = ?').run(i1.id);
  w.raw.prepare('UPDATE pc_inventory_lots SET qty_remaining = qty_remaining - 50 WHERE id = ?').run(i2.id);
  const [s1, s2] = two(`SELECT id FROM pc_stock_lots WHERE variant_id = '${cat.white}' ORDER BY received_at, id`);
  w.raw.prepare('UPDATE pc_stock_lots SET on_hand_qty = on_hand_qty + 40 WHERE id = ?').run(s1.id);
  w.raw.prepare('UPDATE pc_stock_lots SET on_hand_qty = on_hand_qty - 40 WHERE id = ?').run(s2.id);
  assert.deepEqual(await failingChecks(w), ['credit_lots_equal_their_draws', 'inventory_lots_equal_their_draws', 'stock_lots_equal_their_draws']);
  const report = await ok(w.owner, 'GET', `${ADMIN}/reconcile`);
  const credit = report.checks.find((c: Json) => c.name === 'credit_lots_equal_their_draws');
  assert.deepEqual(credit.issues.map((x: Json) => x.lot_id).sort(), [c1.id, c2.id].sort());
});

test('p0: a lot whose draws are valued beyond what was paid for it is reported', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h6 }, { kind: 'material', variant_id: cat.white, quantity: 250 }]);
  const { jobId } = await estimatedJob(w, w.a, cat, { seconds: H, materials: [{ variant_id: cat.white, model_grams: 100 }] });
  await runToPrinting(w, w.a, jobId, cat.printers[0]);
  await ok(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/complete`, { printed_seconds: H, materials: [{ variant_id: cat.white, qty: 100 }] });
  await reconcileClean(w);
  // What a lot was bought for changes after its seconds and grams were valued.
  w.raw.exec('UPDATE pc_credit_lots SET paid_iqd = paid_iqd + 6000');
  w.raw.exec('UPDATE pc_inventory_lots SET paid_iqd = paid_iqd + 4000');
  assert.deepEqual(await failingChecks(w), ['credit_lots_equal_their_draws', 'inventory_lots_equal_their_draws']);
});

test('p0: reconciliation proves one active assignment per printer and per job, and only for jobs on the floor', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h24 }, { kind: 'material', variant_id: cat.white, quantity: 500 }]);
  const first = await estimatedJob(w, w.a, cat, { seconds: H, materials: [{ variant_id: cat.white, model_grams: 50 }], title: 'First' });
  await runToPrinting(w, w.a, first.jobId, cat.printers[0]);
  const second = await estimatedJob(w, w.a, cat, { seconds: H, materials: [{ variant_id: cat.white, model_grams: 50 }], title: 'Second' });
  await ok(w.a, 'POST', `${API}/jobs/${second.jobId}/review`);
  const confirmed = await ok(w.a, 'POST', `${API}/jobs/${second.jobId}/confirm`, undefined, idem('c2'));
  if (confirmed.status === 'confirmed') await ok(w.assistant, 'POST', `${ADMIN}/jobs/${second.jobId}/approve`);
  await reconcileClean(w);

  // The partial unique indexes refuse a second active assignment; reconciliation proves it independently.
  w.raw.exec('DROP INDEX uq_pc_printer_assignments_printer');
  w.raw
    .prepare("INSERT INTO pc_printer_assignments (id, job_id, printer_id, state, assigned_by, assigned_at) VALUES ('pcpa_forged', ?, ?, 'active', 'x', '2026-01-01T00:00:00.000Z')")
    .run(second.jobId, cat.printers[0]);
  assert.deepEqual(await failingChecks(w), ['active_assignments_match_jobs_on_the_floor', 'one_active_assignment_per_printer_and_job']);
  const report = await ok(w.owner, 'GET', `${ADMIN}/reconcile`);
  const dup = report.checks.find((c: Json) => c.name === 'one_active_assignment_per_printer_and_job');
  assert.deepEqual(dup.issues, [{ kind: 'printer', ref_id: cat.printers[0], active: 2 }]);
  const floor = report.checks.find((c: Json) => c.name === 'active_assignments_match_jobs_on_the_floor');
  assert.deepEqual(floor.issues.map((x: Json) => [x.kind, x.job_id]), [['assignment_without_job_on_the_floor', second.jobId]]);

  // A job printing with no machine held is reported too.
  w.raw.prepare("UPDATE pc_printer_assignments SET state = 'released' WHERE job_id = ?").run(first.jobId);
  w.raw.prepare("UPDATE pc_printer_assignments SET state = 'released' WHERE id = 'pcpa_forged'").run();
  const lost = (await ok(w.owner, 'GET', `${ADMIN}/reconcile`)).checks.find((c: Json) => c.name === 'active_assignments_match_jobs_on_the_floor');
  assert.deepEqual(lost.issues.map((x: Json) => [x.kind, x.job_id]), [['job_on_the_floor_without_assignment', first.jobId]]);
});
