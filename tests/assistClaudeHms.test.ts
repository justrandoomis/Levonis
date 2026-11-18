/**
 * PRINTER ERROR CODES AND PHOTOS, READ BY CLAUDE (owner, 2026-11-18: «understand
 * all hms from text or photo»; DECISIONS row 349).
 *
 * Pinned here:
 *   · what counts as an error code (and what does not: a model name, a nozzle size, a phone number);
 *   · a typed code goes to Claude BEFORE the rules, with the makers' wikis as
 *     the only sites its server-side search and fetch may reach;
 *   · with the wiki lookup off, a code is the rules' triage exactly as before;
 *   · a paused server-side lookup is continued, not dropped;
 *   · a photo is read only when it is this signed-in customer's own upload,
 *     and a refused photo answers `reply: null` (the page's own acknowledgement).
 *
 * Run: node --import tsx --test tests/assistClaudeHms.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APEX, asD1, freshDb, json, memoryBucket, post, stubApp, type StubUser } from './fixtures/app';
import { supportRoutes } from '../worker/routes/support';
import { ASSIST_AI_SETTING_KEY } from '../worker/lib/assist/ai/settings';
import { ERROR_CODE_MENTION, supportAiTransport, WIKI_DOMAINS } from '../worker/lib/assist/ai/claude';
import { ownedPhotoKey } from '../worker/lib/assist/ai/photo';

type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const KEY = 'test-worker-secret-key-0000000000-ABCDEFGHIJ-xx';
const member: StubUser = { id: 'u_1', role: 'customer', email: 'a@x.co' };
const ON = { enabled: true, model: 'test-model-1', guests: true };

test('what counts as a printer error code', () => {
  for (const t of ['HMS 0300-0D00-0001-0003', 'طلعلي 0300_0D00_0001_0003', '03000D0000010003', 'Error 2000', 'E0011 on my K1', 'طلع خطأ 2000', 'hms']) {
    assert.ok(ERROR_CODE_MENTION.test(t), t);
  }
  for (const t of ['A1 mini', 'نوزل 0.4', 'اتصل 07838455220', 'بكم P1S', 'اريد طابعة', '2025']) {
    assert.ok(!ERROR_CODE_MENTION.test(t), t);
  }
});

test('a photo key is only ever the same customer\'s own still image', () => {
  assert.equal(ownedPhotoKey('assist/u_1/attachments/a.jpg', 'u_1'), 'assist/u_1/attachments/a.jpg');
  assert.equal(ownedPhotoKey('assist/u_2/attachments/a.jpg', 'u_1'), null, 'another customer');
  assert.equal(ownedPhotoKey('assist/u_1/attachments/a.jpg', null), null, 'a guest');
  assert.equal(ownedPhotoKey('assist/u_1/video/a.mp4', 'u_1'), null, 'not a still image');
  assert.equal(ownedPhotoKey('assist/u_1/../u_2/attachments/a.jpg', 'u_1'), null);
});

async function shop(settings: Rec) {
  const raw = freshDb();
  raw.exec(`INSERT INTO users (id,name,email,password_hash,role) VALUES ('u_1','Sara','a@x.co','h','customer');`);
  raw.prepare('INSERT INTO admin_settings (key, value) VALUES (?, ?)').run(ASSIST_AI_SETTING_KEY, JSON.stringify(settings));
  return asD1(raw);
}

function ask(db: D1Database, user: StubUser | null, body: Rec, extraEnv: Rec = {}) {
  const app = stubApp(db as never, user, (a) => a.route('/api/support', supportRoutes), {
    host: APEX,
    env: { DB: db, ANTHROPIC_API_KEY: KEY, ...extraEnv },
  });
  return post(app, '/api/support/assistant', { locale: 'ar', ...body });
}

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
const EXPLAINED = 'الرسالة معناها إن الصفيحة مو مركبة صح.\n1. نظف ظهر الصفيحة.\nالمصدر: wiki.bambulab.com';

test('a typed HMS code goes to Claude first, and it may only read the makers\' wikis', async () => {
  const sent = provider([
    // A long lookup paused once: its content is handed back and continued.
    { stop_reason: 'pause_turn', usage, content: [{ type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'HMS 0300-0D00-0001-0003' } }] },
    final({ reply: EXPLAINED, product_ids: [], route: 'none' }),
  ]);
  try {
    const db = await shop(ON);
    const reply = (await json(await ask(db, member, { text: 'طابعتي A1 طلعت HMS 0300-0D00-0001-0003' }))).reply as Rec;
    assert.equal(reply.mode, 'ai');
    assert.equal(reply.text, EXPLAINED);
    assert.equal(sent.length, 2, 'the paused turn was continued');
    for (const body of sent) {
      const server = (body.tools as Rec[]).filter((t) => typeof t.type === 'string');
      assert.deepEqual(server.map((t) => t.name).sort(), ['web_fetch', 'web_search']);
      for (const t of server) assert.deepEqual(t.allowed_domains, [...WIKI_DOMAINS]);
    }
    assert.equal(sent[1].messages.at(-1).role, 'assistant', 'the paused content goes back unchanged');
    assert.match(sent[0].system[0].text, /wiki\.bambulab\.com/);
  } finally {
    done();
  }
});

test('with the wiki lookup off, a code is the rules\' triage as before', async () => {
  const sent = provider([]);
  try {
    const db = await shop({ ...ON, wiki: false });
    const reply = (await json(await ask(db, member, { text: 'طلعلي HMS 0300-0D00-0001-0003' }))).reply as Rec;
    assert.equal(reply.mode, undefined);
    assert.equal(reply.intent, 'printer_problem');
    assert.equal(sent.length, 0);
  } finally {
    done();
  }
});

test('a provider failure on a code falls back to the rules\' triage', async () => {
  provider([]);
  try {
    const db = await shop(ON);
    const reply = (await json(await ask(db, member, { text: 'طلعلي HMS 0300-0D00-0001-0003' }))).reply as Rec;
    assert.equal(reply.mode, undefined);
    assert.equal(reply.intent, 'printer_problem');
  } finally {
    done();
  }
});

// The smallest byte run the sniffer takes for a JPEG.
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);

test('an attached photo of the customer\'s own is read and answered', async () => {
  const sent = provider([final({ reply: 'أقرأ بالصورة الرمز 0300-0D00-0001-0003 …', product_ids: [], route: 'none' })]);
  try {
    const db = await shop(ON);
    const bucket = memoryBucket();
    await bucket.put('assist/u_1/attachments/p.jpg', JPEG, { httpMetadata: { contentType: 'image/jpeg' } });
    const res = await ask(db, member, { photo_key: 'assist/u_1/attachments/p.jpg' }, { R2_PRIVATE: bucket });
    const reply = (await json(res)).reply as Rec;
    assert.equal(reply?.mode, 'ai');
    const content = sent[0].messages.at(-1).content as Rec[];
    assert.equal(content[0].type, 'image');
    assert.equal(content[0].source.media_type, 'image/jpeg');
    assert.equal(content[1].type, 'text');
  } finally {
    done();
  }
});

test('a photo that is not theirs, or with photos off, is never sent: reply null', async () => {
  const sent = provider([]);
  try {
    const bucket = memoryBucket();
    await bucket.put('assist/u_2/attachments/p.jpg', JPEG, { httpMetadata: { contentType: 'image/jpeg' } });
    await bucket.put('assist/u_1/attachments/p.jpg', JPEG, { httpMetadata: { contentType: 'image/jpeg' } });
    const db = await shop(ON);
    assert.equal((await json(await ask(db, member, { photo_key: 'assist/u_2/attachments/p.jpg' }, { R2_PRIVATE: bucket }))).reply, null);
    assert.equal((await json(await ask(db, null, { photo_key: 'assist/u_1/attachments/p.jpg' }, { R2_PRIVATE: bucket }))).reply, null);
    const off = await shop({ ...ON, photos: false });
    assert.equal((await json(await ask(off, member, { photo_key: 'assist/u_1/attachments/p.jpg' }, { R2_PRIVATE: bucket }))).reply, null);
    assert.equal(sent.length, 0);
  } finally {
    done();
  }
});
