/**
 * The domain types of `levonis-ads`, and the one adapter interface every
 * advertising platform sits behind (`01-TARGET.md` §9.1). Nothing outside
 * `src/providers/` knows a provider exists, and nothing in Orders or Checkout
 * imports any of it.
 *
 * It lives at the top of `src/` rather than inside `src/providers/` because
 * the store layer needs `ConsentState` too, and
 * `tests/serviceBoundaries.test.ts` forbids one package directory inside a
 * deployable from reaching into another's internals (ADR-004).
 *
 *   interface AdsProvider {
 *     readonly name;
 *     configured(env): boolean;
 *     map(event, consent): ProviderEvent | null;
 *     send(events, opts): Promise<{ accepted; rejected; error? }>;
 *   }
 *
 * `map` takes one extra argument the design leaves implicit: the provider's own
 * name for the event, which comes from the seeded `ads_event_map` row rather
 * than from the adapter, so renaming `Purchase` to something else is a data
 * change. Everything else is the signature as written.
 */
import type { EventEnvelope } from '@levonis/contracts/envelope';
import type { AdsProviderName } from '@levonis/contracts/http/ads';
import type { CircuitBreaker } from '@levonis/platform-kit/rpc';

export type { AdsProviderName };

/** The consent snapshot Ads keeps for a `user_hash` (`ads_consent_snapshots`). */
export interface ConsentState {
  user_hash: string;
  consent: 'none' | 'analytics' | 'ads';
  /** SHA-256 of the normalised email, present only while `consent === 'ads'` */
  email_hash: string | null;
  /** SHA-256 of the E.164 phone, present only while `consent === 'ads'` */
  phone_hash: string | null;
  first_ads_at: string | null;
}

/** A consent snapshot that grants nothing — the value used when Ads has never heard of a user_hash. */
export const NO_CONSENT: ConsentState = Object.freeze({
  user_hash: '',
  consent: 'none',
  email_hash: null,
  phone_hash: null,
  first_ads_at: null,
});

export const hasAdsConsent = (c: ConsentState | null | undefined): boolean => c?.consent === 'ads';

/** One mapped, provider-shaped event, ready to be sent or stored on a delivery row. */
export interface ProviderEvent {
  /** OUR `event_id`, verbatim: it is what the provider dedups on (Meta `event_id`, TikTok `event_id`, …) */
  event_id: string;
  /** our event type, kept for the delivery row */
  event_type: string;
  /** the provider's name for it, from `ads_event_map` */
  event_name: string;
  /** the provider-shaped body. Contains a hashed identifier ONLY under `ads` consent. */
  body: Record<string, unknown>;
}

export interface SendOptions {
  timeoutMs: number;
  correlationId: string;
  /** injected by the registry: the per-provider breaker and, in tests, the fetch stub */
  fetchImpl?: typeof fetch;
  /** the per-provider breaker (`01-TARGET.md` §11.5: 5 consecutive failures, half-open after 60 s) */
  breaker?: CircuitBreaker;
  retries?: number;
}

export interface SendResult {
  accepted: number;
  rejected: number;
  /** absent on success. Never contains a credential: adapters copy the provider's status and a truncated body. */
  error?: string;
  /** `true` when the failure is worth retrying (5xx, timeout, network); a 4xx is our payload's fault. */
  retryable?: boolean;
  /** `true` when nothing left the account (the SANDBOX adapter). */
  sandbox?: boolean;
}

export interface AdsProvider {
  readonly name: AdsProviderName;
  /** every secret NAME the adapter needs is present */
  configured(env: Record<string, string | undefined>): boolean;
  /**
   * Builds the provider-shaped event, or `null` when this envelope maps to
   * nothing for this provider (wrong consent transition, inactive
   * subscription, a payload the provider cannot express).
   */
  map(event: EventEnvelope, consent: ConsentState, providerEvent: string): ProviderEvent | null;
  send(events: ProviderEvent[], env: Record<string, string | undefined>, opts: SendOptions): Promise<SendResult>;
}

/** Truncates a provider's error body so a delivery row can never become a data sink. */
export const briefly = (s: string, max = 300): string => (s.length > max ? `${s.slice(0, max)}…` : s);

/** Maps an HTTP status to a send result. 4xx is ours to fix and is never retried. */
export function resultOfStatus(status: number, body: string, count: number): SendResult {
  if (status >= 200 && status < 300) return { accepted: count, rejected: 0 };
  const retryable = status >= 500 || status === 408 || status === 429;
  return { accepted: 0, rejected: count, error: `${status}: ${briefly(body)}`, retryable };
}
