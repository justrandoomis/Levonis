/**
 * THE KNOWLEDGE ANSWER'S SHAPE AND RULES, WITHOUT THE DATABASE (the Bambu
 * import spec §G.1, §G.2, §G.4, §I.1.2).
 *
 * `GET /api/products/:slug/knowledge` (productKnowledge.ts) reads the 0194 rows
 * and hands them here; the import's runner (scripts/bambu-import/verify.ts)
 * hands the same functions the rows its payload makes, so what VERIFY expects
 * is what the route answers by construction — one rule set, not a copy. This
 * module is pure: it imports the shared package and this directory's
 * vocabulary, never a binding, never `worker/lib` beyond that. The two things
 * only the Worker knows (which `/files/…` address is a customer's picture, and
 * a relation target's picture) come in as `KnowledgeMedia`.
 *
 * What never leaves (row 241, the brief's money and privacy rule) is decided
 * here, field by field — nothing is spread from a row:
 *   - the registry's owner-only keys (manufacturer warranty notes, CBM
 *     `package.volume_m3`) even if a row forgot its visibility (L-4, L-19);
 *   - a `store_page` / `store_messages` reference: the store's own page
 *     address is owner provenance, and those sources lose their title too.
 *     Only a public DOCUMENT (manual, TDS, SDS, wiki, store-CDN document) on an
 *     allow-listed host gets a URL;
 *   - a conflict's text (only `conflict: true`), `derived_from`,
 *     `original_value`; a relation's source handle or evidence.
 *
 * THE IMPORTED ENGLISH IN ARABIC AND SORANI (docs/bambu-import/I18N-DESIGN.md
 * §A.5): with a translation memory (`AssembleOptions.translations`, the rows
 * of 0196 the product's refs name) a value, a list item, an `x.*` label, a
 * test method, a box item or a relation label that has a translation carries
 * it in an OPTIONAL `*_i18n` field beside the English, and a document's title
 * takes it for ar/ckb. Without one the answer is exactly as before. VERIFY's
 * projection never reads a `*_i18n` field.
 *
 * COMPATIBILITY IS ONE ITEM PER TARGET LABEL (§C.1): rows of a bucket, a
 * relation and a label (`labelKey`) are one item — a product-wide fact covers
 * every selection, so it absorbs the same label scoped to a value or a
 * variant — and every visible target of the group rides on it as links
 * (`product`, then `more`). The grouping never reads visibility, so the
 * runner's expectation (no targets) and the route's answer (links) agree.
 */
import { DOCUMENT_HOSTS, DOCUMENT_TITLES, type DocumentKind } from '@levonis/catalog/bambuImport/registry/documents';
import { specKey } from '@levonis/catalog/bambuImport/registry/specKeys';
import { normalizeSource, type Tr } from '@levonis/catalog/bambuImport/i18n';
import { labelKey } from '@levonis/catalog/bambuImport/normalize';
import { completenessOf, type CompletenessCounts } from './completeness';
import { GROUP_ORDER, groupLabel, isSpecStatus, type SpecStatus, type Tri } from './labels';

// ------------------------------------------------------------------ the shapes

export type ScopeKind = 'product' | 'option_value' | 'variant';
export type Region = '' | 'us_110v' | 'intl_220v';

export interface KnowledgeScope {
  kind: ScopeKind;
  id: string;
}

export interface KnowledgeSource {
  /** The row's `source_kind` code (`store_page`, `tds`, `wiki`, `curated` …); the page words it. */
  kind: string;
  /** The source's title; '' for the store's own pages (no store word reaches a customer). */
  title: string;
  locator: string;
  excerpt: string;
  /** Only a public document (manual, TDS, SDS, wiki, store-CDN document) on an allow-listed host. */
  url?: string;
}

export interface CheckedSource {
  kind: string;
  title: string;
  url?: string;
}

export interface KnowledgeRow {
  key: string;
  label: Tri;
  value_text: string;
  value_num: number | null;
  value_num_max: number | null;
  value_bool: boolean | null;
  /** The items of a list fact (supported filaments, certifications …); absent on every other row. */
  items?: string[];
  unit: string;
  status: SpecStatus;
  region: Region;
  scope: KnowledgeScope;
  source: KnowledgeSource;
  /** `not_found` rows only: the sources actually checked (the «المصادر التي رُوجعت» popover). */
  checked_sources?: CheckedSource[];
  test_method: string;
  test_condition: string;
  conflict: boolean;
  /** false: a code for filters (the product family), not a line for the specifications table. */
  display: boolean;
  /** The memory's Arabic and Sorani of `value_text`, when it has them (§A.5). */
  value_i18n?: Tr;
  /** Per item of `items`, its translation or null; present only when one item has one. */
  items_i18n?: Array<Tr | null>;
  /** The translation of an `x.*` row's own label (a registry key's label is authored). */
  label_i18n?: Tr;
  test_method_i18n?: Tr;
}

export interface KnowledgeGroup {
  group: string;
  label: Tri;
  rows: KnowledgeRow[];
}

export interface InTheBoxItem {
  text: string;
  qty: number | null;
  /** Our own `/files/…webp` picture of the item, when the import stored one. */
  image?: string;
  scope: KnowledgeScope;
  region: Region;
  status: SpecStatus;
  /** The memory's Arabic and Sorani of `text`, when it has them. */
  text_i18n?: Tr;
}

export type CompatibilityBucket = 'compatible' | 'not_compatible' | 'requires' | 'related';

export interface CompatibilityItem {
  /** The 0194 relation (`compatible_with`, `recommended_with`, `includes` …). */
  relation: string;
  /** The source's own words for the target. */
  label: string;
  target_kind: string;
  state: 'resolved' | 'pending' | 'unresolvable';
  scope: KnowledgeScope;
  /** Only while a target is VISIBLE: the link (the first visible target by slug). */
  product?: CompatibilityTarget;
  /** The other visible targets of the same label (a family that names several products), by slug. */
  more?: CompatibilityTarget[];
  /** The memory's Arabic and Sorani of a label that is not a name. */
  label_i18n?: Tr;
}

export interface CompatibilityTarget {
  id: string;
  slug: string;
  name: Tri;
  image: string;
}

export interface KnowledgeDocument {
  kind: string;
  title: Tri;
  url: string;
  host: string;
  scope: KnowledgeScope;
}

export interface KnowledgeSwatch {
  option_value_id: string;
  url: string;
  width: number | null;
  height: number | null;
  published_hex: string;
}

export interface ProductKnowledge {
  specs: KnowledgeGroup[];
  logistics: { product: KnowledgeRow[]; package: KnowledgeRow[]; shipment: KnowledgeRow[]; carton: KnowledgeRow[] };
  in_the_box: InTheBoxItem[];
  compatibility: Record<CompatibilityBucket, CompatibilityItem[]>;
  documents: KnowledgeDocument[];
  swatches: KnowledgeSwatch[];
  /** Over the expected keys of the product's type, public rows only; null while it has no knowledge row. */
  completeness: CompletenessCounts | null;
}

export const emptyKnowledge = (): ProductKnowledge => ({
  specs: [],
  logistics: { product: [], package: [], shipment: [], carton: [] },
  in_the_box: [],
  compatibility: { compatible: [], not_compatible: [], requires: [], related: [] },
  documents: [],
  swatches: [],
  completeness: null,
});

// ------------------------------------------------------------------ the rules

/** The source kinds that point at a public DOCUMENT (§G.1 "official document, wiki, TDS and SDS"). */
const PUBLIC_DOCUMENT_SOURCES: ReadonlySet<string> = new Set(['manual', 'tds', 'sds', 'wiki', 'store_doc']);
/** The store's own pages: their address and their title are owner provenance. */
const STORE_SOURCES: ReadonlySet<string> = new Set(['store_page', 'store_messages']);

/** An https URL on a host the registry allows for documents; anything else is never a customer link. */
export function publicDocumentUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  if (!DOCUMENT_HOSTS.has(url.hostname.toLowerCase())) return null;
  return url.toString();
}

/** Keys a customer never reads, whatever a row's visibility says: CBM and the manufacturer's warranty notes. */
export function isOwnerOnlyKey(key: string, group = ''): boolean {
  if (specKey(key)?.ownerOnly) return true;
  if (group === 'manufacturer_terms' || key.startsWith('manufacturer_terms.')) return true;
  return /volume_m3|(^|[._])cbm($|[._])/i.test(key);
}

/** Codes for filters, not lines for the table (the importer's facet mirror of the family). */
const NOT_DISPLAYED_KEYS: ReadonlySet<string> = new Set(['identity.family']);

export const LOGISTICS_PARTS = ['product', 'package', 'shipment', 'carton'] as const;
export type LogisticsPart = (typeof LOGISTICS_PARTS)[number];

/** The box: its rows become `in_the_box` items, never a spec line. */
export const BOX_KEY = 'package.contents';

/** Where a public row is drawn: the box, a logistics part, or its spec group. */
export function placementOf(key: string, groupKey: string): { kind: 'box' } | { kind: 'logistics'; part: LogisticsPart } | { kind: 'group'; group: string } {
  if (key === BOX_KEY) return { kind: 'box' };
  const part = key.split('.')[0];
  if ((LOGISTICS_PARTS as readonly string[]).includes(part)) return { kind: 'logistics', part: part as LogisticsPart };
  return { kind: 'group', group: text(groupKey, 40) || 'other' };
}

export const scopeOf = (kind: unknown, id: unknown): KnowledgeScope => ({
  kind: kind === 'option_value' || kind === 'variant' ? kind : 'product',
  id: kind === 'option_value' || kind === 'variant' ? String(id ?? '') : '',
});

export const regionOf = (v: unknown): Region => (v === 'us_110v' || v === 'intl_220v' ? v : '');

const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const text = (v: unknown, max = 1000): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw.trim() === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** The label of a key: the registry's three languages, or the source's own words for an `x.*` key. */
function rowLabel(key: string, originalLabel: string): Tri {
  const def = specKey(key);
  if (def) return def.labels;
  const words = originalLabel || key.replace(/^x\./, '').replace(/[-_]/g, ' ');
  return { ar: words, en: words, ckb: words };
}

// ------------------------------------------------------------------ rows

/** One 0194 `product_spec_values` row, as far as the answer reads it. */
export interface SpecValueDbRow {
  canonical_key: string;
  group_key: string;
  scope_kind: string;
  scope_id: string;
  region: string;
  data_type: string;
  original_label: string;
  value_text: string;
  value_num: number | null;
  value_num_max: number | null;
  value_bool: number | null;
  value_list: string;
  unit: string;
  status: string;
  source_kind: string;
  source_ref: string;
  source_title: string;
  source_locator: string;
  source_excerpt: string;
  test_method: string;
  test_condition: string;
  checked_sources: string;
  conflict: string;
  sort: number;
}

/** One public row as the customer reads it (the caller has already dropped owner rows and keys). */
export function knowledgeRowOf(r: SpecValueDbRow): KnowledgeRow | null {
  if (!isSpecStatus(r.status)) return null;
  const kind = text(r.source_kind, 40);
  const url = PUBLIC_DOCUMENT_SOURCES.has(kind) ? publicDocumentUrl(r.source_ref) : null;
  const source: KnowledgeSource = {
    kind,
    title: STORE_SOURCES.has(kind) ? '' : text(r.source_title, 200),
    locator: text(r.source_locator, 200),
    excerpt: text(r.source_excerpt, 200),
    ...(url ? { url } : {}),
  };
  const row: KnowledgeRow = {
    key: r.canonical_key,
    label: rowLabel(r.canonical_key, text(r.original_label, 200)),
    value_text: text(r.value_text),
    value_num: numOrNull(r.value_num),
    value_num_max: numOrNull(r.value_num_max),
    value_bool: r.value_bool === 1 ? true : r.value_bool === 0 ? false : null,
    unit: text(r.unit, 20),
    status: r.status,
    region: regionOf(r.region),
    scope: scopeOf(r.scope_kind, r.scope_id),
    source,
    test_method: text(r.test_method, 200),
    test_condition: text(r.test_condition, 200),
    conflict: text(r.conflict) !== '',
    display: !NOT_DISPLAYED_KEYS.has(r.canonical_key),
  };
  if (r.data_type === 'list') {
    const items = parseJson<unknown[]>(r.value_list, []).filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim().slice(0, 200));
    if (items.length) row.items = items.slice(0, 50);
  }
  if (r.status === 'not_found') {
    const checked = parseJson<unknown[]>(r.checked_sources, [])
      .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x))
      .slice(0, 10)
      .map((x) => {
        const k = text(x.kind, 40);
        const link = PUBLIC_DOCUMENT_SOURCES.has(k) ? publicDocumentUrl(x.url) : null;
        return { kind: k, title: STORE_SOURCES.has(k) ? '' : text(x.title, 200), ...(link ? { url: link } : {}) };
      });
    row.checked_sources = checked;
  }
  return row;
}

/**
 * The box items of one `package.contents` row: strings, or `{text, qty, media_key?}` (0194 `value_list`). An
 * item's picture is `mediaUrl('/files/<media_key>')` — the Worker's own canonical-address rule.
 */
export function boxItemsWith(r: SpecValueDbRow, mediaUrl: (raw: string) => string): InTheBoxItem[] {
  if (!isSpecStatus(r.status)) return [];
  const base = { scope: scopeOf(r.scope_kind, r.scope_id), region: regionOf(r.region), status: r.status };
  const out: InTheBoxItem[] = [];
  for (const raw of parseJson<unknown[]>(r.value_list, []).slice(0, 100)) {
    if (typeof raw === 'string') {
      if (raw.trim()) out.push({ text: raw.trim().slice(0, 200), qty: null, ...base });
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const itemText = text(item.text, 200);
    if (!itemText) continue;
    const qty = typeof item.qty === 'number' && Number.isInteger(item.qty) && item.qty > 0 ? item.qty : null;
    const key = text(item.media_key, 300);
    const image = key ? mediaUrl(`/files/${key}`) : '';
    out.push({ text: itemText, qty, ...(image ? { image } : {}), ...base });
  }
  return out;
}

const BUCKET_OF: Readonly<Record<string, CompatibilityBucket>> = {
  compatible_with: 'compatible',
  not_compatible_with: 'not_compatible',
  requires: 'requires',
  related: 'related',
  recommended_with: 'related',
  replacement_for: 'related',
  included_in: 'related',
  includes: 'related',
};

/** The compatibility list a relation is drawn in; null for a relation the answer does not carry. */
export function compatibilityBucketOf(relation: unknown): CompatibilityBucket | null {
  return BUCKET_OF[text(relation, 40)] ?? null;
}

const tri = (ar: unknown, en: unknown, ckb: unknown): Tri => {
  const a = text(ar, 300);
  const e = text(en, 300);
  const k = text(ckb, 300);
  // A Sorani slot never copies the Arabic (row 183): English stands in when no Sorani was written.
  return { ar: a || e, en: e || a, ckb: k || e };
};

// ------------------------------------------------------------------ the whole answer

/**
 * The rows of one product the answer is made of. The ROUTE reads them from
 * D1 already narrowed to what may show: public rows, active documents, and
 * every row on a LIVE scope (the product, an active value of an active group,
 * an active variant — productKnowledge.ts `scopeLive`); swatches of active
 * values of active groups. Whoever else builds them narrows them the same way.
 */
export interface KnowledgeRows {
  specs: readonly SpecValueDbRow[];
  /** `kind, title_en, title_ar, title_ckb, url, host, scope_kind, scope_id`. */
  documents: ReadonlyArray<Record<string, unknown>>;
  /** `relation, target_kind, target_label, state, scope_kind, scope_id`, and `t_id, t_slug, t_name, t_name_ar, t_name_ku` of a VISIBLE target. */
  relations: ReadonlyArray<Record<string, unknown>>;
  /** `option_value_id, url, width, height, published_hex`. */
  swatches: ReadonlyArray<Record<string, unknown>>;
  /** `product_source_refs.source_route` (the product's TYPE, for completeness); null when none. */
  sourceRoute: string | null;
}

/** What only the Worker knows about pictures. */
export interface KnowledgeMedia {
  /** A stored `/files/…` address → the customer's canonical picture URL, or '' when it is not one. */
  url(raw: string): string;
  /** A VISIBLE relation target's picture, by product id ('' when it has none). */
  targetPicture?(productId: string): string;
}

/** What else the Worker knows: the translation memory of the product (normalized English → ar/ckb, §A.5). */
export interface AssembleOptions {
  translations?: ReadonlyMap<string, Tr>;
}

/** One text's translation in the memory, or undefined. */
function trOf(tm: ReadonlyMap<string, Tr> | undefined, s: string): Tr | undefined {
  if (!tm || tm.size === 0 || !s) return undefined;
  const t = tm.get(normalizeSource(s));
  return t && t.ar && t.ckb ? { ar: t.ar, ckb: t.ckb } : undefined;
}

/** A row with the memory's translations of its own words, as optional fields (absent without one). */
function withRowTranslations(row: KnowledgeRow, tm: ReadonlyMap<string, Tr> | undefined): KnowledgeRow {
  if (!tm || tm.size === 0) return row;
  const value = row.value_text ? trOf(tm, row.value_text) : undefined;
  if (value) row.value_i18n = value;
  if (row.items?.length) {
    const items = row.items.map((x) => trOf(tm, x) ?? null);
    if (items.some(Boolean)) row.items_i18n = items;
  }
  if (!specKey(row.key)) {
    const label = trOf(tm, row.label.en);
    if (label) row.label_i18n = label;
  }
  const method = row.test_method ? trOf(tm, row.test_method) : undefined;
  if (method) row.test_method_i18n = method;
  return row;
}

/**
 * COMPATIBILITY, ONE ITEM PER TARGET LABEL (I18N-DESIGN §C.1). Rows are grouped
 * by bucket, relation and `labelKey(label)`; a group holding a product-scoped
 * row yields one product-scoped item (a product-wide fact already applies to
 * every selection), any other group one item per distinct scope. The item's
 * label is the code-point-smallest of its rows (any input order, the same
 * answer), its target kind the smallest, its state `resolved` if any row is,
 * else `pending`, else `unresolvable`; its visible targets, distinct by id and
 * ordered by slug, are `product` and then `more`. Nothing here reads which
 * target is visible to decide WHAT the items are — only to decorate them — so
 * the runner's expectation (rows without targets) and the route's answer
 * (rows with links) are the same items.
 */
export interface CompatRow {
  bucket: CompatibilityBucket;
  relation: string;
  label: string;
  target_kind: string;
  state: CompatibilityItem['state'];
  scope: KnowledgeScope;
  target?: CompatibilityTarget;
}

const cpLess = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function dedupeCompatibility(list: readonly CompatRow[], tm?: ReadonlyMap<string, Tr>): Record<CompatibilityBucket, CompatibilityItem[]> {
  const out: Record<CompatibilityBucket, CompatibilityItem[]> = { compatible: [], not_compatible: [], requires: [], related: [] };
  const groups = new Map<string, CompatRow[]>();
  for (const r of list) {
    const k = `${r.bucket}|${r.relation}|${labelKey(r.label)}`;
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  const STATE_RANK: Record<CompatibilityItem['state'], number> = { resolved: 0, pending: 1, unresolvable: 2 };
  const items: Array<{ bucket: CompatibilityBucket; item: CompatibilityItem }> = [];
  for (const rowsOfGroup of groups.values()) {
    const productWide = rowsOfGroup.some((r) => r.scope.kind === 'product');
    const byScope = new Map<string, CompatRow[]>();
    for (const r of rowsOfGroup) {
      if (productWide && r.scope.kind !== 'product') continue;
      const k = productWide ? 'product|' : `${r.scope.kind}|${r.scope.id}`;
      const g = byScope.get(k);
      if (g) g.push(r);
      else byScope.set(k, [r]);
    }
    for (const rs of byScope.values()) {
      // The visible targets of the label: every row's of a product-wide item (the scoped rows it absorbed name the
      // same products), this scope's rows' otherwise.
      const targets = new Map<string, CompatibilityTarget>();
      for (const r of productWide ? rowsOfGroup : rs) if (r.target && !targets.has(r.target.id)) targets.set(r.target.id, r.target);
      const sortedTargets = [...targets.values()].sort((a, b) => cpLess(a.slug, b.slug) || cpLess(a.id, b.id));
      const label = rowsOfGroup.map((r) => r.label).sort(cpLess)[0];
      const kind = rowsOfGroup.map((r) => r.target_kind).sort(cpLess)[0];
      const state = rowsOfGroup.map((r) => r.state).sort((a, b) => STATE_RANK[a] - STATE_RANK[b])[0];
      const first = rs[0];
      const labelTr = trOf(tm, label);
      items.push({
        bucket: first.bucket,
        item: {
          relation: first.relation,
          label,
          target_kind: kind,
          state,
          scope: productWide ? { kind: 'product', id: '' } : first.scope,
          ...(sortedTargets.length ? { product: sortedTargets[0] } : {}),
          ...(sortedTargets.length > 1 ? { more: sortedTargets.slice(1) } : {}),
          ...(labelTr ? { label_i18n: labelTr } : {}),
        },
      });
    }
  }
  // A stable order whatever the rows' order: relation, then label, then scope.
  items.sort(
    (a, b) =>
      cpLess(a.item.relation, b.item.relation) ||
      cpLess(labelKey(a.item.label), labelKey(b.item.label)) ||
      cpLess(a.item.label, b.item.label) ||
      cpLess(a.item.scope.kind, b.item.scope.kind) ||
      cpLess(a.item.scope.id, b.item.scope.id)
  );
  for (const { bucket, item } of items) out[bucket].push(item);
  return out;
}

/** The answer for one product, from its rows (§G.1), with the memory's translations when given (§A.5). */
export function assembleKnowledge(rows: KnowledgeRows, media: KnowledgeMedia, opts: AssembleOptions = {}): ProductKnowledge {
  const out = emptyKnowledge();
  const tm = opts.translations && opts.translations.size ? opts.translations : undefined;

  // -------------------------------------------------- specifications, logistics, the box
  const publicRows = rows.specs.filter((r) => !isOwnerOnlyKey(r.canonical_key, r.group_key));
  const groups = new Map<string, KnowledgeRow[]>();
  for (const r of publicRows) {
    const place = placementOf(r.canonical_key, r.group_key);
    if (place.kind === 'box') {
      for (const item of boxItemsWith(r, media.url)) {
        const t = trOf(tm, item.text);
        out.in_the_box.push(t ? { ...item, text_i18n: t } : item);
      }
      continue;
    }
    const plain = knowledgeRowOf(r);
    if (!plain) continue;
    const row = withRowTranslations(plain, tm);
    if (place.kind === 'logistics') {
      out.logistics[place.part].push(row);
      continue;
    }
    const list = groups.get(place.group);
    if (list) list.push(row);
    else groups.set(place.group, [row]);
  }
  const order = (g: string) => {
    const i = GROUP_ORDER.indexOf(g);
    return i < 0 ? GROUP_ORDER.length : i;
  };
  out.specs = [...groups.entries()]
    .sort(([a], [b]) => order(a) - order(b) || (a < b ? -1 : a > b ? 1 : 0))
    .map(([group, list]) => ({ group, label: groupLabel(group), rows: list }));
  if (publicRows.length) {
    const c = completenessOf(
      publicRows.map((r) => ({ key: r.canonical_key, status: r.status })),
      rows.sourceRoute
    );
    // Counts only: the customer is told how complete the picture is, not the staff card's key list or ratio.
    out.completeness = {
      applicable: c.applicable,
      verified: c.verified,
      unverified: c.unverified,
      not_found: c.not_found,
      not_published: c.not_published,
      unknown: c.unknown,
    };
  }

  // -------------------------------------------------- documents
  for (const d of rows.documents) {
    const url = publicDocumentUrl(d.url);
    if (!url) continue;
    const host = new URL(url).hostname.toLowerCase();
    if (text(d.host, 200).toLowerCase() !== host) continue;
    const kind = text(d.kind, 40) as DocumentKind;
    const fallback = DOCUMENT_TITLES[kind] ?? DOCUMENT_TITLES.other;
    const titleTr = trOf(tm, text(d.title_en, 300));
    out.documents.push({
      kind,
      title: titleTr
        ? { ar: titleTr.ar, en: text(d.title_en, 300), ckb: titleTr.ckb }
        : { ar: text(d.title_ar, 300) || fallback.ar, en: text(d.title_en, 300) || fallback.en, ckb: text(d.title_ckb, 300) || fallback.ckb },
      url,
      host,
      scope: scopeOf(d.scope_kind, d.scope_id),
    });
  }

  // -------------------------------------------------- compatibility (one item per label; a link only to a VISIBLE target)
  const compat: CompatRow[] = [];
  for (const r of rows.relations) {
    const bucket = compatibilityBucketOf(r.relation);
    if (!bucket) continue;
    const state = r.state === 'resolved' || r.state === 'pending' || r.state === 'unresolvable' ? r.state : 'pending';
    const id = typeof r.t_id === 'string' ? r.t_id : '';
    compat.push({
      bucket,
      relation: text(r.relation, 40),
      label: text(r.target_label, 300),
      target_kind: text(r.target_kind, 40),
      state,
      scope: scopeOf(r.scope_kind, r.scope_id),
      ...(id ? { target: { id, slug: text(r.t_slug, 200), name: tri(r.t_name_ar, r.t_name, r.t_name_ku), image: media.targetPicture?.(id) ?? '' } } : {}),
    });
  }
  out.compatibility = dedupeCompatibility(compat, tm);

  // -------------------------------------------------- swatches (the same facts the page body's relations carry: active values of active groups)
  for (const s of rows.swatches) {
    const url = typeof s.url === 'string' ? media.url(s.url) : '';
    const hex = typeof s.published_hex === 'string' && /^#[0-9A-F]{6}$/.test(s.published_hex) ? s.published_hex : '';
    if (!url && !hex) continue;
    const dim = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.trunc(n) : null);
    out.swatches.push({ option_value_id: text(s.option_value_id, 80), url, width: dim(s.width), height: dim(s.height), published_hex: hex });
  }
  return out;
}
