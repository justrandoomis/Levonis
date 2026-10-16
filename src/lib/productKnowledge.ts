/**
 * THE PRODUCT PAGE'S KNOWLEDGE TABS, AS DATA (the Bambu import spec §G.2,
 * §G.4; the answer of `GET /api/products/:slug/knowledge`,
 * worker/lib/knowledge/productKnowledge.ts).
 *
 * Pure: which tabs exist, which rows each one draws for the selection on
 * screen, how a value reads (never 0 or «No» for a missing one), and every
 * word in Arabic, English and Sorani. The lazy component
 * (src/components/product/ProductKnowledgeTabs.tsx) only lays this out.
 *
 *   Specifications         any spec row (the groups below excepted)
 *   Materials & printing   rows in `material`, `print_settings`, `drying`,
 *                          and the nozzle / plate material and glue rows
 *   Packaging & shipping   any logistics row or in-the-box item
 *   Compatibility          any relation
 *   Documents & manuals    any active document
 *
 * VARIANT-SCOPED ROWS follow the selection: a row scoped to a selected value
 * (or to the variant the selection resolves to) shows first, then the
 * product-level rows — a product row of the same key and region is the
 * scoped row's general case and is not repeated. A row scoped to an unselected
 * value is hidden from the table and listed under «إصدارات أخرى». With no
 * explicit selection the page's default selection (§G.3) applies.
 */
import { REGION_LABELS, VALUE_STATE_LABELS, type Tri } from '../../packages/catalog/src/bambuImport/registry/labels';
import { DOCUMENT_TITLES, type DocumentKind } from '../../packages/catalog/src/bambuImport/registry/documents';

export type { Tri };
export type KnowledgeLang = 'ar' | 'en' | 'ckb';
export type SpecStatus = 'verified' | 'unverified' | 'not_found' | 'not_published' | 'not_applicable' | 'unknown';
export interface KnowledgeScope {
  kind: 'product' | 'option_value' | 'variant';
  id: string;
}

export interface KnowledgeRow {
  key: string;
  label: Tri;
  value_text: string;
  value_num: number | null;
  value_num_max: number | null;
  value_bool?: boolean | null;
  items?: string[];
  unit: string;
  status: SpecStatus;
  region: '' | 'us_110v' | 'intl_220v';
  scope: KnowledgeScope;
  source: { kind: string; title: string; locator: string; excerpt: string; url?: string };
  checked_sources?: Array<{ kind: string; title: string; url?: string }>;
  test_method: string;
  test_condition: string;
  conflict: boolean;
  display?: boolean;
}

export interface KnowledgeAnswer {
  specs: Array<{ group: string; label: Tri; rows: KnowledgeRow[] }>;
  logistics: { product: KnowledgeRow[]; package: KnowledgeRow[]; shipment: KnowledgeRow[]; carton: KnowledgeRow[] };
  in_the_box: Array<{ text: string; qty: number | null; image?: string; scope: KnowledgeScope }>;
  compatibility: Record<'compatible' | 'not_compatible' | 'requires' | 'related', Array<{
    relation: string;
    label: string;
    target_kind?: string;
    state?: string;
    scope: KnowledgeScope;
    product?: { id?: string; slug: string; name: Tri; image: string };
  }>>;
  documents: Array<{ kind: string; title: Tri; url: string; host: string; scope: KnowledgeScope }>;
  completeness?: Record<string, number> | null;
}

// ------------------------------------------------------------------ the words

const t = (ar: string, en: string, ckb: string): Tri => ({ ar, en, ckb });

/** Every word the tabs draw (§G.2 tables; the documents' titles are the registry's, §G.4). */
export const KNOWLEDGE_WORDS = {
  tabSpecs: t('المواصفات', 'Specifications', 'تایبەتمەندییەکان'),
  tabMaterials: t('المواد وإعدادات الطباعة', 'Materials & printing', 'کەرەستە و ڕێکخستنی چاپ'),
  tabPackaging: t('التغليف والشحن', 'Packaging & shipping', 'پاکەتکردن و ناردن'),
  inTheBox: t('محتويات العلبة', 'In the box', 'ناوەڕۆکی سندوق'),
  tabCompatibility: t('التوافق', 'Compatibility', 'گونجاوی'),
  tabDocuments: t('المستندات والأدلة', 'Documents & manuals', 'بەڵگەنامە و ڕێنماییەکان'),
  sourcesChecked: t('المصادر التي رُوجعت', 'Sources checked', 'ئەو سەرچاوانەی پشکنران'),
  source: t('المصدر:', 'Source:', 'سەرچاوە:'),
  official: t('رسمي (Bambu Lab)', 'Official (Bambu Lab)', 'فەرمی (Bambu Lab)'),
  testMethod: t('طريقة الاختبار', 'Test method', 'ڕێگای تاقیکردنەوە'),
  appliesTo: t('خاص بـ', 'Applies to', 'تایبەتە بە'),
  otherVersions: t('إصدارات أخرى', 'Other versions', 'وەشانەکانی تر'),
  compatible: t('متوافق مع', 'Compatible with', 'گونجاوە لەگەڵ'),
  notCompatible: t('غير متوافق مع', 'Not compatible with', 'گونجاو نییە لەگەڵ'),
  requires: t('يتطلب', 'Requires', 'پێویستی پێیەتی'),
  related: t('منتجات ذات صلة', 'Related products', 'بەرهەمە پەیوەندیدارەکان'),
  netWeight: t('الوزن الصافي', 'Net weight', 'کێشی پوخت'),
  packageWeight: t('وزن العبوة', 'Package weight', 'کێشی پاکەت'),
  shipmentWeight: t('الوزن الإجمالي للشحنة', 'Shipment gross weight', 'کێشی گشتی بارەکە'),
  productDims: t('أبعاد المنتج', 'Product dimensions', 'قەبارەی بەرهەم'),
  packageDims: t('أبعاد العبوة', 'Package dimensions', 'قەبارەی پاکەت'),
  recommendedSpace: t('المساحة الموصى بها', 'Recommended space', 'ئەو شوێنەی پێشنیار دەکرێت'),
  opensExternal: t('يُفتح في موقع الشركة المصنّعة', "Opens on the manufacturer's site", 'لە ماڵپەڕی بەرهەمهێنەر دەکرێتەوە'),
  qty: t('العدد', 'Qty', 'ژمارە'),
  tabsLabel: t('معلومات المنتج', 'Product information', 'زانیاری بەرهەم'),
  yes: t('نعم', 'Yes', 'بەڵێ'),
  no: t('لا', 'No', 'نەخێر'),
} as const satisfies Record<string, Tri>;

/** The words a state shows INSTEAD OF A VALUE (never 0, never «No»), and the unverified badge. */
export const STATE_WORDS = VALUE_STATE_LABELS;
/** The US-table row note. */
export const US_110V_NOTE = REGION_LABELS.us_110v;

/** A document's title: the server's, else the registry's title for its kind (§G.4). */
export function documentTitle(doc: { kind: string; title?: Partial<Tri> | null }, lang: KnowledgeLang): string {
  const own = (doc.title?.[lang] ?? '').trim();
  if (own) return own;
  return (DOCUMENT_TITLES[doc.kind as DocumentKind] ?? DOCUMENT_TITLES.other)[lang];
}

export const w = (word: Tri, lang: KnowledgeLang): string => word[lang] || word.en;

// ------------------------------------------------------------------ the selection

export interface KnowledgeSelection {
  /** The values on screen — the explicit selection, else the default selection (§G.3). */
  optionValueIds: readonly string[];
  /** The variant they resolve to, when they resolve to one. */
  variantId: string | null;
}

/** Does this row's scope apply to the selection? Product rows always do. */
export function scopeApplies(scope: KnowledgeScope, sel: KnowledgeSelection): boolean {
  if (scope.kind === 'product' || !scope.id) return true;
  if (scope.kind === 'option_value') return sel.optionValueIds.includes(scope.id);
  return !!sel.variantId && sel.variantId === scope.id;
}

/**
 * The rows the table draws for a selection: the rows scoped to it first, then
 * the product's own rows not already stated for this selection (same key and
 * region). `hidden` are the rows scoped to other values — «إصدارات أخرى».
 */
export function rowsForSelection(rows: readonly KnowledgeRow[], sel: KnowledgeSelection): { shown: KnowledgeRow[]; hidden: KnowledgeRow[] } {
  const scoped: KnowledgeRow[] = [];
  const general: KnowledgeRow[] = [];
  const hidden: KnowledgeRow[] = [];
  for (const r of rows) {
    if (r.display === false) continue;
    if (r.scope.kind === 'product' || !r.scope.id) general.push(r);
    else if (scopeApplies(r.scope, sel)) scoped.push(r);
    else hidden.push(r);
  }
  const stated = new Set(scoped.map((r) => `${r.key}|${r.region}`));
  return { shown: [...scoped, ...general.filter((r) => !stated.has(`${r.key}|${r.region}`))], hidden };
}

// ------------------------------------------------------------------ the tabs

export type KnowledgeTabId = 'specs' | 'materials' | 'packaging' | 'compatibility' | 'documents';

const MATERIAL_GROUPS = new Set(['material', 'print_settings', 'drying']);
/** Nozzle and plate material and glue rows read as materials, whatever group they were filed in. */
const MATERIAL_KEY = /(^|\.)(nozzle_material|build_plate_material)$|^nozzle\.material$|^plate\.|glue/;
/** Keys the packaging tab draws, beside the logistics blocks. */
const PACKAGING_KEYS = new Set(['physical.recommended_space']);

export const isMaterialRow = (group: string, key: string): boolean => MATERIAL_GROUPS.has(group) || MATERIAL_KEY.test(key);

export interface KnowledgeTabs {
  specs: Array<{ group: string; label: Tri; rows: KnowledgeRow[] }>;
  materials: Array<{ group: string; label: Tri; rows: KnowledgeRow[] }>;
  packaging: { lines: PackagingLine[]; box: KnowledgeAnswer['in_the_box'] };
  compatibility: Array<{ bucket: keyof KnowledgeAnswer['compatibility']; label: Tri; items: KnowledgeAnswer['compatibility']['compatible'] }>;
  documents: KnowledgeAnswer['documents'];
  /** The tabs with something to show, in the page's order. */
  order: KnowledgeTabId[];
}

/** Splits the answer into the five tabs (§G.2), each only when it has something to show. */
export function knowledgeTabs(k: KnowledgeAnswer, sel: KnowledgeSelection): KnowledgeTabs {
  const specs: KnowledgeTabs['specs'] = [];
  const materials: KnowledgeTabs['materials'] = [];
  const recommended: KnowledgeRow[] = [];
  for (const g of k.specs ?? []) {
    const own: KnowledgeRow[] = [];
    const mat: KnowledgeRow[] = [];
    for (const r of g.rows ?? []) {
      if (r.display === false) continue;
      if (PACKAGING_KEYS.has(r.key)) recommended.push(r);
      else if (isMaterialRow(g.group, r.key)) mat.push(r);
      else own.push(r);
    }
    if (own.length) specs.push({ group: g.group, label: g.label, rows: own });
    if (mat.length) materials.push({ group: g.group, label: g.label, rows: mat });
  }
  const lines = packagingLines(k.logistics ?? { product: [], package: [], shipment: [], carton: [] }, recommended, sel);
  const box = (k.in_the_box ?? []).filter((i) => scopeApplies(i.scope, sel));
  const buckets: Array<[keyof KnowledgeAnswer['compatibility'], Tri]> = [
    ['compatible', KNOWLEDGE_WORDS.compatible],
    ['not_compatible', KNOWLEDGE_WORDS.notCompatible],
    ['requires', KNOWLEDGE_WORDS.requires],
    ['related', KNOWLEDGE_WORDS.related],
  ];
  const compatibility = buckets
    .map(([bucket, label]) => ({ bucket, label, items: (k.compatibility?.[bucket] ?? []).filter((i) => scopeApplies(i.scope, sel)) }))
    .filter((b) => b.items.length > 0);
  const documents = (k.documents ?? []).filter((d) => scopeApplies(d.scope, sel));
  const order: KnowledgeTabId[] = [];
  if (specs.length) order.push('specs');
  if (materials.length) order.push('materials');
  if (lines.length || box.length) order.push('packaging');
  if (compatibility.length) order.push('compatibility');
  if (documents.length) order.push('documents');
  return { specs, materials, packaging: { lines, box }, compatibility, documents, order };
}

/** One line of the packaging tab: a weight, a set of three dimensions, the recommended space, a carton fact. */
export interface PackagingLine {
  label: Tri;
  /** The rows the line is made of (one, or the three axes of a dimension). */
  rows: KnowledgeRow[];
  /** The three axes stated together («325 × 320 × 325 mm»), when all three carry a number in one unit. */
  joined?: string;
}

/**
 * The packaging tab's lines in a fixed order — net weight, product
 * dimensions, recommended space, package weight, package dimensions, shipment
 * gross weight — then any other logistics row (carton facts) under its own
 * label. Rows scoped to another value are left out; no CBM ever arrives (L-4).
 */
export function packagingLines(
  L: KnowledgeAnswer['logistics'],
  recommended: readonly KnowledgeRow[],
  sel: KnowledgeSelection
): PackagingLine[] {
  const pick = (list: readonly KnowledgeRow[]) => rowsForSelection(list, sel).shown;
  const product = pick(L.product ?? []);
  const pkg = pick(L.package ?? []);
  const used = new Set<KnowledgeRow>();
  const one = (list: KnowledgeRow[], key: string, label: Tri): PackagingLine[] => {
    const r = list.find((x) => x.key === key);
    if (!r) return [];
    used.add(r);
    return [{ label, rows: [r] }];
  };
  const dims = (list: KnowledgeRow[], prefix: string, label: Tri): PackagingLine[] => {
    const axes = ['length', 'width', 'height'].map((a) => list.find((x) => x.key === `${prefix}.${a}`));
    const present = axes.filter((x): x is KnowledgeRow => !!x);
    if (!present.length) return [];
    present.forEach((r) => used.add(r));
    const units = new Set(present.map((r) => r.unit));
    const numbers = present.every((r) => typeof r.value_num === 'number' && r.status !== 'not_found' && r.status !== 'unknown');
    if (present.length === 3 && numbers && units.size === 1) {
      const unit = [...units][0];
      return [{ label, rows: present, joined: `${present.map((r) => plainNumber(r.value_num as number)).join(' × ')}${unit ? ` ${unit}` : ''}` }];
    }
    return present.map((r) => ({ label: r.label, rows: [r] }));
  };
  const out: PackagingLine[] = [
    ...one(product, 'product.net_weight', KNOWLEDGE_WORDS.netWeight),
    ...dims(product, 'product', KNOWLEDGE_WORDS.productDims),
    ...pick(recommended).map((r) => (used.add(r), { label: KNOWLEDGE_WORDS.recommendedSpace, rows: [r] })),
    ...one(pkg, 'package.weight', KNOWLEDGE_WORDS.packageWeight),
    ...dims(pkg, 'package', KNOWLEDGE_WORDS.packageDims),
    ...pick(L.shipment ?? []).filter((r) => r.key === 'shipment.gross_weight').map((r) => (used.add(r), { label: KNOWLEDGE_WORDS.shipmentWeight, rows: [r] })),
  ];
  for (const r of [...product, ...pkg, ...pick(L.shipment ?? []), ...pick(L.carton ?? [])]) {
    if (!used.has(r)) out.push({ label: r.label, rows: [r] });
  }
  return out;
}

export const TAB_WORDS: Record<KnowledgeTabId, Tri> = {
  specs: KNOWLEDGE_WORDS.tabSpecs,
  materials: KNOWLEDGE_WORDS.tabMaterials,
  packaging: KNOWLEDGE_WORDS.tabPackaging,
  compatibility: KNOWLEDGE_WORDS.tabCompatibility,
  documents: KNOWLEDGE_WORDS.tabDocuments,
};

/**
 * What the page knows from the answer, so it can retire its own older sections
 * (the legacy specs, the box) — and whether there is anything to draw at all.
 */
export function knowledgeCovers(k: KnowledgeAnswer): { specs: boolean; box: boolean; any: boolean } {
  const specs = (k.specs ?? []).some((g) => (g.rows ?? []).some((r) => r.display !== false));
  const box = (k.in_the_box ?? []).length > 0;
  return { specs, box, any: knowledgeTabs(k, { optionValueIds: [], variantId: null }).order.length > 0 || specs || box };
}

// ------------------------------------------------------------------ values

const ABSENT = new Set<SpecStatus>(['not_found', 'not_published', 'not_applicable', 'unknown']);

const plainNumber = (n: number): string => {
  const rounded = Math.round(n * 1000) / 1000;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
};

/**
 * The value as published: its text, else its number (a range «a–b»), with the
 * unit once; a list's items; a boolean in words. An absent value is the
 * state's words — never «0», never «No». Numbers stay Latin and LTR (the
 * component wraps them in <bdi>).
 */
export function valueText(r: KnowledgeRow, lang: KnowledgeLang): { text: string; absent: boolean } {
  if (ABSENT.has(r.status)) return { text: w(STATE_WORDS[r.status as Exclude<SpecStatus, 'verified' | 'unverified'>], lang), absent: true };
  if (r.items && r.items.length) return { text: r.items.join(lang === 'en' ? ', ' : '، '), absent: false };
  if (r.value_text) return { text: r.value_text, absent: false };
  if (r.value_num !== null && r.value_num !== undefined) {
    const n = r.value_num_max !== null && r.value_num_max !== undefined ? `${plainNumber(r.value_num)}–${plainNumber(r.value_num_max)}` : plainNumber(r.value_num);
    return { text: r.unit ? `${n} ${r.unit}` : n, absent: false };
  }
  if (r.value_bool === true) return { text: w(KNOWLEDGE_WORDS.yes, lang), absent: false };
  if (r.value_bool === false) return { text: w(KNOWLEDGE_WORDS.no, lang), absent: false };
  return { text: w(STATE_WORDS.unknown, lang), absent: true };
}

/** «المصدر: …» — the document's title, or «رسمي (Bambu Lab)» for the manufacturer's own store page. */
export function sourceLine(r: KnowledgeRow, lang: KnowledgeLang): { text: string; url?: string } | null {
  const s = r.source;
  if (!s || !s.kind) return null;
  if (s.kind === 'curated' || s.kind === 'derived') return null;
  const named = (s.title ?? '').trim() || w(KNOWLEDGE_WORDS.official, lang);
  return { text: `${w(KNOWLEDGE_WORDS.source, lang)} ${named}`, ...(s.url ? { url: s.url } : {}) };
}
