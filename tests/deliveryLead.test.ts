/**
 * THE DAY TO PREPARE — the lead table and its two readings (DECISIONS row 322).
 *
 * The owner: an order for the 13th is prepared on the 12th, «1 day everywhere»;
 * the store's own same-day methods and an order already with the courier or
 * finished have no day on the road. worker/lib/deliveryLead.ts holds that table
 * once and reads it twice — as SQL text the board files, counts and sorts by,
 * and as TypeScript for the order window — so this pins the table, its
 * precedence, the SQL it writes, the refusal of a table that is not plain days
 * and ids, and that the two readings agree on every stage, status, method and
 * day, NULLs and odd values included.
 *
 * Run: node --import tsx --test tests/deliveryLead.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  DELIVERY_LEAD,
  FINISHED_STATUSES,
  HANDED_OVER_STAGES,
  HANDOVER_HOUR,
  MAX_LEAD_DAYS,
  boardDayOf,
  boardDaySql,
  checkLeadTable,
  leadBounds,
  leadDaysFor,
  leadDaysSql,
  type DeliveryLeadTable,
} from '../worker/lib/deliveryLead';
import { DIRECT_STAGES, PREORDER_STAGES, type OrderStage } from '../worker/lib/orderStages';
import { SETTING_DEFAULTS, deliversToHome } from '../worker/lib/settings';

const ALL_STAGES: OrderStage[] = [...new Set<OrderStage>([...DIRECT_STAGES, ...PREORDER_STAGES, 'cancelled'])];

test('the owner’s table: a day on the road for every method, none for the store’s own same-day ones', () => {
  assert.deepEqual(DELIVERY_LEAD, { default_days: 1, method_days: { personal: 0, pickup: 0 } });
  assert.equal(HANDOVER_HOUR, 19, 'the courier takes the day’s parcels at 7 pm');
  // The same-day ids are the shipped methods' own: «توصيل شخصي — نفس اليوم» and the pickup.
  const methods = SETTING_DEFAULTS.checkoutDeliveryMethods;
  const byId = new Map(methods.map((m) => [m.id, m]));
  assert.equal(byId.get('personal')?.descAr, 'نفس اليوم');
  assert.equal(deliversToHome(byId.get('pickup')!), false, 'the pickup is the method with no door');
  assert.equal(deliversToHome(byId.get('personal')!), true, 'and `personal` ends at the door like `standard`: only the id tells them apart');
  for (const id of Object.keys(DELIVERY_LEAD.method_days)) assert.ok(byId.has(id), `${id} is a shipped method`);

  const shelf = { stage: 'preparing', status: 'processing' };
  assert.equal(leadDaysFor({ ...shelf, delivery_method_id: 'standard' }), 1, 'the courier: a day on the road');
  assert.equal(leadDaysFor({ ...shelf, delivery_method_id: 'personal' }), 0, 'our own driver, the same day');
  assert.equal(leadDaysFor({ ...shelf, delivery_method_id: 'pickup' }), 0);
  // A method added tomorrow, a merchant's, or none: a day on the road until the table says otherwise.
  for (const m of ['express', 'merchant', 'home', '', undefined, null, 'PERSONAL', 'constructor', '__proto__']) {
    assert.equal(leadDaysFor({ ...shelf, delivery_method_id: m }), 1, String(m));
  }
});

test('precedence: with the courier or finished beats the method, and the method beats the default', () => {
  for (const stage of HANDED_OVER_STAGES) {
    for (const m of ['standard', 'personal', 'pickup', 'express']) {
      assert.equal(leadDaysFor({ stage, status: 'shipped', delivery_method_id: m }), 0, `${stage}/${m}`);
    }
  }
  // A finished status files by the customer's day even where the stage was left behind.
  for (const status of FINISHED_STATUSES) {
    assert.equal(leadDaysFor({ stage: 'preparing', status, delivery_method_id: 'standard' }), 0, status);
  }
  // Every stage before the courier: the courier's day for `standard`, none for `personal`.
  for (const stage of ALL_STAGES.filter((s) => !(HANDED_OVER_STAGES as readonly string[]).includes(s))) {
    assert.equal(leadDaysFor({ stage, status: 'processing', delivery_method_id: 'standard' }), 1, stage);
    assert.equal(leadDaysFor({ stage, status: 'processing', delivery_method_id: 'personal' }), 0, stage);
  }
  // A booked shipment still on the shelf is still ours to pack.
  assert.equal(leadDaysFor({ stage: 'preparing', status: 'processing', delivery_method_id: 'standard' }), 1);
});

test('the bounds the board’s index range is built from', () => {
  assert.deepEqual(leadBounds(), { min: 0, max: 1 });
  assert.deepEqual(leadBounds({ default_days: 2, method_days: { personal: 0 } }), { min: 0, max: 2 });
  assert.deepEqual(leadBounds({ default_days: 1, method_days: { slow: 3 } }), { min: 0, max: 3 }, 'a method may widen them');
  assert.deepEqual(leadBounds({ default_days: 0, method_days: {} }), { min: 0, max: 0 });
});

test('the SQL is pinned for the owner’s table, and stable for any other', () => {
  assert.equal(
    leadDaysSql(),
    "(CASE WHEN o.stage IN ('out_for_delivery','delivered','cancelled') OR o.status IN ('delivered','cancelled') THEN 0" +
      " WHEN o.delivery_method_id IN ('personal','pickup') THEN 0 ELSE 1 END)"
  );
  assert.equal(boardDaySql(), `date(o.delivery_due_day, '-' || ${leadDaysSql()} || ' days')`);
  // One WHEN per lead, ids sorted, whatever order the table lists them in.
  assert.equal(
    leadDaysSql({ default_days: 1, method_days: { c: 2, a: 0, b: 2 } }, 'x'),
    "(CASE WHEN x.stage IN ('out_for_delivery','delivered','cancelled') OR x.status IN ('delivered','cancelled') THEN 0" +
      " WHEN x.delivery_method_id IN ('a') THEN 0 WHEN x.delivery_method_id IN ('b','c') THEN 2 ELSE 1 END)"
  );
  assert.equal(leadDaysSql({ default_days: 1, method_days: {} }).includes('delivery_method_id'), false, 'no methods, no WHEN');
});

test('a table that is not plain days and plain ids never reaches SQL', () => {
  assert.equal(checkLeadTable(DELIVERY_LEAD), DELIVERY_LEAD);
  const bad: Array<[string, DeliveryLeadTable]> = [
    ['injected id', { default_days: 1, method_days: { "x') OR 1=1 --": 0 } }],
    ['upper case', { default_days: 1, method_days: { Personal: 0 } }],
    ['empty id', { default_days: 1, method_days: { '': 0 } }],
    ['long id', { default_days: 1, method_days: { ['a'.repeat(41)]: 0 } }],
    ['negative', { default_days: 1, method_days: { personal: -1 } }],
    ['fraction', { default_days: 1.5, method_days: {} }],
    ['too far', { default_days: MAX_LEAD_DAYS + 1, method_days: {} }],
    ['a string', { default_days: '1' as unknown as number, method_days: {} }],
    ['NaN', { default_days: Number.NaN, method_days: {} }],
    ['no methods', { default_days: 1 } as unknown as DeliveryLeadTable],
  ];
  for (const [label, table] of bad) {
    assert.throws(() => leadDaysSql(table), /delivery lead/, label);
    assert.throws(() => leadBounds(table), /delivery lead/, label);
  }
  assert.throws(() => leadDaysSql(DELIVERY_LEAD, 'o; DROP TABLE orders'), /delivery lead/, 'the alias too');
});

test('the board day: the delivery day less the lead, across month, year and leap days; no day, no board day', () => {
  assert.equal(boardDayOf('2026-11-13', 1), '2026-11-12', 'the owner’s 13-11 → 12-11');
  assert.equal(boardDayOf('2026-11-13', 0), '2026-11-13');
  assert.equal(boardDayOf('2026-12-01', 1), '2026-11-30');
  assert.equal(boardDayOf('2027-01-01', 1), '2026-12-31');
  assert.equal(boardDayOf('2028-03-01', 1), '2028-02-29');
  for (const none of [null, undefined, '', '13-11-2026', '2026-02-31']) assert.equal(boardDayOf(none, 1), '', String(none));
});

/**
 * THE TWO READINGS AGREE — every stage of both paths (and none, and nonsense)
 * × every status × the shipped methods and odd ids × days across a month and a
 * year end and none, through SQLite's own `date()`.
 */
function twinRows(table: DeliveryLeadTable): number {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t (stage TEXT, status TEXT, delivery_method_id TEXT, delivery_due_day TEXT)');
  const stages: Array<string | null> = [...ALL_STAGES, '', null, 'bogus'];
  const statuses: Array<string | null> = ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled', '', null];
  const methods: Array<string | null> = ['standard', 'personal', 'pickup', 'merchant', 'home', 'slow', '', null, 'constructor', 'PERSONAL'];
  const days: Array<string | null> = ['2026-11-13', '2026-12-01', '2027-01-01', '2028-03-01', null];
  const ins = db.prepare('INSERT INTO t VALUES (?,?,?,?)');
  for (const s of stages) for (const st of statuses) for (const m of methods) for (const d of days) ins.run(s, st, m, d);
  const rows = db
    .prepare(`SELECT stage, status, delivery_method_id, delivery_due_day, ${leadDaysSql(table)} AS lead, ${boardDaySql(table)} AS board FROM t o`)
    .all() as Array<{ stage: string | null; status: string | null; delivery_method_id: string | null; delivery_due_day: string | null; lead: number; board: string | null }>;
  for (const r of rows) {
    const lead = leadDaysFor(r, table);
    const where = JSON.stringify(r);
    assert.equal(r.lead, lead, `lead ${where}`);
    assert.equal(r.board, boardDayOf(r.delivery_due_day, lead) || null, `board day ${where}`);
  }
  db.close();
  return rows.length;
}

test('the TypeScript reading equals the SQL, row for row', () => {
  assert.equal(twinRows(DELIVERY_LEAD), 19 * 8 * 10 * 5);
  // And for a table that is not the owner's: two days on the road, a slow method at three.
  assert.equal(twinRows({ default_days: 2, method_days: { personal: 0, pickup: 0, slow: 3 } }), 19 * 8 * 10 * 5);
});
