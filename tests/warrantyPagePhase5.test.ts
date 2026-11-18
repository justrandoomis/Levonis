/**
 * /warranty rebuilt, Levo Care after the warranty, and the Care part offer on the customer's side
 * (printer phase 5, DECISIONS row 358). What these pin:
 *
 *   - the page's words are four tables by subject, complete in ar / en / ckb, and the Sorani is Sorani
 *     (row 183): never the Arabic, never the English, no Arabic-only letter;
 *   - the cover is said as the warranty, THEN Levo Care after it (12 / 24 / 36 months in total);
 *   - «اطلب خصم ليفو كير» exists only with Care in force, and the form sends `kind: 'care'`;
 *   - a message carrying `part_grant_id` is drawn as a product with its discount and its cart action,
 *     and a live offer is said outside the conversation too;
 *   - the cart and the checkout name «خصم ليفو كير» on its own row and never take it twice;
 *   - where Care is sold it says «12 months after the warranty» with the total for the choice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { codeOf } from './fixtures/source';
import { PAGE_STRINGS } from '../src/components/warranty/copy/page';
import { ADD_STRINGS } from '../src/components/warranty/copy/add';
import { CLAIM_STRINGS } from '../src/components/warranty/copy/claims';
import { CARE_STRINGS as CARE_COPY } from '../src/components/warranty/copy/care';
import { CARE_STRINGS, WARRANTY_STRINGS } from '../src/components/warranty/strings';
import { CoverTimeline } from '../src/components/warranty/CoverTimeline';
import { CarePanel } from '../src/components/warranty/CarePanel';
import { PartOfferCard } from '../src/components/warranty/PartOfferCard';
import { claimWaiting } from '../src/components/warranty/ClaimCard';
import type { CarePublic, Claim, Device, PartGrantPublic } from '../src/components/warranty/types';
import { PS_STRINGS } from '../src/components/product/printerServicesStrings';

type Lang = 'ar' | 'en' | 'ckb';
const LANGS: Lang[] = ['ar', 'en', 'ckb'];

// ---------------------------------------------------------------- the words

/** The two-argument functions whose second argument is the digit formatter (the others take the formatted number). */
const FMT_SECOND = new Set(['rowMonths', 'rowCareMonths', 'totalCover']);

/** Every string a table can say: plain values, and functions called with sample arguments. */
function said(table: Record<string, unknown>, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  const fmt = (n: number) => String(n);
  for (const [key, value] of Object.entries(table)) {
    const name = prefix + key;
    if (typeof value === 'string') out.set(name, value);
    else if (typeof value === 'function') {
      // Two plural shapes each, with the arguments each shape of function takes.
      const f = value as (...a: unknown[]) => string;
      for (const n of [3, 24]) {
        const args = key === 'left' ? [n, 5, fmt] : f.length >= 3 ? [n, '14 مارس', fmt] : FMT_SECOND.has(key) ? [n, fmt] : f.length === 2 ? [n, String(n)] : [n];
        out.set(`${name}(${n})`, f(...args));
      }
    } else if (value && typeof value === 'object') for (const [k, v] of said(value as Record<string, unknown>, `${name}.`)) out.set(k, v);
  }
  return out;
}

const TABLES: Array<[string, Record<Lang, Record<string, unknown>>]> = [
  ['page', PAGE_STRINGS as unknown as Record<Lang, Record<string, unknown>>],
  ['add', ADD_STRINGS as unknown as Record<Lang, Record<string, unknown>>],
  ['claims', CLAIM_STRINGS as unknown as Record<Lang, Record<string, unknown>>],
  ['care', CARE_COPY as unknown as Record<Lang, Record<string, unknown>>],
];

test('the page’s words: four tables, the same keys in ar / en / ckb, nothing empty', () => {
  for (const [name, table] of TABLES) {
    const keys = Object.keys(table.ar).sort();
    for (const lang of LANGS) {
      assert.deepEqual(Object.keys(table[lang]).sort(), keys, `${name}.${lang}: the same keys as the Arabic`);
      for (const [key, text] of said(table[lang])) assert.ok(text.trim().length > 0, `${name}.${lang}.${key} is empty`);
    }
  }
  // The barrel the components read is the three page tables joined, and Care is its own.
  for (const lang of LANGS) {
    assert.equal(WARRANTY_STRINGS[lang].openClaim, PAGE_STRINGS[lang].openClaim);
    assert.equal(WARRANTY_STRINGS[lang].addTitle, ADD_STRINGS[lang].addTitle);
    assert.equal(WARRANTY_STRINGS[lang].kindCare, CLAIM_STRINGS[lang].kindCare);
    assert.equal(CARE_STRINGS[lang], CARE_COPY[lang]);
  }
  const overlap = (a: object, b: object) => Object.keys(a).filter((k) => k in b);
  assert.deepEqual(overlap(PAGE_STRINGS.ar, ADD_STRINGS.ar), [], 'no key in two tables: the join loses nothing');
  assert.deepEqual(overlap(PAGE_STRINGS.ar, CLAIM_STRINGS.ar), []);
  assert.deepEqual(overlap(ADD_STRINGS.ar, CLAIM_STRINGS.ar), []);
});

test('the Sorani is Sorani: never the Arabic, never the English, no Arabic-only letter (DECISIONS row 183)', () => {
  // Latin words both languages keep as they are.
  const SHARED = /^[\s\dA-Za-z%+·().:،—-]*$/;
  for (const [name, table] of TABLES) {
    const ar = said(table.ar);
    const en = said(table.en);
    for (const [key, ckb] of said(table.ckb)) {
      if (SHARED.test(ckb)) continue;
      assert.notEqual(ckb, ar.get(key), `${name}.${key}: the Sorani is the Arabic`);
      assert.notEqual(ckb, en.get(key), `${name}.${key}: the Sorani is the English`);
      // «14 مارس» is this test's own sample date, in Arabic on purpose.
      assert.doesNotMatch(ckb.replace(/14 مارس/g, ''), /[ةىيك]/, `${name}.${key}: an Arabic-only letter in the Sorani — ${ckb}`);
    }
  }
});

test('the owner’s two actions, in his words', () => {
  assert.equal(PAGE_STRINGS.ar.openClaim, 'افتح طلب ضمان');
  assert.equal(PAGE_STRINGS.ar.askCare, 'اطلب خصم ليفو كير');
  assert.equal(CARE_COPY.ar.offerWaiting(1, '1'), 'لديك عرض قطعة بخصم ليفو كير');
  assert.equal(CARE_COPY.ar.addToCart, 'أضف إلى السلة');
  assert.equal(CARE_COPY.ar.chooseOptions, 'اختر الخيارات');
  assert.equal(CARE_COPY.ar.offerPct('30'), 'خصم ليفو كير 30%');
  // Care is a discount, said so wherever it is explained — never a free replacement.
  for (const lang of LANGS) {
    assert.match(CARE_COPY[lang].what, /ليس استبدالًا مجانيًا|not a free replacement|گۆڕینی بەخۆڕایی نییە/);
    assert.match(PAGE_STRINGS[lang].howCare, /12|١٢/);
    // Once, on this account only, by itself.
    assert.match(CARE_COPY[lang].autoNote, /تلقائيًا|by itself|خۆکارانە/);
    assert.match(CARE_COPY[lang].autoNote, /مرة واحدة|once|یەک جار/);
    assert.match(CARE_COPY[lang].autoNote, /هذا الحساب|this account|ئەم هەژمارە/);
  }
});

// ------------------------------------------------------------- the cover card

const DAY = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();

function device(over: Omit<Partial<Device>, 'warranty'> & { warranty?: Partial<Device['warranty']> } = {}): Device {
  const { warranty, ...rest } = over;
  return {
    unit_id: 'u1',
    order_id: 'ORD-1',
    order_item_id: 'oi1',
    unit_index: 1,
    product: { id: 'p1', slug: 'a1', name: 'Bambu Lab A1', name_ar: 'بامبو لاب A1', name_ckb: 'بامبو لاب A1', image: '' },
    serial: '****ABCD',
    delivered_at: iso(-100),
    registered_at: iso(-99),
    warranty: { start_at: iso(-100), end_at: iso(265), base_months: 12, ext_months: 0, state: 'active', remaining_days: 265, ...warranty },
    replaced_by_unit_id: null,
    replacement_of_unit_id: null,
    receipt: null,
    open_claims: 0,
    transferred: false,
    ...rest,
  };
}

const care = (over: Partial<CarePublic> = {}): CarePublic => ({
  state: 'active',
  start_at: iso(-100),
  end_at: iso(630),
  claims_left: 2,
  benefit_left_iqd: 150_000,
  discount_pct: 40,
  warranty_months: 12,
  total_months: 24,
  care_only_from: iso(265),
  ...over,
});

const cover = (d: Device, lang: Lang = 'ar') =>
  renderToStaticMarkup(createElement(CoverTimeline, { device: d, lang, s: WARRANTY_STRINGS[lang], c: CARE_STRINGS[lang] }));

test('the cover: the warranty, then Levo Care after it — two rows, two segments, the total said (12 + 12 = 24)', () => {
  const html = cover(device({ care: care() }));
  assert.match(html, /data-cover="covered"/);
  assert.match(html, /مغطّاة بالضمان حتى/, 'the headline is a sentence');
  assert.match(html, /data-cover-segment="warranty"[\s\S]*data-cover-segment="care"/, 'the warranty first, Care after it');
  assert.match(html, /data-cover-row="warranty"[\s\S]*data-cover-row="care"/);
  // The months are written in the reader's digits (Intl): «12» or «١٢».
  assert.match(html, /\+(12|١٢) شهرًا بعد الضمان/, 'Care is the 12 months AFTER the warranty');
  assert.match(html, /data-cover-total="24"/);
  assert.match(html, /مجموع التغطية (24|٢٤) شهرًا من يوم الاستلام/);
  assert.match(html, /data-cover-today/, 'today is marked while the cover runs');
});

test('the cover: 24 months of warranty + Care reads 36; no warranty + Care reads Care alone', () => {
  const long = cover(device({ warranty: { base_months: 24, end_at: iso(630) }, care: care({ warranty_months: 24, total_months: 36, care_only_from: iso(630), end_at: iso(995) }) }));
  assert.match(long, /data-cover-total="36"/);

  const careOnly = cover(
    device({ warranty: { state: 'expired', base_months: null, end_at: null, remaining_days: null }, care: care({ warranty_months: 0, total_months: 12, care_only_from: iso(-100), end_at: iso(265) }) })
  );
  assert.doesNotMatch(careOnly, /data-cover-segment="warranty"/, 'no warranty segment for a printer bought without one');
  assert.match(careOnly, /data-cover-segment="care"/);
  assert.match(careOnly, /اشتُريت بدون ضمان/);
  assert.match(careOnly, /ليفو كير — ساري حتى/);
});

test('the cover: once the warranty is over Care is the cover in force; once both are over it says so', () => {
  const after = cover(
    device({ delivered_at: iso(-400), warranty: { start_at: iso(-400), end_at: iso(-35), state: 'expired', remaining_days: 0 }, care: care({ start_at: iso(-400), care_only_from: iso(-35), end_at: iso(330) }) })
  );
  assert.match(after, /انتهى الضمان — ليفو كير ساري حتى/);
  assert.match(after, /data-cover="covered"/);

  const over = cover(device({ delivered_at: iso(-800), warranty: { start_at: iso(-800), end_at: iso(-435), state: 'expired', remaining_days: 0 }, care: care({ state: 'expired', care_only_from: iso(-435), end_at: iso(-70) }) }));
  assert.match(over, /data-cover="ended"/);
  assert.match(over, /انتهت التغطية في/);
  assert.doesNotMatch(over, /data-cover-today/);

  // An older server sends no window fields: the warranty's own end is where Care's part begins.
  const older = cover(device({ care: care({ warranty_months: undefined, total_months: undefined, care_only_from: undefined }) }));
  assert.match(older, /data-cover-segment="warranty"[\s\S]*data-cover-segment="care"/);
  assert.doesNotMatch(older, /data-cover-total/, 'a total the server did not send is not said');

  const waiting = cover(device({ delivered_at: null, warranty: { start_at: null, end_at: null, state: 'not_delivered', remaining_days: null } }));
  assert.match(waiting, /data-cover="not_delivered"/);
  assert.match(waiting, /تبدأ التغطية يوم استلام الطابعة/);
});

test('what Care gives: the discount, the requests and the money left — and that it is a discount', () => {
  const html = renderToStaticMarkup(createElement(CarePanel, { care: care(), warrantyActive: true, lang: 'ar', c: CARE_STRINGS.ar }));
  assert.match(html, /خصم حتى 40% على القطع/);
  assert.match(html, /طلبان متبقيان/);
  assert.match(html, /رصيد الخصم المتبقي/);
  assert.match(html, /ليس استبدالًا مجانيًا/);
  assert.match(html, /العيب المصنعي يغطيه الضمان مجانًا/, 'while the warranty runs it says which cover answers what');
  const ended = renderToStaticMarkup(createElement(CarePanel, { care: care({ state: 'expired' }), warrantyActive: false, lang: 'ar', c: CARE_STRINGS.ar }));
  assert.doesNotMatch(ended, /data-device-care-facts/, 'nothing is promised from a Care that is over');
});

test('the printer card: Care’s action only with Care in force; an open request replaces both; requests sit on their device', () => {
  const card = codeOf('src/components/warranty/DeviceCard.tsx');
  assert.match(card, /const careActive = care\?\.state === 'active';/);
  assert.match(card, /\{careActive && \(\s*<button[\s\S]*?data-device-claim="care"[\s\S]*?\{s\.askCare\}/, '«اطلب خصم ليفو كير» is drawn only when Care is active');
  assert.match(card, /onOpenClaim\(device, 'warranty', e\.currentTarget\)[\s\S]*?\{s\.openClaim\}/);
  assert.match(card, /onOpenClaim\(device, 'care', e\.currentTarget\)/);
  assert.match(card, /open\.length > 0 \? \([\s\S]*?data-device-follow[\s\S]*?\{s\.followOpen\}/, 'one open request per printer: the card continues it');
  assert.match(card, /<ClaimRow key=\{cl\.id\} claim=\{cl\}/, 'the device’s open requests are on its card');
  assert.match(card, /data-device-offer=\{offering\.id\}[\s\S]*?c\.offerWaiting\(/, 'a live offer is said on the card');
  assert.match(card, /<CoverTimeline device=\{device\}/);
  assert.match(card, /<CarePanel care=\{care\}/);

  const page = codeOf('src/pages/Warranty.tsx');
  assert.match(page, /claims=\{claimsByUnit\.get\(d\.unit_id\)\}/);
});

// ---------------------------------------------------------------- the page

test('the page: printers first, «إضافة طابعة» secondary once there is one, notices that stay', () => {
  const page = codeOf('src/pages/Warranty.tsx');
  const devicesAt = page.indexOf('id="warranty-devices-title"');
  const claimsAt = page.indexOf('id="warranty-claims-title"');
  const howAt = page.indexOf('id="warranty-how-title"');
  assert.ok(devicesAt > 0 && devicesAt < claimsAt && claimsAt < howAt, 'my printers → my claims → how the cover works');

  // The add panel: always open with no printer; behind the heading's button once there is one.
  assert.match(page, /\{devicesReady && hasDevices && addOpen && <AddDevicePanel [^>]*onClose=\{closeAdd\} \/>\}/);
  assert.match(page, /aria-expanded=\{addOpen\}\s*aria-controls="warranty-add"/);
  assert.match(page, /data-warranty-empty[\s\S]*?\{s\.emptyCta\}[\s\S]*?<AddDevicePanel lang=\{lang\} s=\{s\} refreshKey=\{refreshKey\} onLinked=\{onLinked\} \/>/, 'the empty state leads to adding a printer');
  assert.equal((page.match(/<AddDevicePanel /g) ?? []).length, 2);
  assert.match(codeOf('src/components/warranty/AddDevicePanel.tsx'), /<section id="warranty-add"/);

  // Notices wait for their own X: no timer puts them away.
  assert.doesNotMatch(page, /setTimeout/);
  assert.match(page, /<NoticeStack notices=\{notices\} onDismiss=\{dismiss\} dismissLabel=\{s\.dismiss\} \/>/);
  const notices = codeOf('src/components/warranty/Notices.tsx');
  assert.match(notices, /aria-live="polite"/);
  assert.match(notices, /onClick=\{\(\) => onDismiss\(n\.id\)\}\s*aria-label=\{dismissLabel\}/);
  assert.doesNotMatch(notices, /setTimeout/);

  // Loading, failing and empty are each their own state.
  assert.match(page, /devicesLoading \? \(\s*<SkeletonGroup/);
  assert.match(page, /<ErrorState error=\{devicesError\} onRetry=\{loadDevices\} \/>/);
  assert.match(page, /<ErrorState error=\{claimsError\} onRetry=\{loadClaims\} \/>/);

  // A live part offer is said outside the conversation, and opens it.
  assert.match(page, /data-warranty-offers=\{offersLive\}/);
  assert.match(page, /c\.offerWaiting\(offersLive, /);
  // The two doors every existing capability still goes through.
  for (const door of ["'/api/devices/mine'", "'/api/devices/claims'", '/registration`']) assert.ok(page.includes(door), door);
});

test('a claim says outside its conversation what waits inside it', () => {
  const base = { id: 'wc1', subject: 's', stage: 'diagnosing' } as unknown as Claim;
  assert.equal(claimWaiting(base, 'ar', CARE_STRINGS.ar), null);
  assert.equal(claimWaiting({ ...base, part_offers_live: 1 }, 'ar', CARE_STRINGS.ar), 'لديك عرض قطعة بخصم ليفو كير');
  assert.match(claimWaiting({ ...base, part_offers_live: 3 }, 'ar', CARE_STRINGS.ar) ?? '', /3 عروض/);
  assert.equal(claimWaiting({ ...base, care_quote_state: 'quoted' }, 'ar', CARE_STRINGS.ar), CARE_STRINGS.ar.quoteWaiting);
  const card = codeOf('src/components/warranty/ClaimCard.tsx');
  assert.equal((card.match(/claimWaiting\(claim, lang, c\)/g) ?? []).length, 2, 'the card in «مطالباتي» and the row on the printer');
});

// ------------------------------------------------------------ the claim form

test('the claim form: the choice of D8 only with Care in force, and `kind: \'care\'` only when chosen', () => {
  const form = codeOf('src/components/warranty/ClaimForms.tsx');
  assert.match(form, /const careActive = shown\?\.care\?\.state === 'active';/);
  assert.match(form, /\{careActive && \(\s*<fieldset data-claim-kind-choice=\{kind\}>/);
  assert.match(form, /k === 'care' \? s\.kindCare : s\.kindWarranty/);
  assert.match(form, /k === 'care' \? s\.kindCareSub : s\.kindWarrantySub/, 'one line each on what it is');
  assert.match(form, /const sentAs: ClaimKind = careActive && kind === 'care' \? 'care' : 'warranty';/);
  assert.match(form, /\.\.\.\(sentAs === 'care' \? \{ kind: 'care' \} : \{\}\)/);
  // The window opens on the kind of the button that raised it, at the same boundary the key is minted.
  assert.match(form, /if \(unitId\) \{[\s\S]*?setKind\(openedAsRef\.current\);[\s\S]*?claimKey\.current = newIdempotencyKey\(\);/);
  for (const lang of LANGS) {
    assert.ok(CLAIM_STRINGS[lang].kindWarrantySub.length > 20 && CLAIM_STRINGS[lang].kindCareSub.length > 20, lang);
  }
  assert.match(CLAIM_STRINGS.ar.kindCareSub, /خصم على القطعة التي تحتاجها/);
  assert.match(CLAIM_STRINGS.ar.kindCareSub, /انتهى الضمان/);
  assert.match(CLAIM_STRINGS.ar.kindCareSub, /من الاستخدام/);
  const page = codeOf('src/pages/Warranty.tsx');
  assert.match(page, /sentKind\.current === 'care' \? s\.careSubmitted : s\.claimSubmitted/);
});

// --------------------------------------------------------------- the offer

const grant = (over: Partial<PartGrantPublic> = {}): PartGrantPublic => ({
  id: 'cpg_1',
  claim_id: 'wc1',
  product: { id: 'p_nozzle', slug: 'nozzle-04', name: 'Hardened nozzle 0.4', name_ar: 'فوهة مقسّاة 0.4', name_ku: 'نۆزڵی ڕەق 0.4', image: '', needs_choices: false, available: true },
  discount_pct: 30,
  max_discount_iqd: null,
  price_iqd: 25_000,
  discount_iqd: 7_500,
  after_iqd: 17_500,
  state: 'live',
  expires_at: iso(10),
  created_at: iso(-4),
  used_order_id: null,
  discount_given_iqd: null,
  ...over,
});

const offer = (g: PartGrantPublic, lang: Lang = 'ar') =>
  renderToStaticMarkup(createElement(MemoryRouter, null, createElement(PartOfferCard, { grant: g, lang, c: CARE_STRINGS[lang] })));

test('the part offer: a product card — name, both prices, the percentage, until when, and the cart action', () => {
  const html = offer(grant());
  assert.match(html, /data-part-grant="cpg_1"/);
  assert.match(html, /data-part-grant-state="live"/);
  assert.match(html, /فوهة مقسّاة 0\.4/);
  assert.match(html, /خصم ليفو كير 30%/);
  assert.match(html, /line-through/, 'the price before is struck');
  assert.match(html, /العرض ساري حتى/);
  assert.match(html, /data-part-grant-add[^>]*>[\s\S]*?أضف إلى السلة/);
  assert.match(html, /data-part-grant-auto/, 'it says the discount applies by itself, once, on this account');
  assert.doesNotMatch(html, /data-part-grant-choose/);

  const withChoices = offer(grant({ product: { ...grant().product!, needs_choices: true } }));
  assert.match(withChoices, /<a [^>]*data-part-grant-choose[^>]*>اختر الخيارات/);
  assert.match(withChoices, /<a [^>]*href="\/product\/nozzle-04"[^>]*>اختر الخيارات/, 'the product’s own page, where the options are chosen');
  assert.doesNotMatch(withChoices, /data-part-grant-add/);

  assert.match(offer(grant(), 'ckb'), /نۆزڵی ڕەق 0\.4/, 'the Sorani name');
});

test('the part offer: used, revoked, expired and a deleted product each say what happened, with no action', () => {
  const used = offer(grant({ state: 'used', used_order_id: 'ORD-9', discount_given_iqd: 7_500 }));
  assert.match(used, /data-part-grant-state="used"/);
  assert.match(used, /href="\/orders\/ORD-9"/);
  for (const state of ['revoked', 'expired'] as const) {
    const html = offer(grant({ state }));
    assert.match(html, new RegExp(`data-part-grant-state="${state}"`));
    assert.doesNotMatch(html, /data-part-grant-add|data-part-grant-choose|line-through/, `${state}: no action and no price promised`);
  }
  assert.match(offer(grant({ state: 'revoked' })), /ألغى الفريق هذا العرض/);
  assert.match(offer(grant({ product: null, price_iqd: null, discount_iqd: null, after_iqd: null })), /هذه القطعة لم تعد في المتجر/);
  assert.doesNotMatch(offer(grant({ product: { ...grant().product!, available: false } })), /data-part-grant-add/);
});

test('the part offer adds through the cart’s own door, and the conversation draws it from the message', () => {
  const card = codeOf('src/components/warranty/PartOfferCard.tsx');
  assert.match(card, /await api\.post\('\/api\/cart\/items', \{ productId: p\.id, qty: 1 \}\);/, 'the same POST every add uses — the cart badge follows it');
  assert.match(card, /state === 'added' \? \([\s\S]*?<Link to="\/cart"[\s\S]*?\{c\.goCart\}/, 'after adding, the way to the cart');
  assert.match(card, /apiRefusal\(e, refusalLang\(lang\), c\.addFailed\)/, 'a refusal in the reader’s language');

  const thread = codeOf('src/components/warranty/ClaimThreadOverlay.tsx');
  assert.match(thread, /msg\.part_grant_id \? \(detail\.care\?\.part_grants \?\? \[\]\)\.find\(\(g\) => g\.id === msg\.part_grant_id\) : undefined/);
  assert.match(thread, /<PartOfferCard grant=\{grant\} lang=\{lang\} c=\{CARE_STRINGS\[lang\]\} \/>/);
  // The quote and its acceptance are still there.
  assert.match(thread, /<CareQuoteBox claimId=\{claimId\} quote=\{detail\.care\.quote\}/);
  assert.match(codeOf('src/components/warranty/CareQuoteBox.tsx'), /\/care-quote\/accept`, \{ version: quote\.version \}/);
});

// ------------------------------------------------------- cart and checkout

test('the cart: «خصم ليفو كير» on its line and on its own row, taken exactly once', () => {
  const page = codeOf('src/pages/Cart.tsx');
  assert.match(page, /care_offers\?: CartCareOffer\[\];/);
  assert.match(page, /setCareOffers\(Array\.isArray\(data\.care_offers\) \? data\.care_offers : \[\]\);/, 'an older server sends none: nothing breaks');
  // It rides in `couponGoods` — so the total, the points cap and the delivery basis take it once —
  assert.match(page, /const couponGoods = selectedItems\.reduce\(\(sum, item\) => sum \+ \(coupons\.lineAmounts\.get\(item\.id\) \?\? 0\), 0\) \+ careGoods;/);
  assert.equal((page.match(/- careGoods/g) ?? []).length, 2, 'and is taken back out only to NAME the coupon row beside it');
  // — and is named on its own row and on the line it lands on.
  assert.match(page, /\{couponGoods - careGoods > 0 && \(\s*<div[^>]*data-cart-coupon-goods/);
  assert.match(page, /\{careGoods > 0 && \(\s*<div[^>]*data-cart-care-offer>[\s\S]*?loc\('خصم ليفو كير', 'Levo Care discount', 'داشکاندنی لیڤۆ کێر'\)/);
  assert.match(page, /data-cart-line-care=\{item\.id\}/);
  // Never more than the line still costs, and only on a ticked line.
  assert.match(page, /const line = selectedItems\.find\(\(i\) => i\.id === offer\.cart_item_id\);/);
  assert.match(page, /Math\.min\(Math\.max\(0, Math\.floor\(Number\(offer\.discount_iqd\) \|\| 0\)\), room\)/);
});

test('the checkout: the Care row is split out of the server’s coupon figure, never added to it', () => {
  const page = codeOf('src/pages/Checkout.tsx');
  assert.match(page, /care_offer_discount_iqd\?: number;/);
  assert.match(
    page,
    /const careOfferOff = Math\.min\(Math\.max\(0, Number\(quote\?\.care_offer_discount_iqd\) \|\| 0\), Math\.max\(0, Number\(quote\?\.coupon\?\.discount_iqd\) \|\| 0\)\);/,
    'never more than the coupon figure it is part of'
  );
  assert.match(page, /const codeOff = Math\.max\(0, \(Number\(quote\?\.coupon\?\.discount_iqd\) \|\| 0\) - careOfferOff\);/);
  assert.match(page, /\{quote\?\.coupon && codeOff > 0 && \(/, 'the code’s row carries what is left after the Care part');
  assert.match(page, /\{careOfferOff > 0 && \(\s*<div[^>]*data-checkout-care-offer>/);
  assert.match(page, /for \(const o of quote\?\.care_offers \?\? \[\]\)/, 'an older server sends none');
  assert.match(page, /data-checkout-line-care=\{line\.key\}/);
  // The total on screen stays the server's: nothing here recomputes it.
  assert.doesNotMatch(page, /total_iqd - careOfferOff|total - careOfferOff/);
  const promo = page.indexOf("loc('خصم الكود', 'Promo discount', 'داشکاندنی کۆد')");
  const careRow = page.indexOf('data-checkout-care-offer');
  const points = page.indexOf("loc('خصم النقاط', 'Points Discount', 'داشکاندنی خاڵ')");
  assert.ok(promo > 0 && promo < careRow && careRow < points, 'code → Levo Care → points');
});

// ------------------------------------------------------ where Care is sold

test('where Care is sold: 12 months AFTER the warranty, the total for the choice, a discount and not a replacement', () => {
  for (const lang of LANGS) {
    const s = PS_STRINGS[lang];
    assert.match(s.careSub(40), /12/, lang);
    assert.match(s.careSub(40), /40%/, lang);
    assert.match(s.careSub(40), /بعد الضمان|after the warranty|دوای گەرەنتی/, lang);
    assert.match(s.careSub(40), /لا استبدال مجاني|not a free replacement|گۆڕینی بەخۆڕایی نییە/, lang);
    assert.match(s.careOption(24), /24/, `${lang}: 12 months of warranty + Care = 24`);
    assert.match(s.careOption(36), /36/, `${lang}: 24 months of warranty + Care = 36`);
    assert.doesNotMatch(s.careOption(12), /\+/, `${lang}: without a warranty it is 12 months of Care, nothing added to anything`);
  }
  assert.notEqual(PS_STRINGS.ckb.careSub(40), PS_STRINGS.ar.careSub(40));
  const sheet = codeOf('src/components/product/CustomizeSheet.tsx');
  assert.match(sheet, /label: s\.careOption\(draft\.warranty === 'w24' \? 36 : draft\.warranty === 'w12' \? 24 : 12\)/, 'the total follows the warranty chosen in the same sheet');
  assert.match(codeOf('src/components/product/PrinterPackages.tsx'), /if \(inc\.care === 'c12'\) parts\.push\(`\$\{s\.care\} \+\$\{s\.months\(12\)\}`\);/);
});
