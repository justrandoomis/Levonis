/**
 * LEVONIS PRINT CLOUD — the operational doors beyond the §36 scenarios:
 * the service gates, roles, idempotency, URL imports, plates, the workshop
 * agent and stale telemetry, refunds, conversion, pickup and fee-order expiry,
 * buyback cancellation, append-only ledgers and the reconciliation report
 * catching a tampered balance.
 *
 * Run: node --import tsx --test tests/printCloudOperations.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, dbThrough, stubApp } from './fixtures/app';
import {
  ADMIN,
  AGENT,
  API,
  CUSTOMER_A,
  PC_OWNER,
  buy,
  call,
  credits,
  estimatedJob,
  idem,
  mountPrintCloud,
  ok,
  owned,
  pcWorld,
  reading,
  readyFile,
  reconcileClean,
  refused,
  row,
  rows,
  runToPrinting,
  seedCatalog,
  upload,
} from './fixtures/printCloud';
import { expireUnpaidOrders } from '../worker/lib/printCloud/orders';
import { printCloudTick } from '../worker/lib/printCloud/background';
import { countingD1 } from '../worker/lib/d1Count';
import { PRINT_CLOUD_TICK_BUDGET } from '../worker/lib/quarterHourBudget';

const H = 3600;

test('gates: without 0215 reads see an empty, closed service and writes answer 503 PRINT_CLOUD_NOT_INSTALLED; a closed service answers 503 PRINT_CLOUD_DISABLED except to admins', async () => {
  const old = asD1(dbThrough('0214'));
  const customer = stubApp(old, CUSTOMER_A, mountPrintCloud, { publishV2: false });
  const status = await call(customer, 'GET', `${API}/status`);
  assert.equal(status.status, 200);
  assert.equal(status.json.data.installed, false);
  assert.equal(status.json.data.enabled, false, 'the default configuration: closed');
  assert.equal((await call(customer, 'GET', `${API}/printers`)).json.code, 'PRINT_CLOUD_DISABLED');
  const write = await call(customer, 'POST', `${API}/quotes`, { lines: [] });
  assert.equal(write.status, 503);
  assert.equal(write.json.code, 'PRINT_CLOUD_NOT_INSTALLED', 'a write never reaches a statement');
  const owner = stubApp(old, PC_OWNER, mountPrintCloud, { publishV2: false });
  const listed = await call(owner, 'GET', `${API}/printers`);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.json.data, [], 'an empty service, exactly as a migrated database with no printers');
  assert.equal((await call(owner, 'GET', `${API}/printers/pcpm_none`)).status, 404, 'a named record does not exist');
  assert.equal((await call(owner, 'GET', `${ADMIN}/jobs`)).status, 200);
  assert.equal((await call(owner, 'GET', `${AGENT}/printers`)).status, 401, 'no agent token can be valid');
  assert.equal((await call(owner, 'POST', `${ADMIN}/queue/run`, {})).json.code, 'PRINT_CLOUD_NOT_INSTALLED');

  const w = pcWorld();
  await refused(w.a, 'GET', `${API}/printers`, undefined, 'PRINT_CLOUD_DISABLED');
  assert.equal((await ok(w.guest, 'GET', `${API}/status`)).enabled, false, 'status answers while closed');
  assert.equal((await call(w.owner, 'GET', `${API}/printers`)).status, 200, 'an admin may test before opening');
  const doc = await call(w.guest, 'GET', `${API}/openapi.json`);
  assert.equal(doc.status, 200);
  assert.equal(doc.json.openapi, '3.1.0');
});

test('roles: an assistant (operator) runs the floor but never money or cost; the owner alone sees costs', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  await refused(w.assistant, 'PUT', `${ADMIN}/variants/${cat.white}/price-tiers`, { tiers: [{ mode: 'pack', min_qty: 100, pack_price_iqd: 1 }] }, 'FINANCIAL_SCOPE_REQUIRED');
  await refused(w.assistant, 'GET', `${ADMIN}/orders`, undefined, 'FINANCIAL_SCOPE_REQUIRED');
  await refused(w.assistant, 'GET', `${ADMIN}/reports/revenue`, undefined, 'FINANCIAL_SCOPE_REQUIRED');
  await refused(w.full, 'GET', `${ADMIN}/reports/profit`, undefined, 'COST_ACCESS_DENIED');
  await refused(w.full, 'GET', `${ADMIN}/stock/lots`, undefined, 'COST_ACCESS_DENIED');
  assert.equal((await call(w.owner, 'GET', `${ADMIN}/stock/lots`)).status, 200);
  // A price field through the generic catalogue door is a money act; a cost field is the owner's.
  await refused(w.assistant, 'PATCH', `${ADMIN}/catalog/packages/${cat.packages.h24}`, { price_iqd: 1 }, 'FORBIDDEN');
  await refused(w.full, 'PATCH', `${ADMIN}/catalog/printers/${cat.printers[0]}`, { acquisition_cost_iqd: 1 }, 'FORBIDDEN');
  await ok(w.assistant, 'PATCH', `${ADMIN}/catalog/printers/${cat.printers[0]}`, { location: 'Bay 2' });
  // Reading the printers: the acquisition cost reaches the owner only.
  const asAssistant = await ok(w.assistant, 'GET', `${ADMIN}/catalog/printers`);
  const asOwner = await ok(w.owner, 'GET', `${ADMIN}/catalog/printers`);
  assert.ok(!('acquisition_cost_iqd' in asAssistant[0]));
  assert.equal(asOwner[0].acquisition_cost_iqd, 2_400_000);
  // A price change never rewrites what was bought: the history records it, the old lot keeps its price.
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h24 }]);
  await ok(w.full, 'PATCH', `${ADMIN}/catalog/packages/${cat.packages.h24}`, { price_iqd: 40000 });
  assert.equal(row(w, "SELECT paid_iqd FROM pc_credit_lots WHERE user_id = 'usr_pc_a'")?.paid_iqd, 36000);
  const changes = await ok(w.full, 'GET', `${ADMIN}/price-changes`);
  assert.ok(changes.some((c: Record<string, string>) => c.entity_id === cat.packages.h24 && JSON.parse(c.after_json).price_iqd === 40000));
  // Customers never reach administration; merchant hosts never reach anything.
  assert.equal((await call(w.a, 'GET', `${ADMIN}/overview`)).status, 403);
  assert.equal((await call(w.as({ id: 'usr_owner', role: 'admin', email: 'boss@x.co' }, 'somestore.levonis-iq.com'), 'GET', `${ADMIN}/overview`)).status, 404);
});

test('idempotency: a replayed order returns the first answer; the same key for another request is refused', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const q = await ok(w.a, 'POST', `${API}/quotes`, { lines: [{ kind: 'credit_package', package_id: cat.packages.h6 }] });
  const key = { 'Idempotency-Key': 'order-key-0001' };
  const first = await ok(w.a, 'POST', `${API}/orders`, { quote_id: q.quote_id, payment_method: 'dev' }, key);
  const again = await ok(w.a, 'POST', `${API}/orders`, { quote_id: q.quote_id, payment_method: 'dev' }, key);
  assert.equal(again.order_id, first.order_id);
  assert.equal(again.replayed, true);
  await refused(w.a, 'POST', `${API}/orders`, { quote_id: q.quote_id, payment_method: 'manual' }, 'IDEMPOTENCY_KEY_REUSED', key);
  await refused(w.a, 'POST', `${API}/orders`, { quote_id: q.quote_id }, 'IDEMPOTENCY_KEY_REQUIRED');
  await refused(w.a, 'POST', `${API}/orders`, { quote_id: q.quote_id, payment_method: 'dev' }, 'QUOTE_ALREADY_ORDERED', idem('other'));
  assert.equal(row(w, "SELECT COUNT(*) AS n FROM pc_orders WHERE user_id = 'usr_pc_a'")?.n, 1);
  // An expired quote cannot become an order.
  const q2 = await ok(w.a, 'POST', `${API}/quotes`, { lines: [{ kind: 'credit_package', package_id: cat.packages.h6 }] });
  w.raw.prepare("UPDATE pc_quotes SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(q2.quote_id);
  await refused(w.a, 'POST', `${API}/orders`, { quote_id: q2.quote_id, payment_method: 'dev' }, 'QUOTE_EXPIRED', idem('exp'));
  // The levonis_wallet method places the order and names the wallet door (tests/printCloudWallet.test.ts pays it)…
  const q3 = await ok(w.a, 'POST', `${API}/quotes`, { lines: [{ kind: 'credit_package', package_id: cat.packages.h6 }] });
  const viaWallet = await ok(w.a, 'POST', `${API}/orders`, { quote_id: q3.quote_id, payment_method: 'levonis_wallet' }, idem('w'));
  assert.equal(viaWallet.payment.action, 'pay_from_wallet');
  assert.equal(viaWallet.payment.pay_path, `/api/print-cloud/v1/orders/${viaWallet.order_id}/pay/wallet`);
  // …unless the owner switched wallet payments off.
  const settings = await ok(w.owner, 'GET', `${ADMIN}/settings`);
  await ok(w.owner, 'PATCH', `${ADMIN}/settings`, { version: settings.version, config: { wallet_payment_enabled: false } });
  const q4 = await ok(w.a, 'POST', `${API}/quotes`, { lines: [{ kind: 'credit_package', package_id: cat.packages.h6 }] });
  await refused(w.a, 'POST', `${API}/orders`, { quote_id: q4.quote_id, payment_method: 'levonis_wallet' }, 'PAYMENT_ADAPTER_DISABLED', idem('w-off'));
});

test('unpaid orders expire: the held stock returns to the shelf exactly once', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const q = await ok(w.a, 'POST', `${API}/quotes`, { lines: [{ kind: 'material', variant_id: cat.gold, quantity: 100 }] });
  const o = await ok(w.a, 'POST', `${API}/orders`, { quote_id: q.quote_id, payment_method: 'manual' }, idem('o'));
  assert.equal(row(w, 'SELECT reserved_qty FROM pc_stock_positions WHERE variant_id = ?', cat.gold)?.reserved_qty, 100);
  const later = new Date(Date.now() + 2 * H * 1000);
  assert.deepEqual(await expireUnpaidOrders(w.db, later), { expired: 1, failed: 0, more: false });
  assert.deepEqual(await expireUnpaidOrders(w.db, later), { expired: 0, failed: 0, more: false });
  assert.equal(row(w, 'SELECT reserved_qty FROM pc_stock_positions WHERE variant_id = ?', cat.gold)?.reserved_qty, 0);
  assert.equal(row(w, 'SELECT status FROM pc_orders WHERE id = ?', o.order_id)?.status, 'expired');
  // A payment that arrives after expiry is recorded for the refund desk and grants nothing.
  const late = await ok(w.full, 'POST', `${ADMIN}/orders/${o.order_id}/confirm-payment`, { reference: 'late', amount_iqd: o.total_iqd });
  assert.equal(late.outcome, 'order_not_payable');
  assert.equal((await owned(w.a, cat.gold)).available_qty, 0);
  const report = await ok(w.owner, 'GET', `${ADMIN}/reconcile`);
  assert.equal(report.checks.find((c: Record<string, unknown>) => c.name === 'payments_needing_refund').issues.length, 1);
});

test('URL imports: allow-listed https only, SSRF-guarded, and a link without an authorised download is NEVER reported as a file', async () => {
  const w = pcWorld();
  await seedCatalog(w);
  await refused(w.a, 'POST', `${API}/imports`, { url: 'http://makerworld.com/en/models/1' }, 'URL_NOT_ALLOWED');
  await refused(w.a, 'POST', `${API}/imports`, { url: 'https://evil.example.com/models/1' }, 'URL_NOT_ALLOWED');
  await refused(w.a, 'POST', `${API}/imports`, { url: 'https://127.0.0.1/models/1' }, 'URL_NOT_ALLOWED');
  await refused(w.a, 'POST', `${API}/imports`, { url: 'https://user:pass@makerworld.com/models/1' }, 'URL_NOT_ALLOWED');
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    throw new TypeError('no network in this test');
  }) as typeof fetch;
  try {
    const imp = await ok(w.a, 'POST', `${API}/imports`, { url: 'https://makerworld.com/en/models/123456?from=share' });
    assert.equal(imp.provider, 'makerworld');
    assert.equal(imp.external_id, '123456');
    await w.runTasks();
    const done = await ok(w.a, 'GET', `${API}/imports/${imp.import_id}`);
    assert.equal(done.status, 'link_saved');
    assert.equal(done.file_imported, false);
    assert.equal(done.error_code, 'MANUAL_UPLOAD_REQUIRED');
    assert.equal(done.canonical_url, 'https://makerworld.com/en/models/123456');
    assert.equal(fetched, 0, 'no API configured: nothing was fetched at all');
    assert.equal(row(w, "SELECT COUNT(*) AS n FROM pc_model_files WHERE user_id = 'usr_pc_a' AND source = 'url_import'")?.n, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
  // An API that offers a file on a host that is not authorised: metadata kept, no download attempted.
  const settings = await ok(w.owner, 'GET', `${ADMIN}/settings`);
  await ok(w.owner, 'PATCH', `${ADMIN}/settings`, {
    version: settings.version,
    config: { import_providers: [{ id: 'printables', hosts: ['printables.com'], api_url: 'https://api.printables.com/m/{id}', download_hosts: ['files.printables.com'], enabled: true }] },
  });
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push(url);
    return new Response(JSON.stringify({ name: 'Vase', download_url: 'https://cdn.elsewhere.com/vase.stl' }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const imp = await ok(w.a, 'POST', `${API}/imports`, { url: 'https://www.printables.com/model/77-vase' });
    await w.runTasks();
    const done = await ok(w.a, 'GET', `${API}/imports/${imp.import_id}`);
    assert.equal(done.status, 'link_saved');
    assert.equal(done.metadata.name, 'Vase');
    assert.deepEqual(seen, ['https://api.printables.com/m/77']);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('uploads: a renamed file and a dangerous 3MF are refused at the door; a valid model is measured in the background', async () => {
  const w = pcWorld();
  await seedCatalog(w);
  const bad = await upload(w.a, new TextEncoder().encode('MZ this is an exe'), 'innocent.stl');
  assert.equal(bad.status, 415);
  assert.equal(bad.json.details.reason, 'CONTENT_DOES_NOT_MATCH_EXTENSION');
  const { zipSync, strToU8 } = await import('fflate');
  const evil = await upload(w.a, zipSync({ '3D/3dmodel.model': strToU8('<model/>'), '../../etc/passwd.model': strToU8('x') }), 'evil.3mf');
  assert.equal(evil.status, 422);
  assert.equal(evil.json.details.reason, 'ARCHIVE_PATH_TRAVERSAL');
  assert.equal(row(w, 'SELECT COUNT(*) AS n FROM pc_model_files')?.n, 0, 'nothing refused was stored');
  const fileId = await readyFile(w, w.a, [300, 20, 10], 'long.stl');
  const view = await ok(w.a, 'GET', `${API}/files/${fileId}`);
  assert.equal(view.status, 'ready');
  assert.deepEqual(view.printer_compatibility.map((c: Record<string, boolean>) => [c.as_oriented, c.any_orientation]), [[false, false]], '300 mm fits no 256 mm bed in any orientation');
  assert.ok([...w.bucket.objects.keys()].every((k) => k.startsWith(`print-cloud/usr_pc_a/models/`)), 'stored privately under the owner');
});

test('plates: an arranged plate is valid and named by its algorithm; overlapping manual placements are reported', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const fileId = await readyFile(w, w.a, [30, 20, 5]);
  const project = await ok(w.a, 'POST', `${API}/projects`, { name: 'Medals', project_type: 'medal' });
  const model = await ok(w.a, 'POST', `${API}/projects/${project.project_id}/models`, { file_id: fileId, quantity: 10, material_assignments: [{ variant_id: cat.white }] });
  const arranged = await ok(w.a, 'POST', `${API}/projects/${project.project_id}/plates`, { printer_model_id: cat.model, arrange: true });
  assert.equal(arranged.valid, true);
  assert.equal(arranged.placed, 10);
  assert.equal(arranged.algorithm, 'bbox_shelf_v1');
  const manual = await ok(w.a, 'POST', `${API}/projects/${project.project_id}/plates`, {
    printer_model_id: cat.model,
    placements: [
      { project_model_id: model.project_model_id, x_um: 50_000, y_um: 50_000 },
      { project_model_id: model.project_model_id, x_um: 60_000, y_um: 50_000 },
    ],
  });
  assert.equal(manual.valid, false);
  assert.equal(manual.issues[0].code, 'COLLISION');
  await refused(w.a, 'POST', `${API}/jobs`, { project_id: project.project_id, printer_model_id: cat.model, plate_id: manual.plate_id }, 'VALIDATION');
  const dup = await ok(w.a, 'POST', `${API}/projects/${project.project_id}/duplicate`);
  const copy = await ok(w.a, 'GET', `${API}/projects/${dup.project_id}`);
  assert.equal(copy.models[0].file_id, fileId, 'printing again needs no re-upload');
  assert.equal(copy.plates.length, 2);
});

test('the agent: scoped to its printers; stale telemetry is said to be stale; a silent printer gets no work', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w, { approval: false });
  const agent = await ok(w.full, 'POST', `${ADMIN}/agents`, { name: 'Bay 1', capabilities: ['telemetry', 'job_control'] });
  const other = await ok(w.full, 'POST', `${ADMIN}/agents`, { name: 'Bay 2', capabilities: ['telemetry'] });
  await refused(w.assistant, 'POST', `${ADMIN}/agents`, { name: 'x' }, 'FINANCIAL_SCOPE_REQUIRED');
  const bearer = { Authorization: `Bearer ${agent.token}` };
  await ok(w.owner, 'PATCH', `${ADMIN}/catalog/printers/${cat.printers[0]}`, { adapter: 'agent', agent_id: agent.agent_id, connection_ref: 'lan-1' });
  const mine = await ok(w.guest, 'GET', `${AGENT}/printers`, undefined, bearer);
  assert.deepEqual(mine.map((p: Record<string, string>) => p.id), [cat.printers[0]]);
  assert.equal((await call(w.guest, 'POST', `${AGENT}/printers/${cat.printers[1]}/telemetry`, reading({ machine_state: 'idle' }), bearer)).status, 404, 'not its printer');
  assert.equal((await call(w.guest, 'POST', `${AGENT}/printers/${cat.printers[0]}/telemetry`, reading({ machine_state: 'idle' }), { Authorization: `Bearer ${other.token}` })).status, 404);
  await ok(w.guest, 'POST', `${AGENT}/printers/${cat.printers[0]}/telemetry`, reading({ machine_state: 'idle', nozzle_temp_dc: 245, camera: { available: true, stream_id: 'cam-1', url: 'rtsp://user:pw@10.0.0.5' } }), bearer);
  const fresh = (await ok(w.assistant, 'GET', `${ADMIN}/printers`)).find((p: Record<string, string>) => p.id === cat.printers[0]);
  assert.equal(fresh.connectivity, 'online');
  assert.equal(fresh.telemetry.live, true);
  assert.deepEqual(fresh.telemetry.camera, { available: true, stream_id: 'cam-1' }, 'camera metadata only — no URL, no credential');
  // Silence: neither a reading nor a connection since 2000.
  w.raw.prepare("UPDATE pc_printer_telemetry SET received_at = '2000-01-01T00:00:00.000Z', arrived_at = '2000-01-01T00:00:00.000Z' WHERE printer_id = ?").run(cat.printers[0]);
  const stale = (await ok(w.assistant, 'GET', `${ADMIN}/printers`)).find((p: Record<string, string>) => p.id === cat.printers[0]);
  assert.equal(stale.connectivity, 'offline');
  assert.equal(stale.telemetry.stale, true);
  assert.equal(stale.telemetry.live, false);
  assert.equal(stale.telemetry.nozzle_temp_dc, 245, 'the last reading is kept, labelled stale, never shown as live');
  // With the manual printer in maintenance, only the stale agent printer remains: nothing is assigned.
  await ok(w.owner, 'PATCH', `${ADMIN}/catalog/printers/${cat.printers[1]}`, { status: 'maintenance' });
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h6 }, { kind: 'material', variant_id: cat.white, quantity: 250 }]);
  const { jobId } = await estimatedJob(w, w.a, cat, { seconds: H, materials: [{ variant_id: cat.white, model_grams: 20 }] });
  await ok(w.a, 'POST', `${API}/jobs/${jobId}/review`);
  assert.equal((await ok(w.a, 'POST', `${API}/jobs/${jobId}/confirm`, undefined, idem('c'))).status, 'queued');
  assert.equal((await ok(w.assistant, 'POST', `${ADMIN}/queue/run`)).assigned.length, 0);
  // The printer reports again after the silence: the reconnection is recorded.
  await ok(w.guest, 'POST', `${AGENT}/printers/${cat.printers[0]}/telemetry`, reading({ machine_state: 'idle' }), bearer);
  assert.ok(rows(w, "SELECT kind FROM pc_printer_events WHERE printer_id = ?", cat.printers[0]).some((e) => e.kind === 'connection_restored'));
  assert.deepEqual((await ok(w.assistant, 'POST', `${ADMIN}/queue/run`)).assigned, [{ job_id: jobId, printer_id: cat.printers[0] }]);
  // An event for a job on another printer, or a job not assigned to it, is refused.
  await refused(w.guest, 'POST', `${AGENT}/jobs/${jobId}/events`, { event: 'started', printer_id: cat.printers[1] }, 'NOT_FOUND', bearer);
  await ok(w.guest, 'POST', `${AGENT}/jobs/${jobId}/events`, { event: 'started', printer_id: cat.printers[0] }, bearer);
  // Operator commands reach the agent; revoking the agent closes its door.
  await ok(w.assistant, 'POST', `${ADMIN}/printers/${cat.printers[0]}/commands`, { command: 'pause', job_id: jobId });
  const cmds = await ok(w.guest, 'GET', `${AGENT}/commands`, undefined, bearer);
  assert.equal(JSON.parse(cmds[0].detail_json).command, 'pause');
  await ok(w.full, 'POST', `${ADMIN}/agents/${agent.agent_id}/revoke`);
  assert.equal((await call(w.guest, 'GET', `${AGENT}/printers`, undefined, bearer)).status, 401);
});

test('refunds: only unused hours and grams of that purchase; the order and stock follow exactly', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const orderId = await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h24 }, { kind: 'material', variant_id: cat.white, quantity: 500 }]);
  const order = await ok(w.full, 'GET', `${ADMIN}/orders/${orderId}`);
  const [hours, pla] = order.lines;
  const { jobId } = await estimatedJob(w, w.a, cat, { seconds: 4 * H, materials: [{ variant_id: cat.white, model_grams: 100 }] });
  await runToPrinting(w, w.a, jobId);
  // 4 h are reserved: only the other 20 h can be refunded.
  await refused(w.full, 'POST', `${ADMIN}/orders/${orderId}/refunds`, { line_id: hours.id, quantity: 21 * H, reason: 'x' }, 'INSUFFICIENT_CREDIT', idem('r0'));
  const r1 = await ok(w.full, 'POST', `${ADMIN}/orders/${orderId}/refunds`, { line_id: hours.id, quantity: 12 * H, reason: 'half back' }, idem('r1'));
  assert.equal(r1.amount_iqd, 18000);
  const r2 = await ok(w.full, 'POST', `${ADMIN}/orders/${orderId}/refunds`, { line_id: pla.id, quantity: 200, reason: 'unused' }, idem('r2'));
  assert.equal(r2.amount_iqd, 5800);
  const after = await ok(w.full, 'GET', `${ADMIN}/orders/${orderId}`);
  assert.equal(after.status, 'partially_refunded');
  assert.equal(after.refunded_iqd, 23800);
  assert.deepEqual([(await credits(w.a, cat.tier)).available_seconds, (await owned(w.a, cat.white)).available_qty], [8 * H, 200]);
  await refused(w.assistant, 'POST', `${ADMIN}/orders/${orderId}/refunds`, { line_id: pla.id, quantity: 10, reason: 'x' }, 'FINANCIAL_SCOPE_REQUIRED', idem('r3'));
  await reconcileClean(w);
});

test('conversion between tiers is off until the owner enables a rule, and then moves value with the hours', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const a1 = await ok(w.owner, 'POST', `${ADMIN}/catalog/tiers`, { code: 'a1', name_en: 'A1 hours', name_ar: 'ساعات A1', name_ckb: 'کاتژمێرەکانی A1', hourly_rate_iqd: 750 });
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h24 }]);
  await refused(w.a, 'POST', `${API}/me/credits/convert`, { from_tier_id: cat.tier, to_tier_id: a1.id, seconds: 2 * H }, 'CONVERSION_DISABLED', idem('cv'));
  const rule = await ok(w.full, 'POST', `${ADMIN}/catalog/conversion_rules`, { from_tier_id: cat.tier, to_tier_id: a1.id, ratio_num: 2, ratio_den: 1 });
  await refused(w.a, 'POST', `${API}/me/credits/convert`, { from_tier_id: cat.tier, to_tier_id: a1.id, seconds: 2 * H }, 'CONVERSION_DISABLED', idem('cv'));
  await ok(w.full, 'PATCH', `${ADMIN}/catalog/conversion_rules/${rule.id}`, { enabled: true });
  const out = await ok(w.a, 'POST', `${API}/me/credits/convert`, { from_tier_id: cat.tier, to_tier_id: a1.id, seconds: 2 * H }, idem('cv'));
  assert.equal(out.received_seconds, 4 * H);
  assert.equal((await credits(w.a, cat.tier)).available_seconds, 22 * H);
  assert.equal((await credits(w.a, a1.id)).available_seconds, 4 * H);
  assert.equal(row(w, 'SELECT paid_iqd FROM pc_credit_lots WHERE tier_id = ?', a1.id)?.paid_iqd, 3000, 'the 3,000 IQD the 2 h cost moved with them');
  await reconcileClean(w);
});

test('pickup, inventory delivery and an unpaid delivery fee that expires', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h6 }, { kind: 'material', variant_id: cat.white, quantity: 500 }]);
  const { jobId } = await estimatedJob(w, w.a, cat, { seconds: H, materials: [{ variant_id: cat.white, model_grams: 30 }] });
  await runToPrinting(w, w.a, jobId);
  await ok(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/complete`, { printed_seconds: H, materials: [{ variant_id: cat.white, qty: 30 }] });
  const pickup = await ok(w.a, 'POST', `${API}/shipments`, { kind: 'pickup', job_ids: [jobId] }, idem('p'));
  assert.deepEqual([pickup.status, pickup.fee_iqd], ['preparing', 0]);
  await refused(w.a, 'POST', `${API}/shipments`, { kind: 'pickup', job_ids: [jobId] }, 'STATE_CHANGED', idem('p2'));
  await ok(w.assistant, 'POST', `${ADMIN}/shipments/${pickup.shipment_id}/advance`, { to: 'ready_for_pickup' });
  await ok(w.assistant, 'POST', `${ADMIN}/shipments/${pickup.shipment_id}/advance`, { to: 'picked_up' });
  // Home delivery of 200 g of owned PLA: reserved at once, taken off the shelf at hand-over.
  const before = row(w, 'SELECT on_hand_qty, allocated_qty FROM pc_stock_positions WHERE variant_id = ?', cat.white);
  const ship = await ok(w.a, 'POST', `${API}/shipments`, {
    kind: 'delivery',
    items: [{ variant_id: cat.white, qty: 200 }],
    payment_method: 'manual',
    delivery_address: { recipient_name: 'Ali', phone: '07700000000', governorate: 'أربيل', city: 'Erbil', address_line: '100m road' },
  }, idem('d'));
  assert.equal(ship.fee_iqd, 5000);
  assert.equal((await owned(w.a, cat.white)).reserved_qty, 200);
  // The fee is never paid: the order expires, the shipment is cancelled and the 200 g come back to the customer.
  await expireUnpaidOrders(w.db, new Date(Date.now() + 2 * H * 1000));
  assert.equal((await ok(w.a, 'GET', `${API}/shipments/${ship.shipment_id}`)).status, 'cancelled');
  assert.deepEqual([(await owned(w.a, cat.white)).available_qty, (await owned(w.a, cat.white)).reserved_qty], [470, 0]);
  // Again, paid this time, and handed over.
  const ship2 = await ok(w.a, 'POST', `${API}/shipments`, {
    kind: 'delivery',
    items: [{ variant_id: cat.white, qty: 200 }],
    payment_method: 'dev',
    delivery_address: { recipient_name: 'Ali', phone: '07700000000', governorate: 'erbil', city: 'Erbil', address_line: '100m road' },
  }, idem('d2'));
  await ok(w.a, 'POST', `${API}/orders/${ship2.fee_order_id}/dev-pay`, {});
  await ok(w.assistant, 'POST', `${ADMIN}/shipments/${ship2.shipment_id}/advance`, { to: 'shipped', tracking_ref: 'T-1' });
  const white = await owned(w.a, cat.white);
  assert.deepEqual([white.available_qty, white.reserved_qty], [270, 0]);
  const afterShelf = row(w, 'SELECT on_hand_qty, allocated_qty FROM pc_stock_positions WHERE variant_id = ?', cat.white);
  assert.deepEqual(afterShelf, { on_hand_qty: Number(before?.on_hand_qty) - 200, allocated_qty: Number(before?.allocated_qty) - 200 });
  await reconcileClean(w);
});

test('ledgers are append-only, and reconciliation reports a tampered balance instead of fixing it', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h6 }, { kind: 'material', variant_id: cat.white, quantity: 250 }]);
  assert.throws(() => w.raw.exec("UPDATE pc_credit_ledger SET delta_available = 999999"), /PC_APPEND_ONLY/);
  assert.throws(() => w.raw.exec('DELETE FROM pc_inventory_ledger'), /PC_APPEND_ONLY/);
  assert.throws(() => w.raw.exec('DELETE FROM pc_warehouse_ledger'), /PC_APPEND_ONLY/);
  assert.throws(() => w.raw.exec("UPDATE pc_credit_accounts SET available_seconds = -1"), /ck_pc_credit_available/);
  await reconcileClean(w);
  w.raw.exec("UPDATE pc_credit_accounts SET available_seconds = available_seconds + 3600 WHERE user_id = 'usr_pc_a'");
  const report = await ok(w.owner, 'GET', `${ADMIN}/reconcile`);
  const failed = report.checks.filter((c: Record<string, unknown>) => !c.ok).map((c: Record<string, unknown>) => c.name);
  assert.ok(failed.includes('credit_accounts_equal_ledger'));
  assert.ok(failed.includes('credit_lots_cover_balance'));
  assert.equal(row(w, "SELECT available_seconds FROM pc_credit_accounts WHERE user_id = 'usr_pc_a'")?.available_seconds, 6 * H + 3600, 'reported, never silently corrected');
});

test('buyback request reserves the units; cancelling returns them once', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  await ok(w.full, 'PATCH', `${ADMIN}/categories/filaments/buyback`, { buyback_enabled: true, buyback_rate_bps: 5000 });
  await buy(w.a, [{ kind: 'material', variant_id: cat.black, quantity: 250 }]);
  const req = await ok(w.a, 'POST', `${API}/buybacks`, { variant_id: cat.black, qty: 100 });
  assert.equal(req.estimated_value_iqd, 1600);
  // Reserved units cannot be used by a print or sold twice.
  await refused(w.a, 'POST', `${API}/buybacks`, { variant_id: cat.black, qty: 200 }, 'INSUFFICIENT_INVENTORY');
  await ok(w.a, 'POST', `${API}/buybacks/${req.buyback_id}/cancel`);
  await refused(w.a, 'POST', `${API}/buybacks/${req.buyback_id}/cancel`, {}, 'INVALID_TRANSITION');
  assert.deepEqual([(await owned(w.a, cat.black)).available_qty, (await owned(w.a, cat.black)).reserved_qty], [250, 0]);
  await reconcileClean(w);
});

test('background work is durable: a task that fails is retried with backoff and dies after its last attempt, logged', async () => {
  const w = pcWorld();
  await seedCatalog(w);
  w.raw.exec(`INSERT INTO pc_background_jobs (id, kind, payload_json, dedupe_key, status, attempts, max_attempts, run_after, created_at, updated_at)
              VALUES ('bj1', 'analyze_model_file', '{"file_id":"pcf_missing"}', 'x1', 'queued', 0, 2, '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z')`);
  await w.runTasks();
  // A missing file is an idempotent no-op, not an error: succeeded, logged.
  assert.equal(row(w, "SELECT status FROM pc_background_jobs WHERE id = 'bj1'")?.status, 'succeeded');
  w.raw.exec(`INSERT INTO pc_background_jobs (id, kind, payload_json, dedupe_key, status, attempts, max_attempts, run_after, created_at, updated_at)
              VALUES ('bj2', 'import_model_url', 'not json', 'x2', 'queued', 0, 2, '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z')`);
  await w.runTasks();
  assert.equal(row(w, "SELECT status FROM pc_background_jobs WHERE id = 'bj2'")?.status, 'queued');
  w.raw.exec("UPDATE pc_background_jobs SET run_after = '2000-01-01T00:00:00.000Z' WHERE id = 'bj2'");
  await w.runTasks();
  const dead = row(w, "SELECT status, attempts, last_error FROM pc_background_jobs WHERE id = 'bj2'");
  assert.equal(dead?.status, 'dead');
  assert.equal(dead?.attempts, 2);
  assert.equal(rows(w, "SELECT level FROM pc_background_job_logs WHERE job_id = 'bj2'").length, 2);
  // A lease that expired (a runner that died) is claimed again.
  w.raw.exec(`INSERT INTO pc_background_jobs (id, kind, payload_json, dedupe_key, status, attempts, max_attempts, run_after, lease_token, lease_until, created_at, updated_at)
              VALUES ('bj3', 'expire_orders', '{}', 'x3', 'running', 1, 3, '2000-01-01T00:00:00.000Z', 'old', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z')`);
  await w.runTasks();
  assert.equal(row(w, "SELECT status FROM pc_background_jobs WHERE id = 'bj3'")?.status, 'succeeded');
});

test('the cron step stays inside its share: a backlog bigger than one tick is worked a bounded piece at a time, and later ticks finish it', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  for (let i = 0; i < 12; i++) {
    const q = await ok(w.a, 'POST', `${API}/quotes`, { lines: [{ kind: 'material', variant_id: cat.white, quantity: 100 }] });
    await ok(w.a, 'POST', `${API}/orders`, { quote_id: q.quote_id, payment_method: 'manual' }, idem(`backlog-${i}`));
  }
  await w.runTasks(0);
  w.raw.exec("UPDATE pc_orders SET stock_hold_expires_at = '2000-01-01T00:00:00.000Z'");
  const waiting = () => Number(row(w, "SELECT COUNT(*) AS n FROM pc_orders WHERE status = 'awaiting_payment'")?.n);
  assert.equal(waiting(), 12);
  const counted = countingD1(w.db);
  const env = { DB: counted.db, BUCKET: w.bucket, R2_PRIVATE: w.bucket } as never;
  const spent: number[] = [];
  while (waiting() > 0 && spent.length < 12) {
    const before = counted.executed;
    await printCloudTick(env, { budget: PRINT_CLOUD_TICK_BUDGET, used: () => counted.executed });
    spent.push(counted.executed - before);
  }
  assert.equal(waiting(), 0, `every hold expired, over ${spent.length} ticks`);
  assert.ok(spent.length >= 2, `twelve expiries do not fit one share (${spent.join(', ')})`);
  for (const n of spent) assert.ok(n <= PRINT_CLOUD_TICK_BUDGET, `a tick spent ${n} of ${PRINT_CLOUD_TICK_BUDGET} (${spent.join(', ')})`);
  assert.equal(row(w, 'SELECT reserved_qty FROM pc_stock_positions WHERE variant_id = ?', cat.white)?.reserved_qty, 0, 'every gram back on the shelf');
  assert.ok(rows(w, "SELECT message FROM pc_background_job_logs WHERE message LIKE '%the rest next run%'").length >= 1, 'a task cut short says so');
  // No share, no work: not even the schema probe.
  const before = counted.executed;
  assert.equal(await printCloudTick(env, { budget: 10, used: () => counted.executed }), null);
  assert.equal(counted.executed, before);
  await reconcileClean(w);
});
