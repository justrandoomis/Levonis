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
 */
import { DOCUMENT_HOSTS, DOCUMENT_TITLES, type DocumentKind } from '@levonis/catalog/bambuImport/registry/documents';
import { specKey } from '@levonis/catalog/bambuImport/registry/specKeys';
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
  /** Only while the target is VISIBLE: the link. */
  product?: { id: string; slug: string; name: Tri; image: string };
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

/** The answer for one product, from its rows (§G.1). */
export function assembleKnowledge(rows: KnowledgeRows, media: KnowledgeMedia): ProductKnowledge {
  const out = emptyKnowledge();

  // -------------------------------------------------- specifications, logistics, the box
  const publicRows = rows.specs.filter((r) => !isOwnerOnlyKey(r.canonical_key, r.group_key));
  const groups = new Map<string, KnowledgeRow[]>();
  for (const r of publicRows) {
    const place = placementOf(r.canonical_key, r.group_key);
    if (place.kind === 'box') {
      out.in_the_box.push(...boxItemsWith(r, media.url));
      continue;
    }
    const row = knowledgeRowOf(r);
    if (!row) continue;
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
    out.documents.push({
      kind,
      title: { ar: text(d.title_ar, 300) || fallback.ar, en: text(d.title_en, 300) || fallback.en, ckb: text(d.title_ckb, 300) || fallback.ckb },
      url,
      host,
      scope: scopeOf(d.scope_kind, d.scope_id),
    });
  }

  // -------------------------------------------------- compatibility (a link only to a VISIBLE target)
  for (const r of rows.relations) {
    const bucket = compatibilityBucketOf(r.relation);
    if (!bucket) continue;
    const state = r.state === 'resolved' || r.state === 'pending' || r.state === 'unresolvable' ? r.state : 'pending';
    const id = typeof r.t_id === 'string' ? r.t_id : '';
    out.compatibility[bucket].push({
      relation: text(r.relation, 40),
      label: text(r.target_label, 300),
      target_kind: text(r.target_kind, 40),
      state,
      scope: scopeOf(r.scope_kind, r.scope_id),
      ...(id
        ? { product: { id, slug: text(r.t_slug, 200), name: tri(r.t_name_ar, r.t_name, r.t_name_ku), image: media.targetPicture?.(id) ?? '' } }
        : {}),
    });
  }

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
