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
 *   5. two runs write byte-identical files, and nothing is fetched.
 *
 * Run: node --import tsx --test tests/bambuI18nStrings.test.ts
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
import { collectContext, collectStrings, corpusName, extractStrings, isNeutral, occurrencesOf, writeOutputs } from '../scripts/bambu-import/i18n-strings';
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
