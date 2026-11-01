/**
 * PAGED MATCHING AND THE OWNER'S MATCH DECISIONS (docs/SMART_PRICING.md §3.5,
 * §3.6; migration 0218).
 *
 * `POST /supplier-prices/match {cursor}` matches one page of 25 Levonis
 * products against the current complete snapshots, deterministically and with
 * no AI: the pure matcher (packages/catalog/src/supplierPrices/match.ts) does
 * the scoring; this file reads its inputs and writes its answer.
 *
 * Which products: every ordinary product (no bundle, no mystery box) that the
 * Bambu import created or merged (`product_source_refs`), or that the owner
 * enrolled for an estimate (`product_price_estimates`). Ordered by id; the
 * cursor is the last id.
 *
 * Reads, per page, a fixed number of statements whatever its size:
 *   - the products as the cart reads them (`loadProducts`), their sellable SKUs;
 *   - one batch: the import's identities (`product_external_ids`: variant-scope
 *     bambu_variant_id / bambu_sku_code, option-value-scope color_code,
 *     product-scope part_code), the store handle (`product_source_refs`), a
 *     type the owner chose (its sourcing), and the existing matches with
 *     whether each key is in its source's current complete snapshot;
 *   - the candidates: ONE statement over `supplier_price_keys` (ix_spk_lookup)
 *     for every key of the page through json_each, the strongest few items per
 *     product and source;
 *   - one batch: those items and their SKUs.
 *
 * What a run writes, in ONE batch per page:
 *   - a match whose combo key is no longer a sellable SKU of its product is
 *     pruned (the owner changed its options), whatever its state;
 *   - the matcher's own suggestions are replaced by this run's;
 *   - exact and high matches are confirmed automatically (decided_by 'auto');
 *   - a CONFIRMED match — the owner's or automatic — is carried over as it is:
 *     keyed by the supplier's own ids, it re-attaches to every new capture. The
 *     one exception: an automatic confirmation whose key is gone from its
 *     source's current snapshot is replaced by a new automatic one;
 *   - a pairing the owner rejected is never suggested again.
 * A confirmed key missing from the current snapshot is listed in the answer
 * (`missing`, EST_SOURCE_ITEM_MISSING): its link stays, it gives no price.
 *
 * Matching never publishes anything (§3.5): a confirmed match only feeds an
 * estimate preview; publishing is the owner's apply.
 */
import { auditStatements } from '../audit';
import { notFound } from '../http';
import { fence, isFenceMiss } from '../operations';
import { inputInvalid } from '../pricingEngine/whatIf';
import {
  MATCH_REASONS,
  isAutoConfirmed,
  matchProduct,
  productKeysOf,
  type CatalogueItem,
  type CatalogueSku,
  type MatchIdentity,
  type MatchReason,
} from '@levonis/catalog/supplierPrices/match';
import { isSupplierItemKey, isSupplierSkuKey } from '@levonis/catalog/supplierPrices/format';
import {
  CURRENT_SNAPSHOTS_SQL,
  MATCHES_TOKEN_SQL,
  currentSnapshotsOf,
  isProductId,
  isSupplierSource,
  loadProductSkus,
  pricingChanged,
  strictBody,
  versionTokens,
  type ProductSkus,
  type SupplierSource,
} from './store';

/** Products per match page (§3.5). */
export const MATCH_PAGE = 25;
/** The strongest candidate items per product and source handed to the matcher. */
export const CANDIDATES_PER_SOURCE = 6;
/** Rows per INSERT statement (one json_each list each). */
const WRITE_CHUNK = 300;

const parseJson = <T>(raw: unknown, fallback: T): T => {
  if (typeof raw !== 'string') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

// ---------------------------------------------------------------- the Levonis side

interface ExtRow {
  product_id: string;
  scope_kind: string;
  scope_id: string;
  id_type: string;
  value: string;
}

/** The identity the pure matcher reads for one product (its sellable SKUs, groups with kinds, codes and handle). */
export function identityOf(p: ProductSkus, ext: readonly ExtRow[], handle: string | null, ownerSourcing: 'EU_STORE_EUR' | 'CHINA_CNY' | null): MatchIdentity {
  const { doc, view } = p.loaded;
  const groupOfValue = new Map((view?.values ?? []).map((v) => [v.id, v.group_id] as const));
  const groups = (view?.groups ?? []).map((g) => ({ id: g.id, kind: String(g.kind ?? ''), name_en: g.name_en }));
  if ((doc.options ?? []).some((o) => !groupOfValue.has(o.id))) groups.push({ id: '', kind: '', name_en: '' });
  const colourOfValue = new Map<string, string>();
  const variantCombo = new Map((view?.variants ?? []).map((v) => [v.id, v.combo_key] as const));
  const variantIds = new Map<string, string[]>();
  const skuCodes = new Map<string, string[]>();
  const partCodes: string[] = [];
  const push = (m: Map<string, string[]>, k: string, v: string) => {
    if (!m.has(k)) m.set(k, []);
    if (!m.get(k)!.includes(v)) m.get(k)!.push(v);
  };
  for (const e of ext) {
    if (e.scope_kind === 'option_value' && e.id_type === 'color_code') colourOfValue.set(e.scope_id, e.value);
    else if (e.scope_kind === 'product' && e.id_type === 'part_code') partCodes.push(e.value);
    else if (e.scope_kind === 'variant') {
      const combo = variantCombo.get(e.scope_id);
      if (combo === undefined) continue;
      if (e.id_type === 'bambu_variant_id') push(variantIds, combo, e.value);
      else if (e.id_type === 'bambu_sku_code') push(skuCodes, combo, e.value);
    }
  }
  return {
    product_id: p.product_id,
    name: p.name,
    handle,
    part_codes: partCodes,
    owner_sourcing: ownerSourcing,
    groups,
    values: (doc.options ?? [])
      .filter((o) => o.active !== false)
      .map((o) => ({ id: o.id, group_id: groupOfValue.get(o.id) ?? '', name_en: o.name_en || o.name_ar || '', color_code: colourOfValue.get(o.id) ?? null })),
    colors: (doc.colors ?? []).filter((c) => c.active !== false).map((c) => ({ id: c.id, name_en: c.name_en || c.name_ar || '', color_code: null })),
    skus: (p.skus ?? []).map((s) => ({
      combo_key: s.combo_key,
      value_ids: s.option_value_ids,
      color_id: s.color_id,
      variant_ids: variantIds.get(s.combo_key) ?? [],
      sku_codes: skuCodes.get(s.combo_key) ?? [],
    })),
  };
}

// ---------------------------------------------------------------- the catalogue side

interface ItemRow {
  snapshot_id: string;
  item_key: string;
  source: string;
  title: string;
  name_en: string;
  category: string;
  sourcing_hint: string;
  codes_json: string;
}

interface SkuRow {
  snapshot_id: string;
  item_key: string;
  sku_key: string;
  options_json: string;
  options_en_json: string;
  codes_json: string;
  sku_code: string;
  price: string;
  quantity: number | null;
}

/** One CatalogueItem per stored item (one object, so the matcher reads each item's facts once a page). */
export function catalogueItemsOf(items: readonly ItemRow[], skus: readonly SkuRow[]): Map<string, CatalogueItem & { snapshot_id: string }> {
  const bySnapshotItem = new Map<string, CatalogueSku[]>();
  for (const s of skus) {
    const k = `${s.snapshot_id}\u0000${s.item_key}`;
    if (!bySnapshotItem.has(k)) bySnapshotItem.set(k, []);
    bySnapshotItem.get(k)!.push({
      sku_key: String(s.sku_key),
      options: parseJson<Record<string, string>>(s.options_json, {}),
      options_en: parseJson<Record<string, string>>(s.options_en_json, {}),
      codes: parseJson<string[]>(s.codes_json, []),
      sku_code: String(s.sku_code ?? ''),
      price: String(s.price),
      quantity: s.quantity === null || s.quantity === undefined ? null : Number(s.quantity),
    });
  }
  const out = new Map<string, CatalogueItem & { snapshot_id: string }>();
  for (const i of items) {
    if (!isSupplierSource(i.source)) continue;
    const k = `${i.snapshot_id}\u0000${i.item_key}`;
    out.set(k, {
      snapshot_id: String(i.snapshot_id),
      source: i.source,
      item_key: String(i.item_key),
      title: String(i.title ?? ''),
      name_en: String(i.name_en ?? ''),
      category: String(i.category ?? ''),
      sourcing_hint: String(i.sourcing_hint ?? ''),
      codes: parseJson<string[]>(i.codes_json, []),
      skus: (bySnapshotItem.get(k) ?? []).sort((a, b) => (a.sku_key < b.sku_key ? -1 : a.sku_key > b.sku_key ? 1 : 0)),
    });
  }
  return out;
}

/** The candidates of a page: per product index, the strongest items of each source (ranked by key weight). */
const CANDIDATES_SQL = `
  SELECT pi, source, snapshot_id, item_key FROM (
    SELECT h.pi, h.source, h.snapshot_id, h.item_key,
           ROW_NUMBER() OVER (PARTITION BY h.pi, h.source ORDER BY h.w DESC, h.item_key) AS rn
      FROM (
        SELECT json_extract(j.value, '$[0]') AS pi, s.source AS source, k.snapshot_id AS snapshot_id, k.item_key AS item_key,
               SUM(CASE k.key_type WHEN 'variant_id' THEN 1000 WHEN 'sku_code' THEN 1000 WHEN 'handle' THEN 500
                                   WHEN 'part_code' THEN 100 WHEN 'color_code' THEN 10 WHEN 'model_token' THEN 3 ELSE 1 END) AS w
          FROM json_each(?1) j
          JOIN supplier_price_keys k ON k.key_type = json_extract(j.value, '$[1]') AND k.key_value = json_extract(j.value, '$[2]')
          JOIN supplier_price_snapshots s ON s.id = k.snapshot_id AND s.state = 'complete'
         GROUP BY pi, s.source, k.snapshot_id, k.item_key
      ) h
  ) WHERE rn <= ?2`;

// ---------------------------------------------------------------- one page

export interface MissingKey {
  combo_key: string;
  source: SupplierSource;
  item_key: string;
  sku_key: string;
}

export interface MatchProductSummary {
  product_id: string;
  /** Matches confirmed automatically by this run. */
  confirmed: number;
  /** Suggestions this run left for the owner. */
  suggested: number;
  /** Confirmed matches kept as they were. */
  carried: number;
  /** Matches deleted because their combo key is no longer a sellable SKU. */
  pruned: number;
  /** Confirmed keys absent from their source's current complete snapshot (EST_SOURCE_ITEM_MISSING). */
  missing: MissingKey[];
  /**
   * Candidate items refused outright, with the matcher's code (PACK_MISMATCH, TYPE_MISMATCH,
   * LISTING_MISMATCH, MODEL_MISMATCH, PLACEHOLDER_LISTING): told to the owner, never stored — a
   * refused pairing maps no SKU, so it has no row (at most three per source).
   */
  refused: Array<{ source: SupplierSource; item_key: string; reason: string }>;
  /** Why the product was not matched (its SKU grid is larger than the engine reads). */
  skipped: 'SKU_GRID_TOO_LARGE' | null;
}

export interface MatchPageAnswer {
  products: MatchProductSummary[];
  next_cursor: string | null;
}

interface ExistingRow {
  product_id: string;
  combo_key: string;
  source: string;
  item_key: string;
  sku_key: string;
  state: string;
  decided_by: string;
  present: number;
}

interface NewRow {
  p: string;
  c: string;
  s: SupplierSource;
  i: string;
  k: string;
  cf: string;
  m: string;
  r: string;
  st: 'confirmed' | 'suggested';
  d: string;
  da: string;
  f: string;
}

const pkOf = (r: { product_id?: string; p?: string; combo_key?: string; c?: string; source?: string; s?: string; item_key?: string; i?: string; sku_key?: string; k?: string }) =>
  [r.product_id ?? r.p, r.combo_key ?? r.c, r.source ?? r.s, r.item_key ?? r.i, r.sku_key ?? r.k].join('\u0000');

/** The page of products a run matches: the named ones (≤ 25), or the next 25 after the cursor. */
async function pageIds(db: D1Database, input: { cursor?: unknown; product_ids?: unknown }): Promise<{ ids: string[]; next: string | null }> {
  if (input.product_ids !== undefined) {
    const list = input.product_ids;
    if (!Array.isArray(list) || list.length < 1 || list.length > MATCH_PAGE || !list.every(isProductId)) throw inputInvalid('product_ids');
    return { ids: [...new Set(list as string[])], next: null };
  }
  const cursor = input.cursor === undefined || input.cursor === null ? '' : input.cursor;
  if (typeof cursor !== 'string' || (cursor !== '' && !isProductId(cursor))) throw inputInvalid('cursor');
  const { results } = await db
    .prepare(
      `SELECT p.id FROM products p
        WHERE COALESCE(p.composition, '') = '' AND p.id > ?1
          AND (EXISTS (SELECT 1 FROM product_source_refs r WHERE r.product_id = p.id)
               OR EXISTS (SELECT 1 FROM product_price_estimates e WHERE e.product_id = p.id))
        ORDER BY p.id LIMIT ?2`
    )
    .bind(cursor, MATCH_PAGE + 1)
    .all<{ id: string }>();
  const ids = (results ?? []).map((r) => String(r.id));
  const more = ids.length > MATCH_PAGE;
  const page = ids.slice(0, MATCH_PAGE);
  return { ids: page, next: more ? page[page.length - 1]! : null };
}

/**
 * One page of matching (POST /match {cursor?} or {product_ids}). Answers what
 * it wrote per product and the next cursor (null at the end).
 */
export async function runMatchPage(db: D1Database, input: { cursor?: unknown; product_ids?: unknown }, actor: string, now: Date): Promise<MatchPageAnswer> {
  const at = now.toISOString();
  const { ids, next } = await pageIds(db, input);
  const products = await loadProductSkus(db, ids);
  const order = ids.filter((id) => products.has(id));
  if (!order.length) return { products: [], next_cursor: next };
  const list = JSON.stringify(order);

  const [extRes, refRes, ownerRes, existingRes, snapRes] = (await db.batch([
    db
      .prepare(
        `SELECT product_id, scope_kind, scope_id, id_type, value FROM product_external_ids
          WHERE product_id IN (SELECT value FROM json_each(?)) AND id_type IN ('bambu_variant_id', 'bambu_sku_code', 'color_code', 'part_code')`
      )
      .bind(list),
    db.prepare('SELECT product_id, source_handle FROM product_source_refs WHERE product_id IN (SELECT value FROM json_each(?)) ORDER BY product_id, source').bind(list),
    db
      .prepare(
        `SELECT e.product_id, COALESCE(e.sourcing_override, t.sourcing) AS sourcing
           FROM product_price_estimates e LEFT JOIN price_estimate_types t ON t.key = e.type_key
          WHERE e.product_id IN (SELECT value FROM json_each(?)) AND e.type_source = 'owner'`
      )
      .bind(list),
    db
      .prepare(
        `SELECT m.product_id, m.combo_key, m.source, m.item_key, m.sku_key, m.state, m.decided_by,
                EXISTS (SELECT 1 FROM supplier_price_snapshots s JOIN supplier_price_skus k ON k.snapshot_id = s.id
                         WHERE s.source = m.source AND s.state = 'complete' AND k.item_key = m.item_key AND k.sku_key = m.sku_key) AS present
           FROM supplier_price_matches m WHERE m.product_id IN (SELECT value FROM json_each(?))`
      )
      .bind(list),
    db.prepare(CURRENT_SNAPSHOTS_SQL),
  ])) as Array<{ results?: unknown[] }>;
  const ext = (extRes?.results ?? []) as ExtRow[];
  const handles = new Map<string, string>();
  for (const r of (refRes?.results ?? []) as Array<{ product_id: string; source_handle: string }>) if (!handles.has(r.product_id)) handles.set(r.product_id, String(r.source_handle));
  const ownerSourcing = new Map<string, 'EU_STORE_EUR' | 'CHINA_CNY'>();
  for (const r of (ownerRes?.results ?? []) as Array<{ product_id: string; sourcing: string | null }>) {
    if (r.sourcing === 'EU_STORE_EUR' || r.sourcing === 'CHINA_CNY') ownerSourcing.set(r.product_id, r.sourcing);
  }
  const existing = (existingRes?.results ?? []) as ExistingRow[];
  const current = currentSnapshotsOf((snapRes?.results ?? []) as Record<string, unknown>[]);

  // The identities, and every key of the page (index, type, value).
  const identities = new Map<string, MatchIdentity>();
  const keys: Array<[number, string, string]> = [];
  order.forEach((id, pi) => {
    const p = products.get(id)!;
    if (p.skus === null) return;
    const identity = identityOf(
      p,
      ext.filter((e) => e.product_id === id),
      handles.get(id) ?? null,
      ownerSourcing.get(id) ?? null
    );
    identities.set(id, identity);
    for (const k of productKeysOf(identity)) keys.push([pi, k.key_type, k.key_value]);
  });

  // The candidates (one statement), then their items and SKUs (one batch).
  const candidates = new Map<number, Array<{ snapshot_id: string; item_key: string }>>();
  if (keys.length && current.size) {
    const { results } = await db.prepare(CANDIDATES_SQL).bind(JSON.stringify(keys), CANDIDATES_PER_SOURCE).all<{ pi: number; snapshot_id: string; item_key: string }>();
    for (const r of results ?? []) {
      const pi = Number(r.pi);
      if (!candidates.has(pi)) candidates.set(pi, []);
      candidates.get(pi)!.push({ snapshot_id: String(r.snapshot_id), item_key: String(r.item_key) });
    }
  }
  const refs = new Map<string, [string, string]>();
  for (const list of candidates.values()) for (const c of list) refs.set(`${c.snapshot_id}\u0000${c.item_key}`, [c.snapshot_id, c.item_key]);
  let catalogue = new Map<string, CatalogueItem & { snapshot_id: string }>();
  if (refs.size) {
    const refList = JSON.stringify([...refs.values()]);
    const [itemRes, skuRes] = (await db.batch([
      db
        .prepare(
          `SELECT i.snapshot_id, i.item_key, s.source, i.title, i.name_en, i.category, i.sourcing_hint, i.codes_json
             FROM json_each(?1) j
             JOIN supplier_price_items i ON i.snapshot_id = json_extract(j.value, '$[0]') AND i.item_key = json_extract(j.value, '$[1]')
             JOIN supplier_price_snapshots s ON s.id = i.snapshot_id`
        )
        .bind(refList),
      db
        .prepare(
          `SELECT k.snapshot_id, k.item_key, k.sku_key, k.options_json, k.options_en_json, k.codes_json, k.sku_code, k.price, k.quantity
             FROM json_each(?1) j
             JOIN supplier_price_skus k ON k.snapshot_id = json_extract(j.value, '$[0]') AND k.item_key = json_extract(j.value, '$[1]')`
        )
        .bind(refList),
    ])) as Array<{ results?: unknown[] }>;
    catalogue = catalogueItemsOf((itemRes?.results ?? []) as ItemRow[], (skuRes?.results ?? []) as SkuRow[]);
  }

  // Plan each product's writes.
  const summaries: MatchProductSummary[] = [];
  const prunePairs: Array<[string, string]> = [];
  const replacedAuto: Array<[string, string, string, string, string]> = [];
  const inserts: NewRow[] = [];
  const matched: string[] = [];
  order.forEach((id, pi) => {
    const summary: MatchProductSummary = { product_id: id, confirmed: 0, suggested: 0, carried: 0, pruned: 0, missing: [], refused: [], skipped: null };
    summaries.push(summary);
    const identity = identities.get(id);
    if (!identity) {
      summary.skipped = 'SKU_GRID_TOO_LARGE';
      return;
    }
    matched.push(id);
    const valid = new Set(identity.skus.map((s) => s.combo_key));
    const own = existing.filter((r) => r.product_id === id);
    const vanished = new Set(own.filter((r) => !valid.has(r.combo_key)).map((r) => r.combo_key));
    for (const combo of vanished) prunePairs.push([id, combo]);
    summary.pruned = own.filter((r) => vanished.has(r.combo_key)).length;
    const live = own.filter((r) => valid.has(r.combo_key));
    const confirmedBy = new Map(live.filter((r) => r.state === 'confirmed').map((r) => [`${r.combo_key}\u0000${r.source}`, r] as const));
    const rejected = new Set(live.filter((r) => r.state === 'rejected').map(pkOf));
    const replaced = new Set<string>();

    const items = (candidates.get(pi) ?? []).map((c) => catalogue.get(`${c.snapshot_id}\u0000${c.item_key}`)).filter((x): x is CatalogueItem & { snapshot_id: string } => !!x);
    const result = matchProduct(identity, items);
    for (const sm of result.sources) {
      for (const it of sm.items.filter((x) => x.refused).slice(0, 3)) summary.refused.push({ source: sm.source, item_key: it.item_key, reason: it.refused! });
      const best = sm.best;
      if (!best || best.refused || best.mapped === 0) continue;
      const auto = isAutoConfirmed(best);
      const snapshotId = items.find((it) => it.source === sm.source && it.item_key === best.item_key)?.snapshot_id ?? current.get(sm.source)?.id ?? '';
      for (const sku of best.skus) {
        if (sku.sku_key === null) continue;
        const row: NewRow = {
          p: id,
          c: sku.combo_key,
          s: sm.source,
          i: best.item_key,
          k: sku.sku_key,
          cf: best.confidence,
          m: sku.method ?? best.method,
          r: JSON.stringify([...new Set<MatchReason>([...best.reasons, ...sku.reasons])].filter((x) => (MATCH_REASONS as readonly string[]).includes(x))),
          st: auto ? 'confirmed' : 'suggested',
          d: auto ? 'auto' : '',
          da: auto ? at : '',
          f: snapshotId,
        };
        const conf = confirmedBy.get(`${sku.combo_key}\u0000${sm.source}`);
        if (conf) {
          // A confirmation is carried; an automatic one whose key left the catalogue gives way to a new automatic one.
          if (pkOf(conf) !== pkOf(row) && conf.decided_by === 'auto' && !Number(conf.present) && auto) {
            replacedAuto.push([conf.product_id, conf.combo_key, conf.source, conf.item_key, conf.sku_key]);
            replaced.add(pkOf(conf));
          } else continue;
        }
        if (rejected.has(pkOf(row))) continue;
        inserts.push(row);
        if (auto) summary.confirmed++;
        else summary.suggested++;
      }
    }
    for (const conf of confirmedBy.values()) {
      if (replaced.has(pkOf(conf))) continue;
      summary.carried++;
      if (!Number(conf.present) && isSupplierSource(conf.source)) {
        summary.missing.push({ combo_key: conf.combo_key, source: conf.source, item_key: conf.item_key, sku_key: conf.sku_key });
      }
    }
  });

  const writes: D1PreparedStatement[] = [];
  if (prunePairs.length) {
    writes.push(
      db
        .prepare(
          `DELETE FROM supplier_price_matches
            WHERE EXISTS (SELECT 1 FROM json_each(?1) j
                           WHERE json_extract(j.value, '$[0]') = supplier_price_matches.product_id
                             AND json_extract(j.value, '$[1]') = supplier_price_matches.combo_key)`
        )
        .bind(JSON.stringify(prunePairs))
    );
  }
  if (matched.length) {
    writes.push(db.prepare("DELETE FROM supplier_price_matches WHERE state = 'suggested' AND product_id IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(matched)));
  }
  if (replacedAuto.length) {
    writes.push(
      db
        .prepare(
          `DELETE FROM supplier_price_matches
            WHERE state = 'confirmed' AND decided_by = 'auto'
              AND EXISTS (SELECT 1 FROM json_each(?1) j
                           WHERE json_extract(j.value, '$[0]') = supplier_price_matches.product_id
                             AND json_extract(j.value, '$[1]') = supplier_price_matches.combo_key
                             AND json_extract(j.value, '$[2]') = supplier_price_matches.source
                             AND json_extract(j.value, '$[3]') = supplier_price_matches.item_key
                             AND json_extract(j.value, '$[4]') = supplier_price_matches.sku_key)`
        )
        .bind(JSON.stringify(replacedAuto))
    );
  }
  for (let i = 0; i < inserts.length; i += WRITE_CHUNK) {
    writes.push(
      db
        .prepare(
          `INSERT INTO supplier_price_matches
             (product_id, combo_key, source, item_key, sku_key, confidence, method, reasons_json, units_per_offer,
              state, decided_by, decided_at, found_in_snapshot, version, updated_at)
           SELECT json_extract(j.value, '$.p'), json_extract(j.value, '$.c'), json_extract(j.value, '$.s'),
                  json_extract(j.value, '$.i'), json_extract(j.value, '$.k'), json_extract(j.value, '$.cf'),
                  json_extract(j.value, '$.m'), json_extract(j.value, '$.r'), 1, json_extract(j.value, '$.st'),
                  json_extract(j.value, '$.d'), json_extract(j.value, '$.da'), json_extract(j.value, '$.f'), 1, ?2
             FROM json_each(?1) j
            WHERE NOT EXISTS (SELECT 1 FROM supplier_price_matches m
                               WHERE m.product_id = json_extract(j.value, '$.p') AND m.combo_key = json_extract(j.value, '$.c')
                                 AND m.source = json_extract(j.value, '$.s') AND m.state = 'confirmed')
           ON CONFLICT DO NOTHING`
        )
        .bind(JSON.stringify(inserts.slice(i, i + WRITE_CHUNK)), at)
    );
  }
  if (writes.length) {
    const totals = summaries.reduce((t, s) => ({ c: t.c + s.confirmed, s: t.s + s.suggested, p: t.p + s.pruned }), { c: 0, s: 0, p: 0 });
    const audit = await auditStatements(db, actor, 'supplier_prices.match_run', order[0]!, { products: order.length, confirmed: totals.c, suggested: totals.s, pruned: totals.p });
    await db.batch([...writes, ...audit.statements]);
  }
  return { products: summaries, next_cursor: next };
}

// ---------------------------------------------------------------- the owner's review

export const REVIEW_STATES = ['suggested', 'auto', 'rejected', 'missing'] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

const REVIEW_WHERE: Record<ReviewState, string> = {
  suggested: "m.state = 'suggested'",
  auto: "m.state = 'confirmed' AND m.decided_by = 'auto'",
  rejected: "m.state = 'rejected'",
  missing: `m.state = 'confirmed' AND NOT EXISTS (SELECT 1 FROM supplier_price_snapshots s JOIN supplier_price_skus k ON k.snapshot_id = s.id
             WHERE s.source = m.source AND s.state = 'complete' AND k.item_key = m.item_key AND k.sku_key = m.sku_key)`,
};

/** The products of one review list (GET /matches?state=), 25 a page by id; the cursor is the last id. */
export async function reviewPageIds(db: D1Database, state: ReviewState, cursor: string): Promise<{ ids: string[]; next: string | null }> {
  const { results } = await db
    .prepare(`SELECT DISTINCT m.product_id AS id FROM supplier_price_matches m WHERE ${REVIEW_WHERE[state]} AND m.product_id > ? ORDER BY m.product_id LIMIT ?`)
    .bind(cursor, MATCH_PAGE + 1)
    .all<{ id: string }>();
  const ids = (results ?? []).map((r) => String(r.id));
  const page = ids.slice(0, MATCH_PAGE);
  return { ids: page, next: ids.length > MATCH_PAGE ? page[page.length - 1]! : null };
}

// ---------------------------------------------------------------- PUT /matches/:product_id

export interface MatchDecision {
  combo_key: string;
  source: SupplierSource;
  item_key: string;
  /** null rejects the item for this SKU. */
  sku_key: string | null;
  units_per_offer: number;
}

const DECISION_KEYS = ['combo_key', 'source', 'item_key', 'sku_key', 'units_per_offer'];

/** The body's decisions, each checked against the product's sellable SKUs and its key grammar. */
export function parseDecisions(raw: unknown, sellable: ReadonlySet<string>): MatchDecision[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 720) throw inputInvalid('skus');
  const seen = new Set<string>();
  return raw.map((x) => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) throw inputInvalid('skus');
    const o = x as Record<string, unknown>;
    strictBody(o, DECISION_KEYS);
    if (typeof o.combo_key !== 'string' || !sellable.has(o.combo_key)) throw inputInvalid('combo_key');
    if (!isSupplierSource(o.source)) throw inputInvalid('source');
    if (!isSupplierItemKey(o.source, o.item_key)) throw inputInvalid('item_key');
    const skuKey = o.sku_key === null ? null : o.sku_key;
    if (skuKey !== null && !isSupplierSkuKey(o.source, skuKey)) throw inputInvalid('sku_key');
    const units = o.units_per_offer === undefined ? 1 : o.units_per_offer;
    if (typeof units !== 'number' || !Number.isSafeInteger(units) || units < 1 || units > 1000) throw inputInvalid('units_per_offer');
    if (skuKey === null && units !== 1) throw inputInvalid('units_per_offer');
    const k = `${o.combo_key}\u0000${o.source}`;
    if (seen.has(k)) throw inputInvalid('skus');
    seen.add(k);
    return { combo_key: o.combo_key, source: o.source, item_key: o.item_key as string, sku_key: skuKey as string | null, units_per_offer: units };
  });
}

/**
 * The owner's decisions on one product's matches, fenced on the version token
 * he read: confirm or re-point a SKU (`sku_key`, with `units_per_offer` for a
 * pack only the owner divides — EST_UNITS_DIVIDED), or reject an item for it
 * (`sku_key: null`). A confirmation turns any other confirmation of that SKU
 * and source into a rejection by the owner and drops the other suggestions; a
 * confirmed key must be in its source's current complete snapshot.
 */
export async function decideMatches(db: D1Database, productId: string, body: Record<string, unknown>, actor: string, now: Date): Promise<void> {
  strictBody(body, ['version', 'skus']);
  if (!isProductId(productId)) throw notFound();
  if (typeof body.version !== 'string' || body.version.length > 120) throw inputInvalid('version');
  const product = (await loadProductSkus(db, [productId])).get(productId);
  if (!product) throw notFound();
  if (product.skus === null) throw inputInvalid('combo_key');
  const decisions = parseDecisions(body.skus, new Set(product.skus.map((s) => s.combo_key)));
  const token = (await versionTokens(db, [productId])).get(productId)!.matches;
  if (token !== body.version) throw pricingChanged();

  const confirms = decisions.filter((d) => d.sku_key !== null);
  const rejects = decisions.filter((d) => d.sku_key === null);
  const current = currentSnapshotsOf((await db.prepare(CURRENT_SNAPSHOTS_SQL).all<Record<string, unknown>>()).results ?? []);
  if (confirms.length) {
    const wanted = confirms.map((d) => [current.get(d.source)?.id ?? '', d.item_key, d.sku_key]);
    const { results } = await db
      .prepare(
        `SELECT json_extract(j.value, '$[0]') AS snapshot_id, json_extract(j.value, '$[1]') AS item_key, json_extract(j.value, '$[2]') AS sku_key
           FROM json_each(?1) j
          WHERE EXISTS (SELECT 1 FROM supplier_price_skus k
                         WHERE k.snapshot_id = json_extract(j.value, '$[0]') AND k.item_key = json_extract(j.value, '$[1]') AND k.sku_key = json_extract(j.value, '$[2]'))`
      )
      .bind(JSON.stringify(wanted))
      .all<{ snapshot_id: string; item_key: string; sku_key: string }>();
    const found = new Set((results ?? []).map((r) => `${r.snapshot_id}\u0000${r.item_key}\u0000${r.sku_key}`));
    for (const w of wanted) if (!w[0] || !found.has(w.join('\u0000'))) throw inputInvalid('sku_key');
  }

  const at = now.toISOString();
  const confirmList = JSON.stringify(
    confirms.map((d) => ({ c: d.combo_key, s: d.source, i: d.item_key, k: d.sku_key, u: d.units_per_offer, f: current.get(d.source)!.id }))
  );
  const rejectList = JSON.stringify(rejects.map((d) => ({ c: d.combo_key, s: d.source, i: d.item_key })));
  const sameSku = `json_extract(j.value, '$.c') = supplier_price_matches.combo_key AND json_extract(j.value, '$.s') = supplier_price_matches.source`;
  const notChosen = `NOT (json_extract(j.value, '$.i') = supplier_price_matches.item_key AND json_extract(j.value, '$.k') = supplier_price_matches.sku_key)`;
  const audit = await auditStatements(db, actor, 'supplier_prices.match_decide', productId, {
    confirmed: confirms.length,
    rejected: rejects.length,
    divided: confirms.filter((d) => d.units_per_offer > 1).length,
  });
  const statements: D1PreparedStatement[] = [...fence(db, `${MATCHES_TOKEN_SQL} = ?`, [productId, body.version])];
  if (confirms.length) {
    statements.push(
      // Any other confirmation of the SKU and source: rejected by the owner (a divided pack goes back to one unit).
      db
        .prepare(
          `UPDATE supplier_price_matches
              SET state = 'rejected', units_per_offer = 1, decided_by = ?2, decided_at = ?3, version = version + 1, updated_at = ?3
            WHERE product_id = ?1 AND state = 'confirmed'
              AND EXISTS (SELECT 1 FROM json_each(?4) j WHERE ${sameSku} AND ${notChosen})`
        )
        .bind(productId, actor, at, confirmList),
      db
        .prepare(
          `DELETE FROM supplier_price_matches
            WHERE product_id = ?1 AND state = 'suggested'
              AND EXISTS (SELECT 1 FROM json_each(?2) j WHERE ${sameSku} AND ${notChosen})`
        )
        .bind(productId, confirmList),
      db
        .prepare(
          `INSERT INTO supplier_price_matches
             (product_id, combo_key, source, item_key, sku_key, confidence, method, reasons_json, units_per_offer,
              state, decided_by, decided_at, found_in_snapshot, version, updated_at)
           SELECT ?1, json_extract(j.value, '$.c'), json_extract(j.value, '$.s'), json_extract(j.value, '$.i'), json_extract(j.value, '$.k'),
                  'exact', 'owner', '[]', json_extract(j.value, '$.u'), 'confirmed', ?2, ?3, json_extract(j.value, '$.f'), 1, ?3
             FROM json_each(?4) j WHERE 1
           ON CONFLICT(product_id, combo_key, source, item_key, sku_key) DO UPDATE SET
             state = 'confirmed', units_per_offer = excluded.units_per_offer, decided_by = excluded.decided_by,
             decided_at = excluded.decided_at, version = supplier_price_matches.version + 1, updated_at = excluded.updated_at`
        )
        .bind(productId, actor, at, confirmList)
    );
  }
  if (rejects.length) {
    statements.push(
      db
        .prepare(
          `UPDATE supplier_price_matches
              SET state = 'rejected', units_per_offer = 1, decided_by = ?2, decided_at = ?3, version = version + 1, updated_at = ?3
            WHERE product_id = ?1
              AND EXISTS (SELECT 1 FROM json_each(?4) j WHERE ${sameSku} AND json_extract(j.value, '$.i') = supplier_price_matches.item_key)`
        )
        .bind(productId, actor, at, rejectList)
    );
  }
  try {
    await db.batch([...statements, ...audit.statements]);
  } catch (e) {
    if (isFenceMiss(e)) throw pricingChanged();
    throw e;
  }
}
