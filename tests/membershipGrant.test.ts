/**
 * Granting a membership without a payment.
 *
 * `memberships.source` has allowed `'admin'` since 0001 and nothing ever
 * wrote one, so the only way to hold PLUS was to buy it. The tests here pin
 * the three things that make an entitlement grant safe to have at all:
 *
 *   IT IS NOT A TRANSACTION. No wallet row, no ledger movement, price 0.
 *   That is what lets it stand up a merchant on a live deployment without a
 *   financial movement — and what would make it dangerous if it quietly
 *   became one.
 *
 *   IT GRANTS ONCE. The row id is derived from the caller's idempotency key,
 *   so a double-tapped button is one membership, not two.
 *
 *   IT RESPECTS THE LAUNCH GATE, exactly as a purchase does. Before launch a
 *   grant is `prepaid_pending_launch`, not a pretend-active membership.
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

function setup(launched = true) {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(join(dir, f), 'utf8'));
  }
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash) VALUES
      ('u1','Sara','s@x.co','h'), ('boss','Admin','ad@x.co','h');
  `);
  raw.exec(
    `INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('launchConfig','${
      launched ? '{"activated":true}' : '{"activated":false}'
    }')`
  );
  return { raw, db: new SqliteD1(raw) as unknown as D1Database };
}

function app(db: D1Database, role = 'admin') {
  const a = new Hono<AppContext>();
  a.use('*', async (c, next) => {
    c.set('user', { id: 'boss', role } as never);
    // The admin routes are main-host only (worker/index.ts sets this per request).
    c.set('host', classifyHost('levonis-iq.com', 'levonis-iq.com'));
    c.env = { DB: db } as never;
    await next();
  });
  a.route('/api/memberships', membershipsRoutes);
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

const grant = (a: ReturnType<typeof app>, body: Record<string, unknown>) =>
  a.request('/api/memberships/admin/grant', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const ok = { userId: 'u1', planId: 'plus_1mo', reason: 'comped after a failed payment', idempotencyKey: 'grantkey1' };

// ------------------------------------------------------------- the grant

test('an admin can grant PLUS, and the account may then operate a store', async () => {
  const { db, raw } = setup();
  const res = await grant(app(db), ok);
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.replayed, false);
  assert.equal(body.tier, 'plus');
  assert.equal(body.active, true);

  const m = raw.prepare('SELECT * FROM memberships WHERE user_id = ?').get('u1') as Record<string, string | number>;
  assert.equal(m.tier, 'plus');
  assert.equal(m.state, 'active');
  assert.equal(m.source, 'admin');
  // The cached tier on the user row is refreshed immediately, so the very
  // next request from that account already sees what it may do.
  const u = raw.prepare('SELECT membership_tier FROM users WHERE id = ?').get('u1') as { membership_tier: string };
  assert.equal(u.membership_tier, 'plus');
});

test('NO MONEY MOVES — that is the whole point', async () => {
  const { db, raw } = setup();
  await grant(app(db), ok);

  const m = raw.prepare('SELECT price_paid_iqd, wallet_tx_id, credit_basis_iqd FROM memberships WHERE user_id = ?').get('u1') as
    { price_paid_iqd: number; wallet_tx_id: string | null; credit_basis_iqd: number };
  assert.equal(Number(m.price_paid_iqd), 0);
  assert.equal(m.wallet_tx_id, null);
  assert.equal(Number(m.credit_basis_iqd), 0, 'a grant is worth nothing toward a later paid upgrade');

  const wallet = raw.prepare('SELECT COUNT(*) AS n FROM wallet_transactions').get() as { n: number };
  assert.equal(Number(wallet.n), 0, 'a grant wrote a wallet transaction');
  const holds = raw.prepare('SELECT COUNT(*) AS n FROM wallet_holds').get() as { n: number };
  assert.equal(Number(holds.n), 0);
});

test('the reason is recorded, because a grant nobody can explain gets reversed', async () => {
  const { db, raw } = setup();
  await grant(app(db), ok);
  const m = raw.prepare('SELECT source_ref FROM memberships WHERE user_id = ?').get('u1') as { source_ref: string };
  assert.match(m.source_ref, /^admin:boss:/);
  assert.match(m.source_ref, /failed payment/);

  const a = raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'admin.membership_granted'").get() as
    { n: number };
  assert.equal(Number(a.n), 1);
});

test('a reason is required', async () => {
  const { db } = setup();
  const res = await grant(app(db), { ...ok, reason: '' });
  assert.equal(res.status, 400);
});

// -------------------------------------------------------------- retries

test('a double-tapped grant produces ONE membership', async () => {
  const { db, raw } = setup();
  const a = app(db);
  const first = await grant(a, ok);
  const second = await grant(a, ok);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(((await second.json()) as Record<string, unknown>).replayed, true);

  const n = raw.prepare('SELECT COUNT(*) AS n FROM memberships WHERE user_id = ?').get('u1') as { n: number };
  assert.equal(Number(n.n), 1);
});

test('a DIFFERENT key is a different, deliberate grant — once the account holds no live membership', async () => {
  const { db, raw } = setup();
  const a = app(db);
  await grant(a, ok);
  // ONE MEMBERSHIP AT A TIME applies to grants too: while the first is live,
  // a second is refused rather than stacked (migration 0052's index would
  // refuse the row anyway; the route says why first).
  const stacked = await grant(a, { ...ok, idempotencyKey: 'grantkey2', reason: 'extended by another month' });
  assert.equal(stacked.status, 409);
  const body = (await stacked.json()) as Record<string, unknown>;
  assert.equal(body.code, 'ALREADY_SUBSCRIBED');
  assert.match(String(body.error), /cancel it first/i);
  assert.equal(Number((raw.prepare('SELECT COUNT(*) AS n FROM memberships WHERE user_id = ?').get('u1') as { n: number }).n), 1);

  // After the first is cancelled, the second key is a new, deliberate grant.
  raw.exec("UPDATE memberships SET state = 'cancelled' WHERE user_id = 'u1'");
  const second = await grant(a, { ...ok, idempotencyKey: 'grantkey2', reason: 'extended by another month' });
  assert.equal(second.status, 200);
  const n = raw.prepare('SELECT COUNT(*) AS n FROM memberships WHERE user_id = ?').get('u1') as { n: number };
  assert.equal(Number(n.n), 2);
  assert.equal(Number((raw.prepare("SELECT COUNT(*) AS n FROM memberships WHERE user_id = 'u1' AND state = 'active'").get() as { n: number }).n), 1);
});

test('a grant over a paid membership is refused — the customer is not silently double-covered', async () => {
  const { db, raw } = setup();
  raw.exec(`
    INSERT INTO memberships (id, user_id, plan_id, tier, state, duration_months, price_paid_iqd, starts_at, expires_at)
    VALUES ('paid', 'u1', 'prime_12mo', 'prime', 'active', 12, 99000, '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z');
  `);
  const res = await grant(app(db), { ...ok, planId: 'pro_12mo' });
  assert.equal(res.status, 409);
  const body = (await res.json()) as Record<string, unknown>;
  assert.match(String(body.error), /PRIME/);
  assert.deepEqual(body.details, { membership_id: 'paid', tier: 'prime', state: 'active' });
  // A replay of an EARLIER grant is still a replay, whatever the account holds now.
  raw.exec("INSERT INTO memberships (id, user_id, plan_id, tier, state, duration_months) VALUES ('mem_grant_grantkey1', 'u1', 'plus_1mo', 'plus', 'expired', 1)");
  const replay = await grant(app(db), ok);
  assert.equal(replay.status, 200);
  assert.equal(((await replay.json()) as Record<string, unknown>).replayed, true);
});

test('before launch a grant is refused while a reservation is waiting, with the prepaid code', async () => {
  const { db, raw } = setup(false);
  raw.exec(`
    INSERT INTO memberships (id, user_id, plan_id, tier, state, duration_months, price_paid_iqd)
    VALUES ('res', 'u1', 'plus_12mo', 'plus', 'prepaid_pending_launch', 12, 29000);
  `);
  const res = await grant(app(db), ok);
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as Record<string, unknown>).code, 'ALREADY_PREPAID');
});

// ---------------------------------------------------------- the launch gate

test('before launch a grant is prepaid, not a pretend-active membership', async () => {
  const { db, raw } = setup(false);
  const res = await grant(app(db), ok);
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.active, false);

  const m = raw.prepare('SELECT state, starts_at, expires_at FROM memberships WHERE user_id = ?').get('u1') as
    { state: string; starts_at: string | null; expires_at: string | null };
  assert.equal(m.state, 'prepaid_pending_launch');
  assert.equal(m.starts_at, null);
  assert.equal(m.expires_at, null);
  // And it says so, rather than letting an admin believe the account is live.
  assert.match(String(body.note), /not active yet/i);
});

// ------------------------------------------------------------ refusals

test('a non-admin cannot grant anything', async () => {
  const { db } = setup();
  const res = await grant(app(db, 'customer'), ok);
  assert.equal(res.status, 403);
});

test('an unknown user or plan is refused rather than half-written', async () => {
  const { db, raw } = setup();
  const a = app(db);
  assert.equal((await grant(a, { ...ok, userId: 'nobody' })).status, 404);
  assert.equal((await grant(a, { ...ok, planId: 'no_such_plan' })).status, 404);
  const n = raw.prepare('SELECT COUNT(*) AS n FROM memberships').get() as { n: number };
  assert.equal(Number(n.n), 0);
});
