// THE STORE BUILDER'S BACKEND FOR THE BROWSER E2E (scripts/e2e-store-builder.mjs): the REAL
// layout, merchant, catalogue and storefront routes on node:sqlite with every
// migration applied, the fixture store seeded, the owner signed in. Fresh on
// every start: nothing saved, nothing published.
//
// Run: node --import tsx tests/browser/store-builder-api.mts [port]
import { createServer } from 'node:http';
import { asD1, freshDb, stubApp } from '../fixtures/app';
import { seedLayoutStore } from '../fixtures/storeLayout';
import { storeLayoutRoutes } from '../../worker/routes/storeLayout';
import { storefrontRoutes } from '../../worker/routes/storefront';
import { merchantRoutes } from '../../worker/routes/merchant';
import { merchantCatalogRoutes } from '../../worker/routes/merchantCatalog';

const raw = freshDb();
seedLayoutStore(raw);
// A fresh store: nothing saved, nothing published (the first-run «ابدأ من قالب»).
const db = asD1(raw);
const ENV = { STORE_ROOT_DOMAIN: 'levonis-iq.com' };
const owner = stubApp(db, { id: 'owner', role: 'merchant', email: 'owner@x.co' }, (a) => {
  a.route('/api/merchant/store/layout', storeLayoutRoutes);
  a.route('/api/merchant', merchantRoutes);
  a.route('/api/merchant', merchantCatalogRoutes);
}, { env: ENV });
const pub = stubApp(db, null, (a) => a.route('/api/storefront', storefrontRoutes), { env: ENV });
const ctx = { waitUntil() {}, passThroughOnException() {} };
const port = Number(process.argv[2] ?? 8792);
createServer(async (req, res) => {
  const origin = req.headers.origin ?? '*';
  const cors = { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', 'access-control-allow-headers': req.headers['access-control-request-headers'] ?? '*', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', vary: 'origin' };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    return res.end();
  }
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const app = req.url!.startsWith('/api/storefront') ? pub : owner;
  const r = await app.request(`https://levonis-iq.com${req.url}`, { method: req.method, headers: { 'content-type': String(req.headers['content-type'] ?? 'application/json') }, body: ['GET', 'HEAD'].includes(req.method!) ? undefined : Buffer.concat(chunks) }, undefined, ctx as never);
  await new Promise((r2) => setTimeout(r2, 80));
  if (req.method !== 'GET') console.log(req.method, req.url, r.status);
  res.writeHead(r.status, { ...Object.fromEntries(r.headers.entries()), ...cors });
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(port, '127.0.0.1', () => console.log('builder api on', port));
