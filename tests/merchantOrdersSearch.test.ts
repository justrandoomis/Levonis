/**
 * THE ORDERS LIST'S SEARCH AND EXPORT — GET /api/merchant/orders?q= and
 * GET /api/merchant/orders/export.csv (merchant platform v2 §4.2, P3b).
 *
 *   q matches a prefix of the order number (with or without «ORD-» or a typed
 *   «#»), part of the customer's name, or ≥ 4 digits of the phone on the
 *   order's address — and the phone NEVER comes back in the answer;
 *   a search over 60 characters is SEARCH_QUERY_TOO_LONG;
 *   the rows carry the governorate and the tracking number the list shows;
 *   `next_cursor` is exact (limit + 1): the last page never offers an empty next;
 *   the CSV is the same query — BOM, attachment, header row, the list's
 *   columns and nothing the list withholds — filtered by status and by day.
 *
 * Run: node --import tsx --test tests/merchantOrdersSearch.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, get, json } from './fixtures/app';
import { legacyLedgerWrite } from './fixtures/legacyLedger';
import { merchantRoutes, orderCsvRow } from '../worker/routes/merchant';
import { merchantOrderRoutes } from '../worker/routes/merchantOrders';
import { csvFilename, CSV_MAX_ROWS } from '../worker/lib/csv';

function seed(): DatabaseSync {
  const raw = freshDb();
  legacyLedgerWrite(raw, `
    INSERT INTO users (id,name,email,password_hash,role,email_verified_at,locale) VALUES
      ('sara','سارة أحمد','sara@x.co','h','customer','2026-01-01T00:00:00.000Z','ar'),
      ('nour','نور محمد','nour@x.co','h','customer','2026-01-01T00:00:00.000Z','ar'),
      ('ali','Ali','ali@x.co','h','merchant',NULL,'ar'),
      ('omar','Omar','omar@x.co','h','merchant',NULL,'ar');
    INSERT INTO community_merchants (id,user_id,name,status) VALUES ('m_ali','ali','Ali 3D','active'), ('m_omar','omar','Omar 3D','active');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,status,delivery_settings)
      VALUES ('s_ali','m_ali','ali','ali3d','Ali 3D','active','{}'), ('s_omar','m_omar','omar','omar3d','Omar 3D','active','{}');
  `);
  const add = raw.prepare(
    `INSERT INTO orders
       (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
        subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_type,stage,merchant_id,seller_type,created_at,delivery_tracking_no)
     VALUES (?,?,?,?,'merchant','{}','wallet',10000,1400,?,0,'direct','received',?,'merchant',?,?)`
  );
  add.run('ORD-A1F3', 'sara', 'pending', '{"phone":"07701234567","governorate":"baghdad","address":"شارع فلسطين"}', 45000, 'm_ali', '2026-03-03T10:00:00.000Z', '');
  add.run('ORD-B7', 'nour', 'confirmed', '{"phone":"+964 780-555-9999","governorate":"erbil"}', 12500, 'm_ali', '2026-03-02T10:00:00.000Z', '');
  add.run('ORD-C9', 'sara', 'delivered', '{}', 8000, 'm_ali', '2026-03-01T10:00:00.000Z', 'TRK-1');
  // Another store's order by the same customer: never in this store's list, whatever the search.
  add.run('ORD-X1', 'sara', 'pending', '{"phone":"07701234567"}', 999, 'm_omar', '2026-03-04T10:00:00.000Z', '');
  return raw;
}

const app = (raw: DatabaseSync) =>
  stubApp(asD1(raw), { id: 'ali', role: 'merchant', email: 'ali@x.co' }, (a) => {
    a.route('/api/merchant', merchantRoutes);
    a.route('/api/merchant/orders', merchantOrderRoutes);
  });

const ids = async (a: ReturnType<typeof app>, qs: string) => {
  const res = await get(a, `/api/merchant/orders${qs}`);
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  return { ids: body.orders.map((o: { id: string }) => o.id) as string[], body };
};

test('q matches the order number by prefix — with or without «ORD-», with or without a typed «#»', async () => {
  const a = app(seed());
  assert.deepEqual((await ids(a, '?q=A1F')).ids, ['ORD-A1F3']);
  assert.deepEqual((await ids(a, '?q=%23ORD-A1')).ids, ['ORD-A1F3'], '#ORD-A1');
  assert.deepEqual((await ids(a, '?q=ord-c')).ids, ['ORD-C9'], 'case does not matter');
  assert.deepEqual((await ids(a, '?q=1F3')).ids, [], 'a prefix, not a substring, of the number');
  assert.equal((await ids(a, '?q=A1F')).body.q, 'A1F', 'the answer names the search it answered');
});

test('q matches part of the customer\'s name; the newest order first; never another store\'s', async () => {
  const a = app(seed());
  assert.deepEqual((await ids(a, '?q=' + encodeURIComponent('نور'))).ids, ['ORD-B7']);
  assert.deepEqual((await ids(a, '?q=' + encodeURIComponent('سارة'))).ids, ['ORD-A1F3', 'ORD-C9'], 'ORD-X1 belongs to another store');
  assert.deepEqual((await ids(a, '?q=' + encodeURIComponent('سارة') + '&status=delivered')).ids, ['ORD-C9'], 'the status filter holds under a search');
});

test('q matches FOUR OR MORE digits of the phone on the order\'s address — and the phone never comes back', async () => {
  const a = app(seed());
  const hit = await ids(a, '?q=1234');
  assert.deepEqual(hit.ids, ['ORD-A1F3']);
  assert.deepEqual((await ids(a, '?q=' + encodeURIComponent('٠٧٧٠١٢٣٤'))).ids, ['ORD-A1F3'], 'Arabic-Indic digits, trunk 0 dropped');
  assert.deepEqual((await ids(a, '?q=5559999')).ids, ['ORD-B7'], 'spaces, dashes and the + are not part of a number');
  assert.deepEqual((await ids(a, '?q=123')).ids, [], 'three digits match half the book, so they match no phone');
  const text = JSON.stringify(hit.body);
  assert.ok(!text.includes('1234567') && !text.includes('phone'), `the phone is matched, never returned: ${text}`);
  assert.ok(!text.includes('شارع'), 'nor the street');
});

test('a search over 60 characters is refused as itself; 60 is accepted', async () => {
  const a = app(seed());
  const long = await get(a, '?q='.replace('?', '/api/merchant/orders?') + 'x'.repeat(61));
  assert.equal(long.status, 400);
  assert.equal((await json(long)).code, 'SEARCH_QUERY_TOO_LONG');
  assert.equal((await get(a, '/api/merchant/orders?q=' + 'x'.repeat(60))).status, 200);
});

test('the rows carry what the list shows: the governorate, the tracking number, the lines — and no phone or street', async () => {
  const a = app(seed());
  const { body } = await ids(a, '');
  const byId = Object.fromEntries(body.orders.map((o: { id: string }) => [o.id, o]));
  assert.equal(byId['ORD-A1F3'].governorate, 'baghdad');
  assert.equal(byId['ORD-B7'].governorate, 'erbil');
  assert.equal(byId['ORD-C9'].governorate, '');
  assert.equal(byId['ORD-C9'].tracking_no, 'TRK-1');
  assert.equal(byId['ORD-A1F3'].tracking_no, '');
  assert.equal(byId['ORD-A1F3'].customer_name, 'سارة أحمد');
  assert.equal(byId['ORD-A1F3'].item_count, 0);
  const text = JSON.stringify(body);
  assert.ok(!text.includes('0770') && !text.includes('address_snapshot') && !text.includes('phone'));
  assert.equal(body.orders.length, 3, 'three orders here; ORD-X1 is another store\'s');
});

test('next_cursor is EXACT: a page that ends on the last order says so (limit + 1)', async () => {
  const a = app(seed());
  const exact = await ids(a, '?limit=3');
  assert.equal(exact.ids.length, 3);
  assert.equal(exact.body.next_cursor, null, 'exactly `limit` rows and nothing after: no next page');
  const first = await ids(a, '?limit=2');
  assert.deepEqual(first.ids, ['ORD-A1F3', 'ORD-B7']);
  assert.ok(first.body.next_cursor, 'more exists, so a cursor');
  const second = await ids(a, `?limit=2&cursor=${encodeURIComponent(first.body.next_cursor)}`);
  assert.deepEqual(second.ids, ['ORD-C9']);
  assert.equal(second.body.next_cursor, null);
});

test('THE CSV is the same query as a spreadsheet: BOM, attachment, header row, the list\'s columns, nothing withheld', async () => {
  const a = app(seed());
  const res = await get(a, '/api/merchant/orders/export.csv');
  assert.equal(res.status, 200, await res.clone().text());
  assert.match(res.headers.get('content-type') ?? '', /^text\/csv; charset=utf-8/);
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="orders.csv"');
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  assert.equal(res.headers.get('x-truncated'), null);
  // `Response.text()` strips a BOM while decoding; the bytes on the wire carry it.
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], 'a BOM, so Excel reads the Arabic');
  const text = new TextDecoder().decode(bytes);
  const lines = text.split('\r\n');
  assert.equal(lines[0], 'order_id,status,created_at,customer,governorate,items,subtotal_iqd,shipping_iqd,total_iqd,your_share_iqd,payment_method,tracking_no');
  assert.equal(lines.length, 4, 'a header and three rows');
  assert.match(lines[1], /^ORD-A1F3,pending,2026-03-03T10:00:00.000Z,سارة أحمد,baghdad,0,10000,/);
  assert.match(lines[3], /^ORD-C9,delivered,.*,TRK-1$/);
  assert.ok(!text.includes('0770') && !text.includes('5559999') && !text.includes('شارع'), 'no phone, no street — the list\'s own limits');
});

test('the CSV takes the list\'s filter and a day range (a BAGHDAD day); a bad day is refused; the route is not swallowed by /orders/:id', async () => {
  const raw = seed();
  const a = app(raw);
  const late = raw.prepare(
    `INSERT INTO orders
       (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
        subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_type,stage,merchant_id,seller_type,created_at,delivery_tracking_no)
     VALUES (?,?,?,?,'merchant','{}','wallet',10000,1400,?,0,'direct','received',?,'merchant',?,?)`
  );
  // 01:30 Baghdad on the 2nd is 22:30 UTC on the 1st — the merchant's day, not the calendar's…
  late.run('ORD-D2', 'sara', 'confirmed', '{}', 5000, 'm_ali', '2026-03-01T22:30:00.000Z', '');
  // …and 00:30 Baghdad on the 3rd (21:30 UTC on the 2nd) is already tomorrow.
  late.run('ORD-D3', 'sara', 'confirmed', '{}', 5000, 'm_ali', '2026-03-02T21:30:00.000Z', '');
  const pendingOnly = await get(a, '/api/merchant/orders/export.csv?status=pending');
  assert.equal(pendingOnly.headers.get('content-disposition'), 'attachment; filename="orders-pending.csv"');
  const rows = (await pendingOnly.text()).split('\r\n');
  assert.equal(rows.length, 2);
  assert.match(rows[1], /^ORD-A1F3,/);

  const day = await get(a, '/api/merchant/orders/export.csv?from=2026-03-02&to=2026-03-02');
  assert.equal(day.status, 200);
  const dayRows = (await day.text()).split('\r\n');
  assert.deepEqual(dayRows.slice(1).map((l) => l.split(',')[0]), ['ORD-B7', 'ORD-D2'], '`to` is inclusive of its whole Baghdad day; the small hours of the 3rd are not the 2nd');

  const searched = await get(a, '/api/merchant/orders/export.csv?q=' + encodeURIComponent('نور'));
  assert.deepEqual((await searched.text()).split('\r\n').slice(1).map((l) => l.split(',')[0]), ['ORD-B7']);

  const bad = await get(a, '/api/merchant/orders/export.csv?from=yesterday');
  assert.equal(bad.status, 400);
  assert.equal((await json(bad)).code, 'BAD_DATE');
  const badLong = await get(a, '/api/merchant/orders/export.csv?q=' + 'x'.repeat(61));
  assert.equal((await json(badLong)).code, 'SEARCH_QUERY_TOO_LONG');
});

test('the CSV row and the filename helpers are pure and defensive', () => {
  assert.deepEqual(orderCsvRow({ id: 'ORD-1', status: 'pending', total_iqd: 5, item_count: null }), [
    'ORD-1', 'pending', '', '', '', '', '', '', '5', '', '', '',
  ]);
  assert.equal(csvFilename('orders-pending-2026-03-02'), 'orders-pending-2026-03-02.csv');
  assert.equal(csvFilename('../x y.csv'), 'x_y.csv', 'nothing the Content-Disposition grammar chokes on');
  assert.equal(csvFilename(''), 'export.csv');
  assert.equal(CSV_MAX_ROWS, 5000);
});
