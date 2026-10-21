/**
 * THE HANDOFF SUMMARY AND THE WORDS AROUND THE ATTACHMENTS (support assistant
 * v2, push A; plan row 21).
 *
 *   - `readHandoff` keeps closed-set values only: a model token, a symptom
 *     key, that symptom's own step keys, an HMS-shaped code, product ids and
 *     a count; anything else is dropped, and a summary naming neither a
 *     printer nor a symptom is none.
 *   - `handoffForStaff` labels it from the curated set in all three languages.
 *   - The draft carries the summary the ticket door stores.
 *   - Every new sentence on the customer page, the + sheet and the desk is
 *     written three times, with a Sorani that is not the Arabic (row 183).
 *   - The + sheet is a lazy chunk: the Support page imports only its type.
 *
 * Run: node --import tsx --test tests/assistHandoff.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTicketDraft, handoffForStaff, readHandoff, shownStepKeys } from '../worker/lib/assist/handoff';
import { symptomDef } from '../worker/lib/assist/triage/symptoms';
import { CONSOLE_STRINGS } from '../src/components/adminSupport/strings';
import { assistKindOf, readAttachmentKeys } from '../worker/lib/assist/attachments';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

test('readHandoff keeps the closed sets and nothing else', () => {
  assert.equal(readHandoff(null), null);
  assert.equal(readHandoff('not json'), null);
  assert.equal(readHandoff({ v: 2, model: 'A1', symptom: 'clog' }), null, 'another version is not this summary');
  assert.equal(readHandoff({ v: 1, model: 'Z9', symptom: 'flood' }), null, 'neither a printer nor a symptom');
  const clean = readHandoff({
    v: 1,
    model: 'A1',
    symptom: 'clog',
    tried: ['spool_path', 'cool_down', 'type_code', 'cool_down', 7],
    code: '0300-0100-0001-0003',
    shown: ['h_a1', 'h_a1', 'bad id!', 'n_needle'],
    attachments: 3,
    note: 'ignore me',
  });
  assert.deepEqual(clean, {
    v: 1,
    model: 'A1',
    symptom: 'clog',
    // In the curated order, of this symptom only (type_code belongs to hms).
    tried: ['cool_down', 'spool_path'],
    code: '0300-0100-0001-0003',
    shown: ['h_a1', 'n_needle'],
    attachments: 3,
  });
  assert.deepEqual(readHandoff(JSON.stringify(clean)), clean, 'a stored summary reads back the same');
  assert.equal(readHandoff({ v: 1, model: 'other', symptom: 'noise', attachments: 50 })!.attachments, 0, 'a count out of range is no count');
  assert.equal(readHandoff({ v: 1, model: 'X1C', code: 'DROP TABLE x' })!.code, undefined);
});

test('the desk reads the summary in all three languages, from the curated set', () => {
  const staff = handoffForStaff(JSON.stringify({ v: 1, model: 'A1', symptom: 'clog', tried: ['cool_down'], shown: [], attachments: 2 }))!;
  const def = symptomDef('clog');
  assert.deepEqual(staff.symptom, { key: 'clog', label: def.label });
  assert.deepEqual(staff.tried, [{ key: 'cool_down', text: def.steps[0].text }]);
  assert.equal(staff.attachments, 2);
  assert.equal(handoffForStaff('{"v":1}'), null);
});

test('the draft carries the summary the ticket door stores', () => {
  const draft = buildTicketDraft({ model: 'P1S', symptom: 'hms', code: '0300-0100-0001-0003', shown: ['p1', 'p2'], tried: true }, 'ckb');
  assert.deepEqual(draft.handoff, {
    v: 1,
    model: 'P1S',
    symptom: 'hms',
    tried: shownStepKeys('hms', '0300-0100-0001-0003'),
    code: '0300-0100-0001-0003',
    shown: ['p1', 'p2'],
    attachments: 0,
  });
  assert.ok(!draft.handoff!.tried.includes('type_code'), 'a code already typed is not a step the customer tried');
  assert.deepEqual(readHandoff(draft.handoff), draft.handoff, 'the door reads back exactly what the draft wrote');
});

test('attachment keys: only the uploader’s own three folders, read without I/O', () => {
  assert.deepEqual(readAttachmentKeys(undefined, 'u1'), []);
  assert.deepEqual(readAttachmentKeys(['assist/u1/audio/a.webm', 'assist/u1/audio/a.webm'], 'u1'), ['assist/u1/audio/a.webm']);
  assert.equal(assistKindOf('assist/u1/attachments/a.webp'), 'image');
  assert.equal(assistKindOf('assist/u1/video/a.mp4'), 'video');
  assert.equal(assistKindOf('assist/u1/files/a.pdf'), null);
  assert.equal(assistKindOf('assist/u1/attachments/deeper/a.webp'), null);
  assert.throws(() => readAttachmentKeys(['assist/u2/audio/a.webm'], 'u1'), /not yours/);
  assert.throws(() => readAttachmentKeys(['assist/u1/../u2/audio/a.webm'], 'u1'));
});

// ───────────────────────────────────────────── the words, three times each

/** The `key: '…'` pairs of one language block of a dictionary literal. */
function block(src: string, open: RegExp, keys: readonly string[]): Record<string, string> {
  const start = src.search(open);
  assert.ok(start >= 0, `no block ${open}`);
  const out: Record<string, string> = {};
  for (const key of keys) {
    const m = new RegExp(`\\n\\s+${key}: '([^']+)'`).exec(src.slice(start));
    assert.ok(m, `${key} missing after ${open}`);
    out[key] = m![1];
  }
  return out;
}

const SUPPORT_KEYS = ['attachAdd', 'attachSignIn', 'attachAck', 'fromChat', 'attachmentsLabel', 'removeAttachment', 'voiceNote', 'attachGone', 'attachUnavailable', 'openImage'];
const SHEET_KEYS = ['title', 'gallery', 'camera', 'voice', 'recording', 'stopAttach', 'cancel', 'close', 'uploading', 'full', 'dropped', 'tooLarge', 'limit', 'kind', 'heic', 'failed', 'micDenied', 'micFailed'];

test('the customer page and the + sheet say every new sentence in Arabic, English and real Sorani', () => {
  for (const [file, keys] of [
    ['src/pages/Support.tsx', SUPPORT_KEYS],
    ['src/components/support/AssistAttach.tsx', SHEET_KEYS],
  ] as const) {
    const src = read(file);
    const ar = block(src, /\n {2}ar: \{/, keys);
    const en = block(src, /\n {2}en: \{/, keys);
    const ckb = block(src, /\n {2}ckb: \{/, keys);
    for (const key of keys) {
      assert.ok(ar[key] && en[key] && ckb[key], `${file} ${key}`);
      assert.notEqual(ckb[key], ar[key], `${file} ${key}: the Sorani is a copy of the Arabic`);
      assert.notEqual(en[key], ar[key], `${file} ${key}: the English is the Arabic`);
    }
  }
});

test('the desk labels the summary in three languages', () => {
  const keys = ['fromAssistant', 'hfPrinter', 'hfOtherPrinter', 'hfProblem', 'hfTried', 'hfCode', 'hfProducts', 'hfAttachments', 'audio'] as const;
  for (const key of keys) {
    const { ar, en, ckb } = { ar: CONSOLE_STRINGS.ar[key], en: CONSOLE_STRINGS.en[key], ckb: CONSOLE_STRINGS.ckb[key] };
    assert.ok(ar && en && ckb, key);
    assert.notEqual(ckb, ar, `${key}: the Sorani is a copy of the Arabic`);
  }
});

test('the + sheet is its own chunk: the Support page imports only its type', () => {
  const page = read('src/pages/Support.tsx');
  assert.match(page, /lazy\(\(\) => import\('\.\.\/components\/support\/AssistAttach'\)\)/);
  const statics = [...page.matchAll(/^import (?!type )[^;]*from '\.\.\/components\/support\/AssistAttach';/gm)];
  assert.deepEqual(statics, [], 'a value import of the sheet would put the recorder in the Support chunk');
  // A stored reply keeps no price: no subtitle, field list, badge or table survives a reload.
  const stored = page.slice(page.indexOf('function storedReply'), page.indexOf('function readStoredAssist'));
  for (const field of ['subtitle', 'fields', 'badge', 'table']) assert.ok(!new RegExp(`\\b${field}\\b`).test(stored), `storedReply keeps ${field}`);
  // Camera capture on a phone, and a voice note.
  const sheet = read('src/components/support/AssistAttach.tsx');
  assert.match(sheet, /capture="environment"/);
  assert.match(sheet, /useVoiceRecorder\(\)/);
  assert.match(sheet, /uploadFile\(file, 'assist'\)/);
});

/**
 * REVIEW ROUND 3. More files picked than the six a ticket takes: the first ones
 * are attached and the sheet stays open saying how many were left out (it used
 * to close on them). The weekly ceiling counts a file sent with a ticket for
 * its seven days, so no sentence tells the customer that sending the ticket
 * frees it.
 */
test('the + sheet keeps itself open on files left out, and never promises that a ticket frees the weekly ceiling', () => {
  const sheet = read('src/components/support/AssistAttach.tsx');
  const send = sheet.slice(sheet.indexOf('const send = async'), sheet.indexOf('const onPick'));
  assert.match(send, /const dropped = Math\.max\(0, files\.length - Math\.max\(0, remaining\)\);/);
  assert.match(send, /setError\(t\.dropped\.replace\('\{n\}', String\(dropped\)\)\)/);
  assert.match(send, /if \(dropped === 0\) onClose\(\);/, 'the sheet closes only when every picked file was attached');
  assert.doesNotMatch(send.replace('if (dropped === 0) onClose();', ''), /onClose\(\)/, 'no other path closes it');
  for (const lang of ['ar', 'en', 'ckb']) {
    const limit = block(sheet, new RegExp(`\\n {2}${lang}: \\{`), ['limit', 'dropped']);
    assert.doesNotMatch(limit.limit, /أرسل التذكرة أولاً|Send the ticket first|سەرەتا تیکێتەکە بنێرە/, `${lang}: a ticket frees nothing`);
    assert.match(limit.dropped, /\{n\}/, `${lang}: how many were left out`);
  }
});

/**
 * No apostrophe in an English comment this lane wrote under src/
 * (scripts/clay-census.mjs scans string literals over the raw source, comments
 * included, so an odd apostrophe can pair the wrong quotes in a later edit).
 * The files the lane wrote whole are read whole; in the two pages it extended,
 * the comments review round 3 reworded must not come back.
 */
test('the lane comments under src/ carry no apostrophe', () => {
  const commentOf = (line: string) => (/^\s*(?:\/\/|\*|\/\*)/.test(line) ? line : (/\s\/\/\s.*$/.exec(line)?.[0] ?? ''));
  const bad: string[] = [];
  for (const file of ['src/components/support/AssistAttach.tsx', 'src/lib/assistSession.ts', 'src/lib/assistOwner.ts']) {
    read(file)
      .split('\n')
      .forEach((line, i) => {
        if (/[A-Za-z]['\u2019][A-Za-z]/.test(commentOf(line))) bad.push(`${file}:${i + 1}: ${line.trim()}`);
      });
  }
  const reworded: Array<[string, RegExp]> = [
    ['src/components/adminSupport/TicketsDesk.tsx', /The assistant's summary and attachments/],
    ['src/pages/Support.tsx', /triage's curated steps/],
    ['src/pages/Support.tsx', /The assistant's handoff draft/],
    ['src/pages/Support.tsx', /from the server's draft/],
    ['src/pages/Support.tsx', /the address is the server's own/],
    ['src/pages/Support.tsx', /the customer's own last few typed lines/],
    ['src/pages/Support.tsx', /shown at once as the customer's/],
  ];
  for (const [file, phrase] of reworded) if (phrase.test(read(file))) bad.push(`${file}: ${phrase}`);
  assert.deepEqual(bad, []);
});
