/**
 * THE SIX-HOURLY CRON RUNS THE FX SCHEDULER, AND NOTHING ELSE DOES (FX
 * programme plan §4, §5 wiring; critique F13).
 *
 * wrangler.jsonc declares the six-hourly trigger in all three environments (the one
 * serving levonis-iq.com included); scheduled() matches it exactly and hands
 * ONE job to waitUntil — the scheduler, with the event's scheduled time — and
 * no durable job; the minute and fifteen-minute branches never call it; an
 * unknown string runs nothing (tests/scheduledCronDispatch.test.ts holds the
 * dispatch for every string).
 *
 * Run: node --import tsx --test tests/fxCron.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import worker from '../worker/index';
import { resetEventBus } from '../worker/lib/eventBus';
import { ROOT } from './fixtures/d1';
import { asD1, freshDb, providerFetch, row } from './fixtures/app';
import { ecbBody, iqwealthBody, GOOD_KEY } from './fixtures/fx';
import type { Env } from '../worker/lib/types';

const FX_CRON = '0 */6 * * *';

function fakeCtx() {
  const waited: Promise<unknown>[] = [];
  return { waited, ctx: { waitUntil: (p: Promise<unknown>) => void waited.push(p), passThroughOnException() {} } as unknown as ExecutionContext };
}

test('every crons array contains 0 */6 * * * (default, staging — the Worker serving levonis-iq.com — and dark)', () => {
  const config = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');
  const arrays = [...config.matchAll(/"crons"\s*:\s*(\[[^\]]*\])/g)].map((m) => JSON.parse(m[1]!) as string[]);
  assert.equal(arrays.length, 3);
  for (const a of arrays) {
    assert.ok(a.includes(FX_CRON), JSON.stringify(a));
    assert.ok(a.includes('*/15 * * * *') && a.includes('* * * * *'), 'the existing triggers stay');
  }
});

test('scheduled({cron:"0 */6 * * *"}) waits on runFxScheduler only (1 waitUntil, no durable jobs), stamped with the scheduled time', async () => {
  const raw = freshDb();
  const scheduledTime = Date.parse('2026-10-08T12:00:00.000Z');
  providerFetch.handler = async (url) =>
    new URL(url).hostname === 'iraqsm.com'
      ? new Response(iqwealthBody({ publishedAt: new Date().toISOString() }), { status: 200 })
      : new Response(ecbBody({ day: new Date().toISOString().slice(0, 10) }), { status: 200 });
  const before = providerFetch.attempts.length;
  const outboxBefore = (raw.prepare('SELECT COUNT(*) n FROM outbox').get() as { n: number }).n;
  const { waited, ctx } = fakeCtx();
  try {
    worker.scheduled({ cron: FX_CRON, scheduledTime, noRetry() {} } as unknown as ScheduledEvent, { DB: asD1(raw), IRAQ_PARALLEL_FX_API_KEY: GOOD_KEY, INITIAL_ADMIN_EMAIL: 'boss@x.co' } as Env, ctx);
    assert.equal(waited.length, 1, 'one job');
    await Promise.all(waited);
  } finally {
    providerFetch.handler = null;
    resetEventBus();
  }
  assert.equal(providerFetch.attempts.length - before, 2, 'one IQWealth call, one ECB file');
  const usd = row<Record<string, unknown>>(raw, "SELECT * FROM fx_rate_pairs WHERE pair='USD_IQD'")!;
  assert.equal(usd.last_cron_success_at, new Date(scheduledTime).toISOString());
  assert.equal(usd.pending_reason, 'FIRST_VALUE');
  assert.equal((raw.prepare('SELECT COUNT(*) n FROM outbox').get() as { n: number }).n, outboxBefore, 'no durable job ran');
});

test('the minute and */15 branches never call it', async () => {
  for (const cron of ['* * * * *', '*/15 * * * *']) {
    const raw = freshDb();
    const before = providerFetch.attempts.length;
    const { waited, ctx } = fakeCtx();
    const errors = console.error;
    console.error = () => {};
    try {
      worker.scheduled({ cron, scheduledTime: Date.now(), noRetry() {} } as unknown as ScheduledEvent, { DB: asD1(raw) } as Env, ctx);
      await Promise.all(waited);
    } finally {
      console.error = errors;
      resetEventBus();
    }
    assert.equal(providerFetch.attempts.length, before, `${cron}: no provider call`);
    assert.equal(row<{ n: number }>(raw, 'SELECT COUNT(*) n FROM fx_rate_pairs WHERE last_checked_at IS NOT NULL')!.n, 0, `${cron}: no pair checked`);
  }
});

test('an unknown cron string runs nothing (F13): the FX scheduler included', () => {
  const src = readFileSync(join(ROOT, 'worker/index.ts'), 'utf8');
  assert.match(src, /if \(_event\.cron === '0 \*\/6 \* \* \*'\) \{/);
  assert.match(src, /runFxScheduler\(env, \{ now: new Date\(\), scheduledTime: new Date\(_event\.scheduledTime\) \}, \{ trigger: 'cron' \}\)/);
  // The dispatch itself (every known and unknown string) is pinned by tests/scheduledCronDispatch.test.ts.
  assert.match(readFileSync(join(ROOT, 'tests/scheduledCronDispatch.test.ts'), 'utf8'), /'0 \*\/6 \* \* \*': 1/);
});
