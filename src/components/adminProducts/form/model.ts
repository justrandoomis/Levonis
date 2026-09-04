/**
 * Form state for the rebuilt product form (mandate §1–§8) and the mapping to
 * and from the two endpoints it saves through:
 *
 *   POST /api/admin/products-v2            the document (names, prices, section)
 *   PUT  /api/admin/products/:id/relations the structure (groups, values,
 *                                          colours, links, variants, images,
 *                                          facets, inventory mode)
 *
 * ONE STATE SOURCE PER VALUE (§1: "لا تكرر الحقل نفسه في أكثر من قسم. أنشئ
 * مصدر حالة واحدًا لكل قيمة"). Nothing is mirrored: a colour's stock lives on
 * the colour, an image's primary flag lives on the image, and the sections
 * render different views of the SAME objects.
 *
 * NO ar/ckb ANYWHERE (§3). The Arabic and Kurdish copies are generated on the
 * server by the local translator, so this file has no field for them.
 */

export type SaleType = 'direct_sale' | 'pre_order' | 'bundle';
export type InventoryMode = 'BASE' | 'OPTION' | 'COLOR' | 'VARIANT_COMBINATION';

export interface FormPrices {
  regular_price_iqd: number | null;
  prime_price_iqd: number | null;
  pro_price_iqd: number | null;
  cost_iqd: number | null;
  /**
   * 0044 adjustments. THE FORM DOES NOT EDIT THESE — Quick Edit does — but it
   * must carry them, because the relations save replaces the whole row set and
   * a field the form drops is a field the save clears. An adjustment set in
   * Quick Edit and silently erased by the next rename in the product form is
   * exactly the kind of invisible price change this round exists to end.
   */
  regular_adjust_iqd?: number | null;
  prime_adjust_iqd?: number | null;
  pro_adjust_iqd?: number | null;
  cost_adjust_iqd?: number | null;
}

export interface FormValue extends FormPrices {
  id: string;
  name_en: string;
  sku_part: string;
  image: string;
  sort: number;
  active: boolean;
  stock: number | null;
  low_stock_threshold: number | null;
  /** 0043. '' = inherit the product's sale types, which is what every option
   *  saved before this field existed does. */
  availability_type: '' | 'direct_sale' | 'pre_order';
  lead_time_text: string;
  lead_time_min_days: number | null;
  lead_time_max_days: number | null;
  /** The MODEL this option is a fulfilment of — A1 vs A1 Combo. */
  variant_key: string;
  variant_label: string;
}

export interface FormGroup {
  id: string;
  name_en: string;
  sort: number;
  active: boolean;
  values: FormValue[];
}

export interface FormColor extends FormPrices {
  id: string;
  name_en: string;
  hex: string;
  image: string;
  sku_part: string;
  sort: number;
  active: boolean;
  stock: number | null;
  low_stock_threshold: number | null;
  /** §7 many-to-many: OR inside a group, AND across groups. */
  option_value_ids: string[];
}

export interface FormVariant extends FormPrices {
  id: string;
  option_value_ids: string[];
  color_id: string | null;
  sku: string;
  active: boolean;
  stock: number | null;
  low_stock_threshold: number | null;
}

export interface FormImage {
  id: string;
  url: string;
  alt_en: string;
  sort_order: number;
  is_primary: boolean;
  option_value_id: string | null;
  color_id: string | null;
  variant_id: string | null;
  width: number | null;
  height: number | null;
}

export interface RelationsState {
  inventory_mode: InventoryMode;
  groups: FormGroup[];
  colors: FormColor[];
  variants: FormVariant[];
  images: FormImage[];
}

export const emptyRelations = (): RelationsState => ({
  inventory_mode: 'BASE',
  groups: [],
  colors: [],
  variants: [],
  images: [],
});

export const emptyPrices = (): FormPrices => ({
  regular_price_iqd: null,
  prime_price_iqd: null,
  pro_price_iqd: null,
  cost_iqd: null,
  regular_adjust_iqd: null,
  prime_adjust_iqd: null,
  pro_adjust_iqd: null,
  cost_adjust_iqd: null,
});

let seq = 0;
export function localId(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}${seq}`;
}

// ------------------------------------------------------------------ wire IO

interface WireValue extends FormPrices {
  id: string;
  group_id: string;
  name_en: string;
  sku_part: string;
  image: string;
  sort: number;
  active: number;
  stock: number | null;
  low_stock_threshold: number | null;
  /** 0043 — optional on the wire so this client still reads a response from a
   *  server that has not deployed them yet. */
  availability_type?: string;
  lead_time_text?: string;
  lead_time_min_days?: number | null;
  lead_time_max_days?: number | null;
  variant_key?: string;
  variant_label?: string;
}
interface WireGroup {
  id: string;
  name_en: string;
  sort: number;
  active: number;
}
interface WireColor extends FormPrices {
  id: string;
  name_en: string;
  hex: string;
  image: string;
  sku_part: string;
  sort: number;
  active: number;
  stock: number | null;
  low_stock_threshold: number | null;
}
interface WireLink {
  color_id: string;
  option_value_id: string;
  group_id: string;
}
interface WireVariant extends FormPrices {
  id: string;
  combo_key: string;
  sku: string | null;
  active: number;
  stock: number | null;
  low_stock_threshold: number | null;
}
interface WireImage {
  id: string;
  url: string;
  alt_en: string;
  sort_order: number;
  is_primary: number;
  option_value_id: string | null;
  color_id: string | null;
  variant_id: string | null;
  width: number | null;
  height: number | null;
}

export interface RelationsResponse {
  success: boolean;
  product?: { inventory_mode?: string };
  groups?: WireGroup[];
  values?: WireValue[];
  colors?: WireColor[];
  links?: WireLink[];
  variants?: WireVariant[];
  images?: WireImage[];
}

/** Anything the server might hold, narrowed to what the editor can render. */
const readAvailability = (raw: unknown): '' | 'direct_sale' | 'pre_order' =>
  raw === 'direct_sale' || raw === 'pre_order' ? raw : '';

const prices = (x: FormPrices): FormPrices => ({
  regular_price_iqd: x.regular_price_iqd ?? null,
  prime_price_iqd: x.prime_price_iqd ?? null,
  pro_price_iqd: x.pro_price_iqd ?? null,
  cost_iqd: x.cost_iqd ?? null,
  regular_adjust_iqd: x.regular_adjust_iqd ?? null,
  prime_adjust_iqd: x.prime_adjust_iqd ?? null,
  pro_adjust_iqd: x.pro_adjust_iqd ?? null,
  cost_adjust_iqd: x.cost_adjust_iqd ?? null,
});

/** Decodes the server's canonical `o:<id>|c:<id>` combination key. */
export function parseComboKey(key: string): { option_value_ids: string[]; color_id: string | null } {
  const parts = key.split('|').filter(Boolean);
  return {
    option_value_ids: parts.filter((p) => p.startsWith('o:')).map((p) => p.slice(2)),
    color_id: parts.find((p) => p.startsWith('c:'))?.slice(2) ?? null,
  };
}

export function relationsFromWire(r: RelationsResponse): RelationsState {
  const values = r.values ?? [];
  const links = r.links ?? [];
  const byColor = new Map<string, string[]>();
  for (const l of links) {
    const arr = byColor.get(l.color_id);
    if (arr) arr.push(l.option_value_id);
    else byColor.set(l.color_id, [l.option_value_id]);
  }
  const mode = r.product?.inventory_mode;
  return {
    inventory_mode:
      mode === 'OPTION' || mode === 'COLOR' || mode === 'VARIANT_COMBINATION' ? mode : 'BASE',
    groups: (r.groups ?? []).map((g) => ({
      id: g.id,
      name_en: g.name_en,
      sort: g.sort,
      active: g.active !== 0,
      values: values
        .filter((v) => v.group_id === g.id)
        .sort((a, b) => a.sort - b.sort)
        .map((v) => ({
          id: v.id,
          name_en: v.name_en,
          sku_part: v.sku_part ?? '',
          image: v.image ?? '',
          sort: v.sort,
          active: v.active !== 0,
          stock: v.stock,
          low_stock_threshold: v.low_stock_threshold,
          ...prices(v),
          availability_type: readAvailability(v.availability_type),
          lead_time_text: v.lead_time_text ?? '',
          lead_time_min_days: v.lead_time_min_days ?? null,
          lead_time_max_days: v.lead_time_max_days ?? null,
          variant_key: v.variant_key ?? '',
          variant_label: v.variant_label ?? '',
        })),
    })),
    colors: (r.colors ?? []).map((c) => ({
      id: c.id,
      name_en: c.name_en,
      hex: c.hex,
      image: c.image ?? '',
      sku_part: c.sku_part ?? '',
      sort: c.sort,
      active: c.active !== 0,
      stock: c.stock,
      low_stock_threshold: c.low_stock_threshold,
      option_value_ids: byColor.get(c.id) ?? [],
      ...prices(c),
    })),
    variants: (r.variants ?? []).map((v) => ({
      id: v.id,
      ...parseComboKey(v.combo_key),
      sku: v.sku ?? '',
      active: v.active !== 0,
      stock: v.stock,
      low_stock_threshold: v.low_stock_threshold,
      ...prices(v),
    })),
    images: (r.images ?? [])
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((i) => ({
        id: i.id,
        url: i.url,
        alt_en: i.alt_en ?? '',
        sort_order: i.sort_order,
        is_primary: i.is_primary === 1,
        option_value_id: i.option_value_id,
        color_id: i.color_id,
        variant_id: i.variant_id,
        width: i.width,
        height: i.height,
      })),
  };
}

/** The PUT payload. Sort orders are re-derived from array position, so drag
 *  reordering IS the stored order and no stale index can survive. */
/**
 * The inventory source is DERIVED, never hand-picked (the owner's rule:
 * «المخزون يعتمد على الخيار او اللون المختار تلقائيًا وليس يدويًا من قبل
 * الادمن»). The most specific level that actually carries a stock number
 * wins: any colour stock → COLOR, else any option-value stock → OPTION,
 * else the product's base number (BASE). A product already living on
 * combinations keeps VARIANT_COMBINATION — tearing that down implicitly
 * would zero real reservations. The server model (one authoritative level,
 * levels never summed) is untouched; only WHO chooses the level changed.
 */
export function deriveInventoryMode(rel: RelationsState): InventoryMode {
  if (rel.inventory_mode === 'VARIANT_COMBINATION' && rel.variants.length > 0) return 'VARIANT_COMBINATION';
  if (rel.colors.some((c) => c.stock !== null)) return 'COLOR';
  if (rel.groups.some((g) => g.values.some((v) => v.stock !== null))) return 'OPTION';
  return 'BASE';
}

export function relationsToWire(rel: RelationsState) {
  return {
    inventory_mode: deriveInventoryMode(rel),
    groups: rel.groups.map((g, gi) => ({
      id: g.id,
      name_en: g.name_en,
      sort: gi,
      active: g.active,
      values: g.values.map((v, vi) => ({
        id: v.id,
        name_en: v.name_en,
        sku_part: v.sku_part,
        image: v.image,
        sort: vi,
        active: v.active,
        stock: v.stock,
        low_stock_threshold: v.low_stock_threshold,
        ...prices(v),
        availability_type: v.availability_type,
        // A direct-sale option has nothing to wait for; sending a lead time
        // with it would be refused by the server, so the form clears it here
        // rather than letting the admin hit an error they cannot see.
        lead_time_text: v.availability_type === 'direct_sale' ? '' : v.lead_time_text,
        lead_time_min_days: v.availability_type === 'direct_sale' ? null : v.lead_time_min_days,
        lead_time_max_days: v.availability_type === 'direct_sale' ? null : v.lead_time_max_days,
        variant_key: v.variant_key,
        variant_label: v.variant_label,
      })),
    })),
    colors: rel.colors.map((c, ci) => ({
      id: c.id,
      name_en: c.name_en,
      hex: c.hex,
      image: c.image,
      sku_part: c.sku_part,
      sort: ci,
      active: c.active,
      stock: c.stock,
      low_stock_threshold: c.low_stock_threshold,
      option_value_ids: c.option_value_ids,
      ...prices(c),
    })),
    variants: rel.variants.map((v) => ({
      id: v.id,
      option_value_ids: v.option_value_ids,
      color_id: v.color_id,
      sku: v.sku || null,
      active: v.active,
      stock: v.stock,
      low_stock_threshold: v.low_stock_threshold,
      ...prices(v),
    })),
    images: rel.images.map((i, ii) => ({
      id: i.id,
      url: i.url,
      alt_en: i.alt_en,
      sort_order: ii,
      is_primary: i.is_primary,
      option_value_id: i.option_value_id,
      color_id: i.color_id,
      variant_id: i.variant_id,
      width: i.width,
      height: i.height,
    })),
  };
}

// -------------------------------------------------------------- validation

export interface FormErrors {
  [key: string]: string;
}

const ladder = (p: FormPrices, where: string, out: FormErrors, key: string) => {
  const { regular_price_iqd: reg, prime_price_iqd: prime, pro_price_iqd: pro, cost_iqd: cost } = p;
  if (reg !== null && prime !== null && prime > reg) {
    out[key] = `${where}: سعر PRIME أعلى من السعر الاعتيادي`;
  } else if (reg !== null && pro !== null && pro > reg) {
    out[key] = `${where}: سعر PRO أعلى من السعر الاعتيادي`;
  } else if (prime !== null && pro !== null && pro > prime) {
    out[key] = `${where}: يجب أن يكون PRO ≤ PRIME ≤ الاعتيادي`;
  } else if (cost !== null && (reg === cost || prime === cost || pro === cost)) {
    out[key] = `${where}: سعر البيع يساوي التكلفة`;
  }
};

/**
 * Client-side mirror of the server's rules — for immediate feedback only. The
 * server re-validates everything (§11: "استخدم validation على الخادم لكل سعر
 * وHEX وstock وcategory relation"), so passing here is never permission to
 * skip a server check.
 */
export function validateForm(input: {
  name_en: string;
  price_iqd: number | null;
  prime_price_iqd: number | null;
  pro_price_iqd: number | null;
  product_cost_iqd: number | null;
  category_id: string | null;
  sale_types: SaleType[];
  rel: RelationsState;
  /** Publishing enforces more than saving a draft. */
  publishing: boolean;
}): FormErrors {
  const e: FormErrors = {};
  if (!input.name_en.trim()) e.name_en = 'الاسم الإنجليزي مطلوب';
  if (input.price_iqd === null) e.price_iqd = 'السعر الاعتيادي مطلوب';
  if (input.publishing && !input.category_id) e.category_id = 'القسم الرئيسي مطلوب للنشر';
  if (input.sale_types.length === 0) e.sale_types = 'اختر نوع بيع واحدًا على الأقل';

  ladder(
    {
      regular_price_iqd: input.price_iqd,
      prime_price_iqd: input.prime_price_iqd,
      pro_price_iqd: input.pro_price_iqd,
      cost_iqd: input.product_cost_iqd,
    },
    'الأسعار الأساسية',
    e,
    'prices'
  );

  for (const g of input.rel.groups) {
    if (!g.name_en.trim()) e[`group:${g.id}`] = 'اسم المجموعة مطلوب';
    for (const v of g.values) {
      if (!v.name_en.trim()) e[`value:${v.id}`] = 'اسم الخيار مطلوب';
      ladder(v, v.name_en || 'خيار', e, `value_price:${v.id}`);
    }
  }
  for (const c of input.rel.colors) {
    if (!c.name_en.trim()) e[`color:${c.id}`] = 'اسم اللون مطلوب';
    if (!/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(c.hex)) e[`color_hex:${c.id}`] = 'كود لون غير صالح';
    ladder(c, c.name_en || 'لون', e, `color_price:${c.id}`);
  }
  for (const v of input.rel.variants) {
    if (v.option_value_ids.length === 0 && !v.color_id) {
      e[`variant:${v.id}`] = 'التركيبة تحتاج خيارًا أو لونًا';
    }
    ladder(v, 'تركيبة', e, `variant_price:${v.id}`);
  }
  if (input.rel.inventory_mode === 'VARIANT_COMBINATION' && input.rel.variants.length === 0) {
    e.inventory_mode = 'وضع التركيبات يحتاج تركيبة واحدة على الأقل وإلا لا يمكن البيع';
  }
  if (input.rel.images.filter((i) => i.is_primary).length > 1) {
    e.images = 'صورة رئيسية واحدة فقط';
  }
  return e;
}

/** A short, human summary for a collapsed section header (§1). */
export function summarize(parts: Array<string | null | undefined>): string {
  return parts.filter(Boolean).join(' · ');
}
