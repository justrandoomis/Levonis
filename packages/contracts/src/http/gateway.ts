/**
 * `levonis-gateway` HTTP contract (`01-TARGET.md` §3.3, §3.10, §11.3).
 *
 * The gateway forwards almost everything; the shapes below are the responses it
 * generates ITSELF, so they are the only ones the SPA can receive without a
 * service having run. Type-only — `src/` imports these with `import type`.
 */
import type { ApiFailure, PlatformErrorCode } from './common';

/** Every prefix in the routing table resolves to exactly one of these targets. */
export type RouteTarget =
  | 'CORE' | 'IDENTITY' | 'CATALOG' | 'COMMERCE' | 'LEDGER' | 'SUBSCRIPTIONS' | 'REFERRALS'
  | 'REVIEWS' | 'MARKETPLACE' | 'CHAT' | 'NOTIFICATIONS' | 'FILES' | 'INVOICES' | 'DEVICES'
  | 'KYC' | 'POLICIES' | 'SUPPORT' | 'RISK' | 'INVEST' | 'FARM' | 'CONFIG' | 'ADMIN'
  | 'FULFILMENT' | 'AUDIT' | 'ANALYTICS' | 'ADS'
  /** `GET /api/v1/search` — additive from day one (`01-TARGET.md` §1.2 row 16, §3.3) */
  | 'SEARCH'
  /** the gateway answers itself (health, the four 410s) */
  | 'GATEWAY';

/** Which host classes a prefix is served on (`docs/SUBDOMAIN_ARCHITECTURE.md` §5). */
export type RouteHosts = 'main' | 'root' | 'all';

/** What a caller must prove before the gateway forwards (`01-TARGET.md` §3.5). */
export type RouteRequires = 'none' | 'auth' | 'investor' | 'admin' | 'admin:full';

/**
 * `ROUTE_OVERRIDES` kill switch: `"<prefix>=<target>,…"`, parsed into this.
 * Flipping a prefix back to `CORE` is a var change, not a deploy of new code.
 */
export interface RouteOverride {
  prefix: string;
  target: RouteTarget;
}

/** `GET /api/health?gw=1` — the gateway's own shallow health; never forwarded. */
export interface GatewayHealthResponse {
  success: true;
  status: 'ok';
  svc: 'gateway';
  ver: string;
}

/**
 * The four permanently removed endpoints (`worker/index.ts:193-196`). The
 * gateway answers them with the core's bodies verbatim, so a stale client sees
 * no change when the prefix flips.
 */
export type GoneEndpoint = '/api/d1/query' | '/api/d1/init' | '/api/make-all-investors' | '/api/upload';

export interface GoneResponse extends ApiFailure {
  success: false;
  /** `'This endpoint has been removed.'`, or `'Use POST /api/uploads.'` for `/api/upload` */
  error: string;
}

/** A gateway-generated refusal. `code` is always present, unlike some legacy core bodies. */
export interface GatewayErrorResponse extends ApiFailure {
  code: PlatformErrorCode;
}
