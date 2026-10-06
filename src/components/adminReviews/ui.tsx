/**
 * Small pieces the «المراجعات والهدايا» screens share, built ONLY from the
 * admin `.ap` recipes (adminProducts/theme.ts) and classes already in the
 * entry stylesheet — the CSS budget has no room for a new utility.
 */
import React, { useRef, useState } from 'react';
import { AlertTriangle, Check, Copy, Info, Minus, Package, Star, X } from 'lucide-react';
import * as T from '../adminProducts/theme';
import { copyText } from '../../lib/copyText';

export type Tone = 'success' | 'warning' | 'danger' | 'neutral' | 'info' | 'accent';

const TONE: Record<Tone, string> = {
  success: T.badge.active,
  warning: T.badge.draft,
  danger: T.badge.hidden,
  neutral: 'text-[var(--ap-text-2)] bg-[var(--ap-surface-2)] border-[var(--ap-border)]',
  info: 'text-[var(--ap-info)] bg-[var(--ap-info-bg)] border-[var(--ap-info-border)]',
  accent: 'text-[var(--ap-accent-text)] bg-[var(--ap-accent-soft)] border-[var(--ap-accent-border)]',
};

/** A status in a word and an icon — never colour alone. */
export function Chip({ tone, icon, children, title }: { tone: Tone; icon?: React.ReactNode; children: React.ReactNode; title?: string }) {
  return (
    <span className={`${T.badgeBase} ${TONE[tone]} max-w-full`} title={title}>
      {icon}
      <span className="truncate">{children}</span>
    </span>
  );
}

/** One fact: a label above its value. */
export function Fact({ label, children, ltr }: { label: string; children: React.ReactNode; ltr?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11.5px] font-semibold text-[var(--ap-text-3)]">{label}</dt>
      <dd className="mt-0.5 text-[13px] text-[var(--ap-text-1)] break-words" dir={ltr ? 'ltr' : undefined}>
        {children}
      </dd>
    </div>
  );
}

/** Five stars and the number in words, so the rating is never read from colour. */
export function Stars({ n, label }: { n: number; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5" title={label}>
      <span className="inline-flex items-center gap-0.5" aria-hidden="true" dir="ltr">
        {[1, 2, 3, 4, 5].map((i) => (
          <Star key={i} className={`w-3.5 h-3.5 ${i <= n ? 'text-gold fill-current' : 'text-[var(--ap-text-3)]'}`} />
        ))}
      </span>
      <span className="text-[12px] text-[var(--ap-text-2)] tabular-nums">{label}</span>
    </span>
  );
}

/** A product picture in the admin thumb frame, with an icon when there is none. */
export function Thumb({ src, size = 'md' }: { src: string; size?: 'sm' | 'md' | 'lg' }) {
  const box = size === 'lg' ? 'w-16 h-16' : size === 'sm' ? 'w-10 h-10' : 'w-12 h-12';
  return (
    <span className={`${T.thumb} ${box} inline-flex items-center justify-center`} aria-hidden="true">
      {src ? (
        <img src={src} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
      ) : (
        <Package className="w-5 h-5 text-[var(--ap-text-3)]" />
      )}
    </span>
  );
}

/** ✓ / ✗ / – with its word. */
export function Verdict({ value, met, notMet, unknown }: { value: boolean | null; met: string; notMet: string; unknown: string }) {
  if (value === null) {
    return (
      <span className="inline-flex items-center gap-1 text-[var(--ap-text-3)]">
        <Minus className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        {unknown}
      </span>
    );
  }
  return value ? (
    <span className="inline-flex items-center gap-1 text-[var(--ap-success)]">
      <Check className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
      {met}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-[var(--ap-danger)]">
      <X className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
      {notMet}
    </span>
  );
}

/** An inline message beside the thing it is about. */
export function Notice({ tone, children, live }: { tone: 'warning' | 'danger' | 'info' | 'success'; children: React.ReactNode; live?: boolean }) {
  const t = tone === 'success' ? TONE.success : tone === 'warning' ? TONE.warning : tone === 'danger' ? TONE.danger : TONE.info;
  const Icon = tone === 'success' ? Check : tone === 'info' ? Info : AlertTriangle;
  return (
    <div
      className={`flex items-start gap-2 rounded-[var(--ap-radius-md)] border px-3 py-2 text-[12.5px] leading-relaxed ${t}`}
      role={live ? (tone === 'danger' ? 'alert' : 'status') : undefined}
    >
      <Icon className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
      <div className="min-w-0 break-words">{children}</div>
    </div>
  );
}

/** A small copy button for an id or a serial; ticks only after a real copy. */
export function CopyValue({ value, label, copiedLabel }: { value: string; label: string; copiedLabel: string }) {
  const [state, setState] = useState<'idle' | 'copied'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  if (!value) return null;
  return (
    <button
      type="button"
      className={`${T.btnIcon} relative lv-hit`}
      aria-label={state === 'copied' ? copiedLabel : label}
      title={state === 'copied' ? copiedLabel : label}
      onClick={async () => {
        const ok = await copyText(value);
        if (!ok) return;
        setState('copied');
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setState('idle'), 1800);
      }}
    >
      {state === 'copied' ? <Check className="w-3.5 h-3.5" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5" aria-hidden="true" />}
    </button>
  );
}

/** The radio chip of the admin kit (aria-checked lights it). */
export const RADIO_CHIP = `${T.chip} relative lv-hit aria-checked:text-[var(--ap-accent-text)] aria-checked:bg-[var(--ap-accent-soft)] aria-checked:border-[var(--ap-accent-border)]`;

/** The 44px level square: big enough to tap, lit only when chosen. */
export const LEVEL_SQUARE =
  'inline-flex items-center justify-center w-11 h-11 shrink-0 rounded-[var(--ap-radius-md)] border border-[var(--ap-border)] bg-[var(--ap-surface-2)] text-[15px] font-bold tabular-nums text-[var(--ap-text-2)] transition-colors duration-150 enabled:hover:text-[var(--ap-text-1)] enabled:hover:border-[var(--ap-border-hover)] aria-checked:text-[var(--ap-accent-text)] aria-checked:bg-[var(--ap-accent-soft)] aria-checked:border-[var(--ap-accent-border)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ap-ring)] disabled:opacity-45';

/**
 * A radio group with a roving tab stop. With nothing chosen the FIRST option
 * is the tab stop (a group nobody can reach by keyboard is a dead end), but it
 * is not checked: a level is never preselected.
 */
export function RadioGroup<V extends string | number>({
  label,
  labelledBy,
  options,
  value,
  onChange,
  className,
  itemClassName,
  dir,
  disabled,
  dataAttr,
}: {
  label?: string;
  labelledBy?: string;
  options: Array<{ value: V; label: React.ReactNode; ariaLabel?: string; disabled?: boolean; title?: string }>;
  value: V | null;
  onChange: (v: V) => void;
  className?: string;
  itemClassName: string;
  dir: 'rtl' | 'ltr';
  disabled?: boolean;
  dataAttr?: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const enabled = options.map((o, i) => (!o.disabled && !disabled ? i : -1)).filter((i) => i >= 0);
  const checkedIndex = options.findIndex((o) => o.value === value);
  const stop = checkedIndex >= 0 ? checkedIndex : enabled[0] ?? -1;
  const move = (from: number, delta: number) => {
    if (!enabled.length) return;
    const at = enabled.indexOf(from);
    const next = enabled[(at + delta + enabled.length) % enabled.length];
    refs.current[next]?.focus();
    onChange(options[next].value);
  };
  return (
    <div role="radiogroup" aria-label={labelledBy ? undefined : label} aria-labelledby={labelledBy} className={className}>
      {options.map((o, i) => (
        <button
          key={String(o.value)}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          aria-label={o.ariaLabel}
          title={o.title}
          disabled={disabled || o.disabled}
          tabIndex={i === stop ? 0 : -1}
          className={itemClassName}
          {...(dataAttr ? { [dataAttr]: String(o.value) } : null)}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => {
            const fwd = dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
            const back = dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
            if (e.key === fwd || e.key === 'ArrowDown') {
              e.preventDefault();
              move(i, 1);
            } else if (e.key === back || e.key === 'ArrowUp') {
              e.preventDefault();
              move(i, -1);
            }
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** «تحميل المزيد» under a keyset list. */
export function LoadMore({ label, busy, onClick }: { label: string; busy: boolean; onClick: () => void }) {
  return (
    <div className="flex justify-center pt-1">
      <button type="button" className={`${T.btnSecondary} relative lv-hit`} disabled={busy} onClick={onClick} aria-busy={busy || undefined}>
        {label}
      </button>
    </div>
  );
}

/** A failed load, with the way out beside it. */
export function LoadError({ text, retry, onRetry }: { text: string; retry: string; onRetry: () => void }) {
  return (
    <div className={`${T.surface} p-4 flex flex-wrap items-center justify-between gap-3`} role="alert">
      <p className="text-[13px] text-[var(--ap-danger)]">{text}</p>
      <button type="button" className={`${T.btnSecondary} relative lv-hit`} onClick={onRetry}>
        {retry}
      </button>
    </div>
  );
}

export function Loading({ text }: { text: string }) {
  return (
    <div className={`${T.surface} p-8 text-center text-[13px] text-[var(--ap-text-3)]`} role="status" aria-live="polite">
      {text}
    </div>
  );
}

export function Empty({ text }: { text: string }) {
  return <div className={`${T.surface} p-8 text-center text-[13px] text-[var(--ap-text-3)]`}>{text}</div>;
}
