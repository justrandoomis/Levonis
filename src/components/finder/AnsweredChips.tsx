import React from 'react';
import type { FinderAnswers } from '../../../packages/catalog/src/discovery';
import { answerChipLabel, finderUi, type FinderLang } from './strings';
import type { StepKey } from './flow';

/**
 * The answers so far, as small chips (mockup 6). Tapping one goes back to that
 * question; the chip says what it is and what tapping does.
 */
export default function AnsweredChips({
  answers,
  keys,
  lang,
  onEdit,
  trailing,
}: {
  answers: FinderAnswers;
  keys: StepKey[];
  lang: FinderLang;
  onEdit: (key: StepKey) => void;
  /** Placed after the chips (the results' «تعديل»). */
  trailing?: React.ReactNode;
}) {
  const ui = finderUi(lang);
  const chips = keys
    .map((key) => ({ key, label: answerChipLabel(key, answers, lang) }))
    .filter((c): c is { key: StepKey; label: string } => !!c.label);
  if (chips.length === 0 && !trailing) return null;
  return (
    <ul aria-label={ui.answered} className="flex flex-wrap gap-2">
      {chips.map((c) => (
        <li key={c.key}>
          <button
            type="button"
            onClick={() => onEdit(c.key)}
            aria-label={ui.editAnswer(c.label)}
            className="inline-flex min-h-9 items-center rounded-full bg-surface-selected px-3.5 text-[13px] font-semibold text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus lv-hit relative"
          >
            <bdi>{c.label}</bdi>
          </button>
        </li>
      ))}
      {trailing ? <li>{trailing}</li> : null}
    </ul>
  );
}
