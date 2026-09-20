/**
 * ONE WRITER, ONE ANSWER — the regressions of the second parity review.
 *
 * `tests/templateApplyParity.test.ts` proves the fifteen root causes of
 * docs/TXT_IMPORT_PARITY.md §4 stay fixed. This file is the fixed form of the
 * repros that came AFTER them: the defects the shared persistence contract
 * still carried once both paths were using it. Each test is named by what it
 * guards, and — like its neighbour — nothing here trusts a parser, an echo or
 * a 200. Every verdict is read back from the tables and from the two endpoints
 * `ProductForm` calls:
 *
 *   HIGH  the JSON mirror on `products` outlived the rows it mirrors, so
 *         deleting the last option/colour/picture resurrected them on the next
 *         read and the storefront kept selling them;
 *   HIGH  deleting an emptied option GROUP cascade-deleted a kept value and
 *         re-inserted it with `reserved` back at 0 — reserved inventory
 *         destroyed with a 200 and no warning;
 *   HIGH  a form CREATE committed the product row in one request and the
 *         structure in another, leaving a bare product behind whenever the
 *         structure was refused;
 *   HIGH  the VARIANT_COMBINATION guard passed exactly when the save deleted
 *         the last combination, leaving an unsellable product;
 *   MED   an omitted `inventory_mode` re-derived the stock level instead of
 *         preserving it; a duplicate product SKU answered 500; the id and SKU
 *         lookups bound more parameters than D1 allows;
 *   MED   the confirm-once answer dropped `unknown_keys`;
 *   LOW   an option value or colour a live order names was deleted outright.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, post, get, json, all, row, count, type App } from './fixtures/app';
import { templateRoutes } from '../worker/routes/template';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { adminProductRelationsRoutes } from '../worker/routes/adminProductRelations';
import { adminTaxonomyRoutes } from '../worker/routes/adminTaxonomy';
import { productRoutes } from '../worker/routes/products';
import { toEditorDoc } from '../src/components/adminProducts/types';
import {
  hydrateRelations,
  relationsToWire,
  type RelationsResponse,
} from '../src/components/adminProducts/form/model';
import { fixtureWebp, productMediaFixtureEnv } from './fixtures/productMedia';

const OWNER = { id: 'usr_owner', role: 'admin' as const, email: 'boss@x.co', admin_scope: null };

const mount = (a: Parameters<Parameters<typeof stubApp>[2]>[0]) => {
  a.route('/api/admin/template', templateRoutes);
  a.route('/api/admin/products-v2', adminProductsRoutes);
  a.route('/api/admin/products', adminProductRelationsRoutes);
  a.route('/api/admin/taxonomy', adminTaxonomyRoutes);
  a.route('/api/products', productRoutes);
};

function setup() {
  const raw = freshDb();
  raw.prepare("INSERT INTO brands (id, slug, name_ar, name_en) VALUES ('brd_bambu','bambu','بامبو','Bambu Lab')").run();
  const db = asD1(raw);
  const media = productMediaFixtureEnv();
  return { raw, db, ...media, app: stubApp(db, OWNER, mount, { env: media.env }) };
}

const put = (a: App, path: string, body: unknown) =>
  a.request(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
    body: JSON.stringify(body),
  });

const apply = async (a: App, text: string, mode: 'draft' | 'update' = 'draft', extra: Record<string, unknown> = {}) => {
  const res = await post(a, '/api/admin/template/apply', { text, mode, confirm: true, ...extra });
  return { status: res.status, body: await json(res) };
};

const stamp = (raw: DatabaseSync, id: string) => String(row(raw, 'SELECT updated_at FROM products WHERE id = ?', id)!.updated_at);

const mirrorOf = (raw: DatabaseSync, id: string) => {
  const r = all<{ options: string; colors: string; images: string }>(
    raw,
    'SELECT options, colors, images FROM products WHERE id = ?',
    id
  )[0];
  return {
    options: JSON.parse(r.options || '[]').length,
    colors: JSON.parse(r.colors || '[]').length,
    images: JSON.parse(r.images || '[]').length,
  };
};

/** Exactly the two GETs the form issues, through exactly the two client
 *  transforms it runs over their answers. */
async function formState(a: App, id: string) {
  const p = await json(await get(a, `/api/admin/products-v2/${id}`));
  const r = await json(await get(a, `/api/admin/products/${id}/relations`));
  assert.equal(p.success, true, JSON.stringify(p));
  return { doc: toEditorDoc(p.product), rel: hydrateRelations(r as unknown as RelationsResponse, p.product) };
}

const TXT_TWO_OPTIONS = `template_version=2
slug=mirror-parity
name_ar=منتج
name_en=Mirror Parity
status=draft
price_iqd=100000
brand=bambu
options.1.id=opt_a
options.1.group=Model
options.1.name_ar=ألف
options.1.name_en=Alpha
options.1.active=true
options.2.id=opt_b
options.2.group=Model
options.2.name_ar=باء
options.2.name_en=Beta
options.2.active=true
colors.1.id=col_k
colors.1.name_ar=أسود
colors.1.name_en=Black
colors.1.hex=#000000
images.1.id=img_a
images.1.url=/files/products/catalog/gallery/aaa00001.webp
images.1.primary=true
`;

// ===================================================================== mirror

test('the JSON mirror never outlives the rows: emptying the structure empties `products.options/colors/images` too', async () => {
  const { raw, app } = setup();
  const created = await apply(app, TXT_TWO_OPTIONS);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = created.body.product_id as string;
  assert.deepEqual(mirrorOf(raw, id), { options: 2, colors: 1, images: 1 }, 'the create mirrors its own rows');

  // The admin opens the product, deletes every group, colour and picture, and
  // saves — the way ProductForm does it now: ONE request carrying both.
  const before = await formState(app, id);
  assert.equal(before.rel.groups.flatMap((g) => g.values).length, 2);
  const emptied = { ...before.rel, groups: [], colors: [], variants: [], images: [] };
  const saved = await json(
    await post(app, '/api/admin/products-v2', {
      ...before.doc,
      status: 'draft',
      relations: relationsToWire(emptied),
      expected_updated_at: stamp(raw, id),
    })
  );
  assert.equal(saved.success, true, JSON.stringify(saved));

  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_option_values WHERE product_id = ?', id), 0);
  assert.deepEqual(mirrorOf(raw, id), { options: 0, colors: 0, images: 0 }, 'the mirror went with the rows');

  // And the two readers agree: the form shows nothing, the storefront sells
  // nothing. Before the fix both read the surviving mirror instead.
  const after = await formState(app, id);
  assert.equal(after.doc.options.length, 0, 'the admin GET must not resurrect the deleted options');
  assert.equal(after.rel.groups.length, 0);
  raw.prepare("UPDATE products SET status='active' WHERE id = ?").run(id);
  const pub = await json(await get(app, '/api/products/mirror-parity'));
  assert.equal((pub.product?.options ?? []).length, 0, 'the storefront must not sell the deleted options');
  assert.equal((pub.product?.colors ?? []).length, 0);
});

test('a quarantined legacy image survives an unchanged form save, stays off the storefront, and repairs through its original id', async () => {
  const { raw, app, publicBucket } = setup();
  const made = await json(
    await post(app, '/api/admin/products-v2', {
      name_en: 'Quarantine Save',
      name_ar: 'صورة معزولة',
      price_iqd: 100000,
      status: 'draft',
    })
  );
  const id = made.product.id as string;
  const source = 'https://vendor.example/legacy-front.jpg';
  const staleKey = 'products/catalog/gallery/stale-doc.webp';
  raw.prepare('UPDATE products SET images = ? WHERE id = ?').run(
    JSON.stringify([{
      id: 'stale_doc', url: `/files/${staleKey}`, key: staleKey, role: 'gallery',
      alt_en: 'Stale', order: 0, primary: true,
    }]),
    id
  );
  raw.prepare(
    `INSERT INTO product_images
       (id, product_id, url, r2_key, source_url, alt_en, sort_order, is_primary, quarantined, quarantine_reason)
     VALUES ('img_quarantine', ?, '', '', ?, 'Legacy front', 0, 0, 1, 'external_or_unsafe_url')`
  ).run(id, source);

  const before = await formState(app, id);
  assert.equal(before.rel.images.length, 0, 'quarantine is not an active form/gallery image');
  assert.deepEqual(before.rel.quarantined_images, [{
    id: 'img_quarantine',
    source_url: source,
    quarantine_reason: 'external_or_unsafe_url',
    alt_en: 'Legacy front',
    sort_order: 0,
    option_value_id: null,
    color_id: null,
    variant_id: null,
  }]);
  assert.equal(before.doc.media.length, 0, 'a quarantine row suppresses the stale document-image fallback');

  const unchanged = await post(app, '/api/admin/products-v2', {
    ...before.doc,
    status: 'draft',
    relations: relationsToWire(before.rel),
    expected_updated_at: stamp(raw, id),
  });
  assert.equal(unchanged.status, 200, await unchanged.text());
  assert.deepEqual(
    row(raw, "SELECT url,r2_key,source_url,quarantined,quarantine_reason FROM product_images WHERE id='img_quarantine'"),
    { url: '', r2_key: '', source_url: source, quarantined: 1, quarantine_reason: 'external_or_unsafe_url' },
    'the full-replacement save preserves repair provenance'
  );

  raw.prepare("UPDATE products SET status='active' WHERE id = ?").run(id);
  const publicRead = await json(await get(app, '/api/products/quarantine-save'));
  assert.equal(publicRead.success, true, JSON.stringify(publicRead));
  assert.deepEqual(publicRead.product.media, []);
  assert.deepEqual(publicRead.product.images, []);

  // This is the state the UI creates after its guarded re-ingest button
  // succeeds: the quarantine entry is removed and verified local media reuses
  // its id. The server verifier reads the bytes before clearing quarantine.
  const repairedKey = 'products/catalog/gallery/repaired-quarantine.webp';
  publicBucket.objects.set(repairedKey, fixtureWebp());
  const repairState = await formState(app, id);
  repairState.rel.quarantined_images = [];
  repairState.rel.images = [{
    id: 'img_quarantine',
    url: `/files/${repairedKey}`,
    r2_key: repairedKey,
    source_url: source,
    alt_en: 'Legacy front',
    sort_order: 0,
    is_primary: true,
    option_value_id: null,
    color_id: null,
    variant_id: null,
    width: null,
    height: null,
    bytes: null,
    content_type: 'image/webp',
  }];
  const repaired = await post(app, '/api/admin/products-v2', {
    ...repairState.doc,
    status: 'draft',
    relations: relationsToWire(repairState.rel),
    expected_updated_at: stamp(raw, id),
  });
  assert.equal(repaired.status, 200, await repaired.text());
  assert.deepEqual(
    row(raw, "SELECT url,r2_key,source_url,quarantined,quarantine_reason FROM product_images WHERE id='img_quarantine'"),
    {
      url: `/files/${repairedKey}`,
      r2_key: repairedKey,
      source_url: source,
      quarantined: 0,
      quarantine_reason: '',
    }
  );
});

test('a rolling URL-only local row echoed by GET survives an unchanged form save', async () => {
  const { raw, app } = setup();
  const made = await json(await post(app, '/api/admin/products-v2', {
    slug: 'legacy-url-only-keep',
    name_en: 'Legacy URL Keep',
    name_ar: 'صورة قديمة محفوظة',
    price_iqd: 100000,
    status: 'draft',
  }));
  const id = made.product.id as string;
  const key = 'products/legacy/gallery/url-only-keep.webp';
  raw.prepare(
    `INSERT INTO product_images
       (id, product_id, url, r2_key, source_url, sort_order, is_primary, quarantined, quarantine_reason)
     VALUES ('img_url_only_keep', ?, ?, '', '', 0, 0, 0, '')`
  ).run(id, `/files/${key}`);

  const state = await formState(app, id);
  assert.equal(state.rel.images.length, 0, 'a URL-only row is not display-safe without its canonical key');
  assert.equal(state.rel.quarantined_images?.[0]?.id, 'img_url_only_keep');
  assert.equal(state.rel.quarantined_images?.[0]?.source_url, `/files/${key}`);

  const response = await post(app, '/api/admin/products-v2', {
    ...state.doc,
    status: 'draft',
    relations: relationsToWire(state.rel),
    expected_updated_at: stamp(raw, id),
  });
  assert.equal(response.status, 200, await response.text());
  assert.deepEqual(
    row(raw, "SELECT url,r2_key,quarantined FROM product_images WHERE id='img_url_only_keep'"),
    { url: `/files/${key}`, r2_key: '', quarantined: 0 },
    'the validated quarantine echo keeps the rolling legacy row unchanged'
  );
  assert.equal(
    count(raw, 'SELECT COUNT(*) AS n FROM media_cleanup_jobs WHERE object_key = ?', key),
    0,
    'an unchanged form save must not enqueue the still-referenced object'
  );
});

test('explicitly removing a rolling URL-only quarantine deletes its row and queues its owned object', async () => {
  const { raw, app } = setup();
  const made = await json(await post(app, '/api/admin/products-v2', {
    slug: 'legacy-url-only-remove',
    name_en: 'Legacy URL Remove',
    name_ar: 'حذف صورة قديمة',
    price_iqd: 100000,
    status: 'draft',
  }));
  const id = made.product.id as string;
  const key = 'products/legacy/gallery/url-only-remove.webp';
  raw.prepare(
    `INSERT INTO product_images
       (id, product_id, url, r2_key, source_url, sort_order, is_primary, quarantined, quarantine_reason)
     VALUES ('img_url_only_remove', ?, ?, '', '', 0, 0, 0, '')`
  ).run(id, `/files/${key}`);

  const state = await formState(app, id);
  assert.equal(state.rel.quarantined_images?.[0]?.id, 'img_url_only_remove');
  state.rel.quarantined_images = [];
  const response = await post(app, '/api/admin/products-v2', {
    ...state.doc,
    status: 'draft',
    relations: relationsToWire(state.rel),
    expected_updated_at: stamp(raw, id),
  });
  assert.equal(response.status, 200, await response.text());
  assert.equal(
    count(raw, "SELECT COUNT(*) AS n FROM product_images WHERE id='img_url_only_remove'"),
    0,
    'absence from the explicit quarantine replacement is a real removal'
  );
  assert.equal(
    count(raw, "SELECT COUNT(*) AS n FROM media_cleanup_jobs WHERE object_key = ? AND state = 'pending'", key),
    1,
    'the owned URL-only key reaches durable cleanup after the row commits'
  );
});

test('a relations-only PUT owns the mirror too — the endpoint that deletes the rows rewrites the copy', async () => {
  const { raw, app } = setup();
  const id = (await apply(app, TXT_TWO_OPTIONS)).body.product_id as string;
  const res = await put(app, `/api/admin/products/${id}/relations`, {
    inventory_mode: 'BASE',
    groups: [],
    colors: [],
    variants: [],
    images: [],
  });
  assert.equal(res.status, 200, await res.text());
  assert.deepEqual(mirrorOf(raw, id), { options: 0, colors: 0, images: 0 });
});

test('the same structure leaves the same `products` row whether it came from a TXT file or from the form', async () => {
  const { raw, app } = setup();
  const txtId = (await apply(app, TXT_TWO_OPTIONS)).body.product_id as string;

  const made = await json(
    await post(app, '/api/admin/products-v2', {
      name_en: 'By Form',
      name_ar: 'بالنموذج',
      price_iqd: 100000,
      status: 'draft',
      relations: {
        inventory_mode: 'BASE',
        groups: [
          {
            id: 'fg1',
            name_en: 'Model',
            sort: 0,
            active: true,
            values: [
              { id: 'fv1', name_en: 'Alpha', name_ar: 'ألف', sort: 0, active: true },
              { id: 'fv2', name_en: 'Beta', name_ar: 'باء', sort: 1, active: true },
            ],
          },
        ],
        colors: [{ id: 'fc1', name_en: 'Black', name_ar: 'أسود', hex: '#000000', sort: 0, active: true, option_value_ids: [] }],
        variants: [],
        images: [{ id: 'fi1', url: '/files/products/catalog/gallery/aaa00001.webp', alt_en: '', sort_order: 0, is_primary: true }],
      },
    })
  );
  assert.equal(made.success, true, JSON.stringify(made));
  assert.deepEqual(mirrorOf(raw, made.product.id as string), mirrorOf(raw, txtId));
});

// ============================================== atomicity of the form create

test('a form CREATE is ONE batch: a refused colour leaves no product row behind', async () => {
  const { raw, app } = setup();
  const res = await post(app, '/api/admin/products-v2', {
    name_en: 'Half Saved',
    name_ar: 'نصف محفوظ',
    price_iqd: 100000,
    status: 'draft',
    relations: {
      inventory_mode: 'BASE',
      groups: [],
      // The empty hex the writer refuses — the same rule §7.2 records for the
      // TXT path, which already refused the whole apply.
      colors: [{ id: 'c1', name_en: 'Nope', hex: '', sort: 0, active: true, option_value_ids: [] }],
      variants: [],
      images: [],
    },
  });
  const body = await json(res);
  assert.equal(res.status, 400, JSON.stringify(body));
  assert.equal(body.code, 'VALIDATION');
  assert.ok(
    (body.errors as string[]).some((e) => e.includes('colors[0].hex')),
    `the refusal names the row: ${JSON.stringify(body.errors)}`
  );
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM products'), 0, 'no bare product row was committed');
});

// ================================================== reserved inventory safety

test('moving an option value out of a group that then disappears keeps its reserved units', async () => {
  const { raw, app } = setup();
  const id = (
    await apply(
      app,
      `template_version=2
slug=reserved-move
name_ar=محجوز
name_en=Reserved Move
status=draft
price_iqd=500000
brand=bambu
options.1.id=opt_a
options.1.group=Model
options.1.name_en=A
options.1.stock=4
options.2.id=opt_b
options.2.group=Nozzle
options.2.name_en=B
options.2.stock=2
`
    )
  ).body.product_id as string;

  // A live order holds 2 units of opt_b.
  raw.prepare("UPDATE product_option_values SET reserved = 2, stock = 5 WHERE id = 'opt_b'").run();

  // The owner moves opt_b into "Model"; "Nozzle" is left empty and deleted.
  // `product_option_values.group_id` cascades on the group, so deleting the
  // group BEFORE re-pointing the value wiped the row and the upsert brought it
  // back with `reserved` at its DEFAULT 0.
  const rel = await json(await get(app, `/api/admin/products/${id}/relations`));
  const model = (rel.groups as Array<{ id: string; name_en: string }>).find((g) => g.name_en === 'Model')!;
  const res = await put(app, `/api/admin/products/${id}/relations`, {
    inventory_mode: 'OPTION',
    groups: [
      {
        id: model.id,
        name_en: 'Model',
        sort: 0,
        active: true,
        values: [
          { id: 'opt_a', name_en: 'A', sort: 0, active: true, stock: 4 },
          { id: 'opt_b', name_en: 'B', sort: 1, active: true, stock: 5 },
        ],
      },
    ],
    colors: [],
    variants: [],
    images: [],
  });
  assert.equal(res.status, 200, await res.text());
  const after = row(raw, "SELECT reserved, stock, group_id FROM product_option_values WHERE id = 'opt_b'")!;
  assert.equal(Number(after.reserved), 2, 'the reserved units survived the group move');
  assert.equal(Number(after.stock), 5);
  assert.equal(String(after.group_id), model.id, 'and the value really moved');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_option_groups WHERE product_id = ?', id), 1);
});

test('the same group move through a TXT apply keeps the reserved units', async () => {
  const { raw, app } = setup();
  const base = `template_version=2
slug=reserved-txt
name_ar=محجوز
name_en=Reserved Txt
status=draft
price_iqd=500000
brand=bambu
options.1.id=opt_a
options.1.group=Model
options.1.name_en=A
options.1.stock=4
options.2.id=opt_b
options.2.group=Nozzle
options.2.name_en=B
options.2.stock=2
`;
  const id = (await apply(app, base)).body.product_id as string;
  raw.prepare("UPDATE product_option_values SET reserved = 3, stock = 6 WHERE id = 'opt_b'").run();

  const r = await apply(
    app,
    `template_version=2
product_id=${id}
expected_updated_at=${stamp(raw, id)}
options.1.id=opt_a
options.1.group=Model
options.1.name_en=A
options.1.stock=4
options.2.id=opt_b
options.2.group=Model
options.2.name_en=B
options.2.stock=6
`,
    'update'
  );
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(Number(row(raw, "SELECT reserved FROM product_option_values WHERE id = 'opt_b'")!.reserved), 3);
});

// ============================================ inventory_mode: preserve, then derive

test('an omitted inventory_mode preserves the stored level instead of re-deriving it', async () => {
  const { raw, app } = setup();
  const id = (
    await apply(
      app,
      `template_version=2
slug=mode-preserve
name_ar=لون
name_en=Mode Preserve
status=draft
price_iqd=100000
brand=bambu
colors.1.id=col_red
colors.1.name_en=Red
colors.1.hex=#ff0000
colors.1.stock=5
`
    )
  ).body.product_id as string;
  assert.equal(row(raw, 'SELECT inventory_mode FROM products WHERE id = ?', id)!.inventory_mode, 'COLOR');

  // A client that predates the field renames the colour and states no stock.
  const res = await put(app, `/api/admin/products/${id}/relations`, {
    groups: [],
    colors: [{ id: 'col_red', name_en: 'Crimson', hex: '#ff0000', sort: 0, active: true, stock: null }],
    variants: [],
    images: [],
  });
  assert.equal(res.status, 200, await res.text());
  assert.equal(
    row(raw, 'SELECT inventory_mode FROM products WHERE id = ?', id)!.inventory_mode,
    'COLOR',
    'a body that says nothing about the mode must not change which level counts the stock'
  );

  // But a body that removes the level's rows altogether cannot preserve it:
  // the mode is re-derived and the caller is TOLD.
  const gone = await put(app, `/api/admin/products/${id}/relations`, { groups: [], colors: [], variants: [], images: [] });
  const goneBody = await json(gone);
  assert.equal(gone.status, 200, JSON.stringify(goneBody));
  assert.equal(row(raw, 'SELECT inventory_mode FROM products WHERE id = ?', id)!.inventory_mode, 'BASE');
  assert.ok(
    (goneBody.warnings as string[]).some((w) => w.includes('COLOR') && w.includes('BASE')),
    `the change of level is named: ${JSON.stringify(goneBody.warnings)}`
  );
});

test('VARIANT_COMBINATION is judged on what REMAINS: a save that deletes the last combination is refused', async () => {
  const { raw, app } = setup();
  const made = await json(
    await post(app, '/api/admin/products-v2', { name_en: 'Combo', name_ar: 'تركيبة', price_iqd: 100000, status: 'draft' })
  );
  const id = made.product.id as string;
  const structure = {
    groups: [
      {
        id: 'g1',
        name_en: 'Model',
        sort: 0,
        active: true,
        values: [{ id: 'v1', name_en: 'A', sort: 0, active: true }],
      },
    ],
    colors: [],
    images: [],
  };
  const ok = await put(app, `/api/admin/products/${id}/relations`, {
    ...structure,
    inventory_mode: 'VARIANT_COMBINATION',
    variants: [{ id: 'pv1', option_value_ids: ['v1'], color_id: null, stock: 5 }],
  });
  assert.equal(ok.status, 200, await ok.text());
  assert.equal(row(raw, 'SELECT inventory_mode FROM products WHERE id = ?', id)!.inventory_mode, 'VARIANT_COMBINATION');

  // The stored variant is the one this save deletes, so it cannot satisfy the
  // guard: a product in VARIANT_COMBINATION with no combination answers every
  // selection with VARIANT_NOT_MODELLED and cannot be sold at all.
  const bad = await put(app, `/api/admin/products/${id}/relations`, {
    ...structure,
    inventory_mode: 'VARIANT_COMBINATION',
    variants: [],
  });
  const badBody = await json(bad);
  assert.equal(bad.status, 400, JSON.stringify(badBody));
  assert.ok((badBody.errors as string[]).some((e) => e.includes('VARIANT_COMBINATION')), JSON.stringify(badBody.errors));
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_variants WHERE product_id = ?', id), 1, 'nothing was deleted');
});

// ======================================================== named refusals

test('a duplicate product SKU is refused by name, on both paths, and nothing is written', async () => {
  const { raw, app } = setup();
  const first = await apply(
    app,
    `template_version=2
slug=dup-one
name_ar=واحد
name_en=One
status=draft
price_iqd=100000
brand=bambu
sku=DUP-1
`
  );
  assert.equal(first.status, 200, JSON.stringify(first.body));

  const second = await apply(
    app,
    `template_version=2
slug=dup-two
name_ar=اثنان
name_en=Two
status=draft
price_iqd=100000
brand=bambu
sku=DUP-1
`
  );
  assert.equal(second.status, 400, JSON.stringify(second.body));
  assert.equal(second.body.code, 'SKU_TAKEN');
  assert.equal(second.body.section, 'product');
  assert.equal(second.body.field, 'sku');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM products'), 1);

  const form = await post(app, '/api/admin/products-v2', {
    name_en: 'Three',
    name_ar: 'ثلاثة',
    price_iqd: 100000,
    status: 'draft',
    sku: 'DUP-1',
  });
  const formBody = await json(form);
  assert.equal(form.status, 400, JSON.stringify(formBody));
  assert.equal(formBody.code, 'SKU_TAKEN');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM products'), 1);
});

test('a hundred option values and a hundred images save through D1s 100-parameter limit', async () => {
  const { raw, app } = setup();
  const made = await json(
    await post(app, '/api/admin/products-v2', { name_en: 'Wide', name_ar: 'عريض', price_iqd: 100000, status: 'draft' })
  );
  const id = made.product.id as string;
  const values = Array.from({ length: 120 }, (_, i) => ({ id: `ov_${i}`, name_en: `V${i}`, sort: i, active: true }));
  const images = Array.from({ length: 120 }, (_, i) => ({
    id: `pi_${i}`,
    url: `/files/products/catalog/gallery/img0000${i}.webp`,
    alt_en: '',
    sort_order: i,
    is_primary: i === 0,
  }));
  const res = await put(app, `/api/admin/products/${id}/relations`, {
    inventory_mode: 'BASE',
    groups: [{ id: 'g1', name_en: 'Model', sort: 0, active: true, values }],
    colors: [],
    variants: [],
    images,
  });
  assert.equal(res.status, 200, await res.text());
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_option_values WHERE product_id = ?', id), 120);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_images WHERE product_id = ?', id), 120);

  // And a payload beyond the stated ceiling is refused by name rather than
  // discovered as a timeout.
  const tooMany = await put(app, `/api/admin/products/${id}/relations`, {
    inventory_mode: 'BASE',
    groups: [
      {
        id: 'g1',
        name_en: 'Model',
        sort: 0,
        active: true,
        values: Array.from({ length: 401 }, (_, i) => ({ id: `x_${i}`, name_en: `X${i}`, sort: i, active: true })),
      },
    ],
    colors: [],
    variants: [],
    images: [],
  });
  assert.equal(tooMany.status, 400, await tooMany.text());
});

// ================================================ live orders and deletions

/** A delivered order whose line names one option value and one colour. */
function liveOrder(raw: DatabaseSync, productId: string, valueId: string, colorId: string) {
  raw.prepare("INSERT INTO users (id, email, role) VALUES ('u1','c@x.co','customer')").run();
  raw
    .prepare(
      `INSERT INTO orders (id, user_id, status, address_snapshot, delivery_method_id, delivery_method_snapshot,
                           payment_method_id, subtotal_iqd, shipping_iqd, exchange_rate, total_iqd, due_on_delivery_iqd)
       VALUES ('ord1','u1','delivered','{}','standard','{}','cash',100000,0,1400,100000,0)`
    )
    .run();
  raw
    .prepare(
      `INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_iqd, line_total_iqd,
                                option_value_ids, color_id)
       VALUES ('oi1','ord1',?,'Live',1,100000,100000,?,?)`
    )
    .run(productId, JSON.stringify([valueId]), colorId);
}

test('an option value or colour a live order names is deactivated, never deleted', async () => {
  const { raw, app } = setup();
  const id = (
    await apply(
      app,
      `template_version=2
slug=live-rows
name_ar=حيّ
name_en=Live Rows
status=draft
price_iqd=100000
brand=bambu
options.1.id=opt_keep
options.1.group=Model
options.1.name_en=Keep
options.2.id=opt_live
options.2.group=Model
options.2.name_en=Live
colors.1.id=col_live
colors.1.name_en=Red
colors.1.hex=#ff0000
`
    )
  ).body.product_id as string;
  liveOrder(raw, id, 'opt_live', 'col_live');

  // The form's own relations save, dropping both rows outright.
  const res = await put(app, `/api/admin/products/${id}/relations`, {
    inventory_mode: 'BASE',
    groups: [
      {
        id: String((await json(await get(app, `/api/admin/products/${id}/relations`))).groups[0].id),
        name_en: 'Model',
        sort: 0,
        active: true,
        values: [{ id: 'opt_keep', name_en: 'Keep', sort: 0, active: true }],
      },
    ],
    colors: [],
    variants: [],
    images: [],
  });
  const r = { status: res.status, body: await json(res) };
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const value = row(raw, "SELECT active FROM product_option_values WHERE id = 'opt_live'");
  const colour = row(raw, "SELECT active FROM product_colors WHERE id = 'col_live'");
  assert.ok(value, 'the option value a live order names still exists');
  assert.equal(Number(value!.active), 0, 'and is deactivated instead');
  assert.ok(colour, 'the colour a live order names still exists');
  assert.equal(Number(colour!.active), 0);
  assert.ok(
    (r.body.warnings as string[]).some((w) => w.includes('opt_live') || w.includes('Live')),
    `the caller is told: ${JSON.stringify(r.body.warnings)}`
  );
});

test('a group a retained option value still belongs to is deactivated, not cascaded away', async () => {
  const { raw, app } = setup();
  const id = (
    await apply(
      app,
      `template_version=2
slug=live-group
name_ar=حيّ
name_en=Live Group
status=draft
price_iqd=100000
brand=bambu
options.1.id=opt_keep
options.1.group=Model
options.1.name_en=Keep
options.2.id=opt_live
options.2.group=Nozzle
options.2.name_en=Live
`
    )
  ).body.product_id as string;
  liveOrder(raw, id, 'opt_live', '');
  const rel = await json(await get(app, `/api/admin/products/${id}/relations`));
  const model = (rel.groups as Array<{ id: string; name_en: string }>).find((g) => g.name_en === 'Model')!;
  const nozzle = (rel.groups as Array<{ id: string; name_en: string }>).find((g) => g.name_en === 'Nozzle')!;

  // "Nozzle" is dropped from the payload, and so is its only value — but that
  // value is named by a live order. Deleting the group would cascade over the
  // row the retention just saved, so the group survives, deactivated.
  const res = await put(app, `/api/admin/products/${id}/relations`, {
    inventory_mode: 'BASE',
    groups: [
      { id: model.id, name_en: 'Model', sort: 0, active: true, values: [{ id: 'opt_keep', name_en: 'Keep', sort: 0, active: true }] },
    ],
    colors: [],
    variants: [],
    images: [],
  });
  assert.equal(res.status, 200, await res.text());
  assert.equal(Number(row(raw, "SELECT active FROM product_option_values WHERE id = 'opt_live'")!.active), 0);
  const group = row(raw, 'SELECT active FROM product_option_groups WHERE id = ?', nozzle.id);
  assert.ok(group, 'the group the retained value belongs to still exists');
  assert.equal(Number(group!.active), 0);
});

// ======================================================== confirm-once answer

test('a resubmitted batch still reports the unknown keys and the fields it applied', async () => {
  const { app } = setup();
  const id = (
    await apply(
      app,
      `template_version=2
slug=repeat
name_ar=تكرار
name_en=Repeat
status=draft
price_iqd=100000
brand=bambu
`
    )
  ).body.product_id as string;

  // No `expected_updated_at`: the stale check runs BEFORE the fingerprint is
  // claimed, so an export's stamp would answer 409 and never reach the
  // confirm-once path this test is about.
  const text = `template_version=2
product_id=${id}
name_en=Repeat Two
made_up_key=1
`;
  const first = await apply(app, text, 'update');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(first.body.unknown_keys, ['made_up_key']);

  // The same submission again — the case where the client lost the first
  // answer. Nothing extra is written, and nothing the parser said is dropped.
  const again = await apply(app, text, 'update');
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.already_applied, true);
  assert.deepEqual(again.body.unknown_keys, ['made_up_key'], 'unknown keys are never dropped silently');
  assert.ok((again.body.applied_fields as string[]).length > 0, 'and says what it applied the first time');
});

// =================================== the relations body is a full replacement

test('an omitted collection in a relations body is a full replacement with an empty list, as the contract states', async () => {
  const { raw, app } = setup();
  const id = (await apply(app, TXT_TWO_OPTIONS)).body.product_id as string;
  assert.deepEqual(mirrorOf(raw, id), { options: 2, colors: 1, images: 1 });

  // ONLY `groups` is sent. `colors`, `variants` and `images` are omitted, and
  // an omitted COLLECTION reads exactly like `[]` — the rule is stated in the
  // module header and in docs/FIELD_MAPPING.md, and every caller in this
  // repository sends all four keys on every write. Only `facet_ids`
  // distinguishes absent from empty.
  const res = await put(app, `/api/admin/products/${id}/relations`, {
    inventory_mode: 'BASE',
    groups: [
      { id: 'g1', name_en: 'Model', sort: 0, active: true, values: [{ id: 'v1', name_en: 'Only', sort: 0, active: true }] },
    ],
  });
  assert.equal(res.status, 200, await res.text());
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_option_values WHERE product_id = ?', id), 1);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_colors WHERE product_id = ?', id), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_images WHERE product_id = ?', id), 0);
  assert.deepEqual(mirrorOf(raw, id), { options: 1, colors: 0, images: 0 }, 'and the mirror says the same');
});

// ===================================== the form save carries authored ar/ckb

test('a legacy JSON-only product keeps an Arabic name equal to its English one through its first form save', async () => {
  const { raw, app } = setup();
  const made = await json(
    await post(app, '/api/admin/products-v2', { name_en: 'Legacy', name_ar: 'قديم', price_iqd: 100000, status: 'draft' })
  );
  const id = made.product.id as string;
  // A JSON-only product, exactly as migration 0022 left the ones it could not
  // convert: structure in the columns, no relation row anywhere.
  raw
    .prepare('UPDATE products SET options = ?, images = ? WHERE id = ?')
    .run(
      JSON.stringify([
        { id: 'ov_l', name_en: 'Alpha', name_ar: 'Alpha', name_ckb: 'Alpha', group_en: 'Model', order: 0, active: true, stock: 0 },
      ]),
      JSON.stringify([{ id: 'md_l', url: '/files/products/catalog/gallery/aaa00001.webp', alt_en: 'Pic', alt_ar: 'Pic', order: 0, primary: true }]),
      id
    );

  const state = await formState(app, id);
  assert.equal(state.rel.groups[0].values[0].name_ar, 'Alpha', 'the hydration carries it verbatim');
  const saved = await json(
    await post(app, '/api/admin/products-v2', {
      ...state.doc,
      status: 'draft',
      relations: relationsToWire(state.rel),
      expected_updated_at: stamp(raw, id),
    })
  );
  assert.equal(saved.success, true, JSON.stringify(saved));
  const stored = row(raw, "SELECT name_ar, name_ckb FROM product_option_values WHERE id = 'ov_l'")!;
  assert.equal(stored.name_ar, 'Alpha', 'the first save must not blank a stored Arabic name');
  assert.equal(stored.name_ckb, 'Alpha');
  assert.equal(row(raw, "SELECT alt_ar FROM product_images WHERE id = 'md_l'")!.alt_ar, 'Pic');
});
