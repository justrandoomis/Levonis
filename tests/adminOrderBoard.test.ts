/**
 * THE ORDER BOARD, AGAINST A REAL DATABASE.
 *
 * Everything here runs the actual route over real SQLite with every migration
 * applied — real CHECK constraints, the real partial index, the real JSON
 * functions. Nothing is mocked, because every defect pinned below is a defect
 * IN THE SQL and a mock of the SQL would agree with whatever it was written
 * to agree with.
 *
 * WHAT EACH GROUP IS HERE TO CATCH, all of them silent in production:
 *
 *  (أ) THE ORDERING. The owner's sentence — «إذا كان طلب مباشر لكن طلب المستخدم
 *      التوصيل بعد ثلاثة أيام يتم تأجيله لليوم الثالث … ومن يأتي دوره في التسليم
 *      حتى يصل غدا يأتي دوره ويثبت في الاعلى» — is a two-row assertion: a PRO
 *      order due in thirty days sits BELOW a normal order due tomorrow, and a
 *      PRO order due tomorrow sits ABOVE a normal one due tomorrow. An
 *      implementation that keeps PRO as an absolute pin passes the second and
 *      fails the first, and the screen looks perfectly reasonable either way.
 *
 *  (ب) THE COUNT'S `users` JOIN. The count query used to be `FROM orders o`
 *      with no join while the row query joined `users`. A name search then
 *      fails the COUNT with `no such column: u.name`, and because the two run
 *      in one `Promise.all` the whole screen goes down — but ONLY once somebody
 *      actually types a name, which is why it would have shipped.
 *
 *  (ج) THE UNIQUE FINAL SORT KEY. With thirty-row pages and equal `created_at`,
 *      a sort with no total order lets SQLite return a row on two pages or on
 *      none. Nobody reads page two closely enough to notice a missing order.
 *
 *  (د) THE DAY BOUNDARY. Between 00:00 and 03:00 Baghdad, a UTC-derived
 *      "today" is yesterday — and that is the shift when the day's runs are
 *      planned. The clock is pinned inside that window on purpose.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshDb, asD1, stubApp, get, json, row } from './fixtures/app';
import { ROOT } from './fixtures/d1';
import { adminRoutes } from '../worker/routes/admin';

// 13:00 in Baghdad on the nineteenth — a plain, unambiguous afternoon.
const NOON = '2026-09-19T10:00:00.000Z';
// 01:00 in Baghdad on the NINETEENTH, and the eighteenth in UTC. The window.
const AFTER_MIDNIGHT = '2026-09-18T22:00:00.000Z';

const TODAY = '2026-09-19';
const TOMORROW = '2026-09-20';

/** Runs `fn` with the server's clock pinned. The route reads `Date.now()`. */
/**
 * Runs `fn` with the clock pinned, which is the only way to test a board whose
 * whole ordering is "which Baghdad day is it".
 *
 * `T | Promise<T>` rather than `Promise<T>`: `app.request` is typed
 * `Response | Promise<Response>` because Hono may answer synchronously, and a
 * helper whose job is to hold the clock has no business caring which. The
 * `await` below handles both.
 */
async function at<T>(iso: string, fn: () => T | Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => Date.parse(iso);
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

interface OrderSeed {
  id: string;
  user?: string;
  status?: string;
  day?: string | null;
  priority?: number;
  created_at?: string;
  shipping_type?: string;
  seller_type?: string;
  snapshot?: string;
}

function seed(orders: OrderSeed[], users: [string, string, string | null][] = [['u1', 'زبون', null]]) {
  const raw = freshDb();
  for (const [id, name, phone] of users) {
    raw
      .prepare("INSERT INTO users (id,name,email,password_hash,role,phone_e164) VALUES (?,?,?,'h','customer',?)")
      .run(id, name, `${id}@x.co`, phone);
  }
  raw
    .prepare("INSERT INTO users (id,name,email,password_hash,role,admin_scope) VALUES ('boss','Owner','boss@x.co','h','admin',NULL)")
    .run();
  for (const o of orders) {
    raw
      .prepare(
        `INSERT INTO orders
           (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
            subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,created_at,
            priority,shipping_type,seller_type,delivery_due_day)
         VALUES (?,?,?,?,'home','{}','cod',1000,1500,1000,1000,?,?,?,?,?)`
      )
      .run(
        o.id,
        o.user ?? 'u1',
        o.status ?? 'pending',
        o.snapshot ?? JSON.stringify({ name: 'محمد الساعدي', phone: '+9647801112233', governorate: 'بغداد' }),
        o.created_at ?? '2026-09-15T08:00:00.000Z',
        o.priority ?? 0,
        o.shipping_type ?? 'direct',
        o.seller_type ?? 'levonis',
        o.day === undefined ? null : o.day
      );
  }
  const app = stubApp(
    asD1(raw),
    { id: 'boss', role: 'admin', email: 'boss@x.co', admin_scope: null },
    (a) => a.route('/api/admin', adminRoutes),
    { env: { INITIAL_ADMIN_EMAIL: 'boss@x.co' } }
  );
  return { raw, app };
}

const board = async (app: ReturnType<typeof seed>['app'], qs = '') => {
  const res = await get(app, `/api/admin/orders${qs ? `?${qs}` : ''}`);
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body).slice(0, 400));
  return body;
};
const ids = (body: Record<string, unknown>) => (body.orders as { id: string }[]).map((o) => o.id);

// =========================================================================
// (أ) THE ORDERING — PRO IS PINNED BY THE DUE DAY, NOT ABOVE THE CALENDAR
// =========================================================================

test('(أ) a PRO order due in thirty days sits BELOW a normal one due tomorrow — and ABOVE it when its day is the same', async () => {
  const { app } = seed([
    { id: 'ORD-AAAA000001', day: TOMORROW, priority: 0, created_at: '2026-09-16T08:00:00.000Z' },
    { id: 'ORD-BBBB000002', day: TOMORROW, priority: 1, created_at: '2026-09-19T09:59:00.000Z' },
    { id: 'ORD-CCCC000003', day: '2026-10-19', priority: 1, created_at: '2026-09-10T08:00:00.000Z' },
    { id: 'ORD-DDDD000004', day: TODAY, priority: 0, created_at: '2026-09-18T08:00:00.000Z' },
  ]);
  const order = ids(await at(NOON, () => board(app)));

  // THE PAIR THAT IS DECISION (أ):
  assert.ok(
    order.indexOf('ORD-CCCC000003') > order.indexOf('ORD-AAAA000001'),
    'a PRO order due in thirty days must NOT be pinned above tomorrow\'s work'
  );
  assert.ok(
    order.indexOf('ORD-BBBB000002') < order.indexOf('ORD-AAAA000001'),
    'and INSIDE a day, PRO still comes first — «يثبت في الاعلى»'
  );
  // The whole board, in the one order the owner described.
  assert.deepEqual(order, ['ORD-DDDD000004', 'ORD-BBBB000002', 'ORD-AAAA000001', 'ORD-CCCC000003']);
});

test('(أ) an unscheduled order falls to the TAIL, and overdue rises to the head', async () => {
  const { app } = seed([
    { id: 'ORD-0000000001', day: null },
    { id: 'ORD-0000000002', day: '2026-09-17' }, // two days late
    { id: 'ORD-0000000003', day: TODAY },
  ]);
  const body = await at(NOON, () => board(app));
  assert.deepEqual(ids(body), ['ORD-0000000002', 'ORD-0000000003', 'ORD-0000000001']);
  // «a day we know beats a day we do not», and overdue sorts first with no
  // special case at all — it simply has the smallest key.
  const rows = body.orders as { id: string; due_bucket: string }[];
  assert.equal(rows[0].due_bucket, 'overdue');
  assert.equal(rows[2].due_bucket, 'unscheduled');
});

test('(أ) normal orders are OLDEST first — the old sort sank a three-day-old order below one placed a minute ago', async () => {
  const { app } = seed([
    { id: 'ORD-NEW0000001', day: TOMORROW, created_at: '2026-09-19T09:59:00.000Z' },
    { id: 'ORD-OLD0000002', day: TOMORROW, created_at: '2026-09-16T08:00:00.000Z' },
  ]);
  assert.deepEqual(
    ids(await at(NOON, () => board(app))),
    ['ORD-OLD0000002', 'ORD-NEW0000001'],
    'in a PREPARATION queue, newest-first is backwards'
  );
});

// =========================================================================
// (ج) A TOTAL ORDER, SO PAGING CANNOT REPEAT OR DROP A ROW
// =========================================================================

test('(ج) paging is stable across two pages when created_at ties', async () => {
  // Identical in every sort key but the last one: same day (none), same
  // priority, same `created_at` to the millisecond — which is what a bulk
  // import or a fast afternoon produces.
  const tie = '2026-09-18T08:00:00.000Z';
  const { app } = seed(
    ['ORD-T000000001', 'ORD-T000000002', 'ORD-T000000003', 'ORD-T000000004'].map((id) => ({
      id,
      day: null,
      created_at: tie,
    }))
  );
  const first = ids(await at(NOON, () => board(app, 'limit=2&offset=0')));
  const second = ids(await at(NOON, () => board(app, 'limit=2&offset=2')));
  const seen = [...first, ...second];
  assert.equal(new Set(seen).size, 4, 'a row appeared twice, or not at all — the classic missing-order bug');
  assert.deepEqual([...seen].sort(), ['ORD-T000000001', 'ORD-T000000002', 'ORD-T000000003', 'ORD-T000000004']);
  // And the order is repeatable, which is the other half of "stable".
  assert.deepEqual(ids(await at(NOON, () => board(app, 'limit=2&offset=0'))), first);
});

// =========================================================================
// THE FROZEN PRO FLAG — the board may not reorder while somebody is packing
// =========================================================================

test('flipping users.membership_tier does not move a single row', async () => {
  const { app, raw } = seed(
    [
      { id: 'ORD-P000000001', user: 'lapsed', day: TOMORROW, priority: 1 },
      { id: 'ORD-P000000002', user: 'plain', day: TOMORROW, priority: 0 },
    ],
    [
      ['lapsed', 'زبون برو سابق', null],
      ['plain', 'زبون عادي', null],
    ]
  );
  const before = ids(await at(NOON, () => board(app)));

  // `users.membership_tier` is a LAZY CACHE, written only when `getTierStatus`
  // happens to run for that user — so a lapsed PRO who has not been touched
  // still reads 'pro', and a renewed one may still read 'free'. Sorting on it
  // would make the board reorder between two refreshes while somebody is
  // holding a picking list, which is how a picked order goes missing.
  // `orders.priority` is the frozen answer: what this order PAID for.
  raw.prepare("UPDATE users SET membership_tier = 'pro' WHERE id = 'plain'").run();
  raw.prepare("UPDATE users SET membership_tier = 'free' WHERE id = 'lapsed'").run();

  assert.deepEqual(ids(await at(NOON, () => board(app))), before, 'the board moved because a cache column moved');
  assert.equal(row<{ v: string }>(raw, "SELECT membership_tier v FROM users WHERE id='plain'")?.v, 'pro');
});

// =========================================================================
// SCOPES — «الطلبات الملغية والطلبات التي تم توصيلها يتم عزلها»
// =========================================================================

test('the default scope hides delivered and cancelled from the ROWS and from `total`', async () => {
  const { app } = seed([
    { id: 'ORD-S000000001', day: TODAY },
    { id: 'ORD-S000000002', status: 'delivered', day: TODAY },
    { id: 'ORD-S000000003', status: 'cancelled', day: TODAY },
  ]);
  const body = await at(NOON, () => board(app));
  assert.deepEqual(ids(body), ['ORD-S000000001']);
  // The total is the count of the SAME query. A total that still said 3 would
  // render a pager over rows that are not there.
  assert.equal(body.total, 1, 'the COUNT must carry the scope, not just the page');
  assert.equal(body.scope, 'open');

  const delivered = await at(NOON, () => board(app, 'scope=delivered'));
  assert.deepEqual(ids(delivered), ['ORD-S000000002']);
  assert.equal(delivered.total, 1);
  const cancelled = await at(NOON, () => board(app, 'scope=cancelled'));
  assert.deepEqual(ids(cancelled), ['ORD-S000000003']);
});

test('pre-orders are their own SCOPE, not a bucket in among today\'s work', async () => {
  const { app } = seed([
    { id: 'ORD-D000000001', day: TODAY },
    { id: 'ORD-A000000002', shipping_type: 'preorder_air', day: '2026-10-29' },
    { id: 'ORD-M000000003', shipping_type: 'preorder_sea', day: null },
  ]);
  assert.deepEqual(ids(await at(NOON, () => board(app))), ['ORD-D000000001'], '«فصلها في الطلبات المسبقة»');
  assert.deepEqual(ids(await at(NOON, () => board(app, 'scope=preorder'))), ['ORD-A000000002', 'ORD-M000000003']);
  // `type` narrows orthogonally, inside whichever scope is in force.
  assert.deepEqual(ids(await at(NOON, () => board(app, 'scope=preorder&type=preorder_sea'))), ['ORD-M000000003']);
});

test('a merchant order is BADGED, and cannot inflate a due count — it has no day to be due on', async () => {
  const { app } = seed([
    { id: 'ORD-L000000001', day: TODAY },
    { id: 'ORD-R000000002', seller_type: 'merchant', day: null },
  ]);
  const body = await at(NOON, () => board(app));
  const rows = body.orders as { id: string; seller_type: string; due_bucket: string }[];
  assert.equal(rows.find((r) => r.id === 'ORD-R000000002')?.seller_type, 'merchant', 'the badge the screen needs');
  // Merchant orders never pass through platform checkout, so migration 0094's
  // DEFAULT leaves their day NULL — they sort to the tail and land in
  // `unscheduled`, never in «due today».
  assert.equal(rows.find((r) => r.id === 'ORD-R000000002')?.due_bucket, 'unscheduled');
  assert.equal((body.counts as Record<string, number>).today, 1, 'one of ours, and not the merchant\'s');
  assert.equal(rows.at(-1)?.id, 'ORD-R000000002');
});

test('`status` still narrows inside the open scope, and still selects the isolated scopes on its own', async () => {
  const { app } = seed([
    { id: 'ORD-K000000001', status: 'pending', day: TODAY },
    { id: 'ORD-K000000002', status: 'processing', day: TODAY },
    { id: 'ORD-K000000003', status: 'delivered', day: TODAY },
  ]);
  // The shape the browser probes and every existing link already send.
  assert.deepEqual(ids(await at(NOON, () => board(app, 'status=pending&limit=50'))), ['ORD-K000000001']);
  // And the one the existing screen's dropdown sends, which under a naive
  // reading would be "open orders which are delivered" — an empty screen, 200,
  // no error, for a filter that worked the day before.
  assert.deepEqual(ids(await at(NOON, () => board(app, 'status=delivered'))), ['ORD-K000000003']);
  // An explicit scope always wins over that compatibility rule.
  assert.deepEqual(ids(await at(NOON, () => board(app, 'scope=open&status=delivered'))), []);
});

test('a bad parameter is a 400 with a message, not a silently empty board', async () => {
  const { app } = seed([{ id: 'ORD-V000000001', day: TODAY }]);
  for (const qs of ['scope=everything', 'due=someday', 'type=teleport']) {
    const res = await at(NOON, () => get(app, `/api/admin/orders?${qs}`));
    assert.equal(res.status, 400, qs);
  }
});

// =========================================================================
// (د) THE DAY BOUNDARY, AND THE BUCKETS COMPUTED ON THE SERVER
// =========================================================================

test('(د) «today» is the BAGHDAD day, asserted at 22:00 UTC', async () => {
  const { app } = seed([
    { id: 'ORD-N000000001', day: '2026-09-19' },
    { id: 'ORD-N000000002', day: '2026-09-20' },
  ]);
  const body = await at(AFTER_MIDNIGHT, () => board(app));
  assert.equal(body.today, '2026-09-19', '01:00 Baghdad on the nineteenth is 22:00 UTC on the eighteenth');
  assert.notEqual(body.today, '2026-09-18', 'a UTC-derived today lags by one for these three hours');
  assert.equal(body.tomorrow, '2026-09-20');
  assert.equal(body.week_end, '2026-09-26');

  const rows = body.orders as { id: string; due_bucket: string; due_label: string }[];
  const nineteenth = rows.find((r) => r.id === 'ORD-N000000001')!;
  assert.equal(nineteenth.due_bucket, 'today', 'a UTC-derived bucket would read `tomorrow` here');
  assert.equal(nineteenth.due_label, 'اليوم');
  assert.equal(rows.find((r) => r.id === 'ORD-N000000002')!.due_bucket, 'tomorrow');

  // And the filter agrees with the bucket, because both came from one clock.
  assert.deepEqual(ids(await at(AFTER_MIDNIGHT, () => board(app, 'due=today'))), ['ORD-N000000001']);
});

test('the counts ride inside the COUNT that already runs, and cover every bucket', async () => {
  const { app } = seed([
    { id: 'ORD-C000000001', day: '2026-09-17' }, // overdue
    { id: 'ORD-C000000002', day: TODAY },
    { id: 'ORD-C000000003', day: TOMORROW },
    { id: 'ORD-C000000004', day: '2026-09-24' }, // this week
    { id: 'ORD-C000000005', day: '2026-11-01' }, // later
    { id: 'ORD-C000000006', day: null },
    { id: 'ORD-C000000007', status: 'delivered', day: TODAY },
  ]);
  const body = await at(NOON, () => board(app));
  assert.deepEqual(body.counts, {
    total: 6,
    overdue: 1,
    today: 1,
    tomorrow: 1,
    week: 1,
    later: 1,
    unscheduled: 1,
  });
  // `due=today` INCLUDES the overdue row: a box that should have gone on
  // Tuesday is not a different kind of work on Wednesday, it is the most
  // urgent part of it. `overdue` is still counted separately so a header can
  // say how much of today is late.
  assert.deepEqual(ids(await at(NOON, () => board(app, 'due=today'))), ['ORD-C000000001', 'ORD-C000000002']);
  assert.deepEqual(ids(await at(NOON, () => board(app, 'due=week'))), ['ORD-C000000004']);
  assert.deepEqual(ids(await at(NOON, () => board(app, 'due=later'))), ['ORD-C000000005']);
  assert.deepEqual(ids(await at(NOON, () => board(app, 'due=unscheduled'))), ['ORD-C000000006']);
});

test('the projection carries the day, when it moved, and what packing a box needs', async () => {
  const { app, raw } = seed([{ id: 'ORD-J000000001', day: TOMORROW }], [['u1', 'أحمد الخفاجي', '+9647801112233']]);
  raw.prepare("UPDATE orders SET delivery_day_changed_at = '2026-09-18T11:00:00.000Z'").run();
  const rowOut = (await at(NOON, () => board(app))).orders[0] as Record<string, unknown>;
  assert.equal(rowOut.delivery_due_day, TOMORROW);
  assert.equal(rowOut.delivery_day_changed_at, '2026-09-18T11:00:00.000Z');
  assert.equal(rowOut.due_bucket, 'tomorrow');
  assert.equal(rowOut.due_label, 'غدًا');
  assert.equal(rowOut.customer_name, 'أحمد الخفاجي');
  // The parcel goes to the name and the governorate on the ADDRESS, which may
  // be a different person from the account holder — a gift, or an office.
  const address = rowOut.address as Record<string, unknown>;
  assert.equal(address.name, 'محمد الساعدي');
  assert.equal(address.governorate, 'بغداد');
});

// =========================================================================
// (ب) THE SEARCH — AND THE JOIN THE COUNT MUST HAVE
// =========================================================================

test('(ب) a NAME search does not take the screen down: the COUNT joins `users` too', async () => {
  const { app } = seed(
    [
      { id: 'ORD-Q000000001', user: 'ahmed', day: TODAY },
      { id: 'ORD-Q000000002', user: 'other', day: TODAY },
    ],
    [
      ['ahmed', 'أحمد الخفاجي', null],
      ['other', 'سارة', null],
    ]
  );
  const body = await at(NOON, () => board(app, 'q=%D8%A7%D8%AD%D9%85%D8%AF')); // «احمد», no hamza
  assert.deepEqual(ids(body), ['ORD-Q000000001'], 'the fold makes «احمد» find «أحمد»');
  // THE ASSERTION THIS TEST EXISTS FOR. Before the join, the COUNT threw
  // `no such column: u.name` and the Promise.all rejected — a 500 on the whole
  // board, the first time anybody typed a name.
  assert.equal(body.total, 1, 'the COUNT ran the same WHERE, over the same JOIN');
  assert.equal(body.search_kind, 'name');
  assert.equal((body.search as Record<string, unknown>).pierced, false);
});

test('(ب) the DELIVERY name in the snapshot is searched too, and the fold covers ta marbuta', async () => {
  const { app } = seed(
    [
      {
        id: 'ORD-Q100000001',
        snapshot: JSON.stringify({ name: 'فاطمة عبد الله', phone: '+9647801112233', governorate: 'البصرة' }),
        day: TODAY,
      },
      { id: 'ORD-Q100000002', day: TODAY },
    ],
    [['u1', 'حساب الشركة', null]]
  );
  // «فاطمه» with ha, against «فاطمة» with ta marbuta, stored inside JSON.
  const body = await at(NOON, () => board(app, `q=${encodeURIComponent('فاطمه')}`));
  assert.deepEqual(ids(body), ['ORD-Q100000001']);
  assert.equal(body.total, 1);
});

test('(ب) a malformed address_snapshot does not throw — json_extract over non-JSON kills the statement', async () => {
  const { app } = seed([
    { id: 'ORD-X000000001', snapshot: 'this is not JSON at all', day: TODAY },
    { id: 'ORD-X000000002', snapshot: '', day: TODAY },
    { id: 'ORD-X000000003', day: TODAY },
  ]);
  // The plain board first: every existing reader parses this column in
  // TypeScript with `safeParse`, so it has always tolerated a bad row.
  assert.equal((await at(NOON, () => board(app))).total, 3);
  // And now with the predicate that reaches INTO the column. Unguarded, one
  // bad row out of thirty takes the entire admin screen down.
  const named = await at(NOON, () => board(app, `q=${encodeURIComponent('محمد')}`));
  assert.deepEqual(ids(named), ['ORD-X000000003']);
  const phoned = await at(NOON, () => board(app, 'q=07801112233'));
  assert.deepEqual(ids(phoned), ['ORD-X000000003']);
});

test('(ب) a legacy and a modern phone shape are both found by `07701234567`', async () => {
  const { app } = seed(
    [
      {
        id: 'ORD-H000000001',
        user: 'old',
        status: 'delivered', // and finished, to prove the search pierces
        snapshot: JSON.stringify({ name: 'قديم', phone: '+964-0770 123 4567', governorate: 'نينوى' }),
        day: '2026-08-01',
      },
      {
        id: 'ORD-H000000002',
        user: 'now',
        snapshot: JSON.stringify({ name: 'حديث', phone: '+9647701234567', governorate: 'بغداد' }),
        day: TODAY,
      },
      { id: 'ORD-H000000003', user: 'now', day: TODAY },
    ],
    [
      ['old', 'زبون قديم', null],
      ['now', 'زبون حالي', '+9647701234567'],
    ]
  );
  const body = await at(NOON, () => board(app, 'q=07701234567'));
  assert.equal(body.search_kind, 'phone');
  const found = ids(body).sort();
  assert.ok(found.includes('ORD-H000000001'), 'the legacy `+964-0770 123 4567` snapshot must still be found');
  assert.ok(found.includes('ORD-H000000002'), 'and the modern `+9647701234567` one');
  // The third order belongs to the same ACCOUNT, whose `phone_e164` matches,
  // so it is found by the identity key rather than the snapshot suffix.
  assert.equal(body.total, found.length);
});

test('(ب) an id or phone lookup PIERCES the board; a name or date search respects it', async () => {
  const { app } = seed([
    { id: 'ORD-DEAD000001', status: 'cancelled', day: '2026-08-02' },
    { id: 'ORD-DEAD000002', day: TODAY },
  ]);
  // Looking a finished order up by its number is most of why an admin
  // searches at all. Hiding it would answer "no such order".
  const byId = await at(NOON, () => board(app, 'q=ORD-DEAD0000'));
  assert.equal(byId.search_kind, 'order_id');
  assert.equal((byId.search as Record<string, unknown>).pierced, true);
  assert.deepEqual(ids(byId).sort(), ['ORD-DEAD000001', 'ORD-DEAD000002']);

  // A name search is browsing, so the cancelled order stays isolated.
  const byName = await at(NOON, () => board(app, `q=${encodeURIComponent('محمد')}`));
  assert.equal((byName.search as Record<string, unknown>).pierced, false);
  assert.deepEqual(ids(byName), ['ORD-DEAD000002']);
});

test('(ب) a DATE search is a Baghdad civil day, not ten characters of `created_at`', async () => {
  const { app } = seed([
    // 01:00 Baghdad on the nineteenth. `created_at.slice(0,10)` says the 18th.
    { id: 'ORD-Y000000001', created_at: '2026-09-18T22:00:00.000Z', day: TODAY },
    // 20:00 Baghdad on the eighteenth.
    { id: 'ORD-Y000000002', created_at: '2026-09-18T17:00:00.000Z', day: TODAY },
  ]);
  const nineteenth = await at(NOON, () => board(app, 'q=19-9'));
  assert.equal(nineteenth.search_kind, 'date');
  assert.deepEqual(ids(nineteenth), ['ORD-Y000000001'], 'the order placed just after midnight belongs to the 19th');
  assert.deepEqual(ids(await at(NOON, () => board(app, 'q=18-9'))), ['ORD-Y000000002']);

  // And the ambiguous reading is reported rather than silently OR-ed in.
  const ambiguous = await at(NOON, () => board(app, 'q=5-9'));
  const date = (ambiguous.search as { date: Record<string, unknown> }).date;
  assert.equal(date.assumed_day_first, true);
  assert.equal(date.flip_day, '2026-05-09');
});

test('(ب) THE SEARCH FILTERS, IT NEVER RE-RANKS', async () => {
  // Three orders that all match the name, whose correct order is decided by
  // the day and nothing else. A search that re-ranked — by match quality, by
  // recency, by anything — would quietly override the whole ordering this
  // board exists for.
  const { app } = seed(
    [
      { id: 'ORD-W000000001', day: '2026-10-19', priority: 1 },
      { id: 'ORD-W000000002', day: TODAY, priority: 0 },
      { id: 'ORD-W000000003', day: TOMORROW, priority: 1 },
    ],
    [['u1', 'أحمد الخفاجي', null]]
  );
  const plain = ids(await at(NOON, () => board(app)));
  const searched = ids(await at(NOON, () => board(app, `q=${encodeURIComponent('احمد')}`)));
  assert.deepEqual(searched, plain, 'the clause belongs in the WHERE; the ORDER BY is left exactly as it is');
  assert.deepEqual(searched, ['ORD-W000000002', 'ORD-W000000003', 'ORD-W000000001']);
});

// =========================================================================
// THE PARTIAL INDEX THE BOARD READS THROUGH
// =========================================================================

test('the open scope actually READS THROUGH the partial index, both branches', () => {
  // The claim migration 0094 makes is not about the SQL text, it is about the
  // plan — and the failure mode it names is that the plan still says "USING
  // INDEX" while using the WRONG one. So this asserts the index BY NAME.
  const raw: DatabaseSync = freshDb();
  const ORDER = `ORDER BY o.delivery_due_day IS NULL, o.delivery_due_day ASC, o.priority DESC,
    (o.priority_due_at IS NULL), o.priority_due_at ASC, o.created_at ASC, o.id ASC LIMIT 30 OFFSET 0`;
  const plan = (where: string) =>
    (
      raw
        .prepare(
          `EXPLAIN QUERY PLAN SELECT o.*, u.email FROM orders o LEFT JOIN users u ON u.id = o.user_id
             WHERE ${where} ${ORDER}`
        )
        .all() as { detail: string }[]
    )
      .map((r) => r.detail)
      .join(' | ');

  const OPEN = "(o.status NOT IN ('delivered','cancelled'))";
  for (const [label, scoped] of [
    ['open', `${OPEN} AND (+o.shipping_type = 'direct')`],
    ['preorder', `${OPEN} AND (+o.shipping_type <> 'direct')`],
  ] as const) {
    assert.match(plan(scoped), /idx_orders_board_open/, `scope=${label} lost the board's partial index`);
  }

  // AND THE TWO WAYS TO LOSE IT, both of which still read "USING INDEX" and
  // therefore look perfectly healthy in an EXPLAIN nobody reads closely.
  assert.doesNotMatch(
    plan(`${OPEN} AND (o.shipping_type = 'direct')`),
    /idx_orders_board_open/,
    'without the `+`, the planner takes idx_orders_shipping_type instead — this is why the `+` is there'
  );
  assert.doesNotMatch(
    plan(`(o.status IN ('pending','confirmed','processing','shipped')) AND (+o.shipping_type = 'direct')`),
    /idx_orders_board_open/,
    'and the positive rewrite of the status predicate costs it too — a partial index is matched on TEXT'
  );
  raw.close();
});

test('the open scope emits the index\'s own WHERE verbatim, so the planner can use it', () => {
  const raw: DatabaseSync = freshDb();
  const src = raw.prepare("SELECT sql FROM sqlite_master WHERE name='idx_orders_board_open'").get() as { sql: string };
  assert.ok(src.sql.includes("status NOT IN ('delivered','cancelled')"));
  // The route's literal, character for character. If anybody "tidies" the
  // route's clause into the equivalent positive form, this fails here rather
  // than nine seconds at a time on a live admin screen.
  const route = readFileSync(join(ROOT, 'worker', 'routes', 'admin.ts'), 'utf8');
  assert.ok(
    route.includes(`clauses.push("o.status NOT IN ('delivered','cancelled')")`),
    'the board query must carry the partial index\'s WHERE verbatim — see migrations/0094'
  );
  assert.ok(
    route.includes(`"+o.shipping_type = 'direct'"`),
    'and the `+` that keeps the planner on it — see the block comment at that line'
  );
  raw.close();
});
