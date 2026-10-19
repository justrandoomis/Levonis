/**
 * PRINTER FINDER COVERAGE (assistant plan, Phase 1 item 1.2; acceptance row 18).
 *
 * Live, `/api/printer-finder/meta` counted 2 of the 18 visible printers. The
 * candidate query took the first 300 VISIBLE rows of every type that carry a
 * spec sheet — sellable first, featured first — and only then kept the
 * printers in JS, so a shelf of featured filaments and parts with spec sheets
 * spent the cap before the first printer was read. The assistant's «ساعدني
 * باختيار طابعة» had the same shape with a cap of 40.
 *
 * The fix is `productTypeSql` (worker/lib/catalogPresentation.ts): the type
 * rule (`productTypeOf`) as a SQL condition on the printer and laser
 * sections, applied BEFORE the LIMIT. This suite seeds 400 sellable, featured,
 * non-printer rows with spec sheets AHEAD of the printers and asserts:
 *   - every visible FDM printer with a spec sheet is a candidate, in /meta and
 *     in the finder's answer, and none of the 400 is;
 *   - a hidden printer and one withdrawn to draft are not candidates;
 *   - the assistant still offers printers, at the storefront card's price;
 *   - the SQL condition agrees with `productTypeOf` on every (family,
 *     section) shape, including sections the taxonomy does not know.
 *
 * Run: node --import tsx --test tests/printerFinderCoverage.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, freshDb, get, json, post, stubApp } from './fixtures/app';
import { publishSeededV2 } from './fixtures/autoPublish';
import { LIVE_PRODUCTS, P, seedLiveCatalog } from './fixtures/liveCatalog';
import { FINDER_CANDIDATE_CAP, printerFinderRoutes } from '../worker/routes/printerFinder';
import { productRoutes } from '../worker/routes/products';
import { supportRoutes } from '../worker/routes/support';
import { catalogIndexFor, productTypeOf, productTypeSql } from '../worker/lib/catalogPresentation';

const FILLERS = 400;
const FDM_PRINTERS = LIVE_PRODUCTS.filter((p) => p.sub_category_id === 'cat_printers_fdm').map((p) => p.id);

const columns = (raw: DatabaseSync, table: string): string[] =>
  (raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

/**
 * `n` copies of the live PLA (a filament WITH a spec sheet), each V2-published
 * exactly as the PLA itself was (its pricing rows copied), featured and newer
 * than every printer — so under the finder's ORDER BY (sellable, featured,
 * display order, newest) all of them sort ahead of the first printer.
 */
function seedFillers(raw: DatabaseSync, n: number): void {
  const cols = columns(raw, 'products');
  const override: Record<string, string> = {
    id: `'fil_' || printf('%03d', n.i)`,
    slug: `'filler-filament-' || n.i`,
    name: `'Filler filament ' || n.i`,
    is_featured: '1',
    created_at: `'2026-10-01T00:00:00.000Z'`,
  };
  if (cols.includes('sku')) override.sku = 'NULL';
  const nums = `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${n})`;
  raw.exec(
    `${nums} INSERT INTO products (${cols.join(', ')})
       SELECT ${cols.map((c) => override[c] ?? `p.${c}`).join(', ')} FROM products p, n WHERE p.id = '${P.PLA}'`
  );
  // The engine-only triggers admit a V2 state row and a price row only under the writer's guards
  // (0181, 0189, 0200); the copies take them for the insert and drop them after, as the writer does.
  for (const guard of ['pricing-mode', 'engine-price']) {
    raw.exec(`${nums} INSERT INTO ops_guards (id, ok) SELECT '${guard}:fil_' || printf('%03d', n.i), 1 FROM n`);
  }
  for (const table of ['product_pricing_state', 'pricing_v2_sku_results']) {
    const tc = columns(raw, table);
    raw.exec(
      `${nums} INSERT INTO ${table} (${tc.join(', ')})
         SELECT ${tc.map((c) => (c === 'product_id' ? `'fil_' || printf('%03d', n.i)` : `s.${c}`)).join(', ')}
           FROM ${table} s, n WHERE s.product_id = '${P.PLA}'`
    );
  }
  raw.exec("DELETE FROM ops_guards WHERE id GLOB 'pricing-mode:fil_*' OR id GLOB 'engine-price:fil_*'");
}

async function world(extra = '') {
  const raw = freshDb();
  seedLiveCatalog(raw);
  await publishSeededV2(raw);
  seedFillers(raw, FILLERS);
  if (extra) raw.exec(extra);
  const db = asD1(raw);
  const app = stubApp(db, null, (a) => {
    a.route('/api/printer-finder', printerFinderRoutes);
    a.route('/api/products', productRoutes);
    a.route('/api/support', supportRoutes);
  });
  return { raw, db, app };
}

const ANY = '/api/printer-finder?use=unsure&tech=any&budget=any&sale=any&prio=none&level=beginner';
const ids = (b: Record<string, unknown>) =>
  new Set(((b.results as Array<{ card: { id: string } }>) ?? []).map((r) => r.card.id));
const everyCandidate = (b: Record<string, unknown>) =>
  new Set([
    ...ids(b),
    ...Object.values((b.excluded as Record<string, unknown>) ?? {}).flatMap((v) => (Array.isArray(v) ? (v as string[]) : [])),
  ]);

test('the fixture reproduces the live shape: the old query read no printer at all', async () => {
  const { raw } = await world();
  const first = raw
    .prepare(
      `SELECT id, sub_category_id FROM products
        WHERE status = 'active' AND composition = '' AND spec_fields <> '{}' AND spec_fields <> ''
          AND EXISTS (SELECT 1 FROM pricing_v2_sku_results r WHERE r.product_id = products.id)
        ORDER BY is_featured DESC, display_order ASC, created_at DESC
        LIMIT ?`
    )
    .all(FINDER_CANDIDATE_CAP) as Array<{ id: string; sub_category_id: string }>;
  assert.equal(first.length, FINDER_CANDIDATE_CAP);
  assert.equal(first.filter((r) => r.sub_category_id === 'cat_printers_fdm').length, 0, 'the cap is spent before the first printer');
  assert.ok(FILLERS > FINDER_CANDIDATE_CAP);
});

test('/meta counts every visible FDM printer with a spec sheet, with 400 non-printers ahead of them', async () => {
  const { app } = await world();
  const b = await json(await get(app, '/api/printer-finder/meta'));
  assert.equal(b.success, true);
  assert.deepEqual(b.techs, { fdm: 10, resin: 0, laser: 0 }, 'live this read 2 of 18');
  assert.equal(b.total, FDM_PRINTERS.length);
});

test('the finder ranks every printer and none of the 400 fillers', async () => {
  const { app } = await world();
  const b = await json(await get(app, ANY));
  assert.equal(b.total, FDM_PRINTERS.length);
  const seen = everyCandidate(b);
  for (const id of FDM_PRINTERS) assert.ok(seen.has(id), `${id} is a visible FDM printer with a spec sheet`);
  assert.equal([...seen].some((id) => id.startsWith('fil_') || id === P.PLA), false, 'a filament is never a candidate');
});

test('a hidden printer and a printer withdrawn to draft are not candidates', async () => {
  const { app } = await world(`
    UPDATE products SET status = 'hidden' WHERE id = '${P.X2D}';
    UPDATE products SET status = 'draft' WHERE id = '${P.H2S}';
  `);
  const meta = await json(await get(app, '/api/printer-finder/meta'));
  assert.equal(meta.total, FDM_PRINTERS.length - 2);
  const b = await json(await get(app, ANY));
  const seen = everyCandidate(b);
  assert.equal(seen.has(P.X2D), false, 'hidden');
  assert.equal(seen.has(P.H2S), false, 'withdrawn');
  for (const id of FDM_PRINTERS.filter((x) => x !== P.X2D && x !== P.H2S)) assert.ok(seen.has(id), id);
});

test('«ساعدني باختيار طابعة» still offers printers behind the fillers, at the storefront card price', async () => {
  // A live 10% offer on the X2D, and the X2D featured so it leads the assistant's five.
  const { app } = await world(`
    UPDATE products SET is_featured = 1, created_at = '2026-10-02T00:00:00.000Z' WHERE id = '${P.X2D}';
    INSERT INTO offer_windows (subject_type, subject_id, id, starts_at, ends_at, required_tiers, offer_price_mode,
                               offer_price_iqd, discount_percent, discount_iqd, plus_price_iqd, locked_preview, active)
    VALUES ('product', '${P.X2D}', 'ofw_x2d', NULL, NULL, '[]', 'discount_percent', NULL, 10, NULL, NULL, 1, 1);
  `);
  const reply = (await json(await post(app, '/api/support/assistant', { locale: 'en', intent: 'choose_printer' }))).reply;
  assert.equal(reply.intent, 'choose_printer');
  assert.equal(reply.cards.length, 5, 'the forty-row cap used to be spent on fillers');
  assert.ok(reply.cards.every((c: { link: { to: string } }) => !c.link.to.includes('filler')));

  const x2d = reply.cards.find((c: { link: { to: string } }) => c.link.to === '/product/bambu-lab-x2d');
  assert.ok(x2d, 'the featured X2D is offered');
  const detail = (await json(await get(app, '/api/products/bambu-lab-x2d'))).product;
  const finderCard = (await json(await get(app, ANY))).results.find((r: { card: { id: string } }) => r.card.id === P.X2D)?.card;
  assert.equal(typeof detail.display_price_iqd, 'number');
  const rowPrice = LIVE_PRODUCTS.find((p) => p.id === P.X2D)!.price_iqd;
  assert.ok(detail.display_price_iqd < rowPrice, 'the live offer lowers the card');
  assert.equal(x2d.price_iqd, detail.display_price_iqd, 'the assistant quotes the card, never the row');
  if (finderCard) assert.equal(x2d.price_iqd, finderCard.display_price_iqd);
  assert.match(x2d.subtitle, new RegExp(detail.display_price_iqd.toLocaleString('en-US')));
});

test('productTypeSql agrees with productTypeOf on every family × section shape', async () => {
  const raw = freshDb();
  const db = asD1(raw);
  const idx = await catalogIndexFor(db);
  const sections = [...idx.byId.keys()];
  raw.exec('CREATE TABLE t (id TEXT PRIMARY KEY, template_family TEXT, category_id TEXT, sub_category_id TEXT)');
  const ins = raw.prepare('INSERT INTO t VALUES (?, ?, ?, ?)');
  let n = 0;
  for (const fam of ['devices', 'materials', null, '', 'junk']) {
    for (const leaf of [...sections, '', 'cat_nobody_knows', null]) {
      // In the sub-section, in the main section only, and in both (the sub-section wins).
      ins.run(`r${n++}`, fam, null, leaf);
      ins.run(`r${n++}`, fam, leaf, null);
      ins.run(`r${n++}`, fam, sections[0] ?? null, leaf);
    }
  }
  const rows = raw.prepare('SELECT * FROM t').all() as Array<Record<string, string | null>>;
  for (const types of [['printer', 'laser'], ['printer'], ['filament']]) {
    const cond = productTypeSql(idx, types, 't');
    assert.ok(cond.binds.length <= 6, 'a handful of JSON lists, never one parameter per section');
    const hit = new Set(
      (raw.prepare(`SELECT id FROM t WHERE ${cond.sql}`).all(...cond.binds) as Array<{ id: string }>).map((r) => r.id)
    );
    for (const r of rows) {
      const want = types.includes(productTypeOf(r, idx) ?? '');
      assert.equal(hit.has(String(r.id)), want, `${types.join('+')} ${JSON.stringify(r)}`);
    }
  }
  assert.throws(() => productTypeSql(idx, ['printer'], 'p; DROP TABLE t'), /bad alias/);
});
