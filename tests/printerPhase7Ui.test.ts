/**
 * «خصص طابعتك» phase 7 — the customer's side (owner, 2026-11-20; DECISIONS row 363).
 *
 *  - Delivery leaves the card and the sheet when the owner decides it at checkout; a disabled
 *    Personal is listed nowhere; an offer with neither switch draws exactly what it drew.
 *  - The agreement gate: what `needsAck` is, what a no-warranty choice gives up, and that the
 *    page's button is marked from the lazy card (the product page's opening pays nothing).
 *  - «إرجاع مجاني خلال 7 أيام»: one constant, every sentence built from it, three languages.
 *  - THE SHEET'S TOTAL: the printer × its quantity + the kit + the add-ons + the membership.
 *
 * Run: node --import tsx --test tests/printerPhase7Ui.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PRINTER_SERVICES, servicesOffer, type PrinterServicesConfig } from '../packages/pricing/src/printerServices';
import {
  EMPTY_SELECTION, asksDelivery, deliveryAtCheckout, deliveryChoices, lostWith, needsAck, presetFrom, readyToBuy, sheetTotal, verdictOf,
  type ServiceSelection, type ServicesOffer,
} from '../src/components/product/printerServicesModel';
import { PS_STRINGS, WARRANTY_FREE_RETURN_DAYS, ackSentence } from '../src/components/product/printerServicesStrings';
import { EXPLAIN } from '../src/components/product/printerServicesExplain';
import { S } from '../src/components/adminPrinterServices/adminPrinterStrings';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const LANGS = ['ar', 'en', 'ckb'] as const;

const list = (over: (c: PrinterServicesConfig) => void = () => undefined): PrinterServicesConfig => {
  const c = structuredClone(DEFAULT_PRINTER_SERVICES) as PrinterServicesConfig;
  c.price_anchor = 'smart';
  c.delivery.pickup = { active: true, note: null };
  over(c);
  return c;
};
const offerOf = (c: PrinterServicesConfig): ServicesOffer => servicesOffer(c, { warranty_family: 'a1', delivery_class: 'd1' });
const today = offerOf(list());
const atCheckout = offerOf(list((c) => { c.delivery.choose_at = 'checkout'; c.delivery.personal_active = false; }));
const noPersonal = offerOf(list((c) => { c.delivery.personal_active = false; }));
const just = (o: ServicesOffer, ack: boolean): ServiceSelection => ({ ...(presetFrom(o, 'just', null) as ServiceSelection), confirmed: true, ack_no_warranty: ack });

test('delivery on the page: asked as before without the switches, not asked when the checkout decides, Personal gone when disabled', () => {
  assert.deepEqual([deliveryAtCheckout(today), asksDelivery(today), deliveryChoices(today)], [false, true, ['economy', 'personal', 'pickup']]);
  assert.deepEqual([deliveryAtCheckout(noPersonal), asksDelivery(noPersonal), deliveryChoices(noPersonal)], [false, true, ['economy', 'pickup']]);
  assert.deepEqual([deliveryAtCheckout(atCheckout), asksDelivery(atCheckout), deliveryChoices(atCheckout)], [true, false, []]);
  // An older server sends neither key.
  assert.equal('choose_at' in today.delivery! || 'personal_active' in today.delivery!, false);
  // A choice is complete without a delivery only when the page does not ask for one.
  const smart = { ...(presetFrom(today, 'smart', null) as ServiceSelection), confirmed: true };
  assert.equal(readyToBuy(smart, today), false, 'today: the delivery is still required');
  assert.equal(readyToBuy(smart, atCheckout), true, 'decided at checkout: the add does not wait for it');
  assert.equal(readyToBuy({ ...smart, delivery: 'economy' }, today), true);
  // A delivery the page no longer asks for is not carried into a tapped package.
  assert.equal(presetFrom(atCheckout, 'smart', 'economy')!.delivery, null);
  assert.equal(presetFrom(noPersonal, 'smart', 'personal')!.delivery, null);
  assert.equal(presetFrom(noPersonal, 'smart', 'pickup')!.delivery, 'pickup');
  assert.equal(presetFrom(today, 'smart', 'personal')!.delivery, 'personal');
  // The card and the sheet draw the block through the same test.
  const card = code('src/components/product/PrinterPackages.tsx');
  assert.match(card, /\{asksDelivery\(offer\) \? \(\s*<div className="mt-4">/);
  assert.doesNotMatch(card, /\{offer\.delivery \? \(/);
  const sheet = code('src/components/product/CustomizeSheet.tsx');
  assert.match(sheet, /set\(\{ delivery: v as DeliveryChoice \}\)\), !asksDelivery\(offer\)\)\}/);
  assert.match(sheet, /asksDelivery\(offer\) && draft\.delivery === null \? s\.deliveryChoose/);
});

test('the agreement gate: needed for a confirmed choice without a warranty until the box is ticked', () => {
  assert.equal(needsAck(null), false);
  assert.equal(needsAck({ ...EMPTY_SELECTION }), false, 'nothing is confirmed yet');
  assert.equal(needsAck(just(atCheckout, false)), true);
  assert.equal(needsAck(just(atCheckout, true)), false, 'ticked: the button is itself again at once');
  assert.equal(needsAck({ ...(presetFrom(atCheckout, 'smart', null) as ServiceSelection), confirmed: true }), false);
  // The page's add stays refused while gated (the card's verdict), and is ready the moment it is ticked.
  const priced = { fee_iqd: 0, warranty_months: 0, delivery_fee_iqd: null, blockers: ['SERVICES_NO_WARRANTY_ACK'] };
  assert.equal(verdictOf(just(atCheckout, false), atCheckout, priced, 'fresh'), 'incomplete');
  assert.equal(verdictOf(just(atCheckout, true), atCheckout, { ...priced, blockers: [] }, 'fresh'), 'ready');
});

test('the gate rides the lazy card: the page\'s button is marked aria-disabled and muted, never disabled, and a press points at the box', () => {
  const card = code('src/components/product/PrinterPackages.tsx');
  assert.match(card, /const PAGE_ADD = '\[data-testid="product-cta"\]';/);
  assert.match(card, /el\.setAttribute\('aria-disabled', 'true'\);/);
  assert.doesNotMatch(card, /el\.disabled|setAttribute\('disabled'/, 'the press must still arrive');
  assert.match(card, /document\.addEventListener\('click', onPress, true\);/);
  assert.match(card, /const gated = needsAck\(shown\);/);
  assert.match(card, /pointAtAgreement\(ackBox\.current\);/);
  assert.match(card, /data-agreement-ask>\{s\.ackAsk\}/);
  // The product page still names the button the card looks for, and holds no gate code of its own.
  const page = read('src/pages/Product.tsx');
  assert.match(page, /data-testid="product-cta"/);
  assert.doesNotMatch(page, /needsAck|agreementGate|pointAtAgreement/);
  // Reduced motion: nothing animates and the jump is instant; the static outline is the cue.
  const model = code('src/components/product/printerServicesModel.ts');
  assert.match(model, /prefers-reduced-motion: reduce/);
  assert.match(model, /behavior: calm \? 'auto' : 'smooth'/);
  assert.match(model, /if \(!calm\) box\.animate\?\.\(/);
  assert.match(model, /iterations: 3/);
  // The sheet: its buttons look disabled but are pressed, and the press opens the warranty row.
  const sheet = code('src/components/product/CustomizeSheet.tsx');
  assert.equal((sheet.match(/disabled=\{!ready && !ackMissing\}\s+aria-disabled=\{ackMissing \|\| undefined\}/g) ?? []).length, 3);
  assert.match(sheet, /const askAgreement = \(\) => \{ setOpenRow\('warranty'\); setPointed\(\(n\) => n \+ 1\); \};/);
});

test('what a choice without a warranty gives up is read from the choice — and the box says the same in one sentence', () => {
  assert.deepEqual(lostWith(just(today, false)), ['warranty', 'care', 'services', 'return']);
  assert.deepEqual(lostWith({ ...just(today, false), package: 'custom', care: 'c12' }), ['warranty', 'return'], 'Care was chosen: it is not listed as lost');
  assert.deepEqual(lostWith({ ...just(today, false), package: 'custom', packaging: 'extra' }), ['warranty', 'care', 'return'], 'a service was chosen: «no Levo services» would be false');
  assert.deepEqual(lostWith({ ...(presetFrom(today, 'smart', null) as ServiceSelection) }), [], 'a warranty: nothing is given up');
  assert.deepEqual(PS_STRINGS.ar.lose, { warranty: 'بلا ضمان', care: 'بلا ليفو كير', services: 'بلا أي خدمات ليفو', return: 'بلا إرجاع مجاني' });
  assert.deepEqual(PS_STRINGS.en.lose, { warranty: 'No warranty', care: 'No Levo Care', services: 'No Levo services', return: 'No free return' });
  assert.equal(ackSentence(PS_STRINGS.ar, lostWith(just(today, false))), 'أفهم وأوافق: بلا ضمان، بلا ليفو كير، بلا أي خدمات ليفو، بلا إرجاع مجاني');
  assert.equal(ackSentence(PS_STRINGS.en, ['warranty', 'return']), 'I understand and agree: No warranty, No free return');
  assert.equal(PS_STRINGS.ar.ackAsk, 'ضع علامة على «أفهم وأوافق» لإضافة الطابعة');
  assert.equal(PS_STRINGS.en.ackAsk, 'Tick “I understand and agree” to add the printer');
  assert.equal(PS_STRINGS.ckb.ackAsk, 'نیشانەی «تێدەگەم و ڕازیم» بکە بۆ زیادکردنی پرینتەرەکە');
  for (const lang of LANGS) {
    const s = PS_STRINGS[lang];
    assert.ok(s.ackAsk.includes(s.ackLead), `${lang}: the message names the box by its own words`);
    for (const k of ['warranty', 'care', 'services', 'return'] as const) assert.ok(s.lose[k].trim().length > 3, `${lang}.${k}`);
  }
  for (const k of ['warranty', 'care', 'services', 'return'] as const) assert.notEqual(PS_STRINGS.ckb.lose[k], PS_STRINGS.ar.lose[k], k);
  const card = code('src/components/product/PrinterPackages.tsx');
  assert.match(card, /\{t\.id === 'just' && on \? ackPanel : null\}/, 'right under «الطابعة فقط»');
  assert.match(card, /<X aria-hidden="true" className="h-3\.5 w-3\.5 shrink-0 text-danger" \/> \{s\.lose\[k\]\}/);
  assert.match(card, /<span>\{ackSentence\(s, lost\)\}<\/span>/);
});

test('«إرجاع مجاني خلال 7 أيام»: one number, every sentence built from it, three languages, nothing added', () => {
  assert.equal(WARRANTY_FREE_RETURN_DAYS, 7);
  assert.equal(PS_STRINGS.ar.freeReturn, 'إرجاع مجاني خلال 7 أيام');
  assert.equal(PS_STRINGS.en.freeReturn, 'Free return within 7 days');
  assert.equal(PS_STRINGS.ckb.freeReturn, 'گەڕاندنەوەی بەخۆڕایی لە ماوەی 7 ڕۆژدا');
  assert.equal(PS_STRINGS.ar.freeReturnWith, 'مع الضمان: إرجاع مجاني خلال 7 أيام');
  // The number is typed once: no other «7» sits beside «return» in the customer's words.
  const strings = read('src/components/product/printerServicesStrings.ts');
  assert.equal((strings.match(/WARRANTY_FREE_RETURN_DAYS = 7;/g) ?? []).length, 1);
  assert.doesNotMatch(code('src/components/product/printerServicesStrings.ts'), /(خلال|within|ماوەی) 7 /);
  assert.doesNotMatch(code('src/components/product/printerServicesExplain.ts'), /(خلال|within|ماوەی) 7 /);
  for (const lang of LANGS) {
    const s = PS_STRINGS[lang];
    const x = EXPLAIN[lang];
    assert.ok(x.warrantySum.endsWith(s.freeReturn), `${lang}: the sheet's warranty summary says it`);
    assert.ok(s.freeReturn.includes(String(WARRANTY_FREE_RETURN_DAYS)) && s.freeReturnWith.includes(String(WARRANTY_FREE_RETURN_DAYS)), lang);
  }
  // The card's package rows and the sheet's two warranty options say it; «none» does not.
  const card = code('src/components/product/PrinterPackages.tsx');
  assert.match(card, /if \(inc\.warranty !== 'none'\) parts\.push\(`\$\{s\.warranty\} \$\{s\.months\(inc\.warranty === 'w12' \? 12 : 24\)\}`, s\.freeReturn\);/);
  const sheet = code('src/components/product/CustomizeSheet.tsx');
  assert.match(sheet, /\{ \.\.\.opt\('warranty', 'w12' as const, s\.months\(12\)\), sub: s\.freeReturn \},\s*\{ \.\.\.opt\('warranty', 'w24' as const, s\.months\(24\)\), sub: s\.freeReturn \},/);
  assert.match(sheet, /opt\('warranty', 'none' as const, s\.none\),/);
  assert.match(sheet, /includes\('warranty', x\.warranty, false, `\$\{s\.freeReturnWith\}\.`\)/, '«ماذا يشمل؟» says it first');
});

test('the checkout names the home method «توصيل إلى المنزل» only for an order whose printer\'s delivery is decided there; the cart line says where', () => {
  assert.deepEqual(LANGS.map((l) => PS_STRINGS[l].homeDelivery), ['توصيل إلى المنزل', 'Delivery to home', 'گەیاندن بۆ ماڵەوە']);
  assert.deepEqual([...S.pvHome], ['توصيل إلى المنزل', 'Delivery to home', 'گەیاندن بۆ ماڵەوە']);
  assert.equal(PS_STRINGS.ar.atCheckout, 'يُحدَّد التوصيل عند إتمام الطلب');
  const checkout = code('src/pages/Checkout.tsx');
  assert.match(checkout, /const printerHomeDelivery = items\.some\(\(item\) => \(item\.printer_services\?\.offer\?\.delivery as \{ choose_at\?: string \} \| null \| undefined\)\?\.choose_at === 'checkout'\);/);
  assert.match(checkout, /\{printerHomeDelivery && method\.id === 'standard' \? PS_STRINGS\[psLang\]\.homeDelivery : methodTitle\(method, lang\)\}/);
  const cart = code('src/pages/Cart.tsx');
  assert.match(cart, /const deliverySaid = deliveryAtCheckout \? w\.atCheckout : /);
  assert.match(cart, /\(deliveryAtCheckout \? w\.choosePackage : w\.chooseFirst\)/);
  for (const lang of LANGS) assert.doesNotMatch(PS_STRINGS[lang].choosePackage, /توصيل|deliver|گەیاندن/i, `${lang}: «choose first» asks for no delivery`);
});

test('the admin panel: the two switches with their explanations, Personal\'s prices kept and marked paused, and the preview follows', () => {
  const tab = code('src/components/adminPrinterServices/SharedPriceListTab.tsx');
  assert.match(tab, /d\.delivery\.choose_at = e\.target\.checked \? 'checkout' : 'product';/);
  assert.match(tab, /d\.delivery\.personal_active = e\.target\.checked;/);
  assert.match(tab, /personalOn \? perWord : `\$\{perWord\} — \$\{say\(loc, S\.personalPaused\)\}`/);
  assert.match(tab, /style=\{personalOn \? undefined : \{ opacity: 0\.55 \}\}/);
  const preview = code('src/components/adminPrinterServices/CustomerPreview.tsx');
  assert.match(preview, /offer\.delivery\.choose_at === 'checkout' \? group\('delivery', S\.pvDelivery, <>\s*\{row\('home', say\(loc, S\.pvHome\), money\(offer\.delivery\.economy\)\)\}/);
  assert.match(preview, /offer\.delivery\.personal_active === false \? null : row\('personal'/);
  for (const key of ['chooseAtSwitch', 'chooseAtHint', 'chooseAtOn', 'personalSwitch', 'personalHint', 'personalPaused', 'pvAtCheckout', 'pvHome', 'pvStorePickup'] as const) {
    const [ar, en, ckb] = S[key];
    assert.ok(ar.trim().length > 3 && en.trim().length > 3 && ckb.trim().length > 3, key);
    assert.notEqual(ckb, ar, `${key}: the Sorani is Sorani`);
  }
  assert.equal(S.personalPaused[0], 'متوقف مؤقتاً');
});

// ---------------------------------------------------------------- the sheet's total

test('sheetTotal: the printer × its quantity + the kit + the add-ons + the membership — the owner\'s own figures', () => {
  // No extras: the printer alone.
  assert.deepEqual(sheetTotal({ unit_iqd: 2_000_000, qty: 1 }), { printer_iqd: 2_000_000, kit_iqd: null, addons_iqd: null, membership_iqd: null, total_iqd: 2_000_000 });
  // Kit only (the report: X2D Combo 2,000,000, «4 × eSUN PLA+» +80,000 — the total stayed 2,000,000).
  assert.equal(sheetTotal({ unit_iqd: 2_000_000, qty: 1, kit_total_iqd: 80_000 }).total_iqd, 2_080_000);
  assert.equal(sheetTotal({ unit_iqd: 2_000_000, qty: 1, kit_total_iqd: 56_000 }).total_iqd, 2_056_000);
  // Kit + two add-ons (their total is one server sum: 28,000 + 12,000).
  assert.deepEqual(sheetTotal({ unit_iqd: 2_000_000, qty: 1, kit_total_iqd: 80_000, addons_total_iqd: 40_000 }),
    { printer_iqd: 2_000_000, kit_iqd: 80_000, addons_iqd: 40_000, membership_iqd: null, total_iqd: 2_120_000 });
  // A random-colour kit whose unit price differs: the total follows the server's new kit figure, nothing else moves.
  assert.equal(sheetTotal({ unit_iqd: 2_000_000, qty: 1, kit_total_iqd: 84_000, addons_total_iqd: 40_000 }).total_iqd, 2_124_000);
  // Quantity 2: the printer is × 2; the kit's and the add-ons' totals are already for both printers.
  assert.deepEqual(sheetTotal({ unit_iqd: 2_000_000, qty: 2, kit_total_iqd: 160_000, addons_total_iqd: 56_000 }),
    { printer_iqd: 4_000_000, kit_iqd: 160_000, addons_iqd: 56_000, membership_iqd: null, total_iqd: 4_216_000 });
  // The membership is charged once per order, whatever the quantity.
  assert.equal(sheetTotal({ unit_iqd: 688_000, qty: 2, membership_iqd: 25_000 }).total_iqd, 1_401_000);
  // The owner's expected totals — the unit is the server's (services inside, net of the anchor).
  assert.equal(sheetTotal({ unit_iqd: 644_000, qty: 1, kit_total_iqd: 11_000 }).total_iqd, 655_000, 'A1 Just Printer (688,000 − 44,000) + 1 spool');
  assert.equal(sheetTotal({ unit_iqd: 688_000, qty: 1, kit_total_iqd: 87_000 }).total_iqd, 775_000, 'A1 Smart + 4 spools');
  assert.equal(sheetTotal({ unit_iqd: 888_000, qty: 1, kit_total_iqd: 81_000 }).total_iqd, 969_000, 'A1 Combo');
  assert.equal(sheetTotal({ unit_iqd: 1_840_000, qty: 1, kit_total_iqd: 59_000 }).total_iqd, 1_899_000, 'U1');
  // No printer figure yet: no total — never the extras alone; a bad quantity is one printer.
  assert.equal(sheetTotal({ unit_iqd: null, qty: 1, kit_total_iqd: 80_000 }).total_iqd, null);
  assert.equal(sheetTotal({ unit_iqd: 100, qty: 0 }).total_iqd, 100);
  assert.equal(sheetTotal({ unit_iqd: 100, qty: Number.NaN, kit_total_iqd: Number.NaN }).total_iqd, 100);
});

test('the sheet\'s footer shows that total, each part as its own row, and holds it back while a chosen extra is not priced', () => {
  const sheet = code('src/components/product/CustomizeSheet.tsx');
  assert.match(sheet, /const total = sheetTotal\(\{ unit_iqd: unit, qty: printerQty, kit_total_iqd: kitTotal, addons_total_iqd: addonsTotal, membership_iqd: memberCharge \}\);/);
  assert.match(sheet, /const printerQty = Math\.max\(1, Math\.trunc\(Number\(kitsFor\?\.qty\) \|\| 1\)\);/);
  assert.match(sheet, /const grand = extrasPending \? null : total\.total_iqd;/);
  assert.match(sheet, /\{grand === null \? '—' : money\(grand\)\}/);
  assert.doesNotMatch(sheet, /\{unit === null \? '—' : money\(unit\)\}/, 'the printer\'s unit alone is no longer «the total»');
  for (const row of ['data-sheet-printer-line', 'data-sheet-kit-total', 'data-sheet-addons-total', 'data-sheet-membership-charge', 'data-sheet-no-delivery']) assert.ok(sheet.includes(row), row);
  assert.doesNotMatch(sheet, /extrasApart/, '«outside this total» is no longer true');
  // A partial sum is never the add-ons' total.
  assert.match(sheet, /addonTotals\.length && addonTotals\.length === addonIds\.length/);
  assert.deepEqual(LANGS.map((l) => PS_STRINGS[l].printerLine), ['الطابعة مع الخدمات', 'Printer with services', 'پرینتەر لەگەڵ خزمەتگوزارییەکان']);
  for (const lang of LANGS) assert.ok(PS_STRINGS[lang].totalNoDelivery.trim().length > 10, lang);
  // The card keeps the page's price as the printer's and names the extras beside it.
  assert.match(code('src/components/product/PrinterPackages.tsx'), /<p>\{s\.extrasBeside\}<\/p>/);
});

// ---------------------------------------------------------------- the follow-up round

test('follow-up: the PRO lines do not advertise Personal delivery while the owner has it disabled — the server says so', async () => {
  const { servicesDiscountLine } = await import('../src/components/subscription/compareModel');
  const tri = (ar: string, en: string, ckb?: string) => [ar, en, ckb ?? ''].join(' | ');
  assert.match(servicesDiscountLine(50, tri), /التوصيل الشخصي.*Personal delivery.*گەیاندنی تایبەت/, 'offered (and absent): as before');
  assert.equal(servicesDiscountLine(50, tri, true), servicesDiscountLine(50, tri));
  const off = servicesDiscountLine(50, tri, false);
  assert.doesNotMatch(off, /الشخصي|Personal|تایبەت/);
  assert.match(off, /50%.*50%.*50%/);
  const model = code('src/components/subscription/compareModel.ts');
  assert.match(model, /const personal = proExtras\?\.personal_delivery !== false;/);
  assert.match(model, /servicesDiscountLine\(pct, loc, proExtras\?\.personal_delivery !== false\)/);
  // The fact is the published list's own switch, sent only while it is off.
  assert.match(code('worker/routes/memberships.ts'), /\.\.\.\(servicesConfig && !personalActiveOf\(servicesConfig\) \? \{ personal_delivery: false as const \} : \{\}\),/);
});

test('follow-up: the refusal sentences are true whether delivery is chosen on the page or at checkout, and name no Personal', async () => {
  const { REFUSAL_STRINGS } = await import('../src/lib/refusalStrings');
  const { SERVICES_ERRORS } = await import('../src/components/product/printerServicesStrings');
  for (const codeName of ['SERVICES_REQUIRED', 'SERVICES_DELIVERY_METHOD', 'SERVICES_DELIVERY_REQUIRED']) {
    assert.deepEqual(SERVICES_ERRORS[codeName], REFUSAL_STRINGS[codeName], codeName);
    for (const lang of LANGS) assert.doesNotMatch(REFUSAL_STRINGS[codeName][lang], /شخصي|Personal|تایبەت/, `${codeName}.${lang}`);
    assert.notEqual(REFUSAL_STRINGS[codeName].ckb, REFUSAL_STRINGS[codeName].ar);
  }
  for (const lang of LANGS) assert.doesNotMatch(REFUSAL_STRINGS.SERVICES_REQUIRED[lang], /توصيل|deliver|گەیاندن/i, `${lang}: a package is all an add needs`);
  // A method the server answers as paused for a serviced printer is never a card.
  assert.match(code('src/pages/Checkout.tsx'), /fee\.id === method\.id && fee\.reason === 'printer_personal_paused'\)\) return false;/);
});
