/**
 * DEPLOY AHEAD OF 0177 — CLAUDE.md rule 2, master plan §4.0 rule 4, step S1.
 *
 * Cloudflare can put S1's Worker live before migration 0177 has run. Every
 * new read must therefore tolerate the missing `admin_private_grants` and
 * `security_events` tables, and nothing S1 changed may behave differently on
 * a database one migration behind. Proved three ways on `dbThrough('0176')`:
 *
 *   1. the real session loader, then /api/auth/me: the hints are right;
 *   2. every GET of the base mounts answers EXACTLY as it does on the
 *      migrated database, for the owner and for a full admin (same status,
 *      and the full admin still sees no cost) — except the few routes that
 *      read only a LATER migration's tables, listed by name with the exact
 *      refusal they must give (tests/fixtures/deployAhead.ts);
 *   3. the writes S1 changed — the user PATCH promotion, the withdrawal
 *      notice to the owner — work without the tables.
 *
 * Run: node --import tsx --test tests/costDeployAhead.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { asD1, count, dbThrough, freshDb, json, patch, post, row, stubApp } from './fixtures/app';
import { NOT_A_COST, OWNER, ROLES, appFor, call, getPaths, leaks, seedRoleMatrix } from './fixtures/roleMatrix';
import { DESIGNED_ON_OLDER_DB, judge, unknownMigrations, unreached } from './fixtures/deployAhead';
import { loadSessionUser } from '../worker/lib/session';
import { sha256Hex } from '../worker/lib/crypto';
import { authRoutes } from '../worker/routes/auth';
import { adminRoutes } from '../worker/routes/admin';
import { financeEarningsRoutes } from '../worker/routes/financeEarnings';
import { HttpError } from '../worker/lib/http';
import type { AppContext, Env } from '../worker/lib/types';

const has = (raw: DatabaseSync, name: string) => count(raw, 'SELECT COUNT(*) AS n FROM sqlite_master WHERE name = ?', name) > 0;

test('the fixture really is one migration behind', () => {
  const behind = dbThrough('0176');
  assert.equal(has(behind, 'admin_private_grants'), false);
  assert.equal(has(behind, 'security_events'), false);
  assert.equal(has(behind, 'users_promotion_starts_assistant'), false);
  const ahead = freshDb();
  assert.equal(has(ahead, 'admin_private_grants'), true);
  assert.equal(has(ahead, 'security_events'), true);
});

/** The real session loader in front of the auth routes, the way worker/index.ts mounts them. */
function sessionApp(raw: DatabaseSync) {
  const a = new Hono<AppContext>();
  a.use('*', async (c, next) => {
    c.env = { DB: asD1(raw), INITIAL_ADMIN_EMAIL: 'boss@x.co' } as unknown as Env;
    await loadSessionUser(c);
    await next();
  });
  a.route('/api/auth', authRoutes);
  a.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ success: false, code: err.code }, err.status as 400);
    return c.json({ success: false, error: String(err) }, 500);
  });
  return a;
}

async function meAs(raw: DatabaseSync, userId: string) {
  const token = `deploy-ahead-token-${userId}-0123456789`;
  raw
    .prepare('INSERT INTO sessions (id, user_id, expires_at, user_agent) VALUES (?, ?, ?, ?)')
    .run(await sha256Hex(token), userId, new Date(Date.now() + 86_400_000).toISOString(), 'test');
  const res = await sessionApp(raw).request('https://levonis-iq.com/api/auth/me', { headers: { Cookie: `levonis_session=${token}` } });
  assert.equal(res.status, 200);
  return ((await res.json()) as { user: Record<string, unknown> }).user;
}

test('1 — the real session loader on 0176: the owner’s and the full admin’s hints are right, no grants table needed', async () => {
  const raw = seedRoleMatrix(dbThrough('0176'));
  const owner = await meAs(raw, 'usr_owner');
  assert.equal(owner.is_owner, true);
  assert.equal(owner.can_view_cost, true);
  assert.equal(owner.can_write_cost, true);
  assert.equal(owner.can_move_money, true);
  const full = await meAs(raw, 'usr_full');
  assert.equal(full.can_move_money, true);
  assert.equal(full.can_view_cost, false);
  assert.equal(full.can_view_financials, false);
  const grantee = await meAs(raw, 'usr_grant');
  assert.equal(grantee.can_view_cost, false, 'no grants table, no grants — and delegation is off anyway');
});

test('2 — every GET answers on 0176 exactly as on the migrated database, for the owner and a full admin; the listed later-migration routes give exactly their refusal', async () => {
  assert.deepEqual(unknownMigrations(), [], 'every listed refusal names a real migration');
  assert.ok(DESIGNED_ON_OLDER_DB.length <= 4, 'the list is for routes that read ONLY a later migration, not a way to wave differences through');
  const paths = getPaths();
  const diffs: string[] = [];
  const fullLeaks: string[] = [];
  const reached = new Set<string>();
  for (const [name, user] of [['owner', OWNER], ['full', ROLES.full]] as const) {
    const ahead = appFor(seedRoleMatrix(freshDb()), user);
    const behind = appFor(seedRoleMatrix(dbThrough('0176')), user);
    for (const path of paths) {
      const a = await call(ahead, 'GET', path);
      const b = await call(behind, 'GET', path);
      diffs.push(...judge(name, path, '0176', a, b, reached));
      if (name === 'full' && b.status >= 200 && b.status < 300) {
        for (const l of leaks(b.body)) {
          if (!NOT_A_COST.some((x) => x.path.test(path) && x.leak.test(l))) fullLeaks.push(`${path}  ${l}`);
        }
      }
    }
  }
  assert.deepEqual(diffs, [], 'the Worker behaves differently on 0176 than designed');
  assert.deepEqual(unreached(['owner', 'full'], '0176', reached), [], 'a listed route the sweep never reached');
  assert.deepEqual(fullLeaks, [], 'a full admin sees no cost on 0176 either');
});

test('3a — the user PATCH promotion on 0176: the route itself writes assistant', async () => {
  const raw = seedRoleMatrix(dbThrough('0176'));
  const app = stubApp(asD1(raw), ROLES.full, (a) => a.route('/api/admin', adminRoutes));
  const res = await patch(app, '/api/admin/users/u1', { role: 'admin' });
  assert.equal(res.status, 200);
  assert.equal((await json(res)).admin_scope, 'assistant');
  assert.equal(row<{ admin_scope: string }>(raw, "SELECT admin_scope FROM users WHERE id = 'u1'")!.admin_scope, 'assistant');
});

test('3b — a withdrawal request on 0176 notifies the owner only', async () => {
  const raw = seedRoleMatrix(dbThrough('0176'));
  raw.exec(`
    INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                        subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd)
      VALUES ('o_rm','u1','delivered','{}','standard','{}','cash',50000,1500,55000,55000);
    INSERT INTO finance_order_costs (id,order_id,rule_id,rule_version,rule_name,group_key,staff_id,category_id,milestone,
                                     base_iqd,qty,amount_iqd,cost_day,state,snapshot)
      VALUES ('cost_rm','o_rm','rule_rm',1,'نسبة','prep','staff_rm','rm_wages','delivered',40000,1,10000,'2026-10-01','approved','{}');
  `);
  const app = stubApp(asD1(raw), ROLES.employee, (a) => a.route('/api/finance-earnings', financeEarningsRoutes));
  const res = await post(app, '/api/finance-earnings/withdrawals', { operation_id: 'deploy-ahead-wd', amount_iqd: 5000 });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = 'usr_owner'"), 1, 'the owner is told');
  assert.equal(
    count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE user_id IN ('usr_full','usr_legacy','usr_grant','usr_asst','usr_support')"),
    0,
    'no other admin is (decision 2: the notice links to an owner-only screen)'
  );
});
