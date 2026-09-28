/**
 * THE PUBLIC READ-ONLY API — `/api/public/v1/*` (owner, 2026-09-28: «Public
 * Read-Only API متكامل … بنفس مستوى وصول الزائر العادي غير المسجل، لا أكثر»).
 *
 * What it serves, and how each answer is built, lives in
 * worker/lib/publicApi/ (one route list → router, /openapi.json, /context).
 * This file is the door, and the door's rules are:
 *
 *   ANONYMOUS BY CONSTRUCTION. worker/index.ts never loads a session for this
 *   prefix, so no handler here can see a user even if one wanted to; every
 *   price is computed with the anonymous pricing context.
 *
 *   READ-ONLY. GET and HEAD (and the CORS preflight). Any other method is a
 *   405 with `Allow` — nothing under this prefix can change anything.
 *
 *   THE MAIN SITE ONLY. A merchant subdomain answers 404, as for the admin
 *   API: a store's hostname must not serve the platform's API under its name.
 *
 *   VALIDATED INPUT. Only the parameters an endpoint declares are read, each
 *   checked against its schema before the handler runs; anything else is
 *   ignored and cannot reach a query or the cache key.
 *
 *   CACHED AT THE EDGE, LIMITED AT THE DATABASE. Answers are the same for
 *   everyone, so they are cached per colo under their canonical URL; the
 *   rate limit counts only the requests that miss the cache and reach D1.
 *
 *   OPEN TO BROWSERS. `Access-Control-Allow-Origin: *` without credentials —
 *   the data is public and no cookie is ever read (docs/SECURITY.md §2).
 */
import { Hono, type Context } from 'hono';
import type { AppContext } from '../lib/types';
import { HttpError, requireMainHost } from '../lib/http';
import { rateLimit } from '../lib/ratelimit';
import { ALL_ROUTES, API_VERSION, RATE_LIMIT } from '../lib/publicApi/meta';
import { conditional, edgeCache, weakEtag } from '../lib/publicApi/cache';
import { API_PREFIX, publicUrls } from '../lib/publicApi/urls';
import type { ParamSpec, PublicRoute } from '../lib/publicApi/types';

export const publicApiRoutes = new Hono<AppContext>();

const ALLOW = 'GET, HEAD, OPTIONS';

publicApiRoutes.use('*', requireMainHost);

// Every answer, errors included: readable from any origin, never indexed as a page.
publicApiRoutes.use('*', async (c, next) => {
  await next();
  c.res.headers.set('Access-Control-Allow-Origin', '*');
  c.res.headers.set('Access-Control-Expose-Headers', 'ETag, Retry-After');
  c.res.headers.set('X-Robots-Tag', 'noindex');
});

publicApiRoutes.options('*', (c) =>
  c.body(null, 204, {
    'Access-Control-Allow-Methods': ALLOW,
    'Access-Control-Allow-Headers': 'Accept, Accept-Language, If-None-Match, Content-Type',
    'Access-Control-Max-Age': '86400',
  })
);

// ------------------------------------------------------------ input

const badParam = (name: string, why: string) =>
  new HttpError(400, `Invalid value for "${name}": ${why}.`, 'BAD_PARAM', { param: name });

function checkParam(p: ParamSpec, raw: string): string {
  const s = p.schema as { type?: string; minimum?: number; maximum?: number; maxLength?: number; minLength?: number; enum?: string[] };
  const value = raw.trim();
  if (s.type === 'integer') {
    if (!/^\d{1,12}$/.test(value)) throw badParam(p.name, 'expected a whole number');
    const n = Number(value);
    if (typeof s.minimum === 'number' && n < s.minimum) throw badParam(p.name, `at least ${s.minimum}`);
    if (typeof s.maximum === 'number' && n > s.maximum) throw badParam(p.name, `at most ${s.maximum}`);
    return String(n);
  }
  if (typeof s.maxLength === 'number' && value.length > s.maxLength) throw badParam(p.name, `at most ${s.maxLength} characters`);
  if (typeof s.minLength === 'number' && value.length < s.minLength) throw badParam(p.name, `at least ${s.minLength} characters`);
  if (Array.isArray(s.enum) && !s.enum.includes(value)) {
    if (p.in === 'path') throw new HttpError(404, 'Not found', 'NOT_FOUND');
    throw badParam(p.name, `one of ${s.enum.join(', ')}`);
  }
  return value;
}

function readInput(c: Context<AppContext>, route: PublicRoute) {
  const path: Record<string, string> = {};
  const query: Record<string, string> = {};
  for (const p of route.params ?? []) {
    if (p.in === 'path') {
      path[p.name] = checkParam(p, c.req.param(p.name) ?? '');
      continue;
    }
    const raw = c.req.query(p.name);
    if (raw === undefined || raw.trim() === '') {
      if (p.required) throw badParam(p.name, 'required');
      continue;
    }
    query[p.name] = checkParam(p, raw);
  }
  return { path, query };
}

/** The route's path with its parameters filled in. */
function concretePath(route: PublicRoute, path: Record<string, string>): string {
  return route.path.replace(/\{(\w+)\}/g, (_, name: string) => encodeURIComponent(path[name] ?? ''));
}

function canonicalUrl(origin: string, route: PublicRoute, path: Record<string, string>, query: Record<string, string>): string {
  const qs = Object.keys(query)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`)
    .join('&');
  const p = concretePath(route, path);
  return `${origin}${API_PREFIX}${p === '/' ? '' : p}${qs ? `?${qs}` : ''}`;
}

// ------------------------------------------------------------ serving

const tooMany = (c: Context<AppContext>) =>
  c.json(
    {
      success: false,
      error: 'Too many requests. Wait and try again; cached answers do not count.',
      code: 'RATE_LIMITED',
      details: { retry_after_seconds: RATE_LIMIT.per_seconds },
    },
    429,
    { 'Retry-After': String(RATE_LIMIT.per_seconds) }
  );

async function serve(c: Context<AppContext>, route: PublicRoute): Promise<Response> {
  const urls = publicUrls(c);
  const { path, query } = readInput(c, route);
  const self = canonicalUrl(urls.origin, route, path, query);
  const ifNoneMatch = c.req.header('If-None-Match');
  const cacheControl = `public, max-age=${Math.min(60, route.maxAge)}, s-maxage=${route.maxAge}`;
  const cache = edgeCache();
  const key = new Request(self, { method: 'GET' });

  if (cache) {
    const hit = await cache.match(key);
    if (hit) return conditional(hit, ifNoneMatch, cacheControl);
  }

  // A miss reaches the database: that is what the limit protects.
  try {
    await rateLimit(c, 'public-v1', 240, 60);
  } catch (e) {
    if (e instanceof HttpError && e.status === 429) return tooMany(c);
    throw e;
  }

  const result = await route.handler({ c, db: c.env.DB, urls, path, query });
  const body = route.raw
    ? result.data
    : {
        data: result.data,
        meta: { version: API_VERSION, pagination: result.pagination ?? null },
        links: {
          self,
          next: result.pagination?.next_cursor
            ? canonicalUrl(urls.origin, route, path, { ...query, cursor: result.pagination.next_cursor })
            : null,
          web: result.web ?? null,
        },
      };
  const text = JSON.stringify(body);
  const res = new Response(text, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cacheControl,
      ETag: await weakEtag(text),
    },
  });
  if (cache) {
    const put = cache.put(key, res.clone()).catch((err) => console.warn('public api cache put failed', err));
    try {
      c.executionCtx.waitUntil(put);
    } catch {
      await put;
    }
  }
  return conditional(res, ifNoneMatch, cacheControl);
}

for (const route of ALL_ROUTES) {
  publicApiRoutes.get(route.path.replace(/\{(\w+)\}/g, ':$1'), (c) => serve(c, route));
}

const INDEX = ALL_ROUTES.find((r) => r.path === '/');

// Anything else: an unknown path, or a method this API will never accept.
publicApiRoutes.all('*', (c) => {
  if (c.req.method === 'GET' || c.req.method === 'HEAD') {
    // `/api/public/v1/` is the front door too (the router matches it without the slash).
    if (INDEX && c.req.path === `${API_PREFIX}/`) return serve(c, INDEX);
    return c.json(
      { success: false, error: 'No such endpoint. See /api/public/v1/context.', code: 'NOT_FOUND' },
      404
    );
  }
  return c.json(
    { success: false, error: 'This API is read-only.', code: 'METHOD_NOT_ALLOWED', details: { allow: ALLOW } },
    405,
    { Allow: ALLOW }
  );
});

