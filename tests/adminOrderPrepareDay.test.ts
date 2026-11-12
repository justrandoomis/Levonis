/**
 * THE BOARD BY THE DAY TO PREPARE — «when the customer needs the order
 * delivered on e.g. 13-11, it should appear to the admin to prepare on 12-11
 * because delivery takes 24hr» (owner, 2026-11-11; DECISIONS row 322).
 *
 * The real route over real SQLite with every migration applied and the clock
 * pinned, as tests/adminOrderBoard.test.ts does. What each group pins:
 *
 *   THE RULE      a courier order is filed (bucket, count, `due`, order) on the
 *                 day before its delivery day, in every governorate alike; the
 *                 store's same-day methods and an order already with the
 *                 courier on the day itself; an order with no day stays «بلا
 *                 موعد»; the row still names the customer's day.
 *   THE BOUNDARY  20:59Z and 21:00Z are two Baghdad days.
 *   THE COUNTS    each count equals the rows it describes, and the five `due`
 *                 values split every live scope with no row lost or repeated.
 *   THE ARCHIVE   filed by the customer's day exactly as before (lead 0); its
 *                 order is its own since row 323 (tests/orderArchiveRoute.test.ts).
 *   THE PLANS     the route's own statements — captured as the route ran them
 *                 — read through idx_orders_board_open: rows and COUNT in every
 *                 live scope and `due`, the facet whenever `due` is set; and
 *                 without the stored-day range the facet loses it.
 *   THE WINDOW    GET /orders/:id labels both days in the reader's language.
 *   THE E2E       scripts/e2e-order-fulfilment.mjs expects what this does.
 *
 * Run: node --import tsx --test tests/adminOrderPrepareDay.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshDb, stubApp, get, json } from './fixtures/app';
import { ROOT, SqliteD1, type SqliteStatement } from './fixtures/d1';
import { adminRoutes, boardDueClause, BOARD_DAY_SQL } from '../worker/routes/admin';
import { boardDayOf, leadDaysFor } from '../worker/lib/deliveryLead';
import { STAGE_LEGACY_STATUS, type OrderStage } from '../worker/lib/orderStages';

// 13:00 in Baghdad on Thursday 12 November.
const NOON = '2026-11-12T10:00:00.000Z';
const TODAY = '2026-11-12';
const TOMORROW = '2026-11-13';
const WEEK_END = '2026-11-19';

async function at<T>(iso: string, fn: () => T | Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => Date.parse(iso);
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

interface Seed {
  id: string;
  day?: string | null;
  /** `orders.delivery_method_id`; the courier's `standard` unless said. */
  method?: string;
  /** On the shelf (`preparing`) unless said; the status follows the stage. */
  stage?: string;
  status?: string;
  type?: string;
  priority?: number;
  created_at?: string;
  governorate?: string;
  remote?: string;
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
        delivery_due_day,delivery_remote_id)
     VALUES (?,'u1',?,?,?,?,'{}','cod',1000,1500,1000,1000,?,?,?,'levonis',?,?)`
  );
  for (const o of orders) {
    const stage = o.stage ?? 'preparing';
    ins.run(
      o.id,
      o.status ?? STAGE_LEGACY_STATUS[stage as OrderStage] ?? 'processing',
      stage,
      JSON.stringify({ name: 'زبون', phone: '+9647801112233', governorate: o.governorate ?? 'baghdad' }),
      o.method ?? 'standard',
      o.created_at ?? '2026-11-10T08:00:00.000Z',
      o.priority ?? 0,
      o.type ?? 'direct',
      o.day === undefined ? null : o.day,
      o.remote ?? ''
    );
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

type Row = {
  id: string;
  stage: string;
  due_bucket: string;
  due_label: string;
  board_day: string | null;
  lead_days: number | null;
  prepare_label: string;
  delivery_due_day: string | null;
};
type Board = { orders: Row[]; counts: Record<string, number>; total: number };

const board = async (app: ReturnType<typeof seed>['app'], qs = ''): Promise<Board> => {
  // One page holds every row here, unless the test pages on purpose.
  const query = /(^|&)limit=/.test(qs) ? qs : `limit=100${qs ? `&${qs}` : ''}`;
  const res = await get(app, `/api/admin/orders?${query}`);
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body).slice(0, 400));
  return body as unknown as Board;
};
const ids = (b: Board) => b.orders.map((o) => o.id);
const byId = (b: Board) => new Map(b.orders.map((o) => [o.id, o]));

// =========================================================================
// THE RULE
// =========================================================================

test('the owner’s sentence: on 12-11 a courier order for 13-11 is today’s work, and still says «غدًا»', async () => {
  const { app } = seed([{ id: 'ORD-OWNER0001', day: TOMORROW }]);
  const b = await at(NOON, () => board(app));
  const r = b.orders[0];
  assert.equal(r.due_bucket, 'today', 'filed under «اليوم»: packed today, handed to the courier at 7 pm');
  assert.equal(r.due_label, 'غدًا', 'the row still names the customer’s day');
  assert.equal(r.board_day, TODAY);
  assert.equal(r.lead_days, 1);
  assert.equal(r.prepare_label, 'اليوم');
  assert.equal(b.counts.today, 1);
  assert.equal(b.counts.tomorrow, 0);
  assert.deepEqual(ids(await at(NOON, () => board(app, 'due=today'))), ['ORD-OWNER0001']);
  assert.deepEqual(ids(await at(NOON, () => board(app, 'due=tomorrow'))), []);
});

test('«1 day everywhere»: Erbil, Basra and Baghdad alike; the store’s same-day methods on the day itself', async () => {
  const { app } = seed([
    { id: 'ORD-ERBIL0014', day: '2026-11-14', governorate: 'erbil' },
    { id: 'ORD-BASRA0014', day: '2026-11-14', governorate: 'basra' },
    { id: 'ORD-BAGHD0014', day: '2026-11-14', governorate: 'baghdad' },
    { id: 'ORD-PERSN0012', day: TODAY, method: 'personal' },
    { id: 'ORD-PERSN0013', day: TOMORROW, method: 'personal' },
    { id: 'ORD-PICKU0012', day: TODAY, method: 'pickup' },
    { id: 'ORD-COURI0012', day: TODAY },
  ]);
  const rows = byId(await at(NOON, () => board(app)));
  for (const id of ['ORD-ERBIL0014', 'ORD-BASRA0014', 'ORD-BAGHD0014']) {
    const r = rows.get(id)!;
    assert.deepEqual([r.due_bucket, r.board_day, r.lead_days], ['tomorrow', TOMORROW, 1], id);
    assert.equal(r.prepare_label, 'غدًا', `${id}: packed tomorrow`);
  }
  // Our own driver, the same day: no road day, so the board day IS the delivery day.
  assert.deepEqual([rows.get('ORD-PERSN0012')!.due_bucket, rows.get('ORD-PERSN0012')!.lead_days], ['today', 0]);
  assert.equal(rows.get('ORD-PERSN0012')!.prepare_label, '', 'no second day to name');
  assert.equal(rows.get('ORD-PERSN0013')!.due_bucket, 'tomorrow');
  assert.deepEqual([rows.get('ORD-PICKU0012')!.due_bucket, rows.get('ORD-PICKU0012')!.lead_days], ['today', 0]);
  // The courier's parcel for today should have been handed over last night.
  assert.equal(rows.get('ORD-COURI0012')!.due_bucket, 'overdue');
  assert.equal(rows.get('ORD-COURI0012')!.board_day, '2026-11-11');
});

test('with the courier: filed by its own day — not late the morning after the hand-over, late when the courier is', async () => {
  const { app } = seed([
    { id: 'ORD-OUTFD0012', stage: 'out_for_delivery', day: TODAY },
    { id: 'ORD-OUTFD0011', stage: 'out_for_delivery', day: '2026-11-11' },
    { id: 'ORD-OUTFD0013', stage: 'out_for_delivery', day: TOMORROW },
    // A shipment booked with the courier but still on our shelf: still today's packing.
    { id: 'ORD-BOOKD0013', stage: 'preparing', remote: 'AW-123', day: TOMORROW },
    // Confirmed for today and never handed over: packing is late.
    { id: 'ORD-CONFR0012', stage: 'confirmed', day: TODAY },
  ]);
  const rows = byId(await at(NOON, () => board(app)));
  assert.deepEqual([rows.get('ORD-OUTFD0012')!.due_bucket, rows.get('ORD-OUTFD0012')!.lead_days], ['today', 0]);
  assert.deepEqual([rows.get('ORD-OUTFD0011')!.due_bucket, rows.get('ORD-OUTFD0011')!.stage], ['overdue', 'out_for_delivery'], 'the courier is late');
  assert.equal(rows.get('ORD-OUTFD0013')!.due_bucket, 'tomorrow');
  assert.deepEqual([rows.get('ORD-BOOKD0013')!.due_bucket, rows.get('ORD-BOOKD0013')!.lead_days], ['today', 1]);
  assert.deepEqual([rows.get('ORD-CONFR0012')!.due_bucket, rows.get('ORD-CONFR0012')!.stage], ['overdue', 'confirmed'], 'the packing is late');
});

test('pre-orders at local delivery: the same rule, in «يجب تجهيزها» and in the pre-order scope', async () => {
  const { app } = seed([
    { id: 'ORD-PRELD0013', type: 'preorder_sea', stage: 'local_delivery_prep', day: TOMORROW },
    { id: 'ORD-PREPS0013', type: 'preorder_air', stage: 'local_delivery_prep', day: TOMORROW, method: 'personal' },
    { id: 'ORD-PREOF0013', type: 'preorder_sea', stage: 'out_for_delivery', day: TOMORROW },
    { id: 'ORD-PRELV0014', type: 'preorder_land', stage: 'at_levo_warehouse', day: '2026-11-14' },
    { id: 'ORD-DIRCT0013', day: TOMORROW },
  ]);
  const pre = byId(await at(NOON, () => board(app, 'scope=preorder')));
  assert.equal(pre.get('ORD-PRELD0013')!.due_bucket, 'today', 'made up today for tomorrow’s door');
  assert.equal(pre.get('ORD-PREPS0013')!.due_bucket, 'tomorrow', 'our own driver takes it tomorrow');
  assert.equal(pre.get('ORD-PREOF0013')!.due_bucket, 'tomorrow', 'already with the courier: its own day');
  assert.equal(pre.get('ORD-PRELV0014')!.due_bucket, 'tomorrow');
  const prep = await at(NOON, () => board(app, 'scope=prepare'));
  assert.deepEqual(
    prep.orders.map((o) => [o.id, o.due_bucket]),
    [
      ['ORD-DIRCT0013', 'today'],
      ['ORD-PRELD0013', 'today'],
      ['ORD-PREPS0013', 'tomorrow'],
    ]
  );
  assert.deepEqual([prep.counts.today, prep.counts.tomorrow], [2, 1]);
});

test('an order with no day («في أقرب وقت») stays «بلا موعد», whatever its method or stage', async () => {
  const { app } = seed([
    { id: 'ORD-ASAP00001', day: null },
    { id: 'ORD-ASAP00002', day: null, method: 'personal' },
    { id: 'ORD-ASAP00003', day: null, stage: 'out_for_delivery' },
  ]);
  const b = await at(NOON, () => board(app));
  for (const r of b.orders) {
    assert.deepEqual([r.due_bucket, r.board_day, r.lead_days, r.prepare_label, r.due_label], ['unscheduled', null, null, '', ''], r.id);
  }
  assert.equal(b.counts.unscheduled, 3);
  assert.equal(b.counts.today + b.counts.overdue, 0, 'a NULL day is never today');
});

// =========================================================================
// THE BAGHDAD DAY BOUNDARY
// =========================================================================

test('20:59Z and 21:00Z are two Baghdad days: the same order moves from tomorrow’s work to today’s', async () => {
  const { app } = seed([
    { id: 'ORD-BOUND0013', day: TOMORROW },
    { id: 'ORD-BOUND0012', day: TODAY },
  ]);
  // 23:59 in Baghdad on the eleventh.
  const late = await at('2026-11-11T20:59:00.000Z', () => board(app));
  assert.equal((late as unknown as { today: string }).today, '2026-11-11');
  assert.equal(byId(late).get('ORD-BOUND0013')!.due_bucket, 'tomorrow', 'packed on the twelfth, which is tomorrow');
  assert.equal(byId(late).get('ORD-BOUND0012')!.due_bucket, 'today', 'packed on the eleventh — tonight');
  // 00:00 in Baghdad on the twelfth — still the eleventh in UTC.
  const midnight = await at('2026-11-11T21:00:00.000Z', () => board(app));
  assert.equal((midnight as unknown as { today: string }).today, TODAY);
  assert.equal(byId(midnight).get('ORD-BOUND0013')!.due_bucket, 'today');
  assert.equal(byId(midnight).get('ORD-BOUND0013')!.due_label, 'غدًا');
  assert.equal(byId(midnight).get('ORD-BOUND0012')!.due_bucket, 'overdue', 'its hand-over was last night');
  assert.deepEqual(ids(await at('2026-11-11T21:00:00.000Z', () => board(app, 'due=today'))), ['ORD-BOUND0012', 'ORD-BOUND0013']);
  assert.deepEqual(ids(await at('2026-11-11T20:59:00.000Z', () => board(app, 'due=today'))), ['ORD-BOUND0012']);
});

// =========================================================================
// THE COUNTS EQUAL THE ROWS
// =========================================================================

/** A mixed board: every method, journey and stage the rule tells apart, days from 3 back to 12 ahead, and none. */
function mixed(): Seed[] {
  const out: Seed[] = [];
  const methods = ['standard', 'personal', 'pickup', 'standard'];
  const direct = ['received', 'confirmed', 'preparing', 'out_for_delivery'];
  const pre = ['at_levo_warehouse', 'local_delivery_prep', 'out_for_delivery', 'en_route_to_levo'];
  let n = 0;
  for (let offset = -3; offset <= 12; offset++) {
    for (let k = 0; k < 4; k++) {
      const day = new Date(Date.parse(`${TODAY}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
      const preorder = (offset + k) % 3 === 0;
      out.push({
        id: `ORD-MIX${String(++n).padStart(6, '0')}`,
        day: (offset + k) % 7 === 0 ? null : day,
        method: methods[(offset + 3 + k) % 4],
        type: preorder ? 'preorder_sea' : 'direct',
        stage: (preorder ? pre : direct)[(k + offset + 3) % 4],
        priority: k === 1 ? 1 : 0,
        created_at: `2026-11-0${1 + (k % 9)}T08:00:00.000Z`,
      });
    }
  }
  return out;
}

const BUCKETS = ['overdue', 'today', 'tomorrow', 'week', 'later', 'unscheduled'] as const;
const DUE_OF: Record<string, readonly string[]> = {
  today: ['overdue', 'today'],
  tomorrow: ['tomorrow'],
  week: ['week'],
  later: ['later'],
  unscheduled: ['unscheduled'],
};

test('each count equals the rows it describes, and the five `due` values split every live scope', async () => {
  const seeds = mixed();
  const { app } = seed(seeds);
  const bySeed = new Map(seeds.map((s) => [s.id, s]));
  for (const scope of ['open', 'preorder', 'all', 'prepare']) {
    const b = await at(NOON, () => board(app, `scope=${scope}`));
    assert.ok(b.orders.length > 4, `${scope}: a board worth counting (${b.orders.length})`);
    assert.equal(b.counts.total, b.orders.length, scope);
    for (const bucket of BUCKETS) {
      assert.equal(b.counts[bucket], b.orders.filter((o) => o.due_bucket === bucket).length, `${scope}: ${bucket}`);
    }
    // The SQL's board day is the TypeScript rule's, row by row.
    for (const r of b.orders) {
      const s = bySeed.get(r.id)!;
      const lead = leadDaysFor({ stage: s.stage, status: STAGE_LEGACY_STATUS[s.stage as OrderStage], delivery_method_id: s.method });
      assert.equal(r.board_day, boardDayOf(s.day, lead) || null, `${scope}: ${r.id}`);
    }
    const seen: string[] = [];
    for (const due of Object.keys(DUE_OF)) {
      const got = await at(NOON, () => board(app, `scope=${scope}&due=${due}`));
      const want = b.orders.filter((o) => DUE_OF[due].includes(o.due_bucket)).map((o) => o.id);
      assert.deepEqual(ids(got).sort(), [...want].sort(), `${scope}: due=${due}`);
      assert.equal(got.counts.total, want.length, `${scope}: due=${due} total`);
      seen.push(...ids(got));
    }
    assert.equal(seen.length, b.orders.length, `${scope}: a row in two \`due\` values, or in none`);
    assert.deepEqual([...seen].sort(), ids(b).sort(), scope);
  }
});

// =========================================================================
// THE ORDER
// =========================================================================

test('the order: the board day first, PRO first inside it, then the earlier delivery day — and paging keeps it', async () => {
  const { app } = seed([
    { id: 'ORD-SORT0000B', day: TOMORROW, created_at: '2026-11-09T08:00:00.000Z' }, // board 12-11
    { id: 'ORD-SORT0000C', day: TOMORROW, priority: 1, created_at: '2026-11-11T08:00:00.000Z' }, // board 12-11, PRO
    { id: 'ORD-SORT0000A', day: TODAY, method: 'personal', created_at: '2026-11-11T09:00:00.000Z' }, // board 12-11, delivered today
    { id: 'ORD-SORT0000D', day: TODAY, created_at: '2026-11-11T10:00:00.000Z' }, // board 11-11: overdue
    { id: 'ORD-SORT0000E', day: '2026-11-15', method: 'personal', priority: 1 }, // board 15-11
    { id: 'ORD-SORT0000F', day: '2026-11-15' }, // board 14-11
    { id: 'ORD-SORT0000G', day: null, priority: 1 },
  ]);
  const want = ['ORD-SORT0000D', 'ORD-SORT0000C', 'ORD-SORT0000A', 'ORD-SORT0000B', 'ORD-SORT0000F', 'ORD-SORT0000E', 'ORD-SORT0000G'];
  assert.deepEqual(ids(await at(NOON, () => board(app))), want);
  const paged: string[] = [];
  for (let offset = 0; offset < want.length; offset += 2) paged.push(...ids(await at(NOON, () => board(app, `limit=2&offset=${offset}`))));
  assert.deepEqual(paged, want);
});

// =========================================================================
// THE ARCHIVE
// =========================================================================

test('the archive is filed by the customer’s day, exactly as before — and ordered by when each was finished (row 323)', async () => {
  const seeds: Seed[] = [
    { id: 'ORD-ARCH00001', stage: 'delivered', day: '2026-11-10' },
    { id: 'ORD-ARCH00002', stage: 'delivered', day: TODAY, priority: 1 },
    { id: 'ORD-ARCH00003', stage: 'delivered', day: TODAY },
    // A hand-corrected status over a stage left behind: finished all the same.
    { id: 'ORD-ARCH00004', stage: 'preparing', status: 'delivered', day: TOMORROW },
    { id: 'ORD-ARCH00005', stage: 'delivered', day: null },
    { id: 'ORD-ARCH00006', stage: 'cancelled', day: TOMORROW },
  ];
  const { app, raw } = seed(seeds);
  const delivered = await at(NOON, () => board(app, 'scope=delivered'));
  // Its order is the archive's own since row 323 — when each was delivered,
  // newest first (tests/orderArchiveRoute.test.ts) — and never the board day's.
  const archiveOrder = (
    raw.prepare("SELECT o.id FROM orders o WHERE o.status = 'delivered' ORDER BY o.delivered_at DESC, o.id DESC").all() as Array<{ id: string }>
  ).map((r) => r.id);
  assert.deepEqual(ids(delivered), archiveOrder);
  const rows = byId(delivered);
  assert.deepEqual([rows.get('ORD-ARCH00001')!.due_bucket, rows.get('ORD-ARCH00001')!.lead_days], ['overdue', 0]);
  assert.equal(rows.get('ORD-ARCH00003')!.due_bucket, 'today');
  assert.deepEqual([rows.get('ORD-ARCH00004')!.due_bucket, rows.get('ORD-ARCH00004')!.board_day], ['tomorrow', TOMORROW]);
  for (const r of delivered.orders) assert.equal(r.prepare_label, '', r.id);
  assert.deepEqual(delivered.counts, { total: 5, overdue: 1, today: 2, tomorrow: 1, week: 0, later: 0, unscheduled: 1 });
  const cancelled = await at(NOON, () => board(app, 'scope=cancelled'));
  assert.deepEqual([cancelled.orders[0].id, cancelled.orders[0].due_bucket], ['ORD-ARCH00006', 'tomorrow']);
});

// =========================================================================
// THE PLANS — the route's own statements, as it ran them
// =========================================================================

const plan = (raw: DatabaseSync, sql: string, binds: unknown[]) =>
  (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(binds as never[])) as Array<{ detail: string }>).map((r) => r.detail).join(' | ');

test('rows, COUNT and facet read through idx_orders_board_open in every live scope and every `due`', async () => {
  const { app, raw, db } = seed(mixed());
  for (const scope of ['open', 'preorder', 'all', 'prepare']) {
    for (const due of ['', 'today', 'tomorrow', 'week', 'later', 'unscheduled']) {
      db.seen.length = 0;
      await at(NOON, () => board(app, `scope=${scope}${due ? `&due=${due}` : ''}`));
      const find = (label: string, re: RegExp) => {
        const hit = db.seen.filter((s) => re.test(s.sql));
        assert.equal(hit.length, 1, `${scope}/${due || '-'}: one ${label} statement`);
        return plan(raw, hit[0].sql, hit[0].binds);
      };
      const rows = find('rows', /LIMIT \? OFFSET \?/);
      const count = find('COUNT', /AS due_today/);
      const facet = find('facet', /GROUP BY o\.shipping_type, o\.status/);
      const at_ = `${scope}/${due || '-'}`;
      assert.match(rows, /idx_orders_board_open/, `${at_} rows: ${rows}`);
      assert.match(count, /idx_orders_board_open/, `${at_} COUNT: ${count}`);
      if (due) {
        assert.match(facet, /idx_orders_board_open/, `${at_} facet: ${facet}`);
        // A `due` is a SEARCH on the stored day, never a walk of the whole index.
        for (const [label, p] of [['rows', rows], ['COUNT', count], ['facet', facet]] as const) {
          assert.match(p, /SEARCH o USING INDEX idx_orders_board_open \(delivery_due_day/, `${at_} ${label}: ${p}`);
        }
      }
    }
  }
});

test('the stored-day range is what keeps the index: the board day alone sends the facet over every order', () => {
  const raw = freshDb();
  const facet = (dueSql: string) =>
    `SELECT o.shipping_type AS t, o.status AS s, COUNT(*) AS n
       FROM orders o LEFT JOIN users u ON u.id = o.user_id
      WHERE (o.status NOT IN ('delivered','cancelled')) AND (${dueSql})
      GROUP BY o.shipping_type, o.status`;
  const { sql, binds } = boardDueClause('today', { today: TODAY, tomorrow: TOMORROW, weekEnd: WEEK_END });
  assert.match(plan(raw, facet(sql), binds), /SEARCH o USING INDEX idx_orders_board_open/);
  // The control: the same rows, compared on the board day alone.
  const alone = plan(raw, facet(`${BOARD_DAY_SQL} <= ?`), [TODAY]);
  assert.doesNotMatch(alone, /idx_orders_board_open/, alone);
  raw.close();
});

test('boardDueClause: the stored-day range is the board-day bounds widened by the lead', () => {
  const at_ = { today: TODAY, tomorrow: TOMORROW, weekEnd: WEEK_END };
  assert.deepEqual(boardDueClause('today', at_).binds, ['2026-11-13', TODAY]);
  assert.deepEqual(boardDueClause('tomorrow', at_).binds, [TOMORROW, '2026-11-14', TOMORROW]);
  assert.deepEqual(boardDueClause('week', at_).binds, [TOMORROW, '2026-11-20', TOMORROW, WEEK_END]);
  assert.deepEqual(boardDueClause('later', at_).binds, [WEEK_END, WEEK_END]);
  assert.deepEqual(boardDueClause('unscheduled', at_), { sql: 'o.delivery_due_day IS NULL', binds: [] });
  for (const due of ['today', 'tomorrow', 'week', 'later'] as const) {
    assert.match(boardDueClause(due, at_).sql, /^o\.delivery_due_day /, `${due} leads with the stored day`);
  }
});

// =========================================================================
// THE ORDER WINDOW
// =========================================================================

test('the order window: both days, labelled by the server in the reader’s language', async () => {
  const { app } = seed([
    { id: 'ORD-WIN000001', day: TOMORROW },
    { id: 'ORD-WIN000002', day: TOMORROW, method: 'personal' },
    { id: 'ORD-WIN000003', day: TOMORROW, stage: 'out_for_delivery' },
    { id: 'ORD-WIN000004', day: null },
    { id: 'ORD-WIN000005', day: '2026-11-16' },
  ]);
  const detail = async (id: string, lang = '') => {
    const res = await at(NOON, () => get(app, `/api/admin/orders/${id}${lang ? `?lang=${lang}` : ''}`));
    const body = await json(res);
    assert.equal(res.status, 200, JSON.stringify(body).slice(0, 300));
    const o = body.order as Record<string, unknown>;
    return [o.delivery_day_label, o.prepare_label, o.board_day];
  };
  assert.deepEqual(await detail('ORD-WIN000001'), ['غدًا', 'اليوم', TODAY]);
  assert.deepEqual(await detail('ORD-WIN000001', 'en'), ['Tomorrow', 'Today', TODAY]);
  assert.deepEqual(await detail('ORD-WIN000001', 'ckb'), ['بەیانی', 'ئەمڕۆ', TODAY]);
  assert.deepEqual(await detail('ORD-WIN000002'), ['غدًا', '', TOMORROW], 'our own driver: one day, no second line');
  assert.deepEqual(await detail('ORD-WIN000003'), ['غدًا', '', TOMORROW], 'with the courier: nothing left to prepare');
  assert.deepEqual(await detail('ORD-WIN000004'), ['', '', null], 'no day, no line');
  // A weekday and a month, in ar and ckb digits and Latin ones in English.
  assert.deepEqual(await detail('ORD-WIN000005'), ['الاثنين ١٦ تشرين الثاني', 'الأحد ١٥ تشرين الثاني', '2026-11-15']);
  assert.deepEqual(await detail('ORD-WIN000005', 'en'), ['Monday 16 November', 'Sunday 15 November', '2026-11-15']);
});

// =========================================================================
// THE E2E SCRIPT EXPECTS WHAT THE ROUTE DOES
// =========================================================================

test('scripts/e2e-order-fulfilment.mjs: its fixture, due tomorrow, is today’s work and says «غدًا»', async () => {
  const script = readFileSync(join(ROOT, 'scripts', 'e2e-order-fulfilment.mjs'), 'utf8');
  // It writes the server's own tomorrow, and expects today's bucket with the customer's «غدًا».
  assert.match(script, /delivery_due_day='\$\{tomorrow\}'/);
  assert.match(script, /pinnedRow\?\.due_bucket === 'today'/);
  assert.match(script, /pinnedRow\?\.due_label === 'غدًا'/);
  assert.match(script, /pinnedRow\?\.board_day === today/);
  assert.match(script, /pinnedRow\?\.lead_days === 1/);
  assert.doesNotMatch(script, /delivery_due_day='\$\{today\}'/, 'the day it wrote before row 322');
  // The same fixture through the route: a direct `standard` order moved to
  // «قيد التجهيز» (stage preparing), PRO, due the server's tomorrow.
  const { app } = seed([{ id: 'ORD-E2EFIX001', day: TOMORROW, stage: 'preparing', priority: 1 }]);
  const r = (await at(NOON, () => board(app))).orders[0];
  assert.deepEqual([r.due_bucket, r.due_label, r.board_day, r.lead_days], ['today', 'غدًا', TODAY, 1]);
});
