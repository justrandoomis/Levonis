/**
 * The provider registry and the three kill switches (`01-TARGET.md` §9.1).
 *
 * FOUR different "off" states, deliberately distinguished, because operationally
 * they mean different things:
 *
 *   global off      `ADS_ENABLED` is not the exact string `on`
 *                   -> Ads acks the event and writes NOTHING. Fails closed.
 *   provider off    `ads_providers.enabled = 0`
 *                   -> that provider gets no delivery row; the others still run.
 *   event off       `ads_event_map.enabled = 0` for (event_type, provider)
 *                   -> that pairing produces nothing.
 *   not configured  a secret NAME is missing
 *                   -> the SANDBOX adapter runs: the mapping is validated, a
 *                      row is written `status='sandbox'`, and NOTHING leaves
 *                      the account. This is the emergency switch: unset the
 *                      secret and delivery stops within one deploy-free minute.
 *
 * The breaker is per provider and lives per isolate: 5 consecutive failures
 * open it, it half-opens after 60 s (`01-TARGET.md` §9.1). An open breaker is
 * a `failed` delivery with a backoff, never a dropped conversion.
 */
import { CircuitBreaker } from '@levonis/platform-kit/rpc';
import type { AdsProviderName } from '@levonis/contracts/http/ads';
import { MetaConversionsApi } from './providers/meta';
import { GoogleAdsOfflineConversions } from './providers/google';
import { TikTokEventsApi } from './providers/tiktok';
import { SnapchatConversionsApi } from './providers/snapchat';
import { NoopProvider, SandboxProvider } from './providers/sandbox';
import type { AdsProvider } from './types';

export const BREAKER_FAILURE_THRESHOLD = 5;
export const BREAKER_HALF_OPEN_MS = 60_000;

/** Every adapter, in the order the design lists them. `noop` is the default and sends nothing. */
export function buildProviders(): AdsProvider[] {
  return [new MetaConversionsApi(), new GoogleAdsOfflineConversions(), new TikTokEventsApi(), new SnapchatConversionsApi(), new NoopProvider()];
}

/** The providers that actually deliver — `noop` is excluded from the fan-out. */
export const DELIVERING_PROVIDERS: readonly AdsProviderName[] = ['meta_capi', 'google_ads', 'tiktok', 'snapchat'];

export interface ResolvedProvider {
  /** the adapter to call: the real one, or the SANDBOX wrapper around it */
  adapter: AdsProvider;
  /** the real adapter's own verdict on its secrets */
  configured: boolean;
  breaker: CircuitBreaker;
}

/**
 * One per isolate. Holds the adapters and their breakers; it holds no secret
 * and no database handle, so it can be constructed at module scope.
 */
export class ProviderRegistry {
  private readonly real = new Map<AdsProviderName, AdsProvider>();
  private readonly breakers = new Map<AdsProviderName, CircuitBreaker>();

  constructor(providers: AdsProvider[] = buildProviders(), private readonly makeBreaker: () => CircuitBreaker = () => new CircuitBreaker({ failureThreshold: BREAKER_FAILURE_THRESHOLD, halfOpenAfterMs: BREAKER_HALF_OPEN_MS })) {
    for (const p of providers) this.real.set(p.name, p);
  }

  names(): AdsProviderName[] {
    return [...this.real.keys()];
  }

  breaker(name: AdsProviderName): CircuitBreaker {
    let b = this.breakers.get(name);
    if (!b) {
      b = this.makeBreaker();
      this.breakers.set(name, b);
    }
    return b;
  }

  /**
   * The adapter to use for `name` given the secrets currently on the Worker.
   * An unconfigured provider is wrapped in `SandboxProvider`, so the caller
   * cannot accidentally reach the network: there is no code path from an
   * unconfigured provider to a `fetch`.
   */
  resolve(name: AdsProviderName, env: Record<string, string | undefined>): ResolvedProvider | null {
    const real = this.real.get(name);
    if (!real) return null;
    const configured = real.configured(env);
    return { adapter: configured ? real : new SandboxProvider(real), configured, breaker: this.breaker(name) };
  }
}

/** The global kill switch. Fails CLOSED: anything but the exact string `on` is off. */
export const adsEnabled = (v: string | undefined): boolean => (v ?? '').trim().toLowerCase() === 'on';
