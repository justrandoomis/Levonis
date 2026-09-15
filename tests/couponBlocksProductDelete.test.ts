/**
 * A COUPON THAT NAMES A PRODUCT MUST NOT SURVIVE THAT PRODUCT'S DELETION.
 *
 * 0077 lets a coupon target a product, one of its MODELS ("A1 Combo"), one of
 * its COLOURS, or a bundle. Permanently deleting the product takes its
 * `product_option_values` and `product_colors` rows with it — so the coupon
 * would be left holding a target that no longer resolves, and a resolver
 * facing an unresolvable target has only two options, both wrong:
 *
 *   refuse the coupon the owner is still advertising, or
 *   match nothing, and quietly widen a 950,000 IQD discount to the whole shop.
 *
 * So the DELETE is refused instead, with a remedy the admin can carry out.
 * tests/productDeletionRegistry.test.ts proves the table is registered; this
 * file proves the guard actually bites, on all four arms, and — just as
 * importantly — that it lets go when the coupon is switched off.
 *
 * Run: npx tsx --test tests/couponBlocksProductDelete.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, SqliteD1 } from './fixtures/d1';
import { blockingReferences } from '../worker/lib/productDeletion';

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) raw.exec(readFileSync(join(dir, f), 'utf8'));
  raw.exec(`
    INSERT INTO products (id,slug,name,name_ar,price_iqd,images) VALUES
      ('p_a1','a1','Bambu A1','بامبو A1',950000,'[]'),
      ('p_other','other','Something Else','شيء آخر',10000,'[]');
    INSERT INTO product_option_groups (id,product_id,name_en,sort)
      VALUES ('g1','p_a1','Model',0);
    INSERT INTO product_option_values (id,group_id,product_id,name_en,sort)
      VALUES ('ov_combo','g1','p_a1','Combo',0);
    INSERT INTO product_colors (id,product_id,name_en,hex,sort)
      VALUES ('col_black','p_a1','Black','#000000',0);
  `);
  return { raw, db: new SqliteD1(raw) as unknown as D1Database };
}

let n = 0;
function coupon(raw: DatabaseSync, fields: Record<string, string | number | null>) {
  const cols = ['id', 'code', 'kind', 'value', 'active', ...Object.keys(fields)];
  const vals = [`c${++n}`, `CODE${n}`, 'fixed_iqd', 950_000, 1, ...Object.values(fields)];
  raw
    .prepare(`INSERT INTO coupons (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...(vals as Array<string | number | null>));
}

// ---------------------------------------------------------------- the arms

const ARMS: Array<[string, Record<string, string | number | null>]> = [
  ['scoped to the product itself', { scope: 'product', product_id: 'p_a1' }],
  ['scoped to a MODEL of it', { scope: 'product', product_id: 'p_a1', option_value_id: 'ov_combo' }],
  ['naming only the model, with a wider scope', { scope: 'global', option_value_id: 'ov_combo' }],
  ['naming only a COLOUR of it', { scope: 'global', color_id: 'col_black' }],
  ['built on it as a bundle', { scope: 'bundle', bundle_product_id: 'p_a1' }],
];

for (const [why, fields] of ARMS) {
  test(`an active coupon ${why} refuses the delete`, async () => {
    const { raw, db } = setup();
    coupon(raw, fields);
    const blocked = await blockingReferences(db, 'p_a1');
    assert.ok(blocked, `the delete must be refused: ${why}`);
    assert.equal(blocked.code, 'PRODUCT_IN_COUPON');
    assert.equal(blocked.table, 'coupons');
    assert.equal(blocked.count, 1);
    // The remedy has to be something the admin can actually do.
    assert.match(blocked.remedy, /deactivate|retarget/i);
  });
}

test('a DEACTIVATED coupon does not pin the product in the catalogue for ever', async () => {
  // A campaign that ended must not make a product undeletable. `active = 0`
  // is one click away, which is what makes the refusal above a guard rather
  // than a dead end.
  const { raw, db } = setup();
  coupon(raw, { scope: 'product', product_id: 'p_a1' });
  raw.exec("UPDATE coupons SET active = 0");
  assert.equal(await blockingReferences(db, 'p_a1'), null);
});

test('a coupon naming a DIFFERENT product does not block this one', async () => {
  const { raw, db } = setup();
  coupon(raw, { scope: 'product', product_id: 'p_other' });
  assert.equal(await blockingReferences(db, 'p_a1'), null);
});

test('an unscoped coupon blocks nothing — it names no product at all', async () => {
  const { raw, db } = setup();
  coupon(raw, { scope: 'global' });
  assert.equal(await blockingReferences(db, 'p_a1'), null);
  assert.equal(await blockingReferences(db, 'p_other'), null);
});

test('the pre-0077 blocking refs still work and are not shadowed', async () => {
  // Adding an arm to BLOCKING_REFS must not disturb the ones already there.
  const { raw, db } = setup();
  raw.exec(`
    INSERT INTO products (id,slug,name,name_ar,price_iqd,images)
      VALUES ('p_kit','kit','Starter Kit','حزمة',900000,'[]');
    INSERT INTO bundle_components (id,bundle_product_id,member_product_id,qty,sort)
      VALUES ('bc1','p_kit','p_a1',1,0);
  `);
  const blocked = await blockingReferences(db, 'p_a1');
  assert.ok(blocked);
  assert.equal(blocked.code, 'PRODUCT_IN_BUNDLE', 'the bundle guard still fires first');
});
