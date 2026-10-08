/**
 * THE ALLOWLIST DTOs OF «التسعير والشحن» P1 (MVP plan §6 P1; E4's DTO rules).
 *
 * Built field by field from the evaluation — never a spread of a row or of an
 * engine result — so a key reaches the owner only because it is written here.
 * The router answers them to the verified owner alone (`requireCostRead`),
 * `private, no-store`.
 *
 * Naming contract (owner decision 2, master plan v2 §2.3):
 *   - every money, rate or measure key is in FINANCIAL_FIELDS (both copies),
 *     and every other key new to this router is in PRIVATE_NON_FINANCIAL with
 *     its reason (tests/financialFieldsUnion.test.ts walks these answers);
 *   - a rule is named by its kind — `{kind: 'target_profit', target_profit_iqd}`
 *     or `{kind: 'direct_premium', direct_premium_iqd}` — never `amount_iqd`;
 *   - decimals stay exact TEXT; whole IQD stay integers.
 */
import type { PricingRuleRow } from '@levonis/pricing/ruleResolution';
import { PRICING_MIGRATION_STATUSES, type PricingMigrationStatus } from '@levonis/contracts/pricingMigrationLabels';
import { PROFILE_BASIS, SHIPPING_PROFILES } from '@levonis/pricing/skuChannel';
import { SUPPLIER_CURRENCIES } from '@levonis/pricing/costToPrice';
import type { LegacyCandidate, LegacyReason } from '@levonis/pricing/legacyTargets';
import type { ChannelToday } from './legacy';
import type { ModelEvaluation, ProductEvaluation } from './compute';
import type { RateReference } from './load';
import type { WhatIfResult } from './whatIf';

export const OVERVIEW_PAGE_SIZE = 20;

const names = (src: { name_ar?: string; name_en?: string; name_ckb?: string } | null | undefined) => ({
  name_ar: src?.name_ar ?? '',
  name_en: src?.name_en ?? '',
  name_ckb: src?.name_ckb ?? '',
});

/** One product's line in the overview, and the head of its detail page. */
export function productSummaryDto(p: ProductEvaluation) {
  return {
    id: p.id,
    slug: p.doc.slug,
    ...names(p.doc),
    status: p.doc.status,
    migration_status: p.status,
    reason_codes: [...p.reason_codes],
    info_codes: [...p.info_codes],
    channel_mix: p.mix,
    routes: [...p.routes],
    model_count: p.models.length,
    typed_member_prices: p.typed_member_prices,
  };
}

/** The rate reference, by currency and by profile; never confirmed in P1. */
export function ratesDto(ref: RateReference) {
  return {
    fx_rates: SUPPLIER_CURRENCIES.map((currency) => ({
      currency,
      rate_iqd: ref.fx[currency].rate,
      confirmed: false,
      rate_origin: ref.fx[currency].origin,
    })),
    shipping_rates: SHIPPING_PROFILES.map((profile) => ({
      profile,
      basis: PROFILE_BASIS[profile],
      rate_iqd: ref.shipping[profile].rate,
      confirmed: false,
      rate_origin: ref.shipping[profile].origin,
    })),
  };
}

export function overviewDto(all: readonly ProductEvaluation[], page: number, typedMemberProducts: number) {
  const total = all.length;
  const pages = Math.max(1, Math.ceil(total / OVERVIEW_PAGE_SIZE));
  const current = Math.min(Math.max(1, page), pages);
  const counts = new Map<PricingMigrationStatus, number>(PRICING_MIGRATION_STATUSES.map((s) => [s, 0]));
  for (const p of all) counts.set(p.status, (counts.get(p.status) ?? 0) + 1);
  return {
    success: true as const,
    preview_only: true as const,
    page: current,
    page_size: OVERVIEW_PAGE_SIZE,
    pages,
    total,
    status_counts: PRICING_MIGRATION_STATUSES.map((s) => ({ migration_status: s, count: counts.get(s) ?? 0 })),
    typed_member_price_products: typedMemberProducts,
    products: all.slice((current - 1) * OVERVIEW_PAGE_SIZE, current * OVERVIEW_PAGE_SIZE).map(productSummaryDto),
  };
}

const reasonCodes = (rs: readonly LegacyReason[]) => rs.map((r) => r.code);

/** Reasons with their figures (`ROUTE_FEE_INCLUDED` route and fee, the off-step premium). */
const reasonsWithFigures = (rs: readonly LegacyReason[]) =>
  rs
    .filter((r) => r.route !== undefined || r.iqd !== undefined)
    .map((r) => ({ code: r.code, route: r.route ?? null, legacy_reason_iqd: r.iqd ?? null }));

function channelDto(c: ChannelToday) {
  return {
    channel: c.channel,
    route: c.route,
    today_item_iqd: c.item_iqd,
    today_fee_iqd: c.fee_iqd,
    today_prepaid_iqd: c.prepaid_iqd,
    today_cod_iqd: c.cod_iqd,
    cod_priced_as_direct: c.cod_as_direct,
    landed_cost_iqd: c.cost_iqd,
    price_rung: c.price_rung,
    cost_rung: c.cost_rung,
    resolver_errors: [...c.errors],
  };
}

const targetCandidates = (cs: readonly LegacyCandidate[]) => cs.map((c) => ({ kind: c.kind, route: c.route, target_profit_iqd: c.value_iqd }));
const premiumCandidates = (cs: readonly LegacyCandidate[]) => cs.map((c) => ({ kind: c.kind, route: c.route, direct_premium_iqd: c.value_iqd }));

function modelDto(m: ModelEvaluation) {
  const { target, premium } = m.legacy;
  return {
    option_id: m.option_id,
    ...names(m.option),
    channel_mix: m.legacy.mix,
    base_route: m.legacy.base_route,
    channels: m.channels.map(channelDto),
    target: {
      migration_state: target.state,
      target_profit_iqd: target.value_iqd,
      reason_codes: reasonCodes(target.reasons),
      reason_figures: reasonsWithFigures(target.reasons),
      candidates: targetCandidates(target.candidates),
    },
    premium: {
      migration_state: premium.state,
      direct_premium_iqd: premium.value_iqd,
      reason_codes: reasonCodes(premium.reasons),
      reason_figures: reasonsWithFigures(premium.reasons),
      candidates: premiumCandidates(premium.candidates),
    },
    roundtrip_ok: m.legacy.roundtrip_ok,
    suggested_measures: {
      shipping_weight_g: m.measures.weight_g,
      weight_scope: m.measures.weight_scope,
      shipping_length_mm: m.measures.box?.length_mm ?? null,
      shipping_width_mm: m.measures.box?.width_mm ?? null,
      shipping_height_mm: m.measures.box?.height_mm ?? null,
      box_scope: m.measures.box_scope,
      calculated_cbm: m.measures.calculated_cbm,
    },
    missing: m.missing.map((x) => ({ channel: x.channel, code: x.code })),
  };
}

/** A placed rule, named by its kind (never `amount_iqd`). */
export function ruleDto(r: PricingRuleRow) {
  const base = { scope: r.scope, scope_id: r.scope_id, state: r.state, source: r.source ?? 'LEGACY_MIGRATION' };
  return r.kind === 'target_profit'
    ? { kind: 'target_profit' as const, ...base, target_profit_iqd: r.amount_iqd }
    : { kind: 'direct_premium' as const, ...base, direct_premium_iqd: r.amount_iqd };
}

export function productDetailDto(p: ProductEvaluation, ref: RateReference) {
  return {
    success: true as const,
    preview_only: true as const,
    product: productSummaryDto(p),
    models: p.models.map(modelDto),
    legacy_rules: p.rules.map(ruleDto),
    ...ratesDto(ref),
  };
}

export function whatIfDto(r: WhatIfResult) {
  return {
    success: true as const,
    preview_only: true as const,
    inputs: {
      scope: r.scope,
      scope_id: r.request.option_id ?? '',
      supplier_cost: r.request.supplier_cost,
      supplier_currency: r.request.currency,
      additional_cost_iqd: r.request.additional_cost_iqd,
    },
    ...ratesDto(r.rates),
    models: r.models.map((m) => ({
      option_id: m.option_id,
      ...names(m.option),
      channels: m.channels.map((c) => ({
        channel: c.channel,
        today_prepaid_iqd: c.today_prepaid_iqd,
        today_cod_iqd: c.today_cod_iqd,
        computed_price_iqd: c.price?.computed_price_iqd ?? null,
        change_iqd: c.change_iqd,
        replacement_cost_iqd: c.price?.replacement_cost_iqd ?? null,
        replacement_exact: c.price?.replacement_exact ?? null,
        supplier_cost_iqd: c.price?.supplier_cost_iqd ?? null,
        shipping_cost_iqd: c.price?.shipping_cost_iqd ?? null,
        additional_cost_iqd: c.price?.additional_cost_iqd ?? null,
        target_profit_iqd: c.price?.target_profit_iqd ?? null,
        direct_premium_iqd: c.price?.direct_premium_iqd ?? null,
        preorder_base_iqd: c.price?.preorder_base_iqd ?? null,
        rounding_added_iqd: c.price?.rounding_added_iqd ?? null,
        shipping_profile: c.price?.shipping_profile ?? null,
        fx_rate: c.price?.fx_rate ?? null,
        shipping_rate: c.price?.shipping_rate ?? null,
        effective_weight_g: c.price?.effective_weight_g ?? null,
        effective_cbm: c.price?.effective_cbm ?? null,
        issue_codes: [...c.issue_codes],
      })),
    })),
  };
}
