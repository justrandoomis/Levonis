/**
 * «ملف بيانات المنتج» SPEAKS ARABIC, ENGLISH AND SORANI (docs/DECISIONS.md
 * row 183): every sentence of the sheet, every reason a line is refused,
 * every section name, every refusal code the round trip raises, and the
 * section titles written into the file itself — each with a `ckb` that is
 * its own Sorani (never the Arabic pasted across) and carries Sorani letters.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { DATA_FILE_FIELDS, DATA_FILE_SECTIONS, DATA_FILE_STATUS, DATA_FILE_STRINGS } from '../src/components/adminProducts/dataFileStrings';
import { DATA_FILE_REFUSALS } from '../packages/contracts/src/dataFileRefusals';
import { SECTION_TITLES } from '../worker/lib/productDataFile';
import { REFUSAL_STRINGS, contractRefusal } from '../src/lib/refusalStrings';

const SORANI_ONLY = /[ڕڵێۆەڤگچپژ]/;

const tables: Record<string, Record<string, { ar: string; en: string; ckb: string }>> = {
  DATA_FILE_STRINGS,
  DATA_FILE_STATUS,
  DATA_FILE_SECTIONS,
  DATA_FILE_FIELDS,
  DATA_FILE_REFUSALS,
  SECTION_TITLES,
};

test('every string of the round trip has ar, en and its own Sorani', () => {
  const problems: string[] = [];
  for (const [table, entries] of Object.entries(tables)) {
    for (const [key, t] of Object.entries(entries)) {
      for (const lang of ['ar', 'en', 'ckb'] as const) if (!t[lang] || !t[lang].trim()) problems.push(`${table}.${key}.${lang} empty`);
      if (t.ckb === t.ar) problems.push(`${table}.${key}: ckb copies the Arabic`);
      if (!SORANI_ONLY.test(t.ckb)) problems.push(`${table}.${key}: no Sorani-only letter in «${t.ckb}»`);
      if (/[؀-ۿ]/.test(t.en)) problems.push(`${table}.${key}: Arabic script in the English`);
    }
  }
  assert.deepEqual(problems, []);
});

test('the refusal codes render by code in the reader\'s language', () => {
  for (const code of Object.keys(DATA_FILE_REFUSALS)) {
    assert.ok(REFUSAL_STRINGS[code], `${code} is in the client table`);
    assert.equal(contractRefusal({ code, message: 'server sentence' }, 'ckb'), REFUSAL_STRINGS[code].ckb);
  }
});

test('the sheet takes its words from the table: no Arabic sentence is written into the component', () => {
  const src = readFileSync(join(ROOT, 'src/components/adminProducts/form/DataFileSheet.tsx'), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join('\n');
  assert.doesNotMatch(src, /[؀-ۿ]/, 'every visible word comes from dataFileStrings.ts');
});
