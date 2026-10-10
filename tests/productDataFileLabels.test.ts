/**
 * «تحديث البيانات» NAMES EVERY LINE (docs/DECISIONS.md row 207, requirement 5:
 * the owner saw `shipping_height_mm`, `shipping_length_mm`, `shipping_width_mm`
 * and `manual_cbm` as row titles beside «وزن الشحن (غ)»).
 *
 * Every key the data file can write — every scalar and item field of the
 * template registry, the membership discount of both tiers, the owner's
 * pricing block at its four levels and every spec field — resolves through
 * the sheet's `fieldLabel` (with the labels the server sends) to a label in
 * Arabic, English and Sorani: never the raw leaf, Arabic letters in the
 * Arabic, no Arabic script in the English, and a Sorani of its own (a
 * Sorani-only letter, never the Arabic pasted across — row 183).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIELD_REGISTRY } from '../worker/lib/template';
import { MEMBERSHIP_FIELD_NAMES, PRICING_KEYS } from '../worker/lib/productDataFile';
import { FAMILIES, PRODUCT_TYPES, allTemplateGroups, type TemplateField } from '../worker/lib/templateFamilies';
import { SPEC_FIELD_LABEL_CKB } from '../worker/lib/specFieldLabelsCkb';
import { PRICING_FIELD_LABELS } from '../packages/contracts/src/pricingFieldLabels';
import {
  DATA_FILE_FIELDS,
  DATA_FILE_GROUP_FIELDS,
  DATA_FILE_GROUP_WORDS,
  DATA_FILE_ROUTE_NAMES,
  DATA_FILE_LANG_TAGS,
  DATA_FILE_MEMBERSHIP_FIELDS,
  DATA_FILE_PRICING_FIELDS,
  fieldLabel,
  itemOfNkey,
  keyShape,
  rowTitle,
  type DataFileLabels,
  type Tri,
} from '../src/components/adminProducts/dataFileStrings';
import { create, download, edit, preview, setup } from './fixtures/dataFile';

/** The house's Sorani-only letters (tests/productDataFileStrings.test.ts). */
const SORANI_ONLY = /[ڕڵێۆەڤگچپژ]/;
const STRICT_SORANI = /[ڕڵێۆەڤ]/;
const ARABIC = /[؀-ۿ]/;

/** Every spec field of the registry, once (worker/lib/templateFamilies.ts). */
function specFields(): Map<string, TemplateField> {
  const out = new Map<string, TemplateField>();
  const add = (f: TemplateField) => {
    if (!out.has(f.id)) out.set(f.id, f);
  };
  for (const g of allTemplateGroups()) g.fields.forEach(add);
  for (const fam of Object.values(FAMILIES)) {
    fam.common.fields.forEach(add);
    for (const g of Object.values(fam.sections)) g.fields.forEach(add);
  }
  for (const p of PRODUCT_TYPES) for (const g of p.groups) g.fields.forEach(add);
  return out;
}

/** The labels the server sends for spec fields (templateDataFile.ts `labelsOf`). */
const serverSpecLabels = (): DataFileLabels => ({
  spec: Object.fromEntries([...specFields()].map(([id, f]) => [id, { ar: f.label_ar, en: f.label_en, ckb: SPEC_FIELD_LABEL_CKB[id] ?? f.label_en }])),
});

/** Every key family the data file can write, as a concrete key (`N` / `M` → 1). */
function everyKey(): string[] {
  const keys: string[] = [];
  const exported = (f: { exported?: boolean }) => f.exported !== false;
  for (const s of FIELD_REGISTRY.scalars) if (exported(s)) keys.push(s.key);
  for (const g of FIELD_REGISTRY.groups) {
    for (const f of g.fields) if (exported(f)) keys.push(`${g.name}.1.${f.key}`);
    for (const f of g.rowFields ?? []) if (exported(f)) keys.push(`${g.name}.1.rows.1.${f.key}`);
    for (const [cell, spec] of Object.entries(g.cellFields ?? {})) {
      for (const f of spec.fields) if (exported(f)) keys.push(`${g.name}.1.${cell}.${f.key}`);
      if (spec.list) for (const f of spec.list.fields) if (exported(f)) keys.push(`${g.name}.1.${cell}.${spec.list.name}.1.${f.key}`);
    }
  }
  for (const tier of ['pro', 'prime']) for (const f of MEMBERSHIP_FIELD_NAMES) keys.push(`membership.${tier}.${f}`);
  for (const lvl of ['pricing.base', 'pricing.options.1', 'pricing.colors.1', 'pricing.skus.1']) for (const f of PRICING_KEYS) keys.push(`${lvl}.${f}`);
  for (const id of specFields().keys()) keys.push(`spec.${id}`);
  for (const g of ['options', 'colors', 'variants', 'images', 'spec_groups', 'labels', 'warranty_plans', 'content_blocks', 'usage_steps']) keys.push(`${g}.1.remove`);
  return [...new Set(keys)];
}

function problemsOf(where: string, t: Tri, leaf: string): string[] {
  const out: string[] = [];
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    if (!t[lang] || !t[lang].trim()) out.push(`${where}.${lang} empty`);
    if (t[lang] === leaf) out.push(`${where}.${lang} is the raw leaf «${leaf}»`);
  }
  if (!ARABIC.test(t.ar)) out.push(`${where}: no Arabic letter in «${t.ar}»`);
  if (ARABIC.test(t.en)) out.push(`${where}: Arabic script in the English «${t.en}»`);
  if (!SORANI_ONLY.test(t.ckb)) out.push(`${where}: no Sorani-only letter in «${t.ckb}»`);
  if (t.ckb === t.ar) out.push(`${where}: ckb copies the Arabic`);
  return out;
}

test('every key the data file can write has a real label in ar, en and Sorani — none falls back to its raw name', () => {
  const keys = everyKey();
  assert.ok(keys.length >= 296 + 204, `${keys.length} keys enumerated`);
  const labels = serverSpecLabels();
  // A spec field's Arabic and English are the registry's own (the product page shows them): one of them is
  // Latin in Arabic too («Input shaping»), so for spec lines the Arabic-letter check is the registry's to make.
  const latinInRegistry = new Set([...specFields()].filter(([, f]) => !ARABIC.test(f.label_ar)).map(([id]) => `spec.${id}`));
  assert.deepEqual([...latinInRegistry], ['spec.input_shaping']);
  const problems = keys
    .flatMap((k) => problemsOf(k, fieldLabel(k, labels), keyShape(k).leaf))
    .filter((p) => !(latinInRegistry.has(p.split(':')[0]) && p.includes('no Arabic letter')));
  assert.deepEqual(problems, []);
});

test('the owner\'s four rows read the pricing screens\' own words (pricingFieldLabels.ts), at every level', () => {
  for (const lvl of ['pricing.base', 'pricing.options.3', 'pricing.colors.2', 'pricing.skus.7']) {
    for (const f of ['shipping_length_mm', 'shipping_width_mm', 'shipping_height_mm', 'manual_cbm', 'shipping_weight_g'] as const) {
      assert.deepEqual(fieldLabel(`${lvl}.${f}`), PRICING_FIELD_LABELS[f], `${lvl}.${f}`);
    }
  }
  assert.equal(fieldLabel('pricing.options.3.shipping_height_mm').ar, 'ارتفاع عبوة الشحن (ملم)');
  assert.equal(fieldLabel('pricing.options.3.manual_cbm').ckb, 'قەبارەی دەستی (CBM)');
});

test('SPEC_FIELD_LABEL_CKB holds exactly the registry\'s spec ids, each its own Sorani', () => {
  const ids = [...specFields().keys()].sort();
  assert.deepEqual(Object.keys(SPEC_FIELD_LABEL_CKB).sort(), ids, 'no spec id missing, no stale extra');
  const problems: string[] = [];
  for (const [id, ckb] of Object.entries(SPEC_FIELD_LABEL_CKB)) {
    const f = specFields().get(id)!;
    if (!STRICT_SORANI.test(ckb)) problems.push(`${id}: no Sorani-only letter in «${ckb}»`);
    if (ckb === f.label_ar || ckb === f.label_en) problems.push(`${id}: copies the Arabic or the English`);
  }
  assert.deepEqual(problems, []);
});

test('the label tables themselves: ar, en and its own Sorani in every entry', () => {
  const tables: Record<string, Record<string, Tri>> = {
    DATA_FILE_FIELDS,
    DATA_FILE_MEMBERSHIP_FIELDS,
    DATA_FILE_PRICING_FIELDS,
    DATA_FILE_GROUP_WORDS,
    DATA_FILE_ROUTE_NAMES,
    DATA_FILE_LANG_TAGS,
    ...Object.fromEntries(Object.entries(DATA_FILE_GROUP_FIELDS).map(([g, t]) => [`DATA_FILE_GROUP_FIELDS.${g}`, t])),
  };
  const problems: string[] = [];
  for (const [table, entries] of Object.entries(tables)) {
    for (const [key, t] of Object.entries(entries)) {
      for (const lang of ['ar', 'en', 'ckb'] as const) if (!t[lang]?.trim()) problems.push(`${table}.${key}.${lang} empty`);
      if (t.ckb === t.ar) problems.push(`${table}.${key}: ckb copies the Arabic`);
      if (!SORANI_ONLY.test(t.ckb)) problems.push(`${table}.${key}: no Sorani-only letter`);
      if (ARABIC.test(t.en)) problems.push(`${table}.${key}: Arabic script in the English`);
    }
  }
  assert.deepEqual(problems, []);
});

test('a row\'s title names its item: the server\'s name, else the group and its number; the product\'s own pricing block says so', () => {
  const labels: DataFileLabels = { items: { 'pricing.options:opt_a': { ar: 'قياسي', en: 'Standard', ckb: 'ستاندارد' } } };
  assert.equal(rowTitle('pricing.options.3.shipping_length_mm', { group: 'pricing.options', id: 'opt_a' }, labels, 'en'), 'Standard · Shipping box length (mm)');
  assert.equal(rowTitle('pricing.options.3.shipping_length_mm', { group: 'pricing.options', id: 'opt_a' }, labels, 'ckb'), 'ستاندارد · درێژیی سندوقی ناردن (میلیمەتر)');
  assert.equal(rowTitle('pricing.colors.2.manual_cbm', { group: 'pricing.colors', id: 'col_x' }, labels, 'ar'), 'اللون 2 · الحجم اليدوي (CBM)');
  assert.equal(rowTitle('pricing.base.manual_cbm', null, labels, 'en'), 'Product · Manual CBM');
  assert.equal(rowTitle('variants.4.stock', { group: 'variants', id: 'pv_x' }, undefined, 'en'), 'Combination 4 · Stock');
  assert.equal(rowTitle('name_en', null, undefined, 'ar'), 'الاسم (إنجليزي)');
  assert.equal(rowTitle('membership.prime.percent', null, undefined, 'en'), 'PRIME · Discount percent');
  assert.deepEqual(itemOfNkey('pricing.skus[o:a|c:b].manual_cbm'), { group: 'pricing.skus', id: 'o:a|c:b' });
  assert.deepEqual(itemOfNkey('options[opt_std].preorder.transports[air].surcharge_iqd'), { group: 'options', id: 'opt_std' });
  assert.equal(itemOfNkey('name_en'), null);
});

test('the comparison sends each row\'s item name and each spec field\'s label — the sheet\'s titles carry no raw key', async () => {
  const { app } = setup();
  const id = await create(app);
  let text = await download(app, id);
  const o2 = /^options\.(\d+)\.id=opt_combo$/m.exec(text)![1];
  const c1 = /^colors\.(\d+)\.id=col_black$/m.exec(text)![1];
  text = edit(text, `options.${o2}.stock`, '9');
  text = edit(text, `colors.${c1}.name_ar`, 'أسود لامع');
  text = edit(text, 'spec_groups.1.rows.1.value_en', '300 mm');
  const [p] = await preview(app, text, id);
  const labels = (p as unknown as { labels: DataFileLabels }).labels;
  assert.deepEqual(labels.items?.['options:opt_combo'], { ar: 'كومبو', en: 'Combo', ckb: 'كومبو' });
  assert.equal(labels.items?.['colors:col_black']?.en, 'Black');
  assert.equal(labels.items?.['spec_groups:sg_main']?.en, 'Main');
  // A spec row is an item inside the group: named by its own label (the sheet passes the line's nkey) …
  assert.deepEqual(labels.inner?.['spec_groups:sg_main/rows:sr_vol'], { ar: 'حجم الطباعة', en: 'Build volume', ckb: 'حجم الطباعة' });
  const item = (f: (typeof p.fields)[number]) => (f as unknown as { item: { group: string; id: string } | null }).item;
  const titles = p.fields.map((f) => rowTitle(f.key, item(f), labels, 'en', f.nkey));
  assert.ok(titles.includes('Combo · Stock'), titles.join(' | '));
  assert.ok(titles.includes('Black · Name (Arabic)'), titles.join(' | '));
  assert.ok(titles.includes('Main · Build volume · Row value (English)'), titles.join(' | '));
  // … and, without it, by its number in the file.
  const bare = p.fields.map((f) => rowTitle(f.key, item(f), labels, 'en'));
  assert.ok(bare.includes('Main · Row 1 · Row value (English)'), bare.join(' | '));
});
