/**
 * THE LIVE COST-PRIVACY PROBES — master plan §4.0 "Live verification", S1
 * "Live verification", critiques A9, A10, G-36. Step S1.
 *
 * Workflow 7 runs scripts/live-cost-probes.mjs after every deploy (anonymous
 * GETs only) and, before anything is migrated, refuses an empty
 * INITIAL_ADMIN_EMAIL. It no longer reads the users table at all (DECISIONS
 * row 185 amendment, 2026-10-08): an owner whose address is not verified yet
 * is told so by the site (OWNER_EMAIL_UNVERIFIED) and verifies from the admin
 * screens. A probe that cannot fail is worse than none, so the verdicts are
 * pinned here on fixed bodies, every probe file is held to its shape, and the
 * workflow is held to the order of its steps.
 *
 * Run: node --import tsx --test tests/liveCostProbes.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { sourceOf } from './fixtures/source';
import { APEX, asD1, ctx, freshDb } from './fixtures/app';
import { seedCostlyProduct } from './fixtures/costlyProduct';
import { LIVE_PRODUCTS, seedLiveCatalog } from './fixtures/liveCatalog';
import { FX_PUBLIC_RATE, FX_SENTINELS, seedFxSentinels } from './fixtures/fxSentinels';
import worker from '../worker/index';
// @ts-expect-error - plain ESM script shared with workflow 7, no types
import * as probesScript from '../scripts/live-cost-probes.mjs';
const { fillPath, judge, loadProbeFiles, pick, walkKeys } = probesScript;

interface Probe {
  path: string;
  status?: number[];
  forbidKeys?: string;
  forbidPattern?: string;
  requireIntegerKeys?: string[];
  valuePatterns?: Record<string, string>;
}
const files = loadProbeFiles(join(ROOT, 'scripts/live-cost-probes.d')) as Array<{ file: string; spec: { probes: Probe[]; vars?: Record<string, { from: string; pick: string }> } }>;
const s1 = files.find((f) => f.file === 's1.json')!;
const probe = (path: string) => s1.spec.probes.find((p) => p.path === path);

// ------------------------------------------------------------- the verdicts

test('judge: a wrong status, a forbidden key at any depth, a forbidden pattern and a missing or non-integer price each fail', () => {
  const p: Probe = { path: '/x', status: [200], forbidKeys: 'cost|fx', forbidPattern: 'MANUAL_OVERRIDE', requireIntegerKeys: ['price_iqd'] };
  assert.deepEqual(judge(p, 200, JSON.stringify({ products: [{ price_iqd: 900000, name: 'A1' }] })), []);
  assert.match(judge(p, 500, JSON.stringify({ products: [{ price_iqd: 1 }] })).join('\n'), /status 500/);
  assert.match(judge(p, 200, JSON.stringify({ products: [{ price_iqd: 1, options: [{ cost_iqd: 2 }] }] })).join('\n'), /forbidden key cost_iqd/);
  assert.match(judge(p, 200, JSON.stringify({ products: [{ price_iqd: 1, fxRate: '1310' }] })).join('\n'), /forbidden key fxRate/);
  assert.match(judge(p, 200, JSON.stringify({ products: [{ price_iqd: 1, note: 'MANUAL_OVERRIDE' }] })).join('\n'), /forbidden pattern/);
  assert.match(judge(p, 200, JSON.stringify({ products: [] })).join('\n'), /required key price_iqd is absent/, 'an empty answer is not a pass (G-36)');
  assert.match(judge(p, 200, JSON.stringify({ products: [{ price_iqd: '900000' }] })).join('\n'), /not integers/);
  assert.deepEqual(judge({ path: '/a', status: [401] }, 401, '{"success":false}'), []);
});

test('the owner-row mode is gone: the script exports no owner verdict and never reads a users row', () => {
  assert.equal('ownerRowVerdict' in probesScript, false);
  const src = sourceOf('scripts/live-cost-probes.mjs');
  assert.doesNotMatch(src, /--owner-row/);
  assert.doesNotMatch(src, /\bFROM users\b/i);
});

test('pick and fillPath: a slug is read from a live answer; an unresolved variable refuses the probe', () => {
  assert.equal(pick({ products: [{ slug: 'a1' }] }, 'products.0.slug'), 'a1');
  assert.equal(pick({}, 'products.0.slug'), undefined);
  assert.equal(fillPath('/api/products/{slug}', { slug: 'a 1' }), '/api/products/a%201');
  assert.throws(() => fillPath('/api/products/{slug}', {}), /has no value/);
});

// ------------------------------------------------------------- the files

test('every probe file has the shape the script reads, and every regex compiles', () => {
  assert.ok(files.length >= 1);
  for (const { file, spec } of files) {
    assert.ok(Array.isArray(spec.probes) && spec.probes.length > 0, `${file}: probes`);
    for (const p of spec.probes) {
      assert.match(p.path, /^\//, `${file}: ${p.path}`);
      assert.ok(Array.isArray(p.status) && p.status.every((s) => Number.isInteger(s)), `${file}: ${p.path} status`);
      if (p.forbidKeys) assert.doesNotThrow(() => new RegExp(p.forbidKeys!, 'i'));
      if (p.forbidPattern) assert.doesNotThrow(() => new RegExp(p.forbidPattern!, 'i'));
    }
  }
});

test('s1.json: the cost routers refuse a stranger; the storefront answers carry integer prices and no private key', () => {
  for (const path of ['/api/admin/finance-workspace/summary', '/api/admin/products/x/price-history']) {
    assert.deepEqual(probe(path)?.status, [401], path);
  }
  const products = probe('/api/products?limit=3')!;
  assert.deepEqual(products.status, [200]);
  assert.deepEqual(products.requireIntegerKeys, ['price_iqd']);
  const keys = new RegExp(products.forbidKeys!, 'i');
  // Critique A9: the narrow regex missed these.
  for (const k of ['cost_iqd', 'supplier_cost', 'replacement_cost_iqd', 'target_profit_iqd', 'margin_iqd', 'premium_rule_id', 'extra_rule_id', 'extra_rule_version', 'fx_rate', 'exchange_rate_used', 'shipping_rate', 'shipping_weight_g', 'shipping_cbm', 'rate_iqd', 'manual_cbm', 'effective_cbm', 'pricing_weight_g', 'pricing_revision', 'pricing_mode']) {
    assert.ok(keys.test(k), `the probe would miss ${k}`);
  }
  // …and must not trip on the public sale modes of a product page.
  assert.equal(keys.test('pricing_modes'), false);
  assert.equal(keys.test('price_iqd'), false);
  // A product page and the public API are probed too, by a live slug.
  assert.ok(probe('/api/products/{slug}') && probe('/api/public/v1/products/{slug}'));
  assert.equal(s1.spec.vars?.slug?.from, '/api/products?limit=1');
});

// ------------------------------------------------------------- the membership rule a page shows (S1 review D2)
//
// A bare `rule_id` was forbidden on every storefront probe. The product page
// answers `membership_preview.pro.rule_id` — the id of the PRO/PRIME discount
// rule the customer is shown (membershipBenefits.ts), not a cost — so the day
// the owner resumes PRO, workflow 7 would turn red AFTER deploying, on a page
// that leaks nothing. The cost-rule ids are forbidden by name instead.

const STOREFRONT = ['/api/products?limit=3', '/api/products/{slug}', '/api/public/v1/products/{slug}', '/api/home'];

test('s1.json: a membership rule id passes every storefront probe; target_rule_id, extra_rule_id and its old name premium_rule_id still fail', () => {
  for (const path of STOREFRONT) {
    const keys = new RegExp(probe(path)!.forbidKeys!, 'i');
    assert.equal(keys.test('rule_id'), false, `${path}: membership_preview.pro.rule_id is not a cost`);
    for (const k of ['target_rule_id', 'extra_rule_id', 'premium_rule_id']) assert.ok(keys.test(k), `${path}: the probe would miss ${k}`);
  }
  const page = probe('/api/products/{slug}')!;
  const shown = { product: { slug: 'a1', price_iqd: 900000, membership_preview: { pro: { rule_id: 'mbr_rule_pro', price_iqd: 850000 }, prime: { rule_id: 'mbr_rule_prime', price_iqd: 880000 } } } };
  assert.deepEqual(judge(page, 200, JSON.stringify(shown)), []);
  for (const k of ['target_rule_id', 'extra_rule_id', 'premium_rule_id']) {
    const leak = { product: { slug: 'a1', price_iqd: 900000, pricing: { [k]: 'tr_1' } } };
    assert.match(judge(page, 200, JSON.stringify(leak)).join('\n'), new RegExp(`forbidden key ${k} \\(at product\\.pricing\\.${k}\\)`));
  }
});

/** Every s1.json probe, judged against the local Worker on the live catalogue — the run workflow 7 makes, before it deploys. */
async function probeLocally(proResumed: boolean) {
  const raw = freshDb();
  raw.exec('PRAGMA foreign_keys = OFF;');
  seedCostlyProduct(raw);
  seedLiveCatalog(raw);
  if (proResumed) raw.exec(`UPDATE admin_settings SET value = '{"paused":false,"since":null}' WHERE key = 'proPause'`);
  const env = { DB: asD1(raw), STORE_ROOT_DOMAIN: APEX, APP_ORIGIN: `https://${APEX}`, INITIAL_ADMIN_EMAIL: 'boss@x.co', EXTRA_ALLOWED_ORIGINS: '', ASSETS: { fetch: async () => new Response('spa') } };
  const get = async (path: string) => {
    const res = await worker.fetch(new Request(`https://${APEX}${path}`, { headers: { Host: APEX, accept: 'application/json', 'CF-Connecting-IP': '9.9.9.9' } }), env as never, ctx);
    return { status: res.status, text: await res.text() };
  };
  const vars: Record<string, string> = {};
  for (const [name, def] of Object.entries(s1.spec.vars ?? {})) vars[name] = pick(JSON.parse((await get(def.from)).text), def.pick);
  const failures: string[] = [];
  for (const p of s1.spec.probes) {
    const path = fillPath(p.path, vars);
    const { status, text } = await get(path);
    failures.push(...(judge(p, status, text) as string[]).map((f) => `${path}: ${f}`));
  }
  // Every live product page, not only the first slug.
  const page = probe('/api/products/{slug}')!;
  let membershipRuleIds = 0;
  for (const product of LIVE_PRODUCTS) {
    const { status, text } = await get(`/api/products/${product.slug}`);
    failures.push(...(judge(page, status, text) as string[]).map((f) => `/api/products/${product.slug}: ${f}`));
    if (status === 200) for (const { path } of walkKeys(JSON.parse(text)) as Iterable<{ path: string }>) if (/membership_preview\.pro\.rule_id$/.test(path)) membershipRuleIds++;
  }
  return { failures, membershipRuleIds };
}

test('s1.json against the local Worker, PRO paused as migrated: every probe passes', async () => {
  const { failures } = await probeLocally(false);
  assert.deepEqual(failures, []);
});

test('s1.json against the local Worker with PRO resumed: the product pages carry membership_preview.pro.rule_id and every probe still passes', async () => {
  const { failures, membershipRuleIds } = await probeLocally(true);
  assert.ok(membershipRuleIds > 0, 'not vacuous: the resumed pages do show the PRO rule id');
  assert.deepEqual(failures, []);
});

// ------------------------------------------------------------- pricing.json (MVP P1)

test('pricing.json (MVP P1): the owner’s pricing workspace refuses a stranger — the probes, and the local Worker answering them', async () => {
  const pricing = files.find((f) => f.file === 'pricing.json');
  assert.ok(pricing, 'scripts/live-cost-probes.d/pricing.json exists');
  const paths = pricing!.spec.probes.map((p) => p.path);
  assert.ok(paths.includes('/api/admin/pricing/overview'));
  for (const p of pricing!.spec.probes) assert.deepEqual(p.status, [401], p.path);
  const raw = freshDb();
  seedCostlyProduct(raw);
  const env = { DB: asD1(raw), STORE_ROOT_DOMAIN: APEX, APP_ORIGIN: `https://${APEX}`, INITIAL_ADMIN_EMAIL: 'boss@x.co', EXTRA_ALLOWED_ORIGINS: '', ASSETS: { fetch: async () => new Response('spa') } };
  for (const p of pricing!.spec.probes) {
    const res = await worker.fetch(new Request(`https://${APEX}${p.path}`, { headers: { Host: APEX, accept: 'application/json', 'CF-Connecting-IP': '9.9.9.9' } }), env as never, ctx);
    assert.deepEqual(judge(p, res.status, await res.text()), [], p.path);
  }
});

// ------------------------------------------------------------- fx.json (FX-1)

test('judge: valuePatterns — text matching the pattern or null passes, an absent key passes, a number, an object or other text fails, and the failure never carries the value', () => {
  const p: Probe = { path: '/x', status: [200], valuePatterns: { displayUsdRate: '^[0-9]{1,6}(\\.[0-9]{1,8})?$' } };
  assert.deepEqual(judge(p, 200, JSON.stringify({ settings: { displayUsdRate: '1703.9167' } })), []);
  assert.deepEqual(judge(p, 200, JSON.stringify({ settings: { displayUsdRate: null } })), []);
  assert.deepEqual(judge(p, 200, JSON.stringify({ settings: {} })), []);
  const asNumber = judge(p, 200, JSON.stringify({ settings: { displayUsdRate: 1703.9167 } })).join('\n');
  assert.match(asNumber, /displayUsdRate \(at settings\.displayUsdRate\) is a number/);
  assert.doesNotMatch(asNumber, /1703/, 'a failure line never carries the value');
  assert.match(judge(p, 200, JSON.stringify({ settings: { displayUsdRate: { market: '1666' } } })).join('\n'), /is a object/);
  const text = judge(p, 200, JSON.stringify({ settings: { displayUsdRate: '1,703.91' } })).join('\n');
  assert.match(text, /does not match/);
  assert.doesNotMatch(text, /1,703/);
});

test('fx.json (FX-1): the public settings and the home carry only the effective USD/IQD; the rates routes refuse a stranger — against the local Worker, with and without a rate', async () => {
  const fx = files.find((f) => f.file === 'fx.json');
  assert.ok(fx, 'scripts/live-cost-probes.d/fx.json exists');
  const paths = fx!.spec.probes.map((p) => p.path);
  for (const path of ['/api/settings/public', '/api/home', '/api/admin/pricing/rates', '/api/admin/pricing/rates/history']) assert.ok(paths.includes(path), path);
  for (const p of fx!.spec.probes.filter((x) => x.path.startsWith('/api/admin/'))) assert.deepEqual(p.status, [401], p.path);
  const pub = fx!.spec.probes.find((p) => p.path === '/api/settings/public')!;
  assert.ok(pub.valuePatterns?.displayUsdRate, 'the public figure is held to decimal text or null');
  // The regex catches every private FX name of the 0179 tables and the rates DTO…
  const keys = new RegExp(pub.forbidKeys!, 'i');
  for (const k of ['market_rate', 'market_buy', 'adjustment_iqd_per_usd', 'provider', 'pending_effective_rate', 'last_known_good_rate', 'anomaly_threshold_pct', 'drift_anchor_rate', 'bound_min', 'rejected_rate', 'official_rate', 'effective_rate', 'effective_rates_iqd', 'manual_rate', 'cross_rate', 'usd_iqd_rate', 'source_usd_per_eur', 'fx_usd_iqd_at_purchase', 'rate_iqd', 'supplier_cost_amount', 'current_supplier_cost_iqd']) {
    assert.ok(keys.test(k), `the probe would miss ${k}`);
  }
  // …and not the public ones.
  for (const k of ['displayUsdRate', 'exchangeRate', 'currency', 'price_iqd', 'margin_percent', 'setup_fee_iqd']) assert.equal(keys.test(k), false, k);

  for (const withRate of [false, true]) {
    const raw = freshDb();
    raw.exec('PRAGMA foreign_keys = OFF;');
    seedLiveCatalog(raw);
    if (withRate) seedFxSentinels(raw);
    const env = { DB: asD1(raw), STORE_ROOT_DOMAIN: APEX, APP_ORIGIN: `https://${APEX}`, INITIAL_ADMIN_EMAIL: 'boss@x.co', EXTRA_ALLOWED_ORIGINS: '', ASSETS: { fetch: async () => new Response('spa') } };
    for (const p of fx!.spec.probes) {
      const res = await worker.fetch(new Request(`https://${APEX}${p.path}`, { headers: { Host: APEX, accept: 'application/json', 'CF-Connecting-IP': '9.9.9.9' } }), env as never, ctx);
      const text = await res.text();
      assert.deepEqual(judge(p, res.status, text), [], `${p.path} (${withRate ? 'a rate' : 'no rate'})`);
      if (p.path === '/api/settings/public' || p.path === '/api/home') {
        // Not vacuous: the figure is there — the effective rate, or null before the first approval.
        assert.equal(JSON.parse(text).settings.displayUsdRate, withRate ? FX_PUBLIC_RATE : null, p.path);
        for (const v of FX_SENTINELS) assert.equal(text.includes(v), false, `${p.path} carries the private figure ${v}`);
      }
    }
  }
});

// ------------------------------------------------------------- the workflow

test('workflow 7: an empty INITIAL_ADMIN_EMAIL is still refused, no step reads the users table, the probes run after the live verify', () => {
  const yml = sourceOf('.github/workflows/deploy-staging-code.yml');
  // The vars check stays: it reads the worker vars workflow 7 already reads.
  const refuse = yml.indexOf('$1 == "INITIAL_ADMIN_EMAIL" && $2 != ""');
  const migrate = yml.indexOf('- name: Apply any pending migrations BEFORE the code that needs them');
  assert.ok(refuse > 0, 'the vars step refuses an empty owner address');
  assert.ok(migrate > 0 && refuse < migrate, 'and it does so before anything is migrated');
  // DECISIONS row 185 amendment: the deploy never reads users.
  assert.doesNotMatch(yml, /The owner account exists and is verified/);
  assert.doesNotMatch(yml, /--owner-row/);
  const commands = [...yml.matchAll(/--command "([^"]+)"/g)].map((m) => m[1]!);
  assert.ok(commands.length > 0, 'the read-only checks are still found');
  for (const sql of commands) assert.doesNotMatch(sql, /\busers\b/i, `a deploy step reads users: ${sql.slice(0, 80)}`);
  assert.doesNotMatch(yml.replace(/^\s*#.*$/gm, ''), /\bFROM users\b/i, 'no uncommented line of workflow 7 selects from users');
  // The anonymous cost-privacy probes stay, after the live verification.
  const verify = yml.indexOf('- name: Verify the live site, read-only');
  const probes = yml.indexOf('- name: Cost-privacy probes, read-only');
  assert.ok(verify > 0 && probes > verify, 'the probes run after the live verification');
  assert.match(yml.slice(probes, probes + 300), /run: node scripts\/live-cost-probes\.mjs --base https:\/\/levonis-iq\.com/);
});
