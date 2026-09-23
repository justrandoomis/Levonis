/**
 * THE GREY WORD IN THE SEARCH BOX, AND WHEN A KEY TAKES IT.
 *
 * «اقتراحات بلون رصاصي في الشريط الكتابي نفسه، عند الضغط على سبيس يملأ هذا
 * الاقتراح». The rules live in src/components/search/ghost.ts, apart from
 * React, so they can be held here:
 *
 *   - Space takes the completion ONLY while it is showing — caret at the end,
 *     a word being typed. Everywhere else Space is a space, because Space is
 *     also how every word ends.
 *   - It is read from the EDIT (the value grew by one trailing space), not the
 *     key: phone keyboards report keys as `Unidentified` and compose words
 *     before committing them, so a keydown for ' ' never fires where this shop
 *     is actually used.
 *   - Tab and the arrow that points at the END of the text take it on a
 *     keyboard — → in English, ← in Arabic.
 *
 * Run: node --import tsx --test tests/liveSearchGhost.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import {
  acceptOnChange,
  acceptOnKey,
  ghostFor,
  ghostLayers,
  liveQuery,
  stepActive,
  textDirection,
} from '../src/components/search/ghost';

test('the ghost is the rest of the suggested word, as the shop writes it', () => {
  assert.equal(ghostFor('hot', 'Hotend', 'ltr'), 'end');
  assert.equal(ghostFor('bambu la', 'Lab', 'ltr'), 'b');
  assert.equal(ghostFor('طاب', 'طابعة', 'rtl'), 'عة');
  assert.equal(ghostFor('طابعه', 'طابعة', 'rtl'), '', 'nothing left to add once the word is typed, in either spelling');
  // The shopper keeps typing before the next answer lands: the SAME word
  // still completes, a different one does not.
  assert.equal(ghostFor('hote', 'Hotend', 'ltr'), 'nd');
  assert.equal(ghostFor('hat', 'Hotend', 'ltr'), '');
});

test('no ghost after a space, with no suggestion, or across a change of direction', () => {
  assert.equal(ghostFor('hot ', 'Hotend', 'ltr'), '', 'a finished word');
  assert.equal(ghostFor('hot', null, 'ltr'), '');
  assert.equal(ghostFor('', 'Hotend', 'ltr'), '');
  // A Latin word being typed inside an Arabic line: the tail would belong
  // beside "H2", which a second element drawn after the line cannot do.
  assert.equal(ghostFor('طابعة H2', 'H2D', 'rtl'), '');
});

test('an Arabic ghost is drawn joined to the word it continues, without moving it', () => {
  // «طاب» + «عة» is one written word. The tail gets a joiner so its ع takes
  // its connected form; the invisible copy of the typed text gets a
  // NON-joiner so its ب keeps the final form the input draws — otherwise the
  // copy shrinks and the grey tail slides back over the typed letters.
  assert.deepEqual(ghostLayers('طاب', 'عة'), { typed: 'طاب\u200C', tail: '\u200Dعة' });
  assert.deepEqual(ghostLayers('hot', 'end'), { typed: 'hot', tail: 'end' }, 'Latin is left alone');
  assert.deepEqual(ghostLayers('طابع', 'ة'), { typed: 'طابع\u200C', tail: '\u200Dة' });
  assert.deepEqual(ghostLayers('نور', 'ي'), { typed: 'نور', tail: 'ي' }, 'ر never joins forward: the word breaks there anyway');
  assert.deepEqual(ghostLayers('طاب', ''), { typed: 'طاب', tail: '' });
});

test('SPACE takes the ghost only as the edit that appends one space', () => {
  assert.equal(acceptOnChange('hot', 'hot ', 'end'), 'hotend ', 'the owner’s Space');
  assert.equal(acceptOnChange('طاب', 'طاب ', 'عة'), 'طابعة ');
  assert.equal(acceptOnChange('hot', 'hot ', ''), null, 'no ghost showing: a space is a space');
  assert.equal(acceptOnChange('hot', 'h ot', 'end'), null, 'a space typed mid-word is a space');
  assert.equal(acceptOnChange('hot', 'hotx', 'end'), null, 'any other letter replaces the ghost');
  assert.equal(acceptOnChange('hot', 'ho', 'end'), null, 'backspace');
  assert.equal(acceptOnChange('hot', 'hot  ', 'end'), null, 'a paste is not a keystroke');
  // The typed letters are REPLACED by the shop's word, not glued to its tail.
  assert.equal(acceptOnChange('HOT', 'HOT ', 'end', 'Hotend'), 'Hotend ', 'not «HOTend »');
  assert.equal(acceptOnChange('bambu la', 'bambu la ', 'b', 'Lab'), 'bambu Lab ');
  assert.equal(acceptOnChange('طابعه', 'طابعه ', 'ات', 'طابعةات'), 'طابعةات ');
  assert.equal(acceptOnChange('HOT', 'HOT ', 'end', 'Holder'), 'HOTend ', 'a suggestion the tail did not come from is ignored');
});

test('TAB and the arrow toward the END of the text take it on a keyboard', () => {
  assert.equal(acceptOnKey('Tab', 'hot', 'end', 'ltr', true), 'hotend');
  assert.equal(acceptOnKey('Tab', 'HOT', 'end', 'ltr', true, 'Hotend'), 'Hotend');
  assert.equal(acceptOnKey('ArrowLeft', 'طاب', 'عة', 'rtl', true, 'طابعة'), 'طابعة');
  assert.equal(acceptOnKey('ArrowRight', 'hot', 'end', 'ltr', true), 'hotend');
  assert.equal(acceptOnKey('ArrowLeft', 'hot', 'end', 'ltr', true), null, '← moves the caret in English');
  assert.equal(acceptOnKey('ArrowLeft', 'طاب', 'عة', 'rtl', true), 'طابعة', 'in Arabic the end is on the left');
  assert.equal(acceptOnKey('ArrowRight', 'طاب', 'عة', 'rtl', true), null);
  assert.equal(acceptOnKey('Tab', 'hot', 'end', 'ltr', false), null, 'caret not at the end: Tab moves focus as usual');
  assert.equal(acceptOnKey('Tab', 'hot', '', 'ltr', true), null, 'no ghost: Tab moves focus as usual');
  assert.equal(acceptOnKey(' ', 'hot', 'end', 'ltr', true), null, 'Space is read from the edit, never the key');
});

test('the text direction is the first strong letter’s, as dir="auto" computes it', () => {
  assert.equal(textDirection('Hotend', 'rtl'), 'ltr');
  assert.equal(textDirection('طابعة', 'ltr'), 'rtl');
  assert.equal(textDirection('چاپکەر', 'ltr'), 'rtl', 'Sorani');
  assert.equal(textDirection('3 طابعة', 'ltr'), 'rtl', 'digits are not strong');
  assert.equal(textDirection('', 'rtl'), 'rtl', 'empty: the page’s direction, so the placeholder sits right');
});

test('↑/↓ walk the rows and come back to the field past either end', () => {
  assert.equal(stepActive(-1, 1, 3), 0);
  assert.equal(stepActive(2, 1, 3), -1);
  assert.equal(stepActive(-1, -1, 3), 2);
  assert.equal(stepActive(0, -1, 3), -1);
  assert.equal(stepActive(-1, 1, 0), -1, 'nothing to walk');
});

test('the live query keeps a trailing space — it tells the Worker the word is finished', () => {
  assert.equal(liveQuery('  bambu   lab'), 'bambu lab');
  assert.equal(liveQuery('hot '), 'hot ');
});

// =========================================================================
// THE WIRING — what the component and the pages must keep doing
// =========================================================================

const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

test('the field asks the listing, silently, one request per pause', () => {
  const src = read('src/components/search/LiveSearch.tsx');
  assert.match(src, /api\.get<LiveResponse>\(\s*`\/api\/products\?search=\$\{encodeURIComponent\(query\)\}&limit=\$\{ROWS\}`/);
  assert.match(src, /signal: controller\.signal, mascot: 'silent'/, 'aborted per keystroke, and not acted out by the mascot');
  assert.match(src, /const DEBOUNCE_MS = 200;/);
  assert.match(src, /requestRef\.current !== id/, 'a late answer to an older query is dropped');
  assert.match(src, /maxLength=\{SEARCH_MAX_LENGTH\}/, 'the server refuses more than 100 characters');
  assert.match(src, /role="combobox"/);
  assert.match(src, /aria-activedescendant=/);
  assert.match(src, /role="option"/);
  assert.match(src, /acceptOnChange\(value, next, visibleGhost, answer\?\.data\.suggestion\)/, 'Space is read from the edit');
});

test('the header and the results page both carry the live field', () => {
  const header = read('src/components/Header.tsx');
  assert.match(header, /<LiveSearch\b/);
  assert.match(header, /navigate\('\/products\?search=' \+ encodeURIComponent\(query\)\)/);
  assert.doesNotMatch(header, /type="search"/, 'the bare input is gone');
  const products = read('src/pages/Products.tsx');
  assert.match(products, /<LiveSearch\b/, 'the results page can refine without going back');
  assert.match(products, /params\.set\('offset', String\(products\.length\)\)/, 'and page past the first fifty');
});
