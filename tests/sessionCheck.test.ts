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
import { MAX_SUPERSEDED_READS, createSessionAdopter, decideSession, notKeptNext } from '../src/lib/sessionCheck';
import { ACCOUNT_CREATED_NOT_KEPT, SESSION_NOT_KEPT } from '../src/components/auth/sessionStrings';
import { ApiError, api, clearApiSessionRequests } from '../src/lib/api';

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
  assert.match(ctx, /const adoptSession = useMemo\(\s*\(\) =>\s*createSessionAdopter<ApiUser>\(\{/, 'one adopter per provider: one adoption in flight at a time');
  assert.match(ctx, /clear: \(\) => \{\s*clearApiSessionRequests\(\);\s*clearPrimedRequests\(\);/, 'requests of the guest that is leaving are cancelled first');
  assert.match(ctx, /api\.get<[^>]*>\(AUTH_ME_PATH, \{ signal: new AbortController\(\)\.signal \}\)/, 'the check never joins a coalesced anonymous /me');
  assert.match(ctx, /isSuperseded: \(err\) => err instanceof ApiError && err\.code === 'ABORTED'/, 'a /me cancelled by an epoch bump is superseded, not failed');
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

// ------------------------------------------------ one adoption at a time (review, 2026-10-18)

type U = { id: string };

/** The real API client under a stubbed fetch: /me answers `me()` after `delayMs`. */
function stubFetch(me: () => U | null, delayMs = 20) {
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    calls.push(path);
    await new Promise((r) => setTimeout(r, delayMs));
    if (path.includes('/telegram/status')) return new Response(JSON.stringify({ success: true, state: 'completed' }), { headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ success: true, user: me() }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

function realAdopter() {
  const published: U[] = [];
  let clears = 0;
  const adopt = createSessionAdopter<U>({
    clear: () => {
      clears++;
      clearApiSessionRequests();
    },
    readMe: async () => (await api.get<{ user?: U | null }>('/api/auth/me', { signal: new AbortController().signal }))?.user ?? null,
    isSuperseded: (err) => err instanceof ApiError && err.code === 'ABORTED',
    publish: (u) => published.push(u),
  });
  return { adopt, published, clears: () => clears };
}

test('THE RACE: two «completed» polls at once adopt ONE session, and neither navigates a guest', async () => {
  // Telegram's wake handler fires on focus, visibilitychange and pageshow
  // together: two status polls, two «completed», two adoptions. The second
  // used to bump the epoch under the first one's /me, which then read
  // ABORTED as an unanswered check: 'ok', nobody published, a guest navigated.
  const f = stubFetch(() => ({ id: 'u1' }));
  try {
    const { adopt, published, clears } = realAdopter();
    const order: string[] = [];
    const finish = async (tag: string) => {
      const kept = await adopt();
      order.push(`${tag}:${kept}:${published.at(-1)?.id ?? 'nobody'}`);
    };
    // One flow, one token: the two wake-ups poll the same path.
    const poll = async (tag: string) => {
      const data = await api.get<{ state: string }>('/api/auth/telegram/status?token=flow1');
      if (data.state === 'completed') await finish(tag);
    };
    await Promise.all([poll('A'), poll('B')]);
    assert.deepEqual(order.sort(), ['A:ok:u1', 'B:ok:u1'], 'both callers see the adopted account');
    assert.equal(clears(), 1, 'the leaving guest is cleared once, not once per caller');
    assert.equal(f.calls.filter((c) => c.endsWith('/api/auth/me')).length, 1, 'one /me for one sign-in moment');
    assert.deepEqual(published.map((u) => u.id), ['u1']);
  } finally {
    f.restore();
  }
});

test('a /me cancelled by another session change is asked again — never read as a failed check', async () => {
  // An outside epoch bump (a logout, another account published) lands while
  // the check's /me is on the wire.
  let answer: U | null = { id: 'u1' };
  const f = stubFetch(() => answer, 30);
  try {
    const { adopt, published } = realAdopter();
    const pending = adopt({ id: 'u1' });
    setTimeout(() => clearApiSessionRequests(), 5);
    assert.equal(await pending, 'ok');
    assert.deepEqual(published.map((u) => u.id), ['u1'], 'published from the second, answered /me');
    assert.equal(f.calls.filter((c) => c.endsWith('/api/auth/me')).length, 2, 'the superseded /me was asked again');

    // …and the retry's answer decides, a guest included.
    answer = null;
    const second = adopt({ id: 'u1' });
    setTimeout(() => clearApiSessionRequests(), 5);
    assert.equal(await second, 'not_kept', 'a guest behind a superseded read is still a session not kept');
  } finally {
    f.restore();
  }
});

test('a /me cancelled every time gives up after a bound, and only then counts as unanswered', async () => {
  let reads = 0;
  const adopt = createSessionAdopter<U>({
    clear: () => {},
    readMe: async () => {
      reads++;
      throw new ApiError(0, 'cancelled', 'ABORTED');
    },
    isSuperseded: (err) => err instanceof ApiError && err.code === 'ABORTED',
    publish: () => {},
  });
  assert.equal(await adopt({ id: 'u1' }), 'ok');
  assert.equal(reads, MAX_SUPERSEDED_READS);
  // A real failure (network, 5xx) is not retried: one read, and it never fails the sign-in.
  let failing = 0;
  const flaky = createSessionAdopter<U>({
    clear: () => {},
    readMe: async () => {
      failing++;
      throw new ApiError(0, 'network', 'NETWORK');
    },
    isSuperseded: (err) => err instanceof ApiError && err.code === 'ABORTED',
    publish: () => {},
  });
  assert.equal(await flaky({ id: 'u1' }), 'ok');
  assert.equal(failing, 1);
});

test('after an adoption settles the next one runs on its own', async () => {
  const f = stubFetch(() => ({ id: 'u1' }), 1);
  try {
    const { adopt, clears } = realAdopter();
    assert.equal(await adopt(), 'ok');
    assert.equal(await adopt(), 'ok');
    assert.equal(clears(), 2, 'a later sign-in is its own moment');
  } finally {
    f.restore();
  }
});

test('TelegramAuth handles «completed» once per flow, and a new flow may finish again', () => {
  const src = readFileSync(join(ROOT, 'src/components/auth/TelegramAuth.tsx'), 'utf8');
  const finish = src.slice(src.indexOf('const finish = useCallback('), src.indexOf('const fetchStatus = useCallback('));
  assert.match(finish, /if \(finishingRef\.current\) return;\s*finishingRef\.current = true;/, 'a second finish returns before adopting or navigating');
  const reset = src.slice(src.indexOf('const reset = useCallback('), src.indexOf('const finish = useCallback('));
  assert.match(reset, /finishingRef\.current = false;/, 'reset opens the way for the next flow');
});

// ------------------------------------------------ an account was created, the session was not kept

test('a sign-in may be retried; a sign-up that CREATED the account offers signing in instead', () => {
  assert.deepEqual(notKeptNext(false), { message: 'SESSION_NOT_KEPT', retry: true });
  assert.deepEqual(notKeptNext(false, 'a@b.co'), { message: 'SESSION_NOT_KEPT', retry: true });
  assert.deepEqual(notKeptNext(true, ' new@example.com '), { message: 'ACCOUNT_CREATED_NOT_KEPT', retry: false, signInAs: 'new@example.com' });
  assert.deepEqual(notKeptNext(true, '+9647701234567'), { message: 'ACCOUNT_CREATED_NOT_KEPT', retry: false, signInAs: '+9647701234567' });
  assert.deepEqual(notKeptNext(true, null), { message: 'ACCOUNT_CREATED_NOT_KEPT', retry: false, signInAs: '' });
});

test('the paths that CREATE an account all take the no-retry road', () => {
  const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
  const auth = read('src/pages/Auth.tsx');
  // The e-mailed finish link (/signup/complete) and a password sign-up (/register).
  assert.match(auth, /sessionKept\(await adoptSession\(r\?\.user\), \{ identifier: createdEmail \}\)/, 'the finish link: account created');
  assert.match(auth, /sessionKept\(await adoptSession\(created\.user\), \{ identifier: trimmedEmail \}\)/, 'a password sign-up: account created');
  assert.match(auth, /sessionKept\(await adoptSession\(r\?\.user\)\)\) return;\s*setSucceeded\(true\); \/\/ the server answered AND/, 'a password sign-in may simply be retried');
  // The screen that replaces the spent one: what happened, and only «sign in».
  const screen = auth.slice(auth.indexOf("screenKey = 'created-not-kept';"), auth.indexOf('const withGoogle ='));
  assert.match(screen, /accountCreatedNotKeptText\(lang\)/);
  assert.match(screen, /onClick=\{signInToCreatedAccount\}[^>]*>\s*\{s\.signInCta\}/, 'the one action is signing in');
  assert.doesNotMatch(screen, /FillButton|type="submit"|finishCta|createCta/, 'no retry on that screen');
  const signIn = auth.slice(auth.indexOf('const signInToCreatedAccount = () => {'), auth.indexOf('const clearMessages = () => {'));
  assert.match(signIn, /if \(finishToken\) leaveFinish\('signin'\);\s*else switchView\('signin'\);/, 'the spent finish link is left behind');
  assert.match(signIn, /if \(identifier\) setEmail\(identifier\);/, 'the address or number is filled in');
  // Every CodeAuth and TelegramAuth on the page reports a created account back to it.
  for (const tag of ['CodeAuth', 'TelegramAuth']) {
    const uses = auth.split(`<${tag}`).slice(1).map((rest) => rest.slice(0, rest.indexOf('/>')));
    assert.ok(uses.length >= 2, tag);
    for (const props of uses) assert.match(props, /onAccountCreatedNotKept=\{showCreatedNotKept\}/, `a <${tag}> without the created-account road`);
  }

  // A code sign-up (/signup/otp-complete) spent its ticket.
  const code = read('src/components/auth/CodeAuth.tsx');
  const create = code.slice(code.indexOf('const createAccount = useCallback('), code.indexOf('if (notConfigured)'));
  assert.match(create, /notKeptNext\(true, identifier\)/);
  assert.match(create, /onAccountCreatedNotKept\(next\.signInAs\)/);
  assert.doesNotMatch(create, /sessionNotKeptText/, 'never «try again» after the account exists');
  // A Telegram sign-up: the server says whether this completion created the account.
  const tg = read('src/components/auth/TelegramAuth.tsx');
  assert.match(tg, /notKeptNext\(created \?\? purpose === 'signup', phone\.e164 \?\? ''\)/);
  assert.match(tg, /await finish\(done\?\.user, typeof done\?\.created === 'boolean' \? done\.created : undefined\);/);
});

test('the account-created message exists in all three languages, Sorani written as Sorani', () => {
  for (const lang of ['ar', 'en', 'ckb'] as const) assert.ok(ACCOUNT_CREATED_NOT_KEPT[lang].length > 40, lang);
  assert.notEqual(ACCOUNT_CREATED_NOT_KEPT.ckb, ACCOUNT_CREATED_NOT_KEPT.ar, 'ckb is never a copy of the Arabic (docs/DECISIONS.md row 183)');
  assert.match(ACCOUNT_CREATED_NOT_KEPT.ar, /^أُنشئ حسابك، لكن هذا المتصفح لم يحتفظ بتسجيل الدخول/);
  assert.match(ACCOUNT_CREATED_NOT_KEPT.en, /^Your account was created, but this browser did not keep you signed in/);
  assert.match(ACCOUNT_CREATED_NOT_KEPT.ckb, /هەژمارەکەت دروستکرا/);
  assert.doesNotMatch(ACCOUNT_CREATED_NOT_KEPT.en, /try again/i, 'no retry is offered');
});
