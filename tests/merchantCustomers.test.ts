/**
 * THE PEOPLE WHO BOUGHT FROM THIS STORE (W3-B): GET /api/merchant/customers
 * and GET /api/merchant/customers/:key.
 *
 * Only buyers of THIS store (a cancelled order makes no customer); keyed by an
 * order id, never a user id; paged by a keyset that never repeats or skips;
 * searched by name or phone without returning the phone; the detail shows
 * only this store's orders and the phone the store already sees.
 *
 * Run: node --import tsx --test tests/merchantCustomers.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { get, json } from './fixtures/app';
import { OWNER, OWNER2, addOrder, appOf, seedW2E } from './fixtures/merchantW2E';
import { merchantCustomerRoutes, parseKeyset } from '../worker/routes/merchantCustomers';

const call = async (raw: DatabaseSync, path: string, user = OWNER) => {
  const res = await get(appOf(raw, user, (a) => a.route('/api/merchant/customers', merchantCustomerRoutes)), `/api/merchant/customers${path}`);
  return { status: res.status, body: await json(res) };
};

function world() {
  const raw = seedW2E();
  raw.exec(`
    INSERT INTO users (id,name,username,email,password_hash,role,phone_e164) VALUES
      ('buyer3','Huda Ali','huda','b3@x.co','h','customer','+9647800000003'),
      ('ghost','Only Cancelled','ghost','g@x.co','h','customer',NULL);
  `);
  addOrder(raw, { id: 'O-S1', user: 'buyer', at: '2026-09-01T10:00:00.000Z', total: 10000, governorate: 'basra' });
  addOrder(raw, { id: 'O-S2', user: 'buyer', at: '2026-09-05T10:00:00.000Z', total: 30000, governorate: 'erbil' });
  addOrder(raw, { id: 'O-S3', user: 'buyer', at: '2026-09-06T10:00:00.000Z', total: 99000, status: 'cancelled' });
  addOrder(raw, { id: 'O-O1', user: 'buyer2', at: '2026-09-03T10:00:00.000Z', total: 5000 });
  addOrder(raw, { id: 'O-H1', user: 'buyer3', at: '2026-09-04T10:00:00.000Z', total: 7000, governorate: null });
  addOrder(raw, { id: 'O-G1', user: 'ghost', at: '2026-09-07T10:00:00.000Z', total: 1000, status: 'cancelled' });
  // Another store: Sara bought there too, and Omar only there.
  addOrder(raw, { id: 'Z-1', user: 'buyer', merchant: 'm2', store: 's2', at: '2026-09-08T10:00:00.000Z', total: 777000 });
  raw.exec(`UPDATE orders SET address_snapshot = '{"governorate":"erbil","phone":"0770 123 4567"}' WHERE id = 'O-S2'`);
  return raw;
}

test('the list: buyers of THIS store only, counted orders only, newest buyer first, keyed by an order id', async () => {
  const raw = world();
  const { status, body } = await call(raw, '');
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(
    body.customers.map((c: Record<string, unknown>) => [c.key, c.name, c.order_count, c.spent_iqd, c.governorate ?? null]),
    [
      ['O-S1', 'Sara Ahmed', 2, 40000, 'erbil'],
      ['O-H1', 'Huda Ali', 1, 7000, null],
      ['O-O1', 'Omar Najm', 1, 5000, 'baghdad'],
    ],
    'the cancelled 99,000 and the other store\'s 777,000 are nobody\'s spend here; the ghost never bought'
  );
  assert.equal(body.customers[0].link, '/merchant/customers/O-S1');
  assert.equal(body.next_cursor, null);
  const text = JSON.stringify(body);
  for (const leak of ['"buyer"', 'buyer2', 'user_id', '0770', '+964']) assert.ok(!text.includes(leak), `${leak} leaked`);
});

test('the other store sees its own buyer and nothing of this one', async () => {
  const raw = world();
  const { body } = await call(raw, '', OWNER2);
  assert.deepEqual(body.customers.map((c: { key: string; spent_iqd: number }) => [c.key, c.spent_iqd]), [['Z-1', 777000]]);
});

test('paging: a keyset that neither repeats nor skips, even when two buyers share a timestamp', async () => {
  const raw = world();
  addOrder(raw, { id: 'O-T1', user: 'boss', at: '2026-09-04T10:00:00.000Z', total: 1 }); // same instant as Huda
  const seen: string[] = [];
  let cursor = '';
  for (let i = 0; i < 10; i++) {
    const { status, body } = await call(raw, `?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    assert.equal(status, 200, JSON.stringify(body));
    seen.push(...body.customers.map((c: { key: string }) => c.key));
    if (!body.next_cursor) break;
    cursor = body.next_cursor;
  }
  assert.deepEqual(seen, ['O-S1', 'O-T1', 'O-H1', 'O-O1']);
  assert.equal((await call(raw, '?cursor=garbage')).body.code, 'BAD_CURSOR');
});

test('search: by name, or by a phone on this store\'s orders — matched, never returned', async () => {
  const raw = world();
  assert.deepEqual((await call(raw, '?q=sara')).body.customers.map((c: { key: string }) => c.key), ['O-S1']);
  const byPhone = await call(raw, `?q=${encodeURIComponent('٠٧٧٠١٢٣')}`);
  assert.deepEqual(byPhone.body.customers.map((c: { key: string }) => c.key), ['O-S1'], 'Arabic-Indic digits, spaces ignored');
  assert.ok(!JSON.stringify(byPhone.body).includes('4567'));
  assert.deepEqual((await call(raw, '?q=Najm', OWNER2)).body.customers, [], 'Omar is not zahra\'s customer');
  assert.equal((await call(raw, '?q=a')).body.code, 'SEARCH_QUERY_TOO_SHORT');
  assert.deepEqual((await call(raw, `?q=${encodeURIComponent('%_')}`)).body.customers, [], 'wildcards are literal');
});

test('one customer: this store\'s orders only (cancelled flagged, not counted), the phone as the store sees it', async () => {
  const raw = world();
  const { status, body } = await call(raw, '/O-S2'); // any of their orders here opens them
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.customer, {
    key: 'O-S1',
    name: 'Sara Ahmed',
    order_count: 2,
    spent_iqd: 40000,
    cancelled_count: 1,
    average_order_iqd: 20000,
    first_order_at: '2026-09-01T10:00:00.000Z',
    last_order_at: '2026-09-05T10:00:00.000Z',
    returning: true,
    governorate: 'baghdad',
    // The latest order here is the cancelled O-S3 — its address has no phone, so the account's (none) — absent.
  });
  assert.deepEqual(body.orders.map((o: { id: string; status: string }) => [o.id, o.status]), [
    ['O-S3', 'cancelled'],
    ['O-S2', 'delivered'],
    ['O-S1', 'delivered'],
  ]);
  assert.ok(!JSON.stringify(body).includes('Z-1'), 'the other store\'s order is not theirs to see');
  raw.exec(`UPDATE orders SET address_snapshot = '{"governorate":"erbil","phone":"0770 123 4567"}' WHERE id = 'O-S3'`);
  assert.equal((await call(raw, '/O-S1')).body.customer.phone, '0770 123 4567');
});

test('isolation: another store\'s order as a key, a made-up key, a shape outside the contract — one 404', async () => {
  const raw = world();
  for (const [key, user] of [['Z-1', OWNER], ['O-S1', OWNER2], ['NOPE', OWNER], ['a%20b', OWNER]] as const) {
    const r = await call(raw, `/${key}`, user);
    assert.deepEqual([r.status, r.body.code], [404, 'CUSTOMER_NOT_FOUND'], `${key}`);
  }
  // Someone whose only order here was cancelled is not a customer, but their order still resolves.
  const ghost = await call(raw, '/O-G1');
  assert.deepEqual([ghost.body.customer.order_count, 'average_order_iqd' in ghost.body.customer, ghost.body.customer.key], [0, false, 'O-G1']);
});

test('the customer\'s orders page by (created_at, id)', async () => {
  const raw = world();
  for (let i = 0; i < 25; i++) addOrder(raw, { id: `O-B${String(i).padStart(2, '0')}`, user: 'buyer2', at: '2026-09-10T10:00:00.000Z' });
  const first = await call(raw, '/O-O1');
  assert.equal(first.body.orders.length, 20);
  const second = await call(raw, `/O-O1?cursor=${encodeURIComponent(first.body.next_cursor)}`);
  const ids = [...first.body.orders, ...second.body.orders].map((o: { id: string }) => o.id);
  assert.equal(ids.length, 26);
  assert.equal(new Set(ids).size, 26);
  assert.equal(second.body.next_cursor, null);
});

test('parseKeyset refuses what it cannot read instead of starting over', () => {
  assert.deepEqual(parseKeyset(undefined), { at: '', id: '' });
  assert.deepEqual(parseKeyset('2026-09-01T10:00:00.000Z|O-1'), { at: '2026-09-01T10:00:00.000Z', id: 'O-1' });
  assert.equal(parseKeyset('|O-1'), null);
  assert.equal(parseKeyset("2026-09-01T10:00:00.000Z|x' OR 1"), null);
  assert.equal(parseKeyset('nonsense|O-1'), null);
});
