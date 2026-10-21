/**
 * THE ASSISTANT'S READER (worker/lib/assist/understand), pure.
 *
 * Spoken printer names, Iraqi and Sorani fillers, part families with their
 * clitics, symptoms, HMS codes, and sizes read exactly as the search box reads
 * them. Every spoken model token must be a printer in Bambu's own registry.
 *
 * Run: node --import tsx --test tests/assistReader.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { understand, readHmsCode, readOutcome } from '../worker/lib/assist/understand';
import {
  MODEL_NAME_WORDS,
  SPOKEN_MODELS,
  bareProclitics,
  mentionsModel,
  rewriteSpokenModels,
  splitScripts,
} from '../worker/lib/assist/understand/models';
import { normalizeText } from '../worker/lib/assistantNlu';
import { MODEL_TOKENS } from '../worker/lib/assist/types';
import { MODELS } from '../packages/catalog/src/bambuImport/registry/models';
import { extractIdentifiers } from '../worker/lib/search/identifiers';

test('every spoken form names its printer, and every token is a printer the registry knows', () => {
  const printers = new Set(MODELS.filter((m) => m.kind === 'printer').map((m) => m.token));
  for (const token of MODEL_TOKENS) assert.ok(printers.has(token), `${token} is not a printer in the registry`);
  for (const [token, forms] of SPOKEN_MODELS) {
    assert.ok(printers.has(token), token);
    for (const form of forms) assert.equal(understand(form).model, token, `«${form}»`);
  }
  for (const token of MODEL_TOKENS) assert.ok(MODEL_NAME_WORDS[token].length > 0, token);
});

test('the owner’s spellings: B is not P, and the longest name wins', () => {
  assert.equal(understand('بي ون اس').model, 'P1S', 'the search table spells بي as B; a printer is the P1S');
  assert.equal(understand('بي تو اس').model, 'P2S');
  assert.equal(understand('اي ون ميني').model, 'A1 mini', 'not A1 followed by a stray word');
  assert.equal(understand('اكس ون كاربون').model, 'X1C');
  assert.equal(understand('اكس ون سي').model, 'X1C');
  assert.equal(understand('اكس تو دي').model, 'X2D');
  assert.equal(understand('اچ تو دي').model, 'H2D');
  assert.equal(understand('اتش تو دي').model, 'H2D');
  assert.equal(understand('اي تو ال').model, 'A2L');
  assert.equal(understand('A one').model, 'A1');
  // Latin, through the registry.
  assert.equal(understand('a1mini').model, 'A1 mini');
  assert.equal(understand('X1 Carbon').model, 'X1C');
  assert.equal(understand('p1s').model, 'P1S');
});

test('what is NOT a printer: «اي» is "which", «في دي» is "in D", «ون» alone is nothing', () => {
  for (const text of ['اي طابعة تنصحني', 'في دي', 'ون', 'اي', 'بي']) assert.equal(understand(text).model, undefined, `«${text}»`);
});

test('«نوزل مال اي ون اريده 0.2»: part, printer and size, with nothing left over', () => {
  const u = understand('نوزل مال اي ون اريده 0.2');
  assert.equal(u.part, 'nozzle_hotend');
  assert.equal(u.model, 'A1');
  assert.deepEqual(u.measures, ['0.2']);
  assert.deepEqual(u.residual, [], 'مال and اريده name nothing');
  assert.equal(u.symptom, undefined);
  // The same in Sorani, in English, and with Arabic-Indic digits.
  for (const text of ['نۆزڵ بۆ A1 0.2', 'nozzle for A1 0.2mm', 'نوزل ٠.٢ مال ايه ون']) {
    const v = understand(text);
    assert.equal(v.part, 'nozzle_hotend', text);
    assert.equal(v.model, 'A1', text);
    assert.deepEqual(v.measures, ['0.2'], text);
  }
});

test('sizes and codes are exactly the search engine’s own reading', () => {
  for (const text of ['نوزل 0.4', 'nozzle 0.4mm', 'نوزل ٠.٤', 'FAP035', 'PLA 10101']) {
    const ids = extractIdentifiers(text);
    const u = understand(text);
    assert.deepEqual(u.measures, ids.measures, text);
    assert.deepEqual(u.codes, ids.codes, text);
  }
});

test('«بحث عن منتج صيانه خلل بالنوزل»: a shopping question about a nozzle fault, in maintenance', () => {
  const u = understand('بحث عن منتج صيانه خلل بالنوزل');
  assert.equal(u.part, 'nozzle_hotend', '«بالنوزل» carries its clitics');
  assert.equal(u.productCue, true);
  assert.equal(u.problemCue, true);
  assert.equal(u.maintenance, true);
  assert.equal(u.symptom, undefined, '«خلل» is a fault, not a symptom');
  assert.deepEqual(u.residual, []);
});

test('part families: plates and cleaning tools, with the conjunction glued on', () => {
  assert.equal(understand('واكو بليت؟').part, 'plate');
  assert.deepEqual(understand('واكو بليت؟').residual, []);
  assert.equal(understand('PEI plate').part, 'plate');
  assert.equal(understand('ابرة تنظيف').part, 'cleaning');
  assert.deepEqual(understand('نوزل فولاذ مقوى 0.4').residual, ['فولاذ', 'مقوي'], 'unclaimed words are kept for the search');
});

test('symptoms: «كلوب» is a clog; «خيوط» and «AMS» need a reason; a bare «صوت» is not one', () => {
  for (const text of ['كلوب', 'النوزل مسدود', 'nozzle clogged', 'نۆزڵ گیراوە', 'انسداد النوزل']) {
    assert.equal(understand(text).symptom, 'clog', text);
  }
  assert.equal(understand('خيوط PLA').symptom, undefined, '«خيوط PLA» is a filament question');
  assert.equal(understand('خيوط', { expectSymptom: true }).symptom, 'stringing', 'while the triage asks for the symptom');
  assert.equal(understand('عندي مشكلة خيوط').symptom, 'stringing', 'beside a problem word');
  assert.equal(understand('AMS lite').symptom, undefined, 'AMS is also a product');
  assert.equal(understand('مشكلة AMS').symptom, 'ams');
  assert.equal(understand('صوت').symptom, undefined);
  assert.equal(understand('يطلع صوت غريب').symptom, 'noise');
  assert.equal(understand('ما يلزق على البليت').symptom, 'adhesion');
  assert.equal(understand('ازاحة الطبقات').symptom, 'layer_shift');
});

test('a printer fault with no symptom named: the problem and printer cues', () => {
  const u = understand('صارت عندي مشكله بالطابعه');
  assert.equal(u.problemCue, true);
  assert.equal(u.printerCue, true);
  assert.equal(u.productCue, false);
  assert.equal(understand('پرینتەرەکەم کێشەی هەیە').problemCue, true, 'Sorani');
  assert.equal(understand('پرینتەرەکەم کێشەی هەیە').printerCue, true, 'Sorani');
});

test('HMS codes in the shapes the printer and the app write, and never a plain number', () => {
  assert.equal(readHmsCode('HMS_0300_0100_0001_0003'), '0300-0100-0001-0003');
  assert.equal(readHmsCode('رمز خطأ 0700-2000-0002-0001'), '0700-2000-0002-0001');
  assert.equal(readHmsCode('hms 0C00 0300'), '0C00-0300');
  assert.equal(readHmsCode('HMS0300010000010003'), '0300-0100-0001-0003');
  assert.equal(readHmsCode('2024 1000 5000 3000'), undefined);
  assert.equal(readHmsCode('07701234567'), undefined);
  const u = understand('HMS_0300_0100_0001_0003');
  assert.equal(u.symptom, 'hms');
  assert.deepEqual(u.codes, [], 'an HMS code is never sent to product search');
});

test('legacy readers get the token: «كم تستهلك بي ون اس» → p1s, and plain text is untouched', () => {
  assert.equal(rewriteSpokenModels('كم تستهلك بي ون اس'), 'كم تستهلك p1s');
  assert.equal(rewriteSpokenModels('وين طلبي ORD-8F21'), 'وين طلبي ORD-8F21');
});

test('the by-name check reads whole words, and a series word names its printers', () => {
  assert.equal(mentionsModel('Bambu Hotend - A1/A2', 'A1'), true);
  assert.equal(mentionsModel('Bambu Hotend - X1/P1', 'A1'), false);
  assert.equal(mentionsModel('Bambu Hotend - X1/P1', 'P1S'), true);
  assert.equal(mentionsModel('Bambu Hotend - X1/P1', 'X1C'), true);
  assert.equal(mentionsModel('Hotend for A1 mini', 'A1 mini'), true);
  assert.equal(mentionsModel('Hotend for A12', 'A1'), false);
});

test('an article or preposition glued to a printer name: «الاي ون», «للبي ون اس», «للA1», «بالP1S»', () => {
  for (const [text, model] of [
    ['نوزل مال الاي ون', 'A1'],
    ['نوزل للاي ون', 'A1'],
    ['نوزل بالاي ون', 'A1'],
    ['حق الاي ون', 'A1'],
    ['نوزل مال البي ون اس', 'P1S'],
    ['للبي ون اس', 'P1S'],
    ['للاكس ون كاربون', 'X1C'],
    ['والاي ون ميني', 'A1 mini'],
    ['نوزل للA1', 'A1'],
    ['نوزل بالP1S', 'P1S'],
    ['نوزل للX1C', 'X1C'],
  ] as const) {
    const u = understand(text);
    assert.equal(u.model, model, `«${text}»`);
    assert.deepEqual(u.residual, [], `«${text}»: nothing left over`);
  }
  assert.equal(understand('الهوت اند مال A1').part, 'nozzle_hotend', 'a phrase keeps its article too');
  assert.equal(splitScripts('للA1 بالP1S الـAMS'), 'لل A1 بال P1S الـ AMS');
  assert.equal(splitScripts('A١ ٠.٢mm'), 'A١ ٠.٢mm', 'Arabic-Indic digits stay with their neighbours');
  // Only a known phrase loses its clitic: «البيت» is not «بيت».
  assert.equal(bareProclitics(normalizeText('البيت للاي ون'), [normalizeText('اي ون')]), normalizeText('البيت اي ون'));
  assert.equal(rewriteSpokenModels('كم تستهلك البي ون اس'), 'كم تستهلك p1s');
});

test('a printer named and not read: spoken digits, a model-shaped token, another maker; never a material or a screw', () => {
  for (const text of ['نوزل مال زد ون', 'نوزل k1c', 'نوزل للكريالتي', 'نوزل prusa mk4']) assert.equal(understand(text).printerUnread, true, `«${text}»`);
  assert.equal(understand('عندي طابعة كريالتي اندر 3').otherBrand, true);
  for (const text of ['نوزل مال اي ون', 'PA6-CF', 'براغي M3', 'نوزل V6 0.4', 'نوزل', 'A1 combo']) assert.equal(understand(text).printerUnread, false, `«${text}»`);
});

test('typed symptoms in either word order, and the words that are not symptoms', () => {
  for (const [text, symptom] of [
    ['النوزل معلك', 'clog'],
    ['الفلامنت ما يطلع من النوزل', 'clog'],
    ['ما يطلع فلامنت', 'clog'],
    ['النوزل مسكر', 'clog'],
    ['الطبعة ترتفع من الزوايا', 'adhesion'],
    ['الطبقات دا تزحف', 'layer_shift'],
    ['الطبعة بيها خيوط مثل شعر', 'stringing'],
    ['الـAMS ما يسحب الفلامنت', 'ams'],
    ['AMS is not feeding', 'ams'],
  ] as const) {
    assert.equal(understand(text).symptom, symptom, `«${text}»`);
  }
  for (const text of ['المحل مسكر', 'الطلب معلك', 'خيوط PLA']) assert.equal(understand(text).symptom, undefined, `«${text}»`);
  const leak = understand('تسريب من النوزل');
  assert.equal(leak.problemCue, true);
  assert.equal(leak.faultCue, true, 'a leak is a fault, not the clog its part suggests');
});

test('the outcome of the steps, typed: the negation first, in three languages', () => {
  for (const text of ['جربتها وما انحلّت', 'ما انحلت', 'نفس المشكلة', 'still not fixed', 'did not work', 'هێشتا چارەسەر نەبوو']) {
    assert.equal(readOutcome(normalizeText(text)), 'not_fixed', `«${text}»`);
  }
  for (const text of ['انحلت', 'انحلّت المشكلة شكرا', 'fixed', 'چارەسەر بوو']) assert.equal(readOutcome(normalizeText(text)), 'resolved', `«${text}»`);
  for (const text of ['شكد سعر A1', 'كلوب']) assert.equal(readOutcome(normalizeText(text)), undefined, `«${text}»`);
});

test('follow-up words: a correction, an ordinal, and a printer that is not a product code', () => {
  assert.equal(understand('لا قصدي بي ون اس').correction, true);
  assert.equal(understand('لا قصدي بي ون اس').model, 'P1S');
  assert.equal(understand('الاول بكم').ordinal, 0);
  assert.equal(understand('الثاني متوفر؟').ordinal, 1);
  assert.deepEqual(understand('P1S').codes, [], '«P1S» typed alone is the printer, not the code P1S');
  assert.deepEqual(understand('اكو 0.4؟').measures, ['0.4']);
});
