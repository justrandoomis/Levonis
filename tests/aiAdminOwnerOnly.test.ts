/**
 * THE OWNER'S AI TAB (push B plan §16 #16, §11), end to end on the real
 * router (tests/routeClass/adminAssistAi.ts classifies it 'owner'):
 *
 *   - 403 for every other admin on every route; a write needs a sign-in
 *     younger than ten minutes;
 *   - a save re-fetches the live list and refuses an id missing from it or
 *     lacking the task's capability, and refuses missing rates;
 *   - a typed speech id is saved only with a passing Test's token;
 *   - no answer carries the key, a prefix of it or its length;
 *   - the audit carries the field NAMES, never a value;
 *   - every config write bumps the version;
 *   - the Test answers codes and flags, never the model's output.
 *
 * The provider is answered by the shared fetch tripwire
 * (tests/fixtures/app.ts `providerFetch`), so nothing leaves the process.
 *
 * Run: node --import tsx --test tests/aiAdminOwnerOnly.test.ts
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { OWNER, all, asD1, dbThrough, get, json, providerFetch, put, post, row, send, stubApp, ctx, type StubUser } from './fixtures/app';
import { KEY, SPEECH_MODEL, TEXT_MODEL, aiDb, answer, fakeAi, jsonResponse, tinyJpeg, textModel } from './fixtures/aiLayer';
import { adminAssistAiRoutes, mintTestToken, testTokenValid, usdToMicro } from '../worker/routes/adminAssistAi';
import { ASSIST_AI_REFUSALS } from '../packages/contracts/src/assistAiRefusals';
import { forgetAiConfig } from '../worker/lib/ai/config';
import type { DatabaseSync } from 'node:sqlite';

const BASE = '/api/admin/assist-ai';
const ADMIN: StubUser = { id: 'usr_admin', role: 'admin', email: 'admin@x.co', admin_scope: 'full' };
const ASSISTANT: StubUser = { id: 'usr_asst', role: 'admin', email: 'asst@x.co', admin_scope: 'assistant' };
const CUSTOMER: StubUser = { id: 'usr_c', role: 'customer', email: 'c@x.co' };

const LIST = [
  { id: TEXT_MODEL, display_name: 'Test Text Model A', capabilities: { structured_outputs: { supported: true }, image_input: { supported: true }, effort: { supported: true, low: { supported: true } } } },
  { id: 'test-text-only', display_name: 'Text Only', capabilities: { structured_outputs: { supported: true }, image_input: { supported: false } } },
];

afterEach(() => {
  providerFetch.handler = null;
  providerFetch.attempts.length = 0;
  forgetAiConfig();
});

function listOnly() {
  providerFetch.handler = async (url) => {
    if (url.startsWith('https://api.anthropic.com/v1/models')) return jsonResponse(200, { data: LIST, has_more: false });
    throw new TypeError('fetch failed');
  };
}

function appFor(raw: DatabaseSync, user: StubUser | null, opts: { env?: Record<string, unknown>; sessionAgeSeconds?: number } = {}) {
  return stubApp(asD1(raw), user, (a) => a.route(BASE, adminAssistAiRoutes), {
    env: { ANTHROPIC_API_KEY: KEY, ...(opts.env ?? {}) },
    sessionAgeSeconds: opts.sessionAgeSeconds,
    publishV2: false,
  });
}

const RATES = { in: '1', out: '5', cache_write: '1.25', cache_read: '0.1' };
const call = (a: ReturnType<typeof appFor>, method: string, path: string, body?: unknown) =>
  method === 'GET' ? get(a, path) : send(a, method, path, body ?? {});
const ROUTES: Array<[string, string, unknown?]> = [
  ['GET', BASE],
  ['GET', `${BASE}/models?task=understand`],
  ['PUT', `${BASE}/tasks/understand/0`, { model_id: TEXT_MODEL, rates: RATES }],
  ['DELETE', `${BASE}/tasks/understand/0`],
  ['PUT', `${BASE}/settings`, { enabled: true }],
  ['POST', `${BASE}/test/understand`, {}],
];

test('every route refuses every other admin with 403 OWNER_ONLY, before anything is read or called', async () => {
  listOnly();
  for (const user of [ADMIN, ASSISTANT, CUSTOMER, { ...ADMIN, admin_scope: null }]) {
    const { raw } = aiDb();
    const a = appFor(raw, user);
    for (const [method, path, body] of ROUTES) {
      const res = await call(a, method, path, body);
      assert.equal(res.status, 403, `${user.id} ${method} ${path}`);
      assert.equal((await json(res)).code, 'OWNER_ONLY');
    }
    assert.equal(row<{ n: number }>(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'assist_ai.%'").n, 0);
  }
  assert.equal(providerFetch.attempts.length, 0, 'no provider was asked for a list on behalf of a non-owner');
  const anon = appFor(aiDb().raw, null);
  assert.equal((await get(anon, BASE)).status, 403);
});

test('a write needs a fresh sign-in: 401 REAUTH_REQUIRED after ten minutes', async () => {
  listOnly();
  const { raw } = aiDb();
  const a = appFor(raw, OWNER, { sessionAgeSeconds: 3600 });
  assert.equal((await get(a, BASE)).status, 200, 'a read does not');
  for (const [method, path, body] of ROUTES.filter(([m]) => m !== 'GET')) {
    const res = await send(a, method, path, body ?? {});
    assert.equal(res.status, 401, `${method} ${path}`);
    assert.equal((await json(res)).code, 'REAUTH_REQUIRED');
  }
  assert.equal(row<{ version: number }>(raw, 'SELECT version FROM ai_settings').version, 1);
});

test('a save re-fetches the live list: an unlisted id, a missing capability, missing rates and an unreadable list are refused', async () => {
  const { raw } = aiDb();
  const a = appFor(raw, OWNER);
  listOnly();
  const code = async (path: string, body: unknown) => {
    const res = await put(a, path, body);
    return [res.status, (await json(res)).code];
  };
  assert.deepEqual(await code(`${BASE}/tasks/understand/0`, { model_id: 'test-not-listed', rates: RATES }), [409, 'AI_MODEL_NOT_LISTED']);
  assert.deepEqual(await code(`${BASE}/tasks/vision/0`, { model_id: 'test-text-only', rates: RATES }), [409, 'AI_MODEL_NOT_LISTED']);
  assert.deepEqual(await code(`${BASE}/tasks/understand/0`, { model_id: TEXT_MODEL, rates: { in: '1' } }), [400, 'AI_RATES_REQUIRED']);
  assert.deepEqual(await code(`${BASE}/tasks/understand/0`, { model_id: TEXT_MODEL, rates: { in: '1', out: '0' } }), [400, 'AI_RATES_REQUIRED']);
  assert.deepEqual(await code(`${BASE}/tasks/understand/0`, { model_id: TEXT_MODEL, rates: { in: '1.1234567', out: '5' } }), [400, 'AI_RATE_INVALID']);
  assert.deepEqual(await code(`${BASE}/tasks/understand/0`, { model_id: TEXT_MODEL, rates: { in: '1e-7', out: '5' } }), [400, 'AI_RATE_INVALID']);
  assert.deepEqual(await code(`${BASE}/tasks/understand/0`, { model_id: 'bad id', rates: RATES }), [400, 'AI_MODEL_ID_INVALID']);
  assert.deepEqual(await code(`${BASE}/tasks/translate/0`, { model_id: TEXT_MODEL, rates: RATES }), [400, 'AI_TASK_INVALID']);
  assert.deepEqual(await code(`${BASE}/tasks/understand/2`, { model_id: TEXT_MODEL, rates: RATES }), [400, 'AI_TASK_INVALID']);
  providerFetch.handler = async () => {
    throw new TypeError('fetch failed');
  };
  assert.deepEqual(await code(`${BASE}/tasks/understand/0`, { model_id: TEXT_MODEL, rates: RATES }), [409, 'AI_MODEL_LIST_UNAVAILABLE']);
  assert.equal(all(raw, 'SELECT * FROM ai_task_models').length, 0);
  assert.equal(row<{ version: number }>(raw, 'SELECT version FROM ai_settings').version, 1, 'a refused save bumps nothing');
});

test('a listed model is saved in micro-USD, with effort from the listing, the version bumped and an audit of names only', async () => {
  const { raw } = aiDb();
  const a = appFor(raw, OWNER);
  listOnly();
  const res = await put(a, `${BASE}/tasks/understand/0`, { model_id: TEXT_MODEL, rates: { in: 1, out: '5', cache_write: '1.25', cache_read: '0.1', per_minute: '9' } });
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.effort_low, true);
  assert.equal(typeof body.worst_case_warn, 'boolean');
  const m = row<Record<string, unknown>>(raw, 'SELECT * FROM ai_task_models');
  assert.equal(m.provider, 'anthropic', 'the provider comes from the task, never the body');
  assert.equal(m.in_micro_per_mtok, 1_000_000);
  assert.equal(m.out_micro_per_mtok, 5_000_000);
  assert.equal(m.cache_write_micro_per_mtok, 1_250_000);
  assert.equal(m.cache_read_micro_per_mtok, 100_000);
  assert.equal(m.speech_micro_per_minute, 0, 'a text row stores no per-minute price');
  assert.equal(m.effort_low, 1);
  assert.equal(m.gone, 0);
  assert.equal(row<{ version: number }>(raw, 'SELECT version FROM ai_settings').version, 2);
  const audit = row<{ action: string; target: string; detail: string }>(raw, "SELECT action, target, detail FROM audit_log WHERE action LIKE 'assist_ai.%'");
  assert.equal(audit.action, 'assist_ai.model.save');
  assert.equal(audit.target, 'assist_ai:understand:0');
  const detail = JSON.parse(audit.detail) as Record<string, unknown>;
  assert.deepEqual(Object.keys(detail).sort(), ['fields', 'model_id', 'rank', 'task']);
  assert.deepEqual(detail.fields, ['model_id', 'rates.in', 'rates.out', 'rates.cache_write', 'rates.cache_read', 'effort_low']);
  for (const v of ['1000000', '5000000', '1250000', '100000', '1.25', '"5"']) assert.ok(!audit.detail.includes(v), `a value reached the audit: ${v}`);

  // Saving the same row again changes nothing but still bumps the version (every write does).
  await put(a, `${BASE}/tasks/understand/0`, { model_id: TEXT_MODEL, rates: { in: 1, out: '5', cache_write: '1.25', cache_read: '0.1' } });
  assert.equal(row<{ version: number }>(raw, 'SELECT version FROM ai_settings').version, 3);
  const second = all<{ detail: string }>(raw, "SELECT detail FROM audit_log WHERE action = 'assist_ai.model.save' ORDER BY rowid")[1]!;
  assert.deepEqual((JSON.parse(second.detail) as { fields: string[] }).fields, []);

  // A saved row clears `gone`.
  raw.exec('UPDATE ai_task_models SET gone = 1');
  await put(a, `${BASE}/tasks/understand/0`, { model_id: TEXT_MODEL, rates: RATES });
  assert.equal(row<{ gone: number }>(raw, 'SELECT gone FROM ai_task_models').gone, 0);

  const del = await send(a, 'DELETE', `${BASE}/tasks/understand/0`);
  assert.equal(del.status, 200);
  assert.equal((await json(del)).removed, true);
  assert.equal(all(raw, 'SELECT * FROM ai_task_models').length, 0);
  assert.equal(row<{ version: number }>(raw, 'SELECT version FROM ai_settings').version, 5);
});

test('settings: validated, the version bumped, the audit names the fields only', async () => {
  const { raw } = aiDb({ enabled: false });
  const a = appFor(raw, OWNER);
  const bad = [{}, { enabled: 'yes' }, { daily_cap_usd: 50.01 }, { daily_cap_usd: '1.005' }, { daily_cap_usd: -1 }, { guest_share_pct: 101 }, { guest_share_pct: 2.5 }, []];
  for (const b of bad) {
    const res = await put(a, `${BASE}/settings`, b);
    assert.equal(res.status, 400, JSON.stringify(b));
    assert.equal((await json(res)).code, 'AI_SETTINGS_INVALID');
  }
  const res = await put(a, `${BASE}/settings`, { enabled: true, daily_cap_usd: '2.50', guests: true, guest_share_pct: 10, understand_ckb: false });
  assert.equal(res.status, 200);
  const s = row<Record<string, number>>(raw, 'SELECT enabled, daily_cap_micro_usd, guests, guest_share_pct, understand_ckb, version FROM ai_settings');
  assert.deepEqual({ ...s }, { enabled: 1, daily_cap_micro_usd: 2_500_000, guests: 1, guest_share_pct: 10, understand_ckb: 0, version: 2 });
  const audit = row<{ detail: string }>(raw, "SELECT detail FROM audit_log WHERE action = 'assist_ai.settings.save'");
  assert.deepEqual(JSON.parse(audit.detail), { fields: ['enabled', 'guests', 'daily_cap_micro_usd', 'guest_share_pct'] });
  assert.ok(!/2500000|2\.5|"10"/.test(audit.detail));
  assert.equal((await put(a, `${BASE}/settings`, { daily_cap_usd: 50 })).status, 200, 'the $50 ceiling itself is allowed');
});

test('a typed speech id is saved only with a passing Test token, for that id, within ten minutes', async () => {
  const { raw } = aiDb();
  const ai = fakeAi({
    models: async () => {
      throw new Error('models() not allowed');
    },
  });
  const a = appFor(raw, OWNER, { env: { AI: ai } });
  const rates = { per_minute: '0.006' };
  let res = await put(a, `${BASE}/tasks/speech/0`, { model_id: SPEECH_MODEL, rates });
  assert.equal(res.status, 409);
  assert.equal((await json(res)).code, 'AI_TEST_TOKEN_REQUIRED');
  assert.equal((await json(await get(a, `${BASE}/models?task=speech`))).models, null, 'the list is null, so the UI offers the typed id');

  const form = new FormData();
  form.set('audio', new File([new Uint8Array(4000).fill(7)], 'note.webm', { type: 'audio/webm' }));
  form.set('model_id', SPEECH_MODEL);
  form.set('per_minute', '0.006');
  const test1 = await a.request(`${BASE}/test/speech`, { method: 'POST', body: form, headers: { 'CF-Connecting-IP': '1.2.3.4' } }, undefined, ctx);
  assert.equal(test1.status, 200);
  const t = await json(test1);
  assert.deepEqual(
    { ok: t.ok, code: t.code, valid: t.valid, expected: t.expected },
    { ok: true, code: 'OK', valid: true, expected: true }
  );
  assert.equal(typeof t.test_token, 'string');
  assert.ok(!JSON.stringify(t).includes('hello'), 'the transcript is never returned by the Test');
  assert.equal(ai.runs[0]!.model, SPEECH_MODEL);

  res = await put(a, `${BASE}/tasks/speech/0`, { model_id: 'test/other-speech', rates, test_token: t.test_token });
  assert.equal((await json(res)).code, 'AI_TEST_TOKEN_REQUIRED', 'a token is for its own id');
  res = await put(a, `${BASE}/tasks/speech/0`, { model_id: SPEECH_MODEL, rates, test_token: String(t.test_token).replace(/.$/, (ch) => (ch === '0' ? '1' : '0')) });
  assert.equal((await json(res)).code, 'AI_TEST_TOKEN_REQUIRED', 'a tampered token is refused');
  res = await put(a, `${BASE}/tasks/speech/0`, { model_id: SPEECH_MODEL, rates, test_token: t.test_token });
  assert.equal(res.status, 200);
  const m = row<Record<string, unknown>>(raw, 'SELECT provider, model_id, speech_micro_per_minute, in_micro_per_mtok FROM ai_task_models');
  assert.deepEqual({ ...m }, { provider: 'workers_ai', model_id: SPEECH_MODEL, speech_micro_per_minute: 6_000, in_micro_per_mtok: 0 });

  const now = Date.now();
  const token = await mintTestToken(SPEECH_MODEL, now);
  assert.equal(await testTokenValid(token, SPEECH_MODEL, now + 9 * 60_000), true);
  assert.equal(await testTokenValid(token, SPEECH_MODEL, now + 11 * 60_000), false, 'ten minutes, then it is gone');
  assert.equal(await testTokenValid('1.abc', SPEECH_MODEL, now), false);
});

test('a listed speech id needs no token, and the speech list comes from the binding', async () => {
  const { raw } = aiDb();
  const ai = fakeAi({ models: async () => [{ name: SPEECH_MODEL, task: { name: 'Automatic Speech Recognition' } }] });
  const a = appFor(raw, OWNER, { env: { AI: ai } });
  assert.deepEqual((await json(await get(a, `${BASE}/models?task=speech`))).models, [{ id: SPEECH_MODEL, label: SPEECH_MODEL, effortLow: false }]);
  assert.equal((await put(a, `${BASE}/tasks/speech/1`, { model_id: SPEECH_MODEL, rates: { per_minute: '0.006' } })).status, 200);
  assert.equal((await put(a, `${BASE}/tasks/speech/0`, { model_id: 'test/unlisted', rates: { per_minute: '0.006' } })).status, 409);
  assert.equal((await put(a, `${BASE}/tasks/speech/0`, { model_id: SPEECH_MODEL, rates: { in: '1', out: '1' } })).status, 400, 'speech needs its per-minute price');
});

test('no answer carries the key, a prefix of it, or its length', async () => {
  const { raw } = aiDb({ models: [textModel('understand', 0), textModel('vision', 0)] });
  const a = appFor(raw, OWNER);
  listOnly();
  const bodies: string[] = [];
  for (const [method, path, body] of ROUTES) bodies.push(await (await call(a, method, path, body)).text());
  const overview = await json(await get(a, BASE));
  bodies.push(JSON.stringify(overview));
  assert.deepEqual(Object.keys(overview.health).sort(), ['ai_binding', 'anthropic_key', 'images_binding', 'providers']);
  assert.equal(overview.health.anthropic_key, true);
  for (const b of bodies) {
    assert.ok(!b.includes(KEY.slice(0, 8)), 'a prefix of the key');
    assert.ok(!b.includes(KEY), 'the key');
    assert.doesNotMatch(b, /key_?(prefix|len|length|hint|last)/i);
  }
});

test('GET: the overview, and { migrated: false } before 0210; every write 409 AI_SCHEMA_MISSING', async () => {
  const { raw } = aiDb({ models: [textModel('understand', 0)] });
  raw.prepare("INSERT INTO ai_usage (day, task, provider, model_id, outcome, cost_micro_usd) VALUES (date('now'), 'understand', 'anthropic', 'x', 'TIMEOUT', 1200)").run();
  raw.prepare("INSERT INTO ai_spend_day (day, spent_micro_usd, calls) VALUES (date('now'), 1200, 1)").run();
  const a = appFor(raw, OWNER);
  const res = await get(a, BASE);
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  const o = await json(res);
  assert.equal(o.migrated, true);
  assert.deepEqual(o.settings, { ...o.settings, enabled: true, daily_cap_usd: 1, guests: false, guest_share_pct: 25, understand_ckb: false });
  assert.equal(o.tasks.length, 1);
  assert.deepEqual(o.tasks[0].rates, { in: 1, out: 5, cache_write: 0, cache_read: 0, per_minute: 0 });
  assert.equal(o.tasks[0].ready, true);
  assert.equal(o.today.spent, 0.0012);
  assert.equal(o.today.calls, 1);
  assert.deepEqual(o.outcomes_24h, { understand: { TIMEOUT: 1 } });
  assert.equal(o.week[0].cost, 0.0012);

  const old = dbThrough('0209');
  const b = appFor(old, OWNER);
  const og = await json(await get(b, BASE));
  assert.equal(og.migrated, false);
  listOnly();
  for (const [method, path, body] of ROUTES.filter(([m]) => m !== 'GET')) {
    const r = await send(b, method, path, body ?? {});
    assert.equal(r.status, 409, `${method} ${path}`);
    assert.equal((await json(r)).code, 'AI_SCHEMA_MISSING');
  }
});

test('the understanding Test is budgeted and ledgered, and answers codes and flags only', async () => {
  const { raw } = aiDb({ enabled: false, models: [textModel('understand', 0)] });
  const a = appFor(raw, OWNER);
  providerFetch.handler = async () =>
    answer({ action: 'triage', intent: 'none', printer: 'a1', part: 'none', symptom: 'clog', outcome: 'none', maintenance: false, terms: ['ZZMODELZZ'] });
  const res = await post(a, `${BASE}/test/understand`, {});
  const t = await json(res);
  assert.deepEqual(Object.keys(t).sort(), ['code', 'cost_micro_usd', 'expected', 'ms', 'ok', 'success', 'valid']);
  assert.deepEqual({ ok: t.ok, code: t.code, valid: t.valid, expected: t.expected }, { ok: true, code: 'OK', valid: true, expected: true });
  assert.ok(t.cost_micro_usd > 0);
  assert.ok(!JSON.stringify(t).includes('ZZMODELZZ'), 'the output never leaves the handler');
  assert.equal(row<{ outcome: string }>(raw, 'SELECT outcome FROM ai_usage').outcome, 'OK', 'the Test runs while the switch is off, and is ledgered');
  assert.equal(providerFetch.attempts.filter((x) => x.url === 'https://api.anthropic.com/v1/messages').length, 1);

  providerFetch.handler = async () => answer({ action: 'none' });
  const bad = await json(await post(a, `${BASE}/test/understand`, {}));
  assert.deepEqual({ ok: bad.ok, valid: bad.valid, expected: bad.expected }, { ok: true, valid: false, expected: false });
});

test('the vision Test reads the code the admin browser drew', async () => {
  const { raw } = aiDb({ models: [textModel('vision', 0)] });
  const a = appFor(raw, OWNER);
  providerFetch.handler = async () =>
    answer({ subject: 'printer_screen', printer: 'none', symptom: 'none', part: 'none', hms_codes: ['0300-0100-0001-0003'], label_codes: [], confidence: 'high' });
  const form = new FormData();
  form.set('image', new File([tinyJpeg(800, 600, { app1: true })], 'test.jpg', { type: 'image/jpeg' }));
  form.set('code', '0300-0100-0001-0003');
  const res = await a.request(`${BASE}/test/vision`, { method: 'POST', body: form, headers: { 'CF-Connecting-IP': '1.2.3.4' } }, undefined, ctx);
  const t = await json(res);
  assert.deepEqual({ ok: t.ok, valid: t.valid, expected: t.expected }, { ok: true, valid: true, expected: true });
  assert.ok(!JSON.stringify(t).includes('0300-0100'), 'not even the code read is returned');

  const noImage = new FormData();
  noImage.set('code', '0300-0100-0001-0003');
  const r2 = await a.request(`${BASE}/test/vision`, { method: 'POST', body: noImage, headers: { 'CF-Connecting-IP': '1.2.3.4' } }, undefined, ctx);
  assert.equal((await json(r2)).code, 'AI_TEST_INPUT_INVALID');
  const json400 = await post(a, `${BASE}/test/vision`, {});
  assert.equal(json400.status, 400);
});

test('the Test is rate-limited to 6 per 15 minutes', async () => {
  const { raw } = aiDb();
  const a = appFor(raw, OWNER);
  const codes: number[] = [];
  for (let i = 0; i < 7; i++) codes.push((await post(a, `${BASE}/test/understand`, {})).status);
  assert.deepEqual(codes, [200, 200, 200, 200, 200, 200, 429]);
});

test('usdToMicro reads decimal text exactly', () => {
  assert.equal(usdToMicro('0.000001', 6, 1e9), 1);
  assert.equal(usdToMicro(0.1, 6, 1e9), 100_000);
  assert.equal(usdToMicro('15', 6, 1e9), 15_000_000);
  assert.equal(usdToMicro('1000', 6, 1e9), 1_000_000_000);
  assert.equal(usdToMicro('1000.000001', 6, 1e9), 'invalid');
  assert.equal(usdToMicro('1.5', 2, 50_000_000), 1_500_000);
  assert.equal(usdToMicro('1.555', 2, 50_000_000), 'invalid');
  assert.equal(usdToMicro(undefined, 6, 1e9), null);
  assert.equal(usdToMicro('-1', 6, 1e9), 'invalid');
  assert.equal(usdToMicro(Number.NaN, 6, 1e9), 'invalid');
});

test('every refusal of the tab has ar, en and its own ckb', () => {
  for (const [code, e] of Object.entries(ASSIST_AI_REFUSALS)) {
    for (const lang of ['ar', 'en', 'ckb'] as const) assert.ok(e[lang].trim().length > 0, `${code}.${lang}`);
    assert.notEqual(e.ckb, e.ar, `${code}: ckb is the Arabic`);
    assert.notEqual(e.ckb, e.en, `${code}: ckb is the English`);
    assert.notEqual(e.en, e.ar, `${code}: en is the Arabic`);
    for (const lang of ['ar', 'ckb'] as const) assert.ok(!/[A-Z]{3,}_[A-Z]/.test(e[lang]), `${code}.${lang} carries a machine code`);
  }
  const route = readFileSync(join(ROOT, 'worker/routes/adminAssistAi.ts'), 'utf8');
  for (const m of route.matchAll(/refuse\(\d+, '([A-Z_]+)'\)/g)) assert.ok(m[1]! in ASSIST_AI_REFUSALS, `${m[1]} has no sentences`);
});
