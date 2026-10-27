/**
 * THE CREATIVE STUDIO'S PROVIDER PAGE — who may see and change it, where the
 * key lives and that it never comes back (docs/CREATIVE_STUDIO.md §4,
 * spec §27, §32; DECISIONS row 270).
 *
 *   - role gating: the owner manages; a full admin reads a reduced view; an
 *     assistant admin is refused (CREATIVE_SCOPE_REQUIRED); owner routes refuse
 *     every other admin (OWNER_ONLY); a merchant host never sees the router;
 *   - the typed key is sealed (AES-256-GCM, bound to its row), shown only as
 *     a 4-character hint to the owner, and appears in no answer, no audit row
 *     and no other column — searched in the whole JSON;
 *   - without the vault secret a typed key is refused ENCRYPTION_NOT_CONFIGURED
 *     and the Worker secret ANTHROPIC_API_KEY still works;
 *   - the model is chosen from the live list (fake ids only), the request
 *     carries no sampling parameter, and effort only when the model supports it.
 *
 * Run: node --import tsx --test tests/creativeStudioProvider.test.ts
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { OWNER, MERCHANT_HOST, all, get, json as body, post, put, send } from './fixtures/app';
import {
  ASSISTANT, BASE, ENC_KEY, FULL, MODEL_A, MODEL_B, SECRET_KEY, TYPED_KEY, deepStrings, message, standardProvider, stubProvider, studioApp, studioDb,
} from './fixtures/creativeStudio';
import { RESPONSE_CAP_BYTES, messagesBody } from '../worker/lib/creative/anthropic';
import { readBodyCapped } from '../worker/lib/creative/readBody';
import { NO_CAPABILITIES } from '../worker/lib/creative/settings';
import { sealWith, unsealWith } from '../worker/lib/sealbox';
import { PROVIDER_KEY_AAD, openProviderKey, sealProviderKey } from '../worker/lib/creative/keyVault';

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

test('role gating: owner manages, a full admin reads a reduced view, an assistant is refused, owner routes refuse everyone else', async () => {
  const raw = await studioDb();
  const owner = studioApp(raw, OWNER);
  const full = studioApp(raw, FULL);
  const asst = studioApp(raw, ASSISTANT);

  const o = await body(await get(owner, `${BASE}/provider`));
  assert.equal(o.success, true);
  assert.equal(o.can_manage, true);
  assert.equal(o.provider, 'anthropic');
  assert.equal(o.encryption_ready, true);
  assert.equal(o.key.source, 'none');
  assert.equal(o.ready, false);
  assert.equal(o.not_ready_code, 'KEY_NOT_CONFIGURED');
  assert.deepEqual(o.budget, { daily_requests: 60, daily_tokens: 600000, daily_usd: null, monthly_usd: null, max_parallel: 2, auto_fix_rounds: 2 });

  const f = await body(await get(full, `${BASE}/provider`));
  assert.equal(f.can_manage, false, 'a full admin reads, never manages');
  assert.equal(f.rates, null);

  const a = await get(asst, `${BASE}/provider`);
  assert.equal(a.status, 403);
  assert.equal((await body(a)).code, 'CREATIVE_SCOPE_REQUIRED');
  for (const path of ['/documents', '/products', '/brand', '/jobs', '/opportunities']) {
    const r = await get(asst, `${BASE}${path}`);
    assert.equal(r.status, 403, path);
    assert.equal((await body(r)).code, 'CREATIVE_SCOPE_REQUIRED', path);
  }

  for (const [method, path] of [['PUT', '/provider/key'], ['DELETE', '/provider/key'], ['POST', '/provider/test'], ['GET', '/provider/models'], ['PUT', '/provider/settings'], ['POST', '/brand/versions'], ['POST', '/claims'], ['POST', '/snapshots/import']] as const) {
    for (const app of [full, asst]) {
      const r = method === 'GET' ? await get(app, `${BASE}${path}`) : await send(app, method, `${BASE}${path}`, {});
      assert.equal(r.status, 403, `${method} ${path}`);
      assert.equal((await body(r)).code, 'OWNER_ONLY', `${method} ${path}`);
    }
  }
});

test('the router does not exist on a merchant host, even for the owner', async () => {
  const raw = await studioDb();
  const app = studioApp(raw, OWNER, {}, { host: MERCHANT_HOST });
  for (const path of ['/provider', '/documents', '/products']) {
    const r = await get(app, `${BASE}${path}`);
    assert.equal(r.status, 404, path);
    assert.equal((await body(r)).code, undefined);
  }
});

test('a typed key is sealed, shown as a 4-character hint to the owner only, and appears in no answer, audit row or other column', async () => {
  const raw = await studioDb();
  const owner = studioApp(raw, OWNER);
  const set = await put(owner, `${BASE}/provider/key`, { api_key: TYPED_KEY });
  assert.equal(set.status, 200);
  const status = await body(set);
  assert.equal(status.key.source, 'stored');
  assert.equal(status.key.hint, TYPED_KEY.slice(-4));
  assert.ok(!deepStrings(status).includes(TYPED_KEY), 'the PUT answer never echoes the key');

  // In the database: ciphertext only, bound to its row.
  const row = raw.prepare(`SELECT key_sealed, key_hint FROM creative_provider_settings WHERE id = 'anthropic'`).get() as { key_sealed: string; key_hint: string };
  assert.match(row.key_sealed, /^sealed:v1:/);
  assert.ok(!row.key_sealed.includes(TYPED_KEY));
  assert.equal(await unsealWith(ENC_KEY, row.key_sealed), null, 'without the row binding (AAD) the ciphertext does not open');
  assert.equal(await unsealWith(ENC_KEY, row.key_sealed, { aad: PROVIDER_KEY_AAD }), TYPED_KEY);

  // Nowhere else: every answer the studio gives, every audit row, every text column of every studio table.
  const full = studioApp(raw, FULL);
  for (const [app, path] of [[owner, '/provider'], [full, '/provider'], [owner, '/usage'], [owner, '/jobs']] as const) {
    const res = await get(app, `${BASE}${path}`);
    assert.ok(!deepStrings(await body(res)).includes(TYPED_KEY), path);
  }
  const f = await body(await get(full, `${BASE}/provider`));
  assert.equal(f.key.source, 'stored');
  assert.equal(f.key.hint, null, 'the hint is the owner\'s alone');
  const audits = all(raw, `SELECT action, detail FROM audit_log WHERE action LIKE 'creative.%'`);
  assert.ok(audits.some((a) => a.action === 'creative.provider.key_set'));
  assert.ok(!deepStrings(audits).includes(TYPED_KEY) && !deepStrings(audits).includes(TYPED_KEY.slice(-4)), 'the audit row carries neither the key nor its hint');
  for (const t of all(raw, `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'creative_%'`)) {
    const dump = deepStrings(all(raw, `SELECT * FROM ${t.name}`));
    assert.ok(!dump.includes(TYPED_KEY), `${t.name} holds the key in clear`);
  }

  // Deleting it removes the ciphertext and the hint.
  const del = await send(owner, 'DELETE', `${BASE}/provider/key`, {});
  assert.equal(del.status, 200);
  assert.equal((await body(del)).key.source, 'none');
  const after = raw.prepare(`SELECT key_sealed, key_hint FROM creative_provider_settings WHERE id = 'anthropic'`).get() as { key_sealed: string | null; key_hint: string | null };
  assert.equal(after.key_sealed, null);
  assert.equal(after.key_hint, null);
});

test('a key write needs a sign-in within ten minutes', async () => {
  const raw = await studioDb();
  const stale = studioApp(raw, OWNER, {}, { sessionAgeSeconds: 3600 });
  const r = await put(stale, `${BASE}/provider/key`, { api_key: TYPED_KEY });
  assert.equal(r.status, 401);
  assert.equal((await body(r)).code, 'REAUTH_REQUIRED');
  assert.equal(raw.prepare(`SELECT COUNT(*) AS n FROM creative_provider_settings`).get()!.n, 0);
});

test('without the vault secret a typed key is refused ENCRYPTION_NOT_CONFIGURED — and the Worker secret still works', async () => {
  const raw = await studioDb();
  for (const broken of [undefined, '', 'v1:not-base64-of-32-bytes']) {
    const app = studioApp(raw, OWNER, { CREATIVE_STUDIO_ENC_KEY: broken });
    const st = await body(await get(app, `${BASE}/provider`));
    assert.equal(st.encryption_ready, false, String(broken));
    const r = await put(app, `${BASE}/provider/key`, { api_key: TYPED_KEY });
    assert.equal(r.status, 503, String(broken));
    assert.equal((await body(r)).code, 'ENCRYPTION_NOT_CONFIGURED');
  }
  assert.equal(raw.prepare(`SELECT COUNT(*) AS n FROM creative_provider_settings WHERE key_sealed IS NOT NULL`).get()!.n, 0);

  // The Worker secret: source worker_secret, no hint, and it is the key the provider receives.
  const app = studioApp(raw, OWNER, { CREATIVE_STUDIO_ENC_KEY: undefined, ANTHROPIC_API_KEY: SECRET_KEY });
  const st = await body(await get(app, `${BASE}/provider`));
  assert.equal(st.key.source, 'worker_secret');
  assert.equal(st.key.hint, null);
  const stub = stubProvider(standardProvider());
  restore = stub.restore;
  const models = await get(app, `${BASE}/provider/models`);
  assert.equal(models.status, 200);
  assert.equal(stub.calls[0]!.headers['x-api-key'], SECRET_KEY);
  assert.ok(!deepStrings(await body(models)).includes(SECRET_KEY));
});

test('a stored key outranks the Worker secret, and a key that can no longer be opened falls back honestly', async () => {
  const raw = await studioDb();
  const app = studioApp(raw, OWNER, { ANTHROPIC_API_KEY: SECRET_KEY });
  await put(app, `${BASE}/provider/key`, { api_key: TYPED_KEY });
  const stub = stubProvider(standardProvider());
  restore = stub.restore;
  await get(app, `${BASE}/provider/models`);
  assert.equal(stub.calls.at(-1)!.headers['x-api-key'], TYPED_KEY, 'the owner\'s stored key is used first');
  // The vault secret rotated away: the stored key cannot open, the Worker secret takes over.
  const rotated = studioApp(raw, OWNER, { ANTHROPIC_API_KEY: SECRET_KEY, CREATIVE_STUDIO_ENC_KEY: `v1:${Buffer.alloc(32, 99).toString('base64')}` });
  const st = await body(await get(rotated, `${BASE}/provider`));
  assert.equal(st.key.source, 'worker_secret');
  await get(rotated, `${BASE}/provider/models`);
  assert.equal(stub.calls.at(-1)!.headers['x-api-key'], SECRET_KEY);
});

test('the vault: a KYC ciphertext never opens as a provider key, and a provider ciphertext never opens without its binding', async () => {
  const env = { CREATIVE_STUDIO_ENC_KEY: ENC_KEY };
  const sealed = await sealProviderKey(env, TYPED_KEY);
  assert.equal(await openProviderKey(env, sealed), TYPED_KEY);
  const plain = await sealWith(ENC_KEY, TYPED_KEY);
  assert.equal(await openProviderKey(env, plain), null, 'a ciphertext without the row binding is refused');
  // Rotation: a second key encrypts, the first still opens.
  const ring = { CREATIVE_STUDIO_ENC_KEY: `${ENC_KEY},v2:${Buffer.alloc(32, 12).toString('base64')}` };
  const fresh = await sealProviderKey(ring, TYPED_KEY);
  assert.match(fresh, /^sealed:v2:/);
  assert.equal(await openProviderKey(ring, sealed), TYPED_KEY);
  assert.equal(await openProviderKey(ring, fresh), TYPED_KEY);
});

test('the model is chosen from the live list only; the list pages through has_more; a model without structured outputs is refused', async () => {
  const raw = await studioDb();
  const app = studioApp(raw, OWNER, { ANTHROPIC_API_KEY: SECRET_KEY });
  let page = 0;
  const stub = stubProvider((call) => {
    assert.ok(call.url.startsWith('https://api.anthropic.com/v1/models?limit=100'));
    page += 1;
    if (page === 1) return Response.json({ data: [{ id: MODEL_A, display_name: 'A', capabilities: { structured_outputs: { supported: true } } }], has_more: true, last_id: MODEL_A });
    assert.ok(call.url.includes(`after_id=${MODEL_A}`));
    return Response.json({ data: [{ id: 'test-model-legacy', display_name: 'Legacy', capabilities: { structured_outputs: { supported: false } } }, { id: MODEL_B, display_name: 'B' }], has_more: false, last_id: MODEL_B });
  });
  restore = stub.restore;
  const list = await body(await get(app, `${BASE}/provider/models`));
  assert.deepEqual(list.models.map((m: { id: string }) => m.id), [MODEL_A, 'test-model-legacy', MODEL_B]);
  const b = list.models.find((m: { id: string }) => m.id === MODEL_B);
  assert.equal(b.structured_outputs, null, 'an absent capability is unknown, never guessed');
  assert.equal(stub.calls[0]!.headers['anthropic-version'], '2026-10-21');

  page = 0;
  const r1 = await put(app, `${BASE}/provider/settings`, { model: 'test-model-not-listed' });
  assert.equal(r1.status, 400);
  page = 0;
  const r2 = await put(app, `${BASE}/provider/settings`, { model: 'test-model-legacy' });
  assert.equal(r2.status, 400);
  page = 0;
  const r3 = await put(app, `${BASE}/provider/settings`, { model: MODEL_A, effort: 'high', budget: { daily_requests: 5, max_parallel: 99 }, rates: { input_per_mtok_usd: 4, output_per_mtok_usd: 20, source: 'owner, provider price page', as_of: '2026-10-27' }, vision_review: true, priorities: ['  filament week ', 'filament week'] });
  assert.equal(r3.status, 200);
  const st = await body(r3);
  assert.equal(st.model, MODEL_A);
  assert.equal(st.effort, 'high');
  assert.equal(st.budget.daily_requests, 5);
  assert.equal(st.budget.max_parallel, 8, 'clamped, never unlimited');
  assert.equal(st.rates.input_per_mtok_usd, 4);
  assert.equal(st.vision_review, true);
  assert.equal(st.ready, true);
  assert.deepEqual(JSON.parse((raw.prepare(`SELECT priorities_json FROM creative_provider_settings`).get() as { priorities_json: string }).priorities_json), ['filament week']);
});

test('the request body: no sampling parameters, no tools, no prefill; effort only when the model lists it', () => {
  const base = { task: 'compose' as const, model: MODEL_A, system: 's', content: [{ type: 'text' as const, text: 'x' }], schema: { type: 'object' } };
  const withEffort = messagesBody({ ...base, effort: 'high', capabilities: { model: MODEL_A, structured_outputs: true, vision: true, effort: true, effort_levels: ['low', 'medium', 'high'] } });
  assert.deepEqual(Object.keys(withEffort).sort(), ['max_tokens', 'messages', 'model', 'output_config', 'system']);
  assert.equal(withEffort.max_tokens, 16000);
  assert.deepEqual(withEffort.output_config, { format: { type: 'json_schema', schema: { type: 'object' } }, effort: 'high' });
  assert.deepEqual((withEffort.messages as Array<{ role: string }>).map((m) => m.role), ['user'], 'one user turn, never an assistant prefill');
  for (const banned of ['temperature', 'top_p', 'top_k', 'tools', 'tool_choice', 'stream', 'thinking']) assert.ok(!(banned in withEffort), banned);
  const noEffort = messagesBody({ ...base, effort: 'high', capabilities: { ...NO_CAPABILITIES, effort_levels: [] } });
  assert.ok(!('effort' in (noEffort.output_config as object)), 'unknown effort support: not sent');
  const notListed = messagesBody({ ...base, effort: 'low', capabilities: { model: MODEL_A, structured_outputs: true, vision: true, effort: true, effort_levels: ['high'] } });
  assert.ok(!('effort' in (notListed.output_config as object)));
  assert.equal(messagesBody({ ...base, task: 'edit', effort: null, capabilities: NO_CAPABILITIES }).max_tokens, 8000);
});

test('the connection test: a small real request with the chosen model, recorded with its capabilities; a model that left the list is MODEL_GONE', async () => {
  const raw = await studioDb();
  const app = studioApp(raw, OWNER, { ANTHROPIC_API_KEY: SECRET_KEY });
  // No model chosen yet: the test is the model list.
  const stub = stubProvider(standardProvider());
  restore = stub.restore;
  const first = await body(await post(app, `${BASE}/provider/test`, {}));
  assert.deepEqual(first.test, { ok: true, code: null });
  assert.equal(stub.messages().length, 0, 'no model chosen: the list call only');
  await put(app, `${BASE}/provider/settings`, { model: MODEL_A, effort: 'low' });
  const second = await body(await post(app, `${BASE}/provider/test`, {}));
  assert.deepEqual(second.test, { ok: true, code: null });
  assert.equal(second.capabilities.vision, true);
  assert.equal(second.last_test.ok, true);
  const msg = stub.messages().at(-1)!;
  assert.equal(msg.body!.model, MODEL_A);
  assert.equal((msg.body!.output_config as { effort?: string }).effort, 'low');
  assert.equal(all(raw, `SELECT task, status FROM creative_usage`).length, 1);

  stub.restore();
  const gone = stubProvider((call) => (call.url.includes('/v1/models') ? Response.json({ data: [{ id: MODEL_B }], has_more: false }) : message({ ok: true })));
  restore = gone.restore;
  const third = await body(await post(app, `${BASE}/provider/test`, {}));
  assert.deepEqual(third.test, { ok: false, code: 'MODEL_GONE' });
  assert.equal(gone.messages().length, 0, 'no message to a model that is not listed');
});

test('AI routes refuse before anything when no key or no model is configured', async () => {
  const raw = await studioDb();
  const app = studioApp(raw, OWNER);
  const r = await post(app, `${BASE}/ai/ideas`, { count: 3, priorities: [], idempotency_key: 'ideas-key-0001' });
  assert.equal(r.status, 409);
  assert.equal((await body(r)).code, 'KEY_NOT_CONFIGURED');
  const withKey = studioApp(raw, OWNER, { ANTHROPIC_API_KEY: SECRET_KEY });
  const r2 = await post(withKey, `${BASE}/ai/ideas`, { count: 3, priorities: [], idempotency_key: 'ideas-key-0002' });
  assert.equal(r2.status, 409);
  assert.equal((await body(r2)).code, 'MODEL_NOT_SELECTED');
  assert.equal(all(raw, 'SELECT * FROM creative_jobs').length, 0);
});

test('the answer reader: a declared or streamed body over the cap is TOO_LARGE, a fired deadline TIMEOUT, a whole body its text', async () => {
  const big = new Uint8Array(RESPONSE_CAP_BYTES + 1);
  assert.deepEqual(await readBodyCapped(new Response(big, { headers: { 'content-length': String(big.byteLength) } }), RESPONSE_CAP_BYTES), { ok: false, code: 'TOO_LARGE' });
  // No content-length: the stream itself is counted and cancelled past the cap.
  let pulled = 0;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new Uint8Array(64 * 1024));
    },
  });
  assert.deepEqual(await readBodyCapped(new Response(endless), RESPONSE_CAP_BYTES), { ok: false, code: 'TOO_LARGE' });
  assert.ok(pulled <= RESPONSE_CAP_BYTES / (64 * 1024) + 2, 'reading stops at the cap, not at the end of an endless body');
  // A body that never finishes: the attempt's deadline ends the read.
  const stalled = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined) });
  assert.deepEqual(await readBodyCapped(new Response(stalled), RESPONSE_CAP_BYTES, AbortSignal.timeout(20)), { ok: false, code: 'TIMEOUT' });
  assert.deepEqual(await readBodyCapped(Response.json({ ok: 'yes' }), RESPONSE_CAP_BYTES), { ok: true, text: '{"ok":"yes"}' });
});
