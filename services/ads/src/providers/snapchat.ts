/**
 * `snapchat` — the Snapchat conversions API.
 *
 * Snapchat takes one conversion per request, so `send()` posts the batch
 * sequentially and reports the first failure. The batch this service hands it
 * is one event long in practice (the consumer maps one envelope at a time), so
 * the loop is a safety net rather than the normal path.
 *
 * `client_dedup_id` is our `event_id` — the same dedup contract as everywhere
 * else in this service.
 */
import { fetchWithBudget, PROVIDER_BUDGETS } from '@levonis/platform-kit/httpx';
import { consentedIdentifiers } from '../consent';
import { factsOf } from '../facts';
import { resultOfStatus, type AdsProvider, type ConsentState, type ProviderEvent, type SendOptions, type SendResult } from '../types';
import type { EventEnvelope } from '@levonis/contracts/envelope';

export const SNAPCHAT_ENDPOINT = 'https://tr.snapchat.com/v2/conversion';
export const SNAPCHAT_SECRET_NAMES = ['SNAPCHAT_ADS_ACCESS_TOKEN', 'SNAPCHAT_ADS_PIXEL_ID'] as const;

export class SnapchatConversionsApi implements AdsProvider {
  readonly name = 'snapchat' as const;

  configured(env: Record<string, string | undefined>): boolean {
    return SNAPCHAT_SECRET_NAMES.every((n) => (env[n] ?? '').trim().length > 0);
  }

  map(event: EventEnvelope, consent: ConsentState, providerEvent: string): ProviderEvent | null {
    const facts = factsOf(event);
    if (!facts) return null;
    const { email_hash, phone_hash } = consentedIdentifiers(consent);
    const body: Record<string, unknown> = {
      event_type: providerEvent,
      event_conversion_type: 'WEB',
      timestamp: Date.parse(event.created_at),
      client_dedup_id: event.event_id,
      price: facts.value_iqd,
      currency: facts.currency,
      number_items: facts.num_items,
    };
    if (email_hash) body.hashed_email = email_hash;
    if (phone_hash) body.hashed_phone_number = phone_hash;
    if (facts.content_ids.length) body.item_ids = facts.content_ids;
    if (facts.order_id) body.transaction_id = facts.order_id;
    return { event_id: event.event_id, event_type: event.event_type, event_name: providerEvent, body };
  }

  async send(events: ProviderEvent[], env: Record<string, string | undefined>, opts: SendOptions): Promise<SendResult> {
    const pixel = (env.SNAPCHAT_ADS_PIXEL_ID ?? '').trim();
    let accepted = 0;
    for (const e of events) {
      const res = await fetchWithBudget(
        SNAPCHAT_ENDPOINT,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${(env.SNAPCHAT_ADS_ACCESS_TOKEN ?? '').trim()}`,
            'Content-Type': 'application/json',
            'X-Request-Id': opts.correlationId,
          },
          body: JSON.stringify({ pixel_id: pixel, ...e.body }),
        },
        {
          timeoutMs: opts.timeoutMs || PROVIDER_BUDGETS.ads.timeoutMs,
          retries: opts.retries ?? PROVIDER_BUDGETS.ads.retries,
          provider: 'ads.snapchat',
          breaker: opts.breaker,
          fetchImpl: opts.fetchImpl,
        }
      );
      const one = resultOfStatus(res.status, await res.text().catch(() => ''), 1);
      if (one.accepted === 0) return { accepted, rejected: events.length - accepted, error: one.error, retryable: one.retryable };
      accepted += 1;
    }
    return { accepted, rejected: 0 };
  }
}
