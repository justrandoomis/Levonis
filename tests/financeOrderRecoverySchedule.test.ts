import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import worker from '../worker/index';
import { asD1, count, freshDb, row } from './fixtures/app';
import { ROOT } from './fixtures/d1';
import type { Env } from '../worker/lib/types';

test('the minute schedule repairs historical delivered finance without an admin request or running unrelated durable jobs', async () => {
  const raw = freshDb();
  raw.exec(`INSERT INTO users(id,email,name) VALUES ('recovery-buyer','recovery@example.test','Buyer');
    INSERT INTO products(id,name,slug,price_iqd) VALUES ('recovery-product','Filament','recovery-filament',50000);
    INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,created_at,delivered_at)
      VALUES ('recovery-order','recovery-buyer','delivered','{}','standard','{}','cash',50000,1500,50000,50000,'2026-09-20T00:00:00Z','2026-09-22T00:00:00Z');
    INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis)
      VALUES ('recovery-line','recovery-order','recovery-product','Filament',1,50000,50000,20000,'snapshot');
    INSERT INTO finance_posting_errors(event_key,order_id,message,last_attempt_at)
      VALUES ('cogs:recovery-order','recovery-order','Historical cost rejection','2026-09-22T00:00:00Z');
    INSERT INTO media_cleanup_jobs(id,object_key,visibility,reason,created_at)
      VALUES ('unrelated-cleanup','products/unrelated-recovery-check.jpg','public','image_detach','2026-01-01T00:00:00Z');`);
  const waited: Promise<unknown>[] = [];
  const ctx = { waitUntil: (work: Promise<unknown>) => { waited.push(work); } } as unknown as ExecutionContext;
  const env = { DB: asD1(raw) } as Env;
  const event = { cron: '* * * * *', scheduledTime: Date.now(), noRetry() {} } as unknown as ScheduledEvent;

  worker.scheduled(event, env, ctx);
  // Financial recovery and Quick Buy finalisation (§13): the two time-critical
  // jobs. Nothing else rides the minute tick.
  assert.equal(waited.length, 2, 'the minute tick schedules financial recovery and Quick Buy finalisation only');
  await Promise.all(waited);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM finance_posting_errors WHERE order_id='recovery-order'"), 0);
  assert.equal(count(raw, `SELECT SUM(l.debit_iqd-l.credit_iqd) n FROM accounting_lines l
    JOIN accounting_entries e ON e.id=l.entry_id WHERE e.event_key='cogs:recovery-order' AND l.account_code='5000'`), 20000);
  assert.equal(row(raw, "SELECT state FROM media_cleanup_jobs WHERE id='unrelated-cleanup'")?.state, 'pending');

  const entries = count(raw, 'SELECT COUNT(*) n FROM accounting_entries');
  waited.length = 0;
  worker.scheduled(event, env, ctx);
  await Promise.all(waited);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM accounting_entries'), entries, 'the next tick cannot duplicate the repair');
});

test('all deployed environments enable automatic finance recovery while retaining the general-job schedule', () => {
  const config = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');
  const schedules = [...config.matchAll(/"crons"\s*:\s*(\[[^\]]*\])/g)].map(match => JSON.parse(match[1]) as string[]);
  assert.equal(schedules.length, 3);
  for (const schedule of schedules) {
    assert.ok(schedule.includes('* * * * *'), 'financial recovery must have a configured trigger, not just an exported helper');
    assert.ok(schedule.includes('*/15 * * * *'), 'other jobs retain their existing cadence');
  }
});
