/**
 * THE CREATIVE STUDIO'S SPEND UNDER FAILURE — what a dead or disconnected AI
 * request leaves behind, and what a picture costs (spec §29; acceptance 16, 18;
 * worker/lib/creative/ai.ts, budget.ts, anthropic.ts).
 *
 *   - a reservation left by a Worker that died mid-call is settled at its
 *     reserved WORST CASE with an INTERRUPTED usage row — never released as
 *     free — and two sweeps of the same job settle it once;
 *   - the call and its settle are handed to the request's `waitUntil`;
 *   - a review picture is counted by its pixels, not by its base64 length;
 *   - the long tasks' deadlines sit just under the client's own.
 *
 * The provider is a stub; model ids are fake.
 *
 * Run: node --import tsx --test tests/creativeStudioAiSpend.test.ts
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { OWNER, all, asD1, json as body, pending, post, put, row } from './fixtures/app';
import { BASE, MODEL_A, SECRET_KEY, design, message, modelsPage, stubProvider, studioApp, studioDb, textLayer, type ProviderHandler } from './fixtures/creativeStudio';
import { releaseStale, settleStale } from '../worker/lib/creative/ai';
import { TIMEOUTS_MS } from '../worker/lib/creative/anthropic';
import type { JobRow } from '../worker/lib/creative/jobs';
import { baghdadDay } from '../worker/lib/baghdadTime';
import { AI_TIMEOUT_MS } from '../src/components/creativeStudio/client';

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

async function ready(handler?: ProviderHandler, settings: Record<string, unknown> = {}) {
  const raw = await studioDb();
  const app = studioApp(raw, OWNER, { ANTHROPIC_API_KEY: SECRET_KEY });
  const answer: ProviderHandler = handler ?? (() => message({ ideas: [IDEA], notes: [] }));
  const stub = stubProvider((call) => (call.url.includes('/v1/models') ? modelsPage() : answer(call)));
  restore = stub.restore;
  const res = await put(app, `${BASE}/provider/settings`, { model: MODEL_A, ...settings });
  assert.equal(res.status, 200);
  return { raw, app, stub };
}

const spend = (raw: DatabaseSync) =>
  row<{ requests: number; tokens_reserved: number; tokens_used: number; in_flight: number }>(raw, 'SELECT requests, tokens_reserved, tokens_used, in_flight FROM creative_spend_day');

/** A job a dead Worker left 'running' with its reservation held on today's spend row. */
function strandedJob(raw: DatabaseSync, id: string, tokens: number, minutesAgo = 10) {
  const day = baghdadDay(Date.now());
  const started = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  raw.exec(`INSERT OR IGNORE INTO creative_spend_day (day) VALUES ('${day}')`);
  raw.prepare(`UPDATE creative_spend_day SET requests = requests + 1, tokens_reserved = tokens_reserved + ?, in_flight = in_flight + 1 WHERE day = ?`).run(tokens, day);
  raw
    .prepare(
      `INSERT INTO creative_jobs (id, task, status, actor_id, idempotency_key, request_hash, document_id, base_version, target_ids_json, created_at, started_at, reserved_day, reserved_tokens, reserved_usd_micro)
       VALUES (?, 'ideas', 'running', 'usr_owner', ?, 'h', NULL, NULL, '[]', ?, ?, ?, ?, 0)`
    )
    .run(id, `stranded-${id}`, started, started, day, tokens);
}

test('worker-2: a reservation stranded by a dead Worker is settled at its worst case, with an INTERRUPTED usage row — never released as free', async () => {
  const { raw, app } = await ready();
  strandedJob(raw, 'cjob_dead', 25_000);
  const res = await post(app, `${BASE}/ai/ideas`, { count: 3, priorities: [], idempotency_key: 'ideas-after-crash-01' });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const dead = row<{ status: string; error_code: string }>(raw, `SELECT status, error_code FROM creative_jobs WHERE id = 'cjob_dead'`)!;
  assert.deepEqual({ ...dead }, { status: 'failed', error_code: 'INTERRUPTED' });
  const usage = all<{ status: string; error_code: string | null; task: string; actor_id: string; input_tokens: number | null }>(raw, `SELECT status, error_code, task, actor_id, input_tokens FROM creative_usage WHERE job_id = 'cjob_dead'`);
  assert.equal(usage.length, 1, 'the interrupted call is on the ledger');
  assert.deepEqual({ ...usage[0]! }, { status: 'error', error_code: 'INTERRUPTED', task: 'ideas', actor_id: 'usr_owner', input_tokens: null });
  // The stranded 25,000 count as spent (the call may have been billed); the new call settles with its real 1,500.
  assert.deepEqual({ ...spend(raw)! }, { requests: 2, tokens_reserved: 0, tokens_used: 25_000 + 1_500, in_flight: 0 });
});

test('worker-2: two sweeps of the same stale job settle it once and leave a live call\'s reservation alone', async () => {
  const raw = await studioDb();
  const db = asD1(raw);
  strandedJob(raw, 'cjob_dead', 25_000);
  strandedJob(raw, 'cjob_live', 30_000, 0); // really at the provider right now
  const job = row<JobRow>(raw, `SELECT * FROM creative_jobs WHERE id = 'cjob_dead'`)!;
  // Two AI requests that both read the job as running before either settled it (D1 runs their batches one after the other).
  await settleStale(db, job);
  await settleStale(db, job);
  assert.deepEqual({ ...spend(raw)! }, { requests: 2, tokens_reserved: 30_000, tokens_used: 25_000, in_flight: 1 }, 'the live reservation still counts');
  assert.equal(all(raw, `SELECT * FROM creative_usage WHERE job_id = 'cjob_dead'`).length, 1);
  // The sweep itself only picks jobs older than five minutes: the live call is untouched.
  await releaseStale(db);
  assert.equal(row<{ status: string }>(raw, `SELECT status FROM creative_jobs WHERE id = 'cjob_live'`)!.status, 'running');
  assert.equal(spend(raw)!.in_flight, 1);
});

test('worker-2: the provider call and its settle are handed to the request\'s waitUntil, so a client disconnect cannot strand the reservation', async () => {
  const { raw, app } = await ready();
  const before = pending.length;
  const res = await post(app, `${BASE}/ai/ideas`, { count: 3, priorities: [], idempotency_key: 'ideas-keepalive-01' });
  assert.equal(res.status, 200);
  assert.ok(pending.length > before, 'the AI work was kept alive');
  await Promise.all(pending.slice(before));
  assert.deepEqual({ ...spend(raw)! }, { requests: 1, tokens_reserved: 0, tokens_used: 1_500, in_flight: 0 });
});

/** A header-only PNG of `w`×`h` padded with one IDAT of `bytes` zeros: large on the wire, cheap in pixels. */
function bigPng(w: number, h: number, bytes: number) {
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const ihdr = Buffer.concat([u32(w), u32(h), Buffer.from([8, 6, 0, 0, 0])]);
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    u32(13), Buffer.from('IHDR'), ihdr, u32(0),
    u32(bytes), Buffer.from('IDAT'), Buffer.alloc(bytes), u32(0),
    u32(0), Buffer.from('IEND'), u32(0),
  ]);
}

test('worker-3: a large review PNG on a fresh default day is reserved by its pixels, not its base64 — not BUDGET_EXCEEDED', async () => {
  const { raw, app, stub } = await ready(() => message({ notes: [], summary: 'جيد' }), { vision_review: true });
  const doc = await body(await post(app, `${BASE}/documents`, { title: 'A1', content: design({ layers: [textLayer('headline', 'headline', 'طابعة جديدة')] }), kind: 'post', idempotency_key: 'create-doc-review-1' }));
  const png = bigPng(768, 768, 1_400_000); // ≈1.87 MB of base64: ≈930k "text tokens" by the old estimate, over the 600k default day
  const res = await post(app, `${BASE}/ai/review`, { document_id: doc.document.id, version: 1, image_base64: png.toString('base64'), idempotency_key: 'review-big-png-01' });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.equal(stub.messages().length, 1);
  // The image itself still reaches the provider whole.
  const sent = stub.messages()[0]!.body as { messages: Array<{ content: Array<{ type: string; source?: { data: string } }> }> };
  assert.equal(sent.messages[0]!.content[0]!.source!.data.length, png.toString('base64').length);
  // The reservation was the text, the 8,000-token answer budget and 787 tokens for 768×768 pixels.
  const reserved = row<{ reserved_tokens: number }>(raw, `SELECT reserved_tokens FROM creative_jobs WHERE task = 'review'`)!.reserved_tokens;
  assert.ok(reserved < 20_000, `reserved ${reserved}`);
  assert.ok(reserved >= 8_000 + 787, `reserved ${reserved}`);
});

test('worker-8: the long tasks get about 110 s, still under the client\'s own deadline; the edit keeps its 45 s', () => {
  for (const task of ['ideas', 'compose', 'carousel', 'review'] as const) {
    assert.equal(TIMEOUTS_MS[task], 110_000, task);
    assert.ok(TIMEOUTS_MS[task] < AI_TIMEOUT_MS, `${task} answers before the client gives up`);
  }
  assert.equal(TIMEOUTS_MS.edit, 45_000);
});
