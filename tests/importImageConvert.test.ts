/**
 * THE IMPORT MAY NOT STORE A SUPPLIER'S BYTES, AND MAY NOT LIE ABOUT WHY.
 *
 * Three defects met here, all of them found in live code rather than imagined:
 *
 *   1. THE ZIP PATH NEVER CONVERTED. `storeAsset` called the raw R2 writer
 *      `putMediaObject` directly, so a supplier's JPEG or PNG inside an
 *      imported archive was stored byte for byte — while the REMOTE-URL branch
 *      of the same function, five lines further down, went through the
 *      converting door and produced WebP. One import, two answers, decided by
 *      which column the admin happened to fill.
 *
 *   2. THE SIZE LIMIT DISAGREED WITH ITSELF AND THE MESSAGE WAS FALSE. The ZIP
 *      capped an image at 4 MB while the product form the same admin uses
 *      accepts 8 — and an image over the cap was dropped from the archive map,
 *      so the owner was told it was «غير موجودة في مجلد images/» about a file
 *      they could see in the ZIP they had just built.
 *
 *   3. EVERY iPHONE PHOTO WAS A VIDEO. `sniff` matched `ftyp` at offset 4 and
 *      stopped, and HEIC and MP4 are both ISO-BMFF, so a HEIC photograph was
 *      stored as `video/mp4` — a file the shop serves as a video that no
 *      player can play.
 *
 * And the thing the owner actually asked about: three hotlinked supplier URLs
 * are live on the Bambu Lab A1 right now, `https://` addresses with an empty
 * `key`. This file proves the import can no longer produce one.
 *
 * Nothing here is stubbed except the Cloudflare Images binding and R2, and
 * both are stubbed at their real shapes. The route is the real
 * `/api/admin/import/preview`, the database is real SQLite with every
 * migration applied, and the ZIPs are built with the same `fflate` the
 * importer reads them with.
 *
 * Run: node --import tsx --test tests/importImageConvert.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { freshDb, asD1, failingD1, stubApp, ctx, row, all, count, get, post, json, type App } from './fixtures/app';
import { adminImportRoutes } from '../worker/routes/adminImport';
import { HEIF_REFUSAL, isHeifBytes, sniff } from '../worker/routes/uploads';
import { EXTERNAL_IMAGE_REFUSAL, isOwnedMediaUrl, resolveProduct, type ImportMaps } from '../worker/lib/importApply';
import { parseImport, templateShape, toCsv } from '../worker/lib/importCsv';
import { validateProductDoc } from '../worker/lib/productModel';
import { declaresAvif } from '../worker/routes/uploads';
import { MEDIA_DETACH_REASON, runGuardedMediaCleanup } from '../worker/lib/mediaRefs';

// ------------------------------------------------------------ byte fixtures

/** An ISO-BMFF header carrying `ftyp` and the four-character brand at 8..11. */
function isoBmff(brand: string, size = 32): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0x00, 0x00, 0x00, 0x18], 0);
  b.set([0x66, 0x74, 0x79, 0x70], 4); // 'ftyp'
  for (let i = 0; i < 4; i++) b[8 + i] = brand.charCodeAt(i);
  return b;
}

function png(size = 64): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return b;
}

function jpeg(size = 64): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0xff, 0xd8, 0xff, 0xe0], 0);
  return b;
}

function webpBytes(size = 32): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  b.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  b.set([0x56, 0x50, 0x38, 0x58], 12); // VP8X
  return b;
}

// ------------------------------------------------------- 3. the sniffer

/**
 * THE BRANDS AN iPHONE WRITES. Every one of these used to come back as
 * `video/mp4`, which is how a customer's photograph became an unplayable video
 * in the bucket. `sniff` now declines to name them at all — see the long note
 * beside `isHeifBytes` for why a refusal is the honest answer and a MIME is
 * not — and `isHeifBytes` is what lets a route say WHICH format it is.
 */
test('every HEIF brand is recognised as HEIF and is NOT called video/mp4', () => {
  for (const brand of ['heic', 'heix', 'hevc', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']) {
    const bytes = isoBmff(brand);
    assert.equal(isHeifBytes(bytes), true, `${brand} must be recognised as HEIF`);
    assert.equal(sniff(bytes), null, `${brand} must not be given a MIME — it was ${JSON.stringify(sniff(bytes))}`);
  }
});

/**
 * AND THE VIDEOS STILL WORK. A warranty-claim clip and a chat video are
 * ordinary traffic on this site; a fix for HEIC that started refusing them
 * would be a worse bug than the one it replaced. The five brands the
 * specification names are checked, and so are the ones the real world actually
 * writes — an iPhone shooting video emits `qt  `, Android emits `mp42`,
 * fragmented files emit `iso5`.
 */
test('MP4 brands are still video/mp4, including the ones no specification lists', () => {
  for (const brand of ['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'iso4', 'iso5', 'iso6', 'M4V ', 'mp4v', 'qt  ', 'dash']) {
    assert.deepEqual(sniff(isoBmff(brand)), { ext: 'mp4', mime: 'video/mp4' }, `${brand} must stay a video`);
    assert.equal(isHeifBytes(isoBmff(brand)), false, `${brand} is not HEIF`);
  }
});

test('AVIF is still AVIF — it shares the container and must not be swept up with HEIF', () => {
  for (const brand of ['avif', 'avis']) {
    assert.deepEqual(sniff(isoBmff(brand)), { ext: 'avif', mime: 'image/avif' });
    assert.equal(isHeifBytes(isoBmff(brand)), false);
  }
});

test('the ordinary formats are untouched by the brand reading', () => {
  assert.deepEqual(sniff(jpeg()), { ext: 'jpg', mime: 'image/jpeg' });
  assert.deepEqual(sniff(png()), { ext: 'png', mime: 'image/png' });
  assert.deepEqual(sniff(webpBytes()), { ext: 'webp', mime: 'image/webp' });
  const gif = new Uint8Array(32);
  gif.set([0x47, 0x49, 0x46, 0x38], 0);
  assert.deepEqual(sniff(gif), { ext: 'gif', mime: 'image/gif' });
});

// --------------------------------------------- the hotlinked-URL gate

/**
 * THE THREE IMAGES LIVE ON THE A1 TODAY, AS THE RULE THAT REFUSES THEM.
 *
 * Their real addresses, not invented ones: if `isOwnedMediaUrl` is ever
 * loosened into accepting a scheme, a host or a `..`, this fails naming the
 * exact bytes that are being served to Iraqi visitors from three foreign CDNs.
 */
test('a bare external URL is not a media reference this shop owns', () => {
  for (const url of [
    'https://static.insales-cdn.com/images/products/1/8093/899432349/bambu-lab-a1-1-pc-700543-en.png',
    'https://3d.nice-cdn.com/upload/image/product/large/default/47083_59cd2505.768x768.png',
    'https://cdn-reichelt.de/bilder/web/xxl_ws/I200/BAMBU_LAB_A1_COMBO_ANW_01.png',
    'http://example.com/a.png',
    '//cdn.example.com/a.png',
    'files/products/a.webp',
    '/files/../../etc/passwd',
    '/files/products/../../secret.webp',
    '',
  ]) {
    assert.equal(isOwnedMediaUrl(url), false, `${url} must never be storable as a product image`);
  }
  assert.equal(isOwnedMediaUrl('/files/products/import/gallery/abc123.webp'), true);
  assert.equal(isOwnedMediaUrl('/files/products/catalog/gallery/06bbcc976cea4e00b5b2.webp'), true);
});

/** The maps `resolveProduct` reads, with nothing in them but the images. */
function maps(images: Record<string, string>): ImportMaps {
  return {
    brands: new Map(),
    catalogs: new Map(),
    facets: new Map(),
    familyOf: new Map(),
    images: new Map(Object.entries(images)),
    productSlugs: new Map(),
  };
}

/**
 * THE GATE WHERE A PRODUCT IMAGE IS DECIDED.
 *
 * `resolveImages` is the only thing that fills this map today, and it only
 * ever puts `/files/…` in it — but a map is a value, and the rule about what a
 * product image may BE has to live where the product is built, not only where
 * the map is filled. This is the test that fails if a future edit lets an
 * address become a picture again.
 */
test('a supplier URL in the resolved map cannot become a product image', () => {
  const external = 'https://static.insales-cdn.com/images/products/1/8093/899432349/bambu-lab-a1-1-pc-700543-en.png';
  const csv = toCsv([
    ['row_type', 'key', 'name', 'price_iqd', 'stock', 'image', 'primary'],
    ['product', 'A1', 'Bambu Lab A1', '1000000', '5', '', ''],
    ['image', 'A1', '', '', '', external, 'yes'],
  ]);
  const parsed = parseImport(csv, templateShape('printer'));
  assert.equal(parsed.products.length, 1, JSON.stringify(parsed.issues));

  const resolved = resolveProduct(parsed.products[0], null, maps({ [external]: external }), {
    newId: (p) => `${p}_test`,
    money: true,
  });

  const media = resolved.relations.images as Array<{ url: string }>;
  for (const im of media) {
    assert.equal(im.url.startsWith('http'), false, 'no product image may carry an external address');
    assert.equal(im.url, '', 'the refused cell resolves to nothing rather than to the link');
  }
  assert.ok(
    resolved.issues.some((i) => i.severity === 'error' && i.message.includes(EXTERNAL_IMAGE_REFUSAL)),
    `the refusal must be stated by line; got ${JSON.stringify(resolved.issues)}`
  );
});

test('a key we own passes the same gate untouched', () => {
  const ours = '/files/products/import/gallery/deadbeef.webp';
  const csv = toCsv([
    ['row_type', 'key', 'name', 'price_iqd', 'stock', 'image', 'primary'],
    ['product', 'A1', 'Bambu Lab A1', '1000000', '5', '', ''],
    ['image', 'A1', '', '', '', 'a1.png', 'yes'],
  ]);
  const parsed = parseImport(csv, templateShape('printer'));
  const resolved = resolveProduct(parsed.products[0], null, maps({ 'a1.png': ours }), {
    newId: (p) => `${p}_test`,
    money: true,
  });
  assert.deepEqual((resolved.relations.images as Array<{ url: string }>).map((i) => i.url), [ours]);
  // Only the IMAGE verdict is this test's business: the sheet says nothing
  // about a section, and that complaint belongs to another test.
  assert.deepEqual(resolved.issues.filter((i) => i.message.startsWith('image:')), []);
});

// ------------------------------------------------- 1. and 2. through the route

class MemoryBucket {
  objects = new Map<string, { bytes: Uint8Array; metadata: Record<string, string> }>();
  async put(key: string, value: ArrayBuffer | ArrayBufferView, options?: { httpMetadata?: Record<string, string> }) {
    const bytes = value instanceof ArrayBuffer
      ? new Uint8Array(value.slice(0))
      : new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    this.objects.set(key, { bytes, metadata: options?.httpMetadata ?? {} });
  }
  async get(key: string) {
    const stored = this.objects.get(key);
    if (!stored) return null;
    const bytes = stored.bytes.slice();
    return {
      body: new Blob([bytes]).stream(),
      size: bytes.byteLength,
      httpMetadata: stored.metadata,
      arrayBuffer: () => new Blob([bytes]).arrayBuffer(),
    };
  }
  async head(key: string) {
    const stored = this.objects.get(key);
    return stored ? { key, size: stored.bytes.byteLength } : null;
  }
  async delete(key: string) { this.objects.delete(key); }
}

/**
 * The Cloudflare Images binding at its real shape:
 * `input(stream).output({format}) -> { response() }`. It returns real WebP
 * magic bytes, so the assertions below are made about bytes that genuinely ARE
 * WebP rather than about a promise that they are.
 */
function imagesBinding(opts: { fail?: boolean; distinct?: boolean; onInfo?: () => Promise<void> } = {}) {
  const calls: Array<{ format: string }> = [];
  return {
    calls,
    binding: {
      async info(_stream: ReadableStream) {
        await opts.onInfo?.();
        return { format: 'image/webp', fileSize: 32, width: 320, height: 240 };
      },
      input(stream: ReadableStream) {
        void stream;
        return {
          async output(o: { format: string }) {
            calls.push({ format: o.format });
            if (opts.fail) throw new Error('the converter refused this image');
            const bytes = webpBytes();
            if (opts.distinct) bytes[bytes.length - 1] = calls.length;
            return { response: () => new Response(bytes) };
          },
        };
      },
    },
  };
}

const SECTION = 'tpl_printers';

function setup(opts: {
  images?: unknown;
  dbFactory?: (raw: ReturnType<typeof freshDb>) => D1Database;
} = {}) {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role)
      VALUES ('boss','Admin','boss@x.co','h','admin');
    INSERT INTO catalogs (id,parent_id,slug,name_ar,name_en,template_family,is_printer_catalog,active)
      VALUES ('${SECTION}',NULL,'tpl-printers','طابعات','Printers','devices',1,1);
  `);
  const bucket = new MemoryBucket();
  const db = opts.dbFactory ? opts.dbFactory(raw) : asD1(raw);
  const app = stubApp(
    db,
    { id: 'boss', role: 'admin', email: 'boss@x.co' },
    (a) => a.route('/api/admin/import', adminImportRoutes),
    { env: { R2_PUBLIC: bucket, R2_PRIVATE: new MemoryBucket(), BUCKET: new MemoryBucket(), IMAGES: opts.images } }
  );
  return { raw, app, bucket };
}

const SHEET = (cell: string) =>
  toCsv([
    ['row_type', 'key', 'name', 'status', 'category', 'price_iqd', 'stock', 'image', 'primary'],
    ['product', 'A1', 'Bambu Lab A1', 'active', 'tpl-printers', '1000000', '5', '', ''],
    ['image', 'A1', '', '', '', '', '', cell, 'yes'],
  ]);

async function previewZip(app: App, files: Record<string, Uint8Array>) {
  const zip = zipSync(files, { level: 0 });
  const form = new FormData();
  form.set('file', new File([zip as unknown as BlobPart], 'import.zip', { type: 'application/zip' }));
  form.set('category', SECTION);
  const res = await app.request(
    '/api/admin/import/preview',
    { method: 'POST', body: form, headers: { 'CF-Connecting-IP': '1.2.3.4' } },
    undefined,
    ctx
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { res, body: (await res.json()) as Record<string, any> };
}

/**
 * Every error on one preview row, joined.
 *
 * A refused picture produces TWO lines by design: `resolveProduct` says the
 * cell resolved to nothing, and `resolveImages` says why it did. The owner
 * reads both, so a test that only ever looked at `errors[0]` would be checking
 * the half that never carries the reason.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const why = (r: any): string => (r.errors as string[]).join('\n');

/** The image URLs the preview actually banked, read out of the stored payload. */
function bankedImages(raw: ReturnType<typeof freshDb>, importId: string): string[] {
  const rec = row<{ payload: string }>(raw, 'SELECT payload FROM product_imports WHERE id = ?', importId);
  const payload = JSON.parse(rec!.payload) as {
    products: Array<{ relations: { images: Array<{ url: string }> } }>;
  };
  return payload.products.flatMap((p) => p.relations.images.map((i) => i.url));
}

/**
 * Every product-owned row the shared save planner can replace. `SELECT *` is
 * deliberate: this is a rollback assertion, so a newly added scalar,
 * dimension or relation column must automatically join the byte-for-byte
 * comparison instead of escaping an old hand-written projection.
 */
function productSnapshot(raw: ReturnType<typeof freshDb>, productId: string) {
  return {
    product: row<Record<string, unknown>>(raw, 'SELECT * FROM products WHERE id = ?', productId),
    groups: all(raw, 'SELECT * FROM product_option_groups WHERE product_id = ? ORDER BY id', productId),
    values: all(raw, 'SELECT * FROM product_option_values WHERE product_id = ? ORDER BY id', productId),
    colors: all(raw, 'SELECT * FROM product_colors WHERE product_id = ? ORDER BY id', productId),
    links: all(
      raw,
      `SELECT l.* FROM product_color_option_links l
        JOIN product_colors c ON c.id = l.color_id
       WHERE c.product_id = ? ORDER BY l.color_id, l.group_id, l.option_value_id`,
      productId
    ),
    variants: all(raw, 'SELECT * FROM product_variants WHERE product_id = ? ORDER BY id', productId),
    images: all(raw, 'SELECT * FROM product_images WHERE product_id = ? ORDER BY id', productId),
    fulfillments: all(raw, 'SELECT * FROM product_option_fulfillment WHERE product_id = ? ORDER BY id', productId),
    transports: all(raw, 'SELECT * FROM product_option_transports WHERE product_id = ? ORDER BY id', productId),
    catalogs: all(raw, 'SELECT * FROM product_catalogs WHERE product_id = ? ORDER BY catalog_id', productId),
    translations: all(raw, 'SELECT * FROM product_translations WHERE product_id = ? ORDER BY field', productId),
    search: all(raw, 'SELECT * FROM search_tokens WHERE product_id = ? ORDER BY token', productId),
    priceHistory: all(raw, 'SELECT * FROM price_history WHERE product_id = ? ORDER BY id', productId),
  };
}

/**
 * DEFECT 1, STATED AS A CONTRACT: a PNG inside the ZIP is WebP in the bucket.
 *
 * The key matters as much as the bytes. `products/import/gallery/<sha>.webp`
 * is the four-segment layout the REMOTE branch already produced, so the same
 * photograph supplied as a file and as a URL now lands on ONE object instead
 * of two — and the extension can no longer say `.png` over converted bytes.
 */
test('a PNG inside the ZIP is converted to WebP BEFORE it is stored', async () => {
  const images = imagesBinding();
  const { raw, app, bucket } = setup({ images: images.binding });
  const { res, body } = await previewZip(app, {
    'data.csv': strToU8(SHEET('images/a1.png')),
    'images/a1.png': png(),
  });

  assert.equal(res.status, 200, JSON.stringify(body));
  assert.deepEqual(body.rows[0].errors, [], 'the row must import');
  assert.equal(
    row<{ live: number }>(
      raw,
      "SELECT media_stage_until > strftime('%Y-%m-%dT%H:%M:%fZ','now') AS live FROM product_imports WHERE id = ?",
      body.import_id
    )?.live,
    1,
    'the preview durably owns staged media for the same 24-hour window as its cleanup job'
  );
  assert.deepEqual(images.calls, [{ format: 'image/webp' }], 'the server did the converting');

  const keys = [...bucket.objects.keys()];
  assert.equal(keys.length, 1, JSON.stringify(keys));
  assert.match(keys[0], /^products\/import\/gallery\/[a-f0-9]{64}\.webp$/, 'four segments, and the true extension');
  assert.equal(bucket.objects.get(keys[0])!.metadata.contentType, 'image/webp', 'and R2 serves it as WebP');
  assert.deepEqual(
    [...bucket.objects.get(keys[0])!.bytes.slice(0, 4)],
    [0x52, 0x49, 0x46, 0x46],
    'the CONVERTED bytes are stored, not the PNG that arrived'
  );
  assert.deepEqual(bankedImages(raw, body.import_id), [`/files/${keys[0]}`]);
});

/**
 * DEFECT 1, THE OTHER HALF: «ويكمل الاستيراد».
 *
 * `storeMedia` THROWS when the converter refuses an image. Uncaught, that
 * ended the whole preview with a 500 naming no row and no file — a hundred
 * good products refused because one picture was broken. The row fails, by
 * line, with a reason a person can act on; every other row still imports; and
 * nothing unconverted reaches the bucket.
 */
test('a conversion that FAILS refuses that image only — the import still completes', async () => {
  const images = imagesBinding({ fail: true });
  const { app, bucket } = setup({ images: images.binding });
  const csv = toCsv([
    ['row_type', 'key', 'name', 'status', 'category', 'price_iqd', 'stock', 'image', 'primary'],
    ['product', 'A1', 'Bambu Lab A1', 'active', 'tpl-printers', '1000000', '5', '', ''],
    ['image', 'A1', '', '', '', '', '', 'images/a1.png', 'yes'],
    ['product', 'P1', 'Bambu Lab P1S', 'active', 'tpl-printers', '2000000', '3', '', ''],
  ]);
  const { res, body } = await previewZip(app, { 'data.csv': strToU8(csv), 'images/a1.png': png() });

  assert.equal(res.status, 200, 'a broken picture is not a 500');
  const failed = body.rows.find((r: { key: string }) => r.key === 'A1');
  const survivor = body.rows.find((r: { key: string }) => r.key === 'P1');
  assert.equal(failed.action, 'failed');
  assert.match(why(failed), /تعذّر تحويل هذه الصورة/);
  assert.match(why(failed), /could not be converted/);
  assert.notEqual(survivor.action, 'failed', 'the rest of the file still imports');
  assert.equal(bucket.objects.size, 0, 'and not one unconverted byte was written');
});

/**
 * NO BINDING ON THIS DEPLOYMENT — and the question is asked BEFORE the write.
 *
 * `storeMedia` would have stored the original under its true extension and
 * only logged, which is honest for a chat attachment and wrong for a catalogue
 * the owner was told converts everything. The import asks first, so the bucket
 * stays empty.
 */
test('without the Images binding the picture is refused, not stored unconverted', async () => {
  const { app, bucket } = setup({ images: undefined });
  const { res, body } = await previewZip(app, {
    'data.csv': strToU8(SHEET('images/a1.jpg')),
    'images/a1.jpg': jpeg(),
  });
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.match(why(body.rows[0]), /غير مفعّل/);
  assert.match(why(body.rows[0]), /not enabled/);
  assert.equal(bucket.objects.size, 0);
});

/**
 * DEFECT 2. Six megabytes is over the ZIP's old 4 MB cap and under the product
 * form's 8, which is the exact gap that made the same photograph acceptable by
 * hand and impossible by file.
 */
test('an image between 4 MB and 8 MB imports — the ZIP and the form agree now', async () => {
  const images = imagesBinding();
  const { app, bucket } = setup({ images: images.binding });
  const { res, body } = await previewZip(app, {
    'data.csv': strToU8(SHEET('images/big.png')),
    'images/big.png': png(6 * 1024 * 1024),
  });
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.deepEqual(body.rows[0].errors, [], 'a 6 MB photo is what a phone takes');
  assert.equal(bucket.objects.size, 1);
});

/**
 * DEFECT 2, THE LIE. The old message told the owner the file was «غير موجودة
 * في مجلد images/» — about a file sitting in the ZIP they had just built. The
 * new one names the real reason, the real size and the real limit.
 */
test('an image over 8 MB is refused by SIZE, and the message no longer claims it is missing', async () => {
  const images = imagesBinding();
  const { app, bucket } = setup({ images: images.binding });
  const { res, body } = await previewZip(app, {
    'data.csv': strToU8(SHEET('images/huge.png')),
    'images/huge.png': png(9 * 1024 * 1024),
  });
  assert.equal(res.status, 200, JSON.stringify(body));
  const message = why(body.rows[0]);
  assert.match(message, /9\.0 ميغابايت/, 'the real size');
  assert.match(message, /الحد 8 ميغابايت/, 'and the real limit');
  assert.doesNotMatch(message, /غير موجود/, 'the file is in the ZIP; saying otherwise is false');
  assert.match(message, /9\.0 MB/, 'English too');
  assert.match(message, /مێگابایت/, 'and Kurdish — three languages, every one of them');
  assert.equal(bucket.objects.size, 0);
});

/**
 * DEFECT 3, WHERE IT ACTUALLY BITES THE OWNER: the photographs they took on
 * their phone, dropped into the images/ folder of an import.
 */
test('a HEIC photo in the ZIP is refused by name, with the export that fixes it', async () => {
  const images = imagesBinding();
  const { app, bucket } = setup({ images: images.binding });
  const { res, body } = await previewZip(app, {
    'data.csv': strToU8(SHEET('images/img_4021.heic')),
    'images/img_4021.heic': isoBmff('heic'),
  });
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(why(body.rows[0]).includes(HEIF_REFUSAL), true, why(body.rows[0]));
  assert.match(why(body.rows[0]), /JPEG/, 'and it names the export that ends the problem');
  assert.equal(bucket.objects.size, 0, 'a HEIC is never stored — least of all as a video');
});

/**
 * THE SAME PHOTOGRAPH TWICE IS ONE OBJECT. The hash is taken of the bytes as
 * they ARRIVED, so the second copy costs a HEAD and no conversion — which is
 * what keeps a 400-file archive from converting the same logo forty times.
 */
test('the same image used by two products is converted once', async () => {
  const images = imagesBinding();
  const { app, bucket } = setup({ images: images.binding });
  const csv = toCsv([
    ['row_type', 'key', 'name', 'status', 'category', 'price_iqd', 'stock', 'image', 'primary'],
    ['product', 'A1', 'Bambu Lab A1', 'active', 'tpl-printers', '1000000', '5', '', ''],
    ['image', 'A1', '', '', '', '', '', 'images/a1.png', 'yes'],
    ['product', 'P1', 'Bambu Lab P1S', 'active', 'tpl-printers', '2000000', '3', '', ''],
    ['image', 'P1', '', '', '', '', '', 'images/copy.png', 'yes'],
  ]);
  const { res, body } = await previewZip(app, {
    'data.csv': strToU8(csv),
    'images/a1.png': png(),
    'images/copy.png': png(),
  });
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(bucket.objects.size, 1, 'content-addressed: identical bytes are one object');
  assert.equal(images.calls.length, 1, 'and the converter ran once, not twice');
});

test('confirm replaces spoofed relation image metadata with the stored WebP facts', async () => {
  const images = imagesBinding();
  const { raw, app } = setup({ images: images.binding });
  const preview = await previewZip(app, {
    'data.csv': strToU8(SHEET('images/a1.png')),
    'images/a1.png': png(),
  });
  assert.equal(preview.res.status, 200, JSON.stringify(preview.body));
  assert.deepEqual(preview.body.rows[0].errors, []);

  const rec = row<{ payload: string }>(raw, 'SELECT payload FROM product_imports WHERE id = ?', preview.body.import_id)!;
  const payload = JSON.parse(rec.payload) as { products: Array<{ relations: { images: Array<Record<string, unknown>> } }> };
  Object.assign(payload.products[0].relations.images[0], {
    r2_key: '',
    width: 1,
    height: 2,
    bytes: 999_999,
    content_type: 'image/png',
  });
  raw.prepare('UPDATE product_imports SET payload = ? WHERE id = ?')
    .run(JSON.stringify(payload), preview.body.import_id);

  const confirmRes = await post(app, '/api/admin/import/confirm', { import_id: preview.body.import_id });
  const confirm = await json(confirmRes);
  assert.equal(confirmRes.status, 200, JSON.stringify(confirm));
  assert.deepEqual(confirm.summary, { created: 1, updated: 0, skipped: 0, failed: 0 });

  const stored = row<Record<string, unknown>>(
    raw,
    'SELECT url, r2_key, width, height, bytes, content_type FROM product_images LIMIT 1'
  )!;
  const key = String(stored.url).slice('/files/'.length);
  assert.deepEqual(stored, {
    url: `/files/${key}`,
    r2_key: key,
    width: 320,
    height: 240,
    bytes: 32,
    content_type: 'image/webp',
  });
});

test('confirm reports a missing staged object and writes no product or relation row', async () => {
  const images = imagesBinding();
  const { raw, app, bucket } = setup({ images: images.binding });
  const preview = await previewZip(app, {
    'data.csv': strToU8(SHEET('images/a1.png')),
    'images/a1.png': png(),
  });
  const url = bankedImages(raw, preview.body.import_id)[0];
  bucket.objects.delete(url.slice('/files/'.length));

  const confirmRes = await post(app, '/api/admin/import/confirm', { import_id: preview.body.import_id });
  const confirm = await json(confirmRes);
  assert.equal(confirmRes.status, 200, JSON.stringify(confirm));
  assert.equal(confirm.summary.failed, 1);
  assert.match(confirm.rows[0].reason, /does not exist in media storage/);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM products WHERE id = ?", confirm.rows[0].product_id), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_images'), 0);
});

test('confirm rejects an explicit non-WebP R2 MIME before the catalogue write', async () => {
  const images = imagesBinding();
  const { raw, app, bucket } = setup({ images: images.binding });
  const preview = await previewZip(app, {
    'data.csv': strToU8(SHEET('images/a1.png')),
    'images/a1.png': png(),
  });
  const url = bankedImages(raw, preview.body.import_id)[0];
  bucket.objects.get(url.slice('/files/'.length))!.metadata.contentType = 'image/png';

  const confirmRes = await post(app, '/api/admin/import/confirm', { import_id: preview.body.import_id });
  const confirm = await json(confirmRes);
  assert.equal(confirmRes.status, 200, JSON.stringify(confirm));
  assert.equal(confirm.summary.failed, 1);
  assert.match(confirm.rows[0].reason, /metadata is not image\/webp/);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM products WHERE id = ?", confirm.rows[0].product_id), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_images'), 0);
});

test('CSV create relation-batch failure leaves no product, JSON mirror or product-owned row', async () => {
  let failing: ReturnType<typeof failingD1>['failing'];
  const images = imagesBinding();
  const { raw, app } = setup({
    images: images.binding,
    dbFactory(database) {
      const wrapped = failingD1(database);
      failing = wrapped.failing;
      return wrapped.db;
    },
  });
  const preview = await previewZip(app, {
    'data.csv': strToU8(SHEET('images/a1.png')),
    'images/a1.png': png(),
  });
  assert.equal(preview.res.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.rows[0].action, 'create', JSON.stringify(preview.body));
  assert.deepEqual(preview.body.rows[0].errors, []);

  // This statement used to live in a second batch, after the products INSERT
  // had already committed. Injecting the relation failure therefore proves
  // the row and its derived JSON mirror now share that relation transaction.
  failing!.failWhen = (statements) => statements.some((statement) =>
    /INSERT\s+INTO\s+product_images/i.test(statement.sql)
  );
  const confirmRes = await post(app, '/api/admin/import/confirm', { import_id: preview.body.import_id });
  const confirm = await json(confirmRes);
  assert.equal(confirmRes.status, 200, JSON.stringify(confirm));
  assert.equal(confirm.summary.failed, 1, JSON.stringify(confirm));
  assert.match(String(confirm.rows[0].reason), /simulated D1 failure/);

  const productId = String(confirm.rows[0].product_id);
  const after = productSnapshot(raw, productId);
  assert.equal(after.product, undefined, 'the CREATE row must roll back with its relation rows');
  for (const [section, rows] of Object.entries(after).filter(([name]) => name !== 'product')) {
    assert.deepEqual(rows, [], `${section} must have no orphaned row after the failed CREATE`);
  }
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM products'), 0, 'no bare product or JSON mirror survives');
});

test('CSV confirm queues images its committed replacement detaches, while cleanup preserves a shared key', async () => {
  const { raw, app, bucket } = setup();
  const key = 'products/import/gallery/csv-detach-shared.webp';
  const url = `/files/${key}`;

  raw.exec(`
    INSERT INTO products (id, name, slug, price_iqd, stock)
      VALUES ('csv_owner', 'CSV owner', 'csv-owner', 1000000, 5);
    INSERT INTO products (id, name, slug, price_iqd, stock)
      VALUES ('shared_owner', 'Shared owner', 'shared-owner', 1000000, 5);
  `);
  raw.prepare(
    `INSERT INTO product_images
       (id, product_id, url, r2_key, sort_order, is_primary, width, height, bytes, content_type)
     VALUES ('pi_csv', 'csv_owner', ?, ?, 0, 1, 320, 240, 32, 'image/webp')`
  ).run(url, key);
  raw.prepare(
    `INSERT INTO product_images
       (id, product_id, url, r2_key, sort_order, is_primary, width, height, bytes, content_type)
     VALUES ('pi_shared', 'shared_owner', ?, ?, 0, 1, 320, 240, 32, 'image/webp')`
  ).run(url, key);
  await bucket.put(key, webpBytes(), { httpMetadata: { contentType: 'image/webp' } });

  // A CSV product row with no image children is a full relation replacement;
  // it removes csv_owner's existing product_images row on confirm.
  const csv = toCsv([
    ['row_type', 'key', 'name', 'status', 'category', 'price_iqd', 'stock'],
    ['product', 'csv-owner', 'CSV owner updated', 'active', 'tpl-printers', '1000000', '5'],
  ]);
  const preview = await previewZip(app, { 'data.csv': strToU8(csv) });
  assert.equal(preview.res.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.rows[0].action, 'update', JSON.stringify(preview.body));
  assert.deepEqual(preview.body.rows[0].errors, []);

  const confirmRes = await post(app, '/api/admin/import/confirm', { import_id: preview.body.import_id });
  const confirm = await json(confirmRes);
  assert.equal(confirmRes.status, 200, JSON.stringify(confirm));
  assert.deepEqual(confirm.summary, { created: 0, updated: 1, skipped: 0, failed: 0 });
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM product_images WHERE product_id='csv_owner'"), 0);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM product_images WHERE product_id='shared_owner'"), 1);

  const job = row<{ object_key: string; state: string; reason: string; source_product_id: string }>(
    raw,
    `SELECT object_key, state, reason, source_product_id
       FROM media_cleanup_jobs WHERE object_key = ?`,
    key
  );
  assert.deepEqual(job, {
    object_key: key,
    state: 'pending',
    reason: MEDIA_DETACH_REASON,
    source_product_id: 'csv_owner',
  });

  // The delayed worker re-reads all references. The second product still owns
  // this content-addressed object, so it closes the job without deleting R2.
  const cleanup = await runGuardedMediaCleanup({
    DB: asD1(raw),
    BUCKET: bucket,
    R2_PUBLIC: bucket,
    R2_PRIVATE: new MemoryBucket(),
  } as never);
  assert.deepEqual(cleanup.still_referenced, [key]);
  assert.equal(bucket.objects.has(key), true, 'a key shared by another product must survive cleanup');
  assert.equal(
    row<{ state: string }>(raw, 'SELECT state FROM media_cleanup_jobs WHERE object_key = ?', key)?.state,
    'skipped_shared'
  );
});

test('CSV update relation failure preserves scalars, dimensions, mirrors and relations byte-for-byte', async () => {
  let failing: ReturnType<typeof failingD1>['failing'];
  const harness = setup({
    dbFactory(raw) {
      const wrapped = failingD1(raw);
      failing = wrapped.failing;
      return wrapped.db;
    },
  });
  const { raw, app } = harness;
  const key = 'products/import/gallery/csv-rollback.webp';
  const url = `/files/${key}`;
  raw.prepare(
    `INSERT INTO products
       (id, name, slug, price_iqd, stock, options, colors, images,
        net_weight_g, width_mm, depth_mm, height_mm,
        package_weight_g, package_width_mm, package_depth_mm, package_height_mm)
     VALUES ('csv_rollback', 'CSV rollback', 'csv-rollback', 1000000, 5, ?, ?, ?,
             4200, 380, 410, 430, 6100, 510, 520, 530)`
  ).run(
    JSON.stringify([{ id: 'ov_rollback', name: 'Original Model', image: '', active: true }]),
    JSON.stringify([{ id: 'pc_rollback', name: 'Original Black', hex: '#101010', image: '', active: true }]),
    JSON.stringify([url])
  );
  raw.exec(`
    INSERT INTO product_option_groups (id, product_id, name_en, sort, active)
      VALUES ('og_rollback', 'csv_rollback', 'Model', 0, 1);
    INSERT INTO product_option_values
      (id, product_id, group_id, name_en, stock, sort, active,
       net_weight_g, width_mm, depth_mm, height_mm,
       package_weight_g, package_width_mm, package_depth_mm, package_height_mm)
      VALUES ('ov_rollback', 'csv_rollback', 'og_rollback', 'Original Model', 4, 0, 1,
              4100, 370, 400, 420, 6000, 500, 510, 520);
    INSERT INTO product_colors (id, product_id, name_en, hex, stock, sort, active)
      VALUES ('pc_rollback', 'csv_rollback', 'Original Black', '#101010', NULL, 0, 1);
    INSERT INTO product_color_option_links (color_id, option_value_id, group_id)
      VALUES ('pc_rollback', 'ov_rollback', 'og_rollback');
    INSERT INTO product_option_fulfillment
      (id, product_id, option_id, fulfillment_type, enabled, capacity, capacity_reserved, sort)
      VALUES ('pof_rollback', 'csv_rollback', 'ov_rollback', 'pre_order', 1, 7, 0, 0);
    INSERT INTO product_option_transports
      (id, product_id, fulfillment_id, method, enabled, capacity, capacity_reserved, sort)
      VALUES ('pot_rollback', 'csv_rollback', 'pof_rollback', 'sea', 1, 5, 0, 0);
    INSERT INTO product_catalogs (product_id, catalog_id, position)
      VALUES ('csv_rollback', '${SECTION}', 1);
    INSERT INTO product_translations
      (product_id, field, source_en, source_hash, text_ar, text_ckb, status, translation_version)
      VALUES ('csv_rollback', 'description', 'Old description', 'old-hash', 'قديم', 'کۆن', 'approved', 7);
    INSERT INTO search_tokens (product_id, token, weight)
      VALUES ('csv_rollback', 'rollback-old', 9);
    INSERT INTO price_history (product_id, variant_key, field, old_iqd, new_iqd, changed_by)
      VALUES ('csv_rollback', '', 'regular', 900000, 1000000, 'boss');
  `);
  raw.prepare(
    `INSERT INTO product_images
       (id, product_id, url, r2_key, sort_order, is_primary, width, height, bytes, content_type)
     VALUES ('pi_rollback', 'csv_rollback', ?, ?, 0, 1, 320, 240, 32, 'image/webp')`
  ).run(url, key);

  const csv = toCsv([
    [
      'row_type', 'key', 'name', 'status', 'category', 'price_iqd', 'stock',
      'net_weight_g', 'width_mm', 'depth_mm', 'height_mm',
      'package_weight_g', 'package_width_mm', 'package_depth_mm', 'package_height_mm',
    ],
    [
      'product', 'csv-rollback', 'CSV rollback edited', 'active', 'tpl-printers', '1200000', '8',
      '5200', '480', '510', '530', '7100', '610', '620', '630',
    ],
  ]);
  const preview = await previewZip(app, { 'data.csv': strToU8(csv) });
  assert.equal(preview.res.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.rows[0].action, 'update', JSON.stringify(preview.body));
  assert.deepEqual(preview.body.rows[0].errors, []);
  const before = productSnapshot(raw, 'csv_rollback');

  // The product UPDATE and relation DELETE now inhabit this same batch. Under
  // the old two-batch flow this injected failure left the edited name, price,
  // dimensions and empty JSON mirrors committed over the untouched rows.
  failing!.failWhen = (statements) => statements.some((statement) =>
    /DELETE\s+FROM\s+product_images/i.test(statement.sql)
  );
  const confirmRes = await post(app, '/api/admin/import/confirm', { import_id: preview.body.import_id });
  const confirm = await json(confirmRes);
  assert.equal(confirmRes.status, 200, JSON.stringify(confirm));
  assert.equal(confirm.summary.failed, 1, JSON.stringify(confirm));
  assert.match(String(confirm.rows[0].reason), /simulated D1 failure/);
  const after = productSnapshot(raw, 'csv_rollback');
  assert.deepEqual(after, before, 'every product-owned scalar, dimension and relation must roll back together');
  assert.equal(after.product?.name, 'CSV rollback', 'the attempted rename must not leak out of a failed relation save');
  assert.equal(after.product?.package_width_mm, 510, 'the attempted dimension edit must not leak either');
  assert.equal(
    count(raw, 'SELECT COUNT(*) AS n FROM media_cleanup_jobs WHERE object_key=?', key),
    0,
    'a failed relation batch may not enqueue deletion of its still-live image'
  );
});

test('CSV membership failure rolls product, relation, rule, version and rule audit back together', async () => {
  let failing: ReturnType<typeof failingD1>['failing'];
  const { raw, app } = setup({
    dbFactory(database) {
      const wrapped = failingD1(database);
      failing = wrapped.failing;
      return wrapped.db;
    },
  });
  raw.exec(`
    INSERT INTO products
      (id, name, slug, price_iqd, stock, net_weight_g, package_width_mm)
      VALUES ('csv_membership_atomic', 'Membership original', 'membership-atomic', 1000000, 3, 4100, 500);
  `);
  const csv = toCsv([
    [
      'row_type', 'key', 'name', 'status', 'category', 'price_iqd', 'stock',
      'net_weight_g', 'package_width_mm',
      'membership.pro.discount_mode', 'membership.pro.percent',
    ],
    [
      'product', 'membership-atomic', 'Membership edited', 'active', 'tpl-printers', '1200000', '8',
      '5200', '610', 'percent', '10',
    ],
  ]);
  const preview = await previewZip(app, { 'data.csv': strToU8(csv) });
  assert.equal(preview.res.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.rows[0].action, 'update', JSON.stringify(preview.body));
  assert.deepEqual(preview.body.rows[0].errors, []);
  const before = productSnapshot(raw, 'csv_membership_atomic');
  const beforeVersions = count(raw, 'SELECT COUNT(*) AS n FROM membership_benefit_versions');
  const beforeRuleAudits = count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'membership_benefit.%'");

  failing!.failWhen = (statements) => statements.some((statement) =>
    /INSERT\s+INTO\s+membership_benefit_rules/i.test(statement.sql)
  );
  const confirmRes = await post(app, '/api/admin/import/confirm', { import_id: preview.body.import_id });
  const confirm = await json(confirmRes);
  assert.equal(confirmRes.status, 200, JSON.stringify(confirm));
  assert.equal(confirm.summary.failed, 1, JSON.stringify(confirm));
  assert.match(String(confirm.rows[0].reason), /simulated D1 failure/);
  assert.deepEqual(
    productSnapshot(raw, 'csv_membership_atomic'),
    before,
    'the attempted name, price, dimensions, mirrors and relations must all roll back'
  );
  assert.equal(row<Record<string, unknown>>(raw, "SELECT * FROM products WHERE id='csv_membership_atomic'")?.name, 'Membership original');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM membership_benefit_rules WHERE product_id='csv_membership_atomic'"), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM membership_benefit_versions'), beforeVersions);
  assert.equal(
    count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'membership_benefit.%'"),
    beforeRuleAudits
  );
  assert.equal(
    row<{ action: string }>(raw, 'SELECT action FROM product_import_items WHERE import_id = ?', preview.body.import_id)?.action,
    'failed',
    'only the durable failed checkpoint may survive the rolled-back product batch'
  );
});

test('overlapping CSV confirms have one executor, then replay the identical terminal report', async () => {
  let releaseInfo!: () => void;
  let enteredInfo!: () => void;
  const infoEntered = new Promise<void>((resolve) => { enteredInfo = resolve; });
  const infoGate = new Promise<void>((resolve) => { releaseInfo = resolve; });
  let blocked = false;
  const images = imagesBinding({
    async onInfo() {
      if (blocked) return;
      blocked = true;
      enteredInfo();
      await infoGate;
    },
  });
  const { raw, app } = setup({ images: images.binding });
  const preview = await previewZip(app, {
    'data.csv': strToU8(SHEET('images/a1.png')),
    'images/a1.png': png(),
  });
  assert.equal(preview.res.status, 200, JSON.stringify(preview.body));
  raw.prepare("UPDATE product_imports SET media_stage_until='2000-01-01T00:00:00.000Z' WHERE id=?")
    .run(preview.body.import_id);

  const firstPending = post(app, '/api/admin/import/confirm', { import_id: preview.body.import_id });
  await infoEntered;
  assert.deepEqual(
    row<{ lease_live: number; stage_live: number }>(
      raw,
      `SELECT apply_lease_until > strftime('%Y-%m-%dT%H:%M:%fZ','now') AS lease_live,
              media_stage_until > strftime('%Y-%m-%dT%H:%M:%fZ','now') AS stage_live
         FROM product_imports WHERE id=?`,
      preview.body.import_id
    ),
    { lease_live: 1, stage_live: 1 },
    'acquiring a confirm lease must revive staging protection before media verification starts'
  );
  const competingRes = await post(app, '/api/admin/import/confirm', { import_id: preview.body.import_id });
  const competing = await json(competingRes);
  assert.equal(competingRes.status, 409, JSON.stringify(competing));
  assert.equal(competing.code, 'IMPORT_APPLY_IN_PROGRESS');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM products'), 0, 'the losing caller writes nothing');

  releaseInfo();
  const firstRes = await firstPending;
  const first = await json(firstRes);
  assert.equal(firstRes.status, 200, JSON.stringify(first));
  assert.deepEqual(first.summary, { created: 1, updated: 0, skipped: 0, failed: 0 });
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM products'), 1);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_import_items WHERE import_id = ?', preview.body.import_id), 1);

  const replayRes = await post(app, '/api/admin/import/confirm', { import_id: preview.body.import_id });
  const replayed = await json(replayRes);
  assert.equal(replayRes.status, 200, JSON.stringify(replayed));
  assert.equal(replayed.already_applied, true);
  assert.deepEqual(replayed.summary, first.summary);
  assert.deepEqual(replayed.rows, first.rows);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM products'), 1, 'replay never executes CREATE again');
});

test('an expired crashed confirm resumes from its atomic item checkpoint without replaying CREATE', async () => {
  const { raw, app } = setup();
  const csv = toCsv([
    ['row_type', 'key', 'name', 'status', 'category', 'price_iqd', 'stock'],
    ['product', 'A1', 'Bambu Lab A1', 'active', 'tpl-printers', '1000000', '5'],
  ]);
  const preview = await previewZip(app, { 'data.csv': strToU8(csv) });
  assert.equal(preview.res.status, 200, JSON.stringify(preview.body));
  const importRow = row<{ payload: string }>(raw, 'SELECT payload FROM product_imports WHERE id = ?', preview.body.import_id)!;
  const payload = JSON.parse(importRow.payload) as { products: Array<{ productId: string }> };
  const productId = payload.products[0].productId;

  raw.prepare(
    `UPDATE product_imports
        SET apply_token='crashed-owner', apply_generation=1,
            apply_lease_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes')
      WHERE id=?`
  ).run(preview.body.import_id);
  raw.prepare(
    `INSERT INTO products (id, name, slug, price_iqd, stock)
     VALUES (?, 'Bambu Lab A1', 'crash-checkpoint-a1', 1000000, 5)`
  ).run(productId);
  raw.prepare(
    `INSERT INTO product_import_items
       (import_id,item_index,item_key,line,product_id,action,name,reason,apply_token)
     VALUES (?,0,'A1',2,?,'created','Bambu Lab A1','','crashed-owner')`
  ).run(preview.body.import_id, productId);
  raw.prepare(
    `UPDATE product_imports SET apply_lease_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 second') WHERE id=?`
  ).run(preview.body.import_id);
  const before = productSnapshot(raw, productId);

  const confirmRes = await post(app, '/api/admin/import/confirm', { import_id: preview.body.import_id });
  const confirm = await json(confirmRes);
  assert.equal(confirmRes.status, 200, JSON.stringify(confirm));
  assert.deepEqual(confirm.summary, { created: 1, updated: 0, skipped: 0, failed: 0 });
  assert.equal(confirm.rows[0].action, 'created');
  assert.deepEqual(productSnapshot(raw, productId), before, 'resume must not touch the already committed product');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_import_items WHERE import_id = ?', preview.body.import_id), 1);
  assert.equal(row<{ apply_generation: number }>(raw, 'SELECT apply_generation FROM product_imports WHERE id=?', preview.body.import_id)?.apply_generation, 2);
});

test('the checkpoint trigger fences a stale import owner and rolls its product batch back', async () => {
  const { raw } = setup();
  raw.prepare(
    `INSERT INTO product_imports
       (id,actor_user_id,template_family,category_id,state,payload_hash,report,payload,source_name,
        apply_token,apply_lease_until,apply_generation)
     VALUES ('imp_fence','boss','devices',?,'preview','hash','[]','{}','fence.csv',
             'new-owner',strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes'),2)`
  ).run(SECTION);
  const db = asD1(raw);
  await assert.rejects(
    db.batch([
      db.prepare("INSERT INTO products (id,name,slug,price_iqd,stock) VALUES ('stale_product','Stale','stale-product',1,1)"),
      db.prepare(
        `INSERT INTO product_import_items
           (import_id,item_index,item_key,line,product_id,action,name,reason,apply_token)
         VALUES ('imp_fence',0,'stale',2,'stale_product','created','Stale','','old-owner')`
      ),
    ]),
    /IMPORT_APPLY_LEASE_LOST/
  );
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM products WHERE id='stale_product'"), 0);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM product_import_items WHERE import_id='imp_fence'"), 0);
});

test('CSV re-verifies each staged image at save time after an earlier preflight lease goes stale', async () => {
  let failing: ReturnType<typeof failingD1>['failing'];
  const images = imagesBinding({ distinct: true });
  const harness = setup({
    images: images.binding,
    dbFactory(database) {
      const wrapped = failingD1(database);
      failing = wrapped.failing;
      return wrapped.db;
    },
  });
  const { raw, app, bucket } = harness;
  const csv = toCsv([
    ['row_type', 'key', 'name', 'status', 'category', 'price_iqd', 'stock', 'image', 'primary'],
    ['product', 'A1', 'Bambu Lab A1', 'active', 'tpl-printers', '1000000', '5', '', ''],
    ['image', 'A1', '', '', '', '', '', 'images/a1.png', 'yes'],
    ['product', 'P1', 'Bambu Lab P1S', 'active', 'tpl-printers', '2000000', '3', '', ''],
    ['image', 'P1', '', '', '', '', '', 'images/p1.png', 'yes'],
  ]);
  const preview = await previewZip(app, {
    'data.csv': strToU8(csv),
    'images/a1.png': png(),
    'images/p1.png': png(65),
  });
  assert.equal(preview.res.status, 200, JSON.stringify(preview.body));
  assert.deepEqual(preview.body.rows.flatMap((r: { errors: string[] }) => r.errors), []);
  const urls = bankedImages(raw, preview.body.import_id);
  assert.equal(new Set(urls).size, 2, JSON.stringify(urls));
  const secondKey = urls[1].slice('/files/'.length);

  let removed = false;
  failing!.beforeBatch = (statements) => {
    if (removed || !statements.some((statement) => /INSERT\s+INTO\s+product_import_items/i.test(statement.sql))) return;
    removed = true;
    // Both objects passed the whole-file preflight. Model cleanup winning
    // after that old protection expires, immediately before product 1 commits.
    raw.prepare("UPDATE media_object_guards SET protected_until='' WHERE object_key=?").run(secondKey);
    bucket.objects.delete(secondKey);
  };
  const confirmRes = await post(app, '/api/admin/import/confirm', { import_id: preview.body.import_id });
  const confirm = await json(confirmRes);
  assert.equal(confirmRes.status, 200, JSON.stringify(confirm));
  assert.deepEqual(confirm.summary, { created: 1, updated: 0, skipped: 0, failed: 1 });
  const failed = confirm.rows.find((r: { action: string }) => r.action === 'failed');
  assert.match(String(failed?.reason), /does not exist in media storage/);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM products'), 1, 'the first product keeps partial-import semantics');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_images'), 1);
  assert.equal(
    count(raw, 'SELECT COUNT(*) AS n FROM product_images WHERE r2_key=?', secondKey),
    0,
    'the second product never commits a dangling relation'
  );
});

test('CSV export omits quarantined product_images so its own preview has no empty image row', async () => {
  const { raw, app } = setup();
  raw.exec(`
    INSERT INTO products (id,name,slug,price_iqd,stock,category_id,template_family)
      VALUES ('csv_quarantine_export','Quarantined export','quarantined-export',1000,1,'${SECTION}','devices');
    INSERT INTO product_catalogs (product_id,catalog_id,position)
      VALUES ('csv_quarantine_export','${SECTION}',1);
    INSERT INTO product_images
      (id,product_id,url,r2_key,source_url,sort_order,is_primary,quarantined,quarantine_reason)
      VALUES ('pi_quarantined_export','csv_quarantine_export','','','https://vendor.example/old.jpg',0,0,1,'external_url');
  `);

  const exportRes = await get(app, '/api/admin/import/export?ids=csv_quarantine_export&format=csv');
  const exported = await exportRes.text();
  assert.equal(exportRes.status, 200, exported);
  const parsed = parseImport(exported, templateShape('printer'));
  assert.equal(parsed.products.length, 1, JSON.stringify(parsed.issues));
  assert.equal(parsed.products[0].images.length, 0, 'provenance must not become an empty image child row');

  const preview = await previewZip(app, { 'data.csv': strToU8(exported) });
  assert.equal(preview.res.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.rows[0].action, 'update', JSON.stringify(preview.body));
  assert.deepEqual(preview.body.rows[0].errors, []);
  assert.equal(preview.body.rows[0].images, 0);
});

// ---------------------------------------------------------------------------
//  THE OTHER DOOR
// ---------------------------------------------------------------------------

/**
 * THE IMPORT IS NOT THE ONLY WAY A PICTURE ENTERS THIS CATALOGUE.
 *
 * `isOwnedMediaUrl` was enforced in the import and nowhere else, while the
 * ordinary admin save ran `upgradeMedia`, which took `{url: "https://…",
 * key: ""}` verbatim and wrote it into `product_images.url`. That is exactly
 * the shape of the three hotlinks the live catalogue carries, so closing the
 * import left the defect reachable by one authenticated PUT — and the owner's
 * browser posts that shape every time somebody pastes a vendor link. The rule
 * now lives in `mediaStorage.ts` and both doors read it.
 */
test('an external link cannot become a product image through the ordinary save either', () => {
  const base = {
    name_ar: 'منتج', name_en: 'Product', price_iqd: 1000,
  } as Record<string, unknown>;

  assert.throws(
    () =>
      validateProductDoc({
        ...base,
        media: [{ id: 'img_x', url: 'https://static.insales-cdn.com/images/products/1/8093/x.png', key: '' }],
      }),
    /WebP محلية|owned WebP/,
    'a bare supplier URL must be refused by the save, not stored'
  );

  // A picture we hold passes the same gate untouched.
  const ok = validateProductDoc({
    ...base,
    media: [{ id: 'img_y', url: '/files/products/catalog/gallery/abc12345.webp', key: 'products/catalog/gallery/abc12345.webp' }],
  });
  assert.equal(ok.media.length, 1);
  assert.equal(ok.media[0].url, '/files/products/catalog/gallery/abc12345.webp');
});

/**
 * AN AVIF THAT DECLARES `mif1` AS ITS MAJOR BRAND IS STILL AN AVIF.
 *
 * `mif1`/`msf1` are the GENERIC HEIF brands and are in `HEIF_BRANDS` because
 * an iPhone writes them — but several AVIF encoders, and every AVIF image
 * SEQUENCE, write `mif1` as the major brand and put `avif` in the
 * compatible-brands list instead. Reading the major brand alone, such a file
 * fell past the AVIF entry, was caught as HEIF, and the uploader told the
 * owner to re-export an iPhone photograph they never took. The comment beside
 * HEIF_BRANDS said this could not happen; now it cannot.
 */
test('an AVIF whose major brand is mif1 is not mistaken for an iPhone photo', () => {
  const ftyp = (major: string, compat: string[]): Uint8Array => {
    const size = 16 + compat.length * 4;
    const b = new Uint8Array(Math.max(size, 32));
    b[0] = (size >> 24) & 255; b[1] = (size >> 16) & 255; b[2] = (size >> 8) & 255; b[3] = size & 255;
    const put = (s: string, o: number) => { for (let i = 0; i < 4; i++) b[o + i] = s.charCodeAt(i); };
    put('ftyp', 4); put(major, 8);
    compat.forEach((c, i) => put(c, 16 + i * 4));
    return b;
  };

  const avifAsMif1 = ftyp('mif1', ['avif', 'mif1']);
  assert.equal(declaresAvif(avifAsMif1), true);
  assert.equal(isHeifBytes(avifAsMif1), false, 'an AVIF is not a HEIC');
  assert.deepEqual(sniff(avifAsMif1), { ext: 'avif', mime: 'image/avif' });

  // A real iPhone photo, with the same generic brand and no avif anywhere.
  const realHeif = ftyp('mif1', ['heic', 'mif1']);
  assert.equal(isHeifBytes(realHeif), true);
  assert.equal(sniff(realHeif), null, 'HEIC is still refused, and is still not a video');

  // And the brands that must keep working keep working.
  for (const brand of ['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'iso4', 'iso5', 'iso6', 'M4V ', 'mp4v', 'qt  ', 'dash']) {
    assert.deepEqual(sniff(ftyp(brand, [])), { ext: 'mp4', mime: 'video/mp4' }, brand);
  }
});
