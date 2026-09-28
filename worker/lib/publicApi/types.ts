/**
 * THE PUBLIC API'S ROUTE CONTRACT (worker/routes/publicApi.ts).
 *
 * Every endpoint is ONE `PublicRoute` value, and three things are generated
 * from the same list: the router that serves it, `/openapi.json` that
 * documents it, and `/context` that introduces it to an AI agent. An endpoint
 * cannot be served without being documented, or documented without existing
 * (tests/publicApi.test.ts walks the list against the live router).
 */
import type { Context } from 'hono';
import type { AppContext } from '../types';
import type { JsonSchema } from './schema';
import type { PublicUrls } from './urls';

export interface ParamSpec {
  name: string;
  in: 'query' | 'path';
  description: string;
  /** string (maxLength / pattern / enum) or integer (minimum / maximum) — validated before the handler runs. */
  schema: JsonSchema;
  required?: boolean;
  example?: string;
}

export interface PublicRequest {
  c: Context<AppContext>;
  db: D1Database;
  urls: PublicUrls;
  /** Validated path parameters. */
  path: Record<string, string>;
  /** Validated query parameters — ONLY the declared ones; anything else was ignored. */
  query: Record<string, string>;
}

export interface Pagination {
  limit: number;
  next_cursor: string | null;
  /** How many items match in all, when the source knows; null when it does not. */
  total: number | null;
}

export interface PublicResult {
  data: unknown;
  pagination?: Pagination;
  /** The page on the website this answer describes, as an absolute URL. */
  web?: string | null;
}

export interface PublicRoute {
  operationId: string;
  /** OpenAPI-style, under /api/public/v1 — e.g. '/products/{slug}'. */
  path: string;
  tag: string;
  summary: string;
  description: string;
  params?: ParamSpec[];
  /** The schema of the envelope's `data`. */
  data: JsonSchema;
  paginated?: boolean;
  /** Shared-cache lifetime in seconds (`s-maxage`); browsers get at most 60. */
  maxAge: number;
  /** A ready-to-run example (path + query) for /context. */
  example?: string;
  /** The answer IS the document (/context, /openapi.json, the index) rather than an envelope around `data`. */
  raw?: boolean;
  handler: (req: PublicRequest) => Promise<PublicResult>;
}
