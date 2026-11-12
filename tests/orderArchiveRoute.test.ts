/**
 * THE COMPLETED ORDERS, NEWEST OR OLDEST FIRST — «completed orders should have
 * a filter, latest or oldest first» (owner, 2026-11-11; DECISIONS row 323).
 *
 * The real route over real SQLite with every migration applied and the clock
 * pinned, as tests/adminOrderBoard.test.ts does. What each group pins:
 *
 *   THE ORDER     the archive sorts by when each order was FINISHED —
 *                 `delivered_at` for «تم التسليم», `cancelled_at` for «ملغاة» —
 *                 newest first by default, oldest first on `sort=oldest` (the
 *                 exact reverse), the id breaking ties the same way, and a row
 *                 with no time (NULL or '') as the oldest; never by the due day
 *                 or by when the order was placed. `cancelled_at` is set
 *                 EXPLICITLY here: migration 0081's insert trigger would stamp
 *                 SQLite's wall clock, not the pinned one.
 *   THE PAGES     paging two at a time reads every row once, and the owner's
 *                 symptom is gone: with 65 deliveries the latest is row one of
 *                 page one (it was the last row of page three).
 *   THE LIVE HALF `sort` is ignored there and echoed as null: the same rows in
 *                 the same order, the same statements word for word, still on
 *                 idx_orders_board_open. A pierced lookup keeps the work list's
 *                 order from either half.
 *   THE ROWS      `done_label` («اليوم», «الثلاثاء ١٠ تشرين الثاني», the year
 *                 when not this year) in three languages, across the Baghdad
 *                 midnight; `cancelled_at` on the row.
 *   THE PLANS     the archive's rows statement, as the route ran it: SEARCHed
 *                 by status, never a SCAN; the cancelled half in its index's
 *                 order, sorting only the id.
 *   THE INPUT     a bad `sort` is a 400 on every scope.
 *
 * Run: node --import tsx --test tests/orderArchiveRoute.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshDb, stubApp, get, json } from './fixtures/app';
import { ROOT, SqliteD1, type SqliteStatement } from './fixtures/d1';
import { adminRoutes, BOARD_ORDER_SQL } from '../worker/routes/admin';

// 13:00 in Baghdad on Wednesday 11 November 2026.
const NOON = '2026-11-11T10:00:00.000Z';

async function at<T>(iso: string, fn: () => T | Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => Date.parse(iso);
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

type Status = 'pending' | 'confirmed' | 'processing' | 'shipped' | 'delivered' | 'cancelled';
const STAGE_OF: Record<Status, string> = {
  pending: 'received',
  confirmed: 'confirmed',
  processing: 'preparing',
  shipped: 'out_for_delivery',
  delivered: 'delivered',
  cancelled: 'cancelled',
};

interface Seed {
  id: string;
  status: Status;
  day?: string | null;
  /** NULL unless said. */
  delivered_at?: string | null;
  /** Explicit for a cancelled row; `null` is written AFTER the insert (the 0081 insert trigger stamps a NULL with the wall clock). */
  cancelled_at?: string | null;
  created_at?: string;
  priority?: number;
  type?: string;
}

/** Records every statement the route runs, with its binds, so its plans can be EXPLAINed as run. */
class RecordingD1 {
  readonly seen: Array<{ sql: string; binds: unknown[] }> = [];
  private readonly inner: SqliteD1;
  constructor(raw: DatabaseSync) {
    this.inner = new SqliteD1(raw);
  }
  private wrap(st: SqliteStatement, binds: unknown[]): SqliteStatement {
    const seen = this.seen;
    return {
      sql: st.sql,
      get yieldsRows() {
        return st.yieldsRows;
      },
      bind: (...v: unknown[]) => this.wrap(st.bind(...v), v),
      run: () => (seen.push({ sql: st.sql, binds }), st.run()),
      first: <T>() => (seen.push({ sql: st.sql, binds }), st.first<T>()),
      all: <T>() => (seen.push({ sql: st.sql, binds }), st.all<T>()),
    } as unknown as SqliteStatement;
  }
  prepare(sql: string): SqliteStatement {
    return this.wrap(this.inner.prepare(sql), []);
  }
  batch(statements: SqliteStatement[]) {
    return this.inner.batch(statements);
  }
}

function seed(orders: Seed[]) {
  const raw = freshDb();
  raw.prepare("INSERT INTO users (id,name,email,password_hash,role) VALUES ('u1','زبون','u1@x.co','h','customer')").run();
  raw.prepare("INSERT INTO users (id,name,email,password_hash,role,admin_scope) VALUES ('boss','Owner','boss@x.co','h','admin',NULL)").run();
  const ins = raw.prepare(
    `INSERT INTO orders
       (id,user_id,status,stage,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
        subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,created_at,priority,shipping_type,seller_type,
        delivery_due_day,delivered_at,cancelled_at)
     VALUES (?,'u1',?,?,?,'standard','{}','cod',1000,1500,1000,1000,?,?,?,'levonis',?,?,?)`
  );
  for (const o of orders) {
    ins.run(
      o.id,
      o.status,
      STAGE_OF[o.status],
      JSON.stringify({ name: 'زبون', phone: '+9647801112233', governorate: 'baghdad' }),
      o.created_at ?? '2026-10-01T08:00:00.000Z',
      o.priority ?? 0,
      o.type ?? 'direct',
      o.day === undefined ? null : o.day,
      o.delivered_at ?? null,
      o.cancelled_at ?? null
    );
    if (o.status === 'cancelled' && o.cancelled_at === null) raw.prepare('UPDATE orders SET cancelled_at = NULL WHERE id = ?').run(o.id);
  }
  const db = new RecordingD1(raw);
  const app = stubApp(
    db as unknown as D1Database,
    { id: 'boss', role: 'admin', email: 'boss@x.co', admin_scope: null },
    (a) => a.route('/api/admin', adminRoutes),
    { env: { INITIAL_ADMIN_EMAIL: 'boss@x.co' } }
  );
  return { raw, app, db };
}

type Row = { id: string; status: string; done_label: string; cancelled_at: string | null; delivered_at: string | null; due_bucket: string };
type Board = { orders: Row[]; total: number; sort: string | null; scope: string; counts: Record<string, number> };

const board = async (app: ReturnType<typeof seed>['app'], qs = ''): Promise<Board> => {
  const query = /(^|&)limit=/.test(qs) ? qs : `limit=100${qs ? `&${qs}` : ''}`;
  const res = await at(NOON, () => get(app, `/api/admin/orders?${query}`));
  const body = await json(res);
  assert.equal(res.status, 200, `${qs}: ${JSON.stringify(body).slice(0, 400)}`);
  return body as unknown as Board;
};
const ids = (b: Board) => b.orders.map((o) => o.id);
const plan = (raw: DatabaseSync, sql: string, binds: unknown[]) =>
  (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(binds as never[])) as Array<{ detail: string }>).map((r) => r.detail).join(' | ');

// =========================================================================
// THE SEED — every time differs from the due-day order and from created_at
// =========================================================================

/** The delivered half. Newest first by `delivered_at`: the order of this list. */
const D = {
  TODAY: 'ORD-D0000001', //    10:00 today, due today
  NIGHT: 'ORD-D0000002', //    01:30 today in Baghdad (22:30Z the day before), no day
  EVE: 'ORD-D0000003', //      23:59 on the 10th in Baghdad, PRO, due the 10th
  TWODAYS: 'ORD-D0000004', //  the 9th
  SEA: 'ORD-D0000005', //      a sea pre-order placed in August, delivered on the 8th
  EARLY: 'ORD-D0000006', //    delivered on the 7th, before its own day (the 20th)
  TIE_A: 'ORD-D0000007', //    the 5th, the same instant as TIE_B
  TIE_B: 'ORD-D0000008',
  OLD: 'ORD-D0000009', //      October
  LASTYEAR: 'ORD-D000000A', // a year ago
  EMPTY: 'ORD-D000000B', //    '' (legacy)
  NONE: 'ORD-D000000C', //     NULL (legacy)
};
const C = {
  RECENT: 'ORD-C0000001', // cancelled this morning, placed first, due last
  MID: 'ORD-C0000002', //    placed last, due first
  EARLIER: 'ORD-C0000003',
  CLEARED: 'ORD-C0000004', // no cancelled_at (hand-cleared)
};
const L = { TOMORROW: 'ORD-A0000001', TODAY: 'ORD-A0000002', AIR: 'ORD-A0000003', COURIER: 'ORD-A0000004' };

const MAIN: Seed[] = [
  { id: D.TODAY, status: 'delivered', day: '2026-11-11', delivered_at: '2026-11-11T07:00:00.000Z', created_at: '2026-11-09T08:00:00.000Z' },
  { id: D.NIGHT, status: 'delivered', day: null, delivered_at: '2026-11-10T22:30:00.000Z', created_at: '2026-11-10T08:00:00.000Z' },
  { id: D.EVE, status: 'delivered', day: '2026-11-10', priority: 1, delivered_at: '2026-11-10T20:59:00.000Z', created_at: '2026-11-08T08:00:00.000Z' },
  { id: D.TWODAYS, status: 'delivered', day: '2026-11-09', delivered_at: '2026-11-09T08:00:00.000Z', created_at: '2026-11-07T08:00:00.000Z' },
  { id: D.SEA, status: 'delivered', type: 'preorder_sea', day: '2026-10-15', delivered_at: '2026-11-08T12:00:00.000Z', created_at: '2026-08-20T08:00:00.000Z' },
  { id: D.EARLY, status: 'delivered', day: '2026-11-20', delivered_at: '2026-11-07T10:00:00.000Z', created_at: '2026-11-06T08:00:00.000Z' },
  { id: D.TIE_A, status: 'delivered', day: '2026-11-05', delivered_at: '2026-11-05T09:00:00.000Z', created_at: '2026-11-03T08:00:00.000Z' },
  { id: D.TIE_B, status: 'delivered', day: '2026-11-04', delivered_at: '2026-11-05T09:00:00.000Z', created_at: '2026-11-02T08:00:00.000Z' },
  { id: D.OLD, status: 'delivered', day: '2026-10-03', delivered_at: '2026-10-04T09:00:00.000Z', created_at: '2026-10-01T08:00:00.000Z' },
  { id: D.LASTYEAR, status: 'delivered', day: '2025-11-09', delivered_at: '2025-11-10T09:00:00.000Z', created_at: '2025-11-08T08:00:00.000Z' },
  { id: D.EMPTY, status: 'delivered', day: '2026-09-01', delivered_at: '', created_at: '2026-08-30T08:00:00.000Z' },
  { id: D.NONE, status: 'delivered', day: '2026-09-02', delivered_at: null, created_at: '2026-08-31T08:00:00.000Z' },
  { id: C.RECENT, status: 'cancelled', day: '2026-11-20', cancelled_at: '2026-11-11T08:00:00.000Z', created_at: '2026-11-01T08:00:00.000Z' },
  { id: C.MID, status: 'cancelled', day: '2026-11-04', cancelled_at: '2026-11-09T08:00:00.000Z', created_at: '2026-11-03T08:00:00.000Z' },
  { id: C.EARLIER, status: 'cancelled', day: '2026-11-12', cancelled_at: '2026-11-05T08:00:00.000Z', created_at: '2026-11-02T08:00:00.000Z' },
  { id: C.CLEARED, status: 'cancelled', day: '2026-11-06', cancelled_at: null, created_at: '2026-11-04T08:00:00.000Z' },
  { id: L.TOMORROW, status: 'processing', day: '2026-11-12' },
  { id: L.TODAY, status: 'pending', day: '2026-11-11' },
  { id: L.AIR, status: 'confirmed', type: 'preorder_air', day: '2026-11-14' },
  { id: L.COURIER, status: 'shipped', day: '2026-11-11', created_at: '2026-10-02T08:00:00.000Z' },
];

const DELIVERED_NEWEST = [D.TODAY, D.NIGHT, D.EVE, D.TWODAYS, D.SEA, D.EARLY, D.TIE_B, D.TIE_A, D.OLD, D.LASTYEAR, D.EMPTY, D.NONE];
const CANCELLED_NEWEST = [C.RECENT, C.MID, C.EARLIER, C.CLEARED];

let main: ReturnType<typeof seed> | null = null;
const world = () => (main ??= seed(MAIN));

// =========================================================================
// THE ORDER
// =========================================================================

test('«تم التسليم»: newest delivery first by default, the exact reverse on sort=oldest — ties by id, no time as the oldest', async () => {
  const { app } = world();
  const byDefault = await board(app, 'scope=delivered');
  assert.deepEqual(ids(byDefault), DELIVERED_NEWEST);
  assert.equal(byDefault.sort, 'newest', 'the server says which order it applied');
  assert.equal(byDefault.total, DELIVERED_NEWEST.length);
  const newest = await board(app, 'scope=delivered&sort=newest');
  assert.deepEqual(ids(newest), DELIVERED_NEWEST);
  const oldest = await board(app, 'scope=delivered&sort=oldest');
  assert.deepEqual(ids(oldest), [...DELIVERED_NEWEST].reverse());
  assert.equal(oldest.sort, 'oldest');
  // The ties: the same instant, broken by the id in the same direction.
  assert.ok(ids(newest).indexOf(D.TIE_B) < ids(newest).indexOf(D.TIE_A));
  assert.ok(ids(oldest).indexOf(D.TIE_A) < ids(oldest).indexOf(D.TIE_B));
  // No completion time is the oldest: '' then NULL last newest-first, NULL then '' first oldest-first.
  assert.deepEqual(ids(newest).slice(-2), [D.EMPTY, D.NONE]);
  assert.deepEqual(ids(oldest).slice(0, 2), [D.NONE, D.EMPTY]);
  // Not the due day, which is what the archive used to sort by, and not the day it was placed.
  const { raw } = world();
  const dueDayOrder = (raw.prepare("SELECT id FROM orders o WHERE o.status = 'delivered' ORDER BY o.delivery_due_day IS NULL, o.delivery_due_day, o.id").all() as Array<{ id: string }>).map((r) => r.id);
  const placedOrder = (raw.prepare("SELECT id FROM orders o WHERE o.status = 'delivered' ORDER BY o.created_at DESC, o.id DESC").all() as Array<{ id: string }>).map((r) => r.id);
  assert.notDeepEqual(ids(newest), dueDayOrder);
  assert.notDeepEqual(ids(oldest), dueDayOrder);
  assert.notDeepEqual(ids(newest), placedOrder);
  // A blank `sort` is the default, like a blank `type`.
  assert.deepEqual(ids(await board(app, 'scope=delivered&sort=')), DELIVERED_NEWEST);
});

test('«ملغاة»: by when it was cancelled — not by the due day, not by when it was placed', async () => {
  const { app, raw } = world();
  const newest = await board(app, 'scope=cancelled');
  assert.deepEqual(ids(newest), CANCELLED_NEWEST);
  assert.equal(newest.sort, 'newest');
  const oldest = await board(app, 'scope=cancelled&sort=oldest');
  assert.deepEqual(ids(oldest), [...CANCELLED_NEWEST].reverse());
  assert.equal(oldest.sort, 'oldest');
  // The seed's other two clocks disagree with the cancellation clock, so neither could pass for it.
  assert.deepEqual(
    (raw.prepare("SELECT id FROM orders WHERE status = 'cancelled' ORDER BY created_at DESC").all() as Array<{ id: string }>).map((r) => r.id),
    [C.CLEARED, C.MID, C.EARLIER, C.RECENT]
  );
  assert.deepEqual(
    (raw.prepare("SELECT id FROM orders WHERE status = 'cancelled' ORDER BY delivery_due_day DESC").all() as Array<{ id: string }>).map((r) => r.id),
    [C.RECENT, C.EARLIER, C.CLEARED, C.MID]
  );
  // The hand-cleared row really has no time (the insert trigger would have stamped one).
  assert.equal((raw.prepare('SELECT cancelled_at AS v FROM orders WHERE id = ?').get(C.CLEARED) as { v: unknown }).v, null);
});

test('the journey narrows inside the order; paging two at a time reads every row once, in both directions', async () => {
  const { app } = world();
  assert.deepEqual(
    ids(await board(app, 'scope=delivered&type=direct')),
    DELIVERED_NEWEST.filter((id) => id !== D.SEA),
    'type=direct drops the sea pre-order and keeps the order'
  );
  assert.deepEqual(ids(await board(app, 'scope=delivered&type=preorder_sea&sort=oldest')), [D.SEA]);
  for (const [sort, want] of [
    ['newest', DELIVERED_NEWEST],
    ['oldest', [...DELIVERED_NEWEST].reverse()],
  ] as const) {
    const paged: string[] = [];
    for (let offset = 0; offset < want.length + 2; offset += 2) {
      paged.push(...ids(await board(app, `scope=delivered&sort=${sort}&limit=2&offset=${offset}`)));
    }
    assert.deepEqual(paged, want, `${sort}: a row on two pages, or on none`);
  }
});

test('the owner’s symptom: of 65 deliveries the latest is row one of page one — it was the last row of page three', async () => {
  const day = (n: number) => `2026-${String(9 + Math.floor((n - 1) / 30)).padStart(2, '0')}-${String(((n - 1) % 30) + 1).padStart(2, '0')}`;
  const seeds: Seed[] = [];
  for (let n = 1; n <= 65; n++) {
    // Due day n, delivered on day n at noon; ids run against the days, so the id order is no help.
    seeds.push({ id: `ORD-F${String(100 - n).padStart(7, '0')}`, status: 'delivered', day: day(n), delivered_at: `${day(n)}T09:00:00.000Z`, created_at: `${day(n)}T06:00:00.000Z` });
  }
  const latest = seeds[64].id;
  const first = seeds[0].id;
  const { app } = seed(seeds);
  const page1 = await board(app, 'scope=delivered&limit=30&offset=0');
  assert.equal(page1.total, 65);
  assert.equal(page1.orders[0].id, latest, 'the latest delivery opens the archive');
  const page3 = await board(app, 'scope=delivered&limit=30&offset=60');
  assert.deepEqual(ids(page3).length, 5);
  assert.equal(page3.orders.at(-1)!.id, first, 'and the first delivery closes it');
  const oldest1 = await board(app, 'scope=delivered&sort=oldest&limit=30&offset=0');
  assert.equal(oldest1.orders[0].id, first, '«الأقدم أولًا» opens on the first delivery');
});

// =========================================================================
// THE LIVE HALF, AND A LOOKUP
// =========================================================================

test('the live board ignores `sort`: the same rows, the same statements word for word, the same plans, `sort` null', async () => {
  const { app, db, raw } = world();
  // The board's own statements — rows, COUNT and facet — not the once-per-process probes beside them.
  const boardStatements = () => db.seen.filter((s) => s.sql.includes('FROM orders o LEFT JOIN users u')).map((s) => [s.sql, s.binds]);
  for (const scope of ['open', 'preorder', 'all', 'prepare']) {
    db.seen.length = 0;
    const plain = await board(app, `scope=${scope}`);
    const plainSql = boardStatements();
    db.seen.length = 0;
    const sorted = await board(app, `scope=${scope}&sort=oldest`);
    const sortedSql = boardStatements();
    assert.deepEqual(ids(sorted), ids(plain), scope);
    assert.equal(plain.sort, null, `${scope}: the live board has no archive order`);
    assert.equal(sorted.sort, null, scope);
    assert.equal(plainSql.length, 3, `${scope}: rows, COUNT and facet`);
    assert.deepEqual(sortedSql, plainSql, `${scope}: every statement and bind the same`);
    // Its order is the board day's (row 322) — the constant, untouched — and
    // its rows and COUNT still read the board's partial index under `sort`.
    const rows = db.seen.find((s) => /LIMIT \? OFFSET \?/.test(s.sql))!;
    assert.ok(rows.sql.includes(BOARD_ORDER_SQL), `${scope}: the live ORDER BY`);
    const count = db.seen.find((s) => /AS due_today/.test(s.sql))!;
    for (const [label, s] of [['rows', rows], ['COUNT', count]] as const) {
      const p = plan(raw, s.sql, s.binds);
      assert.match(p, /idx_orders_board_open/, `${scope} ${label}: ${p}`);
    }
  }
  // The live direct orders, and no finished one (their order is pinned by
  // tests/adminOrderBoard.test.ts and tests/adminOrderPrepareDay.test.ts).
  assert.deepEqual(ids(await board(app, 'scope=open&sort=oldest')).sort(), [L.TOMORROW, L.TODAY, L.COURIER].sort());
});

test('a pierced lookup keeps the work list’s order from either half, and says it applied no archive order', async () => {
  const seeds: Seed[] = [
    { id: 'ORD-B0000001', status: 'delivered', day: '2026-11-02', delivered_at: '2026-11-10T10:00:00.000Z' },
    { id: 'ORD-B0000002', status: 'processing', day: '2026-11-12' },
    { id: 'ORD-B0000003', status: 'cancelled', day: '2026-11-13', cancelled_at: '2026-11-11T09:00:00.000Z' },
    { id: 'ORD-B0000004', status: 'delivered', day: '2026-11-08', delivered_at: '2026-11-11T08:00:00.000Z' },
  ];
  const { app, raw } = seed(seeds);
  const workList = (raw.prepare(`SELECT o.id FROM orders o WHERE o.id LIKE 'ORD-B%' ${BOARD_ORDER_SQL}`).all() as Array<{ id: string }>).map((r) => r.id);
  // Meaningful only because the work list's order is not the completion order.
  assert.notDeepEqual(workList, ['ORD-B0000003', 'ORD-B0000004', 'ORD-B0000001', 'ORD-B0000002']);
  for (const qs of ['scope=delivered&sort=oldest', 'scope=cancelled', 'scope=delivered', 'scope=open']) {
    const b = await board(app, `${qs}&q=ORD-B`);
    assert.deepEqual(ids(b), workList, qs);
    assert.equal(b.sort, null, `${qs}: a lookup is not a half of the archive`);
  }
  // A finished order found from the live board still says when it was finished.
  const found = await board(app, 'scope=open&q=ORD-B0000001');
  assert.deepEqual(ids(found), ['ORD-B0000001']);
  assert.equal(found.orders[0].done_label, 'الثلاثاء ١٠ تشرين الثاني');
});

// =========================================================================
// THE ROWS
// =========================================================================

test('`done_label`: the day it was finished, across the Baghdad midnight, with the year only when not this year — three languages', async () => {
  const { app } = world();
  const want: Record<string, Record<string, string>> = {
    ar: { [D.TODAY]: 'اليوم', [D.NIGHT]: 'اليوم', [D.EVE]: 'الثلاثاء ١٠ تشرين الثاني', [D.LASTYEAR]: 'الاثنين ١٠ تشرين الثاني ٢٠٢٥', [D.EMPTY]: '', [D.NONE]: '' },
    en: { [D.TODAY]: 'Today', [D.NIGHT]: 'Today', [D.EVE]: 'Tuesday 10 November', [D.LASTYEAR]: 'Monday 10 November 2025', [D.EMPTY]: '', [D.NONE]: '' },
    ckb: { [D.TODAY]: 'ئەمڕۆ', [D.NIGHT]: 'ئەمڕۆ', [D.EVE]: 'سێشەممە ١٠ تشرینی دووەم', [D.LASTYEAR]: 'دووشەممە ١٠ تشرینی دووەم ٢٠٢٥', [D.EMPTY]: '', [D.NONE]: '' },
  };
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const rows = new Map((await board(app, `scope=delivered&lang=${lang}`)).orders.map((o) => [o.id, o]));
    for (const [id, label] of Object.entries(want[lang])) assert.equal(rows.get(id)!.done_label, label, `${lang} ${id}`);
    const cancelled = new Map((await board(app, `scope=cancelled&lang=${lang}`)).orders.map((o) => [o.id, o]));
    assert.equal(cancelled.get(C.RECENT)!.done_label, want[lang][D.TODAY], `${lang}: cancelled this morning`);
    assert.equal(cancelled.get(C.CLEARED)!.done_label, '', `${lang}: no time, no day`);
  }
  const cancelled = new Map((await board(app, 'scope=cancelled')).orders.map((o) => [o.id, o]));
  assert.equal(cancelled.get(C.MID)!.cancelled_at, '2026-11-09T08:00:00.000Z', 'the row carries when it was cancelled');
  assert.equal(cancelled.get(C.MID)!.done_label, 'الاثنين ٩ تشرين الثاني');
  assert.equal(cancelled.get(C.CLEARED)!.cancelled_at, null);
  // A live order has nothing finished to label.
  for (const r of (await board(app, 'scope=all')).orders) {
    assert.equal(r.done_label, '', r.id);
    assert.equal(r.cancelled_at, null, r.id);
  }
});

// =========================================================================
// THE PLANS — the route's own statements, as it ran them
// =========================================================================

test('the archive’s rows are SEARCHed by status, never a SCAN; the cancelled half reads its index in order and sorts only the id', async () => {
  const { app, raw, db } = world();
  const rowsPlan = async (qs: string) => {
    db.seen.length = 0;
    await board(app, qs);
    const hit = db.seen.filter((s) => /LIMIT \? OFFSET \?/.test(s.sql));
    assert.equal(hit.length, 1, `${qs}: one rows statement`);
    return { sql: hit[0].sql, plan: plan(raw, hit[0].sql, hit[0].binds) };
  };
  for (const sort of ['newest', 'oldest'] as const) {
    const dir = sort === 'newest' ? 'DESC' : 'ASC';
    for (const qs of [`scope=delivered&sort=${sort}`, `scope=delivered&sort=${sort}&type=direct`, `scope=cancelled&sort=${sort}`]) {
      const { sql, plan: p } = await rowsPlan(qs);
      const col = qs.includes('cancelled') ? 'cancelled_at' : 'delivered_at';
      assert.match(sql, new RegExp(`ORDER BY o\\.${col} ${dir}, o\\.id ${dir}\\s+LIMIT`), qs);
      assert.match(p, /SEARCH o USING (COVERING )?INDEX \w+ \(status=\?/, `${qs}: ${p}`);
      assert.doesNotMatch(p, /SCAN o\b/, `${qs}: ${p}`);
      if (col === 'cancelled_at') {
        assert.match(p, /SEARCH o USING INDEX idx_orders_cancelled_retention \(status=\?\)/, `${qs}: ${p}`);
        assert.match(p, /LAST TERM OF ORDER BY/, `${qs}: only the id is sorted — ${p}`);
      }
    }
  }
  // One completion column per half: an expression over both would read no index.
  assert.doesNotMatch(readFileSync(join(ROOT, 'worker/routes/admin.ts'), 'utf8'), /COALESCE\(o\.delivered_at/);
});

// =========================================================================
// THE INPUT
// =========================================================================

test('a bad `sort` is a 400 with a message on every scope — never a silent default', async () => {
  const { app } = world();
  for (const qs of ['scope=delivered&sort=sideways', 'scope=cancelled&sort=NEWEST', 'scope=delivered&sort=newestnewest', 'scope=open&sort=latest', 'sort=1']) {
    const res = await at(NOON, () => get(app, `/api/admin/orders?${qs}`));
    const body = await json(res);
    assert.equal(res.status, 400, qs);
    assert.match(JSON.stringify(body), /sort/, `${qs}: the message names the parameter`);
  }
});
