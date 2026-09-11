/**
 * ONE MEMBERSHIP AT A TIME, under pressure.
 *
 * quotePurchase reads the ledger with a plain SELECT and subscribeUser then
 * commits a batch. Two purchases fired together — different idempotency keys,
 * the same plan twice or PRIME and PRO at once — both passed that SELECT and
 * both committed: two active rows, the wallet debited twice, and for an
 * upgrade the proration credit granted twice. Migration 0052 puts the rule in
 * the database (a partial UNIQUE index over the active rows), the INSERT
 * refuses when the account already holds any live row at the moment of
 * writing, and the losing batch rolls back with its wallet spend.
 *
 * Real schema (every migration, in order), real constraints. The race is
 * simulated the only way a single-process adapter can: a barrier makes both
 * requests finish their quotes before EITHER batch is allowed to run, then
 * the batches run one after the other, as D1's single writer would run them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ROOT, SqliteD1, type SqliteStatement } from './fixtures/d1';
import type { AppContext } from '../worker/lib/types';
import { HttpError } from '../worker/lib/http';
import { classifyHost } from '../worker/lib/hosts';
import { membershipsRoutes } from '../worker/routes/memberships';
import { grantPrinterGiftIfEligible } from '../worker/lib/membershipOps';
import type { Env } from '../worker/lib/types';

const RATE = 1400;
const cents = (iqd: number) => Math.ceil((iqd * 100) / RATE);

const migrationFiles = () => readdirSync(join(ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort();

function applyMigrations(raw: DatabaseSync, filter: (f: string) => boolean = () => true) {
  for (const f of migrationFiles()) {
    if (filter(f)) raw.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  }
}

function setup(launched = true) {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  applyMigrations(raw);
  raw.exec(`INSERT INTO users (id,name,email,password_hash) VALUES ('u1','Sara','s@x.co','h'), ('boss','Admin','ad@x.co','h');`);
  raw.exec(
    `INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('launchConfig','${
      launched ? '{"activated":true}' : '{"activated":false}'
    }')`
  );
  return raw;
}

function seedBalance(raw: DatabaseSync, userId: string, usdCents: number) {
  raw
    .prepare(
      `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, created_by, decided_at)
       VALUES (?, ?, 'deposit', 'USD', ?, 'approved', 'seed', 'admin', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    )
    .run(`wtx_seed_${userId}_${Math.random().toString(36).slice(2, 9)}`, userId, usdCents);
}

/**
 * A D1 whose batch() holds every caller until `arrivals` of them have reached
 * it — so each has quoted against the SAME ledger — then runs the batches one
 * at a time in arrival order. A lone caller is released after a moment so a
 * test that expects a refusal before the batch cannot hang.
 */
function racingDb(raw: DatabaseSync, arrivals: number): D1Database {
  const inner = new SqliteD1(raw);
  let waiting: Array<() => void> = [];
  let lock: Promise<unknown> = Promise.resolve();
  const release = () => {
    for (const w of waiting) w();
    waiting = [];
  };
  return {
    prepare: (sql: string) => inner.prepare(sql),
    batch: (stmts: SqliteStatement[]) => {
      const gate = new Promise<void>((resolve) => {
        waiting.push(resolve);
        if (waiting.length >= arrivals) release();
        else setTimeout(release, 500).unref();
      });
      return gate.then(() => {
        const run = lock.then(() => inner.batch(stmts));
        lock = run.catch(() => undefined);
        return run;
      });
    },
  } as unknown as D1Database;
}

function app(db: D1Database, userId: string, role = 'customer') {
  const a = new Hono<AppContext>();
  a.use('*', async (c, next) => {
    c.set('user', { id: userId, role, created_at: new Date().toISOString() } as never);
    c.set('host', classifyHost('levonis-iq.com', 'levonis-iq.com'));
    c.env = { DB: db } as never;
    await next();
  });
  a.route('/api/memberships', membershipsRoutes);
  a.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ success: false, error: err.message, code: err.code }, err.status as 400);
    throw err;
  });
  return a;
}
type App = ReturnType<typeof app>;
const subscribe = (a: App, planId: string, key: string) =>
  a.request('/api/memberships/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ planId, idempotencyKey: key }),
  });
const json = async (r: Response) => (await r.json()) as Record<string, unknown>;
const rows = (raw: DatabaseSync, user: string) =>
  raw.prepare('SELECT * FROM memberships WHERE user_id = ? ORDER BY created_at, id').all(user) as Array<Record<string, unknown>>;
const live = (raw: DatabaseSync, user: string, state: string) => rows(raw, user).filter((m) => m.state === state);
const debits = (raw: DatabaseSync, user: string) =>
  raw.prepare("SELECT * FROM wallet_transactions WHERE user_id = ? AND type = 'withdrawal'").all(user) as Array<Record<string, unknown>>;

// ------------------------------------------------------------ the two races

test('the same plan bought twice at once: exactly one active row, one 409, the wallet debited once', async () => {
  const raw = setup();
  seedBalance(raw, 'u1', 1_000_000);
  const a = app(racingDb(raw, 2), 'u1');

  const [r1, r2] = await Promise.all([subscribe(a, 'plus_12mo', 'race-a-0001'), subscribe(a, 'plus_12mo', 'race-b-0001')]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [200, 409], 'one purchase commits, the other is refused');
  const loser = r1.status === 409 ? r1 : r2;
  assert.equal((await json(loser)).code, 'ALREADY_SUBSCRIBED');

  assert.equal(live(raw, 'u1', 'active').length, 1, 'one active membership');
  assert.equal(rows(raw, 'u1').length, 1, 'the losing row never landed');
  assert.equal(debits(raw, 'u1').length, 1, 'one wallet debit — the loser rolled back with its spend');
  assert.equal(Number(debits(raw, 'u1')[0].amount), cents(29000));
});

test('PLUS→PRIME and PLUS→PRO at once: one wins, one is 409, the credit is granted once', async () => {
  const raw = setup();
  seedBalance(raw, 'u1', 1_000_000);
  assert.equal((await subscribe(app(new SqliteD1(raw) as unknown as D1Database, 'u1'), 'plus_12mo', 'race2-plus-0001')).status, 200);

  const a = app(racingDb(raw, 2), 'u1');
  const [r1, r2] = await Promise.all([subscribe(a, 'prime_12mo', 'race2-prime-0001'), subscribe(a, 'pro_12mo', 'race2-pro-0001')]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
  const winner = await json(r1.status === 200 ? r1 : r2);
  const loser = await json(r1.status === 409 ? r1 : r2);
  assert.equal(winner.credit_iqd, 29000, 'the whole unused PLUS came back — once');
  assert.equal(winner.upgraded_from, 'plus');
  assert.equal(loser.code, 'ALREADY_SUBSCRIBED');

  const all = rows(raw, 'u1');
  assert.equal(all.length, 2, 'PLUS and the one winner');
  assert.equal(all.filter((m) => m.state === 'cancelled').length, 1);
  assert.equal(live(raw, 'u1', 'active').length, 1);
  // The credit is written on exactly one row.
  assert.equal(all.reduce((n, m) => n + Number(m.credit_applied_iqd), 0), 29000);
  // Two debits in total: PLUS and the winner — never the loser's.
  assert.equal(debits(raw, 'u1').length, 2);
});

test('two prepaid purchases of higher tiers at once, before the launch: one reservation, the replaced value credited once', async () => {
  const raw = setup(false);
  seedBalance(raw, 'u1', 1_000_000);
  assert.equal((await subscribe(app(new SqliteD1(raw) as unknown as D1Database, 'u1'), 'plus_12mo', 'pre-race-plus-0001')).status, 200);

  const a = app(racingDb(raw, 2), 'u1');
  const [r1, r2] = await Promise.all([subscribe(a, 'prime_12mo', 'pre-race-prime-0001'), subscribe(a, 'pro_12mo', 'pre-race-pro-0001')]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409], 'the index only covers active rows — the INSERT guard covers reservations');
  assert.equal(live(raw, 'u1', 'prepaid_pending_launch').length, 1, 'one reservation');
  assert.equal(rows(raw, 'u1').reduce((n, m) => n + Number(m.credit_applied_iqd), 0), 29000, 'credited once');
  assert.equal(debits(raw, 'u1').length, 2);
});

// ------------------------------------------------------- legacy duplicates

test('migration 0052 resolves duplicate active rows before it creates the index: the latest expiry stays', () => {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  applyMigrations(raw, (f) => f < '0052');
  raw.exec(`INSERT INTO users (id,name,email,password_hash) VALUES ('u1','Sara','s@x.co','h'), ('u2','Omar','o@x.co','h');`);
  // Two active rows for u1 — what the race used to leave behind — and a
  // healthy single row for u2 that must not be touched.
  raw.exec(`
    INSERT INTO memberships (id, user_id, plan_id, tier, state, duration_months, price_paid_iqd, starts_at, expires_at, created_at) VALUES
      ('old', 'u1', 'plus_12mo', 'plus', 'active', 12, 29000, '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
      ('new', 'u1', 'prime_12mo', 'prime', 'active', 12, 99000, '2026-03-01T00:00:00.000Z', '2027-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z'),
      ('tie_a', 'u2', 'pro_12mo', 'pro', 'active', 12, 499000, '2026-03-01T00:00:00.000Z', '2027-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z');
  `);
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM memberships WHERE user_id = 'u1' AND state = 'active'").get() as { n: number }).n, 2);

  applyMigrations(raw, (f) => f.startsWith('0052'));

  // node:sqlite hands back null-prototype rows; copy them into plain objects for the comparison.
  const u1 = (raw.prepare("SELECT id, state FROM memberships WHERE user_id = 'u1' ORDER BY id").all() as Array<{ id: string; state: string }>).map(
    (r) => ({ id: r.id, state: r.state })
  );
  assert.deepEqual(u1, [
    { id: 'new', state: 'active' },
    { id: 'old', state: 'cancelled' },
  ]);
  const u2 = raw.prepare("SELECT state FROM memberships WHERE user_id = 'u2'").get() as { state: string };
  assert.equal(u2.state, 'active', 'a lone active row is untouched');
  // The index now holds: a second active row for u1 is refused by the database itself.
  assert.throws(
    () =>
      raw
        .prepare(
          "INSERT INTO memberships (id, user_id, plan_id, tier, state, duration_months) VALUES ('again', 'u1', 'pro_12mo', 'pro', 'active', 12)"
        )
        .run(),
    /UNIQUE constraint failed: memberships\.user_id/
  );
  // The new columns exist with their defaults.
  const cols = (raw.prepare('PRAGMA table_info(memberships)').all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(cols.includes('credit_basis_iqd') && cols.includes('credit_applied_iqd'));
  const n = raw.prepare("SELECT credit_basis_iqd, credit_applied_iqd FROM memberships WHERE id = 'new'").get() as Record<string, unknown>;
  assert.equal(n.credit_basis_iqd, null, 'legacy rows have no basis — the code falls back to price_paid_iqd');
  assert.equal(n.credit_applied_iqd, 0);
});

test('migration 0052 breaks an expiry tie by the latest purchase', () => {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  applyMigrations(raw, (f) => f < '0052');
  raw.exec(`INSERT INTO users (id,name,email,password_hash) VALUES ('u1','Sara','s@x.co','h');`);
  raw.exec(`
    INSERT INTO memberships (id, user_id, plan_id, tier, state, duration_months, price_paid_iqd, starts_at, expires_at, created_at) VALUES
      ('first', 'u1', 'plus_12mo', 'plus', 'active', 12, 29000, '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
      ('second', 'u1', 'prime_12mo', 'prime', 'active', 12, 99000, '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z');
  `);
  applyMigrations(raw, (f) => f.startsWith('0052'));
  const kept = (raw.prepare("SELECT id FROM memberships WHERE user_id = 'u1' AND state = 'active'").all() as Array<{ id: string }>).map((r) => r.id);
  assert.deepEqual(kept, ['second']);
});

// --------------------------------------------------------- prepaid rule

test('a second reservation: the same tier is ALREADY_PREPAID, a lower one is refused, a higher one replaces the lower with its whole value credited', async () => {
  const raw = setup(false);
  seedBalance(raw, 'u1', 1_000_000);
  const a = app(new SqliteD1(raw) as unknown as D1Database, 'u1');

  const first = await json(await subscribe(a, 'prime_12mo', 'pre-prime-0001'));
  assert.equal((first.membership as Record<string, unknown>).state, 'prepaid_pending_launch');
  assert.equal(first.charged_iqd, 99000);

  // Equal tier → ALREADY_PREPAID. Lower tier → refused (it sits under a higher
  // reservation). Neither writes a row.
  assert.equal((await json(await subscribe(a, 'prime_12mo', 'pre-prime-0002'))).code, 'ALREADY_PREPAID');
  assert.equal((await json(await subscribe(a, 'plus_12mo', 'pre-plus-0001'))).code, 'DOWNGRADE_BLOCKED');
  assert.equal(rows(raw, 'u1').length, 1);

  // Higher tier → the PRIME reservation is ended in the same batch and its
  // FULL value (nothing has started, so nothing was used) comes off PRO.
  const q = (await json(await a.request('/api/memberships/quote?planId=pro_12mo'))).quote as Record<string, unknown>;
  assert.equal(q.ok, true);
  assert.equal(q.credit_iqd, 99000);
  assert.equal(q.charge_iqd, 400000);
  assert.equal(q.upgrade_from_tier, 'prime');
  assert.equal(q.activate_now, false);

  const up = await json(await subscribe(a, 'pro_12mo', 'pre-pro-0001'));
  assert.equal(up.credit_iqd, 99000);
  assert.equal(up.charged_iqd, 400000);
  assert.equal(up.charged_usd_cents, cents(400000));
  assert.equal(up.upgraded_from, 'prime');
  assert.deepEqual(
    rows(raw, 'u1').map((m) => [m.tier, m.state]),
    [
      ['prime', 'cancelled'],
      ['pro', 'prepaid_pending_launch'],
    ],
    'one reservation at a time'
  );
  const pro = rows(raw, 'u1')[1];
  assert.equal(Number(pro.price_paid_iqd), 400000, 'what was charged');
  assert.equal(Number(pro.credit_basis_iqd), 499000, 'what the reservation is worth to a later proration');
  assert.equal(Number(pro.credit_applied_iqd), 99000);
});

// ------------------------------------------------------ launch activation

test('launch activation never violates the index: a legacy account with two reservations activates the highest and cancels the rest, audited', async () => {
  const raw = setup(false);
  // Legacy data the rules no longer allow to be written: two reservations for
  // u1, plus a running 'migrated' PLUS row that the PRO reservation supersedes.
  raw.exec(`
    INSERT INTO memberships (id, user_id, plan_id, tier, state, duration_months, price_paid_iqd, starts_at, expires_at, source) VALUES
      ('legacy_plus', 'u1', 'plus_12mo', 'plus', 'active', 12, 0, '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', 'migrated'),
      ('res_prime', 'u1', 'prime_12mo', 'prime', 'prepaid_pending_launch', 12, 99000, NULL, NULL, 'purchase'),
      ('res_pro', 'u1', 'pro_12mo', 'pro', 'prepaid_pending_launch', 12, 499000, NULL, NULL, 'purchase'),
      ('res_boss', 'boss', 'plus_1mo', 'plus', 'prepaid_pending_launch', 1, 4500, NULL, NULL, 'purchase');
  `);
  const admin = app(new SqliteD1(raw) as unknown as D1Database, 'boss', 'admin');
  const r = await admin.request('/api/memberships/admin/activate-launch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: 'ACTIVATE' }),
  });
  assert.equal(r.status, 200);
  const b = await json(r);
  assert.equal(b.converted, 2, 'one per account: u1 → PRO, boss → PLUS');
  assert.equal(b.deferred, 0);

  const u1 = Object.fromEntries(rows(raw, 'u1').map((m) => [m.id, m.state]));
  assert.deepEqual(u1, { legacy_plus: 'cancelled', res_prime: 'cancelled', res_pro: 'active' });
  assert.equal(live(raw, 'boss', 'active').length, 1);
  const u = raw.prepare('SELECT membership_tier FROM users WHERE id = ?').get('u1') as { membership_tier: string };
  assert.equal(u.membership_tier, 'pro');

  const audits = raw
    .prepare("SELECT target, detail FROM audit_log WHERE action = 'membership.launch_dedupe'")
    .all() as Array<{ target: string; detail: string }>;
  assert.equal(audits.length, 1);
  assert.equal(audits[0].target, 'res_pro');
  const detail = JSON.parse(audits[0].detail) as Record<string, unknown>;
  assert.deepEqual(detail.cancelled_prepaid, [{ id: 'res_prime', tier: 'prime' }]);
  assert.deepEqual(detail.superseded_active, { id: 'legacy_plus', tier: 'plus' });

  // A second activation converts nothing and changes nothing.
  const again = await json(
    await admin.request('/api/memberships/admin/activate-launch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: 'ACTIVATE' }),
    })
  );
  assert.equal(again.already_activated, true);
  assert.equal(again.converted, 0);
});

test('launch activation leaves a reservation LOWER than a running higher membership pending, and says so in the audit log', async () => {
  const raw = setup(false);
  raw.exec(`
    INSERT INTO memberships (id, user_id, plan_id, tier, state, duration_months, price_paid_iqd, starts_at, expires_at, source) VALUES
      ('run_pro', 'u1', 'pro_12mo', 'pro', 'active', 12, 0, '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', 'admin'),
      ('res_plus', 'u1', 'plus_12mo', 'plus', 'prepaid_pending_launch', 12, 29000, NULL, NULL, 'purchase');
  `);
  const admin = app(new SqliteD1(raw) as unknown as D1Database, 'boss', 'admin');
  const b = await json(
    await admin.request('/api/memberships/admin/activate-launch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: 'ACTIVATE' }),
    })
  );
  assert.equal(b.converted, 0);
  assert.equal(b.deferred, 1);
  const states = Object.fromEntries(rows(raw, 'u1').map((m) => [m.id, m.state]));
  assert.deepEqual(states, { run_pro: 'active', res_plus: 'prepaid_pending_launch' }, 'nobody is downgraded automatically');
  const n = raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'membership.launch_activation_deferred'").get() as { n: number };
  assert.equal(Number(n.n), 1);
});

// ---------------------------------------------------------- the printer gift

test('the printer gift writes no second live row: granted to a free account, skipped and audited for a member', async () => {
  const raw = setup();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash) VALUES ('member','Noor','n@x.co','h');
    INSERT INTO products (id,slug,name,price_iqd) VALUES ('p_printer','a1','Bambu A1',899000);
    INSERT INTO catalogs (id, slug, name_ar, is_printer_catalog) VALUES ('cat_test_printers','test-printers','طابعات',1);
    INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES ('p_printer','cat_test_printers',1);
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('printerGiftConfig','{"enabled":true,"plan_id":"plus_12mo","milestone":"delivered"}');
    INSERT INTO memberships (id, user_id, plan_id, tier, state, duration_months, price_paid_iqd, starts_at, expires_at)
      VALUES ('paid_prime', 'member', 'prime_12mo', 'prime', 'active', 12, 99000, '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z');
  `);
  const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
  for (const [id, user] of [['ORD-free', 'u1'], ['ORD-member', 'member']]) {
    raw.exec(`
      INSERT INTO orders (id, user_id, status, address_snapshot, delivery_method_id, delivery_method_snapshot,
         payment_method_id, subtotal_iqd, shipping_iqd, exchange_rate, total_iqd, due_on_delivery_iqd, created_at, updated_at)
       VALUES ('${id}','${user}','delivered','{}','standard','{}','cash',899000,0,1400,899000,0,${NOW},${NOW});
      INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_iqd, line_total_iqd)
       VALUES ('oi_${id}','${id}','p_printer','Bambu A1',1,899000,899000);
    `);
  }
  const env = { DB: new SqliteD1(raw) } as unknown as Env;

  // A free account receives the gift: an active PLUS worth 0 toward a later upgrade.
  assert.equal(await grantPrinterGiftIfEligible(env, 'ORD-free'), 'gift_ORD-free');
  const gift = rows(raw, 'u1')[0];
  assert.equal(gift.state, 'active');
  assert.equal(gift.source, 'gift_printer');
  assert.equal(Number(gift.credit_basis_iqd), 0);
  assert.equal(await grantPrinterGiftIfEligible(env, 'ORD-free'), null, 'the same order grants once');
  assert.equal(rows(raw, 'u1').length, 1);

  // A PRIME member cannot hold a second live row: nothing is written, and the
  // skip is on the record for an admin to act on.
  assert.equal(await grantPrinterGiftIfEligible(env, 'ORD-member'), null);
  assert.deepEqual(rows(raw, 'member').map((m) => m.id), ['paid_prime']);
  const skipped = raw
    .prepare("SELECT target, detail FROM audit_log WHERE action = 'membership.gift_skipped'")
    .all() as Array<{ target: string; detail: string }>;
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].target, 'ORD-member');
  const detail = JSON.parse(skipped[0].detail) as Record<string, unknown>;
  assert.equal(detail.user_id, 'member');
  assert.deepEqual(detail.live, { id: 'paid_prime', tier: 'prime', state: 'active' });
});
