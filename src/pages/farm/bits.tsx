/**
 * Small presentational pieces shared by the farm's views and sheets. None of
 * them holds state or calls the server; each draws exactly the numbers it is
 * handed.
 */
import React from 'react';
import { Coins, Star } from 'lucide-react';
import type { FarmStrings } from './strings';
import { formatCoins, formatStars } from './format';
import { CHIP, HEALTH_BAR, healthTone } from './ui';

/** Hairline track with a gold fill — the CoverageBar geometry, driven by a 0–1 fraction. */
export function ProgressBar({
  fraction,
  tone = 'gold',
  label,
  className = '',
}: {
  fraction: number;
  tone?: 'gold' | 'good' | 'warn' | 'bad' | 'zinc';
  label?: string;
  className?: string;
}) {
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  const fill =
    tone === 'gold'
      ? 'bg-[#BAA369]'
      : tone === 'good'
        ? HEALTH_BAR.good
        : tone === 'warn'
          ? HEALTH_BAR.warn
          : tone === 'bad'
            ? HEALTH_BAR.bad
            : 'bg-zinc-500';
  return (
    <div
      className={`relative h-3 ${className}`}
      role={label ? 'progressbar' : undefined}
      aria-label={label}
      aria-valuemin={label ? 0 : undefined}
      aria-valuemax={label ? 100 : undefined}
      aria-valuenow={label ? Math.round(pct) : undefined}
    >
      <div aria-hidden="true" className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-px bg-zinc-800" />
      <div
        aria-hidden="true"
        className={`absolute top-1/2 -translate-y-1/2 h-[2px] rounded-full ${fill} transition-[width] duration-700 motion-reduce:transition-none`}
        style={{ insetInlineStart: 0, width: `${pct}%` }}
      />
    </div>
  );
}

/** Health 0–100 as a bar with its tint. */
export function HealthBar({ health, label, className = '' }: { health: number; label: string; className?: string }) {
  return <ProgressBar fraction={health / 100} tone={healthTone(health)} label={label} className={className} />;
}

export function Chip({ className = '', children, ...rest }: { className?: string; children: React.ReactNode } & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span {...rest} className={`${CHIP} ${className}`}>
      {children}
    </span>
  );
}

/** The coins figure: tabular, LTR, the one place type gets large. */
export function CoinsChip({
  coins,
  lang,
  s,
  size = 'md',
  className = '',
}: {
  coins: number;
  lang: string;
  s: FarmStrings;
  size?: 'md' | 'lg';
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border border-[#BAA369]/30 bg-[#BAA369]/10 text-[#BAA369] ${
        size === 'lg' ? 'px-3.5 py-1.5' : 'px-2.5 py-1'
      } ${className}`}
      aria-label={`${formatCoins(coins, lang)} ${s.coins}`}
      data-farm-coins
    >
      <Coins aria-hidden="true" className={size === 'lg' ? 'w-5 h-5' : 'w-4 h-4'} />
      <span className={`font-black tabular-nums leading-none ${size === 'lg' ? 'text-[24px]' : 'text-[15px]'}`} dir="ltr">
        {formatCoins(coins, lang)}
      </span>
    </span>
  );
}

/** Reputation as five stars, filled to the server's value. */
export function Stars({ stars, s, className = '' }: { stars: number; s: FarmStrings; className?: string }) {
  const label = formatStars(stars);
  const full = Math.floor(Math.max(0, Math.min(5, stars)));
  const frac = Math.max(0, Math.min(5, stars)) - full;
  return (
    <span className={`inline-flex items-center gap-1 ${className}`} aria-label={s.starsLabel(label)} title={s.starsLabel(label)}>
      <span className="inline-flex items-center gap-px" aria-hidden="true" dir="ltr">
        {Array.from({ length: 5 }, (_, i) => {
          const fill = i < full ? 1 : i === full ? frac : 0;
          return (
            <span key={i} className="relative w-3.5 h-3.5 text-zinc-700">
              <Star className="absolute inset-0 w-3.5 h-3.5" fill="currentColor" stroke="none" />
              <span className="absolute inset-0 overflow-hidden text-[#BAA369]" style={{ width: `${fill * 100}%` }}>
                <Star className="w-3.5 h-3.5" fill="currentColor" stroke="none" />
              </span>
            </span>
          );
        })}
      </span>
      <span className="text-[12px] font-bold tabular-nums text-zinc-200" dir="ltr">
        {label}
      </span>
    </span>
  );
}

/**
 * A label/value pair for spec grids. A value that can run long in a narrow
 * column (a build volume, a materials list) takes `wrap`: it breaks onto a
 * second line instead of being cut to "180×180×…", and reserves the two
 * lines so every card in the grid keeps the same height.
 */
export function Spec({ label, value, ltr = true, wrap = false }: { label: string; value: React.ReactNode; ltr?: boolean; wrap?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold text-zinc-500 truncate">{label}</div>
      <div className={`text-[12.5px] font-bold text-zinc-200 tabular-nums ${wrap ? 'break-words leading-tight min-h-[32px]' : 'truncate'}`} dir={ltr ? 'ltr' : undefined}>
        {value}
      </div>
    </div>
  );
}

/** Section header: title with an optional count. */
export function SectionTitle({ id, title, count, action }: { id?: string; title: string; count?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h2 id={id} className="text-white font-bold text-[15px] flex items-baseline gap-2">
        {title}
        {count !== undefined && (
          <span className="text-zinc-500 text-[12px] tabular-nums font-medium" dir="ltr">
            {count}
          </span>
        )}
      </h2>
      {action}
    </div>
  );
}

/** Colour swatch dot for a filament colour. */
export function Swatch({ color, size = 'sm' }: { color: string; size?: 'sm' | 'md' }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block rounded-full border border-white/15 shrink-0 ${size === 'md' ? 'w-4 h-4' : 'w-3 h-3'}`}
      style={{ backgroundColor: color }}
    />
  );
}
