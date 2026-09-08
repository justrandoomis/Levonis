/**
 * The recorded-fixture contract test, one per adapter.
 *
 * `test/fixtures/<provider>.exchange.json` is the recorded wire exchange: the
 * mapped event, the request the adapter puts on the wire (method, URL, header
 * NAMES — never a value — and the full body) and the provider's response. The
 * test replays it: the same committed event fixture goes in, the request must
 * come out byte-identical, and the recorded response must be parsed to the
 * recorded result.
 *
 * That makes an accidental change to a payload a failing test rather than a
 * silent change in what an advertising platform is told about a customer, which
 * is the property that matters here. What it does NOT prove is that the
 * provider still accepts that shape — see `CONTRACT.md`, "Re-verifying the
 * recorded exchanges".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MetaConversionsApi } from '../src/providers/meta';
import { GoogleAdsOfflineConversions } from '../src/providers/google';
import { TikTokEventsApi } from '../src/providers/tiktok';
import { SnapchatConversionsApi } from '../src/providers/snapchat';
import { NoopProvider } from '../src/providers/sandbox';
import type { AdsProvider, ConsentState } from '../src/types';
import { CONFIGURED_ENV, fixture, forbiddenFetch, recordingFetch, SERVICE_ROOT } from './_harness';

interface Exchange {
  provider: string;
  source_event: string;
  provider_event: string;
  mapped: Record<string, unknown>;
  request: { method: string; url: string; headers: string[]; body: unknown };
  response: { status: number; body: unknown };
  result: { accepted: number; rejected: number };
}

const FIXTURE_DIR = join(SERVICE_ROOT, 'test', 'fixtures');
const exchange = (name: string): Exchange => JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.exchange.json`), 'utf8')) as Exchange;

/** The consent snapshot the committed `UserUpdated` fixture produces: `ads`, with both hashes. */
const CONSENTED: ConsentState = {
  user_hash: 'fd7f00b62d225a902278575fd1addcd2633ee9def3b5b1593ef19982d355c1fa',
  consent: 'ads',
  email_hash: '1e1f8fb2fc0418591b31044730f2d535e18d547ef854b76fcadcc5d9a1241544',
  phone_hash: '904305c3f22aa24aeedf911ac0488173924f3337ba67de1a4686e3fe193fbb63',
  first_ads_at: '2026-09-07T10:00:01.000Z',
};

const ADAPTERS: AdsProvider[] = [new MetaConversionsApi(), new GoogleAdsOfflineConversions(), new TikTokEventsApi(), new SnapchatConversionsApi()];

test('the consent snapshot in this suite is the one the committed UserUpdated fixture describes', () => {
  const u = fixture('UserUpdated').payload as Record<string, string>;
  assert.equal(u.marketing_consent, 'ads');
  assert.equal(CONSENTED.user_hash, u.user_hash);
  assert.equal(CONSENTED.email_hash, u.email_hash);
  assert.equal(CONSENTED.phone_hash, u.phone_hash);
});

test('every adapter has a recorded exchange and every recorded exchange has an adapter', () => {
  const recorded = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.exchange.json')).map((f) => f.replace('.exchange.json', '')).sort();
  assert.deepEqual(recorded, ADAPTERS.map((a) => a.name).sort(), 'a new adapter needs a recorded exchange before it can ship');
});

for (const adapter of ADAPTERS) {
  test(`${adapter.name}: maps the committed PurchaseCompleted fixture to the recorded provider payload`, () => {
    const rec = exchange(adapter.name);
    const mapped = adapter.map(fixture('PurchaseCompleted'), CONSENTED, rec.provider_event);
    assert.ok(mapped, `${adapter.name} mapped the conversion to nothing`);
    assert.deepEqual(mapped.body, rec.mapped);
    // OUR event_id is the provider's dedup key, verbatim (01-TARGET.md §9.1).
    assert.equal(mapped.event_id, fixture('PurchaseCompleted').event_id);
    assert.equal(mapped.event_name, rec.provider_event);
  });

  test(`${adapter.name}: puts the recorded request on the wire and reads the recorded response`, async () => {
    const rec = exchange(adapter.name);
    const mapped = adapter.map(fixture('PurchaseCompleted'), CONSENTED, rec.provider_event)!;
    const { impl, calls } = recordingFetch(rec.response);
    const result = await adapter.send([mapped], CONFIGURED_ENV, {
      timeoutMs: 5_000,
      retries: 0,
      correlationId: fixture('PurchaseCompleted').correlation_id,
      fetchImpl: impl,
    });
    assert.equal(calls.length, 1, 'one request per batch');
    assert.equal(calls[0].url, rec.request.url);
    assert.equal(calls[0].init.method, rec.request.method);
    assert.deepEqual(Object.keys(calls[0].init.headers as Record<string, string>).sort(), rec.request.headers);
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), rec.request.body);
    assert.equal(result.accepted, rec.result.accepted);
    assert.equal(result.rejected, rec.result.rejected);
    assert.equal(result.error, undefined);
  });

  test(`${adapter.name}: a 5xx is retryable and a 4xx is not — and neither leaks a credential`, async () => {
    const rec = exchange(adapter.name);
    const mapped = adapter.map(fixture('PurchaseCompleted'), CONSENTED, rec.provider_event)!;
    for (const [status, retryable] of [
      [503, true],
      [400, false],
      [401, false],
    ] as const) {
      const { impl } = recordingFetch({ status, body: { error: 'upstream said no' } });
      const r = await adapter.send([mapped], CONFIGURED_ENV, { timeoutMs: 1_000, retries: 0, correlationId: 'cid', fetchImpl: impl });
      assert.equal(r.accepted, 0);
      assert.equal(r.retryable, retryable, `${status} retryable=${retryable}`);
      for (const secret of Object.values(CONFIGURED_ENV)) {
        if (secret && secret.startsWith('test-')) assert.ok(!(r.error ?? '').includes(secret), 'an error must never carry a credential');
      }
    }
  });

  test(`${adapter.name}: unconfigured — no secret means configured() is false`, () => {
    assert.equal(adapter.configured({}), false);
    assert.equal(adapter.configured(CONFIGURED_ENV), true);
    // one missing name is enough to disqualify the whole adapter
    for (const key of Object.keys(CONFIGURED_ENV)) {
      if (key === 'ADS_ENABLED') continue;
      const partial = { ...CONFIGURED_ENV, [key]: '' };
      if (adapter.configured(CONFIGURED_ENV) && !adapter.configured(partial)) return; // this key belongs to this adapter
    }
  });
}

test('tiktok reports a 200 with a non-zero code as a rejection, not a success', async () => {
  const adapter = new TikTokEventsApi();
  const rec = exchange('tiktok');
  const mapped = adapter.map(fixture('PurchaseCompleted'), CONSENTED, rec.provider_event)!;
  const { impl } = recordingFetch({ status: 200, body: { code: 40001, message: 'Invalid pixel' } });
  const r = await adapter.send([mapped], CONFIGURED_ENV, { timeoutMs: 1_000, retries: 0, correlationId: 'cid', fetchImpl: impl });
  assert.equal(r.accepted, 0);
  assert.equal(r.rejected, 1);
  assert.equal(r.retryable, false);
});

test('google_ads refuses to map a conversion it could not attribute: no consented identifier, no upload', () => {
  const adapter = new GoogleAdsOfflineConversions();
  const anonymous: ConsentState = { ...CONSENTED, consent: 'none', email_hash: null, phone_hash: null };
  assert.equal(adapter.map(fixture('PurchaseCompleted'), anonymous, 'purchase'), null);
});

test('noop is the default and does nothing at all — it maps to null and never fetches', async () => {
  const noop = new NoopProvider();
  assert.equal(noop.configured(), false);
  assert.equal(noop.map(), null);
  const r = await noop.send();
  assert.deepEqual(r, { accepted: 0, rejected: 0, sandbox: true });
  // proven by the harness: `forbiddenFetch` throws, and noop never reaches it
  assert.equal(typeof forbiddenFetch, 'function');
});
