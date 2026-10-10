import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, get, stubApp, pending } from './fixtures/app';
import { COST, leaks } from './fixtures/costlyProduct';
import { miscRoutes } from '../worker/routes/misc';
import { printQuoteRoutes } from '../worker/routes/printQuote';

test('a deployed privacy fix never replays the previous public settings or calculator cache entry', async () => {
  const old = (globalThis as { caches?: unknown }).caches;
  const entries = new Map<string, Response>();
  const paths = ['/api/settings/public', '/api/print-quote/materials'];
  for (const path of paths) entries.set(`https://localhost${path}`, Response.json({ margin_percent: COST.optionAdjust }, {
    headers: { 'Cache-Control': 'public, max-age=60, s-maxage=120', ETag: 'W/"old-cost-projection"' },
  }));
  Object.assign(globalThis, { caches: { default: {
    match: async (key: Request) => entries.get(key.url)?.clone(),
    put: async (key: Request, response: Response) => { entries.set(key.url, response); },
    delete: async (key: Request) => entries.delete(key.url),
  } } });
  const raw = freshDb();
  try {
    const app = stubApp(asD1(raw), null, a => {
      a.route('/api', miscRoutes);
      a.route('/api/print-quote', printQuoteRoutes);
    });
    for (const path of paths) {
      const result = await get(app, path, { 'If-None-Match': 'W/"old-cost-projection"' });
      assert.equal(result.status, 200, `${path}: an old ETag cannot confirm a private stale body`);
      const body = await result.json();
      assert.deepEqual(leaks(body), [], path);
      assert.equal(Object.hasOwn(body as object, 'margin_percent'), false, path);
      await Promise.all(pending);
      const cached = await get(app, path);
      assert.deepEqual(await cached.json(), body, 'the corrected result is still cached');
    }
  } finally {
    raw.close();
    if (old === undefined) delete (globalThis as { caches?: unknown }).caches;
    else Object.assign(globalThis, { caches: old });
  }
});
