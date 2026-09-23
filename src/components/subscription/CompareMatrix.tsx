/**
 * «مقارنة الخطط» — a real matrix, read across.
 *
 * It replaces three separate cards of check-marked lists, which could not be
 * scanned side by side and needed a «يشمل جميع مزايا PLUS» disclosure to say
 * what a higher tier inherits. Here every row is one benefit and every column
 * one tier; a tick comes from the server's entitlement contract, a figure from
 * the rules the checkout applies (see compareModel.ts). The conditions are
 * quiet numbered notes under the table, not sentences inside cells.
 *
 * From 640px all three columns show under a sticky header with each tier's
 * name and price, and the account's own tier is a slightly lifted column. On a
 * phone a segmented control picks the column, so the cells keep their width.
 * «الفروقات فقط» hides the rows every tier shares.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Check, Minus } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { useMoney } from '../../CurrencyContext';
import { Segmented } from '../ui/Segmented';
import { TIER_META, type AnyTier, type PaidTier } from './tierMeta';
import type { ApiPlan, PlanFeatures } from './types';
import { isolatedMoney, type PlanBenefits } from './benefitLines';
import { buildCompare, rowIsUniform, type CompareCell } from './compareModel';

export interface CompareMatrixProps {
  tiers: PaidTier[];
  plans: ApiPlan[] | null;
  contract: Partial<Record<PaidTier, Record<string, boolean>>> | null;
  benefits: PlanBenefits | null;
  features: PlanFeatures | null;
  points: Partial<Record<PaidTier, number>> | null;
  currentTier: AnyTier;
  /** The tier chosen above, which the phone column follows until changed here. */
  selectedTier: PaidTier;
  loading: boolean;
  headingRef?: React.RefObject<HTMLHeadingElement | null>;
}

function Cell({ cell, tier }: { cell: CompareCell; tier: PaidTier }) {
  const { loc } = useLanguage();
  if (cell.kind === 'yes') {
    return (
      <>
        <Check className="w-4 h-4 text-text-primary mx-auto" strokeWidth={2.6} aria-hidden />
        <span className="sr-only">{loc('مشمول', 'Included', 'هەیە')} — {TIER_META[tier].label}</span>
      </>
    );
  }
  if (cell.kind === 'no') {
    return (
      <>
        <Minus className="w-4 h-4 text-text-muted/60 mx-auto" aria-hidden />
        <span className="sr-only">{loc('غير مشمول', 'Not included', 'نییە')} — {TIER_META[tier].label}</span>
      </>
    );
  }
  return (
    <span className="block space-y-0.5">
      {cell.lines.map((l) => (
        <span key={l} className="block text-[12px] leading-snug text-text-primary tabular-nums">
          {l}
        </span>
      ))}
    </span>
  );
}

export function CompareMatrix({
  tiers,
  plans,
  contract,
  benefits,
  features,
  points,
  currentTier,
  selectedTier,
  loading,
  headingRef,
}: CompareMatrixProps) {
  const { t, loc, dir } = useLanguage();
  const { money: plainMoney } = useMoney();
  const money = useMemo(() => isolatedMoney(plainMoney, dir), [plainMoney, dir]);
  const [column, setColumn] = useState<PaidTier>(selectedTier);
  const [diffOnly, setDiffOnly] = useState(false);
  // The phone column follows the card chosen above; picking one here is a
  // separate, local choice until the next card is chosen.
  useEffect(() => setColumn(selectedTier), [selectedTier]);

  const model = useMemo(
    () => buildCompare({ tiers, contract, benefits, features, points, loc, money }),
    [tiers, contract, benefits, features, points, loc, money]
  );

  const priceOf = (tier: PaidTier) => {
    const own = (plans || []).filter((p) => p.tier === tier && p.per_month_iqd !== null);
    if (!own.length) return t('priceTBA');
    const min = Math.min(...own.map((p) => p.per_month_iqd as number));
    return `${own.length > 1 ? loc('من ', 'from ', 'لە ') : ''}${money(min)} ${t('perMonth')}`;
  };

  const visible = (tier: PaidTier) => (tier === column ? '' : 'hidden sm:table-cell');

  return (
    <section aria-labelledby="compare-title" id="compare" className="scroll-mt-4">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-3">
        <h2 id="compare-title" ref={headingRef} tabIndex={-1} className="text-[1.25rem] sm:text-[1.45rem] font-extrabold text-text-primary outline-none">
          {t('planComparisons')}
        </h2>
        <button
          type="button"
          role="switch"
          aria-checked={diffOnly}
          onClick={() => setDiffOnly((v) => !v)}
          className="inline-flex items-center gap-2 min-h-11 px-1 text-[13px] font-semibold text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus rounded-lg"
        >
          <span
            aria-hidden
            className={`relative w-9 h-5 rounded-full border transition-colors ${diffOnly ? 'bg-text-primary border-text-primary' : 'bg-surface-raised border-border-subtle'}`}
          >
            <span
              className={`absolute top-0.5 w-3.5 h-3.5 rounded-full transition-[inset-inline-start] duration-150 ${
                diffOnly ? 'start-[1.1rem] bg-canvas' : 'start-0.5 bg-text-muted'
              }`}
            />
          </span>
          {t('differencesOnly')}
        </button>
      </div>

      {tiers.length > 1 && (
        <Segmented
          group="compare-column"
          label={t('planComparisons')}
          value={column}
          onChange={(id) => setColumn(id as PaidTier)}
          className="mb-3 sm:hidden"
          items={tiers.map((tier) => ({
            id: tier,
            label: TIER_META[tier].label,
            accent: { indicator: 'bg-surface-selected border-border-subtle', text: TIER_META[tier].text },
          }))}
        />
      )}

      {loading ? (
        <div role="status" aria-busy="true" className="lv-surface p-4 space-y-3">
          <span className="sr-only">{t('loadingPlans')}</span>
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-4 rounded bg-surface-raised animate-pulse motion-reduce:animate-none" aria-hidden />
          ))}
        </div>
      ) : (
        <div className="lv-surface overflow-clip" data-compare-matrix>
          <table className="w-full border-collapse text-start">
            <thead className="sticky top-0 z-10">
              <tr>
                <th scope="col" className="w-[42%] sm:w-[34%] px-3 sm:px-4 py-3 text-start text-[12px] font-semibold text-text-muted align-bottom bg-surface border-b border-border-subtle/70">
                  <span className="sr-only">{t('planComparisons')}</span>
                </th>
                {tiers.map((tier) => {
                  const meta = TIER_META[tier];
                  return (
                    <th
                      key={tier}
                      scope="col"
                      data-compare-col={tier}
                      className={`px-2 sm:px-3 py-3 text-center align-bottom border-b border-border-subtle/70 ${visible(tier)} ${tier === currentTier ? 'bg-surface-selected' : 'bg-surface'}`}
                    >
                      <span className="flex items-center justify-center gap-1">
                        <meta.Icon className={`w-3.5 h-3.5 ${meta.text}`} aria-hidden />
                        <span className={`text-[13px] font-extrabold ${meta.text}`} dir="ltr">
                          {meta.label}
                        </span>
                      </span>
                      <span className="block mt-0.5 text-[11px] font-medium text-text-muted tabular-nums">{priceOf(tier)}</span>
                      {tier === currentTier && <span className="block text-[10.5px] font-semibold text-success">{t('currentTier')}</span>}
                    </th>
                  );
                })}
              </tr>
            </thead>
            {model.groups.map((group) => {
              const rows = diffOnly ? group.rows.filter((r) => !rowIsUniform(r, tiers)) : group.rows;
              if (rows.length === 0) return null;
              return (
                <tbody key={group.key} data-compare-group={group.key}>
                  <tr>
                    <th
                      scope="colgroup"
                      colSpan={tiers.length + 1}
                      className="px-3 sm:px-4 pt-5 pb-2 text-start text-[12.5px] font-bold text-text-secondary border-t border-border-subtle/70"
                    >
                      {group.label}
                    </th>
                  </tr>
                  {rows.map((row) => (
                    <tr key={row.key} data-compare-row={row.key} className="border-t border-border-subtle/40">
                      <th scope="row" className="px-3 sm:px-4 py-2.5 text-start align-top text-[12.5px] font-medium leading-snug text-text-secondary">
                        {row.label}
                        {row.note && (
                          <sup className="ms-0.5 text-[10px] text-text-muted">
                            <a href={`#compare-note-${row.note}`} className="focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus rounded">
                              {row.note}
                            </a>
                          </sup>
                        )}
                      </th>
                      {tiers.map((tier) => (
                        <td
                          key={tier}
                          className={`px-2 sm:px-3 py-2.5 text-center align-top ${visible(tier)} ${tier === currentTier ? 'bg-surface-selected/60' : ''}`}
                        >
                          <Cell cell={row.cells[tier]} tier={tier} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              );
            })}
          </table>
        </div>
      )}

      {model.notes.length > 0 && !loading && (
        <ol className="mt-3 space-y-1.5 text-[11.5px] leading-relaxed text-text-muted">
          {model.notes.map((n, i) => (
            <li key={n} id={`compare-note-${i + 1}`} className="flex gap-1.5">
              <span className="tabular-nums shrink-0">{i + 1}.</span>
              <span>{n}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export default CompareMatrix;
