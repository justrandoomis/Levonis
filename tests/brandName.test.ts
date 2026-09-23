import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT } from './fixtures/d1';
import { dbThrough, row } from './fixtures/app';
import { DEFAULT_WARRANTY_CONFIG } from '../worker/lib/warrantyConfig';
import { renderSignInCodeEmail } from '../worker/lib/emailTemplates';
import { verifyEmail } from '../services/notifications/src/templates';

/**
 * «أريد اسم Levonis بالإنجليزي فقط» — ONE NAME, IN LATIN LETTERS, EVERYWHERE.
 *
 * The policy corpus already read «Levonis» (tests/policyCorpus.test.ts pins
 * it). Everything else still spelled the store in Arabic script: «ليفونيس» in
 * the sign-in email, the manifest, the warranty receipt and the support
 * assistant, and a Sorani transliteration spelled three different ways
 * («لیڤۆنیس», «لێڤۆنیس», «ليڤۆنیس» — the second letter is ی, ێ or ي
 * depending on who typed it) plus one misspelling («ليفونس»). The owner's
 * answer closes docs/DECISIONS.md row 99, and this file is what keeps it
 * closed.
 */

/** Every Arabic-script spelling of the brand this repository has carried. */
const TRANSLITERATED = /ليفونيس|ليفونس|لیڤۆنیس|لێڤۆنیس|ليڤۆنیس|ليڤونيس|لیفونیس/;

const SCANNED_DIRS = ['src', 'worker', 'services'];
const SCANNED_FILES = ['index.html'];

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sourceFiles(path);
    else if (/\.(ts|tsx|html)$/.test(name)) yield path;
  }
}

/**
 * A comment may QUOTE the old spelling — the history of why a line changed is
 * worth keeping, and nobody reads a comment on a receipt. A string is what a
 * customer reads, so every non-comment line is scanned.
 */
function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*') || t.startsWith('<!--');
}

test('no customer-visible string spells the store in Arabic script', () => {
  const offenders: string[] = [];
  const files = [
    ...SCANNED_DIRS.flatMap((d) => [...sourceFiles(join(ROOT, d))]),
    ...SCANNED_FILES.map((f) => join(ROOT, f)),
  ];
  assert.ok(files.length > 100, 'the scan found almost nothing to scan — the paths are wrong');
  for (const file of files) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (!isComment(line) && TRANSLITERATED.test(line)) offenders.push(`${relative(ROOT, file)}:${i + 1}`);
      });
  }
  assert.deepEqual(offenders, [], 'the store is «Levonis» in every language');
});

test('the warranty receipt default names «ضمان Levonis»', () => {
  assert.equal(DEFAULT_WARRANTY_CONFIG.type_ar, 'ضمان Levonis');
  assert.ok(DEFAULT_WARRANTY_CONFIG.terms.some((t) => t.ar.startsWith('لـ Levonis أن تفحص')));
});

/**
 * A plain-text channel has no page around the sentence to steady a Latin
 * word in the middle of Arabic, so there the name travels ISOLATED —
 * U+2068 FIRST STRONG ISOLATE … U+2069 POP DIRECTIONAL ISOLATE — and the
 * sentence around it keeps reading right to left in any mail client.
 */
test('in a plain-text email the name is bidi-isolated mid-sentence', () => {
  const ISOLATED = '⁨Levonis⁩';
  for (const lang of ['ar', 'ckb'] as const) {
    const mail = renderSignInCodeEmail(lang, '123456');
    assert.ok(mail.text.includes(ISOLATED), `${lang}: the sign-in email text does not isolate the name`);
    assert.ok(!TRANSLITERATED.test(mail.text) && !TRANSLITERATED.test(mail.html), `${lang}: transliterated`);
  }
  // English needs no isolation: the sentence is already left to right.
  assert.ok(!renderSignInCodeEmail('en', '123456').text.includes('⁨'));

  const welcome = verifyEmail('a@example.com', 'https://levonis-iq.com/v', 'ar');
  assert.ok(welcome.text.includes(`مرحبًا بك في ${ISOLATED}`));
});

// =========================================================================
// MIGRATION 0113 — THE WARRANTY WORDING THE OWNER ALREADY SAVED
// =========================================================================

/** The admin's saved copy as it looked before: every default, old spelling. */
function savedConfig(version: number) {
  return JSON.stringify({
    ...DEFAULT_WARRANTY_CONFIG,
    type_ar: 'ضمان ليفونيس',
    coverage_ar: 'نص كتبه المالك بنفسه ولا يُمس.',
    terms: [
      { ar: 'لليفونيس أن تفحص الجهاز وتُشخّصه قبل الموافقة على الإصلاح أو الاستبدال.', en: 'Levonis may inspect.' },
      { ar: 'شرط كتبه المالك.', en: 'An owner term.' },
    ],
    version,
  });
}

const MIGRATION = readFileSync(join(ROOT, 'migrations/0113_warranty_config_brand_latin.sql'), 'utf8');

test('0113 rewrites the brand inside the saved warranty wording, and only the brand', () => {
  const raw = dbThrough('0112');
  raw.prepare(`INSERT INTO admin_settings (key, value) VALUES ('warrantyConfig', ?)`).run(savedConfig(3));
  // Another setting that happens to carry the old spelling is not this
  // migration's business.
  raw.prepare(`INSERT INTO admin_settings (key, value) VALUES ('someOtherSetting', ?)`).run('"متجر ليفونيس"');

  raw.exec(MIGRATION);

  const stored = JSON.parse(row<{ value: string }>(raw, `SELECT value FROM admin_settings WHERE key = 'warrantyConfig'`)!.value);
  assert.equal(stored.type_ar, 'ضمان Levonis');
  assert.equal(stored.terms[0].ar, 'لـ Levonis أن تفحص الجهاز وتُشخّصه قبل الموافقة على الإصلاح أو الاستبدال.');
  assert.equal(stored.terms[1].ar, 'شرط كتبه المالك.');
  assert.equal(stored.coverage_ar, 'نص كتبه المالك بنفسه ولا يُمس.');
  assert.equal(stored.retailer.name, DEFAULT_WARRANTY_CONFIG.retailer.name);
  assert.equal(stored.version, 4, 'the wording changed, so the version a receipt snapshots moves');
  assert.equal(
    row<{ value: string }>(raw, `SELECT value FROM admin_settings WHERE key = 'someOtherSetting'`)!.value,
    '"متجر ليفونيس"'
  );

  // IDEMPOTENT: a second run finds nothing to rewrite and bumps nothing.
  raw.exec(MIGRATION);
  const again = JSON.parse(row<{ value: string }>(raw, `SELECT value FROM admin_settings WHERE key = 'warrantyConfig'`)!.value);
  assert.deepEqual(again, stored);
});

test('0113 is a no-op on a database with no saved warranty wording, and on one already in Latin', () => {
  const raw = dbThrough('0112');
  raw.exec(MIGRATION);
  assert.equal(row(raw, `SELECT value FROM admin_settings WHERE key = 'warrantyConfig'`), undefined);

  const latin = JSON.stringify({ ...DEFAULT_WARRANTY_CONFIG, version: 7 });
  raw.prepare(`INSERT INTO admin_settings (key, value) VALUES ('warrantyConfig', ?)`).run(latin);
  raw.exec(MIGRATION);
  assert.equal(row<{ value: string }>(raw, `SELECT value FROM admin_settings WHERE key = 'warrantyConfig'`)!.value, latin);
});
