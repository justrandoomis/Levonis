/**
 * THE MYSTERY PANEL — docs/BUNDLES_MYSTERY.md §10, §11.1 and §11.3, at route
 * level against the REAL router over the real transactional SqliteD1.
 *
 * Five things this slice can get wrong are invisible to a unit test:
 *
 *   1. SELLING FROM A POOL MUST NOT LOCK IT. `mystery_allocations.pool_entry_id`
 *      is a foreign key, so an entry that has ever been drawn cannot be deleted
 *      — and a panel that deleted on save would leave the admin unable to edit
 *      that pool ever again, with a runtime error `foreign_key_check` cannot
 *      catch. Entries that leave the set are DEACTIVATED, and the admin is told.
 *   2. TWO ADMINS EDITING ONE POOL. The whole-set replace demands
 *      `expected_updated_at` and answers 409 `STALE_EDIT` echoing `current`.
 *   3. ODDS CHANGES MUST BE AUDITED INSIDE THEIR OWN BATCH. A crash between the
 *      write and the audit would leave an unaudited change to the table that
 *      decides who gets the expensive filament.
 *   4. THE SECRET MUST NEVER APPEAR IN A RESPONSE — asserted by walking every
 *      body this file produces against the value actually stored.
 *   5. THE WARNINGS MUST REACH A HUMAN. `strList` keeps only strings and
 *      `refusalIssues` renders `${line}${key}${message}`, so the panel prints
 *      "undefined" or "[object Object]" unless the server's shape is right.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, failingD1, stubApp, post, get, json, all, row, count, type App, type Mount } from './fixtures/app';
import { adminMysteryRoutes } from '../worker/routes/mystery';
import { refusalIssues } from '../src/components/adminProducts/applyResult';
import type { ApplyVerifyFailure } from '../src/components/adminProducts/types';
import { MYSTERY_REFUSALS } from '../worker/lib/mystery/issues';
import { fixtureWebp, productMediaFixtureEnv } from './fixtures/productMedia';

const OWNER = { id: 'usr_owner', role: 'admin' as const, email: 'boss@x.co', admin_scope: null };
const mount: Mount = (a) => a.route('/api/admin/mystery', adminMysteryRoutes);

const put = (a: App, path: string, b: unknown) =>
  a.request(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
const del = (a: App, path: string) => a.request(path, { method: 'DELETE' });

function setup(env: Record<string, unknown> = {}) {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,username) VALUES ('usr_owner','Admin','boss@x.co','h','admin','boss');
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,inventory_mode,options,colors,selling_type,sale_types,preorder_transports,images)
    VALUES ('p_base','base','Base Spool','أساس',25000,'active',9,'BASE','[]','[]','direct_sale','["direct_sale"]','[]','[]'),
           ('p_color','color','Colour Spool','ألوان',25000,'active',NULL,'COLOR','[]','[]','direct_sale','["direct_sale"]','[]','[]'),
           ('p_option','option','Option Spool','خيارات',25000,'active',NULL,'OPTION','[]','[]','direct_sale','["direct_sale"]','[]','[]');
    INSERT INTO product_colors (id,product_id,name_en,hex,stock,reserved,active)
    VALUES ('clr_red','p_color','Red','#ff0000',3,0,1),
           ('clr_blue','p_color','Blue','#0000ff',4,0,1),
           ('clr_dead','p_color','Retired','#333333',4,0,0);
    INSERT INTO product_option_groups (id,product_id,name_en,sort,active) VALUES ('grp_size','p_option','Size',0,1);
    INSERT INTO product_option_values (id,product_id,group_id,name_en,stock,reserved,active)
    VALUES ('ov_1kg','p_option','grp_size','1kg',5,0,1),
           ('ov_2kg','p_option','grp_size','2kg',2,0,1),
           ('ov_off','p_option','grp_size','Discontinued',9,0,0);
  `);
  const db = asD1(raw);
  return { raw, db, app: stubApp(db, OWNER, mount, { env }) };
}

const makePool = async (app: App, over: Record<string, unknown> = {}) => {
  const res = await json(await post(app, '/api/admin/mystery/pools', { name: 'Filament', kind: 'direct', ...over }));
  assert.equal(res.success, true, JSON.stringify(res));
  return res.pool.id as string;
};

const entries = (raw: DatabaseSync, poolId: string) =>
  all<{ id: string; product_id: string; color_id: string; weight: number; active: number }>(
    raw,
    'SELECT id, product_id, color_id, weight, active FROM mystery_pool_entries WHERE pool_id = ? ORDER BY id',
    poolId
  );

// ------------------------------------------------------------ pools CRUD

test('a pool is created, read back and audited inside its own batch', async () => {
  const { raw, app } = setup();
  const id = await makePool(app, { require_catalog_ids: ['cat_x'], min_available: 2 });
  assert.deepEqual(row(raw, 'SELECT name, kind, min_available FROM mystery_pools WHERE id = ?', id), {
    name: 'Filament',
    kind: 'direct',
    min_available: 2,
  });
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'mystery.pool.update' AND target = ?", id), 1);

  const listed = await json(await get(app, '/api/admin/mystery/pools'));
  assert.equal(listed.pools.length, 1);
  assert.deepEqual(listed.pools[0].require_catalog_ids, ['cat_x']);
});

test('an odds-changing write that fails leaves NO audit row — the audit rides the same batch', async () => {
  const { raw } = setup();
  const { failing, db } = failingD1(raw);
  const app = stubApp(db, OWNER, mount);
  failing.failWhen = (stmts) => stmts.some((s) => /INSERT INTO mystery_pools/.test(s.sql));
  const res = await post(app, '/api/admin/mystery/pools', { name: 'Filament', kind: 'direct' });
  assert.equal(res.status, 500);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM mystery_pools'), 0);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'mystery.pool.update'"), 0);
});

// ------------------------------------------------------- the bulk generator

test('the generator expands options and colours ON THE SERVER, one entry per real stock row', async () => {
  const { raw, app } = setup();
  const id = await makePool(app);
  const res = await json(
    await post(app, `/api/admin/mystery/pools/${id}/entries/generate`, {
      product_ids: ['p_base', 'p_color', 'p_option'],
      weight: 2,
    })
  );
  assert.equal(res.success, true, JSON.stringify(res));

  const rows = entries(raw, id);
  // BASE → one entry; COLOR → one per ACTIVE colour; OPTION → one per ACTIVE value.
  assert.equal(rows.filter((r) => r.product_id === 'p_base').length, 1);
  assert.deepEqual(
    rows.filter((r) => r.product_id === 'p_color').map((r) => r.color_id).sort(),
    ['clr_blue', 'clr_red'],
    'the retired colour is not invented into the pool'
  );
  assert.equal(rows.filter((r) => r.product_id === 'p_option').length, 2, 'the discontinued option value is skipped');
  assert.ok(rows.every((r) => r.weight === 2 && r.active === 1));

  // Running it again MERGES rather than duplicating.
  await post(app, `/api/admin/mystery/pools/${id}/entries/generate`, { product_ids: ['p_color'], weight: 5 });
  const after = entries(raw, id);
  assert.equal(after.length, rows.length, 'no duplicate rows for the same stock row');
  assert.ok(after.filter((r) => r.product_id === 'p_color').every((r) => r.weight === 5), 'the weight was updated in place');
});

test('the eligible preview computes probabilities and the distinct-choice count server-side', async () => {
  const { app } = setup();
  const id = await makePool(app);
  await post(app, `/api/admin/mystery/pools/${id}/entries/generate`, { product_ids: ['p_color'], weight: 1 });
  await post(app, `/api/admin/mystery/pools/${id}/entries/generate`, { product_ids: ['p_base'], weight: 2 });

  const res = await json(await get(app, `/api/admin/mystery/pools/${id}/eligible?spools=3&duplicate_policy=forbid`));
  assert.equal(res.success, true);
  assert.equal(res.distinct_choices, 3, 'red, blue and the base spool');
  assert.equal(res.total_available, 3 + 4 + 9);
  const byName = new Map(res.eligible.map((e: { name: string; probability: number }) => [e.name, e.probability]));
  // weights 1 + 1 + 2 = 4
  assert.equal(byName.get('Base Spool'), 0.5);
  assert.equal(byName.get('Colour Spool'), 0.25);
  assert.equal(
    res.eligible.reduce((s: number, e: { probability: number }) => s + e.probability, 0),
    1
  );
});

test('POOL_TOO_SMALL_FOR_FORBID names the count for the ADMIN — and no customer refusal ever does', async () => {
  const { app } = setup();
  const id = await makePool(app);
  await post(app, `/api/admin/mystery/pools/${id}/entries/generate`, { product_ids: ['p_base'], weight: 1 });

  const res = await json(await get(app, `/api/admin/mystery/pools/${id}/eligible?spools=4&duplicate_policy=forbid`));
  const warning = res.warning_details.find((w: { code: string }) => w.code === 'POOL_TOO_SMALL_FOR_FORBID');
  assert.ok(warning, 'the admin is told, in the save-time warning and the preview');
  assert.match(warning.en, /only 1 distinct choices exist for 4 spools/);
  assert.ok(warning.ar && warning.ckb, 'verbatim in all three languages');
  // `strList` keeps only strings, so the success-path list must be sentences.
  assert.ok(res.warnings.every((w: unknown) => typeof w === 'string'));

  // THE CUSTOMER-FACING REFUSALS CARRY NO NUMBER AT ALL (§7.5, §15.1): a count
  // would let a buyer binary-search their own qty and read back the exact
  // number of eligible, in-stock, distinct entries, for free, on demand.
  for (const [code, text] of Object.entries(MYSTERY_REFUSALS)) {
    for (const lang of ['ar', 'en', 'ckb'] as const) {
      assert.doesNotMatch(text[lang], /\d/, `${code}.${lang} leaks a number to the customer`);
    }
  }
});

// ------------------------------------------- selling from a pool, then editing it

test('a pool that has been drawn from can still be edited: entries are deactivated, never deleted', async () => {
  const { raw, app } = setup();
  const id = await makePool(app);
  await post(app, `/api/admin/mystery/pools/${id}/entries/generate`, { product_ids: ['p_color'], weight: 1 });
  const before = entries(raw, id);
  const sold = before.find((r) => r.color_id === 'clr_red')!;

  // Somebody buys it: an allocation now names that entry for ever.
  raw.exec(`
    INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                        subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd)
      VALUES ('ORD-1','usr_owner','pending','{}','standard','{}','cash',60000,1500,60000,60000);
    INSERT INTO products (id,slug,name,price_iqd,status,stock,composition,selling_type,sale_types,inventory_mode,options,colors,preorder_transports,images)
      VALUES ('p_offer','mystery-box','Mystery Spool',60000,'active',NULL,'mystery','bundle','["bundle"]','BASE','[]','[]','[]','[]');
    INSERT INTO order_items (id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd)
      VALUES ('oi_1','ORD-1',NULL,'Mystery Spool',1,0,0);
  `);
  raw
    .prepare(
      `INSERT INTO mystery_allocations (order_item_id,spool_index,order_id,offer_product_id,pool_id,pool_entry_id,product_id,
                                        name_snapshot,sale_mode,seed,reveal_stage_snapshot,candidates_sha256)
       VALUES ('oi_1',0,'ORD-1','p_offer',?,?, 'p_color','Colour Spool','direct','seed','delivered','sha')`
    )
    .run(id, sold.id);

  // The admin now removes that entry from the set entirely.
  const current = row<{ updated_at: string }>(raw, 'SELECT updated_at FROM mystery_pools WHERE id = ?', id)!.updated_at;
  const res = await json(
    await put(app, `/api/admin/mystery/pools/${id}/entries`, {
      expected_updated_at: current,
      entries: before.filter((r) => r.id !== sold.id).map((r) => ({ id: r.id, product_id: r.product_id, color_id: r.color_id, weight: 1 })),
    })
  );
  assert.equal(res.success, true, JSON.stringify(res));
  assert.equal(res.deactivated, 1);
  assert.match(
    res.warning_details.find((w: { code: string }) => w.code === 'POOL_ENTRY_DEACTIVATED').en,
    /deactivated rather than deleted/
  );

  // The row is STILL THERE — excluded, kept for history — and the foreign key
  // from the allocation still resolves.
  const after = entries(raw, id).find((r) => r.id === sold.id)!;
  assert.deepEqual({ active: after.active, weight: after.weight }, { active: 0, weight: 0 });
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM mystery_allocations WHERE pool_entry_id = ?', sold.id), 1);
  const violations = all(raw, 'PRAGMA foreign_key_check');
  assert.deepEqual(violations, [], 'editing a pool that has been drawn from breaks no foreign key');
});

test('a concurrent whole-set replace is refused with 409 STALE_EDIT and changes nothing', async () => {
  const { raw, app } = setup();
  const id = await makePool(app);
  await post(app, `/api/admin/mystery/pools/${id}/entries/generate`, { product_ids: ['p_color'], weight: 1 });
  const stale = row<{ updated_at: string }>(raw, 'SELECT updated_at FROM mystery_pools WHERE id = ?', id)!.updated_at;

  // Another admin saves first.
  await new Promise((r) => setTimeout(r, 5));
  const first = await put(app, `/api/admin/mystery/pools/${id}/entries`, {
    expected_updated_at: stale,
    entries: [{ product_id: 'p_color', color_id: 'clr_red', weight: 9 }],
  });
  assert.equal(first.status, 200);

  const res = await put(app, `/api/admin/mystery/pools/${id}/entries`, {
    expected_updated_at: stale,
    entries: [{ product_id: 'p_base', weight: 1 }],
  });
  assert.equal(res.status, 409);
  const b = await json(res);
  assert.equal(b.code, 'STALE_EDIT');
  assert.ok(b.current, 'the response echoes the current value so the panel can reload');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM mystery_pool_entries WHERE pool_id = ? AND product_id = ?', id, 'p_base'), 0);

  // And the requirement is not optional: a save without it is refused outright.
  const missing = await put(app, `/api/admin/mystery/pools/${id}/entries`, { entries: [] });
  assert.equal(missing.status, 400);
});

test('a whole-set replace refuses a product that is itself a composition row', async () => {
  const { raw, app } = setup();
  raw.exec(`
    INSERT INTO products (id,slug,name,price_iqd,status,stock,composition,selling_type,sale_types,inventory_mode,options,colors,preorder_transports,images)
      VALUES ('p_bundle','bnd','A Bundle',90000,'active',NULL,'bundle','bundle','["bundle"]','BASE','[]','[]','[]','[]');
  `);
  const id = await makePool(app);
  const current = row<{ updated_at: string }>(raw, 'SELECT updated_at FROM mystery_pools WHERE id = ?', id)!.updated_at;
  const res = await put(app, `/api/admin/mystery/pools/${id}/entries`, {
    expected_updated_at: current,
    entries: [{ product_id: 'p_bundle', weight: 1 }],
  });
  assert.equal(res.status, 400);
  const b = await json(res);
  assert.equal(b.code, 'BUNDLE_VALIDATION');
  // The refusal renders through the panel's own decoder with no "undefined".
  const rendered = refusalIssues(b.details as ApplyVerifyFailure);
  assert.ok(rendered.length > 0);
  assert.ok(rendered.every((line) => !line.includes('undefined')), rendered.join(' | '));
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM mystery_pool_entries'), 0);
});

test('a pool an offer or a past draw names is deactivated, never deleted', async () => {
  const { raw, app } = setup();
  const id = await makePool(app);
  raw.exec(`
    INSERT INTO products (id,slug,name,price_iqd,status,stock,composition,selling_type,sale_types,inventory_mode,options,colors,preorder_transports,images)
      VALUES ('p_offer','mystery-box','Mystery Spool',60000,'active',NULL,'mystery','bundle','["bundle"]','BASE','[]','[]','[]','[]');
  `);
  raw.prepare('INSERT INTO mystery_offers (product_id, direct_pool_id) VALUES (?, ?)').run('p_offer', id);

  const res = await json(await del(app, `/api/admin/mystery/pools/${id}`));
  assert.equal(res.deleted, false);
  assert.equal(res.deactivated, true);
  assert.equal(row<{ active: number }>(raw, 'SELECT active FROM mystery_pools WHERE id = ?', id)!.active, 0);
  assert.match(res.warning_details[0].en, /used by 1 offers/);

  // An unused pool really is deleted.
  const spare = await makePool(app, { name: 'Spare' });
  assert.equal((await json(await del(app, `/api/admin/mystery/pools/${spare}`))).deleted, true);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM mystery_pools'), 1);
});

// ------------------------------------------------------------- the offers

const OFFER_BODY = {
  name_en: 'Mystery Filament',
  name_ar: 'فتيل عشوائي',
  price_iqd: 30_000,
  status: 'draft',
  spool_qty: 2,
  duplicate_policy: 'forbid',
  reveal_stage: 'delivered',
  show_odds: true,
  max_qty_per_order: 3,
};

test('mystery create/update normalize stored media metadata, and duplicate refuses a vanished object', async () => {
  const media = productMediaFixtureEnv({ supplyDeclaredWebp: false });
  const key = 'products/mystery/gallery/offer-gate.webp';
  const url = `/files/${key}`;
  await media.publicBucket.put(key, fixtureWebp());
  const claimed = [{
    id: 'img_mystery_gate', url, key, primary: true, order: 0,
    width: 7, height: 8, bytes: 123_456, content_type: 'image/jpeg',
  }];
  const { raw, app } = setup(media.env);

  const createdRes = await post(app, '/api/admin/mystery/offers', { ...OFFER_BODY, direct_pool_id: null, media: claimed });
  const created = await json(createdRes);
  assert.equal(createdRes.status, 200, JSON.stringify(created));
  const id = created.product.id as string;
  const stored = JSON.parse(row<{ images: string }>(raw, 'SELECT images FROM products WHERE id = ?', id)!.images)[0];
  assert.deepEqual(
    { url: stored.url, key: stored.key, content_type: stored.content_type, bytes: stored.bytes, width: stored.width, height: stored.height },
    { url, key, content_type: 'image/webp', bytes: 30, width: 640, height: 480 }
  );

  const updatedRes = await put(app, `/api/admin/mystery/offers/${id}`, {
    ...OFFER_BODY,
    name_en: 'Updated mystery filament',
    direct_pool_id: null,
    media: claimed,
  });
  assert.equal(updatedRes.status, 200, await updatedRes.text());

  await media.publicBucket.delete(key);
  const duplicateRes = await post(app, `/api/admin/mystery/offers/${id}/duplicate`, {});
  const duplicate = await json(duplicateRes);
  assert.equal(duplicateRes.status, 400, JSON.stringify(duplicate));
  assert.equal(duplicate.code, 'IMAGE_REFERENCE_MISSING');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM products WHERE composition = 'mystery'"), 1);
});

test('mystery create rejects a missing local WebP before any catalogue row is written', async () => {
  const media = productMediaFixtureEnv({ supplyDeclaredWebp: false });
  const key = 'products/mystery/gallery/missing.webp';
  const { raw, app } = setup(media.env);
  const res = await post(app, '/api/admin/mystery/offers', {
    ...OFFER_BODY,
    direct_pool_id: null,
    media: [{ id: 'img_missing', url: `/files/${key}`, key, primary: true }],
  });
  const body = await json(res);
  assert.equal(res.status, 400, JSON.stringify(body));
  assert.equal(body.code, 'IMAGE_REFERENCE_MISSING');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM products WHERE composition = 'mystery'"), 0);
});

test('a mystery offer is a pinned products row, and its secret is created but never returned', async () => {
  const { raw, app } = setup();
  const poolId = await makePool(app);
  await post(app, `/api/admin/mystery/pools/${poolId}/entries/generate`, { product_ids: ['p_color'], weight: 1 });

  const created = await json(await post(app, '/api/admin/mystery/offers', { ...OFFER_BODY, direct_pool_id: poolId }));
  assert.equal(created.success, true, JSON.stringify(created));
  const id = created.product.id as string;

  // §1.2's pins, read back from the TABLE and not from the response.
  assert.deepEqual(
    row(raw, 'SELECT composition, stock, stock_reserved, selling_type, sale_types, inventory_mode FROM products WHERE id = ?', id),
    {
      composition: 'mystery',
      stock: null,
      stock_reserved: 0,
      selling_type: 'bundle',
      sale_types: '["bundle"]',
      inventory_mode: 'BASE',
    }
  );
  assert.deepEqual(row(raw, 'SELECT spool_qty, direct_pool_id, allow_direct, allow_preorder FROM mystery_offers WHERE product_id = ?', id), {
    spool_qty: 2,
    direct_pool_id: poolId,
    allow_direct: 1,
    allow_preorder: 0,
  });
  assert.deepEqual(row(raw, 'SELECT duplicate_policy, reveal_stage, show_odds, max_qty_per_order FROM bundle_config WHERE product_id = ?', id), {
    duplicate_policy: 'forbid',
    reveal_stage: 'delivered',
    show_odds: 1,
    max_qty_per_order: 3,
  });

  // THE SECRET: created, 64 hex, and in NO response body.
  const secret = row<{ secret: string }>(raw, 'SELECT secret FROM mystery_offer_secrets WHERE product_id = ?', id)!.secret;
  assert.match(secret, /^[0-9a-f]{64}$/);
  const bodies = [
    JSON.stringify(created),
    JSON.stringify(await json(await get(app, `/api/admin/mystery/offers/${id}`))),
    JSON.stringify(await json(await get(app, '/api/admin/mystery/offers'))),
    JSON.stringify(await json(await get(app, `/api/admin/mystery/pools/${poolId}`))),
    JSON.stringify(await json(await get(app, `/api/admin/mystery/pools/${poolId}/eligible`))),
  ];
  for (const b of bodies) {
    assert.ok(!b.includes(secret), 'an offer secret reached an admin payload');
    assert.ok(!/"secret"/.test(b), 'no response even carries a secret key');
  }
});

test('duplicating an offer generates a NEW secret', async () => {
  const { raw, app } = setup();
  const poolId = await makePool(app);
  const created = await json(await post(app, '/api/admin/mystery/offers', { ...OFFER_BODY, direct_pool_id: poolId }));
  const id = created.product.id as string;
  const original = row<{ secret: string }>(raw, 'SELECT secret FROM mystery_offer_secrets WHERE product_id = ?', id)!.secret;

  const copy = await json(await post(app, `/api/admin/mystery/offers/${id}/duplicate`, {}));
  assert.equal(copy.success, true, JSON.stringify(copy));
  const copyId = copy.product.id as string;
  assert.notEqual(copyId, id);
  const copied = row<{ secret: string }>(raw, 'SELECT secret FROM mystery_offer_secrets WHERE product_id = ?', copyId)!.secret;
  assert.notEqual(copied, original, 'a copy that inherited the secret would inherit every future draw');
  assert.equal(row<{ status: string }>(raw, 'SELECT status FROM products WHERE id = ?', copyId)!.status, 'draft');
  assert.equal(row<{ spool_qty: number }>(raw, 'SELECT spool_qty FROM mystery_offers WHERE product_id = ?', copyId)!.spool_qty, 2);

  // A deliberate rotation changes it again, and still returns nothing.
  const rotated = await json(await post(app, `/api/admin/mystery/offers/${id}/rotate-secret`, {}));
  assert.deepEqual(rotated, { success: true, rotated: true });
  assert.notEqual(row<{ secret: string }>(raw, 'SELECT secret FROM mystery_offer_secrets WHERE product_id = ?', id)!.secret, original);
});

test('an impossible offer configuration is refused, never repaired', async () => {
  const { raw, app } = setup();
  const direct = await makePool(app);
  const pre = await makePool(app, { name: 'Pre-order pool', kind: 'preorder' });

  const refusal = async (b: Record<string, unknown>) => {
    const res = await post(app, '/api/admin/mystery/offers', { ...OFFER_BODY, ...b });
    const body = await json(res);
    return { status: res.status, codes: (body.details?.errors ?? []).map((e: { code: string }) => e.code), body };
  };

  // Neither mode enabled.
  assert.deepEqual((await refusal({ allow_direct: false, allow_preorder: false })).codes, ['MYSTERY_NO_MODE_ENABLED']);
  // A pre-order pool wired into the direct slot: the two are never mixed.
  assert.deepEqual((await refusal({ direct_pool_id: pre })).codes, ['MYSTERY_POOL_KIND_MISMATCH']);
  // The physical-line ceiling, refused AT SAVE so the customer never meets it.
  const tooLarge = await refusal({ direct_pool_id: direct, spool_qty: 20, max_qty_per_order: 99 });
  assert.deepEqual(tooLarge.codes, ['MYSTERY_SPOOLS_TOO_LARGE']);
  assert.match(tooLarge.body.details.errors[0].en, /1980 physical lines/);
  assert.ok(tooLarge.body.details.errors[0].ar && tooLarge.body.details.errors[0].ckb);
  // Publishing with no pool at all is refused; saving a DRAFT warns instead.
  assert.deepEqual((await refusal({ direct_pool_id: null, status: 'active' })).codes, ['MYSTERY_POOL_MISSING']);
  const draft = await json(await post(app, '/api/admin/mystery/offers', { ...OFFER_BODY, direct_pool_id: null }));
  assert.equal(draft.success, true);
  assert.ok(draft.warnings.some((w: string) => /no pool to draw from/.test(w)));

  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM products WHERE composition = 'mystery'"), 1, 'only the draft was written');
});

test('a non-admin session never reaches the mystery panel', async () => {
  const { db } = setup();
  const app = stubApp(db, { id: 'cust', role: 'customer', email: 's@x.co' }, mount);
  for (const res of [
    await get(app, '/api/admin/mystery/pools'),
    await post(app, '/api/admin/mystery/pools', { name: 'x' }),
  ]) {
    assert.equal(res.status, 403);
  }
});
