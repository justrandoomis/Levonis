/**
 * THE STORE-SAFE OFFER, PURE (Services S-P2 spec §4, §13.1; DECISIONS row 238).
 *
 *   worked     the plan's figures, exactly: the 9-month A1 Combo → 545,000 (margin 105,700);
 *              V1 (bought at 850,000, new today 500,000) → 300,000; a cheaper pre-order route
 *              (470,000) → 280,000
 *   defaults   each family at its §4.4 parameters
 *   property   2,000 seeded cases per invariant: offer ≤ Σ paid, ≤ Σ now × max_offer, ≤ Σ store cap,
 *              < Σ now; a whole Combo ≤ combo_now × max_offer; integers; rounding always down
 *   split      what was paid splits exactly; the settlement takes the collection fee off the credit
 *
 * Run: node --import tsx --test tests/sv2_p2_offer_formula.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blankInputs, type ComponentInputs, type TradeInFamily, type Score } from '../packages/pricing/src/tradeIn';
import { DEFAULT_RULE_SETS } from '../packages/pricing/src/tradeInDefaults';
import {
  DEFAULT_OFFER_PARAMS,
  componentOffer,
  paramsOf,
  requestOffer,
  settlement,
  splitPaid,
  validateOfferParams,
  type ComponentOffer,
} from '../packages/pricing/src/tradeInOffer';

const fdm = DEFAULT_OFFER_PARAMS.fdm;
const ams = DEFAULT_OFFER_PARAMS.ams;

test('worked: the 9-month A1 Combo is offered 545,000 — the printer 404,405, the AMS 142,315, expected margin 105,700', () => {
  const combo = 1_000_000;
  const plain = 750_000;
  const amsNow = Math.min(combo - plain, 320_000);
  const [paidA, paidP] = splitPaid(1_100_000, [amsNow, combo - amsNow]);
  assert.deepEqual([paidA, paidP], [275_000, 825_000]);
  const P = componentOffer(DEFAULT_RULE_SETS.fdm, fdm, { role: 'device', family: 'fdm', now_iqd: plain, paid_iqd: paidP, usage_months: 9, warranty_left_months: 3, product_id: 'p', inputs: { ...blankInputs('fdm'), hours: 600 } });
  const A = componentOffer(DEFAULT_RULE_SETS.ams, ams, { role: 'ams', family: 'ams', now_iqd: amsNow, paid_iqd: paidA, usage_months: 9, warranty_left_months: 3, product_id: 'p', inputs: blankInputs('ams') });
  assert.deepEqual(
    [P.base_iqd, P.q_bp, P.cond_iqd, P.resale_iqd, P.costs_iqd, P.margin_iqd, P.store_cap_iqd, P.offer_iqd],
    [750_000, 8530, 637_000, 511_800, 30_625, 76_770, 404_405, 404_405]
  );
  assert.deepEqual(
    [A.base_iqd, A.q_bp, A.cond_iqd, A.resale_iqd, A.costs_iqd, A.margin_iqd, A.store_cap_iqd, A.offer_iqd],
    [250_000, 9070, 200_000, 181_400, 11_875, 27_210, 142_315, 142_315]
  );
  const r = requestOffer([A, P], { wholeComboNowIqd: combo, fdmParams: fdm, rounding: fdm.offer_rounding_iqd, minOffer: fdm.min_offer_iqd });
  assert.equal(r.offer_iqd, 545_000);
  assert.equal(r.expected_margin_iqd, 105_700);
});

test('worked V1: bought at 850,000, new today 500,000 → 300,000; a cheaper pre-order route at 470,000 → 280,000', () => {
  const offer = (now: number) => {
    const c = componentOffer(DEFAULT_RULE_SETS.fdm, fdm, { role: 'device', family: 'fdm', now_iqd: now, paid_iqd: 850_000, usage_months: 0, warranty_left_months: 12, product_id: 'p', inputs: blankInputs('fdm') });
    return { c, r: requestOffer([c], { wholeComboNowIqd: null, fdmParams: fdm, rounding: 5_000, minOffer: 50_000 }) };
  };
  const v1 = offer(500_000);
  assert.deepEqual([v1.c.cond_iqd, v1.c.resale_iqd, v1.c.costs_iqd, v1.c.margin_iqd, v1.c.offer_iqd], [425_000, 400_000, 40_000, 60_000, 300_000]);
  assert.equal(v1.r.offer_iqd, 300_000);
  assert.ok(v1.r.offer_iqd! < 500_000, 'below what the same model costs new today');
  assert.equal(offer(470_000).r.offer_iqd, 280_000);
});

test('defaults: each family at its §4.4 parameters; a stored NULL is the default, a stored value wins, cap_bp is the rule set\'s', () => {
  const table: Record<TradeInFamily, [number, number, number, number, number, number, number, number]> = {
    fdm: [8000, 25_000, 25, 1500, 50_000, 7000, 8500, 50_000],
    resin: [7000, 25_000, 25, 1500, 50_000, 6000, 8000, 50_000],
    laser: [7500, 30_000, 25, 1500, 50_000, 6500, 8000, 50_000],
    ams: [8000, 10_000, 25, 1500, 20_000, 7000, 8000, 20_000],
    accessory: [6000, 5_000, 0, 2000, 10_000, 5000, 7000, 10_000],
  };
  for (const [f, t] of Object.entries(table) as Array<[TradeInFamily, typeof table.fdm]>) {
    const p = paramsOf({ family: f, cap_bp: DEFAULT_RULE_SETS[f].cap_bp, resale_bp: null });
    assert.deepEqual(
      [p.resale_bp, p.handling_iqd, p.warranty_reserve_bp, p.margin_bp, p.margin_min_iqd, p.max_offer_bp, p.cap_bp, p.min_offer_iqd, p.offer_rounding_iqd],
      [...t, 5_000],
      f
    );
  }
  assert.equal(paramsOf({ family: 'fdm', cap_bp: 9000, margin_bp: 2000 }).margin_bp, 2000);
  assert.equal(paramsOf({ family: 'fdm', cap_bp: 9000 }).cap_bp, 9000);
  assert.equal(paramsOf({ family: 'fdm', cap_bp: 8500, max_offer_bp: 9600 }).max_offer_bp, 7000, 'out of the CHECK range: the default');
  assert.deepEqual(validateOfferParams({ max_offer_bp: 9501 }), { ok: false, errors: ['params.max_offer_bp'] });
  assert.deepEqual(validateOfferParams({ margin_bp: null, handling_iqd: 30_000 }), { ok: true, value: { margin_bp: null, handling_iqd: 30_000 } });
});

/** A small seeded PRNG (mulberry32): the same 2,000 cases every run. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInputs(r: () => number, family: TradeInFamily): ComponentInputs {
  const score = () => (1 + Math.floor(r() * 5)) as Score;
  const faults = DEFAULT_RULE_SETS[family].factors.find((f) => f.factor === 'faults');
  const ids = faults && faults.config.kind === 'checklist' ? faults.config.items.map((i) => i.id) : [];
  return {
    ...blankInputs(family),
    hours: family === 'ams' || family === 'accessory' ? null : Math.floor(r() * 6000),
    cleanliness: score(),
    exterior: score(),
    scratches: score(),
    accessory_condition: score(),
    faults: ids.filter(() => r() < 0.15),
    repairs_count: Math.floor(r() * 4),
    original_accessories: (['all', 'partial', 'none'] as const)[Math.floor(r() * 3)],
  };
}

test('property (2,000 seeded cases): integers; offer ≤ paid, ≤ now × max_offer, ≤ store cap when positive, < now; rounding down; a whole Combo ≤ combo × max_offer', () => {
  const r = rng(2026_10_15);
  const families: TradeInFamily[] = ['fdm', 'resin', 'laser', 'ams', 'accessory'];
  for (let i = 0; i < 2000; i++) {
    const family = families[Math.floor(r() * families.length)];
    const p = DEFAULT_OFFER_PARAMS[family];
    const now = 50_000 + Math.floor(r() * 5_000_000);
    const paid = Math.floor(r() * 6_000_000);
    const c = componentOffer(DEFAULT_RULE_SETS[family], p, {
      role: 'device',
      family,
      now_iqd: now,
      paid_iqd: paid,
      usage_months: Math.floor(r() * 60),
      warranty_left_months: Math.floor(r() * 24),
      product_id: 'p',
      inputs: randomInputs(r, family),
    });
    for (const [k, v] of Object.entries(c)) if (typeof v === 'number') assert.ok(Number.isSafeInteger(v), `${k} = ${v} is not an integer (case ${i})`);
    assert.ok(c.offer_iqd >= 0);
    assert.ok(c.offer_iqd <= paid, `case ${i}: offer ${c.offer_iqd} above paid ${paid}`);
    assert.ok(c.offer_iqd <= Math.floor((now * p.max_offer_bp) / 10_000), `case ${i}: above max_offer`);
    if (c.store_cap_iqd > 0) assert.ok(c.offer_iqd <= c.store_cap_iqd, `case ${i}: above the store cap`);
    else assert.equal(c.offer_iqd, 0, `case ${i}: a negative store cap offers nothing`);
    assert.ok(c.offer_iqd < now, `case ${i}: at or above new`);
    const req = requestOffer([c], { wholeComboNowIqd: null, fdmParams: p, rounding: p.offer_rounding_iqd, minOffer: p.min_offer_iqd });
    if (req.offer_iqd !== null) {
      assert.equal(req.offer_iqd % p.offer_rounding_iqd, 0);
      assert.ok(req.offer_iqd <= c.offer_iqd && c.offer_iqd - req.offer_iqd < p.offer_rounding_iqd, 'rounded DOWN, by less than one step');
      assert.ok(req.offer_iqd >= p.min_offer_iqd);
    } else assert.ok(Math.floor(c.offer_iqd / p.offer_rounding_iqd) * p.offer_rounding_iqd < p.min_offer_iqd || c.offer_iqd === 0);
  }
  // A whole Combo: the two parts never exceed the Combo's own max_offer share.
  for (let i = 0; i < 2000; i++) {
    const combo = 300_000 + Math.floor(r() * 3_000_000);
    const amsNow = Math.floor(combo * (0.1 + r() * 0.4));
    const parts: ComponentOffer[] = [
      componentOffer(DEFAULT_RULE_SETS.ams, ams, { role: 'ams', family: 'ams', now_iqd: amsNow, paid_iqd: Math.floor(amsNow * (0.5 + r())), usage_months: Math.floor(r() * 30), warranty_left_months: Math.floor(r() * 12), product_id: 'p', inputs: randomInputs(r, 'ams') }),
      componentOffer(DEFAULT_RULE_SETS.fdm, fdm, { role: 'device', family: 'fdm', now_iqd: combo - amsNow, paid_iqd: Math.floor((combo - amsNow) * (0.5 + r())), usage_months: Math.floor(r() * 30), warranty_left_months: Math.floor(r() * 12), product_id: 'p', inputs: randomInputs(r, 'fdm') }),
    ];
    const req = requestOffer(parts, { wholeComboNowIqd: combo, fdmParams: fdm, rounding: 5_000, minOffer: 50_000 });
    if (req.offer_iqd !== null) {
      assert.ok(req.offer_iqd <= Math.floor((combo * fdm.max_offer_bp) / 10_000), `combo case ${i}`);
      assert.ok(req.offer_iqd <= parts[0].offer_iqd + parts[1].offer_iqd);
      assert.ok(req.offer_iqd <= parts[0].paid_iqd + parts[1].paid_iqd);
    }
  }
});

test('below the minimum there is no offer, and an offer is never rounded up', () => {
  const c = { offer_iqd: 49_999, resale_iqd: 0, costs_iqd: 0, store_cap_iqd: 0 } as ComponentOffer;
  assert.equal(requestOffer([c], { wholeComboNowIqd: null, fdmParams: fdm, rounding: 5_000, minOffer: 50_000 }).offer_iqd, null);
  const d = { offer_iqd: 54_999, resale_iqd: 0, costs_iqd: 0, store_cap_iqd: 0 } as ComponentOffer;
  assert.equal(requestOffer([d], { wholeComboNowIqd: null, fdmParams: fdm, rounding: 5_000, minOffer: 50_000 }).offer_iqd, 50_000);
});

test('splitPaid sums exactly, AMS first, the printer the rest; settlement: the fee comes off the credit, never below 0 nor above the target', () => {
  const r = rng(7);
  for (let i = 0; i < 2000; i++) {
    const paid = Math.floor(r() * 10_000_000);
    const nows = [Math.floor(r() * 1_000_000), Math.floor(r() * 3_000_000)];
    const parts = splitPaid(paid, nows);
    assert.equal(parts[0] + parts[1], paid);
    assert.ok(parts.every((x) => Number.isSafeInteger(x) && x >= 0));
  }
  assert.deepEqual(splitPaid(100, [0, 0]), [0, 100]);
  assert.deepEqual(settlement(1_500_000, 545_000, 5_000), { target_price_iqd: 1_500_000, trade_in_value_iqd: 545_000, credit_iqd: 540_000, difference_iqd: 960_000, excess_iqd: 0, pickup_fee_iqd: 5_000 });
  assert.deepEqual(settlement(400_000, 545_000, 5_000), { target_price_iqd: 400_000, trade_in_value_iqd: 545_000, credit_iqd: 400_000, difference_iqd: 0, excess_iqd: 140_000, pickup_fee_iqd: 5_000 });
  assert.equal(settlement(400_000, 3_000, 5_000).credit_iqd, 0, 'never below 0');
});
