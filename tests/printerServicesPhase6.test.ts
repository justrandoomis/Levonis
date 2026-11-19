/**
 * «خصص طابعتك» phase 6 (owner, 2026-11-19; DECISIONS row 362):
 *
 *  - THE PRICE ANCHOR — «today's price IS the Smart Choice price». A line with a choice is charged
 *    P − anchor + fee(choice): Just Printer = P − anchor, Smart = P, Complete = P + (complete − smart).
 *    The anchor lives in the SERVICES component alone (net fee = fee − anchor): applied / regular /
 *    member / offer-before figures never change, so price protection, the engine basis and the struck
 *    price read an anchored line as before; discount bases read min(applied, unit).
 *    Pinned at every door: the product quote, the cart, the order quote and the placed order agree for
 *    every package; a line never goes below 0 (P < anchor: the anchor does not apply); a line with NO
 *    choice is priced and recorded as Smart; and a list with no anchor answers byte-identically to one
 *    stored before the field existed.
 *  - Delivery class d6 and the free warehouse pickup: offered only when switched on, free, ordered with
 *    the store's pickup method, refused with its own code on any other.
 *  - Finance: the printer part + the services part of an anchored line still sum to the line.
 *
 * Run: node --import tsx --test tests/printerServicesPhase6.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { ROOT, SqliteD1 } from './fixtures/d1';
import type { AppContext } from '../worker/lib/types';
import { HttpError } from '../worker/lib/http';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';
import { productRoutes } from '../worker/routes/products';
import { policiesRoutes } from '../worker/routes/policies';
import { adminRoutes } from '../worker/routes/admin';
import { adminPrinterServiceRoutes } from '../worker/routes/adminPrinterServices';
import { classifyHost } from '../worker/lib/hosts';
import { acceptedPolicies } from './lib/policies';
import { PRINTER_STANDARD_DELIVERY_POLICY } from '../packages/shipping/src/printerDeliveryPolicy';
import { resetPolicyCorpusMemo } from '../worker/lib/policySync';
import { autoPublishFromEnv } from './fixtures/autoPublish';
import { forgetPricingInputs } from '../worker/lib/membershipBenefits';
import { splitServicedLine } from '../worker/lib/printerFinance';
import { keepPhase6Fields, offerForLine, orderServicesView, pricedServicesView, printerAnchorNotes, servicesForMethod } from '../worker/lib/printerServices';
import { goodsBaseUnitIqd, settleServicesAnchor, type ResolvedPrice } from '../packages/pricing/src/pricing';
import { priceProtectionRoutes } from '../worker/routes/returns';
import { repriceV2 } from './fixtures/v2Publish';
import { offerFigures } from '../worker/lib/customerPricing';
import { REFUSAL_STRINGS } from '../src/lib/refusalStrings';
import {
  DEFAULT_PRINTER_SERVICES, DELIVERY_CHOICES, DELIVERY_CLASSES, EMPTY_SELECTION, SERVICES_OPTION_UNAVAILABLE, SERVICES_PICKUP_METHOD,
  anchorDefaultSelection, anchorFeeFor, canonicalConfig, configIssues, deliveryRow, encodeSelection, parseSelection, pickupOf,
  presetSelection, priceAnchorOf, priceServices, publishIssues, servicesOffer, withPhase2Defaults,
  type PricedServices, type PrinterServicesConfig, type ServiceSelection,
} from '../packages/pricing/src/printerServices';

const A1 = { warranty_family: 'a1', delivery_class: 'd1' } as const;
const clone = (): PrinterServicesConfig => JSON.parse(JSON.stringify(DEFAULT_PRINTER_SERVICES));
const NOTE = { ar: 'مخزن بغداد، الكرادة — 10ص إلى 6م', en: 'Baghdad warehouse, Karrada — 10am to 6pm', ckb: 'کۆگای بەغدا، کەڕادە — 10ی بەیانی تا 6ی ئێوارە' };

/** A list as it was stored before phase 6: no anchor, no pickup, no class d6. */
function legacyConfig(): PrinterServicesConfig {
  const c = clone() as unknown as Record<string, unknown> & { delivery: { classes: Record<string, unknown>; pickup?: unknown } };
  delete c.price_anchor;
  delete c.delivery.pickup;
  delete c.delivery.classes.d6;
  return c as unknown as PrinterServicesConfig;
}
function liveConfig(over: (c: PrinterServicesConfig) => void = () => undefined): PrinterServicesConfig {
  const c = clone();
  c.revision = 1;
  c.products = { p_a1: { warranty_family: 'a1', delivery_class: 'd1' } };
  c.price_anchor = 'smart';
  c.delivery.pickup = { active: true, note: NOTE };
  over(c);
  return c;
}
const confirmed = (s: ServiceSelection): ServiceSelection => ({ ...s, confirmed: true });
const pkg = (c: PrinterServicesConfig, id: 'just' | 'smart' | 'complete', delivery: ServiceSelection['delivery']): ServiceSelection =>
  ({ ...presetSelection(c, id, delivery), confirmed: true, ack_no_warranty: id === 'just' });
const custom = (delivery: ServiceSelection['delivery']): ServiceSelection =>
  ({ ...EMPTY_SELECTION, package: 'custom', warranty: 'w24', packaging: 'extra', delivery, confirmed: true });

// ================================================================== the pure half

test('a list stored before phase 6 stays valid and reads as no anchor, d6 unpriced, pickup off — and answers byte-identically', () => {
  const old = legacyConfig();
  assert.deepEqual(configIssues(old), []);
  assert.deepEqual([priceAnchorOf(old), pickupOf(old), deliveryRow(old, 'd6')], ['none', { active: false, note: null }, { economy_iqd: null, personal_iqd: null }]);
  const read = withPhase2Defaults(old);
  assert.deepEqual([read.price_anchor, read.delivery.pickup, read.delivery.classes.d6], ['none', { active: false, note: null }, { economy_iqd: null, personal_iqd: null }]);
  assert.deepEqual(canonicalConfig(old), canonicalConfig(DEFAULT_PRINTER_SERVICES), 'the canonical store writes the three fields');
  assert.deepEqual(canonicalConfig(DEFAULT_PRINTER_SERVICES), DEFAULT_PRINTER_SERVICES);
  // Byte-identical: the offer and the priced choice of an old list, of the seeded list and of one saying 'none' aloud.
  const none = clone(); none.price_anchor = 'none'; none.delivery.pickup = { active: false, note: NOTE };
  for (const c of [old, clone(), none]) {
    assert.equal(JSON.stringify(servicesOffer(c, A1)), JSON.stringify(servicesOffer(legacyConfig(), A1)));
    const p = priceServices(c, A1, pkg(c, 'smart', 'economy'));
    assert.equal(JSON.stringify(p), JSON.stringify(priceServices(legacyConfig(), A1, pkg(old, 'smart', 'economy'))));
    assert.equal('anchor_fee_iqd' in p, false);
    assert.equal(anchorFeeFor(c, A1), null);
  }
  const offer = servicesOffer(old, A1);
  assert.equal('anchor' in offer, false);
  assert.deepEqual(offer.delivery, { economy: 5_000, personal: 15_000 });
});

test('configIssues: the anchor is none or smart; the pickup is {active, note}; class d6 is a class', () => {
  const bad = clone() as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  bad.price_anchor = 'complete';
  bad.delivery.pickup = { active: 'yes', note: null };
  assert.deepEqual(configIssues(bad).filter((i) => i.startsWith('price_anchor') || i.startsWith('delivery.pickup')).map((i) => i.split(':')[0]), ['delivery.pickup', 'price_anchor']);
  bad.delivery.pickup = { active: true, note: { ar: 'x'.repeat(201), en: '', ckb: '' } };
  assert.ok(configIssues(bad).some((i) => i.startsWith('delivery.pickup')));
  bad.delivery.pickup = { active: true, note: { ar: 'a', en: 'b' } };
  assert.ok(configIssues(bad).some((i) => i.startsWith('delivery.pickup')), 'a note needs its three slots');
  bad.delivery.classes.d6 = { economy_iqd: 1.5, personal_iqd: null };
  assert.ok(configIssues(bad).includes('delivery.classes.d6: {economy_iqd, personal_iqd}'));

  assert.deepEqual([...DELIVERY_CLASSES], ['d1', 'd2', 'd3', 'd4', 'd5', 'd6']);
  assert.deepEqual([...DELIVERY_CHOICES], ['economy', 'personal', 'pickup']);
  const ok = liveConfig((c) => { c.products.p_a1 = { warranty_family: 'a1', delivery_class: 'd6' }; c.delivery.classes.d6 = { economy_iqd: 10_000, personal_iqd: 25_000 }; });
  assert.deepEqual(configIssues(ok), []);
  assert.deepEqual(publishIssues(ok), []);
  const canon = canonicalConfig({ ...ok, delivery: { ...ok.delivery, pickup: { active: true, note: { ar: ' أ ', en: ' b ', ckb: ' ج ' } } } });
  assert.deepEqual(canon.delivery.pickup, { active: true, note: { ar: 'أ', en: 'b', ckb: 'ج' } });
  assert.deepEqual(canonicalConfig({ ...ok, delivery: { ...ok.delivery, pickup: { active: true, note: { ar: ' ', en: '', ckb: '' } } } }).delivery.pickup, { active: true, note: null });
  assert.deepEqual(canonicalConfig(canon), canon, 'canonical is a fixed point');
  assert.equal(canon.price_anchor, 'smart');
});

test('the anchor is exactly the Smart package\'s fee for the family; none when off, when Smart is off or unpriced', () => {
  const c = liveConfig();
  assert.equal(anchorFeeFor(c, A1), 44_000);
  assert.equal(anchorFeeFor(c, { warranty_family: 'h3c', delivery_class: 'd5' }), 39_000 + 19_000);
  assert.equal(anchorFeeFor(c, A1), priceServices(c, A1, anchorDefaultSelection(c)).fee_iqd, 'what priceServices returns for the Smart package');
  assert.deepEqual(priceServices(c, A1, anchorDefaultSelection(c)).blockers, []);
  assert.equal(anchorFeeFor(liveConfig((x) => { x.price_anchor = 'none'; }), A1), null);
  assert.equal(anchorFeeFor(liveConfig((x) => { x.packages.smart.active = false; }), A1), null);
  assert.equal(anchorFeeFor(liveConfig((x) => { x.warranty.w12.a1 = null; }), A1), null);
  // The offer says it; priceServices itself never subtracts (fee_iqd stays the real fee).
  assert.deepEqual(servicesOffer(c, A1).anchor, { package: 'smart', fee_iqd: 44_000 });
  assert.equal(priceServices(c, A1, pkg(c, 'complete', null)).fee_iqd, 131_000);
  assert.equal('anchor_fee_iqd' in priceServices(c, A1, pkg(c, 'complete', null)), false);
});

test('publishing an anchored list needs a Smart package every mapped printer can be priced with; a pickup note is all three languages or none', () => {
  assert.deepEqual(publishIssues(liveConfig()), []);
  assert.ok(publishIssues(liveConfig((c) => { c.packages.smart.active = false; })).some((i) => i.startsWith('price_anchor: the Smart package is off')));
  const unpriced = publishIssues(liveConfig((c) => { c.warranty.w12.a1 = null; }));
  assert.ok(unpriced.some((i) => i.startsWith('products.p_a1: the Smart package is not priced')), JSON.stringify(unpriced));
  // A version of another family that cannot be priced is caught too.
  const version = publishIssues(liveConfig((c) => { c.warranty.w12.h2 = null; c.products.p_a1.by_option_value = { ov_big: { warranty_family: 'h2' } }; }));
  assert.ok(version.some((i) => i.startsWith('products.p_a1: the Smart package is not priced')));
  // Without the anchor none of this blocks.
  assert.deepEqual(publishIssues(liveConfig((c) => { c.price_anchor = 'none'; c.packages.smart.active = false; })), []);
  assert.ok(publishIssues(liveConfig((c) => { c.delivery.pickup = { active: true, note: { ar: 'عنوان', en: '', ckb: '' } }; })).includes('delivery.pickup.note: needs Arabic, English and Kurdish (or none)'));
  assert.deepEqual(publishIssues(liveConfig((c) => { c.delivery.pickup = { active: true, note: null }; })), []);
});

test('the warehouse pickup: free while switched on, refused while off; d6 prices like every class', () => {
  const on = liveConfig();
  const p = priceServices(on, A1, pkg(on, 'smart', 'pickup'));
  assert.deepEqual([p.delivery_fee_iqd, p.blockers], [0, []]);
  assert.deepEqual(servicesOffer(on, A1).delivery, { economy: 5_000, personal: 15_000, pickup: { note: NOTE } });
  const off = liveConfig((c) => { c.delivery.pickup = { active: false, note: NOTE }; });
  const q = priceServices(off, A1, pkg(off, 'smart', 'pickup'));
  assert.deepEqual([q.delivery_fee_iqd, q.blockers], [null, [SERVICES_OPTION_UNAVAILABLE]]);
  assert.equal('pickup' in servicesOffer(off, A1).delivery!, false);
  const noDelivery = liveConfig((c) => { c.delivery.active = false; });
  assert.deepEqual(priceServices(noDelivery, A1, pkg(noDelivery, 'smart', 'pickup')).blockers, [SERVICES_OPTION_UNAVAILABLE]);
  // The selection round-trips; delivery_options keeps its two keys (frozen snapshots read them).
  const s = pkg(on, 'smart', 'pickup');
  assert.deepEqual(parseSelection(encodeSelection(s)), s);
  assert.deepEqual(p.delivery_options, { economy_iqd: 5_000, personal_iqd: 15_000 });
  // d6: unpriced in the seed (a blocker, never 0), priced once the owner sets it.
  const D6 = { warranty_family: 'a1', delivery_class: 'd6' } as const;
  assert.deepEqual(priceServices(on, D6, pkg(on, 'smart', 'economy')).blockers, [SERVICES_OPTION_UNAVAILABLE]);
  const priced = liveConfig((c) => { c.delivery.classes.d6 = { economy_iqd: 10_000, personal_iqd: 25_000 }; });
  assert.deepEqual([priceServices(priced, D6, pkg(priced, 'smart', 'economy')).delivery_fee_iqd, priceServices(priced, D6, pkg(priced, 'smart', 'personal')).delivery_fee_iqd], [10_000, 25_000]);
  assert.deepEqual(servicesOffer(priced, D6).delivery, { economy: 10_000, personal: 25_000, pickup: { note: NOTE } });
  // A list stored without d6 prices a d6 printer as unpriced, never a crash.
  const old = legacyConfig();
  assert.deepEqual(priceServices(old, D6, pkg(old, 'smart', 'economy')).blockers, [SERVICES_OPTION_UNAVAILABLE]);
  assert.deepEqual(servicesOffer(old, D6).delivery, { economy: null, personal: null });
});

/** A resolver answer as it stands BEFORE the anchor is settled (the full services fee in the unit, the line only marked). */
function lifted(over: { applied: number; regular?: number; fee: number; anchor?: number; before?: number; pro?: number | null; usd?: number; defaulted?: boolean }): ResolvedPrice {
  const services = { fee_iqd: over.fee, lines: [], blockers: [], ...(over.anchor !== undefined ? { anchor_fee_iqd: over.anchor } : {}), ...(over.defaulted ? { defaulted: true } : {}) } as unknown as PricedServices;
  return {
    regular_iqd: over.regular ?? over.applied, pro_iqd: over.pro ?? null, prime_iqd: null, applied_iqd: over.applied, applied_tier: 'regular',
    unit_subtotal_iqd: over.applied + over.fee, services, components: { services_fee_iqd: over.fee },
    ...(over.before !== undefined ? { offer_before_iqd: over.before } : {}),
    ...(over.usd !== undefined ? { regular_usd_cents: over.usd, applied_usd_cents: over.usd } : {}),
    errors: [],
  } as unknown as ResolvedPrice;
}

test('settleServicesAnchor: the anchor lives in the services alone — Just = P − anchor, Smart = P, Complete = P + difference; no price figure moves', () => {
  const P = 960_000; const a = 48_000;
  // The owner's own worked example: «السعر 960,000 = الاختيار الذكي؛ الطابعة فقط 912,000؛ الكاملة 1,093,000».
  const cases: Array<[string, number, number]> = [['just', 0, 912_000], ['smart', 48_000, 960_000], ['complete', 181_000, 1_093_000], ['custom', 25_000, 937_000]];
  for (const [name, fee, unit] of cases) {
    const r = settleServicesAnchor(lifted({ applied: P, fee, anchor: a }));
    assert.deepEqual([r.unit_subtotal_iqd, r.applied_iqd, r.regular_iqd], [unit, P, P], name);
    assert.deepEqual([r.services!.fee_iqd, r.services!.anchor_fee_iqd, r.services!.net_fee_iqd, r.components.services_fee_iqd, r.components.services_anchor_iqd], [fee, a, fee - a, fee, a], name);
    assert.equal(r.unit_subtotal_iqd, r.applied_iqd + r.services!.net_fee_iqd!, name);
    // Rule C: the goods base is what the buyer had before the switch (P) — or what he pays, when that is less.
    assert.equal(goodsBaseUnitIqd(r), Math.min(P, unit), name);
    assert.ok(goodsBaseUnitIqd(r) <= r.unit_subtotal_iqd && r.unit_subtotal_iqd >= 0, name);
  }

  // A member's price and a live offer: every figure the customer and the later readers see is the catalogue's own.
  const member = settleServicesAnchor(lifted({ applied: 900_000, regular: P, pro: 900_000, fee: 0, anchor: a }));
  assert.deepEqual([member.applied_iqd, member.regular_iqd, member.pro_iqd, member.unit_subtotal_iqd], [900_000, P, 900_000, 852_000]);
  const bare = lifted({ applied: 900_000, regular: 900_000, before: P, fee: 0 });
  const offer = settleServicesAnchor(lifted({ applied: 900_000, regular: 900_000, before: P, fee: a, anchor: a }));
  assert.deepEqual([offer.unit_subtotal_iqd, offer.applied_iqd, offer.offer_before_iqd], [900_000, 900_000, P], 'Smart under an offer = the offer price');
  // The struck price and its percent are the bare quote's own (customerPricing.offerFigures reads these two fields).
  assert.deepEqual(offerFigures(offer.offer_before_iqd, offer.applied_iqd), offerFigures(bare.offer_before_iqd, bare.applied_iqd));
  assert.deepEqual(offerFigures(offer.offer_before_iqd, offer.applied_iqd), { offer_before_iqd: 960_000, offer_saving_percent: 6 });

  // Rule D — decided on the price actually applied AFTER the offer. Below the anchor the line is not anchored:
  // a chosen selection is charged on top, exactly as a list with no anchor…
  const tiny = settleServicesAnchor(lifted({ applied: 30_000, fee: 44_000, anchor: 44_000 }));
  assert.deepEqual([tiny.unit_subtotal_iqd, tiny.applied_iqd, 'anchor_fee_iqd' in tiny.services!, 'net_fee_iqd' in tiny.services!, tiny.components.services_anchor_iqd], [74_000, 30_000, false, false, undefined]);
  assert.equal(goodsBaseUnitIqd(tiny), 30_000);
  // …and a line that had NO choice loses the Smart package the anchor would have given it: catalogue 60,000,
  // offer 40,000, anchor 44,000 → the bare 40,000 line with no services (the cart then refuses SERVICES_REQUIRED),
  // never 84,000 with «defaulted».
  const noChoice = settleServicesAnchor(lifted({ applied: 40_000, regular: 40_000, before: 60_000, fee: 44_000, anchor: 44_000, defaulted: true }));
  assert.deepEqual([noChoice.unit_subtotal_iqd, noChoice.applied_iqd, 'services' in noChoice, noChoice.components.services_fee_iqd], [40_000, 40_000, false, undefined]);
  const stillAnchored = settleServicesAnchor(lifted({ applied: 50_000, fee: 44_000, anchor: 44_000, defaulted: true }));
  assert.deepEqual([stillAnchored.unit_subtotal_iqd, stillAnchored.services!.defaulted, stillAnchored.services!.net_fee_iqd], [50_000, true, 0]);
  const edge = settleServicesAnchor(lifted({ applied: 44_000, fee: 0, anchor: 44_000 }));
  assert.deepEqual([edge.unit_subtotal_iqd, edge.applied_iqd, goodsBaseUnitIqd(edge)], [0, 44_000, 0], 'P = anchor with Just Printer is 0, never negative');

  // No anchor mark: the very same object — nothing about an unanchored line changes, and its base is its applied price.
  const plain = lifted({ applied: P, fee: 48_000 });
  assert.equal(settleServicesAnchor(plain), plain);
  assert.equal(goodsBaseUnitIqd(plain), P);
  const none = { regular_iqd: 5, applied_iqd: 5, unit_subtotal_iqd: 5, errors: [] } as unknown as ResolvedPrice;
  assert.equal(settleServicesAnchor(none), none);
  assert.equal(goodsBaseUnitIqd(none), 5);

  // Dollars: the catalogue twins stay with the catalogue figures; the unit has one only when it IS the applied price.
  const smartUsd = settleServicesAnchor(lifted({ applied: P, fee: a, anchor: a, usd: 64_000 }));
  assert.deepEqual([smartUsd.regular_usd_cents, smartUsd.applied_usd_cents, smartUsd.unit_subtotal_usd_cents], [64_000, 64_000, 64_000]);
  const justUsd = settleServicesAnchor(lifted({ applied: P, fee: 0, anchor: a, usd: 64_000 }));
  assert.deepEqual([justUsd.regular_usd_cents, justUsd.applied_usd_cents, justUsd.unit_subtotal_usd_cents], [64_000, 64_000, undefined]);
});

test('the views: net fee and anchor only on an anchored line; the offer drops its anchor when the line is not anchored; old snapshots read as before', () => {
  const c = liveConfig();
  const priced = priceServices(c, A1, pkg(c, 'just', 'economy'));
  assert.deepEqual(Object.keys(pricedServicesView(priced)), ['fee_iqd', 'lines', 'warranty_months', 'delivery_fee_iqd', 'blockers']);
  const anchored = pricedServicesView({ ...priced, anchor_fee_iqd: 44_000 });
  assert.deepEqual([anchored.fee_iqd, anchored.anchor_fee_iqd, anchored.net_fee_iqd], [0, 44_000, -44_000]);
  const offer = servicesOffer(c, A1);
  assert.equal(offerForLine(offer, { applied_iqd: 840_000 }), offer, 'no choice yet, a price above the anchor');
  assert.equal('anchor' in offerForLine(offer, { applied_iqd: 30_000 }), false, 'a price below the anchor');
  assert.equal('anchor' in offerForLine(offer, { applied_iqd: 30_000, services: priced }), false, 'a priced line the anchor was dropped from');
  assert.equal(offerForLine(offer, { applied_iqd: 796_000, services: { ...priced, anchor_fee_iqd: 44_000 } }), offer);
  const plainOffer = servicesOffer(clone(), A1);
  assert.equal(offerForLine(plainOffer, { applied_iqd: 1 }), plainOffer);

  // A snapshot frozen before phase 6: no anchor keys, the same view; finance splits it exactly as before.
  const oldSnap = JSON.stringify(priceServices(clone(), A1, pkg(c, 'smart', 'economy')));
  const view = orderServicesView(oldSnap)!;
  assert.deepEqual(['anchor_fee_iqd' in view, 'net_fee_iqd' in view, view.fee_iqd], [false, false, 44_000]);
  const newView = orderServicesView(JSON.stringify({ ...priceServices(c, A1, pkg(c, 'just', 'pickup')), anchor_fee_iqd: 44_000 }))!;
  assert.deepEqual([newView.anchor_fee_iqd, newView.net_fee_iqd, newView.delivery], [44_000, -44_000, 'pickup']);
  // The frozen form for the store's pickup method is the one phase 1 wrote: delivery 'pickup', no delivery fee key.
  const frozen = servicesForMethod(priceServices(c, A1, pkg(c, 'smart', 'pickup')), 'pickup') as Record<string, unknown>;
  assert.deepEqual([(frozen.selection as ServiceSelection).delivery, 'delivery_fee_iqd' in frozen], ['pickup', false]);
});

test('finance: the printer part and the services part of an anchored line sum to the line, for every package', () => {
  const c = liveConfig();
  const P = 840_000; const a = 44_000; const qty = 3;
  for (const id of ['just', 'smart', 'complete'] as const) {
    const priced = { ...priceServices(c, A1, pkg(c, id, 'economy')), anchor_fee_iqd: a };
    const total = (P - a + priced.fee_iqd) * qty;
    for (const net of [total, total - 91_000]) {
      const s = splitServicedLine({ qty, line_total_iqd: total, net_goods_iqd: net, services_snapshot: JSON.stringify(priced) });
      assert.equal(s.printer_net + s.services_net, net, `${id} ${net}`);
      assert.equal(s.gross, priced.fee_iqd * qty);
      assert.ok(s.printer_net >= 0 && s.services_net >= 0);
      assert.equal(Object.values(s.services).reduce((x, y) => x + y, 0), s.services_net);
      if (net === total) assert.equal(s.printer_net, (P - a) * qty, 'at full price the printer\'s part is P − anchor');
    }
  }
});

test('a page that does not know the phase 6 fields keeps what the stored draft holds', () => {
  const stored = liveConfig((c) => { c.delivery.classes.d6 = { economy_iqd: 10_000, personal_iqd: 25_000 }; });
  const posted = JSON.parse(JSON.stringify(legacyConfig())) as Record<string, unknown>;
  keepPhase6Fields(posted, stored);
  const kept = posted as unknown as PrinterServicesConfig;
  assert.deepEqual([kept.price_anchor, kept.delivery.pickup, kept.delivery.classes.d6], ['smart', { active: true, note: NOTE }, { economy_iqd: 10_000, personal_iqd: 25_000 }]);
  // What the page DID send is what it meant.
  const explicit = JSON.parse(JSON.stringify(clone())) as Record<string, unknown>;
  keepPhase6Fields(explicit, stored);
  assert.deepEqual([(explicit as unknown as PrinterServicesConfig).price_anchor, (explicit as unknown as PrinterServicesConfig).delivery.pickup], ['none', { active: false, note: null }]);
});

test('the new refusal has words in Arabic, English and Sorani', () => {
  const w = REFUSAL_STRINGS[SERVICES_PICKUP_METHOD];
  assert.ok(w && w.ar && w.en && w.ckb && w.ckb !== w.ar);
});

// ================================================================== the doors

const OPS = JSON.stringify({ serialized: true, warranty_base_months: 12 });

function setup(config: PrinterServicesConfig | null = liveConfig()) {
  resetPolicyCorpusMemo();
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) raw.exec(readFileSync(join(dir, f), 'utf8'));
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','s@x.co','h','customer'), ('owner','Owner','owner@x.co','h','admin');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default) VALUES
      ('addr_b','buyer','Home','Sara','+9647701234567','Baghdad, Karrada 12','',1);
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status) VALUES
      ('dep_b','buyer','deposit','USD',900000,'approved');
  `);
  raw.prepare(
    `INSERT INTO products (id,slug,name,name_ar,price_iqd,prime_price_iqd,pro_price_iqd,status,stock,options,colors,selling_type,sale_types,warranty_plans,ops_policy,images)
     VALUES ('p_a1','a1-printer','Printer A1','طابعة A1',840000,NULL,NULL,'active',50,'[]','[]','direct_sale','["direct_sale"]','[]',?,'[]'),
            ('p_tiny','tiny-printer','Tiny printer','طابعة صغيرة',30000,NULL,NULL,'active',50,'[]','[]','direct_sale','["direct_sale"]','[]',?,'[]'),
            ('p_pla','pla-basic','PLA Basic','PLA أساسي',25000,NULL,NULL,'active',500,'[]','[]','direct_sale','["direct_sale"]','[]','{}','[]')`
  ).run(OPS, OPS);
  raw.exec(`
    INSERT INTO catalogs (id, slug, name_ar, is_printer_catalog) VALUES ('cat_p','test-p6-printers','طابعات',1), ('cat_f','test-p6-filaments','خيوط',0);
    INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES ('p_a1','cat_p',0), ('p_tiny','cat_p',1), ('p_pla','cat_f',0);
  `);
  if (config) {
    raw.prepare('INSERT INTO admin_settings (key, value) VALUES (?, ?)').run(
      'printerServices', JSON.stringify({ draft: config, published: config, published_at: '2026-11-19T00:00:00.000Z', published_by: 'owner' })
    );
  }
  const db = new SqliteD1(raw) as unknown as D1Database;
  forgetPricingInputs(db);
  return { raw, db };
}

function appAs(db: D1Database, userId: string, role: 'customer' | 'admin' = 'customer') {
  const a = new Hono<AppContext>();
  a.use('*', async (c, next) => {
    c.set('user', { id: userId, role, email: `${userId}@x.co`, username: userId, email_verified_at: '2026-01-01T00:00:00.000Z' } as never);
    c.set('host', classifyHost('levonis-iq.com', 'levonis-iq.com'));
    c.env = { DB: db, APP_ORIGIN: 'https://levonis-iq.com', STORE_ROOT_DOMAIN: 'levonis-iq.com', INITIAL_ADMIN_EMAIL: 'owner@x.co' } as never;
    await next();
  });
  a.use('*', autoPublishFromEnv);
  a.route('/api/cart', cartRoutes);
  a.route('/api/orders', orderRoutes);
  a.route('/api/products', productRoutes);
  a.route('/api/policies', policiesRoutes);
  a.route('/api/admin/printer-services', adminPrinterServiceRoutes);
  a.route('/api/price-protection', priceProtectionRoutes);
  a.route('/api/admin', adminRoutes);
  a.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ success: false, error: err.message, code: err.code, details: err.details ?? null }, err.status as 400);
    throw err;
  });
  return a;
}

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p.catch(() => undefined)); }, passThroughOnException() {} } as unknown as ExecutionContext;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response) => (await res.json()) as Record<string, any>;
const send = (a: ReturnType<typeof appAs>, method: string, path: string, body?: unknown) =>
  a.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, undefined, ctx);
const post = (a: ReturnType<typeof appAs>, path: string, body: unknown) => send(a, 'POST', path, body);
const put = (a: ReturnType<typeof appAs>, path: string, body: unknown) => send(a, 'PUT', path, body);
const get = (a: ReturnType<typeof appAs>, path: string) => send(a, 'GET', path);

let seq = 0;
const orderBody = (over: Record<string, unknown> = {}) => ({
  addressId: 'addr_b',
  deliveryMethodId: 'standard',
  printerStandardDeliveryAcceptance: { version: PRINTER_STANDARD_DELIVERY_POLICY.version, accepted: true },
  paymentMethodId: 'cash',
  useWallet: false,
  usePoints: false,
  itemIds: [],
  idempotencyKey: `p6-${Date.now()}-${++seq}`,
  policyAcceptance: acceptedPolicies(),
  ...over,
});

test('the quote: no choice = the catalogue price (it IS Smart); with a choice the unit follows it, and says the anchor and the net fee', async () => {
  const c = liveConfig();
  const { db } = setup(c);
  const a = appAs(db, 'buyer');
  const bare = await json(await post(a, '/api/products/a1-printer/quote', { qty: 1 }));
  assert.deepEqual([bare.quote.unit_subtotal_iqd, bare.quote.applied_iqd, bare.printer_services.selection], [840_000, 840_000, null]);
  assert.deepEqual(bare.printer_services.offer.anchor, { package: 'smart', fee_iqd: 44_000 });
  assert.deepEqual(bare.printer_services.offer.delivery, { economy: 5_000, personal: 15_000, pickup: { note: NOTE } });

  const expect: Array<[string, ServiceSelection, number, number]> = [
    ['just', pkg(c, 'just', null), 0, 796_000],
    ['smart', pkg(c, 'smart', null), 44_000, 840_000],
    ['complete', pkg(c, 'complete', null), 131_000, 927_000],
    ['custom', custom(null), 107_000, 903_000],
  ];
  for (const [name, services, fee, unit] of expect) {
    const q = await json(await post(a, '/api/products/a1-printer/quote', { qty: 2, services }));
    assert.deepEqual(q.quote.errors ?? [], [], name);
    // The printer's own figures are the bare quote's: only the unit follows the choice.
    assert.deepEqual([q.quote.unit_subtotal_iqd, q.quote.line_total_iqd, q.quote.applied_iqd, q.quote.regular_iqd], [unit, unit * 2, 840_000, 840_000], name);
    assert.deepEqual([q.quote.offer_before_iqd, q.quote.offer_saving_percent], [bare.quote.offer_before_iqd, bare.quote.offer_saving_percent], name);
    const sel = q.printer_services.selection;
    assert.deepEqual([sel.fee_iqd, sel.anchor_fee_iqd, sel.net_fee_iqd], [fee, 44_000, fee - 44_000], name);
    assert.equal(q.quote.applied_iqd + sel.net_fee_iqd, q.quote.unit_subtotal_iqd, name);
    assert.deepEqual(q.printer_services.offer.anchor, { package: 'smart', fee_iqd: 44_000 }, name);
  }
  // A preview before the customer confirmed is still a quote (the cart asks for the confirmation).
  const preview = await json(await post(a, '/api/products/a1-printer/quote', { qty: 1, services: presetSelection(c, 'just') }));
  assert.equal(preview.quote.unit_subtotal_iqd, 796_000);
  // The pickup choice is free in the quote.
  const pick = await json(await post(a, '/api/products/a1-printer/quote', { qty: 1, services: pkg(c, 'smart', 'pickup') }));
  assert.deepEqual([pick.printer_services.selection.delivery_fee_iqd, pick.printer_services.selection.blockers], [0, []]);
});

test('cart = quote = order for every package under the anchor; the snapshot keeps the real fee and the anchor; finance sums to the line', async () => {
  const c = liveConfig();
  const cases: Array<[string, ServiceSelection, number, number]> = [
    ['just', pkg(c, 'just', 'economy'), 0, 796_000],
    ['smart', pkg(c, 'smart', 'personal'), 44_000, 840_000],
    ['complete', pkg(c, 'complete', 'economy'), 131_000, 927_000],
    ['custom', custom('personal'), 107_000, 903_000],
  ];
  for (const [name, services, fee, unit] of cases) {
    const { db, raw } = setup(c);
    const a = appAs(db, 'buyer');
    const quoted = await json(await post(a, '/api/products/a1-printer/quote', { qty: 2, services }));
    const added = await post(a, '/api/cart/items', { productId: 'p_a1', qty: 2, services });
    const cart = await json(added);
    assert.equal(added.status, 200, `${name}: ${JSON.stringify(cart)}`);
    const line = cart.items[0];
    assert.deepEqual([line.unit_price_iqd, line.printer_services.priced.fee_iqd, line.printer_services.priced.anchor_fee_iqd, line.printer_services.priced.net_fee_iqd, line.printer_services.needs_choice],
      [unit, fee, 44_000, fee - 44_000, false], name);
    assert.equal(line.unit_price_iqd, quoted.quote.unit_subtotal_iqd, `${name}: cart = product quote`);
    assert.equal(line.printer_services.selection.package, services.package);

    const oq = await json(await post(a, '/api/orders/quote', orderBody()));
    assert.equal(oq.success, true, `${name}: ${JSON.stringify(oq)}`);
    assert.equal(oq.quote.subtotal_iqd, unit * 2, `${name}: order quote = cart`);
    assert.equal('printer_pickup' in oq.quote, false);

    const placed = await post(a, '/api/orders', orderBody());
    const body = await json(placed);
    assert.equal(placed.status, 200, `${name}: ${JSON.stringify(body)}`);
    const item = body.order.items[0];
    assert.deepEqual([item.unit_price_iqd, item.line_total_iqd, Number(body.order.subtotal_iqd)], [unit, unit * 2, unit * 2], `${name}: order = quote`);
    assert.deepEqual([item.services.fee_iqd, item.services.anchor_fee_iqd, item.services.net_fee_iqd, item.services.selection.package], [fee, 44_000, fee - 44_000, services.package], name);

    const row = raw.prepare('SELECT * FROM order_items WHERE order_id = ?').get(body.order.id) as Record<string, unknown>;
    const snap = JSON.parse(String(row.services_snapshot));
    assert.deepEqual([snap.fee_iqd, snap.anchor_fee_iqd, snap.net_fee_iqd, snap.revision], [fee, 44_000, fee - 44_000, 1], name);
    const pricing = JSON.parse(String(row.pricing_snapshot));
    assert.deepEqual([pricing.applied_iqd, pricing.regular_iqd, pricing.unit_subtotal_iqd], [840_000, 840_000, unit], `${name}: the catalogue figures are frozen untouched`);
    // Rule E: the engine basis is stored exactly as on an unanchored line (it needs regular = the engine price).
    assert.deepEqual([row.price_basis, Number(row.engine_regular_iqd)], ['engine', 840_000], `${name}: engine basis`);
    // Rule C: the goods base is min(applied, unit) — the Smart / Complete buyer's is the catalogue price, as before the switch.
    const stored = raw.prepare('SELECT merchandise_iqd FROM orders WHERE id = ?').get(body.order.id) as { merchandise_iqd: number };
    assert.equal(Number(stored.merchandise_iqd), Math.min(840_000, unit) * 2, `${name}: merchandise`);
    assert.ok(Number(stored.merchandise_iqd) <= unit * 2, `${name}: never more than the line charges`);
    assert.deepEqual('goods_base_unit_iqd' in line ? line.goods_base_unit_iqd : null, unit < 840_000 ? unit : null, `${name}: the cart names the base only when it is below the applied price`);
    const split = splitServicedLine({ qty: row.qty, line_total_iqd: row.line_total_iqd, net_goods_iqd: row.line_total_iqd, services_snapshot: row.services_snapshot });
    assert.deepEqual([split.printer_net, split.services_net, split.printer_net + split.services_net], [796_000 * 2, fee * 2, unit * 2], `${name}: finance`);
    raw.close();
  }
});

test('an anchored printer with NO choice is priced and recorded as Smart at every door — never the bare price with nothing in it', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'buyer');
  const added = await post(a, '/api/cart/items', { productId: 'p_a1', qty: 1 });
  const cart = await json(added);
  assert.equal(added.status, 200, JSON.stringify(cart));
  const line = cart.items[0];
  assert.deepEqual([line.unit_price_iqd, line.printer_services.needs_choice, line.printer_services.defaulted, line.printer_services.selection.package, line.printer_services.priced.net_fee_iqd],
    [840_000, false, true, 'smart', 0]);
  assert.equal((raw.prepare("SELECT services FROM cart_items WHERE user_id = 'buyer'").get() as { services: string }).services, '', 'nothing is invented into the stored line');
  // No delivery was chosen: the standard method still asks for it; the store's pickup method completes the order.
  const refused = await json(await post(a, '/api/orders', orderBody()));
  assert.equal(refused.code, 'SERVICES_DELIVERY_REQUIRED', JSON.stringify(refused));
  const placed = await post(a, '/api/orders', orderBody({ deliveryMethodId: 'pickup' }));
  const body = await json(placed);
  assert.equal(placed.status, 200, JSON.stringify(body));
  const item = body.order.items[0];
  assert.deepEqual([item.unit_price_iqd, item.services.selection.package, item.services.warranty_months, item.services.fee_iqd, item.services.anchor_fee_iqd], [840_000, 'smart', 12, 44_000, 44_000]);
  const snap = JSON.parse(String((raw.prepare('SELECT services_snapshot FROM order_items WHERE order_id = ?').get(body.order.id) as { services_snapshot: string }).services_snapshot));
  assert.deepEqual([snap.defaulted, snap.selection.confirmed, snap.selection.delivery], [true, true, 'pickup']);
  const tasks = raw.prepare('SELECT kind FROM order_service_tasks WHERE order_id = ?').all(body.order.id) as Array<{ kind: string }>;
  assert.deepEqual(tasks.map((t) => t.kind), ['packaging'], 'the warehouse gets the packing instruction');
});

test('no anchor: nothing changes — no choice is still refused, and the quote of a list saying «none» is the quote of a list stored before the field', async () => {
  const answers: string[] = [];
  for (const config of [legacyConfig(), (() => { const c = clone(); c.price_anchor = 'none'; c.delivery.pickup = { active: false, note: NOTE }; return c; })()]) {
    config.revision = 1;
    config.products = { p_a1: { warranty_family: 'a1', delivery_class: 'd1' } };
    const { db, raw } = setup(config);
    const a = appAs(db, 'buyer');
    const bare = await json(await post(a, '/api/products/a1-printer/quote', { qty: 1 }));
    const smart = await json(await post(a, '/api/products/a1-printer/quote', { qty: 1, services: pkg(config, 'smart', 'economy') }));
    assert.deepEqual([smart.quote.unit_subtotal_iqd, smart.quote.applied_iqd], [884_000, 840_000]);
    assert.deepEqual(Object.keys(smart.printer_services.selection), ['fee_iqd', 'lines', 'warranty_months', 'delivery_fee_iqd', 'blockers']);
    assert.equal('anchor' in smart.printer_services.offer, false);
    answers.push(JSON.stringify([bare.quote, bare.printer_services, smart.quote, smart.printer_services]));
    const none = await json(await post(a, '/api/cart/items', { productId: 'p_a1', qty: 1 }));
    assert.equal(none.code, 'SERVICES_REQUIRED');
    // The warehouse pickup is not offered: a posted choice is refused.
    const pick = await json(await post(a, '/api/cart/items', { productId: 'p_a1', qty: 1, services: pkg(config, 'smart', 'pickup') }));
    assert.equal(pick.code, SERVICES_OPTION_UNAVAILABLE);
    const added = await json(await post(a, '/api/cart/items', { productId: 'p_a1', qty: 1, services: pkg(config, 'smart', 'economy') }));
    assert.deepEqual([added.items[0].unit_price_iqd, Object.keys(added.items[0].printer_services)], [884_000, ['offer', 'selection', 'priced', 'needs_choice']]);
    const placed = await json(await post(a, '/api/orders', orderBody()));
    assert.equal(placed.success, true, JSON.stringify(placed));
    const snap = JSON.parse(String((raw.prepare('SELECT services_snapshot FROM order_items WHERE order_id = ?').get(placed.order.id) as { services_snapshot: string }).services_snapshot));
    assert.deepEqual(['anchor_fee_iqd' in snap, 'defaulted' in snap, 'anchor_fee_iqd' in placed.order.items[0].services], [false, false, false]);
    raw.close();
  }
  assert.equal(answers[0], answers[1], 'byte-identical');
});

test('a printer priced below its anchor is never anchored: it sells at its price plus the services, and the owner is told', async () => {
  const c = liveConfig((x) => { x.products.p_tiny = { warranty_family: 'a1', delivery_class: 'd1' }; });
  const { db, raw } = setup(c);
  const a = appAs(db, 'buyer');
  const bare = await json(await post(a, '/api/products/tiny-printer/quote', { qty: 1 }));
  assert.equal(bare.quote.unit_subtotal_iqd, 30_000);
  assert.equal('anchor' in bare.printer_services.offer, false, 'the page shows the «+» prices for this printer');
  const smart = await json(await post(a, '/api/products/tiny-printer/quote', { qty: 1, services: pkg(c, 'smart', 'economy') }));
  assert.deepEqual([smart.quote.unit_subtotal_iqd, smart.quote.applied_iqd, 'anchor_fee_iqd' in smart.printer_services.selection, 'anchor' in smart.printer_services.offer], [74_000, 30_000, false, false]);
  const just = await json(await post(a, '/api/products/tiny-printer/quote', { qty: 1, services: pkg(c, 'just', 'economy') }));
  assert.equal(just.quote.unit_subtotal_iqd, 30_000, 'never below its own price, never negative');
  // It behaves as a list with no anchor: no choice is refused, a choice is charged on top.
  assert.equal((await json(await post(a, '/api/cart/items', { productId: 'p_tiny', qty: 1 }))).code, 'SERVICES_REQUIRED');
  const added = await json(await post(a, '/api/cart/items', { productId: 'p_tiny', qty: 1, services: pkg(c, 'smart', 'economy') }));
  assert.equal(added.items[0].unit_price_iqd, 74_000);
  const placed = await json(await post(a, '/api/orders', orderBody()));
  assert.equal(placed.success, true, JSON.stringify(placed));
  assert.deepEqual([placed.order.items[0].unit_price_iqd, 'anchor_fee_iqd' in placed.order.items[0].services], [74_000, false]);
  // The owner is told beside the publish issues — never blocked.
  const notes = await printerAnchorNotes(db, c);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /^products\.p_tiny: its price \(30000\) is below the Smart package \(44000\)/);
  assert.deepEqual(await printerAnchorNotes(db, liveConfig()), []);
  assert.deepEqual(await printerAnchorNotes(db, { ...c, price_anchor: 'none' }), []);
  const admin = await json(await get(appAs(db, 'owner', 'admin'), '/api/admin/printer-services'));
  assert.deepEqual([admin.anchor_notes.length, admin.publish_issues], [1, []]);
  raw.close();
});

test('warehouse pickup at checkout: allowed with the store\'s pickup method and free; refused with its own code on any other', async () => {
  const c = liveConfig();
  const { db, raw } = setup(c);
  const a = appAs(db, 'buyer');
  const added = await post(a, '/api/cart/items', { productId: 'p_a1', qty: 2, services: pkg(c, 'complete', 'pickup') });
  assert.equal(added.status, 200, JSON.stringify(await json(added.clone())));
  const cartItemId = (raw.prepare("SELECT id FROM cart_items WHERE user_id = 'buyer'").get() as { id: string }).id;
  assert.equal((await json(added)).items[0].printer_services.priced.delivery_fee_iqd, 0);

  // The standard method still answers a quote — and says the pickup method is required.
  const std = await json(await post(a, '/api/orders/quote', orderBody()));
  assert.equal(std.success, true, JSON.stringify(std));
  assert.deepEqual(std.quote.printer_pickup, { required: true, satisfied: false, delivery_method_id: 'pickup', cart_item_ids: [cartItemId] });
  assert.equal(std.quote.shipping.components.some((x: { kind: string }) => x.kind === 'printer_service'), false, 'no courier fee is invented for a collected printer');
  const refused = await post(a, '/api/orders', orderBody());
  const why = await json(refused);
  assert.deepEqual([refused.status, why.code, why.details.cart_item_ids, why.details.required_delivery_method_id, why.details.delivery_method_id], [400, SERVICES_PICKUP_METHOD, [cartItemId], 'pickup', 'standard']);
  assert.ok(why.details.message.ar && why.details.message.en && why.details.message.ckb);
  assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number }).n, 0, 'nothing was written');

  const pick = await json(await post(a, '/api/orders/quote', orderBody({ deliveryMethodId: 'pickup' })));
  assert.deepEqual([pick.quote.printer_pickup.satisfied, pick.quote.is_pickup, pick.quote.subtotal_iqd], [true, true, 927_000 * 2]);
  const placed = await post(a, '/api/orders', orderBody({ deliveryMethodId: 'pickup' }));
  const body = await json(placed);
  assert.equal(placed.status, 200, JSON.stringify(body));
  const order = raw.prepare('SELECT shipping_iqd, subtotal_iqd FROM orders WHERE id = ?').get(body.order.id) as Record<string, unknown>;
  assert.deepEqual([Number(order.shipping_iqd ?? 0), Number(order.subtotal_iqd)], [0, 927_000 * 2], 'no delivery fee, the same line price');
  assert.deepEqual([body.order.items[0].services.delivery, body.order.items[0].services.delivery_fee_iqd], ['pickup', null]);
  raw.close();
});

test('class d6: a printer mapped to it is offered and charged the owner\'s two prices', async () => {
  const c = liveConfig((x) => { x.products.p_a1 = { warranty_family: 'a1', delivery_class: 'd6' }; x.delivery.classes.d6 = { economy_iqd: 10_000, personal_iqd: 25_000 }; });
  const { db, raw } = setup(c);
  const a = appAs(db, 'buyer');
  const q = await json(await post(a, '/api/products/a1-printer/quote', { qty: 1 }));
  assert.deepEqual(q.printer_services.offer.delivery, { economy: 10_000, personal: 25_000, pickup: { note: NOTE } });
  assert.equal((await post(a, '/api/cart/items', { productId: 'p_a1', qty: 2, services: pkg(c, 'smart', 'economy') })).status, 200);
  const placed = await json(await post(a, '/api/orders', orderBody()));
  assert.equal(placed.success, true, JSON.stringify(placed));
  const ship = JSON.parse(String((raw.prepare('SELECT delivery_method_snapshot FROM orders WHERE id = ?').get(placed.order.id) as { delivery_method_snapshot: string }).delivery_method_snapshot)).quote;
  const comp = ship.components.find((x: { kind: string }) => x.kind === 'printer_service');
  assert.deepEqual([comp.fee_iqd, comp.units, comp.printer_delivery, comp.delivery_class], [20_000, 2, 'economy', 'd6']);
  raw.close();
});

test('kits are unaffected by the anchor: the same kit price with and without it', async () => {
  const kit = { id: 'a1-starter', active: true, sort: 1, title: { ar: 'باقة البداية', en: 'Starter kit', ckb: 'پاکێجی دەستپێک' },
    items: [{ product_id: 'p_pla', option_value_ids: [], color_id: null, qty: 2 }], printers: null };
  const prices: number[] = [];
  for (const anchor of ['smart', 'none'] as const) {
    const { db, raw } = setup(liveConfig((x) => { x.price_anchor = anchor; x.kits = [kit]; }));
    const body = await json(await get(appAs(db, 'buyer'), '/api/products/a1-printer/kits?qty=1'));
    assert.equal(body.kits.length, 1, JSON.stringify(body));
    prices.push(body.kits[0].price_per_printer_iqd);
    raw.close();
  }
  assert.deepEqual(prices, [50_000, 50_000]);
});

test('admin: the draft saves the anchor, the pickup and class d6; a page that omits them keeps them; publishing refuses an anchor with Smart off', async () => {
  const { db, raw } = setup(null);
  const owner = appAs(db, 'owner', 'admin');
  const first = await json(await get(owner, '/api/admin/printer-services'));
  assert.deepEqual([first.draft.price_anchor, first.draft.delivery.pickup, first.draft.delivery.classes.d6, first.anchor_notes], ['none', { active: false, note: null }, { economy_iqd: null, personal_iqd: null }, []]);
  const draft = { ...first.draft, products: { p_a1: { warranty_family: 'a1', delivery_class: 'd6' } }, price_anchor: 'smart',
    delivery: { ...first.draft.delivery, pickup: { active: true, note: NOTE }, classes: { ...first.draft.delivery.classes, d6: { economy_iqd: 10_000, personal_iqd: 25_000 } } } };
  const saved = await json(await put(owner, '/api/admin/printer-services/draft', { draft, base_revision: first.draft.revision }));
  assert.equal(saved.success, true, JSON.stringify(saved));
  assert.deepEqual([saved.draft.price_anchor, saved.draft.delivery.pickup, saved.draft.delivery.classes.d6, saved.publish_issues], ['smart', { active: true, note: NOTE }, { economy_iqd: 10_000, personal_iqd: 25_000 }, []]);
  // An older page: no anchor, no pickup, no d6 in what it sends.
  const older = JSON.parse(JSON.stringify(saved.draft));
  delete older.price_anchor; delete older.delivery.pickup; delete older.delivery.classes.d6;
  const again = await json(await put(owner, '/api/admin/printer-services/draft', { draft: older, base_revision: saved.draft.revision }));
  assert.deepEqual([again.draft.price_anchor, again.draft.delivery.pickup.active, again.draft.delivery.classes.d6.economy_iqd], ['smart', true, 10_000]);
  // Smart switched off under the anchor: said on save, refused on publish.
  const off = { ...again.draft, packages: { ...again.draft.packages, smart: { ...again.draft.packages.smart, active: false } } };
  const offSaved = await json(await put(owner, '/api/admin/printer-services/draft', { draft: off, base_revision: again.draft.revision }));
  assert.ok(offSaved.publish_issues.some((i: string) => i.startsWith('price_anchor: the Smart package is off')));
  const refused = await json(await post(owner, '/api/admin/printer-services/publish', { base_revision: offSaved.draft.revision }));
  assert.equal(refused.code, 'PRINTER_SERVICES_NOT_READY');
  // Back on: it publishes, and customers are quoted under the anchor at once.
  const on = await json(await put(owner, '/api/admin/printer-services/draft', { draft: again.draft, base_revision: offSaved.draft.revision }));
  const live = await json(await post(owner, '/api/admin/printer-services/publish', { base_revision: on.draft.revision }));
  assert.equal(live.success, true, JSON.stringify(live));
  forgetPricingInputs(db);
  const q = await json(await post(appAs(db, 'buyer'), '/api/products/a1-printer/quote', { qty: 1, services: confirmed(presetSelection(live.published, 'just')) }));
  assert.deepEqual([q.quote.unit_subtotal_iqd, q.printer_services.selection.net_fee_iqd], [796_000, -44_000]);
  raw.close();
});

// ================================================================== the unchanged readers (rules A, C, E, I)

const setList = (raw: DatabaseSync, db: D1Database, config: PrinterServicesConfig) => {
  raw.prepare('INSERT INTO admin_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    'printerServices', JSON.stringify({ draft: config, published: config, published_at: '2026-11-19T00:00:00.000Z', published_by: 'owner' }));
  forgetPricingInputs(db);
};

test('price protection reads an anchored line with no change: Smart bought at the catalogue price, the price falls 20,000 → 20,000 credit per unit', async () => {
  const outcomes: Array<[number, number, number]> = [];
  for (const anchor of ['smart', 'none'] as const) {
    const c = liveConfig((x) => { x.price_anchor = anchor; });
    const { db, raw } = setup(c);
    const a = appAs(db, 'buyer');
    // Smart under the anchor is the catalogue price; without it the same printer bought with NO services is the comparison.
    const services = anchor === 'smart' ? pkg(c, 'smart', 'pickup') : pkg(c, 'just', 'pickup');
    assert.equal((await post(a, '/api/cart/items', { productId: 'p_a1', qty: 1, services })).status, 200);
    const placed = await json(await post(a, '/api/orders', orderBody({ deliveryMethodId: 'pickup' })));
    assert.equal(placed.success, true, JSON.stringify(placed));
    assert.equal(placed.order.items[0].unit_price_iqd, 840_000);
    raw.prepare("UPDATE orders SET status='delivered', stage='delivered', delivered_at=? WHERE id=?").run(new Date().toISOString(), placed.order.id);
    await repriceV2(raw, 'p_a1', 820_000);
    forgetPricingInputs(db);
    const item = raw.prepare('SELECT id FROM order_items WHERE order_id = ?').get(placed.order.id) as { id: string };
    const claim = await json(await post(a, '/api/price-protection/claims', { orderItemId: item.id }));
    assert.equal(claim.success, true, `${anchor}: ${JSON.stringify(claim)}`);
    outcomes.push([claim.claim.original_unit_iqd, claim.claim.observed_unit_iqd, claim.claim.eligible_unit_iqd]);
    raw.close();
  }
  assert.deepEqual(outcomes[0], [840_000, 820_000, 20_000], 'the anchored Smart line');
  assert.deepEqual(outcomes[0], outcomes[1], 'exactly what the same printer was owed before the switch');
});

test('rule C: a coupon reads the catalogue price for a Smart buyer (as before the switch) and what he pays for a Just Printer buyer — never more than the line', async () => {
  const run = async (anchor: 'smart' | 'none', services: (c: PrinterServicesConfig) => ServiceSelection) => {
    const c = liveConfig((x) => { x.price_anchor = anchor; });
    const { db, raw } = setup(c);
    raw.exec("INSERT INTO coupons(id,code,kind,value,min_total_iqd,active) VALUES ('p6-coupon','PHASE6','percent',10,0,1)");
    const a = appAs(db, 'buyer');
    const added = await post(a, '/api/cart/items', { productId: 'p_a1', qty: 1, services: services(c) });
    assert.equal(added.status, 200, JSON.stringify(await json(added.clone())));
    const q = await json(await post(a, '/api/orders/quote', orderBody({ deliveryMethodId: 'pickup', couponCode: 'PHASE6' })));
    assert.equal(q.success, true, JSON.stringify(q));
    const out = { subtotal: Number(q.quote.subtotal_iqd), discount: Number(q.quote.coupon?.discount_iqd ?? q.quote.coupon_discount_iqd ?? 0), merchandise: Number(q.quote.merchandise_iqd ?? NaN) };
    raw.close();
    return out;
  };
  const before = await run('none', (c) => pkg(c, 'just', 'pickup'));     // the bare printer before the switch: 840,000
  const smart = await run('smart', (c) => pkg(c, 'smart', 'pickup'));    // the same 840,000 under the anchor
  const just = await run('smart', (c) => pkg(c, 'just', 'pickup'));      // 796,000
  assert.deepEqual([before.subtotal, smart.subtotal, just.subtotal], [840_000, 840_000, 796_000]);
  assert.ok(before.discount > 0, JSON.stringify(before));
  assert.equal(smart.discount, before.discount, 'a Smart buyer\'s coupon is exactly what it was before the switch');
  assert.ok(just.discount <= smart.discount && just.discount <= just.subtotal, JSON.stringify(just));
  assert.equal(just.discount, Math.round(before.discount * 796_000 / 840_000), 'a Just Printer buyer\'s base is what he pays');
});

test('rule I: with no anchor the cart line and the order quote are byte-identical to a list stored before the field; a cart line stored before the flip reprices', async () => {
  const strip = (v: unknown) => JSON.stringify(v)
    .replace(/"(id|cart_item_id|product_image|added_at|created_at|updated_at|quote_id|expires_at)":"[^"]*"/g, '"$1":"·"')
    .replace(/ci_[0-9a-f]+/g, 'ci_·').replace(/oi_[0-9a-f]+/g, 'oi_·');
  const answers: string[][] = [];
  for (const config of [legacyConfig(), (() => { const c = clone(); c.price_anchor = 'none'; c.delivery.pickup = { active: false, note: null }; return c; })()]) {
    config.revision = 1;
    config.products = { p_a1: { warranty_family: 'a1', delivery_class: 'd1' } };
    const { db, raw } = setup(config);
    const a = appAs(db, 'buyer');
    assert.equal((await post(a, '/api/cart/items', { productId: 'p_a1', qty: 2, services: pkg(config, 'complete', 'personal') })).status, 200);
    const cart = await json(await get(a, '/api/cart'));
    const oq = await json(await post(a, '/api/orders/quote', orderBody({ idempotencyKey: 'p6-pin' })));
    assert.equal(oq.success, true, JSON.stringify(oq));
    assert.equal('goods_base_unit_iqd' in cart.items[0], false);
    assert.equal('printer_pickup' in oq.quote, false);
    answers.push([strip(cart.items[0]), strip(oq.quote)]);
    raw.close();
  }
  assert.equal(answers[0][0], answers[1][0], 'cart line');
  assert.equal(answers[0][1], answers[1][1], 'order quote');
  // The recorded figures of that line (phase 5): 840,000 + 131,000 per unit, Personal delivery 15,000 per printer.
  const line = JSON.parse(answers[0][0]);
  assert.deepEqual([line.unit_price_iqd, line.breakdown.applied_iqd, line.breakdown.regular_iqd, line.printer_services.priced], [
    971_000, 840_000, 840_000,
    { fee_iqd: 131_000, lines: [
      { service: 'warranty', choice: 'w24', fee_iqd: 100_000, policy_version: 1 }, { service: 'care', choice: 'c12', fee_iqd: 19_000, policy_version: 1 },
      { service: 'packaging', choice: 'extra', fee_iqd: 7_000 }, { service: 'inspection', choice: 'full', fee_iqd: 5_000 }, { service: 'academy', choice: 'recorded', fee_iqd: 0 },
    ], warranty_months: 24, delivery_fee_iqd: 15_000, blockers: [] },
  ]);
  assert.equal(JSON.parse(answers[0][1]).subtotal_iqd, 971_000 * 2);

  // A line put in the cart BEFORE the owner flips the switch reprices by itself: Smart 884,000 → 840,000, Just 840,000 → 796,000.
  for (const [id, was, now] of [['smart', 884_000, 840_000], ['just', 840_000, 796_000]] as const) {
    const before = liveConfig((x) => { x.price_anchor = 'none'; });
    const { db, raw } = setup(before);
    const a = appAs(db, 'buyer');
    const added = await json(await post(a, '/api/cart/items', { productId: 'p_a1', qty: 1, services: pkg(before, id, 'pickup') }));
    assert.equal(added.items[0].unit_price_iqd, was, id);
    setList(raw, db, liveConfig((x) => { x.revision = 2; }));
    const cart = await json(await get(a, '/api/cart'));
    assert.deepEqual([cart.items[0].unit_price_iqd, cart.items[0].breakdown.applied_iqd, cart.items[0].printer_services.priced.net_fee_iqd], [now, 840_000, now - 840_000], id);
    const placed = await json(await post(a, '/api/orders', orderBody({ deliveryMethodId: 'pickup' })));
    assert.equal(placed.success, true, JSON.stringify(placed));
    assert.equal(placed.order.items[0].unit_price_iqd, now, id);
    raw.close();
  }
});
