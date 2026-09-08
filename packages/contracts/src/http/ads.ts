/**
 * `levonis-ads` HTTP contract — `/api/v1/ads/admin/*` (`01-TARGET.md` §9.1,
 * row 18): providers, kill switches and deliveries. Admin-only.
 *
 * Nothing here carries a contact: Identity hashes email/phone and Ads keeps the
 * hashes in `ads_consent_snapshots` keyed by `user_hash`, so a delivery row
 * names an `event_id` and a provider, never a person. Type-only.
 */

/** The five adapters; `noop` is the default when nothing is configured. */
export type AdsProviderName = 'meta_capi' | 'google_ads' | 'tiktok' | 'snapchat' | 'noop';

/**
 * `sandbox` = the provider's secrets are absent, so the mapping was validated
 * and the row written but nothing left the account. `no_consent` = the consent
 * snapshot for that `user_hash` is not `ads`.
 */
export type AdsDeliveryStatus = 'sent' | 'sandbox' | 'no_consent' | 'rejected' | 'failed' | 'dead';

/** `GET /api/v1/ads/admin/providers` */
export interface AdsProviderStatus {
  name: AdsProviderName;
  /** every secret the adapter needs is present */
  configured: boolean;
  /** `ads.providers.<name>.enabled` */
  enabled: boolean;
  /** the per-provider circuit breaker (`01-TARGET.md` §11.5) */
  breaker: 'closed' | 'open' | 'half_open';
  consecutive_failures: number;
}

export interface AdsProvidersResponse {
  success: true;
  /** `ads.enabled` — the master kill switch */
  enabled: boolean;
  providers: AdsProviderStatus[];
}

/** One row of the seeded `ads_event_map`: our event type → the provider's name for it. */
export interface AdsEventMapping {
  event_type: string;
  provider: AdsProviderName;
  provider_event: string;
  /** `ads.events.<type>.enabled` */
  enabled: boolean;
}

/** `GET /api/v1/ads/admin/event-map` */
export interface AdsEventMapResponse {
  success: true;
  mappings: AdsEventMapping[];
}

/** One row of `ads_deliveries`. */
export interface AdsDeliveryRow {
  id: string;
  event_id: string;
  event_type: string;
  provider: AdsProviderName;
  status: AdsDeliveryStatus;
  attempts: number;
  error: string | null;
  created_at: string;
  delivered_at: string | null;
}

/** `GET /api/v1/ads/admin/deliveries?provider=…&status=…&limit=…&cursor=…` */
export interface AdsDeliveriesResponse {
  success: true;
  rows: AdsDeliveryRow[];
  next: string | null;
  /** rows in `ads_dead_letters` — the alert is `> 0` */
  dead_letters: number;
}

/**
 * `POST /api/v1/ads/admin/flags` — flips `ads.enabled`,
 * `ads.providers.<name>.enabled` or `ads.events.<type>.enabled` through CONFIG.
 * The emergency switch is not this route: it is unsetting the secret, which
 * drops the provider to `sandbox`.
 */
export interface AdsFlagResponse {
  success: true;
  name: string;
  enabled: boolean;
  version: number;
}
