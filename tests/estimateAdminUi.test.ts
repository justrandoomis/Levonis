/**
 * «التسعير التقديري» — THE OWNER'S ESTIMATES WORKSPACE, ITS SUPPLIER LINKS AND
 * THE PRODUCT FORM'S BANNER (docs/SMART_PRICING.md §3.9, §7, §10, §12 WP12).
 *
 *   - the workspace is LAZY and OWNER-MOUNTED: its own chunk, opened from a card
 *     in «التسعير والشحن» (itself mounted only for `can_write_cost === true`),
 *     imported nowhere else; the banner is its own lazy chunk too, and reads
 *     the owner's routes only for the owner — every other admin sees the
 *     product read's state and no request is made;
 *   - EVERY CALL GOES TO /api/admin/pricing, each one a route the two owner
 *     routers really serve; nothing is kept in browser storage, no float is
 *     parsed, no private figure is baked into the code;
 *   - THREE LANGUAGES: every string in Arabic, English and real Sorani (never
 *     the Arabic copied, row 183), every flag and reason code labelled, the
 *     server's owner-only sentences copied exactly;
 *   - THE SUPPLIER LINKS (§3.9): the Tmall item id with its copy button, the
 *     item and the exact option opened in a new tab without an opener or a
 *     referrer, the EU links as the server built them (`skr=yes`), the captured
 *     price with its currency, label and date, «تحديث السعر»; a link the server
 *     did not build from the three fixed https origins is never drawn, and a
 *     key gone from the newest capture keeps its links and shows no price;
 *   - the browser's own helpers: the upload (strict parse, SHA-256, chunks of
 *     ≤ 50 items and ≤ 256 KB), the decimals as TEXT, the type editor's body,
 *     the bulk accept, the apply outcomes, the workspace address.
 *
 * Run: node --import tsx --test tests/estimateAdminUi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ROOT } from './fixtures/d1';
import { codeOf } from './fixtures/source';
import { LanguageProvider } from '../src/LanguageContext';
import { FINANCIAL_FIELDS } from '../worker/lib/adminScope';
import { STORE_PAGE_UNREADABLE_TEXT } from '../worker/lib/supplierPrices/storePage';
import { SUPPLIER_PRICE_FORMAT_MESSAGE } from '../packages/catalog/src/supplierPrices/format';
import { MATCH_REASONS } from '../packages/catalog/src/supplierPrices/match';
import { supplierItemUrl, supplierSkuUrl } from '../packages/catalog/src/supplierPrices/links';
import {
  ESTIMATE_BLOCKING_FLAGS,
  ESTIMATE_HARD_FLAGS,
  ESTIMATE_INFO_FLAGS,
  ESTIMATE_REFUSALS,
  ESTIMATE_SOFT_FLAGS,
  ESTIMATE_STRINGS,
} from '../packages/contracts/src/priceEstimates';
import * as STRINGS from '../src/components/adminEstimates/strings';
import { FLAG_LABELS, LINKS, OWNER_REFUSALS, REASON_LABELS, flagClass, flagText, say, type Tri, type UiLang } from '../src/components/adminEstimates/strings';
import { ESTIMATE_PRICING_API, ESTIMATES_API, SUPPLIER_PRICES_API, productEditorHref, safeSupplierHref, workspaceHref, type ProductLinks, type SupplierLink } from '../src/components/adminEstimates/api';
import { decimalText, latinDigits, noteText, wholeNumber } from '../src/components/adminEstimates/input';
import { UploadPrepareError, UPLOAD_CHUNK_BYTES, UPLOAD_CHUNK_ITEMS, planChunks, prepareUpload, sha256Hex } from '../src/components/adminEstimates/upload';
import { APPLY_PAGE, RunStopped, applyInPages, computeAllPages, matchAllPages, sendUpload } from '../src/components/adminEstimates/runs';
import { groupDecimal, moneyText, pctText } from '../src/components/adminEstimates/format';
import { FlagList, SupplierLinkRow, flagFieldNames, refusalText } from '../src/components/adminEstimates/parts';
import { PRICING_FIELD_LABELS } from '../packages/contracts/src/pricingFieldLabels';
import { ProductLinksCard } from '../src/components/adminEstimates/LinksTab';
import { bulkAcceptable } from '../src/components/adminEstimates/ReviewTab';
import { allowedRoutes, typeUpdateOf } from '../src/components/adminEstimates/TypesTab';
import { outcomeText, refreshKeepsPrices, rowFlags } from '../src/components/adminEstimates/EstimateLists';
import { readWorkspaceAddress } from '../src/components/adminEstimates/EstimateWorkspace';
import { prepareFailureText } from '../src/components/adminEstimates/SnapshotsTab';
import EstimateBanner, { StaffEstimateState, sourceDates } from '../src/components/adminEstimates/EstimateBanner';
import EstimatesCard from '../src/components/adminEstimates/EstimatesCard';
import { confirmGate, openFlagsOf, withNamed } from '../src/components/adminEstimates/ConfirmSheet';
import { MeasuresHold, confirmHint, holdText, measureHold, statementOf, type MeasureHold } from '../src/components/adminEstimates/ConfirmSheet';
import { cmText, kgText } from '../src/components/adminEstimates/format';
import { productDimensionsHref, type ConfirmGate } from '../src/components/adminEstimates/api';
import { DimensionsSection } from '../src/components/adminProducts/form/DimensionsSection';
import { emptyDimensions } from '../src/lib/productTypes';
import { ApiError } from '../src/lib/api';
import { COST_REFUSALS } from '../packages/contracts/src/costRefusals';
import type { EstimateLine, EstimateType, StoredEstimate } from '../src/components/adminEstimates/api';

const DIR = 'src/components/adminEstimates';
const LANGS: readonly UiLang[] = ['ar', 'en', 'ckb'];
const files = readdirSync(join(ROOT, DIR))
  .filter((f) => /\.(ts|tsx)$/.test(f))
  .map((f) => `${DIR}/${f}`);

function srcFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) srcFiles(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(relative(ROOT, p).split(sep).join('/'));
  }
  return out;
}

let LANG: UiLang = 'ar';
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (k === 'levo_lang' ? LANG : null),
  setItem: () => {},
  removeItem: () => {},
};
function inLang(child: ReactElement, lang: UiLang): string {
  LANG = lang;
  return renderToStaticMarkup(createElement(LanguageProvider, { children: child }));
}
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
/** Every `<a …>` opening tag of a markup. */
const anchors = (html: string) => [...html.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);
const attr = (tag: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1]?.replace(/&amp;/g, '&') ?? null;

// ---------------------------------------------------------------- fixtures

const TMALL_ITEM = '1053109777521';
const TMALL_SKU = '6264995743059';
const EU_VARIANT = '596571526982115329';

function link(over: Partial<SupplierLink> = {}): SupplierLink {
  return {
    source: 'tmall_cn',
    state: 'confirmed',
    item_key: TMALL_ITEM,
    sku_key: TMALL_SKU,
    title: '拓竹 3D打印模型手捻钻 创客宝库-ZH121',
    name_en: 'Bambu hand drill kit ZH121',
    options: { 商品规格: '手捻钻钻头套装（1套）' },
    options_en: { Spec: 'Hand drill bit set (1 set)' },
    codes: ['ZH121'],
    price: '40',
    currency: 'CNY',
    price_label: '优惠前',
    captured_on: '2026-10-31',
    quantity: 59,
    item_url: supplierItemUrl('tmall_cn', TMALL_ITEM),
    sku_url: supplierSkuUrl('tmall_cn', TMALL_ITEM, TMALL_SKU),
    missing: false,
    match_confidence: 'high',
    match_method: 'part_code',
    match_reasons: ['CODE_EQUAL'],
    units_per_offer: 1,
    decided_at: '2026-10-31T10:00:00.000Z',
    note: '',
    ...over,
  };
}

const euLink = (over: Partial<SupplierLink> = {}) =>
  link({
    source: 'bambu_eu',
    item_key: 'h2d',
    sku_key: EU_VARIANT,
    title: 'H2D',
    name_en: 'H2D',
    options: { option1: 'H2D AMS Combo', option2: 'Standard' },
    options_en: { option1: 'H2D AMS Combo', option2: 'Standard' },
    codes: [],
    price: '2599',
    currency: 'EUR',
    price_label: '',
    item_url: supplierItemUrl('bambu_eu', 'h2d'),
    sku_url: supplierSkuUrl('bambu_eu', 'h2d', EU_VARIANT),
    match_confidence: 'exact',
    ...over,
  });

const product = (skus: ProductLinks['skus']): ProductLinks => ({
  product_id: 'prod_drill',
  name: 'Hand drill kit',
  names: { ar: 'طقم المثقاب اليدوي', en: 'Hand drill kit', ckb: 'کۆمەڵەی دەستەمێکوتی دەستی' },
  versions: { matches: '1.1.2026-10-31', manual: '0.0.' },
  skus,
});

// ---------------------------------------------------------------- lazy and owner-mounted

test('the workspace is lazy and owner-mounted: a card in «التسعير والشحن» opens its own chunk, imported nowhere else', () => {
  // The pricing tab is mounted for the owner alone, fail-closed (unchanged).
  const admin = codeOf('src/pages/Admin.tsx');
  assert.match(admin, /const canSeePricing = user\?\.can_write_cost === true;/);
  assert.match(admin, /activeTab === 'pricing' && canSeePricing && <AdminPricing \/>/);
  assert.doesNotMatch(admin, /adminEstimates/, 'the admin shell never reaches the workspace itself');

  const pricing = codeOf('src/components/adminPricing/AdminPricing.tsx');
  assert.match(pricing, /const EstimateWorkspace = lazy\(\(\) => import\('\.\.\/adminEstimates\/EstimateWorkspace'\)\);/);
  assert.match(pricing, /const EstimatesCard = lazy\(\(\) => import\('\.\.\/adminEstimates\/EstimatesCard'\)\);/);
  assert.doesNotMatch(pricing, /from '\.\.\/adminEstimates\//, 'the pricing tab imports nothing of the workspace statically');
  assert.match(pricing, /<EstimatesCard onOpen=\{\(\) => openEstimates\(true\)\} \/>/);
  assert.match(pricing, /<EstimateWorkspace onBack=\{\(\) => openEstimates\(false\)\} \/>/);
  // The rates panel stays the tab's first section; the estimates card comes after the V2 card.
  assert.ok(pricing.indexOf('<RatesPanel') < pricing.indexOf('data-pricing-v2-card'));
  assert.ok(pricing.indexOf('data-pricing-v2-card') < pricing.indexOf('<EstimatesCard'));

  // The banner: its own lazy chunk in section ٣, under Suspense.
  const section = codeOf('src/components/adminProducts/form/v2/PricesSectionV2.tsx');
  assert.match(section, /const EstimateBanner = lazy\(\(\) => import\('\.\.\/\.\.\/\.\.\/adminEstimates\/EstimateBanner'\)\);/);
  assert.doesNotMatch(section, /from '\.\.\/\.\.\/\.\.\/adminEstimates\//);
  // …handed the form's ways in (§4.9: a statement of real measures reloads the form; «الأبعاد والوزن» and the cost
  // weight open in place) and read again when the stored pricing moves.
  assert.match(
    section,
    /<Suspense fallback=\{null\}>\s*<EstimateBanner\s+productId=\{productId\}\s+owner=\{v2\.owner\}\s+state=\{priceEstimate\}\s+onProductChanged=\{onProductChanged\}\s+onOpenDimensions=\{onOpenDimensions\}\s+onOpenCost=\{onOpenCost\}\s+revision=\{v2\.stored\?\.seq \? `\$\{v2\.stored\.seq\.inputs_seq\}:\$\{v2\.stored\.seq\.write_seq\}` : ''\}\s*\/>/
  );

  // Nobody else reaches into the workspace, statically or lazily.
  const allowed = new Map([
    ['src/components/adminPricing/AdminPricing.tsx', ['EstimateWorkspace', 'EstimatesCard']],
    ['src/components/adminProducts/form/v2/PricesSectionV2.tsx', ['EstimateBanner']],
  ]);
  for (const file of srcFiles(join(ROOT, 'src'))) {
    if (file.startsWith(DIR)) continue;
    const reached = [...codeOf(file).matchAll(/adminEstimates\/([A-Za-z]+)/g)].map((m) => m[1]!);
    assert.deepEqual([...new Set(reached)].sort(), [...(allowed.get(file) ?? [])].sort(), `${file} reaches into the estimates workspace`);
  }
  // …and the workspace never reaches into the pricing tab (tests/adminPricingClient.test.ts pins the tab's own imports).
  for (const file of files) assert.doesNotMatch(codeOf(file), /adminPricing\//, `${file} imports the pricing tab`);
});

test('the banner reads the owner’s routes only for the owner; every other admin sees the state, with no request', () => {
  const section = codeOf('src/components/adminProducts/form/v2/PricesSectionV2.tsx');
  assert.match(section, /productId && v2\.mode === 'stored' && \(v2\.owner \|\| priceEstimate\?\.label \|\| priceEstimate\?\.state\)/);
  const banner = codeOf(`${DIR}/EstimateBanner.tsx`);
  // The staff branch returns before the owner's component, which alone holds the reads.
  const staffAt = banner.indexOf('if (!owner) return <StaffEstimateState');
  const ownerFn = banner.indexOf('function OwnerEstimateBanner(');
  assert.ok(staffAt > 0 && ownerFn > staffAt);
  assert.ok(banner.indexOf('fetchEstimate(') > ownerFn && banner.indexOf('fetchProductLinks(') > ownerFn, 'a read outside the owner’s banner');
  assert.doesNotMatch(banner.slice(0, ownerFn), /fetch[A-Z]\w*\(/, 'the staff state makes a request');

  for (const lang of LANGS) {
    const labelled = inLang(createElement(EstimateBanner, { productId: 'p1', owner: false, state: { label: true, state: 'estimated' } }), lang);
    assert.match(labelled, /data-estimate-banner="staff"/);
    assert.ok(text(labelled).includes(say(STRINGS.BANNER.staffLabel, lang)), lang);
    const paused = renderToStaticMarkup(createElement(StaffEstimateState, { state: { label: false, state: 'paused' }, lang, dir: 'rtl' }));
    assert.ok(text(paused).includes(say(STRINGS.ESTIMATE_STATE_LABELS.paused, lang)), lang);
  }
  assert.equal(renderToStaticMarkup(createElement(StaffEstimateState, { state: null, lang: 'ar', dir: 'rtl' })), '');
  assert.equal(renderToStaticMarkup(createElement(StaffEstimateState, { state: { label: false, state: null }, lang: 'ar', dir: 'rtl' })), '');
  // The owner's banner renders nothing until its reads answer (and nothing at all on an older database).
  assert.equal(inLang(createElement(EstimateBanner, { productId: 'p1', owner: true }), 'ar'), '');
});

test('the card in «التسعير والشحن» says what the workspace is, in three languages', () => {
  for (const lang of LANGS) {
    const html = inLang(createElement(EstimatesCard, { onOpen: () => {} }), lang);
    assert.match(html, /data-pricing-estimates-card/);
    assert.ok(text(html).includes(say(STRINGS.WORKSPACE.cardTitle, lang)), lang);
    assert.ok(text(html).includes(say(STRINGS.WORKSPACE.open, lang)), lang);
  }
});

// ---------------------------------------------------------------- every call goes to /api/admin/pricing

/** The client's calls, normalised: METHOD /router/path with `:p` for every parameter. */
function clientCalls(): string[] {
  const api = codeOf(`${DIR}/api.ts`);
  const out: string[] = [];
  for (const m of api.matchAll(/api\.(get|post|put|patch|delete)<[^>]*>\(\s*`([^`]*)/g)) {
    const path = m[2]!
      .replace('${SUPPLIER_PRICES_API}', '/supplier-prices')
      .replace('${ESTIMATES_API}', '/estimates')
      .replace(/\$\{enc\([^)]*\)\}/g, ':p')
      .replace(/\?.*$/, '')
      .replace(/\$\{qs.*$/, '');
    out.push(`${m[1]!.toUpperCase()} ${path}`);
  }
  return out.sort();
}

/** The routes the two owner routers serve, normalised the same way. */
function serverRoutes(): Set<string> {
  const out = new Set<string>();
  for (const [file, router, prefix] of [
    ['worker/routes/adminSupplierPrices.ts', 'adminSupplierPricesRoutes', '/supplier-prices'],
    ['worker/routes/adminPriceEstimates.ts', 'adminPriceEstimatesRoutes', '/estimates'],
  ] as const) {
    for (const m of codeOf(file).matchAll(new RegExp(`${router}\\.(get|post|put|patch|delete)\\('([^']+)'`, 'g'))) {
      out.add(`${m[1]!.toUpperCase()} ${prefix}${m[2]!.replace(/:[a-z_]+/g, ':p')}`);
    }
  }
  return out;
}

test('every call goes to /api/admin/pricing — each one a route the owner routers really serve', () => {
  assert.equal(ESTIMATE_PRICING_API, '/api/admin/pricing');
  assert.equal(SUPPLIER_PRICES_API, '/api/admin/pricing/supplier-prices');
  assert.equal(ESTIMATES_API, '/api/admin/pricing/estimates');
  const api = codeOf(`${DIR}/api.ts`);
  // Every path starts at one of the two routers.
  for (const m of api.matchAll(/api\.(get|post|put|patch|delete)<[^>]*>\(\s*`([^`]*)/g)) {
    assert.match(m[2]!, /^\$\{(SUPPLIER_PRICES_API|ESTIMATES_API)\}\//, `a call outside /api/admin/pricing: ${m[2]}`);
  }
  const calls = clientCalls();
  assert.deepEqual(calls, [
    'GET /estimates/control',
    'GET /estimates/products',
    'GET /estimates/products/:p',
    'GET /estimates/types',
    'GET /estimates/types/:p/suggest',
    'GET /supplier-prices/links',
    'GET /supplier-prices/links/:p',
    'GET /supplier-prices/lookup',
    'GET /supplier-prices/matches',
    'GET /supplier-prices/snapshots',
    'POST /estimates/apply',
    'POST /estimates/compute',
    'POST /estimates/products/:p/confirm',
    'POST /estimates/types',
    'POST /supplier-prices/match',
    'POST /supplier-prices/read-store-page',
    'POST /supplier-prices/snapshots',
    'POST /supplier-prices/snapshots/:p/complete',
    'POST /supplier-prices/snapshots/:p/discard',
    'POST /supplier-prices/snapshots/:p/items',
    'PUT /estimates/control',
    'PUT /estimates/products/:p',
    'PUT /estimates/types/:p',
    'PUT /supplier-prices/manual/:p',
    'PUT /supplier-prices/matches/:p',
  ]);
  const served = serverRoutes();
  for (const c of calls) assert.ok(served.has(c), `${c} is not a route of the owner routers`);
  // The workspace, the Links tab and the banner make no request of their own: api.ts alone speaks to the server.
  for (const file of files) {
    const code = codeOf(file);
    assert.doesNotMatch(code, /\b(localStorage|sessionStorage|indexedDB)\b/, `${file}: supplier data must not persist in the browser`);
    assert.doesNotMatch(code, /\bparseFloat\(|\bfetch\(/, `${file}: a float parse or a raw fetch`);
    if (file === `${DIR}/api.ts`) continue;
    assert.doesNotMatch(code, /\bapi\.(get|post|put|patch|delete)\b/, `${file}: a request outside api.ts`);
    assert.doesNotMatch(code, /['"`]\/api\//, `${file}: a request outside api.ts`);
  }
});

test('no private figure is baked into the workspace: no owner-only key is ever given a number in the code', () => {
  // The bundle guard (tests/leakAudit_client-bundles_bundle_private_names_guard_gap.test.ts) scans every built
  // chunk for `key:number`; the source is held to the same rule, so a minifier cannot inline one later.
  const keys = (FINANCIAL_FIELDS as readonly string[]).join('|');
  const re = new RegExp(`(?:^|[^A-Za-z0-9_$])['"]?(${keys})['"]?\\s*:\\s*(-?[0-9][0-9_]*(?:\\.[0-9]+)?)(?![A-Za-z0-9_$.])`, 'g');
  for (const file of files) {
    for (const m of codeOf(file).matchAll(re)) assert.equal(Number(m[2]!.replace(/_/g, '')), 0, `${file}: ${m[1]} = ${m[2]}`);
  }
  // One unit is the server's default: a pack division travels only when the owner typed one.
  assert.match(codeOf(`${DIR}/ReviewTab.tsx`), /\.\.\.\(n > 1 \? \{ units_per_offer: n \} : \{\}\)/);
  // No price, rate, measure or profit is typed into the workspace's words (invariant I8).
  for (const [name, value] of Object.entries(STRINGS)) {
    if (name === 'TYPES' || name === 'REVIEW') continue; // their limits (1–1000 units, 2–40 letters, 80 characters) are grammar, not figures
    const walk = (v: unknown) => {
      if (v && typeof v === 'object') for (const x of Object.values(v as object)) walk(x);
      else if (typeof v === 'string') assert.doesNotMatch(v.replace(/\{\w+\}/g, '').replace(/levonis\.supplier-prices\.v1|UTF-8|\b25\b/g, ''), /\d/, `${name}: «${v}» carries a figure`);
    };
    walk(value);
  }
});

// ---------------------------------------------------------------- three languages

const SORANI = /[ڕڵێۆەڤگچپژیک]/;
const ARABIC_ONLY = /[ةىيك]/;
const ARABIC_SCRIPT = /[؀-ۿ]/;
/** «sign in» in the three languages: «تسجيل الدخول» / «سجّل الدخول», «چوونەژوورەوە» / «بچۆ ژوورەوە». */
const SIGN_IN = /sign[- ]?in|تسجيل (?:ال)?دخول|سجّل الدخول|ژوورەوە/i;

function leaves(v: unknown, path: string, out: Array<[string, Tri]> = []): Array<[string, Tri]> {
  if (!v || typeof v !== 'object') return out;
  const o = v as Record<string, unknown>;
  if (typeof o.ar === 'string' && typeof o.en === 'string' && typeof o.ckb === 'string') {
    out.push([path, o as unknown as Tri]);
    return out;
  }
  for (const [k, x] of Object.entries(o)) leaves(x, `${path}.${k}`, out);
  return out;
}

test('every string is in Arabic, English and real Sorani — never the Arabic copied, the slots the same', () => {
  const all = Object.entries(STRINGS).flatMap(([k, v]) => leaves(v, k));
  assert.ok(all.length > 300, `only ${all.length} strings found`);
  const slots = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  for (const [path, s] of all) {
    for (const l of LANGS) {
      assert.ok(s[l].trim().length > 0, `${path}.${l} is empty`);
      assert.equal(s[l], s[l].trim(), `${path}.${l} has stray whitespace`);
    }
    assert.match(s.ar, ARABIC_SCRIPT, `${path}: the Arabic is not Arabic`);
    assert.doesNotMatch(s.en, ARABIC_SCRIPT, `${path}: the English carries Arabic script`);
    assert.match(s.ckb, SORANI, `${path}: the Sorani has no Sorani letter — is it Arabic? «${s.ckb}»`);
    assert.doesNotMatch(s.ckb, ARABIC_ONLY, `${path}: the Sorani uses an Arabic-only letter «${s.ckb}»`);
    assert.notEqual(s.ckb, s.ar, `${path}: the Sorani slot carries the Arabic (row 183)`);
    assert.notEqual(s.ckb, s.en, `${path}: the Sorani slot carries the English`);
    assert.equal(slots(s.ar), slots(s.en), `${path}: the slots differ`);
    assert.equal(slots(s.ckb), slots(s.en), `${path}: the slots differ`);
    // No act of the workspace asks for a fresh sign-in (DECISIONS row 285): no string says one is needed.
    for (const l of LANGS) assert.doesNotMatch(s[l], SIGN_IN, `${path}.${l} speaks of a sign-in «${s[l]}»`);
  }
  // The codebase's own words (C32): «بەرهەم», never «کاڵا»; the pricing tab is «نرخدانان و ناردنی بەرهەم».
  for (const [path, s] of all) assert.doesNotMatch(s.ckb, /کاڵا/, path);
  assert.match(STRINGS.WORKSPACE.back.ckb, /نرخدانان و ناردنی بەرهەم/);
  // The labels the storefront shows are the contract's own words.
  assert.deepEqual({ ...STRINGS.BANNER.label }, { ...ESTIMATE_STRINGS.label });
});

test('every word on screen comes from strings.ts — no Arabic or Sorani typed into a component', () => {
  for (const file of files) {
    if (file === `${DIR}/strings.ts` || file === `${DIR}/input.ts`) continue; // input.ts reads the digits people type
    assert.doesNotMatch(codeOf(file), /[ء-يپچژکگیە]/, `${file} spells a word itself instead of reading strings.ts`);
  }
});

test('every flag and match reason has its words; an unknown code falls back to the pricing contract, then to the code', () => {
  for (const code of [...ESTIMATE_BLOCKING_FLAGS, ...ESTIMATE_HARD_FLAGS, ...ESTIMATE_SOFT_FLAGS, ...ESTIMATE_INFO_FLAGS]) {
    assert.ok(FLAG_LABELS[code], `${code} has no label`);
    for (const l of LANGS) assert.equal(flagText(code, l), FLAG_LABELS[code][l]);
  }
  for (const code of ESTIMATE_HARD_FLAGS) assert.equal(flagClass(code), 'hard');
  for (const code of ESTIMATE_SOFT_FLAGS) assert.equal(flagClass(code), 'soft');
  for (const code of ESTIMATE_INFO_FLAGS) assert.equal(flagClass(code), 'info');
  for (const code of ESTIMATE_BLOCKING_FLAGS) assert.equal(flagClass(code), 'blocking');
  // The evaluation's own codes block an apply too, in the pricing contract's words.
  assert.equal(flagClass('FX_RATE_MISSING'), 'blocking');
  assert.notEqual(flagText('FX_RATE_MISSING', 'en'), 'FX_RATE_MISSING');
  assert.notEqual(flagText('V2_ROUTE_BELOW_COST', 'ckb'), 'V2_ROUTE_BELOW_COST');
  assert.ok(flagText('SOMETHING_NEW', 'en').includes('SOMETHING_NEW'));
  for (const r of MATCH_REASONS) assert.ok(REASON_LABELS[r], `match reason ${r} has no label`);
});

test('the owner-only sentences the contract does not carry are the server’s own, copied exactly', () => {
  assert.deepEqual({ ...OWNER_REFUSALS.SUPPLIER_PRICE_FORMAT_INVALID }, { ...SUPPLIER_PRICE_FORMAT_MESSAGE });
  // §3.6: the store-page refusal the server sends (502) is the contract's own entry, so the
  // workspace resolves it there and keeps no second copy that could drift.
  const unreadable = ESTIMATE_REFUSALS.PRICE_ESTIMATE_STORE_PAGE_UNREADABLE;
  assert.equal(OWNER_REFUSALS.PRICE_ESTIMATE_STORE_PAGE_UNREADABLE, undefined, 'the contract carries it');
  assert.deepEqual({ ...STORE_PAGE_UNREADABLE_TEXT }, { ar: unreadable.ar, en: unreadable.en, ckb: unreadable.ckb });
  for (const lang of LANGS) {
    assert.equal(refusalText({ code: 'PRICE_ESTIMATE_STORE_PAGE_UNREADABLE' }, lang), unreadable[lang], lang);
  }
});

// ---------------------------------------------------------------- the supplier links (§3.9)

test('a Tmall row: the item id with its copy button, the item and the exact option in a new tab, the price with its currency, label and date', () => {
  for (const lang of LANGS) {
    const html = renderToStaticMarkup(createElement('ul', null, createElement(SupplierLinkRow, { link: link(), lang })));
    const as = anchors(html);
    assert.equal(as.length, 2, 'the item link and the option link');
    const hrefs = as.map((a) => attr(a, 'href'));
    assert.deepEqual(hrefs, [`https://detail.tmall.com/item.htm?id=${TMALL_ITEM}`, `https://detail.tmall.com/item.htm?id=${TMALL_ITEM}&skuId=${TMALL_SKU}`]);
    for (const a of as) {
      assert.equal(attr(a, 'target'), '_blank');
      assert.equal(attr(a, 'rel'), 'noopener noreferrer', 'no admin address reaches the store');
    }
    // The ids, each with its own copy button.
    assert.match(html, new RegExp(`data-copy-id="${TMALL_ITEM}"`));
    assert.match(html, new RegExp(`data-copy-id="${TMALL_SKU}"`));
    const t = text(html);
    for (const w of [LINKS.tmallId, LINKS.openTmall, LINKS.openOption, LINKS.skuId]) assert.ok(t.includes(w[lang]), `${lang}: «${w[lang]}»`);
    assert.ok(t.includes('CNY 40') && t.includes('优惠前') && t.includes('2026-10-31'), t);
    assert.ok(t.includes('拓竹') && t.includes('Bambu hand drill kit'), 'the title in Chinese and in English');
  }
});

test('an EU row: the store links exactly as the server built them — skr=yes on the product and on the variant; a US link never carries it', () => {
  const html = renderToStaticMarkup(createElement('ul', null, createElement(SupplierLinkRow, { link: euLink(), lang: 'en' })));
  const hrefs = anchors(html).map((a) => attr(a, 'href'));
  assert.deepEqual(hrefs, ['https://eu.store.bambulab.com/products/h2d?skr=yes', `https://eu.store.bambulab.com/products/h2d?id=${EU_VARIANT}&skr=yes`]);
  assert.ok(text(html).includes('EUR 2,599') && text(html).includes(LINKS.openEu.en));
  const us = euLink({ source: 'bambu_us', currency: 'USD', item_url: supplierItemUrl('bambu_us', 'h2d'), sku_url: supplierSkuUrl('bambu_us', 'h2d', '581025672340709385') });
  const usHrefs = anchors(renderToStaticMarkup(createElement('ul', null, createElement(SupplierLinkRow, { link: us, lang: 'en' })))).map((a) => attr(a, 'href'));
  assert.deepEqual(usHrefs, ['https://us.store.bambulab.com/products/h2d', 'https://us.store.bambulab.com/products/h2d?id=581025672340709385']);
  for (const h of usHrefs) assert.doesNotMatch(h!, /skr=/);
});

test('a link the server did not build from the three fixed https origins is never drawn; the id stays as text', () => {
  for (const hostile of [
    'javascript:alert(1)',
    'http://detail.tmall.com/item.htm?id=1',
    'https://evil.example/products/h2d',
    'https://detail.tmall.com.evil.example/item.htm?id=1',
    '//detail.tmall.com/item.htm?id=1',
    'https://eu.store.bambulab.com/products/h2d"><script>',
    'data:text/html,hi',
    '',
    null,
  ]) {
    assert.equal(safeSupplierHref(hostile), null, String(hostile));
    const html = renderToStaticMarkup(createElement('ul', null, createElement(SupplierLinkRow, { link: link({ item_url: hostile, sku_url: hostile }), lang: 'en' })));
    assert.equal(anchors(html).length, 0, `drawn: ${hostile}`);
    assert.ok(text(html).includes(TMALL_ITEM) && text(html).includes(TMALL_SKU), 'the ids are still shown');
    assert.ok(text(html).includes(LINKS.noLink.en));
  }
  for (const ok of [supplierItemUrl('tmall_cn', '1'), supplierSkuUrl('bambu_eu', 'h2d', '1'), supplierItemUrl('bambu_us', 'x1-carbon')]) assert.equal(safeSupplierHref(ok), ok);
});

test('a key gone from the newest capture keeps its links and shows no price; the owner’s own price shows no link', () => {
  const gone = renderToStaticMarkup(createElement('ul', null, createElement(SupplierLinkRow, { link: link({ missing: true, price: null, captured_on: null, price_label: null, options: null, options_en: null }), lang: 'ar' })));
  assert.equal(anchors(gone).length, 2, 'the links stay');
  assert.match(gone, /data-link-missing/);
  assert.doesNotMatch(gone, /data-link-price/);
  assert.ok(text(gone).includes(LINKS.missing.ar));
  const manual = link({ source: 'typed', state: 'manual', item_key: null, sku_key: null, title: null, name_en: null, options: null, options_en: null, codes: [], price: '41.5', item_url: null, sku_url: null, price_label: null, captured_on: '2026-10-31', note: 'رأيته في التطبيق', match_confidence: null, match_reasons: [] });
  const html = renderToStaticMarkup(createElement('ul', null, createElement(SupplierLinkRow, { link: manual, lang: 'en' })));
  assert.equal(anchors(html).length, 0);
  assert.ok(text(html).includes('CNY 41.5') && text(html).includes(say(LINKS.entered, 'en', { date: '2026-10-31' })));
  assert.ok(text(html).includes(STRINGS.LINK_STATE_LABELS.manual.en));
});

test('the Links tab’s card: every option with its facts and «تحديث السعر», and the product’s editor', () => {
  const p = product([
    { combo_key: 'o:spool', labels: { ar: 'مع بكرة', en: 'With spool', ckb: 'لەگەڵ سپوڵ' }, supplier_prices: [link()] },
    { combo_key: 'o:refill', labels: { ar: 'عبوة بديلة', en: 'Refill', ckb: 'پڕکردنەوە' }, supplier_prices: [] },
  ]);
  for (const lang of LANGS) {
    const html = renderToStaticMarkup(createElement('ul', null, createElement(ProductLinksCard, { product: p, lang, onUpdate: () => {} })));
    assert.match(html, /data-links-product="prod_drill"/);
    assert.equal((html.match(/data-links-update=/g) ?? []).length, 2, 'one «تحديث السعر» per fact, one for the option with none');
    const t = text(html);
    assert.ok(t.includes(say(LINKS.updatePrice, lang)) && t.includes(say(LINKS.noLinkForSku, lang)), lang);
    assert.ok(t.includes(p.names[lang]), `${lang}: the product's name`);
    const editor = anchors(html).find((a) => attr(a, 'href')?.startsWith('/admin?'));
    assert.equal(attr(editor!, 'href'), '/admin?tab=products&edit=prod_drill&section=3');
  }
  assert.equal(productEditorHref('bad id'), null);
});

test('the Links tab searches by name, Tmall id or URL, store handle, colour or part code, filters by source and pages by cursor', () => {
  const tab = codeOf(`${DIR}/LinksTab.tsx`);
  assert.match(tab, /fetchLinks\(\{ q, source, cursor: pages\.cursor \}/);
  assert.match(tab, /fetchProductLinks\(focusProduct/);
  assert.match(tab, /placeholder=\{say\(LINKS\.searchPlaceholder, lang\)\}/);
  assert.match(tab, /<UpdatePriceSheet target=\{target\}/);
  assert.match(tab, /<Pager /);
  for (const w of ['Tmall', 'colour', 'part code', 'handle']) assert.ok(LINKS.searchPlaceholder.en.includes(w), w);
  // «تحديث السعر»: manual entry for any source, the one-page store read for an EU or US link, Tmall never fetched.
  const sheet = codeOf(`${DIR}/UpdatePriceSheet.tsx`);
  assert.match(sheet, /setManualPrices\(product\.product_id, \{\s*version: product\.versions\.manual/);
  assert.match(sheet, /readStorePage\(\{ url: url\.trim\(\), \.\.\.\(save \? \{ save: \{ product_id: product\.product_id, combo_keys: keys \} \} : \{\}\) \}\)/);
  assert.match(sheet, /target\.link\?\.source !== 'tmall_cn' \? \(/, 'no store read is offered for a Tmall link');
  assert.match(sheet, /SOURCE_CURRENCY\[from\]/, 'the link’s currency is selected');
});

// ---------------------------------------------------------------- the browser's helpers

test('decimals stay TEXT: the digits people in Iraq type are read, a comma is never guessed', () => {
  assert.equal(latinDigits('١٢٬٥٠٠٫٧٥'), '12500.75');
  assert.equal(decimalText('٢٧٫٩٩'), '27.99');
  assert.equal(decimalText('1,599'), '1599');
  assert.equal(decimalText('1,599.5'), '1599.5');
  assert.equal(decimalText('007.50'), '7.50');
  assert.equal(decimalText(''), '');
  for (const bad of ['27,99', '1,59', '-3', '0', '0.00', '1.', '.5', '1e3', 'abc', '1.2.3']) assert.equal(decimalText(bad), null, bad);
  assert.equal(decimalText('1.1234567', { maxDecimals: 6 }), null);
  assert.equal(decimalText('1.123456', { maxDecimals: 6 }), '1.123456');
  assert.equal(wholeNumber('۱۲۰۰', 1, 100000), 1200);
  assert.equal(wholeNumber('', 1, 10), '');
  for (const bad of ['1.5', '0', '100001', '-1']) assert.equal(wholeNumber(bad, 1, 100000), null, bad);
  assert.equal(noteText('  مثل الأسود  '), 'مثل الأسود');
  assert.equal(noteText('a\u202eb'), null, 'a bidi override is refused');
  assert.equal(noteText('x'.repeat(301)), null);
  // Formatting only — no figure is derived.
  assert.equal(groupDecimal('1599.50'), '1,599.50');
  assert.equal(moneyText('27.99', 'EUR'), 'EUR 27.99');
  assert.equal(pctText('12.345'), '+12.34%');
  assert.equal(pctText('-3.10'), '−3.1%');
});

test('the upload: the strict parser in the browser, the SHA-256 of the bytes, chunks of ≤ 50 items and ≤ 256 KB in file order', async () => {
  const raw = readFileSync(join(ROOT, 'tests/fixtures/supplierPrices/tmall-2026-10-31.v1.json'), 'utf8');
  const bytes = new TextEncoder().encode(raw);
  const file = JSON.parse(raw) as { source: string; items: Array<{ skus: unknown[] }> };
  const prepared = await prepareUpload(bytes);
  assert.equal(prepared.header.source, file.source);
  assert.equal(prepared.itemCount, file.items.length);
  assert.equal(prepared.skuCount, file.items.reduce((n, i) => n + i.skus.length, 0));
  assert.equal(prepared.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(prepared.chunks.flatMap((c) => c.items), file.items, 'the items travel exactly as the file writes them, in order');
  for (const c of prepared.chunks) {
    assert.ok(c.items.length <= UPLOAD_CHUNK_ITEMS);
    assert.ok(Buffer.byteLength(JSON.stringify({ items: c.items, offset: c.offset })) <= UPLOAD_CHUNK_BYTES);
  }
  // Offsets name each chunk's first item in the file.
  let at = 0;
  for (const c of prepared.chunks) {
    assert.equal(c.offset, at);
    at += c.items.length;
  }
  // 120 small items: 50 / 50 / 20; a byte limit splits sooner; an item larger than a chunk is refused.
  const many = Array.from({ length: 120 }, (_, i) => ({ item_key: String(i), skus: [] }));
  assert.deepEqual(planChunks(many).map((c) => [c.offset, c.items.length]), [[0, 50], [50, 50], [100, 20]]);
  const tight = planChunks(many, 50, 200);
  assert.ok(tight.length > 3 && tight.every((c) => Buffer.byteLength(JSON.stringify({ items: c.items, offset: c.offset })) <= 200));
  assert.throws(() => planChunks([{ big: 'x'.repeat(300) }], 50, 200), (e: unknown) => e instanceof UploadPrepareError && e.failure.kind === 'item_too_large');
  // A bad file is refused by path and reason before anything is sent.
  const bad = JSON.parse(raw) as Record<string, unknown>;
  bad.currency = 'USD';
  await assert.rejects(prepareUpload(new TextEncoder().encode(JSON.stringify(bad))), (e: unknown) => e instanceof UploadPrepareError && e.failure.kind === 'format' && e.failure.reason === 'currency_mismatch');
  // …and the owner reads the reason in his own language, never the parser's code.
  const refused = await prepareUpload(new TextEncoder().encode(JSON.stringify(bad))).then(
    () => null,
    (e: unknown) => e
  );
  for (const lang of LANGS) {
    const said = prepareFailureText(refused, lang);
    assert.ok(said.includes(STRINGS.FORMAT_REASON_LABELS.currency_mismatch[lang]), `${lang}: ${said}`);
    assert.equal(said.includes('currency_mismatch'), false, `${lang}: the raw code`);
  }
  assert.equal(STRINGS.formatReasonText('toString', 'en'), 'toString', 'only the parser’s own reasons are labels');
  await assert.rejects(prepareUpload(new Uint8Array([0xff, 0xfe, 0x00])), (e: unknown) => e instanceof UploadPrepareError && e.failure.kind === 'not_utf8');
  assert.equal(await sha256Hex(new TextEncoder().encode('abc')), createHash('sha256').update('abc').digest('hex'));
});

test('the upload run: create, every chunk in order with its offset, complete with the file’s counts and hash; a resume starts at the first unsent chunk', async () => {
  const raw = readFileSync(join(ROOT, 'tests/fixtures/supplierPrices/eu-2026-10-31.v1.json'), 'utf8');
  const prepared = await prepareUpload(new TextEncoder().encode(raw));
  const file = { ...prepared, chunks: planChunks(prepared.chunks.flatMap((c) => c.items), 1) };
  assert.ok(file.chunks.length >= 3, 'one item a chunk, to see the order');
  const calls: string[] = [];
  const stubs = {
    create: async (body: { file_sha256: string; item_count: number; source: string }) => {
      calls.push(`create ${body.source} ${body.item_count} ${body.file_sha256 === prepared.sha256}`);
      return { snapshot: { id: 'sps_1' } };
    },
    items: async (id: string, items: readonly unknown[], offset: number) => {
      calls.push(`items ${id} ${offset} ${items.length}`);
      if (offset === 1 && calls.filter((c) => c.startsWith('items')).length === 2 && fail) throw new Error('network');
      return {};
    },
    complete: async (id: string, body: { item_count: number; sku_count: number; file_sha256: string }) => {
      calls.push(`complete ${id} ${body.item_count} ${body.sku_count} ${body.file_sha256 === prepared.sha256}`);
      return {};
    },
  };
  let fail = true;
  const progress: number[] = [];
  await assert.rejects(sendUpload(file, stubs, { onProgress: (_id, n) => progress.push(n) }), /network/);
  assert.deepEqual(calls, [`create bambu_eu ${prepared.itemCount} true`, 'items sps_1 0 1', 'items sps_1 1 1']);
  assert.deepEqual(progress, [0, 1]);
  // Resumed at its first unsent chunk, on the same snapshot: nothing is created twice.
  fail = false;
  calls.length = 0;
  assert.equal(await sendUpload(file, stubs, { snapshotId: 'sps_1', from: 1 }), 'sps_1');
  assert.deepEqual(calls, [...file.chunks.slice(1).map((c) => `items sps_1 ${c.offset} 1`), `complete sps_1 ${prepared.itemCount} ${prepared.skuCount} true`]);
  // «أوقف»: nothing more is sent, and the run says it was stopped.
  calls.length = 0;
  await assert.rejects(sendUpload(file, stubs, { snapshotId: 'sps_1', from: 0, shouldStop: () => calls.length >= 1 }), (e: unknown) => e instanceof RunStopped);
  assert.deepEqual(calls, ['items sps_1 0 1']);
});

test('matching and compute run page by page to the end; a page that resumes where it began stops the compute run', async () => {
  const pages = [
    { products: [{ product_id: 'a', confirmed: 2, suggested: 1, carried: 0, pruned: 0, missing: [], refused: [], skipped: null }], next_cursor: 'a' },
    { products: [{ product_id: 'b', confirmed: 0, suggested: 3, carried: 1, pruned: 0, missing: [{ combo_key: '', source: 'tmall_cn' as const, item_key: '1', sku_key: '2' }], refused: [], skipped: null }], next_cursor: null },
  ];
  const cursors: string[] = [];
  const totals = await matchAllPages(async ({ cursor }) => {
    cursors.push(cursor);
    return pages[cursors.length - 1]!;
  });
  assert.deepEqual(cursors, ['', 'a']);
  assert.deepEqual(totals, { products: 2, confirmed: 2, suggested: 4, missing: 1, stopped: false });
  const preview = (blocking: boolean) => ({ blocking }) as never;
  let calls = 0;
  const computed = await computeAllPages(async ({ cursor }) => {
    calls += 1;
    if (cursor === '') return { products: [preview(false), preview(true)], deferred: [], next_cursor: 'p2', spent: 0 };
    // The budget fits no product: the same cursor again, nothing computed — the run must not loop.
    return { products: [], deferred: ['p3'], next_cursor: 'p2', spent: 0 };
  });
  assert.deepEqual(computed, { n: 2, ready: 1, stopped: false });
  assert.equal(calls, 2);
});

test('the apply run: five products a call, the deferred ones sent again as the cursor, every outcome kept; a call that attempts nothing stops it', async () => {
  const items = Array.from({ length: 7 }, (_, i) => ({ product_id: `p${i}`, preview_hash: 'a'.repeat(64) }));
  const bodies: string[] = [];
  const done = await applyInPages(items, async (body) => {
    const sent = 'items' in body ? body.items : body.cursor;
    bodies.push(`${'items' in body ? 'items' : 'cursor'}:${sent.map((x) => x.product_id).join(',')}`);
    // The first call defers its last two products (the invocation budget).
    if (sent.length === 5) return { results: sent.slice(0, 3).map((x) => ({ product_id: x.product_id, outcome: 'applied' as const, preview: {} as never })), cursor: sent.slice(3), spent: 0 };
    return { results: sent.map((x) => ({ product_id: x.product_id, outcome: 'refused' as const, code: 'PRICING_PREVIEW_STALE' })), cursor: null, spent: 0 };
  });
  assert.deepEqual(bodies, ['items:p0,p1,p2,p3,p4', 'cursor:p3,p4', 'items:p5,p6']);
  assert.equal(done.size, 7);
  assert.equal(done.get('p0')!.outcome, 'applied');
  assert.equal(done.get('p6')!.outcome, 'refused');
  let n = 0;
  const stuck = await applyInPages(items.slice(0, 2), async (body) => {
    n += 1;
    const sent = 'items' in body ? body.items : body.cursor;
    return { results: [], cursor: sent, spent: 0 };
  });
  assert.equal(n, 1, 'a call that attempted nothing is not sent again forever');
  assert.equal(stuck.size, 0);
  assert.equal(APPLY_PAGE, 5);
});

test('the type editor sends only what the owner changed, figures as he typed them, an emptied one as null', () => {
  const t: EstimateType = {
    key: 'spare_part',
    name_ar: 'قطع غيار',
    name_en: 'Spare parts',
    name_ckb: 'پارچەی یەدەگ',
    sourcing: 'CHINA_CNY',
    route: 'sea',
    allow_air: true,
    us_reference_allowed: false,
    default_weight_g: null,
    default_length_mm: null,
    default_width_mm: null,
    default_height_mm: null,
    default_cbm: null,
    additional_cost_iqd: null,
    min_profit_usd: null,
    stale_after_days: 60,
    version: 4,
    updated_by: '',
    updated_at: '',
    warnings: [],
  };
  const base = { route: 'sea' as const, allow_air: true, us_reference_allowed: false, weight: '', length: '', width: '', height: '', cbm: '', additional: '', minProfit: '', staleDays: '60', name_ar: t.name_ar, name_en: t.name_en, name_ckb: t.name_ckb };
  assert.equal(typeUpdateOf(t, base, 'en').body, null, 'nothing changed: nothing sent');
  const typed = typeUpdateOf(t, { ...base, weight: '٢٥٠', length: '200', width: '200', height: '100', minProfit: '2.50', route: 'air' }, 'en');
  assert.deepEqual(typed.errors, {});
  assert.deepEqual(typed.body, { version: 4, route: 'air', default_weight_g: 250, default_length_mm: 200, default_width_mm: 200, default_height_mm: 100, min_profit_usd: '2.50' });
  assert.equal(typeof typed.body!.min_profit_usd, 'string', 'a decimal travels as text');
  const half = typeUpdateOf(t, { ...base, length: '200' }, 'en');
  assert.equal(half.body, null);
  assert.ok(half.errors.box);
  const cleared = typeUpdateOf({ ...t, default_weight_g: 1000, min_profit_usd: '3' }, { ...base, weight: '', minProfit: '' }, 'en');
  assert.deepEqual(cleared.body, { version: 4, default_weight_g: null, min_profit_usd: null });
  assert.ok(typeUpdateOf(t, { ...base, minProfit: '2,5' }, 'en').errors.minProfit, 'a decimal comma is refused, never guessed');
  assert.ok(typeUpdateOf(t, { ...base, name_ckb: t.name_ar }, 'en').errors.names, 'the Sorani name is never the Arabic');
  // The routes a type may take: the EU store by land, filament by sea, air only where allowed.
  assert.deepEqual(allowedRoutes({ key: 'printer', sourcing: 'EU_STORE_EUR' }, false), ['land']);
  assert.deepEqual(allowedRoutes({ key: 'filament', sourcing: 'CHINA_CNY' }, true), ['sea']);
  assert.deepEqual(allowedRoutes({ key: 'hotend', sourcing: 'CHINA_CNY' }, true), ['sea', 'air']);
  assert.deepEqual(allowedRoutes({ key: 'hotend', sourcing: 'CHINA_CNY' }, false), ['sea']);
});

test('bulk accept takes one high or medium suggestion per option and source, never over a confirmation or an ambiguity', () => {
  const s = (over: Partial<SupplierLink>) => link({ state: 'suggested', ...over });
  const p = product([
    { combo_key: 'a', labels: { ar: 'أ', en: 'A', ckb: 'ئا' }, supplier_prices: [s({ match_confidence: 'high' })] },
    { combo_key: 'b', labels: { ar: 'ب', en: 'B', ckb: 'بێ' }, supplier_prices: [s({ match_confidence: 'medium', sku_key: '2' })] },
    { combo_key: 'c', labels: { ar: 'ج', en: 'C', ckb: 'جێ' }, supplier_prices: [s({ match_confidence: 'low' })] },
    { combo_key: 'd', labels: { ar: 'د', en: 'D', ckb: 'دێ' }, supplier_prices: [link({ state: 'auto' }), s({ match_confidence: 'high', sku_key: '9' })] },
    { combo_key: 'e', labels: { ar: 'ه', en: 'E', ckb: 'هێ' }, supplier_prices: [s({ match_confidence: 'high', sku_key: '7' }), s({ match_confidence: 'high', sku_key: '8' })] },
    { combo_key: 'f', labels: { ar: 'و', en: 'F', ckb: 'ڤ' }, supplier_prices: [link({ state: 'manual', source: 'typed', item_key: null, sku_key: null })] },
  ]);
  assert.deepEqual(bulkAcceptable(p), [
    { combo_key: 'a', source: 'tmall_cn', item_key: TMALL_ITEM, sku_key: TMALL_SKU },
    { combo_key: 'b', source: 'tmall_cn', item_key: TMALL_ITEM, sku_key: '2' },
  ]);
});

test('apply outcomes are said in the owner’s words; a stale hash and a large change each say what to do — and none offers a sign-in (DECISIONS row 285)', () => {
  for (const lang of LANGS) {
    assert.equal(outcomeText({ product_id: 'p', outcome: 'applied', preview: {} as never }, lang).tone, 'success');
    assert.equal(outcomeText({ product_id: 'p', outcome: 'refused', code: 'PRICING_PREVIEW_STALE' }, lang).text, say(STRINGS.OUTCOMES.stale, lang));
    assert.equal(outcomeText({ product_id: 'p', outcome: 'refused', code: 'PRICING_LARGE_CHANGE_CONFIRM' }, lang).text, say(STRINGS.OUTCOMES.needsTick, lang));
    // An older Worker's REAUTH_REQUIRED reads in the shared contract's words; the workspace has no sign-in of its own.
    const old = outcomeText({ product_id: 'p', outcome: 'refused', code: 'REAUTH_REQUIRED' }, lang);
    assert.ok(old.text.includes(COST_REFUSALS.REAUTH_REQUIRED[lang]), old.text);
    assert.deepEqual(Object.keys(old).sort(), ['text', 'tone']);
    const flags = outcomeText({ product_id: 'p', outcome: 'refused', code: 'PRICE_ESTIMATE_NOT_ELIGIBLE', details: { flags: ['EST_NO_PRICE'] } }, lang).text;
    assert.ok(flags.includes(FLAG_LABELS.EST_NO_PRICE[lang]), flags);
  }
});

test('a flag names the fields it is about in the pricing screens’ own words — the minimum profit as theirs — and an unknown name is left out', () => {
  const flags = [
    { code: 'EST_STRUCTURE_OWNER', combo_keys: ['c:a', 'c:b'], fields: ['shipping_profile'] },
    { code: 'EST_TYPE_INCOMPLETE', fields: ['minimum_profit', 'shipping_weight_g', 'no_such_field'] },
    { code: 'EST_OWNER_EDITED', fields: ['no_such_field', 'toString'] },
    { code: 'EST_NO_PRICE', combo_keys: ['c:a'] },
  ];
  const L = PRICING_FIELD_LABELS;
  for (const lang of LANGS) {
    const html = renderToStaticMarkup(createElement(FlagList, { flags, lang }));
    const item = (code: string) => html.split('<li ').find((s) => s.startsWith(`data-flag-code="${code}"`)) ?? '';
    // The stock route the money-1 block names, with the options it holds.
    assert.ok(text(item('EST_STRUCTURE_OWNER')).includes(`${FLAG_LABELS.EST_STRUCTURE_OWNER[lang]} (${L.shipping_profile[lang]}) ${say(STRINGS.FLAG_SKUS, lang, { n: 2 })}`), `${lang}: ${text(item('EST_STRUCTURE_OWNER'))}`);
    assert.ok(text(item('EST_TYPE_INCOMPLETE')).includes(`(${L.target_profit_iqd[lang]} · ${L.shipping_weight_g[lang]})`), lang);
    // No known field left, or none named: nothing more is drawn.
    for (const code of ['EST_OWNER_EDITED', 'EST_NO_PRICE']) assert.doesNotMatch(item(code), /data-flag-fields/, `${lang}: ${code}`);
    assert.equal((html.match(/data-flag-fields/g) ?? []).length, 2);
  }
  assert.deepEqual(flagFieldNames(['minimum_profit', 'shipping_box', 'shipping_box', '__proto__', 'hasOwnProperty'], 'ckb'), [L.target_profit_iqd.ckb, L.shipping_box.ckb]);
  assert.deepEqual(flagFieldNames(undefined, 'ar'), []);
  // A refresh's flag whose options were counted to fit the column says how many, its fields kept.
  for (const lang of LANGS) {
    const html = renderToStaticMarkup(createElement(FlagList, { flags: [{ code: 'EST_STRUCTURE_OWNER', count: 20, fields: ['shipping_profile'] }], lang }));
    assert.ok(text(html).includes(`(${L.shipping_profile[lang]}) ${say(STRINGS.FLAG_SKUS, lang, { n: 20 })}`), `${lang}: ${text(html)}`);
  }
});

test('«تأكيد السعر» refused while the real measures wait on the refresh’s apply: the owner is told to apply it in «التحديث» first; any other refusal on default measures keeps the contract’s words', () => {
  const waiting = new ApiError(409, 'x', 'PRICE_ESTIMATE_DEFAULT_MEASURES', { combo_keys: ['c:b'], waiting_on_apply: true });
  for (const lang of LANGS) {
    assert.equal(refusalText(waiting, lang), say(STRINGS.CONFIRM.applyFirst, lang));
    for (const other of [
      new ApiError(409, 'x', 'PRICE_ESTIMATE_DEFAULT_MEASURES', { combo_keys: ['c:b'] }),
      new ApiError(409, 'x', 'PRICE_ESTIMATE_DEFAULT_MEASURES', { combo_keys: ['c:b'], waiting_on_apply: 'yes' }),
      new ApiError(409, 'x', 'PRICE_ESTIMATE_DEFAULT_MEASURES'),
      { code: 'PRICE_ESTIMATE_DEFAULT_MEASURES', details: { waiting_on_apply: true } },
    ]) {
      assert.equal(refusalText(other, lang), ESTIMATE_REFUSALS.PRICE_ESTIMATE_DEFAULT_MEASURES[lang], lang);
    }
    assert.equal(refusalText(new ApiError(409, 'x', 'PRICE_ESTIMATE_FLAGS_OPEN', { waiting_on_apply: true }), lang), ESTIMATE_REFUSALS.PRICE_ESTIMATE_FLAGS_OPEN[lang], 'that refusal only');
  }
  // The words name the tab the apply is offered in, in each language.
  for (const lang of LANGS) assert.ok(say(STRINGS.CONFIRM.applyFirst, lang).includes(say(STRINGS.TAB_LABELS.refresh, lang)), lang);
});

test('«التحديث» shows where the refresh’s lines take their supplier prices from beside the row’s flags; every other list shows the row’s as they are', () => {
  const line = (combo_key: string, flags: string[]): EstimateLine => ({
    combo_key, channel: 'pre_order_land', source: 'bambu_us', supplier_amount: '10', supplier_currency: 'USD', measure_source: 'product', flags, est_cost_iqd: 1, est_price_iqd: 3, published_price_iqd: 2, change_pct: '50.00', large: true,
  });
  // A US-priced refresh over an EU-applied estimate: its US reference shows for the product, with its options.
  const usOverEu = { flags: [{ code: 'EST_SNAPSHOT_STALE', combo_keys: ['o:a'] }], lines: [line('o:a', ['EST_US_REFERENCE']), line('o:b', ['EST_UNITS_DIVIDED', 'EST_US_REFERENCE'])] };
  assert.deepEqual(rowFlags(usOverEu, 'refresh'), [
    { code: 'EST_SNAPSHOT_STALE', combo_keys: ['o:a'] },
    { code: 'EST_UNITS_DIVIDED', combo_keys: ['o:b'] },
    { code: 'EST_US_REFERENCE', combo_keys: ['o:a', 'o:b'] },
  ]);
  // An EU refresh over a US-applied estimate: the published estimate's reference stays, as customers pay it.
  const euOverUs = { flags: [{ code: 'EST_US_REFERENCE', combo_keys: ['o:a'] }], lines: [line('o:a', [])] };
  assert.equal(rowFlags(euOverUs, 'refresh'), euOverUs.flags);
  // A typed price joins the row's own entry; one naming no option is the product's already.
  assert.deepEqual(rowFlags({ flags: [{ code: 'EST_MANUAL_PRICE', combo_keys: ['o:b'] }], lines: [line('o:a', ['EST_MANUAL_PRICE'])] }, 'refresh'), [{ code: 'EST_MANUAL_PRICE', combo_keys: ['o:a', 'o:b'] }]);
  assert.deepEqual(rowFlags({ flags: [{ code: 'EST_STORE_PAGE_PRICE' }], lines: [line('o:a', ['EST_STORE_PAGE_PRICE'])] }, 'refresh'), [{ code: 'EST_STORE_PAGE_PRICE' }]);
  // Only the price sources: the default measures and the catalogue's words are the server's to show.
  assert.deepEqual(rowFlags({ flags: [], lines: [line('o:a', ['EST_DEFAULT_BOX', 'EST_SNAPSHOT_STALE'])] }, 'refresh'), []);
  for (const mode of ['ready', 'estimated', 'flags'] as const) assert.equal(rowFlags(usOverEu, mode), usOverEu.flags, mode);
  // The row draws them, and nothing else draws the row's flags.
  const code = codeOf(`${DIR}/EstimateLists.tsx`);
  assert.match(code, /const flags = useMemo\(\(\) => rowFlags\(r, mode\), \[r, mode\]\);/);
  assert.match(code, /\{flags\.length \? <FlagList flags=\{flags\} lang=\{lang\} \/> :/);
  assert.doesNotMatch(code, /flags=\{r\.flags\}/);
});

test('«التحديث» says when no price moves: the row is there because its apply takes the real measures in', () => {
  const at = (est: number | null, published: number | null) => ({ est_price_iqd: est, published_price_iqd: published });
  assert.equal(refreshKeepsPrices([at(20_500, 20_500), at(14_000, 14_000)]), true);
  assert.equal(refreshKeepsPrices([at(null, null)]), true, 'as the server compares (IS NOT)');
  assert.equal(refreshKeepsPrices([at(20_500, 20_500), at(20_250, 20_500)]), false);
  assert.equal(refreshKeepsPrices([at(20_500, null)]), false);
  assert.equal(refreshKeepsPrices([]), false);
  for (const lang of LANGS) {
    const s = say(STRINGS.LISTS.refreshMeasuresOnly, lang);
    assert.ok(s.length > 0 && s !== say(STRINGS.LISTS.refreshIntro, lang), lang);
  }
  // Drawn in «التحديث» only, under the row's flags.
  const code = codeOf(`${DIR}/EstimateLists.tsx`);
  assert.match(code, /\{mode === 'refresh' && refreshKeepsPrices\(r\.lines\) \? \(\s*<p [^>]*data-estimate-measures-only>\s*\{say\(LISTS\.refreshMeasuresOnly, lang\)\}/);
  assert.equal((code.match(/LISTS\.refreshMeasuresOnly/g) ?? []).length, 1);
});

test('«تأكيد السعر» asks of the options it confirms what the server asks: their default measures, their soft flags, and the codes the server names', () => {
  const line = (combo_key: string, measure_source: EstimateLine['measure_source'], flags: string[] = []): EstimateLine => ({
    combo_key, channel: 'pre_order_sea', source: 'tmall_cn', supplier_amount: '69', supplier_currency: 'CNY', measure_source, flags, est_cost_iqd: 1, est_price_iqd: 2, published_price_iqd: 2, change_pct: null, large: false,
  });
  const est = (flags: StoredEstimate['flags'], lines: EstimateLine[]) => ({ flags, lines });
  const some = (...keys: string[]) => new Set(keys);
  // Red has its own package; black is on the type's defaults and was typed by the owner.
  const mixed = est(
    [
      { code: 'EST_DEFAULT_BOX', combo_keys: ['c:b'] },
      { code: 'EST_DEFAULT_WEIGHT', combo_keys: ['c:b'] },
      { code: 'EST_MANUAL_PRICE', combo_keys: ['c:b'] },
      { code: 'EST_SNAPSHOT_STALE', combo_keys: ['c:r'] },
      { code: 'EST_OWNER_EDITED', fields: ['shipping_weight_g'] },
    ],
    [line('c:b', 'type_default', ['EST_DEFAULT_BOX', 'EST_DEFAULT_WEIGHT', 'EST_MANUAL_PRICE']), line('c:r', 'colour', ['EST_SNAPSHOT_STALE'])]
  );
  assert.deepEqual(confirmGate(mixed, null), { hard: true, soft: ['EST_MANUAL_PRICE', 'EST_SNAPSHOT_STALE'] });
  assert.deepEqual(confirmGate(mixed, some('c:r')), { hard: false, soft: ['EST_SNAPSHOT_STALE'] });
  assert.deepEqual(confirmGate(mixed, some('c:b')), { hard: true, soft: ['EST_MANUAL_PRICE'] });
  assert.deepEqual(confirmGate(mixed, some()), { hard: false, soft: [] });
  // A flag whose SKUs were counted away (too long for its column) is the product's: it touches every option.
  const counted = est([{ code: 'EST_US_REFERENCE', count: 40 }], [line('c:r', 'colour')]);
  assert.deepEqual(confirmGate(counted, some('c:r')).soft, ['EST_US_REFERENCE']);
  // The default measures are read from the lines (the latest compute); with no line at all, from the stored flags.
  assert.equal(confirmGate(est([{ code: 'EST_DEFAULT_WEIGHT', combo_keys: ['c:b'] }], [line('c:b', 'owner')]), null).hard, false);
  assert.equal(confirmGate(est([{ code: 'EST_DEFAULT_WEIGHT', count: 3 }], []), some('c:r')).hard, true);
  assert.equal(confirmGate(est([{ code: 'EST_DEFAULT_WEIGHT', combo_keys: ['c:b'] }], []), some('c:r')).hard, false);
  // The codes a refusal named join the list once.
  assert.deepEqual(confirmGate(mixed, some('c:r'), ['EST_SUPPLIER_OUT_OF_STOCK', 'EST_SNAPSHOT_STALE']).soft, ['EST_SNAPSHOT_STALE', 'EST_SUPPLIER_OUT_OF_STOCK']);

  // Only a PRICE_ESTIMATE_FLAGS_OPEN refusal names codes to accept, and only soft ones.
  assert.deepEqual(openFlagsOf(new ApiError(409, 'x', 'PRICE_ESTIMATE_FLAGS_OPEN', { flags: ['EST_SNAPSHOT_STALE', 'EST_DEFAULT_BOX', 7] })), ['EST_SNAPSHOT_STALE']);
  assert.deepEqual(openFlagsOf(new ApiError(409, 'x', 'PRICE_ESTIMATE_DEFAULT_MEASURES', { combo_keys: ['c:b'] })), []);
  assert.deepEqual(openFlagsOf(new ApiError(409, 'x', 'PRICE_ESTIMATE_FLAGS_OPEN')), []);
  assert.deepEqual(openFlagsOf(new Error('PRICE_ESTIMATE_FLAGS_OPEN')), []);

  // The sheet asks the soft flags of that gate, and holds on the measures through `measureHold` — the server's live
  // gate first, these lines only for an older server — for the scope and the options ticked. Its submit is never
  // silently disabled: a press that cannot go says what to do (`confirmHint`).
  const sheet = codeOf(`${DIR}/ConfirmSheet.tsx`);
  assert.match(sheet, /const chosen = scope === 'some' \? skus : null;\s*const \{ soft \} = confirmGate\(now, chosen, named\);\s*const hold = measureHold\(now, chosen\);/);
  assert.doesNotMatch(sheet, /disabled=\{hard\}/);
  assert.match(sheet, /disabled=\{!view && !!failure\}/, 'held only while there is nothing read, the failure said beside it');
  assert.match(sheet, /\{hold\.hard \? \(\s*<MeasuresHold/);
  assert.match(sheet, /const more = openFlagsOf\(e\);/);
});

test('«تأكيد السعر» keeps the codes a refusal named for the options it was sent for, across scope and ticks', () => {
  const line = (combo_key: string): EstimateLine => ({
    combo_key, channel: 'pre_order_sea', source: 'tmall_cn', supplier_amount: '69', supplier_currency: 'CNY', measure_source: 'colour', flags: [], est_cost_iqd: 1, est_price_iqd: 2, published_price_iqd: 2, change_pct: null, large: false,
  });
  const est = { flags: [], lines: [line('c:r'), line('c:b'), line('c:g')] };
  const some = (...keys: string[]) => new Set(keys);
  // Red alone was refused on its stock: the code returns whenever red is ticked again, and never asks of black alone.
  const red = withNamed([], ['EST_SUPPLIER_OUT_OF_STOCK'], ['c:r']);
  assert.deepEqual(red, [{ code: 'EST_SUPPLIER_OUT_OF_STOCK', combo_keys: ['c:r'] }]);
  assert.deepEqual(confirmGate(est, some('c:b')).soft, []);
  assert.deepEqual(confirmGate(est, some('c:b'), red).soft, []);
  assert.deepEqual(confirmGate(est, some('c:r', 'c:b'), red).soft, ['EST_SUPPLIER_OUT_OF_STOCK']);
  assert.deepEqual(confirmGate(est, null, red).soft, ['EST_SUPPLIER_OUT_OF_STOCK'], 'the whole product includes red');
  // Named again for black and green: the options join; for the whole product: the product's, and it stays so.
  const both = withNamed(red, ['EST_SUPPLIER_OUT_OF_STOCK', 'EST_SNAPSHOT_STALE'], ['c:g', 'c:b']);
  assert.deepEqual(both, [
    { code: 'EST_SUPPLIER_OUT_OF_STOCK', combo_keys: ['c:b', 'c:g', 'c:r'] },
    { code: 'EST_SNAPSHOT_STALE', combo_keys: ['c:b', 'c:g'] },
  ]);
  assert.deepEqual(confirmGate(est, some('c:r'), both).soft, ['EST_SUPPLIER_OUT_OF_STOCK']);
  const whole = withNamed(both, ['EST_SNAPSHOT_STALE'], null);
  assert.deepEqual(whole[1], { code: 'EST_SNAPSHOT_STALE' });
  assert.deepEqual(withNamed(whole, ['EST_SNAPSHOT_STALE'], ['c:r'])[1], { code: 'EST_SNAPSHOT_STALE' });
  assert.deepEqual(confirmGate(est, some('c:r'), whole).soft, ['EST_SUPPLIER_OUT_OF_STOCK', 'EST_SNAPSHOT_STALE']);
  // A named code is asked only when it is soft, as the server's list is.
  assert.deepEqual(confirmGate(est, null, [{ code: 'EST_DEFAULT_BOX' }, { code: 'EST_OWNER_EDITED' }]).soft, []);

  // The sheet keeps them until it opens on another estimate: neither the scope nor a tick drops them.
  const sheet = codeOf(`${DIR}/ConfirmSheet.tsx`);
  assert.equal((sheet.match(/setNamed\(/g) ?? []).length, 2, 'reset when the estimate changes, added to on a refusal');
  assert.match(sheet, /setNamed\(\[\]\);/);
  assert.match(sheet, /setNamed\(\(s\) => withNamed\(s, more, sent\)\)/);
  assert.match(sheet, /const sent = scope === 'some' \? \[\.\.\.skus\] : null;/);
  assert.match(sheet, /\.\.\.\(sent \? \{ combo_keys: sent \} : \{\}\)/);
});

test('the address opens the workspace on a tab and a product; anything else opens the links', () => {
  assert.deepEqual(readWorkspaceAddress('?tab=pricing&view=estimates&etab=review&product=prod_1'), { tab: 'review', product: 'prod_1' });
  assert.deepEqual(readWorkspaceAddress('?etab=nope&product=bad%20id'), { tab: 'links', product: null });
  assert.equal(workspaceHref('links', 'prod_1'), '/admin?tab=pricing&view=estimates&etab=links&product=prod_1');
  assert.equal(workspaceHref('types'), '/admin?tab=pricing&view=estimates&etab=types');
});

test('the banner’s summary: the sources an estimate prices from, each with the capture date its links carry', () => {
  const p = product([{ combo_key: '', labels: { ar: '', en: '', ckb: '' }, supplier_prices: [link()] }]);
  const line = { combo_key: '', channel: 'pre_order_sea', source: 'tmall_cn' as const, supplier_amount: '40', supplier_currency: 'CNY' as const, measure_source: 'type_default' as const, flags: [], est_cost_iqd: 1, est_price_iqd: 2, published_price_iqd: 2, change_pct: null, large: false };
  const est = { product_id: 'prod_drill', name: 'x', slug: 'x', label: true, state: 'estimated' as const, type: 'accessory', type_source: 'import_type', sourcing_override: null, route_override: null, measure_basis: 'type_default', flags: [{ code: 'EST_DEFAULT_WEIGHT' }], preview_hash: null, computed_at: null, applied_at: null, confirmed_at: null, version: 2, lines: [line] };
  assert.deepEqual(sourceDates(est, p), [{ source: 'tmall_cn', date: '2026-10-31' }]);
  assert.deepEqual(sourceDates(null, p), []);
});

// ---------------------------------------------------------------- the owner's statement of real measures (§4.9 step 0; row 292)

/** A product on its type's defaults, as `GET /estimates/products/:id` answers it, with the server's live gate (null: an older server). */
const gated = (gate: Partial<ConfirmGate> | null, lines: readonly string[] = ['']) => ({
  flags: [
    { code: 'EST_DEFAULT_BOX', combo_keys: [...lines] },
    { code: 'EST_DEFAULT_WEIGHT', combo_keys: [...lines] },
  ],
  lines: lines.map(
    (combo_key): EstimateLine => ({
      combo_key,
      channel: 'pre_order_sea',
      source: 'tmall_cn',
      supplier_amount: '52.5',
      supplier_currency: 'CNY',
      measure_source: 'type_default',
      flags: ['EST_DEFAULT_BOX', 'EST_DEFAULT_WEIGHT'],
      est_cost_iqd: 1,
      est_price_iqd: 2,
      published_price_iqd: 2,
      change_pct: null,
      large: false,
    })
  ),
  confirm_gate:
    gate === null
      ? undefined
      : {
          defaulted: [...lines],
          waiting_on_apply: false,
          waiting_keys: [],
          real_measures: { weight_g: 100, box_mm: [160, 110, 30] as [number, number, number], combo_keys: [...lines] },
          blocked: null,
          ...gate,
        },
});

test('the measures are shown as the pricing form shows them — kg and cm, exact, never through a float', () => {
  assert.equal(kgText(100), '0.1');
  assert.equal(kgText(1250), '1.25');
  assert.equal(kgText(1000), '1');
  assert.equal(kgText(5), '0.005');
  assert.equal(kgText(1300), '1.3');
  assert.equal(cmText(160), '16');
  assert.equal(cmText(165), '16.5');
  assert.equal(cmText(3), '0.3');
  // Where a binary float would print 0.30000000000000004 or 100.29999999999998, the text is the integer's own.
  assert.equal(kgText(300), '0.3');
  assert.equal(cmText(1003), '100.3');
  for (const bad of [-1, 1.5, Number.NaN]) assert.equal(kgText(bad), '—');
});

test('«تأكيد السعر» on default measures: the live gate first, the values with their tick, the statement sent exactly as answered and only once ticked — never a silently disabled submit', () => {
  const hold = measureHold(gated({}), null);
  assert.deepEqual(hold, { hard: true, live: true, statement: { weight_g: 100, box_mm: [160, 110, 30] }, reason: null });
  const ask = (h: MeasureHold, ticked: boolean, extra: Partial<Parameters<typeof confirmHint>[0]> = {}) =>
    confirmHint({ scope: 'whole', skus: new Set(), soft: [], accepted: new Set(), hold: h, ticked, ...extra });
  // Not ticked: the press says what to do and sends nothing; ticked, it sends the values exactly as the server answered them.
  assert.equal(ask(hold, false), 'attestFirst');
  assert.equal(statementOf(hold, false), undefined);
  assert.equal(ask(hold, true), null);
  assert.deepEqual(statementOf(hold, true), { weight_g: 100, box_mm: [160, 110, 30] });
  // Only the measures the gate offers: a box that is real already is never stated.
  assert.deepEqual(statementOf(measureHold(gated({ real_measures: { weight_g: 100, box_mm: null, combo_keys: [''] } }), null), true), { weight_g: 100 });
  // The soft flags still come after the measures, and the options must be chosen first.
  assert.equal(ask(hold, true, { soft: ['EST_MANUAL_PRICE'] }), 'acceptAllFirst');
  assert.equal(ask(hold, true, { scope: 'some' }), 'pickSkus');
  // Held with nothing to state: the reason, never a request — and nothing is stated even if a tick lingered.
  for (const reason of ['type_cbm', 'package_differs', 'package_partial', 'below_net'] as const) {
    const blocked = measureHold(gated({ real_measures: null, blocked: reason }), null);
    assert.deepEqual([blocked.hard, blocked.reason, ask(blocked, true), statementOf(blocked, true)], [true, reason, 'blocked', undefined], reason);
  }
  // Real measures waiting on the refresh's apply, option by option.
  const waiting = gated({ real_measures: null, blocked: 'package_differs', waiting_keys: ['c:b'], defaulted: ['c:b', 'c:r'] }, ['c:b', 'c:r']);
  assert.equal(measureHold(waiting, new Set(['c:b'])).reason, 'waiting');
  assert.equal(measureHold(waiting, null).reason, 'package_differs', 'red does not wait');
  // Options the gate does not hold are free, whatever their (older) lines say; with no gate the lines say it, and the press goes to the server.
  assert.equal(measureHold(gated({ defaulted: ['c:b'], real_measures: null, blocked: 'type_cbm' }, ['c:b', 'c:r']), new Set(['c:r'])).hard, false);
  const old = measureHold(gated(null), null);
  assert.deepEqual(old, { hard: true, live: false, statement: null, reason: null });
  assert.equal(ask(old, false), null, 'an older server judges the press itself');
  assert.equal(statementOf(old, true), undefined, 'and is never sent a field it would refuse');
  // A statement covers only the options it makes real: an option on the type's CBM is held with its reason.
  const mixed = gated({ defaulted: ['c:b', 'c:r'], real_measures: { weight_g: 100, box_mm: null, combo_keys: ['c:r'] }, blocked: 'type_cbm' }, ['c:b', 'c:r']);
  assert.deepEqual(measureHold(mixed, new Set(['c:r'])).statement, { weight_g: 100, box_mm: null });
  assert.equal(measureHold(mixed, null).reason, 'type_cbm');

  // The sheet: read on open and on every stale answer (PRICING_CHANGED through useAct's onStale, a compute, a refusal on the measures).
  const sheet = codeOf(`${DIR}/ConfirmSheet.tsx`);
  assert.match(sheet, /const stale = useCallback\(\(\) => \{\s*setReads\(\(n\) => n \+ 1\);\s*onStale\?\.\(\);\s*\}, \[onStale\]\);\s*const act = useAct\(lang, stale\);/);
  assert.match(sheet, /fetchEstimate\(productId, \{ signal: ac\.signal, mascot: 'silent' \}\)[\s\S]*?\}, \[open, productId, reads\]\);/);
  assert.match(sheet, /if \(errorCode\(e\) === 'PRICE_ESTIMATE_DEFAULT_MEASURES'\) stale\(\);/);
  assert.match(sheet, /const why = confirmHint\(\{ scope, skus, soft, accepted, hold, ticked: attested \}\);\s*if \(why\) \{\s*setHint\(/);
  assert.match(sheet, /\.\.\.\(real_measures \? \{ real_measures \} : \{\}\)/);
  // The tick is bound to the values shown: a read that shows other values leaves it unticked.
  assert.match(sheet, /const attested = statementKey !== null && ticked === statementKey;/);
  // After a statement the product form reads the product again, handed the values stated (its guard if that read fails).
  assert.match(sheet, /if \(real_measures\) onProductChanged\?\.\(real_measures\);/);
});

test('the measures part of the sheet, in three languages: the values with their units and the tick; each reason with the way to its cure', () => {
  const html = (h: MeasureHold, lang: UiLang, ways: { dims?: boolean; cost?: boolean; compute?: boolean } = {}) =>
    renderToStaticMarkup(
      createElement(MeasuresHold, {
        hold: h,
        lang,
        productId: 'p_cut',
        ticked: false,
        onTick: () => {},
        ...(ways.dims ? { onOpenDimensions: () => {} } : {}),
        ...(ways.cost ? { onOpenCost: () => {} } : {}),
        ...(ways.compute ? { onCompute: () => {} } : {}),
      })
    );
  const hrefs = (s: string) => anchors(s).map((a) => attr(a, 'href'));
  const goes = (s: string) => [...s.matchAll(/data-confirm-go="([a-z]+)"/g)].map((m) => m[1]);
  for (const lang of LANGS) {
    const statement = html(measureHold(gated({}), null), lang);
    const t = text(statement);
    assert.match(statement, /data-confirm-measures/);
    assert.match(statement, /<input[^>]*data-confirm-attest/);
    assert.ok(t.includes(`${say(STRINGS.CONFIRM.weight, lang)}: 0.1 ${say(STRINGS.CONFIRM.kg, lang)}`), `${lang}: ${t}`);
    assert.ok(t.includes(`${say(STRINGS.CONFIRM.box, lang)}: 16 × 11 × 3 ${say(STRINGS.CONFIRM.cm, lang)}`), `${lang}: ${t}`);
    for (const k of ['hardOpen', 'measuresTitle', 'fromType', 'attest', 'attestHint', 'notThese', 'enterInCost'] as const) assert.ok(t.includes(say(STRINGS.CONFIRM[k], lang)), `${lang}: ${k}`);
    // The figures are LTR islands; the units are read in the reader's language.
    assert.match(statement, /<bdi dir="ltr"[^>]*>16 × 11 × 3<\/bdi>/);
    // The workspace links the editor's sections; the product form opens its own.
    assert.deepEqual(hrefs(statement), ['/admin?tab=products&edit=p_cut&section=3', '/admin?tab=products&edit=p_cut&section=4']);
    const inForm = html(measureHold(gated({}), null), lang, { dims: true, cost: true });
    assert.deepEqual([hrefs(inForm), goes(inForm)], [[], ['cost', 'dimensions']]);

    // Each reason: its words, and the way to its cure.
    const blocked = (reason: ConfirmGate['blocked'], extra: Partial<ConfirmGate> = {}) => measureHold(gated({ real_measures: null, blocked: reason, ...extra }), null);
    const cases: Array<[MeasureHold, string, string[]]> = [
      [blocked('type_cbm'), say(STRINGS.CONFIRM.typeCbm, lang), ['dimensions', 'compute', 'refresh']],
      [blocked('package_differs'), say(STRINGS.CONFIRM.packageDiffers, lang), ['compute', 'refresh']],
      [blocked('package_partial'), say(STRINGS.CONFIRM.packagePartial, lang), ['dimensions']],
      // The type's weight is lighter than the product itself: a real weight in the cost card, or the net weight corrected.
      [blocked('below_net'), say(STRINGS.CONFIRM.belowNet, lang), ['cost', 'dimensions']],
      [blocked('package_differs', { waiting_keys: [''] }), say(STRINGS.CONFIRM.applyFirst, lang), ['refresh']],
      [measureHold(gated(null), null), say(STRINGS.CONFIRM.hardLines, lang), ['cost', 'dimensions']],
    ];
    for (const [h, words, ways] of cases) {
      const s = html(h, lang, { dims: true, cost: true, compute: true });
      assert.ok(text(s).includes(words), `${lang} ${h.reason}`);
      assert.equal(holdText(h, lang), words);
      assert.deepEqual(goes(s), ways, `${lang} ${h.reason}`);
      assert.doesNotMatch(s, /data-confirm-attest/, 'nothing to tick');
    }
    // «التحديث» is the workspace's own tab, on this product.
    assert.deepEqual(hrefs(html(blocked('package_differs', { waiting_keys: [''] }), lang)), ['/admin?tab=pricing&view=estimates&etab=refresh&product=p_cut']);
  }
});

test('the confirmation’s ways in: the product form reads the product again keeping every edit after a statement, opens «الأبعاد والوزن» and the cost weight in place; the workspace links the editor', () => {
  // ProductForm never reaches the workspace (test 1): it hands callbacks down through section ٣.
  const form = codeOf('src/components/adminProducts/ProductForm.tsx');
  assert.match(form, /onProductChanged=\{afterEstimateMeasures\}\s*onOpenDimensions=\{showPackageMeasures\}\s*onOpenCost=\{showCostWeight\}/);
  // After a statement: a background read, never the spinner nor its «رجوع»-only failure page; dropped when a newer
  // baseline came meanwhile; every unsaved edit laid back (`keepEdits`, dimensions field by field: priceEstimateAttest).
  const after = form.slice(form.indexOf('const afterEstimateMeasures = '), form.indexOf('const deepLinked = useRef(false);'));
  assert.ok(after.length > 0 && after.length < 2000, 'the handler is found');
  assert.match(after, /const afterEstimateMeasures = \(stated: StatedPackage\) => \{/);
  assert.match(after, /void readProduct\(id\)/);
  assert.doesNotMatch(after, /loadProduct\(|setLoading\(|reloadKeepingEdits\(/, 'loadProduct toggles `loading`, which unmounts the form');
  assert.match(after, /reloadIdRef\.current === id && baselineGeneration\.current === generation/);
  assert.match(after, /applyProduct\(read\);[\s\S]*setDoc\(\(d\) => keepEdits\(before\.d, mine, d\)\);/);
  assert.match(after, /if \(JSON\.stringify\(myRel\) !== JSON\.stringify\(before\.rs\)\) \{\s*setRel\(myRel\);/);
  // A read that fails keeps the form, the stated package laid in where its own is empty, and says so.
  assert.match(after, /\.catch\(\(\) => \{\s*if \(!current\(\)\) return;\s*setDoc\(\(d\) => \(\{ \.\.\.d, dimensions: withStatedPackage\(d\.dimensions, stated\) \}\)\);\s*setSaveNote\(saveOutcomeText\('measuresUnread', lang\)\);/);
  assert.match(form, /const showPackageMeasures = \(\) => \{\s*setOpen\(4\);[\s\S]{0,260}document\.querySelector<HTMLElement>\('\[data-package-measures\]'\)/);
  assert.match(form, /const showCostWeight = \(\) => \{\s*showPricing\(3\);[\s\S]{0,200}'\[data-v2-field="weight"\]'/);
  const prices = codeOf('src/components/adminProducts/form/v2/PricesSectionV2.tsx');
  assert.match(prices, /onProductChanged,\s*onOpenDimensions,\s*onOpenCost,\s*\}: \{/);
  // The banner reads again when the stored pricing moves, and hands the ways to the sheet.
  const banner = codeOf(`${DIR}/EstimateBanner.tsx`);
  assert.match(banner, /\}, \[productId, reload, revision\]\);/);
  assert.match(banner, /onStale=\{stale\}\s*onProductChanged=\{onProductChanged\}\s*onOpenDimensions=\{onOpenDimensions\}\s*onOpenCost=\{onOpenCost\}/);
  // The workspace's sheet tells its list when the server moved.
  assert.match(codeOf(`${DIR}/EstimateLists.tsx`), /onStale=\{\(\) => setReload\(\(n\) => n \+ 1\)\}/);
  // «الأبعاد والوزن»: the product's own «صندوق الشحن» block carries the anchor; a model's or colour's never does.
  const own = renderToStaticMarkup(createElement(DimensionsSection, { dimensions: emptyDimensions(), onChange: () => {} }));
  assert.equal((own.match(/data-package-measures/g) ?? []).length, 1);
  assert.match(own, /data-package-measures="">\s*<h4[^>]*>\s*صندوق الشحن/);
  const model = renderToStaticMarkup(createElement(DimensionsSection, { dimensions: emptyDimensions(), onChange: () => {}, collapsible: true }));
  assert.doesNotMatch(model, /data-package-measures/);
  // The workspace's links: section ٤ for the package, section ٣ for the cost.
  assert.equal(productDimensionsHref('p_1'), '/admin?tab=products&edit=p_1&section=4');
  assert.equal(productEditorHref('p_1'), '/admin?tab=products&edit=p_1&section=3');
  assert.equal(productDimensionsHref('bad id'), null);
});
