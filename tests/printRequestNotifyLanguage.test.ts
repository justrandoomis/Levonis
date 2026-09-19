/**
 * THE MATCH NOTIFICATION MUST BE IN THE LANGUAGE ITS READER IS USING.
 *
 * THE BUG THESE TESTS PIN DOWN. `worker/routes/printRequests.ts` used to set
 * both language slots from one variable:
 *
 *     const title = String(request.title ?? '');
 *     …
 *     body_ar: title,
 *     body_en: title,      ← the SAME variable in both slots
 *
 * The customer writes that title in Arabic. Copied verbatim into `body_en`, it
 * reached every merchant reading the site in English or Kurdish as an Arabic
 * sentence inside an otherwise English notification — and
 * migrations/0045_print_requests.sql states the promise it broke in its own
 * words: the text is stored per language so a notification read six months
 * later "must still be in the language the reader is using NOW".
 *
 * WHAT IS ASSERTED, and why each one is not a formality:
 *
 *   1. NO ARABIC SCRIPT SURVIVES INTO AN `_en` FIELD for a request whose title
 *      is Arabic. This is the defect itself, stated as an invariant over the
 *      Unicode range rather than over one known string, so a future field that
 *      leaks an Arabic value fails here too instead of shipping.
 *   2. THE BODY NAMES THE REAL FIELDS. A body that is merely free of Arabic is
 *      satisfied by an empty string; these check the material, the process, the
 *      quality, the quantity, the size, the governorate, the deadline and the
 *      budget actually arrive, in the reader's own language.
 *   3. THE CUSTOMER'S SENTENCE IS QUOTED, NOT TRANSLATED. It appears only in
 *      the slots whose script it is, behind a marker that says whose words they
 *      are — a quotation is true, a silent translation is not.
 *   4. THE TWO SLOTS ARE NEVER THE SAME STRING. The original defect was two
 *      identical values, so identity is checked directly: an Arabic-only body
 *      that happened to be free of the English words would still be caught.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { printMatchNotification, type PrintMatchFacts } from '../worker/routes/printRequests';

/**
 * The Arabic script blocks — Arabic, Arabic Supplement, Arabic Extended-A and
 * the two presentation-form ranges a paste from Word brings with it.
 *
 * SCRIPT, NOT LANGUAGE. Sorani Kurdish is written in the same blocks, so this
 * cannot say "Arabic" and does not claim to. It is exactly the right tool for
 * the one question these tests ask — whether Arabic-script text reached a slot
 * that is supposed to hold Latin.
 */
const ARABIC_SCRIPT = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

/** A realistic published request: an Arabic title and a full set of structured
 *  fields, which is the case the defect actually shipped on. */
const arabicRequest = (over: Partial<PrintMatchFacts> = {}): PrintMatchFacts => ({
  title: 'أريد طباعة غطاء لجهاز قياس الضغط بلون أسود ومتين',
  process: 'fdm',
  quality: 'fine',
  quantity: 4,
  material: { name_ar: 'بولي لاكتيك', name_en: 'PLA' },
  material_id: 'pla',
  color_hex: '#1a1a1a',
  dimensions: '120×80×40 mm',
  governorate: 'baghdad',
  deadline: '2026-10-01',
  budget_iqd: 75000,
  ...over,
});

test('an Arabic title never reaches an _en field', () => {
  const { title, body } = printMatchNotification(arabicRequest());

  assert.ok(
    !ARABIC_SCRIPT.test(body.en),
    `body_en carries Arabic script: ${JSON.stringify(body.en)}`
  );
  assert.ok(
    !ARABIC_SCRIPT.test(title.en),
    `title_en carries Arabic script: ${JSON.stringify(title.en)}`
  );

  // The original defect was literally one variable in two slots. Identity is
  // therefore worth asserting on its own: it fails even for a body that is
  // Arabic-free by accident rather than by construction.
  assert.notEqual(body.ar, body.en);
  assert.notEqual(title.ar, title.en);
});

test('every structured field the merchant decides on is named, in each language', () => {
  const { body } = printMatchNotification(arabicRequest());

  // English: the material, the process, the quality word the customer pressed,
  // the count, the measured size, the colour, the governorate, the deadline and
  // the budget.
  for (const needle of ['PLA', 'FDM', 'Fine', '4 pcs', '120×80×40 mm', '#1a1a1a', 'Baghdad', 'due 2026-10-01', 'budget 75,000 IQD']) {
    assert.ok(body.en.includes(needle), `body_en is missing ${needle}: ${JSON.stringify(body.en)}`);
  }

  // Arabic: the same facts, said in Arabic rather than transliterated.
  for (const needle of ['بولي لاكتيك', 'دقيقة', 'العدد 4', 'بغداد', 'موعد التسليم 2026-10-01', 'الميزانية 75,000 د.ع']) {
    assert.ok(body.ar.includes(needle), `body_ar is missing ${needle}: ${JSON.stringify(body.ar)}`);
  }

  // Kurdish: composed in Sorani, not silently handed the Arabic.
  for (const needle of ['ورد', '4 دانە', 'بەغدا', 'گەیاندن 2026-10-01', 'بودجە 75,000 دینار']) {
    assert.ok(body.ckb.includes(needle), `body_ckb is missing ${needle}: ${JSON.stringify(body.ckb)}`);
  }
  assert.notEqual(body.ckb, body.ar);
});

test("the customer's Arabic words are quoted as theirs, and only where the script fits", () => {
  const facts = arabicRequest();
  const { body } = printMatchNotification(facts);

  assert.ok(body.ar.includes('بكلمات العميل'), 'the Arabic body does not mark the quotation');
  assert.ok(body.ar.includes(facts.title), 'the Arabic body dropped the customer sentence entirely');
  assert.ok(body.ckb.includes('بە وشەکانی کڕیار'), 'the Kurdish body does not mark the quotation');

  // And not in English at all — the point of the fix.
  assert.ok(!body.en.includes(facts.title));
  assert.ok(!body.en.includes('customer'), 'nothing about the customer sentence belongs in body_en here');
});

test('a Latin title is quoted in English and kept out of the Arabic slot', () => {
  const facts = arabicRequest({ title: 'Replacement bracket for a drone arm' });
  const { body } = printMatchNotification(facts);

  assert.ok(body.en.includes("In the customer's words"));
  assert.ok(body.en.includes(facts.title));
  // The mirror of the same bug: English prose in an Arabic body is no better.
  assert.ok(!body.ar.includes(facts.title));
  assert.ok(!body.ckb.includes(facts.title));
});

test('a long title is cut rather than filling the notification', () => {
  const facts = arabicRequest({ title: 'ا'.repeat(400) });
  const { body } = printMatchNotification(facts);
  assert.ok(body.ar.includes('…'), 'a 400-character title was not truncated');
  assert.ok(body.ar.length < 260, `body_ar is ${body.ar.length} characters long`);
});

/**
 * The guards that keep the invariant true when the DATA misbehaves rather than
 * the code. Each of these is a real path by which Arabic could re-enter an
 * `_en` slot without anybody editing the composer.
 */
test('Arabic that arrives through the data cannot reach an _en field', () => {
  // `printMaterials` is an admin-edited setting: the owner can type Arabic into
  // name_en from the settings screen and reopen the bug with no code change.
  const badCatalogue = printMatchNotification(
    arabicRequest({ material: { name_ar: 'بولي لاكتيك', name_en: 'بي إل إيه' } })
  );
  assert.ok(!ARABIC_SCRIPT.test(badCatalogue.body.en), badCatalogue.body.en);
  assert.ok(badCatalogue.body.en.includes('pla'), 'the material id should stand in for an unusable name_en');

  // …and so is the FALLBACK. `material_id` is sixty characters of free text off
  // the publish body, never matched against the catalogue, so an off-catalogue
  // id typed in Arabic reaches the composer with `material` null. Checking the
  // value but not the fallback left the original defect a door of its own.
  const badId = printMatchNotification(
    arabicRequest({ material: null, material_id: 'بي إل إيه' })
  );
  assert.ok(!ARABIC_SCRIPT.test(badId.body.en), badId.body.en);
  assert.ok(badId.body.en.includes('FDM'), 'the rest of the body still composes');

  // `governorateName` echoes an unknown id back, so a legacy free-text
  // governorate would otherwise print an Arabic place name into body_en.
  const freeTextGov = printMatchNotification(arabicRequest({ governorate: 'قضاء المحمودية' }));
  assert.ok(!ARABIC_SCRIPT.test(freeTextGov.body.en), freeTextGov.body.en);

  // The deadline column takes forty characters of anything the client sends.
  const prose = printMatchNotification(arabicRequest({ deadline: 'بأسرع وقت ممكن' }));
  assert.ok(!ARABIC_SCRIPT.test(prose.body.en), prose.body.en);
  assert.ok(!prose.body.ar.includes('التسليم'), 'a sentence is not a deadline and must not be printed as one');

  // A governorate name given in Arabic is still one of the eighteen, and must
  // resolve to the right place in every language rather than be dropped.
  const namedGov = printMatchNotification(arabicRequest({ governorate: 'أربيل' }));
  assert.ok(namedGov.body.en.includes('Erbil'));
  assert.ok(namedGov.body.ckb.includes('هەولێر'));
});

test('a bare request still composes a usable body in all three languages', () => {
  const { body } = printMatchNotification({
    title: '',
    process: 'resin',
    quality: 'standard',
    quantity: 1,
    material: null,
    material_id: '',
    color_hex: '',
    dimensions: '',
    governorate: '',
    deadline: '',
    budget_iqd: null,
  });
  // No material, no size, no place, no title: the process and the quality are
  // all there is, and an empty notification body would be worse than terse.
  assert.equal(body.en, 'Resin · Standard');
  assert.equal(body.ar, 'راتنج · قياسية');
  assert.equal(body.ckb, 'ڕەزین · ستاندارد');
  assert.ok(!ARABIC_SCRIPT.test(body.en));
});

/**
 * THE CALL SITE, not just the composer.
 *
 * A perfect `printMatchNotification` proves nothing if the publish handler goes
 * back to passing one variable to both slots. Reading the source is crude, but
 * it is the only thing that pins the ORIGINAL shape of the defect — two
 * notification fields fed from a single identifier — without standing up a
 * database, a materials catalogue, a merchant and a printer to observe it.
 */
test('the publish handler assigns no single variable to both language slots', () => {
  const src = readFileSync(new URL('../worker/routes/printRequests.ts', import.meta.url), 'utf8');

  const pair = (a: string, b: string) => {
    const get = (field: string) => {
      const m = src.match(new RegExp(`\\n\\s*${field}:\\s*([^,\\n]+),`));
      assert.ok(m, `${field} is no longer assigned in printRequests.ts`);
      return m![1].trim();
    };
    assert.notEqual(get(a), get(b), `${a} and ${b} are fed from the same expression`);
  };
  pair('body_ar', 'body_en');
  pair('title_ar', 'title_en');
});
