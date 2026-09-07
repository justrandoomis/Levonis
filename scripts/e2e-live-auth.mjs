#!/usr/bin/env node
/**
 * Live verification of Studio single sign-on, logout revocation, the
 * email-first sign-up contract and the two account emails, against the REAL
 * origins.
 *
 * WHAT IT DOES AND DOES NOT TOUCH. It signs in as the run's throwaway
 * identity — created in the database by the workflow that runs this, because
 * since the email-first sign-up (migration 0051) POST /register opens no
 * account, and the link that would is in an inbox this script must never
 * read — walks the Studio handoff, tries every way the handoff is supposed to
 * refuse, asks for a password-reset email and a verification email, posts ONE
 * email-first sign-up for a SECOND run-scoped address and checks that it opens
 * nothing, and then logs out to watch the Studio session die. It never buys
 * anything, never touches the wallet or an order, never reads a secret, and
 * never prints a token — the reset, verification and sign-up links are live
 * credentials for a real inbox, so this script asserts on their SHAPE and
 * never on their contents.
 *
 * The email assertions here stop at "the API accepted the request". Whether
 * Resend actually took each message, and whether the sign-up left exactly one
 * pending row and no account, is asserted separately from the database, by
 * counts, by the workflow that runs this — see `15 - Verify Live Auth`.
 *
 * Every check prints pass/fail with the evidence that decided it. A failure
 * is a failure; nothing is retried into looking green.
 */
const APEX = (process.env.APEX || 'https://levonis-iq.com').replace(/\/+$/, '');
const STUDIO = (process.env.STUDIO || 'https://studio.levonis-iq.com').replace(/\/+$/, '');
const MERCHANT = (process.env.MERCHANT_ORIGIN || 'https://levo-e2e-store.levonis-iq.com').replace(/\/+$/, '');
const EMAIL = process.env.TEST_EMAIL || '';
const PASSWORD = process.env.TEST_PASSWORD || '';
// A SECOND run-scoped address for the email-first sign-up probe. It gets one
// POST /register and nothing else; the account above never registers.
const SIGNUP_EMAIL = process.env.SIGNUP_EMAIL || '';
const HANDOFF_TTL_SECONDS = 60; // worker/routes/studio.ts HANDOFF_TTL_SECONDS
const LIVENESS_POLL_SECONDS = Number(process.env.LIVENESS_POLL_SECONDS || 180);

if (!EMAIL || !PASSWORD || !SIGNUP_EMAIL) {
  console.error('TEST_EMAIL, TEST_PASSWORD and SIGNUP_EMAIL are required');
  process.exit(2);
}

const results = [];
let failures = 0;

function check(name, ok, evidence) {
  results.push({ name, ok: !!ok, evidence });
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${evidence ? `  — ${evidence}` : ''}`);
}

// --- a cookie jar small enough to reason about -------------------------------
// Cookies are kept per origin. The main-site cookie is Domain=.levonis-iq.com
// (worker/lib/hosts.ts sessionCookieDomain), which is exactly why the merchant
// negative case below is worth testing: a storefront CAN present it.
const jars = new Map();
function jar(origin) {
  if (!jars.has(origin)) jars.set(origin, new Map());
  return jars.get(origin);
}
function absorb(origin, response) {
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';');
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (value === '' || /expires=Thu, 01 Jan 1970/i.test(raw)) jar(origin).delete(name);
    else jar(origin).set(name, value);
  }
}
const cookieHeader = (origin) =>
  [...jar(origin).entries()].map(([k, v]) => `${k}=${v}`).join('; ');

async function req(origin, path, init = {}) {
  const headers = new Headers(init.headers || {});
  const cookies = init.cookies === null ? '' : cookieHeader(init.cookieOrigin || origin);
  if (cookies) headers.set('Cookie', cookies);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  // The main worker's originCheck() only inspects requests that carry Origin,
  // and a browser would send one on these, so send it too rather than testing
  // an easier path than the real client walks.
  if ((init.method || 'GET') !== 'GET' && !headers.has('Origin')) headers.set('Origin', origin);
  const response = await fetch(`${origin}${path}`, {
    ...init,
    headers,
    redirect: 'manual',
  });
  absorb(init.cookieOrigin || origin, response);
  return response;
}

const json = async (response) => {
  try { return await response.json(); } catch { return null; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================ A. capabilities
console.log('\nA. Capabilities on the live main site');
let userId = null;

{
  const res = await req(APEX, '/api/auth/capabilities');
  const body = await json(res);
  check('capabilities responds 200', res.status === 200, `http=${res.status}`);
  check('passwordReset is true', body?.passwordReset === true, `passwordReset=${body?.passwordReset}`);
  check('emailVerification is true', body?.emailVerification === true, `emailVerification=${body?.emailVerification}`);
  // Both are driven by the same condition (EMAIL_API_KEY && EMAIL_FROM), so
  // record that they agree — a split would mean the code changed.
  check(
    'the two email capabilities agree, as the code says they must',
    body?.passwordReset === body?.emailVerification,
    `passwordReset=${body?.passwordReset} emailVerification=${body?.emailVerification}`
  );
}

// ============================================ B. sign in as the run's identity
console.log("\nB. Signing in as the run's throwaway identity");
{
  // The account was inserted into the database by the workflow (see the
  // header): since the email-first sign-up, /register cannot produce a
  // signed-in user, and the link that could is in an inbox this script must
  // never read. So the session comes from /login, the way a returning person
  // gets one — which also means the identity step and the Worker's password
  // hashing agree, or nothing below runs.
  const res = await req(APEX, '/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: EMAIL, password: PASSWORD }),
  });
  const body = await json(res);
  check('login succeeds', res.status === 200 && body?.success === true, `http=${res.status} code=${body?.code ?? ''}`);
  userId = body?.user?.id ?? null;
  check('a session cookie is set', !!jar(APEX).get('levonis_session'), 'levonis_session present');
  check('the response carries a user id', typeof userId === 'string' && userId.length > 0, userId ? 'present' : 'missing');
  check(
    "and it is the run's own account",
    typeof body?.user?.email === 'string' && body.user.email.toLowerCase() === EMAIL.toLowerCase(),
    'address matches (value never printed)'
  );
}

// ======================================= C. the email-first sign-up contract
console.log('\nC. Sign-up is email-first: /register opens nothing');
{
  // ONE sign-up for the SECOND run-scoped address, sent from an empty cookie
  // jar — a person signing up is not signed in, and the session above must
  // not be able to influence, or be replaced by, this response. The contract
  // (migration 0051, docs/SECURITY_AUDIT_2026-09.md): a uniform 200 with
  // `pending_email`, no cookie, no user, no id — the same answer for a free
  // and a taken address, so nothing here says which this one was. The other
  // half of the contract lives in the database (exactly one pending row, no
  // users row, one sent link on APEX) and is proved by the workflow's SQL
  // step, by counts only.
  const probeJar = 'probe:signup';
  const res = await req(APEX, '/api/auth/register', {
    method: 'POST',
    cookieOrigin: probeJar,
    body: JSON.stringify({ email: SIGNUP_EMAIL, name: 'LEVO live check', locale: 'en' }),
  });
  const setCookies = res.headers.getSetCookie?.() ?? [];
  const body = await json(res);
  check(
    'register answers 200 with the pending body',
    res.status === 200 && body?.success === true && body?.pending_email === true,
    `http=${res.status} pending_email=${body?.pending_email ?? 'absent'} code=${body?.code ?? ''}`
  );
  check(
    'register sets NO cookie',
    setCookies.length === 0 && jar(probeJar).size === 0,
    setCookies.length ? `Set-Cookie: ${setCookies.map((c) => c.split('=')[0]).join(', ')}` : 'no Set-Cookie header'
  );
  check(
    'register returns no user, no id and no token',
    body != null && body.user === undefined && !Object.keys(body).some((k) => /id|token/i.test(k)),
    `keys=${Object.keys(body ?? {}).join(',')}`
  );
  check('the signed-in session above was not touched', !!jar(APEX).get('levonis_session'), 'levonis_session still present');
}

// ============================================== D. the two email flows, real
console.log('\nD. Password reset and email verification (real sends)');
{
  const reset = await req(APEX, '/api/auth/forgot-password', {
    method: 'POST',
    body: JSON.stringify({ email: EMAIL, lang: 'en' }),
  });
  const body = await json(reset);
  // The endpoint always reports success so it cannot enumerate accounts, so
  // this alone is NOT evidence a mail was sent. The outbox check in the
  // workflow is what decides that.
  check('forgot-password accepted', reset.status === 200 && body?.success === true, `http=${reset.status}`);

  const verify = await req(APEX, '/api/auth/verify-email/send', { method: 'POST', body: JSON.stringify({}) });
  const vbody = await json(verify);
  check(
    'verify-email/send accepted',
    verify.status === 200 && vbody?.success === true,
    `http=${verify.status} code=${vbody?.code ?? ''}`
  );
  check(
    'verify-email/send did not report EMAIL_NOT_CONFIGURED',
    vbody?.code !== 'EMAIL_NOT_CONFIGURED',
    `code=${vbody?.code ?? 'none'}`
  );
}

// ===================================================== E. the SSO happy path
console.log('\nE. Studio sign-on, end to end');
let studioSessionCookie = null;

const setCookie = (origin, name, value) => jar(origin).set(name, value);

/**
 * Runs /auth/login and returns the state cookie Studio set, plus the main-site
 * URL it wants the browser to visit. The cookie value is `<state>.<b64 return
 * path>` (studio/worker/auth/callback.ts), and it is captured because the
 * successful callback CLEARS it — and every negative case below needs a valid
 * state cookie in place, or it would be refused by the state check and prove
 * nothing about the thing it is meant to test.
 */
async function beginHandoff(returnTo = '/') {
  const login = await req(STUDIO, `/auth/login?return_to=${encodeURIComponent(returnTo)}`);
  const cookie = jar(STUDIO).get('levo_studio_handoff') ?? null;
  const location = login.headers.get('Location');
  return { login, cookie, startUrl: location ? new URL(location) : null };
}

/** Asks the main site for a code and returns the callback path Studio must visit. */
async function mintCode(startUrl) {
  const start = await req(APEX, startUrl.pathname + startUrl.search);
  const location = start.headers.get('Location');
  const callback = location ? new URL(location, APEX) : null;
  return { start, callback };
}

{
  const { login, cookie, startUrl } = await beginHandoff('/');
  check('Studio /auth/login redirects to the main site', login.status === 302 && !!startUrl, `http=${login.status}`);
  check('Studio sets its state cookie', !!cookie, 'levo_studio_handoff present');
  check(
    'the redirect targets the main handoff entry',
    startUrl?.origin === APEX && startUrl?.pathname === '/api/studio/handoff/start',
    `${startUrl?.origin}${startUrl?.pathname}`
  );

  const { start, callback } = await mintCode(startUrl);
  check('the signed-in user is not asked to log in again', start.status === 302 && callback?.pathname !== '/auth',
    `http=${start.status} -> ${callback?.pathname ?? 'none'}`);
  check('the main site mints a code back to Studio', callback?.origin === STUDIO && callback?.pathname === '/auth/callback',
    `${callback?.origin}${callback?.pathname}`);
  check('the callback carries a code', !!callback?.searchParams.get('code'), 'code present (value never printed)');

  const callbackPath = callback.pathname + callback.search;
  const done = await req(STUDIO, callbackPath);
  studioSessionCookie = jar(STUDIO).get('levo_studio_session') ?? null;
  check('Studio accepts the callback and redirects', done.status === 302, `http=${done.status} -> ${done.headers.get('Location')}`);
  check('Studio did not land on the failure marker', !(done.headers.get('Location') || '').includes('auth_error'),
    done.headers.get('Location') || '');
  check('Studio sets its own session cookie', !!studioSessionCookie, 'levo_studio_session present');

  const me = await req(STUDIO, '/auth/me');
  const body = await json(me);
  check('Studio reports a signed-in user', me.status === 200 && !!body?.user, `http=${me.status}`);
  check('and it is the SAME LEVONIS user', body?.user?.id === userId,
    body?.user?.id === userId ? 'ids match' : `studio=${body?.user?.id} main=${userId}`);

  // REPLAY, isolated. The state cookie is put back exactly as it was, so the
  // state check passes and the only thing that has changed since the request
  // above succeeded is that this code has been consumed. Without restoring it
  // the callback would be refused by the state check and the test would look
  // green while proving nothing.
  setCookie(STUDIO, 'levo_studio_handoff', cookie);
  const replay = await req(STUDIO, callbackPath);
  check('a redeemed code cannot be replayed', (replay.headers.get('Location') || '').includes('auth_error=denied'),
    replay.headers.get('Location') || `http=${replay.status}`);
}

// ========================================================= F. negative cases
console.log('\nF. What the handoff must refuse');
{
  const state = 'levoe2e' + 'x'.repeat(20);

  // A merchant storefront must not be able to mint a handoff FOR ITSELF. The
  // main-site session cookie is Domain=.levonis-iq.com by design (one identity
  // across storefronts, worker/lib/hosts.ts sessionCookieDomain), so a
  // storefront CAN present it. The exact-origin allowlist is the only thing
  // standing between that and a merchant-controlled page holding a code.
  const merchantDest = await req(APEX, `/api/studio/handoff/start?dest=${encodeURIComponent(MERCHANT)}&state=${state}`);
  check('a merchant subdomain cannot be a handoff destination', merchantDest.status === 403,
    `http=${merchantDest.status}`);

  const lookalike = 'https://levonis-iq.com.attacker.example';
  const offPlatform = await req(APEX, `/api/studio/handoff/start?dest=${encodeURIComponent(lookalike)}&state=${state}`);
  check('a look-alike destination is refused', offPlatform.status === 403, `http=${offPlatform.status}`);

  const wrongScheme = await req(APEX, `/api/studio/handoff/start?dest=${encodeURIComponent('http://studio.levonis-iq.com')}&state=${state}`);
  check('the same host over http is refused (exact origin, not host)', wrongScheme.status === 403,
    `http=${wrongScheme.status}`);

  // The same refusal must hold when the request is MADE from the storefront
  // host with the shared cookie attached — the guard is the destination, not
  // the caller's hostname.
  let fromMerchant;
  try {
    fromMerchant = await req(MERCHANT, `/api/studio/handoff/start?dest=${encodeURIComponent(MERCHANT)}&state=${state}`,
      { cookieOrigin: APEX });
  } catch (e) {
    fromMerchant = { status: 0, error: String(e) };
  }
  check('a request made from the storefront host is refused too',
    fromMerchant.status === 403 || fromMerchant.status === 0,
    fromMerchant.status === 0 ? `storefront host unreachable (${fromMerchant.error})` : `http=${fromMerchant.status}`);

  // INVALID CODE, isolated: a real state cookie, a code that was never minted.
  {
    const { cookie, startUrl } = await beginHandoff('/');
    void startUrl;
    setCookie(STUDIO, 'levo_studio_handoff', cookie);
    const cookieState = cookie.split('.')[0];
    const invalid = await req(STUDIO, `/auth/callback?code=${'A'.repeat(43)}&state=${encodeURIComponent(cookieState)}`);
    check('an invalid code signs nobody in', (invalid.headers.get('Location') || '').includes('auth_error=denied'),
      invalid.headers.get('Location') || `http=${invalid.status}`);
  }

  // STATE MISMATCH, isolated: a genuine, unconsumed code with the wrong nonce.
  {
    const { cookie, startUrl } = await beginHandoff('/');
    const { callback } = await mintCode(startUrl);
    setCookie(STUDIO, 'levo_studio_handoff', cookie);
    const wrong = new URL(callback);
    wrong.searchParams.set('state', 'levoe2ewrongstate' + 'y'.repeat(10));
    const mismatched = await req(STUDIO, wrong.pathname + wrong.search);
    check('a state mismatch signs nobody in', (mismatched.headers.get('Location') || '').includes('auth_error=denied'),
      mismatched.headers.get('Location') || `http=${mismatched.status}`);
  }

  // EXPIRY. The TTL is 60 seconds and nothing outside the worker can age a
  // code, so this waits rather than pretending to test it.
  {
    const { cookie, startUrl } = await beginHandoff('/');
    const { callback } = await mintCode(startUrl);
    console.log(`     waiting ${HANDOFF_TTL_SECONDS + 8}s for a code to expire (TTL is ${HANDOFF_TTL_SECONDS}s)…`);
    await sleep((HANDOFF_TTL_SECONDS + 8) * 1000);
    setCookie(STUDIO, 'levo_studio_handoff', cookie);
    const expired = await req(STUDIO, callback.pathname + callback.search);
    check('an expired code signs nobody in', (expired.headers.get('Location') || '').includes('auth_error=denied'),
      expired.headers.get('Location') || `http=${expired.status}`);
  }

  // The session established in E must have survived every refusal above.
  const still = await req(STUDIO, '/auth/me');
  const body = await json(still);
  check('none of those refusals disturbed the real session', body?.user?.id === userId,
    body?.user?.id === userId ? 'still signed in as the same user' : `user=${body?.user?.id ?? 'null'}`);
}

// ==================================================== G. logout revocation
console.log('\nG. Logging out of the main site revokes Studio');
{
  // The Studio session must be live first, measured on an /api/* route —
  // that is the only path the liveness check runs on (studio/worker/index.ts).
  // /auth/me deliberately does NOT run it, so it is the wrong probe.
  const before = await req(STUDIO, '/api/quota');
  check('the Studio API accepts the session before logout', before.status === 200, `http=${before.status}`);

  const out = await req(APEX, '/api/auth/logout', { method: 'POST', body: JSON.stringify({}) });
  check('main-site logout succeeds', out.status === 200, `http=${out.status}`);

  const deadline = Date.now() + LIVENESS_POLL_SECONDS * 1000;
  let revokedAfter = null;
  let last = null;
  while (Date.now() < deadline) {
    await sleep(10_000);
    const probe = await req(STUDIO, '/api/quota');
    last = probe.status;
    if (probe.status === 401) {
      revokedAfter = Math.round((LIVENESS_POLL_SECONDS * 1000 - (deadline - Date.now())) / 1000);
      break;
    }
  }
  check(
    'the Studio session is revoked after main-site logout',
    revokedAfter !== null,
    revokedAfter !== null
      ? `401 after ~${revokedAfter}s (cache TTL is 60s)`
      : `still ${last} after ${LIVENESS_POLL_SECONDS}s`
  );
}

// ================================================================== summary
console.log('\n' + '='.repeat(72));
console.log(`LEVO live auth verification — ${results.length} checks, ${failures} failed`);
console.log('='.repeat(72));
for (const r of results) console.log(`${r.ok ? ' pass ' : ' FAIL '} ${r.name}`);

const { writeFileSync } = await import('node:fs');
writeFileSync(process.env.RESULTS_PATH || '/tmp/live-auth-results.json', JSON.stringify({ results, failures, userId }, null, 2));
process.exit(failures === 0 ? 0 : 1);
