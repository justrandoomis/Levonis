/**
 * AN MP4 WHOSE INDEX IS AT THE END IS STORED, AND THE MERCHANT IS TOLD
 * (perf plan §B.1 #9, P2c).
 *
 * A phone-camera MP4 usually writes its `moov` (the frame index) AFTER its
 * `mdat` (the frames); a browser then downloads the whole clip before it
 * shows frame one. The encoder's «fast start» option fixes it, so the upload
 * route WARNS — `warnings: ['VIDEO_NOT_FASTSTART']` on a successful answer —
 * and the two pickers show the hint in the merchant's language. Refusing the
 * file would turn every phone clip into an error; saying nothing leaves the
 * slow start unexplained.
 *
 * Run: node --import tsx --test tests/videoFastStart.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { AppContext } from '../worker/lib/types';
import { uploadRoutes } from '../worker/routes/uploads';
import { HttpError } from '../worker/lib/http';
import { mp4IsFastStart, sniffVideo } from '../worker/lib/videoSniff';
import { REFUSAL_STRINGS } from '../src/lib/refusalStrings';
import { freshDb, asD1 } from './fixtures/app';
import { ROOT } from './fixtures/d1';

const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
function box(type: string, ...payload: number[][]): number[] {
  const body = payload.flat();
  return [...u32(8 + body.length), ...ascii(type), ...body];
}
/** The same structurally real MP4 tests/merchantVideoUpload.test.ts builds, with the index first or last. */
function mp4(order: 'moov-first' | 'mdat-first'): Uint8Array {
  const stsd = box('stsd', [0, 0, 0, 0], u32(1), box('avc1', new Array(78).fill(0)));
  const trak = box('trak', box('mdia', box('hdlr', [0, 0, 0, 0], u32(0), ascii('vide'), new Array(12).fill(0)), box('minf', box('stbl', stsd))));
  const moov = box('moov', trak);
  const mdat = box('mdat', new Array(64).fill(7));
  return new Uint8Array([...box('ftyp', ascii('isom'), u32(512), ascii('isom'), ascii('mp41')), ...(order === 'moov-first' ? [...moov, ...mdat] : [...mdat, ...moov])]);
}

test('mp4IsFastStart reads the box order — and answers true for anything it cannot judge', () => {
  assert.equal(mp4IsFastStart(mp4('moov-first')), true);
  assert.equal(mp4IsFastStart(mp4('mdat-first')), false);
  assert.equal(sniffVideo(mp4('mdat-first')).ok, true, 'the file is still a playable MP4 — a warning, not a refusal');
  assert.equal(mp4IsFastStart(new Uint8Array(10)), true, 'not an MP4: nothing to warn about');
  assert.equal(mp4IsFastStart(new Uint8Array([...box('ftyp', ascii('isom'), u32(0)), ...box('moov', [])])), true, 'no mdat: nothing to wait for');
  const webmish = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...new Array(20).fill(0)]);
  assert.equal(mp4IsFastStart(webmish), true, 'WebM streams by construction');
});

function uploadApp() {
  const raw = freshDb();
  raw.exec(`INSERT INTO users (id,name,email,password_hash,role) VALUES ('ali','Ali','ali@x.co','h','merchant');
            INSERT INTO community_merchants (id,user_id,name) VALUES ('m_ali','ali','Ali');
            INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name) VALUES ('s_ali','m_ali','ali','ali3d','Ali');`);
  const objects = new Map<string, Uint8Array>();
  const bucket = {
    async put(key: string, value: ArrayBuffer | ArrayBufferView) {
      objects.set(key, value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    },
    async get() { return null; },
    async head() { return null; },
    async delete() {},
  };
  const hono = new Hono<AppContext>();
  hono.use('*', async (c, next) => {
    c.env = { DB: asD1(raw), BUCKET: bucket, R2_PUBLIC: bucket, R2_PRIVATE: bucket } as never;
    c.set('user', { id: 'ali', role: 'merchant' } as never);
    await next();
  });
  hono.route('/api/uploads', uploadRoutes);
  hono.onError((e, c) => (e instanceof HttpError ? c.json({ success: false, code: e.code }, e.status as 400) : Promise.reject(e)));
  return async (bytes: Uint8Array, purpose = 'community') => {
    const form = new FormData();
    form.set('purpose', purpose);
    form.set('file', new File([bytes as unknown as BlobPart], 'clip.mp4', { type: 'video/mp4' }));
    const res = await hono.request('/api/uploads', { method: 'POST', body: form });
    return { status: res.status, body: (await res.json()) as Record<string, unknown>, stored: objects.size };
  };
}

test('the upload route stores a late-index MP4 and answers with the warning; a fast-start file carries none', async () => {
  const upload = uploadApp();
  const slow = await upload(mp4('mdat-first'));
  assert.equal(slow.status, 200, JSON.stringify(slow.body));
  assert.equal(slow.body.success, true);
  assert.match(String(slow.body.key), /^merchants\/ali\/public\/[a-z0-9]+\.mp4$/);
  assert.deepEqual(slow.body.warnings, ['VIDEO_NOT_FASTSTART']);
  assert.equal(slow.stored, 1, 'the file was stored — this is a hint, not a refusal');
  const fast = await upload(mp4('moov-first'));
  assert.equal(fast.status, 200);
  assert.equal('warnings' in fast.body, false, 'a clean answer carries no warnings key at all');
  const post = await upload(mp4('mdat-first'), 'post');
  assert.deepEqual(post.body.warnings, ['VIDEO_NOT_FASTSTART'], 'a maker’s project clip gets the same hint');
});

test('the hint exists in three languages and both pickers show it as a status, not an error', () => {
  const s = REFUSAL_STRINGS.VIDEO_NOT_FASTSTART;
  assert.ok(s && s.ar && s.en && s.ckb);
  assert.notEqual(s.ckb, s.ar);
  assert.notEqual(s.ckb, s.en);
  assert.match(s.en, /Fast start/);
  for (const rel of ['src/components/merchant/catalog/MediaEditor.tsx', 'src/components/community/projects/MediaPicker.tsx']) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    assert.match(src, /warnings\?\.find\(\(w\) => w === 'VIDEO_NOT_FASTSTART'\)/, `${rel} reads the warning`);
    assert.match(src, /role="status" data-media-hint|data-media-hint className="[^"]*" role="status"|role="status"[^>]*data-media-hint/, `${rel} renders it as a status`);
    assert.match(src, /setHint\(refusalText\(warning, /, `${rel} translates it through the refusal table`);
  }
});
