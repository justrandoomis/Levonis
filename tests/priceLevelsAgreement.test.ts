/**
 * THE PRICE THE PAGE PAINTS ON A TAP IS THE PRICE THE QUOTE WOULD ANSWER.
 *
 * The product page used to have exactly one source for a price — a debounced
 * POST to `/quote` — so choosing an option cost a round trip before the figure
 * could change, and the figure was HIDDEN for the whole of that window. The
 * fix publishes every reachable selection's price with the page itself
 * (`priceLevels`, worker/routes/products.ts), and the page paints from it.
 *
 * That is only safe while the published number and the quoted number are the
 * same number. This file is what makes that a rule rather than a hope: for
 * every fixture in the shared ladder list, at every tier, it asserts that each
 * published level equals `resolveUnitPrice` for the same selection — which is
 * exactly what the quote route calls. A divergence here is a customer shown
 * one price on tap and charged another at the door.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveUnitPrice, DEFAULT_PRO_POLICY, type PricingProduct, type Tier } from '../worker/lib/pricing';
import { priceLevels, type PricingCtx } from '../worker/routes/products';
import type { ProductDoc } from '../worker/lib/productModel';
import { LADDER_FIXTURES, col, opt, product } from './pricingLadderFixtures';

/** The document shape `priceLevels` reads: only the pricing surface matters. */
const asDoc = (p: PricingProduct): ProductDoc => p as unknown as ProductDoc;

const ctxFor = (tier: Tier, tierActive: boolean): PricingCtx => ({
  tier,
  tierActive,
  membershipActive: tierActive,
  proContext: tier === 'pro' && tierActive,
  proPolicy: DEFAULT_PRO_POLICY,
  transportDefaults: [],
  tierStatus: null,
});

const TIERS: Array<[Tier, boolean]> = [
  ['free', false],
  ['plus', true],
  ['prime', true],
  ['pro', true],
  // A membership that exists but is not active must price as ordinary — the
  // level map has to reproduce that too, not just the happy path.
  ['pro', false],
];

test('INVARIANT: every published level equals the resolver for the same selection, at every tier', () => {
  for (const f of LADDER_FIXTURES) {
    for (const [tier, active] of TIERS) {
      const ctx = ctxFor(tier, active);
      const levels = priceLevels(asDoc(f.product), ctx, null, 0);
      const expect = (optionId: string | null, colorId: string | null, where: string) => {
        const r = resolveUnitPrice({
          product: f.product,
          optionId,
          colorId,
          tier,
          tierActive: active,
          proPolicy: DEFAULT_PRO_POLICY,
          transportDefaults: [],
        });
        return { r, where: `${f.name} @${tier}${active ? '' : ' (inactive)'} / ${where}` };
      };

      const base = expect(null, null, 'base');
      assert.equal(levels.base.applied_iqd, base.r.applied_iqd, `${base.where} applied`);
      assert.equal(levels.base.regular_iqd, base.r.regular_iqd, `${base.where} regular`);
      assert.equal(levels.base.unit_subtotal_iqd, base.r.unit_subtotal_iqd, `${base.where} subtotal`);
      assert.equal(levels.base.applied_tier, base.r.applied_tier, `${base.where} tier`);

      for (const o of f.product.options.filter((x) => x.active !== false)) {
        const e = expect(o.id, null, `option:${o.id}`);
        assert.ok(levels.option[o.id], `${e.where} missing`);
        assert.equal(levels.option[o.id].applied_iqd, e.r.applied_iqd, `${e.where} applied`);
        assert.equal(levels.option[o.id].regular_iqd, e.r.regular_iqd, `${e.where} regular`);
        assert.equal(levels.option[o.id].unit_subtotal_iqd, e.r.unit_subtotal_iqd, `${e.where} subtotal`);
        assert.equal(levels.option[o.id].applied_tier, e.r.applied_tier, `${e.where} tier`);
      }

      for (const c of f.product.colors.filter((x) => x.active !== false)) {
        const e = expect(null, c.id, `color:${c.id}`);
        assert.ok(levels.color[c.id], `${e.where} missing`);
        assert.equal(levels.color[c.id].applied_iqd, e.r.applied_iqd, `${e.where} applied`);
        assert.equal(levels.color[c.id].regular_iqd, e.r.regular_iqd, `${e.where} regular`);
        assert.equal(levels.color[c.id].unit_subtotal_iqd, e.r.unit_subtotal_iqd, `${e.where} subtotal`);
      }

      for (const [key, lvl] of Object.entries(levels.combo)) {
        const [o, c] = key.split('|');
        const e = expect(o, c, `combo:${key}`);
        assert.equal(lvl.applied_iqd, e.r.applied_iqd, `${e.where} applied`);
        assert.equal(lvl.regular_iqd, e.r.regular_iqd, `${e.where} regular`);
        assert.equal(lvl.unit_subtotal_iqd, e.r.unit_subtotal_iqd, `${e.where} subtotal`);
      }
    }
  }
});

test('a colour linked to one option contributes only that pair — never a combination the choosers cannot reach', () => {
  const p = product({
    options: [opt('o1', { regular_price_iqd: 200_000 }), opt('o2', { regular_price_iqd: 300_000 })],
    colors: [col('c1', { option_id: 'o1' }), col('c2', { option_ids: ['o2'] }), col('c3')],
  });
  const levels = priceLevels(asDoc(p), ctxFor('free', false), null, 0);
  const keys = Object.keys(levels.combo).sort();
  assert.deepEqual(keys, ['o1|c1', 'o1|c3', 'o2|c2', 'o2|c3']);
  assert.equal(levels.complete, true);
});

test('a combination grid past the ceiling is reported as incomplete rather than published half-answered', () => {
  // 16 × 16 = 256 pairs, past MAX_LEVELS (240). The page must then wait for
  // the quote on a combination instead of reading a key that is not there.
  const many = (n: number, mk: (i: number) => unknown) => Array.from({ length: n }, (_, i) => mk(i));
  const p = product({
    options: many(16, (i) => opt(`o${i}`, { regular_price_iqd: 150_000 + i * 1_000 })) as PricingProduct['options'],
    colors: many(16, (i) => col(`c${i}`, { regular_adjust_iqd: i * 500 })) as PricingProduct['colors'],
  });
  const levels = priceLevels(asDoc(p), ctxFor('free', false), null, 0);
  assert.equal(levels.complete, false);
  assert.deepEqual(levels.combo, {});
  // The single-level prices are still published: those are what the FIRST tap
  // reaches, and they are what the "starts from" teaser retires against.
  assert.equal(Object.keys(levels.option).length, 16);
  assert.equal(Object.keys(levels.color).length, 16);
});

test('an inactive option or colour is never priced into the map', () => {
  const p = product({
    options: [opt('live', { regular_price_iqd: 200_000 }), opt('dead', { active: false, regular_price_iqd: 1 })],
    colors: [col('shown'), col('hidden', { active: false })],
  });
  const levels = priceLevels(asDoc(p), ctxFor('free', false), null, 0);
  assert.deepEqual(Object.keys(levels.option), ['live']);
  assert.deepEqual(Object.keys(levels.color), ['shown']);
  assert.ok(!Object.keys(levels.combo).some((k) => k.includes('dead') || k.includes('hidden')));
});
