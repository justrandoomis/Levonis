/**
 * THE PUBLIC BLUEPRINT — what a customer's studio (and a guest's edge-cached
 * read) receives for a product (Programme C, phase C1; docs/LEVO_PROJECT_
 * PROGRAMME.md §B.1 hop 1 «the public projection carries no key, no cost, no
 * merchant note, no part name, only `in_stock` booleans», P5, P6, P13).
 *
 * TWO D1 WAVES, measured (tests/blueprintRoutes.test.ts, the tests/fixtures/
 * wavesD1.ts adapter):
 *   1. the revision ⋈ its product ⋈ the store ⋈ the merchant (`loadBlueprintHead`),
 *      beside the switch (the route reads `customizationConfig` in the same wave);
 *   2. in parallel: the product's variants, the shop's shelf (L3's `stockFor`
 *      per look), the slot options' parts (L6's `loadStoreParts`, and the
 *      same ids unfiltered so an archived part still shows — out of stock),
 *      the workshop's largest bed, and whether the owner may sell today.
 *
 * WHAT NEVER LEAVES: the spec's `private` part (it lives in its own column
 * and this file never reads it), slot `accepts` and hidden fixed parts
 * (`publicSpecOf`), the mesh part NAMES (`product_blueprints.parts` is never
 * read here), the source and draft keys, costs, stock COUNTS and grams —
 * the shelf becomes `in` / `sub:<key>` / `out` per colour.
 *
 * 404 (null here) when the product has no such revision, is private, is not
 * on the shelf (a draft, hidden or archived product), or its store is not
 * servable or not taking orders — unless the caller is a PREVIEWER (a
 * platform admin or the product's own merchant), who sees any non-private,
 * non-archived product's revision. Whether personalisation is switched on is
 * the route's question (worker/lib/personalize/access.ts).
 */
import { safeParse } from '../types';
import type { Env } from '../types';
import { loadStoreParts, type StorePart } from './parts';
import {
  BLUEPRINT_COLUMNS,
  analysisOf,
  draftMeshUrl,
  lookOf,
  photoKeysOf,
  productVariants,
  specOf,
  type BlueprintRow,
} from './blueprints';
import { publicSpecOf, isPhotoOnly } from '@levonis/catalog/personalize/spec';
import { shelfColours, stockFor, type ShelfRow, type RGB } from '@levonis/catalog/personalize/color';
import type { LookKey, PaletteKey, PublicBlueprint, PublicSlotOption, StockState, Vec3 } from '@levonis/catalog/personalize/types';

/** The revision with the product, store and merchant facts the read decides on (wave 1). */
export interface BlueprintHead {
  row: BlueprintRow;
  product: {
    id: string;
    slug: string;
    name: string;
    price_iqd: number;
    prep_days: number;
    variant_mode: string;
    track_stock: number;
    stock: number;
    lifecycle: string;
    status: string;
    publish_state: string;
    audience_user_id: string | null;
    merchant_id: string;
    store_id: string;
  };
  store: { id: string; slug: string; user_id: string; status: string; sells_direct_products: number };
  merchant: { id: string; status: string };
}

/**
 * Wave 1: the LIVE revision (no `rev`), or revision `rev` if it was ever
 * published (live or retired — a paused product's revision still renders a
 * cart line that named it); never a draft.
 */
export async function loadBlueprintHead(db: D1Database, productId: string, rev: number | null = null): Promise<BlueprintHead | null> {
  const r = await db
    .prepare(
      `SELECT ${BLUEPRINT_COLUMNS.split(', ').map((c) => `b.${c}`).join(', ')},
              p.slug AS p_slug, p.name AS p_name, p.price_iqd AS p_price, p.prep_days AS p_prep, p.variant_mode AS p_mode,
              p.track_stock AS p_track, p.stock AS p_stock, p.lifecycle AS p_lifecycle, p.status AS p_status,
              p.publish_state AS p_publish, p.audience_user_id AS p_audience,
              s.slug AS s_slug, s.user_id AS s_user, s.status AS s_status, s.sells_direct_products AS s_sells,
              m.id AS m_id, m.status AS m_status
         FROM product_blueprints b
         JOIN community_products p ON p.id = b.product_id
         JOIN merchant_stores s ON s.id = p.store_id
         JOIN community_merchants m ON m.id = s.merchant_id
        WHERE b.product_id = ?1
          AND ((?2 IS NULL AND b.state = 'live') OR (?2 IS NOT NULL AND b.rev = ?2 AND b.state IN ('live', 'retired')))
        LIMIT 1`
    )
    .bind(productId, rev)
    .first<Record<string, unknown>>();
  if (!r) return null;
  const row = Object.fromEntries(BLUEPRINT_COLUMNS.split(', ').map((c) => [c, r[c]])) as unknown as BlueprintRow;
  return {
    row,
    product: {
      id: row.product_id,
      slug: String(r.p_slug ?? ''),
      name: String(r.p_name ?? ''),
      price_iqd: Math.max(0, Math.trunc(Number(r.p_price) || 0)),
      prep_days: Math.max(0, Math.trunc(Number(r.p_prep) || 0)),
      variant_mode: String(r.p_mode ?? 'simple'),
      track_stock: Number(r.p_track ?? 1),
      stock: Number(r.p_stock ?? 0),
      lifecycle: String(r.p_lifecycle ?? ''),
      status: String(r.p_status ?? ''),
      publish_state: String(r.p_publish ?? ''),
      audience_user_id: (r.p_audience as string | null) ?? null,
      merchant_id: row.merchant_id,
      store_id: row.store_id,
    },
    store: {
      id: row.store_id,
      slug: String(r.s_slug ?? ''),
      user_id: String(r.s_user ?? ''),
      status: String(r.s_status ?? ''),
      sells_direct_products: Number(r.s_sells ?? 0),
    },
    merchant: { id: String(r.m_id ?? ''), status: String(r.m_status ?? '') },
  };
}

/** On the shelf for a guest: the storefront's own product predicate (published, not hidden, not private). */
export const productOnShelf = (h: BlueprintHead): boolean =>
  h.product.lifecycle === 'active' && h.product.status === 'active' && !h.product.audience_user_id;

/**
 * THE OWNER MAY SELL TODAY, in ONE statement for the second wave — the facts
 * `storeTakesOrders` (worker/lib/storeOrderOps.ts) judges, read as SQL so the
 * guest read stays two waves: an active membership of PLUS or higher (the
 * lazy expiry of `getTierStatus` applied in the predicate: a row past its end
 * that no pause froze is not active) and no active restriction gating the
 * store or the builder's benefit (`merchantStore`, `customizableProducts`).
 */
async function ownerSells(db: D1Database, ownerUserId: string, now: string): Promise<boolean> {
  const r = await db
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM memberships ms
                       WHERE ms.user_id = ?1 AND ms.state = 'active' AND ms.tier IN ('plus', 'prime', 'pro')
                         AND (ms.expires_at IS NULL OR ms.expires_at >= ?2 OR ms.paused_at IS NOT NULL)) AS member,
              EXISTS (SELECT 1 FROM restriction_cases rc,
                             json_each(CASE WHEN json_valid(rc.benefit_flags) THEN rc.benefit_flags ELSE '[]' END) f
                       WHERE rc.user_id = ?1 AND rc.state = 'active' AND f.value IN ('merchantStore', 'customizableProducts')) AS gated`
    )
    .bind(ownerUserId, now)
    .first<{ member: number; gated: number }>();
  return !!Number(r?.member) && !Number(r?.gated);
}

/** The store takes orders: the merchant and the store active, selling products, and the owner's plan (`ownerSells`). */
export function storeTakesOrdersNow(h: BlueprintHead, sells: boolean): boolean {
  return h.merchant.status === 'active' && h.store.status === 'active' && Number(h.store.sells_direct_products) === 1 && sells;
}

/** The per-look stock maps (L3's `stockFor`), the shelf's own colours and names; null maps when the shop tracks nothing. */
export function shelfStock(
  spec: { axes: { look?: { values: Record<string, { look: LookKey; material_id: string }> } } },
  shelf: readonly ShelfRow[]
): Pick<PublicBlueprint, 'stock' | 'stock_rgb' | 'stock_names'> {
  if (!shelf.length) return { stock: null, stock_rgb: {}, stock_names: {} };
  const stock: NonNullable<PublicBlueprint['stock']> = {};
  const rgb: Partial<Record<PaletteKey, [number, number, number]>> = {};
  const names: Partial<Record<PaletteKey, string>> = {};
  const note = (have: Array<{ key: PaletteKey; rgb: RGB; name: string }>) => {
    for (const h of have) {
      if (!rgb[h.key]) rgb[h.key] = [h.rgb[0], h.rgb[1], h.rgb[2]];
      if (!names[h.key] && h.name) names[h.key] = h.name.slice(0, 40);
    }
  };
  const looks = Object.values(spec.axes.look?.values ?? {});
  if (looks.length) {
    for (const v of looks) {
      stock[v.look] = stockFor({ material_id: v.material_id }, shelf) as Partial<Record<PaletteKey, StockState>>;
      note(shelfColours({ material_id: v.material_id }, shelf));
    }
  } else {
    // No look axis: one map over every material on the shelf.
    const any = shelf.map((r) => ({ ...r, material_id: '*' }));
    stock.default = stockFor({ material_id: '*' }, any) as Partial<Record<PaletteKey, StockState>>;
    note(shelfColours({ material_id: '*' }, any));
  }
  return { stock, stock_rgb: rgb, stock_names: names };
}

export interface ProjectOptions {
  /** The builder's preview: the mesh through the merchant's own draft door instead of /files. */
  preview?: boolean;
}

/**
 * Wave 2 and the projection: the PublicBlueprint of `head`'s revision, and
 * whether its store takes orders today (the route decides what that means for
 * the caller). Null when the revision holds no spec.
 */
export async function projectBlueprint(
  db: D1Database,
  head: BlueprintHead,
  opts: ProjectOptions = {}
): Promise<{ blueprint: PublicBlueprint; takingOrders: boolean } | null> {
  const full = specOf(head.row);
  if (!full) return null;
  const pub = publicSpecOf(full);
  const ids = [...new Set(pub.slots.flatMap((s) => s.options.filter((o) => o.part.src !== 'levonis').map((o) => o.part.p)))];
  const now = new Date().toISOString();
  const [variants, shelf, parts, named, prefs, sells] = await Promise.all([
    productVariants(db, head.product),
    db
      .prepare('SELECT material_id, color_hex, color_name, grams FROM merchant_material_stock WHERE merchant_id = ?1')
      .bind(head.merchant.id)
      .all<ShelfRow>()
      .then((r) => r.results ?? [])
      .catch(() => [] as ShelfRow[]),
    ids.length ? loadStoreParts(db, head.store.id, { ids }) : Promise.resolve([] as StorePart[]),
    ids.length
      ? db
          .prepare(
            `SELECT id, name, images, price_iqd FROM community_products
              WHERE store_id = ?1 AND id IN (SELECT value FROM json_each(?2))`
          )
          .bind(head.store.id, JSON.stringify(ids))
          .all<{ id: string; name: string; images: string; price_iqd: number }>()
          .then((r) => r.results ?? [])
      : Promise.resolve([] as Array<{ id: string; name: string; images: string; price_iqd: number }>),
    db
      .prepare('SELECT max_build_mm FROM merchant_request_prefs WHERE merchant_id = ?1')
      .bind(head.merchant.id)
      .first<{ max_build_mm: string | null }>()
      .catch(() => null),
    ownerSells(db, head.store.user_id, now),
  ]);

  const slot_options: Record<string, PublicSlotOption[]> = {};
  for (const s of pub.slots) {
    const list: PublicSlotOption[] = [];
    for (const o of s.options) {
      if (o.part.src === 'levonis') continue;
      const row = parts.find((r) => r.product_id === o.part.p && r.variant_id === (o.part.v ?? null));
      if (row) {
        list.push({
          key: o.key,
          product_id: row.product_id,
          variant_id: row.variant_id,
          name: row.label ? `${row.name} · ${row.label}` : row.name,
          image: row.image,
          unit_iqd: row.unit_iqd,
          in_stock: row.in_stock,
        });
        continue;
      }
      // Archived, hidden by Levonis or a variant gone: still listed, never sold (COMPONENT_OUT in the check).
      const gone = named.find((n) => n.id === o.part.p);
      if (gone) {
        list.push({
          key: o.key,
          product_id: gone.id,
          variant_id: o.part.v ?? null,
          name: String(gone.name ?? ''),
          image: safeParse<unknown[]>(gone.images, []).find((x): x is string => typeof x === 'string') ?? null,
          unit_iqd: Math.max(0, Math.trunc(Number(gone.price_iqd) || 0)),
          in_stock: false,
        });
      }
    }
    slot_options[s.id] = list;
  }

  const bed = safeParse<Record<string, unknown>>(prefs?.max_build_mm, {});
  const max: Vec3 = [Number(bed.x) || 0, Number(bed.y) || 0, Number(bed.z) || 0];
  const a = analysisOf(head.row);
  const photoOnly = isPhotoOnly(full);
  const look = lookOf(head.row);
  const keys = photoKeysOf(head.row);
  const meshUrl = opts.preview ? (head.row.draft_mesh_key ? draftMeshUrl(head.row.product_id, head.row.rev) : null) : head.row.mesh_key ? `/files/${head.row.mesh_key}` : null;
  const dims = Array.isArray(a.dims_mm) && a.dims_mm.length === 3 ? (a.dims_mm as Vec3) : ([0, 0, 0] as Vec3);
  const blueprint: PublicBlueprint = {
    ...pub,
    product: {
      id: head.product.id,
      slug: head.product.slug,
      store_slug: head.store.slug,
      name: head.product.name,
      price_iqd: head.product.price_iqd,
      prep_days: head.product.prep_days,
    },
    // A variant whose size/look/quality value the revision does not annotate (added to the product after
    // the publish) is not offered until a revision annotates it.
    variants: variants
      .filter((v) => [pub.axes.size, pub.axes.look, pub.axes.tier].every((ax) => !ax || ax.values[v.values[ax.group]] !== undefined))
      .map((v) => ({ id: v.id, values: v.values, price_iqd: v.price_iqd, in_stock: v.in_stock })),
    mesh:
      photoOnly || !meshUrl
        ? null
        : {
            url: meshUrl,
            hash: String((opts.preview ? a.hash : head.row.mesh_hash) ?? ''),
            bytes: Number((opts.preview ? a.bytes : head.row.mesh_bytes) ?? 0),
            triangles: Number((opts.preview ? a.triangles : head.row.triangles) ?? 0),
            dims_mm: dims,
          },
    look: look && !photoOnly ? { poster_url: `/files/${look.poster_key}`, w: look.w, h: look.h, idmap: look.idmap, quads: look.quads, camera: look.camera } : null,
    photos: pub.photos.flatMap((p) => (keys[p.media_id] ? [{ ...p, url: `/files/${keys[p.media_id]}` }] : [])),
    ...shelfStock(pub, shelf),
    slot_options,
    printer: max[0] > 0 && max[1] > 0 && max[2] > 0 ? { max_mm: max } : null,
    from_iqd: Math.max(0, Math.trunc(Number(head.row.from_iqd) || 0)),
    rev: head.row.rev,
  };
  return { blueprint, takingOrders: storeTakesOrdersNow(head, sells) };
}

/**
 * The guest's PublicBlueprint of a product's live revision (or `rev`), in two
 * waves — null when the product or its store should not be personalised
 * right now (the route's 404). No switch here: dark or not is the route's.
 */
export async function buildPublicBlueprint(db: D1Database, _env: Pick<Env, 'DB'> | null, productId: string, rev: number | null = null): Promise<PublicBlueprint | null> {
  const head = await loadBlueprintHead(db, productId, rev);
  if (!head || !productOnShelf(head)) return null;
  const out = await projectBlueprint(db, head);
  return out && out.takingOrders ? out.blueprint : null;
}

/**
 * The builder's preview of a revision it holds (the draft, else the live
 * one): the same projection, the mesh through the merchant's own draft door.
 * Private to the merchant (the builder route answers it `private, no-store`).
 * `known` is the product, store and merchant the builder's gate already read
 * — then the preview costs the projection's one wave and nothing more.
 */
export async function buildPreviewBlueprint(db: D1Database, row: BlueprintRow | null, known?: Omit<BlueprintHead, 'row'>): Promise<PublicBlueprint | null> {
  if (!row) return null;
  if (known) return (await projectBlueprint(db, { row, ...known }, { preview: true }))?.blueprint ?? null;
  const head = await db
    .prepare(
      `SELECT p.slug, p.name, p.price_iqd, p.prep_days, p.variant_mode, p.track_stock, p.stock, p.lifecycle, p.status, p.publish_state,
              p.audience_user_id, s.slug AS s_slug, s.user_id AS s_user, s.status AS s_status, s.sells_direct_products AS s_sells,
              m.id AS m_id, m.status AS m_status
         FROM community_products p
         JOIN merchant_stores s ON s.id = p.store_id
         JOIN community_merchants m ON m.id = s.merchant_id
        WHERE p.id = ?1`
    )
    .bind(row.product_id)
    .first<Record<string, unknown>>();
  if (!head) return null;
  const out = await projectBlueprint(
    db,
    {
      row,
      product: {
        id: row.product_id,
        slug: String(head.slug ?? ''),
        name: String(head.name ?? ''),
        price_iqd: Math.max(0, Math.trunc(Number(head.price_iqd) || 0)),
        prep_days: Math.max(0, Math.trunc(Number(head.prep_days) || 0)),
        variant_mode: String(head.variant_mode ?? 'simple'),
        track_stock: Number(head.track_stock ?? 1),
        stock: Number(head.stock ?? 0),
        lifecycle: String(head.lifecycle ?? ''),
        status: String(head.status ?? ''),
        publish_state: String(head.publish_state ?? ''),
        audience_user_id: (head.audience_user_id as string | null) ?? null,
        merchant_id: row.merchant_id,
        store_id: row.store_id,
      },
      store: { id: row.store_id, slug: String(head.s_slug ?? ''), user_id: String(head.s_user ?? ''), status: String(head.s_status ?? ''), sells_direct_products: Number(head.s_sells ?? 0) },
      merchant: { id: String(head.m_id ?? ''), status: String(head.m_status ?? '') },
    },
    { preview: true }
  );
  return out?.blueprint ?? null;
}
