/**
 * THE LEVO CARE PART OFFER AS THE SCREENS READ IT (phase 5; DECISIONS row 358): the product card of an offer
 * (picture, names, today's price for THE CLAIMANT, the price after the discount, its state), and the product
 * rules of the staff picker. The price is the storefront's own card for that customer
 * (`resolveListingCards`), never a second price; the checkout re-prices anyway.
 */
import { pricingCtxForUser, resolveListingCards } from './catalog/cardsRead';
import { optimisticSellableFlag, optimisticVisible, runListed } from './listing';
import { cardLeadPhoto } from './cardPhoto';
import { printerProductIds } from './printerIdentity';
import { likePattern } from './sqlLike';
import { grantState, type CarePartGrantRow, type GrantState } from './carePartGrants';

export interface GrantProduct {
  id: string;
  slug: string;
  name: string;
  name_ar: string;
  name_ku: string;
  image: string;
  /** The product has options or colours: the customer chooses them on the product page. */
  needs_choices: boolean;
  /** On sale right now for this customer (a price is shown on its card). */
  available: boolean;
}

export interface PartGrantPublic {
  id: string;
  claim_id: string;
  /** null = the product was deleted since. */
  product: GrantProduct | null;
  discount_pct: number;
  max_discount_iqd: number | null;
  /** The customer's unit price now (base selection), or null when it is not on sale. */
  price_iqd: number | null;
  /** min(floor(price × pct / 100), max_discount_iqd). */
  discount_iqd: number | null;
  after_iqd: number | null;
  state: GrantState;
  expires_at: string;
  created_at: string;
  used_order_id: string | null;
  /** What the offer actually took off the order that used it. */
  discount_given_iqd: number | null;
}
export interface PartGrantAdmin extends PartGrantPublic {
  misuse: boolean;
  note: string;
  created_by: string;
  revoked_at: string | null;
  revoked_by: string | null;
  revoke_reason: string | null;
  coupon_id: string;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
const text = (v: unknown) => (typeof v === 'string' ? v : '');

interface PricedProduct { product: GrantProduct; price_iqd: number | null; row: Record<string, unknown> }

/** Which of these products ask the customer for a choice (an active option value or an active colour). */
async function productsWithChoices(db: D1Database, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const { results } = await db
    .prepare(
      `SELECT DISTINCT product_id FROM (
         SELECT v.product_id FROM product_option_values v JOIN product_option_groups g ON g.id = v.group_id
          WHERE v.active = 1 AND g.active = 1 AND v.product_id IN (SELECT value FROM json_each(?1))
         UNION ALL
         SELECT c.product_id FROM product_colors c WHERE c.active = 1 AND c.product_id IN (SELECT value FROM json_each(?1)))`
    )
    .bind(JSON.stringify(ids))
    .all<{ product_id: string }>();
  return new Set((results ?? []).map((r) => String(r.product_id)));
}

/** A failure of the database or the platform, not of one product's own data: it must surface (5xx), never read as «this product has no price». */
const isStorageFailure = (e: unknown) => /D1_|SQLITE|no such (table|column)|database|network|timed? ?out|too many|fetch failed/i.test(String((e as Error)?.message ?? e));

/**
 * ONE PRODUCT NEVER TAKES THE PICKER DOWN (live bug 2026-11-19: `?q=hotend` answered 500 while `?q=hot`
 * answered 200). The storefront's card builder is asked for the whole page at once. When it throws on a
 * PRODUCT'S OWN DATA (a row it cannot project), every row is asked for on its own and the one that still
 * throws has no card: the picker shows it with its own name, `price_iqd: null` and `available: false`, and
 * its id is logged. A storage failure is never swallowed — not for the batch, not for a row — and when
 * EVERY row of a page fails alone the batch's own error is thrown: that is not one bad product.
 */
async function cardsOneByOneOnFailure(
  db: D1Database, rows: Record<string, unknown>[], ctx: Awaited<ReturnType<typeof pricingCtxForUser>>
): Promise<Map<string, Record<string, unknown>>> {
  let batchError: unknown;
  try {
    return await resolveListingCards(db, rows, ctx, null, 'flag');
  } catch (e) {
    if (isStorageFailure(e)) throw e;
    batchError = e;
    console.error('[care-part] card batch failed; pricing one by one', String((e as Error)?.message ?? e));
  }
  const out = new Map<string, Record<string, unknown>>();
  let failed = 0;
  for (const row of rows) {
    try {
      const card = (await resolveListingCards(db, [row], ctx, null, 'flag')).get(String(row.id));
      if (card) out.set(String(row.id), card);
    } catch (e) {
      if (isStorageFailure(e)) throw e;
      failed += 1;
      console.error('[care-part] product cannot be priced', String(row.id), String((e as Error)?.message ?? e));
    }
  }
  if (rows.length > 1 && failed === rows.length) throw batchError;
  return out;
}

/** VISIBLE product rows → their card facts and today's price for `userId`. A hidden or deleted product is absent. */
async function pricedProducts(db: D1Database, rows: Record<string, unknown>[], userId: string | null): Promise<Map<string, PricedProduct>> {
  const out = new Map<string, PricedProduct>();
  if (!rows.length) return out;
  const ids = rows.map((r) => String(r.id));
  const ctx = await pricingCtxForUser(db, userId);
  const [cards, choices] = await Promise.all([
    cardsOneByOneOnFailure(db, rows, ctx),
    productsWithChoices(db, ids),
  ]);
  for (const row of rows) {
    const id = String(row.id);
    const card = cards.get(id) ?? null;
    const price = card && typeof card.display_price_iqd === 'number' && Number.isFinite(card.display_price_iqd) && card.display_price_iqd > 0 ? Math.trunc(card.display_price_iqd) : null;
    const firstImage = (() => {
      try {
        const list = JSON.parse(text(row.images) || '[]') as unknown;
        return Array.isArray(list) ? (list.find((u) => typeof u === 'string' && u) as string | undefined) ?? '' : '';
      } catch {
        return '';
      }
    })();
    out.set(id, {
      row,
      price_iqd: price,
      product: {
        id,
        slug: text(row.slug),
        name: text(card?.name) || text(row.name),
        name_ar: text(card?.name_ar) || text(row.name_ar),
        name_ku: text(card?.name_ku) || text(row.name_ku),
        image: (card ? cardLeadPhoto(card)?.src : '') || firstImage,
        needs_choices: choices.has(id),
        available: price !== null,
      },
    });
  }
  return out;
}

async function visibleRows(db: D1Database, where: string, binds: unknown[], tail = ''): Promise<Record<string, unknown>[]> {
  const { results } = await runListed(
    db,
    `SELECT *, ${optimisticSellableFlag(db)} AS sellable_now FROM products WHERE ${optimisticVisible(db)} AND ${where}${tail}`,
    (q) => db.prepare(q).bind(...binds).all<Record<string, unknown>>()
  );
  return results ?? [];
}

/** min(floor(price × pct / 100), ceiling) — the same arithmetic `allocateCareOffers` applies to one unit. */
export function partDiscountOf(priceIqd: number, pct: number, maxIqd: number | null): number {
  let d = Math.floor((Math.max(0, Math.trunc(priceIqd)) * Math.max(0, Math.trunc(pct))) / 100);
  if (maxIqd !== null) d = Math.min(d, Math.max(0, Math.trunc(maxIqd)));
  return Math.max(0, Math.min(d, Math.max(0, Math.trunc(priceIqd))));
}

/** The offers as cards. Prices are the CLAIMANT's (`userId`), for the desk too: it is his offer. */
export async function partGrantViews(db: D1Database, grants: CarePartGrantRow[], userId: string, opts: { admin: true }): Promise<PartGrantAdmin[]>;
export async function partGrantViews(db: D1Database, grants: CarePartGrantRow[], userId: string, opts?: { admin?: false }): Promise<PartGrantPublic[]>;
export async function partGrantViews(db: D1Database, grants: CarePartGrantRow[], userId: string, opts: { admin?: boolean } = {}): Promise<PartGrantPublic[]> {
  if (!grants.length) return [];
  const ids = [...new Set(grants.map((g) => g.product_id).filter(Boolean))];
  const priced = await pricedProducts(db, await visibleRows(db, 'products.id IN (SELECT value FROM json_each(?))', [JSON.stringify(ids)]), userId);
  // A product hidden since still has a name and a picture to show (it is only not on sale).
  const missing = ids.filter((id) => !priced.has(id));
  const hidden = missing.length
    ? (await db.prepare('SELECT id, slug, name, name_ar, name_ku, images FROM products WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(missing)).all<Record<string, unknown>>()).results ?? []
    : [];
  const hiddenById = new Map(hidden.map((r) => [String(r.id), r]));
  const now = Date.now();
  return grants.map((g) => {
    const p = priced.get(g.product_id);
    const h = hiddenById.get(g.product_id);
    let hiddenImage = '';
    if (h) {
      try {
        const list = JSON.parse(text(h.images) || '[]') as unknown;
        if (Array.isArray(list)) hiddenImage = (list.find((u) => typeof u === 'string' && u) as string | undefined) ?? '';
      } catch { /* no picture */ }
    }
    const product: GrantProduct | null = p
      ? p.product
      : h
        ? { id: String(h.id), slug: text(h.slug), name: text(h.name), name_ar: text(h.name_ar), name_ku: text(h.name_ku), image: hiddenImage, needs_choices: false, available: false }
        : null;
    const pct = Math.trunc(num(g.discount_pct));
    const max = g.max_discount_iqd === null || g.max_discount_iqd === undefined ? null : Math.trunc(num(g.max_discount_iqd));
    const price = p?.price_iqd ?? null;
    const discount = price === null ? null : partDiscountOf(price, pct, max);
    const state = grantState(g, now);
    const pub: PartGrantPublic = {
      id: g.id,
      claim_id: g.claim_id,
      product,
      discount_pct: pct,
      max_discount_iqd: max,
      price_iqd: price,
      discount_iqd: discount,
      after_iqd: price === null || discount === null ? null : price - discount,
      state,
      expires_at: g.expires_at,
      created_at: g.created_at,
      used_order_id: state === 'used' ? g.used_order_id : null,
      discount_given_iqd: state === 'used' ? Math.trunc(num(g.discount_given_iqd)) : null,
    };
    if (!opts.admin) return pub;
    const admin: PartGrantAdmin = {
      ...pub,
      misuse: !!g.misuse,
      note: g.note ?? '',
      created_by: g.created_by,
      revoked_at: g.revoked_at ?? null,
      revoked_by: g.revoked_by ?? null,
      revoke_reason: g.revoke_reason ?? null,
      coupon_id: g.coupon_id,
    };
    return admin;
  });
}

/**
 * MAY THIS PRODUCT BE OFFERED AS A PART? A store product visible in the catalogue, sold on its own: not a
 * printer, not a bundle / mystery composition. (A membership is not a product here, so it can never be named.)
 * Returns its card facts and today's price for `userId`, or null.
 */
export async function offerablePart(db: D1Database, productId: string, userId: string | null): Promise<(GrantProduct & { price_iqd: number | null }) | null> {
  if (!productId) return null;
  const rows = await visibleRows(db, "products.id = ? AND products.composition = ''", [productId]);
  if (!rows.length) return null;
  if ((await printerProductIds(db, [productId])).has(productId)) return null;
  const p = (await pricedProducts(db, rows, userId)).get(productId);
  return p ? { ...p.product, price_iqd: p.price_iqd } : null;
}

/** The staff picker: up to 20 offerable parts matching `q` (name in any language, slug, SKU), priced for `userId`. */
export async function searchOfferableParts(db: D1Database, q: string, userId: string | null): Promise<Array<GrantProduct & { price_iqd: number | null }>> {
  const like = likePattern(q);
  const where = like
    ? "products.composition = '' AND (products.name LIKE ?1 ESCAPE '\\' OR products.name_ar LIKE ?1 ESCAPE '\\' OR products.name_ku LIKE ?1 ESCAPE '\\' OR products.slug LIKE ?1 ESCAPE '\\' OR COALESCE(products.sku, '') LIKE ?1 ESCAPE '\\')"
    : "products.composition = ''";
  // Read a little past the page: printers are dropped after the read.
  const rows = await visibleRows(db, where, like ? [like] : [], ' ORDER BY products.display_order ASC, products.created_at DESC, products.id ASC LIMIT 60');
  const printers = await printerProductIds(db, rows.map((r) => String(r.id)));
  const kept = rows.filter((r) => !printers.has(String(r.id))).slice(0, 20);
  const priced = await pricedProducts(db, kept, userId);
  return kept.flatMap((r) => {
    const p = priced.get(String(r.id));
    return p ? [{ ...p.product, price_iqd: p.price_iqd }] : [];
  });
}
