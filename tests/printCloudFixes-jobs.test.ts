/**
 * LEVONIS PRINT CLOUD — regression tests for the review findings of the
 * "jobs" cluster (settlement, approval, confirmation windows, estimates,
 * frozen project models, plate orientation). Each test failed before its fix.
 *
 * Run: node --import tsx --test tests/printCloudFixes-jobs.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN,
  API,
  buy,
  estimatedJob,
  idem,
  ok,
  owned,
  pcWorld,
  readyFile,
  reconcileClean,
  refused,
  row,
  rows,
  runToPrinting,
  seedCatalog,
} from './fixtures/printCloud';
import { HttpError } from '../worker/lib/http';
import { canTransition, parseEstimate } from '../worker/lib/printCloud/jobs';
import * as plates from '../worker/lib/printCloud/plates';

const H = 3600;

// ------------------------------------------------------------------ c0: one variant off the shelf twice in one batch

test('c0: a completion that used more than was reserved settles — billed and absorbed grams drawn one after the other, across lots', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  // Behind the seeded gold lot (100 g for 2,500 IQD) a second one: 500 g for 15,000 IQD.
  await ok(w.owner, 'POST', `${ADMIN}/stock/receive`, { variant_id: cat.gold, qty: 500, total_cost_iqd: 15000, supplier: 'Bambu Lab' }, idem('stock'));
  await buy(w.a, [
    { kind: 'credit_package', package_id: cat.packages.h6 },
    { kind: 'material', variant_id: cat.gold, quantity: 100 },
  ]);
  const { jobId } = await estimatedJob(w, w.a, cat, { seconds: H, materials: [{ variant_id: cat.gold, model_grams: 80 }] });
  await runToPrinting(w, w.a, jobId);

  // cap_at_reserved (the default): 80 g billed to the customer, the 50 g beyond the reservation absorbed by the workshop.
  const done = await ok(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/complete`, { printed_seconds: H, materials: [{ variant_id: cat.gold, qty: 130 }] });
  assert.deepEqual(done.materials, [{ variant_id: cat.gold, actual: 130, billed: 80, released: 0, workshop_absorbed: 50 }]);
  assert.equal(row(w, 'SELECT status FROM pc_print_jobs WHERE id = ?', jobId)?.status, 'completed');
  // FIFO across both parts: the customer's 80 g from the first lot (2,000 IQD), the workshop's 50 g as that lot's
  // last 20 g (500 IQD) plus 30 g of the second (900 IQD) — the first lot's draws sum to exactly what it cost.
  assert.deepEqual(rows(w, 'SELECT entry_type, delta_on_hand, delta_allocated, cost_iqd FROM pc_warehouse_ledger WHERE ref_id = ? ORDER BY rowid', jobId), [
    { entry_type: 'consume_customer', delta_on_hand: -80, delta_allocated: -80, cost_iqd: 2000 },
    { entry_type: 'consume_workshop', delta_on_hand: -50, delta_allocated: 0, cost_iqd: 1400 },
  ]);
  assert.deepEqual(rows(w, 'SELECT on_hand_qty FROM pc_stock_lots WHERE variant_id = ? ORDER BY received_at, id', cat.gold).map((l) => l.on_hand_qty), [0, 470]);
  assert.deepEqual(row(w, 'SELECT on_hand_qty, allocated_qty FROM pc_stock_positions WHERE variant_id = ?', cat.gold), { on_hand_qty: 470, allocated_qty: 20 });
  const gold = await owned(w.a, cat.gold);
  assert.deepEqual([gold.consumed_qty, gold.available_qty, gold.reserved_qty], [80, 20, 0]);
  assert.equal(row(w, "SELECT state FROM pc_printer_assignments WHERE job_id = ?", jobId)?.state, 'finished', 'the printer is free again');
  await reconcileClean(w);
});

test('c0: a model failure that reports more failed grams than were reserved resolves (billed up to the reservation, the rest absorbed)', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  await buy(w.a, [
    { kind: 'credit_package', package_id: cat.packages.h24 },
    { kind: 'material', variant_id: cat.white, quantity: 500 },
  ]);
  const { jobId } = await estimatedJob(w, w.a, cat, { seconds: 5 * H, materials: [{ variant_id: cat.white, model_grams: 100 }] });
  await runToPrinting(w, w.a, jobId);
  const fail = await ok(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/fail`, {
    reason_code: 'UNSUPPORTED_OVERHANG',
    responsible: 'model',
    printed_seconds: 2 * H,
    failed_materials: [{ variant_id: cat.white, qty: 120 }],
  });
  const r = await ok(w.assistant, 'POST', `${ADMIN}/failures/${fail.failure_id}/resolve`, { responsible: 'model', reprint: false });
  assert.equal(r.policy, 'charge_printed');
  assert.deepEqual(r.materials, [{ variant_id: cat.white, actual: 120, billed: 100, released: 0, workshop_absorbed: 20 }]);
  assert.deepEqual(rows(w, 'SELECT entry_type, delta_on_hand FROM pc_warehouse_ledger WHERE ref_id = ? ORDER BY rowid', jobId), [
    { entry_type: 'consume_customer', delta_on_hand: -100 },
    { entry_type: 'consume_workshop', delta_on_hand: -20 },
  ]);
  const white = await owned(w.a, cat.white);
  assert.deepEqual([white.consumed_qty, white.available_qty, white.reserved_qty], [100, 400, 0]);
  await reconcileClean(w);
});

// ------------------------------------------------------------------ c3: nothing reaches the queue unreserved

test('c3: an operator cannot approve a job the customer has not confirmed; a confirmed one is approved with its reservation', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  await buy(w.a, [
    { kind: 'credit_package', package_id: cat.packages.h6 },
    { kind: 'material', variant_id: cat.white, quantity: 250 },
  ]);
  const { jobId } = await estimatedJob(w, w.a, cat, { seconds: 5 * H, materials: [{ variant_id: cat.white, model_grams: 200 }] });
  await ok(w.a, 'POST', `${API}/jobs/${jobId}/review`);
  const r = await refused(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/approve`, undefined, 'INVALID_TRANSITION');
  assert.equal(r.details.from, 'awaiting_confirmation');
  assert.equal(row(w, 'SELECT status FROM pc_print_jobs WHERE id = ?', jobId)?.status, 'awaiting_confirmation');
  assert.equal(row(w, 'SELECT COUNT(*) AS n FROM pc_credit_reservations WHERE job_id = ?', jobId)?.n, 0);
  assert.equal(row(w, 'SELECT COUNT(*) AS n FROM pc_queue_entries WHERE job_id = ?', jobId)?.n, 0);
  assert.equal(canTransition('awaiting_confirmation', 'queued'), false, 'no edge skips the reserving confirmation');

  assert.equal((await ok(w.a, 'POST', `${API}/jobs/${jobId}/confirm`, undefined, idem('c'))).status, 'confirmed');
  await ok(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/approve`);
  assert.equal(row(w, 'SELECT status FROM pc_print_jobs WHERE id = ?', jobId)?.status, 'queued');
  assert.deepEqual(row(w, 'SELECT seconds_reserved, state FROM pc_credit_reservations WHERE job_id = ?', jobId), { seconds_reserved: 5 * H, state: 'active' });
  await refused(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/approve`, undefined, 'INVALID_TRANSITION');
  await reconcileClean(w);
});

test('c3: without operator approval a confirmation still passes through `confirmed`, reserved, in one batch', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w, { approval: false });
  await buy(w.a, [
    { kind: 'credit_package', package_id: cat.packages.h6 },
    { kind: 'material', variant_id: cat.white, quantity: 250 },
  ]);
  const { jobId } = await estimatedJob(w, w.a, cat, { seconds: 2 * H, materials: [{ variant_id: cat.white, model_grams: 50 }] });
  await ok(w.a, 'POST', `${API}/jobs/${jobId}/review`);
  assert.equal((await ok(w.a, 'POST', `${API}/jobs/${jobId}/confirm`, undefined, idem('c'))).status, 'queued');
  const events = rows(w, 'SELECT from_status, to_status, event FROM pc_print_job_events WHERE job_id = ? ORDER BY rowid', jobId).slice(-2);
  assert.deepEqual(events, [
    { from_status: 'awaiting_confirmation', to_status: 'confirmed', event: 'confirmed' },
    { from_status: 'confirmed', to_status: 'queued', event: 'queued_without_approval' },
  ]);
  const view = await ok(w.a, 'GET', `${API}/jobs/${jobId}`);
  assert.deepEqual(view.events.slice(-2).map((e: { event: string }) => e.event), ['confirmed', 'queued_without_approval'], 'the view keeps a batch in order');
  assert.equal(row(w, "SELECT state FROM pc_credit_reservations WHERE job_id = ?", jobId)?.state, 'active');
  assert.equal(row(w, "SELECT state FROM pc_queue_entries WHERE job_id = ?", jobId)?.state, 'waiting');
  await reconcileClean(w);
});

// ------------------------------------------------------------------ c9: the confirmation window

test('c9: an expired confirmation window is renewed by reviewing again — the measured estimate is kept', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  await buy(w.a, [
    { kind: 'credit_package', package_id: cat.packages.h6 },
    { kind: 'material', variant_id: cat.white, quantity: 250 },
  ]);
  const { jobId } = await estimatedJob(w, w.a, cat, { seconds: H, materials: [{ variant_id: cat.white, model_grams: 50 }] });
  const estimateId = row(w, 'SELECT estimate_id FROM pc_print_jobs WHERE id = ?', jobId)?.estimate_id;
  await ok(w.a, 'POST', `${API}/jobs/${jobId}/review`);
  w.raw.prepare('UPDATE pc_print_jobs SET confirmation_expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', jobId);

  const expired = await refused(w.a, 'POST', `${API}/jobs/${jobId}/confirm`, undefined, 'QUOTE_EXPIRED', idem('c'));
  const again = await ok(w.a, 'POST', `${API}/jobs/${jobId}/review`);
  assert.equal(expired.details.action, 'review_again', 'the refusal says how to go on');
  assert.equal(again.status, 'awaiting_confirmation');
  assert.equal(again.sufficient, true);
  assert.ok(again.confirmation_expires_at > new Date().toISOString(), 'a fresh window');
  assert.equal((await ok(w.a, 'POST', `${API}/jobs/${jobId}/confirm`, undefined, idem('c2'))).status, 'confirmed');
  assert.equal(row(w, 'SELECT estimate_id FROM pc_print_jobs WHERE id = ?', jobId)?.estimate_id, estimateId, 'nothing was re-sliced');
  assert.deepEqual(rows(w, 'SELECT variant_id, kind, qty FROM pc_job_requirements WHERE job_id = ?', jobId), [{ variant_id: cat.white, kind: 'filament', qty: 50 }]);
  assert.ok(rows(w, 'SELECT event FROM pc_print_job_events WHERE job_id = ?', jobId).some((e) => e.event === 'review_renewed'));
  await reconcileClean(w);
});

test('c9: a free reprint whose automatic confirmation is refused waits in `ready`, not in an expiring review', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  await buy(w.a, [
    { kind: 'credit_package', package_id: cat.packages.h6 },
    { kind: 'material', variant_id: cat.white, quantity: 500 },
  ]);
  const { jobId } = await estimatedJob(w, w.a, cat, { seconds: 5 * H, materials: [{ variant_id: cat.white, model_grams: 100 }] });
  const { jobId: other } = await estimatedJob(w, w.a, cat, { seconds: 2 * H, materials: [{ variant_id: cat.white, model_grams: 10 }], title: 'Other' });
  await runToPrinting(w, w.a, jobId);
  await ok(w.a, 'POST', `${API}/jobs/${other}/review`);
  const fail = await ok(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/fail`, {
    reason_code: 'NOZZLE_CLOG',
    responsible: 'workshop',
    printed_seconds: H,
    failed_materials: [{ variant_id: cat.white, qty: 30 }],
  });
  // While the reprint is being reviewed on the customer's behalf, the customer confirms another job with the hours.
  w.race.when = (sqls) => sqls.some((s) => s.includes('confirmation_expires_at = ?'));
  w.race.hook = async () => {
    await ok(w.a, 'POST', `${API}/jobs/${other}/confirm`, undefined, idem('other'));
  };
  const resolved = await ok(w.assistant, 'POST', `${ADMIN}/failures/${fail.failure_id}/resolve`, { responsible: 'workshop', reprint: true });
  assert.equal(w.race.hook, null, 'the competing confirmation ran');
  assert.equal(resolved.reprint_status, 'waiting_for_customer');
  assert.deepEqual(row(w, 'SELECT status, confirmation_expires_at FROM pc_print_jobs WHERE id = ?', resolved.reprint_job_id), { status: 'ready', confirmation_expires_at: null });
  assert.equal(row(w, 'SELECT COUNT(*) AS n FROM pc_credit_reservations WHERE job_id = ?', resolved.reprint_job_id)?.n, 0);
  assert.equal(row(w, 'SELECT status FROM pc_print_jobs WHERE id = ?', other)?.status, 'confirmed');
  await reconcileClean(w);
});

// ------------------------------------------------------------------ c26: one variant listed twice in an estimate

test('c26: an estimate that lists one variant twice (two slots, one spool) is summed, not refused as a retryable conflict', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const fileId = await readyFile(w, w.a);
  const project = await ok(w.a, 'POST', `${API}/projects`, { name: 'Two slots' });
  await ok(w.a, 'POST', `${API}/projects/${project.project_id}/models`, {
    file_id: fileId,
    material_assignments: [
      { part: 'body', variant_id: cat.white },
      { part: 'base', variant_id: cat.white },
    ],
  });
  const job = await ok(w.a, 'POST', `${API}/jobs`, { project_id: project.project_id, printer_model_id: cat.model });
  await ok(w.a, 'POST', `${API}/jobs/${job.job_id}/analyze`);
  const est = await ok(w.assistant, 'POST', `${ADMIN}/jobs/${job.job_id}/estimate`, {
    duration_seconds: 3600,
    materials: [
      { variant_id: cat.white, model_grams: 20, support_grams: 2 },
      { variant_id: cat.white, model_grams: 10, purge_grams: 1 },
    ],
  });
  assert.equal(est.status, 'ready');
  assert.deepEqual(rows(w, 'SELECT variant_id, model_grams, support_grams, purge_grams FROM pc_estimate_materials WHERE estimate_id = ?', est.estimate_id), [
    { variant_id: cat.white, model_grams: 30, support_grams: 2, purge_grams: 1 },
  ]);
  assert.deepEqual(row(w, 'SELECT model_grams, support_grams, purge_grams FROM pc_estimates WHERE id = ?', est.estimate_id), { model_grams: 30, support_grams: 2, purge_grams: 1 });
  assert.deepEqual(rows(w, "SELECT variant_id, qty FROM pc_job_requirements WHERE job_id = ? AND kind = 'filament'", job.job_id), [{ variant_id: cat.white, qty: 33 }]);

  // The limit holds for the sum, not only for each line.
  assert.throws(
    () => parseEstimate({ duration_seconds: 60, materials: [{ variant_id: 'v', model_grams: 600_000 }, { variant_id: 'v', model_grams: 600_000 }] }),
    (e: unknown) => e instanceof HttpError && e.code === 'VALIDATION'
  );
});

// ------------------------------------------------------------------ c4: a job prints what it was estimated on

test('c4: a job prints the models it was estimated on — they cannot change from analysis until the print is over', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  await buy(w.a, [
    { kind: 'credit_package', package_id: cat.packages.h6 },
    { kind: 'material', variant_id: cat.white, quantity: 250 },
  ]);
  const cube = await readyFile(w, w.a, [10, 10, 10], 'cube.stl');
  const big = await readyFile(w, w.a, [200, 200, 200], 'big.stl');
  const { jobId, projectId } = await estimatedJob(w, w.a, cat, { seconds: H, materials: [{ variant_id: cat.white, model_grams: 5 }], fileId: cube });
  const modelId = (await ok(w.a, 'GET', `${API}/projects/${projectId}`)).models[0].id;
  const swap = { file_id: big, quantity: 50 };
  const modelPath = `${API}/projects/${projectId}/models/${modelId}`;

  // Estimated: what was measured is what the customer will confirm.
  const r = await refused(w.a, 'PATCH', modelPath, swap, 'INVALID_TRANSITION');
  assert.equal(r.details.reason, 'project_models_in_use');
  assert.equal(r.details.job_id, jobId);
  await ok(w.a, 'PATCH', modelPath, { name: 'Cube v2' }); // a name prints nothing
  await ok(w.a, 'POST', `${API}/jobs/${jobId}/review`);
  await ok(w.a, 'POST', `${API}/jobs/${jobId}/confirm`, undefined, idem('c'));
  await ok(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/approve`);
  // Confirmed and queued: no swap, no extra model, and the sliced file stays undeletable.
  await refused(w.a, 'PATCH', modelPath, swap, 'INVALID_TRANSITION');
  await refused(w.a, 'PATCH', modelPath, { transform: { rotation_x_mdeg: 90_000 } }, 'INVALID_TRANSITION');
  await refused(w.a, 'POST', `${API}/projects/${projectId}/models`, { file_id: big, material_assignments: [{ variant_id: cat.white }] }, 'INVALID_TRANSITION');
  assert.deepEqual(row(w, 'SELECT file_id, quantity, name FROM pc_project_models WHERE id = ?', modelId), { file_id: cube, quantity: 1, name: 'Cube v2' });
  assert.equal(row(w, 'SELECT COUNT(*) AS n FROM pc_project_models WHERE project_id = ?', projectId)?.n, 1);
  await refused(w.a, 'DELETE', `${API}/files/${cube}`, undefined, 'INVALID_TRANSITION');
  // Once the job no longer prints them, the models are the customer's to change again.
  await ok(w.a, 'POST', `${API}/jobs/${jobId}/cancel`, { reason: 'changing the model' });
  await ok(w.a, 'PATCH', modelPath, swap);
  await reconcileClean(w);
});

test('c4: an edit that lands between reading the models and committing the analysis makes the analysis fail, not slice stale files', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const fileId = await readyFile(w, w.a);
  const project = await ok(w.a, 'POST', `${API}/projects`, { name: 'Race' });
  const model = await ok(w.a, 'POST', `${API}/projects/${project.project_id}/models`, { file_id: fileId, material_assignments: [{ variant_id: cat.white }] });
  const job = await ok(w.a, 'POST', `${API}/jobs`, { project_id: project.project_id, printer_model_id: cat.model });
  w.race.when = (sqls) => sqls.some((s) => s.includes('INSERT INTO pc_slicing_requests'));
  w.race.hook = async () => {
    await ok(w.a, 'PATCH', `${API}/projects/${project.project_id}/models/${model.project_model_id}`, { quantity: 5 });
  };
  await refused(w.a, 'POST', `${API}/jobs/${job.job_id}/analyze`, undefined, 'STATE_CHANGED');
  assert.equal(w.race.hook, null, 'the competing edit ran');
  assert.equal(row(w, 'SELECT status FROM pc_print_jobs WHERE id = ?', job.job_id)?.status, 'uploaded');
  assert.equal(row(w, 'SELECT COUNT(*) AS n FROM pc_slicing_requests WHERE job_id = ?', job.job_id)?.n, 0);
  // Asked again, the slicer gets the models as they are.
  const again = await ok(w.a, 'POST', `${API}/jobs/${job.job_id}/analyze`);
  const input = JSON.parse(String(row(w, 'SELECT input_json FROM pc_slicing_requests WHERE id = ?', again.slicing_request_id)?.input_json));
  assert.equal(input.models[0].quantity, 5);
});

// ------------------------------------------------------------------ c23: plates and the model's own rotation

test('c23: the oriented footprint turns the box by X, Y and Z — quarter turns exactly, other angles as an outer bound', () => {
  const box = { x_um: 20_000, y_um: 30_000, z_um: 250_000 };
  assert.deepEqual(plates.orientedFootprint(box, {}), box);
  assert.deepEqual(plates.orientedFootprint(box, { x_mdeg: 90_000 }), { x_um: 20_000, y_um: 250_000, z_um: 30_000 });
  assert.deepEqual(plates.orientedFootprint(box, { y_mdeg: -90_000 }), { x_um: 250_000, y_um: 30_000, z_um: 20_000 });
  assert.deepEqual(plates.orientedFootprint(box, { z_mdeg: 90_000 }), { x_um: 30_000, y_um: 20_000, z_um: 250_000 });
  assert.deepEqual(plates.orientedFootprint(box, { x_mdeg: 90_000, z_mdeg: 90_000 }), { x_um: 250_000, y_um: 20_000, z_um: 30_000 });
  assert.deepEqual(plates.orientedFootprint({ x_um: 10_000, y_um: 10_000, z_um: 10_000 }, { z_mdeg: 45_000 }), { x_um: 14_143, y_um: 14_143, z_um: 10_000 });
});

test('c23: a plate is checked with each model as it stands — laid flat is checked flat, auto-oriented is not checkable', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const pillar = await readyFile(w, w.a, [20, 20, 250], 'pillar.stl');
  const shortPillar = await readyFile(w, w.a, [20, 20, 200], 'short-pillar.stl');
  const project = await ok(w.a, 'POST', `${API}/projects`, { name: 'Pillars' });
  const platesPath = `${API}/projects/${project.project_id}/plates`;
  const flat = await ok(w.a, 'POST', `${API}/projects/${project.project_id}/models`, {
    file_id: pillar,
    quantity: 2,
    transform: { rotation_x_mdeg: 90_000 },
    material_assignments: [{ variant_id: cat.white }],
  });
  // Laid flat the pillar covers 20 × 250 mm: at y = 60 and 200 mm the two overlap and both leave the 256 mm bed.
  const manual = await ok(w.a, 'POST', platesPath, {
    printer_model_id: cat.model,
    placements: [
      { project_model_id: flat.project_model_id, x_um: 50_000, y_um: 60_000 },
      { project_model_id: flat.project_model_id, x_um: 50_000, y_um: 200_000 },
    ],
  });
  assert.equal(manual.valid, false);
  assert.deepEqual(manual.issues.map((i: { code: string }) => i.code).sort(), ['COLLISION', 'OUT_OF_BED', 'OUT_OF_BED']);
  await refused(w.a, 'POST', `${API}/jobs`, { project_id: project.project_id, printer_model_id: cat.model, plate_id: manual.plate_id }, 'VALIDATION');

  // The arranger packs the part as it lies: every stored instance, read as the 20 × 200 × 20 mm part it is, fits and touches nothing.
  const short = await ok(w.a, 'POST', `${API}/projects/${project.project_id}/models`, {
    file_id: shortPillar,
    quantity: 2,
    transform: { rotation_x_mdeg: 90_000 },
    material_assignments: [{ variant_id: cat.white }],
  });
  const arranged = await ok(w.a, 'POST', platesPath, { printer_model_id: cat.model, arrange: true, instances: [{ project_model_id: short.project_model_id, count: 2 }] });
  assert.equal(arranged.valid, true);
  assert.equal(arranged.placed, 2);
  const items = rows(w, 'SELECT instance_no, x_um, y_um, rotation_z_mdeg, scale_ppm FROM pc_plate_items WHERE plate_id = ?', arranged.plate_id);
  const lying = { x_um: 20_000, y_um: 200_000, z_um: 20_000 };
  assert.deepEqual(
    plates.validatePlacements(
      items.map((it) => ({ key: String(it.instance_no), x_um: it.x_um, y_um: it.y_um, rotation_z_mdeg: it.rotation_z_mdeg, scale_ppm: it.scale_ppm, footprint: lying })),
      { x_um: 256_000, y_um: 256_000, z_um: 256_000 },
      5000
    ),
    []
  );

  // An auto-oriented model's footprint is unknown until it is sliced: no plate can vouch for it.
  const auto = await ok(w.a, 'POST', `${API}/projects/${project.project_id}/models`, {
    file_id: shortPillar,
    transform: { orientation: 'auto' },
    material_assignments: [{ variant_id: cat.white }],
  });
  const unknown = await ok(w.a, 'POST', platesPath, { printer_model_id: cat.model, placements: [{ project_model_id: auto.project_model_id, x_um: 128_000, y_um: 128_000 }] });
  assert.equal(unknown.valid, false);
  assert.deepEqual(unknown.issues, [{ code: 'ORIENTATION_UNKNOWN', keys: [`${auto.project_model_id}#1`] }]);

  // A job that auto-orients cannot keep a plate's layout either; as placed, the arranged plate is accepted.
  const r = await refused(
    w.a,
    'POST',
    `${API}/jobs`,
    { project_id: project.project_id, printer_model_id: cat.model, plate_id: arranged.plate_id, settings: { orientation: 'auto' } },
    'VALIDATION'
  );
  assert.equal(r.details.reason, 'plate_needs_fixed_orientation');
  assert.equal((await ok(w.a, 'POST', `${API}/jobs`, { project_id: project.project_id, printer_model_id: cat.model, plate_id: arranged.plate_id })).status, 'uploaded');
});

test('c23: a plate checked upright stops vouching for the model once the model is turned', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const pillar = await readyFile(w, w.a, [20, 20, 250], 'pillar.stl');
  const project = await ok(w.a, 'POST', `${API}/projects`, { name: 'Upright' });
  const model = await ok(w.a, 'POST', `${API}/projects/${project.project_id}/models`, { file_id: pillar, quantity: 2, material_assignments: [{ variant_id: cat.white }] });
  const plate = await ok(w.a, 'POST', `${API}/projects/${project.project_id}/plates`, {
    printer_model_id: cat.model,
    placements: [
      { project_model_id: model.project_model_id, x_um: 50_000, y_um: 60_000 },
      { project_model_id: model.project_model_id, x_um: 50_000, y_um: 200_000 },
    ],
  });
  assert.equal(plate.valid, true, 'standing up, two 20 × 20 mm footprints far apart');
  await ok(w.a, 'PATCH', `${API}/projects/${project.project_id}/models/${model.project_model_id}`, { transform: { rotation_x_mdeg: 90_000 } });
  await refused(w.a, 'POST', `${API}/jobs`, { project_id: project.project_id, printer_model_id: cat.model, plate_id: plate.plate_id }, 'VALIDATION');
  const view = await ok(w.a, 'GET', `${API}/projects/${project.project_id}`);
  assert.equal(view.plates[0].valid, 0);
  assert.deepEqual(view.plates[0].issues, [{ code: 'MODEL_CHANGED', keys: [model.project_model_id] }]);
});
