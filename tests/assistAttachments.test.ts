/**
 * THE OWNER'S ITEM 5, AND THE TICKET «تحدث مع الفريق» OPENS (support assistant
 * v2, push A; migration 0209).
 *
 *   - A photo, a clip and a voice note attached in the assistant chat are
 *     stored PRIVATELY under the uploader (`assist/<uid>/…`), through the
 *     existing upload door, its sniffing and its size limits.
 *   - The `/files` gate shows them to their uploader, and to staff only once a
 *     ticket names them.
 *   - The ticket the triage drafts carries them, plus the triage as closed-set
 *     values (`handoff_summary`) that only the desk reads back.
 *   - A database before 0209 still takes a plain ticket.
 *
 * Real migrations, real routes, the real R2 adapter over memory buckets; only
 * the session and the buckets are stubbed.
 *
 * Run: node --import tsx --test tests/assistAttachments.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ROOT, SqliteD1 } from './fixtures/d1';
import { ctx } from './fixtures/app';
import type { AppContext } from '../worker/lib/types';
import { HttpError } from '../worker/lib/http';
import { supportRoutes } from '../worker/routes/support';
import { fileRoutes, uploadRoutes } from '../worker/routes/uploads';
import { claimMediaObjectForCleanup } from '../worker/lib/productDeletion';
import { queueUnattachedAssistMedia } from '../worker/lib/assist/attachments';
import { STATIC_SECURITY_HEADERS } from '../worker/lib/securityPolicy';
import { ASSIST_ATTACH_LIMIT } from '../worker/lib/uploadEntity';

type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

class MemoryBucket {
  objects = new Map<string, { bytes: Uint8Array; metadata: Record<string, string> }>();
  async put(key: string, value: ArrayBuffer | ArrayBufferView, options?: { httpMetadata?: Record<string, string> }) {
    const bytes =
      value instanceof ArrayBuffer
        ? new Uint8Array(value.slice(0))
        : new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    this.objects.set(key, { bytes, metadata: options?.httpMetadata ?? {} });
  }
  async get(key: string) {
    const stored = this.objects.get(key);
    if (!stored) return null;
    return {
      body: new Blob([stored.bytes as unknown as BlobPart]).stream(),
      size: stored.bytes.byteLength,
      httpEtag: `"${key}"`,
      httpMetadata: stored.metadata,
      writeHttpMetadata(headers: Headers) {
        if (stored.metadata.contentType) headers.set('Content-Type', stored.metadata.contentType);
      },
      arrayBuffer: () => new Blob([stored.bytes as unknown as BlobPart]).arrayBuffer(),
    };
  }
  async head(key: string) {
    const stored = this.objects.get(key);
    return stored ? { key, size: stored.bytes.byteLength } : null;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

/** A real WebP with a readable VP8X header — the route measures what it stores. */
function webp(width = 640, height = 480): Uint8Array {
  const b = new Uint8Array(30);
  b.set([0x52, 0x49, 0x46, 0x46], 0);
  b.set([0x57, 0x45, 0x42, 0x50], 8);
  b.set([0x56, 0x50, 0x38, 0x58], 12);
  const w = width - 1;
  const h = height - 1;
  b.set([w & 255, (w >>> 8) & 255, (w >>> 16) & 255], 24);
  b.set([h & 255, (h >>> 8) & 255, (h >>> 16) & 255], 27);
  return b;
}
const bytes = (...parts: Array<number[] | string>): Uint8Array =>
  new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((ch) => ch.charCodeAt(0)) : p)));
const WEBM = bytes([0x1a, 0x45, 0xdf, 0xa3], 'webm-voice');
const MP4_VIDEO = bytes([0, 0, 0, 0x18], 'ftyp', 'isom', [0, 0, 2, 0], 'isomiso2');
const PDF = bytes('%PDF-1.7 evidence');

const images = {
  async info() {
    return { format: 'image/webp', fileSize: 30, width: 640, height: 480 };
  },
  input() {
    return {
      async output() {
        return { response: () => new Response(webp(640, 480)) };
      },
    };
  },
};

const USERS: Record<string, { id: string; role: 'customer' | 'admin'; email: string }> = {
  owner: { id: 'u_owner', role: 'customer', email: 'owner@x.test' },
  stranger: { id: 'u_stranger', role: 'customer', email: 'stranger@x.test' },
  admin: { id: 'u_admin', role: 'admin', email: 'admin@x.test' },
};

function harness(opts: { without0209?: boolean } = {}) {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync(join(ROOT, 'migrations')).filter((n) => n.endsWith('.sql')).sort()) {
    if (opts.without0209 && f.startsWith('0209_')) continue;
    raw.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  }
  for (const u of Object.values(USERS)) {
    raw.prepare("INSERT INTO users (id,name,email,password_hash,role) VALUES (?,?,?,'h',?)").run(u.id, u.id, u.email, u.role);
  }
  const db = new SqliteD1(raw) as unknown as D1Database;
  const publicBucket = new MemoryBucket();
  const privateBucket = new MemoryBucket();
  const hono = new Hono<AppContext>();
  hono.use('*', async (c, next) => {
    c.env = { DB: db, BUCKET: privateBucket, R2_PUBLIC: publicBucket, R2_PRIVATE: privateBucket, IMAGES: images } as never;
    const who = c.req.header('x-test-user') ?? '';
    c.set('user', (USERS[who] ?? null) as never);
    c.set('host', { kind: 'apex' } as never);
    await next();
  });
  hono.route('/api/support', supportRoutes);
  hono.route('/api/uploads', uploadRoutes);
  hono.route('/files', fileRoutes);
  hono.onError((e, c) =>
    e instanceof HttpError
      ? c.json({ success: false, code: e.code, error: e.message }, e.status as 400)
      : c.json({ success: false, error: String(e) }, 500)
  );
  const as = (who: string, path: string, init: RequestInit = {}) =>
    hono.request(path, { ...init, headers: { 'x-test-user': who, 'CF-Connecting-IP': '1.2.3.4', ...(init.headers ?? {}) } }, undefined, ctx);
  const postJson = (who: string, path: string, body: unknown) =>
    as(who, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const upload = (who: string, data: Uint8Array, name: string, type: string, purpose = 'assist') => {
    const form = new FormData();
    form.set('purpose', purpose);
    form.set('file', new File([data as unknown as BlobPart], name, { type }));
    return as(who, '/api/uploads', { method: 'POST', body: form });
  };
  const ask = async (who: string, body: Rec): Promise<Rec> => {
    const res = await postJson(who, '/api/support/assistant', { locale: 'ar', ...body });
    assert.equal(res.status, 200);
    return ((await res.json()) as Rec).reply as Rec;
  };
  return { raw, db, as, postJson, upload, ask, privateBucket, publicBucket };
}

const body = async (r: Response): Promise<Rec> => (await r.json()) as Rec;

async function threeFiles(h: ReturnType<typeof harness>): Promise<{ photo: string; voice: string; clip: string }> {
  const photo = await body(await h.upload('owner', webp(), 'nozzle.webp', 'image/webp'));
  const voice = await body(await h.upload('owner', WEBM, 'voice.webm', 'audio/webm'));
  const clip = await body(await h.upload('owner', MP4_VIDEO, 'clip.mp4', 'video/mp4'));
  return { photo: String(photo.key), voice: String(voice.key), clip: String(clip.key) };
}

// ═════════════════════════════════════════════ the upload door, purpose assist

test('a photo, a voice note and a clip are filed PRIVATELY under the uploader, in the folder that names their kind', async () => {
  const h = harness();
  const { photo, voice, clip } = await threeFiles(h);
  assert.match(photo, /^assist\/u_owner\/attachments\/[a-f0-9]+\.webp$/);
  assert.match(voice, /^assist\/u_owner\/audio\/[a-f0-9]+\.webm$/);
  assert.match(clip, /^assist\/u_owner\/video\/[a-f0-9]+\.mp4$/);
  for (const key of [photo, voice, clip]) assert.ok(h.privateBucket.objects.has(key), key);
  assert.equal(h.publicBucket.objects.size, 0, 'nothing the customer attached is ever public');
  const ledger = h.raw.prepare(`SELECT domain, owner_id, purpose FROM file_objects WHERE object_key = ?`).get(voice) as Rec;
  assert.deepEqual({ ...ledger }, { domain: 'assist', owner_id: 'u_owner', purpose: 'assist' });
});

test('the door holds: no account, a PDF, a file over the limit, and a flood are each refused by name', async () => {
  const h = harness();
  assert.equal((await h.upload('', webp(), 'x.webp', 'image/webp')).status, 401, 'a guest is asked to sign in first');
  const pdf = await h.upload('owner', PDF, 'scan.pdf', 'application/pdf');
  assert.equal(pdf.status, 400);
  assert.equal((await body(pdf)).code, 'ASSIST_ATTACH_KIND');

  h.raw.exec(`INSERT INTO admin_settings (key, value) VALUES ('uploadLimits', '{"video_mb":1}')`);
  const big = new Uint8Array(2 * 1024 * 1024);
  big.set(MP4_VIDEO);
  const tooBig = await h.upload('owner', big, 'long.mp4', 'video/mp4');
  assert.equal(tooBig.status, 400);
  assert.equal((await body(tooBig)).code, 'UPLOAD_TOO_LARGE');

  const seed = h.raw.prepare(
    `INSERT INTO file_objects (object_key, visibility, domain, owner_id, entity_id, mime_type, byte_size) VALUES (?, 'private', 'assist', 'u_owner', 'u_owner', 'image/webp', 30)`
  );
  for (let i = 0; i < ASSIST_ATTACH_LIMIT; i++) seed.run(`assist/u_owner/attachments/seed${i}.webp`);
  const flood = await h.upload('owner', webp(), 'one-more.webp', 'image/webp');
  assert.equal(flood.status, 400);
  const refusal = await body(flood);
  assert.equal(refusal.code, 'ASSIST_ATTACH_LIMIT');
  // Review round 3: a file sent with a ticket still counts for its seven days, so the refusal
  // never promises that sending the ticket frees the ceiling; it says when it frees.
  assert.doesNotMatch(JSON.stringify(refusal), /send the ticket/i);
  assert.match(JSON.stringify(refusal), /few days/);
  assert.equal((await h.upload('stranger', webp(), 'mine.webp', 'image/webp')).status, 200, 'the ceiling is per uploader');
});

// ══════════════════════════════════════════════════════════ the /files gate

test('/files: the uploader reads it; another customer never; staff only once a ticket names it', async () => {
  const h = harness();
  const { photo } = await threeFiles(h);
  assert.equal((await h.as('owner', `/files/${photo}`)).status, 200);
  assert.equal((await h.as('stranger', `/files/${photo}`)).status, 403);
  assert.equal((await h.as('', `/files/${photo}`)).status, 403);
  assert.equal((await h.as('admin', `/files/${photo}`)).status, 403, 'staff do not browse what was never sent to them');

  const sent = await h.postJson('owner', '/api/support/tickets', { confirm: true, subject: 'Nozzle clog', body: 'Nothing comes out.', attachments: [photo] });
  assert.equal(sent.status, 200, JSON.stringify(await sent.clone().json()));
  assert.equal((await h.as('admin', `/files/${photo}`)).status, 200, 'handed to the team, so the desk can open it');
  assert.equal((await h.as('stranger', `/files/${photo}`)).status, 403, 'and still nobody else');
});

// ═══════════════════ the triage → «تحدث مع الفريق» → a prefilled ticket with files

test('the triage ends in a ticket that carries the summary and the three files; the desk reads both, the customer only the files', async () => {
  const h = harness();
  const steps = await h.ask('owner', {
    intent: 'printer_problem',
    params: { step: 'symptom', symptom: 'clog' },
    context: { v: 1, printer: { model: 'A1' }, triage: { stage: 'symptom' } },
  });
  assert.equal(steps.context.triage.stage, 'steps');
  const talk = await h.ask('owner', { intent: 'printer_problem', params: { step: 'outcome', outcome: 'not_fixed' }, context: steps.context });
  assert.equal(talk.handoff, true);
  const draft = talk.ticket_draft as Rec;
  assert.equal(draft.handoff.model, 'A1');
  assert.equal(draft.handoff.symptom, 'clog');
  assert.deepEqual(draft.handoff.tried, (steps.steps as Rec[]).map((st) => st.key), 'every step shown counts as tried');

  const files = await threeFiles(h);
  const keys = [files.photo, files.voice, files.clip];
  const ticketBody = {
    confirm: true,
    subject: draft.subject,
    body: draft.body,
    attachments: keys,
    handoff: draft.handoff,
    idempotencyKey: 'assist-key-0001',
  };
  const created = await h.postJson('owner', '/api/support/tickets', ticketBody);
  assert.equal(created.status, 200, JSON.stringify(await created.clone().json()));
  const ticket = (await body(created)).ticket as Rec;
  assert.equal(ticket.handoff_summary, undefined, 'the summary never rides back to the customer');

  const stored = h.raw.prepare('SELECT handoff_summary FROM support_tickets WHERE id = ?').get(ticket.id) as Rec;
  const summary = JSON.parse(String(stored.handoff_summary));
  assert.equal(summary.model, 'A1');
  assert.equal(summary.symptom, 'clog');
  assert.equal(summary.attachments, 3, 'counted from the files the door linked, not from the body');
  const rows = h.raw.prepare('SELECT file_key, kind FROM support_ticket_attachments WHERE ticket_id = ? ORDER BY position').all(ticket.id) as Rec[];
  assert.deepEqual(rows.map((r) => [r.file_key, r.kind]), [
    [files.photo, 'image'],
    [files.voice, 'audio'],
    [files.clip, 'video'],
  ]);

  // A replay of the same confirmation is the same ticket, with the same three rows.
  const again = await h.postJson('owner', '/api/support/tickets', ticketBody);
  assert.equal((await body(again)).replay, true);
  assert.equal((h.raw.prepare('SELECT COUNT(*) AS n FROM support_ticket_attachments').get() as Rec).n, 3);

  const desk = await body(await h.as('admin', `/api/support/admin/tickets/${ticket.id}`));
  assert.equal(desk.handoff.model, 'A1');
  assert.equal(desk.handoff.symptom.label.ar, 'انسداد النوزل');
  assert.equal(desk.handoff.symptom.label.ckb, 'گیرانی نۆزڵ');
  assert.ok(desk.handoff.tried.length >= 2 && desk.handoff.tried[0].text.en.length > 0);
  assert.deepEqual((desk.attachments as Rec[]).map((a) => a.kind), ['image', 'audio', 'video']);
  assert.equal(desk.attachments[0].file_url, `/files/${files.photo}`);
  for (const a of desk.attachments as Rec[]) assert.equal((await h.as('admin', a.file_url)).status, 200, a.file_url);

  const mine = await body(await h.as('owner', `/api/support/tickets/${ticket.id}`));
  assert.equal(mine.handoff, undefined, 'the customer reads their files, not the summary');
  assert.equal((mine.attachments as Rec[]).length, 3);
  assert.ok(!JSON.stringify(mine).includes('handoff_summary'));
});

test('the ticket door refuses a file that is not this customer’s, one that was never stored, too many, or a foreign folder', async () => {
  const h = harness();
  const theirs = String((await body(await h.upload('stranger', webp(), 'theirs.webp', 'image/webp'))).key);
  const send = (attachments: unknown) =>
    h.postJson('owner', '/api/support/tickets', { confirm: true, subject: 'Nozzle clog', body: 'Nothing comes out.', attachments });
  const cases: Array<[unknown, string]> = [
    [[theirs], 'ATTACHMENT_NOT_YOURS'],
    [['support/tkt_x/attachments/a.webp'], 'ATTACHMENT_NOT_YOURS'],
    [['assist/u_owner/attachments/never-uploaded.webp'], 'ATTACHMENT_NOT_FOUND'],
    [['assist/u_owner/files/a.pdf'], 'ATTACHMENT_INVALID'],
    [Array.from({ length: 7 }, (_, i) => `assist/u_owner/attachments/a${i}.webp`), 'ATTACHMENT_LIMIT'],
    ['assist/u_owner/attachments/a.webp', 'ATTACHMENT_INVALID'],
  ];
  for (const [attachments, code] of cases) {
    // The ticket door allows five attempts an hour; each case is its own attempt.
    h.raw.exec('DELETE FROM rate_limits');
    const res = await send(attachments);
    assert.equal(res.status, 400, JSON.stringify(attachments));
    assert.equal((await body(res)).code, code, JSON.stringify(attachments));
  }
  assert.equal((h.raw.prepare('SELECT COUNT(*) AS n FROM support_tickets').get() as Rec).n, 0, 'no refused ticket was half written');
});

test('a forged summary keeps only closed-set values', async () => {
  const h = harness();
  const res = await h.postJson('owner', '/api/support/tickets', {
    confirm: true,
    subject: 'Printer problem',
    body: 'It stopped printing.',
    handoff: { v: 1, model: 'Z9', symptom: 'clog', tried: ['cool_down', '<script>'], code: 'DROP TABLE', shown: ['p_a1', '../x'], attachments: 99, note: 'hi' },
  });
  assert.equal(res.status, 200);
  const id = (await body(res)).ticket.id;
  const summary = JSON.parse(String((h.raw.prepare('SELECT handoff_summary FROM support_tickets WHERE id = ?').get(id) as Rec).handoff_summary));
  assert.deepEqual(summary, { v: 1, model: null, symptom: 'clog', tried: ['cool_down'], shown: ['p_a1'], attachments: 0 });
});

test('«تحدث مع الفريق» typed mid-triage opens the same prefilled draft', async () => {
  const h = harness();
  const reply = await h.ask('owner', { text: 'تحدث مع الفريق', context: { v: 1, printer: { model: 'P1S' }, triage: { stage: 'steps', symptom: 'adhesion' } } });
  assert.equal(reply.handoff, true);
  assert.match(reply.ticket_draft.subject, /P1S/);
  assert.equal(reply.ticket_draft.handoff.symptom, 'adhesion');
  const cold = await h.ask('owner', { text: 'تحدث مع الفريق' });
  assert.equal(cold.intent, 'human_handoff');
  assert.equal(cold.ticket_draft, undefined, 'without a triage it is the plain handoff');
});

test('a GUEST typing «تحدث مع الفريق» mid-triage gets the same draft and the sign-in link, in ar, en and ckb, and keeps the triage', async () => {
  const h = harness();
  for (const [locale, words] of [
    ['ar', 'تحدث مع الفريق'],
    ['ar', 'اريد احجي ويا الفريق'],
    ['ar', 'افتح تذكرة'],
    ['en', 'talk to the team'],
    ['ckb', 'قسە لەگەڵ تیمەکە بکە'],
  ] as const) {
    h.raw.exec('DELETE FROM rate_limits');
    const context = { v: 1, printer: { model: 'P1S' }, triage: { stage: 'steps', symptom: 'adhesion' } };
    const reply = await h.ask('', { locale, text: words, context });
    assert.equal(reply.handoff, true, `${locale}: ${JSON.stringify(reply).slice(0, 200)}`);
    assert.equal(reply.auth_required, true, locale);
    assert.ok((reply.links as Rec[]).some((l) => l.to === '/auth'), `${locale}: the sign-in link`);
    assert.match(reply.ticket_draft.subject, /P1S/, locale);
    assert.equal(reply.ticket_draft.handoff.symptom, 'adhesion', locale);
    assert.deepEqual(reply.context.triage, { stage: 'done', symptom: 'adhesion' }, `${locale}: the triage is not lost on the way to the sign-in page`);
    // Signed in, the chip drafts the same ticket, never «المشكلة: أخرى».
    const after = await h.ask('owner', { locale, intent: 'printer_problem', params: { step: 'talk' }, context: reply.context });
    assert.equal(after.ticket_draft.handoff.symptom, 'adhesion', locale);
    assert.equal(after.ticket_draft.handoff.model, 'P1S', locale);
  }
  // Without a triage a guest still gets the account sign-in reply for the plain handoff.
  const cold = await h.ask('', { text: 'تحدث مع الفريق' });
  assert.equal(cold.ticket_draft, undefined);
  assert.equal(cold.auth_required, true);
});

// ═══════════════════════════════════════════════ a replay, the cleanup and the ceiling

const count = (h: ReturnType<typeof harness>, sql: string, ...args: string[]): number =>
  Number((h.raw.prepare(sql).get(...args) as Rec).n);

async function photos(h: ReturnType<typeof harness>, n: number, tag: string): Promise<string[]> {
  const keys: string[] = [];
  for (let i = 0; i < n; i++) {
    h.raw.exec('DELETE FROM rate_limits');
    const res = await h.upload('owner', webp(), `${tag}${i}.webp`, 'image/webp');
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    keys.push(String((await body(res)).key));
  }
  return keys;
}

test('a replay of the same confirmation adds no file: never past the six, never onto a ticket staff resolved', async () => {
  const h = harness();
  const base = { confirm: true, subject: 'Nozzle clog', body: 'Nothing comes out.', idempotencyKey: 'assist-key-replay-1' };
  const first = await photos(h, 6, 'a');
  const created = await h.postJson('owner', '/api/support/tickets', { ...base, attachments: first });
  assert.equal(created.status, 200);
  const id = String((await body(created)).ticket.id);
  const rows = () => count(h, 'SELECT COUNT(*) AS n FROM support_ticket_attachments WHERE ticket_id = ?', id);
  assert.equal(rows(), 6, 'the first confirmation links all six');

  // The same key with six other files: the same ticket, the same six.
  const other = await photos(h, 6, 'b');
  h.raw.exec('DELETE FROM rate_limits');
  const replay = await h.postJson('owner', '/api/support/tickets', { ...base, attachments: other });
  assert.equal(replay.status, 200);
  assert.equal((await body(replay)).replay, true);
  assert.equal(rows(), 6, 'a replay never passes the six-file limit');
  assert.equal(((await body(await h.as('owner', `/api/support/tickets/${id}`))).attachments as Rec[]).length, 6);
  for (const key of other) assert.equal((await h.as('admin', `/files/${key}`)).status, 403, 'never handed to the team');

  // Resolved by staff, then replayed with new files: nothing is added and nothing reopens.
  h.raw.prepare("UPDATE support_tickets SET state = 'resolved' WHERE id = ?").run(id);
  const late = await photos(h, 3, 'c');
  h.raw.exec('DELETE FROM rate_limits');
  const again = await h.postJson('owner', '/api/support/tickets', { ...base, attachments: late });
  assert.equal((await body(again)).replay, true);
  assert.equal(rows(), 6);
  assert.equal((h.raw.prepare('SELECT state FROM support_tickets WHERE id = ?').get(id) as Rec).state, 'resolved');
  for (const key of late) assert.equal((await h.as('admin', `/files/${key}`)).status, 403);
  const summary = h.raw.prepare('SELECT handoff_summary FROM support_tickets WHERE id = ?').get(id) as Rec;
  assert.equal(summary.handoff_summary ?? null, null, 'no summary was sent, none was written');
});

test('the ticket door holds each key against the cleanup: a key the drain has claimed is refused, a key it took cannot be claimed', async () => {
  const h = harness();
  const [claimed, kept] = await photos(h, 2, 'g');
  const token = await claimMediaObjectForCleanup(h.db as never, claimed);
  assert.ok(token, 'the drain holds the claim on the old key');
  const refused = await h.postJson('owner', '/api/support/tickets', { confirm: true, subject: 'Nozzle clog', body: 'Nothing comes out.', attachments: [claimed] });
  assert.equal(refused.status, 400);
  assert.equal((await body(refused)).code, 'ATTACHMENT_NOT_FOUND', 'being deleted: never linked to a ticket that would point at nothing');
  assert.equal(count(h, 'SELECT COUNT(*) AS n FROM support_tickets'), 0);
  h.raw.exec('DELETE FROM rate_limits');
  const sent = await h.postJson('owner', '/api/support/tickets', { confirm: true, subject: 'Nozzle clog', body: 'Nothing comes out.', attachments: [kept] });
  assert.equal(sent.status, 200);
  assert.equal(await claimMediaObjectForCleanup(h.db as never, kept), null, 'protected while the ticket commits; then the ticket names it');
});

test('the weekly ceiling holds against parallel uploads: exactly thirty live files, the others refused and removed', async () => {
  const h = harness();
  const seed = h.raw.prepare(
    `INSERT INTO file_objects (object_key, visibility, domain, owner_id, entity_id, mime_type, byte_size)
     VALUES (?, 'private', 'assist', 'u_owner', 'u_owner', 'image/webp', 30)`
  );
  for (let i = 0; i < ASSIST_ATTACH_LIMIT - 1; i++) seed.run(`assist/u_owner/attachments/seed${i}.webp`);
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => h.upload('owner', webp(), `par${i}.webp`, 'image/webp')));
  const accepted = results.filter((r) => r.status === 200);
  assert.equal(accepted.length, 1, `${results.map((r) => r.status).join(',')}`);
  for (const r of results.filter((x) => x.status !== 200)) {
    assert.equal(r.status, 400);
    assert.equal((await body(r)).code, 'ASSIST_ATTACH_LIMIT');
  }
  const live = count(h, `SELECT COUNT(*) AS n FROM file_objects WHERE owner_id = 'u_owner' AND domain = 'assist' AND deleted_at IS NULL`);
  assert.equal(live, ASSIST_ATTACH_LIMIT);
  const stored = [...h.privateBucket.objects.keys()].filter((k) => k.startsWith('assist/u_owner/'));
  assert.equal(stored.length, 1, 'every refused upload is removed from the bucket again');
});

// ═══════════════════════════════════════════════ a database before 0209

test('before 0209: a plain ticket still opens; files are refused by name; the summary is left out', async () => {
  const h = harness({ without0209: true });
  const plain = await h.postJson('owner', '/api/support/tickets', {
    confirm: true,
    subject: 'Nozzle clog',
    body: 'Nothing comes out.',
    handoff: { v: 1, model: 'A1', symptom: 'clog', tried: [], shown: [], attachments: 0 },
  });
  assert.equal(plain.status, 200, JSON.stringify(await plain.clone().json()));
  const id = (await body(plain)).ticket.id;
  const { photo } = await threeFiles(h);
  const withFiles = await h.postJson('owner', '/api/support/tickets', { confirm: true, subject: 'Nozzle clog', body: 'Nothing comes out.', attachments: [photo] });
  assert.equal(withFiles.status, 400);
  assert.equal((await body(withFiles)).code, 'ATTACHMENTS_UNAVAILABLE');
  const desk = await body(await h.as('admin', `/api/support/admin/tickets/${id}`));
  assert.equal(desk.handoff, null);
  assert.deepEqual(desk.attachments, []);
  assert.deepEqual((await body(await h.as('owner', `/api/support/tickets/${id}`))).attachments, []);
  assert.equal((await h.as('admin', `/files/${photo}`)).status, 403, 'no table, no hand-over');
  assert.deepEqual(await queueUnattachedAssistMedia(h.db), { queued: 0, skipped: true });
});

// ═══════════════════════════════════════════════ retention

test('retention queues an unclaimed file after seven days, never one a ticket took, and never twice', async () => {
  const h = harness();
  const { photo, voice } = await threeFiles(h);
  const sent = await h.postJson('owner', '/api/support/tickets', { confirm: true, subject: 'Nozzle clog', body: 'Nothing comes out.', attachments: [voice] });
  assert.equal(sent.status, 200);
  assert.deepEqual(await queueUnattachedAssistMedia(h.db), { queued: 0, skipped: false }, 'nothing is old yet');
  h.raw.exec(`UPDATE file_objects SET created_at = datetime('now', '-8 days') WHERE domain = 'assist'`);
  const first = await queueUnattachedAssistMedia(h.db);
  assert.equal(first.queued, 2, 'the photo and the clip; the voice note went with the ticket');
  const queued = (h.raw.prepare(`SELECT object_key, reason, visibility FROM media_cleanup_jobs ORDER BY object_key`).all() as Rec[]).map((r) => ({ ...r }));
  assert.ok(queued.every((r) => r.reason === 'assist_unattached' && r.visibility === 'private'));
  assert.ok(queued.some((r) => r.object_key === photo));
  assert.ok(!queued.some((r) => r.object_key === voice));
  assert.equal((await queueUnattachedAssistMedia(h.db)).queued, 0, 'a key is queued once');
});

test('the microphone is allowed for this origin only (voice notes), the camera stays as it was', () => {
  const policy = STATIC_SECURITY_HEADERS['Permissions-Policy'];
  assert.match(policy, /microphone=\(self\)/);
  assert.match(policy, /camera=\(self\)/);
  assert.match(policy, /geolocation=\(\)/);
});
