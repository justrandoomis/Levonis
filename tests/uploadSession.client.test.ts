/**
 * THE CLIENT HALF OF RESUMABLE UPLOADS (src/lib/uploadSession.ts): which door a
 * file takes, the resume record and its key, the part arithmetic, the retry
 * curve, the SHA-256 core against Node's, and `uploadLarge` end to end against
 * a fake server — a part that fails once is retried, a cancel deletes the
 * session, a saved session resumes with only the parts the server lacks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  MODEL_ARCHIVE_EXTENSIONS,
  SESSION_THRESHOLD_BYTES,
  UPLOAD_KEEP_SESSION,
  clearResume,
  fileFingerprint,
  isRetryable,
  partCount,
  partRange,
  pickUpload,
  readResume,
  resumeKey,
  retryDelayMs,
  sha256OfFile,
  uploadLarge,
  writeResume,
  type FetchLike,
  type StorageLike,
  type UploadProgress,
} from '../src/lib/uploadSession';
import { Sha256, sha256Hex } from '../src/components/upload/sha256core';
import { ApiError } from '../src/lib/api';
import { UPLOAD_STRINGS, formatBytes } from '../src/components/upload/strings';

const MiB = 1024 * 1024;
const nodeSha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

test('pickUpload: above 8 MiB or any model/archive extension takes the session path', () => {
  assert.equal(pickUpload({ name: 'photo.jpg', size: 1 * MiB }), 'simple');
  assert.equal(pickUpload({ name: 'photo.jpg', size: SESSION_THRESHOLD_BYTES }), 'simple', 'exactly 8 MiB still fits one request');
  assert.equal(pickUpload({ name: 'photo.jpg', size: SESSION_THRESHOLD_BYTES + 1 }), 'session');
  assert.equal(pickUpload({ name: 'cube.STL', size: 4096 }), 'session', 'a tiny model is still sniffed and measured on the session path');
  assert.equal(pickUpload({ name: 'part.3mf', size: 100 }), 'session');
  assert.equal(pickUpload({ name: 'noext', size: 100 }), 'simple');
  for (const ext of ['stl', 'obj', '3mf', 'amf', 'glb', 'gltf', 'step', 'stp', 'zip']) assert.ok(MODEL_ARCHIVE_EXTENSIONS.has(ext), ext);
});

test('the resume key follows the file (name + size + mtime), the purpose and the entity', () => {
  const a = fileFingerprint({ name: 'a.stl', size: 10, lastModified: 5 });
  assert.equal(a, fileFingerprint({ name: 'a.stl', size: 10, lastModified: 5 }));
  assert.notEqual(a, fileFingerprint({ name: 'a.stl', size: 10, lastModified: 6 }), 'an edited file is another file');
  assert.notEqual(a, fileFingerprint({ name: 'a.stl', size: 11, lastModified: 5 }));
  assert.notEqual(resumeKey('post', a), resumeKey('request', a));
  assert.notEqual(resumeKey('request', a, 'req1'), resumeKey('request', a, 'req2'));
  assert.ok(resumeKey('post', a).startsWith('levonis.upload.'));
});

const memoryStorage = (): StorageLike & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
};

test('a resume record round-trips, and anything malformed reads as nothing', () => {
  const storage = memoryStorage();
  const sha = 'a'.repeat(64);
  writeResume(storage, 'k', { session_id: 's1', chunk_bytes: 8 * MiB, sha256: sha, saved_at: 1 });
  assert.deepEqual(readResume(storage, 'k'), { session_id: 's1', chunk_bytes: 8 * MiB, sha256: sha, saved_at: 1 });
  clearResume(storage, 'k');
  assert.equal(readResume(storage, 'k'), null);
  storage.map.set('k', 'not json');
  assert.equal(readResume(storage, 'k'), null);
  storage.map.set('k', JSON.stringify({ session_id: 's1', chunk_bytes: 0, sha256: sha }));
  assert.equal(readResume(storage, 'k'), null, 'a zero chunk is no record');
  storage.map.set('k', JSON.stringify({ session_id: 's1', chunk_bytes: 8, sha256: 'xyz' }));
  assert.equal(readResume(storage, 'k'), null, 'a digest that is not one');
  assert.equal(readResume(null, 'k'), null, 'no storage at all');
  const throwing: StorageLike = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
  assert.equal(readResume(throwing, 'k'), null);
  writeResume(throwing, 'k', { session_id: 's', chunk_bytes: 1, sha256: sha, saved_at: 0 });
  clearResume(throwing, 'k');
});

test('part arithmetic and the retry curve', () => {
  assert.equal(partCount(6 * MiB, 5 * MiB), 2);
  assert.equal(partCount(5 * MiB, 5 * MiB), 1);
  assert.equal(partCount(0, 5 * MiB), 1, 'an empty file is one (empty) part');
  assert.deepEqual(partRange(1, 6 * MiB, 5 * MiB), { start: 0, end: 5 * MiB });
  assert.deepEqual(partRange(2, 6 * MiB, 5 * MiB), { start: 5 * MiB, end: 6 * MiB });
  assert.deepEqual([1, 2, 3].map((n) => retryDelayMs(n)), [600, 1200, 2400]);
  assert.equal(isRetryable(new ApiError(0, 'network')), true);
  assert.equal(isRetryable(new ApiError(503, 'down')), true);
  assert.equal(isRetryable(new ApiError(429, 'slow down')), true);
  assert.equal(isRetryable(new ApiError(400, 'no', 'UPLOAD_PART_TOO_LARGE')), false);
  assert.equal(isRetryable(new ApiError(0, 'cancelled', 'ABORTED')), false);
  assert.equal(isRetryable(new Error('x')), false);
});

test('the SHA-256 core agrees with Node across block boundaries and split updates', () => {
  for (const size of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 65_537]) {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) & 0xff;
    assert.equal(sha256Hex(bytes), nodeSha(bytes), `size ${size}`);
    const split = new Sha256();
    for (let off = 0; off < size; off += 13) split.update(bytes.subarray(off, Math.min(off + 13, size)));
    assert.equal(split.digestHex(), nodeSha(bytes), `size ${size}, 13-byte updates`);
  }
  assert.equal(sha256Hex(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('sha256OfFile hashes a File slice by slice on the main thread when no Worker exists, and reports progress', async () => {
  const bytes = new Uint8Array(5 * MiB + 17);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 0xff;
  const file = new File([bytes as unknown as BlobPart], 'big.bin');
  const seen: number[] = [];
  assert.equal(await sha256OfFile(file, (loaded) => seen.push(loaded)), nodeSha(bytes));
  assert.deepEqual(seen, [4 * MiB, bytes.length]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(sha256OfFile(file, undefined, controller.signal), (e: unknown) => e instanceof ApiError && e.code === 'ABORTED');
});

// ------------------------------------------------------------ a fake server

interface FakeServer {
  fetch: FetchLike;
  calls: string[];
  parts: Map<number, Uint8Array>;
  deleted: boolean;
  failPartOnce: Set<number>;
  received: number[];
  chunk: number;
}
function fakeServer(chunk: number, opts: { received?: number[]; state?: string } = {}): FakeServer {
  const s: FakeServer = { calls: [], parts: new Map(), deleted: false, failPartOnce: new Set(), received: opts.received ?? [], chunk, fetch: async () => new Response() };
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  s.fetch = async (input, init) => {
    const method = init?.method ?? 'GET';
    s.calls.push(`${method} ${input}`);
    if (method === 'POST' && input === '/api/uploads/sessions') {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.purpose, 'post');
      assert.match(body.sha256, /^[0-9a-f]{64}$/);
      return reply(201, { success: true, session_id: 's1', chunk_bytes: chunk, parts_total: Math.ceil(body.bytes / chunk), expires_at: 'later' });
    }
    if (method === 'GET' && input === '/api/uploads/sessions/s1') {
      return reply(200, { success: true, state: opts.state ?? 'open', received: s.received, chunk_bytes: chunk, bytes_so_far: s.received.length * chunk });
    }
    const part = /^\/api\/uploads\/sessions\/s1\/parts\/(\d+)$/.exec(input);
    if (method === 'PUT' && part) {
      const n = Number(part[1]);
      if (s.failPartOnce.delete(n)) return reply(503, { success: false, error: 'flaky' });
      s.parts.set(n, new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer()));
      return reply(200, { success: true, received: [...s.parts.keys()] });
    }
    if (method === 'POST' && input === '/api/uploads/sessions/s1/complete') {
      const ordered = [...s.parts.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
      const all = new Uint8Array(ordered.reduce((n, b) => n + b.length, 0));
      let at = 0;
      for (const b of ordered) { all.set(b, at); at += b.length; }
      return reply(200, { success: true, key: 'users/u1/post-files/x.bin', url: '/files/users/u1/post-files/x.bin', mime: 'application/octet-stream', bytes: all.length, sha256: nodeSha(all) });
    }
    if (method === 'DELETE' && input === '/api/uploads/sessions/s1') {
      s.deleted = true;
      return reply(200, { success: true, state: 'aborted' });
    }
    return reply(404, { success: false, error: 'no such route', code: 'NOT_FOUND' });
  };
  return s;
}

const sampleFile = (size: number) => {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 13 + 1) & 0xff;
  return { bytes, file: new File([bytes as unknown as BlobPart], 'big.bin', { lastModified: 42 }) };
};

test('uploadLarge: hashes, opens a session, sends parts two at a time with a retry, completes, and clears the resume record', async () => {
  const { bytes, file } = sampleFile(2500);
  const server = fakeServer(1000);
  server.failPartOnce.add(2);
  const storage = memoryStorage();
  const progress: UploadProgress[] = [];
  const result = await uploadLarge(file, 'post', {
    fetchImpl: server.fetch,
    storage,
    onProgress: (p) => progress.push(p),
    retries: 3,
  });
  assert.equal(result.sha256, nodeSha(bytes), 'the server saw the bytes in order');
  assert.equal(result.key, 'users/u1/post-files/x.bin');
  assert.equal(server.parts.size, 3);
  assert.equal(server.calls.filter((c) => c.includes('/parts/2')).length, 2, 'the flaky part was sent again');
  assert.equal(storage.map.size, 0, 'nothing left to resume');
  assert.equal(progress[0].phase, 'hashing');
  // Two lanes: part 3 lands while the flaky part 2 waits out its retry pause, so
  // the LAST report — whichever part it names — is the one that reads complete.
  assert.ok(progress.some((p) => p.phase === 'uploading' && p.part === 3));
  assert.ok(progress.some((p) => p.phase === 'uploading' && p.loaded === 2500));
  assert.equal(progress.at(-1)?.phase, 'finishing');
  assert.ok(!server.deleted);
});

test('uploadLarge: a saved open session resumes with only the parts the server lacks', async () => {
  const { file } = sampleFile(2500);
  const storage = memoryStorage();
  const sha = await sha256OfFile(file);
  writeResume(storage, resumeKey('post', fileFingerprint(file)), { session_id: 's1', chunk_bytes: 1000, sha256: sha, saved_at: 1 });
  const server = fakeServer(1000, { received: [1, 2] });
  const result = await uploadLarge(file, 'post', { fetchImpl: server.fetch, storage });
  assert.ok(result.url);
  assert.ok(!server.calls.some((c) => c.startsWith('POST /api/uploads/sessions') && !c.includes('complete')), 'no new session was opened');
  assert.deepEqual([...server.parts.keys()], [3], 'only the missing part travelled');
});

test('uploadLarge: a saved session the server closed is opened afresh; a refusal is not retried and clears the record', async () => {
  const { file } = sampleFile(2500);
  const storage = memoryStorage();
  const sha = await sha256OfFile(file);
  const key = resumeKey('post', fileFingerprint(file));
  writeResume(storage, key, { session_id: 's1', chunk_bytes: 1000, sha256: sha, saved_at: 1 });
  const server = fakeServer(1000, { state: 'expired' });
  await uploadLarge(file, 'post', { fetchImpl: server.fetch, storage });
  assert.ok(server.calls.includes('POST /api/uploads/sessions'), 'a fresh session');
  assert.equal(server.parts.size, 3);

  const refusing = fakeServer(1000);
  const original = refusing.fetch;
  refusing.fetch = async (input, init) =>
    init?.method === 'PUT' ? new Response(JSON.stringify({ success: false, error: 'no', code: 'UPLOAD_PART_TOO_LARGE' }), { status: 400 }) : original(input, init);
  await assert.rejects(uploadLarge(file, 'post', { fetchImpl: refusing.fetch, storage }), (e: unknown) => e instanceof ApiError && e.code === 'UPLOAD_PART_TOO_LARGE');
  assert.equal(refusing.calls.filter((c) => c.startsWith('PUT')).length <= 2, true, 'a refusal is not retried (at most the two lanes’ first attempts)');
  assert.equal(readResume(storage, key), null);
});

test('uploadLarge: a part refused while its sibling lane is in flight rejects the upload, and NO progress follows the rejection', async () => {
  const { file } = sampleFile(2000);
  const server = fakeServer(1000);
  const original = server.fetch;
  let releasePart2!: () => void;
  const part2Gate = new Promise<void>((resolve) => { releasePart2 = resolve; });
  server.fetch = async (input, init) => {
    if (init?.method === 'PUT' && /\/parts\/1$/.test(String(input))) {
      return new Response(JSON.stringify({ success: false, error: 'no', code: 'UPLOAD_PART_TOO_LARGE' }), { status: 400 });
    }
    if (init?.method === 'PUT' && /\/parts\/2$/.test(String(input))) {
      // Lane B is mid-flight when lane A is refused; it lands only after the refusal.
      await part2Gate;
      return original(input, init);
    }
    return original(input, init);
  };
  const progress: Array<{ p: UploadProgress; afterReject: boolean }> = [];
  let rejected = false;
  const run = uploadLarge(file, 'post', { fetchImpl: server.fetch, storage: memoryStorage(), onProgress: (p) => progress.push({ p, afterReject: rejected }), retries: 0 });
  // The refusal must not wait for the sibling: the promise settles while part 2 is still held.
  const settled = await Promise.race([run.then(() => 'resolved', () => 'rejected'), new Promise<string>((r) => setTimeout(() => r('pending'), 200))]);
  releasePart2();
  if (settled === 'pending') await assert.rejects(run);
  else assert.equal(settled, 'rejected');
  rejected = true;
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(progress.some((x) => x.p.phase === 'uploading'), 'the upload was under way');
  assert.deepEqual(progress.filter((x) => x.afterReject), [], 'no progress event after the rejection');
  assert.ok(!progress.some((x) => x.p.phase === 'uploading' && x.p.part === 2), 'the late part is never reported as landed');
  assert.ok(!server.calls.some((c) => c.includes('/complete')), 'never completed');
});

test('uploadLarge: a cancel deletes the session and rejects ABORTED; leaving with UPLOAD_KEEP_SESSION keeps the record', async () => {
  const { file } = sampleFile(2500);
  const storage = memoryStorage();
  const server = fakeServer(1000);
  const controller = new AbortController();
  const slow = server.fetch;
  server.fetch = async (input, init) => {
    if (init?.method === 'PUT') controller.abort();
    return slow(input, init);
  };
  await assert.rejects(uploadLarge(file, 'post', { fetchImpl: server.fetch, storage, signal: controller.signal }), (e: unknown) => e instanceof ApiError && e.code === 'ABORTED');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(server.deleted, true, 'the session was deleted');
  assert.equal(storage.map.size, 0);

  const keep = fakeServer(1000);
  const keepController = new AbortController();
  const base = keep.fetch;
  keep.fetch = async (input, init) => {
    if (init?.method === 'PUT') keepController.abort(UPLOAD_KEEP_SESSION);
    return base(input, init);
  };
  const storage2 = memoryStorage();
  await assert.rejects(uploadLarge(file, 'post', { fetchImpl: keep.fetch, storage: storage2, signal: keepController.signal }), (e: unknown) => e instanceof ApiError && e.code === 'ABORTED');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(keep.deleted, false, 'navigating away keeps the session');
  assert.equal(storage2.map.size, 1, 'and the record that finds it again');
});

test('the tile’s strings exist in all three languages with real Sorani, and sizes read in Latin units', () => {
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const t = UPLOAD_STRINGS[lang];
    for (const key of ['hashing', 'uploading', 'finishing', 'done', 'failed', 'cancelled', 'cancel', 'retry', 'of'] as const) assert.ok(t[key].trim(), `${lang}.${key}`);
    assert.ok(t.part(2, 5).includes('2') && t.part(2, 5).includes('5'));
    assert.ok(t.cellular('30 MB').includes('30 MB'));
  }
  assert.notEqual(UPLOAD_STRINGS.ckb.cancel, UPLOAD_STRINGS.ar.cancel, 'ckb is not the Arabic');
  assert.notEqual(UPLOAD_STRINGS.ckb.hashing, UPLOAD_STRINGS.ar.hashing);
  assert.equal(UPLOAD_STRINGS.ar.cancel, 'إلغاء');
  assert.equal(UPLOAD_STRINGS.ar.retry, 'إعادة المحاولة');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(3 * 1024), '3 KB');
  assert.equal(formatBytes(3.25 * MiB), '3.3 MB');
  assert.equal(formatBytes(41 * MiB), '41 MB');
  assert.equal(formatBytes(1.5 * 1024 * MiB), '1.50 GB');
});
