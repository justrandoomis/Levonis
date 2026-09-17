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

import type { ColorV2, MediaV2, OptionV2 } from '../../../lib/productTypes';

export type SaleType = 'direct_sale' | 'pre_order' | 'bundle';
export type InventoryMode = 'BASE' | 'OPTION' | 'COLOR' | 'VARIANT_COMBINATION';
export type FulfillmentType = 'direct_sale' | 'pre_order';
export type TransportMethod = 'air' | 'sea' | 'land';

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
  /**
   * 0055 — the Arabic / Kurdish names a TXT template authored. The form has
   * no input for them (§3, English-only) but it CARRIES them: the relations
   * save replaces the whole row set, and a field the form drops is a field the
   * save clears. Absent = the row never had one.
   */
  name_ar?: string;
  name_ckb?: string;
  sku_part: string;
  image: string;
  sort: number;
  active: boolean;
  stock: number | null;
  /** Read-only evidence carried so a stock edit can never undercut a live hold. */
  reserved: number;
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
  /** The two independent checkboxes shown on this model. */
  fulfillments: FormFulfillment[];
}

export interface FormTransport extends FormPrices {
  method: TransportMethod;
  enabled: boolean;
  surcharge_iqd: number | null;
  sort: number;
  lead_time_text: string;
  lead_time_min_days: number | null;
  lead_time_max_days: number | null;
  /** Legacy compatibility only. New UI never authors a pre-order quantity. */
  capacity: number | null;
  capacity_reserved: number;
}

export interface FormFulfillment extends FormPrices {
  fulfillment_type: FulfillmentType;
  enabled: boolean;
  sort: number;
  lead_time_text: string;
  lead_time_min_days: number | null;
  lead_time_max_days: number | null;
  /** Legacy compatibility only. Pre-order is available/unavailable, not stocked. */
  capacity: number | null;
  capacity_reserved: number;
  transports: FormTransport[];
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
  /** 0055 — carried, never edited here (see FormValue). */
  name_ar?: string;
  name_ckb?: string;
  hex: string;
  image: string;
  sku_part: string;
  sort: number;
  active: boolean;
  stock: number | null;
  reserved: number;
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
  reserved: number;
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
  /**
   * Where this picture came from, when it was fetched from a vendor page.
   * Carried so the record reaches the database — the server preserves a
   * stored value when this is empty, so an image the form did not fetch keeps
   * whatever provenance it already had.
   */
  source_url?: string;
  /**
   * 0048 alt texts and storage key the TXT template writes and the server
   * stores. Carried for the same reason as `source_url`: the form never edits
   * them, and a save that omitted them would rely on the server's
   * preserve-if-empty rule instead of stating what it read.
   */
  alt_ar?: string;
  alt_ckb?: string;
  r2_key?: string;
}

export interface RelationsState {
  inventory_mode: InventoryMode;
  groups: FormGroup[];
  colors: FormColor[];
  variants: FormVariant[];
  images: FormImage[];
  /**
   * What the loader had to do to show the stored data: an option value whose
   * group row is missing, or a structure read from the product document
   * because no relation rows exist yet. Shown to the admin, never sent.
   */
  hydration_issues?: string[];
}

export interface LinkedColorCombination {
  option_value_ids: string[];
  color_id: string;
}

/** Exact option selections for colours explicitly attached to models. */
export function linkedColorCombinations(rel: RelationsState): LinkedColorCombination[] {
  const groups = rel.groups
    .filter((g) => g.active)
    .map((g) => ({ ...g, values: g.values.filter((v) => v.active) }))
    .filter((g) => g.values.length > 0);
  let choices: string[][] = [[]];
  for (const group of groups) {
    choices = choices.flatMap((chosen) => group.values.map((v) => [...chosen, v.id]));
  }
  if (choices.length === 1 && choices[0].length === 0) return [];

  const groupOf = new Map<string, string>();
  for (const group of groups) for (const value of group.values) groupOf.set(value.id, group.id);
  const out: LinkedColorCombination[] = [];
  for (const color of rel.colors.filter((c) => c.active && c.option_value_ids.length > 0)) {
    const byGroup = new Map<string, Set<string>>();
    for (const valueId of color.option_value_ids) {
      const groupId = groupOf.get(valueId);
      if (!groupId) continue;
      const set = byGroup.get(groupId) ?? new Set<string>();
      set.add(valueId);
      byGroup.set(groupId, set);
    }
    for (const chosen of choices) {
      const ok = [...byGroup.entries()].every(([groupId, allowed]) => {
        const selected = chosen.find((id) => groupOf.get(id) === groupId);
        return !!selected && allowed.has(selected);
      });
      if (ok) out.push({ option_value_ids: [...chosen].sort(), color_id: color.id });
    }
  }
  return out;
}

/**
 * Every exact direct-sale shelf once any model uses per-colour stock. Models
 * without colours become a colour-less variant row, allowing one product to
 * mix “stock on the option” and “stock on option×colour” while the database
 * keeps one authoritative VARIANT_COMBINATION mode.
 */
export function directStockCombinations(
  rel: RelationsState
): Array<{ option_value_ids: string[]; color_id: string | null }> {
  const directIds = new Set(
    rel.groups
      .flatMap((g) => g.values)
      .filter((v) =>
        v.active && v.fulfillments.some((f) => f.fulfillment_type === 'direct_sale' && f.enabled)
      )
      .map((v) => v.id)
  );
  const isDirect = (ids: string[]) => ids.some((id) => directIds.has(id));
  const coloured = linkedColorCombinations(rel).filter((combo) => isDirect(combo.option_value_ids));
  if (coloured.length === 0) return [];
  const groups = rel.groups
    .filter((g) => g.active)
    .map((g) => g.values.filter((v) => v.active))
    .filter((values) => values.length > 0);
  let choices: string[][] = [[]];
  for (const values of groups) choices = choices.flatMap((chosen) => values.map((v) => [...chosen, v.id]));
  const colouredSelections = new Set(coloured.map((x) => [...x.option_value_ids].sort().join('|')));
  return [
    ...coloured,
    ...choices
      .filter(isDirect)
      .filter((ids) => !colouredSelections.has([...ids].sort().join('|')))
      .map((option_value_ids) => ({ option_value_ids: [...option_value_ids].sort(), color_id: null })),
  ];
}

export const combinationKey = (x: { option_value_ids: string[]; color_id: string | null }): string =>
  [...x.option_value_ids].sort().map((id) => `o:${id}`).concat(x.color_id ? [`c:${x.color_id}`] : []).join('|');

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

// ------------------------------------------------------- extended warranty

/**
 * The extended-warranty constants and fee rule, A FAITHFUL COPY of
 * worker/lib/warrantyPlans.ts (PRINTER_BASE_MONTHS, PRINTER_EXTENSION_MONTHS,
 * FEE_PERCENT_HINT, planFee). The client cannot import that module — it pulls
 * the Worker's HTTP helpers — and the server re-validates every save; these
 * exist so the form flags exactly what the server refuses and previews the
 * exact dinar the resolver will charge. tests/extendedWarranty.test.ts runs
 * both copies over the same numbers.
 */
export const PRINTER_BASE_MONTHS = 12;
export const PRINTER_EXTENSION_MONTHS = [12, 24] as const;
export const FEE_PERCENT_HINT = { min: 7.5, max: 10 } as const;

export function isValidFeePercent(v: unknown): v is number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  if (v < 0.01 || v > 100) return false;
  return Math.round(v * 100) / 100 === v;
}

/** `round(basis × percent / 100)` through integer basis points, else the fixed fee. */
export function warrantyFee(plan: { fee_iqd: number; fee_percent: number | null }, basisIqd: number): number {
  const pct = plan.fee_percent;
  if (typeof pct === 'number' && Number.isFinite(pct) && pct > 0) {
    const bp = Math.round(pct * 100);
    const basis = Number.isFinite(basisIqd) && basisIqd > 0 ? Math.round(basisIqd) : 0;
    return Math.round((basis * bp) / 10000);
  }
  return Number.isInteger(plan.fee_iqd) && plan.fee_iqd >= 0 ? plan.fee_iqd : 0;
}

/** The form's view of the plans: the server's rules, before the round trip. */
export interface WarrantyFormInput {
  isPrinter: boolean;
  plans: Array<{ id: string; duration_months: number; duration_kind: string; fee_iqd: number; fee_percent: number | null; active: boolean }>;
  serialized: boolean | null;
  warranty_base_months: number | null;
}

function warrantyRules(w: WarrantyFormInput, out: FormErrors): void {
  if (!w.isPrinter) {
    if (w.plans.length > 0) out.warranty_plans = 'الضمان الممدد للطابعات فقط — هذا المنتج ليس في قسم طابعات؛ احذف الخطط قبل الحفظ';
    return;
  }
  const seen = new Set<number>();
  for (const p of w.plans) {
    if (p.duration_kind !== 'extension' || !(PRINTER_EXTENSION_MONTHS as readonly number[]).includes(p.duration_months)) {
      out[`warranty_plan:${p.id}`] = 'خطة الطابعة تمديد +12 أو +24 شهرًا فقط';
    } else if (seen.has(p.duration_months)) {
      out[`warranty_plan:${p.id}`] = `خطة واحدة لكل مدة (+${p.duration_months} شهرًا مكررة)`;
    }
    seen.add(p.duration_months);
    if (p.fee_percent !== null && !isValidFeePercent(p.fee_percent)) {
      out[`warranty_percent:${p.id}`] = 'النسبة بين 0.01 و100 بمنزلتين عشريتين على الأكثر (مثال 7.5)';
    }
  }
  if (w.plans.some((p) => p.active) && w.serialized === false) {
    out.serialized = 'طابعة تعرض ضمانًا ممددًا يجب أن تكون مُرقَّمة — وإلا لا تُسجَّل التغطية على الوحدات';
  }
  if (w.warranty_base_months !== null && (!Number.isInteger(w.warranty_base_months) || w.warranty_base_months < 1 || w.warranty_base_months > 240)) {
    out.warranty_base_months = 'مدة الضمان الأساسي بين 1 و240 شهرًا';
  }
}

// ------------------------------------------------------------------ wire IO

interface WireValue extends FormPrices {
  id: string;
  group_id: string;
  name_en: string;
  /** 0055 — optional on the wire (rows read before the migration). */
  name_ar?: string | null;
  name_ckb?: string | null;
  sku_part: string;
  image: string;
  sort: number;
  active: number;
  stock: number | null;
  reserved?: number | null;
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
  name_ar?: string | null;
  name_ckb?: string | null;
  hex: string;
  image: string;
  sku_part: string;
  sort: number;
  active: number;
  stock: number | null;
  reserved?: number | null;
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
  reserved?: number | null;
  low_stock_threshold: number | null;
}
interface WireTransport extends FormPrices {
  method: string;
  enabled: number | boolean;
  surcharge_iqd: number | null;
  sort?: number | null;
  lead_time_text?: string | null;
  lead_time_min_days?: number | null;
  lead_time_max_days?: number | null;
  capacity?: number | null;
  capacity_reserved?: number | null;
}
interface WireFulfillment extends FormPrices {
  option_id: string;
  fulfillment_type: string;
  enabled: number | boolean;
  sort?: number | null;
  lead_time_text?: string | null;
  lead_time_min_days?: number | null;
  lead_time_max_days?: number | null;
  capacity?: number | null;
  capacity_reserved?: number | null;
  transports?: WireTransport[];
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
  /** 0048 provenance — carried back so a re-save keeps it. */
  source_url?: string | null;
  alt_ar?: string | null;
  alt_ckb?: string | null;
  r2_key?: string | null;
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
  fulfillments?: WireFulfillment[];
}

/** Anything the server might hold, narrowed to what the editor can render. */
const readAvailability = (raw: unknown): '' | 'direct_sale' | 'pre_order' =>
  raw === 'direct_sale' || raw === 'pre_order' ? raw : '';

const TRANSPORT_METHODS: TransportMethod[] = ['air', 'sea', 'land'];

export const emptyTransport = (method: TransportMethod, enabled = false): FormTransport => ({
  method,
  enabled,
  surcharge_iqd: null,
  sort: TRANSPORT_METHODS.indexOf(method),
  lead_time_text: '',
  lead_time_min_days: null,
  lead_time_max_days: null,
  capacity: null,
  capacity_reserved: 0,
  ...emptyPrices(),
});

export const emptyFulfillment = (type: FulfillmentType, enabled = false): FormFulfillment => ({
  fulfillment_type: type,
  enabled,
  sort: type === 'direct_sale' ? 0 : 1,
  lead_time_text: '',
  lead_time_min_days: null,
  lead_time_max_days: null,
  capacity: null,
  capacity_reserved: 0,
  transports: type === 'pre_order' ? TRANSPORT_METHODS.map((method) => emptyTransport(method)) : [],
  ...emptyPrices(),
});

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

const transportFromWire = (t: WireTransport): FormTransport => ({
  method: t.method === 'air' || t.method === 'sea' ? t.method : 'land',
  enabled: t.enabled !== 0 && t.enabled !== false,
  surcharge_iqd: t.surcharge_iqd ?? null,
  sort: Number.isInteger(t.sort) ? Number(t.sort) : TRANSPORT_METHODS.indexOf(t.method as TransportMethod),
  lead_time_text: t.lead_time_text ?? '',
  lead_time_min_days: t.lead_time_min_days ?? null,
  lead_time_max_days: t.lead_time_max_days ?? null,
  capacity: t.capacity ?? null,
  capacity_reserved: t.capacity_reserved ?? 0,
  ...prices(t),
});

const fulfillmentFromWire = (f: WireFulfillment): FormFulfillment => ({
  fulfillment_type: f.fulfillment_type === 'pre_order' ? 'pre_order' : 'direct_sale',
  enabled: f.enabled !== 0 && f.enabled !== false,
  sort: Number.isInteger(f.sort) ? Number(f.sort) : f.fulfillment_type === 'pre_order' ? 1 : 0,
  lead_time_text: f.lead_time_text ?? '',
  lead_time_min_days: f.lead_time_min_days ?? null,
  lead_time_max_days: f.lead_time_max_days ?? null,
  capacity: f.capacity ?? null,
  capacity_reserved: f.capacity_reserved ?? 0,
  transports: (f.transports ?? []).map(transportFromWire),
  ...prices(f),
});

/** Decodes the server's canonical `o:<id>|c:<id>` combination key. */
export function parseComboKey(key: string): { option_value_ids: string[]; color_id: string | null } {
  const parts = key.split('|').filter(Boolean);
  return {
    option_value_ids: parts.filter((p) => p.startsWith('o:')).map((p) => p.slice(2)),
    color_id: parts.find((p) => p.startsWith('c:'))?.slice(2) ?? null,
  };
}

const valueFromWire = (v: WireValue, fulfillments: FormFulfillment[] = []): FormValue => ({
  id: v.id,
  name_en: v.name_en,
  ...(typeof v.name_ar === 'string' && v.name_ar !== '' ? { name_ar: v.name_ar } : {}),
  ...(typeof v.name_ckb === 'string' && v.name_ckb !== '' ? { name_ckb: v.name_ckb } : {}),
  sku_part: v.sku_part ?? '',
  image: v.image ?? '',
  sort: v.sort,
  active: v.active !== 0,
  stock: v.stock ?? null,
  reserved: v.reserved ?? 0,
  low_stock_threshold: v.low_stock_threshold ?? null,
  ...prices(v),
  availability_type: readAvailability(v.availability_type),
  lead_time_text: v.lead_time_text ?? '',
  lead_time_min_days: v.lead_time_min_days ?? null,
  lead_time_max_days: v.lead_time_max_days ?? null,
  variant_key: v.variant_key ?? '',
  variant_label: v.variant_label ?? '',
  fulfillments,
});

/**
 * `GET /api/admin/products/:id/relations` → form state. EVERY ROW THE SERVER
 * RETURNS IS SHOWN: a value whose `group_id` names no group row is not dropped
 * (it used to be — the value existed in the database and the form said 0),
 * it is placed in a synthesized group with an empty name so the admin sees it,
 * is asked to name it, and the next save writes the missing group row.
 */
export function relationsFromWire(r: RelationsResponse): RelationsState {
  const values = r.values ?? [];
  const links = r.links ?? [];
  const fulfillmentsByOption = new Map<string, FormFulfillment[]>();
  for (const raw of r.fulfillments ?? []) {
    const cell = fulfillmentFromWire(raw);
    const arr = fulfillmentsByOption.get(raw.option_id);
    if (arr) arr.push(cell);
    else fulfillmentsByOption.set(raw.option_id, [cell]);
  }
  const byColor = new Map<string, string[]>();
  for (const l of links) {
    const arr = byColor.get(l.color_id);
    if (arr) arr.push(l.option_value_id);
    else byColor.set(l.color_id, [l.option_value_id]);
  }
  const mode = r.product?.inventory_mode;
  const wireGroups = r.groups ?? [];
  const known = new Set(wireGroups.map((g) => g.id));
  const issues: string[] = [];

  const groups: FormGroup[] = wireGroups.map((g) => ({
    id: g.id,
    name_en: g.name_en,
    sort: g.sort,
    active: g.active !== 0,
    values: values
      .filter((v) => v.group_id === g.id)
      .sort((a, b) => a.sort - b.sort)
      .map((v) => valueFromWire(v, fulfillmentsByOption.get(v.id) ?? [])),
  }));

  // Orphans: values referencing a group the response does not carry.
  const orphanGroupIds = [...new Set(values.filter((v) => !known.has(v.group_id)).map((v) => v.group_id))];
  for (const gid of orphanGroupIds) {
    const orphaned = values.filter((v) => v.group_id === gid).sort((a, b) => a.sort - b.sort);
    groups.push({
      id: gid || localId('og'),
      name_en: '',
      sort: groups.length,
      active: true,
      values: orphaned.map((v) => valueFromWire(v, fulfillmentsByOption.get(v.id) ?? [])),
    });
    issues.push(
      `${orphaned.length} خيار (${orphaned.map((v) => v.name_en || v.id).join(', ')}) مخزّن بلا مجموعة — سمِّ المجموعة ثم احفظ لتُكتب.`
    );
  }

  return {
    inventory_mode:
      mode === 'OPTION' || mode === 'COLOR' || mode === 'VARIANT_COMBINATION' ? mode : 'BASE',
    groups,
    colors: (r.colors ?? []).map((c) => ({
      id: c.id,
      name_en: c.name_en,
      ...(typeof c.name_ar === 'string' && c.name_ar !== '' ? { name_ar: c.name_ar } : {}),
      ...(typeof c.name_ckb === 'string' && c.name_ckb !== '' ? { name_ckb: c.name_ckb } : {}),
      hex: c.hex ?? '',
      image: c.image ?? '',
      sku_part: c.sku_part ?? '',
      sort: c.sort,
      active: c.active !== 0,
      stock: c.stock ?? null,
      reserved: c.reserved ?? 0,
      low_stock_threshold: c.low_stock_threshold ?? null,
      option_value_ids: byColor.get(c.id) ?? [],
      ...prices(c),
    })),
    variants: (r.variants ?? []).map((v) => ({
      id: v.id,
      ...parseComboKey(v.combo_key),
      sku: v.sku ?? '',
      active: v.active !== 0,
      stock: v.stock ?? null,
      reserved: v.reserved ?? 0,
      low_stock_threshold: v.low_stock_threshold ?? null,
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
        option_value_id: i.option_value_id ?? null,
        color_id: i.color_id ?? null,
        variant_id: i.variant_id ?? null,
        width: i.width ?? null,
        height: i.height ?? null,
        source_url: i.source_url ?? '',
        ...(typeof i.alt_ar === 'string' && i.alt_ar !== '' ? { alt_ar: i.alt_ar } : {}),
        ...(typeof i.alt_ckb === 'string' && i.alt_ckb !== '' ? { alt_ckb: i.alt_ckb } : {}),
        ...(typeof i.r2_key === 'string' && i.r2_key !== '' ? { r2_key: i.r2_key } : {}),
      })),
    ...(issues.length > 0 ? { hydration_issues: issues } : {}),
  };
}

/** Whether the relations view carries any structure at all (the storefront's `has_relations`). */
export function hasRelationStructure(rel: RelationsState): boolean {
  return rel.groups.length > 0 || rel.colors.length > 0 || rel.images.length > 0 || rel.variants.length > 0;
}

/** The product document's own copy of the structure, as the admin GET returns it. */
export interface DocStructure {
  options?: OptionV2[] | null;
  colors?: ColorV2[] | null;
  media?: MediaV2[] | null;
  sale_types?: string[] | null;
  selling_type?: string | null;
  preorder_transports?: Array<{ method: TransportMethod; commission_iqd: number | null; active: boolean }> | null;
}

export function docHasStructure(doc: DocStructure): boolean {
  return (doc.options?.length ?? 0) > 0 || (doc.colors?.length ?? 0) > 0 || (doc.media?.length ?? 0) > 0;
}

const docPrices = (x: OptionV2 | ColorV2): FormPrices =>
  prices({
    regular_price_iqd: x.regular_price_iqd ?? null,
    prime_price_iqd: x.prime_price_iqd ?? null,
    pro_price_iqd: x.pro_price_iqd ?? null,
    cost_iqd: x.cost_iqd ?? null,
    regular_adjust_iqd: x.regular_adjust_iqd ?? null,
    prime_adjust_iqd: x.prime_adjust_iqd ?? null,
    pro_adjust_iqd: x.pro_adjust_iqd ?? null,
    cost_adjust_iqd: x.cost_adjust_iqd ?? null,
  });

/**
 * Form state built from the product DOCUMENT (`products.options / colors /
 * images` JSON) — the fallback the storefront already sells from
 * (worker/lib/productOverlay.ts `!view.has_relations`), mirrored here so the
 * admin sees the same options, colours and pictures the customer does.
 *
 * Grouping follows the server bridge (worker/lib/templateRelations.ts): a
 * value joins the group its `group_en` names; a value naming none joins the
 * first group, or a group called "Options" when there is none. Ids are the
 * document's own, so saving this state creates the relation rows under the
 * same ids the cart and the storefront already reference. Nothing is
 * invented: an absent stock is null, an absent price inherits.
 */
export function relationsFromDoc(doc: DocStructure): RelationsState {
  const options = (doc.options ?? []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const groups: FormGroup[] = [];
  const byName = new Map<string, FormGroup>();
  const groupFor = (o: OptionV2): FormGroup => {
    const name = (o.group_en ?? '').trim();
    if (name) {
      const found = byName.get(name.toLowerCase());
      if (found) return found;
      const made: FormGroup = { id: localId('og'), name_en: name, sort: groups.length, active: true, values: [] };
      groups.push(made);
      byName.set(name.toLowerCase(), made);
      return made;
    }
    if (groups.length > 0) return groups[0];
    const made: FormGroup = { id: localId('og'), name_en: 'Options', sort: 0, active: true, values: [] };
    groups.push(made);
    byName.set('options', made);
    return made;
  };
  options.forEach((o, i) => {
    const g = groupFor(o);
    g.values.push({
      id: o.id,
      name_en: o.name_en || o.name_ar,
      // CARRIED VERBATIM. This used to drop an Arabic or Kurdish name equal to
      // the English one as a "fake translation" — but in this catalogue an
      // Arabic option name is often a latin model token ('A1', '0.4mm'), and
      // the writer now honours an explicit clear: the dropped field came back
      // as '' in `relationsToWire` and BLANKED the row on the first save, on
      // exactly the legacy JSON-only products this fallback exists to rescue
      // (docs/TXT_IMPORT_PARITY.md, root cause 7 — client twin).
      ...(o.name_ar ? { name_ar: o.name_ar } : {}),
      ...(o.name_ckb ? { name_ckb: o.name_ckb } : {}),
      sku_part: o.sku_part ?? '',
      image: o.image ?? '',
      sort: typeof o.order === 'number' ? o.order : i,
      active: o.active !== false,
      stock: o.stock ?? null,
      reserved: 0,
      low_stock_threshold: o.low_stock_threshold ?? null,
      ...docPrices(o),
      availability_type: readAvailability(o.availability_type),
      lead_time_text: o.lead_time_text ?? '',
      lead_time_min_days: o.lead_time_min_days ?? null,
      lead_time_max_days: o.lead_time_max_days ?? null,
      variant_key: o.variant_key ?? '',
      variant_label: o.variant_label ?? '',
      fulfillments: [],
    });
  });
  for (const g of groups) g.values.forEach((v, i) => (v.sort = i));

  const valueIds = new Set(options.map((o) => o.id));
  const colors: FormColor[] = (doc.colors ?? [])
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((c, i) => {
      const linked = (c.option_ids && c.option_ids.length > 0 ? c.option_ids : c.option_id ? [c.option_id] : []).filter((id) =>
        valueIds.has(id)
      );
      return {
        id: c.id,
        name_en: c.name_en || c.name_ar,
        ...(c.name_ar ? { name_ar: c.name_ar } : {}),
        ...(c.name_ckb ? { name_ckb: c.name_ckb } : {}),
        hex: c.hex ?? '',
        image: c.image ?? '',
        sku_part: c.sku_part ?? '',
        sort: i,
        active: c.active !== false,
        stock: c.stock ?? null,
        reserved: 0,
        low_stock_threshold: c.low_stock_threshold ?? null,
        option_value_ids: linked,
        ...docPrices(c),
      };
    });

  const colorIds = new Set(colors.map((c) => c.id));
  const media = (doc.media ?? []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const anyPrimary = media.some((m) => m.primary);
  const images: FormImage[] = media.map((m, i) => ({
    id: m.id,
    url: m.url,
    alt_en: m.alt_en ?? '',
    sort_order: i,
    is_primary: anyPrimary ? m.primary === true : i === 0,
    option_value_id: m.option_value_id && valueIds.has(m.option_value_id) ? m.option_value_id : null,
    color_id: m.color_id && colorIds.has(m.color_id) ? m.color_id : null,
    variant_id: null,
    width: m.width ?? null,
    height: m.height ?? null,
    source_url: m.source_url ?? '',
    ...(m.alt_ar ? { alt_ar: m.alt_ar } : {}),
    ...(m.alt_ckb ? { alt_ckb: m.alt_ckb } : {}),
    ...(m.key ? { r2_key: m.key } : {}),
  }));

  const rel: RelationsState = { inventory_mode: 'BASE', groups, colors, variants: [], images };
  rel.inventory_mode = deriveInventoryMode(rel);
  return rel;
}

/**
 * The editor's relation state for a loaded product: the relation tables when
 * they hold anything, else the product document's copy. This is the SAME
 * precedence the storefront applies (productOverlay.ts), so the two never
 * disagree about what a product sells. Falling back is reported in
 * `hydration_issues` — the admin is told the rows do not exist yet and that
 * saving writes them.
 */
export function hydrateRelations(wire: RelationsResponse, doc: DocStructure): RelationsState {
  const fromRows = relationsFromWire(wire);
  if (hasRelationStructure(fromRows) || !docHasStructure(doc)) return withFulfillmentDefaults(fromRows, doc);
  const fromDoc = relationsFromDoc(doc);
  const n = { v: fromDoc.groups.reduce((a, g) => a + g.values.length, 0), c: fromDoc.colors.length, i: fromDoc.images.length };
  return {
    ...withFulfillmentDefaults(fromDoc, doc),
    hydration_issues: [
      ...(fromRows.hydration_issues ?? []),
      `الخيارات (${n.v}) والألوان (${n.c}) والصور (${n.i}) مقروءة من مستند المنتج — لا صفوف علاقات بعد. الحفظ من هنا يكتبها كصفوف.`,
    ],
  };
}

/**
 * The editor always renders two independent checkboxes for every model. Old
 * products may have no cell rows yet, so their current product-level behaviour
 * is projected into those checkboxes without copying any legacy fee. A null
 * cell price continues to inherit the old product surcharge/transport tariff,
 * preserving the customer's final price until the admin deliberately changes
 * this model.
 */
function withFulfillmentDefaults(rel: RelationsState, doc: DocStructure): RelationsState {
  const fallback = Array.isArray(doc.sale_types) && doc.sale_types.length
    ? doc.sale_types
    : [doc.selling_type || 'direct_sale'];
  const productRoutes = new Map((doc.preorder_transports ?? []).map((t) => [t.method, t] as const));

  const completeTransports = (stored: FormTransport[]): FormTransport[] =>
    TRANSPORT_METHODS.map((method) => {
      const found = stored.find((t) => t.method === method);
      if (found) return found;
      const legacy = productRoutes.get(method);
      return emptyTransport(method, legacy?.active === true);
    });

  return {
    ...rel,
    groups: rel.groups.map((g) => ({
      ...g,
      values: g.values.map((v) => {
        const stored = v.fulfillments ?? [];
        const own = readAvailability(v.availability_type);
        const directEnabled = own ? own === 'direct_sale' : fallback.includes('direct_sale') || fallback.includes('bundle');
        const preorderEnabled = own ? own === 'pre_order' : fallback.includes('pre_order');
        const direct = stored.find((f) => f.fulfillment_type === 'direct_sale') ?? emptyFulfillment('direct_sale', directEnabled);
        const preorder = stored.find((f) => f.fulfillment_type === 'pre_order') ?? emptyFulfillment('pre_order', preorderEnabled);
        return {
          ...v,
          fulfillments: [
            { ...direct, transports: [] },
            { ...preorder, transports: completeTransports(preorder.transports) },
          ],
        };
      }),
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
  // A colour tied to a model is an exact (option + colour) shelf. The variant
  // row is therefore authoritative even when its stock is currently blank;
  // falling back to the option row would make all colours spend one counter.
  const exact = directStockCombinations(rel);
  const variants = new Map(rel.variants.filter((v) => v.active).map((v) => [combinationKey(v), v] as const));
  if (exact.length > 0 && exact.every((x) => variants.get(combinationKey(x))?.stock !== null && variants.get(combinationKey(x))?.stock !== undefined)) {
    return 'VARIANT_COMBINATION';
  }
  if (rel.inventory_mode === 'VARIANT_COMBINATION' && rel.variants.length > 0) return 'VARIANT_COMBINATION';
  // COLOR is retained only as a legacy bridge. New edits use exact variants,
  // because one colour linked to two models needs two independent counters.
  if (rel.colors.some((c) => c.stock !== null)) return 'COLOR';
  if (rel.groups.some((g) => g.values.some((v) => v.stock !== null))) return 'OPTION';
  return 'BASE';
}

const fulfillmentToWire = (f: FormFulfillment) => ({
  fulfillment_type: f.fulfillment_type,
  enabled: f.enabled,
  sort: f.sort,
  ...prices(f),
  lead_time_text: f.lead_time_text,
  lead_time_min_days: f.lead_time_min_days,
  lead_time_max_days: f.lead_time_max_days,
  // Pre-order quantity tracking was removed. A legacy counter is carried only
  // while a live order still holds units, so its later release can reach the
  // same row. Once drained, the next save retires it to NULL.
  capacity: f.capacity_reserved > 0 ? f.capacity : null,
  transports:
    f.fulfillment_type === 'pre_order'
      ? f.transports.map((t, sort) => ({
          method: t.method,
          enabled: t.enabled,
          surcharge_iqd: t.surcharge_iqd,
          sort,
          ...prices(t),
          lead_time_text: t.lead_time_text,
          lead_time_min_days: t.lead_time_min_days,
          lead_time_max_days: t.lead_time_max_days,
          capacity: t.capacity_reserved > 0 ? t.capacity : null,
        }))
      : [],
});

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
        name_ar: v.name_ar ?? '',
        name_ckb: v.name_ckb ?? '',
        sku_part: v.sku_part,
        image: v.image,
        sort: vi,
        active: v.active,
        stock: v.stock,
        low_stock_threshold: v.low_stock_threshold,
        ...prices(v),
        // Legacy readers still receive the only unambiguous single answer.
        // Both enabled is represented by the fulfillment cells, not by a fake
        // "mixed" option value.
        availability_type: (() => {
          const direct = v.fulfillments.some((f) => f.fulfillment_type === 'direct_sale' && f.enabled);
          const preorder = v.fulfillments.some((f) => f.fulfillment_type === 'pre_order' && f.enabled);
          return direct !== preorder ? (direct ? 'direct_sale' : 'pre_order') : '';
        })(),
        lead_time_text: v.fulfillments.find((f) => f.fulfillment_type === 'pre_order')?.lead_time_text ?? '',
        lead_time_min_days: v.fulfillments.find((f) => f.fulfillment_type === 'pre_order')?.lead_time_min_days ?? null,
        lead_time_max_days: v.fulfillments.find((f) => f.fulfillment_type === 'pre_order')?.lead_time_max_days ?? null,
        variant_key: v.variant_key,
        variant_label: v.variant_label,
        fulfillments: v.fulfillments.map(fulfillmentToWire),
      })),
    })),
    colors: rel.colors.map((c, ci) => ({
      id: c.id,
      name_en: c.name_en,
      name_ar: c.name_ar ?? '',
      name_ckb: c.name_ckb ?? '',
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
      source_url: i.source_url ?? '',
      alt_ar: i.alt_ar ?? '',
      alt_ckb: i.alt_ckb ?? '',
      r2_key: i.r2_key ?? '',
    })),
  };
}

// -------------------------------------------------------------- validation

export interface FormErrors {
  [key: string]: string;
}

/** The three selling prices one level of the ladder resolves to. */
interface Ladder {
  regular: number;
  prime: number | null;
  pro: number | null;
}

const isNum = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v);
const iqd = (n: number | null) => (n === null ? '—' : n.toLocaleString('en-US'));

/**
 * A FAITHFUL COPY of worker/lib/pricing.ts `memberAtRung` + `derivedRung`.
 *
 * The client cannot import worker code, and the server re-validates every
 * save, so this exists for one reason: the form must flag exactly the rows the
 * server refuses, before the round trip, on the number the row RESOLVES to
 * rather than the number typed into it. Change one, change the other —
 * tests/productModelLadder.test.ts runs both over the same fixtures.
 *
 * `regular` is the row's fixed price, else the value beneath moved by its
 * adjustment, else the value beneath. A member field with nothing of its own
 * inherits the value beneath PLUS this row's regular surcharge (the owner's
 * rule); a fixed member price replaces it; a member adjustment applies on top
 * of the carried value, or on the row's regular price when nothing is carried.
 * `consumed` names the member prices the row inherits but reduces to nothing;
 * `inverted` says the derived PRO ended up above the derived PRIME.
 */
function derivedRung(row: FormPrices, beneath: Ladder): Ladder & { consumed: Array<'PRIME' | 'PRO'>; inverted: boolean } {
  const regAdj = row.regular_adjust_iqd;
  const regular = isNum(row.regular_price_iqd)
    ? row.regular_price_iqd
    : isNum(regAdj)
      ? Math.max(0, Math.round(beneath.regular + regAdj))
      : beneath.regular;
  const delta = regular - beneath.regular;
  const consumed: Array<'PRIME' | 'PRO'> = [];
  const member = (name: 'PRIME' | 'PRO', own: number | null, adj: number | null | undefined, inherited: number | null): number | null => {
    const carried = inherited === null ? null : inherited + delta > 0 ? Math.round(inherited + delta) : null;
    const statesOwn = isNum(own) || (adj !== null && adj !== undefined);
    if (inherited !== null && !statesOwn && regular > 0 && inherited + delta <= 0) consumed.push(name);
    if (isNum(own)) return own;
    if (isNum(adj)) return Math.max(0, Math.round((carried !== null ? carried : regular) + adj));
    return carried;
  };
  const prime = member('PRIME', row.prime_price_iqd, row.prime_adjust_iqd, beneath.prime);
  const pro = member('PRO', row.pro_price_iqd, row.pro_adjust_iqd, beneath.pro);
  return { regular, prime, pro, consumed, inverted: prime !== null && pro !== null && pro > prime };
}

/**
 * The member ladder follows the regular one (worker/lib/pricing.ts
 * memberAtRung): a row that states no PRIME/PRO inherits the base member
 * price PLUS its own regular surcharge. When `base` is given the row is judged
 * on what it RESOLVES to, exactly as the server does (productModel
 * memberRules / productRelations validatePriceLadder): a reduction that
 * swallows an inherited member price, a derived member price above the row's
 * own regular price, and a derived PRIME below the derived PRO are all
 * flagged. A colour is judged under each option it can be sold with too
 * (`under`), because the resolver anchors it on the option the customer picks.
 */
const ladder = (
  p: FormPrices,
  where: string,
  out: FormErrors,
  key: string,
  base?: { regular: number | null; prime: number | null; pro: number | null },
  under: Array<{ name: string; ladder: Ladder }> = []
) => {
  const { regular_price_iqd: reg, prime_price_iqd: prime, pro_price_iqd: pro, cost_iqd: cost } = p;
  if (base && base.regular !== null) {
    const beneath: Ladder = { regular: base.regular, prime: base.prime, pro: base.pro };
    const d = derivedRung(p, beneath);
    for (const name of d.consumed) {
      out[key] = `${where}: التخفيض أكبر من سعر ${name} الموروث (${iqd(name === 'PRIME' ? beneath.prime : beneath.pro)}) — حدّد سعر ${name} لهذا الصف أو قلّل التخفيض`;
      return;
    }
    if (d.prime !== null && d.prime > d.regular) {
      out[key] = `${where}: سعر PRIME الناتج (${iqd(d.prime)}) أعلى من السعر الاعتيادي (${iqd(d.regular)})`;
      return;
    }
    if (d.pro !== null && d.pro > d.regular) {
      out[key] = `${where}: سعر PRO الناتج (${iqd(d.pro)}) أعلى من السعر الاعتيادي (${iqd(d.regular)})`;
      return;
    }
    if (d.inverted) {
      out[key] = `${where}: سعر PRIME الناتج (${iqd(d.prime)}) أقل من سعر PRO الناتج (${iqd(d.pro)}) — يجب أن يكون PRO ≤ PRIME ≤ الاعتيادي`;
      return;
    }
    for (const u of under) {
      const c = derivedRung(p, u.ladder);
      for (const name of c.consumed) {
        out[key] = `${where} مع الخيار «${u.name}»: التخفيض أكبر من سعر ${name} الموروث (${iqd(name === 'PRIME' ? u.ladder.prime : u.ladder.pro)}) — حدّد سعر ${name} لهذا اللون أو قلّل التخفيض`;
        return;
      }
      if (c.inverted) {
        out[key] = `${where} مع الخيار «${u.name}»: سعر PRIME الناتج (${iqd(c.prime)}) أقل من سعر PRO الناتج (${iqd(c.pro)}) — يجب أن يكون PRO ≤ PRIME ≤ الاعتيادي`;
        return;
      }
    }
  }
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
  /** The extended-warranty block (printers only); omitted = not checked. */
  warranty?: WarrantyFormInput;
  delivery_options?: {
    standard: { enabled: boolean; quantity_step: number; fee_iqd: number };
    personal: { enabled: boolean; quantity_step: number; fee_iqd: number };
  } | null;
}): FormErrors {
  const e: FormErrors = {};
  if (input.warranty) warrantyRules(input.warranty, e);
  if (!input.name_en.trim()) e.name_en = 'الاسم الإنجليزي مطلوب';
  if (input.price_iqd === null) e.price_iqd = 'السعر الاعتيادي مطلوب';
  if (input.publishing && !input.category_id) e.category_id = 'القسم الرئيسي مطلوب للنشر';
  if (input.sale_types.length === 0) e.sale_types = 'اختر نوع بيع واحدًا على الأقل';
  if (input.delivery_options) {
    for (const method of ['standard', 'personal'] as const) {
      const rule = input.delivery_options[method];
      if (!Number.isInteger(rule.quantity_step) || rule.quantity_step < 1) {
        e[`delivery:${method}:quantity_step`] = 'عدد القطع لكل شريحة يجب أن يكون عددًا صحيحًا 1 أو أكثر';
      }
      if (!Number.isInteger(rule.fee_iqd) || rule.fee_iqd < 0) {
        e[`delivery:${method}:fee_iqd`] = 'رسم شريحة التوصيل يجب أن يكون عددًا صحيحًا موجبًا أو صفرًا';
      }
    }
  }

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
  const base = { regular: input.price_iqd, prime: input.prime_price_iqd, pro: input.pro_price_iqd };

  for (const g of input.rel.groups) {
    if (!g.name_en.trim()) e[`group:${g.id}`] = 'اسم المجموعة مطلوب';
    for (const v of g.values) {
      if (!v.name_en.trim()) e[`value:${v.id}`] = 'اسم الخيار مطلوب';
      ladder(v, v.name_en || 'خيار', e, `value_price:${v.id}`, base);
      const enabled = v.fulfillments.filter((f) => f.enabled);
      if (v.active && enabled.length === 0) {
        e[`value_availability:${v.id}`] = 'فعّل البيع المباشر أو الطلب المسبق لهذا الخيار';
      }
      const optionBase = base.regular === null
        ? null
        : derivedRung(v, { regular: base.regular, prime: base.prime, pro: base.pro });
      for (const f of enabled) {
        if (optionBase) {
          ladder(
            f,
            `${v.name_en || 'خيار'} — ${f.fulfillment_type === 'direct_sale' ? 'بيع مباشر' : 'طلب مسبق'}`,
            e,
            `value_availability:${v.id}`,
            optionBase
          );
        }
        if (f.fulfillment_type === 'pre_order' && !f.transports.some((t) => t.enabled)) {
          e[`value_availability:${v.id}`] = 'فعّل طريقة واحدة على الأقل للطلب المسبق: بري أو بحري أو جوي';
        }
      }
    }
  }
  // What every ACTIVE option resolves to on top of the base — the rungs a
  // colour is checked under. The server's flat option list is every value with
  // its own `active` flag (productOverlay), so a group flag plays no part here.
  const optionLadders =
    base.regular === null
      ? []
      : input.rel.groups
          .flatMap((g) => g.values)
          .filter((v) => v.active)
          .map((v) => ({ id: v.id, name: v.name_en || 'خيار', ladder: derivedRung(v, { regular: base.regular as number, prime: base.prime, pro: base.pro }) }));
  for (const c of input.rel.colors) {
    if (!c.name_en.trim()) e[`color:${c.id}`] = 'اسم اللون مطلوب';
    if (!/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(c.hex)) e[`color_hex:${c.id}`] = 'كود لون غير صالح';
    // Its link set when it has one, else every active option.
    const under = c.option_value_ids.length ? optionLadders.filter((o) => c.option_value_ids.includes(o.id)) : optionLadders;
    ladder(c, c.name_en || 'لون', e, `color_price:${c.id}`, base, under);
  }
  for (const v of input.rel.variants) {
    if (v.option_value_ids.length === 0 && !v.color_id) {
      e[`variant:${v.id}`] = 'التركيبة تحتاج خيارًا أو لونًا';
    }
    ladder(v, 'تركيبة', e, `variant_price:${v.id}`);
  }
  const valuesById = new Map(input.rel.groups.flatMap((g) => g.values.map((v) => [v.id, v] as const)));
  const variantsByKey = new Map(input.rel.variants.map((v) => [combinationKey(v), v] as const));
  const exactDirectStock = directStockCombinations(input.rel);
  if (exactDirectStock.length === 0) {
    for (const value of valuesById.values()) {
      const direct = value.active && value.fulfillments.some(
        (f) => f.fulfillment_type === 'direct_sale' && f.enabled
      );
      if (direct && value.stock === null) {
        e[`option_stock:${value.id}`] = 'أدخل مخزون البيع المباشر لهذا الخيار';
      }
    }
  }
  for (const combo of exactDirectStock) {
    const direct = combo.option_value_ids.some((id) =>
      valuesById.get(id)?.fulfillments.some((f) => f.fulfillment_type === 'direct_sale' && f.enabled)
    );
    if (!direct) continue;
    const row = variantsByKey.get(combinationKey(combo));
    if (!row || row.stock === null) {
      e[combo.color_id ? `color_stock:${combo.color_id}` : 'inventory_mode'] = combo.color_id
        ? 'أدخل مخزون البيع المباشر لكل خيار مرتبط بهذا اللون'
        : 'أدخل مخزون البيع المباشر للخيارات التي لا ترتبط بألوان';
    }
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
