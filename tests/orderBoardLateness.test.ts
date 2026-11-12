/**
 * WHICH LATENESS «متأخر» IS, AND A STORED DAY THAT IS NO CALENDAR DAY — the
 * independent review of DECISIONS row 322 (2026-11-12), on the real route over
 * real SQLite with every migration applied and the clock pinned, as
 * tests/adminOrderPrepareDay.test.ts does.
 *
 *   THE REASON    the board files an order on the day to pack and hand it over,
 *                 so on its own delivery morning a parcel whose shipment is
 *                 BOOKED with the courier but whose stage nobody moved is late
 *                 by that rule — and the row now says so truthfully
 *                 (`overdue_reason: 'booked'`), never «its day to pack and hand
 *                 over passed». A parcel with the courier past its day is
 *                 'courier', a box still on the shelf 'prepare', a finished
 *                 order never late. The order window says the same as the row.
 *   THE BAD DAY   0094's CHECK holds the shape of `delivery_due_day`, not the
 *                 date: a hand-written '2026-13-01' or '0000-00-00' had no board
 *                 day, so no count and no `due` held it while the row showed
 *                 under «بلا موعد». Now such a day gets no lead — the stored text
 *                 is its board day, as the board filed it before row 322 — and
 *                 every row is in exactly one bucket, one count and one `due`.
 *
 * Run: node --import tsx --test tests/orderBoardLateness.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asD1, stubApp, get, json } from './fixtures/app';
import { adminRoutes } from '../worker/routes/admin';
import { STAGE_LEGACY_STATUS, type OrderStage } from '../worker/lib/orderStages';

// 09:00 in Baghdad on Friday 13 November — the morning of the owner's 13-11.
const MORNING = '2026-11-13T06:00:00.000Z';
// 13:00 in Baghdad on Thursday 12 November.
const NOON = '2026-11-12T10:00:00.000Z';

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
  day: string | null;
  stage?: string;
  status?: string;
  method?: string;
  /** The courier's shipment id — set when the shipment is booked. */
  remote?: string;
  phone?: string;
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
     VALUES (?,'u1',?,?,?,?,'{}','cod',1000,1500,1000,1000,'2026-11-10T08:00:00.000Z',0,'direct','levonis',?,?)`
  );
  for (const o of orders) {
    const stage = o.stage ?? 'preparing';
    ins.run(
      o.id,
      o.status ?? STAGE_LEGACY_STATUS[stage as OrderStage] ?? 'processing',
      stage,
      JSON.stringify({ name: 'زبون', phone: o.phone ?? '+9647801112233', governorate: 'baghdad' }),
      o.method ?? 'standard',
      o.day,
      o.remote ?? ''
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

type Row = {
  id: string;
  status: string;
  stage: string;
  due_bucket: string;
  overdue_reason?: string | null;
  board_day: string | null;
  lead_days: number | null;
  prepare_label: string;
  delivery_due_day: string | null;
};
type Board = { orders: Row[]; counts: Record<string, number>; total: number; search?: { pierced?: boolean } | null };

async function board(app: ReturnType<typeof seed>['app'], qs = ''): Promise<Board> {
  const res = await get(app, `/api/admin/orders?limit=100${qs ? `&${qs}` : ''}`);
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body).slice(0, 400));
  return body as unknown as Board;
}
const byId = (b: Board) => new Map(b.orders.map((o) => [o.id, o]));

async function windowOf(app: ReturnType<typeof seed>['app'], id: string): Promise<Record<string, unknown>> {
  const res = await get(app, `/api/admin/orders/${id}`);
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body).slice(0, 300));
  return body.order as Record<string, unknown>;
}

// =========================================================================
// THE REASON
// =========================================================================

test('the delivery morning: a booked parcel nobody moved is late as «booked», never «its packing day passed»', async () => {
  const { app } = seed([
    // Booked with Al-Waseet on the 12th; the courier's pick-up status never moved the stage.
    { id: 'ORD-B00CED013', day: '2026-11-13', stage: 'preparing', remote: 'AW-777' },
    // Picked up: with the courier, arriving today — not late.
    { id: 'ORD-0F0D00013', day: '2026-11-13', stage: 'out_for_delivery' },
    // Never booked, never handed over: the box is late.
    { id: 'ORD-5E1F00013', day: '2026-11-13', stage: 'preparing' },
    // With the courier since the 11th and due yesterday: the courier is late.
    { id: 'ORD-C0C1E0012', day: '2026-11-12', stage: 'out_for_delivery' },
    // Booked for tomorrow: today's hand-over, not late.
    { id: 'ORD-B00CED014', day: '2026-11-14', stage: 'preparing', remote: 'AW-778' },
    // Our own same-day driver, due yesterday and still «مؤكد»: the box is late.
    { id: 'ORD-9E5000012', day: '2026-11-12', stage: 'confirmed', method: 'personal' },
    // No day: never late.
    { id: 'ORD-A5A900000', day: null, stage: 'preparing', remote: 'AW-779' },
  ]);
  const b = await at(MORNING, () => board(app));
  const rows = byId(b);
  const seen = (id: string) => {
    const r = rows.get(id)!;
    return [r.due_bucket, r.overdue_reason];
  };
  assert.deepEqual(seen('ORD-B00CED013'), ['overdue', 'booked'], 'booked, stage never moved: late on the board day, and the row says why');
  assert.deepEqual(seen('ORD-0F0D00013'), ['today', null], 'with the courier: arriving today');
  assert.deepEqual(seen('ORD-5E1F00013'), ['overdue', 'prepare']);
  assert.deepEqual(seen('ORD-C0C1E0012'), ['overdue', 'courier']);
  assert.deepEqual(seen('ORD-B00CED014'), ['today', null]);
  assert.deepEqual(seen('ORD-9E5000012'), ['overdue', 'prepare']);
  assert.deepEqual(seen('ORD-A5A900000'), ['unscheduled', null]);
  // Every late row carries a reason, and no other row does.
  for (const r of b.orders) assert.equal(r.overdue_reason !== null, r.due_bucket === 'overdue', r.id);
  assert.deepEqual([b.counts.overdue, b.counts.today, b.counts.unscheduled], [4, 2, 1]);

  // The order window says what the row says.
  for (const [id, want] of [
    ['ORD-B00CED013', 'booked'],
    ['ORD-0F0D00013', null],
    ['ORD-5E1F00013', 'prepare'],
    ['ORD-C0C1E0012', 'courier'],
    ['ORD-B00CED014', null],
    ['ORD-9E5000012', 'prepare'],
    ['ORD-A5A900000', null],
  ] as const) {
    const o = await at(MORNING, () => windowOf(app, id));
    assert.equal(o.overdue_reason, want, `window ${id}`);
  }
});

test('a finished order is never late — on the row an order- or phone-number lookup finds, and in its window', async () => {
  const { app } = seed([
    { id: 'ORD-D0E000003', day: '2026-11-03', stage: 'delivered', phone: '+9647809998877' },
    { id: 'ORD-CA0C00005', day: '2026-11-05', stage: 'cancelled', phone: '+9647809998877' },
    { id: 'ORD-11FE00013', day: '2026-11-13', stage: 'preparing', phone: '+9647809998877' },
  ]);
  const b = await at(NOON, () => board(app, 'scope=open&q=07809998877'));
  assert.equal(b.search?.pierced, true, 'a phone lookup pierces the board');
  const rows = byId(b);
  // The lookup returns the finished orders beside the live one; their day passed, but they are not late.
  for (const id of ['ORD-D0E000003', 'ORD-CA0C00005']) {
    assert.equal(rows.get(id)!.overdue_reason, null, id);
    assert.equal((await at(NOON, () => windowOf(app, id))).overdue_reason, null, `window ${id}`);
  }
  assert.deepEqual([rows.get('ORD-11FE00013')!.due_bucket, rows.get('ORD-11FE00013')!.overdue_reason], ['today', null]);
});

// =========================================================================
// THE BAD DAY
// =========================================================================

const BUCKETS = ['overdue', 'today', 'tomorrow', 'week', 'later', 'unscheduled'] as const;
const DUE_OF: Record<string, readonly string[]> = {
  today: ['overdue', 'today'],
  tomorrow: ['tomorrow'],
  week: ['week'],
  later: ['later'],
  unscheduled: ['unscheduled'],
};

test('a stored day that is no calendar day gets no lead: one bucket, one count and one `due` for every row', async () => {
  const bad = ['2026-11-31', '2026-13-01', '0000-00-00', '2026-02-29'];
  const { app } = seed([
    { id: 'ORD-600D00013', day: '2026-11-13' },
    ...bad.map((day, i) => ({ id: `ORD-BAD0${i}`, day })),
    { id: 'ORD-A5A900001', day: null },
  ]);
  const b = await at(NOON, () => board(app));
  const rows = byId(b);
  assert.equal(b.total, 6);
  // The counts add up to the board: nothing counted twice or not at all.
  assert.equal(BUCKETS.reduce((n, k) => n + b.counts[k], 0), b.total, JSON.stringify(b.counts));
  for (const k of BUCKETS) assert.equal(b.counts[k], b.orders.filter((o) => o.due_bucket === k).length, k);
  // A real day keeps its lead; a day SQLite cannot read keeps its stored text.
  assert.deepEqual([rows.get('ORD-600D00013')!.board_day, rows.get('ORD-600D00013')!.lead_days], ['2026-11-12', 1]);
  for (const [i, day] of bad.entries()) {
    const r = rows.get(`ORD-BAD0${i}`)!;
    assert.deepEqual([r.board_day, r.lead_days, r.prepare_label], [day, 0, ''], day);
    assert.notEqual(r.due_bucket, 'unscheduled', `${day} has a day, so it is not «بلا موعد»`);
  }
  // Exactly where the base build filed them: by the stored text.
  assert.deepEqual(
    bad.map((_, i) => rows.get(`ORD-BAD0${i}`)!.due_bucket),
    ['later', 'later', 'overdue', 'overdue']
  );
  // Every row in exactly one `due`, the one its bucket names.
  const seen: string[] = [];
  for (const due of Object.keys(DUE_OF)) {
    const got = await at(NOON, () => board(app, `due=${due}`));
    const want = b.orders.filter((o) => DUE_OF[due].includes(o.due_bucket)).map((o) => o.id).sort();
    assert.deepEqual(got.orders.map((o) => o.id).sort(), want, `due=${due}`);
    assert.equal(got.counts.total, want.length, `due=${due} total`);
    seen.push(...got.orders.map((o) => o.id));
  }
  assert.deepEqual(seen.sort(), b.orders.map((o) => o.id).sort(), 'a row in two `due` values, or in none');

  // The window reads the same rule in TypeScript: the stored text, no second day.
  const w = await at(NOON, () => windowOf(app, 'ORD-BAD01'));
  assert.deepEqual([w.board_day, w.prepare_label], ['2026-13-01', '']);
});
