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
import { understand, readHmsCode } from '../worker/lib/assist/understand';
import { MODEL_NAME_WORDS, SPOKEN_MODELS, mentionsModel, rewriteSpokenModels } from '../worker/lib/assist/understand/models';
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
