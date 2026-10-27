/**
 * LEVONIS PRINT CLOUD — paying an order from the Levonis wallet, and refunding
 * it there (docs/PRINT_CLOUD.md §4.4; worker/lib/printCloud/wallet.ts).
 *
 * Real persisted records throughout: the customer's wallet is funded with
 * approved deposits that carry their dinar testimony (migration 0108), the
 * catalogue is built through the admin API, and the platform's own wallet
 * page (GET /api/wallet) is mounted beside Print Cloud so «the balance falls
 * by exactly the price» is read off the figure the customer actually sees.
 * Races run through RaceD1: a competing request finishes at the exact moment
 * the wallet batch is about to run.
 *
 * Run: node --import tsx --test tests/printCloudWallet.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { dbThrough, failingD1, stubApp, type App, type StubUser } from './fixtures/app';
import { RaceD1 } from './fixtures/raceD1';
import {
  ADMIN,
  API,
  CUSTOMER_A,
  CUSTOMER_B,
  PC_FULL,
  call,
  credits,
  idem,
  mountPrintCloud,
  ok,
  owned,
  pcWorld,
  reconcileClean,
  refused,
  row,
  rows,
  seedCatalog,
  type Catalog,
  type Json,
  type World,
} from './fixtures/printCloud';
import { walletRoutes } from '../worker/routes/wallet';
import { createWithdrawalHold, releaseHold, walletReconciliationReport } from '../worker/lib/walletOps';
import { pcWords } from '../worker/lib/printCloud/errors';
import { signGatewayPayload } from '../worker/lib/printCloud/payments';
import { expireUnpaidOrders } from '../worker/lib/printCloud/orders';

/** The rate every wallet below was funded at: a fresh database reads the legacy default (fx/officialRate.ts). */
const RATE = 1400;
const H = 3600;

interface Deposit {
  cents: number;
  /** The dinars the deposit recorded beside its cents (0108), at RATE. */
  iqd?: number;
}

let seq = 0;
/** Approved USD deposits as the ledger holds them, with their dinar testimony. */
function fund(raw: DatabaseSync, userId: string, deposits: Deposit[]): void {
  for (const d of deposits) {
    raw
      .prepare(
        `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at, amount_iqd, exchange_rate_snapshot)
         VALUES (?, ?, 'deposit', 'USD', ?, 'approved', 'test top-up', '', 'admin', '2026-10-01T00:00:00.000Z', ?, ?)`
      )
      .run(`wtx_seed_${++seq}`, userId, d.cents, d.iqd ?? null, d.iqd ? RATE : null);
  }
}

/**
 * 105,000 IQD in two transfers: 50,000 → 3,571 cents and 55,000 → 3,928
 * cents. Each floor left a remainder (6 and 8 IQD), so the wallet page reads
 * 14 × 7,499 + 14 = 105,000 — the contract's own example.
 */
const WALLET_105K: Deposit[] = [
  { cents: 3571, iqd: 50_000 },
  { cents: 3928, iqd: 55_000 },
];

/** Print Cloud and the platform wallet page on one database, for one signed-in user. */
const withWallet = (w: World, user: StubUser): App =>
  stubApp(
    w.db,
    user,
    (a) => {
      mountPrintCloud(a);
      a.route('/api/wallet', walletRoutes);
    },
    { env: w.env, publishV2: false }
  );

/** The figure the Levonis wallet page prints. */
async function walletPage(app: App): Promise<{ balance_iqd: number; transactions: Json[] }> {
  const r = await call(app, 'GET', '/api/wallet');
  assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 300));
  return r.json as { balance_iqd: number; transactions: Json[] };
}

const meWallet = async (app: App): Promise<Json> => ok(app, 'GET', `${API}/me/wallet`);

const pay = (app: App, orderId: string, key: Record<string, string> = idem('pay')) => call(app, 'POST', `${API}/orders/${orderId}/pay/wallet`, {}, key);

/** Quote → order placed for the wallet. */
async function placeOrder(app: App, lines: unknown[], method = 'levonis_wallet'): Promise<{ orderId: string; total: number }> {
  const quote = await ok(app, 'POST', `${API}/quotes`, { lines });
  const order = await ok(app, 'POST', `${API}/orders`, { quote_id: quote.quote_id, payment_method: method }, idem('order'));
  return { orderId: order.order_id, total: order.total_iqd };
}

/** 24 printing hours (36,000) and a 1 kg spool of white PLA (24,250): 60,250 IQD — the contract's example. */
const ORDER_60K = (cat: Catalog) => [
  { kind: 'credit_package', package_id: cat.packages.h24 },
  { kind: 'material', variant_id: cat.white, quantity: 1000 },
];

async function setWalletPayments(w: World, enabled: boolean): Promise<void> {
  const s = await ok(w.owner, 'GET', `${ADMIN}/settings`);
  await ok(w.owner, 'PATCH', `${ADMIN}/settings`, { version: s.version, config: { wallet_payment_enabled: enabled } });
}

const count = (w: World, sql: string, ...params: unknown[]) => Number(row<{ n: number }>(w, sql, ...params)?.n ?? 0);
const debitsOf = (w: World, orderId: string) => count(w, "SELECT COUNT(*) AS n FROM wallet_transactions WHERE ref = ? AND type = 'withdrawal'", orderId);
/** Everything a refused payment must leave untouched. */
const footprint = (w: World) => ({
  wallet: count(w, 'SELECT COUNT(*) AS n FROM wallet_transactions'),
  events: count(w, 'SELECT COUNT(*) AS n FROM pc_payment_events'),
  confirmed: count(w, "SELECT COUNT(*) AS n FROM pc_payments WHERE status = 'confirmed'"),
  operations: count(w, "SELECT COUNT(*) AS n FROM pc_operations WHERE scope = 'order.pay.wallet'"),
  lots: count(w, 'SELECT COUNT(*) AS n FROM pc_credit_lots'),
  audit: count(w, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'print_cloud.order.paid'"),
});

async function walletWorld(): Promise<{ w: World; cat: Catalog; app: App }> {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  fund(w.raw, CUSTOMER_A.id, WALLET_105K);
  return { w, cat, app: withWallet(w, CUSTOMER_A) };
}

/** The wallet batch: the one that writes the order's debit. */
const walletBatch = (sqls: string[]) => sqls.some((s) => s.includes('INSERT INTO wallet_transactions'));

// ------------------------------------------------------------------ reading the wallet

test('GET /me/wallet: the wallet page figure, the official rate, and `connected` as the owner set it', async () => {
  const { w, app } = await walletWorld();
  const me = await meWallet(app);
  assert.deepEqual(me, { connected: true, available_iqd: 105_000, exchange_rate: RATE });
  assert.equal((await walletPage(app)).balance_iqd, me.available_iqd, 'the SAME dinar figure the wallet page shows');
  assert.deepEqual(await meWallet(w.b), { connected: true, available_iqd: 0, exchange_rate: RATE }, 'an empty wallet reads empty');
  assert.equal((await call(w.guest, 'GET', `${API}/me/wallet`)).status, 401);
  const status = await ok(w.guest, 'GET', `${API}/status`);
  assert.deepEqual(status.integrations.find((i: Json) => i.name === 'wallet_payment'), { name: 'wallet_payment', connected: true });

  await setWalletPayments(w, false);
  assert.deepEqual(await meWallet(app), { connected: false, available_iqd: 105_000, exchange_rate: RATE }, 'switched off: the balance is still the truth');
  assert.equal((await ok(w.guest, 'GET', `${API}/status`)).integrations.find((i: Json) => i.name === 'wallet_payment').connected, false);
  const adapters = await ok(w.assistant, 'GET', `${ADMIN}/adapters`);
  const adapter = adapters.adapters.find((a: Json) => a.name === 'wallet_payment');
  assert.equal(adapter.connected, false);
  assert.match(adapter.note, /switched off/);

  await setWalletPayments(w, true);
  assert.equal((await meWallet(app)).connected, true);
  assert.equal((await ok(w.assistant, 'GET', `${ADMIN}/adapters`)).adapters.find((a: Json) => a.name === 'wallet_payment').connected, true);
});

// ------------------------------------------------------------------ paying

test('paying from the wallet: one batch debits it and fulfils the order once; the page falls by exactly the total', async () => {
  const { w, cat, app } = await walletWorld();
  const { orderId, total } = await placeOrder(app, ORDER_60K(cat));
  assert.equal(total, 60_250);
  const key = idem('pay');
  const r = await pay(app, orderId, key);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.deepEqual(r.json.data, {
    order_id: orderId,
    status: 'paid',
    provider: 'levonis_wallet',
    amount_iqd: 60_250,
    charged_usd_cents: 4303, // floor(60,250 × 100 / 1,400)
    exchange_rate: RATE,
    wallet_tx_id: `wtx_pc_${orderId}`,
    replayed: false,
  });

  // The figure the customer sees fell by the price — on both screens.
  assert.equal((await meWallet(app)).available_iqd, 105_000 - 60_250);
  const page = await walletPage(app);
  assert.equal(page.balance_iqd, 44_750);

  // One approved debit, denominated in the dinars the customer was shown.
  const debit = row(w, 'SELECT * FROM wallet_transactions WHERE id = ?', `wtx_pc_${orderId}`)!;
  assert.equal(debit.user_id, CUSTOMER_A.id);
  assert.equal(debit.type, 'withdrawal');
  assert.equal(debit.status, 'approved');
  assert.equal(debit.amount, 4303);
  assert.equal(debit.ref, orderId);
  assert.equal(debit.created_by, 'system');
  assert.equal(debit.amount_iqd, 60_250);
  assert.equal(debit.exchange_rate_snapshot, RATE);
  assert.match(String(debit.note), new RegExp(`Levonis Print Cloud.*${orderId}`));
  const listed = page.transactions.find((t) => t.id === `wtx_pc_${orderId}`)!;
  assert.equal(listed.amount_iqd, 60_250, 'the wallet list prints the dinars the row recorded');
  assert.equal(listed.ref, orderId);

  // Fulfilled exactly once, in the same batch.
  const order = row(w, 'SELECT status, paid_iqd, payment_method FROM pc_orders WHERE id = ?', orderId)!;
  assert.deepEqual({ ...order }, { status: 'fulfilled', paid_iqd: 60_250, payment_method: 'levonis_wallet' });
  assert.deepEqual(
    rows(w, 'SELECT provider, amount_iqd, status FROM pc_payments WHERE order_id = ? ORDER BY status', orderId),
    [
      { provider: 'levonis_wallet', amount_iqd: 60_250, status: 'confirmed' },
      { provider: 'levonis_wallet', amount_iqd: 60_250, status: 'rejected' },
    ],
    'the pending row of the order is closed, one confirmed payment stands'
  );
  assert.deepEqual(rows(w, 'SELECT provider, provider_event_id, outcome FROM pc_payment_events WHERE order_id = ?', orderId), [
    { provider: 'levonis_wallet', provider_event_id: `wallet:${orderId}`, outcome: 'applied' },
  ]);
  assert.equal((await credits(app, cat.tier)).available_seconds, 24 * H);
  assert.equal((await owned(app, cat.white)).available_qty, 1000);
  assert.equal(count(w, "SELECT COUNT(*) AS n FROM pc_stock_holds WHERE order_id = ? AND state = 'active'", orderId), 0, 'the stock hold became an allocation');

  // A replay with the same key returns the first answer and moves nothing.
  const again = await pay(app, orderId, key);
  assert.equal(again.status, 200);
  assert.deepEqual(again.json.data, { ...r.json.data, replayed: true });
  assert.equal(debitsOf(w, orderId), 1);
  assert.equal((await credits(app, cat.tier)).available_seconds, 24 * H);
  assert.equal((await walletPage(app)).balance_iqd, 44_750);

  // Print Cloud's reconciliation (with its wallet check) and the platform's own both see a purchase, not an anomaly.
  await reconcileClean(w);
  const platform = await walletReconciliationReport(w.db);
  assert.deepEqual(platform.anomalies.filter((a) => a.user_id === CUSTOMER_A.id), [], 'not a payout without a request, not a negative balance');
});

test('a short wallet is refused 402 with both figures, in three languages; nothing is written and the stock hold stays', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  fund(w.raw, CUSTOMER_A.id, [{ cents: 3571, iqd: 50_000 }]);
  const app = withWallet(w, CUSTOMER_A);
  const { orderId } = await placeOrder(app, ORDER_60K(cat));
  const before = footprint(w);
  const key = idem('short');
  const r = await pay(app, orderId, key);
  assert.equal(r.status, 402, JSON.stringify(r.json));
  assert.equal(r.json.code, 'INSUFFICIENT_BALANCE');
  assert.equal(r.json.details.available_iqd, 50_000);
  assert.equal(r.json.details.required_iqd, 60_250);
  const m = r.json.details.messages;
  assert.ok(m.ar && m.en && m.ckb, 'Arabic, English and Sorani');
  assert.notEqual(m.ckb, m.ar, 'the Sorani sentence is not the Arabic one');
  for (const text of [m.ar, m.en, m.ckb]) assert.match(text, /Levonis/, 'the brand in Latin letters, in every language');
  assert.deepEqual(m, pcWords('INSUFFICIENT_BALANCE'));
  assert.deepEqual(footprint(w), before, 'nothing written');
  assert.equal(row(w, 'SELECT status FROM pc_orders WHERE id = ?', orderId)?.status, 'awaiting_payment');
  assert.deepEqual(rows(w, 'SELECT qty, state FROM pc_stock_holds WHERE order_id = ?', orderId), [{ qty: 1000, state: 'active' }], 'the stock hold is untouched');
  assert.equal((await walletPage(app)).balance_iqd, 50_000);

  // A refusal is not a stored answer: topped up, the same key pays.
  fund(w.raw, CUSTOMER_A.id, [{ cents: 1000, iqd: 14_005 }]);
  assert.equal((await walletPage(app)).balance_iqd, 64_005);
  const paid = await pay(app, orderId, key);
  assert.equal(paid.status, 201, JSON.stringify(paid.json));
  assert.equal(paid.json.data.charged_usd_cents, 4303);
  // 4,303 cents are worth 60,242; the debit records its 8-dinar remainder, which the deposits' own 11 cover —
  // so the page falls by the price to the dinar. (A wallet whose deposits recorded fewer remainders falls by the
  // cents' worth instead, never by more than the price: walletOps `walletIqdAvailable` clamps at zero.)
  assert.equal((await walletPage(app)).balance_iqd, 64_005 - 60_250);
  await reconcileClean(w);
});

test('money a pending withdrawal holds is not spendable — read before the batch, and guarded inside it when the hold lands in between', async () => {
  const { w, cat, app } = await walletWorld();
  const { orderId } = await placeOrder(app, ORDER_60K(cat));
  const first = await createWithdrawalHold(w.db, { userId: CUSTOMER_A.id, amountCents: 5000, eventKey: 'wd-test-1', refType: 'withdrawal', refId: 'wd-test-1' });
  assert.ok(first.ok);
  // 2,499 spendable cents (+ the deposits' 14 IQD of remainders): 35,000 on both screens.
  assert.equal((await meWallet(app)).available_iqd, 35_000);
  assert.equal((await walletPage(app)).balance_iqd, 35_000);
  const short = await pay(app, orderId);
  assert.equal(short.status, 402);
  assert.deepEqual([short.json.details.available_iqd, short.json.details.required_iqd], [35_000, 60_250]);
  assert.equal(debitsOf(w, orderId), 0);

  // The hold goes back; a second one lands between the plan and the batch: the debit's own guard refuses it.
  assert.ok((await releaseHold(w.db, { holdId: first.ok ? first.holdId : '', reason: 'test' })).ok);
  assert.equal((await meWallet(app)).available_iqd, 105_000);
  const before = footprint(w);
  w.race.when = walletBatch;
  w.race.hook = async () => {
    const h = await createWithdrawalHold(w.db, { userId: CUSTOMER_A.id, amountCents: 5000, eventKey: 'wd-test-2', refType: 'withdrawal', refId: 'wd-test-2' });
    assert.ok(h.ok, 'the competing withdrawal reserved its money first');
  };
  const raced = await pay(app, orderId);
  assert.equal(w.race.hook, null, 'the race ran');
  assert.equal(raced.status, 402, JSON.stringify(raced.json));
  assert.equal(raced.json.code, 'INSUFFICIENT_BALANCE');
  assert.equal(raced.json.details.available_iqd, 35_000, 'the figures are read again after the refusal');
  assert.deepEqual(footprint(w), before, 'the batch rolled back whole: no debit, no confirmation');
  assert.equal(row(w, 'SELECT status FROM pc_orders WHERE id = ?', orderId)?.status, 'awaiting_payment');
});

// ------------------------------------------------------------------ races

test('two wallet payments of one order under different keys: exactly one payment and one debit', async () => {
  const { w, cat, app } = await walletWorld();
  const { orderId } = await placeOrder(app, ORDER_60K(cat));
  let inner: { status: number; json: Json } | null = null;
  w.race.when = walletBatch;
  w.race.hook = async () => {
    inner = await pay(app, orderId, idem('second-tab'));
  };
  const outer = await pay(app, orderId, idem('first-tab'));
  assert.equal(inner!.status, 201, JSON.stringify(inner!.json));
  assert.equal(outer.status, 409, JSON.stringify(outer.json));
  assert.equal(outer.json.code, 'ORDER_NOT_PAYABLE');
  assert.equal(outer.json.details.reason, 'already_paid');
  assert.equal(debitsOf(w, orderId), 1, 'one debit');
  assert.equal(count(w, "SELECT COUNT(*) AS n FROM pc_payments WHERE order_id = ? AND status = 'confirmed'", orderId), 1, 'one payment');
  assert.equal(count(w, 'SELECT COUNT(*) AS n FROM pc_payment_events WHERE order_id = ?', orderId), 1);
  assert.equal((await walletPage(app)).balance_iqd, 44_750, 'charged once');
  assert.equal((await credits(app, cat.tier)).available_seconds, 24 * H, 'granted once');
  await reconcileClean(w);
});

test('the same key fired twice at once: one debit, and both answers are the first answer', async () => {
  const { w, cat, app } = await walletWorld();
  const { orderId } = await placeOrder(app, ORDER_60K(cat));
  const key = idem('double-tap');
  let inner: { status: number; json: Json } | null = null;
  w.race.when = walletBatch;
  w.race.hook = async () => {
    inner = await pay(app, orderId, key);
  };
  const outer = await pay(app, orderId, key);
  assert.equal(inner!.status, 201);
  assert.equal(outer.status, 200, JSON.stringify(outer.json));
  assert.deepEqual(outer.json.data, { ...inner!.json.data, replayed: true });
  assert.equal(debitsOf(w, orderId), 1);
});

test('a manual receipt and a wallet payment racing: one payment; the wallet is charged only when it won', async () => {
  const { w, cat, app } = await walletWorld();
  // (a) The receipt is confirmed while the wallet request is in flight: the wallet batch meets the order's fence.
  const a = await placeOrder(app, ORDER_60K(cat));
  w.race.when = walletBatch;
  w.race.hook = async () => {
    const m = await ok(w.full, 'POST', `${ADMIN}/orders/${a.orderId}/confirm-payment`, { reference: 'RCPT-A', amount_iqd: a.total });
    assert.equal(m.outcome, 'applied');
  };
  const lost = await pay(app, a.orderId);
  assert.equal(lost.status, 409, JSON.stringify(lost.json));
  assert.equal(lost.json.code, 'ORDER_NOT_PAYABLE');
  assert.equal(debitsOf(w, a.orderId), 0, 'the wallet was never charged');
  assert.equal((await walletPage(app)).balance_iqd, 105_000);
  assert.deepEqual(rows(w, "SELECT provider FROM pc_payments WHERE order_id = ? AND status = 'confirmed'", a.orderId), [{ provider: 'manual' }]);

  // (b) The wallet pays while the receipt is being confirmed: the receipt is recorded for the refund desk, never applied.
  const b = await placeOrder(app, [{ kind: 'credit_package', package_id: cat.packages.h6 }]);
  w.race.when = (sqls) => sqls.some((s) => s.includes("UPDATE pc_orders SET status = 'fulfilled'")) && !walletBatch(sqls);
  w.race.hook = async () => {
    const won = await pay(app, b.orderId);
    assert.equal(won.status, 201, JSON.stringify(won.json));
  };
  const receipt = await ok(w.full, 'POST', `${ADMIN}/orders/${b.orderId}/confirm-payment`, { reference: 'RCPT-B', amount_iqd: b.total });
  assert.equal(receipt.outcome, 'duplicate_order');
  assert.equal(debitsOf(w, b.orderId), 1);
  assert.deepEqual(rows(w, "SELECT provider FROM pc_payments WHERE order_id = ? AND status = 'confirmed'", b.orderId), [{ provider: 'levonis_wallet' }]);
  const desk = (await ok(w.owner, 'GET', `${ADMIN}/reconcile`)).checks.find((c: Json) => c.name === 'payments_needing_refund');
  assert.ok(desk.issues.some((i: Json) => i.order_id === b.orderId && i.provider === 'manual'), 'the cash receipt is listed for the refund desk');
  await reconcileClean(w);
});

test('a gateway confirmation landing inside the wallet request: one payment, no wallet debit', async () => {
  const { w, cat, app } = await walletWorld();
  const { orderId, total } = await placeOrder(app, ORDER_60K(cat));
  const secret = String(w.env.PRINT_CLOUD_PAYMENT_WEBHOOK_SECRET);
  w.race.when = walletBatch;
  w.race.hook = async () => {
    const event = { event_id: `gw-${orderId}`, order_id: orderId, amount_iqd: total, status: 'succeeded' };
    const sig = await signGatewayPayload(secret, JSON.stringify(event), Math.floor(Date.now() / 1000));
    const r = await call(w.guest, 'POST', `${API}/payments/webhook`, event, { 'X-PrintCloud-Signature': sig });
    assert.equal(r.json.data.outcome, 'applied');
  };
  const lost = await pay(app, orderId);
  assert.equal(lost.status, 409);
  assert.equal(lost.json.code, 'ORDER_NOT_PAYABLE');
  assert.equal(debitsOf(w, orderId), 0);
  assert.equal(count(w, "SELECT COUNT(*) AS n FROM pc_payments WHERE order_id = ? AND status = 'confirmed'", orderId), 1);
  await reconcileClean(w);
});

test('an outage while the wallet batch runs is a 500 to retry — never an invented refusal; the same key then pays', async () => {
  const { w, cat } = await walletWorld();
  const { failing, db } = failingD1(w.raw);
  const app = stubApp(db, CUSTOMER_A, mountPrintCloud, { env: w.env, publishV2: false });
  const { orderId } = await placeOrder(app, ORDER_60K(cat));
  const before = footprint(w);
  failing.failWhen = (statements) => statements.some((s) => s.sql.includes('INSERT INTO wallet_transactions'));
  const key = idem('outage');
  const r = await pay(app, orderId, key);
  assert.equal(r.status, 500, `not a refusal: ${JSON.stringify(r.json).slice(0, 300)}`);
  assert.equal(r.json.code, undefined);
  assert.deepEqual(footprint(w), before, 'nothing written');
  failing.failWhen = null;
  const paid = await pay(app, orderId, key);
  assert.equal(paid.status, 201, JSON.stringify(paid.json));
  assert.equal(debitsOf(w, orderId), 1);
});

// ------------------------------------------------------------------ keys, owners, states

test('idempotency and ownership: a key is required, pinned to its order, and nobody pays another customer’s order', async () => {
  const { w, cat, app } = await walletWorld();
  const first = await placeOrder(app, [{ kind: 'credit_package', package_id: cat.packages.h6 }]);
  const second = await placeOrder(app, [{ kind: 'credit_package', package_id: cat.packages.h6 }]);
  await refused(app, 'POST', `${API}/orders/${first.orderId}/pay/wallet`, {}, 'IDEMPOTENCY_KEY_REQUIRED');
  await refused(app, 'POST', `${API}/orders/${first.orderId}/pay/wallet`, {}, 'IDEMPOTENCY_KEY_REQUIRED', { 'Idempotency-Key': 'short' });
  const key = idem('pinned');
  assert.equal((await pay(app, first.orderId, key)).status, 201);
  await refused(app, 'POST', `${API}/orders/${second.orderId}/pay/wallet`, {}, 'IDEMPOTENCY_KEY_REUSED', key);
  assert.equal(debitsOf(w, second.orderId), 0);
  // Customer B — with money of their own — cannot pay A's order, and is told it does not exist.
  fund(w.raw, CUSTOMER_B.id, WALLET_105K);
  await refused(w.b, 'POST', `${API}/orders/${second.orderId}/pay/wallet`, {}, 'NOT_FOUND', idem('b'));
  await refused(app, 'POST', `${API}/orders/pco_does_not_exist/pay/wallet`, {}, 'NOT_FOUND', idem('ghost'));
  assert.equal((await meWallet(w.b)).available_iqd, 105_000);
});

test('a cancelled or expired order is never charged — also when it is cancelled while the payment is in flight', async () => {
  const { w, cat, app } = await walletWorld();
  const cancelled = await placeOrder(app, ORDER_60K(cat));
  await ok(app, 'POST', `${API}/orders/${cancelled.orderId}/cancel`);
  const before = footprint(w);
  const c = await pay(app, cancelled.orderId);
  assert.equal(c.status, 409);
  assert.deepEqual([c.json.code, c.json.details.reason], ['ORDER_NOT_PAYABLE', 'cancelled']);

  // Past its deadline but not yet swept: expired all the same — the sweep is about to put its stock back.
  const late = await placeOrder(app, [{ kind: 'material', variant_id: cat.black, quantity: 500 }]);
  w.raw.prepare("UPDATE pc_orders SET stock_hold_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(late.orderId);
  const e = await pay(app, late.orderId);
  assert.equal(e.status, 409);
  assert.deepEqual([e.json.code, e.json.details.reason], ['ORDER_NOT_PAYABLE', 'expired']);
  assert.deepEqual(await expireUnpaidOrders(w.db, new Date()), { expired: 1, failed: 0, more: false });
  assert.equal((await pay(app, late.orderId)).json.details.reason, 'expired');
  assert.deepEqual(footprint(w), before, 'nothing charged, nothing confirmed');

  // Cancelled by the customer's other tab at the instant the wallet batch runs.
  const raced = await placeOrder(app, ORDER_60K(cat));
  w.race.when = walletBatch;
  w.race.hook = async () => {
    await ok(app, 'POST', `${API}/orders/${raced.orderId}/cancel`);
  };
  const r = await pay(app, raced.orderId);
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.deepEqual([r.json.code, r.json.details.reason], ['ORDER_NOT_PAYABLE', 'cancelled']);
  assert.equal(debitsOf(w, raced.orderId), 0);
  assert.equal(row(w, 'SELECT reserved_qty FROM pc_stock_positions WHERE variant_id = ?', cat.white)?.reserved_qty, 0, 'the cancel put the held stock back, once');
  assert.equal((await walletPage(app)).balance_iqd, 105_000);
  await reconcileClean(w);
});

test('a zero-total order is confirmed with no debit — there is nothing to collect', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  await ok(w.full, 'POST', `${ADMIN}/catalog/promotions`, { name_en: 'Free hours', name_ar: 'ساعات مجانية', name_ckb: 'کاتژمێری بەخۆڕایی', scope: 'credits', percent_bps: 10_000 });
  const app = withWallet(w, CUSTOMER_B); // an empty wallet
  const { orderId, total } = await placeOrder(app, [{ kind: 'credit_package', package_id: cat.packages.h6 }]);
  assert.equal(total, 0);
  const r = await pay(app, orderId);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.deepEqual([r.json.data.amount_iqd, r.json.data.charged_usd_cents, r.json.data.wallet_tx_id], [0, 0, null]);
  assert.equal(count(w, 'SELECT COUNT(*) AS n FROM wallet_transactions WHERE user_id = ?', CUSTOMER_B.id), 0);
  assert.equal(row(w, 'SELECT status FROM pc_orders WHERE id = ?', orderId)?.status, 'fulfilled');
  assert.equal((await credits(app, cat.tier)).available_seconds, 6 * H);
  await reconcileClean(w);
});

test('a delivery fee is payable from the wallet while its shipment waits for it', async () => {
  const { w, cat, app } = await walletWorld();
  const material = await placeOrder(app, [{ kind: 'material', variant_id: cat.white, quantity: 500 }]);
  assert.equal((await pay(app, material.orderId)).status, 201);
  const shipment = await ok(
    app,
    'POST',
    `${API}/shipments`,
    {
      kind: 'delivery',
      items: [{ variant_id: cat.white, qty: 200 }],
      delivery_address: { recipient_name: 'Ali', phone: '+9647700000000', governorate: 'baghdad', city: 'Baghdad', address_line: 'Karrada, street 62' },
      payment_method: 'levonis_wallet',
    },
    idem('ship')
  );
  assert.equal(shipment.payment.action, 'pay_from_wallet');
  const before = (await walletPage(app)).balance_iqd;
  const paid = await pay(app, shipment.fee_order_id);
  assert.equal(paid.status, 201, JSON.stringify(paid.json));
  assert.equal(paid.json.data.amount_iqd, shipment.fee_iqd);
  assert.equal(row(w, 'SELECT status FROM pc_shipments WHERE id = ?', shipment.shipment_id)?.status, 'preparing');
  assert.equal((await walletPage(app)).balance_iqd, before - shipment.fee_iqd);
  await reconcileClean(w);
});

// ------------------------------------------------------------------ the owner's switch

test('wallet payments switched off: 503 PAYMENT_ADAPTER_DISABLED, nothing written — and money already taken still comes back to the wallet', async () => {
  const { w, cat, app } = await walletWorld();
  const paidEarlier = await placeOrder(app, [{ kind: 'credit_package', package_id: cat.packages.h24 }]);
  const key = idem('before-switch');
  assert.equal((await pay(app, paidEarlier.orderId, key)).status, 201);
  const unpaid = await placeOrder(app, [{ kind: 'credit_package', package_id: cat.packages.h6 }]);
  await setWalletPayments(w, false);
  const before = footprint(w);
  const r = await pay(app, unpaid.orderId);
  assert.equal(r.status, 503);
  assert.deepEqual([r.json.code, r.json.details.provider], ['PAYMENT_ADAPTER_DISABLED', 'levonis_wallet']);
  assert.deepEqual(footprint(w), before);
  // A payment made before the switch replays as what it was.
  const replay = await pay(app, paidEarlier.orderId, key);
  assert.deepEqual([replay.status, replay.json.data.replayed, replay.json.data.status], [200, true, 'paid']);
  // Its refund is credited to the wallet regardless.
  const line = row<{ id: string }>(w, 'SELECT id FROM pc_order_lines WHERE order_id = ?', paidEarlier.orderId)!;
  const refund = await ok(w.full, 'POST', `${ADMIN}/orders/${paidEarlier.orderId}/refunds`, { line_id: line.id, reason: 'switched off, still refunded' }, idem('rf'));
  assert.equal(refund.method, 'levonis_wallet');
  assert.equal(refund.wallet_credit.usd_cents, 2571);
  assert.equal((await walletPage(app)).balance_iqd, 105_000);
  // The switch is the money desk's, validated like every setting.
  const s = await ok(w.owner, 'GET', `${ADMIN}/settings`);
  assert.equal(s.config.wallet_payment_enabled, false);
  assert.equal((await call(w.assistant, 'PATCH', `${ADMIN}/settings`, { version: s.version, config: { wallet_payment_enabled: true } })).status, 403);
  const bad = await refused(w.owner, 'PATCH', `${ADMIN}/settings`, { version: s.version, config: { wallet_payment_enabled: 'yes' } }, 'VALIDATION');
  assert.deepEqual([bad.details.field, bad.details.reason], ['wallet_payment_enabled', 'boolean_required']);
});

// ------------------------------------------------------------------ refunds

async function paidOrder(): Promise<{ w: World; cat: Catalog; app: App; orderId: string; lines: { credit: string; material: string } }> {
  const { w, cat, app } = await walletWorld();
  const { orderId } = await placeOrder(app, ORDER_60K(cat));
  assert.equal((await pay(app, orderId)).status, 201);
  const credit = row<{ id: string }>(w, "SELECT id FROM pc_order_lines WHERE order_id = ? AND kind = 'credit_package'", orderId)!.id;
  const material = row<{ id: string }>(w, "SELECT id FROM pc_order_lines WHERE order_id = ? AND kind = 'material'", orderId)!.id;
  return { w, cat, app, orderId, lines: { credit, material } };
}

const refundCredits = (w: World, orderId: string) =>
  rows<{ id: string; amount: number; amount_iqd: number | null; exchange_rate_snapshot: number | null; created_by: string; status: string }>(
    w,
    "SELECT id, amount, amount_iqd, exchange_rate_snapshot, created_by, status FROM wallet_transactions WHERE ref = ? AND type = 'deposit' ORDER BY rowid",
    orderId
  );

test('refunds of a wallet-paid order go back to the wallet: partial, repeated, full — exactly the cents debited, never more, never twice', async () => {
  const { w, app, orderId, lines } = await paidOrder();
  assert.equal((await walletPage(app)).balance_iqd, 44_750);

  // 1. 400 g of the unused spool: 9,700 IQD → floor(4,303 × 9,700 / 60,250) = 692 cents, recorded at the debit's rate.
  const key = idem('rf-400');
  const first = await ok(w.full, 'POST', `${ADMIN}/orders/${orderId}/refunds`, { line_id: lines.material, quantity: 400, reason: 'unused filament' }, key);
  assert.equal(first.amount_iqd, 9_700);
  assert.equal(first.method, 'levonis_wallet');
  assert.deepEqual(first.wallet_credit, { tx_id: `wtx_pc_${first.refund_id}`, usd_cents: 692, amount_iqd: 9_700, exchange_rate: RATE });
  assert.deepEqual(refundCredits(w, orderId), [
    { id: `wtx_pc_${first.refund_id}`, amount: 692, amount_iqd: 9_700, exchange_rate_snapshot: RATE, created_by: 'admin', status: 'approved' },
  ]);
  assert.equal((await walletPage(app)).balance_iqd, 44_750 + 9_700, 'the page rose by the refund');
  assert.deepEqual(row(w, 'SELECT method, status FROM pc_refunds WHERE id = ?', first.refund_id), { method: 'levonis_wallet', status: 'paid_out' });

  // A replay of the same refund credits nothing more.
  const replay = await call(w.full, 'POST', `${ADMIN}/orders/${orderId}/refunds`, { line_id: lines.material, quantity: 400, reason: 'unused filament' }, key);
  assert.deepEqual([replay.status, replay.json.data.replayed, replay.json.data.wallet_credit.tx_id], [200, true, first.wallet_credit.tx_id]);
  assert.equal(refundCredits(w, orderId).length, 1);

  // Cash as well as a wallet credit would refund it twice: another method is refused, nothing written.
  const asCash = await refused(w.full, 'POST', `${ADMIN}/orders/${orderId}/refunds`, { line_id: lines.material, quantity: 100, reason: 'cash', method: 'manual' }, 'VALIDATION', idem('cash'));
  assert.deepEqual([asCash.details.field, asCash.details.reason], ['method', 'order_paid_from_wallet']);
  assert.equal(refundCredits(w, orderId).length, 1);

  // 2. The other 600 g, then 3. the 24 unused hours: the order is fully refunded.
  const second = await ok(w.full, 'POST', `${ADMIN}/orders/${orderId}/refunds`, { line_id: lines.material, reason: 'rest of the spool', method: 'levonis_wallet' }, idem('rf-600'));
  assert.equal(second.amount_iqd, 14_550);
  assert.equal(second.wallet_credit.usd_cents, 1731 - 692);
  const third = await ok(w.full, 'POST', `${ADMIN}/orders/${orderId}/refunds`, { line_id: lines.credit, reason: 'hours unused' }, idem('rf-hours'));
  assert.equal(third.amount_iqd, 36_000);
  assert.equal(third.wallet_credit.usd_cents, 4303 - 1731);
  assert.equal(row(w, 'SELECT status FROM pc_orders WHERE id = ?', orderId)?.status, 'refunded');
  const all = refundCredits(w, orderId);
  assert.equal(all.reduce((s, c) => s + c.amount, 0), 4303, 'refunding the whole paid amount returns EXACTLY the debited cents');
  assert.equal(all.reduce((s, c) => s + Number(c.amount_iqd), 0), 60_250, 'and records exactly the paid dinars');
  // The cents are exact; the page may read at most one cent's worth (13 IQD) per partial refund above the
  // pre-order figure — a refund whose cents are worth a few dinars more than its own share records no negative
  // remainder (walletOps `walletDustIqdSql`), in the customer's favour, never below.
  const after = (await walletPage(app)).balance_iqd;
  assert.ok(after >= 105_000 && after <= 105_000 + 13 * 3, `the wallet is back: ${after}`);
  assert.equal((await meWallet(app)).available_iqd, after, 'Print Cloud reads the same figure');

  // Nothing more to refund, and no refund can push the credits past the debit.
  await refused(w.full, 'POST', `${ADMIN}/orders/${orderId}/refunds`, { line_id: lines.credit, reason: 'again' }, 'INVALID_TRANSITION', idem('rf-again'));
  assert.equal(refundCredits(w, orderId).reduce((s, c) => s + c.amount, 0), 4303);
  await reconcileClean(w);
  const platform = await walletReconciliationReport(w.db);
  assert.deepEqual(platform.anomalies.filter((a) => a.user_id === CUSTOMER_A.id), []);
});

test('one full refund is the exact mirror of the debit: the wallet page returns to the dinar', async () => {
  const { w, cat, app } = await walletWorld();
  const { orderId } = await placeOrder(app, [{ kind: 'credit_package', package_id: cat.packages.h24 }]);
  assert.equal((await pay(app, orderId)).json.data.charged_usd_cents, 2571);
  assert.equal((await walletPage(app)).balance_iqd, 105_000 - 36_000);
  const line = row<{ id: string }>(w, 'SELECT id FROM pc_order_lines WHERE order_id = ?', orderId)!.id;
  const refund = await ok(w.full, 'POST', `${ADMIN}/orders/${orderId}/refunds`, { line_id: line, reason: 'changed my mind' }, idem('full'));
  assert.deepEqual(refund.wallet_credit, { tx_id: `wtx_pc_${refund.refund_id}`, usd_cents: 2571, amount_iqd: 36_000, exchange_rate: RATE });
  assert.equal((await walletPage(app)).balance_iqd, 105_000);
  assert.equal((await meWallet(app)).available_iqd, 105_000);
  await reconcileClean(w);
});

test('two refunds racing never credit the same step twice: the loser re-plans on the new total', async () => {
  const { w, app, orderId, lines } = await paidOrder();
  let inner: Json | null = null;
  w.race.when = (sqls) => sqls.some((s) => s.includes('INSERT INTO pc_refunds'));
  w.race.hook = async () => {
    inner = await ok(w.full, 'POST', `${ADMIN}/orders/${orderId}/refunds`, { line_id: lines.material, quantity: 600, reason: 'tab two' }, idem('rf-two'));
  };
  const outer = await ok(w.full, 'POST', `${ADMIN}/orders/${orderId}/refunds`, { line_id: lines.material, quantity: 400, reason: 'tab one' }, idem('rf-one'));
  assert.equal(inner!.amount_iqd, 14_550);
  assert.equal(inner!.wallet_credit.usd_cents, 1039, 'floor(4,303 × 14,550 / 60,250)');
  assert.equal(outer.amount_iqd, 9_700);
  assert.equal(outer.wallet_credit.usd_cents, 1731 - 1039, 'the step from 14,550 to 24,250 refunded dinars');
  assert.equal(refundCredits(w, orderId).reduce((s, c) => s + c.amount, 0), 1731);
  assert.ok((await walletPage(app)).balance_iqd >= 44_750 + 24_250);
  await reconcileClean(w);
});

test('a wallet refund under one cent’s worth is refused with the smallest amount that credits one; that amount credits exactly a cent', async () => {
  const { w, cat, app } = await walletWorld();
  const { orderId } = await placeOrder(app, [{ kind: 'material', variant_id: cat.white, quantity: 100 }]);
  assert.equal((await pay(app, orderId)).json.data.charged_usd_cents, 250); // 3,500 IQD
  const line = row<{ id: string }>(w, 'SELECT id FROM pc_order_lines WHERE order_id = ?', orderId)!.id;
  const before = footprint(w);
  const tiny = await refused(w.full, 'POST', `${ADMIN}/orders/${orderId}/refunds`, { line_id: line, quantity: 1, amount_iqd: 1, reason: 'one dinar' }, 'VALIDATION', idem('tiny'));
  assert.deepEqual([tiny.details.field, tiny.details.reason, tiny.details.min_amount_iqd], ['amount_iqd', 'below_one_cent', 14]);
  assert.deepEqual(footprint(w), before);
  const one = await ok(w.full, 'POST', `${ADMIN}/orders/${orderId}/refunds`, { line_id: line, quantity: 1, amount_iqd: 14, reason: 'fourteen dinars' }, idem('one'));
  assert.equal(one.wallet_credit.usd_cents, 1);
  await reconcileClean(w);
});

test('refunds of manual and gateway payments are unchanged: recorded for the money desk, no wallet credit', async () => {
  const { w, cat, app } = await walletWorld();
  const { orderId, total } = await placeOrder(app, [{ kind: 'credit_package', package_id: cat.packages.h6 }], 'manual');
  assert.equal((await ok(w.full, 'POST', `${ADMIN}/orders/${orderId}/confirm-payment`, { reference: 'CASH-1', amount_iqd: total })).outcome, 'applied');
  const line = row<{ id: string }>(w, 'SELECT id FROM pc_order_lines WHERE order_id = ?', orderId)!.id;
  const minted = await refused(w.full, 'POST', `${ADMIN}/orders/${orderId}/refunds`, { line_id: line, reason: 'to the wallet?', method: 'levonis_wallet' }, 'VALIDATION', idem('mint'));
  assert.deepEqual([minted.details.field, minted.details.reason], ['method', 'order_not_paid_from_wallet']);
  const refund = await ok(w.full, 'POST', `${ADMIN}/orders/${orderId}/refunds`, { line_id: line, reason: 'cash back' }, idem('cash'));
  assert.deepEqual([refund.method, refund.wallet_credit], ['manual', null]);
  assert.deepEqual(row(w, 'SELECT method, status FROM pc_refunds WHERE id = ?', refund.refund_id), { method: 'manual', status: 'recorded' });
  assert.equal(refundCredits(w, orderId).length, 0);
  assert.equal((await walletPage(app)).balance_iqd, 105_000, 'the wallet never paid and is never credited');
  await reconcileClean(w);
});

// ------------------------------------------------------------------ deploy ahead

/** The platform without Print Cloud's tables (or without 0108's ledger dinars), its wallet funded. */
function olderWorld(through: string, deposits: Deposit[]) {
  const raw = dbThrough(through);
  raw.exec(`INSERT INTO users (id, name, email, password_hash, role, username) VALUES
    ('usr_pc_a', 'Ali', 'a@x.co', 'h', 'customer', 'usr_pc_a'),
    ('usr_full', 'Full', 'full@x.co', 'h', 'admin', 'usr_full')`);
  for (const d of deposits) {
    raw
      .prepare("INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, created_by) VALUES (?, ?, 'deposit', 'USD', ?, 'approved', 'seed', 'admin')")
      .run(`wtx_seed_${++seq}`, 'usr_full', d.cents);
  }
  const db = new RaceD1(raw) as unknown as D1Database;
  return { raw, as: (user: StubUser) => stubApp(db, user, mountPrintCloud, { publishV2: false }) };
}

test('deploy ahead of 0215: GET /me/wallet reads the platform wallet from the defaults; writes are refused before any statement', async () => {
  const behind = olderWorld('0214', [{ cents: 7500 }]);
  const admin = behind.as(PC_FULL);
  // A platform admin may preview the closed service: the wallet is the platform's, and it is there.
  assert.deepEqual(await ok(admin, 'GET', `${API}/me/wallet`), { connected: true, available_iqd: 105_000, exchange_rate: RATE });
  // A customer meets the closed service, exactly as on a migrated database that was never opened.
  assert.equal((await refused(behind.as(CUSTOMER_A), 'GET', `${API}/me/wallet`, undefined, 'PRINT_CLOUD_DISABLED')).code, 'PRINT_CLOUD_DISABLED');
  await refused(admin, 'POST', `${API}/orders/pco_x/pay/wallet`, {}, 'PRINT_CLOUD_NOT_INSTALLED', idem('behind'));
  assert.equal(Number((behind.raw.prepare('SELECT COUNT(*) AS n FROM wallet_transactions').get() as { n: number }).n), 1, 'nothing written');
  const status = await ok(admin, 'GET', `${API}/status`);
  assert.equal(status.installed, false);
  assert.equal(status.integrations.find((i: Json) => i.name === 'wallet_payment').connected, true);
});

test('a database behind on 0108 reads no dinar remainders — the plain cents conversion, as every balance did before it', async () => {
  const behind = olderWorld('0107', [{ cents: 3571 }]);
  assert.deepEqual(await ok(behind.as(PC_FULL), 'GET', `${API}/me/wallet`), { connected: true, available_iqd: 49_994, exchange_rate: RATE });
});
