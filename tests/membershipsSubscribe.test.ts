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
import { classifyHost } from '../worker/lib/hosts';
import { membershipsRoutes } from '../worker/routes/memberships';
import { subscriptionRoutes } from '../worker/routes/subscription';
import { validateCoupon } from '../worker/lib/membershipOps';
import type { Env } from '../worker/lib/types';

const RATE = 1400; // the shipped exchangeRate default: IQD per USD
const cents = (iqd: number) => Math.ceil((iqd * 100) / RATE);

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

  // Configured properly, both are live — and the page may say so.
  raw.exec(`INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('preorderGiftConfig','{"enabled":true,"product_id":"p1","label_ar":"بكرة","qty":1}')`);
  raw.exec(`INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('printerGiftConfig','{"enabled":true,"plan_id":"plus_1mo","milestone":"delivered"}')`);
  raw.exec(`INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('shippingPolicy','{"pro_threshold_iqd":80000}')`);
  body = await json(await a.request('/api/memberships/plans'));
  assert.deepEqual(body.features, { printer_gift: true, preorder_gift: true });
  assert.deepEqual(body.delivery, { pro_threshold_iqd: 80000, prime_threshold_iqd: 150000 }, 'a partial policy keeps the shipped default');
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

// --------------------------------------------------------------- pre-launch

test('before the launch a purchase is reserved at full price and a lower tier cannot sit under a prepaid higher one', async () => {
  const { db, raw } = setup(false);
  seedBalance(raw, 'u1', 1_000_000);
  const a = app(db, 'u1');
  const b = await json(await subscribe(a, 'prime_12mo', 'pre-prime-0001'));
  assert.equal((b.membership as Record<string, unknown>).state, 'prepaid_pending_launch');
  assert.equal(b.credit_iqd, 0);

  const again = await json(await subscribe(a, 'prime_12mo', 'pre-prime-0002'));
  assert.equal(again.code, 'ALREADY_PREPAID');
  const lower = await json(await subscribe(a, 'plus_12mo', 'pre-plus-0001'));
  assert.equal(lower.code, 'DOWNGRADE_BLOCKED');

  // The quote for a higher tier says it will be reserved — and that it
  // REPLACES the PREMIUM reservation, crediting its whole value: one
  // reservation per account, never two waiting for the launch.
  const q = (await json(await a.request('/api/memberships/quote?planId=pro_12mo'))).quote as Record<string, unknown>;
  assert.equal(q.ok, true);
  assert.equal(q.activate_now, false);
  assert.equal(q.expires_at, null);
  assert.equal(q.upgrade_from_tier, 'prime');
  assert.equal(q.credit_iqd, 99000);
  assert.equal(q.charge_iqd, 400000);
  assert.deepEqual(q.pending_tiers, [], 'kept for pages loaded before the rule — always empty now');
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
  assert.equal(fresh.charge_usd_cents, Math.ceil((29000 * 100) / 1500));
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
