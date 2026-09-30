/**
 * IS THIS KEY THE CALLER'S OWN UPLOAD — and what is it?
 *
 * A product file or a post attachment arrives as a KEY the client sends back
 * after an upload (docs/COMMUNITY_ECOSYSTEM.md §9.4). A key is a string, and
 * a string can name anybody's object, so nothing here trusts it: the key must
 * sit in `file_objects` as a live, PRIVATE object owned by the caller, written
 * by an upload door whose `purpose` matches what the caller is attaching it as.
 *
 * `purpose` (file_objects, migration `asset_platform`) is what the upload
 * session recorded; a ledger row written before that column existed carries
 * '' and is admitted on the owner check alone — ownership is the load-bearing
 * rule, the purpose narrows which door the bytes came through. On a database
 * that does not have the column at all (a deploy landing before its
 * migration) the same owner-only rule applies rather than a 500.
 *
 * WHY PRIVATE ONLY: a public key is served by `/files/<key>` to anyone, which
 * would make every grant and every viewer token below it decorative.
 */

import { isSafeMediaKey } from './mediaStorage';
import { MODEL_EXTENSIONS } from './modelGeometry';
import { safeFileName } from './attachments';
import { isSchemaMissing } from './membershipBenefits';

export type FileKind = 'model' | 'document' | 'image' | 'archive';

export interface OwnedFileObject {
  key: string;
  mime: string;
  bytes: number;
  original_name: string | null;
  kind: FileKind;
}

/** The roles a product file may carry (§9.4). */
export const PRODUCT_FILE_ROLES = ['preview', 'download_after_purchase', 'reference', 'instruction', 'source_model'] as const;
export type ProductFileRole = (typeof PRODUCT_FILE_ROLES)[number];

/**
 * The roles a purchase opens. `preview` is never downloadable — it is a shape
 * on a screen. The other four are the merchant's promise to a buyer: the
 * printable, its source, the reference sheet and the instructions (§9.4:
 * "reference/instruction … downloadable after purchase").
 */
export const GRANTED_ROLES: readonly ProductFileRole[] = ['download_after_purchase', 'source_model', 'reference', 'instruction'];

/** The most files one product carries. */
export const PRODUCT_FILES_MAX = 12;
/** The most files one post carries. */
export const POST_FILES_MAX = 3;

const purposeColumnMemo = new WeakMap<object, Promise<boolean>>();

/** Does file_objects carry `purpose` yet? Probed once per database handle. */
export async function fileObjectsHavePurpose(db: D1Database): Promise<boolean> {
  let memo = purposeColumnMemo.get(db);
  if (!memo) {
    memo = db
      .prepare("SELECT 1 AS x FROM pragma_table_info('file_objects') WHERE name = 'purpose'")
      .first()
      .then((r) => !!r)
      .catch(() => false);
    purposeColumnMemo.set(db, memo);
  }
  return memo;
}

/**
 * What a stored object IS, from the sniffed type the ledger recorded (never
 * the name alone): the mime the upload door derived from the bytes, with the
 * extension consulted only for the model formats whose bytes carry no
 * magic (STL/OBJ/STEP land as `model/*` from `classifyAttachment`; a session
 * upload may have recorded `application/octet-stream` for them).
 */
export function fileKindFromMime(mime: string, key = ''): FileKind {
  const m = String(mime ?? '').toLowerCase();
  const ext = key.includes('.') ? key.slice(key.lastIndexOf('.') + 1).toLowerCase() : '';
  if (m.startsWith('model/') || m === 'application/x-amf' || m === 'application/sla' || m === 'application/vnd.ms-pki.stl') return 'model';
  if (ext && ext in MODEL_EXTENSIONS && (m === '' || m === 'application/octet-stream')) return 'model';
  if (m.startsWith('image/')) return 'image';
  if (
    m === 'application/zip' || m === 'application/x-zip-compressed' || m === 'application/x-rar-compressed' ||
    m === 'application/vnd.rar' || m === 'application/x-7z-compressed' || ['zip', 'rar', '7z'].includes(ext)
  ) {
    return 'archive';
  }
  return 'document';
}

/**
 * The caller's own private object under one of `purposes`, or null. Null for
 * a missing row, somebody else's row, a public object, a deleted one and a
 * key that is not even well-formed — one answer, so the door says nothing
 * about what exists.
 */
export async function ownedFileObject(
  db: D1Database,
  key: unknown,
  userId: string,
  purposes: readonly string[]
): Promise<OwnedFileObject | null> {
  const k = typeof key === 'string' ? key.trim().replace(/^\/files\//, '') : '';
  if (!isSafeMediaKey(k) || !userId) return null;
  const hasPurpose = await fileObjectsHavePurpose(db);
  const row = await db
    .prepare(
      `SELECT object_key, mime_type, byte_size, original_name
         FROM file_objects
        WHERE object_key = ?1 AND owner_id = ?2 AND deleted_at IS NULL AND visibility = 'private'
          ${hasPurpose ? `AND (purpose = '' OR purpose IN (SELECT value FROM json_each(?3)))` : ''}`
    )
    .bind(k, userId, ...(hasPurpose ? [JSON.stringify(purposes)] : []))
    .first<{ object_key: string; mime_type: string; byte_size: number; original_name: string | null }>();
  if (!row) return null;
  return {
    key: row.object_key,
    mime: String(row.mime_type ?? ''),
    bytes: Number(row.byte_size ?? 0),
    original_name: row.original_name ?? null,
    kind: fileKindFromMime(String(row.mime_type ?? ''), row.object_key),
  };
}

/**
 * «THIS BUYER MAY DOWNLOAD THESE FILES» — one statement for a whole order.
 *
 * Appended to the batch that captures the payment (the store checkout in
 * worker/routes/storeOrders.ts; a community order the day it names a
 * product), so a grant exists exactly when the money moved and never
 * otherwise. `INSERT OR IGNORE` on the UNIQUE (product_file_id, user_id):
 * a second order of the same product, a retried transition, a re-run batch —
 * one grant per buyer per file, whatever happens around it.
 *
 * The ids are minted in SQL because the set of files is only known to the
 * database at the moment the statement runs.
 */
/**
 * Does this database carry 0157? The store checkout writes grants only when it
 * does, so a Worker deployed ahead of its migration still sells — the same
 * deploy window tests/chatPrivateProducts.test.ts pins for 0152. Remembered
 * once true PER DATABASE HANDLE (a table never goes away; the binding is one
 * object per isolate, so the checkout's money path pays the `LIMIT 0` probe
 * once per isolate, not once per order — and a test that builds databases at
 * different migrations in one process never inherits another handle's
 * answer, the way `fileObjectsHavePurpose` is keyed above); asked again while
 * false, so an isolate that outlives the migration notices it.
 */
let productFilesReadyHandles = new WeakSet<object>();

export async function productFilesReady(db: D1Database): Promise<boolean> {
  if (productFilesReadyHandles.has(db)) return true;
  try {
    await db.prepare('SELECT product_file_id FROM product_file_grants LIMIT 0').all();
    productFilesReadyHandles.add(db);
    return true;
  } catch (e) {
    if (isSchemaMissing(e)) return false;
    throw e;
  }
}

/** For tests that reuse one handle across migrations (none today; kept beside `resetPrivateProductsMemo`). */
export function resetProductFilesMemo(): void {
  productFilesReadyHandles = new WeakSet<object>();
}

/**
 * How many files a product carries — for the shopfront's product read, so the
 * page asks the files door only when there is something behind it (most
 * products carry none). Zero on a database without 0157, whatever the memo
 * says: this read is not on the money path, and a missing table here must
 * never be a 500 on a product page.
 */
export async function productFileCount(db: D1Database, productId: string): Promise<number> {
  if (!(await productFilesReady(db))) return 0;
  try {
    const r = await db.prepare('SELECT COUNT(*) AS n FROM product_files WHERE product_id = ?').bind(productId).first<{ n: number }>();
    return Number(r?.n ?? 0);
  } catch (e) {
    if (isSchemaMissing(e)) return 0;
    throw e;
  }
}

export function productFileGrantStatement(
  db: D1Database,
  input: { productIds: readonly string[]; userId: string; orderId?: string | null; communityOrderId?: string | null; ts: string }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO product_file_grants (id, product_file_id, user_id, order_id, community_order_id, granted_at)
       SELECT 'pfg_' || lower(hex(randomblob(12))), f.id, ?2, ?3, ?4, ?5
         FROM product_files f
        WHERE f.product_id IN (SELECT value FROM json_each(?1))
          AND f.role IN (SELECT value FROM json_each(?6))`
    )
    .bind(
      JSON.stringify([...new Set(input.productIds)]),
      input.userId,
      input.orderId ?? null,
      input.communityOrderId ?? null,
      input.ts,
      JSON.stringify(GRANTED_ROLES)
    );
}

/**
 * A GRANT IS LIVE while its expiry has not passed AND the order that paid for
 * it is not cancelled. A cancelled store order is a refunded one
 * (`cancelStoreOrder` refunds the wallet in the same batch that flips the
 * status), and its batch also revokes the grants it paid for
 * (`revokeOrderProductFileGrantStatements`); this predicate is the second
 * lock on the same door, so a row that was granted before that statement
 * existed — or one a future refund path forgets — still opens nothing.
 * `g` is the grants alias; `now` the bound parameter holding the instant.
 */
export function liveGrantSql(g: string, now: string): string {
  return `(${g}.expires_at IS NULL OR ${g}.expires_at = '' OR ${g}.expires_at > ${now})
          AND (${g}.order_id IS NULL OR NOT EXISTS (SELECT 1 FROM orders co WHERE co.id = ${g}.order_id AND co.status = 'cancelled'))`;
}

/** The grant this user holds on this file right now, if any — expiry honoured, a refunded order not. */
export async function activeGrant(
  db: D1Database,
  fileId: string,
  userId: string,
  now: string = new Date().toISOString()
): Promise<{ id: string; downloads: number } | null> {
  return db
    .prepare(
      `SELECT g.id, g.downloads FROM product_file_grants g
        WHERE g.product_file_id = ?1 AND g.user_id = ?2 AND ${liveGrantSql('g', '?3')}`
    )
    .bind(fileId, userId, now)
    .first<{ id: string; downloads: number }>();
}

/**
 * HAS THIS USER BOUGHT THIS PRODUCT — a live grant on ANY of its files. The
 * `preview` role is never granted (it is a shape on a screen, not a
 * download), so «buyer» is decided per product, not per file: §4d's viewer
 * token («`full` for owner/buyer») and the list's `granted` on the preview
 * row both ask this.
 */
export async function hasProductGrant(
  db: D1Database,
  productId: string,
  userId: string,
  now: string = new Date().toISOString()
): Promise<boolean> {
  const r = await db
    .prepare(
      `SELECT 1 AS x FROM product_file_grants g
         JOIN product_files f ON f.id = g.product_file_id
        WHERE f.product_id = ?1 AND g.user_id = ?2 AND ${liveGrantSql('g', '?3')}
        LIMIT 1`
    )
    .bind(productId, userId, now)
    .first();
  return !!r;
}

/**
 * THE MONEY WENT BACK, SO THE FILES GO BACK — the grants a store order paid
 * for, revoked inside the cancellation's own batch (worker/lib/storeOrderOps.ts
 * `cancelStoreOrder`), fenced on the same gate row as every other statement
 * of that batch, so a lost race revokes nothing.
 *
 * Two statements because a grant is one row per (file, buyer) whatever the
 * number of orders (`INSERT OR IGNORE`): a buyer who ordered the same product
 * twice holds ONE row, stamped with the first order. Cancelling that order
 * must not take a file the other, still-paid order bought — so a row another
 * live store order of the same buyer covers is RE-POINTED at that order
 * first, and only what nothing else paid for is deleted.
 */
export function revokeOrderProductFileGrantStatements(
  db: D1Database,
  orderId: string,
  guard: { sql: string; binds: unknown[] }
): D1PreparedStatement[] {
  const covering = `SELECT o.id FROM orders o
                      JOIN order_items oi ON oi.order_id = o.id
                     WHERE o.user_id = product_file_grants.user_id AND o.id <> ?1
                       AND o.seller_type = 'merchant' AND o.status <> 'cancelled'
                       AND oi.community_product_id = (SELECT product_id FROM product_files WHERE id = product_file_grants.product_file_id)
                     ORDER BY o.created_at DESC LIMIT 1`;
  return [
    db
      .prepare(
        `UPDATE product_file_grants SET order_id = (${covering})
          WHERE order_id = ?1 AND EXISTS (${covering}) AND ${guard.sql}`
      )
      .bind(orderId, ...guard.binds),
    db.prepare(`DELETE FROM product_file_grants WHERE order_id = ?1 AND ${guard.sql}`).bind(orderId, ...guard.binds),
  ];
}

/**
 * A stored name for the Content-Disposition header: the ASCII-safe form for
 * old clients and the RFC 5987 form for everyone else, so an Arabic file name
 * survives the download intact and a newline or a quote never reaches the
 * header (worker/lib/attachments.ts `safeFileName` did the stripping).
 */
export function attachmentDisposition(safeName: string): string {
  const ascii = safeName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safeName)}`;
}

/**
 * The bytes as an ATTACHMENT — the one shape a product file or a post file
 * ever leaves the Worker in: never inline, never sniffed, never cached, never
 * scriptable (the same `nosniff` + sandboxing CSP `/files/*` sends). An HTML
 * mime is downgraded to octet-stream so a stored page can never render.
 */
export function attachmentResponse(object: R2ObjectBody, name: string, mime: string, bytes: number): Response {
  const headers = new Headers({
    'Content-Type': mime && !/^text\/html/i.test(mime) ? mime : 'application/octet-stream',
    'Content-Disposition': attachmentDisposition(safeFileName(name, 'bin')),
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  });
  const size = Number(object.size ?? bytes);
  if (Number.isFinite(size) && size > 0) headers.set('Content-Length', String(size));
  return new Response(object.body, { headers });
}
