/**
 * POST ATTACHMENTS (0157; docs/COMMUNITY_ECOSYSTEM.md §9.4 "Post attachments",
 * "The shared viewer") over the real routes:
 *
 *   · a project carries at most 3 files, each the author's own PRIVATE upload
 *     (purpose post|community in the ledger), a model or a document — a
 *     stranger's key, a public key or a picture is refused;
 *   · the page lists files as names and sizes; the keys reach the author only;
 *   · a viewer link on a PUBLIC post mints for a guest, bound to their session;
 *     on a draft only for whoever may read it; archiving or taking the post
 *     private revokes every link (the viewer answers 404);
 *   · the original downloads only when the author ticked `downloadable` (or is
 *     the author), signed in, as an attachment, counted.
 *
 * Run: node --import tsx --test tests/postFiles.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, post, get, patch, json, count, row, hasColumn, type StubUser, type Mount } from './fixtures/app';
import { communityPostRoutes } from '../worker/routes/communityPosts';
import { printRequestRoutes } from '../worker/routes/printRequests';

const SARA: StubUser = { id: 'sara', role: 'customer', email: 'sara@x.co' };
const EVE: StubUser = { id: 'eve', role: 'customer', email: 'eve@x.co' };

const mount: Mount = (a) => {
  a.route('/api/community', communityPostRoutes);
  a.route('/api/marketplace/print', printRequestRoutes);
};

class MemoryBucket {
  readonly objects = new Map<string, Uint8Array>();
  async put(key: string, value: Uint8Array | ArrayBuffer) {
    this.objects.set(key, value instanceof Uint8Array ? value : new Uint8Array(value));
  }
  async head(key: string) {
    const v = this.objects.get(key);
    return v ? ({ key, size: v.byteLength } as unknown as R2Object) : null;
  }
  async get(key: string) {
    const v = this.objects.get(key);
    if (!v) return null;
    const copy = v.slice();
    return { key, size: v.byteLength, body: new Blob([copy as unknown as BlobPart]).stream(), httpEtag: `"${key}"`, arrayBuffer: async () => copy.buffer };
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

function binaryStl(): Uint8Array {
  const b = new Uint8Array(84 + 50);
  const v = new DataView(b.buffer);
  v.setUint32(80, 1, true);
  [0, 0, 1, 0, 0, 0, 10, 0, 0, 0, 10, 0].forEach((f, i) => v.setFloat32(84 + i * 4, f, true));
  return b;
}

const STL = 'users/sara/post-files/dragon.stl';
const PDF = 'users/sara/post-files/guide.pdf';
const STL2 = 'users/sara/post-files/second.stl';
const STL3 = 'users/sara/post-files/third.stl';
const PIC_PRIVATE = 'users/sara/post-files/photo.webp';
const EVE_STL = 'users/eve/post-files/eve.stl';
/** Sara's own upload through the store-media door: PUBLIC, purpose `community` — never a post file. */
const COMMUNITY_PUBLIC = 'merchants/sara/public/clip.stl';

function seed() {
  const raw = freshDb();
  const purpose = hasColumn(raw, 'file_objects', 'purpose');
  const obj = (key: string, owner: string, mime: string, bytes: number, visibility = 'private', p = 'post') =>
    purpose
      ? `('${key}','${visibility}','users','${owner}','${mime}',${bytes},'${p}')`
      : `('${key}','${visibility}','users','${owner}','${mime}',${bytes})`;
  const cols = purpose ? '(object_key,visibility,domain,owner_id,mime_type,byte_size,purpose)' : '(object_key,visibility,domain,owner_id,mime_type,byte_size)';
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,username) VALUES
      ('sara','Sara Kareem','sara@x.co','h','customer','sara'),
      ('eve','Eve','eve@x.co','h','customer','eve');
    INSERT INTO file_objects ${cols} VALUES
      ${obj('users/sara/posts/a1.webp', 'sara', 'image/webp', 1000, 'public')},
      ${obj(STL, 'sara', 'model/stl', 134)},
      ${obj(PDF, 'sara', 'application/pdf', 15)},
      ${obj(STL2, 'sara', 'model/stl', 134)},
      ${obj(STL3, 'sara', 'model/stl', 134)},
      ${obj(PIC_PRIVATE, 'sara', 'image/webp', 500)},
      ${obj(EVE_STL, 'eve', 'model/stl', 134)},
      ${obj(COMMUNITY_PUBLIC, 'sara', 'model/stl', 134, 'public', 'community')};
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}');
  `);
  const bucket = new MemoryBucket();
  void bucket.put(STL, binaryStl());
  void bucket.put(STL2, binaryStl());
  void bucket.put(PDF, new TextEncoder().encode('%PDF-1.4\n%fake\n'));
  return { raw, bucket };
}

const as = (raw: DatabaseSync, bucket: MemoryBucket, user: StubUser | null) => stubApp(asD1(raw), user, mount, { env: { BUCKET: bucket } });
const UA = { 'User-Agent': 'LevonisTest/1.0' };

const PROJECT = {
  title: 'Articulated dragon',
  body: 'Printed in two colours.',
  kind: 'project',
  media: [{ key: 'users/sara/posts/a1.webp', kind: 'image', width: 1200, height: 900 }],
  files: [{ file_key: STL, name: 'Dragon body', downloadable: true }, { file_key: PDF, name: 'Assembly guide' }],
};

async function draft(raw: DatabaseSync, bucket: MemoryBucket, body: Record<string, unknown> = PROJECT): Promise<string> {
  const made = await post(as(raw, bucket, SARA), '/api/community/posts', body);
  assert.equal(made.status, 201, JSON.stringify(await json(made.clone())));
  return (await json(made)).post.id as string;
}
async function published(raw: DatabaseSync, bucket: MemoryBucket): Promise<string> {
  const id = await draft(raw, bucket);
  const pub = await post(as(raw, bucket, SARA), `/api/community/posts/${id}/publish`);
  assert.equal(pub.status, 200, JSON.stringify(await json(pub.clone())));
  return id;
}
const files = async (raw: DatabaseSync, bucket: MemoryBucket, who: StubUser | null, id: string) =>
  (await json(await get(as(raw, bucket, who), `/api/community/posts/${id}`))).post.files as Array<Record<string, unknown>>;

// ================================================================= attaching

test('a project carries its files: the author sees the keys, a reader the names; a model gets its mesh', async () => {
  const { raw, bucket } = seed();
  const id = await published(raw, bucket);
  const mine = await files(raw, bucket, SARA, id);
  assert.deepEqual(
    mine.map((f) => [f.name, f.kind, f.downloadable, f.has_preview, f.key]),
    [['Dragon body', 'model', true, true, STL], ['Assembly guide', 'document', false, false, PDF]]
  );
  const theirs = await files(raw, bucket, EVE, id);
  assert.deepEqual(theirs.map((f) => f.key), [undefined, undefined], 'the keys reach the author only (D11)');
  assert.equal(theirs[0].bytes, 134);
  const text = await (await get(as(raw, bucket, null), `/api/community/posts/${id}`)).text();
  assert.ok(!text.includes('post-files/') && !text.includes('post-previews/'), 'no private key in a guest\'s page');
  const fid = String(mine[0].id);
  assert.ok(bucket.objects.has(`post-previews/${id}/${fid}.lvm`), 'the mesh sits under a prefix /files/* refuses');
});

test('at most 3 files, each the author\'s own private model or document', async () => {
  const { raw, bucket } = seed();
  const code = async (fs: unknown[]) => {
    const res = await post(as(raw, bucket, SARA), '/api/community/posts', { ...PROJECT, files: fs });
    return { status: res.status, code: (await json(res)).code };
  };
  assert.deepEqual(await code([{ file_key: STL }, { file_key: PDF }, { file_key: STL2 }, { file_key: STL3 }]), { status: 400, code: 'POST_FILE_LIMIT' });
  assert.deepEqual(await code([{ file_key: EVE_STL }]), { status: 400, code: 'POST_FILE_NOT_OWNED' }, 'somebody else\'s upload');
  assert.deepEqual(await code([{ file_key: 'users/sara/posts/a1.webp' }]), { status: 400, code: 'POST_FILE_NOT_OWNED' }, 'a PUBLIC object is not a private attachment');
  assert.deepEqual(await code([{ file_key: COMMUNITY_PUBLIC }]), { status: 400, code: 'POST_FILE_NOT_OWNED' }, 'the author\'s own `community` upload is public, so it is refused with the same words');
  assert.deepEqual(await code([{ file_key: 'users/sara/post-files/never.stl' }]), { status: 400, code: 'POST_FILE_NOT_OWNED' }, 'not in the ledger');
  assert.deepEqual(await code([{ file_key: PIC_PRIVATE }]), { status: 400, code: 'POST_FILE_KIND' }, 'a picture belongs in media');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_posts'), 0, 'nothing was written by a refused body');
  assert.equal((await code([{ file_key: STL }, { file_key: PDF }, { file_key: STL2 }])).status, 201);
});

test('editing keeps a listed file\'s row (and its links), drops an unlisted one, and adds a new one', async () => {
  const { raw, bucket } = seed();
  const id = await published(raw, bucket);
  const before = await files(raw, bucket, SARA, id);
  const stlRow = before.find((f) => f.key === STL)!;
  const minted = await json(await post(as(raw, bucket, EVE), `/api/community/posts/${id}/files/${stlRow.id}/viewer-token`, {}, UA));
  assert.ok(minted.token);
  const edited = await patch(as(raw, bucket, SARA), `/api/community/posts/${id}`, {
    files: [{ file_key: STL, name: 'Dragon body v2', downloadable: false }, { file_key: STL2, name: 'Wings' }],
  });
  assert.equal(edited.status, 200, JSON.stringify(await json(edited.clone())));
  const after = await files(raw, bucket, SARA, id);
  assert.deepEqual(after.map((f) => [f.key, f.name, f.downloadable]), [[STL, 'Dragon body v2', false], [STL2, 'Wings', false]]);
  assert.equal(after[0].id, stlRow.id, 'the same row: its id, its mesh and its links survive the edit');
  assert.equal((await get(as(raw, bucket, EVE), `/api/marketplace/print/viewer/${minted.token}`, UA)).status, 200);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_post_files WHERE post_id = ?', id), 2);
  // A block between the reader and the author closes an account-bound link at the next read — it does not live out its hour.
  raw.exec("INSERT INTO user_blocks (user_id, blocked_id) VALUES ('sara', 'eve')");
  assert.equal((await get(as(raw, bucket, EVE), `/api/marketplace/print/viewer/${minted.token}`, UA)).status, 404, 'blocked: the mesh is closed');
  raw.exec("DELETE FROM user_blocks WHERE user_id = 'sara' AND blocked_id = 'eve'");
  assert.equal((await get(as(raw, bucket, EVE), `/api/marketplace/print/viewer/${minted.token}`, UA)).status, 200, 'unblocked: the same link opens again');
});

// ==================================================================== viewer

test('an anonymous viewer link works for a PUBLIC post and not for a draft; it is bound to the guest\'s session', async () => {
  const { raw, bucket } = seed();
  const pub = await published(raw, bucket);
  const dr = await draft(raw, bucket);
  const fidOf = async (id: string) => String((await files(raw, bucket, SARA, id))[0].id);
  const pubFid = await fidOf(pub);
  const drFid = await fidOf(dr);

  const guest = await post(as(raw, bucket, null), `/api/community/posts/${pub}/files/${pubFid}/viewer-token`, {}, UA);
  assert.equal(guest.status, 200, await guest.clone().text());
  const { token, grant } = await json(guest);
  assert.equal(grant, 'preview');
  const g = row<{ bound_user: string | null; bound_session: string | null; source_type: string }>(raw, 'SELECT bound_user, bound_session, source_type FROM viewer_grants WHERE source_id = ?', pubFid)!;
  assert.equal(g.bound_user, null);
  assert.equal(g.source_type, 'post');
  assert.equal(g.bound_session?.length, 64);

  const meta = await get(as(raw, bucket, null), `/api/marketplace/print/viewer/${token}`, UA);
  assert.equal(meta.status, 200, await meta.clone().text());
  assert.equal((await json(meta)).name, 'Dragon body');
  const mesh = await get(as(raw, bucket, null), `/api/marketplace/print/viewer/${token}/mesh`, UA);
  assert.equal(mesh.status, 200);
  assert.deepEqual([...new Uint8Array(await mesh.arrayBuffer()).subarray(0, 4)], [0x4c, 0x56, 0x4d, 0x31]);
  assert.equal((await get(as(raw, bucket, null), `/api/marketplace/print/viewer/${token}`, { 'User-Agent': 'Other/1.0' })).status, 404, 'another browser');

  // The draft: nobody's business but the author's.
  assert.equal((await post(as(raw, bucket, null), `/api/community/posts/${dr}/files/${drFid}/viewer-token`, {}, UA)).status, 404);
  assert.equal((await post(as(raw, bucket, EVE), `/api/community/posts/${dr}/files/${drFid}/viewer-token`, {}, UA)).status, 404);
  const own = await post(as(raw, bucket, SARA), `/api/community/posts/${dr}/files/${drFid}/viewer-token`, {}, UA);
  assert.equal(own.status, 200);
  assert.equal((await json(own)).grant, 'full', 'the author sees the stored mesh');
  // A document has no mesh to show.
  const pdfFid = String((await files(raw, bucket, SARA, pub))[1].id);
  const noMesh = await post(as(raw, bucket, null), `/api/community/posts/${pub}/files/${pdfFid}/viewer-token`, {}, UA);
  assert.equal(noMesh.status, 409);
  assert.equal((await json(noMesh)).code, 'NO_PREVIEW');
});

test('the viewer token for a hidden post is revoked: archived, taken private, or deleted — the viewer answers 404', async () => {
  const { raw, bucket } = seed();
  const id = await published(raw, bucket);
  const fid = String((await files(raw, bucket, SARA, id))[0].id);
  const mintPath = `/api/community/posts/${id}/files/${fid}/viewer-token`;
  const viewer = (token: string) => get(as(raw, bucket, null), `/api/marketplace/print/viewer/${token}`, UA);

  const t1 = (await json(await post(as(raw, bucket, null), mintPath, {}, UA))).token;
  assert.equal((await viewer(t1)).status, 200);
  assert.equal((await post(as(raw, bucket, SARA), `/api/community/posts/${id}/archive`)).status, 200);
  assert.ok(row<{ revoked_at: string | null }>(raw, 'SELECT revoked_at FROM viewer_grants WHERE source_id = ?', fid)?.revoked_at, 'revoked by the archive');
  const dead = await viewer(t1);
  assert.equal(dead.status, 404);
  assert.equal((await json(dead)).code, 'VIEWER_TOKEN_INVALID');
  assert.equal((await post(as(raw, bucket, null), mintPath, {}, UA)).status, 404, 'no fresh link on an archived post either');

  // Back as a draft, published again, then taken private: the same story.
  assert.equal((await post(as(raw, bucket, SARA), `/api/community/posts/${id}/restore`)).status, 200);
  assert.equal((await post(as(raw, bucket, SARA), `/api/community/posts/${id}/publish`)).status, 200);
  const t2 = (await json(await post(as(raw, bucket, null), mintPath, {}, UA))).token;
  assert.equal((await viewer(t2)).status, 200);
  assert.equal((await patch(as(raw, bucket, SARA), `/api/community/posts/${id}`, { visibility: 'private' })).status, 200);
  assert.equal((await viewer(t2)).status, 404);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM viewer_grants WHERE revoked_at IS NULL'), 0);

  // Levonis hides the post: no revoke statement ran, and the link still opens nothing — the source is re-asked on every read.
  assert.equal((await patch(as(raw, bucket, SARA), `/api/community/posts/${id}`, { visibility: 'public' })).status, 200);
  const t3 = (await json(await post(as(raw, bucket, null), mintPath, {}, UA))).token;
  assert.equal((await viewer(t3)).status, 200);
  raw.prepare("UPDATE community_posts SET admin_hidden_at = '2026-09-29T00:00:00.000Z' WHERE id = ?").run(id);
  assert.equal((await viewer(t3)).status, 404);
  raw.prepare('UPDATE community_posts SET admin_hidden_at = NULL WHERE id = ?').run(id);

  // Deleted outright (after archiving): the rows cascade and the link is gone with them.
  assert.equal((await post(as(raw, bucket, SARA), `/api/community/posts/${id}/archive`)).status, 200);
  assert.equal((await as(raw, bucket, SARA).request(`/api/community/posts/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_post_files'), 0);
  assert.equal((await viewer(t3)).status, 404);
});

// ================================================================== download

test('the original downloads only when the author allows it, signed in, as an attachment, counted', async () => {
  const { raw, bucket } = seed();
  const id = await published(raw, bucket);
  const [stl, pdf] = await files(raw, bucket, SARA, id);
  const dl = (fid: unknown) => `/api/community/posts/${id}/files/${fid}/download`;

  assert.equal((await get(as(raw, bucket, null), dl(stl.id))).status, 401, 'a guest is asked to sign in');
  const ok = await get(as(raw, bucket, EVE), dl(stl.id));
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.match(ok.headers.get('Content-Disposition') ?? '', /^attachment; filename="Dragon body"/);
  assert.equal(ok.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.match(ok.headers.get('Content-Security-Policy') ?? '', /sandbox/);
  assert.equal((await ok.arrayBuffer()).byteLength, 134);
  assert.equal(row<{ downloads: number }>(raw, 'SELECT downloads FROM community_post_files WHERE id = ?', stl.id)?.downloads, 1);

  const locked = await get(as(raw, bucket, EVE), dl(pdf.id));
  assert.equal(locked.status, 403);
  assert.equal((await json(locked)).code, 'POST_FILE_NOT_DOWNLOADABLE');
  assert.equal((await get(as(raw, bucket, SARA), dl(pdf.id))).status, 200, 'the author takes their own file');
  assert.equal((await get(as(raw, bucket, EVE), dl('pfl_nope'))).status, 404);

  // A draft's file is nobody's to download but the author's.
  const dr = await draft(raw, bucket);
  const drFile = (await files(raw, bucket, SARA, dr))[0];
  assert.equal((await get(as(raw, bucket, EVE), `/api/community/posts/${dr}/files/${drFile.id}/download`)).status, 404);
  assert.equal((await get(as(raw, bucket, SARA), `/api/community/posts/${dr}/files/${drFile.id}/download`)).status, 200);
});
