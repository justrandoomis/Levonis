/**
 * A CONFIRMED PURCHASE → THE PRODUCT'S CURRENT COSTS (USD design §3.1-§3.3;
 * owner brief 2026-10-09 §1-§2). Server-side mapping only: the client sends no
 * cost amount, the values are derived here from the purchase's own lines — a
 * draft parsed by the purchase POST's parser (preview) or the COMMITTED lines
 * (apply).
 *
 * A line feeds when the purchase is confirmed (`ordered`, `partial` or
 * `received` — quick receive included) with a FINAL cost, and it is on a route
 * document, or a manual line in USD/EUR/CNY the owner ticked («اعتمد سعر
 * المورد هذا…», supplier cost only), and the owner kept «استعمل هذا الشراء
 * لتسعير هذا المنتج».
 *
 * Field mapping (§3.2), every value rounded UP — never to nearest:
 *   - supplier cost in its currency: unit mode ceil6(unit); total mode the exact
 *     unit when it terminates within 6 places, else ceil6(total ÷ qty); 0 or
 *     missing is NOT written;
 *   - weight routes: shipping_weight_g = ceil(packed grams) when > 0;
 *   - the volume route: manual_cbm = ceil9(mm³ ÷ 1e9) when > 0 (a weight route's
 *     optional allocation CBM never feeds);
 *   - additional_cost_iqd = ceil(Σ shares of the charges marked 'additional'
 *     covering the line ÷ qty), written ONLY when one covers it (otherwise the
 *     stored value stays; freight-looking charges are 'excluded' by default);
 *   - shipping_profile: proposed from the route ONLY when the product resolves
 *     none — never overwritten;
 *   - source_ref = 'purchase:<id>' (line ids change on every PUT).
 * Scopes: base → base, option → option, variant → its first option, colour →
 * base (until FX-7). A line NARROWER than its pricing scope never lowers a
 * stored value (max per field) unless the owner ticks «استعمل قيمة هذا الشراء
 * حتى لو كانت أقل من الحالية»; several lines on one scope take the maximum.
 *
 * Reads purchase rows; never writes one (USD design §7.1 G2).
 */
import {
  ceilToPlaces,
  compareProcurementExact,
  divProcurementExact,
  mulProcurementExact,
  procurementExact,
  procurementExactText,
  exactProcurementUnitDefault,
  type ProcurementExact,
} from '@levonis/contracts/procurementCost';
import { resolveSkuInputs, type SupplierCurrency } from '@levonis/pricing/costToPrice';
import { canonicalUsdRuleAmount } from '@levonis/pricing/ruleResolution';
import type { ShippingProfile } from '@levonis/pricing/skuChannel';
import { chainOf, ownerRow, ruleAt, type InputFields, type InputScope, type InputWrite, type ProductPricingData, type RuleWrite, type StoredInputRow } from './store';
import type { PricingRates } from './rates';

export type PurchaseStatus = 'draft' | 'ordered' | 'partial' | 'received' | 'cancelled';

export interface PurchaseLineForPricing {
  /** The line's position in the document (draft order, or the committed order). */
  index: number;
  /** The committed line id; null for an unsaved draft. */
  line_id: string | null;
  /** `procurementSelectionKey`: product:scope:scope_id. */
  key: string;
  product_id: string;
  scope: 'base' | 'option' | 'color' | 'variant';
  scope_id: string;
  /** The selection's option (a variant's first option); null without one. */
  option_id: string | null;
  label: string;
  qty: number;
  cost_mode: 'unit' | 'total';
  /** As typed: the unit price (unit mode) or the line total (total mode), in the document's currency. */
  source_amount: number;
  weight_g: number;
  volume_mm3: number;
  /** Today's direct-sale store price of the selection (the old reference column), IQD. */
  store_price_iqd: number | null;
}

export interface PurchaseChargeForPricing {
  title: string;
  pricing_role: 'additional' | 'excluded' | null;
  /** The whole dinars this charge put on each line it covers, by line index. */
  shares: Array<{ index: number; amount_iqd: number }>;
}

export interface PurchaseForPricing {
  purchase_id: string | null;
  status: PurchaseStatus;
  cost_state: 'estimated' | 'final';
  currency: string;
  /** The document's own rate (IQD per unit of its currency): shown, never priced from. */
  exchange_rate: number;
  profile: { id: 'germany_land' | 'china_air' | 'china_sea'; shipping_basis: 'weight' | 'volume' } | null;
  lines: PurchaseLineForPricing[];
  charges: PurchaseChargeForPricing[];
}

export const PROFILE_OF_ROUTE: Readonly<Record<'germany_land' | 'china_air' | 'china_sea', ShippingProfile>> = {
  germany_land: 'GERMANY_LAND',
  china_air: 'CHINA_AIR',
  china_sea: 'CHINA_SEA',
};

const SUPPLIER: ReadonlySet<string> = new Set(['USD', 'EUR', 'CNY']);

/** Why a purchase cannot feed pricing (§3.1), or null. */
export function purchaseIneligibility(p: Pick<PurchaseForPricing, 'status' | 'cost_state' | 'lines'>): 'status' | 'estimated' | 'no_lines' | null {
  if (!['ordered', 'partial', 'received'].includes(p.status)) return 'status';
  if (p.cost_state !== 'final') return 'estimated';
  if (!p.lines.length) return 'no_lines';
  return null;
}

/** The line feeds pricing by its kind: a route document, or a ticked manual line in USD/EUR/CNY. */
export function lineFeeds(p: PurchaseForPricing, line: PurchaseLineForPricing, optIn: ReadonlySet<string>): boolean {
  if (!SUPPLIER.has(p.currency)) return false;
  return p.profile !== null || optIn.has(line.key);
}

/** The pricing scope a selection writes to before FX-7. */
export function pricingScopeOf(line: Pick<PurchaseLineForPricing, 'scope' | 'scope_id' | 'option_id'>): { scope: InputScope; scope_id: string; narrow: boolean } {
  if (line.scope === 'option') return { scope: 'option', scope_id: line.scope_id, narrow: false };
  if (line.scope === 'variant') return line.option_id ? { scope: 'option', scope_id: line.option_id, narrow: true } : { scope: 'base', scope_id: '', narrow: true };
  if (line.scope === 'color') return { scope: 'base', scope_id: '', narrow: true };
  return { scope: 'base', scope_id: '', narrow: false };
}

const exactOfNumber = (n: number): ProcurementExact | null => {
  try {
    return Number.isFinite(n) && n > 0 ? procurementExact(String(n)) : null;
  } catch {
    return null;
  }
};

/** The supplier cost of one line per unit, decimal text rounded UP at 6 places; null when 0 or unreadable. */
export function supplierUnitText(line: Pick<PurchaseLineForPricing, 'cost_mode' | 'source_amount' | 'qty'>): string | null {
  const amount = exactOfNumber(line.source_amount);
  if (!amount || amount.num <= 0n) return null;
  try {
    if (line.cost_mode === 'total') {
      const exact = exactProcurementUnitDefault(line.source_amount, line.qty);
      const unit = exact !== null ? exactOfNumber(exact) : null;
      const value = unit ?? ceilToPlaces(divProcurementExact(amount, line.qty), 6);
      return value.num > 0n ? procurementExactText(value) : null;
    }
    return procurementExactText(ceilToPlaces(amount, 6));
  } catch {
    return null;
  }
}

/** The fields one line derives (before scope merging). */
interface LineFields {
  supplier_cost_amount?: string;
  supplier_cost_currency?: SupplierCurrency;
  shipping_weight_g?: number;
  manual_cbm?: string;
  additional_cost_iqd?: number;
}

function lineFields(p: PurchaseForPricing, line: PurchaseLineForPricing, manual: boolean): LineFields {
  const out: LineFields = {};
  const supplier = supplierUnitText(line);
  if (supplier && SUPPLIER.has(p.currency)) {
    out.supplier_cost_amount = supplier;
    out.supplier_cost_currency = p.currency as SupplierCurrency;
  }
  if (manual || !p.profile) return out;
  if (p.profile.shipping_basis === 'weight') {
    if (Number.isFinite(line.weight_g) && line.weight_g > 0) {
      const g = Math.ceil(line.weight_g);
      if (g >= 1 && g <= 100_000_000) out.shipping_weight_g = g;
    }
  } else if (Number.isFinite(line.volume_mm3) && line.volume_mm3 > 0) {
    const mm3 = exactOfNumber(line.volume_mm3);
    if (mm3) {
      const cbm = procurementExactText(ceilToPlaces(divProcurementExact(mm3, 1_000_000_000), 9));
      if (cbm.length <= 12) out.manual_cbm = cbm;
    }
  }
  const additional = p.charges.filter((c) => c.pricing_role === 'additional' && c.shares.some((s) => s.index === line.index));
  if (additional.length) {
    const total = additional.reduce((n, c) => n + c.shares.filter((s) => s.index === line.index).reduce((m, s) => m + s.amount_iqd, 0), 0);
    const unit = Math.ceil(total / line.qty);
    if (Number.isSafeInteger(unit) && unit >= 0 && unit <= 1_000_000_000) out.additional_cost_iqd = unit;
  }
  return out;
}

/** The USD value of a supplier cost at today's rates, for "never lower" comparisons; null without its rate. */
function supplierUsd(amount: string, currency: string, rates: PricingRates | null): ProcurementExact | null {
  try {
    const a = procurementExact(amount);
    if (currency === 'USD') return a;
    const rate = currency === 'EUR' ? rates?.eur_usd : currency === 'CNY' ? rates?.cny_usd : null;
    return rate ? mulProcurementExact(a, procurementExact(rate)) : null;
  } catch {
    return null;
  }
}

const maxNum = (a: number | null | undefined, b: number | undefined): number | undefined =>
  b === undefined ? undefined : a == null ? b : Math.max(a, b);
const maxDecimal = (a: string | null | undefined, b: string | undefined): string | undefined =>
  b === undefined ? undefined : a == null ? b : compareProcurementExact(procurementExact(a), procurementExact(b)) >= 0 ? a : b;

/** One scope's derived write, with what the preview says about it. */
export interface DerivedEntry {
  write: InputWrite;
  /** The purchase lines that fed it (positions and, when committed, ids). */
  line_indexes: number[];
  line_ids: string[];
  /** A line narrower than the scope fed it (max per field unless the owner prefers the purchase). */
  narrow: boolean;
  /** Fields kept at the stored (higher) value because the line was narrower. */
  kept_higher: Array<keyof InputFields>;
}

export interface DerivedProduct {
  product_id: string;
  /** What the purchase itself says per scope, before any stored value is weighed: the idempotency basis. */
  raw: Array<{ scope: InputScope; scope_id: string; narrow: boolean; fields: Record<string, string | number> }>;
  entries: DerivedEntry[];
  /** shipping_profile proposed from the route at a scope that resolves none. */
  proposals: Array<{ scope: InputScope; scope_id: string; shipping_profile: ShippingProfile }>;
  /** Written fields a more specific value shadows (the price will not use them). */
  shadowed: Array<{ scope: InputScope; scope_id: string; field: keyof InputFields }>;
}

/**
 * The input writes one purchase derives for one product (see the file header).
 * `stored` is the product's store as read; `rates` compares supplier costs of
 * different currencies (none in practice: one document has one currency).
 */
export function deriveProductEntries(
  p: PurchaseForPricing,
  productId: string,
  stored: ProductPricingData,
  opts: { optIn: ReadonlySet<string>; prefer: boolean; usePurchase: boolean; rates: PricingRates | null }
): DerivedProduct {
  const out: DerivedProduct = { product_id: productId, raw: [], entries: [], proposals: [], shadowed: [] };
  if (!opts.usePurchase) return out;
  const sourceRef = p.purchase_id ? `purchase:${p.purchase_id}` : 'purchase:draft';
  const groups = new Map<string, { scope: InputScope; scope_id: string; narrow: boolean; fields: LineFields; indexes: number[]; ids: string[] }>();
  for (const line of p.lines) {
    if (line.product_id !== productId || !lineFeeds(p, line, opts.optIn)) continue;
    const target = pricingScopeOf(line);
    const key = `${target.scope}:${target.scope_id}`;
    const fields = lineFields(p, line, p.profile === null);
    const g = groups.get(key) ?? { scope: target.scope, scope_id: target.scope_id, narrow: false, fields: {}, indexes: [], ids: [] };
    g.narrow ||= target.narrow;
    g.indexes.push(line.index);
    if (line.line_id) g.ids.push(line.line_id);
    // Several lines on one scope: the maximum per field (the details name the lines).
    g.fields.supplier_cost_amount = maxDecimal(g.fields.supplier_cost_amount, fields.supplier_cost_amount) ?? g.fields.supplier_cost_amount;
    g.fields.supplier_cost_currency = fields.supplier_cost_currency ?? g.fields.supplier_cost_currency;
    g.fields.shipping_weight_g = maxNum(g.fields.shipping_weight_g, fields.shipping_weight_g) ?? g.fields.shipping_weight_g;
    g.fields.manual_cbm = maxDecimal(g.fields.manual_cbm, fields.manual_cbm) ?? g.fields.manual_cbm;
    g.fields.additional_cost_iqd = maxNum(g.fields.additional_cost_iqd, fields.additional_cost_iqd) ?? g.fields.additional_cost_iqd;
    groups.set(key, g);
  }

  // The product's own scope first, so a profile proposed there covers its models.
  const ordered = [...groups.values()].sort((a, b) => (a.scope === b.scope ? (a.scope_id < b.scope_id ? -1 : a.scope_id > b.scope_id ? 1 : 0) : a.scope === 'base' ? -1 : 1));
  for (const g of ordered) {
    out.raw.push({
      scope: g.scope,
      scope_id: g.scope_id,
      narrow: g.narrow,
      fields: Object.fromEntries(Object.entries(g.fields).filter(([, v]) => v !== undefined)) as Record<string, string | number>,
    });
    const existing = ownerRow(stored.inputs, g.scope, g.scope_id);
    const set: Partial<InputFields> = {};
    const kept: Array<keyof InputFields> = [];
    const lowerKept = g.narrow && !opts.prefer;
    // Supplier cost: replaced, or (a narrower line) only when not lower in USD at today's rates.
    if (g.fields.supplier_cost_amount && g.fields.supplier_cost_currency) {
      let take = true;
      if (lowerKept && existing && (existing.supplier_cost_amount != null || existing.supplier_cost_delta != null)) {
        // One currency compares as typed; two compare in USD at today's rates (unknown → kept).
        const same = existing.supplier_cost_amount != null && existing.supplier_cost_currency === g.fields.supplier_cost_currency;
        const before = same
          ? procurementExact(existing.supplier_cost_amount!)
          : existing.supplier_cost_amount != null && existing.supplier_cost_currency ? supplierUsd(existing.supplier_cost_amount, existing.supplier_cost_currency, opts.rates) : null;
        const after = same ? procurementExact(g.fields.supplier_cost_amount) : supplierUsd(g.fields.supplier_cost_amount, g.fields.supplier_cost_currency, opts.rates);
        take = before !== null && after !== null && compareProcurementExact(after, before) > 0;
      }
      if (take) {
        set.supplier_cost_amount = g.fields.supplier_cost_amount;
        set.supplier_cost_currency = g.fields.supplier_cost_currency;
      } else kept.push('supplier_cost_amount');
    }
    for (const field of ['shipping_weight_g', 'additional_cost_iqd'] as const) {
      const v = g.fields[field];
      if (v === undefined) continue;
      const before = existing?.[field] ?? null;
      if (lowerKept && before != null && before >= v) {
        if (before > v) kept.push(field);
        continue;
      }
      set[field] = v;
    }
    if (g.fields.manual_cbm !== undefined) {
      const before = existing?.manual_cbm ?? null;
      if (lowerKept && before != null && compareProcurementExact(procurementExact(before), procurementExact(g.fields.manual_cbm)) >= 0) {
        if (compareProcurementExact(procurementExact(before), procurementExact(g.fields.manual_cbm)) > 0) kept.push('manual_cbm');
      } else set.manual_cbm = g.fields.manual_cbm;
    }
    out.entries.push({
      write: { scope: g.scope, scope_id: g.scope_id, existing, set, source_ref: sourceRef },
      line_indexes: g.indexes,
      line_ids: g.ids,
      narrow: g.narrow,
      kept_higher: kept,
    });
  }

  // The route's profile, proposed only where the product resolves none (never overwritten).
  if (p.profile) {
    const proposed = PROFILE_OF_ROUTE[p.profile.id];
    for (const e of out.entries) {
      const merged = mergedInputs(stored.inputs, out.entries.map((x) => x.write));
      const resolved = resolveSkuInputs(chainOf(merged, e.write.scope === 'option' ? e.write.scope_id : '')).inputs.shipping_profile;
      if (resolved) continue;
      e.write.set.shipping_profile = proposed;
      out.proposals.push({ scope: e.write.scope, scope_id: e.write.scope_id, shipping_profile: proposed });
    }
  }

  // Shadowing: a value written at the product level that a model's own row holds,
  // or a shipping weight the owner's pricing weight beats.
  const optionRows = stored.inputs.filter((r) => r.scope === 'option');
  for (const e of out.entries) {
    for (const field of Object.keys(e.write.set) as Array<keyof InputFields>) {
      if (field === 'supplier_cost_currency') continue;
      const sameRowPricingWeight = field === 'shipping_weight_g' && (e.write.existing?.pricing_weight_g ?? null) !== null;
      const deeper =
        e.write.scope === 'base' &&
        optionRows.some((r) => (field === 'shipping_weight_g' ? r.shipping_weight_g != null || r.pricing_weight_g != null : r[field as keyof StoredInputRow] != null));
      if (sameRowPricingWeight || deeper) out.shadowed.push({ scope: e.write.scope, scope_id: e.write.scope_id, field });
    }
  }
  return out;
}

/** The store as it would be after the writes (rows of the owner's origin replaced or added). */
export function mergedInputs(stored: readonly StoredInputRow[], writes: readonly InputWrite[]): Array<Partial<StoredInputRow>> {
  const rows: Array<Partial<StoredInputRow>> = stored.map((r) => ({ ...r }));
  for (const w of writes) {
    const scopeId = w.scope === 'base' ? '' : w.scope_id;
    const at = rows.findIndex((r) => r.scope === w.scope && r.scope_id === scopeId && r.origin === 'MANUAL_OVERRIDE');
    const base = at >= 0 ? rows[at]! : { scope: w.scope, scope_id: scopeId, origin: 'MANUAL_OVERRIDE' as const };
    const next: Partial<StoredInputRow> = { ...base, ...w.set };
    if (w.set.supplier_cost_amount != null) next.supplier_cost_delta = null;
    if (at >= 0) rows[at] = next;
    else rows.push(next);
  }
  return rows;
}

// ------------------------------------------------------------ the minimum profit (USD design §4)

export interface MinimumProfitDraft {
  scope: 'product' | 'option';
  scope_id: string;
  /** Canonical USD text; null = INHERIT (the field left empty). */
  amount_usd: string | null;
}

/** The owner's typed minimum profit, validated (§4.1); throws 'invalid' / 'scope' codes for the route to translate. */
export function parseMinimumProfit(raw: unknown, optionIds: ReadonlySet<string>): MinimumProfitDraft {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const scope = r.scope;
  if (scope !== 'product' && scope !== 'option') throw new MinimumProfitError('scope');
  const scopeId = scope === 'product' ? '' : typeof r.scope_id === 'string' ? r.scope_id : '';
  if (scope === 'option' && !optionIds.has(scopeId)) throw new MinimumProfitError('scope');
  if (scope === 'product' && r.scope_id !== undefined && r.scope_id !== null && r.scope_id !== '') throw new MinimumProfitError('scope');
  if (r.amount_usd === null || r.amount_usd === undefined || r.amount_usd === '') return { scope, scope_id: scopeId, amount_usd: null };
  if (typeof r.amount_usd !== 'string') throw new MinimumProfitError('amount');
  const canonical = canonicalUsdRuleAmount(r.amount_usd);
  if (canonical === null) throw new MinimumProfitError('amount');
  return { scope, scope_id: scopeId, amount_usd: canonical };
}

export class MinimumProfitError extends Error {
  constructor(readonly kind: 'scope' | 'amount') {
    super(`MINIMUM_PROFIT_${kind.toUpperCase()}`);
  }
}

/** The rule writes the owner's minimum profits make (empty = INHERIT; an untouched target is not listed). */
export function minimumProfitWrites(productId: string, drafts: readonly MinimumProfitDraft[], stored: ProductPricingData): RuleWrite[] {
  return drafts.map((d) => ({
    kind: 'target_profit' as const,
    scope: d.scope,
    scope_id: d.scope_id,
    existing: ruleAt(stored.rules, productId, 'target_profit', d.scope, d.scope_id),
    next: d.amount_usd === null
      ? { state: 'INHERIT' as const, amount_usd: null, amount_iqd: null, source: 'OWNER' as const, legacy_result_id: null }
      : { state: 'ACTIVE' as const, amount_usd: d.amount_usd, amount_iqd: null, source: 'OWNER' as const, legacy_result_id: null },
  }));
}

/** The rules as they would be after the writes. */
export function mergedRules(stored: ProductPricingData, writes: readonly RuleWrite[]): ProductPricingData['rules'] {
  const rows = stored.rules.map((r) => ({ ...r }));
  for (const w of writes) {
    const scopeId = w.scope === 'product' ? '' : w.scope_id;
    const at = rows.findIndex((r) => r.product_id === stored.product_id && r.kind === w.kind && r.scope === w.scope && r.scope_id === scopeId);
    const next = {
      id: at >= 0 ? rows[at]!.id : `draft:${w.kind}:${w.scope}:${scopeId}`,
      kind: w.kind,
      scope: w.scope,
      catalog_id: null,
      product_id: stored.product_id,
      scope_id: scopeId,
      state: w.next.state,
      amount_usd: w.next.amount_usd,
      amount_iqd: w.next.amount_iqd,
      source: w.next.source,
      legacy_amount_iqd: null,
      legacy_usd_iqd_rate: null,
      legacy_result_id: w.next.legacy_result_id,
      version: at >= 0 ? rows[at]!.version + 1 : 1,
      updated_at: '',
    };
    if (at >= 0) rows[at] = next;
    else rows.push(next);
  }
  return rows;
}
