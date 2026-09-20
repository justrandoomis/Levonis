import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { adminProductRelationsRoutes } from '../worker/routes/adminProductRelations';
import { all, asD1, count, freshDb, json, post, put, stubApp } from './fixtures/app';

const ADMIN = { id: 'media_admin', role: 'admin' as const, email: 'media@x.co', admin_scope: null };

function webp(width = 640, height = 480): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  bytes.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  bytes.set([0x56, 0x50, 0x38, 0x58], 12); // VP8X
  const w = width - 1;
  const h = height - 1;
  bytes.set([w & 255, (w >>> 8) & 255, (w >>> 16) & 255], 24);
  bytes.set([h & 255, (h >>> 8) & 255, (h >>> 16) & 255], 27);
  return bytes;
}

function png(): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return bytes;
}

class MemoryBucket {
  objects = new Map<string, Uint8Array>();
  contentTypes = new Map<string, string>();

  async get(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return {
      key,
      size: bytes.byteLength,
      body: new Blob([bytes]).stream(),
      arrayBuffer: () => new Blob([bytes]).arrayBuffer(),
      // Deliberately always claims WebP: the verifier must judge the body.
      httpMetadata: { contentType: this.contentTypes.get(key) ?? 'image/webp' },
    } as unknown as R2ObjectBody;
  }

  async head(key: string) {
    const bytes = this.objects.get(key);
    return bytes ? ({ key, size: bytes.byteLength } as unknown as R2Object) : null;
  }
}

function imagesBinding() {
  return {
    async info(_stream: ReadableStream) {
      return { format: 'image/webp', fileSize: 30, width: 640, height: 480 };
    },
    input(_stream: ReadableStream) {
      return {
        async output() {
          return { response: () => new Response(webp()) };
        },
      };
    },
  };
}

function setup() {
  const raw = freshDb();
  const publicBucket = new MemoryBucket();
  const legacyBucket = new MemoryBucket();
  const app = stubApp(
    asD1(raw),
    ADMIN,
    (router) => {
      router.route('/api/admin/products-v2', adminProductsRoutes);
      router.route('/api/admin/products', adminProductRelationsRoutes);
    },
    {
      env: {
        BUCKET: legacyBucket,
        R2_PUBLIC: publicBucket,
        R2_PRIVATE: new MemoryBucket(),
        IMAGES: imagesBinding(),
      },
    }
  );
  return { raw, publicBucket, app };
}

function relationImage(key: string) {
  return {
    id: 'img_1',
    url: `/files/${key}`,
    r2_key: key,
    alt_en: 'front',
    sort_order: 0,
    is_primary: true,
    content_type: 'image/webp',
    width: 640,
    height: 480,
    bytes: 30,
  };
}

function createBody(id: string, key: string) {
  return {
    id,
    name_en: 'Media gate',
    name_ar: 'بوابة الصور',
    price_iqd: 100_000,
    status: 'draft',
    relations: {
      inventory_mode: 'BASE',
      groups: [],
      colors: [],
      variants: [],
      images: [relationImage(key)],
    },
  };
}

function selectorBody(id: string, optionKey: string, colorKey: string) {
  const optionId = `${id}_option`;
  const colorId = `${id}_color`;
  return {
    id,
    name_en: 'Bound selector media',
    name_ar: 'صور مرتبطة',
    price_iqd: 100_000,
    status: 'draft',
    relations: {
      inventory_mode: 'BASE',
      groups: [
        {
          id: `${id}_group`,
          name_en: 'Model',
          values: [{ id: optionId, name_en: 'A1', image: '', active: true, sort: 0 }],
        },
      ],
      colors: [
        {
          id: colorId,
          name_en: 'Black',
          hex: '#000000',
          image: '',
          option_value_ids: [optionId],
          active: true,
          sort: 0,
        },
      ],
      variants: [],
      images: [
        {
          ...relationImage(optionKey),
          id: `${id}_option_image`,
          option_value_id: optionId,
        },
        {
          ...relationImage(colorKey),
          id: `${id}_color_image`,
          is_primary: false,
          color_id: colorId,
        },
      ],
    },
  };
}

function selectorState(raw: ReturnType<typeof freshDb>, id: string) {
  return {
    values: all(raw, 'SELECT id, image FROM product_option_values WHERE product_id = ? ORDER BY id', id),
    colors: all(raw, 'SELECT id, image FROM product_colors WHERE product_id = ? ORDER BY id', id),
    images: all(
      raw,
      `SELECT id, url, option_value_id, color_id
         FROM product_images WHERE product_id = ? ORDER BY id`,
      id
    ),
  };
}

/** The four tables the rejected write must leave byte-for-byte untouched. */
function atomicMediaState(raw: ReturnType<typeof freshDb>): string {
  return JSON.stringify({
    products: all(raw, 'SELECT * FROM products ORDER BY id'),
    product_images: all(raw, 'SELECT * FROM product_images ORDER BY id'),
    media_object_guards: all(raw, 'SELECT * FROM media_object_guards ORDER BY object_key'),
    media_cleanup_jobs: all(raw, 'SELECT * FROM media_cleanup_jobs ORDER BY id'),
  });
}

function relationBindingCases(productId: string, keyPrefix: string) {
  const optionId = `${productId}_option`;
  const colorId = `${productId}_color`;
  const variantId = `${productId}_variant`;
  const relationsFor = (key: string) => ({
    inventory_mode: 'BASE',
    groups: [
      {
        id: `${productId}_group`,
        name_en: 'Model',
        values: [{ id: optionId, name_en: 'A1', active: true, sort: 0 }],
      },
    ],
    colors: [
      {
        id: colorId,
        name_en: 'Black',
        hex: '#000000',
        option_value_ids: [optionId],
        active: true,
        sort: 0,
      },
    ],
    variants: [
      {
        id: variantId,
        option_value_ids: [optionId],
        color_id: colorId,
        active: true,
      },
    ],
    images: [{ ...relationImage(key), id: `${productId}_image` }],
  });

  return [
    {
      name: 'unknown option',
      key: `${keyPrefix}/unknown-option.webp`,
      relations: () => {
        const relations = relationsFor(`${keyPrefix}/unknown-option.webp`);
        (relations.images[0] as Record<string, unknown>).option_value_id = 'missing_option';
        return relations;
      },
    },
    {
      name: 'unknown colour',
      key: `${keyPrefix}/unknown-colour.webp`,
      relations: () => {
        const relations = relationsFor(`${keyPrefix}/unknown-colour.webp`);
        (relations.images[0] as Record<string, unknown>).color_id = 'missing_colour';
        return relations;
      },
    },
    {
      name: 'unknown variant',
      key: `${keyPrefix}/unknown-variant.webp`,
      relations: () => {
        const relations = relationsFor(`${keyPrefix}/unknown-variant.webp`);
        (relations.images[0] as Record<string, unknown>).variant_id = 'missing_variant';
        return relations;
      },
    },
    {
      name: 'multiple selector bindings',
      key: `${keyPrefix}/multiple-bindings.webp`,
      relations: () => {
        const relations = relationsFor(`${keyPrefix}/multiple-bindings.webp`);
        (relations.images[0] as Record<string, unknown>).option_value_id = optionId;
        (relations.images[0] as Record<string, unknown>).color_id = colorId;
        return relations;
      },
    },
    {
      name: 'foreign image row id',
      key: `${keyPrefix}/foreign-row.webp`,
      relations: () => {
        const relations = relationsFor(`${keyPrefix}/foreign-row.webp`);
        relations.images[0].id = 'img_owned_by_foreign_product';
        return relations;
      },
    },
  ];
}

function seedForeignImageRow(raw: ReturnType<typeof freshDb>) {
  raw.prepare(
    "INSERT INTO products (id,name,name_ar,slug,status,price_iqd) VALUES ('prd_foreign_media_owner','Foreign','أجنبي','foreign-media-owner','draft',100000)"
  ).run();
  raw.prepare(
    `INSERT INTO product_images (id, product_id, url, r2_key, content_type)
     VALUES ('img_owned_by_foreign_product', 'prd_foreign_media_owner', '/files/products/foreign/gallery/image.webp', 'products/foreign/gallery/image.webp', 'image/webp')`
  ).run();
}

test('products-v2 refuses a missing local media key before any product row commits', async () => {
  const { raw, app } = setup();
  const response = await post(
    app,
    '/api/admin/products-v2',
    createBody('prd_media_missing', 'products/prd_media_missing/gallery/missing.webp')
  );
  const body = await json(response);

  assert.equal(response.status, 400, JSON.stringify(body));
  assert.equal(body.code, 'IMAGE_REFERENCE_MISSING');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM products WHERE id='prd_media_missing'"), 0);
});

test('products-v2 refuses non-WebP bytes renamed to .webp even with WebP metadata', async () => {
  const { raw, publicBucket, app } = setup();
  const key = 'products/prd_media_fake/gallery/renamed.webp';
  publicBucket.objects.set(key, png());
  const response = await post(app, '/api/admin/products-v2', createBody('prd_media_fake', key));
  const body = await json(response);

  assert.equal(response.status, 400, JSON.stringify(body));
  assert.equal(body.code, 'IMAGE_REFERENCE_INVALID');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM products WHERE id='prd_media_fake'"), 0);
});

test('products-v2 refuses an explicit non-WebP R2 Content-Type before any D1 write', async () => {
  const { raw, publicBucket, app } = setup();
  const key = 'products/prd_media_mime/gallery/wrong-header.webp';
  publicBucket.objects.set(key, webp());
  publicBucket.contentTypes.set(key, 'image/png');
  const response = await post(app, '/api/admin/products-v2', createBody('prd_media_mime', key));
  const body = await json(response);

  assert.equal(response.status, 400, JSON.stringify(body));
  assert.equal(body.code, 'IMAGE_REFERENCE_INVALID');
  assert.match(String(body.error), /metadata.*image\/webp/i);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM products WHERE id='prd_media_mime'"), 0);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM product_images WHERE product_id='prd_media_mime'"), 0);
});

test('products-v2 accepts a present decodable WebP and persists its relation row', async () => {
  const { raw, publicBucket, app } = setup();
  const key = 'products/prd_media_real/gallery/real.webp';
  publicBucket.objects.set(key, webp());
  const request = createBody('prd_media_real', key);
  const image = request.relations.images[0] as Record<string, unknown>;
  delete image.r2_key;
  image.content_type = 'image/png';
  image.width = 1;
  image.height = 2;
  image.bytes = 999_999;
  const response = await post(app, '/api/admin/products-v2', request);
  const body = await json(response);

  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM products WHERE id='prd_media_real'"), 1);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM product_images WHERE product_id='prd_media_real'"), 1);
  const stored = raw
    .prepare(
      "SELECT r2_key, content_type, width, height, bytes FROM product_images WHERE product_id='prd_media_real'"
    )
    .get() as Record<string, unknown>;
  assert.equal(stored.r2_key, key);
  assert.equal(stored.content_type, 'image/webp');
  assert.equal(stored.width, 640);
  assert.equal(stored.height, 480);
  assert.equal(stored.bytes, 30);
});

test('relations PUT uses the same verifier and cannot attach a missing object', async () => {
  const { raw, app } = setup();
  raw.prepare(
    "INSERT INTO products (id,name,name_ar,slug,status,price_iqd) VALUES ('prd_rel_media','Media','صورة','rel-media','draft',100000)"
  ).run();
  const key = 'products/prd_rel_media/gallery/missing.webp';
  const response = await put(app, '/api/admin/products/prd_rel_media/relations', {
    inventory_mode: 'BASE',
    groups: [],
    colors: [],
    variants: [],
    images: [relationImage(key)],
  });
  const body = await json(response);

  assert.equal(response.status, 400, JSON.stringify(body));
  assert.equal(body.code, 'IMAGE_REFERENCE_MISSING');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM product_images WHERE product_id='prd_rel_media'"), 0);
});

test('relations PUT persists verified key and byte metadata instead of caller claims', async () => {
  const { raw, publicBucket, app } = setup();
  raw.prepare(
    "INSERT INTO products (id,name,name_ar,slug,status,price_iqd) VALUES ('prd_rel_verified','Media','صورة','rel-verified','draft',100000)"
  ).run();
  const key = 'products/prd_rel_verified/gallery/real.webp';
  publicBucket.objects.set(key, webp(800, 600));
  const image = relationImage(key) as Record<string, unknown>;
  delete image.r2_key;
  image.content_type = 'text/plain';
  image.width = 7;
  image.height = 8;
  image.bytes = 9;

  const response = await put(app, '/api/admin/products/prd_rel_verified/relations', {
    inventory_mode: 'BASE',
    groups: [],
    colors: [],
    variants: [],
    images: [image],
  });
  const body = await json(response);

  assert.equal(response.status, 200, JSON.stringify(body));
  const stored = raw
    .prepare(
      "SELECT r2_key, content_type, width, height, bytes FROM product_images WHERE product_id='prd_rel_verified'"
    )
    .get() as Record<string, unknown>;
  assert.equal(stored.r2_key, key);
  assert.equal(stored.content_type, 'image/webp');
  assert.equal(stored.width, 640);
  assert.equal(stored.height, 480);
  assert.equal(stored.bytes, 30);
});

test('products-v2 relation preflight rejects every invalid image binding before media guards or catalogue rows change', async () => {
  const { raw, publicBucket, app } = setup();
  seedForeignImageRow(raw);
  const productId = 'prd_preflight_create';
  const cases = relationBindingCases(productId, `products/${productId}/gallery`);

  for (const invalid of cases) {
    publicBucket.objects.set(invalid.key, webp());
    const before = atomicMediaState(raw);
    const request: Record<string, unknown> = createBody(productId, invalid.key);
    request.relations = invalid.relations();

    const response = await post(app, '/api/admin/products-v2', request);
    const body = await json(response);

    assert.equal(response.status, 400, `${invalid.name}: ${JSON.stringify(body)}`);
    assert.equal(body.code, 'VALIDATION', `${invalid.name}: ${JSON.stringify(body)}`);
    assert.equal(
      atomicMediaState(raw),
      before,
      `${invalid.name}: products/product_images/media_object_guards/media_cleanup_jobs changed`
    );
  }
});

test('relations PUT preflight rejects every invalid image binding before media guards or persisted rows change', async () => {
  const { raw, publicBucket, app } = setup();
  seedForeignImageRow(raw);
  const productId = 'prd_preflight_relations';
  raw.prepare(
    "INSERT INTO products (id,name,name_ar,slug,status,price_iqd) VALUES ('prd_preflight_relations','Target','هدف','preflight-relations','draft',100000)"
  ).run();
  const cases = relationBindingCases(productId, `products/${productId}/gallery`);

  for (const invalid of cases) {
    publicBucket.objects.set(invalid.key, webp());
    const before = atomicMediaState(raw);
    const response = await put(
      app,
      `/api/admin/products/${productId}/relations`,
      invalid.relations()
    );
    const body = await json(response);

    assert.equal(response.status, 400, `${invalid.name}: ${JSON.stringify(body)}`);
    assert.equal(body.code, 'VALIDATION', `${invalid.name}: ${JSON.stringify(body)}`);
    assert.equal(
      atomicMediaState(raw),
      before,
      `${invalid.name}: products/product_images/media_object_guards/media_cleanup_jobs changed`
    );
  }
});

test('relations PUT rejects an external option scalar image and preserves its bound product_image', async () => {
  const { raw, publicBucket, app } = setup();
  const id = 'prd_scalar_option';
  const optionKey = `products/${id}/gallery/option.webp`;
  const colorKey = `products/${id}/gallery/color.webp`;
  publicBucket.objects.set(optionKey, webp());
  publicBucket.objects.set(colorKey, webp());
  const request = selectorBody(id, optionKey, colorKey);

  let response = await post(app, '/api/admin/products-v2', request);
  assert.equal(response.status, 200, JSON.stringify(await json(response)));
  const before = selectorState(raw, id);
  assert.equal(before.values[0]?.image, '');
  assert.equal(before.colors[0]?.image, '');
  assert.equal(before.images.length, 2);

  request.relations.groups[0].values[0].image = 'https://vendor.example/unverified-option.jpg';
  response = await put(app, `/api/admin/products/${id}/relations`, request.relations);
  const body = await json(response);

  assert.equal(response.status, 400, JSON.stringify(body));
  assert.equal(body.code, 'VALIDATION');
  assert.ok(
    (body.errors as string[]).some((error) => /\.image:.*relations\.images.*option_value_id/.test(error)),
    JSON.stringify(body.errors)
  );
  assert.deepEqual(selectorState(raw, id), before, 'the rejected scalar cannot replace or disturb bound media');
});

test('products-v2 rejects a local color scalar image and preserves its bound product_image', async () => {
  const { raw, publicBucket, app } = setup();
  const id = 'prd_scalar_color';
  const optionKey = `products/${id}/gallery/option.webp`;
  const colorKey = `products/${id}/gallery/color.webp`;
  publicBucket.objects.set(optionKey, webp());
  publicBucket.objects.set(colorKey, webp());
  const request = selectorBody(id, optionKey, colorKey);

  let response = await post(app, '/api/admin/products-v2', request);
  assert.equal(response.status, 200, JSON.stringify(await json(response)));
  const before = selectorState(raw, id);
  assert.equal(before.values[0]?.image, '');
  assert.equal(before.colors[0]?.image, '');
  assert.equal(before.images.length, 2);

  request.relations.colors[0].image = '/files/products/unverified/color.webp';
  response = await post(app, '/api/admin/products-v2', request);
  const body = await json(response);

  assert.equal(response.status, 400, JSON.stringify(body));
  assert.equal(body.code, 'VALIDATION');
  assert.ok(
    (body.errors as string[]).some((error) => /\.image:.*relations\.images.*color_id/.test(error)),
    JSON.stringify(body.errors)
  );
  assert.deepEqual(selectorState(raw, id), before, 'the rejected scalar cannot replace or disturb bound media');
});

test('products-v2 preserves omitted product dimensions and explicit null clears only one field', async () => {
  const { raw, app } = setup();
  const id = 'prd_dimension_partial_update';
  const dimensions = {
    net_weight_g: 8_300,
    width_mm: 385,
    depth_mm: 410,
    height_mm: 430,
    package_weight_g: 13_000,
    package_width_mm: 596,
    package_depth_mm: 536,
    package_height_mm: 325,
  };
  const base = {
    id,
    name_en: 'Dimension preserve',
    name_ar: 'حفظ الأبعاد',
    price_iqd: 100_000,
    status: 'draft',
  };

  let response = await post(app, '/api/admin/products-v2', { ...base, dimensions });
  assert.equal(response.status, 200, JSON.stringify(await json(response)));

  response = await post(app, '/api/admin/products-v2', base);
  assert.equal(response.status, 200, JSON.stringify(await json(response)));
  let stored = raw.prepare(
    `SELECT net_weight_g,width_mm,depth_mm,height_mm,
            package_weight_g,package_width_mm,package_depth_mm,package_height_mm
       FROM products WHERE id=?`
  ).get(id) as Record<string, unknown>;
  assert.deepEqual({ ...stored }, dimensions, 'omitting dimensions on update preserves all eight stored fields');

  response = await post(app, '/api/admin/products-v2', {
    ...base,
    dimensions: { package_width_mm: null },
  });
  assert.equal(response.status, 200, JSON.stringify(await json(response)));
  stored = raw.prepare(
    `SELECT net_weight_g,width_mm,depth_mm,height_mm,
            package_weight_g,package_width_mm,package_depth_mm,package_height_mm
       FROM products WHERE id=?`
  ).get(id) as Record<string, unknown>;
  assert.deepEqual({ ...stored }, { ...dimensions, package_width_mm: null });
});
