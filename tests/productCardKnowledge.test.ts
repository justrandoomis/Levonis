/**
 * THE CARD'S KNOWLEDGE LINE (the Bambu import spec §G.5 «Cards»; the brief's §9;
 * worker/lib/knowledge/cards.ts): `section_name {ar, en, ckb}` and `key_specs`
 * (≤ 4 values of ≤ 40 characters, from the row's `spec_fields` mirrors of the
 * registry keys flagged `cardKeyFor` the product's type), on every card whose
 * route already resolves the card's type from the taxonomy — with no query of
 * its own (tests/d1Waves.test.ts holds the waves).
 *
 * Run: node --import tsx --test tests/productCardKnowledge.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, get, json, stubApp } from './fixtures/app';
import { seedLiveCatalog, P } from './fixtures/liveCatalog';
import { productRoutes } from '../worker/routes/products';
import { catalogRoutes } from '../worker/routes/catalog';
import { printerFinderRoutes } from '../worker/routes/printerFinder';
import { cardKeySpecs, cardKeysFor, sectionNameOf, KEY_SPEC_MAX_CHARS, KEY_SPECS_MAX } from '../worker/lib/knowledge/cards';
import { indexCatalogs, loadCatalogRecords } from '../worker/lib/catalogPresentation';
import { SPEC_KEYS } from '../packages/catalog/src/bambuImport/registry/specKeys';
import { leaks } from './fixtures/costlyProduct';

type Card = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function world() {
  const raw = freshDb();
  seedLiveCatalog(raw);
  const db = asD1(raw);
  const app = stubApp(db, null, (a) => {
    a.route('/api/products', productRoutes);
    a.route('/api/catalog', catalogRoutes);
    a.route('/api/printer-finder', printerFinderRoutes);
  });
  return { raw, db, app };
}

// ------------------------------------------------------------------ the registry decides

test('the card keys come from the registry flags, per storefront type, one per mirrored field', () => {
  const keys = (t: Parameters<typeof cardKeysFor>[0]) => cardKeysFor(t).map((k) => k.key);
  assert.deepEqual(keys('printer'), ['printing.build_volume']);
  assert.deepEqual(keys('filament'), ['material.type', 'material.diameter', 'material.net_weight']);
  assert.deepEqual(keys('parts'), ['nozzle.diameter', 'nozzle.material'], 'a part takes the hotend’s keys, each only when the product carries the field');
  assert.deepEqual(keys('laser'), []);
  assert.deepEqual(keys(null), []);
  // Every key a type returns is flagged for one of its import types — no key is invented here.
  for (const t of ['printer', 'filament', 'parts', 'accessory', 'laser', 'laser_material'] as const) {
    for (const k of cardKeysFor(t)) assert.ok(SPEC_KEYS.find((s) => s.key === k.key)?.cardKeyFor?.length, `${t}: ${k.key}`);
  }
});

test('the values: the compare engine’s own reading, ≤ 4 of ≤ 40 characters, never cut, never an object', () => {
  assert.deepEqual(cardKeySpecs({ build_volume: '256 x 256 x 256' }, 'printer'), ['256 × 256 × 256 mm']);
  assert.deepEqual(
    cardKeySpecs({ build_volume: 'Main nozzle: 256 × 256 × 260 mm; Auxiliary nozzle: 235.5 × 256 × 256 mm' }, 'printer'),
    ['256 × 256 × 260 mm (Main nozzle)']
  );
  assert.deepEqual(cardKeySpecs({ material_type: 'PLA', diameter: '1.75', net_weight: '1000' }, 'filament'), ['PLA', '1.75 mm', '1,000 g']);
  assert.deepEqual(cardKeySpecs({ nozzle_diameter: '0.4', nozzle_material: 'Hardened steel' }, 'parts'), ['0.4 mm', 'Hardened steel']);
  // A part that carries none of the fields says nothing.
  assert.deepEqual(cardKeySpecs({ material: 'PTFE' }, 'parts'), []);
  // A value too long for a card line is left out, never cut.
  const long = 'A very long material description that never fits on a card line';
  assert.ok(long.length > KEY_SPEC_MAX_CHARS);
  assert.deepEqual(cardKeySpecs({ material_type: long, diameter: '1.75' }, 'filament'), ['1.75 mm']);
  // An object or an empty value is noise.
  assert.deepEqual(cardKeySpecs({ material_type: { x: 1 }, diameter: '', net_weight: null } as never, 'filament'), []);
  assert.deepEqual(cardKeySpecs(null, 'filament'), []);
  // A printer's own nozzle material is never a card key of a printer.
  assert.deepEqual(cardKeySpecs({ build_volume: '180 x 180 x 180', nozzle_material: 'Stainless steel', nozzle_diameter: '0.4' }, 'printer'), ['180 × 180 × 180 mm']);
  for (const t of ['printer', 'filament', 'parts'] as const) {
    const fields = Object.fromEntries(SPEC_KEYS.filter((k) => k.templateField).map((k) => [k.templateField, '12']));
    assert.ok(cardKeySpecs(fields, t).length <= KEY_SPECS_MAX);
  }
});

test('the section name: the sub-section, else the main one; Sorani falls back to English, never the Arabic', async () => {
  const w = world();
  const idx = indexCatalogs(await loadCatalogRecords(w.db));
  assert.deepEqual(sectionNameOf({ sub_category_id: 'cat_printers_fdm', category_id: 'cat_printers' }, idx), { ar: 'طابعات FDM', en: 'FDM Printers', ckb: 'چاپکەری FDM' });
  assert.deepEqual(sectionNameOf({ sub_category_id: '', category_id: 'cat_printers' }, idx), { ar: 'الطابعات', en: 'Printers', ckb: 'چاپکەرەکان' });
  // A section nobody named in Sorani: English stands in, never the Arabic (DECISIONS row 183).
  assert.deepEqual(sectionNameOf({ sub_category_id: 'cat_maint_hotend' }, idx), { ar: 'رؤوس الطباعة والفوهات', en: 'Hotends & Nozzles', ckb: 'Hotends & Nozzles' });
  assert.equal(sectionNameOf({ sub_category_id: 'cat_nope' }, idx), null);
  w.raw.exec("UPDATE catalogs SET active = 0 WHERE id = 'cat_printers_fdm'");
  assert.equal(sectionNameOf({ sub_category_id: 'cat_printers_fdm' }, indexCatalogs(await loadCatalogRecords(w.db))), null, 'an inactive section is not named');
});

// ------------------------------------------------------------------ on the real routes

test('the listing: every card names its section, and the printers and the filament their key values', async () => {
  const { app } = world();
  const body = await json(await get(app, '/api/products?limit=50'));
  const cards = body.products as Card[];
  assert.ok(cards.length >= 14);
  for (const c of cards) assert.ok(c.section_name && c.section_name.ar && c.section_name.en && c.section_name.ckb, `${c.slug}: no section name`);
  const by = (slug: string) => cards.find((c) => c.slug === slug)!;
  assert.deepEqual(by('bambu-lab-p1s').key_specs, ['256 × 256 × 256 mm']);
  assert.deepEqual(by('bambu-lab-h2d').key_specs, ['325 × 320 × 325 mm (Single nozzle)']);
  assert.deepEqual(by('bambu-lab-pla-matte-1kg').key_specs, ['PLA', '1.75 mm', '1,000 g']);
  // A product with no spec carries no key line at all (absent, never []).
  assert.equal('key_specs' in by('levo-switch-blue-3pin'), false);
  for (const c of cards) for (const v of c.key_specs ?? []) assert.ok(typeof v === 'string' && v.length <= KEY_SPEC_MAX_CHARS, `${c.slug}: ${v}`);
  assert.deepEqual(leaks(cards.map((c) => ({ key_specs: c.key_specs, section_name: c.section_name }))), []);
});

test('the catalog page and the printer finder carry the same line (one helper, beside `compare_type`)', async () => {
  const { app } = world();
  const page = await json(await get(app, '/api/catalog/printers'));
  const fromPage = (page.shelves as Array<{ products: Card[] }>).flatMap((s) => s.products).find((c) => c.id === P.P1S);
  assert.ok(fromPage, JSON.stringify(Object.keys(page)));
  assert.deepEqual(fromPage.key_specs, ['256 × 256 × 256 mm']);
  assert.equal(fromPage.section_name.en, 'FDM Printers');
  const finder = await json(await get(app, '/api/printer-finder?use=business&tech=fdm&budget=1250000-2500000&sale=any&prio=speed,colors&level=intermediate'));
  const card = (finder.results as Array<{ card: Card }>)[0]?.card;
  assert.ok(card, JSON.stringify(finder).slice(0, 300));
  assert.deepEqual(card.key_specs, ['256 × 256 × 260 mm (Main nozzle)'], 'the X2D leads the finder');
  assert.equal(card.section_name.en, 'FDM Printers');
});
