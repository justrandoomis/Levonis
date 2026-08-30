/**
 * Primitives for the rebuilt product form — mandate §1.
 *
 * The sizing rules are not decoration, they are the acceptance criteria:
 *   - a control is 44px tall (h-11) and its text is 14–16px: big enough to
 *     tap on an iPad, small enough that a section fits on one screen;
 *   - a textarea starts at a usable height and STOPS growing (max-h + scroll),
 *     so one long description cannot push the save bar off the page;
 *   - every grid track is minmax(0,1fr) and every flex child that holds text
 *     carries min-w-0. Without those two, a long SKU or URL widens the track
 *     and the whole admin page scrolls sideways — which §12 tests for at 360,
 *     390, 768, 1024 and 1440px;
 *   - labels are Arabic-first with a small English secondary (the admin panel
 *     is RTL), but every INPUT is dir="ltr" because §3 makes the entered text
 *     English only.
 */

import React, { useId, useState, type ReactNode } from 'react';
import { ChevronDown, Info } from 'lucide-react';

/** 44px control, 14px text, never wider than its track. */
export const field =
  'w-full min-w-0 h-11 bg-zinc-800/40 border border-zinc-700 rounded-lg px-3 text-sm text-white ' +
  'placeholder:text-zinc-600 focus:border-[#6B46FF] focus:ring-1 focus:ring-[#6B46FF]/50 focus:outline-none ' +
  'transition-colors disabled:opacity-50';

/** Same, for a multi-line value that must not grow without bound. */
export const area =
  'w-full min-w-0 min-h-[96px] max-h-[240px] overflow-y-auto bg-zinc-800/40 border border-zinc-700 rounded-lg ' +
  'px-3 py-2 text-sm leading-relaxed text-white placeholder:text-zinc-600 focus:border-[#6B46FF] ' +
  'focus:ring-1 focus:ring-[#6B46FF]/50 focus:outline-none transition-colors resize-y';

export const btn =
  'inline-flex items-center justify-center gap-1.5 h-11 px-3.5 rounded-lg text-sm font-bold transition-colors ' +
  'disabled:opacity-50 disabled:cursor-not-allowed shrink-0';
export const btnPrimary = `${btn} bg-[#6B46FF] hover:bg-[#5a3ae0] text-white`;
export const btnGhost = `${btn} bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700`;
export const btnDanger = `${btn} bg-red-500/10 hover:bg-red-500/20 text-red-300 border border-red-500/30`;
/** A small square icon button that still meets the 44px touch target. */
export const iconBtn =
  'inline-flex items-center justify-center w-11 h-11 rounded-lg text-zinc-400 hover:text-white ' +
  'hover:bg-zinc-800 transition-colors shrink-0';

/**
 * Responsive field grid. One column on a phone, two on a tablet, and — only
 * for short controls — three on a wide screen (§1). `minmax(0,1fr)` rather
 * than `1fr` is what stops a long value from widening the page.
 */
export function Grid({ cols = 2, children }: { cols?: 1 | 2 | 3; children: ReactNode }) {
  const cls =
    cols === 1
      ? 'grid gap-3 [grid-template-columns:minmax(0,1fr)]'
      : cols === 2
        ? 'grid gap-3 [grid-template-columns:minmax(0,1fr)] md:[grid-template-columns:repeat(2,minmax(0,1fr))]'
        : 'grid gap-3 [grid-template-columns:minmax(0,1fr)] md:[grid-template-columns:repeat(2,minmax(0,1fr))] xl:[grid-template-columns:repeat(3,minmax(0,1fr))]';
  return <div className={cls}>{children}</div>;
}

/**
 * One labelled field. `hint` is a SHORT helper line; anything longer belongs
 * in the tooltip, because §1 forbids long technical prose inside the form.
 */
export function Field({
  ar,
  en,
  hint,
  tip,
  required,
  error,
  children,
  span,
}: {
  ar: string;
  en: string;
  hint?: string;
  tip?: string;
  required?: boolean;
  error?: string | null;
  children: ReactNode;
  /** Make the field take the full row in a multi-column grid. */
  span?: boolean;
}) {
  const id = useId();
  return (
    <div className={`min-w-0 ${span ? 'md:col-span-2 xl:col-span-3' : ''}`}>
      <div className="flex items-center gap-1.5 mb-1.5 min-w-0">
        <label htmlFor={id} className="text-[13px] font-bold text-zinc-300 truncate">
          {ar} <span className="text-[11px] font-medium text-zinc-500">{en}</span>
          {required && <span className="text-red-400 ms-1">*</span>}
        </label>
        {tip && (
          <span className="group relative shrink-0">
            <Info className="w-3.5 h-3.5 text-zinc-600" aria-hidden="true" />
            <span className="sr-only">{tip}</span>
            <span
              role="tooltip"
              className="pointer-events-none absolute z-20 start-0 top-5 hidden group-hover:block group-focus-within:block
                         w-56 max-w-[70vw] rounded-lg bg-zinc-950 border border-zinc-700 p-2 text-[11px] leading-snug text-zinc-300 shadow-xl"
            >
              {tip}
            </span>
          </span>
        )}
      </div>
      {React.isValidElement(children)
        ? React.cloneElement(children as React.ReactElement<{ id?: string }>, { id })
        : children}
      {hint && !error && <p className="mt-1 text-[11px] text-zinc-500 truncate">{hint}</p>}
      {error && <p className="mt-1 text-[11px] text-red-400">{error}</p>}
    </div>
  );
}

/** English text input — always LTR, per §1/§3. */
export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input dir="ltr" {...props} className={`${field} ${props.className ?? ''}`} />;
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea dir="ltr" rows={4} {...props} className={`${area} ${props.className ?? ''}`} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative min-w-0">
      <select {...props} className={`${field} appearance-none pe-9 ${props.className ?? ''}`} />
      <ChevronDown className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
    </div>
  );
}

/**
 * Integer IQD money input. EMPTY means "inherit / not set" (null) and an
 * explicit 0 is a real price — never a truthiness check, because a genuinely
 * free item and an unset price are different facts.
 */
export function Money({
  value,
  onChange,
  placeholder,
  required,
  id,
  disabled,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  placeholder?: string;
  required?: boolean;
  id?: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState(value === null ? '' : String(value));
  const [touched, setTouched] = useState(false);
  // Follow the model when it changes from outside (load, reset, import).
  React.useEffect(() => {
    if (!touched) setText(value === null ? '' : String(value));
  }, [value, touched]);
  return (
    <input
      id={id}
      dir="ltr"
      inputMode="numeric"
      disabled={disabled}
      className={field}
      placeholder={placeholder ?? (required ? '0' : 'يرث / inherit')}
      value={text}
      onChange={(e) => {
        const raw = e.target.value.replace(/[^\d]/g, '');
        setTouched(true);
        setText(raw);
        onChange(raw === '' ? null : Number(raw));
      }}
      onBlur={() => setTouched(false)}
    />
  );
}

/** Integer quantity input with the same null-vs-zero contract. */
export function Qty({
  value,
  onChange,
  id,
  placeholder,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  id?: string;
  placeholder?: string;
}) {
  return (
    <Money value={value} onChange={onChange} id={id} placeholder={placeholder ?? 'غير محدود / untracked'} />
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  sub,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  sub?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`flex items-center justify-between gap-3 w-full min-w-0 h-11 px-3 rounded-lg border text-sm text-start transition-colors ${
        checked ? 'bg-[#6B46FF]/10 border-[#6B46FF]/50 text-white' : 'bg-zinc-800/40 border-zinc-700 text-zinc-300'
      }`}
    >
      <span className="min-w-0 truncate">
        {label}
        {sub && <span className="text-[11px] text-zinc-500 ms-1.5">{sub}</span>}
      </span>
      <span
        className={`relative w-9 h-5 rounded-full shrink-0 transition-colors ${checked ? 'bg-[#6B46FF]' : 'bg-zinc-600'}`}
      >
        <span
          className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${checked ? 'start-[18px]' : 'start-0.5'}`}
        />
      </span>
    </button>
  );
}

/** Multi-select card, used for sale types (§6) and facets. */
export function CheckCard({
  checked,
  onChange,
  title,
  sub,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  sub?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`min-w-0 text-start rounded-lg border p-3 transition-colors ${
        checked
          ? 'bg-[#6B46FF]/10 border-[#6B46FF]/60'
          : 'bg-zinc-800/30 border-zinc-700 hover:border-zinc-600'
      }`}
    >
      <span className="flex items-center gap-2 min-w-0">
        <span
          className={`w-4 h-4 rounded border shrink-0 flex items-center justify-center ${
            checked ? 'bg-[#6B46FF] border-[#6B46FF]' : 'border-zinc-600'
          }`}
        >
          {checked && (
            <svg viewBox="0 0 12 12" className="w-3 h-3 text-white" aria-hidden="true">
              <path d="M2 6.5l2.5 2.5L10 3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          )}
        </span>
        <span className="text-sm font-bold text-white truncate">{title}</span>
      </span>
      {sub && <span className="block mt-1 text-[11px] text-zinc-500 truncate">{sub}</span>}
    </button>
  );
}

/**
 * A form section. Collapsed sections show a one-line summary and an item
 * count, so an admin can see what is inside without opening it (§1). Only ONE
 * heavy section is open at a time — the parent decides which.
 */
export function SectionCard({
  n,
  ar,
  en,
  summary,
  count,
  open,
  onToggle,
  error,
  children,
}: {
  n: number;
  ar: string;
  en: string;
  summary?: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
  error?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className={`min-w-0 rounded-xl border overflow-hidden mb-2.5 ${
        error ? 'border-red-500/50 bg-red-500/[0.03]' : 'border-zinc-800 bg-zinc-900/40'
      }`}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="w-full min-w-0 flex items-center gap-2.5 px-3 h-12 text-start hover:bg-zinc-800/30 transition-colors"
      >
        <span
          className={`shrink-0 w-6 h-6 rounded-md grid place-items-center text-[11px] font-black ${
            open ? 'bg-[#6B46FF] text-white' : 'bg-zinc-800 text-zinc-400'
          }`}
        >
          {n}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-bold text-white truncate">
            {ar}
            {/* The English secondary is dropped on a phone: at 360-390px it
                pushed the Arabic title into an ellipsis, and the number plus
                the Arabic title already identify the section. */}
            <span className="hidden sm:inline text-[11px] font-medium text-zinc-500"> {en}</span>
          </span>
          {!open && summary && <span className="block text-[11px] text-zinc-500 truncate">{summary}</span>}
        </span>
        {count !== undefined && count > 0 && (
          <span className="shrink-0 min-w-6 h-5 px-1.5 rounded-full bg-zinc-800 text-[11px] font-bold text-zinc-300 grid place-items-center">
            {count}
          </span>
        )}
        <ChevronDown
          className={`shrink-0 w-4 h-4 text-zinc-500 transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>
      {open && <div className="p-3 border-t border-zinc-800/70 min-w-0">{children}</div>}
    </section>
  );
}

/** A small inline row of repeated items (options, colours) with a header. */
export function Repeater({
  title,
  onAdd,
  addLabel,
  children,
  empty,
}: {
  title: string;
  onAdd: () => void;
  addLabel: string;
  children: ReactNode;
  empty?: string;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2 mb-2 min-w-0">
        <h4 className="text-[13px] font-bold text-zinc-300 truncate">{title}</h4>
        <button type="button" onClick={onAdd} className={`${btnGhost} h-9 px-2.5 text-[12px]`}>
          + {addLabel}
        </button>
      </div>
      {React.Children.count(children) === 0 && empty ? (
        <p className="text-[12px] text-zinc-500 py-2">{empty}</p>
      ) : (
        <div className="space-y-2 min-w-0">{children}</div>
      )}
    </div>
  );
}

export function Banner({ kind, children }: { kind: 'error' | 'warn' | 'ok'; children: ReactNode }) {
  const cls =
    kind === 'error'
      ? 'bg-red-500/10 border-red-500/40 text-red-200'
      : kind === 'warn'
        ? 'bg-amber-500/10 border-amber-500/40 text-amber-100'
        : 'bg-emerald-500/10 border-emerald-500/40 text-emerald-100';
  return (
    <div className={`min-w-0 rounded-lg border px-3 py-2 text-[12px] leading-snug mb-2.5 ${cls}`}>{children}</div>
  );
}
