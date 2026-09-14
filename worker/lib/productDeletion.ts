/**
 * DELETING A PRODUCT, AND LEAVING NOTHING BEHIND.
 *
 * THE DEFECT. The admin delete ran two statements — `DELETE FROM
 * product_catalogs` and `DELETE FROM products` — and left every other table to
 * `ON DELETE CASCADE`. Reading the real schema shows why that was never going
 * to be enough:
 *
 *   - `reviews.product_id` and both `mystery_allocations` product columns are
 *     declared NO ACTION: the row survives, pointing at an id that is gone.
 *   - `order_items`, `order_item_units`, `warranty_receipts`, `price_history`,
 *     `community_complaints`, and every `color_id` outside the product tables,
 *     carry NO FOREIGN KEY AT ALL.
 *   - Nothing in the Worker sets `PRAGMA foreign_keys`, so even the cascades
 *     that ARE declared are a promise the runtime never confirms.
 *   - And a product named by any past order was never deleted at all: it was
 *     flipped to `status = 'hidden'`, leaving the row and all its children in
 *     place. That is what makes re-importing the same product, or reusing its
 *     slug, collide with data the owner believed was gone.
 *
 * THE SHAPE OF THE FIX. Every table that can name a product is listed here,
 * exactly once, in one of three registries:
 *
 *   OWNED     — the row has no meaning without the product. Deleted.
 *   HISTORY   — the row is a record of something that HAPPENED. Kept; its link
 *               to the product is nulled, because the row already carries its
 *               own snapshot of what it needs.
 *   BLOCKING  — another live object depends on this product. The delete is
 *               refused, with a reason naming what to detach first.
 *
 * `tests/productDeletionRegistry.test.ts` walks the LIVE schema and fails if a
 * product-referencing table appears in none of the three. That test is the
 * actual guarantee: the next migration to add such a table cannot quietly
 * reintroduce a leak, because the suite will name it.
 *
 * Deletion is EXPLICIT rather than cascade-driven. That is what makes it
 * work regardless of the runtime's foreign-key setting, and it is the only way
 * to report `rows_deleted_by_table`, which the owner asked for and which is the
 * only honest proof that the delete did what it says.
 */

/** A table whose rows exist only to describe this product. */
export interface OwnedTable {
  table: string;
  /** The column naming the product, or a subquery joining to it. */
  by: { column: 'product_id' } | { sql: string };
}

/**
 * EVERY TABLE DELETED WITH THE PRODUCT, in dependency order (children before
 * parents) so the sequence is valid whether or not foreign keys are enforced.
 */
export const OWNED_TABLES: OwnedTable[] = [
  // ---- the relational product model -------------------------------------
  // Link rows first: they name a group, an option value AND a colour.
  {
    table: 'product_color_option_links',
    by: { sql: 'color_id IN (SELECT id FROM product_colors WHERE product_id = ?1)' },
  },
  { table: 'product_images', by: { column: 'product_id' } },
  { table: 'product_variants', by: { column: 'product_id' } },
  { table: 'product_option_values', by: { column: 'product_id' } },
  { table: 'product_option_groups', by: { column: 'product_id' } },
  { table: 'product_colors', by: { column: 'product_id' } },
  // ---- placement, search, i18n ------------------------------------------
  { table: 'product_catalogs', by: { column: 'product_id' } },
  { table: 'product_facets', by: { column: 'product_id' } },
  { table: 'product_translations', by: { column: 'product_id' } },
  // ---- stock and pricing history owned by the product --------------------
  { table: 'inventory_ledger', by: { column: 'product_id' } },
  { table: 'price_history', by: { column: 'product_id' } },
  // ---- customer state that must not become a ghost -----------------------
  { table: 'favorites', by: { column: 'product_id' } },
  // Before `cart_items`, and by BOTH routes into it: a choice row can name this
  // product's colour, or hang off a cart line for this product. Its foreign
  // keys cascade from `cart_items` — but only if the runtime enforces them,
  // which is exactly the assumption this module refuses to make.
  {
    table: 'cart_bundle_choices',
    by: {
      sql:
        'color_id IN (SELECT id FROM product_colors WHERE product_id = ?1) ' +
        'OR cart_item_id IN (SELECT id FROM cart_items WHERE product_id = ?1)',
    },
  },
  { table: 'cart_items', by: { column: 'product_id' } },
  // ---- reviews describe THIS product and nothing else --------------------
  { table: 'reviews', by: { column: 'product_id' } },
  // ---- bundle/mystery configuration OWNED by this product ---------------
  // (`bundle_components.member_product_id` and `mystery_pool_entries` are
  //  BLOCKING, not owned — they belong to a different product's offer.)
  { table: 'bundle_config', by: { column: 'product_id' } },
  { table: 'bundle_items', by: { column: 'product_id' } },
  { table: 'mystery_offer_secrets', by: { column: 'product_id' } },
  { table: 'mystery_offers', by: { column: 'product_id' } },
  // ---- the product row itself is deleted last, by the caller ------------
];

/**
 * A RECORD OF SOMETHING THAT HAPPENED. Never deleted; the product link is
 * nulled so nothing dangles and nothing JOINs back to a row that is gone.
 *
 * Every one of these already carries its own snapshot — `order_items` holds
 * `name_snapshot`, `image_snapshot`, `option_snapshot`, `pricing_snapshot`,
 * `warranty_snapshot`, `transport_snapshot` and the charged figures;
 * `warranty_receipts` holds `product_description`, `product_model` and
 * `purchase_price_iqd`. So nulling the id costs a customer nothing and keeps
 * the accounting intact, which is the owner's explicit requirement.
 */
export interface HistoryTable {
  table: string;
  /** Columns set to NULL. Every one is verified nullable by the registry test. */
  columns: string[];
}

export const HISTORY_TABLES: HistoryTable[] = [
  // `option_id` and `color_id` on an order line are NOT NULL and stay — see
  // FROZEN_HISTORY below.
  { table: 'order_items', columns: ['product_id'] },
  { table: 'order_item_units', columns: ['product_id'] },
  { table: 'warranty_receipts', columns: ['product_id'] },
  { table: 'community_complaints', columns: ['product_id'] },
];

/**
 * KEPT EXACTLY AS THEY ARE.
 *
 * These rows are part of an order record and their product-shaped columns are
 * declared NOT NULL, so there is nothing to clear — and clearing them would be
 * wrong even if it were possible. `order_items.option_id` is not a live pointer
 * the storefront follows; it is part of the frozen description of what was
 * bought, sitting beside `option_snapshot`, `pricing_snapshot` and
 * `transport_snapshot`, which carry everything a receipt or a warranty claim
 * needs. `mystery_draw_audits` is the tamper-evident record of a draw, keyed to
 * an order and deleted only with that order.
 *
 * They are listed rather than ignored so the registry test can tell "we thought
 * about this table" apart from "nobody has looked at this table yet".
 */
export interface FrozenTable {
  table: string;
  columns: string[];
  why: string;
}

export const FROZEN_HISTORY: FrozenTable[] = [
  {
    table: 'order_items',
    columns: ['option_id', 'color_id'],
    why: 'NOT NULL, and part of the frozen description of what was bought; option_snapshot carries the display data.',
  },
  {
    table: 'mystery_draw_audits',
    columns: ['offer_product_id'],
    why: 'A tamper-evident draw record keyed to an order; it lives and dies with that order, not with the product.',
  },
  {
    table: 'mystery_allocations',
    columns: ['product_id', 'offer_product_id', 'color_id'],
    why:
      'Every column is NOT NULL and the row already carries name_snapshot, image_snapshot and variant_snapshot — ' +
      'it is the self-contained record of what a customer actually drew, and it is deleted only with its order.',
  },
];

/**
 * ANOTHER LIVE OBJECT DEPENDS ON THIS PRODUCT. Deleting would either break that
 * object or silently change what a customer can still buy, so the delete is
 * refused and the admin is told exactly what to detach.
 *
 * Both of these are declared RESTRICT in the schema, so the database would
 * refuse anyway — but a raw constraint error is not an explanation.
 */
export interface BlockingRef {
  table: string;
  column: string;
  code: string;
  /** What the admin has to do first. */
  remedy: string;
}

export const BLOCKING_REFS: BlockingRef[] = [
  {
    table: 'bundle_components',
    column: 'member_product_id',
    code: 'PRODUCT_IN_BUNDLE',
    remedy: 'Remove this product from every bundle that contains it, then delete it.',
  },
  {
    table: 'mystery_pool_entries',
    column: 'product_id',
    code: 'PRODUCT_IN_MYSTERY_POOL',
    remedy: 'Remove this product from every mystery pool, then delete it.',
  },
];

/**
 * WHERE AN R2 KEY CAN HIDE.
 *
 * `product_images.r2_key` is the canonical one, but a key also reaches R2
 * through the option and colour image columns and through four JSON documents
 * on the product row itself. `source_url` is deliberately absent: it holds the
 * VENDOR's URL the image was ingested from, which is not our file to delete.
 */
export const MEDIA_COLUMNS: Array<{ table: string; column: string; by: string }> = [
  { table: 'product_images', column: 'r2_key', by: 'product_id' },
  { table: 'product_images', column: 'url', by: 'product_id' },
  { table: 'product_option_values', column: 'image', by: 'product_id' },
  { table: 'product_colors', column: 'image', by: 'product_id' },
];

/** JSON columns on `products` that can contain media URLs or keys. */
export const MEDIA_JSON_COLUMNS = [
  'images',
  'media',
  'description_images',
  'content_blocks',
  'usage_guide',
] as const;

/**
 * A STRING IS OURS TO DELETE ONLY IF IT NAMES AN OBJECT IN OUR BUCKET.
 *
 * `/files/<key>` is how the Worker serves R2, and a bare key is what
 * `product_images.r2_key` stores. Anything absolute and off-site — a vendor's
 * CDN, an imgur link — is someone else's file and is returned as null so it
 * can never be queued for deletion.
 */
export function mediaKeyFromRef(ref: unknown): string | null {
  if (typeof ref !== 'string') return null;
  const s = ref.trim();
  if (!s) return null;
  if (s.startsWith('/files/')) return s.slice('/files/'.length) || null;
  // An absolute URL on our own origin still points at /files/.
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      if (u.pathname.startsWith('/files/')) return u.pathname.slice('/files/'.length) || null;
    } catch {
      return null;
    }
    return null;
  }
  // A protocol-relative or root-relative path that is not /files/ is not ours.
  if (s.startsWith('//') || s.startsWith('/')) return null;
  // A bare key, as stored in `product_images.r2_key`.
  return s;
}

/** Every media key mentioned anywhere inside a parsed JSON value. */
export function mediaKeysInJson(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string') {
    const k = mediaKeyFromRef(value);
    // A JSON document holds prose as well as URLs. Only a string that reads as
    // one of OUR references is taken; `mediaKeyFromRef` returning a bare string
    // for arbitrary prose is the one case to guard, so a bare key is accepted
    // only when it looks like a media path.
    if (k && (value.includes('/files/') || /^[\w.-]+\/[\w./-]+\.[a-z0-9]{2,5}$/i.test(value))) out.add(k);
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) mediaKeysInJson(v, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) mediaKeysInJson(v, out);
  }
  return out;
}
