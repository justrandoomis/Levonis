/**
 * «التسعير والشحن» P1 — THE CLIENT (MVP plan §6 P1; owner decision 2; S1's
 * client-hint pattern).
 *
 *   - the tab is the owner's: the sidebar entry and the tab body need
 *     `can_write_cost === true` (fail-closed); the owner before the address is
 *     verified keeps the entry and meets OwnerCostVerifyCard, never the screen;
 *   - the screen is its own lazy chunk, imported nowhere else;
 *   - it speaks to /api/admin/pricing alone — two GETs and the what-if POST —
 *     and keeps nothing in browser storage;
 *   - a refusal is said by code: OWNER_EMAIL_UNVERIFIED opens the card;
 *   - the preview banner is the first thing on the screen;
 *   - the what-if request carries every decimal as TEXT (never a float), reads
 *     the digits people in Iraq type, and refuses a half box before sending.
 *
 * Run: node --import tsx --test tests/adminPricingClient.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT } from './fixtures/d1';
import { codeOf } from './fixtures/source';
import { buildRequest, decimalOf, emptyDraft, wholeOf } from '../src/components/adminPricing/whatIfRequest';
import { PRICING_UI_STRINGS } from '../src/components/adminPricing/strings';

const DIR = 'src/components/adminPricing';
const files = readdirSync(join(ROOT, DIR)).map((f) => `${DIR}/${f}`);

function srcFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) srcFiles(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(relative(ROOT, p));
  }
  return out;
}

test('the tab is the owner’s: can_write_cost === true for the entry and the body; the unverified owner gets the card', () => {
  const admin = codeOf('src/pages/Admin.tsx');
  assert.match(admin, /const canSeePricing = user\?\.can_write_cost === true;/);
  assert.match(admin, /const pricingMustVerify = !canSeePricing && user\?\.owner_email_unverified === true;/);
  assert.match(admin, /\.\.\.\(canSeePricing \|\| pricingMustVerify\s*\?\s*\[\{ id: 'pricing'/);
  assert.match(admin, /activeTab === 'pricing' && canSeePricing && <AdminPricing \/>/);
  assert.match(admin, /activeTab === 'pricing' && pricingMustVerify && <OwnerCostVerifyCard \/>/);
  // Lazy: its own chunk, never in a customer's first byte.
  assert.match(admin, /const AdminPricing = React\.lazy\(\(\) => import\('\.\.\/components\/adminPricing\/AdminPricing'\)\);/);
  for (const file of srcFiles(join(ROOT, 'src'))) {
    if (file === 'src/pages/Admin.tsx' || file.startsWith(DIR)) continue;
    assert.doesNotMatch(codeOf(file), /adminPricing\//, `${file} reaches into the pricing screen`);
  }
});

test('it speaks to /api/admin/pricing alone — GET overview, GET product, POST what-if — and stores nothing in the browser', () => {
  const api = codeOf(`${DIR}/api.ts`);
  assert.match(api, /export const PRICING_API = '\/api\/admin\/pricing';/);
  const calls = [...api.matchAll(/api\.(get|post|put|patch|delete)<[^>]+>\(`([^`]+)`/g)].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(calls.sort(), [
    'get ${PRICING_API}/overview?page=${Math.max(1, Math.floor(page))}',
    'get ${PRICING_API}/products/${encodeURIComponent(id)}',
    'post ${PRICING_API}/products/${encodeURIComponent(id)}/what-if',
  ]);
  for (const file of files) {
    const code = codeOf(file);
    assert.doesNotMatch(code, /\b(localStorage|sessionStorage|indexedDB)\b/, `${file}: cost data must not persist in the browser`);
    assert.doesNotMatch(code, /api\.(put|patch|delete)\b/, `${file}: the preview never writes`);
    if (file !== `${DIR}/api.ts`) assert.doesNotMatch(code, /['"`]\/api\//, `${file}: a request outside api.ts`);
    assert.doesNotMatch(code, /parseFloat\(/, `${file}: no float parsing near money`);
  }
});

test('a refusal is said by code: OWNER_EMAIL_UNVERIFIED opens the verification card', () => {
  const parts = codeOf(`${DIR}/parts.tsx`);
  assert.match(parts, /error instanceof ApiError && error\.code === 'OWNER_EMAIL_UNVERIFIED'\) return <OwnerCostVerifyCard \/>;/);
  assert.match(parts, /apiRefusal\(error, lang, fallback\)/);
  // Both the list and the product page route their failures through it.
  assert.match(codeOf(`${DIR}/AdminPricing.tsx`), /<PricingFailure error=\{error\}/);
  assert.match(codeOf(`${DIR}/ProductPricingSheet.tsx`), /<PricingFailure error=\{error\}/);
});

test('the preview banner comes first, in the contract’s own words', () => {
  const root = codeOf(`${DIR}/AdminPricing.tsx`);
  const banner = root.indexOf('<PreviewBanner');
  assert.ok(banner > 0, 'no preview banner');
  assert.ok(banner < root.indexOf('<ProductPricingSheet') && banner < root.indexOf('<PricingProducts'), 'the banner is not above the content');
  assert.match(codeOf(`${DIR}/parts.tsx`), /previewOnlyText\(lang\)/);
});

test('the what-if request: decimals as text, Iraqi digits read, a half box refused, nothing sent on an error', () => {
  const s = PRICING_UI_STRINGS.en;
  const d = emptyDraft('EUR');
  d.cost = '١٢٬٥٠٠٫٧٥';
  d.cbm = '0.024';
  d.weight = '۱۲۰۰';
  d.additional = '0';
  d.fx.EUR = '1610.25';
  d.shipping.CHINA_SEA = '350000';
  const { body, errors } = buildRequest(d, s);
  assert.deepEqual(errors, {});
  assert.deepEqual(body, {
    supplier_cost: '12500.75',
    currency: 'EUR',
    additional_cost_iqd: 0,
    measures: { weight_g: 1200, manual_cbm: '0.024' },
    rates: { fx: { EUR: '1610.25' }, shipping: { CHINA_SEA: '350000' } },
  });
  // Every decimal is a string on the wire; only whole units are numbers.
  assert.equal(typeof body!.supplier_cost, 'string');
  assert.equal(typeof body!.measures!.manual_cbm, 'string');
  assert.equal(typeof body!.rates!.fx!.EUR, 'string');
  // A digit string longer than a float holds survives byte for byte.
  assert.equal(decimalOf('123456789012.3456', 12, 4), '123456789012.3456');

  const bad = emptyDraft('USD');
  bad.cost = '0';
  bad.length = '400';
  bad.width = '300';
  const refused = buildRequest(bad, s);
  assert.equal(refused.body, null, 'nothing is sent while a field is wrong');
  assert.equal(refused.errors.cost, s.invalidCost);
  assert.equal(refused.errors.box, s.boxAllThree);

  assert.equal(decimalOf('12.34567', 12, 4), null, 'five decimals');
  assert.equal(decimalOf('-5', 12, 4), null);
  assert.equal(decimalOf('0.0000', 12, 4), null, 'zero is not a cost');
  assert.equal(wholeOf('12.5', 1), null, 'a decimal is not a whole number');
  assert.equal(wholeOf('0', 1), null);
  assert.equal(wholeOf('0', 0), 0);
});

test('the client never computes a price: no import of the engine, and the panel shows the server’s figures', () => {
  for (const file of files) {
    const code = codeOf(file);
    assert.doesNotMatch(code, /costToPrice|ruleResolution|legacyTargets|pricingEngine|packages\/pricing/, `${file} imports pricing maths`);
  }
  const panel = codeOf(`${DIR}/WhatIfPanel.tsx`);
  assert.match(panel, /<Money iqd=\{c\.computed_price_iqd\} \/>/);
  assert.match(panel, /<ChangeLine change=\{c\.change_iqd\}/);
});
