/**
 * The four presentational pieces the member profile is built out of.
 *
 * THE OWNER'S COMPLAINT WAS ABOUT ORDER, NOT ABOUT PIXELS: «أريد ترتيب أكثر
 * وإضافة تفاصيل أكثر». A flat stack of identical cards is what produced it —
 * twenty facts, all drawn at the same weight, in one column, so the eye has to
 * read every one of them to find the one it came for. So there are exactly
 * three levels here and no more:
 *
 *   Stat     the handful of numbers a decision is actually made on, big,
 *            across the top, readable without reading.
 *   Section  a titled group, so a fact can be FOUND by the question it
 *            answers rather than by scanning.
 *   Row      one label and one value inside a group, label muted, value not,
 *            because they are not equally important and drawing them equally
 *            is what makes a card unreadable.
 *
 * Clay (docs/DECISIONS.md rows 207–209): a Section and a Stat are `lv-surface`
 * cards, and since this window is an overlay panel they sit FLUSH inside it
 * (the rim only — one raised container per stack). Rows are flat with
 * hairline dividers; a Pill is information, a flat opaque `lv-chip`.
 */

import React from 'react';

export function Section({
  title,
  icon,
  note,
  children,
  className = '',
  testId,
}: {
  title: string;
  icon?: React.ReactNode;
  /** A sentence under the title, for a rule the admin has to know to read the
   *  section correctly (what a figure counts, where evidence really opens). */
  note?: string;
  children: React.ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <section
      data-member-section={testId}
      className={`lv-surface p-4 ${className}`}
    >
      <h4 className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-text-muted">
        {icon}
        <span>{title}</span>
      </h4>
      {note && <p className="mt-1.5 text-[11px] leading-relaxed text-text-muted">{note}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

/**
 * One fact. `dir="auto"` on the VALUE and not on the row: an email, a phone
 * number and an IQD amount are latin-leading strings sitting in an Arabic
 * column, and without it the browser pushes their punctuation to the wrong end
 * — a phone number renders as `964+` and an admin reads a number that is not
 * the one stored.
 */
export function Row({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 border-b border-border-subtle last:border-0">
      <span className="shrink-0 text-xs font-medium text-text-muted">{label}</span>
      <span
        dir="auto"
        className={`min-w-0 text-end text-[13px] font-semibold text-text-primary break-words ${mono ? 'tabular-nums' : ''}`}
      >
        {value}
      </span>
    </div>
  );
}

/** A headline number. `tone` carries meaning, never decoration. */
export function Stat({
  label,
  value,
  sub,
  tone = 'plain',
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  tone?: 'plain' | 'money' | 'warn';
}) {
  const color = tone === 'money' ? 'text-mint' : tone === 'warn' ? 'text-gilt' : 'text-white';
  return (
    <div className="lv-surface px-3 py-2.5">
      <div className="text-[10px] font-bold uppercase tracking-wider text-text-muted">{label}</div>
      <div dir="auto" className={`mt-1 text-lg font-black tabular-nums ${color}`}>
        {value}
      </div>
      {sub && <div className="mt-0.5 text-[11px] font-medium text-text-muted">{sub}</div>}
    </div>
  );
}

export type PillTone = 'zinc' | 'violet' | 'gold' | 'green' | 'red' | 'blue';

const PILL: Record<PillTone, string> = {
  zinc: 'bg-surface-selected text-text-secondary',
  violet: 'lv-chip [--chip:var(--color-info)]',
  gold: 'lv-chip [--chip:var(--color-gold)]',
  green: 'lv-chip [--chip:var(--color-success)]',
  red: 'lv-chip [--chip:var(--color-danger)] [--chip-ink:var(--color-error-ink)]',
  blue: 'lv-chip [--chip:var(--color-info)]',
};

export function Pill({
  children,
  tone = 'zinc',
  icon,
}: {
  children: React.ReactNode;
  tone?: PillTone;
  icon?: React.ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-bold ${PILL[tone]}`}
    >
      {icon}
      {children}
    </span>
  );
}

/**
 * Dates are shown in the reader's own locale, from the stored ISO instant.
 *
 * NO DAY ARITHMETIC HAPPENS HERE, on purpose. Baghdad is UTC+3, so for three
 * hours every night a date computed by cutting a UTC timestamp at midnight is
 * the previous day — the failure worker/lib/baghdadTime.ts exists for. An
 * instant rendered through `toLocaleString` carries the viewer's real offset
 * and cannot go wrong that way; the moment this screen wants "orders today" it
 * must ask the server, not subtract dates here.
 */
export function whenLabel(iso: string | null | undefined, fallback: string): string {
  if (!iso) return fallback;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return fallback;
  return d.toLocaleString();
}

export function dayLabelOf(iso: string | null | undefined, fallback: string): string {
  if (!iso) return fallback;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return fallback;
  return d.toLocaleDateString();
}
