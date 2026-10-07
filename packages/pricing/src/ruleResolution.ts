/**
 * MOST-SPECIFIC-WINS RULE RESOLUTION for the two owner rules of the engine:
 * the fixed IQD target profit and the direct-sale premium (owner decisions 3 and
 * 4; master plan v2 §2.3, C34, C40).
 *
 * Walk, most specific first, one scope at a time:
 *
 *     sku > color > option > product > category (nearest ancestor first) > global
 *
 * - `INHERIT` is treated as absent: the walk goes on to the next scope.
 * - `BLOCKED` STOPS the walk: the SKU gets TARGET_PROFIT_BLOCKED (or
 *   DIRECT_PREMIUM_BLOCKED) and no price. A less specific rule never stands in
 *   for one the owner (or the legacy migration) put on hold.
 * - A tie inside one scope (two option values of one SKU, in different groups,
 *   each carrying a rule) takes the MAXIMUM amount and reports RULE_TIE, so a
 *   tie can never lower profit. A BLOCKED rule in a tied scope wins over the
 *   ACTIVE ones (fail closed).
 * - Category rules match only the ancestors of the product's pinned pricing
 *   category (`product_pricing_state.rule_catalog_id`, [C2-A4]), nearest first.
 * - Nothing at any scope → TARGET_PROFIT_MISSING / DIRECT_PREMIUM_MISSING. There
 *   is no invented default ("ولا أريد اختراع نسبة ربح عامة").
 *
 * An ACTIVE row whose amount the 0179 CHECKs would refuse (a target ≤ 0, a
 * negative or fractional amount) is treated as BLOCKED, never skipped: skipping
 * it would silently fall back to a less specific, possibly lower, rule.
 *
 * Pure: the caller passes every rule that could apply (global, the ancestors'
 * category rules, and the product's own rules) — see `loadPricingContext` /
 * `loadProductSnapshot` (R1).
 *
 * The SKU's combo key is DERIVED here from its option values and colour
 * (`skuComboKey`), so a SKU rule can never match on a key that disagrees with the
 * selection it is resolved for.
 */
import { skuComboKey } from './skuChannel';

export type PricingRuleKind = 'target_profit' | 'direct_premium';
export type PricingRuleScope = 'global' | 'category' | 'product' | 'option' | 'color' | 'sku';
export type PricingRuleState = 'ACTIVE' | 'BLOCKED' | 'INHERIT';
export type PricingRuleSource = 'OWNER' | 'LEGACY_MIGRATION';

/** The resolution order, most specific first. */
export const RULE_SCOPE_ORDER: readonly PricingRuleScope[] = ['sku', 'color', 'option', 'product', 'category', 'global'];

/** Upper bound of a rule amount (0179 `amount_iqd BETWEEN 0 AND 1000000000`). */
export const MAX_RULE_AMOUNT_IQD = 1_000_000_000;

/** A `pricing_rules` row (0179), as the engine reads it. */
export interface PricingRuleRow {
  id: string;
  kind: PricingRuleKind;
  scope: PricingRuleScope;
  catalog_id: string | null;
  product_id: string | null;
  scope_id: string;
  state: PricingRuleState;
  amount_iqd: number | null;
  version: number;
  source?: PricingRuleSource;
}

/** The SKU a rule is resolved for (no option and no colour: the product itself). */
export interface RuleTarget {
  product_id: string;
  /** Optional cross-check only: the key is always derived from `option_value_ids`
   * and `color_id`; a given key that differs is a programming error (thrown). */
  combo_key?: string;
  option_value_ids: readonly string[];
  color_id: string | null;
  /** `rule_catalog_id` first, then its parents up to the root (nearest first);
   * empty when the product has no pricing category. */
  ancestry: readonly string[];
}

/** Which row decided, for the dependency stamps of `pricing_sku_costs`. */
export interface RuleRef {
  id: string;
  version: number;
  scope: PricingRuleScope;
  scope_id: string;
  catalog_id: string | null;
  source?: PricingRuleSource;
}

export type RuleResolution =
  | {
      status: 'active';
      kind: PricingRuleKind;
      amount_iqd: number;
      /** The deciding row: the highest amount of its scope. */
      rule: RuleRef;
      /** More than one ACTIVE rule decided at the same scope (RULE_TIE). */
      tie: boolean;
      /** Every ACTIVE row of the deciding scope, highest amount first. */
      candidates: readonly RuleRef[];
    }
  | {
      status: 'blocked';
      kind: PricingRuleKind;
      code: 'TARGET_PROFIT_BLOCKED' | 'DIRECT_PREMIUM_BLOCKED';
      rule: RuleRef;
    }
  | {
      status: 'missing';
      kind: PricingRuleKind;
      code: 'TARGET_PROFIT_MISSING' | 'DIRECT_PREMIUM_MISSING';
    };

const refOf = (row: PricingRuleRow): RuleRef => ({
  id: row.id,
  version: row.version,
  scope: row.scope,
  scope_id: row.scope_id,
  catalog_id: row.catalog_id,
  ...(row.source ? { source: row.source } : {}),
});

/** A valid ACTIVE amount: target > 0, premium ≥ 0, whole IQD, within the CHECK bound. */
export function isValidRuleAmount(kind: PricingRuleKind, amount: unknown): amount is number {
  return (
    typeof amount === 'number' &&
    Number.isSafeInteger(amount) &&
    amount <= MAX_RULE_AMOUNT_IQD &&
    (kind === 'target_profit' ? amount > 0 : amount >= 0)
  );
}

/** The rows of one scope (or one category ancestor) that address this SKU. */
function rowsAt(
  rules: readonly PricingRuleRow[],
  kind: PricingRuleKind,
  scope: PricingRuleScope,
  target: RuleTarget,
  comboKey: string,
  catalogId?: string
): PricingRuleRow[] {
  const options = new Set(target.option_value_ids.filter(Boolean));
  return rules.filter((r) => {
    if (r.kind !== kind || r.scope !== scope) return false;
    switch (scope) {
      case 'sku':
        return r.product_id === target.product_id && r.scope_id !== '' && r.scope_id === comboKey;
      case 'color':
        return r.product_id === target.product_id && !!target.color_id && r.scope_id === target.color_id;
      case 'option':
        return r.product_id === target.product_id && options.has(r.scope_id);
      case 'product':
        return r.product_id === target.product_id;
      case 'category':
        return r.product_id == null && r.catalog_id != null && r.catalog_id === catalogId;
      case 'global':
        return r.product_id == null && r.catalog_id == null;
    }
  });
}

/**
 * The decision of one scope, or null when nothing there applies (no row, or
 * INHERIT only) and the walk continues.
 */
function decide(kind: PricingRuleKind, rows: readonly PricingRuleRow[]): RuleResolution | null {
  const live = rows.filter((r) => r.state !== 'INHERIT');
  if (!live.length) return null;
  const blocked = live.filter((r) => r.state !== 'ACTIVE' || !isValidRuleAmount(kind, r.amount_iqd));
  if (blocked.length) {
    const first = [...blocked].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
    return {
      status: 'blocked',
      kind,
      code: kind === 'target_profit' ? 'TARGET_PROFIT_BLOCKED' : 'DIRECT_PREMIUM_BLOCKED',
      rule: refOf(first),
    };
  }
  // Highest amount first; equal amounts in id order, so the deciding row is deterministic.
  const ranked = [...live].sort((a, b) =>
    (b.amount_iqd as number) - (a.amount_iqd as number) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
  return {
    status: 'active',
    kind,
    amount_iqd: ranked[0].amount_iqd as number,
    rule: refOf(ranked[0]),
    tie: ranked.length > 1,
    candidates: ranked.map(refOf),
  };
}

/** Resolve one rule kind for one SKU: most specific scope wins (see the file header). */
export function resolveRuleAt(rules: readonly PricingRuleRow[], kind: PricingRuleKind, target: RuleTarget): RuleResolution {
  const comboKey = skuComboKey({ option_value_ids: target.option_value_ids, color_id: target.color_id });
  if (target.combo_key !== undefined && target.combo_key !== comboKey)
    throw new Error(`PRICING_INVARIANT: combo_key ${JSON.stringify(target.combo_key)} is not the selection's ${JSON.stringify(comboKey)}`);
  for (const scope of RULE_SCOPE_ORDER) {
    if (scope === 'category') {
      const seen = new Set<string>();
      for (const catalogId of target.ancestry) {
        if (!catalogId || seen.has(catalogId)) continue;
        seen.add(catalogId);
        const decided = decide(kind, rowsAt(rules, kind, 'category', target, comboKey, catalogId));
        if (decided) return decided;
      }
      continue;
    }
    const decided = decide(kind, rowsAt(rules, kind, scope, target, comboKey));
    if (decided) return decided;
  }
  return { status: 'missing', kind, code: kind === 'target_profit' ? 'TARGET_PROFIT_MISSING' : 'DIRECT_PREMIUM_MISSING' };
}
