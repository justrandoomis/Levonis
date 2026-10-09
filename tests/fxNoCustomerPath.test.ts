/**
 * THE CUSTOMER'S REQUEST NEVER REACHES AN FX PROVIDER (FX programme plan §33;
 * the owner's §35 test 23).
 *
 * Product pages, cards, the listing, search, the quote, the cart, the checkout
 * quote and the public settings read STORED figures only — the final prices,
 * and the one stored display rate. The providers are imported by the
 * scheduler alone, and the scheduler by the cron (worker/index.ts) and the
 * owner's routes alone. Runtime: the whole Worker answers the storefront with
 * the key configured and the providers answering, while a spy counts every
 * request to iraqsm.com and the ECB — it must stay at zero.
 *
 * Run: node --import tsx --test tests/fxNoCustomerPath.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import worker from '../worker/index';
import { ROOT } from './fixtures/d1';
import { APEX, asD1, ctx, freshDb, providerFetch } from './fixtures/app';
import { LIVE_PRODUCTS, seedLiveCatalog } from './fixtures/liveCatalog';
import { GOOD_KEY, applyRate, ecbBody, iqwealthBody } from './fixtures/fx';

test('storefront never calls FX APIs: home, listing, product, search, quote, cart, checkout quote and public settings', async () => {
  const raw = freshDb();
  raw.exec('PRAGMA foreign_keys = OFF;');
  seedLiveCatalog(raw);
  applyRate(raw, 'USD_IQD', '1660');
  const env = {
    DB: asD1(raw),
    STORE_ROOT_DOMAIN: APEX,
    APP_ORIGIN: `https://${APEX}`,
    INITIAL_ADMIN_EMAIL: 'boss@x.co',
    EXTRA_ALLOWED_ORIGINS: '',
    IRAQ_PARALLEL_FX_API_KEY: GOOD_KEY,
    ASSETS: { fetch: async () => new Response('<!doctype html><html><head></head><body></body></html>', { headers: { 'content-type': 'text/html' } }) },
  };
  providerFetch.handler = async (url) => (new URL(url).hostname === 'iraqsm.com' ? new Response(iqwealthBody(), { status: 200 }) : new Response(ecbBody(), { status: 200 }));
  const before = providerFetch.attempts.length;
  const slug = LIVE_PRODUCTS[0]!.slug;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await worker.fetch(
      new Request(`https://${APEX}${path}`, {
        method,
        headers: { Host: APEX, accept: 'application/json', 'CF-Connecting-IP': '9.9.9.9', ...(body ? { 'content-type': 'application/json', origin: `https://${APEX}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      }),
      env as never,
      ctx
    );
    await res.text();
    return res.status;
  };
  const statuses: Record<string, number> = {};
  try {
    for (const [method, path, body] of [
      ['GET', '/', undefined],
      ['GET', `/p/${slug}`, undefined],
      ['GET', '/api/home', undefined],
      ['GET', '/api/home/sections', undefined],
      ['GET', '/api/products', undefined],
      ['GET', '/api/products?q=bambu', undefined],
      ['GET', `/api/products/${slug}`, undefined],
      ['POST', `/api/products/${slug}/quote`, { qty: 1 }],
      ['GET', '/api/cart', undefined],
      ['POST', '/api/orders/quote', { items: [{ slug, qty: 1 }] }],
      ['GET', '/api/settings/public', undefined],
      ['GET', '/api/public/v1/products', undefined],
    ] as const) {
      statuses[`${method} ${path}`] = await call(method, path, body);
    }
  } finally {
    providerFetch.handler = null;
  }
  assert.equal(providerFetch.attempts.length - before, 0, `a storefront request reached a provider: ${JSON.stringify(providerFetch.attempts.slice(before))}`);
  assert.equal(statuses['GET /api/home'], 200);
  assert.equal(statuses['GET /api/settings/public'], 200);
  assert.equal(statuses[`GET /api/products/${slug}`], 200);
});

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) tsFiles(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}
const importers = (pattern: RegExp) =>
  [...tsFiles(join(ROOT, 'worker')), ...tsFiles(join(ROOT, 'src')), ...tsFiles(join(ROOT, 'packages')), ...tsFiles(join(ROOT, 'services'))]
    .filter((f) => pattern.test(readFileSync(f, 'utf8')))
    .map((f) => relative(ROOT, f))
    .sort();

test('static: only scheduler.ts imports the providers; only index.ts and adminPricing.ts import the scheduler', () => {
  const providerImporters = importers(/from\s+['"][^'"]*\/providers\/(iqwealth|ecb|transport)['"]|from\s+['"]\.\/(iqwealth|ecb|transport)['"]/).filter((f) => !f.startsWith('worker/lib/fx/providers/'));
  assert.deepEqual(providerImporters, ['worker/lib/fx/scheduler.ts']);
  assert.deepEqual(importers(/from\s+['"][^'"]*fx\/scheduler['"]|from\s+['"]\.\/scheduler['"]/), ['worker/index.ts', 'worker/routes/adminPricing.ts']);
  // The client never names a provider endpoint or the key. The one mention of
  // IQWealth's site is the attribution link its terms ask for, in the top-bar
  // menu (plan §13, §14.4 risk 3) — a link the reader follows, never a request.
  for (const f of tsFiles(join(ROOT, 'src'))) {
    const code = readFileSync(f, 'utf8');
    assert.doesNotMatch(code, /iraqsm\.com\/|eurofxref|ecb\.europa\.eu\/stats|IRAQ_PARALLEL_FX_API_KEY/, relative(ROOT, f));
    if (/iraqsm\.com/.test(code)) {
      assert.equal(relative(ROOT, f), 'src/components/LangThemePanel.tsx', `${relative(ROOT, f)} names IQWealth's host`);
      assert.deepEqual(code.match(/[^'"`\s]*iraqsm\.com[^'"`\s]*/g), ['https://iraqsm.com'], 'only the bare attribution link');
    }
  }
});

test('the browser cannot reach a provider either: the CSP connect-src names neither host', () => {
  const policy = readFileSync(join(ROOT, 'worker/lib/securityPolicy.ts'), 'utf8');
  assert.match(policy, /connect-src/);
  assert.doesNotMatch(policy, /iraqsm|ecb\.europa/);
});
