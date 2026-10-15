/**
 * EXTRACT: one store page → the source facts the import may use (spec §C.1,
 * §C.10 layer 1; source-analysis §2–§4).
 *
 * THE CLOSED READ LIST. Every value taken from the product object `P`, the
 * JSON-LD and the i18n messages goes through a `Reader`, which refuses (throws
 * `ReadOutsideList`) any path that is not listed below and records every path
 * it serves. Resolution of flight references is lazy, so a path that is never
 * asked for is never resolved. Locating `P` and the description element walks
 * the rows by SHAPE, and that walk never descends into a key that names money,
 * stock or a promotion (`NEVER_DESCEND`), nor into the cross-sell payload,
 * which only crossSell.ts reads. Description content is copied through a
 * closed key list (`DESCRIPTION_KEYS`); every other prop is dropped unread.
 *
 * tests/bambuExtract.test.ts proves it on a page wrapped in a recording Proxy:
 * no `get` of a price, discount, stock, quantity-limit, points, flash-sale,
 * pre-sale or buy-and-get key happens anywhere in the page while it is read.
 */
import { refOf, scalarOf, deref, jsonLdBlocks, parseFlight, type FlightStats, type RowValue } from './rsc';
import { cleanText, decodeHandle } from './normalize';

export class ReadOutsideList extends Error {
  constructor(public path: string) {
    super(`IMPORT_READ_OUTSIDE_LIST: ${path}`);
    this.name = 'ReadOutsideList';
  }
}

/** Every path the extractor may read from the product object `P`. */
export const PRODUCT_READ_LIST: readonly string[] = [
  'P.id', 'P.seoCode', 'P.seoUrlHandle', 'P.name', 'P.seoMetaDescription', 'P.currentAllIdRoute', 'P.isFilament',
  'P.productPropertyList', 'P.productPropertyList[]',
  'P.productPropertyList[].propertyKey', 'P.productPropertyList[].propertyKeyId', 'P.productPropertyList[].type',
  'P.productPropertyList[].title', 'P.productPropertyList[].position',
  'P.productPropertyList[].productPropertyValueList', 'P.productPropertyList[].productPropertyValueList[]',
  'P.productPropertyList[].productPropertyValueList[].id', 'P.productPropertyList[].productPropertyValueList[].value',
  'P.productPropertyList[].productPropertyValueList[].selectedDefault', 'P.productPropertyList[].productPropertyValueList[].colorUrl',
  'P.productSkuList', 'P.productSkuList[]', 'P.productSkuList[].id',
  'P.productSkuList[].productSkuPropertyList', 'P.productSkuList[].productSkuPropertyList[]',
  'P.productSkuList[].productSkuPropertyList[].propertyKeyId', 'P.productSkuList[].productSkuPropertyList[].propertyKey',
  'P.productSkuList[].productSkuPropertyList[].propertyValue',
  'P.productSkuList[].mediaFile', 'P.productSkuList[].mediaFile.resourceFileId', 'P.productSkuList[].mediaFile.url',
  'P.productSkuList[].description',
  // Counted into the ledger's source_sold_out_variants only (§C.3, §C.9); never written to a product.
  'P.productSkuList[].isSoldOut',
  'P.mediaFiles', 'P.mediaFiles[]', 'P.mediaFiles[].resourceFileId', 'P.mediaFiles[].url',
  'P.productFeaturesTitle', 'P.productFeaturesModuleList', 'P.productFeaturesModuleList[]',
  'P.productFeaturesModuleList[].title', 'P.productFeaturesModuleList[].content',
  'P.externalVideoLinkList', 'P.externalVideoLinkList[]',
];

/** The JSON-LD identity fields (the §C.1 cross-check). */
export const JSONLD_READ_LIST: readonly string[] = [
  'LD.@type', 'LD.productGroupID', 'LD.hasVariant', 'LD.hasVariant[]', 'LD.hasVariant[].sku', 'LD.brand', 'LD.brand.name',
];

/**
 * The i18n specification tables a D2 page renders client-side (§C.5 D2):
 * `messages.<namespace>.SpecificationTable` key/value pairs only.
 */
export const MESSAGES_READ_LIST: readonly string[] = ['M.*', 'M.*.SpecificationTable', 'M.*.SpecificationTable.*'];

/** The D2 pages whose spec table lives in the messages bundle, by decoded handle (§C.5). */
export const MESSAGE_SPEC_NAMESPACES: Readonly<Record<string, string>> = {
  'ams-2-pro': 'AMSPro',
  'ams-ht': 'AMSHT',
};

/**
 * Keys the shape walk never descends into: money, stock and promotions
 * (source-analysis §3.3 "Do not import", §3.9), the cross-sell payload
 * (crossSell.ts is its one reader) and the site-wide i18n bundle.
 */
export const NEVER_DESCEND =
  /price|cost|stock|inventor|discount|msrp|amount|currency|margin|profit|wallet|coupon|quantity|reserved|points|flashsale|presale|buyandget|promotion|gradient|minimum|maximum|limit|relationproducts|^messages$|ordinfo|orderinfo|serviceguarantee/i;

/** Description props copied out of the page (the closed list for description elements). */
export const DESCRIPTION_KEYS: ReadonlySet<string> = new Set([
  // host elements
  'children', 'dangerouslySetInnerHTML', '__html', 'id', 'src', 'data-src', 'alt', 'href', 'title', 'colSpan', 'rowSpan',
  'width', 'height', 'data-poster', 'poster', 'role',
  // legacy and multi-section HTML
  'description', 'isOldVersion', 'sections', 'name', 'label',
  // bespoke client components (D2)
  'subtitle', 'mediaType', 'mediaUrl', 'posterUrl', 'titleComp', 'button', 'text', 'image', 'items', 'images', 'note',
  'textSource', 'source', 'checkText', 'link', 'dtsLink', 'collapseTable', 'notCollapseTable', 'tableNote', 'collapseText',
  'notCollapseText', 'imageSource', 'textList', 'faqItems', 'question', 'answer', 'hoverSrc', 'mobileSrc', 'position',
  // the page-builder tree (C)
  'config', 'schemaVersion', 'templateId', 'components', 'type', 'variant', 'anchor', 'enabled', 'modules', 'typeStyles',
  'content', 'subtitle2', 'media', 'pc', 'mo', 'naturalWidth', 'naturalHeight', 'featureConfig', 'cards', 'tabs', 'faqs',
  'answerBlocks', 'linkButton', 'level1', 'level2', 'level3',
]);

/**
 * Format E (the newest printer pages: H2S, P2S, H2C …): a component list
 * `data: [{componentType, componentName, data}]`. Its own closed key list:
 * text, media objects, tables, FAQ and in-the-box items. Mobile duplicates,
 * model-showcase statistics (weight, print time), colours and layout keys are
 * never read.
 */
export const COMPONENT_KEYS: ReadonlySet<string> = new Set([
  'componentType', 'componentName', 'data', 'pc', 'anchorId', 'list', 'id', 'name',
  'title', 'subtitle', 'subTitle', 'mainTitle', 'mainTitleText', 'subtitleText', 'description', 'text', 'originalText', 'h2Text',
  'caption', 'note', 'footNote', 'featureTitle', 'featureSubtitle', 'featureImage', 'question', 'answer', 'faqItems', 'items',
  'headers', 'column1', 'column2', 'column3', 'column4', 'column5', 'showCheckIcon',
  'image', 'images', 'imageList', 'pcImage', 'imageSrc', 'src', 'mainImage', 'detailImage', 'leftImage', 'rightImage', 'leftLabel',
  'rightLabel', 'url', 'alt', 'fileOriginalName', 'resourceFileId', 'dataType', 'videoUrl', 'mediaUrl', 'pcVideo', 'link',
  'downloadLink', 'buttonUrl', 'notCollapseTable', 'collapseTable', 'tableNote', 'collapseText', 'notCollapseText', 'tabs',
  'sections', 'modules', 'subModules', 'infoList', 'imageTextList', 'imageTextItems', 'contentCards', 'cardList', 'imageCards',
  'iconList', 'descriptionInfoTitle', 'descriptionInfoDescription', 'label',
]);
const COMPONENT_KEY_RE = /^image\d{1,2}(?:Title|Subtitle)?$/;

/** A format-E component list through COMPONENT_KEYS (references resolved, never past NEVER_DESCEND). */
export function pickComponents(rows: Map<string, RowValue>, v: unknown, depth = 0, seen: Set<string> = new Set()): unknown {
  if (depth > 200) return null;
  if (typeof v === 'string') {
    const ref = refOf(v);
    if (!ref) return scalarOf(v);
    if (seen.has(v)) return null;
    return pickComponents(rows, deref(rows, v), depth + 1, new Set(seen).add(v));
  }
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => pickComponents(rows, x, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v)) {
    if (NEVER_DESCEND.test(k) || !(COMPONENT_KEYS.has(k) || COMPONENT_KEY_RE.test(k))) continue;
    out[k] = pickComponents(rows, (v as Record<string, unknown>)[k], depth + 1, seen);
  }
  return out;
}

/** A path pattern: array elements are `[]`, a listed `*` segment matches any key. */
function patternMatches(list: ReadonlySet<string>, path: string): boolean {
  if (list.has(path)) return true;
  // Try replacing key segments with '*', right to left (only the M.* list uses it).
  const segs = path.split('.');
  for (let mask = 1; mask < 1 << Math.min(segs.length, 4); mask++) {
    const alt = segs.map((s, i) => (i > 0 && mask & (1 << (segs.length - 1 - i)) ? '*' : s)).join('.');
    if (list.has(alt)) return true;
  }
  return false;
}

interface ReadCtx {
  rows: Map<string, RowValue>;
  list: ReadonlySet<string>;
  record: Set<string>;
}

/** A closed-list accessor over one value of the page. */
export class Reader {
  constructor(private ctx: ReadCtx, private value: unknown, readonly path: string) {}

  private child(key: string): { value: unknown; path: string } {
    const path = `${this.path}.${key}`;
    if (!patternMatches(this.ctx.list, path)) throw new ReadOutsideList(path);
    this.ctx.record.add(path);
    const holder = deref(this.ctx.rows, this.value);
    if (holder === null || typeof holder !== 'object' || Array.isArray(holder)) return { value: undefined, path };
    return { value: deref(this.ctx.rows, (holder as Record<string, unknown>)[key]), path };
  }

  has(key: string): boolean {
    const holder = deref(this.ctx.rows, this.value);
    return !!holder && typeof holder === 'object' && !Array.isArray(holder) && key in (holder as object);
  }

  str(key: string): string {
    const v = this.child(key).value;
    return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
  }

  num(key: string): number | null {
    const v = this.child(key).value;
    return typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : null;
  }

  bool(key: string): boolean {
    const v = this.child(key).value;
    return v === true || v === 1 || v === '1' || v === 'true';
  }

  obj(key: string): Reader | null {
    const { value, path } = this.child(key);
    return value && typeof value === 'object' && !Array.isArray(value) ? new Reader(this.ctx, value, path) : null;
  }

  arr(key: string): Reader[] {
    const { value, path } = this.child(key);
    if (!Array.isArray(value)) return [];
    const el = `${path}[]`;
    if (!patternMatches(this.ctx.list, el)) throw new ReadOutsideList(el);
    this.ctx.record.add(el);
    return value.map((v) => new Reader(this.ctx, deref(this.ctx.rows, v), el));
  }

  strArr(key: string): string[] {
    return this.arr(key)
      .map((r) => r.self())
      .filter((v): v is string => typeof v === 'string');
  }

  /** Every key of this object (key names only; no value is read). */
  keys(): string[] {
    const holder = deref(this.ctx.rows, this.value);
    return holder && typeof holder === 'object' && !Array.isArray(holder) ? Object.keys(holder) : [];
  }

  /** The scalar value at this position (strings resolved). */
  self(): unknown {
    const v = deref(this.ctx.rows, this.value);
    return v !== null && typeof v === 'object' ? undefined : v;
  }
}

// ---------------------------------------------------------------- the extraction

export interface SourceMedia {
  resourceFileId: string;
  url: string;
}
export interface SourceValue {
  id: string;
  value: string;
  selectedDefault: boolean;
  colorUrl: string;
}
export interface SourceGroup {
  propertyKeyId: string;
  propertyKey: string;
  type: number;
  title: string;
  position: number;
  values: SourceValue[];
}
export interface SourceSku {
  id: string;
  props: Array<{ propertyKeyId: string; propertyKey: string; value: string }>;
  hero: SourceMedia | null;
  /** Variant note HTML (goes through the sentence classifier, §C.3). */
  description: string;
  soldOut: boolean;
}

export type DescriptionSource =
  | { kind: 'legacy_html'; html: string }
  | { kind: 'sections_html'; sections: Array<{ id: string; name: string; html: string }> }
  | { kind: 'page_builder'; config: unknown }
  | { kind: 'bespoke_shopify_port'; tree: unknown }
  | { kind: 'bespoke_new'; navSections: Array<{ id: string; label: string }>; tree: unknown; specTable?: Record<string, string> }
  | { kind: 'component_list'; components: unknown }
  | { kind: 'none' };

export interface Extraction {
  sourceProductId: string;
  /** decodeURIComponent(P.seoCode), NFC. */
  handle: string;
  canonicalUrl: string;
  title: string;
  seoMetaDescription: string;
  route: string;
  isFilament: boolean;
  groups: SourceGroup[];
  skus: SourceSku[];
  gallery: SourceMedia[];
  features: Array<{ title: string; html: string }>;
  featuresTitle: string;
  videos: string[];
  description: DescriptionSource;
  jsonld: { productGroupId: string; variantSkus: string[]; brand: string } | null;
}

export interface PageExtraction {
  extraction: Extraction;
  /** Every closed-list path served while reading (for the test and the report). */
  reads: string[];
  stats: FlightStats;
  /** How many objects of the product's shape the page holds (expected ≥ 1). */
  productCandidates: number;
}

export class ExtractError extends Error {
  constructor(public code: 'PRODUCT_NOT_FOUND' | 'FLIGHT_EMPTY', message: string) {
    super(message);
    this.name = 'ExtractError';
  }
}

const PRODUCT_SHAPE = ['id', 'seoCode', 'name', 'productSkuList', 'productPropertyList', 'mediaFiles'];

type Visit = {
  object?: (obj: Record<string, unknown>, rowId: string) => boolean | void;
  element?: (type: string, props: Record<string, unknown>, rowId: string, order: number) => void;
};

/**
 * Walks every JSON row in flight order (document order inside a row),
 * never descending into a NEVER_DESCEND key. `object` returning true stops the
 * descent into that object. References are not followed: every row is walked
 * on its own.
 */
export function walkRows(rows: Map<string, RowValue>, visit: Visit): void {
  let order = 0;
  for (const [rowId, row] of rows) {
    if (row.kind !== 'json') continue;
    const stack: unknown[] = [row.value];
    // Iterative pre-order walk: push children in reverse.
    while (stack.length) {
      const v = stack.pop();
      if (Array.isArray(v)) {
        if (v.length === 4 && v[0] === '$' && typeof v[1] === 'string' && v[3] && typeof v[3] === 'object' && !Array.isArray(v[3])) {
          visit.element?.(v[1], v[3] as Record<string, unknown>, rowId, order++);
        }
        for (let i = v.length - 1; i >= 0; i--) if (v[i] && typeof v[i] === 'object') stack.push(v[i]);
        continue;
      }
      if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        if (visit.object?.(o, rowId) === true) continue;
        const keys = Object.keys(o);
        for (let i = keys.length - 1; i >= 0; i--) {
          const k = keys[i];
          if (NEVER_DESCEND.test(k)) continue;
          const c = o[k];
          if (c && typeof c === 'object') stack.push(c);
        }
      }
    }
  }
}

/** A closed-list copy of description content: allowed keys only, references followed. */
export function pickDescription(rows: Map<string, RowValue>, v: unknown, depth = 0, seen: Set<string> = new Set()): unknown {
  if (depth > 200) return null;
  if (typeof v === 'string') {
    const ref = refOf(v);
    if (!ref) return scalarOf(v);
    if (seen.has(v)) return null;
    const next = new Set(seen).add(v);
    return pickDescription(rows, deref(rows, v), depth + 1, next);
  }
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) {
    if (v.length === 4 && v[0] === '$' && typeof v[1] === 'string') {
      // An element: keep its type as written ($L… names a client component), copy its props.
      return ['$', v[1], null, pickDescription(rows, v[3], depth + 1, seen) ?? {}];
    }
    return v.map((x) => pickDescription(rows, x, depth + 1, seen));
  }
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v)) {
    if (!DESCRIPTION_KEYS.has(k)) continue;
    out[k] = pickDescription(rows, (v as Record<string, unknown>)[k], depth + 1, seen);
  }
  return out;
}

function textOfRow(rows: Map<string, RowValue>, v: unknown): string {
  const r = deref(rows, v);
  return typeof r === 'string' ? r : '';
}

/** Finds the description element(s) in the order A → B → C → D → E (source-analysis §4; E found in P0). */
export function locateDescription(rows: Map<string, RowValue>, handle: string): DescriptionSource {
  type El = { type: string; props: Record<string, unknown>; rowId: string; order: number };
  const legacy: El[] = [];
  const sectionNavs: El[] = [];
  const bodies: El[] = [];
  const builders: El[] = [];
  const labelNavs: El[] = [];
  const shopifySections: El[] = [];
  const componentLists: El[] = [];
  walkRows(rows, {
    element: (type, props, rowId, order) => {
      const el = { type, props, rowId, order };
      if ('data' in props) {
        const list = deref(rows, props.data);
        if (Array.isArray(list) && list.length) {
          const first = deref(rows, list[0]);
          if (first && typeof first === 'object' && !Array.isArray(first) && 'componentType' in first) componentLists.push(el);
        }
      }
      if ('isOldVersion' in props && 'description' in props) legacy.push(el);
      const keys = Object.keys(props);
      if (keys.length === 1 && keys[0] === 'description') bodies.push(el);
      if ('config' in props) builders.push(el);
      if ('sections' in props) {
        const secs = deref(rows, props.sections);
        if (Array.isArray(secs) && secs.length) {
          const first = deref(rows, secs[0]);
          if (first && typeof first === 'object' && !Array.isArray(first)) {
            if ('name' in first) sectionNavs.push(el);
            else if ('label' in first) labelNavs.push(el);
          }
        }
      }
      const id = props.id;
      if (typeof id === 'string' && /shopify-section-template--.*__product_description_/.test(id)) shopifySections.push(el);
    },
  });
  if (legacy.length) {
    return { kind: 'legacy_html', html: textOfRow(rows, legacy[0].props.description) };
  }
  if (sectionNavs.length) {
    const nav = sectionNavs[0];
    const secs = (deref(rows, nav.props.sections) as unknown[]).map((s) => deref(rows, s) as Record<string, unknown>);
    const own = bodies.filter((b) => b.rowId === nav.rowId).sort((a, b) => a.order - b.order);
    return {
      kind: 'sections_html',
      sections: secs.map((s, i) => ({
        id: String(deref(rows, s.id) ?? ''),
        name: String(deref(rows, s.name) ?? ''),
        html: own[i] ? textOfRow(rows, own[i].props.description) : '',
      })),
    };
  }
  for (const b of builders) {
    const cfg = deref(rows, b.props.config);
    if (cfg && typeof cfg === 'object' && !Array.isArray(cfg) && 'schemaVersion' in cfg) {
      return { kind: 'page_builder', config: pickDescription(rows, cfg) };
    }
  }
  if (labelNavs.length) {
    const nav = labelNavs[0];
    const secs = (deref(rows, nav.props.sections) as unknown[]).map((s) => deref(rows, s) as Record<string, unknown>);
    const row = rows.get(nav.rowId);
    const out: DescriptionSource = {
      kind: 'bespoke_new',
      navSections: secs.map((s) => ({ id: String(deref(rows, s.id) ?? ''), label: String(deref(rows, s.label) ?? '') })),
      tree: row && row.kind === 'json' ? pickDescription(rows, row.value) : null,
    };
    const ns = MESSAGE_SPEC_NAMESPACES[handle];
    if (ns) {
      const table = readMessageSpecTable(rows, ns);
      if (table) out.specTable = table;
    }
    return out;
  }
  if (shopifySections.length) {
    // The row that holds most of the description sections is the description tree (the Python reference's choice).
    const counts = new Map<string, number>();
    for (const s of shopifySections) counts.set(s.rowId, (counts.get(s.rowId) ?? 0) + 1);
    let best = shopifySections[0].rowId;
    for (const [rowId, n] of counts) if (n > (counts.get(best) ?? 0)) best = rowId;
    const row = rows.get(best);
    return { kind: 'bespoke_shopify_port', tree: row && row.kind === 'json' ? pickDescription(rows, row.value) : null };
  }
  if (componentLists.length) {
    return { kind: 'component_list', components: pickComponents(rows, componentLists[0].props.data) };
  }
  return { kind: 'none' };
}

/** `messages.<ns>.SpecificationTable` as flat key/value strings, through the messages read list. */
function readMessageSpecTable(rows: Map<string, RowValue>, ns: string): Record<string, string> | null {
  let messages: unknown = null;
  walkRows(rows, {
    element: (_type, props) => {
      if (messages === null && 'messages' in props) {
        const m = deref(rows, props.messages);
        if (m && typeof m === 'object' && !Array.isArray(m) && ns in (m as object)) messages = m;
      }
    },
  });
  if (!messages) return null;
  const record = new Set<string>();
  const reader = new Reader({ rows, list: new Set(MESSAGES_READ_LIST), record }, messages, 'M');
  const nsReader = reader.obj(ns);
  const table = nsReader?.obj('SpecificationTable');
  if (!table) return null;
  const out: Record<string, string> = {};
  for (const k of table.keys()) {
    const v = table.str(k);
    if (v) out[k] = v;
  }
  return out;
}

/** Every object of the product's shape, resolved lazily (the walk stops at each). */
export function productCandidates(rows: Map<string, RowValue>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  walkRows(rows, {
    object: (o) => {
      if (PRODUCT_SHAPE.every((k) => k in o)) {
        out.push(o);
        return true;
      }
      return false;
    },
  });
  return out;
}

function readGroups(p: Reader): SourceGroup[] {
  return p
    .arr('productPropertyList')
    .map((g) => ({
      propertyKeyId: g.str('propertyKeyId'),
      propertyKey: g.str('propertyKey'),
      type: g.num('type') ?? 1,
      title: g.str('title'),
      position: g.num('position') ?? 0,
      values: g.arr('productPropertyValueList').map((v) => ({
        id: v.str('id'),
        value: v.str('value'),
        selectedDefault: v.bool('selectedDefault'),
        colorUrl: v.str('colorUrl'),
      })),
    }))
    .map((g, i) => ({ ...g, position: g.position || i + 1 }));
}

function readSkus(p: Reader): SourceSku[] {
  return p.arr('productSkuList').map((s) => {
    const mf = s.obj('mediaFile');
    const heroId = mf ? mf.str('resourceFileId') : '';
    const heroUrl = mf ? mf.str('url') : '';
    return {
      id: s.str('id'),
      props: s.arr('productSkuPropertyList').map((x) => ({
        propertyKeyId: x.str('propertyKeyId'),
        propertyKey: x.str('propertyKey'),
        value: x.str('propertyValue'),
      })),
      hero: heroId || heroUrl ? { resourceFileId: heroId, url: heroUrl } : null,
      description: s.str('description'),
      soldOut: s.bool('isSoldOut'),
    };
  });
}

/** Reads one product object through the closed list. */
export function readProduct(rows: Map<string, RowValue>, raw: unknown, record: Set<string>): Omit<Extraction, 'description' | 'jsonld'> {
  const p = new Reader({ rows, list: new Set(PRODUCT_READ_LIST), record }, raw, 'P');
  const seo = p.str('seoCode');
  return {
    sourceProductId: p.str('id'),
    handle: decodeHandle(seo),
    canonicalUrl: p.str('seoUrlHandle'),
    title: cleanText(p.str('name')),
    seoMetaDescription: cleanText(p.str('seoMetaDescription')),
    route: p.str('currentAllIdRoute'),
    isFilament: p.bool('isFilament'),
    groups: readGroups(p),
    skus: readSkus(p),
    gallery: p.arr('mediaFiles').map((m) => ({ resourceFileId: m.str('resourceFileId'), url: m.str('url') })),
    featuresTitle: cleanText(p.str('productFeaturesTitle')),
    features: p.arr('productFeaturesModuleList').map((f) => ({ title: cleanText(f.str('title')), html: f.str('content') })),
    videos: p.strArr('externalVideoLinkList').map((s) => s.trim()).filter(Boolean),
  };
}

/** Reads the JSON-LD identity fields through their closed list. */
export function readJsonLd(blocks: unknown[], record: Set<string>): Extraction['jsonld'] {
  const rows = new Map<string, RowValue>();
  for (const b of blocks) {
    const r = new Reader({ rows, list: new Set(JSONLD_READ_LIST), record }, b, 'LD');
    const type = r.str('@type');
    if (type !== 'ProductGroup' && type !== 'Product') continue;
    return {
      productGroupId: r.str('productGroupID'),
      variantSkus: r.arr('hasVariant').map((v) => v.str('sku')).filter(Boolean),
      brand: r.obj('brand')?.str('name') ?? '',
    };
  }
  return null;
}

/** The product object of a page: the largest candidate by number of variants and media (they are the same object, usually). */
function pickProduct(rows: Map<string, RowValue>, candidates: Array<Record<string, unknown>>): Record<string, unknown> | null {
  let best: Record<string, unknown> | null = null;
  let bestScore = -1;
  for (const c of candidates) {
    const skus = deref(rows, c.productSkuList);
    const media = deref(rows, c.mediaFiles);
    const score = (Array.isArray(skus) ? skus.length : 0) * 1000 + (Array.isArray(media) ? media.length : 0);
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

/** Extracts a page already split into rows (the entry the Proxy test drives). */
export function extractFromRows(rows: Map<string, RowValue>, jsonld: unknown[], stats: FlightStats): PageExtraction {
  const record = new Set<string>();
  const candidates = productCandidates(rows);
  const raw = pickProduct(rows, candidates);
  if (!raw) throw new ExtractError(rows.size ? 'PRODUCT_NOT_FOUND' : 'FLIGHT_EMPTY', 'no object of the product shape on the page');
  const product = readProduct(rows, raw, record);
  return {
    extraction: { ...product, description: locateDescription(rows, product.handle), jsonld: readJsonLd(jsonld, record) },
    reads: [...record].sort(),
    stats,
    productCandidates: candidates.length,
  };
}

/** Extracts a store page's HTML. */
export function extractPage(html: string): PageExtraction {
  const { rows, stats } = parseFlight(html);
  return extractFromRows(rows, jsonLdBlocks(html), stats);
}

/**
 * The same extraction from a trimmed sample fixture (`samples/*.json`:
 * `{product, description, jsonld}`), through the same closed lists. The
 * fixture's description is already the resolved element/HTML of its kind.
 */
export function extractionFromSample(sample: { product: unknown; description: unknown; jsonld: unknown }): PageExtraction {
  const record = new Set<string>();
  const rows = new Map<string, RowValue>();
  const product = readProduct(rows, sample.product, record);
  const d = (sample.description ?? {}) as Record<string, unknown>;
  let description: DescriptionSource = { kind: 'none' };
  switch (d.kind) {
    case 'legacy_html':
      description = { kind: 'legacy_html', html: typeof d.html === 'string' ? d.html : '' };
      break;
    case 'sections_html':
      description = {
        kind: 'sections_html',
        sections: (Array.isArray(d.sections) ? d.sections : []).map((s: Record<string, unknown>) => ({
          id: String(s.id ?? ''),
          name: String(s.name ?? ''),
          html: typeof s.html === 'string' ? s.html : '',
        })),
      };
      break;
    case 'page_builder':
      description = { kind: 'page_builder', config: pickDescription(rows, d.config) };
      break;
    case 'bespoke_shopify_port':
      description = { kind: 'bespoke_shopify_port', tree: pickDescription(rows, d.tree) };
      break;
    case 'bespoke_new':
      description = {
        kind: 'bespoke_new',
        navSections: (Array.isArray(d.nav_sections) ? d.nav_sections : []).map((s: Record<string, unknown>) => ({
          id: String(s.id ?? ''),
          label: String(s.label ?? ''),
        })),
        tree: pickDescription(rows, d.tree),
      };
      break;
  }
  const jsonld = readJsonLd(Array.isArray(sample.jsonld) ? sample.jsonld : [sample.jsonld], record);
  return {
    extraction: { ...product, description, jsonld },
    reads: [...record].sort(),
    stats: { chunks: 0, badChunks: 0, bytes: 0, rows: 0, badRows: 0 },
    productCandidates: 1,
  };
}

/**
 * The §C.1 identity cross-check: JSON-LD productGroupID equals P.id and every
 * hasVariant[].sku is one of P's variant ids. A disagreement is
 * IDENTITY_AMBIGUOUS. A page without JSON-LD is reported, not refused.
 */
export function identityCrossCheck(x: Extraction): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (!x.sourceProductId) problems.push('P.id is empty');
  if (!x.handle) problems.push('P.seoCode is empty');
  if (x.jsonld) {
    if (x.jsonld.productGroupId && x.jsonld.productGroupId !== x.sourceProductId) problems.push('JSON-LD productGroupID differs from P.id');
    const ids = new Set(x.skus.map((s) => s.id));
    const stray = x.jsonld.variantSkus.filter((s) => !ids.has(s));
    if (stray.length) problems.push(`${stray.length} JSON-LD variant(s) are not P variants`);
  }
  return { ok: problems.length === 0, problems };
}
