/**
 * ONE OFFICIAL USD/IQD FOR THE WHOLE SITE, EVEN IN THE WALLET (owner
 * 2026-10-18, DECISIONS row 252 — overturning owner decision 9's separate
 * wallet rate of 1,400 and amending rows 220/246/248).
 *
 *   public       an approved USD/IQD of 1,680 (market 1,660 + 20) is the public
 *                display rate AND the wallet's `exchangeRate` in
 *                /api/settings/public; the legacy admin setting stays 1,400,
 *                untouched and unread
 *   wallet       after that apply, GET /api/wallet, a deposit typed in dinars
 *                and a checkout paid from the wallet all convert at 1,680; a
 *                snapshot recorded at 1,400 before it stays 1,400
 *   fallback     with no applied rate the wallet converts at the legacy
 *                setting, and with that unusable at its default — never 0
 *   manual       a rate the owner types on MANUAL is the display rate and the
 *                wallet rate, never credited to IQWealth
 *   preview      the admin price preview reads the official rate, for the
 *                owner and an assistant alike
 *   source       no worker file reads the legacy setting except through
 *                worker/lib/fx/officialRate.ts
 *
 * Run: node --import tsx --test tests/officialRate.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { OWNER, asD1, freshDb, get, json, post, put, row, stubApp } from './fixtures/app';
import { OWNER_ROW_SQL, applyRate, fxEnv, market, pairOf } from './fixtures/fx';
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
import { getOfficialUsdRate } from '../worker/lib/fx/officialRate';
import { runWalletRateRebase } from '../worker/lib/walletRateRebase';
import { getPublicDisplayRate } from '../worker/lib/fx/displayRate';

/** The legacy admin setting — the fallback only while no applied rate exists. */
const LEGACY = 1400;
const BUYER = { id: 'buyer', role: 'customer' as const, email: 's@x.co' };
const ASSISTANT = { id: 'asst', role: 'admin' as const, email: 'a@x.co', admin_scope: 'assistant' };

function seed(): DatabaseSync {
  const raw = freshDb();
  raw.exec(OWNER_ROW_SQL);
  raw.exec(`
    INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('exchangeRate', '${LEGACY}');
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

test('an approved rate of 1,680 is the one official rate: the public settings carry it as the display rate and the wallet rate; the legacy setting is untouched', async () => {
  const raw = seed();
  await approveUsdAt1680(raw);
  assert.equal(row<{ value: string }>(raw, "SELECT value FROM admin_settings WHERE key = 'exchangeRate'")!.value, String(LEGACY));
  assert.equal(Number(await getSetting(asD1(raw), 'exchangeRate')), LEGACY);
  assert.equal(await getOfficialUsdRate(asD1(raw)), 1680);
  const pub = (await json(await get(ownerApp(raw), '/api/settings/public'))).settings;
  assert.equal(pub.exchangeRate, 1680, 'the wallet rate is the official rate, a whole-dinar number');
  assert.equal(pub.displayUsdRate, '1680', 'the display rate is the applied rate the products are priced at, exactly');
  assert.equal(pub.displayUsdRateAttributed, true, 'built from the market reading: «based on IQWealth data»');
});

test('after the 1,680 apply, the wallet balance, a deposit typed in dinars and a checkout paid from the wallet convert at 1,680; a snapshot taken at 1,400 before it stays 1,400', async () => {
  const raw = seed();
  const media = productMediaFixtureEnv();
  await media.privateBucket.put('receipts/buyer/r0.webp', new Uint8Array([1, 2, 3, 4, 5, 6]));
  await media.privateBucket.put('receipts/buyer/r1.webp', new Uint8Array([1, 2, 3, 4, 5, 6]));
  // `publishV2: false` until the rate is approved: the clean-start fixture would otherwise approve its own
  // fixture rate on the first customer request (tests/fixtures/autoPublish.ts).
  const mount = (a: Parameters<Parameters<typeof stubApp>[2]>[0]) => {
    a.route('/api/wallet', walletRoutes);
    a.route('/api/orders', orderRoutes);
    a.route('/api/cart', cartRoutes);
  };
  const early_ = stubApp(asD1(raw), BUYER, mount, { env: media.env, publishV2: false });
  const buyer = stubApp(asD1(raw), BUYER, mount, { env: media.env });
  const deposit = async (app: typeof buyer, receipt: string, ref: string) => {
    const res = await post(app, '/api/wallet/deposits', { amount_usd_cents: 2976, declared_amount_iqd: 50_000, receiptKey: `receipts/buyer/${receipt}`, paymentMethod: 'zaincash', reference: ref });
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    return row<{ id: string; amount: number; exchange_rate_snapshot: number }>(
      raw,
      `SELECT t.id, t.amount, m.exchange_rate_snapshot FROM wallet_transactions t JOIN wallet_deposit_meta m ON m.tx_id = t.id
        WHERE t.user_id = 'buyer' AND t.type = 'deposit' AND t.id <> 'dep_b' ORDER BY t.created_at DESC, t.rowid DESC LIMIT 1`
    )!;
  };

  // Before any applied rate: the legacy setting, as before.
  const early = await deposit(early_, 'r0.webp', 'ref-0');
  assert.equal(early.exchange_rate_snapshot, LEGACY);
  assert.equal(early.amount, Math.floor((50_000 * 100) / LEGACY));

  await approveUsdAt1680(raw);

  const wallet = await json(await get(buyer, '/api/wallet'));
  assert.equal(wallet.balance_usd_cents, 100_000);
  assert.equal(wallet.balance_iqd, Math.floor((100_000 * 1680) / 100), 'the balance in dinars at the official 1,680');

  const late = await deposit(buyer, 'r1.webp', 'ref-1');
  assert.equal(late.exchange_rate_snapshot, 1680);
  assert.equal(late.amount, Math.floor((50_000 * 100) / 1680), '2,976 cents at 1,680');
  const kept = row<{ exchange_rate_snapshot: number; amount: number }>(
    raw,
    'SELECT m.exchange_rate_snapshot, t.amount FROM wallet_deposit_meta m JOIN wallet_transactions t ON t.id = m.tx_id WHERE m.tx_id = ?',
    early.id
  )!;
  assert.deepEqual([kept.exchange_rate_snapshot, kept.amount], [LEGACY, Math.floor((50_000 * 100) / LEGACY)], 'money history is never rewritten');

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
  assert.equal(o.exchange_rate, 1680, 'the order snapshots the official rate');
  assert.equal(o.wallet_applied_usd_cents, Math.floor((applied * 100) / 1680));
  const debit = row<{ amount: number; amount_iqd: number | null; exchange_rate_snapshot: number | null }>(
    raw,
    "SELECT amount, amount_iqd, exchange_rate_snapshot FROM wallet_transactions WHERE user_id = 'buyer' AND type = 'withdrawal'"
  );
  assert.ok(debit, 'a wallet debit was written');
  assert.equal(debit!.amount, Math.floor((applied * 100) / 1680), 'the debit converts at 1,680');
  assert.equal(debit!.amount_iqd, applied);
  assert.equal(debit!.exchange_rate_snapshot, 1680);
});

test('a shop that held wallet money: the wallet waits at 1,400 after the 1,680 apply until the rebase, then reads the same dinars and a wallet checkout converts at 1,680 (DECISIONS row 252)', async () => {
  const raw = seed();
  raw.exec('DELETE FROM wallet_rate_rebase'); // the state migration 0202 meets on a shop holding money
  const buyer = stubApp(asD1(raw), BUYER, (a) => {
    a.route('/api/wallet', walletRoutes);
    a.route('/api/orders', orderRoutes);
  });
  await approveUsdAt1680(raw);
  assert.equal(await getOfficialUsdRate(asD1(raw)), LEGACY, 'deployed, not rebased: nothing moved');
  const before = await json(await get(buyer, '/api/wallet'));
  assert.equal(before.balance_iqd, Math.floor((100_000 * LEGACY) / 100));

  assert.equal((await runWalletRateRebase({ DB: asD1(raw) })).status, 'rebased');
  assert.equal(await getOfficialUsdRate(asD1(raw)), 1680);
  const after = await json(await get(buyer, '/api/wallet'));
  assert.equal(after.balance_iqd, before.balance_iqd, 'the balance keeps its dinars');
  assert.equal(after.balance_usd_cents, Math.floor((100_000 * LEGACY) / 1680));

  const order = await post(buyer, '/api/orders', {
    addressId: 'addr_b',
    deliveryMethodId: 'standard',
    paymentMethodId: 'wallet',
    useWallet: true,
    usePoints: false,
    itemIds: [],
    idempotencyKey: `wrr-${Date.now()}`,
    policyAcceptance: acceptedPolicies(),
  });
  const body = await json(order);
  assert.equal(order.status, 200, JSON.stringify(body));
  const applied = body.order.wallet_applied_iqd as number;
  assert.ok(applied > 0, 'the wallet paid');
  const o = row<{ exchange_rate: number; wallet_applied_usd_cents: number }>(raw, 'SELECT exchange_rate, wallet_applied_usd_cents FROM orders WHERE id = ?', body.order.id)!;
  assert.deepEqual([o.exchange_rate, o.wallet_applied_usd_cents], [1680, Math.floor((applied * 100) / 1680)]);
  // Paid its dinars: what is left is the balance less the payment, within the one cent the cents cannot resolve (0108).
  const left = (await json(await get(buyer, '/api/wallet'))).balance_iqd as number;
  assert.ok(left >= before.balance_iqd - applied && left < before.balance_iqd - applied + Math.ceil(1680 / 100), String(left));
});

test('no applied rate: the legacy setting, then its default — never 0; a fractional applied rate counts in whole dinars', async () => {
  const raw = seed();
  const db = asD1(raw);
  assert.equal(await getOfficialUsdRate(db), LEGACY);
  const visitor = stubApp(db, null, (a) => a.route('/api/', miscRoutes), { publishV2: false });
  const pub = (await json(await get(visitor, '/api/settings/public'))).settings;
  assert.deepEqual([pub.exchangeRate, pub.displayUsdRate], [LEGACY, null], 'no applied rate: the legacy wallet rate, no display rate');
  raw.exec("UPDATE admin_settings SET value = '1500' WHERE key = 'exchangeRate'");
  assert.equal(await getOfficialUsdRate(db), 1500);
  raw.exec("UPDATE admin_settings SET value = '0' WHERE key = 'exchangeRate'");
  assert.equal(await getOfficialUsdRate(db), 1400, 'an unusable legacy value falls to the default, never 0');
  raw.exec("DELETE FROM admin_settings WHERE key = 'exchangeRate'");
  assert.equal(await getOfficialUsdRate(db), 1400);
  // A database without the FX tables: the legacy path, never a throw.
  const bare = { prepare: (sql: string) => ({ first: async () => { if (/pricing_fx_rates/.test(sql)) throw new Error('no such table: pricing_fx_rates'); return { value: '1450' }; }, bind() { return this; } }) } as unknown as D1Database;
  assert.equal(await getOfficialUsdRate(bare), 1450);
  assert.deepEqual(await getPublicDisplayRate(bare), { displayUsdRate: null, displayUsdRateAttributed: null });

  await approveUsdAt1680(raw);
  applyRate(raw, 'USD_IQD', '1680.6');
  assert.equal(await getOfficialUsdRate(db), 1681, 'U to the nearest whole dinar for the wallet');
  assert.deepEqual(await getPublicDisplayRate(db), { displayUsdRate: '1680.6', displayUsdRateAttributed: true, exchangeRate: 1681 });
});

test('MANUAL: the rate the owner types is the display rate and the wallet rate, the shop\'s own (never credited)', async () => {
  const raw = seed();
  await approveUsdAt1680(raw);
  const owner = ownerApp(raw);
  const res = await put(owner, '/api/admin/pricing/rates/fx/USD_IQD/manual', { owner_version: Number(pairOf(raw, 'USD_IQD').owner_version), rate: '1700' });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(pairOf(raw, 'USD_IQD').mode, 'MANUAL');
  const pub = (await json(await get(owner, '/api/settings/public'))).settings;
  assert.deepEqual([pub.displayUsdRate, pub.exchangeRate, pub.displayUsdRateAttributed], ['1700', 1700, false]);
  assert.equal(await getOfficialUsdRate(asD1(raw)), 1700);
});

test('the admin price preview reads the official rate — null before the first approval, never the legacy 1,400 — for the owner and an assistant alike', async () => {
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
  const assistant = stubApp(asD1(raw), ASSISTANT, (a) => a.route('/api/admin/products', adminProductsRoutes));
  const res = await post(assistant, '/api/admin/products/p_pla/quote', {});
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.equal(JSON.parse(text).quote.usd_preview.exchange_rate_iqd_per_usd, '1680');
  assert.doesNotMatch(text, /market_adjustment_iqd|market_rate|cost_iqd":\d/, 'no FX private field, no cost');
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

test('one reader: no worker file reads the legacy exchangeRate setting except worker/lib/fx/officialRate.ts (the settings defaults and the admin writer name it)', () => {
  const files = tsFiles(join(ROOT, 'worker'));
  const legacyRead = /getSettings?\([^)]*['"]exchangeRate['"]|key\s*=\s*'exchangeRate'|['"]exchangeRate['"],?\s*$/m;
  const readers = files.filter((f) => legacyRead.test(codeOf(f)));
  assert.deepEqual(
    readers.sort(),
    ['worker/lib/fx/officialRate.ts', 'worker/lib/settings.ts', 'worker/routes/admin.ts'],
    'a new reader of the legacy setting must go through getOfficialUsdRate'
  );
  // admin.ts names it only as the writable key and its validator — its readers use the helper.
  assert.doesNotMatch(codeOf('worker/routes/admin.ts'), /getSettings?\([^)]*'exchangeRate'/);
  for (const f of ['worker/routes/wallet.ts', 'worker/routes/orders.ts', 'worker/routes/memberships.ts', 'worker/routes/adminWalletAdjust.ts', 'worker/lib/walletNotify.ts', 'worker/lib/escrowOps.ts', 'worker/routes/admin.ts']) {
    assert.match(codeOf(f), /getOfficialUsdRate/, `${f} reads the official rate`);
  }
});
