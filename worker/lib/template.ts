/**
 * Deterministic TXT product template pipeline (mandate §6) — NO AI anywhere.
 *
 * Format (template_version=2): human-readable UTF-8 `key=value` lines,
 * `#` comments, indexed repeatable groups (`options.1.name_ar=...`,
 * `spec_groups.1.rows.2.value_ar=...`), multiline values via heredoc
 * (`key=<<<END` ... `END` on its own line). Special tokens:
 *   __NULL__  — explicit null (inherit / no value)
 *   __CLEAR__ — explicit clearing of a previously stored value on update
 * Empty string stays empty. Omitted keys PRESERVE existing values on update.
 *
 * Everything here is pure (no DB, no network): parsing, export, blank
 * generation and template→doc-body merging. Brand/catalog slug resolution
 * needs the DB and lives in worker/routes/template.ts; unresolved references
 * surface as needs_review entries — never silent creation or silent drop.
 */

import { newId } from './crypto';
import type {
  ProductDoc,
  TranslationMeta,
} from './productModel';

export const TEMPLATE_VERSION = 2;
export const NULL_TOKEN = '__NULL__';
export const CLEAR_TOKEN = '__CLEAR__';

// ---------------------------------------------------------------- registry

export type TemplateFieldType =
  | 'string' // single-line text
  | 'text'   // may be multiline (heredoc)
  | 'iqd'    // non-negative integer, Iraqi dinars
  | 'int'    // integer
  | 'bool'   // true/false
  | 'enum'   // one of enumValues
  | 'csv'    // comma-separated list
  | 'hex'    // #RRGGBB or empty
  | 'ref';   // reference resolved via DB (brand / catalog slug or id)

export interface FieldSpec {
  key: string;
  type: TemplateFieldType;
  required: boolean;
  lang?: 'ar' | 'en' | 'ckb';
  nullable: boolean;
  group: string; // one of the 13 editor groups
  notes: string;
  enumValues?: readonly string[];
  min?: number;
  max?: number;
  /** import-only convenience keys are parsed but never exported */
  exported?: boolean;
}

export interface GroupSpec {
  /** template key prefix, e.g. `options` → options.1.name_ar */
  name: string;
  /** doc body key this group writes to */
  bodyKey: string;
  /** id prefix for newly created items ('' = items carry no id) */
  idPrefix: string;
  /** subfield that identifies an item for merge-by-id ('id', or 'method' for transports) */
  mergeKey: string;
  group: string;
  titleAr: string;
  titleEn: string;
  fields: FieldSpec[];
  /** nested rows (spec_groups only): spec_groups.N.rows.M.<field> */
  rowFields?: FieldSpec[];
}

export interface ProtectedFieldSpec {
  key: string;
  notes: string;
}

function f(
  key: string,
  type: TemplateFieldType,
  group: string,
  notes: string,
  opts: Partial<Omit<FieldSpec, 'key' | 'type' | 'group' | 'notes'>> = {}
): FieldSpec {
  return { key, type, required: false, nullable: false, group, notes, ...opts };
}

const IQD_MAX = 2_000_000_000;

/** The 13 canonical editor groups (Arabic-first labels used in exports). */
export const TEMPLATE_GROUPS: Array<{ id: string; titleAr: string; titleEn: string }> = [
  { id: 'identity',        titleAr: 'الهوية',                titleEn: 'Identity' },
  { id: 'description',     titleAr: 'الوصف',                 titleEn: 'Description' },
  { id: 'pricing',         titleAr: 'التسعير',               titleEn: 'Pricing' },
  { id: 'classification',  titleAr: 'التصنيف',               titleEn: 'Classification' },
  { id: 'selling',         titleAr: 'البيع والمخزون',        titleEn: 'Selling & stock' },
  { id: 'transports',      titleAr: 'شحن الطلب المسبق',      titleEn: 'Pre-order transports' },
  { id: 'media',           titleAr: 'الوسائط',               titleEn: 'Media' },
  { id: 'options',         titleAr: 'الخيارات',              titleEn: 'Options' },
  { id: 'colors',          titleAr: 'الألوان',               titleEn: 'Colors' },
  { id: 'specs',           titleAr: 'المواصفات',             titleEn: 'Specifications' },
  { id: 'labels',          titleAr: 'الشارات',               titleEn: 'Labels' },
  { id: 'warranty',        titleAr: 'خطط الضمان',            titleEn: 'Warranty plans' },
  { id: 'content',         titleAr: 'كتل المحتوى',           titleEn: 'Content blocks' },
];

const SCALAR_FIELDS: FieldSpec[] = [
  // identity
  f('name_ar', 'string', 'identity', 'اسم المنتج (المصدر العربي) — Arabic source name; required unless name_en is given', { required: true, lang: 'ar' }),
  f('name_en', 'string', 'identity', 'English name', { lang: 'en' }),
  f('name_ckb', 'string', 'identity', 'ناوی کوردی (سۆرانی) — Kurdish (Sorani) name; stored in the *_ku DB column', { lang: 'ckb' }),
  f('status', 'enum', 'identity', "draft | active | hidden — creation via template is ALWAYS forced to 'draft'", { enumValues: ['draft', 'active', 'hidden'] as const }),
  // description
  f('description_ar', 'text', 'description', 'الوصف العربي (المصدر) — multiline allowed via heredoc', { lang: 'ar' }),
  f('description_en', 'text', 'description', 'English description', { lang: 'en' }),
  f('description_ckb', 'text', 'description', 'وەسفی کوردی — Kurdish description', { lang: 'ckb' }),
  f('how_to_use', 'text', 'description', 'طريقة الاستخدام — usage instructions (multiline allowed)'),
  // pricing — IQD integers; null = inherit/none, 0 = explicit zero
  f('price_iqd', 'iqd', 'pricing', 'السعر الأساسي بالدينار — regular base price, REQUIRED integer', { required: true, min: 0, max: IQD_MAX }),
  f('pro_price_iqd', 'iqd', 'pricing', 'سعر PRO الصريح — explicit PRO price; __NULL__ = no explicit price (store policy applies, default: no discount)', { nullable: true, min: 0, max: IQD_MAX }),
  f('original_price_iqd', 'iqd', 'pricing', 'السعر قبل الخصم — compare-at price; shown only when above the selling price; __NULL__ = none', { nullable: true, min: 0, max: IQD_MAX }),
  f('product_cost_iqd', 'iqd', 'pricing', 'الكلفة (داخلي) — internal cost, NEVER exposed publicly; __NULL__ = unknown', { nullable: true, min: 0, max: IQD_MAX }),
  // classification
  f('brand', 'ref', 'classification', 'العلامة التجارية — brand slug or id, resolved against the brands table; unknown values need review; __NULL__ = no brand', { nullable: true }),
  f('catalogs', 'csv', 'classification', 'الكتالوجات — comma-separated catalog slugs or ids; unknown values need review; empty = in no catalog', { nullable: true }),
  f('hashtags', 'csv', 'classification', 'وسوم — comma-separated hashtags'),
  f('is_featured', 'bool', 'classification', 'منتج مميز — featured flag (true/false)'),
  f('display_order', 'int', 'classification', 'ترتيب العرض — display order (integer, lower = earlier)', { min: -100_000, max: 100_000 }),
  // selling
  f('selling_type', 'enum', 'selling', 'direct_sale | pre_order | bundle', { enumValues: ['direct_sale', 'pre_order', 'bundle'] as const }),
  f('stock', 'int', 'selling', 'المخزون — stock count; __NULL__ = not tracked', { nullable: true, min: 0, max: 1_000_000 }),
  f('payment_options', 'csv', 'selling', 'معرفات طرق الدفع المسموحة — allowed checkout payment method ids, comma-separated'),
];

const GROUP_SPECS: GroupSpec[] = [
  {
    name: 'transports', bodyKey: 'preorder_transports', idPrefix: '', mergeKey: 'method', group: 'transports',
    titleAr: 'شحن الطلب المسبق', titleEn: 'Pre-order transports',
    fields: [
      f('method', 'enum', 'transports', 'air | sea | land — عمولة الشحن تُضاف فوق السعر وتُعفى لأعضاء PRO الفعالين', { required: true, enumValues: ['air', 'sea', 'land'] as const }),
      f('commission_iqd', 'iqd', 'transports', 'عمولة النقل بالدينار — __NULL__ = يرث الافتراضي الإداري لهذه الطريقة', { nullable: true, min: 0, max: IQD_MAX }),
      f('active', 'bool', 'transports', 'معروض للزبائن — offered to customers'),
    ],
  },
  {
    name: 'images', bodyKey: 'media', idPrefix: 'img', mergeKey: 'id', group: 'media',
    titleAr: 'الوسائط', titleEn: 'Media (gallery images)',
    fields: [
      f('id', 'string', 'media', 'معرف ثابت للدمج — stable id used for merge-by-id on update'),
      f('url', 'string', 'media', 'رابط الصورة (/files/<key> أو رابط خارجي) — REQUIRED', { required: true }),
      f('key', 'string', 'media', 'مفتاح R2 الداخلي إن وجد — internal R2 key when stored internally'),
      f('alt_ar', 'string', 'media', 'النص البديل بالعربية', { lang: 'ar' }),
      f('alt_en', 'string', 'media', 'Alt text (English)', { lang: 'en' }),
      f('alt_ckb', 'string', 'media', 'دەقی جێگرەوە بە کوردی', { lang: 'ckb' }),
      f('primary', 'bool', 'media', 'الصورة الرئيسية — exactly one image should be primary'),
      f('source_url', 'string', 'media', 'الرابط المصدر الأصلي عند الاستيراد — original remote source'),
    ],
  },
  {
    name: 'options', bodyKey: 'options', idPrefix: 'opt', mergeKey: 'id', group: 'options',
    titleAr: 'الخيارات', titleEn: 'Options (variants)',
    fields: [
      f('id', 'string', 'options', 'معرف ثابت — stable id; needed for merge-by-id and for colors.*.option_id links'),
      f('name_ar', 'string', 'options', 'اسم الخيار بالعربية', { required: true, lang: 'ar' }),
      f('name_en', 'string', 'options', 'Option name (English)', { lang: 'en' }),
      f('name_ckb', 'string', 'options', 'ناوی هەڵبژاردە بە کوردی', { lang: 'ckb' }),
      f('image', 'string', 'options', 'صورة الخيار — option image URL'),
      f('active', 'bool', 'options', 'فعال — active'),
      f('regular_price_iqd', 'iqd', 'options', 'يستبدل السعر الأساسي — REPLACES the base regular price; __NULL__ = inherit', { nullable: true, min: 0, max: IQD_MAX }),
      f('pro_price_iqd', 'iqd', 'options', 'سعر PRO للخيار — __NULL__ = inherit per-field (option → base)', { nullable: true, min: 0, max: IQD_MAX }),
      f('compare_at_iqd', 'iqd', 'options', 'سعر المقارنة للخيار — __NULL__ = inherit', { nullable: true, min: 0, max: IQD_MAX }),
      f('cost_iqd', 'iqd', 'options', 'كلفة الخيار (داخلي، لا يُنشر أبداً) — __NULL__ = inherit', { nullable: true, min: 0, max: IQD_MAX }),
    ],
  },
  {
    name: 'colors', bodyKey: 'colors', idPrefix: 'col', mergeKey: 'id', group: 'colors',
    titleAr: 'الألوان', titleEn: 'Colors',
    fields: [
      f('id', 'string', 'colors', 'معرف ثابت — stable id for merge-by-id'),
      f('name_ar', 'string', 'colors', 'اسم اللون بالعربية', { required: true, lang: 'ar' }),
      f('name_en', 'string', 'colors', 'Color name (English)', { lang: 'en' }),
      f('name_ckb', 'string', 'colors', 'ناوی ڕەنگ بە کوردی', { lang: 'ckb' }),
      f('hex', 'hex', 'colors', 'رمز اللون #RRGGBB أو فارغ'),
      f('image', 'string', 'colors', 'صورة اللون — color image URL'),
      f('option_id', 'string', 'colors', 'ربط بخيار واحد عبر معرفه — link to ONE option by its id; __NULL__ = متاح لكل الخيارات', { nullable: true }),
      f('option_index', 'int', 'colors', 'بديل استيراد فقط: رقم الخيار في هذا القالب (colors.N.option_index=2 يربط بالخيار options.2) — import-only, never exported', { min: 1, max: 999, exported: false }),
      f('active', 'bool', 'colors', 'فعال — active'),
      f('regular_price_iqd', 'iqd', 'colors', 'يستبدل السعر (لون ← خيار ← أساسي) — REPLACES; __NULL__ = inherit', { nullable: true, min: 0, max: IQD_MAX }),
      f('pro_price_iqd', 'iqd', 'colors', 'سعر PRO للون — __NULL__ = inherit per-field', { nullable: true, min: 0, max: IQD_MAX }),
      f('compare_at_iqd', 'iqd', 'colors', 'سعر المقارنة للون — __NULL__ = inherit', { nullable: true, min: 0, max: IQD_MAX }),
      f('cost_iqd', 'iqd', 'colors', 'كلفة اللون (داخلي) — __NULL__ = inherit', { nullable: true, min: 0, max: IQD_MAX }),
    ],
  },
  {
    name: 'spec_groups', bodyKey: 'spec_groups', idPrefix: 'sg', mergeKey: 'id', group: 'specs',
    titleAr: 'المواصفات', titleEn: 'Specification groups',
    fields: [
      f('id', 'string', 'specs', 'معرف ثابت للمجموعة — stable group id for merge-by-id'),
      f('title_ar', 'string', 'specs', 'عنوان مجموعة المواصفات بالعربية', { required: true, lang: 'ar' }),
      f('title_en', 'string', 'specs', 'Group title (English)', { lang: 'en' }),
      f('title_ckb', 'string', 'specs', 'ناونیشانی گروپ بە کوردی', { lang: 'ckb' }),
    ],
    rowFields: [
      f('id', 'string', 'specs', 'معرف ثابت للسطر — stable row id'),
      f('label_ar', 'string', 'specs', 'اسم المواصفة بالعربية', { required: true, lang: 'ar' }),
      f('label_en', 'string', 'specs', 'Spec label (English)', { lang: 'en' }),
      f('label_ckb', 'string', 'specs', 'ناوی تایبەتمەندی بە کوردی', { lang: 'ckb' }),
      f('value_ar', 'string', 'specs', 'القيمة بالعربية', { lang: 'ar' }),
      f('value_en', 'string', 'specs', 'Value (English)', { lang: 'en' }),
      f('value_ckb', 'string', 'specs', 'بەها بە کوردی', { lang: 'ckb' }),
      f('unit', 'string', 'specs', 'الوحدة (mm، kg، W…) — measurement unit, language-neutral'),
    ],
  },
  {
    name: 'labels', bodyKey: 'labels', idPrefix: 'lbl', mergeKey: 'id', group: 'labels',
    titleAr: 'الشارات', titleEn: 'Labels / badges',
    fields: [
      f('id', 'string', 'labels', 'معرف ثابت — stable id'),
      f('key', 'string', 'labels', "مفتاح اختياري مضبوط: featured | warranty_included | free_returns | free_plus أو فارغ"),
      f('text_ar', 'string', 'labels', 'نص الشارة بالعربية', { lang: 'ar' }),
      f('text_en', 'string', 'labels', 'Label text (English)', { lang: 'en' }),
      f('text_ckb', 'string', 'labels', 'دەقی نیشانە بە کوردی', { lang: 'ckb' }),
      f('icon', 'string', 'labels', 'اسم الأيقونة — icon name'),
      f('visible', 'bool', 'labels', 'ظاهرة للزبون — visible on storefront'),
    ],
  },
  {
    name: 'warranty_plans', bodyKey: 'warranty_plans', idPrefix: 'wp', mergeKey: 'id', group: 'warranty',
    titleAr: 'خطط الضمان', titleEn: 'Warranty plans',
    fields: [
      f('id', 'string', 'warranty', 'معرف ثابت — stable id'),
      f('title_ar', 'string', 'warranty', 'عنوان الخطة بالعربية', { required: true, lang: 'ar' }),
      f('title_en', 'string', 'warranty', 'Plan title (English)', { lang: 'en' }),
      f('title_ckb', 'string', 'warranty', 'ناونیشانی پلان بە کوردی', { lang: 'ckb' }),
      f('terms_ar', 'text', 'warranty', 'شروط الضمان بالعربية (heredoc للأسطر المتعددة)', { lang: 'ar' }),
      f('terms_en', 'text', 'warranty', 'Terms (English)', { lang: 'en' }),
      f('terms_ckb', 'text', 'warranty', 'مەرجەکان بە کوردی', { lang: 'ckb' }),
      f('duration_months', 'int', 'warranty', 'مدة الضمان بالأشهر 1..240', { required: true, min: 1, max: 240 }),
      f('duration_kind', 'enum', 'warranty', 'total (المدة الكلية) | extension (تمديد فوق ضمان المصنع)', { enumValues: ['total', 'extension'] as const }),
      f('fee_iqd', 'iqd', 'warranty', 'رسم الضمان بالدينار — يُضاف على السعر ولا يُعفى أبداً بالعضوية; 0 = مجاني صراحةً', { required: true, min: 0, max: IQD_MAX }),
      f('active', 'bool', 'warranty', 'معروضة — offered'),
    ],
  },
  {
    name: 'content_blocks', bodyKey: 'content_blocks', idPrefix: 'cb', mergeKey: 'id', group: 'content',
    titleAr: 'كتل المحتوى', titleEn: 'Bottom-of-page content blocks',
    fields: [
      f('id', 'string', 'content', 'معرف ثابت — stable id'),
      f('kind', 'enum', 'content', 'text | image | video_embed', { required: true, enumValues: ['text', 'image', 'video_embed'] as const }),
      f('body_ar', 'text', 'content', 'النص العربي (heredoc للأسطر المتعددة)', { lang: 'ar' }),
      f('body_en', 'text', 'content', 'Body (English)', { lang: 'en' }),
      f('body_ckb', 'text', 'content', 'دەق بە کوردی', { lang: 'ckb' }),
      f('caption_ar', 'string', 'content', 'التعليق بالعربية', { lang: 'ar' }),
      f('caption_en', 'string', 'content', 'Caption (English)', { lang: 'en' }),
      f('caption_ckb', 'string', 'content', 'سەردێر بە کوردی', { lang: 'ckb' }),
      f('alt_ar', 'string', 'content', 'النص البديل بالعربية (للصور)', { lang: 'ar' }),
      f('alt_en', 'string', 'content', 'Alt text (English)', { lang: 'en' }),
      f('alt_ckb', 'string', 'content', 'دەقی جێگرەوە بە کوردی', { lang: 'ckb' }),
      f('url', 'string', 'content', 'رابط التضمين للفيديو أو رابط الصورة — embed URL (video_embed) or image URL (image)'),
      f('media_key', 'string', 'content', 'مفتاح R2 عند التخزين الداخلي — internal R2 key'),
    ],
  },
];

/** Fields the template can never edit (or only under an explicit flag). */
const PROTECTED_FIELDS: ProtectedFieldSpec[] = [
  { key: 'product_id', notes: 'header — present in exports; absent = create. Identifies the row to update; never invent one.' },
  { key: 'expected_updated_at', notes: 'header — optional optimistic-concurrency check; apply fails with 409 STALE when the product changed since export.' },
  { key: 'slug', notes: 'stable public identity — preserved on update unless allow_slug_change=true is set in the same template; free on create.' },
  { key: 'allow_slug_change', notes: 'header flag (true/false) unlocking a slug change on update.' },
  { key: 'doc_version', notes: 'schema version managed by the persistence layer — never editable.' },
  { key: 'content_rev', notes: 'Arabic-source revision counter — bumped automatically when Arabic source text changes.' },
  { key: 'translation_meta', notes: 'per-field translation status bookkeeping — derived automatically, never hand-edited.' },
  { key: 'created_at / updated_at', notes: 'timestamps managed by the database.' },
  { key: 'legacy.*', notes: 'v1 passthrough columns (shipping_methods, features, stores, membership_prices, …) — preserved verbatim, not template-editable.' },
];

export const FIELD_REGISTRY = {
  version: TEMPLATE_VERSION,
  scalars: SCALAR_FIELDS,
  groups: GROUP_SPECS,
  protected: PROTECTED_FIELDS,
} as const;

const SCALAR_BY_KEY = new Map(SCALAR_FIELDS.map((s) => [s.key, s]));
const GROUP_BY_NAME = new Map(GROUP_SPECS.map((g) => [g.name, g]));
const HEADER_KEYS = new Set(['template_version', 'product_id', 'expected_updated_at', 'allow_slug_change', 'slug']);

// ---------------------------------------------------------------- parse

export interface TemplateError { line: number; key: string; message: string }
export interface ParsedField { value: unknown; clear: boolean; line: number }
export interface ParsedGroupItem {
  index: number;
  line: number;
  fields: Record<string, ParsedField>;
  rows?: ParsedGroupItem[];
}
export interface ParsedTemplate {
  header: {
    template_version: number | null;
    product_id: string | null;
    expected_updated_at: string | null;
    allow_slug_change: boolean;
  };
  /** scalar registry fields (+ slug) present in the template */
  fields: Record<string, ParsedField>;
  /** group name → clear marker (e.g. `options=__CLEAR__`) */
  groupClears: Record<string, ParsedField>;
  groups: Record<string, ParsedGroupItem[]>;
  unknown_keys: string[];
  errors: TemplateError[];
  warnings: string[];
}

const MAX_TEMPLATE_BYTES = 1_500_000;
const KEY_RE = /^([A-Za-z0-9_.]+)\s*=(.*)$/;
const GROUP_KEY_RE = /^([a-z_]+)\.(\d+)\.(.+)$/;
const ROW_KEY_RE = /^rows\.(\d+)\.(.+)$/;
const HEREDOC_TOKEN_RE = /^[A-Za-z0-9_]{1,40}$/;

function coerce(
  spec: FieldSpec,
  raw: string,
  line: number,
  fullKey: string,
  errors: TemplateError[]
): ParsedField | null {
  const err = (message: string) => {
    errors.push({ line, key: fullKey, message });
    return null;
  };
  if (raw === NULL_TOKEN) {
    if (!spec.nullable) return err(`${NULL_TOKEN} is not allowed here — the field is not nullable (use ${CLEAR_TOKEN} to empty it, or omit the line to keep the current value)`);
    return { value: null, clear: false, line };
  }
  if (raw === CLEAR_TOKEN) {
    if (spec.type === 'iqd' || spec.type === 'int') {
      if (!spec.nullable) return err(`${CLEAR_TOKEN} is not allowed — this number is required; set an explicit value`);
      return { value: null, clear: true, line };
    }
    if (spec.type === 'bool' || spec.type === 'enum') {
      return err(`${CLEAR_TOKEN} is not allowed for ${spec.type} fields — set an explicit value`);
    }
    if (spec.type === 'csv') return { value: [], clear: true, line };
    return { value: '', clear: true, line };
  }
  switch (spec.type) {
    case 'string':
    case 'text':
    case 'ref':
      return { value: raw, clear: false, line };
    case 'hex':
      if (raw !== '' && !/^#[0-9a-fA-F]{6}$/.test(raw)) return err('must be a #RRGGBB hex code or empty');
      return { value: raw, clear: false, line };
    case 'iqd':
    case 'int': {
      if (raw === '') return err(`empty number — write an integer, ${spec.nullable ? `${NULL_TOKEN}, ` : ''}or omit the line to keep the current value`);
      if (!/^-?\d+$/.test(raw)) return err(`must be an integer${spec.type === 'iqd' ? ' (IQD, no separators or decimals)' : ''}`);
      const n = parseInt(raw, 10);
      if (!Number.isSafeInteger(n)) return err('integer out of range');
      const min = spec.min ?? (spec.type === 'iqd' ? 0 : Number.MIN_SAFE_INTEGER);
      const max = spec.max ?? Number.MAX_SAFE_INTEGER;
      if (n < min || n > max) return err(`must be between ${min} and ${max}`);
      return { value: n, clear: false, line };
    }
    case 'bool': {
      const t = raw.toLowerCase();
      if (t === 'true' || t === '1' || t === 'yes') return { value: true, clear: false, line };
      if (t === 'false' || t === '0' || t === 'no') return { value: false, clear: false, line };
      return err('must be true or false');
    }
    case 'enum':
      if (!spec.enumValues || !spec.enumValues.includes(raw)) {
        return err(`must be one of: ${(spec.enumValues ?? []).join(' | ')}`);
      }
      return { value: raw, clear: false, line };
    case 'csv': {
      if (raw === '') return { value: [], clear: false, line };
      const items = raw.split(',').map((x) => x.trim()).filter(Boolean);
      return { value: items, clear: false, line };
    }
  }
}

/**
 * Parses template text into structured fields/groups with line-precise
 * errors. Strips a UTF-8 BOM, normalizes CRLF/CR line endings, handles
 * heredoc multiline values (Arabic/ckb content preserved verbatim).
 */
export function parseTemplate(text: string): ParsedTemplate {
  const out: ParsedTemplate = {
    header: { template_version: null, product_id: null, expected_updated_at: null, allow_slug_change: false },
    fields: {},
    groupClears: {},
    groups: {},
    unknown_keys: [],
    errors: [],
    warnings: [],
  };
  const err = (line: number, key: string, message: string) => out.errors.push({ line, key, message });

  if (typeof text !== 'string') {
    err(1, '', 'template text is missing');
    return out;
  }
  if (text.length > MAX_TEMPLATE_BYTES) {
    err(1, '', `template is too large (max ${MAX_TEMPLATE_BYTES} characters)`);
    return out;
  }
  // BOM strip + newline normalization (CRLF and lone CR → LF).
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  // group → index → item ; duplicate detection sets
  const seenScalar = new Set<string>();
  const seenGroupField = new Set<string>();
  const groupItems: Record<string, Map<number, ParsedGroupItem>> = {};

  const getItem = (groupName: string, index: number, line: number): ParsedGroupItem => {
    const map = (groupItems[groupName] ??= new Map());
    let item = map.get(index);
    if (!item) {
      item = { index, line, fields: {} };
      map.set(index, item);
    }
    return item;
  };

  let i = 0;
  while (i < lines.length) {
    const lineNo = i + 1;
    const rawLine = lines[i];
    i++;
    const trimmed = rawLine.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const m = KEY_RE.exec(trimmed);
    if (!m) {
      err(lineNo, '', `not a key=value line: "${trimmed.slice(0, 60)}"`);
      continue;
    }
    const key = m[1];
    let value = m[2].trim();

    // Heredoc: key=<<<TOKEN … TOKEN (terminator on its own line, content verbatim).
    if (value.startsWith('<<<')) {
      const token = value.slice(3).trim() || 'END';
      if (!HEREDOC_TOKEN_RE.test(token)) {
        err(lineNo, key, `invalid heredoc delimiter "${token}" — use letters/digits/underscore, e.g. key=<<<END`);
        continue;
      }
      const collected: string[] = [];
      let terminated = false;
      while (i < lines.length) {
        const l = lines[i];
        i++;
        if (l.trim() === token) { terminated = true; break; }
        collected.push(l);
      }
      if (!terminated) {
        err(lineNo, key, `unterminated heredoc — missing closing "${token}" line`);
        continue;
      }
      value = collected.join('\n');
    }

    // ---- header keys
    if (HEADER_KEYS.has(key)) {
      if (seenScalar.has(key)) { err(lineNo, key, 'duplicate key'); continue; }
      seenScalar.add(key);
      if (key === 'template_version') {
        if (value !== String(TEMPLATE_VERSION)) {
          err(lineNo, key, `unsupported template_version "${value}" — this parser accepts version ${TEMPLATE_VERSION}`);
        } else {
          out.header.template_version = TEMPLATE_VERSION;
        }
      } else if (key === 'product_id') {
        out.header.product_id = value || null;
      } else if (key === 'expected_updated_at') {
        out.header.expected_updated_at = value || null;
      } else if (key === 'allow_slug_change') {
        const t = value.toLowerCase();
        if (t !== 'true' && t !== 'false' && t !== '') { err(lineNo, key, 'must be true or false'); continue; }
        out.header.allow_slug_change = t === 'true';
      } else if (key === 'slug') {
        out.fields.slug = { value, clear: false, line: lineNo };
      }
      continue;
    }

    // ---- scalar registry keys
    const scalarSpec = SCALAR_BY_KEY.get(key);
    if (scalarSpec) {
      if (seenScalar.has(key)) { err(lineNo, key, 'duplicate key'); continue; }
      seenScalar.add(key);
      const pf = coerce(scalarSpec, value, lineNo, key, out.errors);
      if (pf) out.fields[key] = pf;
      continue;
    }

    // ---- whole-group clear: options=__CLEAR__
    if (GROUP_BY_NAME.has(key)) {
      if (value !== CLEAR_TOKEN) {
        err(lineNo, key, `"${key}" is a repeatable group — use indexed keys like ${key}.1.…, or ${key}=${CLEAR_TOKEN} to remove all items`);
        continue;
      }
      if (out.groupClears[key]) { err(lineNo, key, 'duplicate key'); continue; }
      out.groupClears[key] = { value: null, clear: true, line: lineNo };
      continue;
    }

    // ---- indexed group keys
    const gm = GROUP_KEY_RE.exec(key);
    if (gm && GROUP_BY_NAME.has(gm[1])) {
      const groupSpec = GROUP_BY_NAME.get(gm[1])!;
      const index = parseInt(gm[2], 10);
      if (index < 1 || index > 500) { err(lineNo, key, 'group index must be between 1 and 500'); continue; }
      const sub = gm[3];
      const item = getItem(groupSpec.name, index, lineNo);

      const rm = ROW_KEY_RE.exec(sub);
      if (rm && groupSpec.rowFields) {
        const rowIndex = parseInt(rm[1], 10);
        if (rowIndex < 1 || rowIndex > 500) { err(lineNo, key, 'row index must be between 1 and 500'); continue; }
        const rowKey = rm[2];
        const rowSpec = groupSpec.rowFields.find((r) => r.key === rowKey);
        if (!rowSpec) { out.unknown_keys.push(key); continue; }
        if (seenGroupField.has(key)) { err(lineNo, key, 'duplicate key'); continue; }
        seenGroupField.add(key);
        item.rows ??= [];
        let row = item.rows.find((r) => r.index === rowIndex);
        if (!row) { row = { index: rowIndex, line: lineNo, fields: {} }; item.rows.push(row); }
        const pf = coerce(rowSpec, value, lineNo, key, out.errors);
        if (pf) row.fields[rowKey] = pf;
        continue;
      }

      const fieldSpec = groupSpec.fields.find((x) => x.key === sub);
      if (!fieldSpec) { out.unknown_keys.push(key); continue; }
      if (seenGroupField.has(key)) { err(lineNo, key, 'duplicate key'); continue; }
      seenGroupField.add(key);
      const pf = coerce(fieldSpec, value, lineNo, key, out.errors);
      if (pf) item.fields[sub] = pf;
      continue;
    }

    out.unknown_keys.push(key);
  }

  if (out.header.template_version === null && !out.errors.some((e) => e.key === 'template_version')) {
    err(1, 'template_version', `template_version=${TEMPLATE_VERSION} is required as the first non-comment line`);
  }

  // Materialize groups sorted by index; rows sorted too.
  for (const [name, map] of Object.entries(groupItems)) {
    const items = [...map.values()].sort((a, b) => a.index - b.index);
    for (const it of items) it.rows?.sort((a, b) => a.index - b.index);
    out.groups[name] = items;
  }
  for (const key of out.unknown_keys) {
    out.warnings.push(`unknown key "${key}" was ignored`);
  }
  return out;
}

// ---------------------------------------------------------------- export

export interface ExportOpts {
  /** brand slug for readability (falls back to doc.brand_id / __NULL__) */
  brand?: string | null;
  /** catalog slugs; when undefined the catalogs key is omitted (unknown) */
  catalogs?: string[];
  /** include field-annotation comments (blank template style) */
  comments?: boolean;
}

interface Entry { key: string; value: string | null }

function heredocDelim(value: string): string {
  let token = 'END';
  let n = 1;
  const has = (t: string) => value.split('\n').some((l) => l.trim() === t);
  while (has(token)) token = `END_${++n}`;
  return token;
}

function fmtLines(key: string, value: string | null): string[] {
  if (value === null) return [`${key}=${NULL_TOKEN}`];
  const needsHeredoc =
    value.includes('\n') ||
    value !== value.trim() ||
    value.startsWith('<<<') ||
    value === NULL_TOKEN ||
    value === CLEAR_TOKEN;
  if (!needsHeredoc) return [`${key}=${value}`];
  const token = heredocDelim(value);
  return [`${key}=<<<${token}`, ...value.split('\n'), token];
}

const boolStr = (b: boolean) => (b ? 'true' : 'false');
const numStr = (n: number | null) => (n === null || n === undefined ? null : String(n));

/**
 * Flattens a ProductDoc into deterministic template entries (registry order,
 * group items ordered by their `order` then id). Reused by exportProduct and
 * by the route-level diff (before/after keyed by template key).
 */
export function docToEntries(doc: ProductDoc, opts: ExportOpts = {}): Entry[] {
  const e: Entry[] = [];
  const push = (key: string, value: string | null) => e.push({ key, value });

  // identity
  push('name_ar', doc.name_ar);
  push('name_en', doc.name_en);
  push('name_ckb', doc.name_ckb);
  push('status', doc.status);
  // description
  push('description_ar', doc.description_ar);
  push('description_en', doc.description_en);
  push('description_ckb', doc.description_ckb);
  push('how_to_use', doc.how_to_use);
  // pricing
  push('price_iqd', String(doc.price_iqd));
  push('pro_price_iqd', numStr(doc.pro_price_iqd));
  push('original_price_iqd', numStr(doc.original_price_iqd));
  push('product_cost_iqd', numStr(doc.product_cost_iqd));
  // classification
  if (opts.brand !== undefined) push('brand', opts.brand);
  else push('brand', doc.brand_id ?? null);
  if (opts.catalogs !== undefined) push('catalogs', opts.catalogs.join(','));
  push('hashtags', doc.hashtags.join(','));
  push('is_featured', boolStr(doc.is_featured));
  push('display_order', String(doc.display_order));
  // selling
  push('selling_type', doc.selling_type);
  push('stock', numStr(doc.stock));
  push('payment_options', doc.payment_options.join(','));

  const sorted = <T extends { order?: number; id?: string }>(items: T[]): T[] =>
    [...items].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.id).localeCompare(String(b.id)));

  doc.preorder_transports.forEach((t, i) => {
    const p = `transports.${i + 1}`;
    push(`${p}.method`, t.method);
    push(`${p}.commission_iqd`, numStr(t.commission_iqd));
    push(`${p}.active`, boolStr(t.active));
  });

  sorted(doc.media).forEach((mItem, i) => {
    const p = `images.${i + 1}`;
    push(`${p}.id`, mItem.id);
    push(`${p}.url`, mItem.url);
    push(`${p}.key`, mItem.key);
    push(`${p}.alt_ar`, mItem.alt_ar);
    push(`${p}.alt_en`, mItem.alt_en);
    push(`${p}.alt_ckb`, mItem.alt_ckb);
    push(`${p}.primary`, boolStr(mItem.primary));
    push(`${p}.source_url`, mItem.source_url);
  });

  sorted(doc.options).forEach((o, i) => {
    const p = `options.${i + 1}`;
    push(`${p}.id`, o.id);
    push(`${p}.name_ar`, o.name_ar);
    push(`${p}.name_en`, o.name_en);
    push(`${p}.name_ckb`, o.name_ckb);
    push(`${p}.image`, o.image);
    push(`${p}.active`, boolStr(o.active));
    push(`${p}.regular_price_iqd`, numStr(o.regular_price_iqd));
    push(`${p}.pro_price_iqd`, numStr(o.pro_price_iqd));
    push(`${p}.compare_at_iqd`, numStr(o.compare_at_iqd));
    push(`${p}.cost_iqd`, numStr(o.cost_iqd));
  });

  sorted(doc.colors).forEach((cItem, i) => {
    const p = `colors.${i + 1}`;
    push(`${p}.id`, cItem.id);
    push(`${p}.name_ar`, cItem.name_ar);
    push(`${p}.name_en`, cItem.name_en);
    push(`${p}.name_ckb`, cItem.name_ckb);
    push(`${p}.hex`, cItem.hex);
    push(`${p}.image`, cItem.image);
    push(`${p}.option_id`, cItem.option_id ?? null);
    push(`${p}.active`, boolStr(cItem.active));
    push(`${p}.regular_price_iqd`, numStr(cItem.regular_price_iqd));
    push(`${p}.pro_price_iqd`, numStr(cItem.pro_price_iqd));
    push(`${p}.compare_at_iqd`, numStr(cItem.compare_at_iqd));
    push(`${p}.cost_iqd`, numStr(cItem.cost_iqd));
  });

  sorted(doc.spec_groups).forEach((g, gi) => {
    const p = `spec_groups.${gi + 1}`;
    push(`${p}.id`, g.id);
    push(`${p}.title_ar`, g.title_ar);
    push(`${p}.title_en`, g.title_en);
    push(`${p}.title_ckb`, g.title_ckb);
    sorted(g.rows).forEach((r, ri) => {
      const rp = `${p}.rows.${ri + 1}`;
      push(`${rp}.id`, r.id);
      push(`${rp}.label_ar`, r.label_ar);
      push(`${rp}.label_en`, r.label_en);
      push(`${rp}.label_ckb`, r.label_ckb);
      push(`${rp}.value_ar`, r.value_ar);
      push(`${rp}.value_en`, r.value_en);
      push(`${rp}.value_ckb`, r.value_ckb);
      push(`${rp}.unit`, r.unit);
    });
  });

  sorted(doc.labels).forEach((l, i) => {
    const p = `labels.${i + 1}`;
    push(`${p}.id`, l.id);
    push(`${p}.key`, l.key);
    push(`${p}.text_ar`, l.text_ar);
    push(`${p}.text_en`, l.text_en);
    push(`${p}.text_ckb`, l.text_ckb);
    push(`${p}.icon`, l.icon);
    push(`${p}.visible`, boolStr(l.visible));
  });

  sorted(doc.warranty_plans).forEach((w, i) => {
    const p = `warranty_plans.${i + 1}`;
    push(`${p}.id`, w.id);
    push(`${p}.title_ar`, w.title_ar);
    push(`${p}.title_en`, w.title_en);
    push(`${p}.title_ckb`, w.title_ckb);
    push(`${p}.terms_ar`, w.terms_ar);
    push(`${p}.terms_en`, w.terms_en);
    push(`${p}.terms_ckb`, w.terms_ckb);
    push(`${p}.duration_months`, String(w.duration_months));
    push(`${p}.duration_kind`, w.duration_kind);
    push(`${p}.fee_iqd`, String(w.fee_iqd));
    push(`${p}.active`, boolStr(w.active));
  });

  sorted(doc.content_blocks).forEach((b, i) => {
    const p = `content_blocks.${i + 1}`;
    push(`${p}.id`, b.id);
    push(`${p}.kind`, b.kind);
    push(`${p}.body_ar`, b.body_ar);
    push(`${p}.body_en`, b.body_en);
    push(`${p}.body_ckb`, b.body_ckb);
    push(`${p}.caption_ar`, b.caption_ar);
    push(`${p}.caption_en`, b.caption_en);
    push(`${p}.caption_ckb`, b.caption_ckb);
    push(`${p}.alt_ar`, b.alt_ar);
    push(`${p}.alt_en`, b.alt_en);
    push(`${p}.alt_ckb`, b.alt_ckb);
    push(`${p}.url`, b.url);
    push(`${p}.media_key`, b.media_key);
  });

  return e;
}

const groupTitle = (id: string): { ar: string; en: string } => {
  const g = TEMPLATE_GROUPS.find((x) => x.id === id)!;
  return { ar: g.titleAr, en: g.titleEn };
};

function sectionHeader(groupId: string): string[] {
  const t = groupTitle(groupId);
  return ['', `# ------------------------------ ${t.ar} / ${t.en}`];
}

/** Deterministic full export of a product document (all languages). */
export function exportProduct(doc: ProductDoc, opts: ExportOpts = {}): string {
  const lines: string[] = [
    '# قالب منتج ليفونيس — الإصدار 2 / Levonis product template, version 2',
    '# الأسطر التي تبدأ بـ # تعليقات. القيم الفارغة تبقى فارغة.',
    `# ${NULL_TOKEN} = لا قيمة (وراثة). ${CLEAR_TOKEN} = مسح القيمة الحالية عند التحديث.`,
    '# الحقول المحذوفة من الملف تحافظ على قيمتها الحالية عند التحديث.',
    `template_version=${TEMPLATE_VERSION}`,
    `product_id=${doc.id}`,
  ];
  if (doc.updated_at) lines.push(`expected_updated_at=${doc.updated_at}`);
  lines.push(`# slug ثابت — لتغييره أضف allow_slug_change=true / slug is stable; add allow_slug_change=true to change it`);
  lines.push(`slug=${doc.slug}`);

  const entries = docToEntries(doc, opts);
  let currentSection = '';
  const sectionOf = (key: string): string => {
    const gm = /^([a-z_]+)\.\d+\./.exec(key);
    if (gm) return GROUP_BY_NAME.get(gm[1])?.group ?? gm[1];
    return SCALAR_BY_KEY.get(key)?.group ?? 'identity';
  };
  for (const entry of entries) {
    const sec = sectionOf(entry.key);
    if (sec !== currentSection) {
      currentSection = sec;
      lines.push(...sectionHeader(sec));
    }
    lines.push(...fmtLines(entry.key, entry.value));
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------- blank

function fieldComment(spec: FieldSpec): string {
  const bits: string[] = [spec.type];
  if (spec.required) bits.push('مطلوب/required');
  if (spec.nullable) bits.push(`nullable (${NULL_TOKEN})`);
  if (spec.lang) bits.push(`lang:${spec.lang}`);
  if (spec.enumValues) bits.push(spec.enumValues.join('|'));
  return `# ${spec.key} — ${bits.join(', ')} — ${spec.notes}`;
}

function blankValue(spec: FieldSpec): string {
  if (spec.nullable && (spec.type === 'iqd' || spec.type === 'int' || spec.type === 'ref' || spec.type === 'string')) return NULL_TOKEN;
  switch (spec.type) {
    case 'bool': return spec.key === 'active' || spec.key === 'visible' || spec.key === 'primary' ? 'true' : 'false';
    case 'enum': return spec.enumValues?.[0] ?? '';
    default: return '';
  }
}

/** Blank template with every key, commented with type/required/notes. */
export function generateBlankTemplate(): string {
  const lines: string[] = [
    '# ============================================================',
    '# قالب منتج ليفونيس (فارغ) — الإصدار 2',
    '# Levonis product template (blank), version 2',
    '# ============================================================',
    '# القواعد / Rules:',
    '#  - كل سطر: key=value — الأسطر التي تبدأ بـ # تعليقات وتُتجاهل.',
    `#  - ${NULL_TOKEN} = لا قيمة/وراثة (explicit null). ${CLEAR_TOKEN} = مسح القيمة عند التحديث.`,
    '#  - القيمة الفارغة تبقى فارغة. الحقول المحذوفة تحافظ على قيمتها عند التحديث.',
    '#  - النص متعدد الأسطر: key=<<<END ثم الأسطر ثم END في سطر مستقل.',
    '#  - المجموعات المتكررة مفهرسة: options.1.name_ar ثم options.2.name_ar وهكذا.',
    '#  - الأسعار أعداد صحيحة بالدينار العراقي فقط (بدون فواصل).',
    '#  - أسعار الخيار/اللون تستبدل السعر الأساسي (وراثة لكل حقل: لون ← خيار ← أساسي).',
    '#  - لا تختلق قيماً — إذا كانت المعلومة غير معروفة اترك الحقل فارغاً أو __NULL__.',
    '',
    `template_version=${TEMPLATE_VERSION}`,
    '# product_id: اتركه محذوفاً لإنشاء منتج جديد (يُنشأ دائماً كمسودة draft).',
    '# product_id=',
    '# expected_updated_at: اختياري — فحص التقادم عند التحديث (يُنسخ من التصدير).',
    '# slug: حر عند الإنشاء؛ عند التحديث يتطلب allow_slug_change=true.',
    'slug=',
  ];

  let current = '';
  for (const spec of SCALAR_FIELDS) {
    if (spec.group !== current) {
      current = spec.group;
      lines.push(...sectionHeader(spec.group));
    }
    lines.push(fieldComment(spec));
    lines.push(`${spec.key}=${blankValue(spec)}`);
  }

  for (const g of GROUP_SPECS) {
    lines.push(...sectionHeader(g.group));
    lines.push(`# مجموعة متكررة "${g.name}" — كرر بـ ${g.name}.2.… ${g.name}.3.…`);
    lines.push(`# لحذف كل العناصر عند التحديث: ${g.name}=${CLEAR_TOKEN}`);
    for (const spec of g.fields) {
      if (spec.exported === false) {
        lines.push(fieldComment(spec));
        lines.push(`# ${g.name}.1.${spec.key}=`);
        continue;
      }
      lines.push(fieldComment(spec));
      lines.push(`${g.name}.1.${spec.key}=${blankValue(spec)}`);
    }
    if (g.rowFields) {
      lines.push(`# أسطر المواصفات داخل المجموعة: ${g.name}.1.rows.1.… ${g.name}.1.rows.2.…`);
      for (const spec of g.rowFields) {
        lines.push(fieldComment(spec));
        lines.push(`${g.name}.1.rows.1.${spec.key}=${blankValue(spec)}`);
      }
    }
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------- to doc body

export interface NeedsReviewEntry { key: string; line: number; value: string; message: string }

export interface ResolvedRefs {
  /** resolved brand id; null = clear brand; undefined = omitted/unresolved (preserve) */
  brand_id?: string | null;
  /** resolved catalog ids; undefined = omitted/unresolved (preserve associations) */
  catalog_ids?: string[];
  needs_review?: NeedsReviewEntry[];
}

export interface ToDocResult {
  body: Record<string, unknown>;
  applied_fields: string[];
  cleared_fields: string[];
  preserved_fields: string[];
  needs_review: NeedsReviewEntry[];
  warnings: string[];
}

type LooseItem = Record<string, unknown>;

function applyItemField(target: LooseItem, spec: FieldSpec, pf: ParsedField): void {
  if (pf.clear) {
    if (spec.type === 'iqd' || spec.type === 'int') target[spec.key] = null;
    else if (spec.type === 'csv') target[spec.key] = [];
    else target[spec.key] = '';
    return;
  }
  target[spec.key] = pf.value;
}

function buildGroupItems(
  g: GroupSpec,
  templateItems: ParsedGroupItem[],
  existingItems: LooseItem[],
  result: ToDocResult
): LooseItem[] {
  const mk = g.mergeKey;
  const allHaveIds = templateItems.every(
    (it) => typeof it.fields[mk]?.value === 'string' && (it.fields[mk].value as string).trim() !== ''
  );

  const buildFresh = (it: ParsedGroupItem, orderIndex: number): LooseItem => {
    const item: LooseItem = { order: orderIndex };
    for (const spec of g.fields) {
      const pf = it.fields[spec.key];
      if (pf) applyItemField(item, spec, pf);
    }
    if (g.idPrefix && (typeof item.id !== 'string' || !item.id)) item.id = newId(g.idPrefix);
    // requiredness of subfields — never silently drop an item
    for (const spec of g.fields) {
      if (spec.required && spec.type !== 'iqd' && spec.type !== 'int') {
        const v = item[spec.key];
        if (v === undefined || v === null || v === '') {
          result.needs_review.push({
            key: `${g.name}.${it.index}.${spec.key}`, line: it.line, value: '',
            message: `${spec.key} is required for every ${g.name} item`,
          });
        }
      } else if (spec.required && item[spec.key] === undefined) {
        result.needs_review.push({
          key: `${g.name}.${it.index}.${spec.key}`, line: it.line, value: '',
          message: `${spec.key} is required for every ${g.name} item`,
        });
      }
    }
    if (g.rowFields) item.rows = buildRows(g, it, null, result);
    return item;
  };

  if (existingItems.length > 0 && templateItems.length > 0 && allHaveIds) {
    // MERGE BY ID (transports merge by method): mentioned items are updated
    // field-by-field (omitted subfields preserved); new ids are appended;
    // unmentioned existing items are KEPT (use replace-all or
    // <group>=__CLEAR__ to remove them).
    const byId = new Map(existingItems.map((x) => [String(x[mk]), x]));
    const mentioned = new Set<string>();
    const merged: LooseItem[] = [];
    templateItems.forEach((it, orderIndex) => {
      const id = String(it.fields[mk]!.value).trim();
      mentioned.add(id);
      const base = byId.get(id);
      if (base) {
        const item: LooseItem = { ...base, order: orderIndex };
        for (const spec of g.fields) {
          const pf = it.fields[spec.key];
          if (pf) applyItemField(item, spec, pf);
        }
        if (g.rowFields) item.rows = buildRows(g, it, (base.rows as LooseItem[]) ?? [], result);
        merged.push(item);
      } else {
        merged.push(buildFresh(it, orderIndex));
      }
    });
    let tail = templateItems.length;
    for (const ex of existingItems) {
      if (!mentioned.has(String(ex[mk]))) merged.push({ ...ex, order: tail++ });
    }
    return merged;
  }

  // REPLACE ALL (no existing items, or some template items lack a merge key).
  if (existingItems.length > 0) {
    result.warnings.push(
      `${g.name}: replaced all ${existingItems.length} existing item(s) because not every template item carries ${g.mergeKey === 'id' ? 'an id' : `a ${g.mergeKey}`} — add ${g.mergeKey}s to merge instead`
    );
  }
  return templateItems.map((it, i) => buildFresh(it, i));
}

function buildRows(
  g: GroupSpec,
  templateItem: ParsedGroupItem,
  existingRows: LooseItem[] | null,
  result: ToDocResult
): LooseItem[] {
  const rowSpecs = g.rowFields!;
  const tRows = templateItem.rows ?? [];
  if (tRows.length === 0) return existingRows ?? [];

  const buildFreshRow = (r: ParsedGroupItem, orderIndex: number): LooseItem => {
    const row: LooseItem = { order: orderIndex };
    for (const spec of rowSpecs) {
      const pf = r.fields[spec.key];
      if (pf) applyItemField(row, spec, pf);
    }
    if (typeof row.id !== 'string' || !row.id) row.id = newId('sr');
    for (const spec of rowSpecs) {
      if (spec.required && (row[spec.key] === undefined || row[spec.key] === '')) {
        result.needs_review.push({
          key: `${g.name}.${templateItem.index}.rows.${r.index}.${spec.key}`, line: r.line, value: '',
          message: `${spec.key} is required for every specification row`,
        });
      }
    }
    return row;
  };

  const allRowIds = tRows.every((r) => typeof r.fields.id?.value === 'string' && (r.fields.id.value as string).trim() !== '');
  if (existingRows && existingRows.length > 0 && allRowIds) {
    const byId = new Map(existingRows.map((x) => [String(x.id), x]));
    const mentioned = new Set<string>();
    const merged: LooseItem[] = [];
    tRows.forEach((r, orderIndex) => {
      const id = String(r.fields.id!.value).trim();
      mentioned.add(id);
      const base = byId.get(id);
      if (base) {
        const row: LooseItem = { ...base, order: orderIndex };
        for (const spec of rowSpecs) {
          const pf = r.fields[spec.key];
          if (pf) applyItemField(row, spec, pf);
        }
        merged.push(row);
      } else {
        merged.push(buildFreshRow(r, orderIndex));
      }
    });
    let tail = tRows.length;
    for (const ex of existingRows) {
      if (!mentioned.has(String(ex.id))) merged.push({ ...ex, order: tail++ });
    }
    return merged;
  }
  if (existingRows && existingRows.length > 0) {
    result.warnings.push(
      `${g.name}.${templateItem.index}.rows: replaced all existing rows because not every template row carries an id`
    );
  }
  return tRows.map((r, i) => buildFreshRow(r, i));
}

/**
 * Merges a parsed template onto an existing doc (or builds a create body).
 * - omitted fields PRESERVE existing values (recorded in preserved_fields)
 * - __CLEAR__ empties a field (cleared_fields)
 * - repeatable groups merge BY ID when every item has one, otherwise the
 *   whole group is replaced (with a warning)
 * - brand/catalogs need DB resolution: pass `resolved` from the route; an
 *   unresolved reference lands in needs_review — never silently applied.
 * The returned body still goes through validateProductDoc — this function
 * performs merging, not final validation.
 */
export function toDocBody(
  parsed: ParsedTemplate,
  existing?: ProductDoc | null,
  resolved?: ResolvedRefs
): ToDocResult {
  const result: ToDocResult = {
    body: {},
    applied_fields: [],
    cleared_fields: [],
    preserved_fields: [],
    needs_review: [...(resolved?.needs_review ?? [])],
    warnings: [...parsed.warnings],
  };
  const body: Record<string, unknown> = existing
    ? {
        id: existing.id,
        slug: existing.slug,
        status: existing.status,
        content_rev: existing.content_rev,
        name_ar: existing.name_ar, name_en: existing.name_en, name_ckb: existing.name_ckb,
        description_ar: existing.description_ar, description_en: existing.description_en, description_ckb: existing.description_ckb,
        how_to_use: existing.how_to_use,
        price_iqd: existing.price_iqd,
        pro_price_iqd: existing.pro_price_iqd,
        original_price_iqd: existing.original_price_iqd,
        product_cost_iqd: existing.product_cost_iqd,
        selling_type: existing.selling_type,
        stock: existing.stock,
        brand_id: existing.brand_id,
        is_featured: existing.is_featured,
        display_order: existing.display_order,
        payment_options: existing.payment_options,
        hashtags: existing.hashtags,
        media: existing.media,
        options: existing.options,
        colors: existing.colors,
        spec_groups: existing.spec_groups,
        labels: existing.labels,
        warranty_plans: existing.warranty_plans,
        preorder_transports: existing.preorder_transports,
        content_blocks: existing.content_blocks,
        translation_meta: existing.translation_meta,
      }
    : {};
  result.body = body;

  // ---- slug (protected: update requires allow_slug_change=true)
  const slugField = parsed.fields.slug;
  if (slugField && typeof slugField.value === 'string' && slugField.value.trim() !== '') {
    if (!existing) {
      body.slug = slugField.value.trim();
      result.applied_fields.push('slug');
    } else if (parsed.header.allow_slug_change) {
      body.slug = slugField.value.trim();
      result.applied_fields.push('slug');
    } else if (slugField.value.trim() !== existing.slug) {
      result.preserved_fields.push('slug');
      result.warnings.push('slug: changing the slug requires allow_slug_change=true — the existing slug was kept');
    }
  }

  // ---- scalar fields
  for (const spec of SCALAR_FIELDS) {
    const pf = parsed.fields[spec.key];
    if (!pf) {
      if (existing && spec.key !== 'brand' && spec.key !== 'catalogs') result.preserved_fields.push(spec.key);
      continue;
    }
    if (spec.key === 'brand' || spec.key === 'catalogs') continue; // handled below via resolved refs
    if (pf.clear) {
      result.cleared_fields.push(spec.key);
    } else {
      result.applied_fields.push(spec.key);
    }
    switch (spec.key) {
      case 'payment_options':
      case 'hashtags':
        body[spec.key] = pf.value ?? [];
        break;
      default:
        body[spec.key] = pf.value;
    }
  }

  // ---- brand / catalogs via resolved refs
  const brandField = parsed.fields.brand;
  if (brandField) {
    if (resolved && resolved.brand_id !== undefined) {
      body.brand_id = resolved.brand_id;
      result.applied_fields.push('brand');
    } else if (!result.needs_review.some((n) => n.key === 'brand')) {
      result.needs_review.push({
        key: 'brand', line: brandField.line, value: String(brandField.value ?? NULL_TOKEN),
        message: 'brand reference was not resolved against the brands table',
      });
    }
  } else if (existing) {
    result.preserved_fields.push('brand');
  }
  const catalogsField = parsed.fields.catalogs;
  if (catalogsField) {
    if (resolved && resolved.catalog_ids !== undefined) {
      result.applied_fields.push('catalogs'); // associations written by the route
    } else if (!result.needs_review.some((n) => n.key === 'catalogs')) {
      result.needs_review.push({
        key: 'catalogs', line: catalogsField.line,
        value: Array.isArray(catalogsField.value) ? (catalogsField.value as string[]).join(',') : String(catalogsField.value ?? NULL_TOKEN),
        message: 'catalog references were not resolved against the catalogs table',
      });
    }
  } else if (existing) {
    result.preserved_fields.push('catalogs');
  }

  // ---- repeatable groups (options first so colors.option_index can resolve)
  const orderedGroups = [...GROUP_SPECS].sort((a, b) => (a.name === 'options' ? -1 : b.name === 'options' ? 1 : 0));
  const optionIndexToId = new Map<number, string>();

  for (const g of orderedGroups) {
    const clear = parsed.groupClears[g.name];
    const templateItems = parsed.groups[g.name] ?? [];
    if (clear) {
      body[g.bodyKey] = [];
      result.cleared_fields.push(g.name);
      if (templateItems.length > 0) {
        result.warnings.push(`${g.name}: both ${g.name}=${CLEAR_TOKEN} and indexed items were given — the group was cleared, items ignored`);
      }
      continue;
    }
    if (templateItems.length === 0) {
      if (existing) result.preserved_fields.push(g.name);
      continue;
    }
    const existingItems = (existing ? (body[g.bodyKey] as LooseItem[]) : []) ?? [];
    const items = buildGroupItems(g, templateItems, existingItems, result);
    if (g.name === 'options') {
      templateItems.forEach((it, i) => {
        const built = items[i];
        if (built && typeof built.id === 'string') optionIndexToId.set(it.index, built.id);
      });
    }
    if (g.name === 'colors') {
      // Resolve import-only option_index references onto option ids.
      templateItems.forEach((it, i) => {
        const pf = it.fields.option_index;
        if (!pf || pf.value === null) return;
        const idx = pf.value as number;
        const target = items[i] as LooseItem | undefined;
        if (!target) return;
        const optId = optionIndexToId.get(idx);
        if (optId) {
          target.option_id = optId;
        } else {
          result.needs_review.push({
            key: `colors.${it.index}.option_index`, line: pf.line, value: String(idx),
            message: `option_index=${idx} does not match any options.${idx}.* item in this template`,
          });
        }
        delete target.option_index;
      });
    }
    body[g.bodyKey] = items;
    result.applied_fields.push(g.name);
  }

  return result;
}

// ---------------------------------------------------------------- translation bookkeeping

/**
 * Deterministic translation bookkeeping for template imports (NO AI):
 * bumps content_rev when the Arabic source text changed and records
 * imported/missing status for the en/ckb name and description fields.
 * Existing meta for unchanged values is preserved.
 */
export function translationBookkeeping(
  body: Record<string, unknown>,
  existing: ProductDoc | null
): { content_rev: number; translation_meta: TranslationMeta } {
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const arChanged =
    !existing ||
    str(body.name_ar) !== existing.name_ar ||
    str(body.description_ar) !== existing.description_ar;
  const contentRev = existing ? (arChanged ? existing.content_rev + 1 : existing.content_rev) : 1;

  const meta: TranslationMeta = { ...(existing?.translation_meta ?? {}) };
  const track = (field: 'name' | 'description') => {
    const entry: TranslationMeta[string] = { ...(meta[field] ?? {}) };
    for (const lang of ['en', 'ckb'] as const) {
      const bodyKey = `${field}_${lang}`;
      const value = str(body[bodyKey]);
      const existingValue = existing ? str((existing as unknown as Record<string, unknown>)[bodyKey]) : '';
      if (value === '') {
        entry[lang] = { status: 'missing', src_rev: contentRev };
      } else if (existing && value === existingValue && entry[lang] && !arChanged) {
        // unchanged translation of unchanged source — keep prior status
      } else if (existing && value === existingValue && entry[lang] && arChanged) {
        entry[lang] = { status: 'stale', src_rev: entry[lang]!.src_rev };
      } else {
        entry[lang] = { status: 'imported', src_rev: contentRev };
      }
    }
    meta[field] = entry;
  };
  track('name');
  track('description');
  return { content_rev: contentRev, translation_meta: meta };
}

// ---------------------------------------------------------------- slug helper

/** Same derivation as the v1 admin editor: latin/arabic word chars, dashes. */
export function deriveSlug(nameOrSlug: string): string {
  return nameOrSlug
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}
