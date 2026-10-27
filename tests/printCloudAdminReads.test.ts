/**
 * LEVONIS PRINT CLOUD — the two reads the admin console needs beyond the
 * original doors (src/components/adminPrintCloud):
 *
 *   GET /printers/{id}/maintenance   the windows `PATCH /maintenance/{id}`
 *                                    closes — their cost the owner's alone
 *   GET /shipments/{id}              one shipment with its packing list —
 *                                    its fee for money scope alone
 *
 * Run: node --import tsx --test tests/printCloudAdminReads.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, API, buy, call, estimatedJob, idem, ok, pcWorld, refused, runToPrinting, seedCatalog } from './fixtures/printCloud';

const H_SECONDS = 3600;

test('maintenance windows: listed per printer, latest start first; the cost reaches the owner only', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const printer = cat.printers[1];
  const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
  const first = await ok(w.owner, 'POST', `${ADMIN}/printers/${printer}/maintenance`, { kind: 'repair', starts_at: at(60), ends_at: at(120), notes: 'belt', cost_iqd: 25_000 });
  const second = await ok(w.assistant, 'POST', `${ADMIN}/printers/${printer}/maintenance`, { kind: 'calibration', starts_at: at(240), ends_at: at(300) });

  const asOwner = await ok(w.owner, 'GET', `${ADMIN}/printers/${printer}/maintenance`);
  assert.deepEqual(
    asOwner.map((m: Record<string, unknown>) => m.id),
    [second.maintenance_id, first.maintenance_id],
    'latest start first'
  );
  assert.equal(asOwner[1].cost_iqd, 25_000, 'the owner reads what the window cost');
  assert.deepEqual([asOwner[1].kind, asOwner[1].status, asOwner[1].notes], ['repair', 'planned', 'belt']);

  for (const reader of [w.full, w.assistant]) {
    const list = (await ok(reader, 'GET', `${ADMIN}/printers/${printer}/maintenance`)) as unknown as Array<Record<string, unknown>>;
    assert.equal(list.length, 2);
    for (const m of list) assert.equal('cost_iqd' in m, false, 'no cost key at all for anyone but the owner');
  }

  // The listed id is the one the PATCH door takes.
  await ok(w.assistant, 'PATCH', `${ADMIN}/maintenance/${second.maintenance_id}`, { status: 'cancelled' });
  const after = await ok(w.assistant, 'GET', `${ADMIN}/printers/${printer}/maintenance`);
  assert.equal(after.find((m: Record<string, unknown>) => m.id === second.maintenance_id).status, 'cancelled');

  assert.deepEqual(await ok(w.assistant, 'GET', `${ADMIN}/printers/${cat.printers[0]}/maintenance`), [], 'another printer has none');
  assert.equal((await call(w.a, 'GET', `${ADMIN}/printers/${printer}/maintenance`)).status, 403, 'a customer is not an admin');
});

test('one shipment: its items for the operator; the delivery fee and fee order for money scope only', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h6 }, { kind: 'material', variant_id: cat.white, quantity: 500 }]);
  const { jobId } = await estimatedJob(w, w.a, cat, { seconds: H_SECONDS, materials: [{ variant_id: cat.white, model_grams: 30 }] });
  await runToPrinting(w, w.a, jobId);
  await ok(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/complete`, { printed_seconds: H_SECONDS, materials: [{ variant_id: cat.white, qty: 30 }] });
  const ship = await ok(
    w.a,
    'POST',
    `${API}/shipments`,
    {
      kind: 'delivery',
      job_ids: [jobId],
      items: [{ variant_id: cat.white, qty: 200 }],
      payment_method: 'manual',
      delivery_address: { recipient_name: 'Ali', phone: '07700000000', governorate: 'erbil', city: 'Erbil', address_line: '100m road' },
    },
    idem('ship')
  );

  const full = await ok(w.full, 'GET', `${ADMIN}/shipments/${ship.shipment_id}`);
  assert.equal(full.status, 'awaiting_payment');
  assert.equal(full.fee_iqd, ship.fee_iqd);
  assert.equal(full.fee_order_id, ship.fee_order_id);
  assert.equal(full.address.governorate, 'erbil');
  const items = full.items.map((i: Record<string, unknown>) => [i.item_type, i.job_id ?? i.variant_id, i.qty]).sort();
  assert.deepEqual(items, [['inventory', cat.white, 200], ['print_job', jobId, 1]].sort(), 'the packing list: the print and the 200 g');

  const operator = await ok(w.assistant, 'GET', `${ADMIN}/shipments/${ship.shipment_id}`);
  assert.equal(operator.items.length, 2, 'the operator packs from the same list');
  assert.equal('fee_iqd' in operator, false, 'no fee for the operator');
  assert.equal('fee_order_id' in operator, false, 'no fee order for the operator');

  await refused(w.assistant, 'GET', `${ADMIN}/shipments/pcsh_none`, undefined, 'NOT_FOUND');
  assert.equal((await call(w.a, 'GET', `${ADMIN}/shipments/${ship.shipment_id}`)).status, 403, 'a customer is not an admin');
});
