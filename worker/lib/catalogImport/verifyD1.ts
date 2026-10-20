/**
 * THE WORKER'S OWN RECOMPUTE BEFORE COMPLETE (Bambu import spec §I.1.10;
 * §A.3 `/complete`; stored in catalog_import_items.d1_checks).
 *
 * The runner's evidence is what the public site showed; this is what D1
 * itself says about the same product, recomputed independently, READ ONLY —
 * no row is created, no counter moves (the price-request check uses the same
 * validator `POST /api/price-requests` uses, which only reads, and the test
 * proves the request table is unchanged). COMPLETE is accepted only when every
 * check here is true and the counts agree with the runner's (`/complete`, 6b).
 *
 *   visible            VISIBLE through catalog-only's own predicates (worker/lib/listing.ts)
 *   not_sellable       SELLABLE false — for a product the run CREATED (a merge keeps its own V2 state)
 *   category / sub     category_id and sub_category_id equal the taxonomy map's resolution of the manifest row (create),
 *                      or were left as they were / filled (merge)
 *   memberships        product_catalogs ⊇ the map's secondary memberships (and = primary + secondaries on a create)
 *   search             the current INDEX_STAMP row, the title's tokens and every searchable alias's tokens
 *   media              R2 HEAD of every image, swatch and in-the-box object (when the media bindings are given);
 *                      a HEAD that fails is no answer: 503 IMPORT_STORAGE_UNAVAILABLE, nothing recorded
 *   swatches_own       every swatch row of the product names one of its own option values
 *   counts             groups, values, variants, image bindings, spec statuses and regions, documents and
 *                      relations equal what the write recorded (stage_data.written)
 *   stock_decision     'not_configured' on a create (§B.10)
 *   guard_clear        no ops_guards('catalog-import-batch') row survives
 *   price_request      the default selection (and every selection the runner checked) is eligible when
 *                      complete and SELECTION_REQUIRED when not, through validatePriceRequestSelection
 *
 * The answer holds booleans and counts only: never a value, a name or a URL. Reads only — the one refusal it
 * throws (the storage error above) leaves nothing behind.
 */
import { listing } from '../listing';
import { validatePriceRequestSelection } from '../priceRequests';
import { INDEX_STAMP } from '../search/store';
import { isUsefulToken, tokenize } from '../search/normalize';
import type { Env } from '../types';
import { OpsRefusal } from './auth';
import { importObjectPresence } from './media';
import { IMPORT_GUARD_ID } from './protectedTables';
import { taxonomyOfRow, type ReviewedBundle } from './reviewed';
import type { WrittenCounts } from './writer';

export interface CheckedSelection {
  option_value_ids: string[];
  color_id?: string | null;
}

export interface D1CheckInput {
  bundle: ReviewedBundle;
  runId: string;
  itemId: string;
  /** Selections the runner checked on the page, beyond the default one. */
  selections?: CheckedSelection[];
  /** The media bindings for the R2 HEADs; without them the media check is not run (`media: null`). */
  media?: Pick<Env, 'BUCKET' | 'R2_PUBLIC' | 'R2_PRIVATE'>;
}

export interface D1Checks {
  /** Every hard check is true. */
  ok: boolean;
  checks: Record<string, boolean | null>;
  /** Counts recomputed from D1, comparable with the runner's edge evidence and the write's own record. */
  counts: Record<string, number | Record<string, number>>;
  /** The names of the checks that failed (never a value). */
  failed: string[];
}

const tally = <T>(xs: readonly T[], key: (x: T) => string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const x of xs) out[key(x)] = (out[key(x)] ?? 0) + 1;
  return out;
};

const sameTally = (a: Record<string, number> | undefined, b: Record<string, number>) => {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b)]);
  return [...keys].every((k) => Number(a?.[k] ?? 0) === Number(b[k] ?? 0));
};

/** Recomputes the D1-side facts of one written item. Reads only. */
export async function recomputeD1Checks(db: D1Database, input: D1CheckInput): Promise<D1Checks> {
  const checks: Record<string, boolean | null> = {};
  const counts: D1Checks['counts'] = {};
  const item = await db
    .prepare('SELECT id, handle, levonis_product_id, match_kind, stage_data FROM catalog_import_items WHERE id = ? AND run_id = ?')
    .bind(input.itemId, input.runId)
    .first<{ id: string; handle: string; levonis_product_id: string; match_kind: string; stage_data: string }>();
  const productId = item?.levonis_product_id ?? '';
  checks.written = !!item && productId !== '';
  if (!item || !productId) return finish(checks, counts);
  const created = item.match_kind === 'created';
  let written: Partial<WrittenCounts> = {};
  try {
    written = (JSON.parse(item.stage_data || '{}') as { written?: Partial<WrittenCounts> }).written ?? {};
  } catch {
    written = {};
  }

  // VISIBLE and SELLABLE, through catalog-only's predicates.
  const L = await listing(db);
  const state = (await L.statesOf([productId])).get(productId) ?? 'hidden';
  checks.visible = state !== 'hidden';
  checks.not_sellable = created ? state === 'catalog_only' : null;

  // Taxonomy: the map's resolution of the product's route.
  const product = await db
    .prepare('SELECT p.id, p.name, p.category_id, p.sub_category_id, s.source_route, s.stock_decision, s.match_kind FROM products p LEFT JOIN product_source_refs s ON s.product_id = p.id AND s.source = ? WHERE p.id = ?')
    .bind('bambu_us', productId)
    .first<{ name: string; category_id: string | null; sub_category_id: string | null; source_route: string | null; stock_decision: string | null; match_kind: string | null }>();
  checks.source_ref = !!product?.match_kind && (product.match_kind === 'created') === created;
  // The section the manifest row was REVIEWED for (reviewed.ts taxonomyOfRow), as the writer placed it — never the
  // stored source_route, which only repeats what the write was sent.
  const row = input.bundle.manifest.byHandle.get(item.handle);
  const tax = row ? taxonomyOfRow(input.bundle, row) : null;
  const { results: memberRows } = await db.prepare('SELECT catalog_id FROM product_catalogs WHERE product_id = ?').bind(productId).all<{ catalog_id: string }>();
  const members = new Set((memberRows ?? []).map((r) => String(r.catalog_id)));
  if (!tax) {
    checks.taxonomy = false;
  } else {
    const leafOk = created ? product?.sub_category_id === tax.primary || (product?.sub_category_id === null && product?.category_id === tax.primary) : true;
    const rootOk = created ? !!product?.category_id && members.has(product.category_id) : true;
    checks.taxonomy = leafOk && rootOk;
    checks.memberships = tax.secondaries.every((id) => members.has(id)) && (!created || members.has(tax.primary));
    if (created) {
      const expected = new Set([product?.category_id ?? '', product?.sub_category_id ?? '', ...tax.secondaries].filter(Boolean));
      checks.memberships = checks.memberships && expected.size === members.size && [...expected].every((id) => members.has(id));
    }
  }
  counts.memberships = members.size;

  // The search index: the stamp, the title's tokens, every searchable alias's tokens.
  const { results: tokenRows } = await db.prepare('SELECT token FROM search_tokens WHERE product_id = ?').bind(productId).all<{ token: string }>();
  const tokens = new Set((tokenRows ?? []).map((r) => String(r.token)));
  const { results: aliasRows } = await db
    .prepare('SELECT value FROM product_external_ids WHERE product_id = ? AND searchable = 1')
    .bind(productId)
    .all<{ value: string }>();
  const wanted = [String(product?.name ?? ''), ...(aliasRows ?? []).map((r) => String(r.value))].flatMap((t) => tokenize(t).filter(isUsefulToken));
  checks.search_stamp = tokens.has(INDEX_STAMP);
  checks.search_tokens = wanted.every((t) => tokens.has(t));
  // The stamps (`#doc:…`, `#ids:…`) are not tokens: every word a shopper can type starts with a letter or digit.
  counts.search_tokens = [...tokens].filter((t) => !t.startsWith('#')).length;

  // The rows the write recorded, recomputed.
  const { results: imageRows } = await db
    .prepare(
      created
        ? 'SELECT id, r2_key, option_value_id, variant_id, color_id FROM product_images WHERE product_id = ?'
        : `SELECT i.id, i.r2_key, i.option_value_id, i.variant_id, i.color_id FROM product_images i
            WHERE i.product_id = ? AND i.id IN (SELECT levonis_id FROM product_option_source_refs WHERE product_id = i.product_id AND kind = 'image')`
    )
    .bind(productId)
    .all<{ id: string; r2_key: string; option_value_id: string | null; variant_id: string | null; color_id: string | null }>();
  const images = imageRows ?? [];
  const bindings = tally(images, (i) => (i.variant_id ? 'variant' : i.option_value_id ? 'value' : i.color_id ? 'color' : 'product'));
  counts.images = images.length;
  counts.image_bindings = bindings;
  const one = async (sql: string) => Number((await db.prepare(sql).bind(productId).first<{ n: number }>())?.n ?? 0);
  if (created) {
    counts.groups = await one('SELECT COUNT(*) AS n FROM product_option_groups WHERE product_id = ?');
    counts.values = await one('SELECT COUNT(*) AS n FROM product_option_values WHERE product_id = ?');
    counts.variants = await one('SELECT COUNT(*) AS n FROM product_variants WHERE product_id = ?');
  }
  const { results: specRows } = await db
    .prepare('SELECT status, region FROM product_spec_values WHERE product_id = ? AND import_run_id = ?')
    .bind(productId, input.runId)
    .all<{ status: string; region: string }>();
  const specsByStatus = tally(specRows ?? [], (s) => s.status);
  const specsByRegion = tally((specRows ?? []).filter((s) => s.region), (s) => s.region);
  counts.specs_by_status = specsByStatus;
  counts.specs_by_region = specsByRegion;
  counts.documents = await one(`SELECT COUNT(*) AS n FROM product_documents WHERE product_id = ? AND import_run_id <> ''`);
  counts.relations = await one(`SELECT COUNT(*) AS n FROM product_relations WHERE product_id = ? AND import_run_id <> ''`);
  const { results: swatchRows } = await db
    .prepare(
      `SELECT s.r2_key, EXISTS (SELECT 1 FROM product_option_values v WHERE v.id = s.option_value_id AND v.product_id = s.product_id) AS own
         FROM product_option_value_swatches s WHERE s.product_id = ?`
    )
    .bind(productId)
    .all<{ r2_key: string; own: number }>();
  counts.swatches = (swatchRows ?? []).length;
  // §I.1.6: every swatch row this product holds is the swatch of one of its own values.
  checks.swatches_own = (swatchRows ?? []).every((s) => Number(s.own) === 1);
  checks.counts =
    images.length === Number(written.images ?? -1) &&
    sameTally(written.image_bindings, bindings) &&
    sameTally(written.specs_by_status, specsByStatus) &&
    sameTally(written.specs_by_region, specsByRegion) &&
    counts.documents === Number(written.documents ?? -1) &&
    counts.relations === Number(written.relations ?? -1) &&
    counts.swatches === Number(written.swatches ?? -1) &&
    (!created ||
      (counts.groups === Number(written.groups ?? -1) && counts.values === Number(written.values ?? -1) && counts.variants === Number(written.variants ?? -1)));

  // The objects behind every image, swatch and in-the-box picture.
  if (input.media) {
    const { results: boxRows } = await db
      .prepare("SELECT value_list FROM product_spec_values WHERE product_id = ? AND canonical_key = 'package.contents'")
      .bind(productId)
      .all<{ value_list: string }>();
    const boxKeys = (boxRows ?? []).flatMap((r) => {
      try {
        return (JSON.parse(r.value_list) as Array<{ media_key?: unknown }>).flatMap((x) => (typeof x?.media_key === 'string' && x.media_key ? [x.media_key] : []));
      } catch {
        return [];
      }
    });
    const keys = [...new Set([...images.map((i) => i.r2_key), ...(swatchRows ?? []).map((s) => s.r2_key), ...boxKeys].filter(Boolean))];
    const presence = await Promise.all(keys.map((k) => importObjectPresence(input.media!, k)));
    // A HEAD that FAILED is not a missing object (§B.5: transient), as at /media and /readback: the whole call is
    // answered 503 before completeItem records anything, and the runner asks again. Only an object R2 positively
    // does not have (absent, or empty) fails the check.
    if (presence.includes('unknown')) throw new OpsRefusal(503, 'IMPORT_STORAGE_UNAVAILABLE', [input.itemId]);
    checks.media = presence.every((p) => p === 'present');
    counts.media_objects = keys.length;
  } else {
    checks.media = null;
  }

  // The stock decision (§B.10) and the guard row.
  checks.stock_decision = created ? product?.stock_decision === 'not_configured' : product?.stock_decision === 'not_required';
  checks.guard_clear = !(await db.prepare('SELECT 1 AS x FROM ops_guards WHERE id = ?').bind(IMPORT_GUARD_ID).first());

  // The price-request door, through the POST's own validator: eligible when complete, SELECTION_REQUIRED when not.
  const requestsBefore = await requestRows(db, productId);
  const { results: groupRows } = await db
    .prepare(
      `SELECT g.id, g.default_value_id, (SELECT COUNT(*) FROM product_option_values v WHERE v.group_id = g.id AND v.id = g.default_value_id AND v.active = 1) AS has_default
         FROM product_option_groups g WHERE g.product_id = ? AND g.active = 1`
    )
    .bind(productId)
    .all<{ id: string; default_value_id: string; has_default: number }>();
  const groups = groupRows ?? [];
  const defaults = groups.filter((g) => Number(g.has_default) > 0).map((g) => String(g.default_value_id));
  // A colour is a choice too (a merged product's product_colors): with one, the default selection is incomplete.
  const colours = await one('SELECT COUNT(*) AS n FROM product_colors WHERE product_id = ? AND active = 1');
  const selections: Array<CheckedSelection & { complete: boolean }> = [
    { option_value_ids: defaults, complete: defaults.length === groups.length && colours === 0 },
    ...(input.selections ?? []).map((s) => ({ ...s, complete: s.option_value_ids.length >= groups.length })),
  ];
  let eligible = true;
  for (const s of selections) {
    const v = await validatePriceRequestSelection(db, productId, { option_value_ids: s.option_value_ids, color_id: s.color_id ?? null });
    const good = s.complete ? v.ok === true || (!created && !v.ok && v.code === 'PRICE_REQUEST_ALREADY_PRICED') : !v.ok && v.code === 'PRICE_REQUEST_SELECTION_REQUIRED';
    if (!good) eligible = false;
  }
  checks.price_request = eligible;
  const requestsAfter = await requestRows(db, productId);
  checks.no_request_created = requestsBefore === requestsAfter;
  counts.selections_checked = selections.length;
  return finish(checks, counts);
}

async function requestRows(db: D1Database, productId: string): Promise<number | null> {
  try {
    return Number((await db.prepare('SELECT COUNT(*) AS n FROM product_price_requests WHERE product_id = ?').bind(productId).first<{ n: number }>())?.n ?? 0);
  } catch {
    // A database without 0193 has no request table: nothing could have been created.
    return null;
  }
}

function finish(checks: Record<string, boolean | null>, counts: D1Checks['counts']): D1Checks {
  const failed = Object.entries(checks)
    .filter(([, v]) => v === false)
    .map(([k]) => k);
  return { ok: failed.length === 0, checks, counts, failed };
}
