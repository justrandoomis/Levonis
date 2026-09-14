/**
 * THE BUNDLES PANEL — docs/BUNDLES_MYSTERY.md §11 and plan slice 5.
 *
 * Every assertion here is at route level against the REAL router over the real
 * transactional SqliteD1, because the four things this slice can get wrong are
 * all invisible to a unit test:
 *
 *   1. ONE PLAN, ONE BATCH. The product row and its composition must land in
 *      `saveProductAtomic`'s single `db.batch`. A second batch touching a
 *      product table would be a second writer, and
 *      docs/TXT_IMPORT_PARITY.md §5.1 has exactly one.
 *   2. THE WARNINGS MUST REACH A HUMAN. `strList` keeps only strings and
 *      `refusalIssues` renders `${line}${key}${message}`, so the three
 *      warnings the owner quoted word for word vanish or print "[object
 *      Object]" / "undefined" unless the server's shape is right. Both
 *      decoders are imported here and run over the real bodies.
 *   3. AN INVALID CONFIGURATION IS REFUSED, NEVER REPAIRED. A discount at or
 *      above the parts, a percent outside 1..90, two price sources on one
 *      offer, a mixed-shipping composition, a nested bundle and an unpriced
 *      publish each get their own named refusal.
 *   4. THE PINS HOLD. A bundle's `stock` is NULL, its `selling_type` is
 *      'bundle' and it has no options or colours of its own — read back from
 *      the table, not from the response.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, failingD1, stubApp, post, get, json, all, row, count, type App, type Mount } from './fixtures/app';
import { adminBundlesRoutes } from '../worker/routes/adminBundles';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { refusalIssues } from '../src/components/adminProducts/applyResult';
import type { ApplyVerifyFailure } from '../src/components/adminProducts/types';

const OWNER = { id: 'usr_owner', role: 'admin' as const, email: 'boss@x.co', admin_scope: null };
const ASSISTANT = { id: 'usr_asst', role: 'admin' as const, email: 'asst@x.co', admin_scope: 'assistant' };

const mount: Mount = (a) => {
  a.route('/api/admin/bundles', adminBundlesRoutes);
  a.route('/api/admin/products-v2', adminProductsRoutes);
};

interface SeedProduct {
  id: string;
  slug: string;
  name: string;
  price: number;
  stock: number | null;
  saleTypes?: string;
  transports?: string;
  cost?: number | null;
  status?: string;
}

function seedProduct(raw: DatabaseSync, p: SeedProduct) {
  raw
    .prepare(
      `INSERT INTO products (id, slug, status, name, name_ar, price_iqd, product_cost_iqd, stock, stock_reserved,
                             inventory_mode, sale_types, selling_type, preorder_transports, images, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,0,'BASE',?,?,?,'[]',?,?)`
    )
    .run(
      p.id,
      p.slug,
      p.status ?? 'active',
      p.name,
      p.name,
      p.price,
      p.cost ?? null,
      p.stock,
      p.saleTypes ?? '["direct_sale"]',
      (p.saleTypes ?? '["direct_sale"]').includes('pre_order') && !(p.saleTypes ?? '').includes('direct_sale')
        ? 'pre_order'
        : 'direct_sale',
      p.transports ?? '[]',
      new Date().toISOString(),
      new Date().toISOString()
    );
}

/** The owner's worked example: a printer, a spool bought two at a time, and a
 *  nozzle. printer 5 · spool 6 needing 2 · nozzle 20 → max_bundles 3. */
function setup(user: typeof OWNER | typeof ASSISTANT = OWNER) {
  const raw = freshDb();
  raw
    .prepare("INSERT INTO users (id,name,email,password_hash,role,username) VALUES (?,?,?,?,?,?)")
    .run(user.id, 'Admin', user.email, 'h', 'admin', user.id);
  seedProduct(raw, { id: 'prd_printer', slug: 'printer', name: 'Printer', price: 900000, stock: 5, cost: 700000 });
  seedProduct(raw, { id: 'prd_spool', slug: 'spool', name: 'Spool', price: 20000, stock: 6, cost: 12000 });
  seedProduct(raw, { id: 'prd_nozzle', slug: 'nozzle', name: 'Nozzle', price: 5000, stock: 20, cost: 2000 });
  const db = asD1(raw);
  return { raw, db, app: stubApp(db, user, mount) };
}

const KIT = {
  name_en: 'Starter kit',
  name_ar: 'حزمة البداية',
  price_iqd: 850000,
  status: 'draft',
  components: [
    { member_product_id: 'prd_printer', qty: 1, sort: 0 },
    { member_product_id: 'prd_spool', qty: 2, sort: 1 },
    { member_product_id: 'prd_nozzle', qty: 1, sort: 2 },
  ],
  config: { price_mode: 'fixed', max_qty_per_order: 5, min_price_iqd: 1 },
};

const put = (a: App, path: string, body: unknown) =>
  a.request(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const patch = (a: App, path: string, body: unknown) =>
  a.request(path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const del = (a: App, path: string) => a.request(path, { method: 'DELETE' });

const create = async (app: App, body: Record<string, unknown> = {}) => {
  const res = await post(app, '/api/admin/bundles', { ...KIT, ...body });
  return { status: res.status, body: await json(res) };
};

// ===================================================================== create

test('a bundle is a products row: stock NULL, selling_type bundle, no options of its own', async () => {
  const { raw, app } = setup();
  const made = await create(app);
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const id = made.body.product.id as string;

  const p = row<Record<string, unknown>>(raw, 'SELECT * FROM products WHERE id = ?', id)!;
  assert.equal(p.composition, 'bundle');
  assert.equal(p.stock, null, 'THE invariant: a bundle is never stocked');
  assert.equal(p.stock_reserved, 0);
  assert.equal(p.selling_type, 'bundle');
  assert.equal(p.sale_types, '["bundle"]');
  assert.equal(p.inventory_mode, 'BASE');
  assert.equal(p.options, '[]');
  assert.equal(p.colors, '[]');
  assert.equal(p.status, 'draft');
  assert.equal(String(p.slug), 'starter-kit');

  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM bundle_components WHERE bundle_product_id = ?', id), 3);
  const cfg = row<Record<string, unknown>>(raw, 'SELECT * FROM bundle_config WHERE product_id = ?', id)!;
  assert.equal(cfg.price_mode, 'fixed');
  assert.equal(cfg.max_qty_per_order, 5);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'bundle.create'"), 1);
});

test("the preview is the scarcest component, computed by the storefront's own function", async () => {
  const { app } = setup();
  const made = await create(app);
  const preview = made.body.preview as Record<string, unknown>;
  // printer 5/1 = 5 · spool floor(6/2) = 3 · nozzle 20/1 = 20 → min = 3
  assert.equal((preview.availability as Record<string, unknown>).max_bundles, 3);
  assert.equal(preview.component_total_iqd, 900000 + 2 * 20000 + 5000);
  assert.equal(preview.bundle_price_iqd, 850000);
  assert.equal(preview.discount_iqd, 945000 - 850000);
  assert.equal(preview.saving_percent, Math.round(((945000 - 850000) * 100) / 945000));
});

test('THE composition rides the product save: ONE batch, and no second one touches a product table', async () => {
  const raw = freshDb();
  raw.prepare("INSERT INTO users (id,name,email,password_hash,role,username) VALUES (?,?,?,?,?,?)")
    .run(OWNER.id, 'Admin', OWNER.email, 'h', 'admin', OWNER.id);
  seedProduct(raw, { id: 'prd_printer', slug: 'printer', name: 'Printer', price: 900000, stock: 5 });
  seedProduct(raw, { id: 'prd_spool', slug: 'spool', name: 'Spool', price: 20000, stock: 6 });
  seedProduct(raw, { id: 'prd_nozzle', slug: 'nozzle', name: 'Nozzle', price: 5000, stock: 20 });
  const { failing, db } = failingD1(raw);
  const app = stubApp(db, OWNER, mount);

  const res = await post(app, '/api/admin/bundles', KIT);
  assert.equal(res.status, 200, await res.text());

  const productWrites = failing.batches.filter((b) =>
    b.some((s) => /INSERT INTO products|UPDATE products|INSERT INTO bundle_components|INSERT INTO bundle_config/i.test(s))
  );
  assert.equal(
    productWrites.length,
    1,
    `the product row and its composition must land in ONE batch; saw ${productWrites.length}:\n${JSON.stringify(failing.batches, null, 2)}`
  );
  const one = productWrites[0];
  assert.ok(one.some((s) => /INSERT INTO products/i.test(s)), 'the product row is in that batch');
  assert.ok(one.some((s) => /INSERT INTO bundle_components/i.test(s)), 'the components are in the SAME batch');
  assert.ok(one.some((s) => /INSERT INTO bundle_config/i.test(s)), 'the config is in the same batch');
});

test('a window price and a tier gate are audited INSIDE the save batch, never after it', async () => {
  const { raw, app } = setup();
  const made = await create(app, {
    offer: { required_tiers: ['plus'], active: true, ends_at: '2099-01-01T00:00:00Z' },
  });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const id = made.body.product.id as string;
  const w = row<Record<string, unknown>>(raw, "SELECT * FROM offer_windows WHERE subject_id = ?", id)!;
  assert.equal(w.required_tiers, '["plus"]');
  assert.equal(w.ends_at, '2099-01-01T00:00:00.000Z');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'offer.update' AND target = ?", id), 1);
});

// ================================================================== refusals

const refusal = async (app: App, body: Record<string, unknown>) => {
  const res = await post(app, '/api/admin/bundles', { ...KIT, ...body });
  const b = await json(res);
  return { status: res.status, body: b, codes: ((b.details?.errors ?? []) as Array<{ code: string }>).map((e) => e.code) };
};

test('a discount at or above the component total is REFUSED — a free bundle is never published', async () => {
  const { raw, app } = setup();
  const out = await refusal(app, { config: { price_mode: 'discount_iqd', discount_iqd: 2_000_000, max_qty_per_order: 5 } });
  assert.equal(out.status, 400);
  assert.equal(out.body.code, 'BUNDLE_VALIDATION');
  assert.ok(out.codes.includes('BUNDLE_DISCOUNT_EXCEEDS_TOTAL'), JSON.stringify(out.body));
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM products WHERE composition <> ''"), 0, 'nothing was written');
});

test('discount_percent = 200 is refused, and so is setting both discount kinds at once', async () => {
  const { app } = setup();
  const pct = await refusal(app, { config: { price_mode: 'discount_percent', discount_percent: 200, max_qty_per_order: 5 } });
  assert.equal(pct.status, 400);
  assert.match(JSON.stringify(pct.body), /between 1 and 90/);

  const both = await refusal(app, {
    config: { price_mode: 'discount_percent', discount_percent: 10, discount_iqd: 5000, max_qty_per_order: 5 },
  });
  assert.equal(both.status, 400);
  assert.match(JSON.stringify(both.body), /never both/);
});

test('a window price beside a derived bundle price is refused with OFFER_PRICE_CONFLICT', async () => {
  const { app } = setup();
  const out = await refusal(app, {
    config: { price_mode: 'discount_percent', discount_percent: 10, max_qty_per_order: 5 },
    offer: { offer_price_mode: 'fixed', offer_price_iqd: 700000, active: true },
  });
  assert.equal(out.status, 400);
  assert.ok(out.codes.includes('OFFER_PRICE_CONFLICT'), JSON.stringify(out.body));
});

test('a direct + pre-order composition is refused with BUNDLE_SHIPPING_MIXED naming both components', async () => {
  const { raw, app } = setup();
  seedProduct(raw, {
    id: 'prd_air',
    slug: 'air-part',
    name: 'Air part',
    price: 60000,
    stock: null,
    saleTypes: '["pre_order"]',
    transports: '[{"method":"air","commission_iqd":5000,"active":true}]',
  });
  const out = await refusal(app, {
    components: [
      { member_product_id: 'prd_printer', qty: 1 },
      { member_product_id: 'prd_air', qty: 1 },
    ],
  });
  assert.equal(out.status, 400);
  assert.ok(out.codes.includes('BUNDLE_SHIPPING_MIXED'), JSON.stringify(out.body));
  const line = (out.body.details.errors as Array<{ message: string }>).find((e) => /shipping types/.test(e.message))!;
  assert.match(line.message, /Printer/);
  assert.match(line.message, /Air part/);
});

test('two pre-order components that share no transport method are refused, never forced onto one', async () => {
  const { raw, app } = setup();
  seedProduct(raw, {
    id: 'prd_air',
    slug: 'air-part',
    name: 'Air part',
    price: 60000,
    stock: null,
    saleTypes: '["pre_order"]',
    transports: '[{"method":"air","commission_iqd":5000,"active":true}]',
  });
  seedProduct(raw, {
    id: 'prd_sea',
    slug: 'sea-part',
    name: 'Sea part',
    price: 40000,
    stock: null,
    saleTypes: '["pre_order"]',
    transports: '[{"method":"sea","commission_iqd":2000,"active":true}]',
  });
  const out = await refusal(app, {
    components: [
      { member_product_id: 'prd_air', qty: 1 },
      { member_product_id: 'prd_sea', qty: 1 },
    ],
  });
  assert.equal(out.status, 400);
  assert.ok(out.codes.includes('BUNDLE_SHIPPING_MIXED'), JSON.stringify(out.body));
});

test('a bundle cannot contain a bundle', async () => {
  const { app } = setup();
  const first = await create(app);
  const nested = await refusal(app, {
    name_en: 'Nested kit',
    components: [{ member_product_id: first.body.product.id, qty: 1 }],
  });
  assert.equal(nested.status, 400);
  assert.ok(nested.codes.includes('BUNDLE_NESTING_NOT_ALLOWED'), JSON.stringify(nested.body));
});

test('a pinned option value that does not exist on the member product is refused, never dropped', async () => {
  const { app } = setup();
  const out = await refusal(app, {
    components: [{ member_product_id: 'prd_printer', qty: 1, option_value_ids: ['opt_nope'] }],
  });
  assert.equal(out.status, 400);
  assert.ok(out.codes.includes('COMPONENT_SELECTION_INVALID'), JSON.stringify(out.body));
  assert.match(JSON.stringify(out.body), /opt_nope/);
});

test('an empty composition is refused', async () => {
  const { app } = setup();
  const out = await refusal(app, { components: [] });
  assert.equal(out.status, 400);
  assert.ok(out.codes.includes('BUNDLE_NO_COMPONENTS'));
});

test('a composition that would exceed MAX_PHYSICAL_LINES in one order is refused at save', async () => {
  const { raw, app } = setup();
  for (let i = 0; i < 6; i += 1) {
    seedProduct(raw, { id: `prd_x${i}`, slug: `x${i}`, name: `X${i}`, price: 1000, stock: 100 });
  }
  const out = await refusal(app, {
    components: Array.from({ length: 6 }, (_, i) => ({ member_product_id: `prd_x${i}`, qty: 1 })),
    config: { price_mode: 'fixed', max_qty_per_order: 99 },
  });
  assert.equal(out.status, 400);
  assert.ok(out.codes.includes('COMPOSITION_TOO_LARGE'), JSON.stringify(out.body));
});

test('an inverted member ladder is refused — the product ladder by validateProductDoc, the PLUS rung by the planner', async () => {
  const { app } = setup();
  // The three product rungs are already the document's own rule, and reusing
  // it is the point: a bundle IS a product, so there is no second ladder.
  const product = await refusal(app, { price_iqd: 500000, pro_price_iqd: 600000 });
  assert.equal(product.status, 400);
  assert.match(product.body.error as string, /PRO <= PRIME <= Regular/);

  // The PLUS rung is offer-scoped, so nothing else in the tree knows it.
  const plus = await refusal(app, {
    price_iqd: 500000,
    pro_price_iqd: 400000,
    config: { price_mode: 'fixed', max_qty_per_order: 5, plus_price_iqd: 300000 },
  });
  assert.equal(plus.status, 400);
  assert.ok(plus.codes.includes('MEMBER_LADDER_INVERTED'), JSON.stringify(plus.body));
});

test('an inverted schedule is refused', async () => {
  const { app } = setup();
  const out = await refusal(app, {
    offer: { starts_at: '2099-02-01T00:00:00Z', ends_at: '2099-01-01T00:00:00Z', active: true },
  });
  assert.equal(out.status, 400);
  assert.ok(out.codes.includes('SCHEDULE_INVERTED'), JSON.stringify(out.body));
});

// =================================================================== warnings

test('every refusal reaches a human: refusalIssues renders it, and never prints "undefined"', async () => {
  const { app } = setup();
  const out = await refusal(app, { config: { price_mode: 'discount_iqd', discount_iqd: 2_000_000, max_qty_per_order: 5 } });
  const lines = refusalIssues(out.body.details as ApplyVerifyFailure);
  assert.ok(lines.length > 0, 'the refusal carried no row-level line at all');
  assert.equal(
    lines.some((l) => l.includes('undefined')),
    false,
    `an entry without a \`message\` prints the literal string "undefined": ${JSON.stringify(lines)}`
  );
  for (const e of out.body.details.errors as Array<Record<string, string>>) {
    for (const lang of ['ar', 'en', 'ckb']) {
      assert.equal(typeof e[lang], 'string', `${e.code} has no ${lang}`);
      assert.ok(e[lang].length > 0, `${e.code}'s ${lang} is empty`);
    }
  }
});

test('the success-path warnings survive strList — a list of objects would vanish entirely', async () => {
  const { app } = setup();
  // The spool has 6 units and the bundle needs 8 of them.
  const made = await create(app, {
    components: [{ member_product_id: 'prd_spool', qty: 8 }],
    price_iqd: 100000,
  });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const warnings = made.body.warnings as unknown[];
  assert.ok(Array.isArray(warnings));
  assert.deepEqual(
    warnings.filter((w) => typeof w === 'string'),
    warnings,
    'strList (applyResult.ts) keeps only strings — an object-shaped warnings list becomes empty'
  );
  assert.equal(
    warnings.join(' · ').includes('[object Object]'),
    false,
    "ProductForm joins warnings with ' · '"
  );
  const detail = (made.body.warning_details as Array<Record<string, string>>).find((w) => w.code === 'COMPONENT_SHORT')!;
  assert.ok(detail, JSON.stringify(made.body.warning_details));
  assert.match(detail.en, /needs 8 units of Spool but only 6 is available/);
  for (const lang of ['ar', 'en', 'ckb']) assert.ok(detail[lang].length > 0, `COMPONENT_SHORT has no ${lang}`);
});

test('a bundle priced above its parts warns, and an inactive member warns — neither is repaired', async () => {
  const { raw, app } = setup();
  raw.prepare("UPDATE products SET status='draft' WHERE id='prd_nozzle'").run();
  const made = await create(app, { price_iqd: 2_000_000 });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const codes = (made.body.warning_details as Array<{ code: string }>).map((w) => w.code);
  assert.ok(codes.includes('PRICE_ABOVE_COMPONENTS'), JSON.stringify(codes));
  assert.ok(codes.includes('COMPONENT_PRODUCT_INACTIVE'), JSON.stringify(codes));
  assert.equal(made.body.product.price_iqd, 2_000_000, 'the price the admin typed is NOT rewritten');
});

test('a derived price that drifts from the stored key warns about the KEY, not about the charge', async () => {
  const { app } = setup();
  const made = await create(app, {
    price_iqd: 100000,
    config: { price_mode: 'discount_percent', discount_percent: 10, max_qty_per_order: 5 },
  });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const drift = (made.body.warning_details as Array<Record<string, string>>).find((w) => w.code === 'DERIVED_PRICE_DRIFT')!;
  assert.ok(drift, JSON.stringify(made.body.warning_details));
  assert.match(drift.en, /sort and search key only/);
  // The preview quotes the DERIVED figure, which is what the door will charge.
  assert.equal(made.body.preview.bundle_price_iqd, Math.floor((945000 * 90) / 100));
});

// ================================================== migrated legacy drafts

test('a migrated legacy bundle shows MIGRATED_NEEDS_PRICE, and publishing it is refused', async () => {
  const { raw, app } = setup();
  raw
    .prepare(
      `INSERT INTO products (id, slug, status, name, name_ar, price_iqd, stock, inventory_mode, composition, selling_type, sale_types, images)
       VALUES ('prd_bnd_old','bundle-old','draft','Old kit','حزمة قديمة',0,NULL,'BASE','bundle','bundle','["bundle"]','[]')`
    )
    .run();
  raw.prepare("INSERT INTO bundle_config (product_id, price_mode, max_qty_per_order) VALUES ('prd_bnd_old','fixed',5)").run();
  raw
    .prepare(
      "INSERT INTO bundle_components (id, bundle_product_id, member_product_id, qty, sort) VALUES ('bc_old','prd_bnd_old','prd_spool',1,0)"
    )
    .run();

  const listed = await json(await get(app, '/api/admin/bundles'));
  const card = (listed.bundles as Array<Record<string, unknown>>).find((b) => b.id === 'prd_bnd_old')!;
  assert.ok((card.warnings as string[]).some((w) => /display list with no price/.test(w)), JSON.stringify(card.warnings));
  assert.equal(card.component_count, 1);

  const published = await patch(app, '/api/admin/bundles/prd_bnd_old/status', { action: 'enable' });
  const body = await json(published);
  assert.equal(published.status, 400, JSON.stringify(body));
  assert.equal(body.code, 'BUNDLE_VALIDATION');
  assert.ok((body.details.errors as Array<{ code: string }>).some((e) => e.code === 'MIGRATED_NEEDS_PRICE'));
  assert.equal(row<Record<string, unknown>>(raw, "SELECT status FROM products WHERE id='prd_bnd_old'")!.status, 'draft');
});

// ================================================================ lifecycle

test('publish, duplicate, reorder and archive', async () => {
  const { raw, app } = setup();
  const made = await create(app);
  const id = made.body.product.id as string;

  const enabled = await patch(app, `/api/admin/bundles/${id}/status`, { action: 'enable' });
  assert.equal(enabled.status, 200, await enabled.text());
  assert.equal(row<Record<string, unknown>>(raw, 'SELECT status FROM products WHERE id = ?', id)!.status, 'active');

  const copyRes = await post(app, `/api/admin/bundles/${id}/duplicate`, {});
  const copy = await json(copyRes);
  assert.equal(copyRes.status, 200, JSON.stringify(copy));
  const copyId = copy.product.id as string;
  assert.notEqual(copyId, id);
  assert.equal(copy.product.status, 'draft', 'a copy is always a draft');
  assert.notEqual(copy.product.slug, made.body.product.slug);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM bundle_components WHERE bundle_product_id = ?', copyId), 3);
  const sourceIds = all<{ id: string }>(raw, 'SELECT id FROM bundle_components WHERE bundle_product_id = ?', id).map((r) => r.id);
  const copyIds = all<{ id: string }>(raw, 'SELECT id FROM bundle_components WHERE bundle_product_id = ?', copyId).map((r) => r.id);
  assert.equal(
    copyIds.some((x) => sourceIds.includes(x)),
    false,
    'a copy gets its OWN component rows, so a cart line pointing at the original is never re-pointed'
  );

  const reordered = await put(app, '/api/admin/bundles/reorder', { order: [copyId, id] });
  assert.equal(reordered.status, 200, await reordered.text());
  assert.equal(row<Record<string, unknown>>(raw, 'SELECT display_order FROM products WHERE id = ?', copyId)!.display_order, 0);
  assert.equal(row<Record<string, unknown>>(raw, 'SELECT display_order FROM products WHERE id = ?', id)!.display_order, 1);

  const archived = await del(app, `/api/admin/bundles/${copyId}`);
  assert.equal(archived.status, 200, await archived.text());
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM products WHERE id = ?', copyId), 0, 'an unsold bundle is deleted');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM bundle_components WHERE bundle_product_id = ?', copyId), 0);
});

test('an edit keeps its component ids, its slug and its stale-edit guard', async () => {
  const { raw, app } = setup();
  const made = await create(app);
  const id = made.body.product.id as string;
  const opened = await json(await get(app, `/api/admin/bundles/${id}`));
  assert.equal(opened.success, true, JSON.stringify(opened));
  assert.equal((opened.components as unknown[]).length, 3);

  const stale = await put(app, `/api/admin/bundles/${id}`, {
    ...KIT,
    components: opened.components,
    expected_updated_at: '1999-01-01T00:00:00.000Z',
  });
  assert.equal(stale.status, 409);
  assert.equal((await json(stale)).code, 'STALE_EDIT');

  const saved = await put(app, `/api/admin/bundles/${id}`, {
    ...KIT,
    name_en: 'Starter kit renamed',
    components: (opened.components as Array<Record<string, unknown>>).slice(0, 2),
    expected_updated_at: opened.updated_at,
  });
  assert.equal(saved.status, 200, await saved.text());
  const ids = all<{ id: string }>(raw, 'SELECT id FROM bundle_components WHERE bundle_product_id = ? ORDER BY sort', id);
  assert.equal(ids.length, 2);
  assert.deepEqual(
    ids.map((r) => r.id),
    (opened.components as Array<{ id: string }>).slice(0, 2).map((c) => c.id),
    'the surrogate ids survive an edit — a cart line still resolves its choices'
  );
  assert.equal(row<Record<string, unknown>>(raw, 'SELECT slug FROM products WHERE id = ?', id)!.slug, 'starter-kit');
});

// =========================================================== the other panel

test('the product editor refuses a composition row and names the panel that owns it', async () => {
  const { app } = setup();
  const made = await create(app);
  const id = made.body.product.id as string;
  const res = await get(app, `/api/admin/products-v2/${id}`);
  const body = await json(res);
  assert.equal(res.status, 409, JSON.stringify(body));
  assert.equal(body.code, 'COMPOSITION_PRODUCT');
  assert.equal(body.details.panel, 'bundles');

  const listed = await json(await get(app, '/api/admin/products-v2'));
  const badge = (listed.products as Array<Record<string, unknown>>).find((p) => p.id === id)!;
  assert.equal(badge.composition, 'bundle', 'the grid badges it instead of opening an editor that will refuse');
});

test('permanent member deletion removes its relationships and hides affected bundles', async () => {
  const { app, raw } = setup();
  const bundleId = (await create(app)).body.product.id as string;
  assert.equal((await del(app, '/api/admin/products-v2/prd_spool')).status, 400, 'permanence is explicit');
  const res = await del(app, '/api/admin/products-v2/prd_spool?permanent=true');
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.product_deleted, true);
  assert.equal(row(raw, "SELECT COUNT(*) n FROM products WHERE id='prd_spool'")!.n, 0);
  assert.equal(row(raw, "SELECT COUNT(*) n FROM bundle_components WHERE member_product_id='prd_spool'")!.n, 0);
  assert.equal(row(raw, 'SELECT status FROM products WHERE id=?', bundleId)!.status, 'hidden');
});

// ================================================================ §11.4 scope

test('component cost never reaches an assistant admin — not in the preview, not in the listing', async () => {
  const { raw } = setup();
  raw.prepare("INSERT INTO users (id,name,email,password_hash,role,username) VALUES (?,?,?,?,?,?)")
    .run(ASSISTANT.id, 'Asst', ASSISTANT.email, 'h', 'admin', ASSISTANT.id);
  const db = asD1(raw);
  const owner = stubApp(db, OWNER, mount);
  const made = await create(owner);
  const id = made.body.product.id as string;
  assert.match(JSON.stringify(made.body.preview), /cost_iqd/, 'the owner DOES see component cost');

  const assistant = stubApp(db, ASSISTANT, mount);
  for (const path of [`/api/admin/bundles/${id}/preview`, `/api/admin/bundles/${id}`, '/api/admin/bundles']) {
    const body = JSON.stringify(await json(await get(assistant, path)));
    assert.equal(/cost_iqd|product_cost_iqd|margin/.test(body), false, `${path} leaked a financial field to an assistant`);
    assert.equal(body.includes('700000'), false, `${path} leaked the printer's cost figure to an assistant`);
  }
});


// ==================================================================== wiring

test('the panel keeps its chunk name, the Worker mounts the new router, and the old panel is gone', () => {
  // `tests/bundleBudget.test.ts` pins the chunk name `AdminBundles`, and vite
  // derives it from the FILE name — so the folder may move but the file may
  // not be renamed.
  assert.ok(
    existsSync('src/components/adminBundles/AdminBundles.tsx'),
    'the rebuilt panel must keep the file name AdminBundles.tsx, which is the chunk name'
  );
  assert.equal(
    existsSync('src/components/AdminBundles.tsx'),
    false,
    'the legacy panel wrote the legacy `bundles` table, which is read-only history after 0059'
  );
  const admin = readFileSync('src/pages/Admin.tsx', 'utf8');
  assert.match(admin, /React\.lazy\(\(\) => import\('\.\.\/components\/adminBundles\/AdminBundles'\)\)/);
  assert.match(admin, /activeTab === 'bundles'/, 'the tab id stays `bundles`');

  const index = readFileSync('worker/index.ts', 'utf8');
  assert.match(index, /import \{ adminBundlesRoutes \} from '\.\/routes\/adminBundles'/);
  assert.match(index, /app\.route\('\/api\/admin\/bundles', adminBundlesRoutes\)/);

  // The panel's own guard, not the host middleware's: `requireMainHost` is a
  // HOST check and never a role check (§10).
  const router = readFileSync('worker/routes/adminBundles.ts', 'utf8');
  assert.match(router, /adminBundlesRoutes\.use\('\*', requireAdmin\)/);
});
