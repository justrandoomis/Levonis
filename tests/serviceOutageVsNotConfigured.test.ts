/**
 * «غير مهيَّأ» AND «معطّل مؤقتًا» ARE TWO DIFFERENT REFUSALS.
 *
 * THE DAY THIS COST. The owner reported that WhatsApp sign-up, sign-in and
 * notifications all showed «الدخول برمز عبر واتساب غير مُفعّل بعد — لم يهيّئه
 * المسؤول», and said, correctly, that everything WAS configured: the key, the
 * number, the provider, the GitHub Action.
 *
 * Measured on the live shop the same day (workflow 46, read-only):
 *
 *     whatsappOtp   : true         the key is on the Worker
 *     provider      : HTTP 200     the key is accepted, not rejected
 *     session status: logged_out   the shop's WhatsApp PHONE is unlinked
 *
 * So the deployment was configured and the channel was down — and the server
 * said exactly that, naming the road that still worked: 503
 * `WHATSAPP_UNAVAILABLE`, «واتساب غير متاح حالياً — استخدم تيليغرام أو البريد».
 *
 * `isNotConfigured` answered `true` for it, because it read only the STATUS
 * (`e.status === 503`) and `unavailable()` is a 503 for BOTH families. The
 * client then discarded the server's sentence, replaced the whole screen with
 * a warning blaming the administrator, and took the alternative away with it.
 *
 * These tests pin the distinction on both sides of the wire, because a fix on
 * only one of them decays: the client rule is meaningless if the server stops
 * naming its codes this way, and the server's codes are meaningless if the
 * client goes back to reading the status.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ApiError, isNotConfigured, isServiceOutage } from '../src/lib/api';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

/** `ApiError(status, message, code)` — status first; see src/lib/api.ts. */
const err = (status: number, code?: string) => new ApiError(status, 'x', code);

// =========================================================================
// THE PREDICATE
// =========================================================================

test('a channel that is DOWN is not a channel nobody configured', () => {
  const down = err(503, 'WHATSAPP_UNAVAILABLE');
  assert.equal(isServiceOutage(down), true, 'this is the live logged-out session');
  assert.equal(
    isNotConfigured(down),
    false,
    'answering true here is what printed «لم يهيّئه المسؤول» over a configured shop'
  );
});

test('Telegram has the same two families, and the same trap', () => {
  assert.equal(isServiceOutage(err(503, 'TELEGRAM_UNAVAILABLE')), true);
  assert.equal(isNotConfigured(err(503, 'TELEGRAM_UNAVAILABLE')), false);
});

test('a deployment with no provider is still reported as not configured', () => {
  for (const code of [
    'WHATSAPP_NOT_CONFIGURED',
    'EMAIL_NOT_CONFIGURED',
    'GOOGLE_NOT_CONFIGURED',
    'R2_NOT_CONFIGURED',
  ]) {
    assert.equal(isNotConfigured(err(503, code)), true, `${code} must keep hiding its control`);
    assert.equal(isServiceOutage(err(503, code)), false);
  }
});

/**
 * Two Telegram refusals carry NO code (worker/routes/auth.ts:1298, :1450) and
 * genuinely mean "not configured". Narrowing the default would have turned a
 * correctly hidden control into a dead button — a second bug pointing the
 * other way.
 */
test('a 503 with no code keeps the old answer, deliberately', () => {
  assert.equal(isNotConfigured(err(503)), true);
  assert.equal(isServiceOutage(err(503)), false);
});

test('nothing but a 503 is either of these', () => {
  for (const status of [400, 401, 403, 404, 429, 500, 502]) {
    assert.equal(isNotConfigured(err(status, 'WHATSAPP_NOT_CONFIGURED')), false);
    assert.equal(isServiceOutage(err(status, 'WHATSAPP_UNAVAILABLE')), false);
  }
  assert.equal(isNotConfigured(new Error('boom')), false);
  assert.equal(isServiceOutage(null), false);
});

// =========================================================================
// THE SERVER'S HALF OF THE CONTRACT
// =========================================================================

test('the server still names the logged-out session as an OUTAGE, not a misconfiguration', () => {
  const src = read('worker/routes/auth.ts');
  // The two codes the client's rule depends on. If either is renamed, the
  // client silently goes back to blaming the administrator.
  assert.match(src, /'WHATSAPP_UNAVAILABLE'/, 'the session-down refusal keeps its OUTAGE name');
  assert.match(src, /'WHATSAPP_NOT_CONFIGURED'/, 'and the no-key refusal keeps its CONFIG name');
});

test('the client screen does not blank itself for an outage', () => {
  const src = read('src/components/auth/CodeAuth.tsx');
  // `setNotConfigured(true)` replaces the whole component, taking the channel
  // switcher and the retry with it. An outage must not reach that call.
  const outage = src.indexOf('isServiceOutage(e)');
  const notConfigured = src.indexOf('isNotConfigured(e)');
  assert.ok(outage > 0, 'the outage branch must exist');
  assert.ok(
    outage < notConfigured,
    'the outage must be answered BEFORE the not-configured branch that blanks the screen'
  );
});

// =========================================================================
// WHAT THE SHOPPER IS PROMISED
// =========================================================================

/**
 * `channelsLive()` reads the session from a cache that only a FAILED SEND ever
 * wrote, so a logged-out shop kept advertising WhatsApp until some customer
 * was the one who found out. The admin diagnostics route is the one place that
 * asks the provider outright; it now records what it learns.
 */
test('the admin probe records the session state it just measured', () => {
  const src = read('worker/routes/admin.ts');
  assert.match(src, /recordSessionOutage/, 'a down session must be written where channelsLive reads it');
  assert.match(src, /clearSessionOutage/, 'and a recovered one must clear it');
});
