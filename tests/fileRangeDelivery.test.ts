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
 * P2c (perf plan §B.1 #9) adds the PUBLIC clip: a merchant's product video
 * or reel is read from R2 whole and once, stored whole in the edge cache, and
 * every range — the opening probe, every seek, every replay by every visitor
 * of that colo — is cut from the stored file. Two ranges used to cost two
 * HEADs and two GETs from R2's region; they now cost one GET and then nothing.
 *
 * Run: node --import tsx --test tests/fileRangeDelivery.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, ctx, freshDb, pending, stubApp, type StubUser } from './fixtures/app';
import { answerRangeFromFull, edgeCachePutKey, fileRoutes, parseByteRange, sliceStream } from '../worker/routes/uploads';

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

// ------------------------------------- a PUBLIC clip: the range comes from the edge (P2c, plan §B.1 #9)

/**
 * `caches.default` as the Workers runtime provides it, minus the slicing it
 * does on its own: a stored whole file comes back as the 200 it was stored
 * as, and the route slices it. (On Cloudflare a ranged `match` is answered
 * with a 206 by the cache itself; the route passes such a hit through — the
 * stub exercises the other branch, which is the one that must exist for the
 * pattern to be safe on any runtime.)
 */
class MemCache {
  store = new Map<string, { status: number; headers: [string, string][]; bytes: Uint8Array }>();
  async match(req: Request) {
    const e = this.store.get(req.url);
    return e ? new Response(e.bytes.slice(), { status: e.status, headers: e.headers }) : undefined;
  }
  async put(req: Request, res: Response) {
    const headers: [string, string][] = [];
    res.headers.forEach((v, k) => headers.push([k, v]));
    this.store.set(req.url, { status: res.status, headers, bytes: new Uint8Array(await res.arrayBuffer()) });
  }
}

const PUBLIC_CLIP_KEY = 'merchants/ali/public/reel.mp4';

function publicSetup() {
  const raw = freshDb();
  const bucket = new RangeBucket();
  bucket.objects.set(PUBLIC_CLIP_KEY, CLIP);
  const cache = new MemCache();
  const app = stubApp(asD1(raw), null, (a) => a.route('/files', fileRoutes), {
    env: { BUCKET: bucket, R2_PRIVATE: bucket, R2_PUBLIC: bucket },
  });
  const g = globalThis as { caches?: unknown };
  const fetchIt = async (headers: Record<string, string> = {}, path = `/files/${PUBLIC_CLIP_KEY}`) => {
    const before = g.caches;
    g.caches = { default: cache };
    try {
      const res = await app.request(path, { headers }, undefined, ctx);
      // Let the `waitUntil` cache write land before the next request asks.
      await Promise.all(pending.splice(0));
      return res;
    } finally {
      g.caches = before;
      if (before === undefined) delete g.caches;
    }
  };
  return { bucket, cache, fetchIt };
}

test('a public clip: the first range costs ONE R2 GET (no HEAD) and stores the whole file; the second costs nothing', async () => {
  const { bucket, cache, fetchIt } = publicSetup();
  const probe = await fetchIt({ Range: 'bytes=0-1' });
  assert.equal(probe.status, 206);
  assert.equal(probe.headers.get('Content-Range'), `bytes 0-1/${CLIP.byteLength}`);
  assert.equal(probe.headers.get('Content-Length'), '2');
  assert.equal(probe.headers.get('Accept-Ranges'), 'bytes');
  assert.equal(probe.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
  assert.deepEqual([...new Uint8Array(await probe.arrayBuffer())], [0, 1]);
  assert.deepEqual(bucket.reads, [`get ${PUBLIC_CLIP_KEY}`], 'one whole GET — no HEAD, no ranged GET');

  // What was stored is the WHOLE file, under the plain key, as a 200.
  const stored = [...cache.store.entries()];
  assert.equal(stored.length, 1);
  const [url, entry] = stored[0];
  assert.ok(url.endsWith(`/files/${PUBLIC_CLIP_KEY}`), url);
  assert.equal(entry.status, 200);
  assert.equal(entry.bytes.byteLength, CLIP.byteLength);
  assert.equal(new Headers(entry.headers).get('Content-Length'), String(CLIP.byteLength));
  assert.equal(new Headers(entry.headers).get('Content-Range'), null, 'never a partial body as if it were the file');

  // The seek — served from the edge; R2 is not asked again.
  const seek = await fetchIt({ Range: 'bytes=500-' });
  assert.equal(seek.status, 206);
  assert.equal(seek.headers.get('Content-Range'), `bytes 500-999/${CLIP.byteLength}`);
  const bytes = new Uint8Array(await seek.arrayBuffer());
  assert.equal(bytes.byteLength, 500);
  assert.equal(bytes[0], 500 % 251);
  assert.equal(bytes[499], 999 % 251);
  const tail = await fetchIt({ Range: 'bytes=-4' });
  assert.deepEqual([...new Uint8Array(await tail.arrayBuffer())], [...CLIP.slice(996)]);
  assert.deepEqual(bucket.reads, [`get ${PUBLIC_CLIP_KEY}`], 'two more ranges, zero more R2 operations');

  // And the plain request is the same cached whole file.
  const whole = await fetchIt();
  assert.equal(whole.status, 200);
  assert.equal((await whole.arrayBuffer()).byteLength, CLIP.byteLength);
  assert.deepEqual(bucket.reads, [`get ${PUBLIC_CLIP_KEY}`]);
});

test('a public clip: 416, an ignored range and If-Range behave from the cache exactly as from the bucket', async () => {
  const { bucket, fetchIt } = publicSetup();
  await fetchIt(); // prime
  const past = await fetchIt({ Range: 'bytes=5000-' });
  assert.equal(past.status, 416);
  assert.equal(past.headers.get('Content-Range'), `bytes */${CLIP.byteLength}`);
  const multi = await fetchIt({ Range: 'bytes=0-1,4-5' });
  assert.equal(multi.status, 200, 'several spans are ignored, not refused');
  assert.equal((await multi.arrayBuffer()).byteLength, CLIP.byteLength);
  const stale = await fetchIt({ Range: 'bytes=0-1', 'If-Range': '"an-older-etag"' });
  assert.equal(stale.status, 200, 'a changed file is served whole, never spliced');
  const same = await fetchIt({ Range: 'bytes=0-1', 'If-Range': `"etag-${PUBLIC_CLIP_KEY.length}"` });
  assert.equal(same.status, 206);
  assert.deepEqual(bucket.reads, [`get ${PUBLIC_CLIP_KEY}`], 'all of it from the edge');
});

test('a public clip on a cold colo: a 416 and a 304 read no body, and the 304 needs no HEAD', async () => {
  const { bucket, fetchIt } = publicSetup();
  const past = await fetchIt({ Range: 'bytes=5000-' });
  assert.equal(past.status, 416);
  assert.deepEqual(bucket.reads, [`get ${PUBLIC_CLIP_KEY}`], 'the size came from the one GET; no HEAD');
  const fresh = publicSetup();
  const cond = await fresh.fetchIt({ 'If-None-Match': `"etag-${PUBLIC_CLIP_KEY.length}"` });
  assert.equal(cond.status, 304);
  assert.deepEqual(fresh.bucket.reads, [`get ${PUBLIC_CLIP_KEY}`], 'one operation, its body released unread');
});

test('a PRIVATE clip never enters the shared cache, ranged or not', async () => {
  const { fetchAs, bucket } = setup();
  const cache = new MemCache();
  const g = globalThis as { caches?: unknown };
  g.caches = { default: cache };
  try {
    const res = await fetchAs(OWNER, { Range: 'bytes=0-1' });
    assert.equal(res.status, 206);
    const whole = await fetchAs(OWNER);
    assert.equal(whole.status, 200);
    await Promise.all(pending.splice(0));
  } finally {
    delete g.caches;
  }
  assert.equal(cache.store.size, 0, 'a private object was written to the shared edge cache');
  assert.deepEqual(bucket.reads, [`head ${KEY}`, `get ${KEY} 0+2`, `get ${KEY}`], 'the private path is unchanged: HEAD, ranged GET, whole GET');
});

test('sliceStream and answerRangeFromFull — the pieces the cached answer is cut with', async () => {
  const bytes = async (s: ReadableStream<Uint8Array>) => [...new Uint8Array(await new Response(s).arrayBuffer())];
  const src = () => new Blob([Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) as unknown as BlobPart]).stream();
  assert.deepEqual(await bytes(sliceStream(src(), 0, 2)), [0, 1]);
  assert.deepEqual(await bytes(sliceStream(src(), 3, 4)), [3, 4, 5, 6]);
  assert.deepEqual(await bytes(sliceStream(src(), 8, 2)), [8, 9]);
  // Chunk boundaries do not matter: a source delivered byte by byte slices the same.
  const trickle = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < 10; i++) c.enqueue(Uint8Array.of(i));
      c.close();
    },
  });
  assert.deepEqual(await bytes(sliceStream(trickle, 3, 4)), [3, 4, 5, 6]);

  const full = () =>
    new Response(Uint8Array.from({ length: 10 }, (_, i) => i), { headers: { 'Content-Length': '10', etag: '"v1"', 'Content-Type': 'video/mp4' } });
  const part = answerRangeFromFull(full(), 'bytes=2-4', undefined);
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('Content-Range'), 'bytes 2-4/10');
  assert.equal(part.headers.get('Content-Length'), '3');
  assert.equal(part.headers.get('Content-Type'), 'video/mp4', 'the stored headers travel with the slice');
  assert.deepEqual([...new Uint8Array(await part.arrayBuffer())], [2, 3, 4]);
  assert.equal(answerRangeFromFull(full(), 'bytes=10-', undefined).status, 416);
  assert.equal(answerRangeFromFull(full(), 'bytes=0-1', '"v0"').status, 200, 'If-Range mismatch: the whole file');
  assert.equal(answerRangeFromFull(full(), 'items=0-1', undefined).status, 200, 'another unit: ignored');
  const noLength = new Response('abc', { headers: { etag: '"v1"' } });
  noLength.headers.delete('Content-Length');
  assert.equal(answerRangeFromFull(noLength, 'bytes=0-1', undefined).status, 200, 'no size, no guessing');
  // The whole file's Range header is never the cache key: the entry is written under the plain request.
  const put = edgeCachePutKey(new Request('https://levonis-iq.com/files/products/a.mp4', { headers: { Range: 'bytes=0-1', 'If-Range': '"x"' } }), 'products/a.mp4');
  assert.equal(put.headers.get('Range'), null);
  assert.equal(put.headers.get('If-Range'), null);
  assert.equal(put.url, 'https://levonis-iq.com/files/products/a.mp4');
});
