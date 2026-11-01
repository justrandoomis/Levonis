/**
 * THE ESTIMATE'S INPUTS OVER THE STORE (docs/SMART_PRICING.md §4.4, §4.5) —
 * the I/O side of packages/pricing/src/estimateInputs.ts.
 *
 * The pure planner (`planEstimateInputs`) decides the supplier
 * representation, the measures, the profile, the extra cost and the minimum
 * profit, and merges them three ways against `applied_wire_json`: a field the
 * estimator last wrote is the estimator's, any other value is the owner's and
 * is kept (EST_OWNER_EDITED). This file hands it what the V2 read holds —
 * each sellable SKU with its model's and colour's own packages (`packagesOf`,
 * DECISIONS row 247), the option groups, the product's own package (a public
 * spec, `products.package_*`), the stored inputs and the product's own minimum
 * profit rule, the scopes the form accepts — and lays the planner's answer
 * back onto the V2 desired set: the input writes the estimator authored carry
 * `source_ref 'estimate:<snapshot id | type>'` (the form's are 'owner').
 *
 * A catalogue price reaches the planner as decimal text in its own currency,
 * exactly as captured or typed; nothing here converts, rounds or infers one
 * (invariants I1, I8).
 */
import type { V2Desired, V2Read } from '../v2/api';
import { sellableSkus } from '../legacy';
import { formScopeIds } from '../productInputs';
import { packagesOf, ruleAt } from '../store';
import type { SkuSupplierPrice } from '../../supplierPrices/store';
import {
  type EstimatePlan,
  type EstimatePlanInput,
  type EstimateSku,
  type EstimateSupplierPrice,
  type EstimateTypeInputs,
} from '@levonis/pricing/estimateInputs';
import type { PreorderRoute } from '@levonis/pricing/skuChannel';
import type { EstimateTypeRow } from './types';

/** The flags a catalogue price carries onto the SKU it prices (the rest are decided elsewhere). */
const NOT_CARRIED = new Set(['EST_NO_PRICE', 'EST_MATCH_REVIEW']);

/** Each sellable SKU of a (draft) product as the planner reads it, or null when the grid overflows. */
export function estimateSkusOf(read: Pick<V2Read, 'loaded'>): EstimateSku[] | null {
  const { doc, view } = read.loaded;
  const grid = sellableSkus(doc, view);
  if (grid.overflow) return null;
  const packages = packagesOf(doc);
  return grid.skus.map((s) => {
    const color = s.color?.id ?? null;
    return { combo_key: s.combo_key, option_value_ids: [...s.option_value_ids], color_id: color, packaged: packages(s.option_value_ids, color) };
  });
}

/** WP5's price of one SKU as the planner takes it, or null (no price). */
export function plannerPriceOf(p: SkuSupplierPrice | undefined): EstimateSupplierPrice | null {
  if (!p || p.price_source === 'none' || !p.amount || !p.currency) return null;
  return {
    amount: p.amount,
    currency: p.currency,
    source: p.price_source,
    ref: p.snapshot_id,
    flags: p.flags.filter((f) => !NOT_CARRIED.has(f)),
  };
}

/** The type's figures with the product's route (its override applied). */
export function typeInputsOf(type: EstimateTypeRow, route: PreorderRoute): EstimateTypeInputs {
  return {
    key: type.key,
    route,
    default_weight_g: type.default_weight_g,
    default_length_mm: type.default_length_mm,
    default_width_mm: type.default_width_mm,
    default_height_mm: type.default_height_mm,
    default_cbm: type.default_cbm,
    additional_cost_iqd: type.additional_cost_iqd,
    min_profit_usd: type.min_profit_usd,
  };
}

/** Everything the planner reads for one product, from the V2 read of the document the apply would leave. */
export function planInputOf(
  read: V2Read,
  skus: readonly EstimateSku[],
  type: EstimateTypeInputs,
  prices: ReadonlyMap<string, SkuSupplierPrice>,
  applied: string | null
): EstimatePlanInput {
  const priced = new Map<string, EstimateSupplierPrice>();
  for (const s of skus) {
    const p = plannerPriceOf(prices.get(s.combo_key));
    if (p) priced.set(s.combo_key, p);
  }
  const ids = formScopeIds(read.loaded);
  const rule = ruleAt(read.stored.rules, read.loaded.id, 'target_profit', 'product', '');
  return {
    skus,
    prices: priced,
    option_groups: new Map((read.loaded.view?.values ?? []).map((v) => [v.id, v.group_id] as const)),
    type,
    product_package: read.loaded.doc.dimensions ?? null,
    inputs: read.stored.inputs,
    product_rule: rule ? { state: rule.state, amount_usd: rule.amount_usd ?? null, amount_iqd: rule.amount_iqd ?? null } : null,
    applied,
    scopes: { option: ids.option, ...(ids.color ? { color: ids.color } : {}), ...(ids.sku ? { sku: ids.sku } : {}) },
  };
}

/** The wire the planner built, as the V2 API's own parser takes it (`parseV2Wire`). */
export const wireBodyOf = (plan: EstimatePlan): Record<string, unknown> => ({
  method: plan.wire.method,
  cost: { inputs: plan.wire.cost.inputs, ...(plan.wire.cost.minimum_profit !== undefined ? { minimum_profit: plan.wire.cost.minimum_profit } : {}) },
});

/**
 * The desired set with the estimator's provenance (§4.4 «Origin»): each input write at a scope the plan wrote
 * carries its `source_ref` ('estimate:<snapshot id | type>'); every other write keeps its own (a purchase
 * fold's 'purchase'). The preview hash binds scopes and values, never a source_ref, so it is unchanged.
 */
export function withEstimateRefs(desired: V2Desired, plan: EstimatePlan): V2Desired {
  const refs = new Map(plan.source_refs.map((r) => [`${r.scope}\u0000${r.scope === 'base' ? '' : r.scope_id}`, r.source_ref] as const));
  return {
    ...desired,
    inputWrites: desired.inputWrites.map((w) => {
      const ref = refs.get(`${w.scope}\u0000${w.scope === 'base' ? '' : w.scope_id}`);
      return ref && w.source_ref === 'owner' ? { ...w, source_ref: ref } : w;
    }),
  };
}
