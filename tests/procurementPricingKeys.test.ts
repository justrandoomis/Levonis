/**
 * EVERY KEY THE INPUTS STAGE ANSWERS IS CLASSIFIED (USD design §9; the naming
 * contract of tests/financialFieldsUnion.test.ts applied to the new routes):
 * the procurement card's preview, apply-purchase, the owner's rules, «قبول
 * القيم المرحّلة» and the product form's USD pricing.
 *
 * A key new to the code base is in FINANCIAL_FIELDS (both byte-identical
 * copies) or in INPUTS_PRIVATE_NON_FINANCIAL below with its reason; a key the
 * Worker already uses elsewhere is shared vocabulary; and every key that names
 * money, a rate or a measure is in FINANCIAL_FIELDS, whatever else it is. The
 * net then strips every seeded figure from the answers at any depth.
 *
 * Run: node --import tsx --test tests/procurementPricingKeys.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { FINANCIAL_FIELDS, stripFinancials } from '../worker/lib/adminScope';
import { FINANCIAL_FIELDS as KIT_FIELDS } from '../packages/platform-kit/src/scope';
import { ROOT } from './fixtures/d1';
import { get, json, post } from './fixtures/app';
import { pricingWorld, AMS, AMS_MODEL } from './fixtures/procurementPricing';

const LIST = new Set<string>(FINANCIAL_FIELDS as readonly string[]);

/** Owner-only keys of these answers that carry no amount — a code, a state, a flag, a count or a container. */
const INPUTS_PRIVATE_NON_FINANCIAL: Readonly<Record<string, string>> = {
  profile_source: 'default / proposed / first_route — where the bar’s shipping route came from, never a rate',
  engine_priced: 'yes/no: the product is priced by the engine',
  rule_level: 'the level (product / option) the deciding minimum profit comes from — a level name',
  excluded_charges: 'the TITLES of the charges left out of pricing as freight-looking — words the owner typed, never an amount',
  feeds: 'yes/no: this purchase can feed the product’s current costs',
  eligible: 'yes/no: the purchase is confirmed with a final cost',
  use_purchase: 'yes/no: the owner’s «استعمل هذا الشراء لتسعير هذا المنتج»',
  prefer_purchase_values: 'yes/no: the owner’s «استعمل قيمة هذا الشراء حتى لو كانت أقل»',
  applied: 'yes/no: this purchase was applied to the product’s pricing',
  cancelled_source: 'yes/no: a stored cost came from a purchase cancelled since',
  entries: 'a container: the derived input writes, every value under a FINANCIAL_FIELDS field name',
  narrow: 'yes/no: a line narrower than its pricing scope fed the entry',
  kept_higher: 'the FIELD NAMES kept at the stored (higher) value — names, never values',
  changes: 'a container keyed by FINANCIAL_FIELDS field names, each with its before → after',
  proposals: 'a container: a proposed shipping route per scope (under shipping_profile, FINANCIAL_FIELDS)',
  shadowed: 'a container: the FIELD NAMES a more specific value shadows',
  missing_codes: 'E1 readiness CODES of the product',
  review_pending: 'yes/no: a new exchange rate waits for the owner’s approval',
  derived_stale: 'yes/no: the derived IQD rates disagree with the pairs (every write refuses)',
  rows_changed: 'how many input and rule rows a write changed — a count',
  scopes: 'a container: the product form’s scopes, every value under a FINANCIAL_FIELDS key',
  models: 'a container: each model and its bar under pricing_summary (FINANCIAL_FIELDS)',
  sells_direct: 'yes/no: the model has an enabled direct-sale cell',
  target_profit_state: 'ACTIVE / INHERIT / BLOCKED — the state of a minimum-profit rule, never its amount',
  direct_sale_extra_state: 'ACTIVE / INHERIT / BLOCKED — the state of a Direct Sale Extra rule, never its amount',
  inputs_seq: 'the product’s input counter, the fence of the next write — a counter',
  // The P1 names these answers reuse (registered in tests/financialFieldsUnion.test.ts too).
  issue_codes: 'E1 readiness CODES of one bar or one model × channel',
  cod_priced_as_direct: 'yes/no: cash on delivery re-prices the pre-order from the direct ladder',
  // The writer's preview (owner decision 8).
  adoption: 'a container: what the save would do to the prices (adopt / reprice / data only), every figure under a FINANCIAL_FIELDS key',
  needs_write: 'yes/no: the save would write a price',
  write_seq: 'a counter of the product’s price writes (the fence of «رجوع إلى التسعير اليدوي») — a count, never an amount',
  large_change: 'yes/no: a price moves more than 15% (the tick and a fresh sign-in)',
  drop_flag: 'yes/no: a price falls more than 30%',
  legacy_step: 'yes/no: the migrated minimum, rounded up to the cent, moves a price one step',
  route_fee_removed: 'yes/no: the old route fee is folded into the engine price',
  // FX-7 (migration 0183): the colour and SKU levels.
  sku_levels: 'yes/no: the database has the per-SKU price rung, so the colour and variant levels are offered',
  per_sku: 'yes/no: the product is priced per colour or variant (its preview rows are one per SKU)',
  skus: 'a container: each SKU with its names, keys and bar under pricing_summary (FINANCIAL_FIELDS)',
};

function workerCorpus(): string {
  const files: string[] = [];
  const collect = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name !== 'pricingEngine' && name !== 'fx') collect(p);
      } else if (p.endsWith('.ts') && name !== 'adminPricing.ts') files.push(p);
    }
  };
  collect(join(ROOT, 'worker'));
  return files.map((f) => readFileSync(f, 'utf8')).join('\n');
}

test('every key of the Inputs stage’s answers is in FINANCIAL_FIELDS, registered, or shared vocabulary — and every money key is in the net', async () => {
  const w = pricingWorld();
  // An IQD-converted cost, so «تفاصيل» carries its provenance; a freight-looking charge, so the excluded list is filled.
  w.raw.exec(`INSERT INTO pricing_inputs (product_id, scope, scope_id, origin, supplier_cost_amount, supplier_cost_currency, supplier_input_mode,
      original_input_amount, original_input_currency, conversion_rate_snapshot, conversion_fx_version, canonical_supplier_cost_usd, converted_at,
      shipping_profile, shipping_weight_g, source_ref, version, updated_at)
    VALUES ('${AMS}', 'base', '', 'MANUAL_OVERRIDE', '300', 'USD', 'IQD_CONVERTED', '480000', 'IQD', '1600', 1, '300',
      '2026-10-01T00:00:00.000Z', 'GERMANY_LAND', 2500, 'owner', 1, '2026-10-01T00:00:00.000Z')`);
  const answers: unknown[] = [];
  const charges = [{ title: 'شحن محلي', scope: 'unit', unit_amount_iqd: 16_000, basis: 'quantity', applies_to: null }];
  const minimum = { minimum_profits: [{ product_id: AMS, scope: 'option', scope_id: AMS_MODEL, amount_usd: '120' }] };
  // «استعمل هذا الشراء» unticked: the bar prices the stored IQD-converted cost.
  const look = await w.preview({ draft: w.draft({ charges }), pricing: { ...minimum, use_purchase: { [AMS]: false } } });
  assert.equal(look.status, 200, JSON.stringify(look.body));
  assert.ok(look.body.lines[0].pricing_summary.iqd_converted, JSON.stringify(look.body.lines[0].pricing_summary));
  answers.push(look.body);
  const d = w.draft({ charges });
  const confirm = await w.preview({ draft: d, pricing: minimum });
  const id = await w.save(d);
  answers.push((await w.apply(AMS, { purchase_id: id, minimum_profits: [{ scope: 'product', amount_usd: '1' }], preview_hash: confirm.body.products[0].preview_hash })).body);
  answers.push((await w.apply(AMS, { purchase_id: id, minimum_profits: [{ scope: 'option', scope_id: AMS_MODEL, amount_usd: '120' }], preview_hash: confirm.body.products[0].preview_hash })).body);
  answers.push((await w.preview({ purchase_id: id })).body);
  const rulesRead = await json(await get(w.app, `/api/admin/pricing/products/${AMS}/rules`));
  answers.push(rulesRead);
  answers.push((await w.putRules(AMS, { inputs_seq: rulesRead.inputs_seq, rules: [{ kind: 'direct_sale_extra', scope: 'product', amount_iqd: 25_000 }] })).body);
  const inputs = await w.getInputs(AMS);
  answers.push(inputs.body);
  answers.push((await w.previewInputs(AMS, { inputs: [{ scope: 'option', scope_id: AMS_MODEL, supplier_cost_amount: '500', supplier_cost_currency: 'CNY' }] })).body);
  answers.push((await w.putInputs(AMS, { inputs_seq: inputs.body.inputs_seq, inputs: [{ scope: 'base', additional_cost_iqd: 3000 }] })).body);
  const detail = await json(await get(w.app, `/api/admin/pricing/products/lp_04`));
  const adopt = await post(w.app, '/api/admin/pricing/products/lp_04/targets/adopt', { legacy_hash: detail.legacy_hash });
  assert.equal(adopt.status, 200);
  answers.push(await json(adopt));

  const keys = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); }
  };
  answers.forEach(walk);
  assert.ok(keys.size > 80, `only ${keys.size} keys walked`);
  for (const k of ['pricing_summary', 'iqd_converted', 'excluded_charges', 'entries', 'scopes', 'models', 'rows_changed']) assert.ok(keys.has(k), `the walk reached ${k}`);

  const corpus = workerCorpus();
  const shared = (k: string) => new RegExp(`(^|[^\\w$])${k}\\s*\\??:`, 'm').test(corpus) || new RegExp(`['"]${k}['"]\\s*:`).test(corpus);
  assert.equal(shared('rule_level'), false, 'not vacuous: a name of these routes alone is not "shared"');
  const unclassified = [...keys].filter((k) => !LIST.has(k) && !(k in INPUTS_PRIVATE_NON_FINANCIAL) && !shared(k)).sort();
  assert.deepEqual(unclassified, [], 'add each to FINANCIAL_FIELDS (both copies) or to INPUTS_PRIVATE_NON_FINANCIAL with its reason');
  const MONEY = /_iqd$|_mm$|_g$|cbm|^fx_|_rate$|_rates$|^supplier_|^replacement_|^shipping_|^landed_|_usd$|_cents$|^target_profit|^minimum_/;
  const unnetted = [...keys].filter((k) => MONEY.test(k) && !LIST.has(k) && !k.endsWith('_state')).sort();
  assert.deepEqual(unnetted, [], 'a money, rate or measure key outside FINANCIAL_FIELDS');
  // Rules are named by kind, never amount_iqd (C2-A6).
  assert.equal(keys.has('amount_iqd'), false);
  // Every registered name is really answered, and none is also in the net.
  assert.deepEqual(Object.keys(INPUTS_PRIVATE_NON_FINANCIAL).filter((k) => !keys.has(k)), []);
  assert.deepEqual(Object.keys(INPUTS_PRIVATE_NON_FINANCIAL).filter((k) => LIST.has(k)), []);
  assert.deepEqual([...KIT_FIELDS], [...FINANCIAL_FIELDS]);

  // The net leaves no seeded figure in any answer.
  const stripped = JSON.stringify(stripFinancials(answers));
  for (const figure of ['992000', '"450"', '"480000"', '16000', '"120"', '25000', '"1600"', '"1.1"']) assert.ok(!stripped.includes(figure), `${figure} survived the strip`);
});
