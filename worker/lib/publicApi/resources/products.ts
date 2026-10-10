/**
 * PRODUCTS — the catalogue as a signed-out visitor sees it.
 *
 * Nothing here queries prices or builds cards itself: the list is
 * `listCatalogProducts` and the detail is `catalogProductDetail`, the same
 * functions `GET /api/products` and `GET /api/products/:slug` answer from
 * (worker/routes/products.ts), called with the ANONYMOUS pricing context
 * (`pricingCtxForUser(db, null)`) — so every price here is the price a
 * visitor sees on the site, and cannot be a member's even if a cookie was
 * sent. What leaves is then built field by field (common.ts), never the
 * storefront payload itself: that payload still carries raw stock counts,
 * SKU parts, supplier source URLs and benefit-rule ids a visitor never sees
 * on the page.
 */
import { listing } from '../../listing';
import { HttpError, notFound } from '../../http';
import { catalogIndexFor } from '../../catalogPresentation';
import { parseProductRow } from '../../productModel';
import { maskName } from '../../../routes/reviews';
import {
  catalogProductDetail,
  listCatalogProducts,
  pricingCtxForUser,
} from '../../../routes/products';
import { LISTING_SORTS, SALE_FILTERS } from '@levonis/catalog/discovery';
import {
  brandRef,
  brandsById,
  imageFromMedia,
  imageFromUrl,
  int,
  isoOrNull,
  localized,
  offerFromCard,
  priceFromCard,
  productCardDto,
  sectionRef,
  type Localized,
  type PublicAvailability,
} from '../common';
import { decodeCursor, parseLimit, pageFromSource } from '../paging';
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

const SLUG_PARAM = {
  name: 'slug',
  in: 'path' as const,
  required: true,
  description: 'The product\'s slug, as in its site address /product/{slug}.',
  schema: { type: 'string', maxLength: 160 },
  example: 'bambu-lab-a1-mini',
};

const LIMIT_PARAM = {
  name: 'limit',
  in: 'query' as const,
  description: 'Items per page, 1–50 (default 24). Larger values are clamped.',
  schema: { type: 'integer', minimum: 1 },
};

const CURSOR_PARAM = {
  name: 'cursor',
  in: 'query' as const,
  description: 'The `meta.pagination.next_cursor` of the previous page.',
  schema: { type: 'string', maxLength: 200 },
};

// ------------------------------------------------------------ the list

async function listProducts(req: PublicRequest) {
  const { db, urls, query } = req;
  const limit = parseLimit(query.limit);
  const offset = decodeCursor(query.cursor);

  // The public vocabulary → the storefront listing's own grammar
  // (@levonis/catalog/discovery), which validates every value again.
  const q: Record<string, string> = { limit: String(limit), offset: String(offset) };
  if (query.q) q.search = query.q;
  if (query.section) q.category = query.section;
  if (query.brand) q.brand = query.brand;
  if (query.sort) q.sort = query.sort;
  if (query.available === '1') q.avail = '1';
  if (query.sale) q.sale = query.sale;
  if (query.offer === '1') q.offer = '1';
  if (query.min_price || query.max_price) q.price = `${query.min_price ?? ''}-${query.max_price ?? ''}`;

  const [{ body, rows }, idx] = await Promise.all([
    listCatalogProducts(db, q, pricingCtxForUser(db, null), { withTotal: true }),
    catalogIndexFor(db).catch(() => null),
  ]);
  const cards = (Array.isArray(body.products) ? body.products : []) as Record<string, unknown>[];
  const brands = await brandsById(db, [...rows.values()].map((r) => r.brand_id));
  const items = cards.map((card) => productCardDto(card, rows.get(String(card.id)), { urls, idx, brands }));

  // A listing that had to stop at its candidate cap knows only a lower bound.
  const total = body.truncated === true ? null : typeof body.total === 'number' ? body.total : null;
  return {
    data: items,
    pagination: pageFromSource(limit, offset, items.length, total),
    web: urls.web(query.section ? `/products?category=${encodeURIComponent(query.section)}` : '/products'),
  };
}

// ------------------------------------------------------------ one product

const OPTION_SCHEMA = object(
  {
    group: string('The option group the choice belongs to (e.g. a nozzle size), \'\' when the product has one list of options.'),
    name: localizedSchema(),
    image: nullable(url('The choice\'s own picture, when it has one.')),
    price: nullable(integer('The price with this choice, for a visitor, offers applied.')),
    regular_price: nullable(integer('The regular price with this choice.')),
    available: nullable(boolean('Whether this choice can be bought now; null when the site does not say.')),
    sale_mode: nullable(enumOf(['direct_sale', 'pre_order'], 'Set when this choice is sold only one way.')),
  },
  'One purchasable choice of the product (a size, a model, a bundle level…).'
);

const COLOR_SCHEMA = object(
  {
    name: localizedSchema(),
    hex: nullable(string('The colour as #RRGGBB, when given.')),
    image: nullable(url('A picture in this colour, when there is one.')),
    price: nullable(integer('The price in this colour, for a visitor.')),
    regular_price: nullable(integer('The regular price in this colour.')),
    available: nullable(boolean('Whether this colour can be bought now; null when the site does not say.')),
    only_with: array(localizedSchema(), 'The options this colour is sold with; empty when it goes with any.'),
  },
  'One colour of the product.'
);

const PRODUCT_SCHEMA = object(
  {
    slug: string(),
    kind: enumOf(['product'], 'Always `product` here; bundles have their own endpoint.'),
    name: localizedSchema(),
    description: localizedSchema('The product description (plain text, may contain line breaks).'),
    url: url('The product\'s page on the website.'),
    api_url: url('This product in the public API.'),
    reviews_url: url('This product\'s reviews in the public API.'),
    brand: nullable(ref('BrandRef')),
    sections: array(ref('SectionRef'), 'Where the product is filed, from the main section down.'),
    images: array(ref('Image'), 'Every public picture of the product, main picture first. Original quality.'),
    light_image: nullable(url('The main picture made for the light theme, when there is one.')),
    price: ref('Price'),
    availability: ref('Availability'),
    offer: nullable(ref('Offer')),
    purchase: object(
      {
        direct_sale: nullable(integer('The unit price when bought from stock in Iraq (the opening choice).')),
        pre_order: array(
          object(
            {
              method: enumOf(['air', 'sea', 'land'], 'How the pre-order is shipped.'),
              prepaid: nullable(integer('Unit price when paid in advance.')),
              cash_on_delivery: nullable(integer('Unit price when paid on delivery.')),
            },
            'One way to pre-order.'
          ),
          'The ways to pre-order and their unit prices (the opening choice).'
        ),
      },
      'How the product can be bought and what each way costs.'
    ),
    options: array(OPTION_SCHEMA),
    colors: array(COLOR_SCHEMA),
    combinations: array(
      object(
        {
          option: localizedSchema(),
          color: localizedSchema(),
          price: integer(),
          regular_price: integer(),
        },
        'The price of one option in one colour.'
      ),
      'The price of every option × colour pair, when the product has both (may be empty when there are too many to list).'
    ),
    specifications: array(
      object(
        {
          title: localizedSchema(),
          rows: array(
            object({ label: localizedSchema(), value: localizedSchema(), unit: string() }, 'One specification.')
          ),
        },
        'A group of specifications.'
      )
    ),
    dimensions: object(
      {
        net_weight_g: nullable(number()),
        width_mm: nullable(number()),
        depth_mm: nullable(number()),
        height_mm: nullable(number()),
        package_weight_g: nullable(number()),
        package_width_mm: nullable(number()),
        package_depth_mm: nullable(number()),
        package_height_mm: nullable(number()),
      },
      'Physical size and weight, when published.'
    ),
    labels: array(localizedSchema(), 'Short badges the product page shows (e.g. «warranty included»).'),
    condition: nullable(
      object(
        {
          kind: enumOf(['open_box', 'used', 'refurbished']),
          grade: nullable(enumOf(['like_new', 'excellent', 'good', 'fair'])),
          usage_hours: nullable(integer('Hours of printing, when known.')),
          warranty_months: nullable(integer()),
          fault: localizedSchema('What was wrong, if anything.'),
          repair: localizedSchema('What was repaired.'),
          notes: localizedSchema('The condition notes the product page shows.'),
          images: array(ref('Image'), 'Pictures of this very unit.'),
          new_price_reference: nullable(integer('The new product\'s price, for comparison, when the site shows it.')),
        },
        'The condition report of a used, open-box or refurbished unit.'
      )
    ),
    warranty: object(
      {
        base_months: nullable(integer('The warranty included in the price, in months.')),
        plans: array(
          object(
            {
              title: localizedSchema(),
              terms: localizedSchema(),
              months: integer(),
              kind: enumOf(['total', 'extension'], 'Total length, or months added to the base warranty.'),
              price: nullable(integer('What the plan adds to the price.')),
            },
            'An optional warranty plan.'
          )
        ),
      },
      'Warranty.'
    ),
    rating: object(
      {
        average: nullable(number('1–5, one decimal; null with no reviews.')),
        count: integer('Published reviews in all.'),
      },
      'Customer reviews summary.'
    ),
    fits_printers: array(
      object({ slug: string(), name: localizedSchema(), url: url(), api_url: url() }, 'A printer this part fits.'),
      'For a part or accessory: the printers the shop says it fits.'
    ),
    content: array(
      object(
        {
          kind: enumOf(['text', 'image', 'video']),
          text: localizedSchema(),
          caption: localizedSchema(),
          url: nullable(url('The picture or the video embed.')),
        },
        'A block of the product\'s long-form description.'
      )
    ),
    usage_guide: object(
      {
        official_url: nullable(url('The maker\'s own documentation.')),
        steps: array(
          object(
            {
              kind: enumOf(['setup', 'usage']),
              title: localizedSchema(),
              body: localizedSchema(),
              images: array(url()),
              video_url: nullable(url()),
              link_url: nullable(url()),
            },
            'One step.'
          )
        ),
      },
      'How to set up and use the product.'
    ),
    created_at: nullable(dateTime()),
  },
  'A product, as its page shows it to a signed-out visitor.'
);

type Rec = Record<string, unknown>;
const asRec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const asList = (v: unknown): Rec[] => (Array.isArray(v) ? (v as unknown[]).filter((x) => x && typeof x === 'object') as Rec[] : []);
const nameOf = (r: Rec): Localized => localized(r.name_ar, r.name_en, r.name_ckb);

/** Availability from the page's own verdict (`SaleAvailability`), counts capped as the site shows them. */
function availabilityFromSale(a: Rec, saleTypes: unknown): PublicAvailability {
  const modes = Array.isArray(saleTypes)
    ? (saleTypes as unknown[]).filter((t): t is string => t === 'direct_sale' || t === 'pre_order' || t === 'bundle')
    : [];
  const stock = asRec(a.stock);
  if (a.mode === 'direct_sale') {
    const n = typeof stock.available === 'number' ? stock.available : null;
    return { state: 'available', quantity: n === null ? null : Math.min(Math.max(0, n), 99), low_stock: stock.low === true, sale_modes: modes };
  }
  if (a.mode === 'preorder') return { state: 'preorder', quantity: null, low_stock: false, sale_modes: modes };
  if (a.mode === 'unavailable') return { state: 'unavailable', quantity: null, low_stock: false, sale_modes: modes };
  return { state: 'unknown', quantity: null, low_stock: false, sale_modes: modes };
}

/** option/colour id → can it be bought now (from the public relations view: a count, or a coarse state). */
function availabilityById(relations: unknown): Map<string, boolean | null> {
  const out = new Map<string, boolean | null>();
  const r = asRec(relations);
  const read = (v: Rec) => {
    if (typeof v.id !== 'string') return;
    if (typeof v.available === 'number') out.set(v.id, v.available > 0);
    else if (typeof v.stock_state === 'string') out.set(v.id, v.stock_state !== 'sold_out');
    else out.set(v.id, null);
  };
  for (const g of asList(r.option_groups)) for (const v of asList(g.values)) read(v);
  for (const c of asList(r.colors)) read(c);
  return out;
}

const lvl = (levels: Rec, key: string, id: string) => asRec(asRec(levels[key])[id]);

function dimensionsOf(d: unknown) {
  const r = asRec(d);
  const n = (k: string) => (typeof r[k] === 'number' && Number.isFinite(r[k]) ? (r[k] as number) : null);
  return {
    net_weight_g: n('net_weight_g'),
    width_mm: n('width_mm'),
    depth_mm: n('depth_mm'),
    height_mm: n('height_mm'),
    package_weight_g: n('package_weight_g'),
    package_width_mm: n('package_width_mm'),
    package_depth_mm: n('package_depth_mm'),
    package_height_mm: n('package_height_mm'),
  };
}

function httpsOrNull(v: unknown): string | null {
  return typeof v === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(v.trim()) ? v.trim() : null;
}

function productDetailDto(
  body: Rec,
  row: Rec,
  sections: ReturnType<typeof sectionRef>[],
  urls: PublicUrls
) {
  const product = asRec(body.product);
  const slug = String(row.slug);
  const levels = asRec(body.price_levels);
  const availableBy = availabilityById(body.relations);

  const options = asList(product.options).map((o) => {
    const id = String(o.id ?? '');
    const level = lvl(levels, 'option', id);
    const mode = o.availability_type === 'direct_sale' || o.availability_type === 'pre_order' ? o.availability_type : null;
    return {
      group: typeof o.group_en === 'string' ? o.group_en : '',
      name: nameOf(o),
      image: urls.media(o.image),
      price: int(level.applied_iqd),
      regular_price: int(level.regular_iqd),
      available: availableBy.get(id) ?? null,
      sale_mode: mode as 'direct_sale' | 'pre_order' | null,
    };
  });
  const optionName = new Map(asList(product.options).map((o) => [String(o.id ?? ''), nameOf(o)]));
  const colors = asList(product.colors).map((col) => {
    const id = String(col.id ?? '');
    const level = lvl(levels, 'color', id);
    const linked = Array.isArray(col.option_ids) && col.option_ids.length > 0 ? col.option_ids : col.option_id ? [col.option_id] : [];
    return {
      name: nameOf(col),
      hex: typeof col.hex === 'string' && /^#[0-9a-f]{6}$/i.test(col.hex) ? col.hex : null,
      image: urls.media(col.image),
      price: int(level.applied_iqd),
      regular_price: int(level.regular_iqd),
      available: availableBy.get(id) ?? null,
      only_with: (linked as unknown[]).map((oid) => optionName.get(String(oid))).filter((n): n is Localized => !!n),
    };
  });
  const colorName = new Map(asList(product.colors).map((c) => [String(c.id ?? ''), nameOf(c)]));
  const combinations =
    levels.complete === true
      ? Object.entries(asRec(levels.combo)).flatMap(([key, v]) => {
          const [oid, cid] = key.split('|');
          const option = optionName.get(oid);
          const color = colorName.get(cid);
          const price = int(asRec(v).applied_iqd);
          const regular = int(asRec(v).regular_iqd);
          return option && color && price !== null && regular !== null ? [{ option, color, price, regular_price: regular }] : [];
        })
      : [];

  const modes = asRec(body.pricing_modes);
  const direct = asRec(modes.direct);
  const cond = asRec(product.condition);
  const conditionKind = cond.kind === 'open_box' || cond.kind === 'used' || cond.kind === 'refurbished' ? cond.kind : null;
  const grades = ['like_new', 'excellent', 'good', 'fair'];
  const media = asList(product.media);
  const images = [...media.filter((m) => m.primary), ...media.filter((m) => !m.primary)]
    .map((m) => imageFromMedia(m, urls))
    .filter((m): m is NonNullable<typeof m> => !!m);
  const rating = asRec(body.rating);
  const guide = asRec(product.usage_guide);

  return {
    slug,
    kind: 'product' as const,
    name: localized(product.name_ar, product.name_en, product.name_ckb),
    description: localized(product.description_ar, product.description_en, product.description_ckb),
    url: urls.web(`/product/${encodeURIComponent(slug)}`),
    api_url: urls.api(`/products/${encodeURIComponent(slug)}`),
    reviews_url: urls.api(`/products/${encodeURIComponent(slug)}/reviews`),
    brand: body.brand ? brandRef({ ...(body.brand as { id: string; name_ar: string; name_en: string; name_ckb: string }), slug: String(asRec(body.brand).slug ?? '') }, urls) : null,
    sections: sections.filter((s): s is NonNullable<typeof s> => !!s),
    images,
    light_image: urls.media(product.light_image),
    price: priceFromCard(product),
    availability: availabilityFromSale(asRec(body.availability), product.sale_types),
    offer: offerFromCard(product),
    purchase: {
      direct_sale: int(direct.unit_subtotal_iqd),
      pre_order: asList(modes.preorder)
        .filter((p) => p.method === 'air' || p.method === 'sea' || p.method === 'land')
        .map((p) => ({
          method: p.method as 'air' | 'sea' | 'land',
          prepaid: int(asRec(p.prepaid).unit_subtotal_iqd),
          cash_on_delivery: int(asRec(p.cod).unit_subtotal_iqd),
        })),
    },
    options,
    colors,
    combinations,
    specifications: asList(product.spec_groups).map((g) => ({
      title: localized(g.title_ar, g.title_en, g.title_ckb),
      rows: asList(g.rows).map((r) => ({
        label: localized(r.label_ar, r.label_en, r.label_ckb),
        value: localized(r.value_ar, r.value_en, r.value_ckb),
        unit: typeof r.unit === 'string' ? r.unit : '',
      })),
    })),
    dimensions: dimensionsOf(product.dimensions),
    labels: asList(product.labels).map((l) => localized(l.text_ar, l.text_en, l.text_ckb)),
    condition: conditionKind
      ? {
          kind: conditionKind as 'open_box' | 'used' | 'refurbished',
          grade: typeof cond.grade === 'string' && grades.includes(cond.grade) ? (cond.grade as string) : null,
          usage_hours: int(cond.usage_hours),
          warranty_months: int(cond.warranty_months),
          fault: localized(cond.fault_ar, cond.fault_en, cond.fault_ckb),
          repair: localized(cond.repair_ar, cond.repair_en, cond.repair_ckb),
          notes: localized(cond.notes_ar, cond.notes_en, cond.notes_ckb),
          images: (Array.isArray(cond.unit_images) ? cond.unit_images : [])
            .map((u) => imageFromUrl(u, urls))
            .filter((m): m is NonNullable<typeof m> => !!m),
          new_price_reference: int(asRec(body.condition_reference).reference_iqd),
        }
      : null,
    warranty: {
      base_months: int(product.warranty_base_months),
      plans: asList(product.warranty_plans).map((w) => ({
        title: localized(w.title_ar, w.title_en, w.title_ckb),
        terms: localized(w.terms_ar, w.terms_en, w.terms_ckb),
        months: int(w.duration_months) ?? 0,
        kind: (w.duration_kind === 'extension' ? 'extension' : 'total') as 'total' | 'extension',
        price: int(w.fee_iqd),
      })),
    },
    rating: { average: typeof rating.average === 'number' ? rating.average : null, count: int(rating.count) ?? 0 },
    fits_printers: asList(body.fits_printers).map((p) => ({
      slug: String(p.slug ?? ''),
      name: localized(p.name_ar, p.name, p.name_ckb),
      url: urls.web(`/product/${encodeURIComponent(String(p.slug ?? ''))}`),
      api_url: urls.api(`/products/${encodeURIComponent(String(p.slug ?? ''))}`),
    })),
    content: asList(product.content_blocks).map((b) => ({
      kind: (b.kind === 'image' ? 'image' : b.kind === 'video_embed' ? 'video' : 'text') as 'text' | 'image' | 'video',
      text: localized(b.body_ar, b.body_en, b.body_ckb),
      caption: localized(b.caption_ar, b.caption_en, b.caption_ckb),
      url: b.kind === 'image' ? urls.media(b.url) : b.kind === 'video_embed' ? httpsOrNull(b.url) : null,
    })),
    usage_guide: {
      official_url: httpsOrNull(guide.official_url),
      steps: asList(guide.steps).map((s) => ({
        kind: (s.kind === 'setup' ? 'setup' : 'usage') as 'setup' | 'usage',
        title: localized(s.title_ar, s.title, s.title_ckb),
        body: localized(s.body_ar, s.body, s.body_ckb),
        images: (Array.isArray(s.images) ? s.images : []).map((u) => urls.media(u) ?? httpsOrNull(u)).filter((u): u is string => !!u),
        video_url: httpsOrNull(s.video_url),
        link_url: httpsOrNull(s.link_url),
      })),
    },
    created_at: isoOrNull(product.created_at),
  };
}

async function activeProductRow(db: D1Database, slug: string): Promise<Rec> {
  const row = await db
    .prepare(`SELECT * FROM products WHERE slug = ? AND ${(await listing(db)).listed('products')}`)
    .bind(slug)
    .first<Rec>();
  if (!row) throw notFound('Product not found');
  if (String(row.composition ?? '') !== '') {
    // A bundle or a mystery box is a product row too; its page is its own.
    throw new HttpError(404, 'This slug is a bundle; read it from /bundles/{slug}.', 'IS_BUNDLE', {
      bundle_path: `/api/public/v1/bundles/${slug}`,
    });
  }
  return row;
}

async function getProduct(req: PublicRequest) {
  const { db, urls } = req;
  const slug = req.path.slug;
  const row = await activeProductRow(db, slug);
  const parsed = parseProductRow(row);
  const [{ body }, idx] = await Promise.all([
    catalogProductDetail(db, row, parsed, pricingCtxForUser(db, null)),
    catalogIndexFor(db).catch(() => null),
  ]);
  // The brand block of the page carries no slug; one read on its primary key.
  if (body.brand) {
    const b = await db.prepare('SELECT slug FROM brands WHERE id = ?').bind(String(asRec(body.brand).id)).first<{ slug: string }>();
    body.brand = b ? { ...asRec(body.brand), slug: b.slug } : null;
  }
  const leaf = parsed.sub_category_id || parsed.category_id;
  const sections = leaf && idx?.byId.has(leaf) ? idx.branch(leaf).slice().reverse().map((r) => sectionRef(idx, r.id, urls)) : [];
  return {
    data: productDetailDto(body, row, sections, urls),
    web: urls.web(`/product/${encodeURIComponent(slug)}`),
  };
}

// ------------------------------------------------------------ reviews

const REVIEW_SCHEMA = object(
  {
    rating: integer('Stars, 1–5.'),
    text: string('What the customer wrote; \'\' for a rating without words.'),
    reviewer: string('The reviewer as the site shows them — a masked name (e.g. «Ahmed K.»).'),
    verified_purchase: boolean('The reviewer bought the product through the site.'),
    incentivized: boolean('The reviewer received a reward for the review.'),
    automatic: boolean('An automatic rating the site records after a delivery the customer did not review.'),
    photo_count: integer('How many photos the customer attached (the photos themselves are not published through this API).'),
    created_at: nullable(dateTime()),
  },
  'One published customer review.'
);

const REVIEWS_SCHEMA = object(
  {
    product: object({ slug: string(), url: url(), api_url: url() }),
    average: nullable(number('1–5, one decimal; null with no reviews.')),
    count: integer('Published reviews in all.'),
    reviews: array(ref('Review')),
  },
  'A product\'s published reviews, newest first.'
);

async function productReviews(req: PublicRequest) {
  const { db, urls, query } = req;
  const slug = req.path.slug;
  const product = await db
    .prepare(`SELECT id, slug FROM products WHERE slug = ? AND ${(await listing(db)).listed('products')}`)
    .bind(slug)
    .first<{ id: string; slug: string }>();
  if (!product) throw notFound('Product not found');
  const limit = parseLimit(query.limit, 20);
  const offset = decodeCursor(query.cursor);
  const [summary, list] = await Promise.all([
    db
      .prepare("SELECT COUNT(*) AS n, AVG(stars) AS avg_stars FROM reviews WHERE product_id = ? AND status = 'published'")
      .bind(product.id)
      .first<{ n: number; avg_stars: number | null }>(),
    db
      .prepare(
        `SELECT r.stars, r.body, r.media, r.created_at, r.order_id, r.source, u.name, u.username,
                (SELECT 1 FROM review_rewards rr WHERE rr.review_id = r.id AND rr.state = 'approved' LIMIT 1) AS has_reward
           FROM reviews r JOIN users u ON u.id = r.user_id
          WHERE r.product_id = ? AND r.status = 'published'
          ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`
      )
      .bind(product.id, limit, offset)
      .all<Rec>(),
  ]);
  const count = Number(summary?.n) || 0;
  const reviews = (list.results ?? []).map((r) => {
    const system = (r.source ?? 'user') === 'system';
    let photos = 0;
    try {
      const parsed = JSON.parse(String(r.media ?? '[]'));
      photos = Array.isArray(parsed) ? parsed.length : 0;
    } catch {
      photos = 0;
    }
    return {
      rating: Math.min(5, Math.max(1, int(r.stars) ?? 5)),
      text: typeof r.body === 'string' ? r.body : '',
      reviewer: system ? 'Levonis' : maskName(r.name as string | null, r.username as string | null),
      verified_purchase: !!r.order_id,
      incentivized: !!r.has_reward,
      automatic: system,
      photo_count: photos,
      created_at: isoOrNull(r.created_at),
    };
  });
  return {
    data: {
      product: {
        slug: product.slug,
        url: urls.web(`/product/${encodeURIComponent(product.slug)}`),
        api_url: urls.api(`/products/${encodeURIComponent(product.slug)}`),
      },
      average: summary?.avg_stars != null ? Math.round(Number(summary.avg_stars) * 10) / 10 : null,
      count,
      reviews,
    },
    pagination: pageFromSource(limit, offset, reviews.length, count),
    web: urls.web(`/product/${encodeURIComponent(product.slug)}`),
  };
}

// ------------------------------------------------------------ routes

export const PRODUCT_COMPONENTS: Record<string, JsonSchema> = {
  Product: PRODUCT_SCHEMA,
  ProductOption: OPTION_SCHEMA,
  ProductColor: COLOR_SCHEMA,
  Review: REVIEW_SCHEMA,
  ProductReviews: REVIEWS_SCHEMA,
};

export const PRODUCT_ROUTES: PublicRoute[] = [
  {
    operationId: 'listProducts',
    path: '/products',
    tag: 'Products',
    summary: 'List and search published products',
    description:
      'Published catalogue products with the prices a signed-out visitor sees. Filter by section, brand, price and availability; sort; search with `q` (Arabic, English or Kurdish, typo-tolerant — the site\'s own search). Bundles appear only in search results; list them with /bundles.',
    params: [
      { name: 'q', in: 'query', description: 'Search text, as typed into the site\'s search box.', schema: { type: 'string', maxLength: 100 }, example: 'bambu' },
      { name: 'section', in: 'query', description: 'A section slug (see /sections); includes everything filed below it.', schema: { type: 'string', maxLength: 80 }, example: 'printers' },
      { name: 'brand', in: 'query', description: 'One or more brand slugs, comma-separated (see /brands).', schema: { type: 'string', maxLength: 200 } },
      { name: 'min_price', in: 'query', description: 'Lowest price in IQD.', schema: { type: 'integer', minimum: 0, maximum: 1_000_000_000 } },
      { name: 'max_price', in: 'query', description: 'Highest price in IQD.', schema: { type: 'integer', minimum: 0, maximum: 1_000_000_000 } },
      { name: 'available', in: 'query', description: '1 = only what can be bought now from stock.', schema: { type: 'string', enum: ['1'] } },
      { name: 'sale', in: 'query', description: 'direct = sold from stock; preorder = can be pre-ordered.', schema: { type: 'string', enum: [...SALE_FILTERS] } },
      { name: 'offer', in: 'query', description: '1 = only products with a time-limited offer.', schema: { type: 'string', enum: ['1'] } },
      { name: 'sort', in: 'query', description: 'relevance (default), newest, price_asc, price_desc, name, available, direct.', schema: { type: 'string', enum: [...LISTING_SORTS] } },
      LIMIT_PARAM,
      CURSOR_PARAM,
    ],
    data: array(ref('ProductCard')),
    paginated: true,
    maxAge: 120,
    example: '/products?section=printers&sort=price_asc&limit=10',
    handler: listProducts,
  },
  {
    operationId: 'getProduct',
    path: '/products/{slug}',
    tag: 'Products',
    summary: 'One product with its prices, options, colours, pictures and specifications',
    description:
      'Everything the product page shows a signed-out visitor: names and description in three languages, every original picture, the price of every option, colour and combination, availability, pre-order prices, specifications, warranty plans, condition report for used units, review summary and the printers a part fits.',
    params: [SLUG_PARAM],
    data: ref('Product'),
    maxAge: 120,
    example: '/products/{slug}',
    handler: getProduct,
  },
  {
    operationId: 'listProductReviews',
    path: '/products/{slug}/reviews',
    tag: 'Products',
    summary: 'A product\'s published reviews',
    description:
      'Published customer reviews, newest first, with the reviewer masked exactly as the site shows it. Automatic ratings the site records after a delivery are flagged `automatic`.',
    params: [SLUG_PARAM, LIMIT_PARAM, CURSOR_PARAM],
    data: ref('ProductReviews'),
    paginated: true,
    maxAge: 300,
    example: '/products/{slug}/reviews',
    handler: productReviews,
  },
];
