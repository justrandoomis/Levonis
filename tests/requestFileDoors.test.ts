/**
 * ONE FILE ON A REQUEST, WHICHEVER DOOR IT CAME THROUGH (Community V3 R2 and
 * R3, docs/DECISIONS.md row 258) — real routes, real migrations, the
 * multipart R2 double (tests/fixtures/app.ts `MemoryBucket`).
 *
 * R2: the resumable session's `complete` runs the SAME post-insert hooks as
 * the whole-body door (worker/lib/requestFileHooks.ts): on a published job it
 * supersedes the offers priced without the file and notifies once; it asks
 * the request's state and room again, so a session opened before an
 * acceptance, or one racing for the sixth slot, cannot land a file; it stores
 * a model's measurement the way /analyze does. The two doors leave the same
 * rows behind.
 *
 * R3: /analyze refuses to read a model above MEASURE_MAX_BYTES — by the row's
 * size, by the object's size, or by the bytes as they stream — and answers a
 * clean «measure later» instead of buffering it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  MemoryBucket, all, asD1, count, ctx, freshDb, json, memoryBucket, pending, post, row, stubApp, type App, type Mount, approveMerchants,
} from './fixtures/app';
import { marketplaceRoutes } from '../worker/routes/marketplace';
import { printRequestRoutes } from '../worker/routes/printRequests';
import { uploadSessionRoutes } from '../worker/routes/uploadSessions';
import { MEASURE_LATER_CODE, MEASURE_MAX_BYTES, insertRequestFile } from '../worker/lib/requestFileHooks';
import { MAX_FILES_PER_REQUEST } from '../worker/lib/requestFileRoom';
import { HttpError } from '../worker/lib/http';
import { drainMatchQueue } from '../worker/lib/printMatchingStore';

const MiB = 1024 * 1024;
const RATE = 1400;
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

const mount: Mount = (a) => {
  a.route('/api/marketplace/print', printRequestRoutes);
  a.route('/api/marketplace', marketplaceRoutes);
  a.route('/api/uploads/sessions', uploadSessionRoutes);
};

/** Anonymised: a buyer, a workshop that prints FDM, and a resin-only one. */
function seed(): DatabaseSync {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Buyer','buyer@x.co','h','customer'), ('owner','Shop One','owner@x.co','h','customer'),
      ('owner2','Shop Two','owner2@x.co','h','customer');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,starts_at,expires_at) VALUES
      ('mem1','owner','plus_12mo','plus','active',12,29000,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z'),
      ('mem2','owner2','plus_12mo','plus','active',12,29000,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z');
    INSERT INTO community_merchants (id,user_id,name,phone) VALUES ('m1','owner','Shop One',''), ('m2','owner2','Shop Two','');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,contact_phone) VALUES
      ('s1','m1','owner','shopone','Shop One',''), ('s2','m2','owner2','shoptwo','Shop Two','');
    INSERT INTO merchant_printers (id,merchant_id,store_id,name,technology,build_x_mm,build_y_mm,build_z_mm,materials,quality_max)
      VALUES ('p1','m1','s1','Big FDM','fdm',300,300,300,'[]','ultra'),
             ('p2','m2','s2','Resin','resin',200,200,200,'[]','ultra');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('exchangeRate','${RATE}');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}');
  `);
  approveMerchants(raw);
  return raw;
}

const fund = (raw: DatabaseSync, user: string, iqd: number) =>
  raw.exec(`INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note)
            VALUES ('wt_${Math.random().toString(36).slice(2)}','${user}','deposit','USD',${Math.ceil((iqd * 100) / RATE)},'approved','test funding')`);

const as = (raw: DatabaseSync, id: string, bucket: unknown): App =>
  stubApp(asD1(raw), { id, role: 'customer', email: `${id}@x.co` }, mount, {
    env: { BUCKET: bucket, R2_PUBLIC: bucket, R2_PRIVATE: bucket },
  });

const PLA = { process: 'fdm', material_id: 'pla', quality: 'standard', quantity: 1 };

async function newDraft(raw: DatabaseSync, bucket: unknown): Promise<string> {
  const res = await post(as(raw, 'buyer', bucket), '/api/marketplace/requests', {
    title: 'A phone stand', description: 'A stand for a phone, please',
  });
  assert.equal(res.status, 201);
  return (await json(res)).request.id as string;
}

/** Published, with one pending offer from the FDM workshop on revision 1. */
async function publishedWithOffer(raw: DatabaseSync, bucket: unknown): Promise<{ id: string; offerId: string }> {
  const id = await newDraft(raw, bucket);
  const pub = await post(as(raw, 'buyer', bucket), `/api/marketplace/print/requests/${id}/publish`, PLA);
  assert.equal(pub.status, 200, JSON.stringify(await json(pub.clone())));
  const offer = await post(as(raw, 'owner', bucket), `/api/marketplace/requests/${id}/offers`, { price_iqd: 20_000 });
  assert.equal(offer.status, 201, JSON.stringify(await json(offer.clone())));
  return { id, offerId: (await json(offer)).offer.id as string };
}

// ------------------------------------------------------------ sample bytes

/** A PNG head with a 2×2 IHDR — the ledger refuses a picture without real dimensions. */
const png = (size = 256) => {
  const out = new Uint8Array(size);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 2, 8, 6, 0, 0, 0]);
  return out;
};
/** A closed binary-STL cube of 12 triangles, `s` mm on a side. */
function stlCube(s = 10): Uint8Array {
  const v = [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, s], [s, 0, s], [s, s, s], [0, s, s]];
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

// ------------------------------------------------------------ the two doors

const viaSimpleDoor = (raw: DatabaseSync, bucket: MemoryBucket, id: string, name: string, bytes: Uint8Array) => {
  const form = new FormData();
  form.append('file', new File([bytes as unknown as BlobPart], name));
  return as(raw, 'buyer', bucket).request(`/api/marketplace/requests/${id}/files`, { method: 'POST', body: form }, undefined, ctx);
};

/** Open a session for `bytes` on request `id` and send every part — not yet complete. */
async function openAndSend(raw: DatabaseSync, bucket: MemoryBucket, id: string, name: string, bytes: Uint8Array) {
  const a = as(raw, 'buyer', bucket);
  const opened = await post(a, '/api/uploads/sessions', {
    purpose: 'request', entity_id: id, file_name: name, bytes: bytes.length, mime: '', sha256: sha(bytes),
  });
  const body = await json(opened);
  assert.equal(opened.status, 201, JSON.stringify(body));
  const chunk = body.chunk_bytes as number;
  for (let n = 1, off = 0; off < bytes.length; n++, off += chunk) {
    const res = await a.request(
      `/api/uploads/sessions/${body.session_id}/parts/${n}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream', 'CF-Connecting-IP': '1.2.3.4' },
        body: bytes.subarray(off, Math.min(off + chunk, bytes.length)) as unknown as BodyInit,
      },
      undefined,
      ctx
    );
    assert.equal(res.status, 200, `part ${n}: ${await res.text()}`);
  }
  return body.session_id as string;
}
const completeSession = (raw: DatabaseSync, bucket: MemoryBucket, sessionId: string) =>
  post(as(raw, 'buyer', bucket), `/api/uploads/sessions/${sessionId}/complete`, {});

async function viaSessionDoor(raw: DatabaseSync, bucket: MemoryBucket, id: string, name: string, bytes: Uint8Array) {
  return completeSession(raw, bucket, await openAndSend(raw, bucket, id, name, bytes));
}

const noticeCount = (raw: DatabaseSync, user: string, kind: string) =>
  count(raw, 'SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = ? AND kind = ?', user, kind);

// ------------------------------------------------------------ R2

test('R2: a session completing on a published request supersedes the stale offer and notifies exactly once', async () => {
  const raw = seed();
  const bucket = memoryBucket();
  const { id, offerId } = await publishedWithOffer(raw, bucket);
  assert.equal(noticeCount(raw, 'owner', 'request_files'), 0);

  const sessionId = await openAndSend(raw, bucket, id, 'detail.png', png());
  const done = await completeSession(raw, bucket, sessionId);
  const body = await json(done);
  assert.equal(done.status, 200, JSON.stringify(body));
  assert.equal(body.file.kind, 'reference');

  // Revised in the same batch as the row; the offer priced on revision 1 is stale.
  assert.equal(row<{ revision: number }>(raw, 'SELECT revision FROM community_requests WHERE id = ?', id)!.revision, 2);
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_offers WHERE id = ?', offerId)!.state, 'superseded');
  const snap = row<{ files: string; reason: string }>(raw, 'SELECT files, reason FROM community_request_revisions WHERE request_id = ? AND revision = 2', id)!;
  assert.equal(snap.reason, 'files');
  assert.equal(JSON.parse(snap.files).length, 1);
  // «أضاف … ملفات» to the workshop behind the offer, and its «your offer is stale» — once each.
  assert.equal(noticeCount(raw, 'owner', 'request_files'), 1);
  assert.equal(noticeCount(raw, 'owner', 'offer_stale'), 1);
  assert.equal(noticeCount(raw, 'buyer', 'request_files'), 0, 'never the customer’s own account');
  // The discussion's «تغيّر الطلب» row, and a re-match queued or done.
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM community_request_comments WHERE request_id = ? AND kind <> 'comment'", id) >= 1, true);

  // The completed session cannot be completed again, so nothing is told twice.
  assert.equal((await completeSession(raw, bucket, sessionId)).status, 404);
  assert.equal(noticeCount(raw, 'owner', 'request_files'), 1);
  assert.equal(noticeCount(raw, 'owner', 'offer_stale'), 1);
});

test('R2: a session opened before the acceptance and completed after it is refused — no row, no object, no notice', async () => {
  const raw = seed();
  const bucket = memoryBucket();
  fund(raw, 'buyer', 500_000);
  const { id, offerId } = await publishedWithOffer(raw, bucket);
  const sessionId = await openAndSend(raw, bucket, id, 'late.png', png());

  const accepted = await post(as(raw, 'buyer', bucket), `/api/marketplace/offers/${offerId}/accept`, {
    expected_price_iqd: 20_000, offer_revision: 1,
  });
  assert.equal(accepted.status, 201, JSON.stringify(await json(accepted.clone())));
  const noticesBefore = count(raw, 'SELECT COUNT(*) AS n FROM user_notifications');
  const revisionBefore = row<{ revision: number }>(raw, 'SELECT revision FROM community_requests WHERE id = ?', id)!.revision;

  const late = await completeSession(raw, bucket, sessionId);
  assert.equal(late.status, 409);
  assert.equal((await json(late)).code, 'REQUEST_NOT_EDITABLE');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_request_files WHERE request_id = ?', id), 0);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM file_objects WHERE purpose = 'request'"), 0, 'no ledger row for a refused file');
  assert.equal([...bucket.objects.keys()].filter((k) => k.startsWith('requests/')).length, 0, 'the assembled object was deleted');
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM upload_sessions WHERE id = ?', sessionId)!.state, 'aborted');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM user_notifications'), noticesBefore, 'nobody is told about a file that did not land');
  assert.equal(row<{ revision: number }>(raw, 'SELECT revision FROM community_requests WHERE id = ?', id)!.revision, revisionBefore);
});

test(`R2: the session door respects the ${MAX_FILES_PER_REQUEST}-file limit at complete, not only at open`, async () => {
  const raw = seed();
  const bucket = memoryBucket();
  const id = await newDraft(raw, bucket);
  for (let i = 0; i < MAX_FILES_PER_REQUEST - 1; i++) {
    raw.prepare(
      `INSERT INTO community_request_files (id, request_id, file_key, file_name, content_type, size_bytes, kind)
       VALUES (?, ?, ?, ?, 'image/png', 256, 'reference')`
    ).run(`crf_seed_${i}`, id, `requests/buyer/seed${i}.png`, `seed${i}.png`);
  }
  // Both open while one slot is left; the first to complete takes it.
  const first = await openAndSend(raw, bucket, id, 'first.png', png(300));
  const second = await openAndSend(raw, bucket, id, 'second.png', png(400));
  assert.equal((await completeSession(raw, bucket, first)).status, 200);

  const refused = await completeSession(raw, bucket, second);
  assert.equal(refused.status, 400);
  const body = await json(refused);
  assert.equal(body.code, 'REQUEST_FILES_FULL');
  assert.equal(body.details.max_files, MAX_FILES_PER_REQUEST);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_request_files WHERE request_id = ?', id), MAX_FILES_PER_REQUEST);
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM upload_sessions WHERE id = ?', second)!.state, 'aborted');
  assert.equal([...bucket.objects.values()].filter((o) => o.bytes.length === 400).length, 0, 'the refused object is gone');

  // A seventh session is refused at open, and the whole-body door says the same.
  const seventh = await post(as(raw, 'buyer', bucket), '/api/uploads/sessions', {
    purpose: 'request', entity_id: id, file_name: 'seventh.png', bytes: 256, mime: '', sha256: sha(png()),
  });
  assert.equal(seventh.status, 400);
  assert.equal((await json(seventh)).code, 'REQUEST_FILES_FULL');
  const simple = await viaSimpleDoor(raw, bucket, id, 'seventh.png', png());
  assert.equal(simple.status, 400);
  assert.equal((await json(simple)).code, 'REQUEST_FILES_FULL');
});

test('R2: the row is guarded where it is written — a full or closed request aborts the whole batch, ledger row included', async () => {
  const raw = seed();
  const bucket = memoryBucket();
  const { id, offerId } = await publishedWithOffer(raw, bucket);
  const db = asD1(raw) as unknown as D1Database;
  for (let i = 0; i < MAX_FILES_PER_REQUEST; i++) {
    raw.prepare(
      `INSERT INTO community_request_files (id, request_id, file_key, file_name, content_type, size_bytes, kind)
       VALUES (?, ?, ?, ?, 'image/png', 256, 'reference')`
    ).run(`crf_full_${i}`, id, `requests/buyer/full${i}.png`, `full${i}.png`);
  }
  const ledger = db
    .prepare(`INSERT INTO file_objects (object_key, visibility, domain, owner_id, entity_id, mime_type, byte_size, original_name, sha256, purpose)
              VALUES ('requests/buyer/x.png', 'private', 'requests', 'buyer', ?, 'image/png', 256, 'x.png', '', 'request')`)
    .bind(id);
  const file = { id: 'crf_extra', requestId: id, ownerId: 'buyer', key: 'requests/buyer/x.png', name: 'x.png', mime: 'image/png', bytes: 256, kind: 'reference' };

  await assert.rejects(insertRequestFile(db, file, [ledger]), (e: unknown) => e instanceof HttpError && e.code === 'REQUEST_FILES_FULL');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM community_request_files WHERE id = 'crf_extra'"), 0);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM file_objects WHERE object_key = 'requests/buyer/x.png'"), 0, 'the ledger row rode the aborted batch');
  assert.equal(row<{ revision: number }>(raw, 'SELECT revision FROM community_requests WHERE id = ?', id)!.revision, 1, 'no revision for a file that did not land');
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_offers WHERE id = ?', offerId)!.state, 'pending');

  raw.exec(`DELETE FROM community_request_files WHERE id = 'crf_full_0'`);
  raw.prepare(`UPDATE community_requests SET state = 'cancelled' WHERE id = ?`).run(id);
  await assert.rejects(insertRequestFile(db, file, [ledger]), (e: unknown) => e instanceof HttpError && e.code === 'REQUEST_NOT_EDITABLE');
  await assert.rejects(
    insertRequestFile(db, { ...file, ownerId: 'owner' }, [ledger]),
    (e: unknown) => e instanceof HttpError && e.status === 404,
    'a stranger’s id is a 404'
  );
});

/** Every row a new file leaves behind, with the ids that differ between two databases masked. */
function sideEffects(raw: DatabaseSync, id: string) {
  const offerIds = all<{ id: string }>(raw, 'SELECT id FROM community_offers WHERE request_id = ?', id).map((o) => o.id);
  const fileIds = all<{ id: string }>(raw, 'SELECT id FROM community_request_files WHERE request_id = ?', id).map((f) => f.id);
  const mask = (v: unknown) => {
    let s = JSON.stringify(v);
    for (const [real, label] of [[id, '<request>'], ...offerIds.map((o) => [o, '<offer>']), ...fileIds.map((f) => [f, '<file>'])]) {
      s = s.split(real).join(label);
    }
    return JSON.parse(s.replace(/"\d{4}-\d{2}-\d{2}T[\d:.]+Z"/g, '"<time>"'));
  };
  return mask({
    request: row(raw, 'SELECT state, revision FROM community_requests WHERE id = ?', id),
    offers: all(raw, 'SELECT merchant_id, state, request_revision FROM community_offers WHERE request_id = ? ORDER BY merchant_id', id),
    revisions: all(raw, 'SELECT revision, reason, json_array_length(files) AS files FROM community_request_revisions WHERE request_id = ? ORDER BY revision', id),
    files: all(
      raw,
      `SELECT file_name, content_type, size_bytes, kind, model_format, analysis, preview_key <> '' AS has_preview,
              analysed_at IS NOT NULL AS analysed
         FROM community_request_files WHERE request_id = ?`,
      id
    ),
    notices: all(
      raw,
      `SELECT user_id, kind, title_ar, title_en, body_en, link, entity_type, entity_id, event_key,
              json_extract(meta, '$.title_ckb') AS title_ckb
         FROM user_notifications ORDER BY user_id, kind, event_key`
    ),
    discussion: all(raw, "SELECT author_id, kind, body FROM community_request_comments WHERE request_id = ? AND kind <> 'comment' ORDER BY created_at", id),
    matches: all(raw, 'SELECT merchant_id, eligible, revision FROM community_request_matches WHERE request_id = ? ORDER BY merchant_id', id),
    previews: count(raw, "SELECT COUNT(*) AS n FROM file_objects WHERE object_key LIKE 'request-previews/%'"),
  });
}

test('R2: the whole-body door and the session door leave identical side effects — revision, supersede, notices, re-match, stored measurement', async () => {
  const run = async (door: 'simple' | 'session') => {
    const raw = seed();
    const bucket = memoryBucket();
    const { id } = await publishedWithOffer(raw, bucket);
    const res = door === 'simple'
      ? await viaSimpleDoor(raw, bucket, id, 'bracket.stl', stlCube(20))
      : await viaSessionDoor(raw, bucket, id, 'bracket.stl', stlCube(20));
    assert.ok(res.status === 200 || res.status === 201, `${door}: ${await res.text()}`);
    // The whole-body door measures after its answer, under waitUntil.
    await Promise.all(pending);
    return { effects: sideEffects(raw, id), bucket };
  };
  const simple = await run('simple');
  const session = await run('session');
  assert.deepEqual(session.effects, simple.effects);

  // And what they agree on is the R2 contract, not two identical omissions.
  const e = simple.effects;
  assert.equal(e.request.revision, 2);
  assert.deepEqual(e.offers.map((o: { state: string }) => o.state), ['superseded']);
  assert.equal(e.files.length, 1);
  assert.equal(e.files[0].model_format, 'stl');
  assert.equal(JSON.parse(e.files[0].analysis).measured, true);
  assert.equal(e.files[0].has_preview, 1, 'the viewer mesh is stored on arrival');
  assert.equal(e.previews, 1);
  assert.equal(e.notices.filter((n: { kind: string }) => n.kind === 'request_files').length, 1);
  assert.equal(e.notices.filter((n: { kind: string }) => n.kind === 'offer_stale').length, 1);
  assert.ok(e.notices.find((n: { kind: string; title_ckb: string | null }) => n.kind === 'request_files')?.title_ckb, 'the Sorani is stamped');
  assert.ok(e.discussion.length >= 1, 'the discussion shows the revision');
});

test('R2: a model completed through a session is measured and stored the way /analyze stores it; /analyze then answers from the row', async () => {
  const raw = seed();
  const bucket = memoryBucket();
  const id = await newDraft(raw, bucket);
  const done = await viaSessionDoor(raw, bucket, id, 'cube.stl', stlCube(10));
  const body = await json(done);
  assert.equal(done.status, 200, JSON.stringify(body));
  const fileId = body.file.id as string;
  const stored = row<{ analysis: string; model_format: string; preview_key: string; analysed_at: string | null }>(
    raw, 'SELECT analysis, model_format, preview_key, analysed_at FROM community_request_files WHERE id = ?', fileId
  )!;
  assert.equal(stored.model_format, 'stl');
  assert.ok(stored.analysed_at);
  assert.deepEqual(JSON.parse(stored.analysis), body.analysis, 'the row holds what the session measured');
  assert.equal(stored.preview_key, `request-previews/${id}/${fileId}.lvm`);
  assert.ok(bucket.objects.has(stored.preview_key), 'the mesh is in the bucket');
  // A draft revises nothing and tells nobody.
  assert.equal(row<{ revision: number }>(raw, 'SELECT revision FROM community_requests WHERE id = ?', id)!.revision, 1);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE kind = 'request_files'"), 0);

  const an = await post(as(raw, 'buyer', bucket), `/api/marketplace/print/requests/${id}/files/${fileId}/analyze`);
  const answer = await json(an);
  assert.equal(an.status, 200);
  assert.equal(answer.cached, true);
  assert.equal(answer.analysis.measured, true);
});

// ------------------------------------------------------------ R2: the commit outlives the client

const queued = (raw: DatabaseSync, id: string) =>
  count(raw, "SELECT COUNT(*) AS n FROM community_match_queue WHERE kind = 'request' AND subject_id = ?", id);
const matchesOn = (raw: DatabaseSync, id: string, revision: number) =>
  count(raw, 'SELECT COUNT(*) AS n FROM community_request_matches WHERE request_id = ? AND revision = ?', id, revision);

/** An ExecutionContext that keeps what the route hands to `waitUntil`. */
function watchingCtx(): { ctx: ExecutionContext; handed: Promise<unknown>[] } {
  const handed: Promise<unknown>[] = [];
  return {
    handed,
    ctx: { waitUntil: (p: Promise<unknown>) => { handed.push(p.catch(() => undefined)); }, passThroughOnException() {} } as unknown as ExecutionContext,
  };
}

/**
 * A bucket that holds the viewer mesh's write until the test lets it go —
 * the measurement's slowest step standing still — and notes what was already
 * recorded the moment it arrived.
 */
class MeshGateBucket extends MemoryBucket {
  release: () => void = () => undefined;
  private readonly gate = new Promise<void>((resolve) => { this.release = resolve; });
  private reached: (seen: Record<string, number>) => void = () => undefined;
  readonly arrived = new Promise<Record<string, number>>((resolve) => { this.reached = resolve; });
  constructor(private readonly look: () => Record<string, number> = () => ({})) {
    super();
  }
  override async put(key: string, value: ArrayBuffer | ArrayBufferView | string, options?: { httpMetadata?: { contentType?: string } }) {
    if (key.startsWith('request-previews/')) {
      this.reached(this.look());
      await this.gate;
    }
    return super.put(key, value, options);
  }
}

test('R2: the re-match is queued in the insert’s own batch — an invocation cut off right after the commit is finished by the sweep', async () => {
  const raw = seed();
  const bucket = memoryBucket();
  const { id, offerId } = await publishedWithOffer(raw, bucket);
  const db = asD1(raw) as unknown as D1Database;
  assert.equal(queued(raw, id), 0);
  const file = (fid: string, requestId: string) => ({
    id: fid, requestId, ownerId: 'buyer', key: `requests/buyer/${fid}.png`, name: `${fid}.png`, mime: 'image/png', bytes: 256, kind: 'reference',
  });

  // The batch alone: the invocation ends before a single hook runs.
  await insertRequestFile(db, file('crf_cut', id));
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_offers WHERE id = ?', offerId)!.state, 'superseded');
  assert.equal(queued(raw, id), 1, 'the re-match rode the batch that superseded the offer');
  assert.equal(row<{ reason: string }>(raw, "SELECT reason FROM community_match_queue WHERE kind = 'request' AND subject_id = ?", id)!.reason, 'files');
  assert.equal(matchesOn(raw, id, 2), 0);

  // The sweep finishes it: the verdicts are decided again on revision 2.
  const report = await drainMatchQueue({ DB: db } as never, { limit: 5 });
  assert.equal(report.requests, 1, JSON.stringify(report));
  assert.equal(queued(raw, id), 0);
  assert.ok(matchesOn(raw, id, 2) >= 1);

  // A draft queues nothing; a refused row queues nothing.
  const draft = await newDraft(raw, bucket);
  await insertRequestFile(db, file('crf_draft', draft));
  assert.equal(queued(raw, draft), 0, 'a draft is never matched');
  raw.prepare(`UPDATE community_requests SET state = 'cancelled' WHERE id = ?`).run(id);
  await assert.rejects(insertRequestFile(db, file('crf_late', id)), (e: unknown) => e instanceof HttpError && e.code === 'REQUEST_NOT_EDITABLE');
  assert.equal(queued(raw, id), 0, 'the queue row rode the aborted batch');
});

test('R2: the revision, both notices and the re-match are recorded before the model is measured, and the chain is handed to waitUntil', async () => {
  const raw = seed();
  let id = '';
  const bucket = new MeshGateBucket(() => ({
    revision: count(raw, 'SELECT COUNT(*) AS n FROM community_request_revisions WHERE request_id = ? AND revision = 2', id),
    offer_stale: noticeCount(raw, 'owner', 'offer_stale'),
    request_files: noticeCount(raw, 'owner', 'request_files'),
    matched: matchesOn(raw, id, 2) > 0 ? 1 : 0,
    queued: queued(raw, id),
  }));
  try {
    ({ id } = await publishedWithOffer(raw, bucket));
    const sessionId = await openAndSend(raw, bucket, id, 'bracket.stl', stlCube(20));
    const watch = watchingCtx();
    const done = as(raw, 'buyer', bucket).request(
      `/api/uploads/sessions/${sessionId}/complete`,
      { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' }, body: '{}' },
      undefined,
      watch.ctx
    );

    // The mesh write stands still: everything the commit means is already there.
    const seen = await bucket.arrived;
    assert.deepEqual(seen, { revision: 1, offer_stale: 1, request_files: 1, matched: 1, queued: 0 });
    assert.equal(watch.handed.length, 1, 'the chain is the runtime’s to finish, whatever the client does');
    assert.equal(
      row<{ state: string }>(raw, 'SELECT state FROM upload_sessions WHERE id = ?', sessionId)!.state,
      'completed',
      'completed with its row: a retry cannot land the file twice'
    );

    bucket.release();
    const res = await done;
    assert.equal(res.status, 200, await res.text());
    const stored = row<{ analysis: string; preview_key: string }>(raw, 'SELECT analysis, preview_key FROM community_request_files WHERE request_id = ?', id)!;
    assert.equal(JSON.parse(stored.analysis).measured, true, 'the measurement still lands, last');
    assert.ok(stored.preview_key);
  } finally {
    bucket.release();
  }
});

test('R2: the whole-body door answers before it parses a model — the measurement runs after the answer, under waitUntil, from one copy', async () => {
  const raw = seed();
  const bucket = new MeshGateBucket();
  try {
    const { id, offerId } = await publishedWithOffer(raw, bucket);
    const watch = watchingCtx();
    const form = new FormData();
    form.append('file', new File([stlCube(20) as unknown as BlobPart], 'bracket.stl'));
    const answered = await Promise.race([
      as(raw, 'buyer', bucket).request(`/api/marketplace/requests/${id}/files`, { method: 'POST', body: form }, undefined, watch.ctx),
      new Promise<'waited'>((resolve) => setTimeout(() => resolve('waited'), 5_000)),
    ]);
    assert.notEqual(answered, 'waited', 'the answer waited for the measurement');
    const res = answered as Response;
    const body = await json(res);
    assert.equal(res.status, 201, JSON.stringify(body));

    // Answered with the commit's meaning done and the model not yet parsed.
    assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_offers WHERE id = ?', offerId)!.state, 'superseded');
    assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_request_revisions WHERE request_id = ? AND revision = 2', id), 1);
    assert.equal(noticeCount(raw, 'owner', 'offer_stale'), 1);
    assert.equal(noticeCount(raw, 'owner', 'request_files'), 1);
    assert.equal(row<{ analysis: string }>(raw, 'SELECT analysis FROM community_request_files WHERE id = ?', body.file.id)!.analysis, '');
    assert.equal(watch.handed.length, 2, 'the hooks, and the measurement after the answer');

    // Then the deferred measurement reaches the mesh, and lands.
    await bucket.arrived;
    bucket.release();
    await Promise.all(watch.handed);
    const stored = row<{ analysis: string; preview_key: string }>(raw, 'SELECT analysis, preview_key FROM community_request_files WHERE id = ?', body.file.id)!;
    assert.equal(JSON.parse(stored.analysis).measured, true);
    assert.equal(stored.preview_key, `request-previews/${id}/${body.file.id}.lvm`);
  } finally {
    bucket.release();
  }
});

// ------------------------------------------------------------ R3

/**
 * A bucket whose one model is whatever the test says: a declared size, and a
 * stream that counts what it hands out. `arrayBuffer()` throws — /analyze may
 * never take the whole object in one gulp.
 */
function trapBucket(opts: { declaredSize?: number; streamBytes: number; chunk?: number }) {
  const chunk = new Uint8Array(opts.chunk ?? MiB);
  const state = { gets: 0, pulled: 0, cancelled: false, arrayBufferCalls: 0 };
  const objects = new Map<string, Uint8Array>();
  const bucket = {
    state,
    objects,
    async get(key: string) {
      if (key !== 'requests/buyer/huge.stl') {
        const v = objects.get(key);
        return v ? { key, size: v.byteLength, body: new Blob([v as unknown as BlobPart]).stream(), arrayBuffer: async () => v.buffer } : null;
      }
      state.gets++;
      let left = opts.streamBytes;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (left <= 0) return controller.close();
          const n = Math.min(left, chunk.byteLength);
          left -= n;
          state.pulled += n;
          controller.enqueue(n === chunk.byteLength ? chunk : chunk.subarray(0, n));
        },
        cancel() {
          state.cancelled = true;
        },
      });
      return {
        key,
        ...(opts.declaredSize !== undefined ? { size: opts.declaredSize } : {}),
        body,
        httpEtag: '"x"',
        async arrayBuffer() {
          state.arrayBufferCalls++;
          throw new Error('the whole object was asked for');
        },
      };
    },
    async head(key: string) {
      const v = objects.get(key);
      return v ? { key, size: v.byteLength } : null;
    },
    async put(key: string, value: Uint8Array) {
      objects.set(key, value);
      return { key };
    },
    async delete(key: string) {
      objects.delete(key);
    },
  };
  return bucket;
}

async function draftWithHugeModel(raw: DatabaseSync, bucket: unknown, rowSize: number): Promise<{ id: string; fileId: string }> {
  const id = await newDraft(raw, bucket);
  raw.prepare(
    `INSERT INTO community_request_files (id, request_id, file_key, file_name, content_type, size_bytes, kind)
     VALUES ('crf_huge', ?, 'requests/buyer/huge.stl', 'huge.stl', 'model/stl', ?, 'model')`
  ).run(id, rowSize);
  return { id, fileId: 'crf_huge' };
}

const analyze = (raw: DatabaseSync, bucket: unknown, id: string, fileId: string) =>
  post(as(raw, 'buyer', bucket), `/api/marketplace/print/requests/${id}/files/${fileId}/analyze`);

function assertMeasureLater(body: Record<string, unknown>) {
  assert.equal(body.success, true);
  assert.equal(body.analysis, null);
  assert.equal(body.measure, 'later');
  assert.equal(body.code, MEASURE_LATER_CODE);
  assert.equal(body.limit_bytes, MEASURE_MAX_BYTES);
}

test('R3: /analyze above the cap by the row’s size answers «measure later» without touching the object', async () => {
  const raw = seed();
  const bucket = trapBucket({ declaredSize: 200 * MiB, streamBytes: 200 * MiB });
  const { id, fileId } = await draftWithHugeModel(raw, bucket, 200 * MiB);
  const res = await analyze(raw, bucket, id, fileId);
  assert.equal(res.status, 200);
  assertMeasureLater(await json(res));
  assert.equal(bucket.state.gets, 0, 'R2 was never asked');
  assert.equal(row<{ analysis: string }>(raw, 'SELECT analysis FROM community_request_files WHERE id = ?', fileId)!.analysis, '', 'nothing is stored');
});

test('R3: /analyze above the cap by the object’s own size cancels the body unread', async () => {
  const raw = seed();
  const bucket = trapBucket({ declaredSize: MEASURE_MAX_BYTES + 1, streamBytes: MEASURE_MAX_BYTES + 1 });
  const { id, fileId } = await draftWithHugeModel(raw, bucket, 1000); // the row understates it
  const res = await analyze(raw, bucket, id, fileId);
  assert.equal(res.status, 200);
  assertMeasureLater(await json(res));
  assert.equal(bucket.state.gets, 1);
  assert.equal(bucket.state.arrayBufferCalls, 0);
  assert.equal(bucket.state.cancelled, true);
  assert.ok(bucket.state.pulled <= MiB, `at most the stream's first chunk was pulled, not ${bucket.state.pulled} bytes`);
});

test('R3: /analyze whose bytes outrun the declared size stops at the cap — never buffers the rest', async () => {
  const raw = seed();
  const total = MEASURE_MAX_BYTES + 20 * MiB;
  const bucket = trapBucket({ declaredSize: 1000, streamBytes: total });
  const { id, fileId } = await draftWithHugeModel(raw, bucket, 1000);
  const res = await analyze(raw, bucket, id, fileId);
  assert.equal(res.status, 200);
  assertMeasureLater(await json(res));
  assert.equal(bucket.state.arrayBufferCalls, 0);
  assert.equal(bucket.state.cancelled, true);
  assert.ok(bucket.state.pulled <= MEASURE_MAX_BYTES + 2 * MiB, `stopped near the cap, not at ${bucket.state.pulled} of ${total}`);
  assert.equal(row<{ analysis: string }>(raw, 'SELECT analysis FROM community_request_files WHERE id = ?', fileId)!.analysis, '');
});

test('R3: a model within the cap is still measured by /analyze, and stored once', async () => {
  const raw = seed();
  const bucket = memoryBucket();
  const id = await newDraft(raw, bucket);
  const cube = stlCube(15);
  await bucket.put('requests/buyer/cube.stl', cube);
  raw.prepare(
    `INSERT INTO community_request_files (id, request_id, file_key, file_name, content_type, size_bytes, kind)
     VALUES ('crf_cube', ?, 'requests/buyer/cube.stl', 'cube.stl', 'model/stl', ?, 'model')`
  ).run(id, cube.length);
  const first = await json(await analyze(raw, bucket, id, 'crf_cube'));
  assert.equal(first.cached, false);
  assert.equal(first.analysis.measured, true);
  assert.equal(Math.round(first.analysis.dimensions_mm.x), 15);
  assert.ok(row<{ preview_key: string }>(raw, 'SELECT preview_key FROM community_request_files WHERE id = ?', 'crf_cube')!.preview_key);
  const again = await json(await analyze(raw, bucket, id, 'crf_cube'));
  assert.equal(again.cached, true);
});
