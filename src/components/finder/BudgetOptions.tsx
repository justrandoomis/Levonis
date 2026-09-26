import React from 'react';
import { FINDER_BUDGET_IDS } from '../../lib/finder/answers';
import type { FinderBudget } from '../../../packages/catalog/src/discovery';
import type { FinderMeta } from '../../../packages/catalog/src/discoveryTypes';
import ChoiceRows, { type RowOption } from './ChoiceRows';
import { ANY_ICON, BUDGET_ICON } from './icons';
import { budgetLabel, printersCount, type FinderLang } from './strings';

/**
 * QUESTION 3 — the four ranges the owner fixed (Q5) plus «لا يهم», each with the
 * LIVE count of printers in it from `/api/printer-finder/meta` (regular prices,
 * the same for every viewer). A count is shown only when the server gave one;
 * while it loads, the rows are simply without it (never a placeholder number).
 */
export default function BudgetOptions({
  labelledBy,
  value,
  meta,
  lang,
  onChoose,
}: {
  labelledBy: string;
  value: FinderBudget | null;
  meta: FinderMeta | null;
  lang: FinderLang;
  onChoose: (value: FinderBudget, viaPointer: boolean) => void;
}) {
  const counts = new Map((meta?.budgets ?? []).map((b) => [b.range, b.count]));
  const options: RowOption<FinderBudget>[] = (FINDER_BUDGET_IDS as readonly FinderBudget[]).map((id) => {
    const n = id === 'any' ? meta?.total : counts.get(id);
    return {
      value: id,
      title: budgetLabel(id, lang),
      Icon: id === 'any' ? ANY_ICON : BUDGET_ICON,
      meta: typeof n === 'number' ? printersCount(n, lang) : undefined,
    };
  });
  return <ChoiceRows labelledBy={labelledBy} options={options} mode="single" selected={value ? [value] : []} onChoose={onChoose} />;
}
