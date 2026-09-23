/**
 * Buying a membership — the rules the confirmation window relies on.
 *
 * ONE MEMBERSHIP AT A TIME. A lower tier upgrades into a higher one with the
 * unused value credited (PLUS→PREMIUM, PLUS→PRO, PREMIUM→PRO), a higher tier is
 * never downgraded while it runs, PREMIUM keeps the legacy `prime` id, a replay never
 * charges twice, and an empty wallet is refused before anything is written.
 * The quote endpoint must say exactly what the purchase then does.
 *
 * Real schema (every migration, in order), real wallet CHECK constraints.
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
import { walletSpendCents } from '../worker/lib/walletOps';
import { classifyHost } from '../worker/lib/hosts';
import { membershipsRoutes } from '../worker/routes/memberships';
import { subscriptionRoutes } from '../worker/routes/subscription';
import { addMonths, validateCoupon } from '../worker/lib/membershipOps';
import type { Env } from '../worker/lib/types';

const RATE = 1400; // the shipped exchangeRate default: IQD per USD
/*
  THE SAME CONVERSION THE PURCHASE USES, imported rather than copied.
  This helper held its own `Math.ceil`, and when `walletSpendCents` moved to
  FLOOR — «عند الدولار يقرب الى عدد صحيح اقل», the rule that stopped a 50,000
  د.ع deposit refusing a 50,000 د.ع bill — six tests failed against code that
  was right. A test that re-implements the arithmetic it is checking only
  ever pins the copy.
*/
const cents = (iqd: number) => walletSpendCents(iqd, null, RATE);

function setup(launched = true) {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(join(dir, f), 'utf8'));
  }
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash) VALUES
      ('u1','Sara','s@x.co','h'), ('u2','Omar','o@x.co','h'), ('u3','Lina','l@x.co','h'), ('boss','Admin','ad@x.co','h');
  `);
  raw.exec(
    `INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('launchConfig','${
      launched ? '{"activated":true}' : '{"activated":false}'
    }')`
  );
  return { raw, db: new SqliteD1(raw) as unknown as D1Database };
}

function seedBalance(raw: DatabaseSync, userId: string, usdCents: number) {
  raw
    .prepare(
      `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, created_by, decided_at)
       VALUES (?, ?, 'deposit', 'USD', ?, 'approved', 'seed', 'admin', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    )
    .run(`wtx_seed_${userId}_${usdCents}_${Math.random().toString(36).slice(2, 7)}`, userId, usdCents);
}

function app(db: D1Database, userId: string | null, role = 'customer', host = 'levonis-iq.com') {
  const a = new Hono<AppContext>();
  a.use('*', async (c, next) => {
    if (userId) c.set('user', { id: userId, role, created_at: new Date().toISOString() } as never);
    // The host classification worker/index.ts computes for every request:
    // the main site by default, a merchant subdomain when a test asks for one.
    c.set('host', classifyHost(host, 'levonis-iq.com'));
    c.env = { DB: db } as never;
    await next();
  });
  a.route('/api/memberships', membershipsRoutes);
  a.route('/api/subscription', subscriptionRoutes);
  a.onError((err, c) => {
    if (err instanceof HttpError) {
      // Mirrors worker/index.ts: a refusal's machine-readable context travels with it.
      return c.json(
        { success: false, error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) },
        err.status as 400
      );
    }
    throw err;
  });
  return a;
}

type App = ReturnType<typeof app>;
const post = (a: App, path: string, body: Record<string, unknown>) =>
  a.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const subscribe = (a: App, planId: string, key: string, extra: Record<string, unknown> = {}) =>
  post(a, '/api/memberships/subscribe', { planId, idempotencyKey: key, ...extra });
const json = async (r: Response) => (await r.json()) as Record<string, unknown>;

const rows = (raw: DatabaseSync, user: string) =>
  raw.prepare('SELECT * FROM memberships WHERE user_id = ? ORDER BY created_at').all(user) as Array<Record<string, unknown>>;
const walletRows = (raw: DatabaseSync, user: string) =>
  raw.prepare("SELECT * FROM wallet_transactions WHERE user_id = ? AND type = 'withdrawal'").all(user) as Array<Record<string, unknown>>;

// ------------------------------------------------------------- /plans

test('/plans reports the conditional gifts and the delivery thresholds from settings', async () => {
  const { db, raw } = setup();
  const a = app(db, null);
  let body = await json(await a.request('/api/memberships/plans'));
  assert.deepEqual(body.features, { printer_gift: false, preorder_gift: false }, 'nothing is enabled by default');
  assert.deepEqual(body.delivery, { pro_threshold_iqd: 75000, prime_threshold_iqd: 150000 });
  const plans = body.plans as Array<Record<string, unknown>>;
  assert.equal(plans.length, 6);
  assert.ok(plans.every((p) => !Object.keys(p).some((k) => k.includes('cost'))));
  // The per-month figure the cards show is the SERVER's arithmetic.
  for (const p of plans) {
    assert.equal(p.per_month_iqd, Math.round((p.price_iqd as number) / (p.duration_months as number)), `${p.id} per_month_iqd`);
  }
  assert.equal(plans.find((p) => p.id === 'plus_12mo')?.per_month_iqd, 2417);

  // An enabled preorder gift WITHOUT a product is not a gift.
  raw.exec(`INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('preorderGiftConfig','{"enabled":true,"product_id":"","label_ar":"","qty":1}')`);
  raw.exec(`INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('printerGiftConfig','{"enabled":true,"plan_id":"no_such_plan","milestone":"delivered"}')`);
  body = await json(await a.request('/api/memberships/plans'));
  assert.deepEqual(body.features, { printer_gift: false, preorder_gift: false });

  // Configured properly, the pre-order gift is live — and the page may say so.
  // The printer gift is NOT, whatever its switch says: it is granted by hand
  // now (nothing calls grantPrinterGiftIfEligible), so advertising it on the
  // card would promise something no code gives.
  raw.exec(`INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('preorderGiftConfig','{"enabled":true,"product_id":"p1","label_ar":"بكرة","qty":1}')`);
  raw.exec(`INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('printerGiftConfig','{"enabled":true,"plan_id":"plus_1mo","milestone":"delivered"}')`);
  raw.exec(`INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('shippingPolicy','{"pro_threshold_iqd":80000}')`);
  body = await json(await a.request('/api/memberships/plans'));
  assert.deepEqual(body.features, { printer_gift: false, preorder_gift: true });
  assert.deepEqual(body.delivery, { pro_threshold_iqd: 80000, prime_threshold_iqd: 150000 }, 'a partial policy keeps the shipped default');
});

/**
 * D1 REFUSES MORE THAN 100 BOUND PARAMETERS; node:sqlite ALLOWS 999. A
 * statement built with one `?` per row passes every test here and fails in
 * production at 101 (tests/d1ParameterCeilings.test.ts). This adapter holds
 * the suite to the production ceiling.
 */
class CeilingD1 extends SqliteD1 {
  override prepare(sql: string) {
    const stmt = super.prepare(sql);
    const bind = stmt.bind.bind(stmt);
    stmt.bind = (...values: unknown[]) => {
      if (values.length > 100) throw new Error(`D1_ERROR: too many SQL variables (${values.length})`);
      return bind(...values);
    };
    return stmt;
  }
}

function seedCatalogue(raw: DatabaseSync, printers: number) {
  raw.exec(`
    INSERT INTO catalogs (id,parent_id,slug,name_ar,name_en,is_printer_catalog) VALUES
      ('sb_printers',NULL,'sb-printers','الطابعات','Printers',1),
      ('sb_filament',NULL,'sb-filament','الفلمنت','Filament',0);
  `);
  const product = raw.prepare(
    `INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images,category_id,sub_category_id)
     VALUES (?,?,?,?,?,?,20,'[]','[]','direct_sale','["direct_sale"]','[]','[]',?,NULL)`
  );
  const rule = raw.prepare(
    `INSERT INTO membership_benefit_rules (id,tier,benefit_type,scope,product_id,discount_mode,percent,fixed_iqd,max_discount_iqd,cap_scope,enabled,priority,label)
     VALUES (?,?,'product_discount','product',?,?,?,?,?,?,1,0,?)`
  );
  for (let i = 0; i < printers; i++) {
    product.run(`pp${i}`, `sb-printer-${i}`, `Printer Model ${i}`, `طابعة موديل ${i}`, 1_000_000, 'active', 'sb_printers');
    rule.run(`r-pro-p${i}`, 'pro', `pp${i}`, 'percent', 10, null, 100000, 'per_unit', `PRO on printer ${i}`);
    rule.run(`r-prime-p${i}`, 'prime', `pp${i}`, 'fixed', null, 25000, null, null, null);
  }
  // Filament: two products share one offer, a third has its own.
  for (const [id, pct] of [['pf1', 5], ['pf2', 5], ['pf3', 7]] as const) {
    product.run(id, `sb-${id}`, `Filament ${id}`, `فلمنت ${id}`, 25_000, 'active', 'sb_filament');
    rule.run(`r-pro-${id}`, 'pro', id, 'percent', pct, null, null, null, null);
  }
  // A product filed under no section, and one that is not for sale.
  product.run('loose', 'sb-loose', 'Loose Nozzle', 'فوهة مفردة', 10_000, 'active', null);
  rule.run('r-pro-loose', 'pro', 'loose', 'percent', 3, null, null, null, null);
  product.run('hid', 'sb-hid', 'Hidden Printer', 'طابعة مخفية', 1_000_000, 'hidden', 'sb_printers');
  rule.run('r-pro-hid', 'pro', 'hid', 'percent', 50, null, null, null, null);
}

test('/plans states a product discount on its section — never per product, never with a product name — and answers past the D1 bind ceiling', async () => {
  const { raw } = setup();
  seedCatalogue(raw, 150);
  const res = await app(new CeilingD1(raw) as unknown as D1Database, null).request('/api/memberships/plans');
  assert.equal(res.status, 200, 'a store with 150 per-product rules can still open the subscription page');
  const text = await res.text();
  assert.equal(/Printer Model|طابعة موديل|Filament pf|فلمنت pf|Loose Nozzle|Hidden Printer/.test(text), false, 'no product name leaves the server');
  const benefits = (JSON.parse(text) as { benefits: Record<string, { discounts: Array<Record<string, unknown>> }> }).benefits;

  const pro = benefits.pro.discounts;
  const printers = pro.filter((d) => d.target_id === 'sb_printers');
  assert.equal(printers.length, 1, '150 identical per-printer rules are one line');
  assert.equal(printers[0].scope, 'category');
  assert.equal(printers[0].target_name_ar, 'الطابعات');
  assert.equal(printers[0].percent, 10);
  assert.equal(printers[0].max_discount_iqd, 100000);
  assert.equal(printers[0].cap_scope, 'per_unit');
  assert.equal(printers[0].product_count, 150, 'the hidden printer is not counted — nobody can buy it');
  assert.equal(printers[0].label, null, 'a per-product label does not speak for 150 products');

  const filament = pro.filter((d) => d.target_id === 'sb_filament').map((d) => [d.percent, d.product_count]);
  assert.deepEqual(filament, [[5, 2], [7, 1]]);
  const loose = pro.filter((d) => d.target_id === null);
  assert.deepEqual(loose.map((d) => [d.scope, d.percent, d.target_name_ar]), [['category', 3, '']]);
  assert.equal(pro.some((d) => d.percent === 50), false, 'the hidden product\'s rule promises nothing');

  const premium = benefits.prime.discounts;
  assert.equal(premium.length, 1);
  assert.equal(premium[0].discount_mode, 'fixed');
  assert.equal(premium[0].fixed_iqd, 25000);
  assert.equal(premium[0].target_name_ar, 'الطابعات');
});

test('/plans advertises the delivery rule the checkout would choose — priority, then id — not the last one in row order', async () => {
  const { db, raw } = setup();
  raw.exec(`
    INSERT INTO membership_benefit_rules (id,tier,benefit_type,scope,free_shipping_threshold_iqd,shipping_methods,enabled,priority,label) VALUES
      ('fs-a','pro','free_shipping','global',50000,'["standard","personal"]',1,5,'high'),
      ('fs-b','pro','free_shipping','global',60000,'["standard"]',1,1,'low, but written last');
  `);
  const body = await json(await app(db, null).request('/api/memberships/plans'));
  const fs = (body.benefits as Record<string, Record<string, Record<string, unknown>>>).pro.free_shipping;
  assert.equal(fs.rule_id, 'fs-a');
  assert.equal(fs.threshold_iqd, 50000);

  // The checkout's own selector over the same rows says the same thing.
  const { resolveOrderBenefits, activeBenefitRules } = await import('../worker/lib/membershipBenefits');
  const order = resolveOrderBenefits({
    rules: await activeBenefitRules(db),
    status: { tier: 'pro', active: true, expires_at: null, pending_launch: null, gated_benefits: [] },
    shippingBasisIqd: 55000,
    deliveryMethod: 'personal',
    nowIso: new Date().toISOString(),
  });
  assert.equal(order.shipping.rule_id, 'fs-a');
});

// ------------------------------------------------------- a plain purchase

test('a purchase charges the wallet at the current rate and a replay charges once', async () => {
  const { db, raw } = setup();
  seedBalance(raw, 'u1', 100_000);
  const a = app(db, 'u1');

  const first = await subscribe(a, 'plus_12mo', 'attempt-0001');
  assert.equal(first.status, 200);
  const b1 = await json(first);
  assert.equal(b1.replay, false);
  assert.equal(b1.charged_iqd, 29000);
  assert.equal(b1.charged_usd_cents, cents(29000));
  assert.equal((b1.membership as Record<string, unknown>).state, 'active');
  assert.equal((b1.membership as Record<string, unknown>).tier, 'plus');

  const second = await subscribe(a, 'plus_12mo', 'attempt-0001');
  assert.equal(second.status, 200);
  const b2 = await json(second);
  assert.equal(b2.replay, true, 'the same key is the same attempt');
  assert.equal(b2.charged_iqd, 29000, 'a replay tells the same story');
  assert.equal(b2.charged_usd_cents, cents(29000), 'including the wallet debit it made');
  assert.equal(rows(raw, 'u1').length, 1);
  assert.equal(walletRows(raw, 'u1').length, 1, 'one wallet debit');
  assert.equal(Number(walletRows(raw, 'u1')[0].amount), cents(29000));
  // What the row carries into a later upgrade (migration 0052).
  const row = rows(raw, 'u1')[0];
  assert.equal(Number(row.price_paid_iqd), 29000);
  assert.equal(Number(row.credit_basis_iqd), 29000);
  assert.equal(Number(row.credit_applied_iqd), 0);
});

test('an empty wallet is refused with INSUFFICIENT_BALANCE and nothing is written', async () => {
  const { db, raw } = setup();
  seedBalance(raw, 'u1', 100); // one dollar
  const a = app(db, 'u1');
  const r = await subscribe(a, 'pro_12mo', 'attempt-poor-0001');
  assert.equal(r.status, 400);
  assert.equal((await json(r)).code, 'INSUFFICIENT_BALANCE');
  assert.equal(rows(raw, 'u1').length, 0);
  assert.equal(walletRows(raw, 'u1').length, 0);
});

// --------------------------------------------------------- PREMIUM wording

test('the legacy prime tier is called PREMIUM in every customer refusal, never PLUS', async () => {
  const { db, raw } = setup();
  seedBalance(raw, 'u1', 1_000_000);
  const a = app(db, 'u1');
  assert.equal((await subscribe(a, 'prime_12mo', 'prime-0001')).status, 200);

  const again = await json(await subscribe(a, 'prime_12mo', 'prime-0002'));
  assert.equal(again.code, 'ALREADY_SUBSCRIBED');
  assert.match(String(again.error), /PREMIUM/);
  assert.doesNotMatch(String(again.error), /PLUS/);
});

// -------------------------------------------------------------- upgrades

test('PLUS → PREMIUM is a prorated upgrade: credit for the unused PLUS, old row ended, one active row', async () => {
  const { db, raw } = setup();
  seedBalance(raw, 'u1', 1_000_000);
  const a = app(db, 'u1');
  assert.equal((await subscribe(a, 'plus_12mo', 'up-plus-0001')).status, 200);

  const r = await subscribe(a, 'prime_12mo', 'up-prime-0001');
  assert.equal(r.status, 200);
  const b = await json(r);
  // Bought moments ago: every day of PLUS is unused, so the whole 29,000 comes back.
  assert.equal(b.credit_iqd, 29000);
  assert.equal(b.charged_iqd, 99000 - 29000);
  assert.equal(b.charged_usd_cents, cents(70000));
  assert.equal(b.upgraded_from, 'plus');

  const all = rows(raw, 'u1');
  assert.deepEqual(
    all.map((m) => [m.tier, m.state]),
    [
      ['plus', 'cancelled'],
      ['prime', 'active'],
    ]
  );
  const u = raw.prepare('SELECT membership_tier FROM users WHERE id = ?').get('u1') as { membership_tier: string };
  assert.equal(u.membership_tier, 'prime');
  // The PREMIUM row is worth its PRICE to a later upgrade, not the 70,000 it
  // cost after the credit — and it remembers the credit it consumed.
  const prime = all[1];
  assert.equal(Number(prime.price_paid_iqd), 70000);
  assert.equal(Number(prime.credit_basis_iqd), 99000);
  assert.equal(Number(prime.credit_applied_iqd), 29000);
});

test('two hops keep the first credit: PLUS → PREMIUM → PRO on one day charges the PRO price in total, and a replay reports the same credit', async () => {
  const { db, raw } = setup();
  seedBalance(raw, 'u1', 1_000_000);
  // A 199,000 PRO makes the arithmetic of the finding visible: 29,000 +
  // 70,000 + 100,000 = 199,000 — not 29,000 + 70,000 + 129,000 = 228,000.
  raw.exec("UPDATE membership_plans SET price_iqd = 199000 WHERE id = 'pro_12mo'");
  const a = app(db, 'u1');

  const hop1 = await json(await subscribe(a, 'plus_12mo', 'hop-1-0001'));
  const hop2 = await json(await subscribe(a, 'prime_12mo', 'hop-2-0001'));
  const hop3 = await json(await subscribe(a, 'pro_12mo', 'hop-3-0001'));
  assert.equal(hop1.charged_iqd, 29000);
  assert.equal(hop2.charged_iqd, 70000);
  assert.equal(hop2.credit_iqd, 29000);
  assert.equal(hop3.credit_iqd, 99000, 'the second hop credits the PREMIUM price, not the post-credit charge');
  assert.equal(hop3.charged_iqd, 100000);
  assert.equal(Number(hop1.charged_iqd) + Number(hop2.charged_iqd) + Number(hop3.charged_iqd), 199000);
  assert.equal(rows(raw, 'u1').filter((m) => m.state === 'active').length, 1);

  // A retried confirmation of the last hop tells the same story.
  const replay = await json(await subscribe(a, 'pro_12mo', 'hop-3-0001'));
  assert.equal(replay.replay, true);
  assert.equal(replay.credit_iqd, 99000);
  assert.equal(replay.charged_iqd, 100000);
  assert.equal(replay.charged_usd_cents, cents(100000));
  assert.equal(walletRows(raw, 'u1').length, 3, 'three debits, never a fourth');
});

test('PREMIUM → PRO is a prorated upgrade too — the rule is any lower → higher', async () => {
  const { db, raw } = setup();
  seedBalance(raw, 'u1', 1_000_000);
  const a = app(db, 'u1');
  assert.equal((await subscribe(a, 'prime_12mo', 'up2-prime-0001')).status, 200);

  const b = await json(await subscribe(a, 'pro_12mo', 'up2-pro-0001'));
  assert.equal(b.credit_iqd, 99000);
  assert.equal(b.charged_iqd, 400000);
  assert.equal(b.upgraded_from, 'prime');
  const active = rows(raw, 'u1').filter((m) => m.state === 'active');
  assert.equal(active.length, 1);
  assert.equal(active[0].tier, 'pro');
});

test('PLUS → PRO still prorates (the original rule is preserved)', async () => {
  const { db, raw } = setup();
  seedBalance(raw, 'u1', 1_000_000);
  const a = app(db, 'u1');
  await subscribe(a, 'plus_1mo', 'up3-plus-0001');
  const b = await json(await subscribe(a, 'pro_12mo', 'up3-pro-0001'));
  assert.equal(b.credit_iqd, 4500);
  assert.equal(b.charged_iqd, 499000 - 4500);
  assert.equal(rows(raw, 'u1').filter((m) => m.state === 'active').length, 1);
});

// ------------------------------------------------------------- downgrades

test('a lower tier cannot be bought under a running higher one', async () => {
  const { db, raw } = setup();
  seedBalance(raw, 'u1', 1_000_000);
  const a = app(db, 'u1');
  assert.equal((await subscribe(a, 'pro_12mo', 'dg-pro-0001')).status, 200);

  const toPrime = await json(await subscribe(a, 'prime_12mo', 'dg-prime-0001'));
  assert.equal(toPrime.code, 'DOWNGRADE_BLOCKED');
  assert.match(String(toPrime.error), /PRO/);
  assert.match(String(toPrime.error), /PREMIUM/);
  const toPlus = await json(await subscribe(a, 'plus_12mo', 'dg-plus-0001'));
  assert.equal(toPlus.code, 'DOWNGRADE_BLOCKED');
  assert.equal(rows(raw, 'u1').length, 1, 'nothing was written');
});

test('PREMIUM → PLUS is a downgrade and is refused', async () => {
  const { db, raw } = setup();
  seedBalance(raw, 'u1', 1_000_000);
  const a = app(db, 'u1');
  assert.equal((await subscribe(a, 'prime_12mo', 'dg2-prime-0001')).status, 200);
  const r = await json(await subscribe(a, 'plus_3mo', 'dg2-plus-0001'));
  assert.equal(r.code, 'DOWNGRADE_BLOCKED');
  assert.match(String(r.error), /PREMIUM/);
  assert.match(String(r.error), /PLUS/);
});

// ------------------------------------------------------------ the launch

/**
 * «الموقع يعمل — اجعل البطاقات والاشتراكات تعمل». A database nobody has ever
 * configured is the one the owner's live site had: no launchConfig row, and a
 * code default that said "not launched", so every card was sold as a
 * reservation that granted nothing. This runs every migration and writes NO
 * setting of its own — exactly that database, after this deploy.
 */
function setupFresh() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(join(dir, f), 'utf8'));
  }
  raw.exec("INSERT INTO users (id,name,email,password_hash) VALUES ('u1','Sara','s@x.co','h'), ('boss','Admin','ad@x.co','h')");
  return { raw, db: new SqliteD1(raw) as unknown as D1Database };
}

test('on a fresh database the site is live: /plans says so, the quote starts now, and a purchase runs for its full duration', async () => {
  const { db, raw } = setupFresh();
  const stored = raw.prepare("SELECT value FROM admin_settings WHERE key = 'launchConfig'").get() as { value: string };
  assert.equal(JSON.parse(stored.value).activated, true, 'migration 0109 writes the launch as activated');

  const plans = await json(await app(db, null).request('/api/memberships/plans'));
  assert.equal((plans.launch as Record<string, unknown>).activated, true);

  seedBalance(raw, 'u1', 1_000_000);
  const a = app(db, 'u1');
  const q = (await json(await a.request('/api/memberships/quote?planId=prime_12mo'))).quote as Record<string, unknown>;
  assert.equal(q.ok, true);
  assert.equal(q.activate_now, true, 'nothing is reserved any more');
  assert.equal(typeof q.expires_at, 'string');

  const before = new Date().toISOString();
  const b = await json(await subscribe(a, 'prime_12mo', 'live-prime-0001'));
  const m = b.membership as Record<string, unknown>;
  assert.equal(m.state, 'active');
  assert.ok(String(m.starts_at) >= before, 'the clock starts at the purchase');
  assert.equal(m.expires_at, addMonths(String(m.starts_at), 12), 'and runs the whole twelve months');

  const mine = await json(await a.request('/api/memberships/mine'));
  const status = mine.status as Record<string, unknown>;
  assert.equal(status.active, true);
  assert.equal(status.tier, 'prime', 'the benefit exists the moment the card is bought');
  assert.equal(status.pending_launch, null);
});

test('with no launch setting stored at all, the code default is live too', async () => {
  const { db, raw } = setupFresh();
  raw.exec("DELETE FROM admin_settings WHERE key = 'launchConfig'");
  seedBalance(raw, 'u1', 1_000_000);
  const a = app(db, 'u1');
  assert.equal(((await json(await a.request('/api/memberships/plans'))).launch as Record<string, unknown>).activated, true);
  const q = (await json(await a.request('/api/memberships/quote?planId=plus_12mo'))).quote as Record<string, unknown>;
  assert.equal(q.activate_now, true);
  const b = await json(await subscribe(a, 'plus_12mo', 'nodefault-0001'));
  assert.equal((b.membership as Record<string, unknown>).state, 'active');
});

test('migration 0109 turns an unlaunched store live, keeps a launched one exactly as it was, and can run twice', () => {
  const run = (seed: string | null) => {
    const raw = new DatabaseSync(':memory:');
    const dir = join(ROOT, 'migrations');
    const files = readdirSync(dir).filter((x) => x.endsWith('.sql')).sort();
    const live = files.find((f) => f.startsWith('0109_'))!;
    for (const f of files) if (f < live) raw.exec(readFileSync(join(dir, f), 'utf8'));
    if (seed !== null) raw.prepare("INSERT INTO admin_settings (key, value) VALUES ('launchConfig', ?)").run(seed);
    const sql = readFileSync(join(dir, live), 'utf8');
    raw.exec(sql);
    raw.exec(sql);
    return JSON.parse((raw.prepare("SELECT value FROM admin_settings WHERE key = 'launchConfig'").get() as { value: string }).value);
  };
  const none = run(null);
  assert.equal(none.activated, true);
  assert.match(String(none.activated_at), /^\d{4}-\d{2}-\d{2}T/);

  const off = run('{"launch_at":"2026-08-01T00:00:00.000Z","activated":false,"activated_at":null}');
  assert.equal(off.activated, true, 'the owner\'s live store is live');
  assert.equal(off.launch_at, '2026-08-01T00:00:00.000Z', 'an announced date is kept');
  assert.match(String(off.activated_at), /^\d{4}-/);

  const on = run('{"launch_at":"2026-01-01T00:00:00.000Z","activated":true,"activated_at":"2026-01-02T00:00:00.000Z"}');
  assert.deepEqual(on, { launch_at: '2026-01-01T00:00:00.000Z', activated: true, activated_at: '2026-01-02T00:00:00.000Z' });
});

test('a reservation left from before the launch starts the first time its account is read — now, not backdated — and supersedes a lower running row', async () => {
  const { db, raw } = setup(false);
  raw.exec(`
    INSERT INTO memberships (id, user_id, plan_id, tier, state, duration_months, price_paid_iqd, starts_at, expires_at, source) VALUES
      ('legacy_plus', 'u1', 'plus_12mo', 'plus', 'active', 12, 0, '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', 'migrated'),
      ('res_prime', 'u1', 'prime_12mo', 'prime', 'prepaid_pending_launch', 12, 99000, NULL, NULL, 'purchase');
  `);
  const a = app(db, 'u1');
  // Before the launch the reservation waits — the gate still means what it says.
  let status = (await json(await a.request('/api/memberships/mine'))).status as Record<string, unknown>;
  assert.equal(status.tier, 'plus');
  assert.deepEqual(status.pending_launch, { tier: 'prime', duration_months: 12 });

  // The launch was recorded months ago; nobody pressed the sweep since.
  raw.exec(`INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('launchConfig','{"launch_at":"2026-01-01T00:00:00.000Z","activated":true,"activated_at":"2026-01-01T00:00:00.000Z"}')`);
  const before = new Date().toISOString();
  status = (await json(await a.request('/api/memberships/mine'))).status as Record<string, unknown>;
  assert.equal(status.active, true);
  assert.equal(status.tier, 'prime', 'what was paid for is what the account now holds');
  assert.equal(status.pending_launch, null);

  const byId = Object.fromEntries(rows(raw, 'u1').map((m) => [m.id, m]));
  assert.equal(byId.res_prime.state, 'active');
  assert.equal(byId.legacy_plus.state, 'cancelled', 'one membership at a time');
  assert.ok(String(byId.res_prime.starts_at) >= before, 'starts now — the months since the launch are not lost');
  assert.equal(byId.res_prime.expires_at, addMonths(String(byId.res_prime.starts_at), 12));
  const cache = raw.prepare('SELECT membership_tier FROM users WHERE id = ?').get('u1') as { membership_tier: string };
  assert.equal(cache.membership_tier, 'prime');

  const audits = () =>
    raw.prepare("SELECT action FROM audit_log WHERE action LIKE 'membership.launch%' ORDER BY action").all().map((r) => (r as { action: string }).action);
  assert.deepEqual(audits(), ['membership.launch_converted', 'membership.launch_dedupe']);
  // Read again: nothing left to convert, nothing written twice.
  await a.request('/api/memberships/mine');
  assert.deepEqual(audits(), ['membership.launch_converted', 'membership.launch_dedupe']);
});

test('a reservation below a running higher membership is left for a human, silently on read', async () => {
  const { db, raw } = setup();
  raw.exec(`
    INSERT INTO memberships (id, user_id, plan_id, tier, state, duration_months, price_paid_iqd, starts_at, expires_at, source) VALUES
      ('run_pro', 'u1', 'pro_12mo', 'pro', 'active', 12, 0, '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', 'admin'),
      ('res_plus', 'u1', 'plus_12mo', 'plus', 'prepaid_pending_launch', 12, 29000, NULL, NULL, 'purchase');
  `);
  const a = app(db, 'u1');
  for (let i = 0; i < 3; i++) {
    const status = (await json(await a.request('/api/memberships/mine'))).status as Record<string, unknown>;
    assert.equal(status.tier, 'pro', 'nobody is downgraded automatically');
  }
  const states = Object.fromEntries(rows(raw, 'u1').map((m) => [m.id, m.state]));
  assert.deepEqual(states, { run_pro: 'active', res_plus: 'prepaid_pending_launch' });
  const n = raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'membership.launch%'").get() as { n: number };
  assert.equal(Number(n.n), 0, 'a page view is not an audit event');
  // The admin panel still sees it — as work by hand, not as sweep work — and
  // the sweep reports it.
  const admin = app(db, 'boss', 'admin');
  const listed = await json(await admin.request('/api/memberships/admin/plans'));
  assert.equal(listed.prepaid_count, 0);
  assert.equal(listed.deferred_count, 1);
  const sweep = await json(await post(admin, '/api/memberships/admin/activate-launch', { confirm: 'ACTIVATE' }));
  assert.equal(sweep.deferred, 1);
});

// ------------------------------------------------------------------ quote

test('the quote says exactly what the purchase then does', async () => {
  const { db, raw } = setup();
  seedBalance(raw, 'u1', 6000); // $60.00
  const a = app(db, 'u1');
  await subscribe(a, 'plus_12mo', 'q-plus-0001'); // costs $20.72 → $39.28 left

  const q = (await json(await a.request('/api/memberships/quote?planId=prime_12mo'))).quote as Record<string, unknown>;
  assert.equal(q.ok, true);
  assert.equal(q.price_iqd, 99000);
  assert.equal(q.credit_iqd, 29000);
  assert.equal(q.charge_iqd, 70000);
  assert.equal(q.exchange_rate, RATE);
  assert.equal(q.charge_usd_cents, cents(70000));
  assert.equal(q.balance_usd_cents, 6000 - cents(29000));
  assert.equal(q.shortfall_usd_cents, cents(70000) - (6000 - cents(29000)));
  assert.equal(q.activate_now, true);
  assert.equal(typeof q.expires_at, 'string');
  assert.equal(q.upgrade_from_tier, 'plus');
  assert.ok(!Object.keys(q).some((k) => k.includes('cost')));

  // Nothing was written by asking.
  assert.equal(rows(raw, 'u1').length, 1);

  // The purchase then refuses for the very shortfall the quote showed.
  const r = await json(await subscribe(a, 'prime_12mo', 'q-prime-0001'));
  assert.equal(r.code, 'INSUFFICIENT_BALANCE');
});

test('the quote carries a refusal as ok:false with the same code the purchase would give', async () => {
  const { db, raw } = setup();
  seedBalance(raw, 'u1', 1_000_000);
  const a = app(db, 'u1');
  await subscribe(a, 'pro_12mo', 'qr-pro-0001');
  const q = (await json(await a.request('/api/memberships/quote?planId=prime_12mo'))).quote as Record<string, unknown>;
  assert.equal(q.ok, false);
  assert.equal(q.code, 'DOWNGRADE_BLOCKED');
  assert.match(String(q.message), /PRO/);

  raw.exec("UPDATE membership_plans SET price_iqd = NULL WHERE id = 'plus_1mo'");
  const unpriced = (await json(await a.request('/api/memberships/quote?planId=plus_1mo'))).quote as Record<string, unknown>;
  assert.equal(unpriced.ok, false);
  assert.equal(unpriced.code, 'PLAN_UNPRICED');

  assert.equal((await a.request('/api/memberships/quote?planId=nope')).status, 404);
  assert.equal((await app(db, null).request('/api/memberships/quote?planId=pro_12mo')).status, 401);
});

test('the quote does not hand out an inactive plan — 404, exactly as GET /plans hides it', async () => {
  const { db, raw } = setup();
  raw.exec("UPDATE membership_plans SET active = 0 WHERE id = 'plus_1mo'");
  const a = app(db, 'u1');
  const r = await a.request('/api/memberships/quote?planId=plus_1mo');
  assert.equal(r.status, 404);
  const body = await json(r);
  assert.equal(body.quote, undefined, 'no refusal payload carrying the plan and its price');
  assert.equal(JSON.stringify(body).includes('4500'), false, 'the price of a withdrawn plan is not in the answer');
  // The purchase path refuses it too, as before.
  seedBalance(raw, 'u1', 1_000_000);
  assert.equal((await json(await subscribe(a, 'plus_1mo', 'inactive-0001'))).code, 'PLAN_UNPRICED');
});

test('a confirmation carries the figures the page showed: a drifted quote is refused with the fresh one, a matching one is charged, none at all means an older client', async () => {
  const { db, raw } = setup();
  seedBalance(raw, 'u1', 1_000_000);
  const a = app(db, 'u1');
  const shown = (await json(await a.request('/api/memberships/quote?planId=plus_12mo'))).quote as Record<string, unknown>;
  assert.equal(shown.charge_usd_cents, cents(29000));

  // The exchange rate moves between the summary and the tap on Confirm.
  raw.exec(`INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('exchangeRate','1500')`);
  const drifted = await subscribe(a, 'plus_12mo', 'drift-0001', { charge_iqd: shown.charge_iqd, charge_usd_cents: shown.charge_usd_cents });
  assert.equal(drifted.status, 409);
  const body = await json(drifted);
  assert.equal(body.code, 'QUOTE_CHANGED');
  const fresh = (body.details as Record<string, unknown>).quote as Record<string, unknown>;
  assert.equal(fresh.ok, true);
  assert.equal(fresh.charge_iqd, 29000);
  assert.equal(fresh.exchange_rate, 1500);
  assert.equal(fresh.charge_usd_cents, walletSpendCents(29000, null, 1500));
  assert.equal(typeof fresh.balance_usd_cents, 'number');
  assert.equal(rows(raw, 'u1').length, 0, 'nothing was written');
  assert.equal(walletRows(raw, 'u1').length, 0, 'nothing was charged');

  // Confirming the fresh figures — same attempt, same key — goes through.
  const ok = await subscribe(a, 'plus_12mo', 'drift-0001', { charge_iqd: fresh.charge_iqd, charge_usd_cents: fresh.charge_usd_cents });
  assert.equal(ok.status, 200);
  assert.equal((await json(ok)).charged_usd_cents, fresh.charge_usd_cents);
  assert.equal(walletRows(raw, 'u1').length, 1);

  // A client that sends no figures is charged the recomputed quote, as before.
  raw.exec(`INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('exchangeRate','1400')`);
  const legacy = await json(await subscribe(app(db, 'u2'), 'plus_12mo', 'legacy-0001'));
  assert.equal(legacy.code, 'INSUFFICIENT_BALANCE', 'the older client reaches the charge (and u2 has no money)');

  // Half-sent figures are a malformed request, not a silent fallback.
  assert.equal((await subscribe(a, 'prime_12mo', 'half-0001', { charge_iqd: 70000 })).status, 400);
});

// ------------------------------------------------------------------ legacy

test('the legacy /api/subscription contract still buys through the same core', async () => {
  const { db, raw } = setup();
  seedBalance(raw, 'u1', 1_000_000);
  const a = app(db, 'u1');
  const r = await post(a, '/api/subscription/subscribe', { plan: 'plus', durationId: '1yr' });
  assert.equal(r.status, 200);
  const b = await json(r);
  assert.equal(b.plan, 'plus');
  assert.equal(b.state, 'active');
  assert.equal(rows(raw, 'u1')[0].plan_id, 'plus_12mo');
});

// ------------------------------------------------------------------- admin

test('the admin plan list shows inactive plans too, and only to admins', async () => {
  const { db, raw } = setup();
  raw.exec("UPDATE membership_plans SET active = 0 WHERE id = 'plus_1mo'");
  const admin = app(db, 'boss', 'admin');
  const b = await json(await admin.request('/api/memberships/admin/plans'));
  const plans = b.plans as Array<Record<string, unknown>>;
  assert.equal(plans.length, 6);
  assert.equal(plans.find((p) => p.id === 'plus_1mo')?.active, false);
  assert.equal((b.launch as Record<string, unknown>).activated, true);

  const pub = (await json(await app(db, null).request('/api/memberships/plans'))).plans as unknown[];
  assert.equal(pub.length, 5, 'the public list hides the inactive plan');

  assert.equal((await app(db, 'u1').request('/api/memberships/admin/plans')).status, 403);

  const patched = await admin.request('/api/memberships/admin/plans/plus_1mo', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ price_iqd: null, active: true }),
  });
  assert.equal(patched.status, 200);
  const plan = (await json(patched)).plan as Record<string, unknown>;
  assert.equal(plan.price_iqd, null);
  assert.equal(plan.purchasable, false);
  assert.equal(plan.active, true);
});

test('after the launch the panel still reaches a leftover reservation: it is counted, and the sweep starts it NOW', async () => {
  const { db, raw } = setup();
  raw.exec(`INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('launchConfig','{"launch_at":"2026-01-01T00:00:00.000Z","activated":true,"activated_at":"2026-01-01T00:00:00.000Z"}')`);
  // A straggler written by a legacy or racing writer after the launch.
  raw.exec(`
    INSERT INTO memberships (id, user_id, plan_id, tier, state, duration_months, price_paid_iqd, starts_at, expires_at, source) VALUES
      ('late', 'u2', 'plus_12mo', 'plus', 'prepaid_pending_launch', 12, 29000, NULL, NULL, 'purchase');
  `);
  const admin = app(db, 'boss', 'admin');
  const listed = await json(await admin.request('/api/memberships/admin/plans'));
  assert.equal(listed.prepaid_count, 1, 'the panel can see there is something to sweep');

  const before = new Date().toISOString();
  const r = await json(await post(admin, '/api/memberships/admin/activate-launch', { confirm: 'ACTIVATE' }));
  assert.equal(r.already_activated, true);
  assert.equal(r.converted, 1);
  assert.equal(r.prepaid_count, 0);
  assert.equal(r.activated_at, '2026-01-01T00:00:00.000Z', 'the launch keeps its own date');
  const late = rows(raw, 'u2')[0];
  assert.equal(late.state, 'active');
  assert.ok(String(late.starts_at) >= before, 'not backdated to the launch — the customer loses no days');
  assert.equal(late.expires_at, addMonths(String(late.starts_at), 12));
});

test('a reservation under a higher running tier is counted as deferred, not as sweep work, so the button can go dark', async () => {
  const { db, raw } = setup();
  raw.exec(`INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('launchConfig','{"launch_at":"2026-01-01T00:00:00.000Z","activated":true,"activated_at":"2026-01-01T00:00:00.000Z"}')`);
  raw.exec(`
    INSERT INTO memberships (id, user_id, plan_id, tier, state, duration_months, price_paid_iqd, starts_at, expires_at, source) VALUES
      ('run-pro', 'u2', 'pro_12mo', 'pro', 'active', 12, 499000, '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', 'purchase'),
      ('stuck',   'u2', 'plus_12mo', 'plus', 'prepaid_pending_launch', 12, 29000, NULL, NULL, 'purchase'),
      ('go',      'u3', 'plus_12mo', 'plus', 'prepaid_pending_launch', 12, 29000, NULL, NULL, 'purchase');
  `);
  const admin = app(db, 'boss', 'admin');
  const listed = await json(await admin.request('/api/memberships/admin/plans'));
  assert.equal(listed.prepaid_count, 1, 'only the reservation the sweep can start');
  assert.equal(listed.deferred_count, 1);

  const r = await json(await post(admin, '/api/memberships/admin/activate-launch', { confirm: 'ACTIVATE' }));
  assert.equal(r.converted, 1);
  assert.equal(r.deferred, 1);
  assert.equal(r.prepaid_count, 0, 'nothing left the sweep could start — the button goes dark instead of «(1)» forever');
  assert.equal(r.deferred_count, 1, 'the stuck one is still named, as work by hand');
  assert.equal(rows(raw, 'u2').find((m) => m.id === 'stuck')?.state, 'prepaid_pending_launch');
});

test('the memberships admin surface exists only on the main host — a merchant subdomain answers 404 even to an admin', async () => {
  const { db, raw } = setup();
  const onShop = app(db, 'boss', 'admin', 'shop.levonis-iq.com');
  assert.equal((await onShop.request('/api/memberships/admin/plans')).status, 404);
  assert.equal((await onShop.request('/api/memberships/admin/list')).status, 404);
  const patched = await onShop.request('/api/memberships/admin/plans/plus_1mo', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ price_iqd: 1 }),
  });
  assert.equal(patched.status, 404);
  assert.equal((await post(onShop, '/api/memberships/admin/activate-launch', { confirm: 'ACTIVATE' })).status, 404);
  assert.equal(
    (await post(onShop, '/api/memberships/admin/grant', { userId: 'u1', planId: 'plus_1mo', reason: 'from a shop page', idempotencyKey: 'shopgrant1' })).status,
    404
  );
  assert.equal((await post(onShop, '/api/memberships/admin/nope/cancel', {})).status, 404);
  // Nothing moved.
  const price = raw.prepare("SELECT price_iqd FROM membership_plans WHERE id = 'plus_1mo'").get() as { price_iqd: number };
  assert.equal(price.price_iqd, 4500);
  assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM memberships').get() as { n: number }).n, 0);
  // The public routes are still served on the storefront host, and the main host still administers.
  assert.equal((await onShop.request('/api/memberships/plans')).status, 200);
  assert.equal((await app(db, 'boss', 'admin').request('/api/memberships/admin/plans')).status, 200);
});

// ---------------------------------------------------------- coupon ladder

test('the coupon ladder follows inheritance and honours a paused exclusiveCoupons benefit', async () => {
  const { db, raw } = setup();
  seedBalance(raw, 'u1', 1_000_000);
  seedBalance(raw, 'u2', 1_000_000);
  seedBalance(raw, 'u3', 1_000_000);
  await subscribe(app(db, 'u1'), 'pro_12mo', 'cp-pro-0001');
  await subscribe(app(db, 'u2'), 'plus_12mo', 'cp-plus-0001');
  await subscribe(app(db, 'u3'), 'prime_12mo', 'cp-premium-0001');
  raw.prepare(
    "INSERT INTO coupons (id, code, tier_required, kind, value, max_per_user) VALUES ('c1', 'PRIMEONLY', 'prime', 'fixed_iqd', 1000, 5)"
  ).run();
  raw.prepare(
    "INSERT INTO coupons (id, code, tier_required, kind, value, max_per_user) VALUES ('c2', 'PLUSONLY', 'plus', 'fixed_iqd', 1000, 5)"
  ).run();
  const env = { DB: db } as unknown as Env;

  // PRO is above PRIME on the ladder, so a PRO member may use a PRIME coupon.
  assert.equal((await validateCoupon(env, 'u1', 'PRIMEONLY', 50000)).ok, true);
  assert.equal((await validateCoupon(env, 'u3', 'PRIMEONLY', 50000)).ok, true, 'PREMIUM receives its own coupon');
  // PLUS is below it.
  assert.equal((await validateCoupon(env, 'u2', 'PRIMEONLY', 50000)).reason, 'TIER_REQUIRED');
  assert.equal((await validateCoupon(env, 'u2', 'PLUSONLY', 50000)).ok, true);
  assert.equal((await validateCoupon(env, 'u3', 'PLUSONLY', 50000)).ok, true, 'PREMIUM inherits PLUS coupons');
  assert.equal((await validateCoupon(env, 'u1', 'PLUSONLY', 50000)).ok, true, 'PRO inherits PLUS coupons');

  // An admin restriction on exclusiveCoupons pauses the coupon for the PRO member.
  raw.prepare(
    "INSERT INTO restriction_cases (id, user_id, kind, state, reason, benefit_flags) VALUES ('rc1', 'u1', 'other', 'active', 'review', '[\"exclusiveCoupons\"]')"
  ).run();
  assert.equal((await validateCoupon(env, 'u1', 'PRIMEONLY', 50000)).reason, 'TIER_REQUIRED');
});
