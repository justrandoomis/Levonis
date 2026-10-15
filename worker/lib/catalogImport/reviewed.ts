/**
 * THE REVIEWED SCOPE OF THE CATALOGUE IMPORT, AS THE WORKER ENFORCES IT
 * (Bambu import spec §A.3 "The reviewed scope", §B.6, §C.1, §C.4, §D.2, §E.1;
 * docs/DECISIONS.md rows 239 and 241).
 *
 * Eight committed, reviewed files decide what the import may do. The ops
 * router bundles them as wrangler `Text` modules (step 6b) and hands their
 * texts to `parseReviewedBundle`; everything here is PURE — no I/O, no D1, no
 * clock — so the runner and the tests read the files with exactly the same
 * rules:
 *
 *   data/bambu-import/manifest.json           which products exist at all (source id, handle, type,
 *                                             curated flag, hold code, queue position, SKU codes, value labels)
 *   data/bambu-import/taxonomy-map.json       the only way a product gets its sections (§D.2)
 *   data/bambu-import/existing-matches.json   which source merges into which Levonis product (§E.1)
 *   data/bambu-import/compat-targets.json     the only way a relation or printer fit resolves (§B.6)
 *   data/bambu-import/identity-map.json       model / series / family (§C.1)
 *   data/bambu-import/media-overrides.json    the only way an unbound image gets a binding (§C.4)
 *   data/bambu-import/curated/index.json      handle → SHA-256 of each reviewed curated file (§F)
 *   data/bambu-import/search-synonyms.json    the ar/ckb synonyms /run/prepare-taxonomy inserts
 *
 * `parseReviewedBundle` validates every file's shape (a malformed file is a
 * refusal naming the file and the JSON path, never a half-read bundle) and
 * returns each file's SHA-256 plus the combined digest `/hello` answers and
 * `catalog_import_runs.reviewed_bundle_sha256` stores.
 *
 * `checkReviewedScope(bundle, payload)` is the gate `/stage` and `/write` run
 * (§A.3 table, §E.1 item 4): a source not in the manifest, a merge the matches
 * file does not list, a create for a source it lists as merge / merge_publish /
 * hold_owner_hidden, a manifest hold, a curated product without its reviewed
 * file, identity rows the identity map does not give, an override binding the
 * overrides file does not name, and a relation target the compat file and the
 * manifest do not name — each is refused with the §B.5 blocker code. A create
 * is never refused for a source listed `not_bambu` or `distinct`.
 *
 * PRIVACY (§A.8). `existing-matches.json` is committed to a public
 * repository: an entry may hold ids, a public slug, a decision, a reason code,
 * the value map and the review stamp — nothing else. Any other key (a free-text
 * note above all) is refused here, so such a file can never be bundled.
 */
import { H, sha256Hex } from '@levonis/catalog/bambuImport/hash';
import { canonicalJson } from '@levonis/catalog/bambuImport/fingerprint';
import type { CompatTargets } from '@levonis/catalog/bambuImport/relations';
import type { MediaOverride } from '@levonis/catalog/bambuImport/media';
import type { ImportPayload } from '@levonis/catalog/bambuImport/payload';

// ---------------------------------------------------------------- the files

/** The bundled files, by key, with their path under data/bambu-import/. */
export const REVIEWED_FILES = {
  manifest: 'manifest.json',
  taxonomyMap: 'taxonomy-map.json',
  existingMatches: 'existing-matches.json',
  compatTargets: 'compat-targets.json',
  identityMap: 'identity-map.json',
  mediaOverrides: 'media-overrides.json',
  curatedIndex: 'curated/index.json',
  searchSynonyms: 'search-synonyms.json',
} as const;
export type ReviewedFileKey = keyof typeof REVIEWED_FILES;
/** The raw text of every bundled file (what the wrangler Text modules hold). */
export type ReviewedTexts = Record<ReviewedFileKey, string>;

export class ReviewedBundleInvalid extends Error {
  readonly code = 'REVIEWED_BUNDLE_INVALID';
  constructor(
    readonly file: string,
    readonly path: string,
    readonly reason: string
  ) {
    super(`reviewed file ${file} is invalid at ${path}: ${reason}`);
    this.name = 'ReviewedBundleInvalid';
  }
}

export const HOLD_CODES = ['', 'OWNER_HIDDEN', 'ORDER_TYPE_WORD'] as const;
export type HoldCode = (typeof HOLD_CODES)[number];

export interface ReviewedValueLabelRow {
  group_source_id?: string;
  name_en: string;
  name_ar: string;
  name_ckb: string;
}

/** One row of manifest.json (the fields the Worker reads; review-only fields are kept as they are). */
export interface ManifestRow {
  queue_position: number;
  source: 'bambu_us';
  source_product_id: string;
  handle: string;
  canonical_url: string;
  title: string;
  type: string;
  currentAllIdRoute: string;
  leaf: string;
  also: string[];
  curated: boolean;
  hold_code: HoldCode;
  sku_codes: Record<string, string>;
  value_labels: Record<string, ReviewedValueLabelRow>;
  [review: string]: unknown;
}

export interface TaxonomyCreateNode {
  key: string;
  parent: string;
  slug: string;
  name_en: string;
  name_ar: string;
  name_ckb: string;
  template_family: 'devices' | 'materials';
  is_printer_catalog: 0 | 1;
  sort: number;
}
export interface TaxonomyMap {
  version: 1;
  snapshot_sha256: string | null;
  create: TaxonomyCreateNode[];
  /** Deepest matching prefix of currentAllIdRoute wins. */
  routes: Record<string, { primary: string; also?: string[] }>;
  /** Evidence-backed overrides (rule 7). */
  handles: Record<string, { primary: string; route: string; quote: string }>;
  /** Secondary memberships with their evidence. */
  also_by_handle: Record<string, Array<{ also: string; route: string; quote: string }>>;
  leaf_limit: number;
}

export const MATCH_DECISIONS = ['merge', 'merge_publish', 'distinct', 'not_bambu', 'hold_owner_hidden'] as const;
export type MatchDecision = (typeof MATCH_DECISIONS)[number];
export const MATCH_REASONS = ['same_model', 'different_generation', 'different_bundle', 'not_bambu_product', 'owner_decision'] as const;
/** What a source variant maps to on the existing product (§E.1, §E.2). */
export interface ValueMapEntry {
  option_value_ids?: string[];
  color_id?: string;
}
export interface ExistingMatch {
  source_product_id: string;
  source_handle: string;
  levonis_product_id: string;
  /** Only when the product was active at review (§A.8). */
  levonis_slug?: string;
  decision: MatchDecision;
  value_map: Record<string, ValueMapEntry>;
  unmapped_variants: string[];
  reason: (typeof MATCH_REASONS)[number];
  reviewed_by: string;
  reviewed_at: string;
  /** merge_publish only: the owner's approval (a DECISIONS row or a message id). */
  approval_ref?: string;
}

export interface IdentityEntry {
  model?: string;
  series?: string;
  family?: string;
}

/** A reviewed binding for an image the source ties to nothing (§C.4). Ids are the deterministic Levonis ids (§B.8). */
export interface MediaOverrideEntry {
  handle: string;
  resource_file_id: string;
  value_ids: string[];
  variant_ids: string[];
  reviewed_by: string;
  reason: string;
}

export interface SynonymRow {
  term: string;
  canonical: string;
  lang: 'ar' | 'ckb';
}

export interface ReviewedBundle {
  manifest: { rows: ManifestRow[]; bySourceId: ReadonlyMap<string, ManifestRow>; byHandle: ReadonlyMap<string, ManifestRow> };
  taxonomy: TaxonomyMap;
  matches: { entries: ExistingMatch[]; bySourceId: ReadonlyMap<string, ExistingMatch> };
  compat: CompatTargets;
  identity: ReadonlyMap<string, IdentityEntry>;
  overrides: MediaOverrideEntry[];
  curated: ReadonlyMap<string, string>;
  synonyms: SynonymRow[];
  /** SHA-256 of each file's exact text. */
  sha256: Record<ReviewedFileKey, string>;
  /** sha256 over `<file path>:<sha256>\n` in REVIEWED_FILES order: the run's reviewed_bundle_sha256. */
  bundleSha256: string;
}

// ---------------------------------------------------------------- shape helpers

type Json = unknown;
const isObj = (v: Json): v is Record<string, Json> => !!v && typeof v === 'object' && !Array.isArray(v);

class Reader {
  constructor(readonly file: string) {}
  fail(path: string, reason: string): never {
    throw new ReviewedBundleInvalid(this.file, path, reason);
  }
  obj(v: Json, path: string): Record<string, Json> {
    if (!isObj(v)) this.fail(path, 'expected an object');
    return v as Record<string, Json>;
  }
  arr(v: Json, path: string): Json[] {
    if (!Array.isArray(v)) this.fail(path, 'expected a list');
    return v as Json[];
  }
  str(v: Json, path: string, opts: { max?: number; empty?: boolean; pattern?: RegExp } = {}): string {
    if (typeof v !== 'string') this.fail(path, 'expected a string');
    const s = v as string;
    if (!opts.empty && s === '') this.fail(path, 'must not be empty');
    if (s.length > (opts.max ?? 2000)) this.fail(path, 'too long');
    if (opts.pattern && !opts.pattern.test(s)) this.fail(path, 'not the expected shape');
    return s;
  }
  int(v: Json, path: string): number {
    if (typeof v !== 'number' || !Number.isInteger(v)) this.fail(path, 'expected a whole number');
    return v as number;
  }
  oneOf<T extends string>(v: Json, path: string, values: readonly T[]): T {
    if (typeof v !== 'string' || !values.includes(v as T)) this.fail(path, `expected one of ${values.join('|')}`);
    return v as T;
  }
  only(o: Record<string, Json>, path: string, keys: readonly string[]): void {
    for (const k of Object.keys(o)) if (!keys.includes(k)) this.fail(`${path}.${k}`, 'key not allowed in this file');
  }
  version(o: Record<string, Json>): void {
    if (o.version !== 1) this.fail('$.version', 'expected version 1');
  }
}

function parseJson(file: string, text: string): Json {
  try {
    return JSON.parse(text) as Json;
  } catch {
    throw new ReviewedBundleInvalid(file, '$', 'not JSON');
  }
}

const SOURCE_ID = /^\d{1,24}$/;
const ARABIC = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
/** DECISIONS row 183: a ckb text never copies the Arabic. */
const ckbCopiesAr = (ar: string, ckb: string) => ar !== '' && ar === ckb && ARABIC.test(ar);

// ---------------------------------------------------------------- per file

function parseManifest(text: string): ReviewedBundle['manifest'] {
  const r = new Reader(REVIEWED_FILES.manifest);
  const root = r.obj(parseJson(r.file, text), '$');
  r.version(root);
  if (root.source !== 'bambu_us') r.fail('$.source', "expected 'bambu_us'");
  const rows: ManifestRow[] = [];
  const bySourceId = new Map<string, ManifestRow>();
  const byHandle = new Map<string, ManifestRow>();
  const positions = new Set<number>();
  r.arr(root.rows, '$.rows').forEach((raw, i) => {
    const p = `$.rows[${i}]`;
    const o = r.obj(raw, p);
    const spid = r.str(String(o.source_product_id ?? ''), `${p}.source_product_id`, { pattern: SOURCE_ID });
    const handle = r.str(o.handle, `${p}.handle`, { max: 300 });
    const pos = r.int(o.queue_position, `${p}.queue_position`);
    if (pos < 1) r.fail(`${p}.queue_position`, 'must be 1 or more');
    if (bySourceId.has(spid)) r.fail(`${p}.source_product_id`, 'duplicate source id');
    if (byHandle.has(handle)) r.fail(`${p}.handle`, 'duplicate handle');
    if (positions.has(pos)) r.fail(`${p}.queue_position`, 'duplicate queue position');
    const sku = o.sku_codes === undefined ? {} : r.obj(o.sku_codes, `${p}.sku_codes`);
    for (const [k, v] of Object.entries(sku)) r.str(v, `${p}.sku_codes.${k}`, { max: 120 });
    const labels = o.value_labels === undefined ? {} : r.obj(o.value_labels, `${p}.value_labels`);
    for (const [k, v] of Object.entries(labels)) {
      const lp = `${p}.value_labels.${k}`;
      const l = r.obj(v, lp);
      const ar = r.str(l.name_ar, `${lp}.name_ar`, { max: 200 });
      const ckb = r.str(l.name_ckb, `${lp}.name_ckb`, { max: 200 });
      r.str(l.name_en, `${lp}.name_en`, { max: 200 });
      if (ckbCopiesAr(ar, ckb)) r.fail(`${lp}.name_ckb`, 'copies the Arabic (DECISIONS row 183)');
    }
    const row: ManifestRow = {
      ...o,
      queue_position: pos,
      source: 'bambu_us',
      source_product_id: spid,
      handle,
      canonical_url: r.str(o.canonical_url, `${p}.canonical_url`, { max: 1000, pattern: /^https:\/\// }),
      title: typeof o.title === 'string' ? o.title : '',
      type: r.str(o.type, `${p}.type`, { max: 40 }),
      currentAllIdRoute: r.str(o.currentAllIdRoute ?? '', `${p}.currentAllIdRoute`, { max: 200, empty: true }),
      leaf: typeof o.leaf === 'string' ? o.leaf : '',
      also: Array.isArray(o.also) ? o.also.map((a, j) => r.str(a, `${p}.also[${j}]`, { max: 80 })) : [],
      curated: o.curated === true,
      hold_code: r.oneOf(o.hold_code ?? '', `${p}.hold_code`, HOLD_CODES),
      sku_codes: sku as Record<string, string>,
      value_labels: labels as unknown as Record<string, ReviewedValueLabelRow>,
    };
    positions.add(pos);
    bySourceId.set(spid, row);
    byHandle.set(handle, row);
    rows.push(row);
  });
  return { rows, bySourceId, byHandle };
}

const NODE_REF = /^(?:@[a-z0-9][a-z0-9-]*|cat_[a-z0-9_]+)$/;

function parseTaxonomy(text: string): TaxonomyMap {
  const r = new Reader(REVIEWED_FILES.taxonomyMap);
  const root = r.obj(parseJson(r.file, text), '$');
  r.version(root);
  const create: TaxonomyCreateNode[] = [];
  const keys = new Set<string>();
  const slugs = new Set<string>();
  r.arr(root.create ?? [], '$.create').forEach((raw, i) => {
    const p = `$.create[${i}]`;
    const o = r.obj(raw, p);
    const key = r.str(o.key, `${p}.key`, { max: 60, pattern: /^[a-z0-9][a-z0-9-]*$/ });
    if (keys.has(key)) r.fail(`${p}.key`, 'duplicate key');
    const slug = r.str(o.slug, `${p}.slug`, { max: 80, pattern: /^[a-z0-9][a-z0-9-]*$/ });
    if (slugs.has(slug)) r.fail(`${p}.slug`, 'duplicate slug');
    const name_ar = r.str(o.name_ar, `${p}.name_ar`, { max: 120 });
    const name_ckb = r.str(o.name_ckb, `${p}.name_ckb`, { max: 120 });
    if (ckbCopiesAr(name_ar, name_ckb)) r.fail(`${p}.name_ckb`, 'copies the Arabic (DECISIONS row 183)');
    keys.add(key);
    slugs.add(slug);
    create.push({
      key,
      parent: r.str(o.parent, `${p}.parent`, { max: 80, pattern: NODE_REF }),
      slug,
      name_en: r.str(o.name_en, `${p}.name_en`, { max: 120 }),
      name_ar,
      name_ckb,
      template_family: r.oneOf(o.template_family, `${p}.template_family`, ['devices', 'materials'] as const),
      is_printer_catalog: o.is_printer_catalog === 1 ? 1 : 0,
      sort: typeof o.sort === 'number' && Number.isInteger(o.sort) ? o.sort : 0,
    });
  });
  const ref = (v: Json, path: string): string => {
    const s = r.str(v, path, { max: 80, pattern: NODE_REF });
    if (s.startsWith('@') && !keys.has(s.slice(1))) r.fail(path, 'names a node the file does not create');
    return s;
  };
  // A created node may sit under another created node: resolve every parent too.
  create.forEach((n, i) => ref(n.parent, `$.create[${i}].parent`));
  const routes: TaxonomyMap['routes'] = {};
  for (const [prefix, raw] of Object.entries(r.obj(root.routes ?? {}, '$.routes'))) {
    const p = `$.routes["${prefix}"]`;
    if (!/^\d+(?:>\d+)*$/.test(prefix)) r.fail(p, 'a route is source ids joined by >');
    const o = r.obj(raw, p);
    routes[prefix] = {
      primary: ref(o.primary, `${p}.primary`),
      also: o.also === undefined ? undefined : r.arr(o.also, `${p}.also`).map((a, j) => ref(a, `${p}.also[${j}]`)),
    };
  }
  const handles: TaxonomyMap['handles'] = {};
  for (const [h, raw] of Object.entries(r.obj(root.handles ?? {}, '$.handles'))) {
    const p = `$.handles["${h}"]`;
    const o = r.obj(raw, p);
    handles[h] = { primary: ref(o.primary, `${p}.primary`), route: r.str(o.route, `${p}.route`, { max: 200 }), quote: r.str(o.quote, `${p}.quote`, { max: 400 }) };
  }
  const also_by_handle: TaxonomyMap['also_by_handle'] = {};
  for (const [h, raw] of Object.entries(r.obj(root.also_by_handle ?? {}, '$.also_by_handle'))) {
    also_by_handle[h] = r.arr(raw, `$.also_by_handle["${h}"]`).map((e, j) => {
      const p = `$.also_by_handle["${h}"][${j}]`;
      const o = r.obj(e, p);
      return { also: ref(o.also, `${p}.also`), route: r.str(o.route, `${p}.route`, { max: 200 }), quote: r.str(o.quote, `${p}.quote`, { max: 400 }) };
    });
  }
  const snap = root.snapshot_sha256;
  if (snap !== null && snap !== undefined) r.str(snap, '$.snapshot_sha256', { pattern: /^[0-9a-f]{64}$/ });
  return {
    version: 1,
    snapshot_sha256: (snap as string | null | undefined) ?? null,
    create,
    routes,
    handles,
    also_by_handle,
    leaf_limit: typeof root.leaf_limit === 'number' ? root.leaf_limit : 250,
  };
}

const MATCH_KEYS = [
  'source_product_id',
  'source_handle',
  'levonis_product_id',
  'levonis_slug',
  'decision',
  'value_map',
  'unmapped_variants',
  'reason',
  'reviewed_by',
  'reviewed_at',
  'approval_ref',
] as const;

function parseMatches(text: string): ReviewedBundle['matches'] {
  const r = new Reader(REVIEWED_FILES.existingMatches);
  const root = r.obj(parseJson(r.file, text), '$');
  r.version(root);
  r.only(root, '$', ['version', 'status', 'reviewed_by', 'reviewed_at', 'snapshot_sha256', 'entries']);
  const entries: ExistingMatch[] = [];
  const bySourceId = new Map<string, ExistingMatch>();
  r.arr(root.entries ?? [], '$.entries').forEach((raw, i) => {
    const p = `$.entries[${i}]`;
    const o = r.obj(raw, p);
    r.only(o, p, MATCH_KEYS);
    const spid = r.str(String(o.source_product_id ?? ''), `${p}.source_product_id`, { pattern: SOURCE_ID });
    if (bySourceId.has(spid)) r.fail(`${p}.source_product_id`, 'duplicate source id');
    const decision = r.oneOf(o.decision, `${p}.decision`, MATCH_DECISIONS);
    const valueMap: Record<string, ValueMapEntry> = {};
    for (const [vid, v] of Object.entries(o.value_map === undefined ? {} : r.obj(o.value_map, `${p}.value_map`))) {
      const vp = `${p}.value_map["${vid}"]`;
      if (!SOURCE_ID.test(vid)) r.fail(vp, 'a value map is keyed by the source variant id');
      const e = r.obj(v, vp);
      r.only(e, vp, ['option_value_ids', 'color_id']);
      const entry: ValueMapEntry = {};
      if (e.option_value_ids !== undefined) entry.option_value_ids = r.arr(e.option_value_ids, `${vp}.option_value_ids`).map((x, j) => r.str(x, `${vp}.option_value_ids[${j}]`, { max: 60 }));
      if (e.color_id !== undefined) entry.color_id = r.str(e.color_id, `${vp}.color_id`, { max: 60 });
      if (!entry.option_value_ids?.length && !entry.color_id) r.fail(vp, 'maps to nothing');
      valueMap[vid] = entry;
    }
    const approval = o.approval_ref === undefined ? undefined : r.str(o.approval_ref, `${p}.approval_ref`, { max: 120 });
    if (decision === 'merge_publish' && !approval) r.fail(`${p}.approval_ref`, 'merge_publish needs the owner approval reference');
    const m: ExistingMatch = {
      source_product_id: spid,
      source_handle: r.str(o.source_handle, `${p}.source_handle`, { max: 300 }),
      levonis_product_id: r.str(o.levonis_product_id, `${p}.levonis_product_id`, { max: 80 }),
      levonis_slug: o.levonis_slug === undefined ? undefined : r.str(o.levonis_slug, `${p}.levonis_slug`, { max: 200 }),
      decision,
      value_map: valueMap,
      unmapped_variants: (o.unmapped_variants === undefined ? [] : r.arr(o.unmapped_variants, `${p}.unmapped_variants`)).map((x, j) =>
        r.str(String(x ?? ''), `${p}.unmapped_variants[${j}]`, { pattern: SOURCE_ID })
      ),
      reason: r.oneOf(o.reason, `${p}.reason`, MATCH_REASONS),
      reviewed_by: r.str(o.reviewed_by, `${p}.reviewed_by`, { max: 120 }),
      reviewed_at: r.str(o.reviewed_at, `${p}.reviewed_at`, { max: 40 }),
      approval_ref: approval,
    };
    bySourceId.set(spid, m);
    entries.push(m);
  });
  return { entries, bySourceId };
}

function parseCompat(text: string): CompatTargets {
  const r = new Reader(REVIEWED_FILES.compatTargets);
  const root = r.obj(parseJson(r.file, text), '$');
  r.version(root);
  const labels = r.obj(root.labels ?? {}, '$.labels');
  for (const [label, raw] of Object.entries(labels)) r.obj(raw, `$.labels["${label}"]`);
  for (const k of ['compounds', 'reviewed_unresolvable', 'requirement_targets', 'requirement_unresolvable']) {
    if (root[k] !== undefined) r.obj(root[k], `$.${k}`);
  }
  return root as unknown as CompatTargets;
}

function parseIdentity(text: string): Map<string, IdentityEntry> {
  const r = new Reader(REVIEWED_FILES.identityMap);
  const root = r.obj(parseJson(r.file, text), '$');
  r.version(root);
  const out = new Map<string, IdentityEntry>();
  for (const [handle, raw] of Object.entries(r.obj(root.entries ?? {}, '$.entries'))) {
    const p = `$.entries["${handle}"]`;
    const o = r.obj(raw, p);
    const e: IdentityEntry = {};
    for (const k of ['model', 'series', 'family'] as const) {
      if (o[k] === undefined || o[k] === '') continue;
      e[k] = r.str(o[k], `${p}.${k}`, { max: 120 });
    }
    out.set(handle, e);
  }
  return out;
}

function parseOverrides(text: string): MediaOverrideEntry[] {
  const r = new Reader(REVIEWED_FILES.mediaOverrides);
  const root = r.obj(parseJson(r.file, text), '$');
  r.version(root);
  return r.arr(root.overrides ?? [], '$.overrides').map((raw, i) => {
    const p = `$.overrides[${i}]`;
    const o = r.obj(raw, p);
    const ids = (k: string) => (o[k] === undefined ? [] : r.arr(o[k], `${p}.${k}`).map((x, j) => r.str(x, `${p}.${k}[${j}]`, { max: 40 })));
    const e: MediaOverrideEntry = {
      handle: r.str(o.handle, `${p}.handle`, { max: 300 }),
      resource_file_id: r.str(String(o.resource_file_id ?? ''), `${p}.resource_file_id`, { max: 200 }),
      value_ids: ids('value_ids'),
      variant_ids: ids('variant_ids'),
      reviewed_by: r.str(o.reviewed_by, `${p}.reviewed_by`, { max: 120 }),
      reason: r.str(o.reason, `${p}.reason`, { max: 80 }),
    };
    if (!e.value_ids.length && !e.variant_ids.length) r.fail(p, 'binds nothing');
    return e;
  });
}

function parseCurated(text: string): Map<string, string> {
  const r = new Reader(REVIEWED_FILES.curatedIndex);
  const root = r.obj(parseJson(r.file, text), '$');
  r.version(root);
  const out = new Map<string, string>();
  for (const [handle, sha] of Object.entries(r.obj(root.entries ?? {}, '$.entries'))) {
    out.set(handle, r.str(sha, `$.entries["${handle}"]`, { pattern: /^[0-9a-f]{64}$/ }));
  }
  return out;
}

function parseSynonyms(text: string): SynonymRow[] {
  const r = new Reader(REVIEWED_FILES.searchSynonyms);
  const root = r.obj(parseJson(r.file, text), '$');
  r.version(root);
  return r.arr(root.rows ?? [], '$.rows').map((raw, i) => {
    const p = `$.rows[${i}]`;
    const o = r.obj(raw, p);
    return { term: r.str(o.term, `${p}.term`, { max: 80 }), canonical: r.str(o.canonical, `${p}.canonical`, { max: 80 }), lang: r.oneOf(o.lang, `${p}.lang`, ['ar', 'ckb'] as const) };
  });
}

/** Parses and validates the eight bundled files. Throws ReviewedBundleInvalid on the first problem. */
export function parseReviewedBundle(texts: ReviewedTexts): ReviewedBundle {
  const sha256 = {} as Record<ReviewedFileKey, string>;
  for (const k of Object.keys(REVIEWED_FILES) as ReviewedFileKey[]) {
    if (typeof texts[k] !== 'string') throw new ReviewedBundleInvalid(REVIEWED_FILES[k], '$', 'missing from the bundle');
    sha256[k] = sha256Hex(texts[k]);
  }
  const bundleSha256 = sha256Hex((Object.keys(REVIEWED_FILES) as ReviewedFileKey[]).map((k) => `${REVIEWED_FILES[k]}:${sha256[k]}\n`).join(''));
  return {
    manifest: parseManifest(texts.manifest),
    taxonomy: parseTaxonomy(texts.taxonomyMap),
    matches: parseMatches(texts.existingMatches),
    compat: parseCompat(texts.compatTargets),
    identity: parseIdentity(texts.identityMap),
    overrides: parseOverrides(texts.mediaOverrides),
    curated: parseCurated(texts.curatedIndex),
    synonyms: parseSynonyms(texts.searchSynonyms),
    sha256,
    bundleSha256,
  };
}

/** Valid, EMPTY files: zero manifest rows, so a Worker carrying them refuses every source (the inert bundle). */
export function emptyReviewedTexts(): ReviewedTexts {
  const j = (o: unknown) => `${JSON.stringify(o, null, 2)}\n`;
  return {
    manifest: j({ version: 1, source: 'bambu_us', rows: [] }),
    taxonomyMap: j({ version: 1, snapshot_sha256: null, create: [], routes: {}, handles: {}, also_by_handle: {}, leaf_limit: 250 }),
    existingMatches: j({ version: 1, entries: [] }),
    compatTargets: j({ version: 1, labels: {} }),
    identityMap: j({ version: 1, entries: {} }),
    mediaOverrides: j({ version: 1, overrides: [] }),
    curatedIndex: j({ version: 1, entries: {} }),
    searchSynonyms: j({ version: 1, rows: [] }),
  };
}

// ---------------------------------------------------------------- taxonomy (§D.2)

/**
 * The catalog id `/run/prepare-taxonomy` gives the node the map creates as
 * `key` ('@pla' → 'cat_bi_pla'). Deterministic, so the writer can name the
 * node before reading it and a second prepare inserts nothing (insert-only).
 */
export function taxonomyNodeId(key: string): string {
  return `cat_bi_${key.replace(/^@/, '').replace(/[^a-z0-9]+/g, '_')}`;
}

/** A map reference ('@key' or a seeded catalog id) as the catalog id it names in D1. */
export const catalogIdOf = (ref: string): string => (ref.startsWith('@') ? taxonomyNodeId(ref) : ref);

export interface TaxonomyResolution {
  /** The primary leaf, as a catalog id. */
  primary: string;
  /** Secondary memberships (catalog ids), never the primary, in map order. */
  secondaries: string[];
  /** How the leaf was found. */
  via: 'handle' | 'route';
}

/**
 * Rule 1 of §D.2: handle override → deepest route prefix → null (BLOCKED
 * TAXONOMY_UNMAPPED). Secondaries: the matched route's `also` and the
 * evidence-backed `also_by_handle` entries.
 */
export function resolveTaxonomy(map: TaxonomyMap, handle: string, route: string): TaxonomyResolution | null {
  let primary = '';
  let via: TaxonomyResolution['via'] = 'route';
  const parts = route ? route.split('>') : [];
  let routeAlso: string[] = [];
  for (let i = parts.length; i > 0; i--) {
    const hit = map.routes[parts.slice(0, i).join('>')];
    if (hit) {
      primary = hit.primary;
      routeAlso = hit.also ?? [];
      break;
    }
  }
  const override = Object.prototype.hasOwnProperty.call(map.handles, handle) ? map.handles[handle] : undefined;
  if (override) {
    primary = override.primary;
    via = 'handle';
  }
  if (!primary) return null;
  const primaryId = catalogIdOf(primary);
  const secondaries: string[] = [];
  for (const ref of [...routeAlso, ...(map.also_by_handle[handle] ?? []).map((e) => e.also)]) {
    const id = catalogIdOf(ref);
    if (id !== primaryId && !secondaries.includes(id)) secondaries.push(id);
  }
  return { primary: primaryId, secondaries, via };
}

// ---------------------------------------------------------------- the scope gate (§A.3, §E.1)

/** `p_` + H('bambu_us:product:' + source id): a created product's deterministic id (§B.8). */
export const newProductIdOf = (sourceProductId: string): string => `p_${H(`bambu_us:product:${sourceProductId}`)}`;

/** The §B.5 blocker codes the reviewed scope can answer. */
export type ScopeRefusalCode =
  | 'REVIEWED_SCOPE_REFUSED'
  | 'OWNER_HIDDEN'
  | 'ORDER_TYPE_WORD'
  | 'CURATION_MISSING'
  | 'TAXONOMY_UNMAPPED';

export interface ScopeRefusal {
  code: ScopeRefusalCode;
  /** A fixed reason code (never input text). */
  reason: string;
}

export type ScopeVerdict =
  | { ok: true; row: ManifestRow; match: ExistingMatch | null; taxonomy: TaxonomyResolution }
  | { ok: false; refusal: ScopeRefusal };

const refuse = (code: ScopeRefusalCode, reason: string): ScopeVerdict => ({ ok: false, refusal: { code, reason } });

/**
 * Every target the compat file names (in `to`, `members`, `by_subject` and
 * `default`, of its labels and its requirement targets): the existing Levonis
 * product ids and the source handles. Evidence quotes are not targets.
 */
export function reviewedTargets(compat: CompatTargets): { ids: Set<string>; handles: Set<string> } {
  const ids = new Set<string>();
  const handles = new Set<string>();
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (isObj(v)) {
      for (const [k, x] of Object.entries(v)) {
        if (k === 'levonis_product_id' && typeof x === 'string' && x) ids.add(x);
        else if (k === 'source_handle' && typeof x === 'string' && x) handles.add(x);
        else if (k !== 'evidence' && k !== 'usage_evidence') visit(x);
      }
    }
  };
  for (const table of [compat.labels, compat.requirement_targets]) visit(table ?? {});
  return { ids, handles };
}
const TARGETS = new WeakMap<object, { ids: Set<string>; handles: Set<string> }>();
const targetsOf = (compat: CompatTargets) => {
  let s = TARGETS.get(compat);
  if (!s) TARGETS.set(compat, (s = reviewedTargets(compat)));
  return s;
};

/** The reviewed overrides of one product, in the shape the package's media binder reads. */
export function mediaOverridesFor(bundle: ReviewedBundle, handle: string): MediaOverride[] {
  return bundle.overrides
    .filter((o) => o.handle === handle)
    .map((o) => ({ resourceFileId: o.resource_file_id, valueIds: o.value_ids, variantIds: o.variant_ids }));
}

/**
 * THE GATE. Pure: the payload against the bundle. The first refusal wins; on
 * success, the manifest row, the reviewed match (null for an unlisted source)
 * and the taxonomy resolution.
 */
export function checkReviewedScope(bundle: ReviewedBundle, payload: ImportPayload): ScopeVerdict {
  // 1. The manifest: the source, its handle and nothing else.
  const row = bundle.manifest.bySourceId.get(payload.source_product_id);
  if (!row) return refuse('REVIEWED_SCOPE_REFUSED', 'source_not_in_manifest');
  if (row.handle !== payload.handle) return refuse('REVIEWED_SCOPE_REFUSED', 'handle_differs_from_manifest');
  // 2. A manifest hold blocks at its turn until the owner decides (§B.5).
  if (row.hold_code === 'OWNER_HIDDEN') return refuse('OWNER_HIDDEN', 'manifest_hold');
  if (row.hold_code === 'ORDER_TYPE_WORD') return refuse('ORDER_TYPE_WORD', 'manifest_hold');
  // 3. The existing-product matches (§E.1 item 4).
  const match = bundle.matches.bySourceId.get(payload.source_product_id) ?? null;
  if (match && match.source_handle !== payload.handle) return refuse('REVIEWED_SCOPE_REFUSED', 'match_handle_differs');
  if (payload.write_mode === 'merge') {
    if (!match || (match.decision !== 'merge' && match.decision !== 'merge_publish')) return refuse('REVIEWED_SCOPE_REFUSED', 'merge_not_listed');
    if (match.levonis_product_id !== payload.product_id) return refuse('REVIEWED_SCOPE_REFUSED', 'merge_target_not_listed');
  } else {
    if (match && match.decision === 'hold_owner_hidden') return refuse('OWNER_HIDDEN', 'match_hold_owner_hidden');
    if (match && (match.decision === 'merge' || match.decision === 'merge_publish')) return refuse('REVIEWED_SCOPE_REFUSED', 'create_for_listed_merge');
    // not_bambu / distinct / unlisted: the source is created, under its deterministic id only.
    if (payload.product_id !== newProductIdOf(payload.source_product_id)) return refuse('REVIEWED_SCOPE_REFUSED', 'create_id_not_deterministic');
  }
  // 4. Curated scope (§F): a curated product is written with its reviewed file, and only that one.
  const curated = bundle.curated.get(payload.handle) ?? '';
  if (row.curated && !curated) return refuse('CURATION_MISSING', 'curated_file_not_bundled');
  if (payload.curated_sha256 !== curated) return refuse('REVIEWED_SCOPE_REFUSED', 'curated_sha256_differs');
  // 5. Identity rows come from the identity map only (§C.1).
  const identity = bundle.identity.get(payload.handle) ?? {};
  for (const k of ['model', 'series', 'family'] as const) {
    const rows = payload.specs.filter((s) => s.key === `identity.${k}`);
    const want = identity[k] ?? '';
    if (rows.length > 1) return refuse('REVIEWED_SCOPE_REFUSED', 'identity_row_repeated');
    const got = rows[0]?.value_text ?? '';
    if (got !== want) return refuse('REVIEWED_SCOPE_REFUSED', `identity_${k}_not_reviewed`);
  }
  // 6. An override binding only as the overrides file states it (§C.4).
  const overrides = bundle.overrides.filter((o) => o.handle === payload.handle);
  for (const img of payload.images) {
    if (img.binding_rule !== 'reviewed_override') continue;
    const ov = overrides.find((o) => o.resource_file_id === img.source_media_id);
    const ok =
      !!ov &&
      ((img.option_value_id !== null && ov.value_ids.includes(img.option_value_id)) || (img.variant_id !== null && ov.variant_ids.includes(img.variant_id)));
    if (!ok) return refuse('REVIEWED_SCOPE_REFUSED', 'override_not_reviewed');
  }
  // 7. Relation targets resolve only through the compat file and the manifest (§B.6).
  const targets = targetsOf(bundle.compat);
  for (const rel of payload.relations) {
    if (rel.state === 'resolved' && (!rel.target_product_id || !targets.ids.has(rel.target_product_id))) {
      return refuse('REVIEWED_SCOPE_REFUSED', 'relation_target_not_reviewed');
    }
    // Pending on a handle the compat file names (it waits for that product's own batch, or becomes
    // unresolvable at the end of the run when the handle is outside the manifest, §B.6).
    if (rel.state === 'pending' && (rel.target_source !== 'bambu_us' || !targets.handles.has(rel.target_source_handle))) {
      return refuse('REVIEWED_SCOPE_REFUSED', 'relation_pending_on_unreviewed_handle');
    }
  }
  // 8. The taxonomy (§D.2 rule 1).
  const taxonomy = resolveTaxonomy(bundle.taxonomy, payload.handle, payload.route);
  if (!taxonomy) return refuse('TAXONOMY_UNMAPPED', 'no_route_or_handle_entry');
  return { ok: true, row, match, taxonomy };
}

/** The canonical digest of a payload (`catalog_import_items.payload_sha256`; `/write` must send the staged one). */
export function payloadSha256(payload: unknown): string {
  return sha256Hex(canonicalJson(payload));
}
