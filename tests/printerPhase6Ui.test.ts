/**
 * «خصص طابعتك» phase 6 — the customer's side (owner, 2026-11-19; DECISIONS row 362).
 *
 *  - THE ANCHOR'S ARITHMETIC, as pure functions of the offer the server sends: «today's price IS the
 *    Smart Choice price», so Just Printer is a REDUCTION, Smart Choice is «included», Complete is the
 *    difference — and in «تخصيص بنفسي» every choice is a delta against what the price holds.
 *  - The free warehouse pickup row, offered only when the offer carries it.
 *  - An offer with neither field (today's server) draws exactly what it drew before.
 *  - The words: Arabic, English and Sorani; a draw is a chance, Care is a discount.
 *  - The sheet's lists are asked for once and shared (`warmed`), so they are there when it opens.
 *  - The chosen state is the house's own — no white slab — and the bar is compact.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PRINTER_SERVICES, servicesOffer, type PrinterServicesConfig } from '../packages/pricing/src/printerServices';
import {
  anchorOf, anchoredStart, deliveryChoices, deliveryFee, forgetWarmed, includedIn, netFee, optionDelta, packageDelta, pickupOf,
  presetFrom, readyToBuy, removedByJust, signedMoney, warmed, warmedNow, type ServicesOffer,
} from '../src/components/product/printerServicesModel';
import { PS_STRINGS } from '../src/components/product/printerServicesStrings';
import { EXPLAIN } from '../src/components/product/printerServicesExplain';
import { OFFER_STRINGS } from '../src/components/product/printerOfferStrings';
import { preorderDays, readOffers } from '../src/components/product/PrinterOffersRows';
import { resolveTransport, type RouteFacts } from '../src/lib/productSelection';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const LANGS = ['ar', 'en', 'ckb'] as const;

/** The published list's figures (plan-phase6 «Live facts»): w12 25,000 / 29,000, w24 100,000 / 150,000, Care 19,000, extra 7,000, inspection 5,000. */
const config: PrinterServicesConfig = (() => {
  const c = structuredClone(DEFAULT_PRINTER_SERVICES) as PrinterServicesConfig;
  c.warranty.active = true;
  c.warranty.w12 = { a1: 25_000, xpa2: 29_000, h2: 35_000, h3c: 39_000 };
  c.warranty.w24 = { a1: 100_000, xpa2: 150_000, h2: 200_000, h3c: 250_000 };
  c.care.active = true; c.care.price_iqd = 19_000;
  c.packaging.active = true; c.packaging.extra_iqd = 7_000;
  c.inspection.active = true; c.inspection.price_iqd = 5_000;
  c.delivery.active = true;
  c.delivery.classes.d2 = { economy_iqd: 10_000, personal_iqd: 35_000 };
  c.packages.smart = { ...c.packages.smart, active: true, warranty: 'w12', care: 'c12', packaging: 'standard', inspection: 'none', discount_iqd: 0 };
  c.packages.complete = { ...c.packages.complete, active: true, warranty: 'w24', care: 'c12', packaging: 'extra', inspection: 'full', discount_iqd: 0 };
  return c;
})();
/** The offer as TODAY's server sends it: no anchor, no pickup. */
const plain = (family: 'a1' | 'xpa2'): ServicesOffer => {
  const o = structuredClone(servicesOffer(config, { warranty_family: family, delivery_class: 'd2' })) as ServicesOffer & { anchor?: unknown; delivery: Record<string, unknown> | null };
  delete o.anchor;
  if (o.delivery) delete o.delivery.pickup;
  return o;
};
/** The same offer with the phase-6 fields the contract adds. */
const anchored = (family: 'a1' | 'xpa2', pickup = true): ServicesOffer => {
  const o = plain(family) as ServicesOffer & { anchor?: unknown; delivery: Record<string, unknown> | null };
  o.anchor = { package: 'smart', fee_iqd: o.packages.smart!.price_iqd };
  if (pickup && o.delivery) o.delivery.pickup = { note: { ar: 'مخزن بغداد', en: 'Baghdad warehouse', ckb: 'کۆگای بەغدا' } };
  return o;
};

// ---------------------------------------------------------------- the anchor's arithmetic

test('the anchor: Just Printer is a reduction, Smart Choice is included, Complete is the difference (xpa2 — the P1S)', () => {
  const o = anchored('xpa2');
  assert.deepEqual(anchorOf(o), { package: 'smart', fee_iqd: 48_000 }, 'w12 29,000 + Care 19,000');
  assert.deepEqual(packageDelta(o, 'just'), { iqd: -48_000, included: false });
  assert.deepEqual(packageDelta(o, 'smart'), { iqd: 0, included: true });
  assert.deepEqual(packageDelta(o, 'complete'), { iqd: 133_000, included: false }, '181,000 − 48,000');
  // What leaves the price with «الطابعة فقط», service by service — and it adds up to the anchor.
  assert.deepEqual(removedByJust(o), [{ service: 'warranty', iqd: -29_000 }, { service: 'care', iqd: -19_000 }]);
  // The worked example of the plan: 960,000 = Smart; Just 912,000; Complete 1,093,000.
  const P = 960_000;
  assert.equal(P + packageDelta(o, 'just')!.iqd, 912_000);
  assert.equal(P + packageDelta(o, 'smart')!.iqd, 960_000);
  assert.equal(P + packageDelta(o, 'complete')!.iqd, 1_093_000);
});

test('the anchor on family a1: −44,000 (−25,000 warranty, −19,000 Care), included, +87,000', () => {
  const o = anchored('a1');
  assert.deepEqual(packageDelta(o, 'just'), { iqd: -44_000, included: false });
  assert.deepEqual(removedByJust(o), [{ service: 'warranty', iqd: -25_000 }, { service: 'care', iqd: -19_000 }], 'the owner’s «-25000, -19000»');
  assert.equal(packageDelta(o, 'smart')!.included, true);
  assert.deepEqual(packageDelta(o, 'complete'), { iqd: 87_000, included: false }, '131,000 − 44,000');
});

test('«تخصيص بنفسي» under the anchor: every choice is a delta against what the price includes', () => {
  const o = anchored('a1');
  assert.deepEqual(includedIn(o), { warranty: 'w12', care: 'c12', packaging: 'standard', inspection: 'none' });
  assert.deepEqual(optionDelta(o, 'warranty', 'none'), { iqd: -25_000, included: false });
  assert.deepEqual(optionDelta(o, 'warranty', 'w12'), { iqd: 0, included: true });
  assert.deepEqual(optionDelta(o, 'warranty', 'w24'), { iqd: 75_000, included: false }, '100,000 − 25,000');
  assert.deepEqual(optionDelta(o, 'care', 'none'), { iqd: -19_000, included: false });
  assert.deepEqual(optionDelta(o, 'care', 'c12'), { iqd: 0, included: true });
  assert.deepEqual(optionDelta(o, 'packaging', 'extra'), { iqd: 7_000, included: false });
  assert.deepEqual(optionDelta(o, 'inspection', 'full'), { iqd: 5_000, included: false });
  // «مشمول في السعر» is said of a service the price holds — never of «بدون» or the standard packaging.
  assert.deepEqual(optionDelta(o, 'inspection', 'none'), { iqd: 0, included: false });
  assert.deepEqual(optionDelta(o, 'packaging', 'standard'), { iqd: 0, included: false });
  // The same on xpa2: none −29,000, 24 months +121,000.
  const x = anchored('xpa2');
  assert.equal(optionDelta(x, 'warranty', 'none')!.iqd, -29_000);
  assert.equal(optionDelta(x, 'warranty', 'w24')!.iqd, 121_000);
});

test('without an anchor (today’s server) every figure is the «+» price it always was', () => {
  const o = plain('xpa2');
  assert.equal(anchorOf(o), null);
  assert.equal(anchoredStart(o), null, 'nothing is chosen until the customer taps');
  assert.deepEqual(packageDelta(o, 'just'), { iqd: 0, included: false });
  assert.deepEqual(packageDelta(o, 'smart'), { iqd: 48_000, included: false });
  assert.deepEqual(packageDelta(o, 'complete'), { iqd: 181_000, included: false });
  assert.deepEqual(removedByJust(o), []);
  assert.deepEqual(optionDelta(o, 'warranty', 'w12'), { iqd: 29_000, included: false });
  assert.deepEqual(optionDelta(o, 'warranty', 'none'), { iqd: 0, included: false });
  assert.deepEqual(optionDelta(o, 'care', 'c12'), { iqd: 19_000, included: false });
  assert.equal(netFee({ fee_iqd: 48_000, warranty_months: 12, delivery_fee_iqd: null, blockers: [] }), 48_000, 'no anchor: the fee itself');
});

test('a malformed or unusable anchor is no anchor', () => {
  const o = plain('xpa2');
  const loose = o as unknown as { anchor?: unknown };
  for (const bad of [null, {}, { package: 'complete', fee_iqd: 48_000 }, { package: 'smart', fee_iqd: 0 }, { package: 'smart', fee_iqd: -5 }, { package: 'smart', fee_iqd: 48_000.5 }, { package: 'smart', fee_iqd: '48000' }]) {
    loose.anchor = bad;
    assert.equal(anchorOf(o), null, JSON.stringify(bad));
  }
  // An anchor over a Smart package the offer no longer sells cannot be drawn.
  const gone = anchored('xpa2');
  gone.packages.smart = null;
  assert.equal(anchorOf(gone), null);
  assert.equal(anchoredStart(gone), null);
});

test('a discounted Smart package has no honest per-service split: the tile shows the total alone', () => {
  const o = anchored('xpa2') as ServicesOffer & { anchor: { package: 'smart'; fee_iqd: number } };
  o.anchor = { package: 'smart', fee_iqd: 45_000 };
  assert.deepEqual(removedByJust(o), [], 'the lines (48,000) do not add up to the anchor (45,000)');
  assert.deepEqual(packageDelta(o, 'just'), { iqd: -45_000, included: false }, 'the total is still the server’s anchor');
});

test('the priced choice against the price: the server’s net figure, else fee − anchor', () => {
  const base = { warranty_months: 0, delivery_fee_iqd: null, blockers: [] as string[] };
  assert.equal(netFee({ ...base, fee_iqd: 0, anchor_fee_iqd: 48_000, net_fee_iqd: -48_000 }), -48_000, 'Just Printer');
  assert.equal(netFee({ ...base, fee_iqd: 48_000, anchor_fee_iqd: 48_000, net_fee_iqd: 0 }), 0, 'Smart Choice');
  assert.equal(netFee({ ...base, fee_iqd: 181_000, anchor_fee_iqd: 48_000 }), 133_000, 'derived when the server sent the anchor only');
});

test('an anchored printer opens on Smart Choice, confirmed — and delivery is still the customer’s to choose', () => {
  const o = anchored('xpa2');
  const start = anchoredStart(o)!;
  assert.equal(start.package, 'smart');
  assert.equal(start.confirmed, true, 'it is what the price on the page pays for');
  assert.equal(start.warranty, 'w12');
  assert.equal(start.care, 'c12');
  assert.equal(start.delivery, null, 'delivery is never preselected');
  assert.equal(readyToBuy(start, o), false, 'not buyable until delivery is chosen');
  assert.equal(readyToBuy({ ...start, delivery: 'economy' }, o), true);
  // The card hands it over only while the page holds NO choice (a choice the customer made is never replaced).
  const card = code('src/components/product/PrinterPackages.tsx');
  assert.match(card, /const opening = selection === null \? anchoredStart\(offer\) : null;/);
});

// ---------------------------------------------------------------- the pickup row

test('the delivery rows: Economy, Personal, and the free warehouse pickup only when the offer carries it', () => {
  const off = anchored('xpa2', false);
  assert.equal(pickupOf(off), null);
  assert.deepEqual(deliveryChoices(off), ['economy', 'personal']);
  assert.equal(deliveryFee(off, 'pickup'), null, 'a pickup the offer does not carry has no price: its row cannot be chosen');
  const on = anchored('xpa2');
  assert.deepEqual(deliveryChoices(on), ['economy', 'personal', 'pickup']);
  assert.equal(deliveryFee(on, 'pickup'), 0, 'free');
  assert.equal(deliveryFee(on, 'economy'), 10_000);
  assert.equal(deliveryFee(on, 'personal'), 35_000);
  assert.equal(pickupOf(on)!.note!.ckb, 'کۆگای بەغدا', 'the owner’s note, in the reader’s language');
  // A pickup with no note still shows (the card then says its own line).
  const bare = anchored('xpa2') as ServicesOffer & { delivery: { pickup?: unknown } };
  bare.delivery.pickup = { note: null };
  assert.deepEqual(pickupOf(bare), { note: null });
  // A package tap keeps the pickup while it is offered, and drops it when it is not.
  assert.equal(presetFrom(on, 'complete', 'pickup')!.delivery, 'pickup');
  assert.equal(presetFrom(off, 'complete', 'pickup')!.delivery, null);
  // Delivery switched off altogether: no rows.
  const none = anchored('xpa2');
  none.delivery = null;
  assert.deepEqual(deliveryChoices(none), []);
  // The card and the sheet draw the rows from that one list, with the note.
  const card = code('src/components/product/PrinterPackages.tsx');
  assert.match(card, /const deliveryIds = deliveryChoices\(offer\);/);
  assert.match(card, /pickupOf\(offer\)\?\.note\?\.\[lang\] \|\| s\.deliveryPickupSub/);
  assert.match(code('src/components/product/CustomizeSheet.tsx'), /deliveryChoices\(offer\)\.map\(/);
  // The cart's line names the pickup too.
  assert.match(code('src/pages/Cart.tsx'), /chosenDelivery === 'pickup' \? w\.deliveryPickup/);
});

test('the checkout takes the store’s pickup method when a printer line chose the warehouse', () => {
  const page = code('src/pages/Checkout.tsx');
  assert.match(page, /printer_pickup\?: \{ required: boolean; satisfied: boolean; delivery_method_id: string;/);
  assert.match(page, /const pickupWanted = quote\?\.printer_pickup\?\.required && !quote\.printer_pickup\.satisfied \? quote\.printer_pickup\.delivery_method_id : '';/);
  assert.match(page, /availableDeliveryMethods\.some\(\(method\) => method\.id === pickupWanted\)\) setDeliveryMethod\(pickupWanted\);/, 'only a method the checkout really offers');
});

// ---------------------------------------------------------------- figures with their sign

test('a signed figure keeps its sign in front of the digits in a right-to-left line', () => {
  const ar = (v: number) => `${v.toLocaleString('en-US')} د.ع`;
  const en = (v: number) => `${v.toLocaleString('en-US')} IQD`;
  assert.equal(signedMoney(-48_000, ar), '⁦−48,000⁩ د.ع', 'the sign and the digits are one left-to-right isolate');
  assert.equal(signedMoney(133_000, ar), '⁦+133,000⁩ د.ع');
  assert.equal(signedMoney(-25_000, en), '⁦−25,000⁩ IQD');
  assert.equal(signedMoney(-48_000, () => '$36.64'), '⁦−$36.64⁩', 'a figure with no trailing unit is isolated whole');
  assert.doesNotMatch(signedMoney(-48_000, ar), /-/, 'a real minus sign (U+2212), not a hyphen');
});

// ---------------------------------------------------------------- the words

test('the new words exist in Arabic, English and Sorani, and the Sorani is its own', () => {
  for (const lang of LANGS) {
    const s = PS_STRINGS[lang];
    for (const key of ['included', 'justRemoves', 'deliveryHow', 'deliveryPickup', 'deliveryPickupSub'] as const) assert.ok(s[key].trim().length > 2, `${lang}.${key}`);
    assert.match(s.priceIncludes(s.smart), new RegExp(s.smart), `${lang}: the line names the package the price includes`);
    const x = EXPLAIN[lang];
    for (const key of ['whatIncluded', 'mostImportant', 'warrantySum', 'packagingSum', 'inspectionSum', 'academySum'] as const) assert.ok(x[key].trim().length > 2, `${lang}.${key}`);
    for (const list of [x.warranty, x.care(90), x.packaging, x.inspection(2, 3), x.academy]) {
      assert.ok(list.length >= 3 && list.length <= 5, `${lang}: three to five concrete lines`);
      for (const line of list) assert.ok(line.trim().length > 8, `${lang}: ${line}`);
    }
  }
  assert.equal(PS_STRINGS.ar.included, 'مشمول في السعر');
  assert.equal(PS_STRINGS.en.included, 'Included in the price');
  assert.equal(PS_STRINGS.ckb.included, 'لەناو نرخدایە');
  assert.equal(EXPLAIN.ar.whatIncluded, 'ماذا يشمل؟');
  assert.equal(EXPLAIN.en.whatIncluded, "What's included?");
  assert.equal(EXPLAIN.ckb.whatIncluded, 'چی لەخۆدەگرێت؟');
  // Sorani is never the Arabic copied (DECISIONS row 183).
  const flat = (x: (typeof EXPLAIN)['ar']) => [x.whatIncluded, x.mostImportant, x.warrantySum, x.packagingSum, x.inspectionSum, x.academySum, ...x.warranty, ...x.care(90), ...x.packaging, ...x.inspection(2, 3), ...x.academy];
  const ar = flat(EXPLAIN.ar);
  flat(EXPLAIN.ckb).forEach((line, i) => assert.notEqual(line, ar[i], `ckb line ${i} is the Arabic`));
  for (const key of ['included', 'justRemoves', 'deliveryHow', 'deliveryPickup', 'deliveryPickupSub'] as const) assert.notEqual(PS_STRINGS.ckb[key], PS_STRINGS.ar[key], key);
  assert.match(EXPLAIN.ckb.care(90).join(' '), /[ەێۆڕڵ]/, 'written in Sorani letters');
});

test('the explanations promise nothing the shop does not: Care is a discount, the draw a chance, the warranty a part', () => {
  for (const lang of LANGS) {
    const x = EXPLAIN[lang];
    const care = x.care(40).join(' ');
    assert.match(care, /40%/, `${lang}: the ceiling is the offer’s own figure`);
    assert.match(care, /ليس استبدالاً مجانياً|not a free replacement|گۆڕینی بەخۆڕایی نییە/, `${lang}: Care is not a free replacement`);
    assert.match(care, /وليس وعداً|not a promise|بەڵێن نییە/, `${lang}: the draw is a chance`);
    assert.match(care, /12/, `${lang}: twelve months after the warranty, twelve months of coupons`);
    const warranty = x.warranty.join(' ');
    assert.match(warranty, /عيب مصنعي|factory defect|کەموکوڕیی کارگە/, `${lang}: what the warranty covers`);
    assert.match(warranty, /سوء الاستخدام|misuse|خراپ بەکارهێنان/, `${lang}: what it does not`);
    assert.match(warranty, /الفوهة|nozzle|نۆزڵ/, `${lang}: consumables are named`);
    assert.match(warranty, /وليس استبدالاً للطابعة كاملة|does not swap the whole printer|نەک گۆڕینی هەموو پرینتەرەکە/, `${lang}: a part, not the printer`);
    assert.match(x.inspection(2, 3).join(' '), /2–3/, `${lang}: the offer’s own lead days`);
    // No word of a guarantee the documents do not give.
    assert.doesNotMatch([...x.packaging, ...x.inspection(2, 3)].join(' '), /نضمن|guarantee|مضمون|گەرەنتی دەکەین/, lang);
  }
  // The words ride the sheet's own chunk: nothing else imports them (the product opening, the cart and the checkout stay as they were).
  const sheet = read('src/components/product/CustomizeSheet.tsx');
  assert.match(sheet, /import \{ EXPLAIN \} from '\.\/printerServicesExplain';/);
  for (const rel of ['src/pages/Product.tsx', 'src/pages/Cart.tsx', 'src/pages/Checkout.tsx', 'src/components/product/PrinterPackages.tsx', 'src/components/product/printerServicesStrings.ts', 'src/components/cart/PrinterExtrasLines.tsx']) {
    assert.doesNotMatch(read(rel), /printerServicesExplain/, rel);
  }
  // Each service of the sheet carries its lines; Levo Care wears «الأهم» and opens with them.
  const body = code('src/components/product/CustomizeSheet.tsx');
  for (const key of ['warranty', 'care', 'packaging', 'inspection', 'academy']) assert.match(body, new RegExp(`includes\\('${key}', x\\.${key}`), key);
  assert.match(body, /includes\('care', x\.care\(offer\.care\?\.max_discount_pct \?\? 90\), true\)/);
  assert.match(body, /!offer\.care, x\.mostImportant\)/);
});

// ---------------------------------------------------------------- pre-order add-ons

test('an add-on that is not in stock comes as a pre-order, with its days', () => {
  assert.equal(preorderDays({}), null, 'absent = with the printer');
  assert.equal(preorderDays({ fulfillment: 'with_printer', lead_days: { min: 5, max: 9 } }), null);
  assert.equal(preorderDays({ fulfillment: 'pre_order', lead_days: { min: null, max: 20 } }), '20');
  assert.equal(preorderDays({ fulfillment: 'pre_order', lead_days: { min: 10, max: 20 } }), '⁦10–20⁩', '«min–max» when both, kept left to right');
  assert.equal(preorderDays({ fulfillment: 'pre_order', lead_days: { min: 20, max: 20 } }), '20');
  assert.equal(preorderDays({ fulfillment: 'pre_order' }), '', 'a pre-order with no figure still says so');
  const offers = readOffers({ addons: [
    { id: 'a', name: 'Nozzle', price_per_printer_iqd: 30_500, total_iqd: 30_500 },
    // The server's shape for a part that is not on the shelf (phase6-api.md): not sold WITH the printer.
    { id: 'b', slug: 'nozzle-set', name: 'Nozzle set', available: false, reason: 'ADDON_PREORDER_SEPARATE', price_per_printer_iqd: null, total_iqd: null, fulfillment: 'pre_order', transport: 'land', lead_days: { min: null, max: 20 }, preorder: { transport: 'land', unit_price_iqd: 121_750, lead_days: { min: null, max: 20 } } },
  ] }, 'en');
  assert.deepEqual(offers.addons.map((a) => a.preorder), [null, '20']);
  assert.deepEqual(offers.addons.map((a) => [a.available, a.slug, a.preorder_unit_iqd]), [[true, '', null], [false, 'nozzle-set', 121_750]]);
  for (const lang of LANGS) {
    const s = OFFER_STRINGS[lang];
    assert.match(s.preorder('20'), /20/, lang);
    assert.ok(s.preorder('').length > 3 && !/\d/.test(s.preorder('')), `${lang}: no figure, no number`);
    assert.ok(s.preorderOrder.length > 8, lang);
  }
  assert.equal(OFFER_STRINGS.ar.preorder('20'), 'طلب مسبق · 20 يوماً');
  assert.equal(OFFER_STRINGS.en.preorder('20'), 'Pre-order · 20 days');
  assert.equal(OFFER_STRINGS.ckb.preorder('20'), 'پێشداواکاری · 20 ڕۆژ');
  assert.equal(OFFER_STRINGS.ar.preorderSeparate, 'يُطلب منفرداً — يصل بعد الطابعة');
  assert.equal(OFFER_STRINGS.en.preorderSeparate, 'Ordered separately — arrives after the printer');
  assert.equal(OFFER_STRINGS.ckb.preorderSeparate, 'بە جیا داوا دەکرێت — دوای پرینتەرەکە دەگات');
  assert.equal(OFFER_STRINGS.ar.preorderOrder, 'اطلبه كطلب مسبق');
  const rows = code('src/components/product/PrinterOffersRows.tsx');
  assert.match(rows, /data-addon-preorder=\{a\.id\}>\{s\.preorder\(a\.preorder\)\}/);
  // One order is one journey: a pre-order part is not a tick box — its row leads to its own page.
  assert.match(rows, /if \(a\.preorder !== null && !a\.available && !on\) \{/);
  assert.match(rows, /<Link to=\{`\/product\/\$\{a\.slug\}`\}/);
  assert.notEqual(OFFER_STRINGS.ckb.preorderSeparate, OFFER_STRINGS.ar.preorderSeparate);
  assert.match(rows, /data-addon-preorder-link>\{s\.preorderOrder\}<\/Link>/, 'a link button to the part’s page — nothing is added from here');
  // No such line can exist in the cart (the add refuses it), so the cart says nothing about it.
  assert.doesNotMatch(code('src/components/cart/PrinterExtrasLines.tsx'), /preorder/i);
});

// ---------------------------------------------------------------- the lists are there when the sheet opens

test('one request per key, shared while in flight, read back at once — and a failure is forgotten', async () => {
  forgetWarmed();
  let calls = 0;
  const load = () => { calls += 1; return new Promise<string>((resolve) => setTimeout(() => resolve(`answer ${calls}`), 5)); };
  const a = warmed('k:one', load);
  const b = warmed('k:one', load);
  assert.equal(calls, 1, 'the card and the sheet share one request');
  assert.equal(warmedNow('k:one'), undefined, 'not here yet');
  assert.equal(await a, 'answer 1');
  assert.equal(await b, 'answer 1');
  assert.equal(warmedNow('k:one'), 'answer 1', 'the sheet’s first paint has it');
  assert.equal(await warmed('k:one', load), 'answer 1');
  assert.equal(calls, 1, 'still one');
  assert.equal(await warmed('k:one', load, true), 'answer 2', '«إعادة المحاولة» asks again');
  assert.equal(await warmed('k:two', load), 'answer 3', 'another printer selection is another key');
  // A failed request is not remembered.
  let failing = 0;
  const bad = () => { failing += 1; return Promise.reject(new Error('offline')); };
  await assert.rejects(warmed('k:bad', bad));
  assert.equal(warmedNow('k:bad'), undefined);
  await assert.rejects(warmed('k:bad', bad));
  assert.equal(failing, 2, 'the next try asks the server again');
  forgetWarmed();
});

test('the card asks for the sheet’s lists while idle; the sheet reads them when it opens, not when a row does', () => {
  const card = code('src/components/product/PrinterPackages.tsx');
  assert.match(card, /const loadSheet = \(\) => import\('\.\/CustomizeSheet'\);/);
  assert.match(card, /loadSheet\(\)\.then\(\(m\) => m\.warmSheet\(/);
  assert.match(card, /requestIdleCallback\(warmNow, \{ timeout: 1200 \}\)/);
  assert.match(card, /onPointerDown=\{warmNow\}/, 'and at once when a finger lands on the card');
  const sheet = code('src/components/product/CustomizeSheet.tsx');
  assert.match(sheet, /export function warmSheet\(offer: ServicesOffer, kitsFor: KitsFor \| null, lang: PsLang, userId: string \| null\): void/);
  assert.match(sheet, /const wantMembers = open && memberOffered && !!user;/);
  assert.match(sheet, /const wantKits = open && !!kitsFor && \(kitsOffered \|\| addonsOffered \|\| bundlesOffered\);/);
  assert.doesNotMatch(sheet, /openRow === 'filament' \|\| openRow === 'addons'/, 'the lists no longer wait for their row');
  assert.match(sheet, /const here = again \? undefined : offersNow\(f, colours, lang\);/);
  // A list still on its way is blocks of its rows' height, not a sentence that flashes.
  const rows = code('src/components/product/PrinterOffersRows.tsx');
  assert.match(rows, /data-offers-skeleton/);
  assert.match(rows, /<span className="sr-only">\{label \?\? s\.loading\}<\/span>/);
});

// ---------------------------------------------------------------- the look

test('the chosen state is the house’s own: no white slab anywhere on the card or the sheet', () => {
  for (const rel of ['src/components/product/PrinterPackages.tsx', 'src/components/product/CustomizeSheet.tsx', 'src/components/product/PrinterOffersRows.tsx']) {
    const src = code(rel).replace(/bg-white object-contain/g, '');
    assert.doesNotMatch(src, /bg-white\b(?!\/)/, `${rel}: a pure white fill is back`);
    assert.doesNotMatch(src, /accentColor: '#fff'/, rel);
  }
  const card = code('src/components/product/PrinterPackages.tsx');
  assert.equal((card.match(/className=\{?[`"]lv-choice /g) ?? []).length, 3, 'the package rows, the delivery rows and «تخصيص بنفسي»');
  assert.match(card, /<span className="lv-choice-mark"><Check className="h-3 w-3" \/><\/span>/, 'the house’s gold check');
  const sheet = code('src/components/product/CustomizeSheet.tsx');
  assert.match(sheet, /className="lv-button lv-button-accent min-w-0 flex-1"\s+data-sheet-add/);
  assert.match(sheet, /className="lv-button lv-button-secondary shrink-0"\s+data-sheet-apply/);
  assert.match(sheet, /className="lv-button lv-button-accent w-full"\s+data-sheet-apply/);
  // The card says what the price includes, and each row its figure against it.
  assert.match(card, /data-packages-includes>\{anchor \? s\.priceIncludes\(s\.smart\) : s\.cardSub\}/);
  assert.match(card, /delta: packageDelta\(offer, 'just'\)/);
});

// ---------------------------------------------------------------- the product page

const THREE: RouteFacts = { transports: [{ method: 'sea', configured: true }, { method: 'land', configured: true }, { method: 'air', configured: true }] };
const LAND_ONLY: RouteFacts = { transports: [{ method: 'land', configured: true }] };
const SEA_FULL: RouteFacts = { transports: [{ method: 'sea', configured: true }, { method: 'land', configured: true }], routes: [{ method: 'sea', usable: false }, { method: 'land', usable: true }] };

test('«Availability select auto»: a pre-order with one open route answers the route question by itself', () => {
  // The owner’s case on the live P1S: the version is out of stock, the page falls to «طلب مسبق», and the only route is land.
  assert.equal(resolveTransport('', 'pre_order', LAND_ONLY), 'land', 'no press needed');
  assert.equal(resolveTransport('', 'pre_order', SEA_FULL), 'land', 'one route is open: the full one does not count');
  // Two or more open routes stay a real question.
  assert.equal(resolveTransport('', 'pre_order', THREE), '');
  // The customer’s own choice is never replaced while it is still offered.
  assert.equal(resolveTransport('air', 'pre_order', THREE), 'air');
  assert.equal(resolveTransport('land', 'pre_order', LAND_ONLY), 'land');
  // A choice this version does not offer gives way to the only open route — and to a question when there are several.
  assert.equal(resolveTransport('sea', 'pre_order', LAND_ONLY), 'land');
  assert.equal(resolveTransport('sea', 'pre_order', SEA_FULL), 'land');
  assert.equal(resolveTransport('rail', 'pre_order', THREE), '');
  // Nothing direct, and nothing unanswered, ever carries a route.
  assert.equal(resolveTransport('', 'direct_sale', LAND_ONLY), '');
  assert.equal(resolveTransport('land', '', LAND_ONLY), '');
  assert.equal(resolveTransport('', 'pre_order', undefined), '');
  assert.equal(resolveTransport('', 'pre_order', { transports: [{ method: 'land', configured: false }] }), '', 'a route nobody priced is not open');
  // It is derived per combination (re-read on every version change): the page keeps no preselect of its own.
  const page = code('src/pages/Product.tsx');
  assert.doesNotMatch(page, /usable\.length === 1/, 'the load and the «طلب مسبق» card no longer preselect the route themselves');
  assert.match(page, /onClick=\{\(\) => setOrderType\('pre_order'\)\}/);
  assert.match(page, /const effectiveTransport = resolveTransport\(transportMethod, requestedOrderType, availability\?\.preorder\);/);
});

test('the phone’s purchase bar is compact: one price line over a 44 px button', () => {
  const page = code('src/pages/Product.tsx');
  // The plain button is the house’s own 44 px (`lv-button`), not a 50 px slab with 15 px type.
  assert.match(page, /className="lv-button lv-button-primary w-full active:scale-\[0\.985\] \[touch-action:manipulation\]"/);
  assert.doesNotMatch(page, /lv-button-primary w-full min-h-\[50px\]/);
  // The price is one line (label at the start, figure at the end); the stepper and the button share the row under it.
  assert.match(page, /showQuickBuyToggle \? 'me-auto' : 'flex basis-full items-baseline justify-between gap-2'/);
  assert.match(page, /<div className="mx-auto flex w-full max-w-\[640px\] flex-wrap items-center gap-x-2 gap-y-1 sm:gap-2\.5">/);
  // The Quick Buy pair is 44 px too.
  const bar = code('src/components/quickBuy/QuickBuyBar.tsx');
  assert.match(bar, /const C = 44;/);
  assert.doesNotMatch(bar, /min-h-\[50px\]/);
});

test('an anchored line strikes the catalogue price and shows no percent of the printer’s own part', () => {
  // phase6-api.md: with a selection, `offer_before_iqd` is the catalogue figure − the anchor and its percent
  // is computed on that part. The page puts the anchor back (the dinar saving stays exact) and drops the percent.
  const page = code('src/pages/Product.tsx');
  assert.match(page, /const psAnchor = psQuoted\?\.selection\?\.anchor_fee_iqd \|\| 0;/);
  assert.match(page, /before: quote!\.offer_before_iqd != null \? quote!\.offer_before_iqd \+ psAnchor : null,/);
  assert.match(page, /savingPercent: psAnchor \? null : quote!\.offer_saving_percent \?\? null,/);
  // The card itself states no saving percent at all.
  assert.doesNotMatch(code('src/components/product/PrinterPackages.tsx'), /saving_percent|o4\.save\(|s\.save\(/);
});
