/**
 * «مرشد الطابعات» — THE STEP MACHINE, PURE (docs/ux/CATALOG_DISCOVERY.md §3.4, §8).
 *
 * THE URL IS THE STATE. The six answers are the finder grammar
 * (src/lib/finder/answers.ts); the question on screen is one more key, `step`
 * (1–6), so a refresh on question 4 is question 4 with the first three still
 * answered. With every answer present and no `step`, the page is the results.
 *
 * The rules, all here so tests/finderFlowModel.test.ts can walk them:
 *
 *   - A step can be shown only once every step before it could have been
 *     reached: `step` is clamped to the first unanswered question.
 *   - Answering moves to the NEXT UNANSWERED question after this one, else the
 *     first unanswered anywhere, else the results. So editing one answer from
 *     the results (or from a chip) goes straight back to where the visitor was,
 *     not through every question again.
 *   - Skipping is an answer (tech `any`, budget `any`, priorities `[]`), only on
 *     the three skippable questions (2, 3, 5).
 *   - Back goes to the previous QUESTION, never the previous page; there is no
 *     back on question 1 (the ✕ is the way out).
 *   - Priorities are ORDERED and at most two; a third tap is refused, not
 *     silently swapped, and the page says why.
 */
import {
  FINDER_KEYS,
  MAX_FINDER_PRIORITIES,
  parseAnswers,
  serializeAnswers,
} from '../../lib/finder/answers';
import type { FinderAnswers, FinderPriority } from '../../../packages/catalog/src/discovery';

export type StepKey = (typeof FINDER_KEYS)[number];

export const STEPS: readonly StepKey[] = FINDER_KEYS;
export const STEP_COUNT = STEPS.length;

/** Questions 2, 3 and 5 (§8 table). */
export const SKIPPABLE: Readonly<Record<StepKey, boolean>> = Object.freeze({
  use: false,
  tech: true,
  budget: true,
  sale: false,
  prio: true,
  level: false,
});

/** Single-choice steps advance on their own after a tap; priorities wait for «التالي». */
export const AUTO_ADVANCE: Readonly<Record<StepKey, boolean>> = Object.freeze({
  use: true,
  tech: true,
  budget: true,
  sale: true,
  prio: false,
  level: true,
});

/** The pause between a tap and the next question — long enough to see the check. */
export const AUTO_ADVANCE_MS = 220;

export type FinderView = { kind: 'step'; index: number } | { kind: 'results' };

export const isAnswered = (a: FinderAnswers, key: StepKey): boolean => a[key] !== null;

/** The index of the first unanswered question, or -1 when all six are answered. */
export function firstUnanswered(a: FinderAnswers): number {
  return STEPS.findIndex((k) => !isAnswered(a, k));
}

/** `step=` → 0-based index, or null. Anything but 1…6 is ignored. */
export function parseStepParam(raw: string | null | undefined): number | null {
  if (!raw || !/^[1-9]$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= STEP_COUNT ? n - 1 : null;
}

/** What the page shows for these answers and this `step`. */
export function resolveView(a: FinderAnswers, stepParam: number | null): FinderView {
  const gap = firstUnanswered(a);
  if (stepParam === null) return gap === -1 ? { kind: 'results' } : { kind: 'step', index: gap };
  // A question past an unanswered one cannot be on screen yet.
  const reachable = gap === -1 ? STEP_COUNT - 1 : gap;
  return { kind: 'step', index: Math.min(stepParam, reachable) };
}

/** Where to go after question `index` is answered (or skipped). */
export function nextView(a: FinderAnswers, index: number): FinderView {
  for (let i = index + 1; i < STEP_COUNT; i++) if (!isAnswered(a, STEPS[i])) return { kind: 'step', index: i };
  const gap = firstUnanswered(a);
  return gap === -1 ? { kind: 'results' } : { kind: 'step', index: gap };
}

/** The previous question, or null on the first. */
export function backView(index: number): FinderView | null {
  return index > 0 ? { kind: 'step', index: index - 1 } : null;
}

/** Answers with one question answered. */
export function answer<K extends StepKey>(a: FinderAnswers, key: K, value: FinderAnswers[K]): FinderAnswers {
  return { ...a, [key]: value };
}

/** A skip, as the answer it stands for — or the answers unchanged on a step that cannot be skipped. */
export function skip(a: FinderAnswers, key: StepKey): FinderAnswers {
  if (!SKIPPABLE[key]) return a;
  if (key === 'tech') return { ...a, tech: 'any' };
  if (key === 'budget') return { ...a, budget: 'any' };
  if (key === 'prio') return { ...a, prio: [] };
  return a;
}

/**
 * One tap on a priority. Ordered, at most two: tapping a chosen one removes it
 * (the other moves up to first), tapping a third is REFUSED.
 */
export function togglePriority(
  current: readonly FinderPriority[] | null,
  p: FinderPriority
): { prio: FinderPriority[]; refused: boolean } {
  const list = [...(current ?? [])];
  const at = list.indexOf(p);
  if (at >= 0) {
    list.splice(at, 1);
    return { prio: list, refused: false };
  }
  if (list.length >= MAX_FINDER_PRIORITIES) return { prio: list, refused: true };
  list.push(p);
  return { prio: list, refused: false };
}

/** Whether «التالي» may be pressed on this question. */
export function canContinue(a: FinderAnswers, key: StepKey): boolean {
  if (key === 'prio') return (a.prio?.length ?? 0) > 0;
  return isAnswered(a, key);
}

/** The steps answered BEFORE `index`, for the chips above the question. */
export function answeredBefore(a: FinderAnswers, index: number): StepKey[] {
  return STEPS.slice(0, Math.max(0, index)).filter((k) => isAnswered(a, k));
}

/** The query string (no `?`) for answers and a view. Results carry no `step`. */
export function finderSearch(a: FinderAnswers, view: FinderView): string {
  const base = serializeAnswers(a);
  if (view.kind === 'results') return base;
  const step = `step=${view.index + 1}`;
  return base ? `${base}&${step}` : step;
}

/** Answers and view from a query string. */
export function readFinderUrl(search: string): { answers: FinderAnswers; view: FinderView } {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const answers = parseAnswers(params);
  return { answers, view: resolveView(answers, parseStepParam(params.get('step'))) };
}

/** How many answers there are — the ✕ asks before leaving only after three. */
export function answeredCount(a: FinderAnswers): number {
  return STEPS.filter((k) => isAnswered(a, k)).length;
}

export const LEAVE_CONFIRM_AFTER = 3;
