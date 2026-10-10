/**
 * «ملف بيانات المنتج» — THE PRODUCT DATA FILE AND ITS ROUND TRIP
 * (owner brief 2026-10-10: «تضمين كل الحقول في ملف txt … عند تحديث البيانات
 * يتم تنزيل ملف معلومات بيانات المنتج وعند ارفاق الملف يقارن التغييرات فقط
 * ويطبقها اذا حقل تغير … ليس استيراد من جديد»).
 *
 * The file is the TXT template's own grammar and keys (worker/lib/template.ts
 * `docToEntries` — no new parser, no renamed key, no version bump), one block
 * per product between `=== product <id> ===` and `=== end <id> ===`, plus:
 *   - a header (`data_file`, `data_file_version`, `viewer`, `products`);
 *   - read-only lines: `pricing_mode`, the fingerprints `fp.<group>` and
 *     `<group>.N.fp` (16 hex: what the product was when the file was made);
 *   - `<group>.N.remove=true` — the ONLY way an item leaves (an omitted line
 *     or item is never a deletion);
 *   - for the verified owner only, the `pricing.*` block: the USD pricing
 *     inputs and the two owner rules per scope, one to one onto the product
 *     form's pricing door (worker/lib/pricingEngine/productInputs.ts).
 *
 * Coming back, the file is COMPARED, never imported: every key is matched to
 * the stored product by ITEM ID (not by its position in the file), and each
 * one lands in exactly one bucket — unchanged, a change, or a refusal with
 * its own reason (unknown, invalid, read-only, engine-managed, owner-only,
 * changed since the download, …). Only the changes are written, through a
 * minimal patch the server writes itself (`buildPatch`) and the same
 * persistence path the form uses.
 *
 * Everything here is pure: no database, no network.
 */
import {
  CLEAR_TOKEN,
  NULL_TOKEN,
  TEMPLATE_VERSION,
  checkFieldValue,
  fieldSpecAt,
  type FieldSpec,
} from './template';
import { scanTemplate } from './sectionUpdate';
import { splitUrlList } from './urlList';
import { sha256Hex } from './crypto';
import { FINANCIAL_FIELDS } from './adminScope';

export const DATA_FILE_ID = 'levonis-product-data';
export const DATA_FILE_VERSION = 1;
/** Products in one file (one export, one preview call). */
export const MAX_DATA_FILE_PRODUCTS = 25;

export type DataFileViewer = 'owner' | 'staff';

/** One `key=value` of a product as the file states it (`value` null = `__NULL__`). */
export interface FlatEntry {
  key: string;
  value: string | null;
  line?: number;
}

/**
 * A key, identified by WHAT it names rather than where it sits in the file:
 * `options.3.name_en` → `options[opt_x].name_en`,
 * `options.1.preorder.transports.2.surcharge_iqd` →
 * `options[opt_x].preorder.transports[air].surcharge_iqd`.
 */
export interface NEntry {
  key: string;
  nkey: string;
  value: string | null;
  line: number;
  /** The scalar key, `spec`, `membership`, `pricing`, `fp`, `header`, or the group name. */
  head: string;
  item?: { group: string; id: string; index: number; isNew: boolean };
  /** The path inside the item (or the pricing scope): `['direct', 'price_iqd']`. */
  path: string[];
  meta?: 'fp' | 'remove' | 'header' | 'id';
}

// ----------------------------------------------------------------- the key families

/** Top-level groups and the subfield that identifies one of their items. */
const MERGE_KEY: Record<string, string> = {
  transports: 'method',
  images: 'id',
  options: 'id',
  colors: 'id',
  variants: 'id',
  spec_groups: 'id',
  labels: 'id',
  warranty_plans: 'id',
  content_blocks: 'id',
  usage_steps: 'id',
};
/** Groups whose item may be removed with `.remove=true`. */
export const REMOVABLE_GROUPS = new Set(['options', 'colors', 'variants', 'images', 'spec_groups', 'labels', 'warranty_plans', 'content_blocks', 'usage_steps']);
/** The id prefix a NEW item of the group is given (deterministically, `newItemId`). */
const ID_PREFIX: Record<string, string> = {
  options: 'opt',
  colors: 'col',
  variants: 'pv',
  spec_groups: 'sg',
  labels: 'lbl',
  warranty_plans: 'wp',
  content_blocks: 'cb',
  usage_steps: 'ustep',
};
const PRICING_LEVELS: Record<string, { scope: 'option' | 'color' | 'sku'; merge: string }> = {
  options: { scope: 'option', merge: 'id' },
  colors: { scope: 'color', merge: 'id' },
  skus: { scope: 'sku', merge: 'combo_key' },
};

/** The template's header lines and the data file's own read-only lines. */
const HEADER_KEYS = new Set([
  'template_version',
  'product_id',
  'expected_updated_at',
  'allow_slug_change',
  'slug',
  'pricing_mode',
  'data_file',
  'data_file_version',
  'viewer',
  'products',
  'exported_at',
]);

/** The USD pricing fields of one scope (the form's fields, the IQD convenience input, the two rules). */
export const PRICING_INPUT_KEYS = [
  'supplier_cost_amount',
  'supplier_cost_currency',
  'supplier_cost_iqd',
  'shipping_profile',
  'shipping_weight_g',
  'shipping_length_mm',
  'shipping_width_mm',
  'shipping_height_mm',
  'manual_cbm',
  'additional_cost_iqd',
] as const;
export const PRICING_RULE_KEYS = ['minimum_target_profit_usd', 'direct_sale_extra_iqd'] as const;
export const PRICING_KEYS: readonly string[] = [...PRICING_INPUT_KEYS, ...PRICING_RULE_KEYS];

const MEMBERSHIP_RE = /^membership\.(pro|prime)\.([a-z_]+)$/;
export const MEMBERSHIP_FIELD_NAMES = ['discount_mode', 'percent', 'fixed_iqd', 'max_discount_iqd', 'cap_scope', 'max_quantity'];

const FINANCIAL = new Set<string>(FINANCIAL_FIELDS as readonly string[]);
const leafOf = (n: Pick<NEntry, 'head' | 'path'>) => (n.path.length ? n.path[n.path.length - 1] : n.head);

/** A cost or a private pricing value: the verified owner's alone (owner decision 2). */
export function isPrivateEntry(n: Pick<NEntry, 'head' | 'path'>): boolean {
  if (n.head === 'pricing') return true;
  if (n.head === 'membership') return false;
  return FINANCIAL.has(leafOf(n));
}

/** The same test on a raw key (`options.2.cost_iqd`, `pricing.base.…`). */
export function isPrivateKey(key: string): boolean {
  if (key === 'pricing' || key.startsWith('pricing.')) return true;
  if (key.startsWith('membership.')) return false;
  const leaf = key.slice(key.lastIndexOf('.') + 1);
  return FINANCIAL.has(leaf);
}

const PRICE_LEAVES = new Set([
  'price_iqd',
  'pro_price_iqd',
  'prime_price_iqd',
  'original_price_iqd',
  'regular_price_iqd',
  'regular_adjust_iqd',
  'prime_adjust_iqd',
  'pro_adjust_iqd',
  'surcharge_iqd',
]);
/** A selling-price key (any level). The top-level transports' commission is a route setting, not a price. */
export function isPriceEntry(n: Pick<NEntry, 'head' | 'path' | 'item'>): boolean {
  if (n.head === 'pricing' || n.head === 'membership' || n.head === 'spec') return false;
  if (n.item?.group === 'transports') return false;
  return PRICE_LEAVES.has(leafOf(n));
}

/** Image keys the store owns (the bytes, where they live): never edited from a file. */
const IMAGE_READ_ONLY = new Set(['url', 'key', 'width', 'height', 'content_type', 'bytes', 'source_url']);

// ----------------------------------------------------------------- normalization

const ITEM_ID_RE = /^([a-z_]+)\.(\d+)\.(id|method)$/;
const ROW_ID_RE = /^spec_groups\.(\d+)\.rows\.(\d+)\.id$/;
const ROUTE_ID_RE = /^options\.(\d+)\.(direct|preorder)\.transports\.(\d+)\.method$/;
const PRICING_ID_RE = /^pricing\.(options|colors|skus)\.(\d+)\.(id|combo_key)$/;
const ITEM_KEY_RE = /^([a-z_]+)\.(\d+)\.(.+)$/;

/**
 * Every entry of one product, named by identity. Ids are read first, so an
 * item's lines may sit in any order; an item with no id line is NEW
 * (`#new<index>`), and two items naming one id are reported in `duplicates`.
 */
export function normalizeEntries(entries: readonly FlatEntry[]): { list: NEntry[]; duplicates: string[] } {
  const itemId = new Map<string, string>();
  const rowId = new Map<string, string>();
  const routeId = new Map<string, string>();
  const pricingId = new Map<string, string>();
  const duplicates: string[] = [];
  const seenIds = new Map<string, string>();
  for (const e of entries) {
    const v = (e.value ?? '').trim();
    let m = PRICING_ID_RE.exec(e.key);
    if (m) {
      if (PRICING_LEVELS[m[1]].merge === m[3] && v) pricingId.set(`${m[1]}.${m[2]}`, v);
      continue;
    }
    m = ROW_ID_RE.exec(e.key);
    if (m) {
      if (v) rowId.set(`${m[1]}.${m[2]}`, v);
      continue;
    }
    m = ROUTE_ID_RE.exec(e.key);
    if (m) {
      if (v) routeId.set(`${m[1]}.${m[2]}.${m[3]}`, v);
      continue;
    }
    m = ITEM_ID_RE.exec(e.key);
    if (m && MERGE_KEY[m[1]] === m[3] && v) {
      const at = `${m[1]}.${m[2]}`;
      const prior = seenIds.get(`${m[1]}:${v}`);
      if (prior && prior !== at) duplicates.push(e.key);
      else seenIds.set(`${m[1]}:${v}`, at);
      itemId.set(at, v);
    }
  }

  const list: NEntry[] = [];
  for (const e of entries) {
    const line = e.line ?? 0;
    const base = { key: e.key, value: e.value, line };
    if (HEADER_KEYS.has(e.key)) {
      list.push({ ...base, nkey: e.key, head: 'header', path: [], meta: 'header' });
      continue;
    }
    if (e.key.startsWith('fp.')) {
      list.push({ ...base, nkey: e.key, head: 'fp', path: [e.key.slice(3)], meta: 'fp' });
      continue;
    }
    if (e.key.startsWith('spec.')) {
      list.push({ ...base, nkey: e.key, head: 'spec', path: [e.key.slice(5)] });
      continue;
    }
    if (MEMBERSHIP_RE.test(e.key)) {
      list.push({ ...base, nkey: e.key, head: 'membership', path: e.key.split('.').slice(1) });
      continue;
    }
    if (e.key === 'pricing' || e.key.startsWith('pricing.')) {
      const parts = e.key.split('.');
      if (parts[1] === 'base' && parts.length === 3) {
        list.push({ ...base, nkey: e.key, head: 'pricing', path: ['base', parts[2]] });
        continue;
      }
      const lvl = PRICING_LEVELS[parts[1] ?? ''];
      if (lvl && parts.length === 4 && /^\d+$/.test(parts[2])) {
        const index = Number(parts[2]);
        const id = pricingId.get(`${parts[1]}.${parts[2]}`) ?? `#new${index}`;
        const field = parts[3];
        const meta = field === lvl.merge ? 'id' : field === 'fp' ? 'fp' : undefined;
        list.push({
          ...base,
          nkey: `pricing.${parts[1]}[${id}].${field}`,
          head: 'pricing',
          item: { group: `pricing.${parts[1]}`, id, index, isNew: id.startsWith('#new') },
          path: [parts[1], field],
          ...(meta ? { meta } : {}),
        });
        continue;
      }
      list.push({ ...base, nkey: e.key, head: 'pricing', path: parts.slice(1) });
      continue;
    }
    const m = ITEM_KEY_RE.exec(e.key);
    if (m && MERGE_KEY[m[1]]) {
      const group = m[1];
      const index = Number(m[2]);
      const id = itemId.get(`${group}.${m[2]}`) ?? `#new${index}`;
      const item = { group, id, index, isNew: id.startsWith('#new') };
      const rest = m[3].split('.');
      let path = rest;
      let meta: NEntry['meta'];
      if (rest.length === 1 && rest[0] === MERGE_KEY[group]) meta = 'id';
      else if (rest.length === 1 && rest[0] === 'fp') meta = 'fp';
      else if (rest.length === 1 && rest[0] === 'remove') meta = 'remove';
      else if (group === 'spec_groups' && rest[0] === 'rows' && rest.length === 3) {
        const rid = rowId.get(`${m[2]}.${rest[1]}`) ?? `#new${rest[1]}`;
        path = ['rows', rid, rest[2]];
      } else if (group === 'options' && rest.length === 4 && rest[1] === 'transports' && /^\d+$/.test(rest[2])) {
        const method = routeId.get(`${m[2]}.${rest[0]}.${rest[2]}`) ?? `#new${rest[2]}`;
        path = [rest[0], 'transports', method, rest[3]];
        if (rest[3] === 'method') meta = 'id';
      }
      const nkey = `${group}[${id}]${path.map((p, i) => (path[i - 1] === 'rows' || path[i - 1] === 'transports' ? `[${p}]` : `.${p}`)).join('')}`;
      list.push({ ...base, nkey, head: group, item, path, ...(meta ? { meta } : {}) });
      continue;
    }
    list.push({ ...base, nkey: e.key, head: e.key.includes('.') ? e.key.split('.')[0] : e.key, path: [] });
  }
  return { list, duplicates };
}

// ----------------------------------------------------------------- values

/**
 * A value as it compares: the registry's own reading of it, so `TRUE` equals
 * `true`, `025000` equals `25000`, a CSV's spaces do not count, and
 * `__CLEAR__` equals the empty value it writes. A value the type refuses is
 * returned as written (it is judged invalid elsewhere, never equal).
 */
export function canonicalValue(n: Pick<NEntry, 'head' | 'path' | 'key'>, value: string | null): string | null {
  if (n.head === 'pricing') {
    if (value === null || value === '' || value === NULL_TOKEN || value === CLEAR_TOKEN) return null;
    const v = value.trim();
    if (/^\d+$/.test(v)) return String(Number(v));
    if (/^\d+\.\d+$/.test(v)) return v.replace(/0+$/, '').replace(/\.$/, '');
    return v;
  }
  if (n.head === 'membership') return value === null ? NULL_TOKEN : value.trim();
  if (value === null) return null;
  if (n.head === 'spec') return value === CLEAR_TOKEN ? '' : value;
  const spec = fieldSpecAt(n.key);
  if (!spec) return value;
  if (value === CLEAR_TOKEN) {
    if (spec.type === 'iqd' || spec.type === 'int' || spec.type === 'percent') return spec.nullable ? null : value;
    return spec.type === 'bool' || spec.type === 'enum' ? value : '';
  }
  switch (spec.type) {
    case 'bool': {
      const t = value.toLowerCase();
      if (t === 'true' || t === '1' || t === 'yes') return 'true';
      if (t === 'false' || t === '0' || t === 'no') return 'false';
      return value;
    }
    case 'iqd':
    case 'int': {
      const plain = spec.plusIsPlain && /^\+\d+$/.test(value) ? value.slice(1) : value;
      if (/^-?\d+$/.test(plain)) return String(parseInt(plain, 10));
      return value;
    }
    case 'percent':
      return /^\+?\d+(\.\d{1,2})?$/.test(value) ? String(Number(value.replace(/^\+/, ''))) : value;
    case 'csv':
      return value
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
        .join(',');
    case 'urls':
      return splitUrlList(value).join(' ');
    default:
      return value;
  }
}

/** The registry entry of a key, or null (unknown, or a spelling the data file does not use). */
export function specOf(n: Pick<NEntry, 'key' | 'head'>): FieldSpec | null {
  if (n.head === 'pricing' || n.head === 'membership') return null;
  const spec = fieldSpecAt(n.key);
  if (!spec || spec.exported === false) return null;
  return spec;
}

// ----------------------------------------------------------------- fingerprints

/**
 * The fingerprint group of a key. Prices of every level are ONE group and
 * costs another, so the engine repricing a product, or the owner editing a
 * cost, never moves the fingerprint of an item's name or stock; every other
 * key belongs to its scalar section or to its own item.
 */
export function fpGroupOf(n: NEntry): string | null {
  if (n.meta) return null;
  if (n.head === 'pricing') return n.item ? `pricing:${n.item.group.slice(8)}:${n.item.id}` : 'pricing_base';
  if (n.head === 'membership') return 'membership';
  if (n.head === 'spec') return 'specs';
  if (isPrivateEntry(n)) return 'cost';
  if (isPriceEntry(n)) return 'prices';
  if (n.item) return `item:${n.item.group}:${n.item.id}`;
  const spec = fieldSpecAt(n.key);
  return spec ? spec.group : 'identity';
}

/** The fingerprint line of a group: `fp.<group>` for a section, `<group>.N.fp` for an item. */
export async function fingerprints(productId: string, list: readonly NEntry[]): Promise<Map<string, string>> {
  const groups = new Map<string, Array<[string, string]>>();
  for (const n of list) {
    if (n.item?.isNew) continue;
    if (n.head !== 'pricing' && n.head !== 'membership' && n.head !== 'spec' && !specOf(n)) continue;
    const g = fpGroupOf(n);
    if (!g) continue;
    const v = canonicalValue(n, n.value);
    (groups.get(g) ?? groups.set(g, []).get(g)!).push([n.nkey, v === null ? NULL_TOKEN : v]);
  }
  const out = new Map<string, string>();
  for (const [g, pairs] of groups) {
    pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    out.set(g, (await sha256Hex(JSON.stringify([productId, g, pairs]))).slice(0, 16));
  }
  return out;
}

/** The fingerprints a file carries, by group name (the same names `fpGroupOf` gives). */
export function fileFingerprints(list: readonly NEntry[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of list) {
    if (n.meta !== 'fp' || typeof n.value !== 'string') continue;
    const v = n.value.trim().toLowerCase();
    if (!/^[0-9a-f]{16}$/.test(v)) continue;
    if (n.head === 'fp') out.set(n.path[0], v);
    else if (n.item && n.head === 'pricing') out.set(`pricing:${n.item.group.slice(8)}:${n.item.id}`, v);
    else if (n.item) out.set(`item:${n.item.group}:${n.item.id}`, v);
  }
  return out;
}

/** A new item's id: the same file gives the same id at preview and at apply (the token covers it). */
export async function newItemId(productId: string, group: string, index: number, content: string): Promise<string> {
  const prefix = ID_PREFIX[group] ?? 'itm';
  return `${prefix}_${(await sha256Hex(`${productId}|${group}|${index}|${content}`)).slice(0, 20)}`;
}

// ----------------------------------------------------------------- the file

export const SECTION_TITLES: Record<string, { ar: string; en: string; ckb: string }> = {
  identity: { ar: 'الهوية', en: 'Identity', ckb: 'ناسنامە' },
  description: { ar: 'الوصف', en: 'Description', ckb: 'وەسف' },
  pricing: { ar: 'الأسعار', en: 'Prices', ckb: 'نرخەکان' },
  classification: { ar: 'التصنيف', en: 'Classification', ckb: 'پۆلێنکردن' },
  selling: { ar: 'البيع والمخزون', en: 'Selling & stock', ckb: 'فرۆشتن و کۆگا' },
  delivery: { ar: 'خيارات التوصيل', en: 'Delivery options', ckb: 'بژاردەکانی گەیاندن' },
  transports: { ar: 'شحن الطلب المسبق', en: 'Pre-order transports', ckb: 'ناردنی داواکاریی پێشوەخت' },
  media: { ar: 'الصور', en: 'Pictures', ckb: 'وێنەکان' },
  options: { ar: 'الخيارات والتركيبات', en: 'Options & combinations', ckb: 'هەڵبژاردەکان و تێکەڵەکان' },
  colors: { ar: 'الألوان', en: 'Colours', ckb: 'ڕەنگەکان' },
  specs: { ar: 'المواصفات', en: 'Specifications', ckb: 'تایبەتمەندییەکان' },
  labels: { ar: 'الشارات', en: 'Labels', ckb: 'نیشانەکان' },
  warranty: { ar: 'الضمان', en: 'Warranty', ckb: 'گەرەنتی' },
  condition: { ar: 'الحالة', en: 'Condition', ckb: 'دۆخ' },
  dimensions: { ar: 'الأبعاد والوزن', en: 'Dimensions & weight', ckb: 'قەبارە و کێش' },
  content: { ar: 'كتل المحتوى', en: 'Content blocks', ckb: 'بلۆکەکانی ناوەڕۆک' },
  usage: { ar: 'دليل التركيب والاستخدام', en: 'Setup & usage guide', ckb: 'ڕێبەری دامەزراندن و بەکارهێنان' },
  membership: { ar: 'خصم العضوية', en: 'Membership discount', ckb: 'داشکاندنی ئەندامێتی' },
  pricing_usd: { ar: 'التسعير بالدولار (للمالك فقط)', en: 'USD pricing (owner only)', ckb: 'نرخدانان بە دۆلار (تەنها بۆ خاوەن)' },
};

/** The form section a key belongs to (the sheet groups its changes by it). */
export function sectionOf(n: Pick<NEntry, 'head' | 'item' | 'key'>): string {
  if (n.head === 'pricing') return 'pricing_usd';
  if (n.head === 'membership') return 'membership';
  if (n.head === 'spec') return 'specs';
  if (n.item) {
    if (n.item.group === 'variants') return 'options';
    if (n.item.group === 'images') return 'media';
    if (n.item.group === 'spec_groups') return 'specs';
    if (n.item.group === 'warranty_plans') return 'warranty';
    if (n.item.group === 'content_blocks') return 'content';
    if (n.item.group === 'usage_steps') return 'usage';
    return n.item.group;
  }
  const spec = fieldSpecAt(n.key);
  return spec ? spec.group : 'identity';
}

/** `key=value`, or a heredoc when the value needs one (the template's own rule). */
export function writeLine(key: string, value: string | null): string[] {
  if (value === null) return [`${key}=${NULL_TOKEN}`];
  const needs = value.includes('\n') || value !== value.trim() || value.startsWith('<<<');
  if (!needs) return [`${key}=${value}`];
  const lines = new Set(value.split('\n').map((l) => l.trim()));
  let token = 'END';
  for (let n = 1; lines.has(token); n++) token = `END_${n}`;
  return [`${key}=<<<${token}`, ...value.split('\n'), token];
}

export interface BlockRender {
  productId: string;
  slug: string;
  updatedAt: string | null;
  engine: boolean;
  viewer: DataFileViewer;
  /** The product's entries in file order (doc keys, membership, pricing block). */
  entries: FlatEntry[];
  /** Comment lines written beside a key (`#   ↳ …`). */
  notes?: ReadonlyMap<string, readonly string[]>;
  /** Comment lines written above a key (a spec field's own name). */
  above?: ReadonlyMap<string, string>;
}

const ENGINE_NOTE = '[محرك] يحسبه محرك التسعير — غيّر بيانات التسعير بدلاً منه · engine-priced: change the pricing inputs instead · بزوێنەری نرخدانان دایدەنێت';

/** One product's block, its fingerprints written beside what they cover. */
export async function renderBlock(r: BlockRender): Promise<string> {
  const { list } = normalizeEntries(r.entries);
  const fps = await fingerprints(r.productId, list);
  const lines: string[] = [
    `=== product ${r.productId} ===`,
    `template_version=${TEMPLATE_VERSION}`,
    `product_id=${r.productId}`,
    `slug=${r.slug}`,
    ...(r.updatedAt ? [`expected_updated_at=${r.updatedAt}`] : []),
    `pricing_mode=${r.engine ? 'engine' : 'manual'}`,
  ];
  const sectionFps = [...fps.entries()].filter(([g]) => !g.startsWith('item:') && !g.startsWith('pricing:')).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [g, v] of sectionFps) lines.push(`fp.${g}=${v}`);
  let section = '';
  for (const n of list) {
    const s = sectionOf(n);
    if (s !== section) {
      section = s;
      const t = SECTION_TITLES[s] ?? SECTION_TITLES.identity;
      lines.push('', `# ── ${t.ar} · ${t.en} · ${t.ckb}`);
    }
    const above = r.above?.get(n.key);
    if (above) lines.push(`# ${above}`);
    lines.push(...writeLine(n.key, n.head === 'pricing' && n.value === null ? '' : n.value));
    if (n.meta === 'id' && n.item && !n.path.includes('transports')) {
      const fp = n.head === 'pricing' ? fps.get(`pricing:${n.item.group.slice(8)}:${n.item.id}`) : fps.get(`item:${n.item.group}:${n.item.id}`);
      const prefix = n.key.slice(0, n.key.lastIndexOf('.'));
      if (fp) lines.push(`${prefix}.fp=${fp}`);
      if (REMOVABLE_GROUPS.has(n.item.group)) lines.push(`${prefix}.remove=false`);
    }
    if (r.engine && isPriceEntry(n) && n.head !== 'header' && n.key !== 'original_price_iqd') lines.push(`#   ↳ ${ENGINE_NOTE}`);
    for (const note of r.notes?.get(n.key) ?? []) lines.push(`#   ↳ ${note}`);
  }
  lines.push(`=== end ${r.productId} ===`);
  return lines.join('\n');
}

/** The whole file: header, usage note in three languages, then one block per product. */
export function renderDataFile(blocks: readonly string[], viewer: DataFileViewer, exportedAt: string): string {
  return [
    '# ملف بيانات المنتج — LEVONIS · Product data file · فایلی زانیاریی بەرهەم',
    '# عدّل القيم ثم أرفق الملف في «تحديث البيانات»: يُطبَّق ما تغيّر فقط. لا تغيّر id ولا أسطر fp. السطر الذي تحذفه = لا تغيير؛ __CLEAR__ يمسح القيمة؛ العنصر يُحذف فقط بـ remove=true.',
    '# Edit values, then attach the file in «تحديث البيانات»: only what changed is applied. Keep the id and fp lines. A line you delete = no change; __CLEAR__ clears; an item is removed only with remove=true.',
    '# نرخەکان بگۆڕە و پاشان فایلەکە لە «نوێکردنەوەی زانیاری» هاوپێچ بکە: تەنها ئەوەی گۆڕاوە جێبەجێ دەکرێت. هێڵەکانی id و fp مەگۆڕە؛ هێڵێک بسڕیتەوە = هیچ ناگۆڕێت؛ __CLEAR__ بەها پاک دەکاتەوە؛ بڕگە تەنها بە remove=true لادەبرێت.',
    viewer === 'owner'
      ? '# [مالك] أسطر التكلفة والتسعير بالدولار تظهر للمالك وحده · cost and USD pricing lines are the owner\'s alone · هێڵەکانی تێچوو و نرخدانان بە دۆلار تەنها بۆ خاوەنن'
      : '# هذا الملف بلا تكلفة ولا تسعير خاص · this file carries no cost or private pricing · ئەم فایلە تێچوو و نرخدانانی تایبەتی تێدا نییە',
    `data_file=${DATA_FILE_ID}`,
    `data_file_version=${DATA_FILE_VERSION}`,
    `exported_at=${exportedAt}`,
    `viewer=${viewer}`,
    `products=${blocks.length}`,
    '',
    blocks.join('\n\n'),
    '',
  ].join('\n');
}

export interface FileError {
  line: number;
  message: string;
  code: string;
}

export interface ParsedBlock {
  productId: string;
  /** No fingerprints (an export of the old door, or a file without blocks). */
  legacy: boolean;
  entries: FlatEntry[];
  malformed: Array<{ line: number; text: string }>;
}

export interface ParsedDataFile {
  version: number | null;
  viewer: string | null;
  blocks: ParsedBlock[];
  errors: FileError[];
}

const BLOCK_START = /^===\s*product\s+([A-Za-z0-9_-]{1,80})\s*===$/;
const BLOCK_END = /^===\s*end\s+([A-Za-z0-9_-]{1,80})\s*===$/;

/**
 * The file, cut into product blocks. A file with no block markers is one
 * product (the old export `levonis-product-<id>.txt`, or a spreadsheet's
 * rows) and must name it with `product_id`.
 */
export function splitDataFile(text: string): ParsedDataFile {
  const lines = String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n');
  const out: ParsedDataFile = { version: null, viewer: null, blocks: [], errors: [] };
  const headerText: string[] = [];
  const blocks: Array<{ id: string; start: number; body: string[]; ended: boolean }> = [];
  let open: (typeof blocks)[number] | null = null;
  let inHeredoc: string | null = null;
  lines.forEach((raw, i) => {
    const t = raw.trim();
    if (inHeredoc) {
      if (t === inHeredoc) inHeredoc = null;
      if (open) open.body.push(raw);
      else headerText.push(raw);
      return;
    }
    const start = BLOCK_START.exec(t);
    if (start) {
      if (open) out.errors.push({ line: open.start, message: `block ${open.id} has no end line`, code: 'DATA_FILE_MALFORMED' });
      open = { id: start[1], start: i + 1, body: [], ended: false };
      blocks.push(open);
      return;
    }
    const end = BLOCK_END.exec(t);
    if (end) {
      if (!open || open.id !== end[1]) out.errors.push({ line: i + 1, message: `end line for ${end[1]} without its block`, code: 'DATA_FILE_MALFORMED' });
      else open.ended = true;
      open = null;
      return;
    }
    const hd = /^[A-Za-z0-9_.]+\s*=\s*<<<\s*([A-Za-z0-9_]{0,40})\s*$/.exec(t);
    if (hd) inHeredoc = hd[1] || 'END';
    if (open) open.body.push(raw);
    else headerText.push(raw);
  });
  if (open) out.errors.push({ line: (open as { start: number }).start, message: `block ${(open as { id: string }).id} has no end line`, code: 'DATA_FILE_MALFORMED' });

  const head = scanTemplate(headerText.join('\n')).entries;
  const get = (k: string) => head.find((e) => e.key === k)?.value ?? null;
  const v = get('data_file_version');
  if (v !== null) {
    out.version = /^\d+$/.test(v) ? Number(v) : NaN;
    if (!(out.version! >= 1 && out.version! <= DATA_FILE_VERSION)) {
      out.errors.push({ line: 0, message: `data_file_version ${v} is newer than this server understands`, code: 'DATA_FILE_VERSION' });
    }
  }
  out.viewer = get('viewer');

  if (blocks.length === 0) {
    const scan = scanTemplate(headerText.join('\n'));
    const pid = scan.entries.find((e) => e.key === 'product_id')?.value?.trim() ?? '';
    if (!pid) {
      out.errors.push({ line: 0, message: 'the file names no product (no product block and no product_id line)', code: 'DATA_FILE_NO_PRODUCT' });
      return out;
    }
    const entries = scan.entries.filter((e) => !['data_file', 'data_file_version', 'viewer', 'products', 'exported_at'].includes(e.key));
    out.blocks.push({
      productId: pid,
      legacy: !entries.some((e) => e.key.startsWith('fp.') || /\.fp$/.test(e.key)),
      entries: entries.map((e) => ({ key: e.key, value: e.value === NULL_TOKEN ? null : e.value, line: e.line })),
      malformed: scan.malformed,
    });
    return out;
  }
  for (const b of blocks) {
    const scan = scanTemplate(b.body.join('\n'));
    const entries = scan.entries.map((e) => ({ key: e.key, value: e.value === NULL_TOKEN ? null : e.value, line: e.line + b.start }));
    const named = entries.find((e) => e.key === 'product_id')?.value?.trim();
    if (named && named !== b.id) {
      out.errors.push({ line: b.start, message: `block ${b.id} names product_id ${named}`, code: 'DATA_FILE_MALFORMED' });
      continue;
    }
    out.blocks.push({
      productId: b.id,
      legacy: !entries.some((e) => e.key.startsWith('fp.') || /\.fp$/.test(e.key)),
      entries,
      malformed: scan.malformed.map((m) => ({ line: m.line + b.start, text: m.text })),
    });
  }
  const ids = out.blocks.map((b) => b.productId);
  if (new Set(ids).size !== ids.length) out.errors.push({ line: 0, message: 'a product appears twice in the file', code: 'DATA_FILE_MALFORMED' });
  return out;
}

// ----------------------------------------------------------------- the comparison

export type FieldStatus =
  | 'change'
  | 'STALE_IN_FILE'
  | 'UNKNOWN_FIELD'
  | 'INVALID_VALUE'
  | 'READ_ONLY'
  | 'ENGINE_MANAGED'
  | 'CONFLICT_SINCE_DOWNLOAD'
  | 'COST_OWNER_ONLY'
  | 'PRICING_SCOPE_UNKNOWN'
  | 'STRUCTURE_WITH_ADOPTION';

export interface FieldResult {
  key: string;
  nkey: string;
  line: number;
  status: FieldStatus;
  section: string;
  item: { group: string; id: string; isNew: boolean } | null;
  /** The field inside the item (or the key itself). */
  field: string;
  before: string | null;
  after: string | null;
  /** The validator's or planner's own sentence, for INVALID_VALUE. */
  message?: string;
  private: boolean;
}

export interface CompareInput {
  productId: string;
  file: readonly NEntry[];
  live: readonly NEntry[];
  liveFps: ReadonlyMap<string, string>;
  /** The caller may write cost (the verified owner). */
  owner: boolean;
  /** The product's prices are the engine's. */
  engine: boolean;
  /** A file without fingerprints: its `expected_updated_at` against the product's. */
  legacy: boolean;
  liveUpdatedAt: string | null;
  /** The images the product really has (a picture a legacy column implies is not one). */
  liveImageIds: ReadonlySet<string>;
  /** The pricing scopes the product has (null = the pricing engine is not installed). */
  pricingScopes: { option: ReadonlySet<string>; color: ReadonlySet<string>; sku: ReadonlySet<string> } | null;
}

export interface CompareResult {
  fields: FieldResult[];
  /** Items the file still names that the product no longer has, unedited in the file (said once, not refused). */
  goneItems: string[];
  /** Block-level problems (duplicate ids). */
  errors: FileError[];
}

const ENGINE_ITEM_PRICE = new Set(['regular_price_iqd', 'pro_price_iqd', 'prime_price_iqd', 'regular_adjust_iqd', 'prime_adjust_iqd', 'pro_adjust_iqd']);
const ENGINE_CELL_PRICE = new Set(['price_iqd', 'prime_price_iqd', 'pro_price_iqd']);
const ENGINE_ROUTE_PRICE = new Set(['price_iqd', 'prime_price_iqd', 'pro_price_iqd', 'surcharge_iqd']);

/** Would writing this change touch a price the engine owns (migration 0181 §10, the locks)? */
function engineManaged(n: NEntry, before: string | null, after: string | null, liveHas: (nkey: string) => boolean, itemIsNew: boolean): boolean {
  if (!n.item) return n.head === 'price_iqd' || n.head === 'pro_price_iqd' || n.head === 'prime_price_iqd';
  const g = n.item.group;
  const p = n.path;
  if (g === 'options') {
    if (itemIsNew) return true; // a model added
    if (n.meta === 'remove') return after === 'true'; // a model removed
    if (p.length === 1) {
      if (p[0] === 'direct' || p[0] === 'preorder') return true; // an order type cleared
      if (ENGINE_ITEM_PRICE.has(p[0])) return true;
      if (p[0] === 'active') return before === 'false' && after === 'true';
      return false;
    }
    const cell = p[0];
    if (!liveHas(`options[${n.item.id}].${cell}.enabled`)) return true; // an order type added
    if (p.length === 2) {
      if (ENGINE_CELL_PRICE.has(p[1])) return true;
      if (p[1] === 'enabled') return before === 'false' && after === 'true';
      return false;
    }
    if (p[1] === 'transports') {
      if (p.length === 2) return true;
      const route = p[2];
      if (!liveHas(`options[${n.item.id}].${cell}.transports[${route}].enabled`)) return true; // a new route
      if (ENGINE_ROUTE_PRICE.has(p[3])) return true;
      if (p[3] === 'enabled') return before === 'false' && after === 'true';
    }
    return false;
  }
  if (g === 'colors') {
    if (!ENGINE_ITEM_PRICE.has(p[0] ?? '')) return false;
    // A new colour may be added with no price of its own; one that carries a price is a price.
    return itemIsNew ? after !== null && after !== '' : true;
  }
  return false;
}

/** The reason a picture line from a file is read-only: pictures are added in the form. */
export const NEW_IMAGE = 'NEW_IMAGE';

/**
 * Every key of the file, judged against the product as it is now. Pure:
 * the caller supplies the product's entries and fingerprints as its own
 * viewer sees them, and judges the planned save afterwards.
 */
export async function compareBlock(input: CompareInput): Promise<CompareResult> {
  const live = new Map(input.live.map((n) => [n.nkey, n]));
  const liveHas = (nkey: string) => live.has(nkey);
  const liveItems = new Set(input.live.filter((n) => n.item).map((n) => `${n.item!.group}:${n.item!.id}`));
  const fileFps = fileFingerprints(input.file);
  const selfFps = await fingerprints(input.productId, input.file.filter((n) => !(n.item && !liveItems.has(`${n.item.group}:${n.item.id}`) && n.item.isNew)));
  const fields: FieldResult[] = [];
  const errors: FileError[] = [];
  const goneItems = new Set<string>();
  const seen = new Set<string>();

  const result = (n: NEntry, status: FieldStatus, before: string | null, after: string | null, message?: string): FieldResult => ({
    key: n.key,
    nkey: n.nkey,
    line: n.line,
    status,
    section: sectionOf(n),
    item: n.item ? { group: n.item.group, id: n.item.id, isNew: n.item.isNew || !liveItems.has(`${n.item.group}:${n.item.id}`) } : null,
    field: n.item ? n.path.join('.') : n.key,
    before,
    after,
    ...(message ? { message } : {}),
    private: isPrivateEntry(n),
  });

  for (const n of input.file) {
    // ---- the owner's alone: refused from the file itself, never compared (no oracle)
    if (!n.meta && isPrivateEntry(n) && !input.owner) {
      fields.push(result(n, 'COST_OWNER_ONLY', null, null));
      continue;
    }
    if (n.meta === 'fp' || n.meta === 'id') continue;
    if (n.meta === 'header') {
      if (n.key === 'slug' || n.key === 'pricing_mode') {
        const lv = live.get(n.key)?.value ?? null;
        if (lv !== null && (n.value ?? '').trim() !== lv) fields.push(result(n, 'READ_ONLY', lv, n.value));
      }
      continue;
    }
    if (seen.has(n.nkey)) {
      fields.push(result(n, 'INVALID_VALUE', null, n.value, 'duplicate key'));
      continue;
    }
    seen.add(n.nkey);

    const itemKey = n.item ? `${n.item.group}:${n.item.id}` : null;
    const itemLive = itemKey ? liveItems.has(itemKey) : true;
    // An item the file names by an id the product no longer has: removed (or re-keyed) since the download.
    if (n.item && !itemLive && !n.item.isNew && n.head !== 'pricing') {
      const group = `item:${n.item.group}:${n.item.id}`;
      const fileFp = fileFps.get(group);
      if (fileFp || input.legacy) {
        const untouched =
          !!fileFp &&
          selfFps.get(group) === fileFp &&
          (!isPriceEntry(n) || selfFps.get('prices') === fileFps.get('prices')) &&
          (!isPrivateEntry(n) || selfFps.get('cost') === fileFps.get('cost'));
        if (untouched) goneItems.add(itemKey!);
        else if (n.meta !== 'remove') fields.push(result(n, 'CONFLICT_SINCE_DOWNLOAD', null, n.value));
        continue;
      }
      // No fingerprint for it in a file that has them: an item the admin added, with an id of their own.
    }

    // ---- what the key is
    if (n.meta === 'remove') {
      const t = (n.value ?? '').trim().toLowerCase();
      if (t !== 'true' && t !== 'false') {
        fields.push(result(n, 'INVALID_VALUE', null, n.value, 'must be true or false'));
        continue;
      }
      if (t === 'false') continue;
      if (!REMOVABLE_GROUPS.has(n.item!.group)) {
        fields.push(result(n, 'UNKNOWN_FIELD', null, n.value));
        continue;
      }
      if (!itemLive) continue; // nothing to remove
      if (input.engine && engineManaged(n, 'false', 'true', liveHas, false)) {
        fields.push(result(n, 'ENGINE_MANAGED', 'false', 'true'));
        continue;
      }
      fields.push(result(n, 'change', 'false', 'true'));
      continue;
    }

    if (n.head === 'pricing') {
      // Judged in full by the caller (it needs the pricing door); here: the scope exists, and the key is one of the block's.
      const field = n.item ? n.path[1] : n.path[1];
      if (!PRICING_KEYS.includes(field) || (n.path[0] !== 'base' && !n.item)) {
        fields.push(result(n, 'UNKNOWN_FIELD', null, n.value));
        continue;
      }
      if (!input.pricingScopes) {
        fields.push(result(n, 'PRICING_SCOPE_UNKNOWN', null, n.value));
        continue;
      }
      if (n.item) {
        const lvl = PRICING_LEVELS[n.item.group.slice(8)];
        const set = input.pricingScopes[lvl.scope];
        if (n.item.isNew || !set.has(n.item.id)) {
          fields.push(result(n, 'PRICING_SCOPE_UNKNOWN', null, n.value));
          continue;
        }
      }
    } else if (n.head !== 'membership') {
      const spec = specOf(n);
      if (!spec) {
        fields.push(result(n, 'UNKNOWN_FIELD', null, n.value));
        continue;
      }
      // `options.N.preorder.transports=__CLEAR__`: a list, not a field — a route is stopped with enabled=false.
      if (n.item?.group === 'options' && n.path.length === 2 && n.path[1] === 'transports') {
        fields.push(result(n, 'UNKNOWN_FIELD', null, n.value));
        continue;
      }
    } else if (!MEMBERSHIP_FIELD_NAMES.includes(n.path[1] ?? '')) {
      fields.push(result(n, 'UNKNOWN_FIELD', null, n.value));
      continue;
    }

    const lv = live.get(n.nkey);
    const before = lv ? canonicalValue(lv, lv.value) : null;
    const after = canonicalValue(n, n.value);
    if (lv && before === after) continue;
    // A cell, route or row the product does not have, stated empty: nothing to add.
    if (!lv && itemLive && (after === null || after === '')) continue;

    // ---- the store's own: pictures' bytes, a picture added from a file
    if (n.item?.group === 'images') {
      if (!itemLive || !input.liveImageIds.has(n.item.id)) {
        fields.push(result(n, 'READ_ONLY', before, n.value, NEW_IMAGE));
        continue;
      }
      if (IMAGE_READ_ONLY.has(n.path[0] ?? '')) {
        fields.push(result(n, 'READ_ONLY', before, n.value));
        continue;
      }
    }

    // ---- changed since the download?
    if (itemLive) {
      const group = fpGroupOf(n);
      const fileFp = group ? fileFps.get(group) : undefined;
      if (input.legacy || !group) {
        if (input.legacy) {
          const expected = input.file.find((x) => x.key === 'expected_updated_at')?.value?.trim() ?? null;
          if (!expected || expected !== input.liveUpdatedAt) {
            fields.push(result(n, 'CONFLICT_SINCE_DOWNLOAD', before, n.value));
            continue;
          }
        }
      } else if (fileFp !== undefined && fileFp !== input.liveFps.get(group)) {
        if (selfFps.get(group) === fileFp) {
          // The product moved here since the download and the file was not edited here: the file is just older.
          fields.push(result(n, 'STALE_IN_FILE', before, n.value));
        } else {
          fields.push(result(n, 'CONFLICT_SINCE_DOWNLOAD', before, n.value));
        }
        continue;
      }
    }

    // ---- the engine's prices
    if (input.engine && n.head !== 'pricing' && n.head !== 'membership' && engineManaged(n, before, after, liveHas, !itemLive)) {
      fields.push(result(n, 'ENGINE_MANAGED', before, n.value));
      continue;
    }

    // ---- the value itself
    if (n.head !== 'pricing' && n.head !== 'membership' && n.head !== 'spec') {
      const spec = specOf(n)!;
      const why = n.value === null ? (spec.nullable ? null : `${NULL_TOKEN} is not allowed here`) : checkFieldValue(spec, n.value, n.key);
      if (why) {
        fields.push(result(n, 'INVALID_VALUE', before, n.value, why));
        continue;
      }
    }
    fields.push(result(n, 'change', before, n.value));
  }

  // Two items naming one id collide on every key: the second's lines are refused as duplicates above.
  return { fields, goneItems: [...goneItems], errors };
}

// ----------------------------------------------------------------- the patch

export interface PatchOutput {
  /** The minimal template the server applies (`template_version`, `product_id`, the changed keys). */
  text: string;
  /** The patch key → the file key it came from (a refusal of the patch names the file's line). */
  keyMap: Map<string, string>;
  removals: Record<string, string[]>;
  /** The file item (group:#newN) → the id the server gave it. */
  newIds: Record<string, string>;
  /** Membership tiers the patch carries (all six keys of each, from the file). */
  membershipTiers: string[];
}

/**
 * The changes, as a template the existing merge applies in place
 * (`TemplateMergeContext.patch`): scalar keys as they are; each touched item
 * once, by its id, with only its changed fields; a new item with every field
 * the file gives it and an id the server chose; a removal named apart. The
 * pricing block is not here (it goes through the pricing door).
 */
export async function buildPatch(
  productId: string,
  accepted: readonly NEntry[],
  file: readonly NEntry[],
  live: readonly NEntry[]
): Promise<PatchOutput> {
  const keyMap = new Map<string, string>();
  const removals: Record<string, string[]> = {};
  const newIds: Record<string, string> = {};
  const lines: string[] = [`template_version=${TEMPLATE_VERSION}`, `product_id=${productId}`];
  const push = (patchKey: string, fileKey: string, value: string | null) => {
    keyMap.set(patchKey, fileKey);
    lines.push(...writeLine(patchKey, value));
  };
  const liveItems = new Set(live.filter((n) => n.item).map((n) => `${n.item!.group}:${n.item!.id}`));

  // New items get their ids first (deterministic over the item's own lines).
  for (const n of accepted) {
    if (!n.item || n.head === 'pricing') continue;
    const k = `${n.item.group}:${n.item.id}`;
    if (liveItems.has(k) || !n.item.isNew || newIds[k]) continue;
    const content = file
      .filter((x) => x.item && x.item.group === n.item!.group && x.item.index === n.item!.index)
      .map((x) => `${x.key}=${x.value ?? NULL_TOKEN}`)
      .join('\n');
    newIds[k] = await newItemId(productId, n.item.group, n.item.index, content);
  }
  const idOf = (n: NEntry) => newIds[`${n.item!.group}:${n.item!.id}`] ?? n.item!.id;

  const membershipTiers = new Set<string>();
  const items = new Map<string, NEntry[]>();
  for (const n of accepted) {
    if (n.head === 'pricing') continue;
    if (n.head === 'membership') {
      membershipTiers.add(n.path[0]);
      continue;
    }
    if (n.meta === 'remove') {
      (removals[n.item!.group] ??= []).push(n.item!.id);
      continue;
    }
    if (n.item) {
      const k = `${n.item.group}:${n.item.id}`;
      (items.get(k) ?? items.set(k, []).get(k)!).push(n);
      continue;
    }
    // A spec emptied in the file is cleared (an empty `spec.` line alone means "not supplied").
    if (n.head === 'spec' && (n.value === '' || n.value === null)) push(n.key, n.key, CLEAR_TOKEN);
    else push(n.key, n.key, n.value);
  }
  for (const tier of membershipTiers) {
    for (const f of MEMBERSHIP_FIELD_NAMES) {
      const key = `membership.${tier}.${f}`;
      const fromFile = file.find((x) => x.key === key);
      const fromLive = live.find((x) => x.key === key);
      const v = fromFile ? fromFile.value : fromLive?.value ?? '';
      push(key, fromFile?.key ?? key, v === null ? NULL_TOKEN : v);
    }
  }

  const counters = new Map<string, number>();
  for (const [, list] of items) {
    const group = list[0].item!.group;
    const index = (counters.get(group) ?? 0) + 1;
    counters.set(group, index);
    const at = `${group}.${index}`;
    const mergeKey = MERGE_KEY[group];
    push(`${at}.${mergeKey}`, list[0].key.replace(/\.[^.]+$/, `.${mergeKey}`), group === 'transports' ? list[0].item!.id : idOf(list[0]));
    // Rows and routes: numbered within the patch, named by their own id/method.
    const rows = new Map<string, number>();
    const routes = new Map<string, number>();
    for (const n of list) {
      const p = n.path;
      if (group === 'spec_groups' && p[0] === 'rows') {
        let r = rows.get(p[1]);
        if (r === undefined) {
          r = rows.size + 1;
          rows.set(p[1], r);
          const rid = p[1].startsWith('#new') ? await newItemId(productId, 'spec_rows', Number(p[1].slice(4)), `${idOf(n)}|${n.key}`) : p[1];
          push(`${at}.rows.${r}.id`, n.key.replace(/\.[^.]+$/, '.id'), rid.replace(/^itm_/, 'sr_'));
        }
        if (p[2] !== 'id') push(`${at}.rows.${r}.${p[2]}`, n.key, n.value);
        continue;
      }
      if (group === 'options' && p.length === 4 && p[1] === 'transports') {
        const rk = `${p[0]}:${p[2]}`;
        let r = routes.get(rk);
        if (r === undefined) {
          r = [...routes.keys()].filter((x) => x.startsWith(`${p[0]}:`)).length + 1;
          routes.set(rk, r);
          const method = p[2].startsWith('#new')
            ? (file.find((x) => x.item && x.item.id === n.item!.id && x.path[0] === p[0] && x.path[2] === p[2] && x.path[3] === 'method')?.value ?? '')
            : p[2];
          push(`${at}.${p[0]}.transports.${r}.method`, n.key.replace(/\.[^.]+$/, '.method'), method);
        }
        if (p[3] !== 'method') push(`${at}.${p[0]}.transports.${r}.${p[3]}`, n.key, n.value);
        continue;
      }
      if (group === 'options' && p.length === 1 && (p[0] === 'direct' || p[0] === 'preorder')) {
        push(`${at}.${p[0]}`, n.key, CLEAR_TOKEN);
        continue;
      }
      push(`${at}.${p.join('.')}`, n.key, n.value);
    }
  }
  return { text: `${lines.join('\n')}\n`, keyMap, removals, newIds, membershipTiers: [...membershipTiers] };
}

/** The canonical JSON a hash is taken over (sorted keys, so equal content hashes equal). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
