/**
 * A REVIEW'S VIDEO PLAYS ON AN iPHONE (perf plan §B.1 #9, P2c).
 *
 * `GET /api/reviews/media/*` streamed every object whole with a 200, and
 * Safari reads that as «this server cannot stream»: a customer's review clip
 * was a dead player on the phones most customers hold. The handler now gives
 * the three answers a player needs — 206 with the bytes asked for, 416 past
 * the end, `Accept-Ranges: bytes` everywhere — after the same authorisation
 * as before, with the same revocable `no-cache` policy, and never through a
 * shared cache: review media is private storage whose permission is asked of
 * the database on every request.
 *
 * Run: node --import tsx --test tests/reviewsMediaRange.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, ctx, freshDb, stubApp, type StubUser } from './fixtures/app';
import { reviewRoutes } from '../worker/routes/reviews';

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
      httpEtag: '"clip-v1"',
      writeHttpMetadata(headers: Headers) {
        headers.set('Content-Type', 'video/mp4');
      },
    };
  }
  async head(key: string) {
    this.reads.push(`head ${key}`);
    const all = this.objects.get(key);
    return all ? { key, size: all.byteLength, httpEtag: '"clip-v1"' } : null;
  }
}

const AUTHOR: StubUser = { id: 'u_author', role: 'customer', email: 'a@x.co' };
const STRANGER: StubUser = { id: 'u_other', role: 'customer', email: 'o@x.co' };
const PUBLISHED_KEY = 'reviews/u_author/video/pub.mp4';
const PENDING_KEY = 'reviews/u_other/video/pending.mp4';
const CLIP = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);

function setup() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('u_author','A','a@x.co','h','customer'), ('u_other','O','o@x.co','h','customer');
    INSERT INTO products (id, slug, name, price_iqd, status) VALUES ('p1','pla','PLA',1000,'active');
    INSERT INTO reviews (id,user_id,product_id,stars,body,media,status)
      VALUES ('rv_pub','u_author','p1',5,'good','[{"key":"${PUBLISHED_KEY}","kind":"video"}]','published');
  `);
  raw.exec(`
    INSERT INTO reviews (id,user_id,product_id,stars,body,media,status)
      VALUES ('rv_pending','u_other','p1',4,'ok','[{"key":"${PENDING_KEY}","kind":"video"}]','pending');
  `);
  const bucket = new RangeBucket();
  bucket.objects.set(PUBLISHED_KEY, CLIP);
  bucket.objects.set(PENDING_KEY, CLIP);
  const fetchAs = (user: StubUser | null, key: string, headers: Record<string, string> = {}) =>
    stubApp(asD1(raw), user, (a) => a.route('/api/reviews', reviewRoutes), {
      env: { BUCKET: bucket, R2_PRIVATE: bucket, R2_PUBLIC: bucket },
    }).request(`/api/reviews/media/${key}`, { headers }, undefined, ctx);
  return { bucket, fetchAs };
}

test('Safari’s opening probe on a published review video gets two bytes and a 206', async () => {
  const { fetchAs, bucket } = setup();
  const res = await fetchAs(null, PUBLISHED_KEY, { Range: 'bytes=0-1' });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('Content-Range'), `bytes 0-1/${CLIP.byteLength}`);
  assert.equal(res.headers.get('Content-Length'), '2');
  assert.equal(res.headers.get('Accept-Ranges'), 'bytes');
  assert.equal(res.headers.get('Content-Type'), 'video/mp4');
  assert.equal(res.headers.get('Cache-Control'), 'public, no-cache', 'the revocable policy is unchanged by a range');
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [0, 1]);
  assert.deepEqual(bucket.reads, [`head ${PUBLISHED_KEY}`, `get ${PUBLISHED_KEY} 0+2`]);
});

test('a seek, a suffix, a range past the end, an ignored range and If-Range', async () => {
  const { fetchAs } = setup();
  const mid = await fetchAs(null, PUBLISHED_KEY, { Range: 'bytes=500-' });
  assert.equal(mid.status, 206);
  assert.equal(mid.headers.get('Content-Range'), `bytes 500-999/${CLIP.byteLength}`);
  assert.equal(new Uint8Array(await mid.arrayBuffer())[0], 500 % 251);
  const tail = await fetchAs(null, PUBLISHED_KEY, { Range: 'bytes=-4' });
  assert.deepEqual([...new Uint8Array(await tail.arrayBuffer())], [...CLIP.slice(996)]);
  const past = await fetchAs(null, PUBLISHED_KEY, { Range: 'bytes=5000-' });
  assert.equal(past.status, 416);
  assert.equal(past.headers.get('Content-Range'), `bytes */${CLIP.byteLength}`);
  const multi = await fetchAs(null, PUBLISHED_KEY, { Range: 'bytes=0-1,4-5' });
  assert.equal(multi.status, 200);
  assert.equal((await multi.arrayBuffer()).byteLength, CLIP.byteLength);
  const stale = await fetchAs(null, PUBLISHED_KEY, { Range: 'bytes=0-1', 'If-Range': '"clip-v0"' });
  assert.equal(stale.status, 200, 'a changed file is served whole, never spliced');
  const same = await fetchAs(null, PUBLISHED_KEY, { Range: 'bytes=0-1', 'If-Range': '"clip-v1"' });
  assert.equal(same.status, 206);
});

test('the whole file still says it can do ranges, and a revalidation is still a 304', async () => {
  const { fetchAs } = setup();
  const whole = await fetchAs(null, PUBLISHED_KEY);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('Accept-Ranges'), 'bytes');
  assert.equal((await whole.arrayBuffer()).byteLength, CLIP.byteLength);
  const cond = await fetchAs(null, PUBLISHED_KEY, { 'If-None-Match': '"clip-v1"' });
  assert.equal(cond.status, 304);
  const condRange = await fetchAs(null, PUBLISHED_KEY, { 'If-None-Match': '"clip-v1"', Range: 'bytes=0-1' });
  assert.equal(condRange.status, 304, 'a browser that already holds the clip is told so before any byte');
});

test('a range is a way of reading, not a way around who may read', async () => {
  const { fetchAs, bucket } = setup();
  // An unpublished review's clip: only its author (or an admin) — a stranger and an anonymous visitor get 404.
  const anon = await fetchAs(null, PENDING_KEY, { Range: 'bytes=0-1' });
  assert.equal(anon.status, 404);
  const stranger = await fetchAs(AUTHOR, PENDING_KEY, { Range: 'bytes=0-1' });
  assert.equal(stranger.status, 404);
  assert.deepEqual(bucket.reads, [], 'neither HEAD nor GET reached the bucket');
  const owner = await fetchAs(STRANGER, PENDING_KEY, { Range: 'bytes=0-1' });
  assert.equal(owner.status, 206, 'the author of the pending review may play their own clip');
  assert.equal(owner.headers.get('Cache-Control'), 'private, no-cache');
});
