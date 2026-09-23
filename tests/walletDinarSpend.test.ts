/**
 * «قام بتعبئة خمسين ألف وعندما يريد أن يطلب منتجا الذي يكون طابعة تطلب خمسين
 *  ألف ضبط فيقول له الرصيد غير كافي.»
 *
 * THE OWNER'S CUSTOMER, RUN THROUGH THE REAL ROUTES. Every figure below comes
 * from `POST /api/orders`, `POST /api/orders/:id/cancel` and `GET /api/wallet`
 * against every migration, the real printer catalog flag, the real cart and
 * the real wallet engine. Nothing is stubbed but the session.
 *
 * THREE POPULATIONS, BECAUSE THE FIRST FIX ONLY CLOSED ONE OF THEM:
 *
 *   1. ONE transfer of 50,000 د.ع. Closed by migration 0108's first draft.
 *   2. TWO transfers of 25,000 د.ع. NOT closed by it: the remainder ceiling
 *      was applied to the whole wallet, so two honest 10-dinar remainders were
 *      cut to 14 and the balance read 49,994 — the owner's own number — and
 *      the advance was refused exactly as reported. The ceiling is per row now.
 *   3. A customer who ORDERS AND THEN CANCELS. Also not closed: the cancel
 *      refunded every cent and no dinar, so the balance came back six dinars
 *      LOWER than before they shopped and the same order was then refused.
 *      A cancel that leaves a customer poorer than never ordering is the one
 *      shape this work is forbidden to produce.
 *
 * Run: node --import tsx --test tests/walletDinarSpend.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, SqliteD1 } from './fixtures/d1';
import { stubApp, json, post, ctx, pending, type App } from './fixtures/app';
import { orderRoutes } from '../worker/routes/orders';
import { walletRoutes } from '../worker/routes/wallet';
import { createDepositRequest } from '../worker/lib/walletOps';
import { acceptedPolicies } from './lib/policies';
import { resetPolicyCorpusMemo } from '../worker/lib/policySync';
import { iqdToUsdCents } from '../src/lib/api';

const RATE = 1400;

function setup() {
  resetPolicyCorpusMemo();
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(join(dir, f), 'utf8'));
  }
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('buyer','Sara','s@x.co','h','customer');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default) VALUES
      ('addr_b','buyer','Home','Sara','+9647701234567','Baghdad, Karrada 12','',1);
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,direct_surcharge_iqd,images)
      VALUES ('p_x1','x1-printer','Printer X1','طابعة X1',899000,'active',50,'[]','[]','direct_sale','["direct_sale"]','[]',NULL,'[]');
    INSERT INTO catalogs (id, slug, name_ar, is_printer_catalog) VALUES ('cat_wds','wds-printers','طابعات',1);
    INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES ('p_x1','cat_wds',0);
  `);
  return { raw, db: new SqliteD1(raw) as unknown as D1Database };
}

const app = (db: D1Database) =>
  stubApp(db, { id: 'buyer', role: 'customer', email: 's@x.co' }, (a) => {
    a.route('/api/orders', orderRoutes);
    a.route('/api/wallet', walletRoutes);
  });

/** File a top-up the way the customer's browser files it, then approve it. */
async function topUp(db: D1Database, raw: DatabaseSync, typedIqd: number, ref: string) {
  const txId = `wtx_${ref}`;
  const res = await createDepositRequest(db, {
    userId: 'buyer',
    // The browser's own conversion — `iqdToUsdCents`, which floors.
    amountCents: iqdToUsdCents(typedIqd, RATE),
    receiptKey: `receipts/buyer/${ref}.png`,
    provider: 'zaincash',
    channel: 'app',
    reference: ref,
    declaredAmountIqd: typedIqd,
    exchangeRateSnapshot: RATE,
    txId,
  });
  assert.equal(res.ok, true, `the top-up must file: ${JSON.stringify(res)}`);
  raw.prepare("UPDATE wallet_transactions SET status = 'approved' WHERE id = ?").run(txId);
}

const cartLine = (raw: DatabaseSync, id: string) =>
  raw
    .prepare(
      `INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty)
       VALUES (?, 'buyer', 'p_x1', '', '[]', '', '', '', '', 1)`
    )
    .run(id);

let seq = 0;
const orderBody = () => ({
  addressId: 'addr_b',
  deliveryMethodId: 'standard',
  paymentMethodId: 'cash',
  useWallet: false,
  usePoints: false,
  itemIds: [],
  idempotencyKey: `wds-${Date.now()}-${++seq}`,
  policyAcceptance: acceptedPolicies(),
});

const balanceIqd = async (a: App) => Number((await json(await a.request('/api/wallet', {}, undefined, ctx))).balance_iqd);

// ---------------------------------------------------------------------------

test('ONE transfer of 50,000: the wallet reads 50,000 and the printer advance is paid', async () => {
  const { db, raw } = setup();
  await topUp(db, raw, 50_000, 'T1');
  const a = app(db);
  assert.equal(await balanceIqd(a), 50_000, 'not 49,994 and not 50,008 — the figure that was typed');

  cartLine(raw, 'ci1');
  const placed = await json(await post(a, '/api/orders', orderBody()));
  assert.equal(placed.success, true, JSON.stringify(placed));
  assert.equal(placed.order.wallet_applied_iqd, 50_000, 'the advance was taken, in the unit it is quoted in');
  assert.equal(await balanceIqd(a), 0, 'and the wallet reads empty, not a six-dinar ghost of its own credit');
  await Promise.allSettled(pending);
});

test('TWO transfers of 25,000: the same 50,000, and the same advance — the ceiling is per row', async () => {
  const { db, raw } = setup();
  await topUp(db, raw, 25_000, 'T2a');
  await topUp(db, raw, 25_000, 'T2b');
  const a = app(db);

  // The ledger holds 3,570 cents (1,785 twice), worth 49,980 د.ع. The two
  // honest ten-dinar remainders are what make the difference, and a ceiling
  // applied to their SUM cut them to 14 — the reading was 49,994.
  assert.equal(
    (raw.prepare("SELECT SUM(amount) AS c FROM wallet_transactions WHERE user_id='buyer' AND status='approved'").get() as { c: number }).c,
    3570
  );
  assert.equal(await balanceIqd(a), 50_000, 'the owner’s number, 49,994, must not come back');

  cartLine(raw, 'ci1');
  const placed = await json(await post(a, '/api/orders', orderBody()));
  assert.equal(placed.success, true, JSON.stringify(placed));
  assert.equal(placed.order.wallet_applied_iqd, 50_000);
  assert.equal(await balanceIqd(a), 0);
  await Promise.allSettled(pending);
});

test('THREE and FOUR transfers: the reading is the sum that was typed, not a ceiling of it', async () => {
  for (const [n, each] of [[3, 50_000], [4, 10_000], [10, 5_000]] as const) {
    const { db, raw } = setup();
    for (let i = 0; i < n; i += 1) await topUp(db, raw, each, `T${n}-${i}`);
    assert.equal(await balanceIqd(app(db)), n * each, `${n} × ${each}`);
  }
});

test('order then CANCEL: the balance comes back whole, and the same order can be placed again', async () => {
  const { db, raw } = setup();
  await topUp(db, raw, 50_000, 'T4');
  const a = app(db);
  assert.equal(await balanceIqd(a), 50_000);

  cartLine(raw, 'ci1');
  const placed = await json(await post(a, '/api/orders', orderBody()));
  assert.equal(placed.success, true, JSON.stringify(placed));
  assert.equal(await balanceIqd(a), 0);

  const cancelled = await json(await post(a, `/api/orders/${placed.order.id}/cancel`, {}));
  assert.equal(cancelled.success, true, JSON.stringify(cancelled));

  // THE ASSERTION THIS FILE EXISTS FOR. Every cent came back before; the
  // dinars did not, and the reading landed on 49,994 — six dinars below where
  // the customer started, for ever, from an order they did not keep.
  assert.equal(await balanceIqd(a), 50_000, 'a cancel may not leave a customer poorer than never ordering');
  const refund = raw
    .prepare("SELECT amount, amount_iqd, exchange_rate_snapshot FROM wallet_transactions WHERE id = ?")
    .get(`wtx_refund_${placed.order.id}_usd`) as { amount: number; amount_iqd: number; exchange_rate_snapshot: number };
  assert.deepEqual({ ...refund }, { amount: 3571, amount_iqd: 50_000, exchange_rate_snapshot: RATE },
    'the refund copies the debit’s dinars — it does not recompute them and it invents no rate');

  // And the order that was refused before can be placed again.
  cartLine(raw, 'ci2');
  const again = await json(await post(a, '/api/orders', orderBody()));
  assert.equal(again.success, true, JSON.stringify(again));
  assert.equal(again.order.wallet_applied_iqd, 50_000);
  await Promise.allSettled(pending);
});

test('a wallet that is genuinely short is still refused, in the sentence that explains why', async () => {
  const { db, raw } = setup();
  await topUp(db, raw, 30_000, 'T5');
  const a = app(db);
  assert.equal(await balanceIqd(a), 30_000);
  cartLine(raw, 'ci1');
  const refused = await json(await post(a, '/api/orders', orderBody()));
  assert.equal(refused.success, false);
  assert.equal(refused.code, 'INSUFFICIENT_BALANCE');
  assert.match(String(refused.error), /50,000 د\.ع مقدماً/, 'the Arabic printer sentence, not a bare English refusal');
  assert.equal(refused.details.wallet_available_iqd, 30_000);
  await Promise.allSettled(pending);
});

test('the debit never takes more cents than the wallet holds — a CHECK abort would FAIL the order, not refuse it', async () => {
  const { db, raw } = setup();
  await topUp(db, raw, 25_000, 'T6a');
  await topUp(db, raw, 25_000, 'T6b');
  const a = app(db);
  cartLine(raw, 'ci1');
  const placed = await json(await post(a, '/api/orders', orderBody()));
  assert.equal(placed.success, true, JSON.stringify(placed));
  // 50,000 د.ع of order value against the 3,570 cents that are actually there:
  // floor(5,000,000 / 1,400) is 3,571, one more than the wallet holds, and an
  // uncapped debit would violate CHECK (amount > 0) and abort the whole batch.
  const stored = raw
    .prepare('SELECT wallet_applied_iqd, wallet_applied_usd_cents FROM orders WHERE id = ?')
    .get(placed.order.id) as { wallet_applied_iqd: number; wallet_applied_usd_cents: number };
  assert.deepEqual({ ...stored }, { wallet_applied_iqd: 50_000, wallet_applied_usd_cents: 3570 });
  const debit = raw
    .prepare("SELECT amount, amount_iqd FROM wallet_transactions WHERE id = ?")
    .get(`wtx_ord_${placed.order.id}_usd`) as { amount: number; amount_iqd: number };
  assert.deepEqual({ ...debit }, { amount: 3570, amount_iqd: 50_000 });
  await Promise.allSettled(pending);
});
