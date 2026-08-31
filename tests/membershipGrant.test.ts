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
    c.env = { DB: db } as never;
    await next();
  });
  a.route('/api/memberships', membershipsRoutes);
  a.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ success: false, error: err.message, code: err.code }, err.status as 400);
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

  const m = raw.prepare('SELECT price_paid_iqd, wallet_tx_id FROM memberships WHERE user_id = ?').get('u1') as
    { price_paid_iqd: number; wallet_tx_id: string | null };
  assert.equal(Number(m.price_paid_iqd), 0);
  assert.equal(m.wallet_tx_id, null);

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

test('a DIFFERENT key is a different, deliberate grant', async () => {
  const { db, raw } = setup();
  const a = app(db);
  await grant(a, ok);
  await grant(a, { ...ok, idempotencyKey: 'grantkey2', reason: 'extended by another month' });
  const n = raw.prepare('SELECT COUNT(*) AS n FROM memberships WHERE user_id = ?').get('u1') as { n: number };
  assert.equal(Number(n.n), 2);
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
