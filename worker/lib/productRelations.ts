/**
 * Relational option groups, values, colours and their links — mandate §7.
 *
 * THE VISIBILITY ALGEBRA, stated once and implemented once:
 *
 *   "إذا لم يُربط اللون بأي خيار، يظهر مع جميع الخيارات المتوافقة. إذا رُبط
 *    بقيم محددة، لا يظهر إلا عندما تحقق اختيارات المستخدم الروابط المطلوبة.
 *    وضّح منطق AND/OR في البيانات: داخل مجموعة الخيارات OR، وبين مجموعات
 *    الخيارات AND."
 *
 *   - A colour with NO links is visible with every compatible selection.
 *   - A colour WITH links is visible only when, FOR EVERY option group it
 *     links into, the buyer's chosen value in that group is one of the linked
 *     values. That is OR inside a group and AND across groups.
 *   - A group the colour does not link into places no constraint at all.
 *   - While a constrained group has no choice yet, the colour is "not yet
 *     decidable": `visibleFor` reports it as hidden and `pendingGroups` names
 *     the groups still to be chosen, so the UI can say why instead of showing
 *     an empty swatch row.
 *
 * The links live in `product_color_option_links` as real rows (§7: "استخدم
 * many-to-many relation بين color وoption_value، ولا تخزن IDs كسلسلة نصية"),
 * with `group_id` denormalized so the grouping is one indexed read.
 */

import { derivedRung, type LadderRungs, type PriceFields } from './pricing';

export interface OptionGroupRow {
  id: string;
  product_id: string;
  name_en: string;
  sort: number;
  active: number | boolean;
}

export interface OptionValueRow {
  id: string;
  product_id: string;
  group_id: string;
  name_en: string;
  /** 0055. Authored Arabic / Kurdish names; '' = none (display falls back to
   *  name_en). Optional on the type so a row read before the migration ran
   *  still parses. */
  name_ar?: string | null;
  name_ckb?: string | null;
  sku_part: string;
  image: string;
  sort: number;
  active: number | boolean;
  stock: number | null;
  reserved: number;
  low_stock_threshold: number | null;
  regular_price_iqd: number | null;
  prime_price_iqd: number | null;
  pro_price_iqd: number | null;
  cost_iqd: number | null;
  /** 0044. Signed dinar move applied to the inherited value for the same
   *  field; NULL on every row that has never used an adjustment. Optional on
   *  the type for the same reason as the 0043 columns above. */
  regular_adjust_iqd?: number | null;
  prime_adjust_iqd?: number | null;
  pro_adjust_iqd?: number | null;
  cost_adjust_iqd?: number | null;
  /** 0043. Optional on the type because a row read from a database that has
   *  not run 0043 yet simply will not have them, and the overlay must not
   *  crash a storefront over a column that is only ever an enrichment. */
  availability_type?: string;
  lead_time_text?: string;
  lead_time_min_days?: number | null;
  lead_time_max_days?: number | null;
  variant_key?: string;
  variant_label?: string;
  /** 0073. Non-empty = this row was merged into that model and is history. */
  merged_into?: string;
}

/**
 * 0073. ONE CELL OF (MODEL x ORDER TYPE) — the row that lets one product carry
 * a different direct-sale difference per model. Every column is optional on the
 * type for the same reason the 0043 columns are: a Worker can reach an edge
 * before its migration reaches D1, and an enrichment must never crash a
 * storefront.
 */
export interface OptionFulfillmentRow {
  id: string;
  product_id: string;
  option_id: string;
  fulfillment_type: string;
  enabled: number | boolean;
  regular_price_iqd: number | null;
  prime_price_iqd: number | null;
  pro_price_iqd: number | null;
  cost_iqd: number | null;
  regular_adjust_iqd?: number | null;
  prime_adjust_iqd?: number | null;
  pro_adjust_iqd?: number | null;
  cost_adjust_iqd?: number | null;
  lead_time_text?: string;
  lead_time_min_days?: number | null;
  lead_time_max_days?: number | null;
  sort?: number;
}

/** 0073. ONE CELL OF (MODEL x PRE-ORDER x TRANSPORT). Never local delivery. */
export interface OptionTransportRow {
  id: string;
  product_id: string;
  fulfillment_id: string;
  method: string;
  enabled: number | boolean;
  surcharge_iqd: number | null;
  regular_price_iqd: number | null;
  prime_price_iqd: number | null;
  pro_price_iqd: number | null;
  cost_iqd: number | null;
  regular_adjust_iqd?: number | null;
  prime_adjust_iqd?: number | null;
  pro_adjust_iqd?: number | null;
  cost_adjust_iqd?: number | null;
  lead_time_text?: string;
  lead_time_min_days?: number | null;
  lead_time_max_days?: number | null;
  sort?: number;
}

export interface ColorRow {
  id: string;
  product_id: string;
  name_en: string;
  /** 0055 — see OptionValueRow. */
  name_ar?: string | null;
  name_ckb?: string | null;
  hex: string;
  image: string;
  sku_part: string;
  sort: number;
  active: number | boolean;
  stock: number | null;
  reserved: number;
  low_stock_threshold: number | null;
  regular_price_iqd: number | null;
  prime_price_iqd: number | null;
  pro_price_iqd: number | null;
  cost_iqd: number | null;
  /** 0044. Signed dinar move applied to the inherited value for the same
   *  field; NULL on every row that has never used an adjustment. Optional on
   *  the type for the same reason as the 0043 columns above. */
  regular_adjust_iqd?: number | null;
  prime_adjust_iqd?: number | null;
  pro_adjust_iqd?: number | null;
  cost_adjust_iqd?: number | null;
}

export interface ColorLinkRow {
  color_id: string;
  option_value_id: string;
  group_id: string;
}

export interface ColorVisibility {
  visible: boolean;
  /** Groups the colour constrains that the buyer has not chosen in yet. */
  pendingGroups: string[];
  /** Groups where the buyer's choice conflicts with the colour's links. */
  conflictingGroups: string[];
}

/** The buyer's current choice: group id → chosen option value id. */
export type GroupSelection = Record<string, string | undefined>;

/**
 * Decides whether one colour may be shown/chosen for the current selection.
 * Pure and total — it never throws, and an unlinked colour is always visible.
 */
export function colorVisibility(
  colorId: string,
  links: ColorLinkRow[],
  selection: GroupSelection
): ColorVisibility {
  const mine = links.filter((l) => l.color_id === colorId);
  if (mine.length === 0) return { visible: true, pendingGroups: [], conflictingGroups: [] };

  const byGroup = new Map<string, Set<string>>();
  for (const l of mine) {
    let set = byGroup.get(l.group_id);
    if (!set) {
      set = new Set<string>();
      byGroup.set(l.group_id, set);
    }
    set.add(l.option_value_id);
  }

  const pending: string[] = [];
  const conflicting: string[] = [];
  for (const [groupId, allowed] of byGroup) {
    const chosen = selection[groupId];
    if (!chosen) {
      pending.push(groupId);
      continue;
    }
    // OR inside the group.
    if (!allowed.has(chosen)) conflicting.push(groupId);
  }
  // AND across groups: every constrained group must be satisfied.
  return {
    visible: pending.length === 0 && conflicting.length === 0,
    pendingGroups: pending,
    conflictingGroups: conflicting,
  };
}

/** Colours currently selectable for a selection, in display order. */
export function visibleColors(
  colors: ColorRow[],
  links: ColorLinkRow[],
  selection: GroupSelection
): ColorRow[] {
  return colors
    .filter((c) => c.active !== 0 && c.active !== false)
    .filter((c) => colorVisibility(c.id, links, selection).visible)
    .sort((a, b) => a.sort - b.sort || a.name_en.localeCompare(b.name_en));
}

/**
 * Server-side validation of a submitted selection. Returns machine-readable
 * codes; the caller decides how to word them. This is the check that stops a
 * crafted request from buying a colour/option pairing the admin never offered.
 */
export function validateSelection(input: {
  groups: OptionGroupRow[];
  values: OptionValueRow[];
  colors: ColorRow[];
  links: ColorLinkRow[];
  selectedValueIds: string[];
  selectedColorId: string | null;
}): string[] {
  const errors: string[] = [];
  const activeGroups = input.groups.filter((g) => g.active !== 0 && g.active !== false);
  const valueById = new Map(input.values.map((v) => [v.id, v]));

  const selection: GroupSelection = {};
  for (const id of input.selectedValueIds) {
    const v = valueById.get(id);
    if (!v) {
      errors.push('OPTION_VALUE_NOT_FOUND');
      continue;
    }
    if (v.active === 0 || v.active === false) errors.push('OPTION_VALUE_INACTIVE');
    if (selection[v.group_id]) {
      // Two values from one group is not "OR" — OR describes what a COLOUR may
      // be linked to, not what a buyer may pick.
      errors.push('OPTION_GROUP_DUPLICATE_SELECTION');
      continue;
    }
    selection[v.group_id] = v.id;
  }

  // Every active group with at least one active value demands a choice.
  for (const g of activeGroups) {
    const hasActiveValue = input.values.some(
      (v) => v.group_id === g.id && v.active !== 0 && v.active !== false
    );
    if (hasActiveValue && !selection[g.id]) errors.push('OPTION_GROUP_REQUIRED');
  }

  if (input.selectedColorId) {
    const color = input.colors.find((c) => c.id === input.selectedColorId);
    if (!color) errors.push('COLOR_NOT_FOUND');
    else if (color.active === 0 || color.active === false) errors.push('COLOR_INACTIVE');
    else {
      const vis = colorVisibility(color.id, input.links, selection);
      if (!vis.visible) errors.push('COLOR_OPTION_MISMATCH');
    }
  } else if (input.colors.some((c) => c.active !== 0 && c.active !== false)) {
    errors.push('COLOR_REQUIRED');
  }

  return [...new Set(errors)];
}

// ------------------------------------------------------------------- loading

export interface ProductRelations {
  groups: OptionGroupRow[];
  values: OptionValueRow[];
  colors: ColorRow[];
  links: ColorLinkRow[];
  /** 0073. Empty on a database that has not run the migration yet. */
  fulfillments: OptionFulfillmentRow[];
  transports: OptionTransportRow[];
}

/**
 * Values are ordered GROUP BY GROUP — the group's sort first, then the value's
 * sort within it. The flat `ORDER BY sort, name_en` this used to be interleaved
 * the groups ("Model / A1", "Nozzle / 0.4", "Model / A1 Combo") and, because
 * the TXT export derives group order from first appearance, flipped the group
 * order on every round trip (docs/TXT_IMPORT_PARITY.md, root cause 13). Shared
 * by the one-product and the paged reads so every consumer sees one order.
 */
export const VALUES_ORDER_SQL =
  `SELECT v.* FROM product_option_values v
     LEFT JOIN product_option_groups g ON g.id = v.group_id
    WHERE v.product_id = ?
    ORDER BY COALESCE(g.sort, 0), COALESCE(g.name_en, ''), v.sort, v.name_en`;

/**
 * 0073. A MERGED-AWAY ROW IS HISTORY, NOT A MODEL.
 *
 * `merged_into` names the model a duplicate was folded into. Those rows are
 * kept so `order_items.option_id` still resolves, but nothing sellable may see
 * them. Filtering in SQL rather than in every consumer is what makes that true
 * everywhere at once — and `COALESCE` keeps the query valid against a database
 * that has not run 0073, where the column is simply absent from the row.
 */
export function liveValues(values: OptionValueRow[]): OptionValueRow[] {
  return values.filter((v) => !String(v.merged_into ?? '').trim());
}

/** Loads every relational piece of one product in four indexed reads. */
export async function loadProductRelations(
  db: D1Database,
  productId: string
): Promise<ProductRelations> {
  const [groups, values, colors, links, fulfillments, transports] = await Promise.all([
    db
      .prepare('SELECT * FROM product_option_groups WHERE product_id = ? ORDER BY sort, name_en')
      .bind(productId)
      .all<OptionGroupRow>(),
    db.prepare(VALUES_ORDER_SQL).bind(productId).all<OptionValueRow>(),
    db
      .prepare('SELECT * FROM product_colors WHERE product_id = ? ORDER BY sort, name_en')
      .bind(productId)
      .all<ColorRow>(),
    db
      .prepare(
        `SELECT l.color_id, l.option_value_id, l.group_id
           FROM product_color_option_links l
           JOIN product_colors c ON c.id = l.color_id
          WHERE c.product_id = ?`
      )
      .bind(productId)
      .all<ColorLinkRow>(),
    // 0073 may not have reached this database yet; the cells are an
    // enrichment, so their absence degrades to "this product has none" and
    // every price falls back to the product's own, exactly as before.
    softRows<OptionFulfillmentRow>(() =>
      db
        .prepare('SELECT * FROM product_option_fulfillment WHERE product_id = ? ORDER BY sort, id')
        .bind(productId)
        .all<OptionFulfillmentRow>()
    ),
    softRows<OptionTransportRow>(() =>
      db
        .prepare('SELECT * FROM product_option_transports WHERE product_id = ? ORDER BY sort, id')
        .bind(productId)
        .all<OptionTransportRow>()
    ),
  ]);
  return {
    groups: groups.results,
    values: values.results,
    colors: colors.results,
    links: links.results,
    fulfillments,
    transports,
  };
}

/** A read whose table may not exist yet returns nothing rather than throwing. */
async function softRows<T>(run: () => Promise<{ results: T[] }>): Promise<T[]> {
  try {
    return (await run()).results;
  } catch (e) {
    console.error(`option cells unavailable: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

// ---------------------------------------------------------------- validation

/** #RGB / #RRGGBB, case-insensitive. Anything else is rejected — a colour with
 *  an unparseable hex renders as a broken swatch on the storefront. */
export function isValidHex(v: unknown): v is string {
  return typeof v === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v.trim());
}

export function normalizeHex(v: string): string {
  const s = v.trim().toLowerCase();
  if (s.length === 4) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  return s;
}

export interface PriceLadderInput {
  regular_price_iqd: number | null;
  prime_price_iqd: number | null;
  pro_price_iqd: number | null;
  cost_iqd: number | null;
  regular_adjust_iqd?: number | null;
  prime_adjust_iqd?: number | null;
  pro_adjust_iqd?: number | null;
  cost_adjust_iqd?: number | null;
}

const asFields = (p: PriceLadderInput): PriceFields => ({
  regular_price_iqd: p.regular_price_iqd, prime_price_iqd: p.prime_price_iqd, pro_price_iqd: p.pro_price_iqd, cost_iqd: p.cost_iqd,
  regular_adjust_iqd: p.regular_adjust_iqd ?? null, prime_adjust_iqd: p.prime_adjust_iqd ?? null,
  pro_adjust_iqd: p.pro_adjust_iqd ?? null, cost_adjust_iqd: p.cost_adjust_iqd ?? null,
});

/** One option a colour can be sold with, and the ladder it resolves to on top of the base. */
export interface OptionLadder {
  /** How the option is named in a refusal. */
  where: string;
  ladder: LadderRungs;
}

/**
 * The ladders a COLOUR must be checked under — one per option it can be sold
 * with, each the option's own rung on top of the base (pricing.ts
 * derivedRung): its linked options when it has links, else every active
 * option. The resolver walks base → option → colour, so a colour that is fine
 * against the base can still swallow the PRO price an option states, or invert
 * PRIME and PRO under it — and only a check under that option can see it. A
 * product with no active option yields an empty list: the colour is then
 * measured against the base alone.
 *
 * The colour PUT in worker/routes/adminProductRelations.ts is the caller: it
 * has the option values in hand when it validates the colours.
 */
export function optionLaddersFor(
  base: LadderRungs,
  options: Array<{ id: string; where: string; active: boolean | number; prices: PriceLadderInput }>,
  linked: string[]
): OptionLadder[] {
  const active = options.filter((o) => o.active !== 0 && o.active !== false);
  const chosen = linked.length ? active.filter((o) => linked.includes(o.id)) : active;
  return chosen.map((o) => ({ where: o.where, ladder: derivedRung(asFields(o.prices), base) }));
}

/**
 * §5 price rules, enforced server-side at every level (product, option value,
 * colour, variant):
 *   - PRO <= PRIME <= Regular, because the PRIME discount is smaller than PRO;
 *   - the selling price must DIFFER from the cost ("يجب أن يختلف سعر البيع عن
 *     التكلفة. امنع الحفظ مع رسالة واضحة إذا تساويا");
 *   - integers only, never negative.
 */
export function validatePriceLadder(
  p: PriceLadderInput,
  where: string,
  /** The product's base ladder — lets the derived member prices be checked too (pricing.ts derivedRung). */
  beneath?: LadderRungs,
  /** For a colour: the ladder of each option it can be sold with (`optionLaddersFor`). */
  under?: OptionLadder[]
): string[] {
  const errors: string[] = [];
  const bad = (v: number | null) => v !== null && (!Number.isInteger(v) || v < 0);
  if (bad(p.regular_price_iqd)) errors.push(`${where}: regular price must be a whole number of IQD`);
  if (bad(p.prime_price_iqd)) errors.push(`${where}: PRIME price must be a whole number of IQD`);
  if (bad(p.pro_price_iqd)) errors.push(`${where}: PRO price must be a whole number of IQD`);
  if (bad(p.cost_iqd)) errors.push(`${where}: cost must be a whole number of IQD`);
  if (errors.length) return errors;

  const { regular_price_iqd: reg, prime_price_iqd: prime, pro_price_iqd: pro, cost_iqd: cost } = p;
  if (reg !== null && prime !== null && prime > reg) {
    errors.push(`${where}: the PRIME price must not be above the regular price`);
  }
  if (reg !== null && pro !== null && pro > reg) {
    errors.push(`${where}: the PRO price must not be above the regular price`);
  }
  if (prime !== null && pro !== null && pro > prime) {
    errors.push(`${where}: the PRO price must not be above the PRIME price (PRO ≤ PRIME ≤ Regular)`);
  }
  if (cost !== null) {
    for (const [label, value] of [
      ['regular', reg],
      ['PRIME', prime],
      ['PRO', pro],
    ] as const) {
      if (value !== null && value === cost) {
        errors.push(`${where}: the ${label} price is identical to the cost — set a real selling price`);
      }
    }
  }
  // The member ladder follows the regular one: a row that states no member
  // price inherits the base member price PLUS its own surcharge. A reduction
  // that swallows that member price is refused, so is a member adjustment
  // that lifts the derived price above the row's regular price, and so is a
  // row whose derived PRIME lands below its derived PRO — the resolver would
  // charge PRIME members the PRO number, one the row never shows.
  if (beneath) {
    const fields = asFields(p);
    const d = derivedRung(fields, beneath);
    for (const f of d.consumed) {
      errors.push(`${where}: the reduction is larger than the ${f.toUpperCase()} price this row inherits (${beneath[f]}) — state a ${f.toUpperCase()} price for it, or reduce less`);
    }
    if (d.prime !== null && d.prime > d.regular) errors.push(`${where}: the PRIME price this row resolves to (${d.prime}) is above its regular price (${d.regular})`);
    if (d.pro !== null && d.pro > d.regular) errors.push(`${where}: the PRO price this row resolves to (${d.pro}) is above its regular price (${d.regular})`);
    if (d.inverted) {
      errors.push(`${where}: the PRIME price this row resolves to (${d.prime}) is below the PRO price it resolves to (${d.pro}) — PRO ≤ PRIME ≤ Regular`);
    }
    // A colour anchors on the option the customer picked, not on the base:
    // the same two checks, once under each option it can be sold with.
    for (const u of under ?? []) {
      const c = derivedRung(fields, u.ladder);
      for (const f of c.consumed) {
        errors.push(`${where}: with option ${u.where}, the reduction is larger than the ${f.toUpperCase()} price this colour inherits (${u.ladder[f]}) — state a ${f.toUpperCase()} price for it, or reduce less`);
      }
      if (c.inverted) {
        errors.push(`${where}: with option ${u.where}, the PRIME price this colour resolves to (${c.prime}) is below its PRO price (${c.pro}) — PRO ≤ PRIME ≤ Regular`);
      }
    }
  }
  return errors;
}
