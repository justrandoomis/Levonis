/**
 * MOST-SPECIFIC-WINS RULE RESOLUTION for the two owner rules of the engine:
 * the minimum target profit and the Direct Sale Extra (owner decisions 3 and
 * 4; master plan v2 §2.3, C34, C40).
 *
 * THE MINIMUM PROFIT CARRIES ITS CURRENCY (owner brief 2026-10-09, USD design
 * §2.2; migration 0181). A `target_profit` row holds exactly one of:
 *   - `amount_usd`: the owner's minimum profit in US dollars — canonical
 *     decimal text, at most two decimals, 0 < x ≤ 100,000 (the 0181 CHECK);
 *   - `amount_iqd`: a whole dinar amount > 0 — the migrated, not yet converted
 *     form (P1 builds it in memory; storage allows it only on a
 *     LEGACY_MIGRATION row).
 * The Direct Sale Extra is always whole dinars on the 1,000 step and never
 * USD. Its exact dinar figure is `amount_usd × U` (`targetProfitExactIqd`),
 * where U is the effective USD/IQD the price is computed at.
 *
 * Walk, most specific first, one scope at a time:
 *
 *     sku > color > option > product > category (nearest ancestor first) > global
 *
 * - `INHERIT` is treated as absent: the walk goes on to the next scope.
 * - `BLOCKED` STOPS the walk: the SKU gets TARGET_PROFIT_BLOCKED (or
 *   DIRECT_SALE_EXTRA_BLOCKED) and no price. A less specific rule never stands in
 *   for one the owner (or the legacy migration) put on hold.
 * - A tie inside one scope (two option values of one SKU, in different groups,
 *   each carrying a rule) takes the MAXIMUM amount and reports RULE_TIE, so a
 *   tie can never lower profit. A BLOCKED rule in a tied scope wins over the
 *   ACTIVE ones (fail closed).
 * - Category rules match only the ancestors of the product's pinned pricing
 *   category (`product_pricing_state.rule_catalog_id`, [C2-A4]), nearest first.
 * - Nothing at any scope → TARGET_PROFIT_MISSING / DIRECT_SALE_EXTRA_MISSING. There
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
import {
  compareProcurementExact,
  mulProcurementExact,
  procurementExact,
  procurementExactText,
  type ProcurementExact,
} from '@levonis/contracts/procurementCost';
import { skuComboKey } from './skuChannel';

export type PricingRuleKind = 'target_profit' | 'direct_sale_extra';
export type PricingRuleScope = 'global' | 'category' | 'product' | 'option' | 'color' | 'sku';
export type PricingRuleState = 'ACTIVE' | 'BLOCKED' | 'INHERIT';
export type PricingRuleSource = 'OWNER' | 'LEGACY_MIGRATION';

/** The resolution order, most specific first. */
export const RULE_SCOPE_ORDER: readonly PricingRuleScope[] = ['sku', 'color', 'option', 'product', 'category', 'global'];

/** Upper bound of a rule amount (0179 `amount_iqd BETWEEN 0 AND 1000000000`). */
export const MAX_RULE_AMOUNT_IQD = 1_000_000_000;

/** Upper bound of a minimum profit in USD (0181 `amount_usd`): × U ≤ 10,000 keeps T×U ≤ 1e9. */
export const MAX_RULE_AMOUNT_USD = 100_000;
/** At most this many decimals in a USD minimum profit (cents). */
export const RULE_USD_PLACES = 2;

/** The 0181 CHECK grammar of `pricing_rules.amount_usd`: digits, at most one '.', 1–2 decimals, ≤ 9 characters. */
const USD_RULE_TEXT = /^[0-9]+(?:\.[0-9]{1,2})?$/;
const MAX_USD_EXACT: ProcurementExact = { num: BigInt(MAX_RULE_AMOUNT_USD), den: 1n };

/**
 * A stored USD minimum profit, exact — or null when the 0181 CHECK would refuse
 * it (not text, more than two decimals, 0, above 100,000). Reads what the
 * database may hold ('120.50' and '120.5' alike); writers store the canonical
 * form (`canonicalUsdRuleAmount`).
 */
export function parseUsdRuleAmount(raw: unknown): ProcurementExact | null {
  if (typeof raw !== 'string' || raw.length > 9 || !USD_RULE_TEXT.test(raw)) return null;
  const exact = procurementExact(raw);
  if (exact.num <= 0n || compareProcurementExact(exact, MAX_USD_EXACT) > 0) return null;
  return exact;
}

/**
 * Arabic-Indic and Eastern Arabic-Indic digits to ASCII; the Arabic decimal
 * separator to '.'; a plain comma to '.' only as a DECIMAL comma (one or two
 * digits after it, at the end) — '1,200' stays unparseable rather than
 * silently becoming 1.2.
 */
function asciiDecimal(text: string): string {
  return text
    .trim()
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/\u066b/g, '.')
    .replace(/^([0-9]+),([0-9]{1,2})$/, '$1.$2');
}

/**
 * The canonical text of a minimum profit the owner typed (USD design §4.1):
 * Arabic-Indic digits and a decimal comma are normalised, leading zeros and
 * trailing fraction zeros dropped ('120.50' → '120.5', '٠٧٫٥' → '7.5'), and
 * the 0181 bounds applied. Null when it is not such an amount; '' and null are
 * the caller's INHERIT, not an amount.
 */
export function canonicalUsdRuleAmount(raw: unknown): string | null {
  let text: string;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null;
    text = String(raw);
  } else if (typeof raw === 'string') text = asciiDecimal(raw);
  else return null;
  const m = /^0*([0-9]+)(?:\.([0-9]*?)0*)?$/.exec(text);
  if (!m || text.endsWith('.') || text.startsWith('.')) return null;
  const whole = m[1].replace(/^0+(?=\d)/, '');
  const fraction = m[2] ?? '';
  const canonical = fraction ? `${whole}.${fraction}` : whole;
  return parseUsdRuleAmount(canonical) ? canonical : null;
}

/** A `pricing_rules` row (0179), as the engine reads it. */
export interface PricingRuleRow {
  id: string;
  kind: PricingRuleKind;
  scope: PricingRuleScope;
  catalog_id: string | null;
  product_id: string | null;
  scope_id: string;
  state: PricingRuleState;
  /** Whole dinars: the Direct Sale Extra, or a migrated (not yet converted) minimum profit. */
  amount_iqd: number | null;
  /** target_profit only: the minimum profit in USD, decimal text (0181). Absent = null. */
  amount_usd?: string | null;
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
      /** The deciding row's whole-dinar amount; null when it is a USD minimum profit. */
      amount_iqd: number | null;
      /** target_profit only: the deciding row's minimum profit in USD (canonical text); null/absent for a dinar amount. */
      amount_usd?: string | null;
      /** The deciding row: the highest amount of its scope (in dinars at U). */
      rule: RuleRef;
      /** More than one ACTIVE rule decided at the same scope (RULE_TIE). */
      tie: boolean;
      /** Every ACTIVE row of the deciding scope, highest amount first. */
      candidates: readonly RuleRef[];
      /** The USD/IQD a tie MIXING a USD and a dinar row was ranked at; null/absent otherwise
       * (a tie of one currency ranks the same at any rate). `priceSku` asserts it prices at it. */
      ranked_at_usd_iqd?: string | null;
    }
  | {
      status: 'blocked';
      kind: PricingRuleKind;
      code: 'TARGET_PROFIT_BLOCKED' | 'DIRECT_SALE_EXTRA_BLOCKED';
      rule: RuleRef;
    }
  | {
      status: 'missing';
      kind: PricingRuleKind;
      code: 'TARGET_PROFIT_MISSING' | 'DIRECT_SALE_EXTRA_MISSING';
    };

const refOf = (row: PricingRuleRow): RuleRef => ({
  id: row.id,
  version: row.version,
  scope: row.scope,
  scope_id: row.scope_id,
  catalog_id: row.catalog_id,
  ...(row.source ? { source: row.source } : {}),
});

/** A valid ACTIVE dinar amount: target > 0, Direct Sale Extra ≥ 0, whole IQD, within the CHECK bound. */
export function isValidRuleAmount(kind: PricingRuleKind, amount: unknown): amount is number {
  return (
    typeof amount === 'number' &&
    Number.isSafeInteger(amount) &&
    amount <= MAX_RULE_AMOUNT_IQD &&
    (kind === 'target_profit' ? amount > 0 : amount >= 0)
  );
}

/**
 * A valid ACTIVE row amount (the 0181 CHECKs): a minimum profit holds EXACTLY
 * one of a USD amount (≤ 2 dp, 0 < x ≤ 100,000) or a whole dinar amount > 0;
 * a Direct Sale Extra holds whole dinars ≥ 0 and never a USD amount.
 */
export function isValidRuleRowAmount(row: Pick<PricingRuleRow, 'kind' | 'amount_iqd' | 'amount_usd'>): boolean {
  const usd = row.amount_usd ?? null;
  if (row.kind !== 'target_profit') return usd === null && isValidRuleAmount(row.kind, row.amount_iqd);
  if (usd !== null) return row.amount_iqd == null && parseUsdRuleAmount(usd) !== null;
  return isValidRuleAmount('target_profit', row.amount_iqd);
}

/** A USD/IQD rate as an exact positive rational, or null (absent, malformed or ≤ 0). */
function usdRateOf(rate: string | null | undefined): ProcurementExact | null {
  if (typeof rate !== 'string' || !/^[0-9]+(?:\.[0-9]+)?$/.test(rate)) return null;
  const exact = procurementExact(rate);
  return exact.num > 0n ? exact : null;
}

/**
 * The EXACT dinar figure of a resolved minimum profit: `amount_usd × U`, or the
 * whole dinar amount. Null when it is a USD amount and U is missing (the
 * caller reports FX_RATE_MISSING {currency: 'USD'}), or the resolution is not
 * active.
 */
export function targetProfitExactIqd(resolution: RuleResolution, usdIqdRate: string | null | undefined): ProcurementExact | null {
  if (resolution.status !== 'active') return null;
  const usd = resolution.amount_usd ?? null;
  if (usd !== null) {
    const amount = parseUsdRuleAmount(usd);
    const u = usdRateOf(usdIqdRate);
    return amount && u ? mulProcurementExact(amount, u) : null;
  }
  return isValidRuleAmount(resolution.kind, resolution.amount_iqd) ? procurementExact(resolution.amount_iqd) : null;
}

/**
 * A row's rank key in a tie: its amount in dinars at U (group 0). Without U a
 * USD amount cannot be compared with dinars, so the USD rows rank FIRST (group
 * 0, by their USD amount — comparable among themselves at any rate) and the
 * dinar rows after them (group 1): fail closed, the price then needs the rate
 * it lacks and is refused, never lowered.
 */
function rankKey(row: PricingRuleRow, u: ProcurementExact | null): { group: 0 | 1; value: ProcurementExact } {
  const usd = row.amount_usd ?? null;
  if (usd !== null) {
    const amount = parseUsdRuleAmount(usd) as ProcurementExact;
    return { group: 0, value: u ? mulProcurementExact(amount, u) : amount };
  }
  return { group: u ? 0 : 1, value: procurementExact(row.amount_iqd as number) };
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
 *
 * A tie ranks by the EXACT dinar figure at U (`amount_usd × U`, or the dinar
 * amount), then by id (USD design §2.2). A USD row with no U to rank it ranks
 * FIRST: the price then needs the rate it lacks and is refused, never lowered.
 */
function decide(kind: PricingRuleKind, rows: readonly PricingRuleRow[], usdIqdRate: string | null): RuleResolution | null {
  const live = rows.filter((r) => r.state !== 'INHERIT');
  if (!live.length) return null;
  const blocked = live.filter((r) => r.state !== 'ACTIVE' || !isValidRuleRowAmount(r));
  if (blocked.length) {
    const first = [...blocked].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
    return {
      status: 'blocked',
      kind,
      code: kind === 'target_profit' ? 'TARGET_PROFIT_BLOCKED' : 'DIRECT_SALE_EXTRA_BLOCKED',
      rule: refOf(first),
    };
  }
  // Highest amount first; equal amounts in id order, so the deciding row is deterministic.
  const u = usdRateOf(usdIqdRate);
  const keys = new Map(live.map((r) => [r, rankKey(r, u)]));
  const ranked = [...live].sort((a, b) => {
    const ka = keys.get(a)!;
    const kb = keys.get(b)!;
    return ka.group - kb.group || compareProcurementExact(kb.value, ka.value) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
  const top = ranked[0];
  const usd = top.amount_usd ?? null;
  const currencies = new Set(live.map((r) => ((r.amount_usd ?? null) === null ? 'IQD' : 'USD')));
  return {
    status: 'active',
    kind,
    amount_iqd: usd === null ? (top.amount_iqd as number) : null,
    ...(usd !== null ? { amount_usd: procurementExactText(parseUsdRuleAmount(usd)!) } : {}),
    rule: refOf(top),
    tie: ranked.length > 1,
    candidates: ranked.map(refOf),
    ...(currencies.size > 1 && u ? { ranked_at_usd_iqd: procurementExactText(u) } : {}),
  };
}

/**
 * Resolve one rule kind for one SKU: most specific scope wins (see the file
 * header). `usdIqdRate` (U) ranks a tie between a USD and a dinar minimum
 * profit; pass the rate the price will be computed at.
 */
export function resolveRuleAt(
  rules: readonly PricingRuleRow[],
  kind: PricingRuleKind,
  target: RuleTarget,
  opts: { usdIqdRate?: string | null } = {}
): RuleResolution {
  const usdIqdRate = opts.usdIqdRate ?? null;
  const comboKey = skuComboKey({ option_value_ids: target.option_value_ids, color_id: target.color_id });
  if (target.combo_key !== undefined && target.combo_key !== comboKey)
    throw new Error(`PRICING_INVARIANT: combo_key ${JSON.stringify(target.combo_key)} is not the selection's ${JSON.stringify(comboKey)}`);
  for (const scope of RULE_SCOPE_ORDER) {
    if (scope === 'category') {
      const seen = new Set<string>();
      for (const catalogId of target.ancestry) {
        if (!catalogId || seen.has(catalogId)) continue;
        seen.add(catalogId);
        const decided = decide(kind, rowsAt(rules, kind, 'category', target, comboKey, catalogId), usdIqdRate);
        if (decided) return decided;
      }
      continue;
    }
    const decided = decide(kind, rowsAt(rules, kind, scope, target, comboKey), usdIqdRate);
    if (decided) return decided;
  }
  return { status: 'missing', kind, code: kind === 'target_profit' ? 'TARGET_PROFIT_MISSING' : 'DIRECT_SALE_EXTRA_MISSING' };
}
