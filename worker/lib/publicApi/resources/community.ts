/**
 * LEVO COMMUNITY — the shops' products, the shop directory, the print-request
 * board and the workshops' finished work, exactly while a signed-out visitor
 * may see them.
 *
 * THE COMMUNITY HAS A DOOR (worker/lib/communityGate.ts). The owner closed it
 * for maintenance, and it stays closed to a visitor until the owner opens it
 * to everyone — the allow-list and the admin door are for signed-in people,
 * and this API never has one. So every endpoint below except `/community`
 * itself answers the site's own refusal while it is closed — HTTP 503,
 * `COMMUNITY_CLOSED` — and starts serving the moment it opens, with no deploy.
 * `/community` always answers, and says which it is.
 *
 * THE SITE'S OWN ROWS. The visibility rules are the community routes' own,
 * imported rather than restated (worker/routes/community.ts:
 * `communityProductsVisible`, `communityDirectoryVisible`,
 * `requestBoardVisible`, `communityWorks`): published products only, nothing
 * of a sanctioned shop, only requests on the public board. The API then
 * narrows further:
 *
 *   - only items that have a shop to open (a pre-store listing or a
 *     profile-only merchant has no page an agent could follow);
 *   - a print request never names its customer — not even masked — and never
 *     carries its private notes; it is identified by the reference in its
 *     public web address (`/requests/<reference>`), the only handle
 *     the board itself uses;
 *   - offset paging, so no cursor carries an internal id.
 */
import { communityClosedRefusal, communityMayEnter, readCommunityGate } from '../../communityGate';
import { membershipBadges } from '../../entitlements';
import { rootDomainFrom } from '../../hosts';
import { likePattern } from '../../sqlLike';
import { normalizeGovernorate } from '../../iraqGovernorates';
import { notFound } from '../../http';
import {
  COMMUNITY_DIRECTORY_COLUMNS,
  COMMUNITY_DIRECTORY_FROM,
  COMMUNITY_PRODUCTS_FROM,
  communityDirectoryVisible,
  communityProductsVisible,
  communityWorks,
  requestBoardVisible,
} from '../../../routes/community';
import { int, isoOrNull, num, type PublicImage } from '../common';
import { decodeCursor, pageFromSource, parseLimit } from '../paging';
import { array, boolean, dateTime, enumOf, integer, nullable, number, object, ref, string, url, type JsonSchema } from '../schema';
import type { PublicRequest, PublicResult, PublicRoute } from '../types';
import {
  CURSOR_PARAM,
  LIMIT_PARAM,
  STORE_PRODUCT_CARD_SCHEMA,
  governorate,
  merchantFile,
  storeProductCard,
  storeRef,
  storeSite,
} from './stores';

type Rec = Record<string, unknown>;

const text = (v: unknown, max = 4000): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Is the community open to a signed-out visitor right now? */
export async function communityOpenToVisitors(db: D1Database): Promise<boolean> {
  return communityMayEnter(await readCommunityGate(db), null);
}

/** The site's own refusal while it is not. */
async function requireOpen(db: D1Database): Promise<void> {
  if (!(await communityOpenToVisitors(db))) throw communityClosedRefusal();
}

const Q_PARAM = {
  name: 'q',
  in: 'query' as const,
  description: 'Search text (matched against names and descriptions, as the community page\'s own search).',
  schema: { type: 'string', maxLength: 100 },
};

// ------------------------------------------------------------ /community

const COMMUNITY_SCHEMA = object(
  {
    open: boolean(
      'Whether Levo Community is open to visitors. While false, /community/* answers 503 COMMUNITY_CLOSED; shops stay reachable by their own address (/stores/{slug}).'
    ),
    url: url('The community on the website.'),
    products_url: url(),
    stores_url: url(),
    requests_url: url(),
    works_url: url(),
  },
  'Levo Community: independent 3D-printing shops on Levonis, their products, and a board of custom print requests.'
);

async function community(req: PublicRequest): Promise<PublicResult> {
  const { db, urls } = req;
  const open = await communityOpenToVisitors(db);
  return {
    data: {
      open,
      url: urls.web('/community'),
      products_url: urls.api('/community/products'),
      stores_url: urls.api('/community/stores'),
      requests_url: urls.api('/community/requests'),
      works_url: urls.api('/community/works'),
    },
    web: urls.web('/community'),
  };
}

// ------------------------------------------------------------ products

const COMMUNITY_PRODUCT_SCHEMA = object(
  {
    ...(STORE_PRODUCT_CARD_SCHEMA.properties as Record<string, JsonSchema>),
    store: ref('StoreRef'),
  },
  'A product one of the community\'s shops publishes, with the shop that sells it.'
);

async function communityProducts(req: PublicRequest): Promise<PublicResult> {
  const { db, urls, query } = req;
  await requireOpen(db);
  const root = rootDomainFrom(req.c.env);
  const limit = parseLimit(query.limit);
  const offset = decodeCursor(query.cursor);
  const q = likePattern(query.q);
  const where = `${communityProductsVisible('?1')} AND s.id IS NOT NULL`;
  const [rows, total] = await Promise.all([
    db
      .prepare(
        `SELECT p.*, s.slug AS s_slug, s.name AS s_name, s.logo_key AS s_logo_key
           ${COMMUNITY_PRODUCTS_FROM}
          WHERE ${where}
          ORDER BY p.created_at DESC, p.id DESC LIMIT ?2 OFFSET ?3`
      )
      .bind(q, limit, offset)
      .all<Rec>(),
    db.prepare(`SELECT COUNT(*) AS n ${COMMUNITY_PRODUCTS_FROM} WHERE ${where}`).bind(q).first<{ n: number }>(),
  ]);
  const items = (rows.results ?? [])
    .filter((p) => typeof p.s_slug === 'string' && p.s_slug !== '')
    .map((p) => {
      const storeSlug = String(p.s_slug);
      return {
        ...storeProductCard(p, { slug: storeSlug, root }, urls),
        store: storeRef(urls, root, storeSlug, p.s_name, p.s_logo_key),
      };
    });
  return {
    data: items,
    pagination: pageFromSource(limit, offset, items.length, Number(total?.n ?? 0)),
    web: urls.web('/community'),
  };
}

// ------------------------------------------------------------ the shop directory

const STORE_SUMMARY_SCHEMA = object(
  {
    slug: string('The shop\'s identifier — see /stores/{slug}.'),
    name: string(),
    tagline: string(),
    logo: nullable(ref('Image')),
    governorate: nullable(ref('Governorate')),
    accepts_custom_requests: boolean(),
    verified: boolean('Verified by Levonis.'),
    pro_badge: boolean(),
    premium_badge: boolean(),
    badge: string('The shop\'s reputation badge.'),
    rating: nullable(number('Average review rating, 1–5.')),
    rating_count: integer(),
    completed_orders: integer(),
    followers: integer(),
    product_count: integer('Published products.'),
    url: url('The shop\'s own site.'),
    api_url: url('The shop in the public API.'),
  },
  'A shop in the community directory, with the trust signals its page shows.'
);

async function communityStores(req: PublicRequest): Promise<PublicResult> {
  const { db, urls, query } = req;
  await requireOpen(db);
  const root = rootDomainFrom(req.c.env);
  const limit = parseLimit(query.limit);
  const offset = decodeCursor(query.cursor);
  const q = likePattern(query.q);
  const where = `${communityDirectoryVisible('?1')} AND s.id IS NOT NULL AND COALESCE(s.slug, '') <> ''`;
  const [rows, total] = await Promise.all([
    db
      .prepare(
        `SELECT ${COMMUNITY_DIRECTORY_COLUMNS}
           ${COMMUNITY_DIRECTORY_FROM}
          WHERE ${where}
          ORDER BY cm.created_at DESC, cm.id DESC LIMIT ?2 OFFSET ?3`
      )
      .bind(q, limit, offset)
      .all<Rec>(),
    db.prepare(`SELECT COUNT(*) AS n ${COMMUNITY_DIRECTORY_FROM} WHERE ${where}`).bind(q).first<{ n: number }>(),
  ]);
  const list = rows.results ?? [];
  const badges = await membershipBadges(db, list.map((m) => m.user_id));
  const items = list.map((m) => {
    const slug = String(m.store_slug);
    const ratingCount = int(m.rating_count) ?? 0;
    return {
      slug,
      name: text(m.store_name, 200),
      tagline: text(m.store_tagline, 300),
      logo: storeRef(urls, root, slug, m.store_name, m.store_logo_key).logo,
      governorate: governorate(m.store_governorate),
      accepts_custom_requests: !!m.store_custom,
      verified: !!m.verified,
      pro_badge: badges.pro.has(String(m.user_id)),
      premium_badge: badges.premium.has(String(m.user_id)),
      badge: text(m.badge_override, 40) || text(m.badge, 40) || 'new',
      rating: ratingCount ? (num(m.rating_avg_x100) ?? 0) / 100 : null,
      rating_count: ratingCount,
      completed_orders: int(m.completed_orders) ?? 0,
      followers: int(m.followers) ?? 0,
      product_count: int(m.product_count) ?? 0,
      url: storeSite(urls, root, slug),
      api_url: urls.api(`/stores/${encodeURIComponent(slug)}`),
    };
  });
  return {
    data: items,
    pagination: pageFromSource(limit, offset, items.length, Number(total?.n ?? 0)),
    web: urls.web('/community'),
  };
}

// ------------------------------------------------------------ the request board

const REQUEST_STATES = ['open', 'receiving_offers'] as const;

const PRINT_REQUEST_SCHEMA = object(
  {
    reference: string('The request\'s reference — the one in its web address. The customer is never named.'),
    title: string(),
    description: string(),
    category: string(),
    quantity: nullable(integer()),
    material: string('As the customer wrote it or chose it.'),
    color: string(),
    dimensions: string(),
    budget_iqd: nullable(integer('The customer\'s budget, when they gave one.')),
    deadline: nullable(string('When they need it, as they stated it.')),
    governorate: nullable(ref('Governorate')),
    delivery_preference: string(),
    state: enumOf([...REQUEST_STATES], 'open: waiting for offers; receiving_offers: offers have arrived.'),
    offer_count: integer(),
    file_count: integer('Design files attached (only the customer and the shops they deal with can open them).'),
    created_at: nullable(dateTime()),
    expires_at: nullable(dateTime('When it leaves the board.')),
    url: url('The request on the website\'s board.'),
    api_url: url(),
  },
  'A custom print job a customer posted on the public board for shops to quote.'
);

const REQUEST_COLUMNS = `r.id, r.title, r.description, r.category, r.quantity, r.material, r.color, r.dimensions,
            r.budget_iqd, r.deadline, r.governorate, r.delivery_pref, r.state, r.offer_count, r.created_at, r.expires_at,
            (SELECT COUNT(*) FROM community_request_files f WHERE f.request_id = r.id) AS file_count`;

function printRequest(r: Rec, urls: PublicRequest['urls']) {
  const ref_ = String(r.id);
  return {
    reference: ref_,
    title: text(r.title, 200),
    description: text(r.description),
    category: text(r.category, 80),
    quantity: int(r.quantity),
    material: text(r.material, 80),
    color: text(r.color, 80),
    dimensions: text(r.dimensions, 200),
    budget_iqd: int(r.budget_iqd),
    deadline: text(r.deadline, 40) || null,
    governorate: governorate(r.governorate),
    delivery_preference: text(r.delivery_pref, 60),
    state: r.state === 'receiving_offers' ? ('receiving_offers' as const) : ('open' as const),
    offer_count: int(r.offer_count) ?? 0,
    file_count: int(r.file_count) ?? 0,
    created_at: isoOrNull(r.created_at),
    expires_at: isoOrNull(r.expires_at),
    url: urls.web(`/requests/${encodeURIComponent(ref_)}`),
    api_url: urls.api(`/community/requests/${encodeURIComponent(ref_)}`),
  };
}

async function communityRequests(req: PublicRequest): Promise<PublicResult> {
  const { db, urls, query } = req;
  await requireOpen(db);
  const limit = parseLimit(query.limit);
  const offset = decodeCursor(query.cursor);
  const q = likePattern(query.q);
  const gov = query.governorate ? normalizeGovernorate(query.governorate) || '\u0000' : '';
  const where = `${requestBoardVisible('?1', '?2')}
        AND (?3 = '' OR r.category = ?3)
        AND (?4 = '' OR r.governorate = ?4)`;
  const binds = [new Date().toISOString(), q, query.category ?? '', gov];
  const [rows, total] = await Promise.all([
    db
      .prepare(`SELECT ${REQUEST_COLUMNS} FROM community_requests r WHERE ${where} ORDER BY r.created_at DESC, r.id DESC LIMIT ?5 OFFSET ?6`)
      .bind(...binds, limit, offset)
      .all<Rec>(),
    db.prepare(`SELECT COUNT(*) AS n FROM community_requests r WHERE ${where}`).bind(...binds).first<{ n: number }>(),
  ]);
  const items = (rows.results ?? []).map((r) => printRequest(r, urls));
  return {
    data: items,
    pagination: pageFromSource(limit, offset, items.length, Number(total?.n ?? 0)),
    web: urls.web('/requests'),
  };
}

async function communityRequest(req: PublicRequest): Promise<PublicResult> {
  const { db, urls } = req;
  await requireOpen(db);
  // The same board rule, for one reference: a draft, a private, a closed or an
  // expired request is not public, whoever asks.
  const r = await db
    .prepare(`SELECT ${REQUEST_COLUMNS} FROM community_requests r WHERE r.id = ?3 AND ${requestBoardVisible('?1', '?2')}`)
    .bind(new Date().toISOString(), '', req.path.reference)
    .first<Rec>();
  if (!r) throw notFound('Request not found');
  const item = printRequest(r, urls);
  return { data: item, web: item.url };
}

// ------------------------------------------------------------ the workshops' work

const WORK_SCHEMA = object(
  {
    title: string(),
    details: string(),
    image: ref('Image'),
    store: ref('StoreRef'),
  },
  'A finished piece a shop shows from its workshop.'
);

async function communityWorkList(req: PublicRequest): Promise<PublicResult> {
  const { db, urls, query } = req;
  await requireOpen(db);
  const root = rootDomainFrom(req.c.env);
  const limit = parseLimit(query.limit, 12, 24);
  const rows = await communityWorks(db, limit);
  const items = rows
    .map((w) => {
      const href = typeof w.image_key === 'string' && w.image_key ? merchantFile(urls, `/files/${w.image_key}`) : null;
      if (!href || typeof w.store_slug !== 'string' || !w.store_slug) return null;
      const image: PublicImage = { url: href, width: null, height: null, alt: { ar: '', en: text(w.title, 200), ckb: '' } };
      return {
        title: text(w.title, 200),
        details: text(w.details),
        image,
        store: storeRef(urls, root, w.store_slug, w.store_name, w.store_logo_key),
      };
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
  return { data: items, web: urls.web('/community') };
}

// ------------------------------------------------------------ routes

export const COMMUNITY_COMPONENTS: Record<string, JsonSchema> = {
  Community: COMMUNITY_SCHEMA,
  CommunityProduct: COMMUNITY_PRODUCT_SCHEMA,
  StoreSummary: STORE_SUMMARY_SCHEMA,
  PrintRequest: PRINT_REQUEST_SCHEMA,
  Work: WORK_SCHEMA,
};

const CLOSED_NOTE = ' While the community is closed to visitors this answers 503 COMMUNITY_CLOSED (see /community).';

export const COMMUNITY_ROUTES: PublicRoute[] = [
  {
    operationId: 'getCommunity',
    path: '/community',
    tag: 'Community',
    summary: 'Whether Levo Community is open, and where its lists are',
    description:
      'Levo Community is the marketplace of independent 3D-printing shops on Levonis and its board of custom print requests. It can be closed for maintenance; this endpoint always answers and says whether its lists are public right now.',
    data: ref('Community'),
    maxAge: 60,
    handler: community,
  },
  {
    operationId: 'listCommunityProducts',
    path: '/community/products',
    tag: 'Community',
    summary: 'Products the community\'s shops publish',
    description: `Newest first across every shop, searchable, each with the shop that sells it.${CLOSED_NOTE}`,
    params: [Q_PARAM, LIMIT_PARAM, CURSOR_PARAM],
    data: array(ref('CommunityProduct')),
    paginated: true,
    maxAge: 60,
    example: '/community/products?limit=12',
    handler: communityProducts,
  },
  {
    operationId: 'listCommunityStores',
    path: '/community/stores',
    tag: 'Community',
    summary: 'The shop directory',
    description: `Every shop of the community, newest first, searchable, with its rating, completed orders, followers and product count.${CLOSED_NOTE}`,
    params: [Q_PARAM, LIMIT_PARAM, CURSOR_PARAM],
    data: array(ref('StoreSummary')),
    paginated: true,
    maxAge: 60,
    example: '/community/stores',
    handler: communityStores,
  },
  {
    operationId: 'listPrintRequests',
    path: '/community/requests',
    tag: 'Community',
    summary: 'The public board of custom print requests',
    description: `Jobs customers posted for shops to quote — still taking offers, newest first. The customer is never named.${CLOSED_NOTE}`,
    params: [
      Q_PARAM,
      { name: 'category', in: 'query', description: 'A request category, exactly.', schema: { type: 'string', maxLength: 60 } },
      { name: 'governorate', in: 'query', description: 'A governorate code (e.g. baghdad).', schema: { type: 'string', maxLength: 40 } },
      LIMIT_PARAM,
      CURSOR_PARAM,
    ],
    data: array(ref('PrintRequest')),
    paginated: true,
    maxAge: 60,
    example: '/community/requests',
    handler: communityRequests,
  },
  {
    operationId: 'getPrintRequest',
    path: '/community/requests/{reference}',
    tag: 'Community',
    summary: 'One request on the board',
    description: `A request while it is on the public board; 404 once it is not (taken, expired, withdrawn or private).${CLOSED_NOTE}`,
    params: [
      {
        name: 'reference',
        in: 'path',
        required: true,
        description: 'The request\'s reference (see /community/requests).',
        schema: { type: 'string', maxLength: 60 },
      },
    ],
    data: ref('PrintRequest'),
    maxAge: 60,
    example: '/community/requests/{reference}',
    handler: communityRequest,
  },
  {
    operationId: 'listCommunityWorks',
    path: '/community/works',
    tag: 'Community',
    summary: 'Finished work from the shops\' workshops',
    description: `Pictures of finished pieces the shops show, newest first, at most three per shop.${CLOSED_NOTE}`,
    params: [
      { name: 'limit', in: 'query', description: 'How many, 1–24 (default 12).', schema: { type: 'integer', minimum: 1 } },
    ],
    data: array(ref('Work')),
    maxAge: 300,
    example: '/community/works',
    handler: communityWorkList,
  },
];
