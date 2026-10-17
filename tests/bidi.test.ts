/**
 * MIXED ARABIC / SORANI / ENGLISH TEXT IN READING ORDER (docs/bambu-import/
 * I18N-DESIGN.md §B; src/lib/bidi.ts, src/components/ui/BidiText.tsx).
 *
 *   1. a line's direction is its script's: any Arabic-script letter is RTL,
 *      a Latin name at the start does not flip it (no first-strong rule);
 *   2. inside an RTL line every Latin / number run is one LTR isolate —
 *      dimensions, ranges, part codes, «≤ 300 °C» — with the sentence's own
 *      punctuation and an unbalanced bracket left outside;
 *   3. the component: one block line per line, each with its own `dir`, the
 *      runs in `<bdi dir="ltr">`, an English line plain LTR; the product page,
 *      the tabs and the comparison use it where the owner saw the defect.
 *
 * Run: node --import tsx --test tests/bidi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ROOT } from './fixtures/d1';
import { ltrRuns, scriptDir } from '../src/lib/bidi';
import BidiText from '../src/components/ui/BidiText';

const runs = (s: string) => ltrRuns(s).map((r) => (r.ltr ? `[${r.text}]` : r.text)).join('');

test('scriptDir: Arabic or Sorani script anywhere is RTL; English is LTR; a leading Latin name does not flip it', () => {
  assert.equal(scriptDir('AMS Hub مطلوب لأكثر من وحدة'), 'rtl');
  assert.equal(scriptDir('X1 Series و P1 Series'), 'rtl');
  assert.equal(scriptDir('کەمتر لە 10mA'), 'rtl');
  assert.equal(scriptDir('The Filament buffer is an accessory.'), 'ltr');
  assert.equal(scriptDir('389 × 389 × 458 mm'), 'ltr');
  assert.equal(scriptDir(''), 'ltr');
  assert.equal(scriptDir(null), 'ltr');
});

test('ltrRuns: every Latin and number run isolated, the Arabic punctuation and an unbalanced bracket outside', () => {
  assert.equal(runs('X1 Series و P1 Series'), '[X1 Series] و [P1 Series]');
  assert.equal(runs('الأبعاد 389 × 389 × 458 mm.'), 'الأبعاد [389 × 389 × 458 mm].');
  assert.equal(runs('≤ 300 °C كحد أقصى'), '[≤ 300 °C] كحد أقصى');
  assert.equal(runs('الموصل (SA011)'), 'الموصل ([SA011])');
  assert.equal(runs('برغي M3*21.5 (x2)، و4-Pin.'), 'برغي [M3*21.5 (x2)]، و[4-Pin].');
  assert.equal(runs('نص (ملاحظة عربية) ثم 220-240 V:'), 'نص (ملاحظة عربية) ثم [220-240 V]:');
  assert.equal(runs('کەمتر لە 10mA'), 'کەمتر لە [10mA]');
  assert.equal(runs('دقة ±0.1 mm؛ سرعة 500 mm/s'), 'دقة [±0.1 mm]؛ سرعة [500 mm/s]');
  assert.equal(runs('Pure English text.'), '[Pure English text].', '(an English line is never cut: BidiText draws it plain LTR)');
  assert.equal(runs('نص عربي فقط'), 'نص عربي فقط');
  for (const s of ['الموصل (SA011)', 'برغي M3*21.5 (x2)، و4-Pin.', 'a - b']) assert.equal(ltrRuns(s).map((r) => r.text).join(''), s, 'nothing lost');
});

test('ltrRuns keeps a trailing «+», «™», «®» and a one-character unit («℃», «℉») inside its run (review: «2M+» drawn «+2M»)', () => {
  assert.equal(runs('أكثر من 2M+ نموذج مجاني.'), 'أكثر من [2M+] نموذج مجاني.');
  assert.equal(runs('حتى 180℃'), 'حتى [180℃]');
  assert.equal(runs('من -20℉ إلى 120℉'), 'من [-20℉] إلى [120℉]');
  assert.equal(runs('خيط PLA Silk+ اللامع'), 'خيط [PLA Silk+] اللامع');
  assert.equal(runs('رأس E3D High Flow ObXidian™ Hotend للطابعة'), 'رأس [E3D High Flow ObXidian™ Hotend] للطابعة');
  assert.equal(runs('شعار Bambu Lab® الرسمي'), 'شعار [Bambu Lab®] الرسمي');
  assert.equal(runs('300 °C كحد أقصى'), '[300 °C] كحد أقصى', 'the control case is unchanged');
  for (const s of ['أكثر من 2M+ نموذج', 'حتى 180℃', 'رأس E3D High Flow ObXidian™ Hotend']) assert.equal(ltrRuns(s).map((r) => r.text).join(''), s, 'nothing lost');
});

test('a spaced «-» or «+» between Arabic words and a run is the sentence\'s separator, never the run\'s sign (landing review: «بالمسحوق - 0.075mm» drawn «-0.075mm»)', () => {
  // Committed reviewed translations (spec values, box items, usage bodies, x.* labels): the mark stays in the RTL
  // context, between the word and the run, where the plain RTL paragraph drew it before.
  assert.equal(runs('طلاء PEI بالمسحوق - 0.075mm / صفيحة الفولاذ المقاوم للصدأ - 0.5mm/0.4mm'), 'طلاء [PEI] بالمسحوق - [0.075mm] / صفيحة الفولاذ المقاوم للصدأ - [0.5mm/0.4mm]');
  assert.equal(runs('السرير الساخن - LV'), 'السرير الساخن - [LV]');
  assert.equal(runs('بێدی گەرم - LV'), 'بێدی گەرم - [LV]');
  assert.equal(runs('كابل الناقل (Bus) - (2x)6pin (1.5m)'), 'كابل الناقل ([Bus]) - ([2x])[6pin (1.5m)]');
  assert.equal(runs('1. وحدة 10 W Laser Module - 1 قطعة 2. عدسة الليزر - 1 قطعة'), '[1]. وحدة [10 W Laser Module - 1] قطعة [2]. عدسة الليزر - [1] قطعة');
  assert.equal(runs('23 حساسًا + 3 كاميرات'), '[23] حساسًا + [3] كاميرات');
  assert.equal(runs('تُستخدم لوحة توزيع الطاقة (PDB) - 4 قنوات'), 'تُستخدم لوحة توزيع الطاقة ([PDB]) - [4] قنوات');
  // A sign glued to its number is still the number's, and a prefix mark keeps its number (the existing cases).
  assert.equal(runs('من -20℉ إلى +45℃'), 'من [-20℉] إلى [+45℃]');
  assert.equal(runs('≤ 300 °C كحد أقصى'), '[≤ 300 °C] كحد أقصى');
  for (const s of ['السرير الساخن - LV', '23 حساسًا + 3 كاميرات', 'كابل الناقل (Bus) - (2x)6pin (1.5m)']) assert.equal(ltrRuns(s).map((r) => r.text).join(''), s, 'nothing lost');
  assert.equal(renderToStaticMarkup(createElement(BidiText, { text: 'السرير الساخن - LV' })), '<span dir="rtl">السرير الساخن - <bdi dir="ltr">LV</bdi></span>');
});

test('BidiText: one block line each with its own dir; runs in <bdi dir="ltr">; English plain LTR; empty lines kept', () => {
  const one = renderToStaticMarkup(createElement(BidiText, { text: 'أقل من 10mA' }));
  assert.equal(one, '<span dir="rtl">أقل من <bdi dir="ltr">10mA</bdi></span>');
  assert.equal(renderToStaticMarkup(createElement(BidiText, { text: 'Below 10mA', as: 'bdi' })), '<bdi dir="ltr">Below 10mA</bdi>');
  const many = renderToStaticMarkup(createElement(BidiText, { as: 'p', multiline: true, className: 'x', text: 'يُنعّم المخزن مسار الخيط.\n\nCompatibility: X1 Series, P1P' }));
  assert.equal(
    many,
    '<p class="x"><span dir="rtl" class="block text-start">يُنعّم المخزن مسار الخيط.</span><span class="block h-[0.75em]" aria-hidden="true"></span><span dir="ltr" class="block text-start">Compatibility: X1 Series, P1P</span></p>'
  );
});

test('the page, the tabs and the comparison draw imported text through BidiText; no dir="auto" is left where the owner saw the defect', () => {
  const page = readFileSync(join(ROOT, 'src/pages/Product.tsx'), 'utf8');
  assert.match(page, /<BidiText as="p" multiline className="text-sm text-text-secondary leading-relaxed" text=\{description\} \/>/, 'the description, line by line');
  assert.match(page, /<BidiText as="p" multiline className="text-sm text-text-secondary leading-relaxed" text=\{howToUse\} \/>/);
  assert.match(page, /· <bdi dir=\{scriptDir\(value\)\}>\{value\}<\/bdi>/, 'the chosen value beside its question');
  assert.equal((page.match(/<ChipLabel text=\{(label|m\.label)\} className="block truncate/g) ?? []).length, 4, 'every truncated chooser label ellipsizes at its own end');
  assert.match(page, /<span dir=\{scriptDir\(text\)\} className=\{`\$\{className\} text-start rtl:text-right`\}>/);
  assert.match(page, /<h1 className="[^"]*text-start rtl:text-right" dir=\{scriptDir\(name\)\}>/);
  // The name a desktop reader sees (the h1 is screen-reader-only there): rule 7 too (review: «[Refurbished] …» drawn
  // «… [Refurbished]»).
  assert.match(page, /<p aria-hidden="true" dir=\{scriptDir\(name\)\} className="[^"]*text-start rtl:text-right">\{name\}<\/p>/);
  // The page body's own spec table (the fallback while the knowledge answer is absent): values in reading order.
  const specs = page.slice(page.indexOf('!knowledgeCovers.specs ? ('), page.indexOf('!knowledgeCovers.specs ? (') + 2600);
  assert.match(specs, /<BidiText as="bdi" text=\{pick\(lang as Lang, r\.value_ar, r\.value_en, r\.value_ckb\)\} \/>/);
  assert.match(specs, /<BidiText as="bdi" text=\{spec\.value\} \/>/);
  const description = page.slice(page.indexOf('title={s.description}'), page.indexOf('title={s.description}') + 600);
  assert.doesNotMatch(description, /whitespace-pre-line|dir="auto"/);
  const tabs = readFileSync(join(ROOT, 'src/components/product/ProductKnowledgeTabs.tsx'), 'utf8');
  assert.doesNotMatch(tabs, /dir="auto"/);
  const table = readFileSync(join(ROOT, 'src/components/compare/SpecTable.tsx'), 'utf8');
  assert.match(table, /<BidiText as="bdi" text=\{shown\} \/>/);
});
