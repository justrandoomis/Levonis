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
 * The palette is AdminUsers.tsx's own zinc family rather than the shared admin
 * tokens: this window is opened out of that table and sits over it, and a
 * window that does not match the surface it grew out of reads as a different
 * application.
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
      className={`rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 ${className}`}
    >
      <h4 className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-zinc-500">
        {icon}
        <span>{title}</span>
      </h4>
      {note && <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-500">{note}</p>}
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
    <div className="flex items-start justify-between gap-3 py-1.5 border-b border-zinc-800/60 last:border-0">
      <span className="shrink-0 text-xs font-medium text-zinc-500">{label}</span>
      <span
        dir="auto"
        className={`min-w-0 text-end text-[13px] font-semibold text-zinc-200 break-words ${mono ? 'tabular-nums' : ''}`}
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
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 px-3 py-2.5">
      <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">{label}</div>
      <div dir="auto" className={`mt-1 text-lg font-black tabular-nums ${color}`}>
        {value}
      </div>
      {sub && <div className="mt-0.5 text-[11px] font-medium text-zinc-500">{sub}</div>}
    </div>
  );
}

export type PillTone = 'zinc' | 'violet' | 'gold' | 'green' | 'red' | 'blue';

const PILL: Record<PillTone, string> = {
  zinc: 'bg-zinc-800 text-zinc-300 border-zinc-700',
  violet: 'bg-iris/10 text-iris border-iris/30',
  gold: 'bg-gilt/10 text-gilt border-gilt/30',
  green: 'bg-mint/10 text-mint border-mint/30',
  red: 'bg-red-500/10 text-red-400 border-red-500/30',
  blue: 'bg-blue-500/10 text-blue-300 border-blue-500/30',
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
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-bold ${PILL[tone]}`}
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
