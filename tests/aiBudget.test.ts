/**
 * THE DAILY CAP FAILS CLOSED (push B plan §16 #7, §10; invariant I9).
 *
 * On the real 0210 schema (every migration applied): fifty concurrent
 * reservations never pass the cap, the guest share is enforced inside the same
 * UPDATE, a call above a tenth of the cap is refused, over the cap the
 * transport is never called, settle swaps the reservation for the real cost,
 * a timeout is charged the reservation, a lost settle keeps it, the UTC day
 * rolls over, the cost formula matches hand-computed integers (cache-rate
 * defaults included), and a model without rates is not ready.
 *
 * Run: node --import tsx --test tests/aiBudget.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEY, READING_OK, aiDb, answer, clock, recordingTransport, textModel, speechModel } from './fixtures/aiLayer';
import { row } from './fixtures/app';
import {
  costMicro,
  estimateInputTokens,
  perCallLimitMicro,
  pruneAiLedger,
  reserve,
  settle,
  utcDay,
  worstCaseMicro,
} from '../worker/lib/ai/budget';
import { loadAiConfig } from '../worker/lib/ai/config';
import { aiReady, runUnderstand } from '../worker/lib/ai/run';
import { NO_USAGE, type AiConfig, type Rates, type TaskModel } from '../worker/lib/ai/types';
import type { Env } from '../worker/lib/types';

const rates = (o: Partial<Rates> = {}): Rates => ({ inPerMTok: 0, outPerMTok: 0, cacheWritePerMTok: 0, cacheReadPerMTok: 0, speechPerMinute: 0, ...o });
const cfgOf = (o: Partial<AiConfig> = {}): AiConfig => ({
  version: 1,
  enabled: true,
  capMicro: 1_000_000,
  guests: true,
  guestSharePct: 25,
  understandCkb: false,
  models: { understand: [], vision: [], speech: [] },
  ...o,
});
const DAY = '2026-10-22';
const input = { text: 'الطابعة تطلع خيوط', locale: 'ar' as const };

test('cost math against hand-computed integers, with the cache-rate defaults', () => {
  const u = { inputTokens: 1234, outputTokens: 567, cacheWriteTokens: 100, cacheReadTokens: 1000, speechMs: 0 };
  // cwR' = 2 × inR = 6, crR' = inR = 3 (USD per MTok):
  // 1234·3 + 100·6 + 1000·3 + 567·15 = 3702 + 600 + 3000 + 8505 = 15807 → 15807 micro-USD.
  assert.equal(costMicro(rates({ inPerMTok: 3_000_000, outPerMTok: 15_000_000 }), u), 15_807);
  // Entered cache rates 3.75 and 0.30: 3702 + 375 + 300 + 8505 = 12882.
  assert.equal(costMicro(rates({ inPerMTok: 3_000_000, outPerMTok: 15_000_000, cacheWritePerMTok: 3_750_000, cacheReadPerMTok: 300_000 }), u), 12_882);
  // Speech: 45.5 s at $0.006 a minute = 4550 micro-USD.
  assert.equal(costMicro(rates({ speechPerMinute: 6_000 }), { ...NO_USAGE, speechMs: 45_500 }), 4_550);
  // Fractions round UP: one token at $1/MTok is a whole micro-USD, never zero.
  assert.equal(costMicro(rates({ inPerMTok: 1_000_000 }), { ...NO_USAGE, inputTokens: 1 }), 1);
  assert.equal(costMicro(rates({ inPerMTok: 1_000_000 }), NO_USAGE), 0);
});

test('the worst case per call (§10)', () => {
  const m: TaskModel = { task: 'understand', rank: 0, provider: 'anthropic', modelId: 'x', rates: rates({ inPerMTok: 3_000_000, outPerMTok: 15_000_000 }), effortLow: false };
  // (100 + 2000) input tokens × 3 + 1536 × 15 = 6300 + 23040 = 29340.
  assert.equal(estimateInputTokens('a'.repeat(60), 'b'.repeat(40)), 2100);
  assert.equal(worstCaseMicro(m, { inputTokens: 2100, maxTokens: 1536 }), 29_340);
  // UTF-8 bytes, not characters: Arabic letters are two bytes each.
  assert.equal(estimateInputTokens('', 'نوزل'), 2008);
  // Vision adds each picture's capped token estimate.
  assert.equal(estimateInputTokens('', '', [1000, 4784]), 2000 + 5784);
  // Speech: 75 s at the per-minute rate, whatever shorter duration is claimed.
  const s: TaskModel = { task: 'speech', rank: 0, provider: 'workers_ai', modelId: 'x', rates: rates({ speechPerMinute: 6_000 }), effortLow: false };
  assert.equal(worstCaseMicro(s, { inputTokens: 0, maxTokens: 0, speechMs: 1000 }), 7_500);
  assert.equal(perCallLimitMicro(1_000_000), 100_000);
});

/**
 * D1 runs one batch at a time; the in-process SQLite adapter would instead
 * refuse a second transaction opened while the first awaits. This queue gives
 * the adapter D1's own serialisation, so fifty callers really do race for the
 * same row through the conditional UPDATE.
 */
function serialised(db: D1Database): D1Database {
  let tail: Promise<unknown> = Promise.resolve();
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== 'batch') return Reflect.get(target, prop, receiver);
      return (stmts: D1PreparedStatement[]) => {
        const run = tail.then(() => target.batch(stmts));
        tail = run.catch(() => undefined);
        return run;
      };
    },
  });
}

test('fifty concurrent reservations never pass the cap', async () => {
  const { raw, db: plain } = aiDb();
  const db = serialised(plain);
  const cfg = cfgOf();
  const granted = await Promise.all(Array.from({ length: 50 }, () => reserve(db, DAY, 30_000, cfg, false)));
  assert.equal(granted.filter(Boolean).length, 33);
  const r = row<{ reserved_micro_usd: number; calls: number }>(raw, 'SELECT reserved_micro_usd, calls FROM ai_spend_day WHERE day = ?', DAY);
  assert.equal(r.reserved_micro_usd, 990_000);
  assert.equal(r.calls, 33);
  assert.ok(r.reserved_micro_usd <= cfg.capMicro);
  // Without the queue the adapter's overlapping transactions fail: a failed reservation is a refusal,
  // so even then the cap holds (fail closed).
  const second = aiDb();
  const any = await Promise.all(Array.from({ length: 50 }, () => reserve(second.db, DAY, 30_000, cfg, false)));
  const held = row<{ reserved_micro_usd: number } | undefined>(second.raw, 'SELECT reserved_micro_usd FROM ai_spend_day WHERE day = ?', DAY);
  assert.ok((held?.reserved_micro_usd ?? 0) === any.filter(Boolean).length * 30_000);
  assert.ok((held?.reserved_micro_usd ?? 0) <= cfg.capMicro);
});

test('the guest share is enforced inside the same UPDATE', async () => {
  const { raw, db } = aiDb();
  const cfg = cfgOf({ guestSharePct: 25 });
  assert.equal(await reserve(db, DAY, 100_000, cfg, true), true);
  assert.equal(await reserve(db, DAY, 100_000, cfg, true), true);
  assert.equal(await reserve(db, DAY, 100_000, cfg, true), false, '300 000 > 25 % of 1 000 000');
  assert.equal(await reserve(db, DAY, 100_000, cfg, false), true, 'a signed-in customer is not held by the guest share');
  const r = row<{ reserved_micro_usd: number; guest_micro_usd: number }>(raw, 'SELECT reserved_micro_usd, guest_micro_usd FROM ai_spend_day WHERE day = ?', DAY);
  assert.deepEqual({ ...r }, { reserved_micro_usd: 300_000, guest_micro_usd: 200_000 });
  assert.equal(await reserve(db, DAY, 1, cfgOf({ guestSharePct: 0 }), true), false, 'a 0 % share lets no guest through');
  assert.equal(await reserve(db, DAY, 1, cfgOf({ capMicro: 0 }), false), false, 'a zero cap refuses everything');
});

test('settle swaps the reservation for the real cost and writes a codes-only ledger row', async () => {
  const { raw, db } = aiDb();
  const cfg = cfgOf();
  assert.equal(await reserve(db, DAY, 50_000, cfg, true), true);
  await settle(db, DAY, 50_000, true, {
    task: 'understand',
    rank: 0,
    provider: 'anthropic',
    modelId: 'test-text-model-a',
    outcome: 'OK',
    guest: true,
    usage: { inputTokens: 900, outputTokens: 80, cacheWriteTokens: 0, cacheReadTokens: 0, speechMs: 0 },
    costMicro: 1_300,
    latencyMs: 812,
  });
  const d = row<Record<string, number>>(raw, 'SELECT reserved_micro_usd, spent_micro_usd, guest_micro_usd FROM ai_spend_day WHERE day = ?', DAY);
  assert.deepEqual({ ...d }, { reserved_micro_usd: 0, spent_micro_usd: 1_300, guest_micro_usd: 1_300 });
  const u = row<Record<string, unknown>>(raw, 'SELECT * FROM ai_usage');
  assert.equal(u.outcome, 'OK');
  assert.equal(u.cost_micro_usd, 1_300);
  assert.equal(u.guest, 1);
  assert.equal(u.input_tokens, 900);
});

test('a lost settle keeps the reservation: the day fails closed', async () => {
  const { raw, db } = aiDb();
  assert.equal(await reserve(db, DAY, 50_000, cfgOf(), false), true);
  raw.exec('DROP TABLE ai_usage'); // the ledger insert fails, so the whole settle batch rolls back
  await settle(db, DAY, 50_000, false, {
    task: 'understand',
    rank: 0,
    provider: 'anthropic',
    modelId: 'x',
    outcome: 'OK',
    guest: false,
    usage: NO_USAGE,
    costMicro: 10,
    latencyMs: 1,
  });
  const d = row<Record<string, number>>(raw, 'SELECT reserved_micro_usd, spent_micro_usd FROM ai_spend_day WHERE day = ?', DAY);
  assert.deepEqual({ ...d }, { reserved_micro_usd: 50_000, spent_micro_usd: 0 });
});

test('a call whose worst case is above a tenth of the cap is refused before the transport', async () => {
  // Cap $0.01: the per-call limit is 1000 micro-USD, far below one understanding call at $1/$5.
  const { db } = aiDb({ capMicro: 10_000, models: [textModel('understand', 0)] });
  const t = recordingTransport(() => answer(READING_OK));
  const env = { DB: db, ANTHROPIC_API_KEY: KEY } as unknown as Env;
  assert.equal(await runUnderstand(env, input, { guest: false }, { transport: t }), null);
  assert.equal(t.calls.length, 0);
  assert.equal(await aiReady(env, 'understand'), false, 'and readiness says so');
});

test('over the cap the transport is never called', async () => {
  const c = clock();
  const { raw, db } = aiDb({ models: [textModel('understand', 0)] });
  raw.prepare('INSERT INTO ai_spend_day (day, spent_micro_usd) VALUES (?, ?)').run(utcDay(c.now()), 995_000);
  const t = recordingTransport(() => answer(READING_OK));
  const env = { DB: db, ANTHROPIC_API_KEY: KEY } as unknown as Env;
  assert.equal(await runUnderstand(env, input, { guest: false }, { transport: t, now: c.now }), null);
  assert.equal(t.calls.length, 0);
  assert.equal(row<{ n: number }>(raw, 'SELECT COUNT(*) AS n FROM ai_usage').n, 0, 'no call, no ledger row');
});

test('a successful call is settled at its real cost; a timeout is charged the whole reservation', async () => {
  const c = clock();
  const { raw, db } = aiDb({ models: [textModel('understand', 0)] });
  const env = { DB: db, ANTHROPIC_API_KEY: KEY } as unknown as Env;
  const ok = recordingTransport(() => answer(READING_OK, { usage: { input_tokens: 2000, output_tokens: 100 } }));
  assert.deepEqual(await runUnderstand(env, input, { guest: false }, { transport: ok, now: c.now }), READING_OK);
  const day = utcDay(c.now());
  let d = row<Record<string, number>>(raw, 'SELECT reserved_micro_usd, spent_micro_usd, calls FROM ai_spend_day WHERE day = ?', day);
  // 2000 × $1 + 100 × $5 per MTok = 2000 + 500 = 2500 micro-USD.
  assert.deepEqual({ ...d }, { reserved_micro_usd: 0, spent_micro_usd: 2_500, calls: 1 });

  const slow = recordingTransport(() => {
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  });
  assert.equal(await runUnderstand(env, input, { guest: false }, { transport: slow, now: c.now }), null);
  d = row<Record<string, number>>(raw, 'SELECT reserved_micro_usd, spent_micro_usd FROM ai_spend_day WHERE day = ?', day);
  const charged = row<{ cost_micro_usd: number; outcome: string }>(raw, "SELECT cost_micro_usd, outcome FROM ai_usage WHERE outcome = 'TIMEOUT'");
  assert.ok(charged.cost_micro_usd > 2_500, 'the timeout is charged the worst case, not nothing');
  assert.equal(d.spent_micro_usd, 2_500 + charged.cost_micro_usd);
  assert.equal(d.reserved_micro_usd, 0);
});

test('the UTC day rolls over: a new day has the whole cap again', async () => {
  const c = clock(Date.parse('2026-10-22T23:59:59.000Z'));
  const { raw, db } = aiDb({ models: [textModel('understand', 0)] });
  raw.prepare('INSERT INTO ai_spend_day (day, spent_micro_usd) VALUES (?, ?)').run('2026-10-22', 1_000_000);
  const env = { DB: db, ANTHROPIC_API_KEY: KEY } as unknown as Env;
  const t = recordingTransport(() => answer(READING_OK));
  assert.equal(await runUnderstand(env, input, { guest: false }, { transport: t, now: c.now }), null);
  assert.equal(t.calls.length, 0);
  c.set(Date.parse('2026-10-23T00:00:01.000Z'));
  assert.deepEqual(await runUnderstand(env, input, { guest: false }, { transport: t, now: c.now }), READING_OK);
  assert.equal(t.calls.length, 1);
  assert.equal(row<{ calls: number }>(raw, "SELECT calls FROM ai_spend_day WHERE day = '2026-10-23'").calls, 1);
  assert.equal(utcDay(Date.parse('2026-10-22T23:59:59.999Z')), '2026-10-22');
  assert.equal(utcDay(Date.parse('2026-10-23T00:00:00.000Z')), '2026-10-23');
});

test('no rates means not ready, and no call', async () => {
  const { db } = aiDb({ models: [{ ...textModel('understand', 0), outR: 0 }, { ...speechModel(0), minR: 0 }] });
  const env = { DB: db, ANTHROPIC_API_KEY: KEY, AI: { run: async () => ({}), models: async () => [] } } as unknown as Env;
  assert.equal(await aiReady(env, 'understand'), false);
  assert.equal(await aiReady(env, 'speech'), false);
  const t = recordingTransport(() => answer(READING_OK));
  assert.equal(await runUnderstand(env, input, { guest: false }, { transport: t }), null);
  assert.equal(t.calls.length, 0);
  const cfg = await loadAiConfig(db);
  assert.equal(cfg?.models.understand.length, 1, 'the row is loaded; it is the missing rate that keeps it idle');
});

test('the retention step deletes old ledger rows only, and skips before 0210', async () => {
  const { raw, db } = aiDb();
  const now = Date.parse('2026-10-22T03:00:00.000Z');
  for (const day of ['2026-07-23', '2026-07-24', '2026-10-21']) {
    raw.prepare("INSERT INTO ai_usage (day, task, provider, model_id, outcome) VALUES (?, 'understand', 'anthropic', 'x', 'OK')").run(day);
  }
  for (const day of ['2025-09-16', '2025-09-18', '2026-10-21']) raw.prepare('INSERT INTO ai_spend_day (day) VALUES (?)').run(day);
  const r = await pruneAiLedger(db, now);
  assert.deepEqual(r, { usage_deleted: 1, days_deleted: 1, skipped: false });
  raw.exec('DROP TABLE ai_usage; DROP TABLE ai_spend_day');
  assert.deepEqual(await pruneAiLedger(db, now), { usage_deleted: 0, days_deleted: 0, skipped: true });
});
