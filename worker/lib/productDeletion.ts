import { deleteMediaObject, isAnonymousPublicMediaKey } from './mediaStorage';

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

/**
 * JSON/text columns on `products` that can contain media URLs or keys.
 *
 * `options` and `colors` are here because the LEGACY embedded shape stored the
 * whole option and colour list as JSON on the product row, each entry carrying
 * its own `image` — products created before the relational tables existed still
 * hold their media only there. The list is intersected with the live
 * `pragma_table_info` before use, so naming a column a future migration drops
 * degrades to skipping it rather than failing the delete.
 */
export const MEDIA_JSON_COLUMNS = [
  'images',
  'options',
  'colors',
  'description_images',
  'description_videos',
  'content_blocks',
  'usage_guide',
  'how_to_use',
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

// ===========================================================================
//  THE ENGINE
// ===========================================================================

/** The narrow slice of D1 this module needs, so tests can drive it directly. */
export interface DeletionDb {
  prepare(sql: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

/**
 * WHICH COLUMNS ACTUALLY EXIST, ASKED OF THE DATABASE RATHER THAN ASSUMED.
 *
 * A registry is a claim about the schema, and a claim can go stale between a
 * migration landing and this file being updated. Every query below is built
 * from the LIVE `pragma_table_info`, so a table or column that is not there is
 * skipped instead of aborting a delete halfway through — and
 * `tests/productDeletionRegistry.test.ts` is what makes the skip loud: it fails
 * when the schema grows something this file does not know about.
 */
async function columnsOf(db: DeletionDb, table: string): Promise<Set<string>> {
  try {
    const rows = await db.prepare(`SELECT name FROM pragma_table_info(?)`).bind(table).all<{ name: string }>();
    return new Set((rows.results ?? []).map((r) => String(r.name)));
  } catch {
    return new Set();
  }
}

async function tableExists(db: DeletionDb, table: string): Promise<boolean> {
  return (await columnsOf(db, table)).size > 0;
}

// ---------------------------------------------------------------------------
//  MEDIA
// ---------------------------------------------------------------------------

export interface ProductMedia {
  /** Every key this product references, whether or not it is ours alone. */
  keys: string[];
  /** Keys also referenced by a row that survives this delete. */
  shared: string[];
  /** Keys referenced by nothing else — the ones safe to remove from R2. */
  owned: string[];
}

/**
 * EVERY R2 KEY THIS PRODUCT POINTS AT.
 *
 * Read BEFORE a single row is deleted, because after the delete there is
 * nothing left to read them from. That ordering is the whole reason
 * `media_cleanup_jobs` exists: the keys are captured and recorded inside the
 * same commit that removes the rows, so a bucket call that fails afterwards is
 * a retryable job rather than a permanently orphaned file.
 */
export async function collectProductMediaKeys(db: DeletionDb, productId: string): Promise<Set<string>> {
  const keys = new Set<string>();

  for (const source of MEDIA_COLUMNS) {
    const cols = await columnsOf(db, source.table);
    if (!cols.has(source.column) || !cols.has(source.by)) continue;
    const rows = await db
      .prepare(`SELECT "${source.column}" AS v FROM "${source.table}" WHERE "${source.by}" = ?`)
      .bind(productId)
      .all<{ v: unknown }>();
    for (const row of rows.results ?? []) {
      const key = mediaKeyFromRef(row.v);
      if (key) keys.add(key);
    }
  }

  const productCols = await columnsOf(db, 'products');
  const jsonCols = MEDIA_JSON_COLUMNS.filter((c) => productCols.has(c));
  if (jsonCols.length) {
    const row = await db
      .prepare(`SELECT ${jsonCols.map((c) => `"${c}"`).join(', ')} FROM products WHERE id = ?`)
      .bind(productId)
      .first<Record<string, unknown>>();
    for (const col of jsonCols) {
      const raw = row?.[col];
      if (typeof raw !== 'string' || !raw.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Not JSON (an older free-text `how_to_use`, say). Scan it as one
        // string: a media reference inside prose is still a reference.
        parsed = raw;
      }
      for (const k of mediaKeysInJson(parsed)) keys.add(k);
    }
  }

  return keys;
}

/**
 * IS THIS FILE STILL SOMEONE ELSE'S?
 *
 * A key reached by importing the same vendor gallery into two products is
 * stored twice, and deleting product A must not blank product B's photo. Each
 * candidate is asked of every place a product can hold a reference, EXCLUDING
 * the product being deleted — if anything answers, the R2 object stays and only
 * the relation goes.
 *
 * The JSON columns are matched with LIKE rather than parsed, deliberately: a
 * false POSITIVE here costs one orphaned file, which the scanner reports and an
 * admin can clear; a false negative destroys a live image. The asymmetry decides
 * the design.
 */
export async function partitionSharedMedia(
  db: DeletionDb,
  productId: string,
  keys: Iterable<string>
): Promise<{ shared: string[]; owned: string[] }> {
  const shared: string[] = [];
  const owned: string[] = [];

  const productCols = await columnsOf(db, 'products');
  const jsonCols = MEDIA_JSON_COLUMNS.filter((c) => productCols.has(c));
  const probes: Array<{ sql: string }> = [];

  for (const source of MEDIA_COLUMNS) {
    const cols = await columnsOf(db, source.table);
    if (!cols.has(source.column) || !cols.has(source.by)) continue;
    probes.push({
      sql:
        `SELECT 1 AS hit FROM "${source.table}" ` +
        `WHERE "${source.by}" <> ?1 AND ("${source.column}" = ?2 OR "${source.column}" = '/files/' || ?2) LIMIT 1`,
    });
  }
  if (jsonCols.length) {
    probes.push({
      sql:
        `SELECT 1 AS hit FROM products WHERE id <> ?1 AND (` +
        jsonCols.map((c) => `"${c}" LIKE '%' || ?2 || '%'`).join(' OR ') +
        `) LIMIT 1`,
    });
  }

  for (const key of keys) {
    let isShared = false;
    for (const probe of probes) {
      const hit = await db.prepare(probe.sql).bind(productId, key).first<{ hit: number }>();
      if (hit) {
        isShared = true;
        break;
      }
    }
    (isShared ? shared : owned).push(key);
  }
  return { shared, owned };
}

/** Which bucket a key lives in, decided by the same predicate that serves it. */
export function mediaVisibilityOf(key: string): 'public' | 'private' {
  return isAnonymousPublicMediaKey(key) ? 'public' : 'private';
}

// ---------------------------------------------------------------------------
//  THE DELETE
// ---------------------------------------------------------------------------

export interface BlockedDeletion {
  code: string;
  table: string;
  count: number;
  remedy: string;
}

export interface DeletionResult {
  product_deleted: boolean;
  already_deleted: boolean;
  rows_deleted_by_table: Record<string, number>;
  rows_unlinked_by_table: Record<string, number>;
  media_keys_found: string[];
  r2_objects_shared_skipped: string[];
  /** Queued for R2 removal — ids in `media_cleanup_jobs`, to run after commit. */
  media_jobs: Array<{ id: string; key: string; visibility: 'public' | 'private' }>;
  blocked?: BlockedDeletion;
}

/** Why a blocked delete is a refusal and not an error the admin has to decode. */
export async function blockingReferences(db: DeletionDb, productId: string): Promise<BlockedDeletion | null> {
  for (const ref of BLOCKING_REFS) {
    const cols = await columnsOf(db, ref.table);
    if (!cols.has(ref.column)) continue;
    const row = await db
      .prepare(`SELECT COUNT(*) AS n FROM "${ref.table}" WHERE "${ref.column}" = ?`)
      .bind(productId)
      .first<{ n: number }>();
    const count = Number(row?.n ?? 0);
    if (count > 0) return { code: ref.code, table: ref.table, count, remedy: ref.remedy };
  }
  return null;
}

/**
 * THE PERMANENT DELETE, AS ONE COMMITTED SEQUENCE.
 *
 * Order matters and is not negotiable:
 *
 *   1. Confirm the product is there. Gone already is SUCCESS, not a 500 — the
 *      admin pressing Delete twice is the commonest way this is called, and the
 *      second press must be quiet.
 *   2. Refuse if a live object still depends on it, naming what to detach.
 *   3. COLLECT MEDIA KEYS while the rows that hold them still exist.
 *   4. Partition those keys into ours and shared.
 *   5. In ONE batch: record the cleanup jobs, delete every OWNED row in
 *      dependency order, null every HISTORY link, delete the product.
 *
 * R2 is touched only after that batch returns. D1 and R2 cannot share a
 * transaction, so the choice is which failure to prefer — and a file that
 * outlives its product is recoverable (the job retries, the scanner reports it)
 * while a product that outlives a deleted file is a broken catalogue page.
 */
export async function deleteProductPermanently(
  db: DeletionDb,
  productId: string,
  options: { newId: () => string } = { newId: () => crypto.randomUUID() }
): Promise<DeletionResult> {
  const empty: DeletionResult = {
    product_deleted: false,
    already_deleted: true,
    rows_deleted_by_table: {},
    rows_unlinked_by_table: {},
    media_keys_found: [],
    r2_objects_shared_skipped: [],
    media_jobs: [],
  };

  const exists = await db.prepare('SELECT id FROM products WHERE id = ?').bind(productId).first<{ id: string }>();
  if (!exists) return empty;

  const blocked = await blockingReferences(db, productId);
  if (blocked) return { ...empty, already_deleted: false, blocked };

  const found = await collectProductMediaKeys(db, productId);
  const { shared, owned } = await partitionSharedMedia(db, productId, found);

  const jobs = owned.map((key) => ({ id: options.newId(), key, visibility: mediaVisibilityOf(key) }));

  const statements: D1PreparedStatement[] = [];
  const ledger: Array<{ kind: 'job' | 'delete' | 'unlink'; table: string }> = [];

  for (const job of jobs) {
    // OR IGNORE against the partial unique index on (object_key) WHERE pending:
    // deleting two products that shared a key in the same sweep, or retrying a
    // half-finished delete, must not queue the same object twice.
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO media_cleanup_jobs (id, object_key, visibility, reason, source_product_id)
           VALUES (?, ?, ?, 'product_delete', ?)`
        )
        .bind(job.id, job.key, job.visibility, productId)
    );
    ledger.push({ kind: 'job', table: 'media_cleanup_jobs' });
  }

  for (const child of OWNED_TABLES) {
    if (!(await tableExists(db, child.table))) continue;
    const where = 'column' in child.by ? `"${child.by.column}" = ?1` : child.by.sql;
    statements.push(db.prepare(`DELETE FROM "${child.table}" WHERE ${where}`).bind(productId));
    ledger.push({ kind: 'delete', table: child.table });
  }

  for (const history of HISTORY_TABLES) {
    const cols = await columnsOf(db, history.table);
    const present = history.columns.filter((c) => cols.has(c));
    if (!present.length) continue;
    // The link is nulled; the row — and its own snapshot of what was bought —
    // stays exactly as it was. `WHERE <col> = ?` also makes this idempotent.
    statements.push(
      db
        .prepare(
          `UPDATE "${history.table}" SET ${present.map((c) => `"${c}" = NULL`).join(', ')} ` +
            `WHERE ${present.map((c) => `"${c}" = ?1`).join(' OR ')}`
        )
        .bind(productId)
    );
    ledger.push({ kind: 'unlink', table: history.table });
  }

  statements.push(db.prepare('DELETE FROM products WHERE id = ?1').bind(productId));
  ledger.push({ kind: 'delete', table: 'products' });

  const results = await db.batch(statements);

  const rows_deleted_by_table: Record<string, number> = {};
  const rows_unlinked_by_table: Record<string, number> = {};
  results.forEach((res, i) => {
    const entry = ledger[i];
    if (!entry) return;
    const changes = Number((res as { meta?: { changes?: number } }).meta?.changes ?? 0);
    if (entry.kind === 'delete') rows_deleted_by_table[entry.table] = (rows_deleted_by_table[entry.table] ?? 0) + changes;
    else if (entry.kind === 'unlink') rows_unlinked_by_table[entry.table] = (rows_unlinked_by_table[entry.table] ?? 0) + changes;
  });

  return {
    product_deleted: (rows_deleted_by_table.products ?? 0) > 0,
    already_deleted: false,
    rows_deleted_by_table,
    rows_unlinked_by_table,
    media_keys_found: [...found],
    r2_objects_shared_skipped: shared,
    media_jobs: jobs,
  };
}

// ---------------------------------------------------------------------------
//  THE HALF THAT CANNOT BE IN THE TRANSACTION
// ---------------------------------------------------------------------------

export interface MediaCleanupEnv {
  DB: D1Database;
  BUCKET: R2Bucket;
  R2_PUBLIC?: R2Bucket;
  R2_PRIVATE?: R2Bucket;
}

export interface MediaCleanupOutcome {
  deleted: string[];
  failed: Array<{ key: string; error: string }>;
}

/**
 * RUN THE QUEUED BUCKET DELETIONS AND CLOSE THE JOBS.
 *
 * A failure here is recorded, never thrown outward: the product is already gone
 * and telling the admin the delete failed would be a lie. The job stays
 * `pending` with its error and attempt count, and the same function run again
 * (by the retry sweep, or by a second Delete press) finishes it.
 *
 * A MISSING OBJECT IS SUCCESS. R2's `delete` does not distinguish, and neither
 * should we: the job's goal is "this key is not in the bucket", and a key that
 * was never written — an image row whose upload failed — already satisfies it.
 */
export async function runMediaCleanup(
  env: MediaCleanupEnv,
  jobs: Array<{ id: string; key: string; visibility: 'public' | 'private' }>
): Promise<MediaCleanupOutcome> {
  const out: MediaCleanupOutcome = { deleted: [], failed: [] };
  for (const job of jobs) {
    try {
      await deleteMediaObject(env, job.visibility, job.key);
      out.deleted.push(job.key);
      await env.DB.prepare(
        `UPDATE media_cleanup_jobs
            SET state = 'done', attempts = attempts + 1, last_error = '',
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE object_key = ? AND state = 'pending'`
      )
        .bind(job.key)
        .run();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown';
      out.failed.push({ key: job.key, error: message });
      await env.DB.prepare(
        `UPDATE media_cleanup_jobs
            SET attempts = attempts + 1, last_error = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE object_key = ? AND state = 'pending'`
      )
        .bind(message.slice(0, 400), job.key)
        .run();
    }
  }
  return out;
}

/** Pending jobs, oldest first — what the retry sweep and the report both read. */
export async function pendingMediaCleanup(
  db: DeletionDb,
  limit = 200
): Promise<Array<{ id: string; key: string; visibility: 'public' | 'private'; attempts: number }>> {
  const rows = await db
    .prepare(
      `SELECT id, object_key, visibility, attempts FROM media_cleanup_jobs
        WHERE state = 'pending' ORDER BY created_at LIMIT ?`
    )
    .bind(limit)
    .all<{ id: string; object_key: string; visibility: string; attempts: number }>();
  return (rows.results ?? []).map((r) => ({
    id: String(r.id),
    key: String(r.object_key),
    visibility: r.visibility === 'private' ? 'private' : 'public',
    attempts: Number(r.attempts ?? 0),
  }));
}

/**
 * THE EDGE STILL HAS THE PICTURE.
 *
 * `/files/*` participates in `caches.default` with a one-year `immutable`
 * lifetime, which is honest for a key that never changes its bytes — but a
 * DELETED key must stop being served, and an immutable entry would outlive the
 * object by up to a year. Each removed key's URL is dropped from the colo cache
 * that this request landed in.
 *
 * SCOPE, STATED PLAINLY: `caches.default.delete` is per-colo. It clears the
 * cache of the datacentre serving the admin's own request, not every edge
 * worldwide — a global purge needs the zone-level Cloudflare API and a token
 * this Worker deliberately does not carry. Other colos stop serving the file
 * when their entry expires or is evicted, and an origin miss then 404s because
 * the object is gone. The returned list is what was actually invalidated, not
 * what we wish had been.
 */
export async function invalidateMediaCache(origin: string, keys: string[]): Promise<string[]> {
  const cache = typeof caches !== 'undefined' ? (caches as unknown as { default?: Cache }).default ?? null : null;
  if (!cache) return [];
  const invalidated: string[] = [];
  for (const key of keys) {
    const url = `${origin.replace(/\/+$/, '')}/files/${key}`;
    try {
      if (await cache.delete(url)) invalidated.push(url);
    } catch {
      // A cache that refuses a delete is not a reason to fail a delete that
      // has already committed.
    }
  }
  return invalidated;
}

// ---------------------------------------------------------------------------
//  THE SCANNER — WHAT EARLIER DELETES LEFT BEHIND
// ---------------------------------------------------------------------------

/**
 * WHAT IS ALREADY BROKEN, BEFORE ANYTHING IS TOUCHED.
 *
 * Every delete before this module ran two statements, so the live database
 * holds residue that the new path will never create: option rows, colours,
 * images, facets and reviews whose product is gone, and R2 objects nothing
 * references. This reports them.
 *
 * IT DEFAULTS TO A DRY RUN AND THE OWNER ASKED FOR EXACTLY THAT. Nothing is
 * deleted unless `dryRun: false` is passed explicitly, and even then the caller
 * has to have seen the report first — the admin route refuses a destructive run
 * without an `acknowledge` token matching the dry run's own counts.
 */
export interface OrphanGroup {
  table: string;
  column: string;
  orphan_rows: number;
  sample_ids: string[];
}

export interface OrphanReport {
  dry_run: boolean;
  dangling_rows: OrphanGroup[];
  orphan_r2_objects: Array<{ key: string; bytes: number }>;
  r2_scanned: number;
  /** True when the R2 listing hit its cap — the report is a floor, not a total. */
  r2_truncated: boolean;
  pending_media_jobs: number;
  totals: { orphan_rows: number; orphan_r2_objects: number; orphan_bytes: number };
  /** Populated only on a destructive run. */
  removed?: { rows_by_table: Record<string, number>; r2_objects: string[] };
}

/** How many R2 objects one scan will look at. Stated in the report, never silent. */
export const ORPHAN_SCAN_R2_LIMIT = 2_000;

/**
 * A row is an orphan when the id it names is not there any more. Expressed once,
 * per registry entry, so a table added to the registry is scanned automatically.
 */
const ORPHAN_PARENTS: Record<string, { column: string; parent: string; parentKey: string }> = {
  product_id: { column: 'product_id', parent: 'products', parentKey: 'id' },
  color_id: { column: 'color_id', parent: 'product_colors', parentKey: 'id' },
  option_id: { column: 'option_id', parent: 'product_option_values', parentKey: 'id' },
  cart_item_id: { column: 'cart_item_id', parent: 'cart_items', parentKey: 'id' },
};

export async function scanProductOrphans(
  db: DeletionDb,
  bucket: R2Bucket | null,
  options: { dryRun?: boolean; r2Limit?: number } = {}
): Promise<OrphanReport> {
  const dryRun = options.dryRun !== false;
  const r2Limit = options.r2Limit ?? ORPHAN_SCAN_R2_LIMIT;

  const dangling: OrphanGroup[] = [];
  const scanned = new Set<string>();

  for (const entry of OWNED_TABLES) {
    const cols = await columnsOf(db, entry.table);
    if (!cols.size) continue;
    for (const [col, parent] of Object.entries(ORPHAN_PARENTS)) {
      if (!cols.has(col)) continue;
      const mark = `${entry.table}.${col}`;
      if (scanned.has(mark)) continue;
      scanned.add(mark);
      const idCol = cols.has('id') ? 'id' : col;
      const rows = await db
        .prepare(
          `SELECT "${idCol}" AS ident FROM "${entry.table}"
            WHERE "${col}" IS NOT NULL
              AND "${col}" NOT IN (SELECT "${parent.parentKey}" FROM "${parent.parent}")`
        )
        .all<{ ident: unknown }>();
      const found = rows.results ?? [];
      if (!found.length) continue;
      dangling.push({
        table: entry.table,
        column: col,
        orphan_rows: found.length,
        sample_ids: found.slice(0, 10).map((r) => String(r.ident)),
      });
    }
  }

  // Every key the database still points at, so an R2 object can be judged.
  const referenced = new Set<string>();
  for (const source of MEDIA_COLUMNS) {
    const cols = await columnsOf(db, source.table);
    if (!cols.has(source.column)) continue;
    const rows = await db
      .prepare(`SELECT "${source.column}" AS v FROM "${source.table}" WHERE "${source.column}" IS NOT NULL`)
      .all<{ v: unknown }>();
    for (const row of rows.results ?? []) {
      const key = mediaKeyFromRef(row.v);
      if (key) referenced.add(key);
    }
  }
  const productCols = await columnsOf(db, 'products');
  const jsonCols = MEDIA_JSON_COLUMNS.filter((c) => productCols.has(c));
  if (jsonCols.length) {
    const rows = await db.prepare(`SELECT ${jsonCols.map((c) => `"${c}"`).join(', ')} FROM products`).all<Record<string, unknown>>();
    for (const row of rows.results ?? []) {
      for (const col of jsonCols) {
        const raw = row[col];
        if (typeof raw !== 'string' || !raw.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = raw;
        }
        for (const k of mediaKeysInJson(parsed)) referenced.add(k);
      }
    }
  }

  const orphanObjects: Array<{ key: string; bytes: number }> = [];
  let r2Scanned = 0;
  let truncated = false;
  if (bucket) {
    let cursor: string | undefined;
    do {
      const page: R2Objects = await bucket.list({ prefix: 'products/', cursor, limit: 500 });
      for (const obj of page.objects) {
        r2Scanned += 1;
        if (!referenced.has(obj.key)) orphanObjects.push({ key: obj.key, bytes: Number(obj.size ?? 0) });
      }
      cursor = page.truncated ? page.cursor : undefined;
      if (r2Scanned >= r2Limit && cursor) {
        truncated = true;
        break;
      }
    } while (cursor);
  }

  const pending = await db
    .prepare(`SELECT COUNT(*) AS n FROM media_cleanup_jobs WHERE state = 'pending'`)
    .first<{ n: number }>()
    .catch(() => null);

  const report: OrphanReport = {
    dry_run: dryRun,
    dangling_rows: dangling,
    orphan_r2_objects: orphanObjects,
    r2_scanned: r2Scanned,
    r2_truncated: truncated,
    pending_media_jobs: Number(pending?.n ?? 0),
    totals: {
      orphan_rows: dangling.reduce((n, g) => n + g.orphan_rows, 0),
      orphan_r2_objects: orphanObjects.length,
      orphan_bytes: orphanObjects.reduce((n, o) => n + o.bytes, 0),
    },
  };

  if (dryRun) return report;

  const rows_by_table: Record<string, number> = {};
  for (const group of dangling) {
    const parent = ORPHAN_PARENTS[group.column];
    if (!parent) continue;
    const res = await db
      .prepare(
        `DELETE FROM "${group.table}"
          WHERE "${group.column}" IS NOT NULL
            AND "${group.column}" NOT IN (SELECT "${parent.parentKey}" FROM "${parent.parent}")`
      )
      .run();
    rows_by_table[group.table] = (rows_by_table[group.table] ?? 0) + Number(res.meta?.changes ?? 0);
  }
  const removedKeys: string[] = [];
  if (bucket) {
    for (const obj of orphanObjects) {
      try {
        await bucket.delete(obj.key);
        removedKeys.push(obj.key);
      } catch {
        // Reported by the next scan; never fails the sweep.
      }
    }
  }
  report.removed = { rows_by_table, r2_objects: removedKeys };
  return report;
}
