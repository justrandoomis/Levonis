/**
 * «التخصيص» — THE THREE TABLES OF PROGRAMME C, PHASE C1 (migrations/
 * 0164_customization_core.sql; docs/LEVO_PROJECT_PROGRAMME.md §B.7 row
 * customization_core, §0 rows 4–6 and 21).
 *
 * Pinned against the real migration chain, straight SQL — the database says
 * no whatever the code above it forgets:
 *   · product_blueprints: one row per revision, UNIQUE (product_id, rev); at
 *     most ONE live and ONE draft revision per product (partial unique
 *     indexes); a live or retired revision's CONTENT never changes
 *     (trg_blueprint_locked) while its state, referenced_at, from_iqd and
 *     timestamps may; the identity never changes; the state moves only
 *     draft → live → retired → live;
 *   · no blueprint on a private (0152) product, nor on a row whose store or
 *     merchant is not the product's; a product with a blueprint never turns
 *     private (our trigger alone, 0152's lock dropped to prove it);
 *   · blueprint_part_refs follow their revision and their part (CASCADE);
 *   · design_configs are immutable, one per (owner, hash), and every twin
 *     code is unique.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, row, all, count } from './fixtures/app';
import { seedCatalog } from './fixtures/catalog';

const TS = '2026-09-30T10:00:00.000Z';

function world(): DatabaseSync {
  const raw = freshDb();
  seedCatalog(raw);
  raw.exec(`
    INSERT INTO community_products (id, merchant_id, store_id, slug, name, price_iqd, publish_state) VALUES
      ('cp_a', 'm_ali', 's_ali', 'stand', 'Stand', 20000, 'published'),
      ('cp_part', 'm_ali', 's_ali', 'magnet', 'Magnet', 1000, 'hidden'),
      ('cp_z', 'm_zain', 's_zain', 'z-thing', 'Zain thing', 5000, 'published');
    INSERT INTO community_products (id, merchant_id, store_id, slug, name, price_iqd, publish_state, audience_user_id) VALUES
      ('cp_private', 'm_ali', 's_ali', 'a-quote', 'A quote', 9000, 'published', 'buyer');
  `);
  return raw;
}

/** One revision row, straight into the table (the code's own writes are tests/blueprintRoutes.test.ts). */
function rev(raw: DatabaseSync, productId: string, n: number, state: 'draft' | 'live' | 'retired', over: Record<string, unknown> = {}) {
  const r = {
    id: `bp_${productId}_${n}`,
    product_id: productId,
    store_id: productId === 'cp_z' ? 's_zain' : 's_ali',
    merchant_id: productId === 'cp_z' ? 'm_zain' : 'm_ali',
    rev: n,
    state,
    spec: '{"v":1,"regions":[]}',
    created_at: TS,
    updated_at: TS,
    ...over,
  };
  const cols = Object.keys(r);
  raw.prepare(`INSERT INTO product_blueprints (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...(Object.values(r) as never[]));
  return r.id;
}

const refuses = (fn: () => unknown, message: RegExp, label?: string) => assert.throws(fn, message, label);

// ------------------------------------------------------------------ shape

test('0164 creates the three tables, their unique indexes and every trigger', () => {
  const raw = world();
  const names = (type: string) => all<{ name: string }>(raw, 'SELECT name FROM sqlite_master WHERE type = ? ORDER BY name', type).map((r) => r.name);
  for (const t of ['product_blueprints', 'blueprint_part_refs', 'design_configs']) assert.ok(names('table').includes(t), t);
  for (const i of ['ux_blueprint_live', 'ux_blueprint_draft', 'idx_product_blueprints_store', 'idx_product_blueprints_live', 'idx_blueprint_part_refs_part', 'idx_design_configs_product']) {
    assert.ok(names('index').includes(i), i);
  }
  for (const t of ['trg_blueprint_identity', 'trg_blueprint_locked', 'trg_blueprint_state', 'trg_blueprint_not_private', 'trg_blueprint_product_stays_public', 'trg_config_immutable']) {
    assert.ok(names('trigger').includes(t), t);
  }
  const cols = all<{ name: string }>(raw, 'PRAGMA table_info(product_blueprints)').map((c) => c.name);
  for (const c of ['spec', 'private_json', 'source_keys', 'parts', 'analysis', 'mesh_state', 'draft_mesh_key', 'mesh_key', 'mesh_hash', 'mesh_bytes', 'triangles', 'look', 'photo_keys', 'family', 'tags', 'from_iqd', 'referenced_at', 'published_at', 'retired_at']) {
    assert.ok(cols.includes(c), `product_blueprints.${c}`);
  }
});

test('JSON columns hold JSON and the enumerations hold their words', () => {
  const raw = world();
  refuses(() => rev(raw, 'cp_a', 1, 'draft', { spec: 'not json' }), /CHECK constraint failed/);
  refuses(() => rev(raw, 'cp_a', 1, 'draft', { private_json: '{' }), /CHECK constraint failed/);
  refuses(() => rev(raw, 'cp_a', 1, 'draft', { mesh_state: 'baking' }), /CHECK constraint failed/);
  refuses(() => rev(raw, 'cp_a', 1, 'published' as 'live'), /CHECK constraint failed/);
  refuses(() => rev(raw, 'cp_a', 0, 'draft'), /CHECK constraint failed/);
  refuses(() => rev(raw, 'cp_a', 1, 'draft', { triangles: -1 }), /CHECK constraint failed/);
  rev(raw, 'cp_a', 1, 'draft', { mesh_state: 'photo', photo_keys: '{"pm_1":"merchants/ali/public/aaaa1111.webp"}' });
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_blueprints'), 1);
});

// ------------------------------------------------------------- revisions

test('UNIQUE (product_id, rev): a revision number is used once per product', () => {
  const raw = world();
  rev(raw, 'cp_a', 1, 'retired');
  refuses(() => rev(raw, 'cp_a', 1, 'draft', { id: 'bp_other' }), /UNIQUE constraint failed: product_blueprints\.product_id, product_blueprints\.rev/);
  // Another product numbers its own revisions.
  rev(raw, 'cp_z', 1, 'draft');
});

test('two live revisions are impossible — by insert and by flipping a draft — and so are two drafts; retired ones pile up', () => {
  const raw = world();
  rev(raw, 'cp_a', 1, 'retired');
  rev(raw, 'cp_a', 2, 'retired');
  rev(raw, 'cp_a', 3, 'live');
  refuses(() => rev(raw, 'cp_a', 4, 'live'), /UNIQUE constraint failed: product_blueprints\.product_id/);
  rev(raw, 'cp_a', 4, 'draft');
  refuses(() => rev(raw, 'cp_a', 5, 'draft'), /UNIQUE constraint failed: product_blueprints\.product_id/);
  refuses(() => raw.exec("UPDATE product_blueprints SET state = 'live' WHERE id = 'bp_cp_a_4'"), /UNIQUE constraint failed/);
  // The publish order — retire the old one, then flip — is the one that works.
  raw.exec("UPDATE product_blueprints SET state = 'retired' WHERE id = 'bp_cp_a_3'");
  raw.exec("UPDATE product_blueprints SET state = 'live' WHERE id = 'bp_cp_a_4'");
  assert.deepEqual(
    all(raw, "SELECT rev, state FROM product_blueprints WHERE product_id = 'cp_a' ORDER BY rev"),
    [{ rev: 1, state: 'retired' }, { rev: 2, state: 'retired' }, { rev: 3, state: 'retired' }, { rev: 4, state: 'live' }]
  );
});

test('the lock: a live or retired revision refuses every content edit, and allows its state, referenced_at, from_iqd and timestamps', () => {
  const raw = world();
  rev(raw, 'cp_a', 1, 'retired', { published_at: TS });
  rev(raw, 'cp_a', 2, 'live', { published_at: TS, mesh_key: 'merchants/ali/public/bp/bp_cp_a_2-r2-0123456789ab.lvm.gz', mesh_state: 'ready' });
  const content: Array<[string, string]> = [
    ['spec', `'{"v":1,"regions":[],"x":1}'`],
    ['private_json', `'{"notes":"changed"}'`],
    ['source_keys', `'["merchants/ali/product-files/x.stl"]'`],
    ['parts', `'[{"n":0}]'`],
    ['analysis', `'{"format":"stl"}'`],
    ['mesh_state', `'failed'`],
    ['draft_mesh_key', `'merchants/ali/blueprints/cp_a-0123456789ab.lvm.gz'`],
    ['mesh_key', `'merchants/ali/public/bp/other-r9-0123456789ab.lvm.gz'`],
    ['mesh_hash', `'ffff'`],
    ['mesh_bytes', '1'],
    ['triangles', '12'],
    ['look', `'{"poster_key":"x"}'`],
    ['photo_keys', `'{"a":"b"}'`],
    ['family', `'lamp'`],
    ['tags', `'["biz"]'`],
    ['created_at', `'2020-01-01T00:00:00.000Z'`],
  ];
  for (const id of ['bp_cp_a_1', 'bp_cp_a_2']) {
    for (const [col, v] of content) {
      refuses(() => raw.exec(`UPDATE product_blueprints SET ${col} = ${v} WHERE id = '${id}'`), /BLUEPRINT_LOCKED/, `${id}.${col}`);
    }
  }
  // What stays writable.
  raw.exec(`UPDATE product_blueprints SET referenced_at = '${TS}', from_iqd = 21000, updated_at = '${TS}' WHERE id = 'bp_cp_a_2'`);
  raw.exec(`UPDATE product_blueprints SET state = 'retired', retired_at = '${TS}' WHERE id = 'bp_cp_a_2'`);
  raw.exec(`UPDATE product_blueprints SET state = 'live', published_at = '${TS}', retired_at = NULL WHERE id = 'bp_cp_a_1'`);
  assert.deepEqual(row(raw, "SELECT state, referenced_at, from_iqd FROM product_blueprints WHERE id = 'bp_cp_a_2'"), { state: 'retired', referenced_at: TS, from_iqd: 21000 });
  // A draft is the one revision whose content is written.
  rev(raw, 'cp_a', 3, 'draft');
  for (const [col, v] of content) raw.exec(`UPDATE product_blueprints SET ${col} = ${v} WHERE id = 'bp_cp_a_3'`);
  assert.equal(row<{ family: string }>(raw, "SELECT family FROM product_blueprints WHERE id = 'bp_cp_a_3'")!.family, 'lamp');
});

test('the identity never changes, in any state', () => {
  const raw = world();
  rev(raw, 'cp_a', 1, 'draft');
  for (const [col, v] of [['id', "'bp_new'"], ['product_id', "'cp_part'"], ['store_id', "'s_zain'"], ['merchant_id', "'m_zain'"], ['rev', '7']]) {
    refuses(() => raw.exec(`UPDATE product_blueprints SET ${col} = ${v} WHERE id = 'bp_cp_a_1'`), /BLUEPRINT_LOCKED/, col);
  }
});

test('the state moves only draft → live → retired → live', () => {
  const raw = world();
  rev(raw, 'cp_a', 1, 'draft');
  refuses(() => raw.exec("UPDATE product_blueprints SET state = 'retired' WHERE id = 'bp_cp_a_1'"), /BLUEPRINT_LOCKED/, 'draft → retired');
  raw.exec("UPDATE product_blueprints SET state = 'live' WHERE id = 'bp_cp_a_1'");
  refuses(() => raw.exec("UPDATE product_blueprints SET state = 'draft' WHERE id = 'bp_cp_a_1'"), /BLUEPRINT_LOCKED/, 'live → draft');
  raw.exec("UPDATE product_blueprints SET state = 'retired' WHERE id = 'bp_cp_a_1'");
  refuses(() => raw.exec("UPDATE product_blueprints SET state = 'draft' WHERE id = 'bp_cp_a_1'"), /BLUEPRINT_LOCKED/, 'retired → draft');
  raw.exec("UPDATE product_blueprints SET state = 'live' WHERE id = 'bp_cp_a_1'");
  assert.equal(row<{ state: string }>(raw, "SELECT state FROM product_blueprints WHERE id = 'bp_cp_a_1'")!.state, 'live');
});

// ------------------------------------------------------------ the product

test('no blueprint on a private product, nor under another store or merchant than the product\'s', () => {
  const raw = world();
  refuses(() => rev(raw, 'cp_private', 1, 'draft'), /BLUEPRINT_PRODUCT_INELIGIBLE/);
  refuses(() => rev(raw, 'cp_a', 1, 'draft', { store_id: 's_zain' }), /BLUEPRINT_PRODUCT_INELIGIBLE/);
  refuses(() => rev(raw, 'cp_a', 1, 'draft', { merchant_id: 'm_zain' }), /BLUEPRINT_PRODUCT_INELIGIBLE/);
  refuses(() => rev(raw, 'cp_missing', 1, 'draft'), /BLUEPRINT_PRODUCT_INELIGIBLE|FOREIGN KEY/);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_blueprints'), 0);
});

test('a product with a blueprint never turns private — 0164 refuses it even without 0152\'s own lock', () => {
  const raw = world();
  rev(raw, 'cp_a', 1, 'draft');
  refuses(() => raw.exec("UPDATE community_products SET audience_user_id = 'buyer' WHERE id = 'cp_a'"), /CUSTOM_PRODUCT_LOCKED|BLUEPRINT_PRODUCT_INELIGIBLE/);
  raw.exec('DROP TRIGGER trg_private_product_locked');
  refuses(() => raw.exec("UPDATE community_products SET audience_user_id = 'buyer' WHERE id = 'cp_a'"), /BLUEPRINT_PRODUCT_INELIGIBLE/);
  assert.equal(row<{ audience_user_id: string | null }>(raw, "SELECT audience_user_id FROM community_products WHERE id = 'cp_a'")!.audience_user_id, null);
  // A product WITHOUT a blueprint is 0152's business alone.
  raw.exec("UPDATE community_products SET audience_user_id = 'buyer' WHERE id = 'cp_z'");
});

test('deleting a product deletes its revisions, their part refs and its configurations', () => {
  const raw = world();
  rev(raw, 'cp_a', 1, 'live');
  raw.exec(`
    INSERT INTO blueprint_part_refs (product_id, rev, slot_key, option_key, part_product_id, qty) VALUES ('cp_a', 1, 'magnet', 'm10', 'cp_part', 2);
    INSERT INTO design_configs (id, owner_id, product_id, rev, hash, spec, twin_code, created_at)
      VALUES ('cfg_1', 'buyer', 'cp_a', 1, '${'a'.repeat(64)}', '{"v":1}', 'ABCDEFGHJK12', '${TS}');
  `);
  raw.exec("DELETE FROM community_products WHERE id = 'cp_a'");
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_blueprints'), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM blueprint_part_refs'), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM design_configs'), 0);
});

// -------------------------------------------------------------- part refs

test('part refs name a real revision and a real part, and go with either', () => {
  const raw = world();
  refuses(
    () => raw.exec("INSERT INTO blueprint_part_refs (product_id, rev, slot_key, option_key, part_product_id) VALUES ('cp_a', 9, 'magnet', 'm10', 'cp_part')"),
    /FOREIGN KEY constraint failed/
  );
  rev(raw, 'cp_a', 1, 'retired');
  rev(raw, 'cp_a', 2, 'draft');
  raw.exec(`
    INSERT INTO blueprint_part_refs (product_id, rev, slot_key, option_key, part_product_id, part_variant_id, qty) VALUES
      ('cp_a', 1, 'magnet', 'm10', 'cp_part', '', 2),
      ('cp_a', 2, 'magnet', 'm10', 'cp_part', '', 2),
      ('cp_a', 2, '~fixed', '0', 'cp_part', '', 1);
  `);
  refuses(
    () => raw.exec("INSERT INTO blueprint_part_refs (product_id, rev, slot_key, option_key, part_product_id, qty) VALUES ('cp_a', 2, 'x', 'y', 'cp_part', 21)"),
    /CHECK constraint failed/
  );
  raw.exec("DELETE FROM product_blueprints WHERE id = 'bp_cp_a_2'");
  assert.deepEqual(all(raw, 'SELECT product_id, rev, slot_key FROM blueprint_part_refs'), [{ product_id: 'cp_a', rev: 1, slot_key: 'magnet' }]);
  raw.exec("DELETE FROM community_products WHERE id = 'cp_part'");
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM blueprint_part_refs'), 0, 'a deleted part leaves no ref behind');
});

// ----------------------------------------------------------- configurations

const config = (raw: DatabaseSync, id: string, owner: string, hash: string, twin: string, over: Record<string, unknown> = {}) => {
  const r = { id, owner_id: owner, product_id: 'cp_a', rev: 1, hash, spec: '{"v":1,"p":"cp_a"}', twin_code: twin, created_at: TS, ...over };
  const cols = Object.keys(r);
  raw.prepare(`INSERT INTO design_configs (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...(Object.values(r) as never[]));
};

test('design_configs are immutable — every column, even `public`', () => {
  const raw = world();
  config(raw, 'cfg_1', 'buyer', 'a'.repeat(64), 'ABCDEFGHJK12');
  for (const [col, v] of [['spec', `'{"v":1,"p":"cp_a","notes":"x"}'`], ['public', '1'], ['hash', `'${'b'.repeat(64)}'`], ['twin_code', "'ZZZZZZZZZZZZ'"], ['rev', '2'], ['owner_id', "'ali'"]]) {
    refuses(() => raw.exec(`UPDATE design_configs SET ${col} = ${v} WHERE id = 'cfg_1'`), /CONFIG_IMMUTABLE/, col);
  }
  assert.deepEqual(row(raw, "SELECT spec, public, twin_code FROM design_configs WHERE id = 'cfg_1'"), { spec: '{"v":1,"p":"cp_a"}', public: 0, twin_code: 'ABCDEFGHJK12' });
  // A change of mind is a NEW configuration beside it.
  config(raw, 'cfg_2', 'buyer', 'b'.repeat(64), 'ABCDEFGHJK13', { spec: '{"v":1,"p":"cp_a","notes":"x"}' });
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM design_configs WHERE owner_id = 'buyer'"), 2);
});

test('UNIQUE (owner, hash): equal choices are one row per owner; twin codes are unique; the hash and twin code have their lengths', () => {
  const raw = world();
  const h = 'c'.repeat(64);
  config(raw, 'cfg_1', 'buyer', h, 'ABCDEFGHJK12');
  refuses(() => config(raw, 'cfg_2', 'buyer', h, 'ABCDEFGHJK13'), /UNIQUE constraint failed: design_configs\.owner_id, design_configs\.hash/);
  config(raw, 'cfg_3', 'zain', h, 'ABCDEFGHJK14');
  refuses(() => config(raw, 'cfg_4', 'ali', 'd'.repeat(64), 'ABCDEFGHJK12'), /UNIQUE constraint failed: design_configs\.twin_code/);
  refuses(() => config(raw, 'cfg_5', 'ali', 'short', 'ABCDEFGHJK15'), /CHECK constraint failed/);
  refuses(() => config(raw, 'cfg_6', 'ali', 'e'.repeat(64), 'SHORT'), /CHECK constraint failed/);
  refuses(() => config(raw, 'cfg_7', 'ali', 'f'.repeat(64), 'ABCDEFGHJK16', { spec: '{nope' }), /CHECK constraint failed/);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM design_configs'), 2);
});
