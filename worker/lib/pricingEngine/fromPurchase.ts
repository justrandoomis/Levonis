/**
 * A CONFIRMED PURCHASE → THE PRODUCT'S CURRENT COSTS (USD design §3.1-§3.3;
 * owner brief 2026-10-09 §1-§2). Server-side mapping only: the client sends no
 * cost amount, the values are derived here from the purchase's own lines — a
 * draft parsed by the purchase POST's parser (preview) or the COMMITTED lines
 * (apply).
 *
 * A line feeds when the purchase is confirmed (`ordered`, `partial` or
 * `received` — quick receive included) with a FINAL cost, and it is on a route
 * document, or a manual line (supplier cost only), and the owner kept «استعمل
 * هذا الشراء لتسعير هذا المنتج». A manual line in USD/EUR/CNY feeds in its
 * currency. A local dinar purchase (IQD) feeds too (DECISIONS row 249, «الدولار
 * هو الأساس»): its unit dinars are converted ONCE to USD at the purchase's U
 * (its FX snapshot, `usd_iqd`) and offered as an IQD_CONVERTED supplier cost
 * with that conversion's snapshot — the same rule as a typed dinar supplier
 * cost (rows 214, 224); without a known U and version the line does not feed.
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
 * base. A line NARROWER than its pricing scope (a colour, a variant) lands at
 * its own level (below); its broader scope is only SEEDED — a field is written
 * there only while nothing resolves for it yet (DECISIONS row 249), and never
 * raised or lowered, so a sibling colour or variant never moves because another
 * was bought (unless the owner ticks «استعمل قيمة هذا الشراء حتى لو كانت أقل من
 * الحالية», the old preview's replace). A seed is marked (`seed`) and read again
 * where it lands — at apply and in the needs-pricing fold (`openSeedFields`) —
 * so one computed against an emptier store never overwrites what another
 * review or the owner wrote since. Several lines on one scope take the maximum.
 *
 * FX-7 gaps — THE COLOUR'S AND THE VARIANT'S OWN LEVEL (with the SKU rung,
 * 0183): a colour line ALSO feeds its colour, and a variant line its SKU
 * (`skuLevelOf`), exactly — the purchase priced that colour or that variant,
 * not a neighbour. Inheritance is respected: a field is written at that level
 * only where it holds a value of its own already, or where the purchase's value
 * differs from what every one of the level's SKUs inherits (product → model →
 * colour, after this purchase's broader writes — never its seeds, so the bought
 * level always carries what was bought, the review self-contained) — a colour bought at its
 * product's own cost keeps inheriting instead of pinning a copy; a shipping
 * weight is never written above the owner's pricing weight it would beat. The
 * double-freight guard is the same: the level's extra is fed only by charges
 * marked 'additional' (`lineFields`), never route freight. No shipping profile
 * is proposed at these levels (the broader scope's proposal is inherited).
 *
 * Reads purchase rows; never writes one (USD design §7.1 G2).
 */
import {
  ceilToPlaces,
  compareProcurementExact,
  divProcurementExact,
  procurementExact,
  procurementExactText,
  quotientProcurementExact,
  exactProcurementUnitDefault,
  type ProcurementExact,
} from '@levonis/contracts/procurementCost';
import { resolveSkuInputs, type SupplierCurrency } from '@levonis/pricing/costToPrice';
import { canonicalUsdRuleAmount } from '@levonis/pricing/ruleResolution';
import { parseSkuComboKey, type ShippingProfile } from '@levonis/pricing/skuChannel';
import { chainOf, chainOfUnit, ownerRow, ruleAt, type InputFields, type InputScope, type InputWrite, type IqdSnapshot, type ProductPricingData, type RuleWrite, type StoredInputRow, type UnitPackages, type UnitSelection } from './store';
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
  /**
   * This shipment's own landed figures for the whole line, in whole dinars, exactly as the document stores
   * them (the lot cost): the raw purchase at the document's rate, the route freight at the document's freight
   * rate, and the extra charges' shares. Present for an unsaved draft read by the purchase POST's parser;
   * absent for a saved purchase, whose pricing reads stay as they were (DECISIONS row 273).
   */
  landed?: { raw_iqd: number; freight_iqd: number; extras_iqd: number; freight_rate_iqd: number | null };
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
  /**
   * An IQD document's U (row 249): the central USD/IQD of its FX snapshot (or of the save that writes
   * it) with its version and time. Absent or null: an IQD line does not feed (no rate is guessed).
   */
  usd_iqd?: { rate: string; version: number; at: string } | null;
}

export const PROFILE_OF_ROUTE: Readonly<Record<'germany_land' | 'china_air' | 'china_sea', ShippingProfile>> = {
  germany_land: 'GERMANY_LAND',
  china_air: 'CHINA_AIR',
  china_sea: 'CHINA_SEA',
};

const SUPPLIER: ReadonlySet<string> = new Set(['USD', 'EUR', 'CNY']);

/**
 * DECISIONS row 273: the dollar rate of THIS shipment (IQD per USD, exact). A dollar document: its own
 * rate. A euro or yuan document: the dollar its rate implies through the approved central cross (rate ÷ E
 * or ÷ C), so the supplier's euros or yuan are the same dollars the engine reads and only the dinars of this
 * shipment move. A dinar document: its U (row 249), else the central U. Null when a figure is missing.
 */
export function shipmentUsdIqd(p: Pick<PurchaseForPricing, 'currency' | 'exchange_rate' | 'usd_iqd'>, rates: Pick<PricingRates, 'usd_iqd' | 'eur_usd' | 'cny_usd'> | null): ProcurementExact | null {
  try {
    const positive = (x: ProcurementExact | null) => (x && x.num > 0n ? x : null);
    if (p.currency === 'IQD') return positive(procurementExact(p.usd_iqd?.rate ?? rates?.usd_iqd ?? '0'));
    if (!Number.isFinite(p.exchange_rate) || p.exchange_rate <= 0) return null;
    const doc = procurementExact(String(p.exchange_rate));
    if (p.currency === 'USD') return positive(doc);
    const cross = p.currency === 'EUR' ? rates?.eur_usd : p.currency === 'CNY' ? rates?.cny_usd : null;
    if (!cross) return null;
    return positive(quotientProcurementExact(doc, procurementExact(cross)));
  } catch {
    return null;
  }
}

/**
 * DECISIONS row 273: one selection's landed unit cost on THIS shipment, in dinars (exact): every line of the
 * selection, Σ (raw + freight + extras) ÷ Σ qty — the «تكلفة القطعة الفعلية لهذه الشحنة» the purchase
 * screen shows and the lots carry. Null when a line lacks its landed figures or the selection is not bought.
 */
export function shipmentUnitLandedIqd(p: Pick<PurchaseForPricing, 'lines'>, match: (line: PurchaseLineForPricing) => boolean): ProcurementExact | null {
  const lines = p.lines.filter(match);
  if (!lines.length || lines.some((l) => !l.landed || !Number.isSafeInteger(l.qty) || l.qty <= 0)) return null;
  const dinars = lines.reduce((n, l) => n + l.landed!.raw_iqd + l.landed!.freight_iqd + l.landed!.extras_iqd, 0);
  const qty = lines.reduce((n, l) => n + l.qty, 0);
  if (!Number.isSafeInteger(dinars) || dinars <= 0) return null;
  return divProcurementExact(procurementExact(BigInt(dinars)), qty);
}

/** Why a purchase cannot feed pricing (§3.1), or null. */
export function purchaseIneligibility(p: Pick<PurchaseForPricing, 'status' | 'cost_state' | 'lines'>): 'status' | 'estimated' | 'no_lines' | null {
  if (!['ordered', 'partial', 'received'].includes(p.status)) return 'status';
  if (p.cost_state !== 'final') return 'estimated';
  if (!p.lines.length) return 'no_lines';
  return null;
}

/** A dinar document's U and version, when both are known (row 249); null otherwise. */
const iqdRateOf = (p: Pick<PurchaseForPricing, 'currency' | 'usd_iqd'>): { rate: string; version: number; at: string } | null => {
  if (p.currency !== 'IQD' || !p.usd_iqd) return null;
  const { rate, version, at } = p.usd_iqd;
  if (!Number.isSafeInteger(version) || version <= 0 || typeof at !== 'string' || !at) return null;
  try {
    return procurementExact(rate).num > 0n ? { rate, version, at } : null;
  } catch {
    return null;
  }
};

/** The line feeds pricing by its kind: a route document, or a ticked manual line in USD/EUR/CNY — or IQD at a known U (row 249). */
export function lineFeeds(p: PurchaseForPricing, line: PurchaseLineForPricing, optIn: ReadonlySet<string>): boolean {
  if (!SUPPLIER.has(p.currency) && !iqdRateOf(p)) return false;
  return p.profile !== null || optIn.has(line.key);
}

/**
 * FX-7 gaps: the colour and SKU levels this product's inputs may name, and its
 * sellable SKUs — present only with the SKU rung (0183); without it a colour or
 * variant line feeds its broader scope alone, exactly as before.
 */
export interface PurchaseSkuLevels {
  color: ReadonlySet<string>;
  sku: ReadonlySet<string>;
  /** A variant row's id → its combo key (a procurement variant line names the row). */
  variants: ReadonlyMap<string, string>;
  /** Every sellable SKU (relation order, the model first): the units a level reaches. */
  units: ReadonlyArray<UnitSelection & { combo_key: string }>;
  /** The document's packages (row 247): a level's SKUs inherit its model's and colour's own measure, as V2 prices them. */
  packages?: UnitPackages;
}

/** The colour or SKU level a colour or variant line is exactly (FX-7 gaps), or null: no SKU rung, a colour or variant gone, a variant that is its model alone. */
export function skuLevelOf(line: Pick<PurchaseLineForPricing, 'scope' | 'scope_id'>, levels: PurchaseSkuLevels | undefined): { scope: 'color' | 'sku'; scope_id: string } | null {
  if (!levels) return null;
  if (line.scope === 'color') return levels.color.has(line.scope_id) ? { scope: 'color', scope_id: line.scope_id } : null;
  if (line.scope === 'variant') {
    const key = levels.variants.get(line.scope_id);
    return key && levels.sku.has(key) ? { scope: 'sku', scope_id: key } : null;
  }
  return null;
}

/** The pricing scope a selection writes to (its broader scope; FX-7's own colour or SKU level is `skuLevelOf`). */
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
  /** An IQD line's conversion (row 249): the supplier cost above is then its USD. */
  iqd?: IqdSnapshot;
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
  const u = iqdRateOf(p);
  if (supplier && u) {
    // Row 249: the dinars (whole, rounded up) converted once to USD at the purchase's U, rounded UP at 6 places.
    try {
      const dinars = procurementExactText(ceilToPlaces(procurementExact(supplier), 0));
      const usd = ceilToPlaces(quotientProcurementExact(procurementExact(dinars), procurementExact(u.rate)), 6);
      if (usd.num > 0n && /^[1-9][0-9]{0,12}$/.test(dinars)) {
        out.supplier_cost_amount = procurementExactText(usd);
        out.supplier_cost_currency = 'USD';
        out.iqd = { original_input_amount: dinars, conversion_rate_snapshot: u.rate, conversion_fx_version: u.version, converted_at: u.at };
      }
    } catch {
      /* an unreadable figure does not feed */
    }
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
  /**
   * Row 249: a SEED — a narrower line's figures offered to its empty broader level. Written only while
   * nothing resolves there (`openSeedFields`, read again at apply and in the needs-pricing fold); never the
   * level that was bought, so it never decides which other purchase's review this one replaces.
   */
  seed?: boolean;
}

export interface DerivedProduct {
  product_id: string;
  /** What the purchase itself says per scope, before any stored value is weighed: the idempotency basis. */
  raw: Array<{ scope: InputScope; scope_id: string; narrow: boolean; fields: Record<string, string | number> }>;
  entries: DerivedEntry[];
  /** shipping_profile proposed from the route at a scope that resolves none. */
  proposals: Array<{ scope: InputScope; scope_id: string; shipping_profile: ShippingProfile }>;
  /** Written fields a more specific value shadows (the price will not use them; `shadowedOf`). */
  shadowed: ShadowedWrite[];
}

/**
 * The input writes one purchase derives for one product (see the file header).
 * `stored` is the product's store as read; `rates` is kept for the callers
 * (a narrow line no longer compares currencies: it only seeds, row 249).
 */
export function deriveProductEntries(
  p: PurchaseForPricing,
  productId: string,
  stored: ProductPricingData,
  opts: { optIn: ReadonlySet<string>; prefer: boolean; usePurchase: boolean; rates: PricingRates | null; levels?: PurchaseSkuLevels }
): DerivedProduct {
  const out: DerivedProduct = { product_id: productId, raw: [], entries: [], proposals: [], shadowed: [] };
  if (!opts.usePurchase) return out;
  const sourceRef = p.purchase_id ? `purchase:${p.purchase_id}` : 'purchase:draft';
  type Group = { scope: InputScope; scope_id: string; narrow: boolean; fields: LineFields; indexes: number[]; ids: string[] };
  const groups = new Map<string, Group>();
  // FX-7 gaps: the colour's and the variant's own levels, fed after the broader scopes (see the file header).
  const exact = new Map<string, Group>();
  const add = (into: Map<string, Group>, target: { scope: InputScope; scope_id: string; narrow: boolean }, line: PurchaseLineForPricing, fields: LineFields) => {
    const key = `${target.scope}:${target.scope_id}`;
    const g = into.get(key) ?? { scope: target.scope, scope_id: target.scope_id, narrow: false, fields: {}, indexes: [], ids: [] };
    g.narrow ||= target.narrow;
    g.indexes.push(line.index);
    if (line.line_id) g.ids.push(line.line_id);
    // Several lines on one scope: the maximum per field (the details name the lines).
    const supplier = maxDecimal(g.fields.supplier_cost_amount, fields.supplier_cost_amount) ?? g.fields.supplier_cost_amount;
    // The dinar conversion travels with the line whose USD won (row 249).
    if (fields.supplier_cost_amount !== undefined && supplier === fields.supplier_cost_amount) {
      if (fields.iqd) g.fields.iqd = fields.iqd;
      else delete g.fields.iqd;
    }
    g.fields.supplier_cost_amount = supplier;
    g.fields.supplier_cost_currency = fields.supplier_cost_currency ?? g.fields.supplier_cost_currency;
    g.fields.shipping_weight_g = maxNum(g.fields.shipping_weight_g, fields.shipping_weight_g) ?? g.fields.shipping_weight_g;
    g.fields.manual_cbm = maxDecimal(g.fields.manual_cbm, fields.manual_cbm) ?? g.fields.manual_cbm;
    g.fields.additional_cost_iqd = maxNum(g.fields.additional_cost_iqd, fields.additional_cost_iqd) ?? g.fields.additional_cost_iqd;
    into.set(key, g);
  };
  for (const line of p.lines) {
    if (line.product_id !== productId || !lineFeeds(p, line, opts.optIn)) continue;
    const fields = lineFields(p, line, p.profile === null);
    add(groups, pricingScopeOf(line), line, fields);
    const own = skuLevelOf(line, opts.levels);
    if (own) add(exact, { ...own, narrow: false }, line, fields);
  }

  // The product's own scope first, so a profile proposed there covers its models.
  const ordered = [...groups.values()].sort((a, b) => (a.scope === b.scope ? (a.scope_id < b.scope_id ? -1 : a.scope_id > b.scope_id ? 1 : 0) : a.scope === 'base' ? -1 : 1));
  for (const g of ordered) {
    out.raw.push({
      scope: g.scope,
      scope_id: g.scope_id,
      narrow: g.narrow,
      fields: rawFields(g.fields),
    });
    const existing = ownerRow(stored.inputs, g.scope, g.scope_id);
    const set: Partial<InputFields> = {};
    const kept: Array<keyof InputFields> = [];
    // Row 249: a narrower line (a colour, a variant) only SEEDS its broader scope — a field is written there
    // only while nothing resolves for it yet; it is never raised or lowered (the bought level carries the
    // purchase, skuLevelEntries). The old preview's «use this purchase's value» still replaces.
    const seedOnly = g.narrow && !opts.prefer;
    const held = seedOnly ? resolveSkuInputs(chainOf(stored.inputs, g.scope === 'option' ? g.scope_id : '')).inputs : null;
    if (g.fields.supplier_cost_amount && g.fields.supplier_cost_currency) {
      const has = !!held && (held.supplier !== null || existing?.supplier_cost_amount != null || existing?.supplier_cost_delta != null);
      if (!has) {
        set.supplier_cost_amount = g.fields.supplier_cost_amount;
        set.supplier_cost_currency = g.fields.supplier_cost_currency;
      } else if (!(held!.supplier && held!.supplier.currency === g.fields.supplier_cost_currency && compareProcurementExact(procurementExact(held!.supplier.amount), procurementExact(g.fields.supplier_cost_amount)) === 0))
        kept.push('supplier_cost_amount');
    }
    if (g.fields.shipping_weight_g !== undefined) {
      const v = g.fields.shipping_weight_g;
      if (!held || (held.weight === null && existing?.shipping_weight_g == null)) set.shipping_weight_g = v;
      else if (held.weight?.value !== v) kept.push('shipping_weight_g');
    }
    if (g.fields.additional_cost_iqd !== undefined) {
      const v = g.fields.additional_cost_iqd;
      if (!held || (held.additional_cost_iqd === null && existing?.additional_cost_iqd == null)) set.additional_cost_iqd = v;
      else if (held.additional_cost_iqd?.value !== v) kept.push('additional_cost_iqd');
    }
    if (g.fields.manual_cbm !== undefined) {
      const cbm = procurementExact(g.fields.manual_cbm);
      if (!held || (held.cbm === null && existing?.manual_cbm == null)) set.manual_cbm = g.fields.manual_cbm;
      else if (!(held.cbm && compareProcurementExact(procurementExact(held.cbm.effective), cbm) === 0)) kept.push('manual_cbm');
    }
    const iqd = set.supplier_cost_amount !== undefined ? g.fields.iqd : undefined;
    out.entries.push({
      write: { scope: g.scope, scope_id: g.scope_id, existing, set, source_ref: sourceRef, ...(iqd ? { iqd } : {}) },
      line_indexes: g.indexes,
      line_ids: g.ids,
      narrow: g.narrow,
      kept_higher: kept,
      ...(seedOnly ? { seed: true } : {}),
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

  // FX-7 gaps: each colour's and variant's own level, against what its SKUs inherit after the writes above.
  if (opts.levels && exact.size) skuLevelEntries(out, [...exact.values()], stored, opts.levels, sourceRef);

  // Shadowing: a value written that a more specific level's own row holds (row 249), or a shipping weight the
  // owner's pricing weight beats.
  for (const s of shadowedOf(stored.inputs, out.entries.map((e) => e.write), opts.levels)) {
    if (!out.shadowed.some((x) => x.scope === s.scope && x.scope_id === s.scope_id && x.field === s.field)) out.shadowed.push(s);
  }
  return out;
}

/** A group's fields as the idempotency basis reads them (figures only; the dinar conversion is its own). */
const rawFields = (f: LineFields): Record<string, string | number> =>
  Object.fromEntries(Object.entries(f).filter(([k, v]) => v !== undefined && k !== 'iqd')) as Record<string, string | number>;

/** One shadowed write: the field, its scope, and the more specific levels whose own row holds it. */
export interface ShadowedWrite {
  scope: InputScope;
  scope_id: string;
  field: keyof InputFields;
  by?: Array<{ scope: InputScope; scope_id: string }>;
}

/**
 * The fields of `writes` that a MORE SPECIFIC level's own row holds already, so
 * the price of some SKU will not use them (row 249): a product write under a
 * model's, a colour's or a SKU's row; a model write under the row of a colour
 * one of its SKUs has (any colour row without the SKU rung) or a SKU row whose
 * selection includes it; a colour write under a SKU row of that colour. A
 * shipping weight the same row's pricing weight beats is listed too (no `by`).
 * Read at the review's read time from the stored inputs as they are then.
 */
export function shadowedOf(
  stored: readonly StoredInputRow[],
  writes: ReadonlyArray<Pick<InputWrite, 'scope' | 'scope_id' | 'set' | 'existing'>>,
  levels?: PurchaseSkuLevels
): ShadowedWrite[] {
  const out: ShadowedWrite[] = [];
  const holds = (r: StoredInputRow, field: keyof InputFields) =>
    field === 'shipping_weight_g' ? r.shipping_weight_g != null || r.pricing_weight_g != null : field === 'supplier_cost_amount' ? r.supplier_cost_amount != null : r[field as keyof StoredInputRow] != null;
  const own = stored.filter((r) => r.origin === 'MANUAL_OVERRIDE' || r.origin === 'SOURCE');
  for (const w of writes) {
    const deeper = own.filter((r) => {
      if (w.scope === 'base') return r.scope !== 'base';
      if (w.scope === 'option') {
        if (r.scope === 'sku') return parseSkuComboKey(r.scope_id)?.option_value_ids.includes(w.scope_id) ?? false;
        if (r.scope === 'color') return levels ? levels.units.some((u) => u.color_id === r.scope_id && u.option_value_ids.includes(w.scope_id)) : true;
        return false;
      }
      if (w.scope === 'color') return r.scope === 'sku' && parseSkuComboKey(r.scope_id)?.color_id === w.scope_id;
      return false;
    });
    for (const field of Object.keys(w.set) as Array<keyof InputFields>) {
      if (field === 'supplier_cost_currency' || field === 'shipping_profile') continue;
      const by = deeper.filter((r) => holds(r, field));
      const sameRowPricingWeight = field === 'shipping_weight_g' && (w.existing?.pricing_weight_g ?? null) !== null;
      if (!by.length && !sameRowPricingWeight) continue;
      const seen = new Set<string>();
      const names = by.flatMap((r) => (seen.has(`${r.scope}:${r.scope_id}`) ? [] : (seen.add(`${r.scope}:${r.scope_id}`), [{ scope: r.scope, scope_id: r.scope_id }])));
      out.push({ scope: w.scope, scope_id: w.scope_id, field, ...(names.length ? { by: names } : {}) });
    }
  }
  return out;
}

/**
 * FX-7 gaps: the entries of the colour and SKU levels a purchase's colour and
 * variant lines are exactly (see the file header). A field is written where the
 * level holds its own value already, or where the purchase's value differs from
 * what one of the level's SKUs inherits; a shipping weight the owner's pricing
 * weight decides above it is listed as shadowed instead.
 */
function skuLevelEntries(
  out: DerivedProduct,
  groups: ReadonlyArray<{ scope: InputScope; scope_id: string; fields: LineFields; indexes: number[]; ids: string[] }>,
  stored: ProductPricingData,
  levels: PurchaseSkuLevels,
  sourceRef: string
): void {
  // What the level's SKUs inherit: the store after this purchase's broader writes, the level's own rows left out.
  // A SEED is not one of them (row 249): it lands only while its level is empty, which another review or the
  // owner may change before this one is applied — so the bought level carries what was bought, self-contained.
  const after = mergedInputs(stored.inputs, out.entries.filter((e) => !e.seed).map((e) => e.write));
  const ordered = [...groups].sort((a, b) => (a.scope === b.scope ? (a.scope_id < b.scope_id ? -1 : a.scope_id > b.scope_id ? 1 : 0) : a.scope === 'color' ? -1 : 1));
  for (const g of ordered) {
    out.raw.push({
      scope: g.scope,
      scope_id: g.scope_id,
      narrow: false,
      fields: rawFields(g.fields),
    });
    const existing = ownerRow(stored.inputs, g.scope, g.scope_id);
    const without = after.filter((r) => !(r.scope === g.scope && r.scope_id === g.scope_id));
    let units = levels.units.filter((u) => (g.scope === 'color' ? u.color_id === g.scope_id : u.combo_key === g.scope_id));
    if (!units.length && g.scope === 'sku') {
      // A variant row the form lists but no sellable SKU is: its own selection, as its key names it.
      const sel = parseSkuComboKey(g.scope_id);
      if (sel) units = [{ option_value_ids: sel.option_value_ids, color_id: sel.color_id, combo_key: g.scope_id }];
    }
    const inherited = units.map((u) => resolveSkuInputs(chainOfUnit(without, levels.packages ? { ...u, packaged: levels.packages(u.option_value_ids, u.color_id) } : u)).inputs);
    const set: Partial<InputFields> = {};
    const ownValue = (field: keyof InputFields) => existing?.[field] != null;
    if (g.fields.supplier_cost_amount && g.fields.supplier_cost_currency) {
      const amount = procurementExact(g.fields.supplier_cost_amount);
      const same = inherited.length > 0 && inherited.every((i) => !!i.supplier && i.supplier.currency === g.fields.supplier_cost_currency && compareProcurementExact(procurementExact(i.supplier.amount), amount) === 0);
      if (ownValue('supplier_cost_amount') || ownValue('supplier_cost_delta') || !same) {
        set.supplier_cost_amount = g.fields.supplier_cost_amount;
        set.supplier_cost_currency = g.fields.supplier_cost_currency;
      }
    }
    if (g.fields.shipping_weight_g !== undefined) {
      const v = g.fields.shipping_weight_g;
      // The owner's pricing weight (at this level or above) decides the weight: never beaten from a purchase.
      const pricedAbove = inherited.some((i) => i.weight?.field === 'pricing_weight_g') || ownValue('pricing_weight_g');
      if (pricedAbove) out.shadowed.push({ scope: g.scope, scope_id: g.scope_id, field: 'shipping_weight_g' });
      else if (ownValue('shipping_weight_g') || !(inherited.length > 0 && inherited.every((i) => i.weight?.value === v))) set.shipping_weight_g = v;
    }
    if (g.fields.manual_cbm !== undefined) {
      const cbm = procurementExact(g.fields.manual_cbm);
      const same = inherited.length > 0 && inherited.every((i) => !!i.cbm && compareProcurementExact(procurementExact(i.cbm.effective), cbm) === 0);
      if (ownValue('manual_cbm') || !same) set.manual_cbm = g.fields.manual_cbm;
    }
    if (g.fields.additional_cost_iqd !== undefined) {
      const v = g.fields.additional_cost_iqd;
      if (ownValue('additional_cost_iqd') || !(inherited.length > 0 && inherited.every((i) => (i.additional_cost_iqd?.value ?? 0) === v))) set.additional_cost_iqd = v;
    }
    const iqd = set.supplier_cost_amount !== undefined ? g.fields.iqd : undefined;
    out.entries.push({
      write: { scope: g.scope, scope_id: g.scope_id, existing, set, source_ref: sourceRef, ...(iqd ? { iqd } : {}) },
      line_indexes: g.indexes,
      line_ids: g.ids,
      narrow: false,
      kept_higher: [],
    });
  }
}

/** A write as a review stores it, for `openSeedFields`. */
export interface SeedableWrite {
  scope: InputScope;
  scope_id: string;
  set: Partial<InputFields>;
  iqd?: IqdSnapshot;
  seed?: boolean;
}

/**
 * Row 249: a review's write as it lands on `rows` NOW (the stored set at apply, or the needs-pricing fold so
 * far). A SEED keeps only the fields its level still resolves nothing for — from itself or above — and its own
 * row does not hold, so a seed computed against an earlier, emptier store never overwrites a value another
 * review or the owner set since. A route's shipping profile is a proposal the same way on any write: dropped
 * once the level resolves one. Null when nothing is left to write.
 */
export function openSeedFields<T extends SeedableWrite>(rows: readonly Partial<StoredInputRow>[], w: T): T | null {
  if (w.scope !== 'base' && w.scope !== 'option') return Object.keys(w.set).length ? w : null;
  const scopeId = w.scope === 'base' ? '' : w.scope_id;
  const held = resolveSkuInputs(chainOf(rows, w.scope === 'option' ? scopeId : '')).inputs;
  const own = rows.find((r) => r.scope === w.scope && (r.scope_id ?? '') === scopeId && r.origin === 'MANUAL_OVERRIDE');
  const set: Partial<InputFields> = { ...w.set };
  let iqd = w.iqd;
  if (w.seed) {
    if ('supplier_cost_amount' in set && (held.supplier !== null || own?.supplier_cost_amount != null || own?.supplier_cost_delta != null)) {
      delete set.supplier_cost_amount;
      delete set.supplier_cost_currency;
      iqd = undefined;
    }
    if ('shipping_weight_g' in set && (held.weight !== null || own?.shipping_weight_g != null)) delete set.shipping_weight_g;
    if ('additional_cost_iqd' in set && (held.additional_cost_iqd !== null || own?.additional_cost_iqd != null)) delete set.additional_cost_iqd;
    if ('manual_cbm' in set && (held.cbm !== null || own?.manual_cbm != null)) delete set.manual_cbm;
  }
  if ('shipping_profile' in set && held.shipping_profile !== null) delete set.shipping_profile;
  if (!Object.keys(set).length) return null;
  const next = { ...w, set } as T;
  if (iqd) next.iqd = iqd;
  else delete next.iqd;
  return next;
}

/** The IQD snapshot columns of a row (0181): written by a conversion, cleared when the supplier cost leaves dinars. */
const NO_IQD_SNAPSHOT = {
  original_input_amount: null,
  original_input_currency: null,
  conversion_rate_snapshot: null,
  conversion_fx_version: null,
  canonical_supplier_cost_usd: null,
  converted_at: null,
} as const;

/**
 * The store as it would be after the writes (rows of the owner's origin replaced or added). Each row stays
 * self-consistent the way `nextInputRow` stores it (DECISIONS row 254): a write that sets the supplier cost without
 * converting dinars leaves SOURCE_CURRENCY and no snapshot — a stored IQD_CONVERTED snapshot never describes an
 * amount a purchase fold or an owner's edit replaced; a write that converts dinars (`w.iqd`) carries its own.
 */
export function mergedInputs(stored: readonly StoredInputRow[], writes: readonly InputWrite[]): Array<Partial<StoredInputRow>> {
  const rows: Array<Partial<StoredInputRow>> = stored.map((r) => ({ ...r }));
  for (const w of writes) {
    const scopeId = w.scope === 'base' ? '' : w.scope_id;
    const at = rows.findIndex((r) => r.scope === w.scope && r.scope_id === scopeId && r.origin === 'MANUAL_OVERRIDE');
    const base = at >= 0 ? rows[at]! : { scope: w.scope, scope_id: scopeId, origin: 'MANUAL_OVERRIDE' as const };
    const next: Partial<StoredInputRow> = { ...base, ...w.set };
    if (w.set.supplier_cost_amount != null) next.supplier_cost_delta = null;
    // The supplier-mode rules of `nextInputRow`, on the merged row.
    const supplierTouched = 'supplier_cost_amount' in w.set || 'supplier_cost_delta' in w.set || 'supplier_cost_currency' in w.set;
    const hasSupplier = next.supplier_cost_amount != null || next.supplier_cost_delta != null;
    const wasConverted = base.supplier_input_mode === 'IQD_CONVERTED';
    if (w.iqd && hasSupplier) {
      Object.assign(next, {
        supplier_input_mode: 'IQD_CONVERTED',
        original_input_amount: w.iqd.original_input_amount,
        original_input_currency: 'IQD',
        conversion_rate_snapshot: w.iqd.conversion_rate_snapshot,
        conversion_fx_version: w.iqd.conversion_fx_version,
        canonical_supplier_cost_usd: next.supplier_cost_amount ?? null,
        converted_at: w.iqd.converted_at,
      });
    } else {
      const mode = !hasSupplier ? null : wasConverted && !supplierTouched ? 'IQD_CONVERTED' : 'SOURCE_CURRENCY';
      next.supplier_input_mode = mode;
      if (wasConverted && mode !== 'IQD_CONVERTED') Object.assign(next, NO_IQD_SNAPSHOT);
    }
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

// ------------------------------------------------------------ the Direct Sale Extra (owner request 2026-10-10)

/**
 * The owner's typed Direct Sale Extra on the procurement card's review: a stock
 * purchase is reviewed for DIRECT SALE, so the review asks for the one input
 * the direct price lacks, in place. Product or model (option) level — colour
 * and SKU levels are not offered on this card. `amount_iqd` is whole dinars on
 * the 1,000 step (validated by `parseDirectSaleExtraAmount`); null = INHERIT.
 * There is no invented default: an untyped extra stays as stored.
 */
export interface DirectSaleExtraDraft {
  scope: 'product' | 'option';
  scope_id: string;
  amount_iqd: number | null;
}

/** The rule writes the owner's typed Direct Sale Extras make (mirrors `minimumProfitWrites`). */
export function directSaleExtraWrites(productId: string, drafts: readonly DirectSaleExtraDraft[], stored: ProductPricingData): RuleWrite[] {
  return drafts.map((d) => ({
    kind: 'direct_sale_extra' as const,
    scope: d.scope,
    scope_id: d.scope === 'product' ? '' : d.scope_id,
    existing: ruleAt(stored.rules, productId, 'direct_sale_extra', d.scope, d.scope === 'product' ? '' : d.scope_id),
    next: d.amount_iqd === null
      ? { state: 'INHERIT' as const, amount_usd: null, amount_iqd: null, source: 'OWNER' as const, legacy_result_id: null }
      : { state: 'ACTIVE' as const, amount_iqd: d.amount_iqd, amount_usd: null, source: 'OWNER' as const, legacy_result_id: null },
  }));
}

/** The rules as they would be after the writes. */
export function mergedRules(stored: ProductPricingData, writes: readonly RuleWrite[]): ProductPricingData['rules'] {
  const rows = stored.rules.map((r) => ({ ...r }));
  for (const w of writes) {
    const scopeId = w.scope === 'product' ? '' : w.scope_id;
    const at = rows.findIndex((r) => r.product_id === stored.product_id && r.kind === w.kind && r.scope === w.scope && r.scope_id === scopeId);
    const next = {
      id: at >= 0 ? rows[at]!.id : (w.new_id ?? `draft:${w.kind}:${w.scope}:${scopeId}`),
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
