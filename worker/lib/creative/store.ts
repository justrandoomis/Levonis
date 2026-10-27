/**
 * THE STORE CONNECTOR — READ-ONLY, THROUGH THE PUBLIC CARD PATH
 * (spec §9; docs/CREATIVE_STUDIO.md §5).
 *
 * The studio quotes what a guest sees NOW, through the same functions the
 * storefront draws with (worker/lib/catalog/cardsRead.ts): the storefront's
 * visibility rule, `pricingCtxForUser(db, null)` (the signed-out viewer),
 * `resolveListingCards` → `priceFromCard` → `cardAvailability`, and for one
 * option of a product `resolveVariantPricing`, the resolver the product page,
 * the comparison and the printer finder already use. Nothing here prices,
 * counts stock or decides sellability itself, and nothing here writes.
 *
 * AN ALLOW-LIST, BUILT FIELD BY FIELD. The marketing snapshot
 * (packages/creativeDoc/src/snapshot.ts `ProductSnapshotData`) has no field
 * for a cost, a margin, a supplier, a stock count, a sale count or an investor
 * figure, and every value below is copied into it by name — no row or card is
 * ever spread into an answer. The cost-leak role sweeps walk every studio GET.
 *
 * PRICE SEMANTICS (spec §9, acceptance 2):
 *   unpriced      status 'unpriced', amount null — NEVER 0
 *   members-only  status 'members_only' (a locked composition): no public number
 *   live PUBLIC offer  the offer window and the struck regular price; a
 *                 members-only window is not an offer here
 *   membership teaser  only in `member_price_iqd`, never as the public price
 * AVAILABILITY is the card rule: a pre-order is never 'available', an unpriced
 * product is 'unknown'.
 *
 * VARIANTS. `variant_key` is `ov:<option value id>` — one active option of the
 * product (a model: «A1» vs «A1 Combo»). Its price is that option's own level
 * from `resolveVariantPricing` (the lowest of its SKUs, `from` when they
 * differ); its availability is 'available' only on a positive stock count for
 * that option, never inherited from a sibling; its pictures are the
 * product-wide ones plus the ones bound to that option. KNOWN LIMIT: colours
 * and option combinations are not variants here, and pictures bound only to a
 * colour or a combination appear in the product detail (with their binding)
 * but in no snapshot — the brief's rule is that the picture, the price and the
 * availability belong to the SAME option, and a colour-only picture cannot be
 * proven to belong to one model. The product-level snapshot carries only
 * product-wide pictures for the same reason.
 */
import { cardAvailability, compositionAvailability, type AvailabilityState } from '../../../packages/catalog/src/availability';
import { cleanText } from '../../../packages/creativeDoc/src/text';
import type { ProductDetailDto, ProductListItemDto, ProductVariantDto } from '../../../packages/creativeDoc/src/api';
import { canonicalJson, type Localized, type ProductSnapshotData, type SnapshotAvailability, type SnapshotImage, type SnapshotPrice } from '../../../packages/creativeDoc/src/snapshot';
import { listCatalogProducts, pricingCtxForUser, resolveListingCards, resolveVariantPricing, type PricingCtx } from '../catalog/cardsRead';
import { sha256Hex } from '../crypto';
import { loadProductKnowledge } from '../knowledge/productKnowledge';
import { optimisticSellable, optimisticSellableFlag, optimisticVisible, runListed } from '../listing';
import { offerFromCard, priceFromCard } from '../publicApi/common';

type Row = Record<string, unknown>;

const text = (v: unknown) => (typeof v === 'string' ? v : '');
const intOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
const loc = (ar: unknown, en: unknown, ckb: unknown): Localized => ({ ar: text(ar).slice(0, 300), en: text(en).slice(0, 300), ckb: text(ckb).slice(0, 300) });
const emptyLoc = (l: Localized | null) => !l || (!l.ar && !l.en && !l.ckb);

/** The signed-out viewer's pricing context — what a guest sees. */
export function guestPricing(db: D1Database): Promise<PricingCtx> {
  return pricingCtxForUser(db, null);
}

// ---------------------------------------------------------------------------
// Price and availability from a card
// ---------------------------------------------------------------------------

/** A live window open to everyone (no tier required, not the members' lock) that priced the card's figure. */
function livePublicOffer(card: Row): { starts_at: string | null; ends_at: string | null } | null {
  const o = offerFromCard(card);
  if (!o || o.members_only) return null;
  const raw = card.offer as Row | undefined;
  const tiers = raw?.required_tiers;
  const publicWindow = Array.isArray(tiers) ? tiers.length === 0 : tiers === undefined || tiers === '[]' || tiers === '';
  if (!publicWindow || raw?.price_source !== 'offer') return null;
  return { starts_at: o.starts_at, ends_at: o.ends_at };
}

const UNPRICED: SnapshotPrice = Object.freeze({ status: 'unpriced', amount_iqd: null, regular_iqd: null, from: false, offer: null, member_price_iqd: null }) as SnapshotPrice;

/** The price a guest sees on this card, its kinds kept apart (exported for tests). */
export function priceOfCard(card: Row): SnapshotPrice {
  const locked = card.locked === true;
  const p = priceFromCard(card, locked);
  if (p.status === 'members_only') return { ...UNPRICED, status: 'members_only' };
  if (p.status !== 'priced' || p.amount === null || p.amount <= 0) return { ...UNPRICED };
  const offer = livePublicOffer(card);
  const before = intOrNull(card.display_offer_before_iqd);
  const teasers = [intOrNull(card.display_pro_iqd), intOrNull(card.display_prime_iqd)].filter((x): x is number => x !== null && x > 0 && x < p.amount!);
  return {
    status: 'priced',
    amount_iqd: p.amount,
    regular_iqd: offer && before !== null && before > p.amount ? before : null,
    from: p.from,
    offer: offer && before !== null && before > p.amount ? offer : null,
    member_price_iqd: teasers.length ? Math.min(...teasers) : null,
  };
}

/** The card's availability: the composition verdict for a bundle, the card rule for a product. */
export function availabilityOfCard(card: Row, row: Row): SnapshotAvailability {
  if (String(row.composition ?? '') !== '') return compositionAvailability(card.availability_state) as AvailabilityState;
  return cardAvailability(card).state;
}

const saleTypesOf = (card: Row): string[] =>
  Array.isArray(card.sale_types) ? (card.sale_types as unknown[]).filter((t): t is string => t === 'direct_sale' || t === 'pre_order' || t === 'bundle') : [];

// ---------------------------------------------------------------------------
// Reading visible products
// ---------------------------------------------------------------------------

/** VISIBLE rows by id, read under the storefront's own rule (`catalogByIds` in the support assistant does the same). */
async function visibleRows(db: D1Database, ids: string[]): Promise<Row[]> {
  if (!ids.length) return [];
  const scope = `${optimisticVisible(db)} AND (products.composition = '' OR ${optimisticSellable(db)})`;
  const { results } = await runListed(
    db,
    `SELECT *, ${optimisticSellableFlag(db)} AS sellable_now FROM products WHERE ${scope} AND products.id IN (SELECT value FROM json_each(?))`,
    (q) => db.prepare(q).bind(JSON.stringify(ids)).all<Row>()
  );
  return results ?? [];
}

async function brandNames(db: D1Database, ids: string[]): Promise<Map<string, Localized>> {
  const out = new Map<string, Localized>();
  const wanted = [...new Set(ids.filter(Boolean))];
  if (!wanted.length) return out;
  const { results } = await db.prepare('SELECT id, name_ar, name_en, name_ckb FROM brands WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(wanted)).all<Row>();
  for (const r of results ?? []) out.set(String(r.id), loc(r.name_ar, r.name_en, r.name_ckb));
  return out;
}

async function categoryNames(db: D1Database, ids: string[]): Promise<Map<string, Localized>> {
  const out = new Map<string, Localized>();
  const wanted = [...new Set(ids.filter(Boolean))];
  if (!wanted.length) return out;
  const { results } = await db.prepare('SELECT id, name_ar, name_en, name_ckb FROM catalogs WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(wanted)).all<Row>();
  for (const r of results ?? []) out.set(String(r.id), loc(r.name_ar, r.name_en, r.name_ckb));
  return out;
}

const nameOf = (row: Row): Localized => loc(row.name_ar, row.name, row.name_ku);

/** The first lines of a description, without markup, for `short_description`. */
function shortText(v: unknown): string {
  return cleanText(text(v).replace(/<[^>]*>/g, ' ').replace(/[#*_`>[\]]/g, ' '), 300).value;
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export interface ProductListQuery {
  q: string;
  category: string;
  limit: number;
  offset: number;
}

function cardImage(card: Row): ProductListItemDto['image'] {
  const media = Array.isArray(card.media) ? (card.media as Row[]) : [];
  const images = Array.isArray(card.images) ? (card.images as unknown[]) : [];
  const url = text(images[0]) || text(media[0]?.url);
  if (!url) return null;
  const m = media.find((x) => text(x?.url) === url) ?? media[0];
  return { url, same_origin: url.startsWith('/files/'), width: intOrNull(m?.width), height: intOrNull(m?.height) };
}

/** The storefront listing (search, category, paging) as studio list items — the listing's own visibility and price. */
export async function listProducts(db: D1Database, query: ProductListQuery): Promise<{ products: ProductListItemDto[]; total: number | null }> {
  const q: Record<string, string> = { limit: String(query.limit), offset: String(query.offset) };
  // The trailing space says the last word is finished (the listing's own convention, routes/products.ts).
  if (query.q) q.search = `${query.q} `;
  if (query.category) q.category = query.category;
  const listing = await listCatalogProducts(db, q, guestPricing(db), { withTotal: true });
  const cards = Array.isArray(listing.body.products) ? (listing.body.products as Row[]) : [];
  const ids = cards.map((c) => text(c.id)).filter(Boolean);
  const [brands, options] = await Promise.all([
    brandNames(db, cards.map((c) => text(c.brand_id))),
    ids.length
      ? db
          .prepare(`SELECT product_id, COUNT(*) AS n FROM product_option_values WHERE active = 1 AND product_id IN (SELECT value FROM json_each(?)) GROUP BY product_id`)
          .bind(JSON.stringify(ids))
          .all<{ product_id: string; n: number }>()
      : Promise.resolve({ results: [] as Array<{ product_id: string; n: number }> }),
  ]);
  const optionCount = new Map((options.results ?? []).map((r) => [r.product_id, r.n]));
  const products: ProductListItemDto[] = [];
  for (const card of cards) {
    const id = text(card.id);
    if (!id) continue;
    const row = listing.rows.get(id) ?? card;
    const price = priceOfCard(card);
    products.push({
      id,
      slug: text(card.product_slug ?? card.slug ?? row.slug),
      name: nameOf(row),
      brand: brands.get(text(card.brand_id)) ?? null,
      image: cardImage(card),
      price_status: price.status,
      display_price_iqd: price.status === 'priced' ? price.amount_iqd : null,
      availability: availabilityOfCard(card, row),
      has_variants: (optionCount.get(id) ?? 0) > 1,
      category_id: text(card.category_id) || null,
    });
  }
  const total = typeof listing.body.total === 'number' ? listing.body.total : null;
  return { products, total };
}

// ---------------------------------------------------------------------------
// One product
// ---------------------------------------------------------------------------

interface ImageRow {
  url: string;
  alt_en: string;
  alt_ar: string | null;
  alt_ckb: string | null;
  is_primary: number;
  option_value_id: string | null;
  color_id: string | null;
  variant_id: string | null;
  width: number | null;
  height: number | null;
}

const bindingKey = (r: ImageRow): string | null =>
  r.option_value_id ? `ov:${r.option_value_id}` : r.color_id ? `c:${r.color_id}` : r.variant_id ? `v:${r.variant_id}` : null;

async function productImages(db: D1Database, productId: string): Promise<SnapshotImage[]> {
  const { results } = await db
    .prepare(
      `SELECT url, alt_en, alt_ar, alt_ckb, is_primary, option_value_id, color_id, variant_id, width, height
         FROM product_images WHERE product_id = ? AND COALESCE(quarantined, 0) = 0
        ORDER BY is_primary DESC, sort_order, id LIMIT 40`
    )
    .bind(productId)
    .all<ImageRow>();
  return (results ?? [])
    .filter((r) => typeof r.url === 'string' && r.url.length > 0 && r.url.length <= 420)
    .map((r) => ({
      url: r.url,
      width: intOrNull(r.width),
      height: intOrNull(r.height),
      alt: (r.alt_ar || r.alt_en || '').slice(0, 300),
      primary: r.is_primary === 1,
      variant_key: bindingKey(r),
      same_origin: r.url.startsWith('/files/'),
    }));
}

interface OptionInfo {
  id: string;
  label: Localized;
}

async function activeOptions(db: D1Database, productId: string): Promise<OptionInfo[]> {
  const { results } = await db
    .prepare(
      `SELECT v.id, v.name_en, v.name_ar, v.name_ckb FROM product_option_values v
         JOIN product_option_groups g ON g.id = v.group_id AND g.active = 1
        WHERE v.product_id = ? AND v.active = 1 AND COALESCE(v.merged_into, '') = ''
        ORDER BY g.sort, v.sort, v.id LIMIT 40`
    )
    .bind(productId)
    .all<Row>();
  return (results ?? []).map((r) => ({ id: String(r.id), label: loc(r.name_ar, r.name_en, r.name_ckb) }));
}

/** Specs (verified, displayable, product-wide or this option's) and box contents, from the public knowledge answer. */
async function specsAndContents(db: D1Database, productId: string, optionId: string | null): Promise<{ specs: ProductSnapshotData['specs']; contents: ProductSnapshotData['contents'] }> {
  const k = await loadProductKnowledge(db, productId);
  const inScope = (s: { kind: string; id: string }) => s.kind === 'product' || (optionId !== null && s.kind === 'option_value' && s.id === optionId);
  const specs: ProductSnapshotData['specs'] = [];
  for (const g of k.specs) {
    for (const r of g.rows) {
      if (specs.length >= 24) break;
      if (r.status !== 'verified' || r.display === false || !inScope(r.scope)) continue;
      let value = r.value_text.trim();
      if (!value && r.items?.length) value = r.items.slice(0, 6).join('، ');
      if (!value && r.value_num !== null) value = `${r.value_num}${r.value_num_max !== null ? `–${r.value_num_max}` : ''}${r.unit ? ` ${r.unit}` : ''}`;
      if (!value) continue; // a yes/no fact needs words this connector does not invent
      specs.push({ label: { ar: r.label.ar, en: r.label.en, ckb: r.label.ckb }, value: value.slice(0, 160) });
    }
  }
  const contents = k.in_the_box
    .filter((b) => b.status === 'verified' && inScope(b.scope))
    .slice(0, 20)
    .map((b) => ({ text: b.text.slice(0, 160), qty: typeof b.qty === 'number' && Number.isFinite(b.qty) ? b.qty : null }));
  return { specs, contents };
}

interface Resolved {
  row: Row;
  card: Row;
  images: SnapshotImage[];
  options: OptionInfo[];
  variants: Map<string, { price: SnapshotPrice; availability: SnapshotAvailability }>;
  brand: Localized | null;
  category: Localized | null;
}

/** One option's price from its resolved level: the guest's figure, a live public offer only when it lowered THIS option. */
function optionPrice(level: { applied_iqd: number; offer_before_iqd?: number | null }, from: boolean, cardOffer: { starts_at: string | null; ends_at: string | null } | null): SnapshotPrice {
  if (!(level.applied_iqd > 0)) return { ...UNPRICED };
  const before = typeof level.offer_before_iqd === 'number' && level.offer_before_iqd > level.applied_iqd ? level.offer_before_iqd : null;
  return {
    status: 'priced',
    amount_iqd: level.applied_iqd,
    regular_iqd: cardOffer && before !== null ? before : null,
    from,
    offer: cardOffer && before !== null ? cardOffer : null,
    member_price_iqd: null,
  };
}

/**
 * One option's availability, conservatively: 'available' only on a positive
 * stock count for THAT option; a pre-order where the option (or the product it
 * inherits from) is sold as one; otherwise the product's word with
 * 'available' downgraded to 'unknown' — a sibling's stock is not this one's.
 */
function optionAvailability(product: SnapshotAvailability, saleTypes: string[], option: { availability_type?: string }, available: number | null): SnapshotAvailability {
  if (product === 'unknown') return 'unknown';
  const type = option.availability_type ?? '';
  const direct = type === 'direct_sale' || (type === '' && (saleTypes.includes('direct_sale') || saleTypes.includes('bundle')));
  const preorder = type === 'pre_order' || (type === '' && saleTypes.includes('pre_order'));
  if (available !== null && available > 0 && direct) return 'available';
  if (preorder) return 'preorder';
  if (available === 0) return 'unavailable';
  return product === 'available' ? 'unknown' : product;
}

/** Everything about one VISIBLE product, through the card path; null when a guest cannot see it. */
async function resolveProduct(db: D1Database, productId: string): Promise<Resolved | null> {
  const rows = await visibleRows(db, [productId]);
  const row = rows[0];
  if (!row) return null;
  const ctx = await guestPricing(db);
  const card = (await resolveListingCards(db, [row], ctx, null, 'flag')).get(productId);
  if (!card) return null;
  const isComposition = String(row.composition ?? '') !== '';
  const [images, options, brands, categories] = await Promise.all([
    productImages(db, productId),
    isComposition ? Promise.resolve([] as OptionInfo[]) : activeOptions(db, productId),
    brandNames(db, [text(row.brand_id)]),
    categoryNames(db, [text(row.category_id)]),
  ]);
  const productPrice = priceOfCard(card);
  const productAvailability = availabilityOfCard(card, row);
  const variants = new Map<string, { price: SnapshotPrice; availability: SnapshotAvailability }>();
  if (options.length) {
    const sellable = row.sellable_now === 1 || row.sellable_now === true;
    const pricing = sellable && productPrice.status === 'priced' ? (await resolveVariantPricing(db, [row], ctx)).get(productId) : undefined;
    const cardOffer = productPrice.offer;
    const saleTypes = saleTypesOf(card);
    for (const o of options) {
      const resolved = pricing?.options.find((x) => x.option.id === o.id);
      // An option no priced SKU carries is not offered at a price (DECISIONS row 240): unpriced, never another option's figure.
      const price = resolved ? optionPrice(resolved.level, resolved.from, cardOffer) : { ...UNPRICED, status: productPrice.status === 'members_only' ? 'members_only' as const : 'unpriced' as const };
      const availability = price.status === 'priced' ? optionAvailability(productAvailability, saleTypes, resolved?.option ?? {}, resolved?.available ?? null) : 'unknown';
      variants.set(`ov:${o.id}`, { price, availability });
    }
  }
  return {
    row,
    card,
    images,
    options,
    variants,
    brand: brands.get(text(row.brand_id)) ?? null,
    category: categories.get(text(row.category_id)) ?? null,
  };
}

const pathOf = (row: Row) => {
  const slug = encodeURIComponent(text(row.slug));
  return String(row.composition ?? '') !== '' ? `/bundles/${slug}` : `/product/${slug}`;
};

/** The studio's product page: pictures with their bindings, the guest price and availability, each option, specs and contents. */
export async function productDetail(db: D1Database, productId: string): Promise<ProductDetailDto | null> {
  const p = await resolveProduct(db, productId);
  if (!p) return null;
  const { specs, contents } = await specsAndContents(db, productId, null);
  const wide = p.images.filter((i) => i.variant_key === null);
  const variants: ProductVariantDto[] = p.options.map((o) => {
    const key = `ov:${o.id}`;
    const v = p.variants.get(key)!;
    return { key, label: o.label, images: [...wide, ...p.images.filter((i) => i.variant_key === key)], price: v.price, availability: v.availability };
  });
  return {
    id: productId,
    slug: text(p.row.slug),
    path: pathOf(p.row),
    name: nameOf(p.row),
    brand: emptyLoc(p.brand) ? null : p.brand,
    category: emptyLoc(p.category) ? null : p.category,
    images: p.images,
    price: priceOfCard(p.card),
    availability: availabilityOfCard(p.card, p.row),
    variants,
    specs,
    contents,
  };
}

/**
 * The marketing snapshot of a product (or one option of it), as data — the
 * allow-list. `null` when a guest cannot see the product, or the option is
 * not one of its active options.
 */
export async function buildSnapshotData(db: D1Database, productId: string, variantKey: string | null): Promise<ProductSnapshotData | null> {
  const p = await resolveProduct(db, productId);
  if (!p) return null;
  let option: OptionInfo | null = null;
  if (variantKey !== null) {
    option = p.options.find((o) => `ov:${o.id}` === variantKey) ?? null;
    if (!option) return null;
  }
  const { specs, contents } = await specsAndContents(db, productId, option?.id ?? null);
  const variant = variantKey ? p.variants.get(variantKey)! : null;
  const images = p.images.filter((i) => i.variant_key === null || (variantKey !== null && i.variant_key === variantKey));
  return {
    product_id: productId,
    slug: text(p.row.slug),
    path: pathOf(p.row),
    variant_key: variantKey,
    variant_label: option ? option.label : null,
    name: nameOf(p.row),
    brand: emptyLoc(p.brand) ? null : p.brand,
    category: emptyLoc(p.category) ? null : p.category,
    sku: typeof p.row.sku === 'string' && p.row.sku ? p.row.sku.slice(0, 80) : null,
    short_description: { ar: shortText(p.row.description_ar), en: shortText(p.row.description), ckb: shortText(p.row.description_ku) },
    specs,
    contents,
    price: variant ? variant.price : priceOfCard(p.card),
    availability: variant ? variant.availability : availabilityOfCard(p.card, p.row),
    sale_types: saleTypesOf(p.card),
    images,
    source_updated_at: typeof p.row.updated_at === 'string' ? p.row.updated_at : null,
  };
}

/** sha256 of the canonical JSON — the same data always hashes the same. */
export function snapshotHash(data: ProductSnapshotData): Promise<string> {
  return sha256Hex(canonicalJson(data));
}

/** What the card says now about a batch of products (the catalogue watch): availability and the public price. */
export async function cardStates(
  db: D1Database,
  ids: string[]
): Promise<Map<string, { availability: SnapshotAvailability; price_status: SnapshotPrice['status']; display_price_iqd: number | null; offer: boolean; name: Localized; category_id: string | null }>> {
  const out = new Map<string, { availability: SnapshotAvailability; price_status: SnapshotPrice['status']; display_price_iqd: number | null; offer: boolean; name: Localized; category_id: string | null }>();
  const rows = await visibleRows(db, ids);
  if (!rows.length) return out;
  const cards = await resolveListingCards(db, rows, await guestPricing(db), null, 'flag');
  for (const row of rows) {
    const id = String(row.id);
    const card = cards.get(id);
    if (!card) continue;
    const price = priceOfCard(card);
    out.set(id, {
      availability: availabilityOfCard(card, row),
      price_status: price.status,
      display_price_iqd: price.status === 'priced' ? price.amount_iqd : null,
      offer: price.offer !== null,
      name: nameOf(row),
      category_id: text(row.category_id) || null,
    });
  }
  return out;
}

/** The visible product ids after `cursor`, in id order — one bounded page of the watch's pass. */
export async function visibleIdsAfter(db: D1Database, cursor: string, limit: number): Promise<string[]> {
  const { results } = await runListed(
    db,
    `SELECT products.id AS id FROM products WHERE ${optimisticVisible(db)} AND (products.composition = '' OR ${optimisticSellable(db)}) AND products.id > ? ORDER BY products.id LIMIT ?`,
    (q) => db.prepare(q).bind(cursor, limit).all<{ id: string }>()
  );
  return (results ?? []).map((r) => r.id);
}
