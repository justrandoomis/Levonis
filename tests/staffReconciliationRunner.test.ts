import test from 'node:test';
import assert from 'node:assert/strict';
import { createStaffReconciliationRunner, type ReconciliationActivity, type StaffReconciliation } from '../src/components/financePeople/staffReconciliationRunner';

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
  assert.equal(f.refreshed, 3, 'refreshes first page, after five more pages, and completion, not every page');
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
