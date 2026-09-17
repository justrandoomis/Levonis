/**
 * THE THREE PROVIDER CONTRACTS, PINNED — verified against the published docs
 * on 2026-09-17, and asserted here so the next person does not have to
 * re-read them to find out whether this code still matches.
 *
 *   RESEND   https://resend.com/docs/api-reference/emails/send-email
 *     POST https://api.resend.com/emails
 *     Authorization: Bearer re_…
 *     body {from, to, subject, html, text}   ← `from` accepts "Name <a@b.c>"
 *     header Idempotency-Key, max 256 chars, 24-hour dedup window
 *     success {"id": "49a3999c-…"}
 *     No API version header and no date-based versioning.
 *
 *   TELEGRAM https://core.telegram.org/bots/api  (Bot API 10.3, 2026-08-24)
 *     POST https://api.telegram.org/bot<token>/sendMessage
 *     body {chat_id, text, …}
 *     `text` caps at 4096 characters; this code sends at most 4000.
 *
 *   WASENDER https://wasenderapi.com/api-docs/messages/send-text-message
 *     POST https://www.wasenderapi.com/api/send-message
 *     Authorization: Bearer <key>
 *     body {to, text}   ← `to` is E.164 WITH the plus, per the docs' own example
 *     success {"success": true, "data": {"msgId", "jid", "status"}}
 *     (covered in depth by tests/wasender.test.ts; the endpoint is pinned here
 *     so all three live in one place)
 *
 * WHY A TEST AND NOT A COMMENT. Two of these three were wrong in ways nobody
 * could see: the Resend request had no timeout at all, and `EMAIL_FROM` was
 * checked two different ways so a whitespace value made the UI and the sender
 * disagree about whether mail worked. A contract that is only written down in
 * prose is a contract nothing enforces.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO: reach the network. It reads the
 * request the code BUILDS. A test that called a provider would be a test that
 * fails when somebody's wifi does, and it would spend the shop's quota.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESEND_ENDPOINT, emailConfigured, emailAllowsRecipient, sendEmailNow } from '../worker/lib/emailSend';
import { WASENDER_SEND_ENDPOINT, WASENDER_STATUS_ENDPOINT } from '../worker/lib/wasender';
import type { Env } from '../worker/lib/types';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outboxSrc = readFileSync(join(ROOT, 'worker', 'lib', 'outbox.ts'), 'utf8');

interface Capture {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signalPresent: boolean;
}

function capture(status = 200, payload: unknown = { id: 'msg_1' }) {
  const calls: Capture[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
      // fetchWithBudget races the request against a timer rather than passing
      // an AbortSignal through, so its presence is asserted by behaviour below.
      signalPresent: !!init?.signal,
    });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const env = (over: Partial<Env> = {}): Env =>
  ({
    EMAIL_API_KEY: 're_test_key',
    EMAIL_FROM: 'LEVONIS <no-reply@levonis-iq.com>',
    ...over,
  }) as Env;

// =========================================================================
// RESEND
// =========================================================================

test('RESEND — the endpoint, the bearer header and the five body fields are the documented ones', async () => {
  const { calls, fetchImpl } = capture();
  const ok = await sendEmailNow(env(), 'you@example.com', 'Subject', '<p>Hi</p>', 'Hi', { fetchImpl });

  assert.equal(ok, true);
  assert.equal(RESEND_ENDPOINT, 'https://api.resend.com/emails');
  assert.equal(calls[0].url, RESEND_ENDPOINT);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.authorization, 'Bearer re_test_key');
  assert.equal(calls[0].headers['content-type'], 'application/json');
  assert.deepEqual(Object.keys(calls[0].body).sort(), ['from', 'html', 'subject', 'text', 'to']);
  // "Name <address>" is a documented `from` shape, and it must survive intact —
  // trimming must not eat the display name or the angle brackets.
  assert.equal(calls[0].body.from, 'LEVONIS <no-reply@levonis-iq.com>');
  assert.equal(calls[0].body.to, 'you@example.com');
});

test('RESEND — Idempotency-Key is sent only with a key, and is truncated to the documented 256', async () => {
  // Present: the outbox path, where the SAME business event may be retried.
  const withKey = capture();
  await sendEmailNow(env(), 'you@example.com', 'S', '<p>h</p>', 't', {
    fetchImpl: withKey.fetchImpl,
    idempotencyKey: 'x'.repeat(300),
  });
  assert.equal(withKey.calls[0].headers['idempotency-key'].length, 256);

  // Absent: the immediate path. A key there would be wrong in the other
  // direction — two genuinely separate sign-in codes would dedup into one.
  const noKey = capture();
  await sendEmailNow(env(), 'you@example.com', 'S', '<p>h</p>', 't', { fetchImpl: noKey.fetchImpl });
  assert.equal('idempotency-key' in noKey.calls[0].headers, false);
});

test('RESEND — the send is retried ONLY when an idempotency key makes a retry safe', async () => {
  // Without a key, a retry after an ambiguous 502 mails the customer twice.
  let plain = 0;
  await sendEmailNow(env(), 'you@example.com', 'S', '<p>h</p>', 't', {
    fetchImpl: (async () => {
      plain++;
      return new Response('{}', { status: 502 });
    }) as unknown as typeof fetch,
  });
  assert.equal(plain, 1, 'no key, no retry');

  // With one, the provider deduplicates, so retrying is the right answer to a
  // transient 502 rather than a second email.
  let keyed = 0;
  await sendEmailNow(env(), 'you@example.com', 'S', '<p>h</p>', 't', {
    idempotencyKey: 'order.placed:ORD-1:email',
    fetchImpl: (async () => {
      keyed++;
      return new Response('{}', { status: 502 });
    }) as unknown as typeof fetch,
  });
  assert.ok(keyed > 1, 'a keyed send is retried within the provider budget');
});

test('RESEND — a hung provider is abandoned rather than holding the request open', async () => {
  // The bug this pins: both live Resend calls used bare `fetch` with nothing
  // to cancel them, and on the immediate path that is an auth response a
  // person is staring at.
  const started = Date.now();
  const ok = await sendEmailNow(env(), 'you@example.com', 'S', '<p>h</p>', 't', {
    fetchImpl: (() => new Promise<Response>(() => {})) as unknown as typeof fetch,
  });
  assert.equal(ok, false, 'a timeout is a failed send, reported as one');
  assert.ok(Date.now() - started < 20_000, 'it gave up inside the provider budget');
});

test('RESEND — a failed send NEVER throws, because the caller is beside a business decision', async () => {
  for (const impl of [
    (async () => new Response('{"message":"domain not verified"}', { status: 403 })) as unknown as typeof fetch,
    (async () => {
      throw new Error('connection reset');
    }) as unknown as typeof fetch,
  ]) {
    assert.equal(await sendEmailNow(env(), 'you@example.com', 'S', '<p>h</p>', 't', { fetchImpl: impl }), false);
  }
});

test('EMAIL CONFIG — one answer to "can we mail?", and whitespace is not a value', async () => {
  assert.equal(emailConfigured(env()), true);
  assert.equal(emailConfigured(env({ EMAIL_API_KEY: '' })), false);
  assert.equal(emailConfigured(env({ EMAIL_FROM: '   ' })), false);
  assert.equal(emailConfigured({} as Env), false);

  // …and an unconfigured send makes no request at all.
  const { calls, fetchImpl } = capture();
  assert.equal(await sendEmailNow(env({ EMAIL_FROM: ' ' }), 'a@b.co', 'S', 'h', 't', { fetchImpl }), false);
  assert.equal(calls.length, 0);
});

test('EMAIL ALLOWLIST — empty means everyone, unless the deployment says it means nobody', async () => {
  assert.equal(emailAllowsRecipient(env(), 'anyone@example.com'), true);
  assert.equal(emailAllowsRecipient(env({ EMAIL_ALLOWLIST_REQUIRED: 'on' }), 'anyone@example.com'), false);
  const listed = env({ EMAIL_ALLOWED_RECIPIENTS: ' Boss@Example.com , qa@example.com ' });
  assert.equal(emailAllowsRecipient(listed, 'boss@example.com'), true, 'case and padding are not identity');
  assert.equal(emailAllowsRecipient(listed, 'customer@example.com'), false);

  // A blocked recipient is a SKIPPED send, not a request the provider refuses.
  const { calls, fetchImpl } = capture();
  assert.equal(await sendEmailNow(listed, 'customer@example.com', 'S', 'h', 't', { fetchImpl }), false);
  assert.equal(calls.length, 0);
});

// =========================================================================
// TELEGRAM
// =========================================================================

test('TELEGRAM — the outbox posts to the documented bot endpoint and stays under the 4096 text cap', () => {
  assert.ok(
    outboxSrc.includes('https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage'),
    'worker/lib/outbox.ts no longer posts to the documented sendMessage endpoint'
  );
  // Bot API caps `text` at 4096. 4000 leaves room rather than sitting on the
  // boundary, and a message that is silently REFUSED for being long is worse
  // than one that is visibly truncated.
  assert.ok(outboxSrc.includes('text.slice(0, 4000)'), 'the Telegram text cap was removed');
  assert.ok(outboxSrc.includes('chat_id: payload.chat_id'));
});

// =========================================================================
// WASENDER
// =========================================================================

test('WASENDER — both endpoints are the documented ones, on the www host the docs use', () => {
  assert.equal(WASENDER_SEND_ENDPOINT, 'https://www.wasenderapi.com/api/send-message');
  assert.equal(WASENDER_STATUS_ENDPOINT, 'https://www.wasenderapi.com/api/status');
});

// =========================================================================
// THE OUTBOX ROUTES EACH KIND TO ITS OWN PROVIDER
// =========================================================================

test('the outbox knows exactly three kinds, and an unconfigured one is DEAD rather than retried forever', () => {
  for (const marker of [
    "payload.kind === 'email'",
    "payload.kind === 'whatsapp'",
    "EMAIL_NOT_CONFIGURED",
    "WHATSAPP_NOT_CONFIGURED",
    "TELEGRAM_NOT_CONFIGURED",
  ]) {
    assert.ok(outboxSrc.includes(marker), `worker/lib/outbox.ts no longer handles: ${marker}`);
  }
});
