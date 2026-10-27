/**
 * LEVONIS PRINT CLOUD — the scenarios of the brief's §36, each against the
 * REAL routers over every migration (tests/fixtures/printCloud.ts): money in
 * integer dinars, time in integer seconds, every balance read back through
 * the API AND proved against its ledger by the reconciliation report.
 *
 * Run: node --import tsx --test tests/printCloudScenarios.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN,
  API,
  AGENT,
  buy,
  call,
  credits,
  estimatedJob,
  idem,
  ok,
  owned,
  pcWorld,
  reconcileClean,
  refused,
  row,
  rows,
  runToPrinting,
  seedCatalog,
} from './fixtures/printCloud';
import { signGatewayPayload } from '../worker/lib/printCloud/payments';

const H = 3600;

test('printing credits: 24 h bought, 8.9 h reserved, 8.5 h used → 15.5 h left and the 0.4 h reservation released', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h24 }]);
  assert.deepEqual(await credits(w.a, cat.tier).then((c) => [c.available_seconds, c.reserved_seconds]), [24 * H, 0]);

  const reserved = Math.round(8.9 * H); // 32,040 s
  const used = Math.round(8.5 * H); // 30,600 s
  await buy(w.a, [{ kind: 'material', variant_id: cat.white, quantity: 250 }]);
  const { jobId } = await estimatedJob(w, w.a, cat, { seconds: reserved, materials: [{ variant_id: cat.white, model_grams: 110 }] });
  await runToPrinting(w, w.a, jobId);
  const during = await credits(w.a, cat.tier);
  assert.equal(during.available_seconds, 24 * H - reserved);
  assert.equal(during.reserved_seconds, reserved);

  // Waiting in the queue and preparing consumed nothing: only completion bills.
  const done = await ok(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/complete`, { printed_seconds: used, materials: [{ variant_id: cat.white, qty: 110 }] });
  assert.equal(done.billed_seconds, used);
  const after = await credits(w.a, cat.tier);
  assert.equal(after.available_seconds, 15.5 * H);
  assert.equal(after.reserved_seconds, 0);
  assert.equal(after.consumed_seconds, used);
  assert.deepEqual(after.available, { hours: 15, minutes: 30, seconds: 15.5 * H });

  const res = row(w, 'SELECT seconds_reserved, seconds_consumed, seconds_released, state FROM pc_credit_reservations WHERE job_id = ?', jobId);
  assert.deepEqual(res, { seconds_reserved: reserved, seconds_consumed: used, seconds_released: reserved - used, state: 'settled' });
  const ledger = rows(w, "SELECT entry_type, delta_available, delta_reserved, delta_consumed FROM pc_credit_ledger WHERE user_id = 'usr_pc_a' ORDER BY rowid");
  assert.deepEqual(
    ledger.map((l) => l.entry_type),
    ['purchase', 'reserve', 'consume', 'release']
  );
  // The consumed seconds are valued at what they were bought for: 30,600 of 86,400 s of a 36,000 IQD package.
  const consume = row(w, "SELECT value_iqd FROM pc_credit_ledger WHERE entry_type = 'consume' AND job_id = ?", jobId);
  assert.equal(consume?.value_iqd, Math.round((36000 * used) / (24 * H)));
  await reconcileClean(w);
});

test('filament top-up: 490 g owned + 250 g bought = 740 g, and «top up to 1 kg» prices the missing 510 g as a new purchase', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  await buy(w.a, [{ kind: 'material', variant_id: cat.white, quantity: 490 }]);
  assert.equal((await owned(w.a, cat.white)).available_qty, 490);
  await buy(w.a, [{ kind: 'material', variant_id: cat.white, quantity: 250 }]);
  const after = await owned(w.a, cat.white);
  assert.equal(after.available_qty, 740);
  assert.equal(after.unit_code, 'g');
  // Two lots, two prices: 490 g by the ≥250 g bracket (32 IQD/g → 15,680 → 15,750) is CAPPED at the
  // 500 g pack (14,500) — never more for less; 250 g at its pack price.
  const lots = rows(w, "SELECT qty_total, paid_iqd FROM pc_inventory_lots WHERE user_id = 'usr_pc_a' ORDER BY rowid");
  assert.deepEqual(lots, [{ qty_total: 490, paid_iqd: 14500 }, { qty_total: 250, paid_iqd: 8000 }]);

  const w2 = pcWorld();
  const cat2 = await seedCatalog(w2);
  await buy(w2.a, [{ kind: 'material', variant_id: cat2.white, quantity: 490 }]);
  const topUp = await ok(w2.a, 'POST', `${API}/me/inventory/top-up-quote`, { variant_id: cat2.white, target_qty: 1000 });
  assert.equal(topUp.owned_qty, 490);
  assert.equal(topUp.quantity, 510);
  assert.equal(topUp.balance_after_qty, 1000);
  // 510 g is priced on ITS OWN quantity (≥500 g bracket, 29 IQD/g = 14,790 → 15,000), never on 490 + 510 = 1 kg.
  assert.equal(topUp.quote.lines[0].base_price_iqd, 15000);
  assert.equal(topUp.quote.lines[0].breakdown.rule.type, 'bracket');
  await reconcileClean(w);
});

test('gram pricing: exact packs at pack price, custom quantities by bracket, never above the next pack', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const price = async (quantity: number, unit?: string) =>
    (await ok(w.guest, 'POST', `${API}/pricing/quote`, { lines: [{ kind: 'material', variant_id: cat.white, quantity, ...(unit ? { unit } : {}) }] })).lines[0];
  assert.equal((await price(100)).final_price_iqd, 3500);
  assert.equal((await price(250)).final_price_iqd, 8000);
  assert.equal((await price(500)).final_price_iqd, 14500);
  assert.equal((await price(1000)).final_price_iqd, 24250);
  assert.equal((await price(1, 'kg')).final_price_iqd, 24250, 'kg converts to the variant base unit');
  // 370 g: ≥250 bracket 32 IQD/g = 11,840 → 12,000 (rounded up to 250).
  assert.equal((await price(370)).final_price_iqd, 12000);
  // 950 g: ≥500 bracket = 27,550 → 27,750, capped at the 1 kg pack (24,250).
  const p950 = await price(950);
  assert.equal(p950.final_price_iqd, 24250);
  assert.equal(p950.breakdown.capped_by_pack_qty, 1000);
  // 1,500 g: ≥1,000 bracket at 24.25 IQD/g = 36,375 → 36,500.
  assert.equal((await price(1500)).final_price_iqd, 36500);
  // The full kilo is better value per gram than 100 g.
  assert.ok((await price(1000)).breakdown.effective_unit_price_milli_iqd < (await price(100)).breakdown.effective_unit_price_milli_iqd);
  await refused(w.guest, 'POST', `${API}/pricing/quote`, { lines: [{ kind: 'material', variant_id: cat.white, quantity: 105 }] }, 'QUANTITY_NOT_ALLOWED');
  await refused(w.guest, 'POST', `${API}/pricing/quote`, { lines: [{ kind: 'material', variant_id: cat.white, quantity: 2, unit: 'pc' }] }, 'VALIDATION');
  await refused(w.guest, 'POST', `${API}/pricing/quote`, { lines: [{ kind: 'material', variant_id: cat.white, quantity: 100.5 }] }, 'VALIDATION');
  // Credit packages and custom hours.
  const h = await ok(w.guest, 'POST', `${API}/pricing/quote`, {
    lines: [
      { kind: 'credit_package', package_id: cat.packages.h24 },
      { kind: 'credit_hours', tier_id: cat.tier, seconds: 10 * H },
    ],
  });
  assert.deepEqual(h.lines.map((l: Record<string, number>) => [l.seconds, l.final_price_iqd]), [[24 * H, 36000], [10 * H, 15000]]);
  assert.equal(h.total_iqd, 51000);
});

test('multiple materials: two colours are reserved and settled independently', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  await buy(w.a, [
    { kind: 'credit_package', package_id: cat.packages.h6 },
    { kind: 'material', variant_id: cat.white, quantity: 500 },
    { kind: 'material', variant_id: cat.black, quantity: 250 },
    { kind: 'material', variant_id: cat.red, quantity: 100 },
  ]);
  const { jobId } = await estimatedJob(w, w.a, cat, {
    seconds: 3 * H,
    materials: [
      { variant_id: cat.white, model_grams: 80, purge_grams: 6 },
      { variant_id: cat.black, model_grams: 20, purge_grams: 4 },
    ],
  });
  await runToPrinting(w, w.a, jobId);
  const res = rows(w, "SELECT variant_id, qty_reserved, state FROM pc_inventory_reservations WHERE ref_id = ? ORDER BY variant_id", jobId);
  assert.deepEqual(
    res.map((r) => [r.variant_id, r.qty_reserved, r.state]).sort(),
    [[cat.black, 24, 'active'], [cat.white, 86, 'active']].sort()
  );
  assert.deepEqual([(await owned(w.a, cat.white)).available_qty, (await owned(w.a, cat.black)).available_qty], [500 - 86, 250 - 24]);
  await ok(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/complete`, {
    printed_seconds: 3 * H - 120,
    materials: [
      { variant_id: cat.white, qty: 84 },
      { variant_id: cat.black, qty: 24 },
    ],
  });
  assert.deepEqual(
    [(await owned(w.a, cat.white)).available_qty, (await owned(w.a, cat.black)).available_qty, (await owned(w.a, cat.red)).available_qty],
    [500 - 84, 250 - 24, 100],
    'each colour charged its own actual grams; the unused red is untouched'
  );
  // The shelf lost exactly what the customer used, per colour.
  const shelf = rows(w, "SELECT variant_id, -delta_on_hand AS g FROM pc_warehouse_ledger WHERE entry_type = 'consume_customer' AND ref_id = ? ORDER BY variant_id", jobId);
  assert.deepEqual(shelf.map((s) => [s.variant_id, s.g]).sort(), [[cat.black, 24], [cat.white, 84]].sort());
  await reconcileClean(w);
});

test('accessory consumption: 20 magnets owned, a job uses 2 → 18 left', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  await buy(w.a, [
    { kind: 'credit_package', package_id: cat.packages.h6 },
    { kind: 'material', variant_id: cat.white, quantity: 250 },
    { kind: 'material', variant_id: cat.magnets, quantity: 20 },
  ]);
  assert.equal((await owned(w.a, cat.magnets)).unit_code, 'pc');
  const { jobId } = await estimatedJob(w, w.a, cat, {
    seconds: 2 * H,
    materials: [{ variant_id: cat.white, model_grams: 40 }],
    accessories: [{ variant_id: cat.magnets, qty: 2 }],
    projectType: 'magnetic',
  });
  await runToPrinting(w, w.a, jobId);
  assert.equal((await owned(w.a, cat.magnets)).reserved_qty, 2);
  // The operator verifies: filament as reported; the magnets, not listed, were used exactly as reserved.
  await ok(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/complete`, { printed_seconds: 2 * H, materials: [{ variant_id: cat.white, qty: 40 }] });
  const magnets = await owned(w.a, cat.magnets);
  assert.deepEqual([magnets.available_qty, magnets.reserved_qty, magnets.consumed_qty], [18, 0, 2]);
  await reconcileClean(w);
});

test('print queue: two jobs never run on the same printer at once — scheduler, operator and the database all refuse', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w, { secondPrinter: false });
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h24 }, { kind: 'material', variant_id: cat.white, quantity: 500 }]);
  await buy(w.b, [{ kind: 'credit_package', package_id: cat.packages.h24 }, { kind: 'material', variant_id: cat.white, quantity: 500 }]);
  const j1 = (await estimatedJob(w, w.a, cat, { seconds: 2 * H, materials: [{ variant_id: cat.white, model_grams: 50 }], title: 'Keychain' })).jobId;
  const j2 = (await estimatedJob(w, w.b, cat, { seconds: 2 * H, materials: [{ variant_id: cat.white, model_grams: 50 }], title: 'Box' })).jobId;
  for (const [app, id] of [[w.a, j1], [w.b, j2]] as const) {
    await ok(app, 'POST', `${API}/jobs/${id}/review`);
    await ok(app, 'POST', `${API}/jobs/${id}/confirm`, undefined, idem('c'));
    await ok(w.assistant, 'POST', `${ADMIN}/jobs/${id}/approve`);
  }
  const run = await ok(w.assistant, 'POST', `${ADMIN}/queue/run`);
  assert.equal(run.assigned.length, 1, 'one machine, one job');
  assert.equal(run.waiting, 1);
  const [onMachine, waiting] = run.assigned[0].job_id === j1 ? [j1, j2] : [j2, j1];
  await refused(w.assistant, 'POST', `${ADMIN}/jobs/${waiting}/assign`, { printer_id: cat.printers[0] }, 'PRINTER_BUSY');
  // Even a write that skipped every check is stopped by the partial unique index.
  assert.throws(() =>
    w.raw.exec(`INSERT INTO pc_printer_assignments (id, job_id, printer_id, state, assigned_by, assigned_at) VALUES ('x', '${waiting}', '${cat.printers[0]}', 'active', 'x', 'x')`)
  , /UNIQUE constraint failed/);
  // Estimated start of the waiting job: after the running one.
  const q = await ok(w.assistant, 'GET', `${ADMIN}/queue`);
  const est = q.find((e: Record<string, string>) => e.job_id === waiting);
  assert.equal(est.basis, 'simulated');
  assert.ok(Date.parse(est.estimated_start_at) >= Date.now() + 2 * H * 1000 - 5000);
  // Machine freed → the waiting job goes on.
  await ok(w.assistant, 'POST', `${ADMIN}/jobs/${onMachine}/start`);
  await ok(w.assistant, 'POST', `${ADMIN}/jobs/${onMachine}/complete`, { printed_seconds: 2 * H, materials: [] });
  const run2 = await ok(w.assistant, 'POST', `${ADMIN}/queue/run`);
  assert.deepEqual(run2.assigned, [{ job_id: waiting, printer_id: cat.printers[0] }]);
  // A machine in a maintenance window is never given work.
  await ok(w.owner, 'PATCH', `${ADMIN}/catalog/printers/${cat.printers[0]}`, { status: 'maintenance' });
  const verdicts = await ok(w.assistant, 'GET', `${ADMIN}/printers`);
  assert.equal(verdicts[0].status, 'maintenance');
  await reconcileClean(w);
});

test('concurrent purchase of the same last 100 g: one order holds it, the other is refused OUT_OF_STOCK — never oversold', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const qa = await ok(w.a, 'POST', `${API}/quotes`, { lines: [{ kind: 'material', variant_id: cat.gold, quantity: 100 }] });
  const qb = await ok(w.b, 'POST', `${API}/quotes`, { lines: [{ kind: 'material', variant_id: cat.gold, quantity: 100 }] });
  assert.ok(qa.orderable && qb.orderable, 'both quotes saw the 100 g available — a quote reserves nothing');
  // B's whole order completes in the instant before A's order batch commits.
  w.race.when = (sqls) => sqls.some((s) => s.includes('INSERT INTO pc_orders'));
  let bOrder: string | null = null;
  w.race.hook = async () => {
    const r = await ok(w.b, 'POST', `${API}/orders`, { quote_id: qb.quote_id, payment_method: 'dev' }, idem('b'));
    bOrder = r.order_id;
  };
  await refused(w.a, 'POST', `${API}/orders`, { quote_id: qa.quote_id, payment_method: 'dev' }, 'OUT_OF_STOCK', idem('a'));
  assert.ok(bOrder);
  const pos = row(w, 'SELECT on_hand_qty, reserved_qty, allocated_qty FROM pc_stock_positions WHERE variant_id = ?', cat.gold);
  assert.deepEqual(pos, { on_hand_qty: 100, reserved_qty: 100, allocated_qty: 0 });
  await ok(w.b, 'POST', `${API}/orders/${bOrder}/dev-pay`, {});
  assert.deepEqual(row(w, 'SELECT on_hand_qty, reserved_qty, allocated_qty FROM pc_stock_positions WHERE variant_id = ?', cat.gold), { on_hand_qty: 100, reserved_qty: 0, allocated_qty: 100 });
  // A's quote is still open (its order never existed): a retry is refused for stock, not for the quote.
  await refused(w.a, 'POST', `${API}/orders`, { quote_id: qa.quote_id, payment_method: 'dev' }, 'OUT_OF_STOCK', idem('a2'));
  await reconcileClean(w);
});

test('duplicate payment confirmation: the same webhook twice, and a second event for a paid order, grant once', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const quote = await ok(w.a, 'POST', `${API}/quotes`, {
    lines: [
      { kind: 'credit_package', package_id: cat.packages.h24 },
      { kind: 'material', variant_id: cat.white, quantity: 250 },
      { kind: 'material', variant_id: cat.magnets, quantity: 10 },
    ],
  });
  const order = await ok(w.a, 'POST', `${API}/orders`, { quote_id: quote.quote_id, payment_method: 'gateway' }, idem('o'));
  const secret = String(w.env.PRINT_CLOUD_PAYMENT_WEBHOOK_SECRET);
  const deliver = async (eventId: string, amount = order.total_iqd) => {
    const body = JSON.stringify({ event_id: eventId, order_id: order.order_id, amount_iqd: amount, status: 'succeeded' });
    const sig = await signGatewayPayload(secret, body, Math.floor(Date.now() / 1000));
    const res = await w.guest.request(`${API}/payments/webhook`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'X-PrintCloud-Signature': sig } });
    return { status: res.status, json: (await res.json()) as Record<string, Record<string, string>> };
  };
  const first = await deliver('evt_1');
  assert.equal(first.json.data.outcome, 'applied');
  assert.equal((await deliver('evt_1')).json.data.outcome, 'duplicate_event');
  assert.equal((await deliver('evt_2')).json.data.outcome, 'duplicate_order');
  // A forged signature is refused before anything is read.
  const forged = await w.guest.request(`${API}/payments/webhook`, {
    method: 'POST',
    body: JSON.stringify({ event_id: 'evt_3', order_id: order.order_id, amount_iqd: order.total_iqd, status: 'succeeded' }),
    headers: { 'content-type': 'application/json', 'X-PrintCloud-Signature': `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}` },
  });
  assert.equal(forged.status, 401);
  assert.equal((await credits(w.a, cat.tier)).available_seconds, 24 * H);
  assert.equal((await owned(w.a, cat.white)).available_qty, 250);
  assert.equal((await owned(w.a, cat.magnets)).available_qty, 10);
  assert.equal(row(w, "SELECT COUNT(*) AS n FROM pc_payments WHERE order_id = ? AND status = 'confirmed'", order.order_id)?.n, 1);
  assert.equal(row(w, "SELECT COUNT(*) AS n FROM pc_credit_lots WHERE user_id = 'usr_pc_a'")?.n, 1);
  // The manual adapter goes through the same door: a third confirmation is recorded, grants nothing.
  const manual = await ok(w.full, 'POST', `${ADMIN}/orders/${order.order_id}/confirm-payment`, { reference: 'CASH-1', amount_iqd: order.total_iqd });
  assert.equal(manual.outcome, 'duplicate_order');
  const events = rows(w, 'SELECT provider_event_id, outcome FROM pc_payment_events ORDER BY received_at, id');
  assert.deepEqual(events.map((e) => e.outcome), ['applied', 'duplicate_order', 'duplicate_order']);
  await reconcileClean(w);
});

test('cancellation: a queued job releases its hours and materials exactly once', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  await buy(w.a, [
    { kind: 'credit_package', package_id: cat.packages.h24 },
    { kind: 'material', variant_id: cat.white, quantity: 250 },
    { kind: 'material', variant_id: cat.rings, quantity: 5 },
  ]);
  const { jobId } = await estimatedJob(w, w.a, cat, { seconds: 4 * H, materials: [{ variant_id: cat.white, model_grams: 60 }], accessories: [{ variant_id: cat.rings, qty: 1 }] });
  await ok(w.a, 'POST', `${API}/jobs/${jobId}/review`);
  await ok(w.a, 'POST', `${API}/jobs/${jobId}/confirm`, undefined, idem('c'));
  await ok(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/approve`);
  assert.equal((await credits(w.a, cat.tier)).available_seconds, 20 * H);
  await ok(w.a, 'POST', `${API}/jobs/${jobId}/cancel`, { reason: 'changed my mind' });
  await refused(w.a, 'POST', `${API}/jobs/${jobId}/cancel`, {}, 'INVALID_TRANSITION');
  const c = await credits(w.a, cat.tier);
  assert.deepEqual([c.available_seconds, c.reserved_seconds, c.consumed_seconds], [24 * H, 0, 0]);
  assert.deepEqual([(await owned(w.a, cat.white)).available_qty, (await owned(w.a, cat.rings)).available_qty], [250, 5]);
  assert.equal(row(w, "SELECT COUNT(*) AS n FROM pc_credit_ledger WHERE entry_type = 'release' AND job_id = ?", jobId)?.n, 1);
  assert.equal(row(w, "SELECT state FROM pc_queue_entries WHERE job_id = ?", jobId)?.state, 'removed');
  // A cancelled job never comes back to the queue.
  await refused(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/assign`, { printer_id: cat.printers[0] }, 'INVALID_TRANSITION');
  await reconcileClean(w);
});

test('printer failure: a verified workshop failure costs the customer nothing, and the free reprint queues itself', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h24 }, { kind: 'material', variant_id: cat.white, quantity: 500 }]);
  const { jobId } = await estimatedJob(w, w.a, cat, { seconds: 5 * H, materials: [{ variant_id: cat.white, model_grams: 120 }] });
  await runToPrinting(w, w.a, jobId);
  const shelfBefore = row(w, 'SELECT on_hand_qty, allocated_qty FROM pc_stock_positions WHERE variant_id = ?', cat.white);
  const fail = await ok(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/fail`, {
    reason_code: 'NOZZLE_CLOG',
    responsible: 'workshop',
    description: 'hotend clogged at layer 210',
    printed_seconds: 2 * H,
    failed_materials: [{ variant_id: cat.white, qty: 55 }],
  });
  const resolved = await ok(w.assistant, 'POST', `${ADMIN}/failures/${fail.failure_id}/resolve`, { responsible: 'workshop', reprint: true });
  assert.equal(resolved.policy, 'no_charge');
  assert.equal(resolved.billed_seconds, 0);
  assert.equal(resolved.reprint_status, 'queued', 'the free reprint was confirmed on the customer behalf from the released balance');
  // The failed attempt cost nothing; the reprint reserved the same estimate again.
  const c = await credits(w.a, cat.tier);
  assert.deepEqual([c.consumed_seconds, c.available_seconds, c.reserved_seconds], [0, 19 * H, 5 * H]);
  const white = await owned(w.a, cat.white);
  assert.deepEqual([white.consumed_qty, white.available_qty, white.reserved_qty], [0, 380, 120]);
  // The 55 g the failed print really used came off the WORKSHOP's own stock, not the customer's allocation.
  const shelfAfter = row(w, 'SELECT on_hand_qty, allocated_qty FROM pc_stock_positions WHERE variant_id = ?', cat.white);
  assert.deepEqual(shelfAfter, { on_hand_qty: Number(shelfBefore?.on_hand_qty) - 55, allocated_qty: shelfBefore?.allocated_qty });
  assert.equal(row(w, "SELECT -delta_on_hand AS g FROM pc_warehouse_ledger WHERE entry_type = 'consume_workshop' AND ref_id = ?", jobId)?.g, 55);
  // Resolving again changes nothing.
  await refused(w.assistant, 'POST', `${ADMIN}/failures/${fail.failure_id}/resolve`, { responsible: 'workshop' }, 'INVALID_TRANSITION');
  assert.equal(row(w, 'SELECT status FROM pc_print_jobs WHERE id = ?', jobId)?.status, 'reprint_requested');
  await reconcileClean(w);
});

test('customer-caused failure: printed seconds and failed grams are billed under the policy, never beyond the reservation', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h24 }, { kind: 'material', variant_id: cat.white, quantity: 500 }]);
  const { jobId } = await estimatedJob(w, w.a, cat, { seconds: 5 * H, materials: [{ variant_id: cat.white, model_grams: 120 }] });
  await runToPrinting(w, w.a, jobId);
  const fail = await ok(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/fail`, { reason_code: 'UNSUPPORTED_OVERHANG', responsible: 'model', printed_seconds: 7 * H, failed_materials: [{ variant_id: cat.white, qty: 40 }] });
  const r = await ok(w.assistant, 'POST', `${ADMIN}/failures/${fail.failure_id}/resolve`, { responsible: 'model', reprint: false });
  assert.equal(r.policy, 'charge_printed');
  assert.equal(r.billed_seconds, 5 * H, 'capped at the 5 h the customer approved');
  const c = await credits(w.a, cat.tier);
  assert.deepEqual([c.consumed_seconds, c.available_seconds, c.reserved_seconds], [5 * H, 19 * H, 0]);
  const white = await owned(w.a, cat.white);
  assert.deepEqual([white.consumed_qty, white.available_qty, white.reserved_qty], [40, 460, 0]);
  // An assistant may not state billable amounts by hand (a money decision).
  const { jobId: j2 } = await estimatedJob(w, w.a, cat, { seconds: H, materials: [{ variant_id: cat.white, model_grams: 10 }] });
  await runToPrinting(w, w.a, j2);
  const f2 = await ok(w.assistant, 'POST', `${ADMIN}/jobs/${j2}/fail`, { reason_code: 'POWER', responsible: 'undetermined', printed_seconds: 600 });
  await refused(w.assistant, 'POST', `${ADMIN}/failures/${f2.failure_id}/resolve`, { responsible: 'undetermined', billable_seconds: 300 }, 'FORBIDDEN');
  await ok(w.full, 'POST', `${ADMIN}/failures/${f2.failure_id}/resolve`, { responsible: 'undetermined', billable_seconds: 300 });
  assert.equal((await credits(w.a, cat.tier)).consumed_seconds, 5 * H + 300);
  await reconcileClean(w);
});

test('buyback: 500 g left of a 1 kg lot bought for 24,250 IQD at 50 % pays 6,063 IQD, from the purchase lot', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  await ok(w.full, 'PATCH', `${ADMIN}/categories/filaments/buyback`, { buyback_enabled: true, buyback_rate_bps: 5000 });
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h24 }, { kind: 'material', variant_id: cat.white, quantity: 1000 }]);
  const { jobId } = await estimatedJob(w, w.a, cat, { seconds: H, materials: [{ variant_id: cat.white, model_grams: 500 }] });
  await runToPrinting(w, w.a, jobId);
  await ok(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/complete`, { printed_seconds: H, materials: [{ variant_id: cat.white, qty: 500 }] });
  assert.equal((await owned(w.a, cat.white)).available_qty, 500);
  const quote = await ok(w.a, 'POST', `${API}/buybacks/quote`, { variant_id: cat.white, qty: 500 });
  assert.equal(quote.purchase_value_iqd, 12125);
  assert.equal(quote.estimated_value_iqd, 6063);
  assert.equal(quote.rate_bps, 5000);
  await refused(w.a, 'POST', `${API}/buybacks/quote`, { variant_id: cat.white, qty: 501 }, 'INSUFFICIENT_INVENTORY');
  const req = await ok(w.a, 'POST', `${API}/buybacks`, { variant_id: cat.white, qty: 500 }, idem('bb'));
  // Reserved: no print can use the grams being sold back.
  assert.deepEqual([(await owned(w.a, cat.white)).available_qty, (await owned(w.a, cat.white)).reserved_qty], [0, 500]);
  const sellableBefore = row(w, 'SELECT on_hand_qty - reserved_qty - allocated_qty AS s FROM pc_stock_positions WHERE variant_id = ?', cat.white)?.s;
  await refused(w.assistant, 'POST', `${ADMIN}/buybacks/${req.buyback_id}/approve`, {}, 'FINANCIAL_SCOPE_REQUIRED');
  const approved = await ok(w.full, 'POST', `${ADMIN}/buybacks/${req.buyback_id}/approve`, { note: 'ok' });
  assert.equal(approved.value_iqd, 6063);
  assert.equal((await owned(w.a, cat.white)).reserved_qty, 0);
  assert.equal(row(w, 'SELECT on_hand_qty - reserved_qty - allocated_qty AS s FROM pc_stock_positions WHERE variant_id = ?', cat.white)?.s, Number(sellableBefore) + 500, 'the grams went back to sellable stock');
  // Accessories never inherit the filament rule.
  await buy(w.a, [{ kind: 'material', variant_id: cat.magnets, quantity: 10 }]);
  await refused(w.a, 'POST', `${API}/buybacks/quote`, { variant_id: cat.magnets, qty: 5 }, 'BUYBACK_NOT_ALLOWED');
  await reconcileClean(w);
});

test('security: customer A cannot read B’s file, inventory, job, order or project — every id answers 404', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  await buy(w.b, [{ kind: 'credit_package', package_id: cat.packages.h24 }, { kind: 'material', variant_id: cat.white, quantity: 250 }]);
  const { jobId, projectId } = await estimatedJob(w, w.b, cat, { seconds: H, materials: [{ variant_id: cat.white, model_grams: 20 }] });
  const fileId = row(w, "SELECT id FROM pc_model_files WHERE user_id = 'usr_pc_b'")?.id as string;
  const orderId = row(w, "SELECT id FROM pc_orders WHERE user_id = 'usr_pc_b'")?.id as string;
  for (const path of [`/files/${fileId}`, `/files/${fileId}/download`, `/jobs/${jobId}`, `/orders/${orderId}`, `/projects/${projectId}`]) {
    const r = await call(w.a, 'GET', `${API}${path}`);
    assert.equal(r.status, 404, `${path} answered ${r.status}`);
  }
  await refused(w.a, 'POST', `${API}/files/${fileId}/download-link`, {}, 'NOT_FOUND');
  await refused(w.a, 'POST', `${API}/jobs/${jobId}/cancel`, {}, 'NOT_FOUND');
  await refused(w.a, 'POST', `${API}/projects/${projectId}/models`, { file_id: fileId }, 'NOT_FOUND');
  // A's own project cannot reference B's file either.
  const mine = await ok(w.a, 'POST', `${API}/projects`, { name: 'mine' });
  await refused(w.a, 'POST', `${API}/projects/${mine.project_id}/models`, { file_id: fileId }, 'NOT_FOUND');
  assert.deepEqual(await ok(w.a, 'GET', `${API}/me/inventory`), []);
  assert.deepEqual((await ok(w.a, 'GET', `${API}/me/credits`)).tiers, []);
  // Signed links are bound to the account they were issued to.
  const link = await ok(w.b, 'POST', `${API}/files/${fileId}/download-link`);
  assert.equal((await call(w.a, 'GET', link.url)).status, 404);
  assert.equal((await w.b.request(link.url, { headers: { 'CF-Connecting-IP': '1.2.3.4' } })).status, 200);
  // A guest gets nothing private; a merchant storefront host gets nothing at all.
  assert.equal((await call(w.guest, 'GET', `${API}/me/credits`)).status, 401);
  assert.equal((await call(w.as({ id: 'usr_pc_a', role: 'customer', email: 'a@x.co' }, 'somestore.levonis-iq.com'), 'GET', `${API}/me/credits`)).status, 404);
  assert.equal((await call(w.as(null, 'cloud.levonis-iq.com'), 'GET', `${API}/printers`)).status, 200);
  // Agents never see a printer credential, and an unknown token is refused.
  assert.equal((await call(w.guest, 'GET', `${AGENT}/printers`, undefined, { Authorization: 'Bearer pca_wrongwrongwrongwrongwrong' })).status, 401);
});
