import test from 'node:test';
import assert from 'node:assert/strict';
import { codeOf } from './fixtures/source';
import { createStaffReconciliationRunner, RATE_LIMIT_REST_MS, REFRESH_INTERVAL_MS, type ReconciliationActivity, type StaffReconciliation } from '../src/components/financePeople/staffReconciliationRunner';

const job = (n = 0, state: StaffReconciliation['state'] = 'running', revision = 1): StaffReconciliation => ({ staff_id: 'employee', revision, state, cursor: String(n), processed_orders: n, adjusted_orders: n, updated_at: `2026-10-05T20:00:${String(n).padStart(2, '0')}Z` });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture(advance: (j: StaffReconciliation) => Promise<StaffReconciliation>, read = async () => job(), refresh = async () => {}) {
  let clock = 100_000, id = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const jobs: StaffReconciliation[] = [], activities: ReconciliationActivity[] = [];
  let refreshed = 0;
  const runner = createStaffReconciliationRunner({
    advance, read, refresh: async () => { refreshed++; await refresh(); }, onJob: (j) => jobs.push(j), onActivity: (_, a) => activities.push(a), now: () => clock,
    schedule(callback, delay) { const key = ++id; timers.set(key, { at: clock + delay, callback }); return () => { timers.delete(key); }; },
  });
  return { runner, jobs, activities, timers, get refreshed() { return refreshed; },
    async next() { const selected = [...timers].sort((a, b) => a[1].at - b[1].at)[0]; assert.ok(selected, 'a next page is scheduled'); timers.delete(selected[0]); clock = selected[1].at; selected[1].callback(); await flush(); },
    get delay() { return Math.min(...[...timers.values()].map(t => t.at - clock)); },
  };
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test('loaded pending jobs continue beyond the old three-page limit and refresh the final balance', async () => {
  let calls = 0;
  const f = fixture(async j => { calls++; return job(j.processed_orders + 1, calls === 8 ? 'complete' : 'running'); });
  f.runner.sync([job(0, 'pending')]); f.runner.start();
  for (let n = 0; n < 8; n++) await f.next();
  assert.equal(calls, 8); assert.equal(f.jobs.at(-1)?.state, 'complete');
  assert.equal(f.refreshed, 2, 'refreshes after the first page and at completion, not every page');
  assert.equal(f.timers.size, 0);
});

test('save and retry signals during an active page never create parallel POSTs', async () => {
  const first = deferred<StaffReconciliation>(); let calls = 0;
  const f = fixture(async () => { calls++; return first.promise; });
  f.runner.sync([job()]); f.runner.start(); await f.next();
  f.runner.sync([job()]); f.runner.retry(job()); f.runner.start();
  assert.equal(calls, 1); assert.equal(f.timers.size, 0);
  first.resolve(job(1, 'complete')); await flush();
  assert.equal(calls, 1); assert.equal(f.timers.size, 0);
});

test('a lost POST response that committed is read back and delayed before the next page', async () => {
  let reads = 0, calls = 0;
  const f = fixture(async j => { calls++; if (calls === 1) throw new Error('network'); assert.equal(j.cursor, '1'); return job(2, 'complete'); }, async () => { reads++; return job(1); });
  f.runner.sync([job()]); f.runner.start(); await f.next();
  assert.equal(reads, 1); assert.equal(calls, 1); assert.equal(f.delay, 5000);
  await f.next(); assert.equal(calls, 2); assert.equal(f.jobs.at(-1)?.state, 'complete');
});

test('unchanged durable cursor backs off and stops after three failures for manual retry', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; throw new Error('network'); });
  f.runner.sync([job()]); f.runner.start(); await f.next(); assert.equal(f.delay, 5000);
  await f.next(); assert.equal(f.delay, 10000);
  await f.next(); assert.equal(calls, 3); assert.equal(f.timers.size, 0); assert.equal(f.activities.at(-1)?.retrying, false);
  f.runner.sync([job()]); assert.equal(f.timers.size, 0, 'unchanged list refresh does not restart failed network work');
  f.runner.retry(job()); assert.equal(f.timers.size, 1);
});

test('failed server jobs stop automatically, and explicit retry checks for completion before writing', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return job(1, 'failed'); }, async () => job(2, 'complete'));
  f.runner.sync([job()]); f.runner.start(); await f.next();
  assert.equal(calls, 1); assert.equal(f.timers.size, 0);
  f.runner.retry(job(1, 'failed')); await f.next();
  assert.equal(calls, 1, 'cron already completed the job, so no further POST');
  assert.equal(f.jobs.at(-1)?.state, 'complete'); assert.equal(f.timers.size, 0);
  assert.equal(f.refreshed, 2, 'terminal retry refreshes the final balance once');
});

test('revision conflict adopts the durable new revision instead of repeating the old request', async () => {
  const versions: number[] = [];
  const f = fixture(async j => { versions.push(j.revision); if (j.revision === 1) throw new Error('409 revision'); return job(1, 'complete', 2); }, async () => job(0, 'pending', 2));
  f.runner.sync([job()]); f.runner.start(); await f.next(); await f.next();
  assert.deepEqual(versions, [1, 2]); assert.equal(f.jobs.at(-1)?.revision, 2);
});

test('a late old-revision response cannot replace a newer date-change job', async () => {
  const old = deferred<StaffReconciliation>(); const versions: number[] = [];
  const f = fixture(async j => { versions.push(j.revision); return j.revision === 1 ? old.promise : job(1, 'complete', 2); });
  f.runner.sync([job()]); f.runner.start(); await f.next();
  f.runner.sync([job(0, 'pending', 2)]); old.resolve(job(4, 'complete', 1)); await flush();
  assert.equal(f.jobs.at(-1)?.revision, 2); await f.next(); assert.deepEqual(versions, [1, 2]);
});

test('unmount stops timers and late UI updates; restarting does not duplicate an in-flight page', async () => {
  const pending = deferred<StaffReconciliation>(); let calls = 0;
  const f = fixture(async () => { calls++; return pending.promise; });
  f.runner.sync([job()]); f.runner.start(); await f.next();
  f.runner.stop(); f.runner.start(); assert.equal(calls, 1); assert.equal(f.timers.size, 0);
  f.runner.stop(); const before = f.activities.length; pending.resolve(job(1)); await flush();
  assert.equal(f.activities.length, before); assert.equal(f.jobs.length, 0); assert.equal(f.refreshed, 0); assert.equal(f.timers.size, 0);
});

test('completion verified after a timed-out POST refreshes the final balance without another POST', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; throw new Error('timeout'); }, async () => job(1, 'complete'));
  f.runner.sync([job()]); f.runner.start(); await f.next();
  assert.equal(calls, 1); assert.equal(f.refreshed, 1); assert.equal(f.timers.size, 0);
});

test('a failed recovery GET must succeed before another reconciliation POST', async () => {
  let writes = 0, reads = 0;
  const f = fixture(async j => { writes++; if (writes === 1) throw new Error('POST timeout'); assert.equal(j.cursor, '1'); return job(2, 'complete'); }, async () => { reads++; if (reads === 1) throw new Error('GET offline'); return job(1); });
  f.runner.sync([job()]); assert.equal(f.timers.size, 0, 'does not run before the owner capability starts it'); f.runner.start(); await f.next();
  assert.equal(writes, 1); assert.equal(reads, 1); assert.equal(f.delay, 5000);
  await f.next(); assert.equal(reads, 2); assert.equal(writes, 2); assert.equal(f.jobs.at(-1)?.state, 'complete');
});

// ---- the finance budgets (S1 review D1) ------------------------------------
//
// One POST per order, 1.2 s apart: on the shared finance write budget (120 an
// hour) a long recalculation locked the owner out of every finance write. The
// server now pages on its own bucket; when even that is spent the runner
// leaves the job to the cron instead of reporting a failure.

const limited = () => Object.assign(new Error('Too many requests, try again later'), { status: 429 });

test('a 429 is not a failure: no read-back, no error, no failure count — the runner rests and resumes', async () => {
  let calls = 0, reads = 0;
  const f = fixture(async (j) => { calls++; if (calls === 2) throw limited(); return job(j.processed_orders + 1, calls === 3 ? 'complete' : 'running'); }, async () => { reads++; return job(1); });
  f.runner.sync([job(0, 'pending')]); f.runner.start();
  await f.next(); assert.equal(calls, 1);
  await f.next(); assert.equal(calls, 2);
  assert.equal(reads, 0, 'a refused request wrote nothing, so nothing is read back');
  assert.deepEqual(f.activities.at(-1), { busy: false, deferred: true }, 'quiet: no error and no retry button');
  assert.equal(f.delay, RATE_LIMIT_REST_MS, 'rests, leaving the pages to the cron meanwhile');
  await f.next(); assert.equal(calls, 3); assert.equal(f.jobs.at(-1)?.state, 'complete');
  assert.equal(f.activities.at(-1)?.error, undefined);
});

test('when a rest ends the staff list is read once before the next page, so the cron’s progress shows', async () => {
  let calls = 0;
  const order: string[] = [];
  const f = fixture(
    async (j) => { calls++; order.push('page'); if (calls === 2) throw limited(); return job(j.processed_orders + 1); },
    async () => job(),
    async () => { order.push('refresh'); }
  );
  f.runner.sync([job(0, 'pending')]); f.runner.start();
  await f.next(); await f.next();
  assert.deepEqual(order, ['page', 'refresh', 'page'], 'the first page refreshes; the refused one does not');
  await f.next();
  assert.deepEqual(order, ['page', 'refresh', 'page', 'refresh', 'page'], 'the rest ended: one list read, then the page');
  await f.next();
  assert.equal(order.filter((x) => x === 'refresh').length, 2, 'and only once — the 30 s throttle applies again');
});

test('repeated 429s never block the job for a manual retry the way three failures do', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; throw limited(); });
  f.runner.sync([job()]); f.runner.start();
  for (let i = 0; i < 5; i++) await f.next();
  assert.equal(calls, 5); assert.equal(f.timers.size, 1, 'still scheduled after five refusals');
  assert.ok(f.activities.every((a) => !a.error && a.retrying === undefined));
});

test('one 429 rests every job: the paging budget is per account, not per employee', async () => {
  const touched: string[] = [];
  const f = fixture(async (j) => { touched.push(j.staff_id); if (touched.length === 1) throw limited(); return { ...j, state: 'complete' }; });
  f.runner.sync([job(), { ...job(), staff_id: 'second' }]); f.runner.start();
  await f.next();
  assert.deepEqual(touched, ['employee']);
  assert.equal(f.delay, RATE_LIMIT_REST_MS, 'the second employee waits for the same rest');
  await f.next(); await f.next();
  assert.deepEqual(touched.sort(), ['employee', 'employee', 'second']);
});

test('an explicit retry during a rest asks once; another 429 rests again quietly', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; throw limited(); }, async () => job());
  f.runner.sync([job()]); f.runner.start(); await f.next();
  assert.equal(f.delay, RATE_LIMIT_REST_MS);
  f.runner.retry(job()); assert.equal(f.delay, 0, 'the owner asked');
  await f.next(); assert.equal(calls, 2); assert.equal(f.delay, RATE_LIMIT_REST_MS);
  assert.deepEqual(f.activities.at(-1), { busy: false, deferred: true });
});

test('an hour of paging refreshes the staff list at most once per 30 s, inside the finance read budget', async () => {
  let calls = 0;
  const f = fixture(async (j) => { calls++; return job(j.processed_orders + 1); });
  f.runner.sync([job(0, 'pending')]); f.runner.start();
  const pages = Math.floor(3_600_000 / 1200);
  for (let n = 0; n < pages; n++) await f.next();
  assert.equal(calls, pages);
  assert.ok(f.refreshed <= 3_600_000 / REFRESH_INTERVAL_MS + 1, `${f.refreshed} refreshes in an hour`);
  assert.ok(f.refreshed < 600 / 4, 'leaves most of the 600-an-hour read budget to the finance screens');
});

test('the People panel says a rested recalculation goes on in the background — in ar, en and Sorani — instead of a frozen "Calculating"', () => {
  const panel = codeOf('src/components/financePeople/PeoplePanel.tsx');
  const notice = /\{activity\?\.deferred && job\.state !== 'failed' && <p className="fp-muted">\{loc\('([^']+)', '([^']+)', '([^']+)'\)\}<\/p>\}/.exec(panel);
  assert.ok(notice, 'the deferred flag is rendered');
  const [, ar, en, ckb] = notice;
  assert.match(en, /keeps calculating in the background/);
  assert.match(ar, /في الخلفية/);
  assert.match(ckb, /[ڕڵێۆەڤگچپژ]/, 'real Sorani');
  assert.doesNotMatch(ckb, /[ةىيك]/, 'Sorani writes ی and ک');
  assert.notEqual(ckb, ar);
});
