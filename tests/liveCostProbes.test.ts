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
import { FX_DISPLAY_RATE, FX_SENTINELS, seedFxSentinels } from './fixtures/fxSentinels';
import worker from '../worker/index';
// @ts-expect-error - plain ESM script shared with workflow 7, no types
import * as probesScript from '../scripts/live-cost-probes.mjs';
import { fetchPublished } from './fixtures/autoPublish';
const { cliVars, fillPath, judge, loadProbeFiles, pick, planProbe, readVar, runProbes, walkKeys } = probesScript;

interface Probe {
  path: string;
  status?: number[];
  forbidKeys?: string;
  forbidPattern?: string;
  requireIntegerKeys?: string[];
  requireWhenVar?: string;
  integerKeys?: string[];
  valuePatterns?: Record<string, string>;
  forbidValues?: Record<string, string>;
}
const files = loadProbeFiles(join(ROOT, 'scripts/live-cost-probes.d')) as Array<{
  file: string;
  spec: { probes: Probe[]; vars?: Record<string, { from?: string; pick?: string; optional?: boolean }> };
}>;
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
      if (p.requireWhenVar !== undefined) {
        // It relaxes a presence rule, so it must name a var this file reads by GET and may find empty.
        const def = spec.vars?.[p.requireWhenVar];
        assert.ok(def?.optional === true && typeof def.from === 'string' && typeof def.pick === 'string', `${file}: ${p.path} requireWhenVar names an optional var read by GET`);
        assert.ok((p.requireIntegerKeys ?? []).length > 0, `${file}: ${p.path} requireWhenVar without requireIntegerKeys`);
      }
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
  assert.equal(products.requireWhenVar, 'slug', 'the listing needs its prices only while something is listed (the clean start)');
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
  if (proResumed) {
    raw.exec(`UPDATE admin_settings SET value = '{"paused":false,"since":null}' WHERE key = 'proPause'`);
    // Since the clean start a member price is a benefit rule, never a typed rung (DECISIONS row 222): one
    // catalogue-wide PRO rule, so the resumed pages carry its id.
    raw.exec(`INSERT INTO membership_benefit_rules (id, tier, benefit_type, scope, product_id, discount_mode, percent, fixed_iqd, enabled, priority, label)
      VALUES ('mbr_rule_pro_probe', 'pro', 'product_discount', 'global', NULL, 'percent', 5, NULL, 1, 0, 'PRO probe')`);
  }
  const env = { DB: asD1(raw), STORE_ROOT_DOMAIN: APEX, APP_ORIGIN: `https://${APEX}`, INITIAL_ADMIN_EMAIL: 'boss@x.co', EXTRA_ALLOWED_ORIGINS: '', ASSETS: { fetch: async () => new Response('spa') } };
  const get = async (path: string) => {
    const res = await fetchPublished(worker, new Request(`https://${APEX}${path}`, { headers: { Host: APEX, accept: 'application/json', 'CF-Connecting-IP': '9.9.9.9' } }), env as never, ctx);
    return { status: res.status, text: await res.text() };
  };
  const vars: Record<string, string> = {};
  for (const [name, def] of Object.entries(s1.spec.vars ?? {})) vars[name] = pick(JSON.parse((await get(def.from!)).text), def.pick!);
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
    const res = await fetchPublished(worker, new Request(`https://${APEX}${p.path}`, { headers: { Host: APEX, accept: 'application/json', 'CF-Connecting-IP': '9.9.9.9' } }), env as never, ctx);
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
  for (const k of ['margin_percent', 'setup_fee_iqd', 'machine_iqd_per_hour', 'market_rate', 'market_buy', 'adjustment_iqd_per_usd', 'market_adjustment_iqd', 'settings_diff', 'provider', 'pending_effective_rate', 'last_known_good_rate', 'anomaly_threshold_pct', 'drift_anchor_rate', 'bound_min', 'rejected_rate', 'official_rate', 'effective_rate', 'effective_rates_iqd', 'manual_rate', 'cross_rate', 'usd_iqd_rate', 'source_usd_per_eur', 'fx_usd_iqd_at_purchase', 'rate_iqd', 'supplier_cost_amount', 'current_supplier_cost_iqd']) {
    assert.ok(keys.test(k), `the probe would miss ${k}`);
  }
  // …and not the public ones.
  // (The print-service rates left the public settings with DECISIONS row 220: forbidden above.)
  for (const k of ['displayUsdRate', 'exchangeRate', 'currency', 'price_iqd']) assert.equal(keys.test(k), false, k);

  for (const withRate of [false, true]) {
    const raw = freshDb();
    raw.exec('PRAGMA foreign_keys = OFF;');
    seedLiveCatalog(raw);
    if (withRate) seedFxSentinels(raw);
    const env = { DB: asD1(raw), STORE_ROOT_DOMAIN: APEX, APP_ORIGIN: `https://${APEX}`, INITIAL_ADMIN_EMAIL: 'boss@x.co', EXTRA_ALLOWED_ORIGINS: '', ASSETS: { fetch: async () => new Response('spa') } };
    for (const p of fx!.spec.probes) {
      // Without a rate nothing is published (a fixture publish would approve its own rate): no product shows.
      const request = new Request(`https://${APEX}${p.path}`, { headers: { Host: APEX, accept: 'application/json', 'CF-Connecting-IP': '9.9.9.9' } });
      const res = withRate ? await fetchPublished(worker, request, env as never, ctx) : await worker.fetch(request, env as never, ctx);
      const text = await res.text();
      assert.deepEqual(judge(p, res.status, text), [], `${p.path} (${withRate ? 'a rate' : 'no rate'})`);
      if (p.path === '/api/settings/public' || p.path === '/api/home') {
        // Not vacuous: the figure is there — the market base to the dinar (DECISIONS row 220), or null before the first approval.
        assert.equal(JSON.parse(text).settings.displayUsdRate, withRate ? FX_DISPLAY_RATE : null, p.path);
        for (const v of FX_SENTINELS) assert.equal(text.includes(v), false, `${p.path} carries the private figure ${v}`);
      }
    }
  }
});

// ------------------------------------------------------------- leaks.json (the 2026-10-10 leak audit, DECISIONS row 220)

const SUPPLIER_LINK = 'https://supplier-secret.example/listing/original.jpg';

test('leaks.json: each probe flags the value the audit found leaking, and passes the public shape', () => {
  const leaksFile = files.find((f) => f.file === 'leaks.json');
  assert.ok(leaksFile, 'scripts/live-cost-probes.d/leaks.json exists');
  const at = (path: string) => leaksFile!.spec.probes.find((p) => p.path === path)!;
  for (const path of ['/api/print-quote/accessories', '/api/marketplace/print/catalog', '/api/print-quote/printers', '/api/products/print-calculator', '/api/settings/public', '/api/home', '/api/products/{slug}', '/api/public/v1/products/{slug}']) {
    assert.ok(at(path), `leaks.json probes ${path}`);
    assert.deepEqual(at(path).status, [200], path);
  }
  const acc = at('/api/print-quote/accessories');
  assert.deepEqual(judge(acc, 200, JSON.stringify({ accessories: [{ id: 'magnet-6x3', name_en: 'Magnet', unit: 'piece', category: 'magnet' }] })), []);
  assert.match(judge(acc, 200, JSON.stringify({ accessories: [{ id: 'magnet-6x3', cost_iqd: 250 }] })).join('\n'), /forbidden key cost_iqd/);
  const cat = at('/api/marketplace/print/catalog');
  assert.deepEqual(judge(cat, 200, JSON.stringify({ min_job_iqd: 5000, accessories: [{ id: 'a', unit: 'piece' }] })), [], 'the published minimum job stays');
  assert.match(judge(cat, 200, JSON.stringify({ accessories: [{ id: 'a', cost_iqd: 250 }] })).join('\n'), /forbidden key cost_iqd/);
  const printers = at('/api/print-quote/printers');
  for (const k of ['purchase_iqd', 'residual_iqd', 'maintenance_iqd_per_hour', 'useful_print_hours', 'baseline_success_rate', 'machine_iqd_per_hour']) {
    assert.match(judge(printers, 200, JSON.stringify({ printers: [{ id: 'bbl-a1', [k]: 1 }] })).join('\n'), new RegExp(`forbidden key ${k}`), k);
  }
  assert.deepEqual(judge(printers, 200, JSON.stringify({ printers: [{ id: 'bbl-a1', price_group: 'f1', untimed_price_group: 'u1' }] })), [], 'a price GROUP label is not a figure');
  const calc = at('/api/products/print-calculator');
  assert.deepEqual(judge(calc, 200, JSON.stringify({ filaments: [{ price_iqd: 25000, iqd_per_gram: 25 }], rates: { configured: true } })), [], 'the filament sale prices stay');
  for (const k of ['margin_percent', 'setup_fee_iqd', 'machine_iqd_per_hour']) {
    assert.match(judge(calc, 200, JSON.stringify({ rates: { [k]: 1, configured: true } })).join('\n'), new RegExp(`forbidden key ${k}`), k);
  }
  for (const path of ['/api/settings/public', '/api/home']) {
    const p = at(path);
    assert.match(judge(p, 200, JSON.stringify({ settings: { printServicePricing: null } })).join('\n'), /forbidden key printServicePricing/, path);
    assert.match(judge(p, 200, JSON.stringify({ settings: { x: { margin_percent: 30 } } })).join('\n'), /forbidden key margin_percent/, path);
    assert.deepEqual(judge(p, 200, JSON.stringify({ settings: { displayUsdRate: '1667', printerHomeDeliveryNoteIqd: 5000 } })), [], path);
  }
  const page = at('/api/products/{slug}');
  assert.deepEqual(judge(page, 200, JSON.stringify({ product: { media: [{ key: 'k', source_url: '' }] } })), []);
  const leak = judge(page, 200, JSON.stringify({ product: { media: [{ key: 'k', source_url: SUPPLIER_LINK }] } })).join('\n');
  assert.match(leak, /source_url \(at product\.media\[0\]\.source_url\) does not match/);
  assert.doesNotMatch(leak, /supplier-secret/, 'a failure line never carries the value');
  // Pricing V2 (spec §8): a V2 private key or flag on a product page is a leak; the final price is not.
  for (const path of ['/api/products/{slug}', '/api/public/v1/products/{slug}']) {
    const p = at(path);
    for (const k of ['v2_points', 'editor_usd', 'editor_usd_price', 'discount_usd', 'usd_ceil6', 'exact_iqd', 'sku_strict', 'v2']) {
      assert.match(judge(p, 200, JSON.stringify({ product: { [k]: '1' } })).join('\n'), new RegExp(`forbidden key ${k}`), `${path} ${k}`);
    }
    assert.deepEqual(judge(p, 200, JSON.stringify({ product: { price_iqd: 1_600_000, sku_prices: [{ combo_key: 'o:a', channel: 'direct_sale', regular_price_iqd: 1_600_000 }] } })), [], path);
  }
});

test('leaks.json against the local Worker with every private print figure set and a supplier link on the probed product: every probe passes', async () => {
  const leaksFile = files.find((f) => f.file === 'leaks.json')!;
  const raw = freshDb();
  raw.exec('PRAGMA foreign_keys = OFF;');
  seedCostlyProduct(raw);
  seedLiveCatalog(raw);
  // The owner's private print figures, all set (the audit found the sweeps reading nulls).
  raw.exec(`
    INSERT INTO admin_settings (key,value) VALUES
      ('printServicePricing','{"machine_iqd_per_hour":6141,"setup_fee_iqd":6252,"margin_percent":27.75}')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    UPDATE printer_models SET purchase_iqd = 2150000, residual_iqd = 350000, useful_print_hours = 6000, maintenance_iqd_per_hour = 180;
  `);
  const env = { DB: asD1(raw), STORE_ROOT_DOMAIN: APEX, APP_ORIGIN: `https://${APEX}`, INITIAL_ADMIN_EMAIL: 'boss@x.co', EXTRA_ALLOWED_ORIGINS: '', ASSETS: { fetch: async () => new Response('spa') } };
  const get = async (path: string) => {
    const res = await fetchPublished(worker, new Request(`https://${APEX}${path}`, { headers: { Host: APEX, accept: 'application/json', 'CF-Connecting-IP': '9.9.9.9' } }), env as never, ctx);
    return { status: res.status, text: await res.text() };
  };
  const vars: Record<string, string> = {};
  for (const [name, def] of Object.entries(leaksFile.spec.vars ?? {})) vars[name] = pick(JSON.parse((await get(def.from!)).text), def.pick!);
  assert.ok(vars.slug, 'the probed slug resolves');
  // A picture fetched by URL from a supplier, on the very product the probes read.
  const key = `products/x/gallery/${'d4'.repeat(32)}.webp`;
  raw.prepare('UPDATE products SET images = ? WHERE slug = ?').run(
    JSON.stringify([{ id: 'img_sup', url: `/files/${key}`, key, role: 'gallery', alt_ar: 'صورة', alt_en: 'Picture', alt_ckb: 'وێنە', order: 0, primary: true, width: 800, height: 800, source_url: SUPPLIER_LINK, option_value_id: '', color_id: '', variant_id: '' }]),
    vars.slug
  );
  const failures: string[] = [];
  const bodies = new Map<string, string>();
  for (const p of leaksFile.spec.probes) {
    const path = fillPath(p.path, vars);
    const { status, text } = await get(path);
    bodies.set(p.path, text);
    failures.push(...(judge(p, status, text) as string[]).map((f) => `${path}: ${f}`));
  }
  assert.deepEqual(failures, []);
  // Not vacuous: the lists are there, the picture is served, and its supplier link is blanked.
  assert.ok(JSON.parse(bodies.get('/api/print-quote/accessories')!).accessories.length > 0, 'the accessory catalogue answered');
  assert.ok(JSON.parse(bodies.get('/api/print-quote/printers')!).printers.length > 0, 'the printer list answered');
  assert.equal(JSON.parse(bodies.get('/api/products/print-calculator')!).rates.configured, true, 'the calculator says the owner priced the service');
  const pageText = bodies.get('/api/products/{slug}')!;
  assert.ok(pageText.includes(key), 'the product page serves the picture');
  assert.ok(pageText.includes('"source_url":""'), 'with its supplier link blanked');
  for (const text of bodies.values()) assert.equal(text.includes('supplier-secret'), false);
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
  assert.match(yml.slice(probes, probes + 600), /node scripts\/live-cost-probes\.mjs --base https:\/\/levonis-iq\.com/);
});

// ------------------------------------------------------------- the clean start (DECISIONS row 222, addendum A.4.6)

test('optional vars: a probe whose optional var has no value is SKIPPED, a required one still refuses; --var fills a var; forbidValues names the key, never the value', () => {
  const page = { path: '/api/products/{slug}', status: [200] };
  assert.deepEqual(Object.keys(planProbe(page, {}, { slug: { optional: true } })), ['skip']);
  assert.match(planProbe(page, {}, { slug: { optional: true } }).skip, /no listed product yet/);
  assert.match(planProbe(page, {}, { slug: { from: '/api/products?limit=1' } }).error, /has no value/);
  assert.deepEqual(planProbe(page, { slug: 'a1' }, { slug: { optional: true } }), { path: '/api/products/a1' });
  assert.deepEqual(cliVars(['--base', 'https://x', '--var', 'hidden_slug=bambu-a1', '--var', 'broken']), { hidden_slug: 'bambu-a1' });
  const search: Probe = { path: '/api/products?search={hidden_slug}', status: [200], forbidValues: { slug: '{hidden_slug}' } };
  assert.deepEqual(judge(search, 200, JSON.stringify({ products: [{ slug: 'other' }] }), { hidden_slug: 'secret-slug' }), []);
  const hit = judge(search, 200, JSON.stringify({ products: [{ slug: 'secret-slug' }] }), { hidden_slug: 'secret-slug' }).join('\n');
  assert.match(hit, /forbidden value of key slug \(at products\[0\]\.slug\)/);
  assert.doesNotMatch(hit, /secret-slug/, 'a failure line never carries the value');
  // The runner wires it: the CLI vars, the skip and the summary.
  const src = sourceOf('scripts/live-cost-probes.mjs');
  assert.match(src, /const plan = planProbe\(probe, vars, spec\.vars \?\? \{\}, empty\);/);
  assert.match(src, /judge\(plan\.probe \?\? probe, status, text, vars\)/, 'a relaxed listing probe is judged as planned');
  assert.match(src, /await runProbes\(loadProbeFiles\(dir\), \(path\) => get\(base, path\), cliVars\(args\)\)/, 'main runs the exported runner the tests run');
  assert.match(src, /::notice::/);
  assert.match(src, /if \(ran === 0\)/, 'an empty probe set still fails the run');
});

test('readVar: only a 200 JSON answer whose picked list is there and empty is an empty catalogue; no answer, another status, a body that is not JSON or no list at all is a failed read', () => {
  const def = { from: '/api/products?limit=1', pick: 'products.0.slug', optional: true };
  assert.deepEqual(readVar(def, 200, JSON.stringify({ success: true, products: [{ slug: 'a1' }] })), { value: 'a1' });
  assert.deepEqual(readVar(def, 200, JSON.stringify({ success: true, products: [] })), { empty: true });
  assert.match(readVar(def, 503, JSON.stringify({ success: true, products: [] })).error, /status 503/, 'a 503 with an empty list is still a failed read');
  assert.match(readVar(def, 200, '<html>error</html>').error, /not JSON/);
  assert.match(readVar(def, 200, JSON.stringify({ success: false, error: 'SERVICE_SETUP' })).error, /has no products\.0\.slug/, 'no list at all is not an empty one');
  assert.match(readVar(def, 200, JSON.stringify({ products: [{ name: 'A1' }] })).error, /has no products\.0\.slug/, 'a listed product without a slug is not an empty catalogue');
  assert.match(readVar(def, 200, JSON.stringify({ products: {} })).error, /has no/);
  assert.match(readVar(def, 200, JSON.stringify({ products: [{ slug: 7 }] })).error, /has no products\.0\.slug/, 'a slug that is not text is not a slug');
});

test('planProbe + judge: requireWhenVar lets the listing\'s prices be absent ONLY while its var is proven empty; integers and forbidden keys still hold; a failed read relaxes nothing', () => {
  const defs = { slug: { from: '/api/products?limit=1', pick: 'products.0.slug', optional: true } };
  const listing: Probe = { path: '/api/products?limit=3', status: [200], forbidKeys: 'cost|fx', forbidPattern: 'MANUAL_OVERRIDE', requireIntegerKeys: ['price_iqd'], requireWhenVar: 'slug' };
  const page: Probe = { path: '/api/products/{slug}', status: [200], requireIntegerKeys: ['price_iqd'] };
  const empty = new Set(['slug']);
  // Proven empty: the slug probe skips; the listing runs relaxed.
  assert.deepEqual(Object.keys(planProbe(page, {}, defs, empty)), ['skip']);
  const relaxed = planProbe(listing, {}, defs, empty);
  assert.equal(relaxed.path, '/api/products?limit=3');
  assert.match(relaxed.notice, /nothing listed yet/);
  assert.deepEqual(relaxed.probe.requireIntegerKeys, undefined);
  assert.deepEqual(relaxed.probe.integerKeys, ['price_iqd']);
  assert.deepEqual(judge(relaxed.probe, 200, JSON.stringify({ success: true, products: [] })), [], 'an empty list answered 200 is not a leak');
  assert.match(judge(listing, 200, JSON.stringify({ success: true, products: [] })).join('\n'), /required key price_iqd is absent/, 'the unrelaxed probe is what failed the cut-over');
  assert.match(judge(relaxed.probe, 200, JSON.stringify({ products: [{ price_iqd: '1' }] })).join('\n'), /not integers/, 'a price that does appear is still an integer');
  assert.match(judge(relaxed.probe, 200, JSON.stringify({ products: [], cost_iqd: 1 })).join('\n'), /forbidden key cost_iqd/, 'the forbidden keys still hold');
  assert.match(judge(relaxed.probe, 200, '{"products":[],"n":"MANUAL_OVERRIDE"}').join('\n'), /forbidden pattern/);
  assert.match(judge(relaxed.probe, 500, JSON.stringify({ products: [] })).join('\n'), /status 500/);
  // A listed slug: the presence rule is back.
  assert.deepEqual(planProbe(listing, { slug: 'a1' }, defs, new Set()), { path: '/api/products?limit=3' });
  // A FAILED read (the var has no value but was not proven empty): nothing is relaxed, the slug probes refuse.
  assert.deepEqual(planProbe(listing, {}, defs, new Set()), { path: '/api/products?limit=3' });
  assert.match(planProbe(page, {}, defs, new Set()).error, /has no value/, 'a failed read is not an empty catalogue');
  // A workflow var with no `from`, not given: still a legitimate skip (the clean start's hidden slug).
  assert.deepEqual(Object.keys(planProbe({ path: '/api/products/{hidden_slug}', status: [404] }, {}, { hidden_slug: { optional: true } })), ['skip']);
});

/** A fake site for runProbes: answers by path, `throw` for a path that does not answer. */
function fakeSite(answers: Record<string, { status: number; body: unknown } | 'throw'>) {
  return async (path: string) => {
    const a = answers[path];
    if (a === 'throw') throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    if (!a) return { status: 401, text: '{"success":false}' };
    return { status: a.status, text: typeof a.body === 'string' ? a.body : JSON.stringify(a.body) };
  };
}

test('runProbes: the cut-over run — nothing listed yet — is green with the slug probes skipped; a listing that cannot be read fails the run, never passes as empty', async () => {
  const lines: string[] = [];
  const log = (l: string) => lines.push(l);
  const emptyList = { status: 200, body: { success: true, products: [] } };
  const site = (listing: { status: number; body: unknown } | 'throw') => fakeSite({ '/api/products?limit=1': listing, '/api/products?limit=3': emptyList, '/api/home': { status: 200, body: { success: true, sections: [] } } });
  const s1Only = [s1];
  // The clean start: an empty catalogue answered 200.
  const green = await runProbes(s1Only, site(emptyList), {}, log);
  assert.equal(green.failed, 0, lines.filter((l) => l.startsWith('::error::')).join('\n'));
  assert.ok(green.ran > 0 && green.skipped === 2, `ran ${green.ran}, skipped ${green.skipped}`);
  assert.ok(lines.some((l) => /::notice::s1\.json: \/api\/products\?limit=3 — nothing listed yet/.test(l)), 'the relaxation is said out loud');
  // Every way the read can fail is a failure, and the slug probes do not silently skip.
  for (const [why, listing] of [['no answer', 'throw'], ['a 503', { status: 503, body: { success: true, products: [] } }], ['not JSON', { status: 200, body: '<html>' }], ['no list', { status: 200, body: { success: false } }]] as const) {
    lines.length = 0;
    const red = await runProbes(s1Only, site(listing), {}, log);
    assert.ok(red.failed > 0, `${why}: the run must fail`);
    assert.ok(lines.some((l) => /^::error::s1\.json: \{slug\} could not be read from \/api\/products\?limit=1/.test(l)), `${why}: the read failure is an error`);
    assert.equal(red.skipped, 0, `${why}: no slug probe skips on a failed read`);
    assert.ok(lines.some((l) => /^::error::s1\.json: \/api\/products\/\{slug\} — variable \{slug\} has no value/.test(l)), `${why}: the product page probe refuses`);
  }
});

test('the clean start: s1.json and leaks.json read their slug as OPTIONAL, and cleanstart.json probes the hidden product workflow 7 passes in', () => {
  for (const name of ['s1.json', 'leaks.json']) {
    const f = files.find((x) => x.file === name)!;
    assert.equal(f.spec.vars?.slug?.optional, true, `${name}: an empty catalogue right after the cut-over is not a leak`);
    // Probes with no var always run, so the file never proves nothing.
    assert.ok(f.spec.probes.some((p) => !/\{/.test(p.path)), `${name}: some probes need no listed product`);
  }
  const clean = files.find((x) => x.file === 'cleanstart.json');
  assert.ok(clean, 'scripts/live-cost-probes.d/cleanstart.json exists');
  assert.equal(clean!.spec.vars?.hidden_slug?.optional, true);
  assert.equal(clean!.spec.vars?.hidden_slug?.from, undefined, 'the slug comes from the workflow (--var), never from a public read');
  const byPath = new Map(clean!.spec.probes.map((p) => [p.path, p]));
  assert.deepEqual(byPath.get('/api/products/{hidden_slug}')?.status, [404]);
  assert.deepEqual(byPath.get('/api/public/v1/products/{hidden_slug}')?.status, [404]);
  assert.deepEqual(byPath.get('/api/products?search={hidden_slug}')?.forbidValues, { slug: '{hidden_slug}' });
  // Workflow 7 reads one hidden product, read-only, after the migrations, and hands it to the runner.
  const wf = sourceOf('.github/workflows/deploy-staging-code.yml');
  assert.match(wf, /> \/tmp\/hidden_slug\.json/);
  assert.match(wf, /pv2\.mode = 'engine' AND pv2\.pricing_method IS NOT NULL AND EXISTS \(SELECT 1 FROM pricing_v2_sku_results/);
  assert.match(wf, /--var "hidden_slug=\$hidden"/);
  // Read AFTER the deploy and right before the probes: a product the owner publishes while the deploy
  // runs (the new Worker accepts V2 publishes the moment it lands) must not turn a good deploy red.
  const readAt = wf.indexOf('- name: Read one product still waiting for its V2 price (read-only)');
  const deployAt = wf.indexOf('- name: Deploy, carrying every existing var forward');
  const verifyAt = wf.indexOf('- name: Verify the live site, read-only');
  const probesAt = wf.indexOf('- name: Cost-privacy probes, read-only');
  assert.ok(readAt > 0 && deployAt > 0 && verifyAt > 0 && probesAt > 0, 'the four steps are found');
  assert.ok(wf.indexOf('> /tmp/hidden_slug.json') > deployAt, 'the hidden product is read after the deploy');
  assert.ok(readAt > verifyAt && readAt < probesAt, 'after the live verification, before the probes');
  assert.equal((wf.slice(readAt, probesAt).match(/^\s*- name: /gm) ?? []).length, 1, 'no step between the read and the probes');
  assert.doesNotMatch(wf.slice(readAt, probesAt), /--yes|--file|INSERT|UPDATE|DELETE/i, 'the read writes nothing');
});

test('cleanstart.json against the local Worker: a product still waiting for its V2 price is neither shown, found nor searched', async () => {
  const raw = freshDb();
  raw.exec('PRAGMA foreign_keys = OFF;');
  seedLiveCatalog(raw);
  const env = { DB: asD1(raw), STORE_ROOT_DOMAIN: APEX, APP_ORIGIN: `https://${APEX}`, INITIAL_ADMIN_EMAIL: 'boss@x.co', EXTRA_ALLOWED_ORIGINS: '', ASSETS: { fetch: async () => new Response('spa') } };
  // No publish: every seeded product is as the cut-over left it.
  const hidden = LIVE_PRODUCTS[0]!.slug;
  const clean = files.find((x) => x.file === 'cleanstart.json')!;
  const failures: string[] = [];
  for (const p of clean.spec.probes) {
    const plan = planProbe(p, { hidden_slug: hidden }, clean.spec.vars ?? {});
    assert.ok(plan.path, p.path);
    const res = await worker.fetch(new Request(`https://${APEX}${plan.path}`, { headers: { Host: APEX, accept: 'application/json', 'CF-Connecting-IP': '9.9.9.9' } }), env as never, ctx);
    failures.push(...(judge(p, res.status, await res.text(), { hidden_slug: hidden }) as string[]).map((f) => `${plan.path}: ${f}`));
  }
  assert.deepEqual(failures, []);
  // And the whole run workflow 7 makes on the cut-over deploy — every probe file, through the same runner,
  // against this unpublished Worker — is green: the slug probes skip, the listing runs without requiring a
  // price nothing lists yet, and every other probe passes.
  const localGet = async (path: string) => {
    const res = await worker.fetch(new Request(`https://${APEX}${path}`, { headers: { Host: APEX, accept: 'application/json', 'CF-Connecting-IP': '9.9.9.9' } }), env as never, ctx);
    return { status: res.status, text: await res.text() };
  };
  const listed = await localGet('/api/products?limit=1');
  assert.equal(pick(JSON.parse(listed.text), 'products.0.slug'), undefined, 'nothing is listed before the first V2 price');
  assert.deepEqual(readVar(s1.spec.vars!.slug, listed.status, listed.text), { empty: true }, 'an empty catalogue, not a failed read');
  const listing = await localGet('/api/products?limit=3');
  assert.match(judge(probe('/api/products?limit=3')!, listing.status, listing.text).join('\n'), /required key price_iqd is absent/, 'not vacuous: without requireWhenVar this probe fails the cut-over deploy');
  const lines: string[] = [];
  const run = await runProbes(files, localGet, { hidden_slug: hidden }, (l: string) => lines.push(l));
  assert.deepEqual(lines.filter((l) => l.startsWith('::error::')), []);
  assert.equal(run.failed, 0);
  assert.ok(run.ran > 0, 'some probes ran');
  assert.ok(lines.some((l) => /::notice::s1\.json: \/api\/products\?limit=3 — nothing listed yet/.test(l)), 'the listing ran relaxed');
  assert.ok(lines.some((l) => /^ok {2}GET \/api\/products\?limit=3 -> 200$/.test(l)), 'and passed');
  assert.ok(lines.some((l) => /^ok {2}GET \/api\/products\/[^ ]+ -> 404$/.test(l)), 'the hidden product was probed');
  const slugProbes = files.flatMap((f) => f.spec.probes.filter((p) => /\{slug\}/.test(p.path))).length;
  assert.equal(run.skipped, slugProbes, 'every {slug} probe skipped, nothing else');
});
