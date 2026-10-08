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
// @ts-expect-error - plain ESM script shared with workflow 7, no types
import * as probesScript from '../scripts/live-cost-probes.mjs';
const { fillPath, judge, loadProbeFiles, pick } = probesScript;

interface Probe {
  path: string;
  status?: number[];
  forbidKeys?: string;
  forbidPattern?: string;
  requireIntegerKeys?: string[];
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
  for (const k of ['cost_iqd', 'supplier_cost', 'replacement_cost_iqd', 'target_profit_iqd', 'margin_iqd', 'premium_rule_id', 'fx_rate', 'exchange_rate_used', 'shipping_rate', 'shipping_weight_g', 'shipping_cbm', 'rate_iqd', 'manual_cbm', 'effective_cbm', 'pricing_weight_g', 'pricing_revision', 'pricing_mode']) {
    assert.ok(keys.test(k), `the probe would miss ${k}`);
  }
  // …and must not trip on the public sale modes of a product page.
  assert.equal(keys.test('pricing_modes'), false);
  assert.equal(keys.test('price_iqd'), false);
  // A product page and the public API are probed too, by a live slug.
  assert.ok(probe('/api/products/{slug}') && probe('/api/public/v1/products/{slug}'));
  assert.equal(s1.spec.vars?.slug?.from, '/api/products?limit=1');
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
