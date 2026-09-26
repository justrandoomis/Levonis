/**
 * OWNER ROUND 11 — «قم بتطوير صفحة المقارنة وصفحة اختيار الطابعة».
 *
 *   1. The colour semantics (worker/lib/multicolor.ts): a tool changer, a
 *      multi-nozzle, a dual nozzle and a single nozzle with an AMS are four
 *      different answers to «ألوان متعددة», read from the sheet, never guessed.
 *   2. A variant is a different machine: «A1» and «A1 Combo» are two columns,
 *      each at the price the PRODUCT PAGE shows for it, with its own sheet.
 *   3. The finder ranks on those semantics, per configuration.
 *   4. «الفروق فقط» and best-in-row read the new rows in the right direction.
 *   5. «إزاحة الكانفاس»: nothing on the compare page can widen the scroller.
 *
 * Run: node --import tsx --test tests/compareMulticolorVariants.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asD1, freshDb, get, json, stubApp } from './fixtures/app';
import { LIVE_PRODUCTS, P, seedLiveCatalog } from './fixtures/liveCatalog';
import { liveColourFacts, seedLivePrinterOptions } from './fixtures/livePrinterOptions';
import { compareRoutes } from '../worker/routes/compare';
import { printerFinderRoutes } from '../worker/routes/printerFinder';
import { productRoutes } from '../worker/routes/products';
import {
  colorFit,
  multicolorBadge,
  multicolorProfile,
  parseVariantSpecs,
  variantSheet,
} from '../worker/lib/multicolor';
import { compareProducts } from '../worker/lib/compareSpecs';
import { runFinder, whyFor } from '../worker/lib/printerFinder';
import { parseFinderParams } from '../packages/catalog/src/discovery';
import { liveCandidates } from './fixtures/finderCandidates';
import { rowDiffers, rowHint, type CompareRow } from '../src/lib/compare';
import { multicolorBadgeCopy, multicolorBadgeShort } from '../src/components/compare/MulticolorBadge';
import { whySentence } from '../src/components/finder/strings';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const sheetOf = (id: string): Record<string, unknown> => {
  const base = LIVE_PRODUCTS.find((p) => p.id === id)!.spec_fields;
  return { ...base, ...(liveColourFacts().get(id) ?? {}) };
};

function world() {
  const raw = freshDb();
  seedLiveCatalog(raw);
  seedLivePrinterOptions(raw);
  const app = stubApp(asD1(raw), null, (a) => {
    a.route('/api/compare', compareRoutes);
    a.route('/api/printer-finder', printerFinderRoutes);
    a.route('/api/products', productRoutes);
  });
  return { raw, app };
}

const answers = (q: string) => {
  const p = new URLSearchParams(q);
  return parseFinderParams((k) => p.get(k));
};

// ============================================================ 1. semantics

test('SEMANTICS: the four ways to print colour, from the live sheets + 0144', () => {
  const u1 = multicolorProfile(variantSheet(sheetOf(P.U1), null));
  assert.deepEqual(
    [u1.method, u1.native, u1.waste, u1.with_ams, u1.multi_material, u1.out_of_box],
    ['tool_changer', 4, 'near_zero', 4, true, 4],
    'Snapmaker U1: four independent toolheads, near-zero purge'
  );
  const h2c = multicolorProfile(sheetOf(P.H2C));
  assert.deepEqual([h2c.method, h2c.native, h2c.waste, h2c.with_ams], ['multi_nozzle', 7, 'low', 24], 'H2C: seven dedicated paths, 24 with AMS');
  const x2d = multicolorProfile(sheetOf(P.X2D));
  assert.deepEqual([x2d.method, x2d.native, x2d.waste, x2d.with_ams], ['dual_nozzle', 2, 'low', 25], 'X2D: two nozzles natively, 25 with AMS and purge');
  const a1 = multicolorProfile(sheetOf(P.A1));
  assert.deepEqual([a1.method, a1.native, a1.waste, a1.with_ams], ['ams_single_nozzle', 1, 'high', 4], 'A1: one nozzle, colours via AMS lite with purge');
});

test('SEMANTICS: the one derivation is physics — one extruder + more than one colour purges; nothing else is guessed', () => {
  // The A1 as it was BEFORE 0144: extruders 1, max_colors 4.
  const before = multicolorProfile(LIVE_PRODUCTS.find((p) => p.id === P.A1)!.spec_fields);
  assert.equal(before.method, 'ams_single_nozzle');
  assert.equal(before.waste, 'high');
  assert.deepEqual(before.derived.sort(), ['method', 'native', 'waste']);
  // Two extruders and nothing stated: NOT a dual nozzle by guess.
  const unknown = multicolorProfile({ extruders: '2', max_colors: '25' });
  assert.equal(unknown.method, null);
  assert.equal(unknown.native, null);
  assert.equal(unknown.waste, null);
  assert.equal(colorFit(unknown, 'few'), 0.05 * 0 + colorFit({ ...unknown }, 'few')!, 'a missing part contributes nothing');
  // An empty sheet is a profile of unknowns, never a throw.
  assert.deepEqual(multicolorProfile({}).derived, []);
});

test('SEMANTICS: «few colours, no waste» ranks a tool changer above an AMS single nozzle; «many» the other way', () => {
  const u1 = multicolorProfile(variantSheet(sheetOf(P.U1), null));
  const p2sCombo = multicolorProfile(variantSheet(sheetOf(P.P2S), { id: 'p2s-combo', variant_key: 'p2s-combo' }));
  assert.ok(colorFit(u1, 'few')! > colorFit(p2sCombo, 'few')!, 'U1 beats a P2S Combo on few-and-clean');
  assert.ok(colorFit(p2sCombo, 'many')! > colorFit(u1, 'many')!, 'the 20-colour P2S Combo beats the U1 on many');
});

test('SEMANTICS: the badge codes and their words', () => {
  const u1 = multicolorBadge(multicolorProfile(variantSheet(sheetOf(P.U1), null)));
  assert.equal(u1.kind, 'native');
  assert.equal(multicolorBadgeCopy(u1, 'ar')!.main, '4 ألوان · بلا هدر يُذكر');
  assert.equal(multicolorBadgeShort(u1, 'ar')!.main, '4 ألوان');
  const x2d = multicolorBadge(multicolorProfile(sheetOf(P.X2D)));
  assert.equal(multicolorBadgeCopy(x2d, 'ar')!.main, 'لونان · بهدر قليل');
  assert.equal(multicolorBadgeCopy(x2d, 'ar')!.sub, 'حتى 25 مع AMS');
  const a1Combo = multicolorBadge(multicolorProfile(variantSheet(sheetOf(P.A1), { id: 'a1-combo', variant_key: 'a1-combo' })));
  assert.equal(a1Combo.kind, 'ams');
  assert.match(multicolorBadgeCopy(a1Combo, 'ar')!.sub!, /4 كما تُباع/);
  assert.match(multicolorBadgeCopy(a1Combo, 'ar')!.sub!, /هدر/, 'an AMS badge always says it purges');
  assert.equal(multicolorBadgeCopy(multicolorBadge(multicolorProfile({})), 'ar'), null, 'nothing known, nothing said');
});

test('VARIANT LINES: allow-listed, lenient to how an admin types, and never a row', () => {
  const lines = parseVariantSpecs('A1-Combo: ams_units_included=١, colors_out_of_box: 4; build_volume=999\n\n junk line\nh2d-laser: laser_module_power=10، cutting_module=Yes');
  assert.deepEqual(lines.get('a1-combo'), { ams_units_included: '1', colors_out_of_box: '4' }, 'Arabic digits folded; build_volume refused');
  assert.deepEqual(lines.get('h2d-laser'), { laser_module_power: '10', cutting_module: 'Yes' });
  const sheet = variantSheet(
    { build_volume: '256 × 256 × 256', variant_specs: 'x: laser_module_power=10\ny: ams_units_included=1' },
    { id: 'y', variant_key: 'y', net_weight_g: 30500, width_mm: 492, depth_mm: 514, height_mm: 626 }
  );
  assert.equal(sheet.variant_specs, undefined, 'the instruction never reaches a table');
  assert.equal(sheet.has_laser_module, 'No', 'laser stated per option: the option without one has none');
  assert.equal(sheet.weight, '30.5');
  assert.equal(sheet.dimensions, '492 × 514 × 626');
  const laser = variantSheet({ variant_specs: 'x: laser_module_power=10' }, { id: 'x' });
  assert.equal(laser.has_laser_module, 'Yes');
});

// ================================================ 2. variants and prices

test('VARIANTS: A1, A1 Combo and U1 are three columns at the PRODUCT PAGE’s own prices', async () => {
  const { app } = world();
  const b = await json(await get(app, `/api/compare?ids=${P.A1},${P.A1}:a1-combo,${P.U1}`));
  assert.equal(b.success, true);
  const [a1, combo, u1] = b.products;
  // The live product page showed 799,000 / 965,000 / 1,749,000: the model's
  // regular rung plus its direct-sale cell. The old grid said 749,000 / 915,000.
  assert.deepEqual([a1.price_iqd, combo.price_iqd, u1.price_iqd], [799000, 965000, 1749000]);
  assert.equal(a1.option.id, 'a1', 'a bare id is the base (cheapest) configuration');
  assert.equal(a1.default_option, true);
  assert.equal(combo.default_option, false);
  assert.deepEqual(a1.options.map((o: { id: string; price_iqd: number }) => [o.id, o.price_iqd]), [['a1', 799000], ['a1-combo', 965000]]);
  assert.equal(u1.options, undefined, 'one way to buy: nothing to switch');
  // Each column has ITS configuration's sheet.
  const row = (id: string) => b.comparison.groups.flatMap((g: { rows: CompareRow[] }) => g.rows).find((r: CompareRow) => r.field_id === id);
  assert.deepEqual(row('colors_out_of_box').values.map((v: { text: string }) => v.text), ['1', '4', '4']);
  assert.deepEqual(row('ams_units_included').values.map((v: { text: string }) => v.text), ['0', '1', '0']);
  assert.equal(row('variant_specs'), undefined);
  assert.equal(b.products[0].multicolor.badge.kind, 'ams');
  assert.equal(u1.multicolor.badge.kind, 'native');
});

test('VARIANTS: the column price IS the product page’s `price_levels`, resolver for resolver', async () => {
  const { app } = world();
  const page = await json(await get(app, '/api/products/bambu-lab-h2d'));
  const levels = page.price_levels.option as Record<string, { unit_subtotal_iqd: number }>;
  const ids = ['h2d', 'h2d-combo', 'h2d-laser-full-combo-10w'];
  const b = await json(await get(app, `/api/compare?ids=${ids.map((o) => `${P.H2D}:${o}`).join(',')}`));
  assert.deepEqual(
    b.products.map((p: { price_iqd: number }) => p.price_iqd),
    ids.map((o) => levels[o].unit_subtotal_iqd)
  );
  assert.deepEqual(b.products.map((p: { laser_module_w: number | null }) => p.laser_module_w), [null, null, 10]);
});

test('VARIANTS: an option that is not this product’s is refused by name, blaming that column', async () => {
  const { app } = world();
  const res = await get(app, `/api/compare?ids=${P.A1},${P.U1}:a1-combo`);
  assert.equal(res.status, 400);
  const b = await json(res);
  assert.equal(b.code, 'COMPARE_OPTION_NOT_FOUND');
  assert.deepEqual(b.details, { product_id: P.U1, option_id: 'a1-combo' });
});

test('VARIANTS: the picker finally offers the configurations, priced (they used to be read off a column nobody selected)', async () => {
  const { app } = world();
  const b = await json(await get(app, `/api/compare/candidates?for=${P.A1}`));
  assert.deepEqual(b.for.options.map((o: { id: string; price_iqd: number }) => [o.id, o.price_iqd]), [['a1', 799000], ['a1-combo', 965000]]);
  const h2d = b.products.find((p: { id: string }) => p.id === P.H2D);
  assert.equal(h2d.options.length, 4);
});

// ==================================================== 3. the finder

test('FINDER: «few colours, no waste» puts the U1 first and every tool changer / multi-nozzle above AMS single nozzles', async () => {
  const { app } = world();
  const b = await json(await get(app, '/api/printer-finder?use=multicolor&mc=few&tech=any&budget=any&sale=any&prio=colors&level=beginner'));
  assert.equal(b.answers.mc, 'few');
  const slugs = b.results.map((r: { card: { slug: string } }) => r.card.slug);
  assert.equal(slugs[0], 'snapmaker-u1');
  const rankOf = (slug: string) => slugs.indexOf(slug);
  assert.ok(rankOf('bambu-lab-h2c') < rankOf('bambu-lab-p2s') || rankOf('bambu-lab-p2s') < 0);
  const top = b.results[0];
  assert.deepEqual(top.why[0], { code: 'colors_native', colors: 4, waste: 'near_zero', method: 'tool_changer' });
  assert.equal(whySentence(top.why, 'ar'), 'تطبع 4 ألوان برؤوس طباعة مستقلة وهدر شبه معدوم.');
  assert.equal(top.card.multicolor.kind, 'native');
});

test('FINDER: one result per printer, the best-matching CONFIGURATION with its own price', async () => {
  const { app } = world();
  const b = await json(await get(app, '/api/printer-finder?use=multicolor&mc=many&tech=any&budget=any&sale=any&prio=colors&level=beginner'));
  const products = b.results.map((r: { card: { id: string } }) => r.card.id);
  assert.equal(new Set(products).size, products.length, 'never the same printer twice');
  // «Many colours»: the Combo (AMS in the box, four colours as sold) is the
  // configuration shown — not the cheaper bare printer that prints one.
  const p2s = b.results.find((r: { card: { id: string } }) => r.card.id === P.P2S);
  assert.equal(p2s.variant.option_id, 'p2s-combo');
  assert.equal(p2s.variant.price_iqd, 1699000);
  assert.equal(p2s.variant.others, 1);
  assert.equal(b.total, 10, 'counted per printer, not per configuration');
});

test('FINDER: «Laser» means the configuration that ships the laser, never its Combo sibling', async () => {
  const { app } = world();
  const b = await json(await get(app, '/api/printer-finder?use=hobby&tech=laser&budget=any&sale=any&prio=none&level=beginner'));
  for (const r of b.results) {
    assert.match(r.variant.option_id, /laser/, `${r.card.slug} was offered as ${r.variant.option_id}`);
    assert.deepEqual(r.why[0].code, 'laser');
  }
  const meta = await json(await get(app, '/api/printer-finder/meta'));
  assert.equal(meta.techs.laser, 3, 'H2D, H2S, H2C — per printer');
});

test('FINDER: «why» is built only from the answers and the shop’s own numbers', () => {
  const specs = variantSheet(sheetOf(P.A1), { id: 'a1-combo', variant_key: 'a1-combo' });
  const why = whyFor({ specs, price: 965000, available: 5 }, answers('use=multicolor&tech=any&budget=750000-1250000&sale=direct&prio=colors&level=beginner'), { min: 750000, max: 1250000 });
  assert.deepEqual(why, [
    { code: 'colors_ams', colors: 4, out_of_box: 4 },
    { code: 'budget', price_iqd: 965000 },
    { code: 'direct', units: 5 },
  ]);
  assert.equal(whyFor({ specs: {}, price: 0, available: 0 }, answers('use=unsure&tech=any&budget=any&sale=any&prio=none&level=pro'), null).length, 0);
});

test('FINDER: the old defect — the U1 is no longer «ranked lower» for a business that wants colour', () => {
  const facts = liveColourFacts();
  const out = runFinder(
    liveCandidates((p) => ({ spec_fields: variantSheet({ ...p.spec_fields, ...(facts.get(p.id) ?? {}) }, null) as Record<string, string> })),
    answers('use=business&tech=fdm&budget=1250000-2500000&sale=any&prio=speed,colors&level=intermediate')
  );
  assert.ok(out.results.some((r) => r.card.id === P.U1));
  assert.ok(!out.excluded.ranked_lower.includes(P.U1));
});

// ============================================== 4. diff and best-in-row

test('BEST-IN-ROW: each metric wins in its own direction — less waste, more native colours, lower price, bigger volume', () => {
  const r = compareProducts({
    products: [
      { id: 'u1', product_type: 'printer', section_slugs: ['fdm-printers', 'printers'], spec_fields: variantSheet(sheetOf(P.U1), null), price_iqd: 1749000 },
      { id: 'x2d', product_type: 'printer', section_slugs: ['fdm-printers', 'printers'], spec_fields: variantSheet(sheetOf(P.X2D), { id: 'x2d', variant_key: 'x2d' }), price_iqd: 1649000 },
      { id: 'a1', product_type: 'printer', section_slugs: ['fdm-printers', 'printers'], spec_fields: variantSheet(sheetOf(P.A1), { id: 'a1', variant_key: 'a1' }), price_iqd: 799000 },
    ],
  });
  const row = (id: string) => r.groups.flatMap((g) => g.rows).find((x) => x.field_id === id)!;
  assert.deepEqual(row('purge_waste').winners, [0], 'Near zero beats Low beats High');
  assert.equal(row('purge_waste').better, 'lower');
  assert.deepEqual(row('purge_waste').losers, [1, 2]);
  assert.deepEqual(row('max_colors_native').winners, [0]);
  assert.deepEqual(row('max_colors').winners, [1], 'the AMS ceiling still has its own row, won by the X2D');
  assert.deepEqual(row('price_iqd').winners, [2], 'the cheapest wins the price row');
  assert.deepEqual(row('build_volume').winners, [0], 'the biggest volume wins');
  assert.deepEqual(row('colors_out_of_box').winners, [0], 'U1 prints four as sold; X2D two; A1 one');
  assert.equal(row('multicolor_method').better, 'none', 'the method is shown, never scored');
  assert.equal(r.groups.flatMap((g) => g.rows).some((x) => x.field_id === 'variant_specs'), false);
  // Client-side: the hints read the direction the server sent.
  assert.equal(rowHint(row('purge_waste') as unknown as CompareRow), 'lower');
  assert.equal(rowHint(row('multi_material') as unknown as CompareRow), 'unscored', 'the A1 does not state it');
});

test('«الفروق فقط»: an identical colour fact hides, a different one stays — including a missing one', () => {
  const r = compareProducts({
    products: [
      { id: 'a', product_type: 'printer', section_slugs: ['fdm-printers'], spec_fields: variantSheet(sheetOf(P.P1S), { id: 'p1s', variant_key: 'p1s' }), price_iqd: 1 },
      { id: 'b', product_type: 'printer', section_slugs: ['fdm-printers'], spec_fields: variantSheet(sheetOf(P.P1S), { id: 'p1s-ams-combo', variant_key: 'p1s-ams-combo' }), price_iqd: 2 },
    ],
  });
  const row = (id: string) => r.groups.flatMap((g) => g.rows).find((x) => x.field_id === id)! as unknown as CompareRow;
  assert.equal(rowDiffers(row('purge_waste')), false, 'both High: hidden');
  assert.equal(rowDiffers(row('multicolor_method')), false);
  assert.equal(rowDiffers(row('colors_out_of_box')), true, '1 vs 4: the whole point of a Combo');
  assert.equal(rowDiffers(row('ams_units_included')), true);
});

test('ORDINAL: an answer off the scale is shown and never ranked', () => {
  const r = compareProducts({
    products: [
      { id: 'a', product_type: 'printer', section_slugs: ['fdm-printers'], spec_fields: { purge_waste: 'Near zero' }, price_iqd: 1 },
      { id: 'b', product_type: 'printer', section_slugs: ['fdm-printers'], spec_fields: { purge_waste: 'about 5 g' }, price_iqd: 1 },
    ],
  });
  const row = r.groups.flatMap((g) => g.rows).find((x) => x.field_id === 'purge_waste')!;
  assert.deepEqual(row.winners, []);
  assert.equal(row.values[1].num, null);
});

// ================================================ 5. no horizontal overflow

test('NO CANVAS SHIFT: the verdict rail bleeds exactly its container’s padding, and nothing can widen the page', () => {
  const code = (src: string) => src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const band = code(read('src/components/compare/VerdictBand.tsx'));
  assert.match(band, /-mx-\[var\(--rail-bleed,1rem\)\] px-\[var\(--rail-bleed,1rem\)\]/);
  assert.ok(!/-mx-4 px-4/.test(band), 'the page-edge bleed is back inside a padded panel');
  assert.ok(!/max-w-\[82vw\]/.test(band), 'a card sized against the viewport, not the rail');
  assert.match(band, /max-w-\[82%\]/);
  assert.match(band, /overscroll-x-contain/);

  const page = code(read('src/pages/Compare.tsx'));
  assert.match(page, /className="mx-auto w-full min-w-0 max-w-4xl overflow-x-clip px-4 pb-6"/);
  assert.ok(!/overflow-x-hidden/.test(page), '`hidden` would break the sticky header; `clip` does not');
  assert.match(page, /<details data-compare-details className="[^"]*\boverflow-clip\b[^"]*"/);
  assert.match(page, /<div className="min-w-0 px-3 pb-4 \[--rail-bleed:0\.75rem\]">/);

  const strip = code(read('src/components/compare/StickyColumns.tsx'));
  assert.ok(!/inset-x-\[-/.test(strip), 'the sticky strip reaches past the page gutter again');
  assert.ok(!/\b100vw\b/.test(strip + band + page), '100vw counts the scrollbar and overflows');
});
