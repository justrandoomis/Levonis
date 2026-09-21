/**
 * LINKING TELEGRAM MUST GIVE THE ACCOUNT ITS PHONE.
 *
 * `/api/telegram/link/confirm` wrote `telegram_links.phone_e164` and stopped,
 * while every other reader in this codebase asks `users.phone_e164`. Two of the
 * owner's reports were that one gap: WhatsApp had no destination to offer
 * («لا يوجد خيار لربط الواتساب» — channelReadiness answered
 * ACCOUNT_NO_DESTINATION with no action), and the number visible in Settings
 * never reached the profile screen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tg = readFileSync(join(ROOT, 'worker/routes/telegram.ts'), 'utf8');
const auth = readFileSync(join(ROOT, 'worker/routes/auth.ts'), 'utf8');

const STAMP =
  /UPDATE users SET phone_e164 = \?1\s*\n\s*WHERE id = \?2 AND phone_e164 IS NULL\s*\n\s*AND NOT EXISTS \(SELECT 1 FROM users WHERE phone_e164 = \?1\)/;

test('the link path stamps the account phone, exactly as the login path does', () => {
  assert.match(tg, STAMP, 'link/confirm self-heals users.phone_e164');
  assert.match(auth, STAMP, 'and the login path it was copied from still does');

  // The guards are the whole safety argument, so pin them rather than the
  // statement's shape alone: it must never overwrite a number the account
  // holds, and never take one another account holds.
  const m = STAMP.exec(tg)![0];
  assert.match(m, /phone_e164 IS NULL/, 'never overwrites an existing number');
  assert.match(m, /NOT EXISTS \(SELECT 1 FROM users WHERE phone_e164 = \?1\)/, 'never steals another account’s');
});

test('it runs AFTER the link is committed, and cannot undo it', () => {
  const at = tg.indexOf('UPDATE users SET phone_e164');
  const audit = tg.indexOf("'telegram.link_confirmed'");
  assert.ok(audit > 0 && at > audit, 'the stamp follows the confirmed-link audit, so the link is already written');

  // Swallowed like the primary-channel write beside it: a failure here loses a
  // convenience, and must never fail a link the customer has already proven.
  const tail = tg.slice(at, at + 600);
  assert.match(tail, /catch \(e\) \{[\s\S]{0,200}console\.error\('phone_e164 self-heal failed/);
  assert.ok(!/throw/.test(tail.slice(0, tail.indexOf('catch'))), 'nothing between the update and the catch throws');
});

test('the readers this unblocks all ask users.phone_e164', () => {
  // If these ever move to another column the stamp above stops being the fix,
  // so the test names them.
  const readiness = readFileSync(join(ROOT, 'worker/lib/channelReadiness.ts'), 'utf8');
  assert.match(readiness, /phone_e164/, 'channelReadiness resolves a WhatsApp destination from it');
  assert.match(readiness, /ACCOUNT_NO_DESTINATION/, 'and that is the blocker it reports without one');
  const types = readFileSync(join(ROOT, 'worker/lib/types.ts'), 'utf8');
  assert.match(types, /phone_e164/, 'publicUser projects it to the client');
});
