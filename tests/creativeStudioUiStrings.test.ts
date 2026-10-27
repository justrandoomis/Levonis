/**
 * THE STUDIO SPEAKS ARABIC, ENGLISH AND REAL SORANI — every word
 * (DECISIONS row 183; the walker of tests/adminSecurity.test.ts:195-209).
 *
 *  - every table in src/components/creativeStudio/strings.ts: three non-empty
 *    slots, the Sorani neither the Arabic nor the English, no Arabic-only
 *    letter (ة ى ي ك) in it, and a Sorani letter once it is longer than 8;
 *  - a sentence for EVERY error code of the HTTP contract
 *    (packages/creativeDoc/src/api.ts `ErrorCode`), read from the source so a
 *    new code without words fails here;
 *  - every quality code, refusal code, conflict and option the package can
 *    return has words too.
 *
 * Run: node --import tsx --test tests/creativeStudioUiStrings.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import {
  ALL_TABLES, CONFLICT_TEXT, ERROR_TEXT, OPTION_TEXT, QUALITY_TEXT, REFUSAL_TEXT, ROLE_TEXT, errorText, fill, tx,
} from '../src/components/creativeStudio/strings';
import { LAYER_ROLES } from '../packages/creativeDoc/src/schema';

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** The members of a string-literal union, read from the TypeScript source. */
function unionMembers(src: string, name: string): string[] {
  const start = src.indexOf(`export type ${name} =`);
  assert.ok(start >= 0, `${name} is declared`);
  const end = src.indexOf(';', start);
  return [...src.slice(start, end).matchAll(/'([A-Za-z_]+)'/g)].map((m) => m[1]);
}

test('WORDS: every string in Arabic, English and real Sorani — never a copy, never an Arabic-only letter', () => {
  let count = 0;
  for (const [name, table] of ALL_TABLES) {
    for (const [key, t] of Object.entries(table)) {
      count++;
      for (const lang of ['ar', 'en', 'ckb'] as const) assert.ok(typeof t[lang] === 'string' && t[lang].trim().length > 0, `${name}.${key}.${lang}`);
      assert.notEqual(t.ckb, t.ar, `${name}.${key}: the Sorani is the Arabic`);
      assert.notEqual(t.ckb, t.en, `${name}.${key}: the Sorani is the English`);
      assert.doesNotMatch(t.ckb, /[ةىيك]/, `${name}.${key}: an Arabic-only letter in the Sorani: ${t.ckb}`);
      if (t.ckb.length > 8) assert.match(t.ckb, /[ڕڵۆێەپچژگڤکی]/, `${name}.${key}: no Sorani letter: ${t.ckb}`);
    }
  }
  assert.ok(count > 400, `the walker read the tables (${count} strings)`);
});

test('every error code of the HTTP contract has its own sentence', () => {
  const codes = unionMembers(read('packages/creativeDoc/src/api.ts'), 'ErrorCode');
  assert.ok(codes.length >= 30, `the contract's codes were read (${codes.length})`);
  for (const code of codes) assert.ok(Object.prototype.hasOwnProperty.call(ERROR_TEXT, code), `no words for ${code}`);
  // The client's own failure codes too.
  for (const code of ['NETWORK', 'TIMEOUT', 'INVALID_RESPONSE']) assert.ok(code in ERROR_TEXT, code);
  assert.equal(errorText('KEY_NOT_CONFIGURED', 'x', 'ar'), ERROR_TEXT.KEY_NOT_CONFIGURED.ar);
  assert.equal(errorText('SOMETHING_NEW', 'the server words', 'en'), 'the server words', 'an unknown code keeps the server sentence');
});

test('every code the shared package can return has words: quality, refusals, conflicts, options, roles', () => {
  const quality = unionMembers(read('packages/creativeDoc/src/quality.ts'), 'QualityCode');
  for (const c of quality) assert.ok(c in QUALITY_TEXT, `quality ${c}`);
  const refusals = unionMembers(read('packages/creativeDoc/src/ops.ts'), 'RefusalCode');
  for (const c of refusals) assert.ok(c in REFUSAL_TEXT, `refusal ${c}`);
  const conflicts = unionMembers(read('packages/creativeDoc/src/layout.ts'), 'ConflictCode');
  for (const c of conflicts) assert.ok(c in CONFLICT_TEXT, `conflict ${c}`);
  const options = unionMembers(read('packages/creativeDoc/src/layout.ts'), 'ConflictOption');
  for (const c of options) assert.ok(c in OPTION_TEXT, `option ${c}`);
  for (const r of LAYER_ROLES) assert.ok(r in ROLE_TEXT, `role ${r}`);
});

test('placeholders are filled after the language is chosen, and a missing one stays visible', () => {
  assert.equal(fill('{n} عناصر: {names}', { n: 2, names: 'العنوان، السعر' }), '2 عناصر: العنوان، السعر');
  assert.equal(fill('Version {n}', {}), 'Version {n}');
  assert.equal(tx({ ar: 'أ', en: 'E', ckb: 'ک' }, 'ckb'), 'ک');
});
