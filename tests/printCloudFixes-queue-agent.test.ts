/**
 * LEVONIS PRINT CLOUD — the queue and the workshop agent, as the review found
 * them broken (docs/PRINT_CLOUD.md §7.5, §9). Each test is the reviewer's
 * reproduction, on real records through the real routers:
 *
 *   - the quarter-hour pass walks the whole queue: a head of jobs no machine
 *     can take neither eats its share nor hides the job behind it (c6);
 *   - a dependency is met by its reprint, and a dependency that can never be
 *     met releases the job waiting on it (c10);
 *   - an agent printer that is unreachable or running its own print gets no
 *     work (c12);
 *   - a job cancelled mid-pass does not abort the pass (c21);
 *   - a late or buffered reading never replaces a newer one nor passes for
 *     live (c11);
 *   - a re-sent or late agent event changes nothing (c22);
 *   - idle counts mean what the scheduler means (c24);
 *   - a telemetry-only token reads no customer file (c25);
 *   - a slicer token that never connected is not «connected» (c28).
 *
 * Run: node --import tsx --test tests/printCloudFixes-queue-agent.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN,
  AGENT,
  API,
  buy,
  call,
  credits,
  estimatedJob,
  idem,
  ok,
  pcWorld,
  readyFile,
  reconcileClean,
  refused,
  row,
  rows,
  runToPrinting,
  seedCatalog,
  type Catalog,
  type Json,
  type World,
} from './fixtures/printCloud';
import type { App } from './fixtures/app';
import { printCloudTick } from '../worker/lib/printCloud/background';
import { countingD1 } from '../worker/lib/d1Count';
import { PRINT_CLOUD_TICK_BUDGET } from '../worker/lib/quarterHourBudget';

const H = 3600;

/** A confirmed job in the queue (approval off): one hour, 20 g of white. */
async function queuedJob(w: World, app: App, cat: Catalog, title = 'Part'): Promise<string> {
  const { jobId } = await estimatedJob(w, app, cat, { seconds: H, materials: [{ variant_id: cat.white, model_grams: 20 }], title });
  await ok(app, 'POST', `${API}/jobs/${jobId}/review`);
  assert.equal((await ok(app, 'POST', `${API}/jobs/${jobId}/confirm`, undefined, idem('confirm'))).status, 'queued');
  return jobId;
}

/** Like `queuedJob`, for a job that waits for `dependsOn`. */
async function queuedJobAfter(w: World, app: App, cat: Catalog, dependsOn: string): Promise<string> {
  const fileId = await readyFile(w, app);
  const project = await ok(app, 'POST', `${API}/projects`, { name: 'Lid', project_type: 'figure' });
  await ok(app, 'POST', `${API}/projects/${project.project_id}/models`, { file_id: fileId, quantity: 1, material_assignments: [{ part: 'default', variant_id: cat.white }] });
  const job = await ok(app, 'POST', `${API}/jobs`, { project_id: project.project_id, printer_model_id: cat.model, title: 'Lid', depends_on_job_id: dependsOn });
  await ok(app, 'POST', `${API}/jobs/${job.job_id}/analyze`);
  await ok(w.assistant, 'POST', `${ADMIN}/jobs/${job.job_id}/estimate`, { duration_seconds: H, materials: [{ variant_id: cat.white, model_grams: 20 }], slicer_name: 'OrcaSlicer' });
  await ok(app, 'POST', `${API}/jobs/${job.job_id}/review`);
  assert.equal((await ok(app, 'POST', `${API}/jobs/${job.job_id}/confirm`, undefined, idem('confirm'))).status, 'queued');
  return job.job_id;
}

/** `n` queued copies of `jobId` at `priority`, sliced for a 0.6 mm nozzle no machine of the workshop carries. */
function unplaceableCopies(w: World, jobId: string, n: number, priority: number): void {
  const job = w.raw.prepare('INSERT INTO pc_print_jobs (id, user_id, project_id, plate_id, printer_model_id, tier_id, title, status, settings_json, copies, estimate_id, priority, needs_operator_approval, operator_instructions_json, queued_at, op_token, created_at, updated_at) SELECT ?, user_id, project_id, plate_id, printer_model_id, tier_id, title, \'queued\', json_set(settings_json, \'$.nozzle_um\', 600), copies, estimate_id, ?, 0, operator_instructions_json, queued_at, ?, created_at, updated_at FROM pc_print_jobs WHERE id = ?');
  const entry = w.raw.prepare("INSERT INTO pc_queue_entries (id, job_id, priority, enqueued_at, state, updated_at) VALUES (?, ?, ?, '2000-01-01T00:00:00.000Z', 'waiting', '2000-01-01T00:00:00.000Z')");
  for (let i = 0; i < n; i++) {
    const id = `pcj_wide_${String(i).padStart(4, '0')}`;
    job.run(id, priority, `tok_wide_${i}`, jobId);
    entry.run(`pcqe_wide_${i}`, id, priority);
  }
}

/** An agent with these capabilities, bound to `printerId`; the other machine of the model is put in maintenance. */
async function agentOn(w: World, cat: Catalog, capabilities: string[], printerId = cat.printers[0]): Promise<{ id: string; bearer: Record<string, string> }> {
  const agent = await ok(w.full, 'POST', `${ADMIN}/agents`, { name: 'Bay 1', capabilities });
  await ok(w.owner, 'PATCH', `${ADMIN}/catalog/printers/${printerId}`, { adapter: 'agent', agent_id: agent.agent_id, connection_ref: 'lan-1' });
  for (const p of cat.printers.filter((x) => x !== printerId)) await ok(w.owner, 'PATCH', `${ADMIN}/catalog/printers/${p}`, { status: 'maintenance' });
  return { id: agent.agent_id, bearer: { Authorization: `Bearer ${agent.token}` } };
}

const status = (w: World, jobId: string) => row(w, 'SELECT status FROM pc_print_jobs WHERE id = ?', jobId)?.status;

test('c6: the cron pass walks past a head of jobs no machine can take: the job behind them is placed and the task ends inside its share', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w, { approval: false });
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h24 }, { kind: 'material', variant_id: cat.white, quantity: 500 }]);
  const fits = await queuedJob(w, w.a, cat);
  // Thirty higher-priority jobs ahead of it that need a nozzle no machine has; both machines idle.
  unplaceableCopies(w, fits, 30, 5);
  await w.runTasks(0);
  const counted = countingD1(w.db);
  const env = { DB: counted.db, BUCKET: w.bucket, R2_PRIVATE: w.bucket } as never;
  const spent: number[] = [];
  for (let i = 0; i < 2; i++) {
    const before = counted.executed;
    await printCloudTick(env, { budget: PRINT_CLOUD_TICK_BUDGET, used: () => counted.executed });
    spent.push(counted.executed - before);
  }
  assert.equal(status(w, fits), 'preparing', 'the compatible job behind the head was placed by the cron');
  for (const n of spent) assert.ok(n <= PRINT_CLOUD_TICK_BUDGET, `a tick spent ${n} of ${PRINT_CLOUD_TICK_BUDGET} (${spent.join(', ')})`);
  // The pass ended: no schedule_queue task loops on, holding the head of every later tick.
  assert.deepEqual(rows(w, "SELECT status FROM pc_background_jobs WHERE kind = 'schedule_queue'").map((r) => r.status), ['succeeded']);
  assert.equal(Number(row(w, "SELECT COUNT(*) AS n FROM pc_print_jobs WHERE status = 'queued'")?.n), 30, 'the unplaceable jobs still wait, untouched');
});

test('c6: a pass reads the queue a page at a time to its end: 250 unplaceable jobs ahead do not hide the one that fits', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w, { approval: false });
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h6 }, { kind: 'material', variant_id: cat.white, quantity: 250 }]);
  const fits = await queuedJob(w, w.a, cat);
  unplaceableCopies(w, fits, 250, 5);
  const run = await ok(w.assistant, 'POST', `${ADMIN}/queue/run`);
  assert.equal(run.assigned.length, 1, JSON.stringify(run).slice(0, 300));
  assert.equal(run.assigned[0].job_id, fits);
  assert.equal(run.waiting, 250);
  assert.equal(run.more, false);
});

test('c10: a dependency is met by its reprint: the job waiting on a failed print runs once the reprint completes', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w, { approval: false });
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h24 }, { kind: 'material', variant_id: cat.white, quantity: 500 }]);
  // A prints; B waits for A.
  const a = await queuedJob(w, w.a, cat, 'Base');
  await ok(w.assistant, 'POST', `${ADMIN}/jobs/${a}/assign`, { printer_id: cat.printers[0] });
  await ok(w.assistant, 'POST', `${ADMIN}/jobs/${a}/start`);
  const b = await queuedJobAfter(w, w.a, cat, a);
  assert.deepEqual((await ok(w.assistant, 'POST', `${ADMIN}/queue/run`)).assigned, [], 'B waits for A');
  // A fails by the workshop's fault; its free reprint is queued, printed and completed.
  const fail = await ok(w.assistant, 'POST', `${ADMIN}/jobs/${a}/fail`, { reason_code: 'NOZZLE_CLOG', responsible: 'workshop', printed_seconds: 600 });
  const resolved = await ok(w.assistant, 'POST', `${ADMIN}/failures/${fail.failure_id}/resolve`, { responsible: 'workshop', reprint: true });
  assert.equal(resolved.reprint_status, 'queued');
  const reprint = resolved.reprint_job_id as string;
  const first = await ok(w.assistant, 'POST', `${ADMIN}/queue/run`);
  assert.deepEqual(first.assigned.map((x: Json) => x.job_id), [reprint], 'the reprint runs; B still waits for it');
  await ok(w.assistant, 'POST', `${ADMIN}/jobs/${reprint}/start`);
  await ok(w.assistant, 'POST', `${ADMIN}/jobs/${reprint}/complete`, { printed_seconds: H, materials: [{ variant_id: cat.white, qty: 20 }] });
  assert.equal(status(w, a), 'reprint_requested');
  const second = await ok(w.assistant, 'POST', `${ADMIN}/queue/run`);
  assert.deepEqual(second.assigned.map((x: Json) => x.job_id), [b], 'the reprint completed: what B waited for is made');
});

test('c10: a dependency that can no longer complete releases the job waiting on it: cancelled, every reservation back, the customer told', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w, { approval: false });
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h24 }, { kind: 'material', variant_id: cat.white, quantity: 500 }]);
  // D waits for C; C is cancelled. The customer's queue says so, and the next pass releases D.
  const c = await queuedJob(w, w.a, cat, 'Cap');
  const d = await queuedJobAfter(w, w.a, cat, c);
  await ok(w.a, 'POST', `${API}/jobs/${c}/cancel`, { reason: 'changed my mind' });
  const queue = await ok(w.a, 'GET', `${API}/queue`);
  assert.equal(queue.jobs.find((j: Json) => j.job_id === d)?.basis, 'dependency_cannot_complete');
  const reservedBefore = (await credits(w.a, cat.tier)).reserved_seconds;
  const third = await ok(w.assistant, 'POST', `${ADMIN}/queue/run`);
  assert.deepEqual(third.released, [d]);
  assert.equal(status(w, d), 'cancelled');
  assert.equal(row(w, 'SELECT state FROM pc_credit_reservations WHERE job_id = ?', d)?.state, 'released', 'its hours are given back');
  assert.equal((await credits(w.a, cat.tier)).reserved_seconds, reservedBefore - H);
  assert.equal(row(w, "SELECT state FROM pc_inventory_reservations WHERE ref_id = ?", d)?.state, 'released', 'and its grams');
  assert.ok(
    row(w, "SELECT id FROM user_notifications WHERE user_id = 'usr_pc_a' AND kind = 'print_cloud' AND entity_id = ? AND json_extract(meta, '$.notice') = 'job_cancelled'", d),
    'the customer is told'
  );
  await refused(w.assistant, 'POST', `${ADMIN}/jobs/${d}/assign`, { printer_id: cat.printers[1] }, 'INVALID_TRANSITION');
  // A failure closed without a reprint is as final: F, waiting for E, is released the same way.
  const e = await queuedJob(w, w.a, cat, 'Hinge');
  const f = await queuedJobAfter(w, w.a, cat, e);
  await ok(w.assistant, 'POST', `${ADMIN}/jobs/${e}/assign`, { printer_id: cat.printers[0] });
  await ok(w.assistant, 'POST', `${ADMIN}/jobs/${e}/start`);
  const fail = await ok(w.assistant, 'POST', `${ADMIN}/jobs/${e}/fail`, { reason_code: 'WARPING', responsible: 'model', printed_seconds: 600 });
  assert.deepEqual((await ok(w.assistant, 'POST', `${ADMIN}/queue/run`)).released, [], 'an open failure may still be reprinted: F waits');
  await ok(w.assistant, 'POST', `${ADMIN}/failures/${fail.failure_id}/resolve`, { responsible: 'model', reprint: false });
  assert.deepEqual((await ok(w.assistant, 'POST', `${ADMIN}/queue/run`)).released, [f]);
  assert.equal(status(w, f), 'cancelled');
  await reconcileClean(w);
});

test('c12: an agent printer whose fresh reading says offline, printing, paused or preparing gets no work', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w, { approval: false });
  const agent = await agentOn(w, cat, ['telemetry', 'job_control']);
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h6 }, { kind: 'material', variant_id: cat.white, quantity: 250 }]);
  const jobId = await queuedJob(w, w.a, cat);
  const telemetry = (body: Json) => ok(w.guest, 'POST', `${AGENT}/printers/${cat.printers[0]}/telemetry`, body, agent.bearer);
  for (const machine_state of ['offline', 'printing', 'paused', 'preparing']) {
    await telemetry({ machine_state, ...(machine_state === 'offline' ? {} : { job_id: 'sd-card-print' }) });
    assert.deepEqual((await ok(w.assistant, 'POST', `${ADMIN}/queue/run`)).assigned, [], `a machine reporting ${machine_state} gets no work`);
    const verdict = await call(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/assign`, { printer_id: cat.printers[0] });
    assert.ok(verdict.status >= 400, `an operator cannot assign it either (${machine_state})`);
    assert.equal(verdict.json.code, machine_state === 'offline' ? 'INCOMPATIBLE_PRINTER' : 'PRINTER_BUSY');
  }
  await telemetry({ machine_state: 'offline' });
  const view = (await ok(w.assistant, 'GET', `${ADMIN}/printers`)).find((p: Json) => p.id === cat.printers[0]);
  assert.equal(view.connectivity, 'offline', 'an unreachable machine is not shown online');
  // Reachable and idle again: it takes the job.
  await telemetry({ machine_state: 'idle' });
  assert.deepEqual((await ok(w.assistant, 'POST', `${ADMIN}/queue/run`)).assigned, [{ job_id: jobId, printer_id: cat.printers[0] }]);
});

test('c21: a job cancelled while the pass runs is skipped; the pass still places the jobs after it', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w, { approval: false });
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h24 }, { kind: 'material', variant_id: cat.white, quantity: 500 }]);
  const jobs = [await queuedJob(w, w.a, cat, 'J0'), await queuedJob(w, w.a, cat, 'J1'), await queuedJob(w, w.a, cat, 'J2')];
  jobs.forEach((id, i) => w.raw.prepare('UPDATE pc_print_jobs SET priority = ? WHERE id = ?').run(3 - i, id));
  // Just before the first assignment lands, the customer cancels J1.
  w.race.when = (sqls) => sqls.some((s) => s.includes('INSERT INTO pc_printer_assignments'));
  w.race.hook = async () => {
    await ok(w.a, 'POST', `${API}/jobs/${jobs[1]}/cancel`, { reason: 'not needed' });
  };
  const run = await call(w.assistant, 'POST', `${ADMIN}/queue/run`);
  assert.equal(run.status, 200, JSON.stringify(run.json).slice(0, 300));
  assert.deepEqual(run.json.data.assigned.map((a: Json) => a.job_id), [jobs[0], jobs[2]]);
  assert.equal(run.json.data.waiting, 0, 'a cancelled job is not waiting');
  assert.deepEqual(jobs.map((id) => status(w, id)), ['preparing', 'cancelled', 'preparing']);
});

test('c21: a job an operator assigns while the pass runs is skipped, not a 409', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w, { approval: false });
  const third = await ok(w.owner, 'POST', `${ADMIN}/catalog/printers`, {
    model_id: cat.model,
    name: 'X2D #3',
    serial_number: 'SN-X2D-0003',
    equipment_code: 'LEV-X2D-03',
    nozzle_um: 400,
    ams_slots: 4,
    materials_json: ['PLA', 'PETG'],
  });
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h24 }, { kind: 'material', variant_id: cat.white, quantity: 500 }]);
  const jobs = [await queuedJob(w, w.a, cat, 'J0'), await queuedJob(w, w.a, cat, 'J1'), await queuedJob(w, w.a, cat, 'J2')];
  jobs.forEach((id, i) => w.raw.prepare('UPDATE pc_print_jobs SET priority = ? WHERE id = ?').run(3 - i, id));
  // Just before the first assignment lands, an operator puts J1 on the third machine by hand; a machine is still free for it.
  w.race.when = (sqls) => sqls.some((s) => s.includes('INSERT INTO pc_printer_assignments'));
  w.race.hook = async () => {
    await ok(w.assistant, 'POST', `${ADMIN}/jobs/${jobs[1]}/assign`, { printer_id: third.id });
  };
  const run = await call(w.assistant, 'POST', `${ADMIN}/queue/run`);
  assert.equal(run.status, 200, JSON.stringify(run.json).slice(0, 300));
  assert.deepEqual(jobs.map((id) => status(w, id)), ['preparing', 'preparing', 'preparing']);
  assert.equal(row(w, "SELECT printer_id FROM pc_printer_assignments WHERE job_id = ? AND state = 'active'", jobs[1])?.printer_id, third.id, 'J1 stays where the operator put it');
  assert.deepEqual(run.json.data.assigned.map((a: Json) => a.job_id), [jobs[0], jobs[2]]);
  assert.equal(run.json.data.waiting, 0, 'a job that left the queue is not waiting');
});

test('c11: a reading is dated by when it was taken: a buffered one is stale, and an older one never replaces a newer one', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w, { approval: false });
  const agent = await agentOn(w, cat, ['telemetry', 'job_control']);
  const telemetry = (body: Json) => ok(w.guest, 'POST', `${AGENT}/printers/${cat.printers[0]}/telemetry`, body, agent.bearer);
  const view = async () => (await ok(w.assistant, 'GET', `${ADMIN}/printers`)).find((p: Json) => p.id === cat.printers[0]);
  const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();
  // A reading flushed two hours late is stored, and shown for what it is: stale.
  assert.equal((await telemetry({ machine_state: 'idle', reported_at: ago(2 * H) })).stored, true);
  const buffered = await view();
  assert.equal(buffered.telemetry.stale, true);
  assert.equal(buffered.telemetry.live, false);
  assert.equal(buffered.connectivity, 'offline');
  // The machine faults now; then a reading from two hours ago arrives.
  await telemetry({ machine_state: 'error', errors: [{ code: 'HMS_0300', message: 'nozzle' }], reported_at: ago(0) });
  const late = await telemetry({ machine_state: 'idle', reported_at: ago(2 * H) });
  assert.deepEqual([late.stored, late.superseded], [false, true]);
  const current = await view();
  assert.equal(current.telemetry.machine_state, 'error', 'the error stands');
  assert.deepEqual(current.telemetry.errors.map((e: Json) => e.code), ['HMS_0300']);
  assert.equal(current.telemetry.live, true);
  // The buffered reading itself arrived a moment before: the CONNECTION was never silent, so nothing was
  // «restored» — and the superseded late copy records nothing either.
  assert.equal(rows(w, "SELECT id FROM pc_printer_events WHERE printer_id = ? AND kind = 'connection_restored'", cat.printers[0]).length, 0, 'a superseded reading records nothing');
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h6 }, { kind: 'material', variant_id: cat.white, quantity: 250 }]);
  await queuedJob(w, w.a, cat);
  assert.deepEqual((await ok(w.assistant, 'POST', `${ADMIN}/queue/run`)).assigned, [], 'a faulted machine gets no work');
  // An agent clock running ahead cannot freeze the row: its reading counts as taken now, and the next one still lands.
  await telemetry({ machine_state: 'error', reported_at: new Date(Date.now() + 3 * H * 1000).toISOString() });
  await telemetry({ machine_state: 'idle' });
  assert.equal((await view()).telemetry.machine_state, 'idle');
});

test('c22: a re-sent pause and a late start change nothing', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w, { approval: false });
  const agent = await agentOn(w, cat, ['telemetry', 'job_control']);
  await ok(w.guest, 'POST', `${AGENT}/printers/${cat.printers[0]}/telemetry`, { machine_state: 'idle' }, agent.bearer);
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h6 }, { kind: 'material', variant_id: cat.white, quantity: 250 }]);
  const jobId = await queuedJob(w, w.a, cat);
  assert.equal((await ok(w.assistant, 'POST', `${ADMIN}/queue/run`)).assigned.length, 1);
  const event = (body: Json) => call(w.guest, 'POST', `${AGENT}/jobs/${jobId}/events`, { printer_id: cat.printers[0], ...body }, agent.bearer);
  assert.equal((await event({ event: 'started' })).status, 200);
  assert.equal((await event({ event: 'paused', event_id: 'evt-0001-pause' })).json.data.status, 'paused');
  assert.equal((await event({ event: 'resumed', event_id: 'evt-0002-resume' })).json.data.status, 'printing');
  // The first pause, re-sent by a flaky network after the resume.
  const again = await event({ event: 'paused', event_id: 'evt-0001-pause' });
  assert.equal(again.status, 200);
  assert.equal(again.json.data.already_applied, true);
  assert.equal(status(w, jobId), 'printing');
  assert.equal(rows(w, "SELECT id FROM pc_print_job_events WHERE job_id = ? AND event = 'paused'", jobId).length, 1);
  // An operator pauses it (magnets go in); a late `started` from the agent neither resumes it nor restarts its clock.
  const startedAt = row(w, 'SELECT started_at FROM pc_print_jobs WHERE id = ?', jobId)?.started_at;
  await ok(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/pause`, { reason: 'magnet insertion' });
  const late = await event({ event: 'started' });
  assert.equal(late.status, 200);
  assert.equal(late.json.data.already_applied, true);
  assert.equal(status(w, jobId), 'paused');
  assert.equal(row(w, 'SELECT started_at FROM pc_print_jobs WHERE id = ?', jobId)?.started_at, startedAt);
  assert.equal(rows(w, "SELECT id FROM pc_print_job_events WHERE job_id = ? AND event = 'started'", jobId).length, 1);
  // A pause or resume must name itself: without an id, a re-sent copy could not be told from a new one.
  assert.equal((await event({ event: 'resumed' })).json.code, 'VALIDATION');
  assert.equal(status(w, jobId), 'paused');
});

test('c24: idle counts follow the scheduler: a silent, never-connected or faulted agent machine is not idle', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w, { approval: false });
  const agent = await ok(w.full, 'POST', `${ADMIN}/agents`, { name: 'Bay 1', capabilities: ['telemetry'] });
  const bearer = { Authorization: `Bearer ${agent.token}` };
  await ok(w.owner, 'PATCH', `${ADMIN}/catalog/printers/${cat.printers[0]}`, { adapter: 'agent', agent_id: agent.agent_id, connection_ref: 'lan-1' });
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h6 }]);
  const counts = async () => ({
    availability: (await ok(w.a, 'GET', `${API}/printers/${cat.model}/availability`)).machines_idle,
    offline: (await ok(w.a, 'GET', `${API}/printers/${cat.model}/availability`)).machines_offline,
    models: (await ok(w.a, 'GET', `${API}/printers`)).find((m: Json) => m.id === cat.model).machines_idle,
    model: (await ok(w.a, 'GET', `${API}/printers/${cat.model}`)).machines_idle,
    mine: (await ok(w.a, 'GET', `${API}/me/printers`)).find((m: Json) => m.printer_model_id === cat.model).idle_machines,
    dashboard: (await ok(w.a, 'GET', `${API}/me/dashboard`)).printers.find((m: Json) => m.printer_model_id === cat.model).idle_machines,
  });
  const only = (idle: number, offline: number) => ({ availability: idle, offline, models: idle, model: idle, mine: idle, dashboard: idle });
  assert.deepEqual(await counts(), only(1, 1), 'never connected: only the manual machine is idle');
  await ok(w.guest, 'POST', `${AGENT}/printers/${cat.printers[0]}/telemetry`, { machine_state: 'idle' }, bearer);
  assert.deepEqual(await counts(), only(2, 0));
  w.raw.prepare("UPDATE pc_printer_telemetry SET received_at = '2000-01-01T00:00:00.000Z' WHERE printer_id = ?").run(cat.printers[0]);
  assert.deepEqual(await counts(), only(1, 1), 'silent for hours');
  await ok(w.guest, 'POST', `${AGENT}/printers/${cat.printers[0]}/telemetry`, { machine_state: 'error', errors: [{ code: 'HMS_0300' }] }, bearer);
  assert.deepEqual(await counts(), only(1, 0), 'faulted');
  // The manual machine in a maintenance window that is on now is not idle either.
  await ok(w.guest, 'POST', `${AGENT}/printers/${cat.printers[0]}/telemetry`, { machine_state: 'idle' }, bearer);
  await ok(w.assistant, 'POST', `${ADMIN}/printers/${cat.printers[1]}/maintenance`, {
    kind: 'calibration',
    starts_at: new Date(Date.now() - 60_000).toISOString(),
    ends_at: new Date(Date.now() + H * 1000).toISOString(),
  });
  assert.deepEqual(await counts(), only(1, 0));
});

test('c25: the file door needs the capability of the work: a telemetry-only token reads no customer model', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w, { approval: false });
  const camera = await agentOn(w, cat, ['telemetry']);
  await ok(w.guest, 'POST', `${AGENT}/printers/${cat.printers[0]}/telemetry`, { machine_state: 'idle' }, camera.bearer);
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h6 }, { kind: 'material', variant_id: cat.white, quantity: 250 }]);
  const fileId = await readyFile(w, w.a, [40, 30, 10], 'secret.stl');
  const { jobId } = await estimatedJob(w, w.a, cat, { seconds: H, materials: [{ variant_id: cat.white, model_grams: 20 }], fileId });
  await runToPrinting(w, w.a, jobId, cat.printers[0]);
  const read = (bearer: Record<string, string>) => call(w.guest, 'GET', `${AGENT}/files/${fileId}`, undefined, bearer);
  assert.equal((await read(camera.bearer)).status, 404, 'the job is on its printer, but it does not control jobs');
  // The same printer under an agent that controls jobs may fetch what it prints.
  const control = await ok(w.full, 'POST', `${ADMIN}/agents`, { name: 'Bay 1 control', capabilities: ['telemetry', 'job_control'] });
  await ok(w.owner, 'PATCH', `${ADMIN}/catalog/printers/${cat.printers[0]}`, { agent_id: control.agent_id });
  assert.equal((await read({ Authorization: `Bearer ${control.token}` })).status, 200);
});

test('c28: a slicer token that never called in is not a connected slicer; one heard from lately is', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  assert.equal((await ok(w.guest, 'GET', `${API}/status`)).slicer, 'not_connected');
  const slicer = await ok(w.full, 'POST', `${ADMIN}/agents`, { name: 'Workshop PC', capabilities: ['slicer'] });
  assert.equal((await ok(w.guest, 'GET', `${API}/status`)).slicer, 'never_connected');
  const analyse = async () => {
    const fileId = await readyFile(w, w.a);
    const project = await ok(w.a, 'POST', `${API}/projects`, { name: 'Vase', project_type: 'figure' });
    await ok(w.a, 'POST', `${API}/projects/${project.project_id}/models`, { file_id: fileId, quantity: 1, material_assignments: [{ part: 'default', variant_id: cat.white }] });
    const job = await ok(w.a, 'POST', `${API}/jobs`, { project_id: project.project_id, printer_model_id: cat.model });
    return (await ok(w.a, 'POST', `${API}/jobs/${job.job_id}/analyze`)).slicer;
  };
  assert.equal(await analyse(), 'awaiting_slicer', 'nobody will slice it yet');
  // The agent program starts and polls for work.
  await ok(w.guest, 'POST', `${AGENT}/slicing/claim`, undefined, { Authorization: `Bearer ${slicer.token}` });
  assert.equal((await ok(w.guest, 'GET', `${API}/status`)).slicer, 'connected');
  assert.equal(await analyse(), 'queued');
  // It falls silent.
  w.raw.prepare("UPDATE pc_agents SET last_seen_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(slicer.agent_id);
  assert.equal((await ok(w.guest, 'GET', `${API}/status`)).slicer, 'stale');
  assert.equal(await analyse(), 'awaiting_slicer');
});
