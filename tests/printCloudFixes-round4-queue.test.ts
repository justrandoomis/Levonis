/**
 * LEVONIS PRINT CLOUD — round four: every runner of the queue bounded, and a
 * stranded chain dead to its end (docs/PRINT_CLOUD.md §7.5, §12). Each test is
 * the verifier's reproduction, on real records through the real routers:
 *
 *   operator  POST /admin/print-cloud/queue/run stays inside 600 statements
 *             of its own request: seven of the largest stranded jobs go a few
 *             a run, the answer naming the releases it deferred and asking
 *             for another run — never past D1's 1,000 an invocation.
 *   requests  the runner after an upload or an import claims only the work
 *             that request enqueued, within 300 statements: a scheduling pass
 *             left due is never worked in a customer's invocation.
 *   chain     a job waiting on a stranded job waits for a print that cannot
 *             come: the queue says dependency_cannot_complete, and the cron
 *             releases it even while its large dependency waits for room.
 *
 * Run: node --import tsx --import ./scripts/test-no-network.mjs --test tests/printCloudFixes-round4-queue.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN,
  API,
  CUSTOMER_A,
  PC_ASSISTANT,
  boxStl,
  buy,
  estimatedJob,
  idem,
  mountPrintCloud,
  ok,
  owned,
  pcWorld,
  readyFile,
  reconcileClean,
  refused,
  row,
  seedCatalog,
  upload,
  type Catalog,
  type Json,
  type World,
} from './fixtures/printCloud';
import { pending, stubApp } from './fixtures/app';
import { AFTER_REQUEST_STATEMENTS, printCloudTick } from '../worker/lib/printCloud/background';
import { enqueueTask } from '../worker/lib/printCloud/tasks';
import { countingD1 } from '../worker/lib/d1Count';
import { PRINT_CLOUD_TICK_BUDGET } from '../worker/lib/quarterHourBudget';

/** An estimate's most materials (parseEstimate) and a job's most accessories (parseAccessories). */
const COLOURS = 16;
const ACCESSORIES = 20;
/** The most reservations a job holds: its hours and one per material. */
const MOST = 1 + COLOURS + ACCESSORIES;
/** D1's queries per Worker invocation. */
const D1_LIMIT = 1000;

const status = (w: World, jobId: string) => row(w, 'SELECT status FROM pc_print_jobs WHERE id = ?', jobId)?.status;
const taskStatus = (w: World, dedupeKey: string) => row(w, 'SELECT status FROM pc_background_jobs WHERE dedupe_key = ?', dedupeKey)?.status;
const reservations = (w: World, jobId: string) =>
  Number(row(w, "SELECT COUNT(*) AS n FROM pc_credit_reservations WHERE job_id = ? AND state = 'active'", jobId)?.n) +
  Number(row(w, "SELECT COUNT(*) AS n FROM pc_inventory_reservations WHERE ref_id = ? AND state = 'active'", jobId)?.n);

interface Wide {
  filaments: string[];
  accessories: string[];
}

/**
 * The workshop of the fixtures, widened to the limits (as in
 * tests/printCloudFixes-queue2.test.ts): the model takes 16 colours, twelve
 * more PLA colours and eighteen more accessories are sold and stocked, and
 * customer A owns hours, 100 g of every colour and 40 of every accessory.
 */
async function wideWorkshop(w: World, cat: Catalog): Promise<Wide> {
  const settings = await ok(w.owner, 'GET', `${ADMIN}/settings`);
  await ok(w.owner, 'PATCH', `${ADMIN}/settings`, { version: settings.version, config: { max_active_jobs_per_customer: 100 } });
  await ok(w.owner, 'PATCH', `${ADMIN}/catalog/printer_models/${cat.model}`, { max_colors: COLOURS });
  const productOf = (variantId: string) => String(row(w, 'SELECT product_id FROM pc_variants WHERE id = ?', variantId)?.product_id);
  const variant = async (body: Record<string, unknown>, tiers: unknown[], stock: number) => {
    const id = (await ok(w.owner, 'POST', `${ADMIN}/catalog/variants`, body)).id as string;
    await ok(w.owner, 'PUT', `${ADMIN}/variants/${id}/price-tiers`, { tiers });
    await ok(w.owner, 'POST', `${ADMIN}/stock/receive`, { variant_id: id, qty: stock, total_cost_iqd: stock * 10, supplier: 'Bambu Lab' }, idem('stock'));
    return id;
  };
  const filaments = [cat.white, cat.black, cat.red, cat.gold];
  for (let i = filaments.length; i < COLOURS; i++) {
    filaments.push(
      await variant(
        {
          product_id: productOf(cat.white),
          sku: `PLA-BASIC-C${i}`,
          name_en: `PLA Basic colour ${i}`,
          name_ar: `PLA أساسي لون ${i}`,
          name_ckb: `PLA بنەڕەتی ڕەنگی ${i}`,
          unit_code: 'g',
          min_purchase_qty: 100,
          purchase_step_qty: 10,
          max_purchase_qty: 5000,
          diameter_um: 1750,
          color_name: `Colour ${i}`,
          color_hex: `#${(0x101010 * (i - 3)).toString(16).padStart(6, '0').slice(0, 6)}`,
        },
        [{ mode: 'bracket', min_qty: 100, unit_price_milli_iqd: 35000 }],
        1000
      )
    );
  }
  const accessories = [cat.magnets, cat.rings];
  for (let i = accessories.length; i < ACCESSORIES; i++) {
    accessories.push(
      await variant(
        {
          product_id: productOf(cat.magnets),
          sku: `MAG-K${i}`,
          name_en: `Magnet kind ${i}`,
          name_ar: `مغناطيس نوع ${i}`,
          name_ckb: `موگناتیسی جۆری ${i}`,
          unit_code: 'pc',
        },
        [{ mode: 'bracket', min_qty: 1, unit_price_milli_iqd: 250000 }],
        100
      )
    );
  }
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h24 }, ...filaments.map((v) => ({ kind: 'material', variant_id: v, quantity: 100 }))]);
  await buy(w.a, accessories.map((v) => ({ kind: 'material', variant_id: v, quantity: 40 })));
  return { filaments, accessories };
}

/** A confirmed job in the queue: ten minutes, 20 g of white, nothing it waits for. */
async function plainJob(w: World, cat: Catalog, title: string): Promise<string> {
  const { jobId } = await estimatedJob(w, w.a, cat, { seconds: 600, materials: [{ variant_id: cat.white, model_grams: 20 }], title });
  await ok(w.a, 'POST', `${API}/jobs/${jobId}/review`);
  assert.equal((await ok(w.a, 'POST', `${API}/jobs/${jobId}/confirm`, undefined, idem('confirm'))).status, 'queued');
  return jobId;
}

/** A queued job holding exactly `n` reservations (n ≥ 2), waiting for `dependsOn`: its hours, colours of 1 g, then accessories of one piece. */
async function heldJob(w: World, cat: Catalog, wide: Wide, n: number, dependsOn: string, fileId: string): Promise<string> {
  const colours = Math.min(n - 1, COLOURS);
  const parts = wide.filaments.slice(0, colours);
  const project = await ok(w.a, 'POST', `${API}/projects`, { name: `Held ${n}`, project_type: 'figure' });
  await ok(w.a, 'POST', `${API}/projects/${project.project_id}/models`, {
    file_id: fileId,
    quantity: 1,
    material_assignments: parts.map((variant_id, i) => ({ part: i ? `part${i}` : 'default', variant_id })),
  });
  const job = await ok(w.a, 'POST', `${API}/jobs`, {
    project_id: project.project_id,
    printer_model_id: cat.model,
    title: `Held ${n}`,
    depends_on_job_id: dependsOn,
    accessories: wide.accessories.slice(0, n - 1 - colours).map((variant_id) => ({ variant_id, qty: 1 })),
  });
  await ok(w.a, 'POST', `${API}/jobs/${job.job_id}/analyze`);
  await ok(w.assistant, 'POST', `${ADMIN}/jobs/${job.job_id}/estimate`, {
    duration_seconds: 600,
    materials: parts.map((variant_id) => ({ variant_id, model_grams: 1 })),
    slicer_name: 'OrcaSlicer',
  });
  await ok(w.a, 'POST', `${API}/jobs/${job.job_id}/review`);
  assert.equal((await ok(w.a, 'POST', `${API}/jobs/${job.job_id}/confirm`, undefined, idem('confirm'))).status, 'queued');
  assert.equal(reservations(w, job.job_id), n, `the job holds ${n} reservations`);
  return job.job_id;
}

/** The real cron step at a full share, a `schedule_queue` task due ahead of this slot's periodic work; what it spent. */
function ticks(w: World) {
  const counted = countingD1(w.db);
  const env = { DB: counted.db, BUCKET: w.bucket, R2_PRIVATE: w.bucket } as never;
  let n = 0;
  return async (): Promise<number> => {
    await w.db.batch([enqueueTask(w.db, { kind: 'schedule_queue', dedupeKey: `tick-${++n}`, now: new Date(Date.now() - 60_000) })]);
    const before = counted.executed;
    await printCloudTick(env, { budget: PRINT_CLOUD_TICK_BUDGET, used: () => counted.executed });
    return counted.executed - before;
  };
}

/**
 * The widened workshop, a head job and `n` of the largest jobs waiting on it —
 * stranded: the head is cancelled — and three cron ticks, each inside its
 * share, that leave every one of them queued (too large for any tick).
 */
async function strandedLargest(n: number): Promise<{ w: World; cat: Catalog; large: string[] }> {
  const w = pcWorld();
  const cat = await seedCatalog(w, { approval: false });
  const wide = await wideWorkshop(w, cat);
  const head = await plainJob(w, cat, 'Head');
  const fileId = await readyFile(w, w.a);
  const large: string[] = [];
  for (let i = 0; i < n; i++) large.push(await heldJob(w, cat, wide, MOST, head, fileId));
  await ok(w.a, 'POST', `${API}/jobs/${head}/cancel`, { reason: 'changed my mind' });
  await w.runTasks();
  const tick = ticks(w);
  for (let i = 0; i < 3; i++) {
    const spent = await tick();
    assert.ok(spent <= PRINT_CLOUD_TICK_BUDGET, `tick ${i + 1} spent ${spent} of ${PRINT_CLOUD_TICK_BUDGET}`);
  }
  for (const id of large) assert.equal(status(w, id), 'queued', 'too large for any tick: it waits');
  return { w, cat, large };
}

// ------------------------------------------------------------------ 1. operator

test("POST /queue/run stays inside its request's D1 budget: seven of the largest stranded jobs go a few a run, the answer naming the rest", async () => {
  const { w, cat, large } = await strandedLargest(7);
  const counted = countingD1(w.db);
  const operator = stubApp(counted.db, PC_ASSISTANT, mountPrintCloud, { env: w.env, publishV2: false });
  const released: string[] = [];
  let runs = 0;
  while (released.length < large.length) {
    assert.ok(++runs <= large.length, 'every run releases at least one');
    const before = counted.executed;
    const run = await ok(operator, 'POST', `${ADMIN}/queue/run`);
    const spent = counted.executed - before;
    assert.ok(spent <= D1_LIMIT, `POST /queue/run sent ${spent} statements in one invocation (D1 allows 1,000)`);
    assert.ok(spent <= 600 + 20, `the pass stayed inside its 600 statements (and the door's own reads): ${spent}`);
    assert.ok(run.released.length >= 1, JSON.stringify(run));
    released.push(...run.released);
    const left = large.filter((id) => !released.includes(id));
    // What did not fit is named, so the operator knows to run it again.
    assert.deepEqual([...run.deferred].sort(), [...left].sort(), `run ${runs}: the answer names every release it deferred`);
    assert.equal(run.more, left.length > 0, `run ${runs}: another run is asked for while any is left`);
  }
  assert.ok(runs > 1, 'seven of the largest do not fit one run');
  for (const id of large) {
    assert.equal(status(w, id), 'cancelled');
    assert.equal(reservations(w, id), 0);
  }
  assert.equal((await owned(w.a, cat.magnets)).reserved_qty, 0);
  await reconcileClean(w);
});

// ------------------------------------------------------------------ 2. requests

test("a customer's upload: its runner measures the file it enqueued and nothing else, inside its bound — the stranded jobs and a pass left due wait", async () => {
  const { w, large } = await strandedLargest(7);
  // A scheduling pass left due (a tick that deferred, changed something and ran out of room or task slots).
  await w.db.batch([enqueueTask(w.db, { kind: 'schedule_queue', dedupeKey: 'left-due', now: new Date(Date.now() - 60_000) })]);
  const counted = countingD1(w.db);
  const customer = stubApp(counted.db, CUSTOMER_A, mountPrintCloud, { env: w.env, publishV2: false });
  const before = counted.executed;
  const r = await upload(customer, boxStl(40, 30, 10), 'x.stl');
  assert.equal(r.status, 201, JSON.stringify(r.json));
  await Promise.allSettled(pending.splice(0));
  const spent = counted.executed - before;
  assert.ok(spent <= D1_LIMIT, `one customer upload invocation sent ${spent} statements (D1 allows 1,000)`);
  assert.ok(spent <= AFTER_REQUEST_STATEMENTS + 60, `the upload and its runner stayed inside the runner's ${AFTER_REQUEST_STATEMENTS} and the door's own: ${spent}`);
  for (const id of large) assert.equal(status(w, id), 'queued', "the scheduler's backlog is not worked in a customer's invocation");
  assert.equal(taskStatus(w, 'left-due'), 'queued', 'the pass is left to the cron and the operator');
  assert.equal(taskStatus(w, `analyze:${r.json.data.file_id}`), 'succeeded', 'the file the upload enqueued is measured');
});

test("…and an import's runner: only the import it enqueued; neither door's runner places a queued job", async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w, { approval: false });
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h24 }, { kind: 'material', variant_id: cat.white, quantity: 100 }]);
  const waiting = await plainJob(w, cat, 'Waiting');
  await w.db.batch([enqueueTask(w.db, { kind: 'schedule_queue', dedupeKey: 'left-due', now: new Date(Date.now() - 60_000) })]);
  const imp = await ok(w.a, 'POST', `${API}/imports`, { url: 'https://makerworld.com/en/models/123456' });
  await Promise.allSettled(pending.splice(0));
  assert.equal((await ok(w.a, 'GET', `${API}/imports/${imp.import_id}`)).status, 'link_saved', 'the import it enqueued ran');
  assert.equal(taskStatus(w, 'left-due'), 'queued');
  assert.equal(status(w, waiting), 'queued', 'no scheduling pass ran in the import');
  const r = await upload(w.a, boxStl(20, 20, 20), 'y.stl');
  assert.equal(r.status, 201);
  await Promise.allSettled(pending.splice(0));
  assert.equal(taskStatus(w, `analyze:${r.json.data.file_id}`), 'succeeded');
  assert.equal(taskStatus(w, 'left-due'), 'queued');
  assert.equal(status(w, waiting), 'queued', 'no scheduling pass ran in the upload');
  // The cron takes it.
  const spent = await ticks(w)();
  assert.ok(spent <= PRINT_CLOUD_TICK_BUDGET);
  assert.equal(status(w, waiting), 'preparing');
});

// ------------------------------------------------------------------ 3. chain

test('head <- Large <- Small, the head cancelled: Small waits for a print that cannot come — shown dependency_cannot_complete, released by the cron while Large waits for room', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w, { approval: false });
  const wide = await wideWorkshop(w, cat);
  const head = await plainJob(w, cat, 'Head');
  const fileId = await readyFile(w, w.a);
  const large = await heldJob(w, cat, wide, MOST, head, fileId);
  const small = await heldJob(w, cat, wide, 2, large, fileId);
  const basis = async (app = w.a): Promise<Record<string, string>> => {
    const answer = await ok(app, 'GET', app === w.a ? `${API}/queue` : `${ADMIN}/queue`);
    const jobs: Json[] = Array.isArray(answer) ? answer : answer.jobs;
    return Object.fromEntries(jobs.filter((j) => j.job_id !== head).map((j) => [j.job_id, j.basis]));
  };
  // While the head can still be made, both wait for it.
  assert.deepEqual(await basis(), { [large]: 'waiting_for_dependency', [small]: 'waiting_for_dependency' });

  await ok(w.a, 'POST', `${API}/jobs/${head}/cancel`, { reason: 'changed my mind' });
  await w.runTasks();
  // Large waits on a cancelled job, Small on a job that waits on one: neither can be made, and both are told so.
  assert.deepEqual(await basis(), { [large]: 'dependency_cannot_complete', [small]: 'dependency_cannot_complete' });
  assert.deepEqual(await basis(w.assistant), { [large]: 'dependency_cannot_complete', [small]: 'dependency_cannot_complete' });
  const refusal = await refused(w.assistant, 'POST', `${ADMIN}/jobs/${small}/assign`, { printer_id: cat.printers[0] }, 'DEPENDENCY_NOT_MET');
  assert.equal(refusal.details.reason, 'dependency_cannot_complete');

  // The cron: Large's release is larger than any share and waits; Small's fits, and goes.
  const tick = ticks(w);
  for (let i = 0; i < 4; i++) {
    const spent = await tick();
    assert.ok(spent <= PRINT_CLOUD_TICK_BUDGET, `tick ${i + 1} spent ${spent} of ${PRINT_CLOUD_TICK_BUDGET}`);
  }
  assert.equal(status(w, small), 'cancelled', 'Small is released by the cron');
  assert.equal(reservations(w, small), 0, 'its hours and grams given back');
  assert.equal(
    row(w, "SELECT COUNT(*) AS n FROM pc_print_job_events WHERE job_id = ? AND to_status = 'cancelled' AND detail_json LIKE '%dependency_cannot_complete%'", small)?.n,
    1,
    'cancelled for the reason it names'
  );
  assert.equal(status(w, large), 'queued', 'Large waits for a run with room');
  assert.equal(reservations(w, large), MOST);
  assert.deepEqual(await basis(), { [large]: 'dependency_cannot_complete' });
  await reconcileClean(w);
});

test('a pass that stops at its limit of changes asks to run again: of 21 small stranded jobs the operator run releases 20 and answers more, the next run the last', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w, { approval: false });
  const wide = await wideWorkshop(w, cat);
  const fileId = await readyFile(w, w.a);
  const head = await plainJob(w, cat, 'Head');
  const small: string[] = [];
  for (let i = 0; i < 21; i++) small.push(await heldJob(w, cat, wide, 2, head, fileId));
  await ok(w.a, 'POST', `${API}/jobs/${head}/cancel`, { reason: 'changed my mind' });
  const first = await ok(w.assistant, 'POST', `${ADMIN}/queue/run`);
  assert.equal(first.released.length, 20);
  assert.equal(first.more, true, 'stopped at its limit with jobs unread: run again');
  const second = await ok(w.assistant, 'POST', `${ADMIN}/queue/run`);
  assert.deepEqual([second.released.length, second.more], [1, false]);
  assert.ok(small.every((j) => status(w, j) === 'cancelled'));
  await reconcileClean(w);
});
