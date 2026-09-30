/**
 * RESUMABLE UPLOAD SESSIONS (docs/COMMUNITY_ECOSYSTEM.md §9.4, Phase 4a) —
 * against the real migrations, the real routes and an in-memory R2 double
 * with multipart uploads (tests/fixtures/app.ts `MemoryBucket`).
 *
 * What is proven here: a session is its owner's at every step; a part over
 * the chunk is refused; a complete with a missing part is refused and stores
 * nothing; a checksum mismatch deletes the object and leaves no ledger row; a
 * ZIP with 5 000 entries or a 100× ratio is refused before it is a file; a
 * forged `.stl` that is a PNG is classified by its bytes on both doors; the
 * quota counts live objects AND open sessions, and is asked again on complete;
 * the admin's limit change is audited and
 * applied to the very next session without the financial scope; the cron
 * sweep aborts an expired session.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';
import type { Env } from '../worker/lib/types';
import {
  asD1, count, ctx, freshDb, get, json, memoryBucket, patch, post, row, stubApp, type App, type MemoryBucket, type StubUser,
} from './fixtures/app';
import type { DatabaseSync } from 'node:sqlite';
import { uploadRoutes } from '../worker/routes/uploads';
import { sweepExpiredUploadSessions, uploadSessionRoutes } from '../worker/routes/uploadSessions';
import { adminCommunityRoutes } from '../worker/routes/adminCommunity';
import { getSetting } from '../worker/lib/settings';

const U1: StubUser = { id: 'u1', role: 'customer', email: 'u1@x.co' };
const U2: StubUser = { id: 'u2', role: 'customer', email: 'u2@x.co' };
const AIDE: StubUser = { id: 'aide', role: 'admin', email: 'aide@x.co', admin_scope: 'assistant' };

const MiB = 1024 * 1024;
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function seed(): DatabaseSync {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('u1','U','u1@x.co','h','customer'), ('u2','V','u2@x.co','h','customer'), ('aide','A','aide@x.co','h','admin');
    INSERT INTO community_requests (id,customer_id,title,state) VALUES ('req1','u1','A gear','open');
    INSERT INTO chats (id) VALUES ('chat_1');
    INSERT INTO chat_participants (chat_id,user_id) VALUES ('chat_1','u1');
  `);
  return raw;
}

const app = (raw: DatabaseSync, user: StubUser | null, bucket: MemoryBucket): App =>
  stubApp(
    asD1(raw),
    user,
    (a) => {
      a.route('/api/uploads', uploadRoutes);
      a.route('/api/uploads/sessions', uploadSessionRoutes);
      a.route('/api/admin/community', adminCommunityRoutes);
    },
    { env: { BUCKET: bucket, R2_PUBLIC: bucket, R2_PRIVATE: bucket } }
  );

const raw = (a: App, method: string, path: string, body?: BodyInit) =>
  a.request(path, { method, headers: { 'content-type': 'application/octet-stream', 'CF-Connecting-IP': '1.2.3.4' }, body }, undefined, ctx);
const putPart = (a: App, id: string, n: number, bytes: Uint8Array) => raw(a, 'PUT', `/api/uploads/sessions/${id}/parts/${n}`, bytes as unknown as BodyInit);
const complete = (a: App, id: string) => post(a, `/api/uploads/sessions/${id}/complete`, {});
const del = (a: App, id: string) => raw(a, 'DELETE', `/api/uploads/sessions/${id}`);

async function open(a: App, body: Record<string, unknown>) {
  const res = await post(a, '/api/uploads/sessions', body);
  return { status: res.status, body: await json(res) };
}

/** Send every part of `bytes` under `chunk`, in order. */
async function sendAll(a: App, id: string, bytes: Uint8Array, chunk: number) {
  for (let n = 1, off = 0; off < bytes.length; n++, off += chunk) {
    const res = await putPart(a, id, n, bytes.subarray(off, Math.min(off + chunk, bytes.length)));
    assert.equal(res.status, 200, `part ${n}: ${await res.text()}`);
  }
}

// ------------------------------------------------------------ sample bytes

const pdf = (size: number) => {
  const out = new Uint8Array(size);
  out.set(strToU8('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'));
  for (let i = 32; i < size; i++) out[i] = i & 0xff;
  return out;
};
const png = (size = 256) => {
  const out = new Uint8Array(size);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return out;
};
const gif = (size = 64) => {
  const out = new Uint8Array(size);
  out.set(strToU8('GIF89a'));
  out[6] = 2; out[8] = 2; // 2×2
  return out;
};
/** A closed binary-STL cube of 12 triangles. */
function stlCube(): Uint8Array {
  const v = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const out = new Uint8Array(84 + 50 * f.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(80, f.length, true);
  f.forEach((tri, i) => {
    let at = 84 + i * 50 + 12;
    for (const idx of tri) for (const c of v[idx]) { dv.setFloat32(at, c, true); at += 4; }
  });
  return out;
}
const THREE_MF_XML = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <resources><object id="1" type="model"><mesh>
  <vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/><vertex x="0" y="0" z="10"/></vertices>
  <triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="1" v2="2" v3="3"/><triangle v1="0" v2="3" v3="2"/></triangles>
 </mesh></object></resources>
 <build><item objectid="1"/></build>
</model>`;
const good3mf = () => zipSync({ '[Content_Types].xml': strToU8('<Types/>'), '3D/3dmodel.model': strToU8(THREE_MF_XML) });

// ------------------------------------------------------------ the tests

test('a session is its owner’s at every step — 404 UPLOAD_SESSION_NOT_FOUND for anyone else', async () => {
  const db = seed();
  const bucket = memoryBucket();
  const mine = app(db, U1, bucket);
  const theirs = app(db, U2, bucket);
  const bytes = stlCube();
  const created = await open(mine, { purpose: 'post', file_name: 'cube.stl', bytes: bytes.length, mime: 'model/stl', sha256: sha(bytes) });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.session_id as string;
  assert.equal(created.body.chunk_bytes, 8 * MiB, 'the default part size');

  for (const [label, res] of [
    ['get', await get(theirs, `/api/uploads/sessions/${id}`)],
    ['put', await putPart(theirs, id, 1, bytes)],
    ['complete', await complete(theirs, id)],
    ['delete', await del(theirs, id)],
  ] as const) {
    assert.equal(res.status, 404, label);
    assert.equal((await json(res)).code, 'UPLOAD_SESSION_NOT_FOUND', label);
  }
  const still = await json(await get(mine, `/api/uploads/sessions/${id}`));
  assert.equal(still.state, 'open');
  assert.deepEqual(still.received, []);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM upload_sessions WHERE state = 'open'"), 1, 'the stranger changed nothing');

  const gone = await del(mine, id);
  assert.equal(gone.status, 200);
  assert.equal([...bucket.uploads.values()][0].aborted, true, 'the multipart upload was aborted on the bucket');
  assert.equal(row<{ state: string }>(db, 'SELECT state FROM upload_sessions WHERE id = ?', id)!.state, 'aborted');
});

test('a part over the chunk, a part number past the end, and a complete with a missing part are refused; the full set lands', async () => {
  const db = seed();
  db.exec(`INSERT INTO admin_settings (key, value) VALUES ('uploadLimits', '{"chunk_mb":5}')`);
  const bucket = memoryBucket();
  const a = app(db, U1, bucket);
  const bytes = pdf(6 * MiB);
  const created = await open(a, { purpose: 'post', file_name: 'sheet.pdf', bytes: bytes.length, mime: 'application/pdf', sha256: sha(bytes) });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.session_id as string;
  const chunk = created.body.chunk_bytes as number;
  assert.equal(chunk, 5 * MiB);
  assert.equal(created.body.parts_total, 2);

  const big = await putPart(a, id, 1, new Uint8Array(chunk + 1));
  assert.equal(big.status, 400);
  assert.equal((await json(big)).code, 'UPLOAD_PART_TOO_LARGE');
  const past = await putPart(a, id, 3, bytes.subarray(0, 10));
  assert.equal(past.status, 400);

  assert.equal((await putPart(a, id, 1, bytes.subarray(0, chunk))).status, 200);
  const early = await complete(a, id);
  assert.equal(early.status, 400);
  const refusal = await json(early);
  assert.equal(refusal.code, 'UPLOAD_INCOMPLETE');
  assert.deepEqual(refusal.details.missing, [2]);
  assert.equal(bucket.objects.size, 0, 'nothing assembled');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM file_objects'), 0);

  const resume = await json(await get(a, `/api/uploads/sessions/${id}`));
  assert.deepEqual(resume.received, [1]);
  assert.equal(resume.bytes_so_far, chunk);

  // The same part again is idempotent; then the last, smaller part.
  assert.equal((await putPart(a, id, 1, bytes.subarray(0, chunk))).status, 200);
  const last = await putPart(a, id, 2, bytes.subarray(chunk));
  assert.equal(last.status, 200);
  assert.deepEqual((await json(last)).received, [1, 2]);

  const done = await complete(a, id);
  const body = await json(done);
  assert.equal(done.status, 200, JSON.stringify(body));
  assert.equal(body.mime, 'application/pdf');
  assert.equal(body.bytes, bytes.length);
  assert.equal(body.sha256, sha(bytes));
  assert.match(body.key, /^users\/u1\/post-files\/[a-z0-9]+\.pdf$/, 'a document on a post is private, under the author');
  assert.equal(body.url, `/files/${body.key}`);
  const stored = bucket.objects.get(body.key)!;
  assert.equal(stored.bytes.length, bytes.length);
  assert.equal(sha(stored.bytes), sha(bytes), 'the parts were assembled in order');
  const ledger = row<{ sha256: string; purpose: string; byte_size: number; visibility: string }>(db, 'SELECT sha256, purpose, byte_size, visibility FROM file_objects WHERE object_key = ?', body.key)!;
  assert.deepEqual(ledger, { sha256: sha(bytes), purpose: 'post', byte_size: bytes.length, visibility: 'private' });
  assert.equal(row<{ state: string }>(db, 'SELECT state FROM upload_sessions WHERE id = ?', id)!.state, 'completed');
  assert.equal((await complete(a, id)).status, 404, 'a completed session cannot be completed twice');
});

test('a checksum mismatch deletes the object and leaves no ledger row', async () => {
  const db = seed();
  const bucket = memoryBucket();
  const a = app(db, U1, bucket);
  const bytes = pdf(4096);
  const created = await open(a, { purpose: 'post', file_name: 'x.pdf', bytes: bytes.length, mime: 'application/pdf', sha256: sha(pdf(4097)) });
  assert.equal(created.status, 201);
  const id = created.body.session_id as string;
  await sendAll(a, id, bytes, created.body.chunk_bytes as number);
  const res = await complete(a, id);
  assert.equal(res.status, 400);
  const body = await json(res);
  assert.equal(body.code, 'CHECKSUM_MISMATCH');
  assert.equal(body.details.actual, sha(bytes));
  assert.equal(bucket.objects.size, 0, 'the assembled object was deleted');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM file_objects'), 0);
  assert.equal(row<{ state: string }>(db, 'SELECT state FROM upload_sessions WHERE id = ?', id)!.state, 'aborted');
  assert.equal((await get(a, `/api/uploads/sessions/${id}`)).status, 404, 'nothing to resume');
});

test('a ZIP with 5 000 entries, and one with a 100× ratio, are refused before they are files; a real 3MF is measured', async () => {
  const db = seed();
  const bucket = memoryBucket();
  const a = app(db, U1, bucket);

  const many = zipSync(Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`e${i}.txt`, new Uint8Array([1])])));
  const bomb = zipSync({ '3D/3dmodel.model': new Uint8Array(20 * MiB) }, { level: 9 });
  assert.ok(bomb.length < 200 * 1024, `the bomb is small on the wire (${bomb.length} bytes)`);

  for (const [name, bytes, expect] of [
    ['many.3mf', many, (d: Record<string, unknown>) => assert.equal(d.entries, 5000)],
    ['bomb.3mf', bomb, (d: Record<string, unknown>) => assert.ok((d.uncompressed as number) >= 20 * MiB, JSON.stringify(d))],
  ] as const) {
    const created = await open(a, { purpose: 'post', file_name: name, bytes: bytes.length, mime: 'model/3mf', sha256: sha(bytes) });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.session_id as string;
    await sendAll(a, id, bytes, created.body.chunk_bytes as number);
    const res = await complete(a, id);
    assert.equal(res.status, 400, name);
    const body = await json(res);
    assert.equal(body.code, 'ARCHIVE_TOO_DEEP', name);
    expect(body.details as Record<string, unknown>);
  }
  assert.equal(bucket.objects.size, 0, 'neither archive was stored');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM file_objects'), 0);

  const good = good3mf();
  const created = await open(a, { purpose: 'post', file_name: 'tetra.3mf', bytes: good.length, mime: 'model/3mf', sha256: sha(good) });
  assert.equal(created.status, 201);
  await sendAll(a, created.body.session_id as string, good, created.body.chunk_bytes as number);
  const done = await complete(a, created.body.session_id as string);
  const body = await json(done);
  assert.equal(done.status, 200, JSON.stringify(body));
  assert.equal(body.mime, 'model/3mf');
  assert.equal(body.analysis?.format, '3mf');
  assert.equal(body.analysis?.measured, true, 'the bounded unzip still reads a real model');
  assert.equal(body.analysis?.triangle_count, 4);
});

test('a forged .stl that is a PNG is classified by its bytes — refused by the session, stored as a picture by the whole-body route', async () => {
  const db = seed();
  const bucket = memoryBucket();
  const a = app(db, U1, bucket);

  const fake = png();
  const created = await open(a, { purpose: 'post', file_name: 'cube.stl', bytes: fake.length, mime: 'model/stl', sha256: sha(fake) });
  assert.equal(created.status, 201);
  const id = created.body.session_id as string;
  await sendAll(a, id, fake, created.body.chunk_bytes as number);
  const res = await complete(a, id);
  assert.equal(res.status, 400);
  const body = await json(res);
  assert.equal(body.code, 'UPLOAD_KIND_NOT_ALLOWED');
  assert.deepEqual(body.details, { declared: 'stl', detected: 'image/png' });
  assert.equal(bucket.objects.size, 0);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM file_objects'), 0);

  // A real cube under its own name is a model, measured.
  const cube = stlCube();
  const ok = await open(a, { purpose: 'post', file_name: 'cube.stl', bytes: cube.length, mime: 'model/stl', sha256: sha(cube) });
  await sendAll(a, ok.body.session_id as string, cube, ok.body.chunk_bytes as number);
  const done = await json(await complete(a, ok.body.session_id as string));
  assert.equal(done.mime, 'model/stl');
  assert.equal(done.analysis?.triangle_count, 12);
  assert.equal(done.analysis?.volume_mm3, 1000);

  // The whole-body route never trusted the name either: a GIF called .stl is a GIF.
  const form = new FormData();
  form.append('purpose', 'post');
  form.append('file', new File([gif() as unknown as BlobPart], 'cube.stl', { type: 'model/stl' }));
  const simple = await a.request('/api/uploads', { method: 'POST', headers: { 'CF-Connecting-IP': '1.2.3.4' }, body: form }, undefined, ctx);
  const stored = await json(simple);
  assert.equal(simple.status, 200, JSON.stringify(stored));
  assert.equal(stored.mime, 'image/gif');
  assert.match(stored.key, /\.gif$/);
  assert.equal(row<{ purpose: string }>(db, 'SELECT purpose FROM file_objects WHERE object_key = ?', stored.key)!.purpose, 'post', 'the whole-body route records the purpose');
});

test('the quota counts only live objects, and the admin sets it without the financial scope (audited)', async () => {
  const db = seed();
  const bucket = memoryBucket();
  db.exec(`
    INSERT INTO file_objects (object_key, visibility, domain, owner_id, entity_id, mime_type, byte_size, purpose, deleted_at) VALUES
      ('users/u1/post-files/live.stl', 'private', 'users', 'u1', 'u1', 'model/stl', ${800 * MiB}, 'post', NULL),
      ('users/u1/post-files/gone.stl', 'private', 'users', 'u1', 'u1', 'model/stl', ${900 * MiB}, 'post', '2026-01-01T00:00:00.000Z'),
      ('users/u1/post-files/other.stl', 'private', 'users', 'u1', 'u1', 'model/stl', ${900 * MiB}, 'product_file', NULL)
  `);
  const admin = app(db, AIDE, bucket);
  const set = await patch(admin, '/api/admin/community/settings', { uploadQuotas: { post_gb: 1 } });
  assert.equal(set.status, 200, JSON.stringify(await json(set)));
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'admin.upload_limits' AND actor_id = 'aide'"), 1);

  const a = app(db, U1, bucket);
  const digest = sha(new Uint8Array(1));
  const over = await open(a, { purpose: 'post', file_name: 'big.stl', bytes: 250 * MiB, mime: 'model/stl', sha256: digest });
  assert.equal(over.status, 400);
  assert.equal(over.body.code, 'UPLOAD_QUOTA_EXCEEDED');
  assert.equal(over.body.details.used_bytes, 800 * MiB, 'the deleted 900 MiB and the other purpose do not count');
  assert.equal(over.body.details.limit_bytes, 1024 * MiB);
  const fits = await open(a, { purpose: 'post', file_name: 'big.stl', bytes: 200 * MiB, mime: 'model/stl', sha256: digest });
  assert.equal(fits.status, 201, JSON.stringify(fits.body));
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM upload_sessions WHERE state = 'open'"), 1);
});

test('OPEN SESSIONS COUNT towards the quota — sessions opened in turn cannot each pass the same cap — and complete asks again before the ledger row', async () => {
  const db = seed();
  const bucket = memoryBucket();
  // 0.00001 GiB = 10 737 bytes.
  db.exec(`INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('uploadQuotas', '{"post_gb":0.00001}')`);
  const a = app(db, U1, bucket);
  const six = pdf(6000);
  const four = pdf(4000);
  const declare = (name: string, bytes: Uint8Array) => ({ purpose: 'post', file_name: name, bytes: bytes.length, mime: 'application/pdf', sha256: sha(bytes) });

  const first = await open(a, declare('a.pdf', six));
  assert.equal(first.status, 201, JSON.stringify(first.body));
  // The probe of the review: a second 6 000-byte session, opened before the first landed, used to pass too.
  const second = await open(a, declare('b.pdf', six));
  assert.equal(second.status, 400);
  assert.equal(second.body.code, 'UPLOAD_QUOTA_EXCEEDED');
  assert.equal(second.body.details.used_bytes, 6000, 'the open session is counted before it lands');
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM upload_sessions WHERE owner_id = 'u1' AND state = 'open'"), 1);
  // Another owner's open session is not this owner's; another purpose is not this purpose.
  assert.equal((await open(app(db, U2, bucket), declare('c.pdf', six))).status, 201);
  assert.equal((await open(app(db, U1, bucket), { ...declare('d.stl', six), purpose: 'request', entity_id: 'req1' })).status, 201);
  // Under the cap together: a 4 000-byte session beside the open 6 000 one.
  const third = await open(a, declare('e.pdf', four));
  assert.equal(third.status, 201, JSON.stringify(third.body));

  // Meanwhile the owner's live bytes grew (a whole-body upload landing): the two open sessions no longer both fit.
  db.exec(`INSERT INTO file_objects (object_key, visibility, domain, owner_id, entity_id, mime_type, byte_size, purpose)
           VALUES ('users/u1/posts/photo.jpg', 'public', 'users', 'u1', 'u1', 'image/jpeg', 2000, 'post')`);
  await sendAll(a, first.body.session_id, six, first.body.chunk_bytes);
  const refused = await complete(a, first.body.session_id);
  assert.equal(refused.status, 400, await refused.clone().text());
  const body = await json(refused);
  assert.equal(body.code, 'UPLOAD_QUOTA_EXCEEDED');
  assert.equal(body.details.used_bytes, 6000, 'the other open session (4 000) and the landed picture (2 000), never this session\'s own bytes');
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM file_objects WHERE owner_id = 'u1' AND purpose = 'post' AND mime_type = 'application/pdf'"), 0, 'no ledger row');
  assert.equal(row<{ state: string }>(db, 'SELECT state FROM upload_sessions WHERE id = ?', first.body.session_id)?.state, 'aborted');
  assert.equal([...bucket.objects.keys()].filter((k) => k.endsWith('.pdf')).length, 0, 'the assembled object was deleted');

  // The refused session no longer counts: the 4 000-byte one lands (2 000 + 4 000 ≤ 10 737).
  await sendAll(a, third.body.session_id, four, third.body.chunk_bytes);
  const landed = await complete(a, third.body.session_id);
  assert.equal(landed.status, 200, await landed.clone().text());
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM file_objects WHERE owner_id = 'u1' AND purpose = 'post' AND deleted_at IS NULL"), 2);
  // And the next ask sees exactly what is live: 6 000 used, 4 000 more fits, 6 000 more does not.
  assert.equal((await open(a, declare('f.pdf', four))).status, 201);
  const over = await open(a, declare('g.pdf', six));
  assert.equal(over.status, 400);
  assert.equal(over.body.details.used_bytes, 10000);
});

test('the admin’s limit change is audited, applied to the next session, bounded, and leaves the fee keys behind their scope', async () => {
  const db = seed();
  const bucket = memoryBucket();
  const admin = app(db, AIDE, bucket);

  const fee = await patch(admin, '/api/admin/community/settings', { communityFeeStorePercentX100: 0 });
  assert.equal(fee.status, 403, 'an assistant still cannot move the commission');
  assert.equal((await json(fee)).code, 'FINANCIAL_SCOPE_REQUIRED');

  const set = await patch(admin, '/api/admin/community/settings', { uploadLimits: { model_mb: 1, chunk_mb: 16 } });
  const applied = await json(set);
  assert.equal(set.status, 200, JSON.stringify(applied));
  assert.equal(applied.settings.uploadLimits.model_mb, 1);
  assert.equal(applied.settings.uploadLimits.chunk_mb, 16);
  assert.equal(applied.settings.uploadLimits.video_mb, 100, 'untouched ceilings keep their defaults');
  const audit = row<{ detail: string; target: string }>(db, "SELECT detail, target FROM audit_log WHERE action = 'admin.upload_limits'")!;
  assert.equal(audit.target, 'uploads');
  assert.equal(JSON.parse(audit.detail).after.uploadLimits.model_mb, 1);
  assert.equal(JSON.parse(audit.detail).before.uploadLimits.model_mb, 300);

  const bad = await patch(admin, '/api/admin/community/settings', { uploadLimits: { chunk_mb: 2 } });
  assert.equal(bad.status, 400, 'R2 refuses a non-final part under 5 MiB, so the form may not set one');

  const shown = await getSetting(asD1(db), 'uploadLimits');
  assert.equal(shown.model_mb, 1);
  assert.equal(shown.chunk_mb, 16, 'the refused patch changed nothing');
  assert.equal((await getSetting(asD1(db), 'uploadQuotas')).post_gb, 2);

  const a = app(db, U1, bucket);
  const digest = sha(new Uint8Array(1));
  const tooBig = await open(a, { purpose: 'post', file_name: 'big.stl', bytes: 2 * MiB, mime: 'model/stl', sha256: digest });
  assert.equal(tooBig.status, 400);
  assert.equal(tooBig.body.code, 'UPLOAD_TOO_LARGE');
  assert.equal(tooBig.body.details.limit_bytes, MiB);
  const fits = await open(a, { purpose: 'post', file_name: 'small.stl', bytes: MiB, mime: 'model/stl', sha256: digest });
  assert.equal(fits.status, 201);
  assert.equal(fits.body.chunk_bytes, 16 * MiB, 'the new part size applies to the next session');

  // The whole-body route reads the same ceilings.
  db.exec(`UPDATE admin_settings SET value = '{"image_mb":1}' WHERE key = 'uploadLimits'`);
  const form = new FormData();
  form.append('purpose', 'post');
  form.append('file', new File([gif(MiB + 1024) as unknown as BlobPart], 'big.gif', { type: 'image/gif' }));
  const simple = await a.request('/api/uploads', { method: 'POST', headers: { 'CF-Connecting-IP': '1.2.3.4' }, body: form }, undefined, ctx);
  assert.equal(simple.status, 400);
  assert.equal((await json(simple)).code, 'UPLOAD_TOO_LARGE');
});

test('purposes file under their entity: a stranger’s request is 404, a non-participant’s chat is 403, and neither answer carries a key', async () => {
  const db = seed();
  const bucket = memoryBucket();
  const bytes = pdf(2048);
  const declare = (purpose: string, entity: string) => ({ purpose, entity_id: entity, file_name: 'spec.pdf', bytes: bytes.length, mime: 'application/pdf', sha256: sha(bytes) });

  const stranger = app(db, U2, bucket);
  assert.equal((await open(stranger, declare('request', 'req1'))).status, 404);
  assert.equal((await open(stranger, declare('chat', 'chat_1'))).status, 403);
  assert.equal((await open(stranger, declare('product_file', ''))).body.code, 'STORE_REQUIRED');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM upload_sessions'), 0);

  const owner = app(db, U1, bucket);
  const kinds = await open(owner, { purpose: 'community', file_name: 'x.pdf', bytes: 10, mime: 'application/pdf', sha256: sha(bytes) });
  assert.equal(kinds.body.code, 'UPLOAD_KIND_NOT_ALLOWED', 'store media takes pictures and clips only');
  const zip = await open(owner, { purpose: 'post', file_name: 'x.zip', bytes: 10, mime: 'application/zip', sha256: sha(bytes) });
  assert.equal(zip.body.code, 'UPLOAD_KIND_NOT_ALLOWED', 'a bare archive is not admitted yet');

  const req = await open(owner, declare('request', 'req1'));
  assert.equal(req.status, 201, JSON.stringify(req.body));
  await sendAll(owner, req.body.session_id as string, bytes, req.body.chunk_bytes as number);
  const reqDone = await json(await complete(owner, req.body.session_id as string));
  assert.equal(reqDone.key, undefined, 'a request answers with its file row, never a key');
  assert.equal(reqDone.file.kind, 'document');
  assert.equal(reqDone.file.size_bytes, bytes.length);
  const reqRow = row<{ file_key: string; request_id: string }>(db, 'SELECT file_key, request_id FROM community_request_files WHERE id = ?', reqDone.file.id)!;
  assert.equal(reqRow.request_id, 'req1');
  assert.match(reqRow.file_key, /^requests\/u1\/files\//);

  const chat = await open(owner, declare('chat', 'chat_1'));
  assert.equal(chat.status, 201);
  await sendAll(owner, chat.body.session_id as string, bytes, chat.body.chunk_bytes as number);
  const chatDone = await json(await complete(owner, chat.body.session_id as string));
  assert.equal(chatDone.key, undefined);
  assert.match(chatDone.url, /^\/files\/chat\/chat_1\/files\//, 'a PDF in a conversation sits in the thread’s files folder');
});

test('the cron sweep aborts expired open sessions and expires their rows, at most the batch per run', async () => {
  const db = seed();
  const bucket = memoryBucket();
  const a = app(db, U1, bucket);
  const digest = sha(new Uint8Array(1));
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const created = await open(a, { purpose: 'post', file_name: `m${i}.stl`, bytes: 1000, mime: 'model/stl', sha256: digest });
    assert.equal(created.status, 201);
    ids.push(created.body.session_id as string);
  }
  db.exec(`UPDATE upload_sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id IN ('${ids[0]}', '${ids[1]}')`);
  const env = { DB: asD1(db), BUCKET: bucket } as unknown as Env;

  const first = await sweepExpiredUploadSessions(env, undefined, 1);
  assert.equal(first.expired, 1, 'bounded per run');
  const second = await sweepExpiredUploadSessions(env);
  assert.equal(second.expired, 1);
  const third = await sweepExpiredUploadSessions(env);
  assert.equal(third.expired, 0, 'idempotent');

  const uploads = [...bucket.uploads.values()];
  assert.deepEqual(uploads.map((u) => u.aborted), [true, true, false]);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM upload_sessions WHERE state = 'expired'"), 2);
  assert.equal((await get(a, `/api/uploads/sessions/${ids[0]}`)).status, 404, 'an expired session is nothing to resume');
  assert.equal((await get(a, `/api/uploads/sessions/${ids[2]}`)).status, 200, 'the live one is untouched');

  // Closed rows are deleted a week later, never sooner.
  db.exec(`UPDATE upload_sessions SET updated_at = '2000-01-02T00:00:00.000Z' WHERE id = '${ids[0]}'`);
  const housekeeping = await sweepExpiredUploadSessions(env);
  assert.equal(housekeeping.deleted, 1);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM upload_sessions'), 2);
});
