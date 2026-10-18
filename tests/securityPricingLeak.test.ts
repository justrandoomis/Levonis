/**
 * S1 — THE SENTINEL LEAK SWEEP, A GATE FROM FX-1 ON (FX programme plan §14.1
 * (12), §14.2 S1; critique F9).
 *
 * Every private field of the 0179 tables is seeded with a sentinel no public
 * number can equal (tests/fixtures/fxSentinels.ts), on top of the role
 * matrix's costly product, stock, order and purchase. Then EVERY GET route of
 * every mount of worker/index.ts — the admin routers, the storefront, the
 * public API, `/api/settings/public`, `/api/home` — is called as every caller
 * who must see no cost (guest, customer, merchant, every non-owner admin, the
 * employee, the investor, the support assistant), and the HTML documents the
 * Worker renders are fetched as a guest. No sentinel, as a number or as text,
 * and no FINANCIAL_FIELDS key with a value may appear anywhere. The one
 * exception is `displayUsdRate`, which equals the effective USD/IQD by design.
 * FX-3 reseeds this with the supplier inputs, FX-6 with the lot snapshot.
 *
 * Not vacuous: the owner's own sweep sees the sentinels on the rates screens.
 *
 * Run: node --import tsx --test tests/securityPricingLeak.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index';
import { APEX, asD1, ctx } from './fixtures/app';
import { OWNER, ROLES, seededCopy, sweepGets, type SweepResult } from './fixtures/roleMatrix';
import { BATCH_SENTINELS, FX_DISPLAY_RATE, FX_SENTINELS, V2_SENTINELS, seedBatchSentinels, seedFxSentinels } from './fixtures/fxSentinels';
import { arithmeticLeaks } from './fixtures/costlyProduct';

const seed = () => {
  const raw = seededCopy();
  seedFxSentinels(raw);
  // FX-6: a batch whose purchase snapshot carries sentinels (migration 0182).
  seedBatchSentinels(raw);
  return raw;
};
// Pricing V2 (0189): the role matrix seeds its costly product's V2 stores with
// V2_SENTINELS (seedV2Sentinels). The product stays unmigrated here, so no door
// serves them; the V2 routes' sweep over the same sentinels — with the product
// made V2, and the owner's read proving it is not vacuous — is
// tests/pricingV2Roles.test.ts (spec §8, V2-3b deviation 11).
const SENTINELS = [...FX_SENTINELS, ...BATCH_SENTINELS, ...V2_SENTINELS];
const extra = { decimals: SENTINELS, numbers: SENTINELS.map(Number) };

let sweep: Promise<Record<string, SweepResult>> | null = null;
const all = () => (sweep ??= sweepGets({ seed, extra, roles: { ...ROLES, owner: OWNER } }));

for (const role of Object.keys(ROLES)) {
  test(`S1: no GET answer to ${role} carries an FX sentinel or a private FX key`, async () => {
    const r = (await all())[role]!;
    assert.ok(r.answered > 10, `${role}: only ${r.answered} answers walked`);
    assert.deepEqual(r.leaks, []);
  });
}

test('S1 is not vacuous: the owner sees the sentinels on the rates screens', async () => {
  const owner = (await all()).owner!;
  for (const path of ['/api/admin/pricing/rates', '/api/admin/pricing/rates/history']) assert.ok(owner.costSeen.includes(path), `${path} showed the owner nothing`);
});

test('S1: the public answers carry the display rate and nothing else of FX; the documents carry no sentinel', async () => {
  const raw = seed();
  const env = { DB: asD1(raw), STORE_ROOT_DOMAIN: APEX, APP_ORIGIN: `https://${APEX}`, INITIAL_ADMIN_EMAIL: 'boss@x.co', EXTRA_ALLOWED_ORIGINS: '', ASSETS: { fetch: async () => new Response('<!doctype html><html><head></head><body><div id="root"></div></body></html>', { headers: { 'content-type': 'text/html' } }) } };
  const fetchText = async (path: string) => {
    const res = await worker.fetch(new Request(`https://${APEX}${path}`, { headers: { Host: APEX, 'CF-Connecting-IP': '9.9.9.9' } }), env as never, ctx);
    return { status: res.status, text: await res.text() };
  };
  const settings = JSON.parse((await fetchText('/api/settings/public')).text);
  assert.equal(settings.settings.displayUsdRate, FX_DISPLAY_RATE, 'the exception: the one official USD/IQD, the applied rate, exactly, is public (DECISIONS row 252)');
  for (const path of ['/', '/p/a1', '/api/settings/public', '/api/home', '/api/home/sections', '/api/products', '/api/products/a1', '/api/public/v1/products', '/api/public/v1/products/a1']) {
    const { text } = await fetchText(path);
    for (const s of SENTINELS) assert.equal(text.includes(s), false, `${path} carries ${s}`);
    assert.doesNotMatch(text, /market_rate|adjustment_iqd_per_usd|market_adjustment_iqd|settings_diff|pending_effective|last_known_good|drift_anchor|iqwealth|rate_iqd"/, path);
    // V2-0 C5 (DECISIONS row 225): final numbers only — no step of a price
    // either. A JSON answer is walked key by key; a document is searched for
    // the names that can mean nothing else.
    if (path.startsWith('/api/')) assert.deepEqual(arithmeticLeaks(JSON.parse(text)), [], path);
    else assert.doesNotMatch(text, ARITHMETIC_ONLY_KEYS, path);
  }
});

/** Key names that are the arithmetic of a price and nothing else, as they would appear in serialized JSON. */
const ARITHMETIC_ONLY_KEYS =
  /"(member_rule|regular_price_iqd|regular_adjust_iqd|prime_adjust_iqd|pro_adjust_iqd|direct_surcharge_iqd|surcharge_iqd|commission_iqd|membership_adjustment_iqd|transport_fee_iqd|direct_fee_iqd|warranty_fee_iqd)"\s*:/;
