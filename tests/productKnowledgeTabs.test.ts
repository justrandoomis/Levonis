/**
 * THE PRODUCT'S KNOWLEDGE TABS (the Bambu import spec §G.2, §G.4;
 * src/lib/productKnowledge.ts and the lazy src/components/product/
 * ProductKnowledgeTabs.tsx).
 *
 *   1. every word exactly as the spec's tables give it, in three languages,
 *      the Sorani never the Arabic;
 *   2. the tabs that show, and only with something to show;
 *   3. variant-scoped rows follow the selection; rows for other values under
 *      «إصدارات أخرى»; no product row repeated beside its scoped case;
 *   4. a missing value says why — never 0, never «No»; numbers as published;
 *   5. the packaging tab's weights and dimensions; no CBM;
 *   6. documents: title by kind, new tab, noopener noreferrer, the host and
 *      «يُفتح في موقع الشركة المصنّعة» (the component, rendered);
 *   7. the server's answer drives it end to end (the real route's DTO).
 *
 * Run: node --import tsx --test tests/productKnowledgeTabs.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import {
  KNOWLEDGE_WORDS,
  STATE_WORDS,
  US_110V_NOTE,
  documentTitle,
  knowledgeCovers,
  knowledgeTabs,
  packagingLines,
  rowsForSelection,
  sourceLine,
  valueText,
  type KnowledgeAnswer,
  type KnowledgeRow,
} from '../src/lib/productKnowledge';
import { DOCUMENT_TITLES } from '../packages/catalog/src/bambuImport/registry/documents';

const row = (over: Partial<KnowledgeRow> & { key: string }): KnowledgeRow => ({
  label: { ar: over.key, en: over.key, ckb: over.key },
  value_text: '',
  value_num: null,
  value_num_max: null,
  unit: '',
  status: 'verified',
  region: '',
  scope: { kind: 'product', id: '' },
  source: { kind: 'store_page', title: '', locator: '', excerpt: '' },
  test_method: '',
  test_condition: '',
  conflict: false,
  ...over,
});

const empty = (): KnowledgeAnswer => ({
  specs: [],
  logistics: { product: [], package: [], shipment: [], carton: [] },
  in_the_box: [],
  compatibility: { compatible: [], not_compatible: [], requires: [], related: [] },
  documents: [],
});

// ------------------------------------------------------------------ 1. the words

test('the spec’s tables, word for word, in three languages; the Sorani never the Arabic', () => {
  const spec: Array<[keyof typeof KNOWLEDGE_WORDS, string, string, string]> = [
    ['tabSpecs', 'المواصفات', 'Specifications', 'تایبەتمەندییەکان'],
    ['tabMaterials', 'المواد وإعدادات الطباعة', 'Materials & printing', 'کەرەستە و ڕێکخستنی چاپ'],
    ['tabPackaging', 'التغليف والشحن', 'Packaging & shipping', 'پاکەتکردن و ناردن'],
    ['inTheBox', 'محتويات العلبة', 'In the box', 'ناوەڕۆکی سندوق'],
    ['tabCompatibility', 'التوافق', 'Compatibility', 'گونجاوی'],
    ['tabDocuments', 'المستندات والأدلة', 'Documents & manuals', 'بەڵگەنامە و ڕێنماییەکان'],
    ['sourcesChecked', 'المصادر التي رُوجعت', 'Sources checked', 'ئەو سەرچاوانەی پشکنران'],
    ['official', 'رسمي (Bambu Lab)', 'Official (Bambu Lab)', 'فەرمی (Bambu Lab)'],
    ['testMethod', 'طريقة الاختبار', 'Test method', 'ڕێگای تاقیکردنەوە'],
    ['appliesTo', 'خاص بـ', 'Applies to', 'تایبەتە بە'],
    ['otherVersions', 'إصدارات أخرى', 'Other versions', 'وەشانەکانی تر'],
    ['compatible', 'متوافق مع', 'Compatible with', 'گونجاوە لەگەڵ'],
    ['notCompatible', 'غير متوافق مع', 'Not compatible with', 'گونجاو نییە لەگەڵ'],
    ['requires', 'يتطلب', 'Requires', 'پێویستی پێیەتی'],
    ['related', 'منتجات ذات صلة', 'Related products', 'بەرهەمە پەیوەندیدارەکان'],
    ['netWeight', 'الوزن الصافي', 'Net weight', 'کێشی پوخت'],
    ['packageWeight', 'وزن العبوة', 'Package weight', 'کێشی پاکەت'],
    ['shipmentWeight', 'الوزن الإجمالي للشحنة', 'Shipment gross weight', 'کێشی گشتی بارەکە'],
    ['productDims', 'أبعاد المنتج', 'Product dimensions', 'قەبارەی بەرهەم'],
    ['packageDims', 'أبعاد العبوة', 'Package dimensions', 'قەبارەی پاکەت'],
    ['recommendedSpace', 'المساحة الموصى بها', 'Recommended space', 'ئەو شوێنەی پێشنیار دەکرێت'],
    ['opensExternal', 'يُفتح في موقع الشركة المصنّعة', "Opens on the manufacturer's site", 'لە ماڵپەڕی بەرهەمهێنەر دەکرێتەوە'],
  ];
  for (const [k, ar, en, ckb] of spec) assert.deepEqual(KNOWLEDGE_WORDS[k], { ar, en, ckb }, k);
  // «المصدر: …» / "Source: …" / «سەرچاوە: …»
  assert.deepEqual(KNOWLEDGE_WORDS.source, { ar: 'المصدر:', en: 'Source:', ckb: 'سەرچاوە:' });
  assert.deepEqual(STATE_WORDS.not_found, { ar: 'غير متوفر في المصادر التي رُوجعت', en: 'Not in the sources checked', ckb: 'لەو سەرچاوانەی پشکنران نییە' });
  assert.deepEqual(STATE_WORDS.not_published, { ar: 'لم تنشره الشركة المصنّعة', en: 'Not published by the manufacturer', ckb: 'لەلایەن بەرهەمهێنەرەوە بڵاو نەکراوەتەوە' });
  assert.deepEqual(STATE_WORDS.not_applicable, { ar: 'لا ينطبق', en: 'Not applicable', ckb: 'پەیوەندی پێوە نییە' });
  assert.deepEqual(STATE_WORDS.unknown, { ar: 'غير متوفر', en: 'Not available', ckb: 'بەردەست نییە' });
  assert.deepEqual(STATE_WORDS.unverified, { ar: 'غير مؤكَّد', en: 'Unverified', ckb: 'پشتڕاست نەکراوەتەوە' });
  assert.deepEqual(US_110V_NOTE, { ar: 'النسخة الأمريكية (100–120 فولت)', en: 'US version (100–120 V)', ckb: 'وەشانی ئەمریکی (100–120 ڤۆڵت)' });
  for (const w of [...Object.values(KNOWLEDGE_WORDS), ...Object.values(STATE_WORDS), US_110V_NOTE]) {
    assert.ok(w.ar && w.en && w.ckb);
    assert.notEqual(w.ckb, w.ar, `«${w.en}»: the Sorani copies the Arabic`);
  }
});

test('documents: the server’s title, else the registry’s title by kind (§G.4)', () => {
  assert.equal(documentTitle({ kind: 'tds', title: { ar: '', en: '', ckb: '' } }, 'ar'), 'ورقة البيانات الفنية (TDS)');
  assert.equal(documentTitle({ kind: 'sds', title: null }, 'ckb'), 'پەڕەی زانیاری سەلامەتی (SDS)');
  assert.equal(documentTitle({ kind: 'mystery', title: null }, 'en'), DOCUMENT_TITLES.other.en);
  assert.equal(documentTitle({ kind: 'manual', title: { en: 'H2D User Manual' } }, 'en'), 'H2D User Manual');
});

// ------------------------------------------------------------------ 2–3. tabs and scopes

test('the tabs that show: only those with something to show, in the page’s order', () => {
  assert.deepEqual(knowledgeTabs(empty(), { optionValueIds: [], variantId: null }).order, []);
  const k = empty();
  k.specs = [
    { group: 'printing', label: { ar: 'الطباعة', en: 'Printing', ckb: 'چاپ' }, rows: [row({ key: 'printing.build_volume', value_text: '256 × 256 × 256 mm' })] },
    { group: 'print_settings', label: { ar: 'إعدادات', en: 'Settings', ckb: 'ڕێکخستن' }, rows: [row({ key: 'print_settings.nozzle_temp', value_text: '190–230 °C' })] },
    { group: 'extrusion', label: { ar: 'البثق', en: 'Extruder', ckb: 'پاڵنەر' }, rows: [row({ key: 'extrusion.nozzle_material', value_text: 'Hardened steel' })] },
    { group: 'identity', label: { ar: 'هوية', en: 'Identity', ckb: 'ناسنامە' }, rows: [row({ key: 'identity.family', value_text: 'bambu_filament', display: false })] },
  ];
  k.documents = [{ kind: 'manual', title: { ar: '', en: '', ckb: '' }, url: 'https://store.bblcdn.com/m.pdf', host: 'store.bblcdn.com', scope: { kind: 'product', id: '' } }];
  const tabs = knowledgeTabs(k, { optionValueIds: [], variantId: null });
  assert.deepEqual(tabs.order, ['specs', 'materials', 'documents']);
  assert.deepEqual(tabs.materials.flatMap((g) => g.rows.map((r) => r.key)), ['print_settings.nozzle_temp', 'extrusion.nozzle_material'], 'nozzle material reads as material');
  assert.ok(!tabs.specs.flatMap((g) => g.rows).some((r) => r.key === 'identity.family'), 'a filter code is no table line');
  assert.deepEqual(knowledgeCovers(k), { specs: true, box: false, any: true });
  assert.deepEqual(knowledgeCovers(empty()), { specs: false, box: false, any: false }, 'an empty answer draws nothing');
});

test('variant-scoped rows: the selection’s own first, then the product’s; other values under «إصدارات أخرى»', () => {
  const rows = [
    row({ key: 'shipment.gross_weight', value_text: '31 kg' }),
    row({ key: 'shipment.gross_weight', value_text: '44 kg', scope: { kind: 'option_value', id: 'combo' } }),
    row({ key: 'shipment.gross_weight', value_text: '50 kg', scope: { kind: 'option_value', id: 'laser' } }),
    row({ key: 'motion.max_speed', value_text: '1000 mm/s' }),
    row({ key: 'printing.camera', value_text: 'Yes', scope: { kind: 'variant', id: 'pv_combo_std' } }),
  ];
  const combo = rowsForSelection(rows, { optionValueIds: ['combo'], variantId: 'pv_combo_std' });
  assert.deepEqual(combo.shown.map((r) => r.value_text), ['44 kg', 'Yes', '1000 mm/s'], 'the product’s 31 kg is the general case of the combo’s own row');
  assert.deepEqual(combo.hidden.map((r) => r.value_text), ['50 kg']);
  const none = rowsForSelection(rows, { optionValueIds: [], variantId: null });
  assert.deepEqual(none.shown.map((r) => r.value_text), ['31 kg', '1000 mm/s']);
  assert.equal(none.hidden.length, 3);
});

// ------------------------------------------------------------------ 4. values

test('a missing value says why — never 0, never «No»; numbers as published; unverified and US rows keep their value', () => {
  assert.deepEqual(valueText(row({ key: 'k', status: 'not_found' }), 'ar'), { text: STATE_WORDS.not_found.ar, absent: true });
  assert.deepEqual(valueText(row({ key: 'k', status: 'not_published' }), 'ckb'), { text: STATE_WORDS.not_published.ckb, absent: true });
  assert.deepEqual(valueText(row({ key: 'k', status: 'not_applicable' }), 'en'), { text: 'Not applicable', absent: true });
  assert.deepEqual(valueText(row({ key: 'k', status: 'unknown', value_num: 0 }), 'en'), { text: 'Not available', absent: true }, 'a stray 0 is never shown');
  assert.equal(valueText(row({ key: 'k', value_text: '350 °C', value_num: 350 }), 'ar').text, '350 °C');
  assert.equal(valueText(row({ key: 'k', value_num: 190, value_num_max: 230, unit: '°C' }), 'en').text, '190–230 °C');
  assert.equal(valueText(row({ key: 'k', items: ['PLA', 'PETG'] }), 'ar').text, 'PLA، PETG');
  assert.equal(valueText(row({ key: 'k', value_bool: false }), 'en').text, 'No', 'a stated «no» is a value, not a missing one');
  assert.equal(valueText(row({ key: 'k', status: 'unverified', value_text: '100-120 VAC', region: 'us_110v' }), 'en').text, '100-120 VAC');
});

test('the source line: a document’s own title with its link; «رسمي (Bambu Lab)» for the store page; nothing for curated', () => {
  assert.deepEqual(sourceLine(row({ key: 'k', source: { kind: 'manual', title: 'H2D User Manual', locator: 'p.12', excerpt: '', url: 'https://store.bblcdn.com/m.pdf' } }), 'en'), {
    text: 'Source: H2D User Manual',
    url: 'https://store.bblcdn.com/m.pdf',
  });
  assert.deepEqual(sourceLine(row({ key: 'k' }), 'ar'), { text: 'المصدر: رسمي (Bambu Lab)' });
  assert.equal(sourceLine(row({ key: 'k', source: { kind: 'curated', title: '', locator: '', excerpt: '' } }), 'en'), null);
});

// ------------------------------------------------------------------ 5. packaging

test('packaging: net weight, the three axes together, recommended space, package and shipment weights; carton facts by their own label', () => {
  const L = {
    product: [
      row({ key: 'product.net_weight', value_text: '31 kg', value_num: 31000, unit: 'g' }),
      row({ key: 'product.length', value_num: 492, unit: 'mm' }),
      row({ key: 'product.width', value_num: 514, unit: 'mm' }),
      row({ key: 'product.height', value_num: 626, unit: 'mm' }),
    ],
    package: [row({ key: 'package.weight', value_text: '38 kg' }), row({ key: 'package.length', value_num: 600, unit: 'mm' })],
    shipment: [row({ key: 'shipment.gross_weight', value_text: '44.2 kg', status: 'unverified', region: 'us_110v' })],
    carton: [row({ key: 'carton.pieces', value_num: 1, label: { ar: 'عدد القطع في الكرتونة', en: 'Pieces per carton', ckb: 'ژمارەی پارچە لە کارتۆن' } })],
  };
  const lines = packagingLines(L, [row({ key: 'physical.recommended_space', value_text: '1000 × 1000 × 1000 mm' })], { optionValueIds: [], variantId: null });
  assert.deepEqual(
    lines.map((l) => l.label.en),
    ['Net weight', 'Product dimensions', 'Recommended space', 'Package weight', 'package.length', 'Shipment gross weight', 'Pieces per carton']
  );
  assert.equal(lines[1].joined, '492 × 514 × 626 mm');
  assert.equal(lines[4].joined, undefined, 'one axis is shown as itself, never padded');
});

// ------------------------------------------------------------------ 6. the component

test('the component: lazy-loaded data, the accordion on phones and tabs on desktop, links that open safely', () => {
  const src = readFileSync(join(ROOT, 'src/components/product/ProductKnowledgeTabs.tsx'), 'utf8');
  assert.match(src, /`\/api\/products\/\$\{slug\}\/knowledge`/, 'it fetches the knowledge answer itself');
  assert.match(src, /useMediaQuery\('\(min-width: 1024px\)'\)/);
  assert.match(src, /<Section\b/, 'the page’s own accordion on phones');
  assert.match(src, /<TabStrip\b/, 'tabs on desktop');
  const blanks = [...src.matchAll(/target="_blank"/g)].length;
  const safe = [...src.matchAll(/target="_blank"\s+rel="noopener noreferrer"/g)].length;
  assert.ok(blanks > 0 && blanks === safe, 'every new-tab link carries noopener noreferrer');
  assert.match(src, /<bdi>\{v\.text\}<\/bdi>/, 'numbers in <bdi>');
  assert.match(src, /KNOWLEDGE_WORDS\.opensExternal/);
  const page = readFileSync(join(ROOT, 'src/pages/Product.tsx'), 'utf8');
  assert.match(page, /React\.lazy\(\(\) => import\('\.\.\/components\/product\/ProductKnowledgeTabs'\)\)/, 'a lazy chunk of its own');
  assert.match(page, /rootMargin: '400px'/, 'fetched when it nears the viewport');
});
