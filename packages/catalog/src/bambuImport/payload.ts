/**
 * THE IMPORT PAYLOAD AND ITS ALLOW-LIST (spec §C.10 layer 2, §A.4 step 1).
 *
 * The runner sends one payload per product to `/stage` and `/write`; the
 * Worker runs the same `assertImportPayload` before anything else. The payload
 * is a CLOSED shape:
 *
 *   - any key the schema does not name is refused, at any depth;
 *   - any key matching FORBIDDEN_KEY (price, cost, stock, discount, currency,
 *     supplier, freight, cbm …) is refused anywhere — `carton.pieces` and
 *     `package.volume_m3` live as spec VALUES, never as keys;
 *   - every customer-facing string the sentence classifier labels money,
 *     promotion, US shipping policy or warranty is refused; owner-only text
 *     (a `visibility: 'owner'` spec row) may carry a withheld warranty
 *     sentence, never money, promotion or policy.
 *
 * The refusal is IMPORT_PAYLOAD_KEY_REFUSED with the JSON path (never the
 * offending text). `buildImportPayload` composes the payload from one page's
 * extraction and the reviewed files, from defaults only: no price, cost,
 * stock, discount or promotion from the source can reach it.
 */
import { H } from './hash';
import { collapseWs, hostOf, keptLinkUrl, stripQuery } from './normalize';
import type { Extraction } from './extract';
import { buildOptions, sourceTextOf, type OptionModel, type ReviewedValueLabel } from './options';
import { describe, parseBoxItem, type Described } from './describe';
import { planMedia, type MediaOverride, type MediaPlan } from './media';
import { buildSpecs, specRowId, variantNoteRows, type SpecResult, type SpecRow } from './specs';
import { buildRelations, compatLabelReviewed, type CompatTargets, type RelationResult } from './relations';
import { classifySentence, scrubProse, type SentenceClass } from './sentences';
import { productTypeOf, type ProductType } from './registry/types';
import { modelsInText } from './registry/models';
import { DOCUMENT_HOSTS, DOCUMENT_TITLES, documentKindOf, type DocumentKind } from './registry/documents';
import { altText, BLOCK_TITLES, tri, type Tri } from './registry/labels';

// ---------------------------------------------------------------- the refusal codes (§C.11)

export const IMPORT_ERROR_MESSAGES: Readonly<Record<string, Tri>> = {
  IMPORT_PAYLOAD_KEY_REFUSED: tri(
    'رُفض حقل غير مسموح في بيانات الاستيراد.',
    'A field that is not allowed was refused in the import data.',
    'خانەیەکی ڕێپێنەدراو لە زانیارییەکانی هاوردەدا ڕەتکرایەوە.'
  ),
  IMPORT_FINANCIAL_WRITE_REFUSED: tri(
    'الاستيراد لا يكتب أي سعر أو تكلفة أو مخزون.',
    'The import never writes a price, cost or stock.',
    'هاوردەکردن هیچ نرخ، تێچوو یان کۆگایەک نانووسێت.'
  ),
  IMPORT_LEASE_LOST: tri(
    'انتهت مهلة هذا المنتج في الاستيراد؛ سيُعاد بأمان.',
    "This product's import lease expired; it will be retried safely.",
    'ماوەی هاوردەکردنی ئەم بەرهەمە تەواو بوو؛ بە سەلامەتی دووبارە دەکرێتەوە.'
  ),
  IMPORT_IDENTITY_AMBIGUOUS: tri(
    'هوية المنتج في المصدر غير مؤكدة، فتوقف الاستيراد عنده.',
    "The product's source identity could not be confirmed; the import stopped at it.",
    'ناسنامەی سەرچاوەی بەرهەمەکە پشتڕاست نەکرایەوە؛ هاوردەکردن لێی ڕاوەستا.'
  ),
  IMPORT_REVIEWED_SCOPE_REFUSED: tri(
    'هذا المنتج أو هذا الدمج غير موجود في القوائم المراجَعة، فلم يُكتب.',
    'This product or merge is not in the reviewed lists, so it was not written.',
    'ئەم بەرهەمە یان ئەم تێکەڵکردنە لە لیستە پێداچوونەوەکراوەکاندا نییە، بۆیە نەنووسرا.'
  ),
  IMPORT_ILLEGAL_TRANSITION: tri(
    'انتقال غير مسموح في حالة الاستيراد؛ لم يتغير شيء.',
    'That import state change is not allowed; nothing changed.',
    'ئەم گۆڕینی دۆخەی هاوردەکردن ڕێگەپێدراو نییە؛ هیچ نەگۆڕا.'
  ),
  IMPORT_STOCK_NOT_CONFIGURED: tri(
    'حدّد طريقة المخزون لهذا المنتج المستورد قبل نشر سعره.',
    "Set this imported product's stock mode before publishing its price.",
    'پێش بڵاوکردنەوەی نرخ، شێوازی کۆگای ئەم بەرهەمە هاوردەکراوە دیاری بکە.'
  ),
  IMPORT_STOCK_TRACKED_EMPTY: tri(
    'لتتبّع الكمية أدخل كمية المخزون أولاً.',
    'To track quantity, enter the stock quantity first.',
    'بۆ بەدواداچوونی بڕ، سەرەتا بڕی کۆگا بنووسە.'
  ),
};

// ---------------------------------------------------------------- the wire shape

export type ScopeKind = 'product' | 'option_value' | 'variant';

export interface PayloadValue {
  id: string;
  source_id: string;
  name_en: string;
  name_ar: string;
  name_ckb: string;
  variant_key: string;
  variant_label: string;
  sort: number;
  colour_code: string;
}
export interface PayloadGroup {
  id: string;
  source_id: string;
  sort: number;
  name_en: string;
  name_ar: string;
  name_ckb: string;
  kind: string;
  source_label: string;
  default_value_id: string;
  values: PayloadValue[];
}
export interface PayloadVariant {
  id: string;
  source_id: string;
  combo_key: string;
  value_ids: string[];
}
export interface PayloadImage {
  id: string;
  source_media_id: string;
  source_url: string;
  sort_order: number;
  is_primary: boolean;
  option_value_id: string | null;
  variant_id: string | null;
  /** A representative row's source variant (media.ts viaVariantId): the client drops the row when it clashes (§G.3, R6). */
  via_variant_id: string | null;
  binding_rule: string;
  alt_en: string;
  alt_ar: string;
  alt_ckb: string;
}
export interface PayloadSwatch {
  value_id: string;
  source_media_id: string;
  source_url: string;
}
export interface PayloadContentBlock {
  id: string;
  kind: 'text' | 'image' | 'video_embed';
  order: number;
  section_kind: string;
  section_path: string;
  title_en: string;
  body_en: string;
  url: string;
  source_media_id: string;
  source_url: string;
  alt_en: string;
  alt_ar: string;
  alt_ckb: string;
}
export interface PayloadBoxItem {
  text: string;
  qty: number | null;
  source_media_id: string;
  source_url: string;
  /** The source's own sub-title over this item ("For Only Laser Module") when it names no option value; else ''. */
  section: string;
}
export interface PayloadSpec {
  id: string;
  key: string;
  group: string;
  scope_kind: ScopeKind;
  scope_id: string;
  region: '' | 'us_110v' | 'intl_220v';
  data_type: string;
  original_label: string;
  original_value: string;
  value_text: string;
  value_num: number | null;
  value_num_max: number | null;
  value_bool: 0 | 1 | null;
  value_list: Array<string | number | PayloadBoxItem>;
  unit: string;
  status: string;
  confidence: string;
  source_kind: string;
  source_title: string;
  source_locator: string;
  source_excerpt: string;
  test_method: string;
  test_condition: string;
  derived_from: string;
  missing_reason: string;
  checked_sources: Array<{ kind: string; url: string; title: string }>;
  visibility: 'public' | 'owner';
  conflict: string;
  sort: number;
}
export interface PayloadDocument {
  id: string;
  kind: DocumentKind;
  title_en: string;
  title_ar: string;
  title_ckb: string;
  url: string;
  host: string;
  scope_kind: ScopeKind;
  scope_id: string;
  language: string;
  sort: number;
}
export interface PayloadRelation {
  id: string;
  scope_kind: ScopeKind;
  scope_id: string;
  relation: string;
  target_kind: string;
  target_product_id: string | null;
  target_source: string;
  target_source_handle: string;
  target_family: string;
  target_label: string;
  state: 'resolved' | 'pending' | 'unresolvable';
  evidence_kind: string;
  evidence_text: string;
}
export interface PayloadExternalId {
  scope_kind: ScopeKind;
  scope_id: string;
  id_type: 'bambu_product_id' | 'bambu_variant_id' | 'bambu_sku_code' | 'color_code' | 'part_code';
  value: string;
  searchable: boolean;
}
export interface PayloadSourceRef {
  kind: 'group' | 'value' | 'variant' | 'image';
  source_id: string;
  levonis_id: string;
  source_label: string;
  binding_rule: string;
  /** product_option_source_refs.via_variant_id: a representative image row's source variant, else ''. */
  via_variant_id: string;
}
export interface PayloadNote {
  kind: string;
  field: string;
}

export interface ImportPayload {
  protocol: 2;
  source: 'bambu_us';
  source_product_id: string;
  handle: string;
  route: string;
  write_mode: 'create' | 'merge';
  /** The deterministic new id (create) or the reviewed Levonis id (merge). */
  product_id: string;
  curated_sha256: string;
  extraction_sha256: string;
  product: {
    title_en: string;
    short_description_en: string;
    variant_mode: 'BASE' | 'VARIANT_COMBINATION';
    usage_steps: Array<{ title_en: string; body_en: string }>;
    usage_official_url: string;
  };
  groups: PayloadGroup[];
  variants: PayloadVariant[];
  images: PayloadImage[];
  swatches: PayloadSwatch[];
  content_blocks: PayloadContentBlock[];
  specs: PayloadSpec[];
  documents: PayloadDocument[];
  relations: PayloadRelation[];
  external_ids: PayloadExternalId[];
  source_refs: PayloadSourceRef[];
  notes: PayloadNote[];
}

// ---------------------------------------------------------------- the closed schema

/** Keys refused anywhere in a payload (§C.10). */
export const FORBIDDEN_KEY =
  /price|cost|stock|inventor|discount|msrp|amount|currency|margin|profit|wallet|coupon|quantity|qty_available|reserved|lot|fifo|supplier|tariff|freight|cbm|landing/i;

/** How a string is checked: customer prose, owner-only prose, or an identifier / URL / enum. */
type TextClass = 'customer' | 'owner' | 'code';

type Field =
  | { t: 'str'; text: TextClass; max?: number; oneOf?: readonly string[]; nullable?: boolean }
  | { t: 'num'; nullable?: boolean; int?: boolean }
  | { t: 'bool' }
  | { t: 'lit'; value: string | number }
  | { t: 'obj'; fields: Readonly<Record<string, Field>>; ownerWhen?: (o: Record<string, unknown>) => boolean }
  | { t: 'arr'; of: Field; max?: number }
  | { t: 'union'; of: readonly Field[] };

const code = (max = 400): Field => ({ t: 'str', text: 'code', max });
const codeN = (max = 400): Field => ({ t: 'str', text: 'code', max, nullable: true });
const cust = (max = 2000): Field => ({ t: 'str', text: 'customer', max });
const own = (max = 2000): Field => ({ t: 'str', text: 'owner', max });
const oneOf = (values: readonly string[]): Field => ({ t: 'str', text: 'code', oneOf: values });
const int: Field = { t: 'num', int: true };
const numN: Field = { t: 'num', nullable: true };
const bool: Field = { t: 'bool' };
const obj = (fields: Record<string, Field>, ownerWhen?: (o: Record<string, unknown>) => boolean): Field => ({ t: 'obj', fields, ownerWhen });
const arr = (of: Field, max = 2000): Field => ({ t: 'arr', of, max });

const SCOPES = ['product', 'option_value', 'variant'] as const;

const BOX_ITEM = obj({ text: cust(300), qty: { t: 'num', nullable: true, int: true }, source_media_id: code(200), source_url: code(1000), section: cust(200) });

const SPEC = obj(
  {
    id: code(40),
    key: code(80),
    group: code(40),
    scope_kind: oneOf(SCOPES),
    scope_id: code(40),
    region: oneOf(['', 'us_110v', 'intl_220v']),
    data_type: oneOf(['string', 'number', 'boolean', 'enum', 'range', 'list', 'date', 'object']),
    original_label: cust(300),
    original_value: cust(1000),
    value_text: cust(2000),
    value_num: numN,
    value_num_max: numN,
    value_bool: { t: 'num', nullable: true, int: true },
    value_list: arr({ t: 'union', of: [cust(500), { t: 'num' }, BOX_ITEM] }, 200),
    unit: code(20),
    status: oneOf(['verified', 'unverified', 'not_found', 'not_published', 'not_applicable', 'unknown']),
    confidence: oneOf(['official_variant', 'official_doc', 'official_page', 'component_maker', 'independent', 'derived']),
    source_kind: oneOf(['store_page', 'store_messages', 'store_doc', 'tds', 'sds', 'manual', 'wiki', 'curated', 'derived']),
    source_title: cust(200),
    source_locator: code(200),
    source_excerpt: cust(200),
    test_method: cust(300),
    test_condition: cust(300),
    derived_from: code(300),
    missing_reason: oneOf(['', 'not_found_in_checked_sources', 'not_published_by_manufacturer', 'not_applicable']),
    checked_sources: arr(obj({ kind: code(40), url: code(1000), title: cust(200) }), 20),
    visibility: oneOf(['public', 'owner']),
    conflict: own(300),
    sort: int,
  },
  (o) => o.visibility === 'owner'
);

export const PAYLOAD_SCHEMA: Field = obj({
  protocol: { t: 'lit', value: 2 },
  source: { t: 'lit', value: 'bambu_us' },
  source_product_id: code(40),
  handle: code(300),
  route: code(200),
  write_mode: oneOf(['create', 'merge']),
  product_id: code(80),
  curated_sha256: code(64),
  extraction_sha256: code(64),
  product: obj({
    title_en: cust(300),
    short_description_en: cust(2000),
    variant_mode: oneOf(['BASE', 'VARIANT_COMBINATION']),
    usage_steps: arr(obj({ title_en: cust(300), body_en: cust(4000) }), 40),
    usage_official_url: code(1000),
  }),
  groups: arr(
    obj({
      id: code(40),
      source_id: code(40),
      sort: int,
      name_en: cust(80),
      name_ar: cust(80),
      name_ckb: cust(80),
      kind: oneOf(['', 'color', 'spool', 'printer', 'version', 'size', 'nozzle', 'plate', 'units', 'pack', 'item', 'other']),
      source_label: cust(200),
      default_value_id: code(40),
      values: arr(
        obj({
          id: code(40),
          source_id: code(40),
          name_en: cust(200),
          name_ar: cust(200),
          name_ckb: cust(200),
          variant_key: code(60),
          variant_label: cust(200),
          sort: int,
          colour_code: code(20),
        }),
        500
      ),
    }),
    20
  ),
  variants: arr(obj({ id: code(40), source_id: code(40), combo_key: code(2000), value_ids: arr(code(40), 20) }), 2000),
  images: arr(
    obj({
      id: code(40),
      source_media_id: code(200),
      source_url: code(1000),
      sort_order: int,
      is_primary: bool,
      option_value_id: codeN(40),
      variant_id: codeN(40),
      via_variant_id: codeN(40),
      binding_rule: oneOf(['general', 'value', 'value_set', 'variant', 'representative', 'content_duplicate', 'reviewed_override']),
      alt_en: cust(300),
      alt_ar: cust(300),
      alt_ckb: cust(300),
    }),
    2000
  ),
  swatches: arr(obj({ value_id: code(40), source_media_id: code(200), source_url: code(1000) }), 500),
  content_blocks: arr(
    obj({
      id: code(40),
      kind: oneOf(['text', 'image', 'video_embed']),
      order: int,
      section_kind: code(40),
      section_path: code(200),
      title_en: cust(300),
      body_en: cust(20000),
      url: code(1000),
      source_media_id: code(200),
      source_url: code(1000),
      alt_en: cust(300),
      alt_ar: cust(300),
      alt_ckb: cust(300),
    }),
    200
  ),
  specs: arr(SPEC, 3000),
  documents: arr(
    obj({
      id: code(40),
      kind: oneOf(Object.keys(DOCUMENT_TITLES)),
      title_en: cust(300),
      title_ar: cust(300),
      title_ckb: cust(300),
      url: code(1000),
      host: code(100),
      scope_kind: oneOf(SCOPES),
      scope_id: code(40),
      language: code(10),
      sort: int,
    }),
    200
  ),
  relations: arr(
    obj({
      id: code(40),
      scope_kind: oneOf(SCOPES),
      scope_id: code(40),
      relation: oneOf(['compatible_with', 'not_compatible_with', 'requires', 'recommended_with', 'related', 'replacement_for', 'included_in', 'includes']),
      target_kind: oneOf(['printer', 'ams', 'hub', 'buffer', 'laser_module', 'toolhead', 'spool', 'family', 'part', 'material', 'other']),
      target_product_id: codeN(80),
      target_source: oneOf(['', 'bambu_us']),
      target_source_handle: code(300),
      target_family: code(80),
      target_label: cust(200),
      state: oneOf(['resolved', 'pending', 'unresolvable']),
      evidence_kind: oneOf(['option_value', 'compat_section', 'spec_row', 'feature_bullet', 'description_text', 'wiki_table', 'manual', 'curated']),
      evidence_text: cust(300),
    }),
    2000
  ),
  external_ids: arr(
    obj({
      scope_kind: oneOf(SCOPES),
      scope_id: code(40),
      id_type: oneOf(['bambu_product_id', 'bambu_variant_id', 'bambu_sku_code', 'color_code', 'part_code']),
      value: code(120),
      searchable: bool,
    }),
    4000
  ),
  source_refs: arr(
    obj({
      kind: oneOf(['group', 'value', 'variant', 'image']),
      source_id: code(200),
      levonis_id: code(40),
      source_label: cust(200),
      binding_rule: oneOf(['', 'general', 'value', 'value_set', 'variant', 'representative', 'content_duplicate', 'reviewed_override']),
      via_variant_id: code(40),
    }),
    6000
  ),
  notes: arr(obj({ kind: code(40), field: code(120) }), 2000),
});

/** Every key the schema names, at any depth (the test proves none matches FORBIDDEN_KEY). */
export function schemaKeys(f: Field = PAYLOAD_SCHEMA, out = new Set<string>()): Set<string> {
  if (f.t === 'obj') for (const [k, v] of Object.entries(f.fields)) {
    out.add(k);
    schemaKeys(v, out);
  }
  else if (f.t === 'arr') schemaKeys(f.of, out);
  else if (f.t === 'union') for (const x of f.of) schemaKeys(x, out);
  return out;
}

// ---------------------------------------------------------------- the validator

export type RefusalReason = 'forbidden_key' | 'unknown_key' | 'missing_key' | 'wrong_type' | 'too_long' | 'not_allowed_value' | 'refused_text';

export class ImportPayloadRefused extends Error {
  readonly code = 'IMPORT_PAYLOAD_KEY_REFUSED';
  readonly status = 400;
  constructor(
    readonly path: string,
    readonly reason: RefusalReason,
    /** For refused_text: the classifier's class (never the text). */
    readonly textClass: SentenceClass | '' = ''
  ) {
    super(`${IMPORT_ERROR_MESSAGES.IMPORT_PAYLOAD_KEY_REFUSED.en} (${reason} at ${path})`);
    this.name = 'ImportPayloadRefused';
  }
}

const REFUSED_FOR: Readonly<Record<TextClass, ReadonlySet<SentenceClass>>> = {
  customer: new Set(['money', 'promotion', 'shipping_policy', 'warranty']),
  owner: new Set(['money', 'promotion', 'shipping_policy']),
  code: new Set(),
};

function textRefusal(s: string, cls: TextClass): SentenceClass | null {
  const refused = REFUSED_FOR[cls];
  if (!refused.size || !s) return null;
  // Sentence by sentence: a refused sentence inside a long text is found on its own.
  for (const line of s.split(/\n+/)) {
    for (const part of line.split(/(?<=[.!?。])\s+/)) {
      const c = classifySentence(part);
      if (refused.has(c)) return c;
    }
  }
  return null;
}

function check(v: unknown, f: Field, path: string, ownerScope: boolean): void {
  switch (f.t) {
    case 'lit':
      if (v !== f.value) throw new ImportPayloadRefused(path, 'not_allowed_value');
      return;
    case 'str': {
      if (v === null && f.nullable) return;
      if (typeof v !== 'string') throw new ImportPayloadRefused(path, 'wrong_type');
      if (f.max !== undefined && v.length > f.max) throw new ImportPayloadRefused(path, 'too_long');
      if (f.oneOf && !f.oneOf.includes(v)) throw new ImportPayloadRefused(path, 'not_allowed_value');
      const cls: TextClass = f.text === 'customer' && ownerScope ? 'owner' : f.text;
      const refused = textRefusal(v, cls);
      if (refused) throw new ImportPayloadRefused(path, 'refused_text', refused);
      return;
    }
    case 'num':
      if (v === null && f.nullable) return;
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new ImportPayloadRefused(path, 'wrong_type');
      if (f.int && !Number.isInteger(v)) throw new ImportPayloadRefused(path, 'wrong_type');
      return;
    case 'bool':
      if (typeof v !== 'boolean') throw new ImportPayloadRefused(path, 'wrong_type');
      return;
    case 'arr':
      if (!Array.isArray(v)) throw new ImportPayloadRefused(path, 'wrong_type');
      if (f.max !== undefined && v.length > f.max) throw new ImportPayloadRefused(path, 'too_long');
      v.forEach((x, i) => check(x, f.of, `${path}[${i}]`, ownerScope));
      return;
    case 'union': {
      // Keys are checked first, so a forbidden key inside any alternative is reported as such.
      forbiddenKeys(v, path);
      let last: ImportPayloadRefused | null = null;
      for (const alt of f.of) {
        try {
          check(v, alt, path, ownerScope);
          return;
        } catch (e) {
          if (!(e instanceof ImportPayloadRefused)) throw e;
          if (e.reason === 'refused_text') throw e;
          last = e;
        }
      }
      throw last ?? new ImportPayloadRefused(path, 'wrong_type');
    }
    case 'obj': {
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ImportPayloadRefused(path, 'wrong_type');
      const o = v as Record<string, unknown>;
      for (const k of Object.keys(o)) {
        if (FORBIDDEN_KEY.test(k)) throw new ImportPayloadRefused(`${path}.${k}`, 'forbidden_key');
      }
      for (const k of Object.keys(o)) {
        if (!Object.prototype.hasOwnProperty.call(f.fields, k)) throw new ImportPayloadRefused(`${path}.${k}`, 'unknown_key');
      }
      const owner = ownerScope || (f.ownerWhen ? f.ownerWhen(o) : false);
      for (const [k, sub] of Object.entries(f.fields)) {
        if (!Object.prototype.hasOwnProperty.call(o, k)) throw new ImportPayloadRefused(`${path}.${k}`, 'missing_key');
        check(o[k], sub, `${path}.${k}`, owner);
      }
      return;
    }
  }
}

/** Refuses a forbidden key anywhere under a value (used before trying union alternatives). */
function forbiddenKeys(v: unknown, path: string): void {
  if (Array.isArray(v)) v.forEach((x, i) => forbiddenKeys(x, `${path}[${i}]`));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (FORBIDDEN_KEY.test(k)) throw new ImportPayloadRefused(`${path}.${k}`, 'forbidden_key');
      forbiddenKeys(x, `${path}.${k}`);
    }
  }
}

/**
 * The allow-list validator. Throws ImportPayloadRefused (IMPORT_PAYLOAD_KEY_REFUSED,
 * 400) with the JSON path of the first refusal; returns the payload typed.
 */
export function assertImportPayload(payload: unknown): ImportPayload {
  forbiddenKeys(payload, '$');
  check(payload, PAYLOAD_SCHEMA, '$', false);
  return payload as ImportPayload;
}

// ---------------------------------------------------------------- the builder

export interface IdentityEntry {
  model?: string;
  series?: string;
  family?: string;
}

/**
 * The fields of one manifest row (data/bambu-import/manifest.json `rows[]`)
 * the builder reads. The runner (step 8) and the writer (step 6) pass the row
 * exactly as the reviewed file holds it; every other field (queue position,
 * leaf, curated flag, plan estimate, a label's evidence …) is review data the
 * builder ignores.
 */
export interface ManifestRowInput {
  source_product_id: string;
  handle: string;
  /** Frozen SKU codes (§C.1): source variant id → code. */
  sku_codes?: Readonly<Record<string, string>> | null;
  /** Reviewed display labels (owner-questions §E.1, P0-11): source value id → label. */
  value_labels?: Readonly<Record<string, ReviewedValueLabel>> | null;
}

export interface BuildInputs {
  extraction: Extraction;
  writeMode: 'create' | 'merge';
  /** The reviewed Levonis id for a merge; a create uses the deterministic new id. */
  mergeProductId?: string;
  curatedSha256?: string;
  extractionSha256: string;
  /**
   * The product's manifest row. It must name this page's product (its
   * `source_product_id` and `handle`), or the build reports
   * IDENTITY_AMBIGUOUS and applies none of it.
   */
  manifestRow?: ManifestRowInput | null;
  /** The frozen SKU codes for a caller without a manifest row (tests); ignored when `manifestRow` is given. */
  skuCodes?: Readonly<Record<string, string>>;
  identity?: IdentityEntry | null;
  targets: CompatTargets | null;
  overrides?: readonly MediaOverride[];
  contentKey?: (resourceFileId: string) => string | undefined;
  retrievedAt: string;
}

export interface BuildReport {
  productType: ProductType;
  format: Described['format'];
  counts: Record<string, number>;
  specsByStatus: Record<string, number>;
  specsByRegion: Record<string, number>;
  relationsByState: Record<string, number>;
  sentenceCounts: Record<string, number>;
  /** Hard problems (the item cannot be written as it is) and the manifest hold code. */
  errors: string[];
  hold: string;
  unknownLabels: string[];
  soldOutCount: number;
}

export interface BuildResult {
  payload: ImportPayload;
  model: OptionModel;
  media: MediaPlan;
  described: Described;
  specs: SpecResult;
  relations: RelationResult;
  report: BuildReport;
}

/** At most 40 description images and 30 in-the-box images per product (§1 row 14, §C.5). */
export const CONTENT_IMAGE_CAP = 40;
export const BOX_IMAGE_CAP = 30;

const NEW_PRODUCT_PREFIX = 'p_';
const GENERIC_LINK_TEXT = /^(?:here|click here|this|link|this link|wiki|wiki link|wiki page|page|learn more|more|read more|video|download|details|view|see more)?$/i;
const YOUTUBE = /^https:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,20})/i;

const httpsOf = (url: string) => (url.startsWith('//') ? `https:${url}` : url.replace(/^http:\/\//i, 'https://'));
const mediaIdOf = (prefix: string, url: string) => `${prefix}:${H(stripQuery(url))}`;

function tally<T>(xs: readonly T[], key: (x: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[key(x)] = (out[key(x)] ?? 0) + 1;
  return out;
}

/** A table header that names money: "Price", "Cost", "MSRP" (optionally "Unit price", "Price (USD)"). */
const MONEY_HEADER = /^\s*(?:(?:unit|retail|list|sale|regular|reference)\s+)?(?:prices?|costs?|msrp|rrp)\s*(?:\([^)]*\))?\s*:?\s*$/i;

/**
 * A comparison table without its money: a column headed "Price" (or a row labelled so) never reaches a
 * customer, whatever its cells say. The bearing pages' "Comparison of Bearing Materials" grades each
 * material "Very affordable" … "Expensive"; the sentence classifier blanks those cells one by one, and
 * this drops the column itself, so no empty "Price" column is left behind.
 */
export function withoutMoneyColumns(rows: readonly string[][]): string[][] {
  const head = rows[0] ?? [];
  const drop = new Set<number>();
  head.forEach((c, i) => {
    if (i > 0 && MONEY_HEADER.test(c)) drop.add(i); // a column headed "Price"
  });
  return rows.filter((r) => !MONEY_HEADER.test(r[0] ?? '')).map((r) => r.filter((_, i) => !drop.has(i))); // and a row labelled so
}

/** The YouTube embed URL of a link, or '' (only YouTube is embedded, §C.5). */
export function youtubeEmbed(url: string): string {
  const m = YOUTUBE.exec(httpsOf(url.trim()));
  return m ? `https://www.youtube.com/embed/${m[1]}` : '';
}

function toPayloadSpec(r: SpecRow): PayloadSpec {
  const text = r.valueText.length > 2000 ? `${r.valueText.slice(0, 1999)}…` : r.valueText;
  return {
    id: r.id,
    key: r.key,
    group: r.group,
    scope_kind: r.scopeKind,
    scope_id: r.scopeId,
    region: r.region,
    data_type: r.dataType,
    original_label: r.originalLabel,
    original_value: r.originalValue,
    value_text: text,
    value_num: r.valueNum,
    value_num_max: r.valueNumMax,
    value_bool: r.valueBool,
    value_list: r.valueList as PayloadSpec['value_list'],
    unit: r.unit,
    status: r.status,
    confidence: r.confidence,
    source_kind: r.sourceKind,
    source_title: r.sourceTitle,
    source_locator: r.sourceLocator,
    source_excerpt: r.sourceExcerpt,
    test_method: r.testMethod,
    test_condition: r.testCondition,
    derived_from: r.derivedFrom,
    missing_reason: r.missingReason,
    checked_sources: r.checkedSources,
    visibility: r.visibility,
    conflict: r.conflict,
    sort: r.sort,
  };
}

/** Composes one product's payload from its extraction and the reviewed files. */
export function buildImportPayload(inp: BuildInputs): BuildResult {
  const x = inp.extraction;
  const newId = `${NEW_PRODUCT_PREFIX}${H(`bambu_us:product:${x.sourceProductId}`)}`;
  const productId = inp.writeMode === 'merge' && inp.mergeProductId ? inp.mergeProductId : newId;
  const productType = productTypeOf(x.route);
  // The manifest row applies only to the product it names (§B.5 IDENTITY_AMBIGUOUS otherwise).
  const row = inp.manifestRow ?? null;
  const rowMismatch = !!row && (String(row.source_product_id) !== x.sourceProductId || row.handle !== x.handle);
  const rowOk = row && !rowMismatch ? row : null;
  const skuCodes = row ? (rowOk?.sku_codes ?? {}) : (inp.skuCodes ?? {});
  const model = buildOptions(x, productId, {
    valueLabels: rowOk?.value_labels ?? null,
    isReviewedTarget: inp.targets ? (label: string) => compatLabelReviewed(inp.targets, label) : null,
  });
  if (rowMismatch) model.errors.push({ code: 'IDENTITY_AMBIGUOUS', detail: 'the manifest row names another product' });
  const described = describe(x.description);
  const modelToken = modelsInText(x.title)[0]?.token ?? '';
  const ctx = { productId, productType, canonicalUrl: x.canonicalUrl, retrievedAt: inp.retrievedAt, model, modelToken };
  const specs = buildSpecs({ described, features: x.features, featuresTitle: x.featuresTitle }, ctx);
  const media = planMedia({ productId, title: x.title, gallery: x.gallery, model, contentKey: inp.contentKey, overrides: inp.overrides });
  const notes: PayloadNote[] = [];
  const sentenceCounts: Record<string, number> = { money: 0, promotion: 0, shipping_policy: 0, warranty: 0, region: 0 };
  const withheld: string[] = [];
  const scrub = (text: string): string => {
    const r = scrubProse(text);
    for (const [k, n] of Object.entries(r.counts)) sentenceCounts[k] += n;
    withheld.push(...r.withheld);
    return r.kept;
  };

  // Extra spec rows: identity, variant notes, in the box, compatibility statement, warranty notes.
  const extra: SpecRow[] = [];
  const specBase = (key: string, init: Partial<SpecRow>): SpecRow => ({
    id: '',
    key,
    group: key.split('.')[0],
    scopeKind: 'product',
    scopeId: '',
    region: '',
    dataType: 'string',
    originalLabel: '',
    originalValue: '',
    valueText: '',
    valueNum: null,
    valueNumMax: null,
    valueBool: null,
    valueList: [],
    unit: '',
    status: 'verified',
    confidence: 'official_page',
    sourceKind: 'store_page',
    sourceRef: x.canonicalUrl,
    sourceTitle: 'Bambu Lab US store product page',
    sourceLocator: '',
    sourceExcerpt: '',
    testMethod: '',
    testCondition: '',
    derivedFrom: '',
    missingReason: '',
    checkedSources: [],
    visibility: 'public',
    conflict: '',
    sort: 0,
    ...init,
  });
  for (const k of ['model', 'series', 'family'] as const) {
    const v = inp.identity?.[k];
    if (v) extra.push(specBase(`identity.${k}`, { valueText: v, originalValue: v, sourceLocator: cutTo(`route ${x.route}`, 200) }));
  }
  const notesOfVariants = variantNoteRows(ctx);
  for (const r of notesOfVariants.rows) {
    r.valueText = scrub(r.valueText);
    r.sourceExcerpt = r.valueText.slice(0, 200);
    r.originalValue = r.valueText;
    if (r.valueText) extra.push(r);
  }
  withheld.push(...notesOfVariants.withheld);

  // In the box: box items (with images), plain lists; a section titled by a value scopes its items.
  const boxByScope = new Map<string, { items: PayloadBoxItem[]; locator: string; label: string }>();
  let boxImages = 0;
  const valueNamed = (title: string): string => {
    const t = title.toLowerCase();
    for (const g of model.groups) {
      for (const v of g.values) {
        const name = sourceTextOf(v);
        if (name && t.includes(name.toLowerCase()) && /add-?ons?|combo|bundle/i.test(title)) return v.id;
      }
    }
    return '';
  };
  // The page's own words name values: every match below reads a value's source text, never a reviewed label (§E.1).
  const versionWords = new Set(model.groups.flatMap((g) => g.values.map((v) => sourceTextOf(v).toLowerCase())));
  // A format-E item lists the versions it ships with: each names a value (exactly, case-insensitive).
  const valueByName = new Map<string, string>();
  for (const g of model.groups) for (const v of g.values) valueByName.set(sourceTextOf(v).trim().toLowerCase(), v.id);
  /**
   * A line "For H2D/H2C" (or "For LightGrip Cutting Mat:") heads the items after it (review 4, finding 10):
   * they belong to the value(s) it names, and the line is no item. A short line naming no value is a
   * sub-title of the items after it (`section`), never an item.
   *
   * Naming, in this order: the whole name (without a parenthetical or a leading "For"); else the values
   * that name EVERY part of it ("For A2L/X2D/P2S/P1 Series/X1 Series" is the value "A2L/X2D/P2S/P1/X1",
   * not also "H2 Series/P1 Series/X1 Series", which shares two of its parts; "For H2D" is "H2D and H2D
   * Laser"); else, part by part, the values naming each ("For H2D/H2C" over the values H2D and H2C).
   * A word such as "Series" never decides it.
   */
  const normName = (n: string) =>
    n.toLowerCase().replace(/[(（][^)）]*[)）]/g, ' ').replace(/^\s*for\s+/, '').replace(/\s+/g, ' ').trim();
  const partsOf = (n: string) =>
    normName(n)
      .split(/\s*(?:\/|,|&|\+|\band\b)\s*/)
      .map((p) => p.replace(/\b(?:series|printers?)\b/g, ' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  const allValues = model.groups.flatMap((g) => g.values);
  const valuesNamedBy = (named: string): string[] => {
    const want = normName(named);
    if (!want) return [];
    const exact = allValues.filter((v) => normName(sourceTextOf(v)) === want);
    if (exact.length) return exact.map((v) => v.id);
    const parts = partsOf(named);
    if (!parts.length) return [];
    const covering = allValues.filter((v) => {
      const own = new Set(partsOf(sourceTextOf(v)));
      return parts.every((p) => own.has(p));
    });
    if (covering.length) return covering.map((v) => v.id);
    const ids = new Set<string>();
    for (const part of parts) {
      const naming = allValues.filter((v) => partsOf(sourceTextOf(v)).includes(part));
      if (!naming.length) return [];
      for (const v of naming) ids.add(v.id);
    }
    return [...ids];
  };
  const HEADER = /^for\s+(.+?)\s*:?\s*$/i;
  const headerOf = (text: string, qty: number | null, image: string | null): { scopes: string[]; title: string } | null => {
    if (qty !== null || image) return null;
    // Not `scrub`: a line that turns out to be an item is scrubbed (and counted) once, by `take`.
    const m = HEADER.exec(collapseWs(scrubProse(text).kept));
    if (!m) return null;
    const scopes = valuesNamedBy(m[1]);
    if (scopes.length) return { scopes, title: '' };
    // Unresolved: only a short label, not a sentence ("For best results, …" stays an item).
    return m[1].length <= 60 && !/[.,;!?]/.test(m[1]) ? { scopes: [], title: m[1] } : null;
  };
  for (const sec of described.sections) {
    if (sec.kind !== 'in_the_box') continue;
    const sectionScope = valueNamed(sec.title);
    const slotOf = (scope: string) => {
      const slot = boxByScope.get(scope) ?? { items: [], locator: `${sec.title || 'In the box'} › ${sec.path}`, label: sec.title || 'In the box' };
      boxByScope.set(scope, slot);
      return slot;
    };
    let headerScopes: string[] | null = null;
    let heading = '';
    const take = (text: string, qty: number | null, image: string | null, itemScopes?: string[]) => {
      const header = itemScopes?.length ? null : headerOf(text, qty, image);
      if (header) {
        headerScopes = header.scopes.length ? header.scopes : null;
        heading = header.title;
        return;
      }
      const named = itemScopes?.length ? itemScopes.map((n) => valueByName.get(n.trim().toLowerCase()) ?? '') : headerScopes ?? [sectionScope];
      const targets = named.includes('') ? [sectionScope] : named;
      const t = collapseWs(scrub(text));
      // A bare value name is a label, not an item; with a count it is the item itself
      // ("For LightGrip Cutting Mat:" then "LightGrip Cutting Mat*3", cutting-mat-combo-3-pcs).
      if (!t || (qty === null && versionWords.has(t.toLowerCase())) || /depending on (the )?selected/i.test(t)) return;
      let mid = '';
      let src = '';
      if (image && boxImages < BOX_IMAGE_CAP) {
        src = httpsOf(stripQuery(image));
        mid = mediaIdOf('box', src);
        boxImages++;
      }
      for (const scope of targets) slotOf(scope).items.push({ text: t.slice(0, 300), qty, source_media_id: mid, source_url: src, section: heading.slice(0, 200) });
    };
    for (const b of sec.blocks) {
      if (b.t === 'box_item') take(b.text, b.qty, b.image, b.scopes);
      else if (b.t === 'list') for (const i of b.items) {
        const p = parseBoxItem(i);
        take(p.text, p.qty, null);
      }
      else if (b.t === 'text') for (const line of b.text.split(/\n+/)) {
        const p = parseBoxItem(line);
        if (p.text && p.text.length <= 120) take(p.text, p.qty, null);
      }
    }
  }
  for (const [scope, slot] of [...boxByScope]) if (!slot.items.length) boxByScope.delete(scope);
  for (const [scope, slot] of boxByScope) {
    extra.push(
      specBase('package.contents', {
        group: 'contents',
        dataType: 'list',
        scopeKind: scope ? 'option_value' : 'product',
        scopeId: scope,
        valueList: slot.items,
        valueText: slot.items.map((i) => (i.qty && i.qty > 1 ? `${i.text} ×${i.qty}` : i.text)).join('\n'),
        originalLabel: slot.label,
        sourceLocator: cutTo(slot.locator, 200),
        status: 'verified',
      })
    );
  }
  // The compatibility section's own published sentences.
  const compatTexts: string[] = [];
  for (const sec of described.sections) {
    if (sec.kind !== 'compat') continue;
    for (const b of sec.blocks) if (b.t === 'text') compatTexts.push(scrub(b.text));
  }
  const compatStatement = collapseWs(compatTexts.filter(Boolean).join('\n')).slice(0, 2000);
  if (compatStatement) extra.push(specBase('compat.statement', { group: 'compat', valueText: compatStatement, originalValue: compatStatement.slice(0, 1000), sourceLocator: 'compatibility section', status: 'unverified' }));

  // Relations (after the compatibility statement exists).
  const relations = buildRelations({
    productId,
    handle: x.handle,
    model,
    described,
    relationBullets: specs.relationBullets,
    variantNotes: model.variants.filter((v) => v.note).map((v) => ({ variantId: v.id, html: v.note })),
    compatStatements: compatStatement ? [{ text: compatStatement, locator: 'compatibility section' }] : [],
    targets: inp.targets,
  });

  // Content blocks.
  const blocks: PayloadContentBlock[] = [];
  let order = 0;
  let contentImages = 0;
  let contentImagesOmitted = 0;
  const seenImages = new Set<string>();
  const block = (b: Partial<PayloadContentBlock> & Pick<PayloadContentBlock, 'kind' | 'section_kind' | 'section_path'>) => {
    const full: PayloadContentBlock = { id: '', order: order++, title_en: '', body_en: '', url: '', source_media_id: '', source_url: '', alt_en: '', alt_ar: '', alt_ckb: '', ...b };
    full.id = `cb_${H(`${productId}:${full.section_path}:${full.order}`)}`;
    blocks.push(full);
  };
  const shortDescription = scrub(x.seoMetaDescription);
  const usageSteps: Array<{ title_en: string; body_en: string }> = [];
  // Specification sections become spec rows only (§C.5): their leftover labels ("Download A1 TDS") are not prose.
  const PROSE_KINDS = new Set(['overview', 'features', 'warning', 'comparison', 'other']);
  for (const sec of described.sections) {
    if (sec.kind === 'in_the_box' || sec.kind === 'compat') continue;
    if (sec.kind === 'instructions') {
      const body = scrub(sec.blocks.map((b) => (b.t === 'text' ? b.text : b.t === 'list' ? b.items.join('\n') : '')).filter(Boolean).join('\n'));
      if (sec.title || body) usageSteps.push({ title_en: (scrub(sec.title) || 'Step').slice(0, 300), body_en: body.slice(0, 4000) });
      continue;
    }
    if (sec.kind === 'faq') {
      const qa = sec.blocks.filter((b): b is Extract<typeof b, { t: 'faq' }> => b.t === 'faq');
      const body = qa.map((q) => `${scrub(q.question)}\n${scrub(q.answer)}`.trim()).filter(Boolean).join('\n\n');
      if (body) block({ kind: 'text', section_kind: 'faq', section_path: sec.path, title_en: BLOCK_TITLES.faq.en, body_en: body.slice(0, 20000) });
      continue;
    }
    if (!PROSE_KINDS.has(sec.kind)) continue;
    const parts: string[] = [];
    // A section title is customer prose too ("… for an exclusive bundle discount"): a refused title is dropped.
    const sectionTitle = scrub(sec.title).slice(0, 300);
    const flush = () => {
      const body = parts.join('\n').trim();
      parts.length = 0;
      if (body) block({ kind: 'text', section_kind: sec.kind, section_path: sec.path, title_en: sectionTitle, body_en: body.slice(0, 20000) });
    };
    for (const b of sec.blocks) {
      if (b.t === 'text') {
        const t = scrub(b.text);
        if (t && t !== sec.title && t !== sectionTitle) parts.push(t);
      } else if (b.t === 'list') {
        const items = b.items.map((i) => scrub(i)).filter(Boolean);
        if (items.length) parts.push(items.map((i) => `• ${i}`).join('\n'));
      } else if (b.t === 'table' && sec.kind !== 'specs') {
        const rows = withoutMoneyColumns(b.grid.rows)
          .map((r) => r.map((c) => collapseWs(scrub(c))).join(' | '))
          .filter((r) => r.replace(/[\s|]/g, ''));
        if (rows.length) parts.push(rows.join('\n'));
      } else if (b.t === 'image') {
        const url = httpsOf(stripQuery(b.url));
        if (!url || seenImages.has(url)) continue;
        seenImages.add(url);
        if (contentImages >= CONTENT_IMAGE_CAP) {
          contentImagesOmitted++;
          continue;
        }
        flush();
        contentImages++;
        const alt = altText(x.title);
        block({ kind: 'image', section_kind: sec.kind, section_path: sec.path, source_media_id: mediaIdOf('content', url), source_url: url, alt_en: alt.en, alt_ar: alt.ar, alt_ckb: alt.ckb });
      } else if (b.t === 'video') {
        const embed = youtubeEmbed(b.url);
        if (embed) {
          flush();
          block({ kind: 'video_embed', section_kind: sec.kind, section_path: sec.path, url: embed });
        }
      }
    }
    flush();
  }
  // Feature bullets that are neither specs nor relation evidence: one "Highlights" block.
  const highlights = specs.highlights.map((h) => scrub(h)).filter(Boolean);
  if (highlights.length) block({ kind: 'text', section_kind: 'features', section_path: 'P.productFeaturesModuleList', title_en: BLOCK_TITLES.highlights.en, body_en: highlights.map((h) => `• ${h}`).join('\n').slice(0, 20000) });
  for (const v of x.videos) {
    const embed = youtubeEmbed(v);
    if (embed && !blocks.some((b) => b.url === embed)) block({ kind: 'video_embed', section_kind: 'overview', section_path: 'P.externalVideoLinkList', url: embed });
  }

  // Documents.
  const documents: PayloadDocument[] = [];
  const docSeen = new Set<string>();
  let usageOfficialUrl = '';
  const addDoc = (rawUrl: string, text: string) => {
    const url = httpsOf(keptLinkUrl(rawUrl.trim()));
    const host = hostOf(url);
    if (!url.startsWith('https://') || !DOCUMENT_HOSTS.has(host)) return;
    const kind = host.endsWith('youtube.com') || host === 'youtu.be' ? 'video' : documentKindOf(text, url);
    const scopeKind: ScopeKind = 'product';
    const id = `pd_${H(`${productId}${url}${scopeKind}`)}`;
    if (docSeen.has(id)) return;
    docSeen.add(id);
    const reg = DOCUMENT_TITLES[kind];
    // A generic link text ("here.", "wiki link", "Learn More") is not a title: the registry title stands alone.
    const linkText = collapseWs(scrub(text)).replace(/[\s,.;:!]+$/, '').slice(0, 200);
    const sourceTitle = GENERIC_LINK_TEXT.test(linkText) ? '' : linkText;
    const en = sourceTitle || reg.en;
    const tail = sourceTitle && sourceTitle !== reg.en ? ` — ${sourceTitle}` : '';
    documents.push({ id, kind, title_en: en, title_ar: `${reg.ar}${tail}`.slice(0, 300), title_ckb: `${reg.ckb}${tail}`.slice(0, 300), url, host, scope_kind: scopeKind, scope_id: '', language: 'en', sort: documents.length });
    if (kind === 'wiki' && !usageOfficialUrl) usageOfficialUrl = url;
  };
  for (const d of described.documents) addDoc(d.url, d.text);
  for (const d of described.wikiLinks) addDoc(d.url, d.text);
  for (const d of described.videos) addDoc(d.url, d.text || 'Video');
  for (const v of x.videos) addDoc(v, 'Video');
  for (const d of described.otherLinks) if (hostOf(httpsOf(d.url)) === 'makerworld.com') addDoc(d.url, d.text);
  // Tracker links resolve in ENRICH (one HEAD, allow-listed hosts only); until then each is a tracker_unresolved note.
  for (let i = 0; i < described.trackerLinks.length; i++) notes.push({ kind: 'tracker_unresolved', field: 'documents' });

  // Warranty sentences: withheld from customers, kept owner-only (L-19).
  const warranty = [...new Set(withheld.map((w) => collapseWs(w)).filter(Boolean))];
  if (warranty.length) {
    extra.push(
      specBase('manufacturer_terms.warranty_note', {
        dataType: 'list',
        valueList: warranty.map((w) => w.slice(0, 500)),
        valueText: warranty.join('\n').slice(0, 2000),
        visibility: 'owner',
        status: 'unverified',
        sourceLocator: 'description sentences (withheld)',
      })
    );
    for (let i = 0; i < warranty.length; i++) notes.push({ kind: 'sentence_withheld', field: 'manufacturer_terms.warranty_note' });
  }

  // All spec rows, with ids; scrub customer-facing text of public rows once more (variant notes and tables).
  const allSpecs: SpecRow[] = [...specs.rows];
  const taken = new Set(allSpecs.map((r) => `${r.key}|${r.scopeKind}|${r.scopeId}|${r.region}`));
  for (const r of extra) {
    const k = `${r.key}|${r.scopeKind}|${r.scopeId}|${r.region}`;
    if (taken.has(k)) continue;
    taken.add(k);
    allSpecs.push(r);
  }
  allSpecs.forEach((r, i) => {
    r.sort = i;
    r.id = specRowId(productId, r.key, r.scopeKind, r.scopeId, r.region);
  });
  // not_found rows are created by buildSpecs for keys no checked source gave; drop one when an extra row now supplies the key.
  const supplied = new Set(allSpecs.filter((r) => r.status !== 'not_found').map((r) => r.key));
  const finalSpecs = allSpecs.filter((r) => r.status !== 'not_found' || !supplied.has(r.key));

  for (const n of specs.notes) notes.push({ kind: n.kind, field: n.field.slice(0, 120) });
  for (const n of relations.notes) notes.push({ kind: n.kind, field: n.field });
  for (const n of model.notes) if (n.code === 'TRANSLATION_REVIEW') notes.push({ kind: 'translation_review', field: 'option_groups' });
  for (const r of media.report.reviewList) notes.push({ kind: 'image_review', field: r.slice(0, 120) });

  // External ids.
  const externalIds: PayloadExternalId[] = [{ scope_kind: 'product', scope_id: '', id_type: 'bambu_product_id', value: x.sourceProductId, searchable: false }];
  for (const v of model.variants) {
    externalIds.push({ scope_kind: 'variant', scope_id: v.id, id_type: 'bambu_variant_id', value: v.sourceId, searchable: false });
    const sku = skuCodes[v.sourceId];
    if (sku) externalIds.push({ scope_kind: 'variant', scope_id: v.id, id_type: 'bambu_sku_code', value: sku.slice(0, 120), searchable: true });
  }
  for (const g of model.groups) for (const v of g.values) if (v.colourCode) externalIds.push({ scope_kind: 'option_value', scope_id: v.id, id_type: 'color_code', value: v.colourCode, searchable: true });

  // Source references.
  const sourceRefs: PayloadSourceRef[] = [];
  for (const g of model.groups) {
    sourceRefs.push({ kind: 'group', source_id: g.sourceId, levonis_id: g.id, source_label: g.sourceLabel.slice(0, 200), binding_rule: '', via_variant_id: '' });
    // A value's source label is its source text — or its reviewed label, which replaces wording the
    // classifier refuses (§E.1): `source_label` is checked as customer text, so refused words never stay.
    for (const v of g.values) sourceRefs.push({ kind: 'value', source_id: v.sourceId, levonis_id: v.id, source_label: v.nameEn.slice(0, 200), binding_rule: '', via_variant_id: '' });
  }
  for (const v of model.variants) sourceRefs.push({ kind: 'variant', source_id: v.sourceId, levonis_id: v.id, source_label: '', binding_rule: '', via_variant_id: '' });
  for (const r of media.rows) sourceRefs.push({ kind: 'image', source_id: r.resourceFileId, levonis_id: r.id, source_label: '', binding_rule: r.rule, via_variant_id: r.viaVariantId ?? '' });

  const payload: ImportPayload = {
    protocol: 2,
    source: 'bambu_us',
    source_product_id: x.sourceProductId,
    handle: x.handle,
    route: x.route,
    write_mode: inp.writeMode,
    product_id: productId,
    curated_sha256: inp.curatedSha256 ?? '',
    extraction_sha256: inp.extractionSha256,
    product: {
      title_en: x.title,
      short_description_en: shortDescription.slice(0, 2000),
      variant_mode: model.inventoryMode,
      usage_steps: usageSteps.slice(0, 40),
      usage_official_url: usageOfficialUrl,
    },
    groups: model.groups.map((g) => ({
      id: g.id,
      source_id: g.sourceId,
      sort: g.position,
      name_en: g.nameEn,
      name_ar: g.nameAr,
      name_ckb: g.nameCkb,
      kind: g.kind,
      source_label: g.sourceLabel.slice(0, 200),
      default_value_id: g.defaultValueId,
      values: g.values.map((v) => ({
        id: v.id,
        source_id: v.sourceId,
        name_en: v.nameEn,
        name_ar: v.nameAr,
        name_ckb: v.nameCkb,
        variant_key: v.variantKey,
        variant_label: v.variantLabel,
        sort: v.sort,
        colour_code: v.colourCode ?? '',
      })),
    })),
    variants: model.variants.map((v) => ({ id: v.id, source_id: v.sourceId, combo_key: v.comboKey, value_ids: [...v.valueIds] })),
    images: media.rows.map((r) => ({
      id: r.id,
      source_media_id: r.resourceFileId,
      source_url: r.url,
      sort_order: r.sortOrder,
      is_primary: r.isPrimary,
      option_value_id: r.optionValueId,
      variant_id: r.variantId,
      via_variant_id: r.viaVariantId,
      binding_rule: r.rule,
      alt_en: r.alt.en,
      alt_ar: r.alt.ar,
      alt_ckb: r.alt.ckb,
    })),
    swatches: media.swatches.map((s) => ({ value_id: s.valueId, source_media_id: s.sourceMediaId, source_url: s.url })),
    content_blocks: blocks,
    specs: finalSpecs.map(toPayloadSpec),
    documents,
    relations: relations.rows.map((r) => ({
      id: r.id,
      scope_kind: r.scopeKind,
      scope_id: r.scopeId,
      relation: r.relation,
      target_kind: r.targetKind,
      target_product_id: r.targetProductId,
      target_source: r.targetSource,
      target_source_handle: r.targetSourceHandle,
      target_family: r.targetFamily,
      target_label: r.targetLabel.slice(0, 200),
      state: r.state,
      evidence_kind: r.evidenceKind,
      // The evidence quotes the source's own sentence, which can carry store words around the fact it proves
      // ("If you require a filament buffer, you can add it to your shopping cart below."): the relation stands,
      // the refused words do not reach a customer (and so never refuse the whole payload).
      evidence_text: scrubProse(r.evidenceText).kept,
    })),
    external_ids: externalIds,
    source_refs: sourceRefs,
    notes,
  };

  const report: BuildReport = {
    productType,
    format: described.format,
    counts: {
      groups: payload.groups.length,
      values: payload.groups.reduce((n, g) => n + g.values.length, 0),
      variants: payload.variants.length,
      images: payload.images.length,
      distinct_images: new Set(payload.images.map((i) => i.source_media_id)).size,
      swatches: payload.swatches.length,
      content_blocks: blocks.length,
      content_images: contentImages,
      content_images_omitted: contentImagesOmitted,
      box_items: [...boxByScope.values()].reduce((n, s) => n + s.items.length, 0),
      box_images: boxImages,
      specs: payload.specs.length,
      documents: documents.length,
      relations: payload.relations.length,
      external_ids: externalIds.length,
      notes: notes.length,
    },
    specsByStatus: tally(payload.specs, (s) => s.status),
    specsByRegion: tally(payload.specs.filter((s) => s.region), (s) => s.region),
    relationsByState: tally(payload.relations, (r) => r.state),
    sentenceCounts,
    errors: model.errors.map((e) => e.code),
    hold: model.hold,
    unknownLabels: specs.unknownLabels,
    soldOutCount: model.soldOutCount,
  };
  return { payload, model, media, described, specs, relations, report };
}

const cutTo = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

