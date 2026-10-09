/**
 * scheduled() MATCHES EVERY CRON STRING EXACTLY, AND AN UNKNOWN ONE RUNS
 * NOTHING (FX programme plan §5 wiring, critique F13).
 *
 * Cron triggers are Worker settings, not part of a version. After a dashboard
 * rollback or `wrangler rollback` the triggers of the newer commit stay, so
 * the Worker that answers them may not know one of them. Before this rule any
 * string that was not the minute fell into the fifteen-minute jobs: the FX
 * scheduler's six-hour trigger would have run the durable jobs, the staff
 * reconciliation and the upload sweep a second time on a rolled-back Worker.
 *
 * The jobs each known cron runs are pinned where they live
 * (financeOrderRecoverySchedule.test.ts for the minute,
 * mediaCleanupSchedule.test.ts for the fifteen minutes); this file pins the
 * dispatch: which strings run anything at all.
 *
 * Run: node --import tsx --test tests/scheduledCronDispatch.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import worker from '../worker/index';
import { resetEventBus } from '../worker/lib/eventBus';
import { asD1, freshDb } from './fixtures/app';
import { ROOT } from './fixtures/d1';
import type { Env } from '../worker/lib/types';

const event = (cron: string) => ({ cron, scheduledTime: Date.now(), noRetry() {} }) as unknown as ScheduledEvent;

/** An ExecutionContext that keeps what it is given, so nothing runs unseen. */
function fakeCtx() {
  const waited: Promise<unknown>[] = [];
  return {
    waited,
    ctx: { waitUntil: (p: Promise<unknown>) => { waited.push(p); }, passThroughOnException() {} } as unknown as ExecutionContext,
  };
}

/** How many jobs each cron this commit knows hands to waitUntil today. */
const KNOWN: Readonly<Record<string, number>> = {
  '* * * * *': 2, // order finance recovery, Quick Buy finalisation
  '*/15 * * * *': 3, // staff reconciliation, durable jobs, upload-session sweep
};

/** Every `triggers.crons` array of wrangler.jsonc (default, staging, dark). */
function declaredCrons(): string[][] {
  const config = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');
  return [...config.matchAll(/"crons"\s*:\s*(\[[^\]]*\])/g)].map((m) => JSON.parse(m[1]) as string[]);
}

test('every cron wrangler.jsonc declares is one scheduled() knows: a new trigger needs its own branch first', () => {
  const schedules = declaredCrons();
  assert.equal(schedules.length, 3, 'three environments');
  for (const schedule of schedules) assert.deepEqual(schedule.filter((cron) => !(cron in KNOWN)), []);
});

test('each known cron string runs its own jobs and nothing else', async () => {
  for (const [cron, jobs] of Object.entries(KNOWN)) {
    const env = { DB: asD1(freshDb()) } as Env;
    const { waited, ctx } = fakeCtx();
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      worker.scheduled(event(cron), env, ctx);
      assert.equal(waited.length, jobs, `${cron}: ${jobs} jobs handed to waitUntil`);
      await Promise.all(waited);
    } finally {
      console.error = original;
      resetEventBus();
    }
  }
});

test('an unknown cron string runs nothing: no job, no database access, one warning (F13)', () => {
  const unknown = [
    '0 */6 * * *', // the FX trigger a later commit adds: a rolled-back Worker ignores it
    '',
    '*/15 * * * * ', // near misses of the known strings: the match is exact
    ' * * * * *',
    '*/15  * * * *',
    '* * * * * *',
    '*/5 * * * *',
    '0 * * * *',
  ];
  for (const cron of unknown) {
    const touched: string[] = [];
    const db = new Proxy(
      {},
      {
        get: (_target, prop) => {
          touched.push(String(prop));
          return () => { throw new Error(`the database was touched by ${JSON.stringify(cron)}`); };
        },
      }
    );
    const warned: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warned.push(args); };
    const { waited, ctx } = fakeCtx();
    try {
      worker.scheduled(event(cron), { DB: db } as unknown as Env, ctx);
    } finally {
      console.warn = original;
      resetEventBus();
    }
    assert.equal(waited.length, 0, `${JSON.stringify(cron)} must run nothing`);
    assert.deepEqual(touched, [], `${JSON.stringify(cron)} must not touch the database`);
    assert.equal(warned.length, 1, `${JSON.stringify(cron)} is reported once`);
    assert.match(String(warned[0]![0]), /unknown cron, nothing run/);
  }
});
