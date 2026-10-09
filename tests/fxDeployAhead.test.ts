/**
 * FX-1's CODE ON A DATABASE WITHOUT 0179 (FX programme plan §15.2 "Deploy-ahead",
 * §16 rollback safety; CLAUDE.md rule 2).
 *
 * Workflow 7 applies 0179 before it deploys, but a manual redeploy or an
 * emergency path can run this code against the database one migration behind:
 * 0178, the serial scan's. Then: the owner's rates routes answer 503
 * PRICING_NOT_INSTALLED in three languages, the scheduler is a no-op (no
 * provider is called), `displayUsdRate` is null, the P1 pricing workspace
 * still answers from the purchase screens, a purchase confirmed 'ordered'
 * still saves with no FX statement (tests/procurementFxSnapshot.test.ts), and
 * every other GET answers exactly as it does on the migrated database.
 *
 * Run: node --import tsx --test tests/fxDeployAhead.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { OWNER, asD1, count, dbThrough, freshDb, get, json, stubApp } from './fixtures/app';
import { OWNER_ROW_SQL, fakeProviders, fxEnv } from './fixtures/fx';
import { ROLES, appFor, call, getPaths, seedRoleMatrix } from './fixtures/roleMatrix';
import { judge, unreached } from './fixtures/deployAhead';
import { adminPricingRoutes } from '../worker/routes/adminPricing';
import { miscRoutes } from '../worker/routes/misc';
import { runFxScheduler } from '../worker/lib/fx/scheduler';
import { COST_REFUSALS } from '../packages/contracts/src/costRefusals';

const has = (raw: DatabaseSync, name: string) => count(raw, 'SELECT COUNT(*) AS n FROM sqlite_master WHERE name = ?', name) > 0;

test('the fixture really is one migration behind: 0178 is in, 0179 is not', () => {
  const behind = dbThrough('0178');
  const ahead = freshDb();
  assert.equal(has(behind, 'serial_assignments'), true, '0178_serial_assignments.sql is applied');
  for (const table of ['fx_rate_pairs', 'fx_rate_log', 'pricing_fx_rates', 'pricing_shipping_rates']) {
    assert.equal(has(behind, table), false, `${table} belongs to 0179`);
    assert.equal(has(ahead, table), true, `${table} exists once 0179 runs`);
  }
});

test('deploy ahead of 0179 (database at 0178): owner 503 PRICING_NOT_INSTALLED, scheduler no-op, displayUsdRate null, the P1 workspace still answers', async () => {
  const raw = dbThrough('0178');
  raw.exec(OWNER_ROW_SQL);
  const app = stubApp(asD1(raw), OWNER, (a) => {
    a.route('/api/admin/pricing', adminPricingRoutes);
    a.route('/api', miscRoutes);
  });
  for (const path of ['/api/admin/pricing/rates', '/api/admin/pricing/rates/history', '/api/admin/pricing/rates/history?pair=USD_IQD']) {
    const res = await get(app, path);
    assert.equal(res.status, 503, path);
    assert.equal((await json(res)).code, 'PRICING_NOT_INSTALLED', path);
    assert.equal(res.headers.get('cache-control'), 'private, no-store', path);
  }
  const sentence = COST_REFUSALS.PRICING_NOT_INSTALLED;
  assert.ok(sentence.ar.length > 0 && sentence.en.length > 0 && sentence.ckb.length > 0, 'the client renders it in ar, en and ckb by code');
  assert.notEqual(sentence.ckb, sentence.ar, 'the Sorani is Sorani, not a copy of the Arabic');
  const f = fakeProviders();
  const report = await runFxScheduler(fxEnv(raw), { now: new Date(), scheduledTime: new Date() }, { trigger: 'cron', fetchImpl: f.fetch });
  assert.equal(report.skipped, 'NOT_INSTALLED');
  assert.equal(f.calls.length, 0, 'no provider is called');
  const pub = await json(await get(app, '/api/settings/public'));
  assert.equal(pub.settings.displayUsdRate, null);
  const overview = await get(app, '/api/admin/pricing/overview');
  assert.equal(overview.status, 200, 'P1 reads the purchase screens when no central rate exists');
});

test('every GET answers on 0178 exactly as on the migrated database, for the owner and a full admin, except the listed FX routes, which give exactly their refusal', async () => {
  const paths = getPaths();
  const diffs: string[] = [];
  const reached = new Set<string>();
  for (const [name, user] of [['owner', OWNER], ['full', ROLES.full]] as const) {
    const ahead = appFor(seedRoleMatrix(freshDb()), user);
    const behind = appFor(seedRoleMatrix(dbThrough('0178')), user);
    for (const path of paths) diffs.push(...judge(name, path, '0178', await call(ahead, 'GET', path), await call(behind, 'GET', path), reached));
  }
  assert.deepEqual(diffs, [], 'FX-1 behaves differently on 0178 than designed');
  assert.deepEqual(unreached(['owner', 'full'], '0178', reached), [], 'a listed FX route the sweep never reached');
  assert.ok(reached.has('owner /api/admin/pricing/rates') && reached.has('owner /api/admin/pricing/rates/history'));
});
