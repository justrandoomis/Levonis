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
 *   7. the import's own rows (buildImportPayload over the committed fixtures,
 *      through the server's knowledgeRowOf): the US 110 V table is never the
 *      product's value — only under «إصدارات أخرى» (§C.6, L-20) — and weights
 *      read as published («31 kg», «1 kg»; §G.2);
 *   8. the markup: a valid <dl> (dt and dd only in each row's div), a
 *      disclosure that says it opens, a router link to a compatible product,
 *      a desktop strip that wraps instead of clipping a label.
 *
 * Run: node --import tsx --test tests/productKnowledgeTabs.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ROOT } from './fixtures/d1';
import { sample, fixtureJson } from './fixtures/bambu/load';
import { buildImportPayload } from '../packages/catalog/src/bambuImport/payload';
import { extractionFingerprint } from '../packages/catalog/src/bambuImport/fingerprint';
import { knowledgeRowOf, boxItemsOf, isOwnerOnlyKey, type SpecValueDbRow } from '../worker/lib/knowledge/productKnowledge';
import { groupLabel } from '../worker/lib/knowledge/labels';
import { defaultSelection } from '../src/lib/productChooser';
import { productVariantIdForSelection } from '../packages/pricing/src/productSelectionMedia';
import { LanguageProvider } from '../src/LanguageContext';
import { TabBody } from '../src/components/product/ProductKnowledgeTabs';
import {
  KNOWLEDGE_WORDS,
  STATE_WORDS,
  US_110V_NOTE,
  documentTitle,
  knowledgeCovers,
  knowledgeTabs,
  packagingLines,
  packagingOther,
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
  const recommended = [row({ key: 'physical.recommended_space', value_text: '1000 × 1000 × 1000 mm' })];
  const none = { optionValueIds: [], variantId: null };
  const lines = packagingLines(L, recommended, none);
  assert.deepEqual(
    lines.map((l) => l.label.en),
    ['Net weight', 'Product dimensions', 'Recommended space', 'Package weight', 'package.length', 'Pieces per carton'],
    'the US 110 V shipment weight is no line of the product (L-20)'
  );
  assert.equal(lines[1].joined, '492 × 514 × 626 mm');
  assert.equal(lines[4].joined, undefined, 'one axis is shown as itself, never padded');
  // It sits under «إصدارات أخرى» with the rows of other versions.
  assert.deepEqual(packagingOther(L, recommended, none).map((r) => [r.key, r.region]), [['shipment.gross_weight', 'us_110v']]);
  const k = { ...empty(), logistics: L };
  assert.deepEqual(knowledgeTabs(k, none).packaging.other.map((r) => r.value_text), ['44.2 kg']);
  // A packaging tab with only US facts still shows — its «إصدارات أخرى» is all it has.
  const usOnly = { ...empty(), logistics: { product: [], package: [], shipment: L.shipment, carton: [] } };
  assert.deepEqual(knowledgeTabs(usOnly, none).order, ['packaging']);
});

test('the US 110 V table is never the product’s value: under «إصدارات أخرى» whatever its scope; 220 V first (L-20)', () => {
  const rows = [
    row({ key: 'electrical.voltage', value_text: '100-120 VAC, 50/60 Hz', status: 'unverified', region: 'us_110v' }),
    row({ key: 'electrical.max_power', value_text: '1320 W@110 V', status: 'unverified', region: 'us_110v', scope: { kind: 'option_value', id: 'combo' } }),
    row({ key: 'electrical.max_power', value_text: '1000 W' }),
    row({ key: 'electrical.max_power', value_text: '1320 W@220 V', region: 'intl_220v' }),
    row({ key: 'electrical.voltage', value_text: '220-240 VAC, 50/60 Hz', region: 'intl_220v' }),
  ];
  const { shown, hidden } = rowsForSelection(rows, { optionValueIds: ['combo'], variantId: null });
  assert.deepEqual(shown.map((r) => r.value_text), ['1320 W@220 V', '1000 W', '220-240 VAC, 50/60 Hz'], 'no US value in the table; a key’s 220 V row before its region-free row');
  assert.deepEqual(hidden.map((r) => r.value_text), ['100-120 VAC, 50/60 Hz', '1320 W@110 V'], 'even the selection’s own US row');
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
  assert.match(src, /<BidiText as="bdi" text=\{v\.text\} \/>/, 'a value is an isolate: its direction from its script, numbers and Latin runs isolated (I18N-DESIGN §B)');
  assert.match(src, /KNOWLEDGE_WORDS\.opensExternal/);
  const page = readFileSync(join(ROOT, 'src/pages/Product.tsx'), 'utf8');
  assert.match(page, /React\.lazy\(\(\) => import\('\.\.\/components\/product\/ProductKnowledgeTabs'\)\)/, 'a lazy chunk of its own');
  assert.match(page, /rootMargin: '400px'/, 'fetched when it nears the viewport');
});

// ------------------------------------------------------------------ 7. the import's own rows

/** The import's payload for a committed fixture. */
function payloadOf(handle: 'h2d' | 'a1' | 'pla-basic-filament') {
  const x = sample(handle);
  return buildImportPayload({
    extraction: x,
    writeMode: 'create',
    extractionSha256: extractionFingerprint(x),
    targets: fixtureJson('compat-targets.json') as never,
    retrievedAt: '2026-10-15T00:00:00Z',
  }).payload;
}

/** The server's own row mapping and split (worker/lib/knowledge/productKnowledge.ts) over the import's rows. */
function answerOf(p: ReturnType<typeof payloadOf>): KnowledgeAnswer {
  const out = empty();
  const groups = new Map<string, KnowledgeRow[]>();
  for (const s of p.specs) {
    if (s.visibility === 'owner' || isOwnerOnlyKey(s.key, s.group)) continue;
    const db: SpecValueDbRow = {
      canonical_key: s.key,
      group_key: s.group,
      scope_kind: s.scope_kind,
      scope_id: s.scope_id,
      region: s.region,
      data_type: s.data_type,
      original_label: s.original_label,
      value_text: s.value_text,
      value_num: s.value_num,
      value_num_max: s.value_num_max,
      value_bool: s.value_bool,
      value_list: JSON.stringify(s.value_list),
      unit: s.unit,
      status: s.status,
      source_kind: s.source_kind,
      // The payload carries no store address (the writer adds it owner-side); a manual's own URL is not needed here.
      source_ref: '',
      source_title: s.source_title,
      source_locator: s.source_locator,
      source_excerpt: s.source_excerpt,
      test_method: s.test_method,
      test_condition: s.test_condition,
      checked_sources: JSON.stringify(s.checked_sources),
      conflict: s.conflict,
      sort: s.sort,
    };
    if (s.key === 'package.contents') {
      out.in_the_box.push(...(boxItemsOf(db) as KnowledgeAnswer['in_the_box']));
      continue;
    }
    const r = knowledgeRowOf(db) as KnowledgeRow | null;
    if (!r) continue;
    const part = s.key.split('.')[0];
    if (part === 'product' || part === 'package' || part === 'shipment' || part === 'carton') {
      out.logistics[part].push(r);
      continue;
    }
    groups.set(s.group, [...(groups.get(s.group) ?? []), r]);
  }
  out.specs = [...groups.entries()].map(([group, rows]) => ({ group, label: groupLabel(group), rows }));
  return out;
}

/** What the page hands the tabs on opening (src/pages/Product.tsx): the default selection and its variant. */
function openingSelection(p: ReturnType<typeof payloadOf>) {
  const groups = p.groups.map((g) => ({ id: g.id, kind: g.kind, default_value_id: g.default_value_id, values: g.values.map((v) => ({ id: v.id })) }));
  const variants = p.variants.map((v) => ({ id: v.id, combo_key: v.combo_key }));
  const optionValueIds = defaultSelection(groups, variants);
  return { optionValueIds, variantId: productVariantIdForSelection(variants, { optionValueIds }) };
}

test('the H2D as it opens: no US 110 V value in the specifications or as a packaging line — all of them under «إصدارات أخرى»', () => {
  const p = payloadOf('h2d');
  const us = p.specs.filter((s) => s.region === 'us_110v' && s.visibility === 'public').map((s) => s.key);
  assert.ok(us.includes('electrical.voltage') && us.includes('shipment.gross_weight') && us.includes('package.length'), us.join(', '));
  const sel = openingSelection(p);
  const tabs = knowledgeTabs(answerOf(p), sel);
  const tables = [...tabs.specs, ...tabs.materials].map((g) => rowsForSelection(g.rows, sel));
  assert.deepEqual(tables.flatMap((t) => t.shown).filter((r) => r.region === 'us_110v').map((r) => `${r.key} = ${r.value_text}`), []);
  assert.deepEqual(tabs.packaging.lines.filter((l) => l.rows.some((r) => r.region === 'us_110v')).map((l) => l.label.en), []);
  const other = [...tables.flatMap((t) => t.hidden), ...tabs.packaging.other];
  for (const key of ['electrical.voltage', 'shipment.gross_weight', 'package.length']) {
    assert.ok(other.some((r) => r.key === key && r.region === 'us_110v'), `${key} is under «إصدارات أخرى»`);
  }
  // The product's own facts stay: its net weight and its own dimensions.
  assert.deepEqual(tabs.packaging.lines.slice(0, 2).map((l) => l.label.en), ['Net weight', 'Product dimensions']);
});

test('weights read as published: H2D 31 kg and 40.6 / 44.2 / 48.2 kg, A1 8.3 kg, PLA Basic 1 kg — the number stays in grams', () => {
  const h2d = answerOf(payloadOf('h2d'));
  const net = h2d.logistics.product.find((r) => r.key === 'product.net_weight')!;
  assert.deepEqual([valueText(net, 'ar').text, net.value_num, net.unit], ['31 kg', 31000, 'g']);
  assert.deepEqual(h2d.logistics.shipment.map((r) => valueText(r, 'en').text).sort(), ['40.6 kg', '44.2 kg', '48.2 kg']);
  const a1 = answerOf(payloadOf('a1'));
  assert.equal(valueText(a1.logistics.product.find((r) => r.key === 'product.net_weight')!, 'ckb').text, '8.3 kg');
  assert.deepEqual(a1.logistics.shipment.map((r) => valueText(r, 'en').text).sort(), ['13 kg', '13.5 kg']);
  const pla = answerOf(payloadOf('pla-basic-filament'));
  const plaNet = pla.specs.flatMap((g) => g.rows).find((r) => r.key === 'material.net_weight')!;
  assert.deepEqual([valueText(plaNet, 'en').text, plaNet.value_num], ['1 kg', 1000]);
});

// ------------------------------------------------------------------ 8. the markup

const render = (el: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(createElement(LanguageProvider, null, createElement(MemoryRouter, null, el)));

test('the markup: each fact is one div of its <dl> holding only <dt> and <dd> — the notes are <dd>s too', () => {
  const k = empty();
  k.specs = [
    {
      group: 'electrical',
      label: { ar: 'الكهرباء', en: 'Electrical', ckb: 'کارەبا' },
      rows: [
        row({ key: 'electrical.voltage', value_text: '220-240 V', region: 'intl_220v', test_method: 'Bench', source: { kind: 'manual', title: 'H2D User Manual', locator: '', excerpt: '', url: 'https://store.bblcdn.com/m.pdf' } }),
        row({ key: 'electrical.voltage', value_text: '100-120 V', status: 'unverified', region: 'us_110v' }),
        row({ key: 'electrical.max_power', value_text: '1000 W', scope: { kind: 'option_value', id: 'laser' } }),
      ],
    },
  ];
  k.logistics.shipment = [row({ key: 'shipment.gross_weight', value_text: '44.2 kg', status: 'unverified', region: 'us_110v', scope: { kind: 'option_value', id: 'combo' } })];
  const sel = { optionValueIds: ['combo'], variantId: null };
  const tabs = knowledgeTabs(k, sel);
  const html = ['specs', 'packaging'].map((id) =>
    render(createElement(TabBody, { id: id as 'specs', tabs, lang: 'en', selection: sel, scopeNames: { combo: 'H2D AMS Combo', laser: 'H2D Laser Full Combo' } }))
  ).join('');
  // Every child of a <dl> is a div; inside it, only <dt> and <dd>.
  const dls = [...html.matchAll(/<dl[^>]*>([\s\S]*?)<\/dl>/g)].map((m) => m[1]);
  assert.ok(dls.length >= 3, `three lists (the table, its other versions, the packaging's): ${dls.length}`);
  for (const inner of dls) {
    const rows = [...inner.matchAll(/<div[^>]*>([\s\S]*?)<\/div>/g)].map((m) => m[1]);
    assert.ok(rows.length > 0);
    assert.equal(inner.replace(/<div[^>]*>[\s\S]*?<\/div>/g, ''), '', 'nothing but rows directly in a <dl>');
    for (const r of rows) {
      const tops = r.replace(/<(dt|dd)\b[^>]*>[\s\S]*?<\/\1>/g, '');
      assert.equal(tops, '', `a row holds only <dt> and <dd>: ${r.slice(0, 200)}`);
      assert.doesNotMatch(r, /<p\b|<div\b/);
    }
  }
  // The notes ride in the row: the US note, «Applies to», the test method, the source.
  assert.match(html, /<dd class="col-span-2[^"]*" data-knowledge-note="us_110v">US version \(100–120 V\)<\/dd>/);
  assert.match(html, /data-knowledge-note="applies-to">Applies to <bdi dir="ltr">H2D AMS Combo<\/bdi><\/dd>/);
  assert.match(html, /<dd class="col-span-2[^"]*">Test method: <bdi dir="ltr">Bench<\/bdi><\/dd>/);
});

test('«إصدارات أخرى» says it opens: a chevron that turns, the native marker hidden — in the specifications and the packaging tab', () => {
  const k = empty();
  k.specs = [{ group: 'electrical', label: { ar: 'الكهرباء', en: 'Electrical', ckb: 'کارەبا' }, rows: [row({ key: 'electrical.voltage', value_text: '100-120 V', status: 'unverified', region: 'us_110v' })] }];
  k.logistics.package = [row({ key: 'package.weight', value_text: '38 kg', status: 'unverified', region: 'us_110v' })];
  const sel = { optionValueIds: [], variantId: null };
  const tabs = knowledgeTabs(k, sel);
  for (const id of ['specs', 'packaging'] as const) {
    const html = render(createElement(TabBody, { id, tabs, lang: 'ar', selection: sel, scopeNames: {} }));
    const details = /<details class="group[^"]*" data-knowledge-other="true">\s*<summary class="([^"]*)">([\s\S]*?)<\/summary>/.exec(html);
    assert.ok(details, `${id}: a collapsed «إصدارات أخرى»`);
    assert.match(details[1], /list-none/);
    assert.match(details[1], /\[&amp;::-webkit-details-marker\]:hidden/);
    assert.match(details[2], /<svg[^>]*class="[^"]*lucide-chevron-down[^"]*group-open:rotate-180[^"]*"[^>]*aria-hidden="true"/, 'a chevron that turns');
    assert.match(details[2], /إصدارات أخرى/);
    assert.match(html, /النسخة الأمريكية \(100–120 فولت\)/, 'with the US note');
  }
});

test('a compatible product is the router’s link (no reload), its slug encoded; a target without a page is its label', () => {
  const k = empty();
  k.compatibility.compatible = [
    { relation: 'compatible_with', label: 'Bambu Lab A1', scope: { kind: 'product', id: '' }, product: { slug: 'bambu-lab-a1', name: { ar: 'A1', en: 'Bambu Lab A1', ckb: 'A1' }, image: '' } },
    { relation: 'compatible_with', label: 'AMS 2 Pro', scope: { kind: 'product', id: '' } },
  ];
  const tabs = knowledgeTabs(k, { optionValueIds: [], variantId: null });
  const html = render(createElement(TabBody, { id: 'compatibility', tabs, lang: 'en', selection: { optionValueIds: [], variantId: null }, scopeNames: {} }));
  assert.match(html, /<a [^>]*href="\/product\/bambu-lab-a1"[^>]*>/);
  const src = readFileSync(join(ROOT, 'src/components/product/ProductKnowledgeTabs.tsx'), 'utf8');
  assert.match(src, /<Link\s+to=\{`\/product\/\$\{encodeURIComponent\(p\.slug\)\}`\}/, 'react-router’s Link, the slug encoded');
  assert.doesNotMatch(src, /href=\{`\/product\//, 'no raw anchor to a product page');
});

test('the desktop tab strip wraps instead of clipping its last label (no hidden scroll row in a 68ch column)', () => {
  const src = readFileSync(join(ROOT, 'src/components/product/ProductKnowledgeTabs.tsx'), 'utf8');
  const strip = /<TabStrip\b[\s\S]*?\/>/.exec(src)?.[0] ?? '';
  assert.match(strip, /className="flex-wrap\b/);
  assert.doesNotMatch(strip, /overflow-x-auto|hide-scrollbar/);
});

// ------------------------------------------------------------------ 9. the owner's note on /product/filament-buffer (I18N-DESIGN §B, §C.3, §C.4)

/** The canary's answer as the route gives it after the dedupe: two chips, «يتطلب AMS Hub», the statement row. */
function canary(linked: boolean): KnowledgeAnswer {
  const k = empty();
  k.specs = [
    {
      group: 'electrical',
      label: { ar: 'الكهرباء', en: 'Electrical', ckb: 'کارەبا' },
      rows: [
        row({ key: 'electrical.voltage', label: { ar: 'الجهد الكهربائي', en: 'Voltage', ckb: 'ڤۆڵتیە' }, value_text: '24V' }),
        row({ key: 'electrical.current', label: { ar: 'التيار', en: 'Current', ckb: 'تەزوو' }, value_text: 'Below 10mA', value_i18n: { ar: 'أقل من 10mA', ckb: 'کەمتر لە 10mA' } }),
      ],
    },
    {
      group: 'part',
      label: { ar: 'القطعة', en: 'Part', ckb: 'پارچە' },
      rows: [
        row({ key: 'part.material', value_text: 'Plastics, PCBA' }),
        row({ key: 'part.color', value_text: 'Gray', value_i18n: { ar: 'رمادي', ckb: 'خۆڵەمێشی' } }),
      ],
    },
    { group: 'compat', label: { ar: 'التوافق', en: 'Compatibility', ckb: 'گونجاوی' }, rows: [row({ key: 'compat.statement', value_text: 'X1 Series and P1 Series', status: 'unverified' })] },
  ];
  const p1s = { id: 'p_p1s', slug: 'p1s', name: { ar: 'Bambu Lab P1S', en: 'Bambu Lab P1S', ckb: 'Bambu Lab P1S' }, image: '' };
  const rp1s = { id: 'p_rp1s', slug: 'refurbished-p1s', name: { ar: 'Refurbished P1S', en: 'Refurbished P1S', ckb: 'Refurbished P1S' }, image: '' };
  const hub = { id: 'p_hub', slug: 'ams-hub', name: { ar: 'AMS Hub', en: 'AMS Hub', ckb: 'AMS Hub' }, image: '/files/hub.webp' };
  k.compatibility.compatible = [
    { relation: 'compatible_with', label: 'P1 Series', target_kind: 'family', scope: { kind: 'product', id: '' }, ...(linked ? { product: p1s, more: [rp1s] } : {}) },
    { relation: 'compatible_with', label: 'X1 Series', target_kind: 'family', scope: { kind: 'product', id: '' } },
  ];
  k.compatibility.requires = [{ relation: 'requires', label: 'AMS Hub', target_kind: 'hub', scope: { kind: 'product', id: '' }, ...(linked ? { product: hub } : {}) }];
  return k;
}

const SEL = { optionValueIds: ['ov_8de61959ea1a198354b199e2'], variantId: null };

test('compatibility said once: the statement leaves the specifications when the chips say it; kept as a note only when it says more', () => {
  const tabs = knowledgeTabs(canary(false), SEL);
  assert.ok(!tabs.specs.some((g) => g.rows.some((r) => r.key === 'compat.statement')), 'not in the specifications');
  assert.ok(!tabs.specs.some((g) => g.group === 'compat'), 'an emptied group disappears');
  assert.equal(tabs.compatibilityNote, undefined, '«X1 Series and P1 Series» says nothing the chips do not');
  // A statement that says more stays, under the chips.
  const more = canary(false);
  more.specs[2].rows[0] = row({ key: 'compat.statement', value_text: 'X1 Series and P1 Series (not the A1 mini)', status: 'unverified' });
  const t2 = knowledgeTabs(more, SEL);
  assert.equal(t2.compatibilityNote?.value_text, 'X1 Series and P1 Series (not the A1 mini)');
  const html = render(createElement(TabBody, { id: 'compatibility', tabs: t2, lang: 'ar', selection: SEL, scopeNames: {} }));
  assert.match(html, /data-knowledge-compat-note="true"><span dir="ltr">X1 Series and P1 Series \(not the A1 mini\)<\/span><span[^>]*data-unverified="true">غير مؤكَّد<\/span>/);
  // Without a Compatibility tab, the statement stays where it was.
  const none = canary(false);
  none.compatibility = { compatible: [], not_compatible: [], requires: [], related: [] };
  assert.ok(knowledgeTabs(none, SEL).specs.some((g) => g.rows.some((r) => r.key === 'compat.statement')));
});

test('«يتطلب AMS Hub» not on the site yet: plain words, no link, no pill; on the site: a link to its page; a family: its label, then its members', () => {
  const plain = render(createElement(TabBody, { id: 'compatibility', tabs: knowledgeTabs(canary(false), SEL), lang: 'ar', selection: SEL, scopeNames: {} }));
  assert.doesNotMatch(plain, /<a\b/, 'nothing to follow');
  assert.doesNotMatch(plain, /rounded-full|border-border-subtle|min-h-\[36px\]|lv-choice/, 'no pill, no border, no tappable height');
  assert.match(plain, /<li dir="rtl" class="text-sm text-text-secondary"><bdi dir="ltr">P1 Series<\/bdi>، <bdi dir="ltr">X1 Series<\/bdi><\/li>/, 'one line of words, «، » between them');
  assert.match(plain, /يتطلب[\s\S]*<li dir="ltr" class="text-sm text-text-secondary">AMS Hub<\/li>/);
  assert.equal((plain.match(/P1 Series/g) ?? []).length, 1, 'each label once');
  const en = render(createElement(TabBody, { id: 'compatibility', tabs: knowledgeTabs(canary(false), SEL), lang: 'en', selection: SEL, scopeNames: {} }));
  assert.match(en, /<li dir="ltr" class="text-sm text-text-secondary">P1 Series, X1 Series<\/li>/);
  const linked = render(createElement(TabBody, { id: 'compatibility', tabs: knowledgeTabs(canary(true), SEL), lang: 'ar', selection: SEL, scopeNames: {} }));
  assert.match(linked, /<a [^>]*data-knowledge-link="true" href="\/product\/ams-hub"/, 'the hub, once imported, is a link');
  assert.match(linked, /data-knowledge-family="true"><span class="text-sm text-text-secondary"><bdi dir="ltr">P1 Series<\/bdi>:<\/span><a [^>]*href="\/product\/p1s"[\s\S]*?<a [^>]*href="\/product\/refurbished-p1s"/, 'a family: its label, then each member');
  assert.match(linked, /<span dir="ltr" class="text-start rtl:text-right">Bambu Lab P1S<\/span>/, 'a name reads LTR, aligned with the column');
  assert.match(linked, /lucide-chevron-right[^"]*rtl:rotate-180/, 'a chevron says it goes somewhere');
  assert.match(linked, /<li dir="ltr" class="text-sm text-text-secondary">X1 Series<\/li>/, 'the label with no page stays words');
});

test('mixed scripts: «أقل من 10mA» is RTL with 10mA isolated LTR; an English fallback reads LTR; Sorani the same', () => {
  const tabs = knowledgeTabs(canary(false), SEL);
  const ar = render(createElement(TabBody, { id: 'specs', tabs, lang: 'ar', selection: SEL, scopeNames: {} }));
  assert.match(ar, /<bdi dir="rtl">أقل من <bdi dir="ltr">10mA<\/bdi><\/bdi>/);
  assert.match(ar, /<bdi dir="ltr">Plastics, PCBA<\/bdi>/, 'no translation: the English reads LTR');
  assert.match(ar, /<bdi dir="rtl">رمادي<\/bdi>/);
  assert.match(ar, /<bdi dir="ltr">24V<\/bdi>/);
  const ckb = render(createElement(TabBody, { id: 'specs', tabs, lang: 'ckb', selection: SEL, scopeNames: {} }));
  assert.match(ckb, /<bdi dir="rtl">کەمتر لە <bdi dir="ltr">10mA<\/bdi><\/bdi>/);
  const en = render(createElement(TabBody, { id: 'specs', tabs, lang: 'en', selection: SEL, scopeNames: {} }));
  assert.match(en, /<bdi dir="ltr">Below 10mA<\/bdi>/, 'English reads the English');
  assert.equal(valueText(canary(false).specs[1].rows[1], 'ckb').text, 'خۆڵەمێشی');
  // A list joins its translated items; a box item and a test method read in the reader's language.
  const list = row({ key: 'printing.supported_filament', items: ['Gray', 'PLA'], items_i18n: [{ ar: 'رمادي', ckb: 'خۆڵەمێشی' }, null] });
  assert.equal(valueText(list, 'ar').text, 'رمادي، PLA');
  assert.equal(valueText(list, 'en').text, 'Gray, PLA');
});

test('one chip per product in a bucket: a compound whose two labels link the same product draws it once (review: «H2D and H2D Laser»)', () => {
  const h2d = { id: 'p_h2d', slug: 'h2d', name: { ar: 'Bambu Lab H2D', en: 'Bambu Lab H2D', ckb: 'Bambu Lab H2D' }, image: '' };
  const refurb = { id: 'p_rh2d', slug: 'refurbished-bambu-lab-h2d-3d-printer', name: { ar: '[Refurbished] Bambu Lab H2D 3D Printer', en: '[Refurbished] Bambu Lab H2D 3D Printer', ckb: '[Refurbished] Bambu Lab H2D 3D Printer' }, image: '' };
  const k = canary(false);
  // compat-targets.json: «H2D» is a family {h2d, refurbished H2D}; «H2D Laser» a printer pointing to h2d.
  k.compatibility.compatible = [
    { relation: 'compatible_with', label: 'H2D', target_kind: 'family', scope: { kind: 'product', id: '' }, product: h2d, more: [refurb] },
    { relation: 'compatible_with', label: 'H2D Laser', target_kind: 'printer', scope: { kind: 'product', id: '' }, product: h2d },
  ];
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const html = render(createElement(TabBody, { id: 'compatibility', tabs: knowledgeTabs(k, SEL), lang, selection: SEL, scopeNames: {} }));
    assert.equal((html.match(/href="\/product\/h2d"/g) ?? []).length, 1, `${lang}: the H2D once`);
    assert.equal((html.match(/href="\/product\/refurbished-bambu-lab-h2d-3d-printer"/g) ?? []).length, 1, `${lang}: the refurbished H2D once`);
  }
  // The other order (a printer label first, then a family that holds it): still once each, the family keeps its other member.
  k.compatibility.compatible = [...k.compatibility.compatible].reverse();
  const html = render(createElement(TabBody, { id: 'compatibility', tabs: knowledgeTabs(k, SEL), lang: 'ar', selection: SEL, scopeNames: {} }));
  assert.equal((html.match(/href="\/product\/h2d"/g) ?? []).length, 1);
  assert.equal((html.match(/href="\/product\/refurbished-bambu-lab-h2d-3d-printer"/g) ?? []).length, 1);
  // Two buckets are separate facts: the same product may be compatible in one and required in another.
  const both = canary(false);
  both.compatibility.compatible = [{ relation: 'compatible_with', label: 'H2D', target_kind: 'printer', scope: { kind: 'product', id: '' }, product: h2d }];
  both.compatibility.requires = [{ relation: 'requires', label: 'H2D', target_kind: 'printer', scope: { kind: 'product', id: '' }, product: h2d }];
  const two = render(createElement(TabBody, { id: 'compatibility', tabs: knowledgeTabs(both, SEL), lang: 'en', selection: SEL, scopeNames: {} }));
  assert.equal((two.match(/href="\/product\/h2d"/g) ?? []).length, 2);
});

test('a linked live product with Arabic and Sorani names: its chip reads the English name (B.7, pickName), never an Arabic name forced LTR (landing review)', () => {
  // The live P1S (a merge keeps its name): GET /api/products/bambu-lab-p1s, name_ar and name_ku in Arabic script.
  const p1s = {
    id: 'prd_b1e2ff5081a34f3f9389',
    slug: 'bambu-lab-p1s',
    name: {
      en: 'Bambu Lab P1S / P1S AMS Combo / P1S AMS 2 Combo 3D Printer',
      ar: 'طابعة Bambu Lab P1S / P1S AMS Combo / P1S AMS 2 Combo ثلاثية الأبعاد',
      ckb: 'چاپکەری سێ ڕەهەندی Bambu Lab P1S / P1S AMS Combo / P1S AMS 2 Combo',
    },
    image: '',
  };
  const k = canary(false);
  k.compatibility.compatible = [{ relation: 'compatible_with', label: 'P1 Series', target_kind: 'family', scope: { kind: 'product', id: '' }, product: p1s }];
  for (const lang of ['ar', 'ckb', 'en'] as const) {
    const html = render(createElement(TabBody, { id: 'compatibility', tabs: knowledgeTabs(k, SEL), lang, selection: SEL, scopeNames: {} }));
    assert.match(html, /<span dir="ltr" class="text-start rtl:text-right">Bambu Lab P1S \/ P1S AMS Combo \/ P1S AMS 2 Combo 3D Printer<\/span>/, `${lang}: the English name, LTR`);
    assert.doesNotMatch(html, /طابعة Bambu|چاپکەری سێ/, `${lang}: no Arabic-script name in the chip`);
  }
  // A row saved before the rule with only an Arabic name: that name, in its own direction.
  const legacy = canary(false);
  legacy.compatibility.compatible = [{ relation: 'compatible_with', label: 'P1 Series', target_kind: 'family', scope: { kind: 'product', id: '' }, product: { ...p1s, name: { en: '', ar: p1s.name.ar, ckb: '' } } }];
  const html = render(createElement(TabBody, { id: 'compatibility', tabs: knowledgeTabs(legacy, SEL), lang: 'ar', selection: SEL, scopeNames: {} }));
  assert.match(html, /<span dir="rtl" class="text-start rtl:text-right">طابعة Bambu Lab P1S/);
});

test('«محتويات العلبة»: an English item sits beside its bullet on an RTL page, like a translated one (review: the box list zigzagged)', () => {
  const k = canary(false);
  k.in_the_box = [
    { text: 'H2D Laser Full Combo', qty: null, scope: { kind: 'product', id: '' } },
    { text: 'Quick start guide', qty: 2, scope: { kind: 'product', id: '' }, text_i18n: { ar: 'دليل البدء السريع', ckb: 'ڕێبەری دەستپێکی خێرا' } },
  ];
  const html = render(createElement(TabBody, { id: 'packaging', tabs: knowledgeTabs(k, SEL), lang: 'ar', selection: SEL, scopeNames: {} }));
  assert.match(html, /<span dir="ltr" class="min-w-0 flex-1 text-start rtl:text-right">H2D Laser Full Combo<\/span>/, 'the start of the RTL column, not the far edge');
  assert.match(html, /<span dir="rtl" class="min-w-0 flex-1 text-start rtl:text-right">دليل البدء السريع<\/span>/);
});
