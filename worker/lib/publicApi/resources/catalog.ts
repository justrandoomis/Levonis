/**
 * SECTIONS, BRANDS AND SEARCH — how the catalogue is organised.
 *
 * Sections are the explorer's own tree (`buildCatalogTree`,
 * worker/routes/catalog.ts): active sections that hold at least one product,
 * in the owner's order, with the same roll-up counts the site draws. Brands
 * are the active brands that have published products; their logos are the
 * site-media slots the home page draws (worker/lib/siteMedia.ts BRAND_SLOTS).
 */
import { listing } from '../../listing';
import { notFound } from '../../http';
import { catalogIndexFor } from '../../catalogPresentation';
import { getSetting } from '../../settings';
import { BRAND_SLOTS, resolveSiteMedia } from '../../siteMedia';
import { normalizeText } from '../../search/normalize';
import { buildCatalogTree } from '../../../routes/catalog';
import { listCatalogProducts, pricingCtxForUser } from '../../../routes/products';
import type { CatalogTreeNode } from '@levonis/catalog/discoveryTypes';
import { brandsById, localized, productCardDto, type BrandInfo } from '../common';
import { array, integer, localized as localizedSchema, nullable, object, ref, string, url, type JsonSchema } from '../schema';
import type { PublicRequest, PublicRoute } from '../types';
import type { PublicUrls } from '../urls';

// ------------------------------------------------------------ sections

const PICTURE_SET_SCHEMA = object(
  {
    dark: nullable(url('Dark theme, large screens.')),
    light: nullable(url('Light theme, large screens.')),
    dark_phone: nullable(url('Dark theme, phones (under 640 px).')),
    light_phone: nullable(url('Light theme, phones.')),
  },
  'One picture in up to four versions — null where the owner uploaded none (the site then falls back to another version, and finally to a product photo).'
);

const SECTION_SCHEMA: JsonSchema = object(
  {
    slug: string('The section\'s identifier in this API and on the site.'),
    name: localizedSchema(),
    description: localizedSchema('One or two lines the section page shows; \'\' when none was written.'),
    path: string('The page path on the site.'),
    url: url('The section\'s page on the website.'),
    api_url: url('This section in the public API.'),
    products_api_url: url('Every product in this section and below it, in the public API.'),
    product_count: integer('Published products here or anywhere below.'),
    available_count: nullable(integer('Of those, how many can be bought now from stock; null when the site did not count.')),
    pictures: object({ card: ref('PictureSet'), banner: ref('PictureSet') }, 'The section\'s own pictures: its card on the home page and its banner.'),
    children: array(ref('Section'), 'Sub-sections that hold products, in the site\'s order.'),
  },
  'A section (category) of the catalogue.'
);

function pictureSet(urls: PublicUrls, dark: unknown, light: unknown, darkPhone: unknown, lightPhone: unknown) {
  return { dark: urls.media(dark), light: urls.media(light), dark_phone: urls.media(darkPhone), light_phone: urls.media(lightPhone) };
}

type SectionDto = {
  slug: string;
  name: ReturnType<typeof localized>;
  description: ReturnType<typeof localized>;
  path: string;
  url: string;
  api_url: string;
  products_api_url: string;
  product_count: number;
  available_count: number | null;
  pictures: { card: ReturnType<typeof pictureSet>; banner: ReturnType<typeof pictureSet> };
  children: SectionDto[];
};

function sectionDto(n: CatalogTreeNode, urls: PublicUrls): SectionDto {
  return {
    slug: n.slug,
    name: localized(n.name_ar, n.name_en, n.name_ckb),
    description: localized(n.description_ar, n.description_en, n.description_ckb),
    path: n.path,
    url: urls.web(n.path),
    api_url: urls.api(`/sections/${encodeURIComponent(n.slug)}`),
    products_api_url: urls.api(`/products?section=${encodeURIComponent(n.slug)}`),
    product_count: n.product_count,
    available_count: n.available_count,
    pictures: {
      card: pictureSet(urls, n.image_url, n.light_image_url, n.mobile_image_url, n.light_mobile_image_url),
      banner: pictureSet(urls, n.hero_image_url, n.hero_light_image_url, n.hero_mobile_image_url, n.hero_light_mobile_image_url),
    },
    children: (n.children ?? []).map((ch) => sectionDto(ch, urls)),
  };
}

async function sectionTree(db: D1Database) {
  return buildCatalogTree(db, pricingCtxForUser(db, null));
}

async function listSections(req: PublicRequest) {
  const { roots, totals } = await sectionTree(req.db);
  return {
    data: {
      sections: roots.map((r) => sectionDto(r, req.urls)),
      totals: { products: totals.products, available: totals.available },
    },
    web: req.urls.web('/categories'),
  };
}

function findNode(nodes: readonly CatalogTreeNode[], slug: string, trail: CatalogTreeNode[] = []): { node: CatalogTreeNode; trail: CatalogTreeNode[] } | null {
  for (const n of nodes) {
    if (n.slug === slug) return { node: n, trail };
    const hit = findNode(n.children ?? [], slug, [...trail, n]);
    if (hit) return hit;
  }
  return null;
}

async function getSection(req: PublicRequest) {
  const { roots } = await sectionTree(req.db);
  const hit = findNode(roots, req.path.slug);
  if (!hit) throw notFound('Section not found');
  const section = sectionDto(hit.node, req.urls);
  return {
    data: {
      ...section,
      breadcrumb: hit.trail.map((t) => ({
        slug: t.slug,
        name: localized(t.name_ar, t.name_en, t.name_ckb),
        path: t.path,
        url: req.urls.web(t.path),
        api_url: req.urls.api(`/sections/${encodeURIComponent(t.slug)}`),
      })),
    },
    web: req.urls.web(hit.node.path),
  };
}

// ------------------------------------------------------------ brands

const BRAND_SCHEMA = object(
  {
    slug: string('The brand\'s identifier in this API and on the site.'),
    name: localizedSchema(),
    logo: nullable(url('The brand logo the home page shows, when the site has one.')),
    product_count: integer('Published products of this brand.'),
    url: url('The brand\'s products on the website.'),
    api_url: url('This brand in the public API.'),
    products_api_url: url('This brand\'s products in the public API.'),
  },
  'A brand sold on the site.'
);

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

async function brandRows(db: D1Database, slug?: string) {
  const listedP = (await listing(db)).listed('p');
  const { results } = await db
    .prepare(
      `SELECT b.id, b.slug, b.name_ar, b.name_en, b.name_ckb, COUNT(p.id) AS n
         FROM brands b
         JOIN products p ON p.brand_id = b.id AND ${listedP} AND p.composition = ''
        WHERE b.active = 1 ${slug ? 'AND b.slug = ?' : ''}
        GROUP BY b.id
        ORDER BY n DESC, b.name_en`
    )
    .bind(...(slug ? [slug] : []))
    .all<BrandInfo & { n: number }>();
  return results ?? [];
}

async function brandLogos(db: D1Database, urls: PublicUrls): Promise<Map<string, string>> {
  const stored = await getSetting(db, 'mainPageMedia');
  const out = new Map<string, string>();
  const resolved = new Map(resolveSiteMedia(stored).map((m) => [m.slot, m.url]));
  for (const slot of BRAND_SLOTS) {
    const href = urls.media(resolved.get(slot.slot));
    if (!href) continue;
    out.set(squash(slot.slot.replace(/^brand-/, '')), href);
    out.set(squash(slot.label), href);
  }
  return out;
}

function brandDto(b: BrandInfo & { n: number }, logos: Map<string, string>, urls: PublicUrls) {
  return {
    slug: b.slug,
    name: localized(b.name_ar, b.name_en, b.name_ckb),
    logo: logos.get(squash(b.slug)) ?? logos.get(squash(b.name_en ?? '')) ?? null,
    product_count: Number(b.n) || 0,
    url: urls.web(`/products?brand=${encodeURIComponent(b.slug)}`),
    api_url: urls.api(`/brands/${encodeURIComponent(b.slug)}`),
    products_api_url: urls.api(`/products?brand=${encodeURIComponent(b.slug)}`),
  };
}

async function listBrands(req: PublicRequest) {
  const [rows, logos] = await Promise.all([brandRows(req.db), brandLogos(req.db, req.urls)]);
  return { data: rows.map((b) => brandDto(b, logos, req.urls)), web: req.urls.web('/products') };
}

async function getBrand(req: PublicRequest) {
  const [rows, logos] = await Promise.all([brandRows(req.db, req.path.slug), brandLogos(req.db, req.urls)]);
  const b = rows[0];
  if (!b) throw notFound('Brand not found');
  return { data: brandDto(b, logos, req.urls), web: req.urls.web(`/products?brand=${encodeURIComponent(b.slug)}`) };
}

// ------------------------------------------------------------ search

const SEARCH_SCHEMA = object(
  {
    query: string('The search text as received.'),
    suggestion: nullable(string('A completion the site would offer for the last word, when it has one.')),
    products: array(ref('ProductCard'), 'The best-matching products (the site\'s own ranked search), at most `limit`.'),
    sections: array(ref('SectionRef'), 'Sections whose name matches.'),
    brands: array(ref('BrandRef'), 'Brands whose name matches.'),
    more_products_api_url: url('Every matching product, paginated.'),
  },
  'Search across products, sections and brands.'
);

async function search(req: PublicRequest) {
  const { db, urls, query } = req;
  const q = (query.q ?? '').trim();
  const limit = Math.min(Number.parseInt(query.limit ?? '10', 10) || 10, 24);
  const [{ body, rows }, idx, brandList] = await Promise.all([
    listCatalogProducts(db, { search: q, limit: String(limit), offset: '0' }, pricingCtxForUser(db, null)),
    catalogIndexFor(db).catch(() => null),
    brandRows(db),
  ]);
  const cards = (Array.isArray(body.products) ? body.products : []) as Record<string, unknown>[];
  const brands = await brandsById(db, [...rows.values()].map((r) => r.brand_id));
  const needle = normalizeText(q);
  const matches = (...names: unknown[]) => needle.length > 0 && names.some((n) => normalizeText(n).includes(needle));
  const sections = idx
    ? [...idx.byId.values()]
        .filter((r) => r.active && matches(r.name_ar, r.name_en, r.name_ckb, r.slug))
        .slice(0, 10)
        .map((r) => ({
          slug: r.slug,
          name: localized(r.name_ar, r.name_en, r.name_ckb),
          path: idx.path(r.id),
          url: urls.web(idx.path(r.id)),
          api_url: urls.api(`/sections/${encodeURIComponent(r.slug)}`),
        }))
    : [];
  const brandHits = brandList
    .filter((b) => matches(b.name_ar, b.name_en, b.name_ckb, b.slug))
    .slice(0, 10)
    .map((b) => ({
      slug: b.slug,
      name: localized(b.name_ar, b.name_en, b.name_ckb),
      url: urls.web(`/products?brand=${encodeURIComponent(b.slug)}`),
      api_url: urls.api(`/brands/${encodeURIComponent(b.slug)}`),
    }));
  return {
    data: {
      query: q,
      suggestion: typeof body.suggestion === 'string' && body.suggestion ? body.suggestion : null,
      products: cards.map((card) => productCardDto(card, rows.get(String(card.id)), { urls, idx, brands })),
      sections,
      brands: brandHits,
      more_products_api_url: urls.api(`/products?q=${encodeURIComponent(q)}`),
    },
    web: urls.web(`/products?search=${encodeURIComponent(q)}`),
  };
}

// ------------------------------------------------------------ routes

export const CATALOG_COMPONENTS: Record<string, JsonSchema> = {
  PictureSet: PICTURE_SET_SCHEMA,
  Section: SECTION_SCHEMA,
  Brand: BRAND_SCHEMA,
  SearchResults: SEARCH_SCHEMA,
};

const SLUG = (what: string, example: string) => ({
  name: 'slug',
  in: 'path' as const,
  required: true,
  description: `The ${what}'s slug.`,
  schema: { type: 'string', maxLength: 160 },
  example,
});

export const CATALOG_ROUTES: PublicRoute[] = [
  {
    operationId: 'listSections',
    path: '/sections',
    tag: 'Catalogue',
    summary: 'The section (category) tree',
    description:
      'Every section that holds products, as a tree in the site\'s order, with product counts, descriptions and each section\'s own pictures (card and banner, dark and light, large screen and phone).',
    data: object(
      {
        sections: array(ref('Section')),
        totals: object({ products: integer('Published products in all sections.'), available: nullable(integer('Of those, how many can be bought now.')) }),
      },
      'The catalogue tree.'
    ),
    maxAge: 300,
    example: '/sections',
    handler: listSections,
  },
  {
    operationId: 'getSection',
    path: '/sections/{slug}',
    tag: 'Catalogue',
    summary: 'One section with its sub-sections',
    description: 'A section, its sub-sections and the way down to it from the main section. Its products: /products?section={slug}.',
    params: [SLUG('section', 'printers')],
    data: object(
      {
        ...((SECTION_SCHEMA.properties as Record<string, JsonSchema>) ?? {}),
        breadcrumb: array(ref('SectionRef'), 'The sections above this one, main section first.'),
      },
      'A section.'
    ),
    maxAge: 300,
    example: '/sections/printers',
    handler: getSection,
  },
  {
    operationId: 'listBrands',
    path: '/brands',
    tag: 'Catalogue',
    summary: 'Brands with published products',
    description: 'Active brands that have published products, most products first, with their logos when the site has one.',
    data: array(ref('Brand')),
    maxAge: 300,
    example: '/brands',
    handler: listBrands,
  },
  {
    operationId: 'getBrand',
    path: '/brands/{slug}',
    tag: 'Catalogue',
    summary: 'One brand',
    description: 'A brand. Its products: /products?brand={slug}.',
    params: [SLUG('brand', 'bambu-lab')],
    data: ref('Brand'),
    maxAge: 300,
    example: '/brands/{slug}',
    handler: getBrand,
  },
  {
    operationId: 'search',
    path: '/search',
    tag: 'Catalogue',
    summary: 'Search products, sections and brands',
    description:
      'The site\'s own search (Arabic normalisation, Latin/Arabic spellings, typo tolerance) for products, plus sections and brands whose names match.',
    params: [
      { name: 'q', in: 'query', required: true, description: 'What to look for.', schema: { type: 'string', minLength: 1, maxLength: 100 }, example: 'filament' },
      { name: 'limit', in: 'query', description: 'Products to return, 1–24 (default 10).', schema: { type: 'integer', minimum: 1 } },
    ],
    data: ref('SearchResults'),
    maxAge: 120,
    example: '/search?q=pla',
    handler: search,
  },
];
