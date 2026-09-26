import React, { forwardRef } from 'react';
import { FINDER_LEVELS, FINDER_PRIORITIES, FINDER_SALES, FINDER_USES } from '../../lib/finder/answers';
import type {
  FinderAnswers,
  FinderBudget,
  FinderLevel,
  FinderPriority,
  FinderSale,
  FinderTech,
  FinderUse,
} from '../../../packages/catalog/src/discovery';
import type { FinderMeta } from '../../../packages/catalog/src/discoveryTypes';
import ChoiceTiles from './ChoiceTiles';
import ChoiceRows, { type RowOption } from './ChoiceRows';
import BudgetOptions from './BudgetOptions';
import { LEVEL_ICON, PRIORITY_ICON, SALE_ICON, TECH_ICON, USE_ICON } from './icons';
import {
  LEVEL_COPY,
  PRIORITY_COPY,
  SALE_COPY,
  TECH_COPY,
  USE_COPY,
  finderUi,
  optionCopy,
  printersCount,
  question,
  type FinderLang,
} from './strings';
import type { StepKey } from './flow';

/**
 * WHICH TECHNOLOGIES ARE OFFERED (owner answers Q3, Q4):
 *   - Resin is HIDDEN while the shop has no Resin printer, and appears by
 *     itself when one is filed (the live count from `/meta`). It is kept on
 *     screen only if the link already chose it, so a shared answer still shows
 *     what was picked.
 *   - Laser (printers with a laser module + the laser root) is shown, and when
 *     there is none it is dimmed with the reason (§8: «shown honestly»).
 */
export function techOptions(meta: FinderMeta | null, chosen: FinderTech | null, lang: FinderLang): RowOption<FinderTech>[] {
  const ui = finderUi(lang);
  const out: RowOption<FinderTech>[] = [];
  for (const t of ['any', 'fdm', 'resin', 'laser'] as FinderTech[]) {
    const copy = optionCopy(TECH_COPY, t, lang);
    const n = t === 'any' ? null : meta ? meta.techs[t] : null;
    if (t === 'resin' && !(n && n > 0) && chosen !== 'resin') continue;
    out.push({
      value: t,
      title: copy.title,
      sub: copy.sub,
      Icon: TECH_ICON[t],
      ltrTitle: t !== 'any',
      meta: t === 'fdm' && typeof n === 'number' && n > 0 ? printersCount(n, lang) : undefined,
      dimmedNote: (t === 'laser' || t === 'resin') && meta && n === 0 ? ui.unavailableTech(copy.title) : undefined,
    });
  }
  return out;
}

interface Props {
  stepKey: StepKey;
  answers: FinderAnswers;
  meta: FinderMeta | null;
  lang: FinderLang;
  /** A single-choice answer; `viaPointer` false for a keyboard press (no auto-advance). */
  onSingle: (key: StepKey, value: string, viaPointer: boolean) => void;
  onPriority: (p: FinderPriority) => void;
  priorityRefused: boolean;
}

/** One question: its title (focus lands here), helper, and options. */
const FinderStep = forwardRef<HTMLHeadingElement, Props>(function FinderStep(
  { stepKey, answers, meta, lang, onSingle, onPriority, priorityRefused },
  headingRef
) {
  const q = question(stepKey, lang);
  const ui = finderUi(lang);
  const headingId = `finder-q-${stepKey}`;
  const helperId = `finder-h-${stepKey}`;

  let body: React.ReactNode = null;
  if (stepKey === 'use') {
    body = (
      <ChoiceTiles<FinderUse>
        labelledBy={headingId}
        value={answers.use}
        onChoose={(v, p) => onSingle('use', v, p)}
        options={FINDER_USES.map((u) => ({ value: u, ...optionCopy(USE_COPY, u, lang), Icon: USE_ICON[u], wide: u === 'unsure' }))}
      />
    );
  } else if (stepKey === 'tech') {
    body = (
      <ChoiceRows<FinderTech>
        labelledBy={headingId}
        mode="single"
        selected={answers.tech ? [answers.tech] : []}
        onChoose={(v, p) => onSingle('tech', v, p)}
        options={techOptions(meta, answers.tech, lang)}
      />
    );
  } else if (stepKey === 'budget') {
    body = (
      <BudgetOptions labelledBy={headingId} value={answers.budget} meta={meta} lang={lang} onChoose={(v: FinderBudget, p) => onSingle('budget', v, p)} />
    );
  } else if (stepKey === 'sale') {
    // «أريدها الآن» first: the owner's direct-sale priority.
    const order: FinderSale[] = ['direct', ...FINDER_SALES.filter((s) => s !== 'direct')];
    body = (
      <ChoiceRows<FinderSale>
        labelledBy={headingId}
        mode="single"
        selected={answers.sale ? [answers.sale] : []}
        onChoose={(v, p) => onSingle('sale', v, p)}
        options={order.map((s) => ({ value: s, ...optionCopy(SALE_COPY, s, lang), Icon: SALE_ICON[s] }))}
      />
    );
  } else if (stepKey === 'prio') {
    body = (
      <>
        <ChoiceRows<FinderPriority>
          labelledBy={headingId}
          mode="ordered"
          selected={answers.prio ?? []}
          onChoose={(v) => onPriority(v)}
          rankLabel={ui.priorityRank}
          options={FINDER_PRIORITIES.map((p) => ({ value: p, ...optionCopy(PRIORITY_COPY, p, lang), Icon: PRIORITY_ICON[p] }))}
        />
        <p
          aria-live="polite"
          className={`mt-3 min-h-5 text-[12.5px] leading-5 transition-colors ${priorityRefused ? 'font-semibold text-warning' : 'text-text-muted'}`}
        >
          {(answers.prio?.length ?? 0) >= 2 ? ui.priorityFull : ''}
        </p>
      </>
    );
  } else if (stepKey === 'level') {
    body = (
      <ChoiceRows<FinderLevel>
        labelledBy={headingId}
        mode="single"
        selected={answers.level ? [answers.level] : []}
        onChoose={(v, p) => onSingle('level', v, p)}
        options={FINDER_LEVELS.map((l) => ({ value: l, ...optionCopy(LEVEL_COPY, l, lang), Icon: LEVEL_ICON[l] }))}
      />
    );
  }

  return (
    <section aria-labelledby={headingId} aria-describedby={helperId}>
      <h1
        id={headingId}
        ref={headingRef}
        tabIndex={-1}
        className="text-[27px] font-extrabold leading-[36px] tracking-[-0.015em] text-text-primary outline-none sm:text-[32px] sm:leading-[42px]"
      >
        {q.title}
      </h1>
      <p id={helperId} className="mt-2 text-[14px] leading-[22px] text-text-secondary">
        {q.helper}
      </p>
      <div className="mt-6">{body}</div>
    </section>
  );
});

export default FinderStep;
