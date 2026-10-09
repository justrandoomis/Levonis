/**
 * OWNER DECISION 9 (2026-10-09): THE LEVO WALLET RATE STAYS 1 USD = 1,400
 * IQD, COMPLETELY SEPARATE FROM THE MARKET RATE THE PRICING ENGINE USES.
 *
 *   apart        an approved USD/IQD of 1,680 leaves admin_settings.exchangeRate
 *                at 1,400; /api/settings/public carries both, each in its own
 *                key
 *   wallet       after that apply, a wallet deposit typed in dinars and a
 *                checkout paid from the wallet both convert at 1,400 — the
 *                cents are floor(dinars × 100 / 1,400), never / 1,680
 *   preview      the admin price preview reads the SHOP's rate (null before
 *                the first approval), never the wallet's
 *   source       no wallet, escrow, Quick Buy, membership or checkout code —
 *                nor any worker file that names the wallet's exchangeRate —
 *                imports the FX module or names its tables; no FX or engine
 *                code reads the wallet's exchangeRate
 *
 * Run: node --import tsx --test tests/walletRateSeparation.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { OWNER, asD1, freshDb, get, json, post, put, row, stubApp } from './fixtures/app';
import { OWNER_ROW_SQL, fxEnv, market, pairOf } from './fixtures/fx';
import { ROOT } from './fixtures/d1';
import { codeOf } from './fixtures/source';
import { productMediaFixtureEnv } from './fixtures/productMedia';
import { acceptedPolicies } from './lib/policies';
import { adminPricingRoutes } from '../worker/routes/adminPricing';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { miscRoutes } from '../worker/routes/misc';
import { walletRoutes } from '../worker/routes/wallet';
import { orderRoutes } from '../worker/routes/orders';
import { cartRoutes } from '../worker/routes/cart';
import { runFxScheduler } from '../worker/lib/fx/scheduler';
import { getSetting } from '../worker/lib/settings';

const WALLET = 1400;
const BUYER = { id: 'buyer', role: 'customer' as const, email: 's@x.co' };
const ASSISTANT = { id: 'asst', role: 'admin' as const, email: 'a@x.co', admin_scope: 'assistant' };

function seed(): DatabaseSync {
  const raw = freshDb();
  raw.exec(OWNER_ROW_SQL);
  raw.exec(`
    INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('exchangeRate', '${WALLET}');
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('buyer','Sara','s@x.co','h','customer');
    INSERT INTO users (id,name,email,password_hash,role,admin_scope) VALUES ('asst','Asst','a@x.co','h','admin','assistant');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default)
      VALUES ('addr_b','buyer','Home','Sara','+9647701234567','Baghdad, Karrada 12','',1);
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status) VALUES ('dep_b','buyer','deposit','USD',100000,'approved');
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images)
      VALUES ('p_pla','pla-basic','PLA Basic','PLA أساسي',25000,'active',50,'[]','[]','direct_sale','["direct_sale"]','[]','[]');
    INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty)
      VALUES ('ci1','buyer','p_pla','','[]','','','','',2);
  `);
  return raw;
}

const ownerApp = (raw: DatabaseSync) =>
  stubApp(asD1(raw), OWNER, (a) => {
    a.route('/api/admin/pricing', adminPricingRoutes);
    a.route('/api/admin/products', adminProductsRoutes);
    a.route('/api/', miscRoutes);
  });

/** The owner's example: market 1,660 + 20 dinars, held as the first value, approved → 1,680. */
async function approveUsdAt1680(raw: DatabaseSync) {
  const app = ownerApp(raw);
  const v = () => Number(pairOf(raw, 'USD_IQD').owner_version);
  assert.equal((await put(app, '/api/admin/pricing/rates/fx/USD_IQD/settings', { owner_version: v(), market_adjustment_iqd: '20' })).status, 200);
  const m = market({ sell: 1660 });
  m.state.at = new Date();
  await runFxScheduler(fxEnv(raw), { now: new Date() }, { trigger: 'refresh', pairs: ['USD_IQD'], fetchImpl: m.f.fetch, actorId: 'usr_owner' });
  assert.equal(pairOf(raw, 'USD_IQD').pending_effective_rate, '1680');
  assert.equal((await post(app, '/api/admin/pricing/rates/fx/USD_IQD/review', { owner_version: v(), decision: 'approve' })).status, 200);
  assert.equal(pairOf(raw, 'USD_IQD').effective_rate, '1680');
}

test('an approved market rate of 1,680 leaves the wallet rate at 1,400; the public settings carry both, apart', async () => {
  const raw = seed();
  await approveUsdAt1680(raw);
  assert.equal(row<{ value: string }>(raw, "SELECT value FROM admin_settings WHERE key = 'exchangeRate'")!.value, String(WALLET));
  assert.equal(Number(await getSetting(asD1(raw), 'exchangeRate')), WALLET);
  const pub = (await json(await get(ownerApp(raw), '/api/settings/public'))).settings;
  assert.equal(pub.exchangeRate, WALLET, 'the wallet rate, a number');
  assert.equal(pub.displayUsdRate, '1680', 'the market rate, decimal text');
});

test('after the 1,680 apply, a deposit typed in dinars and a checkout paid from the wallet both convert at 1,400', async () => {
  const raw = seed();
  await approveUsdAt1680(raw);

  // A deposit of 50,000 د.ع — the tab sends the cents a 1,680 reading would give; the server converts the dinars itself.
  const media = productMediaFixtureEnv();
  await media.privateBucket.put('receipts/buyer/r1.webp', new Uint8Array([1, 2, 3, 4, 5, 6]));
  const buyer = stubApp(asD1(raw), BUYER, (a) => {
    a.route('/api/wallet', walletRoutes);
    a.route('/api/orders', orderRoutes);
    a.route('/api/cart', cartRoutes);
  }, { env: media.env });
  const dep = await post(buyer, '/api/wallet/deposits', { amount_usd_cents: 2976, declared_amount_iqd: 50_000, receiptKey: 'receipts/buyer/r1.webp', paymentMethod: 'zaincash', reference: 'ref-1' });
  assert.equal(dep.status, 200, JSON.stringify(await dep.clone().json()));
  const tx = row<{ amount: number; id: string }>(raw, "SELECT id, amount FROM wallet_transactions WHERE user_id = 'buyer' AND type = 'deposit' AND id <> 'dep_b'")!;
  assert.equal(tx.amount, Math.floor((50_000 * 100) / WALLET), '3,571 cents at 1,400');
  assert.notEqual(tx.amount, Math.floor((50_000 * 100) / 1680), 'never 2,976 at the market rate');
  const meta = row<{ exchange_rate_snapshot: number }>(raw, 'SELECT exchange_rate_snapshot FROM wallet_deposit_meta WHERE tx_id = ?', tx.id)!;
  assert.equal(meta.exchange_rate_snapshot, WALLET);

  // A checkout paid from the wallet.
  const order = await post(buyer, '/api/orders', {
    addressId: 'addr_b',
    deliveryMethodId: 'standard',
    paymentMethodId: 'wallet',
    useWallet: true,
    usePoints: false,
    itemIds: [],
    idempotencyKey: `wrs-${Date.now()}`,
    policyAcceptance: acceptedPolicies(),
  });
  const body = await json(order);
  assert.equal(order.status, 200, JSON.stringify(body));
  const applied = body.order.wallet_applied_iqd as number;
  assert.ok(applied > 0, 'the wallet paid');
  const o = row<{ exchange_rate: number; wallet_applied_usd_cents: number }>(raw, 'SELECT exchange_rate, wallet_applied_usd_cents FROM orders WHERE id = ?', body.order.id)!;
  assert.equal(o.exchange_rate, WALLET, 'the order snapshots the wallet rate');
  assert.equal(o.wallet_applied_usd_cents, Math.floor((applied * 100) / WALLET));
  assert.notEqual(o.wallet_applied_usd_cents, Math.floor((applied * 100) / 1680));
  const debit = row<{ amount: number; amount_iqd: number | null; exchange_rate_snapshot: number | null }>(
    raw,
    "SELECT amount, amount_iqd, exchange_rate_snapshot FROM wallet_transactions WHERE user_id = 'buyer' AND type = 'withdrawal'"
  );
  assert.ok(debit, 'a wallet debit was written');
  assert.equal(debit!.amount, Math.floor((applied * 100) / WALLET), 'the debit converts at 1,400');
  assert.equal(debit!.amount_iqd, applied);
  assert.equal(debit!.exchange_rate_snapshot, WALLET);
});

test("the admin price preview reads the shop's rate — null before the first approval, never the wallet's 1,400 — for an assistant too", async () => {
  const raw = seed();
  const asOwner = ownerApp(raw);
  const before = await json(await post(asOwner, '/api/admin/products/p_pla/quote', {}));
  assert.equal(before.quote.usd_preview, null, 'no shop rate yet: no dollar figure (not 1,400)');
  await approveUsdAt1680(raw);
  const after = await json(await post(asOwner, '/api/admin/products/p_pla/quote', {}));
  assert.deepEqual(after.quote.usd_preview, {
    exchange_rate_iqd_per_usd: '1680',
    applied_usd: Math.floor((25_000 * 100) / 1680) / 100,
    unit_subtotal_usd: Math.floor((after.quote.unit_subtotal_iqd * 100) / 1680) / 100,
  });
  // The display rate is public by design; the assistant's preview carries it and nothing private of FX.
  const assistant = stubApp(asD1(raw), ASSISTANT, (a) => a.route('/api/admin/products', adminProductsRoutes));
  const res = await post(assistant, '/api/admin/products/p_pla/quote', {});
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.equal(JSON.parse(text).quote.usd_preview.exchange_rate_iqd_per_usd, '1680');
  assert.doesNotMatch(text, /market_adjustment_iqd|market_rate|"20"|1660|cost_iqd":\d/, 'no FX private figure, no cost');
});

// ------------------------------------------------------------- source rules

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) tsFiles(p, out);
    else if (name.endsWith('.ts')) out.push(relative(ROOT, p));
  }
  return out;
}

test('the wallet side never reaches the FX module: wallet, escrow, Quick Buy, memberships, checkout — and every worker file that converts at the wallet rate — import nothing of it and name none of its tables', () => {
  const named = [
    'worker/lib/walletOps.ts',
    'worker/routes/wallet.ts',
    'worker/lib/escrowOps.ts',
    ...tsFiles(join(ROOT, 'worker/lib/quickBuy')),
    'worker/routes/memberships.ts',
    'worker/lib/membershipOps.ts',
    'worker/routes/orders.ts',
    'worker/lib/walletAdjust.ts',
  ];
  // EVERY worker file whose code names the wallet's `exchangeRate` is wallet side, so a new one is
  // held without being listed here (FX-1A review: security #5 — escrow checkout in storeOrders, the
  // wallet adjustments and their notices were missed). The FX module itself is the other side.
  const walletRateReaders = tsFiles(join(ROOT, 'worker')).filter((f) => !f.startsWith('worker/lib/fx/') && /\bexchangeRate\b/.test(codeOf(f)));
  for (const f of ['worker/routes/storeOrders.ts', 'worker/routes/adminWalletAdjust.ts', 'worker/lib/walletNotify.ts', 'worker/routes/adminFinanceWorkspace.ts']) {
    assert.ok(walletRateReaders.includes(f), `${f} converts at the wallet rate and is held`);
  }
  const walletSide = [...new Set([...named, ...walletRateReaders])];
  assert.ok(walletSide.length >= 18, String(walletSide.length));
  for (const f of walletSide) {
    const src = codeOf(f);
    assert.doesNotMatch(src, /from\s+['"][^'"]*\/fx\/[^'"]+['"]/, `${f} imports the FX module`);
    assert.doesNotMatch(src, /\b(pricing_fx_rates|fx_rate_pairs|fx_rate_log)\b/, `${f} names an FX table`);
    assert.doesNotMatch(src, /displayUsdRate|getDisplayUsdRate/, `${f} reads the market display rate`);
  }
});

test("the FX side never reads the wallet's rate: no FX, engine or pricing-package code names exchangeRate", () => {
  const fxSide = [...tsFiles(join(ROOT, 'worker/lib/fx')), ...tsFiles(join(ROOT, 'worker/lib/pricingEngine')), ...tsFiles(join(ROOT, 'packages/pricing/src'))];
  assert.ok(fxSide.length >= 20);
  for (const f of fxSide) {
    const src = codeOf(f);
    assert.doesNotMatch(src, /\bexchangeRate\b/, `${f} reads the wallet's exchangeRate`);
  }
});
