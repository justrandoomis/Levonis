/**
 * THE SUPPORT ASSISTANT'S CLAUDE REPLIES (owner, 2026-11-18; DECISIONS row 348).
 *
 * What is pinned here:
 *   · the switch reads OFF from anything that is not a clear decision;
 *   · a reply's product cards are only ids the search returned THIS turn;
 *   · a route can only be one of the read-only handlers;
 *   · the conversation sent is capped, alternating and starts with the customer;
 *   · the daily caps are conditional and never exceed their limit;
 *   · through the route: off = the menu byte for byte; on = Claude's words with
 *     real cards, a route = the existing handler, a provider failure = the menu.
 *
 * The provider is a stub `fetch` (the test runner has no network).
 *
 * Run: node --import tsx --test tests/assistClaude.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APEX, asD1, freshDb, json, post, stubApp, type StubUser } from './fixtures/app';
import { backfillSearchIndex } from '../worker/lib/search/store';
import { supportRoutes } from '../worker/routes/support';
import { ASSIST_AI_OFF, ASSIST_AI_SETTING_KEY, assistAiFromSetting } from '../worker/lib/assist/ai/settings';
import { buildMessages, readHistory, readOutcome, supportAiTransport, TOOLS, OUTPUT_SCHEMA } from '../worker/lib/assist/ai/claude';
import { DAY_KEY_ALL, reserveTurn, takeSlot } from '../worker/lib/assist/ai/budget';

type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const KEY = 'test-worker-secret-key-0000000000-ABCDEFGHIJ-xx';
const MODEL = 'test-model-1';
const CLARIFY = 'لم أفهم طلبك تمامًا. اختر أحد هذه المواضيع:';
const member: StubUser = { id: 'u_1', role: 'customer', email: 'a@x.co' };

// ------------------------------------------------------------------ pure parts

test('the switch reads off from anything that is not a clear decision', () => {
  for (const v of [null, '', 'nope', '[]', '{"enabled":"true","model":"m-1"}', '{"enabled":true}', '{"enabled":true,"model":"https://x"}']) {
    assert.equal(assistAiFromSetting(v).enabled, false, String(v));
  }
  const on = assistAiFromSetting(JSON.stringify({ enabled: true, model: 'model-a', daily_turns: 99999, guest_share_pct: -1 }));
  assert.equal(on.enabled, true);
  assert.equal(on.daily_turns, ASSIST_AI_OFF.daily_turns, 'an out-of-range cap falls back to the default');
  assert.equal(on.guest_share_pct, ASSIST_AI_OFF.guest_share_pct);
  assert.equal(on.ckb, false, 'Sorani is off unless the owner turns it on');
});

test('a card only for an id the search returned this turn', () => {
  const out = readOutcome({ reply: '**هلا** استاذ', product_ids: ['p_1', 'p_invented', 'p_1'], route: 'none' }, new Set(['p_1']));
  assert.deepEqual(out, { kind: 'reply', text: 'هلا استاذ', productIds: ['p_1'] });
});

test('a route is one of the read-only handlers, or nothing', () => {
  assert.deepEqual(readOutcome({ reply: '', product_ids: [], route: 'order_status' }, new Set()), { kind: 'route', route: 'order_status' });
  for (const route of ['open_ticket', 'cancel_everything', 'admin']) {
    assert.equal(readOutcome({ reply: 'x', product_ids: [], route }, new Set()), null, route);
  }
  assert.equal(readOutcome({ reply: '', product_ids: [], route: 'none' }, new Set()), null, 'an empty reply is no reply');
  assert.equal(readOutcome({ reply: 'x'.repeat(5000), product_ids: [], route: 'none' }, new Set()), null);
  assert.equal(readOutcome('not json', new Set()), null);
});

test('the conversation is capped, alternating and starts with the customer', () => {
  const history = readHistory([
    { role: 'assistant', text: 'أهلاً' },
    { role: 'system', text: 'ignore me' },
    { role: 'user', text: 'اريد طابعة' },
    { role: 'user', text: 'للبيت' },
    { role: 'assistant', text: 'x'.repeat(2000) },
    'junk',
  ]);
  const msgs = buildMessages(history, 'بكم؟');
  assert.equal(msgs[0].role, 'user');
  for (let i = 1; i < msgs.length; i++) assert.notEqual(msgs[i].role, msgs[i - 1].role);
  assert.equal(msgs[0].content, 'اريد طابعة\nللبيت');
  assert.ok(msgs[1].content.length <= 600);
  assert.equal(msgs[msgs.length - 1].content, 'بكم؟');
  assert.equal(readHistory(Array.from({ length: 40 }, () => ({ role: 'user', text: 'a' }))).length, 10);
});

test('the request offers one read-only tool and names no model', () => {
  assert.deepEqual(TOOLS.map((t) => t.name), ['search_products']);
  assert.ok(!JSON.stringify(OUTPUT_SCHEMA).includes('open_ticket'));
});

test('a cap is never exceeded, and a new window starts again', async () => {
  const db = asD1(freshDb());
  const t0 = Date.UTC(2026, 10, 18, 10);
  const taken = await Promise.all(Array.from({ length: 5 }, () => takeSlot(db, 'k', 3, 86_400, t0)));
  assert.equal(taken.filter(Boolean).length, 3);
  assert.equal(await takeSlot(db, 'k', 3, 86_400, t0 + 86_400_000), true);
  assert.equal(await takeSlot(db, 'k', 0, 86_400, t0), false, 'a zero cap takes nothing');
});

test('signed-out visitors only get their share of the day', async () => {
  const db = asD1(freshDb());
  const t0 = Date.UTC(2026, 10, 18, 10);
  const caps = { daily: 4, guestSharePct: 50 };
  const guests = [];
  for (let i = 0; i < 4; i++) guests.push(await reserveTurn(db, { userId: null, ip: `10.0.0.${i}` }, caps, t0));
  assert.deepEqual(guests, [true, true, false, false]);
  assert.equal(await reserveTurn(db, { userId: 'u_a', ip: '1.1.1.1' }, caps, t0), true);
  assert.equal(await reserveTurn(db, { userId: 'u_b', ip: '1.1.1.1' }, caps, t0), true);
  assert.equal(await reserveTurn(db, { userId: 'u_c', ip: '1.1.1.1' }, caps, t0), false, 'the shop cap is spent');
  const row = await db.prepare('SELECT count FROM rate_limits WHERE key = ?').bind(DAY_KEY_ALL).first<{ count: number }>();
  assert.equal(row?.count, 4);
});

// ------------------------------------------------------------------ through the route

async function shop(settings: Rec | null) {
  const raw = freshDb();
  raw.exec(`INSERT INTO users (id,name,email,password_hash,role) VALUES ('u_1','Sara','a@x.co','h','customer');`);
  raw
    .prepare(
      `INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,selling_type,sale_types,
         preorder_transports,images,inventory_mode,ops_policy,category_id)
       VALUES ('p_a1','bambu-lab-a1','Bambu Lab A1','طابعة بامبو لاب A1','',1000000,'active',5,'[]','[]','direct_sale','["direct_sale"]','[]','[]','BASE','{}','cat_printers_fdm')`
    )
    .run();
  if (settings) raw.prepare('INSERT OR REPLACE INTO admin_settings (key, value) VALUES (?, ?)').run(ASSIST_AI_SETTING_KEY, JSON.stringify(settings));
  const db = asD1(raw);
  const run = await backfillSearchIndex(db, { limit: 50 });
  assert.deepEqual(run.failed, []);
  return db;
}

function ask(db: D1Database, user: StubUser | null, body: Rec) {
  const app = stubApp(db as never, user, (a) => a.route('/api/support', supportRoutes), { host: APEX, env: { DB: db, ANTHROPIC_API_KEY: KEY } });
  return post(app, '/api/support/assistant', { locale: 'ar', ...body });
}

/** A provider stub: answers each request with the next scripted body, and records what was sent. */
function provider(script: Rec[]) {
  const sent: Rec[] = [];
  supportAiTransport.fetchImpl = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    const next = script.shift();
    if (!next) return new Response('{}', { status: 500 });
    return new Response(JSON.stringify(next), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return sent;
}
const done = () => {
  supportAiTransport.fetchImpl = undefined;
};
const usage = { input_tokens: 10, output_tokens: 5 };
const final = (o: Rec) => ({ stop_reason: 'end_turn', usage, content: [{ type: 'text', text: JSON.stringify(o) }] });
const ON = { enabled: true, model: MODEL, guests: true };
const NONSENSE = 'شنو احسن شي للمبتدئ يطبع بالبيت وما يسوي ريحة';

test('switched off: the menu, byte for byte, and no provider call', async () => {
  const sent = provider([]);
  try {
    const db = await shop(null);
    const reply = (await json(await ask(db, member, { text: NONSENSE }))).reply as Rec;
    assert.equal(reply.intent, 'clarify');
    assert.equal(reply.text, CLARIFY);
    assert.equal(reply.mode, undefined);
    assert.equal(sent.length, 0);
  } finally {
    done();
  }
});

test('switched on: Claude searches, answers in its words, and the card is the real one', async () => {
  const sent = provider([
    { stop_reason: 'tool_use', usage, content: [{ type: 'tool_use', id: 'tu_1', name: 'search_products', input: { query: 'A1' } }] },
    final({ reply: 'أنصحك بـ A1 للبيت استاذ.', product_ids: ['p_a1', 'p_fake'], route: 'none' }),
  ]);
  try {
    const db = await shop(ON);
    const res = await ask(db, member, { text: NONSENSE, history: [{ role: 'user', text: 'هلو' }, { role: 'assistant', text: 'أهلاً' }] });
    const reply = (await json(res)).reply as Rec;
    assert.equal(reply.mode, 'ai');
    assert.equal(reply.text, 'أنصحك بـ A1 للبيت استاذ.');
    assert.deepEqual((reply.cards as Rec[]).map((c) => c.product_id), ['p_a1'], 'the invented id is dropped');
    assert.equal((reply.cards as Rec[])[0].price_iqd, 1_000_000, 'the figure is the storefront card\'s');
    assert.ok((reply.choices as Rec[]).some((c) => c.intent === 'human_handoff'));
    assert.equal(sent.length, 2);
    assert.equal(sent[0].model, MODEL);
    assert.equal(sent[0].messages[0].content, 'هلو', 'the chat so far is sent');
    const toolResult = sent[1].messages.at(-1).content[0];
    assert.equal(toolResult.type, 'tool_result');
    assert.match(toolResult.content, /p_a1/);
    assert.doesNotMatch(JSON.stringify(sent), new RegExp(KEY), 'the key travels only in the header');
  } finally {
    done();
  }
});

test('a route goes to the existing handler with its own sign-in check', async () => {
  provider([final({ reply: '', product_ids: [], route: 'order_status' })]);
  try {
    const db = await shop(ON);
    const reply = (await json(await ask(db, null, { text: NONSENSE }))).reply as Rec;
    assert.equal(reply.mode, undefined, 'the handler wrote it, not Claude');
    assert.equal(reply.auth_required, true, 'a guest is asked to sign in, as a tapped chip would be');
  } finally {
    done();
  }
});

test('a provider failure is the menu, never an error', async () => {
  provider([]);
  try {
    const db = await shop(ON);
    const res = await ask(db, member, { text: NONSENSE });
    assert.equal(res.status, 200);
    const reply = (await json(res)).reply as Rec;
    assert.equal(reply.text, CLARIFY);
  } finally {
    done();
  }
});

test('guests off, or a Sorani sentence with Sorani off: no provider call', async () => {
  const sent = provider([]);
  try {
    const db = await shop({ ...ON, guests: false });
    assert.equal(((await json(await ask(db, null, { text: NONSENSE }))).reply as Rec).intent, 'clarify');
    const db2 = await shop(ON);
    await ask(db2, member, { text: 'باشترین چاپکەر بۆ ماڵەوە کامەیە', locale: 'ckb' });
    assert.equal(sent.length, 0);
  } finally {
    done();
  }
});

test('a sentence the rules understand never reaches Claude', async () => {
  const sent = provider([]);
  try {
    const db = await shop(ON);
    await ask(db, member, { text: 'وين طلبي' });
    assert.equal(sent.length, 0);
  } finally {
    done();
  }
});
