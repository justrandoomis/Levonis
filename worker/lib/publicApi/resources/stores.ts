/**
 * STORES — the merchant shops of Levo Community, as a signed-out visitor sees
 * them on each shop's own address (`<slug>.levonis-iq.com`).
 *
 * A shop with its own address is OUTSIDE the community's maintenance wall
 * (worker/lib/communityGate.ts, «A shop with its own address is not the
 * directory»): a visitor who has the address sees the shop whether or not the
 * community is open, so these endpoints answer either way. FINDING shops — the
 * directory — is inside the wall, and so is /community/stores here.
 *
 * Everything is read through the storefront's own functions
 * (worker/routes/storefront.ts): `servableStoreBySlug` — which never serves a
 * sanctioned shop — `publicStore`, `storeStats`, `storeCollections`,
 * `storeServices`, `storeShowcase`, `publishedStoreProduct`,
 * `storeReviewSummary`, and `publicProductExtras` (worker/lib/catalog/
 * public.ts); then rebuilt here field by field. What the storefront withholds
 * stays withheld (a stock count, an exact sales count, an unpublished phone),
 * and the API withholds a little more:
 *
 *   - no internal id of any kind: shops and products are named by slug,
 *     variants by the option values they combine, reviews not at all;
 *   - no contact phone, even a published one — the shop's page shows it to a
 *     person; the API is not a phone directory;
 *   - no pickup note (it can be a street address), only the governorate;
 *   - reviewers masked exactly as on the site («Ahmed K.»), their photos
 *     counted but not linked: a review photo's storage key embeds the
 *     reviewer's account id.
 *
 * MERCHANT PICTURES are published only as files the site itself serves to
 * anyone (`/files/merchants/<owner>/public/…`), never an external address a
 * merchant typed. That storage key names the owning account, exactly as on
 * the shop's own pages: the URL is the site's, and the API does not rename it.
 */
import { rootDomainFrom, storeUrl } from '../../hosts';
import type { StoreContext } from '../../merchantAuth';
import { publicProductExtras } from '../../catalog/public';
import { IRAQ_GOVERNORATES, normalizeGovernorate } from '../../iraqGovernorates';
import { TECHNOLOGIES, FINISHES } from '@levonis/catalog/attributes';
import { SWATCHES } from '@levonis/catalog/palette';
import { maskName } from '../../../routes/reviews';
import {
  publicProduct,
  publicStore,
  publishedStoreProduct,
  servableStoreBySlug,
  storeCollections,
  storeReviewSummary,
  storeServices,
  storeShowcase,
  storeStats,
} from '../../../routes/storefront';
import { notFound } from '../../http';
import { int, isoOrNull, localized, num, type Localized, type PublicImage } from '../common';
import { decodeCursor, pageFromSource, parseLimit } from '../paging';
import {
  array,
  boolean,
  dateTime,
  enumOf,
  integer,
  localized as localizedSchema,
  nullable,
  number,
  object,
  ref,
  string,
  url,
  type JsonSchema,
} from '../schema';
import type { PublicRequest, PublicResult, PublicRoute } from '../types';
import type { PublicUrls } from '../urls';

type Rec = Record<string, unknown>;

const text = (v: unknown, max = 4000): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** A merchant-typed list of short strings (categories, service areas, materials). */
function stringList(v: unknown, max = 40): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => text(x, 120)).filter(Boolean).slice(0, max);
}

/** Parse a JSON column the way the storefront does, without trusting its shape. */
function parsed(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** A merchant's picture: only a file the site serves to anyone — never an external address a merchant typed. */
export function merchantFile(urls: PublicUrls, value: unknown): string | null {
  return typeof value === 'string' && value.trim().startsWith('/files/') ? urls.media(value.trim()) : null;
}

const keyFile = (urls: PublicUrls, key: unknown) =>
  typeof key === 'string' && key ? merchantFile(urls, `/files/${key}`) : null;

const picture = (href: string | null, alt: Localized = localized('', '', '')): PublicImage | null =>
  href ? { url: href, width: null, height: null, alt } : null;

// ------------------------------------------------------------ governorates

export interface PublicGovernorate {
  code: string;
  name: Localized;
}

export const GOVERNORATE_SCHEMA = object(
  {
    code: string('The governorate\'s code in the site\'s fixed list of Iraq\'s governorates, e.g. baghdad.'),
    name: localizedSchema(),
  },
  'An Iraqi governorate.'
);

const GOVERNORATE_BY_ID = new Map(IRAQ_GOVERNORATES.map((g) => [g.id, g]));

export function governorate(raw: unknown): PublicGovernorate | null {
  const id = normalizeGovernorate(raw);
  const g = id ? GOVERNORATE_BY_ID.get(id) : undefined;
  return g ? { code: g.id, name: localized(g.ar, g.en, g.ckb) } : null;
}

// ------------------------------------------------------------ store references

/** The shop's own site: its subdomain, or — without a configured root domain — its page on the main site. */
export function storeSite(urls: PublicUrls, root: string | null, slug: string): string {
  const sub = storeUrl(slug, root, '');
  return sub.startsWith('https://') ? sub : urls.web(`/community/store/${encodeURIComponent(slug)}`);
}

/** A product's page on its shop's site. */
export function storeProductSite(urls: PublicUrls, root: string | null, storeSlug: string, productSlug: string): string {
  const sub = storeUrl(storeSlug, root, '');
  return sub.startsWith('https://')
    ? `${sub}/p/${encodeURIComponent(productSlug)}`
    : urls.web(`/community/store/${encodeURIComponent(storeSlug)}/p/${encodeURIComponent(productSlug)}`);
}

export interface StoreRef {
  slug: string;
  name: string;
  logo: PublicImage | null;
  url: string;
  api_url: string;
}

export const STORE_REF_SCHEMA = object(
  {
    slug: string('The shop\'s identifier in this API — also its web address, <slug>.levonis-iq.com.'),
    name: string('The shop\'s name, as its merchant wrote it.'),
    logo: nullable(ref('Image')),
    url: url('The shop\'s own site.'),
    api_url: url('This shop in the public API.'),
  },
  'A merchant shop of Levo Community.'
);

export function storeRef(urls: PublicUrls, root: string | null, slug: string, name: unknown, logoKey: unknown): StoreRef {
  return {
    slug,
    name: text(name, 200),
    logo: picture(keyFile(urls, logoKey)),
    url: storeSite(urls, root, slug),
    api_url: urls.api(`/stores/${encodeURIComponent(slug)}`),
  };
}

// ------------------------------------------------------------ products

export interface StoreProductCard {
  slug: string;
  name: Localized;
  images: PublicImage[];
  price_iqd: number;
  original_price_iqd: number | null;
  on_sale: boolean;
  category: string;
  condition: string;
  in_stock: boolean;
  sales_tier: number | null;
  featured: boolean;
  url: string;
  api_url: string;
}

export const STORE_PRODUCT_CARD_SCHEMA = object(
  {
    slug: string('The product\'s identifier in this API and on its shop\'s site.'),
    name: localizedSchema('Written by the merchant; Kurdish is never provided for shop products.'),
    images: array(ref('Image'), 'The product\'s pictures, originals, in the merchant\'s order.'),
    price_iqd: integer('The price on the shop\'s page, in IQD. Delivery is not included.'),
    original_price_iqd: nullable(integer('The crossed-out price, when the shop shows one.')),
    on_sale: boolean('True when `original_price_iqd` is above the price.'),
    category: string('The shop\'s own category label (free text; may be empty).'),
    condition: string('new, used, … as the shop states it.'),
    in_stock: boolean('Whether the shop can sell it now. Stock levels are never published.'),
    sales_tier: nullable(integer('A sales milestone the page shows («+50 sold») — rounded down, never the exact count.')),
    featured: boolean('Pinned by the merchant.'),
    url: url('The product\'s page on its shop\'s site.'),
    api_url: url('This product in the public API.'),
  },
  'A product a merchant shop publishes.'
);

/** The storefront's own public product (`publicProduct`), re-picked. */
export function storeProductCard(p: Rec, store: { slug: string; root: string | null }, urls: PublicUrls): StoreProductCard {
  const pub = publicProduct(p);
  const slug = String(pub.slug ?? '');
  const price = Math.max(0, int(pub.price_iqd) ?? 0);
  const original = int(pub.original_price_iqd);
  const images = (Array.isArray(pub.images) ? (pub.images as unknown[]) : [])
    .map((v) => picture(merchantFile(urls, v)))
    .filter((x): x is PublicImage => !!x);
  return {
    slug,
    name: localized(pub.name_ar, pub.name, ''),
    images,
    price_iqd: price,
    original_price_iqd: original !== null && original > 0 ? original : null,
    on_sale: original !== null && original > price,
    category: text(pub.category, 120),
    condition: text(pub.condition, 40) || 'new',
    in_stock: !!pub.in_stock,
    sales_tier: int(pub.sales_tier),
    featured: !!pub.featured,
    url: storeProductSite(urls, store.root, store.slug, slug),
    api_url: urls.api(`/stores/${encodeURIComponent(store.slug)}/products/${encodeURIComponent(slug)}`),
  };
}

const OPTION_SCHEMA = object(
  {
    name: localizedSchema(),
    kind: enumOf(['color', 'choice']),
    values: array(
      object({
        name: localizedSchema(),
        swatch: string('A colour swatch name for colour options (e.g. black), else empty.'),
      })
    ),
  },
  'An option the customer chooses (size, colour, …), with only the values some variant uses.'
);

const VARIANT_SCHEMA = object(
  {
    choices: array(
      object({
        option: string('The option\'s name (as the merchant wrote it).'),
        value: string('The chosen value\'s name.'),
      }),
      'One value per option, in the options\' order.'
    ),
    price_iqd: integer('This combination\'s price.'),
    compare_at_iqd: nullable(integer('Its crossed-out price, if any.')),
    in_stock: boolean(),
    image: nullable(ref('Image')),
  },
  'One combination of option values the shop sells.'
);

const MEDIA_SCHEMA = object(
  {
    kind: enumOf(['image', 'video']),
    url: url('The original file. Download it directly.'),
    alt: localizedSchema(),
  },
  'A picture or video of the product.'
);

const ATTRIBUTES_SCHEMA = object(
  {
    material: nullable(string('Print material code from the site\'s material list (e.g. pla).')),
    technology: nullable(enumOf([...TECHNOLOGIES])),
    color: nullable(enumOf([...SWATCHES])),
    finish: nullable(enumOf([...FINISHES])),
    dimensions_mm: nullable(
      object({ x: nullable(number()), y: nullable(number()), z: nullable(number()) }, 'Width, depth, height in millimetres.')
    ),
    weight_g: nullable(integer()),
  },
  'What a 3D-printed product is made of, and how — each null when the merchant did not say.'
);

const STORE_PRODUCT_SCHEMA = object(
  {
    ...(STORE_PRODUCT_CARD_SCHEMA.properties as Record<string, JsonSchema>),
    description: localizedSchema(),
    options: array(ref('StoreProductOption')),
    variants: array(ref('StoreProductVariant'), 'Empty when the product is sold as one item.'),
    media: array(ref('StoreProductMedia'), 'Pictures and videos, originals, in order.'),
    attributes: ref('PrintAttributes'),
    delivery_methods: array(string(), 'How the shop hands it over, as the merchant labels it.'),
    prep_days: integer('Days the shop needs before it ships.'),
    store: ref('StoreRef'),
  },
  'A shop product with everything its page shows a visitor.'
);

async function storeProduct(req: PublicRequest): Promise<PublicResult> {
  const { db, urls } = req;
  const root = rootDomainFrom(req.c.env);
  const ctx = await servableStoreBySlug(db, req.path.slug);
  const p = await publishedStoreProduct(db, ctx.store.id, req.path.product);
  if (!p) throw notFound('Product not found');
  const extras = await publicProductExtras(db, p);
  const card = storeProductCard(p, { slug: ctx.store.slug, root }, urls);

  const valueName = new Map<string, { option: string; value: string }>();
  const options = extras.option_groups.map((g) => {
    for (const v of g.values) valueName.set(v.id, { option: g.name, value: v.name });
    return {
      name: localized(g.name_ar, g.name, ''),
      kind: g.kind === 'color' ? ('color' as const) : ('choice' as const),
      values: g.values.map((v) => ({ name: localized(v.name_ar, v.name, ''), swatch: text(v.swatch, 40) })),
    };
  });
  const variants = extras.variants.map((v) => ({
    choices: v.value_ids.map((id) => valueName.get(id)).filter((x): x is { option: string; value: string } => !!x),
    price_iqd: Math.max(0, int(v.price_iqd) ?? 0),
    compare_at_iqd: int(v.compare_at_iqd),
    in_stock: !!v.in_stock,
    image: picture(merchantFile(urls, v.image)),
  }));
  const media = extras.media.length
    ? extras.media
        .map((m) => {
          const href = merchantFile(urls, m.url);
          return href ? { kind: m.kind, url: href, alt: localized(m.alt_ar, m.alt, '') } : null;
        })
        .filter((x): x is { kind: 'image' | 'video'; url: string; alt: Localized } => !!x)
    : card.images.map((i) => ({ kind: 'image' as const, url: i.url, alt: i.alt }));
  const a = extras.attributes;
  const dims = a.dim_x_mm !== null || a.dim_y_mm !== null || a.dim_z_mm !== null
    ? { x: num(a.dim_x_mm), y: num(a.dim_y_mm), z: num(a.dim_z_mm) }
    : null;
  const pub = publicProduct(p);
  return {
    data: {
      ...card,
      description: localized(pub.description_ar, pub.description, ''),
      options,
      variants,
      media,
      attributes: {
        material: a.material ? text(a.material, 40) : null,
        technology: a.technology && (TECHNOLOGIES as readonly string[]).includes(a.technology) ? a.technology : null,
        color: a.color && (SWATCHES as readonly string[]).includes(a.color) ? a.color : null,
        finish: a.finish && (FINISHES as readonly string[]).includes(a.finish) ? a.finish : null,
        dimensions_mm: dims,
        weight_g: int(a.weight_g),
      },
      delivery_methods: stringList(pub.delivery_methods, 10),
      prep_days: Math.max(0, int(pub.prep_days) ?? 0),
      store: storeRef(urls, root, ctx.store.slug, ctx.store.name, ctx.store.logo_key),
    },
    web: card.url,
  };
}

async function storeProducts(req: PublicRequest): Promise<PublicResult> {
  const { db, urls, query } = req;
  const root = rootDomainFrom(req.c.env);
  const ctx = await servableStoreBySlug(db, req.path.slug);
  const limit = parseLimit(query.limit);
  const offset = decodeCursor(query.cursor);
  // The storefront's own listing rule — published only (`lifecycle` and
  // `status` both active, the predicate of GET /api/storefront/:slug/products),
  // newest first — paged by position instead of by (created_at, id), so no
  // cursor ever carries a product's internal id.
  const where = `store_id = ?1 AND lifecycle = 'active' AND status = 'active'
        AND (?2 = '' OR category = ?2)
        AND (?3 = 0 OR (original_price_iqd IS NOT NULL AND original_price_iqd > price_iqd))
        AND (?4 = 0 OR featured = 1)`;
  const binds = [ctx.store.id, query.category ?? '', query.deals === '1' ? 1 : 0, query.featured === '1' ? 1 : 0];
  const [rows, total] = await Promise.all([
    db
      .prepare(`SELECT * FROM community_products WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?5 OFFSET ?6`)
      .bind(...binds, limit, offset)
      .all<Rec>(),
    db.prepare(`SELECT COUNT(*) AS n FROM community_products WHERE ${where}`).bind(...binds).first<{ n: number }>(),
  ]);
  const items = (rows.results ?? []).map((p) => storeProductCard(p, { slug: ctx.store.slug, root }, urls));
  return {
    data: items,
    pagination: pageFromSource(limit, offset, items.length, Number(total?.n ?? 0)),
    web: storeSite(urls, root, ctx.store.slug),
  };
}

// ------------------------------------------------------------ the store

const STORE_SCHEMA = object(
  {
    slug: string('The shop\'s identifier in this API — also its web address.'),
    name: string(),
    tagline: string(),
    description: string(),
    logo: nullable(ref('Image')),
    banner: nullable(ref('Image')),
    governorate: nullable(ref('Governorate')),
    categories: array(string(), 'What the shop sells, in its own words.'),
    service_areas: array(string(), 'Where it works, in its own words.'),
    business_hours: array(
      object({
        day: string(),
        open: string('HH:MM, or empty.'),
        close: string('HH:MM, or empty.'),
        closed: boolean('The merchant listed this day as closed (open and close are then empty).'),
      })
    ),
    policies: array(object({ topic: string(), text: string() }), 'The shop\'s own policies (returns, delivery, …).'),
    social_links: array(object({ network: string(), url: url() })),
    links: array(object({ title: string(), url: url() }), 'Links the merchant pinned to the shop\'s header.'),
    facts: array(object({ title: string(), subtitle: string() }), 'Short facts the merchant pinned to the header.'),
    open: boolean('Whether the shop takes orders right now.'),
    sells_products: boolean('Whether it sells ready products (as well as, or instead of, print jobs).'),
    accepts_custom_requests: boolean('Whether it takes custom print jobs.'),
    delivery: object(
      {
        areas: array(
          object({
            governorate: ref('Governorate'),
            fee_iqd: integer(),
            free: boolean(),
            free_over_iqd: nullable(integer('Orders at or above this amount ship free.')),
            prep_days: nullable(integer()),
            eta: string('What the shop says about delivery time there.'),
          })
        ),
        pickup: nullable(object({ governorate: nullable(ref('Governorate')) }, 'The shop offers pickup.')),
        prep_days: nullable(integer()),
        free_over_iqd: nullable(integer()),
        note: string(),
      },
      'Where the shop delivers and what it charges — the checkout prices again from the address.'
    ),
    merchant: object(
      {
        name: string('The merchant\'s public name.'),
        verified: boolean('Verified by Levonis.'),
        pro_badge: boolean('Holds an active PRO membership.'),
        premium_badge: boolean('Holds an active PREMIUM membership.'),
        badge: string('The shop\'s reputation badge (new, trusted, …).'),
        rating: nullable(number('Average review rating, 1–5.')),
        rating_count: integer(),
        completed_orders: integer('Orders it has completed on Levonis.'),
      }
    ),
    stats: object({
      followers: integer(),
      product_count: integer('Published products.'),
      positive_pct: nullable(integer('Share of reviews at 4★ or more; null with no reviews.')),
      deal_count: integer('Products shown with a crossed-out price.'),
    }),
    collections: array(
      object({
        name: localizedSchema(),
        kind: string('manual, featured, new_arrivals or best_sellers.'),
        image: nullable(ref('Image')),
        product_count: integer(),
      }),
      'The shop\'s shelves, as its page shows them (only those holding a published product).'
    ),
    services: array(
      object({
        title: string(),
        description: string(),
        kind: string('print_service, design, finishing, scanning, repair or other.'),
        price_from_iqd: nullable(integer('A starting price; null means «ask for a quote».')),
        price_unit: string(),
        materials: array(string()),
        image: nullable(ref('Image')),
      }),
      'Services the shop advertises.'
    ),
    showcase: array(
      object({
        kind: enumOf(['printer', 'material', 'work']),
        title: string(),
        details: string(),
        image: nullable(ref('Image')),
      }),
      'The workshop on display: its printers, materials and finished work.'
    ),
    created_at: nullable(dateTime()),
    url: url('The shop\'s own site.'),
    products_url: url('Its products in the public API.'),
    reviews_url: url('Its reviews in the public API.'),
  },
  'A merchant shop, as its page shows it to a signed-out visitor.'
);

function hours(v: unknown) {
  if (!Array.isArray(v)) return [];
  const time = (x: unknown) => (typeof x === 'string' && /^\d{1,2}:\d{2}$/.test(x.trim()) ? x.trim() : '');
  return v
    .map((row) => {
      if (typeof row === 'string') return { day: text(row, 60), open: '', close: '', closed: false };
      if (!row || typeof row !== 'object') return null;
      const r = row as Rec;
      // A day the merchant marked «مغلق» travels as closed, with no times.
      if (r.closed === true) return { day: text(r.day, 60), open: '', close: '', closed: true };
      return { day: text(r.day, 60), open: time(r.open), close: time(r.close), closed: false };
    })
    .filter((r): r is { day: string; open: string; close: string; closed: boolean } => !!r && !!r.day)
    .slice(0, 14);
}

const httpUrl = (v: unknown): string | null => {
  const s = text(v, 300);
  return /^https?:\/\/[^\s"'<>]+$/i.test(s) ? s : null;
};

function textMap(v: unknown, max: number): Array<[string, string]> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return [];
  return Object.entries(v as Rec)
    .map(([k, val]) => [text(k, 60), text(val, 2000)] as [string, string])
    .filter(([k, val]) => !!k && !!val)
    .slice(0, max);
}

async function getStore(req: PublicRequest): Promise<PublicResult> {
  const { db, urls } = req;
  const root = rootDomainFrom(req.c.env);
  const ctx: StoreContext = await servableStoreBySlug(db, req.path.slug);
  const [profile, stats, collections, services, showcase] = await Promise.all([
    publicStore(db, ctx, root),
    storeStats(db, ctx),
    storeCollections(db, ctx.store.id),
    storeServices(db, ctx.store.id),
    storeShowcase(db, ctx.store.id),
  ]);
  const slug = ctx.store.slug;
  const site = storeSite(urls, root, slug);
  const links = (Array.isArray(profile.profile_links) ? (profile.profile_links as unknown[]) : [])
    .map((w) => {
      const r = (w && typeof w === 'object' ? w : {}) as Rec;
      const href = httpUrl(r.url);
      return href && text(r.title, 30) ? { title: text(r.title, 30), url: href } : null;
    })
    .filter((x): x is { title: string; url: string } => !!x);
  const facts = (Array.isArray(profile.profile_facts) ? (profile.profile_facts as unknown[]) : [])
    .map((w) => {
      const r = (w && typeof w === 'object' ? w : {}) as Rec;
      return text(r.title, 30) ? { title: text(r.title, 30), subtitle: text(r.subtitle, 40) } : null;
    })
    .filter((x): x is { title: string; subtitle: string } => !!x);
  const d = profile.delivery;
  const areas = d.areas
    .map((g) => {
      const gov = governorate(g.governorate);
      return gov
        ? {
            governorate: gov,
            fee_iqd: Math.max(0, int(g.fee_iqd) ?? 0),
            free: !!g.free,
            free_over_iqd: int(g.free_over_iqd),
            prep_days: int(g.prep_days),
            eta: text(g.eta_note, 80),
          }
        : null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
  const m = profile.merchant;
  return {
    data: {
      slug,
      name: text(profile.name, 200),
      tagline: text(profile.tagline, 300),
      description: text(profile.description),
      logo: picture(merchantFile(urls, profile.logoUrl)),
      banner: picture(merchantFile(urls, profile.bannerUrl)),
      governorate: governorate(profile.governorate),
      categories: stringList(profile.categories),
      service_areas: stringList(profile.service_areas),
      business_hours: hours(profile.business_hours),
      policies: textMap(profile.policies, 12).map(([topic, body]) => ({ topic, text: body })),
      social_links: textMap(profile.social_links, 10)
        .map(([network, href]) => ({ network, url: httpUrl(href) }))
        .filter((x): x is { network: string; url: string } => !!x.url),
      links,
      facts,
      open: !!profile.open,
      sells_products: !!profile.sells_direct_products,
      accepts_custom_requests: !!profile.accepts_custom_requests,
      delivery: {
        areas,
        pickup: d.pickup ? { governorate: governorate(d.pickup.governorate) } : null,
        prep_days: int(d.prep_days),
        free_over_iqd: int(d.free_over_iqd),
        note: text(d.note, 200),
      },
      merchant: {
        name: text(m.name, 200),
        verified: !!m.verified,
        pro_badge: !!m.pro_badge,
        premium_badge: !!m.premium_badge,
        badge: text(m.badge, 40) || 'new',
        rating: num(m.rating),
        rating_count: int(m.rating_count) ?? 0,
        completed_orders: int(m.completed_orders) ?? 0,
      },
      stats: {
        followers: int(stats.followers) ?? 0,
        product_count: int(stats.product_count) ?? 0,
        positive_pct: int(stats.positive_pct),
        deal_count: int(stats.deal_count) ?? 0,
      },
      collections: collections.map((s) => ({
        name: localized(s.name_ar, s.name, ''),
        kind: text(s.kind, 30) || 'manual',
        image: picture(keyFile(urls, s.image_key)),
        product_count: int(s.product_count) ?? 0,
      })),
      services: services.map((s) => ({
        title: text(s.title, 200),
        description: text(s.description),
        kind: text(s.kind, 40),
        price_from_iqd: int(s.price_from_iqd),
        price_unit: text(s.price_unit, 60),
        materials: stringList(parsed(s.materials), 20),
        image: picture(keyFile(urls, s.image_key)),
      })),
      showcase: showcase
        .filter((s) => s.kind === 'printer' || s.kind === 'material' || s.kind === 'work')
        .map((s) => ({
          kind: s.kind as 'printer' | 'material' | 'work',
          title: text(s.title, 200),
          details: text(s.details),
          image: picture(keyFile(urls, s.image_key)),
        })),
      created_at: isoOrNull(profile.created_at),
      url: site,
      products_url: urls.api(`/stores/${encodeURIComponent(slug)}/products`),
      reviews_url: urls.api(`/stores/${encodeURIComponent(slug)}/reviews`),
    },
    web: site,
  };
}

// ------------------------------------------------------------ reviews

const STORE_REVIEWS_SCHEMA = object(
  {
    store: ref('StoreRef'),
    average: nullable(number('Average rating, 1–5; null with no reviews.')),
    count: integer('Visible reviews in all.'),
    distribution: object(
      { '1': integer(), '2': integer(), '3': integer(), '4': integer(), '5': integer() },
      'How many reviews gave each rating.'
    ),
    reviews: array(
      object({
        rating: integer('1–5.'),
        text: string(),
        reviewer: string('Masked as the site shows it: first name and an initial.'),
        verified_purchase: boolean('Every shop review comes from a completed order.'),
        photo_count: integer('Photos attached. They are not linked: their addresses identify the reviewer\'s account.'),
        merchant_reply: nullable(string()),
        merchant_replied_at: nullable(dateTime()),
        created_at: nullable(dateTime()),
      })
    ),
  },
  'A shop\'s reviews, newest first.'
);

async function storeReviews(req: PublicRequest): Promise<PublicResult> {
  const { db, urls, query } = req;
  const root = rootDomainFrom(req.c.env);
  const ctx = await servableStoreBySlug(db, req.path.slug);
  const limit = parseLimit(query.limit, 20);
  const offset = decodeCursor(query.cursor);
  const merchantId = String(ctx.merchant.id);
  // The storefront's own rule (GET /api/storefront/:slug/reviews): this
  // merchant's reviews that moderation has not hidden, newest first.
  const [summary, list] = await Promise.all([
    storeReviewSummary(db, merchantId),
    db
      .prepare(
        `SELECT r.rating, r.body, r.images, r.merchant_reply, r.merchant_replied_at, r.created_at,
                u.name AS customer_name, u.username AS customer_username
           FROM merchant_reviews r JOIN users u ON u.id = r.customer_id
          WHERE r.merchant_id = ?1 AND r.hidden = 0
          ORDER BY r.created_at DESC, r.id DESC LIMIT ?2 OFFSET ?3`
      )
      .bind(merchantId, limit, offset)
      .all<Rec>(),
  ]);
  const reviews = (list.results ?? []).map((r) => {
    const photos = parsed(r.images);
    return {
      rating: Math.min(5, Math.max(1, int(r.rating) ?? 5)),
      text: text(r.body),
      reviewer: maskName(r.customer_name as string | null, r.customer_username as string | null),
      verified_purchase: true,
      photo_count: Array.isArray(photos) ? photos.length : 0,
      merchant_reply: text(r.merchant_reply) || null,
      merchant_replied_at: isoOrNull(r.merchant_replied_at),
      created_at: isoOrNull(r.created_at),
    };
  });
  const dist = summary.distribution;
  return {
    data: {
      store: storeRef(urls, root, ctx.store.slug, ctx.store.name, ctx.store.logo_key),
      average: summary.average,
      count: summary.count,
      distribution: { '1': dist['1'] ?? 0, '2': dist['2'] ?? 0, '3': dist['3'] ?? 0, '4': dist['4'] ?? 0, '5': dist['5'] ?? 0 },
      reviews,
    },
    pagination: pageFromSource(limit, offset, reviews.length, summary.count),
    web: storeSite(urls, root, ctx.store.slug),
  };
}

// ------------------------------------------------------------ routes

const STORE_SLUG = {
  name: 'slug',
  in: 'path' as const,
  required: true,
  description: 'The shop\'s slug — the first label of its address, <slug>.levonis-iq.com.',
  schema: { type: 'string', maxLength: 64 },
  example: 'ali3d',
};

export const LIMIT_PARAM = {
  name: 'limit',
  in: 'query' as const,
  description: 'Items per page, 1–50 (default 24). Larger values are clamped.',
  schema: { type: 'integer', minimum: 1 },
};

export const CURSOR_PARAM = {
  name: 'cursor',
  in: 'query' as const,
  description: 'The `meta.pagination.next_cursor` of the previous page.',
  schema: { type: 'string', maxLength: 200 },
};

export const STORE_COMPONENTS: Record<string, JsonSchema> = {
  Governorate: GOVERNORATE_SCHEMA,
  StoreRef: STORE_REF_SCHEMA,
  Store: STORE_SCHEMA,
  StoreProductCard: STORE_PRODUCT_CARD_SCHEMA,
  StoreProduct: STORE_PRODUCT_SCHEMA,
  StoreProductOption: OPTION_SCHEMA,
  StoreProductVariant: VARIANT_SCHEMA,
  StoreProductMedia: MEDIA_SCHEMA,
  PrintAttributes: ATTRIBUTES_SCHEMA,
  StoreReviews: STORE_REVIEWS_SCHEMA,
};

export const STORE_ROUTES: PublicRoute[] = [
  {
    operationId: 'getStore',
    path: '/stores/{slug}',
    tag: 'Stores',
    summary: 'A merchant shop: profile, delivery, services, workshop and shelves',
    description:
      'A Levo Community shop as its own site (<slug>.levonis-iq.com) shows it to a signed-out visitor. Shops are public on their own address even while the community directory is closed; a shop Levonis has suspended answers 404 STORE_UNAVAILABLE.',
    params: [STORE_SLUG],
    data: ref('Store'),
    maxAge: 60,
    example: '/stores/{slug}',
    handler: getStore,
  },
  {
    operationId: 'listStoreProducts',
    path: '/stores/{slug}/products',
    tag: 'Stores',
    summary: 'A shop\'s published products',
    description: 'Newest first. Filter by the shop\'s own category label, by deals (a crossed-out price) or by the merchant\'s pinned products.',
    params: [
      STORE_SLUG,
      { name: 'category', in: 'query', description: 'The shop\'s own category label, exactly.', schema: { type: 'string', maxLength: 60 } },
      { name: 'deals', in: 'query', description: '1 = only products with a crossed-out price.', schema: { type: 'string', enum: ['1'] } },
      { name: 'featured', in: 'query', description: '1 = only products the merchant pinned.', schema: { type: 'string', enum: ['1'] } },
      LIMIT_PARAM,
      CURSOR_PARAM,
    ],
    data: array(ref('StoreProductCard')),
    paginated: true,
    maxAge: 60,
    example: '/stores/{slug}/products',
    handler: storeProducts,
  },
  {
    operationId: 'getStoreProduct',
    path: '/stores/{slug}/products/{product}',
    tag: 'Stores',
    summary: 'One shop product with its options, variants, pictures and print details',
    description: 'Everything the product\'s page shows a visitor: texts, every original picture and video, the price and availability of every variant, and what it is printed from.',
    params: [
      STORE_SLUG,
      {
        name: 'product',
        in: 'path',
        required: true,
        description: 'The product\'s slug (see /stores/{slug}/products).',
        schema: { type: 'string', maxLength: 160 },
      },
    ],
    data: ref('StoreProduct'),
    maxAge: 60,
    example: '/stores/{slug}/products/{product}',
    handler: storeProduct,
  },
  {
    operationId: 'listStoreReviews',
    path: '/stores/{slug}/reviews',
    tag: 'Stores',
    summary: 'A shop\'s reviews and rating distribution',
    description: 'Reviews from completed orders, newest first, with the reviewer masked as on the site and the merchant\'s reply.',
    params: [STORE_SLUG, LIMIT_PARAM, CURSOR_PARAM],
    data: ref('StoreReviews'),
    paginated: true,
    maxAge: 300,
    example: '/stores/{slug}/reviews',
    handler: storeReviews,
  },
];
