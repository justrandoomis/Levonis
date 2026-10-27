/**
 * THE REQUEST EDITOR'S DOORS ON THE SERVER, AND THE SERVER CRITIQUES OF P1-06
 * THEY CLOSE (docs/handoff/p1-06-design-critiques.md, server list; plan B0b;
 * docs/DECISIONS.md row 268) — through the real routes and migrations.
 *
 *   the blank entry    a draft born empty and version 3, signed in, behind
 *                      the gate, on the main site only (critique 13)
 *   the draft save     holds what was typed so far (an empty title, a
 *                      cleared description); a stale window is refused
 *                      DRAFT_CHANGED, and the comparison is INSIDE the write:
 *                      a save landing between the read and the write still
 *                      loses (critique 11), even one stamped in the same
 *                      millisecond: the guard asks the row count, not the
 *                      clock
 *   the publish        asks the title and the description of a draft born
 *                      empty
 *   provenance         a link pointed elsewhere no longer carries origin_*
 *                      (critique 14)
 *   a lost answer      a request upload whose «complete» landed: the session
 *                      read returns the stored file, so a retry makes no
 *                      second copy (critique 10)
 *   copies             only from the reader's own project or one the public
 *                      may read: not an admin's reach into a hidden post, not
 *                      an unpublished one (critique 9)
 *   the budget switch  the chat sheet's read rule no longer covers a direct
 *                      request the editor made, so the editor's switch alone
 *                      decides what its store reads; a repeat does not carry
 *                      the editor's entry mark
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, count, ctx, get, json, MERCHANT_HOST, MemoryBucket, post, put, row, stubApp, type Mount } from './fixtures/app';
import { world } from './fixtures/requestModelWorld';
import { marketplaceRoutes } from '../worker/routes/marketplace';
import { printRequestRoutes } from '../worker/routes/printRequests';
import { requestEntryRoutes } from '../worker/routes/requestEntries';
import { uploadSessionRoutes } from '../worker/routes/uploadSessions';
import { ENTRY_NOTE_PREFIX, madeInChatForOneStore } from '../worker/lib/requestBudget';

const mount: Mount = (a) => {
  a.route('/api/marketplace/print', printRequestRoutes);
  a.route('/api/marketplace/print', requestEntryRoutes);
  a.route('/api/marketplace', marketplaceRoutes);
  a.route('/api/uploads/sessions', uploadSessionRoutes);
};
const as = (
  raw: DatabaseSync,
  id: string | null,
  opts: { host?: string; bucket?: MemoryBucket; role?: 'customer' | 'admin'; db?: D1Database } = {}
) =>
  stubApp(opts.db ?? asD1(raw), id ? { id, role: opts.role ?? 'customer', email: `${id}@x.co` } : null, mount, {
    host: opts.host,
    env: opts.bucket ? { BUCKET: opts.bucket, R2_PRIVATE: opts.bucket, R2_PUBLIC: opts.bucket } : {},
  });
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

async function blank(raw: DatabaseSync, user = 'buyer', opts: { host?: string } = {}) {
  const res = await post(as(raw, user, opts), '/api/marketplace/print/requests', { entry: { kind: 'blank' } });
  return { status: res.status, body: await json(res) };
}

test('the blank entry: a version-3 draft born empty, for its customer alone, on the main site only', async () => {
  const raw = world();
  const born = await blank(raw);
  assert.equal(born.status, 201, JSON.stringify(born.body));
  const id = born.body.request_id as string;
  const draft = born.body.draft as Record<string, unknown>;
  assert.equal(draft.state, 'draft');
  assert.equal(draft.title, '');
  assert.equal(draft.description, '');
  assert.equal(draft.schema_version, 3);
  assert.equal(draft.direct, null);
  assert.equal(typeof draft.updated_at, 'string');
  assert.ok((draft.updated_at as string).length > 10);
  // Nobody else reads it, and the board does not list it.
  assert.equal((await get(as(raw, 'owner'), `/api/marketplace/requests/${id}`)).status, 404);
  const board = await json(await get(as(raw, 'stranger'), '/api/marketplace/requests'));
  assert.ok(!(board.requests as Array<{ id: string }>).some((x) => x.id === id));

  // Critique 13: a store subdomain carries the session cookie; the door is the main site's.
  const onStore = await blank(raw, 'buyer', { host: MERCHANT_HOST });
  assert.equal(onStore.status, 404);
  // Signed in, and behind the gate.
  assert.equal((await post(as(raw, null), '/api/marketplace/print/requests', {})).status, 401);
  raw.prepare(`UPDATE admin_settings SET value = '{"open":false}' WHERE key = 'communityGate'`).run();
  const closed = await blank(raw);
  assert.equal(closed.status, 503);
  assert.equal(closed.body.code, 'COMMUNITY_CLOSED');
  assert.equal(count(raw, `SELECT COUNT(*) AS n FROM community_requests WHERE customer_id = 'buyer'`), 1);

  // An unknown way in is refused, and makes nothing.
  raw.prepare(`UPDATE admin_settings SET value = '{"open":true}' WHERE key = 'communityGate'`).run();
  const odd = await post(as(raw, 'buyer'), '/api/marketplace/print/requests', { entry: { kind: 'teleport' } });
  assert.equal(odd.status, 400);
  assert.equal(count(raw, `SELECT COUNT(*) AS n FROM community_requests WHERE customer_id = 'buyer'`), 1);
});

test('the draft save keeps what was typed so far, and the publish asks the text a born-empty draft lacks', async () => {
  const raw = world();
  const id = (await blank(raw)).body.request_id as string;
  const saveAs = (body: object) => put(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}/draft`, body);

  const typed = await saveAs({ schema_version: 3, title: 'A b', description: 'short' });
  assert.equal(typed.status, 200, JSON.stringify(await json(typed.clone())));
  // A cleared description is saved as cleared: the old text never comes back.
  assert.equal((await saveAs({ schema_version: 3, description: '' })).status, 200);
  assert.equal(row<{ description: string }>(raw, 'SELECT description FROM community_requests WHERE id = ?', id)!.description, '');
  // Above the ceilings is still refused.
  assert.equal((await saveAs({ schema_version: 3, title: 'x'.repeat(141) })).status, 400);

  const publish = (body: object) => post(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}/publish`, body);
  const noTitle = await publish({ schema_version: 3 });
  assert.equal(noTitle.status, 400);
  assert.equal((await json(noTitle)).code, 'REQUEST_TITLE_REQUIRED');
  await saveAs({ schema_version: 3, title: 'A shelf bracket' });
  const noDescription = await publish({ schema_version: 3 });
  assert.equal(noDescription.status, 400);
  assert.equal((await json(noDescription)).code, 'REQUEST_DESCRIPTION_REQUIRED');
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_requests WHERE id = ?', id)!.state, 'draft');
});

test('critique 11: a stale window is refused DRAFT_CHANGED, and the comparison is inside the write itself', async () => {
  const raw = world();
  const born = await blank(raw);
  const id = born.body.request_id as string;
  const stamp = (born.body.draft as { updated_at: string }).updated_at;

  // Window A saves with the stamp it holds: accepted, and a new stamp comes back.
  const a = await put(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}/draft`, {
    schema_version: 3, title: 'From window A', expected_updated_at: stamp,
  });
  const aBody = await json(a);
  assert.equal(a.status, 200, JSON.stringify(aBody));
  const next = aBody.draft.updated_at as string;
  assert.notEqual(next, stamp);

  // Window B still holds the old stamp: refused, with the draft as it now is.
  const b = await put(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}/draft`, {
    schema_version: 3, title: 'From window B', expected_updated_at: stamp,
  });
  const bBody = await json(b);
  assert.equal(b.status, 409);
  assert.equal(bBody.code, 'DRAFT_CHANGED');
  assert.equal(bBody.details.draft.title, 'From window A');

  // THE RACE: window C reads the right stamp, and another save lands after
  // that read and before C's write. The write itself compares the stamp, so
  // C loses and the other save stands.
  const d1 = asD1(raw);
  const batch = d1.batch.bind(d1);
  let armed = true;
  (d1 as unknown as { batch: typeof d1.batch }).batch = (async (stmts: D1PreparedStatement[]) => {
    if (armed) {
      armed = false;
      raw.prepare(`UPDATE community_requests SET title = 'Saved in between', updated_at = '2099-01-01T00:00:00.000Z' WHERE id = ?`).run(id);
    }
    return batch(stmts);
  }) as typeof d1.batch;
  const c = await put(as(raw, 'buyer', { db: d1 }), `/api/marketplace/print/requests/${id}/draft`, {
    schema_version: 3, title: 'From window C', expected_updated_at: next,
  });
  const cBody = await json(c);
  assert.equal(c.status, 409, JSON.stringify(cBody));
  assert.equal(cBody.code, 'DRAFT_CHANGED');
  const now = row<{ title: string; updated_at: string; state: string }>(raw, 'SELECT title, updated_at, state FROM community_requests WHERE id = ?', id)!;
  assert.deepEqual({ ...now }, { title: 'Saved in between', updated_at: '2099-01-01T00:00:00.000Z', state: 'draft' });

  // A save without the stamp (an older client, the page-leave flush): the last save wins.
  const flush = await put(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}/draft`, { schema_version: 3, title: 'On leave' });
  assert.equal(flush.status, 200);
  assert.equal(row<{ title: string }>(raw, 'SELECT title FROM community_requests WHERE id = ?', id)!.title, 'On leave');
});

test('critique 11: two saves stamped in the same millisecond — the one that lost the row is refused, not mixed in', async () => {
  const raw = world();
  const born = await blank(raw);
  const id = born.body.request_id as string;
  const stamp = (born.body.draft as { updated_at: string }).updated_at;
  const quantity = () => row<{ quantity: number }>(raw, 'SELECT quantity FROM community_request_parts WHERE request_id = ? ORDER BY position LIMIT 1', id)!.quantity;
  const partsBefore = quantity();

  // Both windows hold `stamp`. Window A's save lands between window B's read
  // and B's write, and both are stamped T: the row then carries B's own new
  // stamp, which a guard comparing stamps would take for B's write.
  const T = '2031-03-03T03:03:03.033Z';
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...a: unknown[]) {
      if (a.length === 0) super(T);
      else super(...(a as [string]));
    }
    static now() {
      return RealDate.parse(T);
    }
  }
  const d1 = asD1(raw);
  const batch = d1.batch.bind(d1);
  let armed = true;
  (d1 as unknown as { batch: typeof d1.batch }).batch = (async (stmts: D1PreparedStatement[]) => {
    if (armed) {
      armed = false;
      raw.prepare(`UPDATE community_requests SET title = 'Window A', updated_at = ? WHERE id = ? AND updated_at = ?`).run(T, id, stamp);
    }
    return batch(stmts);
  }) as typeof d1.batch;
  (globalThis as { Date: DateConstructor }).Date = FrozenDate as unknown as DateConstructor;
  let b: Response;
  try {
    b = await put(as(raw, 'buyer', { db: d1 }), `/api/marketplace/print/requests/${id}/draft`, {
      schema_version: 3, title: 'Window B', expected_updated_at: stamp,
      parts: [{ process: 'unsure', quantity: 7, materials: [{ material_id: 'unsure', colors: [{ mode: 'any' }] }] }],
    });
  } finally {
    (globalThis as { Date: DateConstructor }).Date = RealDate;
  }
  const bBody = await json(b);
  assert.equal(b.status, 409, JSON.stringify(bBody));
  assert.equal(bBody.code, 'DRAFT_CHANGED');
  assert.equal(bBody.details.draft.title, 'Window A', 'B is handed the draft as A left it');
  // Nothing of B was written: not its title, not its part.
  const now = row<{ title: string; updated_at: string }>(raw, 'SELECT title, updated_at FROM community_requests WHERE id = ?', id)!;
  assert.deepEqual({ ...now }, { title: 'Window A', updated_at: T });
  assert.equal(quantity(), partsBefore, 'no mixed draft: B’s part quantity is not in it');
  // B, still holding the stamp it started from, cannot overwrite A either.
  const again = await put(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}/draft`, {
    schema_version: 3, title: 'Window B again', expected_updated_at: stamp,
  });
  assert.equal(again.status, 409);
  assert.equal(row<{ title: string }>(raw, 'SELECT title FROM community_requests WHERE id = ?', id)!.title, 'Window A');
});

test('critique 14: a link pointed elsewhere no longer carries the provenance of a handoff', async () => {
  const raw = world();
  const id = (await blank(raw)).body.request_id as string;
  const saveAs = (body: object) => put(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}/draft`, body);
  const first = await saveAs({
    schema_version: 3,
    sources: [{ id: 'tmp_l', kind: 'link', url: 'https://www.printables.com/model/12345-clip', note: '', is_primary: true }],
    parts: [{ process: 'unsure', quantity: 1, source_ids: ['tmp_l'], materials: [{ material_id: 'unsure', colors: [{ mode: 'any' }] }] }],
  });
  assert.equal(first.status, 200, JSON.stringify(await json(first.clone())));
  const src = row<{ id: string }>(raw, `SELECT id FROM community_request_sources WHERE request_id = ? AND kind = 'link'`, id)!;
  // A server handoff wrote where it came from.
  raw.prepare(`UPDATE community_request_sources SET origin_id = 'prd_1', origin_ref = 'product', origin_meta = '{"title":"Clip"}' WHERE id = ?`).run(src.id);

  // The same URL again keeps it.
  const same = await saveAs({
    schema_version: 3,
    sources: [{ id: src.id, kind: 'link', url: 'https://www.printables.com/model/12345-clip', note: 'same', is_primary: true }],
  });
  assert.equal(same.status, 200, JSON.stringify(await json(same.clone())));
  assert.equal(row<{ origin_id: string }>(raw, 'SELECT origin_id FROM community_request_sources WHERE id = ?', src.id)!.origin_id, 'prd_1');

  // Pointed elsewhere: the provenance goes.
  const moved = await saveAs({
    schema_version: 3,
    sources: [{ id: src.id, kind: 'link', url: 'https://www.printables.com/model/99999-other', note: '', is_primary: true }],
  });
  assert.equal(moved.status, 200, JSON.stringify(await json(moved.clone())));
  const after = row<Record<string, unknown>>(raw, 'SELECT origin_id, origin_ref, origin_hash, origin_meta FROM community_request_sources WHERE id = ?', src.id)!;
  assert.equal(after.origin_id, '');
  assert.equal(after.origin_ref, '');
  assert.equal(after.origin_hash, '');
  assert.deepEqual(JSON.parse(String(after.origin_meta || '{}')), {});
});

/** A PNG head with a 2x2 IHDR. */
const png = (size = 256) => {
  const out = new Uint8Array(size);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 2, 8, 6, 0, 0, 0]);
  return out;
};

test('critique 10: a request session whose complete landed answers with its stored file, so a retry makes no second copy', async () => {
  const raw = world();
  const bucket = new MemoryBucket();
  const id = (await blank(raw)).body.request_id as string;
  const app = as(raw, 'buyer', { bucket });
  const bytes = png();
  const opened = await post(app, '/api/uploads/sessions', {
    purpose: 'request', entity_id: id, file_name: 'ref.png', bytes: bytes.length, mime: '', sha256: sha(bytes),
  });
  const session = await json(opened);
  assert.equal(opened.status, 201, JSON.stringify(session));
  const part = await app.request(
    `/api/uploads/sessions/${session.session_id}/parts/1`,
    { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'CF-Connecting-IP': '1.2.3.4' }, body: bytes as unknown as BodyInit },
    undefined,
    ctx
  );
  assert.equal(part.status, 200, await part.text());
  const done = await post(app, `/api/uploads/sessions/${session.session_id}/complete`, {});
  const doneBody = await json(done);
  assert.equal(done.status, 200, JSON.stringify(doneBody));

  // The answer to «complete» was lost: the browser asks the session again.
  const again = await json(await get(app, `/api/uploads/sessions/${session.session_id}`));
  assert.equal(again.state, 'completed');
  assert.equal(again.file.id, doneBody.file.id);
  assert.equal(again.file.file_name, doneBody.file.file_name);
  assert.equal(again.sha256, sha(bytes));
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_request_files WHERE request_id = ?', id), 1);
  // Another account's session is nobody's to read.
  assert.equal((await get(as(raw, 'stranger', { bucket }), `/api/uploads/sessions/${session.session_id}`)).status, 404);
});

/** A project post by `owner` with one public cover picture. */
function coverPost(raw: DatabaseSync, bucket: MemoryBucket, id: string, opts: { state?: string; hidden?: boolean } = {}) {
  raw.prepare(
    `INSERT INTO community_posts (id,author_id,kind,title,body,state,visibility,tags,published_at,admin_hidden_at)
     VALUES (?, 'owner', 'project', 'Desk lamp', 'A lamp', ?, 'public', '[]', '2026-10-01T00:00:00.000Z', ?)`
  ).run(id, opts.state ?? 'published', opts.hidden ? '2026-10-02T00:00:00.000Z' : null);
  const key = `community/owner/${id}cover.png`;
  void bucket.put(key, png(), { httpMetadata: { contentType: 'image/png' } });
  raw.prepare(`INSERT INTO community_post_media (id, post_id, kind, media_key, sort_order) VALUES (?, ?, 'image', ?, 0)`).run(`${id}_m`, id, key);
}

test('critique 9: a copy comes only from the reader’s own project or one the public may read', async () => {
  const raw = world();
  const bucket = new MemoryBucket();
  coverPost(raw, bucket, 'pub');
  coverPost(raw, bucket, 'hidden', { hidden: true });
  coverPost(raw, bucket, 'unpublished', { state: 'draft' });
  const enter = (user: string, postId: string, role: 'customer' | 'admin' = 'customer') =>
    post(as(raw, user, { bucket, role }), '/api/marketplace/print/requests', { entry: { kind: 'project', post_id: postId } });

  // An admin reads every post, but copies none it could not read as the public.
  for (const p of ['hidden', 'unpublished']) {
    const res = await enter('admin1', p, 'admin');
    assert.equal(res.status, 404, p);
    assert.equal((await json(res)).code, 'ENTRY_NOT_FOUND');
  }
  assert.equal(count(raw, `SELECT COUNT(*) AS n FROM community_requests WHERE customer_id = 'admin1'`), 0);
  // The author copies from their own unpublished project; a buyer from a published one.
  assert.equal((await enter('owner', 'unpublished')).status, 201);
  const pub = await enter('buyer', 'pub');
  const body = await json(pub);
  assert.equal(pub.status, 201, JSON.stringify(body));
  assert.equal(body.copied.files, 1);
});

test('the chat sheet read rule does not cover a direct request the editor made; a repeat drops the entry mark', async () => {
  const chatRow = { visibility: 'direct', created_by: 'customer', origin_chat_id: 'chat_1', notes: '' };
  assert.equal(madeInChatForOneStore(chatRow), true, 'the chat sheet stores notes = ""');
  assert.equal(madeInChatForOneStore({ ...chatRow, notes: undefined }), true, 'a reader that does not name notes keeps the rule');
  assert.equal(madeInChatForOneStore({ ...chatRow, notes: `${ENTRY_NOTE_PREFIX}store:m1` }), false);
  assert.equal(madeInChatForOneStore({ ...chatRow, notes: `${ENTRY_NOTE_PREFIX}product:prd_1` }), false);

  const raw = world();
  const res = await post(as(raw, 'buyer'), '/api/marketplace/print/requests', { entry: { kind: 'store', merchant_id: 'm1' } });
  const id = (await json(res)).request_id as string;
  assert.equal(row<{ notes: string }>(raw, 'SELECT notes FROM community_requests WHERE id = ?', id)!.notes, `${ENTRY_NOTE_PREFIX}store:m1`);
  const repeat = await post(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}/repeat`, {});
  const rBody = await json(repeat);
  assert.equal(repeat.status, 201, JSON.stringify(rBody));
  const copy = row<{ notes: string; visibility: string }>(raw, 'SELECT notes, visibility FROM community_requests WHERE id = ?', rBody.request_id ?? rBody.id)!;
  assert.deepEqual({ ...copy }, { notes: '', visibility: 'public' });
});
