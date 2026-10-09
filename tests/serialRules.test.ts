/**
 * SERIAL FORMAT RULES — THE PURE HALF (owner decision 2, 2026-10-09;
 * migration 0181; packages/catalog/src/serialRules.ts).
 *
 * The owner: the shop sells Bambu Lab and Snapmaker (and Creality, Anycubic,
 * ELEGOO); the Bambu serial shape alone never refuses a serial; each brand
 * has its own rules and another brand's validator is added without a
 * rebuild. So a rule is DATA in a restricted format — and this file proves
 * the format cannot carry a pattern, that every bound holds, and what each
 * seeded rule says about real serials.
 *
 * Run: node --import tsx --test tests/serialRules.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { freshDb, row } from './fixtures/app';
import {
  BAMBU_BOX_SN_RE,
  GENERIC_RULE,
  LEGACY_RULE,
  evaluateSerial,
  parseSerialRule,
  specAsRule,
  type SerialRule,
  type SerialRuleSpec,
} from '../packages/catalog/src/serialRules';
import { BOX_SN_RE, buildBulkRow, classifyCode, classifyLabel, serialModelHint } from '../packages/catalog/src/deviceSerials';
import { ruleFromRow, type RuleRow } from '../worker/lib/serialRules';
import { classifyScanInput, serialFamilyConflict } from '../worker/lib/serialAssignments';
import { REFUSAL_STRINGS } from '../src/lib/refusalStrings';
import { SERIAL_RULES_STRINGS, ruleFieldName } from '../src/components/adminWarranty/serialInventory/serialRulesStrings';
import { SERIAL_STRINGS } from '../src/components/adminOrders/serials/strings';
import { formatNoteText } from '../src/components/adminOrders/serials/formatNotes';

const SN15 = '03919D580607841'; // the owner's A1 Combo label
const SN18 = '03919D580607841ABC';
const SN16 = '03919D5806078412';
const BOX = 'B07119G5811000AB';
const EAN = '6977252425445';

/** The two seed rules exactly as migration 0181 stores them. */
function seeds(): { bambu: SerialRule; snapmaker: SerialRule } {
  const raw = freshDb();
  const read = (id: string) => ruleFromRow(row<RuleRow>(raw, 'SELECT * FROM serial_brand_rules WHERE id = ?', id)!);
  return { bambu: read('sbr_bambu_lab'), snapmaker: read('sbr_snapmaker') };
}

const spec = (over: Record<string, unknown>) => {
  const p = parseSerialRule({ label: 'T', ...over });
  assert.ok(p.ok, JSON.stringify(p));
  return (p as { spec: SerialRuleSpec }).spec;
};
const refusedAt = (input: unknown) => {
  const p = parseSerialRule(input);
  assert.equal(p.ok, false, `accepted: ${JSON.stringify(input).slice(0, 120)}`);
  return p as { ok: false; field: string; reason: string };
};

// ------------------------------------------------------------------ the parser

test('the parser holds every bound of the format, and names the field to fix', () => {
  assert.equal(refusedAt({ min_len: 5 }).field, 'min_len');
  assert.equal(refusedAt({ max_len: 41 }).field, 'max_len');
  assert.deepEqual(refusedAt({ min_len: 20, max_len: 10 }), { ok: false, field: 'min_len', reason: 'MIN_OVER_MAX' });
  assert.equal(refusedAt({ lengths: [6, 7, 8, 9, 10, 11, 12] }).reason, 'TOO_MANY');
  assert.equal(refusedAt({ lengths: [5] }).field, 'lengths[0]');
  assert.equal(refusedAt({ lengths: [41] }).reason, 'OUT_OF_RANGE');
  assert.equal(refusedAt({ lengths: [15, 15] }).reason, 'DUPLICATE');
  assert.equal(refusedAt({ lengths: '15' }).reason, 'NOT_A_LIST');
  const many = Array.from({ length: 65 }, (_, i) => ({ p: `P${i}`, m: 'M' }));
  assert.equal(refusedAt({ prefixes: many }).reason, 'TOO_MANY');
  assert.equal(refusedAt({ prefixes: [{ p: 'AB-1', m: 'X' }] }).field, 'prefixes[0].p', 'letters and digits only');
  assert.equal(refusedAt({ prefixes: [{ p: 'ABCDEFG', m: 'X' }] }).reason, 'TOO_LONG');
  assert.equal(refusedAt({ prefixes: [{ p: '039', m: '' }] }).field, 'prefixes[0].m');
  assert.equal(refusedAt({ prefixes: [{ p: '039', m: 'A1' }, { p: '039', m: 'A1 mini' }] }).reason, 'DUPLICATE');
  assert.equal(refusedAt({ prefixes: [{ p: '039', m: 'A1', a: ['a', 'b', 'c', 'd', 'e'] }] }).reason, 'TOO_MANY');
  const positions = Array.from({ length: 9 }, (_, i) => ({ at: i + 1, len: 1, cls: 'DIGIT' }));
  assert.equal(refusedAt({ positions }).reason, 'TOO_MANY');
  assert.equal(refusedAt({ positions: [{ at: 41, len: 1, cls: 'DIGIT' }] }).field, 'positions[0].at');
  assert.equal(refusedAt({ positions: [{ at: 38, len: 4, cls: 'DIGIT' }] }).field, 'positions[0].len', 'a position never reaches past 40');
  assert.equal(refusedAt({ positions: [{ at: 1, len: 2, cls: 'ABC' }] }).field, 'positions[0].cls', 'a literal is exactly `len` characters');
  for (const [k, v] of [['charset', 'UNICODE'], ['mode', 'strict'], ['box_sn_shape', 'creality'], ['prefix_policy', 'never'], ['family_check', 'yes']] as const) {
    assert.deepEqual(refusedAt({ [k]: v }), { ok: false, field: k, reason: 'BAD_VALUE' }, k);
  }
  assert.deepEqual(refusedAt({ label: 'x'.repeat(61) }), { ok: false, field: 'label', reason: 'TOO_LONG' });
  assert.deepEqual(refusedAt({ source_note: 'x'.repeat(301) }), { ok: false, field: 'source_note', reason: 'TOO_LONG' });
  assert.deepEqual(refusedAt({ source_note: 'ö'.repeat(299), label: 'é'.repeat(60), prefixes: Array.from({ length: 40 }, (_, i) => ({ p: `P${i}`, m: 'Ø'.repeat(40) })) }), {
    ok: false,
    field: '*',
    reason: 'TOO_LARGE',
  });
  // Unknown keys, at the top and inside an entry.
  assert.deepEqual(refusedAt({ pattern: '^0' }), { ok: false, field: 'pattern', reason: 'UNKNOWN_KEY' });
  assert.deepEqual(refusedAt({ prefixes: [{ p: '039', m: 'A1', re: '.*' }] }), { ok: false, field: 'prefixes[0].re', reason: 'UNKNOWN_KEY' });
  assert.deepEqual(refusedAt([1, 2]), { ok: false, field: '', reason: 'NOT_AN_OBJECT' });
  // Left out = the table's default (the generic rule's shape).
  assert.deepEqual(spec({}), {
    label: 'T', mode: 'warn', charset: 'ALNUM', min_len: 6, max_len: 40, lengths: [], prefixes: [], prefix_policy: 'hint', positions: [], box_sn_shape: 'none', family_check: false, source_note: '',
  });
  // A prefix is stored upper case; a model keeps its words.
  assert.deepEqual(spec({ prefixes: [{ p: ' 00m ', m: 'X1C', a: ['X1 Carbon'] }] }).prefixes, [{ p: '00M', m: 'X1C', a: ['X1 Carbon'] }]);
});

test('NO REGEX FROM DATA: a pattern-looking string is refused in every field, and the module builds none', () => {
  const evil = '^(a+)+$';
  assert.equal(refusedAt({ label: evil }).reason, 'PATTERN_NOT_ALLOWED');
  assert.equal(refusedAt({ source_note: 'see (wiki)' }).reason, 'PATTERN_NOT_ALLOWED');
  assert.equal(refusedAt({ prefixes: [{ p: '^0', m: 'A1' }] }).reason, 'PATTERN_NOT_ALLOWED');
  assert.equal(refusedAt({ prefixes: [{ p: '039', m: 'A1|A2' }] }).reason, 'PATTERN_NOT_ALLOWED');
  assert.equal(refusedAt({ prefixes: [{ p: '039', m: 'A1', a: ['X1.*'] }] }).reason, 'PATTERN_NOT_ALLOWED');
  assert.equal(refusedAt({ positions: [{ at: 1, len: 2, cls: '[0-9]' }] }).reason, 'PATTERN_NOT_ALLOWED');
  const src = readFileSync(join(ROOT, 'packages/catalog/src/serialRules.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.equal(/new\s+RegExp\s*\(|\bRegExp\s*\(/.test(src), false, 'serialRules.ts never builds a RegExp');
  // …and the worker's half reads stored rows without building one either.
  const worker = readFileSync(join(ROOT, 'worker/lib/serialRules.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.equal(/\bRegExp\s*\(/.test(worker), false);
  // The seeds the migration writes are themselves valid rules.
  const { bambu, snapmaker } = seeds();
  for (const r of [bambu, snapmaker]) {
    const back = parseSerialRule(Object.fromEntries(Object.entries(r).filter(([k]) => !['id', 'version', 'scope', 'brand_id', 'product_id'].includes(k))));
    assert.ok(back.ok, `${r.id} round-trips through the parser: ${JSON.stringify(back)}`);
  }
});

// ------------------------------------------------------------------ Bambu Lab

test('Bambu Lab: 15 and 18 characters with a known prefix pass, 16 warns, an unknown prefix warns, the box number is refused', () => {
  const { bambu } = seeds();
  assert.equal(bambu.box_sn_shape, 'bambu');
  assert.equal(bambu.family_check, true);
  assert.equal(bambu.mode, 'warn');
  assert.deepEqual(bambu.lengths, [15, 18]);
  assert.equal(bambu.prefixes.length, 13, "the 13 printer prefixes of Bambu's own page");
  assert.deepEqual(evaluateSerial(SN15, bambu), { refuse: [], warnings: [], family: { p: '039', m: 'A1' } });
  assert.deepEqual(evaluateSerial(SN18, bambu).warnings, []);
  assert.deepEqual(evaluateSerial(SN16, bambu), { refuse: [], warnings: [{ code: 'LENGTH_UNEXPECTED', len: 16, expected: '15 / 18' }], family: null });
  assert.deepEqual(evaluateSerial('ZZZ19D580607841', bambu).warnings, [{ code: 'PREFIX_UNKNOWN' }], '`hint`: a warning');
  assert.deepEqual(evaluateSerial(BOX, bambu).refuse, [{ code: 'LOOKS_LIKE_BOX' }]);
  // `known_only` + `enforce`: the unknown prefix is refused, the 16 too.
  const strict = { ...bambu, prefix_policy: 'known_only' as const, mode: 'enforce' as const };
  assert.deepEqual(evaluateSerial('ZZZ19D580607841', strict).refuse, [{ code: 'PREFIX_UNKNOWN' }]);
  assert.equal(evaluateSerial(SN16, strict).refuse[0]?.code, 'LENGTH_UNEXPECTED');
  // `off`: nothing beyond the hard checks — and its box number is no longer refused (only said).
  const off = { ...bambu, mode: 'off' as const };
  assert.deepEqual(evaluateSerial(SN16, off), { refuse: [], warnings: [], family: null });
  assert.deepEqual(evaluateSerial(BOX, off).warnings, [{ code: 'LOOKS_LIKE_BAMBU_BOX' }]);
  // Bulk Add under the Bambu rule: the box number is still refused, and so are an EAN and a receipt.
  assert.equal(buildBulkRow(1, { serial: BOX }, {}, bambu).problem, 'SERIAL_LOOKS_LIKE_BOX');
  assert.equal(buildBulkRow(1, { serial: EAN }, {}, bambu).problem, 'SERIAL_LOOKS_LIKE_EAN');
  assert.equal(buildBulkRow(1, { serial: 'WR-2026-0905-001' }, {}, bambu).problem, 'SERIAL_LOOKS_LIKE_RECEIPT');
  assert.deepEqual(buildBulkRow(1, { serial: SN16 }, {}, bambu).warnings, [{ code: 'LENGTH_UNEXPECTED', len: 16, expected: '15 / 18' }]);
  assert.equal(buildBulkRow(1, { serial: SN16 }, {}, bambu).problem, null, 'warn mode: the row is still added');
  assert.equal(buildBulkRow(1, { serial: SN16 }, {}, strict).problem, 'SERIAL_FORMAT_MISMATCH', 'enforce: refused, with its reasons');
  assert.equal(buildBulkRow(1, { serial: SN16 }, {}, strict).warnings[0].code, 'LENGTH_UNEXPECTED');
});

test('the generic rule and Snapmaker: a Bambu-box-shaped serial is ACCEPTED with a warning; a U1-style serial passes; hard checks stay', () => {
  const { snapmaker } = seeds();
  assert.equal(snapmaker.box_sn_shape, 'none');
  assert.equal(snapmaker.family_check, false);
  assert.equal(snapmaker.mode, 'warn');
  assert.deepEqual([snapmaker.min_len, snapmaker.max_len, snapmaker.lengths, snapmaker.charset], [6, 40, [], 'ALNUM'], 'generic ALNUM 6–40, no invented format');
  for (const r of [GENERIC_RULE, snapmaker]) {
    assert.deepEqual(evaluateSerial(BOX, r), { refuse: [], warnings: [{ code: 'LOOKS_LIKE_BAMBU_BOX' }], family: null }, r.id);
    assert.deepEqual(evaluateSerial('12345678901234567890', r), { refuse: [], warnings: [], family: null }, `${r.id}: 16 digits + a 4-character code`);
    assert.deepEqual(evaluateSerial('ABCD1234EF', r).warnings, []);
    const bulk = buildBulkRow(1, { serial: BOX }, {}, r);
    assert.equal(bulk.problem, null, `${r.id}: Bulk Add takes it`);
    assert.deepEqual(bulk.warnings, [{ code: 'LOOKS_LIKE_BAMBU_BOX' }]);
    // The hard checks are the same for every brand.
    assert.equal(buildBulkRow(1, { serial: EAN }, {}, r).problem, 'SERIAL_LOOKS_LIKE_EAN');
    assert.equal(buildBulkRow(1, { serial: '036000291452' }, {}, r).problem, 'SERIAL_LOOKS_LIKE_EAN', 'a UPC-A of any brand');
    assert.equal(buildBulkRow(1, { serial: 'WR-2026-0905-001' }, {}, r).problem, 'SERIAL_LOOKS_LIKE_RECEIPT');
    assert.equal(buildBulkRow(1, { serial: 'AB12' }, {}, r).problem, 'SERIAL_TOO_SHORT');
    assert.equal(buildBulkRow(1, { serial: 'NEP 4. 234' }, {}, r).problem, 'SERIAL_CHARS');
  }
  // The classifier: the box shape is a box only under a rule that names it.
  assert.equal(BOX_SN_RE, BAMBU_BOX_SN_RE);
  assert.deepEqual(classifyCode({ text: BOX }), { kind: 'box_sn', value: BOX }, "today's reading by default");
  assert.deepEqual(classifyCode({ text: BOX }, { boxShape: 'none' }), { kind: 'serial', value: BOX });
  assert.deepEqual(classifyScanInput(BOX, GENERIC_RULE), { kind: 'serial', norm: BOX, raw: BOX });
  assert.deepEqual(classifyScanInput(BOX, seeds().bambu), { kind: 'box_sn', box: BOX });
  assert.deepEqual(classifyScanInput(BOX), { kind: 'box_sn', box: BOX }, 'no rule named: LEGACY_RULE');
  // A label of several codes keeps the positional Bambu reading.
  assert.deepEqual(classifyLabel([{ text: BOX }, { text: SN15 }, { text: EAN }]), { productSn: SN15, boxSn: BOX, ean: EAN, receipt: null });
});

test('enforce with positions and characters: fixed classes, no pattern', () => {
  const r = specAsRule(spec({ mode: 'enforce', charset: 'DIGITS', lengths: [10], positions: [{ at: 1, len: 2, cls: '12' }, { at: 3, len: 1, cls: 'DIGIT' }] }));
  assert.deepEqual(evaluateSerial('1234567890', r), { refuse: [], warnings: [], family: null });
  assert.deepEqual(evaluateSerial('9934567890', r).refuse, [{ code: 'POSITION_UNEXPECTED', at: 1 }]);
  assert.deepEqual(
    evaluateSerial('12A4567890X', r).refuse.map((n) => n.code),
    ['LENGTH_UNEXPECTED', 'CHARS_UNEXPECTED', 'POSITION_UNEXPECTED']
  );
  const hex = specAsRule(spec({ charset: 'HEX' }));
  assert.deepEqual(evaluateSerial('ABCDEF0123', hex).warnings, []);
  assert.deepEqual(evaluateSerial('ABCDEFG123', hex).warnings, [{ code: 'CHARS_UNEXPECTED' }]);
});

// ------------------------------------------------------------------ the model family

test('the model check: the Bambu rule with its aliases fixes X1C; another brand is never checked; LEGACY is today', () => {
  const { bambu, snapmaker } = seeds();
  // 030 (A1 mini) on «A1 Combo»: a conflict, as today.
  assert.deepEqual(serialFamilyConflict('03000A123456789', ['Bambu Lab A1 Combo'], bambu), { serial_family: 'A1 mini', product_family: 'Bambu Lab A1 Combo' });
  assert.equal(serialFamilyConflict(SN15, ['Bambu Lab A1 Combo'], bambu), null);
  // THE X1C DEFECT: `00M` names «X1C» and «X1 Carbon» — both product names agree.
  assert.equal(serialFamilyConflict('00M00A123456789', ['Bambu Lab X1C'], bambu), null, 'a real X1C on «X1C»: no conflict');
  assert.equal(serialFamilyConflict('00M00A123456789', ['Bambu Lab X1 Carbon Combo'], bambu), null, '…and on «X1 Carbon»');
  assert.ok(serialFamilyConflict('00M00A123456789', ['Bambu Lab A1 Combo'], bambu), 'an X1C serial on an A1 is still another model');
  // Today's rule (before 0181) keeps today's behaviour, defect included.
  assert.ok(serialFamilyConflict('00M00A123456789', ['Bambu Lab X1C'], LEGACY_RULE), 'LEGACY: the X1C defect, unchanged until 0181');
  assert.ok(serialFamilyConflict('00M00A123456789', ['Bambu Lab X1C']), 'no rule named: LEGACY_RULE');
  // Another brand is never refused for its first characters.
  assert.equal(serialFamilyConflict('039ABCDEF012345', ['Creality K1C'], GENERIC_RULE), null);
  assert.equal(serialFamilyConflict('039ABCDEF012345', ['Snapmaker U1'], snapmaker), null);
  assert.ok(serialFamilyConflict('039ABCDEF012345', ['Creality K1C'], LEGACY_RULE), 'which is exactly what today does');
  // An 18-character Bambu serial names its family too (Bambu: "15 or 18").
  assert.deepEqual(serialFamilyConflict('03000A123456789ABC', ['Bambu Lab A1 Combo'], bambu)?.serial_family, 'A1 mini');
  // The display hint follows the rule; without one, the five-prefix fallback.
  assert.equal(serialModelHint('094ABC123456789', bambu)?.label, 'Bambu Lab H2D');
  assert.equal(serialModelHint('094ABC123456789'), null, 'the fallback knows five prefixes');
  assert.equal(serialModelHint(SN15)?.model, 'A1');
  assert.equal(serialModelHint(SN15, GENERIC_RULE), null, 'a rule with no prefixes names no family');
});

// ------------------------------------------------------------------ the words

test('every new line exists in Arabic, English and Sorani — and the Sorani is its own', () => {
  for (const code of ['SERIAL_FORMAT_MISMATCH', 'SERIAL_RULE_INVALID', 'SERIAL_RULE_CHANGED', 'SERIAL_RULE_EXISTS', 'SERIAL_RULE_NOT_FOUND', 'SERIAL_RULE_TARGET_UNKNOWN', 'SERIAL_RULES_NOT_INSTALLED']) {
    const e = REFUSAL_STRINGS[code];
    assert.ok(e && e.ar && e.en && e.ckb, code);
    assert.notEqual(e.ckb, e.ar, `${code}: ckb copies the Arabic`);
    assert.notEqual(e.ckb, e.en, `${code}: ckb copies the English`);
  }
  // The plan's own sentences.
  assert.equal(REFUSAL_STRINGS.SERIAL_FORMAT_MISMATCH.ar, 'الرقم التسلسلي لا يطابق صيغة الأرقام التي ضبطها المالك لهذه العلامة التجارية.');
  assert.equal(REFUSAL_STRINGS.SERIAL_RULE_CHANGED.ckb, 'کەسێک پێش تۆ ئەم یاسایەی گۆڕی؛ دووبارە بارکرایەوە — پێیدا بچۆرەوە و دووبارە پاشەکەوتی بکە.');
  // The owner screen's own table.
  const { ar, en, ckb } = SERIAL_RULES_STRINGS;
  const sample = (v: unknown): string[] => {
    if (typeof v === 'string') return [v];
    if (typeof v === 'function') return [String((v as (...a: unknown[]) => unknown)(7, 3, 2, 1))];
    if (v && typeof v === 'object') return Object.values(v as Record<string, unknown>).flatMap(sample);
    return [];
  };
  const keys = Object.keys(ar) as Array<keyof typeof ar>;
  assert.deepEqual(Object.keys(en).sort(), [...keys].sort());
  assert.deepEqual(Object.keys(ckb).sort(), [...keys].sort());
  for (const k of keys) {
    const a = sample(ar[k]);
    const e = sample(en[k]);
    const c = sample(ckb[k]);
    assert.equal(c.length, a.length, `ckb.${String(k)} has every entry`);
    assert.equal(e.length, a.length, `en.${String(k)} has every entry`);
    c.forEach((line, i) => {
      assert.ok(line.trim(), `ckb.${String(k)}[${i}] is empty`);
      assert.notEqual(line, a[i], `ckb.${String(k)} copies the Arabic: «${line}»`);
      assert.notEqual(line, e[i], `ckb.${String(k)} copies the English: «${line}»`);
    });
  }
  assert.equal(ar.tabTitle, 'صيغ الأرقام التسلسلية');
  assert.equal(ckb.unbrandedTitle, 'ئەو بەرهەمانەی ژمارەی زنجیرەییان پێویستە بەڵام براندیان نییە');
  assert.equal(ruleFieldName('prefixes[3].p', en), 'prefixes (4)');
  // The format notes, by code, in the three languages (the serial-scan table's own test walks ckb ≠ ar for them too).
  assert.equal(formatNoteText({ code: 'LENGTH_UNEXPECTED', len: 16, expected: '15 / 18' }, 'en'), 'Unusual length for this brand (16 characters; expected 15 / 18).');
  assert.equal(formatNoteText({ code: 'LOOKS_LIKE_BAMBU_BOX' }, 'ar'), SERIAL_STRINGS.ar.formatNotes.LOOKS_LIKE_BAMBU_BOX);
  assert.equal(formatNoteText({ code: 'SOMETHING_NEW' }, 'ckb'), SERIAL_STRINGS.ckb.formatTitle, 'an unknown code is never printed bare');
});
