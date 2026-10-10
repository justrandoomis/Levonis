/**
 * THE WORDS OF THE «التسعير بالدولار والشحن» SAVE (owner report 2026-10-10; docs/DECISIONS.md row 213;
 * the verifiers' strings review): what the owner reads after each save is true, in ar, en and ckb.
 *
 *   S1 a stored («ready») review never says the held write's «this save completes the data … in the same step»
 *   S2 an engine product held after «نشر» says the product itself was saved
 *   S3 a refused confirm says what is true: data stored / product saved / nothing saved
 *   S4 ckb names "derived" with one word on the panel
 *   S5 en: no autosave wording
 *   S6 a saved outcome is said once in the panel
 *   S7 a decimal comma in the box / weight fields is read (and an unreadable number is said)
 *   S8 «{field}» never reaches the FX screen
 *
 * The review sheet is a portal (`Modal` → `createPortal(…, document.body)`): the
 * server renderer cannot draw a portal, so `createPortal` is replaced with the
 * identity BEFORE any module that imports react-dom is loaded (all project
 * imports below are dynamic for that reason). Nothing else is stubbed.
 *
 * Run: node --import tsx --test tests/usdPricingSaveStrings.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactElement } from 'react';

const ROOT = join(import.meta.dirname, '..');
const source = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

// The sheet is a portal: draw it in place (see the header).
const rd = createRequire(import.meta.url)('react-dom') as { createPortal: (n: unknown) => unknown };
rd.createPortal = (n: unknown) => n;
(globalThis as { document?: unknown }).document ??= { body: {} };

type Lang = 'ar' | 'en' | 'ckb';
const setLang = (lang: Lang) => {
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: () => lang, setItem: () => {}, removeItem: () => {} };
};

const mods = async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { LanguageProvider } = await import('../src/LanguageContext');
  const M = await import('../src/components/adminProducts/form/UsdPricingSection');
  const { USD_PRICING_FORM_STRINGS } = await import('../src/components/adminProducts/form/usdPricingStrings');
  const { ENGINE_SAVE_STRINGS } = await import('../src/components/adminOperations/engineSaveStrings');
  const { emptyDimensions } = await import('../src/lib/productTypes');
  const render = (lang: Lang, state: unknown, el: ReactElement) => {
    setLang(lang);
    return renderToStaticMarkup(createElement(LanguageProvider, { children: createElement(M.UsdPricingProvider, { value: state as never, children: el }) }));
  };
  return { createElement, M, S: USD_PRICING_FORM_STRINGS, ES: ENGINE_SAVE_STRINGS, emptyDimensions, render };
};

const text = (html: string) => html.replace(/<[^>]+>/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
const count = (hay: string, needle: string) => hay.split(needle).length - 1;

/** The panel state the form's hook would hold (the shape tests/productFormUsdPricing.test.ts uses). */
async function stateOf(over: Record<string, unknown> = {}, answerOver: Record<string, unknown> = {}) {
  const { emptyDimensions } = await mods();
  const dims = () => ({ ...emptyDimensions() });
  const inputs = { supplier_cost_amount: '899.5', supplier_cost_currency: 'USD', supplier_input_mode: null, original_input_amount: null, conversion_rate_snapshot: null, converted_at: null, shipping_profile: 'CHINA_SEA', shipping_weight_g: null, pricing_weight_g: null, shipping_length_mm: 600, shipping_width_mm: 520, shipping_height_mm: 480, manual_cbm: null, additional_cost_iqd: 15000, source_ref: 'owner' };
  const scope = (s: 'base' | 'option', id: string, pricing: unknown) => ({ scope: s, scope_id: id, name_ar: id ? 'U1' : '', name_en: id ? 'U1' : '', name_ckb: id ? 'U1' : '', pricing_inputs: pricing, minimum_target_profit_usd: '120', target_profit_iqd: null, target_profit_state: null, direct_sale_extra_iqd: 25000, direct_sale_extra_state: null });
  const summary = { state: 'blocked', issue_codes: ['FX_DERIVED_STALE'], shipping_profile: 'CHINA_SEA', profile_source: 'default', engine_priced: false, option_id: 'm1', rule_level: 'product', minimum_target_profit_usd: '120', target_profit_iqd: null, target_profit_cents: 12_000, current_total_cost_cents: null, final_price_cents: null, preorder_base_iqd: null, direct_sale_extra_iqd: 25_000, direct_sale_price_iqd: null, rounding_added_iqd: 0, supplier_original_amount: '899.5', supplier_original_currency: 'USD', iqd_converted: null, cross_rate: null, supplier_cost_usd: '899.5', supplier_cost_cents: 89_950, basis: 'cbm', effective_weight_g: null, effective_cbm: '0.14976', shipping_rate: null, shipping_cost_iqd: null, shipping_cost_usd: null, shipping_cost_cents: null, additional_cost_iqd: 15000, additional_cost_usd: null, additional_cost_cents: null, excluded_charges: [], current_total_cost_usd: null, final_price_usd: null, usd_iqd_rate: '1600', document_rate: null, store_price_iqd: 1_579_000 };
  const answer = { product_id: 'p1', mode: 'manual', inputs_seq: 3, rates: { usd_iqd_rate: '1600', review_pending: false, derived_stale: false }, scopes: [scope('base', '', inputs), scope('option', 'm1', null)], models: [{ option_id: 'm1', name_ar: 'U1', name_en: 'U1', name_ckb: 'U1', sells_direct: true, pricing_summary: summary }], rows: [], preview_hash: 'a'.repeat(64), ...answerOver };
  const form = { baseDimensions: dims(), optionDimensions: { m1: dims() }, savedBaseDimensions: dims(), savedOptionDimensions: { m1: dims() }, models: [{ id: 'm1', name_en: 'U1', name_ar: 'U1', name_ckb: 'U1', sells_direct: true }], productSellsDirect: true, setMeasure: () => {} };
  return {
    enabled: true, productId: 'p1', form, answer, shown: answer, drafts: {}, effective: {}, dirty: false, touched: false, invalid: false, invalidWhere: '',
    busy: false, saving: false, notInstalled: false, error: '', notice: '', outcome: null, serverField: null, rateKnownMissing: false, engine: false,
    setDraft: () => {}, discard: () => {}, save: async () => {}, reload: () => {}, snapshot: () => null, saveAfterProduct: async () => ({ ok: true, message: '' }),
    afterProductSaved: async () => {}, review: null, reviewBusy: false, confirmReview: async () => {}, cancelReview: () => {}, openReview: () => {}, exitEngine: async () => {},
    ...over,
  };
}

const ADOPT = { kind: 'adopt', complete: true, needs_write: true, large_change: false, rows: [], missing_codes: [] };

// ---------------------------------------------------------------------------------------------- 1

test('S1 the stored («ready») review sheet opens with «the data is already saved» — never the held write’s «saved … in the same step» (all three languages)', async () => {
  const { M, S, ES, createElement, render } = await mods();
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    // Exactly what readyReview() opens after a data-first save of a manual product (review.stored = true).
    const review = M.readyReview('p1', { product_id: 'p1', inputs_seq: 4, preview_hash: 'b'.repeat(64), adoption: ADOPT } as never)!;
    assert.equal(review.stored, true);
    const html = text(render(lang, await stateOf({ review }), createElement(M.UsdPricingSaveSheet)));
    assert.ok(html.includes(S[lang].sheetDataSaved), `${lang}: the sheet says the data is saved`);
    assert.ok(!html.includes(ES[lang].adoptIntro), `${lang}: never the held write’s intro beside it`);
    assert.equal(count(html, S[lang].sheetDataSaved), 1);
  }
});

// ---------------------------------------------------------------------------------------------- 2

test('S2 an ENGINE product held after «نشر»/«مسودة»: the sheet says the product itself was saved; held by «حفظ التسعير بالدولار» alone: nothing saved', async () => {
  const { M, S, createElement, render } = await mods();
  const { ApiError } = await import('../src/lib/api');
  const { ctx } = await import('./fixtures/app');
  const { pricingWorld } = await import('./fixtures/procurementPricing');
  const { SNAP } = await import('./fixtures/usdPricingSave');
  const w = pricingWorld();
  const io = {
    get: (p: string) => call('GET', p),
    post: (p: string, b: unknown) => call('POST', p, b),
    put: (p: string, b: unknown) => call('PUT', p, b),
  } as never;
  async function call(method: string, path: string, body?: unknown) {
    const res = await w.app.request(path, { method, headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, undefined, ctx);
    const out = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new ApiError(res.status, String(out.error ?? ''), out.code as string | undefined, out.details as Record<string, unknown> | undefined, out);
    return out;
  }
  // The owner's product, adopted by the engine (the same steps as tests/usdPricingCommit.test.ts).
  const drafts = { base: { supplier_cost_currency: 'USD', supplier_cost_amount: '899', shipping_profile: 'CHINA_SEA', box: [600, 520, 480] as [number, number, number], additional_cost_iqd: 15000, minimum_target_profit_usd: '120', direct_sale_extra_iqd: 25000 } };
  const first = await M.commitPricing(io, SNAP, drafts, {});
  assert.equal(first.kind, 'saved');
  const ready = first.kind === 'saved' ? first.ready! : null;
  await (io as { put: (p: string, b: unknown) => Promise<unknown> }).put(M.inputsPath(SNAP), { ...ready!.body, preview_hash: ready!.hash, confirm_large_change: true });
  // «نشر»: ProductForm POSTs the product, and ONLY after that succeeds calls saveAfterProduct → commitPricing (withProduct).
  const form = source('src/components/adminProducts/ProductForm.tsx');
  assert.ok(form.indexOf("'/api/admin/products-v2'") < form.indexOf('pricing.saveAfterProduct(savedId, pricingSnap)'), 'the pricing goes after the product save');
  assert.match(source('src/components/adminProducts/form/UsdPricingSection.tsx'), /commitPricing\(io, pid, snap\.drafts, \{ preview: snap\.preview, describe, seenRates: snap\.seenRates, withProduct: true \}\)/);
  const held = await M.commitPricing(io, SNAP, { base: { additional_cost_iqd: 40000 } }, { withProduct: true });
  assert.equal(held.kind, 'held');
  const review = held.kind === 'held' ? held.review : null;
  assert.equal(review!.stored, false);
  assert.equal(review!.withProduct, true);
  const alone = await M.commitPricing(io, SNAP, { base: { additional_cost_iqd: 40000 } }, {});
  const aloneReview = alone.kind === 'held' ? alone.review : null;
  assert.equal(aloneReview!.withProduct, undefined);
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const html = text(render(lang, await stateOf({ review, engine: true }), createElement(M.UsdPricingSaveSheet)));
    assert.ok(html.includes(S[lang].sheetProductSaved), `${lang}: after «نشر» the sheet says the product was saved`);
    assert.ok(!html.includes(S[lang].sheetNothingSaved), `${lang}: and never «nothing is saved»`);
    const htmlAlone = text(render(lang, await stateOf({ review: aloneReview, engine: true }), createElement(M.UsdPricingSaveSheet)));
    assert.ok(htmlAlone.includes(S[lang].sheetNothingSaved), `${lang}: «حفظ التسعير بالدولار» alone: nothing saved yet`);
  }
});

// ---------------------------------------------------------------------------------------------- 3

test('S3 a refused confirm says what is true: the data stored (not adopted), the product saved (pricing not), or nothing saved at all', async () => {
  const { S } = await mods();
  const section = source('src/components/adminProducts/form/UsdPricingSection.tsx');
  // The review records where it came from (the product's save, or the panel's own button).
  assert.match(section, /export interface PricingReview \{[\s\S]*?withProduct\?: boolean;\n\}/);
  assert.match(section, /text: held\.stored \? s\.adoptNotDone\(m\) : held\.withProduct \? s\.pricingNotSaved\(m\) : s\.notSavedAlone\(m\)/);
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const three = new Set([S[lang].adoptNotDone('X'), S[lang].pricingNotSaved('X'), S[lang].notSavedAlone('X')]);
    assert.equal(three.size, 3, `${lang}: three different sentences`);
    for (const t of three) assert.ok(t.includes('X'), `${lang}: the reason is kept`);
  }
});

// ---------------------------------------------------------------------------------------------- 4

test('S4 ckb: the «derived rates» banner and the issue line under it name the same thing with the same word (دەرهێنراو)', async () => {
  const { M, S, createElement, render } = await mods();
  const { pricingIssueLabel } = await import('../packages/contracts/src/pricingIssues');
  const answerOver = { rates: { usd_iqd_rate: '1600', review_pending: false, derived_stale: true } };
  const st = await stateOf({}, answerOver);
  const html = text(render('ckb', { ...st, shown: st.answer }, createElement(M.UsdPricingProductPanel)));
  assert.ok(html.includes(S.ckb.ratesDerivedStale), 'the banner');
  assert.ok(html.includes(pricingIssueLabel('FX_DERIVED_STALE', 'ckb')), 'the issue line');
  assert.ok(pricingIssueLabel('FX_DERIVED_STALE', 'ckb').includes('دەرهێنراو'));
  assert.ok(S.ckb.ratesDerivedStale.includes('دەرهێنراو'), S.ckb.ratesDerivedStale);
  assert.ok(!S.ckb.ratesDerivedStale.includes('داڕێژراو'));
  // And a refusal for stale derived rates gives the banner's advice, never «try again» (the panel's own words).
  assert.match(source('src/components/adminProducts/form/UsdPricingSection.tsx'), /const derived = e instanceof ApiError && e\.code === 'FX_DERIVED_STALE';[\s\S]{0,80}\? s\.ratesDerivedStale/);
});

// ---------------------------------------------------------------------------------------------- 5

test('S5 the no-dollar-rate banner names the buttons that save — no «as you type» autosave wording (ar, en, ckb)', async () => {
  const { S } = await mods();
  const section = source('src/components/adminProducts/form/UsdPricingSection.tsx');
  assert.ok(!/setDraft = useCallback[\s\S]{0,400}commitPricing\(/.test(section), 'typing never saves');
  assert.doesNotMatch(S.en.ratesNoUsd, /as you type/i, `en: «${S.en.ratesNoUsd}»`);
  assert.doesNotMatch(S.ar.ratesNoUsd, /كما تكتبها/, `ar: «${S.ar.ratesNoUsd}»`);
  for (const lang of ['ar', 'en', 'ckb'] as const) assert.ok(S[lang].ratesNoUsd.includes(S[lang].save), `${lang}: names «${S[lang].save}»`);
});

// ---------------------------------------------------------------------------------------------- 6

test('S6 a saved outcome is said ONCE in the panel — beside the save button, not again in a banner', async () => {
  const { M, S, createElement, render } = await mods();
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const said = S[lang].saved;
    const html = text(render(lang, await stateOf({ notice: said, outcome: { kind: 'saved', tone: 'ok', text: said } }), createElement(M.UsdPricingProductPanel)));
    assert.equal(count(html, said), 1, `${lang}: «${said}» ×${count(html, said)}`);
    // Anything that still needs the owner stays a banner (a refusal here).
    const refused = S[lang].notSavedAlone('X');
    const htmlRefused = text(render(lang, await stateOf({ outcome: { kind: 'refused', tone: 'error', text: refused } }), createElement(M.UsdPricingProductPanel)));
    assert.equal(count(htmlRefused, refused), 1);
  }
});

// ---------------------------------------------------------------------------------------------- 7

test('S7 a decimal comma in the box / weight fields is read like the cost’s (60,5 → 60.5), a thousands-looking one stays unread — and is said', async () => {
  const { parseScaledInteger } = await import('../src/components/adminProducts/form/DimensionsSection');
  const { typedDecimalText } = await import('../packages/contracts/src/procurementCost');
  assert.equal(typedDecimalText('899,5'), '899.5', 'the cost / CBM reader takes a decimal comma');
  assert.equal(parseScaledInteger('٦٠٫٥', 10), 605, 'the Arabic decimal key');
  assert.equal(parseScaledInteger('60', 10), 600);
  assert.equal(parseScaledInteger('60,5', 10), 605, 'a decimal comma in «عرض الصندوق (سم)»');
  assert.equal(parseScaledInteger('٦٠,٥', 10), 605);
  assert.equal(parseScaledInteger('60,', 10), 600, 'typing on: «60,» is 60 until the next key');
  assert.equal(parseScaledInteger('1,5', 1000), 1500, 'a decimal comma in the weight (kg)');
  assert.equal(parseScaledInteger('1,500', 1000), null, 'three digits after a comma: never guessed');
  assert.equal(parseScaledInteger('60,55', 10), null, 'finer than a millimetre');
  // What cannot be read is said under the field while it is typed, in each language.
  const dims = source('src/components/adminProducts/form/DimensionsSection.tsx');
  assert.match(dims, /const unreadable = focused && text\.trim\(\) !== '' && parseScaledInteger\(text, scale\) === null;/);
  assert.match(dims, /data-measure-unreadable/);
  for (const lang of ['ar:', 'en:', 'ckb:']) assert.ok(dims.slice(dims.indexOf('const UNREADABLE')).includes(lang));
});

// ---------------------------------------------------------------------------------------------- 8

test('S8 «التسعير والشحن» (the FX panel) never prints a raw «{field}»', async () => {
  const { apiRefusal } = await import('../src/lib/refusalStrings');
  const { ApiError } = await import('../src/lib/api');
  assert.ok(/if \(error instanceof ApiError && error\.code === 'PRICING_CHANGED'\) return s\.panelChanged;\n {2}return apiRefusal\(error, lang, s\.loadFailed\);/.test(source('src/components/adminPricing/fxParts.tsx')));
  const e = new ApiError(400, 'Invalid value', 'PRICING_INPUT_INVALID', { field: 'rate' });
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const said = apiRefusal(e, lang, 'fallback');
    assert.ok(!said.includes('{field}'), `${lang}: the FX screen says «${said}»`);
    assert.ok(said.length > 5);
  }
});

// ---------------------------------------------------------------------------------------------- 9

test('S9 the product form’s own chrome (section ٨’s summary, the bar) speaks the reader’s language; after adoption the panel says the store price follows the engine', async () => {
  const { M, S, createElement, render } = await mods();
  const form = source('src/components/adminProducts/ProductForm.tsx');
  assert.doesNotMatch(form, /'محفوظ'|>تغييرات غير محفوظة</, 'no Arabic-only «محفوظ» / «تغييرات غير محفوظة» left in the form');
  assert.match(form, /fileUpdateNote \?\? us\.savedShort/);
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    assert.ok(S[lang].savedShort && S[lang].unsaved);
    const engine = text(render(lang, await stateOf({ engine: true }, { mode: 'engine' }), createElement(M.UsdPricingProductPanel)));
    assert.ok(engine.includes(S[lang].pricesEngine) && !engine.includes(S[lang].pricesLater), `${lang}: engine`);
    const manual = text(render(lang, await stateOf(), createElement(M.UsdPricingProductPanel)));
    assert.ok(manual.includes(S[lang].pricesLater) && !manual.includes(S[lang].pricesEngine), `${lang}: manual`);
  }
  // Every new word exists in the three languages, and Sorani never copies the Arabic.
  for (const k of ['savedShort', 'sheetProductSaved', 'adoptNotDone', 'pricesEngine', 'iqdAtRate', 'rateUnseen', 'restSavedWithheld', 'measuresForPricingOnly', 'leaveMeasures'] as const) {
    const v = (lang: 'ar' | 'en' | 'ckb') => {
      const x = S[lang][k] as unknown;
      return typeof x === 'function' ? (x as (...a: string[]) => string)('A', 'B', 'C') : String(x);
    };
    for (const lang of ['ar', 'en', 'ckb'] as const) assert.ok(v(lang).length > 3, `${k} ${lang}`);
    assert.notEqual(v('ckb'), v('ar'), `${k}: ckb copies the Arabic`);
    assert.notEqual(v('en'), v('ar'), `${k}: en copies the Arabic`);
  }
});
