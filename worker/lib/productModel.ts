/**
 * Canonical product document — ONE schema/validation contract shared by the
 * editor API, template parser, URL-extraction draft, persistence and
 * storefront projections (mandate §4).
 *
 * Storage: the `products` row plus JSON columns. Legacy JSON shapes from the
 * v1 editor are upgraded IN CODE by the adapters below — reads never fail on
 * old data and nothing is truncated. Writes always persist v2 shapes and
 * bump doc_version to 2.
 *
 * Language columns: DB *_ar is the Arabic source; DB `name`/`description`
 * hold English; DB *_ku columns hold Iraqi Kurdish content exposed as `ckb`.
 *
 * Null-vs-zero: nullable price fields use null = inherit; 0 is explicit.
 * Legacy option/color prices of 0/undefined are upgraded to null because the
 * v1 resolver ignored non-positive overrides (documented in FIELD_MAPPING).
 */

import { safeParse } from './types';
import { badRequest } from './http';
import { newId } from './crypto';
import type { OptionV2, ColorV2, TransportOffer, WarrantyPlanV2, PriceFields } from './pricing';

export const DOC_VERSION = 2;

export interface MediaV2 {
  id: string;
  url: string; // delivery URL (/files/<key> or remote)
  key: string; // R2 object key when stored internally, else ''
  role: 'gallery';
  alt_ar: string;
  alt_en: string;
  alt_ckb: string;
  order: number;
  primary: boolean;
  width: number | null;
  height: number | null;
  source_url: string; // original remote source when imported
}

export interface SpecRowV2 {
  id: string;
  label_ar: string;
  label_en: string;
  label_ckb: string;
  value_ar: string;
  value_en: string;
  value_ckb: string;
  unit: string;
  order: number;
}

export interface SpecGroupV2 {
  id: string;
  title_ar: string;
  title_en: string;
  title_ckb: string;
  order: number;
  rows: SpecRowV2[];
}

export interface LabelV2 {
  id: string;
  key: string; // optional controlled key ('featured', 'warranty_included', 'free_returns', 'free_plus') or ''
  text_ar: string;
  text_en: string;
  text_ckb: string;
  icon: string;
  order: number;
  visible: boolean;
}

export interface ContentBlockV2 {
  id: string;
  kind: 'text' | 'image' | 'video_embed';
  order: number;
  body_ar: string;
  body_en: string;
  body_ckb: string;
  caption_ar: string;
  caption_en: string;
  caption_ckb: string;
  alt_ar: string;
  alt_en: string;
  alt_ckb: string;
  url: string; // embed URL for video_embed, image URL for image
  media_key: string; // R2 key when internal
}

export interface TranslationStatusEntry {
  status: 'approved' | 'imported' | 'stale' | 'missing';
  src_rev: number;
}

/**
 * Per-field, per-language state. ENGLISH IS THE SOURCE (product-form mandate
 * §3); `ar` and `ckb` describe the locally generated copies. `en` is kept so
 * pre-§3 rows written under the older Arabic-sourced scheme still parse.
 */
export interface TranslationMeta {
  [field: string]: {
    en?: TranslationStatusEntry;
    ar?: TranslationStatusEntry;
    ckb?: TranslationStatusEntry;
  };
}

export interface ProductDoc {
  id: string;
  slug: string;
  status: 'draft' | 'active' | 'hidden';
  doc_version: number;
  content_rev: number;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  description_ar: string;
  description_en: string;
  description_ckb: string;
  price_iqd: number; // regular base — required
  pro_price_iqd: number | null;
  /** LEVO PRIME base price (mandate §5). NULL = falls back to regular; a
   *  PRIME discount is never invented. */
  prime_price_iqd: number | null;
  product_cost_iqd: number | null; // internal, admin-only
  /** Legacy scalar, kept as sale_types[0] so pre-0018 readers keep working. */
  selling_type: 'direct_sale' | 'pre_order' | 'bundle';
  /** §6: a product may offer several sale types at once. Never empty. */
  sale_types: Array<'direct_sale' | 'pre_order' | 'bundle'>;
  preorder_transports: TransportOffer[];
  stock: number | null;
  /** Warn level for the BASE stock row; null = no warning configured. */
  low_stock_threshold: number | null;
  brand_id: string | null;
  /** §4: the main section and its sub-section, as real catalogs rows. */
  category_id: string | null;
  sub_category_id: string | null;
  /** 'devices' | 'materials' | null = inherit from the section (§10). */
  template_family: string | null;
  /** §4: optional, or generated at save time. */
  sku: string | null;
  /** §10: values for the spec fields the section's template declares. */
  spec_fields: Record<string, string>;
  media: MediaV2[];
  options: OptionV2[];
  colors: ColorV2[];
  spec_groups: SpecGroupV2[];
  labels: LabelV2[];
  warranty_plans: WarrantyPlanV2[];
  content_blocks: ContentBlockV2[];
  translation_meta: TranslationMeta;
  is_featured: boolean;
  display_order: number;
  payment_options: string[];
  hashtags: string[];
  how_to_use: string;
  // Legacy read-only passthrough (v1 data preserved, not edited in v2 UI):
  legacy: {
    brand_text: string;
    categories: string;
    subcategory_id: string;
    shipping_methods: unknown[];
    features: unknown[];
    description_images: unknown[];
    description_videos: unknown[];
    stores: unknown[];
    algorithm_tags: unknown[];
    membership_prices: Record<string, number>;
  };
  created_at?: string;
  updated_at?: string;
}

// ---------------------------------------------------------------- helpers

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;

/** Legacy semantics ignored non-positive overrides → upgrade 0/absent to null. */
const legacyPrice = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;

const s = (v: unknown, max = 5000): string => (typeof v === 'string' ? v.slice(0, max) : '');
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const METHODS = ['air', 'sea', 'land'] as const;

function ensureId(v: unknown, prefix: string): string {
  const id = typeof v === 'string' && v.trim() ? v.trim().slice(0, 60) : '';
  return id || newId(prefix);
}

// ---------------------------------------------------------------- adapters (read)

export function upgradeMedia(raw: unknown): MediaV2[] {
  const arr = Array.isArray(raw) ? raw : safeParse<unknown[]>(raw, []);
  const out: MediaV2[] = [];
  arr.forEach((item, i) => {
    if (typeof item === 'string' && item) {
      out.push({
        id: `img_legacy_${i}`, url: item, key: item.startsWith('/files/') ? item.slice(7) : '',
        role: 'gallery', alt_ar: '', alt_en: '', alt_ckb: '', order: i, primary: i === 0,
        width: null, height: null, source_url: '',
      });
    } else if (item && typeof item === 'object') {
      const m = item as Partial<MediaV2>;
      if (!m.url && !m.key) return;
      out.push({
        id: ensureId(m.id, 'img'),
        url: s(m.url, 1000) || (m.key ? `/files/${m.key}` : ''),
        key: s(m.key, 400),
        role: 'gallery',
        alt_ar: s(m.alt_ar, 300), alt_en: s(m.alt_en, 300), alt_ckb: s(m.alt_ckb, 300),
        order: typeof m.order === 'number' ? m.order : i,
        primary: !!m.primary,
        width: num(m.width), height: num(m.height),
        source_url: s(m.source_url, 1000),
      });
    }
  });
  out.sort((a, b) => a.order - b.order);
  if (out.length && !out.some((m) => m.primary)) out[0].primary = true;
  // Exactly one primary.
  let seen = false;
  for (const m of out) {
    if (m.primary && seen) m.primary = false;
    if (m.primary) seen = true;
  }
  return out;
}

// Compare-at is gone (mandate §4). A stored v2 option/color may still carry
// compare_at_iqd from before 0018 — it is simply not read, and prime_price_iqd
// takes its place in the four-price ladder.
function upgradePriceFields(o: Record<string, unknown>): PriceFields {
  const isV2 = 'regular_price_iqd' in o || 'compare_at_iqd' in o || 'prime_price_iqd' in o;
  if (isV2) {
    return {
      regular_price_iqd: num(o.regular_price_iqd),
      prime_price_iqd: num(o.prime_price_iqd),
      pro_price_iqd: num(o.pro_price_iqd),
      cost_iqd: num(o.cost_iqd),
    };
  }
  return {
    regular_price_iqd: legacyPrice(o.price_iqd),
    prime_price_iqd: legacyPrice(o.prime_price_iqd),
    pro_price_iqd: legacyPrice(o.pro_price_iqd),
    cost_iqd: legacyPrice(o.cost_iqd),
  };
}

/** §10: a flat {field_id: value} map of template-declared spec values. Values
 *  are trimmed strings; anything else is dropped rather than coerced. */
function readSpecFields(raw: unknown): Record<string, string> {
  const src = typeof raw === 'string' ? safeParse<Record<string, unknown>>(raw, {}) : raw;
  if (!src || typeof src !== 'object' || Array.isArray(src)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
    if (typeof k !== 'string' || k.length > 80) continue;
    if (typeof v === 'string') out[k] = v.slice(0, 2000);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = String(v);
  }
  return out;
}

/** §6: normalizes the multi-select sale types, always yielding at least one. */
export function normalizeSaleTypes(raw: unknown, fallback: string): ProductDoc['sale_types'] {
  const allowed = ['direct_sale', 'pre_order', 'bundle'] as const;
  const list = Array.isArray(raw) ? raw : safeParseArr(raw);
  const out = allowed.filter((t) => list.includes(t));
  if (out.length) return [...out];
  const single = allowed.find((t) => t === fallback);
  return [single ?? 'direct_sale'];
}

export function upgradeOptions(raw: unknown): OptionV2[] {
  const arr = safeParseArr(raw);
  return arr.map((item, i) => {
    const o = item as Record<string, unknown>;
    return {
      id: ensureId(o.id, 'opt'),
      name_ar: s(o.name_ar, 200),
      name_en: s(o.name_en ?? o.name, 200),
      name_ckb: s(o.name_ckb ?? o.name_ku, 200),
      image: s(o.image, 1000),
      order: typeof o.order === 'number' ? (o.order as number) : i,
      active: o.active !== false,
      ...upgradePriceFields(o),
    };
  }).sort((a, b) => a.order - b.order);
}

export function upgradeColors(raw: unknown): ColorV2[] {
  const arr = safeParseArr(raw);
  return arr.map((item, i) => {
    const c = item as Record<string, unknown>;
    let optionId: string | null = typeof c.option_id === 'string' && c.option_id ? (c.option_id as string) : null;
    if (!optionId && Array.isArray(c.linked_option_ids) && typeof c.linked_option_ids[0] === 'string') {
      optionId = c.linked_option_ids[0] as string; // v1 multi-link → first link
    }
    const hexRaw = s(c.hex ?? c.hex_code, 10);
    return {
      id: ensureId(c.id, 'col'),
      name_ar: s(c.name_ar, 200),
      name_en: s(c.name_en ?? c.name, 200),
      name_ckb: s(c.name_ckb ?? c.name_ku, 200),
      hex: HEX_RE.test(hexRaw) ? hexRaw : '',
      image: s(c.image, 1000),
      option_id: optionId,
      order: typeof c.order === 'number' ? (c.order as number) : i,
      active: c.active !== false,
      ...upgradePriceFields(c),
    };
  }).sort((a, b) => a.order - b.order);
}

export function upgradeSpecGroups(raw: unknown): SpecGroupV2[] {
  const arr = safeParseArr(raw);
  if (arr.length === 0) return [];
  const first = arr[0] as Record<string, unknown>;
  if (Array.isArray(first?.rows)) {
    // Already v2.
    return arr.map((g0, gi) => {
      const g = g0 as Record<string, unknown>;
      return {
        id: ensureId(g.id, 'sg'),
        title_ar: s(g.title_ar, 200), title_en: s(g.title_en, 200), title_ckb: s(g.title_ckb, 200),
        order: typeof g.order === 'number' ? (g.order as number) : gi,
        rows: (Array.isArray(g.rows) ? g.rows : []).map((r0, ri) => {
          const r = r0 as Record<string, unknown>;
          return {
            id: ensureId(r.id, 'sr'),
            label_ar: s(r.label_ar, 300), label_en: s(r.label_en, 300), label_ckb: s(r.label_ckb, 300),
            value_ar: s(r.value_ar, 1000), value_en: s(r.value_en, 1000), value_ckb: s(r.value_ckb, 1000),
            unit: s(r.unit, 40),
            order: typeof r.order === 'number' ? (r.order as number) : ri,
          };
        }).sort((a, b) => a.order - b.order),
      };
    }).sort((a, b) => a.order - b.order);
  }
  // Legacy flat [{key, value}] → one general group; language of legacy text
  // is unknown, stored as Arabic source with en/ckb marked missing via meta.
  return [{
    id: 'sg_general',
    title_ar: 'المواصفات', title_en: 'Specifications', title_ckb: '',
    order: 0,
    rows: arr.map((r0, ri) => {
      const r = r0 as Record<string, unknown>;
      return {
        id: `sr_legacy_${ri}`,
        label_ar: s(r.key, 300), label_en: '', label_ckb: '',
        value_ar: s(r.value, 1000), value_en: '', value_ckb: '',
        unit: '', order: ri,
      };
    }),
  }];
}

export function upgradeLabels(raw: unknown): LabelV2[] {
  const arr = safeParseArr(raw);
  return arr.map((item, i) => {
    if (typeof item === 'string') {
      return { id: `lbl_legacy_${i}`, key: '', text_ar: item, text_en: '', text_ckb: '', icon: '', order: i, visible: true };
    }
    const l = item as Record<string, unknown>;
    return {
      id: ensureId(l.id, 'lbl'),
      key: s(l.key, 60),
      text_ar: s(l.text_ar, 200), text_en: s(l.text_en, 200), text_ckb: s(l.text_ckb, 200),
      icon: s(l.icon, 60),
      order: typeof l.order === 'number' ? (l.order as number) : i,
      visible: l.visible !== false,
    };
  }).sort((a, b) => a.order - b.order);
}

export function upgradeWarranty(raw: unknown): WarrantyPlanV2[] {
  const arr = safeParseArr(raw);
  return arr.map((item, i) => {
    const w = item as Record<string, unknown>;
    const isV2 = 'title_ar' in w || 'duration_months' in w;
    if (isV2) {
      return {
        id: ensureId(w.id, 'wp'),
        title_ar: s(w.title_ar, 200), title_en: s(w.title_en, 200), title_ckb: s(w.title_ckb, 200),
        terms_ar: s(w.terms_ar, 3000), terms_en: s(w.terms_en, 3000), terms_ckb: s(w.terms_ckb, 3000),
        duration_months: num(w.duration_months) ?? 12,
        duration_kind: (w.duration_kind === 'extension' ? 'extension' : 'total') as 'total' | 'extension',
        fee_iqd: num(w.fee_iqd) ?? 0,
        order: typeof w.order === 'number' ? (w.order as number) : i,
        active: w.active !== false,
      };
    }
    return {
      id: `wp_legacy_${i}`,
      title_ar: s(w.name, 200), title_en: '', title_ckb: '',
      terms_ar: '', terms_en: '', terms_ckb: '',
      duration_months: 12, duration_kind: 'total' as const,
      fee_iqd: num(w.price_iqd) ?? 0,
      order: i, active: true,
    };
  }).sort((a, b) => a.order - b.order);
}

export function upgradeTransports(raw: unknown): TransportOffer[] {
  const arr = safeParseArr(raw);
  const out: TransportOffer[] = [];
  for (const item of arr) {
    const t = item as Record<string, unknown>;
    if (METHODS.includes(t.method as never)) {
      out.push({
        method: t.method as TransportOffer['method'],
        commission_iqd: num(t.commission_iqd),
        active: t.active !== false,
      });
    }
  }
  return out;
}

export function upgradeContentBlocks(raw: unknown): ContentBlockV2[] {
  const arr = safeParseArr(raw);
  return arr.map((item, i) => {
    const b = item as Record<string, unknown>;
    const kind = (b.kind === 'image' || b.kind === 'video_embed' ? b.kind : 'text') as ContentBlockV2['kind'];
    return {
      id: ensureId(b.id, 'cb'),
      kind,
      order: typeof b.order === 'number' ? (b.order as number) : i,
      body_ar: s(b.body_ar, 20000), body_en: s(b.body_en, 20000), body_ckb: s(b.body_ckb, 20000),
      caption_ar: s(b.caption_ar, 500), caption_en: s(b.caption_en, 500), caption_ckb: s(b.caption_ckb, 500),
      alt_ar: s(b.alt_ar, 300), alt_en: s(b.alt_en, 300), alt_ckb: s(b.alt_ckb, 300),
      url: s(b.url, 1000),
      media_key: s(b.media_key, 400),
    };
  }).sort((a, b) => a.order - b.order);
}

function safeParseArr(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  return safeParse<unknown[]>(raw, []);
}

// ---------------------------------------------------------------- row → doc

export function parseProductRow(row: Record<string, unknown>): ProductDoc {
  return {
    id: String(row.id),
    slug: String(row.slug),
    status: (row.status as ProductDoc['status']) ?? 'active',
    doc_version: num(row.doc_version) ?? 1,
    content_rev: num(row.content_rev) ?? 1,
    name_ar: s(row.name_ar, 300),
    name_en: s(row.name, 300),
    name_ckb: s(row.name_ku, 300),
    description_ar: s(row.description_ar, 50000),
    description_en: s(row.description, 50000),
    description_ckb: s(row.description_ku, 50000),
    price_iqd: num(row.price_iqd) ?? 0,
    pro_price_iqd: num(row.pro_price_iqd),
    prime_price_iqd: num(row.prime_price_iqd),
    product_cost_iqd: num(row.product_cost_iqd),
    selling_type: row.selling_type === 'pre_order' || row.selling_type === 'bundle' ? row.selling_type : 'direct_sale',
    sale_types: normalizeSaleTypes(row.sale_types, String(row.selling_type ?? 'direct_sale')),
    preorder_transports: upgradeTransports(row.preorder_transports),
    stock: num(row.stock),
    low_stock_threshold: num(row.low_stock_threshold),
    brand_id: typeof row.brand_id === 'string' && row.brand_id ? row.brand_id : null,
    category_id: typeof row.category_id === 'string' && row.category_id ? row.category_id : null,
    sub_category_id: typeof row.sub_category_id === 'string' && row.sub_category_id ? row.sub_category_id : null,
    template_family:
      row.template_family === 'devices' || row.template_family === 'materials' ? row.template_family : null,
    sku: typeof row.sku === 'string' && row.sku ? row.sku : null,
    spec_fields: safeParse<Record<string, string>>(String(row.spec_fields ?? '{}'), {}),
    media: upgradeMedia(row.images),
    options: upgradeOptions(row.options),
    colors: upgradeColors(row.colors),
    spec_groups: upgradeSpecGroups(row.specifications),
    labels: upgradeLabels(row.labels),
    warranty_plans: upgradeWarranty(row.warranty_plans),
    content_blocks: upgradeContentBlocks(row.content_blocks),
    translation_meta: safeParse<TranslationMeta>(row.translation_meta, {}),
    is_featured: !!row.is_featured,
    display_order: typeof row.display_order === 'number' ? row.display_order : 0,
    payment_options: safeParse<string[]>(row.payment_options, []),
    hashtags: safeParse<string[]>(row.hashtags, []),
    how_to_use: s(row.how_to_use, 20000),
    legacy: {
      brand_text: s(row.brand, 200),
      categories: s(row.categories, 500),
      subcategory_id: s(row.subcategory_id, 60),
      shipping_methods: safeParseArr(row.shipping_methods),
      features: safeParseArr(row.features),
      description_images: safeParseArr(row.description_images),
      description_videos: safeParseArr(row.description_videos),
      stores: safeParseArr(row.stores),
      algorithm_tags: safeParseArr(row.algorithm_tags),
      membership_prices: safeParse<Record<string, number>>(row.membership_prices, {}),
    },
    created_at: row.created_at ? String(row.created_at) : undefined,
    updated_at: row.updated_at ? String(row.updated_at) : undefined,
  };
}

// ---------------------------------------------------------------- validation (write)

/**
 * Validates an incoming admin/editor/template document body into a clean
 * ProductDoc. Throws HttpError(400) with a precise field path on violation.
 * The same function backs the editor API and the template import pipeline.
 */
export function validateProductDoc(body: Record<string, unknown>, opts: { requireName?: boolean } = {}): ProductDoc {
  const fail = (path: string, why: string): never => {
    throw badRequest(`${path}: ${why}`, 'VALIDATION');
  };

  const nameAr = s(body.name_ar, 300).trim();
  const nameEn = s(body.name_en, 300).trim();
  if (opts.requireName !== false && !nameAr && !nameEn) fail('name_ar', 'الاسم مطلوب (Arabic or English name required)');

  const price = body.price_iqd;
  if (!Number.isInteger(price) || (price as number) < 0) fail('price_iqd', 'regular base price must be a non-negative integer (IQD)');

  const optionalPrice = (v: unknown, path: string): number | null => {
    if (v === null || v === undefined || v === '') return null;
    if (!Number.isInteger(v) || (v as number) < 0) fail(path, 'must be a non-negative integer (IQD) or null');
    return v as number;
  };

  const sellingType = body.selling_type === 'pre_order' || body.selling_type === 'bundle' ? body.selling_type : 'direct_sale';

  // Repeatable groups run through the same upgraders (they accept v2 shapes),
  // then get structural checks.
  const options = upgradeOptions(body.options ?? []);
  const colors = upgradeColors(body.colors ?? []);
  const media = upgradeMedia(body.media ?? body.images ?? []);
  const specGroups = upgradeSpecGroups(body.spec_groups ?? body.specifications ?? []);
  const labels = upgradeLabels(body.labels ?? []);
  const warranty = upgradeWarranty(body.warranty_plans ?? []);
  const transports = upgradeTransports(body.preorder_transports ?? []);
  const blocks = upgradeContentBlocks(body.content_blocks ?? []);

  const dupCheck = (items: Array<{ id: string }>, path: string) => {
    const ids = new Set<string>();
    for (const it of items) {
      if (ids.has(it.id)) fail(path, `duplicate id "${it.id}"`);
      ids.add(it.id);
    }
  };
  dupCheck(options, 'options');
  dupCheck(colors, 'colors');
  dupCheck(media, 'media');
  dupCheck(warranty, 'warranty_plans');
  dupCheck(blocks, 'content_blocks');

  const optionIds = new Set(options.map((o) => o.id));
  for (const c of colors) {
    if (c.option_id && !optionIds.has(c.option_id)) {
      fail(`colors.${c.id}.option_id`, `references unknown option "${c.option_id}"`);
    }
    const rawColors = Array.isArray(body.colors) ? (body.colors as Array<Record<string, unknown>>) : [];
    const rawC = rawColors.find((x) => x && x.id === c.id);
    if (rawC && rawC.hex && !HEX_RE.test(String(rawC.hex))) {
      fail(`colors.${c.id}.hex`, 'must be a #RRGGBB hex code');
    }
  }

  const seenMethods = new Set<string>();
  for (const t of transports) {
    if (seenMethods.has(t.method)) fail('preorder_transports', `duplicate method "${t.method}"`);
    seenMethods.add(t.method);
  }
  if (sellingType !== 'pre_order' && transports.some((t) => t.active)) {
    // Transport offers are meaningless outside preorder — kept stored but inactive.
    transports.forEach((t) => (t.active = false));
  }

  for (const w of warranty) {
    if (w.duration_months <= 0 || w.duration_months > 240) fail(`warranty_plans.${w.id}.duration_months`, 'must be 1..240');
    if (w.fee_iqd < 0) fail(`warranty_plans.${w.id}.fee_iqd`, 'must be >= 0');
  }

  const stock = body.stock === null || body.stock === undefined || body.stock === '' ? null : body.stock;
  if (stock !== null && (!Number.isInteger(stock) || (stock as number) < 0)) fail('stock', 'must be a non-negative integer or null (untracked)');

  const status = body.status === 'draft' || body.status === 'hidden' ? body.status : 'active';

  return {
    id: typeof body.id === 'string' && body.id ? (body.id as string) : newId('prd'),
    slug: s(body.slug, 200), // final slug decided by the persistence layer (stability rules)
    status,
    doc_version: DOC_VERSION,
    content_rev: num(body.content_rev) ?? 1,
    name_ar: nameAr,
    name_en: nameEn,
    name_ckb: s(body.name_ckb, 300).trim(),
    description_ar: s(body.description_ar, 50000),
    description_en: s(body.description_en, 50000),
    description_ckb: s(body.description_ckb, 50000),
    price_iqd: price as number,
    pro_price_iqd: optionalPrice(body.pro_price_iqd, 'pro_price_iqd'),
    prime_price_iqd: optionalPrice(body.prime_price_iqd, 'prime_price_iqd'),
    product_cost_iqd: optionalPrice(body.product_cost_iqd, 'product_cost_iqd'),
    selling_type: sellingType as ProductDoc['selling_type'],
    sale_types: normalizeSaleTypes(body.sale_types, sellingType as string),
    preorder_transports: transports,
    stock: stock as number | null,
    low_stock_threshold: optionalPrice(body.low_stock_threshold, 'low_stock_threshold'),
    brand_id: typeof body.brand_id === 'string' && body.brand_id ? (body.brand_id as string) : null,
    category_id: typeof body.category_id === 'string' && body.category_id ? (body.category_id as string) : null,
    sub_category_id:
      typeof body.sub_category_id === 'string' && body.sub_category_id ? (body.sub_category_id as string) : null,
    template_family:
      body.template_family === 'devices' || body.template_family === 'materials' ? body.template_family : null,
    sku: s(body.sku, 60).trim() || null,
    spec_fields: readSpecFields(body.spec_fields),
    media,
    options,
    colors,
    spec_groups: specGroups,
    labels,
    warranty_plans: warranty,
    content_blocks: blocks,
    translation_meta: (typeof body.translation_meta === 'object' && body.translation_meta !== null
      ? body.translation_meta
      : {}) as TranslationMeta,
    is_featured: !!body.is_featured,
    display_order: Number.isInteger(body.display_order) ? (body.display_order as number) : 0,
    payment_options: Array.isArray(body.payment_options) ? (body.payment_options as string[]).slice(0, 20).map((x) => s(x, 60)) : [],
    hashtags: Array.isArray(body.hashtags) ? (body.hashtags as string[]).slice(0, 30).map((x) => s(x, 60)) : [],
    how_to_use: s(body.how_to_use, 20000),
    legacy: {
      brand_text: s((body.legacy as Record<string, unknown>)?.brand_text ?? body.brand, 200),
      categories: s((body.legacy as Record<string, unknown>)?.categories ?? body.categories, 500),
      subcategory_id: s((body.legacy as Record<string, unknown>)?.subcategory_id ?? body.subcategory_id, 60),
      shipping_methods: [], features: [], description_images: [], description_videos: [], stores: [], algorithm_tags: [],
      membership_prices: {},
    },
  };
}

// ---------------------------------------------------------------- doc → row

/** Column map for INSERT/UPDATE. Legacy passthrough columns are preserved by
 *  the persistence layer via COALESCE-style partial update, not overwritten. */
export function serializeDoc(doc: ProductDoc): Record<string, unknown> {
  return {
    id: doc.id,
    slug: doc.slug,
    status: doc.status,
    doc_version: DOC_VERSION,
    content_rev: doc.content_rev,
    name: doc.name_en,
    name_ar: doc.name_ar,
    name_ku: doc.name_ckb,
    description: doc.description_en,
    description_ar: doc.description_ar,
    description_ku: doc.description_ckb,
    price_iqd: doc.price_iqd,
    pro_price_iqd: doc.pro_price_iqd,
    prime_price_iqd: doc.prime_price_iqd,
    product_cost_iqd: doc.product_cost_iqd,
    // Kept in sync with sale_types[0] so every pre-0018 reader still sees a
    // valid scalar; sale_types is the authority.
    selling_type: doc.sale_types[0] ?? doc.selling_type,
    sale_types: JSON.stringify(doc.sale_types),
    preorder_transports: JSON.stringify(doc.preorder_transports),
    stock: doc.stock,
    low_stock_threshold: doc.low_stock_threshold,
    brand_id: doc.brand_id,
    category_id: doc.category_id,
    sub_category_id: doc.sub_category_id,
    template_family: doc.template_family,
    sku: doc.sku,
    spec_fields: JSON.stringify(doc.spec_fields),
    images: JSON.stringify(doc.media),
    options: JSON.stringify(doc.options),
    colors: JSON.stringify(doc.colors),
    specifications: JSON.stringify(doc.spec_groups),
    labels: JSON.stringify(doc.labels),
    warranty_plans: JSON.stringify(doc.warranty_plans),
    content_blocks: JSON.stringify(doc.content_blocks),
    translation_meta: JSON.stringify(doc.translation_meta),
    is_featured: doc.is_featured ? 1 : 0,
    display_order: doc.display_order,
    payment_options: JSON.stringify(doc.payment_options),
    hashtags: JSON.stringify(doc.hashtags),
    how_to_use: doc.how_to_use,
  };
}

// ---------------------------------------------------------------- projections

/** Admin projection: the full document (costs included). */
export function projectAdmin(doc: ProductDoc) {
  return doc;
}

const stripCostFields = <T extends PriceFields>(x: T) => {
  const { cost_iqd, ...rest } = x;
  return rest;
};

/**
 * Public storefront projection — NO cost fields anywhere (product, option,
 * color), no translation bookkeeping, hidden options/colors/labels removed.
 * Selling prices are computed by the caller through the resolver.
 */
export function projectPublic(doc: ProductDoc) {
  return {
    id: doc.id,
    slug: doc.slug,
    status: doc.status,
    name_ar: doc.name_ar,
    name_en: doc.name_en,
    name_ckb: doc.name_ckb,
    description_ar: doc.description_ar,
    description_en: doc.description_en,
    description_ckb: doc.description_ckb,
    price_iqd: doc.price_iqd,
    pro_price_iqd: doc.pro_price_iqd,
    prime_price_iqd: doc.prime_price_iqd,
    selling_type: doc.selling_type,
    sale_types: doc.sale_types,
    preorder_transports: doc.preorder_transports.filter((t) => t.active),
    stock: doc.stock,
    low_stock_threshold: doc.low_stock_threshold,
    brand_id: doc.brand_id,
    category_id: doc.category_id,
    sub_category_id: doc.sub_category_id,
    template_family: doc.template_family,
    sku: doc.sku,
    spec_fields: doc.spec_fields,
    media: doc.media,
    images: doc.media.map((m) => m.url), // legacy string[] compatibility
    options: doc.options.filter((o) => o.active).map(stripCostFields),
    colors: doc.colors.filter((c) => c.active).map(stripCostFields),
    spec_groups: doc.spec_groups,
    labels: doc.labels.filter((l) => l.visible),
    warranty_plans: doc.warranty_plans.filter((w) => w.active),
    content_blocks: doc.content_blocks,
    is_featured: doc.is_featured,
    display_order: doc.display_order,
    payment_options: doc.payment_options,
    hashtags: doc.hashtags,
    how_to_use: doc.how_to_use,
    created_at: doc.created_at,
  };
}

export const PRODUCT_COLUMNS = [
  'id','slug','status','doc_version','content_rev','name','name_ar','name_ku',
  'description','description_ar','description_ku','price_iqd','pro_price_iqd',
  'prime_price_iqd','product_cost_iqd','selling_type','sale_types','preorder_transports',
  'stock','low_stock_threshold','brand_id','category_id','sub_category_id',
  'template_family','sku','spec_fields','images','options','colors','specifications','labels',
  'warranty_plans','content_blocks','translation_meta','is_featured',
  'display_order','payment_options','hashtags','how_to_use',
] as const;
