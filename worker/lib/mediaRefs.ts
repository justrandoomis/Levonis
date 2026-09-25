/**
 * Which image references a merchant is allowed to point at.
 *
 * A merchant supplies their logo, banner and product pictures as strings, and
 * a string the merchant controls that ends up in `<img src>` is a request the
 * VISITOR'S browser makes to wherever the merchant chose. That is:
 *
 *   - an off-platform tracking pixel — every visitor's IP and User-Agent
 *     handed to a third party the visitor never chose to talk to;
 *   - a shop that breaks when someone else's host goes away;
 *   - and, with a `data:` or `javascript:` scheme, an attempt at something
 *     worse.
 *
 * `MERCHANT_STORES.md` §10 already says no merchant string reaches the
 * stylesheet. This is the same rule for the other place a merchant string can
 * reach the page. A reference is accepted only if it addresses an object THIS
 * platform issued to THIS merchant — which is what makes "linked to a real
 * record" true rather than "a key someone typed in".
 *
 * New uploads use `merchants/<user id>/public/<id>.<ext>`. The previous
 * `community/<user id>/<id>.<ext>` shape stays accepted while stored products
 * migrate, so editing an old listing never strips its working media.
 */

import { deleteMediaObject, isSafeMediaKey, type MediaVisibility } from './mediaStorage';
import {
  claimMediaObjectForCleanup,
  mediaKeyFromRef,
  mediaKeysInJson,
  mediaVisibilityOf,
  pendingMediaCleanup,
  releaseMediaObjectCleanupClaim,
  type MediaCleanupEnv,
} from './productDeletion';
import { MAIN_PAGE_PREFIX, isSiteMediaObject } from './siteMedia';
import { newId } from './crypto';


/** `<hex id>.<ext>` — exactly what `newId()` + the sniffer produce. */
const OBJECT_RE = /^[a-z0-9]{4,40}\.(jpg|jpeg|png|gif|webp|avif)$/;

/**
 * The storage key behind a reference, if it belongs to `userId`.
 *
 * Accepts either the key (`community/u1/ab.jpg`) or the delivery path
 * (`/files/community/u1/ab.jpg`), because both forms exist in the codebase
 * already — the store columns hold keys and the product array holds paths.
 * Returns `null` for anything else, including an absolute URL, a `data:` URI,
 * a traversal, and another merchant's object.
 */
export function ownedMediaKey(value: unknown, userId: string): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.length > 200) return null;
  // A scheme or a protocol-relative prefix means it is not ours. Checked
  // before any stripping, so `//evil.example/x` cannot slip through as a path.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return null;

  const key = raw.startsWith('/files/') ? raw.slice('/files/'.length) : raw;
  if (key.includes('..') || key.includes('\\')) return null;

  const parts = key.split('/');
  const legacy = parts.length === 3 && parts[0] === 'community' && parts[1] === userId;
  const canonical = parts.length === 4 && parts[0] === 'merchants' && parts[1] === userId && parts[2] === 'public';
  if (!legacy && !canonical) return null;
  const object = parts[parts.length - 1];
  if (!OBJECT_RE.test(object)) return null;
  return key;
}

/** The same check, returning the `/files/...` path the frontend renders. */
export function ownedMediaUrl(value: unknown, userId: string): string | null {
  const key = ownedMediaKey(value, userId);
  return key ? `/files/${key}` : null;
}

/**
 * Filter a list of product images down to the ones this merchant owns.
 *
 * Silent, not an error: a merchant re-saving a product whose image was
 * removed should not be blocked from fixing the price. What they cannot do is
 * introduce a reference to something that is not theirs.
 */
export function ownedMediaUrls(value: unknown, userId: string, max = 8): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const url = ownedMediaUrl(item, userId);
    if (url && !out.includes(url)) out.push(url);
    if (out.length >= max) break;
  }
  return out;
}

// ===========================================================================
//  PART TWO — EVERY PLACE AN R2 KEY CAN BE STORED, WRITTEN DOWN ONCE
// ===========================================================================

/**
 * WHY THIS EXISTS, AND WHAT IT ALMOST COST.
 *
 * The orphan sweeper decides which R2 objects nothing points at any more, and
 * then offers to delete them. Its notion of "pointed at" was
 * `MEDIA_COLUMNS` + `MEDIA_JSON_COLUMNS` in `productDeletion.ts`: four product
 * tables and eight JSON columns on `products`. That is the set a PRODUCT
 * delete needs. It is not the set the BUCKET needs, and the difference is not
 * academic:
 *
 *   - The home page's hero banners are uploaded through
 *     `POST /api/uploads` with `purpose=product` (src/components/
 *     AdminHomeSettings.tsx calls `uploadFile(file, 'product')`), so they are
 *     stored under `products/catalog/gallery/<id>.webp` — INSIDE the prefix the
 *     sweeper lists — and the pointer to them lives in a JSON document in
 *     `admin_settings.value` under the key `homeBanners`, which the sweeper
 *     never read. Every banner on the front page was therefore an "orphan".
 *   - `order_items.image_snapshot` is the thumbnail a customer sees when they
 *     open an order they placed last year. It is the whole reason the column
 *     exists (the product may be gone). The sweeper never read it either, so
 *     every past order's picture was an "orphan" too.
 *
 * Pressing the cleanup button would have deleted both. This module is the
 * answer: ONE manifest of every column an R2 key can reach, walked by the
 * sweeper, and a coverage audit that REFUSES the destructive run when the live
 * schema contains a key-bearing column the manifest has not been taught about.
 *
 * A COLUMN SCAN IS NOT ENOUGH, AND THAT IS THE POINT.
 * `admin_settings.value` is a JSON blob. `reviews.media` is a JSON array of
 * `{key, kind}`. `products.options` is the legacy embedded option list, each
 * entry carrying its own `image`. A scan that compares column VALUES to keys
 * sees none of them — which is exactly how the banners became invisible. Every
 * `kind: 'json'` source below is PARSED and walked to any depth. If a future
 * change narrows this back to a column comparison, the banners disappear
 * again, silently, and the first symptom is a blank home page.
 */

/** How a source stores its reference. */
export type MediaSourceKind =
  /** One reference per cell: a bare key, `/files/<key>`, or an absolute URL. */
  | 'text'
  /** A JSON document; keys may sit at any depth inside it. */
  | 'json';

export interface MediaRefSource {
  table: string;
  column: string;
  kind: MediaSourceKind;
  /** Why this column can keep an object alive. Read by a human, not by code. */
  why: string;
  /**
   * A `WHERE` clause that narrows the source to the rows that can still be
   * SHOWING the object, when the whole table would be a LEDGER.
   *
   * WHY THIS EXISTS AT ALL. A source that is never pruned makes every key it
   * ever mentioned immortal: the queue re-checks before it deletes, finds the
   * key in a row from March, closes the job `skipped_shared` — permanently,
   * because a closed job leaves `pending` once — and the bytes can never be
   * removed by anything. It also inflates `r2_objects_protected`, which the
   * owner was told means "a live page still shows this", until that number
   * stops distinguishing a home banner from a dead import record.
   *
   * It is applied ONLY when every column it names exists in the live schema;
   * otherwise the source is read whole, because a narrowing that silently
   * fails to parse is the one mistake that deletes a live picture.
   */
  where?: string;
  /** The columns `where` reads. The clause is used only if the schema has them. */
  whereColumns?: readonly string[];
}

/**
 * THE SOURCES THE SWEEPER WALKS.
 *
 * Derived from the schema (every migration parsed) and from the code that
 * writes each column — not from memory. A table or column that a migration
 * later drops degrades to being skipped, exactly like `MEDIA_JSON_COLUMNS`
 * does, because the walker intersects this list with `pragma_table_info`
 * before it issues a statement.
 */
export const MEDIA_REFERENCE_SOURCES: readonly MediaRefSource[] = [
  // ---- the catalogue ----------------------------------------------------
  /**
   * A SECTION'S OWN COVER — the one picture on the home page that an admin
   * CHOSE rather than the storefront borrowing one (migration 0100).
   *
   * It is not narrowed by `active`. A deactivated section still holds its
   * artwork and the owner reactivates sections routinely, so letting the
   * sweeper take the file the moment a section is switched off would make
   * "deactivate, then activate again" silently lose the picture. The object is
   * two kilobytes; the re-upload is the expensive thing.
   */
  { table: 'catalogs', column: 'image_key', kind: 'text', why: 'the cover an admin set for a section on the home page (0100)' },
  { table: 'product_images', column: 'r2_key', kind: 'text', why: 'the canonical product image key (0048)' },
  { table: 'product_images', column: 'url', kind: 'text', why: 'the delivery path for the same image; older rows have only this' },
  { table: 'product_option_values', column: 'image', kind: 'text', why: 'per-option swatch' },
  { table: 'product_colors', column: 'image', kind: 'text', why: 'per-colour swatch' },
  { table: 'products', column: 'images', kind: 'json', why: 'the JSON mirror of the gallery; pre-0018 products have ONLY this' },
  { table: 'products', column: 'description_images', kind: 'json', why: 'long-description artwork' },
  { table: 'products', column: 'description_videos', kind: 'json', why: 'long-description video objects' },
  { table: 'products', column: 'options', kind: 'json', why: 'legacy embedded options, each with its own image' },
  { table: 'products', column: 'colors', kind: 'json', why: 'legacy embedded colours, each with its own image' },
  { table: 'products', column: 'content_blocks', kind: 'json', why: 'rich content blocks embed image references' },
  { table: 'products', column: 'usage_guide', kind: 'json', why: 'illustrated usage steps' },
  { table: 'products', column: 'how_to_use', kind: 'json', why: 'illustrated how-to steps' },
  { table: 'products', column: 'how_to_use_ar', kind: 'json', why: 'the Arabic how-to, same shape' },
  { table: 'products', column: 'how_to_use_ckb', kind: 'json', why: 'the Kurdish how-to, same shape' },
  { table: 'products', column: 'specifications', kind: 'json', why: 'spec rows may carry a diagram' },
  { table: 'products', column: 'condition_doc', kind: 'json', why: '0085 condition evidence photographs' },
  { table: 'products', column: 'stores', kind: 'json', why: 'vendor rows; off-site URLs are dropped by mediaKeyFromRef, ours are not' },
  /**
   * THE IMPORT'S STAGING WINDOW — AND ONLY THE WINDOW.
   *
   * An import writes `products/import/<sha>` objects during the PREVIEW, before
   * any product row names them, so between preview and confirm this payload is
   * the only thing standing between those objects and the sweeper. That is a
   * real reference and it is why these two lines exist.
   *
   * But `product_imports` rows are never deleted — `worker/routes/adminImport
   * .ts` has an INSERT and an UPDATE and no DELETE, and no prune job exists —
   * so once the import is APPLIED the payload keeps naming those keys for
   * ever, long after the products were deleted. Scanned unconditionally it
   * made every image that ever arrived through a ZIP permanently undeletable:
   * the queue would find the key here, close the job `skipped_shared`, and no
   * admin action could ever reach those bytes again.
   *
   * A preview owns its staged objects for one explicit, durable window. The
   * apply lease renews that window while confirm is actively reading and
   * writing; after both timestamps expire, an abandoned row is a ledger and
   * must no longer defeat its staging cleanup job. Once `state = 'applied'`,
   * `product_images` is the authority regardless of either old timestamp.
   */
  {
    table: 'product_imports',
    column: 'payload',
    kind: 'json',
    why: 'an import writes products/import/<sha> objects before any row names them — the staging window only',
    where:
      "state = 'preview' AND (" +
      "media_stage_until > strftime('%Y-%m-%dT%H:%M:%fZ','now') OR " +
      "(apply_token <> '' AND apply_lease_until > strftime('%Y-%m-%dT%H:%M:%fZ','now')))",
    whereColumns: ['state', 'media_stage_until', 'apply_token', 'apply_lease_until'],
  },
  {
    table: 'product_imports',
    column: 'report',
    kind: 'json',
    why: 'the import report echoes the keys it stored, while the import is still staged',
    where:
      "state = 'preview' AND (" +
      "media_stage_until > strftime('%Y-%m-%dT%H:%M:%fZ','now') OR " +
      "(apply_token <> '' AND apply_lease_until > strftime('%Y-%m-%dT%H:%M:%fZ','now')))",
    whereColumns: ['state', 'media_stage_until', 'apply_token', 'apply_lease_until'],
  },
  { table: 'bundles', column: 'image', kind: 'text', why: 'bundle cover art' },
  { table: 'investment_items', column: 'image', kind: 'text', why: 'investment listing art' },

  // ---- the home page and everything else the owner authors ---------------
  /**
   * THE ONE THAT WOULD HAVE COST THE FRONT PAGE.
   *
   * Every owner-authored setting is a row in this table and the value is JSON.
   * `homeBanners`, `homeSectionItems` and `mainPageMedia` all keep image
   * pointers here, and there is no column whose NAME says so. Scanning the
   * whole table — rather than naming three settings — is deliberate: a setting
   * added next month that holds a picture is covered on the day it is added,
   * with nobody having to remember this file exists.
   *
   * `mainPageMedia` needs one extra step and gets it in the walker: it stores
   * a BARE OBJECT NAME (`banner-1-a1b2.webp`), not a key, and the real object
   * is `UiUx/MainPage/` + that name. Read as a plain reference it resolves to
   * the wrong key and the real file still looks unreferenced.
   */
  { table: 'admin_settings', column: 'value', kind: 'json', why: 'homeBanners / homeSectionItems / mainPageMedia and every future owner-authored setting' },

  // ---- history: rows that must keep showing a picture after the product is gone
  {
    table: 'order_items',
    column: 'image_snapshot',
    kind: 'text',
    why: 'the thumbnail on a past order; the product row may no longer exist, which is the reason the snapshot column exists at all',
  },
  { table: 'mystery_allocations', column: 'image_snapshot', kind: 'text', why: 'the revealed item on a past mystery draw' },
  { table: 'community_orders', column: 'offer_snapshot', kind: 'json', why: 'a merchant offer as it was accepted, images included' },
  { table: 'invoices', column: 'snapshot', kind: 'json', why: 'invoice lines keep the item image they were issued with' },

  // ---- merchants and their storefronts ----------------------------------
  { table: 'merchant_stores', column: 'logo_key', kind: 'text', why: 'store logo' },
  { table: 'merchant_stores', column: 'banner_key', kind: 'text', why: 'store banner' },
  { table: 'merchant_services', column: 'image_key', kind: 'text', why: 'store-builder service card art' },
  { table: 'merchant_showcase', column: 'image_key', kind: 'text', why: 'store-builder showcase art' },
  { table: 'community_merchants', column: 'avatar_key', kind: 'text', why: 'merchant avatar' },
  { table: 'community_products', column: 'images', kind: 'json', why: 'merchant product gallery' },
  { table: 'community_products', column: 'options', kind: 'json', why: 'merchant product options carry images' },
  { table: 'community_products', column: 'colors', kind: 'json', why: 'merchant product colours carry images' },
  { table: 'merchant_reviews', column: 'images', kind: 'json', why: 'photographs a buyer attached to a merchant review' },
  // 0126 — the catalogue model (W2-F): a product's ordered pictures and videos,
  // a variant's own picture, and a collection's cover. `community_products.images`
  // stays above as the JSON mirror of the pictures.
  { table: 'community_product_media', column: 'media_key', kind: 'text', why: 'a merchant product picture or video, in gallery order (0126)' },
  { table: 'community_product_variants', column: 'image_key', kind: 'text', why: 'the picture a product variant shows when chosen (0126)' },
  { table: 'merchant_store_sections', column: 'image_key', kind: 'text', why: 'a store collection cover (0126)' },
  // 0123 — a store's app-icon renditions (worker/lib/storeIcons.ts). Each is
  // served to every installed app and home-screen icon of that store; the
  // replaced ones are queued on media_cleanup_jobs, whose guarded drain must
  // see these to know which renditions are still live.
  { table: 'merchant_store_icons', column: 'icon192_key', kind: 'text', why: 'the store app icon, 192 px (manifest)' },
  { table: 'merchant_store_icons', column: 'icon512_key', kind: 'text', why: 'the store app icon, 512 px (manifest, share card)' },
  { table: 'merchant_store_icons', column: 'maskable512_key', kind: 'text', why: 'the store app icon, 512 px maskable (Android)' },
  { table: 'merchant_store_icons', column: 'apple180_key', kind: 'text', why: 'the store apple-touch icon, 180 px (iOS home screen)' },
  { table: 'merchant_store_icons', column: 'favicon32_key', kind: 'text', why: 'the store tab icon, 32 px' },
  { table: 'merchant_store_icons', column: 'source_key', kind: 'text', why: 'the logo the renditions were cut from; kept alive until they are re-cut' },
  // 0122 — a store page's layout (packages/storeLayout): banner, gallery,
  // image+text and video blocks hold media KEYS at any depth. Every retained
  // revision counts, not only the published one — a merchant can restore any
  // of the last 50, and a restore that brought back a deleted picture would
  // be a broken page. Registered in the same change as the columns, because an
  // unclassified `*_json` column refuses the whole guarded sweep.
  { table: 'store_layout_drafts', column: 'layout_json', kind: 'json', why: 'the merchant\'s working store layout (0122) — block media keys' },
  { table: 'store_layout_revisions', column: 'layout_json', kind: 'json', why: 'published store layouts (0122), the last 50 per store, each restorable' },

  // ---- customers ---------------------------------------------------------
  { table: 'users', column: 'avatar_key', kind: 'text', why: 'account avatar' },
  { table: 'users', column: 'profile_json', kind: 'json', why: 'display profile; printer photos have been stored here' },
  { table: 'reviews', column: 'media', kind: 'json', why: 'review photographs and videos — [{key, kind}]' },
  { table: 'review_rewards', column: 'instagram_evidence', kind: 'text', why: 'the private evidence object an admin reviews' },
  { table: 'user_notifications', column: 'meta', kind: 'json', why: 'a notification may carry the image it is about' },

  // ---- money, support, and everything private ---------------------------
  { table: 'wallet_transactions', column: 'receipt_key', kind: 'text', why: 'the private deposit receipt' },
  { table: 'chat_messages', column: 'file_key', kind: 'text', why: 'a chat attachment' },
  { table: 'claim_messages', column: 'file_key', kind: 'text', why: 'a warranty-claim attachment' },
  { table: 'community_complaint_messages', column: 'file_key', kind: 'text', why: 'a complaint attachment' },
  // Migration 0107. Registered IN THE SAME COMMIT as the column, because
  // `verifyMediaCoverage` refuses the whole sweep while ANY key-bearing
  // column is unclassified — an unregistered support attachment would not
  // merely be missed, it would silently turn the entire guarded cleanup into
  // a no-op for every other prefix too.
  { table: 'support_ticket_messages', column: 'file_key', kind: 'text', why: 'a support-ticket attachment' },
  { table: 'warranty_claims', column: 'evidence', kind: 'json', why: 'private evidence keys' },
  { table: 'return_cases', column: 'evidence', kind: 'json', why: 'private evidence keys' },
  { table: 'restriction_cases', column: 'evidence', kind: 'json', why: 'private evidence keys' },
  { table: 'kyc_cases', column: 'evidence_keys', kind: 'json', why: 'identity documents under the private kyc/ prefix' },
  { table: 'kyc_cases', column: 'payload', kind: 'json', why: 'the case payload references the same documents' },

  // ---- printing ----------------------------------------------------------
  { table: 'community_request_files', column: 'file_key', kind: 'text', why: 'the uploaded 3D model or drawing' },
  { table: 'community_request_files', column: 'preview_key', kind: 'text', why: 'the derived preview mesh the viewer serves' },
  { table: 'print_analyses', column: 'file_key', kind: 'text', why: 'the analysed model object' },

  // ---- outbound ----------------------------------------------------------
  { table: 'tg_admin_notifications', column: 'photo_key', kind: 'text', why: 'the picture a Telegram admin notification sends' },
] as const;

/**
 * COLUMNS THAT LOOK LIKE THEY HOLD AN OBJECT KEY AND DO NOT.
 *
 * The coverage audit below casts a deliberately WIDE net — any TEXT column
 * whose name reads like media, plus every TEXT column that defaults to `[]` or
 * `{}` (a JSON document is where a key hides without the name saying so). That
 * net catches a great deal that is not media, and every catch has to be
 * DECIDED rather than ignored, because "it did not look like media to me" is
 * the exact reasoning that lost the banners.
 *
 * So: a column is either a source above, or it is here with the reason it is
 * not one. Anything in neither list makes the destructive sweep refuse to run.
 * A future migration cannot quietly add a third category.
 *
 * WHEN IN DOUBT, MAKE IT A SOURCE, NOT AN EXCLUSION. Over-scanning costs a
 * read and reports one orphan fewer. Under-scanning deletes a picture that is
 * on a live page. Those are not comparable mistakes.
 */
export const NON_MEDIA_COLUMNS: Readonly<Record<string, string>> = {
  // -- identifiers and de-duplication tokens; never a path ------------------
  'admin_settings.key': 'the setting name',
  'bnpl_ledger.idempotency_key': 'request de-duplication token',
  'community_escrow_events.idempotency_key': 'request de-duplication token',
  'farm_ledger.idempotency_key': 'request de-duplication token',
  'farm_requests.idempotency_key': 'request de-duplication token',
  'inventory_ledger.idempotency_key': 'request de-duplication token',
  // 0098 — the same token shape, on the two tables the FIFO inventory layer
  // makes idempotent: a receipt (a double-tapped Receive) and a lot allocation
  // (a replayed deduction).
  'incoming_inventory_receipts.idempotency_key': 'request de-duplication token',
  'order_item_inventory_allocations.idempotency_key': 'request de-duplication token',
  'merchant_payout_ledger.idempotency_key': 'request de-duplication token',
  'merchant_ledger_entries.event_key': 'ledger idempotency key (0121)',
  'community_request_matches.reasons': 'eligibility reason codes, JSON array of fixed codes (0132)',
  'request_file_reads.file_id': 'a community_request_files row id, not a storage key (0132)',
  'merchant_payouts.event_key': 'payout idempotency key (0121)',
  'merchant_payouts.method_snapshot': 'payout channel and account as requested — JSON, no media (0121)',
  'orders.idempotency_key': 'request de-duplication token',
  'orders.client_idempotency_key': 'request de-duplication token',
  'reward_claims.idempotency_key': 'request de-duplication token',
  'order_payment_settlements.event_key': 'event identity, e.g. cod:<ref>',
  'outbox.event_key': 'event identity, e.g. invoice:ORD-X:1',
  'tg_admin_notifications.event_key': 'event identity',
  'user_notifications.event_key': 'event identity',
  'wallet_adjustments.event_key': 'event identity',
  'wallet_holds.event_key': 'event identity',
  'wallet_transactions.event_key': 'event identity',
  /**
   * 0103/0104 — THE TWO GINI STRINGS, AND NEITHER IS A PATH.
   *
   * `products.gini_url` is an EXTERNAL link: the product's page in the Qi Card
   * instalments app, typed by an administrator and passed through `safeLink`
   * before it is ever stored. Nothing uploads to it and nothing serves from
   * it, so an orphan sweep that treated it as a reference would be scanning
   * somebody else's website for our bytes.
   *
   * `orders.gini_receipt_barcode` is the code printed on the customer's Gini
   * collection slip, captured by the admin scanner as TEXT. It identifies a
   * receipt in Gini's system; there is no image of it in our bucket.
   *
   * Classified rather than left unknown because the sweep refuses to run at
   * all while one column is unclassified — which is the right default, and
   * the reason this list exists.
   */
  'products.gini_url': 'an external link to the product in the Gini app',
  'orders.gini_receipt_barcode': 'the Gini collection barcode, as text',
  // 0115 — WHEN the customer confirmed receiving a community-store order (the
  // «استلمت طلبي» that releases the merchant's credit): an ISO timestamp,
  // never an image of a receipt.
  'orders.receipt_confirmed_at': 'a timestamp — when the customer confirmed receipt',
  'rate_limits.key': 'the throttle bucket, e.g. login:1.2.3.4',
  'policy_documents.key': 'the policy slug — terms, privacy, warranty',
  'policy_acceptances.policy_key': 'the same policy slug',
  'telegram_admin_topics.topic_key': 'a Telegram forum topic name',
  'tg_admin_notifications.topic_key': 'a Telegram forum topic name',
  'price_history.variant_key': "'' | option:<id> | color:<id>",
  'product_option_values.variant_key': 'the same variant addressing string',
  'product_variants.combo_key': 'the sorted option-id tuple that identifies a variant',
  'product_import_items.item_key': 'the CSV row key (SKU or slug) used to resume one import item, not an R2 key',
  'product_imports.media_stage_until': 'the UTC expiry of a staged import reference, not an object path',
  'model_view_tokens.file_id': 'a row id in community_request_files, not a key',
  'community_print_requests.primary_file_id': 'a row id in community_request_files, not a key',
  'printer_models.slicer_profile_id': 'a slicer profile identifier',
  'print_analyses.profile_revision': 'a slicer profile revision string',
  'print_analyses.orientation_key': 'which orientation was measured, e.g. z-up',
  'print_analyses.file_sha256': 'the content hash of the analysed model, not its location',
  'wallet_deposit_meta.attachment_fingerprint': 'a hash used to detect a re-used receipt image, not its key',
  // Migration 0110. Classified in the same change as the column: left unknown,
  // it would refuse the WHOLE guarded sweep (see `verifyMediaCoverage`).
  // 0126 — the catalogue model (W2-F). A swatch is a palette NAME
  // (packages/catalog/src/palette.ts), and the SKU snapshot is the text a
  // merchant gave the variant — neither is a key.
  'community_product_option_values.swatch': "a palette colour name, e.g. 'red' — never CSS, never a key",
  'order_items.sku_snapshot': 'the SKU text of the variant at order time',
  'chat_messages.attachment_kind': "'image' | 'video' | 'audio' | 'file' — what `file_key` holds, not a key",
  // 0123 — bookkeeping of the app-icon renditions. The net does not catch
  // these two names; they are written down anyway because each string embeds
  // the logo key it is about (`<recipe>:<colour>:<key>`). They record which
  // attempt failed / which one is in flight — nothing is SHOWN from them, and
  // the live pointer to the logo is merchant_stores.logo_key.
  'merchant_store_icons.failed_fingerprint': 'which (recipe, colour, logo) failed to render — bookkeeping, not a display',
  'merchant_store_icons.lease_fingerprint': 'which (recipe, colour, logo) is rendering now — a lease, not a display',

  // -- the game. every *_key here names a game asset, not an R2 object ------
  'farm_achievements.key': 'the achievement id',
  'farm_achievements.reward_json': 'points and currency, no media',
  'farm_events.payload_json': 'simulation events, no media',
  'farm_jobs.product_key': 'an in-game product id',
  'farm_jobs.colors_json': 'in-game filament colour names',
  'farm_jobs.customer_name': 'a generated in-game name',
  'farm_printers.model_key': 'an in-game printer model id',
  'farm_printers.upgrades_json': 'in-game upgrade ids',
  'farm_profiles.location_key': 'an in-game room id',
  'farm_profiles.stats_json': 'counters',
  'farm_profiles.tutorial_json': 'tutorial progress flags',
  'farm_requests.result_json': 'the reply a farm action returned',

  // -- OUR OWN BOOKKEEPING ABOUT OBJECTS ----------------------------------
  /**
   * These bookkeeping rows DO hold object keys, and they are excluded on purpose: they
   * are the ledger that says an object exists or is being removed, not a page
   * that displays it. Counting `media_cleanup_jobs.object_key` as a reference
   * would make every queued deletion cancel itself, and counting
   * `file_objects.object_key` would make the reference set the whole bucket
   * and the sweeper a no-op.
   */
  'file_objects.object_key': 'the upload ledger — an inventory of objects, not a page that shows one',
  'media_cleanup_jobs.object_key': 'the deletion queue — treating it as a reference would cancel every delete',
  'media_object_guards.object_key': 'the attach/delete lock — control state, not a page that shows the object',
  'file_migration_log.old_key': 'an append-only record of a move that already happened',
  'file_migration_log.new_key': 'the same record; the live pointer is in the table that was updated',

  // -- links to somewhere that is not our bucket ---------------------------
  'product_images.source_url': "the VENDOR's URL the image was ingested from — not our file to delete",
  'price_reports.url': 'a competitor link a customer typed; never fetched, never ours',
  'community_print_requests.source_url': 'an external model page the customer pasted',
  'community_print_requests.source_meta': 'provider metadata for that external page',
  'merchant_stores.social_links': 'off-platform profile links',
  'merchant_stores.profile_links': 'off-platform profile links',

  // -- lists of ids, names, numbers and settings ---------------------------
  'bundle_components.option_value_ids': 'option ids',
  'cart_bundle_choices.option_value_ids': 'option ids',
  'cart_items.option_value_ids': 'option ids',
  'mystery_allocations.option_value_ids': 'option ids',
  'mystery_pool_entries.option_value_ids': 'option ids',
  'order_items.option_value_ids': 'option ids',
  'mystery_pools.require_catalog_ids': 'catalog ids',
  'mystery_pools.require_facet_ids': 'facet ids',
  'gift_pool_items.compat_products': 'product ids',
  'gift_pools.items': 'product ids and quantities',
  'gift_entitlements.chosen_options': 'option ids',
  'gift_entitlements.contents': 'product ids and quantities',
  'gift_redemptions.options': 'option ids',
  'gift_redemptions.contents': 'product ids and quantities',
  'offer_windows.required_tiers': 'membership tier names',
  'coupons.fulfillment_types': 'enum words',
  'coupons.transport_methods': 'enum words',
  'coupons.delivery_methods': 'enum words',
  'community_products.delivery_methods': 'enum words',
  'products.shipping_methods': 'enum words',
  'products.payment_options': 'enum words',
  'products.preorder_transports': 'enum words',
  'products.sale_types': 'enum words',
  'products.membership_prices': 'numbers per tier',
  'products.warranty_plans': 'warranty durations and prices',
  'products.labels': 'badge words',
  'products.hashtags': 'tag words',
  'products.algorithm_tags': 'tag words',
  'products.features': 'bullet text',
  'products.spec_fields': 'spec field names',
  'products.ops_policy': 'operational flags',
  'products.translation_meta': 'which fields the owner authored by hand',
  'merchant_printers.materials': 'material names',
  'merchant_printers.colors': 'colour names',
  'merchant_request_prefs.processes': 'process names',
  'merchant_request_prefs.materials': 'material names',
  'merchant_request_prefs.colors': 'colour names',
  'merchant_request_prefs.capabilities': 'capability words',
  'merchant_request_prefs.governorates': 'Iraqi governorate names',
  'merchant_request_prefs.delivery': 'delivery settings',
  'merchant_services.materials': 'material names',
  'merchant_stores.categories': 'category slugs',
  'merchant_stores.service_areas': 'governorate names',
  'merchant_stores.business_hours': 'opening times',
  'merchant_stores.policies': 'policy prose',
  'merchant_stores.delivery_settings': 'fees and ranges',
  'merchant_stores.profile_facts': 'short display facts',
  'printer_models.materials': 'material names',
  'restriction_cases.benefit_flags': 'which benefits are suspended',
  'review_rewards.eligibility': 'why a reward was or was not granted',
  'community_request_matches.score_detail': 'the match score breakdown',
  'community_request_files.file_name': 'the name the customer uploaded under; the key is file_key',
  'print_analyses.file_name': 'the name the customer uploaded under; the key is file_key',
  'print_analyses.unmeasured': 'which measurements could not be taken',

  // -- snapshots made of text and numbers, never of a location -------------
  'orders.address_snapshot': 'a postal address',
  'orders.delivery_method_snapshot': 'a delivery method and its fee',
  'orders.membership_tier_snapshot': 'a tier name',
  'orders.coupon_snapshot': 'a coupon code and its discount',
  'orders.support_snapshot': 'the support terms in force',
  'orders.benefit_snapshot': 'the membership benefits in force',
  'order_items.name_snapshot': 'the product name as sold',
  'order_items.option_snapshot': 'the human-readable variant text',
  'order_items.pricing_snapshot': 'the price ladder as sold',
  'order_items.warranty_snapshot': 'the warranty as sold',
  'order_items.transport_snapshot': 'the transport choice as sold',
  'mystery_allocations.name_snapshot': 'the item name as drawn',
  'mystery_allocations.variant_snapshot': 'the variant text as drawn',
  'mystery_allocations.reveal_stage_snapshot': 'which reveal stage applied',
  'price_protection_claims.policy_snapshot': 'the price-protection terms in force',
  'return_cases.delivered_at_snapshot': 'a timestamp',
  'review_rewards.quality_snapshot': 'the quality score breakdown',
  'reviews.quality_summary': 'the moderation summary text',
  'print_quotes.snapshot': 'the quote numbers as issued',
  'community_print_requests.analysis': 'measured volume, time and mass',
  'community_print_requests.estimate': 'the price estimate numbers',
  // Print requests v2 (W5-A, 0130). Snapshots carry FILE ROW IDS, names,
  // kinds and sizes — the keys stay in community_request_files.file_key.
  'community_request_revisions.spec': 'a request revision: spec facts, a file row id, an external link',
  'community_request_revisions.files': 'file row ids, names, kinds and sizes of that revision — no key',
  'community_request_revisions.estimate': 'the price estimate numbers',
  'community_offer_revisions.terms': 'an offer revision: price terms and text, no media',
  'community_offers.material_ids': 'catalogue material ids',
  'community_orders.request_snapshot': 'the accepted request revision (as community_request_revisions)',
  'community_orders.contact_snapshot': 'names, phones and a delivery address — no media',
  'membership_benefit_versions.before_json': 'benefit rules before an edit',
  'membership_benefit_versions.after_json': 'benefit rules after an edit',
  'membership_benefit_versions.rules_json': 'benefit rules',
  'warranty_receipts.coverage_text': 'the printed coverage sentence',
  'warranty_receipts.coverage_text_en': 'the same sentence in English',
  'warranty_receipts.terms_json': 'the printed terms',
  'warranty_receipts.retailer_json': 'the retailer name and address',
  'users.profile_prompt_at': 'a timestamp',

  // -- LEDGERS AND LOGS THAT MENTION A KEY WITHOUT SHOWING IT --------------
  /**
   * An EVENT LOG is not a page.
   *
   * `core_outbox_events.envelope` really does contain object keys:
   * `productPersistence.ts` publishes `ProductAddedV1` with
   * `images: doc.media.map(m => m.key || m.url)`, and `eventBus.ts` writes the
   * signed envelope into this column inside the save batch. These two lines
   * are here because that has to be SAID, not because the column was missed —
   * and the answer is that it is an exclusion, for the same reason
   * `file_objects.object_key` is one: an event that was published in March
   * records what the catalogue looked like in March. Scanning it would make
   * every picture the shop has ever had immortal, and `product_imports` above
   * is the worked example of what that costs. Nothing renders these rows to a
   * customer; if a key here is live, the row that SHOWS it is scanned.
   */
  'core_outbox_events.envelope': 'the signed event log — it records what was shown once, not what is shown now',
  'outbox.payload': 'a queued email or Telegram message body; the record that shows the picture is scanned',

  // -- words the wide net catches that are numbers, ids and labels ---------
  'community_merchants.badge': 'a tier label (`new`, `trusted`), not a picture',
  'community_merchants.badge_override': 'an admin override of that same label',
  'policy_acceptances.document_id': 'a policy_documents id',
  'product_imports.payload_hash': 'a hash of the previewed payload, used to match confirm to preview',
  'warranty_receipts.receipt_no': 'a printed receipt number',
  'warranty_receipts.order_receipt_no': 'the order receipt number',
  'warranty_receipts.replaced_by_receipt_id': 'a warranty_receipts id',
  'warranty_receipts.replaces_receipt_id': 'a warranty_receipts id',
};

/**
 * THE WIDE NET. A column is a CANDIDATE — something a human must classify —
 * when its name reads like media, or when it is a JSON document.
 *
 * The second rule is the important one. `products.options` and
 * `admin_settings.value` do not contain a single media word between them, and
 * both hold image references. A name-only detector would have told us this
 * manifest was complete while the banners were still invisible.
 *
 * WHAT THIS GUARANTEES, STATED EXACTLY, BECAUSE THE EARLIER WORDING CLAIMED
 * MORE THAN IT DELIVERS. The property is: a MEDIA-NAMED or JSON-DEFAULTED
 * column cannot enter the schema without a human classifying it. It is NOT
 * "no column can ever escape". A migration adding `landing.headline TEXT` with
 * a NULL default and an ordinary name is not a candidate and never will be —
 * and `core_outbox_events.envelope` and `outbox.payload`, which DO carry
 * object keys, escaped exactly that way until the words `envelope` and
 * `payload` were added to the pattern above and both were recorded below.
 *
 * WHY NOT EVERY TEXT COLUMN. That rule is the complete one, and it was
 * measured: 1475 of this schema's text columns have a NULL default and an
 * ordinary name. Requiring a written reason for each would make the exclusion
 * list ten times the size of the file, and — far worse — on the day it landed
 * `unclassified` would be non-empty and the owner's cleanup button would
 * refuse every press until all 1475 were written out. The honest position is
 * this: the net catches the shape the defect actually had, the wording above
 * no longer overstates it, and a reviewer adding a key-bearing column with an
 * innocuous name must add it here by hand.
 */
const MEDIA_NAME_PATTERN =
  /(image|img|photo|logo|banner|icon|media|thumb|avatar|cover|picture|attach|file|object|asset|gallery|url|evidence|snapshot|screenshot|poster|background|backdrop|render|preview|hero|artwork|swatch|sticker|badge|seal|stamp|scan|video|clip|audio|qr_?code|receipt|document|envelope|payload|blocks?$|_key$|^key$|_json$|content_blocks|usage_guide|how_to_use)/i;

/** A TEXT column declared `DEFAULT '[]'` or `DEFAULT '{}'` is a JSON document. */
function isJsonDefault(dflt: string | null): boolean {
  if (typeof dflt !== 'string') return false;
  const v = dflt.trim().replace(/^'|'$/g, '');
  return v === '[]' || v === '{}';
}

/** Only a text-ish column can hold a key; SQLite reports the declared type. */
function isTextish(type: string | null): boolean {
  const t = String(type ?? '').toUpperCase();
  return t === '' || /CHAR|CLOB|TEXT|BLOB/.test(t);
}

export interface SchemaColumn {
  name: string;
  type: string | null;
  dflt: string | null;
}

/** table name → its columns, as the database reports them right now. */
export type LiveSchema = Map<string, SchemaColumn[]>;

/** The slice of D1 this module needs, so tests can drive it with node:sqlite. */
export interface MediaRefDb {
  prepare(sql: string): D1PreparedStatement;
}

/**
 * The schema AS IT IS, asked of the database.
 *
 * A manifest is a claim about the schema and a claim can go stale between a
 * migration and a deploy — the same reasoning `productDeletion.ts` gives for
 * intersecting its registries with `pragma_table_info`. Everything below works
 * from this, never from what the file believes.
 */
export async function readLiveSchema(db: MediaRefDb): Promise<LiveSchema> {
  /**
   * ONE STATEMENT, NOT ONE PER TABLE.
   *
   * The first version asked `sqlite_master` for the table names and then
   * issued a `pragma_table_info` for each — 194 round trips on this schema
   * before a single reference had been read, growing with every migration
   * rather than with the data. `pragma_table_info` is a table-valued function
   * and joins to `sqlite_master` correlated on the table name, so the whole
   * schema comes back in one query.
   *
   * The per-table loop is KEPT as a fallback and is not dead code: the joined
   * form needs SQLite's table-valued pragma support, and this function is the
   * gate in front of a destructive delete. If a runtime ever refuses that
   * syntax, the right answer is the slow read, never an empty schema — an
   * empty schema makes `auditMediaCoverage` report zero candidates and zero
   * unclassified columns, which reads as "provably complete" and is the exact
   * false green this whole guard exists to prevent.
   */
  const schema: LiveSchema = new Map();
  try {
    const joined = await db
      .prepare(
        `SELECT m.name AS tbl, p.name AS col, p.type AS type, p.dflt_value AS dflt
           FROM sqlite_master m
           JOIN pragma_table_info(m.name) p
          WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'
          ORDER BY m.name, p.cid`
      )
      .all<{ tbl: string; col: string; type: string | null; dflt: string | null }>();
    for (const row of joined.results ?? []) {
      const table = String(row.tbl);
      const cols = schema.get(table) ?? [];
      cols.push({ name: String(row.col), type: row.type ?? null, dflt: row.dflt ?? null });
      schema.set(table, cols);
    }
    if (schema.size) return schema;
  } catch {
    // Fall through to the per-table read below.
  }

  schema.clear();
  const tables = await db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all<{ name: string }>();
  for (const row of tables.results ?? []) {
    const table = String(row.name);
    // The table name comes from sqlite_master, so it cannot be injected; it is
    // still quoted because a table named with a reserved word is legal.
    const cols = await db
      .prepare(`SELECT name, type, dflt_value FROM pragma_table_info('${table.replace(/'/g, "''")}')`)
      .all<{ name: string; type: string | null; dflt_value: string | null }>();
    schema.set(
      table,
      (cols.results ?? []).map((c) => ({ name: String(c.name), type: c.type ?? null, dflt: c.dflt_value ?? null }))
    );
  }
  return schema;
}

/** Every `table.column` a human must have classified, given this schema. */
export function mediaColumnCandidates(schema: LiveSchema): string[] {
  const out: string[] = [];
  for (const [table, cols] of schema) {
    for (const col of cols) {
      if (!isTextish(col.type)) continue;
      if (MEDIA_NAME_PATTERN.test(col.name) || isJsonDefault(col.dflt)) out.push(`${table}.${col.name}`);
    }
  }
  return out.sort();
}

export interface CoverageAudit {
  /** Candidates that are neither a source nor a recorded exclusion. */
  unclassified: string[];
  /** Sources the live schema no longer has — reported, never fatal. */
  stale_sources: string[];
  /** Exclusions the live schema no longer has — housekeeping, never fatal. */
  stale_exclusions: string[];
}

/**
 * IS THE REFERENCE SET PROVABLY COMPLETE FOR THIS SCHEMA?
 *
 * `unclassified` is the only answer that matters. A column in it is a column
 * that can hold an object key and that nothing in this file has an opinion
 * about — which means the sweeper's "nothing points at this object" is a
 * guess. The destructive path turns that guess into a permanent delete, so it
 * refuses instead. A migration that adds `promo_banners.image_key` makes this
 * list non-empty on the very next request, and the fix is one line here.
 */
export function auditMediaCoverage(schema: LiveSchema): CoverageAudit {
  const known = new Set<string>(Object.keys(NON_MEDIA_COLUMNS));
  for (const s of MEDIA_REFERENCE_SOURCES) known.add(`${s.table}.${s.column}`);

  const live = new Set(mediaColumnCandidates(schema));
  const liveAll = new Set<string>();
  for (const [table, cols] of schema) for (const c of cols) liveAll.add(`${table}.${c.name}`);

  return {
    unclassified: [...live].filter((id) => !known.has(id)).sort(),
    stale_sources: MEDIA_REFERENCE_SOURCES.map((s) => `${s.table}.${s.column}`)
      .filter((id) => !liveAll.has(id))
      .sort(),
    stale_exclusions: Object.keys(NON_MEDIA_COLUMNS).filter((id) => !liveAll.has(id)).sort(),
  };
}

/** A source read that FAILED — not "the column is absent", which is fine. */
export interface MediaScanFailure {
  source: string;
  error: string;
}

export interface MediaReferenceScan {
  keys: Set<string>;
  /** `table.column` entries actually read, for the report. */
  scanned: string[];
  /** Sources the schema does not have; skipped, exactly like MEDIA_JSON_COLUMNS. */
  absent: string[];
  failed: MediaScanFailure[];
}

/** Take a reference the way the delete path does, then insist it is a real key. */
function addKey(out: Set<string>, value: unknown): void {
  const key = mediaKeyFromRef(value);
  // The same gate `scanProductOrphans` applies: a junk string counted on one
  // side and not the other reads as an orphan and gets proposed for deletion.
  if (key && isSafeMediaKey(key)) out.add(key);
}

/**
 * EVERY KEY THE DATABASE STILL POINTS AT.
 *
 * One statement per source, each intersected with the live schema first. A
 * source that throws is RECORDED rather than swallowed: a reference set built
 * from a query that failed is a reference set that is missing rows, and the
 * caller must be able to refuse the delete because of it. `productDeletion`'s
 * own scan has no such channel — it is a product delete, where a missing table
 * genuinely means "this deployment predates the feature" — which is exactly
 * why the bucket sweep needs its own.
 */
export async function collectMediaReferences(db: MediaRefDb, schema: LiveSchema): Promise<MediaReferenceScan> {
  const keys = new Set<string>();
  const scanned: string[] = [];
  const absent: string[] = [];
  const failed: MediaScanFailure[] = [];

  for (const source of MEDIA_REFERENCE_SOURCES) {
    const id = `${source.table}.${source.column}`;
    const cols = schema.get(source.table);
    if (!cols || !cols.some((c) => c.name === source.column)) {
      absent.push(id);
      continue;
    }
    try {
      // `admin_settings` is read with its key so `mainPageMedia` can be
      // resolved against its prefix; every other source needs the value alone.
      const isSettings = source.table === 'admin_settings' && source.column === 'value';
      // A narrowing is applied only when the live schema really has every
      // column it reads. A `WHERE` naming a column a migration has not added
      // yet would throw, and a source that throws refuses the whole sweep —
      // correct, but a needless refusal. Reading the table whole is the safe
      // degradation: it over-scans, which costs one report line, where
      // under-scanning costs a live picture.
      const narrow =
        source.where && (source.whereColumns ?? []).every((c) => cols.some((x) => x.name === c))
          ? ` AND (${source.where})`
          : '';
      const sql = isSettings
        ? `SELECT "key" AS k, "value" AS v FROM "admin_settings"`
        : `SELECT "${source.column}" AS v FROM "${source.table}" WHERE "${source.column}" IS NOT NULL AND "${source.column}" <> ''${narrow}`;
      const rows = await db.prepare(sql).all<{ v: unknown; k?: unknown }>();
      for (const row of rows.results ?? []) {
        if (source.kind === 'text') {
          addKey(keys, row.v);
          continue;
        }
        const raw = row.v;
        if (typeof raw !== 'string' || !raw.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          // A column that is documented as JSON but holds a bare string is
          // still a reference the page renders. Falling back to the raw value
          // is what `scanProductOrphans` does, and for the same reason.
          parsed = raw;
        }
        if (isSettings && row.k === 'mainPageMedia') {
          resolveSiteMediaKeys(keys, parsed);
          continue;
        }
        for (const k of mediaKeysInJson(parsed)) {
          if (isSafeMediaKey(k)) keys.add(k);
        }
      }
      scanned.push(id);
    } catch (error) {
      failed.push({ source: id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { keys, scanned, absent, failed };
}

/**
 * `mainPageMedia` IS A POINTER, NOT A PATH.
 *
 * It maps a slot id to a BARE FILENAME — `banner-1-a1b2.webp` — and the object
 * is `UiUx/MainPage/` + that name (worker/lib/siteMedia.ts explains why the
 * filename changes on every upload). Walked as ordinary JSON it yields the
 * filename as if it were a key, which matches nothing in the bucket, and the
 * brand marks and service icons on the first screen stay unreferenced.
 */
function resolveSiteMediaKeys(out: Set<string>, parsed: unknown): void {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
  for (const object of Object.values(parsed as Record<string, unknown>)) {
    if (!isSiteMediaObject(object)) continue;
    const key = MAIN_PAGE_PREFIX + object;
    if (isSafeMediaKey(key)) out.add(key);
  }
}

export interface MediaCoverage {
  /** True only when every key-bearing column is classified AND every read worked. */
  ok: boolean;
  /** Plain sentences naming what is unverified. Empty when `ok`. */
  refusals: string[];
  audit: CoverageAudit;
  scan: MediaReferenceScan;
}

/**
 * THE GATE THE DELETE MUST PASS.
 *
 * Read-only and cheap enough to run on the report as well, because an admin
 * looking at the dry run deserves to know the report is trustworthy BEFORE
 * they reach for the button. `ok === false` is never a silent no-op and never
 * a partial sweep: the caller returns the refusal with these sentences in it.
 */
export async function verifyMediaCoverage(db: MediaRefDb): Promise<MediaCoverage> {
  const schema = await readLiveSchema(db);
  const audit = auditMediaCoverage(schema);
  const scan = await collectMediaReferences(db, schema);

  const refusals: string[] = [];
  if (audit.unclassified.length) {
    refusals.push(
      `${audit.unclassified.length} column(s) can hold an object key and are not named in ` +
        `MEDIA_REFERENCE_SOURCES or NON_MEDIA_COLUMNS (worker/lib/mediaRefs.ts): ` +
        `${audit.unclassified.slice(0, 20).join(', ')}` +
        (audit.unclassified.length > 20 ? `, … ${audit.unclassified.length - 20} more` : '')
    );
  }
  for (const f of scan.failed) {
    refusals.push(`the reference scan of ${f.source} failed (${f.error}), so the reference set is incomplete`);
  }
  return { ok: refusals.length === 0, refusals, audit, scan };
}

// ===========================================================================
//  PART THREE — DETACHING AN IMAGE FROM A SAVED PRODUCT
// ===========================================================================

/**
 * WHAT WAS LEAKING.
 *
 * `productPersistence.ts` removes a `product_images` row whenever the payload
 * stops naming it — an admin deleting one picture from a product and pressing
 * Save. The row went; the object stayed in R2 for ever. `grep` for `R2`,
 * `deleteMediaObject`, `media_cleanup_jobs` or `file_objects` in that file
 * returned ZERO. The owner pays for those bytes every month, and nothing in
 * the product lay to find them again: the FULL-product delete queues its keys,
 * a partial save never did.
 *
 * WHY A QUEUE AND NOT A DELETE, IN THE OWNER'S OWN REASONING.
 * With a queue the object may outlive the save by a few minutes, but an image
 * that is still displayed can never be destroyed — the worker re-checks before
 * it touches the bucket. With an immediate delete, any error leaves a broken
 * image on a live page, and the page is what the customer sees. So: queue.
 *
 * WHAT IS REUSED, NAMED EXPLICITLY. This is the machinery the full-product
 * delete already runs, not a second copy of it:
 *   - the `media_cleanup_jobs` table and its partial unique index
 *     `idx_media_cleanup_key_pending` (migration 0072) — which is what makes a
 *     double save, or two products sharing a key, queue the object once;
 *   - `mediaVisibilityOf` → `isAnonymousPublicMediaKey`, so a retry cannot
 *     guess the wrong bucket;
 *   - `deleteMediaObject` from `mediaStorage.ts`, including its "a missing
 *     object is success" behaviour;
 *   - `pendingMediaCleanup` from `productDeletion.ts` for the queue read.
 * The new part is the RE-CHECK and the BOUND, below — which the full-product
 * path does not need (its product is already gone) and this one cannot live
 * without.
 */

/**
 * HOW MANY TIMES A JOB MAY FAIL BEFORE A HUMAN HAS TO LOOK AT IT.
 *
 * `runMediaCleanup` increments `attempts` and leaves the job `pending` no
 * matter how often it fails, so a key R2 will never accept is retried for
 * ever and the queue only grows. Five attempts is enough to ride out a bucket
 * outage and short enough that a genuinely stuck job surfaces the same day.
 * Past it the job goes to `failed` — the dead-letter state migration 0072
 * already declares — with its last error kept, so the retry endpoint's report
 * can name it and the object can be dealt with by hand. Never an infinite
 * retry, and never a silent swallow.
 */
export const MEDIA_CLEANUP_MAX_ATTEMPTS = 5;

/** The reason string a detach writes, so the queue says where a job came from. */
export const MEDIA_DETACH_REASON = 'image_detach';

/**
 * THE KEY BEHIND A `product_images` ROW — OR NULL, WHICH IS NOT A FAILURE.
 *
 * `r2_key` is the canonical column since 0048; rows written before it carry
 * only `url`. And some rows carry NEITHER of ours: the live catalogue has
 * three images that are an `https://` hotlink to somebody else's server with
 * an empty `key`. That file is not ours, deleting it is not ours to attempt,
 * and queueing it would put a job in the table that can never succeed and will
 * dead-letter for no reason. `mediaKeyFromRef` already returns null for an
 * off-origin URL — this function exists so every caller gets that answer the
 * same way.
 */
export function detachedMediaKey(row: { r2_key?: string | null; url?: string | null }): string | null {
  const direct = mediaKeyFromRef(row.r2_key ?? '');
  if (direct && isSafeMediaKey(direct)) return direct;
  const viaUrl = mediaKeyFromRef(row.url ?? '');
  return viaUrl && isSafeMediaKey(viaUrl) ? viaUrl : null;
}

/** D1 refuses more than 100 bound parameters, so rows are chunked at 90/5. */
const DETACH_COLUMNS = 5;
const DETACH_ROWS_PER_STATEMENT = Math.floor(90 / DETACH_COLUMNS);

export interface DetachDb {
  prepare(sql: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

/**
 * QUEUE THE OBJECTS A SAVE STOPPED REFERENCING.
 *
 * CALLED ONLY AFTER THE SAVE HAS COMMITTED, and that ordering is the whole
 * safety argument. D1 batches are atomic: a save that rolls back leaves the
 * `product_images` row in place and the product still shows the picture. A
 * queue written INSIDE that batch would roll back with it — but a queue
 * written before it, or in a batch of its own that commits first, would
 * survive, and the sweep would then destroy an image the product is still
 * displaying. So the enqueue happens after, and never as part of, the save.
 *
 * Its own failure is deliberately NOT fatal. The save has already committed
 * and telling the admin it failed would be a lie; the object is then merely
 * unreferenced, which is precisely what the orphan report exists to find.
 */
export async function enqueueMediaDetach(
  db: DetachDb,
  keys: readonly string[],
  productId: string,
  options: { newId?: () => string } = {}
): Promise<string[]> {
  const mint = options.newId ?? (() => newId('mcj'));
  const unique = [...new Set(keys.filter((k) => typeof k === 'string' && isSafeMediaKey(k)))];
  if (!unique.length) return [];

  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < unique.length; i += DETACH_ROWS_PER_STATEMENT) {
    const chunk = unique.slice(i, i + DETACH_ROWS_PER_STATEMENT);
    const values: unknown[] = [];
    for (const key of chunk) {
      values.push(mint(), key, mediaVisibilityOf(key), MEDIA_DETACH_REASON, productId);
    }
    statements.push(
      db
        .prepare(
          // OR IGNORE against `idx_media_cleanup_key_pending`: saving the same
          // product twice, or two products that shared the picture, must not
          // queue one object twice.
          `INSERT OR IGNORE INTO media_cleanup_jobs (id, object_key, visibility, reason, source_product_id)
           VALUES ${chunk.map(() => '(?, ?, ?, ?, ?)').join(', ')}`
        )
        .bind(...values)
    );
  }
  await db.batch(statements);
  return unique;
}

export interface GuardedCleanupOutcome {
  /** False when coverage failed — nothing was touched. */
  ran: boolean;
  refusals: string[];
  attempted: number;
  deleted: string[];
  /** Still referenced when the worker looked: left alone, job closed. */
  still_referenced: string[];
  /** Past MEDIA_CLEANUP_MAX_ATTEMPTS: moved to `failed` for a human. */
  dead_lettered: Array<{ key: string; attempts: number; error: string }>;
  /** Failed this round, still `pending`, will be retried. */
  retrying: Array<{ key: string; error: string }>;
  /**
   * When the reference snapshot each delete was judged against was taken.
   *
   * One entry per chunk. A delete that later turns out to have raced a save
   * can be correlated with the snapshot that missed it, instead of the run
   * being an undated fact.
   */
  verified_at: string[];
  /**
   * A ledger write that failed AFTER the bucket had already answered.
   *
   * Never fatal and never silent: the bytes are gone or not gone regardless of
   * whether the row recording it could be written, and the one outcome this
   * must not produce is a run that throws away the record of what it deleted.
   */
  bookkeeping_failures: Array<{ key: string; error: string }>;
}

/**
 * HOW MANY JOBS ONE REFERENCE SNAPSHOT MAY COVER.
 *
 * The re-check is only as fresh as the scan behind it. Reading 200 jobs,
 * taking ONE snapshot and then deleting against it for the rest of the run
 * means the last delete is judged by a reference set read before the first
 * one was touched — seconds, not milliseconds, once ~55 full-table SELECTs and
 * up to 200 bucket deletes with two D1 writes each are in between. In that gap
 * an admin can re-attach the very picture they just removed and watch the undo
 * silently do nothing.
 *
 * So the snapshot is re-taken every chunk. Twenty-five is small enough that a
 * snapshot is never more than a second or two old and large enough that a
 * normal run costs one or two coverage scans, not eight.
 */
export const MEDIA_CLEANUP_VERIFY_CHUNK = 25;

/**
 * HOW MANY JOBS ONE RUN TAKES.
 *
 * Lowered from 200 with the chunked re-check: each chunk pays for its own
 * coverage scan, and the cron comes back in fifteen minutes. Fifty per run is
 * 200 an hour, which is far more than an admin can detach by hand, and it
 * keeps a single tick's CPU well inside the Worker's budget.
 */
export const MEDIA_CLEANUP_RUN_LIMIT = 50;

/**
 * RUN THE QUEUE, RE-CHECKING EVERY KEY AT THE MOMENT OF DELETION.
 *
 * THE WINDOW THIS CLOSES. A key is queued because one row stopped naming it.
 * Between then and now the SAME key can have been attached somewhere else —
 * the admin moved a picture to another product, pasted its `/files/...` path
 * into a home banner, or simply undid the edit. "It was unreferenced when we
 * queued it" is not the question the bucket delete answers; "is it
 * unreferenced NOW" is. So the reference set is rebuilt here, from the
 * manifest, and a key that reappears is closed as `skipped_shared` — the state
 * migration 0072 already has for exactly this — rather than deleted.
 *
 * IF COVERAGE CANNOT BE PROVEN, NOTHING IS DELETED. An incomplete reference
 * set cannot tell a live image from an orphan, and a delete made on one is a
 * guess. The jobs stay pending and the refusal says which columns are
 * unverified.
 *
 * THE LEDGER ROW IS DATED, NOT DROPPED. `file_objects` keeps who uploaded what
 * and when; a delete that removed the row would destroy that record along with
 * the bytes. `deleted_at` (migration 0068 already declares it) is stamped
 * instead, and it is stamped in UTC like the `created_at` beside it — Baghdad
 * time is the rule for anything a person reads as a DAY (worker/lib/
 * baghdadTime.ts), but two timestamps in one row must share a clock or
 * "uploaded before deleted" stops being true.
 */
export async function runGuardedMediaCleanup(
  env: MediaCleanupEnv,
  options: {
    limit?: number;
    maxAttempts?: number;
    /**
     * Post-commit delete paths already hold the exact jobs their D1 batch
     * queued. Supplying them keeps the inline response about that deletion,
     * while still running the same global reference scan and cleanup claim as
     * the scheduled drain.
     */
    jobs?: ReadonlyArray<{
      id: string;
      key: string;
      visibility: 'public' | 'private';
      attempts?: number;
    }>;
  } = {}
): Promise<GuardedCleanupOutcome> {
  const maxAttempts = options.maxAttempts ?? MEDIA_CLEANUP_MAX_ATTEMPTS;
  const out: GuardedCleanupOutcome = {
    ran: false,
    refusals: [],
    attempted: 0,
    deleted: [],
    still_referenced: [],
    dead_lettered: [],
    retrying: [],
    verified_at: [],
    bookkeeping_failures: [],
  };

  const jobs = options.jobs
    ? options.jobs.map((job) => ({ ...job, attempts: job.attempts ?? 0 }))
    : await pendingMediaCleanup(env.DB, options.limit ?? MEDIA_CLEANUP_RUN_LIMIT);
  out.attempted = jobs.length;
  if (!jobs.length) {
    out.ran = true;
    return out;
  }

  /**
   * A LEDGER WRITE MAY NOT DESTROY THE RECORD OF A BUCKET DELETE.
   *
   * `closeJob` and `bumpAttempt` are ordinary D1 writes and D1 rejects: a
   * transient "Network connection lost", a write-lock timeout, or a deployment
   * running ahead of migration 0072. Unwrapped, that rejection left the loop
   * and left the function — the route answered 500, `outcome.deleted` was
   * discarded so `invalidateMediaCache` never ran for keys whose bytes WERE
   * destroyed (leaving a one-year immutable cache entry in front of nothing),
   * the audit row was never written, and every remaining job was skipped with
   * no record that the run had stopped. `runMediaCleanup` already swallows
   * this class with its own `mark()` helper; this is the same decision, said
   * out loud and reported rather than silent.
   */
  const write = async (key: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (error) {
      out.bookkeeping_failures.push({ key, error: error instanceof Error ? error.message : String(error) });
    }
  };
  const releaseClaim = async (key: string, token: string): Promise<boolean> => {
    try {
      const released = await releaseMediaObjectCleanupClaim(env.DB, key, token);
      if (released) return true;
      out.bookkeeping_failures.push({ key, error: 'media cleanup claim ownership was lost before release' });
      return false;
    } catch (error) {
      out.bookkeeping_failures.push({ key, error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  };

  for (let from = 0; from < jobs.length; from += MEDIA_CLEANUP_VERIFY_CHUNK) {
    const chunk = jobs.slice(from, from + MEDIA_CLEANUP_VERIFY_CHUNK);
    // RE-TAKEN PER CHUNK — see MEDIA_CLEANUP_VERIFY_CHUNK. The refusal on the
    // FIRST chunk is the whole run's refusal (nothing has been touched yet);
    // a later chunk that cannot prove coverage simply stops, leaving its jobs
    // pending, because the deletes already made are facts to be reported.
    const coverage = await verifyMediaCoverage(env.DB);
    if (!coverage.ok) {
      out.refusals = coverage.refusals;
      if (from === 0) return out;
      break;
    }
    const claimed: Array<{ job: (typeof chunk)[number]; token: string }> = [];
    for (const job of chunk) {
      const token = await claimMediaObjectForCleanup(env.DB, job.key);
      if (token) claimed.push({ job, token });
    }
    if (!claimed.length) {
      out.ran = true;
      continue;
    }

    // Claims block every cooperating attach before it can save a reference.
    // Re-scan after acquiring them so the snapshot includes every attach that
    // won the guard first; later attaches see the token and fail safely.
    const claimedCoverage = await verifyMediaCoverage(env.DB);
    if (!claimedCoverage.ok) {
      for (const { job, token } of claimed) {
        await releaseClaim(job.key, token);
      }
      out.refusals = claimedCoverage.refusals;
      if (from === 0) return out;
      break;
    }
    out.ran = true;
    out.verified_at.push(new Date().toISOString());

    for (const { job, token } of claimed) {
      if (claimedCoverage.scan.keys.has(job.key)) {
        out.still_referenced.push(job.key);
        if (!(await releaseClaim(job.key, token))) continue;
        await write(job.key, () => closeJob(env.DB, job.key, 'skipped_shared', 'still referenced when the cleanup ran'));
        continue;
      }
      try {
        await deleteMediaObject(env, job.visibility as MediaVisibility, job.key);
        out.deleted.push(job.key);
        if (!(await releaseClaim(job.key, token))) continue;
        await write(job.key, () => closeJob(env.DB, job.key, 'done', ''));
        await write(job.key, () => stampFileObjectDeleted(env.DB, job.key));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown';
        if (!(await releaseClaim(job.key, token))) continue;
        const attempts = job.attempts + 1;
        if (attempts >= maxAttempts) {
          out.dead_lettered.push({ key: job.key, attempts, error: message });
          await write(job.key, () => closeJob(env.DB, job.key, 'failed', message));
        } else {
          out.retrying.push({ key: job.key, error: message });
          await write(job.key, () => bumpAttempt(env.DB, job.key, message));
        }
      }
    }
  }
  return out;
}

export interface ImmediateGuardedCleanupOutcome {
  deleted: string[];
  /** Candidate keys a surviving global reference still owns. */
  shared: string[];
  /** Work not safely completed; its durable job remains available to retry. */
  failed: Array<{ key: string; error: string }>;
  report: GuardedCleanupOutcome;
}

/**
 * Run a permanent product deletion's exact post-commit jobs through the same
 * global manifest guard as the scheduled cleanup worker.
 *
 * `partitionSharedMedia` intentionally knows only about product rows. That is
 * useful before the transaction, but insufficient authority to delete bytes:
 * a home banner, order snapshot, invoice or merchant page may still name the
 * same key. This adapter preserves the small `{deleted, failed}` route
 * contract while exposing globally shared keys for the response and audit.
 */
export async function runGuardedMediaCleanupJobs(
  env: MediaCleanupEnv,
  jobs: ReadonlyArray<{ id: string; key: string; visibility: 'public' | 'private' }>
): Promise<ImmediateGuardedCleanupOutcome> {
  if (jobs.length === 0) {
    const report = await runGuardedMediaCleanup(env, { jobs: [] });
    return { deleted: [], shared: [], failed: [], report };
  }

  const report = await runGuardedMediaCleanup(env, { jobs });
  const deleted = new Set(report.deleted);
  const shared = new Set(report.still_referenced);
  const errors = new Map<string, string>();

  for (const item of report.retrying) errors.set(item.key, item.error);
  for (const item of report.dead_lettered) errors.set(item.key, item.error);
  for (const item of report.bookkeeping_failures) errors.set(item.key, item.error);

  const refusal = report.refusals.join('; ');
  for (const job of jobs) {
    if (deleted.has(job.key) || shared.has(job.key)) continue;
    if (!errors.has(job.key)) {
      errors.set(
        job.key,
        refusal || 'media cleanup could not acquire the global deletion guard; the durable job remains pending'
      );
    }
  }

  return {
    deleted: [...deleted],
    shared: [...shared],
    failed: [...errors].map(([key, error]) => ({ key, error })),
    report,
  };
}

/** A job leaves `pending` exactly once; the partial unique index depends on it. */
async function closeJob(db: D1Database, key: string, state: string, error: string): Promise<void> {
  await db
    .prepare(
      `UPDATE media_cleanup_jobs
          SET state = ?, attempts = attempts + 1, last_error = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE object_key = ? AND state = 'pending'`
    )
    .bind(state, error.slice(0, 400), key)
    .run();
}

async function bumpAttempt(db: D1Database, key: string, error: string): Promise<void> {
  await db
    .prepare(
      `UPDATE media_cleanup_jobs
          SET attempts = attempts + 1, last_error = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE object_key = ? AND state = 'pending'`
    )
    .bind(error.slice(0, 400), key)
    .run();
}

/**
 * THE UPLOAD LEDGER KEEPS ITS ROW AND GAINS A DATE.
 *
 * `file_objects` records who uploaded what, when, how big and under whose
 * account. Deleting the row along with the bytes would destroy that record,
 * and the owner asked for the opposite: the history stays readable and the row
 * simply says when the object went. `deleted_at` (migration 0068 already
 * declares it) is what says so.
 *
 * Wrapped because a deployment can run this Worker before 0068 reaches its
 * database, and a bucket delete that already succeeded must not be reported as
 * a failure because the audit row could not be stamped.
 */
export async function markObjectsDeleted(db: D1Database, keys: readonly string[]): Promise<void> {
  for (const key of keys) await stampFileObjectDeleted(db, key);
}

async function stampFileObjectDeleted(db: D1Database, key: string): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE file_objects SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE object_key = ? AND deleted_at IS NULL`
      )
      .bind(key)
      .run();
  } catch {
    // Reported by nothing, on purpose: the bytes are gone either way and the
    // orphan report reads the bucket, not this row.
  }
}

// ===========================================================================
//  PART FOUR — WHAT THE SWEEP IS ACTUALLY ALLOWED TO REMOVE
// ===========================================================================

export interface SweepCandidate {
  key: string;
  bytes: number;
  /** When R2 says the object was written, if the lister reported it. */
  uploaded?: string | null;
}

/**
 * HOW LONG AN OBJECT IS TOO YOUNG TO BE CALLED AN ORPHAN.
 *
 * THE WINDOW THIS CLOSES, AND IT IS NOT HYPOTHETICAL. The admin form uploads
 * a picture the INSTANT it is picked — `ImagesSection.tsx` POSTs to
 * `/api/uploads`, `uploads.ts` writes `products/catalog/gallery/<id>.webp`
 * and hands back `/files/<key>` — and that key then lives ONLY in React state
 * until the admin presses Save. Between the drop and the Save, no row in this
 * database names it. The wide manifest does not help: the only record such an
 * object has is `file_objects`, which is deliberately NOT a source (it is an
 * inventory of objects, not a page that shows one) — so a sweep run while a
 * product form is open on another screen reports every staged picture as an
 * orphan, and deleting them leaves the admin's Save writing `product_images`
 * rows that point at nothing. The same window belongs to a home banner, which
 * is uploaded first and written into `admin_settings.homeBanners` on Save.
 *
 * WHY AN AGE FLOOR AND NOT A `file_objects` SCAN. Making the ledger a source
 * would make the reference set the whole bucket and nothing could ever be
 * swept again — the file says so where that exclusion is recorded. An age
 * floor costs nothing, needs no manifest entry, and expresses the real rule:
 * "nothing points at this" is only meaningful once the thing that would point
 * at it has had time to be saved.
 *
 * Twenty-four hours because it must outlast an edit session that goes home
 * for the night, and because an object this sweep declines today is simply
 * offered again tomorrow. The count is REPORTED, never silently dropped.
 */
export const SWEEP_MIN_AGE_MS = 24 * 60 * 60 * 1000;

export interface SweepPartition {
  /** Unreferenced by the FULL manifest: safe to remove. */
  removable: SweepCandidate[];
  /**
   * Proposed as orphans by the narrow scan and saved by the wide one.
   *
   * This list is the defect, itemised. Every key in it is an object that is
   * live on the site — a home banner, a past order's thumbnail — that the
   * previous cleanup would have deleted. It is reported on the dry run as
   * well, so the number is visible before anyone reaches for the button.
   */
  protected_keys: string[];
  /**
   * Too YOUNG to judge — see `SWEEP_MIN_AGE_MS`.
   *
   * An object uploaded within the grace period may be sitting in a product
   * form that nobody has saved yet, in which case no row names it and no row
   * can. Reported rather than dropped, so a number that never falls is
   * visible instead of mysterious.
   */
  staged_keys: string[];
}

/**
 * THE WIDE REFERENCE SET HAS THE LAST WORD.
 *
 * `scanProductOrphans` builds its candidate list from the product tables
 * alone, which is right for a product delete and wrong for the bucket. Rather
 * than let it delete from that list, the destructive route asks it for the
 * list as a DRY RUN and then strains it through this — so the narrow set can
 * only ever propose, never dispose.
 */
export function partitionSweepCandidates(
  candidates: readonly SweepCandidate[],
  referenced: ReadonlySet<string>,
  options: { now?: number; minAgeMs?: number } = {}
): SweepPartition {
  const now = options.now ?? Date.now();
  const minAge = options.minAgeMs ?? SWEEP_MIN_AGE_MS;
  const removable: SweepCandidate[] = [];
  const protectedKeys: string[] = [];
  const stagedKeys: string[] = [];
  for (const candidate of candidates) {
    if (referenced.has(candidate.key)) {
      protectedKeys.push(candidate.key);
      continue;
    }
    // An object with NO upload time is treated as old. R2 always reports one;
    // a lister that does not is a lister this code cannot date, and refusing
    // every object for ever would turn the cleanup into a permanent no-op.
    const uploaded = candidate.uploaded ? Date.parse(candidate.uploaded) : NaN;
    if (Number.isFinite(uploaded) && now - uploaded < minAge) {
      stagedKeys.push(candidate.key);
      continue;
    }
    removable.push(candidate);
  }
  return { removable, protected_keys: protectedKeys, staged_keys: stagedKeys };
}

export interface SweepDeletion {
  deleted: string[];
  failed: Array<{ key: string; error: string }>;
}

const SWEEP_RECOVERY_REASON = 'orphan_sweep_recovery';

/** Persist recovery ownership before an orphan sweep performs an external delete. */
async function ensureSweepRecoveryJob(db: D1Database, key: string): Promise<void> {
  await db.prepare(
    `INSERT OR IGNORE INTO media_cleanup_jobs
       (id, object_key, visibility, reason, source_product_id, state, attempts, last_error)
     VALUES (?, ?, ?, ?, '', 'pending', 0, '')`
  ).bind(newId('mcj'), key, mediaVisibilityOf(key), SWEEP_RECOVERY_REASON).run();
}

/**
 * Remove the objects the partition cleared, one at a time.
 *
 * A failure is recorded and the sweep continues: the rows are already gone by
 * the time this runs, and stopping would leave the report describing a state
 * that never existed. The next report lists whatever is still there.
 *
 * IT GOES THROUGH `deleteMediaObject`, NOT `bucket.delete`, AND THAT IS THE
 * WHOLE POINT OF THIS FUNCTION TAKING AN `env`. A raw delete on the PRIMARY
 * binding removes one of the two copies a stable key can have. `mediaStorage`
 * spells out the consequence at its own delete: while `R2_PUBLIC` and the
 * legacy `BUCKET` may both hold the key, removing only the primary means the
 * very next request for `/files/<key>` misses the primary, falls through
 * `readThroughLegacy`, finds the legacy copy and SERVES IT BACK — with this
 * report already telling the owner the bytes are gone, `file_objects` already
 * stamped `deleted_at`, and the cache key already invalidated. The object is
 * still public and still billed. `deleteMediaObject` attempts both, even when
 * the first rejects, and applies `isSafeMediaKey` on the way — the one guard
 * between this loop and an arbitrary string.
 */
export async function deleteSweptObjects(
  env: MediaCleanupEnv | null,
  objects: readonly SweepCandidate[]
): Promise<SweepDeletion> {
  const out: SweepDeletion = { deleted: [], failed: [] };
  if (!env) return out;
  for (const object of objects) {
    let token: string | null = null;
    let objectDeleted = false;
    try {
      // The bucket delete is external to D1. A pending row must exist first so
      // a successful delete followed by a failed guard release still has a
      // durable recovery path after the claim lease expires.
      await ensureSweepRecoveryJob(env.DB, object.key);
      token = await claimMediaObjectForCleanup(env.DB, object.key);
      if (!token) continue;
      const coverage = await verifyMediaCoverage(env.DB);
      if (!coverage.ok) {
        if (!(await releaseMediaObjectCleanupClaim(env.DB, object.key, token))) {
          throw new Error('media cleanup claim ownership was lost before release');
        }
        token = null;
        out.failed.push({ key: object.key, error: coverage.refusals.join('; ') });
        continue;
      }
      if (coverage.scan.keys.has(object.key)) {
        if (!(await releaseMediaObjectCleanupClaim(env.DB, object.key, token))) {
          throw new Error('media cleanup claim ownership was lost before release');
        }
        token = null;
        await closeJob(env.DB, object.key, 'skipped_shared', 'still referenced when the orphan sweep ran');
        continue;
      }
      await deleteMediaObject(env, mediaVisibilityOf(object.key), object.key);
      out.deleted.push(object.key);
      objectDeleted = true;
      if (!(await releaseMediaObjectCleanupClaim(env.DB, object.key, token))) {
        throw new Error('media cleanup claim ownership was lost before release');
      }
      token = null;
      await closeJob(env.DB, object.key, 'done', '');
    } catch (error) {
      if (token && !objectDeleted) {
        try {
          await releaseMediaObjectCleanupClaim(env.DB, object.key, token);
          token = null;
        } catch {
          // The pending recovery job remains. Cleanup reclaims the expired
          // token rather than allowing an attachment to bypass ownership.
        }
      }
      out.failed.push({ key: object.key, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return out;
}
