/**
 * WHAT A LAYOUT NEEDS FROM THE DATABASE, AND THE SHAPE IT ARRIVES IN.
 *
 * The public storefront answers a layout together with the rows its blocks
 * show (worker/lib/storeLayout.ts), so a store page paints from ONE answer
 * instead of a waterfall of per-section calls. `collectDataNeeds` is the pure
 * half of that: from the visible blocks it lists which queries to run — each
 * distinct product query once, at the largest size any block asked for — and
 * the server turns the list into a single batched read. Hidden blocks cost
 * nothing.
 *
 * The shapes below are the PUBLIC ones. They carry what a card shows and
 * nothing a competitor or a stranger should read: no stock counts, no cost,
 * no customer identity beyond the masked review name.
 */
import { BLOCKS, type FieldSpec } from './blocks';
import { renderableBlocks } from './normalize';
import type { LinkTarget } from './refs';
import type { StoreLayout } from './schema';

export type ProductSource = 'latest' | 'featured' | 'deals' | 'collection';

export interface ProductQuery {
  key: string;
  source: ProductSource;
  collection_id: string;
  limit: number;
}

export interface DataNeeds {
  products: ProductQuery[];
  /** Products a merchant picked by id (featured_products), across all blocks. */
  productIds: string[];
  collections: boolean;
  services: boolean;
  showcase: boolean;
  /** How many recent reviews to send; 0 = no reviews block. */
  reviews: number;
  printers: boolean;
  couponIds: string[];
}

/** Rows per product query, and the page size the storefront's own lists use. */
export const MAX_PRODUCT_QUERY = 24;
export const MAX_PICKED_PRODUCTS = 60;
/**
 * Distinct product queries per layout. They are read as ONE statement
 * (UNION ALL), and this keeps its bound parameters far below D1's 100.
 */
export const MAX_PRODUCT_QUERIES = 12;
export const MAX_COUPONS = 8;
/** The storefront's first page of reviews (the /reviews endpoint's default). */
export const TAB_REVIEWS = 20;

export function productQueryKey(source: ProductSource, collectionId = ''): string {
  return source === 'collection' ? `collection:${collectionId}` : source;
}

/**
 * Every product a block LINKS to (a banner's button, a call to action). The
 * link is an id; the address needs the product's slug, so a linked product
 * arrives with the picked ones — and a link to one that is gone or hidden
 * simply does not render.
 */
function linkedProducts(values: Record<string, unknown>, specs: { readonly [k: string]: FieldSpec }, add: (id: string) => void) {
  for (const key of Object.keys(specs)) {
    const spec = specs[key];
    const v = values[key];
    if (spec.t === 'link') {
      const link = v as LinkTarget | undefined;
      if (link && link.kind === 'product') add(link.id);
    } else if (spec.t === 'list' && Array.isArray(v)) {
      for (const item of v) linkedProducts(item as Record<string, unknown>, spec.item, add);
    }
  }
}

export function collectDataNeeds(layout: StoreLayout): DataNeeds {
  const queries = new Map<string, ProductQuery>();
  const ask = (source: ProductSource, collectionId: string, limit: number) => {
    if (source === 'collection' && !collectionId) return;
    const key = productQueryKey(source, collectionId);
    const size = Math.min(MAX_PRODUCT_QUERY, Math.max(1, limit));
    const prev = queries.get(key);
    if (!prev && queries.size >= MAX_PRODUCT_QUERIES) return;
    queries.set(key, { key, source, collection_id: source === 'collection' ? collectionId : '', limit: Math.max(prev?.limit ?? 0, size) });
  };
  const needs: DataNeeds = {
    products: [],
    productIds: [],
    collections: false,
    services: false,
    showcase: false,
    reviews: 0,
    printers: false,
    couponIds: [],
  };

  const pick = (id: string) => {
    if (!needs.productIds.includes(id) && needs.productIds.length < MAX_PICKED_PRODUCTS) needs.productIds.push(id);
  };

  for (const b of renderableBlocks(layout)) {
    linkedProducts(b.settings as unknown as Record<string, unknown>, BLOCKS[b.type].settings, pick);
    switch (b.type) {
      case 'products_grid':
      case 'products_carousel':
        ask(b.settings.source, b.settings.collection_id, b.settings.limit);
        break;
      case 'deals':
        ask('deals', '', b.settings.limit);
        break;
      case 'featured_products':
        b.settings.product_ids.forEach(pick);
        break;
      case 'collections':
        needs.collections = true;
        break;
      case 'coupon_banner':
        if (b.settings.coupon_id && !needs.couponIds.includes(b.settings.coupon_id) && needs.couponIds.length < MAX_COUPONS) {
          needs.couponIds.push(b.settings.coupon_id);
        }
        break;
      case 'services':
        needs.services = true;
        break;
      case 'showcase':
        needs.showcase = true;
        break;
      case 'reviews':
        needs.reviews = Math.max(needs.reviews, b.settings.limit);
        break;
      case 'printers':
        needs.printers = true;
        break;
      case 'tabs':
        for (const tab of b.settings.items) {
          if (tab === 'products') {
            ask('latest', '', MAX_PRODUCT_QUERY);
            needs.collections = true;
          } else if (tab === 'collections') needs.collections = true;
          else if (tab === 'deals') ask('deals', '', MAX_PRODUCT_QUERY);
          else if (tab === 'services') needs.services = true;
          else if (tab === 'showcase') needs.showcase = true;
          else if (tab === 'about' && b.settings.about_reviews) needs.reviews = Math.max(needs.reviews, TAB_REVIEWS);
        }
        break;
      default:
        break;
    }
  }
  needs.products = [...queries.values()];
  return needs;
}

// ---------------------------------------------------------- public shapes

export interface ProductCardData {
  id: string;
  slug: string;
  name: string;
  name_ar: string;
  /** The first picture only — a card shows one. */
  images: string[];
  price_iqd: number;
  original_price_iqd: number | null;
  /** Availability, never the count. */
  in_stock: boolean;
  featured: boolean;
  section_id: string | null;
  /** Sales rounded DOWN to a passed tier, or null (worker/lib/salesBadge.ts). */
  sales_tier: number | null;
}

export interface ProductPage {
  items: ProductCardData[];
  next_cursor: string | null;
}

export interface CollectionData {
  id: string;
  name: string;
  name_ar: string;
  product_count: number;
}

export interface ServiceData {
  id: string;
  title: string;
  description: string;
  kind: string;
  price_from_iqd: number | null;
  price_unit: string;
  materials: string[];
  imageUrl: string | null;
}

export interface ShowcaseData {
  id: string;
  kind: 'printer' | 'material' | 'work';
  title: string;
  details: string;
  imageUrl: string | null;
}

export interface ReviewData {
  id: string;
  rating: number;
  body: string;
  images: string[];
  verified: boolean;
  /** Masked: «Ahmed K.» — never the account name. */
  customer_name: string;
  merchant_reply: string | null;
  merchant_replied_at: string | null;
  created_at: string;
}

export interface ReviewsData {
  average: number | null;
  count: number;
  distribution: Record<string, number>;
  reviews: ReviewData[];
  next_cursor: string | null;
}

export interface PrinterData {
  id: string;
  name: string;
  technology: 'fdm' | 'resin';
  brand: string;
  model: string;
  /** Build volume in millimetres, x/y/z. */
  build_mm: [number, number, number];
  materials: Array<{ id: string; name_ar: string; name_en: string }>;
  multicolor: boolean;
  enclosed: boolean;
  quality_max: string;
}

export interface CouponData {
  id: string;
  code: string;
  kind: 'fixed_iqd' | 'percent';
  value: number;
  min_total_iqd: number;
  ends_at: string | null;
}

/**
 * The rows a layout's blocks show. `null` = not asked for (the block may load
 * it itself); `[]` = asked for, and there is none.
 */
export interface BlockData {
  products: Record<string, ProductPage>;
  picked: ProductCardData[];
  collections: CollectionData[] | null;
  services: ServiceData[] | null;
  showcase: ShowcaseData[] | null;
  reviews: ReviewsData | null;
  printers: PrinterData[] | null;
  coupons: CouponData[];
}

export function emptyBlockData(): BlockData {
  return { products: {}, picked: [], collections: null, services: null, showcase: null, reviews: null, printers: null, coupons: [] };
}
