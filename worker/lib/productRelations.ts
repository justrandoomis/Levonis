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
}

export interface ColorRow {
  id: string;
  product_id: string;
  name_en: string;
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
}

/** Loads every relational piece of one product in four indexed reads. */
export async function loadProductRelations(
  db: D1Database,
  productId: string
): Promise<ProductRelations> {
  const [groups, values, colors, links] = await Promise.all([
    db
      .prepare('SELECT * FROM product_option_groups WHERE product_id = ? ORDER BY sort, name_en')
      .bind(productId)
      .all<OptionGroupRow>(),
    db
      .prepare('SELECT * FROM product_option_values WHERE product_id = ? ORDER BY sort, name_en')
      .bind(productId)
      .all<OptionValueRow>(),
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
  ]);
  return {
    groups: groups.results,
    values: values.results,
    colors: colors.results,
    links: links.results,
  };
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
}

/**
 * §5 price rules, enforced server-side at every level (product, option value,
 * colour, variant):
 *   - PRO <= PRIME <= Regular, because the PRIME discount is smaller than PRO;
 *   - the selling price must DIFFER from the cost ("يجب أن يختلف سعر البيع عن
 *     التكلفة. امنع الحفظ مع رسالة واضحة إذا تساويا");
 *   - integers only, never negative.
 */
export function validatePriceLadder(p: PriceLadderInput, where: string): string[] {
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
  return errors;
}
