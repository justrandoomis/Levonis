/**
 * WHO MAY CHANGE THE EXCHANGE-RATE SETTINGS (owner decisions 5, 10, 11 —
 * «editable by Main Admin»), ROLE BY ROLE, AUTOMATED.
 *
 * For every caller: `GET /api/admin/pricing/rates`, `PUT
 * /rates/fx/USD_IQD/settings {owner_version, market_adjustment_iqd: '20'}`
 * (decision 5) and `PUT … {owner_version, min_change_pct: '0.8'}` (decision
 * 10, a guard setting).
 *
 *   verified owner      200 — both need a fresh sign-in: on a stale session
 *                       each is 401 REAUTH_REQUIRED and writes nothing. The
 *                       band is a guard setting (§7.8); the adjustment moves
 *                       the effective USD rate and the public displayUsdRate
 *                       with no market guard in between (the WP-FX1A role
 *                       table; FX-1A review: security #1, correctness #2)
 *   unverified owner    403 OWNER_EMAIL_UNVERIFIED (canWriteCost)
 *   full admin, legacy NULL scope, assistant, the 'assisstant' typo
 *                       403 COST_ACCESS_DENIED
 *   customer, merchant  403 FORBIDDEN
 *   anonymous           401
 *
 * No refused call changes the pair, writes a log row or writes an audit row;
 * every answer is private, no-store. The route classes do not move
 * (tests/costRouteClassification.test.ts is unchanged).
 *
 * Run: node --import tsx --test tests/fxSettingsRoles.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { OWNER, asD1, count, freshDb, get, json, put, stubApp, type StubUser } from './fixtures/app';
import { OWNER_ROW_SQL, applyRate, pairOf } from './fixtures/fx';
import { adminPricingRoutes } from '../worker/routes/adminPricing';

const BASE = '/api/admin/pricing';
const STALE = 11 * 60;

interface Role {
  name: string;
  user: StubUser | null;
  status: number;
  code: string | null;
}

const ROLES: Role[] = [
  { name: 'unverified owner', user: { ...OWNER, email_verified_at: null }, status: 403, code: 'OWNER_EMAIL_UNVERIFIED' },
  { name: 'full admin', user: { id: 'f1', role: 'admin', email: 'f@x.co', admin_scope: 'full' }, status: 403, code: 'COST_ACCESS_DENIED' },
  { name: 'legacy NULL-scope admin', user: { id: 'n1', role: 'admin', email: 'n@x.co', admin_scope: null }, status: 403, code: 'COST_ACCESS_DENIED' },
  { name: 'assistant', user: { id: 'a1', role: 'admin', email: 'a@x.co', admin_scope: 'assistant' }, status: 403, code: 'COST_ACCESS_DENIED' },
  { name: "'assisstant' typo", user: { id: 't1', role: 'admin', email: 't@x.co', admin_scope: 'assisstant' }, status: 403, code: 'COST_ACCESS_DENIED' },
  { name: 'customer', user: { id: 'c1', role: 'customer', email: 'c@x.co' }, status: 403, code: 'FORBIDDEN' },
  { name: 'merchant', user: { id: 'm1', role: 'merchant', email: 'm@x.co' }, status: 403, code: 'FORBIDDEN' },
  { name: 'anonymous', user: null, status: 401, code: null },
];

function world(user: StubUser | null, sessionAgeSeconds = 0) {
  const raw = freshDb();
  raw.exec(OWNER_ROW_SQL);
  applyRate(raw, 'USD_IQD', '1660');
  const app = stubApp(asD1(raw), user, (a) => a.route(BASE, adminPricingRoutes), { sessionAgeSeconds });
  return { raw, app };
}

const snapshot = (raw: DatabaseSync) => ({
  pair: JSON.stringify(pairOf(raw, 'USD_IQD')),
  logs: count(raw, 'SELECT COUNT(*) n FROM fx_rate_log'),
  audits: count(raw, 'SELECT COUNT(*) n FROM audit_log'),
});

const BODIES = (raw: DatabaseSync) => [
  { owner_version: Number(pairOf(raw, 'USD_IQD').owner_version), market_adjustment_iqd: '20' },
  { owner_version: Number(pairOf(raw, 'USD_IQD').owner_version), min_change_pct: '0.8' },
];

for (const role of ROLES) {
  test(`${role.name}: GET /rates and both settings writes → ${role.status}${role.code ? ` ${role.code}` : ''}; nothing changes, nothing is logged or audited`, async () => {
    const { raw, app } = world(role.user);
    const before = snapshot(raw);
    const answers = [await get(app, `${BASE}/rates`), ...(await Promise.all(BODIES(raw).map((b) => put(app, `${BASE}/rates/fx/USD_IQD/settings`, b))))];
    for (const res of answers) {
      assert.equal(res.status, role.status, role.name);
      assert.equal(res.headers.get('cache-control'), 'private, no-store');
      const b = await json(res);
      if (role.code) assert.equal(b.code, role.code, role.name);
      assert.doesNotMatch(JSON.stringify(b), /1660|market_adjustment_iqd|min_change_pct/, `${role.name}: the refusal names no figure and no field`);
    }
    assert.deepEqual(snapshot(raw), before, `${role.name}: the pair, the log and the audit are untouched`);
  });
}

test('verified owner: both writes answer 200 and land — the adjustment as fixed dinars, the band with its old → new', async () => {
  const { raw, app } = world(OWNER);
  assert.equal((await get(app, `${BASE}/rates`)).status, 200);
  const [adj, band] = BODIES(raw);
  assert.equal((await put(app, `${BASE}/rates/fx/USD_IQD/settings`, adj)).status, 200);
  assert.equal(pairOf(raw, 'USD_IQD').market_adjustment_iqd, '20');
  assert.equal(pairOf(raw, 'USD_IQD').effective_rate, '1680');
  const res = await put(app, `${BASE}/rates/fx/USD_IQD/settings`, { ...band, owner_version: Number(pairOf(raw, 'USD_IQD').owner_version) });
  assert.equal(res.status, 200);
  assert.equal(pairOf(raw, 'USD_IQD').min_change_pct, '0.8');
  assert.equal(count(raw, "SELECT COUNT(*) n FROM audit_log WHERE action = 'fx.settings.update'"), 2);
});

test('verified owner on a stale session: the band AND the adjustment → 401 REAUTH_REQUIRED; nothing changes, nothing is logged or audited, the public rate does not move', async () => {
  const { raw, app } = world(OWNER, STALE);
  const before = snapshot(raw);
  const [adj, band] = BODIES(raw);
  for (const [body, what] of [
    [band, 'the band'],
    [adj, 'the adjustment'],
  ] as const) {
    const refused = await put(app, `${BASE}/rates/fx/USD_IQD/settings`, body);
    assert.equal(refused.status, 401, what);
    assert.equal(refused.headers.get('cache-control'), 'private, no-store');
    assert.equal((await json(refused)).code, 'REAUTH_REQUIRED', what);
    assert.deepEqual(snapshot(raw), before, `${what}: a refused change writes nothing`);
  }
  assert.equal(pairOf(raw, 'USD_IQD').effective_rate, '1660', 'the effective (and public) rate stays');
  assert.equal(count(raw, "SELECT COUNT(*) n FROM user_notifications WHERE kind = 'fx_attention'"), 0, 'no bell');
});
