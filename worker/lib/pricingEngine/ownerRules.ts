/**
 * THE OWNER'S RULES: the minimum profit in USD and the Direct Sale Extra, per
 * product and per option (USD design §4; owner decisions 3, 4, 7), and the
 * acceptance of the migrated values (§4.3; FX plan §10 step 2).
 *
 * Validation (in the route, mirrored by the 0181 CHECKs):
 *   - minimum profit: canonical USD text, ≤ 2 decimals, 0 < x ≤ 100,000;
 *     Arabic-Indic digits and a decimal comma normalised; empty = INHERIT;
 *     never a dinar amount (a dinar minimum exists only as a migrated row);
 *   - Direct Sale Extra: whole dinars ≥ 0 on the 1,000 step, never USD;
 *     empty = INHERIT;
 *   - levels: product, option, and — on a database with the SKU rung (0183,
 *     FX-7) — colour and SKU (an exact combination of the product's values and
 *     colour); empty = inherit, walking SKU → colour → option → product. Global
 *     and category are refused — there is no invented default.
 * Refusals name the FIELD, never the value (UNKNOWN_FIELD,
 * PRICING_INPUT_INVALID, DIRECT_SALE_EXTRA_NOT_ON_STEP).
 */
import { HttpError } from '../http';
import { serverMessage } from '@levonis/contracts/costRefusals';
import { canonicalUsdRuleAmount, type PricingRuleRow } from '@levonis/pricing/ruleResolution';
import { ROUNDING_STEP_IQD } from '@levonis/pricing/costToPrice';
import { strictBody } from '../fx/ownerActs';
import { inputInvalid } from './whatIf';
import { ruleAt, type ProductPricingData, type ProductRuleScope, type RuleWrite } from './store';

const MAX_RULES_PER_WRITE = 60;

/**
 * The ids each level may name for one product: its active models, and — only
 * with the SKU rung (0183) — its colours and its colour/variant SKUs. Absent
 * colour and SKU sets refuse those levels exactly as before FX-7.
 */
export interface PricingScopeIds {
  option: ReadonlySet<string>;
  color?: ReadonlySet<string>;
  sku?: ReadonlySet<string>;
}

export const scopeIdsOf = (ids: ReadonlySet<string> | PricingScopeIds): PricingScopeIds =>
  ids instanceof Set ? { option: ids } : (ids as PricingScopeIds);

/** Parse `PUT /products/:id/rules` → the rule writes (absent targets are untouched). */
export function parseRuleWrites(
  body: Record<string, unknown>,
  productId: string,
  scopeIds: ReadonlySet<string> | PricingScopeIds,
  stored: ProductPricingData,
  opts: { max?: number } = {}
): RuleWrite[] {
  const list = body.rules;
  if (!Array.isArray(list) || list.length < 1 || list.length > (opts.max ?? MAX_RULES_PER_WRITE)) throw inputInvalid('rules');
  const ids = scopeIdsOf(scopeIds);
  const seen = new Set<string>();
  return list.map((raw, i) => {
    const r = strictBody(raw, ['kind', 'scope', 'scope_id', 'amount_usd', 'amount_iqd']);
    const kind = r.kind;
    if (kind !== 'target_profit' && kind !== 'direct_sale_extra') throw inputInvalid(`rules[${i}].kind`);
    const scope = r.scope as ProductRuleScope;
    const levels: Record<string, ReadonlySet<string> | undefined> = { option: ids.option, color: ids.color, sku: ids.sku };
    if (scope !== 'product' && !levels[scope]) throw inputInvalid(`rules[${i}].scope`);
    const scopeId = scope === 'product' ? '' : typeof r.scope_id === 'string' ? r.scope_id : '';
    if (scope !== 'product' && !levels[scope]!.has(scopeId)) throw inputInvalid(`rules[${i}].scope_id`);
    if (scope === 'product' && r.scope_id !== undefined && r.scope_id !== null && r.scope_id !== '') throw inputInvalid(`rules[${i}].scope_id`);
    const key = `${kind}:${scope}:${scopeId}`;
    if (seen.has(key)) throw inputInvalid(`rules[${i}]`);
    seen.add(key);
    const existing = ruleAt(stored.rules, productId, kind, scope, scopeId);
    const inherit = { state: 'INHERIT' as const, amount_usd: null, amount_iqd: null, source: 'OWNER' as const, legacy_result_id: null };
    if (kind === 'target_profit') {
      if (r.amount_iqd !== undefined && r.amount_iqd !== null) throw inputInvalid(`rules[${i}].amount_iqd`);
      if (r.amount_usd === undefined || r.amount_usd === null || r.amount_usd === '') return { kind, scope, scope_id: scopeId, existing, next: inherit };
      const usd = typeof r.amount_usd === 'string' ? canonicalUsdRuleAmount(r.amount_usd) : null;
      if (usd === null) throw inputInvalid('minimum_target_profit_usd');
      return { kind, scope, scope_id: scopeId, existing, next: { state: 'ACTIVE' as const, amount_usd: usd, amount_iqd: null, source: 'OWNER' as const, legacy_result_id: null } };
    }
    if (r.amount_usd !== undefined && r.amount_usd !== null) throw inputInvalid(`rules[${i}].amount_usd`);
    if (r.amount_iqd === undefined || r.amount_iqd === null || r.amount_iqd === '') return { kind, scope, scope_id: scopeId, existing, next: inherit };
    const iqd = r.amount_iqd;
    if (typeof iqd !== 'number' || !Number.isSafeInteger(iqd) || iqd < 0 || iqd > 1_000_000_000) throw inputInvalid('direct_sale_extra_iqd');
    if (iqd % ROUNDING_STEP_IQD !== 0) throw new HttpError(400, serverMessage('DIRECT_SALE_EXTRA_NOT_ON_STEP'), 'DIRECT_SALE_EXTRA_NOT_ON_STEP', { field: 'direct_sale_extra_iqd' });
    return { kind, scope, scope_id: scopeId, existing, next: { state: 'ACTIVE' as const, amount_iqd: iqd, amount_usd: null, source: 'OWNER' as const, legacy_result_id: null } };
  });
}

/**
 * «قبول القيم المرحّلة» (§4.3): the minimum profit and Direct Sale Extra the old
 * prices carry (P1's answer B placement, `legacyTargets.ts`), stored as
 * LEGACY_MIGRATION rows — the dinar amount as is (owner question Q2's default:
 * converted to USD at the adopting save). A held value stays a BLOCKED marker.
 * The owner's own rows are never overwritten: a target the owner set is left
 * as it is. A Direct Sale Extra off the 1,000 step cannot be stored (0181
 * CHECK) and is placed as BLOCKED, for the owner to type.
 */
export function legacyAcceptWrites(productId: string, placed: readonly PricingRuleRow[], stored: ProductPricingData, legacyResultId: string): RuleWrite[] {
  const out: RuleWrite[] = [];
  for (const row of placed) {
    if (row.product_id !== productId || (row.scope !== 'product' && row.scope !== 'option')) continue;
    const scope = row.scope;
    const existing = ruleAt(stored.rules, productId, row.kind, scope, row.scope_id);
    if (existing && existing.source === 'OWNER') continue;
    const onStep = row.kind !== 'direct_sale_extra' || (typeof row.amount_iqd === 'number' && row.amount_iqd % ROUNDING_STEP_IQD === 0);
    const active = row.state === 'ACTIVE' && typeof row.amount_iqd === 'number' && onStep && (row.kind === 'direct_sale_extra' ? row.amount_iqd >= 0 : row.amount_iqd > 0);
    out.push({
      kind: row.kind,
      scope,
      scope_id: scope === 'product' ? '' : row.scope_id,
      existing,
      next: active
        ? { state: 'ACTIVE', amount_iqd: row.amount_iqd as number, amount_usd: null, source: 'LEGACY_MIGRATION', legacy_result_id: legacyResultId }
        : { state: 'BLOCKED', amount_iqd: null, amount_usd: null, source: 'LEGACY_MIGRATION', legacy_result_id: legacyResultId },
    });
  }
  return out;
}
