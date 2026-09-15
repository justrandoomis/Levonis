/**
 * "تقييم المنتجات المستلمة" — the product-review window of a RECEIVED order,
 * tested as the promise the sheet is built on.
 *
 * src/components/orders/ReviewSheet.tsx asks GET /api/reviews/order/:orderId
 * once and then enables or disables every row from that answer alone. So the
 * contract worth pinning is not "the endpoint returns 200" — it is that the
 * endpoint and POST /api/reviews CANNOT DISAGREE:
 *
 *   * every line the endpoint calls `reviewable`, POST accepts;
 *   * every line it calls `reviewed`, POST refuses (409);
 *   * every line it calls `not_delivered`, POST refuses (ORDER_NOT_DELIVERED);
 *   * anything it omits, POST could not have stored anyway.
 *
 * A sheet that offers a row the server would bounce is the exact defect this
 * file exists to prevent.
 *
 * The real routes run against the real migrations through the SQLite adapter;
 * only the session is stubbed.
 * Run: npx tsx --test tests/orderReviewSheet.test.ts
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
import { STATIC_SECURITY_HEADERS } from '../worker/lib/securityPolicy';
import { reviewRoutes } from '../worker/routes/reviews';

interface Line {
  order_item_id: string;
  product_id: string;
  name: string;
  image: string;
  variant: string;
  is_printer: boolean;
  existing_review: { id: string; stars: number; status: string; created_at: string } | null;
  can_replace_system_review: boolean;
  state: 'reviewable' | 'reviewed' | 'not_delivered';
}
interface OrderReview {
  success: boolean;
  order_id: string;
  delivered: boolean;
  review_points: number | null;
  remaining: number;
  lines: Line[];
}

const ORDER_COLS = `id, user_id, status, stage, shipping_type, address_snapshot, delivery_method_id,
  delivery_method_snapshot, payment_method_id, subtotal_iqd, shipping_iqd, exchange_rate, total_iqd,
  due_on_delivery_iqd, delivered_at, created_at, updated_at`;

function order(id: string, user: string, status: string, delivered: string | null) {
  return `INSERT INTO orders (${ORDER_COLS}) VALUES
    ('${id}','${user}','${status}','${status}','direct','{}','standard','{}','cash',
     100000,5000,1400,105000,0,${delivered ? `'${delivered}'` : 'NULL'},
     '2026-01-01T10:00:00.000Z','2026-01-01T10:00:00.000Z');`;
}

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) raw.exec(readFileSync(join(dir, f), 'utf8'));
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','s@x.co','h','customer'),
      ('stranger','Omar','o@x.co','h','customer');
    INSERT INTO products (id,slug,name,name_ar,price_iqd,images) VALUES
      ('p1','bambu-a1','Bambu A1','بامبو A1',899000,'["https://img/a1.jpg"]'),
      ('p2','pla-white','PLA White','PLA أبيض',25000,'[]'),
      ('p3','nozzle','Nozzle 0.4','فوهة',5000,'[]');
    -- A printer catalog, so is_printer is the owner's real flag, not a guess.
    INSERT INTO catalogs (id,slug,name_ar,name_en,is_printer_catalog)
      VALUES ('cat_pr','test-printers-review-sheet','طابعات','Printers',1);
    INSERT INTO product_catalogs (product_id,catalog_id,position) VALUES ('p1','cat_pr',1);

    ${order('ORD-D', 'buyer', 'delivered', '2026-01-04T10:00:00.000Z')}
    ${order('ORD-SHIP', 'buyer', 'shipped', null)}
    ${order('ORD-OTHER', 'stranger', 'delivered', '2026-01-04T10:00:00.000Z')}

    INSERT INTO order_items (id,order_id,product_id,name_snapshot,image_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd) VALUES
      ('oi1','ORD-D','p1','Bambu A1','https://img/a1.jpg','Combo',1,899000,899000),
      -- The SAME product on two lines of one order: 0003's
      -- UNIQUE(user_id, product_id) collapses them into a single review.
      ('oi2','ORD-D','p2','PLA White','','White',2,25000,50000),
      ('oi3','ORD-D','p2','PLA White','','Black',1,25000,25000),
      -- A mystery spool carries no product and can hold no review row.
      ('oi4','ORD-D',NULL,'Mystery spool','','',1,0,0),
      -- A line whose product has since left the catalog: reviews.product_id
      -- has an FK to products, so this one cannot be reviewed at all.
      ('oi5','ORD-D','p_gone','Discontinued part','','',1,1000,1000),
      ('oi6','ORD-SHIP','p3','Nozzle 0.4','','',1,5000,5000),
      ('oi7','ORD-OTHER','p1','Bambu A1','','',1,899000,899000);
  `);
  return { raw, db: new SqliteD1(raw) as unknown as D1Database };
}

function appAs(db: D1Database, user: { id: string; role: string }) {
  const a = new Hono<AppContext>();
  a.use('*', async (c, next) => {
    c.set('user', { id: user.id, role: user.role, email: `${user.id}@x.co` } as never);
    c.env = { DB: db } as never;
    await next();
  });
  a.route('/api/reviews', reviewRoutes);
  a.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ success: false, error: err.message, code: err.code }, err.status as 400);
    throw err;
  });
  return a;
}

const buyer = { id: 'buyer', role: 'customer' };
const stranger = { id: 'stranger', role: 'customer' };

const orderReview = async (db: D1Database, who: typeof buyer, id: string) => {
  const res = await appAs(db, who).request(`/api/reviews/order/${id}`);
  return { status: res.status, body: (await res.json()) as OrderReview };
};

const postReview = (db: D1Database, who: typeof buyer, payload: Record<string, unknown>) =>
  appAs(db, who).request('/api/reviews', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

/** Long enough to clear the server's minimum, distinct per call so the
 *  duplicate-text signal does not colour the result. */
const text = (n: number) => `Print ${n}: the bed levelling held for a week and the first layer is clean every time.`;

const byProduct = (b: OrderReview) => Object.fromEntries(b.lines.map((l) => [l.product_id, l.state]));

// --------------------------------------------------------------- ownership

test('the order review list is the caller’s own order only', async () => {
  const { db } = setup();
  assert.equal((await orderReview(db, buyer, 'ORD-D')).status, 200);
  // Someone else's delivered order is the same 404 its absence would give.
  assert.equal((await orderReview(db, stranger, 'ORD-D')).status, 404);
  assert.equal((await orderReview(db, buyer, 'ORD-OTHER')).status, 404);
  assert.equal((await orderReview(db, buyer, 'NO-SUCH-ORDER')).status, 404);
});

test('another customer’s review of the same product does not mark mine as rated', async () => {
  const { db } = setup();
  // The stranger rates p1 from THEIR delivered order.
  assert.equal((await postReview(db, stranger, { productId: 'p1', orderId: 'ORD-OTHER', stars: 5, body: text(1) })).status, 200);

  const { body } = await orderReview(db, buyer, 'ORD-D');
  assert.equal(byProduct(body).p1, 'reviewable', 'p1 must still be mine to rate');
  assert.equal(body.lines.find((l) => l.product_id === 'p1')?.existing_review, null);
});

// ------------------------------------------------- which lines are offered

test('the list is one entry per PRODUCT, and omits what could never hold a review', async () => {
  const { db } = setup();
  const { body } = await orderReview(db, buyer, 'ORD-D');

  assert.deepEqual(
    body.lines.map((l) => l.product_id),
    ['p1', 'p2'],
    'two lines of p2 collapse into one, the mystery spool and the delisted product are omitted'
  );
  // The omissions are not cosmetic: POST cannot store either of them.
  assert.equal((await postReview(db, buyer, { productId: 'p_gone', orderId: 'ORD-D', stars: 5, body: text(2) })).status, 400);
  assert.equal(body.remaining, 2);
  // The printer flag is the owner's catalog flag, read for the whole order.
  assert.equal(body.lines.find((l) => l.product_id === 'p1')?.is_printer, true);
  assert.equal(body.lines.find((l) => l.product_id === 'p2')?.is_printer, false);
});

test('an order still on its way offers no stars and says why', async () => {
  const { db } = setup();
  const { body } = await orderReview(db, buyer, 'ORD-SHIP');
  assert.equal(body.delivered, false);
  assert.equal(body.remaining, 0, 'nothing may be rated before it is received');
  assert.deepEqual(body.lines.map((l) => l.state), ['not_delivered']);

  // …and the server refuses it for the same reason, not merely the UI.
  const res = await postReview(db, buyer, { productId: 'p3', orderId: 'ORD-SHIP', stars: 5, body: text(3) });
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { code: string }).code, 'ORDER_NOT_DELIVERED');
});

// ------------------------------------------- each product, one at a time

test('every product of a received order can be rated, and remaining counts down', async () => {
  const { db } = setup();

  assert.equal((await postReview(db, buyer, { productId: 'p1', orderId: 'ORD-D', stars: 5, body: text(4) })).status, 200);
  let { body } = await orderReview(db, buyer, 'ORD-D');
  assert.equal(body.remaining, 1);
  assert.deepEqual(byProduct(body), { p1: 'reviewed', p2: 'reviewable' });
  const rated = body.lines.find((l) => l.product_id === 'p1')!;
  assert.equal(rated.existing_review?.stars, 5);
  assert.equal(rated.existing_review?.status, 'published', 'the review is live, not "awaiting approval"');

  // The SECOND product of the same order is still open — the sheet does not
  // end on the first one.
  assert.equal((await postReview(db, buyer, { productId: 'p2', orderId: 'ORD-D', stars: 4, body: text(5) })).status, 200);
  ({ body } = await orderReview(db, buyer, 'ORD-D'));
  assert.equal(body.remaining, 0, 'nothing left to review — the sheet must say so instead of offering a form');
  assert.deepEqual(byProduct(body), { p1: 'reviewed', p2: 'reviewed' });
  assert.equal(body.lines.find((l) => l.product_id === 'p2')?.existing_review?.stars, 4);
});

test('a second rating of the same product is REFUSED, and the list keeps saying so', async () => {
  const { db } = setup();
  assert.equal((await postReview(db, buyer, { productId: 'p1', orderId: 'ORD-D', stars: 5, body: text(6) })).status, 200);

  const again = await postReview(db, buyer, { productId: 'p1', orderId: 'ORD-D', stars: 1, body: text(7) });
  assert.equal(again.status, 409, 'one review per product — the second is refused, not silently applied');

  const { body } = await orderReview(db, buyer, 'ORD-D');
  const l = body.lines.find((x) => x.product_id === 'p1')!;
  assert.equal(l.state, 'reviewed');
  assert.equal(l.can_replace_system_review, false);
  assert.equal(l.existing_review?.stars, 5, 'the refused 1-star did not overwrite the real 5');
});

// ------------------------------------------ the sheet cannot offer a bounce

test('THE INVARIANT: what the list offers, POST accepts; what it closes, POST refuses', async () => {
  const { db } = setup();
  const { body } = await orderReview(db, buyer, 'ORD-D');

  for (const line of body.lines) {
    const res = await postReview(db, buyer, {
      productId: line.product_id,
      orderId: 'ORD-D',
      stars: 4,
      body: text(body.lines.indexOf(line) + 10),
    });
    if (line.state === 'reviewable') {
      assert.equal(res.status, 200, `${line.product_id} was offered as reviewable and must be accepted`);
    } else {
      assert.notEqual(res.status, 200, `${line.product_id} was not offered and must not be accepted`);
    }
  }

  // Now that both are rated, the list closes both AND POST refuses both.
  const after = (await orderReview(db, buyer, 'ORD-D')).body;
  assert.equal(after.remaining, 0);
  for (const line of after.lines) {
    assert.equal(line.state, 'reviewed');
    const res = await postReview(db, buyer, { productId: line.product_id, orderId: 'ORD-D', stars: 2, body: text(20) });
    assert.equal(res.status, 409, `${line.product_id} is closed in the list and must be closed on the server`);
  }
});

// --------------------------------------------------- untrusted review text

test('review text is bounded on the way in and comes back out as data, never markup', async () => {
  const { db, raw } = setup();
  const injection = '<img src=x onerror="alert(1)"> <script>steal()</script> & "quotes" \'and\' <b>bold</b>';

  // Over the 4000-character bound: refused, nothing stored.
  const tooLong = await postReview(db, buyer, { productId: 'p1', orderId: 'ORD-D', stars: 5, body: 'x'.repeat(4001) });
  assert.equal(tooLong.status, 400);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM reviews').get()!.n, 0, 'an over-long body stores nothing');

  // Inside the bound: stored verbatim as TEXT — the payload is JSON, so the
  // markup travels as a string value and is never a fragment of a document.
  const ok = await postReview(db, buyer, { productId: 'p1', orderId: 'ORD-D', stars: 5, body: `${injection} ${text(30)}` });
  assert.equal(ok.status, 200);

  const res = await appAs(db, buyer).request('/api/reviews/product/p1');
  assert.equal(res.status, 200);
  const rawBody = await res.text();

  // The text is stored and returned VERBATIM — the server does not mangle a
  // customer's words. What keeps it inert is the boundary it crosses, so that
  // boundary is what this pins.
  const parsed = JSON.parse(rawBody) as { reviews: Array<{ body: string }> };
  assert.ok(parsed.reviews[0].body.includes(injection), 'the text round-trips intact as DATA');

  // 1. It leaves as a JSON string value, never as a document.
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  // 2. …and the response may not be re-sniffed into one.
  assert.equal(STATIC_SECURITY_HEADERS['X-Content-Type-Options'], 'nosniff');
  // 3. The sheet renders it as a React TEXT NODE, which escapes at the DOM.
  //    An innerHTML sink appearing here later is the defect this catches.
  const sheet = readFileSync(join(ROOT, 'src/components/orders/ReviewSheet.tsx'), 'utf8');
  assert.ok(!sheet.includes('dangerouslySetInnerHTML'), 'review text must never reach an innerHTML sink');
});

// ---------------------------------------------------------- honest config

test('the points promise is the configured value or nothing — never invented', async () => {
  const { db, raw } = setup();
  assert.equal((await orderReview(db, buyer, 'ORD-D')).body.review_points, null, 'unconfigured stays null');

  // The SAME key worker/routes/reviews.ts reads for the per-product endpoint.
  raw.exec(`INSERT INTO admin_settings (key, value) VALUES ('reviewPointsConfig', '{"enabled":true,"points":25}')`);
  assert.equal((await orderReview(db, buyer, 'ORD-D')).body.review_points, 25);
});
