/**
 * A SUPPORT VIDEO HAS TO PLAY ON THE OWNER'S iPAD.
 *
 * `/files/*` answered every request with the whole object and a 200, and said
 * nothing about ranges. Safari on iPhone and iPad will not play a `<video>`
 * from a server like that: it opens with `Range: bytes=0-1`, and a 200 carrying
 * forty megabytes is its sign that the server cannot stream. Private clips —
 * a print peeling off the bed, sent in «تذاكري» — are never edge-cached, so
 * nothing in front of the Worker ever answered the range for them either.
 *
 * These tests pin the three answers a player needs — 206 with the bytes it
 * asked for, 416 for a range past the end, `Accept-Ranges: bytes` on every
 * answer — and the one that matters most: a range is a way of READING a file,
 * so it is answered only after the file's own authorisation, and a stranger's
 * range request touches no byte in the bucket.
 *
 * Run: node --import tsx --test tests/fileRangeDelivery.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, ctx, freshDb, stubApp, type StubUser } from './fixtures/app';
import { fileRoutes, parseByteRange } from '../worker/routes/uploads';

// ------------------------------------------------------------- the parser

test('parseByteRange — the three forms a player sends, clamped to the file', () => {
  assert.deepEqual(parseByteRange('bytes=0-1', 100), { offset: 0, length: 2 });
  assert.deepEqual(parseByteRange('bytes=10-', 100), { offset: 10, length: 90 });
  assert.deepEqual(parseByteRange('bytes=-10', 100), { offset: 90, length: 10 });
  assert.deepEqual(parseByteRange('bytes=90-500', 100), { offset: 90, length: 10 }, 'an end past the file is the last byte');
  assert.deepEqual(parseByteRange('bytes=-500', 100), { offset: 0, length: 100 }, 'a suffix longer than the file is the file');
  assert.deepEqual(parseByteRange('BYTES = 5 - 5', 100), { offset: 5, length: 1 });
});

test('parseByteRange — past the end is a 416; nonsense is ignored rather than refused', () => {
  assert.equal(parseByteRange('bytes=100-', 100), 'unsatisfiable');
  assert.equal(parseByteRange('bytes=150-200', 100), 'unsatisfiable');
  assert.equal(parseByteRange('bytes=-0', 100), 'unsatisfiable');
  assert.equal(parseByteRange('bytes=0-1', 0), 'unsatisfiable');
  // RFC 9110: a range the server does not understand is IGNORED — the whole
  // file is served — never turned into an error.
  assert.equal(parseByteRange('bytes=0-1,5-6', 100), null, 'several spans');
  assert.equal(parseByteRange('bytes=9-3', 100), null, 'backwards');
  assert.equal(parseByteRange('items=0-1', 100), null, 'another unit');
  assert.equal(parseByteRange('bytes=-', 100), null);
  assert.equal(parseByteRange('', 100), null);
});

// -------------------------------------------------------------- the route

/** An R2-shaped bucket that honours `range` and records every read. */
class RangeBucket {
  reads: string[] = [];
  objects = new Map<string, Uint8Array>();
  async get(key: string, options?: { range?: { offset: number; length: number } }) {
    this.reads.push(`get ${key}${options?.range ? ` ${options.range.offset}+${options.range.length}` : ''}`);
    const all = this.objects.get(key);
    if (!all) return null;
    const bytes = options?.range ? all.slice(options.range.offset, options.range.offset + options.range.length) : all;
    return {
      body: new Blob([bytes as unknown as BlobPart]).stream(),
      size: all.byteLength,
      httpEtag: `"etag-${key.length}"`,
      writeHttpMetadata(headers: Headers) {
        headers.set('Content-Type', 'video/mp4');
      },
    };
  }
  async head(key: string) {
    this.reads.push(`head ${key}`);
    const all = this.objects.get(key);
    return all ? { key, size: all.byteLength, httpEtag: `"etag-${key.length}"` } : null;
  }
}

const OWNER: StubUser = { id: 'u_owner', role: 'customer', email: 'o@x.co' };
const STRANGER: StubUser = { id: 'u_stranger', role: 'customer', email: 's@x.co' };
const KEY = 'support/tkt_mine/video/clip.mp4';
const CLIP = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);

function setup() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('u_owner','Owner','o@x.co','h','customer'), ('u_stranger','S','s@x.co','h','customer');
    INSERT INTO support_tickets (id,user_id,subject) VALUES ('tkt_mine','u_owner','Peeling');
  `);
  const bucket = new RangeBucket();
  bucket.objects.set(KEY, CLIP);
  const app = (user: StubUser | null) =>
    stubApp(asD1(raw), user, (a) => a.route('/files', fileRoutes), {
      env: { BUCKET: bucket, R2_PRIVATE: bucket, R2_PUBLIC: bucket },
    });
  const fetchAs = (user: StubUser | null, headers: Record<string, string> = {}) =>
    app(user).request(`/files/${KEY}`, { headers }, undefined, ctx);
  return { bucket, fetchAs };
}

test('Safari’s opening probe gets two bytes and a 206, not the whole clip', async () => {
  const { fetchAs } = setup();
  const res = await fetchAs(OWNER, { Range: 'bytes=0-1' });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('Content-Range'), `bytes 0-1/${CLIP.byteLength}`);
  assert.equal(res.headers.get('Content-Length'), '2');
  assert.equal(res.headers.get('Accept-Ranges'), 'bytes');
  assert.equal(res.headers.get('Content-Type'), 'video/mp4');
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [0, 1]);
});

test('a seek past the start and a suffix read return exactly those bytes', async () => {
  const { fetchAs } = setup();
  const mid = await fetchAs(OWNER, { Range: 'bytes=500-' });
  assert.equal(mid.status, 206);
  assert.equal(mid.headers.get('Content-Range'), `bytes 500-999/${CLIP.byteLength}`);
  const midBytes = new Uint8Array(await mid.arrayBuffer());
  assert.equal(midBytes.byteLength, 500);
  assert.equal(midBytes[0], 500 % 251);

  const tail = await fetchAs(OWNER, { Range: 'bytes=-4' });
  assert.equal(tail.status, 206);
  assert.equal(tail.headers.get('Content-Range'), `bytes 996-999/${CLIP.byteLength}`);
  assert.deepEqual([...new Uint8Array(await tail.arrayBuffer())], [...CLIP.slice(996)]);
});

test('a range past the end is a 416 that names the size, and reads no body', async () => {
  const { fetchAs, bucket } = setup();
  const res = await fetchAs(OWNER, { Range: 'bytes=5000-' });
  assert.equal(res.status, 416);
  assert.equal(res.headers.get('Content-Range'), `bytes */${CLIP.byteLength}`);
  assert.ok(!bucket.reads.some((r) => r.startsWith('get ')), 'the size came from a HEAD; no body was fetched');
});

test('a plain request is still the whole file, and now says it can do ranges', async () => {
  const { fetchAs } = setup();
  const res = await fetchAs(OWNER);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Accept-Ranges'), 'bytes');
  assert.equal((await res.arrayBuffer()).byteLength, CLIP.byteLength);
  // Several spans are ignored, not refused.
  const multi = await fetchAs(OWNER, { Range: 'bytes=0-1,4-5' });
  assert.equal(multi.status, 200);
});

test('If-Range for a file that has since changed gets the whole new file, not a splice', async () => {
  const { fetchAs } = setup();
  const res = await fetchAs(OWNER, { Range: 'bytes=0-1', 'If-Range': '"an-older-etag"' });
  assert.equal(res.status, 200);
  assert.equal((await res.arrayBuffer()).byteLength, CLIP.byteLength);
  const same = await fetchAs(OWNER, { Range: 'bytes=0-1', 'If-Range': `"etag-${KEY.length}"` });
  assert.equal(same.status, 206);
});

test('a range is a way of reading, not a way around who may read — a stranger touches no byte', async () => {
  const { fetchAs, bucket } = setup();
  const res = await fetchAs(STRANGER, { Range: 'bytes=0-1' });
  assert.equal(res.status, 403);
  const anon = await fetchAs(null, { Range: 'bytes=0-1' });
  assert.equal(anon.status, 403);
  assert.deepEqual(bucket.reads, [], 'neither HEAD nor GET reached the bucket');
});
