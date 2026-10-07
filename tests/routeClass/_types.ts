/**
 * THE ROUTE CLASSIFICATION VOCABULARY — owner decision 2, security spec §7,
 * master plan §4.0 "Route classification", critique A3. Step S1.
 *
 * Every `/api/admin/*` mount of worker/index.ts has a file in this folder that
 * classifies every one of its routes (tests/costRouteClassification.test.ts
 * fails on a mount without one, on a route without a class, and on a class
 * for a route that no longer exists). A router a later step adds brings its
 * own file.
 *
 *   cost_read / cost_write  cost data: every caller but the owner is refused at
 *                           the guard with 403 COST_ACCESS_DENIED — the same
 *                           body for a real and an invented id, whatever the
 *                           query string says
 *   money                   moves money or shows money figures: an assistant is
 *                           refused (403, FINANCIAL_SCOPE_REQUIRED unless the
 *                           route says otherwise), a full admin is not
 *   owner                   the owner's act alone (investor contracts, owner
 *                           receipts): every other admin is refused
 *   op                      catalogue and operations, any admin; whatever cost
 *                           the route touches is stripped from a non-owner's
 *                           answer (the GET and write sweeps prove it)
 *   open                    no admin needed
 *
 * WRITES (critique A3). Every non-GET `op`/`open` route either names one VALID
 * body for the write sweep (`body`, which the owner's call must accept), or
 * says why the empty body is enough (`noBody`, or the mount's `writes`
 * reason). The empty body runs for every route regardless, so every
 * validation refusal is walked for leaks too.
 */
import type { Hono } from 'hono';
import type { AppContext } from '../../worker/lib/types';

export type RouteClass = 'cost_read' | 'cost_write' | 'money' | 'owner' | 'op' | 'open';

export interface RouteRule {
  cls: RouteClass;
  /**
   * The refusal a non-owner (cost, owner) or an assistant (money) gets, when it
   * is not the class's default. The one cost exception is the incoming
   * profit preview, which keeps its 404 (master plan C2).
   */
  refusal?: { status: number; code?: string };
  /** The concrete path to call, when the route needs a real id the generic filler does not give. */
  path?: string;
  /** One valid request body for the write sweep; the owner's call must succeed with it. */
  body?: unknown;
  /** Why this write needs no valid body in the sweep. */
  noBody?: string;
  /** Anything a reviewer should know about the class. */
  why?: string;
}

export type RouteSpec = RouteClass | RouteRule;

export interface MountClass {
  /** The prefix worker/index.ts mounts the router on. */
  prefix: string;
  /** The router's exported name, exactly as worker/index.ts imports it. */
  name: string;
  router: Hono<AppContext>;
  /** The default reason for this mount's `op` writes that carry no `body`. */
  writes?: string;
  /** `METHOD /path` exactly as the router declares it → its class. */
  routes: Readonly<Record<string, RouteSpec>>;
}

export interface RouteClassFile {
  family: string;
  mounts: readonly MountClass[];
}

export const ruleOf = (spec: RouteSpec): RouteRule => (typeof spec === 'string' ? { cls: spec } : spec);

/**
 * The reasons a write needs no valid body in the sweep. Each is a statement
 * about what the route TOUCHES, so a reviewer can check it against the handler.
 */
export const NB = {
  CATALOGUE:
    'catalogue structure only (names, slugs, images, order, visibility, facets, vocabulary); no cost, lot or price-history column is read or answered',
  MEDIA: 'media objects and their references; no cost column is read or answered',
  MODERATION: 'community moderation and support state (status, badges, messages); no product cost is read',
  ORDER_FLOW:
    'order status, stages, delivery and documents; answers the order’s public fields — its cost lines and COGS are read only by the finance routers (classified cost_read)',
  SETTINGS: 'settings documents of the shop (home, ads, farm, warranty, membership rules); cost settings are refused per key (classified in admin.ts PUT /settings/:key)',
  QUICK_BUY: 'quick-buy session state; answers the session, never a cost',
  REFUSED_FIRST:
    'the handler refuses before it reads the body for every caller the sweep runs (no seeded row in the state it needs); the refusal is walked',
  OWNER_ACT: 'refused to every non-owner before the body is read',
} as const;
