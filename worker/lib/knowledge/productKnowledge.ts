/**
 * THE KNOWLEDGE ANSWER — `GET /api/products/:slug/knowledge` (the Bambu import
 * spec §G.1, §G.2, §G.4, §B.2; docs/DECISIONS.md rows 239 and 241).
 *
 * What a customer may read about a product beyond its page body: the typed
 * specifications with their provenance and status, the logistics facts, what is
 * in the box, compatibility, the official documents and how complete the
 * picture is. Loaded by the product page's lazy tabs when they near the
 * viewport — never on first paint.
 *
 * AN ALLOW-LIST, BUILT FIELD BY FIELD. Nothing is spread from a row. What never
 * leaves (row 241, the brief's money and privacy rule):
 *   - a row with `visibility = 'owner'`, and the registry's owner-only keys
 *     (manufacturer warranty notes, CBM `package.volume_m3`) even if a row
 *     forgot its visibility (L-4, L-19);
 *   - a `store_page` / `store_messages` reference (`source_ref`): the store's
 *     own page address is owner provenance. Only a public DOCUMENT gets a URL —
 *     a manual, TDS, SDS, wiki page or store-CDN document on an allow-listed
 *     host — and the store's own pages lose their title too (no store word
 *     reaches a customer);
 *   - `canonical_url`, a swatch's `source_url` / `hex_source_ref`, a document's
 *     tracker link, a relation's source handle or evidence, a conflict's text
 *     (only `conflict: true`), `derived_from`, `original_value`;
 *   - a resolved relation's product unless that product is VISIBLE (§B.6):
 *     otherwise the label alone.
 *
 * WITHOUT 0194 the answer is empty (CLAUDE.md rule 2): every read goes through
 * `knowledgeRead`, and a missing table answers `EMPTY_KNOWLEDGE`.
 *
 * EVERY PUBLIC ROW IS IN THE ANSWER ONCE. The import's live check (§I.1.2,
 * packages/catalog/src/bambuImport/fingerprint.ts `KnowledgeAnswer`) rebuilds
 * the public facts from it: `specs[].rows` hold every row but logistics and the
 * box, `logistics.*` the logistics rows (same row shape), `in_the_box` the box
 * items with their row's scope, region and status, plus `swatches`, `documents`
 * and the relations under `compatibility`.
 */
import { DOCUMENT_HOSTS, DOCUMENT_TITLES, type DocumentKind } from '@levonis/catalog/bambuImport/registry/documents';
import { specKey } from '@levonis/catalog/bambuImport/registry/specKeys';
import { canonicalProductMediaUrl } from '../productModel';
import { optimisticVisible, runListed } from '../listing';
import { productImageFromRelations } from '../productSelectionImage';
import type { ImageRow } from '../productOverlay';
import { isMissingKnowledgeSchema, knowledgeRead } from './schema';
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

const LOGISTICS_PARTS = ['product', 'package', 'shipment', 'carton'] as const;
type LogisticsPart = (typeof LOGISTICS_PARTS)[number];

const BOX_KEY = 'package.contents';

const scopeOf = (kind: unknown, id: unknown): KnowledgeScope => ({
  kind: kind === 'option_value' || kind === 'variant' ? kind : 'product',
  id: kind === 'option_value' || kind === 'variant' ? String(id ?? '') : '',
});

const regionOf = (v: unknown): Region => (v === 'us_110v' || v === 'intl_220v' ? v : '');

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

/** The box items of one `package.contents` row: strings, or `{text, qty, media_key?}` (0194 `value_list`). */
export function boxItemsOf(r: SpecValueDbRow): InTheBoxItem[] {
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
    const image = key ? canonicalProductMediaUrl(`/files/${key}`) : '';
    out.push({ text: itemText, qty, ...(image ? { image } : {}), ...base });
  }
  return out;
}

const SPEC_COLUMNS = `canonical_key, group_key, scope_kind, scope_id, region, data_type, original_label, value_text, value_num,
       value_num_max, value_bool, value_list, unit, status, source_kind, source_ref, source_title, source_locator,
       source_excerpt, test_method, test_condition, checked_sources, conflict, sort`;

const BUCKET_OF: Record<string, CompatibilityBucket> = {
  compatible_with: 'compatible',
  not_compatible_with: 'not_compatible',
  requires: 'requires',
  related: 'related',
  recommended_with: 'related',
  replacement_for: 'related',
  included_in: 'related',
  includes: 'related',
};

const tri = (ar: unknown, en: unknown, ckb: unknown): Tri => {
  const a = text(ar, 300);
  const e = text(en, 300);
  const k = text(ckb, 300);
  // A Sorani slot never copies the Arabic (row 183): English stands in when no Sorani was written.
  return { ar: a || e, en: e || a, ckb: k || e };
};

/**
 * A row's scope is LIVE: the product itself, or a value of an active group /
 * an active variant of this very product. The page body drops an inactive
 * group, an inactive value and an inactive variant (productOverlay.ts
 * `relationsBlock`), so a fact scoped to one of them — or to one deleted since —
 * is off-screen everywhere: it never reaches the answer, the edge or a tab's
 * «إصدارات أخرى». A condition on the same statement: no new wave.
 */
const scopeLive = (a: string) => `CASE ${a}.scope_kind
      WHEN 'option_value' THEN EXISTS (SELECT 1 FROM product_option_values lv JOIN product_option_groups lg ON lg.id = lv.group_id
                                        WHERE lv.id = ${a}.scope_id AND lv.product_id = ${a}.product_id AND lv.active = 1 AND lg.active = 1)
      WHEN 'variant' THEN EXISTS (SELECT 1 FROM product_variants lx WHERE lx.id = ${a}.scope_id AND lx.product_id = ${a}.product_id AND lx.active = 1)
      ELSE 1 END`;

// ------------------------------------------------------------------ the read

/**
 * Everything `/knowledge` answers for one VISIBLE product (the route checked
 * that). ONE WAVE of six statements — the pictures of the relation targets
 * ride it too, their ids a subquery of the relation read's own rule, so an
 * imported printer linking its AMS, plates and filaments costs no dependent
 * round trip (tests/d1Waves.test.ts measures that path). Empty without 0194.
 * A fact scoped to a value or variant the page body no longer shows is left
 * out (`scopeLive`).
 */
export async function loadProductKnowledge(db: D1Database, productId: string): Promise<ProductKnowledge> {
  const visibleTarget = optimisticVisible(db, 't');
  const [specRows, docRows, relationRows, swatchRows, sourceRows, targetImages] = await Promise.all([
    knowledgeRead(db, async () =>
      (
        await db
          .prepare(`SELECT ${SPEC_COLUMNS} FROM product_spec_values s WHERE s.product_id = ? AND s.visibility = 'public' AND ${scopeLive('s')}
                     ORDER BY sort, canonical_key, scope_kind, scope_id, region`)
          .bind(productId)
          .all<SpecValueDbRow>()
      ).results ?? []
    ),
    knowledgeRead(db, async () =>
      (
        await db
          .prepare(`SELECT d.kind, d.title_en, d.title_ar, d.title_ckb, d.url, d.host, d.scope_kind, d.scope_id FROM product_documents d
                     WHERE d.product_id = ? AND d.active = 1 AND ${scopeLive('d')} ORDER BY d.sort, d.kind, d.url`)
          .bind(productId)
          .all<Record<string, unknown>>()
      ).results ?? []
    ),
    knowledgeRead(db, async () =>
      (
        await runListed(
          db,
          `SELECT r.relation, r.target_kind, r.target_label, r.state, r.scope_kind, r.scope_id,
                  t.id AS t_id, t.slug AS t_slug, t.name AS t_name, t.name_ar AS t_name_ar, t.name_ku AS t_name_ku
             FROM product_relations r
             LEFT JOIN products t ON t.id = r.target_product_id AND r.state = 'resolved' AND COALESCE(t.composition, '') = '' AND ${visibleTarget}
            WHERE r.product_id = ? AND ${scopeLive('r')}
            ORDER BY r.relation, r.scope_kind, r.scope_id, r.target_label`,
          (q) => db.prepare(q).bind(productId).all<Record<string, unknown>>()
        )
      ).results ?? []
    ),
    knowledgeRead(db, async () =>
      (
        await db
          .prepare(`SELECT s.option_value_id, s.url, s.width, s.height, s.published_hex
                      FROM product_option_value_swatches s
                      JOIN product_option_values v ON v.id = s.option_value_id AND v.product_id = s.product_id AND v.active = 1
                      JOIN product_option_groups g ON g.id = v.group_id AND g.active = 1
                     WHERE s.product_id = ? ORDER BY s.option_value_id`)
          .bind(productId)
          .all<Record<string, unknown>>()
      ).results ?? []
    ),
    // The route is read only to know the product's TYPE (its expected keys); it never leaves the Worker.
    knowledgeRead(db, async () =>
      (
        await db
          .prepare('SELECT source_route FROM product_source_refs WHERE product_id = ? ORDER BY source, source_product_id LIMIT 1')
          .bind(productId)
          .all<{ source_route: string }>()
      ).results ?? []
    ),
    // The pictures of the targets a customer may follow (resolved, VISIBLE, not a composition, a live
    // scope): every image row, the picture chosen below exactly as every card's. A failure that is not
    // a missing 0194 costs the pictures, never the answer (as loadAuthoritativeProductImages).
    knowledgeRead(db, async () => {
      try {
        return (
          (
            await runListed(
              db,
              `SELECT i.* FROM product_images i
                WHERE i.product_id IN (SELECT r.target_product_id FROM product_relations r
                                         JOIN products t ON t.id = r.target_product_id AND COALESCE(t.composition, '') = '' AND ${visibleTarget}
                                        WHERE r.product_id = ? AND r.state = 'resolved' AND ${scopeLive('r')})
                ORDER BY i.product_id, i.sort_order, i.id`,
              (q) => db.prepare(q).bind(productId).all<ImageRow>()
            )
          ).results ?? []
        );
      } catch (e) {
        if (isMissingKnowledgeSchema(e)) throw e;
        console.error(`knowledge: relation target pictures unavailable: ${e instanceof Error ? e.message : String(e)}`);
        return [] as ImageRow[];
      }
    }),
  ]);
  if (!specRows || !docRows || !relationRows || !swatchRows || !sourceRows || !targetImages) return emptyKnowledge();
  const out = emptyKnowledge();

  // -------------------------------------------------- specifications, logistics, the box
  const publicRows = specRows.filter((r) => !isOwnerOnlyKey(r.canonical_key, r.group_key));
  const groups = new Map<string, KnowledgeRow[]>();
  for (const r of publicRows) {
    const key = r.canonical_key;
    if (key === BOX_KEY) {
      out.in_the_box.push(...boxItemsOf(r));
      continue;
    }
    const row = knowledgeRowOf(r);
    if (!row) continue;
    const part = key.split('.')[0] as LogisticsPart;
    if ((LOGISTICS_PARTS as readonly string[]).includes(part)) {
      out.logistics[part].push(row);
      continue;
    }
    const group = text(r.group_key, 40) || 'other';
    const list = groups.get(group);
    if (list) list.push(row);
    else groups.set(group, [row]);
  }
  const order = (g: string) => {
    const i = GROUP_ORDER.indexOf(g);
    return i < 0 ? GROUP_ORDER.length : i;
  };
  out.specs = [...groups.entries()]
    .sort(([a], [b]) => order(a) - order(b) || (a < b ? -1 : a > b ? 1 : 0))
    .map(([group, rows]) => ({ group, label: groupLabel(group), rows }));
  if (publicRows.length) {
    const c = completenessOf(
      publicRows.map((r) => ({ key: r.canonical_key, status: r.status })),
      sourceRows[0]?.source_route ?? null
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
  for (const d of docRows) {
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
  const imagesOf = new Map<string, ImageRow[]>();
  for (const image of targetImages) imagesOf.set(image.product_id, [...(imagesOf.get(image.product_id) ?? []), image]);
  const pictures = new Map([...imagesOf].map(([id, rows]) => [id, productImageFromRelations(rows)]));
  for (const r of relationRows) {
    const bucket = BUCKET_OF[text(r.relation, 40)];
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
        ? { product: { id, slug: text(r.t_slug, 200), name: tri(r.t_name_ar, r.t_name, r.t_name_ku), image: pictures.get(id) ?? '' } }
        : {}),
    });
  }

  // -------------------------------------------------- swatches (the same facts the page body's relations carry: active values of active groups)
  for (const s of swatchRows) {
    const url = canonicalProductMediaUrl(s.url);
    const hex = typeof s.published_hex === 'string' && /^#[0-9A-F]{6}$/.test(s.published_hex) ? s.published_hex : '';
    if (!url && !hex) continue;
    const dim = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.trunc(n) : null);
    out.swatches.push({ option_value_id: text(s.option_value_id, 80), url, width: dim(s.width), height: dim(s.height), published_hex: hex });
  }
  return out;
}
