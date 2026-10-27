/**
 * THE PROJECT HANDOFF COPIES (plan P1-06, acceptance 20 (part) and 13;
 * GAP-MAP conflict 5; docs/DECISIONS.md row 268) — through the real entry
 * door, the draft read and the migrations.
 *
 *   «اطلب طباعته» on a project makes a draft whose files are the request's
 *   OWN copies: new objects under `requests/<customer>/`, new `file_objects`
 *   rows carrying the post's sha256 and `purpose = 'request'`, and sources of
 *   kind `project_post` with `origin_id` = the post, `origin_ref` = the post
 *   file and `origin_hash` = the sha256. Each model is a part measured from it.
 *
 *   A later edit of the post — a file renamed, replaced with other bytes,
 *   deleted, the post itself deleted — changes nothing in the request: not its
 *   files, not their bytes, not their sha256, not its model hash.
 *
 *   A file that is not downloadable is never copied; a copy whose bytes are
 *   not what the post's ledger says is dropped (COPY_CHANGED) and leaves no
 *   object behind; a retry of a file already copied makes no second copy.
 *   A post the reader may not read answers ENTRY_NOT_FOUND and makes nothing,
 *   and so does a portfolio piece whose customer has not consented (pending)
 *   or declined: hidden from every public list, it is copied by nobody but
 *   its author.
 *   A file the live composer stored under the author's name WITHOUT its
 *   extension is copied under its stored type, and its bytes are still
 *   classified against that type.
 *   No projection below the owner carries `origin_*`, a sha256 or the author.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, count, get, json, MemoryBucket, post, row, stubApp, type Mount } from './fixtures/app';
import { world } from './fixtures/requestModelWorld';
import { marketplaceRoutes } from '../worker/routes/marketplace';
import { printRequestRoutes } from '../worker/routes/printRequests';
import { requestEntryRoutes } from '../worker/routes/requestEntries';
import { factsHashV3, projectModel, readRequestModel } from '../worker/lib/requestModel';

const mount: Mount = (a) => {
  a.route('/api/marketplace/print', printRequestRoutes);
  a.route('/api/marketplace/print', requestEntryRoutes);
  a.route('/api/marketplace', marketplaceRoutes);
};
const as = (raw: DatabaseSync, id: string, bucket: MemoryBucket) =>
  stubApp(asD1(raw), { id, role: 'customer', email: `${id}@x.co` }, mount, {
    env: { BUCKET: bucket, R2_PRIVATE: bucket, R2_PUBLIC: bucket },
  });

/** A binary STL cube of `mm`. */
function stl(mm: number): Uint8Array {
  const v = (i: number, j: number, k: number) => [i * mm, j * mm, k * mm];
  const p000 = v(0, 0, 0), p100 = v(1, 0, 0), p110 = v(1, 1, 0), p010 = v(0, 1, 0);
  const p001 = v(0, 0, 1), p101 = v(1, 0, 1), p111 = v(1, 1, 1), p011 = v(0, 1, 1);
  const tris = [
    [p000, p110, p100], [p000, p010, p110], [p001, p101, p111], [p001, p111, p011],
    [p000, p100, p101], [p000, p101, p001], [p010, p011, p111], [p010, p111, p110],
    [p000, p001, p011], [p000, p011, p010], [p100, p110, p111], [p100, p111, p101],
  ].map((t) => t.flat());
  const out = new Uint8Array(84 + tris.length * 50);
  const dv = new DataView(out.buffer);
  dv.setUint32(80, tris.length, true);
  let at = 84;
  for (const t of tris) {
    at += 12;
    for (let i = 0; i < 9; i++) { dv.setFloat32(at, t[i], true); at += 4; }
    at += 2;
  }
  return out;
}
const PNG = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
const PDF = new TextEncoder().encode('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** A published project by Ali (`owner`): two downloadable models, a PDF he did not tick, a cover picture. */
function project(raw: DatabaseSync, bucket: MemoryBucket, opts: { id?: string; state?: string; visibility?: string; badLedger?: boolean } = {}) {
  const id = opts.id ?? 'post1';
  const a = stl(20), b = stl(30);
  raw.prepare(
    `INSERT INTO community_posts (id,author_id,kind,title,body,state,visibility,tags,published_at)
     VALUES (?, 'owner', 'project', 'Cable clip set', 'Two clips', ?, ?, '[]', '2026-10-01T00:00:00.000Z')`
  ).run(id, opts.state ?? 'published', opts.visibility ?? 'public');
  const files: Array<[string, string, string, Uint8Array, number, string]> = [
    [`${id}_a`, 'model', 'clip-a.stl', a, 1, 'model/stl'],
    [`${id}_b`, 'model', 'clip-b.stl', b, 1, 'model/stl'],
    [`${id}_c`, 'document', 'notes.pdf', PDF, 0, 'application/pdf'],
  ];
  files.forEach(([fid, kind, name, bytes, downloadable, mime], i) => {
    const key = `users/owner/private/${fid}.${name.split('.').pop()}`;
    void bucket.put(key, bytes, { httpMetadata: { contentType: mime } });
    raw.prepare(
      `INSERT INTO community_post_files (id, post_id, file_key, kind, name, bytes, mime, downloadable, position) VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(fid, id, key, kind, name, bytes.byteLength, mime, downloadable, i);
    raw.prepare(
      `INSERT INTO file_objects (object_key, visibility, domain, owner_id, entity_id, mime_type, byte_size, original_name, sha256, purpose)
       VALUES (?, 'private', 'users', 'owner', ?, ?, ?, ?, ?, 'post')`
    ).run(key, id, mime, bytes.byteLength, name, opts.badLedger && i === 0 ? 'f'.repeat(64) : sha(bytes));
  });
  const cover = `community/owner/${id}cover.png`;
  void bucket.put(cover, PNG, { httpMetadata: { contentType: 'image/png' } });
  raw.prepare(`INSERT INTO community_post_media (id, post_id, kind, media_key, sort_order) VALUES (?, ?, 'image', ?, 0)`).run(`${id}_m`, id, cover);
  return { id, a, b };
}

async function enter(raw: DatabaseSync, bucket: MemoryBucket, postId: string, user = 'buyer') {
  const res = await post(as(raw, user, bucket), '/api/marketplace/print/requests', { entry: { kind: 'project', post_id: postId } });
  return { status: res.status, body: await json(res) };
}

test('the project handoff copies each downloadable file and the cover into the request, by sha256, as project_post sources', async () => {
  const raw = world();
  const bucket = new MemoryBucket();
  const p = project(raw, bucket);
  const born = await enter(raw, bucket, p.id);
  assert.equal(born.status, 201, JSON.stringify(born.body));
  const id = born.body.request_id as string;
  assert.equal(born.body.replayed, false);
  assert.equal(born.body.copied.files, 3, 'two models and the cover');
  assert.deepEqual(born.body.copied.skipped, []);

  const files = raw.prepare('SELECT id, file_key, file_name, kind FROM community_request_files WHERE request_id = ? ORDER BY created_at, id').all(id) as Array<Record<string, string>>;
  assert.equal(files.length, 3);
  assert.ok(files.every((f) => f.file_key.startsWith('requests/buyer/')), 'new objects, under the customer');
  assert.ok(!files.some((f) => f.file_name === 'notes.pdf'), 'a file the author did not make downloadable is never copied');
  for (const f of files) {
    const ledger = row<{ sha256: string; purpose: string; owner_id: string; entity_id: string }>(raw, 'SELECT sha256, purpose, owner_id, entity_id FROM file_objects WHERE object_key = ?', f.file_key);
    assert.ok(ledger, `a ledger row for ${f.file_name}`);
    assert.equal(ledger!.purpose, 'request');
    assert.equal(ledger!.owner_id, 'buyer');
    assert.equal(ledger!.entity_id, id);
    assert.equal(ledger!.sha256, sha(bucket.objects.get(f.file_key)!.bytes), 'the digest of the copy itself');
  }
  const sources = raw.prepare(`SELECT kind, file_id, sha256, origin_id, origin_ref, origin_hash, origin_meta FROM community_request_sources WHERE request_id = ? ORDER BY position`).all(id) as Array<Record<string, string>>;
  assert.equal(sources.length, 3);
  assert.ok(sources.every((s) => s.kind === 'project_post' && s.origin_id === p.id && s.origin_hash === s.sha256 && /^[0-9a-f]{64}$/.test(s.sha256)));
  assert.deepEqual(sources.map((s) => s.origin_ref).slice(0, 2), [`${p.id}_a`, `${p.id}_b`]);
  assert.equal(sources[0].sha256, sha(p.a), 'the post sha256 is the copy sha256');
  assert.deepEqual(JSON.parse(sources[0].origin_meta), { title: 'Cable clip set' }, 'the post title only — never its author');

  // Each model is a part measured from its copy; the first model is the main source.
  const model = born.body.draft.model;
  assert.equal(model.parts.length, 2);
  assert.deepEqual(model.parts.map((x: { measured_file_id: string }) => x.measured_file_id), files.filter((f) => f.kind === 'model').map((f) => f.id));
  assert.equal(model.sources.filter((x: { is_primary: boolean }) => x.is_primary).length, 1);
  assert.equal(born.body.draft.title, 'Cable clip set');
  // Each copy is a download, counted and logged.
  assert.equal(row<{ downloads: number }>(raw, 'SELECT downloads FROM community_post_files WHERE id = ?', `${p.id}_a`)!.downloads, 1);
  assert.equal(count(raw, `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'community.post_file_downloaded'`) >= 2, true);

  // Replay: an untouched draft from the same project answers again; nothing is copied twice.
  const again = await enter(raw, bucket, p.id);
  assert.equal(again.status, 200);
  assert.equal(again.body.request_id, id);
  assert.equal(again.body.replayed, true);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_request_files WHERE request_id = ?', id), 3);
});

test('acceptance 20 (part): editing, replacing, deleting the post files and the post never changes the request', async () => {
  const raw = world();
  const bucket = new MemoryBucket();
  const p = project(raw, bucket);
  const born = await enter(raw, bucket, p.id);
  const id = born.body.request_id as string;
  const before = await readRequestModel(asD1(raw) as never, id);
  const hashBefore = await factsHashV3(before!);
  const filesBefore = JSON.stringify(raw.prepare('SELECT id, file_key, file_name, size_bytes FROM community_request_files WHERE request_id = ? ORDER BY id').all(id));
  const sourcesBefore = JSON.stringify(raw.prepare('SELECT id, sha256, origin_hash FROM community_request_sources WHERE request_id = ? ORDER BY id').all(id));
  const keys = (raw.prepare('SELECT file_key FROM community_request_files WHERE request_id = ?').all(id) as Array<{ file_key: string }>).map((x) => x.file_key);
  const bytesBefore = keys.map((k) => sha(bucket.objects.get(k)!.bytes));

  // The author renames one file, replaces the bytes of the other, deletes the PDF, then the whole post.
  raw.prepare(`UPDATE community_post_files SET name = 'renamed.stl' WHERE id = ?`).run(`${p.id}_a`);
  const bKey = (row<{ file_key: string }>(raw, 'SELECT file_key FROM community_post_files WHERE id = ?', `${p.id}_b`))!.file_key;
  await bucket.put(bKey, stl(99));
  raw.prepare('DELETE FROM community_post_files WHERE id = ?').run(`${p.id}_c`);
  raw.prepare('DELETE FROM community_posts WHERE id = ?').run(p.id);

  const after = await readRequestModel(asD1(raw) as never, id);
  assert.equal(await factsHashV3(after!), hashBefore, 'the model hash');
  assert.equal(JSON.stringify(raw.prepare('SELECT id, file_key, file_name, size_bytes FROM community_request_files WHERE request_id = ? ORDER BY id').all(id)), filesBefore, 'the files');
  assert.equal(JSON.stringify(raw.prepare('SELECT id, sha256, origin_hash FROM community_request_sources WHERE request_id = ? ORDER BY id').all(id)), sourcesBefore, 'the sha256 of every source');
  assert.deepEqual(keys.map((k) => sha(bucket.objects.get(k)!.bytes)), bytesBefore, 'the bytes, read back');
  // And the customer still reads the draft whole.
  const res = await get(as(raw, 'buyer', bucket), `/api/marketplace/print/requests/${id}/draft`);
  assert.equal(res.status, 200);
  assert.equal((await json(res)).draft.files.length, 3);
});

test('a copy whose bytes are not what the post ledger says is dropped (COPY_CHANGED) and leaves no object', async () => {
  const raw = world();
  const bucket = new MemoryBucket();
  const p = project(raw, bucket, { id: 'post9', badLedger: true });
  const objectsBefore = [...bucket.objects.keys()].filter((k) => k.startsWith('requests/')).length;
  const born = await enter(raw, bucket, p.id);
  assert.equal(born.status, 201);
  const skipped = born.body.copied.skipped as Array<{ code: string; post_file_id: string }>;
  assert.deepEqual(skipped.map((s) => [s.code, s.post_file_id]), [['COPY_CHANGED', 'post9_a']]);
  const id = born.body.request_id as string;
  const keys = (raw.prepare('SELECT file_key FROM community_request_files WHERE request_id = ?').all(id) as Array<{ file_key: string }>).map((x) => x.file_key);
  assert.equal(keys.length, 2);
  const requestObjects = [...bucket.objects.keys()].filter((k) => k.startsWith('requests/'));
  assert.equal(requestObjects.length - objectsBefore, 2, 'the refused copy left no object');
  assert.equal(count(raw, `SELECT COUNT(*) AS n FROM file_objects WHERE owner_id = 'buyer' AND object_key LIKE 'requests/%'`), 2, 'nor a ledger row');
});

test('acceptance 13 (server): a retry copies a skipped file once, and never copies a held file again', async () => {
  const raw = world();
  const bucket = new MemoryBucket();
  const p = project(raw, bucket, { id: 'post7', badLedger: true });
  const born = await enter(raw, bucket, p.id);
  const id = born.body.request_id as string;
  // The author's ledger is put right; the customer presses «أعد المحاولة» for the skipped file — and, by mistake, a held one.
  raw.prepare(`UPDATE file_objects SET sha256 = ? WHERE object_key = (SELECT file_key FROM community_post_files WHERE id = 'post7_a')`).run(sha(p.a));
  const retry = async () => {
    const res = await post(as(raw, 'buyer', bucket), `/api/marketplace/print/requests/${id}/copy-from-project`, { post_id: p.id, file_ids: ['post7_a', 'post7_b'] });
    return { status: res.status, body: await json(res) };
  };
  const first = await retry();
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.copied.files, 1);
  assert.deepEqual(first.body.copied.already, ['post7_b']);
  const second = await retry();
  assert.equal(second.body.copied.files, 0, 'nothing copied twice');
  assert.deepEqual(second.body.copied.already.sort(), ['post7_a', 'post7_b']);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_request_files WHERE request_id = ?', id), 3);
  assert.equal(count(raw, `SELECT COUNT(*) AS n FROM file_objects WHERE owner_id = 'buyer' AND object_key LIKE 'requests/%'`), 3);
  // Another project's files cannot be pulled through this request.
  const other = project(raw, bucket, { id: 'post8' });
  const res = await post(as(raw, 'buyer', bucket), `/api/marketplace/print/requests/${id}/copy-from-project`, { post_id: other.id });
  assert.equal(res.status, 404);
  assert.equal((await json(res)).code, 'ENTRY_NOT_FOUND');
});

test('a project the reader may not read answers ENTRY_NOT_FOUND and makes nothing', async () => {
  const raw = world();
  const bucket = new MemoryBucket();
  project(raw, bucket, { id: 'pdraft', state: 'draft' });
  project(raw, bucket, { id: 'pprivate', visibility: 'private' });
  project(raw, bucket, { id: 'phidden' });
  raw.prepare(`UPDATE community_posts SET admin_hidden_at = '2026-10-02T00:00:00.000Z' WHERE id = 'phidden'`).run();
  project(raw, bucket, { id: 'pblocked' });
  raw.prepare(`INSERT INTO user_blocks (user_id, blocked_id) VALUES ('owner', 'buyer')`).run();
  for (const id of ['pdraft', 'pprivate', 'phidden', 'pblocked', 'nope']) {
    const r = await enter(raw, bucket, id);
    assert.equal(r.status, 404, id);
    assert.equal(r.body.code, 'ENTRY_NOT_FOUND', id);
  }
  assert.equal(count(raw, `SELECT COUNT(*) AS n FROM community_requests WHERE customer_id = 'buyer'`), 0);
});

test('a portfolio piece whose customer has not consented or declined is copied by nobody but its author (POST_PUBLIC_SQL)', async () => {
  const raw = world();
  const bucket = new MemoryBucket();
  project(raw, bucket, { id: 'pdeclined' });
  project(raw, bucket, { id: 'ppending' });
  raw.prepare(`UPDATE community_posts SET consent_status = 'declined' WHERE id = 'pdeclined'`).run();
  raw.prepare(`UPDATE community_posts SET consent_status = 'pending' WHERE id = 'ppending'`).run();
  for (const id of ['pdeclined', 'ppending']) {
    const r = await enter(raw, bucket, id);
    assert.equal(r.status, 404, id);
    assert.equal(r.body.code, 'ENTRY_NOT_FOUND', id);
  }
  assert.equal(count(raw, `SELECT COUNT(*) AS n FROM community_requests WHERE customer_id = 'buyer'`), 0);
  assert.equal([...bucket.objects.keys()].filter((k) => k.startsWith('requests/')).length, 0, 'no copy under requests/');
  // The author still starts a request from their own piece.
  const mine = await enter(raw, bucket, 'pdeclined', 'owner');
  assert.equal(mine.status, 201, JSON.stringify(mine.body));

  // Declined after a request was made from it: a retry copies nothing more.
  const p = project(raw, bucket, { id: 'plater', badLedger: true });
  const born = await enter(raw, bucket, p.id);
  assert.equal(born.status, 201);
  raw.prepare(`UPDATE file_objects SET sha256 = ? WHERE object_key = (SELECT file_key FROM community_post_files WHERE id = 'plater_a')`).run(sha(p.a));
  raw.prepare(`UPDATE community_posts SET consent_status = 'declined' WHERE id = 'plater'`).run();
  const retry = await post(as(raw, 'buyer', bucket), `/api/marketplace/print/requests/${born.body.request_id}/copy-from-project`, { post_id: p.id });
  assert.equal(retry.status, 404);
  assert.equal((await json(retry)).code, 'ENTRY_NOT_FOUND');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_request_files WHERE request_id = ?', born.body.request_id), 2, 'the skipped file stays uncopied');
});

test('a file the composer stored without its extension is copied under its stored type, and its bytes still decide', async () => {
  const raw = world();
  const bucket = new MemoryBucket();
  const id = 'pcomposer';
  raw.prepare(
    `INSERT INTO community_posts (id,author_id,kind,title,body,state,visibility,tags,published_at)
     VALUES (?, 'owner', 'project', 'Cable clip set', 'Two clips', 'published', 'public', '[]', '2026-10-01T00:00:00.000Z')`
  ).run(id);
  // As projects/FileComposer.tsx stores them: «Cable clip (large).stl» → «Cable clip (large)».
  const a = stl(20), b = stl(30);
  const files: Array<[string, string, string, Uint8Array, string]> = [
    [`${id}_a`, 'Cable clip (large)', `users/owner/private/${id}_a.stl`, a, 'model/stl'],
    // A suffix that is not a file type, on a key without one: the stored MIME names it.
    [`${id}_b`, 'Bracket v1.2', `users/owner/private/${id}_b`, b, 'model/stl'],
    // The stored type says STL, the bytes are a PDF: refused, as an upload would be.
    [`${id}_c`, 'Not a model', `users/owner/private/${id}_c.stl`, PDF, 'model/stl'],
  ];
  files.forEach(([fid, name, key, bytes, mime], i) => {
    void bucket.put(key, bytes, { httpMetadata: { contentType: mime } });
    raw.prepare(
      `INSERT INTO community_post_files (id, post_id, file_key, kind, name, bytes, mime, downloadable, position) VALUES (?,?,?,?,?,?,?,1,?)`
    ).run(fid, id, key, 'model', name, bytes.byteLength, mime, i);
    raw.prepare(
      `INSERT INTO file_objects (object_key, visibility, domain, owner_id, entity_id, mime_type, byte_size, original_name, sha256, purpose)
       VALUES (?, 'private', 'users', 'owner', ?, ?, ?, ?, ?, 'post')`
    ).run(key, id, mime, bytes.byteLength, name, sha(bytes));
  });
  const born = await enter(raw, bucket, id);
  assert.equal(born.status, 201, JSON.stringify(born.body));
  assert.equal(born.body.copied.files, 2);
  assert.deepEqual(born.body.copied.skipped, [{ name: 'Not a model.stl', code: 'COPY_KIND', post_file_id: `${id}_c` }]);
  const rid = born.body.request_id as string;
  const stored = raw.prepare('SELECT file_name, kind, file_key FROM community_request_files WHERE request_id = ? ORDER BY created_at, id').all(rid) as Array<Record<string, string>>;
  assert.deepEqual(stored.map((f) => f.file_name).sort(), ['Bracket v1.2.stl', 'Cable clip (large).stl']);
  assert.ok(stored.every((f) => f.kind === 'model' && f.file_key.startsWith('requests/buyer/') && f.file_key.endsWith('.stl')));
  const sources = raw.prepare(`SELECT origin_ref, sha256 FROM community_request_sources WHERE request_id = ? ORDER BY position`).all(rid) as Array<Record<string, string>>;
  assert.deepEqual(sources.map((x) => [x.origin_ref, x.sha256]), [[`${id}_a`, sha(a)], [`${id}_b`, sha(b)]]);
  // Each is a part, named as the author named it.
  const parts = born.body.draft.model.parts as Array<{ name: string; measured_file_id: string }>;
  assert.deepEqual(parts.map((x) => x.name), ['Cable clip (large)', 'Bracket v1.2']);
  assert.ok(parts.every((x) => typeof x.measured_file_id === 'string' && x.measured_file_id !== ''));
});

test('below the owner, no projection of the copied request carries origin_*, a sha256 or the author', async () => {
  const raw = world();
  const bucket = new MemoryBucket();
  const p = project(raw, bucket);
  const born = await enter(raw, bucket, p.id);
  const read = await readRequestModel(asD1(raw) as never, born.body.request_id as string);
  for (const audience of ['public', 'merchant', 'accepted'] as const) {
    const text = JSON.stringify(projectModel(read!, audience));
    assert.ok(!/origin_|sha256/.test(text), `${audience}: no provenance`);
    assert.ok(!/owner|Ali/.test(text), `${audience}: no author`);
  }
  const owner = JSON.stringify(projectModel(read!, 'owner'));
  assert.ok(owner.includes(p.id) && owner.includes('origin_hash'), 'the owner reads where the files came from');
});
