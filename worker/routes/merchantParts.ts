/**
 * «من ليفونيس» — A LEVONIS ITEM BECOMES ONE OF THE MERCHANT'S OWN PARTS
 * (Programme C, phase C1; docs/LEVO_PROJECT_PROGRAMME.md §B.3 row «From
 * Levonis», §0 row 7).
 *
 *   POST /api/merchant/parts/from-levonis {product_id, option_key?}
 *   POST /api/merchant/parts/:id/refresh
 *
 * A STOP-GAP, SAID PLAINLY. The brief's «select compatible items from the
 * existing Levonis store … no duplicate inventory» waits for two sellers on
 * one order (E13). Until then a merchant builds with THEIR OWN product: this
 * door creates it, in ONE batch, as a HIDDEN part («inside products only») in
 * the caller's store — the Levonis item's name, description, a starting price
 * the merchant edits later (the Levonis guest price), variants from the item's
 * option values (or the one option chosen), the facts as `part_spec` with
 * `source = levonis:<id>#<option>`, and the pictures COPIED into the merchant's
 * own public prefix (`merchants/<uid>/public/lv<sha>.<ext>`, content-addressed,
 * so a second copy of the same bytes is the same key). The stock starts at 0:
 * it is the merchant's stock, never Levonis's.
 *
 * «Refresh from Levonis» re-reads the facts and the pictures through the
 * stored source and RETURNS the item's current Levonis price beside the
 * product — the merchant's own price is never overwritten in silence. The
 * merchant's own pictures (anything not an `lv…` copy) are kept.
 *
 * Refusals: 409 PART_NOT_ELIGIBLE (the item is not live, not marked
 * «يُستخدم داخل منتجات مطبوعة», or the option is not one of it), 409
 * PART_ALREADY_IMPORTED {product_id} (this store already made a part from this
 * source — checked before the batch and fenced inside it), 400
 * PART_SPEC_INVALID {path} (a Levonis spec that does not read as a part).
 *
 * Mounted at /api/merchant/parts (worker/index.ts). The store is the session's
 * (`requireSellingPrivileges` → `storeForUser`); no id in a body reaches
 * another store. Answers are the merchant's own (private, no-store).
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext, Env } from '../lib/types';
import { safeParse } from '../lib/types';
import { HttpError, notFound, requireAuth, str } from '../lib/http';
import { rateLimit } from '../lib/ratelimit';
import { audit } from '../lib/audit';
import { newId } from '../lib/crypto';
import { requireSellingPrivileges, type StoreContext } from '../lib/merchantAuth';
import { purgeStorefrontAfterWrite } from '../lib/edgePolicy';
import { suggestSlug } from '../lib/merchantOps';
import { buildMediaKey, getMediaObject, putMediaObject } from '../lib/mediaStorage';
import { MAX_MEDIA, mediaStatements, readProductDetail, variantModelStatements } from '../lib/catalog/product';
import { partSpecInvalid, readPartSpecInput } from '../lib/personalize/parts';
import { assertBuilderOpen } from '../lib/personalize/access';
import { readLevonisPart, type LevonisPart, type LevonisPartOption } from './printParts';
import { normalizeVariantModel, MAX_VALUES_PER_GROUP, type VariantModel } from '@levonis/catalog/variants';
import { partDims, partSpecToMap, readPartSpec, type PartDims, type PartSpec } from '@levonis/catalog/personalize/parts';

export const merchantPartRoutes = new Hono<AppContext>();
merchantPartRoutes.use('*', requireAuth);
// A refresh can change a published part's pictures: the store's cached pages go.
merchantPartRoutes.use('*', purgeStorefrontAfterWrite);

const nowIso = () => new Date().toISOString();

const notEligible = (details?: Record<string, unknown>) =>
  new HttpError(
    409,
    'This Levonis item cannot be used as a part — it is not on sale or not marked for use inside printed products.',
    'PART_NOT_ELIGIBLE',
    details
  );

const alreadyImported = (productId: string) =>
  new HttpError(409, 'You already made a part from this Levonis item — edit that one instead.', 'PART_ALREADY_IMPORTED', {
    product_id: productId,
  });

/** `levonis:<id>` for the whole item, `levonis:<id>#<option id>` for one of its options. */
export function levonisSource(productId: string, optionKey?: string | null): string {
  return optionKey ? `levonis:${productId}#${optionKey}` : `levonis:${productId}`;
}

export function parseLevonisSource(source: string | undefined): { productId: string; optionKey: string | null } | null {
  const m = /^levonis:([^\s#]{1,80})(?:#(\S{0,80}))?$/.exec(source ?? '');
  return m ? { productId: m[1], optionKey: m[2] || null } : null;
}

/** The part this store already made from `source`, if any. */
async function importedFrom(db: D1Database, storeId: string, source: string): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT id FROM community_products
        WHERE store_id = ? AND part_spec IS NOT NULL
          AND (CASE WHEN json_valid(part_spec) THEN json_extract(part_spec, '$.source') END) = ?
        LIMIT 1`
    )
    .bind(storeId, source)
    .first<{ id: string }>();
  return row?.id ?? null;
}

// ------------------------------------------------------------- the pictures

const IMAGE_MIME: Record<string, string> = {
  webp: 'image/webp', avif: 'image/avif', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
};

/** A Levonis copy's object id: `lv` + 30 hex of the bytes' SHA-256 (it passes `ownedMediaKey`). */
const COPY_KEY = /\/lv[0-9a-f]{30}\.[a-z]+$/;

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * ONE PUBLIC LEVONIS PICTURE → THE MERCHANT'S OWN PUBLIC PREFIX. Read through
 * the media layer (with its legacy-bucket fallback), written through it (so
 * `file_objects` records the merchant as the owner and a later editor save
 * passes `verifyProductRefs`). Content-addressed: the same bytes land on the
 * same key, so a refresh of an unchanged picture writes nothing new. null when
 * the object is missing or is not a picture.
 */
async function copyPicture(env: Env, ownerUserId: string, sourceKey: string): Promise<string | null> {
  const ext = (/\.([a-z0-9]+)$/i.exec(sourceKey)?.[1] ?? '').toLowerCase();
  if (!IMAGE_MIME[ext]) return null;
  const object = await getMediaObject(env, 'public', sourceKey);
  if (!object) return null;
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > 20 * 1024 * 1024) return null;
  const mime = object.httpMetadata?.contentType?.startsWith('image/') ? object.httpMetadata.contentType : IMAGE_MIME[ext];
  const digest = hex(await crypto.subtle.digest('SHA-256', bytes)).slice(0, 30);
  const key = buildMediaKey({ visibility: 'public', domain: 'merchants', entityId: ownerUserId, kind: 'public', objectId: `lv${digest}`, extension: ext });
  await putMediaObject(
    env,
    { key, visibility: 'public', domain: 'merchants', mime, bytes: bytes.byteLength, ownerId: ownerUserId, entityId: ownerUserId },
    bytes,
    { httpMetadata: { contentType: mime, cacheControl: 'public, max-age=31536000, immutable' } }
  );
  return key;
}

/**
 * The item's gallery and the chosen options' own pictures, copied, deduped,
 * at most MAX_MEDIA. `byOption` maps an option id to its copied picture.
 */
async function copyPictures(
  env: Env,
  ownerUserId: string,
  part: LevonisPart,
  options: readonly LevonisPartOption[]
): Promise<{ keys: string[]; byOption: Map<string, string>; skipped: number }> {
  const byOption = new Map<string, string>();
  const keys: string[] = [];
  let skipped = 0;
  const copied = new Map<string, string | null>();
  const copy = async (source: string): Promise<string | null> => {
    if (copied.has(source)) return copied.get(source)!;
    let key: string | null = null;
    try {
      key = await copyPicture(env, ownerUserId, source);
    } catch (e) {
      console.error('from-levonis: a picture could not be copied', source, e instanceof Error ? e.message : String(e));
    }
    if (!key) skipped += 1;
    copied.set(source, key);
    return key;
  };
  // An option's own picture first when ONE option is the part: it is what it looks like.
  const optionSources = options.map((o) => ({ id: o.key, source: o.image ? o.image.slice('/files/'.length) : '' }));
  const ordered = [
    ...(options.length === 1 ? optionSources.filter((o) => o.source).map((o) => o.source) : []),
    ...part.gallery,
    ...optionSources.filter((o) => o.source).map((o) => o.source),
  ];
  for (const source of ordered) {
    if (keys.length >= MAX_MEDIA) break;
    const key = await copy(source);
    if (key && !keys.includes(key)) keys.push(key);
  }
  for (const o of optionSources) {
    const key = o.source ? copied.get(o.source) : null;
    if (key && keys.includes(key)) byOption.set(o.id, key);
  }
  return { keys, byOption, skipped };
}

// ------------------------------------------------------------- the facts

/** The item's facts for a part sold as one thing (the whole item, or one option of it). */
function simpleSpec(part: LevonisPart, optionKey: string | null, source: string): PartSpec {
  const spec: PartSpec = { ...(optionKey ? partDims(part.spec, optionKey) : part.spec), source };
  delete spec.variants;
  return spec;
}

/** The stored map, read back strictly (400 PART_SPEC_INVALID when the Levonis sheet does not read as a part). */
function storedMap(spec: PartSpec, valueIds: readonly string[]): string {
  const read = readPartSpecInput(partSpecToMap(spec), valueIds);
  if (!read.ok) throw partSpecInvalid(read.path);
  return JSON.stringify({ ...read.map, ...(spec.source ? { source: spec.source } : {}) });
}

const clip = (s: string, max: number) => s.trim().slice(0, max).trim();

/** The option group a Levonis item's options become, with value names the 0126 gate accepts. */
function levonisModel(
  part: LevonisPart,
  options: readonly LevonisPartOption[],
  basePrice: number,
  byOption: Map<string, string>
): { model: VariantModel; groupId: string; valueIdByOption: Map<string, string> } | null {
  const groupId = newId('po');
  const seen = new Set<string>();
  const valueIdByOption = new Map<string, string>();
  const values = options.slice(0, MAX_VALUES_PER_GROUP).map((o, i) => {
    let name = clip(o.name || o.name_ar || `${i + 1}`, 60);
    if (seen.has(name.toLocaleLowerCase('en-US'))) name = clip(`${name.slice(0, 54)} (${i + 1})`, 60);
    seen.add(name.toLocaleLowerCase('en-US'));
    const ref = newId('pov');
    valueIdByOption.set(o.key, ref);
    return { ref, name, name_ar: clip(o.name_ar, 60), swatch: '' };
  });
  const checked = normalizeVariantModel({
    groups: [{ ref: groupId, name: clip(part.option_group || 'Option', 60) || 'Option', name_ar: 'الخيار', kind: 'choice', values }],
    variants: options.slice(0, MAX_VALUES_PER_GROUP).map((o) => ({
      values: [valueIdByOption.get(o.key)],
      price_iqd: o.price_iqd === basePrice ? null : o.price_iqd,
      compare_at_iqd: null,
      stock: 0,
      sku: '',
      active: true,
      image_key: byOption.get(o.key) ?? null,
      low_stock_threshold: null,
    })),
  });
  return checked.ok ? { model: checked.model, groupId, valueIdByOption } : null;
}

// -------------------------------------------------------------- from Levonis

async function readBody(c: Context<AppContext>): Promise<Record<string, unknown>> {
  return (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
}

/** Why a product id is not a part: 404 when it is not a live Levonis item at all. */
async function refuseMissing(db: D1Database, productId: string): Promise<never> {
  const live = await db.prepare("SELECT 1 AS ok FROM products WHERE id = ? AND status = 'active'").bind(productId).first();
  if (!live) throw notFound('Product not found');
  throw notEligible();
}

merchantPartRoutes.post('/from-levonis', async (c) => {
  await rateLimit(c, 'merchant-product-create', 60, 3600);
  const ctx = await requireSellingPrivileges(c);
  // «التخصيص» ships dark (C1): this door opens with the builder — its switch or a pilot, and the entitlement.
  await assertBuilderOpen(c, ctx);
  const db = c.env.DB;
  const body = await readBody(c);
  const productId = str(body.product_id, 'product_id', { min: 1, max: 80 });
  const optionKey = str(body.option_key ?? '', 'option_key', { max: 80, required: false }) || null;

  const part = await readLevonisPart(db, productId);
  if (!part) return refuseMissing(db, productId);
  const option = optionKey ? part.options.find((o) => o.key === optionKey) : undefined;
  if (optionKey && !option) throw notEligible({ option_key: optionKey });

  const source = levonisSource(part.id, optionKey);
  const existing = await importedFrom(db, ctx.store.id, source);
  if (existing) throw alreadyImported(existing);

  const withVariants = !option && part.options.length > 0;
  const chosen = option ? [option] : withVariants ? part.options.slice(0, MAX_VALUES_PER_GROUP) : [];
  const pictures = await copyPictures(c.env, ctx.store.user_id, part, chosen);

  const id = newId('cp');
  const ts = nowIso();
  const basePrice = option ? option.price_iqd : withVariants ? Math.min(...chosen.map((o) => o.price_iqd)) : part.price_iqd;
  const built = withVariants ? levonisModel(part, chosen, basePrice, pictures.byOption) : null;
  if (withVariants && !built) throw notEligible({ reason: 'options' });

  // The facts: the item's, with each option's line keyed by the value it became.
  let spec: PartSpec;
  let valueIds: string[] = [];
  if (built) {
    const { variants: lines, ...base } = part.spec;
    const byValue: Record<string, PartDims> = {};
    for (const [optionId, valueId] of built.valueIdByOption) if (lines?.[optionId]) byValue[valueId] = lines[optionId];
    spec = { ...base, source, ...(Object.keys(byValue).length ? { variants: byValue } : {}) };
    valueIds = [...built.valueIdByOption.values()];
  } else {
    spec = simpleSpec(part, option?.key ?? null, source);
  }
  const partSpec = storedMap(spec, valueIds);

  const name = clip(option ? `${part.name || part.name_ar} — ${option.name || option.name_ar}` : part.name || part.name_ar || 'Part', 120);
  const nameAr = clip(option && part.name_ar ? `${part.name_ar} — ${option.name_ar || option.name}` : part.name_ar, 120);
  const base = suggestSlug(name) || 'part';
  const cols: Record<string, unknown> = {
    id,
    merchant_id: ctx.merchant.id,
    store_id: ctx.store.id,
    slug: `${ctx.store.slug}-${base}-${id.slice(-6)}`.slice(0, 120),
    name: name.length >= 2 ? name : `${name} part`.trim(),
    name_ar: nameAr,
    description: clip(part.description, 6000),
    description_ar: clip(part.description_ar, 6000),
    images: '[]',
    price_iqd: basePrice,
    sku: '',
    stock: 0,
    track_stock: 1,
    category: '',
    condition: 'new',
    delivery_methods: '[]',
    prep_days: 0,
    featured: 0,
    weight_g: part.net_weight_g,
    part_spec: partSpec,
    // «مخفي عن المتجر — داخل المنتجات فقط»: the 0126 insert trigger makes it status 'hidden'.
    publish_state: 'hidden',
    created_at: ts,
    updated_at: ts,
  };
  const names = Object.keys(cols);
  const storeParam = names.length + 1;
  const sourceParam = names.length + 2;
  const stmts: D1PreparedStatement[] = [
    // FENCED: a second import racing this one inserts nothing, and every
    // statement after it then fails its foreign key — the batch is all or nothing.
    db
      .prepare(
        `INSERT INTO community_products (${names.join(', ')})
         SELECT ${names.map((_, i) => `?${i + 1}`).join(', ')}
          WHERE NOT EXISTS (
            SELECT 1 FROM community_products x
             WHERE x.store_id = ?${storeParam} AND x.part_spec IS NOT NULL
               AND (CASE WHEN json_valid(x.part_spec) THEN json_extract(x.part_spec, '$.source') END) = ?${sourceParam})`
      )
      .bind(...names.map((n) => cols[n]), ctx.store.id, source),
  ];
  if (pictures.keys.length) {
    stmts.push(...mediaStatements(db, id, ctx.store.id, pictures.keys.map((key) => ({ key, kind: 'image' as const, alt: '', alt_ar: '' }))));
  }
  if (built) {
    stmts.push(
      ...variantModelStatements(db, id, ctx.store.id, built.model, {
        // The ids are minted here so the facts can be keyed by them: named as
        // «existing», `variantModelStatements` keeps them as the rows' ids.
        groupIds: new Set([built.groupId]),
        valueIds: new Set(valueIds),
        variantByCombo: new Map(),
      }).statements
    );
  }
  let inserted = false;
  try {
    const results = await db.batch(stmts);
    inserted = Number(results[0]?.meta?.changes ?? 0) > 0;
  } catch (e) {
    const raced = await importedFrom(db, ctx.store.id, source);
    if (raced) throw alreadyImported(raced);
    throw e;
  }
  if (!inserted) throw alreadyImported((await importedFrom(db, ctx.store.id, source)) ?? '');

  await audit(db, ctx.store.user_id, 'merchant.part_imported', id, { store: ctx.store.id, source });
  const product = await readProductDetail(db, ctx.merchant.id, id);
  return c.json({ success: true, product, images: { copied: pictures.keys.length, skipped: pictures.skipped } }, 201);
});

// ------------------------------------------------------------------- refresh

/** The Levonis answer a refresh returns beside the product — the merchant decides what to do with the price. */
function levonisPrice(part: LevonisPart, optionKey: string | null) {
  const option = optionKey ? part.options.find((o) => o.key === optionKey) : undefined;
  return {
    id: part.id,
    option_key: optionKey,
    price_iqd: option ? option.price_iqd : part.price_iqd,
    in_stock: option ? option.in_stock : part.in_stock,
    options: part.options.map((o) => ({ key: o.key, name: o.name, name_ar: o.name_ar, name_ckb: o.name_ckb, price_iqd: o.price_iqd, in_stock: o.in_stock })),
  };
}

merchantPartRoutes.post('/:id/refresh', async (c) => {
  await rateLimit(c, 'merchant-part-refresh', 60, 3600);
  const ctx: StoreContext = await requireSellingPrivileges(c);
  // «التخصيص» ships dark (C1): as the from-Levonis door above.
  await assertBuilderOpen(c, ctx);
  const db = c.env.DB;
  const id = c.req.param('id');
  const row = await db
    .prepare(
      `SELECT p.id, p.part_spec, p.variant_mode,
              (SELECT json_group_array(json_object('id', x.id, 'name', x.name)) FROM community_product_option_values x
                WHERE x.product_id = p.id) AS values_json,
              (SELECT json_group_array(k) FROM (SELECT m.media_key AS k FROM community_product_media m
                WHERE m.product_id = p.id AND m.kind = 'image' ORDER BY m.position, m.id)) AS media_json
         FROM community_products p
        WHERE p.id = ? AND p.merchant_id = ? AND p.store_id = ? AND p.audience_user_id IS NULL`
    )
    .bind(id, ctx.merchant.id, ctx.store.id)
    .first<Record<string, unknown>>();
  if (!row) throw notFound('Product not found');
  const stored = readPartSpec(row.part_spec ?? null);
  const src = parseLevonisSource(stored?.source);
  if (!stored || !src) throw notEligible({ reason: 'source' });

  const part = await readLevonisPart(db, src.productId);
  if (!part) return refuseMissing(db, src.productId);
  const option = src.optionKey ? part.options.find((o) => o.key === src.optionKey) : undefined;
  if (src.optionKey && !option) throw notEligible({ option_key: src.optionKey });

  const values = safeParse<Array<{ id: string; name: string }>>(row.values_json, []);
  const valueIds = values.map((v) => v.id);
  let spec: PartSpec;
  if (row.variant_mode === 'variants' && !option) {
    // Each Levonis option's line lands on the merchant's value of the same
    // name; a value the merchant renamed or added keeps the line it had.
    const { variants: lines, ...base } = part.spec;
    const byValue: Record<string, PartDims> = { ...(readPartSpec(row.part_spec, valueIds)?.variants ?? {}) };
    for (const v of values) {
      const o = part.options.find((x) => x.name.trim().toLocaleLowerCase('en-US') === v.name.trim().toLocaleLowerCase('en-US'));
      if (o && lines?.[o.key]) byValue[v.id] = lines[o.key];
    }
    spec = { ...base, source: stored.source, ...(Object.keys(byValue).length ? { variants: byValue } : {}) };
  } else {
    spec = simpleSpec(part, option?.key ?? null, stored.source!);
  }
  const partSpec = storedMap(spec, valueIds);

  // Fresh copies first, then every picture of the merchant's own (never an `lv…` copy of an older Levonis picture).
  const pictures = await copyPictures(c.env, ctx.store.user_id, part, option ? [option] : []);
  const own = safeParse<unknown[]>(row.media_json, []).filter((k): k is string => typeof k === 'string' && !COPY_KEY.test(k));
  const media = [...pictures.keys, ...own.filter((k) => !pictures.keys.includes(k))].slice(0, MAX_MEDIA);

  const ts = nowIso();
  await db.batch([
    db.prepare('UPDATE community_products SET part_spec = ?1, updated_at = ?2 WHERE id = ?3 AND merchant_id = ?4').bind(partSpec, ts, id, ctx.merchant.id),
    ...mediaStatements(db, id, ctx.store.id, media.map((key) => ({ key, kind: 'image' as const, alt: '', alt_ar: '' }))),
    // A variant's picture must be one of the product's; one that is gone is cleared, never left dangling.
    db
      .prepare(
        `UPDATE community_product_variants SET image_key = NULL
          WHERE product_id = ?1 AND image_key IS NOT NULL AND image_key NOT IN (SELECT value FROM json_each(?2))`
      )
      .bind(id, JSON.stringify(media)),
  ]);
  await audit(db, ctx.store.user_id, 'merchant.part_refreshed', id, { store: ctx.store.id, source: stored.source });
  const product = await readProductDetail(db, ctx.merchant.id, id);
  return c.json({ success: true, product, levonis: levonisPrice(part, src.optionKey), images: { copied: pictures.keys.length, skipped: pictures.skipped } });
});
