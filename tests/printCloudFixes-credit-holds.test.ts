/**
 * LEVONIS PRINT CLOUD — the third round: lot-level credit holds.
 *
 * A reservation used to name no lot, and every path inferred which seconds it
 * held from a «spend-order prefix». Each finding below was a gap in that
 * inference; a reservation now records the lots it holds
 * (`pc_credit_reservation_lots`, `pc_credit_lots.seconds_held`), so each is
 * pinned on recorded holds:
 *
 *   0  a job confirmed after an expiry holds only good hours: when an older
 *      job gives the expired lot back, the sweep takes ALL of it, and the
 *      later job never spends it;
 *   1  a balance change racing a confirmation cannot let the job hold
 *      expired hours (there is no expiry pre-pass left to race);
 *   2  a workshop failure after the package expired does not burn the hours
 *      the job legitimately held: the free reprint inherits them, and only
 *      its parent's own share;
 *   3  a credit line refunds only its lot's FREE part, and nothing once the
 *      lot has expired;
 *   4  the expiry page filters per lot, so lots wholly held for jobs never
 *      fill it and starve the lots that can expire;
 *   5  an admin balance debit draws only free hours that are still good;
 *
 * and the invariants the holds keep — a lot never holds more than it has
 * left (two confirmations racing for it: the loser re-plans), and
 * reconciliation proves every hold against its lot and its reservation.
 *
 * Run: node --import tsx --import ./scripts/test-no-network.mjs --test tests/printCloudFixes-credit-holds.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, API, buy, call, credits, estimatedJob, idem, ok, pcWorld, reconcileClean, refused, row, rows, runToPrinting, seedCatalog, type Catalog, type World } from './fixtures/printCloud';
import { expiredLots } from '../worker/lib/printCloud/credits';
import { enqueueTask } from '../worker/lib/printCloud/tasks';

const H = 3600;
const PAST = '2000-01-01T00:00:00.000Z';

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
  const key = `test-holds-expiry-${++sweeps}`;
  await w.db.batch([enqueueTask(w.db, { kind: 'expire_credit_lots', dedupeKey: key, now: new Date() })]);
  await w.runTasks();
  return row(w, 'SELECT status, last_error FROM pc_background_jobs WHERE dedupe_key = ?', key);
}

const remaining = (w: World, lotId: string) => row(w, 'SELECT seconds_remaining FROM pc_credit_lots WHERE id = ?', lotId)?.seconds_remaining;
const expiringLotOf = (w: World, userId: string) => row(w, "SELECT id FROM pc_credit_lots WHERE user_id = ? AND expires_at IS NOT NULL AND source = 'purchase'", userId)?.id as string;
const plainLotOf = (w: World, userId: string) => row(w, "SELECT id FROM pc_credit_lots WHERE user_id = ? AND expires_at IS NULL AND source = 'purchase'", userId)?.id as string;
const expire = (w: World, lotId: string, at = PAST) => w.raw.prepare('UPDATE pc_credit_lots SET expires_at = ? WHERE id = ?').run(at, lotId);
const expiredSeconds = (w: World, lotId: string) => Number(row(w, "SELECT COALESCE(-SUM(delta_available), 0) AS s FROM pc_credit_ledger WHERE entry_type = 'expire' AND lot_id = ?", lotId)?.s);
/** Seconds a job's settlement drew from a lot. */
const consumedFrom = (w: World, lotId: string) => Number(row(w, "SELECT COALESCE(SUM(seconds), 0) AS s FROM pc_credit_lot_draws WHERE lot_id = ? AND ledger_entry_key LIKE 'consume:%'", lotId)?.s);
const balance = async (w: World, cat: Catalog) => {
  const c = await credits(w.a, cat.tier);
  return [c.available_seconds, c.reserved_seconds];
};

async function confirm(w: World, jobId: string) {
  await ok(w.a, 'POST', `${API}/jobs/${jobId}/review`);
  return ok(w.a, 'POST', `${API}/jobs/${jobId}/confirm`, undefined, idem('confirm'));
}

/** After confirmation: approval if the workshop asks for it, a machine, printing. */
async function toPrinting(w: World, jobId: string) {
  if (row(w, 'SELECT status FROM pc_print_jobs WHERE id = ?', jobId)?.status === 'confirmed') await ok(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/approve`);
  await ok(w.assistant, 'POST', `${ADMIN}/queue/run`);
  await ok(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/start`);
}

const complete = (w: World, cat: Catalog, jobId: string, seconds: number) =>
  ok(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/complete`, { printed_seconds: seconds, materials: [{ variant_id: cat.white, qty: 20 }] });

/** An expiring 6 h lot and a plain 6 h lot for A, with 500 g of white to print with. */
async function twoLots(w: World, cat: Catalog) {
  await buy(w.a, [{ kind: 'credit_package', package_id: await expiringPackage(w, cat) }, { kind: 'material', variant_id: cat.white, quantity: 500 }]);
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h6 }]);
  return { expiring: expiringLotOf(w, 'usr_pc_a'), plain: plainLotOf(w, 'usr_pc_a') };
}

// ------------------------------------------------------------------ 0

test('0: a job confirmed after an expiry holds only good hours — when the older job gives the expired lot back, the sweep takes all of it', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const { expiring, plain } = await twoLots(w, cat);
  const { jobId: j1 } = await estimatedJob(w, w.a, cat, { seconds: 6 * H, materials: [{ variant_id: cat.white, model_grams: 20 }] });
  await confirm(w, j1);
  // J1 was confirmed before the expiry and holds the expiring lot (spend order: expiring first).
  expire(w, expiring);
  const { jobId: j2 } = await estimatedJob(w, w.a, cat, { seconds: 3 * H, materials: [{ variant_id: cat.white, model_grams: 20 }], title: 'Second' });
  await confirm(w, j2);
  assert.equal(remaining(w, expiring), 6 * H);

  await ok(w.a, 'POST', `${API}/jobs/${j1}/cancel`, { reason: 'changed my mind' });
  assert.equal((await sweepExpiry(w))?.status, 'succeeded');
  assert.equal(remaining(w, expiring), 0, 'all J1 gave back expires: J2 never held the expired lot');
  assert.equal(expiredSeconds(w, expiring), 6 * H);
  assert.deepEqual(await balance(w, cat), [3 * H, 3 * H]);

  await toPrinting(w, j2);
  await complete(w, cat, j2, 3 * H);
  assert.equal(consumedFrom(w, expiring), 0, 'J2 spent none of the expired package');
  assert.equal(remaining(w, plain), 3 * H, 'J2 printed from the hours that were still good');
  assert.deepEqual(await balance(w, cat), [3 * H, 0]);
  await reconcileClean(w);
});

test('0: what a job confirmed before the expiry gives back at settlement expires whole, even with a later job open', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const { expiring, plain } = await twoLots(w, cat);
  const { jobId: j1 } = await estimatedJob(w, w.a, cat, { seconds: 6 * H, materials: [{ variant_id: cat.white, model_grams: 20 }] });
  await runToPrinting(w, w.a, j1);
  expire(w, expiring);
  const { jobId: j2 } = await estimatedJob(w, w.a, cat, { seconds: 3 * H, materials: [{ variant_id: cat.white, model_grams: 20 }], title: 'Second' });
  await confirm(w, j2);
  // J1 prints 2 h of its 6: it draws them from the lot it held and gives the other 4 h back.
  await complete(w, cat, j1, 2 * H);
  assert.deepEqual([remaining(w, expiring), consumedFrom(w, expiring)], [4 * H, 2 * H]);
  assert.equal((await sweepExpiry(w))?.status, 'succeeded');
  assert.equal(remaining(w, expiring), 0, 'all 4 h given back expire');
  assert.equal(remaining(w, plain), 6 * H, "J2's 3 h are held on the plain lot");
  assert.deepEqual(await balance(w, cat), [3 * H, 3 * H]);
  await reconcileClean(w);
});

// ------------------------------------------------------------------ 1

test('1: a balance change racing a confirmation never lets the job hold expired hours', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const { expiring } = await twoLots(w, cat);
  expire(w, expiring);
  const { jobId } = await estimatedJob(w, w.a, cat, { seconds: 6 * H, materials: [{ variant_id: cat.white, model_grams: 20 }] });
  await ok(w.a, 'POST', `${API}/jobs/${jobId}/review`);
  // Just before the confirmation first writes to the customer's lots, another purchase lands.
  w.race.when = (sqls) => sqls.some((s) => s.includes('UPDATE pc_credit_lots'));
  w.race.hook = async () => {
    await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h6 }]);
  };
  const confirmed = await ok(w.a, 'POST', `${API}/jobs/${jobId}/confirm`, undefined, idem('confirm'));
  assert.equal(w.race.hook, null, 'the purchase raced the confirmation');
  assert.equal(confirmed.reserved_seconds, 6 * H);
  assert.equal(remaining(w, expiring), 6 * H);

  assert.equal((await sweepExpiry(w))?.status, 'succeeded');
  assert.equal(remaining(w, expiring), 0, 'the job holds none of the expired lot, so all of it expires');
  assert.deepEqual(await balance(w, cat), [6 * H, 6 * H]);
  await toPrinting(w, jobId);
  await complete(w, cat, jobId, 6 * H);
  assert.equal(consumedFrom(w, expiring), 0);
  assert.deepEqual(await balance(w, cat), [6 * H, 0]);
  await reconcileClean(w);
});

// ------------------------------------------------------------------ 2

/** The workshop fails the print and the operator resolves it with a free reprint. */
async function workshopFailure(w: World, jobId: string) {
  const fail = await ok(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/fail`, { reason_code: 'NOZZLE_CLOG', responsible: 'workshop', printed_seconds: 600 });
  return ok(w.assistant, 'POST', `${ADMIN}/failures/${fail.failure_id}/resolve`, { responsible: 'workshop', reprint: true });
}

test('2: a workshop failure after the package expired does not burn the hours the job held: the free reprint inherits them', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  await buy(w.a, [{ kind: 'credit_package', package_id: await expiringPackage(w, cat) }, { kind: 'material', variant_id: cat.white, quantity: 500 }]);
  const expiring = expiringLotOf(w, 'usr_pc_a');
  const { jobId } = await estimatedJob(w, w.a, cat, { seconds: 6 * H, materials: [{ variant_id: cat.white, model_grams: 20 }] });
  await runToPrinting(w, w.a, jobId);
  expire(w, expiring);

  const resolved = await workshopFailure(w, jobId);
  assert.equal(resolved.reprint_status, 'queued', 'the free reprint is confirmed on the hours its parent held');
  assert.equal(remaining(w, expiring), 6 * H);
  assert.equal(expiredSeconds(w, expiring), 0, 'nothing expired between the failure and the reprint');
  assert.equal(row(w, "SELECT seconds_reserved FROM pc_credit_reservations WHERE job_id = ? AND state = 'active'", resolved.reprint_job_id)?.seconds_reserved, 6 * H);
  assert.deepEqual(await balance(w, cat), [0, 6 * H]);

  // Wholly held by the reprint, the lot gives the sweep nothing; the reprint prints from it.
  assert.equal((await sweepExpiry(w))?.status, 'succeeded');
  assert.equal(remaining(w, expiring), 6 * H);
  await toPrinting(w, resolved.reprint_job_id);
  await complete(w, cat, resolved.reprint_job_id, 6 * H);
  assert.equal(consumedFrom(w, expiring), 6 * H);
  const after = await credits(w.a, cat.tier);
  assert.deepEqual([after.available_seconds, after.reserved_seconds, after.consumed_seconds], [0, 0, 6 * H]);
  await reconcileClean(w);
});

test('2: with good hours beside them, the reprint still takes the inherited ones — and only its parent’s own share of the expired lot', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const { expiring, plain } = await twoLots(w, cat);
  // The parent holds 2 h of the expiring lot; the lot's other 4 h are free when it expires.
  const { jobId } = await estimatedJob(w, w.a, cat, { seconds: 2 * H, materials: [{ variant_id: cat.white, model_grams: 20 }] });
  await runToPrinting(w, w.a, jobId);
  expire(w, expiring);

  const resolved = await workshopFailure(w, jobId);
  assert.equal(resolved.reprint_status, 'queued');
  assert.deepEqual([remaining(w, expiring), remaining(w, plain)], [6 * H, 6 * H], 'nothing expired yet, and the reprint did not move onto the good hours');
  assert.deepEqual(
    rows(w, 'SELECT h.lot_id, h.seconds FROM pc_credit_reservation_lots h JOIN pc_credit_reservations r ON r.id = h.reservation_id WHERE r.job_id = ?', resolved.reprint_job_id),
    [{ lot_id: expiring, seconds: 2 * H }],
    'the reprint holds what its parent held, not the good hours'
  );
  // The 4 h the parent never held were never its to pass on: they expire.
  assert.equal((await sweepExpiry(w))?.status, 'succeeded');
  assert.deepEqual([remaining(w, expiring), expiredSeconds(w, expiring)], [2 * H, 4 * H]);
  assert.deepEqual(await balance(w, cat), [6 * H, 2 * H]);
  await reconcileClean(w);
});

// ------------------------------------------------------------------ 3

test('3: after a partial expiry, the held remainder of an expired lot is not refundable as money', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const orderId = await buy(w.a, [{ kind: 'credit_package', package_id: await expiringPackage(w, cat) }, { kind: 'material', variant_id: cat.white, quantity: 500 }]);
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h6 }]);
  const expiring = expiringLotOf(w, 'usr_pc_a');
  const line = (await ok(w.full, 'GET', `${ADMIN}/orders/${orderId}`)).lines.find((l: { kind: string }) => l.kind === 'credit_package');
  const { jobId } = await estimatedJob(w, w.a, cat, { seconds: 4 * H, materials: [{ variant_id: cat.white, model_grams: 20 }] });
  await confirm(w, jobId);
  expire(w, expiring);
  await sweepExpiry(w);
  assert.equal(remaining(w, expiring), 4 * H, 'the 4 h the job holds stay for it');

  const r = await refused(w.full, 'POST', `${ADMIN}/orders/${orderId}/refunds`, { line_id: line.id, reason: 'unused' }, 'INSUFFICIENT_CREDIT', idem('rf'));
  assert.equal(r.details.refundable_seconds, 0);
  assert.equal(remaining(w, expiring), 4 * H);
  // Given back, those 4 h expire like the rest: no refund, and the good hours are all that is left.
  await ok(w.a, 'POST', `${API}/jobs/${jobId}/cancel`, { reason: 'changed my mind' });
  await sweepExpiry(w);
  assert.equal(remaining(w, expiring), 0);
  assert.deepEqual(await balance(w, cat), [6 * H, 0]);
  assert.equal(Number(row(w, 'SELECT COUNT(*) AS n FROM pc_refunds WHERE order_id = ?', orderId)?.n), 0);
  await reconcileClean(w);
});

test('3: before the expiry a credit line refunds only its own lot’s free part, never seconds a job holds there', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const orderId = await buy(w.a, [{ kind: 'credit_package', package_id: await expiringPackage(w, cat) }, { kind: 'material', variant_id: cat.white, quantity: 500 }]);
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h6 }]);
  const expiring = expiringLotOf(w, 'usr_pc_a');
  const line = (await ok(w.full, 'GET', `${ADMIN}/orders/${orderId}`)).lines.find((l: { kind: string }) => l.kind === 'credit_package');
  const { jobId } = await estimatedJob(w, w.a, cat, { seconds: 4 * H, materials: [{ variant_id: cat.white, model_grams: 20 }] });
  await confirm(w, jobId);
  // The job holds 4 h of the lot; the account's 8 free hours do not make them refundable.
  const tooMuch = await refused(w.full, 'POST', `${ADMIN}/orders/${orderId}/refunds`, { line_id: line.id, quantity: 3 * H, reason: 'unused' }, 'INSUFFICIENT_CREDIT', idem('rf'));
  assert.equal(tooMuch.details.refundable_seconds, 2 * H);
  const refund = await ok(w.full, 'POST', `${ADMIN}/orders/${orderId}/refunds`, { line_id: line.id, reason: 'unused' }, idem('rf'));
  assert.deepEqual([refund.quantity, refund.amount_iqd], [2 * H, 3000]);
  assert.equal(remaining(w, expiring), 4 * H);
  await toPrinting(w, jobId);
  await complete(w, cat, jobId, 4 * H);
  assert.equal(consumedFrom(w, expiring), 4 * H, 'the job printed from the lot it held');
  assert.deepEqual(await balance(w, cat), [6 * H, 0]);
  await reconcileClean(w);
});

// ------------------------------------------------------------------ 4

test('4: lots wholly held for jobs never fill the expiry page, so every lot that can expire is reached', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  await buy(w.a, [{ kind: 'material', variant_id: cat.white, quantity: 500 }]);
  for (let i = 0; i < 51; i++) {
    await ok(w.full, 'POST', `${ADMIN}/customers/usr_pc_a/credits/adjust`, { tier_id: cat.tier, seconds: H, reason: `goodwill ${i}` }, idem('adj'));
  }
  const { jobId } = await estimatedJob(w, w.a, cat, { seconds: 50 * H, materials: [{ variant_id: cat.white, model_grams: 20 }] });
  await confirm(w, jobId);
  // The job holds the first 50 lots in spend order (oldest first); they expire earliest.
  const lots = rows(w, "SELECT id FROM pc_credit_lots WHERE user_id = 'usr_pc_a' ORDER BY created_at, id").map((l) => l.id as string);
  lots.forEach((id, i) => expire(w, id, `2000-01-01T00:${String(i).padStart(2, '0')}:00.000Z`));
  await buy(w.b, [{ kind: 'credit_package', package_id: await expiringPackage(w, cat) }]);
  const theirs = expiringLotOf(w, 'usr_pc_b');
  expire(w, theirs, '2000-02-01T00:00:00.000Z');

  const page = await expiredLots(w.db, new Date());
  assert.deepEqual(page.map((l) => l.id), [lots[50], theirs], 'only lots with a free part fill the page');
  assert.equal((await sweepExpiry(w))?.status, 'succeeded');
  assert.deepEqual([remaining(w, lots[50]), remaining(w, theirs)], [0, 0]);
  assert.equal((await credits(w.b, cat.tier)).available_seconds, 0);
  assert.equal(Number(row(w, "SELECT COUNT(*) AS n FROM pc_credit_ledger WHERE entry_type = 'expire'")?.n), 2);
  // A's expired free hour is gone, not shielded by a later confirmation.
  const { jobId: more } = await estimatedJob(w, w.a, cat, { seconds: H, materials: [{ variant_id: cat.white, model_grams: 20 }], title: 'One more' });
  await ok(w.a, 'POST', `${API}/jobs/${more}/review`);
  await refused(w.a, 'POST', `${API}/jobs/${more}/confirm`, undefined, 'INSUFFICIENT_CREDIT', idem('confirm'));
  assert.deepEqual(await balance(w, cat), [0, 50 * H]);
  await reconcileClean(w);
});

// ------------------------------------------------------------------ 5

test('5: an admin balance debit after an expiry draws only hours that are still good', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const { expiring, plain } = await twoLots(w, cat);
  expire(w, expiring);
  const adjust = (seconds: number) => call(w.full, 'POST', `${ADMIN}/customers/usr_pc_a/credits/adjust`, { tier_id: cat.tier, seconds, reason: 'correction' }, idem('adj'));
  assert.equal((await adjust(-6 * H)).status, 200);
  assert.deepEqual([remaining(w, expiring), remaining(w, plain)], [6 * H, 0], 'the debit drew the good hours, not the expired ones');
  // Only expired hours are left: a further debit has nothing to take.
  assert.equal((await adjust(-H)).json.code, 'INSUFFICIENT_CREDIT');
  assert.equal((await sweepExpiry(w))?.status, 'succeeded');
  assert.equal(remaining(w, expiring), 0);
  assert.deepEqual(await balance(w, cat), [0, 0]);
  await reconcileClean(w);
});

// ------------------------------------------------------------------ the invariants

test('two confirmations racing for the last good hours: the lot refuses the second hold, which re-plans and is refused for credit', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const { expiring, plain } = await twoLots(w, cat);
  expire(w, expiring);
  const { jobId: first } = await estimatedJob(w, w.a, cat, { seconds: 6 * H, materials: [{ variant_id: cat.white, model_grams: 20 }] });
  const { jobId: second } = await estimatedJob(w, w.a, cat, { seconds: 6 * H, materials: [{ variant_id: cat.white, model_grams: 20 }], title: 'Second' });
  await ok(w.a, 'POST', `${API}/jobs/${first}/review`);
  await ok(w.a, 'POST', `${API}/jobs/${second}/review`);
  // Both plan to hold the plain lot. The unswept expired hours keep the account's available balance
  // covering both, so only the lot's own CHECK can refuse the second hold.
  w.race.when = (sqls) => sqls.some((s) => s.includes('INSERT INTO pc_credit_reservation_lots'));
  w.race.hook = async () => {
    await ok(w.a, 'POST', `${API}/jobs/${second}/confirm`, undefined, idem('confirm'));
  };
  await refused(w.a, 'POST', `${API}/jobs/${first}/confirm`, undefined, 'INSUFFICIENT_CREDIT', idem('confirm'));
  assert.equal(w.race.hook, null, 'the competing confirmation ran');
  assert.deepEqual(row(w, 'SELECT seconds_remaining, seconds_held FROM pc_credit_lots WHERE id = ?', plain), { seconds_remaining: 6 * H, seconds_held: 6 * H });
  assert.equal(row(w, 'SELECT seconds_held FROM pc_credit_lots WHERE id = ?', expiring)?.seconds_held, 0);
  assert.equal(Number(row(w, 'SELECT COUNT(*) AS n FROM pc_credit_reservations WHERE job_id = ?', first)?.n), 0);
  await reconcileClean(w);
});

const failingChecks = async (w: World) =>
  (await ok(w.owner, 'GET', `${ADMIN}/reconcile`)).checks.filter((c: { ok: boolean; name: string }) => !c.ok && c.name !== 'payments_needing_refund').map((c: { name: string }) => c.name);

test('holds are recorded per lot, and reconciliation proves each of them: a hold moved or invented is reported, never repaired', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const { expiring, plain } = await twoLots(w, cat);
  await buy(w.b, [{ kind: 'credit_package', package_id: cat.packages.h6 }]);
  const theirs = plainLotOf(w, 'usr_pc_b');
  const { jobId } = await estimatedJob(w, w.a, cat, { seconds: 8 * H, materials: [{ variant_id: cat.white, model_grams: 20 }] });
  await confirm(w, jobId);
  const reservation = row(w, "SELECT id FROM pc_credit_reservations WHERE job_id = ? AND state = 'active'", jobId)?.id as string;
  // 8 h held in spend order: the whole expiring lot first, then 2 h of the plain one.
  assert.deepEqual(rows(w, 'SELECT lot_id, seconds FROM pc_credit_reservation_lots WHERE reservation_id = ? ORDER BY rowid', reservation), [
    { lot_id: expiring, seconds: 6 * H },
    { lot_id: plain, seconds: 2 * H },
  ]);
  const held = (id: string) => row(w, 'SELECT seconds_held FROM pc_credit_lots WHERE id = ?', id)?.seconds_held;
  assert.deepEqual([held(expiring), held(plain)], [6 * H, 2 * H]);
  assert.deepEqual(await balance(w, cat), [4 * H, 8 * H]);
  await reconcileClean(w);

  // The database refuses a lot holding more than it has, and an edited or deleted hold row.
  assert.throws(() => w.raw.prepare('UPDATE pc_credit_lots SET seconds_held = seconds_remaining + 1 WHERE id = ?').run(plain), /ck_pc_credit_lot_held/);
  assert.throws(() => w.raw.exec('UPDATE pc_credit_reservation_lots SET seconds = 1'), /PC_APPEND_ONLY/);
  assert.throws(() => w.raw.exec('DELETE FROM pc_credit_reservation_lots'), /PC_APPEND_ONLY/);

  // An hour of hold moved from one lot to the other: every total still agrees, the per-lot check does not.
  const move = (from: string, to: string) => {
    w.raw.prepare('UPDATE pc_credit_lots SET seconds_held = seconds_held - ? WHERE id = ?').run(H, from);
    w.raw.prepare('UPDATE pc_credit_lots SET seconds_held = seconds_held + ? WHERE id = ?').run(H, to);
  };
  move(expiring, plain);
  assert.deepEqual(await failingChecks(w), ['credit_lot_holds_equal_active_reservations']);
  move(plain, expiring);
  await reconcileClean(w);

  // A hold row on another customer's lot: the reservation no longer equals its holds, nor that lot its holds.
  w.raw.prepare('INSERT INTO pc_credit_reservation_lots (reservation_id, lot_id, seconds, created_at) VALUES (?, ?, ?, ?)').run(reservation, theirs, H, PAST);
  assert.deepEqual((await failingChecks(w)).sort(), ['credit_lot_holds_equal_active_reservations', 'credit_reservations_equal_their_holds']);
  assert.equal(held(theirs), 0, 'reported, never repaired');
});
