/**
 * STOCK ALERTS — THE ONE QUESTION: «the shopper wished for THIS; can they buy
 * it now?» (migration 0092, «خبرني لما يرجع»).
 *
 * This module answers that and nothing else. It does not send, it does not
 * write, it does not decide policy. It turns a stored `product_stock_alerts`
 * row into a verdict the sweep can act on and the arm endpoint can refuse
 * with, and it does so by asking the SAME engine the product page and the
 * cart ask — `saleAvailability` in worker/routes/products.ts, which owns
 * `resolveStock`, the colour visibility algebra, the per-model fulfilment
 * cells and the forty-line `directEnabled` derivation. Nothing here
 * re-implements an availability rule; the only thing this file owns is WHICH
 * selections to ask about, and that is a search, not a rule.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT «SELECT stock, COMPARE WITH LAST TIME»
 *
 * Availability is not the `stock` column. It is
 * `max(0, stock - max(0, reserved))` at the ONE level `products.inventory_mode`
 * names, and then gated by whether direct sale is enabled for that exact
 * target. A cancelled order raises availability through a `release` that never
 * touches `stock` at all, and four further edits raise it with no stock write
 * of any kind:
 *
 *   - a value / colour / variant row flipped `active` 0 -> 1
 *   - `products.inventory_mode` repointed at a different level
 *   - a direct-sale cell (`product_option_fulfillment`) re-enabled
 *   - a `product_variants` row CREATED for a combination nobody had modelled
 *
 * A sweep that diffs a column catches none of those. Resolving the wish
 * through `saleAvailability` catches every one of them for free, because each
 * of them changes what that function answers.
 *
 * AND `stock IS NULL` MEANS UNTRACKED, NEVER ZERO. There is no `COALESCE(stock, 0)`
 * anywhere in this file and there must never be one. The sting is that
 * `directUsable` requires `tracked`, so an untracked product shows the shopper
 * the SAME «نفد المخزون» copy as a genuinely empty one while being permanently
 * unarmable — it can never satisfy `tracked && available > 0`. That is why
 * `UNTRACKED` is a dead reason: the arm endpoint refuses honestly instead of
 * arming a promise that can never be kept.
 *
 * ---------------------------------------------------------------------------
 * WHY A PARTIAL SELECTION IS THE WHOLE DESIGN PROBLEM
 *
 * `resolveStock`'s OPTION branch filters the snapshot to the CHOSEN values and
 * takes the minimum over THOSE. A one-value wish on a two-group product
 * therefore never looks at group two. Answering from it would send «رجع موديل
 * A1» to a customer whose product page still refuses to add to cart because
 * every AMS value sits at zero. A message about something you cannot buy is
 * worse than no message at all: this feature has exactly one unit of trust and
 * that spends it.
 *
 * So a wish is never resolved from its own row. It is resolved by looking for
 * a COMPLETE, buyable selection that CONTAINS the wished target — the wish
 * pins one dimension and the search fills every other one from rows that are
 * really active. Only `saleAvailability` ever renders a verdict on a
 * candidate; the walk merely proposes them.
 *
 * ---------------------------------------------------------------------------
 * WHY THE LOADER IS NOT `inventorySnapshot` / `loadRelationsViews`
 *
 * The admin snapshot path costs EIGHT D1 statements per product (one `products`
 * read, six inside `loadProductRelations`, one `product_variants` read), and
 * four of those six read data the stock question never consults — images,
 * option transports, prices, lead times. A 100-product sweep at eight
 * statements each is 800 statements inside a cron that already runs nine other
 * sweeps. `loadAlertContexts` reads the rows it actually needs, batched per
 * TABLE across every product at once with chunked `IN (…)` lists — the pattern
 * `planInventory` uses and states the reason for — so one sweep pass over N
 * products costs
 *
 *     7 x ceil(N / 90)  +  ceil(N / 50)   statements
 *
 * (seven tables at this module's chunk size, plus `activePoolProductIds` at
 * its own documented 50). That is 16 for a hundred products against the admin
 * path's 800, and it stays flat in N up to the first chunk boundary instead of
 * growing with every product the sweep looks at.
 *
 * It also deliberately does NOT filter the rows it loads. A snapshot with the
 * inactive rows dropped cannot tell a DEACTIVATED target from a DELETED one,
 * and `TARGET_INACTIVE` versus `TARGET_REMOVED` is exactly the distinction the
 * shopper is owed («ما عاد نعرضه» is not «ما عاد موجود»). The active flag lives
 * in this module's own maps and is applied by this module's own search.
 */

import { comboKey, type InventorySnapshot } from './inventory';
import { authoredName } from './productOverlay';
import { normalizeComposition, normalizeSaleTypes } from './productModel';
import type { ProductDoc } from './productModel';
import type { ColorLinkRow } from './productRelations';
import type { ColorV2, OptionFulfillment, OptionV2 } from './pricing';
import { availabilityFromName, normalizeAvailability } from './availability';
import { activePoolProductIds } from './mysteryDraw';
import { degradeIfSchemaMissing } from './membershipBenefits';
import { saleAvailability, type SaleAvailability } from '../routes/products';

// ---------------------------------------------------------------- contract

export interface AlertWish {
  kind: 'product' | 'option_value' | 'color' | 'combination';
  /** '' when the wish does not name one — the schema's sentinel, never NULL. */
  option_value_id: string;
  color_id: string;
}

/**
 * WHY AN ALERT CAN NEVER COME TRUE. Every one of these is a REFUSAL the
 * customer is entitled to hear, not a silent skip: an alert that is quietly
 * dropped from the driving set sits armed for its full ninety days while
 * «تنبيهاتي» presents it as live.
 *
 *   NOT_A_STOCK_TARGET    the wish names nothing this catalogue sells from a
 *                         shelf: a malformed target, or a target for which
 *                         neither sale type is offered at all.
 *   VARIANT_NOT_MODELLED  VARIANT_COMBINATION mode, and no `product_variants`
 *                         row joins the wished value and colour. An ARM-time
 *                         refusal only — see `armRefusal`.
 *   TARGET_REMOVED        the row is gone (or was merged away by 0073). Ids
 *                         are never reused, so this is permanent.
 *   TARGET_INACTIVE       the row is there with `active = 0`, or its group is.
 *   PRODUCT_UNAVAILABLE   `products.status` is not 'active' (draft / hidden).
 *   UNTRACKED             the authoritative shelf claims no number, so
 *                         `directUsable` can never be true.
 *   PREORDER_ONLY         direct sale is not enabled FOR THIS TARGET.
 *   COMPOSITION           the product is a bundle / mystery row.
 */
export type AlertDeadReason =
  | 'NOT_A_STOCK_TARGET'
  | 'VARIANT_NOT_MODELLED'
  | 'TARGET_REMOVED'
  | 'TARGET_INACTIVE'
  | 'PRODUCT_UNAVAILABLE'
  | 'UNTRACKED'
  | 'PREORDER_ONLY'
  | 'COMPOSITION';

export interface AlertVerdict {
  /** True only when a COMPLETE selection containing the wish is sellable from
   *  the shelf right now. This is the field the sweep fires on. */
  buyable: boolean;
  /**
   * Units behind that selection, or `null` for «we did not successfully read a
   * quantity» — which migration 0092 says `last_available` means and which is
   * NOT zero. It is null for a mystery-pool member (publishing the count is
   * the oracle §8.2 row 18 forbids), null when no complete selection could be
   * formed at all, and null for every dead verdict.
   *
   * It is NEVER the wished row's own count while `buyable` is false: a number
   * taken from a partial selection is the wrong-message bug in numeric form.
   */
  available: number | null;
  dead: AlertDeadReason | null;
  /** What the message will NAME. Never the stock engine's own `label`, which
   *  is `name_en` for an option and the machine `combo_key` for a variant. */
  label: { ar: string; en: string; ckb: string };
}

export interface AlertProductContext {
  product_id: string;
  slug: string;
  name: { ar: string; en: string; ckb: string };
  /** §8.2 row 18: this product is in an ACTIVE mystery pool, so exact counts
   *  are not publishable and only a product-wide alert is offered. */
  coarse: boolean;
  /* whatever else the resolver needs, kept internal */
  [k: string]: unknown;
}

// ------------------------------------------------------- internal context

/** A colour or option value as this module needs it: the name columns the
 *  message will read, the active flag the snapshot cannot carry, and nothing
 *  else. */
interface TargetRow {
  id: string;
  active: boolean;
  /** For a value: the group it belongs to. '' for a colour. */
  group_id: string;
  label: { ar: string; en: string; ckb: string };
}

/**
 * The half of `AlertProductContext` the contract keeps opaque. It is reached
 * by a single cast in each entry point rather than being exported, because the
 * shape is this module's business and the sweep must not start reading the
 * snapshot for itself — that is how a second, divergent availability rule gets
 * written.
 */
interface LoadedContext extends AlertProductContext {
  status: string;
  composition: string;
  /** Exactly the `AvailabilityDoc` slice `saleAvailability` reads. */
  doc: Pick<ProductDoc, 'selling_type' | 'stock' | 'options' | 'colors' | 'preorder_transports'> & {
    sale_types?: string[];
    composition?: string;
  };
  snapshot: InventorySnapshot;
  links: ColorLinkRow[];
  /** Live values only (0073 tombstones removed), by id. */
  valueById: Map<string, TargetRow>;
  colorById: Map<string, TargetRow>;
  /** Active groups, in catalogue order — the same list as `snapshot.group_ids`. */
  activeGroupIds: string[];
}

// ------------------------------------------------------------------- loader

/**
 * D1 refuses a query with more than 100 bound parameters, so every `IN (…)`
 * list here is cut at 90 — the same margin `productPersistence.ts` documents,
 * leaving room for a trailing bind without a raw driver error standing in for
 * a named refusal.
 */
const IN_CHUNK = 90;

function chunked<T>(xs: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += IN_CHUNK) out.push(xs.slice(i, i + IN_CHUNK));
  return out;
}

const truthy = (v: unknown): boolean => v !== 0 && v !== false && v !== null && v !== undefined;

/**
 * The relational tables ENRICH a product; a failed read of one of them must
 * degrade the sweep, not take the cron down. This is the same argument
 * `softAll` in productOverlay.ts makes, for the same tables, after the same
 * incident: a Worker can reach an edge before its migration reaches D1.
 *
 * A product whose relations failed to load simply resolves from its own row,
 * which for an alert means "not buyable yet" — never a false fire.
 */
async function soft<T>(label: string, run: () => Promise<{ results: T[] }>): Promise<T[]> {
  try {
    return (await run()).results;
  } catch (e) {
    console.error(`stock alert relations unavailable (${label}): ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

interface ProductRow {
  id: string;
  slug: string;
  status: string;
  name: string;
  name_ar: string | null;
  name_ku: string | null;
  selling_type: string;
  sale_types: string;
  composition: string | null;
  inventory_mode: string;
  stock: number | null;
  stock_reserved: number | null;
  low_stock_threshold: number | null;
}

interface GroupRow {
  id: string;
  product_id: string;
  active: number | null;
}

interface ValueRow {
  id: string;
  product_id: string;
  group_id: string;
  name_en: string;
  name_ar: string | null;
  name_ckb: string | null;
  active: number | null;
  stock: number | null;
  reserved: number | null;
  low_stock_threshold: number | null;
  availability_type: string | null;
  merged_into: string | null;
}

interface ColorRowLite {
  id: string;
  product_id: string;
  name_en: string;
  name_ar: string | null;
  name_ckb: string | null;
  active: number | null;
  stock: number | null;
  reserved: number | null;
  low_stock_threshold: number | null;
}

interface VariantRowLite {
  id: string;
  product_id: string;
  combo_key: string;
  active: number | null;
  stock: number | null;
  reserved: number | null;
  low_stock_threshold: number | null;
}

interface FulfillmentRowLite {
  product_id: string;
  option_id: string;
  fulfillment_type: string;
  enabled: number | null;
}

const bucket = <T extends { product_id: string }>(rows: T[]): Map<string, T[]> => {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const arr = m.get(r.product_id);
    if (arr) arr.push(r);
    else m.set(r.product_id, [r]);
  }
  return m;
};

/**
 * EVERYTHING THE RESOLVER NEEDS FOR A PAGE OF PRODUCTS, BATCHED PER TABLE.
 *
 * Seven chunked reads plus the mystery-pool membership read, for ANY number of
 * products — never seven per product. Missing ids simply do not appear in the
 * returned map; the sweep treats an absent context as "this product is gone"
 * and reconciles the alert, which is the same answer `products` returning no
 * row would give.
 *
 * THE COLUMN LISTS ARE NAMED RATHER THAN `SELECT *` because a sweep touches a
 * hundred products' worth of option values and colours at once and the twenty
 * pricing, lead-time and SKU columns on those rows are bytes this question
 * never reads. `low_stock_threshold` IS read, though nothing here consults
 * `low`: the snapshot handed to `saleAvailability` must be a faithful
 * `InventorySnapshot` and not a doctored one, because a doctored snapshot is
 * precisely how the inactive-versus-deleted distinction was lost.
 */
export async function loadAlertContexts(
  db: D1Database,
  productIds: string[]
): Promise<Map<string, AlertProductContext>> {
  const out = new Map<string, AlertProductContext>();
  const ids = [...new Set(productIds)].filter(Boolean);
  if (ids.length === 0) return out;

  const products: ProductRow[] = [];
  const groups: GroupRow[] = [];
  const values: ValueRow[] = [];
  const colors: ColorRowLite[] = [];
  const variants: VariantRowLite[] = [];
  const links: Array<ColorLinkRow & { product_id: string }> = [];
  const cells: FulfillmentRowLite[] = [];

  for (const part of chunked(ids)) {
    const ph = part.map(() => '?').join(', ');
    // The seven reads of one chunk are independent, so they go out together
    // rather than one after another: a sweep pass is latency-bound, not
    // CPU-bound, and D1 counts statements, not round trips.
    const [p, g, v, c, vr, l, f] = await Promise.all([
      // The product row itself is NOT soft. Without it there is no context at
      // all, and pretending a product has no alerts is a silent skip — the
      // very thing PRODUCT_UNAVAILABLE exists to prevent.
      db
        .prepare(
          `SELECT id, slug, status, name, name_ar, name_ku, selling_type, sale_types, composition,
                  inventory_mode, stock, stock_reserved, low_stock_threshold
             FROM products WHERE id IN (${ph})`
        )
        .bind(...part)
        .all<ProductRow>()
        .then((r) => r.results),
      soft<GroupRow>('option groups', () =>
        db
          .prepare(
            `SELECT id, product_id, active FROM product_option_groups
              WHERE product_id IN (${ph}) ORDER BY sort, id`
          )
          .bind(...part)
          .all<GroupRow>()
      ),
      soft<ValueRow>('option values', () =>
        db
          .prepare(
            `SELECT id, product_id, group_id, name_en, name_ar, name_ckb, active, stock, reserved,
                    low_stock_threshold, availability_type, merged_into
               FROM product_option_values WHERE product_id IN (${ph}) ORDER BY sort, id`
          )
          .bind(...part)
          .all<ValueRow>()
      ),
      soft<ColorRowLite>('colors', () =>
        db
          .prepare(
            `SELECT id, product_id, name_en, name_ar, name_ckb, active, stock, reserved,
                    low_stock_threshold
               FROM product_colors WHERE product_id IN (${ph}) ORDER BY sort, id`
          )
          .bind(...part)
          .all<ColorRowLite>()
      ),
      soft<VariantRowLite>('variants', () =>
        db
          .prepare(
            `SELECT id, product_id, combo_key, active, stock, reserved, low_stock_threshold
               FROM product_variants WHERE product_id IN (${ph}) ORDER BY combo_key`
          )
          .bind(...part)
          .all<VariantRowLite>()
      ),
      soft<ColorLinkRow & { product_id: string }>('color links', () =>
        db
          .prepare(
            `SELECT c.product_id, l.color_id, l.option_value_id, l.group_id
               FROM product_color_option_links l
               JOIN product_colors c ON c.id = l.color_id
              WHERE c.product_id IN (${ph})`
          )
          .bind(...part)
          .all<ColorLinkRow & { product_id: string }>()
      ),
      // 0073's (model x order type) cells. WITHOUT THESE THE DIRECT-SALE GATE
      // IS A PRODUCT-LEVEL GUESS, which is trap 5 exactly: a product offering
      // both sale types passes a product-level gate while the wished model is
      // pre-order only and has no shelf at all.
      soft<FulfillmentRowLite>('fulfillment cells', () =>
        db
          .prepare(
            `SELECT product_id, option_id, fulfillment_type, enabled
               FROM product_option_fulfillment WHERE product_id IN (${ph}) ORDER BY sort, id`
          )
          .bind(...part)
          .all<FulfillmentRowLite>()
      ),
    ]);
    products.push(...p);
    groups.push(...g);
    values.push(...v);
    colors.push(...c);
    variants.push(...vr);
    links.push(...l);
    cells.push(...f);
  }

  /**
   * §8.2 row 18. `activePoolProductIds` is the single authority on pool
   * membership and chunks its own `IN (…)` list at its own documented 50; this
   * module does not second-guess another module's chunk size. Missing 0061
   * degrades to "no pools", which is the honest answer when the feature is not
   * installed — and the conservative one, since it only ever ENABLES a finer
   * alert on a shop that has no pools to leak.
   */
  const pooled = await degradeIfSchemaMissing(
    'mystery pools (migration 0061)',
    () => activePoolProductIds(db, ids),
    new Set<string>()
  );

  const groupsBy = bucket(groups);
  const valuesBy = bucket(values);
  const colorsBy = bucket(colors);
  const variantsBy = bucket(variants);
  const linksBy = bucket(links);
  const cellsBy = bucket(cells);

  for (const row of products) {
    out.set(row.id, buildContext(row, {
      groups: groupsBy.get(row.id) ?? [],
      values: valuesBy.get(row.id) ?? [],
      colors: colorsBy.get(row.id) ?? [],
      variants: variantsBy.get(row.id) ?? [],
      links: linksBy.get(row.id) ?? [],
      cells: cellsBy.get(row.id) ?? [],
      coarse: pooled.has(row.id),
    }));
  }
  return out;
}

function buildContext(
  row: ProductRow,
  rel: {
    groups: GroupRow[];
    values: ValueRow[];
    colors: ColorRowLite[];
    variants: VariantRowLite[];
    links: Array<ColorLinkRow & { product_id: string }>;
    cells: FulfillmentRowLite[];
    coarse: boolean;
  }
): LoadedContext {
  const activeGroupIds = rel.groups.filter((g) => truthy(g.active)).map((g) => g.id);
  const activeGroupSet = new Set(activeGroupIds);

  // 0073 TOMBSTONES ARE NOT MODELS. A row merged into another carries
  // `merged_into` and is history; `liveValues` drops it for every other reader
  // and it is dropped here too, so a wish aimed at one answers TARGET_REMOVED
  // — which is what a merge did to it.
  const live = rel.values.filter((v) => !String(v.merged_into ?? '').trim());

  const cellsByOption = new Map<string, OptionFulfillment[]>();
  for (const f of rel.cells) {
    const type = f.fulfillment_type === 'pre_order' ? 'pre_order' : 'direct_sale';
    // Only `fulfillment_type` and `enabled` are read by the gate. The price
    // and lead-time fields are null because they are never consulted here and
    // reading them would be a hundred products' worth of bytes for nothing;
    // this doc is internal to this module and never prices anything.
    const cell: OptionFulfillment = {
      fulfillment_type: type,
      enabled: truthy(f.enabled),
      regular_price_iqd: null,
      prime_price_iqd: null,
      pro_price_iqd: null,
      cost_iqd: null,
      // A pre-order cell's ROUTES are deliberately not loaded. They decide
      // `preorder.usable`, and this module never reads it: the only pre-order
      // question an alert asks is the GATE — "is direct sale enabled for this
      // target" — which `saleAvailability` answers from the cells alone.
      transports: [],
    };
    const arr = cellsByOption.get(f.option_id);
    if (arr) arr.push(cell);
    else cellsByOption.set(f.option_id, [cell]);
  }

  const options: OptionV2[] = live.map((v) => ({
    id: v.id,
    name_ar: authoredName(v.name_ar, v.name_en),
    name_en: v.name_en,
    name_ckb: authoredName(v.name_ckb, v.name_en),
    image: '',
    order: 0,
    // THE REAL FLAG, not the storefront overlay's `true`. `saleAvailability`
    // needs it to tell OPTION_INACTIVE from OPTION_NOT_FOUND, and this module
    // needs it to tell TARGET_INACTIVE from TARGET_REMOVED. The GROUP's own
    // active flag is applied by the snapshot's `group_ids`, exactly as the
    // storefront overlay does it — folding it in here would report a value in
    // a hidden group as a value that does not exist.
    active: truthy(v.active),
    // 0043's legacy declaration, INCLUDING the name-derived fallback, because
    // a value literally named «طلب مسبق» on a product written before the cells
    // existed is still an explicit pre-order declaration and trap 5 turns on
    // exactly that.
    availability_type: normalizeAvailability(v.availability_type) || availabilityFromName(v.name_en),
    fulfillments: cellsByOption.get(v.id) ?? [],
    stock: v.stock,
    regular_price_iqd: null,
    prime_price_iqd: null,
    pro_price_iqd: null,
    cost_iqd: null,
  }));

  const linksByColor = new Map<string, string[]>();
  for (const l of rel.links) {
    const arr = linksByColor.get(l.color_id);
    if (arr) arr.push(l.option_value_id);
    else linksByColor.set(l.color_id, [l.option_value_id]);
  }

  const colors: ColorV2[] = rel.colors.map((c) => {
    const linked = linksByColor.get(c.id) ?? [];
    return {
      id: c.id,
      name_ar: authoredName(c.name_ar, c.name_en),
      name_en: c.name_en,
      name_ckb: authoredName(c.name_ckb, c.name_en),
      hex: '',
      image: '',
      // Filled only for a single link, exactly as `applyRelations` does: it is
      // the one constraint the legacy field can state faithfully, and it is
      // the fallback `saleAvailability` uses when no link rows exist at all.
      option_id: linked.length === 1 ? linked[0] : null,
      option_ids: linked,
      order: 0,
      active: truthy(c.active),
      stock: c.stock ?? null,
      regular_price_iqd: null,
      prime_price_iqd: null,
      pro_price_iqd: null,
      cost_iqd: null,
    };
  });

  const snapshot: InventorySnapshot = {
    inventory_mode:
      row.inventory_mode === 'OPTION' || row.inventory_mode === 'COLOR' || row.inventory_mode === 'VARIANT_COMBINATION'
        ? row.inventory_mode
        : 'BASE',
    // `group_ids: []` is ambiguous on its own — it is both a legacy flat
    // chooser and a product whose every relational group is hidden. This
    // marker is what keeps the second from resurrecting values from the first.
    has_group_rows: rel.groups.length > 0,
    base: {
      stock: row.stock,
      reserved: Number(row.stock_reserved ?? 0),
      low_stock_threshold: row.low_stock_threshold ?? null,
    },
    option_values: live.map((v) => ({
      id: v.id,
      group_id: v.group_id,
      name_en: v.name_en,
      stock: v.stock,
      reserved: v.reserved ?? 0,
      low_stock_threshold: v.low_stock_threshold ?? null,
    })),
    colors: rel.colors.map((c) => ({
      id: c.id,
      name_en: c.name_en,
      stock: c.stock,
      reserved: c.reserved ?? 0,
      low_stock_threshold: c.low_stock_threshold ?? null,
    })),
    variants: rel.variants.map((v) => ({
      id: v.id,
      combo_key: v.combo_key,
      stock: v.stock,
      reserved: v.reserved ?? 0,
      low_stock_threshold: v.low_stock_threshold ?? null,
      active: truthy(v.active),
    })),
    group_ids: activeGroupIds,
  };

  const valueById = new Map<string, TargetRow>();
  for (const v of live) {
    valueById.set(v.id, {
      id: v.id,
      // A value inside a hidden group is not selectable, and the customer is
      // owed TARGET_INACTIVE for it rather than a verdict that never resolves.
      active: truthy(v.active) && (rel.groups.length === 0 || activeGroupSet.has(v.group_id)),
      group_id: v.group_id,
      label: {
        ar: authoredName(v.name_ar, v.name_en),
        en: v.name_en || authoredName(v.name_ar, ''),
        ckb: authoredName(v.name_ckb, v.name_en),
      },
    });
  }
  const colorById = new Map<string, TargetRow>();
  for (const c of rel.colors) {
    colorById.set(c.id, {
      id: c.id,
      active: truthy(c.active),
      group_id: '',
      label: {
        ar: authoredName(c.name_ar, c.name_en),
        en: c.name_en || authoredName(c.name_ar, ''),
        ckb: authoredName(c.name_ckb, c.name_en),
      },
    });
  }

  const composition = normalizeComposition(row.composition);
  return {
    product_id: row.id,
    slug: row.slug,
    name: {
      ar: row.name_ar || row.name,
      en: row.name || row.name_ar || '',
      ckb: row.name_ku || row.name_ar || row.name,
    },
    coarse: rel.coarse,
    status: row.status,
    composition,
    doc: {
      selling_type:
        row.selling_type === 'pre_order' || row.selling_type === 'bundle' ? row.selling_type : 'direct_sale',
      sale_types: normalizeSaleTypes(row.sale_types, String(row.selling_type ?? 'direct_sale')),
      composition,
      stock: row.stock,
      options,
      colors,
      // Never read: pre-order ROUTES decide `preorder.usable`, and the only
      // pre-order question here is the gate. Stated as empty rather than
      // loaded so nobody later mistakes this doc for a priceable one.
      preorder_transports: [],
    },
    snapshot,
    links: rel.links.map(({ color_id, option_value_id, group_id }) => ({ color_id, option_value_id, group_id })),
    valueById,
    colorById,
    activeGroupIds,
  };
}

// ------------------------------------------------------------ the search

/**
 * Product data is admin-authored, but an accidental 12x12x12x12 option matrix
 * must not turn one alert into twenty thousand availability resolutions inside
 * a cron. The walk fails CLOSED at this cap — "not buyable yet", never a fire
 * — so the worst case is a notification one sweep late, not a wrong one. It is
 * the same budget and the same reasoning `firstUsableDirectSelection` and
 * `directStockAvailable` already use on the storefront's hot path.
 */
const WITNESS_EVALUATION_CAP = 512;

interface SearchState {
  budget: number;
  /** The first COMPLETE selection the engine proved is sellable now. */
  hit: SaleAvailability | null;
  /** At least one complete selection was judged at all. */
  sawComplete: boolean;
  /** A complete selection resolved to a shelf that carries a number … */
  sawTracked: boolean;
  /** … or to one that claims none. */
  sawUntracked: boolean;
}

/** Strict token parse of a `combo_key`. NEVER a substring match: `indexOf`
 *  against an id would let «A1 mini + black» be satisfied by «A1 max + black»,
 *  which is a different and more expensive machine. */
function parseCombo(raw: unknown): { optionValueIds: string[]; colorId: string | null } | null {
  const optionValueIds: string[] = [];
  let colorId: string | null = null;
  for (const token of String(raw ?? '').split('|')) {
    if (!token) continue;
    if (token.startsWith('o:')) {
      const id = token.slice(2);
      if (!id || optionValueIds.includes(id)) return null;
      optionValueIds.push(id);
      continue;
    }
    if (token.startsWith('c:')) {
      const id = token.slice(2);
      if (!id || colorId !== null) return null;
      colorId = id;
      continue;
    }
    return null;
  }
  return optionValueIds.length === 0 && colorId === null ? null : { optionValueIds, colorId };
}

/**
 * ONE CANDIDATE, JUDGED BY THE ENGINE AND BY NOTHING ELSE.
 *
 * `selection.complete` is the engine's own completeness rule (one value per
 * required group, colour present when a visible colour exists, colour visible
 * for this tuple). `modes` carries the per-target direct-sale gate. `stock`
 * carries `resolveStock`'s verdict at the authoritative level. This function
 * re-derives none of the three; it records them.
 */
function evaluate(
  ctx: LoadedContext,
  state: SearchState,
  optionValueIds: string[],
  colorId: string | null,
  inventory?: InventorySnapshot
): void {
  if (state.hit || state.budget <= 0) return;
  state.budget -= 1;
  const a = saleAvailability(ctx.doc, {
    optionValueIds,
    colorId,
    inventory: inventory ?? ctx.snapshot,
    links: ctx.links,
    coarseStock: ctx.coarse,
    preferredType: 'direct_sale',
  });
  if (!a.selection.complete) return;
  state.sawComplete = true;
  if (a.stock.tracked) state.sawTracked = true;
  else state.sawUntracked = true;
  const direct = a.modes.find((m) => m.type === 'direct_sale');
  if (direct?.usable) state.hit = a;
}

/**
 * IS THERE A COMPLETE SELECTION, CONTAINING THE WISH, THAT CAN BE BOUGHT?
 *
 * The wish PINS a dimension and the walk fills the rest. An option-value wish
 * pins its group to that one value, so the walk is forced to prove that every
 * OTHER group still has an active value that works — which is the whole of
 * trap 3: a one-value wish must never be answered from a minimum taken over
 * that one value alone. A colour wish pins the colour, a combination wish pins
 * both, and a product wish pins nothing, which is the any-of-set behaviour a
 * shopper who asked for «أي خيار» actually asked for.
 *
 * VARIANT_COMBINATION MODE IS NOT A MAXIMUM OVER VARIANTS. Taking the largest
 * variant carrying the wished colour reproduces the very defect the pin
 * exists to prevent: a shopper watching «A1 mini + أسود» would be told the
 * colour is back because «A1 max + أسود» restocked. So the walk iterates the
 * MODELLED ROWS, reconstructs each one's real Selection from its tokens, and
 * hands that Selection to the engine — `resolveStock` then answers about that
 * exact row and no other.
 */
function search(ctx: LoadedContext, pinValue: string, pinColor: string): SearchState {
  const state: SearchState = {
    budget: WITNESS_EVALUATION_CAP,
    hit: null,
    sawComplete: false,
    sawTracked: false,
    sawUntracked: false,
  };
  const snap = ctx.snapshot;

  /**
   * EVERY RELATIONAL GROUP IS HIDDEN. There is no chooser, so there is no
   * selection to judge and the empty one would resolve UNTRACKED and get the
   * alert killed. Showing a group again is a no-stock-write restock path, so
   * this is "wait", not "dead".
   */
  if (snap.has_group_rows && ctx.activeGroupIds.length === 0 && snap.option_values.length > 0) {
    return state;
  }

  if (snap.inventory_mode === 'VARIANT_COMBINATION') {
    const seen = new Set<string>();
    for (const variant of snap.variants) {
      if (!variant.active) continue;
      const parsed = parseCombo(variant.combo_key);
      if (!parsed) continue;
      if (pinValue && !parsed.optionValueIds.includes(pinValue)) continue;
      if (pinColor && parsed.colorId !== pinColor) continue;
      // A stale row naming a value or colour that is gone or switched off is
      // not public inventory, whatever its stock column says.
      if (!parsed.optionValueIds.every((id) => ctx.valueById.get(id)?.active === true)) continue;
      if (parsed.colorId && ctx.colorById.get(parsed.colorId)?.active !== true) continue;
      // `comboKey` is THE canonical encoder (worker/lib/inventory.ts); the
      // stored key may have been written with its tokens in another order, and
      // re-encoding here is what makes the one-row lookup below exact rather
      // than order-dependent.
      const key = comboKey({ option_value_ids: parsed.optionValueIds, color_id: parsed.colorId });
      if (!key || seen.has(key)) continue;
      seen.add(key);
      // A one-row snapshot turns `resolveStock`'s linear scan into an O(1)
      // question about THIS row — the candidate has already been strictly
      // parsed, so nothing is lost.
      evaluate(ctx, state, parsed.optionValueIds, parsed.colorId, { ...snap, variants: [{ ...variant, combo_key: key }] });
      if (state.hit || state.budget <= 0) break;
    }
    return state;
  }

  // ---- option groups ------------------------------------------------------
  const activeValuesOf = (groupId: string): string[] =>
    snap.option_values
      .filter((v) => v.group_id === groupId && ctx.valueById.get(v.id)?.active === true)
      .map((v) => v.id);

  /**
   * ORDERING ONLY, NEVER A VERDICT. A group's values are tried stocked-first
   * so a genuine witness sitting last in catalogue order is found well inside
   * the budget instead of beyond it. Nothing is DROPPED on this basis — the
   * engine decides sellability, and this number is not consulted again.
   */
  const remainder = (id: string): number => {
    const row = snap.option_values.find((v) => v.id === id);
    if (!row || row.stock === null) return 0;
    return Math.max(0, row.stock - Math.max(0, row.reserved));
  };
  const stockedFirst = (ids: string[]): string[] =>
    [...ids].sort((a, b) => (remainder(b) > 0 ? 1 : 0) - (remainder(a) > 0 ? 1 : 0));

  let groups: string[][];
  if (ctx.activeGroupIds.length > 0) {
    groups = ctx.activeGroupIds
      .map((gid) => {
        // The pinned group offers exactly one candidate: the wish itself.
        if (pinValue && ctx.valueById.get(pinValue)?.group_id === gid) return [pinValue];
        return stockedFirst(activeValuesOf(gid));
      })
      // A group with no active value demands no choice — `saleAvailability`
      // builds `requiredGroups` from the ACTIVE options, so a selection that
      // omits such a group is still complete. Dropping it here keeps the walk
      // and the engine saying the same thing about completeness.
      .filter((ids) => ids.length > 0);
  } else if (snap.option_values.length > 0) {
    // A legacy flat chooser: values with no group rows behind them are ONE
    // choice, not N required ones.
    const flat = snap.option_values.filter((v) => ctx.valueById.get(v.id)?.active === true).map((v) => v.id);
    groups = pinValue ? [[pinValue]] : flat.length ? [stockedFirst(flat)] : [];
  } else {
    groups = [];
  }

  /**
   * COLOUR CANDIDATES. A pinned colour is the only one tried. Otherwise every
   * active colour is offered to the engine and `null` last — the engine's own
   * visibility algebra (OR within a group, AND across groups) rejects the ones
   * that do not belong to the tuple, and `COLOR_REQUIRED` rejects `null` when
   * a colour is mandatory. Brute force delegated to the authority beats a
   * second copy of the algebra living here.
   */
  const activeColorIds = snap.colors.filter((c) => ctx.colorById.get(c.id)?.active === true).map((c) => c.id);
  const colorCandidates: Array<string | null> = pinColor
    ? [pinColor]
    : activeColorIds.length > 0
      ? [...activeColorIds, null]
      : [null];

  const chosen: string[] = [];
  const walk = (depth: number): void => {
    if (state.hit || state.budget <= 0) return;
    if (depth === groups.length) {
      for (const colorId of colorCandidates) {
        evaluate(ctx, state, [...chosen], colorId);
        if (state.hit || state.budget <= 0) return;
      }
      return;
    }
    for (const id of groups[depth]) {
      chosen.push(id);
      walk(depth + 1);
      chosen.pop();
      if (state.hit || state.budget <= 0) return;
    }
  };
  walk(0);
  return state;
}

/** The modelled rows a wish could ever be satisfied by, in VARIANT_COMBINATION
 *  mode. Used by the ARM door only — see `armRefusal`. */
function hasModelledRow(ctx: LoadedContext, pinValue: string, pinColor: string): boolean {
  for (const variant of ctx.snapshot.variants) {
    if (!variant.active) continue;
    const parsed = parseCombo(variant.combo_key);
    if (!parsed) continue;
    if (pinValue && !parsed.optionValueIds.includes(pinValue)) continue;
    if (pinColor && parsed.colorId !== pinColor) continue;
    return true;
  }
  return false;
}

// ------------------------------------------------------------- the verdict

const labelOf = (ctx: LoadedContext, wish: AlertWish): AlertVerdict['label'] => {
  const value = wish.option_value_id ? ctx.valueById.get(wish.option_value_id) : undefined;
  const color = wish.color_id ? ctx.colorById.get(wish.color_id) : undefined;
  // A removed target has no names left, and the message still has to name
  // SOMETHING the customer recognises — so it falls back to the product.
  if (wish.kind === 'combination' && value && color) {
    return {
      ar: `${value.label.ar} — ${color.label.ar}`,
      en: `${value.label.en} — ${color.label.en}`,
      ckb: `${value.label.ckb} — ${color.label.ckb}`,
    };
  }
  if (wish.kind === 'option_value' && value) return value.label;
  if (wish.kind === 'color' && color) return color.label;
  if (wish.kind === 'combination') return value?.label ?? color?.label ?? ctx.name;
  return ctx.name;
};

/** The wish names exactly the ids its kind is defined by — no more, no less.
 *  A 'color' row carrying an option value id is not a colour alert with an
 *  extra field, it is a row nothing in this module can honestly resolve. */
function malformed(wish: AlertWish): boolean {
  const hasValue = !!wish.option_value_id;
  const hasColor = !!wish.color_id;
  switch (wish.kind) {
    case 'product':
      return hasValue || hasColor;
    case 'option_value':
      return !hasValue || hasColor;
    case 'color':
      return hasValue || !hasColor;
    case 'combination':
      return !hasValue || !hasColor;
    default:
      return true;
  }
}

const dead = (reason: AlertDeadReason, label: AlertVerdict['label']): AlertVerdict => ({
  buyable: false,
  available: null,
  dead: reason,
  label,
});

/**
 * THE ANSWER. Pure — it reads nothing but the context the loader built, so the
 * sweep can resolve a whole page of alerts without another database round trip
 * and a test can put any catalogue in front of it.
 *
 * THE ORDER OF THE CHECKS IS PART OF THE CONTRACT. In particular the direct-
 * sale GATE is decided before UNTRACKED, because a pre-order line resolves
 * through `resolveCapacity` with a null snapshot and that returns UNTRACKED
 * unconditionally: under any "untracked means we cannot promise" rule the
 * pre-order-only target would otherwise be classified by the wrong reason, and
 * under an "untracked fires immediately" rule it would self-fire the instant
 * it was armed.
 */
export function resolveWish(ctx: AlertProductContext, wish: AlertWish): AlertVerdict {
  const c = ctx as LoadedContext;
  const label = labelOf(c, wish);

  if (malformed(wish)) return dead('NOT_A_STOCK_TARGET', label);

  /**
   * A COMPOSITION HAS NO SHELF OF ITS OWN, EVER. `products.stock` is NULL on a
   * bundle or mystery row for ever, and `saleAvailability` OVERRIDES its
   * availability with a `compositionMax` computed from each MEMBER product.
   * An alert keyed to the bundle's own id therefore watches a column that will
   * never move and a level this module deliberately does not load, so it can
   * never observe a member restocking — while the page shows the customer the
   * ordinary sold-out copy, which is exactly how such an alert gets armed.
   * Refusing at the door is the only honest answer; the alternative is a row
   * that sits armed for ninety days and fires never.
   */
  if (c.composition !== '') return dead('COMPOSITION', label);

  /**
   * A DRAFT OR HIDDEN PRODUCT IS A REFUSAL, NOT A SILENT SKIP. If the sweep
   * merely filtered it out of the driving set the alert would sit armed for
   * its full ninety days while «تنبيهاتي» presented it as live. The reason
   * travels so the sweep can kill it WITH an explanation.
   */
  if (c.status !== 'active') return dead('PRODUCT_UNAVAILABLE', label);

  /**
   * §8.2 ROW 18 — A POOL MEMBER PUBLISHES A COARSE STATE AND NOTHING FINER.
   *
   * A per-target alert on a mystery-pool member is a SUBSCRIBABLE PUSH FEED of
   * the moment each pool row crosses zero, delivered to the customer's phone.
   * Two anonymous catalogue reads around a purchase already defeat the reveal
   * milestones; a standing alert defeats them deterministically and without
   * even polling. Only the product-wide alert is offered.
   *
   * This refuses every narrower kind, not only 'color', and deliberately so:
   * `mystery_pool_entries` is keyed by (product, option_value_ids, colour), so
   * a per-MODEL alert is the same oracle one axis over.
   */
  if (c.coarse && wish.kind !== 'product') return dead('NOT_A_STOCK_TARGET', label);

  // ---- does the target still exist, and is it still offered? --------------
  if (wish.option_value_id) {
    const row = c.valueById.get(wish.option_value_id);
    if (!row) return dead('TARGET_REMOVED', label);
    if (!row.active) return dead('TARGET_INACTIVE', label);
  }
  if (wish.color_id) {
    const row = c.colorById.get(wish.color_id);
    if (!row) return dead('TARGET_REMOVED', label);
    if (!row.active) return dead('TARGET_INACTIVE', label);
  }

  /**
   * THE DIRECT-SALE GATE IS PER TARGET, NOT PER PRODUCT.
   *
   * `product_option_values.availability_type` and 0073's per-value fulfilment
   * cells exist precisely so two models of one product can differ, and a
   * product that offers BOTH sale types passes any product-level gate while
   * the wished model is pre-order only and has no shelf at all.
   *
   * The probe below is the one place this module asks `saleAvailability` about
   * a selection that may be PARTIAL, and it is safe for exactly one field:
   * `modes` is derived from `selectedDeclarations` — the declarations of the
   * values actually named — and is independent of whether the selection is
   * complete. Its `stock` block is NOT read here and must never be; that is
   * the partial-selection lie this whole module is built to avoid.
   */
  const gate = saleAvailability(c.doc, {
    optionValueIds: wish.option_value_id ? [wish.option_value_id] : [],
    colorId: wish.color_id || null,
    inventory: c.snapshot,
    links: c.links,
    coarseStock: c.coarse,
    preferredType: 'direct_sale',
  });
  if (!gate.modes.some((m) => m.type === 'direct_sale')) {
    /**
     * PREORDER_ONLY. Pre-order is a promise about an import, not about a
     * shelf, and since 0075's follow-up it has no counter left to watch at
     * all: `resolveForOrderType` sends a pre-order line to
     * `resolveCapacity(null, '')`, which returns UNTRACKED unconditionally. So
     * there is nothing here that can "come back" — and under any rule that
     * reads untracked as available, such an alert would self-fire the instant
     * it was armed. Naming the reason is what lets the door say «هذا الموديل
     * بالطلب المسبق فقط» instead of «سننبهك» and then never doing so.
     *
     * NEITHER SALE TYPE. The target is not on sale in any form — a direct cell
     * switched off on a product with no pre-order, or a value whose legacy
     * `availability_type` contradicts the product's own `sale_types`. That is
     * an owner's decision to stop offering it, the same class as deactivating
     * the row, and it is killed WITH a reason for the same purpose: «تنبيهاتي»
     * must never show the customer an armed row that nothing can ever satisfy.
     */
    return dead(gate.modes.some((m) => m.type === 'pre_order') ? 'PREORDER_ONLY' : 'NOT_A_STOCK_TARGET', label);
  }

  // ---- the search --------------------------------------------------------
  const state = search(c, wish.option_value_id, wish.color_id);
  if (state.hit) {
    return {
      buyable: true,
      // `null` here is the coarse branch suppressing the count, not an absence
      // of stock: the customer is told it is back, never how many.
      available: state.hit.stock.available,
      dead: null,
      label,
    };
  }

  /**
   * UNTRACKED IS PERMANENT, AND IT LOOKS EXACTLY LIKE SOLD OUT.
   *
   * `directUsable = directEnabled && tracked && available !== null && available > 0`,
   * so a shelf that claims no number can never satisfy it — the product page
   * shows «نفد المخزون» and will keep showing it until an admin types a number.
   * Reported only when every complete selection agreed: a product where one
   * completion tracks and another does not is a live catalogue, not a dead
   * alert.
   */
  if (state.sawComplete && state.sawUntracked && !state.sawTracked) {
    return dead('UNTRACKED', label);
  }

  return {
    buyable: false,
    // 0 only when the engine really answered about a tracked shelf; `null`
    // means «we have never successfully read a quantity for this target»,
    // which migration 0092 says `last_available` means and which is not zero.
    available: state.sawTracked ? 0 : null,
    dead: null,
    label,
  };
}

/**
 * WHAT THE ARM ENDPOINT MUST REFUSE, and why it is stricter than the sweep.
 *
 * Arming is a PROMISE. The door may only make one about a target this
 * catalogue can actually deliver, so it refuses everything `resolveWish` calls
 * dead plus one case the sweep deliberately tolerates:
 *
 *   VARIANT_NOT_MODELLED. In VARIANT_COMBINATION mode a combination with no
 *   `product_variants` row is not sellable and never falls back to base stock
 *   — that silent fallback is the oversell the mode exists to prevent. The
 *   shop does not offer that combination, so the door says so rather than
 *   accepting a standing request for it.
 *
 *   The SWEEP does not kill an already-armed alert for the same reason,
 *   because creating a variant row for a previously unmodelled combination is
 *   one of the restock paths that writes no stock at all: the row appears, the
 *   engine starts answering, and an alert that already exists costs nothing to
 *   honour. Conservative at the door, generous once the promise is made.
 */
export function armRefusal(ctx: AlertProductContext, wish: AlertWish): AlertDeadReason | null {
  const c = ctx as LoadedContext;
  const verdict = resolveWish(c, wish);
  if (verdict.dead) return verdict.dead;
  if (c.snapshot.inventory_mode === 'VARIANT_COMBINATION' && !hasModelledRow(c, wish.option_value_id, wish.color_id)) {
    return 'VARIANT_NOT_MODELLED';
  }
  return null;
}
