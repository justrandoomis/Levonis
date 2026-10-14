/**
 * PRICING V2 CLEAN START — FINANCE EDGES (review of feat/pricing-v2-core, 2026-10-14).
 *
 * 1. The estimate frozen on a pre-order line paid cash on delivery is the cost
 *    of the ROUTE it ships on (R_route), never R_stock: such a line is priced
 *    from the direct ladder but still travels by its route.
 * 2. A Quick Buy session quoted before the clean start is given up, never
 *    finalised with an old dinar quote as the cap of a new V2 price.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { channelOfLine, estimateChannelOfLine, v2EstimateOf } from '../worker/lib/pricingEngine/orderBasis';
import { quotedBeforeCleanStart } from '../worker/lib/quickBuy/finalize';

test('a COD pre-order line freezes its route\'s replacement cost, not the stock route\'s', async () => {
  const cod = { pricing_basis: 'direct' as const, route: 'air' };
  assert.equal(channelOfLine(cod), 'direct_sale', 'priced from the direct ladder (the engine basis is unchanged)');
  assert.equal(estimateChannelOfLine(cod), 'pre_order_air', 'but it ships by air: its cost is R_air');
  assert.equal(estimateChannelOfLine({ pricing_basis: 'preorder', route: 'sea' }), 'pre_order_sea');
  assert.equal(estimateChannelOfLine({ pricing_basis: 'direct', route: null }), 'direct_sale');
  assert.equal(estimateChannelOfLine({ pricing_basis: 'preorder', route: null }), null);

  // The estimate read picks the route's row.
  const rows = [
    { product_id: 'p1', combo_key: '', channel: 'direct_sale', replacement_cost_iqd: 900_000, replacement_exact: '900000', usd_iqd_rate: '1500', usd_fx_version: 3 },
    { product_id: 'p1', combo_key: '', channel: 'pre_order_air', replacement_cost_iqd: 1_100_000, replacement_exact: '1100000', usd_iqd_rate: '1500', usd_fx_version: 3 },
  ];
  const db = { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }) } as unknown as D1Database;
  const got = await v2EstimateOf(db, [{ key: 'l1', product_id: 'p1', option_id: '', pricing_basis: 'direct', route: 'air' }, { key: 'l2', product_id: 'p1', option_id: '', pricing_basis: 'direct', route: null }], true);
  assert.equal(got.get('l1')?.estimated_cost_iqd, 1_100_000);
  assert.equal(got.get('l2')?.estimated_cost_iqd, 900_000);
});

test('a Quick Buy session quoted before the clean start is recognised (and given up), one after it is not', () => {
  const at = '2026-10-15T08:00:00.000Z';
  assert.equal(quotedBeforeCleanStart('2026-10-15T07:59:59.000Z', at), true);
  assert.equal(quotedBeforeCleanStart('2026-10-15T08:00:00.001Z', at), false);
  assert.equal(quotedBeforeCleanStart('2026-10-15T07:00:00.000Z', null), false, 'before 0190 nothing is given up');
  assert.equal(quotedBeforeCleanStart(null, at), false);
  // The finaliser asks it before any order attempt.
  const src = readFileSync(join(import.meta.dirname, '../worker/lib/quickBuy/finalize.ts'), 'utf8');
  assert.match(src, /if \(quotedBeforeCleanStart\(session\.created_at, await cleanStartAt\(db\)\)\) return settleGiveUp\(db, session, 'PRICE_CHANGED'\);/);
});
