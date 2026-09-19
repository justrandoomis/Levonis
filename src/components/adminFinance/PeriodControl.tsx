import React from 'react';
import { RefreshCw } from 'lucide-react';
import type { FinanceGranularity } from '../../lib/api';
import { PRESET_IDS, type PresetId, type RangeProblem } from './period';
import { rangeLabel } from './format';
import type { FinanceStrings } from './strings';

/**
 * THE PERIOD CONTROL — one row, above everything it scopes.
 *
 * Every figure, every chart and every table on this screen is a view of ONE
 * slice, so there is exactly one place to choose that slice and it sits above
 * all of them. A per-chart date picker is the fastest way to put two numbers
 * that disagree on the same screen: the owner reads a revenue tile scoped to
 * this month beside a product chart still scoped to last week and has no way
 * to know it. If one chart ever genuinely needs its own range, it is a
 * different screen.
 *
 * PRESETS BEFORE A CALENDAR. «آخر ٣٠ يومًا» is a row to press, not two dates to
 * find in a grid — nobody fights a calendar for the range they ask for every
 * day. The custom range sits behind its own preset for the case the rows do
 * not cover, and it is applied on a button rather than on every keystroke: a
 * half-typed «2026-0» is a range the server would refuse and a screen that
 * would blank while the owner is still typing.
 *
 * GROUPING IS IN THE SAME ROW, not inside the chart card, for the same reason:
 * it changes the request, so it changes every number below it.
 *
 * THE RANGE IS CHECKED BEFORE THE REQUEST LEAVES. The server enforces all of
 * it — this is the courtesy that turns a 400 and a blanked screen into a
 * sentence under the field.
 */

export interface PeriodValue {
  preset: PresetId;
  from: string;
  to: string;
  granularity: FinanceGranularity;
}

const GRANULARITIES: FinanceGranularity[] = ['day', 'week', 'month', 'range'];

export default function PeriodControl({
  value,
  draft,
  problem,
  loading,
  s,
  latin,
  onPreset,
  onDraft,
  onApply,
  onGranularity,
  onRefresh,
}: {
  value: PeriodValue;
  /** What is typed into the custom fields, which is not yet what is shown. */
  draft: { from: string; to: string };
  problem: RangeProblem;
  loading: boolean;
  s: FinanceStrings;
  latin: boolean;
  onPreset: (id: PresetId) => void;
  onDraft: (next: { from: string; to: string }) => void;
  onApply: () => void;
  onGranularity: (g: FinanceGranularity) => void;
  onRefresh: () => void;
}) {
  const presetLabel: Record<PresetId, string> = {
    today: s.today,
    last7: s.last7,
    last30: s.last30,
    month: s.thisMonth,
    last90: s.last90,
    custom: s.custom,
  };
  const granularityLabel: Record<FinanceGranularity, string> = {
    day: s.byDay,
    week: s.byWeek,
    month: s.byMonth,
    range: s.wholeRange,
  };
  const problemText =
    problem === 'from_not_a_day'
      ? s.badFrom
      : problem === 'to_not_a_day'
        ? s.badTo
        : problem === 'reversed'
          ? s.reversed
          : problem === 'too_long'
            ? s.tooLong
            : '';

  return (
    <div data-finance-period className="lv-surface p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-[12px] leading-[1.5] font-bold text-text-muted">{s.periodLabel}</span>
        <div role="group" aria-label={s.periodLabel} className="flex flex-wrap items-center gap-1.5">
          {PRESET_IDS.map((id) => (
            <button
              key={id}
              type="button"
              data-finance-preset={id}
              aria-pressed={value.preset === id}
              onClick={() => onPreset(id)}
              className="lv-choice press-scale min-h-[44px] px-3 text-[12px] leading-[1.5] font-bold"
            >
              {presetLabel[id]}
            </button>
          ))}
        </div>

        <span className="hidden h-5 w-px bg-border-subtle sm:block" aria-hidden />

        <span className="text-[12px] leading-[1.5] font-bold text-text-muted">{s.granularityLabel}</span>
        <div role="group" aria-label={s.granularityLabel} className="flex flex-wrap items-center gap-1.5">
          {GRANULARITIES.map((g) => (
            <button
              key={g}
              type="button"
              data-finance-granularity={g}
              aria-pressed={value.granularity === g}
              onClick={() => onGranularity(g)}
              className="lv-choice press-scale min-h-[44px] px-3 text-[12px] leading-[1.5] font-bold"
            >
              {granularityLabel[g]}
            </button>
          ))}
        </div>

        <button
          type="button"
          data-finance-refresh
          onClick={onRefresh}
          disabled={loading}
          className="lv-button lv-button-secondary lv-button-sm press-scale ms-auto"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden />
          {s.refresh}
        </button>
      </div>

      {value.preset === 'custom' && (
        <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-border-subtle pt-3">
          <div className="min-w-[9rem]">
            <label htmlFor="finance-from" className="block text-[11px] leading-[1.5] font-bold text-text-muted">
              {s.from}
            </label>
            <input
              id="finance-from"
              type="date"
              dir="ltr"
              value={draft.from}
              aria-invalid={problem === 'from_not_a_day' || problem === 'reversed'}
              onChange={(e) => onDraft({ from: e.target.value, to: draft.to })}
              className="lv-input mt-1 text-[13px] leading-[1.5]"
            />
          </div>
          <div className="min-w-[9rem]">
            <label htmlFor="finance-to" className="block text-[11px] leading-[1.5] font-bold text-text-muted">
              {s.to}
            </label>
            <input
              id="finance-to"
              type="date"
              dir="ltr"
              value={draft.to}
              aria-invalid={problem === 'to_not_a_day' || problem === 'too_long'}
              onChange={(e) => onDraft({ from: draft.from, to: e.target.value })}
              className="lv-input mt-1 text-[13px] leading-[1.5]"
            />
          </div>
          <button
            type="button"
            data-finance-apply
            onClick={onApply}
            disabled={problem !== null}
            className="lv-button lv-button-primary lv-button-sm press-scale"
          >
            {s.apply}
          </button>
          {problemText && (
            <p role="alert" className="lv-field-error w-full">
              {problemText}
            </p>
          )}
        </div>
      )}

      {/* What is actually on screen, spelled out: a preset name alone does not
          tell the owner which days the figures cover. */}
      <p className="mt-2 text-[11px] leading-[1.6] text-text-muted">
        <span dir="ltr">{rangeLabel(value.from, value.to, latin)}</span>
      </p>
    </div>
  );
}
