/**
 * ONE SOURCE OF TRUTH for a product's options, colours, images and stock.
 *
 * Migration 0022 backfilled every existing product's JSON `options` / `colors`
 * / `images` columns into real rows, and the admin form writes only rows from
 * now on. This module is the read side of that: given a parsed ProductDoc it
 * returns a doc whose `options` and `colors` come from the TABLES whenever the
 * product has any relational row, plus the richer structures the JSON model
 * could not express (option GROUPS, many-to-many colour links, variant
 * combinations, bound images).
 *
 * Why an overlay rather than a rewrite of every consumer: the price resolver,
 * the cart, checkout, invoices, returns and the storefront all already speak
 * OptionV2/ColorV2. Feeding them relational data in that shape means one
 * source of truth without a big-bang change to code that is currently correct.
 * The extra structure rides alongside as `relations`, and consumers that
 * understand it (the product page, the admin stock table, validation) use it.
 *
 * A product with NO relational rows falls through to its JSON columns
 * unchanged. That is not a permanent dual path: 0022 gave every product with
 * variants its rows, so the fallback only covers a product that genuinely has
 * neither options nor colours nor images.
 */

import {
  canonicalProductMedia,
  canonicalProductMediaUrl,
  isCanonicalProductMedia,
  type MediaV2,
  type ProductDoc,
} from './productModel';
import type {
  ColorV2,
  OptionFulfillment,
  OptionV2,
  PhysicalDimensionOverrides,
} from './pricing';
import { parsePhysicalDimensions } from './physicalDimensions';
import {
  liveValues,
  loadProductRelations,
  type ColorLinkRow,
  type ColorRow,
  type OptionFulfillmentRow,
  type OptionGroupRow,
  type OptionTransportRow,
  type OptionValueRow,
} from './productRelations';
import {
  isInventoryMode,
  type CapacitySnapshot,
  type InventoryMode,
  type InventorySnapshot,
} from './inventory';
import {
  availabilityFromName,
  normalizeAvailability,
  variantKeyFrom,
  variantLabelFallback,
} from './availability';

export interface VariantRow extends PhysicalDimensionOverrides {
  id: string;
  product_id: string;
  combo_key: string;
  sku: string | null;
  active: number;
  stock: number | null;
  reserved: number;
  low_stock_threshold: number | null;
  regular_price_iqd: number | null;
  prime_price_iqd: number | null;
  pro_price_iqd: number | null;
  cost_iqd: number | null;
}

export interface ImageRow {
  id: string;
  product_id: string;
  url: string;
  alt_en: string;
  sort_order: number;
  is_primary: number;
  option_value_id: string | null;
  color_id: string | null;
  variant_id: string | null;
  width: number | null;
  height: number | null;
  // ---- 0048 ------------------------------------------------------------
  // Optional in the TYPE because a Worker deployed before the migration ran
  // reads rows that have no such column; `?? ''` at every use site keeps that
  // deploy READING instead of crashing on undefined. The WRITE side is not
  // survivable — the upsert in adminProductRelations.ts names these columns
  // unconditionally and would fail with "no such column" — which is why the
  // deploy workflow applies migrations BEFORE it publishes the code
  // (.github/workflows/deploy-staging-code.yml, "Apply any pending migrations
  // BEFORE the code that needs them"). A rollback to an older Worker is safe;
  // a deploy that skips its migration is not, and never has been.
  alt_ar?: string | null;
  alt_ckb?: string | null;
  r2_key?: string | null;
  source_url?: string | null;
  /** Recorded by the uploader; carried so a text edit does not erase it. */
  content_type?: string | null;
  bytes?: number | null;
  /** 0099. Quarantined rows are provenance, never display media. */
  quarantined?: number | boolean | null;
  quarantine_reason?: string | null;
}

/**
 * Only a canonical, explicitly active row can enter a product projection.
 * `quarantined` is an additional deny bit, never an allow bit: an old worker
 * may have written a malformed row without it, so canonical URL/key checks
 * still apply independently.
 */
export function isActiveProductImageRow(row: ImageRow | Record<string, unknown>): boolean {
  const marked = row.quarantined === 1 || row.quarantined === true;
  return !marked && isCanonicalProductMedia(row);
}

/** The cross-field invariant required before a quarantine row may be echoed
 * through the admin repair protocol. */
export function isValidProductImageQuarantine(row: ImageRow | Record<string, unknown>): boolean {
  const marked = row.quarantined === 1 || row.quarantined === true;
  return marked && String(row.url ?? '').trim() === '' &&
    String(row.r2_key ?? '').trim() === '' && String(row.source_url ?? '').trim() !== '';
}

export interface ProductRelationsView {
  has_relations: boolean;
  /** True even when every image row is quarantined. It suppresses fallback to
   * stale `products.images` JSON without exposing the quarantined rows. */
  has_image_rows?: boolean;
  inventory_mode: InventoryMode;
  groups: OptionGroupRow[];
  values: OptionValueRow[];
  colors: ColorRow[];
  links: ColorLinkRow[];
  variants: VariantRow[];
  images: ImageRow[];
  /** 0073. The (model x order type) and (model x route) cells. */
  fulfillments: OptionFulfillmentRow[];
  transports: OptionTransportRow[];
}

export const EMPTY_RELATIONS: ProductRelationsView = {
  has_relations: false,
  has_image_rows: false,
  inventory_mode: 'BASE',
  groups: [],
  values: [],
  colors: [],
  links: [],
  variants: [],
  images: [],
  fulfillments: [],
  transports: [],
};

/**
 * THE OVERLAY MUST NEVER TAKE THE CATALOGUE DOWN.
 *
 * These tables ENRICH a product with its options, colours and images; the
 * product itself is complete without them, in its own row. So a read that
 * fails here degrades to "no relations" and the storefront renders from the
 * legacy JSON columns, rather than turning one failed query into a 500 for
 * every product on the site.
 *
 * This is not theoretical. On 2026-08-30 the live worker was running code
 * that reads these tables against a database still migrated to 0012, and
 * every product listing answered 500 with
 * `D1_ERROR: no such table: product_option_groups` while the product rows
 * themselves were perfectly fine. A deploy will always be able to land before
 * its migration — the window may be seconds or, as here, days — and the
 * storefront has to survive it.
 *
 * The error is logged, once per read, so the gap is visible in the worker log
 * instead of silently pretending the products have no options.
 */
async function softAll<T>(
  label: string,
  run: () => Promise<{ results: T[] }>
): Promise<T[]> {
  try {
    return (await run()).results;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`product relations unavailable (${label}): ${msg}`);
    return [];
  }
}

/** True when the failure is specifically "the relational tables are not there
 *  yet" — worth distinguishing in a log from a genuine query bug. */
export function isMissingRelationTable(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /no such table/i.test(msg);
}

/** Loads everything relational for one product in four batched reads. */
export async function loadRelationsView(
  db: D1Database,
  productId: string,
  inventoryMode: unknown
): Promise<ProductRelationsView> {
  const [rel, variants, images] = await Promise.all([
    loadProductRelations(db, productId).catch((e) => {
      console.error(
        `product relations unavailable (one product ${productId}): ${e instanceof Error ? e.message : String(e)}`
      );
      return { groups: [], values: [], colors: [], links: [], fulfillments: [], transports: [] };
    }),
    softAll<VariantRow>('variants', () =>
      db
        .prepare('SELECT * FROM product_variants WHERE product_id = ? ORDER BY combo_key')
        .bind(productId)
        .all<VariantRow>()
    ),
    softAll<ImageRow>('images', () =>
      db
        .prepare('SELECT * FROM product_images WHERE product_id = ? ORDER BY sort_order, id')
        .bind(productId)
        .all<ImageRow>()
    ),
  ]);
  const activeImages = images.filter(isActiveProductImageRow);
  const has =
    rel.groups.length > 0 || rel.values.length > 0 || rel.colors.length > 0 || images.length > 0;
  return {
    has_relations: has,
    has_image_rows: images.length > 0,
    inventory_mode: isInventoryMode(inventoryMode) ? inventoryMode : 'BASE',
    groups: rel.groups,
    // A row merged into another model by 0073 is history, not a model. It is
    // filtered HERE, once, so no consumer has to remember.
    values: liveValues(rel.values),
    colors: rel.colors,
    links: rel.links,
    variants,
    images: activeImages,
    fulfillments: rel.fulfillments,
    transports: rel.transports,
  };
}

/** Same, for a page of products, without N+1 queries. */
export async function loadRelationsViews(
  db: D1Database,
  rows: Array<{ id: string; inventory_mode?: unknown }>
): Promise<Map<string, ProductRelationsView>> {
  const out = new Map<string, ProductRelationsView>();
  if (rows.length === 0) return out;
  const ids = rows.map((r) => r.id);
  const ph = ids.map(() => '?').join(', ');

  const [groups, values, colors, links, variants, images, fulfillments, optionTransports] = await Promise.all([
    softAll<OptionGroupRow>('groups', () =>
      db.prepare(`SELECT * FROM product_option_groups WHERE product_id IN (${ph}) ORDER BY sort, name_en`).bind(...ids).all<OptionGroupRow>()
    ),
    // Group by group, then value sort — the same order loadProductRelations
    // reads, so a listing and a product page never disagree about it.
    softAll<OptionValueRow>('values', () =>
      db
        .prepare(
          `SELECT v.* FROM product_option_values v
             LEFT JOIN product_option_groups g ON g.id = v.group_id
            WHERE v.product_id IN (${ph})
            ORDER BY COALESCE(g.sort, 0), COALESCE(g.name_en, ''), v.sort, v.name_en`
        )
        .bind(...ids)
        .all<OptionValueRow>()
    ),
    softAll<ColorRow>('colors', () =>
      db.prepare(`SELECT * FROM product_colors WHERE product_id IN (${ph}) ORDER BY sort, name_en`).bind(...ids).all<ColorRow>()
    ),
    softAll<ColorLinkRow & { product_id: string }>('links', () =>
      db
        .prepare(
          `SELECT c.product_id, l.color_id, l.option_value_id, l.group_id
             FROM product_color_option_links l
             JOIN product_colors c ON c.id = l.color_id
            WHERE c.product_id IN (${ph})`
        )
        .bind(...ids)
        .all<ColorLinkRow & { product_id: string }>()
    ),
    softAll<VariantRow>('variants', () =>
      db.prepare(`SELECT * FROM product_variants WHERE product_id IN (${ph}) ORDER BY combo_key`).bind(...ids).all<VariantRow>()
    ),
    softAll<ImageRow>('images', () =>
      db.prepare(`SELECT * FROM product_images WHERE product_id IN (${ph}) ORDER BY sort_order, id`).bind(...ids).all<ImageRow>()
    ),
    softAll<OptionFulfillmentRow>('fulfillments', () =>
      db
        .prepare(`SELECT * FROM product_option_fulfillment WHERE product_id IN (${ph}) ORDER BY sort, id`)
        .bind(...ids)
        .all<OptionFulfillmentRow>()
    ),
    softAll<OptionTransportRow>('option transports', () =>
      db
        .prepare(`SELECT * FROM product_option_transports WHERE product_id IN (${ph}) ORDER BY sort, id`)
        .bind(...ids)
        .all<OptionTransportRow>()
    ),
  ]);

  const bucket = <T extends { product_id: string }>(list: T[]) => {
    const m = new Map<string, T[]>();
    for (const x of list) {
      const arr = m.get(x.product_id);
      if (arr) arr.push(x);
      else m.set(x.product_id, [x]);
    }
    return m;
  };
  const g = bucket(groups);
  const v = bucket(values);
  const c = bucket(colors);
  const l = bucket(links);
  const vr = bucket(variants);
  const im = bucket(images);
  const fl = bucket(fulfillments);
  const ot = bucket(optionTransports);

  for (const row of rows) {
    const gs = g.get(row.id) ?? [];
    const vs = liveValues(v.get(row.id) ?? []);
    const cs = c.get(row.id) ?? [];
    const storedImages = im.get(row.id) ?? [];
    const ims = storedImages.filter(isActiveProductImageRow);
    out.set(row.id, {
      has_relations: gs.length > 0 || vs.length > 0 || cs.length > 0 || storedImages.length > 0,
      has_image_rows: storedImages.length > 0,
      inventory_mode: isInventoryMode(row.inventory_mode) ? row.inventory_mode : 'BASE',
      groups: gs,
      values: vs,
      colors: cs,
      links: (l.get(row.id) ?? []).map(({ color_id, option_value_id, group_id }) => ({
        color_id,
        option_value_id,
        group_id,
      })),
      variants: vr.get(row.id) ?? [],
      images: ims,
      fulfillments: fl.get(row.id) ?? [],
      transports: ot.get(row.id) ?? [],
    });
  }
  return out;
}

const truthy = (v: number | boolean) => v !== 0 && v !== false;

/** The stored name in a language, or the English one when none was authored. */
export const authoredName = (stored: string | null | undefined, english: string): string =>
  typeof stored === 'string' && stored.trim() !== '' ? stored : english;

/**
 * Projects relational rows into the OptionV2/ColorV2 shapes the price resolver
 * and every existing consumer already understand.
 *
 * The ar/ckb name slots carry the AUTHORED name when the row has one (0055 —
 * a TXT template can state `options.N.name_ar`) and fall back to the English
 * name otherwise: §7 defines option and colour names as English-only in the
 * form, and copying rather than blanking means a locale-aware caller still
 * gets a readable label. The fallback is display-only; nothing is stored.
 *
 * `option_id` on a colour is filled ONLY when the colour links to exactly one
 * option value — that is the one case the old single-link field can express
 * faithfully. Richer link sets leave it null and are enforced through
 * validateSelection instead, so the old field can never claim a constraint
 * narrower or wider than the real one.
 */
export interface OverlayOpts {
  /**
   * Show rows the storefront must not see.
   *
   * The customer-facing overlay drops inactive options and colours and reports
   * `active: true` for the survivors, which is right for a shop page. It is
   * wrong for the ADMIN export: an option the owner switched off then vanishes
   * from the .txt, so «ويفعل الخيارات» — re-enable the options by editing the
   * file — is impossible, and re-importing that file would delete the
   * disabled rows outright. Admin readers pass true and get every row with its
   * REAL active flag.
   */
  includeInactive?: boolean;
  /**
   * Arabic and Kurdish names AS STORED — '' when none was authored — instead
   * of the English display fallback. The storefront wants the fallback (a
   * readable label); the admin document, the TXT export and the read-back
   * verification want the truth, because the fallback exported and
   * re-imported would be stored as an authored Kurdish name that nobody wrote.
   */
  authoredNames?: boolean;
}

export function applyRelations(
  doc: ProductDoc,
  view: ProductRelationsView,
  opts: OverlayOpts = {}
): ProductDoc {
  if (!view.has_relations) return doc;
  const showAll = opts.includeInactive === true;
  const nameIn = (stored: string | null | undefined, english: string): string =>
    opts.authoredNames ? (typeof stored === 'string' ? stored : '') : authoredName(stored, english);
  const groupNameById = new Map(view.groups.map((g) => [g.id, g.name_en]));
  const hasGroupRows = view.groups.length > 0;
  const activeGroupIds = new Set(
    view.groups.filter((group) => truthy(group.active)).map((group) => group.id)
  );

  /**
   * 0073. THE MODEL'S OWN CELLS, indexed by the option they belong to.
   *
   * A disabled cell is CARRIED, not dropped — the resolver has to be able to
   * say FULFILLMENT_DISABLED rather than quietly falling through to the
   * product's fallback price, and the admin form needs to show the row it
   * switched off. Whether a cell prices anything is the resolver's decision;
   * whether it exists is this one's.
   */
  // Read DEFENSIVELY even though the type says required. This is the same
  // rolling-deploy argument the whole overlay is built on: a view assembled by
  // code that predates 0073 — a cached object, a caller not yet rebuilt, a
  // fixture — simply has no such key, and an enrichment must never be the
  // thing that throws on a storefront read.
  const viewFulfillments = view.fulfillments ?? [];
  const viewTransports = view.transports ?? [];
  const transportsByFulfillment = new Map<string, OptionTransportRow[]>();
  for (const t of viewTransports) {
    const arr = transportsByFulfillment.get(t.fulfillment_id);
    if (arr) arr.push(t);
    else transportsByFulfillment.set(t.fulfillment_id, [t]);
  }
  const cellsByOption = new Map<string, OptionFulfillment[]>();
  for (const f of viewFulfillments) {
    const type = f.fulfillment_type === 'pre_order' ? 'pre_order' : 'direct_sale';
    const cell: OptionFulfillment = {
      fulfillment_type: type,
      enabled: truthy(f.enabled),
      regular_price_iqd: f.regular_price_iqd,
      prime_price_iqd: f.prime_price_iqd,
      pro_price_iqd: f.pro_price_iqd,
      cost_iqd: f.cost_iqd,
      regular_adjust_iqd: f.regular_adjust_iqd ?? null,
      prime_adjust_iqd: f.prime_adjust_iqd ?? null,
      pro_adjust_iqd: f.pro_adjust_iqd ?? null,
      cost_adjust_iqd: f.cost_adjust_iqd ?? null,
      lead_time_text: f.lead_time_text ?? '',
      lead_time_text_ar: f.lead_time_text_ar ?? '',
      lead_time_text_ckb: f.lead_time_text_ckb ?? '',
      lead_time_min_days: f.lead_time_min_days ?? null,
      lead_time_max_days: f.lead_time_max_days ?? null,
      // 0075. The pre-order pool, carried so the admin surfaces and the TXT
      // export can state it. `?? null` is the ROLLING-DEPLOY default (the
      // column may be absent from a cached view), never a reading of 0:
      // null is UNTRACKED and 0 is tracked-and-empty. A direct cell's stray
      // value is inert — the resolver never reads it.
      capacity: type === 'pre_order' ? (f.capacity ?? null) : null,
      // A direct sale has no route, so its transports are never read; carrying
      // them anyway would let a stray row price a line that has no journey.
      transports:
        type === 'pre_order'
          ? (transportsByFulfillment.get(f.id) ?? []).map((t) => ({
              method: t.method === 'air' || t.method === 'sea' ? t.method : 'land',
              enabled: truthy(t.enabled),
              surcharge_iqd: t.surcharge_iqd,
              // null = this route draws on the cell's shared pool above.
              capacity: t.capacity ?? null,
              regular_price_iqd: t.regular_price_iqd,
              prime_price_iqd: t.prime_price_iqd,
              pro_price_iqd: t.pro_price_iqd,
              cost_iqd: t.cost_iqd,
              regular_adjust_iqd: t.regular_adjust_iqd ?? null,
              prime_adjust_iqd: t.prime_adjust_iqd ?? null,
              pro_adjust_iqd: t.pro_adjust_iqd ?? null,
              cost_adjust_iqd: t.cost_adjust_iqd ?? null,
              lead_time_text: t.lead_time_text ?? '',
              lead_time_text_ar: t.lead_time_text_ar ?? '',
              lead_time_text_ckb: t.lead_time_text_ckb ?? '',
              lead_time_min_days: t.lead_time_min_days ?? null,
              lead_time_max_days: t.lead_time_max_days ?? null,
            }))
          : [],
    };
    const arr = cellsByOption.get(f.option_id);
    if (arr) arr.push(cell);
    else cellsByOption.set(f.option_id, [cell]);
  }

  const options: OptionV2[] = view.values
    .filter(
      (v) =>
        showAll ||
        (truthy(v.active) && (!hasGroupRows || activeGroupIds.has(v.group_id)))
    )
    .map((v) => ({
      id: v.id,
      name_ar: nameIn(v.name_ar, v.name_en),
      name_en: v.name_en,
      name_ckb: nameIn(v.name_ckb, v.name_en),
      image: canonicalProductMediaUrl(v.image),
      order: v.sort,
      active: showAll ? truthy(v.active) : true,
      ...parsePhysicalDimensions(v as unknown as Record<string, unknown>),
      group_en: groupNameById.get(v.group_id) ?? '',
      sku_part: v.sku_part ?? '',
      low_stock_threshold: v.low_stock_threshold ?? null,
      regular_price_iqd: v.regular_price_iqd,
      prime_price_iqd: v.prime_price_iqd,
      pro_price_iqd: v.pro_price_iqd,
      cost_iqd: v.cost_iqd,
      // 0044. Adjustments travel with the row so the central resolver applies
      // them; an old row has NULL in all four and resolves exactly as before.
      regular_adjust_iqd: v.regular_adjust_iqd ?? null,
      prime_adjust_iqd: v.prime_adjust_iqd ?? null,
      pro_adjust_iqd: v.pro_adjust_iqd ?? null,
      cost_adjust_iqd: v.cost_adjust_iqd ?? null,
      // 0043. The label falls back to the option's own name so a row written
      // before variant_key existed still names its model; the KEY falls back
      // to that label's slug rather than to name parsing, so grouping is
      // stable even for a legacy row.
      availability_type: normalizeAvailability(v.availability_type) || availabilityFromName(v.name_en),
      lead_time_text: v.lead_time_text ?? '',
      lead_time_text_ar: v.lead_time_text_ar ?? '',
      lead_time_text_ckb: v.lead_time_text_ckb ?? '',
      lead_time_min_days: v.lead_time_min_days ?? null,
      lead_time_max_days: v.lead_time_max_days ?? null,
      variant_label: (v.variant_label ?? '').trim() || variantLabelFallback(v.name_en),
      variant_key:
        (v.variant_key ?? '').trim() ||
        variantKeyFrom((v.variant_label ?? '').trim() || variantLabelFallback(v.name_en)),
      // 0073. Empty on a model that has not been given order types, which is
      // every model written before the migration — and which resolves exactly
      // as it always did, through `availability_type` above.
      fulfillments: cellsByOption.get(v.id) ?? [],
      merged_into: (v.merged_into ?? '').trim(),
      stock: v.stock,
    }));

  const linksByColor = new Map<string, string[]>();
  for (const l of view.links) {
    const arr = linksByColor.get(l.color_id);
    if (arr) arr.push(l.option_value_id);
    else linksByColor.set(l.color_id, [l.option_value_id]);
  }

  const colors: ColorV2[] = view.colors
    .filter((x) => showAll || truthy(x.active))
    .map((x) => {
      const linked = linksByColor.get(x.id) ?? [];
      return {
        id: x.id,
        name_ar: nameIn(x.name_ar, x.name_en),
        name_en: x.name_en,
        name_ckb: nameIn(x.name_ckb, x.name_en),
        hex: x.hex,
        image: canonicalProductMediaUrl(x.image),
        option_id: linked.length === 1 ? linked[0] : null,
        // The FULL link set, which `option_id` can only express when there is
        // exactly one. Admin readers restore the real constraint from this.
        option_ids: linked,
        order: x.sort,
        active: showAll ? truthy(x.active) : true,
        ...parsePhysicalDimensions(x as unknown as Record<string, unknown>),
        stock: x.stock ?? null,
        low_stock_threshold: x.low_stock_threshold ?? null,
        sku_part: x.sku_part ?? '',
        regular_price_iqd: x.regular_price_iqd,
        prime_price_iqd: x.prime_price_iqd,
        pro_price_iqd: x.pro_price_iqd,
        cost_iqd: x.cost_iqd,
        regular_adjust_iqd: x.regular_adjust_iqd ?? null,
        prime_adjust_iqd: x.prime_adjust_iqd ?? null,
        pro_adjust_iqd: x.pro_adjust_iqd ?? null,
        cost_adjust_iqd: x.cost_adjust_iqd ?? null,
      };
    });

  /**
   * A COMPLETE MediaV2, not a near-miss.
   *
   * This used to build an object with `kind` and `media_key` — neither of
   * which MediaV2 has — while missing `key`, `role`, `width`, `height` and
   * `source_url`, and an `as ProductDoc['media']` cast at the return hid the
   * mismatch from the compiler. Every consumer that read one of the absent
   * fields got `undefined`, and the TXT exporter's formatter takes a
   * `string | null`: exporting a product with a relational image crashed the
   * whole export with "Cannot read properties of undefined (reading
   * 'includes')". The cast is gone so the next missing field is a build error
   * rather than a 500.
   *
   * Dimensions, verified object metadata and provenance come from the row.
   * Empty strings remain the honest answer for alt text that was never
   * written, rather than inventing one during the overlay.
   */
  const mediaCandidates: MediaV2[] =
    (view.has_image_rows ?? view.images.length > 0)
      ? view.images.map((i) => ({
          id: i.id,
          url: i.url,
          key: i.r2_key ?? '',
          role: 'gallery' as const,
          alt_ar: i.alt_ar ?? '',
          alt_en: i.alt_en,
          alt_ckb: i.alt_ckb ?? '',
          order: i.sort_order,
          primary: i.is_primary === 1,
          width: i.width,
          height: i.height,
          content_type: i.content_type ?? '',
          bytes: i.bytes ?? null,
          source_url: i.source_url ?? '',
          // WHAT THE PICTURE IS OF. Dropped before 0048 existed, which is why
          // exporting and re-importing unbound every option and colour photo.
          option_value_id: i.option_value_id ?? '',
          color_id: i.color_id ?? '',
          variant_id: i.variant_id ?? '',
        }))
      : doc.media;

  return { ...doc, options, colors, media: canonicalProductMedia(mediaCandidates) };
}

/** The snapshot the inventory engine needs, from an already-loaded view. */
export function snapshotFrom(
  view: ProductRelationsView,
  base: { stock: number | null; reserved: number; low_stock_threshold: number | null }
): InventorySnapshot {
  const activeGroupIds = new Set(
    view.groups.filter((group) => truthy(group.active)).map((group) => group.id)
  );
  return {
    inventory_mode: view.inventory_mode,
    // Keep this separate from `group_ids`: an empty active-group list can
    // mean either true legacy data or relational groups that are all hidden.
    has_group_rows: view.groups.length > 0,
    base,
    option_values: view.values.map((v) => ({
      id: v.id,
      group_id: v.group_id,
      name_en: v.name_en,
      stock: v.stock,
      reserved: v.reserved ?? 0,
      low_stock_threshold: v.low_stock_threshold,
    })),
    colors: view.colors.map((x) => ({
      id: x.id,
      name_en: x.name_en,
      stock: x.stock,
      reserved: x.reserved ?? 0,
      low_stock_threshold: x.low_stock_threshold,
    })),
    variants: view.variants.map((v) => ({
      id: v.id,
      combo_key: v.combo_key,
      stock: v.stock,
      reserved: v.reserved ?? 0,
      low_stock_threshold: v.low_stock_threshold,
      active: truthy(v.active),
    })),
    // An inactive group is not a customer dimension. Keeping it here made
    // availability demand a hidden choice even though publicRelations and
    // validateSelection correctly omit it.
    group_ids: view.groups.filter((g) => activeGroupIds.has(g.id)).map((g) => g.id),
  };
}

/**
 * THE PRE-ORDER COUNTER FOR ONE MODEL (migration 0075), from an already-loaded
 * view — the capacity half of what `snapshotFrom` does for stock.
 *
 * `selected` is the customer's option-value selection. Capacity is configured
 * per (MODEL x pre-order), so the MODEL is the selected value that actually
 * carries a pre-order cell — a multi-group selection names several values and
 * only one of them is the model. There is deliberately no "all models" answer:
 * a product with three models has up to three independent pools, and summing
 * them would be the double count §7 forbids, while taking the largest would
 * promise units of a model the customer did not choose.
 *
 * WHICH SELECTED VALUE IS THE MODEL, AND WHY IT IS NOT "THE FIRST ONE".
 *
 * This used to answer `ids.find(id => a pre_order cell exists for id)`. Two
 * things were wrong with that, and both were reproduced against the real
 * routes:
 *
 *  (a) A selection naming TWO values that each carry a pre-order cell charged
 *      ONE of them and left the other unenforced — four units sold against a
 *      cell whose capacity was 1, which stayed at `capacity_reserved` 0 while
 *      a different cell absorbed all four. Charging only one counter when the
 *      configuration implies two is the same defect as summing them, inverted.
 *  (b) The answer depended on ARRAY ORDER, and the two doors do not agree on
 *      the order: the cart add keeps the client's order, the checkout reads
 *      the canonically sorted list `cart_items.option_value_ids` stores. So
 *      the counter the door validated was not always the counter the sale
 *      consumed.
 *
 * `resolveStock` has no such ambiguity because `products.inventory_mode` names
 * the ONE authoritative row. There is no equivalent column here, so the rule
 * is this, and it is order-independent by construction:
 *
 *   A cell is TRACKED when its own capacity is set, or when any of its routes
 *   holds a quota. Exactly one tracked cell among the selected values is THE
 *   counter. More than one is an UNMODELLED CONFIGURATION and is REFUSED
 *   (`conflict`), at the door, with a code — never silently resolved. None
 *   tracked means every candidate answers UNTRACKED, so they are interchange-
 *   able and the lowest `option_id` is taken purely to keep `scope_id` stable
 *   between the two doors.
 *
 * WHY REFUSE RATHER THAN CHARGE THEM ALL. Charging every tracked cell the
 * selection names is two counters for one sale: `planOrderDeduction` and the
 * release path are built on ONE target per line with one `idempotency_key`,
 * so "exactly once" would have to be re-derived for a partial failure (one
 * cell full, one not) with no way to express a half-sold line. And it is not
 * what the data means: two pools of units for one physical unit is a
 * catalogue mistake, not a sale.
 *
 * WHY NOT TIE IT TO THE GROUP `inventory_mode` DESIGNATES. `inventory_mode` is
 * `OPTION` for the whole product, not for a group — it names a LEVEL, not
 * which of several groups owns the shelf — so there is no group to inherit,
 * and inventing one would make the pre-order counter depend on a column whose
 * documented meaning is about direct-sale stock.
 *
 * WHAT THIS REFUSES TODAY: NOTHING. `capacity` is NULL on every row in every
 * existing catalogue (migration 0075 adds it NULL and copies nothing into it),
 * so every existing cell is untracked, no selection has two tracked cells, and
 * the answer is byte for byte what it was before.
 *
 * Returns null when nothing is selected, or when no selected model has a
 * pre-order cell — a product from before 0073, or one whose pre-order lives
 * only on the product row. The resolver reads that as UNTRACKED and sells,
 * which is exactly how the shop behaved before this column existed
 * (DECISION 6).
 *
 * A `direct_sale` cell is never consulted here even if some writer put a
 * capacity on it: the direct-sale number is the model's stock, and a capacity
 * on that cell is a payload mistake the parser refuses, not a counter.
 */
export function capacityFrom(
  view: ProductRelationsView,
  selected: string | readonly string[]
): CapacitySnapshot | null {
  const ids = new Set((typeof selected === 'string' ? [selected] : [...selected]).filter(Boolean));
  if (ids.size === 0) return null;
  const cells = view.fulfillments ?? [];
  const allRoutes = view.transports ?? [];
  // Scanning the CELLS and sorting by option id — never scanning the caller's
  // array — is what makes the answer independent of the order the doors pass
  // their selection in. `(option_id, fulfillment_type)` is unique (0073), so
  // this is at most one row per selected value.
  const named = cells
    .filter((f) => f.fulfillment_type === 'pre_order' && ids.has(f.option_id))
    .sort((a, b) => (a.option_id < b.option_id ? -1 : a.option_id > b.option_id ? 1 : 0));
  if (named.length === 0) return null;

  const routesOf = (cellId: string) => allRoutes.filter((t) => t.fulfillment_id === cellId);
  /** Tracked = this cell claims a limit somewhere. `?? null` and NEVER `?? 0`:
   *  an absent column is untracked, not sold out. */
  const isTracked = (f: OptionFulfillmentRow) =>
    (f.capacity ?? null) !== null || routesOf(f.id).some((t) => (t.capacity ?? null) !== null);
  const tracked = named.filter(isTracked);
  const labelOf = (optionId: string) =>
    (view.values ?? []).find((v) => v.id === optionId)?.name_en || optionId;

  if (tracked.length > 1) {
    return {
      cell: null,
      transports: [],
      conflict: {
        option_ids: tracked.map((f) => f.option_id),
        cell_ids: tracked.map((f) => f.id),
        labels: tracked.map((f) => labelOf(f.option_id)),
      },
    };
  }

  const cellRow = tracked[0] ?? named[0];
  const label = labelOf(cellRow.option_id);
  return {
    cell: {
      id: cellRow.id,
      // `?? null` and NOT `?? 0`: a view assembled before 0075 has no such key,
      // and reading the absent column as zero would report every pre-order in
      // the catalogue as sold out.
      capacity: cellRow.capacity ?? null,
      reserved: cellRow.capacity_reserved ?? 0,
      label,
    },
    conflict: null,
    transports: routesOf(cellRow.id).map((t) => ({
      id: t.id,
      method: t.method,
      enabled: truthy(t.enabled),
      capacity: t.capacity ?? null,
      reserved: t.capacity_reserved ?? 0,
      label: `${label} — ${t.method}`,
    })),
  };
}

/**
 * The public shape of the relational structure: groups with their values,
 * colours with their real link lists, modelled combinations and bound images.
 * Cost NEVER crosses this boundary, at any level.
 *
 * `coarse` is §8.2 row 18: for a product in an ACTIVE mystery pool the EXACT
 * `available` is suppressed at option-value and colour level and replaced by a
 * coarse `stock_state`. Publishing exact counts here is the one channel the
 * "use the real inventory" rule creates, and two anonymous GETs around a
 * purchase would otherwise defeat every reveal milestone after `'paid'`
 * deterministically. Admins read the exact counts through
 * `adminRelations`, which this function is not.
 */
export function publicRelations(view: ProductRelationsView, coarse = false) {
  if (!view.has_relations) return null;
  const linksByColor = new Map<string, ColorLinkRow[]>();
  for (const l of view.links) {
    const arr = linksByColor.get(l.color_id);
    if (arr) arr.push(l);
    else linksByColor.set(l.color_id, [l]);
  }
  // What a customer may know about a level's stock: the sellable remainder,
  // never the raw counters. NULL = untracked at that level. Meaningful only
  // when inventory_mode makes that level authoritative — the client gates
  // its chips on the mode this same payload carries.
  const exactAvailable = (stock: number | null, reserved: number | null | undefined) =>
    stock === null ? null : Math.max(0, stock - (reserved ?? 0));
  const availableOf = (stock: number | null, reserved: number | null | undefined) =>
    coarse ? null : exactAvailable(stock, reserved);
  /** in_stock / low / sold_out — the only stock fact a pool member publishes.
   *  `null` when the level is untracked, exactly as `available` would be. */
  const stateOf = (
    stock: number | null,
    reserved: number | null | undefined,
    low: number | null | undefined
  ): string | null => {
    const n = exactAvailable(stock, reserved);
    if (n === null) return null;
    if (n <= 0) return 'sold_out';
    return low !== null && low !== undefined && n <= low ? 'low' : 'in_stock';
  };
  return {
    inventory_mode: view.inventory_mode,
    option_groups: view.groups
      .filter((g) => truthy(g.active))
      .map((g) => ({
        id: g.id,
        name_en: g.name_en,
        sort: g.sort,
        values: view.values
          .filter((v) => v.group_id === g.id && truthy(v.active))
          .map((v) => ({
            id: v.id,
            name_en: v.name_en,
            image: canonicalProductMediaUrl(v.image),
            sort: v.sort,
            ...parsePhysicalDimensions(v as unknown as Record<string, unknown>),
            available: availableOf(v.stock, v.reserved),
            ...(coarse ? { stock_state: stateOf(v.stock, v.reserved, v.low_stock_threshold) } : {}),
            regular_price_iqd: v.regular_price_iqd,
            prime_price_iqd: v.prime_price_iqd,
            pro_price_iqd: v.pro_price_iqd,
          })),
      })),
    colors: view.colors
      .filter((x) => truthy(x.active))
      .map((x) => ({
        id: x.id,
        name_en: x.name_en,
        hex: x.hex,
        image: canonicalProductMediaUrl(x.image),
        sort: x.sort,
        ...parsePhysicalDimensions(x as unknown as Record<string, unknown>),
        // The real many-to-many links, grouped so the client can apply the
        // same OR-within / AND-across rule the server enforces.
        links: (linksByColor.get(x.id) ?? []).map((l) => ({
          group_id: l.group_id,
          option_value_id: l.option_value_id,
        })),
        available: availableOf(x.stock, x.reserved),
        ...(coarse ? { stock_state: stateOf(x.stock, x.reserved, x.low_stock_threshold) } : {}),
        regular_price_iqd: x.regular_price_iqd,
        prime_price_iqd: x.prime_price_iqd,
        pro_price_iqd: x.pro_price_iqd,
      })),
    variants: view.variants
      .filter((v) => truthy(v.active))
      .map((v) => ({
        id: v.id,
        combo_key: v.combo_key,
        ...parsePhysicalDimensions(v as unknown as Record<string, unknown>),
        // Exact option×colour stock is what a direct-sale colour chip needs.
        // As at the other levels, public readers receive only the sellable
        // remainder (or a coarse state for mystery products), never counters.
        available: availableOf(v.stock, v.reserved),
        ...(coarse ? { stock_state: stateOf(v.stock, v.reserved, v.low_stock_threshold) } : {}),
        regular_price_iqd: v.regular_price_iqd,
        prime_price_iqd: v.prime_price_iqd,
        pro_price_iqd: v.pro_price_iqd,
      })),
    images: view.images.filter(isCanonicalProductMedia).map((i) => ({
      id: i.id,
      url: i.url,
      alt_en: i.alt_en,
      sort_order: i.sort_order,
      is_primary: i.is_primary === 1,
      option_value_id: i.option_value_id,
      color_id: i.color_id,
      variant_id: i.variant_id,
      width: i.width,
      height: i.height,
    })),
  };
}
