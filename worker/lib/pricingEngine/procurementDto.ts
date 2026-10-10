/**
 * THE ALLOWLIST DTOs OF THE PROCUREMENT CARD'S PRICING AND THE OWNER'S RULES
 * (USD design §5, §6.3, §9). Built field by field — never a spread of a row or
 * of an engine result — and answered to the verified owner alone, behind the
 * pricing door, `private, no-store`. Every money, rate or measure key is in
 * FINANCIAL_FIELDS (both copies); every other key new here is classified in
 * tests/procurementPricingKeys (via tests/financialFieldsUnion.test.ts).
 */
import type { PricingRates } from './rates';
import type { LineSummary, PricedModel, ProductPreview } from './procurementPreview';
import type { PurchaseLineForPricing } from './fromPurchase';
import { INPUT_FIELD_NAMES, type InputFields, type StoredRuleRow } from './store';
import { ruleDto } from './dto';

export function summaryDto(s: LineSummary) {
  return {
    state: s.state,
    issue_codes: [...s.issue_codes],
    shipping_profile: s.shipping_profile,
    profile_source: s.profile_source,
    engine_priced: s.engine_priced,
    sells_direct: s.sells_direct,
    option_id: s.option_id,
    rule_level: s.rule_level,
    minimum_target_profit_usd: s.minimum_target_profit_usd,
    target_profit_iqd: s.target_profit_iqd,
    target_profit_cents: s.target_profit_cents,
    current_total_cost_cents: s.current_total_cost_cents,
    final_price_cents: s.final_price_cents,
    preorder_base_iqd: s.preorder_base_iqd,
    direct_sale_extra_iqd: s.direct_sale_extra_iqd,
    direct_sale_price_iqd: s.direct_sale_price_iqd,
    rounding_added_iqd: s.rounding_added_iqd,
    supplier_original_amount: s.supplier_original_amount,
    supplier_original_currency: s.supplier_original_currency,
    iqd_converted: s.iqd_converted
      ? {
          original_input_amount: s.iqd_converted.original_input_amount,
          conversion_rate_snapshot: s.iqd_converted.conversion_rate_snapshot,
          converted_at: s.iqd_converted.converted_at,
        }
      : null,
    cross_rate: s.cross_rate,
    supplier_cost_usd: s.supplier_cost_usd,
    supplier_cost_cents: s.supplier_cost_cents,
    basis: s.basis,
    effective_weight_g: s.effective_weight_g,
    effective_cbm: s.effective_cbm,
    shipping_rate: s.shipping_rate,
    shipping_cost_iqd: s.shipping_cost_iqd,
    shipping_cost_usd: s.shipping_cost_usd,
    shipping_cost_cents: s.shipping_cost_cents,
    additional_cost_iqd: s.additional_cost_iqd,
    additional_cost_usd: s.additional_cost_usd,
    additional_cost_cents: s.additional_cost_cents,
    excluded_charges: [...s.excluded_charges],
    current_total_cost_usd: s.current_total_cost_usd,
    final_price_usd: s.final_price_usd,
    usd_iqd_rate: s.usd_iqd_rate,
    document_rate: s.document_rate,
    store_price_iqd: s.store_price_iqd,
  };
}

export function lineDto(line: PurchaseLineForPricing, s: LineSummary) {
  return {
    index: line.index,
    line_id: line.line_id,
    key: line.key,
    product_id: line.product_id,
    pricing_summary: summaryDto(s),
  };
}

const fieldValue = (row: Partial<InputFields> | null | undefined, k: keyof InputFields) => (row ? (row[k] ?? null) : null);

/** The current minimum profits of a product at its own levels (product, option), for the card's field. */
export function minimumProfitsDto(productId: string, rules: readonly StoredRuleRow[]) {
  return rules
    .filter((r) => r.product_id === productId && r.kind === 'target_profit' && (r.scope === 'product' || r.scope === 'option'))
    .map((r) => ({
      scope: r.scope,
      scope_id: r.scope_id,
      state: r.state,
      source: r.source,
      minimum_target_profit_usd: r.amount_usd ?? null,
      target_profit_iqd: r.amount_usd ? null : (r.amount_iqd ?? null),
    }));
}

/**
 * The current Direct Sale Extras of a product at the card's levels (product,
 * option), for the review's field (owner request 2026-10-10): its placeholder,
 * and which models' own rows are BLOCKED (a legacy answer-B review), so the
 * product's typed value also lands on them. Named by kind, never `amount_iqd`.
 */
export function directSaleExtrasDto(productId: string, rules: readonly StoredRuleRow[]) {
  return rules
    .filter((r) => r.product_id === productId && r.kind === 'direct_sale_extra' && (r.scope === 'product' || r.scope === 'option'))
    .map((r) => ({
      scope: r.scope,
      scope_id: r.scope_id,
      state: r.state,
      source: r.source,
      direct_sale_extra_iqd: r.state === 'ACTIVE' ? (r.amount_iqd ?? null) : null,
    }));
}

/**
 * Owner decision 8's six figures per model × channel (the current replacement
 * cost, the minimum profit, the new pre-order price, the Direct Sale Extra,
 * the new direct price, old → new), field by field.
 */
export function previewRowsDto(models: readonly PricedModel[]) {
  return models.flatMap((m) =>
    m.channels
      .filter((c) => c.ok)
      .map((c) => {
        const price = m.result?.channels.find((x) => x.channel === c.channel) ?? null;
        return {
          option_id: m.option_id,
          // FX-7: the unit's key and colour (a model's own key, no colour, when priced per model).
          combo_key: m.combo_key,
          color_id: m.color_id,
          ...m.names,
          channel: c.channel,
          today_prepaid_iqd: c.prepaid_iqd,
          today_cod_iqd: c.cod_iqd,
          cod_priced_as_direct: c.cod_as_direct,
          computed_price_iqd: price?.computed_price_iqd ?? null,
          change_iqd: price && c.prepaid_iqd !== null ? price.computed_price_iqd - c.prepaid_iqd : null,
          replacement_cost_iqd: price?.replacement_cost_iqd ?? null,
          target_profit_usd: price?.target_profit_usd ?? null,
          target_profit_iqd: price?.target_profit_iqd ?? null,
          direct_sale_extra_iqd: price?.direct_sale_extra_iqd ?? null,
          preorder_base_iqd: price?.preorder_base_iqd ?? null,
          issue_codes: m.result ? [...new Set(m.result.issues.filter((i) => i.severity === 'error' && i.channel === c.channel).map((i) => i.code))].sort() : [],
        };
      })
  );
}

export function productPreviewDto(p: ProductPreview, extra: { applied?: boolean; cancelled_source?: boolean; rules: readonly StoredRuleRow[] }) {
  return {
    product_id: p.product_id,
    label: p.label,
    mode: p.mode,
    feeds: p.feeds,
    eligible: p.eligible,
    reason: p.reason,
    use_purchase: p.use_purchase,
    prefer_purchase_values: p.prefer_purchase_values,
    preview_hash: p.preview_hash,
    applied: extra.applied ?? false,
    cancelled_source: extra.cancelled_source ?? false,
    entries: p.derived.entries.map((e) => ({
      scope: e.write.scope,
      scope_id: e.write.scope_id,
      narrow: e.narrow,
      line_ids: [...e.line_ids],
      kept_higher: [...e.kept_higher],
      changes: Object.fromEntries(
        INPUT_FIELD_NAMES.filter((k) => k in e.write.set).map((k) => [k, { before: fieldValue(e.write.existing, k), after: e.write.set[k] ?? null }])
      ),
    })),
    proposals: p.derived.proposals.map((x) => ({ scope: x.scope, scope_id: x.scope_id, shipping_profile: x.shipping_profile })),
    shadowed: p.derived.shadowed.map((x) => ({ scope: x.scope, scope_id: x.scope_id, field: x.field })),
    rows: previewRowsDto(p.models),
    missing_codes: [...p.missing_codes],
    cod_priced_as_direct: p.cod_as_direct,
    minimum_profits: minimumProfitsDto(p.product_id, extra.rules),
    direct_sale_extras: directSaleExtrasDto(p.product_id, extra.rules),
    extra_suggestions: p.extra_suggestions.map((x) => ({ option_id: x.option_id, direct_sale_extra_iqd: x.value_iqd })),
  };
}

export function ratesHeadDto(rates: PricingRates | null) {
  return {
    usd_iqd_rate: rates?.usd_iqd ?? null,
    review_pending: rates ? Object.values(rates.review_pending).some(Boolean) : false,
    derived_stale: rates?.derived_stale ?? false,
  };
}

/** A product's stored rules, by kind (never `amount_iqd`), and its counter for the next write's fence. */
export function storedRulesDto(productId: string, rules: readonly StoredRuleRow[], inputsSeq: number) {
  return {
    success: true as const,
    product_id: productId,
    inputs_seq: inputsSeq,
    rules: rules.filter((r) => r.product_id === productId).map((r) => ruleDto(r)),
  };
}
