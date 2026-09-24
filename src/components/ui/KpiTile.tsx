/**
 * KPITILE — one figure the merchant watches, and how it moved.
 *
 * WHAT WAS WRONG with the StatCard it replaces for new screens
 * (`ui/statCards.tsx`): five competing tints (purple, blue, green, amber, red)
 * so a row of tiles read as five alarms, 10px labels, and a sparkline that
 * could not say "there is no history".
 *
 * WHAT THIS IS. A neutral surface, a quiet label, the figure in tabular digits
 * as the one loud thing, and — only when the caller has them — a delta and a
 * trend. ONE accent: the trend line. The delta's colour is semantic (better /
 * worse) and never alone: it also has an arrow and a signed number.
 *
 * NO FAKE DATA, ANYWHERE:
 *   - `value` null/undefined prints «—», not 0;
 *   - `loading` draws skeleton bars, not a number that will change;
 *   - the delta is shown only when the caller passes one — "vs last week"
 *     with no last week is not a figure;
 *   - `Sparkline` draws nothing from fewer than two real points (it does not
 *     invent a flat line either — absence is absence).
 *
 * `to` makes the whole tile a link to the screen that explains the figure
 * (the Command Center's tiles are doors, not decorations).
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowUp, Minus } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { formatFigure, formatPercent } from '../../lib/localeNumber';
import { formatSignedMoney } from '../../lib/money';
import { Skeleton } from './Skeleton';

export interface KpiDelta {
  /** The change: 12.5 with `format: 'percent'` is "12.5% up"; −3 is "3 down". */
  value: number;
  format?: 'percent' | 'number' | 'money';
  /** What it is compared with: «مقارنة بالأسبوع الماضي». */
  label?: string;
  /** Which way is better. `neutral`: report the change without judging it. */
  good?: 'up' | 'down' | 'neutral';
}

export interface KpiTileProps {
  label: React.ReactNode;
  /** The figure — a number, or `<Money iqd={…} />`. null/undefined prints «—». */
  value: React.ReactNode | null | undefined;
  delta?: KpiDelta | null;
  /** The trend slot: a `<Sparkline series={…} />` of REAL points, or nothing. */
  trend?: React.ReactNode;
  /** One line under the figure: «3 تحتاج إجراء». */
  hint?: React.ReactNode;
  icon?: React.ReactNode;
  loading?: boolean;
  /** Makes the tile a link to the screen behind the figure. */
  to?: string;
  className?: string;
}

function deltaText(delta: KpiDelta, lang: 'ar' | 'en' | 'ckb'): string {
  const v = delta.value;
  if (delta.format === 'money') return formatSignedMoney(v, lang);
  return delta.format === 'percent' ? formatPercent(v, lang, 1, true) : formatFigure(v, lang, 0, true);
}

export function KpiTile({ label, value, delta, trend, hint, icon, loading = false, to, className = '' }: KpiTileProps) {
  const { lang } = useLanguage();
  const direction = delta ? Math.sign(delta.value) : 0;
  const judged = delta?.good ?? 'up';
  const tone =
    !delta || direction === 0 || judged === 'neutral'
      ? 'text-text-muted'
      : (direction > 0) === (judged === 'up')
        ? 'text-success'
        : 'text-danger';
  // Straight up and down: a direction of change, not of reading, so it needs
  // no mirroring in Arabic.
  const Arrow = direction > 0 ? ArrowUp : direction < 0 ? ArrowDown : Minus;

  const body = (
    <>
      <div className="flex items-center gap-2 text-[13px] font-medium text-text-secondary">
        {icon && <span aria-hidden="true" className="shrink-0 text-text-muted">{icon}</span>}
        <span className="min-w-0 truncate">{label}</span>
      </div>
      {loading ? (
        <div aria-hidden="true" className="mt-2 space-y-2">
          <Skeleton className="h-7 w-28 rounded-md" />
          <Skeleton className="h-3.5 w-20 rounded" />
        </div>
      ) : (
        <>
          <div className="mt-1.5 text-ui-xl font-bold tabular-nums text-text-primary">{value ?? '—'}</div>
          {delta && (
            <p className={`mt-1 flex flex-wrap items-center gap-x-1.5 text-[12px] ${tone}`}>
              <Arrow aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              {/* Automatic direction: the locale's own sign and «٪» placement. */}
              <bdi className="font-semibold tabular-nums">{deltaText(delta, lang)}</bdi>
              {delta.label && <span className="text-text-muted">{delta.label}</span>}
            </p>
          )}
          {hint && <p className="mt-1 text-[12px] text-text-muted">{hint}</p>}
        </>
      )}
      {trend && !loading && <div className="mt-3">{trend}</div>}
    </>
  );

  const shell = `lv-surface block min-w-0 p-4 ${className}`;
  if (to) {
    return (
      <Link
        to={to}
        data-kpi
        aria-busy={loading || undefined}
        className={`${shell} transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus`}
      >
        {body}
      </Link>
    );
  }
  return (
    <div data-kpi aria-busy={loading || undefined} className={shell}>
      {body}
    </div>
  );
}

/**
 * A tiny trend line in the accent. Decorative (the figure and the delta carry
 * the meaning); fewer than two real points draws nothing at all.
 */
export function Sparkline({ series, className = '' }: { series: readonly number[]; className?: string }) {
  const points = series.filter((v) => Number.isFinite(v));
  if (points.length < 2) return null;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const span = max - min || 1;
  const step = 100 / (points.length - 1);
  const path = points.map((v, i) => `${(i * step).toFixed(1)},${(26 - ((v - min) / span) * 22).toFixed(1)}`).join(' ');
  return (
    <svg
      viewBox="0 0 100 28"
      preserveAspectRatio="none"
      aria-hidden="true"
      data-sparkline
      className={`block h-7 w-full text-gold ${className}`}
    >
      <polyline points={path} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
