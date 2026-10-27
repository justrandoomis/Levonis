/**
 * LEVONIS PRINT CLOUD — round three: the scheduler's release of a stranded
 * job, sized, never overshooting and never blocking (docs/PRINT_CLOUD.md §7.5).
 * Each test is the reviewer's reproduction, on real records through the real
 * routers:
 *
 *   sized     a release asks for at least every statement it sends, its reads
 *             and its batch, measured from one reservation to the most a job
 *             can hold (one credit, 16 colours, 20 accessories). There is no
 *             ceiling, so the largest job never takes a bounded run past its
 *             share: it waits.
 *   skipped   a release that does not fit the room is deferred, and the pass
 *             goes on placing the jobs behind it.
 *   operator  a release larger than any quarter-hour share is done by the
 *             operator's queue run, or by the admin task run, whose own
 *             scheduling pass leads it inside its 600 statements.
 *
 * Run: node --import tsx --import ./scripts/test-no-network.mjs --test tests/printCloudFixes-queue2.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, API, buy, estimatedJob, idem, ok, owned, pcWorld, readyFile, reconcileClean, row, seedCatalog, type Catalog, type World } from './fixtures/printCloud';
import { PRINT_CLOUD_TASK_OVERHEAD, PRINT_CLOUD_UNIT_STATEMENTS, printCloudTick, roomWithin, runPrintCloudTasks } from '../worker/lib/printCloud/background';
import { runScheduler } from '../worker/lib/printCloud/queue';
import { loadConfig } from '../worker/lib/printCloud/settings';
import { enqueueTask } from '../worker/lib/printCloud/tasks';
import { countingD1 } from '../worker/lib/d1Count';
import { configureEventBus, resetEventBus } from '../worker/lib/eventBus';
import { PRINT_CLOUD_TICK_BUDGET } from '../worker/lib/quarterHourBudget';

/** An estimate's most materials (parseEstimate) and a job's most accessories (parseAccessories). */
const COLOURS = 16;
const ACCESSORIES = 20;
/** The most reservations a job holds: its hours and one per material. */
const MOST = 1 + COLOURS + ACCESSORIES;

const status = (w: World, jobId: string) => row(w, 'SELECT status FROM pc_print_jobs WHERE id = ?', jobId)?.status;
const reservations = (w: World, jobId: string) =>
  Number(row(w, "SELECT COUNT(*) AS n FROM pc_credit_reservations WHERE job_id = ? AND state = 'active'", jobId)?.n) +
  Number(row(w, "SELECT COUNT(*) AS n FROM pc_inventory_reservations WHERE ref_id = ? AND state = 'active'", jobId)?.n);

interface Wide {
  filaments: string[];
  accessories: string[];
}

/**
 * The workshop of the fixtures, widened to the limits: the model takes 16
 * colours, twelve more PLA colours and eighteen more accessories are sold and
 * stocked, and customer A owns hours, 100 g of every colour and 40 of every
 * accessory — enough for a job of every size.
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

/**
 * A queued job holding exactly `n` reservations, waiting for `dependsOn`: its
 * hours, then up to 16 colours of 1 g, then accessories of one piece. A job of
 * one reservation is a colour weighed at 0 g (no grams, nothing to hold).
 */
async function heldJob(w: World, cat: Catalog, wide: Wide, n: number, dependsOn: string, fileId: string): Promise<string> {
  const colours = Math.min(n - 1, COLOURS);
  const parts = wide.filaments.slice(0, Math.max(1, colours));
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
    materials: parts.map((variant_id) => ({ variant_id, model_grams: colours ? 1 : 0 })),
    slicer_name: 'OrcaSlicer',
  });
  await ok(w.a, 'POST', `${API}/jobs/${job.job_id}/review`);
  assert.equal((await ok(w.a, 'POST', `${API}/jobs/${job.job_id}/confirm`, undefined, idem('confirm'))).status, 'queued');
  assert.equal(reservations(w, job.job_id), n, `the job holds ${n} reservations`);
  return job.job_id;
}

/** The workshop widened, a head job, and the largest job a customer can confirm waiting on it — stranded: the head is cancelled. */
async function strandedLargest(): Promise<{ w: World; cat: Catalog; wide: Wide; largest: string }> {
  const w = pcWorld();
  const cat = await seedCatalog(w, { approval: false });
  const wide = await wideWorkshop(w, cat);
  const head = await plainJob(w, cat, 'Head');
  const largest = await heldJob(w, cat, wide, MOST, head, await readyFile(w, w.a));
  await ok(w.a, 'POST', `${API}/jobs/${head}/cancel`, { reason: 'changed my mind' });
  await w.runTasks();
  return { w, cat, wide, largest };
}

/** A `schedule_queue` task run within `budget` statements, as the cron's runner runs it (a new one, or the one due again); what it spent. */
function passes(w: World) {
  const counted = countingD1(w.db);
  const env = { DB: counted.db, BUCKET: w.bucket, R2_PRIVATE: w.bucket } as never;
  let n = 0;
  return {
    async pass(budget: number, again = false): Promise<number> {
      if (!again) await w.db.batch([enqueueTask(w.db, { kind: 'schedule_queue', dedupeKey: `sched-${++n}`, now: new Date() })]);
      const before = counted.executed;
      await runPrintCloudTasks(env, { limit: 1, room: roomWithin(() => counted.executed, budget) });
      return counted.executed - before;
    },
    /** The real cron step at a full share, a `schedule_queue` task due ahead of this slot's periodic work. */
    async tick(): Promise<number> {
      await w.db.batch([enqueueTask(w.db, { kind: 'schedule_queue', dedupeKey: `tick-${++n}`, now: new Date(Date.now() - 60_000) })]);
      const before = counted.executed;
      await printCloudTick(env, { budget: PRINT_CLOUD_TICK_BUDGET, used: () => counted.executed });
      return counted.executed - before;
    },
  };
}

// ------------------------------------------------------------------ 1. sized

test('a release asks for at least what it sends, measured from one reservation to the most a job holds (one credit, 16 colours, 20 accessories)', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w, { approval: false });
  const wide = await wideWorkshop(w, cat);
  const head = await plainJob(w, cat, 'Head');
  const fileId = await readyFile(w, w.a);
  const held = new Map<string, number>();
  for (let n = 1; n <= MOST; n++) held.set(await heldJob(w, cat, wide, n, head, fileId), n);
  await ok(w.a, 'POST', `${API}/jobs/${head}/cancel`, { reason: 'changed my mind' });
  await w.runTasks();

  // With the event bus on, the audit row is three statements: the most a release sends.
  configureEventBus({ DB: w.db, EVENT_BUS_ENABLED: 'on', INITIAL_ADMIN_EMAIL: 'x@x.co', EXTRA_ALLOWED_ORIGINS: '' } as never);
  try {
    const counted = countingD1(w.db);
    const { config } = await loadConfig(w.db);
    // Every room the pass asks for, and the counter when it asks: what follows a release's question, up to the next, is that release.
    const asks: Array<{ statements: number | undefined; at: number }> = [];
    const r = await runScheduler(counted.db, config, new Date(), 100, (statements) => {
      asks.push({ statements, at: counted.executed });
      return true;
    });
    const end = counted.executed;
    assert.equal(r.released.length, MOST, JSON.stringify(r).slice(0, 300));
    const releases = asks.map((a, i) => ({ asked: a.statements, sent: (asks[i + 1]?.at ?? end) - a.at })).filter((a) => a.asked !== undefined);
    assert.equal(releases.length, MOST, 'each release asked for its own room');
    releases.forEach((a, i) => {
      const n = held.get(r.released[i]);
      assert.ok(a.sent <= (a.asked as number), `a release of ${n} reservations sent ${a.sent} statements, asked for ${a.asked}`);
    });
  } finally {
    resetEventBus();
  }
  for (const id of held.keys()) assert.equal(reservations(w, id), 0);
  await reconcileClean(w);
});

test('the largest job, stranded, never takes a run past its share: neither a tight one, nor a full 120, nor the cron tick', async () => {
  const { w, cat, largest } = await strandedLargest();
  const p = passes(w);
  const tight = PRINT_CLOUD_TASK_OVERHEAD + PRINT_CLOUD_UNIT_STATEMENTS;
  const spentTight = await p.pass(tight);
  assert.ok(spentTight <= tight, `a tight run spent ${spentTight} of ${tight}`);
  const spentFull = await p.pass(PRINT_CLOUD_TICK_BUDGET);
  assert.ok(spentFull <= PRINT_CLOUD_TICK_BUDGET, `a full run spent ${spentFull} of ${PRINT_CLOUD_TICK_BUDGET}`);
  const spentTick = await p.tick();
  assert.ok(spentTick <= PRINT_CLOUD_TICK_BUDGET, `the tick spent ${spentTick} of ${PRINT_CLOUD_TICK_BUDGET}`);
  // Too large for any share: it waits, every reservation still held, for a run that has the room.
  assert.equal(status(w, largest), 'queued');
  assert.equal(reservations(w, largest), MOST);
  assert.equal((await owned(w.a, cat.magnets)).reserved_qty, 1);
  await reconcileClean(w);
});

// ------------------------------------------------------------------ 2. skipped

test('a stranded job whose release does not fit does not stop the job behind it: that one is placed, and the pass ends', async () => {
  const { w, cat, largest } = await strandedLargest();
  const behind = await plainJob(w, cat, 'Behind');
  await ok(w.assistant, 'POST', `${ADMIN}/jobs/${largest}/priority`, { priority: 5 });
  const p = passes(w);
  const task = () => row(w, "SELECT status FROM pc_background_jobs WHERE dedupe_key = 'sched-1'")?.status;
  const spent = await p.pass(90);
  assert.ok(spent <= 90, `a run spent ${spent} of 90`);
  assert.equal(status(w, behind), 'preparing', 'the job behind the stranded one was placed');
  assert.equal(status(w, largest), 'queued', 'the release that does not fit waits');
  // It changed something and deferred a release, so it asks to run again; run again, it only looks, and ends.
  assert.equal(task(), 'queued');
  const again = await p.pass(PRINT_CLOUD_TICK_BUDGET, true);
  assert.ok(again <= PRINT_CLOUD_TICK_BUDGET, `a run spent ${again} of ${PRINT_CLOUD_TICK_BUDGET}`);
  assert.equal(task(), 'succeeded');
  assert.equal(status(w, largest), 'queued');
  // And in the cron tick: the next job behind is placed too, inside the share.
  const next = await plainJob(w, cat, 'Next');
  const spentTick = await p.tick();
  assert.ok(spentTick <= PRINT_CLOUD_TICK_BUDGET, `the tick spent ${spentTick} of ${PRINT_CLOUD_TICK_BUDGET}`);
  assert.equal(status(w, next), 'preparing');
  assert.equal(status(w, largest), 'queued');
  await reconcileClean(w);
});

// ------------------------------------------------------------------ 3. operator

test("a release too large for the tick's share is done by the operator's queue run: cancelled, every reservation back", async () => {
  const { w, cat, largest } = await strandedLargest();
  const spentTick = await passes(w).tick();
  assert.ok(spentTick <= PRINT_CLOUD_TICK_BUDGET, `the tick spent ${spentTick} of ${PRINT_CLOUD_TICK_BUDGET}`);
  assert.equal(status(w, largest), 'queued', 'the tick leaves it for a run with room');
  const run = await ok(w.assistant, 'POST', `${ADMIN}/queue/run`);
  assert.deepEqual(run.released, [largest]);
  assert.equal(status(w, largest), 'cancelled');
  assert.equal(reservations(w, largest), 0);
  assert.equal((await owned(w.a, cat.magnets)).reserved_qty, 0);
  await reconcileClean(w);
});

test('…or by the admin task run: a scheduling pass leads it, inside its 600 statements', async () => {
  const { w, cat, largest } = await strandedLargest();
  await passes(w).tick();
  assert.equal(status(w, largest), 'queued');
  // Nothing of the queue's is due any more: the run brings its own pass.
  const counted = countingD1(w.db);
  const before = counted.executed;
  const run = await ok(w.assistant, 'POST', `${ADMIN}/tasks/run`);
  const spent = counted.executed - before;
  assert.ok(spent <= 600, `the run spent ${spent} of 600`);
  assert.ok(run.succeeded >= 1, JSON.stringify(run));
  assert.equal(status(w, largest), 'cancelled');
  assert.equal(reservations(w, largest), 0);
  assert.equal((await owned(w.a, cat.magnets)).reserved_qty, 0);
  // Asked again within the minute, the door adds no second pass.
  await ok(w.assistant, 'POST', `${ADMIN}/tasks/run`);
  assert.equal(Number(row(w, "SELECT COUNT(*) AS n FROM pc_background_jobs WHERE dedupe_key LIKE 'schedule_queue:by_hand:%'")?.n), 1);
  await reconcileClean(w);
});
