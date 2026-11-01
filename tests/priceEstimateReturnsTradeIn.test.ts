/**
 * TRADE-IN VALUES A UNIT SETTLED AT ITS OWN FINAL PRICE AT THAT PRICE
 * (docs/SMART_PRICING.md §6.9; migration 0218; review finding orders-1).
 *
 * Sara's older order ORD-OLD (an A1 at 850,000, no estimate) and ORD-EST: an
 * A1 sold at an estimated 850,000 beside a P1S at 1,500,000, cash, delivered.
 * `GET /api/trade-in/eligible` values each unit from what was paid for it —
 * the same per-line attribution as the return refund and price protection
 * (worker/lib/paidNet.ts `estimateLineAdjustments`):
 *
 *   APPROVED     the A1 approved at 900,000 (+50,000 moved): A1 900,000 and
 *                the P1S its own 1,500,000 — the shift is the A1's alone.
 *   CANCEL-OUT   A1 confirmed +50,000, P1S confirmed −50,000, no money moved.
 *   ABSORBED     A1 confirmed +50,000 under an edited total that kept the
 *                total: no money moved, so both stay at their charges.
 *   AS BEFORE    no estimate rows (an ordinary +50,000 proposal), or a
 *                database without 0218: spread by net goods as it always was.
 *   UNREADABLE   503 PRICE_ESTIMATES_READ_FAILED, as the claim door answers.
 *
 * Run: node --import tsx --test tests/priceEstimateReturnsTradeIn.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, get, json, row, stubApp, withoutTriggers } from './fixtures/app';
import { tradeInRoutes } from '../worker/routes/tradeIn';
import { CUSTOMER, customerApp, daysAgo, restoreFetch, seed } from './sv2_tradein_fixture';

test.after(restoreFetch);

type Settlement = 'none' | 'approved' | 'cancel_out' | 'absorbed';

/** Each settlement's estimate rows: [item, product, estimate, state, final, proposal]. */
const ROWS: Record<Exclude<Settlement, 'none'>, Array<[string, string, number, string, number, string | null]>> = {
  approved: [['oi_e_a1', 'p_a1', 850_000, 'approved', 900_000, 'padj_seeded000000000000000']],
  cancel_out: [
    ['oi_e_a1', 'p_a1', 850_000, 'confirmed', 900_000, null],
    ['oi_e_p1s', 'p_p1s', 1_500_000, 'confirmed', 1_450_000, null],
  ],
  absorbed: [['oi_e_a1', 'p_a1', 850_000, 'confirmed', 900_000, null]],
};

function world(settlement: Settlement, through?: string): DatabaseSync {
  const raw = seed({ paid: 850_000, through });
  // An ordinary 0140 proposal of +50,000 when there are no estimate rows; the approved one moved the same.
  const adjustment = settlement === 'approved' || settlement === 'none' ? 50_000 : 0;
  const total = 2_350_000 + adjustment;
  const at = daysAgo(15);
  raw.exec(`
    INSERT INTO orders (id,user_id,status,stage,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                        subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,price_adjustment_iqd,created_at,updated_at,delivered_at) VALUES
      ('ORD-EST','cust','delivered','delivered','{}','standard','{}','cash',2350000,0,1400,${total},0,${adjustment},'${daysAgo(30)}','${at}','${at}');
    INSERT INTO order_items (id,order_id,product_id,name_snapshot,image_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd,option_id,option_value_ids) VALUES
      ('oi_e_a1','ORD-EST','p_a1','Bambu Lab A1','','A1',1,850000,850000,'v_a1','["v_a1"]'),
      ('oi_e_p1s','ORD-EST','p_p1s','Bambu Lab P1S','','',1,1500000,1500000,'','[]');
  `);
  if (settlement !== 'none') {
    // Checkout writes these rows (T7); a delivered order is seeded here, so the insert guard is lifted for them alone.
    const values = ROWS[settlement]
      .map(([item, product, est, state, fin, adj]) => `('${item}','ORD-EST','${product}','','pre_order_land',1,${est},1,'${state}',${fin},${adj ? `'${adj}'` : 'NULL'},'boss','${at}','${daysAgo(30)}')`)
      .join(',');
    withoutTriggers(
      raw,
      ['trg_ope_insert_guard'],
      `INSERT INTO order_price_estimates (order_item_id,order_id,product_id,combo_key,channel,qty,estimate_unit_iqd,notice_version,state,final_unit_iqd,adjustment_id,decided_by,decided_at,created_at) VALUES ${values}`
    );
  }
  return raw;
}

/** What trade-in values each unit at: line → paid_iqd. */
async function paid(app: ReturnType<typeof customerApp>): Promise<Record<string, number>> {
  const res = await get(app, '/api/trade-in/eligible');
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body).slice(0, 300));
  return Object.fromEntries((body.units as Array<{ order_item_id: string; paid_iqd: number }>).map((u) => [u.order_item_id, u.paid_iqd]));
}

// =========================================================================

test('APPROVED: the estimated A1 is valued at its approved final price and the P1S at its own charge', async () => {
  // Before the fix the +50,000 was spread by net goods: A1 868,085 and P1S 1,531,915.
  assert.deepEqual(await paid(customerApp(world('approved'))), { oi_a1: 850_000, oi_e_a1: 900_000, oi_e_p1s: 1_500_000 });
});

test('CANCEL-OUT: lines confirmed at finals that net to zero (no money moved) are valued at their final prices', async () => {
  // Before the fix both were valued at their estimates (850,000 and 1,500,000).
  assert.deepEqual(await paid(customerApp(world('cancel_out'))), { oi_a1: 850_000, oi_e_a1: 900_000, oi_e_p1s: 1_450_000 });
});

test('ABSORBED: a confirmed final whose edited total kept the order total moved no money, so both units keep their charges', async () => {
  assert.deepEqual(await paid(customerApp(world('absorbed'))), { oi_a1: 850_000, oi_e_a1: 850_000, oi_e_p1s: 1_500_000 });
});

test('AS BEFORE: orders without estimate rows spread their accepted adjustment by net goods, exactly as they always did', async () => {
  assert.deepEqual(await paid(customerApp(world('none'))), { oi_a1: 850_000, oi_e_a1: 868_085, oi_e_p1s: 1_531_915 });
});

test('AS BEFORE: a database without 0218 values every unit exactly as a migrated one without estimate rows does', async () => {
  const raw = world('none', '0217');
  assert.equal(row(raw, "SELECT 1 AS x FROM sqlite_master WHERE name = 'order_price_estimates'"), undefined, 'no 0218 here');
  assert.deepEqual(await paid(customerApp(raw)), { oi_a1: 850_000, oi_e_a1: 868_085, oi_e_p1s: 1_531_915 });
});

test('UNREADABLE: estimate records that cannot be read refuse the valuation (503 PRICE_ESTIMATES_READ_FAILED), as the claim door does', async () => {
  const inner = asD1(world('approved'));
  const refuse = async () => {
    throw new Error('D1_ERROR: database is locked');
  };
  const db = {
    prepare: (sql: string) =>
      sql.includes('order_price_estimates')
        ? { bind: () => ({ all: refuse, first: refuse, run: refuse, raw: refuse }), all: refuse, first: refuse, run: refuse, raw: refuse }
        : inner.prepare(sql),
    batch: (s: D1PreparedStatement[]) => inner.batch(s),
    exec: (q: string) => inner.exec(q),
  } as unknown as D1Database;
  const res = await get(stubApp(db, CUSTOMER, (a) => a.route('/api/trade-in', tradeInRoutes)), '/api/trade-in/eligible');
  const body = await json(res);
  assert.equal(res.status, 503, JSON.stringify(body).slice(0, 300));
  assert.equal(body.code, 'PRICE_ESTIMATES_READ_FAILED');
});
