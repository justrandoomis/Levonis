import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, ApiError, clearApiSessionRequests } from '../src/lib/api';
import { COST } from './fixtures/costlyProduct';
import { codeOf } from './fixtures/source';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('the first session lookup preserves opening reads made with that same cookie', async () => {
  let finish: (response: Response) => void = () => {};
  globalThis.fetch = (async (path: unknown) => String(path) === '/api/auth/me'
    ? Response.json({ success: true, user: { id: 'owner', can_view_cost: true } })
    : new Promise<Response>(resolve => { finish = resolve; })) as typeof fetch;
  const opening = api.get('/api/home/initial-cookie');
  await api.get('/api/auth/me');
  finish(Response.json({ success: true, price_iqd: 749000 }));
  assert.deepEqual(await opening, { success: true, price_iqd: 749000 });
  const auth = codeOf('src/AuthContext.tsx');
  assert.match(auth, /const sessionScope = useRef<string \| null>\(null\);/);
  assert.match(auth, /if \(sessionScope\.current !== null\) \{\s*clearApiSessionRequests\(\);\s*clearPrimedRequests\(\);\s*\}\s*sessionScope\.current = scope;/);
});

test('a same-account permissions refresh cancels old private reads before publishing the new scope', async () => {
  const reads: Array<(value: Response) => void> = [];
  globalThis.fetch = (async () => new Promise<Response>(resolve => reads.push(resolve))) as typeof fetch;
  const path = '/api/admin/products-v2/revoked-cost-fixture';
  const original = api.get(path);
  const refused = assert.rejects(original, (e: unknown) => e instanceof ApiError && e.code === 'ABORTED');
  clearApiSessionRequests();
  const next = api.get(path);
  reads[0](Response.json({ success: true, product_cost_iqd: COST.product }));
  await refused;
  // Completion of the earlier promise must not remove the new coalesced read.
  assert.equal(api.get(path), next);
  reads[1](Response.json({ success: true, price_iqd: 749000 }));
  assert.deepEqual(await next, { success: true, price_iqd: 749000 });
  const source = codeOf('src/AuthContext.tsx');
  const publisher = source.slice(source.indexOf('const setUser = useCallback'), source.indexOf('useEffect(purgeLegacyPrivateDrafts'));
  assert.match(publisher, /next\.id, next\.role, next\.admin_scope, next\.can_view_cost/);
  for (const reset of ['clearApiSessionRequests();', 'clearPrimedRequests();', 'clearPageCache();', 'privateDrafts.clear();']) {
    assert.ok(publisher.indexOf(reset) >= 0 && publisher.indexOf(reset) < publisher.indexOf('setSessionUser(next);'), reset);
  }
});

test('an owner request pending across sign-out cannot become the next account’s cost response', async () => {
  const reads: Array<(value: Response) => void> = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') return Response.json({ success: true });
    return new Promise<Response>(resolve => reads.push(resolve));
  }) as typeof fetch;
  const path = '/api/admin/products-v2/cost-session-fixture';
  const previous = api.get(path);
  // Attach the rejection handler before resolving either response.
  const previousResult = previous.then(value => ({ value }), error => ({ error }));
  await api.post('/api/auth/logout');
  const next = api.get(path);
  const nextResult = next.then(value => ({ value }), error => ({ error }));
  reads[0](Response.json({ success: true, product_cost_iqd: COST.product }));
  if (reads[1]) reads[1](Response.json({ success: false, code: 'COST_ACCESS_DENIED' }, { status: 403 }));
  const old = await previousResult;
  const current = await nextResult;
  assert.equal(reads.length, 2, 'the next account makes its own authenticated request');
  assert.ok('error' in old && old.error instanceof ApiError && old.error.code === 'ABORTED', 'late owner bytes never reach a still-mounted consumer');
  assert.ok('error' in current && current.error instanceof ApiError && current.error.code === 'COST_ACCESS_DENIED');
});

test('GETs carrying distinct guest capabilities never share their response', async () => {
  let reads = 0;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    reads++;
    return Response.json({ success: true, capability: new Headers(init?.headers).get('X-Guest-Token') });
  }) as typeof fetch;
  const [one, two] = await Promise.all([
    api.get<{ capability: string }>('/api/print-quote/fixture', { headers: { 'X-Guest-Token': 'first' } }),
    api.get<{ capability: string }>('/api/print-quote/fixture', { headers: { 'X-Guest-Token': 'second' } }),
  ]);
  assert.equal(reads, 2);
  assert.equal(one.capability, 'first');
  assert.equal(two.capability, 'second');
});
