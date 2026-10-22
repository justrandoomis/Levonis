/**
 * THE RUNTIME: RANKS, CIRCUIT, MEMO, ABSENCE (push B plan §16 #8, §6.7, §10).
 *
 *   - rank 0 TIMEOUT (and the other transient codes) falls back to rank 1
 *     inside the shared deadline, but not with less than 2 s left;
 *   - an invalid answer, a refusal, a truncation, a rejected key or an empty
 *     quota goes straight to basic, rank 1 untouched;
 *   - KEY_REJECTED opens the provider circuit for 60 minutes, three
 *     consecutive TIMEOUTs for 5;
 *   - MODEL_GONE marks the row gone, bumps the version, and the next call
 *     skips it;
 *   - the 30 s memo, and a version bump picked up after it;
 *   - a missing 0210 schema, the switch off, a guest, Sorani text: basic,
 *     with no provider call and no write.
 *
 * Run: node --import tsx --test tests/aiRuntimeRouting.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEY, READING_OK, TEXT_MODEL, TEXT_MODEL_B, aiDb, answer, clock, errorResponse, recordingTransport, textModel } from './fixtures/aiLayer';
import { all, asD1, dbThrough, row } from './fixtures/app';
import { forgetAiConfig, loadAiConfig, loadAiState, CONFIG_MEMO_MS } from '../worker/lib/ai/config';
import { aiReady, readiness, runTask, runUnderstand, understandSpec } from '../worker/lib/ai/run';
import type { Env } from '../worker/lib/types';

const input = { text: 'الطابعة تطلع خيوط مثل الشعر', locale: 'ar' as const };
const envOf = (db: D1Database, extra: Record<string, unknown> = {}) => ({ DB: db, ANTHROPIC_API_KEY: KEY, ...extra }) as unknown as Env;
const modelOf = (body: string) => (JSON.parse(body) as { model: string }).model;
const abortLike = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

test('rank 0 TIMEOUT falls back to rank 1 inside the deadline', async () => {
  const c = clock();
  const { db } = aiDb({ models: [textModel('understand', 0), textModel('understand', 1)] });
  const t = recordingTransport((n) => {
    if (n === 1) {
      c.advance(500);
      throw abortLike();
    }
    return answer(READING_OK);
  });
  assert.deepEqual(await runUnderstand(envOf(db), input, { guest: false }, { transport: t, now: c.now }), READING_OK);
  assert.deepEqual(t.calls.map((x) => modelOf(x.body)), [TEXT_MODEL, TEXT_MODEL_B]);
});

test('…but not with less than 2 s left', async () => {
  const c = clock();
  const { db } = aiDb({ models: [textModel('understand', 0), textModel('understand', 1)] });
  const t = recordingTransport(() => {
    c.advance(2_500); // 4 s deadline − 2.5 s = 1.5 s left
    throw abortLike();
  });
  assert.equal(await runUnderstand(envOf(db), input, { guest: false }, { transport: t, now: c.now }), null);
  assert.equal(t.calls.length, 1);
});

test('every transient code may fall back; every terminal code goes straight to basic', async () => {
  const fallback: Array<() => Response> = [
    () => errorResponse(500, 'api_error'),
    () => errorResponse(529, 'overloaded_error'),
    () => errorResponse(429, 'rate_limit_error'),
    () => errorResponse(404, 'not_found_error'),
  ];
  for (const first of fallback) {
    const { db } = aiDb({ models: [textModel('understand', 0), textModel('understand', 1)] });
    const t = recordingTransport((n) => (n === 1 ? first() : answer(READING_OK)));
    assert.deepEqual(await runUnderstand(envOf(db), input, { guest: false }, { transport: t }), READING_OK);
    assert.equal(t.calls.length, 2);
  }
  const terminal: Array<[string, () => Response]> = [
    ['BAD_OUTPUT', () => answer(null, { rawText: 'not json' })],
    ['REFUSAL', () => answer(READING_OK, { stop: 'refusal' })],
    ['TRUNCATED', () => answer(READING_OK, { stop: 'max_tokens' })],
    ['KEY_REJECTED', () => errorResponse(401, 'authentication_error')],
    ['QUOTA', () => errorResponse(402, 'billing_error')],
    ['HTTP_4XX', () => errorResponse(400, 'invalid_request_error')],
  ];
  for (const [code, first] of terminal) {
    const { db } = aiDb({ models: [textModel('understand', 0), textModel('understand', 1)] });
    const t = recordingTransport(first);
    const env = envOf(db);
    const out = await runTask(env, understandSpec(env, input, { guest: false }, { transport: t }), { transport: t });
    assert.equal(out.code, code);
    assert.equal(out.ok, false);
    assert.equal(t.calls.length, 1, `${code} must not reach rank 1`);
  }
});

test('KEY_REJECTED opens the circuit for 60 minutes; OK closes it again', async () => {
  const c = clock();
  const { raw, db } = aiDb({ models: [textModel('understand', 0)] });
  const env = envOf(db);
  let reply: () => Response = () => errorResponse(401, 'authentication_error');
  const t = recordingTransport(() => reply());
  assert.equal(await runUnderstand(env, input, { guest: false }, { transport: t, now: c.now }), null);
  const h = row<{ open_until: string; last_fail_code: string }>(raw, "SELECT open_until, last_fail_code FROM ai_provider_health WHERE provider = 'anthropic'");
  assert.equal(h.last_fail_code, 'KEY_REJECTED');
  assert.equal(h.open_until, new Date(c.now() + 60 * 60_000).toISOString());
  // Same isolate, at once: no call.
  assert.equal(await runUnderstand(env, input, { guest: false }, { transport: t, now: c.now }), null);
  assert.equal(t.calls.length, 1);
  assert.equal(await aiReady(env, 'understand', undefined, c.now()), false);
  // Another isolate (a fresh memo) reads the open circuit from D1.
  forgetAiConfig();
  c.advance(59 * 60_000);
  assert.equal(await runUnderstand(env, input, { guest: false }, { transport: t, now: c.now }), null);
  assert.equal(t.calls.length, 1);
  // After the hour, one call goes through; it succeeds and the circuit closes.
  c.advance(2 * 60_000 + CONFIG_MEMO_MS);
  reply = () => answer(READING_OK);
  assert.deepEqual(await runUnderstand(env, input, { guest: false }, { transport: t, now: c.now }), READING_OK);
  const closed = row<{ open_until: string | null; consecutive_failures: number }>(raw, "SELECT open_until, consecutive_failures FROM ai_provider_health WHERE provider = 'anthropic'");
  assert.deepEqual({ ...closed }, { open_until: null, consecutive_failures: 0 });
});

test('three consecutive TIMEOUTs open the circuit for 5 minutes', async () => {
  const c = clock();
  const { raw, db } = aiDb({ models: [textModel('understand', 0)] });
  const env = envOf(db);
  const t = recordingTransport(() => {
    throw abortLike();
  });
  for (let i = 0; i < 3; i++) {
    assert.equal(await runUnderstand(env, input, { guest: false }, { transport: t, now: c.now }), null);
    c.advance(1_000);
  }
  assert.equal(t.calls.length, 3);
  const h = row<{ open_until: string; consecutive_failures: number }>(raw, "SELECT open_until, consecutive_failures FROM ai_provider_health WHERE provider = 'anthropic'");
  assert.equal(h.consecutive_failures, 3);
  assert.equal(Date.parse(h.open_until) - (c.now() - 1_000), 5 * 60_000);
  assert.equal(await runUnderstand(env, input, { guest: false }, { transport: t, now: c.now }), null);
  assert.equal(t.calls.length, 3, 'open: nothing called');
  // Past the window one call is let through; failing again re-opens at once.
  c.advance(5 * 60_000 + CONFIG_MEMO_MS);
  assert.equal(await runUnderstand(env, input, { guest: false }, { transport: t, now: c.now }), null);
  assert.equal(t.calls.length, 4);
  assert.equal(await runUnderstand(env, input, { guest: false }, { transport: t, now: c.now }), null);
  assert.equal(t.calls.length, 4);
});

test('a refusal or invalid output does not count toward the circuit', async () => {
  const { raw, db } = aiDb({ models: [textModel('understand', 0)] });
  const t = recordingTransport(() => answer(READING_OK, { stop: 'refusal' }));
  for (let i = 0; i < 4; i++) await runUnderstand(envOf(db), input, { guest: false }, { transport: t });
  assert.equal(t.calls.length, 4);
  const h = row<{ open_until: string | null; consecutive_failures: number; last_fail_code: string }>(raw, 'SELECT open_until, consecutive_failures, last_fail_code FROM ai_provider_health');
  assert.deepEqual({ ...h }, { open_until: null, consecutive_failures: 0, last_fail_code: 'REFUSAL' });
});

test('MODEL_GONE marks the row gone and bumps the version; the next call skips it', async () => {
  const { raw, db } = aiDb({ models: [textModel('understand', 0), textModel('understand', 1)] });
  const v0 = row<{ version: number }>(raw, 'SELECT version FROM ai_settings').version;
  const t = recordingTransport((n) => (n === 1 ? errorResponse(404, 'not_found_error') : answer(READING_OK)));
  const env = envOf(db);
  assert.deepEqual(await runUnderstand(env, input, { guest: false }, { transport: t }), READING_OK);
  assert.deepEqual(all<{ rank: number; gone: number }>(raw, 'SELECT rank, gone FROM ai_task_models ORDER BY rank').map((r) => [r.rank, r.gone]), [
    [0, 1],
    [1, 0],
  ]);
  assert.equal(row<{ version: number }>(raw, 'SELECT version FROM ai_settings').version, v0 + 1);
  await runUnderstand(env, input, { guest: false }, { transport: t });
  assert.deepEqual(t.calls.map((x) => modelOf(x.body)), [TEXT_MODEL, TEXT_MODEL_B, TEXT_MODEL_B], 'the gone row is skipped in this isolate at once');
  forgetAiConfig();
  await runUnderstand(env, input, { guest: false }, { transport: t });
  assert.equal(modelOf(t.calls[3]!.body), TEXT_MODEL_B, 'and in every other one');
});

test('the 30 s memo, and a version bump picked up after it', async () => {
  const c = clock();
  const { raw, db } = aiDb({ models: [textModel('understand', 0)] });
  const env = envOf(db);
  assert.equal(await aiReady(env, 'understand', undefined, c.now()), true);
  raw.exec('UPDATE ai_settings SET enabled = 0, version = version + 1');
  c.advance(CONFIG_MEMO_MS - 1);
  assert.equal(await aiReady(env, 'understand', undefined, c.now()), true, 'inside 30 s the memo answers');
  c.advance(2);
  assert.equal(await aiReady(env, 'understand', undefined, c.now()), false, 'after 30 s the kill switch is seen');
  assert.equal((await loadAiConfig(db, c.now()))?.version, 2);
  raw.exec('UPDATE ai_settings SET enabled = 1, version = version + 1');
  forgetAiConfig(db);
  assert.equal(await aiReady(env, 'understand', undefined, c.now()), true, 'the isolate that saved forgets its memo at once');
});

test('a missing 0210 schema is basic everywhere, with no call and no write', async () => {
  const raw = dbThrough('0209');
  const db = asD1(raw);
  const env = envOf(db);
  const t = recordingTransport(() => answer(READING_OK));
  assert.equal(await loadAiState(db), null);
  assert.equal(await aiReady(env, 'understand'), false);
  assert.equal(await runUnderstand(env, input, { guest: false }, { transport: t }), null);
  assert.deepEqual(await readiness(env, { signedIn: true }), {
    mode: 'basic',
    text: false,
    photo: false,
    clip: false,
    voice: false,
    voice_locales: ['ar', 'en'],
    photo_provider: null,
    voice_provider: null,
  });
  assert.equal(t.calls.length, 0);
});

test('the switch off, a guest without the toggle, Sorani text without the toggle: no call, no reservation', async () => {
  const off = aiDb({ enabled: false, models: [textModel('understand', 0)] });
  const t = recordingTransport(() => answer(READING_OK));
  const env = envOf(off.db);
  assert.equal(await runUnderstand(env, input, { guest: false }, { transport: t }), null);

  const guests = aiDb({ guests: false, models: [textModel('understand', 0)] });
  assert.equal(await runUnderstand(envOf(guests.db), input, { guest: true }, { transport: t }), null);
  assert.equal(await aiReady(envOf(guests.db), 'understand', { guest: true }), false);
  assert.equal(await aiReady(envOf(guests.db), 'vision', { guest: true }), false);

  const ckb = aiDb({ models: [textModel('understand', 0)] });
  assert.equal(await runUnderstand(envOf(ckb.db), { text: 'پرینتەرەکەم کار ناکات', locale: 'ar' }, { guest: false }, { transport: t }), null);
  assert.equal(await runUnderstand(envOf(ckb.db), { text: 'my printer', locale: 'ckb' }, { guest: false }, { transport: t }), null);
  assert.equal(t.calls.length, 0);
  for (const d of [off, guests, ckb]) assert.equal(row<{ n: number }>(d.raw, 'SELECT COUNT(*) AS n FROM ai_spend_day').n, 0);

  const ckbOn = aiDb({ understandCkb: true, models: [textModel('understand', 0)] });
  assert.deepEqual(await runUnderstand(envOf(ckbOn.db), { text: 'پرینتەرەکەم کار ناکات', locale: 'ckb' }, { guest: false }, { transport: t }), READING_OK);
  const guestsOn = aiDb({ guests: true, models: [textModel('understand', 0)] });
  assert.deepEqual(await runUnderstand(envOf(guestsOn.db), input, { guest: true }, { transport: t }), READING_OK);
  assert.equal(t.calls.length, 2);
  assert.equal(row<{ guest: number }>(guestsOn.raw, 'SELECT guest FROM ai_usage').guest, 1);
});

test('no key or no model: basic, nothing called', async () => {
  const { db } = aiDb({ models: [textModel('understand', 0)] });
  const t = recordingTransport(() => answer(READING_OK));
  assert.equal(await runUnderstand({ DB: db } as unknown as Env, input, { guest: false }, { transport: t }), null);
  const none = aiDb();
  assert.equal(await runUnderstand(envOf(none.db), input, { guest: false }, { transport: t }), null);
  assert.equal(t.calls.length, 0);
});

test('the bookkeeping goes through waitUntil when the route gives one', async () => {
  const { raw, db } = aiDb({ models: [textModel('understand', 0)] });
  const pending: Promise<unknown>[] = [];
  const t = recordingTransport(() => answer(READING_OK));
  assert.deepEqual(await runUnderstand(envOf(db), input, { guest: false }, { transport: t, waitUntil: (p) => pending.push(p) }), READING_OK);
  assert.equal(pending.length, 1);
  await Promise.all(pending);
  assert.equal(row<{ n: number }>(raw, 'SELECT COUNT(*) AS n FROM ai_usage').n, 1);
});
