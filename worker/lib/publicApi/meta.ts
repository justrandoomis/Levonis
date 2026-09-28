/**
 * THE API DESCRIBING ITSELF — `/` (an index), `/context` (for an AI agent)
 * and `/openapi.json` (for any client), all generated from the one route list
 * (./registry.ts), so none of the three can describe an endpoint that does
 * not exist or miss one that does.
 */
import { readCommunityGate, communityMayEnter } from '../communityGate';
import { POLICY_DOCUMENTS } from '../policies';
import { PLATFORM_NAME } from '../webManifest';
import { RESOURCE_COMPONENTS, RESOURCE_ROUTES } from './registry';
import { MAX_LIMIT, DEFAULT_LIMIT } from './paging';
import { API_PREFIX, type PublicUrls } from './urls';
import { array, boolean, enumOf, integer, nullable, object, ref, string, url, type JsonSchema } from './schema';
import type { ParamSpec, PublicRequest, PublicRoute } from './types';

export const API_VERSION = 'v1';
export const OPENAPI_VERSION = '1.0.0';

/** The limiter's allowance, as /context and the 429 state it (worker/routes/publicApi.ts). */
export const RATE_LIMIT = { requests: 240, per_seconds: 60 } as const;

// ------------------------------------------------------------ envelope

const PAGINATION_SCHEMA = object(
  {
    limit: integer('Items per page.'),
    next_cursor: nullable(string('Pass as `cursor` for the next page; null on the last page.')),
    total: nullable(integer('Matching items in all, when known.')),
  },
  'Where this page is in the list.'
);

const META_SCHEMA = object(
  {
    version: enumOf([API_VERSION]),
    pagination: nullable(ref('Pagination')),
  },
  'About this answer.'
);

const LINKS_SCHEMA = object(
  {
    self: url('This answer, canonically.'),
    next: nullable(url('The next page; null when there is none.')),
    web: nullable(url('The page on the website this answer describes.')),
  },
  'Links.'
);

const ERROR_SCHEMA: JsonSchema = {
  type: 'object',
  description: 'An error. `code` is stable and machine-readable; `error` is a human sentence.',
  properties: {
    success: { type: 'boolean', enum: [false] },
    error: { type: 'string' },
    code: { type: 'string', description: 'e.g. NOT_FOUND, BAD_PARAM, INVALID_CURSOR, RATE_LIMITED, METHOD_NOT_ALLOWED, IS_BUNDLE.' },
    details: { type: 'object', description: 'Machine-readable context (e.g. `param`, `retry_after_seconds`).' },
  },
  required: ['success', 'error'],
};

function envelopeSchema(route: PublicRoute): JsonSchema {
  return object({ data: route.data, meta: ref('Meta'), links: ref('Links') }, 'Every answer: the data, about the answer, and links.');
}

// ------------------------------------------------------------ openapi.json

function openApiPath(route: PublicRoute) {
  const parameters = (route.params ?? []).map((p: ParamSpec) => ({
    name: p.name,
    in: p.in,
    required: p.in === 'path' ? true : !!p.required,
    description: p.description,
    schema: p.schema,
    ...(p.example ? { example: p.example } : {}),
  }));
  const errors = {
    '400': { $ref: '#/components/responses/BadRequest' },
    '404': { $ref: '#/components/responses/NotFound' },
    '429': { $ref: '#/components/responses/RateLimited' },
  };
  return {
    get: {
      operationId: route.operationId,
      tags: [route.tag],
      summary: route.summary,
      description: route.description,
      parameters,
      responses: {
        '200': {
          description: route.summary,
          headers: {
            ETag: { description: 'Send it back as If-None-Match to get a 304 when nothing changed.', schema: { type: 'string' } },
            'Cache-Control': { description: 'How long the answer may be reused.', schema: { type: 'string' } },
          },
          content: { 'application/json': { schema: route.raw ? route.data : envelopeSchema(route) } },
        },
        '304': { description: 'Not modified (after If-None-Match).' },
        ...errors,
      },
    },
  };
}

export function buildOpenApi(routes: readonly PublicRoute[], urls: PublicUrls) {
  const tags = [...new Set(routes.map((r) => r.tag))];
  const errorResponse = (description: string) => ({
    description,
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  });
  return {
    openapi: '3.1.0',
    info: {
      title: `${PLATFORM_NAME} Public API`,
      version: OPENAPI_VERSION,
      summary: 'Read-only access to everything a signed-out visitor can see on the Levonis 3D printing store.',
      description: [
        'Levonis (levonis-iq.com) is a 3D printing store in Iraq: printers, filament, resin, parts, accessories, bundles and made-to-order prints.',
        'This API returns exactly what a signed-out visitor sees on the website — products, prices, pictures, sections, brands, offers, bundles, policies, FAQ, banners and pages — and nothing else: no account, order, customer, admin, cost or supplier data.',
        'It is read-only (GET/HEAD), needs no key, and every text is given in Arabic, English and Central Kurdish. Start with /context.',
      ].join('\n\n'),
      contact: { name: 'Levonis support', url: urls.web('/support') },
    },
    servers: [{ url: `${urls.origin}${API_PREFIX}` }],
    tags: tags.map((t) => ({ name: t })),
    paths: Object.fromEntries(routes.map((r) => [r.path, openApiPath(r)])),
    components: {
      schemas: {
        ...RESOURCE_COMPONENTS,
        Pagination: PAGINATION_SCHEMA,
        Meta: META_SCHEMA,
        Links: LINKS_SCHEMA,
        Error: ERROR_SCHEMA,
      },
      responses: {
        BadRequest: errorResponse('A parameter is not valid (`details.param` names it).'),
        NotFound: errorResponse('There is no such item, or it is not public.'),
        RateLimited: {
          ...errorResponse('Too many uncached requests; wait `Retry-After` seconds.'),
          headers: { 'Retry-After': { schema: { type: 'integer' } } },
        },
      },
    },
  };
}

// ------------------------------------------------------------ context

const CONTEXT_SCHEMA: JsonSchema = { type: 'object', description: 'A plain description of the API for an AI agent (see the endpoint description).' };

async function contextDocument(routes: readonly PublicRoute[], req: PublicRequest) {
  const { db, urls } = req;
  const [counts, gate] = await Promise.all([
    db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM products WHERE status = 'active' AND composition = '') AS products,
           (SELECT COUNT(*) FROM products WHERE status = 'active' AND composition <> '') AS bundles,
           (SELECT COUNT(*) FROM catalogs WHERE active = 1) AS sections,
           (SELECT COUNT(*) FROM brands WHERE active = 1) AS brands`
      )
      .first<{ products: number; bundles: number; sections: number; brands: number }>()
      .catch(() => null),
    readCommunityGate(db).catch(() => null),
  ]);
  const byTag = new Map<string, PublicRoute[]>();
  for (const r of routes) byTag.set(r.tag, [...(byTag.get(r.tag) ?? []), r]);
  const exampleUrl = (r: PublicRoute) => (r.example && !r.example.includes('{') ? urls.api(r.example) : null);
  return {
    name: `${PLATFORM_NAME} Public API`,
    version: API_VERSION,
    purpose:
      'Read-only access to the public content of levonis-iq.com — a 3D printing store in Iraq, and Levo Community, its marketplace of independent printing shops — at exactly the level of a signed-out visitor. Use it to browse the catalogue and the shops, read prices, download product pictures, and answer questions about the shop and its policies.',
    website: urls.web('/'),
    base_url: `${urls.origin}${API_PREFIX}`,
    openapi_url: urls.api('/openapi.json'),
    access: {
      authentication: 'none',
      methods: ['GET', 'HEAD'],
      scope:
        'Exactly what a signed-out visitor sees. Never: accounts, customers, orders, carts, wallets, admin data, cost prices, suppliers, internal notes or stock ledgers. Sending cookies changes nothing.',
      cors: 'Any origin may read it from a browser (Access-Control-Allow-Origin: *), without credentials.',
    },
    conventions: {
      envelope:
        'Every endpoint except /, /context and /openapi.json answers { "data": …, "meta": { "version", "pagination" }, "links": { "self", "next", "web" } }.',
      languages:
        'Texts are objects { "ar", "en", "ckb" } — Arabic (the source language), English and Central Kurdish (Sorani). A language is "" where the shop has not written that text; fall back to Arabic, then English.',
      currency: 'All prices are whole Iraqi dinars (IQD). Delivery is not included in product prices; see /site for delivery methods.',
      prices:
        'A price is what a signed-out customer pays for one unit today, offers applied. `member_price` is the PRO price the site advertises to visitors. Items marked members_only show no price to visitors.',
      identifiers:
        'Items are identified by their slug (a shop by the first label of its address, <slug>.levonis-iq.com). Every item carries `url` (its page on the website) and `api_url` (its full record here). Internal database identifiers are never published; a print request is identified by the reference in its public web address.',
      pagination: `Lists take \`limit\` (1–${MAX_LIMIT}, default ${DEFAULT_LIMIT}) and \`cursor\`. Follow \`links.next\` until it is null.`,
      images:
        'Picture URLs are absolute and point at the original files (WebP) — the highest quality the site stores. Download them directly; they are public and cached for a year.',
      errors:
        'Errors are { "success": false, "error": "…", "code": "…", "details"?: {…} } with the HTTP status (400, 404, 405, 429). While Levo Community is closed to visitors, /community/* answers 503 with code COMMUNITY_CLOSED; a suspended shop answers 404 STORE_UNAVAILABLE.',
      caching: 'Answers carry Cache-Control and a weak ETag; send If-None-Match to get a 304. Data is at most a few minutes old.',
      rate_limits: `About ${RATE_LIMIT.requests} uncached requests per ${RATE_LIMIT.per_seconds} seconds per IP address. Over it: HTTP 429 with Retry-After. Cached answers are not counted.`,
    },
    start_here: [
      { step: 'What the shop is, its languages, currency, delivery and payment methods', request: urls.api('/site') },
      { step: 'How the catalogue is organised', request: urls.api('/sections') },
      { step: 'Browse products (filter by section, brand, price; sort)', request: urls.api('/products?limit=24') },
      { step: 'Search', request: urls.api('/search?q=printer') },
      { step: 'Everything about one product', request: `${urls.api('/products')}/{slug}` },
      { step: 'Policies and FAQ', request: urls.api('/faq') },
      { step: 'Levo Community — the independent shops and the print-request board (when open)', request: urls.api('/community') },
    ],
    content: {
      products: counts ? Number(counts.products) || 0 : null,
      bundles_and_mystery_boxes: counts ? Number(counts.bundles) || 0 : null,
      sections: counts ? Number(counts.sections) || 0 : null,
      brands: counts ? Number(counts.brands) || 0 : null,
      policies: POLICY_DOCUMENTS.length,
      community_open_to_visitors: gate ? communityMayEnter(gate, null) : false,
    },
    resources: [...byTag.entries()].map(([tag, list]) => ({
      name: tag,
      endpoints: list.map((r) => ({
        method: 'GET',
        path: r.path,
        url: `${urls.origin}${API_PREFIX}${r.path}`,
        summary: r.summary,
        description: r.description,
        parameters: (r.params ?? []).map((p) => ({ name: p.name, in: p.in, required: p.in === 'path' || !!p.required, description: p.description })),
        paginated: !!r.paginated,
        example: exampleUrl(r),
      })),
    })),
  };
}

// ------------------------------------------------------------ the three meta routes

const INDEX_SCHEMA = object(
  {
    name: string(),
    description: string(),
    version: enumOf([API_VERSION]),
    context_url: url('Start here: what the API offers and how to use it.'),
    openapi_url: url('The OpenAPI 3.1 description.'),
    website: url(),
    read_only: boolean(),
    endpoints: array(url()),
  },
  'The API\'s front door.'
);

function metaRoutes(all: () => readonly PublicRoute[]): PublicRoute[] {
  return [
    {
      operationId: 'getIndex',
      path: '/',
      tag: 'API',
      summary: 'The API\'s front door',
      description: 'Where to start: links to /context and /openapi.json.',
      data: INDEX_SCHEMA,
      raw: true,
      maxAge: 3600,
      example: '/',
      handler: async ({ urls }) => ({
        data: {
          name: `${PLATFORM_NAME} Public API`,
          description: 'Read-only access to everything a signed-out visitor can see on levonis-iq.com.',
          version: API_VERSION,
          context_url: urls.api('/context'),
          openapi_url: urls.api('/openapi.json'),
          website: urls.web('/'),
          read_only: true,
          endpoints: all()
            .filter((r) => !r.path.includes('{'))
            .map((r) => `${urls.origin}${API_PREFIX}${r.path === '/' ? '' : r.path}`),
        },
      }),
    },
    {
      operationId: 'getContext',
      path: '/context',
      tag: 'API',
      summary: 'Everything an AI agent needs to use this API',
      description:
        'A plain-language map of the API for AI agents: what the site is, what the API covers and never covers, the conventions (languages, prices, identifiers, pagination, pictures, errors, caching, limits), where to start, the size of the catalogue, and every endpoint with an example.',
      data: CONTEXT_SCHEMA,
      raw: true,
      maxAge: 600,
      example: '/context',
      handler: async (req) => ({ data: await contextDocument(all(), req) }),
    },
    {
      operationId: 'getOpenApi',
      path: '/openapi.json',
      tag: 'API',
      summary: 'The OpenAPI 3.1 description of this API',
      description: 'Every endpoint, parameter and field, with descriptions — for code generators and AI agents.',
      data: { type: 'object', description: 'An OpenAPI 3.1 document.' },
      raw: true,
      maxAge: 3600,
      example: '/openapi.json',
      handler: async ({ urls }) => ({ data: buildOpenApi(all(), urls) }),
    },
  ];
}

export const ALL_ROUTES: readonly PublicRoute[] = (() => {
  const list: PublicRoute[] = [];
  list.push(...metaRoutes(() => list), ...RESOURCE_ROUTES);
  return list;
})();
