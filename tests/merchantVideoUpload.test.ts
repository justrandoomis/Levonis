/**
 * A MERCHANT'S VIDEO (merchant platform W2-F, brief item 6): the upload route
 * takes MP4 and WebM from a merchant only when the bytes ARE a playable video —
 * the container walked end to end, a real video track in a codec browsers play
 * — and files it exactly like a merchant picture, under the uploader's own
 * prefix. The store page's video block (W2-C) then accepts the owner's own
 * video and refuses anyone else's.
 *
 * Run: node --import tsx --test tests/merchantVideoUpload.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import type { AppContext } from '../worker/lib/types';
import { uploadRoutes } from '../worker/routes/uploads';
import { HttpError } from '../worker/lib/http';
import { sniffVideo } from '../worker/lib/videoSniff';
import { verifyLayoutRefs } from '../worker/lib/storeLayout';
import { storeById } from '../worker/lib/merchantAuth';
import { normalizeLayout } from '../packages/storeLayout/src/normalize';
import { freshDb, asD1 } from './fixtures/app';

// ------------------------------------------------------------ byte builders

const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
function box(type: string, ...payload: number[][]): number[] {
  const body = payload.flat();
  return [...u32(8 + body.length), ...ascii(type), ...body];
}
/** A minimal but structurally real MP4: ftyp, moov/trak/mdia/{hdlr, minf/stbl/stsd/<codec>}, mdat. */
function mp4({ brand = 'isom', handler = 'vide', codec = 'avc1', tail = [] as number[] } = {}): Uint8Array {
  const stsd = box('stsd', [0, 0, 0, 0], u32(1), box(codec, new Array(78).fill(0)));
  const trak = box('trak', box('mdia', box('hdlr', [0, 0, 0, 0], u32(0), ascii(handler), new Array(12).fill(0)), box('minf', box('stbl', stsd))));
  return new Uint8Array([
    ...box('ftyp', ascii(brand), u32(512), ascii('isom'), ascii('mp41')),
    ...box('moov', trak),
    ...box('mdat', new Array(64).fill(7)),
    ...tail,
  ]);
}
/** EBML element: id bytes, a 1-byte size vint (or unknown size), payload. */
const el = (id: number[], payload: number[], unknown = false) => [...id, unknown ? 0xff : 0x80 | payload.length, ...payload];
function webm({ docType = 'webm', codec = 'V_VP9', trackType = 1 } = {}): Uint8Array {
  const header = el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], ascii(docType)));
  const entry = el([0xae], [...el([0xd7], [1]), ...el([0x83], [trackType]), ...el([0x86], ascii(codec))]);
  const tracks = el([0x16, 0x54, 0xae, 0x6b], entry);
  const cluster = [0x1f, 0x43, 0xb6, 0x75, 0xff, ...new Array(40).fill(9)];
  // A MediaRecorder file: the Segment's size is "unknown".
  const segment = [0x18, 0x53, 0x80, 0x67, 0xff, ...el([0x15, 0x49, 0xa9, 0x66], [0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40]), ...tracks, ...cluster];
  return new Uint8Array([...header, ...segment]);
}

// ---------------------------------------------------------------- the sniffer

test('the sniffer accepts real MP4 (H.264/HEVC/AV1) and WebM (VP8/VP9/AV1) — and says which', () => {
  assert.deepEqual(sniffVideo(mp4()), { ok: true, mime: 'video/mp4', ext: 'mp4', codec: 'avc1' });
  assert.equal((sniffVideo(mp4({ codec: 'hvc1', brand: 'qt  ' })) as { codec: string }).codec, 'hvc1');
  assert.equal((sniffVideo(mp4({ codec: 'av01', brand: 'iso5' })) as { codec: string }).codec, 'av01');
  assert.deepEqual(sniffVideo(webm()), { ok: true, mime: 'video/webm', ext: 'webm', codec: 'V_VP9' });
  assert.equal(sniffVideo(webm({ codec: 'V_VP8' })).ok, true);
});

test('the sniffer refuses a disguise — each with its reason', () => {
  const reason = (b: Uint8Array) => (sniffVideo(b) as { reason?: string }).reason;
  const html = new TextEncoder().encode('<html><script>alert(document.cookie)</script></html>'.padEnd(64, ' '));
  assert.equal(reason(html), 'not_video');
  // An HTML page behind a real-looking ftyp: the boxes do not chain.
  assert.equal(reason(new Uint8Array([...box('ftyp', ascii('isom'), u32(0)), ...new TextEncoder().encode('<html>'.repeat(20))])), 'malformed');
  assert.equal(reason(mp4({ tail: [1, 2, 3] })), 'malformed', 'trailing bytes that are not a box');
  assert.equal(reason(mp4({ handler: 'soun', codec: 'mp4a' })), 'no_video_track', 'audio only');
  assert.equal(reason(mp4({ brand: 'M4A ' })), 'audio_only');
  assert.equal(reason(mp4({ brand: 'heic' })), 'image_container', 'an iPhone photograph');
  assert.equal(reason(mp4({ codec: 'mp4v' })), 'codec_unsupported');
  assert.equal(reason(webm({ docType: 'matroska' })), 'not_video', 'a Matroska file is not WebM');
  assert.equal(reason(webm({ codec: 'V_MPEG4/ISO/AVC' })), 'codec_unsupported');
  assert.equal(reason(webm({ trackType: 2, codec: 'A_OPUS' })), 'no_video_track');
  assert.equal(reason(new Uint8Array(10)), 'not_video');
});

// ------------------------------------------------------------- the upload route

function uploadApp(userId: string) {
  const raw = freshDb();
  raw.exec(`INSERT INTO users (id,name,email,password_hash,role) VALUES ('ali','Ali','ali@x.co','h','merchant'), ('zain','Zain','z@x.co','h','merchant');
            INSERT INTO community_merchants (id,user_id,name) VALUES ('m_ali','ali','Ali'), ('m_zain','zain','Zain');
            INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name) VALUES ('s_ali','m_ali','ali','ali3d','Ali'), ('s_zain','m_zain','zain','zainprint','Zain');`);
  const objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  const bucket = {
    async put(key: string, value: ArrayBuffer | ArrayBufferView, options?: { httpMetadata?: { contentType?: string } }) {
      const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      objects.set(key, { bytes, contentType: options?.httpMetadata?.contentType });
    },
    async get() { return null; },
    async head() { return null; },
    async delete() {},
  };
  const hono = new Hono<AppContext>();
  hono.use('*', async (c, next) => {
    c.env = { DB: asD1(raw), BUCKET: bucket, R2_PUBLIC: bucket, R2_PRIVATE: bucket } as never;
    c.set('user', { id: userId, role: 'merchant' } as never);
    await next();
  });
  hono.route('/api/uploads', uploadRoutes);
  hono.onError((e, c) => (e instanceof HttpError ? c.json({ success: false, code: e.code, details: e.details }, e.status as 400) : Promise.reject(e)));
  const upload = async (bytes: Uint8Array, name: string, type: string, purpose = 'community') => {
    const form = new FormData();
    form.set('purpose', purpose);
    form.set('file', new File([bytes as unknown as BlobPart], name, { type }));
    const res = await hono.request('/api/uploads', { method: 'POST', body: form });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { raw, upload, objects };
}

test('a merchant uploads an MP4 and a WebM: filed under THEIR prefix, recorded as video, served as video', async () => {
  const { raw, upload, objects } = uploadApp('ali');
  const a = await upload(mp4(), 'clip.mp4', 'video/mp4');
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.match(a.body.key, /^merchants\/ali\/public\/[a-z0-9]+\.mp4$/);
  assert.equal(a.body.mime, 'video/mp4');
  const b = await upload(webm(), 'clip.webm', 'video/webm');
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.match(b.body.key, /^merchants\/ali\/public\/[a-z0-9]+\.webm$/);
  const ledger = raw.prepare('SELECT object_key, owner_id, mime_type FROM file_objects ORDER BY object_key').all() as Array<Record<string, string>>;
  assert.deepEqual(ledger.map((r) => `${r.owner_id}:${r.mime_type}`).sort(), ['ali:video/mp4', 'ali:video/webm']);
  assert.equal(objects.get(a.body.key)?.contentType, 'video/mp4');
});

test('a disguised file is refused before a byte is stored — VIDEO_UNSUPPORTED with the reason', async () => {
  const { upload, objects } = uploadApp('ali');
  const fake = new Uint8Array([...box('ftyp', ascii('isom'), u32(0)), ...new TextEncoder().encode('<html><script>x</script></html>'.repeat(4))]);
  const r = await upload(fake, 'clip.mp4', 'video/mp4');
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'VIDEO_UNSUPPORTED');
  assert.equal(r.body.details.reason, 'malformed');
  const audio = await upload(mp4({ handler: 'soun', codec: 'mp4a' }), 'song.mp4', 'video/mp4');
  assert.equal(audio.body.code, 'VIDEO_UNSUPPORTED');
  const mkv = await upload(webm({ docType: 'matroska' }), 'x.webm', 'video/webm');
  assert.equal(mkv.body.code, 'VIDEO_UNSUPPORTED');
  assert.equal(objects.size, 0);
  // A merchant video counts toward the video ceiling, not the picture one.
  const big = new Uint8Array(41 * 1024 * 1024);
  big.set(mp4(), 0);
  assert.equal((await upload(big, 'big.mp4', 'video/mp4')).status, 400);
});

test('the store page’s video block takes the owner’s own video and refuses another merchant’s', async () => {
  const ali = uploadApp('ali');
  const mine = (await ali.upload(mp4(), 'mine.mp4', 'video/mp4')).body.key as string;
  // Zain's video, in the same database: uploaded by Zain.
  ali.raw.exec(`INSERT INTO file_objects (object_key,visibility,domain,owner_id,mime_type,byte_size) VALUES ('merchants/zain/public/zzzz9999.mp4','public','merchants','zain','video/mp4',100)`);
  const ctx = (await storeById(asD1(ali.raw), 's_ali'))!;
  const layout = (video: string) =>
    normalizeLayout(
      { schema_version: 1, theme: 'classic', blocks: [{ id: 'v1', type: 'video', settings: { title: { ar: 'فيديو', en: 'Video', ckb: '' }, video } }] },
      { ownerUserId: 'ali' }
    ).layout;
  const ok = await verifyLayoutRefs(asD1(ali.raw), ctx, layout(mine));
  assert.deepEqual(ok.issues, [], JSON.stringify(ok.issues));
  assert.equal((ok.layout.blocks[0].settings as { video: string }).video, mine, "the owner's own video stays");
  // Another merchant's key does not even normalise under Ali's ownership…
  const foreign = normalizeLayout(
    { schema_version: 1, theme: 'classic', blocks: [{ id: 'v1', type: 'video', settings: { video: 'merchants/zain/public/zzzz9999.mp4' } }] },
    { ownerUserId: 'ali' }
  );
  assert.ok(foreign.issues.length > 0, 'refused at the schema');
  // …and a key under Ali's prefix that the ledger never recorded as Ali's video is dropped by the server check.
  const ghost = await verifyLayoutRefs(asD1(ali.raw), ctx, layout('merchants/ali/public/ffff0000.mp4'));
  assert.ok(ghost.issues.length > 0);
  assert.ok(!(ghost.layout.blocks[0]?.settings as { video?: string } | undefined)?.video, 'the unrecorded key is emptied');
});
