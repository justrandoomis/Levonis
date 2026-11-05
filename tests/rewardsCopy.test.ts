/**
 * THE REWARDS AREA'S WORDS (rewards spec §8, §11). Every string of /rewards and
 * its pages lives in src/components/rewards/copy.ts, in Arabic, English and
 * Sorani, and the Sorani is its own (DECISIONS row 183: a ckb slot never
 * carries the Arabic or the English, nor an Arabic-only letter). Counted
 * sentences fill their figure in every form; the policy sentences the area
 * must say are pinned; and nothing reads as a game of luck (DECISIONS row 25,
 * policies 15.4 and 15.9: the Levonis team chooses the winners), the one luck
 * word being the 15.4 negation in `facts.chosen`.
 *
 * Run: node --import tsx --test tests/rewardsCopy.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  COPY,
  COUNTED,
  ORDINAL,
  POINTS_OBJ_KEYS,
  copyParts,
  copyText,
  countText,
  countedForm,
  ordinal,
  pointsForm,
  type CopyKey,
  type Counted,
  type CountedKey,
} from '../src/components/rewards/copy';
import { formatDayMonth } from '../src/components/orders/format';
import { formatFigure } from '../src/lib/localeNumber';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const LANGS = ['ar', 'en', 'ckb'] as const;

const entries = Object.entries(COPY) as Array<[CopyKey, readonly [string, string, string]]>;
const counted = Object.entries(COUNTED) as Array<[CountedKey, Counted]>;
const formsOf = (c: Counted) => ({ ar: Object.values(c.ar), en: Object.values(c.en), ckb: Object.values(c.ckb) });

/** The marks a string asks the screen to fill. */
const marks = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

const ARABIC_ONLY = /[ةىيك]/;
const SORANI_LETTER = /[ڕڵۆێەپچژگڤکی]/;

/**
 * Row 183 as the house's string tests hold it (adminSecurity,
 * creativeStudioUiStrings): a Sorani string has no Arabic-only letter, is not
 * the English, and words of any length have a Sorani letter. Its marks aside:
 * «تا {money}» is one short word.
 */
function soraniFaults(where: string, ckb: string, en: readonly string[]): string[] {
  const out: string[] = [];
  if (ARABIC_ONLY.test(ckb)) out.push(`${where}: an Arabic-only letter in «${ckb}»`);
  if (en.includes(ckb)) out.push(`${where}: ckb = en «${ckb}»`);
  const words = ckb.replace(/\{\w+\}/g, '').trim();
  if (words.length > 8 && !SORANI_LETTER.test(words)) out.push(`${where}: no Sorani letter in «${ckb}»`);
  return out;
}

test('every rewards string has three non-empty slots, and the Sorani is its own: not the Arabic, not the English, no Arabic-only letter', () => {
  const bad: string[] = [];
  for (const [k, v] of entries) {
    if (v.length !== 3 || v.some((x) => !x.trim())) bad.push(`${k}: empty slot`);
    else if (v[2] === v[0]) bad.push(`${k}: ckb = ar`);
    else bad.push(...soraniFaults(k, v[2], [v[1]]));
  }
  assert.deepEqual(bad, []);
  assert.ok(entries.length >= 180, `the hub, four pages, the detail and the entry sheet (${entries.length} keys)`);
});

test('the three languages of a string ask for the same values', () => {
  const bad = entries.filter(([, [ar, en, ckb]]) => marks(ar).join() !== marks(en).join() || marks(ar).join() !== marks(ckb).join()).map(([k]) => k);
  assert.deepEqual(bad, []);
});

test('every counted form is written in each language, and no Sorani form is an Arabic or an English one', () => {
  const bad: string[] = [];
  for (const [k, c] of counted) {
    const f = formsOf(c);
    if (f.ar.length !== 6 || f.en.length !== 3 || f.ckb.length !== 2) bad.push(`${k}: form count`);
    for (const lang of LANGS) for (const s of f[lang]) if (!s.trim()) bad.push(`${k}.${lang}: empty form`);
    for (const s of f.ckb) if (f.ar.includes(s)) bad.push(`${k}: ckb «${s}» is an Arabic form`);
    for (const s of f.ckb) bad.push(...soraniFaults(`${k}.ckb`, s, f.en));
    // A figure past two is always shown: Arabic 3–10 / 11–99 / 100+, English and Sorani «other».
    for (const s of [c.ar.few, c.ar.many, c.ar.hundred, c.en.other, c.ckb.other]) if (!s.includes('{n}')) bad.push(`${k}: «${s}» drops the figure`);
  }
  assert.deepEqual(bad, []);
});

test('ORDINAL names ten places in each language, the Sorani its own', () => {
  for (const lang of LANGS) {
    assert.equal(ORDINAL[lang].length, 10, lang);
    assert.ok(ORDINAL[lang].every((s) => s.trim()), lang);
  }
  ORDINAL.ckb.forEach((s, i) => {
    assert.notEqual(s, ORDINAL.ar[i], `place ${i + 1}`);
    assert.deepEqual(soraniFaults(`place ${i + 1}`, s, [ORDINAL.en[i]]), []);
  });
  assert.equal(ordinal(2, 'ar'), 'الثاني');
  assert.equal(ordinal(1, 'en'), '1st');
  assert.equal(ordinal(3, 'en'), '3rd');
  assert.equal(ordinal(10, 'ckb'), 'دەیەم');
  // Past the tenth (the server names at most ten), the figure, with English's suffix.
  assert.equal(ordinal(11, 'en'), `${formatFigure(11, 'en')}th`);
  assert.equal(ordinal(12, 'en'), `${formatFigure(12, 'en')}th`);
  assert.equal(ordinal(21, 'en'), `${formatFigure(21, 'en')}st`);
  assert.equal(ordinal(23, 'en'), `${formatFigure(23, 'en')}rd`);
  assert.equal(ordinal(11, 'ar'), formatFigure(11, 'ar'));
});

test('countText fills {n} in EVERY form with formatFigure — the Arabic zero, one and two too', () => {
  const left: string[] = [];
  for (const [k, c] of counted) {
    for (const lang of LANGS) {
      for (const n of [0, 1, 2, 3, 10, 11, 99, 100, 101, 103, 111, 1234, 25000]) {
        const out = countText(k, n, lang);
        const form = countedForm(c, n, lang);
        if (out.includes('{n}')) left.push(`${k}.${lang}(${n})`);
        if (form.includes('{n}') && out !== form.replace(/\{n\}/g, formatFigure(n, lang))) left.push(`${k}.${lang}(${n}) not formatFigure`);
      }
    }
  }
  assert.deepEqual(left, []);
  // The house countedText would leave «{n} نقطة» unfilled for 0.
  assert.equal(countText('points', 0, 'ar'), `${formatFigure(0, 'ar')} نقطة`);
  assert.equal(countText('points', 1234, 'en'), `${formatFigure(1234, 'en')} points`);
  assert.equal(countText('points', 7, 'ar', '٧'), '٧ نقاط', 'the caller may pass the figure as shown');
});

test('the Arabic count takes its dual, its plurals and its oblique form', () => {
  const ar = (k: CountedKey, n: number) => countText(k, n, 'ar');
  assert.equal(ar('points', 1), 'نقطة واحدة');
  assert.equal(ar('points', 2), 'نقطتان');
  assert.equal(ar('pointsObj', 2), 'نقطتين');
  assert.equal(ar('points', 3), `${formatFigure(3, 'ar')} نقاط`);
  assert.equal(ar('points', 10), `${formatFigure(10, 'ar')} نقاط`);
  assert.equal(ar('points', 11), `${formatFigure(11, 'ar')} نقطة`);
  assert.equal(ar('points', 103), `${formatFigure(103, 'ar')} نقاط`);
  assert.equal(ar('daysLeft', 0), 'آخر يوم');
  assert.equal(ar('daysLeft', 14), `${formatFigure(14, 'ar')} يومًا متبقيًا`);
  assert.equal(ar('spotsLeft', 3), `بقيت ${formatFigure(3, 'ar')} أماكن`);
  assert.equal(ar('moreProducts', 2), 'ومنتجان آخران');
  assert.equal(countText('daysLeft', 0, 'ckb'), 'دوایین ڕۆژ');
  assert.equal(countText('days', 7, 'ckb'), `${formatFigure(7, 'ckb')} ڕۆژ`);
  assert.equal(countText('entrants', 1, 'en'), '1 entrant');
});

test('copyText fills marks, keeps a mark it was not given, and copyParts cuts at the marks', () => {
  assert.equal(copyText('row.closes', 'ar', { date: '17 تشرين الثاني' }), 'تُغلق في 17 تشرين الثاني');
  assert.equal(copyText('entrants.of', 'en', { n: 37, max: 50 }), '37 of 50');
  assert.equal(copyText('row.closes', 'en', {}), 'Closes {date}');
  assert.deepEqual(copyParts('hub.pending', 'ar'), [{ slot: 'points' }, { text: ' في الطريق' }]);
  assert.deepEqual(copyParts('shop.balance', 'en'), [{ text: 'Your balance: ' }, { slot: 'points' }]);
  assert.deepEqual(copyParts('back', 'ckb'), [{ text: 'گەڕانەوە' }]);
});

test('the † keys take the oblique «نقطتين», and each asks for {points}', () => {
  assert.deepEqual([...POINTS_OBJ_KEYS].sort(), ['cta.enterFee', 'door.shop.from', 'rate.noLevel', 'row.fee', 'sheet.sendFee', 'shop.confirm.title']);
  for (const k of POINTS_OBJ_KEYS) {
    assert.equal(pointsForm(k), 'pointsObj', k);
    for (const s of COPY[k]) assert.ok(s.includes('{points}'), `${k}: ${s}`);
  }
  assert.equal(pointsForm('hub.pending'), 'points');
  assert.equal(copyText('cta.enterFee', 'ar', { points: countText(pointsForm('cta.enterFee'), 2, 'ar') }), 'شارك بـ نقطتين');
});

test('the pinned sentences: the page name, the use button, and the policies the area must say', () => {
  assert.deepEqual([...COPY['title.home']], ['المكافآت', 'Rewards', 'خەڵاتەکان'], 'the page name the notices use');
  assert.equal(COPY['coupon.use'][0], 'استخدمه الآن');
  // 15.4: the team chooses; never by lot or by luck.
  assert.ok(COPY['facts.chosen'][0].includes('الفائزون يختارهم فريق Levonis'));
  assert.ok(COPY['facts.chosen'][0].includes('ولا تُحدَّد النتيجة بالقرعة ولا بالحظ'));
  // 14.10: points spent in the shop do not come back.
  assert.ok(COPY['shop.confirm.body'][0].includes('لا تعود النقاط إن انتهى الكوبون دون استخدام'));
  // 15.6 / 15.7: a paid entry is returned in full on a cancellation or a rejection.
  for (const k of ['sheet.fee', 'confirm.fee'] as const) assert.ok(COPY[k][0].includes('وتُعاد كاملة إن أُلغيت المسابقة أو لم تُقبل مشاركتك'), k);
  // 15.3: the entry is the customer's own work.
  assert.deepEqual([...COPY['sheet.ownWork']], [
    'يجب أن تكون المشاركة من عملك، والصورة لشيء طبعته أو صوّرته بنفسك.',
    'Your entry must be your own work, and the photo of something you printed or photographed yourself.',
    'بەشدارییەکەت دەبێت کاری خۆت بێت، و وێنەکە هی شتێک بێت کە خۆت چاپت کردووە یان وێنەت گرتووە.',
  ]);
  // 15.8: a winning entry is shown with the shortened name.
  assert.deepEqual([...COPY['sheet.public']], [
    'إن فزت، تُعرض مشاركتك — إجابتك وصورتك — مع اسمك المختصر في صفحة المسابقة.',
    "If you win, your entry — answer and photo — is shown with your shortened name on the competition's page.",
    'ئەگەر بیبەیتەوە، بەشدارییەکەت — وەڵام و وێنەکەت — لەگەڵ ناوە کورتکراوەکەت لە پەڕەی پێشبڕکێکەدا پیشان دەدرێت.',
  ]);
  // The review form's own field label, so the customer finds where the story goes.
  const [ar, en, ckb] = COPY['rate.step2'];
  assert.ok(ar.includes('«دليل ستوري إنستغرام (خاص)»'));
  assert.ok(en.includes('«Instagram story evidence (private)»'));
  assert.ok(ckb.includes('«بەڵگەی ستۆری ئینستاگرام (تایبەت)»'));
  // The handle keeps its isolates in the right-to-left languages (spec §7).
  for (const s of [ar, ckb]) assert.ok(s.includes('⁦@levonis_iq⁩'));
});

test('no rewards string reads as a game of luck — except the 15.4 negation in facts.chosen', () => {
  const AR = ['قرعة', 'يانصيب', 'الحظ', 'حظك', 'بالتوفيق', 'سحب عشوائي'];
  const EN = /\b(lotter(y|ies)|raffle|luck(y)?|chance|random draw|prize draw)\b/i;
  const CKB = ['تیروپشک', 'بەخت', 'شانس'];
  const hits: string[] = [];
  const check = (where: string, ar: readonly string[], en: readonly string[], ckb: readonly string[]) => {
    for (const s of ar) for (const w of AR) if (s.includes(w)) hits.push(`${where} ar «${w}»`);
    for (const s of en) if (EN.test(s)) hits.push(`${where} en «${s.match(EN)?.[0]}»`);
    for (const s of ckb) for (const w of CKB) if (s.includes(w)) hits.push(`${where} ckb «${w}»`);
  };
  for (const [k, [ar, en, ckb]] of entries) if (k !== 'facts.chosen') check(k, [ar], [en], [ckb]);
  for (const [k, c] of counted) {
    const f = formsOf(c);
    check(`COUNTED.${k}`, f.ar, f.en, f.ckb);
  }
  check('ORDINAL', ORDINAL.ar, ORDINAL.en, ORDINAL.ckb);
  assert.deepEqual(hits, []);
});

/** The area's files: src/pages/RewardsArea.tsx and everything under src/components/rewards. */
function areaFiles(): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(join(ROOT, rel))) {
      const child = `${rel}/${name}`;
      if (statSync(join(ROOT, child)).isDirectory()) walk(child);
      else if (/\.tsx?$/.test(name)) out.push(child);
    }
  };
  walk('src/components/rewards');
  if (existsSync(join(ROOT, 'src/pages/RewardsArea.tsx'))) out.push('src/pages/RewardsArea.tsx');
  return out;
}

/** `loc(...)` calls passing fewer than three languages. */
function shortLocCalls(rel: string): string[] {
  const src = ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true, rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'loc' && n.arguments.length < 3) {
      out.push(`${rel}:${src.getLineAndCharacterOfPosition(n.getStart()).line + 1}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
  return out;
}

test('the area writes Sorani itself: no two-language loc(), no ckb-IQ locale, no device date strings, no language ternary', () => {
  const files = areaFiles();
  for (const f of ['src/components/rewards/copy.ts', 'src/components/rewards/model.ts', 'src/components/rewards/useT.tsx']) assert.ok(files.includes(f), f);
  const bad: string[] = [];
  for (const f of files) {
    const src = read(f);
    bad.push(...shortLocCalls(f).map((at) => `${at} loc() without the Sorani`));
    if (/['"`]ckb-IQ/.test(src)) bad.push(`${f}: a ckb-IQ locale (Chromium falls back to the device's)`);
    if (src.includes('toLocaleDateString')) bad.push(`${f}: toLocaleDateString (orders/format.ts writes the dates)`);
    if (/lang\s*===\s*'(en|ar|ckb)'\s*\?/.test(src)) bad.push(`${f}: a lang === … ? ternary (Sorani falls into a branch)`);
  }
  assert.deepEqual(bad, []);
});

test('formatDayMonth: Sorani months by hand, Arabic and English from the house locales, Latin digits', () => {
  assert.equal(formatDayMonth('2026-11-14T12:00:00Z', 'ckb'), '14ی تشرینی دووەم');
  const ar = formatDayMonth('2026-11-14T12:00:00Z', 'ar');
  assert.ok(ar.includes('تشرين الثاني'), ar);
  assert.ok(ar.includes('14'), ar);
  assert.doesNotMatch(ar, /[٠-٩۰-۹]/, 'Latin digits, as on every other figure');
  assert.doesNotMatch(ar, /2026/, 'no year');
  assert.equal(formatDayMonth('2026-11-14T12:00:00Z', 'en'), '14 Nov');
  assert.equal(formatDayMonth('', 'ar'), '');
  assert.equal(formatDayMonth(null, 'en'), '');
  assert.equal(formatDayMonth('not a date', 'ckb'), '');
});
