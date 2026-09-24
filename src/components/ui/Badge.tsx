/**
 * BADGE and STATUSCHIP — small labels that carry a count or a state.
 *
 * A STATUSCHIP says what state a thing is in: «مدفوع», «بانتظار الشحن»,
 * «ملغى». The tone is one of the system's semantic colours — success,
 * warning, danger, info — or neutral, or the one accent; never a sixth colour
 * a screen invented. The state is carried by THREE cues at once: the word,
 * a leading dot, and the tint, so it survives colour blindness, a greyscale
 * screenshot and a screen reader alike (apple-design §5, §7).
 *
 * Restrained on purpose: a 10% tint and tone-coloured text — no border plus
 * fill plus glow for one state.
 *
 * A BADGE is a count («3») or a short tag beside something else. Numbers are
 * tabular and set as an LTR island, so «12» never reads «21» in an Arabic row.
 */
import React from 'react';

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

const CHIP: Record<Tone, string> = {
  neutral: 'bg-white/[0.06] text-text-secondary',
  accent: 'bg-gold/10 text-gold',
  success: 'bg-success/10 text-success',
  warning: 'bg-warning/10 text-warning',
  danger: 'bg-danger/10 text-danger',
  info: 'bg-info/10 text-info',
};

const DOT: Record<Tone, string> = {
  neutral: 'bg-text-muted',
  accent: 'bg-gold',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
};

export interface StatusChipProps {
  tone?: Tone;
  children: React.ReactNode;
  /** Drop the leading dot (e.g. when an icon is passed). */
  dot?: boolean;
  icon?: React.ReactNode;
  className?: string;
}

export function StatusChip({ tone = 'neutral', children, dot = true, icon, className = '' }: StatusChipProps) {
  return (
    <span
      data-status-chip={tone}
      // Never truncated: «بانتظار ال…» is not a status. A chip too long for
      // its row wraps rather than hiding the word that carries the state.
      className={`inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold leading-tight ${CHIP[tone]} ${className}`}
    >
      {icon ?? (dot && <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[tone]}`} />)}
      <span className="min-w-0">{children}</span>
    </span>
  );
}

export interface BadgeProps {
  children: React.ReactNode;
  tone?: Tone;
  className?: string;
}

/** A count or a short tag. For a number, pass the number itself: it is set LTR and tabular. */
export function Badge({ children, tone = 'neutral', className = '' }: BadgeProps) {
  const numeric = typeof children === 'number';
  return (
    <span
      dir={numeric ? 'ltr' : undefined}
      className={`inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-[11px] font-bold leading-none ${
        numeric ? 'tabular-nums' : ''
      } ${CHIP[tone]} ${className}`}
    >
      {numeric && (children as number) > 99 ? '99+' : children}
    </span>
  );
}
