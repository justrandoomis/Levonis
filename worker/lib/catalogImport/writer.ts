/**
 * THE CATALOGUE IMPORT'S WRITER (Bambu import spec §A.4, §A.5, §A.6, §B.6,
 * §B.8, §B.10, §C.2–§C.10, §D.2, §E.1–§E.4; docs/DECISIONS.md rows 239, 241).
 *
 * One product per call, through the app's own save path:
 *
 *   planImportWrite(ctx, input)  — allow-list (`assertImportPayload`), the item
 *       and its lease, the reviewed scope (./reviewed.ts, pure), the brand and
 *       the taxonomy read from D1, the document built from defaults
 *       (./doc.ts) or — for a reviewed merge — from the stored row, the
 *       relations wire body with the deterministic ids of §B.8 and `bv-`
 *       variant keys, the local translations (review_needed, never a ckb that
 *       copies the Arabic), `preflightProductSave` → media verification →
 *       `planProductSave`, then THE BATCH:
 *
 *         0  the guard row ops_guards('catalog-import-batch') — inserted only while
 *            the item is WRITING under this lease with this staged payload
 *            (else its CHECK aborts everything: a stale or changed write never lands)
 *         …  merge: the protected fingerprint SELECTs, one table per statement
 *         …  plan.statements (product, options, variants, images, catalogs,
 *            printer fits, search tokens, outbox)
 *         …  side statements: option-group 0194 columns, product_source_refs,
 *            product_option_source_refs, product_spec_values, product_documents,
 *            product_external_ids, product_relations, product_option_value_swatches,
 *            product_translations, catalog_import_conflicts — multi-row INSERTs
 *            of at most 100 bound parameters (owner-questions §E.4)
 *         …  incoming: the pending relations that name this product's handle,
 *            and their printer fits when this product is a printer (§B.6)
 *         n-2 the WRITTEN event (fenced by trg_cie_lease_fence)
 *         n-1 the checkpoint: PUBLISHING, last_completed_stage WRITING
 *         …  merge: the fingerprint SELECTs again; create: the money-default probe
 *         n+1 DELETE the guard row
 *
 *       and counts the whole invocation (./budget.ts): over 900 → PLAN_TOO_LARGE.
 *
 *   runImportWrite(ctx, plan)    — runs the batch (one D1 transaction), compares
 *       the fingerprints in memory, checks the money defaults, and does the
 *       post-commit bookkeeping (`postCommitProductSave`, the write digest).
 *
 * `/stage` calls `planImportWrite` with `mode: 'stage'`: the same plan against
 * placeholder media, never run, for its invocation estimate (§A.1 change 1).
 *
 * WHAT IT NEVER DOES. No price, cost, stock, SKU, warranty, ops, offer or
 * condition key reaches the document or the relations; the actor has no money
 * scope; compositions are refused; the guard triggers of 0195 abort any money,
 * stock, package or pricing write inside the batch, and the stock decision of
 * a created product is `not_configured` (§B.10).
 */
import {
  assertImportPayload,
  type ImportPayload,
  type PayloadBoxItem,
  type PayloadImage,
  type PayloadSpec,
} from '@levonis/catalog/bambuImport/payload';
import { specRowId } from '@levonis/catalog/bambuImport/specs';
import { relationRowId } from '@levonis/catalog/bambuImport/relations';
import { H, sha256Hex } from '@levonis/catalog/bambuImport/hash';
import { canonicalJson } from '@levonis/catalog/bambuImport/fingerprint';
import { specKey } from '@levonis/catalog/bambuImport/registry/specKeys';
import { colourFacet } from '@levonis/catalog/bambuImport/registry/colours';
import { HttpError } from '../http';
import { auditStatementCount } from '../audit';
import { comboKey } from '../inventory';
import { newId } from '../crypto';
import {
  loadRelationsResponse,
  localizeRespectingAuthored,
  planProductSave,
  postCommitProductSave,
  preflightProductSave,
  reloadForVerification,
  verifyApplied,
  type ProductSavePlan,
  type ProductWriteIntent,
  type RelationsResponse,
  type TranslationOverrides,
} from '../productPersistence';
import {
  parseProductRow,
  upgradeContentBlocks,
  upgradeSpecGroups,
  upgradeUsageGuide,
  type ContentBlockV2,
  type ProductDoc,
  type SpecGroupV2,
  type SpecRowV2,
  type UsageGuideV2,
} from '../productModel';
import { verifyAndNormalizeProductMedia } from '../productMediaWrite';
import { headMediaObject } from '../mediaStorage';
import { loadPrinterFitIds } from '../printerFits';
import { printerProductIds } from '../printerIdentity';
import { loadSearchAliases, ALIAS_SPEC_KEYS } from '../search/aliases';
import { productSlugFrom, uniqueProductSlug } from '../productSlug';
import { localizableSlots } from '../translationSlots';
import { hashSource, TRANSLATION_VERSION } from '../translate';
import { fieldsFor, flatFields } from '../templateFamilies';
import type { Env } from '../types';
import { GUARDED_ROW_TABLES, IMPORT_GUARD_ID, IMPORT_GUARD_REFUSAL, jsonElementMoneySql, nonDefaultSql, type GuardedColumn } from './protectedTables';
import { countingD1, IMPORT_INVOCATION_LIMIT, packedInserts, type InvocationCounter } from './budget';
import { newImportProductDoc } from './doc';
import {
  checkReviewedScope,
  payloadSha256,
  type ExistingMatch,
  type ManifestRow,
  type ReviewedBundle,
  type ScopeRefusalCode,
  type TaxonomyResolution,
} from './reviewed';

// ---------------------------------------------------------------- constants

/** The writer's actor (§A.4): a system id, no money scope. */
export const IMPORT_ACTOR = Object.freeze({ adminId: 'system:catalog-import', money: false });

/** The appended / created mirror group of official specifications (§C.6, §E.2), in three languages. */
export const OFFICIAL_SPEC_GROUP = Object.freeze({
  id: 'sg_bambu_official',
  title_ar: 'مواصفات Bambu Lab الرسمية',
  title_en: 'Bambu Lab official specifications',
  title_ckb: 'تایبەتمەندییە فەرمییەکانی Bambu Lab',
});

/** 0195's conflict kinds: a payload note of any other kind is not a conflict row. */
export const CONFLICT_KINDS: ReadonlySet<string> = new Set([
  'field_kept_existing',
  'variant_not_merged',
  'spec_sources_disagree',
  'image_unbound',
  'image_review',
  'taxonomy_note',
  'relation_unresolvable',
  'translation_review',
  'region_value',
  'sentence_withheld',
  'curation_disagreement',
  'tracker_unresolved',
  'category_filled',
]);

/** The planner's per-collection ceiling (productPersistence.ts MAX_ROWS_PER_COLLECTION). */
export const IMPORT_ROW_CAP = 400;

const BRAND_SLUG = 'bambu-lab';
const ARABIC = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

// ---------------------------------------------------------------- refusals

/**
 * A write the import refuses. `code` is the refusal (an ar/en/ckb code of
 * §C.11 where one exists); `blocker` the §B.5 code the item goes BLOCKED with
 * ('' = not a blocker: retry, e.g. a lost lease); `reason` a fixed reason code.
 * The message never carries input text, SQL or a value.
 */
export class ImportWriteRefused extends Error {
  constructor(
    readonly code: string,
    readonly blocker: string,
    readonly status: number,
    readonly reason: string
  ) {
    super(`${code} (${reason})`);
    this.name = 'ImportWriteRefused';
  }
}

const scopeRefusal = (code: ScopeRefusalCode, reason: string) =>
  new ImportWriteRefused(code === 'REVIEWED_SCOPE_REFUSED' ? 'IMPORT_REVIEWED_SCOPE_REFUSED' : code, code, 409, reason);

// ---------------------------------------------------------------- public types

export type MediaWriteEnv = Pick<Env, 'BUCKET' | 'R2_PUBLIC' | 'R2_PRIVATE' | 'IMAGES'>;

export interface ImportWriteContext {
  /** The counted binding: every statement of the invocation goes through it (./budget.ts). */
  db: D1Database;
  counter: InvocationCounter;
  /** The media bindings for verification; required in 'write' mode. */
  media?: MediaWriteEnv;
}

/** A context over a raw binding, counting from zero (tests, and a caller with no reads of its own). */
export function importWriteContext(db: D1Database, media?: MediaWriteEnv): ImportWriteContext {
  const counted = countingD1(db);
  return { db: counted.db, counter: counted.counter, media };
}

export interface ImportWriteInput {
  /** 'stage': plan against placeholder media and never run (§A.3 /stage); 'write': the real plan. */
  mode: 'stage' | 'write';
  payload: unknown;
  bundle: ReviewedBundle;
  runId: string;
  itemId: string;
  leaseToken: string;
  /** When the source page was fetched (product_source_refs.fetched_at, spec rows' retrieved_at). */
  retrievedAt?: string;
  /**
   * The runner's document checks (§A.3 /write `document_checks`, §C.7): each names a payload document and what
   * its HEAD/GET answered. They land on product_documents; a dead link is written `active = 0`, never shown.
   */
  documentChecks?: readonly DocumentCheck[];
  /**
   * TEST-ONLY SEAM (tests/catalogImportAllowList.test.ts): skip the allow-list so
   * the DB guard is proven on its own. No route ever sets it.
   */
  unsafeSkipAllowListForTests?: true;
}

/** One document check of the runner (scripts/bambu-import/opsClient.ts `DocumentCheck`). */
export interface DocumentCheck {
  document_id: string;
  check_status: number;
  content_type: string;
  byte_size: number | null;
  content_sha256: string;
  checked_at: string;
  tracker_source: string;
}

/**
 * The counts the runner's edge evidence carries (scripts/bambu-import/verify.ts `edgeEvidence`): the payload's
 * own collection sizes. Stored at the write, so /complete can tell that the runner verified the payload this
 * item wrote (§I.1 "their counts agree"); what D1 holds is compared with `written` separately.
 */
export function payloadCounts(payload: ImportPayload): Record<string, number> {
  return {
    groups: payload.groups.length,
    values: payload.groups.reduce((n, g) => n + g.values.length, 0),
    variants: payload.variants.length,
    images: payload.images.length,
    swatches: payload.swatches.length,
    documents: payload.documents.length,
    relations: payload.relations.length,
    specs: payload.specs.length,
  };
}

/** A link answered 2xx/3xx is alive; anything else (and 0: no answer) is dead and stays off the storefront. */
export const documentAlive = (status: number): boolean => status >= 200 && status < 400;

/** What the batch wrote, by kind (stored on the item as stage_data.written for /complete, §I.1.10). */
export interface WrittenCounts {
  groups: number;
  values: number;
  variants: number;
  images: number;
  image_bindings: Record<string, number>;
  swatches: number;
  specs: number;
  specs_by_status: Record<string, number>;
  specs_by_region: Record<string, number>;
  documents: number;
  relations: number;
  relations_by_state: Record<string, number>;
  external_ids: number;
  source_refs: number;
  conflicts: number;
  box_items: number;
  content_blocks: number;
  translations: number;
}

export interface ImportImageRow {
  id: string;
  source_media_id: string;
  r2_key: string;
  url: string;
  sort_order: number;
  is_primary: boolean;
  option_value_id: string | null;
  color_id: string | null;
  variant_id: string | null;
  via_variant_id: string;
  binding_rule: string;
}

export interface ImportWriteEstimate {
  /** Statements the invocation sent before the batch (auth, lease, reads, preflight, media verification, planner). */
  reads: number;
  batch: number;
  postCommit: number;
  total: number;
  limit: number;
}

export interface ImportWritePlan {
  mode: 'stage' | 'write';
  runId: string;
  itemId: string;
  leaseToken: string;
  productId: string;
  slug: string;
  matchKind: 'created' | 'merged';
  payloadSha256: string;
  statements: D1PreparedStatement[];
  save: ProductSavePlan;
  /** Positions in `statements` of the fingerprint SELECTs (merge) and the money probe (create). */
  layout: { before: [number, number]; after: [number, number]; probe: number; fingerprintTables: string[] };
  estimate: ImportWriteEstimate;
  counts: WrittenCounts;
  /** The final image rows (after media and the content-duplicate collapse): the runner's expected fingerprint reads them. */
  images: ImportImageRow[];
  searchAliases: string[];
  warnings: string[];
  /** The conflict rows the write records, by kind and field (never their detail): /stage answers these. */
  conflicts: Array<{ kind: string; field: string }>;
}

export interface ImportWriteResult {
  product_id: string;
  slug: string;
  created: boolean;
  merged: boolean;
  counts: WrittenCounts;
  /**
   * Merge: the protected fingerprints before and after are equal (read inside the batch, compared after its commit;
   * a JSON array of money by its fee tuples, as the guard trigger compares it); null for a create.
   */
  before_fp_equal: boolean | null;
  /**
   * Create: every guarded money, stock and package column (GUARDED_ROW_TABLES) of the new product and of its value,
   * variant and colour rows is at its default, and the stock decision is 'not_configured'; null for a merge.
   */
  after_money_default: boolean | null;
  /** verifyApplied's mismatches against this payload's plan, right after the commit (-1: the readback could not run). */
  readback_mismatches: number;
  /**
   * The image rows this write bound, AFTER the content-duplicate collapse (§C.4 step 1): the runner computes the
   * expected public projection from the payload, this answer and the /media results (§I.1.2) — a payload image
   * absent here was collapsed into the earlier copy of the same bytes.
   */
  images: Array<Pick<ImportImageRow, 'id' | 'source_media_id' | 'r2_key' | 'sort_order' | 'is_primary' | 'option_value_id' | 'variant_id' | 'color_id' | 'binding_rule'>>;
}

// ---------------------------------------------------------------- small helpers

const tally = <T>(xs: readonly T[], key: (x: T) => string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const x of xs) out[key(x)] = (out[key(x)] ?? 0) + 1;
  return out;
};

/** DECISIONS row 183: a ckb slot never copies the Arabic. A copy becomes '' (the reader falls back to the English). */
export const ckbNotCopy = (ar: string, ckb: string): string => (ar !== '' && ar === ckb && ARABIC.test(ar) ? '' : ckb);

const isMissingImportTable = (e: unknown) => /no such table:?\s*(catalog_import_\w+|product_source_refs|product_spec_values|product_relations)/i.test(String((e as Error)?.message ?? e));

const message = (e: unknown) => String((e as Error)?.message ?? e);

// ---------------------------------------------------------------- media and the content-duplicate collapse (§C.4 step 1)

interface MediaRow {
  status: string;
  r2_key: string;
  width: number | null;
  height: number | null;
  bytes: number | null;
}

/**
 * Gallery entries whose stored WebP has the SAME object key collapse into the
 * earliest position (§C.4 step 1), recomputed here from the item's own media
 * rows: when any copy is bound, the general copies go and the bound rows of a
 * later copy take the earliest position — with rule `content_duplicate`, except
 * a representative (its via variant kept) and a reviewed override; when
 * none is, only the earliest general row stays. Rows of ONE gallery entry
 * (a value set) are never collapsed. Exactly one primary is kept.
 */
export function collapseContentDuplicates(rows: readonly ImportImageRow[]): { rows: ImportImageRow[]; collapsed: number } {
  const byKey = new Map<string, ImportImageRow[]>();
  rows.forEach((r) => {
    const list = byKey.get(r.r2_key) ?? [];
    list.push(r);
    byKey.set(r.r2_key, list);
  });
  const drop = new Set<string>();
  const changed = new Map<string, Partial<ImportImageRow>>();
  for (const group of byKey.values()) {
    const sources = [...new Set(group.map((r) => r.source_media_id))];
    if (sources.length < 2) continue;
    const firstSort = (sid: string) => Math.min(...group.filter((r) => r.source_media_id === sid).map((r) => r.sort_order));
    const canonical = sources.reduce((a, b) => (firstSort(b) < firstSort(a) ? b : a));
    const earliest = firstSort(canonical);
    const bound = group.filter((r) => r.option_value_id || r.variant_id || r.color_id);
    if (bound.length) {
      const seen = new Set<string>();
      for (const r of group) {
        const binding = `${r.option_value_id ?? ''}|${r.variant_id ?? ''}|${r.color_id ?? ''}`;
        if (!(r.option_value_id || r.variant_id || r.color_id) || seen.has(binding)) {
          drop.add(r.id);
          continue;
        }
        seen.add(binding);
        if (r.source_media_id === canonical) continue;
        // A representative keeps its rule and the variant whose hero it shows (R6: the page drops it on a clashing
        // selection), and a reviewed override its rule, as the package's own planMedia places them; only a binding
        // inherited from the copy (value, variant, value set) becomes 'content_duplicate'. Either way it moves first.
        changed.set(
          r.id,
          r.binding_rule === 'representative' || r.binding_rule === 'reviewed_override'
            ? { sort_order: earliest }
            : { sort_order: earliest, binding_rule: 'content_duplicate', via_variant_id: '' }
        );
      }
    } else {
      const keep = group.find((r) => r.source_media_id === canonical && r.sort_order === earliest) ?? group[0];
      for (const r of group) if (r.id !== keep.id) drop.add(r.id);
    }
  }
  const out = rows.filter((r) => !drop.has(r.id)).map((r) => ({ ...r, ...(changed.get(r.id) ?? {}) }));
  if (out.length && !out.some((r) => r.is_primary)) {
    const lead = [...out].sort((a, b) => a.sort_order - b.sort_order)[0];
    lead.is_primary = true;
  }
  let seenPrimary = false;
  for (const r of out) {
    if (r.is_primary && seenPrimary) r.is_primary = false;
    if (r.is_primary) seenPrimary = true;
  }
  return { rows: out, collapsed: rows.length - out.length };
}

// ---------------------------------------------------------------- search aliases (§C.1, step 5)

/** The aliases the batch is about to write: searchable external ids and public identity model/series rows. */
export function importSearchAliases(
  externalIds: ReadonlyArray<{ value: string; searchable: boolean }>,
  specs: ReadonlyArray<{ key: string; value_text: string; visibility: string }>
): string[] {
  const out = new Set<string>();
  for (const e of externalIds) if (e.searchable && e.value.trim() && e.value.trim().length <= 120) out.add(e.value.trim());
  for (const s of specs) {
    if ((ALIAS_SPEC_KEYS as readonly string[]).includes(s.key) && s.visibility === 'public' && s.value_text.trim()) out.add(s.value_text.trim());
  }
  return [...out].sort();
}

// ---------------------------------------------------------------- the fingerprints (§E.4)

const guardedColumns = (table: string): GuardedColumn[] => {
  const t = GUARDED_ROW_TABLES.find((x) => x.table === table)!;
  return [...t.money, ...t.stock, ...t.package];
};

/**
 * A fingerprint column: the value itself; a JSON array of money (warranty plans, pre-order routes) by the guard
 * trigger's own tuple multiset (protectedTables.ts jsonElementMoneySql), never its text — the save path
 * re-serialises those columns on every save (a legacy `{name, price_iqd}` plan, a route without `active`) and
 * that moves no fee, so a merge that the trigger lets through reads the same before and after.
 */
const fingerprintColumns = (table: string): string[] =>
  guardedColumns(table).map((c) => (c.jsonElementMoney ? `${jsonElementMoneySql(c, table)} AS ${c.name}` : c.name));

/** One table per statement, never a UNION chain (§A.5). Each binds the product id once. */
export const FINGERPRINT_QUERIES: ReadonlyArray<{ table: string; sql: string }> = [
  { table: 'products', sql: `SELECT id, ${fingerprintColumns('products').join(', ')} FROM products WHERE id = ?` },
  { table: 'product_option_values', sql: `SELECT id, ${fingerprintColumns('product_option_values').join(', ')} FROM product_option_values WHERE product_id = ? ORDER BY id` },
  { table: 'product_colors', sql: `SELECT id, ${fingerprintColumns('product_colors').join(', ')} FROM product_colors WHERE product_id = ? ORDER BY id` },
  { table: 'product_variants', sql: `SELECT id, ${fingerprintColumns('product_variants').join(', ')} FROM product_variants WHERE product_id = ? ORDER BY id` },
  { table: 'product_option_fulfillment', sql: 'SELECT * FROM product_option_fulfillment WHERE product_id = ? ORDER BY id' },
  { table: 'product_option_transports', sql: 'SELECT * FROM product_option_transports WHERE product_id = ? ORDER BY id' },
  { table: 'product_pricing_state', sql: 'SELECT * FROM product_pricing_state WHERE product_id = ?' },
  { table: 'product_sku_prices', sql: 'SELECT * FROM product_sku_prices WHERE product_id = ? ORDER BY combo_key, channel' },
  { table: 'pricing_v2_sku_results', sql: 'SELECT * FROM pricing_v2_sku_results WHERE product_id = ? ORDER BY combo_key, channel' },
  { table: 'pricing_price_points', sql: 'SELECT * FROM pricing_price_points WHERE product_id = ? ORDER BY scope, scope_id, kind' },
  { table: 'pricing_preorder_discounts', sql: 'SELECT * FROM pricing_preorder_discounts WHERE product_id = ? ORDER BY scope, scope_id' },
  { table: 'inventory_lots', sql: 'SELECT COUNT(*) AS n, total(qty_received) AS received, total(qty_remaining) AS remaining, total(total_cost_iqd) AS cost FROM inventory_lots WHERE product_id = ?' },
  { table: 'inventory_ledger', sql: 'SELECT COUNT(*) AS n, total(qty) AS qty, MAX(id) AS last FROM inventory_ledger WHERE product_id = ?' },
  { table: 'order_items', sql: 'SELECT COUNT(*) AS n, total(qty) AS qty, total(line_total_iqd) AS total FROM order_items WHERE product_id = ?' },
  { table: 'price_history', sql: 'SELECT COUNT(*) AS n, MAX(id) AS last FROM price_history WHERE product_id = ?' },
];

/** Any guarded column of `table` away from its insert default (the generated triggers' own expressions). */
const anyNonDefault = (table: string) => guardedColumns(table).map((c) => nonDefaultSql(c, table)).join(' OR ');
const GUARDED_CHILD_TABLES = GUARDED_ROW_TABLES.map((t) => t.table).filter((t) => t !== 'products');

/**
 * The new product's money, stock, package and stock-decision probe (§A.5): one statement, generated from the one
 * list (GUARDED_ROW_TABLES), so every guarded column of the product and of its value, variant and colour rows is
 * read — never a hand-kept subset.
 */
export const MONEY_PROBE_SQL = `SELECT
  (SELECT COUNT(*) FROM products WHERE id = ?1 AND NOT (${anyNonDefault('products')})) AS product_ok,
  ${GUARDED_CHILD_TABLES.map((t) => `(SELECT COUNT(*) FROM ${t} WHERE product_id = ?1 AND (${anyNonDefault(t)})) AS ${t}_bad`).join(',\n  ')},
  (SELECT COUNT(*) FROM product_source_refs WHERE product_id = ?1 AND stock_decision = 'not_configured') AS stock_decision_ok`;

/** The probe's row read as "every money, stock and package column of the new rows is at its default". */
export const moneyProbeAtDefault = (p: Record<string, unknown>): boolean =>
  Number(p.product_ok) === 1 && Number(p.stock_decision_ok) === 1 && GUARDED_CHILD_TABLES.every((t) => Number(p[`${t}_bad`]) === 0);

// ---------------------------------------------------------------- reads

interface ItemRow {
  id: string;
  run_id: string;
  source: string;
  source_product_id: string;
  handle: string;
  canonical_url: string;
  processing_state: string;
  lease_token: string;
  payload_sha256: string;
  slug: string;
  source_collections: string;
  run_state: string;
  lease_live: number;
}

async function loadItem(db: D1Database, runId: string, itemId: string): Promise<ItemRow> {
  let row: ItemRow | null;
  try {
    row = await db
      .prepare(
        `SELECT i.id, i.run_id, i.source, i.source_product_id, i.handle, i.canonical_url, i.processing_state, i.lease_token,
                i.payload_sha256, i.slug, i.source_collections, r.state AS run_state,
                CASE WHEN i.lease_until > ${NOW_SQL} THEN 1 ELSE 0 END AS lease_live
           FROM catalog_import_items i JOIN catalog_import_runs r ON r.id = i.run_id
          WHERE i.id = ? AND i.run_id = ?`
      )
      .bind(itemId, runId)
      .first<ItemRow>();
  } catch (e) {
    if (isMissingImportTable(e)) throw new ImportWriteRefused('IMPORT_NOT_INSTALLED', '', 503, 'migrations_0194_0195_absent');
    throw e;
  }
  if (!row) throw new ImportWriteRefused('IMPORT_ITEM_NOT_FOUND', '', 404, 'item_not_in_run');
  return row;
}

/** Does the product have V2 results (a published price)? A database without the table has none. */
async function hasV2Results(db: D1Database, productId: string): Promise<boolean> {
  try {
    return !!(await db.prepare('SELECT 1 AS x FROM pricing_v2_sku_results WHERE product_id = ? LIMIT 1').bind(productId).first());
  } catch {
    return false;
  }
}

/** One statement (STAGE_MEDIA_READS: /stage adds it to its estimate, so the two totals agree). */
async function loadMedia(db: D1Database, runId: string, sourceProductId: string): Promise<Map<string, MediaRow>> {
  const { results } = await db
    .prepare('SELECT source_media_id, status, r2_key, width, height, bytes FROM catalog_import_media WHERE run_id = ? AND source_product_id = ?')
    .bind(runId, sourceProductId)
    .all<MediaRow & { source_media_id: string }>();
  return new Map((results ?? []).map((r) => [String(r.source_media_id), r]));
}

interface CatalogRow {
  id: string;
  parent_id: string | null;
  slug: string;
  template_family: string | null;
  is_printer_catalog: number;
  active: number;
}

interface ResolvedTaxonomy {
  category_id: string;
  sub_category_id: string | null;
  secondaries: string[];
  template_family: 'devices' | 'materials' | null;
  /** Root and leaf slugs, for the template fields (§C.6 mirrors). */
  slugs: string[];
  /** Every catalog of the placement is a printer catalog → this product is a printer (§B.6 mirror). */
  printerCatalogs: Set<string>;
  catalogs: Map<string, CatalogRow>;
}

async function resolveCatalogs(db: D1Database, tax: TaxonomyResolution): Promise<ResolvedTaxonomy> {
  const { results } = await db
    .prepare('SELECT id, parent_id, slug, template_family, is_printer_catalog, active FROM catalogs')
    .all<CatalogRow>();
  const catalogs = new Map((results ?? []).map((r) => [String(r.id), r]));
  for (const id of [tax.primary, ...tax.secondaries]) {
    if (!catalogs.has(id)) throw new ImportWriteRefused('TAXONOMY_UNMAPPED', 'TAXONOMY_UNMAPPED', 409, 'catalog_node_not_prepared');
  }
  const chain: CatalogRow[] = [];
  for (let at: CatalogRow | undefined = catalogs.get(tax.primary); at && chain.length < 12; at = at.parent_id ? catalogs.get(at.parent_id) : undefined) chain.push(at);
  const root = chain[chain.length - 1];
  const leaf = chain[0];
  const family = (chain.map((c) => c.template_family).find((f) => f === 'devices' || f === 'materials') ?? null) as ResolvedTaxonomy['template_family'];
  const printerCatalogs = new Set([tax.primary, root.id, ...tax.secondaries].filter((id) => Number(catalogs.get(id)?.is_printer_catalog ?? 0) === 1));
  return {
    category_id: root.id,
    sub_category_id: root.id === leaf.id ? null : leaf.id,
    secondaries: tax.secondaries,
    template_family: family,
    slugs: root.id === leaf.id ? [root.slug] : [root.slug, leaf.slug],
    printerCatalogs,
    catalogs,
  };
}

async function brandId(db: D1Database): Promise<string> {
  const row = await db.prepare('SELECT id FROM brands WHERE slug = ?').bind(BRAND_SLUG).first<{ id: string }>();
  if (!row) throw new ImportWriteRefused('TAXONOMY_UNMAPPED', 'TAXONOMY_UNMAPPED', 409, 'brand_not_prepared');
  return String(row.id);
}

// ---------------------------------------------------------------- the spec mirrors (§C.6 "Mirrors written in the same batch")

/** Spec rows the legacy mirrors carry: public, product-scoped, verified or unverified, never a US-only value. */
const mirrorable = (s: PayloadSpec) =>
  s.visibility === 'public' &&
  s.scope_kind === 'product' &&
  (s.status === 'verified' || s.status === 'unverified') &&
  (s.region === '' || s.region === 'intl_220v') &&
  s.key !== 'package.contents' &&
  s.key !== 'compat.statement' &&
  !s.key.startsWith('manufacturer_terms.');

const valueOf = (s: PayloadSpec): string => {
  const text = s.value_text.trim();
  if (text) return text.slice(0, 1000);
  if (s.value_num !== null) return `${s.value_num}${s.value_num_max !== null ? `–${s.value_num_max}` : ''}${s.unit ? ` ${s.unit}` : ''}`;
  if (s.value_bool !== null) return s.value_bool ? 'Yes' : 'No';
  return '';
};

/**
 * Keys the specification TABLE never shows: `identity.family` is the internal product_family code (identity-map.json,
 * "internal, from the type"), written to product_spec_values for the facet mirror only (§C.1, §G.5) — step 7's
 * knowledge tab hides the same key (NOT_DISPLAYED_KEYS).
 */
const NOT_IN_SPEC_TABLE: ReadonlySet<string> = new Set(['identity.family']);

/**
 * The official-specifications group: registry labels in three languages (authored, kept as reviewed); every value
 * left to the local dictionary like any imported prose (§1 row 16, §C.8: what the dictionary renders, status
 * imported / review_needed — never authored, so a word it knows is never kept in English and a later save may
 * still bring a newer dictionary term).
 */
export function officialSpecGroup(specs: readonly PayloadSpec[], skipLabels: ReadonlySet<string> = new Set()): { group: SpecGroupV2 | null; overrides: TranslationOverrides } {
  const overrides: TranslationOverrides = {};
  const rows: SpecRowV2[] = [];
  for (const s of specs) {
    if (!mirrorable(s) || NOT_IN_SPEC_TABLE.has(s.key)) continue;
    const value = valueOf(s);
    if (!value) continue;
    const def = specKey(s.key);
    const label = def ? def.labels : { en: s.original_label || s.key, ar: '', ckb: '' };
    if (skipLabels.has(label.en.toLowerCase())) continue;
    const id = `sr_${s.id.replace(/^sv_/, '')}`;
    rows.push({ id, label_en: label.en, label_ar: label.ar, label_ckb: ckbNotCopy(label.ar, label.ckb), value_en: value, value_ar: '', value_ckb: '', unit: '', order: rows.length });
    // Authored registry labels stay as they are (an x.* label is left to the dictionary).
    if (def) overrides[`spec:${OFFICIAL_SPEC_GROUP.id}:${id}:label`] = { ar: label.ar, ckb: ckbNotCopy(label.ar, label.ckb) };
  }
  if (!rows.length) return { group: null, overrides: {} };
  overrides[`spec_group:${OFFICIAL_SPEC_GROUP.id}:title`] = { ar: OFFICIAL_SPEC_GROUP.title_ar, ckb: OFFICIAL_SPEC_GROUP.title_ckb };
  return { group: { ...OFFICIAL_SPEC_GROUP, order: 0, rows }, overrides };
}

/** spec_fields[templateField] for the fields the product's branch declares (a select only with a declared option). */
export function specFieldMirror(specs: readonly PayloadSpec[], family: 'devices' | 'materials' | null, slugs: string[]): Record<string, string> {
  if (!family) return {};
  const fields = new Map(flatFields(fieldsFor(family, slugs)).map((f) => [f.id, f]));
  const out: Record<string, string> = {};
  for (const s of specs) {
    const isBox = s.key === 'package.contents' && s.scope_kind === 'product' && s.visibility === 'public';
    const fieldId = isBox ? 'in_the_box' : specKey(s.key)?.templateField;
    if (!fieldId || out[fieldId] !== undefined) continue;
    const f = fields.get(fieldId);
    if (!f || (!isBox && !mirrorable(s))) continue;
    let v = isBox ? s.value_text.trim() : f.type === 'number' ? (s.value_num !== null ? String(s.value_num) : '') : valueOf(s);
    if (!v) continue;
    if (f.type === 'select' && !(f.options ?? []).includes(v)) continue;
    v = v.slice(0, 2000);
    out[fieldId] = v;
  }
  return out;
}

/**
 * The spool group's value as the `spool_type` field's own option words, read by the same rules as the listing's
 * spool facet (packages/catalog discovery spoolToken): refill / no spool → Refill, cardboard → Cardboard, spool →
 * With spool; anything else says nothing (never guessed).
 */
export function spoolOptionOf(value: string): 'Refill' | 'Cardboard' | 'With spool' | null {
  const t = value.trim().toLowerCase();
  if (/\brefill\b|\bno spool\b|\bwithout spool\b/.test(t)) return 'Refill';
  if (/\bcardboard\b/.test(t)) return 'Cardboard';
  if (/\bspool\b/.test(t)) return 'With spool';
  return null;
}

/**
 * The facet mirrors an option group carries (§C.6 "Facet mirrors", §G.5), for the fields the product's branch
 * declares: `color_name` = the colour group's base colours (registry/colours.ts), `spool_type` = the spool group's
 * option words. Both are multi-valued facets joined by ' | ' (a filament sold as refill and with a spool is both),
 * so `spool_type` is the one select written outside its single-option rule.
 */
export function optionFacetMirror(groups: ImportPayload['groups'], family: 'devices' | 'materials' | null, slugs: string[]): Record<string, string> {
  if (!family) return {};
  const declared = new Set(flatFields(fieldsFor(family, slugs)).map((f) => f.id));
  const out: Record<string, string> = {};
  const valuesOf = (kind: string) => groups.filter((g) => g.kind === kind).flatMap((g) => g.values.map((v) => v.name_en));
  if (declared.has('color_name')) {
    const colours = colourFacet(valuesOf('color'));
    if (colours) out.color_name = colours.slice(0, 2000);
  }
  if (declared.has('spool_type')) {
    const words = [...new Set(valuesOf('spool').map(spoolOptionOf).filter((w): w is NonNullable<typeof w> => !!w))];
    if (words.length) out.spool_type = words.join(' | ');
  }
  return out;
}

// ---------------------------------------------------------------- the merge mapping (§E.2, §E.3)

interface MergeMapping {
  /** payload value id → the existing option value or colour it maps to. */
  values: Map<string, { optionValueId?: string; colorId?: string }>;
  /** payload variant id → the existing variant, value or colour it maps to. */
  variants: Map<string, { variantId?: string; optionValueId?: string; colorId?: string }>;
  unmappedVariants: string[];
}

function mergeMapping(payload: ImportPayload, match: ExistingMatch, rel: RelationsResponse): MergeMapping {
  const existingValues = new Set(rel.values.map((v) => String(v.id)));
  const existingColors = new Set(rel.colors.map((c) => String(c.id)));
  const variantByKey = new Map(rel.variants.map((v) => [String(v.combo_key), String(v.id)]));
  const entryOf = new Map<string, { option_value_ids?: string[]; color_id?: string }>();
  const unmapped: string[] = [...match.unmapped_variants];
  for (const v of payload.variants) {
    const e = match.value_map[v.source_id];
    const ok =
      !!e &&
      (e.option_value_ids ?? []).every((id) => existingValues.has(id)) &&
      (!e.color_id || existingColors.has(e.color_id));
    if (ok) entryOf.set(v.id, e);
    else if (!unmapped.includes(v.source_id)) unmapped.push(v.source_id);
  }
  const variants: MergeMapping['variants'] = new Map();
  for (const [vid, e] of entryOf) {
    const key = comboKey({ option_value_ids: e.option_value_ids ?? [], color_id: e.color_id ?? null });
    const existing = key ? variantByKey.get(key) : undefined;
    if (existing) variants.set(vid, { variantId: existing });
    else if ((e.option_value_ids ?? []).length === 1 && !e.color_id) variants.set(vid, { optionValueId: e.option_value_ids![0] });
    else if (e.color_id && !(e.option_value_ids ?? []).length) variants.set(vid, { colorId: e.color_id });
  }
  const values: MergeMapping['values'] = new Map();
  for (const g of payload.groups) {
    for (const val of g.values) {
      const entries = payload.variants.filter((v) => v.value_ids.includes(val.id)).map((v) => entryOf.get(v.id));
      if (!entries.length || entries.some((e) => !e)) continue;
      let common: string[] | null = null;
      for (const e of entries) {
        const ids = e!.option_value_ids ?? [];
        common = common === null ? [...ids] : common.filter((id) => ids.includes(id));
      }
      if (common && common.length === 1) {
        values.set(val.id, { optionValueId: common[0] });
        continue;
      }
      const colours = new Set(entries.map((e) => e!.color_id ?? ''));
      if (colours.size === 1 && [...colours][0]) values.set(val.id, { colorId: [...colours][0] });
    }
  }
  return { values, variants, unmappedVariants: unmapped };
}

// ---------------------------------------------------------------- the plan

interface SideRow {
  table: string;
  head: string;
  row: string;
  tail: string;
  values: unknown[][];
}

/** Everything a write plans from the payload once the product's id, scope ids and media are settled. */
interface Mapped {
  images: ImportImageRow[];
  imageAlts: Map<string, { en: string; ar: string; ckb: string; source_url: string }>;
  swatches: Array<{ valueId: string; url: string; key: string; width: number | null; height: number | null; sourceUrl: string }>;
  specs: Array<PayloadSpec & { valueListJson: string }>;
  documents: ImportPayload['documents'];
  externalIds: ImportPayload['external_ids'];
  relations: ImportPayload['relations'];
  sourceRefs: Array<{ kind: string; source_id: string; levonis_id: string; source_label: string; binding_rule: string; via_variant_id: string }>;
  conflicts: Array<{ kind: string; field: string }>;
  boxItems: number;
}

const STAGE_KEY = (sourceMediaId: string) => `products/import/stage/${sha256Hex(sourceMediaId)}.webp`;

/**
 * Builds the write. Throws ImportWriteRefused (the scope, the item, the
 * taxonomy, the media, the budget), ImportPayloadRefused (the allow-list), or
 * the planner's own HttpError (RELATIONS_VALIDATION …, a PAYLOAD_REFUSED for the
 * route).
 */
export async function planImportWrite(ctx: ImportWriteContext, input: ImportWriteInput): Promise<ImportWritePlan> {
  const db = ctx.db;
  // 1. The allow-list (§C.10 layer 2).
  const payload = input.unsafeSkipAllowListForTests ? (input.payload as ImportPayload) : assertImportPayload(input.payload);
  const sha = payloadSha256(payload);
  const warnings: string[] = [];

  // 2. The item, its lease and its run.
  const item = await loadItem(db, input.runId, input.itemId);
  if (item.source !== payload.source || item.source_product_id !== payload.source_product_id || item.handle !== payload.handle) {
    throw new ImportWriteRefused('IMPORT_IDENTITY_AMBIGUOUS', 'IDENTITY_AMBIGUOUS', 409, 'payload_names_another_item');
  }
  if (!['open', 'running'].includes(item.run_state)) throw new ImportWriteRefused('IMPORT_RUN_NOT_OPEN', '', 409, 'run_not_open');
  if (!item.lease_token || item.lease_token !== input.leaseToken || Number(item.lease_live) !== 1) {
    throw new ImportWriteRefused('IMPORT_LEASE_LOST', '', 409, 'lease_not_held');
  }
  if (input.mode === 'write') {
    if (item.processing_state !== 'WRITING') throw new ImportWriteRefused('IMPORT_ILLEGAL_TRANSITION', '', 409, 'item_not_writing');
    if (!item.payload_sha256 || item.payload_sha256 !== sha) throw new ImportWriteRefused('IMPORT_NOT_STAGED', 'PAYLOAD_REFUSED', 409, 'payload_differs_from_staged');
  }

  // 3. The reviewed scope (pure, §A.3, §E.1).
  const verdict = checkReviewedScope(input.bundle, payload);
  if (!verdict.ok) throw scopeRefusal(verdict.refusal.code, verdict.refusal.reason);
  const { row: manifestRow, match } = verdict;
  const merge = payload.write_mode === 'merge';

  // Every variant's key is the one the planner will compute (§C.3); a SKU naming no value was refused upstream.
  const groupOfValue = new Map(payload.groups.flatMap((g) => g.values.map((v) => [v.id, g.id] as const)));
  for (const v of payload.variants) {
    if (v.value_ids.some((id) => !groupOfValue.has(id)) || comboKey({ option_value_ids: v.value_ids, color_id: null }) !== v.combo_key) {
      throw new ImportWriteRefused('IMPORT_IDENTITY_AMBIGUOUS', 'IDENTITY_AMBIGUOUS', 409, 'variant_combo_key_differs');
    }
  }
  const valueCount = payload.groups.reduce((n, g) => n + g.values.length, 0);
  if (payload.groups.length > IMPORT_ROW_CAP || valueCount > IMPORT_ROW_CAP || payload.variants.length > IMPORT_ROW_CAP || payload.images.length > IMPORT_ROW_CAP) {
    throw new ImportWriteRefused('ROW_CAP', 'ROW_CAP', 409, 'collection_over_400_rows');
  }

  // 3b. A create never lands on a product that already has V2 results (the step 5 review): the stock gate's
  //     automatic-repricing exemption assumes no 'created' source row ever names a priced product. Read here,
  //     and fenced again inside the batch (the guard row's condition), so a price published in between aborts it.
  if (!merge && (await hasV2Results(db, payload.product_id))) {
    throw new ImportWriteRefused('IMPORT_CREATE_ON_PRICED_PRODUCT', 'REVIEWED_SCOPE_REFUSED', 409, 'product_has_v2_results');
  }

  // 4. Brand and taxonomy, read from D1 (§A.4 step 2, §D.2).
  const brand = await brandId(db);
  const tax = await resolveCatalogs(db, verdict.taxonomy);

  // 5. Media: the item's own rows (write), or placeholders (stage).
  const media = input.mode === 'write' ? await loadMedia(db, input.runId, payload.source_product_id) : null;
  const stored = (sourceMediaId: string): MediaRow | null => {
    if (!media) return { status: 'stored', r2_key: STAGE_KEY(sourceMediaId), width: null, height: null, bytes: null };
    const m = media.get(sourceMediaId);
    return m && m.status === 'stored' && m.r2_key ? m : null;
  };
  /**
   * The media that are not gallery rows — swatches, description images, in-the-box pictures — are proven by an
   * R2 HEAD (present, non-empty, WebP), which costs no D1 statement: the full byte verification with its cleanup
   * guard (four statements an object) is spent on the gallery rows the planner writes. These objects were
   * converted and stored by /media, and catalog_import_media.r2_key keeps them referenced (worker/lib/mediaRefs.ts).
   */
  const auxIds = [
    ...payload.swatches.map((s) => s.source_media_id),
    ...payload.content_blocks.filter((b) => b.kind === 'image' && b.source_media_id).map((b) => b.source_media_id),
    ...payload.specs.flatMap((s) => s.value_list.flatMap((v) => (v && typeof v === 'object' && v.source_media_id ? [v.source_media_id] : []))),
  ];
  const auxPresent = new Set<string>();
  if (media) {
    if (!ctx.media) throw new ImportWriteRefused('IMPORT_MEDIA_UNAVAILABLE', '', 503, 'media_bindings_missing');
    const keys = [...new Set(auxIds.map((id) => stored(id)?.r2_key ?? '').filter(Boolean))];
    const heads = await Promise.all(
      keys.map(async (key) => {
        try {
          const h = await headMediaObject(ctx.media!, 'public', key);
          const type = h?.httpMetadata?.contentType?.toLowerCase() ?? '';
          return h && Number(h.size ?? 0) > 0 && (!type || type === 'image/webp') ? key : '';
        } catch {
          return '';
        }
      })
    );
    for (const k of heads) if (k) auxPresent.add(k);
  }
  const storedAux = (sourceMediaId: string): MediaRow | null => {
    const m = stored(sourceMediaId);
    return m && (!media || auxPresent.has(m.r2_key)) ? m : null;
  };
  const auxMissing = new Set(auxIds.filter((id) => !storedAux(id))).size;

  const productId = payload.product_id;
  const retrievedAt = input.retrievedAt ?? new Date().toISOString();

  // 6. The product's slug (create: stable on retries, §A.4).
  let slug: string;
  let prevRow: Record<string, unknown> | null = null;
  if (merge) {
    prevRow = await db.prepare('SELECT * FROM products WHERE id = ?').bind(productId).first<Record<string, unknown>>();
    if (!prevRow) throw new ImportWriteRefused('IMPORT_REVIEWED_SCOPE_REFUSED', 'REVIEWED_SCOPE_REFUSED', 409, 'merge_target_missing');
    if (String(prevRow.status) !== 'active' && match?.decision === 'merge') throw new ImportWriteRefused('OWNER_HIDDEN', 'OWNER_HIDDEN', 409, 'merge_target_not_active');
    slug = String(prevRow.slug);
  } else {
    const taken = item.slug ? await db.prepare('SELECT id FROM products WHERE slug = ?').bind(item.slug).first<{ id: string }>() : null;
    slug = item.slug && (!taken || taken.id === productId) ? item.slug : await uniqueProductSlug(db, productSlugFrom(payload.handle));
  }

  // 7. Images: the payload's rows on their stored objects, then the content-duplicate collapse.
  const galleryRows: ImportImageRow[] = [];
  const imageAlts = new Map<string, { en: string; ar: string; ckb: string; source_url: string }>();
  for (const img of payload.images) {
    const m = stored(img.source_media_id);
    if (!m) {
      if (img.is_primary) throw new ImportWriteRefused('PRIMARY_MEDIA_FAILED', 'PRIMARY_MEDIA_FAILED', 409, 'primary_image_not_stored');
      continue;
    }
    galleryRows.push(imageRowOf(img, m.r2_key));
    imageAlts.set(img.id, { en: img.alt_en, ar: img.alt_ar, ckb: ckbNotCopy(img.alt_ar, img.alt_ckb), source_url: img.source_url });
  }
  const droppedImages = payload.images.length - galleryRows.length;
  const collapsed = input.mode === 'write' ? collapseContentDuplicates(galleryRows) : { rows: galleryRows, collapsed: 0 };
  let images = collapsed.rows;

  // 8. The scope ids: a create keeps the payload's; a merge maps through value_map (§E.2).
  let mapping: MergeMapping | null = null;
  let storedRel: RelationsResponse | null = null;
  if (merge) {
    storedRel = await loadRelationsResponse(db, productId);
    if (!storedRel) throw new ImportWriteRefused('IMPORT_REVIEWED_SCOPE_REFUSED', 'REVIEWED_SCOPE_REFUSED', 409, 'merge_target_missing');
    const legacy = parseProductRow(prevRow!);
    const hasRows = storedRel.groups.length + storedRel.values.length + storedRel.colors.length + storedRel.variants.length + storedRel.images.length + storedRel.quarantined_images.length > 0;
    // A product whose options or colours live only in its legacy JSON (no relation row) would lose them on the
    // storefront the moment an image row exists (productOverlay.ts `has_relations`): such a merge is not written.
    if (!hasRows && (legacy.options.length > 0 || legacy.colors.length > 0)) {
      throw new ImportWriteRefused('IMPORT_REVIEWED_SCOPE_REFUSED', 'REVIEWED_SCOPE_REFUSED', 409, 'merge_target_legacy_structure');
    }
    // The same for a gallery kept only in products.images (§E.2: the owner's pictures are never hidden, reordered or
    // replaced): the first appended row would switch the page to rows only and take the hero, and the owner's next
    // form save would rewrite the JSON from those rows. Refused, whatever rows the options have, until the owner
    // saves the product once in the form (which turns the JSON into rows) and the item is retried.
    if (storedRel.images.length + storedRel.quarantined_images.length === 0 && legacy.media.length > 0) {
      throw new ImportWriteRefused('IMPORT_REVIEWED_SCOPE_REFUSED', 'REVIEWED_SCOPE_REFUSED', 409, 'merge_target_legacy_gallery');
    }
    mapping = mergeMapping(payload, match!, storedRel);
    images = mergeImages(images, mapping, storedRel);
  }
  const mapScope = (kind: string, id: string): { kind: 'product' | 'option_value' | 'variant'; id: string } | null => {
    if (kind === 'product') return { kind: 'product', id: '' };
    if (!mapping) return { kind: kind as 'option_value' | 'variant', id };
    if (kind === 'option_value') {
      const m = mapping.values.get(id);
      return m?.optionValueId ? { kind: 'option_value', id: m.optionValueId } : null;
    }
    const m = mapping.variants.get(id);
    if (m?.variantId) return { kind: 'variant', id: m.variantId };
    if (m?.optionValueId) return { kind: 'option_value', id: m.optionValueId };
    return null;
  };

  const conflicts: Mapped['conflicts'] = [];
  for (const n of payload.notes) if (CONFLICT_KINDS.has(n.kind)) conflicts.push({ kind: n.kind, field: n.field.slice(0, 120) });
  if (droppedImages > 0) conflicts.push({ kind: 'image_review', field: 'images.not_stored' });
  if (auxMissing > 0) conflicts.push({ kind: 'image_review', field: 'media.not_stored' });

  // Specs (scope mapped; box items on their stored objects, no store URL; source_ref owner-only for store rows).
  const specs: Mapped['specs'] = [];
  let boxItems = 0;
  for (const s of payload.specs) {
    const scope = mapScope(s.scope_kind, s.scope_id);
    if (!scope) {
      conflicts.push({ kind: 'variant_not_merged', field: `spec:${s.key}` });
      continue;
    }
    const valueList = s.value_list.map((x) => {
      if (!x || typeof x !== 'object') return x;
      const item = x as PayloadBoxItem;
      boxItems++;
      const m = item.source_media_id ? storedAux(item.source_media_id) : null;
      return { text: item.text, qty: item.qty, ...(m ? { media_key: m.r2_key } : {}), ...(item.section ? { section: item.section } : {}) };
    });
    specs.push({
      ...s,
      id: scope.kind === s.scope_kind && scope.id === s.scope_id ? s.id : specRowId(productId, s.key, scope.kind, scope.id, s.region),
      scope_kind: scope.kind,
      scope_id: scope.id,
      valueListJson: JSON.stringify(valueList),
    });
  }

  const externalIds: ImportPayload['external_ids'] = [];
  for (const e of payload.external_ids) {
    const scope = mapScope(e.scope_kind, e.scope_id);
    if (!scope) continue;
    externalIds.push({ ...e, scope_kind: scope.kind, scope_id: scope.id });
  }

  // Relations: scope mapped, outgoing pendings resolved when their target is already written (§B.6),
  // a reviewed existing target checked to exist, never a relation to itself.
  const pendingHandles = [...new Set(payload.relations.filter((r) => r.state === 'pending').map((r) => r.target_source_handle))];
  const resolvedTargets = [...new Set(payload.relations.filter((r) => r.state === 'resolved' && r.target_product_id).map((r) => r.target_product_id!))];
  const writtenByHandle = new Map<string, string>();
  if (pendingHandles.length) {
    const { results } = await db
      .prepare("SELECT source_handle, product_id FROM product_source_refs WHERE source = 'bambu_us' AND source_handle IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(pendingHandles))
      .all<{ source_handle: string; product_id: string }>();
    for (const r of results ?? []) writtenByHandle.set(String(r.source_handle), String(r.product_id));
  }
  const existingTargets = new Set<string>();
  if (resolvedTargets.length) {
    const { results } = await db
      .prepare('SELECT id FROM products WHERE id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(resolvedTargets))
      .all<{ id: string }>();
    for (const r of results ?? []) existingTargets.add(String(r.id));
  }
  const relations: ImportPayload['relations'] = [];
  // One row per 0194 ux_prel key (and per id): a second row on a key would be dropped by ON CONFLICT DO NOTHING
  // while its printer fit and its count were still written, so it is never planned, and the report says so.
  const relationSeen = new Map<string, string>();
  const relationKeyOf = (r: ImportPayload['relations'][number]) => JSON.stringify([r.scope_kind, r.scope_id, r.relation, r.target_source_handle, r.target_family, r.target_label]);
  for (const r of payload.relations) {
    const scope = mapScope(r.scope_kind, r.scope_id);
    if (!scope) {
      conflicts.push({ kind: 'variant_not_merged', field: `relation:${r.relation}` });
      continue;
    }
    let next = { ...r, scope_kind: scope.kind, scope_id: scope.id };
    if (next.state === 'pending' && writtenByHandle.has(next.target_source_handle)) {
      next = { ...next, state: 'resolved', target_product_id: writtenByHandle.get(next.target_source_handle)! };
    } else if (next.state === 'resolved' && !existingTargets.has(next.target_product_id ?? '')) {
      next = { ...next, state: 'unresolvable', target_product_id: null };
      conflicts.push({ kind: 'relation_unresolvable', field: next.relation });
    }
    if (next.target_product_id === productId) continue;
    if (scope.kind !== r.scope_kind || scope.id !== r.scope_id) {
      next.id = relationRowId(productId, {
        relation: next.relation as never,
        scopeKind: next.scope_kind,
        scopeId: next.scope_id,
        targetSourceHandle: r.target_source_handle,
        targetProductId: r.target_product_id,
        targetFamily: r.target_family,
        targetLabel: r.target_label,
      });
    }
    const key = relationKeyOf(next);
    const target = `${next.state}:${next.target_product_id ?? ''}`;
    const prior = relationSeen.get(key) ?? relationSeen.get(`id:${next.id}`);
    if (prior !== undefined) {
      // The same row twice (two scopes mapped onto one) is one row; another target on the same key is reported.
      if (prior !== target) conflicts.push({ kind: 'relation_unresolvable', field: `${next.relation}:duplicate_key` });
      continue;
    }
    relationSeen.set(key, target).set(`id:${next.id}`, target);
    relations.push(next);
  }

  // Swatches: only for values this product owns (create) or a mapped option value (merge), on a stored object.
  const swatches: Mapped['swatches'] = [];
  for (const s of payload.swatches) {
    const target = merge ? mapping!.values.get(s.value_id)?.optionValueId : s.value_id;
    const m = storedAux(s.source_media_id);
    if (!target || !m) continue;
    if (swatches.some((x) => x.valueId === target)) continue;
    swatches.push({ valueId: target, url: `/files/${m.r2_key}`, key: m.r2_key, width: m.width, height: m.height, sourceUrl: s.source_url });
  }

  // Source refs: groups, values and variants (create; a merge only what it mapped), then every image row.
  const sourceRefs: Mapped['sourceRefs'] = [];
  for (const r of payload.source_refs) {
    if (r.kind === 'image') continue;
    if (!merge) {
      sourceRefs.push({ ...r, binding_rule: '', via_variant_id: '' });
      continue;
    }
    if (r.kind === 'value') {
      const m = mapping!.values.get(r.levonis_id);
      if (m?.optionValueId) sourceRefs.push({ ...r, levonis_id: m.optionValueId, binding_rule: '', via_variant_id: '' });
    } else if (r.kind === 'variant') {
      const m = mapping!.variants.get(r.levonis_id);
      if (m?.variantId) sourceRefs.push({ ...r, levonis_id: m.variantId, binding_rule: '', via_variant_id: '' });
    }
  }
  const imageRuleOf = new Map(images.map((i) => [i.id, i]));
  for (const i of imageRuleOf.values()) {
    if (merge && storedRel!.images.some((x) => x.id === i.id)) continue;
    const rule = i.binding_rule === 'representative' && !i.via_variant_id ? 'value' : i.binding_rule;
    sourceRefs.push({ kind: 'image', source_id: i.source_media_id, levonis_id: i.id, source_label: '', binding_rule: rule, via_variant_id: rule === 'representative' ? i.via_variant_id : '' });
  }
  if (mapping) for (const v of mapping.unmappedVariants) conflicts.push({ kind: 'variant_not_merged', field: v.slice(0, 120) });

  // 9. The document and the relations wire body.
  const contentBlocks = contentBlocksOf(payload, storedAux);
  // An imported step carries no image or video, so one without a body would be an empty numbered card (a section
  // whose only content was media, titled by its nav label): never written. Ids keep the source position.
  const usageGuide: UsageGuideV2 = {
    official_url: payload.product.usage_official_url,
    steps: payload.product.usage_steps
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => s.body_en.trim() !== '')
      .map(({ s, i }, order) => ({
        id: `us_${H(`${productId}:usage:${i}`)}`,
        kind: 'usage' as const,
        title: s.title_en.slice(0, 200),
        body: s.body_en.slice(0, 2000),
        title_ar: '',
        title_ckb: '',
        body_ar: '',
        body_ckb: '',
        images: [],
        video_url: '',
        link_url: payload.product.usage_official_url,
        order,
      })),
  };
  // The spec rows' mirrors first (a spec row of the field wins), then the option groups' facet mirrors.
  const specFields = { ...optionFacetMirror(payload.groups, tax.template_family, tax.slugs), ...specFieldMirror(specs, tax.template_family, tax.slugs) };
  const filled: string[] = [];
  let doc: ProductDoc;
  let prev: ProductDoc | null = null;
  let relationsBody: Record<string, unknown> | null;
  /** A merge's appended images, as wire rows (verified, then inserted beside the save, never through it). */
  let appendedWire: Array<Record<string, unknown>> = [];
  let overrides: TranslationOverrides = {};
  let catalogIds: string[];
  let printerFits: string[];
  const printerTargets = await printerProductIds(
    db,
    relations.filter((r) => r.relation === 'compatible_with' && r.state === 'resolved' && r.target_product_id).map((r) => r.target_product_id!)
  );
  const newFits = [...new Set(relations.filter((r) => r.relation === 'compatible_with' && r.state === 'resolved' && printerTargets.has(r.target_product_id ?? '')).map((r) => r.target_product_id!))];

  if (!merge) {
    const official = officialSpecGroup(specs);
    overrides = official.overrides;
    for (const b of contentBlocks) if (b.kind === 'image') overrides[`block:${b.id}:alt`] = { ar: b.alt_ar, ckb: b.alt_ckb };
    doc = newImportProductDoc({
      id: productId,
      slug,
      status: 'active',
      name_en: payload.product.title_en,
      name_ar: payload.product.title_en,
      name_ckb: payload.product.title_en,
      description_en: payload.product.short_description_en,
      brand_id: brand,
      category_id: tax.category_id,
      sub_category_id: tax.sub_category_id,
      template_family: tax.template_family,
      spec_fields: specFields,
      spec_groups: official.group ? [official.group] : [],
      content_blocks: contentBlocks,
      usage_guide: usageGuide,
    });
    relationsBody = createRelationsWire(payload, images, imageAlts);
    catalogIds = [tax.category_id, ...(tax.sub_category_id ? [tax.sub_category_id] : []), ...tax.secondaries];
    printerFits = newFits;
  } else {
    prev = parseProductRow(prevRow!);
    doc = parseProductRow(prevRow!);
    if (match!.decision === 'merge_publish') doc.status = 'active';
    // An EMPTY classification is filled from the map (§E.2), logged; a non-empty one is never touched.
    if (!doc.category_id) {
      doc.category_id = tax.category_id;
      conflicts.push({ kind: 'category_filled', field: 'category_id' });
    } else if (doc.category_id !== tax.category_id) conflicts.push({ kind: 'field_kept_existing', field: 'category_id' });
    if (!doc.sub_category_id && tax.sub_category_id) {
      doc.sub_category_id = tax.sub_category_id;
      conflicts.push({ kind: 'category_filled', field: 'sub_category_id' });
    } else if (tax.sub_category_id && doc.sub_category_id !== tax.sub_category_id) conflicts.push({ kind: 'field_kept_existing', field: 'sub_category_id' });
    if (!doc.name_en.trim()) {
      doc.name_en = payload.product.title_en;
      filled.push('name');
    }
    if (!doc.description_en.trim() && payload.product.short_description_en) {
      doc.description_en = payload.product.short_description_en;
      filled.push('description');
    } else if (payload.product.short_description_en && doc.description_en !== payload.product.short_description_en) {
      conflicts.push({ kind: 'field_kept_existing', field: 'description' });
    }
    const sameBlocks = doc.content_blocks.length === contentBlocks.length && doc.content_blocks.every((b, i) => b.id === contentBlocks[i].id);
    if (!doc.content_blocks.length && contentBlocks.length) {
      // Through the document's own reader, so the stored JSON is the one every later save writes back.
      doc.content_blocks = upgradeContentBlocks(contentBlocks);
      for (const b of contentBlocks) {
        filled.push(`block:${b.id}:body`, `block:${b.id}:alt`, `block:${b.id}:caption`);
        if (b.kind === 'image') overrides[`block:${b.id}:alt`] = { ar: b.alt_ar, ckb: b.alt_ckb };
      }
    } else if (contentBlocks.length && !sameBlocks) conflicts.push({ kind: 'field_kept_existing', field: 'content_blocks' });
    const sameGuide = doc.usage_guide.official_url === usageGuide.official_url && doc.usage_guide.steps.map((x) => x.id).join() === usageGuide.steps.map((x) => x.id).join();
    if (!doc.usage_guide.official_url && !doc.usage_guide.steps.length && (usageGuide.official_url || usageGuide.steps.length)) {
      doc.usage_guide = upgradeUsageGuide(usageGuide);
      for (const s of usageGuide.steps) filled.push(`usage_step:${s.id}:title`, `usage_step:${s.id}:body`);
    } else if ((usageGuide.official_url || usageGuide.steps.length) && !sameGuide) conflicts.push({ kind: 'field_kept_existing', field: 'usage_guide' });
    for (const [k, v] of Object.entries(specFields)) {
      if (!doc.spec_fields[k]?.trim()) doc.spec_fields[k] = v;
      else if (doc.spec_fields[k] !== v) conflicts.push({ kind: 'field_kept_existing', field: `spec_fields.${k}` });
    }
    if (!doc.spec_groups.some((g) => g.id === OFFICIAL_SPEC_GROUP.id || g.title_en === OFFICIAL_SPEC_GROUP.title_en)) {
      const known = new Set(doc.spec_groups.flatMap((g) => g.rows.map((r) => r.label_en.trim().toLowerCase())));
      const official = officialSpecGroup(specs, known);
      if (official.group) {
        doc.spec_groups = upgradeSpecGroups([...doc.spec_groups, { ...official.group, order: doc.spec_groups.length }]);
        Object.assign(overrides, official.overrides);
        filled.push(`spec_group:${OFFICIAL_SPEC_GROUP.id}:title`, ...official.group.rows.flatMap((r) => [`spec:${OFFICIAL_SPEC_GROUP.id}:${r.id}:label`, `spec:${OFFICIAL_SPEC_GROUP.id}:${r.id}:value`]));
      }
    }
    // A merge never re-upserts the product's structure (§E.2: no add, remove or rename of a group, value or
    // variant): an engine-priced product's variant upserts would meet 0181's locks even unchanged, and a save
    // is a full replacement. The document goes through the planner alone; the appended images are inserted
    // beside it, verified the same way (the append-only stage of §A.6).
    relationsBody = null;
    appendedWire = images.map((i) => wireImage(i, imageAlts.get(i.id)));
    const [currentCatalogs, currentFits] = await Promise.all([
      db.prepare('SELECT catalog_id FROM product_catalogs WHERE product_id = ?').bind(productId).all<{ catalog_id: string }>(),
      loadPrinterFitIds(db, productId),
    ]);
    catalogIds = [...new Set([...(currentCatalogs.results ?? []).map((r) => String(r.catalog_id)), ...tax.secondaries])];
    printerFits = [...new Set([...currentFits, ...newFits])];
  }

  // 10. Translations: the local dictionary only, every imported prose slot review_needed (§C.8).
  const prevSlots = new Map(prev ? localizableSlots(prev as unknown as Record<string, unknown>).map((s) => [s.key, s]) : []);
  localizeRespectingAuthored(doc, null, overrides);
  const srcRev = Math.max(1, Number(doc.content_rev) || 1);
  // The authored slots the localiser just marked approved, over what a merged product already records.
  const meta = { ...(merge ? prev!.translation_meta ?? {} : {}), ...doc.translation_meta };
  const translationRows: unknown[][] = [];
  for (const slot of localizableSlots(doc as unknown as Record<string, unknown>)) {
    const isNew = !merge || filled.includes(slot.key);
    if (merge && !isNew) {
      // A merge never changes what the product already says (§E.2): every slot it did not fill is put back.
      const before = prevSlots.get(slot.key);
      if (before) {
        slot.set('ar', before.ar);
        slot.set('ckb', before.ckb);
      }
      continue;
    }
    slot.set('ckb', ckbNotCopy(slot.ar, slot.ckb));
    if (slot.key === 'name' || !slot.en.trim()) continue;
    const authored = Object.prototype.hasOwnProperty.call(overrides, slot.key);
    if (!authored) meta[slot.key] = { ar: { status: 'imported', src_rev: srcRev }, ckb: { status: 'imported', src_rev: srcRev } };
    if (slot.key.startsWith('option:') || slot.key.startsWith('color:')) continue;
    translationRows.push([productId, slot.key, slot.en, hashSource(slot.en), slot.ar, ckbNotCopy(slot.ar, slot.ckb), 'review_needed', TRANSLATION_VERSION]);
  }
  doc.translation_meta = meta;

  // 11. Search aliases (§C.1): what this batch writes (+ what a merged product already has).
  let aliases = importSearchAliases(externalIds, specs);
  if (merge) aliases = [...new Set([...((await loadSearchAliases(db, [productId])).get(productId) ?? []), ...aliases])].sort();

  // 12. Preflight, media verification, the authoritative plan (§A.4 step 4).
  const intent: ProductWriteIntent = {
    mode: merge ? 'update' : 'create',
    doc,
    prev,
    relations: relationsBody,
    catalogIds,
    printerFits,
    actor: { ...IMPORT_ACTOR },
    hashtags: false,
    allowComposition: false,
    searchAliases: aliases,
  };
  try {
    await preflightProductSave(db, intent);
    if (input.mode === 'write') {
      // The gallery rows this write adds: bytes, decode and the cleanup guard (§A.4 step 4). A merge's stored rows were
      // verified when they were saved and are not re-protected here.
      const newImages = relationsBody ? (relationsBody.images as Array<Record<string, unknown>>).filter((i) => images.some((x) => x.id === i.id)) : appendedWire;
      await verifyAndNormalizeProductMedia({ ...ctx.media!, DB: db }, { media: [] } as unknown as ProductDoc, newImages);
    }
  } catch (e) {
    throw refusalOfPlanner(e);
  }
  let save: ProductSavePlan;
  try {
    save = await planProductSave(db, intent, { relationMediaMetadata: input.mode === 'write' ? 'authoritative' : 'deferred' });
  } catch (e) {
    throw refusalOfPlanner(e);
  }

  // 13. The batch.
  const statements: D1PreparedStatement[] = [];
  statements.push(
    db
      .prepare(
        `INSERT INTO ops_guards (id, ok) SELECT ?, CASE WHEN EXISTS (
           SELECT 1 FROM catalog_import_items i JOIN catalog_import_runs r ON r.id = i.run_id
            WHERE i.id = ? AND i.run_id = ? AND i.processing_state = 'WRITING' AND i.lease_token = ? AND i.lease_token <> ''
              AND i.lease_until > ${NOW_SQL} AND i.payload_sha256 = ? AND r.state IN ('open','running'))
           ${merge ? '' : 'AND NOT EXISTS (SELECT 1 FROM pricing_v2_sku_results v WHERE v.product_id = ?)'} THEN 1 ELSE 0 END`
      )
      .bind(...[IMPORT_GUARD_ID, input.itemId, input.runId, input.leaseToken, sha, ...(merge ? [] : [productId])])
  );
  const beforeStart = statements.length;
  if (merge) for (const q of FINGERPRINT_QUERIES) statements.push(db.prepare(q.sql).bind(productId));
  const beforeEnd = statements.length;
  statements.push(...save.statements);

  const side: SideRow[] = [];
  const runId = input.runId;
  const canonicalUrl = manifestRow.canonical_url || item.canonical_url;
  // (a) The option groups' 0194 columns (create only: a merge never touches the product's own groups).
  if (!merge) {
    for (const g of payload.groups) {
      statements.push(
        db
          .prepare('UPDATE product_option_groups SET name_ar = ?, name_ckb = ?, kind = ?, default_value_id = ? WHERE id = ? AND product_id = ?')
          .bind(g.name_ar, ckbNotCopy(g.name_ar, g.name_ckb), g.kind, g.default_value_id, g.id, productId)
      );
    }
  }
  // (a') A merge's appended images (§E.2), verified above, after the existing ones; the primary only when there is none.
  if (merge && appendedWire.length) {
    statements.push(
      ...packedInserts(
        db,
        `INSERT INTO product_images (id, product_id, url, alt_en, alt_ar, alt_ckb, sort_order, is_primary, option_value_id, color_id, variant_id,
                                     width, height, bytes, content_type, r2_key, source_url)`,
        `(${Array.from({ length: 17 }, () => '?').join(', ')})`,
        appendedWire.map((w) => [
          w.id, productId, w.url, w.alt_en, w.alt_ar, w.alt_ckb, w.sort_order, w.is_primary ? 1 : 0, w.option_value_id ?? null, w.color_id ?? null, w.variant_id ?? null,
          w.width ?? null, w.height ?? null, w.bytes ?? null, w.content_type || 'image/webp', w.r2_key, w.source_url ?? '',
        ]),
        'ON CONFLICT DO NOTHING'
      )
    );
  }
  // (b) Where the product came from, and its stock decision (§B.10).
  statements.push(sourceRefStatement(db, { payload, productId, manifestRow, canonicalUrl, item, runId, retrievedAt, merge }));
  // (c) The packed side rows.
  side.push({
    table: 'product_option_source_refs',
    head: 'INSERT INTO product_option_source_refs (product_id, kind, source, source_id, levonis_id, source_label, binding_rule, via_variant_id, import_run_id)',
    row: '(?, ?, ?, ?, ?, ?, ?, ?, ?)',
    tail: 'ON CONFLICT DO NOTHING',
    values: dedupeBy(sourceRefs, (r) => `${r.kind}|${r.source_id}|${r.levonis_id}`).map((r) => [productId, r.kind, 'bambu_us', r.source_id, r.levonis_id, r.source_label, r.binding_rule, r.via_variant_id, runId]),
  });
  side.push({
    table: 'product_spec_values',
    head: `INSERT INTO product_spec_values (id, product_id, canonical_key, group_key, scope_kind, scope_id, region, data_type, original_label, original_value,
             value_text, value_num, value_num_max, value_bool, value_list, unit, status, confidence, source_kind, source_ref, source_title,
             source_locator, source_excerpt, retrieved_at, test_method, test_condition, derived_from, missing_reason, checked_sources,
             visibility, conflict, sort, import_run_id)`,
    row: `(${Array.from({ length: 33 }, () => '?').join(', ')})`,
    tail: 'ON CONFLICT DO NOTHING',
    values: dedupeBy(specs, (s) => `${s.key}|${s.scope_kind}|${s.scope_id}|${s.region}`).map((s) => [
      s.id, productId, s.key, s.group, s.scope_kind, s.scope_id, s.region, s.data_type, s.original_label, s.original_value.slice(0, 1000),
      s.value_text, s.value_num, s.value_num_max, s.value_bool, s.valueListJson, s.unit, s.status, s.confidence, s.source_kind, specSourceRef(s, canonicalUrl), s.source_title,
      s.source_locator.slice(0, 200), s.source_excerpt.slice(0, 200), retrievedAt, s.test_method, s.test_condition, s.derived_from, s.missing_reason, checkedSourcesJson(s.checked_sources),
      s.visibility, s.conflict, s.sort, runId,
    ]),
  });
  const checks = new Map((input.documentChecks ?? []).map((k) => [k.document_id, k]));
  side.push({
    table: 'product_documents',
    head: `INSERT INTO product_documents (id, product_id, kind, title_en, title_ar, title_ckb, url, host, scope_kind, scope_id, language, source_kind, retrieved_at, sort, active, import_run_id,
             tracker_source, content_type, byte_size, content_sha256, checked_at, check_status)`,
    row: `(${Array.from({ length: 22 }, () => '?').join(', ')})`,
    tail: 'ON CONFLICT DO NOTHING',
    values: dedupeBy(payload.documents, (d) => `${d.url}|${d.scope_kind}|${d.scope_id}`).map((d) => {
      const k = checks.get(d.id);
      return [
        d.id, productId, d.kind, d.title_en, d.title_ar, ckbNotCopy(d.title_ar, d.title_ckb), d.url, d.host, d.scope_kind, d.scope_id, d.language, 'store_page', retrievedAt, d.sort,
        k && !documentAlive(k.check_status) ? 0 : 1, runId,
        k?.tracker_source ?? '', k?.content_type ?? '', k?.byte_size ?? null, k?.content_sha256 ?? '', k?.checked_at ?? '', k?.check_status ?? 0,
      ];
    }),
  });
  side.push({
    table: 'product_external_ids',
    head: 'INSERT INTO product_external_ids (product_id, scope_kind, scope_id, id_type, value, source_kind, source_ref, retrieved_at, searchable)',
    row: '(?, ?, ?, ?, ?, ?, ?, ?, ?)',
    tail: 'ON CONFLICT DO NOTHING',
    values: dedupeBy(externalIds, (e) => `${e.scope_kind}|${e.scope_id}|${e.id_type}|${e.value}`).map((e) => [productId, e.scope_kind, e.scope_id, e.id_type, e.value, 'store_page', '', retrievedAt, e.searchable ? 1 : 0]),
  });
  side.push({
    table: 'product_relations',
    head: `INSERT INTO product_relations (id, product_id, scope_kind, scope_id, relation, target_kind, target_product_id, target_source, target_source_handle,
             target_family, target_label, state, evidence_kind, evidence_text, retrieved_at, import_run_id, resolved_at)`,
    row: '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    tail: 'ON CONFLICT DO NOTHING',
    values: dedupeBy(relations, (r) => r.id).map((r) => [
      r.id, productId, r.scope_kind, r.scope_id, r.relation, r.target_kind, r.state === 'resolved' ? r.target_product_id : null, r.target_source, r.target_source_handle,
      r.target_family, r.target_label, r.state, r.evidence_kind, r.evidence_text.slice(0, 300), retrievedAt, runId, r.state === 'resolved' ? retrievedAt : '',
    ]),
  });
  side.push({
    table: 'product_option_value_swatches',
    head: 'INSERT INTO product_option_value_swatches (option_value_id, product_id, url, r2_key, width, height, source_url)',
    row: '(?, ?, ?, ?, ?, ?, ?)',
    tail: 'ON CONFLICT DO NOTHING',
    values: swatches.map((s) => [s.valueId, productId, s.url, s.key, s.width, s.height, s.sourceUrl]),
  });
  side.push({
    table: 'product_translations',
    head: 'INSERT INTO product_translations (product_id, field, source_en, source_hash, text_ar, text_ckb, status, translation_version)',
    row: '(?, ?, ?, ?, ?, ?, ?, ?)',
    tail: `ON CONFLICT (product_id, field) DO UPDATE SET source_en = excluded.source_en, source_hash = excluded.source_hash, text_ar = excluded.text_ar,
             text_ckb = excluded.text_ckb, status = excluded.status, translation_version = excluded.translation_version, updated_at = ${NOW_SQL}`,
    values: translationRows,
  });
  // Keyed by the conflict and its occurrence, not by its position: a re-sent write names the same rows.
  const seenConflicts = new Map<string, number>();
  const conflictRows = conflicts.map((c) => {
    const k = `${c.kind}:${c.field}`;
    const n = (seenConflicts.get(k) ?? 0) + 1;
    seenConflicts.set(k, n);
    return [`cic_${H(`${input.itemId}:${k}:${n}`)}`, runId, input.itemId, productId, c.kind, c.field, ''];
  });
  side.push({
    table: 'catalog_import_conflicts',
    head: 'INSERT INTO catalog_import_conflicts (id, run_id, item_id, product_id, kind, field, detail)',
    row: '(?, ?, ?, ?, ?, ?, ?)',
    tail: 'ON CONFLICT DO NOTHING',
    values: conflictRows,
  });
  for (const s of side) statements.push(...packedInserts(db, s.head, s.row, s.values, s.tail));

  // (d) Incoming: every pending relation that names this product's handle resolves to it (family members included:
  //     each member row is pending on its own handle), and its printer fits when this product is a printer (§B.6).
  statements.push(
    db
      .prepare(
        `UPDATE product_relations SET target_product_id = ?, state = 'resolved', resolved_at = ?
          WHERE state = 'pending' AND target_source = 'bambu_us' AND target_source_handle = ? AND product_id <> ?`
      )
      .bind(productId, new Date().toISOString(), payload.handle, productId)
  );
  if (tax.printerCatalogs.size > 0 || (merge && (await printerProductIds(db, [productId])).has(productId))) {
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO product_printer_fits (product_id, printer_id, position)
           SELECT r.product_id, ?1, (SELECT COALESCE(MAX(f.position) + 1, 0) FROM product_printer_fits f WHERE f.product_id = r.product_id)
             FROM product_relations r
            WHERE r.target_product_id = ?1 AND r.relation = 'compatible_with' AND r.state = 'resolved' AND r.product_id <> ?1
            GROUP BY r.product_id`
        )
        .bind(productId)
    );
  }

  // (e) The fenced event and the checkpoint.
  const counts = countsOf({ payload, images, swatches, specs, relations, externalIds, sourceRefs, conflicts: conflictRows.length, boxItems, contentBlocks, translations: translationRows.length, save });
  statements.push(
    db
      .prepare(
        `INSERT INTO catalog_import_events (id, run_id, item_id, seq, stage, outcome, code, message, detail, lease_token)
         VALUES (?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM catalog_import_events WHERE run_id = ?), 'WRITTEN', 'ok', ?, '', ?, ?)`
      )
      .bind(newId('cie'), runId, input.itemId, runId, merge ? 'merged' : 'created', JSON.stringify({ groups: counts.groups, values: counts.values, variants: counts.variants, images: counts.images, specs: counts.specs }), input.leaseToken)
  );
  statements.push(
    db
      .prepare(
        `UPDATE catalog_import_items
            SET processing_state = 'PUBLISHING', last_completed_stage = 'WRITING', levonis_product_id = ?, slug = ?, match_kind = ?,
                stage_attempts = 0, retry_at = '',
                stage_data = json_set(CASE WHEN json_valid(stage_data) THEN stage_data ELSE '{}' END, '$.written', json(?), '$.payload_counts', json(?)),
                updated_at = ${NOW_SQL}
          WHERE id = ? AND run_id = ? AND lease_token = ?`
      )
      .bind(productId, slug, merge ? 'merged' : 'created', JSON.stringify(counts), JSON.stringify(payloadCounts(payload)), input.itemId, runId, input.leaseToken)
  );
  const afterStart = statements.length;
  let probe = -1;
  if (merge) for (const q of FINGERPRINT_QUERIES) statements.push(db.prepare(q.sql).bind(productId));
  else {
    probe = statements.length;
    statements.push(db.prepare(MONEY_PROBE_SQL).bind(productId));
  }
  const afterEnd = merge ? statements.length : afterStart;
  statements.push(db.prepare('DELETE FROM ops_guards WHERE id = ?').bind(IMPORT_GUARD_ID));

  // 14. The budget: the whole invocation (§A.5).
  // Each post-commit audit costs what audit() sends on THIS binding (one statement, or three with the event bus on).
  const perAudit = auditStatementCount(db);
  const postCommit = perAudit /* catalog_import.write */ + (save.relations ? perAudit : 0) + (save.detachedMedia.length ? 2 + perAudit : 0) + (merge ? 1 : 0) + READBACK_STATEMENTS;
  const estimate: ImportWriteEstimate = {
    reads: ctx.counter.count + (input.mode === 'stage' ? STAGE_MEDIA_READS + stageMediaEstimate(images) : 0),
    batch: statements.length,
    postCommit,
    total: 0,
    limit: IMPORT_INVOCATION_LIMIT,
  };
  estimate.total = estimate.reads + estimate.batch + estimate.postCommit;
  if (estimate.total > IMPORT_INVOCATION_LIMIT) throw new ImportWriteRefused('PLAN_TOO_LARGE', 'PLAN_TOO_LARGE', 409, 'invocation_over_900');

  if (collapsed.collapsed) warnings.push(`content duplicates collapsed: ${collapsed.collapsed}`);
  return {
    mode: input.mode,
    runId,
    itemId: input.itemId,
    leaseToken: input.leaseToken,
    productId,
    slug,
    matchKind: merge ? 'merged' : 'created',
    payloadSha256: sha,
    statements,
    save,
    layout: { before: [beforeStart, beforeEnd], after: [afterStart, afterEnd], probe, fingerprintTables: FINGERPRINT_QUERIES.map((q) => q.table) },
    estimate,
    counts,
    images,
    searchAliases: aliases,
    warnings,
    conflicts: conflicts.map((c) => ({ kind: c.kind, field: c.field })),
  };
}

/** Media verification's statements per distinct gallery object in /stage, where nothing is verified yet: PRAGMA, upsert, read, deferral. */
export const STAGE_MEDIA_PER_OBJECT = 4;
/** The write's own read of the item's media rows (loadMedia: one statement), which /stage does not spend. */
export const STAGE_MEDIA_READS = 1;
function stageMediaEstimate(images: ImportImageRow[]): number {
  return new Set(images.map((i) => i.r2_key)).size * STAGE_MEDIA_PER_OBJECT;
}

/** A planner or verifier refusal as the import's: PAYLOAD_REFUSED (a structure the app refuses), or the original. */
function refusalOfPlanner(e: unknown): unknown {
  if (e instanceof ImportWriteRefused) return e;
  if (e instanceof HttpError) {
    if (e.code === 'COMPOSITION_NOT_ALLOWED') return new ImportWriteRefused('IMPORT_REVIEWED_SCOPE_REFUSED', 'REVIEWED_SCOPE_REFUSED', 409, 'merge_target_is_a_composition');
    if (/^IMAGE_/.test(String(e.code ?? ''))) return new ImportWriteRefused(String(e.code), e.status >= 500 ? '' : 'PRIMARY_MEDIA_FAILED', e.status, 'media_not_verified');
    if (e.status === 400) return new ImportWriteRefused(String(e.code || 'RELATIONS_VALIDATION'), 'PAYLOAD_REFUSED', 400, 'planner_refused');
  }
  return e;
}

function imageRowOf(img: PayloadImage, key: string): ImportImageRow {
  return {
    id: img.id,
    source_media_id: img.source_media_id,
    r2_key: key,
    url: `/files/${key}`,
    sort_order: img.sort_order,
    is_primary: img.is_primary,
    option_value_id: img.option_value_id,
    color_id: null,
    variant_id: img.variant_id,
    via_variant_id: img.via_variant_id ?? '',
    binding_rule: img.binding_rule,
  };
}

/** A merge's appended images: bound only through value_map (to an option value, a variant, or a colour), else product-level (§E.2). */
function mergeImages(rows: ImportImageRow[], mapping: MergeMapping, rel: RelationsResponse): ImportImageRow[] {
  const existingIds = new Set(rel.images.map((i) => String(i.id)));
  const existingBindings = new Set(rel.images.map((i) => `${i.r2_key}|${i.option_value_id ?? ''}|${i.variant_id ?? ''}|${i.color_id ?? ''}`));
  let next = rel.images.reduce((m, i) => Math.max(m, Number(i.sort_order) || 0), -1) + 1;
  const hasPrimary = rel.images.some((i) => Number(i.is_primary) === 1);
  const out: ImportImageRow[] = [];
  const seen = new Set<string>();
  for (const r of [...rows].sort((a, b) => a.sort_order - b.sort_order)) {
    let binding: Pick<ImportImageRow, 'option_value_id' | 'variant_id' | 'color_id'> = { option_value_id: null, variant_id: null, color_id: null };
    if (r.variant_id) {
      const m = mapping.variants.get(r.variant_id);
      if (m?.variantId) binding = { ...binding, variant_id: m.variantId };
      else if (m?.optionValueId) binding = { ...binding, option_value_id: m.optionValueId };
      else if (m?.colorId) binding = { ...binding, color_id: m.colorId };
    } else if (r.option_value_id) {
      const m = mapping.values.get(r.option_value_id);
      if (m?.optionValueId) binding = { ...binding, option_value_id: m.optionValueId };
      else if (m?.colorId) binding = { ...binding, color_id: m.colorId };
    }
    const key = `${r.r2_key}|${binding.option_value_id ?? ''}|${binding.variant_id ?? ''}|${binding.color_id ?? ''}`;
    if (existingIds.has(r.id) || existingBindings.has(key) || seen.has(key)) continue;
    seen.add(key);
    const bound = !!(binding.option_value_id || binding.variant_id || binding.color_id);
    // A representative names the variant whose hero it shows (0194, R6): the merged product's own variant, through
    // the value map. One that maps to no existing variant (only a value or a colour) is a plain value binding.
    const via = bound && r.binding_rule === 'representative' ? (mapping.variants.get(r.via_variant_id)?.variantId ?? '') : '';
    out.push({
      ...r,
      ...binding,
      sort_order: next++,
      is_primary: !hasPrimary && out.length === 0,
      binding_rule: !bound ? 'general' : r.binding_rule === 'representative' && !via ? 'value' : r.binding_rule,
      via_variant_id: via,
    });
  }
  return out;
}

function createRelationsWire(payload: ImportPayload, images: ImportImageRow[], alts: Map<string, { en: string; ar: string; ckb: string; source_url: string }>): Record<string, unknown> {
  return {
    inventory_mode: payload.product.variant_mode,
    groups: payload.groups.map((g) => ({
      id: g.id,
      name_en: g.name_en,
      sort: g.sort,
      active: true,
      values: g.values.map((v) => ({
        id: v.id,
        name_en: v.name_en,
        name_ar: v.name_ar,
        name_ckb: ckbNotCopy(v.name_ar, v.name_ckb),
        sort: v.sort,
        active: true,
        sku_part: '',
        image: '',
        availability_type: '',
        lead_time_text: '',
        stock: null,
        low_stock_threshold: null,
        variant_key: v.variant_key,
        variant_label: v.variant_label,
      })),
    })),
    colors: [],
    variants: payload.variants.map((v) => ({ id: v.id, option_value_ids: [...v.value_ids], color_id: null, sku: null, active: true, stock: null, low_stock_threshold: null })),
    images: images.map((i) => wireImage(i, alts.get(i.id))),
  };
}

function wireImage(i: ImportImageRow, alt: { en: string; ar: string; ckb: string; source_url: string } | undefined): Record<string, unknown> {
  return {
    id: i.id,
    url: i.url,
    r2_key: i.r2_key,
    alt_en: alt?.en ?? '',
    alt_ar: alt?.ar ?? '',
    alt_ckb: alt?.ckb ?? '',
    sort_order: i.sort_order,
    is_primary: i.is_primary,
    option_value_id: i.option_value_id,
    color_id: i.color_id,
    variant_id: i.variant_id,
    source_url: alt?.source_url ?? '',
    content_type: 'image/webp',
  };
}

/**
 * Content blocks (§C.5): text with its section title as the first line — ONCE per section, as the source shows it
 * (the package splits a section's text around each image or video, every piece carrying the section's title) —
 * images on their stored objects, YouTube embeds.
 */
function contentBlocksOf(payload: ImportPayload, stored: (id: string) => MediaRow | null): ContentBlockV2[] {
  const out: ContentBlockV2[] = [];
  let shown = '';
  for (const b of payload.content_blocks) {
    const base = { id: b.id, order: out.length, body_ar: '', body_ckb: '', caption_ar: '', caption_en: '', caption_ckb: '', alt_ar: '', alt_en: '', alt_ckb: '', url: '', media_key: '' };
    if (b.kind === 'text') {
      const heading = b.title_en ? JSON.stringify([b.section_path, b.title_en]) : '';
      const body = b.title_en && heading !== shown && !b.body_en.startsWith(b.title_en) ? `${b.title_en}\n${b.body_en}` : b.body_en;
      if (!body.trim()) continue;
      if (heading) shown = heading;
      out.push({ ...base, kind: 'text', body_en: body.slice(0, 20000) });
    } else if (b.kind === 'image') {
      const m = stored(b.source_media_id);
      if (m) out.push({ ...base, kind: 'image', body_en: '', url: `/files/${m.r2_key}`, media_key: m.r2_key, alt_en: b.alt_en, alt_ar: b.alt_ar, alt_ckb: ckbNotCopy(b.alt_ar, b.alt_ckb) });
    } else if (b.kind === 'video_embed' && b.url) {
      out.push({ ...base, kind: 'video_embed', body_en: '', url: b.url });
    }
  }
  return out;
}

/** A spec row's provenance: store-sourced rows cite the store page (owner-only, §B.2); a doc/wiki row its first checked source. */
function specSourceRef(s: PayloadSpec, canonicalUrl: string): string {
  if (['not_found', 'not_published', 'not_applicable', 'unknown'].includes(s.status)) return '';
  if (s.source_kind === 'store_page' || s.source_kind === 'store_messages' || s.source_kind === 'derived') return canonicalUrl;
  const first = s.checked_sources.find((c) => /^https:\/\//.test(c.url));
  return first?.url ?? '';
}

function sourceRefStatement(
  db: D1Database,
  a: { payload: ImportPayload; productId: string; manifestRow: ManifestRow; canonicalUrl: string; item: ItemRow; runId: string; retrievedAt: string; merge: boolean }
): D1PreparedStatement {
  const collections = (() => {
    try {
      const v = JSON.parse(a.item.source_collections || '[]');
      return JSON.stringify(Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 100) : []);
    } catch {
      return '[]';
    }
  })();
  const values = [
    a.payload.source_product_id,
    a.productId,
    a.payload.handle,
    a.canonicalUrl,
    a.payload.route,
    collections,
    a.merge ? 'merged' : 'created',
    a.merge ? 'not_required' : 'not_configured',
    a.payload.extraction_sha256,
    a.retrievedAt,
    a.runId,
  ];
  const head = `INSERT INTO product_source_refs (source, source_product_id, product_id, source_handle, canonical_url, source_route, source_collections_json,
                  match_kind, stock_decision, fingerprint, fetched_at, import_run_id)
                VALUES ('bambu_us', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  // A create is a plain INSERT: its primary key (source, source_product_id) makes a duplicate create impossible (§A.7).
  // A merge refreshes its provenance on a re-send and never touches the stock decision.
  return db
    .prepare(
      a.merge
        ? `${head} ON CONFLICT (source, source_product_id) DO UPDATE SET fingerprint = excluded.fingerprint, fetched_at = excluded.fetched_at,
             import_run_id = excluded.import_run_id, source_route = excluded.source_route, updated_at = ${NOW_SQL}
           WHERE product_source_refs.product_id = excluded.product_id`
        : head
    )
    .bind(...values);
}

/**
 * A spec row's checked sources as stored: each entry projected to its three allow-listed fields (§C.10 layer 2),
 * like every other nested payload object the writer serialises — never the object as it arrived.
 */
function checkedSourcesJson(sources: PayloadSpec['checked_sources']): string {
  return JSON.stringify(sources.map((c) => ({ kind: String(c.kind ?? ''), url: String(c.url ?? ''), title: String(c.title ?? '') })));
}

function dedupeBy<T>(xs: readonly T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = key(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function countsOf(a: {
  payload: ImportPayload;
  images: ImportImageRow[];
  swatches: Mapped['swatches'];
  specs: Mapped['specs'];
  relations: ImportPayload['relations'];
  externalIds: ImportPayload['external_ids'];
  sourceRefs: Mapped['sourceRefs'];
  conflicts: number;
  boxItems: number;
  contentBlocks: ContentBlockV2[];
  translations: number;
  save: ProductSavePlan;
}): WrittenCounts {
  const merged = a.payload.write_mode === 'merge';
  return {
    groups: merged ? 0 : a.payload.groups.length,
    values: merged ? 0 : a.payload.groups.reduce((n, g) => n + g.values.length, 0),
    variants: merged ? 0 : a.payload.variants.length,
    images: a.images.length,
    image_bindings: tally(a.images, (i) => (i.variant_id ? 'variant' : i.option_value_id ? 'value' : i.color_id ? 'color' : 'product')),
    swatches: a.swatches.length,
    specs: dedupeBy(a.specs, (s) => `${s.key}|${s.scope_kind}|${s.scope_id}|${s.region}`).length,
    specs_by_status: tally(a.specs, (s) => s.status),
    specs_by_region: tally(a.specs.filter((s) => s.region), (s) => s.region),
    documents: dedupeBy(a.payload.documents, (d) => `${d.url}|${d.scope_kind}|${d.scope_id}`).length,
    relations: dedupeBy(a.relations, (r) => r.id).length,
    relations_by_state: tally(a.relations, (r) => r.state),
    external_ids: a.externalIds.length,
    source_refs: a.sourceRefs.length,
    conflicts: a.conflicts,
    box_items: a.boxItems,
    content_blocks: a.contentBlocks.length,
    translations: a.translations,
  };
}

// ---------------------------------------------------------------- the run

const digestOf = (rows: unknown): string => sha256Hex(canonicalJson(rows));

/**
 * Runs the planned batch (one D1 transaction), then the post-commit
 * bookkeeping. Throws ImportWriteRefused for a batch the database refused:
 * IMPORT_FINANCIAL_WRITE_REFUSED (a guard trigger), IMPORT_LEASE_LOST (the
 * lease fence), IMPORT_ITEM_CHANGED (the guard row's fence: the item left
 * WRITING, the lease or the staged payload changed), IMPORT_DUPLICATE_CREATE
 * (the source is already written), IMPORT_ILLEGAL_TRANSITION.
 */
export async function runImportWrite(ctx: ImportWriteContext, plan: ImportWritePlan): Promise<ImportWriteResult> {
  if (plan.mode !== 'write') throw new ImportWriteRefused('IMPORT_STAGE_PLAN', '', 500, 'a_stage_plan_is_never_run');
  let results: Array<{ results?: unknown[] }>;
  try {
    results = (await ctx.db.batch(plan.statements)) as Array<{ results?: unknown[] }>;
  } catch (e) {
    const refused = refusalOfBatch(e);
    // The guard row's fence failed: say which condition, when it is the priced product (read after the abort).
    if (refused instanceof ImportWriteRefused && refused.code === 'IMPORT_ITEM_CHANGED' && plan.matchKind === 'created' && (await hasV2Results(ctx.db, plan.productId))) {
      throw new ImportWriteRefused('IMPORT_CREATE_ON_PRICED_PRODUCT', 'REVIEWED_SCOPE_REFUSED', 409, 'product_has_v2_results');
    }
    throw refused;
  }
  const rowsAt = (i: number) => (results[i]?.results ?? []) as Array<Record<string, unknown>>;
  let beforeEqual: boolean | null = null;
  let moneyDefault: boolean | null = null;
  let digest = '';
  if (plan.matchKind === 'merged') {
    const before: unknown[] = [];
    const after: unknown[] = [];
    for (let i = plan.layout.before[0]; i < plan.layout.before[1]; i++) before.push(rowsAt(i));
    for (let i = plan.layout.after[0]; i < plan.layout.after[1]; i++) after.push(rowsAt(i));
    digest = digestOf(before);
    beforeEqual = digest === digestOf(after);
  } else {
    const p = rowsAt(plan.layout.probe)[0] ?? {};
    moneyDefault = moneyProbeAtDefault(p);
  }
  // Post-commit (§A.4 step 8): never turns the committed write into a failure.
  await postCommitProductSave(ctx.db, plan.save, [
    { action: 'catalog_import.write', detail: { run_id: plan.runId, item_id: plan.itemId, match_kind: plan.matchKind, ...plan.counts, image_bindings: undefined, specs_by_status: undefined, specs_by_region: undefined, relations_by_state: undefined } },
  ]);
  // The readback (§A.3 GET /readback, §I.1.6): the stored product against the plan of this very payload —
  // reloadForVerification + verifyApplied — recorded on the item, since /readback itself carries no payload.
  const readback = await verifyWrite(ctx.db, plan);
  if (plan.matchKind === 'merged') {
    try {
      await ctx.db
        .prepare("INSERT OR IGNORE INTO catalog_import_protected (run_id, phase, subject, digest) VALUES (?, 'write', ?, ?)")
        .bind(plan.runId, plan.productId, digest)
        .run();
    } catch (e) {
      console.error('catalog_import_protected_write_failed', JSON.stringify({ code: 'IMPORT_DIGEST_NOT_STORED', reason: message(e).slice(0, 80) }));
    }
  }
  return {
    product_id: plan.productId,
    slug: plan.slug,
    created: plan.matchKind === 'created',
    merged: plan.matchKind === 'merged',
    counts: plan.counts,
    before_fp_equal: beforeEqual,
    after_money_default: moneyDefault,
    readback_mismatches: readback.mismatches,
    images: plan.images.map((i) => ({
      id: i.id,
      source_media_id: i.source_media_id,
      r2_key: i.r2_key,
      sort_order: i.sort_order,
      is_primary: i.is_primary,
      option_value_id: i.option_value_id,
      variant_id: i.variant_id,
      color_id: i.color_id,
      binding_rule: i.binding_rule,
    })),
  };
}

/**
 * Statements the readback spends after the batch, for §A.5: reloadForVerification's reads (22, measured on the
 * fixtures: the row, the relations view and response, the catalogs, the printer fits) and the record, rounded up.
 */
export const READBACK_STATEMENTS = 24;

/**
 * verifyApplied over the freshly committed product, recorded as `stage_data.readback` (counts and section
 * names, never a value). Never turns the committed write into a failure: a read that fails records -1.
 */
async function verifyWrite(db: D1Database, plan: ImportWritePlan): Promise<{ mismatches: number; sections: string[] }> {
  let out = { mismatches: -1, sections: [] as string[] };
  try {
    const stored = await reloadForVerification(db, plan.productId);
    const found = stored ? verifyApplied(plan.save, stored, { documentKeys: null }) : null;
    out = found ? { mismatches: found.length, sections: [...new Set(found.map((m) => m.section))].sort() } : { mismatches: 1, sections: ['product_missing'] };
  } catch (e) {
    console.error('catalog_import_readback_failed', JSON.stringify({ code: 'IMPORT_READBACK_FAILED', reason: message(e).slice(0, 80) }));
  }
  try {
    await db
      .prepare(
        `UPDATE catalog_import_items SET stage_data = json_set(CASE WHEN json_valid(stage_data) THEN stage_data ELSE '{}' END, '$.readback', json(?))
          WHERE id = ? AND run_id = ?`
      )
      .bind(JSON.stringify(out), plan.itemId, plan.runId)
      .run();
  } catch (e) {
    console.error('catalog_import_readback_not_stored', JSON.stringify({ code: 'IMPORT_READBACK_NOT_STORED', reason: message(e).slice(0, 80) }));
  }
  return out;
}

/** The database's refusal of an import batch, as the import's own code (never the SQL text). */
export function refusalOfBatch(e: unknown): unknown {
  const m = message(e);
  if (m.includes(IMPORT_GUARD_REFUSAL)) return new ImportWriteRefused('IMPORT_FINANCIAL_WRITE_REFUSED', 'IMPORT_FINANCIAL_WRITE_REFUSED', 409, 'guard_trigger_fired');
  if (m.includes('IMPORT_LEASE_LOST')) return new ImportWriteRefused('IMPORT_LEASE_LOST', '', 409, 'lease_fence');
  if (m.includes('IMPORT_ILLEGAL_TRANSITION')) return new ImportWriteRefused('IMPORT_ILLEGAL_TRANSITION', '', 409, 'transition_trigger');
  if (m.includes('IMPORT_RUN_NOT_OPEN')) return new ImportWriteRefused('IMPORT_RUN_NOT_OPEN', '', 409, 'run_not_open');
  if (/CHECK constraint failed:\s*ok\s*=\s*1/i.test(m)) return new ImportWriteRefused('IMPORT_ITEM_CHANGED', '', 409, 'guard_row_fence');
  if (/UNIQUE constraint failed:\s*product_source_refs\./i.test(m)) return new ImportWriteRefused('IMPORT_DUPLICATE_CREATE', 'REVIEWED_SCOPE_REFUSED', 409, 'source_already_written');
  if (/UNIQUE constraint failed:\s*products\.(id|slug)/i.test(m)) return new ImportWriteRefused('IMPORT_DUPLICATE_CREATE', 'REVIEWED_SCOPE_REFUSED', 409, 'product_already_written');
  return e;
}
