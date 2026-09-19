/**
 * WHAT THE CHECKOUT RECORDS MUST BE WHAT THE CHECKOUT WROTE.
 *
 * «أثناء الشراء» — a PRO earns double on a purchase. The accrual ROW already
 * carried that: the INSERT resolves the multiplier inside the checkout
 * transaction and writes 1,500 where a free customer gets 750. So does every
 * customer-facing surface, which reads that row back.
 *
 * THE AUDIT TRAIL DID NOT. `buildPurchaseAccrualStatements` is synchronous and
 * therefore cannot look up a membership, so the plan it hands back reports
 * `base_points` — the figure BEFORE the multiplier — while the statement it
 * hands back writes the multiplied one. worker/routes/orders.ts wrote that
 * plan's `points` into the `order.create` audit record, so the order ledger
 * said 750 for a purchase that accrued 1,500.
 *
 * Nobody is short-changed by this, which is exactly why it survived: the money
 * was always right. But the audit log is where a points dispute is settled —
 * an admin asked "why does this member have 1,500 points" reads the record of
 * the purchase, and the record disagreed with the ledger by a factor of two on
 * every subscriber order ever placed. A trail that is wrong in the customer's
 * favour is still a trail that cannot be trusted to settle the next argument.
 *
 * So the assertion is not "the number is 1,500". It is that THE RECORD AND THE
 * ROW ARE THE SAME NUMBER, for a PRO and for a customer with no subscription
 * alike — a defect of this shape cannot hide behind a fixture whose multiplier
 * happens to be 1.
 *
 * The real checkout route runs against real migrations; only the session is
 * stubbed.
 * Run: npx tsx --test tests/checkoutPointsPromise.test.ts
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
import { orderRoutes } from '../worker/routes/orders';
import { acceptedPolicies } from './lib/policies';
import { resetPolicyCorpusMemo } from '../worker/lib/policySync';

function setup() {
  // A NEW DATABASE IS A NEW ARCHIVE. `ensurePolicyCorpus` memoises a COMPLETED
  // mirror per isolate, and one test process is one isolate holding many
  // databases: without this, the first database in the run gets the policy
  // rows and every later one is skipped as already-synced, so checkout refuses
  // consent it cannot bind to a row. tests/fixtures/app.ts#dbThrough does the
  // same for the fixtures it builds; this file builds its own.
  resetPolicyCorpusMemo();
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) raw.exec(readFileSync(join(dir, f), 'utf8'));
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('plain','Sara','s@x.co','h','customer'),
      ('pro','Omar','o@x.co','h','customer');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default) VALUES
      ('addr_plain','plain','Home','Sara','+9647701234567','Baghdad, Karrada 12','',1),
      ('addr_pro','pro','Home','Omar','+9647709876543','Erbil, Ankawa 4','',1);
    INSERT INTO approved_addresses (id,user_id,version,name,phone_e164,address,landmark,state)
      VALUES ('ap_pro','pro',1,'Omar','+9647709876543','Erbil, Ankawa 4','','approved');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,starts_at,expires_at)
      VALUES ('m_pro','pro','pro_12mo','pro','active',12,499000,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z');
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,images)
      VALUES ('p_pla','pla-basic','PLA Basic','PLA أساسي',25000,'active',50,'[]','[]','direct_sale','["direct_sale"]','[]');
  `);
  for (const [id, user] of [['ci_plain', 'plain'], ['ci_pro', 'pro']] as const) {
    raw
      .prepare(
        `INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty)
         VALUES (?,?, 'p_pla','','[]','','','','',3)`
      )
      .run(id, user);
  }
  return { raw, db: new SqliteD1(raw) as unknown as D1Database };
}

const pending: Promise<unknown>[] = [];
const ctx = {
  waitUntil: (p: Promise<unknown>) => {
    pending.push(p.catch(() => undefined));
  },
  passThroughOnException() {},
} as unknown as ExecutionContext;

function appAs(db: D1Database, userId: string) {
  const a = new Hono<AppContext>();
  a.use('*', async (c, next) => {
    c.set('user', { id: userId, role: 'customer', email: `${userId}@x.co`, username: userId } as never);
    c.env = { DB: db } as never;
    await next();
  });
  a.route('/api/orders', orderRoutes);
  a.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ success: false, error: err.message, code: err.code, details: err.details ?? null }, err.status as 400);
    }
    throw err;
  });
  return a;
}

let seq = 0;
async function checkout(db: D1Database, user: string, addressId: string) {
  const res = await appAs(db, user).request(
    '/api/orders',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        addressId,
        deliveryMethodId: 'standard',
        paymentMethodId: 'cash',
        useWallet: false,
        usePoints: false,
        itemIds: [],
        idempotencyKey: `pts-${user}-${++seq}`,
        policyAcceptance: acceptedPolicies(),
      }),
    },
    undefined,
    ctx
  );
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* left empty; `text` carries the failure into the assertion message */
  }
  await Promise.all(pending.splice(0));
  return { status: res.status, body, text };
}

/** The `order.create` audit detail — the permanent record of the purchase. */
function auditDetail(raw: DatabaseSync, orderId: string): Record<string, unknown> {
  const row = raw
    .prepare("SELECT detail FROM audit_log WHERE action = 'order.create' AND target = ?")
    .get(orderId) as { detail: string } | undefined;
  assert.ok(row, `no order.create audit record for ${orderId}`);
  return JSON.parse(row.detail) as Record<string, unknown>;
}

const accrualRow = (raw: DatabaseSync, orderId: string) =>
  raw
    .prepare(
      `SELECT points, base_points, multiplier_x100, tier_at_award
         FROM points_accruals WHERE order_id = ? AND kind = 'purchase'`
    )
    .get(orderId) as
    | { points: number; base_points: number; multiplier_x100: number; tier_at_award: string }
    | undefined;

test('a PRO purchase is RECORDED with the points it actually accrued', async () => {
  const { raw, db } = setup();
  const res = await checkout(db, 'pro', 'addr_pro');
  assert.equal(res.status, 200, res.text);
  const orderId = String((res.body.order as { id: string }).id);
  const row = accrualRow(raw, orderId);
  assert.ok(row, 'the purchase created a pending accrual');
  assert.equal(row.multiplier_x100, 200, 'PRO');
  assert.equal(row.tier_at_award, 'pro');
  assert.ok(row.base_points > 0, `the fixture must actually earn points — got ${row.base_points}`);
  assert.equal(row.points, row.base_points * 2, 'the row itself doubled the award');

  // THE DEFECT: this was row.base_points — half of what the member received.
  const detail = auditDetail(raw, orderId);
  assert.equal(typeof detail.points_pending, 'number', 'the record states a points figure at all');
  assert.equal(
    detail.points_pending,
    row.points,
    `the audit record says ${String(detail.points_pending)} but the ledger holds ${row.points}`
  );
  // And it says whose multiplier it was, so the record explains itself.
  assert.equal(detail.tier, 'pro');
});

test('a customer with no subscription is recorded exactly as before', async () => {
  const { raw, db } = setup();
  const res = await checkout(db, 'plain', 'addr_plain');
  assert.equal(res.status, 200, res.text);
  const orderId = String((res.body.order as { id: string }).id);
  const row = accrualRow(raw, orderId)!;
  assert.equal(row.multiplier_x100, 100);
  assert.equal(row.points, row.base_points, 'no membership, no multiplication');
  assert.equal(auditDetail(raw, orderId).points_pending, row.points);
});

test('the PRO and the plain customer bought the identical cart, and the record shows double', async () => {
  // Both carts are three spools of the same product at the same price, so the
  // ONLY difference between the two records is the subscription. This is the
  // ratio «2x أي ضعف النقاط» stated as an assertion rather than as a constant.
  const { raw, db } = setup();
  const pro = await checkout(db, 'pro', 'addr_pro');
  const plain = await checkout(db, 'plain', 'addr_plain');
  assert.equal(pro.status, 200, pro.text);
  assert.equal(plain.status, 200, plain.text);
  const proDetail = auditDetail(raw, String((pro.body.order as { id: string }).id));
  const plainDetail = auditDetail(raw, String((plain.body.order as { id: string }).id));
  const proPts = proDetail.points_pending;
  const plainPts = plainDetail.points_pending;
  // Guarded: NaN === NaN under Object.is, so an absent field would otherwise
  // satisfy the ratio below without either number ever existing.
  assert.equal(typeof proPts, 'number');
  assert.equal(typeof plainPts, 'number');
  assert.ok(Number(plainPts) > 0, 'the plain customer earned something to compare against');
  assert.equal(
    accrualRow(raw, String((pro.body.order as { id: string }).id))!.base_points,
    accrualRow(raw, String((plain.body.order as { id: string }).id))!.base_points,
    'same cart, same base'
  );
  assert.equal(Number(proPts), Number(plainPts) * 2);
});
