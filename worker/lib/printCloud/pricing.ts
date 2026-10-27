/**
 * THE QUOTE ENGINE (docs/PRINT_CLOUD.md §4). Server-side, integer dinars,
 * and the only place a Print Cloud price is ever computed.
 *
 * Three kinds of line:
 *
 *   credit_package  a package of a tier («24 hours of X2D Combo — 36,000 IQD»),
 *                   possibly a bundle that carries declared material lines;
 *   credit_hours    a custom number of hours of a tier, at the tier's hourly
 *                   rate, in the tier's step — only where the owner enabled it;
 *   material        grams (or pieces, sets, millimetres) of a variant.
 *
 * MATERIAL PRICES. An exact pack size (100 g, 250 g, 500 g, 1 kg) costs its
 * pack price. Any other permitted quantity is priced per unit from the
 * highest bracket it reaches (e.g. ≥ 500 g at 29.000 IQD/g), rounded UP to the
 * configured step, and — unless the owner turns it off — never above the
 * price of the smallest pack that covers it, so 950 g never costs more than
 * 1 kg. The tier is chosen from THIS purchase's quantity alone: grams the
 * customer already owns never move a purchase into a cheaper bracket.
 *
 * Nothing here reserves anything. A quote is a price promise until it
 * expires; stock is held only when an order is created from it.
 */
import { many, one } from './db';
import { invalid, pcError } from './errors';
import { inventoryAccountId } from './inventory';
import type { PrintCloudConfig } from './settings';
import { sellable, position } from './warehouse';
import { apportion, iso, mulDivRound, roundUpTo, SECONDS_PER_HOUR } from './util';

export interface TierRow {
  mode: 'pack' | 'bracket';
  min_qty: number;
  pack_price_iqd: number | null;
  unit_price_milli_iqd: number | null;
}

export interface MaterialPrice {
  price_iqd: number;
  rule:
    | { type: 'pack'; pack_qty: number; pack_price_iqd: number }
    | { type: 'bracket'; min_qty: number; unit_price_milli_iqd: number; raw_iqd: number; rounded_to_iqd: number };
  /** Set when the next pack's price was lower and the price was capped at it. */
  capped_by_pack_qty: number | null;
  /** Thousandths of a dinar per base unit, for display. */
  effective_unit_price_milli_iqd: number;
}

/** Price `qty` base units from a variant's active tiers. Null = no tier prices this quantity. */
export function priceMaterial(qty: number, tiers: TierRow[], opts: { rounding: number; capAtNextPack: boolean }): MaterialPrice | null {
  if (!Number.isSafeInteger(qty) || qty <= 0) return null;
  const packs = tiers.filter((t) => t.mode === 'pack' && t.pack_price_iqd !== null).sort((a, b) => a.min_qty - b.min_qty);
  const brackets = tiers.filter((t) => t.mode === 'bracket' && t.unit_price_milli_iqd !== null).sort((a, b) => a.min_qty - b.min_qty);
  const exact = packs.find((p) => p.min_qty === qty);
  let result: MaterialPrice | null = null;
  if (exact) {
    result = {
      price_iqd: Number(exact.pack_price_iqd),
      rule: { type: 'pack', pack_qty: exact.min_qty, pack_price_iqd: Number(exact.pack_price_iqd) },
      capped_by_pack_qty: null,
      effective_unit_price_milli_iqd: 0,
    };
  } else {
    const bracket = [...brackets].reverse().find((b) => b.min_qty <= qty);
    if (!bracket) return null;
    const unit = Number(bracket.unit_price_milli_iqd);
    const raw = mulDivRound(unit, qty, 1000);
    const rounded = roundUpTo(raw, opts.rounding);
    result = {
      price_iqd: rounded,
      rule: { type: 'bracket', min_qty: bracket.min_qty, unit_price_milli_iqd: unit, raw_iqd: raw, rounded_to_iqd: opts.rounding },
      capped_by_pack_qty: null,
      effective_unit_price_milli_iqd: 0,
    };
    if (opts.capAtNextPack) {
      const cover = packs.find((p) => p.min_qty >= qty);
      if (cover && Number(cover.pack_price_iqd) < result.price_iqd) {
        result.price_iqd = Number(cover.pack_price_iqd);
        result.capped_by_pack_qty = cover.min_qty;
      }
    }
  }
  result.effective_unit_price_milli_iqd = mulDivRound(result.price_iqd, 1000, qty);
  return result;
}

/**
 * The balance «top up» aims at when the customer names no target, in the
 * variant's base unit (1,000 g = 1 kg). POST /me/inventory/top-up-quote
 * applies it and GET /me/inventory states it per row, so a screen can say
 * what an empty target means instead of guessing.
 */
export const TOP_UP_DEFAULT_TARGET_QTY = 1000;

/** «Top up to 1 kg»: how much to buy so the balance reaches `target`, in the variant's step. */
export function topUpQuantity(owned: number, target: number, step: number, min: number): number {
  if (target <= owned) return 0;
  const gap = target - owned;
  const stepped = Math.ceil(gap / step) * step;
  return Math.max(min, stepped);
}

// ------------------------------------------------------------------ lines

export type FulfillmentMode = 'inventory' | 'delivery' | 'project';

export type QuoteLineInput =
  | { kind: 'credit_package'; package_id: string; quantity: number }
  | { kind: 'credit_hours'; tier_id: string; seconds: number }
  | { kind: 'material'; variant_id: string; quantity: number; unit: string | null; fulfillment: FulfillmentMode; project_id: string | null };

export interface BundleItem {
  variant_id: string;
  qty: number;
  value_iqd: number;
}

export interface PricedLine {
  line_no: number;
  kind: 'credit_package' | 'credit_hours' | 'material';
  tier_id: string | null;
  package_id: string | null;
  variant_id: string | null;
  category_code: string | null;
  quantity: number;
  seconds: number;
  base_price_iqd: number;
  discount_iqd: number;
  final_price_iqd: number;
  fulfillment: 'credits' | FulfillmentMode;
  project_id: string | null;
  expires_after_days: number | null;
  /** Material a bundle package grants alongside its hours (held and allocated like a purchase). */
  bundle: BundleItem[];
  breakdown: Record<string, unknown>;
  stock: { available: boolean; sellable_qty: number } | null;
}

export interface PromotionRow {
  id: string;
  code: string | null;
  scope: string;
  percent_bps: number;
  amount_off_iqd: number;
  min_subtotal_iqd: number;
  membership: string | null;
  starts_at: string | null;
  ends_at: string | null;
  max_redemptions: number | null;
  redemptions: number;
}

export interface PricedQuote {
  lines: PricedLine[];
  subtotal_iqd: number;
  discount_iqd: number;
  total_iqd: number;
  promotions: Array<{ id: string; code: string | null; discount_iqd: number }>;
  orderable: boolean;
  problems: Array<{ line_no: number; code: string }>;
}

export function parseQuoteLines(raw: unknown): QuoteLineInput[] {
  if (!Array.isArray(raw) || !raw.length) throw invalid('lines', 'array_required');
  if (raw.length > 25) throw invalid('lines', 'too_many');
  return raw.map((l, i): QuoteLineInput => {
    if (!l || typeof l !== 'object') throw invalid(`lines[${i}]`, 'object_required');
    const o = l as Record<string, unknown>;
    const intOf = (v: unknown, f: string, min: number, max: number) => {
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) throw invalid(`lines[${i}].${f}`, 'integer_required');
      return v;
    };
    const idOf = (v: unknown, f: string) => {
      if (typeof v !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(v)) throw invalid(`lines[${i}].${f}`, 'reference');
      return v;
    };
    switch (o.kind) {
      case 'credit_package':
        return { kind: 'credit_package', package_id: idOf(o.package_id, 'package_id'), quantity: o.quantity === undefined ? 1 : intOf(o.quantity, 'quantity', 1, 1000) };
      case 'credit_hours':
        return { kind: 'credit_hours', tier_id: idOf(o.tier_id, 'tier_id'), seconds: intOf(o.seconds, 'seconds', 60, 100_000_000) };
      case 'material': {
        const f = o.fulfillment ?? 'inventory';
        if (f !== 'inventory' && f !== 'delivery' && f !== 'project') throw invalid(`lines[${i}].fulfillment`, 'not_allowed');
        if (f === 'project' && typeof o.project_id !== 'string') throw invalid(`lines[${i}].project_id`, 'required');
        return {
          kind: 'material',
          variant_id: idOf(o.variant_id, 'variant_id'),
          quantity: intOf(o.quantity, 'quantity', 1, 100_000_000),
          unit: typeof o.unit === 'string' ? o.unit : null,
          fulfillment: f,
          project_id: f === 'project' ? idOf(o.project_id, 'project_id') : null,
        };
      }
      default:
        throw invalid(`lines[${i}].kind`, 'not_allowed');
    }
  });
}

function parseBundle(raw: unknown): BundleItem[] {
  if (typeof raw !== 'string') return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v
      .filter((b): b is Record<string, unknown> => !!b && typeof b === 'object')
      .map((b) => ({ variant_id: String(b.variant_id ?? ''), qty: Number(b.qty), value_iqd: Number(b.value_iqd ?? 0) }))
      .filter((b) => b.variant_id && Number.isSafeInteger(b.qty) && b.qty > 0 && Number.isSafeInteger(b.value_iqd) && b.value_iqd >= 0);
  } catch {
    return [];
  }
}

function inWindow(now: Date, from: string | null, until: string | null): boolean {
  const t = iso(now);
  return (!from || from <= t) && (!until || until > t);
}

function promoMatches(scope: string, line: PricedLine): boolean {
  if (scope === 'all') return true;
  if (scope === 'credits') return line.kind !== 'material';
  if (scope === 'materials') return line.kind === 'material';
  if (scope.startsWith('tier:')) return line.tier_id === scope.slice(5);
  if (scope.startsWith('variant:')) return line.variant_id === scope.slice(8);
  if (scope.startsWith('category:')) return line.category_code === scope.slice(9);
  return false;
}

/** The discount one promotion gives this set of lines, per line (exact integers). */
export function promotionDiscount(p: PromotionRow, lines: PricedLine[]): number[] {
  const eligible = lines.map((l) => (promoMatches(p.scope, l) ? l.base_price_iqd : 0));
  const eligibleSubtotal = eligible.reduce((s, v) => s + v, 0);
  if (eligibleSubtotal <= 0 || eligibleSubtotal < p.min_subtotal_iqd) return lines.map(() => 0);
  const total = Math.min(eligibleSubtotal, mulDivRound(eligibleSubtotal, p.percent_bps, 10000) + p.amount_off_iqd);
  return apportion(total, eligible);
}

export interface QuoteContext {
  userId: string;
  config: PrintCloudConfig;
  now: Date;
  coupon: string | null;
  /** The customer's membership tier from the MembershipAdapter, or null when not connected. */
  membership: string | null;
}

/** Price every line, apply promotions, check limits and stock. Reads only. */
export async function priceQuote(db: D1Database, inputs: QuoteLineInput[], q: QuoteContext): Promise<PricedQuote> {
  const lines: PricedLine[] = [];
  const problems: PricedQuote['problems'] = [];
  const materialQty = new Map<string, number>();
  for (const [i, input] of inputs.entries()) {
    const lineNo = i + 1;
    if (input.kind === 'credit_package') {
      const pkg = await one<Record<string, unknown>>(
        db,
        `SELECT p.*, t.active AS tier_active FROM pc_credit_packages p JOIN pc_credit_tiers t ON t.id = p.tier_id WHERE p.id = ?`,
        input.package_id
      );
      if (!pkg || !pkg.active || !pkg.tier_active || !inWindow(q.now, pkg.valid_from as string | null, pkg.valid_until as string | null)) {
        throw pcError('NOT_FOUND', { line_no: lineNo, field: 'package_id' });
      }
      if (input.quantity < Number(pkg.min_quantity) || input.quantity > Number(pkg.max_quantity)) {
        throw pcError('QUANTITY_NOT_ALLOWED', { line_no: lineNo, min: pkg.min_quantity, max: pkg.max_quantity });
      }
      if (pkg.max_per_customer !== null) {
        const bought = await one<{ n: number }>(
          db,
          `SELECT COALESCE(SUM(l.quantity), 0) AS n FROM pc_order_lines l JOIN pc_orders o ON o.id = l.order_id
            WHERE o.user_id = ? AND l.package_id = ? AND o.status IN ('awaiting_payment', 'fulfilled', 'partially_refunded')`,
          q.userId,
          input.package_id
        );
        if (Number(bought?.n ?? 0) + input.quantity > Number(pkg.max_per_customer)) throw pcError('LIMIT_REACHED', { line_no: lineNo });
      }
      const bundle = parseBundle(pkg.bundle_json).map((b) => ({ ...b, qty: b.qty * input.quantity, value_iqd: b.value_iqd * input.quantity }));
      const base = Number(pkg.price_iqd) * input.quantity;
      if (bundle.reduce((s, b) => s + b.value_iqd, 0) > base) throw pcError('PRICE_NOT_CONFIGURED', { line_no: lineNo, reason: 'bundle_value_exceeds_price' });
      for (const b of bundle) materialQty.set(b.variant_id, (materialQty.get(b.variant_id) ?? 0) + b.qty);
      lines.push({
        line_no: lineNo,
        kind: 'credit_package',
        tier_id: String(pkg.tier_id),
        package_id: input.package_id,
        variant_id: null,
        category_code: null,
        quantity: input.quantity,
        seconds: Number(pkg.seconds) * input.quantity,
        base_price_iqd: base,
        discount_iqd: 0,
        final_price_iqd: base,
        fulfillment: 'credits',
        project_id: null,
        expires_after_days: pkg.expires_after_days === null ? null : Number(pkg.expires_after_days),
        bundle,
        breakdown: { package_code: pkg.code, unit_price_iqd: Number(pkg.price_iqd), seconds_each: Number(pkg.seconds), expires_after_days: pkg.expires_after_days },
        stock: null,
      });
    } else if (input.kind === 'credit_hours') {
      const tier = await one<Record<string, unknown>>(db, 'SELECT * FROM pc_credit_tiers WHERE id = ?', input.tier_id);
      if (!tier || !tier.active) throw pcError('NOT_FOUND', { line_no: lineNo, field: 'tier_id' });
      if (!tier.custom_hours_enabled) throw pcError('PRICE_NOT_CONFIGURED', { line_no: lineNo, reason: 'custom_hours_disabled' });
      if (input.seconds < Number(tier.min_custom_seconds) || input.seconds % Number(tier.custom_step_seconds) !== 0) {
        throw pcError('QUANTITY_NOT_ALLOWED', { line_no: lineNo, min_seconds: tier.min_custom_seconds, step_seconds: tier.custom_step_seconds });
      }
      const base = mulDivRound(Number(tier.hourly_rate_iqd), input.seconds, SECONDS_PER_HOUR);
      lines.push({
        line_no: lineNo,
        kind: 'credit_hours',
        tier_id: input.tier_id,
        package_id: null,
        variant_id: null,
        category_code: null,
        quantity: 1,
        seconds: input.seconds,
        base_price_iqd: base,
        discount_iqd: 0,
        final_price_iqd: base,
        fulfillment: 'credits',
        project_id: null,
        expires_after_days: null,
        bundle: [],
        breakdown: { hourly_rate_iqd: Number(tier.hourly_rate_iqd) },
        stock: null,
      });
    } else {
      const v = await one<Record<string, unknown>>(
        db,
        `SELECT v.*, p.category_code, p.active AS product_active, u.dimension
           FROM pc_variants v JOIN pc_products p ON p.id = v.product_id JOIN pc_units u ON u.code = v.unit_code
          WHERE v.id = ?`,
        input.variant_id
      );
      if (!v || !v.active || !v.product_active) throw pcError('NOT_FOUND', { line_no: lineNo, field: 'variant_id' });
      let qty = input.quantity;
      if (input.unit && input.unit !== v.unit_code) {
        const unit = await one<{ base_code: string; factor_to_base: number }>(db, 'SELECT base_code, factor_to_base FROM pc_units WHERE code = ?', input.unit);
        // Only a unit of the SAME base converts (kg → g); grams never become pieces.
        if (!unit || unit.base_code !== v.unit_code) throw invalid(`lines[${i}].unit`, 'incompatible_unit');
        qty = qty * Number(unit.factor_to_base);
        if (!Number.isSafeInteger(qty)) throw invalid(`lines[${i}].quantity`, 'too_large');
      }
      const modes = JSON.parse(String(v.fulfillment_modes_json)) as string[];
      if (!modes.includes(input.fulfillment)) throw pcError('VALIDATION', { line_no: lineNo, field: 'fulfillment', reason: 'not_offered_for_variant' });
      if (input.fulfillment === 'project') {
        const project = await one<{ id: string }>(db, 'SELECT id FROM pc_projects WHERE id = ? AND user_id = ?', input.project_id, q.userId);
        if (!project) throw pcError('NOT_FOUND', { line_no: lineNo, field: 'project_id' });
      }
      if (qty < Number(v.min_purchase_qty) || qty > Number(v.max_purchase_qty) || qty % Number(v.purchase_step_qty) !== 0) {
        throw pcError('QUANTITY_NOT_ALLOWED', {
          line_no: lineNo,
          min: Number(v.min_purchase_qty),
          max: Number(v.max_purchase_qty),
          step: Number(v.purchase_step_qty),
        });
      }
      if (v.max_per_customer_qty !== null) {
        const owned = await one<{ n: number }>(
          db,
          `SELECT COALESCE(SUM(l.quantity), 0) AS n FROM pc_order_lines l JOIN pc_orders o ON o.id = l.order_id
            WHERE o.user_id = ? AND l.variant_id = ? AND l.kind = 'material' AND o.status IN ('awaiting_payment', 'fulfilled', 'partially_refunded')`,
          q.userId,
          input.variant_id
        );
        if (Number(owned?.n ?? 0) + qty > Number(v.max_per_customer_qty)) throw pcError('LIMIT_REACHED', { line_no: lineNo });
      }
      const tiers = await many<TierRow>(
        db,
        'SELECT mode, min_qty, pack_price_iqd, unit_price_milli_iqd FROM pc_price_tiers WHERE variant_id = ? AND active = 1',
        input.variant_id
      );
      const price = priceMaterial(qty, tiers, { rounding: q.config.material_price_rounding_iqd, capAtNextPack: q.config.cap_custom_price_at_next_pack });
      if (!price) throw pcError('PRICE_NOT_CONFIGURED', { line_no: lineNo, quantity: qty });
      materialQty.set(input.variant_id, (materialQty.get(input.variant_id) ?? 0) + qty);
      lines.push({
        line_no: lineNo,
        kind: 'material',
        tier_id: null,
        package_id: null,
        variant_id: input.variant_id,
        category_code: String(v.category_code),
        quantity: qty,
        seconds: 0,
        base_price_iqd: price.price_iqd,
        discount_iqd: 0,
        final_price_iqd: price.price_iqd,
        fulfillment: input.fulfillment,
        project_id: input.project_id,
        expires_after_days: null,
        bundle: [],
        breakdown: { unit_code: v.unit_code, ...price },
        stock: null,
      });
    }
  }

  // Stock visibility: not a reservation — the order's batch holds and fences it.
  const stockByVariant = new Map<string, number>();
  for (const variantId of materialQty.keys()) stockByVariant.set(variantId, sellable(await position(db, variantId)));
  for (const line of lines) {
    if (line.kind === 'material' && line.variant_id) {
      const s = stockByVariant.get(line.variant_id) ?? 0;
      line.stock = { available: s >= (materialQty.get(line.variant_id) ?? 0), sellable_qty: Math.max(0, s) };
      if (!line.stock.available) problems.push({ line_no: line.line_no, code: 'OUT_OF_STOCK' });
    }
    if (line.bundle.length) {
      const ok = line.bundle.every((b) => (stockByVariant.get(b.variant_id) ?? 0) >= (materialQty.get(b.variant_id) ?? 0));
      if (!ok) problems.push({ line_no: line.line_no, code: 'OUT_OF_STOCK' });
    }
  }

  // Promotions: the best automatic one, plus the customer's coupon if valid.
  const promos = await many<PromotionRow & { active: number }>(
    db,
    `SELECT id, code, scope, percent_bps, amount_off_iqd, min_subtotal_iqd, membership, starts_at, ends_at, max_redemptions, redemptions, active
       FROM pc_promotions WHERE active = 1 AND (code IS NULL OR code = ?)`,
    q.coupon ?? ''
  );
  const usable = promos.filter(
    (p) =>
      inWindow(q.now, p.starts_at, p.ends_at) &&
      (p.max_redemptions === null || Number(p.redemptions) < Number(p.max_redemptions)) &&
      (!p.membership || p.membership === q.membership)
  );
  if (q.coupon && !usable.some((p) => p.code === q.coupon)) throw invalid('coupon', 'not_valid');
  const applied: PricedQuote['promotions'] = [];
  const automatic = usable
    .filter((p) => p.code === null)
    .map((p) => ({ p, d: promotionDiscount(p, lines) }))
    .map((x) => ({ ...x, total: x.d.reduce((s, v) => s + v, 0) }))
    .filter((x) => x.total > 0)
    .sort((a, b) => b.total - a.total || a.p.id.localeCompare(b.p.id));
  const chosen = [...automatic.slice(0, 1), ...usable.filter((p) => p.code !== null).map((p) => ({ p, d: promotionDiscount(p, lines), total: 0 }))];
  for (const { p, d } of chosen) {
    let given = 0;
    d.forEach((amount, idx) => {
      const room = lines[idx].final_price_iqd;
      const take = Math.min(room, amount);
      lines[idx].discount_iqd += take;
      lines[idx].final_price_iqd -= take;
      given += take;
    });
    if (given > 0) applied.push({ id: p.id, code: p.code, discount_iqd: given });
  }
  const subtotal = lines.reduce((s, l) => s + l.base_price_iqd, 0);
  const discount = lines.reduce((s, l) => s + l.discount_iqd, 0);
  return { lines, subtotal_iqd: subtotal, discount_iqd: discount, total_iqd: subtotal - discount, promotions: applied, orderable: problems.length === 0, problems };
}

/** The customer's current balance of a variant (for «top up to 1 kg»). */
export async function ownedQty(db: D1Database, userId: string, variantId: string): Promise<number> {
  const row = await one<{ available_qty: number; reserved_qty: number }>(
    db,
    'SELECT available_qty, reserved_qty FROM pc_inventory_accounts WHERE id = ?',
    inventoryAccountId(userId, variantId)
  );
  return row ? Number(row.available_qty) + Number(row.reserved_qty) : 0;
}
