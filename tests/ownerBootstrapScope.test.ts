/**
 * THE OWNER BOOTSTRAP KEEPS THE OWNER WHOLE — critique G-3, owner decision 2,
 * migration 0177, step S1.
 *
 * 0177's trigger `users_promotion_starts_assistant` fires on EVERY
 * non-admin → admin transition, and the owner's own bootstrap (the first
 * verified Google sign-in of INITIAL_ADMIN_EMAIL, worker/routes/auth.ts) is
 * one. Two defences, both proved here:
 *   1. the bootstrap writes the role and then `admin_scope = NULL` as two
 *      statements in one batch, so the row is left NULL;
 *   2. every predicate decides the owner by address before it reads a scope,
 *      so even an owner row the trigger DID leave at 'assistant' keeps every
 *      power: cost read and write, money, and the owner-only acts.
 *
 * Run: node --import tsx --test tests/ownerBootstrapScope.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, dbThrough, freshDb, get, json, patch, row, stubApp, type StubUser } from './fixtures/app';
import { seedCostlyProduct, seedCostlyStock, COST } from './fixtures/costlyProduct';
import { resolveGoogleIdentity } from '../worker/routes/auth';
import { publicUser, type Env, type SessionUser } from '../worker/lib/types';
import { adminRoutes } from '../worker/routes/admin';
import { adminPriceGridRoutes } from '../worker/routes/adminPriceGrid';
import { adminFinanceWorkspaceRoutes } from '../worker/routes/adminFinanceWorkspace';
import { adminFinanceRoutes } from '../worker/routes/adminFinance';
import { adminFinanceReportRoutes } from '../worker/routes/adminFinanceReport';
import { adminFinanceOperationsRoutes } from '../worker/routes/adminFinanceOperations';
import { adminFinancePeopleRoutes } from '../worker/routes/adminFinancePeople';
import { adminInvestmentFinanceRoutes } from '../worker/routes/adminInvestmentFinance';
import { adminProcurementRoutes } from '../worker/routes/adminProcurement';
import { adminInventoryRoutes } from '../worker/routes/adminInventory';
import { adminWalletAdjustRoutes } from '../worker/routes/adminWalletAdjust';

const OWNER_EMAIL = 'boss@x.co';
const identity = { sub: 'google-owner-sub', email: OWNER_EMAIL, name: 'Owner' };

async function bootstrap(raw: DatabaseSync): Promise<SessionUser> {
  const env = { DB: asD1(raw), INITIAL_ADMIN_EMAIL: OWNER_EMAIL } as unknown as Env;
  return resolveGoogleIdentity(env, identity);
}

const ownerApp = (raw: DatabaseSync, owner: SessionUser) =>
  stubApp(asD1(raw), owner as unknown as StubUser, (a) => {
    a.route('/api/admin/finance-workspace', adminFinanceWorkspaceRoutes);
    a.route('/api/admin/finance-operations', adminFinanceOperationsRoutes);
    a.route('/api/admin/finance-people', adminFinancePeopleRoutes);
    a.route('/api/admin/investment-finance', adminInvestmentFinanceRoutes);
    a.route('/api/admin/procurement', adminProcurementRoutes);
    a.route('/api/admin/inventory', adminInventoryRoutes);
    a.route('/api/admin/wallet-adjust', adminWalletAdjustRoutes);
    a.route('/api/admin', adminRoutes);
    a.route('/api/admin/products', adminPriceGridRoutes);
    a.route('/api/admin/finance', adminFinanceRoutes);
    a.route('/api/admin/finance/report', adminFinanceReportRoutes);
  });

/** Every owner power, over HTTP. */
async function assertWholeOwner(raw: DatabaseSync, owner: SessionUser) {
  const env = { INITIAL_ADMIN_EMAIL: OWNER_EMAIL } as unknown as Env;
  const hints = publicUser(owner, env);
  assert.equal(hints.is_owner, true);
  assert.equal(hints.can_view_cost, true);
  assert.equal(hints.can_write_cost, true);
  assert.equal(hints.can_move_money, true);
  assert.equal(hints.can_view_financials, true);

  const a = ownerApp(raw, owner);
  for (const path of [
    '/api/admin/finance-workspace/summary',
    '/api/admin/finance-operations/config',
    '/api/admin/finance-people/accounts',
    '/api/admin/investment-finance/profiles',
    '/api/admin/investment-finance/contracts',
    '/api/admin/procurement/config',
    '/api/admin/products/p_a1/price-history',
    '/api/admin/finance/expenses',
    '/api/admin/finance/report/summary',
    '/api/admin/wallet-adjust/rounding-drift',
  ]) {
    const res = await get(a, path);
    assert.equal(res.status, 200, `${path} → ${res.status} ${JSON.stringify(await res.clone().json().catch(() => null))}`);
  }
  // Cost reaches the owner in a mixed answer, too.
  const incoming = await json(await get(a, '/api/admin/inventory/incoming'));
  assert.equal((incoming.incoming as Array<Record<string, unknown>>)[0]!.exchange_rate_used, 203.7);
  const settings = await json(await get(a, '/api/admin/settings'));
  assert.ok('minMarginPercent' in settings.settings, 'the cost settings are read');
  const products = await json(await get(a, '/api/admin/products'));
  assert.equal((products.products as Array<Record<string, unknown>>)[0]!.product_cost_iqd, COST.product);

  // The owner-only acts.
  raw.exec("INSERT INTO users (id,name,email,password_hash,role,admin_scope) VALUES ('usr_aide','Aide','aide@x.co','h','admin','assistant')");
  const widen = await patch(a, '/api/admin/users/usr_aide', { admin_scope: 'full' });
  assert.equal(widen.status, 200, JSON.stringify(await widen.clone().json()));
  assert.equal(row<{ admin_scope: string }>(raw, "SELECT admin_scope FROM users WHERE id = 'usr_aide'")!.admin_scope, 'full');
  const investor = await patch(a, '/api/admin/users/usr_aide', { is_investor: true });
  assert.equal(investor.status, 200);
}

function shop(raw: DatabaseSync = freshDb()) {
  seedCostlyProduct(raw);
  seedCostlyStock(raw);
  return raw;
}

test('a fresh database: the first verified Google sign-in of INITIAL_ADMIN_EMAIL becomes the owner, scope NULL', async () => {
  const raw = shop();
  const owner = await bootstrap(raw);
  assert.equal(owner.role, 'admin');
  assert.equal(owner.admin_scope, null, 'the second statement of the batch leaves the owner row NULL');
  assert.ok(owner.email_verified_at, 'Google proved the address (critique A10)');
  const audit = row<{ n: number }>(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'auth.initial_admin_bootstrap'")!;
  assert.equal(audit.n, 1);
  await assertWholeOwner(raw, owner);
});

test("an owner row the trigger DID leave at 'assistant' keeps every owner power (predicates decide the owner first)", async () => {
  const raw = shop();
  // The bootstrap as a single statement — exactly what the trigger turns into 'assistant'.
  raw.exec(`INSERT INTO users (id,name,email,password_hash,role,email_verified_at)
            VALUES ('usr_owner','Owner','${OWNER_EMAIL}','h','customer','2026-01-01T00:00:00.000Z')`);
  raw.exec("UPDATE users SET role = 'admin' WHERE id = 'usr_owner'");
  const stored = row<SessionUser>(raw, "SELECT * FROM users WHERE id = 'usr_owner'")!;
  assert.equal(stored.admin_scope, 'assistant', 'the trigger stored assistant');
  await assertWholeOwner(raw, stored);
});

test('deploy ahead of 0177 (no trigger): the bootstrap still promotes, and the owner row is NULL', async () => {
  const raw = shop(dbThrough('0176'));
  const owner = await bootstrap(raw);
  assert.equal(owner.role, 'admin');
  assert.equal(owner.admin_scope, null);
});

test('once an admin exists the bootstrap promotes nobody, and a lookalike address is never the owner', async () => {
  const raw = shop();
  raw.exec("INSERT INTO users (id,name,email,password_hash,role,admin_scope) VALUES ('usr_first','First','first@x.co','h','admin',NULL)");
  const env = { DB: asD1(raw), INITIAL_ADMIN_EMAIL: OWNER_EMAIL } as unknown as Env;
  const late = await resolveGoogleIdentity(env, identity);
  assert.equal(late.role, 'customer', 'no second bootstrap while an admin exists');
  const other = await resolveGoogleIdentity(env, { sub: 'google-other', email: 'boss@x.co.evil.example', name: 'X' });
  assert.equal(other.role, 'customer');
  assert.equal(publicUser(other, env).is_owner, false);
});
