/**
 * THE RESOLVER'S LADDER INVARIANTS, pinned over the shared fixture list
 * (tests/pricingLadderFixtures.ts).
 *
 *  1. PRO ≤ PRIME ≤ Regular on every resolved line where the values exist —
 *     including the legacy rows the validators now refuse, because those are
 *     the rows a clamp exists for.
 *  2. A PRO member never pays more than a PRIME member: a line with a PRIME
 *     price but no PRO of its own (PRIME-only product, or a base PRO swallowed
 *     by a reduction) charges PRO members the PRIME price, and `pro_iqd` says
 *     so.
 *  3. `product_cost_iqd` never influences, and never leaks into, a member
 *     price.
 *  4. `derivedRung` reports a PRIME-below-PRO inversion (the H1 input).
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampMemberLadder, derivedRung, resolveUnitPrice, type Tier } from '../worker/lib/pricing';
import { LADDER_FIXTURES, col, opt, product, selectionsOf } from './pricingLadderFixtures';

const TIERS: Tier[] = ['free', 'prime', 'pro'];
const resolve = (p: Parameters<typeof resolveUnitPrice>[0]['product'], sel: { optionId: string | null; colorId: string | null }, tier: Tier) =>
  resolveUnitPrice({ product: p, optionId: sel.optionId, colorId: sel.colorId, tier, tierActive: tier !== 'free' });

// ------------------------------------------------------------ 1. the order

test('INVARIANT: PRO ≤ PRIME ≤ Regular on every resolved line of every fixture, accepted or refused', () => {
  for (const f of LADDER_FIXTURES) {
    for (const sel of selectionsOf(f.product)) {
      for (const tier of TIERS) {
        const r = resolve(f.product, sel, tier);
        const where = `${f.name} / ${sel.optionId ?? '-'}|${sel.colorId ?? '-'} / ${tier}`;
        if (r.prime_iqd !== null) assert.ok(r.prime_iqd <= r.regular_iqd, `${where}: PRIME ${r.prime_iqd} above regular ${r.regular_iqd}`);
        if (r.pro_iqd !== null) assert.ok(r.pro_iqd <= r.regular_iqd, `${where}: PRO ${r.pro_iqd} above regular ${r.regular_iqd}`);
        if (r.pro_iqd !== null && r.prime_iqd !== null) assert.ok(r.pro_iqd <= r.prime_iqd, `${where}: PRO ${r.pro_iqd} above PRIME ${r.prime_iqd}`);
        assert.ok(r.applied_iqd <= r.regular_iqd, `${where}: a member paid more than the regular price`);
      }
    }
  }
});

test('INVARIANT: a PRO member never pays more than a PRIME member, on any line of any fixture', () => {
  for (const f of LADDER_FIXTURES) {
    for (const sel of selectionsOf(f.product)) {
      const prime = resolve(f.product, sel, 'prime').applied_iqd;
      const pro = resolve(f.product, sel, 'pro').applied_iqd;
      assert.ok(pro <= prime, `${f.name} / ${sel.optionId ?? '-'}|${sel.colorId ?? '-'}: PRO paid ${pro}, PRIME paid ${prime}`);
    }
  }
});

// ------------------------------------------------- 2. PRO falls back to PRIME

test('M3: a colour whose fixed price swallows the option\'s own PRO charges PRO members the PRIME price', () => {
  // Base 150/125/100k; option +100,000 with its own PRO 40,000; colour fixed
  // 130,000 on it. Regular 130,000, PRIME 125,000 + (130,000 − 250,000) =
  // 105,000, PRO 40,000 − 120,000 ≤ 0 → nothing carried. Before this rule a
  // PRO member paid 130,000 while a PRIME member paid 105,000.
  const p = product({ options: [opt('o1', { regular_adjust_iqd: 100_000, pro_price_iqd: 40_000 })], colors: [col('c1', { option_id: 'o1', regular_price_iqd: 130_000 })] });
  const sel = { optionId: 'o1', colorId: 'c1' };
  assert.equal(resolve(p, sel, 'free').regular_iqd, 130_000);
  const prime = resolve(p, sel, 'prime');
  assert.equal(prime.prime_iqd, 105_000);
  assert.equal(prime.applied_iqd, 105_000);
  const pro = resolve(p, sel, 'pro');
  assert.equal(pro.pro_iqd, 105_000, 'pro_iqd reports the number charged, so every display agrees');
  assert.equal(pro.applied_iqd, 105_000);
  assert.equal(pro.applied_tier, 'pro');
});

test('a PRIME-only product charges PRO members the PRIME price, not the regular one', () => {
  const p = product({ pro_price_iqd: null, options: [opt('o1', { regular_adjust_iqd: 25_000 })] });
  const base = resolve(p, { optionId: null, colorId: null }, 'pro');
  assert.equal(base.pro_iqd, 125_000);
  assert.equal(base.applied_iqd, 125_000);
  const withOption = resolve(p, { optionId: 'o1', colorId: null }, 'pro');
  assert.equal(withOption.pro_iqd, 150_000, 'the fallback carries the surcharge like every member price');
  assert.equal(withOption.applied_iqd, 150_000);
});

test('no member price on the line at all: nothing is invented — both stay null and the regular price applies', () => {
  const p = product({ prime_price_iqd: null, pro_price_iqd: null, options: [opt('o1', { regular_adjust_iqd: 25_000 })] });
  for (const tier of TIERS) {
    const r = resolve(p, { optionId: 'o1', colorId: null }, tier);
    assert.equal(r.pro_iqd, null);
    assert.equal(r.prime_iqd, null);
    assert.equal(r.applied_iqd, 175_000);
    assert.equal(r.applied_tier, 'regular');
  }
});

test('a reduction that swallows the only member price (no PRIME either) still charges the reduced regular price', () => {
  // The pre-existing safety net: PRO 90,000 swallowed by a −100,000 option,
  // no PRIME anywhere → nothing to fall back to.
  const p = product({ price_iqd: 100_000, prime_price_iqd: null, pro_price_iqd: 90_000, options: [opt('o1', { regular_price_iqd: 0 })] });
  const r = resolve(p, { optionId: 'o1', colorId: null }, 'pro');
  assert.equal(r.pro_iqd, null);
  assert.equal(r.applied_iqd, 0);
  assert.equal(r.applied_tier, 'regular');
});

test('an explicit PRO price still wins over the PRIME fallback, and the store-wide PRO policy still applies before it', () => {
  const explicit = resolve(product({ options: [opt('o1', { regular_adjust_iqd: 25_000 })] }), { optionId: 'o1', colorId: null }, 'pro');
  assert.equal(explicit.pro_iqd, 125_000, 'the carried PRO, not the PRIME 150,000');
  const policy = resolveUnitPrice({
    product: product({ pro_price_iqd: null }),
    tier: 'pro',
    tierActive: true,
    proPolicy: { mode: 'global_percent', percent: 10 },
  });
  assert.equal(policy.pro_iqd, 135_000, 'policy 10% off 150,000');
  assert.equal(policy.prime_iqd, 135_000, 'and PRIME is never below PRO, as before');
});

test('H1 at resolve time: a PRIME member pays the carried PRO price, never the lower PRIME the row states', () => {
  const p = product({ options: [opt('o1', { regular_adjust_iqd: 25_000, prime_price_iqd: 120_000 })] });
  const r = resolve(p, { optionId: 'o1', colorId: null }, 'prime');
  assert.equal(r.pro_iqd, 125_000);
  assert.equal(r.prime_iqd, 125_000);
  assert.equal(r.applied_iqd, 125_000);
});

// ---------------------------------------------------- 3. cost never leaks

test('INVARIANT: product_cost_iqd never influences a member price, on any line of any fixture', () => {
  for (const f of LADDER_FIXTURES) {
    for (const sel of selectionsOf(f.product)) {
      for (const tier of TIERS) {
        const seen = new Set<string>();
        for (const cost of [null, 1, 149_999, 999_999_999]) {
          const r = resolve({ ...f.product, product_cost_iqd: cost }, sel, tier);
          seen.add(JSON.stringify([r.regular_iqd, r.prime_iqd, r.pro_iqd, r.applied_iqd, r.applied_tier]));
          assert.equal(r.cost_iqd, cost, `${f.name}: the cost reported is the cost given`);
        }
        assert.equal(seen.size, 1, `${f.name} / ${sel.optionId ?? '-'}|${sel.colorId ?? '-'} / ${tier}: the prices moved with the cost: ${[...seen].join(' vs ')}`);
      }
    }
  }
});

test('a cost on an option or colour row does not reach the member prices either', () => {
  const plain = product({ options: [opt('o1', { regular_adjust_iqd: 25_000 })], colors: [col('c1', { option_id: 'o1', regular_adjust_iqd: 10_000 })] });
  const costed = product({
    product_cost_iqd: 1,
    options: [opt('o1', { regular_adjust_iqd: 25_000, cost_iqd: 2 })],
    colors: [col('c1', { option_id: 'o1', regular_adjust_iqd: 10_000, cost_adjust_iqd: 3 })],
  });
  for (const tier of TIERS) {
    const a = resolve(plain, { optionId: 'o1', colorId: 'c1' }, tier);
    const b = resolve(costed, { optionId: 'o1', colorId: 'c1' }, tier);
    assert.deepEqual([b.regular_iqd, b.prime_iqd, b.pro_iqd, b.applied_iqd], [a.regular_iqd, a.prime_iqd, a.pro_iqd, a.applied_iqd], tier);
  }
});

// ------------------------------------------------------ 4. the derived view

test('derivedRung reports the H1 inversion, and the shared clamp resolves it the way the resolver does', () => {
  const base = { regular: 150_000, prime: 125_000, pro: 100_000 };
  const d = derivedRung({ regular_price_iqd: null, prime_price_iqd: 120_000, pro_price_iqd: null, cost_iqd: null, regular_adjust_iqd: 25_000 }, base);
  assert.deepEqual([d.regular, d.prime, d.pro], [175_000, 120_000, 125_000]);
  assert.equal(d.inverted, true);
  assert.deepEqual(d.consumed, []);
  assert.deepEqual(clampMemberLadder(d.regular, d.prime, d.pro), { prime: 125_000, pro: 125_000 });

  const fine = derivedRung({ regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null, regular_adjust_iqd: 25_000 }, base);
  assert.deepEqual([fine.regular, fine.prime, fine.pro, fine.inverted], [175_000, 150_000, 125_000, false]);
});

test('clampMemberLadder: PRO falls back to PRIME, PRIME never below PRO, neither above regular, nothing invented', () => {
  assert.deepEqual(clampMemberLadder(130_000, 105_000, null), { prime: 105_000, pro: 105_000 });
  assert.deepEqual(clampMemberLadder(150_000, 80_000, 90_000), { prime: 90_000, pro: 90_000 });
  assert.deepEqual(clampMemberLadder(100_000, 120_000, 110_000), { prime: 100_000, pro: 100_000 });
  assert.deepEqual(clampMemberLadder(100_000, null, null), { prime: null, pro: null });
  assert.deepEqual(clampMemberLadder(100_000, null, 90_000), { prime: null, pro: 90_000 }, 'a PRO-only line keeps PRIME empty');
});
