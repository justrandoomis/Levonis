/**
 * Full multi-group cart identity.
 * Run: node --import tsx --test tests/cartMultiOptionIdentity.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  canonicalOptionValueIds,
  optionValueIdsInRelationOrder,
  optionValueIdsJson,
  sameOptionValueIds,
} from '../worker/lib/cartSelectionIdentity';

test('the complete option selection has one order-independent TEXT identity', () => {
  assert.deepEqual(
    canonicalOptionValueIds(['region-us', 'model-a', 'region-us', '', null]),
    ['model-a', 'region-us']
  );
  assert.equal(
    optionValueIdsJson(['region-us', 'model-a']),
    optionValueIdsJson(['model-a', 'region-us'])
  );
  assert.equal(sameOptionValueIds(['model-a', 'region-us'], ['region-us', 'model-a']), true);
  assert.notEqual(
    optionValueIdsJson(['model-a', 'region-eu']),
    optionValueIdsJson(['model-a', 'region-us'])
  );
});

test('pricing order follows authored relation groups rather than identity text order', () => {
  const relations = {
    groups: [
      { id: 'retired', sort: 0, name_en: 'Retired', active: false },
      { id: 'model', sort: 10, name_en: 'Model', active: null },
      { id: 'accessory', sort: 20, name_en: 'Accessory', active: true },
    ],
    values: [
      { id: 'deprecated-0', group_id: 'retired', sort: 0, name_en: 'Deprecated' },
      { id: 'addon-a', group_id: 'accessory', sort: 0, name_en: 'Addon' },
      { id: 'model-z', group_id: 'model', sort: 0, name_en: 'Model Z' },
    ],
  };

  assert.deepEqual(canonicalOptionValueIds(['model-z', 'addon-a']), ['addon-a', 'model-z']);
  assert.deepEqual(
    optionValueIdsInRelationOrder(['deprecated-0', 'addon-a', 'model-z'], relations),
    ['model-z', 'addon-a', 'deprecated-0']
  );
});

test('0082 expands identity and both platform upserts remain rolling-deploy compatible', () => {
  const expand = readFileSync(
    new URL('../migrations/0082_cart_multi_option_identity.sql', import.meta.url),
    'utf8'
  );
  assert.match(
    expand,
    /ON cart_items\s*\(\s*user_id,\s*product_id,\s*option_id,\s*option_value_ids,\s*color_id,\s*shipping_method_id\s*\)/s
  );
  assert.match(expand, /idx_cart_levonis_line_v2/);
  assert.doesNotMatch(expand, /DROP INDEX IF EXISTS idx_cart_levonis_line;/);

  const route = readFileSync(new URL('../worker/routes/cart.ts', import.meta.url), 'utf8');
  assert.equal(
    route.split('ON CONFLICT DO UPDATE SET qty').length - 1,
    2,
    'ordinary and composition upserts must work on old-only, dual and new-only schemas'
  );
  assert.doesNotMatch(
    route,
    /ON CONFLICT\(user_id, product_id, option_id, option_value_ids, color_id, shipping_method_id\)/
  );
  assert.match(
    route,
    /product_id = \? AND option_id = \? AND option_value_ids = \?\s+AND color_id = \?/
  );
  assert.equal(
    route.split("const primaryOption = canonical[0] ?? '';").length - 1,
    2,
    'POST and PATCH must persist the lexical identity, not mutable group order'
  );
  assert.doesNotMatch(route, /const primaryOption = pricingIds\[0\]/);
});
