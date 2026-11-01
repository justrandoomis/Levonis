/**
 * ESTIMATED PRE-ORDER PRICES — THE INPUTS ONE ESTIMATE WRITES
 * (docs/SMART_PRICING.md §4.4–§4.6, §10; packages/pricing/src/estimateInputs.ts).
 *
 * Proves, pure:
 *   1. compaction — base, one group's option absolutes, colour, per SKU — every
 *      representation re-resolved by E1's own `resolveSkuInputs` to the exact
 *      catalogue price of every SKU (a property test over random products);
 *      mixed currencies go to SKU scope; a missing price is never taken from a
 *      sibling; the 61-entry cap of the form's parse;
 *   2. the measures — model and colour packages, then the product's package on
 *      the base row ([depth, width, height] → [L, W, H]), then the type's
 *      defaults only where a SKU has none (flagged); defaults never reach
 *      `products.package_*`; `manual_cbm` only where no box exists at base;
 *   3. the three-way merge against `applied_wire_json`: the estimator's fields
 *      are rewritten or cleared, the owner's changes are kept (EST_OWNER_EDITED,
 *      names only), a value the estimator never wrote is kept — across levels;
 *   4. the parity pins: the chain this package builds is the worker's
 *      `chainOfUnit`, its decimal reading is the form's, its limits are the
 *      form parser's;
 *   5. end to end, on a real database: the wire passes `parseV2Wire` and
 *      `desiredFor` and the V2 evaluation prices every SKU at §4.3's formula;
 *      a refresh of an unchanged estimate sends nothing; an owner's correction
 *      survives the next refresh.
 *
 * Run: node --import tsx --test tests/estimateInputs.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ESTIMATE_INPUT_BLOCKING,
  MANUAL_CBM_DIGITS,
  MAX_ESTIMATE_INPUT_ENTRIES,
  SUPPLIER_AMOUNT_DIGITS,
  canonicalManualCbm,
  canonicalSupplierAmount,
  compactSupplierPrices,
  estimateChain,
  ownScopeOf,
  parseAppliedWire,
  planEstimateInputs,
  productPackageOf,
  serializeAppliedWire,
  skuMeasureSources,
  type EstimateInputRow,
  type EstimatePackage,
  type EstimatePlan,
  type EstimatePlanInput,
  type EstimateSku,
  type EstimateSupplierPrice,
  type EstimateTypeInputs,
  type SupplierTarget,
} from '../packages/pricing/src/estimateInputs';
import { resolveSkuInputs, type SupplierCurrency } from '../packages/pricing/src/costToPrice';
import { skuComboKey } from '../packages/pricing/src/skuChannel';
import { roundPriceIqd } from '../packages/pricing/src/priceRounding';
import {
  addProcurementExact,
  mulProcurementExact,
  parseProcurementDecimal,
  procurementExact,
  procurementExactText,
  divProcurementExact,
} from '../packages/contracts/src/procurementCost';
import { chainOfUnit, packagesOf, ruleAt, type StoredInputRow, type StoredRuleRow } from '../worker/lib/pricingEngine/store';
import { FORM_INPUT_FIELDS, formScopeIds } from '../worker/lib/pricingEngine/productInputs';
import { mergedInputs } from '../worker/lib/pricingEngine/fromPurchase';
import { sellableSkus } from '../worker/lib/pricingEngine/legacy';
import { desiredFor, evaluateDesired, loadV2Read, parseV2Wire } from '../worker/lib/pricingEngine/v2/api';
import type { Env } from '../worker/lib/types';
import { asD1, dbThrough } from './fixtures/app';
import { OWNER_ROW_SQL, applyRate } from './fixtures/fx';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------- fixtures -- */

/** mulberry32: a small seeded PRNG, so a failure reproduces. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TYPE: EstimateTypeInputs = {
  key: 'filament',
  route: 'sea',
  default_weight_g: 1300,
  default_length_mm: 210,
  default_width_mm: 210,
  default_height_mm: 90,
  default_cbm: null,
  additional_cost_iqd: 500,
  min_profit_usd: '2',
};
const typeOf = (patch: Partial<EstimateTypeInputs> = {}): EstimateTypeInputs => ({ ...TYPE, ...patch });

/** A product's SKUs: one value of each group (relation order), times its colours (or none). */
function grid(groups: ReadonlyArray<readonly string[]>, colours: readonly string[] = [], packaged?: (ids: string[], colour: string | null) => EstimateSku['packaged']): EstimateSku[] {
  let selections: string[][] = [[]];
  for (const g of groups) selections = selections.flatMap((sel) => g.map((v) => [...sel, v]));
  const out: EstimateSku[] = [];
  for (const ids of selections) {
    for (const colour of colours.length ? colours : [null]) {
      out.push({ combo_key: skuComboKey({ option_value_ids: ids, color_id: colour }), option_value_ids: ids, color_id: colour, ...(packaged ? { packaged: packaged(ids, colour) } : {}) });
    }
  }
  return out;
}
/** Option value id → group id for `grid`'s groups (`g0`, `g1`, …). */
const groupsOf = (groups: ReadonlyArray<readonly string[]>): Record<string, string> =>
  Object.fromEntries(groups.flatMap((g, i) => g.map((v) => [v, `g${i}`] as const)));

const cny = (amount: string, extra: Partial<EstimateSupplierPrice> = {}): EstimateSupplierPrice => ({ amount, currency: 'CNY', source: 'tmall_cn', ref: 'sps_1', ...extra });
const priceMap = (skus: readonly EstimateSku[], f: (s: EstimateSku) => EstimateSupplierPrice | null) => {
  const m = new Map<string, EstimateSupplierPrice>();
  for (const s of skus) {
    const p = f(s);
    if (p) m.set(s.combo_key, p);
  }
  return m;
};

/** A stored `pricing_inputs` row (MANUAL_OVERRIDE unless said). */
const row = (scope: EstimateInputRow['scope'], scopeId: string, fields: Partial<EstimateInputRow>, origin: EstimateInputRow['origin'] = 'MANUAL_OVERRIDE'): Partial<EstimateInputRow> => ({
  scope,
  scope_id: scope === 'base' ? '' : scopeId,
  origin,
  ...fields,
});

/** The product's package: 1 kg packed, 200 × 200 × 100 mm (depth × width × height). */
const PACKAGE = { package_weight_g: 1000, package_depth_mm: 200, package_width_mm: 180, package_height_mm: 100 };

const plan = (input: Partial<EstimatePlanInput> & Pick<EstimatePlanInput, 'skus' | 'prices'>): EstimatePlan =>
  planEstimateInputs({ type: TYPE, inputs: [], product_package: PACKAGE, ...input });

/** The rows an apply of a plan leaves: its wire's fields laid over the stored rows (as `parseInputEntry` + `mergedInputs` would). */
function afterApply(rows: readonly Partial<EstimateInputRow>[], p: EstimatePlan): Partial<EstimateInputRow>[] {
  const out = rows.map((r) => ({ ...r }));
  for (const e of p.wire.cost.inputs) {
    const scopeId = e.scope === 'base' ? '' : e.scope_id!;
    let r = out.find((x) => x.scope === e.scope && (x.scope_id ?? '') === scopeId && x.origin === 'MANUAL_OVERRIDE');
    if (!r) {
      r = row(e.scope, scopeId, {});
      out.push(r);
    }
    const { scope: _s, scope_id: _id, ...fields } = e;
    Object.assign(r, fields);
    if (fields.supplier_cost_amount != null) r.supplier_cost_delta = null;
  }
  return out;
}

/** Each SKU's resolved supplier cost over rows: `amount currency`, or the codes that keep it from resolving. */
const supplierOf = (rows: readonly Partial<EstimateInputRow>[], s: EstimateSku): string => {
  const r = resolveSkuInputs(estimateChain(rows, s));
  return r.inputs.supplier ? `${r.inputs.supplier.amount} ${r.inputs.supplier.currency}` : r.problems.supplier.map((p) => p.code).join(',');
};

const flagOf = (p: EstimatePlan, code: string) => p.flags.find((f) => f.code === code);
const entryAt = (p: EstimatePlan, scope: string, id = '') => p.wire.cost.inputs.find((e) => e.scope === scope && (e.scope_id ?? '') === id);

/* --------------------------------------------------- 1. the parity pins -- */

test('parity: the chain this package builds is the worker’s chainOfUnit (rows of both origins, marks, packages)', () => {
  const rnd = prng(0xc4a1);
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const maybe = <T>(v: T, p = 0.4): T | null => (rnd() < p ? v : null);
  const MARKS = ['shipping_weight_g', 'pricing_weight_g', 'shipping_box', 'shipping_width_mm', 'manual_cbm', 'shipping_profile'];
  const fields = (origin: 'SOURCE' | 'MANUAL_OVERRIDE'): Partial<EstimateInputRow> => ({
    supplier_cost_amount: maybe(String(int(1, 999))),
    supplier_cost_delta: maybe(`+${int(0, 50)}`, 0.15),
    supplier_cost_currency: maybe((['USD', 'EUR', 'CNY'] as const)[int(0, 2)], 0.7),
    shipping_profile: maybe((['GERMANY_LAND', 'CHINA_AIR', 'CHINA_SEA'] as const)[int(0, 2)], 0.3),
    pricing_weight_g: maybe(int(1, 9000), 0.2),
    shipping_weight_g: maybe(int(1, 9000)),
    shipping_length_mm: maybe(int(1, 900)),
    shipping_width_mm: maybe(int(1, 900)),
    shipping_height_mm: maybe(int(1, 900)),
    manual_cbm: maybe(`0.${int(1, 999)}`, 0.3),
    additional_cost_iqd: maybe(int(0, 9000), 0.3),
    unresolved_fields: origin === 'SOURCE' ? JSON.stringify(MARKS.filter(() => rnd() < 0.2)) : '[]',
  });
  const pkg = (): EstimatePackage | null =>
    rnd() < 0.4 ? null : { weight_g: rnd() < 0.5 ? int(1, 5000) : null, box: rnd() < 0.5 ? [int(1, 500), int(1, 500), int(1, 500)] : null };
  for (let i = 0; i < 2000; i++) {
    const groups = [['a1', 'a2'], ['b1', 'b2', 'b3']].slice(0, int(0, 2));
    const colours = ['c1', 'c2'].slice(0, int(0, 2));
    const skus = grid(groups, colours);
    const scopes: Array<[EstimateInputRow['scope'], string]> = [['base', ''], ...groups.flat().map((v) => ['option', v] as [EstimateInputRow['scope'], string]), ...colours.map((c) => ['color', c] as [EstimateInputRow['scope'], string]), ...skus.map((s) => ['sku', s.combo_key] as [EstimateInputRow['scope'], string])];
    const rows: Partial<EstimateInputRow>[] = [];
    for (const [scope, id] of scopes) for (const origin of ['SOURCE', 'MANUAL_OVERRIDE'] as const) if (rnd() < 0.45) rows.push(row(scope, id, fields(origin), origin));
    const s = skus[int(0, skus.length - 1)]!;
    const packaged = rnd() < 0.5 ? { model: pkg(), color: pkg() } : undefined;
    const sku: EstimateSku = { ...s, ...(packaged ? { packaged } : {}) };
    const mine = estimateChain(rows, sku);
    const theirs = chainOfUnit(rows as Partial<StoredInputRow>[], { option_value_ids: sku.option_value_ids, color_id: sku.color_id, combo_key: sku.combo_key || null, ...(packaged ? { packaged } : {}) });
    assert.deepEqual(mine, theirs, `#${i}`);
    assert.deepEqual(resolveSkuInputs(mine), resolveSkuInputs(theirs), `#${i} resolves the same`);
  }
});

test('parity: amounts and CBM are read as the form reads them (parseProcurementDecimal), within the form parser’s own limits', () => {
  const src = readFileSync(join(ROOT, 'worker/lib/pricingEngine/productInputs.ts'), 'utf8');
  assert.equal(Number(/const MAX_SCOPES = (\d+);/.exec(src)?.[1]), MAX_ESTIMATE_INPUT_ENTRIES, 'the form takes at most MAX_SCOPES entries');
  const amount = /positiveDecimal\(.*'supplier_cost_amount', (\d+), (\d+)\)/.exec(src);
  assert.deepEqual([Number(amount?.[1]), Number(amount?.[2])], [SUPPLIER_AMOUNT_DIGITS.int, SUPPLIER_AMOUNT_DIGITS.fraction]);
  const cbm = /positiveDecimal\(.*'manual_cbm', (\d+), (\d+)\)/.exec(src);
  assert.deepEqual([Number(cbm?.[1]), Number(cbm?.[2])], [MANUAL_CBM_DIGITS.int, MANUAL_CBM_DIGITS.fraction]);
  assert.match(src, new RegExp(`cbm\\.length > ${MANUAL_CBM_DIGITS.length}\\)`));

  const form = (v: string, int: number, frac: number) => {
    try {
      return parseProcurementDecimal(v, { maxIntDigits: int, maxFractionDigits: frac, min: 'positive' });
    } catch {
      return null;
    }
  };
  const rnd = prng(0xdec1);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
  const samples = ['69', '69.00', '069.50', '0.000001', '0.0000001', '0', '0.0', '1e3', '.5', '5.', '+5', '-5', ' 7 ', '1,5', '١٢', '999999999999', '1000000000000', '12.3456789', '0001.10'];
  for (let i = 0; i < 4000; i++) {
    const digits = () => Array.from({ length: Math.floor(rnd() * 15) }, () => pick('0123456789'.split(''))).join('');
    samples.push(`${digits() || '0'}${rnd() < 0.6 ? `.${digits() || '0'}` : ''}`);
  }
  for (const v of samples) {
    assert.equal(canonicalSupplierAmount(v), form(v, 12, 6), `amount ${JSON.stringify(v)}`);
    const c = form(v, 3, 9);
    assert.equal(canonicalManualCbm(v), c !== null && c.length <= 12 ? c : null, `cbm ${JSON.stringify(v)}`);
  }
  assert.equal(canonicalSupplierAmount(69 as unknown as string), null, 'a JSON number is never a decimal (no float reaches a price)');
});

/* ------------------------------------------------------- 2. compaction -- */

const targetsOf = (skus: readonly EstimateSku[], f: (s: EstimateSku) => [string, SupplierCurrency]): SupplierTarget[] =>
  skus.map((s) => {
    const [amount, currency] = f(s);
    return { sku: s, amount: canonicalSupplierAmount(amount)!, currency };
  });
const entryRows = (c: NonNullable<ReturnType<typeof compactSupplierPrices>>) =>
  c.entries.map((e) => row(e.scope, e.scope_id, { supplier_cost_amount: e.amount, supplier_cost_currency: e.currency }));
function assertExact(targets: readonly SupplierTarget[], c: NonNullable<ReturnType<typeof compactSupplierPrices>>, label: string) {
  const rows = entryRows(c);
  for (const t of targets) assert.equal(supplierOf(rows, t.sku), `${t.amount} ${t.currency}`, `${label}: ${t.sku.combo_key}`);
  assert.equal(c.exact, true, label);
}

test('compaction (§4.4): one base absolute when every SKU costs the same — 69.00 and 69 are the same exact price', () => {
  const skus = grid([['spool', 'refill']], ['red', 'blue']);
  const targets = targetsOf(skus, (s) => [s.color_id === 'red' ? '69.00' : '69', 'CNY']);
  const c = compactSupplierPrices(targets, { groupOf: (id) => groupsOf([['spool', 'refill']])[id]! })!;
  assert.equal(c.level, 'base');
  assert.deepEqual(c.entries.map((e) => [e.scope, e.scope_id, e.amount, e.currency]), [['base', '', '69', 'CNY']]);
  assertExact(targets, c, 'base');
  // One thousandth of a yuan apart is another price: never rounded together.
  const apart = targetsOf(skus, (s) => [s.combo_key === skus[0]!.combo_key ? '69.001' : '69', 'CNY']);
  const d = compactSupplierPrices(apart, { groupOf: (id) => groupsOf([['spool', 'refill']])[id]! })!;
  assert.notEqual(d.level, 'base');
  assertExact(apart, d, 'apart');
});

test('compaction: option absolutes on ONE group’s values when the cost depends on that group only (each SKU meets exactly one)', () => {
  const groups = [['spool', 'refill'], ['n02', 'n04', 'n06']] as const;
  const skus = grid(groups, ['red', 'blue']);
  const groupOf = (id: string) => groupsOf(groups)[id]!;
  // Spool against refill (the first group).
  const byKind = targetsOf(skus, (s) => [s.option_value_ids.includes('spool') ? '89' : '69', 'CNY']);
  const a = compactSupplierPrices(byKind, { groupOf })!;
  assert.equal(a.level, 'option');
  assert.equal(a.group_id, 'g0');
  assert.deepEqual(a.entries.map((e) => [e.scope_id, e.amount]), [['refill', '69'], ['spool', '89']]);
  assertExact(byKind, a, 'by kind');
  // The nozzle (the second group): absolutes on its three values, the first group untouched.
  const byNozzle = targetsOf(skus, (s) => [s.option_value_ids.includes('n02') ? '120' : s.option_value_ids.includes('n04') ? '99.5' : '101', 'CNY']);
  const b = compactSupplierPrices(byNozzle, { groupOf })!;
  assert.deepEqual([b.level, b.group_id, b.entries.length], ['option', 'g1', 3]);
  assertExact(byNozzle, b, 'by nozzle');
  // Two option absolutes of different groups on one SKU would be INPUT_CONFLICT: never written.
  const both = [...entryRows(a), ...entryRows(b)];
  assert.match(supplierOf(both, skus[0]!), /INPUT_CONFLICT/);
});

test('compaction: colour absolutes when the cost depends on the colour only', () => {
  const groups = [['spool', 'refill']] as const;
  const skus = grid(groups, ['red', 'blue', 'green']);
  const targets = targetsOf(skus, (s) => [s.color_id === 'green' ? '79.9' : s.color_id === 'red' ? '69' : '72', 'CNY']);
  const c = compactSupplierPrices(targets, { groupOf: (id) => groupsOf(groups)[id]! })!;
  assert.equal(c.level, 'color');
  assert.deepEqual(c.entries.map((e) => [e.scope, e.scope_id, e.amount]), [['color', 'blue', '72'], ['color', 'green', '79.9'], ['color', 'red', '69']]);
  assertExact(targets, c, 'colour');
});

test('compaction: per SKU at the SKU’s own level otherwise — exact SKU, a lone model, the product itself', () => {
  const groups = [['spool', 'refill']] as const;
  const skus = grid(groups, ['red', 'blue']);
  const joint = targetsOf(skus, (s) => [String(60 + skus.indexOf(s)), 'CNY']);
  const c = compactSupplierPrices(joint, { groupOf: (id) => groupsOf(groups)[id]! })!;
  assert.equal(c.level, 'sku');
  assert.deepEqual(c.entries.map((e) => e.scope), ['sku', 'sku', 'sku', 'sku']);
  assertExact(joint, c, 'joint');
  // A model alone (no colour, one group): its own level IS the model's; the product itself is `base`.
  assert.deepEqual(ownScopeOf({ combo_key: 'o:x', option_value_ids: ['x'] }), { scope: 'option', scope_id: 'x' });
  assert.deepEqual(ownScopeOf({ combo_key: '', option_value_ids: [] }), { scope: 'base', scope_id: '' });
  assert.deepEqual(ownScopeOf({ combo_key: 'c:red', option_value_ids: [] }), { scope: 'sku', scope_id: 'c:red' });
  assert.deepEqual(ownScopeOf({ combo_key: 'o:a|o:b', option_value_ids: ['a', 'b'] }), { scope: 'sku', scope_id: 'o:a|o:b' });
});

test('compaction: mixed currencies go to SKU scope, even when one group would explain the amounts', () => {
  const groups = [['spool', 'refill']] as const;
  const skus = grid(groups, ['red', 'blue']);
  const mixed = targetsOf(skus, (s) => (s.option_value_ids.includes('spool') ? ['89', 'CNY'] : ['12.5', 'EUR']));
  const c = compactSupplierPrices(mixed, { groupOf: (id) => groupsOf(groups)[id]! })!;
  assert.equal(c.level, 'sku');
  assertExact(mixed, c, 'mixed');
  // Through the plan too: four SKU entries, each with its own currency.
  const p = plan({ skus, option_groups: groupsOf(groups), prices: priceMap(skus, (s) => (s.option_value_ids.includes('spool') ? cny('89') : { amount: '12.5', currency: 'EUR', source: 'bambu_eu' })) });
  assert.equal(p.supplier.level, 'sku');
  assert.deepEqual(p.wire.cost.inputs.filter((e) => e.scope === 'sku').map((e) => e.supplier_cost_currency).sort(), ['CNY', 'CNY', 'EUR', 'EUR']);
});

test('property: 3,000 random products — every compaction reproduces every SKU exactly, and is the least specific that can', () => {
  const rnd = prng(0x5eed_c0);
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const dec = () => `${int(1, 9999)}${rnd() < 0.5 ? `.${int(0, 99)}` : ''}`;
  const tally: Record<string, number> = {};
  for (let i = 0; i < 3000; i++) {
    const groups = Array.from({ length: int(0, 3) }, (_, g) => Array.from({ length: int(1, 3) }, (_, v) => `g${g}v${v}`));
    const colours = Array.from({ length: int(0, 3) }, (_, k) => `c${k}`);
    const skus = grid(groups, colours);
    const kind = int(0, 4); // 0 constant, 1 by a group, 2 by colour, 3 any, 4 mixed currencies
    const g = groups.length ? int(0, groups.length - 1) : 0;
    const table = new Map<string, string>();
    const val = (k: string) => table.get(k) ?? (table.set(k, dec()), table.get(k)!);
    const targets = targetsOf(skus, (s) => {
      const key = kind === 0 ? '' : kind === 1 ? (s.option_value_ids[g] ?? '') : kind === 2 ? (s.color_id ?? '') : s.combo_key;
      return [val(key), kind === 4 && rnd() < 0.5 ? 'EUR' : 'CNY'];
    });
    const c = compactSupplierPrices(targets, { groupOf: (id) => id.slice(0, 2) })!;
    assertExact(targets, c, `#${i}`);
    tally[c.level] = (tally[c.level] ?? 0) + 1;
    const distinct = new Set(targets.map((t) => `${t.amount} ${t.currency}`)).size;
    if (distinct === 1) assert.equal(c.level, 'base', `#${i} one price is one base absolute`);
    else if (new Set(targets.map((t) => t.currency)).size > 1) assert.equal(c.level, 'sku', `#${i} mixed currencies`);
    else if (kind === 1) assert.equal(c.level, 'option', `#${i} a function of one group`);
    assert.ok(c.entries.length <= skus.length, `#${i} never more entries than SKUs`);
  }
  for (const level of ['base', 'option', 'color', 'sku']) assert.ok((tally[level] ?? 0) > 100, `${level} exercised (${JSON.stringify(tally)})`);
});

test('a missing price is never taken from a sibling: EST_NO_PRICE, and the priced SKUs go per SKU', () => {
  const groups = [['spool', 'refill']] as const;
  const skus = grid(groups, ['red', 'blue']);
  const lost = skus.find((s) => s.option_value_ids.includes('refill') && s.color_id === 'blue')!;
  const p = plan({ skus, option_groups: groupsOf(groups), prices: priceMap(skus, (s) => (s === lost ? null : cny('69'))) });
  assert.deepEqual(flagOf(p, 'EST_NO_PRICE')?.combo_keys, [lost.combo_key]);
  assert.ok(p.blocked_by.includes('EST_NO_PRICE'));
  assert.equal(p.supplier.level, 'sku', 'even three equal prices are not written as a base the fourth would inherit');
  const rows = afterApply([], p);
  assert.match(supplierOf(rows, lost), /SUPPLIER_COST_MISSING/);
  for (const s of skus.filter((x) => x !== lost)) assert.equal(supplierOf(rows, s), '69 CNY');
  // An amount the form's wire cannot carry (13 integer digits, 7 decimals, a float) is no price either.
  for (const bad of ['1000000000000', '1.0000001', 69 as unknown as string]) {
    const q = plan({ skus: grid([]), prices: { '': cny(bad) } });
    assert.deepEqual(flagOf(q, 'EST_NO_PRICE')?.combo_keys, [''], String(bad));
    assert.equal(entryAt(q, 'base')?.supplier_cost_amount, undefined);
  }
});

test('the 61-entry cap of the form’s parse: 60 models + the base row pass, 61 models are EST_TOO_MANY_SCOPES', () => {
  for (const [models, blocked] of [[60, false], [61, true]] as const) {
    const values = Array.from({ length: models }, (_, i) => `m${String(i).padStart(2, '0')}`);
    const skus = grid([values]);
    const p = plan({ skus, prices: priceMap(skus, (s) => cny(String(100 + skus.indexOf(s)))) });
    assert.equal(p.supplier.level, 'option');
    assert.equal(p.wire.cost.inputs.length, models + 1, 'one entry per model, and the base row');
    assert.equal(!!flagOf(p, 'EST_TOO_MANY_SCOPES'), blocked, `${models} models`);
    assert.equal(p.blocked_by.includes('EST_TOO_MANY_SCOPES'), blocked);
  }
  // A refresh sends only what changed: the same 61 models re-applied with one new price is one entry.
  const values = Array.from({ length: 61 }, (_, i) => `m${String(i).padStart(2, '0')}`);
  const skus = grid([values]);
  const prices = priceMap(skus, (s) => cny(String(100 + skus.indexOf(s))));
  const first = plan({ skus, prices, product_package: PACKAGE });
  const stored = afterApply([], first);
  prices.set(skus[3]!.combo_key, cny('555'));
  const again = plan({ skus, prices, inputs: stored, applied: first.applied_json, product_rule: { state: 'ACTIVE', amount_usd: '2' } });
  assert.deepEqual(again.wire.cost.inputs, [{ scope: 'option', scope_id: 'm03', supplier_cost_amount: '555', supplier_cost_currency: 'CNY' }]);
  assert.equal(flagOf(again, 'EST_TOO_MANY_SCOPES'), undefined);
});

/* ---------------------------------------------------------- 3. measures -- */

test('measures: the product’s package goes on the base row, [depth, width, height] → [L, W, H], as the form’s withPackageMeasure', () => {
  const skus = grid([['spool', 'refill']]);
  const p = plan({ skus, prices: priceMap(skus, () => cny('69')) });
  const base = entryAt(p, 'base')!;
  assert.deepEqual(
    [base.shipping_weight_g, base.shipping_length_mm, base.shipping_width_mm, base.shipping_height_mm, base.manual_cbm],
    [1000, 200, 180, 100, undefined]
  );
  assert.deepEqual(productPackageOf(PACKAGE), { weight_g: 1000, box: [200, 180, 100] });
  assert.equal(base.shipping_profile, 'CHINA_SEA', 'the route’s profile (ROUTE_PROFILE.sea)');
  assert.equal(base.additional_cost_iqd, 500, 'the type’s extra cost');
  assert.equal(p.wire.cost.minimum_profit, '2', 'the type’s minimum profit, as the product’s rule (D3)');
  for (const s of p.skus) assert.deepEqual([s.weight_source, s.cbm_source, s.measure_source], ['product', 'product', 'product']);
  assert.equal(p.measure_basis, 'real');
  assert.equal(flagOf(p, 'EST_DEFAULT_WEIGHT'), undefined);
  assert.deepEqual(p.blocked_by, []);
});

test('measures: model and colour packages decide first; the product’s package next; the type’s defaults only where a SKU has none', () => {
  const groups = [['a1', 'mini']] as const;
  const MINI: EstimatePackage = { weight_g: 4200, box: [400, 380, 300] };
  const RED: EstimatePackage = { weight_g: null, box: [410, 390, 310] };
  const skus = grid(groups, ['red', 'grey'], (ids, colour) => ({ model: ids[0] === 'mini' ? MINI : null, color: colour === 'red' ? RED : null }));
  const prices = priceMap(skus, () => ({ amount: '299', currency: 'EUR', source: 'bambu_eu' }));
  const printer = typeOf({ key: 'printer', route: 'land', default_weight_g: 9000, default_length_mm: 500, default_width_mm: 500, default_height_mm: 500 });
  const src = (p: EstimatePlan, c: string) => {
    const s = p.skus.find((x) => x.combo_key === c)!;
    return [s.weight_source, s.cbm_source];
  };
  const key = (m: string, c: string) => skuComboKey({ option_value_ids: [m], color_id: c });
  // With the product's package: models and colours first, the product's package for the rest; no default.
  const real = plan({ skus, prices, type: printer, option_groups: groupsOf(groups) });
  assert.deepEqual(src(real, key('mini', 'grey')), ['model', 'model']);
  assert.deepEqual(src(real, key('mini', 'red')), ['model', 'colour'], 'the colour’s box is more specific than the model’s');
  assert.deepEqual(src(real, key('a1', 'red')), ['product', 'colour']);
  assert.deepEqual(src(real, key('a1', 'grey')), ['product', 'product']);
  assert.equal(real.measure_basis, 'real');
  // Without it: the type's defaults price exactly the SKUs nothing else measures, and are flagged on them.
  const bare = plan({ skus, prices, type: printer, option_groups: groupsOf(groups), product_package: null });
  const base = entryAt(bare, 'base')!;
  assert.deepEqual([base.shipping_weight_g, base.shipping_length_mm, base.manual_cbm], [9000, 500, undefined]);
  assert.deepEqual(src(bare, key('a1', 'grey')), ['type_default', 'type_default']);
  assert.deepEqual(src(bare, key('a1', 'red')), ['type_default', 'colour']);
  assert.deepEqual(src(bare, key('mini', 'red')), ['model', 'colour']);
  assert.deepEqual(flagOf(bare, 'EST_DEFAULT_WEIGHT')?.combo_keys, [key('a1', 'grey'), key('a1', 'red')].sort());
  assert.deepEqual(flagOf(bare, 'EST_DEFAULT_BOX')?.combo_keys, [key('a1', 'grey')]);
  assert.equal(bare.measure_basis, 'mixed');
  assert.equal(bare.skus.find((s) => s.combo_key === key('a1', 'grey'))!.measure_source, 'type_default');
  // Every SKU measured by its own package: no default is written at all, even with none on the product.
  const own = grid(groups, [], () => ({ model: MINI, color: null }));
  const none = plan({ skus: own, prices: priceMap(own, () => cny('10')), option_groups: groupsOf(groups), product_package: null });
  assert.deepEqual([entryAt(none, 'base')?.shipping_weight_g, entryAt(none, 'base')?.shipping_length_mm, entryAt(none, 'base')?.manual_cbm], [undefined, undefined, undefined]);
  // The owner's own option-level measures win over a default too (they are kept, and decide their SKUs).
  const owner = plan({ skus, prices, type: printer, option_groups: groupsOf(groups), product_package: null, inputs: [row('option', 'a1', { shipping_weight_g: 8000, shipping_length_mm: 450, shipping_width_mm: 450, shipping_height_mm: 450 })] });
  assert.deepEqual(src(owner, key('a1', 'grey')), ['owner', 'owner']);
  assert.equal(entryAt(owner, 'base')?.shipping_weight_g, undefined, 'no SKU needs a default weight any more');
  // A type with no default where a SKU needs one blocks: EST_TYPE_INCOMPLETE, naming the measure and the SKUs.
  const short = plan({ skus, prices, option_groups: groupsOf(groups), product_package: null, type: typeOf({ route: 'land', default_weight_g: null, default_length_mm: null, default_width_mm: null, default_height_mm: null }) });
  const f = flagOf(short, 'EST_TYPE_INCOMPLETE')!;
  assert.deepEqual(f.fields, ['shipping_box', 'shipping_weight_g']);
  assert.deepEqual(f.combo_keys, [key('a1', 'grey'), key('a1', 'red')].sort());
  assert.ok(short.blocked_by.includes('EST_TYPE_INCOMPLETE'));
  // And a type with no minimum profit blocks (D3: the profit is the owner's per-type figure, never invented).
  const noProfit = plan({ skus, prices, option_groups: groupsOf(groups), type: typeOf({ min_profit_usd: null }) });
  assert.deepEqual(flagOf(noProfit, 'EST_TYPE_INCOMPLETE')?.fields, ['minimum_profit']);
  assert.equal(noProfit.wire.cost.minimum_profit, undefined);
  // … whatever the product holds: the type table is filled in first (§4.1), so every product of the type waits alike.
  const held = plan({ skus, prices, option_groups: groupsOf(groups), type: typeOf({ min_profit_usd: null }), product_rule: { state: 'ACTIVE', amount_usd: '5' } });
  assert.deepEqual(flagOf(held, 'EST_TYPE_INCOMPLETE')?.fields, ['minimum_profit']);
  assert.equal(held.wire.cost.minimum_profit, undefined, 'and the owner’s own rule is never touched');
});

test('defaults never reach products.package_*: the plan names pricing inputs only, and leaves the product’s dimensions alone', () => {
  const skus = grid([['spool', 'refill']], ['red']);
  const dims = Object.freeze({ package_weight_g: null, package_depth_mm: null, package_width_mm: null, package_height_mm: null });
  const p = plan({ skus, prices: priceMap(skus, () => cny('69')), product_package: dims });
  assert.equal(flagOf(p, 'EST_DEFAULT_WEIGHT')?.combo_keys?.length, 2, 'the defaults are in use');
  const keys = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        keys.add(k);
        walk(x);
      }
    }
  };
  walk(p);
  assert.deepEqual([...keys].filter((k) => /package|dimension|depth_mm/.test(k)), [], 'no product dimension key anywhere in the plan');
  for (const e of p.wire.cost.inputs) {
    for (const k of Object.keys(e)) assert.ok(k === 'scope' || k === 'scope_id' || (FORM_INPUT_FIELDS as readonly string[]).includes(k), `${k} is not a form input field`);
  }
  // The defaults sit in the private base input, recorded as `type_default` so a confirm can refuse while they price a SKU.
  assert.deepEqual(p.applied.inputs.filter((f) => f.source === 'type_default').map((f) => f.field).sort(), ['additional_cost_iqd', 'shipping_box', 'shipping_profile', 'shipping_weight_g']);
  assert.deepEqual(dims, { package_weight_g: null, package_depth_mm: null, package_width_mm: null, package_height_mm: null });
});

test('manual_cbm only without a box: the type’s CBM is written only where no box exists at base (LD6)', () => {
  const skus = grid([['spool', 'refill']]);
  const prices = priceMap(skus, () => cny('69'));
  const both = typeOf({ default_cbm: '0.0045' });
  // No box anywhere: the type's CBM, as manual_cbm, and not its box.
  const bare = plan({ skus, prices, type: both, product_package: { package_weight_g: 1000 } });
  const b = entryAt(bare, 'base')!;
  assert.deepEqual([b.manual_cbm, b.shipping_length_mm], ['0.0045', undefined]);
  for (const s of bare.skus) assert.equal(s.cbm_source, 'type_default');
  assert.equal(resolveSkuInputs(estimateChain(afterApply([], bare), skus[0]!)).inputs.cbm?.effective, '0.0045');
  // The product's own box: no manual CBM, which would beat it at its level.
  const boxed = plan({ skus, prices, type: both });
  assert.equal(entryAt(boxed, 'base')!.manual_cbm, undefined);
  for (const s of boxed.skus) assert.equal(s.cbm_source, 'product');
  // The owner's own box at base: no manual CBM over it either, and the owner's box is kept.
  const ownerBox = plan({ skus, prices, type: both, product_package: { package_weight_g: 1000 }, inputs: [row('base', '', { shipping_length_mm: 300, shipping_width_mm: 300, shipping_height_mm: 300 })] });
  const o = entryAt(ownerBox, 'base')!;
  assert.deepEqual([o.manual_cbm, o.shipping_length_mm], [undefined, undefined]);
  for (const s of ownerBox.skus) assert.equal(s.cbm_source, 'owner');
  // A type with a box only: the box.
  const boxOnly = plan({ skus, prices, product_package: { package_weight_g: 1000 } });
  assert.deepEqual([entryAt(boxOnly, 'base')!.manual_cbm, entryAt(boxOnly, 'base')!.shipping_length_mm], [undefined, 210]);
  // Later the product gets a box: the estimator's own default CBM is cleared, the box written.
  const stored = afterApply([], bare);
  const later = plan({ skus, prices, type: both, inputs: stored, applied: bare.applied_json, product_rule: { state: 'ACTIVE', amount_usd: '2' } });
  const l = entryAt(later, 'base')!;
  assert.deepEqual([l.manual_cbm, l.shipping_length_mm, l.shipping_width_mm, l.shipping_height_mm], [null, 200, 180, 100]);
  for (const s of later.skus) assert.equal(s.cbm_source, 'product');
  assert.equal(later.measure_basis, 'real');
});

/* ------------------------------------------------- 4. the three-way merge -- */

test('three-way merge (§4.5): an unchanged refresh sends nothing; a new price, only that; a new shape clears the old one', () => {
  const groups = [['spool', 'refill']] as const;
  const skus = grid(groups, ['red', 'blue']);
  const og = groupsOf(groups);
  const byKind = (refill: string) => priceMap(skus, (s) => cny(s.option_value_ids.includes('spool') ? '89' : refill));
  const first = plan({ skus, option_groups: og, prices: byKind('69') });
  assert.equal(first.supplier.level, 'option');
  const stored = afterApply([], first);
  const rule = { state: 'ACTIVE', amount_usd: '2' };
  // Applied record round-trips; the refresh of the same inputs is empty.
  assert.deepEqual(parseAppliedWire(first.applied_json), first.applied);
  assert.equal(serializeAppliedWire(parseAppliedWire(first.applied_json)!), first.applied_json);
  const same = plan({ skus, option_groups: og, prices: byKind('69'), inputs: stored, applied: first.applied_json, product_rule: rule });
  assert.deepEqual(same.wire, { method: 'cost', cost: { inputs: [] } });
  assert.equal(same.applied_json, first.applied_json);
  // A new snapshot moves the refill: one field of one scope.
  const moved = plan({ skus, option_groups: og, prices: byKind('71.5'), inputs: stored, applied: first.applied_json, product_rule: rule });
  assert.deepEqual(moved.wire.cost.inputs, [{ scope: 'option', scope_id: 'refill', supplier_cost_amount: '71.5', supplier_cost_currency: 'CNY' }]);
  // Both kinds now cost the same: one base absolute, and the two option absolutes the estimator wrote are cleared.
  const flat = plan({ skus, option_groups: og, prices: byKind('89'), inputs: stored, applied: first.applied_json, product_rule: rule });
  assert.equal(flat.supplier.level, 'base');
  assert.deepEqual(entryAt(flat, 'base')?.supplier_cost_amount, '89');
  for (const v of ['spool', 'refill']) assert.deepEqual(entryAt(flat, 'option', v), { scope: 'option', scope_id: v, supplier_cost_amount: null, supplier_cost_currency: null });
  for (const s of skus) assert.equal(supplierOf(afterApply(stored, flat), s), '89 CNY');
  assert.deepEqual(flat.applied.inputs.filter((f) => f.field === 'supplier_cost').map((f) => [f.scope, f.scope_id]), [['base', '']]);
  // The type's figures move: profile, extra cost and minimum profit follow; nothing the owner holds is touched.
  const retyped = plan({ skus, option_groups: og, prices: byKind('69'), inputs: stored, applied: first.applied_json, product_rule: rule, type: typeOf({ additional_cost_iqd: 750, min_profit_usd: '2.50' }) });
  assert.deepEqual(retyped.wire, { method: 'cost', cost: { inputs: [{ scope: 'base', additional_cost_iqd: 750 }], minimum_profit: '2.5' } });
  // Determinism: the same inputs give the same wire, byte for byte (the apply re-plans and compares hashes).
  assert.equal(JSON.stringify(plan({ skus, option_groups: og, prices: byKind('71.5'), inputs: stored, applied: first.applied_json, product_rule: rule })), JSON.stringify(moved));
});

test('three-way merge: a field the owner changed is kept and named (EST_OWNER_EDITED, names only); one the estimator never wrote is kept silently', () => {
  const groups = [['spool', 'refill']] as const;
  const skus = grid(groups, ['red', 'blue']);
  const og = groupsOf(groups);
  const prices = priceMap(skus, (s) => cny(s.option_value_ids.includes('spool') ? '89' : '69'));
  const first = plan({ skus, option_groups: og, prices });
  const stored = afterApply([], first);
  // The owner corrects the refill's cost in USD (procurementLinePricing) and the base weight in the form.
  const edited = stored.map((r) =>
    r.scope === 'option' && r.scope_id === 'refill' ? { ...r, supplier_cost_amount: '9.25', supplier_cost_currency: 'USD' as const } : r.scope === 'base' ? { ...r, shipping_weight_g: 1111 } : r
  );
  const next = plan({ skus, option_groups: og, prices: priceMap(skus, (s) => cny(s.option_value_ids.includes('spool') ? '95' : '75')), inputs: edited, applied: first.applied_json, product_rule: { state: 'ACTIVE', amount_usd: '3' } });
  // The refill is the owner's now, so the catalogue prices the spool alone: one base absolute is exact (the
  // owner's refill absolute replaces it on the refill), and the estimator's own spool absolute is cleared.
  assert.equal(next.supplier.level, 'base');
  assert.deepEqual(next.wire.cost.inputs, [
    { scope: 'base', supplier_cost_amount: '95', supplier_cost_currency: 'CNY' },
    { scope: 'option', scope_id: 'spool', supplier_cost_amount: null, supplier_cost_currency: null },
  ], 'the owner’s refill cost and base weight are not touched');
  assert.equal(next.wire.cost.minimum_profit, undefined, 'the owner’s minimum profit stays');
  assert.deepEqual(flagOf(next, 'EST_OWNER_EDITED'), { code: 'EST_OWNER_EDITED', fields: ['minimum_profit', 'shipping_weight_g', 'supplier_cost'] });
  for (const s of skus) assert.equal(supplierOf(afterApply(edited, next), s), s.option_value_ids.includes('spool') ? '95 CNY' : '9.25 USD');
  assert.deepEqual(next.skus.map((s) => s.supplier), skus.map((s) => (s.option_value_ids.includes('spool') ? 'catalogue' : 'owner')));
  // The record keeps what the estimator wrote under the owner's value: the next refresh still knows it is theirs.
  const again = plan({ skus, option_groups: og, prices, inputs: afterApply(edited, next), applied: next.applied_json, product_rule: { state: 'ACTIVE', amount_usd: '3' } });
  assert.deepEqual(flagOf(again, 'EST_OWNER_EDITED')?.fields, ['minimum_profit', 'shipping_weight_g', 'supplier_cost']);
  assert.ok(!again.wire.cost.inputs.some((e) => e.scope === 'option' && e.scope_id === 'refill'));
  // Never written by the estimator (no record) but holding a value: kept, no EST_OWNER_EDITED; listed as held.
  const fresh = plan({ skus, option_groups: og, prices, inputs: [row('base', '', { shipping_profile: 'CHINA_AIR', additional_cost_iqd: 0 })], product_rule: { state: 'ACTIVE', amount_usd: '7' } });
  assert.equal(flagOf(fresh, 'EST_OWNER_EDITED'), undefined);
  assert.deepEqual([entryAt(fresh, 'base')?.shipping_profile, entryAt(fresh, 'base')?.additional_cost_iqd, fresh.wire.cost.minimum_profit], [undefined, undefined, undefined]);
  assert.deepEqual(fresh.owner_held.map((h) => h.field).sort(), ['additional_cost_iqd', 'minimum_profit', 'shipping_profile']);
  // …but a stock route other than the estimate's (air, the type sails by sea) would price D on air freight: it blocks.
  assert.deepEqual(flagOf(fresh, 'EST_STRUCTURE_OWNER'), { code: 'EST_STRUCTURE_OWNER', combo_keys: skus.map((s) => s.combo_key).sort(), fields: ['shipping_profile'] });
  assert.ok(fresh.blocked_by.includes('EST_STRUCTURE_OWNER'));
  // A cost the owner typed in dinars is the owner's even if its dollars happened to equal a catalogue price.
  const iqd = plan({ skus: grid([]), prices: { '': { amount: '9.25', currency: 'USD', source: 'bambu_us' } }, inputs: [row('base', '', { supplier_cost_amount: '9.25', supplier_cost_currency: 'USD', supplier_input_mode: 'IQD_CONVERTED' })], applied: { v: 1, inputs: [{ scope: 'base', scope_id: '', field: 'supplier_cost', value: { amount: '9.25', currency: 'USD' }, source: 'bambu_us' }], minimum_profit: null } });
  assert.equal(entryAt(iqd, 'base')?.supplier_cost_amount, undefined);
  assert.deepEqual(iqd.skus[0]!.supplier, 'owner');
});

test('the stock route is the estimate’s (§4.3): an owner’s profile on another route is never overwritten — it blocks (EST_STRUCTURE_OWNER) on the SKUs it reaches', () => {
  const groups = [['spool', 'refill']] as const;
  const skus = grid(groups, ['red']);
  const og = groupsOf(groups);
  const prices = priceMap(skus, () => cny('69'));
  const key = (m: string) => skuComboKey({ option_value_ids: [m], color_id: 'red' });
  const profileOf = (rows: readonly Partial<EstimateInputRow>[], s: EstimateSku) => resolveSkuInputs(estimateChain(rows, s)).inputs.shipping_profile?.value ?? null;
  const offRoute = (p: EstimatePlan) => flagOf(p, 'EST_STRUCTURE_OWNER');

  // Nothing held: the estimator writes the route's profile, and nothing blocks.
  const first = plan({ skus, option_groups: og, prices });
  assert.equal(entryAt(first, 'base')?.shipping_profile, 'CHINA_SEA');
  assert.equal(offRoute(first), undefined);
  // The owner holds the route's own profile: kept as it is, and nothing blocks.
  const same = plan({ skus, option_groups: og, prices, inputs: [row('base', '', { shipping_profile: 'CHINA_SEA' })] });
  assert.equal(entryAt(same, 'base')?.shipping_profile, undefined);
  assert.equal(offRoute(same), undefined);
  assert.ok(!same.blocked_by.includes('EST_STRUCTURE_OWNER'));

  // The owner holds land (a data-only form save, no record): kept, never overwritten — and the product is blocked.
  const land = [row('base', '', { shipping_profile: 'GERMANY_LAND' })];
  const held = plan({ skus, option_groups: og, prices, inputs: land });
  assert.equal(entryAt(held, 'base')?.shipping_profile, undefined, 'the owner’s route is not touched');
  for (const s of skus) assert.equal(profileOf(afterApply(land, held), s), 'GERMANY_LAND');
  assert.deepEqual(offRoute(held), { code: 'EST_STRUCTURE_OWNER', combo_keys: [key('refill'), key('spool')].sort(), fields: ['shipping_profile'] });
  assert.ok(held.blocked_by.includes('EST_STRUCTURE_OWNER'));
  // The same profile is the estimate's when the route is land (a type or override that ships by land): nothing blocks.
  assert.equal(offRoute(plan({ skus, option_groups: og, prices, inputs: land, type: typeOf({ route: 'land' }) })), undefined);

  // The owner changed the profile the estimator wrote: kept and named, and blocked too.
  const stored = afterApply([], first).map((r) => (r.scope === 'base' ? { ...r, shipping_profile: 'CHINA_AIR' as const } : r));
  const edited = plan({ skus, option_groups: og, prices, inputs: stored, applied: first.applied_json, product_rule: { state: 'ACTIVE', amount_usd: '2' } });
  assert.ok(flagOf(edited, 'EST_OWNER_EDITED')?.fields?.includes('shipping_profile'));
  assert.equal(entryAt(edited, 'base')?.shipping_profile, undefined);
  assert.deepEqual(offRoute(edited)?.combo_keys, [key('refill'), key('spool')].sort());

  // A profile on one model only reaches that model's SKUs.
  const model = plan({ skus, option_groups: og, prices, inputs: [row('option', 'refill', { shipping_profile: 'CHINA_AIR' })] });
  assert.deepEqual(offRoute(model), { code: 'EST_STRUCTURE_OWNER', combo_keys: [key('refill')], fields: ['shipping_profile'] });

  // The owner clears it (the form sends null): the field is empty again, so the next estimate writes the route's.
  const cleared = plan({ skus, option_groups: og, prices, inputs: [row('base', '', { shipping_profile: null })] });
  assert.equal(entryAt(cleared, 'base')?.shipping_profile, 'CHINA_SEA');
  assert.equal(offRoute(cleared), undefined);
});

test('three-way merge across levels: no estimator absolute at or above an owner’s cost, nothing beneath a cleared one', () => {
  const groups = [['spool', 'refill']] as const;
  const colours = ['red', 'blue'];
  const skus = grid(groups, colours);
  const og = groupsOf(groups);
  const key = (m: string, c: string) => skuComboKey({ option_value_ids: [m], color_id: c });
  // Colour prices (Tmall prices each colour), and the owner's own cost on the refill model.
  const byColour = priceMap(skus, (s) => cny(s.color_id === 'red' ? '69' : '72'));
  const ownerModel = [row('option', 'refill', { supplier_cost_amount: '50', supplier_cost_currency: 'CNY' })];
  const p = plan({ skus, option_groups: og, prices: byColour, inputs: ownerModel });
  // A colour absolute would override the owner's model cost on the refill SKUs: the spool SKUs go per SKU instead.
  assert.equal(p.supplier.level, 'sku');
  assert.deepEqual(p.wire.cost.inputs.filter((e) => e.supplier_cost_amount).map((e) => e.scope_id).sort(), [key('spool', 'blue'), key('spool', 'red')].sort());
  const after = afterApply(ownerModel, p);
  assert.equal(supplierOf(after, skus.find((s) => s.combo_key === key('refill', 'red'))!), '50 CNY');
  assert.equal(supplierOf(after, skus.find((s) => s.combo_key === key('spool', 'blue'))!), '72 CNY');
  // One price everywhere: a base absolute IS allowed beneath the owner's model cost (it never reaches the refill).
  const flat = plan({ skus, option_groups: og, prices: priceMap(skus, () => cny('69')), inputs: ownerModel });
  assert.equal(flat.supplier.level, 'base');
  assert.equal(supplierOf(afterApply(ownerModel, flat), skus.find((s) => s.combo_key === key('refill', 'blue'))!), '50 CNY');
  // The owner CLEARED the refill cost the estimator wrote: no base (or any) absolute may price the refill from the spool.
  const first = plan({ skus, option_groups: og, prices: priceMap(skus, (s) => cny(s.option_value_ids.includes('spool') ? '89' : '69')) });
  const cleared = afterApply([], first).map((r) => (r.scope === 'option' && r.scope_id === 'refill' ? { ...r, supplier_cost_amount: null, supplier_cost_currency: null } : r));
  const next = plan({ skus, option_groups: og, prices: priceMap(skus, () => cny('89')), inputs: cleared, applied: first.applied_json, product_rule: { state: 'ACTIVE', amount_usd: '2' } });
  assert.notEqual(next.supplier.level, 'base');
  const nextRows = afterApply(cleared, next);
  for (const s of skus) assert.match(supplierOf(nextRows, s), s.option_value_ids.includes('spool') ? /^89 CNY$/ : /^SUPPLIER_COST_MISSING/);
  assert.deepEqual(flagOf(next, 'EST_NO_PRICE')?.combo_keys, [key('refill', 'blue'), key('refill', 'red')].sort(), 'the owner’s cleared SKUs have no price: blocked, never inferred');
  assert.ok(flagOf(next, 'EST_OWNER_EDITED')?.fields?.includes('supplier_cost'));
  // The stored record keeps the cleared field the owner's on every later refresh.
  const later = plan({ skus, option_groups: og, prices: priceMap(skus, () => cny('89')), inputs: nextRows, applied: next.applied_json, product_rule: { state: 'ACTIVE', amount_usd: '2' } });
  assert.ok(!later.wire.cost.inputs.some((e) => e.scope_id === 'refill' && e.supplier_cost_amount));
});

test('the merged store decides: a currency the owner left without an amount never becomes a conflict, the representation moves past it', () => {
  const groups = [['spool', 'refill']] as const;
  const skus = grid(groups, ['red', 'blue']);
  const og = groupsOf(groups);
  const prices = priceMap(skus, (s) => cny(s.option_value_ids.includes('spool') ? '89' : '69'));
  // The red colour's row names EUR with no amount (a currency chosen, the amount left empty).
  const stray = [row('color', 'red', { supplier_cost_currency: 'EUR' })];
  const optionRows = [row('option', 'spool', { supplier_cost_amount: '89', supplier_cost_currency: 'CNY' }), row('option', 'refill', { supplier_cost_amount: '69', supplier_cost_currency: 'CNY' })];
  const red = skus.find((s) => s.color_id === 'red')!;
  // The option absolutes alone are exact, but beneath that EUR they are CURRENCY_WITHOUT_AMOUNT on every red SKU …
  assert.match(supplierOf([...stray, ...optionRows], red), /CURRENCY_WITHOUT_AMOUNT/);
  // … so the plan moves on, to absolutes at each SKU's own level, above the stray currency.
  const p = plan({ skus, option_groups: og, prices, inputs: stray });
  assert.equal(p.supplier.level, 'sku');
  const after = afterApply(stray, p);
  for (const s of skus) assert.equal(supplierOf(after, s), `${s.option_value_ids.includes('spool') ? '89' : '69'} CNY`, s.combo_key);
  assert.equal(p.supplier.exact, true);
  assert.deepEqual(p.blocked_by, []);
});

test('a record at a scope the product no longer offers is carried, never cleared through the wire (the form would refuse the scope)', () => {
  const skus3 = grid([['a', 'b', 'c']]);
  const first = plan({ skus: skus3, prices: priceMap(skus3, (s) => cny(String(10 + skus3.indexOf(s)))) });
  const stored = afterApply([], first);
  const skus2 = skus3.filter((s) => s.combo_key !== 'o:c');
  const next = plan({ skus: skus2, prices: priceMap(skus2, (s) => cny(String(10 + skus3.indexOf(s)))), inputs: stored, applied: first.applied_json, product_rule: { state: 'ACTIVE', amount_usd: '2' } });
  assert.deepEqual(next.wire.cost.inputs, []);
  assert.ok(next.applied.inputs.some((f) => f.scope === 'option' && f.scope_id === 'c'), 'still the estimator’s, should the model come back');
  // With the form's own scope list (formScopeIds), a scope it lists is cleared as usual.
  const listed = plan({ skus: skus2, prices: priceMap(skus2, (s) => cny(String(10 + skus3.indexOf(s)))), inputs: stored, applied: first.applied_json, product_rule: { state: 'ACTIVE', amount_usd: '2' }, scopes: { option: ['a', 'b', 'c'] } });
  assert.deepEqual(listed.wire.cost.inputs, [{ scope: 'option', scope_id: 'c', supplier_cost_amount: null, supplier_cost_currency: null }]);
});

test('price-source flags ride only on SKUs the catalogue prices; the catalogue’s own codes are carried; source_ref names the snapshot or the type', () => {
  const skus = grid([['a', 'b', 'c', 'd']]);
  const sources: Record<string, EstimateSupplierPrice> = {
    'o:a': { amount: '10', currency: 'USD', source: 'bambu_us', ref: 'sps_us', flags: ['EST_SNAPSHOT_STALE'] },
    'o:b': { amount: '11', currency: 'USD', source: 'typed' },
    'o:c': { amount: '12', currency: 'USD', source: 'store_page', flags: ['EST_UNITS_DIVIDED'] },
    'o:d': { amount: '13', currency: 'USD', source: 'bambu_eu', ref: 'sps_eu' },
  };
  const p = plan({ skus, prices: sources, type: typeOf({ key: 'electronics_part', route: 'land' }) });
  const flags = Object.fromEntries(p.skus.map((s) => [s.combo_key, s.flags]));
  assert.deepEqual(flags, { 'o:a': ['EST_SNAPSHOT_STALE', 'EST_US_REFERENCE'], 'o:b': ['EST_MANUAL_PRICE'], 'o:c': ['EST_STORE_PAGE_PRICE', 'EST_UNITS_DIVIDED'], 'o:d': [] });
  assert.deepEqual(flagOf(p, 'EST_US_REFERENCE')?.combo_keys, ['o:a']);
  assert.deepEqual(p.source_refs, [
    { scope: 'base', scope_id: '', source_ref: 'estimate:electronics_part' },
    { scope: 'option', scope_id: 'a', source_ref: 'estimate:sps_us' },
    { scope: 'option', scope_id: 'b', source_ref: 'estimate:electronics_part' },
    { scope: 'option', scope_id: 'c', source_ref: 'estimate:electronics_part' },
    { scope: 'option', scope_id: 'd', source_ref: 'estimate:sps_eu' },
  ]);
  assert.equal(entryAt(p, 'base')?.shipping_profile, 'GERMANY_LAND');
  // An owner-priced SKU carries none of its catalogue price's flags.
  const owned = plan({ skus, prices: sources, inputs: [row('option', 'a', { supplier_cost_amount: '9', supplier_cost_currency: 'USD' })] });
  assert.deepEqual(owned.skus.find((s) => s.combo_key === 'o:a')!.flags, []);
  assert.equal(flagOf(owned, 'EST_US_REFERENCE'), undefined);
  for (const code of ESTIMATE_INPUT_BLOCKING) assert.ok(!p.blocked_by.includes(code));
});

test('parseAppliedWire is defensive: a bad document is none, a bad record is dropped (its field reads as the owner’s)', () => {
  for (const bad of [null, undefined, '', '{', '[]', '{"v":2,"inputs":[]}', 42]) assert.equal(parseAppliedWire(bad), null, String(bad));
  const doc = {
    v: 1,
    inputs: [
      { scope: 'base', scope_id: '', field: 'shipping_weight_g', value: 1000, source: 'product_package' },
      { scope: 'base', scope_id: '', field: 'shipping_weight_g', value: 2000, source: 'type_default' },
      { scope: 'option', scope_id: '', field: 'supplier_cost', value: { amount: '5', currency: 'CNY' }, source: 'tmall_cn' },
      { scope: 'option', scope_id: 'x', field: 'supplier_cost', value: { amount: 5, currency: 'CNY' }, source: 'tmall_cn' },
      { scope: 'option', scope_id: 'x', field: 'supplier_cost', value: { amount: '05.50', currency: 'CNY' }, source: 'tmall_cn' },
      { scope: 'base', scope_id: '', field: 'shipping_box', value: [1, 2], source: 'type_default' },
      { scope: 'base', scope_id: '', field: 'nope', value: 1, source: 'type_default' },
      { scope: 'base', scope_id: '', field: 'manual_cbm', value: '0.1', source: 'invented' },
    ],
    minimum_profit: { amount_usd: '2.50', source: 'type_default' },
  };
  assert.deepEqual(parseAppliedWire(JSON.stringify(doc)), {
    v: 1,
    inputs: [
      { scope: 'base', scope_id: '', field: 'shipping_weight_g', value: 1000, source: 'product_package' },
      { scope: 'option', scope_id: 'x', field: 'supplier_cost', value: { amount: '5.5', currency: 'CNY' }, source: 'tmall_cn' },
    ],
    minimum_profit: { amount_usd: '2.5', source: 'type_default' },
  });
});

test('skuMeasureSources is §4.9’s test: a measure is defaulted only while the base field still holds the type default', () => {
  const skus = grid([['a']]);
  const p = plan({ skus, prices: priceMap(skus, () => cny('1')), product_package: null });
  const rows = afterApply([], p);
  assert.deepEqual(skuMeasureSources(rows, skus[0]!, p.applied), { weight: 'type_default', cbm: 'type_default', issues: [] });
  // The owner typed the real weight in the form: no longer defaulted (the box still is).
  const typed = rows.map((r) => (r.scope === 'base' ? { ...r, shipping_weight_g: 1234 } : r));
  assert.deepEqual(skuMeasureSources(typed, skus[0]!, p.applied), { weight: 'owner', cbm: 'type_default', issues: [] });
  // Nothing at all: none, with the engine's codes.
  assert.deepEqual(skuMeasureSources([], skus[0]!, null), { weight: 'none', cbm: 'none', issues: ['CBM_MISSING', 'WEIGHT_MISSING'] });
});

/* ------------------------------------------------- 5. end to end, real DB -- */

/** A database with the V2 engine (through 0217: these inputs need nothing of 0218), the brief's rates, and one filament. */
function filamentWorld() {
  const raw = dbThrough('0217');
  raw.exec(OWNER_ROW_SQL);
  applyRate(raw, 'USD_IQD', '1600');
  applyRate(raw, 'EUR_USD', '1.1');
  applyRate(raw, 'CNY_USD', '0.14');
  raw.exec(`UPDATE pricing_shipping_rates SET rate_iqd = '3200', version = version + 1 WHERE profile = 'GERMANY_LAND';
            UPDATE pricing_shipping_rates SET rate_iqd = '20000', version = version + 1 WHERE profile = 'CHINA_AIR';
            UPDATE pricing_shipping_rates SET rate_iqd = '400000', version = version + 1 WHERE profile = 'CHINA_SEA';`);
  const pid = 'est_pla';
  raw.exec(`
    INSERT INTO products (id, slug, name, name_ar, name_ku, status, price_iqd, stock, selling_type, sale_types, preorder_transports, inventory_mode,
                          package_weight_g, package_depth_mm, package_width_mm, package_height_mm)
    VALUES ('${pid}', 'est-pla', 'PLA Basic', 'بلا بيسك', 'پی ئێڵ ئەی', 'active', 1000, NULL, 'pre_order', '["pre_order"]',
            '[{"method":"sea","commission_iqd":0,"active":true}]', 'BASE', 1000, 200, 200, 100);
    INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('${pid}_gk', '${pid}', 'Kind', 0, 1), ('${pid}_gw', '${pid}', 'Weight', 1, 1);
    INSERT INTO product_option_values (id, product_id, group_id, name_en, name_ar, name_ckb, sort, active) VALUES
      ('${pid}_spool', '${pid}', '${pid}_gk', 'Spool', 'مع بكرة', 'لەگەڵ قەرقەرە', 0, 1),
      ('${pid}_refill', '${pid}', '${pid}_gk', 'Refill', 'عبوة', 'پڕکردنەوە', 1, 1),
      ('${pid}_1kg', '${pid}', '${pid}_gw', '1 kg', '1 كغ', '1 کگ', 0, 1),
      ('${pid}_2kg', '${pid}', '${pid}_gw', '2 kg', '2 كغ', '2 کگ', 1, 1);
    INSERT INTO product_colors (id, product_id, name_en, name_ar, name_ckb, hex, sort, active) VALUES
      ('${pid}_red', '${pid}', 'Red', 'أحمر', 'سوور', '#cc0000', 0, 1),
      ('${pid}_blue', '${pid}', 'Blue', 'أزرق', 'شین', '#0000cc', 1, 1);
  `);
  return { raw, db: asD1(raw), pid };
}

test('end to end: the wire passes the real V2 parser and evaluation, and every SKU is priced at §4.3’s formula', async () => {
  const w = filamentWorld();
  const read = (await loadV2Read(w.db, w.pid))!;
  const { skus: units } = sellableSkus(read.loaded.doc, read.loaded.view);
  assert.equal(units.length, 8, 'kind × weight × colour');
  const packages = packagesOf(read.loaded.doc);
  const skus: EstimateSku[] = units.map((u) => ({ combo_key: u.combo_key, option_value_ids: u.option_value_ids, color_id: u.color?.id ?? null, packaged: packages(u.option_value_ids, u.color?.id ?? null) }));
  const option_groups = Object.fromEntries((read.loaded.view?.values ?? []).map((v) => [v.id, v.group_id] as const));
  // Tmall prices the refill and the spool, and the 2 kg twice the 1 kg: a function of two groups → per SKU.
  const amountOf = (s: EstimateSku) => {
    const kind = s.option_value_ids.includes(`${w.pid}_spool`) ? 89 : 69;
    return String(s.option_value_ids.includes(`${w.pid}_2kg`) ? kind * 2 - 0.5 : kind);
  };
  const ids = formScopeIds(read.loaded);
  const input: EstimatePlanInput = {
    skus,
    prices: priceMap(skus, (s) => cny(amountOf(s))),
    option_groups,
    type: TYPE,
    product_package: read.loaded.doc.dimensions,
    inputs: read.stored.inputs,
    product_rule: ruleAt(read.stored.rules, w.pid, 'target_profit', 'product', ''),
    applied: null,
    scopes: { option: ids.option, color: ids.color, sku: ids.sku },
  };
  const p = planEstimateInputs(input);
  assert.deepEqual(p.blocked_by, []);
  assert.equal(p.supplier.level, 'sku');
  const o = { viewer: 'owner' as const, env: {} as Env, user: null, now: '2026-10-31T00:00:00.000Z' };
  const desired = desiredFor(read, parseV2Wire(JSON.parse(JSON.stringify(p.wire))), o);
  const ev = await evaluateDesired(read, desired);
  assert.equal(ev.complete, true, ev.codes.join(','));
  // §4.3 by hand: R = amount × C·U + CBM × sea + extra; D = roundPriceIqd(R + T × U); a pre-order-only SKU is D.
  const rates = read.rates!;
  const fx = procurementExact(rates.central.fx.CNY!.rate!);
  const sea = procurementExact(rates.central.shipping.CHINA_SEA!.rate!);
  const cbm = divProcurementExact(procurementExact(200 * 200 * 100), 1_000_000_000n);
  const tu = mulProcurementExact(procurementExact('2'), procurementExact(rates.usd_iqd!));
  const rows = mergedInputs(read.stored.inputs, desired.inputWrites);
  for (const s of skus) {
    const r = addProcurementExact(mulProcurementExact(procurementExact(amountOf(s)), fx), mulProcurementExact(cbm, sea), procurementExact(500));
    const expected = roundPriceIqd(addProcurementExact(r, tu));
    const got = ev.rows.find((x) => x.combo_key === s.combo_key && x.channel === 'pre_order_sea');
    assert.equal(got?.new_iqd, expected, `${s.combo_key}: ${procurementExactText(r)} + T·U`);
    assert.equal(ev.rows.filter((x) => x.combo_key === s.combo_key).length, 1, 'one route: pre-order by sea only');
    assert.equal(supplierOf(rows, s), `${canonicalSupplierAmount(amountOf(s))} CNY`, 'the merged store reproduces the catalogue price');
  }
  // Every entry was accepted for its own scope and carries the form's source_ref ('owner'): compute sets the estimate's.
  assert.equal(desired.inputWrites.length, p.wire.cost.inputs.length);
  assert.deepEqual(desired.ruleWrites.map((r) => [r.kind, r.scope, r.next.amount_usd]), [['target_profit', 'product', '2']]);

  // A refresh of the same estimate over the applied store sends nothing; the owner's correction survives one.
  const appliedRows = rows as Partial<StoredInputRow>[];
  const rule: StoredRuleRow = { id: 'r1', kind: 'target_profit', scope: 'product', catalog_id: null, product_id: w.pid, scope_id: '', state: 'ACTIVE', amount_usd: '2', amount_iqd: null, version: 1, source: 'OWNER', legacy_amount_iqd: null, legacy_usd_iqd_rate: null, legacy_result_id: null, updated_at: '' };
  const again = planEstimateInputs({ ...input, inputs: appliedRows, product_rule: rule, applied: p.applied_json });
  assert.deepEqual(again.wire, { method: 'cost', cost: { inputs: [] } });
  const corrected = appliedRows.map((r) => (r.scope === 'base' ? { ...r, additional_cost_iqd: 1500 } : r));
  const third = planEstimateInputs({ ...input, inputs: corrected, product_rule: rule, applied: p.applied_json, type: typeOf({ additional_cost_iqd: 600 }) });
  assert.deepEqual(third.wire, { method: 'cost', cost: { inputs: [] } }, 'the owner’s extra cost stands against a new type figure');
  assert.deepEqual(flagOf(third, 'EST_OWNER_EDITED')?.fields, ['additional_cost_iqd']);
});
