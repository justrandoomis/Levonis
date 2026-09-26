/**
 * A LOCAL, READ-ONLY CATALOGUE API FOR THE DISCOVERY SCREENSHOTS.
 *
 * `/api/catalog/*` and the listing parameters of `/api/products` are new
 * (catalog discovery S1) and are not deployed yet, so the live shop cannot
 * answer them. This serves them from the REAL Worker routes
 * (worker/routes/catalog.ts, worker/routes/products.ts) over an in-memory
 * SQLite database with every migration applied and the live catalogue of
 * 2026-09-25 seeded (tests/fixtures/liveCatalog.ts) — and, when the live shop
 * is reachable, refreshed from its PUBLIC read-only endpoints: each product's
 * photographs (`GET /api/products`) and each section's names (`GET /api/home`).
 * Nothing is ever written anywhere but this process's memory.
 *
 *   node --import tsx scripts/catalog-discovery-api.ts [port]   (default 4196)
 *
 * Used by scripts/e2e-catalog-discovery-shots.mjs.
 */
import { createServer } from 'node:http';
import { asD1, freshDb, stubApp } from '../tests/fixtures/app';
import { seedLiveCatalog } from '../tests/fixtures/liveCatalog';
import { catalogRoutes } from '../worker/routes/catalog';
import { productRoutes } from '../worker/routes/products';

const PORT = Number(process.argv[2] || process.env.CATALOG_API_PORT || 4196);
const ORIGIN = process.env.HOME_SHOTS_ORIGIN || 'https://levonis-iq.com';

const raw = freshDb();
seedLiveCatalog(raw);

async function refreshFromLive(): Promise<void> {
  try {
    const res = await fetch(`${ORIGIN}/api/products?limit=50`, { headers: { accept: 'application/json' } });
    const body = (await res.json()) as { products?: Array<{ id: string; images?: string[]; media?: unknown[] }> };
    const set = raw.prepare('UPDATE products SET images = ? WHERE id = ?');
    let n = 0;
    for (const p of body.products ?? []) {
      const media = Array.isArray(p.media) ? (p.media as Array<{ url?: string; primary?: boolean }>) : [];
      const urls = [...media.filter((m) => m.primary), ...media.filter((m) => !m.primary)].map((m) => m.url).filter(Boolean) as string[];
      const images = urls.length ? urls : (p.images ?? []);
      if (images.length) n += Number(set.run(JSON.stringify(images), p.id).changes);
    }
    const home = (await (await fetch(`${ORIGIN}/api/home`, { headers: { accept: 'application/json' } })).json()) as {
      categories?: Array<{ id: string; name_ar: string; name_en: string; name_ckb: string; children?: Array<{ id: string; name_ar: string; name_en: string; name_ckb: string }> }>;
    };
    const name = raw.prepare('UPDATE catalogs SET name_ar = ?, name_en = ?, name_ckb = ? WHERE id = ?');
    for (const c of home.categories ?? []) {
      name.run(c.name_ar, c.name_en, c.name_ckb, c.id);
      for (const k of c.children ?? []) name.run(k.name_ar, k.name_en, k.name_ckb, k.id);
    }
    console.log(`catalog-discovery-api: ${n} products carry their live photographs; section names from ${ORIGIN}`);
  } catch (e) {
    console.log(`catalog-discovery-api: live refresh skipped (${e instanceof Error ? e.message : e}); serving the seed as captured`);
  }
}

const app = stubApp(asD1(raw), null, (a) => {
  a.route('/api/catalog', catalogRoutes);
  a.route('/api/products', productRoutes);
});

await refreshFromLive();

createServer(async (req, res) => {
  try {
    if (req.method !== 'GET') {
      res.writeHead(405).end();
      return;
    }
    const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
    const out = await app.request(url.pathname + url.search, { headers: { 'CF-Connecting-IP': '127.0.0.1' } });
    const body = Buffer.from(await out.arrayBuffer());
    res.writeHead(out.status, { 'content-type': out.headers.get('content-type') || 'application/json' });
    res.end(body);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: String(e) }));
  }
}).listen(PORT, '127.0.0.1', () => console.log(`catalog-discovery-api: http://127.0.0.1:${PORT}`));
