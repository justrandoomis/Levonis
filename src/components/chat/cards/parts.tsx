/**
 * THE PIECES EVERY CARD IS BUILT FROM — one shell, one status line, one row of
 * facts, one action row — so a quote, a print request, a private product and
 * an order read as members of one family in the conversation, and a status is
 * drawn the same way everywhere (a small dot and words, never colour alone).
 */
import type React from 'react';
import { Loader2 } from 'lucide-react';

export type Tone = 'good' | 'wait' | 'stop' | 'muted';

const TONE_DOT: Record<Tone, string> = {
  good: 'bg-emerald-500',
  wait: 'bg-amber-500',
  stop: 'bg-red-500',
  muted: 'bg-text-muted',
};

export function CardShell({
  mine,
  label,
  kind,
  children,
}: {
  mine: boolean;
  label: string;
  kind: string;
  children: React.ReactNode;
}) {
  return (
    <article
      aria-label={label}
      data-chat-card={kind}
      className={`w-full max-w-[min(80%,24rem)] mt-1 overflow-hidden rounded-xl border border-border-subtle bg-surface text-text-primary ${
        mine ? 'ltr:rounded-tr-sm rtl:rounded-tl-sm' : 'ltr:rounded-tl-sm rtl:rounded-tr-sm'
      }`}
    >
      {children}
    </article>
  );
}

/** The card's kind, small, above its title — «عرض سعر», «طلب طباعة»… */
export function CardKicker({ icon: Icon, children }: { icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>; children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-1.5 text-[11px] font-semibold text-text-muted">
      <Icon className="w-3.5 h-3.5" aria-hidden />
      {children}
    </p>
  );
}

export function StatusLine({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  if (!children) return null;
  return (
    <p className="flex items-center gap-1.5 text-[12px] text-text-secondary" data-card-status>
      <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${TONE_DOT[tone]}`} aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

/** A fact of the deal: «المدة — ٣ أيام». Nothing is drawn for an empty value. */
export function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  if (children === null || children === undefined || children === '') return null;
  return (
    <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
      <dt className="text-text-muted shrink-0">{label}</dt>
      <dd dir="auto" className="text-text-primary text-end min-w-0 break-words">{children}</dd>
    </div>
  );
}

export function CardActions({ children }: { children: React.ReactNode }) {
  return <div className="mt-2 flex flex-wrap gap-2">{children}</div>;
}

export function CardButton({
  onClick,
  busy = false,
  disabled = false,
  variant = 'secondary',
  action,
  children,
}: {
  onClick: () => void;
  busy?: boolean;
  disabled?: boolean;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  action: string;
  children: React.ReactNode;
}) {
  const cls =
    variant === 'primary'
      ? 'lv-button lv-button-primary'
      : variant === 'ghost'
        ? 'lv-button lv-button-ghost'
        : variant === 'danger'
          ? 'lv-button lv-button-secondary text-danger'
          : 'lv-button lv-button-secondary';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || disabled}
      aria-busy={busy}
      data-card-action={action}
      className={`${cls} lv-button-sm ${variant === 'primary' ? 'flex-1' : ''}`}
    >
      {busy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
      {children}
    </button>
  );
}

/** A tone for a status, by what it asks of the reader. */
export function toneOf(status: string): Tone {
  if (['available', 'pending', 'open', 'receiving_offers', 'merchant_marked_delivered', 'delivered', 'superseded'].includes(status)) return 'wait';
  if (['accepted', 'purchased', 'completed', 'customer_confirmed', 'in_progress', 'funded', 'confirmed', 'processing', 'shipped', 'received'].includes(status)) return 'good';
  if (['disputed'].includes(status)) return 'stop';
  return 'muted';
}

/** A date the way the conversation shows it: «١٢ أكتوبر» / «12 Oct». */
export function shortDate(iso: unknown, lang: string): string {
  if (typeof iso !== 'string' || !iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(lang === 'en' ? 'en-GB' : 'ar-IQ-u-nu-latn', { day: 'numeric', month: 'short' });
}
