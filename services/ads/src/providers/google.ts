/**
 * `google_ads` — offline conversion uploads (`uploadClickConversions`).
 *
 * The platform has no click id to attribute with, so every upload is an
 * *enhanced* conversion: the identity is the hashed email/phone Identity
 * supplied under `ads` consent, carried in `userIdentifiers`. Without consent
 * there is nothing to identify the conversion with, `map()` returns null and
 * the delivery is recorded `no_consent`.
 *
 * `orderId` is our `event_id` (or the order id when the conversion has one) —
 * it is the field Google dedups uploads on, which is the same role Meta's
 * `event_id` plays.
 */
import { fetchWithBudget, PROVIDER_BUDGETS } from '@levonis/platform-kit/httpx';
import { consentedIdentifiers } from '../consent';
import { factsOf } from '../facts';
import { resultOfStatus, type AdsProvider, type ConsentState, type ProviderEvent, type SendOptions, type SendResult } from '../types';
import type { EventEnvelope } from '@levonis/contracts/envelope';

export const GOOGLE_ADS_HOST = 'https://googleads.googleapis.com';
export const GOOGLE_ADS_VERSION = 'v18';

export const GOOGLE_SECRET_NAMES = [
  'GOOGLE_ADS_DEVELOPER_TOKEN',
  'GOOGLE_ADS_ACCESS_TOKEN',
  'GOOGLE_ADS_CUSTOMER_ID',
  'GOOGLE_ADS_CONVERSION_ACTION_ID',
] as const;

export const googleEndpoint = (customerId: string): string =>
  `${GOOGLE_ADS_HOST}/${GOOGLE_ADS_VERSION}/customers/${customerId}:uploadClickConversions`;

/** Google wants `yyyy-mm-dd hh:mm:ss+00:00`, not ISO-8601 with a `T` and a `Z`. */
export function googleDateTime(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '+00:00');
}

export class GoogleAdsOfflineConversions implements AdsProvider {
  readonly name = 'google_ads' as const;

  configured(env: Record<string, string | undefined>): boolean {
    return GOOGLE_SECRET_NAMES.every((n) => (env[n] ?? '').trim().length > 0);
  }

  map(event: EventEnvelope, consent: ConsentState, providerEvent: string): ProviderEvent | null {
    const facts = factsOf(event);
    if (!facts) return null;
    const { email_hash, phone_hash } = consentedIdentifiers(consent);
    const userIdentifiers: Array<Record<string, string>> = [];
    if (email_hash) userIdentifiers.push({ hashedEmail: email_hash });
    if (phone_hash) userIdentifiers.push({ hashedPhoneNumber: phone_hash });
    // No identifier means no attributable conversion for this platform.
    if (userIdentifiers.length === 0) return null;
    return {
      event_id: event.event_id,
      event_type: event.event_type,
      event_name: providerEvent,
      body: {
        orderId: facts.order_id ?? event.event_id,
        conversionDateTime: googleDateTime(event.created_at),
        conversionValue: facts.value_iqd,
        currencyCode: facts.currency,
        userIdentifiers,
        // filled in at send time from the secret, so no account id is stored
        conversionAction: '',
      },
    };
  }

  async send(events: ProviderEvent[], env: Record<string, string | undefined>, opts: SendOptions): Promise<SendResult> {
    const customer = (env.GOOGLE_ADS_CUSTOMER_ID ?? '').trim();
    const action = (env.GOOGLE_ADS_CONVERSION_ACTION_ID ?? '').trim();
    const conversions = events.map((e) => ({
      ...e.body,
      conversionAction: `customers/${customer}/conversionActions/${action}`,
    }));
    const res = await fetchWithBudget(
      googleEndpoint(customer),
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${(env.GOOGLE_ADS_ACCESS_TOKEN ?? '').trim()}`,
          'developer-token': (env.GOOGLE_ADS_DEVELOPER_TOKEN ?? '').trim(),
          'Content-Type': 'application/json',
          'X-Request-Id': opts.correlationId,
        },
        // partialFailure keeps one bad row from rejecting the batch; the
        // response body then names the rows that failed and we retry nothing.
        body: JSON.stringify({ conversions, partialFailure: true, validateOnly: false }),
      },
      {
        timeoutMs: opts.timeoutMs || PROVIDER_BUDGETS.ads.timeoutMs,
        retries: opts.retries ?? PROVIDER_BUDGETS.ads.retries,
        provider: 'ads.google_ads',
        breaker: opts.breaker,
        fetchImpl: opts.fetchImpl,
      }
    );
    return resultOfStatus(res.status, await res.text().catch(() => ''), events.length);
  }
}
