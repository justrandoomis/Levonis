/**
 * LEVONIS PRINT CLOUD — review fixes, credits and background tasks:
 *
 *   c1  an expired lot gives up only its FREE part: the seconds confirmed
 *       jobs hold on it stay for their jobs, and a confirmation landing while
 *       the expiry is planned holds none of it (round 3: holds are recorded
 *       per lot, so it no longer races the planned batch);
 *   c5  a lot that expired while partly reserved finishes expiring once its
 *       job gives seconds back, a lot whose holds change under a planned
 *       expiry refuses that batch visibly, and one lot that cannot expire
 *       never holds back the lots behind it;
 *   c14 a runner that died in a task's last attempt leaves it dead, not
 *       reclaimed forever, and a crashed attempt backs off behind fresh work;
 *   c19 converted hours keep the expiry they were bought under, and a
 *       conversion takes only hours that are free and not yet expired.
 *
 * Run: node --import tsx --import ./scripts/test-no-network.mjs --test tests/printCloudFixes-credits-tasks.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, API, buy, credits, estimatedJob, idem, ok, pcWorld, reconcileClean, row, rows, runToPrinting, seedCatalog, type Catalog, type World } from './fixtures/printCloud';
import { runPrintCloudTasks } from '../worker/lib/printCloud/background';
import { enqueueTask } from '../worker/lib/printCloud/tasks';

const H = 3600;
const PAST = '2000-01-01T00:00:00.000Z';

/** A 6 h package the owner set to expire 30 days after purchase (stated on the quote). */
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
  const key = `test-expiry-${++sweeps}`;
  await w.db.batch([enqueueTask(w.db, { kind: 'expire_credit_lots', dedupeKey: key, now: new Date() })]);
  await w.runTasks();
  return row(w, 'SELECT id, status, attempts, last_error FROM pc_background_jobs WHERE dedupe_key = ?', key);
}

const lot = (w: World, id: string) => row(w, 'SELECT id, seconds_remaining, expires_at FROM pc_credit_lots WHERE id = ?', id);
const expiringLotOf = (w: World, userId: string) => row(w, "SELECT id FROM pc_credit_lots WHERE user_id = ? AND expires_at IS NOT NULL AND source = 'purchase'", userId)?.id as string;
const plainLotOf = (w: World, userId: string) => row(w, "SELECT id FROM pc_credit_lots WHERE user_id = ? AND expires_at IS NULL AND source = 'purchase'", userId)?.id as string;
const expiries = (w: World, lotId: string) => rows(w, "SELECT entry_key, delta_available FROM pc_credit_ledger WHERE entry_type = 'expire' AND lot_id = ? ORDER BY created_at, entry_key", lotId);

/** After confirmation: approval if the workshop asks for it, a machine, printing. */
async function toPrinting(w: World, jobId: string) {
  const job = await ok(w.a, 'GET', `${API}/jobs/${jobId}`);
  if (job.status === 'confirmed') await ok(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/approve`);
  await ok(w.assistant, 'POST', `${ADMIN}/queue/run`);
  await ok(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/start`);
}

// ------------------------------------------------------------------ c1

test('c1: an expired lot whose hours a confirmed job holds expires nothing, and never burns hours that do not expire', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const pkg = await expiringPackage(w, cat);
  await buy(w.a, [{ kind: 'credit_package', package_id: pkg }, { kind: 'material', variant_id: cat.white, quantity: 500 }]);
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h6 }]);
  const expiring = expiringLotOf(w, 'usr_pc_a');
  const plain = plainLotOf(w, 'usr_pc_a');
  const { jobId } = await estimatedJob(w, w.a, cat, { seconds: 6 * H, materials: [{ variant_id: cat.white, model_grams: 30 }] });
  await runToPrinting(w, w.a, jobId);
  assert.deepEqual([(await credits(w.a, cat.tier)).available_seconds, (await credits(w.a, cat.tier)).reserved_seconds], [6 * H, 6 * H]);

  // The job will draw the expiring lot first (spend order): all of it is held.
  w.raw.prepare('UPDATE pc_credit_lots SET expires_at = ? WHERE id = ?').run(PAST, expiring);
  assert.equal((await sweepExpiry(w))?.status, 'succeeded');
  assert.equal(lot(w, expiring)?.seconds_remaining, 6 * H, 'nothing of a fully reserved lot expires');
  assert.deepEqual(expiries(w, expiring), []);
  assert.equal((await credits(w.a, cat.tier)).available_seconds, 6 * H);

  // 5 h printed: drawn from the expired lot, 1 h given back — and that 1 h, now free, expires on the next run.
  await ok(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/complete`, { printed_seconds: 5 * H, materials: [{ variant_id: cat.white, qty: 30 }] });
  assert.deepEqual([lot(w, expiring)?.seconds_remaining, lot(w, plain)?.seconds_remaining], [1 * H, 6 * H]);
  assert.equal((await sweepExpiry(w))?.status, 'succeeded');
  assert.deepEqual(
    expiries(w, expiring).map((e) => e.delta_available),
    [-1 * H]
  );
  assert.deepEqual([lot(w, expiring)?.seconds_remaining, lot(w, plain)?.seconds_remaining], [0, 6 * H], 'the hours that never expire are untouched');
  const after = await credits(w.a, cat.tier);
  assert.deepEqual([after.available_seconds, after.reserved_seconds, after.consumed_seconds], [6 * H, 0, 5 * H]);
  await reconcileClean(w);
});

test('c1: only the free part of an expired lot expires, beyond what the open reservations hold', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const pkg = await expiringPackage(w, cat);
  await buy(w.a, [{ kind: 'credit_package', package_id: pkg }, { kind: 'material', variant_id: cat.white, quantity: 500 }]);
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h6 }]);
  const expiring = expiringLotOf(w, 'usr_pc_a');
  const { jobId } = await estimatedJob(w, w.a, cat, { seconds: 2 * H, materials: [{ variant_id: cat.white, model_grams: 30 }] });
  await runToPrinting(w, w.a, jobId);
  w.raw.prepare('UPDATE pc_credit_lots SET expires_at = ? WHERE id = ?').run(PAST, expiring);
  await sweepExpiry(w);
  // 2 h of the expired lot are held for the job; the other 4 h expire. The 6 h that never expire stay available.
  assert.equal(lot(w, expiring)?.seconds_remaining, 2 * H);
  assert.deepEqual([(await credits(w.a, cat.tier)).available_seconds, (await credits(w.a, cat.tier)).reserved_seconds], [6 * H, 2 * H]);
  await ok(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/complete`, { printed_seconds: 2 * H, materials: [{ variant_id: cat.white, qty: 30 }] });
  assert.equal(lot(w, expiring)?.seconds_remaining, 0, 'the job drew exactly the held seconds');
  assert.equal((await credits(w.a, cat.tier)).available_seconds, 6 * H);
  await reconcileClean(w);
});

test('c1: a confirmation landing while an expiry is planned holds none of the expired lot, and the planned expiry still lands', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const pkg = await expiringPackage(w, cat);
  await buy(w.a, [{ kind: 'credit_package', package_id: pkg }, { kind: 'material', variant_id: cat.white, quantity: 500 }]);
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h6 }]);
  await buy(w.b, [{ kind: 'credit_package', package_id: pkg }]);
  const mine = expiringLotOf(w, 'usr_pc_a');
  const plain = plainLotOf(w, 'usr_pc_a');
  const theirs = expiringLotOf(w, 'usr_pc_b');
  const { jobId } = await estimatedJob(w, w.a, cat, { seconds: 6 * H, materials: [{ variant_id: cat.white, model_grams: 30 }] });
  await ok(w.a, 'POST', `${API}/jobs/${jobId}/review`);
  w.raw.prepare('UPDATE pc_credit_lots SET expires_at = ? WHERE id = ?').run(PAST, mine);
  w.raw.prepare('UPDATE pc_credit_lots SET expires_at = ? WHERE id = ?').run('2000-01-02T00:00:00.000Z', theirs);
  // Just before the sweep's first expiry batch commits, the customer confirms a 6 h job. The lot had already
  // expired, so the job holds only the plain hours, and the lot's free part — the expiry's plan — is unchanged.
  w.race.when = (sqls) => sqls.some((s) => s.includes('INSERT INTO pc_credit_lot_draws'));
  w.race.hook = async () => {
    await ok(w.a, 'POST', `${API}/jobs/${jobId}/confirm`, undefined, idem('confirm'));
  };
  const task = await sweepExpiry(w);
  assert.equal(w.race.hook, null, 'the race ran');
  assert.equal(task?.status, 'succeeded', String(task?.last_error));
  assert.deepEqual([lot(w, mine)?.seconds_remaining, lot(w, theirs)?.seconds_remaining], [0, 0], 'both expired lots expire whole');
  assert.deepEqual([(await credits(w.a, cat.tier)).available_seconds, (await credits(w.a, cat.tier)).reserved_seconds], [0, 6 * H]);
  await toPrinting(w, jobId);
  await ok(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/complete`, { printed_seconds: 6 * H, materials: [{ variant_id: cat.white, qty: 30 }] });
  assert.deepEqual([lot(w, mine)?.seconds_remaining, lot(w, plain)?.seconds_remaining], [0, 0], 'the job drew the hours that were still good');
  assert.equal((await credits(w.a, cat.tier)).available_seconds, 0);
  await reconcileClean(w);
});

test('c5: an expired lot whose holds change while its expiry is planned refuses the batch; the lot behind it still expires, the failure stays visible, and the next run finishes it', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const pkg = await expiringPackage(w, cat);
  await buy(w.a, [{ kind: 'credit_package', package_id: pkg }, { kind: 'material', variant_id: cat.white, quantity: 500 }]);
  await buy(w.b, [{ kind: 'credit_package', package_id: pkg }]);
  const mine = expiringLotOf(w, 'usr_pc_a');
  const theirs = expiringLotOf(w, 'usr_pc_b');
  // Confirmed before the expiry, the job holds 2 h of the lot; the other 4 h are free when it expires.
  const { jobId } = await estimatedJob(w, w.a, cat, { seconds: 2 * H, materials: [{ variant_id: cat.white, model_grams: 30 }] });
  await runToPrinting(w, w.a, jobId);
  w.raw.prepare('UPDATE pc_credit_lots SET expires_at = ? WHERE id = ?').run(PAST, mine);
  w.raw.prepare('UPDATE pc_credit_lots SET expires_at = ? WHERE id = ?').run('2000-01-02T00:00:00.000Z', theirs);
  // Just before the sweep expires those 4 h, the job completes at 1 h and gives its other hour back to the lot.
  w.race.when = (sqls) => sqls.some((s) => s.includes('INSERT INTO pc_credit_lot_draws')) && sqls.some((s) => s.includes('seconds_held = ?'));
  w.race.hook = async () => {
    await ok(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/complete`, { printed_seconds: H, materials: [{ variant_id: cat.white, qty: 30 }] });
  };
  const task = await sweepExpiry(w);
  assert.equal(w.race.hook, null, 'the race ran');
  assert.equal(lot(w, mine)?.seconds_remaining, 5 * H, 'the planned batch saw other holds and was refused');
  assert.equal(lot(w, theirs)?.seconds_remaining, 0, "another customer's lot behind it still expires");
  assert.equal(task?.status, 'queued', 'the refused batch fails the task: retried, not hidden');
  assert.match(String(task?.last_error), /expired lots 1, failed 1/);
  // The next run expires everything the lot has left: the 4 h that were free and the hour given back.
  assert.equal((await sweepExpiry(w))?.status, 'succeeded');
  assert.equal(lot(w, mine)?.seconds_remaining, 0);
  assert.deepEqual(expiries(w, mine).map((e) => e.delta_available), [-5 * H]);
  assert.deepEqual([(await credits(w.a, cat.tier)).available_seconds, (await credits(w.a, cat.tier)).consumed_seconds], [0, H]);
  await reconcileClean(w);
});

// ------------------------------------------------------------------ c5

test('c5: a lot that expired while partly reserved finishes expiring when the job gives its seconds back, and later lots still expire', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const pkg = await expiringPackage(w, cat);
  await buy(w.a, [{ kind: 'credit_package', package_id: pkg }, { kind: 'material', variant_id: cat.white, quantity: 500 }]);
  const mine = expiringLotOf(w, 'usr_pc_a');
  const { jobId } = await estimatedJob(w, w.a, cat, { seconds: H, materials: [{ variant_id: cat.white, model_grams: 30 }] });
  await ok(w.a, 'POST', `${API}/jobs/${jobId}/review`);
  await ok(w.a, 'POST', `${API}/jobs/${jobId}/confirm`, undefined, idem('confirm'));
  w.raw.prepare('UPDATE pc_credit_lots SET expires_at = ? WHERE id = ?').run(PAST, mine);
  assert.equal((await sweepExpiry(w))?.status, 'succeeded');
  assert.equal(lot(w, mine)?.seconds_remaining, H, 'the reserved hour stays for its job');
  assert.equal((await credits(w.a, cat.tier)).available_seconds, 0);

  // The job is cancelled: its hour is free again. Another customer's lot expires later than this one.
  await ok(w.a, 'POST', `${API}/jobs/${jobId}/cancel`, { reason: 'changed my mind' });
  assert.equal((await credits(w.a, cat.tier)).available_seconds, H);
  await buy(w.b, [{ kind: 'credit_package', package_id: pkg }]);
  const theirs = expiringLotOf(w, 'usr_pc_b');
  w.raw.prepare('UPDATE pc_credit_lots SET expires_at = ? WHERE id = ?').run('2000-01-02T00:00:00.000Z', theirs);

  const task = await sweepExpiry(w);
  assert.equal(task?.status, 'succeeded', String(task?.last_error));
  assert.deepEqual([lot(w, mine)?.seconds_remaining, lot(w, theirs)?.seconds_remaining], [0, 0]);
  const passes = expiries(w, mine);
  assert.deepEqual(passes.map((e) => e.delta_available).sort((x, y) => x - y), [-5 * H, -H], 'two passes over the same lot');
  assert.equal(new Set(passes.map((e) => e.entry_key)).size, 2, 'each pass has its own entry key');
  assert.equal((await credits(w.a, cat.tier)).available_seconds, 0);
  assert.equal((await credits(w.b, cat.tier)).available_seconds, 0);
  // Nothing is left to do: a further run expires nothing and fails nothing.
  assert.equal((await sweepExpiry(w))?.status, 'succeeded');
  assert.equal(expiries(w, mine).length, 2);
  await reconcileClean(w);
});

// ------------------------------------------------------------------ c14

const insertTask = (w: World, id: string, status: string, attempts: number, maxAttempts: number, runAfter: string, leaseUntil: string | null) =>
  w.raw
    .prepare(
      `INSERT INTO pc_background_jobs (id, kind, payload_json, dedupe_key, status, attempts, max_attempts, run_after, lease_token, lease_until, created_at, updated_at)
       VALUES (?, 'expire_orders', '{}', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, `dk-${id}`, status, attempts, maxAttempts, runAfter, leaseUntil ? 'old' : null, leaseUntil, PAST, PAST);

test('c14: a task whose runner died in its last attempt is dead — never reclaimed again, never ahead of fresh work', async () => {
  const w = pcWorld();
  await seedCatalog(w);
  insertTask(w, 'spent', 'running', 9, 5, PAST, '2000-01-01T00:02:00.000Z');
  insertTask(w, 'fresh', 'queued', 0, 5, '2020-01-01T00:00:00.000Z', null);
  const env = { DB: w.db, BUCKET: w.bucket as never, R2_PRIVATE: w.bucket as never };
  const report = await runPrintCloudTasks(env, { limit: 5 });
  const spent = row(w, "SELECT status, attempts, last_error, finished_at FROM pc_background_jobs WHERE id = 'spent'");
  assert.equal(spent?.status, 'dead');
  assert.equal(spent?.attempts, 9, 'not run again');
  assert.equal(spent?.last_error, 'LEASE_EXPIRED_AFTER_LAST_ATTEMPT');
  assert.ok(spent?.finished_at);
  assert.deepEqual(rows(w, "SELECT attempt, level, message FROM pc_background_job_logs WHERE job_id = 'spent'"), [{ attempt: 9, level: 'error', message: 'LEASE_EXPIRED_AFTER_LAST_ATTEMPT' }]);
  assert.equal(row(w, "SELECT status FROM pc_background_jobs WHERE id = 'fresh'")?.status, 'succeeded');
  assert.equal(report.dead, 1);
  // A later run leaves it alone.
  await runPrintCloudTasks(env, { limit: 5 });
  assert.equal(row(w, "SELECT attempts FROM pc_background_jobs WHERE id = 'spent'")?.attempts, 9);
});

/** A runner whose isolate is killed right after its claim: nothing it writes later lands. */
function killedAfterClaim(db: D1Database): D1Database {
  let batches = 0;
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          if (++batches > 1) throw new Error('isolate killed');
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

test('c14: a crashed attempt is retried after its backoff, behind fresh due work, and dies after its last one', async () => {
  const w = pcWorld();
  await seedCatalog(w);
  const t0 = new Date('2026-03-01T00:00:00.000Z');
  const at = (minutes: number) => () => new Date(t0.getTime() + minutes * 60_000);
  insertTask(w, 'poison', 'queued', 0, 2, '2026-02-28T23:00:00.000Z', null);
  const live = { DB: w.db, BUCKET: w.bucket as never, R2_PRIVATE: w.bucket as never };
  const dying = () => ({ ...live, DB: killedAfterClaim(w.db) });

  await runPrintCloudTasks(dying(), { limit: 1, now: at(0) });
  assert.deepEqual(row(w, "SELECT status, attempts FROM pc_background_jobs WHERE id = 'poison'"), { status: 'running', attempts: 1 });
  insertTask(w, 'fresh', 'queued', 0, 5, '2026-03-01T00:01:00.000Z', null);

  // Fifteen minutes on, the lease has run out: fresh due work goes first.
  await runPrintCloudTasks(live, { limit: 1, now: at(15) });
  assert.equal(row(w, "SELECT status FROM pc_background_jobs WHERE id = 'fresh'")?.status, 'succeeded');
  assert.deepEqual(row(w, "SELECT status, attempts FROM pc_background_jobs WHERE id = 'poison'"), { status: 'running', attempts: 1 }, 'the crashed task did not jump the queue');

  // Its second and last attempt is killed too…
  await runPrintCloudTasks(dying(), { limit: 1, now: at(16) });
  assert.deepEqual(row(w, "SELECT status, attempts FROM pc_background_jobs WHERE id = 'poison'"), { status: 'running', attempts: 2 });
  // …and once that lease runs out, it is dead without running a third time.
  const report = await runPrintCloudTasks(live, { limit: 3, now: at(30) });
  assert.deepEqual(row(w, "SELECT status, attempts, last_error FROM pc_background_jobs WHERE id = 'poison'"), { status: 'dead', attempts: 2, last_error: 'LEASE_EXPIRED_AFTER_LAST_ATTEMPT' });
  assert.equal(report.dead, 1);
  assert.equal(report.ran, 0);
});

// ------------------------------------------------------------------ c19

async function conversionTier(w: World, cat: Catalog) {
  const a1 = await ok(w.owner, 'POST', `${ADMIN}/catalog/tiers`, { code: 'a1', name_en: 'A1 hours', name_ar: 'ساعات A1', name_ckb: 'کاتژمێرەکانی A1', hourly_rate_iqd: 750 });
  for (const [from, to] of [[cat.tier, a1.id], [a1.id, cat.tier]]) {
    const rule = await ok(w.full, 'POST', `${ADMIN}/catalog/conversion_rules`, { from_tier_id: from, to_tier_id: to, ratio_num: 1, ratio_den: 1 });
    await ok(w.full, 'PATCH', `${ADMIN}/catalog/conversion_rules/${rule.id}`, { enabled: true });
  }
  return a1.id as string;
}

const convert = (w: World, from: string, to: string, seconds: number) => ok(w.a, 'POST', `${API}/me/credits/convert`, { from_tier_id: from, to_tier_id: to, seconds }, idem('cv'));
const lotsIn = (w: World, tierId: string) =>
  rows(w, "SELECT seconds_remaining, paid_iqd, expires_at FROM pc_credit_lots WHERE user_id = 'usr_pc_a' AND tier_id = ? AND seconds_remaining > 0 ORDER BY expires_at IS NULL, expires_at", tierId);

test('c19: converted hours keep the expiry they were bought under, there and back, and their value', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const a1 = await conversionTier(w, cat);
  const pkg = await expiringPackage(w, cat);
  await buy(w.a, [{ kind: 'credit_package', package_id: pkg }]);
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h6 }]);
  const expiresAt = lot(w, expiringLotOf(w, 'usr_pc_a'))?.expires_at as string;
  assert.ok(expiresAt);

  // 9 h: the 6 expiring hours (9,000 IQD) and 3 of the plain ones (5,250 IQD of 10,500).
  const out = await convert(w, cat.tier, a1, 9 * H);
  assert.equal(out.received_seconds, 9 * H);
  assert.deepEqual(lotsIn(w, a1), [
    { seconds_remaining: 6 * H, paid_iqd: 9000, expires_at: expiresAt },
    { seconds_remaining: 3 * H, paid_iqd: 5250, expires_at: null },
  ]);
  const ledger = rows(w, "SELECT entry_type, value_iqd FROM pc_credit_ledger WHERE user_id = 'usr_pc_a' AND entry_type IN ('conversion_in', 'conversion_out')");
  const sum = (t: string) => ledger.filter((l) => l.entry_type === t).reduce((s, l) => s + Number(l.value_iqd), 0);
  assert.equal(sum('conversion_in'), sum('conversion_out'), 'the value that left arrived');

  // Converted straight back, the expiring hours still expire.
  await convert(w, a1, cat.tier, 9 * H);
  const back = lotsIn(w, cat.tier);
  assert.deepEqual(
    back.map((l) => [l.seconds_remaining, l.expires_at]),
    [[6 * H, expiresAt], [3 * H, null], [3 * H, null]]
  );
  // And at that date they go.
  w.raw.exec(`UPDATE pc_credit_lots SET expires_at = '${PAST}' WHERE user_id = 'usr_pc_a' AND expires_at IS NOT NULL`);
  await sweepExpiry(w);
  assert.deepEqual([(await credits(w.a, cat.tier)).available_seconds, (await credits(w.a, a1)).available_seconds], [6 * H, 0]);
  await reconcileClean(w);
});

test('c19: a conversion takes only free hours — never the ones a confirmed job holds, never ones already past their expiry', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const a1 = await conversionTier(w, cat);
  const pkg = await expiringPackage(w, cat);
  await buy(w.a, [{ kind: 'credit_package', package_id: pkg }, { kind: 'material', variant_id: cat.white, quantity: 500 }]);
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h6 }]);
  const expiring = expiringLotOf(w, 'usr_pc_a');
  const plain = plainLotOf(w, 'usr_pc_a');
  const { jobId } = await estimatedJob(w, w.a, cat, { seconds: 3 * H, materials: [{ variant_id: cat.white, model_grams: 30 }] });
  await runToPrinting(w, w.a, jobId);

  // The job holds the first 3 h in spend order (the expiring lot's). The 3 h converted are its other 3.
  await convert(w, cat.tier, a1, 3 * H);
  assert.deepEqual([lot(w, expiring)?.seconds_remaining, lot(w, plain)?.seconds_remaining], [3 * H, 6 * H]);
  assert.deepEqual(lotsIn(w, a1).map((l) => [l.seconds_remaining, l.expires_at]), [[3 * H, lot(w, expiring)?.expires_at]]);

  // Past its date (the sweep has not run yet), the expiring lot is not convertible: 3 h come from the plain lot.
  w.raw.prepare('UPDATE pc_credit_lots SET expires_at = ? WHERE id = ?').run(PAST, expiring);
  await ok(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/complete`, { printed_seconds: 2 * H, materials: [{ variant_id: cat.white, qty: 30 }] });
  assert.equal(lot(w, expiring)?.seconds_remaining, H, 'an hour given back to an expired lot');
  await convert(w, cat.tier, a1, 3 * H);
  assert.deepEqual([lot(w, expiring)?.seconds_remaining, lot(w, plain)?.seconds_remaining], [H, 3 * H]);
  assert.equal(lotsIn(w, a1).filter((l) => l.expires_at === null).length, 1);
  await reconcileClean(w);
});
