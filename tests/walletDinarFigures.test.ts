/**
 * «المحفظة: كتابة 50 ألف يظهر 50,008؛ اجعل العملة العراقية هي الأساس
 *  والافتراضية. السحب: وسائل الاستلام نفس القنوات (كي كارد، الرافدين، زين
 *  كاش، استلام كاش) مع عمولة سحب 3% قابلة للتغيير من لوحة الإدارة.»
 *
 * THE REST OF THE WALLET PAGE, IN THE DINARS THE CUSTOMER TYPED. The header
 * read 50,000 since migration 0108; the four figures under it, the operations
 * list, the withdrawal form, the admin member card and the payout card did
 * not. Every assertion below runs the REAL routes over EVERY migration, with
 * only the session stubbed — the same harness tests/walletDinarSpend.test.ts
 * uses — because each of these was a server figure some screen then had to
 * print, and the defect was always on one side of that line or the other.
 *
 * Run: node --import tsx --test tests/walletDinarFigures.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, json, post, put, get, pending, row, count, type App } from './fixtures/app';
import { walletRoutes, withdrawalAnnouncement } from '../worker/routes/wallet';
import { adminRoutes } from '../worker/routes/admin';
import {
  createDepositRequest,
  readWalletDust,
  resolvePayoutChannel,
  walletIqdAvailable,
  walletLedgerDinarsReady,
  withdrawalReserveCents,
  type WithdrawalRow,
} from '../worker/lib/walletOps';
import { walletCreditStatement, walletTxPublic } from '../worker/lib/wallet';
import { DEFAULT_PAYOUT_METHODS, normalizePayoutMethods, getSetting } from '../worker/lib/settings';
import { iqdToUsdCents } from '../src/lib/api';
import { withdrawalClaim } from '../src/lib/walletWithdrawClaim';

const RATE = 1400;

function setup() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','s@x.co','h','customer'),
      ('boss','Owner','boss@x.co','h','admin');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('exchangeRate','${RATE}');
  `);
  return { raw, db: asD1(raw) };
}

const customer = (db: D1Database) =>
  stubApp(db, { id: 'buyer', role: 'customer', email: 's@x.co' }, (a) => a.route('/api/wallet', walletRoutes));
const owner = (db: D1Database) =>
  stubApp(db, { id: 'boss', role: 'admin', email: 'boss@x.co' }, (a) => {
    a.route('/api/admin', adminRoutes);
    a.route('/api/wallet', walletRoutes);
  });

/** A top-up filed the way the browser files it (floored cents + typed dinars). */
async function topUp(db: D1Database, raw: DatabaseSync, typedIqd: number, ref: string, approve = true) {
  const txId = `wtx_${ref}`;
  const res = await createDepositRequest(db, {
    userId: 'buyer',
    amountCents: iqdToUsdCents(typedIqd, RATE),
    receiptKey: `receipts/buyer/${ref}.png`,
    provider: 'zaincash',
    channel: 'app',
    reference: ref,
    declaredAmountIqd: typedIqd,
    exchangeRateSnapshot: RATE,
    txId,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  if (approve) raw.prepare("UPDATE wallet_transactions SET status = 'approved' WHERE id = ?").run(txId);
  return txId;
}

const wallet = async (a: App) => json(await get(a, '/api/wallet'));

let seq = 0;
const withdraw = (a: App, typedIqd: number, extra: Record<string, unknown> = {}) =>
  post(a, '/api/wallet/withdrawals', {
    amount_usd_cents: iqdToUsdCents(typedIqd, RATE),
    declared_amount_iqd: typedIqd,
    destinationKind: 'zaincash',
    destinationAccount: '07701234567',
    idempotencyKey: `wd-test-${++seq}`,
    ...extra,
  });

// ------------------------------------------------------------ E1 (a) tiles

test('a typed 50,000 under review reads 50,000 in «إيداعات قيد المراجعة», not 49,994', async () => {
  const { db, raw } = setup();
  await topUp(db, raw, 50_000, 'P1', false);
  const w = await wallet(customer(db));
  assert.equal(w.balances.usd_cents_pending_deposits, 3571);
  assert.equal(w.balances.iqd_pending_deposits, 50_000);
});

test('after approval «الرصيد المسوّى» reads 50,000 — the same figure as the header', async () => {
  const { db, raw } = setup();
  await topUp(db, raw, 50_000, 'S1');
  const w = await wallet(customer(db));
  assert.equal(w.balance_iqd, 50_000);
  assert.equal(w.balances.iqd_settled, 50_000);
  assert.equal(w.balances.iqd_held, 0);
});

test('a withdrawal on hold reads its typed dinars in «محجوز» and «سحوبات مفتوحة», and settled does not move', async () => {
  const { db, raw } = setup();
  await topUp(db, raw, 100_000, 'H1');
  const a = customer(db);
  const res = await json(await withdraw(a, 50_000));
  assert.equal(res.success, true, JSON.stringify(res));
  const w = await wallet(a);
  assert.equal(w.balances.iqd_held, 50_000, 'held: the typed figure, not 49,994');
  assert.equal(w.balances.iqd_pending_withdrawals, 50_000);
  assert.equal(w.balances.iqd_settled, 100_000, 'a hold is not a settlement');
  assert.equal(w.balance_iqd, 50_000);
  await Promise.allSettled(pending);
});

// ------------------------------------------------------ E1 (b) operations

test('every ledger row carries its recorded dinars to the operations list', async () => {
  const { db, raw } = setup();
  await topUp(db, raw, 50_000, 'L1');
  const w = await wallet(customer(db));
  const dep = w.transactions.find((t: { id: string }) => t.id === 'wtx_L1');
  assert.equal(dep.amount_iqd, 50_000);
  assert.equal(dep.exchange_rate_snapshot, RATE);
  // And a row with no recorded dinars says so, rather than inventing them.
  assert.deepEqual(
    { a: walletTxPublic({ id: 'x', amount: 3571 }).amount_iqd, r: walletTxPublic({ id: 'x', amount: 3571 }).exchange_rate_snapshot },
    { a: null, r: null }
  );
  // The pair travels together or not at all.
  assert.equal(walletTxPublic({ id: 'x', amount: 1, amount_iqd: 14 }).amount_iqd, null);
});

// -------------------------------------------------------- E1 (d) refunds

test('a 50,000 return refund is credited so the wallet reads exactly 50,000 back', async () => {
  const { db } = setup();
  assert.equal(await walletLedgerDinarsReady(db), true);
  await walletCreditStatement(db, true, {
    id: 'wtx_ret_1', userId: 'buyer', cents: Math.floor((50_000 * 100) / RATE), note: 'Refund', ref: 'o1',
    nowIso: new Date().toISOString(), amountIqd: 50_000, rate: RATE,
  }).run();
  const w = await wallet(customer(db));
  assert.equal(w.balance_iqd, 50_000, 'not 49,994');
  assert.equal(w.transactions[0].amount_iqd, 50_000);
});

// ---------------------------------------------- E1 (e) whole-balance withdraw

test('two 25,000 deposits (3,570 cents) can withdraw the displayed 50,000', async () => {
  const { db, raw } = setup();
  await topUp(db, raw, 25_000, 'W2a');
  await topUp(db, raw, 25_000, 'W2b');
  const a = customer(db);
  assert.equal((await wallet(a)).balance_iqd, 50_000);

  const res = await json(await withdraw(a, 50_000));
  assert.equal(res.success, true, `the customer's own balance was refused: ${JSON.stringify(res)}`);
  assert.equal(res.withdrawal.amount_usd_cents, 3570, 'reserved at the cents on hand, not the 3,571 the floor asked for');
  assert.equal(res.withdrawal.declared_amount_iqd, 50_000, 'the typed figure is still what the request records');
  assert.equal((await wallet(a)).balance_iqd, 0, 'and the wallet then reads empty');
  await Promise.allSettled(pending);
});

test('in USD the displayed $35.71 of two 25,000 deposits can be withdrawn — the form and the server agree', async () => {
  const { db, raw } = setup();
  await topUp(db, raw, 25_000, 'U2a');
  await topUp(db, raw, 25_000, 'U2b');
  const a = customer(db);
  const w = await wallet(a);
  assert.equal(w.balances.usd_cents_available, 3570);
  assert.equal(w.balances.iqd_available, 50_000);
  // What the header and the form's «الرصيد المتاح» print in USD: the dinars floored.
  assert.equal(iqdToUsdCents(w.balances.iqd_available, RATE), 3571);

  // The form, in USD, with the displayed figure typed.
  const claim = withdrawalClaim({
    currency: 'USD', rawAmount: 35.71, amountCents: 3571,
    availableCents: w.balances.usd_cents_available, availableIqd: w.balances.iqd_available, exchangeRate: RATE,
  });
  assert.equal(claim.overBalance, false, 'the displayed balance is not «over the balance»');
  assert.deepEqual(claim.remaining, { cents: 0 });
  assert.equal(claim.declaredIqd, 50_000, 'it carries the dinars the displayed dollars stand for');

  // And the server takes exactly what the form sends.
  const res = await json(
    await post(a, '/api/wallet/withdrawals', {
      amount_usd_cents: 3571,
      declared_amount_iqd: claim.declaredIqd || undefined,
      destinationKind: 'zaincash',
      destinationAccount: '07701234567',
      idempotencyKey: `wd-test-${++seq}`,
    })
  );
  assert.equal(res.success, true, `the customer's own displayed balance was refused: ${JSON.stringify(res)}`);
  assert.equal(res.withdrawal.amount_usd_cents, 3570, 'reserved at the cents on hand');
  assert.equal((await wallet(a)).balance_iqd, 0);

  // A cent over the displayed dollars is still over, and still sends no claim.
  const over = withdrawalClaim({
    currency: 'USD', rawAmount: 35.72, amountCents: 3572, availableCents: 3570, availableIqd: 50_000, exchangeRate: RATE,
  });
  assert.deepEqual({ over: over.overBalance, d: over.declaredIqd }, { over: true, d: 0 });
  // Inside the ledger cents a dollar figure is its own number: no dinars sent.
  const inside = withdrawalClaim({
    currency: 'USD', rawAmount: 10, amountCents: 1000, availableCents: 3570, availableIqd: 50_000, exchangeRate: RATE,
  });
  assert.deepEqual({ over: inside.overBalance, d: inside.declaredIqd, r: inside.remaining }, { over: false, d: 0, r: { cents: 2571 } });
  // Between the cents and the whole balance: the fewest dinars that floor onto them.
  assert.equal(
    withdrawalClaim({ currency: 'USD', rawAmount: 35.71, amountCents: 3571, availableCents: 3570, availableIqd: 50_010, exchangeRate: RATE })
      .declaredIqd,
    49_994
  );
  // IQD is unchanged: the typed dinars against the dinar balance.
  assert.deepEqual(
    withdrawalClaim({ currency: 'IQD', rawAmount: 50_000, amountCents: 3571, availableCents: 3570, availableIqd: 50_000, exchangeRate: RATE }),
    { declaredIqd: 50_000, overBalance: false, remaining: { iqd: 0 } }
  );
  await Promise.allSettled(pending);
});

test('a withdrawal genuinely over the dinar balance is still refused', async () => {
  const { db, raw } = setup();
  await topUp(db, raw, 25_000, 'W3a');
  await topUp(db, raw, 24_000, 'W3b');
  const r = await withdraw(customer(db), 50_000);
  assert.equal(r.status >= 400, true);
  assert.equal(
    withdrawalReserveCents({ requestedCents: 3571, declaredIqd: 50_000, availableCents: 3500, dustIqd: 20, exchangeRate: RATE }),
    3571,
    'over the dinar balance: the request is left as asked and the hold refuses it'
  );
  assert.equal(
    withdrawalReserveCents({ requestedCents: 3571, declaredIqd: 50_000, availableCents: 3570, dustIqd: 20, exchangeRate: RATE }),
    3570
  );
  assert.equal(
    withdrawalReserveCents({ requestedCents: 3571, declaredIqd: null, availableCents: 3570, dustIqd: 20, exchangeRate: RATE }),
    3571,
    'no typed dinars, no cap'
  );
});

// ----------------------------------------------------- F payout channels

test('the four channels the owner named are the default, and a broken list reads as them', () => {
  assert.deepEqual(
    DEFAULT_PAYOUT_METHODS.map((m) => [m.name, m.requires_account]),
    [['كي كارد', true], ['مصرف الرافدين', true], ['زين كاش', true], ['استلام كاش', false]]
  );
  assert.deepEqual(normalizePayoutMethods([]), DEFAULT_PAYOUT_METHODS);
  assert.deepEqual(normalizePayoutMethods('junk'), DEFAULT_PAYOUT_METHODS);
  assert.deepEqual(
    normalizePayoutMethods([{ id: 'a', name: ' A ' }, { id: 'a', name: 'dup' }, { id: '', name: 'x' }, { id: 'c', name: 'C', requires_account: false }]),
    [{ id: 'a', name: 'A', requires_account: true }, { id: 'c', name: 'C', requires_account: false }]
  );
  assert.equal(resolvePayoutChannel('nope', DEFAULT_PAYOUT_METHODS), null);
  assert.equal(resolvePayoutChannel('zaincash', DEFAULT_PAYOUT_METHODS)?.label, 'زين كاش');
  // Only the owner's payout list decides what may be FILED — not a deposit
  // method, not a legacy id the step once offered.
  assert.equal(resolvePayoutChannel('fib', DEFAULT_PAYOUT_METHODS), null, 'FIB was never offered');
  assert.equal(resolvePayoutChannel('manual_transfer', DEFAULT_PAYOUT_METHODS), null);
});

test('a channel the owner removed can no longer be filed, whatever a stale tab still offers', async () => {
  const { db, raw } = setup();
  await topUp(db, raw, 200_000, 'RM1');
  // The owner deletes «زين كاش» in the admin editor, and publishes a deposit
  // method with the same id (the fallback that used to let it through).
  const edit = await json(
    await put(owner(db), '/api/admin/settings/payoutMethods', {
      value: [{ id: 'ki_card', name: 'كي كارد' }, { id: 'cash_pickup', name: 'استلام كاش', requires_account: false }],
    })
  );
  assert.equal(edit.success, true, JSON.stringify(edit));
  raw
    .prepare("INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('paymentMethods', ?)")
    .run(JSON.stringify([{ id: 'zaincash', name: 'زين كاش', accountNumber: '0770', accountName: 'Shop' }]));
  const a = customer(db);
  for (const kind of ['zaincash', 'fib', 'manual_transfer']) {
    const r = await withdraw(a, 50_000, { destinationKind: kind });
    assert.equal(r.status, 400, kind);
    assert.equal((await json(r)).code, 'UNKNOWN_PAYOUT_METHOD', kind);
  }
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM wallet_withdrawals WHERE user_id = 'buyer'"), 0, 'nothing was filed');
  const ki = await json(await withdraw(a, 50_000, { destinationKind: 'ki_card' }));
  assert.equal(ki.success, true, JSON.stringify(ki));
  await Promise.allSettled(pending);
});

test('cash pickup files with no account; Ki Card still needs one; the name is frozen on the request', async () => {
  const { db, raw } = setup();
  await topUp(db, raw, 200_000, 'C1');
  const a = customer(db);
  assert.deepEqual((await getSetting(db, 'payoutMethods')).map((m) => m.id), ['ki_card', 'rafidain', 'zaincash', 'cash_pickup']);

  const cash = await json(await withdraw(a, 50_000, { destinationKind: 'cash_pickup', destinationAccount: undefined }));
  assert.equal(cash.success, true, JSON.stringify(cash));
  assert.equal(cash.withdrawal.destination.label, 'استلام كاش');
  assert.equal(cash.withdrawal.destination.kind, 'cash_pickup');

  const noAccount = await withdraw(a, 50_000, { destinationKind: 'ki_card', destinationAccount: '' });
  assert.equal(noAccount.status, 400, 'a channel that needs an account still refuses one missing');

  const unknown = await json(await withdraw(a, 50_000, { destinationKind: 'invented' }));
  assert.equal(unknown.code, 'UNKNOWN_PAYOUT_METHOD');

  const ki = await json(await withdraw(a, 50_000, { destinationKind: 'ki_card', destinationAccount: '1234-5678' }));
  assert.equal(ki.success, true, JSON.stringify(ki));
  assert.equal(ki.withdrawal.destination.label, 'كي كارد');
  await Promise.allSettled(pending);
});

test('the dinar commission and payout the customer was quoted are recorded, and the admin card receives them', async () => {
  const { db, raw } = setup();
  await topUp(db, raw, 100_000, 'F1');
  const res = await json(await withdraw(customer(db), 50_000));
  assert.equal(res.success, true, JSON.stringify(res));
  // 3% of the typed 50,000 — exactly what the form promised.
  assert.equal(res.withdrawal.fee_iqd, 1_500);
  assert.equal(res.withdrawal.net_iqd, 48_500);
  const stored = row<{ destination_label: string; fee_iqd: number; net_iqd: number }>(
    raw, 'SELECT destination_label, fee_iqd, net_iqd FROM wallet_withdrawals WHERE id = ?', res.id
  )!;
  assert.deepEqual(stored, { destination_label: 'زين كاش', fee_iqd: 1_500, net_iqd: 48_500 });

  const list = await json(await get(owner(db), '/api/admin/wallet-requests'));
  const card = list.requests.find((t: { withdrawal?: { id: string } }) => t.withdrawal?.id === res.id);
  assert.ok(card, 'the request is on the admin list');
  assert.equal(card.withdrawal.destination_label, 'زين كاش', 'the reviewer sees which channel to pay through');
  assert.equal(card.withdrawal.destination_kind, 'zaincash');
  assert.equal(card.withdrawal.net_iqd, 48_500, 'not 48,496 at today’s rate');
  assert.equal(card.withdrawal.fee_iqd, 1_500);
  assert.equal(card.withdrawal.exchange_rate_snapshot, RATE);
  await Promise.allSettled(pending);
});

test('the Telegram line prints the channel by name and the commission in dinars', () => {
  const row = {
    declared_amount_iqd: 50_000, fee_cents: 107, net_cents: 3464, fee_iqd: 1_500, net_iqd: 48_500,
    destination_label: 'زين كاش', destination_kind: 'pm_1726',
  } as unknown as WithdrawalRow;
  const line = withdrawalAnnouncement({ number: 'WD-1', user: 'sara', amountCents: 3571, row, channelLabel: 'x' });
  assert.match(line, /Amount: 50,000 د\.ع \(ledger \$35\.71\)/);
  assert.match(line, /Commission: 1,500 د\.ع \(ledger \$1\.07\)/);
  assert.match(line, /To transfer: 48,500 د\.ع \(ledger \$34\.64\)/);
  assert.match(line, /Destination: زين كاش/);
  assert.doesNotMatch(line, /pm_1726/, 'never the raw id');
});

test('the owner edits the payout channels; an empty list is refused, not stored', async () => {
  const { db } = setup();
  const a = owner(db);
  const empty = await put(a, '/api/admin/settings/payoutMethods', { value: [] });
  assert.equal(empty.status, 400);
  const ok = await json(
    await put(a, '/api/admin/settings/payoutMethods', {
      value: [{ id: 'ki_card', name: 'كي كارد' }, { id: 'cash_pickup', name: 'استلام كاش', requires_account: false }],
    })
  );
  assert.equal(ok.success, true, JSON.stringify(ok));
  assert.deepEqual(await getSetting(db, 'payoutMethods'), [
    { id: 'ki_card', name: 'كي كارد', requires_account: true },
    { id: 'cash_pickup', name: 'استلام كاش', requires_account: false },
  ]);
});

// -------------------------------------------------- E1 (f) member detail

test('the admin member card reads the member’s own dinars — spendable, not settled converted', async () => {
  const { db, raw } = setup();
  await topUp(db, raw, 25_000, 'M1a');
  await topUp(db, raw, 25_000, 'M1b');
  const d = await json(await get(owner(db), '/api/admin/users/buyer/detail'));
  assert.equal(d.financial.wallet_usd_cents, 3570);
  assert.equal(d.financial.wallet_iqd, 50_000, 'not 49,980');
  assert.equal(
    d.financial.wallet_iqd,
    walletIqdAvailable(3570, (await readWalletDust(db, 'buyer')).dust_iqd, RATE),
    'the same function the member’s own wallet reads'
  );
});

test('both return-side credits write their dinars beside the cents', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { ROOT } = await import('./fixtures/d1');
  const src = readFileSync(join(ROOT, 'worker/routes/returns.ts'), 'utf8');
  assert.match(src, /walletCreditStatement\(c\.env\.DB, ledgerDinars, \{[\s\S]{0,300}amountIqd: walletRefundIqd,/, 'the return refund');
  assert.match(src, /walletCreditStatement\(c\.env\.DB, ledgerDinars, \{[\s\S]{0,300}amountIqd: credit,/, 'the price-protection credit');
  assert.doesNotMatch(src, /Math\.round\(\((walletRefundIqd|credit) \* 100\) \/ rate\)/, 'no rounding up into cents');
});
