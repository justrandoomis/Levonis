/**
 * THE REQUEST EDITOR'S DRAFT, ON THE SERVER (plan P1-06, acceptance 14 and
 * 13; docs/DECISIONS.md row 268) — through the real routes and migrations.
 *
 *   the entry door     a draft born empty and version 3, on the main site,
 *                      signed in, behind the gate (tests/communityGate.test.ts)
 *   the draft save     holds what was typed so far (an empty title, a cleared
 *                      description), and refuses a stale window (DRAFT_CHANGED)
 *                      inside the write itself
 *   the publish        asks the title and the description of a draft born
 *                      empty, and never opens a request for one store
 *   one request        Scenario D built with the EDITOR's own state functions
 *                      and body: saved, read back into the same body, saved
 *                      again with nothing changed, published
 *   compat             a published version-1 request with a pending offer,
 *                      opened in the editor and saved unchanged, keeps it
 *   a lost answer      a request upload whose «complete» landed but whose
 *                      answer was lost: the retry adopts the stored file, and
 *                      opens no second session (acceptance 13)
 *   provenance         a link pointed elsewhere no longer carries origin_*
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { analyseModel } from '../worker/lib/modelGeometry';
import { asD1, count, ctx, get, json, MERCHANT_HOST, MemoryBucket, post, put, row, stubApp, type App, type Mount } from './fixtures/app';
import { addFile, offerOn, PLA, world } from './fixtures/requestModelWorld';
import { marketplaceRoutes } from '../worker/routes/marketplace';
import { printRequestRoutes } from '../worker/routes/printRequests';
import { requestEntryRoutes } from '../worker/routes/requestEntries';
import { uploadSessionRoutes } from '../worker/routes/uploadSessions';
import { readRequestModel, factsHashV3 } from '../worker/lib/requestModel';
import { uploadLarge, resumeKey, fileFingerprint, type StorageLike } from '../src/lib/uploadSession';
import {
  addLink,
  addPart,
  addTextRef,
  adoptIds,
  bodyKey,
  chooseMaterial,
  editorBody,
  hydrate,
  namedColour,
  sentShape,
  setOriginal,
  setPrimary,
  updateMaterial,
  updatePart,
  updateSource,
  type EditorState,
} from '../src/components/community/requests/editor/state';
import type { DraftShape } from '../src/components/community/requests/api';

const mount: Mount = (a) => {
  a.route('/api/marketplace/print', printRequestRoutes);
  a.route('/api/marketplace/print', requestEntryRoutes);
  a.route('/api/marketplace', marketplaceRoutes);
  a.route('/api/uploads/sessions', uploadSessionRoutes);
};
const as = (raw: DatabaseSync, id: string | null, opts: { host?: string; bucket?: MemoryBucket } = {}) =>
  stubApp(asD1(raw), id ? { id, role: 'customer', email: `${id}@x.co` } : null, mount, {
    host: opts.host,
    env: opts.bucket ? { BUCKET: opts.bucket, R2_PRIVATE: opts.bucket, R2_PUBLIC: opts.bucket } : {},
  });

const entry = async (raw: DatabaseSync, user = 'buyer') => {
  const res = await post(as(raw, user), '/api/marketplace/print/requests', { entry: { kind: 'blank' } });
  return { status: res.status, body: await json(res) };
};
const save = async (raw: DatabaseSync, id: string, body: object) => {
  const res = await put(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}/draft`, body);
  return { status: res.status, body: await json(res) };
};
const draftOf = async (raw: DatabaseSync, id: string): Promise<DraftShape> =>
  (await json(await get(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}/draft`))).draft as DraftShape;
const publishBody = async (raw: DatabaseSync, id: string, body: object) => {
  const res = await post(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}/publish`, body);
  return { status: res.status, body: await json(res) };
};

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

const MATS = [
  { id: 'pla', process: 'fdm' as const },
  { id: 'tpu', process: 'fdm' as const },
];
const processOf = (id: string) => MATS.find((m) => m.id === id)?.process ?? '';

// ------------------------------------------------------------ the entry door

test('the entry door: a draft born empty and version 3, for its customer only, on the main site', async () => {
  const raw = world();
  const born = await entry(raw);
  assert.equal(born.status, 201, JSON.stringify(born.body));
  const id = born.body.request_id as string;
  const d = born.body.draft as DraftShape;
  assert.equal(d.state, 'draft');
  assert.equal(d.title, '');
  assert.equal(d.description, '');
  assert.equal(d.schema_version, 3, 'born version 3: never read as a legacy text request');
  assert.equal(d.model?.parts.length, 1);
  assert.equal(d.model?.parts[0].materials[0].material_unsure, true);
  assert.deepEqual(d.model?.parts[0].materials[0].colors.map((c) => c.mode), ['any']);
  assert.ok(d.updated_at, 'the save stamp the editor sends back');
  assert.equal(d.direct, null);
  const r = row<{ state: string; visibility: string; customer_id: string }>(raw, 'SELECT state, visibility, customer_id FROM community_requests WHERE id = ?', id)!;
  assert.deepEqual([r.state, r.visibility, r.customer_id], ['draft', 'public', 'buyer']);
  // Nobody else sees it, and it is not on the board.
  assert.equal((await get(as(raw, 'owner'), `/api/marketplace/print/requests/${id}/draft`)).status, 404);
  const board = await json(await get(as(raw, 'owner'), '/api/marketplace/requests'));
  assert.ok(!(board.requests as Array<{ id: string }>).some((x) => x.id === id));

  // A store subdomain carries the session cookie; it never creates a request.
  const before = count(raw, 'SELECT COUNT(*) AS n FROM community_requests');
  assert.equal((await post(as(raw, 'buyer', { host: MERCHANT_HOST }), '/api/marketplace/print/requests', {})).status, 404);
  assert.equal((await post(as(raw, null), '/api/marketplace/print/requests', {})).status, 401);
  assert.equal((await post(as(raw, 'buyer'), '/api/marketplace/print/requests', { entry: { kind: 'teleport' } })).status, 400);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_requests'), before, 'a refused entry creates nothing');
});

// ------------------------------------------------------------ the draft save

test('a draft holds what was typed so far: a short title saves, and a cleared description stays cleared', async () => {
  const raw = world();
  const id = (await entry(raw)).body.request_id as string;
  const short = await save(raw, id, { title: 'ab', description: '' });
  assert.equal(short.status, 200, JSON.stringify(short.body));
  assert.equal(short.body.draft.title, 'ab');
  assert.equal((await save(raw, id, { description: 'A bracket for the shelf, please' })).body.draft.description, 'A bracket for the shelf, please');
  const cleared = await save(raw, id, { description: '' });
  assert.equal(cleared.body.draft.description, '', 'clearing the description to rewrite it is saved, so the old text never comes back');
  // The maximums still hold.
  assert.equal((await save(raw, id, { title: 'x'.repeat(141) })).status, 400);
});

test('a stale window gets 409 DRAFT_CHANGED with the draft as it now is, and writes nothing', async () => {
  const raw = world();
  const id = (await entry(raw)).body.request_id as string;
  const first = await save(raw, id, { title: 'First window' });
  const stamp = first.body.draft.updated_at as string;
  // Another window saved since.
  raw.prepare(`UPDATE community_requests SET title = 'Other window', updated_at = '2030-01-01T00:00:00.000Z' WHERE id = ?`).run(id);
  const stale = await save(raw, id, { title: 'Stale words', expected_updated_at: stamp });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'DRAFT_CHANGED');
  assert.equal(stale.body.details.draft.title, 'Other window');
  assert.equal(stale.body.details.draft.updated_at, '2030-01-01T00:00:00.000Z');
  assert.equal(row<{ title: string }>(raw, 'SELECT title FROM community_requests WHERE id = ?', id)!.title, 'Other window', 'nothing written');
  // The current stamp saves; no stamp at all (the page-leave flush) is the last save winning.
  const fresh = await save(raw, id, { title: 'Current window', expected_updated_at: '2030-01-01T00:00:00.000Z' });
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  assert.equal((await save(raw, id, { title: 'Leaving words' })).body.draft.title, 'Leaving words');
  // A published request is not a draft: REQUEST_NOT_DRAFT, whatever the stamp says.
  raw.prepare(`UPDATE community_requests SET state = 'open' WHERE id = ?`).run(id);
  const late = await save(raw, id, { title: 'Late', expected_updated_at: 'whatever' });
  assert.equal(late.body.code, 'REQUEST_NOT_DRAFT');
});

// ------------------------------------------------------------ the publish

test('the publish asks a draft born empty for its title and its description', async () => {
  const raw = world();
  const id = (await entry(raw)).body.request_id as string;
  const noTitle = await publishBody(raw, id, {});
  assert.equal(noTitle.status, 400);
  assert.equal(noTitle.body.code, 'REQUEST_TITLE_REQUIRED');
  await save(raw, id, { title: 'A phone stand' });
  const noText = await publishBody(raw, id, {});
  assert.equal(noText.body.code, 'REQUEST_DESCRIPTION_REQUIRED');
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_requests WHERE id = ?', id)!.state, 'draft', 'a refused publish opens nothing');
  await save(raw, id, { description: 'A stand for a phone, please' });
  const ok = await publishBody(raw, id, {});
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_requests WHERE id = ?', id)!.state, 'open');
});

test('a request for one store is never published to the board (REQUEST_IS_DIRECT), and its draft names the store', async () => {
  const raw = world();
  raw.exec(`INSERT INTO community_requests (id, customer_id, title, description, status, state, visibility, target_merchant_id, created_at, updated_at)
            VALUES ('creq_direct', 'buyer', 'A gear for Ali', 'A gear like the old one, please', 'closed', 'draft', 'direct', 'm1', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`);
  const res = await publishBody(raw, 'creq_direct', PLA);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'REQUEST_IS_DIRECT');
  assert.equal(row<{ state: string }>(raw, "SELECT state FROM community_requests WHERE id = 'creq_direct'")!.state, 'draft');
  const d = await draftOf(raw, 'creq_direct');
  assert.equal(d.direct?.merchant_id, 'm1');
  assert.equal(d.direct?.store_name, 'Ali 3D');
  assert.equal(d.direct?.store_slug, 'ali3d');
});

// ------------------------------------------------------------ one request (Scenario D)

const LINK = 'https://www.printables.com/model/4242-cable-clip';

/** Scenario D, built with the editor's own state functions. */
function scenarioD(s0: EditorState): EditorState {
  const key = (name: string) => s0.sources.find((x) => s0.files.find((f) => f.id === x.fileId)?.file_name === name)!.key;
  let s = s0;
  s = { ...s, title: 'A clip and its soft grip', description: 'A cable clip with a soft grip, please' };
  s = addLink(s, LINK, 'printables')[0];
  s = addTextRef(s, 'Soft where the thumb goes, hard where it clips')[0];
  s = setPrimary(s, key('clip.stl'));
  s = updateSource(s, key('front.jpg'), { note: 'the grip, like this' });
  s = setOriginal(s, key('clip.step'), true)[0];
  const one = s.parts[0];
  s = updatePart(s, one.key, { name: 'Clip', measuredFileId: s.files.find((f) => f.file_name === 'clip.stl')!.id });
  s = chooseMaterial(s, one.key, one.materials[0].key, 'pla', processOf);
  s = updateMaterial(s, one.key, one.materials[0].key, { colours: [namedColour('Black', '#1a1a1a')] });
  const [s2, twoKey] = addPart(s);
  s = s2;
  const two = s.parts.find((p) => p.key === twoKey)!;
  s = updatePart(s, twoKey, { name: 'Grip', dims: { x: 40, y: 15, z: 10 }, sourceKeys: [key('side.png')] });
  s = chooseMaterial(s, twoKey, two.materials[0].key, 'tpu', processOf);
  s = updateMaterial(s, twoKey, two.materials[0].key, {
    colours: [namedColour('Red', '#d32f2f'), { mode: 'as_reference', hex: '', label: '', ref: key('side.png') }],
  });
  return s;
}

test('Scenario D through the editor: saved, read back into the very same body, saved again with nothing changed, published', async () => {
  const raw = world();
  const id = (await entry(raw)).body.request_id as string;
  addFile(raw, id, 'crf_stl', 'model', 'clip.stl', { analysis: analyseModel(stl(30), 'clip.stl') as unknown as Record<string, unknown> });
  addFile(raw, id, 'crf_step', 'model', 'clip.step');
  addFile(raw, id, 'crf_front', 'reference', 'front.jpg');
  addFile(raw, id, 'crf_side', 'reference', 'side.png');

  const start = hydrate(await draftOf(raw, id));
  assert.equal(start.files.length, 4);
  assert.equal(start.sources.length, 4, 'every file of the request is a source');
  const s = scenarioD(start);
  const body = editorBody(s);
  assert.equal('source_type' in body, false, 'the editor never sends source_type');
  assert.ok(body.sources.some((x) => x.id.startsWith('tmp_link_')), 'a new link travels under a tmp id');
  assert.ok(body.parts[1].materials[0].colors.some((c) => c.mode === 'as_reference' && c.ref === start.sources.find((x) => x.fileId === 'crf_side')!.id));

  const saved = await save(raw, id, { ...body, expected_updated_at: s.updatedAt });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const adopted = adoptIds(s, sentShape(s), saved.body.draft);
  // RESUMED: the draft read back is the state the editor had, to the byte of its body.
  const resumed = hydrate(await draftOf(raw, id));
  assert.equal(bodyKey(resumed), bodyKey(adopted), 'a reload resumes exactly what was saved');
  assert.equal(resumed.parts.length, 2);
  assert.deepEqual(resumed.parts.map((p) => p.name), ['Clip', 'Grip']);
  assert.deepEqual(resumed.parts.map((p) => p.materials.map((m) => m.materialId)), [['pla'], ['tpu']]);
  const grip = resumed.parts[1];
  assert.deepEqual(grip.materials[0].colours.map((c) => c.mode), ['catalogue', 'as_reference']);
  const side = resumed.sources.find((x) => x.fileId === 'crf_side')!;
  assert.equal(grip.materials[0].colours[1].ref, side.key, '«كما في المرجع» names the picture it means');
  assert.equal(resumed.sources.find((x) => x.fileId === 'crf_front')!.note, 'the grip, like this');
  assert.equal(resumed.sources.find((x) => x.fileId === 'crf_stl')!.primary, true);
  assert.equal(resumed.sources.find((x) => x.fileId === 'crf_step')!.original, true, 'the original file, for the accepted merchant only');
  assert.equal(resumed.sources.filter((x) => x.kind === 'link').length, 1);
  assert.equal(resumed.sources.filter((x) => x.kind === 'text_ref').length, 1);

  // SAVED AGAIN, NOTHING CHANGED: the model hash does not move.
  const before = await factsHashV3((await readRequestModel(asD1(raw) as unknown as D1Database, id))!);
  const again = await save(raw, id, { ...editorBody(resumed), expected_updated_at: resumed.updatedAt });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  const after = await factsHashV3((await readRequestModel(asD1(raw) as unknown as D1Database, id))!);
  assert.equal(after, before);

  // PUBLISHED with the same body.
  const pub = await publishBody(raw, id, editorBody(hydrate(again.body.draft)));
  assert.equal(pub.status, 200, JSON.stringify(pub.body));
  const spec = JSON.parse(row<{ spec: string }>(raw, 'SELECT spec FROM community_request_revisions WHERE request_id = ? ORDER BY revision DESC', id)!.spec);
  assert.equal(spec.model.parts.length, 2);
  assert.equal(spec.model.sources.length, 6, 'four files, a link and a written reference');
});

test('an edit of a published version-1 request, saved through the editor unchanged, keeps its pending offer', async () => {
  const raw = world();
  const res = await post(as(raw, 'buyer'), '/api/marketplace/requests', { title: 'A phone stand', description: 'A stand for a phone, please' });
  const id = (await json(res)).request.id as string;
  assert.equal((await publishBody(raw, id, PLA)).status, 200);
  const offer = await offerOn(raw, id);
  const d = await draftOf(raw, id);
  assert.equal(d.state, 'receiving_offers');
  const s = hydrate(d);
  const body = editorBody(s);
  assert.equal('title' in body, false, 'a published request keeps the title merchants read');
  const pub = await publishBody(raw, id, body);
  assert.equal(pub.status, 200, JSON.stringify(pub.body));
  assert.equal(pub.body.replayed, true, 'nothing a merchant priced changed');
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_offers WHERE id = ?', offer.id)!.state, 'pending');
});

// ------------------------------------------------------------ a lost answer (acceptance 13)

test('a request upload whose answer was lost: the retry adopts the stored file and opens no second session', async () => {
  const raw = world();
  const bucket = new MemoryBucket();
  const id = (await entry(raw)).body.request_id as string;
  const app: App = as(raw, 'buyer', { bucket });
  const bytes = stl(20);
  const file = new File([bytes as unknown as BlobPart], 'part.stl', { type: 'model/stl', lastModified: 1 });
  const sha = createHash('sha256').update(bytes).digest('hex');

  // The first try: the session opens, the parts land, «complete» commits — and its answer never arrives.
  const opened = await json(await post(app, '/api/uploads/sessions', { purpose: 'request', entity_id: id, file_name: 'part.stl', bytes: bytes.length, mime: 'model/stl', sha256: sha }));
  assert.ok(opened.session_id, JSON.stringify(opened));
  const part = await app.request(`/api/uploads/sessions/${opened.session_id}/parts/1`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: bytes as unknown as BodyInit }, undefined, ctx);
  assert.equal(part.status, 200, await part.clone().text());
  const done = await post(app, `/api/uploads/sessions/${opened.session_id}/complete`, {});
  assert.equal(done.status, 200, await done.clone().text());
  const stored = (await json(done)).file as { id: string };

  // The session itself says what it stored.
  const state = await json(await get(app, `/api/uploads/sessions/${opened.session_id}`));
  assert.equal(state.state, 'completed');
  assert.equal(state.file.id, stored.id);
  assert.match(state.file.url, new RegExp(`/api/marketplace/requests/${id}/files/${stored.id}$`));

  // The retry, as the browser runs it: the resume record of the first try is still there.
  const memory = new Map<string, string>();
  const storage: StorageLike = { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => void memory.set(k, v), removeItem: (k) => void memory.delete(k) };
  storage.setItem(resumeKey('request', fileFingerprint(file), id), JSON.stringify({ session_id: opened.session_id, chunk_bytes: opened.chunk_bytes, sha256: sha, saved_at: Date.now() }));
  const calls: string[] = [];
  const result = await uploadLarge(file, 'request', {
    entityId: id,
    storage,
    fetchImpl: async (input, init) => {
      calls.push(`${init?.method ?? 'GET'} ${input}`);
      return app.request(input, init, undefined, ctx);
    },
  });
  assert.equal((result.file as { id: string }).id, stored.id, 'the file the lost answer stored');
  assert.deepEqual(calls, [`GET /api/uploads/sessions/${opened.session_id}`], 'no new session, no part, no complete');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_request_files WHERE request_id = ?', id), 1);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM upload_sessions WHERE entity_id = ?", id), 1);
  assert.equal(memory.size, 0, 'the resume record is gone');
});

// ------------------------------------------------------------ provenance

test('a link the customer points elsewhere no longer carries the provenance of the one a handoff made', async () => {
  const raw = world();
  const id = (await entry(raw)).body.request_id as string;
  let s = hydrate(await draftOf(raw, id));
  s = addLink(s, LINK, 'printables')[0];
  const first = await save(raw, id, editorBody(s));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const linkId = (first.body.draft as DraftShape).model!.sources.find((x) => x.kind === 'link')!.id;
  raw.prepare(`UPDATE community_request_sources SET origin_id = 'cp1', origin_ref = 'product', origin_hash = '', origin_meta = '{"title":"A clip"}' WHERE id = ?`).run(linkId);

  // The same link again: its provenance stays.
  const same = hydrate(await draftOf(raw, id));
  await save(raw, id, editorBody(same));
  assert.equal(row<{ origin_id: string }>(raw, 'SELECT origin_id FROM community_request_sources WHERE id = ?', linkId)!.origin_id, 'cp1');

  // Pointed at another model: the same source row, its provenance cleared.
  const moved = editorBody(same);
  const link = moved.sources.find((x) => x.kind === 'link')!;
  link.url = 'https://www.printables.com/model/9999-another-clip';
  const res = await save(raw, id, moved as unknown as Record<string, unknown>);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const r = row<{ origin_id: string; origin_ref: string; origin_meta: string }>(raw, 'SELECT origin_id, origin_ref, origin_meta FROM community_request_sources WHERE id = ?', linkId)!;
  assert.deepEqual([r.origin_id, r.origin_ref, r.origin_meta], ['', '', '{}']);
});
