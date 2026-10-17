/**
 * THE STRINGS TO TRANSLATE (docs/bambu-import/I18N-DESIGN.md §D;
 * scripts/bambu-import/i18n-strings.ts), over the committed fixtures: the
 * trimmed `filament-buffer` and `ams-2-pro` pages (as a two-page corpus, gzip,
 * named by the crawler's rule) with the reviewed bundle of data/bambu-import,
 * and the 8 audit-class samples through `buildImportPayload`.
 *
 *   1. filament-buffer offers «Below 10mA», «Plastics, PCBA», «Gray», its box
 *      item and its description — the text the owner saw in English;
 *   2. it never offers a neutral value («24V», «50 g»), a name («X1 Series»,
 *      «AMS Hub», «X1 Series and P1 Series»), owner-only text, a registry label;
 *   3. every key is sourceHash(en) of a normalized string; the batches put
 *      every page string before every api string and keep a product's strings
 *      together; a string sits in the batch of its first product;
 *   4. the build is the runner's: the crawler's file names (a non-ASCII handle
 *      included), a withdrawn page reported, a missing page reported;
 *   5. two runs write byte-identical files, and nothing is fetched;
 *   6. a later round (`--existing`): a committed string is not offered again but
 *      its new products are linked to the committed row, the batches are
 *      numbered after the committed parts, and the assembler never overwrites
 *      another round's part;
 *   7. a registry string also offered as a value is one row in one part; a
 *      product's own option or colour name is a name on that product; English
 *      made only of connector words is offered;
 *   8. the assembler takes exactly `reviewed`, `needs_review` and `keep`, and
 *      removes a part it owns that ends up empty (p000 too with --no-authored).
 *
 * Run: node --import tsx --test tests/bambuI18nStrings.test.ts
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { ROOT } from './fixtures/d1';
import { SAMPLE_HANDLES, fixtureJson, sample } from './fixtures/bambu/load';
import { buildImportPayload } from '../packages/catalog/src/bambuImport/payload';
import { extractPage } from '../packages/catalog/src/bambuImport/extract';
import { extractionFingerprint } from '../packages/catalog/src/bambuImport/fingerprint';
import { normalizeSource, sourceHash } from '../packages/catalog/src/bambuImport/i18n';
import { loadReviewedBundle } from '../scripts/bambu-import/discover';
import { collectContext, collectStrings, corpusName, exclusionOf, existingEnglish, extractStrings, isNeutral, nextBatchNumber, occurrencesOf, writeOutputs } from '../scripts/bambu-import/i18n-strings';
import { assemble } from '../scripts/bambu-import/i18n-assemble';
import { checkTranslationsDir, manifestProductIds, translationNames } from '../scripts/bambu-import/i18nData';
import { newProductIdOf } from '../worker/lib/catalogImport/reviewed';
import { isOwnerOnlyKey } from '../worker/lib/knowledge/answer';

const DATA = join(ROOT, 'data', 'bambu-import');
const bundle = loadReviewedBundle(DATA);
const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function corpus(): string {
  const dir = mkdtempSync(join(tmpdir(), 'i18n-corpus-'));
  dirs.push(dir);
  for (const h of ['filament-buffer', 'ams-2-pro']) {
    writeFileSync(join(dir, `${corpusName(h)}.html.gz`), gzipSync(readFileSync(join(ROOT, 'tests', 'fixtures', 'bambu', `${h}.page.html`))));
  }
  writeFileSync(join(dir, 'halloween-filament-special-combo.status'), '{"status":404}');
  return dir;
}

let fetches = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  fetches += 1;
  throw new Error('the extraction never fetches');
}) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
});

const run = (dir: string) => extractStrings({ corpus: dir, dataDir: DATA, generatedAt: '2026-10-16T00:00:00.000Z', codeCommit: 'c'.repeat(40), root: ROOT });

test('filament-buffer offers the English the owner saw; never a neutral value, a name or owner-only text', () => {
  const r = run(corpus());
  const fb = newProductIdOf(bundle.rows.find((x) => x.handle === 'filament-buffer')!.source_product_id);
  const mine = r.strings.strings.filter((s) => s.products.includes(fb));
  const en = mine.map((s) => s.en);
  for (const want of ['Below 10mA', 'Plastics, PCBA', 'Gray', 'Filament buffer, 2x M3*21.5 screws']) assert.ok(en.includes(want), `offers «${want}»`);
  assert.ok(mine.some((s) => s.kind === 'short_description' && s.en.startsWith('The Filament buffer is an accessory')), 'the description');
  for (const never of ['24V', '50 g', 'X1 Series', 'P1 Series', 'AMS Hub', 'X1 Series and P1 Series', 'Electricity', 'Voltage']) assert.ok(!en.includes(never), `never «${never}»`);
  const allText = JSON.stringify(r.strings);
  assert.ok(!/m³|volume_m3/.test(allText), 'no owner-only (CBM) text');
  for (const s of r.strings.strings) {
    assert.equal(s.en, normalizeSource(s.en));
    assert.equal(s.h, sourceHash(s.en));
    assert.ok(s.products.length && s.handles.length && s.freq >= s.products.length);
  }
  assert.equal(new Set(r.strings.strings.map((s) => s.h)).size, r.strings.strings.length, 'one entry per string');
  // «Gray» is the dictionary's too: its seed rides along for the reviewer, never as a translation of its own.
  assert.deepEqual(mine.find((s) => s.en === 'Gray')!.dict, { ar: 'رمادي', ckb: 'خۆڵەمێشی' });
  // Counts and the build's own report.
  assert.equal(r.strings.counts.products_built, 2);
  assert.deepEqual(r.strings.counts.products_withdrawn, ['halloween-filament-special-combo']);
  assert.equal(r.strings.counts.products_failed.length, bundle.rows.length - 3);
  assert.ok(r.strings.counts.products_failed.every((f) => f.reason === 'missing'));
  assert.ok(r.strings.counts.excluded.neutral > 0 && r.strings.counts.excluded.name > 0 && r.strings.counts.excluded.owner_only > 0);
  assert.equal(fetches, 0, 'nothing fetched');
});

test('batches: page before api, a product kept together, a string in its first product\'s batch, about 250 each', () => {
  const r = run(corpus());
  const surfaces = r.batches.map((b) => b.surface);
  assert.deepEqual(surfaces, [...surfaces].sort((a, b) => (a === b ? 0 : a === 'page' ? -1 : 1)), 'every page batch first');
  const seen = new Set<string>();
  for (const b of r.batches) {
    assert.ok(b.strings.length > 0 && b.strings.length <= 250);
    for (const s of b.strings) {
      assert.ok(!seen.has(s.h), 'a string is in one batch');
      seen.add(s.h);
    }
  }
  assert.equal(seen.size, r.strings.strings.length, 'every string is in a batch');
  // Small batches keep a product's strings together: the batches holding one product's strings are consecutive.
  const small = collectStrings(
    (['filament-buffer', 'ams-2-pro'] as const).map((h) => ({ row: bundle.rows.find((x) => x.handle === h)!, payload: payloadOfPage(h) })),
    collectContext(bundle),
    { generatedAt: 'x', corpus: 'x', codeCommit: '', bundleSha256: '', batchSize: 10 }
  );
  assert.ok(small.batches.length > 2);
  for (const handle of ['filament-buffer', 'ams-2-pro']) {
    const at = small.batches.map((b, i) => (b.handles.includes(handle) ? i : -1)).filter((i) => i >= 0);
    const bySurface = (surface: string) => at.filter((i) => small.batches[i].surface === surface);
    for (const surface of ['page', 'api']) {
      const xs = bySurface(surface);
      if (xs.length) assert.equal(xs[xs.length - 1] - xs[0] + 1, xs.length, `${handle} (${surface}): consecutive batches`);
    }
  }
  assert.ok(small.batches.every((b) => b.strings.length <= 10));
});

function payloadOfPage(handle: 'filament-buffer' | 'ams-2-pro') {
  const html = readFileSync(join(ROOT, 'tests', 'fixtures', 'bambu', `${handle}.page.html`), 'utf8');
  const x = extractPage(html).extraction;
  const row = bundle.rows.find((r) => r.handle === handle)!;
  return buildImportPayload({ extraction: x, writeMode: 'create', extractionSha256: extractionFingerprint(x), manifestRow: row, targets: bundle.targets, overrides: bundle.overrides, retrievedAt: '2026-10-16T00:00:00.000Z' }).payload;
}

test('the 8 audit-class samples: strings with keys, no owner-only text, no neutral or name string', () => {
  const ctx = collectContext(bundle);
  const products = SAMPLE_HANDLES.map((h) => {
    const x = sample(h);
    const p = buildImportPayload({ extraction: x, writeMode: 'create', extractionSha256: extractionFingerprint(x), targets: fixtureJson('compat-targets.json') as never, retrievedAt: '2026-10-15T00:00:00Z' }).payload;
    return { row: { queue_position: 1, source_product_id: x.sourceProductId, handle: x.handle, title: x.title } as never, payload: p };
  });
  const r = collectStrings(products, ctx, { generatedAt: 'x', corpus: 'x', codeCommit: '', bundleSha256: '' });
  assert.ok(r.strings.strings.length > 50, `${r.strings.strings.length} strings`);
  const owner = new Set(
    products.flatMap(({ payload }) =>
      payload.specs.filter((x) => x.visibility !== 'public' || isOwnerOnlyKey(x.key, x.group)).map((x) => normalizeSource(x.value_text)).filter((t) => t.length > 3)
    )
  );
  assert.ok(owner.size > 0, 'the samples carry owner-only rows (else this proves nothing)');
  for (const s of r.strings.strings) {
    assert.equal(isNeutral(s.en), false, s.en);
    assert.ok(!owner.has(s.en), `owner-only text offered: ${s.en}`);
  }
  // Every kind the samples carry is a known kind, and the page kinds come first.
  const kinds = new Set(r.strings.strings.map((s) => s.kind));
  for (const k of kinds) assert.match(k, /^(short_description|usage_title|usage_body|spec_value_text|spec_list_item|spec_label|box_item|test_method|doc_title|relation_label|block_title|block_line|block_cell|faq_q|faq_a)$/);
  // The occurrences mirror the writer: a usage step without a body is never written, so never offered.
  for (const { payload } of products) {
    const occ = occurrencesOf(payload);
    const empty = payload.product.usage_steps.filter((s) => !s.body_en.trim()).map((s) => normalizeSource(s.title_en));
    for (const t of empty) assert.ok(!occ.some((o) => o.kind === 'usage_title' && o.en === t && !payload.product.usage_steps.some((s) => s.body_en.trim() && normalizeSource(s.title_en) === t)));
  }
});

test('the neutral rule and the crawler\'s file names', () => {
  for (const s of ['24V', '50 g', 'PLA, PETG', '389 × 389 × 458 mm', '220-240 V', '≤ 300 °C', 'X1C / P1S', 'https://wiki.bambulab.com/en/x', 'PETG-CF', 'TPU 85A / TPU 90A']) assert.equal(isNeutral(s), true, s);
  for (const s of ['Below 10mA', 'Gray', 'Step 1', 'Plastics, PCBA', '2 spools', 'Bluetooth speaker']) assert.equal(isNeutral(s), false, s);
  // Measurements and names the old «only names» rule swallowed by accident (review: it said «name» with no name
  // removed): still never offered, now for the right reason.
  for (const s of ['300*285 mm²', '256 x 256 x 256 mm³*', '127.1mm*78.8mm', '4.0x1.7mm', '41*13*21mm', '1.17 g/cm³', '≥60HRC', '85±5mm°', '2.45mW@3.3V', '13.56MHZ', '16.4ft/5m', '@storm879', '@BrandedAbstract3D', 'Makerize3D', 'W.drop2027', 'TaterTotterer1'])
    assert.equal(isNeutral(s), true, s);
  for (const s of ['3D-printed parts', '4.Printability', '2.Acknowledgement', 'For the AMS', 'Printer']) assert.equal(isNeutral(s), false, s);
  assert.equal(corpusName('usb‑c-soldering-iron-kit-for-heat-set-inserts'), 'usb_c-soldering-iron-kit-for-heat-set-inserts');
  assert.equal(corpusName('cyberbrick-mk20-1a4-waffenträger'), 'cyberbrick-mk20-1a4-waffentr_ger');
  assert.equal(corpusName('garden-races-cyberbrick-4×4-rc-truck'), 'garden-races-cyberbrick-4_4-rc-truck');
});

test('two runs write byte-identical files; nothing is fetched', () => {
  const dir = corpus();
  const outs = [0, 1].map(() => {
    const out = mkdtempSync(join(tmpdir(), 'i18n-out-'));
    dirs.push(out);
    const r = run(dir);
    writeOutputs(out, r, { glossary: r.glossary, names: r.names });
    return out;
  });
  const list = (d: string) => ['strings.json', 'glossary.json', 'names.json', 'RULES.md', ...readdirSync(join(d, 'batches')).map((f) => `batches/${f}`)].sort();
  assert.deepEqual(list(outs[0]), list(outs[1]));
  for (const f of list(outs[0])) assert.equal(readFileSync(join(outs[0], f), 'utf8'), readFileSync(join(outs[1], f), 'utf8'), `${f} is byte-identical`);
  assert.ok(readdirSync(join(outs[0], 'batches')).every((f) => /^batch-\d{3}\.json$/.test(f)));
  const glossary = JSON.parse(readFileSync(join(outs[0], 'glossary.json'), 'utf8')).entries as Array<{ ar: string; ckb: string }>;
  assert.ok(glossary.length > 100 && glossary.every((g) => g.ar && g.ckb && g.ar !== g.ckb), 'the glossary in three languages, the Sorani its own');
  assert.equal(fetches, 0);
});

test('the assembler: translators\' rows validated into committed parts, a bad row refused by code, the index regenerated, CI\'s check passing', async () => {
  const { assemble } = await import('../scripts/bambu-import/i18n-assemble');
  const { checkTranslationsDir, manifestProductIds, translationNames } = await import('../scripts/bambu-import/i18nData');
  const out = mkdtempSync(join(tmpdir(), 'i18n-out-'));
  const parts = mkdtempSync(join(tmpdir(), 'i18n-parts-'));
  dirs.push(out, parts);
  const r = run(corpus());
  writeOutputs(out, r, { glossary: r.glossary, names: r.names });
  const first = r.batches[0];
  const h = (en: string) => first.strings.find((s) => s.en === en)!.h;
  writeFileSync(
    join(out, 'batches', 'batch-001.out.json'),
    JSON.stringify([
      { h: h('Below 10mA'), ar: 'أقل من 10mA', ckb: 'کەمتر لە 10mA', status: 'reviewed' },
      { h: h('Plastics, PCBA'), ar: ' بلاستيك،  PCBA ', ckb: 'پلاستیک، PCBA', status: 'reviewed' },
      { h: h('Filament buffer, 2x M3*21.5 screws'), ar: 'المخزن المؤقت، 2 براغي', ckb: 'بافەر، 2x M3*21.5 بورغی', status: 'reviewed' },
    ])
  );
  const rep = assemble({ inDir: out, dataDir: DATA, outDir: parts });
  assert.equal(rep.translated, 2);
  assert.deepEqual(rep.refused.map((x) => x.code), ['DIGITS'], 'a lost number refuses that row, by code');
  assert.deepEqual(rep.problems, []);
  const p001 = JSON.parse(readFileSync(join(parts, 'p001.json'), 'utf8')) as Array<Record<string, unknown>>;
  assert.deepEqual(p001.map((x) => [x.en, x.ar, x.status]), [
    ['Below 10mA', 'أقل من 10mA', 'reviewed'],
    ['Plastics, PCBA', 'بلاستيك، PCBA', 'reviewed'],
  ]);
  const index = JSON.parse(readFileSync(join(parts, 'index.json'), 'utf8'));
  assert.deepEqual(Object.keys(index.parts), [...(rep.authored ? ['p000'] : []), 'p001']);
  assert.deepEqual(checkTranslationsDir(parts, { names: translationNames(bundle), productIds: manifestProductIds(bundle) }), []);
  // With the dictionary's seeds accepted, «Gray» joins as machine.
  const seeded = assemble({ inDir: out, dataDir: DATA, outDir: parts, acceptSeeds: true });
  assert.ok(seeded.seeds >= 1);
  const again = JSON.parse(readFileSync(join(parts, 'p001.json'), 'utf8')) as Array<Record<string, unknown>>;
  assert.deepEqual(again.find((x) => x.en === 'Gray'), { h: sourceHash('Gray'), en: 'Gray', ar: 'رمادي', ckb: 'خۆڵەمێشی', kind: 'spec_value_text', status: 'machine', products: (again.find((x) => x.en === 'Gray')!.products as string[]) });
});

// ------------------------------------------------------------------ the review's findings

const META = { generatedAt: 'x', corpus: 'x', codeCommit: '', bundleSha256: '' };
const builtPage = (handle: 'filament-buffer' | 'ams-2-pro') => ({ row: bundle.rows.find((r) => r.handle === handle)!, payload: payloadOfPage(handle) });
const TR: Record<string, { ar: string; ckb: string }> = {
  Gray: { ar: 'رمادي', ckb: 'خۆڵەمێشی' },
  'Below 10mA': { ar: 'أقل من 10mA', ckb: 'کەمتر لە 10mA' },
  'Plastics, PCBA': { ar: 'بلاستيك، PCBA', ckb: 'پلاستیک، PCBA' },
};
/** The translators answer the strings of TR in every batch of `dir`. */
function translateKnown(dir: string): void {
  for (const f of readdirSync(join(dir, 'batches')).filter((x) => /^batch-\d+\.json$/.test(x))) {
    const b = JSON.parse(readFileSync(join(dir, 'batches', f), 'utf8')) as { strings: Array<{ h: string; en: string }> };
    const rows = b.strings.filter((x) => TR[x.en]).map((x) => ({ h: x.h, ...TR[x.en], status: 'reviewed' }));
    writeFileSync(join(dir, 'batches', f.replace('.json', '.out.json')), JSON.stringify(rows));
  }
}
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
const lines = (path: string) => (JSON.parse(readFileSync(path, 'utf8')) as Array<{ h: string; en: string; status: string; products: string[] }>);
const checkCtx = () => ({ names: translationNames(bundle), productIds: manifestProductIds(bundle) });

test('a later round links a new product to a string already committed and never overwrites round 1 (review: rounds)', () => {
  const fb = builtPage('filament-buffer');
  const ams = builtPage('ams-2-pro');
  const committed = tmp('i18n-committed-');
  // Round 1: the filament buffer alone (the AMS 2 Pro page was missing from the first crawl).
  const in1 = tmp('i18n-round1-');
  writeOutputs(in1, collectStrings([fb], collectContext(bundle), META), { glossary: [], names: [] });
  translateKnown(in1);
  assert.deepEqual(assemble({ inDir: in1, dataDir: DATA, outDir: committed, authored: false }).problems, []);
  const round1 = readFileSync(join(committed, 'p001.json'), 'utf8');
  assert.ok(round1.includes('"en":"Gray"') && round1.includes('"en":"Below 10mA"'));
  // Round 2 with --existing: the AMS 2 Pro states «Gray» too.
  const gray = ams.payload.specs.find((x) => x.key !== 'package.contents' && x.visibility === 'public' && x.data_type !== 'list' && x.value_text)!;
  gray.value_text = 'Gray';
  assert.equal(nextBatchNumber(committed), 2);
  const r2 = collectStrings([fb, ams], collectContext(bundle, existingEnglish(committed)), { ...META, firstBatch: nextBatchNumber(committed) });
  assert.ok(!r2.strings.strings.some((x) => x.en === 'Gray'), 'a committed string is not offered again');
  assert.ok(r2.strings.counts.excluded.existing > 0);
  const link = r2.strings.linked.find((l) => l.en === 'Gray')!;
  assert.equal(link.part, 'p001');
  assert.ok(link.products.includes(ams.payload.product_id), 'the new product is linked to the committed row');
  assert.equal(r2.batches[0].batch, 2, 'numbered after the committed parts');
  const in2 = tmp('i18n-round2-');
  writeOutputs(in2, r2, { glossary: [], names: [] });
  assert.ok(readdirSync(join(in2, 'batches')).every((f) => !f.startsWith('batch-001')));
  const b2 = JSON.parse(readFileSync(join(in2, 'batches', 'batch-002.json'), 'utf8')) as { strings: Array<{ h: string; en: string }> };
  const pick = b2.strings.find((x) => /^[A-Za-z ]+$/.test(x.en) && x.en.split(' ').length <= 4)!;
  writeFileSync(join(in2, 'batches', 'batch-002.out.json'), JSON.stringify([{ h: pick.h, ar: 'نص عربي للتجربة', ckb: 'دەقێکی کوردی بۆ تاقیکردنەوە', status: 'needs_review' }]));
  const rep2 = assemble({ inDir: in2, dataDir: DATA, outDir: committed, authored: false });
  assert.deepEqual(rep2.problems, []);
  assert.equal(rep2.relinked.length, 1);
  assert.equal(rep2.relinked[0].part, 'p001');
  assert.ok(rep2.relinked[0].products >= 1, 'products added to the committed rows');
  const p001 = lines(join(committed, 'p001.json'));
  assert.ok(p001.some((x) => x.en === 'Below 10mA'), 'round 1 is still committed');
  assert.ok(p001.find((x) => x.en === 'Gray')!.products.includes(ams.payload.product_id), 'its row now names the new product (its ref)');
  assert.ok(lines(join(committed, 'p002.json')).some((x) => x.h === pick.h), 'round 2 writes its own part');
  assert.deepEqual(checkTranslationsDir(committed, checkCtx()), []);
  // A round numbered from 1 again (no --existing) never overwrites round 1's part: a problem, the file untouched.
  const before = readFileSync(join(committed, 'p001.json'), 'utf8');
  const in3 = tmp('i18n-round3-');
  writeOutputs(in3, collectStrings([ams], collectContext(bundle), META), { glossary: [], names: [] });
  translateKnown(in3);
  const rep3 = assemble({ inDir: in3, dataDir: DATA, outDir: committed, authored: false });
  assert.ok(rep3.problems.some((p) => /^p001: holds \d+ string\(s\) of no batch of this run/.test(p)), rep3.problems.join('\n'));
  assert.equal(readFileSync(join(committed, 'p001.json'), 'utf8'), before);
});

test('a registry string offered as a value and carried by a content block is one row in one part (review: two parts)', () => {
  const fb = builtPage('filament-buffer');
  const box = fb.payload.specs.find((x) => x.key === 'package.contents')!;
  (box.value_list as unknown[]).push({ text: 'Hotend', qty: 1 });
  const block = fb.payload.content_blocks.find((b) => b.kind === 'text')!;
  fb.payload.content_blocks.push({ ...block, id: 'cb_twice', title_en: '', body_en: 'Part | Hotend' });
  const r = collectStrings([fb], collectContext(bundle), META);
  assert.equal(r.strings.strings.filter((x) => x.en === 'Hotend').length, 1, 'offered once');
  assert.ok(!r.strings.authored.some((a) => a.en === 'Hotend'), 'not authored as well');
  const e = r.strings.strings.find((x) => x.en === 'Hotend')!;
  assert.deepEqual(Object.keys(e.kinds).sort(), ['block_cell', 'box_item']);
  const dir = tmp('i18n-twice-');
  writeOutputs(dir, r, { glossary: [], names: [] });
  const b = JSON.parse(readFileSync(join(dir, 'batches', 'batch-001.json'), 'utf8')) as { strings: Array<{ h: string; en: string }> };
  writeFileSync(join(dir, 'batches', 'batch-001.out.json'), JSON.stringify([{ h: b.strings.find((x) => x.en === 'Hotend')!.h, ar: 'رأس الصهر', ckb: 'سەری تواندنەوە', status: 'reviewed' }]));
  const out = tmp('i18n-twice-out-');
  assert.deepEqual(assemble({ inDir: dir, dataDir: DATA, outDir: out }).problems, []);
});

test('a product\'s own option or colour name is a name on that product; connector words alone are English to translate (review)', () => {
  const ctx = collectContext(bundle);
  // h2d's box lists its own option «H2D Laser Full Combo»: never offered for it.
  const x = sample('h2d');
  const p = buildImportPayload({ extraction: x, writeMode: 'create', extractionSha256: extractionFingerprint(x), targets: fixtureJson('compat-targets.json') as never, retrievedAt: '2026-10-15T00:00:00Z' }).payload;
  const own = p.groups.flatMap((g) => g.values.map((v) => v.name_en));
  assert.ok(own.includes('H2D Laser Full Combo'));
  const r = collectStrings([{ row: { queue_position: 1, source_product_id: x.sourceProductId, handle: x.handle, title: x.title } as never, payload: p }], ctx, META);
  for (const n of own) assert.ok(!r.strings.strings.some((s) => s.en === n), `«${n}» is h2d's own option or colour name`);
  // The same words are an ordinary string for a product that has no such option.
  assert.equal(exclusionOf('H2D Laser Full Combo', 'box_item', ctx), null);
  assert.equal(exclusionOf('H2D Laser Full Combo', 'box_item', ctx, new Set(['h2d laser full combo'])), 'name');
  // «only names» needs a name: connector words alone say something (I18N-DESIGN §C.3).
  for (const en of ['Compatible with all printers', 'For the AMS', 'Printer Compatibility']) assert.equal(exclusionOf(en, 'block_line', ctx), null, en);
  for (const en of ['X1 Series and P1 Series', 'Compatibility: X1 Series, P1P', 'AMS Hub']) assert.equal(exclusionOf(en, 'spec_value_text', ctx), 'name', en);
});

test('the assembler takes exactly reviewed, needs_review and keep; a part it owns that ends up empty is removed (review)', () => {
  const r = run(corpus());
  const dir = tmp('i18n-status-');
  writeOutputs(dir, r, { glossary: r.glossary, names: r.names });
  const first = r.batches[0];
  const h = (en: string) => first.strings.find((x) => x.en === en)!.h;
  writeFileSync(
    join(dir, 'batches', 'batch-001.out.json'),
    JSON.stringify([
      { h: h('Below 10mA'), ar: 'أقل من 10mA', ckb: 'کەمتر لە 10mA', status: 'reviewed' },
      { h: h('Gray'), ar: 'رمادي', ckb: 'خۆڵەمێشی', status: 'needs-review' },
      { h: h('Plastics, PCBA'), ar: 'بلاستيك، PCBA', ckb: 'پلاستیک، PCBA' },
      { h: h('Filament buffer, 2x M3*21.5 screws'), ar: 'Filament buffer, 2x M3*21.5 screws', ckb: 'Filament buffer, 2x M3*21.5 screws', status: 'keep' },
    ])
  );
  const out = tmp('i18n-status-out-');
  const rep = assemble({ inDir: dir, dataDir: DATA, outDir: out });
  assert.deepEqual(rep.refused.map((x) => x.code), ['STATUS', 'STATUS'], 'a typo and a missing status are refused, never committed reviewed');
  assert.equal(rep.translated, 1);
  assert.equal(rep.keep, 1);
  const p001 = lines(join(out, 'p001.json'));
  assert.deepEqual(p001.map((x) => [x.en, x.status]), [
    ['Below 10mA', 'reviewed'],
    ['Filament buffer, 2x M3*21.5 screws', 'keep'],
  ]);
  assert.ok(existsSync(join(out, 'p000.json')), 'the authored headings');
  assert.deepEqual(checkTranslationsDir(out, checkCtx()), []);
  // The translators withdraw everything and the assembly is run again without the authored part: nothing of it stays.
  writeFileSync(join(dir, 'batches', 'batch-001.out.json'), '[]');
  const again = assemble({ inDir: dir, dataDir: DATA, outDir: out, authored: false });
  assert.deepEqual(again.removed.sort(), ['p000', 'p001']);
  assert.deepEqual(readdirSync(out).sort(), ['index.json']);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(out, 'index.json'), 'utf8')).parts), []);
});
