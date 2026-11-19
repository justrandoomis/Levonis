/**
 * «خصص طابعتك» phase 6 in the admin panel (DECISIONS row 362): the owner's switch «سعر الطابعة المعروض هو
 * سعر الاختيار الذكي» with its explanation and a worked example from the edited printer, delivery class 6
 * in the selects and the price table, the warehouse pickup switch with its three-language note, and
 * «ما يراه الزبون» showing each choice as its difference from the price (− / included / +) and the pickup.
 *
 * Run: TZ=UTC node --import tsx --test tests/printerAdminPhase6.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_PRINTER_SERVICES, DELIVERY_CLASSES, type PrinterServicesConfig } from '../packages/pricing/src/printerServices';
import SharedPriceListTab from '../src/components/adminPrinterServices/SharedPriceListTab';
import PrinterThisTab, { type ServicesPrinter } from '../src/components/adminPrinterServices/PrinterThisTab';
import CustomerPreview from '../src/components/adminPrinterServices/CustomerPreview';
import { issueText } from '../src/components/adminPrinterServices/issueWords';
import { CLASS_LABEL, S } from '../src/components/adminPrinterServices/adminPrinterStrings';

const loc = (ar: string) => ar;
const noop = () => {};
const A1 = 'prd_a1';
const printer: ServicesPrinter = { id: A1, slug: 'bambu-a1', name: 'Bambu Lab A1', status: 'active', is_used: false, versions: [] };
const NOTE = { ar: 'مخزن بغداد — 10ص إلى 6م', en: 'Baghdad warehouse — 10am to 6pm', ckb: 'کۆگای بەغدا — 10 تا 6' };
function draft(over: (c: PrinterServicesConfig) => void = () => undefined): PrinterServicesConfig {
  const c = JSON.parse(JSON.stringify(DEFAULT_PRINTER_SERVICES)) as PrinterServicesConfig;
  c.products = { [A1]: { warranty_family: 'a1', delivery_class: 'd6' } };
  c.delivery.classes.d6 = { economy_iqd: 10_000, personal_iqd: 25_000 };
  over(c);
  return c;
}
const anchored = () => draft((c) => { c.price_anchor = 'smart'; c.delivery.pickup = { active: true, note: NOTE }; });
const shared = (d: PrinterServicesConfig, props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(SharedPriceListTab, { draft: d, upd: noop, loc, published: null, productId: A1, ...props }));
const preview = (d: PrinterServicesConfig) => renderToStaticMarkup(createElement(CustomerPreview, { draft: d, loc, lang: 'ar', printer }));

test('class 6 has its label in three languages and is in the printer\'s class select and the price table', () => {
  assert.deepEqual([...CLASS_LABEL.d6], ['الفئة 6 · صندوق A1', 'Class 6 · A1 box', 'پۆلی 6 · سندوقی A1']);
  for (const c of DELIVERY_CLASSES) assert.ok(CLASS_LABEL[c] && CLASS_LABEL[c][2] !== CLASS_LABEL[c][0], c);
  const select = renderToStaticMarkup(createElement(PrinterThisTab, { draft: draft(), upd: noop, loc, printer }));
  assert.match(select, /<option value="d6"[^>]*>الفئة 6 · صندوق A1<\/option>/);
  const html = shared(draft());
  for (const c of DELIVERY_CLASSES) assert.match(html, new RegExp(`data-shared-class="${c}"`), c);
  assert.ok(html.indexOf('data-shared-class="d6"') < html.indexOf('data-shared-class="d1"'), 'this printer\'s class comes first');
  // A draft stored before class 6 existed still renders (its row reads as unpriced).
  const old = draft();
  delete (old.delivery.classes as Record<string, unknown>).d6;
  old.products[A1].delivery_class = 'd1';
  assert.match(shared(old), /data-shared-class="d6"/);
});

test('the owner\'s switch: named, explained both ways, with this printer\'s own example; off by default', () => {
  const off = shared(draft());
  assert.match(off, /data-shared-group="anchor"/);
  assert.match(off, /data-price-anchor="none"/);
  assert.ok(off.includes(S.anchorSwitch[0]) && off.includes(S.anchorHintOn[0]) && off.includes(S.anchorHintOff[0]) && off.includes(S.anchorOffSummary[0]));
  const SWITCH_ON = /<input[^>]*checked=""[^>]*data-price-anchor-switch|<input[^>]*data-price-anchor-switch[^>]*checked=""/;
  assert.doesNotMatch(off, SWITCH_ON);
  const on = shared(anchored());
  assert.match(on, /data-price-anchor="smart"/);
  assert.match(on, SWITCH_ON);
  assert.ok(on.includes(S.anchorOnSummary[0]));
  // The example is this printer's (family A1: Smart 44,000, Complete 131,000) — the differences when its price is not known to the page.
  const example = /data-anchor-example[^>]*>([\s\S]*?)<\/div>/.exec(on)?.[1] ?? '';
  assert.ok(example.includes(S.pvIncluded[0]), example);
  assert.match(example, /−44,000/);
  assert.match(example, /\+87,000/);
  assert.doesNotMatch(on, /data-anchor-below|data-anchor-needs-smart/);
  // What stops it is said: the Smart package off, or this printer priced below its anchor.
  assert.match(shared(draft((c) => { c.price_anchor = 'smart'; c.packages.smart.active = false; })), /data-anchor-needs-smart/);
  assert.match(shared(anchored(), { anchorBelow: true }), /data-anchor-below/);
  for (const t of [S.anchorSwitch, S.anchorHintOn, S.anchorHintOff, S.anchorBelow, S.anchorNeedsSmart, S.pickupSwitch, S.pickupHint, S.pickupNoteTitle, S.pvIncluded, S.pvPickup, S.pvAnchored]) {
    assert.ok(t[0] && t[1] && t[2] && String(t[2]) !== String(t[0]), t[1]);
  }
});

test('the warehouse pickup: a switch, a hint and a note in three languages inside the delivery prices', () => {
  const off = shared(draft());
  assert.match(off, /data-shared-pickup="off"/);
  assert.ok(off.includes(S.pickupSwitch[0]) && off.includes(S.pickupHint[0]) && off.includes(S.pickupNoteRule[0]));
  const on = shared(anchored());
  assert.match(on, /data-shared-pickup="on"/);
  for (const text of [NOTE.ar, NOTE.en, NOTE.ckb]) assert.ok(on.includes(`value="${text}"`), text);
  assert.ok(on.includes(S.pickupOn[0]), 'the folded summary says pickup is offered');
});

test('«ما يراه الزبون»: without the anchor the «+» prices as before; with it every choice shows its difference and the pickup shows', () => {
  const plain = preview(draft());
  assert.doesNotMatch(plain, /data-preview-anchored|data-preview-included|data-preview-delta|data-preview-group="delivery"[\s\S]*استلام من المخزن/);
  const html = preview(anchored());
  assert.match(html, /data-preview-anchored/);
  assert.ok(html.includes(S.pvAnchored[0]));
  const deltas = [...html.matchAll(/data-preview-delta="(-?\d+)"/g)].map((m) => Number(m[1]));
  // Warranty none −25,000 · 24 months +75,000 · without Care −19,000 · extra packaging +7,000 · inspection +5,000 · Printer only −44,000 · Complete +87,000.
  assert.deepEqual(deltas, [-25_000, 75_000, -19_000, 7_000, 5_000, -44_000, 87_000]);
  assert.match(html, /−25,000/);
  assert.match(html, /\+75,000/);
  // What the price includes says so: 12-month warranty, Levo Care, standard packaging, the Smart package itself.
  assert.equal((html.match(/data-preview-included/g) ?? []).length, 4);
  // Delivery: the class's two prices and the free pickup with its note.
  assert.ok(html.includes(S.pvPickup[0]) && html.includes(NOTE.ar));
  assert.match(html, /10,000/);
  assert.doesNotMatch(html, /\b(w12|w24|c12)\b/, 'no code reaches the preview');
});

test('what blocks a publish is said in words for the new rules', () => {
  const say = (i: string) => issueText(i, loc);
  for (const i of [
    'price_anchor: the Smart package is off — switch it on, or switch the price anchor off',
    `products.${A1}: the Smart package is not priced for this printer's warranty family — the price anchor cannot apply`,
    'delivery.pickup.note: needs Arabic, English and Kurdish (or none)',
    'price_anchor: none or smart',
  ]) {
    const out = say(i);
    assert.equal(out.translated, true, i);
    assert.notEqual(out.text, i);
  }
});
