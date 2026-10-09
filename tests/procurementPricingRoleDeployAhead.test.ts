/**
 * DEPLOY-AHEAD OF THE INPUTS STAGE (USD design §3.3, §10, fit #9; CLAUDE.md
 * rule 2): this code on a database migrated only through 0179.
 *
 *   - a routed purchase with extra charges saves exactly as today: the
 *     `purchase_charges` INSERT names no `pricing_role` (the column is 0181's);
 *   - the procurement card's pricing and the product form's USD pricing answer
 *     503 PRICING_NOT_INSTALLED (the card then shows one line and no bar);
 *   - on the migrated database the same save records the role.
 *
 * Run: node --import tsx --test tests/procurementPricingRoleDeployAhead.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dbThrough, get, hasColumn, json } from './fixtures/app';
import { OWNER_ROW_SQL } from './fixtures/fx';
import { seedLegacyCatalogue, seedProfileRates } from './fixtures/legacyCatalogue';
import { pricingWorld, AMS } from './fixtures/procurementPricing';

const CHARGES = [
  { title: 'شحن محلي', scope: 'unit', unit_amount_iqd: 16_000, basis: 'quantity', applies_to: null },
  { title: 'تغليف', scope: 'unit', unit_amount_iqd: 4_000, basis: 'quantity', applies_to: null },
];

test('on a 0179 database a routed purchase with charges saves as today, and the pricing routes answer 503 PRICING_NOT_INSTALLED', async () => {
  const raw = dbThrough('0179');
  assert.equal(hasColumn(raw, 'purchase_charges', 'pricing_role'), false);
  raw.exec(OWNER_ROW_SQL);
  seedLegacyCatalogue(raw);
  seedProfileRates(raw);
  const w = pricingWorld({ raw });
  const id = await w.save(w.draft({ charges: CHARGES }));
  const rows = raw.prepare('SELECT title, amount_iqd FROM purchase_charges WHERE purchase_id = ? ORDER BY position').all(id) as Array<{ title: string; amount_iqd: number }>;
  assert.deepEqual(rows.map((r) => [r.title, r.amount_iqd]), [['شحن محلي', 32_000], ['تغليف', 8_000]]);
  for (const r of [await w.preview({ draft: w.draft({ charges: CHARGES }) }), await w.preview({ purchase_id: id }), await w.getInputs(AMS)]) {
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.code, 'PRICING_NOT_INSTALLED');
  }
  const put = await w.putInputs(AMS, { inputs_seq: 0, rules: [{ kind: 'target_profit', scope: 'product', amount_usd: '120' }] });
  assert.equal(put.status, 503);
  // The saved document reads back with no role (null), as an older row does.
  const doc = (await json(await get(w.app, `/api/admin/procurement/documents/${id}`))) as { charges: Array<{ pricing_role: unknown }> };
  assert.deepEqual(doc.charges.map((c) => c.pricing_role), [null, null]);
});

test('on the migrated database the same save records each charge’s pricing role (freight-looking → excluded)', async () => {
  const w = pricingWorld();
  const id = await w.save(w.draft({ charges: CHARGES }));
  const rows = w.raw.prepare('SELECT title, pricing_role FROM purchase_charges WHERE purchase_id = ? ORDER BY position').all(id) as Array<{ title: string; pricing_role: string }>;
  assert.deepEqual(rows.map((r) => [r.title, r.pricing_role]), [['شحن محلي', 'excluded'], ['تغليف', 'additional']]);
  // A manual document's charges never feed pricing: no role.
  const manual = await w.save({
    operation_id: 'op_manual_role_00001',
    currency: 'USD',
    exchange_rate: 1500,
    status: 'ordered',
    cost_state: 'final',
    lines: [{ product_id: AMS, scope: 'option', scope_id: `${AMS}_o0`, qty_ordered: 1, source_unit_amount: 300, weight_g: 2500, volume_mm3: 0 }],
    charges: [{ title: 'شحن', scope: 'shipment', amount_iqd: 10_000, basis: 'quantity', applies_to: null }],
  });
  assert.deepEqual(w.raw.prepare('SELECT pricing_role FROM purchase_charges WHERE purchase_id = ?').all(manual).map((r) => (r as { pricing_role: unknown }).pricing_role), [null]);
});
