/**
 * «مرشد الطابعات» — THE STEP MACHINE (catalog discovery S6b;
 * src/components/finder/flow.ts, docs/ux/CATALOG_DISCOVERY.md §3.4, §8).
 *
 * The URL is the state: six answers plus the question on screen (`step`). This
 * suite walks what the page does with them — which question shows, where an
 * answer, a skip, «رجوع» and an edit go, that a refresh on any step keeps the
 * answers, and the ordered two-priority rule.
 *
 * Run: node --import tsx --test tests/finderFlowModel.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import {
  AUTO_ADVANCE,
  SKIPPABLE,
  STEPS,
  answer,
  answeredBefore,
  answeredCount,
  backView,
  canContinue,
  finderSearch,
  firstUnanswered,
  nextView,
  parseStepParam,
  readFinderUrl,
  resolveView,
  skip,
  togglePriority,
} from '../src/components/finder/flow';
import { emptyAnswers, parseAnswers } from '../src/lib/finder/answers';

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const ALL = 'use=business&tech=fdm&budget=1250000-2500000&sale=any&prio=speed,colors&level=intermediate';

test('six questions in the documented order; 2, 3 and 5 can be skipped; priorities do not auto-advance', () => {
  assert.deepEqual([...STEPS], ['use', 'tech', 'budget', 'sale', 'prio', 'level']);
  assert.deepEqual(
    STEPS.filter((k) => SKIPPABLE[k]),
    ['tech', 'budget', 'prio']
  );
  assert.deepEqual(
    STEPS.filter((k) => !AUTO_ADVANCE[k]),
    ['prio']
  );
});

test('a fresh finder opens on question 1; all six answered opens on the results', () => {
  assert.deepEqual(readFinderUrl('').view, { kind: 'step', index: 0 });
  assert.deepEqual(readFinderUrl(`?${ALL}`).view, { kind: 'results' });
  // A skipped step is an answer, so it counts toward "complete".
  assert.deepEqual(readFinderUrl('use=hobby&tech=any&budget=any&sale=direct&prio=none&level=beginner').view, { kind: 'results' });
});

test('REFRESH ON ANY STEP keeps the answers and the question', () => {
  for (let i = 0; i < STEPS.length; i++) {
    const a = parseAnswers(ALL);
    const search = finderSearch(a, { kind: 'step', index: i });
    const back = readFinderUrl(`?${search}`);
    assert.deepEqual(back.answers, a, `answers lost on step ${i + 1}`);
    assert.deepEqual(back.view, { kind: 'step', index: i }, `question lost on step ${i + 1}`);
  }
  // The results carry no `step`.
  assert.equal(finderSearch(parseAnswers(ALL), { kind: 'results' }), ALL);
  assert.equal(finderSearch(emptyAnswers(), { kind: 'step', index: 0 }), 'step=1');
});

test('a step past an unanswered question cannot be shown: `step` is clamped', () => {
  const a = parseAnswers('use=business');
  assert.deepEqual(resolveView(a, 4), { kind: 'step', index: 1 });
  assert.deepEqual(resolveView(a, 0), { kind: 'step', index: 0 });
  assert.equal(parseStepParam('7'), null);
  assert.equal(parseStepParam('0'), null);
  assert.equal(parseStepParam('x'), null);
  assert.equal(parseStepParam('3'), 2);
  assert.deepEqual(readFinderUrl('?use=business&step=6').view, { kind: 'step', index: 1 });
});

test('answering moves to the next UNANSWERED question, else the results', () => {
  let a = emptyAnswers();
  a = answer(a, 'use', 'business');
  assert.deepEqual(nextView(a, 0), { kind: 'step', index: 1 });
  a = answer(a, 'tech', 'fdm');
  assert.deepEqual(nextView(a, 1), { kind: 'step', index: 2 });
  // Editing question 2 from the results goes straight back to the results.
  const done = parseAnswers(ALL);
  assert.deepEqual(nextView(answer(done, 'tech', 'any'), 1), { kind: 'results' });
  // Editing question 1 while 5 and 6 are still open goes to 5, not to 2.
  const partial = parseAnswers('use=hobby&tech=fdm&budget=any&sale=direct');
  assert.deepEqual(nextView(answer(partial, 'use', 'sell'), 0), { kind: 'step', index: 4 });
  // After the last question with a gap earlier, the gap is next.
  const gap = parseAnswers('use=hobby&budget=any&sale=direct&prio=none&level=pro');
  assert.deepEqual(nextView(gap, 5), { kind: 'step', index: 1 });
});

test('SKIP is an answer on 2, 3 and 5 only, and advances', () => {
  const a = parseAnswers('use=business');
  const t = skip(a, 'tech');
  assert.equal(t.tech, 'any');
  assert.equal(skip(parseAnswers('use=business&tech=fdm'), 'budget').budget, 'any');
  assert.deepEqual(skip(a, 'prio').prio, []);
  // Not skippable: unchanged.
  assert.deepEqual(skip(a, 'use'), a);
  assert.deepEqual(skip(a, 'sale'), a);
  assert.deepEqual(skip(a, 'level'), a);
  // A skipped priority serialises as `prio=none` and survives a refresh.
  const s = finderSearch(skip(parseAnswers('use=a'), 'prio'), { kind: 'step', index: 5 });
  assert.match(s, /prio=none/);
  assert.deepEqual(readFinderUrl(s).answers.prio, []);
  assert.equal(firstUnanswered(parseAnswers(ALL)), -1);
});

test('BACK goes to the previous question, never off question 1', () => {
  assert.equal(backView(0), null);
  assert.deepEqual(backView(1), { kind: 'step', index: 0 });
  assert.deepEqual(backView(5), { kind: 'step', index: 4 });
});

test('priorities: ordered, at most two, a third is refused (not swapped), a tap removes', () => {
  let r = togglePriority(null, 'speed');
  assert.deepEqual(r, { prio: ['speed'], refused: false });
  r = togglePriority(r.prio, 'colors');
  assert.deepEqual(r.prio, ['speed', 'colors']);
  const third = togglePriority(r.prio, 'quiet');
  assert.equal(third.refused, true);
  assert.deepEqual(third.prio, ['speed', 'colors']);
  // Removing the first moves the second up to first.
  assert.deepEqual(togglePriority(r.prio, 'speed').prio, ['colors']);
});

test('«التالي» needs an answer; on priorities it needs at least one pick', () => {
  const a = emptyAnswers();
  assert.equal(canContinue(a, 'use'), false);
  assert.equal(canContinue(answer(a, 'use', 'hobby'), 'use'), true);
  assert.equal(canContinue(answer(a, 'prio', []), 'prio'), false);
  assert.equal(canContinue(answer(a, 'prio', ['ease']), 'prio'), true);
});

test('the chips above a question are the answers before it; the ✕ asks only after three answers', () => {
  const a = parseAnswers('use=business&tech=fdm&budget=any&sale=any');
  assert.deepEqual(answeredBefore(a, 4), ['use', 'tech', 'budget', 'sale']);
  assert.deepEqual(answeredBefore(a, 0), []);
  assert.equal(answeredCount(a), 4);
  assert.equal(answeredCount(emptyAnswers()), 0);
  const page = read('src/pages/PrinterFinder.tsx');
  assert.match(page, /answeredCount\(answers\) >= LEAVE_CONFIRM_AFTER/);
  assert.match(page, /useConfirm\(\)/, 'the leave question is the shared ConfirmDialog, not window.confirm');
  assert.doesNotMatch(page, /window\.confirm|\balert\(/);
});

test('the page: URL replace per answer, keyboard presses do not auto-advance, focus moves to the question', () => {
  const page = read('src/pages/PrinterFinder.tsx');
  assert.match(page, /\{ replace: true, state: location\.state \}/, 'each answer replaces the query string');
  assert.match(page, /if \(viaPointer && AUTO_ADVANCE\[key\]\)/);
  assert.match(page, /heading\.current\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(read('src/components/finder/choiceKeys.ts'), /e\.detail > 0/);
  // A screen reader hears the step label change and the progress.
  assert.match(read('src/components/finder/FinderChrome.tsx'), /aria-live="polite"/);
  assert.match(read('src/components/finder/FinderProgress.tsx'), /role="progressbar"/);
});

test('the route is lazy and full-screen, with the tray gate mounted for refused adds', () => {
  const app = read('src/App.tsx');
  assert.match(app, /const PrinterFinder = React\.lazy\(\(\) => import\('\.\/pages\/PrinterFinder'\)\);/);
  assert.match(app, /'\/printer-finder'\]\.some\(p => pathForShell === p/);
  assert.match(app, /<Route path="\/printer-finder" element=\{<><PrinterFinder \/><CompareTrayGate \/><\/>\} \/>/);
});

test('a technology the shop does not sell puts support first, above the labelled alternatives', () => {
  const results = read('src/components/finder/FinderResults.tsx');
  assert.match(results, /data\.tech_matches === 0 && answers\.tech && answers\.tech !== 'any'/);
  assert.match(results, /data-support-first/);
  // Resin is hidden while there are none (owner Q4); Laser is shown dimmed with the reason (Q3).
  const step = read('src/components/finder/FinderStep.tsx');
  assert.match(step, /if \(t === 'resin' && !\(n && n > 0\) && chosen !== 'resin'\) continue;/);
  assert.match(step, /dimmedNote: \(t === 'laser' \|\| t === 'resin'\) && meta && n === 0/);
});
