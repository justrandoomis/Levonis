/**
 * THE TRANSLATION MEMORY'S SHARED RULES (docs/bambu-import/I18N-DESIGN.md §A.1,
 * §C.3, §E; packages/catalog/src/bambuImport/i18n.ts).
 *
 *   1. `normalizeSource`: NBSP, ZWSP, CRLF, tabs collapse; NFD becomes NFC;
 *      `sourceHash` is the SHA-256 of those UTF-8 bytes (checked against
 *      node:crypto, which is what `sha256sum` prints);
 *   2. `translateLines`: a bullet prefix is kept verbatim, a table row is
 *      translated cell by cell, a missed segment keeps its English, `hit 0`
 *      leaves the text exactly as it was; `translateWhole` normalizes first;
 *   3. `namesOnly`: «X1 Series and P1 Series» is names; a statement that adds
 *      a word is not;
 *   4. `validateTranslationRow`: every refusal code, one failing and one
 *      passing example each, and the part file's exact serialization.
 *
 * Run: node --import tsx --test tests/catalogI18nSegments.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  namesOnly,
  normalizeSource,
  serializeTranslationPart,
  slotSegments,
  sourceHash,
  translateLines,
  translateWhole,
  validateTranslationRow,
  type TranslationRow,
  type Tr,
} from '../packages/catalog/src/bambuImport/i18n';
import { IDENTITY_TERMS } from '../worker/lib/translate/dictionary';

const sha = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

test('normalizeSource collapses NBSP, ZWSP, CRLF and tabs, trims, then NFC; sourceHash is sha256 of those bytes', () => {
  assert.equal(normalizeSource('  Below\u00a010mA \u200b\r\n\tmax  '), 'Below 10mA max');
  assert.equal(normalizeSource('\ufeffCafé'), 'Café');
  assert.equal(normalizeSource('Café').length, 4, 'NFD → NFC');
  assert.equal(normalizeSource('a\u2028b\u2029c'), 'a b c');
  assert.equal(sourceHash('Below 10mA'), sha('Below 10mA'));
  assert.equal(sourceHash('  Below\u00a010mA '), sha('Below 10mA'), 'the key is over the normalized form');
  assert.equal(sourceHash('Café'), sha('Café'));
  assert.match(sourceHash('x'), /^[0-9a-f]{64}$/);
});

const TM = new Map<string, Tr>([
  ['Smooth filament path.', { ar: 'مسار خيط سلس.', ckb: 'ڕێڕەوی فیلامێنتی نەرم.' }],
  ['Weight', { ar: 'الوزن', ckb: 'کێش' }],
  ['Gray', { ar: 'رمادي', ckb: 'خۆڵەمێشی' }],
]);
const lookup = (n: string) => TM.get(n) ?? null;

test('translateLines: bullets kept, cells split, misses stay English, hit 0 leaves the text untouched', () => {
  const text = '• Smooth filament path.\nAn untranslated line.\n\nWeight | 50 g | Gray\n- Smooth   filament\u00a0path. ';
  const t = translateLines(text, lookup);
  assert.equal(t.total, 6);
  assert.equal(t.hit, 4);
  assert.equal(t.ar, '• مسار خيط سلس.\nAn untranslated line.\n\nالوزن | 50 g | رمادي\n- مسار خيط سلس.');
  assert.equal(t.ckb, '• ڕێڕەوی فیلامێنتی نەرم.\nAn untranslated line.\n\nکێش | 50 g | خۆڵەمێشی\n- ڕێڕەوی فیلامێنتی نەرم.');
  const none = translateLines('  Nothing  here \n• at all', lookup);
  assert.equal(none.hit, 0);
  assert.equal(none.ar, '  Nothing  here \n• at all', 'byte-identical when nothing is translated');
  assert.deepEqual(slotSegments(text), ['Smooth filament path.', 'An untranslated line.', 'Weight', '50 g', 'Gray', 'Smooth filament path.']);
  assert.deepEqual(translateWhole(' Gray\u00a0', lookup), { ar: 'رمادي', ckb: 'خۆڵەمێشی' });
  assert.equal(translateWhole('Grey', lookup), null);
  assert.equal(translateWhole('', lookup), null);
});

test('namesOnly: a statement of names and connectors is names; one more word is not', () => {
  const names = ['X1 Series', 'P1 Series'];
  assert.equal(namesOnly('X1 Series and P1 Series', names), true);
  assert.equal(namesOnly('Compatible with X1 Series & P1 Series printers', names), true);
  assert.equal(namesOnly('X1 Series / P1 Series;', names), true);
  assert.equal(namesOnly('X1 Series and P1 Series (requires the AMS Hub)', names), false);
  assert.equal(namesOnly('X1 Series and A1 mini', names), false);
  assert.equal(namesOnly('٢٤', names), false, 'no Latin word: nothing was matched');
});

test('namesOnly: no name removed is never «only names»; the connectors are the design\'s list (review: connector-only English)', () => {
  // I18N-DESIGN §C.3: and or & / , ; + with series printers compatible compatibility — nothing else.
  assert.equal(namesOnly('Compatible with all printers', []), false, 'connectors alone: no name was matched');
  assert.equal(namesOnly('Compatible with all printers', ['AMS Hub']), false);
  assert.equal(namesOnly('Compatible with printers', ['AMS Hub']), false, 'only connectors, but no name: says something');
  assert.equal(namesOnly('For the AMS', ['AMS']), false, '«for» and «the» are words, not connectors');
  assert.equal(namesOnly('Compatible with all X1 Series printers', ['X1 Series']), false, '«all» is a word');
  assert.equal(namesOnly('X1C printer', ['X1C']), false, '«printer» (singular) is not in the list');
  assert.equal(namesOnly('Compatibility: X1 Series, P1P', ['X1 Series', 'P1P']), true, 'names and the design\'s connectors');
  assert.equal(namesOnly('X1 Series + P1 Series', ['X1 Series', 'P1 Series']), true);
});

test('translateLines with the stored slot: a line the memory misses keeps the stored line (review: one hit wiped the slot)', () => {
  const en = 'Smooth filament path.\nColor: Gray\nAn untranslated line.';
  const base = { ar: 'مسار سلس قديم\nاللون: رمادي\nAn untranslated line.', ckb: 'ڕێڕەوی کۆن\nڕەنگ: خۆڵەمێشی\nAn untranslated line.' };
  const t = translateLines(en, lookup, base);
  assert.equal(t.hit, 1);
  assert.equal(t.ar, 'مسار خيط سلس.\nاللون: رمادي\nAn untranslated line.', 'the dictionary\'s line survives');
  assert.equal(t.ckb, 'ڕێڕەوی فیلامێنتی نەرم.\nڕەنگ: خۆڵەمێشی\nAn untranslated line.');
  // A table row: a missed cell keeps the stored cell when the stored row has the same cells.
  const cells = translateLines('Weight | Strong | Gray', lookup, { ar: 'الوزن | قوي | رمادي', ckb: 'کێش | بەهێز | خۆڵەمێشی' });
  assert.equal(cells.ar, 'الوزن | قوي | رمادي');
  assert.equal(cells.ckb, 'کێش | بەهێز | خۆڵەمێشی');
  // A stored slot cut into other lines than the English is not aligned: a missed line keeps its English.
  const off = translateLines(en, lookup, { ar: 'سطر واحد', ckb: 'یەک دێڕ' });
  assert.equal(off.ar, 'مسار خيط سلس.\nColor: Gray\nAn untranslated line.');
  // Without a stored slot: exactly as before.
  assert.equal(translateLines(en, lookup).ar, 'مسار خيط سلس.\nColor: Gray\nAn untranslated line.');
  // A stored line that is blank or a copy of another language never stands in for a translation the memory has.
  assert.equal(translateLines(en, lookup, { ar: '', ckb: '' }).ar, 'مسار خيط سلس.\nColor: Gray\nAn untranslated line.');
});

const IDENTITY = new Set(IDENTITY_TERMS);

function row(en: string, ar: string, ckb: string, over: Partial<TranslationRow> & Record<string, unknown> = {}): Record<string, unknown> {
  return { h: sourceHash(en), en, ar, ckb, kind: 'spec_value_text', status: 'reviewed', products: ['p_a', 'p_b'], ...over };
}
const GOOD = row('Below 10mA', 'أقل من 10mA', 'کەمتر لە 10mA');

test('validateTranslationRow: a good row passes, with the identity terms and the names', () => {
  const v = validateTranslationRow(GOOD, { identity: IDENTITY, names: new Set(['AMS Hub']) });
  assert.equal(v.ok, true, JSON.stringify(v));
  const named = row('Use the AMS Hub with PLA.', 'استخدم AMS Hub مع PLA.', 'AMS Hub لەگەڵ PLA بەکاربهێنە.', { kind: 'short_description' });
  assert.equal(validateTranslationRow(named, { identity: IDENTITY, names: new Set(['AMS Hub']) }).ok, true);
});

test('validateTranslationRow: every refusal code, one failing example each', () => {
  const code = (r: unknown, ctx = { identity: IDENTITY, names: new Set(['AMS Hub', 'Filament Buffer']) }) => {
    const v = validateTranslationRow(r, ctx);
    return v.ok ? 'ok' : v.code;
  };
  const cases: Array<[string, unknown]> = [
    ['SHAPE', { ...GOOD, extra: 1 }],
    ['SHAPE', [GOOD]],
    ['SHAPE', { ...GOOD, products: 'p_a' }],
    ['EMPTY', { ...GOOD, ar: '' }],
    ['NOT_NORMALIZED', row('Below  10mA', 'أقل من 10mA', 'کەمتر لە 10mA', { h: sourceHash('Below 10mA') })],
    ['NOT_NORMALIZED', { ...GOOD, ar: 'أقل من\n10mA' }],
    ['HASH', { ...GOOD, h: sourceHash('Below 10 mA') }],
    ['HASH', { ...GOOD, h: 'A'.repeat(64) }],
    ['KIND', { ...GOOD, kind: 'price' }],
    ['STATUS', { ...GOOD, status: 'approved' }],
    ['TOO_LONG', { ...GOOD, ar: `أقل من 10mA ${'ب'.repeat(300)}` }],
    ['TOO_LONG', row('x'.repeat(4001), 'س', 'ە')],
    ['BIDI_CONTROL', { ...GOOD, ar: 'أقل من \u200e10mA' }],
    ['AR_SCRIPT', { ...GOOD, ar: 'Below 10mA' }],
    ['AR_SCRIPT', { ...GOOD, ar: 'کەمتر لە 10mA', ckb: 'کەمتر لە 10mA ی' }],
    ['CKB_SCRIPT', { ...GOOD, ckb: 'Below 10mA' }],
    ['CKB_SCRIPT', { ...GOOD, ckb: 'اقل من 10mA' }],
    ['CKB_COPIES_AR', { ...GOOD, ckb: 'أقل من 10mA' }],
    ['DIGITS', { ...GOOD, ar: 'أقل من ١٠mA' }],
    ['DIGITS', row('Holds 2 spools', 'يحمل بكرتين', 'دوو بکرە هەڵدەگرێت', { kind: 'short_description' })],
    ['TOKEN_LOST', { ...GOOD, ar: 'أقل من 10 مللي أمبير' }],
    ['TOKEN_LOST', row('Works with PLA', 'يعمل مع البلا', 'لەگەڵ PLA کار دەکات', { kind: 'short_description' })],
    ['TOKEN_LOST', row('Connector (SA011)', 'الموصل (SA 011)', 'گەیەنەر (SA011)', { kind: 'short_description' })],
    ['NAME_TRANSLATED', row('Requires the AMS Hub', 'يتطلب موزع AMS', 'پێویستی بە AMS Hub هەیە', { kind: 'short_description' })],
    ['MONEY_ADDED', row('Gray', 'رمادي بسعر خاص', 'خۆڵەمێشی', { kind: 'spec_value_text' })],
    ['MONEY_ADDED', row('Gray', 'رمادي', 'خۆڵەمێشی بە نرخی تایبەت', { kind: 'spec_value_text' })],
    ['MONEY_ADDED', row('Gray', 'رمادي - الشحن خلال يومين', 'خۆڵەمێشی', { kind: 'spec_value_text' })],
    ['MONEY_ADDED', row('Gray', 'رمادي', 'نرخی خۆڵەمێشی', { kind: 'spec_value_text' })],
    ['MONEY_ADDED', row('Gray', 'رمادي', 'خۆڵەمێشی (نرخەکەی)', { kind: 'spec_value_text' })],
    ['KEEP', row('Bambu PET-CF/TPU 95A', 'Bambu PET-CF/TPU 95A', 'Bambu PET-CF', { status: 'keep' })],
    ['KEEP', row('Windows', 'ويندوز', 'Windows', { status: 'keep' })],
    ['PRODUCTS', { ...GOOD, products: [] }],
    ['PRODUCTS', { ...GOOD, products: ['p_b', 'p_a'] }],
    ['PRODUCTS', { ...GOOD, products: ['p_a', 'p_a'] }],
    ['PRODUCTS', { ...GOOD, products: ['bad id'] }],
  ];
  for (const [want, r] of cases) assert.equal(code(r), want, `${want}: ${JSON.stringify(r).slice(0, 160)}`);
  // …and the passing twin of the trickier ones.
  assert.equal(code(row('Holds 2 spools', 'يحمل 2 بكرة', 'دوو بکرە هەڵدەگرێت 2', { kind: 'short_description' })), 'ok');
  assert.equal(code(row('Connector (SA011)', 'الموصل (SA011)', 'گەیەنەر (SA011)', { kind: 'short_description' })), 'ok');
  assert.equal(code({ ...GOOD, ar: 'أقل من 10 mA ', ckb: 'کەمتر لە 10mA' }), 'NOT_NORMALIZED');
  assert.equal(code(row('24 V input', 'دخل 24 V', 'تێچوونی 24 V', { kind: 'short_description' })), 'ok', 'a unit with or without the space');
  assert.equal(code(row('1st layer', 'الطبقة 1st', 'چینی 1st', { kind: 'short_description' })), 'ok');
  assert.equal(code({ ...GOOD, ckb: 'کەمتر' }), 'DIGITS');
  assert.equal(code({ ...GOOD, ckb: 'ە 10mA' }), 'ok', 'one Sorani word is enough');
  assert.equal(code(row('Full list', 'قائمة كاملة', 'لیست کامل', { kind: 'doc_title' })), 'CKB_SCRIPT', 'two Arabic-script words without a Sorani letter');
  assert.equal(code(row('Full list', 'قائمة كاملة', 'لیستی تەواو', { kind: 'doc_title' })), 'ok');
  // «بەنرخ» is «valuable», not a price (review: the money check refused an honest Sorani line).
  assert.equal(code(row('Save valuable time.', 'وفّر وقتك الثمين.', 'کاتی بەنرخی خۆت بپارێزە.', { kind: 'short_description' })), 'ok');
  assert.equal(code(row('Priceless', 'لا يُقدَّر', 'بێنرخ نییە', { kind: 'short_description' })), 'ok');
  // A `keep` row: the reviewers decided the English stays (names, codes, filenames) — its ar and ckb are the English.
  assert.equal(code(row('Bambu PET-CF/TPU 95A', 'Bambu PET-CF/TPU 95A', 'Bambu PET-CF/TPU 95A', { status: 'keep' })), 'ok');
  assert.equal(code(row('MacOS, Windows', 'MacOS, Windows', 'MacOS, Windows', { status: 'keep' })), 'ok');
});

test('a part file is one row per line, keys in the committed order, LF and a trailing newline', () => {
  const v = validateTranslationRow(GOOD);
  assert.ok(v.ok);
  const text = serializeTranslationPart([v.row, v.row]);
  assert.equal(text.split('\n').length, 5);
  assert.ok(text.startsWith('[\n{"h":"'));
  assert.ok(text.endsWith('}\n]\n'));
  assert.deepEqual(Object.keys(JSON.parse(text)[0]), ['h', 'en', 'ar', 'ckb', 'kind', 'status', 'products']);
  assert.equal(serializeTranslationPart([]), '[]\n');
});
