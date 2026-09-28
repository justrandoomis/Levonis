/**
 * THE HOME PAGE, THE OFFERS AND THE BUNDLES.
 *
 * The home page's product rows come through the same functions the site's
 * own rows use (`listCatalogProducts`, `resolveProductCards`, the shelf
 * queries in worker/lib/homeShelves.ts), priced for an anonymous visitor.
 * Compositions never slip into a plain product row here: the listing adds
 * `composition = ''` itself, and the shelf queries exclude them.
 *
 * BUNDLES are built from the resolved composition (`ResolvedBundle`), not
 * from the storefront card: a members-only box is published with its
 * picture and names but NO price — exactly the locked card the site shows a
 * visitor — and a box whose offer the owner switched off is not listed at
 * all (`listBundles`).
 */
import { notFound } from '../../http';
import { catalogIndexFor } from '../../catalogPresentation';
import { getSettings } from '../../settings';
import { homeCategoryTree } from '../../catalogMembership';
import { featuredIds, flashDealIds } from '../../homeShelves';
import { loadCompositionBySlug, displayOverride, type ResolvedBundle } from '../../bundleRead';
import { publicMysteryBlock, type MysteryContext } from '../../mysteryLine';
import { productImageForSelection } from '../../productSelectionImage';
import { listBundles } from '../../../routes/bundles';
import {
  listCatalogProducts,
  pricingCtxForUser,
  resolveCompositionPageWithMystery,
  resolveProductCards,
  type PricingCtx,
} from '../../../routes/products';
import {
  availabilityFromComposition,
  brandsById,
  imageFromUrl,
  int,
  isoOrNull,
  localized,
  offerFromCard,
  productCardDto,
  type Localized,
} from '../common';
import { bannerDtos } from './site';
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
import type { PublicRequest, PublicRoute } from '../types';
import type { PublicUrls } from '../urls';

type Rec = Record<string, unknown>;

/** Product rows by id, in the order given, as public cards (anonymous prices). */
async function cardsForIds(db: D1Database, ids: string[], urls: PublicUrls, ctx: Promise<PricingCtx>) {
  if (ids.length === 0) return [];
  const { results } = await db
    .prepare(
      "SELECT * FROM products WHERE status = 'active' AND composition = '' AND id IN (SELECT value FROM json_each(?))"
    )
    .bind(JSON.stringify(ids))
    .all<Rec>();
  const rows = new Map((results ?? []).map((r) => [String(r.id), r]));
  const ordered = ids.map((id) => rows.get(id)).filter((r): r is Rec => !!r);
  const [cards, idx, brands] = await Promise.all([
    resolveProductCards(db, ordered, await ctx, null),
    catalogIndexFor(db).catch(() => null),
    brandsById(db, ordered.map((r) => r.brand_id)),
  ]);
  return ordered
    .map((r) => {
      const card = cards.get(String(r.id));
      return card ? productCardDto(card, r, { urls, idx, brands }) : null;
    })
    .filter((c): c is NonNullable<typeof c> => !!c);
}

// ------------------------------------------------------------ home

const HOME_SECTION_SCHEMA = object(
  {
    slug: string(),
    name: localizedSchema(),
    product_count: integer(),
    url: url(),
    api_url: url(),
    pictures: object({ card: ref('PictureSet') }),
    children: array(
      object(
        { slug: string(), name: localizedSchema(), product_count: integer(), url: url(), api_url: url(), pictures: object({ card: ref('PictureSet') }) },
        'A sub-section on the home page.'
      )
    ),
  },
  'A section shown on the home page.'
);

const HOME_SCHEMA = object(
  {
    blocks: array(
      object({ key: string('Which block (hero, categories, printer_finder, latest_products, editorial_banners, services…).'), title: localizedSchema(), visible: boolean() }),
      'The home page\'s blocks, in the owner\'s order.'
    ),
    hero_slides: array(ref('Banner')),
    ticker: array(string(), 'The short announcements scrolling under the hero.'),
    sections: array(HOME_SECTION_SCHEMA, 'The sections the home page offers, with their card pictures.'),
    latest_products: array(ref('ProductCard'), 'The newest products.'),
    flash_deals: array(ref('ProductCard'), 'Products on a time-limited offer now, soonest ending first.'),
    featured_products: array(ref('ProductCard'), 'Products the owner features.'),
    editorial_banners: array(ref('Banner')),
  },
  'The home page, as a signed-out visitor sees it.'
);

async function home(req: PublicRequest) {
  const { db, urls } = req;
  const ctx = pricingCtxForUser(db, null);
  const [settings, tree, idx, latest, flashIds, featIds] = await Promise.all([
    getSettings(db, ['homeSections', 'homeBanners', 'homeAds']),
    homeCategoryTree(db),
    catalogIndexFor(db).catch(() => null),
    listCatalogProducts(db, { limit: '12', offset: '0' }, ctx),
    flashDealIds(db, new Date().toISOString()),
    featuredIds(db),
  ]);
  const sectionsSetting = Array.isArray(settings.homeSections) ? (settings.homeSections as Rec[]) : [];
  const hidden = new Set(sectionsSetting.filter((s) => s && s.isVisible === false).map((s) => String(s.id)));
  const pathOf = (id: string, slug: string) => (idx?.byId.has(id) ? idx.path(id) : `/categories/${slug}`);
  const pictures = (n: { image_url?: string; light_image_url?: string; mobile_image_url?: string; light_mobile_image_url?: string }) => ({
    card: {
      dark: urls.media(n.image_url),
      light: urls.media(n.light_image_url),
      dark_phone: urls.media(n.mobile_image_url),
      light_phone: urls.media(n.light_mobile_image_url),
    },
  });
  const latestCards = (Array.isArray(latest.body.products) ? latest.body.products : []) as Rec[];
  const brands = await brandsById(db, [...latest.rows.values()].map((r) => r.brand_id));
  const [flash, featured] = await Promise.all([cardsForIds(db, flashIds, urls, ctx), cardsForIds(db, featIds, urls, ctx)]);
  const ads = Array.isArray(settings.homeAds) ? (settings.homeAds as Rec[]) : [];
  return {
    data: {
      blocks: sectionsSetting
        .filter((s) => s && typeof s.id === 'string')
        .map((s) => ({ key: String(s.id), title: localized(s.titleAr, s.titleEn, ''), visible: s.isVisible !== false })),
      hero_slides: [
        ...(hidden.has('first_banner') ? [] : bannerDtos(settings.homeBanners, 'first_banner', urls)),
        ...(hidden.has('second_banner') ? [] : bannerDtos(settings.homeBanners, 'second_banner', urls)),
      ],
      ticker: hidden.has('ads_panel') ? [] : ads.map((a) => (typeof a.text === 'string' ? a.text.trim() : '')).filter(Boolean),
      sections: tree.map((n) => ({
        slug: n.slug,
        name: localized(n.name_ar, n.name_en, n.name_ckb),
        product_count: n.product_count,
        url: urls.web(pathOf(n.id, n.slug)),
        api_url: urls.api(`/sections/${encodeURIComponent(n.slug)}`),
        pictures: pictures(n),
        children: (n.children ?? []).map((ch) => ({
          slug: ch.slug,
          name: localized(ch.name_ar, ch.name_en, ch.name_ckb),
          product_count: ch.product_count,
          url: urls.web(pathOf(ch.id, ch.slug)),
          api_url: urls.api(`/sections/${encodeURIComponent(ch.slug)}`),
          pictures: pictures(ch),
        })),
      })),
      latest_products: latestCards.map((card) => productCardDto(card, latest.rows.get(String(card.id)), { urls, idx, brands })),
      flash_deals: flash,
      featured_products: featured,
      editorial_banners: hidden.has('editorial_banners') ? [] : bannerDtos(settings.homeBanners, 'editorial_banners', urls),
    },
    web: urls.web('/'),
  };
}

// ------------------------------------------------------------ offers

async function offers(req: PublicRequest) {
  const { db, urls, query } = req;
  const limit = parseLimit(query.limit);
  const offset = decodeCursor(query.cursor);
  const ctx = pricingCtxForUser(db, null);
  const [{ body, rows }, idx] = await Promise.all([
    listCatalogProducts(db, { offer: '1', sort: 'relevance', limit: String(limit), offset: String(offset) }, ctx),
    catalogIndexFor(db).catch(() => null),
  ]);
  const cards = (Array.isArray(body.products) ? body.products : []) as Rec[];
  const brands = await brandsById(db, [...rows.values()].map((r) => r.brand_id));
  // `offer=1` also matches an offer that has not started yet; a visitor can
  // only take the ones running now.
  const live = cards.filter((card) => offerFromCard(card) !== null);
  return {
    data: live.map((card) => productCardDto(card, rows.get(String(card.id)), { urls, idx, brands })),
    pagination: pageFromSource(limit, offset, cards.length, null),
    web: urls.web('/products?offer=1'),
  };
}

// ------------------------------------------------------------ bundles

const BUNDLE_SCHEMA = object(
  {
    slug: string(),
    kind: enumOf(['bundle', 'mystery'], 'A bundle of named products, or a mystery box of filament.'),
    name: localizedSchema(),
    description: localizedSchema(),
    url: url(),
    api_url: url(),
    image: nullable(ref('Image')),
    members_only: boolean('True when only members may buy it; a visitor then sees no price.'),
    price: ref('Price'),
    saving_percent: nullable(number('How much cheaper than buying the items one by one.')),
    availability: ref('Availability'),
    offer: nullable(
      object({ starts_at: nullable(dateTime()), ends_at: nullable(dateTime()) }, 'The time window the bundle is on sale in, when it has one.')
    ),
    items: array(
      object(
        {
          slug: string(),
          name: localizedSchema(),
          quantity: integer(),
          optional: boolean(),
          image: nullable(ref('Image')),
          url: url(),
        },
        'An item in the bundle.'
      ),
      'What is in a bundle (empty for a mystery box, and for a members-only bundle).'
    ),
    mystery: nullable(
      object(
        {
          spools: integer('How many spools the box holds.'),
          families: array(localizedSchema(), 'The filament families it can contain.'),
          customer_picks_family: boolean('The buyer chooses the family.'),
          reveal: localizedSchema('When the contents are revealed.'),
          odds: nullable(array(object({ family: localizedSchema(), percent: number() }), 'The chance of each family, when the shop publishes them.')),
        },
        'Mystery box details.'
      )
    ),
  },
  'A bundle or mystery box.'
);

function bundleDto(b: ResolvedBundle, urls: PublicUrls, familyNames: Map<string, Localized>, mystery?: MysteryContext) {
  const doc = b.doc;
  const slug = doc.slug;
  const locked = b.locked === true;
  const display = displayOverride(b) as Rec;
  const amount = locked ? null : int(display.display_price_iqd) ?? int(b.pricing.applied_iqd);
  const regular = locked ? null : int(display.display_regular_iqd) ?? int(b.pricing.regular_iqd) ?? amount;
  const cover = productImageForSelection(doc, { optionValueIds: [], colorId: null }, b.view);
  const w = b.window;
  const nameOfFamily = (id: string) => familyNames.get(id) ?? localized('', id, '');
  return {
    slug,
    kind: (doc.composition === 'mystery' ? 'mystery' : 'bundle') as 'bundle' | 'mystery',
    name: localized(doc.name_ar, doc.name_en, doc.name_ckb),
    description: locked ? localized('', '', '') : localized(doc.description_ar, doc.description_en, doc.description_ckb),
    url: urls.web(`/bundles/${encodeURIComponent(slug)}`),
    api_url: urls.api(`/bundles/${encodeURIComponent(slug)}`),
    image: imageFromUrl(cover, urls, localized(doc.name_ar, doc.name_en, doc.name_ckb)),
    members_only: locked,
    price: { currency: 'IQD' as const, amount, regular, from: false, member_price: null },
    saving_percent: locked ? null : typeof b.pricing.saving_percent === 'number' ? b.pricing.saving_percent : null,
    availability: availabilityFromComposition(locked ? 'member_exclusive' : b.availability.state),
    offer: w && w.active ? { starts_at: isoOrNull(w.starts_at), ends_at: isoOrNull(w.ends_at) } : null,
    items:
      locked || doc.composition === 'mystery'
        ? []
        : b.components
            .filter((c) => c.included)
            .map((c) => ({
              slug: c.doc.slug,
              name: localized(c.doc.name_ar, c.doc.name_en, c.doc.name_ckb),
              quantity: c.qty_per_bundle,
              optional: c.optional,
              image: imageFromUrl(
                productImageForSelection(c.doc, { optionValueIds: c.selection.option_value_ids, colorId: c.selection.color_id }, c.view),
                urls
              ),
              url: urls.web(`/product/${encodeURIComponent(c.doc.slug)}`),
            })),
    mystery:
      !locked && mystery
        ? (() => {
            const block = publicMysteryBlock(mystery, 'ar') as Rec;
            const en = publicMysteryBlock(mystery, 'en') as Rec;
            const ckb = publicMysteryBlock(mystery, 'ckb') as Rec;
            const odds = Array.isArray(block.odds) ? (block.odds as Array<{ family_id: string; percent: number }>) : null;
            return {
              spools: int(block.spool_qty) ?? 0,
              families: (Array.isArray(block.families) ? (block.families as string[]) : []).map(nameOfFamily),
              customer_picks_family: block.customer_picks_family === true,
              reveal: localized(block.reveal_stage_label, en.reveal_stage_label, ckb.reveal_stage_label),
              odds: odds ? odds.map((o) => ({ family: nameOfFamily(o.family_id), percent: o.percent })) : null,
            };
          })()
        : null,
  };
}

/** Mystery families are catalog or facet ids — never shown as ids. */
async function familyNamesFor(db: D1Database, ids: string[]): Promise<Map<string, Localized>> {
  const out = new Map<string, Localized>();
  const list = [...new Set(ids.filter(Boolean))];
  if (list.length === 0) return out;
  const [cats, facets] = await Promise.all([
    db.prepare('SELECT id, name_ar, name_en, name_ckb FROM catalogs WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(list)).all<Rec>(),
    db.prepare('SELECT id, name_ar, name_en, name_ckb FROM facets WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(list)).all<Rec>(),
  ]);
  for (const r of [...(facets.results ?? []), ...(cats.results ?? [])]) out.set(String(r.id), localized(r.name_ar, r.name_en, r.name_ckb));
  return out;
}

async function bundlesList(req: PublicRequest) {
  const { db, urls, query } = req;
  const limit = parseLimit(query.limit);
  const offset = decodeCursor(query.cursor);
  const { bundles } = await listBundles(
    db,
    { kind: query.kind, search: query.q, limit, offset },
    pricingCtxForUser(db, null)
  );
  return {
    data: bundles.map((b) => bundleDto(b, urls, new Map())),
    pagination: pageFromSource(limit, offset, bundles.length, null),
    web: urls.web(query.kind === 'mystery' ? '/bundles?kind=mystery' : '/bundles'),
  };
}

async function bundleDetail(req: PublicRequest) {
  const { db, urls } = req;
  const row = await loadCompositionBySlug(db, req.path.slug);
  if (!row || String(row.status ?? '') !== 'active') throw notFound('Bundle not found');
  const ctx = await pricingCtxForUser(db, null);
  const { resolved, mystery } = await resolveCompositionPageWithMystery(db, [row], ctx);
  const b = resolved.get(String(row.id));
  if (!b || b.availability.state === 'unconfigured' || (b.window && !b.window.active)) throw notFound('Bundle not found');
  const m = mystery.get(String(row.id));
  let families = new Map<string, Localized>();
  if (m) {
    const block = publicMysteryBlock(m, 'ar') as Rec;
    const oddsIds = Array.isArray(block.odds) ? (block.odds as Array<{ family_id: string }>).map((o) => o.family_id) : [];
    families = await familyNamesFor(db, [...m.families, ...oddsIds]);
  }
  return {
    data: bundleDto(b, urls, families, m),
    web: urls.web(`/bundles/${encodeURIComponent(req.path.slug)}`),
  };
}

// ------------------------------------------------------------ routes

export const SHOP_COMPONENTS: Record<string, JsonSchema> = {
  Home: HOME_SCHEMA,
  Bundle: BUNDLE_SCHEMA,
};

const LIMIT = { name: 'limit', in: 'query' as const, description: 'Items per page, 1–50 (default 24).', schema: { type: 'integer', minimum: 1 } };
const CURSOR = { name: 'cursor', in: 'query' as const, description: 'The `meta.pagination.next_cursor` of the previous page.', schema: { type: 'string', maxLength: 200 } };

export const SHOP_ROUTES: PublicRoute[] = [
  {
    operationId: 'getHome',
    path: '/home',
    tag: 'Site',
    summary: 'The home page',
    description: 'The home page as a visitor sees it: its blocks in the owner\'s order, hero slides, announcements, the sections it offers with their pictures, the newest products, flash deals, featured products and the editorial banners.',
    data: ref('Home'),
    maxAge: 120,
    example: '/home',
    handler: home,
  },
  {
    operationId: 'listOffers',
    path: '/offers',
    tag: 'Products',
    summary: 'Products on a time-limited offer now',
    description: 'Products whose offer is running now — priced for a visitor, or marked members-only — with the offer\'s end time.',
    params: [LIMIT, CURSOR],
    data: array(ref('ProductCard')),
    paginated: true,
    maxAge: 120,
    example: '/offers',
    handler: offers,
  },
  {
    operationId: 'listBundles',
    path: '/bundles',
    tag: 'Products',
    summary: 'Bundles and mystery boxes on sale',
    description: 'Product bundles sold at one price, and filament mystery boxes. A members-only one is listed without a price, as the site shows it to a visitor.',
    params: [
      { name: 'kind', in: 'query', description: 'bundle or mystery; both when omitted.', schema: { type: 'string', enum: ['bundle', 'mystery'] } },
      { name: 'q', in: 'query', description: 'Search in names and descriptions.', schema: { type: 'string', maxLength: 100 } },
      LIMIT,
      CURSOR,
    ],
    data: array(ref('Bundle')),
    paginated: true,
    maxAge: 120,
    example: '/bundles?kind=bundle',
    handler: bundlesList,
  },
  {
    operationId: 'getBundle',
    path: '/bundles/{slug}',
    tag: 'Products',
    summary: 'One bundle or mystery box',
    description: 'A bundle with every item in it, or a mystery box with its size, possible filament families, when its contents are revealed and — when the shop publishes them — the odds of each family.',
    params: [{ name: 'slug', in: 'path', required: true, description: 'The bundle\'s slug.', schema: { type: 'string', maxLength: 160 }, example: 'starter-kit' }],
    data: ref('Bundle'),
    maxAge: 120,
    example: '/bundles/{slug}',
    handler: bundleDetail,
  },
];
