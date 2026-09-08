/**
 * `tiktok` — the TikTok events API.
 *
 * The pixel code is a credential-adjacent identifier, so it lives with the
 * secrets rather than in a var, and the adapter counts as configured only when
 * both names are present.
 *
 * `event_id` is ours, verbatim — TikTok dedups a server event against the
 * browser pixel on it, exactly as Meta does.
 */
import { fetchWithBudget, PROVIDER_BUDGETS } from '@levonis/platform-kit/httpx';
import { consentedIdentifiers } from '../consent';
import { factsOf } from '../facts';
import { resultOfStatus, type AdsProvider, type ConsentState, type ProviderEvent, type SendOptions, type SendResult } from '../types';
import type { EventEnvelope } from '@levonis/contracts/envelope';

export const TIKTOK_HOST = 'https://business-api.tiktok.com';
export const TIKTOK_VERSION = 'v1.3';
export const tiktokEndpoint = (): string => `${TIKTOK_HOST}/open_api/${TIKTOK_VERSION}/event/track/`;

export const TIKTOK_SECRET_NAMES = ['TIKTOK_ADS_ACCESS_TOKEN', 'TIKTOK_ADS_PIXEL_CODE'] as const;

export class TikTokEventsApi implements AdsProvider {
  readonly name = 'tiktok' as const;

  configured(env: Record<string, string | undefined>): boolean {
    return TIKTOK_SECRET_NAMES.every((n) => (env[n] ?? '').trim().length > 0);
  }

  map(event: EventEnvelope, consent: ConsentState, providerEvent: string): ProviderEvent | null {
    const facts = factsOf(event);
    if (!facts) return null;
    const { email_hash, phone_hash } = consentedIdentifiers(consent);
    const user: Record<string, unknown> = {};
    if (email_hash) user.email = email_hash;
    if (phone_hash) user.phone = phone_hash;
    if (facts.user_hash) user.external_id = facts.user_hash;
    return {
      event_id: event.event_id,
      event_type: event.event_type,
      event_name: providerEvent,
      body: {
        event: providerEvent,
        event_time: Math.floor(Date.parse(event.created_at) / 1000),
        event_id: event.event_id,
        user,
        properties: {
          currency: facts.currency,
          value: facts.value_iqd,
          contents: facts.content_ids.map((id) => ({ content_id: id, content_type: 'product', quantity: 1 })),
        },
        page: { url: '' },
      },
    };
  }

  async send(events: ProviderEvent[], env: Record<string, string | undefined>, opts: SendOptions): Promise<SendResult> {
    const res = await fetchWithBudget(
      tiktokEndpoint(),
      {
        method: 'POST',
        headers: {
          'Access-Token': (env.TIKTOK_ADS_ACCESS_TOKEN ?? '').trim(),
          'Content-Type': 'application/json',
          'X-Request-Id': opts.correlationId,
        },
        body: JSON.stringify({
          event_source: 'web',
          event_source_id: (env.TIKTOK_ADS_PIXEL_CODE ?? '').trim(),
          data: events.map((e) => e.body),
        }),
      },
      {
        timeoutMs: opts.timeoutMs || PROVIDER_BUDGETS.ads.timeoutMs,
        retries: opts.retries ?? PROVIDER_BUDGETS.ads.retries,
        provider: 'ads.tiktok',
        breaker: opts.breaker,
        fetchImpl: opts.fetchImpl,
      }
    );
    const body = await res.text().catch(() => '');
    const result = resultOfStatus(res.status, body, events.length);
    // TikTok answers 200 with a non-zero `code` for a rejected batch, so an
    // HTTP status alone would report a silent loss as a success.
    if (result.accepted > 0) {
      const code = ((): number => {
        try {
          return Number((JSON.parse(body) as { code?: unknown }).code ?? 0);
        } catch {
          return 0;
        }
      })();
      if (code !== 0) return { accepted: 0, rejected: events.length, error: `code ${code}`, retryable: false };
    }
    return result;
  }
}
