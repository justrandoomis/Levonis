/**
 * LEVONIS PRINT CLOUD — the brief's §39 acceptance scenario, end to end, on
 * real persisted records: a new customer buys hours, PLA, magnets and rings;
 * tops up PLA to 490 g; uploads three models (STL, 3MF, OBJ) and imports a
 * fourth by URL; creates five jobs; a slicing WORKER (the workshop agent,
 * through its bearer-token API) measures them; resources are reserved; the
 * scheduler puts them on compatible machines; the machines (agent events)
 * print them; consumption is verified and reconciled; the customer is told;
 * the prints are delivered home; unused material stays theirs; everything is
 * audited and the reconciliation report is clean.
 *
 * Run: node --import tsx --test tests/printCloudAcceptance.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';
import {
  ADMIN,
  AGENT,
  API,
  boxStl,
  buy,
  call,
  credits,
  idem,
  ok,
  owned,
  pcWorld,
  reading,
  reconcileClean,
  row,
  rows,
  seedCatalog,
  upload,
  type Json,
} from './fixtures/printCloud';

const H = 3600;

function cube3mf(size: number): Uint8Array {
  const s = size;
  const v = [
    [0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0],
    [0, 0, s], [s, 0, s], [s, s, s], [0, s, s],
  ];
  const t = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <metadata name="Title">Medal</metadata>
 <resources><object id="1" type="model"><mesh>
  <vertices>${v.map((p) => `<vertex x="${p[0]}" y="${p[1]}" z="${p[2]}"/>`).join('')}</vertices>
  <triangles>${t.map((f) => `<triangle v1="${f[0]}" v2="${f[1]}" v3="${f[2]}"/>`).join('')}</triangles>
 </mesh></object></resources>
 <build><item objectid="1"/></build>
</model>`;
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'),
    '3D/3dmodel.model': strToU8(model),
  });
}

function cubeObj(size: number): Uint8Array {
  const s = size;
  const v = [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, s], [s, 0, s], [s, s, s], [0, s, s]];
  const f = [[1, 3, 2], [1, 4, 3], [5, 6, 7], [5, 7, 8], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 4, 8], [3, 8, 7], [4, 1, 5], [4, 5, 8]];
  return strToU8(`# phone holder\no holder\n${v.map((p) => `v ${p.join(' ')}`).join('\n')}\n${f.map((x) => `f ${x.join(' ')}`).join('\n')}\n`);
}

test('§39 acceptance: purchase → files → five jobs → slicer → queue → machines → reconciliation → delivery, all on real records', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w, { approval: true });

  // The URL provider: its OWN JSON API offers an authorised download on its file host.
  const settings = await ok(w.owner, 'GET', `${ADMIN}/settings`);
  await ok(w.owner, 'PATCH', `${ADMIN}/settings`, {
    version: settings.version,
    config: {
      import_providers: [
        { id: 'printables', hosts: ['printables.com'], api_url: 'https://api.printables.com/v1/models/{id}', download_hosts: ['files.printables.com'], enabled: true },
        { id: 'makerworld', hosts: ['makerworld.com'], api_url: '', download_hosts: [], enabled: true },
      ],
    },
  });

  // ---- 1. A new customer buys 24 h of X2D Combo, 250 g PLA, 10 magnets and 5 rings — one order.
  const orderId = await buy(w.a, [
    { kind: 'credit_package', package_id: cat.packages.h24 },
    { kind: 'material', variant_id: cat.white, quantity: 250 },
    { kind: 'material', variant_id: cat.magnets, quantity: 10 },
    { kind: 'material', variant_id: cat.rings, quantity: 5 },
  ]);
  const order = await ok(w.a, 'GET', `${API}/orders/${orderId}`);
  assert.equal(order.status, 'fulfilled');
  assert.equal(order.total_iqd, 36000 + 8000 + 2000 + 1500);
  assert.equal((await credits(w.a, cat.tier)).available_seconds, 24 * H);
  assert.deepEqual(
    [(await owned(w.a, cat.white)).available_qty, (await owned(w.a, cat.magnets)).available_qty, (await owned(w.a, cat.rings)).available_qty],
    [250, 10, 5]
  );

  // ---- 2. Later: 240 g more PLA → 490 g.
  await buy(w.a, [{ kind: 'material', variant_id: cat.white, quantity: 240 }]);
  assert.equal((await owned(w.a, cat.white)).available_qty, 490);

  // ---- 3. Three uploads (STL, 3MF, OBJ) and a fourth model by URL.
  const stl = await upload(w.a, boxStl(60, 40, 30), 'dragon.stl');
  const tmf = await upload(w.a, cube3mf(30), 'medal.3mf');
  const obj = await upload(w.a, cubeObj(25), 'holder.obj');
  for (const r of [stl, tmf, obj]) assert.equal(r.status, 201, JSON.stringify(r.json));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'https://api.printables.com/v1/models/424242') {
      return new Response(JSON.stringify({ title: 'Keychain tag', creator: { name: 'maker' }, license: 'CC-BY-4.0', download_url: 'https://files.printables.com/424242/keychain.stl' }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === 'https://files.printables.com/424242/keychain.stl') return new Response(boxStl(50, 20, 4));
    throw new TypeError(`unexpected fetch ${url}`);
  }) as typeof fetch;
  let importId: string;
  try {
    importId = (await ok(w.a, 'POST', `${API}/imports`, { url: 'https://www.printables.com/model/424242-keychain-tag?utm_source=x' })).import_id;
    await w.runTasks(20);
  } finally {
    globalThis.fetch = realFetch;
  }
  const imported = await ok(w.a, 'GET', `${API}/imports/${importId}`);
  assert.equal(imported.status, 'file_imported');
  assert.equal(imported.file_imported, true);
  assert.equal(imported.license, 'CC-BY-4.0');
  const files = await ok(w.a, 'GET', `${API}/files`);
  assert.equal(files.length, 4);
  assert.ok(files.every((f: Json) => f.status === 'ready'), JSON.stringify(files));
  const fileOf = (name: string) => files.find((f: Json) => f.original_name === name)!.id as string;
  const geometry = await ok(w.a, 'GET', `${API}/files/${fileOf('dragon.stl')}`);
  assert.deepEqual(geometry.geometry.dimensions_mm, { x: 60, y: 40, z: 30 });
  assert.equal(geometry.printer_compatibility[0].any_orientation, true);

  // ---- 4. Five jobs.
  const plan = [
    { name: 'Dragon', file: fileOf('dragon.stl'), type: 'figure', seconds: Math.round(2.5 * H), grams: 110, accessories: [] as Json[] },
    { name: 'Medal', file: fileOf('medal.3mf'), type: 'medal', seconds: 1 * H, grams: 30, accessories: [] },
    { name: 'Phone holder', file: fileOf('holder.obj'), type: 'magnetic', seconds: Math.round(1.5 * H), grams: 60, accessories: [{ variant_id: cat.magnets, qty: 4 }] },
    { name: 'Keychain', file: fileOf('keychain.stl'), type: 'keychain', seconds: 1 * H, grams: 25, accessories: [{ variant_id: cat.rings, qty: 2 }] },
    { name: 'Storage box', file: fileOf('dragon.stl'), type: 'storage', seconds: 2 * H, grams: 80, accessories: [] },
  ];
  const jobs: string[] = [];
  for (const p of plan) {
    const project = await ok(w.a, 'POST', `${API}/projects`, { name: p.name, project_type: p.type });
    await ok(w.a, 'POST', `${API}/projects/${project.project_id}/models`, { file_id: p.file, material_assignments: [{ variant_id: cat.white }] });
    const job = await ok(w.a, 'POST', `${API}/jobs`, { project_id: project.project_id, printer_model_id: cat.model, title: p.name, accessories: p.accessories.length ? p.accessories : undefined });
    assert.equal(job.status, 'uploaded');
    const analysis = await ok(w.a, 'POST', `${API}/jobs/${job.job_id}/analyze`);
    assert.equal(analysis.slicer, 'awaiting_slicer', 'no slicer is connected yet: the job waits, nothing is invented');
    jobs.push(job.job_id);
  }
  // The keychain project's name and type suggest rings, with the rule that matched.
  const keychainProject = row<{ project_id: string }>(w, 'SELECT project_id FROM pc_print_jobs WHERE id = ?', jobs[3])!.project_id;
  const sugg = await ok(w.a, 'GET', `${API}/projects/${keychainProject}/accessory-suggestions`);
  assert.equal(sugg[0].variant_id, cat.rings);
  assert.equal(sugg[0].reason.method, 'lexical_rule');

  // ---- 5. A workshop agent with a real slicer claims and measures every job.
  const agent = await ok(w.full, 'POST', `${ADMIN}/agents`, { name: 'Workshop PC', capabilities: ['telemetry', 'job_control', 'slicer'] });
  assert.match(agent.token, /^pca_/);
  assert.equal(row(w, 'SELECT COUNT(*) AS n FROM pc_agents WHERE token_hash = ?', agent.token)?.n, 0, 'only the hash is stored');
  const bearer = { Authorization: `Bearer ${agent.token}` };
  for (const id of cat.printers) await ok(w.owner, 'PATCH', `${ADMIN}/catalog/printers/${id}`, { adapter: 'agent', agent_id: agent.agent_id, connection_ref: `lan-${id}` });
  for (let i = 0; i < plan.length; i++) {
    const claim = await ok(w.guest, 'POST', `${AGENT}/slicing/claim`, undefined, bearer);
    assert.ok(claim, 'a slicing request was waiting');
    // The agent downloads the job's file through its job-scoped door…
    const file = await w.guest.request(claim.files[0].path, { headers: { ...bearer, 'CF-Connecting-IP': '1.2.3.4' } });
    assert.equal(file.status, 200);
    // …and posts what its slicer measured.
    const p = plan[jobs.indexOf(claim.job_id)];
    await ok(w.guest, 'POST', `${AGENT}/slicing/${claim.slicing_request_id}/result`, {
      duration_seconds: p.seconds,
      layer_count: 300,
      materials: [{ variant_id: cat.white, model_grams: p.grams - 2, support_grams: 0, purge_grams: 2 }],
      slicer_name: 'OrcaSlicer',
      slicer_version: '2.3.0',
      printer_profile: 'Bambu Lab X2D 0.4',
    }, bearer);
  }
  assert.equal((await ok(w.guest, 'POST', `${AGENT}/slicing/claim`, undefined, bearer)), null);

  // ---- 6. Resources validated and reserved; jobs enter the queue (operator approval on).
  for (const id of jobs) {
    const review = await ok(w.a, 'POST', `${API}/jobs/${id}/review`);
    assert.equal(review.sufficient, true);
    const confirmed = await ok(w.a, 'POST', `${API}/jobs/${id}/confirm`, undefined, idem('confirm'));
    assert.equal(confirmed.status, 'confirmed');
    await ok(w.assistant, 'POST', `${ADMIN}/jobs/${id}/approve`);
  }
  const totalSeconds = plan.reduce((s, p) => s + p.seconds, 0);
  const totalGrams = plan.reduce((s, p) => s + p.grams, 0);
  const c1 = await credits(w.a, cat.tier);
  assert.deepEqual([c1.available_seconds, c1.reserved_seconds], [24 * H - totalSeconds, totalSeconds]);
  const white1 = await owned(w.a, cat.white);
  assert.deepEqual([white1.available_qty, white1.reserved_qty], [490 - totalGrams, totalGrams]);
  assert.deepEqual([(await owned(w.a, cat.magnets)).reserved_qty, (await owned(w.a, cat.rings)).reserved_qty], [4, 2]);

  // ---- 7. The scheduler assigns compatible machines (fresh telemetry first: an agent printer that is silent gets nothing).
  const silent = await ok(w.assistant, 'POST', `${ADMIN}/queue/run`);
  assert.equal(silent.assigned.length, 0, 'stale telemetry: no machine is trusted');
  for (const id of cat.printers) await ok(w.guest, 'POST', `${AGENT}/printers/${id}/telemetry`, reading({ machine_state: 'idle', nozzle_temp_dc: 250, bed_temp_dc: 300 }), bearer);

  // ---- 8. The workshop executes until the queue is empty.
  const completed: string[] = [];
  for (let round = 0; round < 5 && completed.length < jobs.length; round++) {
    const run = await ok(w.assistant, 'POST', `${ADMIN}/queue/run`);
    const machines = new Set(run.assigned.map((a: Json) => a.printer_id));
    assert.equal(machines.size, run.assigned.length, 'never two jobs on one machine');
    for (const a of run.assigned as Json[]) {
      const p = plan[jobs.indexOf(a.job_id)];
      await ok(w.guest, 'POST', `${AGENT}/jobs/${a.job_id}/events`, { event: 'started', printer_id: a.printer_id }, bearer);
      // Re-sent by a flaky network: already applied, nothing changes.
      assert.equal((await ok(w.guest, 'POST', `${AGENT}/jobs/${a.job_id}/events`, { event: 'started', printer_id: a.printer_id }, bearer)).already_applied, true);
      await ok(w.guest, 'POST', `${AGENT}/printers/${a.printer_id}/telemetry`, reading({ machine_state: 'printing', job_id: a.job_id, progress_permille: 500, remaining_seconds: 600 }), bearer);
      const actualSeconds = p.seconds - 300;
      const actualGrams = p.grams - 3;
      const report = await call(w.guest, 'POST', `${AGENT}/jobs/${a.job_id}/events`, { event: 'completed', printer_id: a.printer_id, printed_seconds: actualSeconds, materials: [{ variant_id: cat.white, qty: actualGrams }] }, bearer);
      assert.equal(report.status, 202, 'held for an operator to verify');
      const detail = await ok(w.assistant, 'GET', `${ADMIN}/jobs/${a.job_id}`);
      const record = detail.consumption_records.find((r: Json) => !r.verified);
      await ok(w.assistant, 'POST', `${ADMIN}/jobs/${a.job_id}/verify-completion`, { consumption_record_id: record.id });
      await ok(w.guest, 'POST', `${AGENT}/printers/${a.printer_id}/telemetry`, reading({ machine_state: 'idle' }), bearer);
      completed.push(a.job_id);
    }
  }
  assert.equal(completed.length, 5);

  // ---- 9. Verified consumption recorded; unused reservations released; balances exact.
  const usedSeconds = plan.reduce((s, p) => s + (p.seconds - 300), 0);
  const usedGrams = plan.reduce((s, p) => s + (p.grams - 3), 0);
  const c2 = await credits(w.a, cat.tier);
  assert.deepEqual([c2.available_seconds, c2.reserved_seconds, c2.consumed_seconds], [24 * H - usedSeconds, 0, usedSeconds]);
  const white2 = await owned(w.a, cat.white);
  assert.deepEqual([white2.available_qty, white2.reserved_qty, white2.consumed_qty], [490 - usedGrams, 0, usedGrams]);
  assert.deepEqual(
    [(await owned(w.a, cat.magnets)).available_qty, (await owned(w.a, cat.rings)).available_qty],
    [10 - 4, 5 - 2],
    'accessories: used exactly as reserved'
  );
  for (const id of jobs) assert.equal(row(w, 'SELECT status FROM pc_print_jobs WHERE id = ?', id)?.status, 'completed');

  // ---- 10. Completion notifications, in three languages.
  const notes = rows<{ title_en: string; meta: string }>(w, "SELECT title_en, meta FROM user_notifications WHERE user_id = 'usr_pc_a' AND kind = 'print_cloud' AND json_extract(meta, '$.notice') = 'job_completed'");
  assert.equal(notes.length, 5);
  assert.ok(notes.every((n) => JSON.parse(n.meta).title_ckb === 'چاپکردن تەواو بوو'));

  // ---- 11. Home delivery of the finished prints (its fee is its own order), unused material kept.
  const shipment = await ok(w.a, 'POST', `${API}/shipments`, {
    kind: 'delivery',
    job_ids: jobs,
    payment_method: 'dev',
    delivery_address: { recipient_name: 'Ali', phone: '+9647700000000', governorate: 'baghdad', city: 'Baghdad', address_line: 'Karrada, street 62' },
  }, idem('ship'));
  assert.equal(shipment.status, 'awaiting_payment');
  assert.equal(shipment.fee_iqd, 5000);
  await ok(w.a, 'POST', `${API}/orders/${shipment.fee_order_id}/dev-pay`, {});
  assert.equal((await ok(w.a, 'GET', `${API}/shipments/${shipment.shipment_id}`)).status, 'preparing');
  await ok(w.assistant, 'POST', `${ADMIN}/shipments/${shipment.shipment_id}/advance`, { to: 'shipped', carrier: 'Al-Waseet', tracking_ref: 'AW-1' });
  await ok(w.assistant, 'POST', `${ADMIN}/shipments/${shipment.shipment_id}/advance`, { to: 'delivered' });
  // Printing hours never paid for delivery.
  assert.equal((await credits(w.a, cat.tier)).consumed_seconds, usedSeconds);
  assert.equal((await owned(w.a, cat.white)).available_qty, 490 - usedGrams, 'the unused PLA stays in the workshop, theirs');

  // ---- 12. Auditable: money, stock, credits and print events all on record.
  const actions = new Set(rows<{ action: string }>(w, "SELECT DISTINCT action FROM audit_log WHERE action LIKE 'print_cloud.%'").map((r) => r.action));
  for (const a of ['print_cloud.order.create', 'print_cloud.order.paid', 'print_cloud.job.confirm', 'print_cloud.job.approve', 'print_cloud.job.assign', 'print_cloud.job.start', 'print_cloud.job.complete', 'print_cloud.stock.receive', 'print_cloud.shipment.request', 'print_cloud.shipment.advance', 'print_cloud.agent.create']) {
    assert.ok(actions.has(a), `missing audit ${a}`);
  }
  const events = rows<{ event: string }>(w, 'SELECT event FROM pc_print_job_events WHERE job_id = ? ORDER BY rowid', jobs[0]).map((e) => e.event);
  assert.deepEqual(events, ['created', 'analysis_requested', 'estimate_recorded', 'reviewed', 'confirmed', 'approved', 'assigned', 'started', 'completion_reported', 'completed']);
  // The money view: cash collected vs revenue recognised.
  const revenue = await ok(w.full, 'GET', `${ADMIN}/reports/revenue?from=2000-01-01T00:00:00Z&to=2100-01-01T00:00:00Z`);
  assert.equal(revenue.cash_collected.total, 47500 + 8000 + 5000, JSON.stringify(revenue));
  assert.ok(revenue.recognised_revenue.printing_hours > 0 && revenue.deferred_liability_now.printing_hours > 0);
  const profit = await ok(w.owner, 'GET', `${ADMIN}/reports/profit?from=2000-01-01T00:00:00Z&to=2100-01-01T00:00:00Z`);
  assert.ok(profit.cost_of_material_used > 0);
  await reconcileClean(w);
});
