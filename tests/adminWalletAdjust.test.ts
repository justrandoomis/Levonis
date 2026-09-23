/**
 * «المستخدمين لا يمكن التعديل على رصيده مثل خصم رصيد وإضافة رصيد يدوي أو خصم
 *  النقاط وإضافة نقاط» — and «صحّحها بتسوية مسجّلة».
 *
 * The admin's hand on a member's wallet (worker/routes/adminWalletAdjust.ts)
 * run against the real migrations, with the member's OWN wallet page
 * (GET /api/wallet) as the witness: an admin credit of 50,000 د.ع must read
 * 50,000 there, not 49,994.
 *
 * Also the two older routes that minted money with only `requireAdmin`:
 * /api/wallet/admin/transactions/:id/adjustment and PUT /admin/withdrawal-fee.
 *
 * Run: node --import tsx --test tests/adminWalletAdjust.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asD1, stubApp, post, put, get, json, count, all, row } from './fixtures/app';
import { adminWalletAdjustRoutes } from '../worker/routes/adminWalletAdjust';
import { walletRoutes } from '../worker/routes/wallet';
import {
  applyRoundingDrift,
  legsNetIqd,
  manualWalletAdjust,
  netDebitCents,
  planDinarDebit,
  planDinarLegs,
  predictReading,
  rowDrift,
  scanRoundingDrift,
  withReadingCompensation,
} from '../worker/lib/walletAdjust';
import {
  advanceWithdrawal,
  createDepositRequest,
  decideDeposit,
  markWithdrawalPaid,
  requestWithdrawal,
} from '../worker/lib/walletOps';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { adjustedFigure, parseWholeAmount } from '../src/components/adminUsers/WalletAdjustPanel';

type Actor = 'asst' | 'boss' | 'full';

function world() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,admin_scope) VALUES
      ('asst','Assistant','asst@x.co','h','admin','assistant'),
      ('full','Finance','full@x.co','h','admin','full'),
      ('boss','Owner','boss@x.co','h','admin',NULL),
      ('target','Customer','t@x.co','h','customer',NULL),
      ('other','Other','o@x.co','h','customer',NULL);
  `);
  const db = asD1(raw);
  const as = (actor: Actor) =>
    stubApp(db, { id: actor, role: 'admin', email: `${actor}@x.co`, admin_scope: actor === 'asst' ? 'assistant' : actor === 'full' ? 'full' : null }, (a) => {
      a.route('/api/admin/wallet-adjust', adminWalletAdjustRoutes);
      a.route('/api/wallet', walletRoutes);
    });
  const customer = (id = 'target') =>
    stubApp(db, { id, role: 'customer', email: `${id}@x.co` }, (a) => a.route('/api/wallet', walletRoutes));
  /** What the member's own wallet page reads. */
  const walletPage = async (id = 'target') => json(await get(customer(id), '/api/wallet'));
  return { raw, db, as, walletPage };
}

let keySeq = 0;
const adjust = (extra: Record<string, unknown>) => ({
  kind: 'balance',
  direction: 'credit',
  reason: 'manual correction by owner',
  idempotencyKey: `adjust-key-${String(++keySeq).padStart(6, '0')}`,
  ...extra,
});
const ADJ = '/api/admin/wallet-adjust/users/target';

// ------------------------------------------------------------ the arithmetic

test('every planned change moves the dinars by exactly D, with no negative remainder and no zero-cent row', () => {
  for (const rate of [1400, 1500, 1310]) {
    for (let d = -3000; d <= 3000; d++) {
      if (d === 0) continue;
      const legs = planDinarLegs(d, rate);
      assert.ok(legs.length >= 1 && legs.length <= 2, `D=${d}`);
      assert.equal(legsNetIqd(legs), d, `D=${d} at ${rate}`);
      for (const l of legs) {
        assert.ok(Number.isInteger(l.cents) && l.cents > 0, `cents>0 for D=${d}`);
        assert.ok(l.amountIqd >= Math.floor((l.cents * rate) / 100), `remainder never negative for D=${d}`);
      }
    }
  }
});

test('a whole-balance debit that the exact plan cannot fund falls back to the cents on hand', () => {
  // 3,571 cents + a six-dinar remainder read 50,000; the exact plan wants 3,572.
  const legs = planDinarDebit(50_000, 1400, 3571);
  assert.deepEqual(legs, [{ type: 'withdrawal', cents: 3571, amountIqd: 50_000 }]);
});

test('rowDrift: a row 0108 already reads exactly has no drift', () => {
  const exact = rowDrift({ kind: 'deposit', cents: 3571, typedIqd: 50_000, recordedIqd: 50_000, rowRate: 1400, depositRequest: true, todayRate: 1400 });
  assert.equal(exact?.owed_iqd, 0);
  const noRate = rowDrift({ kind: 'deposit', cents: 3571, typedIqd: 50_000, recordedIqd: 50_000, rowRate: null, depositRequest: true, todayRate: 1400 });
  assert.equal(noRate?.owed_iqd, 6);
  const ceilWd = rowDrift({ kind: 'withdrawal', cents: 3572, typedIqd: 50_000, recordedIqd: 50_000, rowRate: 1400, depositRequest: false, todayRate: 1400 });
  assert.equal(ceilWd?.owed_iqd, 8);
  const notRounding = rowDrift({ kind: 'deposit', cents: 3000, typedIqd: 50_000, recordedIqd: null, rowRate: 1400, depositRequest: true, todayRate: 1400 });
  assert.equal(notRounding?.rounding, false);
});

// --------------------------------------------------------------- item C

test('crediting 50,000 IQD reads exactly 50,000 on the member’s own wallet page, audited with actor, before, after and reason', async () => {
  const { raw, as, walletPage } = world();
  const res = await post(as('boss'), ADJ, adjust({ amount_iqd: 50_000, idempotencyKey: 'credit-50000-0001' }));
  const out = await json(res);
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(out.before.balance_iqd, 0);
  assert.equal(out.after.balance_iqd, 50_000);
  const page = await walletPage();
  assert.equal(page.balance_iqd, 50_000, 'not 49,994');
  assert.equal(page.balance_usd_cents, 3571);
  const tx = row<{ amount: number; amount_iqd: number; exchange_rate_snapshot: number; created_by: string; decided_by: string }>(
    raw, "SELECT amount, amount_iqd, exchange_rate_snapshot, created_by, decided_by FROM wallet_transactions WHERE user_id='target'"
  );
  assert.deepEqual(tx, { amount: 3571, amount_iqd: 50_000, exchange_rate_snapshot: 1400, created_by: 'admin', decided_by: 'boss' });
  const audits = all<{ actor_id: string; target: string; detail: string }>(raw, "SELECT actor_id, target, detail FROM audit_log WHERE action='wallet.manual_adjust'");
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor_id, 'boss');
  assert.equal(audits[0].target, 'target');
  const detail = JSON.parse(audits[0].detail);
  assert.equal(detail.before, 0);
  assert.equal(detail.after, 50_000);
  assert.equal(detail.reason, 'manual correction by owner');
});

test('a debit of the whole 50,000 empties the wallet exactly; a debit beyond the balance is refused and writes nothing', async () => {
  const { raw, as, walletPage } = world();
  const app = as('boss');
  assert.equal((await post(app, ADJ, adjust({ amount_iqd: 50_000 }))).status, 200);

  const over = await post(app, ADJ, adjust({ direction: 'debit', amount_iqd: 50_001 }));
  const overOut = await json(over);
  assert.equal(over.status, 409, JSON.stringify(overOut));
  assert.equal(overOut.code, 'INSUFFICIENT_BALANCE');
  assert.equal(count(raw, "SELECT COUNT(*) n FROM wallet_transactions WHERE user_id='target'"), 1, 'nothing written');
  assert.equal((await walletPage()).balance_iqd, 50_000);

  const whole = await post(app, ADJ, adjust({ direction: 'debit', amount_iqd: 50_000 }));
  assert.equal(whole.status, 200, JSON.stringify(await json(whole)));
  const page = await walletPage();
  assert.equal(page.balance_iqd, 0);
  assert.equal(page.balance_usd_cents, 0);
});

test('a partial debit and a credit under one cent both land exactly', async () => {
  const { as, walletPage } = world();
  const app = as('full');
  await post(app, ADJ, adjust({ amount_iqd: 100_000 }));
  await post(app, ADJ, adjust({ direction: 'debit', amount_iqd: 25_000 }));
  assert.equal((await walletPage()).balance_iqd, 75_000);
  await post(app, ADJ, adjust({ amount_iqd: 6 }));
  assert.equal((await walletPage()).balance_iqd, 75_006);
  await post(app, ADJ, adjust({ direction: 'debit', amount_iqd: 8 }));
  assert.equal((await walletPage()).balance_iqd, 74_998);
});

test('points: added, deducted, and a deduction beyond the points refused', async () => {
  const { raw, as, walletPage } = world();
  const app = as('boss');
  assert.equal((await post(app, ADJ, adjust({ kind: 'points', points: 100 }))).status, 200);
  const over = await post(app, ADJ, adjust({ kind: 'points', direction: 'debit', points: 150 }));
  const overOut = await json(over);
  assert.equal(over.status, 409, JSON.stringify(overOut));
  assert.equal(overOut.code, 'INSUFFICIENT_POINTS');
  const ok = await json(await post(app, ADJ, adjust({ kind: 'points', direction: 'debit', points: 40 })));
  assert.equal(ok.after.points, 60);
  assert.equal((await walletPage()).point_balance, 60);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM wallet_transactions WHERE currency='POINT'"), 2);
});

test('an assistant admin is refused every money route: 403 FINANCIAL_SCOPE_REQUIRED and nothing is written', async () => {
  const { raw, as } = world();
  const app = as('asst');
  for (const [path, body] of [
    [ADJ, adjust({ amount_iqd: 50_000 })],
    ['/api/admin/wallet-adjust/rounding-drift/apply', { confirm: 'APPLY', fingerprint: 'x'.repeat(24) }],
  ] as const) {
    const res = await post(app, path, body);
    assert.equal(res.status, 403, path);
    assert.equal((await json(res)).code, 'FINANCIAL_SCOPE_REQUIRED');
  }
  const scan = await get(app, '/api/admin/wallet-adjust/rounding-drift');
  assert.equal(scan.status, 403);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM wallet_transactions'), 0);
});

test('a reason is required, and the idempotency key replays instead of crediting twice', async () => {
  const { raw, as, walletPage } = world();
  const app = as('boss');
  const noReason = await post(app, ADJ, adjust({ amount_iqd: 1000, reason: 'ok' }));
  assert.equal(noReason.status, 400);
  const a = await json(await post(app, ADJ, adjust({ amount_iqd: 50_000, idempotencyKey: 'same-key-000001' })));
  const b = await json(await post(app, ADJ, adjust({ amount_iqd: 50_000, idempotencyKey: 'same-key-000001' })));
  assert.equal(a.replayed, false);
  assert.equal(b.replayed, true);
  assert.equal(a.id, b.id);
  assert.equal((await walletPage()).balance_iqd, 50_000, 'not doubled');
  assert.equal(count(raw, "SELECT COUNT(*) n FROM audit_log WHERE action='wallet.manual_adjust'"), 1);
  const reused = await post(app, ADJ, adjust({ amount_iqd: 1, idempotencyKey: 'same-key-000001' }));
  assert.equal(reused.status, 409);
  assert.equal((await json(reused)).code, 'IDEMPOTENCY_KEY_REUSED');
});

// ------------------------------------------- the two older money routes

test('the legacy transaction adjustment: assistant refused, and a debit beyond the balance cannot push it negative', async () => {
  const { raw, as } = world();
  raw.exec(`INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status) VALUES ('wtx_orig','target','deposit','USD',1000,'approved')`);
  const path = '/api/wallet/admin/transactions/wtx_orig/adjustment';
  const asst = await post(as('asst'), path, { direction: 'credit', amountCents: 100_000_000, reason: 'mint money', eventKey: 'k-asst' });
  assert.equal(asst.status, 403);
  assert.equal((await json(asst)).code, 'FINANCIAL_SCOPE_REQUIRED');

  const over = await post(as('boss'), path, { direction: 'debit', amountCents: 1001, reason: 'too much', eventKey: 'k-over' });
  const overOut = await json(over);
  assert.equal(over.status, 409, JSON.stringify(overOut));
  assert.equal(overOut.code, 'INSUFFICIENT_BALANCE');
  assert.equal(count(raw, "SELECT COUNT(*) n FROM wallet_transactions WHERE user_id='target'"), 1);

  const fine = await post(as('boss'), path, { direction: 'debit', amountCents: 1000, reason: 'exact refund back', eventKey: 'k-ok' });
  assert.equal(fine.status, 200);
});

test('PUT /admin/withdrawal-fee: an assistant cannot change the commission', async () => {
  const { raw, as } = world();
  const res = await put(as('asst'), '/api/wallet/admin/withdrawal-fee', { fee_bps: 5000 });
  assert.equal(res.status, 403);
  assert.equal((await json(res)).code, 'FINANCIAL_SCOPE_REQUIRED');
  assert.equal(count(raw, "SELECT COUNT(*) n FROM admin_settings WHERE key='withdrawalFeeBps'"), 0);
  assert.equal((await put(as('boss'), '/api/wallet/admin/withdrawal-fee', { fee_bps: 300 })).status, 200);
});

// ------------------------------------------------- «فحص فروقات التقريب»

async function seedDrift(raw: ReturnType<typeof freshDb>, db: D1Database, env: { DB: D1Database }) {
  // (1) target: typed 50,000, credited 3,571 cents with NO recorded rate —
  //     the ledger reads 49,994 and nothing restores the six.
  raw.exec(`
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status) VALUES ('wtx_floor','target','deposit','USD',3571,'approved');
    INSERT INTO wallet_deposit_meta (tx_id,user_id,declared_amount_cents,declared_amount_iqd) VALUES ('wtx_floor','target',3571,50000);
  `);
  // (2) target: an exact modern deposit — 0108 already reads it as 50,000.
  const exact = await createDepositRequest(db, {
    userId: 'target', amountCents: 3571, receiptKey: 'r/1', reference: 'EXACT-1', provider: 'zain', channel: 'c',
    declaredAmountIqd: 50_000, exchangeRateSnapshot: 1400,
  });
  assert.ok(exact.ok);
  await decideDeposit(env as never, { requestId: exact.ok ? exact.txId : '', action: 'approve', actorUserId: 'boss', reason: 'ok', source: 'site' });
  // (3) target: a CEIL withdrawal — typed 50,000, debited 3,572 cents = 50,008.
  const wd = await requestWithdrawal(db, {
    userId: 'target', amountCents: 3572, destination: { kind: 'zain', account: '0770' }, eventKey: 'wd-ceil',
    declaredAmountIqd: 50_000, exchangeRateSnapshot: 1400,
  });
  assert.ok(wd.ok, JSON.stringify(wd));
  const wdId = wd.ok ? wd.id : '';
  await advanceWithdrawal(db, { id: wdId, to: 'approved', actorId: 'boss' });
  await advanceWithdrawal(db, { id: wdId, to: 'processing', actorId: 'boss' });
  const paid = await markWithdrawalPaid(db, { id: wdId, payoutReference: 'REF-1', actorId: 'boss' });
  assert.ok(paid.ok, JSON.stringify(paid));
  // (4) other: a CEIL deposit — typed 50,000, credited 3,572 cents = 50,008.
  const ceil = await createDepositRequest(db, {
    userId: 'other', amountCents: 3572, receiptKey: 'r/2', reference: 'CEIL-1', provider: 'zain', channel: 'c',
    declaredAmountIqd: 50_000, exchangeRateSnapshot: 1400,
  });
  assert.ok(ceil.ok);
  await decideDeposit(env as never, { requestId: ceil.ok ? ceil.txId : '', action: 'approve', actorUserId: 'boss', reason: 'ok', source: 'site' });
}

test('the rounding check lists +6 for a floored deposit and +8 back for a ceiled withdrawal, and nothing for an exact row', async () => {
  const { raw, db, as, walletPage } = world();
  await seedDrift(raw, db, { DB: db });
  const before = (await walletPage()).balance_iqd;
  // 49,994 + 50,000 − 50,008 = 49,986; the member typed 50,000 + 50,000 − 50,000.
  assert.equal(before, 49_986);

  const scan = await json(await get(as('boss'), '/api/admin/wallet-adjust/rounding-drift'));
  assert.equal(scan.success, true, JSON.stringify(scan));
  const target = scan.members.find((m: { user_id: string }) => m.user_id === 'target');
  assert.ok(target, JSON.stringify(scan.members));
  const byTx = Object.fromEntries(target.rows.map((r: { tx_id: string; owed_iqd: number }) => [r.tx_id, r.owed_iqd]));
  assert.equal(byTx.wtx_floor, 6);
  assert.equal(Object.values(byTx).includes(8), true, 'the ceiled withdrawal owes 8 back');
  assert.equal(target.rows.length, 2, 'the exact deposit is not listed');
  assert.equal(target.apply_iqd, 14);
  const other = scan.members.find((m: { user_id: string }) => m.user_id === 'other');
  assert.equal(other.apply_iqd, -8, 'a ceiled deposit was over-credited by eight');

  // Nothing is written by the check.
  assert.equal(count(raw, "SELECT COUNT(*) n FROM wallet_transactions WHERE ref='rounding_drift'"), 0);

  // The typed phrase and the fingerprint are both required.
  const noPhrase = await post(as('boss'), '/api/admin/wallet-adjust/rounding-drift/apply', { confirm: 'yes', fingerprint: scan.fingerprint });
  assert.equal(noPhrase.status, 400);
  const stale = await post(as('boss'), '/api/admin/wallet-adjust/rounding-drift/apply', { confirm: 'تطبيق التسوية', fingerprint: 'deadbeefdeadbeef' });
  assert.equal(stale.status, 409);
  assert.equal((await json(stale)).code, 'PLAN_CHANGED');

  const applied = await json(
    await post(as('boss'), '/api/admin/wallet-adjust/rounding-drift/apply', { confirm: 'تطبيق التسوية', fingerprint: scan.fingerprint })
  );
  assert.equal(applied.success, true, JSON.stringify(applied));
  assert.equal((await walletPage()).balance_iqd, 50_000, 'exactly what the member typed: 50,000 + 50,000 − 50,000');
  assert.equal((await walletPage('other')).balance_iqd, 50_000, 'the ceiled deposit reads the 50,000 transferred');
  const audits = all<{ detail: string }>(raw, "SELECT detail FROM audit_log WHERE action='wallet.rounding_drift' AND target='target'");
  assert.equal(audits.length, 1);
  assert.equal(JSON.parse(audits[0].detail).reason, 'تسوية فروقات التقريب القديمة');
  const notes = all<{ note: string }>(raw, "SELECT note FROM wallet_transactions WHERE ref='rounding_drift'");
  assert.ok(notes.length >= 2 && notes.every((n) => n.note === 'تسوية فروقات التقريب القديمة'));

  // A second run finds nothing, and a replayed apply writes nothing.
  const again = await json(await get(as('boss'), '/api/admin/wallet-adjust/rounding-drift'));
  assert.deepEqual(again.members, []);
  const rows = count(raw, 'SELECT COUNT(*) n FROM wallet_transactions');
  const replay = await json(
    await post(as('boss'), '/api/admin/wallet-adjust/rounding-drift/apply', { confirm: 'APPLY', fingerprint: again.fingerprint })
  );
  assert.deepEqual(replay.results, []);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM wallet_transactions'), rows);
});

test('a debit correction never takes a balance below zero: it is capped and reported', async () => {
  const { raw, db, as, walletPage } = world();
  const ceil = await createDepositRequest(db, {
    userId: 'other', amountCents: 3572, receiptKey: 'r/2', reference: 'CEIL-2', provider: 'zain', channel: 'c',
    declaredAmountIqd: 50_000, exchangeRateSnapshot: 1400,
  });
  await decideDeposit({ DB: db } as never, { requestId: ceil.ok ? ceil.txId : '', action: 'approve', actorUserId: 'boss', reason: 'ok', source: 'site' });
  // The member has since spent every cent the deposit brought in.
  raw.exec(`INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status) VALUES ('wtx_spend','other','withdrawal','USD',3572,'approved')`);
  assert.equal((await walletPage('other')).balance_iqd, 0);
  const scan = await json(await get(as('boss'), '/api/admin/wallet-adjust/rounding-drift'));
  const other = scan.members.find((m: { user_id: string }) => m.user_id === 'other');
  assert.equal(other.outstanding_iqd, -8);
  assert.equal(other.apply_iqd, 0);
  assert.equal(other.capped, true);
  const applied = await json(
    await post(as('boss'), '/api/admin/wallet-adjust/rounding-drift/apply', { confirm: 'APPLY', fingerprint: scan.fingerprint })
  );
  assert.deepEqual(applied.results, []);
  assert.equal((await walletPage('other')).balance_iqd, 0);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM wallet_transactions WHERE ref='rounding_drift'"), 0);
});

// ------------------------------- a wallet whose own remainder is off-reading

/**
 * Dinar-less legacy credit, then a checkout-style spend that recorded its
 * dinars: the raw remainder is −10, the page reads the plain cents (25,004).
 */
function seedNegativeRemainder(raw: ReturnType<typeof freshDb>, user = 'target') {
  raw.exec(`
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,created_by) VALUES ('legacy_${user}','${user}','deposit','USD',3571,'approved','admin');
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,created_by,amount_iqd,exchange_rate_snapshot)
      VALUES ('spend_${user}','${user}','withdrawal','USD',1785,'approved','system',25000,1400);
  `);
}

test('the compensation pair and the prediction: the reading moves by exactly D whatever the wallet’s own remainder', () => {
  for (const before of [
    { available_cents: 1786, dust_iqd: -10 },
    { available_cents: 1786, dust_iqd: -700 },
    { available_cents: 0, dust_iqd: 9 },
    { available_cents: 3571, dust_iqd: 6 },
  ]) {
    const b = { ...before, balance_iqd: predictReading(before, [], 1400).balance_iqd };
    for (const d of [6, 13, 14, 50_000, -8, -10_000]) {
      if (b.balance_iqd + d < 0 || (b.available_cents === 0 && d < 14)) continue;
      const legs = withReadingCompensation(d > 0 ? planDinarLegs(d, 1400) : planDinarDebit(-d, 1400, b.available_cents)!, b, 1400);
      assert.equal(predictReading(b, legs, 1400).balance_iqd, b.balance_iqd + d, `${JSON.stringify(b)} D=${d}`);
      assert.equal(legsNetIqd(legs.filter((l) => !l.comp)), d, 'the change’s own legs record exactly D');
      assert.equal(netDebitCents(legs.filter((l) => l.comp)), 0, 'the pair moves no cents');
    }
  }
});

test('a credit of 50,000 on a wallet whose remainder is negative moves the member’s page by exactly 50,000, and the audit says what the page reads', async () => {
  const { raw, as, walletPage } = world();
  seedNegativeRemainder(raw);
  const before = (await walletPage()).balance_iqd;
  assert.equal(before, 25_004);
  const res = await post(as('boss'), ADJ, adjust({ amount_iqd: 50_000 }));
  const out = await json(res);
  assert.equal(res.status, 200, JSON.stringify(out));
  const after = (await walletPage()).balance_iqd;
  assert.equal(after - before, 50_000, 'not 49,994');
  assert.equal(out.after.balance_iqd, after);
  const detail = JSON.parse(row<{ detail: string }>(raw, "SELECT detail FROM audit_log WHERE action='wallet.manual_adjust'")!.detail);
  assert.equal(detail.after, after);
  // The admin's own row records the 50,000 typed; the pair is apart from it.
  const own = all<{ amount_iqd: number; ref: string }>(raw, "SELECT amount_iqd, ref FROM wallet_transactions WHERE id LIKE 'wtx_madj_%' AND ref = 'admin:boss'");
  assert.deepEqual(own.map((r) => r.amount_iqd), [50_000]);

  const debit = await post(as('boss'), ADJ, adjust({ direction: 'debit', amount_iqd: 10_000 }));
  assert.equal(debit.status, 200);
  assert.equal((await walletPage()).balance_iqd, after - 10_000);
});

test('a result the ledger cannot show is refused and writes nothing: a debit leaving under one cent, a sub-cent credit to an empty wallet', async () => {
  const { raw, as, walletPage } = world();
  const app = as('boss');
  await post(app, ADJ, adjust({ amount_iqd: 25_000 }));
  await post(app, ADJ, adjust({ amount_iqd: 25_000 }));
  assert.equal((await walletPage()).balance_iqd, 50_000);
  const rows = count(raw, 'SELECT COUNT(*) n FROM wallet_transactions');
  const audits = count(raw, "SELECT COUNT(*) n FROM audit_log WHERE action='wallet.manual_adjust'");
  const nearly = await post(app, ADJ, adjust({ direction: 'debit', amount_iqd: 49_990 }));
  const nearlyOut = await json(nearly);
  assert.equal(nearly.status, 409, JSON.stringify(nearlyOut));
  assert.equal(nearlyOut.code, 'AMOUNT_UNREPRESENTABLE');
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM wallet_transactions'), rows);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM audit_log WHERE action='wallet.manual_adjust'"), audits);
  assert.equal((await walletPage()).balance_iqd, 50_000);

  const { as: as2, walletPage: page2 } = world();
  const tiny = await post(as2('boss'), ADJ, adjust({ amount_iqd: 10 }));
  assert.equal(tiny.status, 409);
  assert.equal((await json(tiny)).code, 'AMOUNT_UNREPRESENTABLE');
  assert.equal((await page2()).balance_iqd, 0);
});

test('a second submit with the same key that passed the pre-check in a race writes no second audit row and answers as a replay', async () => {
  const { raw, db, as, walletPage } = world();
  const key = 'race-key-000001';
  assert.equal((await post(as('boss'), ADJ, adjust({ amount_iqd: 50_000, idempotencyKey: key }))).status, 200);
  // The racing submit read no prior rows: its pre-check ran before the winner's batch landed.
  let missed = false;
  const racing = new Proxy(db, {
    get(target, prop, recv) {
      if (prop !== 'prepare') return Reflect.get(target, prop, recv);
      return (sql: string) => {
        const stmt = target.prepare(sql);
        if (!missed && sql.includes('WHERE id IN (?1, ?2)')) {
          missed = true;
          return { bind: () => ({ all: async () => ({ results: [] }) }) } as unknown as D1PreparedStatement;
        }
        return stmt;
      };
    },
  }) as D1Database;
  const res = await manualWalletAdjust({ DB: racing } as never, {
    actorId: 'boss', userId: 'target', kind: 'balance', direction: 'credit', amount: 50_000,
    reason: 'manual correction by owner', idempotencyKey: key, rate: 1400,
  });
  assert.ok(missed);
  assert.equal(res.ok && res.replayed, true, JSON.stringify(res));
  assert.equal(count(raw, "SELECT COUNT(*) n FROM audit_log WHERE action='wallet.manual_adjust'"), 1);
  assert.equal((await walletPage()).balance_iqd, 50_000);
});

test('a rounding correction on a wallet whose remainder is negative moves the page by the owed dinars; one with no cents behind it is not marked done', async () => {
  const { raw, db, as, walletPage } = world();
  // target: a floored deposit (+6 owed), then a spend that recorded its dinars.
  raw.exec(`
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status) VALUES ('wtx_floor','target','deposit','USD',3571,'approved');
    INSERT INTO wallet_deposit_meta (tx_id,user_id,declared_amount_cents,declared_amount_iqd) VALUES ('wtx_floor','target',3571,50000);
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,created_by,amount_iqd,exchange_rate_snapshot)
      VALUES ('spend_t','target','withdrawal','USD',1785,'approved','system',25000,1400);
  `);
  // other: a floored deposit, since spent to the last cent with no dinars recorded.
  raw.exec(`
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status) VALUES ('wtx_floor_o','other','deposit','USD',3571,'approved');
    INSERT INTO wallet_deposit_meta (tx_id,user_id,declared_amount_cents,declared_amount_iqd) VALUES ('wtx_floor_o','other',3571,50000);
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status) VALUES ('spend_o','other','withdrawal','USD',3571,'approved');
  `);
  const before = (await walletPage()).balance_iqd;
  assert.equal(before, 25_004);
  const scan = await json(await get(as('boss'), '/api/admin/wallet-adjust/rounding-drift'));
  const t = scan.members.find((m: { user_id: string }) => m.user_id === 'target');
  assert.equal(t.apply_iqd, 6);
  assert.equal(t.balance_iqd, 25_004, 'the batched balance read agrees with the member’s page');
  const applied = await json(
    await post(as('boss'), '/api/admin/wallet-adjust/rounding-drift/apply', { confirm: 'APPLY', fingerprint: scan.fingerprint })
  );
  const byUser = Object.fromEntries(applied.results.map((r: { user_id: string; status: string }) => [r.user_id, r.status]));
  assert.equal(byUser.target, 'applied');
  assert.equal(byUser.other, 'unrepresentable');
  assert.equal((await walletPage()).balance_iqd, before + 6, 'not +0');
  const detail = JSON.parse(row<{ detail: string }>(raw, "SELECT detail FROM audit_log WHERE action='wallet.rounding_drift'")!.detail);
  assert.equal(detail.after, before + 6);
  const again = await json(await get(as('boss'), '/api/admin/wallet-adjust/rounding-drift'));
  assert.deepEqual(again.members.map((m: { user_id: string }) => m.user_id), ['other'], 'the unwritten one stays listed');
  void db;
});

test('the rounding apply pages its members, and the same list applied twice writes one audit per member', async () => {
  const { raw, db } = world();
  raw.exec(`
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status) VALUES ('f1','target','deposit','USD',3571,'approved'), ('f2','other','deposit','USD',3571,'approved');
    INSERT INTO wallet_deposit_meta (tx_id,user_id,declared_amount_cents,declared_amount_iqd) VALUES ('f1','target',3571,50000), ('f2','other',3571,50000);
  `);
  const env = { DB: db } as never;
  const scan = await scanRoundingDrift(env, 1400);
  assert.equal(scan.members.length, 2);
  const first = await applyRoundingDrift(env, 'boss', scan, { limit: 1 });
  assert.equal(first.results.length, 1);
  assert.equal(first.remaining, 1);
  // Two admins on the same list: the second finds its rows already there.
  const second = await applyRoundingDrift(env, 'full', scan);
  assert.deepEqual(second.results.map((r) => r.status).sort(), ['already_applied', 'applied']);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM audit_log WHERE action='wallet.rounding_drift'"), 2);
  assert.deepEqual((await scanRoundingDrift(env, 1400)).members, []);
});

// ----------------------------------------------------- the screens use it
//
// This repository has no DOM runner, so the WIRING is asserted over the source
// (the way tests/adminUserModal.test.ts pins the modal): a server route no
// screen calls is the failure this project keeps shipping.

const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');

test('the review shows the resulting figure, and the amount parser takes Arabic digits and separators', () => {
  assert.equal(adjustedFigure(49_994, 'credit', 6), 50_000);
  assert.equal(adjustedFigure(50_000, 'debit', 50_000), 0);
  assert.equal(adjustedFigure(10, 'debit', 11), -1);
  assert.equal(adjustedFigure(10, 'credit', NaN), null);
  assert.equal(parseWholeAmount('٥٠,٠٠٠'), 50_000);
  assert.equal(parseWholeAmount('50,000'), 50_000);
  assert.ok(Number.isNaN(parseWholeAmount('12.5')));
  assert.ok(Number.isNaN(parseWholeAmount('-5')));
});

test('the member window mounts the adjustment control behind the server’s financial answer and reloads after it', () => {
  const modal = src('src/components/adminUsers/MemberDetailModal.tsx');
  assert.match(modal, /\{view\.financial && \(\s*<Section[\s\S]*?<WalletAdjustPanel/, 'mounted only when the server sent `financial`');
  assert.match(modal, /onDone=\{\(\) => void load\(m\.identity\.id\)\}/, 'the window reloads from the server after an adjustment');
  assert.match(modal, /balanceIqd=\{[\s\S]*?view\.financial\.wallet_iqd/, 'the review starts from the dinars the member reads');

  const panel = src('src/components/adminUsers/WalletAdjustPanel.tsx');
  assert.match(panel, /api\.post<[^>]+>\(`\/api\/admin\/wallet-adjust\/users\/\$\{encodeURIComponent\(userId\)\}`/);
  for (const field of ['kind', 'direction', 'amount_iqd', 'points', 'reason', 'idempotencyKey']) {
    assert.ok(panel.includes(field), `the body carries ${field}, the field the route reads`);
  }
  assert.match(panel, /setReview\(\{ key: newIdempotencyKey\(\) \}\)/, 'one key per reviewed adjustment, so a double press replays');
  const strings = src('src/components/adminUsers/strings.ts');
  assert.ok(strings.includes("adjTitle: loc('تعديل الرصيد والنقاط'"));
});

test('the rounding tool is mounted in the wallet settings and calls the dry run, then the apply with phrase and fingerprint', () => {
  assert.match(src('worker/index.ts'), /app\.route\('\/api\/admin\/wallet-adjust', adminWalletAdjustRoutes\)/);
  const settings = src('src/components/AdminWalletSettings.tsx');
  assert.match(settings, /<RoundingDriftTool \/>/);
  const tool = src('src/components/adminWallet/RoundingDriftTool.tsx');
  assert.ok(tool.includes("api.get<DriftScan>('/api/admin/wallet-adjust/rounding-drift')"));
  assert.match(tool, /const confirm = phrase\.trim\(\);/);
  assert.match(tool, /api\.post<ApplyResult>\('\/api\/admin\/wallet-adjust\/rounding-drift\/apply', \{\s*confirm,\s*fingerprint: current\.fingerprint,/);
  // What was not written stays visible: listed by name, and the table re-scanned.
  assert.match(tool, /if \(r\.status !== 'applied'\) skipped\.push/);
  assert.match(tool, /data-drift-not-applied/);
  assert.match(tool, /current = await api\.get<DriftScan>\('\/api\/admin\/wallet-adjust\/rounding-drift'\);[\s\S]*?if \(!res\.remaining \|\| wrote === 0\) break;[\s\S]*?setScan\(current\)/);
  assert.ok(!tool.includes('setScan(null)'), 'the list is never cleared after applying');
  assert.ok(tool.includes('فحص فروقات التقريب') && tool.includes('تطبيق التسوية'));
});
