/**
 * `meta_capi` — Meta server events.
 *
 * One adapter covers both names in the design: the Conversions API is the send
 * path and the Meta **Marketing API** graph host is the surface it posts to
 * (`<graph>/<dataset_id>/events`), so there is one credential pair, one
 * endpoint and one recorded fixture rather than two adapters that would differ only
 * in a comment.
 *
 * `event_id` is OUR `event_id`, verbatim: that is what the browser Pixel and
 * this server event dedup against each other on
 * (`01-TARGET.md` §9.1, `03-EVENTS.md` §2.5).
 *
 * Identifiers (`em`, `ph`) are the hashes Identity computed on a consent
 * change; `consentedIdentifiers()` returns nulls for any snapshot that is not
 * `ads`, so an unconsented event is sent with no user data at all — and the
 * consumer does not send it in the first place.
 */
import { fetchWithBudget, PROVIDER_BUDGETS } from '@levonis/platform-kit/httpx';
import { consentedIdentifiers } from '../consent';
import { factsOf } from '../facts';
import { hasAdsConsent, resultOfStatus, type AdsProvider, type ConsentState, type ProviderEvent, type SendOptions, type SendResult } from '../types';
import type { EventEnvelope } from '@levonis/contracts/envelope';

/** The graph/Marketing API host and version the dataset events are posted to. */
export const META_GRAPH_HOST = 'https://graph.facebook.com';
export const META_GRAPH_VERSION = 'v21.0';

export const META_SECRET_NAMES = ['META_CAPI_ACCESS_TOKEN', 'META_CAPI_DATASET_ID'] as const;

export const metaEndpoint = (datasetId: string): string => `${META_GRAPH_HOST}/${META_GRAPH_VERSION}/${datasetId}/events`;

const seconds = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

export class MetaConversionsApi implements AdsProvider {
  readonly name = 'meta_capi' as const;

  configured(env: Record<string, string | undefined>): boolean {
    return META_SECRET_NAMES.every((n) => (env[n] ?? '').trim().length > 0);
  }

  map(event: EventEnvelope, consent: ConsentState, providerEvent: string): ProviderEvent | null {
    const facts = factsOf(event);
    if (!facts) return null;
    const { email_hash, phone_hash } = consentedIdentifiers(consent);
    const user_data: Record<string, unknown> = {};
    if (email_hash) user_data.em = [email_hash];
    if (phone_hash) user_data.ph = [phone_hash];
    if (hasAdsConsent(consent) && consent.user_hash) user_data.external_id = [consent.user_hash];
    const custom_data: Record<string, unknown> = { currency: facts.currency, value: facts.value_iqd };
    if (facts.content_ids.length) {
      custom_data.content_ids = facts.content_ids;
      custom_data.content_type = 'product';
    }
    if (facts.num_items) custom_data.num_items = facts.num_items;
    if (facts.order_id) custom_data.order_id = facts.order_id;
    return {
      event_id: event.event_id,
      event_type: event.event_type,
      event_name: providerEvent,
      body: {
        event_name: providerEvent,
        event_time: seconds(event.created_at),
        event_id: event.event_id,
        action_source: 'website',
        user_data,
        custom_data,
      },
    };
  }

  async send(events: ProviderEvent[], env: Record<string, string | undefined>, opts: SendOptions): Promise<SendResult> {
    const token = (env.META_CAPI_ACCESS_TOKEN ?? '').trim();
    const dataset = (env.META_CAPI_DATASET_ID ?? '').trim();
    const res = await fetchWithBudget(
      metaEndpoint(dataset),
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Request-Id': opts.correlationId },
        body: JSON.stringify({ data: events.map((e) => e.body) }),
      },
      {
        timeoutMs: opts.timeoutMs || PROVIDER_BUDGETS.ads.timeoutMs,
        retries: opts.retries ?? PROVIDER_BUDGETS.ads.retries,
        provider: 'ads.meta_capi',
        breaker: opts.breaker,
        fetchImpl: opts.fetchImpl,
      }
    );
    return resultOfStatus(res.status, await res.text().catch(() => ''), events.length);
  }
}
