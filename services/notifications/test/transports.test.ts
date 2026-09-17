/**
 * The two transports, and the rule the slice is judged on: **delivery is
 * disabled unless the secret NAMES exist**, and the provider
 * `Idempotency-Key` is the event key.
 *
 * The requests are compared against `worker/lib/outbox.ts` as it stands, read
 * from disk — a port that quietly changes the wire format is the failure this
 * test exists to catch, and restating the format here would only prove that the
 * test agrees with itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EmailTransport, RESEND_ENDPOINT, allowedRecipient, IDEMPOTENCY_KEY_MAX } from '../src/transports/email';
import { TelegramTransport, TELEGRAM_API, TEXT_MAX } from '../src/transports/telegram';
import { TransportRegistry } from '../src/transports/registry';
import { CONFIGURED_ENV, forbiddenFetch, recordingFetch, REPO_ROOT, SERVICE_ROOT, UNCONFIGURED_ENV } from './_harness';

const coreOutbox = readFileSync(join(REPO_ROOT, 'worker', 'lib', 'outbox.ts'), 'utf8');
/**
 * The core's EMAIL wire format moved out of outbox.ts into lib/emailSend.ts,
 * so that the immediate auth path (a reset link, a sign-in code) and the
 * durable outbox stop maintaining two copies of the same request. The
 * property this file defends is unchanged — the dark transport must send what
 * the core sends — so it now reads whichever of the two files the core keeps
 * each half in. Telegram is still built inline in outbox.ts.
 */
const coreEmail = readFileSync(join(REPO_ROOT, 'worker', 'lib', 'emailSend.ts'), 'utf8');

const EMAIL = { kind: 'email', to: 'someone@example.com', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' } as const;
const TELEGRAM = { kind: 'telegram', chat_id: '-100123', text: 'New order' } as const;

test('the endpoints are the ones the core uses today, read from the core rather than restated', () => {
  assert.ok(coreEmail.includes(RESEND_ENDPOINT), `the core no longer posts to ${RESEND_ENDPOINT}`);
  assert.ok(coreOutbox.includes(`${TELEGRAM_API}/bot`), 'worker/lib/outbox.ts no longer posts to the Telegram bot API');
  // Two halves of the same rule, in the two files that now hold them: the
  // outbox supplies the EVENT KEY as the idempotency key, and the sender
  // truncates it to the provider's documented maximum.
  assert.ok(
    coreOutbox.includes('idempotencyKey: eventKey'),
    'the core still keys Resend on the event key, so a retry of one business event cannot double-send'
  );
  assert.ok(
    coreEmail.includes("headers['Idempotency-Key'] = opts.idempotencyKey.slice(0, 256)"),
    'the core still truncates the Idempotency-Key to 256'
  );
  assert.equal(IDEMPOTENCY_KEY_MAX, 256);
  assert.ok(coreOutbox.includes('text.slice(0, 4000)'));
  assert.equal(TEXT_MAX, 4000);
});

test('EMAIL: disabled without its secret NAMES — no request is made and the row is dropped, not failed', async () => {
  const t = new EmailTransport();
  assert.equal(t.configured({}), false);
  assert.equal(t.configured({ EMAIL_API_KEY: 'k' }), false, 'a From address is needed too');
  assert.equal(t.configured({ EMAIL_API_KEY: 'k', EMAIL_FROM: '  ' }), false, 'whitespace is not a value');
  assert.equal(t.configured(CONFIGURED_ENV), true);

  // the harness fetch throws: reaching it at all fails the test
  const r = await t.send(EMAIL, UNCONFIGURED_ENV, { eventKey: 'invoice:ORD-1:1', fetchImpl: forbiddenFetch });
  assert.deepEqual(r, { ok: false, error: 'EMAIL_NOT_CONFIGURED', disabled: true });
});

test('EMAIL: the request is the core\'s, and Idempotency-Key IS the event key', async () => {
  const { impl, calls } = recordingFetch({ status: 200, body: { id: 'msg_1' } });
  const r = await new EmailTransport().send(EMAIL, CONFIGURED_ENV, { eventKey: 'invoice:ORD-1:1', fetchImpl: impl });
  assert.deepEqual(r, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, RESEND_ENDPOINT);
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers['Idempotency-Key'], 'invoice:ORD-1:1');
  assert.equal(headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    from: 'no-reply@levonis.invalid',
    to: EMAIL.to,
    subject: EMAIL.subject,
    html: EMAIL.html,
    text: EMAIL.text,
  });
});

test('EMAIL: an over-long event key is truncated to the provider limit rather than rejected', async () => {
  const { impl, calls } = recordingFetch({ status: 200, body: {} });
  await new EmailTransport().send(EMAIL, CONFIGURED_ENV, { eventKey: 'k'.repeat(400), fetchImpl: impl });
  assert.equal((calls[0].init.headers as Record<string, string>)['Idempotency-Key'].length, IDEMPOTENCY_KEY_MAX);
});

test('EMAIL: a 5xx is retryable, a 4xx is not, and neither error carries the API key', async () => {
  for (const [status, retryable] of [[500, true], [429, true], [422, false]] as const) {
    const { impl } = recordingFetch({ status, body: { message: 'nope' } });
    const r = await new EmailTransport().send(EMAIL, CONFIGURED_ENV, { eventKey: 'k'.repeat(20), fetchImpl: impl, retries: 0 });
    assert.equal(r.ok, false);
    assert.equal(r.retryable, retryable, String(status));
    assert.ok(!(r.error ?? '').includes('test-email-key'));
  }
});

test('TELEGRAM: disabled without the bot token; the admin group is a separate requirement', async () => {
  const t = new TelegramTransport();
  assert.equal(t.configured({}), false);
  assert.equal(t.configured({ TELEGRAM_BOT_TOKEN: 'x' }), true, 'a customer message needs only the token');
  assert.equal(t.adminConfigured({ TELEGRAM_BOT_TOKEN: 'x' }), false, 'an admin message needs the group too');
  assert.equal(t.adminConfigured(CONFIGURED_ENV), true);

  const r = await t.send(TELEGRAM, UNCONFIGURED_ENV, { eventKey: 'order:1:admin', fetchImpl: forbiddenFetch });
  assert.deepEqual(r, { ok: false, error: 'TELEGRAM_NOT_CONFIGURED', disabled: true });
});

test('TELEGRAM: plain text, capped, no parse_mode — a user-supplied name cannot inject markup', async () => {
  const { impl, calls } = recordingFetch({ status: 200, body: { ok: true } });
  const long = { kind: 'telegram', chat_id: 42, text: '*'.repeat(5_000) } as const;
  const r = await new TelegramTransport().send(long, CONFIGURED_ENV, { eventKey: 'k', fetchImpl: impl });
  assert.deepEqual(r, { ok: true });
  const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
  assert.equal(body.chat_id, 42);
  assert.equal(String(body.text).length, TEXT_MAX);
  assert.equal(body.disable_web_page_preview, true);
  assert.ok(!('parse_mode' in body), 'no parse_mode: markup in a display name must stay inert');
});

test('TELEGRAM: the bot token is in the URL, so the failure path must not put the URL in the error', async () => {
  const { impl } = recordingFetch({ status: 403, body: { description: 'bot was blocked by the user' } });
  const r = await new TelegramTransport().send(TELEGRAM, CONFIGURED_ENV, { eventKey: 'k', fetchImpl: impl, retries: 0 });
  assert.equal(r.ok, false);
  assert.ok(!(r.error ?? '').includes('test-bot-token'));
  assert.ok(!(r.error ?? '').includes('api.telegram.org'));
});

test('a transport refuses a payload of the other kind rather than sending it somewhere odd', async () => {
  assert.equal((await new EmailTransport().send(TELEGRAM, CONFIGURED_ENV, { eventKey: 'k', fetchImpl: forbiddenFetch })).ok, false);
  assert.equal((await new TelegramTransport().send(EMAIL, CONFIGURED_ENV, { eventKey: 'k', fetchImpl: forbiddenFetch })).ok, false);
});

test('the staging recipient allowlist is the core\'s, character for character', () => {
  assert.ok(coreOutbox.includes('EMAIL_ALLOWED_RECIPIENTS'), 'the core still has the guard this one was copied from');
  assert.equal(allowedRecipient('', 'anyone@example.com'), true, 'an empty allowlist allows everyone');
  assert.equal(allowedRecipient(undefined, 'anyone@example.com'), true);
  // …unless the deployment declares that it must not reach a real address at
  // all, which is what the dark stack sets. "The dark stack keeps the email
  // allowlist ON" has to be true of the SEMANTICS, not only of a comment.
  assert.equal(allowedRecipient('', 'anyone@example.com', { requireAllowlist: true }), false, 'empty + required = nobody');
  assert.equal(allowedRecipient(undefined, 'anyone@example.com', { requireAllowlist: true }), false);
  assert.equal(allowedRecipient('a@x.com', 'a@x.com', { requireAllowlist: true }), true, 'a real allowlist still allows its members');
  assert.equal(allowedRecipient('a@x.com, B@X.com', 'b@x.com'), true, 'case-insensitive');
  assert.equal(allowedRecipient('a@x.com', 'b@x.com'), false);
});

test('the registry answers "can this be sent" without ever looking at a value', () => {
  const reg = new TransportRegistry();
  assert.deepEqual(reg.channels().sort(), ['email', 'telegram']);
  assert.equal(reg.get('inapp'), null, 'in-app is a row, not a transport');
  assert.equal(reg.enabled('email', UNCONFIGURED_ENV), false);
  assert.equal(reg.enabled('email', CONFIGURED_ENV), true);
  assert.equal(reg.enabled('telegram', UNCONFIGURED_ENV), false);
  assert.equal(reg.enabled('telegram', CONFIGURED_ENV), true);
});

/**
 * THE DARK STACK'S CONFIGURATION MUST MATCH ITS PROMISE.
 *
 * `services/notifications/wrangler.jsonc` env.dark says "a dark run must not be
 * able to mail a real customer" while shipping `NOTIFY_DELIVERY: "on"`. The
 * only thing that can make that true with an EMPTY `EMAIL_ALLOWED_RECIPIENTS`
 * is `EMAIL_ALLOWLIST_REQUIRED`, so the file is read here rather than trusted.
 */
test('env.dark cannot deliver mail to an unbounded set of recipients', () => {
  const raw = readFileSync(join(SERVICE_ROOT, 'wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const cfg = JSON.parse(raw) as { vars: Record<string, string>; env: { dark: { vars: Record<string, string> } } };
  const on = (v: string | undefined) => (v ?? '').trim().toLowerCase() === 'on';
  for (const [name, vars] of [['production', cfg.vars], ['dark', cfg.env.dark.vars]] as const) {
    const bounded = (vars.EMAIL_ALLOWED_RECIPIENTS ?? '').trim().length > 0 || on(vars.EMAIL_ALLOWLIST_REQUIRED);
    assert.ok(!on(vars.NOTIFY_DELIVERY) || bounded, `${name}: delivery is on with an unbounded recipient set`);
    assert.ok('EMAIL_ALLOWLIST_REQUIRED' in vars, `${name}: the var must be declared, or the preservation pass wipes it`);
  }
});
