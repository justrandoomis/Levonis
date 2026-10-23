import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, ctx, freshDb, json, stubApp } from './fixtures/app';
import { searchDay, searchTrendingRoutes } from '../worker/routes/searchTrending';

function setup() {
  const raw = freshDb();
  raw.exec("INSERT INTO products (id, slug, name, price_iqd) VALUES ('a1','a1','Bambu Lab A1',775000), ('pla','pla','PLA Basic',21000);");
  const app = stubApp(asD1(raw), null, (a) => a.route('/api/search', searchTrendingRoutes), { publishV2: false });
  const request = (path: string, init?: RequestInit) => app.request(`https://levonis-iq.com/api/search/${path}`, init, {}, ctx);
  const select = (ip: string, product_id = 'a1') => request('selection', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip }, body: JSON.stringify({ product_id }) });
  return { raw, request, select };
}

test('trends count distinct daily viewers and only publish after three selections', async () => {
  const { raw, request, select } = setup();
  for (let i = 0; i < 4; i++) assert.equal((await select('192.0.2.1')).status, 200);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM search_selection_visitors').get()!.n, 1);
  assert.deepEqual((await json(await request('trending'))).items, []);
  await select('192.0.2.2'); await select('192.0.2.3');
  const body = await json(await request('trending'));
  assert.deepEqual(body.items, [{ id: 'a1', term: 'Bambu Lab A1', rank: 1, previous_rank: null }]);
  const stored = raw.prepare('SELECT visitor_hash FROM search_selection_visitors LIMIT 1').get()!;
  assert.match(String(stored.visitor_hash), /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(body).includes('192.0.2.'), false);
});

test('hidden or removed products never appear and rank changes use the previous day', async () => {
  const { raw, request, select } = setup();
  for (let i = 1; i <= 3; i++) await select(`192.0.2.${i}`);
  const insert = raw.prepare('INSERT INTO search_selection_visitors VALUES (?, ?, ?)');
  for (let i = 0; i < 4; i++) insert.run(searchDay() - 1, 'pla', `y-${i}`);
  for (let i = 0; i < 3; i++) insert.run(searchDay() - 1, 'a1', `y-${i}`);
  assert.equal((await json(await request('trending'))).items[0].previous_rank, 2);
  raw.exec("UPDATE products SET status='hidden' WHERE id='a1'");
  assert.deepEqual((await json(await request('trending'))).items, []);
  assert.equal((await json(await select('192.0.2.4'))).recorded, false);
  assert.equal((await json(await select('192.0.2.4', 'missing'))).recorded, false);
});

test('missing migration gracefully disables trends without breaking search', async () => {
  const { raw, request, select } = setup();
  raw.exec('DROP TABLE search_selection_visitors');
  assert.deepEqual((await json(await request('trending'))).items, []);
  assert.equal((await json(await select('192.0.2.1'))).recorded, false);
});

test('trend day changes at Baghdad midnight', () => {
  assert.equal(searchDay(Date.parse('2026-10-23T21:00:00Z')) - searchDay(Date.parse('2026-10-23T20:59:59Z')), 1);
});

test('a new selection retains only the current day and six previous calendar days', async () => {
  const { raw, select } = setup();
  const insert = raw.prepare('INSERT INTO search_selection_visitors VALUES (?, ?, ?)');
  insert.run(searchDay() - 7, 'a1', 'expired');
  insert.run(searchDay() - 6, 'a1', 'retained');
  await select('192.0.2.1');
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM search_selection_visitors WHERE visitor_hash = 'expired'").get()!.n, 0);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM search_selection_visitors WHERE visitor_hash = 'retained'").get()!.n, 1);
});
