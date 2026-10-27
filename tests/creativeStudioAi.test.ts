/**
 * THE CREATIVE STUDIO'S AI REQUESTS — what happens on every provider outcome,
 * the budget under parallel calls, idempotency, cancellation, and the local
 * validation that decides what the app accepts (spec §27–§29, §16;
 * acceptance 9, 10, 15, 16; docs/CREATIVE_STUDIO.md §4).
 *
 * The provider is a stub behind the router's injectable transport; model ids
 * are fake. Every failure must leave a FAILED job, a usage row with its code,
 * an error answer and no stored result — never a fake success.
 *
 * Run: node --import tsx --test tests/creativeStudioAi.test.ts
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { OWNER, all, get, json as body, post, put, row } from './fixtures/app';
import {
  BASE, MODEL_A, SECRET_KEY, design, json, message, modelsPage, standardProvider, stubProvider, studioApp, studioDb, textLayer, type ProviderHandler,
} from './fixtures/creativeStudio';

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

const IDEA = {
  objective: 'education', target_kind: 'topic', target_ref: '', audience: 'مبتدئون', reason: 'موضوع تعليمي يناسب المبتدئين',
  evidence_ids: ['education_topic:first_print'], message: 'خطوات أول طباعة', headline: 'ابدأ أول طباعة', subhead: 'من الملف إلى القطعة',
  cta: 'تعرّف أكثر', post_type: 'single', layout: 'headline_first', caption: 'دليل سريع لأول طباعة', alt_text: 'طابعة تطبع قطعة',
};

/** The studio with the Worker secret and a chosen model; the stub answers messages with `answer`. */
async function ready(handler?: ProviderHandler, settings: Record<string, unknown> = {}) {
  const raw = await studioDb();
  const app = studioApp(raw, OWNER, { ANTHROPIC_API_KEY: SECRET_KEY });
  let current: ProviderHandler = handler ?? standardProvider(() => message({ ideas: [IDEA], notes: [] }));
  const stub = stubProvider((call) => (call.url.includes('/v1/models') ? modelsPage() : current(call)));
  restore = stub.restore;
  const res = await put(app, `${BASE}/provider/settings`, { model: MODEL_A, ...settings });
  assert.equal(res.status, 200);
  return { raw, app, stub, set: (h: ProviderHandler) => (current = h) };
}

const ideas = (app: ReturnType<typeof studioApp>, key: string, extra: Record<string, unknown> = {}) =>
  post(app, `${BASE}/ai/ideas`, { count: 3, priorities: [], idempotency_key: key, ...extra });

const spend = (raw: DatabaseSync) => row<{ requests: number; tokens_reserved: number; tokens_used: number; in_flight: number }>(raw, 'SELECT requests, tokens_reserved, tokens_used, in_flight FROM creative_spend_day');

test('a valid answer: a succeeded job, stored ideas with ids, a usage row with counts only, the spend settled with the real usage', async () => {
  const { raw, app, stub } = await ready();
  const res = await ideas(app, 'ideas-ok-0001');
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const b = await body(res);
  assert.equal(b.ideas.length, 1);
  assert.match(b.ideas[0].id, /^cidea_/);
  assert.equal(b.ideas[0].status, 'new');
  assert.equal(b.usage.model, MODEL_A);
  assert.equal(b.usage.input_tokens, 1200);
  const job = row<{ status: string; result_json: string }>(raw, 'SELECT status, result_json FROM creative_jobs WHERE id = ?', b.job_id)!;
  assert.equal(job.status, 'succeeded');
  const usage = all(raw, 'SELECT * FROM creative_usage');
  assert.equal(usage.length, 1);
  assert.equal(usage[0]!.status, 'ok');
  assert.equal(usage[0]!.est_cost_micro_usd, null, 'no rates, no invented cost');
  // The usage row has no column that could hold a prompt, an answer or a key.
  assert.deepEqual(Object.keys(usage[0]!).sort(), ['actor_id', 'cache_read_tokens', 'created_at', 'document_id', 'error_code', 'est_cost_micro_usd', 'id', 'input_tokens', 'job_id', 'model', 'output_tokens', 'rate_source', 'status', 'task']);
  assert.deepEqual(spend(raw), { requests: 1, tokens_reserved: 0, tokens_used: 1500, in_flight: 0 });
  // What was sent: the system prompt's rules, data inside tags, and no sampling parameters.
  const sent = stub.messages()[0]!.body!;
  assert.match(String(sent.system), /Never write Sorani Kurdish/);
  assert.match(String(sent.system), /DATA/);
  const text = JSON.stringify(sent.messages);
  assert.match(text, /<evidence>/);
  assert.ok(!/temperature|top_p|top_k/.test(JSON.stringify(sent)));
  // Listed again from the ideas page.
  const list = await body(await get(app, `${BASE}/ideas`));
  assert.equal(list.ideas[0].id, b.ideas[0].id);
});

const FAILURES: Array<[string, ProviderHandler, string, number, 'released' | 'usage' | 'worst']> = [
  ['401', () => json({ type: 'error', error: { type: 'authentication_error', message: 'x' } }, 401), 'KEY_REJECTED', 502, 'released'],
  ['403', () => json({ type: 'error' }, 403), 'KEY_REJECTED', 502, 'released'],
  ['404', () => json({ type: 'error' }, 404), 'MODEL_GONE', 502, 'released'],
  ['400', () => json({ type: 'error' }, 400), 'PROVIDER_ERROR', 502, 'released'],
  ['500', () => json({ type: 'error' }, 500), 'PROVIDER_ERROR', 502, 'released'],
  ['302', () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/v1/messages' } }), 'PROVIDER_ERROR', 502, 'released'],
  ['refusal', () => message({}, { stop: 'refusal' }), 'PROVIDER_REFUSED', 502, 'usage'],
  ['max_tokens', () => message({}, { stop: 'max_tokens', text: '{"ideas": [' }), 'OUTPUT_TRUNCATED', 502, 'usage'],
  ['invalid JSON', () => message(null, { text: 'Here are some ideas!' }), 'INVALID_OUTPUT', 502, 'usage'],
  ['timeout', () => { const e = new Error('The operation timed out.'); e.name = 'TimeoutError'; throw e; }, 'PROVIDER_TIMEOUT', 504, 'worst'],
];

for (const [name, handler, code, status, accounting] of FAILURES) {
  test(`provider failure (${name}) → ${code}: a failed job, a usage row, no result, the reservation ${accounting}`, async () => {
    const { raw, app, stub } = await ready(handler);
    const res = await ideas(app, `ideas-fail-${name.replace(/\W/g, '')}-01`);
    assert.equal(res.status, status);
    const b = await body(res);
    assert.equal(b.success, false);
    assert.equal(b.code, code);
    assert.equal(b.ideas, undefined, 'no fake success');
    const job = row<{ status: string; error_code: string; result_json: string | null }>(raw, 'SELECT status, error_code, result_json FROM creative_jobs')!;
    assert.equal(job.status, 'failed');
    assert.equal(job.error_code, code);
    assert.equal(job.result_json, null);
    const usage = all(raw, 'SELECT status, error_code, input_tokens FROM creative_usage');
    assert.equal(usage.length, 1);
    assert.equal(usage[0]!.error_code, code);
    assert.equal(usage[0]!.status, code === 'PROVIDER_REFUSED' ? 'refused' : 'error');
    assert.equal(all(raw, 'SELECT * FROM creative_ideas').length, 0);
    const s = spend(raw)!;
    assert.equal(s.in_flight, 0);
    assert.equal(s.tokens_reserved, 0);
    if (accounting === 'released') assert.equal(s.tokens_used, 0, 'not processed: nothing counted');
    if (accounting === 'usage') assert.equal(s.tokens_used, 1500, 'processed: the reported usage counts');
    if (accounting === 'worst') assert.ok(s.tokens_used > 16000, 'ambiguous: the worst case counts, never zero');
    // A timeout is never re-sent (the outcome is unknown and a re-send could be billed twice).
    if (name === 'timeout' || name === '302') assert.equal(stub.messages().length, 1);
    // A failed job has nothing to cancel: a press of «إلغاء» answers with it unchanged.
    const jobId = row<{ id: string }>(raw, 'SELECT id FROM creative_jobs')!.id;
    const cancel = await post(app, `${BASE}/jobs/${jobId}/cancel`, {});
    assert.equal(cancel.status, 200);
    assert.equal((await body(cancel)).job.status, 'failed');
    assert.equal(row<{ status: string }>(raw, 'SELECT status FROM creative_jobs')!.status, 'failed');
  });
}

test('429: one retry only when retry-after is 5 s or less; 529: one backoff retry, then PROVIDER_OVERLOADED', async () => {
  let n = 0;
  const { raw, app, stub, set } = await ready((() => (++n === 1 ? json({}, 429, { 'retry-after': '2' }) : message({ ideas: [IDEA], notes: [] }))) as ProviderHandler);
  const ok = await ideas(app, 'ideas-429-retry-01');
  assert.equal(ok.status, 200);
  assert.deepEqual(stub.sleeps, [2000]);
  assert.equal(stub.messages().length, 2);

  set(() => json({}, 429, { 'retry-after': '30' }));
  const slow = await ideas(app, 'ideas-429-slow-001');
  assert.equal((await body(slow)).code, 'PROVIDER_RATE_LIMITED');
  assert.equal(slow.status, 429);
  assert.equal(stub.messages().length, 3, 'a 30 s retry-after is not waited for');

  n = 0;
  set(() => (++n === 1 ? json({}, 529) : message({ ideas: [IDEA], notes: [] })));
  assert.equal((await ideas(app, 'ideas-529-retry-01')).status, 200);
  set(() => json({}, 529));
  const over = await ideas(app, 'ideas-529-fail-001');
  assert.equal(over.status, 503);
  assert.equal((await body(over)).code, 'PROVIDER_OVERLOADED');
  assert.equal(all(raw, `SELECT * FROM creative_jobs WHERE status = 'failed'`).length, 2);
});

test('budget: the parallel limit refuses the overflow while a call is in flight, the daily cap refuses past it, and a failure releases', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { raw, app, set } = await ready(async () => {
    await gate;
    return message({ ideas: [IDEA], notes: [] });
  }, { budget: { max_parallel: 1, daily_requests: 3 } });
  const first = ideas(app, 'ideas-par-first-01');
  // Let the first request reserve and reach the provider.
  for (let i = 0; i < 50 && !(spend(raw)?.in_flight === 1); i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(spend(raw)!.in_flight, 1);
  const second = await ideas(app, 'ideas-par-second-1');
  assert.equal(second.status, 429);
  assert.equal((await body(second)).code, 'PARALLEL_LIMIT');
  release();
  assert.equal((await first).status, 200);
  assert.equal(spend(raw)!.in_flight, 0);

  set(() => json({}, 401));
  assert.equal((await body(await ideas(app, 'ideas-par-fail-001'))).code, 'KEY_REJECTED');
  assert.equal(spend(raw)!.tokens_reserved, 0, 'the failed call gave its reservation back');
  // Requests: first (ok), second never reserved, the 401 — two counted; the third is the last one allowed.
  set(() => message({ ideas: [IDEA], notes: [] }));
  assert.equal((await ideas(app, 'ideas-par-third-01')).status, 200);
  const over = await ideas(app, 'ideas-par-fourth-1');
  assert.equal(over.status, 429);
  assert.equal((await body(over)).code, 'BUDGET_EXCEEDED');
  const failed = all(raw, `SELECT error_code FROM creative_jobs WHERE status = 'failed' ORDER BY created_at`);
  assert.ok(failed.some((j) => j.error_code === 'PARALLEL_LIMIT') && failed.some((j) => j.error_code === 'BUDGET_EXCEEDED'));
});

test('the USD caps apply only with rates, and a call whose worst case would pass the daily cap is refused before it is sent', async () => {
  const { raw, app, stub } = await ready(undefined, {
    rates: { input_per_mtok_usd: 4, output_per_mtok_usd: 20, source: 'test rates', as_of: '2026-10-27' },
    budget: { daily_usd: 0.05 },
  });
  // Worst case: 16,000 output tokens × $20/M = $0.32 > $0.05.
  const res = await ideas(app, 'ideas-usd-cap-0001');
  assert.equal(res.status, 429);
  assert.equal((await body(res)).code, 'BUDGET_EXCEEDED');
  assert.equal(stub.messages().length, 0);
  assert.equal(spend(raw)!.requests, 0);
});

test('idempotency: the same key and request replays the stored result without a second call; a different request under the key is 409', async () => {
  const { raw, app, stub } = await ready();
  const a = await body(await ideas(app, 'ideas-idem-key-01'));
  const b = await body(await ideas(app, 'ideas-idem-key-01'));
  assert.equal(b.job_id, a.job_id);
  assert.deepEqual(b.ideas.map((i: { id: string }) => i.id), a.ideas.map((i: { id: string }) => i.id));
  assert.equal(stub.messages().length, 1, 'no second provider call');
  assert.equal(all(raw, 'SELECT * FROM creative_usage').length, 1);
  const c = await ideas(app, 'ideas-idem-key-01', { count: 5 });
  assert.equal(c.status, 409);
  assert.equal((await body(c)).code, 'IDEMPOTENCY_KEY_REUSED');
  // A replayed failure is the same failure, still without a call.
  restore?.();
  const failing = stubProvider((call) => (call.url.includes('/v1/models') ? modelsPage() : json({}, 401)));
  restore = failing.restore;
  await ideas(app, 'ideas-idem-fail-01');
  const again = await ideas(app, 'ideas-idem-fail-01');
  assert.equal((await body(again)).code, 'KEY_REJECTED');
  assert.equal(failing.messages().length, 1);
});

// ---------------------------------------------------------------------------
// Edits: stale versions, validation against the stored document, cancellation
// ---------------------------------------------------------------------------

async function withDesign(raw: DatabaseSync, app: ReturnType<typeof studioApp>) {
  const content = design({
    layers: [
      textLayer('headline', 'headline', 'طابعة جديدة'),
      textLayer('price', 'price', '900,000 د.ع', { y: 400, source: { kind: 'product', slot: 'main', field: 'price' } }),
      textLayer('note', 'body', 'نص ثابت', { y: 600, locked: true }),
    ],
  });
  const res = await post(app, `${BASE}/documents`, { title: 'A1 ad', content, kind: 'post', idempotency_key: 'create-doc-key-01' });
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  return (await body(res)).document as { id: string; version: number };
}

const patch = (docId: string, version: number, ops: unknown[], targets: string[], extra: Record<string, unknown> = {}) => ({
  schema_version: 1, document_id: docId, base_document_version: version, intent: 'edit', target_layer_ids: targets, operations: ops, reason: 'r', warnings: [], clarification: '', ...extra,
});

test('an AI edit against a stale version is refused STALE_VERSION before any provider call', async () => {
  const { raw, app, stub } = await ready();
  const doc = await withDesign(raw, app);
  const saved = await put(app, `${BASE}/documents/${doc.id}`, { base_version: 1, content: design({ layers: [textLayer('headline', 'headline', 'عنوان آخر')] }) });
  assert.equal((await body(saved)).document.version, 2);
  const before = stub.messages().length;
  const res = await post(app, `${BASE}/ai/edit`, { document_id: doc.id, base_version: 1, instruction: 'كبّر العنوان', scope_ids: ['headline'], annotations: [], idempotency_key: 'edit-stale-key-01' });
  assert.equal(res.status, 409);
  assert.equal((await body(res)).code, 'STALE_VERSION');
  assert.equal(stub.messages().length, before, 'the provider was never called');
  assert.equal(all(raw, 'SELECT * FROM creative_jobs').length, 0);
});

test('acceptance 10: a JSON-valid patch is still refused when it targets a layer outside the design, writes a price, claims without evidence, or touches a bound or locked layer', async () => {
  const { raw, app, set } = await ready();
  const doc = await withDesign(raw, app);
  const cases: Array<[string, unknown, string]> = [
    ['outside the document', patch(doc.id, 1, [{ op: 'set_text', layer_id: 'ghost', value: 'x' }], ['ghost']), 'target_outside_document'],
    ['outside the selection', patch(doc.id, 1, [{ op: 'set_text', layer_id: 'note', value: 'x' }], ['note']), 'target_outside_scope'],
    ['a price as text', patch(doc.id, 1, [{ op: 'set_text', layer_id: 'headline', value: 'بسعر 850,000 دينار فقط' }], ['headline']), 'text_refused'],
    ['a discount without an offer', patch(doc.id, 1, [{ op: 'set_text', layer_id: 'headline', value: 'خصم كبير على الطابعة' }], ['headline']), 'text_refused'],
    ['a link', patch(doc.id, 1, [{ op: 'set_text', layer_id: 'headline', value: 'اطلب من levonis-shop.com' }], ['headline']), 'text_refused'],
    ['the wrong base version', patch(doc.id, 7, [{ op: 'set_text', layer_id: 'headline', value: 'x' }], ['headline']), 'stale_version'],
  ];
  for (const [name, answer, reason] of cases) {
    set(() => message(answer));
    const res = await post(app, `${BASE}/ai/edit`, { document_id: doc.id, base_version: 1, instruction: 'عدّل العنوان', scope_ids: ['headline'], annotations: [], idempotency_key: `edit-${name.replace(/\W/g, '')}`.slice(0, 60).padEnd(8, '0') });
    assert.equal(res.status, 502, name);
    const b = await body(res);
    assert.equal(b.code, 'INVALID_OUTPUT', name);
    assert.equal(b.details.reason, reason, name);
  }
  // Design-wide request: writing into the bound price layer, or the locked one, is refused by the operations.
  for (const [name, op, target] of [['bound', { op: 'set_text', layer_id: 'price', value: 'نص' }, 'price'], ['locked', { op: 'set_color', layer_id: 'note', color: '#a9aca6' }, 'note']] as const) {
    set(() => message(patch(doc.id, 1, [op], [target])));
    const res = await post(app, `${BASE}/ai/edit`, { document_id: doc.id, base_version: 1, instruction: 'غيّر', scope_ids: null, annotations: [], idempotency_key: `edit-wide-${name}-01` });
    const b = await body(res);
    assert.equal(b.code, 'INVALID_OUTPUT', name);
    assert.equal(b.details.reason, 'ops_refused', name);
  }
  // Every refused patch is a failed job; nothing reached the design.
  assert.equal(all(raw, `SELECT * FROM creative_jobs WHERE status = 'succeeded'`).length, 0);
  assert.equal(row<{ version: number }>(raw, 'SELECT version FROM creative_documents')!.version, 1);
});

test('a valid patch is returned for preview; cancelling the job prevents its result from ever being applied', async () => {
  const { raw, app, set } = await ready();
  const doc = await withDesign(raw, app);
  set(() => message(patch(doc.id, 1, [{ op: 'set_text', layer_id: 'headline', value: 'طابعة A1 الجديدة' }], ['headline'])));
  const res = await post(app, `${BASE}/ai/edit`, { document_id: doc.id, base_version: 1, instruction: 'حسّن العنوان', scope_ids: ['headline'], annotations: [], idempotency_key: 'edit-valid-key-01' });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const b = await body(res);
  assert.equal(b.patch.operations.length, 1);
  assert.equal(b.patch.base_document_version, 1);

  const cancel = await post(app, `${BASE}/jobs/${b.job_id}/cancel`, {});
  assert.equal((await body(cancel)).job.status, 'cancelled');
  const applied = await post(app, `${BASE}/jobs/${b.job_id}/applied`, { document_id: doc.id, version: 2 });
  assert.equal(applied.status, 409);
  assert.equal((await body(applied)).code, 'JOB_CANCELLED');
  const content = design({ layers: [textLayer('headline', 'headline', 'طابعة A1 الجديدة')] });
  const save = await put(app, `${BASE}/documents/${doc.id}`, { base_version: 1, content, origin: 'ai', job_id: b.job_id });
  assert.equal(save.status, 409);
  assert.equal((await body(save)).code, 'JOB_CANCELLED');
  assert.equal(row<{ version: number }>(raw, 'SELECT version FROM creative_documents')!.version, 1, 'the cancelled result never reached the design');
});

test('a save that applies a job marks it applied in the same batch; applying twice is refused', async () => {
  const { raw, app, set } = await ready();
  const doc = await withDesign(raw, app);
  set(() => message(patch(doc.id, 1, [{ op: 'set_text', layer_id: 'headline', value: 'عنوان أوضح' }], ['headline'])));
  const b = await body(await post(app, `${BASE}/ai/edit`, { document_id: doc.id, base_version: 1, instruction: 'أوضح', scope_ids: ['headline'], annotations: [], idempotency_key: 'edit-apply-key-01' }));
  const content = design({ layers: [textLayer('headline', 'headline', 'عنوان أوضح'), textLayer('note', 'body', 'نص ثابت', { y: 600, locked: true })] });
  const save = await put(app, `${BASE}/documents/${doc.id}`, { base_version: 1, content, origin: 'ai', job_id: b.job_id, change_summary: 'AI headline' });
  assert.equal(save.status, 200);
  const job = row<{ applied_at: string | null; applied_version: number }>(raw, 'SELECT applied_at, applied_version FROM creative_jobs WHERE id = ?', b.job_id)!;
  assert.ok(job.applied_at);
  assert.equal(job.applied_version, 2);
  // The same report again (the editor's explicit call) is a no-op; another version is refused.
  assert.equal((await post(app, `${BASE}/jobs/${b.job_id}/applied`, { document_id: doc.id, version: 2 })).status, 200);
  const twice = await post(app, `${BASE}/jobs/${b.job_id}/applied`, { document_id: doc.id, version: 3 });
  assert.equal((await body(twice)).code, 'JOB_ALREADY_APPLIED');
  assert.equal(row<{ origin: string; job_id: string }>(raw, 'SELECT origin, job_id FROM creative_document_versions WHERE version = 2')!.job_id, b.job_id);
});

test('a job cancelled while the provider works: its late result is never stored as usable', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { raw, app } = await ready(async () => {
    await gate;
    return message({ ideas: [IDEA], notes: [] });
  });
  const pending = ideas(app, 'ideas-cancel-late-1');
  let job: { id: string } | undefined;
  for (let i = 0; i < 50 && !job; i++) {
    job = row<{ id: string }>(raw, `SELECT id FROM creative_jobs WHERE status = 'running'`) ?? undefined;
    if (!job) await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(job, 'the job is running');
  await post(app, `${BASE}/jobs/${job!.id}/cancel`, {});
  release();
  const res = await pending;
  assert.equal(res.status, 409);
  assert.equal((await body(res)).code, 'JOB_CANCELLED');
  assert.equal(row<{ status: string; result_json: string | null }>(raw, 'SELECT status, result_json FROM creative_jobs')!.status, 'cancelled');
  assert.equal(all(raw, 'SELECT * FROM creative_ideas').length, 0);
  assert.equal(row<{ status: string }>(raw, 'SELECT status FROM creative_usage')!.status, 'cancelled', 'the billed call is on the record');
});

test('visual review: off by default (VISION_REVIEW_DISABLED); when on, a model "blocker" is only advice', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000100000001008060000001ff3ff61', 'hex');
  const { raw, app, set } = await ready();
  const doc = await withDesign(raw, app);
  const req = (key: string) => post(app, `${BASE}/ai/review`, { document_id: doc.id, version: 1, image_base64: png.toString('base64'), idempotency_key: key });
  const off = await req('review-off-key-01');
  assert.equal(off.status, 409);
  assert.equal((await body(off)).code, 'VISION_REVIEW_DISABLED');
  await put(app, `${BASE}/provider/settings`, { vision_review: true });
  set(() => message({ notes: [{ layer_id: 'headline', category: 'readability', severity: 'blocker', issue: 'العنوان صغير', suggestion: 'كبّره' }], summary: 'جيد' }));
  const on = await body(await req('review-on-key-01'));
  assert.equal(on.notes[0].severity, 'review', 'a model opinion never blocks on its own');
  assert.equal(on.notes[0].layer_id, 'headline');
});

test('compose: a manual snapshot\'s offer is no evidence — offer wording is refused, the clean proposal kept', async () => {
  const { app, stub, set } = await ready();
  const imported = await body(await post(app, `${BASE}/snapshots/import`, {
    source: 'manual',
    data: { product_id: 'p_manual', name: { ar: 'طابعة', en: 'Printer', ckb: 'چاپکەر' }, price: { status: 'priced', amount_iqd: 800000, regular_iqd: 900000, offer: { starts_at: null, ends_at: null } }, availability: 'available', cost_iqd: 1, stock: 4, supplier: 'x' },
  }));
  assert.equal(imported.source, 'manual');
  assert.ok(!('cost_iqd' in imported.data) && !('stock' in imported.data) && !('supplier' in imported.data), 'the import is an allow-list');
  set(() => message({
    proposals: [
      { variant: 'product_first', reason: 'r', headline: 'طابعة دقيقة لمشاريعك', subhead: '', features: ['سهلة'], cta: 'اطلبها', caption: '', alt_text: '' },
      { variant: 'feature_first', reason: 'r', headline: 'خصم لفترة محدودة', subhead: '', features: [], cta: 'اطلبها', caption: '', alt_text: '' },
    ],
    warnings: [],
    missing: [],
  }));
  const res = await post(app, `${BASE}/ai/compose`, {
    snapshot_id: imported.id, claim_id: null, objective: 'sell', priority: 'product', density: 'brief', template: 'product_hero', family: null,
    variants: ['product_first', 'feature_first'], locale: 'ar', brief: '', idempotency_key: 'compose-manual-01',
  });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const b = await body(res);
  assert.deepEqual(b.proposals.map((p: { variant: string }) => p.variant), ['product_first']);
  assert.equal(b.rejected, 1);
  // The model saw the price's KIND, never its amount.
  const sent = JSON.stringify(stub.messages().at(-1)!.body);
  assert.ok(!sent.includes('800000') && !sent.includes('900000'), 'no amount reaches the model');
  assert.match(sent, /live_public_offer/);
});
