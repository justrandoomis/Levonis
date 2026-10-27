/**
 * «محادثة» on Home (POST /ai/chat): the free conversation goes through the
 * real router, the same provider adapter, budget and jobs. A reply is
 * `{reply, suggested_ideas[]}`; a price or a link in it refuses the whole
 * answer (INVALID_OUTPUT, nothing returned); an idea naming a product the
 * request did not list is dropped. Its job is stored as an `ideas` job (0216's
 * CHECK), so a design made from one of its ideas links it. No model chosen →
 * MODEL_NOT_SELECTED, and the studio still works by hand.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { OWNER, asD1, json as body, post, put } from './fixtures/app';
import { BASE, MODEL_A, SECRET_KEY, message, modelsPage, stubProvider, studioApp, studioDb } from './fixtures/creativeStudio';

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

async function world(answer: () => unknown, model = true) {
  const raw = await studioDb(true);
  const app = studioApp(raw, OWNER, { ANTHROPIC_API_KEY: SECRET_KEY });
  const stub = stubProvider((call) => (call.url.includes('/v1/models') ? modelsPage() : message(answer())));
  restore = stub.restore;
  if (model) assert.equal((await put(app, `${BASE}/provider/settings`, { model: MODEL_A })).status, 200);
  return { raw, app, stub };
}

const turn = (text: string, key = 'chat-key-000001') => ({ messages: [{ role: 'user', text }], idempotency_key: key });

test('a chat turn answers with a checked reply and ideas; the job is an ideas job a design can link', async () => {
  const { raw, app, stub } = await world(() => ({
    reply: 'فكرة: منشور يبرز دقة الطباعة على الخلفية الذهبية.',
    suggested_ideas: [
      { objective: 'sell', product_ref: 'p_print', headline: 'دقة في كل طبقة', subhead: '', note: 'القالب الذهبي' },
      { objective: 'sell', product_ref: 'p_nowhere', headline: 'منتج مخترع', subhead: '', note: '' },
    ],
  }));
  const res = await post(app, `${BASE}/ai/chat`, turn('أريد تصميماً لطابعة A1'));
  assert.equal(res.status, 200);
  const out = (await body(res)) as Record<string, unknown>;
  assert.match(String(out.reply), /دقة الطباعة/);
  assert.deepEqual((out.suggested_ideas as Array<{ product_ref: string }>).map((i) => i.product_ref), ['p_print']);
  assert.equal(out.dropped, 1);
  const sent = JSON.stringify(stub.messages()[0].body);
  assert.ok(sent.includes('أريد تصميماً لطابعة A1') && sent.includes('suggested_ideas'));
  assert.ok(!sent.includes('900000') && !sent.includes('777777'), 'no price or cost reaches the model');
  const job = raw.prepare('SELECT task, status FROM creative_jobs WHERE id = ?').get(String(out.job_id)) as { task: string; status: string };
  assert.deepEqual({ ...job }, { task: 'ideas', status: 'succeeded' });
  const usage = raw.prepare('SELECT task FROM creative_usage WHERE job_id = ?').get(String(out.job_id)) as { task: string };
  assert.equal(usage.task, 'ideas');
  // History is bounded and must end with the owner's turn.
  const bad = await post(app, `${BASE}/ai/chat`, { messages: [{ role: 'assistant', text: 'مرحبا' }], idempotency_key: 'chat-key-000002' });
  assert.equal(bad.status, 400);
  void asD1;
});

test('a reply with a price or a link is refused whole; without a model the chat says so', async () => {
  const { app } = await world(() => ({ reply: 'السعر 900,000 د.ع فقط على https://x.example', suggested_ideas: [] }));
  const res = await post(app, `${BASE}/ai/chat`, turn('كم السعر؟'));
  assert.equal(res.status, 502);
  assert.equal(((await body(res)) as { code: string }).code, 'INVALID_OUTPUT');
  restore?.();
  const none = await world(() => ({ reply: 'x', suggested_ideas: [] }), false);
  const r2 = await post(none.app, `${BASE}/ai/chat`, turn('مرحبا', 'chat-key-000003'));
  assert.equal(r2.status, 409);
  assert.equal(((await body(r2)) as { code: string }).code, 'MODEL_NOT_SELECTED');
});
