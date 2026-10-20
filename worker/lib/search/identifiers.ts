/**
 * THE IDENTIFIER LANE — a code a shopper types is answered EXACTLY, or not at
 * all (smart search 1.5; docs/SEARCH.md «Identifiers»; migration 0206).
 *
 * A shopper holding a spool, a box or a spare part types the code printed on
 * it: the colour code «10101», the part code «FAP035», a SKU. The token index
 * finds a product by such a code (./aliases.ts puts the codes in its `model`
 * field), but it can say neither of the two things that matter about a code:
 *
 *   WHICH SELECTION IT NAMES. «10101» is one colour of PLA Basic, not PLA
 *   Basic. The product page should open on that colour, so the answer carries
 *   the option value, the colour or the variant the code belongs to.
 *
 *   THAT NOTHING CARRIES IT. «10102» is a colour nobody sells. A ranked search
 *   answers with whatever is nearest; an honest one says "no exact match for
 *   10102" first. So a code that matches no identifier AND appears in no
 *   product's index is reported as a miss — and only a code-like one: a word,
 *   a size («0.4mm», «PLA1.75») or a plain short number is never a "code".
 *
 * ONE KEY, BOTH SIDES. `identifierKey` is the only normaliser: the writers key
 * every stored code with it and the query side keys every typed chunk with it,
 * so «fap-035», «FAP 035» typed as one chunk, «ＦＡＰ０３５» and «١٠١٠١» meet the
 * rows they mean. Upper case, digits folded (Arabic-Indic and Persian, through
 * `foldText`), separators dropped. A key needs a digit: «ABS» or «PETG» is a
 * word, and a product whose SKU happens to be one must not turn every search
 * for the word into an "exact match".
 *
 * DERIVED, NEVER AUTHORED. The rows are rebuilt from `products.sku`, the active
 * `product_variants.sku`, the searchable `product_external_ids` (0194) and the
 * option and colour NAMES, by the product save (same batch as the product) and
 * by the search catch-up (store.ts `backfillSearchIndex`) — the same sources,
 * read by the same loader (`loadSearchSources`), so the two writers write the
 * same rows. The identifier stamp `IDENTIFIER_STAMP` in search_tokens says a
 * product's rows were written; a token-only rewrite (a hashtag rename) deletes
 * it with the rest of the product's tokens, and the catch-up writes them again.
 *
 * A COLOUR CODE AT PRODUCT SCOPE. Migration 0194 cannot scope an external id
 * to a `product_colors` colour, so a merge that maps a colour value onto one
 * stores its code at product scope (worker/lib/catalogImport/writer.ts, «THE
 * IDS THE PRODUCT CARRIES ARE KEPT»): the live PLA Basic's 43 colour codes. Its
 * colours are named and keyed by the code («jade-white-10100»), so the one
 * colour (or option value) of the product that names the code — "(10100)" in a
 * name, or `-10100` ending its id — receives a second row at its own scope.
 * Exactly one, or none: two candidates are not an answer.
 *
 * D1 REFUSES MORE THAN 100 BOUND PARAMETERS. Writes pack their rows into one
 * JSON parameter (`json_each`), 500 to a statement; the lookup binds seven
 * values however many codes were typed.
 */
import { extractMeasures, foldText, MEASURE_UNITS } from './normalize';

/** Written into search_tokens beside `INDEX_STAMP` when a product's identifier rows are current. */
export const IDENTIFIER_STAMP = '#ids:1';

export type IdentifierScope = 'product' | 'option_value' | 'variant' | 'color';
export type IdentifierKind =
  | 'sku'
  | 'variant_sku'
  | 'part_code'
  | 'color_code'
  | 'mpn'
  | 'gtin'
  | 'ean'
  | 'bambu_sku'
  | 'model'
  | 'measure';

export interface IdentifierRow {
  key: string;
  scope_kind: IdentifierScope;
  scope_id: string;
  kind: IdentifierKind;
  /** The stored row it was derived from: product_sku, variant_sku, external_id, option_name, colour_name, colour_link. */
  source: string;
}

const MIN_KEY = 3;
const MAX_KEY = 64;
/** The most rows one product writes: far above any real product (PLA Basic is about a hundred). */
const MAX_ROWS = 2000;
/** The separators a code is written with. Removed from the key: «FAP-035» is FAP035. */
const CODE_SEPARATORS = /[\s\-_./\\#:·+,'"()[\]]+/gu;

/**
 * THE KEY OF A CODE, or '' when the text is not one.
 *
 * '' for: anything holding a non-Latin letter (an Arabic word is a word),
 * fewer than three or more than 64 characters, and no digit at all.
 */
export function identifierKey(raw: unknown): string {
  const folded = foldText(raw);
  if (!folded) return '';
  const bare = folded.normalize('NFKC').replace(CODE_SEPARATORS, '');
  if (bare.length < MIN_KEY || bare.length > MAX_KEY || !/^[a-z0-9]+$/.test(bare) || !/\d/.test(bare)) return '';
  return bare.toUpperCase();
}

/** A measure's key: the canonical form `extractMeasures` writes (`0.4`, `6x2`), upper case like every key. */
export const measureKey = (canonical: string): string => canonical.toUpperCase();

/** The external id types a shopper types, and what each is called here (0194 `id_type`). */
const EXTERNAL_KIND: Readonly<Record<string, IdentifierKind>> = {
  bambu_sku_code: 'bambu_sku',
  color_code: 'color_code',
  part_code: 'part_code',
  mpn: 'mpn',
  gtin: 'gtin',
  upc: 'gtin',
  ean: 'ean',
};

const SCOPES: ReadonlySet<string> = new Set(['product', 'option_value', 'variant']);

/** A colour code written in a name, «Jade White (10100)» — the import's own rule (bambuImport/registry/colours.ts `colourCodeOf`). */
const NAME_CODE = /\((\d{5})\)/g;
/** A colour code ending a stored id, «jade-white-10100». Only ever used to place a code the product already carries. */
const ID_CODE = /(?:^|[-_])(\d{5})$/;

/** What a product's identifier rows are derived from. */
export interface IdentifierSources {
  /** `products.sku`. */
  sku?: unknown;
  /** The ACTIVE variants that carry a SKU. */
  variants?: ReadonlyArray<{ id: string; sku: unknown }>;
  /** The searchable `product_external_ids` rows (0194). Other `id_type`s are ignored. */
  externalIds?: ReadonlyArray<{ scope_kind: string; scope_id: string; id_type: string; value: string }>;
  /** Option values: id and every name it is written under. */
  options?: ReadonlyArray<{ id: string; names: readonly string[] }>;
  /** `product_colors` colours: id and every name. */
  colors?: ReadonlyArray<{ id: string; names: readonly string[] }>;
}

type Selection = { kind: 'option_value' | 'color'; id: string };

/** The identifier rows of one product (see the head of this file). Deterministic: the same sources, the same rows. */
export function identifierRows(src: IdentifierSources): IdentifierRow[] {
  const out: IdentifierRow[] = [];
  const seen = new Set<string>();
  const add = (key: string, scope_kind: IdentifierScope, scope_id: string, kind: IdentifierKind, source: string) => {
    if (!key || out.length >= MAX_ROWS) return;
    const k = `${key}\u0000${scope_kind}\u0000${scope_id}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ key, scope_kind, scope_id, kind, source });
  };

  // The selections whose NAME carries a code, and those whose ID ends with one.
  const named = new Map<string, Selection[]>();
  const keyedById = new Map<string, Selection[]>();
  const note = (map: Map<string, Selection[]>, code: string, sel: Selection) => {
    const key = identifierKey(code);
    if (!key) return;
    const list = map.get(key) ?? [];
    if (!list.some((s) => s.kind === sel.kind && s.id === sel.id)) list.push(sel);
    map.set(key, list);
  };
  const selections: Array<{ kind: 'option_value' | 'color'; list: IdentifierSources['options'] }> = [
    { kind: 'option_value', list: src.options },
    { kind: 'color', list: src.colors },
  ];
  for (const { kind, list } of selections) {
    for (const item of list ?? []) {
      const id = typeof item.id === 'string' ? item.id : '';
      if (!id) continue;
      for (const name of item.names) {
        if (typeof name !== 'string') continue;
        for (const m of name.matchAll(NAME_CODE)) note(named, m[1], { kind, id });
      }
      const byId = ID_CODE.exec(id);
      if (byId) note(keyedById, byId[1], { kind, id });
    }
  }

  // 1. The external ids, at the scope they were stored at.
  for (const e of src.externalIds ?? []) {
    const kind = EXTERNAL_KIND[e.id_type];
    if (!kind) continue;
    const key = identifierKey(e.value);
    if (!key) continue;
    const scope = (SCOPES.has(e.scope_kind) ? e.scope_kind : 'product') as IdentifierScope;
    add(key, scope, scope === 'product' ? '' : String(e.scope_id ?? ''), kind, 'external_id');
    // A colour code at product scope: the one selection that names it, if exactly one does.
    if (kind === 'color_code' && scope === 'product') {
      const candidates = named.get(key) ?? keyedById.get(key) ?? [];
      if (candidates.length === 1) add(key, candidates[0].kind, candidates[0].id, 'color_code', 'colour_link');
    }
  }
  // 2. The product's own SKU, and each active variant's.
  add(identifierKey(src.sku), 'product', '', 'sku', 'product_sku');
  for (const v of src.variants ?? []) {
    if (typeof v.id === 'string' && v.id) add(identifierKey(v.sku), 'variant', v.id, 'variant_sku', 'variant_sku');
  }
  // 3. A colour code a name carries «Jade White (10100)», at the selection that carries it.
  for (const [key, list] of named) {
    for (const sel of list) add(key, sel.kind, sel.id, 'color_code', sel.kind === 'color' ? 'colour_name' : 'option_name');
  }
  // 4. The measure an option value is named with («0.4mm», «6×2»): what a size typed in a query preselects.
  for (const o of src.options ?? []) {
    if (typeof o.id !== 'string' || !o.id) continue;
    for (const name of o.names) {
      for (const m of extractMeasures(foldText(name)).measures) add(measureKey(m), 'option_value', o.id, 'measure', 'option_name');
    }
  }
  return out;
}

/** Rows per packed INSERT: one JSON parameter, far under D1's limit on a bound value. */
export const IDENTIFIER_ROWS_PER_STATEMENT = 500;

const INSERT_IDENTIFIERS_SQL = `INSERT OR IGNORE INTO search_identifiers (key, product_id, scope_kind, scope_id, kind, source)
  SELECT json_extract(j.value, '$[0]'), ?1, json_extract(j.value, '$[1]'), json_extract(j.value, '$[2]'),
         json_extract(j.value, '$[3]'), json_extract(j.value, '$[4]')
    FROM json_each(?2) j`;

/**
 * Replace a product's identifier rows with exactly these. STATEMENTS, for the
 * caller's batch (the product save, the catch-up): the DELETE, then one packed
 * INSERT per 500 rows. The stamp goes into search_tokens with the token rows
 * (store.ts `planSearchIndexRows`), after their own DELETE.
 */
export function planSearchIdentifiers(db: D1Database, productId: string, rows: readonly IdentifierRow[]): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [db.prepare('DELETE FROM search_identifiers WHERE product_id = ?').bind(productId)];
  for (let i = 0; i < rows.length; i += IDENTIFIER_ROWS_PER_STATEMENT) {
    const part = rows.slice(i, i + IDENTIFIER_ROWS_PER_STATEMENT).map((r) => [r.key, r.scope_kind, r.scope_id, r.kind, r.source]);
    stmts.push(db.prepare(INSERT_IDENTIFIERS_SQL).bind(productId, JSON.stringify(part)));
  }
  return stmts;
}

// =========================================================================
// PRESENCE (migration 0206)
// =========================================================================

const PRESENT = new WeakMap<object, true>();
const ABSENT_UNTIL = new WeakMap<object, number>();
const ABSENT_RECHECK_MS = 60_000;

/** "no such table: search_identifiers" — a database one migration behind the code. */
export function isMissingSearchIdentifiers(err: unknown): boolean {
  return /no such table:?\s*search_identifiers\b/i.test(String((err as { message?: unknown })?.message ?? err));
}

/** What this binding is known to hold without asking: true, false (rechecked after a minute), or null. */
export function searchIdentifiersKnown(db: object): boolean | null {
  if (PRESENT.has(db)) return true;
  if ((ABSENT_UNTIL.get(db) ?? 0) > Date.now()) return false;
  return null;
}

/** Migration 0206 is on this database. One statement per binding while unknown, none once present. */
export async function searchIdentifiersInstalled(db: D1Database): Promise<boolean> {
  const known = searchIdentifiersKnown(db);
  if (known !== null) return known;
  try {
    await db.prepare('SELECT 1 FROM search_identifiers LIMIT 1').first();
    PRESENT.set(db, true);
    return true;
  } catch (e) {
    if (isMissingSearchIdentifiers(e)) {
      ABSENT_UNTIL.set(db, Date.now() + ABSENT_RECHECK_MS);
      return false;
    }
    throw e;
  }
}

// =========================================================================
// THE QUERY SIDE
// =========================================================================

/** One chunk of a query that could be a code. */
export interface CodeCandidate {
  /** As the shopper typed it (trimmed of edge punctuation): what a miss line quotes. */
  text: string;
  key: string;
  /** Code-like enough that "no exact match" may be said about it (`codeLike`). */
  reportable: boolean;
  /** The query's last chunk: while it is still being typed, a code that STARTS with it is not a miss. */
  last: boolean;
}

export interface QueryIdentifiers {
  codes: CodeCandidate[];
  /** Measure keys (`0.4`, `6X2`): never exact, never a miss — they preselect an option value. */
  measures: string[];
  /** Every chunk of the query is a code (none is a word or a size), and none was dropped by the cap. */
  onlyCodes: boolean;
}

/** The most codes one query looks up. */
export const MAX_QUERY_CODES = 12;
/** What separates the chunks of a query. A code's own separators (`-`, `.`, `/`) stay inside its chunk. */
const CHUNK_SPLIT = /[\s,،;؛!?؟«»"“”()[\]{}<>|]+/u;
const EDGE_PUNCTUATION = /^[-_./\\#:·+'*]+|[-_./\\#:·+'*]+$/gu;
/** A number with its unit glued on: «1000g», «24v», «500ml», «3mm» — a quantity, not a code. */
const QUANTITY = /^\d+(?:mm|cm|m|g|gr|kg|ml|l|w|kw|v|a|mah|hz|k|pcs|pc|x|in|mp)$/;

/**
 * May a miss be reported about this chunk? Four characters at least, and:
 * all digits and at least five («10102», a GTIN — never «2024» or «300»); or
 * letters with at least two digits («FAP035», «RTX4090» — never «X1Carbon» or
 * «A1mini», which are names). Never a chunk holding a size («0.4mm»,
 * «PLA1.75», «6x2») or a quantity («1000g»).
 */
function codeLike(chunk: string, key: string): boolean {
  if (key.length < 4) return false;
  const folded = foldText(chunk);
  if (extractMeasures(folded).measures.length > 0) return false;
  const lower = key.toLowerCase();
  if (QUANTITY.test(lower)) return false;
  const unit = /^\d+([a-z]+)$/.exec(lower);
  if (unit && MEASURE_UNITS.has(unit[1])) return false;
  const digits = (key.match(/\d/g) ?? []).length;
  if (digits === key.length) return key.length >= 5;
  return digits >= 2;
}

/** The codes and measures a query holds. Pure: no database. */
export function extractIdentifiers(text: unknown): QueryIdentifiers {
  if (typeof text !== 'string' || text.trim() === '') return { codes: [], measures: [], onlyCodes: false };
  const measures = [...new Set(extractMeasures(foldText(text)).measures.map(measureKey))];
  const chunks = text
    .split(CHUNK_SPLIT)
    .map((c) => c.replace(EDGE_PUNCTUATION, ''))
    .filter((c) => c !== '');
  const codes: CodeCandidate[] = [];
  const seen = new Set<string>();
  let onlyCodes = chunks.length > 0 && measures.length === 0;
  chunks.forEach((chunk, i) => {
    const key = identifierKey(chunk);
    if (!key) onlyCodes = false;
    if (!key || seen.has(key)) return;
    if (codes.length >= MAX_QUERY_CODES) {
      onlyCodes = false;
      return;
    }
    seen.add(key);
    codes.push({ text: chunk.slice(0, MAX_KEY), key, reportable: codeLike(chunk, key), last: i === chunks.length - 1 });
  });
  return { codes, measures, onlyCodes };
}

/** An exact answer: the product, and the selection of it the code names. */
export interface IdentifierHit {
  product_id: string;
  key: string;
  kind: IdentifierKind;
  scope: { kind: IdentifierScope; id: string };
}

/** The selection a product page opens with (`?v=` in the UI phase). */
export interface MatchedSelection {
  option_value_ids: string[];
  color_id: string | null;
  variant_id: string | null;
}

export interface IdentifierAnswer {
  /** One hit per product, in the order the codes were typed, narrowest scope first. Only products the caller may show. */
  exact: IdentifierHit[];
  /**
   * THE EXACT ANSWER IS THE WHOLE ANSWER: the query is nothing but codes and
   * every one of them is carried. «FAP035» is a question with one answer; the
   * products that merely share its letters («FAP030», a cutting mat) are not
   * answers to it, so the caller lists `exact` alone.
   */
  whole: boolean;
  /** productId → the selection its codes and sizes name. Products with nothing to preselect are absent. */
  matched: Map<string, MatchedSelection>;
  /** The codes, as typed, that no product the caller may show carries — "no exact match for …". */
  miss: string[];
}

interface LaneRow {
  src: 'id' | 'measure' | 'token' | 'prefix';
  key: string;
  product_id: string;
  scope_kind: string;
  scope_id: string;
  kind: string;
  live: number | null;
  group_id: string | null;
  combo_key: string | null;
}

/** The identifier rows of these keys, with what each scope still is (active, its group, its combination). */
const IDENTIFIER_HITS = (src: string, param: string, kindTest: string, limit: number) => `
  SELECT * FROM (
    SELECT '${src}' AS src, si.key AS key, si.product_id AS product_id, si.scope_kind AS scope_kind, si.scope_id AS scope_id,
           si.kind AS kind, COALESCE(ov.active, pc.active, pv.active, si.scope_kind = 'product') AS live,
           ov.group_id AS group_id, pv.combo_key AS combo_key
      FROM search_identifiers si
      LEFT JOIN product_option_values ov ON si.scope_kind = 'option_value' AND ov.id = si.scope_id AND ov.product_id = si.product_id
      LEFT JOIN product_colors pc ON si.scope_kind = 'color' AND pc.id = si.scope_id AND pc.product_id = si.product_id
      LEFT JOIN product_variants pv ON si.scope_kind = 'variant' AND pv.id = si.scope_id AND pv.product_id = si.product_id
     WHERE si.key IN (SELECT value FROM json_each(${param})) AND ${kindTest}
     LIMIT ${limit})`;

/**
 * ONE STATEMENT, SEVEN PARAMETERS, however many codes: the identifier hits of
 * the codes (?1) and of the sizes (?2), the index tokens that spell a code
 * whole (?3 — a code written in a product's name or description is not a
 * miss), and one row saying whether any identifier or token merely STARTS
 * with the chunk still being typed (?4–?7, `live` 1 when one does). Four
 * compound terms: D1 refuses more than five.
 */
const LANE_SQL = `${IDENTIFIER_HITS('id', '?1', "si.kind <> 'measure'", 400)}
  UNION ALL ${IDENTIFIER_HITS('measure', '?2', "si.kind = 'measure'", 1000)}
  UNION ALL SELECT * FROM (
    SELECT 'token', t.token, t.product_id, '', '', '', 1, NULL, NULL FROM search_tokens t
     WHERE t.token IN (SELECT value FROM json_each(?3)) LIMIT 400)
  UNION ALL SELECT 'prefix', '', '', '', '', '',
    (EXISTS (SELECT 1 FROM search_identifiers si WHERE ?4 <> '' AND si.key > ?4 AND si.key < ?5)
      OR EXISTS (SELECT 1 FROM search_tokens t WHERE ?6 <> '' AND t.token > ?6 AND t.token < ?7)), NULL, NULL`;

/** Narrowest first: a variant names the most, the product the least. */
const SCOPE_RANK: Readonly<Record<string, number>> = { variant: 0, color: 1, option_value: 1, product: 2 };

/** `o:<value>|c:<colour>` → the selection (worker/lib/importApply.ts `splitComboKey`, the one encoding). */
function comboSelection(combo: string): { option_value_ids: string[]; color_id: string | null } {
  const option_value_ids: string[] = [];
  let color_id: string | null = null;
  for (const part of combo.split('|')) {
    if (part.startsWith('o:')) option_value_ids.push(part.slice(2));
    else if (part.startsWith('c:')) color_id = part.slice(2);
  }
  return { option_value_ids, color_id };
}

/** One product's selection from every live hit it has: one variant, or one value per group and one colour. */
function selectionOf(rows: readonly LaneRow[]): MatchedSelection | null {
  const variants = new Map<string, string>();
  const groups = new Map<string, Set<string>>();
  const colours = new Set<string>();
  for (const r of rows) {
    if (r.scope_kind === 'variant') variants.set(r.scope_id, r.combo_key ?? '');
    else if (r.scope_kind === 'color') colours.add(r.scope_id);
    else if (r.scope_kind === 'option_value') {
      const g = r.group_id ?? r.scope_id;
      groups.set(g, (groups.get(g) ?? new Set()).add(r.scope_id));
    }
  }
  if (variants.size === 1) {
    const [[variantId, combo]] = [...variants];
    return { ...comboSelection(combo), variant_id: variantId };
  }
  const option_value_ids = [...groups.values()].filter((s) => s.size === 1).map((s) => [...s][0]);
  const color_id = colours.size === 1 ? [...colours][0] : null;
  if (option_value_ids.length === 0 && color_id === null) return null;
  return { option_value_ids: option_value_ids.sort(), color_id, variant_id: null };
}

export interface ResolveOptions {
  /** The last chunk is still being typed (no trailing space): a code that starts with it is not a miss. */
  typing?: boolean;
  /** Which of these products the caller may show (the listing's visibility). Absent: all of them. */
  visible?: (ids: string[]) => Promise<ReadonlySet<string>>;
}

/**
 * RESOLVE THE CODES AND SIZES IN A QUERY (`catalog.resolveIdentifier` of the
 * assistant plan §3.2). Exact only: a code is a hit when its key is stored,
 * never when it is near one.
 *
 * Null when migration 0206 is not on this database: the caller then says
 * nothing about codes at all — neither an exact answer nor a miss it cannot
 * know. A query with no code and no size costs no statement.
 */
export async function resolveIdentifier(db: D1Database, text: string, opts: ResolveOptions = {}): Promise<IdentifierAnswer | null> {
  const { codes, measures, onlyCodes } = extractIdentifiers(text);
  const empty: IdentifierAnswer = { exact: [], whole: false, matched: new Map(), miss: [] };
  if (codes.length === 0 && measures.length === 0) return empty;
  if (!(await searchIdentifiersInstalled(db))) return null;

  const typed = opts.typing ? codes.find((c) => c.last && c.reportable) : undefined;
  const idPrefix = typed?.key ?? '';
  const tokenPrefix = typed ? typed.key.toLowerCase() : '';
  let rows: LaneRow[];
  try {
    const { results } = await db
      .prepare(LANE_SQL)
      .bind(
        JSON.stringify(codes.map((c) => c.key)),
        JSON.stringify(measures),
        JSON.stringify(codes.filter((c) => c.reportable).map((c) => c.key.toLowerCase())),
        idPrefix,
        idPrefix ? `${idPrefix}~` : '',
        tokenPrefix,
        tokenPrefix ? `${tokenPrefix}\uffff` : ''
      )
      .all<LaneRow>();
    rows = results ?? [];
  } catch (e) {
    if (isMissingSearchIdentifiers(e)) return null;
    throw e;
  }

  const live = (r: LaneRow) => Number(r.live) === 1;
  /**
   * A CODE THAT BELONGS TO A SELECTION COUNTS WHILE THAT SELECTION IS SOLD.
   * Per product and key: when rows at a narrower scope exist (the colour a
   * product-scoped colour code was placed on, the variant a SKU names), the
   * product is a hit only through the live ones — a discontinued colour's code
   * is not an exact answer just because the product still carries it at
   * product scope. With no narrower row, the product-scope row answers.
   */
  const groupsOf = new Map<string, LaneRow[]>();
  for (const r of rows) {
    if (r.src !== 'id') continue;
    const k = `${r.key}\u0000${r.product_id}`;
    groupsOf.set(k, [...(groupsOf.get(k) ?? []), r]);
  }
  const codeHits: LaneRow[] = [];
  for (const list of groupsOf.values()) {
    const narrow = list.filter((r) => r.scope_kind !== 'product');
    codeHits.push(...(narrow.length > 0 ? narrow : list).filter(live));
  }
  const tokenRows = rows.filter((r) => r.src === 'token');
  const ids = [...new Set([...codeHits, ...tokenRows].map((r) => String(r.product_id)))];
  let shown: ReadonlySet<string> | null = null;
  if (opts.visible && ids.length > 0) shown = await opts.visible(ids).catch(() => null);
  const isShown = (pid: string) => shown === null || shown.has(pid);
  const shownHits = codeHits.filter((r) => isShown(String(r.product_id)));

  const exact: IdentifierHit[] = [];
  const inExact = new Set<string>();
  const miss: string[] = [];
  let whole = onlyCodes;
  for (const c of codes) {
    const hits = shownHits
      .filter((r) => r.key === c.key)
      .sort((a, b) => (SCOPE_RANK[a.scope_kind] ?? 3) - (SCOPE_RANK[b.scope_kind] ?? 3) || String(a.product_id).localeCompare(String(b.product_id)));
    for (const h of hits) {
      const pid = String(h.product_id);
      if (inExact.has(pid)) continue;
      inExact.add(pid);
      exact.push({
        product_id: pid,
        key: h.key,
        kind: h.kind as IdentifierKind,
        scope: { kind: h.scope_kind as IdentifierScope, id: h.scope_kind === 'product' ? '' : String(h.scope_id) },
      });
    }
    // A short or word-like code («X2D» as a SKU) never narrows the list to itself: only a code-like one does.
    if (hits.length === 0 || !c.reportable) whole = false;
    if (hits.length > 0 || !c.reportable) continue;
    const spelled = tokenRows.some((r) => r.key === c.key.toLowerCase() && isShown(String(r.product_id)));
    const started = c === typed && rows.some((r) => r.src === 'prefix' && live(r));
    if (!spelled && !started) miss.push(c.text);
  }

  // What each product's codes (the shown hits) and sizes name.
  const byProduct = new Map<string, LaneRow[]>();
  for (const r of [...shownHits, ...rows.filter((m) => m.src === 'measure' && live(m))]) {
    const pid = String(r.product_id);
    byProduct.set(pid, [...(byProduct.get(pid) ?? []), r]);
  }
  const matched = new Map<string, MatchedSelection>();
  for (const [pid, list] of byProduct) {
    const sel = selectionOf(list);
    if (sel) matched.set(pid, sel);
  }
  return { exact, whole: whole && exact.length > 0, matched, miss };
}
