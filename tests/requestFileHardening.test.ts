/**
 * P1-03 — THE REST OF THE REQUEST HARDENING (Community V3 Phase 2: R4, R5,
 * R6, R11, R12, R13; docs/DECISIONS.md row 265) — real routes, real
 * migrations, the multipart R2 double (tests/fixtures/app.ts `MemoryBucket`).
 *
 *   R5  one table (packages/contracts/src/requestFiles.ts) read by the
 *       browser, the whole-body route and the resumable session: the same
 *       file gets the same answer — the same code, the same ceiling — through
 *       each of the three doors; a seventh file is refused by all three;
 *   R4  both doors answer the stored file as `{id, url, inline}`, the url
 *       being the authorised route, and the session no longer names
 *       `/files/<key>`;
 *   R6  an Arabic or Sorani file name downloads intact (RFC 5987);
 *   13  a retried part, and a retried complete, land ONE file row;
 *   R12 `?w=` answers a sized copy of a picture behind the same permission,
 *       and the original when no copy can be cut;
 *   R13 the link resolver reads a provider answer under a byte ceiling.
 *
 * The other half of P1-03 — a session completing on a published request
 * supersedes the stale offers and notifies once — is pinned with the doors
 * themselves in tests/requestFileDoors.test.ts (R2).
 *
 * Run: node --import tsx --test tests/requestFileHardening.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  MemoryBucket, asD1, count, ctx, freshDb, json, memoryBucket, post, row, stubApp, type App, type Mount, approveMerchants,
} from './fixtures/app';
import { dimsOf, imagesDouble, pngBytes } from './fixtures/imageDoubles';
import { marketplaceRoutes } from '../worker/routes/marketplace';
import { printRequestRoutes } from '../worker/routes/printRequests';
import { uploadSessionRoutes, limitsForPurpose } from '../worker/routes/uploadSessions';
import { MAX_FILES_PER_REQUEST } from '../worker/lib/requestFileRoom';
import { attachmentDisposition, classifyRequestFile, classifyUnnamedRequestFile, storedRequestFileName } from '../worker/lib/attachments';
import { SETTING_DEFAULTS } from '../worker/lib/settings';
import {
  REQUEST_FILE_EXTENSIONS,
  REQUEST_FILE_LIMITS,
  requestFileProblem,
  type RequestFileKind,
} from '../packages/contracts/src/requestFiles';

const MiB = 1024 * 1024;
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

const mount: Mount = (a) => {
  a.route('/api/marketplace/print', printRequestRoutes);
  a.route('/api/marketplace', marketplaceRoutes);
  a.route('/api/uploads/sessions', uploadSessionRoutes);
};

/** Anonymised: a buyer and one approved workshop. */
function seed(): DatabaseSync {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Buyer','buyer@x.co','h','customer'), ('owner','Shop One','owner@x.co','h','customer'),
      ('stranger','Someone','someone@x.co','h','customer');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,starts_at,expires_at) VALUES
      ('mem1','owner','plus_12mo','plus','active',12,29000,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z');
    INSERT INTO community_merchants (id,user_id,name,phone) VALUES ('m1','owner','Shop One','');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,contact_phone) VALUES ('s1','m1','owner','shopone','Shop One','');
    INSERT INTO merchant_printers (id,merchant_id,store_id,name,technology,build_x_mm,build_y_mm,build_z_mm,materials,quality_max)
      VALUES ('p1','m1','s1','Big FDM','fdm',300,300,300,'[]','ultra');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('exchangeRate','1400');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}');
  `);
  approveMerchants(raw);
  return raw;
}

const as = (raw: DatabaseSync, id: string, bucket: unknown, extra: Record<string, unknown> = {}): App =>
  stubApp(asD1(raw), { id, role: 'customer', email: `${id}@x.co` }, mount, {
    env: { BUCKET: bucket, R2_PUBLIC: bucket, R2_PRIVATE: bucket, ...extra },
  });

async function newDraft(raw: DatabaseSync, bucket: unknown): Promise<string> {
  const res = await post(as(raw, 'buyer', bucket), '/api/marketplace/requests', {
    title: 'A phone stand', description: 'A stand for a phone, please',
  });
  assert.equal(res.status, 201);
  return (await json(res)).request.id as string;
}

// ------------------------------------------------------------ sample bytes

/** A PNG with a real IHDR (2×2), padded to `size` bytes. */
function png(size = 256): Uint8Array {
  const head = pngBytes(2, 2);
  const out = new Uint8Array(Math.max(size, head.length));
  out.set(head);
  return out;
}
/** A PDF of `size` bytes: the magic, then padding. */
function pdf(size = 256): Uint8Array {
  const out = new Uint8Array(size);
  out.set([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
  return out;
}
/** A minimal AVIF head: an `ftyp` box whose major brand is `avif`. */
function avif(size = 256): Uint8Array {
  const out = new Uint8Array(size);
  out.set([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66, 0, 0, 0, 0, 0x6d, 0x69, 0x66, 0x31, 0x6d, 0x69, 0x61, 0x66]);
  return out;
}
/** A closed binary-STL cube: 12 triangles. */
function stl(): Uint8Array {
  const out = new Uint8Array(84 + 50 * 12);
  new DataView(out.buffer).setUint32(80, 12, true);
  return out;
}

// ------------------------------------------------------------ the doors

const viaSimpleDoor = (raw: DatabaseSync, bucket: MemoryBucket, id: string, name: string, bytes: Uint8Array, extra: Record<string, unknown> = {}) => {
  const form = new FormData();
  form.append('file', new File([bytes as unknown as BlobPart], name));
  return as(raw, 'buyer', bucket, extra).request(`/api/marketplace/requests/${id}/files`, { method: 'POST', body: form }, undefined, ctx);
};

const openSession = (raw: DatabaseSync, bucket: MemoryBucket, id: string, name: string, bytes: number, digest = sha(new Uint8Array(1))) =>
  post(as(raw, 'buyer', bucket), '/api/uploads/sessions', { purpose: 'request', entity_id: id, file_name: name, bytes, mime: '', sha256: digest });

const putPart = (raw: DatabaseSync, bucket: MemoryBucket, sessionId: string, n: number, body: Uint8Array) =>
  as(raw, 'buyer', bucket).request(
    `/api/uploads/sessions/${sessionId}/parts/${n}`,
    { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'CF-Connecting-IP': '1.2.3.4' }, body: body as unknown as BodyInit },
    undefined,
    ctx
  );

async function viaSessionDoor(raw: DatabaseSync, bucket: MemoryBucket, id: string, name: string, bytes: Uint8Array) {
  const opened = await openSession(raw, bucket, id, name, bytes.length, sha(bytes));
  const body = await json(opened);
  assert.equal(opened.status, 201, JSON.stringify(body));
  const chunk = body.chunk_bytes as number;
  for (let n = 1, off = 0; off < bytes.length; n++, off += chunk) {
    const res = await putPart(raw, bucket, body.session_id, n, bytes.subarray(off, Math.min(off + chunk, bytes.length)));
    assert.equal(res.status, 200, await res.text());
  }
  return { sessionId: body.session_id as string, done: await post(as(raw, 'buyer', bucket), `/api/uploads/sessions/${body.session_id}/complete`, {}) };
}

const fileRows = (raw: DatabaseSync, id: string) => count(raw, 'SELECT COUNT(*) AS n FROM community_request_files WHERE request_id = ?', id);

// ------------------------------------------------------------ R5: one table

test('R5: the session door reads the request table, not the admin ceilings — and only for a request', () => {
  const admin = { ...SETTING_DEFAULTS.uploadLimits, image_mb: 3, model_mb: 7, document_mb: 2 };
  const forRequest = limitsForPurpose('request', admin);
  assert.equal(forRequest.image_mb * MiB, REQUEST_FILE_LIMITS.maxBytes.image);
  assert.equal(forRequest.model_mb * MiB, REQUEST_FILE_LIMITS.maxBytes.model);
  assert.equal(forRequest.document_mb * MiB, REQUEST_FILE_LIMITS.maxBytes.document);
  assert.equal(forRequest.chunk_mb, admin.chunk_mb, 'the part size stays the admin');
  assert.deepEqual(limitsForPurpose('post', admin), admin, 'every other purpose keeps the admin ceilings');
  assert.equal(MAX_FILES_PER_REQUEST, REQUEST_FILE_LIMITS.maxFiles, 'the count every door asks is the table');
});

for (const [kind, name, make] of [
  ['image', 'photo.png', png],
  ['document', 'drawing.pdf', pdf],
] as Array<[RequestFileKind, string, (n: number) => Uint8Array]>) {
  test(`R5: a ${kind} one byte over the ceiling gets the SAME refusal from the browser, the whole-body route and the session`, async () => {
    const raw = seed();
    const bucket = memoryBucket();
    const id = await newDraft(raw, bucket);
    const limit = REQUEST_FILE_LIMITS.maxBytes[kind];
    const over = limit + 1;

    const browser = requestFileProblem({ name, size: over });
    assert.deepEqual(browser, { code: 'UPLOAD_TOO_LARGE', kind, limit_bytes: limit });

    const session = await openSession(raw, bucket, id, name, over);
    assert.equal(session.status, 400);
    const sBody = await json(session);
    assert.equal(sBody.code, 'UPLOAD_TOO_LARGE');
    assert.equal(sBody.details.limit_bytes, limit);
    assert.equal(sBody.details.kind, kind);

    const simple = await viaSimpleDoor(raw, bucket, id, name, make(over));
    assert.equal(simple.status, 400);
    const wBody = await json(simple);
    assert.equal(wBody.code, 'UPLOAD_TOO_LARGE');
    assert.equal(wBody.details.limit_bytes, limit);
    assert.equal(wBody.details.kind, kind);

    // …and exactly at the ceiling, the browser and the session both say yes.
    assert.equal(requestFileProblem({ name, size: limit }), null);
    assert.equal((await openSession(raw, bucket, id, name, limit)).status, 201);
    assert.equal(fileRows(raw, id), 0, 'nothing refused was stored');
  });
}

test('R5: a model takes the session up to its ceiling; the whole-body route says it is too large FOR THAT ROUTE, never accepting more', async () => {
  const raw = seed();
  const bucket = memoryBucket();
  const id = await newDraft(raw, bucket);
  const limit = REQUEST_FILE_LIMITS.maxBytes.model;
  assert.deepEqual(requestFileProblem({ name: 'part.stl', size: limit + 1 }), { code: 'UPLOAD_TOO_LARGE', kind: 'model', limit_bytes: limit });
  const session = await openSession(raw, bucket, id, 'part.stl', limit + 1);
  assert.equal(session.status, 400);
  assert.equal((await json(session)).details.limit_bytes, limit);
  assert.equal((await openSession(raw, bucket, id, 'part.stl', limit)).status, 201, 'the session takes a model at the ceiling');

  const body = new Uint8Array(REQUEST_FILE_LIMITS.wholeBodyMaxBytes + 1);
  const simple = await viaSimpleDoor(raw, bucket, id, 'part.stl', body);
  assert.equal(simple.status, 400);
  const w = await json(simple);
  assert.equal(w.code, 'UPLOAD_TOO_LARGE');
  assert.equal(w.details.door, 'whole_body', 'the refusal names the route, so the browser sends it through a session');
  assert.ok(w.details.limit_bytes <= limit);
  assert.equal(w.details.kind, undefined, 'never "40 MB, the limit for a model": a model may be 300 MB through the session');
});

test('R5: the kinds are the same list on every door — AVIF through the whole-body route too, a ZIP or a video through none', async () => {
  const raw = seed();
  const bucket = memoryBucket();
  const id = await newDraft(raw, bucket);
  // Every listed extension opens a session and passes the browser check.
  for (const kind of ['image', 'model', 'document'] as const) {
    for (const ext of REQUEST_FILE_EXTENSIONS[kind]) {
      assert.equal(requestFileProblem({ name: `f.${ext}`, size: 10 }), null, ext);
      const res = await openSession(raw, bucket, id, `f.${ext}`, 10);
      assert.equal(res.status, 201, `${ext}: ${JSON.stringify(await json(res))}`);
    }
  }
  // What a request does not take is refused by all three, with one code.
  for (const ext of ['zip', 'mp4', 'heic', 'exe']) {
    assert.equal(requestFileProblem({ name: `f.${ext}`, size: 10 })?.code, 'UPLOAD_KIND_NOT_ALLOWED', ext);
    const res = await openSession(raw, bucket, id, `f.${ext}`, 10);
    assert.equal(res.status, 400, ext);
    assert.equal((await json(res)).code, 'UPLOAD_KIND_NOT_ALLOWED', ext);
  }
  const zip = await viaSimpleDoor(raw, bucket, id, 'f.zip', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]));
  assert.equal(zip.status, 400);
  const z = await json(zip);
  assert.equal(z.code, 'UPLOAD_KIND_NOT_ALLOWED', 'a coded refusal the screen renders from FORMAT_CAPABILITIES');
  assert.equal(z.details.extension, 'zip');
  assert.equal(z.details.purpose, 'request');

  // AVIF: the session always took it; the whole-body route now does too.
  assert.deepEqual(classifyRequestFile(avif(), 'pic.avif'), { ext: 'avif', mime: 'image/avif', kind: 'reference', inline: true });
  const a = await viaSimpleDoor(raw, bucket, id, 'pic.avif', avif());
  assert.equal(a.status, 201, JSON.stringify(await json(a.clone())));
  assert.equal((await json(a)).file.content_type, 'image/avif');
});

/** A Windows executable whose DOS header (words the loader ignores) spells `ftyp` + `avif`. */
function peDressedAsAvif(): Uint8Array {
  const out = new Uint8Array(4096);
  out.set([0x4d, 0x5a, 0x90, 0x00]); // MZ
  out.set([0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66], 4); // ftyp avif
  new DataView(out.buffer).setUint32(0x3c, 0x80, true); // e_lfanew
  out.set([0x50, 0x45, 0, 0], 0x80); // PE\0\0
  return out;
}
const jpeg = (size = 256) => {
  const out = new Uint8Array(size);
  out.set([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  return out;
};
/** An iPhone photo: an `ftyp` box whose major brand is `heic`. */
const heic = (size = 256) => {
  const out = new Uint8Array(size);
  out.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0, 0x6d, 0x69, 0x66, 0x31, 0x68, 0x65, 0x69, 0x63]);
  return out;
};

test('the whole-body door asks the name as the session does: an executable dressed as AVIF, or a picture named .html, is refused and never stored', async () => {
  const raw = seed();
  const bucket = memoryBucket();
  const id = await newDraft(raw, bucket);

  // The bytes alone no longer pass: the ftyp box size (bytes 0..3, "MZ..") is not a box.
  const pe = peDressedAsAvif();
  assert.equal(classifyRequestFile(pe, 'drawing.exe'), null);
  assert.equal(classifyRequestFile(pe, 'drawing.avif'), null);
  // A 1 MiB body that starts with ftyp and declares a huge box: refused without walking it.
  const huge = new Uint8Array(MiB);
  huge.set([0x7f, 0xff, 0xff, 0xf0, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x69, 0x66, 0x31]);
  huge.set([0x61, 0x76, 0x69, 0x66], MiB - 8);
  assert.equal(classifyRequestFile(huge, 'x.avif'), null);
  assert.ok(classifyRequestFile(avif(), 'x.avif'), 'a real AVIF head still passes');

  for (const [name, bytes, extension] of [
    ['drawing.exe', pe, 'exe'],
    ['drawing.avif', pe, null],
    ['x.html', jpeg(), 'html'],
  ] as Array<[string, Uint8Array, string | null]>) {
    const res = await viaSimpleDoor(raw, bucket, id, name, bytes);
    const body = await json(res);
    assert.equal(res.status, 400, `${name}: ${JSON.stringify(body)}`);
    assert.equal(body.code, 'UPLOAD_KIND_NOT_ALLOWED', name);
    if (extension !== null) assert.equal(body.details.extension, extension, name);
    else assert.deepEqual(body.details, { declared: 'avif', detected: null }, name);
  }
  // A listed name whose bytes are another listed format: the session answer, word for word.
  const swapped = await viaSimpleDoor(raw, bucket, id, 'photo.jpg', png());
  assert.equal(swapped.status, 400);
  assert.deepEqual((await json(swapped)).details, { declared: 'jpg', detected: 'image/png' });
  assert.equal(fileRows(raw, id), 0, 'nothing refused was stored');

  // `.jpeg` and `.stp` are spellings, not mismatches.
  const spelled = await viaSimpleDoor(raw, bucket, id, 'photo.JPEG', jpeg());
  assert.equal(spelled.status, 201, JSON.stringify(await json(spelled.clone())));
  assert.equal((await json(spelled)).file.file_name, 'photo.JPEG');
});

/** A plain Windows executable: `MZ`, the PE header offset at 0x3c, `PE\0\0`. */
function pe(): Uint8Array {
  const out = new Uint8Array(4096);
  out.set([0x4d, 0x5a, 0x90, 0x00]); // MZ
  new DataView(out.buffer).setUint32(0x3c, 0x80, true); // e_lfanew
  out.set([0x50, 0x45, 0, 0], 0x80); // PE\0\0
  return out;
}

test('a name with NO extension (a camera shot named by digits, or a bare trailing dot) is taken by the whole-body door when its bytes prove a picture or a model, and stored with the proven extension appended', async () => {
  const raw = seed();
  const bucket = memoryBucket();
  const id = await newDraft(raw, bucket);

  for (const [name, bytes, stored, mime, kind] of [
    ['20261020_1234', jpeg(), '20261020_1234.jpg', 'image/jpeg', 'reference'],
    ['photo.', png(), 'photo.png', 'image/png', 'reference'],
    ['20261020_1235', stl(), '20261020_1235.stl', 'model/stl', 'model'],
  ] as Array<[string, Uint8Array, string, string, string]>) {
    const res = await viaSimpleDoor(raw, bucket, id, name, bytes);
    const body = await json(res);
    assert.equal(res.status, 201, `${name}: ${JSON.stringify(body)}`);
    assert.equal(body.file.file_name, stored, `${name}: the sniffed extension is appended`);
    assert.equal(body.file.content_type, mime, name);
    assert.equal(body.file.kind, kind, name);
    const saved = row<{ file_name: string; content_type: string; file_key: string }>(
      raw, 'SELECT file_name, content_type, file_key FROM community_request_files WHERE id = ?', body.file.id
    )!;
    assert.equal(saved.file_name, stored, `${name}: the row keeps the proven name`);
    assert.equal(saved.content_type, mime, name);
    assert.ok(saved.file_key.endsWith(`.${stored.split('.').pop()}`), `${name}: the key carries the sniffed extension too (${saved.file_key})`);
  }

  // A long name with none keeps the appended extension past the 120-character cut.
  const long = await viaSimpleDoor(raw, bucket, id, '9'.repeat(200), jpeg());
  assert.equal(long.status, 201, JSON.stringify(await json(long.clone())));
  const longName = (await json(long)).file.file_name as string;
  assert.ok(longName.endsWith('.jpg') && longName.length <= 120, longName);
  assert.equal(fileRows(raw, id), 4);

  // Bytes that prove nothing a request takes are refused, named or not: an
  // executable (plain, or dressed as AVIF), a text format the name would have
  // to choose (OBJ), a PDF (a document must be named .pdf), a ZIP — with the
  // name-less refusal the screen renders ("This file is not accepted on a
  // request" and what a request does take). Nothing refused is stored.
  const obj = new TextEncoder().encode('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
  for (const [name, bytes] of [
    ['20261020_1236', pe()],
    ['photo.', pe()],
    ['20261020_1237', peDressedAsAvif()],
    ['20261020_1238', obj],
    ['20261020_1239', pdf()],
    ['20261020_1240', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])],
  ] as Array<[string, Uint8Array]>) {
    const res = await viaSimpleDoor(raw, bucket, id, name, bytes);
    const body = await json(res);
    assert.equal(res.status, 400, `${name}: ${JSON.stringify(body)}`);
    assert.equal(body.code, 'UPLOAD_KIND_NOT_ALLOWED', name);
    assert.deepEqual(body.details, { extension: '', purpose: 'request' }, name);
  }
  // A camera HEIC named by digits is told it is HEIC, as a renamed one is.
  const h = await viaSimpleDoor(raw, bucket, id, '20261020_1241', heic());
  assert.equal(h.status, 400);
  assert.equal((await json(h)).code, 'IMAGE_HEIC_UNSUPPORTED');
  // Over the whole-body ceiling with no name to read a kind from: the route's own ceiling, no kind.
  const big = new Uint8Array(REQUEST_FILE_LIMITS.wholeBodyMaxBytes + 1);
  big.set(jpeg());
  const tooBig = await viaSimpleDoor(raw, bucket, id, '20261020_1242', big);
  assert.equal(tooBig.status, 400);
  assert.deepEqual((await json(tooBig)).details, { limit_bytes: REQUEST_FILE_LIMITS.wholeBodyMaxBytes, door: 'whole_body' });
  assert.equal(fileRows(raw, id), 4, 'nothing refused was stored');

  // A name WITH an extension keeps the strict rule: in the table, and what the bytes are.
  for (const [name, bytes] of [['shot.html', jpeg()], ['shot.png', jpeg()], ['shot.exe', pe()]] as Array<[string, Uint8Array]>) {
    const res = await viaSimpleDoor(raw, bucket, id, name, bytes);
    assert.equal(res.status, 400, name);
    assert.equal((await json(res)).code, 'UPLOAD_KIND_NOT_ALLOWED', name);
  }
  assert.equal(fileRows(raw, id), 4);
});

test('storedRequestFileName: the proven extension is kept or appended, never cut, never left bare', () => {
  assert.equal(storedRequestFileName('20261020_1234', 'jpg'), '20261020_1234.jpg');
  assert.equal(storedRequestFileName('photo.', 'png'), 'photo.png');
  assert.equal(storedRequestFileName('photo...', 'png'), 'photo.png');
  assert.equal(storedRequestFileName('photo.JPEG', 'jpeg'), 'photo.JPEG');
  assert.equal(storedRequestFileName('...', 'jpg'), 'attachment.jpg');
  assert.equal(storedRequestFileName('', 'stl'), 'attachment.stl');
  assert.equal(storedRequestFileName('صورة', 'jpg'), 'صورة.jpg');
  const cut = storedRequestFileName(`${'a'.repeat(115)}.html.png`, 'png');
  assert.ok(cut.endsWith('.png') && cut.length <= 120 && !cut.includes('..'), cut);
  assert.equal(classifyUnnamedRequestFile(pdf()), null, 'a document must be named');
  assert.equal(classifyUnnamedRequestFile(jpeg())?.ext, 'jpg');
});

test('a listed extension whose bytes are not that format gets the SAME answer from both doors — HEIC as HEIC, the rest as a mismatch', async () => {
  const raw = seed();
  const bucket = memoryBucket();
  const id = await newDraft(raw, bucket);
  const shiftedPdf = new Uint8Array(256);
  shiftedPdf.set([0x0a, 0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
  for (const [name, bytes, code, details] of [
    ['photo.jpg', heic(), 'IMAGE_HEIC_UNSUPPORTED', null],
    ['drawing.pdf', shiftedPdf, 'UPLOAD_KIND_NOT_ALLOWED', { declared: 'pdf', detected: null }],
  ] as Array<[string, Uint8Array, string, Record<string, unknown> | null]>) {
    const simple = await viaSimpleDoor(raw, bucket, id, name, bytes);
    const s = await json(simple);
    assert.equal(simple.status, 400, name);
    assert.equal(s.code, code, `${name}: whole-body`);
    const { done } = await viaSessionDoor(raw, bucket, id, name, bytes);
    const d = await json(done);
    assert.equal(done.status, 400, name);
    assert.equal(d.code, code, `${name}: session`);
    if (details) {
      assert.deepEqual(s.details, details, `${name}: whole-body`);
      assert.deepEqual(d.details, details, `${name}: session`);
    }
    assert.equal('extension' in (s.details ?? {}), false, `${name}: never ".${name.split('.').pop()} files are not accepted"`);
  }
  assert.equal(fileRows(raw, id), 0);
});

test('a stored name keeps the extension its bytes were proven against, even past the 120-character cut', async () => {
  const raw = seed();
  const bucket = memoryBucket();
  const id = await newDraft(raw, bucket);
  const name = `${'a'.repeat(115)}.html.png`; // cut at 120, it would end ".html"
  const res = await viaSimpleDoor(raw, bucket, id, name, png());
  assert.equal(res.status, 201, JSON.stringify(await json(res.clone())));
  const stored = (await json(res)).file.file_name as string;
  assert.ok(stored.endsWith('.png') && !stored.includes('..'), stored);
  assert.ok(stored.length <= 120);
});

test(`R5: a seventh file is refused by the browser, the whole-body route and the session alike`, async () => {
  const raw = seed();
  const bucket = memoryBucket();
  const id = await newDraft(raw, bucket);
  for (let i = 0; i < MAX_FILES_PER_REQUEST; i++) {
    raw.prepare(
      `INSERT INTO community_request_files (id, request_id, file_key, file_name, content_type, size_bytes, kind)
       VALUES (?, ?, ?, ?, 'image/png', 256, 'reference')`
    ).run(`crf_seed_${i}`, id, `requests/buyer/seed${i}.png`, `seed${i}.png`);
  }
  assert.deepEqual(requestFileProblem({ name: 'seventh.png', size: 256 }, MAX_FILES_PER_REQUEST), {
    code: 'REQUEST_FILES_FULL', max_files: MAX_FILES_PER_REQUEST,
  });
  const simple = await viaSimpleDoor(raw, bucket, id, 'seventh.png', png());
  assert.equal(simple.status, 400);
  assert.equal((await json(simple)).code, 'REQUEST_FILES_FULL');
  const session = await openSession(raw, bucket, id, 'seventh.png', 256);
  assert.equal(session.status, 400);
  assert.equal((await json(session)).code, 'REQUEST_FILES_FULL');
  assert.equal(fileRows(raw, id), MAX_FILES_PER_REQUEST);
});

// ------------------------------------------------------------ R4: {id, url, inline}

test('R4: both doors answer the stored file as {id, url, inline} — the authorised route, never a key, never /files/', async () => {
  const raw = seed();
  const bucket = memoryBucket();
  const id = await newDraft(raw, bucket);

  const simple = await viaSimpleDoor(raw, bucket, id, 'front.png', png());
  assert.equal(simple.status, 201);
  const a = (await json(simple)).file;
  assert.equal(a.url, `/api/marketplace/requests/${id}/files/${a.id}`);
  assert.equal(a.inline, true);

  const { done } = await viaSessionDoor(raw, bucket, id, 'side.png', png(300));
  assert.equal(done.status, 200);
  const body = await json(done);
  const b = body.file;
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), 'the two doors answer the same shape');
  assert.equal(b.url, `/api/marketplace/requests/${id}/files/${b.id}`);
  assert.equal(b.inline, true);
  assert.equal(body.url, b.url, 'the session top-level url is the route too');
  assert.equal(body.key, undefined, 'a request session never hands back its key');
  const key = row<{ file_key: string }>(raw, 'SELECT file_key FROM community_request_files WHERE id = ?', b.id)!.file_key;
  assert.ok(!JSON.stringify(body).includes(key), 'the storage key appears nowhere in the answer');
  assert.ok(!JSON.stringify(body).includes('/files/requests'), 'no dead /files/<key> address');

  // A model answers the same shape, not inline.
  const { done: m } = await viaSessionDoor(raw, bucket, id, 'cube.stl', stl());
  const mf = (await json(m)).file;
  assert.equal(mf.inline, false);
  assert.equal(mf.url, `/api/marketplace/requests/${id}/files/${mf.id}`);
});

// ------------------------------------------------------------ 13: one row

test('acceptance 13: a retried part reuses the same session, and the file lands as ONE row — a retried complete adds none', async () => {
  const raw = seed();
  const bucket = memoryBucket();
  const id = await newDraft(raw, bucket);
  const bytes = png(512);
  const opened = await openSession(raw, bucket, id, 'retry.png', bytes.length, sha(bytes));
  const s = await json(opened);
  assert.equal(opened.status, 201);
  // The first send of part 1 is answered, the connection drops, the browser sends it again.
  assert.equal((await putPart(raw, bucket, s.session_id, 1, bytes)).status, 200);
  const again = await putPart(raw, bucket, s.session_id, 1, bytes);
  assert.equal(again.status, 200);
  assert.deepEqual((await json(again)).received, [1], 'the part is recorded once');

  const done = await post(as(raw, 'buyer', bucket), `/api/uploads/sessions/${s.session_id}/complete`, {});
  assert.equal(done.status, 200, JSON.stringify(await json(done.clone())));
  const first = (await json(done)).file.id as string;
  assert.equal(fileRows(raw, id), 1);

  // The answer was lost and the browser completes again: no second row.
  const retried = await post(as(raw, 'buyer', bucket), `/api/uploads/sessions/${s.session_id}/complete`, {});
  assert.notEqual(retried.status, 200);
  assert.equal(fileRows(raw, id), 1, 'still one row');
  assert.equal(row<{ id: string }>(raw, 'SELECT id FROM community_request_files WHERE request_id = ?', id)!.id, first);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM file_objects WHERE purpose = 'request'"), 1, 'and one ledger row');
});

// ------------------------------------------------------------ R6: the name

test('R6: an Arabic file name downloads intact — an ASCII stand-in and the RFC 5987 UTF-8 name', async () => {
  const raw = seed();
  const bucket = memoryBucket();
  const id = await newDraft(raw, bucket);
  const name = 'مخطط القطعة.pdf';
  const up = await viaSimpleDoor(raw, bucket, id, name, pdf(512));
  assert.equal(up.status, 201);
  const f = (await json(up)).file;
  assert.equal(f.file_name, name, 'the stored name keeps its letters');

  const got = await as(raw, 'buyer', bucket).request(f.url, {}, undefined, ctx);
  assert.equal(got.status, 200, await got.clone().text());
  const cd = got.headers.get('Content-Disposition') ?? '';
  assert.match(cd, /^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
  const encoded = /filename\*=UTF-8''(.+)$/.exec(cd)![1];
  assert.equal(decodeURIComponent(encoded), name, 'a browser reads back the Arabic name');
  assert.ok(/^[\x20-\x7e]*$/.test(cd), 'the header itself is ASCII — it can be built at all');
  assert.equal(new Uint8Array(await got.arrayBuffer()).length, 512);

  // A Sorani picture stays inline, with its name.
  const pic = await viaSimpleDoor(raw, bucket, id, 'وێنەی پارچە.png', png());
  const p = (await json(pic)).file;
  const shown = await as(raw, 'buyer', bucket).request(p.url, {}, undefined, ctx);
  const pcd = shown.headers.get('Content-Disposition') ?? '';
  assert.match(pcd, /^inline; /);
  assert.equal(decodeURIComponent(/filename\*=UTF-8''(.+)$/.exec(pcd)![1]), 'وێنەی پارچە.png');
});

test('R6: attachmentDisposition encodes what RFC 5987 leaves out and never lets a quote break the header', () => {
  const cd = attachmentDisposition("it's (final)*!.pdf");
  assert.equal(cd, `attachment; filename="it's (final)*!.pdf"; filename*=UTF-8''it%27s%20%28final%29%2A%21.pdf`);
  assert.match(attachmentDisposition('a"b\\c.pdf', 'inline'), /^inline; filename="a_b_c\.pdf"/);
  assert.match(attachmentDisposition('صورة.png'), /filename="____\.png"; filename\*=UTF-8''%D8%B5%D9%88%D8%B1%D8%A9\.png$/);
});

// ------------------------------------------------------------ R12: the sized copy

test('R12: ?w= answers a sized copy of a request picture behind the same permission; without a binding, the original', async () => {
  const raw = seed();
  const bucket = memoryBucket();
  const images = imagesDouble();
  const id = await newDraft(raw, bucket);
  const big = pngBytes(1200, 900);
  const up = await viaSimpleDoor(raw, bucket, id, 'big.png', big);
  assert.equal(up.status, 201, JSON.stringify(await json(up.clone())));
  const f = (await json(up)).file;

  const owner = as(raw, 'buyer', bucket, { IMAGES: images.binding });
  const copy = await owner.request(`${f.url}?w=160`, { headers: { Accept: 'image/avif,image/webp,*/*' } }, undefined, ctx);
  assert.equal(copy.status, 200);
  assert.equal(copy.headers.get('Content-Type'), 'image/avif');
  assert.equal(copy.headers.get('X-Variant-Source'), 'render');
  assert.equal(copy.headers.get('Cache-Control'), 'private, max-age=300', 'a private picture stays privately cached');
  assert.equal(copy.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(images.calls.length, 1);
  assert.equal(images.calls[0].width, 160);
  assert.equal(dimsOf(new Uint8Array(await copy.arrayBuffer()))?.width, 160, 'the copy is the 160 px rung, not the 1200 px original');
  assert.equal(bucket.objects.size, 1, 'the copy is never written to a bucket');

  // No binding on this deployment: the original, whole.
  const plain = await as(raw, 'buyer', bucket).request(`${f.url}?w=160`, {}, undefined, ctx);
  assert.equal(plain.status, 200);
  assert.equal(plain.headers.get('Content-Type'), 'image/png');
  assert.equal(new Uint8Array(await plain.arrayBuffer()).length, big.length);

  // A width off the list is refused; a stranger is refused BEFORE anything is cut.
  assert.equal((await owner.request(`${f.url}?w=999`, {}, undefined, ctx)).status, 400);
  const before = images.calls.length;
  const stranger = await as(raw, 'stranger', bucket, { IMAGES: images.binding }).request(`${f.url}?w=160`, {}, undefined, ctx);
  assert.equal(stranger.status, 404);
  assert.equal(images.calls.length, before, 'no copy was cut for a reader without the right');
});

// ------------------------------------------------------------ R13: the resolver ceiling

test('R13: the link resolver reads a provider answer under a byte ceiling — a huge body is refused, not buffered', async () => {
  const { resolveModelLink, RESOLVER_BODY_MAX_BYTES } = await import('../worker/lib/externalModels');
  const providers = [
    { id: 'makerworld', enabled: true, hosts: ['makerworld.com'], api_url: 'https://api.example.com/models/{id}', headers: {} },
  ] as never;
  const huge = (async () =>
    new Response(JSON.stringify({ name: 'x'.repeat(RESOLVER_BODY_MAX_BYTES + 10) }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
  const refused = await resolveModelLink('https://makerworld.com/models/123', providers, huge);
  assert.equal(refused.resolved, false);
  assert.equal(refused.reason, 'TOO_LARGE');
  const small = (async () =>
    new Response(JSON.stringify({ name: 'Benchy', images: [] }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  assert.equal((await resolveModelLink('https://makerworld.com/models/123', providers, small)).resolved, true);
});
