/**
 * PROGRESS, ONLY FROM REAL NUMBERS.
 *
 * `value` is a percentage the caller computed from two figures the server
 * gave (src/cloud/format.ts `progressPercent` / `permillePercent`). `null` —
 * no telemetry, a stale reading, a total that is not known — draws NOTHING:
 * an empty bar would still say "0 %", and a guessed one is a lie
 * (docs/PRINT_CLOUD.md). The track is a well sunk into its card, the fill one
 * of the system's tones; it fills from the inline start, so in Arabic and
 * Sorani it grows from the right.
 */
export type ProgressTone = 'accent' | 'success' | 'info' | 'warning' | 'danger';

const FILL: Record<ProgressTone, string> = {
  accent: 'bg-gold',
  success: 'bg-success',
  info: 'bg-info',
  warning: 'bg-warning',
  danger: 'bg-danger',
};

export interface ProgressBarProps {
  /** 0–100 from real numbers, or null for "not known" (nothing is drawn). */
  value: number | null | undefined;
  /** The accessible name: «Printing progress», «Hours left». */
  label: string;
  tone?: ProgressTone;
  /** `md` (default) 8px, `sm` 6px. */
  size?: 'sm' | 'md';
  className?: string;
}

export function ProgressBar({ value, label, tone = 'accent', size = 'md', className = '' }: ProgressBarProps) {
  if (value == null || !Number.isFinite(value)) return null;
  const v = Math.min(100, Math.max(0, Math.round(value)));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={v}
      className={`w-full overflow-hidden rounded-full lv-well ${size === 'sm' ? 'h-1.5' : 'h-2'} ${className}`}
    >
      <div className={`h-full rounded-full ${FILL[tone]}`} style={{ inlineSize: `${v}%` }} />
    </div>
  );
}
