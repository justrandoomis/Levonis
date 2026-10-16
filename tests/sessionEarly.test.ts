/**
 * THE SESSION AND THE COMMUNITY'S «OPEN TO ME?» LEAVE WITH THE ENTRY (speed
 * audit 2026-10-16, the /api/auth/me and community-gate findings).
 *
 * Measured live on a phone (Slow-4G, ×4 CPU): /api/auth/me left only from
 * AuthProvider's mount effect, after every chunk was parsed; the community
 * gate asked /api/community/access only once /me had answered; the card —
 * the whole page while the community is shut — drew only after both, one
 * round trip after another (/me 2446→2766, access 2868→3196, the card's h1 at
 * 3360 ms). Priming both at boot measured the card 0.5 s sooner.
 *
 * What this file holds:
 *   1. bootRequests starts /me on every page (last), and the access read on
 *      the gated paths of the main site only;
 *   2. the access read no longer waits for /me: it is asked under the
 *      cookie's own key and ADOPTED by the viewer's key once /me answers —
 *      never across a sign-in or sign-out;
 *   3. AuthContext and the access read take the primed requests; the gate
 *      still draws nothing until the session is known, so nothing on the card
 *      moves when /me lands.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUTH_ME_PATH, COMMUNITY_ACCESS_PATH, RESOLVE_PATH, bootRequests, clearPrimedRequests, isCommunityGatedPath, primeGet,
} from '../src/lib/bootFetch';
import { COMMUNITY_SESSION_KEY, communityAccessFor, resetCommunityAccessCache } from '../src/pages/community/access';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(() => {
  clearPrimedRequests();
  resetCommunityAccessCache();
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});
const browser = () => Object.defineProperty(globalThis, 'window', { value: {}, configurable: true });

/** A fetch that answers the access read and counts every request by path. */
function countingFetch(body: unknown = { closed: true, admin: false, may_enter: false }) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    calls.push(path);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}

test('boot starts the session on every page, last, and the gate\'s question on the gated pages of the main site only', () => {
  const start = (path: string, host = 'levonis-iq.com', inline: { kind?: unknown } | null = null) => bootRequests(path, inline, () => undefined, '', host);
  assert.deepEqual(start('/community'), [RESOLVE_PATH, COMMUNITY_ACCESS_PATH, AUTH_ME_PATH]);
  for (const path of ['/community', '/community/projects', '/community/projects/p1', '/community/store/ali3d', '/community/store/ali3d/p/x', '/community/saved', '/u/ali', '/requests', '/requests/r1', '/followed-stores']) {
    assert.ok(isCommunityGatedPath(path), `${path} is behind CommunityGate`);
    assert.ok(start(path, 'www.levonis-iq.com', { kind: 'main' }).includes(COMMUNITY_ACCESS_PATH), path);
  }
  for (const path of ['/', '/products', '/product/x', '/communityx', '/u', '/requestsx', '/cart', '/auth']) {
    assert.equal(isCommunityGatedPath(path), false, path);
    assert.equal(start(path).includes(COMMUNITY_ACCESS_PATH), false, path);
    assert.equal(start(path).at(-1), AUTH_ME_PATH, `${path}: the session is asked, after the page's own reads`);
  }
  // A store's host has no community routes (src/App.tsx StorefrontApp), nor does any other host.
  assert.deepEqual(start('/community', 'levonis-iq.com', { kind: 'merchant' }), [AUTH_ME_PATH]);
  assert.deepEqual(start('/community', 'shop.levonis-iq.com', { kind: 'main' }), [AUTH_ME_PATH]);
});

test('the access read is asked before /me answers and adopted by the viewer it turns out to be — one request', async () => {
  browser();
  const calls = countingFetch();
  primeGet(COMMUNITY_ACCESS_PATH); // what bootRequests does on /community
  const early = communityAccessFor(COMMUNITY_SESSION_KEY);
  assert.deepEqual(await early, { closed: true, admin: false, may_enter: false });
  // /me answers «guest»: the same answer, not a second question.
  assert.equal(communityAccessFor('guest'), early);
  assert.equal(communityAccessFor('guest'), early);
  assert.deepEqual(calls, [COMMUNITY_ACCESS_PATH], 'the primed request was taken, and nothing else was asked');
});

test('a member\'s session adopts the cookie\'s answer too: the server answered for that very cookie', async () => {
  browser();
  const calls = countingFetch({ closed: true, admin: false, may_enter: true });
  const early = communityAccessFor(COMMUNITY_SESSION_KEY);
  assert.equal((await early).may_enter, true);
  assert.equal(communityAccessFor('usr_allowed'), early);
  assert.equal(calls.length, 1);
});

test('never across a sign-in or sign-out: a session change in between drops the early answer', async () => {
  browser();
  const calls = countingFetch();
  const early = communityAccessFor(COMMUNITY_SESSION_KEY);
  await early;
  clearPrimedRequests(); // what login / logout / a new account does (src/AuthContext.tsx)
  const member = communityAccessFor('usr_member');
  assert.notEqual(member, early, 'a guest\'s card must not survive into the member\'s session');
  await member;
  assert.equal(calls.length, 2);
  // A viewer's own answer is never re-keyed to another viewer.
  assert.notEqual(communityAccessFor('usr_other'), member);
});

test('the clients take the primed requests, and the gate still waits for the session before drawing', () => {
  const auth = read('src/AuthContext.tsx');
  assert.match(auth, /\(takePrimedJson<\{ user: ApiUser \| null \}>\(AUTH_ME_PATH\) \?\? api\.get<\{ user: ApiUser \| null \}>\(AUTH_ME_PATH\)\)/);
  const access = read('src/pages/community/access.tsx');
  assert.match(access, /const primed = takePrimedJson<unknown>\(COMMUNITY_ACCESS_PATH\);/);
  assert.match(access, /const key = isLoaded \? user\?\.id \?\? 'guest' : SESSION_KEY;/, 'the read no longer waits for /me');
  assert.doesNotMatch(access, /if \(key === ''\) return;/);
  assert.match(access, /cache\.key === SESSION_KEY && key !== SESSION_KEY && cache\.epoch === primedSessionEpoch\(\)/, 'adopted only within one session');
  // The gate: no card and no page before the session is known (the sign-in button, the page's own reads).
  const gate = access.slice(access.indexOf('export function CommunityGate'));
  assert.match(gate, /if \(!isLoaded\) return <>\{fallback \?\? null\}<\/>;\s*if \(error !== null\)/);
  // An adopted answer keeps what it already said on screen.
  assert.match(access, /setAnswer\(\(current\) => \(current\.promise === promise \? current : \{ promise, access: null, error: null \}\)\);/);
});
