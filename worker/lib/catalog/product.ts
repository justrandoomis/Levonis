/**
 * A COMMUNITY PRODUCT ON THE 0126 MODEL — how it is read, validated and
 * written by the merchant's own routes (worker/routes/merchantCatalog.ts).
 *
 * THE SERVER DECIDES (docs/MERCHANT_PLATFORM.md §2 decision 8). Every figure,
 * id and key in a body is re-validated here: prices and stock are whole
 * numbers in range, option groups and variants pass the one gate
 * (`normalizeVariantModel`, packages/catalog), a media key must be an upload
 * of THIS store's owner — a video one whose sniffed type the upload ledger
 * recorded as video — a material must be on the platform's list, a collection
 * must be one of this store's manual collections. Ownership is in every
 * statement's WHERE clause besides; nothing a body says about ids can reach
 * another store's rows (the database refuses a foreign value or membership
 * too — 0126's triggers).
 *
 * A body is validated WHOLE and answered with every problem at once
 * (`400 PRODUCT_INVALID`, `details.errors = [{path, code}]`), so the editor can
 * put each one next to its field.
 */
import type { Context } from 'hono';
import type { AppContext } from '../types';
import { safeParse } from '../types';
import { HttpError } from '../http';
import { newId } from '../crypto';
import { ownedMediaKey } from '../mediaRefs';
import { getSetting } from '../settings';
import type { StoreContext } from '../merchantAuth';
import { mediaKey } from '@levonis/storeLayout/refs';
import { normalizeVariantModel, type VariantModel } from '@levonis/catalog/variants';
import { normalizeAttributes, type Attributes } from '@levonis/catalog/attributes';
import { isLowStock, isPublishState, isSoldOut, stateFromLegacyLifecycle, type PublishState } from '@levonis/catalog/lifecycle';
import { variantLabelSql } from './sql';

export const MAX_MEDIA = 12;
export const MAX_VIDEOS = 2;
export const MAX_COLLECTIONS_PER_PRODUCT = 20;
export const CONDITIONS = ['new', 'used', 'refurbished'] as const;

export interface FieldError {
  path: string;
  code: string;
}

export const productInvalid = (errors: FieldError[]) =>
  new HttpError(400, 'Some product fields are not valid', 'PRODUCT_INVALID', { errors });

// ------------------------------------------------------------------ shapes

export interface MediaItem {
  id: string;
  kind: 'image' | 'video';
  key: string;
  url: string;
  alt: string;
  alt_ar: string;
}

export function attributesOf(p: Record<string, unknown>): Attributes {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    material: (p.material as string | null) ?? null,
    technology: (p.print_technology as Attributes['technology']) ?? null,
    color: (p.color as Attributes['color']) ?? null,
    finish: (p.finish as Attributes['finish']) ?? null,
    dim_x_mm: num(p.dim_x_mm),
    dim_y_mm: num(p.dim_y_mm),
    dim_z_mm: num(p.dim_z_mm),
    weight_g: num(p.weight_g),
  };
}

export function stateOf(p: Record<string, unknown>): PublishState {
  return isPublishState(p.publish_state) ? p.publish_state : stateFromLegacyLifecycle(p.lifecycle);
}

/** The columns a list row adds beside `p.*`: the variant summary and the memberships. */
export const LIST_EXTRA_COLUMNS = `
  (SELECT COUNT(*) FROM community_product_variants v WHERE v.product_id = p.id) AS variant_count,
  (SELECT MIN(COALESCE(v.price_iqd, p.price_iqd)) FROM community_product_variants v WHERE v.product_id = p.id AND v.active = 1) AS variant_price_min,
  (SELECT MAX(COALESCE(v.price_iqd, p.price_iqd)) FROM community_product_variants v WHERE v.product_id = p.id AND v.active = 1) AS variant_price_max,
  (SELECT COUNT(*) FROM community_product_variants v WHERE v.product_id = p.id AND v.active = 1 AND v.stock > 0
      AND v.stock <= COALESCE(v.low_stock_threshold, p.low_stock_threshold, -1)) AS variants_low,
  (SELECT json_group_array(m.collection_id) FROM merchant_collection_products m WHERE m.product_id = p.id) AS collection_ids_json`;

/** The merchant's own view of a product (list and detail). */
export function productShape(p: Record<string, unknown>) {
  const state = stateOf(p);
  const tracked = !!Number(p.track_stock);
  const stock = Number(p.stock ?? 0);
  const mode = String(p.variant_mode ?? 'simple');
  const threshold = p.low_stock_threshold === null || p.low_stock_threshold === undefined ? null : Number(p.low_stock_threshold);
  const variantCount = Number(p.variant_count ?? 0);
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    name_ar: p.name_ar,
    description: p.description,
    description_ar: p.description_ar,
    images: safeParse(p.images, []),
    price_iqd: p.price_iqd,
    /** The struck-through «was» price (the pre-0126 name, kept). */
    original_price_iqd: p.original_price_iqd,
    compare_at_iqd: p.original_price_iqd,
    sku: p.sku,
    stock,
    track_stock: tracked,
    category: p.category,
    condition: p.condition,
    prep_days: p.prep_days,
    /** The merchant's lifecycle — draft | published | hidden | archived. */
    state,
    /** The pre-0126 spelling of the same state, for older clients. */
    lifecycle: p.lifecycle,
    status: p.status,
    /** Derived, never stored: published-or-not, it has nothing left to sell. */
    sold_out: isSoldOut({ track_stock: tracked, stock }),
    /**
     * Published but not for sale: no price (owner decision 2026-09-25). A
     * product left at 0 from before the rule stays published and is refused at
     * checkout until the merchant prices it — never silently unpublished.
     */
    price_required:
      state === 'published' &&
      (!(Number(p.price_iqd) > 0) ||
        (mode === 'variants' && p.variant_price_min !== null && p.variant_price_min !== undefined && !(Number(p.variant_price_min) > 0))),
    low_stock:
      tracked &&
      (mode === 'variants' ? Number(p.variants_low ?? 0) > 0 || isLowStock(stock, threshold) : isLowStock(stock, threshold)),
    low_stock_threshold: threshold,
    variant_mode: mode,
    variant_count: variantCount,
    price_range:
      mode === 'variants' && p.variant_price_min !== null && p.variant_price_min !== undefined
        ? { min: Number(p.variant_price_min), max: Number(p.variant_price_max) }
        : null,
    /** Why a legacy product could not be converted automatically (null: not examined yet). */
    legacy_note: mode === 'legacy' ? ((p.legacy_variant_note as string | null) ?? null) : null,
    // The pre-0126 JSON, read-only, only while the product is still sold by it.
    options: mode === 'legacy' ? safeParse(p.options, []) : [],
    colors: mode === 'legacy' ? safeParse(p.colors, []) : [],
    delivery_methods: safeParse(p.delivery_methods, []),
    attributes: attributesOf(p),
    collection_ids: safeParse<unknown[]>(p.collection_ids_json, []).filter((x): x is string => typeof x === 'string'),
    section_id: p.section_id ?? null,
    featured: !!p.featured,
    sold_count: p.sold_count,
    view_count: p.view_count,
    moderation: p.admin_hidden_at
      ? { hidden_by_admin: true, reason: String(p.admin_hidden_reason ?? ''), at: p.admin_hidden_at }
      : null,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}

export type ProductShape = ReturnType<typeof productShape>;

export interface ProductDetail extends ProductShape {
  media: MediaItem[];
  option_groups: Array<{
    id: string;
    name: string;
    name_ar: string;
    kind: 'choice' | 'color';
    values: Array<{ id: string; name: string; name_ar: string; swatch: string }>;
  }>;
  variants: Array<{
    id: string;
    value_ids: string[];
    label: string;
    price_iqd: number | null;
    compare_at_iqd: number | null;
    stock: number;
    sku: string;
    active: boolean;
    image_key: string | null;
    low_stock_threshold: number | null;
  }>;
}

/** One product of this merchant, everything the editor shows, in one round of reads. */
export async function readProductDetail(db: D1Database, merchantId: string, productId: string): Promise<ProductDetail | null> {
  // Five reads at once (not a batch: a batch is for writes, and a read in one
  // answers nothing on some drivers).
  const [row, groups, values, variants, media] = await Promise.all([
    db.prepare(`SELECT p.*, ${LIST_EXTRA_COLUMNS} FROM community_products p WHERE p.id = ?1 AND p.merchant_id = ?2`).bind(productId, merchantId).all(),
    db.prepare(
      `SELECT o.id, o.name, o.name_ar, o.kind, o.position FROM community_product_options o
         JOIN community_products p ON p.id = o.product_id
        WHERE o.product_id = ?1 AND p.merchant_id = ?2 ORDER BY o.position, o.id`
    ).bind(productId, merchantId).all(),
    db.prepare(
      `SELECT x.id, x.option_id, x.name, x.name_ar, x.swatch, x.position FROM community_product_option_values x
         JOIN community_products p ON p.id = x.product_id
        WHERE x.product_id = ?1 AND p.merchant_id = ?2 ORDER BY x.position, x.id`
    ).bind(productId, merchantId).all(),
    db.prepare(
      `SELECT v.*, ${variantLabelSql('v')} AS label FROM community_product_variants v
         JOIN community_products p ON p.id = v.product_id
        WHERE v.product_id = ?1 AND p.merchant_id = ?2 ORDER BY v.position, v.id`
    ).bind(productId, merchantId).all(),
    db.prepare(
      `SELECT m.id, m.kind, m.media_key, m.alt, m.alt_ar FROM community_product_media m
         JOIN community_products p ON p.id = m.product_id
        WHERE m.product_id = ?1 AND p.merchant_id = ?2 ORDER BY m.position, m.id`
    ).bind(productId, merchantId).all(),
  ]);
  const p = (row.results as Record<string, unknown>[])[0];
  if (!p) return null;
  const vals = values.results as Array<Record<string, unknown>>;
  return {
    ...productShape(p),
    media: (media.results as Array<Record<string, unknown>>).map((m) => ({
      id: String(m.id),
      kind: m.kind === 'video' ? 'video' : 'image',
      key: String(m.media_key),
      url: `/files/${String(m.media_key)}`,
      alt: String(m.alt ?? ''),
      alt_ar: String(m.alt_ar ?? ''),
    })),
    option_groups: (groups.results as Array<Record<string, unknown>>).map((g) => ({
      id: String(g.id),
      name: String(g.name),
      name_ar: String(g.name_ar ?? ''),
      kind: g.kind === 'color' ? 'color' : 'choice',
      values: vals
        .filter((x) => x.option_id === g.id)
        .map((x) => ({ id: String(x.id), name: String(x.name), name_ar: String(x.name_ar ?? ''), swatch: String(x.swatch ?? '') })),
    })),
    variants: (variants.results as Array<Record<string, unknown>>).map((v) => ({
      id: String(v.id),
      value_ids: [v.value1_id, v.value2_id, v.value3_id].filter((x): x is string => typeof x === 'string' && !!x),
      label: String(v.label ?? ''),
      price_iqd: v.price_iqd === null ? null : Number(v.price_iqd),
      compare_at_iqd: v.compare_at_iqd === null ? null : Number(v.compare_at_iqd),
      stock: Number(v.stock ?? 0),
      sku: String(v.sku ?? ''),
      active: !!Number(v.active),
      image_key: (v.image_key as string | null) ?? null,
      low_stock_threshold: v.low_stock_threshold === null ? null : Number(v.low_stock_threshold),
    })),
  };
}

// ------------------------------------------------------------------- input

/** Everything a body may set, validated; absent keys are absent (a PATCH). */
export interface ProductInput {
  fields: Record<string, unknown>;
  state?: PublishState;
  attributes?: Attributes;
  media?: Array<{ key: string; kind: 'image' | 'video'; alt: string; alt_ar: string }>;
  /**
   * The media came as the pre-0126 `images` list: pictures only, and an entry
   * that is not the owner's is DROPPED, not refused — the rule that list has
   * always had (a merchant fixing a price is not blocked by an old picture).
   */
  mediaFromImages?: boolean;
  collectionIds?: string[];
  variantModel?: VariantModel;
}

const has = (body: Record<string, unknown>, k: string) => body[k] !== undefined;

function text(v: unknown, max: number, min = 0): string | null {
  if (v === null || v === undefined) return min === 0 ? '' : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length < min || s.length > max ? null : s;
}

function wholeNumber(v: unknown, min: number, max: number): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/**
 * Parse and validate a product body. `partial` = PATCH (only what is sent);
 * otherwise name and price are required. Throws `PRODUCT_INVALID` listing
 * every field that is wrong.
 */
export function readProductInput(body: Record<string, unknown>, partial: boolean): ProductInput {
  const errors: FieldError[] = [];
  const fields: Record<string, unknown> = {};
  const out: ProductInput = { fields };
  const need = (k: string) => !partial || has(body, k);

  // The pre-0126 schemaless lists are not written any more: a variant is a
  // row with its own stock and price now, never a label a client typed (B13).
  if (has(body, 'options') || has(body, 'colors')) {
    const opts = Array.isArray(body.options) ? body.options : [];
    const cols = Array.isArray(body.colors) ? body.colors : [];
    if (opts.length || cols.length) errors.push({ path: 'options', code: 'PRODUCT_OPTIONS_LEGACY' });
  }

  if (need('name')) {
    const v = text(body.name, 120, 2);
    if (v === null) errors.push({ path: 'name', code: 'NAME_INVALID' });
    else fields.name = v;
  }
  for (const [k, max] of [['name_ar', 120], ['description', 6000], ['description_ar', 6000], ['category', 60], ['sku', 64]] as const) {
    if (!has(body, k)) continue;
    const v = text(body[k], max);
    if (v === null) errors.push({ path: k, code: 'FIELD_INVALID' });
    else fields[k] = v;
  }
  if (need('price_iqd')) {
    const v = wholeNumber(body.price_iqd, 0, 1_000_000_000);
    if (v === null) errors.push({ path: 'price_iqd', code: 'PRICE_INVALID' });
    else fields.price_iqd = v;
  }
  const compareKey = has(body, 'compare_at_iqd') ? 'compare_at_iqd' : has(body, 'original_price_iqd') ? 'original_price_iqd' : '';
  if (compareKey) {
    const raw = body[compareKey];
    if (raw === null || raw === '') fields.original_price_iqd = null;
    else {
      const v = wholeNumber(raw, 0, 1_000_000_000);
      if (v === null) errors.push({ path: compareKey, code: 'PRICE_INVALID' });
      else fields.original_price_iqd = v;
    }
  }
  if (has(body, 'stock')) {
    const v = wholeNumber(body.stock, 0, 1_000_000);
    if (v === null) errors.push({ path: 'stock', code: 'STOCK_INVALID' });
    else fields.stock = v;
  }
  if (has(body, 'track_stock')) fields.track_stock = body.track_stock ? 1 : 0;
  if (has(body, 'featured')) fields.featured = body.featured ? 1 : 0;
  if (has(body, 'condition')) {
    if ((CONDITIONS as readonly unknown[]).includes(body.condition)) fields.condition = body.condition;
    else errors.push({ path: 'condition', code: 'FIELD_INVALID' });
  }
  if (has(body, 'prep_days')) {
    const v = wholeNumber(body.prep_days, 0, 365);
    if (v === null) errors.push({ path: 'prep_days', code: 'FIELD_INVALID' });
    else fields.prep_days = v;
  }
  if (has(body, 'low_stock_threshold')) {
    if (body.low_stock_threshold === null || body.low_stock_threshold === '') fields.low_stock_threshold = null;
    else {
      const v = wholeNumber(body.low_stock_threshold, 0, 1_000_000);
      if (v === null) errors.push({ path: 'low_stock_threshold', code: 'FIELD_INVALID' });
      else fields.low_stock_threshold = v;
    }
  }
  if (has(body, 'delivery_methods')) {
    const list = Array.isArray(body.delivery_methods) ? body.delivery_methods : [];
    fields.delivery_methods = JSON.stringify(
      list.filter((x): x is string => typeof x === 'string').map((x) => x.trim().slice(0, 60)).filter(Boolean).slice(0, 10)
    );
  }

  // The state: `state` (the 0126 vocabulary) or `lifecycle` (the old one).
  if (has(body, 'state')) {
    if (isPublishState(body.state)) out.state = body.state;
    else errors.push({ path: 'state', code: 'STATE_INVALID' });
  } else if (has(body, 'lifecycle')) {
    if (['draft', 'active', 'hidden', 'sold_out', 'archived', 'published'].includes(String(body.lifecycle))) {
      out.state = stateFromLegacyLifecycle(body.lifecycle);
    } else errors.push({ path: 'lifecycle', code: 'STATE_INVALID' });
  }

  if (has(body, 'attributes')) {
    const a = normalizeAttributes(body.attributes);
    if (a.ok) out.attributes = a.value;
    else for (const e of a.errors) errors.push({ path: `attributes.${e.field}`, code: e.code });
  }

  // Media: `media` [{key|url, alt, alt_ar}] — or the old `images` list of
  // paths (pictures only). The KIND is decided from the key and checked
  // against the upload ledger later (`verifyMedia`); here only the shape.
  if (!has(body, 'media') && has(body, 'images')) {
    out.mediaFromImages = true;
    const list = Array.isArray(body.images) ? body.images : [];
    const keys: string[] = [];
    for (const item of list) {
      const v = mediaKey(typeof item === 'string' ? item : '', 'image', null);
      if (v?.ok && !keys.includes(v.key)) keys.push(v.key);
      if (keys.length >= 8) break;
    }
    out.media = keys.map((key) => ({ key, kind: 'image' as const, alt: '', alt_ar: '' }));
  } else if (has(body, 'media')) {
    const raw = body.media;
    const list = Array.isArray(raw) ? raw : [];
    if (!Array.isArray(raw)) errors.push({ path: 'media', code: 'MEDIA_INVALID' });
    if (list.length > MAX_MEDIA) errors.push({ path: 'media', code: 'MEDIA_TOO_MANY' });
    const media: NonNullable<ProductInput['media']> = [];
    list.slice(0, MAX_MEDIA).forEach((item, i) => {
      const o = typeof item === 'string' ? { key: item } : item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
      const ref = typeof o.key === 'string' ? o.key : typeof o.url === 'string' ? o.url : '';
      const asImage = mediaKey(ref, 'image', null);
      const asVideo = mediaKey(ref, 'video', null);
      const alt = text(o.alt ?? '', 200);
      const altAr = text(o.alt_ar ?? '', 200);
      if (asImage?.ok) media.push({ key: asImage.key, kind: 'image', alt: alt ?? '', alt_ar: altAr ?? '' });
      else if (asVideo?.ok) media.push({ key: asVideo.key, kind: 'video', alt: alt ?? '', alt_ar: altAr ?? '' });
      else errors.push({ path: `media.${i}`, code: 'MEDIA_INVALID' });
      if (alt === null || altAr === null) errors.push({ path: `media.${i}.alt`, code: 'FIELD_INVALID' });
    });
    if (new Set(media.map((m) => m.key)).size !== media.length) errors.push({ path: 'media', code: 'MEDIA_DUPLICATE' });
    if (media.filter((m) => m.kind === 'video').length > MAX_VIDEOS) errors.push({ path: 'media', code: 'MEDIA_TOO_MANY_VIDEOS' });
    out.media = media;
  }

  if (has(body, 'collection_ids') || has(body, 'section_id')) {
    const raw = has(body, 'collection_ids') ? body.collection_ids : body.section_id ? [body.section_id] : [];
    const list = Array.isArray(raw) ? raw : null;
    if (!list || list.length > MAX_COLLECTIONS_PER_PRODUCT || !list.every((x) => typeof x === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(x))) {
      errors.push({ path: 'collection_ids', code: 'COLLECTION_INVALID' });
    } else out.collectionIds = [...new Set(list as string[])];
  }

  if (has(body, 'variant_model')) {
    if (body.variant_model === null) out.variantModel = { groups: [], variants: [] };
    else {
      const m = normalizeVariantModel(body.variant_model);
      if (m.ok) out.variantModel = m.model;
      else for (const e of m.errors) errors.push({ path: e.path ? `variant_model.${e.path}` : 'variant_model', code: e.code });
    }
  }

  if (errors.length) throw productInvalid(errors);
  return out;
}

// -------------------------------------------------- checks against the store

/**
 * Checks that need the database: media are this owner's live uploads of the
 * right kind, the material is on the platform's list, the collections are this
 * store's manual ones, a variant's picture is one of the product's pictures.
 */
export async function verifyProductRefs(
  c: Context<AppContext>,
  ctx: StoreContext,
  input: ProductInput,
  existingMedia: string[] = []
): Promise<void> {
  const db = c.env.DB;
  const errors: FieldError[] = [];
  const owner = ctx.store.user_id;

  if (input.media?.length && input.mediaFromImages) {
    input.media = input.media.filter((m) => ownedMediaKey(m.key, owner) === m.key);
  } else if (input.media?.length) {
    const canonical = input.media.filter((m) => m.key.startsWith('merchants/'));
    const live = canonical.length
      ? new Map(
          (
            await db
              .prepare(
                `SELECT object_key, mime_type FROM file_objects
                  WHERE owner_id = ?1 AND deleted_at IS NULL AND object_key IN (SELECT value FROM json_each(?2))`
              )
              .bind(owner, JSON.stringify(canonical.map((m) => m.key)))
              .all<{ object_key: string; mime_type: string }>()
          ).results.map((r) => [r.object_key, r.mime_type])
        )
      : new Map<string, string>();
    input.media.forEach((m, i) => {
      if (m.key.startsWith('merchants/')) {
        const mime = live.get(m.key);
        // Another owner's key is simply not in THIS owner's ledger.
        if (!mime || !mime.startsWith(m.kind === 'video' ? 'video/' : 'image/')) errors.push({ path: `media.${i}`, code: 'MEDIA_NOT_OWNED' });
      } else if (m.kind !== 'image' || ownedMediaKey(m.key, owner) !== m.key) {
        // The pre-ledger `community/<owner>/…` shape: pictures, by prefix.
        errors.push({ path: `media.${i}`, code: 'MEDIA_NOT_OWNED' });
      }
    });
  }

  if (input.attributes?.material) {
    const vocabulary = (await getSetting(db, 'printMaterials')) as Array<{ id: string; active?: boolean }>;
    if (!vocabulary.some((m) => m.id === input.attributes!.material)) errors.push({ path: 'attributes.material', code: 'ATTRIBUTE_INVALID' });
  }

  if (input.collectionIds?.length) {
    const { results } = await db
      .prepare(
        `SELECT id FROM merchant_store_sections
          WHERE store_id = ?1 AND kind = 'manual' AND id IN (SELECT value FROM json_each(?2))`
      )
      .bind(ctx.store.id, JSON.stringify(input.collectionIds))
      .all<{ id: string }>();
    const own = new Set(results.map((r) => r.id));
    input.collectionIds.forEach((id, i) => {
      if (!own.has(id)) errors.push({ path: `collection_ids.${i}`, code: 'COLLECTION_NOT_FOUND' });
    });
  }

  if (input.variantModel) {
    const pictures = new Set(input.media ? input.media.filter((m) => m.kind === 'image').map((m) => m.key) : existingMedia);
    input.variantModel.variants.forEach((v, i) => {
      if (!v.image_key) return;
      const key = v.image_key.startsWith('/files/') ? v.image_key.slice(7) : v.image_key;
      if (!pictures.has(key)) errors.push({ path: `variant_model.variants.${i}.image_key`, code: 'VARIANT_IMAGE_INVALID' });
      else v.image_key = key;
    });
  }

  if (errors.length) throw productInvalid(errors);
}

// ------------------------------------------------------------------ writes

const nowIso = () => new Date().toISOString();

/** The media rows of a product, replaced as a whole, and the `images` mirror in the same batch. */
export function mediaStatements(
  db: D1Database,
  productId: string,
  storeId: string,
  media: NonNullable<ProductInput['media']>
): D1PreparedStatement[] {
  const stmts = [db.prepare('DELETE FROM community_product_media WHERE product_id = ?').bind(productId)];
  media.forEach((m, i) => {
    stmts.push(
      db
        .prepare(
          `INSERT INTO community_product_media (id, product_id, store_id, kind, media_key, alt, alt_ar, position)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
        )
        .bind(newId('pm'), productId, storeId, m.kind, m.key, m.alt, m.alt_ar, i)
    );
  });
  stmts.push(
    db
      .prepare('UPDATE community_products SET images = ?1 WHERE id = ?2')
      .bind(JSON.stringify(media.filter((m) => m.kind === 'image').map((m) => `/files/${m.key}`)), productId)
  );
  return stmts;
}

/**
 * The product's manual collections, replaced as a whole. A collection it
 * joins places it FIRST (MIN(position) - 1); one it stays in keeps its place.
 */
export function membershipStatements(db: D1Database, productId: string, storeId: string, ids: string[]): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `DELETE FROM merchant_collection_products
          WHERE product_id = ?1 AND store_id = ?2 AND collection_id NOT IN (SELECT value FROM json_each(?3))`
      )
      .bind(productId, storeId, JSON.stringify(ids)),
    ...ids.map((cid) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO merchant_collection_products (collection_id, product_id, store_id, position)
           SELECT ?1, ?2, ?3, COALESCE((SELECT MIN(position) FROM merchant_collection_products WHERE collection_id = ?1), 1) - 1`
        )
        .bind(cid, productId, storeId)
    ),
  ];
}

interface ExistingModel {
  groupIds: Set<string>;
  valueIds: Set<string>;
  /** combo of value ids → variant id */
  variantByCombo: Map<string, string>;
}

export async function readExistingModel(db: D1Database, productId: string): Promise<ExistingModel> {
  const [g, v, vr] = await Promise.all([
    db.prepare('SELECT id FROM community_product_options WHERE product_id = ?').bind(productId).all(),
    db.prepare('SELECT id FROM community_product_option_values WHERE product_id = ?').bind(productId).all(),
    db.prepare('SELECT id, value1_id, value2_id, value3_id FROM community_product_variants WHERE product_id = ?').bind(productId).all(),
  ]);
  const combos = new Map<string, string>();
  for (const r of vr.results as Array<Record<string, unknown>>) {
    combos.set([r.value1_id, r.value2_id, r.value3_id].filter(Boolean).join('|'), String(r.id));
  }
  return {
    groupIds: new Set((g.results as Array<{ id: string }>).map((r) => r.id)),
    valueIds: new Set((v.results as Array<{ id: string }>).map((r) => r.id)),
    variantByCombo: combos,
  };
}

/**
 * The option groups, values and variants of a product, replaced by `model`.
 *
 * IDS ARE KEPT WHERE THE THING IS THE SAME THING: a group or value named by an
 * id this product already has keeps that id (a ref this product does not own
 * is a NEW row — it can never reach another product's), and a variant keeps
 * its id when its COMBINATION existed before, so a cart line, an order line
 * and the insights that name it survive an edit. What the model no longer has
 * is deleted (its variants cascade). `legacyKeys` (the converter) records which
 * pre-0126 ids named each value.
 */
export function variantModelStatements(
  db: D1Database,
  productId: string,
  storeId: string,
  model: VariantModel,
  existing: ExistingModel,
  legacyRefs?: Map<string, string>
): { statements: D1PreparedStatement[]; variantIds: string[] } {
  const ts = nowIso();
  const groupId = new Map<string, string>();
  const valueId = new Map<string, string>();
  for (const g of model.groups) {
    groupId.set(g.ref, existing.groupIds.has(g.ref) ? g.ref : newId('po'));
    for (const v of g.values) valueId.set(v.ref, existing.valueIds.has(v.ref) ? v.ref : newId('pov'));
  }
  const keptGroups = [...groupId.values()].filter((id) => existing.groupIds.has(id));
  const keptValues = [...valueId.values()].filter((id) => existing.valueIds.has(id));
  const combos = model.variants.map((v) => v.values.map((r) => valueId.get(r)!).join('|'));
  const keptVariants = combos.map((k) => existing.variantByCombo.get(k)).filter((x): x is string => !!x);

  const stmts: D1PreparedStatement[] = [
    // Deletes first: a removed value takes its variants with it (CASCADE).
    db.prepare(
      `DELETE FROM community_product_variants WHERE product_id = ?1 AND id NOT IN (SELECT value FROM json_each(?2))`
    ).bind(productId, JSON.stringify(keptVariants)),
    db.prepare(
      `DELETE FROM community_product_option_values WHERE product_id = ?1 AND id NOT IN (SELECT value FROM json_each(?2))`
    ).bind(productId, JSON.stringify(keptValues)),
    db.prepare(
      `DELETE FROM community_product_options WHERE product_id = ?1 AND id NOT IN (SELECT value FROM json_each(?2))`
    ).bind(productId, JSON.stringify(keptGroups)),
  ];
  model.groups.forEach((g, gi) => {
    const gid = groupId.get(g.ref)!;
    stmts.push(
      db
        .prepare(
          `INSERT INTO community_product_options (id, product_id, store_id, name, name_ar, kind, position)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, name_ar = excluded.name_ar, kind = excluded.kind,
                                         position = excluded.position
            WHERE community_product_options.product_id = excluded.product_id`
        )
        .bind(gid, productId, storeId, g.name, g.name_ar, g.kind, gi)
    );
    g.values.forEach((v, vi) => {
      stmts.push(
        db
          .prepare(
            `INSERT INTO community_product_option_values (id, option_id, product_id, name, name_ar, swatch, position, legacy_ref)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET option_id = excluded.option_id, name = excluded.name, name_ar = excluded.name_ar,
                                           swatch = excluded.swatch, position = excluded.position
              WHERE community_product_option_values.product_id = excluded.product_id`
          )
          .bind(
            valueId.get(v.ref)!, gid, productId, v.name, v.name_ar,
            g.kind === 'color' && v.swatch ? v.swatch : '', vi, legacyRefs?.get(v.ref) ?? null
          )
      );
    });
  });
  const variantIds: string[] = [];
  model.variants.forEach((v, i) => {
    const ids = v.values.map((r) => valueId.get(r)!);
    const existingId = existing.variantByCombo.get(ids.join('|'));
    const id = existingId ?? newId('pv');
    variantIds.push(id);
    if (existingId) {
      stmts.push(
        db
          .prepare(
            `UPDATE community_product_variants
                SET price_iqd = ?1, compare_at_iqd = ?2, stock = ?3, sku = ?4, active = ?5, image_key = ?6,
                    low_stock_threshold = ?7, position = ?8, updated_at = ?9,
                    low_stock_alerted_at = CASE WHEN ?3 > COALESCE(?7, -1) THEN NULL ELSE low_stock_alerted_at END
              WHERE id = ?10 AND product_id = ?11`
          )
          .bind(v.price_iqd, v.compare_at_iqd, v.stock, v.sku, v.active ? 1 : 0, v.image_key, v.low_stock_threshold, i, ts, existingId, productId)
      );
    } else {
      stmts.push(
        db
          .prepare(
            `INSERT INTO community_product_variants
               (id, product_id, store_id, value1_id, value2_id, value3_id, price_iqd, compare_at_iqd, stock, sku, active,
                image_key, low_stock_threshold, position, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15)`
          )
          .bind(
            id, productId, storeId, ids[0], ids[1] ?? null, ids[2] ?? null, v.price_iqd, v.compare_at_iqd, v.stock,
            v.sku, v.active ? 1 : 0, v.image_key, v.low_stock_threshold, i, ts
          )
      );
    }
  });
  // The mode follows the model; the product's stock follows its variants
  // (0126's heal trigger fires on this very write).
  stmts.push(
    db
      .prepare(`UPDATE community_products SET variant_mode = ?1, updated_at = ?2 WHERE id = ?3`)
      .bind(model.groups.length ? 'variants' : 'simple', ts, productId)
  );
  return { statements: stmts, variantIds };
}

/** Whether a product with this model may be published: a variant product needs one active variant. */
/**
 * A PUBLISHED PRODUCT COSTS SOMETHING (owner decision 2026-09-25, review W2-5
 * finding 2): its price above 0, and every ACTIVE variant's price — its own
 * override, or the product's it inherits — above 0. Commission is on the
 * goods, so a 0-priced product sold with a delivery fee paid none.
 * `zeroOwnActiveVariants`: the stored active variants whose own price is 0,
 * for an edit that does not replace the variant model.
 */
export function priceMissing(productPrice: number, model: VariantModel | undefined, zeroOwnActiveVariants = 0): boolean {
  if (!(Number(productPrice) > 0)) return true;
  if (model) return model.groups.length > 0 && model.variants.some((v) => v.active && v.price_iqd !== null && !(v.price_iqd > 0));
  return zeroOwnActiveVariants > 0;
}

/** SQL: a product row `p` that is NOT sellable for want of a price (the same rule, in the database). */
export const PRICE_MISSING_SQL = (p: string) => `(${p}.price_iqd <= 0 OR (${p}.variant_mode = 'variants' AND EXISTS (
  SELECT 1 FROM community_product_variants zv WHERE zv.product_id = ${p}.id AND zv.active = 1 AND COALESCE(zv.price_iqd, ${p}.price_iqd) <= 0)))`;

export function publishableModel(model: VariantModel | undefined, currentActiveVariants: number, currentMode: string): boolean {
  if (model) return model.groups.length === 0 || model.variants.some((v) => v.active);
  return currentMode !== 'variants' || currentActiveVariants > 0;
}

/** Write attribute columns from a validated attribute object. */
export function attributeColumns(a: Attributes): Record<string, unknown> {
  return {
    material: a.material,
    print_technology: a.technology,
    color: a.color,
    finish: a.finish,
    dim_x_mm: a.dim_x_mm,
    dim_y_mm: a.dim_y_mm,
    dim_z_mm: a.dim_z_mm,
    weight_g: a.weight_g,
  };
}
