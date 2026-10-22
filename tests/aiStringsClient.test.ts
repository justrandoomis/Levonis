/**
 * EVERY NEW WORD OF THE ASSISTANT AI LAYER, CLIENT HALF, THREE TIMES
 * (push B1, plan §12.2-§12.4, §16 #18; DECISIONS row 183).
 *
 * `tr()` and the dictionaries of the pages fall back to the Arabic silently,
 * so a key missing in English or Sorani would never show as an error: it
 * would show as Arabic. This walks the four client dictionaries the layer
 * added words to (the Support page, the + sheet, the support desk and the
 * owner tab) and requires, key by key: all three languages, the same
 * placeholders, an English that is not the Arabic, and a Sorani that is its
 * own Sorani (never a copy of the Arabic, written in Sorani letters).
 *
 * THE SORANI RATCHET (the tests/soraniStorefrontGaps.test.ts pattern, here so
 * this layer carries its own): no file the layer added or edited on the
 * client passes a two-language `loc()` or a `loc()` whose Sorani is the
 * Arabic.
 *
 * THE REPO RULE (plan header, I8): the client files of the layer name no
 * model family. Checked by the SHA-256 of every lowercase word against a list
 * that holds digests only; the words themselves were hashed in a scratch
 * shell and are written nowhere in the repository.
 *
 * The server half (ASSIST_T, worker/lib/assist/strings.ts) is the server
 * test of plan §16 #18.
 *
 * Run: node --import tsx --test tests/aiStringsClient.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { ROOT } from './fixtures/d1';
import { CONSOLE_STRINGS } from '../src/components/adminSupport/strings';
import { ADMIN_AI_STRINGS } from '../src/components/AdminAssistAi';

type Lang = 'ar' | 'en' | 'ckb';
const LANGS: readonly Lang[] = ['ar', 'en', 'ckb'];
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/**
 * A letter Arabic does not have: the mark of a Sorani string (tests/adminSidebarSorani.test.ts),
 * with the Sorani kaf «ک» (U+06A9, where Arabic writes «ك»).
 */
const KURDISH = /[ەۆێڕڵڤگچپژک]|ی/;
const ARABIC_LETTER = /[؀-ۿ]/;
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

/** A string the source spells out whole: `'…'`, `"…"` or a template with nothing in it. */
const literal = (n: ts.Node | undefined): string | null =>
  n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null;

/**
 * The string-valued properties of `const <name> = { ar: {…}, en: {…}, ckb: {…} }`
 * in a source file, read with the TypeScript parser (any quoting, any line
 * break). Properties that are not plain strings (a menu, a function) are skipped.
 */
function dictionary(rel: string, name: string): Record<Lang, Record<string, string>> {
  const sf = ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found: ts.ObjectLiteralExpression | undefined;
  const visit = (n: ts.Node) => {
    if (!found && ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) {
      let init: ts.Expression = n.initializer;
      while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression;
      if (ts.isObjectLiteralExpression(init)) found = init;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  assert.ok(found, `${rel}: no dictionary ${name}`);
  const out = { ar: {}, en: {}, ckb: {} } as Record<Lang, Record<string, string>>;
  for (const p of found!.properties) {
    if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name) || !(LANGS as readonly string[]).includes(p.name.text)) continue;
    let block: ts.Expression = p.initializer;
    while (ts.isAsExpression(block) || ts.isParenthesizedExpression(block)) block = block.expression;
    if (!ts.isObjectLiteralExpression(block)) continue;
    for (const q of block.properties) {
      if (!ts.isPropertyAssignment(q) || !(ts.isIdentifier(q.name) || ts.isStringLiteral(q.name))) continue;
      const value = literal(q.initializer);
      if (value !== null) out[p.name.text as Lang][q.name.text] = value;
    }
  }
  return out;
}

/** Every key in three languages, the same placeholders, en ≠ ar, ckb ≠ ar and Sorani letters in the ckb. */
function threeLanguages(where: string, dict: Record<Lang, Record<string, string>>, keys: readonly string[]): void {
  for (const key of keys) {
    const ar = dict.ar[key];
    const en = dict.en[key];
    const ckb = dict.ckb[key];
    assert.ok(ar && ar.trim() && en && en.trim() && ckb && ckb.trim(), `${where} ${key}: missing in a language`);
    assert.deepEqual(placeholders(en), placeholders(ar), `${where} ${key}: the English placeholders differ`);
    assert.deepEqual(placeholders(ckb), placeholders(ar), `${where} ${key}: the Sorani placeholders differ`);
    assert.notEqual(en, ar, `${where} ${key}: the English is the Arabic`);
    assert.notEqual(ckb, ar, `${where} ${key}: the Sorani is a copy of the Arabic`);
    assert.notEqual(ckb, en, `${where} ${key}: the Sorani is the English`);
    assert.match(ckb, KURDISH, `${where} ${key}: the Sorani has no Sorani letter`);
    assert.match(ar, ARABIC_LETTER, `${where} ${key}: the Arabic has no Arabic letter`);
    assert.doesNotMatch(en, ARABIC_LETTER, `${where} ${key}: the English carries Arabic letters`);
  }
}

/**
 * The keys of plan §12.2-§12.4 and where each lives. The two existing
 * dictionaries name their keys in camelCase, so the plan keys are written in
 * their house style there; the owner tab uses the plan keys as they are.
 */
const SUPPORT_KEYS = {
  greeting_ai: 'greetingAi',
  ai_tag: 'aiTag',
  read_photo: 'readPhoto',
  read_clip: 'readClip',
  voice_to_text: 'voiceToText',
  voice_heard: 'voiceHeard',
  voice_ckb_hint: 'voiceCkbHint',
  /** Not in the plan table: a read that failed, said by the page (never a server sentence). */
  read_failed: 'readFailed',
} as const;
const SHEET_KEYS = {
  reading_busy: 'readingBusy',
  frames_busy: 'framesBusy',
  frames_failed: 'framesFailed',
  voice_limit: 'voiceLimit',
  consent_title: 'consentTitle',
  consent_photo: 'consentPhoto',
  consent_voice: 'consentVoice',
  consent_accept: 'consentAccept',
  consent_decline: 'consentDecline',
  /** Not in the plan table: attaching a recording the one-minute cap stopped. */
  attach_recording: 'attachRecording',
  /** Not in the plan table: the link to the privacy clause of plan §12.5. */
  consent_policy: 'consentPolicy',
} as const;
const CONSOLE_KEYS = {
  handoff_read_by_ai: 'readByAi',
  field_code: 'fieldCode',
  field_symptom: 'fieldSymptom',
  field_printer: 'fieldPrinter',
  field_part: 'fieldPart',
} as const;
/** Plan §12.4, every key (the pairs of the table as their own keys). */
const ADMIN_PLAN_KEYS = [
  'tab', 'enabled', 'off_note', 'cap', 'spent', 'cap_reached', 'guests', 'guest_share', 'understand_ckb',
  'task_understand', 'task_vision', 'task_speech', 'primary', 'fallback', 'no_model', 'pick_model',
  'list_unavailable', 'list_manual', 'model_gone', 'rate_in', 'rate_out', 'rate_cache_write', 'rate_cache_read',
  'rate_minute', 'rates_note', 'worst_case_warn', 'save', 'remove', 'test', 'test_ok', 'test_fail', 'test_record',
  'key_set', 'key_missing', 'binding_ok', 'binding_missing', 'images_ok', 'images_missing', 'circuit', 'failures',
  'diagnose_note',
] as const;

test('the Support page says every new sentence in Arabic, English and real Sorani', () => {
  const dict = dictionary('src/pages/Support.tsx', 'STRINGS');
  threeLanguages('Support.tsx', dict, Object.values(SUPPORT_KEYS));
  // The page dictionary keeps one key set across its three languages.
  assert.deepEqual(Object.keys(dict.en).sort(), Object.keys(dict.ar).sort());
  assert.deepEqual(Object.keys(dict.ckb).sort(), Object.keys(dict.ar).sort());
  // The basic greeting stays the push A greeting: the AI one replaces it only in AI mode.
  assert.match(dict.ar.greeting, /بدون ذكاء اصطناعي/);
  assert.match(dict.ar.greetingAi, /الذكاء الاصطناعي/);
});

test('the + sheet (with the consent sheet) says every new sentence in three languages, one key set', () => {
  const dict = dictionary('src/components/support/AssistAttach.tsx', 'COPY');
  threeLanguages('AssistAttach.tsx', dict, Object.values(SHEET_KEYS));
  assert.deepEqual(Object.keys(dict.en).sort(), Object.keys(dict.ar).sort(), 'the + sheet: English keys differ');
  assert.deepEqual(Object.keys(dict.ckb).sort(), Object.keys(dict.ar).sort(), 'the + sheet: Sorani keys differ');
  // The consent names the company, in every language.
  for (const lang of LANGS) {
    assert.deepEqual(placeholders(dict[lang].consentPhoto), ['provider']);
    assert.deepEqual(placeholders(dict[lang].consentVoice), ['provider']);
  }
});

test('the desk names a reading in three languages', () => {
  threeLanguages('CONSOLE_STRINGS', CONSOLE_STRINGS as unknown as Record<Lang, Record<string, string>>, Object.values(CONSOLE_KEYS));
  for (const lang of LANGS) assert.deepEqual(placeholders(CONSOLE_STRINGS[lang].readByAi), ['fields']);
});

test('the owner tab: identical key sets, every plan key, three languages for every word', () => {
  const keys = Object.keys(ADMIN_AI_STRINGS.ar);
  assert.deepEqual(Object.keys(ADMIN_AI_STRINGS.en).sort(), [...keys].sort());
  assert.deepEqual(Object.keys(ADMIN_AI_STRINGS.ckb).sort(), [...keys].sort());
  for (const key of ADMIN_PLAN_KEYS) assert.ok(keys.includes(key), `plan §12.4 key ${key} is missing`);
  // Words that are the same in every language by nature (a product name inside a sentence) still differ around it.
  threeLanguages('ADMIN_AI_STRINGS', ADMIN_AI_STRINGS, keys);
  for (const [key, vars] of [['spent', ['cap', 'spent']], ['worst_case_warn', ['cost']], ['test_ok', ['ms']], ['test_fail', ['code']], ['circuit', ['time']]] as const) {
    for (const lang of LANGS) assert.deepEqual(placeholders(ADMIN_AI_STRINGS[lang][key]), [...vars].sort(), `${lang} ${key}`);
  }
  // The day is a UTC day, said in every language (plan §10).
  for (const lang of LANGS) assert.match(ADMIN_AI_STRINGS[lang].cap, /00:00 UTC/);
});

test('every plan key of §12.2 and §12.3 has its client home', () => {
  const support = dictionary('src/pages/Support.tsx', 'STRINGS').ar;
  const sheet = dictionary('src/components/support/AssistAttach.tsx', 'COPY').ar;
  for (const [plan, key] of Object.entries(SUPPORT_KEYS)) assert.ok(support[key], `${plan} → Support.tsx ${key}`);
  for (const [plan, key] of Object.entries(SHEET_KEYS)) assert.ok(sheet[key], `${plan} → AssistAttach.tsx ${key}`);
  for (const [plan, key] of Object.entries(CONSOLE_KEYS)) assert.ok((CONSOLE_STRINGS.ar as unknown as Record<string, string>)[key], `${plan} → CONSOLE_STRINGS ${key}`);
});

// ----------------------------------------------------------- the ratchet

/** The client files the layer added or edited. */
const LAYER_FILES = [
  'src/lib/assistAi.ts',
  'src/lib/assistMedia.ts',
  'src/components/AdminAssistAi.tsx',
  'src/components/support/AssistAttach.tsx',
  'src/pages/Support.tsx',
  'src/pages/Admin.tsx',
  'src/components/adminSupport/TicketsDesk.tsx',
  'src/components/adminSupport/strings.ts',
  'src/lib/voiceRecorder.ts',
];

/** `loc(…)` calls with fewer than three languages, or whose Sorani is the Arabic letter for letter. */
function badLoc(rel: string): string[] {
  const sf = ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'loc') {
      const ar = literal(n.arguments[0]);
      if (n.arguments.length < 3 || (ar !== null && ar === literal(n.arguments[2]))) {
        out.push(`${rel}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} ${n.getText().slice(0, 80)}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

test('the Sorani ratchet: no file of the layer passes two languages or the Arabic as Sorani', () => {
  assert.deepEqual(LAYER_FILES.flatMap(badLoc), []);
  // The owner tab sidebar entry is a three-language loc with its own Sorani.
  assert.ok(read('src/pages/Admin.tsx').includes("loc('الذكاء الاصطناعي للمساعد', 'Assistant AI', 'زیرەکی دەستکردی یاریدەدەر')"));
});

test('the files the layer wrote whole carry no apostrophe in an English comment (scripts/clay-census.mjs reads raw source)', () => {
  const commentOf = (line: string) => (/^\s*(?:\/\/|\*|\/\*)/.test(line) ? line : (/\s\/\/\s.*$/.exec(line)?.[0] ?? ''));
  const bad: string[] = [];
  for (const file of ['src/lib/assistAi.ts', 'src/lib/assistMedia.ts', 'src/components/AdminAssistAi.tsx', 'src/components/support/AssistAttach.tsx']) {
    read(file)
      .split('\n')
      .forEach((line, i) => {
        if (/[A-Za-z]['’][A-Za-z]/.test(commentOf(line))) bad.push(`${file}:${i + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(bad, []);
});

// --------------------------------------------------------- the repo rule

/**
 * SHA-256 of lowercase model-family words (the lines of the providers, the
 * speech family of Workers AI, other vendors), hashed outside the repository.
 * Digests only, by design: the words are written nowhere here.
 */
const FAMILY_DIGESTS = new Set([
  '053ea4804ef1bb33d4a3d6fb024a614b6d257cebc2bc7cd915da9c9522f37ffc', '194cbf5c4433b278166f7eca3fbab6c639a862ea7dcb10250fdb7dc2c129693a',
  '2f64000c252b33ed2f09a6b0bad35201cc85d8e043aa58389f89a7141a891bfb', '3fb22a5597fb91ee4f9abbf30ea69d318be150e0fcf3ca1db8ca334b520d2894',
  '5a5110ebe1544b31e6d4207a419bc1deb148735f89ae984ff0a2ab809b51f1df', '5d72436256ada53828b51895a94bb8489e9f1ac4fe937a8024ef1594e7045ff6',
  '5d7269a515e497bd4e14a9cbbf1ffcfbf24a6cfaf4500b9ef5a6d40e870f1a88', '60965168ce762e949600281ba6d01fee136e5b6e8257b1f216f9025ed324474c',
  '67f2d22514622d1be30c14ee9f3cb104503a159a33a656ca91a1953aa9616429', '6f7ac1823da81d2e52d1a1549ee69c85bbf8bb56d06682849e7c09da2785ce3b',
  '751a16d8cb41ea83c7b7c76d8deaa859cb1d10760163b5f184be6a79ed913c85', '89d5a3256f5af0afb14219db371dcdbd1183376727ad83ca71e39192cf0f681a',
  '9058f79c893a1d7e20b13009b95b9cf3211478a91a47e2ad65bdfedad6fc98f4', '920510199770f4d65cb8aaa2cd12bdb2b8c37f5b3907c50a734a0e3409da2823',
  '9f644d8d7216f73baab3fbfb4106af4e67f4a2ef760fa4c8e8072d78e19bb213', 'a84571394b5e99fe70aae39ece25f844acbaf83479e27f39a30732e092b19677',
  'add92b9cde2bdbf3daaf65a0db79e9b1a7fa428b71b4d6ce38c742eb6dca0c1c', 'b46573f3283d5eb9274cb9a227e37a9a00a4b04b73e40700901c1160346cdd96',
  'ba7955598f2007bc8cee7329ece0f63ee59f2dbb40d59ad17aadfee76b1092ae', 'c857d09db23e6822e3600bc06ad8d58f92ed62bc8efd81c753f77048662cb97d',
  'c97504235ab15009f6c5f11ba890007a5f3fdd20c9e57b53ea74855033572ddf', 'c9ad8f2cc1294afa0ef22fc2c019ff7243cdd272b2147ddca3f34c5036b05768',
  'cd3ebf2708df4d4c6cdb3d90e5e7456c6bc080c03e8cd4573a31671d15adff94', 'e12ce8285efc67c6d93d3a122e2589ed95089bcbb775ba5634d94e2b8385db07',
  'e12fe631288e303b91d2fc33e97fed2c4c08234d384ed19a5b3e9c79fc3ac49d', 'f4a92fb5a4addcfc2a82d033dec357b0a6ea4f687d9bf492024355f70713ca07',
  'fc5a1047f5919892fcdf8aa79ea5d6bb6531b5c176939ef0110906cb225941c1',
]);

/**
 * The client files this scan covers: every file the layer added, and every
 * file it edited except src/lib/voiceRecorder.ts, whose header names the audio
 * codec of a recording (a harmless word the plan leaves untouched).
 */
const SCANNED = [
  'src/lib/assistAi.ts',
  'src/lib/assistMedia.ts',
  'src/components/AdminAssistAi.tsx',
  'src/components/support/AssistAttach.tsx',
  'src/pages/Support.tsx',
  'src/pages/Admin.tsx',
  'src/components/adminSupport/TicketsDesk.tsx',
  'src/components/adminSupport/strings.ts',
  'tests/aiStringsClient.test.ts',
  'tests/assistMediaHelpers.test.ts',
  'tests/assistAiClient.test.ts',
];

test('the client files of the layer name no model family and no Workers AI model path', () => {
  assert.equal(FAMILY_DIGESTS.size, 27);
  const hex = (w: string) => createHash('sha256').update(w).digest('hex');
  const hits: string[] = [];
  for (const file of SCANNED) {
    const src = read(file);
    const words = new Set(src.toLowerCase().match(/[a-z0-9]+/g) ?? []);
    for (const w of words) if (FAMILY_DIGESTS.has(hex(w))) hits.push(`${file}: a family word (digest ${hex(w).slice(0, 12)}…)`);
    if (/@(?:cf|hf)\//.test(src)) hits.push(`${file}: a Workers AI model path`);
  }
  assert.deepEqual(hits, []);
});
