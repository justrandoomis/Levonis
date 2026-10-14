/**
 * A PUBLIC WEBP CARRIES NO EXIF OR XMP (found by the security verification of
 * DECISIONS row 226; older than it).
 *
 * A still WebP that arrives as WebP is stored as it came (WebP is not in
 * imageConvert's `CONVERTIBLE`), and an extended WebP may carry an `EXIF`
 * chunk with a phone's GPS position. `stripWebpMetadata`
 * (worker/lib/imageMetadata.ts) now drops the EXIF and XMP chunks — and their
 * VP8X flags — at every door that stores a public WebP unconverted: the
 * upload route's public purposes, `productImageToWebp` (products, link cards)
 * and `capStoredWebp` (site media, section pictures). So neither
 * `/files/<key>` nor a `?w=` that falls back to the original (Images
 * allowance spent, binding absent, an animated WebP) hands out a position.
 * The binding's own AVIF/WebP output is not covered here (the lab has no real
 * encoder; Cloudflare discards metadata on WebP and AVIF output).
 *
 * LOCAL ONLY. Run: node --import tsx --test tests/webpMetadataStrip.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import type { AppContext } from '../worker/lib/types';
import { HttpError } from '../worker/lib/http';
import { asD1, ctx, freshDb, pending } from './fixtures/app';
import { R2Double, imagesDouble } from './fixtures/imageDoubles';
import { uploadRoutes, fileRoutes } from '../worker/routes/uploads';
import { stripWebpMetadata } from '../worker/lib/imageMetadata';
import { capStoredWebp, productImageToWebp } from '../worker/lib/imageConvert';

const enc = (s: string) => new TextEncoder().encode(s);
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const le24 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];
const GPS = 'Exif\0\0MM\0*GPSLatitude=33.315200N;GPSLongitude=44.366100E';

/** A still WebP: VP8X (EXIF flag set), a dummy VP8 chunk and an EXIF chunk carrying a GPS position. */
function webpWithExif(width: number, height: number): Uint8Array {
  const vp8x = [...enc('VP8X'), ...le32(10), 0x08, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)];
  const vp8Payload = new Array(64).fill(7);
  const vp8 = [...enc('VP8 '), ...le32(vp8Payload.length), ...vp8Payload];
  const exifPayload = [...enc(GPS)];
  if (exifPayload.length % 2) exifPayload.push(0);
  const exif = [...enc('EXIF'), ...le32(exifPayload.length), ...exifPayload];
  const body = [...enc('WEBP'), ...vp8x, ...vp8, ...exif];
  return new Uint8Array([...enc('RIFF'), ...le32(body.length), ...body]);
}

const hasGps = (bytes: Uint8Array) => new TextDecoder('latin1').decode(bytes).includes('GPSLatitude=33.3152');

test('a customer post WebP is stored without its GPS EXIF, and ?w= falling back serves none either', async () => {
  const raw = freshDb();
  raw.exec("INSERT INTO users (id,name,email,password_hash,role) VALUES ('eve','Eve','eve@x.co','h','customer')");
  const pub = new R2Double();
  const priv = new R2Double();
  const images = imagesDouble();
  const app = new Hono<AppContext>();
  app.use('*', async (c, next) => {
    c.env = { DB: asD1(raw), BUCKET: pub, R2_PUBLIC: pub, R2_PRIVATE: priv, IMAGES: images.binding } as never;
    c.set('user', { id: 'eve', role: 'customer', email: 'eve@x.co', admin_scope: null, username: 'eve', email_verified_at: '2026-01-01T00:00:00.000Z' } as never);
    c.set('sessionCreatedAt', new Date().toISOString());
    await next();
  });
  app.route('/api/uploads', uploadRoutes);
  app.route('/files', fileRoutes);
  app.onError((error, c) => (error instanceof HttpError
    ? c.json({ success: false, code: error.code, error: error.message }, error.status as 400)
    : c.json({ success: false, error: String(error) }, 500)));
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await app.request(path, init, undefined, ctx);
    await Promise.all(pending.splice(0));
    return res;
  };

  // The binding's monthly allowance is spent (9422) — so the upload's warm-up
  // cuts nothing and the copy path falls back to the original.
  images.state.mode = 'throw9422';
  const form = new FormData();
  form.set('purpose', 'post');
  form.set('file', new File([webpWithExif(1200, 900) as unknown as BlobPart], 'holiday.webp', { type: 'image/webp' }));
  const up = await call('/api/uploads', { method: 'POST', body: form, headers: { 'CF-Connecting-IP': '1.2.3.4' } });
  const body = (await up.json()) as { key: string };
  assert.equal(up.status, 200, JSON.stringify(body));
  assert.match(body.key, /^users\/eve\/posts\//, 'a public key');

  const plain = new Uint8Array(await (await call(`/files/${body.key}`)).arrayBuffer());
  const copy = await call(`/files/${body.key}?w=640`, { headers: { Accept: 'image/avif,image/webp,*/*' } });
  const copyBytes = new Uint8Array(await copy.arrayBuffer());
  const evidence = { key: body.key, plainHasGps: hasGps(plain), variantStatus: copy.status, variantType: copy.headers.get('Content-Type'), variantHasGps: hasGps(copyBytes) };
  assert.equal(evidence.plainHasGps, false, `the public original must not carry GPS EXIF; ${JSON.stringify(evidence)}`);
  assert.equal(evidence.variantHasGps, false, `a ?w= answer must not carry GPS EXIF; ${JSON.stringify(evidence)}`);
});

// ------------------------------------------------------------ the pure part

const chunk = (tag: string, payload: number[]) => [...enc(tag), ...le32(payload.length), ...payload, ...(payload.length % 2 ? [0] : [])];
function riff(chunks: number[][]): Uint8Array {
  const body = [...enc('WEBP'), ...chunks.flat()];
  return new Uint8Array([...enc('RIFF'), ...le32(body.length), ...body]);
}
const tags = (b: Uint8Array) => {
  const out: string[] = [];
  for (let at = 12; at + 8 <= b.byteLength; ) {
    const size = b[at + 4] | (b[at + 5] << 8) | (b[at + 6] << 16) | (b[at + 7] << 24);
    out.push(String.fromCharCode(...b.subarray(at, at + 4)));
    at += 8 + size + (size & 1);
  }
  return out;
};

test('stripWebpMetadata drops EXIF and XMP, clears their flags, fixes the RIFF size and keeps every other chunk in order', () => {
  const vp8x = [0x08 | 0x04 | 0x20 | 0x10, 0, 0, 0, ...le24(99), ...le24(49)];
  const src = riff([chunk('VP8X', vp8x), chunk('ICCP', [1, 2, 3]), chunk('ALPH', [9, 9]), chunk('VP8 ', new Array(20).fill(7)), chunk('EXIF', [...enc(GPS)]), chunk('XMP ', [...enc('<x:xmpmeta/>')])]);
  const out = stripWebpMetadata(src);
  assert.deepEqual(tags(out), ['VP8X', 'ICCP', 'ALPH', 'VP8 ']);
  assert.equal(out[20], 0x20 | 0x10, 'ICC and alpha flags kept, EXIF and XMP cleared');
  assert.equal(out[4] | (out[5] << 8) | (out[6] << 16) | (out[7] << 24), out.byteLength - 8);
  assert.equal(hasGps(out), false);
  // Nothing to drop, a simple WebP, or something that is not a WebP at all: the same bytes.
  const clean = riff([chunk('VP8X', [0, 0, 0, 0, ...le24(9), ...le24(9)]), chunk('VP8 ', [1, 2])]);
  assert.equal(stripWebpMetadata(clean), clean);
  const simple = riff([chunk('VP8L', [1, 2, 3, 4])]);
  assert.equal(stripWebpMetadata(simple), simple);
  const truncated = src.subarray(0, 40);
  assert.equal(stripWebpMetadata(truncated), truncated, 'a malformed file is left as it was');
});

test('the other doors that keep a public WebP as it came strip it too: products and link cards, site media and section pictures', async () => {
  const withGps = webpWithExif(800, 600);
  const images = imagesDouble();
  const product = await productImageToWebp({ IMAGES: images.binding } as never, withGps);
  assert.ok(product.ok);
  assert.equal(product.ok && product.converted, false, 'not re-encoded — only the metadata chunk is gone');
  assert.equal(product.ok && hasGps(product.bytes), false);
  const site = await capStoredWebp({ IMAGES: images.binding } as never, withGps);
  assert.equal(site.resized, false);
  assert.equal(hasGps(site.bytes), false);
});
