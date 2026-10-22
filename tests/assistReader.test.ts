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
import { understand, readHmsCode, readOutcome, saysTried } from '../worker/lib/assist/understand';
import {
  FAMILY_MEMBERS,
  MODEL_NAME_WORDS,
  SPOKEN_FAMILIES,
  SPOKEN_MODELS,
  bareEnclitics,
  bareProclitics,
  joinSplitNames,
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

test('Sorani spoken printer names: «ئەی وەن», «پی وەن ئێس», «ئێچ تو دی», each a printer of the registry', () => {
  for (const [text, model] of [
    ['ئەی وەن', 'A1'],
    ['ئەی وەن مینی', 'A1 mini'],
    ['ئەی تو ئێڵ', 'A2L'],
    ['پی وەن ئێس', 'P1S'],
    ['پی وەن پی', 'P1P'],
    ['پی تو ئێس', 'P2S'],
    ['ئێکس وەن کاربۆن', 'X1C'],
    ['ئێکس وەن ئی', 'X1E'],
    ['ئێکس تو دی', 'X2D'],
    ['ئێچ تو دی', 'H2D'],
    ['ئێچ تو دی پرۆ', 'H2D Pro'],
    ['ئێچ تو ئێس', 'H2S'],
    ['ئێچ تو سی', 'H2C'],
  ] as const) {
    assert.equal(understand(text).model, model, `«${text}»`);
  }
  const u = understand('نۆزڵ بۆ ئەی وەن 0.2');
  assert.equal(u.part, 'nozzle_hotend');
  assert.equal(u.model, 'A1');
  assert.deepEqual(u.measures, ['0.2']);
  assert.deepEqual(u.residual, []);
  const fault = understand('کێشە لە ئەی وەن هەیە');
  assert.equal(fault.model, 'A1');
  assert.equal(fault.problemCue, true);
});

test('a series is its printers, never an unread name: «X1», «بي ون», «ئێکس وەن»; «A2» is the A2L', () => {
  const printers = new Set(MODELS.filter((m) => m.kind === 'printer').map((m) => m.token));
  for (const [family, forms] of SPOKEN_FAMILIES) {
    const members = FAMILY_MEMBERS.get(family) ?? [];
    assert.ok(members.length > 0, family);
    for (const m of members) assert.ok(printers.has(m), `${family}: ${m}`);
    for (const form of forms) {
      const u = understand(`نوزل ${form}`);
      assert.equal(u.printerUnread, false, `«${form}»`);
      if (members.length === 1) assert.equal(u.model, members[0], `«${form}»`);
      else assert.deepEqual(u.family?.members, members, `«${form}»`);
    }
  }
  for (const text of ['نوزل X1', 'نوزل x1 series', 'نوزل للاكس ون']) assert.deepEqual(understand(text).family, { name: 'X1', members: ['X1C', 'X1E'] }, text);
  assert.deepEqual(understand('نوزل P1').family, { name: 'P1', members: ['P1P', 'P1S'] });
  assert.equal(understand('نوزل A2').model, 'A2L');
  // A whole model name is never cut down to its series.
  assert.equal(understand('اكس ون كاربون').family, undefined);
  assert.equal(understand('بي ون اس').model, 'P1S');
  assert.equal(understand('X1C').family, undefined);
  // «x2» in lowercase, or held by a size, is a quantity as often as a series: never silently the X2D.
  for (const text of ['نوزل x2', 'نوزل 0.4 x2', 'نوزل 0.4 X2']) assert.equal(understand(text).model, undefined, text);
  assert.equal(understand('نوزل X2').model, 'X2D');
});

test('not printer names: E3D (a hotend maker), «ثري دي» (3D), Iraqi «تو» (just now), TPU 95A, AMS2', () => {
  for (const text of ['نوزل E3D', 'نوزل لطابعة ثري دي', 'نوزل اشتريته تو', 'TPU 95A', 'ams2 pro', 'وصلني تو', 'نۆزڵ بۆ تۆ', 'ئەی تۆ کێشەم هەیە']) {
    assert.equal(understand(text).printerUnread, false, `«${text}»`);
    assert.equal(understand(text).model, undefined, `«${text}»`);
  }
  // A spoken digit after a spoken letter is still a printer the tables do not know.
  for (const text of ['نوزل مال زد ون', 'نوزل كي ون سي', 'نۆزڵ بۆ زێد وەن', 'nozzle for the Z1']) assert.equal(understand(text).printerUnread, true, `«${text}»`);
});

// ════════════════════════════════════════ review, round 2

test('round 2: «اي تو» is "yes, just now", never the A2 series; a bare Latin «A2» is the A2L only beside a part, a printer or a fault', () => {
  for (const [, forms] of SPOKEN_FAMILIES) for (const form of forms) assert.ok(!['اي تو', 'ايه تو'].includes(form), form);
  for (const text of ['اي تو وصلت', 'اي تو اشتريت نوزل', 'الطابعة اي تو', 'اي تو وصلتني الطابعة وبيها مشكلة', 'ورق A2', 'A2 paper']) {
    const u = understand(text);
    assert.equal(u.model, undefined, `«${text}»`);
    assert.equal(u.printerUnread, false, `«${text}»`);
  }
  assert.equal(understand('نوزل A2').model, 'A2L');
  assert.equal(understand('طابعة A2 بيها مشكلة').model, 'A2L');
  assert.equal(understand('اي تو ال').model, 'A2L', 'the whole spoken name is still the A2L');
});

test('round 2: «تو», the purchase and «اي» are not searched: «نوزل اشتريته تو» leaves nothing over', () => {
  for (const text of ['نوزل اشتريته تو', 'اي تو اشتريت نوزل', 'نوزل شريته توه', 'نوزل وصلني تو']) assert.deepEqual(understand(text).residual, [], text);
  assert.deepEqual(understand('نوزل مال اي ون كومبو').residual, [], '«كومبو» is the bundle word of the printer name');
  assert.deepEqual(understand('نۆزڵ بۆ ئەی وەن کۆمبۆ').residual, []);
});

test('round 2: a name in two pieces is one printer: «P1-S», «x1 c», «نوزل p1 s»', () => {
  for (const [text, model] of [
    ['nozzle for p1-s', 'P1S'],
    ['nozzle for P1-S', 'P1S'],
    ['نوزل p1 s', 'P1S'],
    ['nozzle for X1-C', 'X1C'],
    ['nozzle for x1-c', 'X1C'],
    ['H2-D hotend', 'H2D'],
  ] as const) {
    const u = understand(text);
    assert.equal(u.model, model, text);
    assert.equal(u.family, undefined, text);
    assert.equal(u.printerUnread, false, text);
  }
  // Only a join the registry reads as exactly that printer.
  assert.equal(joinSplitNames('A1 mini X1 Carbon A1 a'), 'A1 mini X1 Carbon A1 a');
  assert.equal(joinSplitNames('0.4 x2 d'), '0.4 x2d', 'a join of a real printer only');
  assert.equal(understand('نوزل P1').family?.name, 'P1', 'a series named alone stays a series');
});

test('round 2: Sorani glues the article and the possessive on at the end: «ئەی وەنەکەم» is my A1', () => {
  for (const [text, model] of [
    ['ئەی وەنەکەم کێشەی هەیە', 'A1'],
    ['نۆزڵ بۆ ئەی وەنەکەم', 'A1'],
    ['نۆزڵی ئەی وەنەکە', 'A1'],
    ['پی وەن ئێسەکەم کێشەی هەیە', 'P1S'],
    ['ئێچ تو دییەکەم', 'H2D'],
  ] as const) {
    assert.equal(understand(text).model, model, text);
  }
  assert.deepEqual(understand('نۆزڵ بۆ ئێکس وەنەکەم').family, { name: 'X1', members: ['X1C', 'X1E'] });
  // Only a Sorani name loses a letter: an Arabic phrase is never touched.
  assert.equal(bareEnclitics(normalizeText('اي ونه'), [normalizeText('اي ون')]), normalizeText('اي ونه'));
});

test('round 2: two series named are all their printers, and connectors, belts and lasers are not printers', () => {
  for (const text of ['نوزل X1 او P1', 'hotend for X1 and P1', 'Nozzle Wiper - X1/P1 Series', 'نوزل للاكس ون والبي ون']) {
    const u = understand(text);
    assert.equal(u.printerUnread, false, text);
    assert.deepEqual(u.family?.members, ['P1P', 'P1S', 'X1C', 'X1E'], text);
  }
  for (const text of ['GT2 Timing Belt', '030 Micro DC Motor with SH1.0', 'PH2.0 cable', 'Air-assist Nozzle - R1', 'A4 200g Kraft Paper', 'BT2 screw', 'N20 motor']) {
    assert.equal(understand(text).printerUnread, false, text);
  }
});

test('round 2: a maker named by its line, with a spoken digit, is a printer the shop does not list', () => {
  for (const text of ['نوزل مال نبتون فور', 'وعندي هم كوبرا تو، اريد نوزل الها', 'نێپتوون فۆر', 'نوزل للنبتون فور']) {
    const u = understand(text);
    assert.equal(u.printerUnread, true, text);
    assert.equal(u.otherBrand, true, text);
    assert.equal(u.model, undefined, text);
  }
});

test('round 2: a purchase in the past is the story of a fault, not a shopping question', () => {
  for (const [text, symptom] of [
    ['اشتريت طابعة وصار بيها انسداد بالنوزل', 'clog'],
    ['اشتريت طابعة تو وصار بيها انسداد بالنوزل', 'clog'],
    ['اشتريت A1 من عدكم والنوزل مسدود', 'clog'],
  ] as const) {
    const u = understand(text);
    assert.equal(u.productCue, false, text);
    assert.equal(u.symptom, symptom, text);
  }
  const story = understand('اشتريت طابعة من عندكم وصارت بيها مشكلة');
  assert.equal(story.productCue, false);
  assert.equal(story.problemCue, true);
  // Asking to buy is still asking: «عندكم», «اريد اشتري», «بكم».
  for (const text of ['عندكم نوزل؟', 'اريد اشتري نوزل', 'بكم النوزل']) assert.equal(understand(text).productCue, true, text);
});

test('round 2: Sorani «پلێت» and «کلۆگ», and an HMS code typed with Arabic-Indic digits', () => {
  const plate = understand('پلێت بۆ ئێکس وەن کاربۆن');
  assert.equal(plate.part, 'plate');
  assert.equal(plate.model, 'X1C');
  for (const text of ['کلۆگ', 'نۆزڵەکەم کلۆگ بووە']) assert.equal(understand(text).symptom, 'clog', text);
  assert.equal(readHmsCode('٠٣٠٠-٠١٠٠-٠٠٠١-٠٠٠٣'), '0300-0100-0001-0003');
  assert.equal(readHmsCode('۰۷۰۰-۲۰۰۰-۰۰۰۲-۰۰۰۱'), '0700-2000-0002-0001', 'the Persian digits too');
  const typed = understand('رمز خطأ ٠٣٠٠-٠١٠٠-٠٠٠١-٠٠٠٣');
  assert.equal(typed.hmsCode, '0300-0100-0001-0003');
  assert.equal(typed.symptom, 'hms');
  assert.deepEqual(typed.codes, []);
});

// ════════════════════════════════════════ review, round 3

test('round 3: a lowercase «x1» is the X1 alone or beside a part, a lowercase «x2» stays a quantity', () => {
  for (const text of ['x1', 'x1 nozzle', 'نوزل x1', 'الطابعة x1 بيها مشكلة']) {
    const u = understand(text);
    assert.deepEqual(u.family?.members, ['X1C', 'X1E'], text);
    assert.equal(u.printerUnread, false, text);
  }
  // Beside nothing that makes it a printer, it is not one: and never an unreadable printer either.
  const quantity = understand('PLA x1');
  assert.equal(quantity.family, undefined);
  assert.equal(quantity.printerUnread, false);
  for (const text of ['نوزل x2', 'نوزل 0.4 x2']) assert.equal(understand(text).model, undefined, text);
  // «A2» typed alone answers «which printer?»; «ورق A2» is still paper.
  assert.equal(understand('A2').model, 'A2L');
  assert.equal(understand('ورق A2').model, undefined);
});

test('round 3: the Iraqi «دا», «ما تطبع», «وكفت», "stopped working", «چاپ ناکات» are faults', () => {
  for (const text of ['الطابعة ما تطبع', 'الطابعة ما دا تشتغل', 'الطابعه وكفت', 'my printer is not printing', 'printer stopped working', "it won't print", 'پرینتەرەکەم چاپ ناکات']) {
    assert.equal(understand(text).problemCue, true, text);
  }
  const clog = understand('ما دا يطلع فلامنت من النوزل');
  assert.equal(clog.symptom, 'clog');
  // «دا» elsewhere is left alone.
  assert.equal(understand('دا').problemCue, false);
});

test('round 3: «طابعتي», "my own printer", «پرینتەرەکەی خۆم» name the printer of the account, and nothing else does', () => {
  for (const text of ['طابعتي', 'مالتي', 'my printer', 'my own printer', 'mine', 'پرینتەرەکەم', 'پرینتەرەکەی خۆم', 'هی خۆم']) {
    assert.equal(understand(text).ownPrinter, true, text);
  }
  for (const text of ['طابعتي A1', 'طابعتي بيها مشكلة', 'my printer is broken', 'نوزل لطابعتي', 'printer']) {
    assert.equal(understand(text).ownPrinter, false, text);
  }
});

test('round 3: the words a code arrives with, English follow-ups, a price asked bare, and what is never searched', () => {
  const code = understand('وطلعلي رمز 0300-0100-0001-0003');
  assert.equal(code.symptom, 'hms');
  assert.equal(code.wordSymptom, undefined, 'the words name no fault: the code joins the fault in hand');
  assert.equal(understand('انسداد النوزل ورمز 0300-0100-0001-0003').wordSymptom, 'clog');
  for (const text of ['how much is it?', 'is it in stock?', 'how much are they?', 'how much is the first one?']) {
    assert.deepEqual(understand(text).residual, [], text);
  }
  assert.equal(understand('how much is the first one?').ordinal, 0);
  for (const text of ['how much?', 'شكد؟', 'بيش', 'چەندە؟']) assert.equal(understand(text).priceAsk, true, text);
  assert.equal(understand('how many layers?').priceAsk, false);
  for (const text of ['اريد اغير النوزل مال الاي ون', 'نوزل طابعة ثري دي', 'اريد نوزل جديد', 'اكو نوزل اصلي؟', 'نۆزڵم دەوێت', 'نوزل مال نبتون فور']) {
    assert.deepEqual(understand(text).residual, [], text);
  }
  assert.equal(understand('I need maintenance products for a faulty nozzle').productCue, true);
});

test('round 3: «CR-10» is another maker; «PA-6» is a material and stays a search word', () => {
  const cr = understand('and a nozzle for my CR-10');
  assert.equal(cr.printerUnread, true);
  assert.equal(cr.otherBrand, true);
  assert.deepEqual(cr.residual, []);
  assert.equal(understand('nozzle for cr10').otherBrand, true);
  const pa = understand('PA-6 filament');
  assert.equal(pa.printerUnread, false);
  assert.ok(pa.residual.includes('pa'), JSON.stringify(pa.residual));
  // A Bambu name written in two pieces is still that printer, or that series.
  assert.equal(understand('nozzle for p1-s').model, 'P1S');
  assert.equal(understand('nozzle for A-1').model, 'A1');
  assert.equal(understand('nozzle for A-1').printerUnread, false);
  assert.deepEqual(understand('نوزل X-1').family?.members, ['X1C', 'X1E']);
});

test('round 4: «تنظيف النوزل» is the cleaning tools; a cleaning tool named is read; "nozzle" alone is still the nozzle', () => {
  for (const text of ['nozzle cleaning', 'تنظيف النوزل', 'پاککردنەوەی نۆزڵ', 'شي ينظف النوزل', 'اريد شي انظف بيه النوزل', 'اسفنجة تنظيف النوزل', 'شتێک بۆ پاککردنەوەی نۆزڵ']) {
    const u = understand(text);
    assert.equal(u.part, 'cleaning', text);
    assert.deepEqual(u.residual, [], `${text}: nothing left over to search`);
  }
  assert.equal(understand('اسفنجة تنظيف النوزل').tool, 'sponge');
  assert.equal(understand('ابرة تنظيف').tool, 'needle');
  assert.equal(understand('nozzle cleaning').tool, undefined);
  assert.equal(understand('نوزل مال اي ون').part, 'nozzle_hotend');
  assert.equal(understand('nozzle').part, 'nozzle_hotend');
});

test('round 4: another maker is read in Latin, as the catalogue writes it', () => {
  assert.deepEqual(understand('اكو نوزل سنابميكر؟').makers, ['snapmaker']);
  assert.deepEqual(understand('snapmaker hotend').makers, ['snapmaker']);
  assert.deepEqual(understand('نوزل مال نبتون فور').makers, ['neptune']);
  assert.equal(understand('نوزل مال اي ون').makers, undefined);
});

test('round 4: English faults and the Sorani «any other?»', () => {
  for (const text of ['something is wrong with my printer', 'help, my printer stopped', 'my printer is acting up']) {
    const u = understand(text);
    assert.equal(u.problemCue, true, text);
    assert.equal(u.printerCue, true, text);
  }
  for (const text of ['شتی تر هەیە؟', 'جۆری تر هەیە؟', 'هی تر هەیە؟']) {
    const u = understand(text);
    assert.equal(u.otherPrinter, true, text);
    assert.deepEqual(u.residual, [], text);
    assert.equal(u.printerCue, false, `${text}: no printer named, so it is «more of the same»`);
  }
  assert.equal(understand('پرینتەرێکی تر').printerCue, true, '«another printer» still names a printer');
});

test('round 4.2: an order, a delivery, a return, a warranty or a payment beside a fault word is read as the account', () => {
  for (const text of [
    'something is wrong with my A1 order',
    'my A1 order has stopped',
    'the delivery of my P1S has stopped',
    'I want to return my A1, something is wrong with it',
    'something is wrong with the warranty of my A1',
    'my A1 order is not right',
    'I have a problem with my A1 order',
    'problem with the delivery of my P1S',
    'something wrong with the payment for my printer',
    'عندي مشكلة بطلبية الاي ون',
    'مشكلة بتوصيل البي ون اس',
    'اريد ارجع الاي ون بيه مشكلة',
    'عندي مشكلة بالضمان',
    'داواکارییەکەم کێشەی هەیە',
  ]) {
    assert.equal(understand(text).accountCue, true, text);
  }
  // A purchase or an arrival in the past is the story of a fault, never the account.
  for (const text of [
    'اي تو وصلتني الطابعة وبيها مشكلة',
    'اشتريت طابعة من عندكم وما تشتغل',
    'I bought an A1 and it stopped working',
    'the A1 I ordered is not printing',
    'my printer arrived and it is not printing',
    'something is wrong with my printer',
    'عندي مشكلة بالنوزل',
  ]) {
    assert.equal(understand(text).accountCue, false, text);
  }
});

test('round 4.2: "not right", a bare "wrong with", "has stopped" and "it stopped" are no fault; the printer as the subject still is', () => {
  for (const text of [
    'is the P1S not right for beginners?',
    'the A1 is not right for me, what else?',
    'nothing wrong with the A1, I just want a faster printer',
    'what is wrong with buying the A1 mini?',
    'my A1 order has stopped',
    'my A1 order is not right',
    'has the A1 combo offer stopped?',
  ]) {
    assert.equal(understand(text).problemCue, false, text);
  }
  for (const text of ['something is wrong with my printer', 'help, my printer stopped', 'my printer has stopped', 'my printer is acting up', 'what is wrong with my printer']) {
    assert.equal(understand(text).problemCue, true, text);
  }
});

test('round 4.3: steps not tried are no outcome; a bare "still" or «هێشتا» inside a sentence is not «not fixed», the whole phrases still are', () => {
  for (const text of [
    "I still haven't tried them",
    "still haven't tried",
    'I have not tried them yet',
    "didn't try them",
    'بعدني ما جربتها',
    'ما جربتها',
    'لم أجربها بعد',
    'هێشتا تاقیم نەکردۆتەوە',
    'تاقیم نەکردووەتەوە',
    'still waiting for the needle to arrive',
  ]) {
    assert.equal(readOutcome(normalizeText(text)), undefined, `«${text}»`);
    assert.equal(understand(text).outcome, undefined, `«${text}»`);
  }
  for (const text of [
    'still not fixed',
    'still clogged',
    "it's still the same",
    "still doesn't work",
    "it still didn't work",
    "didn't work",
    'تاقیم کردەوە، هێشتا چارەسەر نەبووە',
    'هێشتا کار ناکات',
    'هێشتا گیراوە',
    'هێشتا هەمان کێشەیە',
  ]) {
    assert.equal(readOutcome(normalizeText(text)), 'not_fixed', `«${text}»`);
  }
});

test('round 5: the steps are said to be tried only with a verb of trying that nothing negates', () => {
  for (const text of [
    'جربتها وما انحلّت',
    'جربت كلشي ونفس المشكله',
    'ما زبطت، جربتها كلها',
    'سويتها بس نفس المشكله',
    'tried them, still not fixed',
    'I did them all, still clogged',
    'done, still the same',
    'still not fixed, I tried them',
    'تاقیم کردەوە، هێشتا چارەسەر نەبووە',
    'تاقیم کردەوە بەڵام هێشتا',
    'هەمووم کرد، هێشتا گیراوە',
  ]) {
    assert.equal(saysTried(normalizeText(text)), true, `«${text}»`);
    assert.equal(understand(text).triedSaid, true, `«${text}»`);
  }
  for (const text of [
    'ما سويتها بس نفس المشكله',
    'ما سويت الخطوات، نفس المشكله',
    'ما طبقت الخطوات بعده مسدود',
    'نفس المشكله',
    'ما انحلت',
    "haven't done them, still clogged",
    'I have not done the steps, no luck',
    "I didn't do them, still clogged",
    'I did not do them, same problem',
    'not yet, same problem',
    "I haven't yet tried",
    'still clogged',
    "it still didn't work",
    'نەمکردووە، هێشتا گیراوە',
    'هێشتا گیراوە',
    'هێشتا تاقیم نەکردۆتەوە',
  ]) {
    assert.equal(saysTried(normalizeText(text)), false, `«${text}»`);
    assert.equal(understand(text).triedSaid, false, `«${text}»`);
  }
});

test('round 5: the common whole «still» replies are «not fixed»; a longer sentence with a bare «still» is not', () => {
  for (const text of [
    'هێشتا کێشەکە هەیە',
    'هێشتا چاک نەبووە',
    'هێشتا کارناکات',
    'هێشتا ئیش ناکات',
    'هێشتا هەمان شتە',
    'نەخێر هێشتا',
    'تاقیم کردەوە بەڵام هێشتا',
    'هێشتا',
    'still',
    'it still happens',
    'nope, still',
    'yes still',
    'still bad',
    'still getting the same error',
    'tried all of them but still',
    'still clogs',
  ]) {
    assert.equal(readOutcome(normalizeText(text)), 'not_fixed', `«${text}»`);
  }
  for (const text of ['still waiting for the needle to arrive', "I still haven't tried them", 'هێشتا تاقیم نەکردۆتەوە', 'still have not tried']) {
    assert.equal(readOutcome(normalizeText(text)), undefined, `«${text}»`);
  }
});

test('round 5.2: a negation further off, a "nothing" after the verb, «ولا» and only some of the steps are never «tried»; the plural «ـهن», the Sorani forms and "did that" are', () => {
  for (const text of [
    "I haven't really tried them, still clogged",
    "I haven't even tried them, still clogged",
    'I have not actually done them, still clogged',
    'never really tried, still clogged',
    'I did nothing, still clogged',
    'I did none of them, still clogged',
    "I've done nothing, still clogged",
    'I have done nothing yet, still clogged',
    'I have done none of them, still clogged',
    'done nothing, still clogged',
    'nothing done, still clogged',
    'tried nothing, still clogged',
    "I've tried nothing yet, still clogged",
    'I did the first one only, still clogged',
    'ولا سويت شي وبعده نفس المشكله',
    'سويت ولا شي، نفس المشكله',
    'ولا خطوة جربتها، نفس المشكله',
    'ما بعد جربتها نفس المشكله',
    'جربت الاولى بس، نفس المشكله',
    'تەنها یەکەمیانم کرد، هێشتا گیراوە',
  ]) {
    assert.equal(saysTried(normalizeText(text)), false, `«${text}»`);
    assert.equal(understand(text).triedSaid, false, `«${text}»`);
  }
  for (const text of [
    'جربتهن وما زبطت',
    'سويتهن بس نفس المشكله',
    'طبقتهن وبعده مسدود',
    'نفذتهن ونفس المشكله',
    'عملتهن كلهن ونفس المشكله',
    'مسويهن بس بعده مسدود',
    'هەموویم تاقی کردەوە، هێشتا چارەسەر نەبووە',
    'تاقی کردەوە، هێشتا گیراوە',
    'تاقیمکردنەوە، هێشتا گیراوە',
    'جێبەجێم کردن، هێشتا گیراوە',
    'ئەنجامم دان بەڵام هێشتا',
    'did that, still clogged',
    'did these, still clogged',
    'gave it a try, still clogged',
    // A clause of its own after the verb, and a bare «لا» ("no,") opening the reply, never negate it.
    'tried, nothing changed',
    'did it, nothing changed',
    'جربت ولا شي تغير',
    'لا جربتها بس نفس المشكله',
  ]) {
    assert.equal(saysTried(normalizeText(text)), true, `«${text}»`);
    assert.equal(understand(text).triedSaid, true, `«${text}»`);
  }
});

// ════════════════════════════════════════ review, round 5.4

test('round 5.4: a printer the customer says they have, own or bought is read as such; a want, a need, a have-not, a price or a stock ask never is', () => {
  for (const text of [
    'عندي اي ون',
    'وعندي اي ون',
    'طابعتي A1',
    'اكو عندي اي ون',
    'اشتريت اي ون من عندكم',
    'شريت اي ون من عدكم',
    'طابعتي A1 من عندكم',
    'عندي طابعة',
    'I have an A1',
    'I own a P1S',
    'I bought an A1',
    'my printer is an A1',
    'A1م هەیە',
    'پرینتەرێکی P1Sم هەیە',
    'پرینتەرێکم هەیە',
    'پرینتەرەکەم A1ە',
  ]) {
    assert.equal(understand(text).ownsSaid, true, `«${text}»`);
  }
  for (const text of [
    'اريد اي ون مالتي',
    'ابي طابعة مالتي',
    'ماكو عندي طابعة',
    'ماكو طابعة عندي',
    'عندي ولا اي ون',
    'ما عندي طابعة',
    'I want an A1, I have a P1S',
    'I need my own printer',
    "I don't have a printer",
    'I have no printer',
    'پرینتەرێکم دەوێ',
    'پرینتەرێکم پێویستە',
    'پرینتەرم نییە',
    'عندكم اي ون؟',
    'do you have the A1?',
    'A1 هەیە؟',
    'how much is my A1',
    'is my printer in stock',
    'اكو طابعتي؟',
    'طابعتي موجودة عندكم؟',
    'عندي A1 موجودة عندكم؟',
    'عندي اي ون شكد سعره',
    'I have an A1, how much is it',
    'A1م هەیە، نرخی چەندە؟',
  ]) {
    assert.equal(understand(text).ownsSaid, false, `«${text}»`);
  }
});

test('round 5.4: the glued «ماعندي» and «معندي» are read as «ما عندي», never a word to search', () => {
  for (const text of ['ماعندي طابعة', 'معندي طابعة', 'وماعندي طابعة']) {
    const spaced = understand(text.replace(/م(ا)?عندي/, 'ما عندي'));
    assert.deepEqual(understand(text).residual, spaced.residual, `«${text}»`);
    assert.ok(!understand(text).residual.some((w) => w.includes('عندي')), `«${text}»: ${JSON.stringify(understand(text).residual)}`);
  }
});

test('round 5.4: «still» or «هێشتا» and a fault, a problem or sameness is «not fixed»; a wait and steps not tried are not', () => {
  for (const text of [
    'still jamming',
    'still jams',
    'still failing',
    'still a problem',
    'still an issue',
    'it still persists',
    'still occurs',
    'still doing it',
    'still nothing',
    'still no extrusion',
    'still nothing comes out',
    'هێشتا کێشەی هەیە',
    'هێشتا هەر وایە',
    'هێشتا هەر کار ناکات',
    'هێشتا خراپە',
    'هێشتا هەر گیراوە',
    'هێشتا نۆزڵەکە گیراوە',
  ]) {
    assert.equal(readOutcome(normalizeText(text)), 'not_fixed', `«${text}»`);
    assert.equal(understand(text).outcome, 'not_fixed', `«${text}»`);
  }
  for (const text of ['still waiting for a part', 'still waiting for the needle to arrive', 'هێشتا چاوەڕێی پارچەکەم', 'هێشتا تاقیم نەکردۆتەوە', "I still haven't tried them"]) {
    assert.equal(readOutcome(normalizeText(text)), undefined, `«${text}»`);
  }
});

test('round 5.4: «بعد ما» before a verb is "after", never a negation; «بعدني ما انحلت» is not fixed; "after trying them" says tried', () => {
  for (const text of ['بعد ما جربتهم ما زبطت', 'بعد ما جربتها نفس المشكلة', 'من بعد ما طبقتها نفس المشكله', 'جربتها بس بعدني ما انحلت', 'after trying them, still clogged']) {
    assert.equal(readOutcome(normalizeText(text)), 'not_fixed', `«${text}»`);
    assert.equal(saysTried(normalizeText(text)), true, `«${text}»`);
    assert.equal(understand(text).triedSaid, true, `«${text}»`);
  }
  for (const text of ['بعدني ما انحلت', 'بعدني ما زبطت']) {
    assert.equal(readOutcome(normalizeText(text)), 'not_fixed', `«${text}»`);
    assert.equal(saysTried(normalizeText(text)), false, `«${text}»`);
  }
  for (const text of ['بعدني ما جربتها', 'ما جربتهم']) {
    assert.equal(readOutcome(normalizeText(text)), undefined, `«${text}»`);
    assert.equal(saysTried(normalizeText(text)), false, `«${text}»`);
  }
});

test('round 5.4: a verb of trying is the steps only with an object that means them or at the end of its clause; never another thing done, and never the printer', () => {
  for (const text of [
    'I tried printing again, still clogged',
    'tried restarting, still clogged',
    'I tried another spool, same problem',
    'I did a cold pull, still clogged',
    'i did see them but still clogged',
    'it did that again, still clogged',
    'the printer did that again, still clogged',
    'still clogged, it did it again',
    'did that help? no, still clogged',
    'حاولت اطبع بس نفس المشكله',
    'جربت اطبع وبعدها مسدودة',
    'سويت تنظيف للنوزل وبعده مسدود',
  ]) {
    assert.equal(saysTried(normalizeText(text)), false, `«${text}»`);
    assert.equal(understand(text).triedSaid, false, `«${text}»`);
  }
  for (const text of [
    'tried them, still clogged',
    'I tried, still clogged',
    'tried everything, still clogged',
    'I tried the steps, still clogged',
    'I did that, still clogged',
    'done that, still clogged',
    'جربت الخطوات وما زبطت',
    'جربت بس نفس المشكله',
    'سويت كلشي وما زبطت',
    'تاقیم کردەوە، هێشتا گیراوە',
  ]) {
    assert.equal(saysTried(normalizeText(text)), true, `«${text}»`);
    assert.equal(understand(text).triedSaid, true, `«${text}»`);
  }
});

test('round 5.4: in Sorani the object comes before the verb: «هەموویم تاقی کردەوە» is the steps tried, «فیلامێنتێکی ترم تاقی کردەوە» is not', () => {
  for (const text of [
    'فیلامێنتێکی ترم تاقی کردەوە، هێشتا گیراوە',
    'دووبارە تاقیم کردەوە، هێشتا گیراوە',
    'سپوڵێکی ترم تاقی کردەوە بەڵام هێشتا',
  ]) {
    assert.equal(saysTried(normalizeText(text)), false, `«${text}»`);
    assert.equal(understand(text).triedSaid, false, `«${text}»`);
  }
  for (const text of [
    'هەموویم تاقی کردەوە، هێشتا گیراوە',
    'هەنگاوەکانم تاقی کردەوە، هێشتا گیراوە',
    'ئەوانەم تاقی کردەوە بەڵام هێشتا',
    'تاقیم کردەوە بەڵام هێشتا',
  ]) {
    assert.equal(saysTried(normalizeText(text)), true, `«${text}»`);
    assert.equal(understand(text).triedSaid, true, `«${text}»`);
  }
});

test('round 5.4: "after" in Sorani, the not-tried forms «بعدني ما» used to cover, «وبعدها مسدودة», and English questions and demonstratives', () => {
  // «دوای ئەوەی» (after): Sorani carries no negation there to mistake.
  for (const text of ['دوای ئەوەی تاقیم کردنەوە، هێشتا گیراوە']) {
    assert.equal(readOutcome(normalizeText(text)), 'not_fixed', `«${text}»`);
    assert.equal(saysTried(normalizeText(text)), true, `«${text}»`);
  }
  // Steps not tried stay without an outcome, with «بعدني ما» out of the list.
  for (const text of ['بعدني ما سويتهم بس نفس المشكلة', 'بعدني ما طبقتهم', 'ما جربتهن وبعده مسدود']) {
    assert.equal(readOutcome(normalizeText(text)), undefined, `«${text}»`);
    assert.equal(saysTried(normalizeText(text)), false, `«${text}»`);
  }
  // «بعد ما» before a verb that is not one of trying keeps its negation: «بعد ما انحلت» is still not fixed.
  assert.equal(readOutcome(normalizeText('بعد ما انحلت')), 'not_fixed');
  // The conjunction glued on: «وبعدها مسدودة» is «بعدها مسدودة».
  for (const text of ['جربت اطبع وبعدها مسدودة', 'وبعده مسدود']) assert.equal(readOutcome(normalizeText(text)), 'not_fixed', `«${text}»`);
  for (const text of ['did it work? no, still clogged', 'I tried that new filament, still clogged', 'I did that new firmware update, still clogged', "it's done that again, still clogged"]) {
    assert.equal(saysTried(normalizeText(text)), false, `«${text}»`);
  }
  for (const text of ['I did that again, still clogged', 'did them all, still clogged', 'I followed your instructions, still clogged', 'went through the steps, still clogged']) {
    assert.equal(saysTried(normalizeText(text)), true, `«${text}»`);
  }
});
