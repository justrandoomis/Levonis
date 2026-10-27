/**
 * LEVONIS PRINT CLOUD — the fourth round: credits. What the independent
 * verifier of the lot-level holds reproduced, each pinned on real records
 * through the real routers (docs/PRINT_CLOUD.md §3.2, §7.5):
 *
 *   1  O(1) UNHOLD. Giving a reservation's holds back is ONE statement
 *      however many lots the hours are held on (credits.ts `unholdAll`): a
 *      job whose hours sit on a hundred lots is released inside the
 *      quarter-hour share of 120 — it used to ask for 123 and wait — the
 *      release asks for at least what it sends and sends what a one-lot
 *      release sends, and a workshop failure that bills nothing gives a
 *      hundred holds back in the statements it gives one back in.
 *   2  THE REPRINT'S ENTITLEMENT WINDOW. A free reprint inherits the hours
 *      its failed parent held, but the failure's resolution gives them back
 *      and the reprint's confirmation holds them again: two batches. While
 *      the reprint is not yet confirmed (ready or awaiting it), the sweep
 *      leaves what it is entitled to on the lot — read from the parent's
 *      hold rows and the reprint link, never from timing — so a sweep racing
 *      the confirmation takes none of it, a reprint waiting for the customer
 *      keeps it for a confirmation by hand, an entitlement that comes back
 *      while a sweep is in flight stops that sweep, and once the reprint is
 *      cancelled the hours expire as any others.
 *
 * Run: node --import tsx --import ./scripts/test-no-network.mjs --test tests/printCloudFixes-round4-credits.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, API, buy, credits, estimatedJob, idem, ok, pcWorld, readyFile, reconcileClean, row, rows, runToPrinting, seedCatalog, type Catalog, type World } from './fixtures/printCloud';
import { roomWithin, runPrintCloudTasks } from '../worker/lib/printCloud/background';
import { expiredLots } from '../worker/lib/printCloud/credits';
import { resolveFailure } from '../worker/lib/printCloud/jobs';
import { runScheduler } from '../worker/lib/printCloud/queue';
import { loadConfig } from '../worker/lib/printCloud/settings';
import { enqueueTask } from '../worker/lib/printCloud/tasks';
import { countingD1 } from '../worker/lib/d1Count';
import { configureEventBus, resetEventBus } from '../worker/lib/eventBus';
import { PRINT_CLOUD_TICK_BUDGET } from '../worker/lib/quarterHourBudget';

const H = 3600;
const PAST = '2000-01-01T00:00:00.000Z';

const status = (w: World, jobId: string) => row(w, 'SELECT status FROM pc_print_jobs WHERE id = ?', jobId)?.status;
const holdRows = (w: World, jobId: string) =>
  rows(w, 'SELECT h.lot_id, h.seconds FROM pc_credit_reservation_lots h JOIN pc_credit_reservations r ON r.id = h.reservation_id WHERE r.job_id = ? ORDER BY h.rowid', jobId);
const heldOnLots = (w: World) => Number(row(w, "SELECT COALESCE(SUM(seconds_held), 0) AS s FROM pc_credit_lots WHERE user_id = 'usr_pc_a'")?.s);
const balance = async (w: World, cat: Catalog) => {
  const c = await credits(w.a, cat.tier);
  return [c.available_seconds, c.reserved_seconds];
};

// ------------------------------------------------------------------ 1. O(1) unhold

/** `n` lots of one hour each for A (goodwill adjustments, oldest first in spend order), and 500 g of white to print with. */
async function hourLots(w: World, cat: Catalog, n: number) {
  await buy(w.a, [{ kind: 'material', variant_id: cat.white, quantity: 500 }]);
  for (let i = 0; i < n; i++) {
    await ok(w.full, 'POST', `${ADMIN}/customers/usr_pc_a/credits/adjust`, { tier_id: cat.tier, seconds: H, reason: `goodwill ${i}` }, idem('adj'));
  }
}

/** A confirmed, queued job of `seconds` and 20 g of white, waiting for `dependsOn` when given. */
async function queuedJob(w: World, cat: Catalog, fileId: string, seconds: number, title: string, dependsOn?: string): Promise<string> {
  const project = await ok(w.a, 'POST', `${API}/projects`, { name: title, project_type: 'figure' });
  await ok(w.a, 'POST', `${API}/projects/${project.project_id}/models`, { file_id: fileId, quantity: 1, material_assignments: [{ part: 'default', variant_id: cat.white }] });
  const job = await ok(w.a, 'POST', `${API}/jobs`, { project_id: project.project_id, printer_model_id: cat.model, title, ...(dependsOn ? { depends_on_job_id: dependsOn } : {}) });
  await ok(w.a, 'POST', `${API}/jobs/${job.job_id}/analyze`);
  await ok(w.assistant, 'POST', `${ADMIN}/jobs/${job.job_id}/estimate`, { duration_seconds: seconds, materials: [{ variant_id: cat.white, model_grams: 20 }], slicer_name: 'OrcaSlicer' });
  await ok(w.a, 'POST', `${API}/jobs/${job.job_id}/review`);
  assert.equal((await ok(w.a, 'POST', `${API}/jobs/${job.job_id}/confirm`, undefined, idem('confirm'))).status, 'queued');
  return job.job_id;
}

test('1: a reservation held across 100 lots is released inside the 120 share: one statement gives every hold back', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w, { approval: false });
  await hourLots(w, cat, 101);
  const fileId = await readyFile(w, w.a);
  const head = await queuedJob(w, cat, fileId, H, 'Head');
  const wide = await queuedJob(w, cat, fileId, 100 * H, 'Wide', head);
  assert.equal(holdRows(w, wide).length, 100, 'the job holds 100 lots');
  await ok(w.a, 'POST', `${API}/jobs/${head}/cancel`, { reason: 'changed my mind' });
  await w.runTasks();
  assert.equal(status(w, wide), 'queued');

  // The verifier's pass: one schedule_queue task within the quarter-hour share.
  const counted = countingD1(w.db);
  const env = { DB: counted.db, BUCKET: w.bucket, R2_PRIVATE: w.bucket } as never;
  await w.db.batch([enqueueTask(w.db, { kind: 'schedule_queue', dedupeKey: 'round4-sched', now: new Date() })]);
  const before = counted.executed;
  await runPrintCloudTasks(env, { limit: 1, room: roomWithin(() => counted.executed, PRINT_CLOUD_TICK_BUDGET) });
  const spent = counted.executed - before;
  assert.ok(spent <= PRINT_CLOUD_TICK_BUDGET, `a full run spent ${spent} of ${PRINT_CLOUD_TICK_BUDGET}`);
  assert.equal(status(w, wide), 'cancelled', 'the release fits the share: it no longer grows with the lots');
  assert.equal(heldOnLots(w), 0, 'every one of the 100 holds is back on its lot');
  assert.deepEqual(await balance(w, cat), [101 * H, 0]);
  await reconcileClean(w);
});

test('1: the release asks for at least what it sends, and a job on 100 lots sends what a job on one lot sends', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w, { approval: false });
  await hourLots(w, cat, 103);
  const fileId = await readyFile(w, w.a);
  const head = await queuedJob(w, cat, fileId, H, 'Head');
  // Released first, a one-lot job carries what only an isolate's first release sends (the outbox probe).
  const first = await queuedJob(w, cat, fileId, H, 'First', head);
  const wide = await queuedJob(w, cat, fileId, 100 * H, 'Wide', head);
  const narrow = await queuedJob(w, cat, fileId, H, 'Narrow', head);
  assert.deepEqual([holdRows(w, wide).length, holdRows(w, narrow).length], [100, 1]);
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
    assert.deepEqual(r.released, [first, wide, narrow], JSON.stringify(r).slice(0, 300));
    const releases = asks.map((a, i) => ({ asked: a.statements, sent: (asks[i + 1]?.at ?? end) - a.at })).filter((a) => a.asked !== undefined);
    assert.equal(releases.length, 3, 'each release asked for its own room');
    const [, onHundred, onOne] = releases;
    releases.forEach((a, i) => {
      assert.ok(a.sent <= (a.asked as number), `release ${i + 1} (a job on ${i === 1 ? 100 : 1} lots) sent ${a.sent} statements, asked for ${a.asked}`);
    });
    assert.equal(onHundred.sent, onOne.sent, `a job on 100 lots sent ${onHundred.sent} statements, a job on one lot ${onOne.sent}`);
    assert.equal(onHundred.asked, onOne.asked, 'and asked for the same room');
  } finally {
    resetEventBus();
  }
  assert.equal(heldOnLots(w), 0);
  assert.deepEqual(await balance(w, cat), [103 * H, 0]);
  await reconcileClean(w);
});

test('1: a workshop failure that bills nothing gives 100 holds back in the statements it gives one back in', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w, { approval: false });
  await hourLots(w, cat, 101);
  const { jobId: wide } = await estimatedJob(w, w.a, cat, { seconds: 100 * H, materials: [{ variant_id: cat.white, model_grams: 20 }], title: 'Wide' });
  await runToPrinting(w, w.a, wide);
  const { jobId: narrow } = await estimatedJob(w, w.a, cat, { seconds: H, materials: [{ variant_id: cat.white, model_grams: 20 }], title: 'Narrow' });
  await runToPrinting(w, w.a, narrow);
  assert.deepEqual([holdRows(w, wide).length, holdRows(w, narrow).length], [100, 1]);
  const failure = async (jobId: string) =>
    (await ok(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/fail`, { reason_code: 'NOZZLE_CLOG', responsible: 'workshop', printed_seconds: 600 })).failure_id as string;
  const failures = { wide: await failure(wide), narrow: await failure(narrow) };

  const { config } = await loadConfig(w.db);
  const counted = countingD1(w.db);
  const resolve = async (failureId: string) => {
    const before = counted.executed;
    await resolveFailure(counted.db, failureId, { responsible: 'workshop', reprint: false, note: '' }, { type: 'operator', id: 'usr_asst' }, config, new Date());
    return counted.executed - before;
  };
  const onOne = await resolve(failures.narrow);
  const onHundred = await resolve(failures.wide);
  assert.equal(onHundred, onOne, `settling a job on 100 lots sent ${onHundred} statements, a job on one lot ${onOne}`);
  assert.equal(heldOnLots(w), 0);
  assert.deepEqual(await balance(w, cat), [101 * H, 0]);
  await reconcileClean(w);
});

// ------------------------------------------------------------------ 2. the reprint's entitlement window

/** A 6 h package (9,000 IQD) the owner set to expire 30 days after purchase. */
async function expiringPackage(w: World, cat: Catalog): Promise<string> {
  const pkg = await ok(w.owner, 'POST', `${ADMIN}/catalog/packages`, {
    tier_id: cat.tier,
    code: 'x2d-6h-30d',
    name_en: '6 hours, 30 days',
    name_ar: '6 ساعات لمدة 30 يوماً',
    name_ckb: '6 کاتژمێر بۆ 30 ڕۆژ',
    seconds: 6 * H,
    price_iqd: 9000,
    expires_after_days: 30,
  });
  return pkg.id as string;
}

let sweeps = 0;
/** One run of the expiry task, as the quarter-hour enqueues it. Returns the task's row. */
async function sweepExpiry(w: World) {
  const key = `test-round4-expiry-${++sweeps}`;
  await w.db.batch([enqueueTask(w.db, { kind: 'expire_credit_lots', dedupeKey: key, now: new Date() })]);
  await w.runTasks();
  return row(w, 'SELECT status, last_error FROM pc_background_jobs WHERE dedupe_key = ?', key);
}

const remaining = (w: World, lotId: string) => row(w, 'SELECT seconds_remaining FROM pc_credit_lots WHERE id = ?', lotId)?.seconds_remaining;
const expiringLotOf = (w: World, userId: string) => row(w, "SELECT id FROM pc_credit_lots WHERE user_id = ? AND expires_at IS NOT NULL AND source = 'purchase'", userId)?.id as string;
const expire = (w: World, lotId: string) => w.raw.prepare('UPDATE pc_credit_lots SET expires_at = ? WHERE id = ?').run(PAST, lotId);
const expiredSeconds = (w: World, lotId: string) => Number(row(w, "SELECT COALESCE(-SUM(delta_available), 0) AS s FROM pc_credit_ledger WHERE entry_type = 'expire' AND lot_id = ?", lotId)?.s);
const consumedFrom = (w: World, lotId: string) => Number(row(w, "SELECT COALESCE(SUM(seconds), 0) AS s FROM pc_credit_lot_draws WHERE lot_id = ? AND ledger_entry_key LIKE 'consume:%'", lotId)?.s);

/** After confirmation: a machine, printing, and completion with all it was estimated. */
async function printToTheEnd(w: World, cat: Catalog, jobId: string, seconds: number) {
  await ok(w.assistant, 'POST', `${ADMIN}/queue/run`);
  await ok(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/start`);
  await ok(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/complete`, { printed_seconds: seconds, materials: [{ variant_id: cat.white, qty: 20 }] });
}

const failByWorkshop = (w: World, jobId: string) =>
  ok(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/fail`, { reason_code: 'NOZZLE_CLOG', responsible: 'workshop', printed_seconds: 600 });

test('2: the sweep racing the free reprint’s confirmation takes none of the hours its parent held: the reprint is confirmed on them', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  await buy(w.a, [{ kind: 'credit_package', package_id: await expiringPackage(w, cat) }, { kind: 'material', variant_id: cat.white, quantity: 500 }]);
  const expiring = expiringLotOf(w, 'usr_pc_a');
  const { jobId } = await estimatedJob(w, w.a, cat, { seconds: 6 * H, materials: [{ variant_id: cat.white, model_grams: 20 }] });
  await runToPrinting(w, w.a, jobId);
  expire(w, expiring);
  const fail = await failByWorkshop(w, jobId);

  // The resolution gave the parent's 6 h back; just before the reprint's confirmation holds them again, the sweep runs.
  let swept: unknown = null;
  w.race.when = (sqls) => sqls.some((s) => s.includes('INSERT INTO pc_credit_reservation_lots'));
  w.race.hook = async () => {
    swept = (await sweepExpiry(w))?.status;
  };
  const resolved = await ok(w.assistant, 'POST', `${ADMIN}/failures/${fail.failure_id}/resolve`, { responsible: 'workshop', reprint: true });
  assert.equal(w.race.hook, null, 'the sweep ran between the resolution and the confirmation');
  assert.equal(swept, 'succeeded');
  assert.equal(resolved.reprint_status, 'queued', 'the free reprint is confirmed on the hours its parent held');
  assert.equal(expiredSeconds(w, expiring), 0, 'the sweep took none of them');
  assert.equal(remaining(w, expiring), 6 * H);
  assert.deepEqual(holdRows(w, resolved.reprint_job_id), [{ lot_id: expiring, seconds: 6 * H }]);
  assert.deepEqual(await balance(w, cat), [0, 6 * H]);

  await printToTheEnd(w, cat, resolved.reprint_job_id, 6 * H);
  assert.equal(consumedFrom(w, expiring), 6 * H, 'the reprint printed from them');
  const after = await credits(w.a, cat.tier);
  assert.deepEqual([after.available_seconds, after.reserved_seconds, after.consumed_seconds], [0, 0, 6 * H]);
  await reconcileClean(w);
});

/**
 * A free reprint the system could not confirm, waiting in `ready` for the
 * customer. A, with an expiring 6 h lot, a plain 6 h lot and 500 g of white:
 * the parent holds `parentHours` of the expiring lot and 20 g, and fails by
 * the workshop's fault once that lot has expired. Just before the reprint's
 * confirmation writes, A confirms another job of 481 g — more than was free
 * while the parent held its 20 g — so the reprint's grams are gone and it is
 * left for A.
 */
async function reprintWaiting(w: World, cat: Catalog, parentHours: number) {
  await buy(w.a, [{ kind: 'credit_package', package_id: await expiringPackage(w, cat) }, { kind: 'material', variant_id: cat.white, quantity: 500 }]);
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h6 }]);
  const expiring = expiringLotOf(w, 'usr_pc_a');
  const { jobId: parent } = await estimatedJob(w, w.a, cat, { seconds: parentHours * H, materials: [{ variant_id: cat.white, model_grams: 20 }] });
  await runToPrinting(w, w.a, parent);
  assert.deepEqual(holdRows(w, parent), [{ lot_id: expiring, seconds: parentHours * H }]);
  expire(w, expiring);
  const { jobId: other } = await estimatedJob(w, w.a, cat, { seconds: H, materials: [{ variant_id: cat.white, model_grams: 481 }], title: 'Other' });
  await ok(w.a, 'POST', `${API}/jobs/${other}/review`);
  const fail = await failByWorkshop(w, parent);
  w.race.when = (sqls) => sqls.some((s) => s.includes('INSERT INTO pc_credit_reservation_lots'));
  w.race.hook = async () => {
    await ok(w.a, 'POST', `${API}/jobs/${other}/confirm`, undefined, idem('confirm'));
  };
  const resolved = await ok(w.assistant, 'POST', `${ADMIN}/failures/${fail.failure_id}/resolve`, { responsible: 'workshop', reprint: true });
  assert.equal(w.race.hook, null, 'the other confirmation raced the reprint’s');
  assert.equal(resolved.reprint_status, 'waiting_for_customer');
  const reprint = resolved.reprint_job_id as string;
  assert.equal(status(w, reprint), 'ready');
  assert.deepEqual(holdRows(w, reprint), [], 'the reprint holds nothing yet');
  return { expiring, other, reprint };
}

/** The customer frees the grams (cancels the other job) and confirms the reprint by hand. */
async function confirmByHand(w: World, other: string, reprint: string) {
  await ok(w.a, 'POST', `${API}/jobs/${other}/cancel`, { reason: 'the reprint first' });
  await ok(w.a, 'POST', `${API}/jobs/${reprint}/review`);
  return ok(w.a, 'POST', `${API}/jobs/${reprint}/confirm`, undefined, idem('confirm'));
}

test('2: while the free reprint waits for the customer, the sweep leaves its parent’s hours; the customer’s own confirmation holds them', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const { expiring, other, reprint } = await reprintWaiting(w, cat, 6);

  assert.equal((await sweepExpiry(w))?.status, 'succeeded');
  assert.equal(expiredSeconds(w, expiring), 0, 'the hours the reprint is entitled to did not expire');
  assert.equal(remaining(w, expiring), 6 * H);
  assert.ok(!(await expiredLots(w.db, new Date())).some((l) => l.id === expiring), 'nor does the lot fill the expiry page');

  const confirmed = await confirmByHand(w, other, reprint);
  assert.equal(confirmed.status, 'queued');
  assert.deepEqual(holdRows(w, reprint), [{ lot_id: expiring, seconds: 6 * H }], 'confirmed by hand, it holds what its parent held — not the good hours');
  assert.equal((await sweepExpiry(w))?.status, 'succeeded');
  assert.equal(remaining(w, expiring), 6 * H, 'wholly held, the lot gives the sweep nothing');

  await printToTheEnd(w, cat, reprint, 6 * H);
  assert.equal(consumedFrom(w, expiring), 6 * H);
  assert.deepEqual(await balance(w, cat), [6 * H, 0]);
  await reconcileClean(w);
});

test('2: only the parent’s share waits for the reprint — the rest of the lot expires — and once the reprint is cancelled, that share expires too', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const { expiring, other, reprint } = await reprintWaiting(w, cat, 2);

  assert.equal((await sweepExpiry(w))?.status, 'succeeded');
  assert.deepEqual([remaining(w, expiring), expiredSeconds(w, expiring)], [2 * H, 4 * H], 'the 4 h the parent never held expire; its 2 h wait');
  assert.equal((await sweepExpiry(w))?.status, 'succeeded');
  assert.equal(remaining(w, expiring), 2 * H, 'and keep waiting, run after run');

  await ok(w.a, 'POST', `${API}/jobs/${reprint}/cancel`, { reason: 'no longer needed' });
  assert.equal((await sweepExpiry(w))?.status, 'succeeded');
  assert.deepEqual([remaining(w, expiring), expiredSeconds(w, expiring)], [0, 6 * H], 'cancelled, the reprint is entitled to nothing: normal expiry resumes');
  // The plain 6 h: 1 h held by the other job, 5 h free.
  assert.deepEqual(await balance(w, cat), [5 * H, H]);
  assert.equal(status(w, other), 'confirmed');
  await reconcileClean(w);
});

test('2: an entitlement that comes back while a sweep is in flight stops that sweep: the reprint, ready again, is confirmed on its parent’s hours', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const { expiring, other, reprint } = await reprintWaiting(w, cat, 6);
  // Edited back to a draft, the reprint is not waiting for a confirmation: the sweep plans to take the lot.
  await ok(w.a, 'PATCH', `${API}/jobs/${reprint}`, {});
  assert.equal(status(w, reprint), 'draft');
  // Just before the sweep's batch, the reprint is measured again and is ready: entitled again.
  w.race.when = (sqls) => sqls.some((s) => s.includes('INSERT INTO pc_credit_lot_draws'));
  w.race.hook = async () => {
    await ok(w.a, 'POST', `${API}/jobs/${reprint}/analyze`);
    await ok(w.assistant, 'POST', `${ADMIN}/jobs/${reprint}/estimate`, { duration_seconds: 6 * H, materials: [{ variant_id: cat.white, model_grams: 20 }], slicer_name: 'OrcaSlicer' });
  };
  const sweep = await sweepExpiry(w);
  assert.equal(w.race.hook, null, 'the reprint became ready while the sweep was in flight');
  assert.notEqual(sweep?.status, 'succeeded', 'the fenced sweep refused to take what the reprint is entitled to again');
  assert.equal(expiredSeconds(w, expiring), 0);
  assert.equal(remaining(w, expiring), 6 * H);
  assert.equal(status(w, reprint), 'ready');

  assert.equal((await sweepExpiry(w))?.status, 'succeeded', 'the next run finds nothing to expire');
  assert.equal(remaining(w, expiring), 6 * H);
  assert.equal((await confirmByHand(w, other, reprint)).status, 'queued');
  assert.deepEqual(holdRows(w, reprint), [{ lot_id: expiring, seconds: 6 * H }]);
  await reconcileClean(w);
});
