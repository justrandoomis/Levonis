/**
 * One cart, one seller (§14, §15).
 *
 * The scope is DERIVED from the lines rather than stored as a flag, and these
 * tests are mostly about why: a flag drifts. Remove the last merchant line
 * from a cart and a stored flag still says "merchant", so the next Levonis
 * add is refused for a cart that is actually empty. A derivation cannot get
 * that wrong, and the empty-cart case is asserted directly.
 *
 * The database half is asserted too, against a real engine: the CHECK on
 * cart_items refuses a line that names a merchant product with no merchant,
 * or both kinds of product at once. That matters because it means the rule
 * survives a future endpoint that forgets to call any of this.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import {
  cartSellerScope,
  sellerConflict,
  sameSeller,
  merchantScope,
  conflictDetails,
  PLATFORM_SCOPE,
  type SellerLine,
} from '../worker/lib/cartSeller';

const platformLine: SellerLine = { seller_type: 'levonis', merchant_id: null, store_id: null };
const aliLine: SellerLine = { seller_type: 'merchant', merchant_id: 'm_ali', store_id: 's_ali' };
const zainLine: SellerLine = { seller_type: 'merchant', merchant_id: 'm_zain', store_id: 's_zain' };

// ------------------------------------------------------------------- scope

test('an empty cart has no seller at all, so the first add never conflicts', () => {
  // Not "a Levonis cart with nothing in it". If an empty cart claimed the
  // platform scope, the first merchant add would be refused for no reason.
  assert.equal(cartSellerScope([]), null);
  assert.equal(sellerConflict([], PLATFORM_SCOPE), null);
  assert.equal(sellerConflict([], merchantScope('m_ali', 's_ali')), null);
});

test('the scope is read from the lines, so removing the last one frees the cart', () => {
  // The exact failure a stored flag produces: empty the merchant lines and
  // the cart is genuinely empty again.
  assert.deepEqual(cartSellerScope([aliLine]), {
    seller_type: 'merchant',
    merchant_id: 'm_ali',
    store_id: 's_ali',
  });
  assert.equal(cartSellerScope([]), null);
});

test('a platform cart is the platform scope', () => {
  assert.deepEqual(cartSellerScope([platformLine, platformLine]), PLATFORM_SCOPE);
});

// --------------------------------------------------------------- conflicts

test('two different merchants conflict', () => {
  const clash = sellerConflict([aliLine], cartSellerScope([zainLine])!);
  assert.ok(clash, 'adding a second merchant was allowed');
  assert.equal(clash.current.merchant_id, 'm_ali');
  assert.equal(clash.incoming.merchant_id, 'm_zain');
});

test('the same merchant does not conflict with itself', () => {
  assert.equal(sellerConflict([aliLine, aliLine], merchantScope('m_ali', 's_ali')), null);
});

test('platform and merchant conflict in both directions', () => {
  assert.ok(sellerConflict([platformLine], merchantScope('m_ali', 's_ali')), 'merchant into a Levonis cart');
  assert.ok(sellerConflict([aliLine], PLATFORM_SCOPE), 'Levonis into a merchant cart');
});

test('two Levonis lines are always the same seller', () => {
  assert.equal(sameSeller(PLATFORM_SCOPE, PLATFORM_SCOPE), true);
  assert.equal(sameSeller(merchantScope('m_ali', 's_ali'), merchantScope('m_ali', 's_ali')), true);
  assert.equal(sameSeller(merchantScope('m_ali', 's_ali'), merchantScope('m_zain', 's_zain')), false);
});

test('a merchant with two stores is still one seller', () => {
  // Identity is the MERCHANT, not the storefront. If a merchant ever runs a
  // second store, their goods still settle as one order with one party
  // responsible — the store id is carried for routing and display.
  assert.equal(sameSeller(merchantScope('m_ali', 's_one'), merchantScope('m_ali', 's_two')), true);
});

test('the conflict names both shops so the dialogue can be specific', () => {
  const clash = sellerConflict([aliLine], merchantScope('m_zain', 's_zain'))!;
  const d = conflictDetails(clash, { current: 'Ali 3D', incoming: 'Zain Prints' });
  assert.equal(d.cart_seller_name, 'Ali 3D');
  assert.equal(d.incoming_seller_name, 'Zain Prints');
  assert.equal(d.cart_merchant_id, 'm_ali');
  assert.equal(d.incoming_merchant_id, 'm_zain');
});

// ------------------------------------------------------- the database floor

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(dir, f), 'utf8'));
  }
  db.exec(`
    INSERT INTO users (id,name,email,password_hash) VALUES ('u1','A','a@x.co','h');
    INSERT INTO products (id,slug,name,price_iqd) VALUES ('p1','x','X',100);
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m_ali','u1','Ali 3D');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name)
      VALUES ('s_ali','m_ali','u1','ali3d','Ali 3D');
    INSERT INTO community_products (id,merchant_id,store_id,slug,name,price_iqd)
      VALUES ('cp1','m_ali','s_ali','b','B',5000);
  `);
  return db;
}

test('the database refuses a malformed line even if every route forgot to check', () => {
  // The application rule above is the friendly half. This is the floor: an
  // endpoint written next year that skips cartSeller entirely still cannot
  // write a line that lies about who is selling.
  const db = freshDb();

  db.exec(
    `INSERT INTO cart_items (id,user_id,seller_type,merchant_id,store_id,community_product_id,qty)
     VALUES ('ok','u1','merchant','m_ali','s_ali','cp1',1)`
  );

  assert.throws(
    () =>
      db.exec(
        `INSERT INTO cart_items (id,user_id,seller_type,community_product_id,qty)
         VALUES ('bad1','u1','merchant','cp1',1)`
      ),
    /.*/,
    'a merchant line with no merchant_id was written'
  );
  assert.throws(
    () =>
      db.exec(
        `INSERT INTO cart_items (id,user_id,seller_type,merchant_id,store_id,community_product_id,product_id,qty)
         VALUES ('bad2','u1','merchant','m_ali','s_ali','cp1','p1',1)`
      ),
    /.*/,
    'a line naming both a platform and a merchant product was written'
  );
});

test('a platform line and a merchant line can both exist in the table — the rule is per cart, not per row', () => {
  // Worth stating: the CHECK constrains a ROW's internal consistency. It is
  // the route layer that keeps one CART to one seller, because SQLite cannot
  // express "every row for this user agrees". Two different users holding
  // different seller carts is completely normal and must stay possible.
  const db = freshDb();
  db.exec(`INSERT INTO users (id,name,email,password_hash) VALUES ('u2','B','b@x.co','h')`);
  db.exec(
    `INSERT INTO cart_items (id,user_id,seller_type,product_id,qty) VALUES ('a','u1','levonis','p1',1)`
  );
  db.exec(
    `INSERT INTO cart_items (id,user_id,seller_type,merchant_id,store_id,community_product_id,qty)
     VALUES ('b','u2','merchant','m_ali','s_ali','cp1',1)`
  );
  const rows = db.prepare('SELECT user_id, seller_type FROM cart_items ORDER BY user_id').all();
  assert.equal(rows.length, 2);
});
