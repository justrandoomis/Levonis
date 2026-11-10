/**
 * «الأشخاص» ON SCREEN (owner request 2026-11-09; DECISIONS row 304).
 *
 *   - every string of src/lib/personFinanceStrings.ts exists in ar, en and ckb
 *     with the same keys, and the ckb is real Sorani: at least one Sorani-only
 *     letter, none of the Arabic-only ones (ة ى ي ك) — DECISIONS row 183;
 *   - the Sorani added inline on the rebuilt screens passes the same check;
 *   - percentages read as the owner writes them (45%, 7.0%);
 *   - the Investors tab, the Staff tab and «أرباحي» all draw the one-person
 *     card, and the thirteen-card capital grid with its «رأس المال المتبقي في
 *     الحساب» (13,000,000 beside a modal that said otherwise) is gone.
 *
 * Run: node --import tsx --test tests/personFinanceView.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PERSON_FINANCE_STRINGS, percentText, type PersonFinanceStrings } from '../src/lib/personFinanceStrings';
import { codeOf } from './fixtures/source';

const SORANI_ONLY = /[ڕڵێۆەڤگچپژ]/;
const ARABIC_ONLY = /[ةىيك]/;
const ARABIC_SCRIPT = /[؀-ۿ]/;

/** Every leaf text of a strings object, functions called with sample numbers. */
function texts(value: unknown, path = ''): Array<[string, string]> {
  if (typeof value === 'string') return [[path, value]];
  if (typeof value === 'function') {
    const fn = value as (...args: unknown[]) => string;
    return fn.length === 3 ? [[path, fn(5, 4, 1)]] : fn.length === 2 ? [[path, fn('45%', 4)]] : [[`${path}(1)`, fn(1)], [`${path}(4)`, fn(4)]];
  }
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => texts(v, path ? `${path}.${k}` : k));
  return [];
}
const keys = (s: PersonFinanceStrings) => texts(s).map(([k]) => k).sort();

test('the person picture is worded in Arabic, English and real Sorani, key for key', () => {
  assert.deepEqual(keys(PERSON_FINANCE_STRINGS.en), keys(PERSON_FINANCE_STRINGS.ar));
  assert.deepEqual(keys(PERSON_FINANCE_STRINGS.ckb), keys(PERSON_FINANCE_STRINGS.ar));
  for (const [key, text] of texts(PERSON_FINANCE_STRINGS.ar)) assert.match(text, ARABIC_SCRIPT, `ar ${key}`);
  for (const [key, text] of texts(PERSON_FINANCE_STRINGS.en)) assert.doesNotMatch(text, ARABIC_SCRIPT, `en ${key}`);
  const ar = new Map(texts(PERSON_FINANCE_STRINGS.ar));
  for (const [key, text] of texts(PERSON_FINANCE_STRINGS.ckb)) {
    assert.doesNotMatch(text, ARABIC_ONLY, `ckb ${key} carries an Arabic-only letter: ${text}`);
    assert.notEqual(text, ar.get(key), `ckb ${key} is the Arabic`);
    if (text.replace(/[\d\s%·.,:()«»←÷-]/g, '').length > 3) assert.match(text, SORANI_ONLY, `ckb ${key} has no Sorani-only letter: ${text}`);
  }
});

test('the Sorani written inline on the rebuilt screens is Sorani too', () => {
  const calls = ['src/components/financePeople/InvestorProfiles.tsx', 'src/components/financePeople/PeoplePanel.tsx', 'src/components/financePeople/PersonFinanceView.tsx', 'src/components/financePeople/MyEarnings.tsx']
    .flatMap((file) => [...codeOf(file).matchAll(/loc\('([^']*)', '([^']*)', '([^']*)'\)/g)].map((m) => [file, m[1], m[3]] as const));
  assert.ok(calls.length >= 10);
  for (const [file, ar, ckb] of calls) {
    assert.doesNotMatch(ckb, ARABIC_ONLY, `${file}: «${ckb}»`);
    assert.notEqual(ckb, ar, `${file}: the Sorani is the Arabic`);
  }
});

test('percentages read as the owner writes them', () => {
  assert.equal(percentText(4500), '45%');
  assert.equal(percentText(5000), '50%');
  assert.equal(percentText(702, 1), '7.0%');
  assert.equal(percentText(4153, 1), '41.5%');
  assert.equal(percentText(null), '—');
});

test('the three screens draw the one-person card, and the old capital grid is gone', () => {
  const investors = codeOf('src/components/financePeople/InvestorProfiles.tsx');
  assert.match(investors, /<PersonCard /);
  assert.match(investors, /<PersonSheet /);
  assert.match(investors, /`\$\{PEOPLE\}\/people\?\$\{query\}`/);
  for (const gone of [/رأس المال المتبقي في الحساب/, /موّل مخزونًا مستلمًا/, /حصة رأس المال المخصصة للمخزون المتبقي/, /المتاح التراكمي/]) assert.doesNotMatch(investors, gone);
  const staff = codeOf('src/components/financePeople/PeoplePanel.tsx');
  assert.match(staff, /<WorkStatus /);
  assert.match(staff, /<WorkHolds /);
  // One «waiting» figure for wages everywhere: a paid wage whose order is redone is not waiting (second review 7).
  assert.match(staff, /wagesWaiting\(person\.balance\)/);
  assert.doesNotMatch(staff, /staff_pending_settlement_reserve_iqd/);
  assert.match(codeOf('src/components/financePeople/StaffBalanceBreakdown.tsx'), /wagesWaiting\(balance\)/);
  assert.match(staff, /<PersonSheet /);
  const own = codeOf('src/components/financePeople/MyEarnings.tsx');
  assert.match(own, /<PersonCard person=\{person\} own /);
  assert.match(own, /<PersonSheet person=\{person\} own /);
  // What can be withdrawn now sits right under the card; the older figures are details.
  assert.ok(own.indexOf('<PersonCard ') < own.indexOf('fp-hero') && own.indexOf('fp-hero') < own.indexOf('<EarningsSources '));
  const view = codeOf('src/components/financePeople/PersonFinanceView.tsx');
  // Any debt the server reports is drawn (profit, wages, capital) — the old grid showed them (final review).
  for (const debt of [/s\.profitDebt/, /s\.wageDebt/, /s\.capitalDebt/]) assert.match(view, debt);
  // The person's own page never offers the owner's actions or order links.
  assert.match(view, /owner=\{!own\}/);
  assert.match(view, /owner \? s\.holdAction\[h\.reason\] : undefined/);
});
