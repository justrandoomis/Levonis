/**
 * The platform-wide HTTP envelope (`01-TARGET.md` §3.10): `worker/lib/http.ts`
 * and `src/lib/api.ts` already agree on it; gateway-generated errors and every
 * `/api/v1/*` response use the same shape. Type-only — shared with the SPA.
 */
export interface ApiFailure {
  success: false;
  error: string;
  code?: string;
  details?: Record<string, unknown>;
}

export type ApiSuccess<T> = { success: true } & T;

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

/** Error codes the gateway and the platform kit emit in addition to today's. */
export type PlatformErrorCode =
  | 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'RATE_LIMITED' | 'NOT_CONFIGURED'
  | 'NOT_VIA_GATEWAY' | 'DEPENDENCY_UNAVAILABLE' | 'IDEMPOTENCY_MISMATCH' | 'IDEMPOTENCY_KEY_INVALID'
  | 'TURNSTILE_REQUIRED' | 'GONE' | 'EVENT_KEY_REUSED' | 'ORDER_SETTLING' | 'ORDER_PENDING_SETTLEMENT' | 'CONTRACT_VIOLATION';

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
export const CORRELATION_HEADER = 'x-correlation-id';
export const PRINCIPAL_HEADER = 'x-levonis-principal';
export const HOST_HEADER = 'x-levonis-host';
export const HOP_HEADER = 'x-levonis-hop';
export const HEALTH_PROBE_HEADER = 'x-health-probe';
export const LEGACY_PATH_HEADER = 'x-levonis-legacy-path';
export const VERSION_HEADER = 'x-levonis-ver';
