/**
 * THE GRID AND THE RESOLVER PRODUCE IDENTICAL NUMBERS.
 *
 * H1 was a grid that showed a PRIME price the resolver never charged (a PRIME
 * cell below the carried PRO), and M3 a grid that showed no PRO price where a
 * PRO member is charged the PRIME one. Both are the same failure: the grid
 * walked the ladder like the resolver but skipped the resolver's last word on
 * a line (pricing.ts clampMemberLadder). This file pins the agreement cell by
 * cell over the shared fixture list — base only, option, option + colour,
 * colour without option, PRO-only, PRIME-only, own member prices, member
 * adjusts, zero adjusts, and the H1 and M3 inputs — accepted and refused
 * alike, because a legacy row is exactly where a clamp matters.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveUnitPrice, type PricingProduct } from '../worker/lib/pricing';
import { buildGrid, previewBulk, type GridProductInput } from '../worker/lib/priceGrid';
import { LADDER_FIXTURES, col, opt, product } from './pricingLadderFixtures';

const gridInput = (p: PricingProduct): GridProductInput => ({
  price_iqd: p.price_iqd,
  prime_price_iqd: p.prime_price_iqd,
  pro_price_iqd: p.pro_price_iqd,
  product_cost_iqd: p.product_cost_iqd,
  selling_type: p.selling_type,
  sale_types: p.sale_types,
  options: p.options as GridProductInput['options'],
  colors: p.colors as GridProductInput['colors'],
});

test('INVARIANT: every effective cell of every fixture equals the resolver\'s number for that row\'s selection', () => {
  for (const f of LADDER_FIXTURES) {
    const rows = buildGrid(gridInput(f.product));
    for (const row of rows) {
      const optionId = row.level === 'option' ? row.id : row.level === 'color' ? row.option_id || null : null;
      const colorId = row.level === 'color' ? row.id : null;
      const r = resolveUnitPrice({ product: f.product, optionId, colorId, tier: 'free', tierActive: false });
      const where = `${f.name} / ${row.level}:${row.id || 'base'}`;
      assert.equal(row.cells.regular.effective, r.regular_iqd, `${where} regular`);
      assert.equal(row.cells.prime.effective, r.prime_iqd, `${where} prime`);
      assert.equal(row.cells.pro.effective, r.pro_iqd, `${where} pro`);
      assert.equal(row.cells.cost.effective, r.cost_iqd, `${where} cost`);
      // …and what each tier is actually charged for exactly this row.
      for (const tier of ['prime', 'pro'] as const) {
        const paid = resolveUnitPrice({ product: f.product, optionId, colorId, tier, tierActive: true }).applied_iqd;
        assert.equal(row.cells[tier].effective ?? row.cells.regular.effective, paid, `${where}: a ${tier} member pays`);
      }
    }
  }
});

test('H1: the grid shows the PRIME price the resolver charges (clamped up to the carried PRO), not the row\'s lower number', () => {
  const p = product({ options: [opt('o1', { regular_adjust_iqd: 25_000, prime_price_iqd: 120_000 })] });
  const row = buildGrid(gridInput(p)).find((r) => r.id === 'o1')!;
  assert.equal(row.cells.regular.effective, 175_000);
  assert.equal(row.cells.pro.effective, 125_000);
  assert.equal(row.cells.prime.effective, 125_000, 'was 120,000 — a number no PRIME member is ever charged');
  assert.equal(row.cells.prime.mode, 'fixed');
  assert.equal(row.cells.prime.value, 120_000, 'the STORED number is still shown as what was typed');
  assert.equal(row.cells.prime.inherited, 150_000, 'the inherit placeholder is the raw carried value');
});

test('M3: the grid shows the PRIME price PRO members fall back to, on the colour row and on a PRIME-only base', () => {
  const p = product({ options: [opt('o1', { regular_adjust_iqd: 100_000, pro_price_iqd: 40_000 })], colors: [col('c1', { option_id: 'o1', regular_price_iqd: 130_000 })] });
  const rows = buildGrid(gridInput(p));
  const colour = rows.find((r) => r.id === 'c1')!;
  assert.deepEqual([colour.cells.regular.effective, colour.cells.prime.effective, colour.cells.pro.effective], [130_000, 105_000, 105_000]);
  assert.equal(colour.cells.pro.mode, 'inherit');
  assert.equal(colour.cells.pro.inherited, null, 'nothing is carried: 40,000 − 120,000 ≤ 0');

  const primeOnly = buildGrid(gridInput(product({ pro_price_iqd: null })));
  assert.equal(primeOnly[0].cells.pro.effective, 125_000, 'the base row too');
  assert.equal(primeOnly[0].cells.pro.mode, 'inherit');
});

test('the value a rung passes up is the RAW ladder value, exactly as pickMember carries it', () => {
  // The option's PRIME is capped at its regular (125,000 → 100,000 for a
  // PRIME member on the option alone), but a colour +50,000 on it carries the
  // uncapped 125,000 + 50,000 = 175,000 — which is what the resolver does.
  const p = product({
    prime_price_iqd: null,
    pro_price_iqd: null,
    options: [opt('o1', { regular_price_iqd: 100_000, prime_price_iqd: 125_000 })],
    colors: [col('c1', { option_id: 'o1', regular_adjust_iqd: 50_000 })],
  });
  const rows = buildGrid(gridInput(p));
  const option = rows.find((r) => r.id === 'o1')!;
  const colour = rows.find((r) => r.id === 'c1')!;
  assert.equal(option.cells.prime.effective, 100_000, 'capped on the option row');
  assert.equal(colour.cells.prime.inherited, 175_000, 'the colour inherits the raw 125,000 plus its surcharge');
  assert.equal(colour.cells.prime.effective, 150_000, 'and is capped at its own regular price, like the resolver');
  const r = resolveUnitPrice({ product: p, optionId: 'o1', colorId: 'c1', tier: 'prime', tierActive: true });
  assert.equal(r.prime_iqd, 150_000);
});

test('a bulk amount on a PRO cell that only shows the PRIME fallback is skipped, not pinned onto the row', () => {
  const p = product({ pro_price_iqd: null, options: [opt('o1', { regular_adjust_iqd: 25_000 })] });
  const rows = buildGrid(gridInput(p));
  const add = previewBulk(rows, { op: 'add', fields: ['pro'], value: 10_000, scope: {} }, null);
  assert.equal(add.changes.length, 0, 'no PRO number exists on any row to add to');
  assert.ok(add.skipped.every((s) => s.reason === 'NO_CURRENT_VALUE'));
  // A row that carries a real PRO price is still moved.
  const withPro = previewBulk(buildGrid(gridInput(product({ options: [opt('o1', { regular_adjust_iqd: 25_000 })] }))), { op: 'add', fields: ['pro'], value: 10_000, scope: { levels: ['option'] } }, null);
  assert.deepEqual(withPro.changes.map((c) => [c.id, c.from_iqd, c.to_iqd]), [['o1', 125_000, 135_000]]);
});
