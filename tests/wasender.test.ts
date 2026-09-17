/**
 * THE WHATSAPP TRANSPORT — WasenderAPI.
 *
 * Every assertion below is anchored to the provider's PUBLISHED contract
 * (wasenderapi.com/api-docs), not to what the implementation happens to do:
 *
 *   POST https://www.wasenderapi.com/api/send-message
 *     Authorization: Bearer <key>
 *     {"to": "+1234567890", "text": "…"}
 *   → {"success": true, "data": {"msgId": 100000, "jid": "+1…", "status": "in_progress"}}
 *   error → {"success": false, "message": "…", "errors": {…}}
 *   GET  https://www.wasenderapi.com/api/status → {"status": "connected"}
 *
 * The three things this suite exists to stop from regressing:
 *
 *   1. A NON-E.164 RECIPIENT MUST NOT REACH THE NETWORK. The provider's `to`
 *      field also accepts group and channel JIDs, so a stored "phone" of
 *      `120363…@g.us` would broadcast a customer's sign-in code to a group.
 *   2. A 200 WHOSE BODY SAYS success:false IS A FAILURE. Trusting the status
 *      line alone would record a send that never happened.
 *   3. THE KEY MUST NEVER SURVIVE INTO A RETURNED STRING. Failure details are
 *      written into `outbox.last_error` and into logs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyWasenderFailure,
  isE164,
  retryAfterSeconds,
  scrub,
  sendWhatsAppText,
  wasenderConfigured,
  wasenderStatus,
  whatsappErrorIsRetryable,
  WASENDER_SEND_ENDPOINT,
  WASENDER_STATUS_ENDPOINT,
} from '../worker/lib/wasender';
import type { Env } from '../worker/lib/types';

const KEY = 'wasender_live_SECRET_KEY_VALUE';
const env = (over: Partial<Env> = {}): Env => ({ WASENDER_API_KEY: KEY, ...over }) as Env;

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch stub that records the request and answers with what the test wants. */
function stub(reply: (call: Call) => Response): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    let body: unknown = null;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : null;
    } catch {
      body = String(init?.body);
    }
    const call: Call = { url: String(input), method: init?.method ?? 'GET', headers, body };
    calls.push(call);
    return reply(call);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const ok = (payload: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json', ...headers } });

// =========================================================================
// THE WIRE
// =========================================================================

test('SEND — URL, method, bearer header and body match the published contract exactly', async () => {
  const { calls, fetchImpl } = stub(() =>
    ok({ success: true, data: { msgId: 100000, jid: '+9647701234567', status: 'in_progress' } })
  );

  const res = await sendWhatsAppText(env(), '+9647701234567', 'hello', { fetchImpl });

  assert.equal(res.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, WASENDER_SEND_ENDPOINT);
  assert.equal(calls[0].url, 'https://www.wasenderapi.com/api/send-message');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.authorization, `Bearer ${KEY}`);
  assert.equal(calls[0].headers['content-type'], 'application/json');
  // Exactly the two documented fields, and the '+' is kept: the provider
  // documents E.164, and its own example carries the plus.
  assert.deepEqual(calls[0].body, { to: '+9647701234567', text: 'hello' });

  // `in_progress` is ACCEPTED, not delivered — it is surfaced, never rewritten
  // into something that sounds like delivery.
  assert.equal(res.ok && res.status, 'in_progress');
  assert.equal(res.ok && res.msg_id, '100000');
});

test('SEND — an unconfigured deployment answers NOT_CONFIGURED and makes no request', async () => {
  const { calls, fetchImpl } = stub(() => ok({ success: true }));
  const res = await sendWhatsAppText({ WASENDER_API_KEY: '   ' } as Env, '+9647701234567', 'hi', { fetchImpl });
  assert.equal(res.ok, false);
  assert.equal(!res.ok && res.error, 'NOT_CONFIGURED');
  assert.equal(calls.length, 0, 'a blank key is not a key — nothing may leave');
  assert.equal(wasenderConfigured({ WASENDER_API_KEY: ' ' } as Env), false);
  assert.equal(wasenderConfigured(env()), true);
});

// =========================================================================
// THE RECIPIENT IS A SECURITY BOUNDARY
// =========================================================================

test('SEND — a group JID, a handle and a bare national number are all refused BEFORE the network', async () => {
  const { calls, fetchImpl } = stub(() => ok({ success: true }));
  for (const bad of [
    '120363012345678901@g.us', // a WhatsApp GROUP — the dangerous one
    '@jane_doe', // a username handle
    '07701234567', // national, no country
    '9647701234567', // E.164 digits without the '+'
    '+0 7701234567', // spaces, and a leading zero country
    '',
  ]) {
    const res = await sendWhatsAppText(env(), bad, 'secret code 123456', { fetchImpl });
    assert.equal(res.ok, false, `${bad} must not be sendable`);
    assert.equal(!res.ok && res.error, 'INVALID_RECIPIENT', `${bad} must be refused as a recipient`);
  }
  assert.equal(calls.length, 0, 'not one of those may reach the provider');
});

test('SEND — an empty message body is refused, so an empty template cannot ping a customer', async () => {
  const { calls, fetchImpl } = stub(() => ok({ success: true }));
  const res = await sendWhatsAppText(env(), '+9647701234567', '   ', { fetchImpl });
  assert.equal(res.ok, false);
  assert.equal(calls.length, 0);
});

test('isE164 accepts real numbers and rejects everything that merely starts with a plus', () => {
  assert.equal(isE164('+9647701234567'), true);
  assert.equal(isE164('+14155550123'), true);
  assert.equal(isE164('+0123456789'), false, 'a country code never starts with 0');
  assert.equal(isE164('+123'), false, 'too short to be a real number');
  assert.equal(isE164('+1234567890123456'), false, 'E.164 is at most 15 digits');
  assert.equal(isE164(null), false);
  assert.equal(isE164(9647701234567), false, 'a number is not a string, whatever it looks like');
});

// =========================================================================
// FAILURE, CLASSIFIED BY ITS REMEDY
// =========================================================================

test('SEND — a 200 body carrying success:false is a FAILURE, not a send', async () => {
  const { fetchImpl } = stub(() =>
    ok({ success: false, message: 'Validation failed', errors: { to: ['The to field is required.'] } })
  );
  const res = await sendWhatsAppText(env(), '+9647701234567', 'hi', { fetchImpl });
  assert.equal(res.ok, false);
  assert.equal(!res.ok && res.error, 'REJECTED');
  assert.match(!res.ok ? (res.detail ?? '') : '', /Validation failed/);
});

test('SEND — a logged-out WhatsApp session is SESSION_NOT_CONNECTED, never UNAUTHORIZED', async () => {
  // The distinction is the whole point: "reconnect the phone" and "your key is
  // wrong" are different jobs for different people.
  const { fetchImpl } = stub(() => ok({ success: false, message: 'Session is not Connected' }, 422));
  const res = await sendWhatsAppText(env(), '+9647701234567', 'hi', { fetchImpl });
  assert.equal(!res.ok && res.error, 'SESSION_NOT_CONNECTED');
  assert.equal(whatsappErrorIsRetryable('SESSION_NOT_CONNECTED'), true);
});

test('SEND — 401/403 is UNAUTHORIZED and is NOT retried by the outbox', async () => {
  for (const status of [401, 403]) {
    const { fetchImpl } = stub(() => ok({ success: false, message: 'Unauthenticated.' }, status));
    const res = await sendWhatsAppText(env(), '+9647701234567', 'hi', { fetchImpl });
    assert.equal(!res.ok && res.error, 'UNAUTHORIZED', `HTTP ${status}`);
  }
  assert.equal(whatsappErrorIsRetryable('UNAUTHORIZED'), false);
  assert.equal(whatsappErrorIsRetryable('REJECTED'), false);
  assert.equal(whatsappErrorIsRetryable('PROVIDER_DOWN'), true);
  assert.equal(whatsappErrorIsRetryable('RATE_LIMITED'), true);
});

test('SEND — a 429 is RATE_LIMITED and carries the provider\'s own retry hint', async () => {
  // X-RateLimit-Reset is documented as SECONDS UNTIL RESET. Reading it as a
  // unix timestamp would produce a cooldown of about fifty years.
  const { fetchImpl } = stub(() =>
    ok({ success: false, message: 'Too many requests' }, 429, { 'X-RateLimit-Reset': '5' })
  );
  const res = await sendWhatsAppText(env(), '+9647701234567', 'hi', { fetchImpl });
  assert.equal(!res.ok && res.error, 'RATE_LIMITED');
  assert.equal(!res.ok ? res.retry_after_seconds : null, 5);
});

test('SEND — a 429 is NOT retried inside one call: retrying is what gets a number banned', async () => {
  let n = 0;
  const { fetchImpl } = stub(() => {
    n++;
    return ok({ success: false }, 429);
  });
  await sendWhatsAppText(env(), '+9647701234567', 'hi', { fetchImpl });
  assert.equal(n, 1, 'exactly one attempt — durable retry belongs to the outbox');
});

test('SEND — a 500 is PROVIDER_DOWN and is also not retried (the send is not idempotent)', async () => {
  let n = 0;
  const { fetchImpl } = stub(() => {
    n++;
    return ok({ success: false }, 503);
  });
  const res = await sendWhatsAppText(env(), '+9647701234567', 'hi', { fetchImpl });
  assert.equal(!res.ok && res.error, 'PROVIDER_DOWN');
  assert.equal(n, 1, 'no Idempotency-Key exists on this provider, so a retry would double-send');
});

test('SEND — a network failure is PROVIDER_DOWN and never throws out of the transport', async () => {
  const fetchImpl = (async () => {
    throw new Error('connection reset');
  }) as unknown as typeof fetch;
  const res = await sendWhatsAppText(env(), '+9647701234567', 'hi', { fetchImpl });
  assert.equal(res.ok, false);
  assert.equal(!res.ok && res.error, 'PROVIDER_DOWN');
});

test('classifyWasenderFailure maps each documented error to its own remedy', () => {
  assert.equal(classifyWasenderFailure(401, 'Unauthenticated.').error, 'UNAUTHORIZED');
  assert.equal(classifyWasenderFailure(403, 'No active subscription').error, 'UNAUTHORIZED');
  assert.equal(classifyWasenderFailure(429, 'Too Many Attempts.').error, 'RATE_LIMITED');
  assert.equal(classifyWasenderFailure(500, 'server error').error, 'PROVIDER_DOWN');
  assert.equal(classifyWasenderFailure(422, '{"message":"Session is not Connected"}').error, 'SESSION_NOT_CONNECTED');
  assert.equal(classifyWasenderFailure(422, 'Validation failed').error, 'REJECTED');
});

test('retryAfterSeconds reads seconds, prefers Retry-After, and drops nonsense', () => {
  const h = (o: Record<string, string>) => new Headers(o);
  assert.equal(retryAfterSeconds(h({ 'Retry-After': '30' })), 30);
  assert.equal(retryAfterSeconds(h({ 'X-RateLimit-Reset': '12' })), 12);
  assert.equal(retryAfterSeconds(h({ 'X-RateLimit-Daily-Reset': '3600' })), 3600);
  assert.equal(retryAfterSeconds(h({})), undefined);
  assert.equal(retryAfterSeconds(h({ 'Retry-After': '0' })), undefined);
  assert.equal(retryAfterSeconds(h({ 'Retry-After': '-5' })), undefined);
  assert.equal(retryAfterSeconds(h({ 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' })), undefined);
  // A unix timestamp read as "seconds from now" would be about 54 years.
  assert.equal(retryAfterSeconds(h({ 'X-RateLimit-Reset': '1789000000' })), undefined);
});

// =========================================================================
// THE KEY NEVER TRAVELS
// =========================================================================

test('the API key never appears in a returned detail string', async () => {
  // The provider echoing the request back is exactly how a bearer token ends
  // up in `outbox.last_error`, which staff read.
  const { fetchImpl } = stub(() => ok({ success: false, message: `rejected request with key ${KEY}` }, 400));
  const res = await sendWhatsAppText(env(), '+9647701234567', 'hi', { fetchImpl });
  assert.equal(res.ok, false);
  const detail = !res.ok ? (res.detail ?? '') : '';
  assert.ok(detail.length > 0, 'a failure must say something');
  assert.equal(detail.includes(KEY), false, 'the key must never survive into a stored string');
  assert.match(detail, /\[redacted\]/);
});

test('scrub removes every occurrence and is a no-op without a key', () => {
  assert.equal(scrub(`a ${KEY} b ${KEY}`, KEY), 'a [redacted] b [redacted]');
  assert.equal(scrub('nothing to do', ''), 'nothing to do');
});

// =========================================================================
// SESSION STATUS — "configured" is not "working"
// =========================================================================

test('STATUS — a connected session can send; every other state cannot', async () => {
  for (const [status, canSend] of [
    ['connected', true],
    ['connecting', false],
    ['disconnected', false],
    ['need_scan', false],
    ['need_passkey', false],
    ['logged_out', false],
    ['expired', false],
  ] as const) {
    const { calls, fetchImpl } = stub(() => ok({ status }));
    const res = await wasenderStatus(env(), { fetchImpl });
    assert.equal(res.ok, true, status);
    assert.equal(res.ok && res.status, status);
    assert.equal(res.ok && res.can_send, canSend, `${status} → can_send ${canSend}`);
    assert.equal(calls[0].url, WASENDER_STATUS_ENDPOINT);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].headers.authorization, `Bearer ${KEY}`);
  }
});

test('STATUS — with no key it is NOT_CONFIGURED, and it never invents a status', async () => {
  const res = await wasenderStatus({} as Env);
  assert.equal(res.ok, false);
  assert.equal(!res.ok && res.error, 'NOT_CONFIGURED');
});

test('STATUS — an unreadable body is PROVIDER_DOWN rather than a guess at "connected"', async () => {
  const { fetchImpl } = stub(() => new Response('<html>maintenance</html>', { status: 200 }));
  const res = await wasenderStatus(env(), { fetchImpl });
  assert.equal(res.ok, false);
  assert.equal(!res.ok && res.error, 'PROVIDER_DOWN');
});
