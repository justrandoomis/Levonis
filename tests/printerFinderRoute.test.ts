/**
 * GET /api/printer-finder and /meta over the live catalogue (catalog discovery S6a).
 *
 * The candidates are what the support assistant offers (active, spec sheet,
 * branch resolves to a printer), priced for the viewer through the listing's
 * one pricing path. Answers are parsed by the page's own grammar; an unknown
 * value is dropped, never a 400.
 *
 * Run: node --import tsx --test tests/printerFinderRoute.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, get, json, stubApp } from './fixtures/app';
import { P, seedLiveCatalog } from './fixtures/liveCatalog';
import { printerFinderRoutes } from '../worker/routes/printerFinder';

function world(extra = '') {
  const raw = freshDb();
  seedLiveCatalog(raw);
  if (extra) raw.exec(extra);
  const app = stubApp(asD1(raw), null, (a) => a.route('/api/printer-finder', printerFinderRoutes));
  return { raw, app };
}

test('the acceptance answers over HTTP: X2D, H2S, P2S, with cards, codes and the disclosure', async () => {
  const { app } = world();
  const res = await get(app, '/api/printer-finder?use=business&tech=fdm&budget=1250000-2500000&sale=any&prio=speed,colors&level=intermediate');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control') ?? '', /public, max-age=60/);
  const b = await json(res);
  assert.deepEqual(b.answers, { use: 'business', tech: 'fdm', budget: '1250000-2500000', sale: 'any', prio: ['speed', 'colors'], level: 'intermediate' });
  assert.deepEqual(b.results.map((r: { card: { id: string } }) => r.card.id), [P.X2D, P.H2S, P.P2S]);
  const top = b.results[0];
  assert.equal(top.rank, 1);
  assert.equal(top.card.slug, 'bambu-lab-x2d');
  assert.equal(top.card.display_price_iqd, 1_575_000);
  assert.equal(top.card.compare_type, 'printer', 'the result card can be put in the compare tray');
  assert.equal('spec_fields' in top.card, false, 'a card, not a product document');
  assert.deepEqual(b.excluded.ranked_lower, [P.U1]);
  assert.equal(b.excluded.budget.length, 6);
});

test('/meta counts the live shelf: 10 FDM, no Resin, no Laser, and the four budget ranges', async () => {
  const { app } = world();
  const res = await get(app, '/api/printer-finder/meta');
  assert.match(res.headers.get('cache-control') ?? '', /s-maxage=300/);
  const b = await json(res);
  assert.deepEqual(b.techs, { fdm: 10, resin: 0, laser: 0 });
  assert.deepEqual(b.budgets, [
    { range: '0-750000', count: 2 },
    { range: '750000-1250000', count: 2 },
    { range: '1250000-2500000', count: 4 },
    { range: '2500000-', count: 2 },
  ]);
  assert.equal(b.total, 10);
});

test('only printers are candidates: a filament with a spec sheet is never offered', async () => {
  const { app } = world();
  const b = await json(await get(app, '/api/printer-finder?use=unsure&tech=any&budget=any&sale=any&prio=none&level=beginner'));
  assert.equal(b.total, 10);
  assert.equal(b.results.some((r: { card: { id: string } }) => r.card.id === P.PLA), false);
});

test('a printer with no spec sheet is not a candidate (it could not be explained)', async () => {
  const { app } = world(`UPDATE products SET spec_fields = '{}' WHERE id = '${P.X2D}'`);
  const b = await json(await get(app, '/api/printer-finder?use=business&tech=fdm&budget=1250000-2500000&sale=any&prio=speed,colors&level=intermediate'));
  assert.equal(b.total, 9);
  assert.equal(b.results.some((r: { card: { id: string } }) => r.card.id === P.X2D), false);
});

test('laser machines join only when «Laser» is asked, alongside printers with a module (owner Q3)', async () => {
  const { app } = world(`
    INSERT INTO products (id, slug, name, description, price_iqd, status, category_id, sub_category_id, spec_fields, stock)
    VALUES ('p_laser', 'xtool-f1', 'xTool F1', '', 900000, 'active', 'cat_laser', 'cat_laser_machines', '{"laser_source":"Diode","warranty":"12"}', 2);
    UPDATE products SET spec_fields = json_set(spec_fields, '$.has_laser_module', 'Yes') WHERE id = '${P.H2S}';
  `);
  const meta = await json(await get(app, '/api/printer-finder/meta'));
  assert.deepEqual(meta.techs, { fdm: 10, resin: 0, laser: 2 });
  const any = await json(await get(app, '/api/printer-finder?use=unsure&tech=any&budget=any&sale=any&prio=none&level=beginner'));
  assert.equal(any.total, 10, 'a laser cutter is not a printer');
  const laser = await json(await get(app, '/api/printer-finder?use=unsure&tech=laser&budget=any&sale=any&prio=none&level=beginner'));
  assert.equal(laser.tech_matches, 2);
  assert.deepEqual(
    new Set(laser.results.filter((r: { relaxed: string[] }) => r.relaxed.length === 0).map((r: { card: { id: string } }) => r.card.id)),
    new Set(['p_laser', P.H2S])
  );
});

test('unknown answers are dropped, not refused — the finder still answers', async () => {
  const { app } = world();
  const res = await get(app, '/api/printer-finder?use=everything&tech=sla&budget=0-1&prio=fast,,quiet&level=guru');
  assert.equal(res.status, 200);
  const b = await json(res);
  assert.deepEqual(b.answers, { use: null, tech: null, budget: null, sale: null, prio: ['quiet'], level: null });
  assert.ok(b.results.length >= 3);
});
