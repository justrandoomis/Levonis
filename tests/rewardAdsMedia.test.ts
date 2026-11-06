/**
 * THE AD'S FILE, FROM THE OWNER'S UPLOAD TO A CUSTOMER'S PHONE (owner's ad:
 * 720×1280, 47.5 s, H.264 + AAC, fast start; migration 0227; docs/DECISIONS.md row
 * 300).
 *
 * An admin-only purpose, `reward_ad`, on both upload doors: the whole body below
 * 8 MiB, a resumable session above it. Public. An MP4 whose index comes first, or
 * refused. And then the part that decides whether a phone can play it at all:
 * `/files/<key>` answering `Range` with a 206 to anyone, and the shop's CSP letting
 * the page load it. Real routes, a real bucket double that honours ranges and
 * multipart parts, and structurally real MP4 bytes.
 *
 * Run: node --import tsx --test tests/rewardAdsMedia.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ROOT } from './fixtures/d1';
import { asD1, ctx, freshDb, get, json, memoryBucket, OWNER, post, row, stubApp, type Mount, type StubUser } from './fixtures/app';
import { fileRoutes, uploadRoutes } from '../worker/routes/uploads';
import { uploadSessionRoutes } from '../worker/routes/uploadSessions';
import { adminRewardsRoutes } from '../worker/routes/adminRewards';
import { rewardRoutes } from '../worker/routes/rewards';
import { assertRewardAdVideo, placementFor, purposeAdmits, visibilityForKey } from '../worker/lib/uploadEntity';
import { isAnonymousPublicMediaKey } from '../worker/lib/mediaStorage';
import { mp4IndexComesFirst, sniffStoredMp4, sniffVideo } from '../worker/lib/videoSniff';
import { spaCsp } from '../worker/lib/securityPolicy';
import { MEDIA_REFERENCE_SOURCES, verifyMediaCoverage } from '../worker/lib/mediaRefs';
import { isPublicVariantKey } from '../packages/contracts/src/imageSizing';
import { REFUSAL_STRINGS } from '../src/lib/refusalStrings';

const MiB = 1024 * 1024;
const READ_SESSIONS = () => readFileSync(join(ROOT, 'worker/routes/uploadSessions.ts'), 'utf8');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
function box(type: string, ...payload: number[][]): number[] {
  const body = payload.flat();
  return [...u32(8 + body.length), ...ascii(type), ...body];
}
/** A structurally real H.264 MP4 with `mediaBytes` of frames, its index first or last. */
function mp4(order: 'moov-first' | 'mdat-first', mediaBytes = 64): Uint8Array {
  const stsd = box('stsd', [0, 0, 0, 0], u32(1), box('avc1', new Array(78).fill(0)));
  const trak = box('trak', box('mdia', box('hdlr', [0, 0, 0, 0], u32(0), ascii('vide'), new Array(12).fill(0)), box('minf', box('stbl', stsd))));
  const head = Uint8Array.from(box('ftyp', ascii('isom'), u32(512), ascii('isom'), ascii('mp41')));
  const moov = Uint8Array.from(box('moov', trak));
  const mdat = new Uint8Array(8 + mediaBytes);
  mdat.set(u32(8 + mediaBytes), 0);
  mdat.set(ascii('mdat'), 4);
  mdat.fill(7, 8);
  const parts = order === 'moov-first' ? [head, moov, mdat] : [head, mdat, moov];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
/** An index-first MP4 with its parts chosen: the shapes a head alone cannot tell apart. */
function film(o: { handler?: string; entry?: string; brand?: string; padding?: number; mediaBytes?: number; declaredMedia?: number; noFrames?: boolean } = {}): Uint8Array {
  const stsd = box('stsd', [0, 0, 0, 0], u32(1), box(o.entry ?? 'avc1', new Array(78).fill(0)));
  const trak = box('trak', box('mdia', box('hdlr', [0, 0, 0, 0], u32(0), ascii(o.handler ?? 'vide'), new Array(12).fill(0)), box('minf', box('stbl', stsd))));
  const head = Uint8Array.from(box('ftyp', ascii(o.brand ?? 'isom'), u32(512), ascii('isom')));
  // Padding before the track table puts the table out of a 64 KiB head's reach.
  const moov = Uint8Array.from(box('moov', ...(o.padding ? [box('udta', new Array(o.padding).fill(0))] : []), trak));
  const free = Uint8Array.from(box('free'));
  const mediaBytes = o.mediaBytes ?? 64;
  const mdat = new Uint8Array(o.noFrames ? 0 : 8 + mediaBytes);
  if (!o.noFrames) {
    mdat.set(u32(8 + (o.declaredMedia ?? mediaBytes)), 0);
    mdat.set(ascii('mdat'), 4);
  }
  const out = new Uint8Array(head.length + moov.length + free.length + mdat.length);
  out.set(head, 0);
  out.set(moov, head.length);
  out.set(free, head.length + moov.length);
  out.set(mdat, head.length + moov.length + free.length);
  return out;
}
/** A minimal lossy WebP header: all the sniff needs, and WebP is stored as it came. */
const webpBytes = () => Uint8Array.from([...ascii('RIFF'), ...[60, 0, 0, 0], ...ascii('WEBP'), ...ascii('VP8 '), ...new Array(52).fill(0)]);
const ebmlBytes = () => Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, ...new Array(40).fill(0)]);

const customer: StubUser = { id: 'u1', role: 'customer', email: 'a@x.co' };
const mounts: Mount = (a) => {
  a.route('/api/uploads/sessions', uploadSessionRoutes);
  a.route('/api/uploads', uploadRoutes);
  a.route('/files', fileRoutes);
  a.route('/api/admin/rewards', adminRewardsRoutes);
  a.route('/api/rewards', rewardRoutes);
};

function world() {
  const raw = freshDb();
  raw.exec(`INSERT INTO users (id,name,email,password_hash,role) VALUES ('usr_owner','Owner','boss@x.co','h','admin'), ('u1','Sara','a@x.co','h','customer')`);
  const bucket = memoryBucket();
  const as = (user: StubUser | null) => stubApp(asD1(raw), user, mounts, { publishV2: false, env: { BUCKET: bucket, R2_PUBLIC: bucket, R2_PRIVATE: bucket } });
  return { raw, bucket, as };
}

function whole(a: ReturnType<ReturnType<typeof world>['as']>, bytes: Uint8Array, name = 'ad.mp4', type = 'video/mp4') {
  const form = new FormData();
  form.set('purpose', 'reward_ad');
  form.set('file', new File([bytes as unknown as BlobPart], name, { type }));
  return a.request('/api/uploads', { method: 'POST', headers: { 'CF-Connecting-IP': '1.2.3.4' }, body: form }, undefined, ctx);
}

async function sendParts(a: ReturnType<ReturnType<typeof world>['as']>, bytes: Uint8Array, name = 'ad.mp4') {
  const opened = await post(a, '/api/uploads/sessions', { purpose: 'reward_ad', file_name: name, bytes: bytes.length, mime: 'video/mp4', sha256: sha(bytes) });
  const body = await json(opened);
  assert.equal(opened.status, 201, JSON.stringify(body));
  for (let n = 1, off = 0; off < bytes.length; n++, off += body.chunk_bytes as number) {
    const part = await a.request(
      `/api/uploads/sessions/${body.session_id}/parts/${n}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream', 'CF-Connecting-IP': '1.2.3.4' },
        body: bytes.subarray(off, Math.min(off + (body.chunk_bytes as number), bytes.length)) as unknown as BodyInit,
      },
      undefined,
      ctx
    );
    assert.equal(part.status, 200, `part ${n}`);
  }
  return body;
}

// ------------------------------------------------------------ the rule

test('fast start is decided from the first bytes: a truncated head of a real file answers, where the old check could not', () => {
  const fast = mp4('moov-first', 200_000);
  const slow = mp4('mdat-first', 200_000);
  const head = (b: Uint8Array) => b.subarray(0, 64 * 1024);
  assert.equal(mp4IndexComesFirst(head(fast)), true);
  assert.equal(mp4IndexComesFirst(head(slow)), false, 'the frames come first, the index is not even in sight');
  assert.equal(mp4IndexComesFirst(fast), true);
  assert.equal(mp4IndexComesFirst(slow), false);
  assert.equal(mp4IndexComesFirst(new Uint8Array(10)), false, 'not an MP4 at all');
  // A large `free` box before the index: as the encoder wrote it, nothing shows the index is near.
  const freeFirst = new Uint8Array(70_000);
  freeFirst.set(box('ftyp', ascii('isom'), u32(512)), 0);
  const at = 16;
  freeFirst.set(u32(200_000), at);
  freeFirst.set(ascii('free'), at + 4);
  assert.equal(mp4IndexComesFirst(freeFirst), false);
  assert.throws(() => assertRewardAdVideo('video/webm', fast), /MP4/);
  assert.doesNotThrow(() => assertRewardAdVideo('video/mp4', head(fast)));
});

test('the purpose: an admin’s, public, one folder, nothing but a picture or a video', () => {
  assert.equal(purposeAdmits('reward_ad', 'video'), true);
  assert.equal(purposeAdmits('reward_ad', 'image'), true);
  assert.equal(purposeAdmits('reward_ad', 'model'), false);
  assert.equal(purposeAdmits('reward_ad', 'document'), false);
  assert.deepEqual(placementFor('reward_ad', 'video', { userId: 'u', entityId: '', mime: 'video/mp4' }), { visibility: 'public', domain: 'rewards', entityId: 'ads', kind: 'video' });
  assert.equal(placementFor('reward_ad', 'image', { userId: 'u', entityId: '', mime: 'image/webp' }).kind, 'poster');
  assert.equal(visibilityForKey('rewards/ads/video/x.mp4'), 'public');
  assert.equal(isAnonymousPublicMediaKey('rewards/ads/video/x.mp4'), true);
  assert.equal(isAnonymousPublicMediaKey('rewards/other/x.mp4'), false, 'the line opens this folder and nothing beside it');
  assert.equal(visibilityForKey('rewards/other/x.mp4'), 'private');
  assert.equal(isPublicVariantKey('rewards/ads/poster/x.webp'), true, 'the client’s copy of the rule agrees');
  assert.equal(isPublicVariantKey('rewards/other/x.webp'), false);
});

// ------------------------------------------------------------ the whole-body door

test('THE WHOLE-BODY DOOR: the owner’s MP4 lands public under rewards/ads/video; a customer is refused before a byte is stored', async () => {
  const { raw, bucket, as } = world();
  const refused = await whole(as(customer), mp4('moov-first'));
  assert.equal(refused.status, 403);
  assert.equal(bucket.objects.size, 0);

  const res = await whole(as(OWNER), mp4('moov-first'));
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.match(String(body.key), /^rewards\/ads\/video\/[a-z0-9]+\.mp4$/);
  assert.equal(body.url, `/files/${body.key}`);
  assert.equal(body.visibility, 'public');
  assert.equal(body.mime, 'video/mp4');
  assert.equal('warnings' in body, false);
  assert.equal(bucket.objects.get(String(body.key))?.contentType, 'video/mp4');
  const ledger = row<{ purpose: string; visibility: string; mime_type: string }>(raw, 'SELECT purpose, visibility, mime_type FROM file_objects WHERE object_key = ?', body.key)!;
  assert.deepEqual({ ...ledger }, { purpose: 'reward_ad', visibility: 'public', mime_type: 'video/mp4' });
});

test('a late-index MP4, a WebM and a forged video are refused at the whole-body door; here it is a refusal, not the merchant’s hint', async () => {
  const { bucket, as } = world();
  const owner = as(OWNER);
  const slow = await whole(owner, mp4('mdat-first'));
  assert.equal(slow.status, 400);
  assert.equal((await json(slow)).code, 'REWARD_AD_NOT_FASTSTART');
  const webm = await whole(owner, ebmlBytes(), 'ad.webm', 'video/webm');
  assert.equal(webm.status, 400);
  assert.equal((await json(webm)).code, 'VIDEO_UNSUPPORTED', 'not even a video: named as such');
  const forged = await whole(owner, Uint8Array.from([...box('ftyp', ascii('isom'), u32(512)), ...new Array(40).fill(0)]));
  assert.equal(forged.status, 400);
  assert.equal(bucket.objects.size, 0, 'nothing refused is stored');
});

test('a poster lands public beside it, as a picture', async () => {
  const { bucket, as } = world();
  const res = await whole(as(OWNER), webpBytes(), 'poster.webp', 'image/webp');
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.match(String(body.key), /^rewards\/ads\/poster\/[a-z0-9]+\.webp$/);
  assert.equal(bucket.objects.size, 1);
});

// ------------------------------------------------------------ the resumable door

test('THE RESUMABLE DOOR, over 8 MiB: an admin’s, in parts, proved by its head and its checksum, answering the key and the public address', async () => {
  const { raw, bucket, as } = world();
  const bytes = mp4('moov-first', 9 * MiB);
  const refused = await post(as(customer), '/api/uploads/sessions', { purpose: 'reward_ad', file_name: 'ad.mp4', bytes: bytes.length, mime: 'video/mp4', sha256: sha(bytes) });
  assert.equal(refused.status, 403, 'a customer opens no session for this');

  const owner = as(OWNER);
  const opened = await sendParts(owner, bytes);
  assert.ok(opened.parts_total >= 2, 'a real multipart upload');
  const done = await post(owner, `/api/uploads/sessions/${opened.session_id}/complete`, {});
  const body = await json(done);
  assert.equal(done.status, 200, JSON.stringify(body));
  assert.match(String(body.key), /^rewards\/ads\/video\/[a-z0-9]+\.mp4$/, 'the same place the whole-body door files it');
  assert.equal(body.url, `/files/${body.key}`);
  assert.equal(body.visibility, 'public');
  assert.equal(body.mime, 'video/mp4');
  assert.equal(bucket.objects.get(String(body.key))?.bytes.length, bytes.length);
  assert.equal(row<{ purpose: string }>(raw, 'SELECT purpose FROM file_objects WHERE object_key = ?', body.key)!.purpose, 'reward_ad');
});

test('at the resumable door a late-index MP4 is refused at the end and its object is deleted; a .webm name is refused before a byte travels', async () => {
  const { raw, bucket, as } = world();
  const owner = as(OWNER);
  const named = await post(owner, '/api/uploads/sessions', { purpose: 'reward_ad', file_name: 'ad.webm', bytes: 100, mime: 'video/webm', sha256: sha(new Uint8Array(100)) });
  assert.equal(named.status, 400);
  assert.equal((await json(named)).code, 'REWARD_AD_MP4_REQUIRED');
  const model = await post(owner, '/api/uploads/sessions', { purpose: 'reward_ad', file_name: 'part.stl', bytes: 100, mime: '', sha256: sha(new Uint8Array(100)) });
  assert.equal((await json(model)).code, 'UPLOAD_KIND_NOT_ALLOWED');

  const slow = mp4('mdat-first', 9 * MiB);
  const opened = await sendParts(owner, slow);
  const done = await post(owner, `/api/uploads/sessions/${opened.session_id}/complete`, {});
  assert.equal(done.status, 400);
  assert.equal((await json(done)).code, 'REWARD_AD_NOT_FASTSTART');
  assert.equal(bucket.objects.size, 0, 'nothing is left in the bucket that no ledger row names');
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM upload_sessions WHERE id = ?', opened.session_id)!.state, 'aborted');
});

test('a stored MP4 is proven whole and a film from a few small reads: what the whole-body door proves, of a file too large to read back', async () => {
  const HEAD = 64 * 1024;
  const prove = async (bytes: Uint8Array) => {
    const reads: Array<[number, number]> = [];
    const verdict = await sniffStoredMp4(bytes.subarray(0, Math.min(HEAD, bytes.length)), bytes.length, async (offset, length) => {
      reads.push([offset, length]);
      return bytes.subarray(offset, offset + length);
    });
    return { verdict, reads };
  };
  const good = await prove(film());
  assert.deepEqual(good.verdict, { ok: true, mime: 'video/mp4', ext: 'mp4', codec: 'avc1' });
  assert.deepEqual(good.reads, [], 'all of it in the head');
  assert.deepEqual((await prove(film({ entry: 'hvc1' }))).verdict, { ok: true, mime: 'video/mp4', ext: 'mp4', codec: 'hvc1' }, 'HEVC as the whole-body door takes it');

  // The whole film is 9 MiB and is never read: a head, then only what lies past it.
  const large = await prove(film({ padding: 200_000, mediaBytes: 9 * MiB }));
  assert.equal(large.verdict.ok, true, 'a track table past the head is read on its own');
  assert.ok(large.reads.every(([, length]) => length <= 300_000), JSON.stringify(large.reads));
  assert.ok(large.reads.length <= 3, 'a few small ranges');

  const refused: Array<[string, Uint8Array, string]> = [
    ['cut off mid-film: it declares frames it does not have', film({ mediaBytes: 64, declaredMedia: 9 * MiB }), 'malformed'],
    ['cut off inside its index', film({ padding: 200_000 }).subarray(0, 100_000), 'malformed'],
    ['sound alone', film({ handler: 'soun', entry: 'mp4a' }), 'no_video_track'],
    ['sound alone, by its brand', film({ brand: 'M4A ' }), 'audio_only'],
    ['a photograph in the same container', film({ brand: 'heic' }), 'image_container'],
    ['a track in a codec nothing plays', film({ entry: 'mp4v' }), 'codec_unsupported'],
    ['an index and no frames', film({ noFrames: true }), 'malformed'],
    ['not an MP4 at all', new Uint8Array(40), 'malformed'],
  ];
  for (const [what, bytes, reason] of refused) {
    assert.deepEqual((await prove(bytes)).verdict, { ok: false, reason }, what);
  }
});

test('THE RESUMABLE DOOR ASKS WHAT THE WHOLE-BODY DOOR ASKS: a truncated film and sound alone are refused at the end, by the same code, and deleted', async () => {
  const { raw, bucket, as } = world();
  const owner = as(OWNER);
  const cases: Array<[string, Uint8Array, string]> = [
    ['truncated', film({ mediaBytes: 64, declaredMedia: 9 * MiB }), 'malformed'],
    ['audio only', film({ handler: 'soun', entry: 'mp4a' }), 'no_video_track'],
  ];
  for (const [what, bytes, reason] of cases) {
    const opened = await sendParts(owner, bytes);
    const done = await post(owner, `/api/uploads/sessions/${opened.session_id}/complete`, {});
    const body = await json(done);
    assert.equal(done.status, 400, what);
    assert.equal(body.code, 'VIDEO_UNSUPPORTED', what);
    assert.equal(body.details?.reason ?? body.reason, reason, what);
    assert.equal(bucket.objects.size, 0, `${what}: nothing is left in the bucket`);
    assert.equal(row<{ state: string }>(raw, 'SELECT state FROM upload_sessions WHERE id = ?', opened.session_id)!.state, 'aborted', what);
    // The whole-body door, for the same bytes: one answer.
    const other = await whole(owner, bytes);
    assert.equal(other.status, 400, what);
    assert.equal((await json(other)).code, 'VIDEO_UNSUPPORTED', what);
  }

  // A real film whose track table lies past the head still passes, in parts.
  const large = film({ padding: 200_000, mediaBytes: 9 * MiB });
  const opened = await sendParts(owner, large);
  assert.ok(opened.parts_total >= 2);
  const done = await post(owner, `/api/uploads/sessions/${opened.session_id}/complete`, {});
  assert.equal(done.status, 200, JSON.stringify(await done.clone().json()));

  // A merchant's clip is not held to this: only an ad asks it.
  assert.match(READ_SESSIONS(), /if \(s\.purpose === 'reward_ad'\) \{\s*assertRewardAdVideo\(mime, head\);\s*\/\/[^\n]*\s*const film = await sniffStoredMp4\(head, size,/);
});

// ------------------------------------------------------------ to a phone

test('/files SERVES IT TO A PHONE WITH RANGE: a signed-out request, Safari’s opening probe, a seek, the tail, and past the end', async () => {
  const { as, bucket } = world();
  // What the door asks the bucket to keep with the object. R2 keeps it; this double's multipart drops it.
  const asked: unknown[] = [];
  const open = bucket.createMultipartUpload.bind(bucket);
  bucket.createMultipartUpload = async (key: string, options?: unknown) => {
    asked.push(options);
    return open(key, options);
  };
  const bytes = mp4('moov-first', 9 * MiB);
  const owner = as(OWNER);
  const opened = await sendParts(owner, bytes);
  const { url, key } = await json(await post(owner, `/api/uploads/sessions/${opened.session_id}/complete`, {}));
  assert.deepEqual(asked, [{ httpMetadata: { contentType: 'video/mp4', cacheControl: 'public, max-age=31536000, immutable' } }]);
  bucket.objects.get(String(key))!.contentType = 'video/mp4';
  const anyone = as(null);
  const size = bytes.length;

  const whole = await get(anyone, url);
  assert.equal(whole.status, 200, 'public: no sign-in');
  assert.equal(whole.headers.get('Accept-Ranges'), 'bytes');
  assert.equal(whole.headers.get('Content-Type'), 'video/mp4');
  assert.equal(whole.headers.get('Content-Length'), String(size));
  assert.equal(whole.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.match(String(whole.headers.get('Cache-Control')), /public/);
  await whole.body?.cancel();

  // Safari opens every <video> with exactly this, and a 200 here means «cannot stream».
  const probe = await get(anyone, url, { Range: 'bytes=0-1' });
  assert.equal(probe.status, 206);
  assert.equal(probe.headers.get('Content-Range'), `bytes 0-1/${size}`);
  assert.equal(probe.headers.get('Content-Length'), '2');
  assert.equal(probe.headers.get('Content-Type'), 'video/mp4');
  assert.deepEqual([...new Uint8Array(await probe.arrayBuffer())], [...bytes.subarray(0, 2)]);

  const seek = await get(anyone, url, { Range: `bytes=${size - 100}-` });
  assert.equal(seek.status, 206);
  assert.equal(seek.headers.get('Content-Range'), `bytes ${size - 100}-${size - 1}/${size}`);
  assert.deepEqual([...new Uint8Array(await seek.arrayBuffer())], [...bytes.subarray(size - 100)]);

  const middle = await get(anyone, url, { Range: `bytes=8388600-8388615` });
  assert.equal(middle.status, 206, 'across the join of two multipart parts');
  assert.deepEqual([...new Uint8Array(await middle.arrayBuffer())], [...bytes.subarray(8388600, 8388616)]);

  const past = await get(anyone, url, { Range: `bytes=${size + 5}-` });
  assert.equal(past.status, 416);
  assert.equal(past.headers.get('Content-Range'), `bytes */${size}`);
});

test('the shop’s CSP lets the page load it, and the sniff agrees with what the door stored', () => {
  const directive = spaCsp().split(';').map((d) => d.trim()).find((d) => d.startsWith('media-src'));
  assert.ok(directive, 'the policy names media-src');
  assert.match(directive!, /'self'/, '/files is this origin');
  assert.deepEqual(sniffVideo(mp4('moov-first')), { ok: true, mime: 'video/mp4', ext: 'mp4', codec: 'avc1' });
});

// ------------------------------------------------------------ it stays

test('the sweep can never take a live ad: both columns are references, and the coverage audit stays whole', async () => {
  for (const column of ['video_url', 'poster_url']) {
    assert.ok(MEDIA_REFERENCE_SOURCES.some((s) => s.table === 'reward_ads' && s.column === column), column);
  }
  const raw: DatabaseSync = freshDb();
  raw.exec(`INSERT INTO reward_ads (id,video_url,poster_url,required_seconds,starts_at,ends_at,active)
            VALUES ('a','/files/rewards/ads/video/v.mp4','/files/rewards/ads/poster/p.webp',45,'2026-01-01','2026-02-01',0)`);
  const coverage = await verifyMediaCoverage(asD1(raw));
  assert.deepEqual(coverage.refusals, [], 'every key-bearing column is classified');
  assert.ok(coverage.scan.keys.has('rewards/ads/video/v.mp4'), 'an ad switched off still holds its video');
  assert.ok(coverage.scan.keys.has('rewards/ads/poster/p.webp'));
});

// ------------------------------------------------------------ a whole upload, to a published ad

test('uploaded through the real door, the file is what the form may name; published, a customer’s page plays it', async () => {
  const { raw, as } = world();
  const form = (video_url: string) => ({
    title_ar: 'إعلان',
    title_en: 'Ad',
    title_ckb: 'ڕیکلام',
    video_url,
    width: 720,
    height: 1280,
    duration_seconds: 47,
    starts_at: new Date(Date.now() - 1000).toISOString(),
    ends_at: new Date(Date.now() + 864_000_000).toISOString(),
    active: true,
  });
  const owner = as(OWNER);
  const stored = await json(await whole(owner, mp4('moov-first')));
  const created = await post(owner, '/api/admin/rewards/ads', form(stored.url));
  assert.equal(created.status, 201, JSON.stringify(await created.clone().json()));
  assert.equal(row<{ video_url: string }>(raw, 'SELECT video_url FROM reward_ads')!.video_url, stored.url);
  // A key in the same folder that nothing stored is the typo the ledger stops.
  assert.equal((await post(owner, '/api/admin/rewards/ads', form('/files/rewards/ads/video/nothing.mp4'))).status, 400);

  const page = await json(await get(as(customer), '/api/rewards'));
  assert.equal(page.missions.video.available, true);
  assert.equal(page.missions.video.videoUrl, stored.url);
  assert.equal(page.missions.video.ad.width, 720);
  assert.equal(page.missions.video.ad.views_max, 2);
  assert.equal(page.missions.video.required_seconds, 45);
});

test('every code these doors answer is written in Arabic, English and Sorani, the Sorani its own', () => {
  const codes = [
    'REWARD_ALREADY_CLAIMED', 'CHECKIN_ALREADY_DONE', 'TASK_DISABLED', 'NO_VIDEO', 'NO_TICKET', 'TOO_SOON', 'AD_LIMIT_REACHED', 'VIDEO_UNSUPPORTED',
    'REWARD_AD_MP4_REQUIRED', 'REWARD_AD_NOT_FASTSTART', 'REWARD_AD_TITLE_REQUIRED', 'REWARD_AD_SORANI_COPY', 'REWARD_AD_VIDEO_REQUIRED',
    'REWARD_AD_POSTER_INVALID', 'REWARD_AD_SIZE_INVALID', 'REWARD_AD_DURATION_INVALID', 'REWARD_AD_SECONDS_INVALID', 'REWARD_AD_WINDOW_INVALID',
    'REWARD_AD_VIEWS_INVALID', 'REWARD_AD_SORT_INVALID', 'REWARD_AD_ACTIVE_REQUIRED',
  ];
  for (const code of codes) {
    const row = REFUSAL_STRINGS[code];
    assert.ok(row?.ar && row.en && row.ckb, code);
    assert.notEqual(row.ckb, row.ar, `${code}: the Sorani copies the Arabic`);
  }
});
