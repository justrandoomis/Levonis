/**
 * FOUR SORANI GAPS AND ONE RAW CODE the Release A browser walk found (all older
 * than the release; DECISIONS row 183 — a Sorani slot never carries the Arabic):
 *
 *  1. product cards counted stock in Arabic («52 قطعة», «بقي 2»);
 *  2. the order page dated itself in Arabic months («14 تشرين الأول»), and its
 *     delivery-day chips came back from the server in Arabic because the
 *     detail request never said which language it was read in;
 *  3. the owner's inventory screen started with Arabic action cards and tabs;
 *  4. the owner's product picker printed the stored status code («active»).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { ROOT } from './fixtures/d1';
import { formatDate, formatDateTime } from '../src/components/orders/format';
import { validUntil } from '../src/components/community/offers/types';
import { dayLabel } from '../worker/lib/deliveryDay';

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** A string the source spells out whole: `'…'`, `"…"` or a template with nothing in it. */
const literal = (n: ts.Node | undefined): string | null =>
  n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null;

/**
 * `loc(...)` calls in a file that pass fewer than three languages — or, with
 * `copies` (smart search 1.7, the assistant plan §6 «Languages»: the check
 * extended to the search, assist and diagnose files), whose Sorani slot is
 * the Arabic string copied letter for letter (DECISIONS row 183). A string
 * that is the same in every language by nature (a code, a brand) is written
 * without `loc`.
 */
function twoLanguageLoc(rel: string, { copies = false }: { copies?: boolean } = {}): string[] {
  const sf = ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'loc') {
      const ar = literal(n.arguments[0]);
      if (n.arguments.length < 3 || (copies && ar !== null && ar === literal(n.arguments[2]))) {
        out.push(`${rel}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} ${n.getText().slice(0, 80)}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

test('the product card counts stock in Sorani, not in Arabic', () => {
  assert.deepEqual(twoLanguageLoc('src/components/product/AvailabilityLine.tsx'), []);
  const code = read('src/components/product/AvailabilityLine.tsx');
  assert.match(code, /`تەنها \$\{num\(n\)\} ماوە`/, 'the low-stock phrase in Sorani');
  assert.match(code, /`\$\{num\(n\)\} دانە`/, 'the count in Sorani');
});

test('order dates read in Sorani months with Latin digits — the same months the delivery-day chips print', () => {
  const d = formatDate('2026-10-14T12:00:00Z', 'ckb');
  assert.equal(d, '14ی تشرینی یەکەم 2026');
  assert.doesNotMatch(d, /تشرين الأول|[٠-٩]/, 'no Arabic month and no Arabic-Indic digit');
  assert.match(formatDateTime('2026-10-14T12:00:00Z', 'ckb'), /^14ی تشرینی یەکەم 2026، \d\d:\d\d$/);
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    // With no "today" the label is «weekday day month»: its tail is the month.
    const chip = dayLabel(`2026-${mm}-15`, '', 'ckb').label;
    const date = formatDate(`2026-${mm}-15T12:00:00Z`, 'ckb');
    const month = date.replace(/^15ی /, '').replace(/ 2026$/, '');
    assert.ok(chip.endsWith(month), `month ${m}: the order date says «${month}», the delivery chip «${chip}»`);
  }
  // Arabic and English are untouched.
  assert.match(formatDate('2026-10-14T12:00:00Z', 'ar'), /تشرين/);
  assert.doesNotMatch(formatDate('2026-10-14T12:00:00Z', 'ar'), /یەکەم/);
  assert.match(formatDate('2026-10-14T12:00:00Z', 'en'), /Oct/);
  assert.equal(formatDate('not a date', 'ckb'), '');
});

test('the order detail asks the server in the reader’s language, so the day chips come back in it', () => {
  const code = read('src/pages/OrderDetail.tsx');
  assert.match(code, /api\.get<\{ order: ApiOrder \}>\(`\/api\/orders\/\$\{encodeURIComponent\(id\)\}\?lang=\$\{encodeURIComponent\(lang\)\}`\)/);
  // And the server reads exactly that parameter for the chips.
  assert.equal(dayLabel('2026-10-16', '', 'ckb').label.includes('تشرینی یەکەم'), true);
  assert.match(read('worker/routes/orders.ts'), /delivery_date: deliveryDateVerb\(\s*data\.order,[\s\S]{0,120}langOf\(c\)/);
});

test('the owner’s inventory screen is Sorani from its first card', () => {
  assert.deepEqual(twoLanguageLoc('src/components/adminInventory/AdminInventory.tsx'), []);
});

test('the owner’s product picker names a status in words, never prints the stored code', () => {
  const code = read('src/components/adminProducts/form/ProductPicker.tsx');
  assert.doesNotMatch(code, /\{p\.status\}/, 'the raw status code is printed');
  for (const [ar, en, ckb] of [['منشور', 'Published', 'بڵاوکراوە'], ['مسودة', 'Draft', 'ڕەشنووس'], ['مخفي', 'Hidden', 'شاراوە']]) {
    assert.ok(code.includes(`loc('${ar}', '${en}', '${ckb}')`), `no label for ${en}`);
  }
});

// ------------------------------------------------------- the merchant admin

/** Every .ts/.tsx file under `dir`, relative to the repo root. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.tsx?$/.test(name)) out.push(rel);
  }
  return out;
}

/**
 * THE MERCHANT ADMIN'S SORANI RATCHET. About 1,190 `loc()` calls under
 * src/components/merchant still pass Arabic and English only, so a Sorani
 * reader sees the Arabic (DECISIONS row 183 lists them as the batches still to
 * write). The ceiling is today's count: a new two-language call fails here,
 * and each batch that writes Sorani lowers it.
 */
const MERCHANT_TWO_LANGUAGE_CEILING = 1188;

test('the merchant admin never gains a two-language string; the ceiling only comes down', () => {
  const found = sourceFiles('src/components/merchant').flatMap((f) => twoLanguageLoc(f));
  assert.ok(
    found.length <= MERCHANT_TWO_LANGUAGE_CEILING,
    `${found.length} two-language loc() calls under src/components/merchant, over the ceiling of ${MERCHANT_TWO_LANGUAGE_CEILING} — write the Sorani`
  );
  if (found.length < MERCHANT_TWO_LANGUAGE_CEILING) {
    console.log(`sorani ratchet: ${found.length} left under src/components/merchant — lower MERCHANT_TWO_LANGUAGE_CEILING to it`);
  }
});

test('the shared pieces every merchant screen shows speak Sorani: DataList selection, the shell words, «عروضي»', () => {
  for (const f of ['src/components/ui/DataList.tsx', 'src/components/community/offers/MyOffersList.tsx', 'src/components/community/offers/types.ts', 'src/components/merchant/shell/strings.ts']) {
    assert.deepEqual(twoLanguageLoc(f), [], `${f} still passes Arabic and English only`);
    assert.doesNotMatch(read(f), /OWNER: Sorani to be written by hand/, `${f} still says its Sorani is missing`);
  }
  // «تا …» on «عروضي» names its day in Sorani months, as order dates do.
  const until = validUntil('2026-10-03T12:00:00Z', 'ckb');
  assert.equal(until, '3ی تشرینی یەکەم');
  assert.doesNotMatch(until ?? '', /تشرين الأول|[٠-٩]/, 'no Arabic month and no Arabic-Indic digit');
  assert.match(validUntil('2026-10-03T12:00:00Z', 'ar') ?? '', /تشرين/);
  assert.match(validUntil('2026-10-03T12:00:00Z', 'en') ?? '', /Oct/);
  const list = read('src/components/ui/DataList.tsx');
  assert.ok(list.includes("loc('تحديد الكل', 'Select all', 'هەمووی هەڵبژێرە')"));
  assert.ok(list.includes("loc('إلغاء التحديد', 'Clear selection', 'پاککردنەوەی هەڵبژاردن')"));
});

// ---------------------------------------------------------- the search entries

/**
 * EVERY WAY INTO SEARCH SPEAKS SORANI (smart search 1.7; the assistant plan §1
 * listed the leaks: TopBarSearch, SearchOverlay, ScopedSearch, CommandPalette,
 * FinderBand, the home PrinterFinder and ProductPickerSheet passed Arabic and
 * English only). The extended check — no two-language `loc()` and no Arabic
 * copied into the Sorani slot — holds them, the live field and its panel, the
 * results page, and every file of the assistant and the diagnose screens as
 * they are written (src/components/assist, src/components/diagnose).
 */
const SEARCH_ENTRIES = [
  'src/components/catalog/TopBarSearch.tsx',
  'src/components/catalog/SearchOverlay.tsx',
  'src/components/listing/ScopedSearch.tsx',
  'src/components/ui/CommandPalette.tsx',
  'src/components/catalog/FinderBand.tsx',
  'src/components/home/v2/PrinterFinder.tsx',
  'src/components/chat/ProductPickerSheet.tsx',
  'src/pages/Products.tsx',
  'src/components/community/search/SearchOverlay.tsx',
];

test('every search entry, the live field, the assistant and diagnose speak Sorani — and never the Arabic in its place', () => {
  const dirs = ['src/components/search', 'src/components/assist', 'src/components/diagnose'].filter((d) => existsSync(join(ROOT, d)));
  const files = [...SEARCH_ENTRIES, ...dirs.flatMap(sourceFiles)];
  assert.ok(files.includes('src/components/search/searchKit.tsx'), 'the search UI files were not walked');
  assert.deepEqual(files.flatMap((f) => twoLanguageLoc(f, { copies: true })), []);
  for (const f of SEARCH_ENTRIES) assert.doesNotMatch(read(f), /OWNER: Sorani to be written by hand/, `${f} still says its Sorani is missing`);
  // The words themselves, as written (Sorani, with its own letters — not the Arabic).
  assert.ok(read('src/components/catalog/TopBarSearch.tsx').includes("loc('بحث في المتجر', 'Search the shop', 'گەڕان لە فرۆشگادا')"));
  assert.ok(read('src/components/home/v2/PrinterFinder.tsx').includes("loc('ساعدني أختار', 'Help me choose', 'یارمەتیم بدە هەڵبژێرم')"));
  assert.ok(read('src/components/chat/ProductPickerSheet.tsx').includes("loc('نفدت الكمية', 'Out of stock', 'تەواو بوو')"));
  assert.ok(read('src/components/ui/CommandPalette.tsx').includes("loc('الأخيرة', 'Recent', 'دواییەکان')"));
});

test('the extended check catches what it is for: two languages, and the Arabic copied into the Sorani slot', () => {
  const probe = join('tests', 'fixtures', '__soraniProbe.tsx');
  const src = "loc('بحث', 'Search');\nloc('بحث', 'Search', 'بحث');\nloc('بحث', 'Search', 'گەڕان');\nloc(name.ar, name.en, name.ar);\n";
  const path = join(ROOT, probe);
  writeFileSync(path, src);
  try {
    assert.equal(twoLanguageLoc(probe).length, 1, 'the old check: only the two-language call');
    assert.deepEqual(twoLanguageLoc(probe, { copies: true }).map((l) => l.split(' ')[0]), [`${probe}:1`, `${probe}:2`]);
  } finally {
    rmSync(path, { force: true });
  }
});
