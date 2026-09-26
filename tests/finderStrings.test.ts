/**
 * «مرشد الطابعات» — THE COPY (catalog discovery S6b;
 * src/components/finder/strings.ts).
 *
 * The server says codes plus values; this table is the only place they become
 * words. Pinned here:
 *   - every reason code, on every field the engine may quote it from, has
 *     Arabic AND English copy, and every caveat code and relaxation too;
 *   - an unknown code, or a reason with no value, renders NOTHING (null) —
 *     a sentence is never invented;
 *   - the engine's real output over the live catalogue renders completely:
 *     no reason or caveat it can produce is left without copy;
 *   - Sorani is never machine-written (ckb reads the Arabic, DECISIONS row 11).
 *
 * Run: node --import tsx --test tests/finderStrings.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ROOT } from './fixtures/d1';
import { liveCandidates } from './fixtures/finderCandidates';
import { runFinder } from '../worker/lib/printerFinder';
import {
  FINDER_BUDGET_IDS,
  FINDER_LEVELS,
  FINDER_PRIORITIES,
  FINDER_SALES,
  FINDER_TECHS,
  FINDER_USES,
  parseAnswers,
} from '../src/lib/finder/answers';
import {
  REASON_CODES,
  REASON_FIELDS_BY_CODE,
  answerChipLabel,
  caveatCopy,
  coverageLabel,
  finderUi,
  printersCount,
  question,
  reasonCopy,
  relaxationLabel,
  resultsUi,
  specValue,
} from '../src/components/finder/strings';
import ReasonList from '../src/components/finder/ReasonList';
import type { FinderCriterion } from '../packages/catalog/src/discoveryTypes';

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const LANGS = ['ar', 'en'] as const;
const hasArabic = (s: string) => /[؀-ۿ]/.test(s);

/** A value the engine could plausibly quote for this field (readCompareValue text). */
const SAMPLE: Record<string, string> = {
  print_speed: '1,000 mm/s',
  max_acceleration: '20,000 mm/s²',
  max_colors: '25',
  min_layer_height: '0.04 mm',
  xy_resolution: '19 µm',
  noise_level: '48 dB',
  skill_level: 'Beginner',
  assembly: 'Pre-assembled',
  auto_leveling: 'Yes',
  build_volume: '340 × 320 × 340 mm',
  chamber_temp_max: '65 °C',
  enclosed: 'Yes',
  bed_temp_max: '120 °C',
  print_failure_detection: 'Yes',
  warranty: '12 months',
  filament_sensor: 'Yes',
  use_cases: 'business, products to sell',
};

test('EVERY reason code × field the engine can quote has Arabic and English copy', () => {
  for (const code of REASON_CODES) {
    const fields = code === 'in_stock' || code === 'in_budget' ? [''] : REASON_FIELDS_BY_CODE[code as FinderCriterion];
    for (const field_id of fields) {
      for (const lang of LANGS) {
        const c = reasonCopy({ code, field_id, value_text: field_id ? SAMPLE[field_id] : '', units: 2 }, lang);
        assert.ok(c, `${code}/${field_id} has no ${lang} copy`);
        assert.ok(c!.text.length > 3);
        assert.equal(hasArabic(c!.text), lang === 'ar', `${code}/${field_id} ${lang} is in the wrong script`);
        if (c!.text.includes('{v}')) assert.ok(c!.value, `${code}/${field_id} has a slot but no value`);
      }
    }
  }
});

test('the engine’s REASON_FIELDS and this table agree (a drift would drop a reason silently)', () => {
  const engine = read('worker/lib/printerFinder.ts');
  const block = /const REASON_FIELDS: Record<FinderCriterion, string\[\]> = \{([\s\S]*?)\n\};/.exec(engine)?.[1] ?? '';
  for (const [code, fields] of Object.entries(REASON_FIELDS_BY_CODE)) {
    const line = new RegExp(`${code}: \\[([^\\]]*)\\]`).exec(block)?.[1] ?? '';
    const listed = [...line.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    assert.deepEqual(listed, fields, `REASON_FIELDS.${code} changed in the engine`);
  }
});

test('NEVER INVENTED: an unknown code, an unknown field, or a missing value renders nothing', () => {
  for (const lang of LANGS) {
    assert.equal(reasonCopy({ code: 'made_up', field_id: 'print_speed', value_text: '1 mm/s' }, lang), null);
    assert.equal(reasonCopy({ code: 'speed', field_id: 'made_up', value_text: '1' }, lang), null);
    assert.equal(reasonCopy({ code: 'speed', field_id: 'print_speed', value_text: '' }, lang), null);
    // A boolean reason is only said when the sheet says Yes.
    assert.equal(reasonCopy({ code: 'durable', field_id: 'enclosed', value_text: 'No' }, lang), null);
    assert.equal(caveatCopy({ code: 'weak', criterion: 'speed', field_id: 'print_speed', value_text: '' }, lang), null);
    assert.equal(caveatCopy({ code: 'nope' } as never, lang), null);
  }
});

test('every caveat code and relaxation label has copy in both languages', () => {
  for (const lang of LANGS) {
    for (const r of ['budget_plus_20', 'allow_preorder', 'any_tech'] as const) {
      assert.ok(relaxationLabel(r, lang));
      assert.ok(caveatCopy({ code: 'relaxed', relaxation: r }, lang));
    }
    assert.ok(caveatCopy({ code: 'professional' }, lang));
    for (const p of FINDER_PRIORITIES) {
      const field = { quality: 'min_layer_height', speed: 'print_speed', quiet: 'noise_level', colors: 'max_colors', ease: 'skill_level', size: 'build_volume' }[p];
      assert.ok(caveatCopy({ code: 'missing', criterion: p, field_id: field }, lang), `missing ${p}`);
      assert.ok(caveatCopy({ code: 'weak', criterion: p, field_id: field, value_text: SAMPLE[field] }, lang), `weak ${p}`);
      assert.ok(coverageLabel(field, p, lang));
    }
  }
  assert.equal(caveatCopy({ code: 'missing', criterion: 'quiet', field_id: 'noise_level' }, 'ar')!.text, 'مستوى الضجيج غير مذكور لهذه الطابعة');
  assert.equal(reasonCopy({ code: 'speed', field_id: 'print_speed', value_text: '1,000 mm/s', top: true }, 'ar')!.suffix, '— الأفضل بين الخيارات');
});

test('THE ENGINE’S REAL OUTPUT over the live catalogue renders completely', () => {
  const answerSets = [
    'use=business&tech=fdm&budget=1250000-2500000&sale=any&prio=speed,colors&level=intermediate',
    'use=hobby&tech=any&budget=any&sale=direct&prio=quiet&level=beginner',
    'use=figures&tech=fdm&budget=0-750000&sale=direct&prio=quality,ease&level=beginner',
    'use=functional&tech=any&budget=2500000-&sale=any&prio=size&level=pro',
    'use=multicolor&tech=fdm&budget=750000-1250000&sale=any&prio=colors,quiet&level=intermediate',
    'use=sell&tech=any&budget=any&sale=any&prio=none&level=pro',
    'use=unsure&tech=any&budget=any&sale=direct&prio=ease,speed&level=beginner',
  ];
  let reasons = 0;
  let caveats = 0;
  for (const q of answerSets) {
    const out = runFinder(liveCandidates(), parseAnswers(q));
    assert.ok(out.results.length > 0, q);
    for (const r of out.results) {
      for (const x of r.reasons) {
        reasons++;
        for (const lang of LANGS) assert.ok(reasonCopy(x, lang), `${q}: reason ${JSON.stringify(x)} has no ${lang} copy`);
      }
      for (const x of r.caveats) {
        caveats++;
        for (const lang of LANGS) assert.ok(caveatCopy(x, lang), `${q}: caveat ${JSON.stringify(x)} has no ${lang} copy`);
      }
    }
  }
  assert.ok(reasons > 10 && caveats > 0, `${reasons} reasons, ${caveats} caveats`);
});

test('RENDERING FROM CODES: the list draws exactly the reasons and caveats it was given, values isolated LTR', () => {
  const out = runFinder(liveCandidates(), parseAnswers('use=business&tech=fdm&budget=1250000-2500000&sale=any&prio=speed,colors&level=intermediate'));
  const top = out.results[0];
  const html = renderToStaticMarkup(
    createElement(ReasonList, { reasons: top.reasons, caveats: top.caveats, lang: 'ar', maxReasons: 3, maxCaveats: 1, watchLabel: 'انتبه' })
  );
  assert.equal((html.match(/data-reason/g) ?? []).length, Math.min(3, top.reasons.length));
  assert.equal((html.match(/data-caveat/g) ?? []).length, Math.min(1, top.caveats.length));
  assert.match(html, /<bdi dir="ltr"[^>]*>1,000 mm\/s<\/bdi>/, 'a spec value sits in an LTR isolate');
  // A code the table does not know is skipped, not paraphrased.
  const junk = renderToStaticMarkup(
    createElement(ReasonList, { reasons: [{ code: 'magic', field_id: 'x', value_text: 'y', top: false } as never], caveats: [], lang: 'ar', maxReasons: 3 })
  );
  assert.equal(junk, '');
  // The row prefers a spec reason over «متوفرة الآن» (the availability line says that).
  const row = renderToStaticMarkup(
    createElement(ReasonList, {
      reasons: [
        { code: 'in_stock', field_id: '', value_text: '', top: false, units: 2 },
        { code: 'size', field_id: 'build_volume', value_text: '340 × 320 × 340 mm', top: true },
      ],
      caveats: [],
      lang: 'ar',
      maxReasons: 1,
      specFirst: true,
    })
  );
  assert.match(row, /حجم طباعة/);
  assert.doesNotMatch(row, /متوفرة الآن/);
});

test('every question and option has copy; the chips name every answer', () => {
  for (const lang of LANGS) {
    for (const k of ['use', 'tech', 'budget', 'sale', 'prio', 'level'] as const) {
      assert.ok(question(k, lang).title.endsWith(lang === 'ar' ? '؟' : '?'));
    }
    for (const u of FINDER_USES) assert.ok(answerChipLabel('use', { use: u, tech: null, budget: null, sale: null, prio: null, level: null }, lang));
    for (const t of FINDER_TECHS) assert.ok(answerChipLabel('tech', { use: null, tech: t, budget: null, sale: null, prio: null, level: null }, lang));
    for (const b of FINDER_BUDGET_IDS) assert.ok(answerChipLabel('budget', { use: null, tech: null, budget: b, sale: null, prio: null, level: null }, lang));
    for (const s of FINDER_SALES) assert.ok(answerChipLabel('sale', { use: null, tech: null, budget: null, sale: s, prio: null, level: null }, lang));
    for (const l of FINDER_LEVELS) assert.ok(answerChipLabel('level', { use: null, tech: null, budget: null, sale: null, prio: null, level: l }, lang));
  }
  const two = { use: null, tech: null, budget: null, sale: null, prio: ['speed', 'colors'] as const, level: null };
  assert.equal(answerChipLabel('prio', { ...two, prio: [...two.prio] }, 'ar'), 'السرعة، ثم تعدد الألوان');
  assert.equal(answerChipLabel('prio', { ...two, prio: [] }, 'ar'), 'بلا أولوية');
  assert.equal(answerChipLabel('use', { ...two, prio: null }, 'ar'), null);
});

test('Arabic counts, titles and the known spec vocabulary', () => {
  assert.deepEqual([0, 1, 2, 4, 10, 11].map((n) => printersCount(n, 'ar')), ['لا توجد طابعات', 'طابعة واحدة', 'طابعتان', '4 طابعات', '10 طابعات', '11 طابعة']);
  const t = resultsUi('ar');
  assert.deepEqual([1, 2, 3, 4].map(t.title), ['أنسب طابعة لك', 'أفضل طابعتين لك', 'أفضل 3 طابعات لك', 'أفضل 4 طابعات لك']);
  assert.equal(t.compareAll(3), 'قارن الطابعات الثلاث');
  assert.equal(specValue('Beginner', 'ar'), 'مبتدئ');
  assert.equal(specValue('Pre-assembled', 'ar'), 'مجمّعة بالكامل');
  assert.equal(specValue('Some Other Value', 'ar'), 'Some Other Value', 'an unknown value is shown as typed');
  assert.equal(finderUi('ar').stepOf(2, 6), 'السؤال 2 من 6');
});

test('SORANI IS NEVER MACHINE-WRITTEN: ckb reads the Arabic, and the files say so', () => {
  assert.equal(finderUi('ckb'), finderUi('ar'));
  assert.equal(resultsUi('ckb'), resultsUi('ar'));
  assert.deepEqual(reasonCopy({ code: 'speed', field_id: 'print_speed', value_text: '1 mm/s' }, 'ckb'), reasonCopy({ code: 'speed', field_id: 'print_speed', value_text: '1 mm/s' }, 'ar'));
  for (const f of ['src/components/finder/strings.ts', 'src/components/compare/lensStrings.ts']) {
    assert.match(read(f), /OWNER: Sorani to be written by hand\./, `${f} lacks the OWNER marker`);
  }
});
