import React from 'react';
import SafeImage from '../ui/SafeImage';
import { useLanguage } from '../../LanguageContext';
import { columnName, type CompareLang, type CompareLens, type CompareLensId, type CompareProductCard } from '../../lib/compare';
import { reasonCopy, type FinderLang } from '../finder/strings';
import { withValue } from '../finder/ReasonList';
import { lensStrings } from './lensStrings';

/**
 * «الخلاصة: الأفضل لـ» — one row per lens: the winner's photograph and name,
 * and the claim it rests on, written from the SAME reason codes the finder
 * speaks (src/components/finder/strings.ts), so «سرعة طباعة حتى 1,000 mm/s»
 * reads the same on both pages. A lens whose margin is under 5% says
 * «متقاربة»; fewer than two machines with data, «لا توجد بيانات كافية» —
 * both the server's verdicts, never overridden here.
 *
 * Each row is a button that selects its lens; the chosen row takes a soft
 * success tint.
 */
export default function BestForSummary({
  lenses,
  products,
  value,
  onChange,
}: {
  lenses: CompareLens[];
  products: CompareProductCard[];
  value: CompareLensId | null;
  onChange: (next: CompareLensId | null) => void;
}) {
  const { lang } = useLanguage();
  const ls = lensStrings(lang);
  const l = lang as CompareLang;
  if (!lenses.length) return null;
  return (
    <section aria-labelledby="lv-compare-bestfor" className="overflow-hidden rounded-[20px] border border-border-subtle bg-surface">
      <h2 id="lv-compare-bestfor" className="px-4 pb-2 pt-4 text-[15px] font-extrabold text-text-primary">
        {ls.summaryTitle}
      </h2>
      <ul>
        {lenses.map((lens) => {
          const on = lens.id === value;
          const winner = lens.state === 'winner' && lens.winner !== null ? products[lens.winner] : null;
          const copy = winner && lens.reason ? reasonCopy(lens.reason, lang as FinderLang) : null;
          const name = winner ? columnName(winner, l).split(' / ')[0] : '';
          return (
            <li key={lens.id} className="border-t border-border-subtle first:border-t-0">
              <button
                type="button"
                aria-pressed={on}
                data-lens-summary={lens.id}
                onClick={() => onChange(on ? null : lens.id)}
                className={`grid min-h-16 w-full grid-cols-[minmax(84px,auto)_1fr] items-center gap-3 px-4 py-2.5 text-start transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus motion-reduce:transition-none ${
                  on ? 'bg-[color-mix(in_oklab,var(--color-success)_11%,var(--color-surface))]' : 'hover:bg-surface-raised'
                }`}
              >
                <span className={`text-[13px] font-bold ${on ? 'text-text-primary' : 'text-text-secondary'}`}>{ls.lensRow[lens.id]}</span>
                {winner ? (
                  <span className="flex min-w-0 items-center gap-3">
                    <SafeImage src={winner.image} alt="" aspect="square" fit="cover" className="w-10 shrink-0 overflow-hidden rounded-[10px]" bgClassName="bg-charcoal" fallbackClassName="text-snow/35" />
                    <span className="min-w-0">
                      <bdi dir="ltr" className="block truncate text-[13.5px] font-extrabold text-text-primary">
                        {name}
                      </bdi>
                      {copy ? (
                        <span className="mt-0.5 block text-[12px] leading-[17px] text-text-secondary">
                          {withValue(copy.text, copy.value)}
                        </span>
                      ) : null}
                    </span>
                  </span>
                ) : (
                  <span className="text-[12.5px] font-semibold text-text-muted">{lens.state === 'tie' ? ls.tie : ls.noData}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
