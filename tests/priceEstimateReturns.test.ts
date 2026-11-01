/**
 * RETURN REFUNDS ON AN ORDER WITH A LINE SETTLED AT ITS OWN FINAL PRICE
 * (docs/SMART_PRICING.md §6.9; migration 0218; review finding orders-1).
 *
 * The order: A (an estimated printer, sold at 1,000,000) and B (an accessory,
 * 100,000), shipping 5,000, cash on delivery, delivered, both inspected for
 * return. The refund reads the same per-line attribution as price protection
 * and trade-in (worker/lib/paidNet.ts `estimateLineAdjustments`):
 *
 *   APPROVED      A approved at 1,200,000 (+200,000 moved): A refunds
 *                 1,200,000 and B its own 100,000 — the shift is A's alone.
 *   CANCEL-OUT    A confirmed +20,000, B confirmed −20,000, no money moved:
 *                 each line refunds its own final price.
 *   ABSORBED      A confirmed +200,000 under an edited total that kept the
 *                 order's total: no money moved, so nothing is refunded for it.
 *   PAST ITS GOODS A's own 600,000 coupon is larger than its approved final
 *                 550,000: A was paid nothing, and the goods the order kept
 *                 (50,000) are B's — never more than the order took.
 *   AS BEFORE     no estimate rows (an ordinary +200,000 proposal), or a
 *                 database without 0218: the adjustment is spread by net
 *                 goods exactly as it always was (118,182 and 1,181,818).
 *   UNREADABLE    the estimate records cannot be read: 503
 *                 PRICE_ESTIMATES_READ_FAILED, nothing written — the same
 *                 answer the price-protection claim door gives.
 *
 * Run: node --import tsx --test tests/priceEstimateReturns.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, dbThrough, json, post, row, stubApp, withoutTriggers, type StubUser } from './fixtures/app';
import { applyRate } from './fixtures/fx';
import { priceProtectionRoutes, returnRoutes } from '../worker/routes/returns';

const RATE = 1400;
const ADMIN: StubUser = { id: 'boss', role: 'admin', email: 'a@x.co' };
const BUYER: StubUser = { id: 'buyer', role: 'customer', email: 's@x.co' };

type Settlement = 'none' | 'approved' | 'cancel_out' | 'absorbed' | 'past_goods';

/** Each settlement: the accepted adjustment, the estimate rows (customer prices only), shipping and A's own coupon. */
interface Variant {
  adjustment: number;
  rows: Array<[string, string, number, string, number, string | null]>;
  shipping?: number;
  couponA?: number;
}
const SETTLED: Record<Exclude<Settlement, 'none'>, Variant> = {
  approved: { adjustment: 200_000, rows: [['oi_a', 'pA', 1_000_000, 'approved', 1_200_000, 'padj_seeded000000000000000']] },
  cancel_out: {
    adjustment: 0,
    rows: [
      ['oi_a', 'pA', 1_000_000, 'confirmed', 1_020_000, null],
      ['oi_b', 'pB', 100_000, 'confirmed', 80_000, null],
    ],
  },
  absorbed: { adjustment: 0, rows: [['oi_a', 'pA', 1_000_000, 'confirmed', 1_200_000, null]] },
  past_goods: {
    adjustment: -450_000,
    shipping: 50_000,
    couponA: 600_000,
    rows: [['oi_a', 'pA', 1_000_000, 'approved', 550_000, 'padj_seeded000000000000000']],
  },
};

function seed(settlement: Settlement, through: string | null = null): DatabaseSync {
  const raw = dbThrough(through);
  applyRate(raw, 'USD_IQD', String(RATE));
  // An ordinary 0140 proposal of +200,000 when there are no estimate rows.
  const v: Variant = settlement === 'none' ? { adjustment: 200_000, rows: [] } : SETTLED[settlement];
  const shipping = v.shipping ?? 5000;
  const couponA = v.couponA ?? 0;
  const total = 1_100_000 + shipping - couponA + v.adjustment;
  const coupon = couponA ? `'{"coupon_id":"cp_a","code":"A600","discount_iqd":${couponA}}'` : 'NULL';
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','s@x.co','h','customer'), ('boss','Admin','a@x.co','h','admin');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('exchangeRate','${RATE}');
    INSERT INTO products (id,slug,name,price_iqd,status,stock,inventory_mode,selling_type,sale_types) VALUES
      ('pA','pa','Printer',1000000,'active',10,'BASE','pre_order','["pre_order"]'),
      ('pB','pb','Accessory',100000,'active',10,'BASE','pre_order','["pre_order"]');
    INSERT INTO orders (id,user_id,status,stage,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                        subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,price_adjustment_iqd,coupon_snapshot,delivered_at)
      VALUES ('ORD-E','buyer','delivered','delivered','{}','standard','{}','cod',1100000,${shipping},${RATE},${total},${total},${v.adjustment},${coupon},'2026-06-01T00:00:00.000Z');
    INSERT INTO order_items (id,order_id,product_id,name_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd,option_id,option_value_ids,color_id,coupon_discount_iqd)
      VALUES ('oi_a','ORD-E','pA','Printer','',1,1000000,1000000,'','[]','',${couponA}),
             ('oi_b','ORD-E','pB','Accessory','',1,100000,100000,'','[]','',0);
    INSERT INTO return_cases (id,order_id,order_item_id,user_id,qty,reason,state,within_window,delivered_at_snapshot)
      VALUES ('rc_a','ORD-E','oi_a','buyer',1,'defective','inspected',1,'2026-06-01T00:00:00.000Z'),
             ('rc_b','ORD-E','oi_b','buyer',1,'defective','inspected',1,'2026-06-01T00:00:00.000Z');
  `);
  if (v.rows.length) {
    // Checkout writes these rows (T7); a delivered order is seeded here, so the insert guard is lifted for them alone.
    const values = v.rows
      .map(([item, product, est, state, fin, adj]) => `('${item}','ORD-E','${product}','','pre_order_sea',1,${est},1,'${state}',${fin},${adj ? `'${adj}'` : 'NULL'},'boss','2026-05-02T10:00:00Z','2026-05-01T10:00:00Z')`)
      .join(',');
    withoutTriggers(
      raw,
      ['trg_ope_insert_guard'],
      `INSERT INTO order_price_estimates (order_item_id,order_id,product_id,combo_key,channel,qty,estimate_unit_iqd,notice_version,state,final_unit_iqd,adjustment_id,decided_by,decided_at,created_at) VALUES ${values}`
    );
  }
  return raw;
}

const adminApp = (db: D1Database) =>
  stubApp(db, ADMIN, (a) => {
    a.route('/api/returns', returnRoutes);
  });

type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function refund(db: D1Database, caseId: string): Promise<{ status: number; body: Rec }> {
  const res = await post(adminApp(db), `/api/returns/admin/${caseId}/transition`, { to: 'resolved', resolution: 'refund' });
  return { status: res.status, body: await json(res) };
}

/** Both lines returned, B first: each refund as the server computed it, and the wallet credit beside it. */
async function refunds(raw: DatabaseSync, db: D1Database = asD1(raw)): Promise<{ a: number; b: number }> {
  const out: Record<string, number> = {};
  for (const [line, caseId] of [['b', 'rc_b'], ['a', 'rc_a']] as const) {
    const r = await refund(db, caseId);
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 400));
    out[line] = Number(r.body.refund?.amount_iqd);
    // A refund of 0 IQD writes no wallet row.
    const credit = row<{ amount_iqd: number }>(raw, 'SELECT amount_iqd FROM wallet_transactions WHERE id = ?', `wtx_ret_${caseId}`);
    assert.equal(credit?.amount_iqd ?? 0, out[line], `the wallet credit of ${caseId} is the refund`);
  }
  return { a: out.a, b: out.b };
}

/** A binding that refuses every read of the estimate records with `failure`, and runs every other statement. */
function refusingEstimates(db: D1Database, failure: string): D1Database {
  const refuse = async () => {
    throw new Error(failure);
  };
  return {
    prepare: (sql: string) =>
      sql.includes('order_price_estimates')
        ? { bind: () => ({ all: refuse, first: refuse, run: refuse, raw: refuse }), all: refuse, first: refuse, run: refuse, raw: refuse }
        : db.prepare(sql),
    batch: (s: D1PreparedStatement[]) => db.batch(s),
    exec: (q: string) => db.exec(q),
  } as unknown as D1Database;
}

// =========================================================================

test('APPROVED: the estimated line refunds its final price and the firm line its own charge — the shift is never spread', async () => {
  const got = await refunds(seed('approved'));
  // Before the fix the +200,000 was spread by net goods: B 118,182 for an item paid 100,000, A 1,181,818 of 1,200,000.
  assert.deepEqual(got, { a: 1_200_000, b: 100_000 });
  assert.ok(got.a + got.b <= 1_305_000, 'never more than the order took');
});

test('CANCEL-OUT: lines confirmed at finals that net to zero (no money moved) refund their own final prices', async () => {
  // Before the fix both refunded their estimates (1,000,000 and 100,000), though B was confirmed at 80,000.
  assert.deepEqual(await refunds(seed('cancel_out')), { a: 1_020_000, b: 80_000 });
});

test('ABSORBED: a confirmed final whose edited total kept the order total moved no money, so the refunds stay as charged', async () => {
  assert.deepEqual(await refunds(seed('absorbed')), { a: 1_000_000, b: 100_000 });
});

test('PAST ITS GOODS: a line cut below its own coupon was paid nothing; the goods the order kept are the other line\u2019s', async () => {
  // Spread by net goods (before the fix) this read A 40,000 and B 10,000. Either way the goods kept are 50,000.
  assert.deepEqual(await refunds(seed('past_goods')), { a: 0, b: 50_000 });
});

test('AS BEFORE: an order without estimate rows spreads its accepted adjustment by net goods, exactly as it always did', async () => {
  assert.deepEqual(await refunds(seed('none')), { a: 1_181_818, b: 118_182 });
});

test('AS BEFORE: a database without 0218 refunds exactly what a migrated one without estimate rows does', async () => {
  const raw = seed('none', '0217');
  assert.equal(row(raw, "SELECT 1 AS x FROM sqlite_master WHERE name = 'order_price_estimates'"), undefined, 'no 0218 here');
  assert.deepEqual(await refunds(raw), { a: 1_181_818, b: 118_182 });
});

test('UNREADABLE: estimate records that cannot be read refuse the refund (503 PRICE_ESTIMATES_READ_FAILED) the way the claim door does, writing nothing', async () => {
  const raw = seed('approved');
  const db = refusingEstimates(asD1(raw), 'D1_ERROR: database is locked');
  const res = await refund(db, 'rc_b');
  assert.equal(res.status, 503, JSON.stringify(res.body).slice(0, 300));
  assert.equal(res.body.code, 'PRICE_ESTIMATES_READ_FAILED');
  assert.equal(row<{ state: string }>(raw, "SELECT state FROM return_cases WHERE id = 'rc_b'")!.state, 'inspected', 'the case did not move');
  assert.equal(row(raw, "SELECT 1 AS x FROM wallet_transactions WHERE id = 'wtx_ret_rc_b'"), undefined, 'no credit was written');

  // The claim door, on the same binding, gives the same answer.
  const claim = await post(stubApp(db, BUYER, (a) => a.route('/api/price-protection', priceProtectionRoutes)), '/api/price-protection/claims', { orderItemId: 'oi_b' });
  const claimBody = await json(claim);
  assert.equal(claim.status, 503);
  assert.equal(claimBody.code, res.body.code);
  assert.equal(claimBody.error, res.body.error);

  // A database that has no such table is not «unreadable»: it simply has no estimate line.
  const old = refusingEstimates(asD1(seed('none')), 'D1_ERROR: no such table: order_price_estimates: SQLITE_ERROR');
  const ok = await refund(old, 'rc_b');
  assert.equal(ok.status, 200, JSON.stringify(ok.body).slice(0, 300));
  assert.equal(ok.body.refund.amount_iqd, 118_182);
});
