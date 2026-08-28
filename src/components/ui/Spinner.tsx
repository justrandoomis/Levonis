import React from 'react';
import { useLanguage } from '../../LanguageContext';

/**
 * LEVONIS inline spinner — a small gold arc for in-button and inline waits.
 * Never a full-page takeover; page-level pending states use the skeletons.
 *
 * Flicker prevention (not an artificial delay): the spinner mounts invisible
 * and only fades in after `delayMs` (default 150ms), so requests that resolve
 * quickly never flash an indicator. `delayMs={0}` shows it immediately (e.g.
 * inside a button right after the user tapped it).
 *
 * prefers-reduced-motion: the rotation is replaced by a gentle opacity pulse;
 * the localized status text is always available to screen readers.
 */

const STYLE_ID = 'lv-spinner-css';
const CSS = `
@keyframes lv-appear { to { opacity: 1; } }
@keyframes lv-rotate { to { transform: rotate(360deg); } }
@keyframes lv-soft-fade { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
.lv-delay-in { opacity: 0; animation: lv-appear 1ms linear var(--lv-delay, 150ms) forwards; }
.lv-spin { animation: lv-rotate 0.8s linear infinite; }
@media (prefers-reduced-motion: reduce) {
  .lv-spin { animation: lv-soft-fade 1.6s ease-in-out infinite; }
}
`;

function ensureSpinnerCss() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}
ensureSpinnerCss();

const SIZES = {
  xs: 'w-3.5 h-3.5 border',
  sm: 'w-4 h-4 border-2',
  md: 'w-6 h-6 border-2',
} as const;

const STRINGS = {
  ar: { loading: 'جارٍ التحميل…' },
  en: { loading: 'Loading…' },
  ckb: { loading: 'باردەکرێت…' },
} as const;

export default function Spinner({
  size = 'sm',
  delayMs = 150,
  label,
  decorative = false,
  className = '',
}: {
  size?: keyof typeof SIZES;
  /** 0 shows immediately; the 150ms default avoids a flash on fast responses. */
  delayMs?: number;
  /** Screen-reader status text; defaults to a localized "Loading…". */
  label?: string;
  /** True when adjacent visible text already announces the wait (e.g. a "Saving…" button). */
  decorative?: boolean;
  className?: string;
}) {
  const { lang } = useLanguage();
  ensureSpinnerCss();
  const delayStyle =
    delayMs > 0 ? ({ '--lv-delay': `${delayMs}ms` } as React.CSSProperties) : undefined;
  return (
    <span
      role={decorative ? undefined : 'status'}
      aria-live={decorative ? undefined : 'polite'}
      aria-hidden={decorative || undefined}
      className={`inline-flex items-center justify-center ${delayMs > 0 ? 'lv-delay-in' : ''} ${className}`}
      style={delayStyle}
    >
      <span
        aria-hidden="true"
        className={`lv-spin rounded-full border-gold/25 border-t-gold ${SIZES[size]}`}
      />
      {!decorative && <span className="sr-only">{label || STRINGS[lang].loading}</span>}
    </span>
  );
}
