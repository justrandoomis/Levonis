/** PRO-only BNPL: eligibility plus the database's concurrent credit fence. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asD1 } from './fixtures/app';
import {
  bnplCancellationStatement,
  bnplChargeStatement,
  bnplEligibility,
  bnplOutstanding,
  bnplRepaymentStatement,
  sweepBnplOverdue,
} from '../worker/lib/bnpl';

const FUTURE = '2099-01-01T00:00:00.000Z';
const PAST = '2020-01-01T00:00:00.000Z';

function setup() {
  const raw = freshDb();
  const db = asD1(raw);
  raw.exec(`
    INSERT INTO users (id,email,password_hash) VALUES
      ('plus','plus@x.co','h'), ('premium','premium@x.co','h'),
      ('pro','pro@x.co','h'), ('expired','expired@x.co','h');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at) VALUES
      ('m_plus','plus','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','${FUTURE}'),
      ('m_premium','premium','prime_12mo','prime','active',12,'2026-01-01T00:00:00.000Z','${FUTURE}'),
      ('m_pro','pro','pro_12mo','pro','active',12,'2026-01-01T00:00:00.000Z','${FUTURE}'),
      ('m_expired','expired','pro_12mo','pro','active',12,'2019-01-01T00:00:00.000Z','${PAST}');
  `);
  for (const user of ['plus', 'premium', 'pro', 'expired']) {
    raw.prepare(
      `INSERT INTO addresses (id,user_id,label,name,phone,address,is_default)
       VALUES (?,?,'Home','Customer','+9647701234567','Baghdad, Karrada',1)`
    ).run(`addr_${user}`, user);
    raw.prepare(
      `INSERT INTO approved_addresses
         (id,user_id,version,name,phone_e164,address,state,source_address_id,approved_by,approved_at)
       VALUES (?,?,1,'Customer','+9647701234567','Baghdad, Karrada','approved',?,'admin','2026-01-01T00:00:00.000Z')`
    ).run(`approved_${user}`, user, `addr_${user}`);
    raw.prepare(
      "INSERT INTO kyc_cases (id,user_id,state,decided_at) VALUES (?,?,'verified','2026-01-01T00:00:00.000Z')"
    ).run(`kyc_${user}`, user);
    raw.prepare("INSERT INTO bnpl_accounts (user_id,state,credit_limit_iqd,approved_by) VALUES (?,'approved',100000,'admin')")
      .run(user);
  }
  return { raw, db };
}

test('BNPL is denied to PLUS/PREMIUM/expired accounts and enabled only for an eligible PRO', async () => {
  const { raw, db } = setup();
  assert.equal((await bnplEligibility(db, 'plus', undefined, 40_000)).reason, 'PRO_REQUIRED');
  assert.equal((await bnplEligibility(db, 'premium', undefined, 40_000)).reason, 'PRO_REQUIRED');
  assert.equal((await bnplEligibility(db, 'expired', undefined, 40_000)).reason, 'PRO_REQUIRED');

  const pro = await bnplEligibility(db, 'pro', undefined, 40_000);
  assert.equal(pro.eligible, true);
  assert.equal(pro.available_iqd, 100_000);
  assert.equal(pro.identity_verified, true);
  assert.equal(pro.approved_address, true);

  raw.exec("DELETE FROM kyc_cases WHERE user_id='pro'");
  assert.equal((await bnplEligibility(db, 'pro', undefined, 40_000)).reason, 'IDENTITY_VERIFICATION_REQUIRED');
  raw.exec("INSERT INTO kyc_cases (id,user_id,state,decided_at) VALUES ('kyc_pro_2','pro','verified','2026-01-01T00:00:00.000Z')");

  assert.equal(
    (await bnplEligibility(db, 'pro', { id: 'other', name: 'Other', phone: '+9647700000000', address: 'Basra' }, 40_000)).reason,
    'APPROVED_ADDRESS_REQUIRED'
  );
  raw.exec("UPDATE bnpl_accounts SET state='requested' WHERE user_id='pro'");
  assert.equal((await bnplEligibility(db, 'pro', undefined, 40_000)).reason, 'BNPL_NOT_APPROVED');
});

function order(raw: ReturnType<typeof freshDb>, id: string, amount: number) {
  raw.prepare(
    `INSERT INTO orders
       (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
        subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,bnpl_due_iqd,bnpl_due_at)
     VALUES (?,'pro','pending',?,'personal','{}','bnpl',?,0,1400,?,0,?,'2026-10-11T12:00:00.000Z')`
  ).run(
    id,
    JSON.stringify({ id: 'addr_pro', name: 'Customer', phone: '+9647701234567', address: 'Baghdad, Karrada' }),
    amount,
    amount,
    amount
  );
}

test('charges, repayments, cancellation and the credit limit are immutable and idempotent', async () => {
  const { raw, db } = setup();
  order(raw, 'ORD-BNPL-1', 60_000);
  await bnplChargeStatement(db, {
    userId: 'pro', orderId: 'ORD-BNPL-1', amountIqd: 60_000,
    dueAt: '2026-10-11T12:00:00.000Z', createdAt: '2026-09-11T12:00:00.000Z',
  }).run();
  assert.equal(await bnplOutstanding(db, 'pro'), 60_000);
  assert.equal((await bnplEligibility(db, 'pro')).available_iqd, 40_000);

  await assert.rejects(
    bnplChargeStatement(db, {
      userId: 'pro', orderId: 'ORD-BNPL-1', amountIqd: 60_000,
      dueAt: '2026-10-11T12:00:00.000Z', createdAt: '2026-09-11T12:00:01.000Z',
    }).run(),
    /UNIQUE/
  );
  order(raw, 'ORD-BNPL-2', 50_000);
  await assert.rejects(
    bnplChargeStatement(db, {
      userId: 'pro', orderId: 'ORD-BNPL-2', amountIqd: 50_000,
      dueAt: '2026-10-11T12:00:00.000Z', createdAt: '2026-09-11T12:00:02.000Z',
    }).run(),
    /BNPL_LIMIT_EXCEEDED/
  );

  await bnplRepaymentStatement(db, {
    userId: 'pro', amountIqd: 20_000, idempotencyKey: 'repay-0001', createdAt: '2026-09-12T12:00:00.000Z',
  }).run();
  assert.equal(await bnplOutstanding(db, 'pro'), 40_000);
  await assert.rejects(
    bnplRepaymentStatement(db, {
      userId: 'pro', amountIqd: 20_000, idempotencyKey: 'repay-0001', createdAt: '2026-09-12T12:00:01.000Z',
    }).run(),
    /UNIQUE/
  );
  await assert.rejects(
    bnplRepaymentStatement(db, {
      userId: 'pro', amountIqd: 40_001, idempotencyKey: 'repay-too-much', createdAt: '2026-09-12T12:00:02.000Z',
    }).run(),
    /BNPL_REPAYMENT_EXCEEDS_DEBT/
  );

  await bnplCancellationStatement(db, 'pro', 'ORD-BNPL-1', '2026-09-13T12:00:00.000Z').run();
  await bnplCancellationStatement(db, 'pro', 'ORD-BNPL-1', '2026-09-13T12:00:01.000Z').run();
  assert.equal(await bnplOutstanding(db, 'pro'), 0);
  assert.equal(
    (raw.prepare("SELECT COUNT(*) AS n FROM bnpl_ledger WHERE idempotency_key='cancel:ORD-BNPL-1'").get() as { n: number }).n,
    1
  );

  // A repayment/cancellation credit must not let the next charge exceed the
  // configured line: application and trigger both clamp outstanding at zero.
  order(raw, 'ORD-BNPL-3', 110_000);
  await assert.rejects(
    bnplChargeStatement(db, {
      userId: 'pro', orderId: 'ORD-BNPL-3', amountIqd: 110_000,
      dueAt: '2026-10-13T12:00:00.000Z', createdAt: '2026-09-13T12:00:02.000Z',
    }).run(),
    /BNPL_LIMIT_EXCEEDED/
  );
});

test('the overdue sweep suspends once, audits once, and remains retry-safe', async () => {
  const { raw, db } = setup();
  order(raw, 'ORD-BNPL-LATE', 35_000);
  await bnplChargeStatement(db, {
    userId: 'pro',
    orderId: 'ORD-BNPL-LATE',
    amountIqd: 35_000,
    dueAt: '2026-09-01T12:00:00.000Z',
    createdAt: '2026-08-01T12:00:00.000Z',
  }).run();

  const first = await sweepBnplOverdue(db, '2026-09-11T12:00:00.000Z');
  assert.deepEqual(first, { scanned: 1, overdue: 1, suspended: 1 });
  assert.equal(
    (raw.prepare("SELECT state FROM bnpl_accounts WHERE user_id='pro'").get() as { state: string }).state,
    'suspended'
  );
  assert.equal(
    (raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='bnpl.overdue_suspend'").get() as { n: number }).n,
    1
  );

  const retry = await sweepBnplOverdue(db, '2026-09-11T12:00:00.000Z');
  assert.deepEqual(retry, { scanned: 1, overdue: 1, suspended: 0 });
  assert.equal(
    (raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='bnpl.overdue_suspend'").get() as { n: number }).n,
    1
  );
});
