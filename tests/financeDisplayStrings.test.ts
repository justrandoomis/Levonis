/**
 * THE P-A SENTENCES IN THREE LANGUAGES, AND THE TOGGLE'S CONTRACT (design P-A
 * §8, §12; docs/DECISIONS.md row 183: a `ckb` slot never carries a copy of the
 * Arabic).
 *
 * Every entry of src/components/financeWorkspace/displayCurrencyStrings.ts and
 * the F1 sentences of the old report have ar, en and real Sorani; placeholders
 * agree across languages. The toggle starts at IQD on every load, is stored
 * nowhere, and the client formats server cents — it computes no money.
 *
 * Run: node --import tsx --test tests/financeDisplayStrings.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { PA_STRINGS, fill } from '../src/components/financeWorkspace/displayCurrencyStrings';
import { financeStrings } from '../src/components/adminFinance/strings';

/** Letters Sorani writes and Arabic does not (tests/programmeRefusals.test.ts), plus Sorani's own ی and ک
 *  (Arabic writes ي and ك) — so a one-word Sorani label such as «دینار» counts. */
const SORANI_ONLY = /[ڕڵێۆەڤگچپژیک]/;
const ARABIC_ONLY = /[ةىيك]/;
const placeholders = (s: string) => [...s.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]).sort();

test('every P-A string has ar, en and its own Sorani — never the Arabic or the English, with a Sorani letter and no Arabic-only one', () => {
  const entries = Object.entries(PA_STRINGS);
  assert.ok(entries.length >= 20, String(entries.length));
  for (const [key, { ar, en, ckb }] of entries) {
    for (const [lang, s] of Object.entries({ ar, en, ckb })) assert.ok(s.trim().length > 0 && s === s.trim(), `${key}.${lang}`);
    assert.notEqual(ckb, ar, `${key}: the Sorani slot carries the Arabic (row 183)`);
    assert.notEqual(ckb, en, `${key}: the Sorani slot carries the English`);
    assert.match(ckb, SORANI_ONLY, `${key}: no Sorani letter — is it Arabic?`);
    assert.doesNotMatch(ckb, ARABIC_ONLY, `${key}: an Arabic-only letter in the Sorani`);
    assert.match(ar, /[؀-ۿ]/, `${key}: the Arabic is not Arabic`);
    assert.doesNotMatch(en, /[؀-ۿ]/, `${key}: Arabic script in the English`);
    assert.deepEqual(placeholders(ckb), placeholders(ar), `${key}: ckb placeholders`);
    assert.deepEqual(placeholders(en), placeholders(ar), `${key}: en placeholders`);
  }
  assert.equal(fill(PA_STRINGS.usdAtTime.en, { rate: '1,600' }), 'At the shop’s dollar rate when ordered: 1,600');
  assert.equal(fill('{a} {b}', { a: 1 }), '1 {b}', 'an unknown placeholder stays as written');
});

test('the brief\'s own words are kept: the toggle note, the report-only note and the F2 sentence', () => {
  assert.equal(PA_STRINGS.usdNote.ar, 'عرض بالدولار فقط. المبالغ المحاسبية محفوظة بالدينار ولا تتغير.');
  assert.equal(PA_STRINGS.reportOnlyNote.ar, 'خصم للعرض في التقرير فقط؛ لا يغيّر حصص المستثمرين ولا الأجور ولا القيود المسجلة');
  assert.equal(PA_STRINGS.displayCurrency.ckb, 'دراوی پیشاندان');
  assert.match(PA_STRINGS.usdToday.ar, /^≈/);
  assert.match(PA_STRINGS.usdMixed.ckb, /^≈/);
});

test('F1 in the old report: the estimate apart, in three languages', () => {
  const ar = financeStrings((a: string) => a);
  const en = financeStrings((_a: string, e: string) => e);
  const ckb = financeStrings((a: string, _e: string, k?: string) => k ?? a);
  for (const key of ['estimateKeptOutBadge', 'estimateApartTitle'] as const) {
    assert.notEqual(ckb[key], ar[key], key);
    assert.notEqual(ckb[key], en[key], key);
    assert.match(String(ckb[key]), SORANI_ONLY, key);
  }
  assert.equal(ar.estimateApartTitle, 'تقدير بتكلفة اليوم — ليس ربحاً فعلياً');
  const note = (s: typeof ar) => s.estimateApartNote('٣٠٬٠٠٠', '١٢٬٠٠٠');
  assert.notEqual(note(ckb), note(ar));
  assert.match(note(ckb), SORANI_ONLY);
  assert.doesNotMatch(note(ckb), ARABIC_ONLY);
});

test('the toggle starts at IQD on every load, is stored nowhere, and the client formats server cents without computing money', () => {
  const src = (f: string) => readFileSync(join(ROOT, 'src/components/financeWorkspace', f), 'utf8');
  const workspace = src('FinanceWorkspace.tsx');
  assert.match(workspace, /useState<DisplayCurrency>\('IQD'\)/);
  assert.doesNotMatch(workspace, /localStorage|sessionStorage/);
  assert.match(workspace, /display=USD/);
  const money = src('displayCurrency.tsx');
  assert.match(money, /formatUsdCents/);
  assert.doesNotMatch(money, /exchangeRate|\* *rate\b|\/ *rate\b|toUsd|iqdTo/, 'no client-side conversion');
  // USD first, the accounting dinars beneath.
  assert.match(money, /PA_STRINGS\.accountingValue/);
  for (const f of ['OrderProfitSheet.tsx', 'OverviewCharts.tsx']) assert.match(src(f), /usd|display/i, f);
});
