/**
 * THE NEW DEVICE'S CHOICES (owner, 2026-11-18): the trade-in sheet's groups are built from the
 * product AS IT IS SOLD — a model kept in the product's own option list (the live A1's «A1 / A1
 * Combo», no group row) is offered and can be chosen; every group sent has a value; a relational
 * product keeps its groups.
 *
 * Run: node --import tsx --test tests/tradeInTargetChoices.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1 } from './fixtures/app';
import { publishSeededV2 } from './fixtures/autoPublish';
import { restoreFetch, seed } from './sv2_tradein_fixture';
import { choicesOf, searchTargets } from '../worker/lib/tradeInTargets';
import { parseProductRow } from '../worker/lib/productModel';

test.after(restoreFetch);

test('a relational product keeps its group and both values through the live search', async () => {
  const raw = seed();
  await publishSeededV2(raw);
  const { targets } = await searchTargets({ DB: asD1(raw) } as never, 'cust', { q: '', family: null, cursor: null, productId: null });
  const a1 = (targets as any[]).find((t) => t.product_id === 'p_a1');
  assert.ok(a1, JSON.stringify((targets as any[]).map((t) => t.product_id)));
  assert.deepEqual(a1.groups.map((g: any) => [g.id, g.values.map((v: any) => v.id)]), [['g_a1', ['v_a1', 'v_a1c']]]);
  for (const t of targets as any[]) for (const g of t.groups) assert.ok(g.values.length > 0, `${t.product_id} ${g.id} has a value`);
});

test('the live A1: models kept in the product’s own option list (no group row) become ONE group the customer can choose from', () => {
  const doc = parseProductRow({
    id: 'p_flat', slug: 'a1', name: 'Bambu Lab A1 / A1 Combo', name_ar: 'بامبو A1', status: 'active', price_iqd: 688000, colors: '[]',
    options: JSON.stringify([
      { id: 'a1', name_ar: 'A1', name_en: 'A1', name_ckb: '', active: true },
      { id: 'a1-combo', name_ar: 'A1 Combo', name_en: 'A1 Combo', name_ckb: '', active: true },
      { id: 'old', name_ar: 'قديم', name_en: 'Old', name_ckb: '', active: false },
    ]),
  });
  const { groups, colors } = choicesOf(doc, [], [], []);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, '');
  assert.deepEqual(groups[0].values.map((v) => [v.id, v.label_en]), [['a1', 'A1'], ['a1-combo', 'A1 Combo']]);
  assert.deepEqual(colors, []);
  // A group row with no value the product sells is never sent.
  const withEmptyRow = choicesOf(doc, [{ id: 'g_empty', product_id: 'p_flat', name_en: 'Bundle', sort: 0 }], [], []);
  assert.deepEqual(withEmptyRow.groups.map((g) => g.id), ['grp:main']);
});
