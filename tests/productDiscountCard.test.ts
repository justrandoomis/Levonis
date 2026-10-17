/**
 * PRODUCT DISCOUNT — THE PRODUCT FORM'S «تخفيض السعر» CARD (docs/ux/PRODUCT-DISCOUNT.md §6, §12 UI).
 *
 * The card's view is pure (`DiscountCardView`): rendered here in every §6.2 state, for the owner and an
 * editor, on a price-first and a cost-first product — the mode and scope controls, the per-model inputs
 * and their «اتركه فارغًا…» hint, the preview rows' chips, the reason a dollar price is unavailable.
 * The save body carries the row as loaded (tiers, limits, `locked_preview`, the PLUS price) and the
 * stamp the card read. Every string exists in three languages, the Sorani its own, in the form's
 * vocabulary. The card is mounted in section ٣ after the prices and before the membership discount.
 *
 * Run: npx tsx --test tests/productDiscountCard.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LanguageProvider } from '../src/LanguageContext';
import {
  DiscountCardView,
  draftFrom,
  saveBodyOf,
  shownRows,
  type DiscountDraft,
  type DiscountReadWire,
  type DiscountViewProps,
  type OfferWire,
  type PreviewRowWire,
} from '../src/components/adminProducts/form/ProductDiscountCard';
import { DISCOUNT_STRINGS, discountStrings } from '../src/components/adminProducts/form/productDiscountStrings';

let LANG = 'ar';
(globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => (k === 'levo_lang' ? LANG : null), setItem: () => {}, removeItem: () => {} };

const M1 = 'm_p1s';
const M2 = 'm_combo';
const names = (en: string, ar = en, ckb = en) => ({ ar, en, ckb });

const read = (over: Partial<DiscountReadWire> = {}): DiscountReadWire => ({
  usd_supported: true,
  published: true,
  composition: false,
  viewer: 'owner',
  method: 'usd',
  usd: { available: true, reason: null, scopes: ['model'] },
  models: [
    { model_id: M1, names: names('P1S'), uniform: true, direct: true },
    { model_id: M2, names: names('P1S Combo', 'P1S كومبو', 'P1S کۆمبۆ'), uniform: true, direct: true },
  ],
  rows: [
    { combo_key: `o:${M1}`, model_id: M1, names: names('P1S'), channel: 'direct_sale', before_iqd: 900_000, before_usd: '600.00', before_usd_exact: true },
    { combo_key: `o:${M1}`, model_id: M1, names: names('P1S'), channel: 'pre_order_land', before_iqd: 825_000, before_usd: '550.00', before_usd_exact: true },
    { combo_key: `o:${M2}`, model_id: M2, names: names('P1S Combo', 'P1S كومبو', 'P1S کۆمبۆ'), channel: 'direct_sale', before_iqd: 1_125_000, before_usd: '750.00', before_usd_exact: true },
    { combo_key: `o:${M2}`, model_id: M2, names: names('P1S Combo', 'P1S كومبو', 'P1S کۆمبۆ'), channel: 'pre_order_land', before_iqd: 1_050_000, before_usd: '700.00', before_usd_exact: true },
  ],
  write_seq: 3,
  ...over,
});

const offer = (over: Partial<OfferWire> = {}): OfferWire => ({
  subject_id: 'p_p1s',
  offer_id: 'ofw_pp1s',
  starts_at: '2026-10-20T09:00:00.000Z',
  ends_at: '2099-01-01T00:00:00.000Z',
  required_tiers: [],
  offer_price_mode: 'fixed_usd',
  offer_price_iqd: null,
  discount_percent: null,
  discount_iqd: null,
  plus_price_iqd: null,
  locked_preview: true,
  active: true,
  max_per_user: null,
  max_global: null,
  updated_at: '2026-10-16T10:00:00.000Z',
  offer_usd_prices: [
    { model_id: M1, usd: '500.00' },
    { model_id: M2, usd: '640.00' },
  ],
  ...over,
});

const previewOf = (r: DiscountReadWire, after: Record<string, [number | null, number | null, PreviewRowWire['state']]>, owner = true): PreviewRowWire[] =>
  r.rows.map((row) => {
    const [a, pct, state] = after[`${row.model_id}|${row.channel}`] ?? [null, null, 'not_covered'];
    return { ...row, after_iqd: a, after_usd: a ? '500.00' : null, offer_saving_percent: pct, state, ...(owner ? { owner: { below_cost: false, below_min_profit: false } } : {}) };
  });

function view(over: Partial<DiscountViewProps> = {}, lang: 'ar' | 'en' | 'ckb' = 'ar'): string {
  LANG = lang;
  const r = over.read === undefined ? read() : over.read;
  const o = over.offer === undefined ? offer() : over.offer;
  const props: DiscountViewProps = {
    lang,
    productId: 'p_p1s',
    read: r,
    offer: o,
    scheduleState: o ? 'live' : null,
    opened: false,
    draft: r ? draftFrom(o, r) : null,
    preview: null,
    previewing: false,
    issues: [],
    warnings: [],
    note: null,
    busy: false,
    drafting: false,
    onOpen: () => {},
    onDraft: () => {},
    onSave: () => {},
    onRemove: () => {},
    ...over,
  };
  return renderToStaticMarkup(createElement(LanguageProvider, null, createElement(DiscountCardView, props)));
}

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/* ------------------------------------------------------------- states -- */

test('§6.2 states: a new product, a composition, an unpublished product, no window', () => {
  assert.match(view({ productId: null }), /احفظ المنتج أولًا، ثم أضف التخفيض\./);
  assert.equal(view({ read: read({ composition: true }) }), '', 'a bundle or mystery offer: no card');
  assert.match(view({ read: read({ published: false }), offer: null }), /انشر أسعار المنتج أولًا؛ يُحسب الخصم من السعر المنشور\./);
  const none = view({ offer: null });
  assert.match(none, /لا يوجد تخفيض على هذا المنتج\./);
  assert.match(none, /\+ إضافة تخفيض/);
  assert.doesNotMatch(none, /data-discount-table/);
});

test('a dollar window per model: the inputs on each model row, the before prices, the state chip and the clock', () => {
  const html = view();
  assert.match(html, /data-discount-segment="mode"/);
  assert.match(html, /role="radio" aria-checked="true"[^>]*>سعر بعد الخصم \(\$\)</);
  assert.doesNotMatch(html, /data-discount-segment="scope"/, 'one scope possible: no scope control');
  assert.match(html, /data-v2-field="discount-usd-m_p1s"[^>]*value="500\.00"/);
  assert.match(html, /data-v2-field="discount-usd-m_combo"[^>]*value="640\.00"/);
  assert.match(html, /\$600\.00/);
  assert.match(html, /900,000<\/bdi> د\.ع/);
  assert.match(html, /الطلب المسبق \(2\)/);
  assert.match(html, /يعمل الآن/);
  assert.match(html, /بتوقيت بغداد/);
  assert.match(html, /value="2026-10-20T12:00"/, 'a stored instant is shown in Baghdad time (09:00Z → 12:00)');
  assert.match(html, /يُحوَّل الدولار إلى الدينار بسعر الصرف نفسه/);
  assert.match(html, /حفظ التخفيض/);
  assert.match(html, /حذف التخفيض/);
  assert.match(html, /href="\/admin\?tab=offers"/);
  // An empty model input says what it does.
  const empty = view({ draft: { ...draftFrom(offer(), read()), usdByModel: { [M1]: '500.00' } } });
  assert.match(empty, /اتركه فارغًا ليبقى هذا الموديل بسعره/);
});

test('both scopes possible: the scope control; the whole-product scope is one input above the table', () => {
  const r = read({ usd: { available: true, reason: null, scopes: ['product', 'model'] } });
  const d: DiscountDraft = { ...draftFrom(null, r), mode: 'usd', scope: 'product', usdWhole: '500' };
  const html = view({ read: r, offer: null, opened: true, draft: d });
  assert.match(html, /data-discount-segment="scope"/);
  assert.match(html, /aria-checked="true"[^>]*>سعر واحد للمنتج كله</);
  assert.match(html, /data-v2-field="discount-usd-whole"[^>]*value="500"/);
  assert.doesNotMatch(html, /data-v2-field="discount-usd-m_p1s"/);
});

test('a dollar price unavailable: the segment is disabled and the sentence says why', () => {
  for (const [reason, sentence] of [
    ['OWNER_ONLY', 'هذا المنتج مسعَّر من التكلفة'],
    ['NOT_DIRECT', 'لا يُباع بيعًا مباشرًا'],
    ['MIXED_PRICES', 'ألوان هذا المنتج بأسعار مختلفة'],
    ['NOT_INSTALLED', 'غير متاح بعد على هذه القاعدة'],
  ] as const) {
    const r = read({ usd: { available: false, reason, scopes: [] } });
    const html = view({ read: r, offer: null, opened: true, draft: draftFrom(null, r) });
    assert.match(html, /role="radio" aria-checked="false" disabled=""[^>]*>سعر بعد الخصم/, reason);
    assert.match(html, new RegExp(sentence), reason);
    assert.match(html, /role="radio" aria-checked="true"[^>]*>نسبة الخصم/, `${reason}: opens on the percent`);
  }
});

test('an editor on a cost-first product sees no dollars anywhere', () => {
  const r = read({
    viewer: 'editor',
    method: 'cost',
    usd: { available: false, reason: 'OWNER_ONLY', scopes: [] },
    rows: read().rows.map((x) => ({ ...x, before_usd: null, before_usd_exact: false })),
  });
  const html = view({ read: r, offer: offer({ offer_price_mode: 'discount_percent', discount_percent: 10, offer_usd_prices: [] }) });
  assert.doesNotMatch(html, /\$\d/, 'no dollar figure');
  assert.match(html, /900,000<\/bdi> د\.ع/);
  // The owner on cost-first reads «≈» dollars.
  const owner = view({ read: read({ method: 'cost', rows: read().rows.map((x) => ({ ...x, before_usd: '612.35', before_usd_exact: false })) }) });
  assert.match(owner, /≈ \$612\.35/);
});

test('another mode, a suspended row, tiers and limits, and a V2 draft not applied', () => {
  const other = view({ offer: offer({ offer_price_mode: 'discount_iqd', discount_iqd: 50_000, offer_usd_prices: [] }) });
  assert.match(other, /هذا المنتج عليه خصم بالدينار من «العروض الخاصة» \(50,000 د\.ع\)/);
  assert.match(other, /role="radio" aria-checked="true"[^>]*>نسبة الخصم/, 'opens on the percent');
  const suspended = view({ offer: offer({ suspended: true }) });
  assert.match(suspended, /موقوف: أُنشئ قبل التسعير الجديد/);
  assert.match(suspended, /احفظ لتشغيله من جديد/);
  const gated = view({ offer: offer({ required_tiers: ['plus'], max_per_user: 5 }) });
  assert.match(text(gated), /إعدادات أخرى لهذا العرض من «العروض الخاصة»: للمشتركين فقط: PLUS · حد 5 لكل زبون/);
  assert.match(view({ drafting: true }), /السعر «قبل» هو المنشور الآن/);
});

test('the preview rows: lowered with its percent, not lower, below the floor, and the owner’s cost chips', () => {
  const r = read();
  const preview = previewOf(r, {
    [`${M1}|direct_sale`]: [750_000, 17, 'lowered'],
    [`${M1}|pre_order_land`]: [null, null, 'below_floor'],
    [`${M2}|direct_sale`]: [null, null, 'not_lower'],
  });
  preview[0]!.owner = { below_cost: true, below_min_profit: false };
  const html = view({ preview });
  assert.match(html, /750,000<\/bdi> د\.ع/);
  assert.match(html, />−17٪</);
  assert.match(html, /بلا تخفيض/);
  assert.match(html, /ليس أقل من السعر الحالي — لا يظهر خصم/);
  assert.match(html, /يجعل السعر صفرًا أو أقل/);
  assert.match(html, /تحت التكلفة/);
  // An editor's preview carries no owner key, so no cost chip can draw.
  const editor = view({ read: read({ viewer: 'editor' }), preview: previewOf(r, { [`${M1}|direct_sale`]: [750_000, 17, 'lowered'] }, false) });
  assert.doesNotMatch(editor, /تحت التكلفة|تحت الحد الأدنى للربح/);
  // In flight: «…» in the after column.
  assert.match(view({ preview, previewing: true }), /aria-live="polite">…</);
});

test('the colours of one model at one price are one row, «كل الألوان»', () => {
  const r = read({
    models: [{ model_id: M1, names: names('P1S'), uniform: true, direct: true }],
    rows: ['c1', 'c2'].map((c) => ({ combo_key: `o:${M1}|c:${c}`, model_id: M1, names: names(`P1S · ${c}`), channel: 'direct_sale' as const, before_iqd: 900_000, before_usd: '600.00', before_usd_exact: true })),
  });
  const rows = shownRows(r, null, 'ar', discountStrings('ar'));
  assert.deepEqual(rows.map((x) => x.label), ['P1S · كل الألوان']);
  const differ = shownRows({ ...r, rows: [r.rows[0]!, { ...r.rows[1]!, before_iqd: 930_000 }] }, null, 'en', discountStrings('en'));
  assert.deepEqual(differ.map((x) => x.label), ['P1S · c1', 'P1S · c2']);
});

test('refusals and warnings render verbatim in the reader’s language; the first refusal can take focus', () => {
  const issue = { code: 'OFFER_NOT_LOWER', ar: 'السعر بعد الخصم ليس أقل', en: 'not below', ckb: 'کەمتر نییە' };
  assert.match(view({ issues: [issue] }, 'ckb'), /کەمتر نییە/);
  assert.match(view({ issues: [issue] }, 'en'), />not below</);
  assert.match(view({ warnings: [{ code: 'W', ar: 'تحذير', en: 'warn', ckb: 'ئاگاداری' }], note: 'حُفظ التخفيض.' }), /تحذير[\s\S]*حُفظ التخفيض\./);
  assert.match(view({ issues: [issue] }), /tabindex="-1"/);
});

/* ---------------------------------------------------------- save body -- */

test('the save body: the row as loaded (tiers, limits, locked_preview, PLUS) untouched, the set, the stamp', () => {
  const loaded = offer({ required_tiers: ['pro'], max_per_user: 2, max_global: 9, locked_preview: false });
  const d = draftFrom(loaded, read());
  const body = saveBodyOf(loaded, { ...d, usdByModel: { [M1]: '480.00', [M2]: '' } });
  assert.deepEqual(body.required_tiers, ['pro']);
  assert.equal(body.max_per_user, 2);
  assert.equal(body.max_global, 9);
  assert.equal(body.locked_preview, false);
  assert.equal(body.offer_price_mode, 'fixed_usd');
  assert.deepEqual(body.offer_usd_prices, [{ model_id: M1, usd: '480.00' }], 'an empty model keeps its price');
  assert.equal(body.expected_updated_at, '2026-10-16T10:00:00.000Z');
  assert.equal(body.starts_at, '2026-10-20T12:00:00', 'Baghdad naive time, read by the server as +03:00');
  const fresh = saveBodyOf(null, { ...draftFrom(null, read()), mode: 'percent', percent: 10 });
  assert.equal(fresh.expected_updated_at, null, '"I saw no row"');
  assert.equal(fresh.offer_price_mode, 'discount_percent');
  assert.equal(fresh.discount_percent, 10);
  assert.equal('offer_usd_prices' in fresh, false);
  assert.deepEqual(fresh.required_tiers, []);
});

/* ------------------------------------------------------------ strings -- */

test('every string in three languages, the Sorani its own, in the form’s vocabulary', () => {
  const keys = Object.keys(DISCOUNT_STRINGS.ar) as Array<keyof typeof DISCOUNT_STRINGS.ar>;
  for (const k of keys) {
    for (const lang of ['ar', 'en', 'ckb'] as const) assert.ok(DISCOUNT_STRINGS[lang][k] !== undefined && DISCOUNT_STRINGS[lang][k] !== '', `${lang}.${k}`);
    const sample = (v: unknown) => (typeof v === 'function' ? (v as (x: unknown) => string)(3) : typeof v === 'object' ? JSON.stringify(v) : String(v));
    if (k === 'colAfter' || k === 'modeUsd' || k === 'usdOne') continue; // checked below: «$» only differs by script
    assert.notEqual(sample(DISCOUNT_STRINGS.ckb[k]), sample(DISCOUNT_STRINGS.ar[k]), `ckb.${k} is not the Arabic`);
  }
  assert.notEqual(DISCOUNT_STRINGS.ckb.modeUsd, DISCOUNT_STRINGS.ar.modeUsd);
  const allCkb = JSON.stringify(Object.values(DISCOUNT_STRINGS.ckb).map((v) => (typeof v === 'function' ? (v as (x: unknown) => string)('x') : v)));
  assert.doesNotMatch(allCkb, /گواستنەوە|کاڵا/, 'the form’s Sorani vocabulary rule');
  // «الخصم ($)» alone names the PRE-ORDER discount in section ٣: the sale is «تخفيض».
  for (const lang of ['ar', 'en', 'ckb'] as const) assert.notEqual(DISCOUNT_STRINGS[lang].title, lang === 'ar' ? 'الخصم ($)' : '');
  assert.equal(DISCOUNT_STRINGS.ar.title, 'تخفيض السعر');
  assert.equal(DISCOUNT_STRINGS.ckb.title, 'داشکاندنی نرخ');
  // The view renders English and Sorani with no Arabic leaking in.
  assert.match(view({}, 'en'), /Sale price/);
  assert.match(view({}, 'ckb'), /داشکاندنی نرخ/);
  assert.doesNotMatch(text(view({}, 'en')), /[؀-ۿ]{3,}/, 'English is English');
});

test('the card is mounted in section ٣ after the prices and before the membership discount', () => {
  const form = readFileSync('src/components/adminProducts/ProductForm.tsx', 'utf8');
  const prices = form.indexOf('<PricesSectionV2');
  const card = form.indexOf('<ProductDiscountCard productId={doc.id || null} />');
  const members = form.indexOf('<MembershipDiscountSection');
  assert.ok(prices > 0 && card > prices && members > card, 'PricesSectionV2 → ProductDiscountCard → MembershipDiscountSection');
});

test('the card and the offers tab link to each other, and both links open their tab (deep links)', () => {
  const card = readFileSync('src/components/adminProducts/form/ProductDiscountCard.tsx', 'utf8');
  const offers = readFileSync('src/components/adminOffers/AdminOffers.tsx', 'utf8');
  const admin = readFileSync('src/pages/Admin.tsx', 'utf8');
  assert.match(card, /href="\/admin\?tab=offers"/);
  assert.match(offers, /\/admin\?tab=products&edit=\$\{encodeURIComponent\(editing\.subject_id\)\}&section=3/);
  const deep = /const DEEP_LINK_TABS: readonly AdminTab\[\] = \[([^\]]*)\]/.exec(admin);
  assert.ok(deep, 'Admin.tsx DEEP_LINK_TABS');
  for (const tab of ['offers', 'products']) assert.match(deep[1], new RegExp(`'${tab}'`), `?tab=${tab} opens its tab, not the overview`);
});

test('the form switch the card wears takes a 44 px tap (§6.4: every target ≥ 44 px, `.lv-hit`)', () => {
  const ui = readFileSync('src/components/adminProducts/form/formUi.tsx', 'utf8');
  const toggle = ui.slice(ui.indexOf('export function Toggle('), ui.indexOf('export function CheckCard('));
  assert.match(toggle, /role="switch"[\s\S]*className="lv-hit relative /, 'the 40 px switch row grows its tap with lv-hit');
});

test('the offers tab: per-model dollar prices name their models in the reader’s language; one model is named, never «1 موديلات»', async () => {
  const { usdLine, usdModelsLine } = await import('../src/components/adminOffers/AdminOffers');
  const set = [
    { model_id: M1, usd: '500.00', names: names('P1S') },
    { model_id: M2, usd: '640.00', names: names('P1S Combo', 'P1S كومبو', 'P1S کۆمبۆ') },
  ];
  const line = (lang: 'ar' | 'en' | 'ckb') => usdModelsLine(set, lang).map((m) => `${m.name} ${m.usd}`).join(' · ');
  assert.equal(line('en'), 'P1S $500.00 · P1S Combo $640.00');
  assert.equal(line('ar'), 'P1S $500.00 · P1S كومبو $640.00');
  assert.equal(line('ckb'), 'P1S $500.00 · P1S کۆمبۆ $640.00');
  // The list line: the lowest price, then the count read as a number of models — or the one model's name.
  assert.equal(usdLine({ offer_usd_prices: set }, 'ar'), '$500.00 · موديلان');
  assert.equal(usdLine({ offer_usd_prices: set }, 'en'), '$500.00 · 2 models');
  assert.equal(usdLine({ offer_usd_prices: set }, 'ckb'), '$500.00 · 2 مۆدێل');
  const one = [{ model_id: M2, usd: '550.00', names: names('P1S Combo', 'P1S كومبو', 'P1S کۆمبۆ') }];
  assert.equal(usdLine({ offer_usd_prices: one }, 'ar'), '$550.00 · P1S كومبو');
  assert.equal(usdLine({ offer_usd_prices: one }, 'en'), '$550.00 · P1S Combo');
  assert.equal(usdLine({ offer_usd_prices: one }, 'ckb'), '$550.00 · P1S کۆمبۆ');
  // An older answer without names: counted, in the right number.
  assert.equal(usdLine({ offer_usd_prices: [{ model_id: M2, usd: '550.00' }] }, 'ar'), '$550.00 · موديل واحد');
  assert.equal(usdLine({ offer_usd_prices: [{ model_id: M2, usd: '550.00' }] }, 'en'), '$550.00 · 1 model');
  const three = [...set, { model_id: 'm3', usd: '700.00' }];
  assert.equal(usdLine({ offer_usd_prices: three }, 'ar'), '$500.00 · 3 موديلات');
  assert.equal(usdLine({ offer_usd_prices: [{ model_id: '', usd: '500.00' }] }, 'ar'), '$500.00', 'the whole product');
  for (const lang of ['ar', 'en', 'ckb'] as const) assert.doesNotMatch(usdLine({ offer_usd_prices: one }, lang), /\b1 (models|موديلات)/);
  // D7 in the tab: an editor on a cost-first product is not offered the dollar mode, and is told why.
  const tab = readFileSync('src/components/adminOffers/AdminOffers.tsx', 'utf8');
  assert.match(tab, /<option value="fixed_usd" disabled=\{editing\.usd_allowed === false/);
  assert.match(tab, /data-offer-usd-owner-only/);
});

/* -------------------------------------------------------- review fixes -- */

test('a refused draft: the preview’s sentence is shown before Save, and no row is called «بلا تخفيض»', async () => {
  const { previewAnswerOf } = await import('../src/components/adminProducts/form/ProductDiscountCard');
  const shape = { code: 'OFFER_USD_PRICE_SHAPE', ar: 'اكتب السعر بالدولار أكبر من صفر', en: 'enter the dollar price above zero', ckb: 'نرخەکە بە دۆلار لە سفر زیاتر بنووسە' };
  // The door's answer to a check-1-to-6 refusal: every row uncovered, the refusal beside them, `refused`.
  const r = read();
  const answer = { rows: previewOf(r, {}), issues: [shape], warnings: [], refused: true };
  const shown = previewAnswerOf(answer);
  assert.equal(shown.preview, null, 'a refused draft prices nothing: the rows show their before price and «—»');
  assert.deepEqual(shown.issues, [shape]);
  for (const [lang, sentence, chip] of [
    ['ar', shape.ar, 'بلا تخفيض'],
    ['en', shape.en, 'No sale'],
    ['ckb', shape.ckb, 'بێ داشکاندن'],
  ] as const) {
    const html = view({ preview: shown.preview, previewIssues: shown.issues, previewWarnings: shown.warnings }, lang);
    assert.ok(html.includes(sentence), `${lang}: the preview's refusal is said before Save`);
    assert.ok(!html.includes(chip), `${lang}: no «${chip}» chip on a refused draft`);
    assert.match(html, /text-text-muted">—</, `${lang}: the after column reads —`);
  }
  // A priced preview keeps its rows; its warnings are shown too; a sentence said twice is said once.
  const priced = previewAnswerOf({ rows: previewOf(r, { [`${M1}|direct_sale`]: [750_000, 17, 'lowered'] }), issues: [], warnings: [{ code: 'OFFER_PRICE_NEVER_ENDS', ar: 'بلا تاريخ انتهاء', en: 'no end date', ckb: 'بەرواری کۆتایی نییە' }] });
  assert.ok(priced.preview && priced.preview.length === 4);
  const html = view({ preview: priced.preview, previewWarnings: priced.warnings, warnings: priced.warnings });
  assert.equal(html.split('بلا تاريخ انتهاء').length - 1, 1, 'deduplicated by code');
});

test('the «الطلب المسبق (n)» disclosure draws its own marker, and it turns when open', () => {
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const html = view({}, lang);
    const summary = /<summary[^>]*>([\s\S]*?)<\/summary>/.exec(html);
    assert.ok(summary, lang);
    assert.match(summary![0], /data-discount-preorder-marker/, `${lang}: a visible marker inside the summary`);
    assert.match(summary![0], /group-open:rotate-180/, 'it turns when the disclosure is open');
    assert.match(summary![0], /min-h-\[44px\]/, 'the 44 px tap stays');
  }
  assert.match(view(), /<details class="group /);
});

test('owner card amounts isolate the FIGURE only: «900,000» is LTR, «د.ع» follows the sentence (Latin digits too)', () => {
  const r = read();
  const html = view({ preview: previewOf(r, { [`${M1}|direct_sale`]: [750_000, 17, 'lowered'] }) });
  assert.match(html, /<bdi dir="ltr">900,000<\/bdi> د\.ع/);
  assert.match(html, /<bdi dir="ltr">750,000<\/bdi> د\.ع/);
  assert.doesNotMatch(html, /<bdi dir="ltr">[\d,]+ د\.ع<\/bdi>/, 'never the unit inside the LTR island');
  assert.match(view({}, 'en'), /<bdi dir="ltr">900,000<\/bdi> IQD/);
});
