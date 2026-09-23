/**
 * «كاميرا/ملف/بصمة صوتية في المحادثة» — A VOICE NOTE AND A DOCUMENT, SENT AND
 * READ BACK AS WHAT THEY ARE.
 *
 * Before: the order chat's «ملف» took images only, and a voice note could not
 * exist anywhere — `chat_messages.kind` is `CHECK (kind IN ('text','image'))`
 * (0001), the upload route sniffed images and MP4 only, and the customer's
 * microphone said «قريباً». Three halves had to change together or none of it
 * would work, so every test here walks the real route chain — upload (magic
 * bytes), send (the key names the conversation), read (the kind the screen
 * draws) — against real migrations, with only the session and the buckets
 * stubbed.
 *
 * Run: node --import tsx --test tests/chatAttachments.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { asD1, ctx, freshDb } from './fixtures/app';
import type { AppContext } from '../worker/lib/types';
import { HttpError } from '../worker/lib/http';
import { chatRoutes, chatAttachmentKind } from '../worker/routes/chats';
import { fileRoutes, sniffChat, uploadRoutes } from '../worker/routes/uploads';
import { attachmentErrorText, attachmentKindOfFile } from '../src/components/chat/ChatAttachment';
import { baseMime, formatElapsed, pickRecorderMime, voiceFileName } from '../src/lib/voiceRecorder';
import { prepareUploadImage } from '../src/lib/imagePreprocess';
import { readFileSync } from 'node:fs';

class MemoryBucket {
  objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  async put(key: string, value: ArrayBuffer | ArrayBufferView, options?: { httpMetadata?: { contentType?: string } }) {
    const bytes = value instanceof ArrayBuffer
      ? new Uint8Array(value.slice(0))
      : new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    this.objects.set(key, { bytes, contentType: options?.httpMetadata?.contentType ?? '' });
  }
  async get(key: string) {
    const stored = this.objects.get(key);
    if (!stored) return null;
    return {
      body: new Blob([stored.bytes as unknown as BlobPart]).stream(),
      size: stored.bytes.byteLength,
      httpEtag: `"${key}"`,
      writeHttpMetadata(headers: Headers) {
        if (stored.contentType) headers.set('Content-Type', stored.contentType);
      },
    };
  }
  async head(key: string) {
    const stored = this.objects.get(key);
    return stored ? { key, size: stored.bytes.byteLength } : null;
  }
  async delete(key: string) { this.objects.delete(key); }
}

// ------------------------------------------------------------- sample bytes

const bytes = (...parts: Array<number[] | string>): Uint8Array => {
  const out: number[] = [];
  for (const p of parts) out.push(...(typeof p === 'string' ? [...p].map((ch) => ch.charCodeAt(0)) : p));
  while (out.length < 32) out.push(0);
  return new Uint8Array(out);
};
const WEBM = bytes([0x1a, 0x45, 0xdf, 0xa3], 'webm');
const OGG = bytes('OggS', [0, 2]);
const PDF = bytes('%PDF-1.7\n');
const MP3 = bytes('ID3', [3, 0]);
const MP4_AUDIO = bytes([0, 0, 0, 0x18], 'ftyp', 'iso5', [0, 0, 2, 0], 'iso5mp41');
const M4A = bytes([0, 0, 0, 0x18], 'ftyp', 'M4A ', [0, 0, 2, 0], 'M4A isom');
const MP4_VIDEO = bytes([0, 0, 0, 0x18], 'ftyp', 'isom', [0, 0, 2, 0], 'isomiso2');
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0]);

// =========================================================================
// THE SNIFF — what a conversation may carry, by magic bytes
// =========================================================================

test('SNIFF — a voice note in every container a browser records, and a PDF', () => {
  assert.deepEqual(sniffChat(WEBM, 'audio/webm'), { ext: 'webm', mime: 'audio/webm' });
  assert.deepEqual(sniffChat(OGG, 'audio/ogg'), { ext: 'ogg', mime: 'audio/ogg' });
  assert.deepEqual(sniffChat(MP3, ''), { ext: 'mp3', mime: 'audio/mpeg' });
  assert.deepEqual(sniffChat(MP4_AUDIO, 'audio/mp4'), { ext: 'mp4', mime: 'audio/mp4' }, 'Safari’s recorder');
  assert.deepEqual(sniffChat(M4A, ''), { ext: 'mp4', mime: 'audio/mp4' }, 'an M4A brand is audio whatever it declares');
  assert.deepEqual(sniffChat(PDF, 'application/pdf'), { ext: 'pdf', mime: 'application/pdf' });
});

test('SNIFF — the declared type chooses a LABEL for a proven container, never admission', () => {
  assert.equal(sniffChat(WEBM, 'video/webm')!.mime, 'video/webm');
  assert.equal(sniffChat(MP4_VIDEO, 'video/mp4')!.mime, 'video/mp4', 'a clip is still a clip');
  assert.equal(sniffChat(JPEG, 'audio/mp4')!.mime, 'image/jpeg', 'a picture that claims to be sound is a picture');
  assert.equal(sniffChat(bytes('<html><script>'), 'audio/webm'), null, 'a claim admits nothing');
  assert.equal(sniffChat(bytes('PK', [3, 4]), 'application/pdf'), null, 'a zip that says PDF is refused');
});

// =========================================================================
// THE WHOLE CHAIN
// =========================================================================

function harness() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('boss','Owner','boss@x.co','h','admin'),
      ('cust','Sara','sara@x.co','h','customer'),
      ('other','Zed','zed@x.co','h','customer');
    INSERT INTO chats (id) VALUES ('chat_1');
    INSERT INTO chat_participants (chat_id,user_id) VALUES ('chat_1','boss'), ('chat_1','cust');
  `);
  const bucket = new MemoryBucket();
  const hono = new Hono<AppContext>();
  const users: Record<string, unknown> = {
    boss: { id: 'boss', role: 'admin', email: 'boss@x.co' },
    cust: { id: 'cust', role: 'customer', email: 'sara@x.co' },
    other: { id: 'other', role: 'customer', email: 'zed@x.co' },
  };
  hono.use('*', async (c, next) => {
    c.env = { DB: asD1(raw), BUCKET: bucket, R2_PRIVATE: bucket, R2_PUBLIC: bucket } as never;
    c.set('user', (users[c.req.header('x-test-user') ?? ''] ?? null) as never);
    c.set('host', { kind: 'apex' } as never);
    await next();
  });
  hono.route('/api/chats', chatRoutes);
  hono.route('/api/uploads', uploadRoutes);
  hono.route('/files', fileRoutes);
  hono.onError((e, c) =>
    e instanceof HttpError
      ? c.json({ success: false, code: e.code, error: e.message }, e.status as 400)
      : c.json({ success: false, error: String(e) }, 500)
  );
  const as = (who: string, path: string, init: RequestInit = {}) =>
    hono.request(path, { ...init, headers: { 'x-test-user': who, 'CF-Connecting-IP': '1.2.3.4', ...(init.headers ?? {}) } }, undefined, ctx);
  const upload = (who: string, file: File, purpose = 'chat', entity = 'chat_1') => {
    const form = new FormData();
    form.set('purpose', purpose);
    form.set('entity_id', entity);
    form.set('file', file);
    return as(who, '/api/uploads', { method: 'POST', body: form });
  };
  const send = (who: string, body: unknown) =>
    as(who, '/api/chats/chat_1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const read = async (who: string) =>
    ((await (await as(who, '/api/chats/chat_1/messages')).json()) as { messages: Array<Record<string, unknown>> }).messages;
  return { raw, bucket, as, upload, send, read };
}

const file = (b: Uint8Array, name: string, type: string) => new File([b as unknown as BlobPart], name, { type });

test('THE SYMPTOM — the admin records a voice note, the CUSTOMER reads it back as audio they can play', async () => {
  const h = harness();
  const up = await h.upload('boss', file(WEBM, 'voice.webm', 'audio/webm'));
  const stored = (await up.json()) as { key: string; mime: string };
  assert.equal(up.status, 200, JSON.stringify(stored));
  assert.equal(stored.mime, 'audio/webm');
  assert.match(stored.key, /^chat\/chat_1\/audio\/[^/]+\.webm$/, 'filed under the conversation, in the audio folder');

  const sent = await h.send('boss', { kind: 'audio', fileKey: stored.key });
  const body = (await sent.json()) as { message: Record<string, unknown> };
  assert.equal(sent.status, 200, JSON.stringify(body));
  assert.equal(body.message.kind, 'audio', 'the send answers with the stored message, ready to append');

  // Stored honestly: not an 'image', and 0001's CHECK still holds.
  const row = h.raw.prepare('SELECT kind, attachment_kind, body, created_at FROM chat_messages').get() as Record<string, string>;
  assert.deepEqual({ kind: row.kind, attachment_kind: row.attachment_kind, body: row.body }, { kind: 'text', attachment_kind: 'audio', body: '' });
  assert.equal(body.message.created_at, row.created_at, 'the appended bubble carries the stored timestamp');

  const [m] = await h.read('cust');
  assert.equal(m.kind, 'audio');
  assert.equal(m.fileUrl, `/files/${stored.key}`);
  // And the customer can actually fetch the bytes, served as sound.
  const served = await h.as('cust', String(m.fileUrl));
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'audio/webm');
  // And the conversation list says what arrived instead of a blank preview.
  const list = (await (await h.as('cust', '/api/chats')).json()) as { chats: Array<{ id: string; last_message: string }> };
  assert.equal(list.chats.find((c) => c.id === 'chat_1')!.last_message, '🎤');
});

test('A DOCUMENT — «ملف» takes a PDF, and it comes back as a file, not a broken picture', async () => {
  const h = harness();
  const up = await h.upload('cust', file(PDF, 'invoice.pdf', 'application/pdf'));
  const stored = (await up.json()) as { key: string };
  assert.equal(up.status, 200, JSON.stringify(stored));
  assert.match(stored.key, /^chat\/chat_1\/files\/[^/]+\.pdf$/);
  assert.equal((await h.send('cust', { kind: 'file', fileKey: stored.key })).status, 200);
  const [m] = await h.read('boss');
  assert.equal(m.kind, 'file');
});

test('SAFARI’S RECORDING (MP4 audio) is a voice note, not a video', async () => {
  const h = harness();
  const up = await h.upload('boss', file(MP4_AUDIO, 'voice.m4a', 'audio/mp4'));
  const stored = (await up.json()) as { key: string; mime: string };
  assert.equal(up.status, 200, JSON.stringify(stored));
  assert.equal(stored.mime, 'audio/mp4');
  assert.match(stored.key, /\/audio\//);
});

test('THE CLIENT’S KIND IS A HINT — the folder the bytes were sniffed into decides', async () => {
  const h = harness();
  const up = await h.upload('boss', file(OGG, 'voice.ogg', 'audio/ogg'));
  const { key } = (await up.json()) as { key: string };
  await h.send('boss', { kind: 'image', fileKey: key });
  const row = h.raw.prepare('SELECT kind, attachment_kind FROM chat_messages').get() as Record<string, string>;
  assert.deepEqual({ ...row }, { kind: 'text', attachment_kind: 'audio' });
});

test('THE KEY STILL NAMES THE CONVERSATION — an audio key from another chat is refused', async () => {
  const h = harness();
  const res = await h.send('boss', { kind: 'audio', fileKey: 'chat/chat_2/audio/obj.webm' });
  assert.equal(res.status, 400);
  assert.equal((h.raw.prepare('SELECT COUNT(*) AS n FROM chat_messages').get() as { n: number }).n, 0);
});

test('ONLY THE CONVERSATION WIDENED — a PDF or a voice note on another purpose is still refused', async () => {
  const h = harness();
  const res = await h.upload('boss', file(PDF, 'x.pdf', 'application/pdf'), 'avatar', '');
  assert.equal(res.status, 400);
  const clip = await h.upload('boss', file(WEBM, 'x.webm', 'audio/webm'), 'receipt', '');
  assert.equal(clip.status, 400);
});

test('A LEGACY CLIP — stored as kind=’image’ before 0110 — is finally read back as a video', async () => {
  const h = harness();
  h.raw
    .prepare("INSERT INTO chat_messages (id,chat_id,sender_id,kind,body,file_key) VALUES ('m_old','chat_1','cust','image','','chat/chat_1/video/obj_1.mp4')")
    .run();
  const [m] = await h.read('boss');
  assert.equal(m.kind, 'video');
  assert.equal(chatAttachmentKind('chat/chat_1/attachments/obj.webp'), 'image', 'a picture is still a picture');
});

// =========================================================================
// THE CLIENT HALVES THAT DECIDE WHAT IS SENT
// =========================================================================

test('THE RECORDER picks the container every participant can PLAY first — MP4/AAC, then WebM, then Ogg', () => {
  assert.equal(pickRecorderMime((m) => m.startsWith('audio/mp4')), 'audio/mp4;codecs=mp4a.40.2', 'Safari');
  assert.equal(pickRecorderMime((m) => m.startsWith('audio/webm')), 'audio/webm;codecs=opus', 'Chrome without MP4');
  assert.equal(pickRecorderMime((m) => m.startsWith('audio/ogg')), 'audio/ogg;codecs=opus', 'Firefox');
  assert.equal(pickRecorderMime(() => { throw new Error('no'); }), '', 'a browser that throws lets the recorder choose');
  assert.equal(baseMime('audio/webm;codecs=opus'), 'audio/webm');
  assert.match(voiceFileName('audio/mp4', 1), /^voice-1\.m4a$/);
  assert.match(voiceFileName('audio/webm;codecs=opus', 1), /^voice-1\.webm$/);
});

test('THE OPTIMISTIC BUBBLE guesses from the file’s type, and a PDF is a document', () => {
  assert.equal(attachmentKindOfFile({ type: 'audio/webm' }), 'audio');
  assert.equal(attachmentKindOfFile({ type: 'image/png' }), 'image');
  assert.equal(attachmentKindOfFile({ type: 'video/mp4' }), 'video');
  assert.equal(attachmentKindOfFile({ type: 'application/pdf' }), 'file');
});

// =========================================================================
// A WORKER AHEAD OF 0110 — the deploy-ahead-of-migrations incident
// =========================================================================

test('AHEAD OF 0110 — a text line, a voice note and the conversation list still work without attachment_kind', async () => {
  const h = harness();
  h.raw.exec('ALTER TABLE chat_messages DROP COLUMN attachment_kind');

  const text = await h.send('cust', { body: 'مرحبا' });
  assert.equal(text.status, 200, 'a plain text line never names the 0110 column');

  const up = await h.upload('boss', file(WEBM, 'voice.webm', 'audio/webm'));
  const { key } = (await up.json()) as { key: string };
  const voice = await h.send('boss', { kind: 'audio', fileKey: key });
  assert.equal(voice.status, 200, 'an attachment falls back to the pre-0110 insert');

  // The read path still derives the kind from the key's folder.
  const msgs = await h.read('cust');
  assert.equal(msgs.at(-1)!.kind, 'audio');

  const list = await h.as('cust', '/api/chats');
  assert.equal(list.status, 200, 'the list falls back to the pre-0110 preview');
  const { chats } = (await list.json()) as { chats: Array<{ id: string; last_message: string }> };
  assert.equal(chats.find((c) => c.id === 'chat_1')!.last_message, '📷');
});

// =========================================================================
// THE BROWSER'S CEILING IS THE SERVER'S — and a refusal says why
// =========================================================================

const sized = (head: Uint8Array, size: number, name: string, type: string) => {
  const b = new Uint8Array(size);
  b.set(head);
  return new File([b as unknown as BlobPart], name, { type });
};

test('A 9 MB PDF, A 9 MB VOICE NOTE AND A 20 MB WEBM CLIP leave the browser — the server admits all three', async () => {
  const MB = 1024 * 1024;
  for (const f of [
    sized(PDF, 9 * MB, 'scan.pdf', 'application/pdf'),
    sized(OGG, 9 * MB, 'voice.ogg', 'audio/ogg'),
    sized(MP3, 9 * MB, 'voice.mp3', 'audio/mpeg'),
    sized(WEBM, 20 * MB, 'clip.webm', 'video/webm'),
  ]) {
    const out = await prepareUploadImage(f, 'chat');
    assert.equal(out.file, f, `${f.name} travels untouched`);
  }
  // Past the server's own ceilings the browser still refuses, and says so.
  await assert.rejects(prepareUploadImage(sized(PDF, 11 * MB, 'big.pdf', 'application/pdf'), 'chat'), /الحد 10\.0 MB/);
  await assert.rejects(prepareUploadImage(sized(WEBM, 41 * MB, 'big.webm', 'video/webm'), 'chat'), /الحد 40\.0 MB/);
});

test('THE REFUSAL IS SHOWN — a size error names the limit; only a network failure is generic', () => {
  assert.equal(attachmentErrorText(new Error('الملف 11.0 MB — الحد 10.0 MB / file exceeds the limit'), 'x'), 'الملف 11.0 MB — الحد 10.0 MB / file exceeds the limit');
  assert.equal(attachmentErrorText(new TypeError('Failed to fetch'), 'تعذر إرسال المرفق'), 'تعذر إرسال المرفق');
  assert.equal(attachmentErrorText('nope', 'تعذر إرسال المرفق'), 'تعذر إرسال المرفق');
  for (const screen of ['src/pages/Chat.tsx', 'src/components/adminOrders/OrderChatPanel.tsx']) {
    const src = readFileSync(screen, 'utf8');
    assert.match(src, /attachmentErrorText\(err,/, `${screen} shows why an attachment was refused`);
  }
});

test('THE RECORDING TIMER reads in the page’s digits — Arabic-Indic unless English, on BOTH screens', () => {
  assert.equal(formatElapsed(65), '1:05');
  assert.equal(formatElapsed(65, true), '1:05');
  assert.equal(formatElapsed(65, false), '١:٠٥');
  for (const screen of ['src/pages/Chat.tsx', 'src/components/adminOrders/OrderChatPanel.tsx']) {
    assert.match(readFileSync(screen, 'utf8'), /formatElapsed\(voice\.elapsed, lang === 'en'\)/, screen);
  }
});
