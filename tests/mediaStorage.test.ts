import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildMediaKey,
  getMediaObject,
  isAnonymousPublicMediaKey,
  isSafeMediaKey,
  mediaBucket,
} from '../worker/lib/mediaStorage';
import { rasterDimensions, validRasterDimensions } from '../worker/lib/imageMetadata';
import { detectConvertibleRaster, prepareProductImage, webpFilename } from '../src/lib/imagePreprocess';
import { planLegacyMediaKey } from '../worker/lib/mediaMigration';

class Bucket {
  objects = new Map<string, Uint8Array>();
  async get(key: string) {
    const value = this.objects.get(key);
    return value ? ({ key, body: new Blob([value]).stream() } as unknown as R2ObjectBody) : null;
  }
}

test('canonical keys are deterministic and path traversal is impossible', () => {
  assert.equal(
    buildMediaKey({ visibility: 'public', domain: 'products', entityId: 'prd_1', kind: 'gallery', objectId: 'abc123', extension: '.WEBP' }),
    'products/prd_1/gallery/abc123.webp'
  );
  assert.throws(() => buildMediaKey({ visibility: 'private', domain: 'chat', entityId: '../u2', kind: 'attachments', objectId: 'abc123', extension: 'webp' }));
  for (const key of ['../private/a.webp', 'products/%2e%2e/a.webp', '/products/a.webp', 'products\\a.webp']) {
    assert.equal(isSafeMediaKey(key), false, key);
  }
});

test('logical buckets are selected by visibility and legacy reads remain available', async () => {
  const legacy = new Bucket();
  const pub = new Bucket();
  const priv = new Bucket();
  const env = { BUCKET: legacy, R2_PUBLIC: pub, R2_PRIVATE: priv } as never;
  assert.equal(mediaBucket(env, 'public'), pub);
  assert.equal(mediaBucket(env, 'private'), priv);
  legacy.objects.set('products/import/old.webp', new Uint8Array([1]));
  assert.ok(await getMediaObject(env, 'public', 'products/import/old.webp'));
});

test('only explicitly public-safe namespaces can be fetched anonymously', () => {
  for (const key of [
    'products/prd_1/gallery/abc.webp',
    'users/u1/avatar/abc.webp',
    'merchants/u1/public/abc.webp',
    'community/u1/legacy.webp',
  ]) assert.equal(isAnonymousPublicMediaKey(key), true, key);
  for (const key of [
    'chat/u1/attachments/abc.webp',
    'receipts/u1/evidence/abc.webp',
    'reviews-evidence/u1/abc.webp',
    'kyc/u1/abc.webp',
  ]) assert.equal(isAnonymousPublicMediaKey(key), false, key);
});

test('legacy migration is dry-planable, preserves orphans, and canonicalizes existing UIUx assets', () => {
  const png = planLegacyMediaKey('products/import/old.png', true);
  assert.equal(png.action, 'convert_webp');
  assert.equal(png.visibility, 'public');
  const privateChat = planLegacyMediaKey('chat/u1/abc.webp', true);
  assert.equal(privateChat.action, 'copy');
  assert.equal(privateChat.visibility, 'private');
  const orphan = planLegacyMediaKey('products/import/orphan.webp', false);
  assert.equal(orphan.action, 'orphan_candidate');
  const logo = planLegacyMediaKey('UIUx/Logo/Levonis-Mark.png', true);
  assert.equal(logo.visibility, 'public');
  assert.equal(logo.action, 'copy');
  assert.match(logo.destinationKey, /^ui\/levonis\/logo\/Levonis-Mark_[a-f0-9]+\.png$/);
});

test('PNG/JPEG signatures are converted through the WebP preprocessing contract', async () => {
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
  assert.equal(detectConvertibleRaster(pngBytes), 'png');
  assert.equal(detectConvertibleRaster(jpegBytes), 'jpeg');
  const input = new File([pngBytes], 'camera.final.PNG', { type: 'application/octet-stream' });
  let encodedSource: File | null = null;
  const result = await prepareProductImage(input, async (source) => {
    encodedSource = source;
    return { blob: new Blob([new Uint8Array([0x52, 0x49, 0x46, 0x46])], { type: 'image/webp' }), width: 1200, height: 800 };
  });
  assert.equal(encodedSource, input);
  assert.equal(result.converted, true);
  assert.equal(result.file.type, 'image/webp');
  assert.equal(result.file.name, 'camera.final.webp');
  assert.equal(result.width, 1200);
  assert.equal(webpFilename('../../unsafe.jpg'), 'unsafe.webp');
});

test('header dimensions are bounded before product media is accepted', () => {
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47], 0);
  png.set([0, 0, 4, 0], 16); // 1024
  png.set([0, 0, 3, 0], 20); // 768
  assert.deepEqual(rasterDimensions(png, 'image/png'), { width: 1024, height: 768 });
  assert.equal(validRasterDimensions({ width: 12_000, height: 4_000 }), true);
  assert.equal(validRasterDimensions({ width: 12_001, height: 10 }), false);
  assert.equal(validRasterDimensions({ width: 10_000, height: 10_000 }), false);
});

/**
 * THE ROUTE NO LONGER *ACCEPTS* A PNG — IT CONVERTS ONE.
 *
 * This test used to pin "accepts product PNG/JPEG without browser conversion",
 * which was true and was the defect: the format a product photo was stored in
 * depended on which browser the owner happened to be using, because the only
 * conversion ran on a canvas and `canvas.toBlob(cb, 'image/webp')` falls back to
 * PNG, silently, wherever there is no WebP encoder.
 *
 * `env.IMAGES` converts the bytes the Worker is already holding, the same way
 * for every device. What this test pins now is that the route measures and
 * stores the CONVERTED bytes — a key or a contentType taken from the sniffed
 * original would be the same lie in a new place.
 */
test('the upload route converts server-side and records what it actually stored', () => {
  const route = readFileSync(new URL('../worker/routes/uploads.ts', import.meta.url), 'utf8');
  const browser = readFileSync(new URL('../src/lib/imagePreprocess.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(route, /PRODUCT_IMAGE_REQUIRES_WEBP/);
  assert.match(route, /convertToWebp\(c\.env, buf, kind\.mime\)/, 'the server does the converting');
  assert.match(route, /rasterDimensions\(buf, storedMime\)/, 'measured on the bytes that will be stored');
  assert.match(route, /extension: storedExt/, 'and the key names the format that is really in the bucket');
  assert.match(route, /IMAGE_CONVERT_UNAVAILABLE/, 'no binding is refused, never silently stored as-is');
  // The browser pass survives as a SHRINK — it saves the uplink on a phone —
  // so the canvas settings that preserve alpha still matter.
  assert.match(browser, /getContext\('2d', \{ alpha: true \}\)/);
  assert.doesNotMatch(browser, /fillRect\(/);
});
