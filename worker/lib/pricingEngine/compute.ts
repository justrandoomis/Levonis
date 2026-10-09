/**
 * ONE PRODUCT, EVALUATED FOR «التسعير والشحن» P1 (MVP plan §6 P1) — read only.
 *
 *   - today's price of every model × channel, prepaid and cash on delivery
 *     (legacy.ts, the cart's own resolver call);
 *   - the minimum profit and the direct-sale premium the old prices carry
 *     (answer B, packages/pricing/src/legacyTargets.ts), and where they would
 *     be placed;
 *   - what the engine would still miss, from E1 itself: `priceSku` run on the
 *     public package measures (suggestions only, C47), the placed values and
 *     the rate reference — so the readiness the owner reads is the engine's,
 *     not a second rule set (master plan v2 check (1)8);
 *   - the preliminary §2.3 status, worst first. P1 stores no supplier cost, so
 *     no product is READY_TO_SWITCH or READY yet.
 */
import { priceSku, resolveSkuInputs, type PricingInputRow, type SkuInputChain, type CentralRates } from '@levonis/pricing/costToPrice';
import { resolveRuleAt, type PricingRuleRow, type RuleTarget } from '@levonis/pricing/ruleResolution';
import { ROUTE_PROFILE, PREORDER_ROUTES, type PreorderRoute, type SkuChannel } from '@levonis/pricing/skuChannel';
import type { LegacyModelResult, LegacySaleMix } from '@levonis/pricing/legacyTargets';
import {
  LEGACY_REASONS,
  isLegacyReasonCode,
  worstMigrationStatus,
  type PricingMigrationStatus,
} from '@levonis/contracts/pricingMigrationLabels';
import type { PricingIssueCode } from '@levonis/contracts/pricingIssues';
import type { OptionV2, PhysicalDimensionOverrides } from '../pricing';
import type { ProductDoc } from '../productModel';
import type { PricingContext } from '../../routes/cart';
import { evaluateLegacy, type ChannelToday, type LegacyEvaluation } from './legacy';
import { centralRatesOf, loadProducts, type LoadedProduct, type RateReference } from './load';

/** The public package measures of one model, as E1 would read them (suggestions, never confirmed). */
export interface SuggestedMeasures {
  weight_g: number | null;
  weight_scope: 'base' | 'option' | null;
  box: { length_mm: number; width_mm: number; height_mm: number } | null;
  box_scope: 'base' | 'option' | null;
  /** L × W × H / 1e9 of the deciding box, exact decimal text. */
  calculated_cbm: string | null;
}

export interface ModelEvaluation {
  option: OptionV2 | null;
  option_id: string;
  channels: ChannelToday[];
  legacy: LegacyModelResult;
  measures: SuggestedMeasures;
  /** E1's error codes per channel (supplier cost included), deduplicated. */
  missing: Array<{ channel: SkuChannel; code: PricingIssueCode }>;
}

export interface ProductEvaluation {
  id: string;
  doc: ProductDoc;
  models: ModelEvaluation[];
  rules: PricingRuleRow[];
  status: PricingMigrationStatus;
  /** Every code that holds the product (sorted, unique): legacy reasons, structure, E1. */
  reason_codes: string[];
  /** Codes that explain a value and hold nothing. */
  info_codes: string[];
  mix: LegacySaleMix;
  routes: PreorderRoute[];
  typed_member_prices: boolean;
}

/** E1 codes a P1 preview expects everywhere (no supplier cost is stored yet; rates are P2's). */
const EXPECTED_IN_P1: ReadonlySet<PricingIssueCode> = new Set<PricingIssueCode>([
  'SUPPLIER_COST_MISSING',
  'SUPPLIER_CURRENCY_MISSING',
  'FX_RATE_MISSING',
  'SHIPPING_RATE_MISSING',
  'FX_RATE_UNCONFIRMED',
  'SHIPPING_RATE_UNCONFIRMED',
]);
/** E1 codes the legacy states already report (a held value is a BLOCKED marker). */
const FROM_LEGACY: ReadonlySet<PricingIssueCode> = new Set<PricingIssueCode>([
  'TARGET_PROFIT_MISSING',
  'TARGET_PROFIT_BLOCKED',
  'DIRECT_PREMIUM_MISSING',
  'DIRECT_PREMIUM_BLOCKED',
  'PREMIUM_NOT_ON_STEP',
]);

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

/** A SOURCE input row from public package fields: the weight, and the box only when complete (atomic, L2-1a). */
function measuresRow(d: PhysicalDimensionOverrides | null | undefined): PricingInputRow {
  const row: PricingInputRow = {};
  if (!d) return row;
  if (positive(d.package_weight_g)) row.shipping_weight_g = d.package_weight_g;
  const [l, w, h] = [d.package_depth_mm, d.package_width_mm, d.package_height_mm];
  if (positive(l) && positive(w) && positive(h)) {
    row.shipping_length_mm = l;
    row.shipping_width_mm = w;
    row.shipping_height_mm = h;
  }
  return row;
}

/**
 * The SOURCE chain of one model: public package measures at product and model
 * level, and the shipping profile a single offered route decides. Supplier
 * cost is the owner's alone and absent until P3 (`override` carries the
 * what-if's).
 */
export function sourceChainOf(doc: ProductDoc, model: { option: OptionV2 | null; channels: ChannelToday[] }, override?: { scope: 'base' | 'option'; row: PricingInputRow }): SkuInputChain {
  const routes = model.channels.filter((c) => c.ok && c.route !== null).map((c) => c.route as PreorderRoute);
  const profile = routes.length === 1 ? ROUTE_PROFILE[routes[0]!] : null;
  const base: PricingInputRow = { ...measuresRow(doc.dimensions) };
  const option: PricingInputRow = { ...measuresRow(model.option) };
  if (profile) (model.option ? option : base).shipping_profile = profile;
  return {
    base: { source: base, override: override?.scope === 'base' ? override.row : null },
    options: model.option
      ? [{ scope_id: model.option.id, source: option, override: override?.scope === 'option' ? override.row : null }]
      : [],
  };
}

/** Where a model's rules are resolved: the model's own option value, or the product itself. */
export function ruleTargetOf(productId: string, optionId: string): RuleTarget {
  return { product_id: productId, option_value_ids: optionId ? [optionId] : [], color_id: null, ancestry: [] };
}

function measuresOf(chain: SkuInputChain): SuggestedMeasures {
  const { inputs } = resolveSkuInputs(chain);
  const scope = (level: string | undefined): 'base' | 'option' | null => (level === 'base' || level === 'option' ? level : null);
  return {
    weight_g: inputs.weight?.value ?? null,
    weight_scope: scope(inputs.weight?.level),
    box: inputs.cbm?.box ? { length_mm: inputs.cbm.box.length_mm, width_mm: inputs.cbm.box.width_mm, height_mm: inputs.cbm.box.height_mm } : null,
    box_scope: inputs.cbm?.box ? scope(inputs.cbm.level) : null,
    calculated_cbm: inputs.cbm?.calculated ?? null,
  };
}

/** E1's verdict on one model with what P1 knows (no supplier cost). */
function missingOf(productId: string, chain: SkuInputChain, channels: SkuChannel[], rules: readonly PricingRuleRow[], optionId: string, rates: CentralRates): ModelEvaluation['missing'] {
  if (!channels.length) return [];
  const at = ruleTargetOf(productId, optionId);
  const result = priceSku({
    chain,
    rates,
    channels,
    target: resolveRuleAt(rules, 'target_profit', at),
    premium: channels.includes('direct_sale') ? resolveRuleAt(rules, 'direct_premium', at) : null,
    allowUnconfirmedRates: true,
  });
  const seen = new Set<string>();
  const out: ModelEvaluation['missing'] = [];
  for (const issue of result.issues) {
    if (issue.severity !== 'error' || !issue.channel) continue;
    const key = `${issue.channel}|${issue.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ channel: issue.channel, code: issue.code });
  }
  return out;
}

function productMix(models: readonly ModelEvaluation[]): LegacySaleMix {
  const mixes = models.map((m) => m.legacy.mix);
  if (mixes.includes('BOTH')) return 'BOTH';
  const d = mixes.includes('DIRECT_ONLY');
  const p = mixes.includes('PREORDER_ONLY');
  return d && p ? 'BOTH' : d ? 'DIRECT_ONLY' : p ? 'PREORDER_ONLY' : 'NOT_SELLABLE';
}

/** Evaluate one loaded product (see the file header). Pure over what was loaded. */
export function evaluateProduct(loaded: LoadedProduct, ctx: PricingContext, reference: RateReference): ProductEvaluation {
  const { doc } = loaded;
  const legacyEval: LegacyEvaluation = evaluateLegacy(loaded.id, doc, loaded.view, ctx);
  const rates = centralRatesOf(reference);
  const rules = legacyEval.legacy.rules;

  const models: ModelEvaluation[] = legacyEval.models.map((m, i) => {
    const chain = sourceChainOf(doc, m);
    const channels = m.channels.filter((c) => c.ok).map((c) => c.channel);
    return {
      option: m.option,
      option_id: m.option_id,
      channels: m.channels,
      legacy: legacyEval.legacy.models[i]!,
      measures: measuresOf(chain),
      missing: missingOf(loaded.id, chain, channels, rules, m.option_id, rates),
    };
  });

  // ---- the codes that hold the product, and the status they give (§2.3, worst first)
  // Every model the store offers is weighed — one whose every channel fails in
  // the resolver too (CHANNEL_NOT_PRICED); only a model offered on no channel
  // at all is left out, unless no model is offered anywhere.
  const offered = models.filter((m) => m.legacy.mix !== 'NOT_SELLABLE' || m.channels.length > 0);
  const considered = offered.length ? offered : models;
  const holding = new Set<string>();
  const info = new Set<string>();
  const statuses: PricingMigrationStatus[] = [];
  const legacyCode = (code: string) => {
    if (!isLegacyReasonCode(code)) return;
    if (LEGACY_REASONS[code].severity === 'info') info.add(code);
    else holding.add(code);
  };
  for (const m of considered) {
    for (const r of [...m.legacy.target.reasons, ...m.legacy.premium.reasons]) legacyCode(r.code);
    // Offered but priced on no channel: its values are held (BLOCKED markers)
    // for the channel setup alone — NEEDS_MANUAL_REVIEW, from the channel check below.
    const unpricedHold = m.legacy.mix === 'NOT_SELLABLE' && m.channels.length > 0;
    if (!unpricedHold && (m.legacy.target.state === 'CONFLICT' || m.legacy.premium.state === 'CONFLICT')) statuses.push('CONFLICT');
    else if (!unpricedHold && (m.legacy.target.state !== 'MIGRATED' || m.legacy.premium.state === 'DIRECT_PREMIUM_REVIEW_REQUIRED')) {
      // A held premium rolls up with the profit (master plan v2 check (1)7).
      statuses.push('TARGET_PROFIT_REVIEW_REQUIRED');
    }
    if (m.channels.some((c) => !c.ok)) {
      holding.add('CHANNEL_NOT_PRICED');
      statuses.push('NEEDS_MANUAL_REVIEW');
    }
    for (const miss of m.missing) {
      if (EXPECTED_IN_P1.has(miss.code) || FROM_LEGACY.has(miss.code)) continue;
      holding.add(miss.code);
      statuses.push('NEEDS_MANUAL_REVIEW');
    }
  }
  if (legacyEval.option_groups > 1) {
    holding.add('OPTION_GROUPS_UNSUPPORTED');
    statuses.push('NEEDS_MANUAL_REVIEW');
  }
  if (legacyEval.colour_pricing) {
    holding.add('COLOR_PRICE_UNSUPPORTED');
    statuses.push('NEEDS_MANUAL_REVIEW');
  }
  if (legacyEval.typed_member_prices) info.add('LEGACY_MEMBER_PRICE_DROPPED');

  const routes = PREORDER_ROUTES.filter((r) => models.some((m) => m.channels.some((c) => c.ok && c.route === r)));
  return {
    id: loaded.id,
    doc,
    models,
    rules,
    status: worstMigrationStatus(statuses, 'WAITING_FOR_SUPPLIER_COST'),
    reason_codes: [...holding].sort(),
    info_codes: [...info].sort(),
    mix: productMix(models),
    routes,
    typed_member_prices: legacyEval.typed_member_prices,
  };
}

/** Evaluate the named products, in the order given; an unknown or composition id is skipped. */
export async function evaluateProducts(
  db: D1Database,
  ids: readonly string[],
  ctx: PricingContext,
  reference: RateReference
): Promise<ProductEvaluation[]> {
  const loaded = await loadProducts(db, ids);
  const out: ProductEvaluation[] = [];
  for (const id of ids) {
    const p = loaded.get(id);
    if (!p || (p.doc.composition ?? '') !== '') continue;
    out.push(evaluateProduct(p, ctx, reference));
  }
  return out;
}
