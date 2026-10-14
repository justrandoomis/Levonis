/**
 * PRICING V2-5 — «نقل الأسعار إلى الدولار», THE SERVER SIDE (implementation
 * spec §6.1-§6.3; docs/PRICING-V2.md §3; owner decisions A1, B1, C1, D1).
 *
 * PROPOSALS (nothing written). «Today» is what customers pay now, per SKU ×
 * channel, prepaid and cash on delivery (`evaluateLegacy`, per SKU). Three
 * options, each PRICED BY THE V2 WRITER (`evaluateV2Write`: priceProductV2,
 * then planWritesFromUnits and the cart's own resolver in verifyPlan) and
 * diffed against today — the rows are the writer's result, never a helper's
 * claim:
 *   - keep_usd  «احتفظ بالأسعار الحالية» (price-first; the default for manual
 *               products): `proposeKeepUsd` — the fewest dollar points and
 *               discounts that reproduce today at U, the kept route per model
 *               the stock route when sold, else the cheapest (the owner may
 *               switch it per model, owner question Q4);
 *   - keep_cost (cost-first; the default for engine products): the stored
 *               inputs and minimum profit, the Direct Sale Extra folded in —
 *               T_new = T + ceil_cents(DSE ÷ U) and Δ = the same cents, at every
 *               scope that states either (`engineKeepTerms`); a direct-only
 *               product's purchase overlay folds into the ordinary inputs;
 *   - from_cost «سعّر من التكلفة»: today's inputs and minimum profit (a
 *               migrated dinar minimum converted up to the cent), Δ reproducing
 *               the kept route, floored at 0 — offered only when the cost
 *               prices every sellable SKU × channel.
 * Flags (owner-only; codes, names and final dinars): ROUTES_NOT_REPRODUCIBLE,
 * PREORDER_ABOVE_DIRECT, LEGACY_COLOUR_PRICE, MEMBER_PRICES_DROP,
 * DIRECT_PURCHASE_OVERLAY, OFF_STEP_PRICE, ROUNDING_STEP, COD_CHANGES,
 * FX_LINKED, BELOW_COST. `unchanged` = every prepaid AND cash-on-delivery
 * figure equal, complete, and no flag but FX_LINKED.
 *
 * THE COMMIT (§6.3), one product, one batch: the V2 writer's batch (fences,
 * tokens, points, discounts, inputs and rules, price rows, history, results,
 * state, audit) with the migration's own statements laid inside it — the
 * legacy snapshot (§2.5 payload v1, read by explicit columns), the folded
 * overlay deleted, the product's Direct Sale Extra rows deleted (both kept in
 * the snapshot) — `pricing_audit` migration/migrate_commit with the
 * idempotency key `v2mig:<pid>:<hash>` and `audit_log` pricing.v2.migrated.
 *
 * PRIVATE: everything here is the owner's (the routes sit behind
 * requireCostRead / assertCostWrite). Nothing is logged.
 */
import { addProcurementExact, ceilToPlaces, procurementExact, procurementExactText, quotientProcurementExact } from '@levonis/contracts/procurementCost';
import { ceilStep } from '@levonis/pricing/costToPrice';
import { engineKeepTerms, proposeKeepUsd, type KeepFlag, type TodayGrid, type TodaySku } from '@levonis/pricing/priceV2Migration';
import { parseUsdRuleAmount, resolveRuleAt, type RuleTarget } from '@levonis/pricing/ruleResolution';
import type { V2Discount, V2Method, V2PricePoint } from '@levonis/pricing/priceV2';
import { PREORDER_ROUTES, ROUTE_PROFILE, parseSkuComboKey, routeOfChannel, type PreorderRoute, type ShippingProfile, type SkuChannel } from '@levonis/pricing/skuChannel';
import { sha256Hex, newId } from '../../crypto';
import { canonical, unitRuleTarget } from '../procurementPreview';
import { evaluateLegacy, hasTypedMemberPrices, unitColorId, unitComboKey, unitOptionIds, type ModelToday } from '../legacy';
import { loadPreviewContext, loadProducts, type LoadedProduct } from '../load';
import { loadPricingRates } from '../rates';
import { INPUT_FIELD_NAMES, ownerRow, ruleAt, type InputFields, type InputWrite, type ProductPricingData, type RuleWrite, type StoredRuleRow } from '../store';
import { legacyConversions, priceImagesEach, withRuleIds } from '../engineWrite';
import { directPurchaseStore } from '../directPurchase';
import { evaluateDesired, loadV2Stores, storedMethodOf, type V2Read } from './api';
import { evaluateV2Write, type V2Evaluation } from './evaluate';
import { v2WriteStatements } from './write';

export type MigrationOption = 'keep_usd' | 'keep_cost' | 'from_cost';
export const MIGRATION_OPTIONS: readonly MigrationOption[] = ['keep_usd', 'keep_cost', 'from_cost'];
/** One product's migration batch (spec §6.3): the census maximum is 150 SKU rows, about 20 statements with chunking. */
export const V2_MIGRATION_STATEMENT_CAP = 300;
/** At most this many unmigrated products are proposed in one request (the list's totals; D1's per-invocation budget). */
export const MIGRATION_LIST_MAX = 200;

/** The owner's per-model choice of the route whose pre-order price is kept (Q4). */
export type KeepRoutes = Readonly<Record<string, PreorderRoute>>;

/** One SKU × channel of a proposal: today against the writer's result, prepaid and cash on delivery. */
export interface MigrationRow {
  combo_key: string;
  names: { ar: string; en: string; ckb: string };
  channel: SkuChannel;
  old_iqd: number | null;
  old_cod_iqd: number | null;
  new_iqd: number | null;
  new_cod_iqd: number | null;
  changed: boolean;
}

export interface MigrationFlag {
  code: string;
  [k: string]: unknown;
}

export interface MigrationProposal {
  option: MigrationOption;
  available: boolean;
  /** Why the option is not offered or not complete (codes only). */
  codes: string[];
  method: V2Method;
  points: V2PricePoint[];
  discounts: V2Discount[];
  inputWrites: InputWrite[];
  ruleWrites: RuleWrite[];
  /** Rules the commit deletes (the product's Direct Sale Extra, captured in the snapshot). */
  dropRules: StoredRuleRow[];
  /** The 0186 overlay is folded and its row deleted. */
  foldOverlay: boolean;
  kept_routes: Record<string, PreorderRoute>;
  rows: MigrationRow[];
  flags: MigrationFlag[];
  unchanged: boolean;
  large_change: boolean;
  drop_flag: boolean;
  hash: string | null;
  ev: V2Evaluation | null;
}

/* ------------------------------------------------------------------ today -- */

const ROUTE_OF_PROFILE: Readonly<Record<ShippingProfile, PreorderRoute>> = Object.fromEntries(
  (Object.entries(ROUTE_PROFILE) as Array<[PreorderRoute, ShippingProfile]>).map(([r, p]) => [p, r])
) as Record<ShippingProfile, PreorderRoute>;

/** What customers pay today, per SKU × channel sold (fees included). */
function todayOf(read: V2Read): { units: ModelToday[]; grid: TodayGrid } {
  const legacy = evaluateLegacy(read.loaded.id, read.loaded.doc, read.loaded.view, read.ctx, { perSku: true });
  const grid: TodaySku[] = legacy.units.map((u) => ({
    combo_key: unitComboKey(u),
    model_id: unitOptionIds(u)[0] ?? null,
    color_id: unitColorId(u),
    channels: u.channels
      .filter((c) => c.ok && c.prepaid_iqd !== null && c.cod_iqd !== null && c.prepaid_iqd >= 1 && c.cod_iqd >= 1)
      .map((c) => ({ channel: c.channel, prepaid_iqd: c.prepaid_iqd!, cod_iqd: c.cod_iqd! })),
  }));
  return { units: legacy.units, grid };
}

/** The stock route of a model: its own input's profile, else the product's. */
function stockRouteOf(stored: ProductPricingData, modelId: string | null): PreorderRoute | null {
  const own = modelId ? ownerRow(stored.inputs, 'option', modelId)?.shipping_profile : null;
  const base = ownerRow(stored.inputs, 'base', '')?.shipping_profile ?? null;
  const profile = own ?? base;
  return profile ? (ROUTE_OF_PROFILE[profile] ?? null) : null;
}

/* ---------------------------------------------------------------- options -- */

interface Desired {
  method: V2Method;
  points: V2PricePoint[];
  discounts: V2Discount[];
  inputWrites: InputWrite[];
  ruleWrites: RuleWrite[];
  dropRules: StoredRuleRow[];
  foldOverlay: boolean;
  kept_routes: Record<string, PreorderRoute>;
  flags: MigrationFlag[];
  codes: string[];
}

const cents = (iqd: number, u: string) => ceilToPlaces(quotientProcurementExact(procurementExact(iqd), procurementExact(u)), 2);

/** A direct-only product's purchase overlay folded into the ordinary inputs (D1): one write per scope it changes. */
function overlayWrites(stored: ProductPricingData): { writes: InputWrite[]; fields: string[] } {
  if (!stored.direct_purchase || !stored.direct_purchase.inputs.length) return { writes: [], fields: [] };
  const merged = directPurchaseStore(stored);
  const writes: InputWrite[] = [];
  const fields = new Set<string>();
  for (const m of merged.inputs) {
    if (m.origin !== 'MANUAL_OVERRIDE') continue;
    const existing = ownerRow(stored.inputs, m.scope, m.scope_id);
    const set: Partial<InputFields> = {};
    for (const k of INPUT_FIELD_NAMES) {
      const next = (m as unknown as Record<string, unknown>)[k] ?? null;
      if (((existing as unknown as Record<string, unknown> | null)?.[k] ?? null) !== next) {
        (set as Record<string, unknown>)[k] = next;
        fields.add(k);
      }
    }
    if (Object.keys(set).length) writes.push({ scope: m.scope, scope_id: m.scope_id, existing, set, source_ref: 'purchase' });
  }
  return { writes, fields: [...fields].sort() };
}

const dseRows = (read: V2Read): StoredRuleRow[] => read.stored.rules.filter((r) => r.product_id === read.loaded.id && r.kind === 'direct_sale_extra');

/** The rule target of a scope (the product, a model, a colour or an exact SKU). */
function targetAt(pid: string, scope: StoredRuleRow['scope'], scopeId: string): RuleTarget {
  if (scope === 'option') return unitRuleTarget(pid, { option_value_ids: [scopeId], color_id: null });
  if (scope === 'color') return unitRuleTarget(pid, { option_value_ids: [], color_id: scopeId });
  if (scope === 'sku') {
    const sel = parseSkuComboKey(scopeId) ?? { option_value_ids: [], color_id: null };
    return unitRuleTarget(pid, sel);
  }
  return unitRuleTarget(pid, { option_value_ids: [], color_id: null });
}

/** The resolved minimum profit in dollars at a target (a dinar minimum converted up to the cent), or null. */
function tUsdAt(rules: readonly StoredRuleRow[], target: RuleTarget, u: string): string | null {
  const r = resolveRuleAt(rules, 'target_profit', target, { usdIqdRate: u });
  if (r.status !== 'active') return null;
  if (r.amount_usd) return r.amount_usd;
  return r.amount_iqd ? procurementExactText(cents(r.amount_iqd, u)) : null;
}

/**
 * keep_cost: the inputs and T as stored, the Direct Sale Extra folded into T and
 * Δ at every scope that states either. A direct-only engine product (0186) priced
 * only its direct sale: its purchase overlay folds into the ordinary inputs and
 * its Δ reproduces today's frozen pre-order price instead.
 */
async function keepCost(read: V2Read, u: string, grid: TodayGrid, keep: KeepRoutes): Promise<Desired> {
  const pid = read.loaded.id;
  const fold = overlayWrites(read.stored);
  // Today's direct prices came from the overlay's store (a direct-only product): fold it, then resolve.
  const merged = directPurchaseStore(read.stored);
  const rules = merged.rules;
  const own = rules.filter((r) => r.product_id === pid && (r.kind === 'target_profit' || r.kind === 'direct_sale_extra') && r.state === 'ACTIVE');
  const scopes = new Map<string, { scope: StoredRuleRow['scope']; scope_id: string; ownDse: boolean }>();
  scopes.set('product\u0000', { scope: 'product', scope_id: '', ownDse: own.some((r) => r.kind === 'direct_sale_extra' && r.scope === 'product') });
  for (const r of own) {
    if (r.scope === 'product' || r.scope === 'global' || r.scope === 'category') continue;
    const k = `${r.scope}\u0000${r.scope_id}`;
    const at = scopes.get(k) ?? { scope: r.scope, scope_id: r.scope_id, ownDse: false };
    if (r.kind === 'direct_sale_extra') at.ownDse = true;
    scopes.set(k, at);
  }
  const codes: string[] = [];
  const ruleWrites: RuleWrite[] = [];
  const discounts: V2Discount[] = [];
  for (const s of scopes.values()) {
    const target = targetAt(pid, s.scope, s.scope_id);
    const t = tUsdAt(rules, target, u);
    if (!t || !parseUsdRuleAmount(t)) {
      if (s.scope === 'product' && !own.some((r) => r.kind === 'target_profit')) continue; // a narrower T decides each SKU
      codes.push('TARGET_PROFIT_MISSING');
      continue;
    }
    const dse = resolveRuleAt(rules, 'direct_sale_extra', target, { usdIqdRate: u });
    const dseIqd = dse.status === 'active' ? (dse.amount_iqd ?? 0) : 0;
    let terms: { t_new: string; discount: string };
    try {
      terms = engineKeepTerms(t, dseIqd, u);
    } catch {
      codes.push('TARGET_PROFIT_MISSING');
      continue;
    }
    if (!parseUsdRuleAmount(terms.t_new)) {
      codes.push('AMOUNT_TOO_LARGE');
      continue;
    }
    const scope = s.scope as RuleWrite['scope'];
    ruleWrites.push({
      kind: 'target_profit',
      scope,
      scope_id: s.scope_id,
      existing: ruleAt(read.stored.rules, pid, 'target_profit', scope, s.scope_id),
      next: { state: 'ACTIVE', amount_usd: terms.t_new, amount_iqd: null, source: 'OWNER', legacy_result_id: null },
    });
    if (s.scope === 'product' || s.ownDse) {
      const d = procurementExact(terms.discount);
      if (d.num > 0n || s.scope !== 'product') discounts.push({ scope: s.scope as V2Discount['scope'], scope_id: s.scope_id, usd: terms.discount });
    }
  }
  const flags: MigrationFlag[] = [];
  if (fold.writes.length) flags.push({ code: 'DIRECT_PURCHASE_OVERLAY', folded_fields: fold.fields });
  const writes = withRuleIds(ruleWrites);
  let kept: Record<string, PreorderRoute> = {};
  let finalDiscounts = discounts;
  if (read.stored.direct_purchase?.direct_only) {
    const reproduced = await reproducingDiscounts(read, u, grid, keep, fold.writes, writes);
    finalDiscounts = reproduced.discounts;
    kept = reproduced.kept;
  }
  return {
    method: 'cost',
    points: [],
    discounts: finalDiscounts,
    inputWrites: fold.writes,
    ruleWrites: writes,
    dropRules: dseRows(read),
    foldOverlay: !!read.stored.direct_purchase,
    kept_routes: kept,
    flags,
    codes: [...new Set(codes)],
  };
}

/**
 * The discounts that reproduce today's kept-route pre-order price under the
 * cost-first D (from_cost, and a direct-only engine product's frozen
 * pre-order): a first pass prices D with no discount; per SKU sold direct and
 * by pre-order, Δ = ceil_cents((E_D − ceil_1000(P_today)) ÷ U), floored at 0;
 * the most common Δ is the product's, a model whose own most common differs
 * gets an exception.
 */
async function reproducingDiscounts(
  read: V2Read,
  u: string,
  grid: TodayGrid,
  keep: KeepRoutes,
  inputWrites: InputWrite[],
  ruleWrites: RuleWrite[]
): Promise<{ discounts: V2Discount[]; kept: Record<string, PreorderRoute>; first: V2Evaluation }> {
  const first = await evaluateV2Write({
    loaded: read.loaded,
    stored: read.stored,
    v2: read.v2,
    ctx: read.ctx,
    rates: read.rates,
    control: read.control,
    method: 'cost',
    points: [],
    discounts: [],
    inputWrites,
    ruleWrites,
    image: read.image,
    acceptBlocked: true,
  });
  const kept: Record<string, PreorderRoute> = {};
  const deltas = new Map<string, { model: string | null; usd: string }>();
  for (const sku of grid) {
    const direct = sku.channels.find((c) => c.channel === 'direct_sale');
    const routes = sku.channels.filter((c) => routeOfChannel(c.channel) !== null);
    if (!direct || !routes.length) continue;
    const preferred = (sku.model_id ? keep[sku.model_id] : undefined) ?? stockRouteOf(read.stored, sku.model_id);
    const cheapest = [...routes].sort((a, b) => a.prepaid_iqd - b.prepaid_iqd || PREORDER_ROUTES.indexOf(routeOfChannel(a.channel)!) - PREORDER_ROUTES.indexOf(routeOfChannel(b.channel)!))[0]!;
    const route = routes.find((c) => routeOfChannel(c.channel) === preferred) ?? cheapest;
    kept[sku.combo_key] = routeOfChannel(route.channel)!;
    const exact = first.rows.find((r) => r.combo_key === sku.combo_key && r.channel === 'direct_sale')?.owner?.exact_iqd;
    if (!exact) continue;
    const gap = addProcurementExact(procurementExact(exact), { num: -BigInt(ceilStep(route.prepaid_iqd)), den: 1n });
    const usd = gap.num > 0n ? procurementExactText(ceilToPlaces(quotientProcurementExact(gap, procurementExact(u)), 2)) : '0';
    deltas.set(sku.combo_key, { model: sku.model_id, usd });
  }
  const mode = (values: string[]) => {
    const n = new Map<string, number>();
    for (const v of values) n.set(v, (n.get(v) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '0';
  };
  const productDelta = mode([...deltas.values()].map((d) => d.usd));
  const discounts: V2Discount[] = productDelta !== '0' ? [{ scope: 'product', scope_id: '', usd: productDelta }] : [];
  const models = new Set([...deltas.values()].map((d) => d.model).filter((m): m is string => m !== null));
  for (const m of models) {
    const own = mode([...deltas.values()].filter((d) => d.model === m).map((d) => d.usd));
    if (own !== productDelta) discounts.push({ scope: 'option', scope_id: m, usd: own });
  }
  return { discounts, kept, first };
}

/** from_cost: today's inputs and minimum profit (a dinar minimum converted up), Δ reproducing the kept route, floored at 0. */
async function fromCost(read: V2Read, u: string, grid: TodayGrid, keep: KeepRoutes): Promise<Desired> {
  const pid = read.loaded.id;
  const fold = overlayWrites(read.stored);
  const ruleWrites: RuleWrite[] = withRuleIds(
    legacyConversions(pid, read.stored.rules, u).map((c) => ({
      kind: 'target_profit' as const,
      scope: c.rule.scope as RuleWrite['scope'],
      scope_id: c.rule.scope_id,
      existing: c.rule,
      next: { state: 'ACTIVE' as const, amount_usd: c.amount_usd, amount_iqd: null, source: 'OWNER' as const, legacy_result_id: null },
    }))
  );
  const { discounts, kept, first } = await reproducingDiscounts(read, u, grid, keep, fold.writes, ruleWrites);
  const flags: MigrationFlag[] = [];
  if (fold.writes.length) flags.push({ code: 'DIRECT_PURCHASE_OVERLAY', folded_fields: fold.fields });
  return {
    method: 'cost',
    points: [],
    discounts,
    inputWrites: fold.writes,
    ruleWrites,
    dropRules: dseRows(read),
    foldOverlay: !!read.stored.direct_purchase,
    kept_routes: kept,
    flags,
    codes: first.complete ? [] : first.codes,
  };
}

/** keep_usd: `proposeKeepUsd`'s points and discounts (its flags kept; its rows are re-derived from the writer). */
function keepUsd(read: V2Read, u: string, grid: TodayGrid, keep: KeepRoutes): Desired {
  const fold = overlayWrites(read.stored);
  let proposal: ReturnType<typeof proposeKeepUsd>;
  try {
    proposal = proposeKeepUsd(grid, u, { keepRoute: (model) => (model ? keep[model] : undefined) ?? stockRouteOf(read.stored, model) });
  } catch {
    return { method: 'usd', points: [], discounts: [], inputWrites: [], ruleWrites: [], dropRules: [], foldOverlay: false, kept_routes: {}, flags: [], codes: ['PRICE_INVALID'] };
  }
  // The helper's own row flags are re-derived from the writer's rows (COD, off-step); FX_LINKED is added once by the proposal.
  const flags: MigrationFlag[] = (proposal.flags as KeepFlag[]).filter((f) => f.code !== 'COD_CHANGES' && f.code !== 'OFF_STEP_PRICE' && f.code !== 'FX_LINKED').map((f) => ({ ...f }));
  if (fold.writes.length) flags.push({ code: 'DIRECT_PURCHASE_OVERLAY', folded_fields: fold.fields });
  return {
    method: 'usd',
    points: proposal.points,
    discounts: proposal.discounts,
    inputWrites: fold.writes,
    ruleWrites: [],
    dropRules: dseRows(read),
    foldOverlay: !!read.stored.direct_purchase,
    kept_routes: { ...proposal.kept_routes },
    flags,
    codes: [],
  };
}

/* --------------------------------------------------------------- propose -- */

/** The default option: keep the engine's cost-first prices, else keep today's prices in dollars. */
export function defaultOption(read: V2Read): MigrationOption {
  return read.stored.state?.mode === 'engine' ? 'keep_cost' : 'keep_usd';
}

const namesOf = (unit: ModelToday | undefined) => ({ ar: unit?.names?.name_ar ?? unit?.option?.name_ar ?? '', en: unit?.names?.name_en ?? unit?.option?.name_en ?? '', ckb: unit?.names?.name_ckb ?? unit?.option?.name_ckb ?? '' });

/** One option's proposal, priced and verified by the V2 writer and diffed against today. Writes nothing. */
export async function proposeMigration(read: V2Read, option: MigrationOption, keep: KeepRoutes = {}): Promise<MigrationProposal> {
  const u = read.rates?.usd_iqd ?? null;
  const { units, grid } = todayOf(read);
  const empty = (codes: string[]): MigrationProposal => ({
    option, available: false, codes, method: option === 'keep_usd' ? 'usd' : 'cost', points: [], discounts: [], inputWrites: [], ruleWrites: [], dropRules: [], foldOverlay: false,
    kept_routes: {}, rows: [], flags: [], unchanged: false, large_change: false, drop_flag: false, hash: null, ev: null,
  });
  if (!u) return empty(['FX_RATE_MISSING']);
  if (storedMethodOf(read)) return empty(['PRICING_V2_MANAGED']);
  if (option === 'keep_cost' && read.stored.state?.mode !== 'engine') return empty(['PRICING_ENGINE_REQUIRED']);
  const desired = option === 'keep_usd' ? keepUsd(read, u, grid, keep) : option === 'keep_cost' ? await keepCost(read, u, grid, keep) : await fromCost(read, u, grid, keep);
  const ev = await evaluateDesired(read, { method: desired.method, points: desired.points, discounts: desired.discounts, inputWrites: desired.inputWrites, ruleWrites: desired.ruleWrites });
  const codes = [...new Set([...desired.codes, ...(ev.complete ? [] : ev.codes)])].sort();
  const unitOf = new Map(units.map((x) => [unitComboKey(x), x] as const));
  const rows: MigrationRow[] = ev.rows.map((r) => {
    const unit = unitOf.get(r.combo_key);
    const today = unit?.channels.find((c) => c.channel === r.channel) ?? null;
    const direct = ev.rows.find((x) => x.combo_key === r.combo_key && x.channel === 'direct_sale')?.new_iqd ?? null;
    const newCod = r.new_iqd === null ? null : routeOfChannel(r.channel) && direct !== null ? direct : r.new_iqd;
    const oldIqd = today?.ok ? today.prepaid_iqd : null;
    const oldCod = today?.ok ? today.cod_iqd : null;
    return { combo_key: r.combo_key, names: namesOf(unit), channel: r.channel, old_iqd: oldIqd, old_cod_iqd: oldCod, new_iqd: r.new_iqd, new_cod_iqd: newCod, changed: oldIqd !== r.new_iqd || oldCod !== newCod };
  });

  // The worker's flags (§6.2): names for ids, final dinars only.
  const flags: MigrationFlag[] = [];
  const modelName = (id: unknown) => read.loaded.doc.options.find((o) => o.id === id);
  const colourName = (id: unknown) => read.loaded.doc.colors.find((c) => c.id === id);
  const named = (o: { name_ar?: string; name_en?: string; name_ckb?: string } | undefined) => (o ? { ar: o.name_ar ?? '', en: o.name_en ?? '', ckb: o.name_ckb ?? '' } : null);
  for (const f of desired.flags) {
    if ('model_id' in f) flags.push({ ...f, model: named(modelName(f.model_id)) });
    else if ('color_id' in f) flags.push({ ...f, colour: named(colourName(f.color_id)) });
    else flags.push(f);
  }
  if (hasTypedMemberPrices(read.loaded.doc)) flags.push({ code: 'MEMBER_PRICES_DROP', count: memberPriceCount(read.loaded) });
  // The row flags describe a proposal the writer could price; an unavailable option lists its codes instead.
  const priced = ev.complete;
  const offStep = rows.filter((r) => r.old_iqd !== null && r.old_iqd % 1000 !== 0).map((r) => ({ combo_key: r.combo_key, channel: r.channel, old_iqd: r.old_iqd, new_iqd: r.new_iqd }));
  if (priced && offStep.length) flags.push({ code: 'OFF_STEP_PRICE', rows: offStep });
  if (priced && option === 'keep_cost') {
    const step = rows.filter((r) => r.old_iqd !== null && r.new_iqd !== null && r.new_iqd - r.old_iqd === 1000).map((r) => ({ combo_key: r.combo_key, channel: r.channel, old_iqd: r.old_iqd, new_iqd: r.new_iqd }));
    if (step.length) flags.push({ code: 'ROUNDING_STEP', rows: step });
  }
  const cod = rows.filter((r) => r.old_cod_iqd !== null && r.old_cod_iqd !== r.new_cod_iqd).map((r) => ({ combo_key: r.combo_key, channel: r.channel, old_cod_iqd: r.old_cod_iqd, new_cod_iqd: r.new_cod_iqd }));
  if (priced && cod.length) flags.push({ code: 'COD_CHANGES', rows: cod });
  if (priced && option === 'keep_usd') {
    const below = ev.rows.filter((r) => r.owner?.below_cost).map((r) => ({ combo_key: r.combo_key, channel: r.channel, new_iqd: r.new_iqd }));
    if (below.length) flags.push({ code: 'BELOW_COST', rows: below });
    flags.push({ code: 'FX_LINKED' });
  }
  const available = ev.complete && (option !== 'from_cost' || desired.codes.length === 0);
  const unchanged = available && rows.every((r) => !r.changed) && flags.every((f) => f.code === 'FX_LINKED');
  const hash = available && ev.hash ? await sha256Hex(canonical({ v: 'v2mig', option, keep: Object.entries(keep).sort(), ev: ev.hash })) : null;
  return {
    option,
    available,
    codes,
    method: desired.method,
    points: desired.points,
    discounts: desired.discounts,
    inputWrites: desired.inputWrites,
    ruleWrites: desired.ruleWrites,
    dropRules: desired.dropRules,
    foldOverlay: desired.foldOverlay,
    kept_routes: desired.kept_routes,
    rows,
    flags,
    unchanged,
    large_change: ev.large_change,
    drop_flag: ev.drop_flag,
    hash,
    ev,
  };
}

/** How many typed member prices the migration drops (`MEMBER_CLEARED`): product, models, cells, routes, colours. */
function memberPriceCount(loaded: LoadedProduct): number {
  const typed = (r: { prime_price_iqd?: unknown; pro_price_iqd?: unknown; prime_adjust_iqd?: unknown; pro_adjust_iqd?: unknown } | null | undefined) =>
    !!r && [r.prime_price_iqd, r.pro_price_iqd, r.prime_adjust_iqd, r.pro_adjust_iqd].some((v) => v !== null && v !== undefined);
  let n = typed(loaded.doc) ? 1 : 0;
  for (const o of loaded.doc.options) {
    if (typed(o)) n += 1;
    for (const f of o.fulfillments ?? []) {
      if (typed(f)) n += 1;
      for (const t of f.transports ?? []) if (typed(t)) n += 1;
    }
  }
  for (const c of loaded.doc.colors) if (typed(c)) n += 1;
  return n;
}

/* ------------------------------------------------------------------- dto -- */

/** The owner's view of a proposal (cost routes only: every figure here is the owner's). */
export function proposalDto(p: MigrationProposal) {
  return {
    option: p.option,
    available: p.available,
    codes: p.codes,
    method: p.method,
    v2_proposal: {
      points: p.points.map((x) => ({ scope: x.scope, id: x.scope_id, kind: x.kind, usd: x.usd })),
      discounts: p.discounts.map((x) => ({ scope: x.scope, id: x.scope_id, usd: x.usd })),
      minimum_profit: p.ruleWrites.map((w) => ({ scope: w.scope, id: w.scope_id, usd: w.next.amount_usd })),
      folded_inputs: p.inputWrites.map((w) => ({ scope: w.scope, id: w.scope_id, fields: Object.keys(w.set).sort() })),
      retired_direct_sale_extra: p.dropRules.length,
    },
    kept_routes: p.kept_routes,
    rows: [...p.rows].sort((a, b) => Number(b.changed) - Number(a.changed)),
    changed: p.rows.filter((r) => r.changed).length,
    flags: p.flags,
    unchanged: p.unchanged,
    large_change: p.large_change,
    drop_flag: p.drop_flag,
    review_hash: p.hash,
  };
}

/* --------------------------------------------------------------- batched -- */

/** Several products' V2 reads in a bounded number of statements (the list): one load per kind, chunked. */
export async function loadMigrationReads(db: D1Database, ids: readonly string[]): Promise<Map<string, V2Read>> {
  const out = new Map<string, V2Read>();
  if (!ids.length) return out;
  // One read after another: each store read is a batch (one snapshot), never two at once.
  const loaded = await loadProducts(db, ids);
  // A database before 0181 reads every product as unmigrated and unstored (api.ts `loadV2Stores`).
  const { stored, v2, control } = await loadV2Stores(db, ids);
  const ctx = await loadPreviewContext(db);
  const rates = await loadPricingRates(db);
  const images = await priceImagesEach(db, ids);
  for (const id of ids) {
    const l = loaded.get(id);
    if (!l) continue;
    out.set(id, { loaded: l, stored: stored.get(id)!, v2: v2.get(id) ?? null, ctx, rates, control, image: images.get(id) ?? '' });
  }
  return out;
}

/* ---------------------------------------------------------------- commit -- */

/** The idempotency key of one product's migration commit. */
export const migrationKey = (pid: string, hash: string) => `v2mig:${pid}:${hash}`;

/** Run reads one after another (never two transactions at once on the test binding). */
async function sequence<T>(jobs: ReadonlyArray<Promise<T> | (() => Promise<T>)>): Promise<T[]> {
  const out: T[] = [];
  for (const j of jobs) out.push(await (typeof j === 'function' ? j() : j));
  return out;
}

/**
 * §2.5 payload v1: every legacy money field of the product, read by explicit
 * column lists, plus today's grid — the rollback copy (V2-7's tool).
 */
async function snapshotPayload(db: D1Database, read: V2Read): Promise<string> {
  const pid = read.loaded.id;
  const MONEY = 'regular_price_iqd, prime_price_iqd, pro_price_iqd, cost_iqd, regular_adjust_iqd, prime_adjust_iqd, pro_adjust_iqd, cost_adjust_iqd';
  const rows = async (sql: string) => {
    try {
      return (await db.prepare(sql).bind(pid).all<Record<string, unknown>>()).results ?? [];
    } catch (e) {
      if (/no such (table|column)/i.test(e instanceof Error ? e.message : String(e))) return [];
      throw e;
    }
  };
  const [product] = await rows('SELECT price_iqd, prime_price_iqd, pro_price_iqd, direct_surcharge_iqd, preorder_transports, original_price_iqd, product_cost_iqd FROM products WHERE id = ?');
  const [values, fulfillments, transports, colors, variants, skuPrices, state, inputs, rules, skuCosts] = await sequence([
    rows(`SELECT id, active, ${MONEY} FROM product_option_values WHERE product_id = ? ORDER BY id`),
    rows(`SELECT id, option_id, fulfillment_type, enabled, ${MONEY} FROM product_option_fulfillment WHERE product_id = ? ORDER BY id`),
    rows(`SELECT id, fulfillment_id, method, enabled, surcharge_iqd, ${MONEY} FROM product_option_transports WHERE product_id = ? ORDER BY id`),
    rows(`SELECT id, active, ${MONEY} FROM product_colors WHERE product_id = ? ORDER BY id`),
    rows('SELECT id, combo_key, active, regular_price_iqd, prime_price_iqd, pro_price_iqd, cost_iqd FROM product_variants WHERE product_id = ? ORDER BY id'),
    rows('SELECT combo_key, channel, regular_price_iqd, source, write_seq FROM product_sku_prices WHERE product_id = ? ORDER BY combo_key, channel'),
    rows('SELECT mode, inputs_seq, write_seq FROM product_pricing_state WHERE product_id = ?'),
    rows(
      'SELECT scope, scope_id, origin, supplier_cost_amount, supplier_cost_delta, supplier_cost_currency, shipping_profile, shipping_weight_g, shipping_length_mm, shipping_width_mm, shipping_height_mm, manual_cbm, additional_cost_iqd, version FROM pricing_inputs WHERE product_id = ? ORDER BY scope, scope_id, origin'
    ),
    rows('SELECT id, kind, scope, scope_id, state, amount_usd, amount_iqd, source, version FROM pricing_rules WHERE product_id = ? ORDER BY id'),
    rows('SELECT combo_key, channel, computed_price_iqd, replacement_cost_iqd, target_profit_iqd FROM pricing_sku_costs WHERE product_id = ? ORDER BY combo_key, channel'),
  ]);
  const today = todayOf(read).units.flatMap((u) => u.channels.filter((c) => c.ok).map((c) => ({ combo_key: unitComboKey(u), channel: c.channel, prepaid_iqd: c.prepaid_iqd, cod_iqd: c.cod_iqd, fee_iqd: c.fee_iqd })));
  return JSON.stringify({
    v: 1,
    product_id: pid,
    product: product ?? null,
    values,
    fulfillments,
    transports,
    colors,
    variants,
    sku_prices: skuPrices,
    state: state[0] ?? null,
    inputs,
    rules,
    sku_costs: skuCosts,
    direct_purchase: read.stored.direct_purchase ?? null,
    today,
  });
}

export interface MigrationCommitOptions {
  actor: string;
  now: string;
  hash: string;
}

/** The one batch of a product's migration (spec §6.3). Throws when the proposal is not available. */
export async function migrationStatements(db: D1Database, read: V2Read, p: MigrationProposal, o: MigrationCommitOptions): Promise<D1PreparedStatement[]> {
  if (!p.available || !p.ev || !p.ev.complete || !read.rates?.usd_iqd) throw new Error('migrationStatements: the proposal is not available');
  const pid = read.loaded.id;
  const payload = await snapshotPayload(db, read);
  const sha = await sha256Hex(payload);
  const migration: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO pricing_legacy_snapshots (id, product_id, reason, captured_at, usd_iqd_rate, fx_version, actor, payload_json, payload_sha256)
         VALUES (?, ?, 'v2_migration', ?, ?, ?, ?, ?, ?)`
      )
      .bind(newId('v2snap'), pid, o.now, read.rates.usd_iqd, Math.max(1, read.rates.pair_versions.USD_IQD), o.actor, payload, sha),
    ...(p.dropRules.length ? [db.prepare("DELETE FROM pricing_rules WHERE product_id = ? AND kind = 'direct_sale_extra'").bind(pid)] : []),
    ...(p.foldOverlay ? [db.prepare('DELETE FROM pricing_direct_purchase WHERE product_id = ?').bind(pid)] : []),
  ];
  return v2WriteStatements(db, p.ev, {
    actor: o.actor,
    now: o.now,
    source: 'migration',
    idempotencyKey: migrationKey(pid, o.hash),
    migration,
    migrationCommit: true,
    auditDetail: { option: p.option, flags: p.flags.map((f) => f.code) },
  });
}
