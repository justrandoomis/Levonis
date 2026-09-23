/**
 * A SUPPORT TICKET IS A CONVERSATION — it appends, and it carries a picture.
 *
 * THE TWO FAILURES THIS SUITE PINS, both reported by the owner against the
 * live site and both invisible to every test that existed before it:
 *
 *  1. «كل رد يعيد تحميل المحادثة» — the reply endpoint answered a bare
 *     `{success:true}`, so the client had no id and no timestamp to append
 *     with and did the only thing it could: threw the thread away and fetched
 *     it again, blanking every bubble behind a spinner. A client fix alone
 *     would have been a guess about what the server wrote; these tests assert
 *     the SERVER hands back the row it actually inserted, and that the id and
 *     the `created_at` in the response are the id and the `created_at` in the
 *     database. That equality is the whole contract — an appended bubble whose
 *     timestamp is a client guess sorts wrongly the moment the page reloads.
 *
 *  2. «لا توجد طريقة لإرفاق وسائط» — `support_ticket_messages` had no `kind`
 *     and no `file_key` (migration 0107 adds them), and `purpose` on the
 *     upload route had no `support`. The interesting half is not that an
 *     upload now succeeds; it is the THREE refusals around it, because the
 *     `else { throw notFound() }` in the private-file gate was the only thing
 *     keeping every non-receipt, non-chat private key unreadable, and opening
 *     a `support/` branch there is exactly where a careless check would hand
 *     one customer's evidence photograph to another.
 *
 * Real migrations, real routes, real R2 adapter. Nothing about the code under
 * test is mocked; only the session lookup and the buckets are stubbed.
 *
 * Run: node --import tsx --test tests/supportTicketMedia.test.ts
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

class MemoryBucket {
  objects = new Map<string, { bytes: Uint8Array; metadata: Record<string, string> }>();
  async put(key: string, value: ArrayBuffer | ArrayBufferView, options?: { httpMetadata?: Record<string, string> }) {
    const bytes = value instanceof ArrayBuffer
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
  async delete(key: string) { this.objects.delete(key); }
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

const images = {
  async info() { return { format: 'image/webp', fileSize: 30, width: 640, height: 480 }; },
  input() {
    return { async output() { return { response: () => new Response(webp(640, 480)) }; } };
  },
};

const USERS: Record<string, { id: string; role: 'customer' | 'admin'; email: string }> = {
  owner: { id: 'u_owner', role: 'customer', email: 'owner@x.test' },
  stranger: { id: 'u_stranger', role: 'customer', email: 'stranger@x.test' },
  admin: { id: 'u_admin', role: 'admin', email: 'admin@x.test' },
};

function harness() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync(join(ROOT, 'migrations')).filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  }
  for (const u of Object.values(USERS)) {
    raw.prepare("INSERT INTO users (id,name,email,password_hash,role) VALUES (?,?,?,'h',?)").run(u.id, u.id, u.email, u.role);
  }
  raw.prepare("INSERT INTO support_tickets (id,user_id,subject,source) VALUES ('tkt_mine',?,'Print came out wrong','manual')").run(USERS.owner.id);
  raw.prepare("INSERT INTO support_tickets (id,user_id,subject,source) VALUES ('tkt_theirs',?,'Other ticket','manual')").run(USERS.stranger.id);

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
  const upload = (who: string, purpose: string, entityId: string) => {
    const form = new FormData();
    form.set('purpose', purpose);
    form.set('entity_id', entityId);
    form.set('file', new File([webp()], 'evidence.webp', { type: 'image/webp' }));
    return as(who, '/api/uploads', { method: 'POST', body: form });
  };
  return { raw, hono, as, postJson, upload, privateBucket, publicBucket };
}

const jsonOf = async (r: Response) => (await r.json()) as Record<string, never>;

test('a customer reply comes back as the row that was written — the client appends it, it does not re-fetch the thread', async () => {
  const h = harness();
  const res = await h.postJson('owner', '/api/support/tickets/tkt_mine/messages', { body: 'Any update?' });
  assert.equal(res.status, 200);
  const body = await jsonOf(res);
  const message = body.message as unknown as Record<string, unknown>;
  assert.ok(message, 'the response carries the message; a bare {success:true} is what forced the reload');

  const stored = h.raw.prepare('SELECT id, body, is_staff, created_at, kind, file_key FROM support_ticket_messages').get() as Record<string, unknown>;
  assert.equal(message.id, stored.id, 'the id in the response is the id in the database');
  assert.equal(message.created_at, stored.created_at, 'the timestamp is the stored one, not a second value the client cannot see');
  assert.equal(message.body, 'Any update?');
  assert.equal(message.is_staff, false);
  assert.equal(message.kind, 'text');
  assert.equal(message.file_url, null);
  assert.equal(body.ticket_state as unknown as string, 'waiting_staff', 'the list row is patched from this, instead of refetching the queue');
});

test('a staff reply comes back the same way, flagged as staff', async () => {
  const h = harness();
  const res = await h.postJson('admin', '/api/support/admin/tickets/tkt_mine/messages', { body: 'We are printing a replacement.' });
  assert.equal(res.status, 200);
  const body = await jsonOf(res);
  const message = body.message as unknown as Record<string, unknown>;
  const stored = h.raw.prepare('SELECT id, created_at, is_staff FROM support_ticket_messages').get() as Record<string, unknown>;
  assert.equal(message.id, stored.id);
  assert.equal(message.created_at, stored.created_at);
  assert.equal(message.is_staff, true);
  assert.equal(body.ticket_state as unknown as string, 'waiting_customer');
});

test('an empty reply is still refused — text or a file, never neither', async () => {
  const h = harness();
  const res = await h.postJson('owner', '/api/support/tickets/tkt_mine/messages', { body: '   ' });
  assert.equal(res.status, 400);
  assert.equal(h.raw.prepare('SELECT COUNT(*) AS n FROM support_ticket_messages').get()!.n, 0);
});

test('a ticket attachment is filed under the TICKET, stored private, and read back as a file url', async () => {
  const h = harness();
  const up = await h.upload('owner', 'support', 'tkt_mine');
  assert.equal(up.status, 200, JSON.stringify(await up.clone().json()));
  const uploaded = await jsonOf(up);
  const key = String(uploaded.key);
  assert.match(key, /^support\/tkt_mine\/attachments\/[a-f0-9]+\.webp$/, 'the key names the ticket, so access is one question');
  assert.equal(h.privateBucket.objects.has(key), true);
  assert.equal(h.publicBucket.objects.size, 0, 'a customer evidence photo is never written to the public bucket');

  const sent = await h.postJson('owner', '/api/support/tickets/tkt_mine/messages', { fileKey: key });
  assert.equal(sent.status, 200);
  const stored = h.raw.prepare('SELECT body, kind, file_key FROM support_ticket_messages').get() as Record<string, unknown>;
  assert.equal(stored.kind, 'image');
  assert.equal(stored.file_key, key);
  assert.equal(stored.body, '', 'an attachment-only message stores the empty string, never NULL');

  const thread = await jsonOf(await h.as('owner', '/api/support/tickets/tkt_mine'));
  const messages = thread.messages as unknown as Array<Record<string, unknown>>;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'image');
  assert.equal(messages[0].file_url, `/files/${key}`);
  assert.equal(messages[0].file_key, undefined, 'the raw key never ships — only the authorised url');

  const adminThread = await jsonOf(await h.as('admin', '/api/support/admin/tickets/tkt_mine'));
  const adminMessages = adminThread.messages as unknown as Array<Record<string, unknown>>;
  assert.equal(adminMessages[0].file_url, `/files/${key}`, 'the console sees the attachment it has to answer about');
});

test('a key belonging to someone else’s ticket cannot be stapled onto this one', async () => {
  const h = harness();
  const res = await h.postJson('owner', '/api/support/tickets/tkt_mine/messages', {
    fileKey: 'support/tkt_theirs/attachments/deadbeef.webp',
  });
  assert.equal(res.status, 400);
  assert.equal(h.raw.prepare('SELECT COUNT(*) AS n FROM support_ticket_messages').get()!.n, 0);
});

test('uploading to a ticket that is not yours is refused before a byte is stored', async () => {
  const h = harness();
  const res = await h.upload('stranger', 'support', 'tkt_mine');
  assert.equal(res.status, 403);
  assert.equal(h.privateBucket.objects.size, 0);
});

test('THE GATE: the ticket owner and staff may read the attachment; nobody else may, and an unknown private prefix is still a 404', async () => {
  const h = harness();
  const uploaded = await jsonOf(await h.upload('owner', 'support', 'tkt_mine'));
  const key = String(uploaded.key);

  assert.equal((await h.as('owner', `/files/${key}`)).status, 200);
  assert.equal((await h.as('admin', `/files/${key}`)).status, 200, 'an agent who cannot open the photo is shown an empty box mid-conversation');
  assert.equal((await h.as('stranger', `/files/${key}`)).status, 403, 'the whole reason the else-branch existed');
  assert.equal((await h.as('', `/files/${key}`)).status, 403, 'signed out reads nothing private');
  assert.equal(
    (await h.as('owner', '/files/kyc/u_owner/evidence/whatever.webp')).status,
    404,
    'adding a support branch opened support/ and nothing else'
  );
});
