/**
 * FX-1's CODE ON A DATABASE WITHOUT 0179 (FX programme plan §15.2 "Deploy-ahead",
 * §16 rollback safety; CLAUDE.md rule 2).
 *
 * Workflow 7 applies 0179 before it deploys, but a manual redeploy or an
 * emergency path can run this code against a database at 0177. Then: the
 * owner's rates routes answer 503 PRICING_NOT_INSTALLED in three languages,
 * the scheduler is a no-op (no provider is called), `displayUsdRate` is null,
 * the P1 pricing workspace still answers from the purchase screens, and a
 * purchase confirmed 'ordered' still saves with no FX statement
 * (tests/procurementFxSnapshot.test.ts).
 *
 * Run: node --import tsx --test tests/fxDeployAhead.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OWNER, asD1, dbThrough, get, json, stubApp } from './fixtures/app';
import { OWNER_ROW_SQL, fakeProviders, fxEnv } from './fixtures/fx';
import { adminPricingRoutes } from '../worker/routes/adminPricing';
import { miscRoutes } from '../worker/routes/misc';
import { runFxScheduler } from '../worker/lib/fx/scheduler';
import { COST_REFUSALS } from '../packages/contracts/src/costRefusals';

test('deploy ahead of 0179: owner 503 PRICING_NOT_INSTALLED, scheduler no-op, displayUsdRate null, the P1 workspace still answers', async () => {
  const raw = dbThrough('0177');
  raw.exec(OWNER_ROW_SQL);
  const app = stubApp(asD1(raw), OWNER, (a) => {
    a.route('/api/admin/pricing', adminPricingRoutes);
    a.route('/api', miscRoutes);
  });
  const rates = await get(app, '/api/admin/pricing/rates');
  assert.equal(rates.status, 503);
  const body = await json(rates);
  assert.equal(body.code, 'PRICING_NOT_INSTALLED');
  assert.ok(COST_REFUSALS.PRICING_NOT_INSTALLED.ckb.length > 0, 'the client renders it in ar, en and ckb by code');
  assert.equal(rates.headers.get('cache-control'), 'private, no-store');
  const f = fakeProviders();
  const report = await runFxScheduler(fxEnv(raw), { now: new Date(), scheduledTime: new Date() }, { trigger: 'cron', fetchImpl: f.fetch });
  assert.equal(report.skipped, 'NOT_INSTALLED');
  assert.equal(f.calls.length, 0);
  const pub = await json(await get(app, '/api/settings/public'));
  assert.equal(pub.settings.displayUsdRate, null);
  const overview = await get(app, '/api/admin/pricing/overview');
  assert.equal(overview.status, 200, 'P1 reads the purchase screens when no central rate exists');
});
