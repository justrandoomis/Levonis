/**
 * A DEPLOYMENT AHEAD OF ITS DATABASE MUST NOT SELL A CART IT CANNOT CHECK OUT.
 *
 * Two defects the verify pass found, both invisible from the storefront:
 *
 *  1. The cart route learned to survive a missing `cart_items` column; the
 *     CHECKOUT did not. Its own SELECT names the same columns with no
 *     fallback, so a customer opened a cart that rendered at the right price
 *     and then hit a 500 the instant they pressed checkout — the worst of both
 *     answers, and the state that best matches the owner's original report.
 *
 *  2. The order batch's catch-all turned EVERY unrecognised failure, a schema
 *     error included, into `badRequest('Order could not be placed. Please try
 *     again.')` with no code. "Please try again" is false for a missing
 *     column: no amount of retrying adds one. With migration 0076 unapplied,
 *     home, catalogue, cart and quote all answer 200 and not a single order
 *     can be placed, while the customer is told it is their problem.
 *
 * Both run the real checkout against real migrations with the column actually
 * removed, so neither test can pass by accident.
 * Run: npx tsx --test tests/checkoutSchemaResilience.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ROOT, SqliteD1 } from './fixtures/d1';
import type { AppContext } from '../worker/lib/types';
import { HttpError } from '../worker/lib/http';
import { orderRoutes } from '../worker/routes/orders';
import { cartRoutes } from '../worker/routes/cart';
import { acceptedPolicies } from './lib/policies';
import { resetPolicyCorpusMemo } from '../worker/lib/policySync';

/** Columns `cart_items` grew after 0001, each in its own migration. Dropping
 *  one reproduces the window in which the Worker is deployed and its
 *  migration is not. */
const LATE_CART_COLUMNS = ['fulfillment_type', 'option_value_ids', 'transport_method', 'warranty_plan_id', 'draw_salt'];

function setup(dropColumn?: string) {
  // A NEW DATABASE IS A NEW ARCHIVE. `ensurePolicyCorpus` memoises a COMPLETED
  // mirror per isolate, and one test process is one isolate holding many
  // databases: without this, the first database in the run gets the policy
  // rows and every later one is skipped as already-synced, so checkout refuses
  // consent it cannot bind to a row. tests/fixtures/app.ts#dbThrough does the
  // same for the fixtures it builds; this file builds its own.
  resetPolicyCorpusMemo();
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) raw.exec(readFileSync(join(dir, f), 'utf8'));
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('buyer','Sara','s@x.co','h','customer');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default)
      VALUES ('addr','buyer','Home','Sara','+9647701234567','Baghdad, Karrada 12','',1);
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,images)
      VALUES ('p_pla','pla-basic','PLA Basic','PLA أساسي',25000,'active',50,'[]','[]','direct_sale','["direct_sale"]','[]');
    INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty)
      VALUES ('ci','buyer','p_pla','','[]','','','','',2);
  `);
  if (dropColumn) {
    if (dropColumn === 'option_value_ids') {
      raw.exec('DROP INDEX IF EXISTS idx_cart_levonis_line_v2; DROP INDEX IF EXISTS idx_cart_levonis_line;');
    }
    raw.exec(`ALTER TABLE cart_items DROP COLUMN ${dropColumn};`);
  }
  return { raw, db: new SqliteD1(raw) as unknown as D1Database };
}

const pending: Promise<unknown>[] = [];
const ctx = {
  waitUntil: (p: Promise<unknown>) => {
    pending.push(p.catch(() => undefined));
  },
  passThroughOnException() {},
} as unknown as ExecutionContext;

function app(db: D1Database) {
  const a = new Hono<AppContext>();
  a.use('*', async (c, next) => {
    c.set('user', { id: 'buyer', role: 'customer', email: 'b@x.co', username: 'buyer' } as never);
    c.env = { DB: db } as never;
    await next();
  });
  a.route('/api/orders', orderRoutes);
  a.route('/api/cart', cartRoutes);
  a.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ success: false, error: err.message, code: err.code }, err.status as 400);
    throw err;
  });
  return a;
}

let seq = 0;
async function call(db: D1Database, path: string, method: 'GET' | 'POST') {
  const res = await app(db).request(
    path,
    method === 'GET'
      ? undefined
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            addressId: 'addr',
            deliveryMethodId: 'standard',
            paymentMethodId: 'cash',
            useWallet: false,
            usePoints: false,
            itemIds: [],
            idempotencyKey: `schema-resilience-checkout-${++seq}`,
            policyAcceptance: acceptedPolicies(),
          }),
        },
    undefined,
    ctx
  );
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* `text` carries the failure into the assertion message */
  }
  await Promise.all(pending.splice(0));
  return { status: res.status, body, text };
}

// ===========================================================================
// 1. THE CART AND THE CHECKOUT SURVIVE THE SAME WINDOW
// ===========================================================================

for (const col of LATE_CART_COLUMNS) {
  test(`a cart_items.${col} behind the deployment leaves BOTH the cart and the quote working`, async () => {
    const { db } = setup(col);
    const cart = await call(db, '/api/cart', 'GET');
    assert.equal(cart.status, 200, cart.text);
    // The quote is what src/pages/Checkout.tsx issues the moment the screen
    // opens. It used to 500 here while the cart above answered 200.
    const quote = await call(db, '/api/orders/quote', 'POST');
    assert.equal(quote.status, 200, `quote refused with ${col} missing: ${quote.text}`);
  });
}

test('the same cart still checks out, and the line keeps its legacy meaning', async () => {
  const { raw, db } = setup('fulfillment_type');
  const res = await call(db, '/api/orders', 'POST');
  assert.equal(res.status, 200, res.text);
  const order = raw.prepare('SELECT shipping_type, subtotal_iqd FROM orders').get() as
    | { shipping_type: string; subtotal_iqd: number }
    | undefined;
  assert.ok(order, 'the order exists');
  // '' is the DEFAULT 0073 itself declares, and selectionFromCartRow's legacy
  // inference already reads a line stored that way as a direct sale. Nothing
  // is guessed: this is the value the row would have carried.
  assert.equal(order.shipping_type, 'direct');
  assert.equal(order.subtotal_iqd, 50_000, '2 × 25,000 — the price is unaffected');
});

test('a fully migrated database is unaffected, and takes the fast path', async () => {
  const { raw, db } = setup();
  const res = await call(db, '/api/orders', 'POST');
  assert.equal(res.status, 200, res.text);
  assert.equal(
    (raw.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number }).n,
    1
  );
});

// ===========================================================================
// 2. A MISSING COLUMN IS THE SHOP'S PROBLEM, NOT THE SHOPPER'S
// ===========================================================================

test('a points_accruals column behind the deployment answers SERVICE_SETUP, not "try again"', async () => {
  // Exactly the 0076 state: the storefront is healthy and the checkout is
  // dead. The old answer was 400 with no code — "your fault, retry" — for a
  // condition no retry can fix.
  const { raw, db } = setup();
  raw.exec('ALTER TABLE points_accruals DROP COLUMN base_points;');

  assert.equal((await call(db, '/api/cart', 'GET')).status, 200, 'the shop still looks healthy');
  assert.equal((await call(db, '/api/orders/quote', 'POST')).status, 200, 'and so does the quote');

  const res = await call(db, '/api/orders', 'POST');
  assert.equal(res.status, 503, res.text);
  assert.equal(res.body.code, 'SERVICE_SETUP');
  assert.match(String(res.body.error), /not a problem with your cart/i);
  // No table name, no column name, no SQL reaches the customer.
  assert.doesNotMatch(String(res.body.error), /points_accruals|base_points|SQLITE|D1_ERROR/i);
  assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number }).n, 0);
});

test('an ordinary refusal is still a 400 and still says what to do', async () => {
  const { raw, db } = setup();
  raw.exec("DELETE FROM cart_items");
  const res = await call(db, '/api/orders', 'POST');
  assert.equal(res.status, 400, res.text);
  assert.match(String(res.body.error), /cart is empty/i);
});
