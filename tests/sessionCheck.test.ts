/**
 * «Signed in» means THIS browser kept the session (sign-in fix, 2026-10-18).
 *
 * Every sign-in used to publish the POST's user and then call a `/me` refresh
 * that swallowed a guest answer and every error — so a browser that never
 * stored the `Secure` cookie (plain http, cookies blocked, a private tab, a
 * mail app's viewer) looked signed in for one page and was a guest on the
 * next, with nothing on screen to say why. src/lib/sessionCheck.ts decides
 * from a fresh /me; a check that FAILS must never fail a sign-in.
 *
 * The wiring is pinned too: every sign-in caller goes through
 * `adoptSession`, and none of them calls the forgiving `refreshUser` any more.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { decideSession } from '../src/lib/sessionCheck';
import { SESSION_NOT_KEPT } from '../src/components/auth/sessionStrings';

const A = { id: 'usr_a', name: 'A' };
const B = { id: 'usr_b', name: 'B' };

test('/me shows the same account the sign-in named: ok, and /me\'s user is published', () => {
  const fresh = { ...A, name: 'A (fresh from /me)' };
  assert.deepEqual(decideSession(A, { ok: true, user: fresh }), { status: 'ok', publish: fresh });
  // A sign-in that named nobody (the Telegram poll path) takes /me's word.
  assert.deepEqual(decideSession(undefined, { ok: true, user: A }), { status: 'ok', publish: A });
  assert.deepEqual(decideSession(null, { ok: true, user: A }), { status: 'ok', publish: A });
});

test('/me answers a guest: the browser did not keep the session — not_kept, nothing published', () => {
  assert.deepEqual(decideSession(A, { ok: true, user: null }), { status: 'not_kept' });
  assert.deepEqual(decideSession(undefined, { ok: true, user: null }), { status: 'not_kept' });
});

test('/me answers a DIFFERENT account: the new session was not kept — not_kept', () => {
  assert.deepEqual(decideSession(A, { ok: true, user: B }), { status: 'not_kept' });
});

test('a check that failed (network, timeout, 5xx, cancelled) never fails the sign-in', () => {
  assert.deepEqual(decideSession(A, { ok: false }), { status: 'ok', publish: A });
  assert.deepEqual(decideSession(undefined, { ok: false }), { status: 'ok', publish: 'keep' }, 'nothing to publish: keep the current state');
});

test('every sign-in caller adopts the session through the check, none through refreshUser', () => {
  const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
  const ctx = read('src/AuthContext.tsx');
  assert.match(ctx, /const adoptSession = useCallback\(/);
  assert.match(ctx, /clearApiSessionRequests\(\);\s*clearPrimedRequests\(\);/, 'requests of the guest that is leaving are cancelled first');
  assert.match(ctx, /api\.get<[^>]*>\(AUTH_ME_PATH, \{ signal: new AbortController\(\)\.signal \}\)/, 'the check never joins a coalesced anonymous /me');
  assert.match(ctx, /decideSession\(/);
  assert.match(ctx, /return adoptSession\(data\.user\);/, 'Google through the context is checked too');

  const auth = read('src/pages/Auth.tsx');
  assert.doesNotMatch(auth, /refreshUser/, 'Auth.tsx publishes no account without the check');
  // Password sign-in, sign-up and the finish link; Google (both branches) below.
  assert.equal((auth.match(/sessionKept\(await adoptSession\(/g) ?? []).length, 3, 'each Auth.tsx sign-in is checked');
  assert.match(auth, /outcome = await adoptSession\(r\?\.user\);/, 'Google with a referral is checked');
  assert.match(auth, /outcome = await loginWithGoogle\(credential\);/, 'Google without one is checked by the context');
  assert.match(auth, /if \(!sessionKept\(outcome\)\) return;/, 'the Google path is checked on both branches');

  for (const file of ['src/components/auth/CodeAuth.tsx', 'src/components/auth/TelegramAuth.tsx']) {
    const src = read(file);
    assert.doesNotMatch(src, /refreshUser/, `${file} publishes no account without the check`);
    assert.match(src, /await adoptSession\(/, file);
    assert.match(src, /sessionNotKeptText\(lang\)/, `${file} says why when the session was not kept`);
  }
  assert.equal((read('src/components/auth/CodeAuth.tsx').match(/await adoptSession\(/g) ?? []).length, 2, 'code sign-in and code sign-up');
});

test('the not-kept message exists in all three languages, Sorani written as Sorani', () => {
  for (const lang of ['ar', 'en', 'ckb'] as const) assert.ok(SESSION_NOT_KEPT[lang].length > 40, lang);
  assert.notEqual(SESSION_NOT_KEPT.ckb, SESSION_NOT_KEPT.ar, 'ckb is never a copy of the Arabic (docs/DECISIONS.md row 183)');
  assert.match(SESSION_NOT_KEPT.ckb, /وێبگەڕ/, 'the Sorani word for browser the auth screens already use');
  assert.match(SESSION_NOT_KEPT.en, /https/);
});
