/**
 * STATCARD — one balance the customer watches: «Printing hours 18.4 h of
 * 24 h», «My filament 650 g».
 *
 * An icon in a tinted square, a quiet title, the figure as the one loud thing
 * (its unit set smaller beside it, both tabular), one sub-line, and — only
 * when the caller has two real numbers — a progress bar. Resting clay
 * (`lv-surface`); with `to` the whole card is a door (pressable clay, the
 * KpiTile recipe). NO FAKE DATA: `value` null prints «—», `loading` draws
 * skeleton bars, `progress` null draws no bar.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { Skeleton } from '../../components/ui/Skeleton';
import { ProgressBar } from './ProgressBar';

export type StatTone = 'accent' | 'success' | 'info' | 'warning';

/** The tinted square behind the icon: the house chip mix of one tone. */
const TINT: Record<StatTone, string> = {
  accent: 'lv-chip [--chip:var(--color-gold)]',
  success: 'lv-chip [--chip:var(--color-success)]',
  info: 'lv-chip [--chip:var(--color-info)]',
  warning: 'lv-chip [--chip:var(--color-warning)]',
};

export interface StatCardProps {
  icon: React.ReactNode;
  title: React.ReactNode;
  /** The figure. null/undefined prints «—». */
  value: React.ReactNode | null | undefined;
  /** Set smaller after the figure: «h», «g». */
  unit?: React.ReactNode;
  /** One line under the figure: «of 24 h», «PLA Basic · White». */
  sub?: React.ReactNode;
  /** 0–100 from real numbers; null/undefined: no bar. */
  progress?: number | null;
  /** The bar's accessible name (required with `progress`). */
  progressLabel?: string;
  tone?: StatTone;
  /** Makes the whole card a link. */
  to?: string;
  loading?: boolean;
  className?: string;
}

export function StatCard({ icon, title, value, unit, sub, progress, progressLabel = '', tone = 'accent', to, loading = false, className = '' }: StatCardProps) {
  const body = (
    <>
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${TINT[tone]}`}>
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-text-secondary">{title}</p>
          {loading ? (
            <div aria-hidden="true" className="mt-1.5 space-y-2">
              <Skeleton className="h-6 w-20 rounded-md" />
              <Skeleton className="h-3 w-24 rounded" />
            </div>
          ) : (
            <>
              <p className="mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-1 text-ui-xl font-bold leading-tight tabular-nums text-text-primary">
                <bdi>{value ?? '—'}</bdi>
                {unit && value != null ? <span className="text-sm font-semibold text-text-secondary">{unit}</span> : null}
              </p>
              {sub ? <p className="mt-0.5 truncate text-[12px] text-text-muted">{sub}</p> : null}
            </>
          )}
        </div>
      </div>
      {!loading && progress != null ? <ProgressBar className="mt-3" size="sm" value={progress} label={progressLabel} tone={tone} /> : null}
    </>
  );
  const shell = `lv-surface block min-w-0 p-4 ${className}`;
  if (to) {
    return (
      <Link
        to={to}
        aria-busy={loading || undefined}
        className={`${shell} no-press transition-colors hover:bg-surface-raised hover:shadow-lg active:shadow-press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus`}
      >
        {body}
      </Link>
    );
  }
  return (
    <div aria-busy={loading || undefined} className={shell}>
      {body}
    </div>
  );
}
