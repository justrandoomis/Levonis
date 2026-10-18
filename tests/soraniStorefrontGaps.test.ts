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
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { ROOT } from './fixtures/d1';
import { formatDate, formatDateTime } from '../src/components/orders/format';
import { dayLabel } from '../worker/lib/deliveryDay';

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** `loc(...)` calls in a file that pass fewer than three languages. */
function twoLanguageLoc(rel: string): string[] {
  const sf = ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'loc' && n.arguments.length < 3) {
      out.push(`${rel}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} ${n.getText().slice(0, 80)}`);
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
  const found = sourceFiles('src/components/merchant').flatMap(twoLanguageLoc);
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
  const list = read('src/components/ui/DataList.tsx');
  assert.ok(list.includes("loc('تحديد الكل', 'Select all', 'هەمووی هەڵبژێرە')"));
  assert.ok(list.includes("loc('إلغاء التحديد', 'Clear selection', 'پاککردنەوەی هەڵبژاردن')"));
});
