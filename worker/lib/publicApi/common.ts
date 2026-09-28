/**
 * THE PUBLIC API'S SHARED PIECES — each DTO next to the schema that documents
 * it, so the two cannot be edited apart without a test noticing.
 *
 * EXPLICIT ALLOWLISTS. Every builder here constructs its output field by
 * field from the internal value; nothing is spread, nothing is copied "minus"
 * a list. A field the internal model gains tomorrow — a cost, a stock count,
 * a supplier link — does not reach a public answer until someone writes it
 * here AND in the schema.
 */
import type { CatalogIndex } from '../catalogPresentation';
import { CONDITION_KINDS } from '../condition';
import { array, boolean, enumOf, integer, nullable, object, ref, string, url, dateTime, localized as localizedSchema, type JsonSchema } from './schema';
import type { PublicUrls } from './urls';

// ------------------------------------------------------------ primitives

export interface Localized {
  ar: string;
  en: string;
  ckb: string;
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export function localized(ar: unknown, en: unknown, ckb: unknown): Localized {
  return { ar: text(ar), en: text(en), ckb: text(ckb) };
}

export const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

export const int = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.round(n);
};

/** An ISO timestamp as the database stored it, or null. */
export function isoOrNull(v: unknown): string | null {
  const s = text(v);
  if (!s) return null;
  const t = Date.parse(s.includes('T') || s.includes('Z') ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// ------------------------------------------------------------ pictures

export interface PublicImage {
  url: string;
  width: number | null;
  height: number | null;
  alt: Localized;
}

export const IMAGE_SCHEMA = object(
  {
    url: url('The original file — the highest quality the site stores (WebP). Download it directly.'),
    width: nullable(integer('Pixel width, when known.')),
    height: nullable(integer('Pixel height, when known.')),
    alt: localizedSchema('Alternative text.'),
  },
  'A public picture.'
);

/** A stored media item (product gallery, `MediaV2`) → a public picture, or null when it is not public. */
export function imageFromMedia(m: unknown, urls: PublicUrls): PublicImage | null {
  if (!m || typeof m !== 'object') return null;
  const r = m as Record<string, unknown>;
  const href = urls.media(r.url);
  if (!href) return null;
  return {
    url: href,
    width: int(r.width),
    height: int(r.height),
    alt: localized(r.alt_ar, r.alt_en, r.alt_ckb),
  };
}

export function imageFromUrl(value: unknown, urls: PublicUrls, alt: Localized = localized('', '', '')): PublicImage | null {
  const href = urls.media(value);
  return href ? { url: href, width: null, height: null, alt } : null;
}

// ------------------------------------------------------------ references

export interface SectionRef {
  slug: string;
  name: Localized;
  path: string;
  url: string;
  api_url: string;
}

export const SECTION_REF_SCHEMA = object(
  {
    slug: string('The section\'s identifier in this API and on the site.'),
    name: localizedSchema(),
    path: string('The section\'s page path on the site, e.g. /categories/printers/fdm-printers.'),
    url: url('The section\'s page on the website.'),
    api_url: url('This section in the public API.'),
  },
  'A section (category) of the catalogue.'
);

export function sectionRef(idx: CatalogIndex | null, id: unknown, urls: PublicUrls): SectionRef | null {
  if (!idx || typeof id !== 'string' || !id) return null;
  const r = idx.byId.get(id);
  if (!r || !r.active) return null;
  const path = idx.path(r.id);
  return {
    slug: r.slug,
    name: localized(r.name_ar, r.name_en, r.name_ckb),
    path,
    url: urls.web(path),
    api_url: urls.api(`/sections/${encodeURIComponent(r.slug)}`),
  };
}

export interface BrandInfo {
  id: string;
  slug: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
}

export interface BrandRef {
  slug: string;
  name: Localized;
  url: string;
  api_url: string;
}

export const BRAND_REF_SCHEMA = object(
  {
    slug: string('The brand\'s identifier in this API and on the site.'),
    name: localizedSchema(),
    url: url('The brand\'s products on the website.'),
    api_url: url('This brand in the public API.'),
  },
  'A brand.'
);

export function brandRef(b: BrandInfo | null | undefined, urls: PublicUrls): BrandRef | null {
  if (!b || !b.slug) return null;
  return {
    slug: b.slug,
    name: localized(b.name_ar, b.name_en, b.name_ckb),
    url: urls.web(`/products?brand=${encodeURIComponent(b.slug)}`),
    api_url: urls.api(`/brands/${encodeURIComponent(b.slug)}`),
  };
}

/** The active brands among `ids`, by id — one read. */
export async function brandsById(db: D1Database, ids: Iterable<unknown>): Promise<Map<string, BrandInfo>> {
  const list = [...new Set([...ids].filter((v): v is string => typeof v === 'string' && v !== ''))];
  if (list.length === 0) return new Map();
  const { results } = await db
    .prepare(
      'SELECT id, slug, name_ar, name_en, name_ckb FROM brands WHERE active = 1 AND id IN (SELECT value FROM json_each(?))'
    )
    .bind(JSON.stringify(list))
    .all<BrandInfo>();
  return new Map((results ?? []).map((b) => [b.id, b]));
}

// ------------------------------------------------------------ prices

export interface PublicPrice {
  currency: 'IQD';
  amount: number | null;
  regular: number | null;
  from: boolean;
  member_price: { tier: 'PRO'; amount: number } | null;
}

export const PRICE_SCHEMA = object(
  {
    currency: enumOf(['IQD'], 'Iraqi dinar. Every amount is a whole number of dinars.'),
    amount: nullable(
      integer(
        'What a signed-out customer pays for one unit today, offers applied; the lowest option\'s price when `from` is true. Null when the price is shown only to members.'
      )
    ),
    regular: nullable(integer('The regular price the amount is compared with (equal to `amount` when nothing is discounted).')),
    from: boolean('True when options or colours cost more than `amount` — the site shows «from».'),
    member_price: nullable(
      object(
        {
          tier: enumOf(['PRO'], 'The membership the price is for.'),
          amount: integer('The member price, as the site advertises it to visitors.'),
        },
        'The price a PRO member would pay, when the site advertises one.'
      )
    ),
  },
  'A price as the site shows it to a signed-out visitor. Delivery is not included.'
);

export function priceFromCard(card: Record<string, unknown>, locked = false): PublicPrice {
  if (locked) return { currency: 'IQD', amount: null, regular: null, from: false, member_price: null };
  const amount = int(card.display_price_iqd) ?? int(card.price_iqd);
  const regular = int(card.display_regular_iqd) ?? amount;
  const pro = int(card.display_pro_iqd);
  return {
    currency: 'IQD',
    amount,
    regular,
    from: card.display_from === true,
    member_price: pro !== null && amount !== null && pro < amount ? { tier: 'PRO', amount: pro } : null,
  };
}

// ------------------------------------------------------------ availability

export type AvailabilityState = 'available' | 'preorder' | 'unavailable' | 'unknown';

export interface PublicAvailability {
  state: AvailabilityState;
  quantity: number | null;
  low_stock: boolean;
  sale_modes: string[];
}

export const AVAILABILITY_SCHEMA = object(
  {
    state: enumOf(
      ['available', 'preorder', 'unavailable', 'unknown'],
      'available = can be bought now from stock; preorder = can be ordered for import; unavailable = neither right now; unknown = the site does not say.'
    ),
    quantity: nullable(
      integer('Units the site shows as available now, capped at 99 (the site shows «99+» above that). Null when it shows no number.', {
        minimum: 0,
      })
    ),
    low_stock: boolean('True when the site warns that only a few are left.'),
    sale_modes: array(enumOf(['direct_sale', 'pre_order', 'bundle']), 'The ways this item is sold.'),
  },
  'Availability as the site shows it to a visitor.'
);

/** The card's own rule (src/lib/productCard.ts `cardAvailability`), low-stock at 2. */
export function availabilityFromCard(card: Record<string, unknown>): PublicAvailability {
  const saleModes = Array.isArray(card.sale_types)
    ? (card.sale_types as unknown[]).filter((t): t is string => t === 'direct_sale' || t === 'pre_order' || t === 'bundle')
    : [];
  const n = card.direct_stock_available;
  if (typeof n === 'number' && Number.isInteger(n) && n > 0) {
    return { state: 'available', quantity: Math.min(n, 99), low_stock: n <= 2, sale_modes: saleModes };
  }
  if (Array.isArray(card.sale_types)) {
    return { state: saleModes.includes('pre_order') ? 'preorder' : 'unavailable', quantity: null, low_stock: false, sale_modes: saleModes };
  }
  return { state: 'unknown', quantity: null, low_stock: false, sale_modes: saleModes };
}

/**
 * A bundle's or mystery box's one availability verdict (bundleComposition.ts
 * `CompositionState`) in the same four words. A members-only box is
 * `unavailable` to a visitor — the site will not sell it to them.
 */
export function availabilityFromComposition(state: unknown): PublicAvailability {
  const s = typeof state === 'string' ? state : '';
  if (s === 'in_stock' || s === 'low' || s === 'ending_soon') {
    return { state: 'available', quantity: null, low_stock: s === 'low', sale_modes: ['bundle'] };
  }
  if (s === 'preorder') return { state: 'preorder', quantity: null, low_stock: false, sale_modes: ['bundle'] };
  if (s === '') return { state: 'unknown', quantity: null, low_stock: false, sale_modes: ['bundle'] };
  return { state: 'unavailable', quantity: null, low_stock: false, sale_modes: ['bundle'] };
}

// ------------------------------------------------------------ offers

export interface PublicOffer {
  starts_at: string | null;
  ends_at: string | null;
  members_only: boolean;
}

export const OFFER_SCHEMA = object(
  {
    starts_at: nullable(dateTime('When the offer began.')),
    ends_at: nullable(dateTime('When the offer ends — the site counts down to it.')),
    members_only: boolean('True when only members get the offer price; a visitor sees the regular price.'),
  },
  'A time-limited offer running now.'
);

/**
 * A LIVE offer that actually applies — priced for a visitor, or shown to them
 * as members-only. A window the admin switched off, or one not yet started or
 * already over, is not an offer a visitor can take, so it is not published.
 */
export function offerFromCard(card: Record<string, unknown>): PublicOffer | null {
  const o = card.offer;
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  if (r.schedule_state !== 'live') return null;
  const locked = r.locked === true;
  if (r.price_source !== 'offer' && !locked) return null;
  return { starts_at: isoOrNull(r.starts_at), ends_at: isoOrNull(r.ends_at), members_only: locked };
}

// ------------------------------------------------------------ product cards

export interface CardContext {
  urls: PublicUrls;
  idx: CatalogIndex | null;
  brands: Map<string, BrandInfo>;
}

export const PRODUCT_CARD_SCHEMA = object(
  {
    slug: string('The product\'s identifier in this API and on the site.'),
    kind: enumOf(['product', 'bundle', 'mystery'], 'A single product, a bundle of products, or a mystery box.'),
    name: localizedSchema(),
    condition: nullable(enumOf([...CONDITION_KINDS], 'Set when the item is not new.')),
    url: url('The product\'s page on the website.'),
    api_url: url('The full product in this API.'),
    image: nullable(ref('Image')),
    light_image: nullable(url('A version of the main picture made for the light theme, when there is one.')),
    brand: nullable(ref('BrandRef')),
    section: nullable(ref('SectionRef')),
    price: ref('Price'),
    availability: ref('Availability'),
    offer: nullable(ref('Offer')),
  },
  'A product as it appears in a list.'
);

function kindOf(v: unknown): 'product' | 'bundle' | 'mystery' {
  return v === 'bundle' ? 'bundle' : v === 'mystery' ? 'mystery' : 'product';
}

function conditionOf(v: unknown): string | null {
  if (!v || typeof v !== 'object') return null;
  const kind = (v as Record<string, unknown>).kind;
  return typeof kind === 'string' && (CONDITION_KINDS as readonly string[]).includes(kind) ? kind : null;
}

/** The first public picture of a card: its primary media, else its first image. */
export function cardImage(card: Record<string, unknown>, urls: PublicUrls): PublicImage | null {
  const media = Array.isArray(card.media) ? (card.media as unknown[]) : [];
  const ordered = [...media.filter((m) => (m as Record<string, unknown>)?.primary), ...media];
  for (const m of ordered) {
    const img = imageFromMedia(m, urls);
    if (img) return img;
  }
  const images = Array.isArray(card.images) ? (card.images as unknown[]) : typeof card.image === 'string' ? [card.image] : [];
  for (const u of images) {
    const img = imageFromUrl(u, urls);
    if (img) return img;
  }
  return null;
}

/**
 * A storefront card (`resolveProductCards` / `compositionCard`) and its row →
 * a public card. Names come from the ROW, where all three languages live; the
 * price, the picture and the availability from the CARD, which is what the
 * site itself drew for a visitor.
 */
export function productCardDto(card: Record<string, unknown>, row: Record<string, unknown> | undefined, cx: CardContext) {
  const slug = text(card.slug ?? card.product_slug ?? row?.slug);
  const kind = kindOf(row?.composition ?? (card.composition as Record<string, unknown> | undefined)?.kind);
  const composition = kind !== 'product';
  const locked = card.locked === true;
  const name = row
    ? localized(row.name_ar, row.name, row.name_ku)
    : localized(card.name_ar, card.name, card.name_ku);
  const sectionId = (row?.sub_category_id ?? card.sub_category_id) || (row?.category_id ?? card.category_id);
  return {
    slug,
    kind,
    name,
    condition: conditionOf(card.condition),
    url: cx.urls.web(composition ? `/bundles/${encodeURIComponent(slug)}` : `/product/${encodeURIComponent(slug)}`),
    api_url: cx.urls.api(composition ? `/bundles/${encodeURIComponent(slug)}` : `/products/${encodeURIComponent(slug)}`),
    image: cardImage(card, cx.urls),
    light_image: cx.urls.media(card.light_image),
    brand: brandRef(cx.brands.get(String(row?.brand_id ?? card.brand_id ?? '')), cx.urls),
    section: sectionRef(cx.idx, sectionId, cx.urls),
    price: priceFromCard(card, locked),
    availability: composition ? availabilityFromComposition(card.availability_state) : availabilityFromCard(card),
    offer: offerFromCard(card),
  };
}

/** Every component schema the shared pieces define, for openapi.json. */
export const COMMON_COMPONENTS: Record<string, JsonSchema> = {
  Localized: localizedSchema(),
  Image: IMAGE_SCHEMA,
  SectionRef: SECTION_REF_SCHEMA,
  BrandRef: BRAND_REF_SCHEMA,
  Price: PRICE_SCHEMA,
  Availability: AVAILABILITY_SCHEMA,
  Offer: OFFER_SCHEMA,
  ProductCard: PRODUCT_CARD_SCHEMA,
};
