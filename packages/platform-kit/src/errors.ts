/**
 * The kit's error type. Carries the HTTP status and the machine code the
 * platform envelope `{success:false, error, code, details}` needs, so a service
 * can translate it exactly like the core's `HttpError` (`worker/lib/http.ts`).
 */
import type { PlatformErrorCode } from '@levonis/contracts/http/common';

export class KitError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: PlatformErrorCode | string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'KitError';
  }

  toBody(): { success: false; error: string; code: string; details?: Record<string, unknown> } {
    return this.details ? { success: false, error: this.message, code: this.code, details: this.details } : { success: false, error: this.message, code: this.code };
  }
}

export const isKitError = (e: unknown): e is KitError => e instanceof KitError;

export const unauthorized = (msg = 'Authentication required') => new KitError(401, msg, 'UNAUTHORIZED');
export const forbidden = (msg = 'Not allowed', code = 'FORBIDDEN') => new KitError(403, msg, code);
export const notFound = (msg = 'Not found') => new KitError(404, msg, 'NOT_FOUND');
export const conflict = (msg: string, code = 'CONFLICT', details?: Record<string, unknown>) => new KitError(409, msg, code, details);
export const tooMany = (msg = 'Too many requests, try again later') => new KitError(429, msg, 'RATE_LIMITED');
export const notViaGateway = () => new KitError(403, 'Not via gateway', 'NOT_VIA_GATEWAY');
export const dependencyUnavailable = (dep: string) => new KitError(503, `Dependency unavailable: ${dep}`, 'DEPENDENCY_UNAVAILABLE', { dependency: dep });
export const idempotencyMismatch = () => new KitError(409, 'Idempotency key was already used with a different request', 'IDEMPOTENCY_MISMATCH');
export const idempotencyKeyInvalid = () => new KitError(400, 'Idempotency-Key must be at least 16 characters', 'IDEMPOTENCY_KEY_INVALID');
export const eventKeyReused = () => new KitError(409, 'Event key was already used by a different command', 'EVENT_KEY_REUSED');
export const contractViolation = (msg: string) => new KitError(400, msg, 'CONTRACT_VIOLATION');

/** Errors that mean "try again" for the RPC client and the bus. */
export class TransientError extends Error {
  readonly transient = true;
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'TransientError';
  }
}

export const isTransient = (e: unknown): boolean =>
  e instanceof TransientError || (typeof e === 'object' && e !== null && (e as { transient?: unknown }).transient === true);
