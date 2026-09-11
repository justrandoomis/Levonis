/**
 * POST /api/admin/wallet/credit mints money, so it carries the three guards a
 * money-minting route needs and did not have:
 *   - financial scope — an `assistant` admin is refused (403 FINANCIAL_SCOPE_REQUIRED);
 *   - a required idempotency key — the same submit twice credits ONCE and
 *     replays the first result; the same key with a different payload is refused;
 *   - a per-admin rate limit.
 * Off the apex it does not exist (see adminHostGuard.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asD1, stubApp, post, json, count, all, MERCHANT_HOST } from './fixtures/app';
import { adminRoutes } from '../worker/routes/admin';

function build(actor: 'asst' | 'boss' | 'full') {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,admin_scope) VALUES
      ('asst','Assistant','asst@x.co','h','admin','assistant'),
      ('full','Finance','full@x.co','h','admin','full'),
      ('boss','Owner','boss@x.co','h','admin',NULL),
      ('target','Customer','t@x.co','h','customer',NULL);
  `);
  const scope = actor === 'asst' ? 'assistant' : actor === 'full' ? 'full' : null;
  const app = stubApp(asD1(raw), { id: actor, role: 'admin', email: `${actor}@x.co`, admin_scope: scope }, (a) => {
    a.route('/api/admin', adminRoutes);
  }, { env: { INITIAL_ADMIN_EMAIL: 'boss@x.co' } });
  return { app, raw };
}

const settled = (raw: ReturnType<typeof freshDb>, user: string, currency = 'USD') =>
  (raw.prepare(
    `SELECT COALESCE(SUM(CASE WHEN type='deposit' THEN amount ELSE -amount END),0) v
       FROM wallet_transactions WHERE user_id=? AND currency=? AND status='approved'`
  ).get(user, currency) as { v: number }).v;

const body = (idempotencyKey: string, extra: Record<string, unknown> = {}) => ({
  userId: 'target', currency: 'USD', amount: 500_000, note: 'manual top-up', idempotencyKey, ...extra,
});

test('an assistant admin cannot credit a wallet: 403 FINANCIAL_SCOPE_REQUIRED and nothing is written', async () => {
  const { app, raw } = build('asst');
  const res = await post(app, '/api/admin/wallet/credit', body('key-assistant-01'));
  const out = await json(res);
  assert.equal(res.status, 403, JSON.stringify(out));
  assert.equal(out.code, 'FINANCIAL_SCOPE_REQUIRED');
  assert.equal(settled(raw, 'target'), 0);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM wallet_transactions"), 0);
});

test('the owner and a full-scope admin can credit; the key is required and audited', async () => {
  for (const actor of ['boss', 'full'] as const) {
    const { app, raw } = build(actor);
    const missing = await post(app, '/api/admin/wallet/credit', { userId: 'target', currency: 'USD', amount: 1000, note: 'no key' });
    assert.equal(missing.status, 400, 'idempotencyKey is required');
    const short = await post(app, '/api/admin/wallet/credit', body('short'));
    assert.equal(short.status, 400, 'a key shorter than 8 chars is refused');

    const res = await post(app, '/api/admin/wallet/credit', body('key-owner-000001'));
    const out = await json(res);
    assert.equal(res.status, 200, JSON.stringify(out));
    assert.equal(out.replayed, false);
    assert.match(String(out.id), /^wtx_credit_[0-9a-f]{32}$/);
    assert.equal(settled(raw, 'target'), 500_000);
    const audits = all<{ detail: string }>(raw, "SELECT detail FROM audit_log WHERE action='wallet.manual_credit'");
    assert.equal(audits.length, 1);
    assert.match(audits[0].detail, /key-owner-000001/, 'the key is on the audit row');
  }
});

test('a double submit credits once: the second identical request replays the first result', async () => {
  const { app, raw } = build('boss');
  const a = await json(await post(app, '/api/admin/wallet/credit', body('key-double-000001')));
  const b = await json(await post(app, '/api/admin/wallet/credit', body('key-double-000001')));
  assert.equal(a.success, true);
  assert.equal(b.success, true);
  assert.equal(a.id, b.id, 'same ledger row');
  assert.equal(a.replayed, false);
  assert.equal(b.replayed, true);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM wallet_transactions WHERE user_id='target'"), 1);
  assert.equal(settled(raw, 'target'), 500_000, 'not doubled');
  assert.equal(count(raw, "SELECT COUNT(*) n FROM audit_log WHERE action='wallet.manual_credit'"), 1, 'a replay is not a second credit to audit');
});

test('the same key with a different payload is refused, never silently reused', async () => {
  const { app, raw } = build('boss');
  assert.equal((await post(app, '/api/admin/wallet/credit', body('key-reuse-0000001'))).status, 200);
  const res = await post(app, '/api/admin/wallet/credit', body('key-reuse-0000001', { amount: 1 }));
  const out = await json(res);
  assert.equal(res.status, 409, JSON.stringify(out));
  assert.equal(out.code, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal(settled(raw, 'target'), 500_000);
});

test('keys are per admin: two admins with the same key are two credits', async () => {
  const raw = freshDb();
  raw.exec(`INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('boss','Owner','boss@x.co','h','admin'), ('full','Finance','full@x.co','h','admin'), ('target','C','t@x.co','h','customer')`);
  const db = asD1(raw);
  const as = (id: string) => stubApp(db, { id, role: 'admin', email: `${id}@x.co` }, (a) => a.route('/api/admin', adminRoutes), { env: { INITIAL_ADMIN_EMAIL: 'boss@x.co' } });
  const a = await json(await post(as('boss'), '/api/admin/wallet/credit', body('shared-key-00001')));
  const b = await json(await post(as('full'), '/api/admin/wallet/credit', body('shared-key-00001')));
  assert.notEqual(a.id, b.id);
  assert.equal(settled(raw, 'target'), 1_000_000);
});

test('a per-admin rate limit stops a runaway credit loop', async () => {
  const { app, raw } = build('boss');
  let ok = 0;
  let throttled = 0;
  for (let i = 0; i < 25; i++) {
    const res = await post(app, '/api/admin/wallet/credit', body(`rate-key-${String(i).padStart(6, '0')}`, { currency: 'POINT', amount: 10 }));
    if (res.status === 200) ok++;
    else if (res.status === 429) throttled++;
    else assert.fail(`unexpected ${res.status}`);
  }
  assert.equal(ok, 20, 'the first twenty in the window go through');
  assert.equal(throttled, 5);
  assert.equal(settled(raw, 'target', 'POINT'), 200);
});

test('off the apex the route does not exist, whoever holds the session', async () => {
  const raw = freshDb();
  raw.exec("INSERT INTO users (id,name,email,password_hash,role) VALUES ('boss','Owner','boss@x.co','h','admin'), ('target','C','t@x.co','h','customer')");
  const app = stubApp(asD1(raw), { id: 'boss', role: 'admin', email: 'boss@x.co' }, (a) => a.route('/api/admin', adminRoutes), {
    host: MERCHANT_HOST, env: { INITIAL_ADMIN_EMAIL: 'boss@x.co' },
  });
  const res = await post(app, '/api/admin/wallet/credit', body('key-offapex-00001'), { Host: MERCHANT_HOST });
  assert.equal(res.status, 404);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM wallet_transactions'), 0);
});
