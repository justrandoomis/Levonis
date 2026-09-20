#!/usr/bin/env node
/**
 * The throwaway identity for `15 - Verify Live Auth`, as a row the live
 * database can take directly.
 *
 * WHY THE ACCOUNT IS INSERTED RATHER THAN REGISTERED. Since the email-first
 * sign-up (migration 0051, docs/SECURITY_AUDIT_2026-09.md), POST
 * /api/auth/register creates no account: it holds a pending row and mails a
 * link, and the account is born only when the person holding that link
 * chooses a password at /auth?finish=TOKEN. The token is stored hashed, so
 * nothing outside the inbox can finish that sign-up — the workflow included.
 * The live scenario still needs a signed-in user (Studio SSO, logout
 * liveness, a real verification mail, a real reset mail), so the workflow
 * creates the account the way the database ends up after a finished sign-up,
 * minus the verified stamp: one `users` row whose password hash is produced
 * by the SAME algorithm the Worker uses — worker/lib/crypto.ts hashPassword,
 * PBKDF2-SHA256, 100 000 iterations, a 16-byte random salt, stored as
 * pbkdf2$<iterations>$<salt b64url>$<hash b64url> — with email_verified_at
 * NULL so /verify-email/send has something real to send. Nothing else about
 * the row is special: the role is the schema's default (`customer` — the
 * CHECK constraint from migration 0001 admits nothing else for a person),
 * onboarding_state is the default `new`, exactly as /register used to leave
 * an account.
 *
 * WHAT IT PRINTS. The hash, alone, on stdout, so the caller can mask it
 * before anything else runs. The password is read from the environment
 * (never argv — `ps` shows argv), the INSERT is written to the file named by
 * --sql, and neither the address nor the password is echoed anywhere.
 *
 *   TEST_EMAIL=… TEST_PASSWORD=… node scripts/live-auth-identity.mjs --sql out.sql
 *
 * Optional: TEST_USERNAME (a fresh random handle otherwise), TEST_USER_ID (a
 * fresh id in the Worker's own `usr_<20 hex>` shape otherwise).
 *
 * The functions are exported so tests/liveAuthIdentity.test.ts can prove the
 * hash verifies with the Worker's own verifyPassword and the INSERT fits the
 * real migrated schema — the two claims this file makes.
 */
import { webcrypto } from 'node:crypto';
import { realpathSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Mirrors worker/lib/crypto.ts — change both or neither. */
export const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
/** worker/lib/http.ts EMAIL_RE, verbatim. */
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
/** worker/lib/usernames.ts SHAPE + length rules, verbatim. */
const USERNAME_SHAPE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const USERNAME_MIN = 3;
const USERNAME_MAX = 30;
const LOCALES = new Set(['en', 'ar', 'ku']);
/** worker/routes/auth.ts PASSWORD_MIN: a password the Worker would refuse
 *  at sign-up must not be what this identity is created with either. */
const PASSWORD_MIN = 8;

const b64url = (bytes) => Buffer.from(bytes).toString('base64url');

/**
 * The Worker's hashPassword, reproduced on Node's WebCrypto. Output shape and
 * parameters are identical: pbkdf2$100000$<22 chars>$<43 chars>.
 */
export async function hashPasswordLikeWorker(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN) {
    throw new Error(`the password must be at least ${PASSWORD_MIN} characters`);
  }
  const salt = webcrypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await webcrypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS }, key, 256);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64url(salt)}$${b64url(new Uint8Array(bits))}`;
}

/** worker/lib/crypto.ts newId('usr'): `usr_` + the first 20 hex chars of a UUID. */
export function newUserId() {
  return `usr_${webcrypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

/**
 * A handle that passes worker/lib/usernames.ts by construction: starts with a
 * letter, ends with an alphanumeric, one dash, 16 characters, never reserved
 * (no reserved handle carries a dash) — and recognisable as a probe's.
 *
 * THE SUFFIX IS DIGITS, AND THAT IS THE WHOLE POINT OF THIS COMMENT.
 *
 * It used to draw from `[a-z0-9]`, and "by construction" was then not true:
 * twelve random letters and digits spell words, including the leetspeak the
 * indecency filter is built to catch. Measured against the real
 * `usernameRejection` over 300,000 draws, 0.019% came back `indecent` —
 * `e2e-0hd884sh1tx9`, `e2e-fuqj2opwe9qc`, `e2e-zi7sh1tptyn4`. Small, and not
 * harmless: this generator feeds a `wrangler d1 execute` INSERT against the
 * LIVE database, so one run in five thousand would have written an account the
 * Worker itself refuses — a row the app would not accept from a person. It was
 * also a 3.7%-per-run flake in tests/liveAuthIdentity.test.ts, which draws 200
 * handles, and a test that fails for a reason nobody can reproduce is a test
 * people start re-running instead of reading.
 *
 * Digits cannot spell anything and leetspeak needs letters to obfuscate, so
 * the property is now STRUCTURAL rather than probable: 500,000 draws, zero
 * rejections, and tests/liveAuthIdentity.test.ts re-measures it on every run
 * so that changing this alphabet back fails loudly instead of rarely.
 *
 * 10^12 suffixes is ample for a probe handle — collision, not guessability, is
 * the only property that matters here.
 */
export function randomUsername() {
  const digits = '0123456789';
  const bytes = webcrypto.getRandomValues(new Uint8Array(12));
  return `e2e-${Array.from(bytes, (b) => digits[b % digits.length]).join('')}`;
}

const sqlString = (v) => `'${String(v).replace(/'/g, "''")}'`;

/**
 * The INSERT for one unverified, password-bearing account. Every value is
 * validated the way the Worker validates the same field, then quoted as a
 * SQL string literal (single quotes doubled), so the file is safe to hand to
 * `wrangler d1 execute --file` whatever the address looks like.
 */
export function identitySql({ id, email, username, passwordHash, name = 'LEVO live check', locale = 'en' }) {
  if (!/^usr_[0-9a-f]{20}$/.test(String(id))) throw new Error('id must be usr_<20 hex chars>');
  const mail = String(email ?? '').trim().toLowerCase();
  if (mail.length < 5 || mail.length > 320 || !EMAIL_RE.test(mail)) throw new Error('email is not a valid address');
  const handle = String(username ?? '').trim().toLowerCase();
  if (handle.length < USERNAME_MIN || handle.length > USERNAME_MAX || !USERNAME_SHAPE.test(handle) || /[._-]{2,}/.test(handle)) {
    throw new Error('username does not satisfy the Worker\'s username rules');
  }
  if (!/^pbkdf2\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/.test(String(passwordHash))) throw new Error('passwordHash is not in the Worker\'s pbkdf2 format');
  if (!LOCALES.has(locale)) throw new Error('locale must be en, ar or ku');
  if (typeof name !== 'string' || name.length > 100) throw new Error('name must be a string of at most 100 characters');
  return [
    '-- 15 - Verify Live Auth: the run\'s throwaway account. Unverified on purpose',
    '-- (the scenario asks it to verify), password hashed by the Worker\'s own',
    '-- PBKDF2 parameters, every other column the schema default.',
    'INSERT INTO users (id, email, username, name, password_hash, locale, email_verified_at)',
    `VALUES (${sqlString(id)}, ${sqlString(mail)}, ${sqlString(handle)}, ${sqlString(name)}, ${sqlString(passwordHash)}, ${sqlString(locale)}, NULL);`,
    '',
  ].join('\n');
}

async function main(argv, env) {
  const at = argv.indexOf('--sql');
  const out = at >= 0 ? argv[at + 1] : '';
  if (!out) {
    console.error('usage: TEST_EMAIL=… TEST_PASSWORD=… node scripts/live-auth-identity.mjs --sql <file>');
    return 2;
  }
  const email = env.TEST_EMAIL || '';
  const password = env.TEST_PASSWORD || '';
  if (!email || !password) {
    console.error('TEST_EMAIL and TEST_PASSWORD are required (from the environment, never argv)');
    return 2;
  }
  const hash = await hashPasswordLikeWorker(password);
  const sql = identitySql({
    id: env.TEST_USER_ID || newUserId(),
    email,
    username: env.TEST_USERNAME || randomUsername(),
    passwordHash: hash,
  });
  writeFileSync(out, sql, { mode: 0o600 });
  // The hash and nothing else: the caller masks this line before it uses it.
  process.stdout.write(`${hash}\n`);
  return 0;
}

const invokedDirectly = (() => {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`live-auth-identity: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  );
}
