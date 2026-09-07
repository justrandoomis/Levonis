/**
 * Input primitives for the farm balancing console, on formUi's 40px control
 * geometry. Every box is dir="ltr": the values are keys, numbers and hex codes,
 * Latin in every UI language. Labels around them follow the page direction
 * and use logical properties only.
 */
import React, { useEffect, useId, useState, type ReactNode } from 'react';
import { Plus, X } from 'lucide-react';
import { field, btn, btnGhost } from '../adminProducts/form/formUi';
import type { FarmAdminStrings } from './strings';

/** A labelled field: primary label in the UI language, a secondary in English (or Arabic when the UI is English), a hint, the default, an error. */
export function FarmField({
  label,
  secondary,
  hint,
  defaultText,
  error,
  span,
  htmlFor,
  path,
  children,
}: {
  label: string;
  secondary?: string;
  hint?: string;
  defaultText?: string;
  error?: string | null;
  span?: boolean;
  htmlFor?: string;
  /** The dotted path, as a probe for tests and for the admin's eye. */
  path: string;
  children: ReactNode;
}) {
  const auto = useId();
  const id = htmlFor ?? auto;
  return (
    <div className={`min-w-0 ${span ? 'md:col-span-2 xl:col-span-3' : ''}`} data-farm-field={path}>
      <label htmlFor={id} className="flex items-baseline gap-1.5 mb-1 min-w-0 text-[12px] font-bold text-zinc-300">
        <span className="truncate">{label}</span>
        {secondary && secondary !== label && (
          <span className="text-[10px] font-medium text-zinc-500 truncate">{secondary}</span>
        )}
      </label>
      {React.isValidElement(children) && !htmlFor
        ? React.cloneElement(children as React.ReactElement<{ id?: string }>, { id })
        : children}
      {error ? (
        <p className="mt-1 text-[11px] text-red-400">{error}</p>
      ) : (
        (hint || defaultText) && (
          <p className="mt-1 text-[11px] text-zinc-500 leading-snug">
            {hint && <span>{hint}</span>}
            {hint && defaultText && <span aria-hidden="true"> · </span>}
            {defaultText && <span className="tabular-nums" dir="auto">{defaultText}</span>}
          </p>
        )
      )}
    </div>
  );
}

/**
 * A number box that lets a decimal be TYPED. The value upstream is a number,
 * but "0." and "" are states a keyboard passes through on the way to one, so
 * the box keeps its own text while it has focus and re-syncs from the number
 * on blur (the PrintPricingAdmin rule). `integer` strips a decimal point as it
 * is typed; `unit` is painted inside the box, `preview` beside it.
 */
export function NumInput({
  value,
  onChange,
  integer,
  step,
  min,
  max,
  unit,
  preview,
  placeholder,
  id,
  ariaLabel,
  disabled,
  className = '',
}: {
  value: number;
  onChange: (v: number) => void;
  integer?: boolean;
  step?: number;
  min?: number;
  max?: number;
  unit?: string;
  preview?: string;
  placeholder?: string;
  id?: string;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [text, setText] = useState(() => String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(String(value));
  }, [value, focused]);
  return (
    <div className={`flex items-center gap-2 min-w-0 ${className}`}>
      <div className="relative min-w-0 flex-1">
        <input
          id={id}
          aria-label={ariaLabel}
          type="text"
          inputMode={integer ? 'numeric' : 'decimal'}
          dir="ltr"
          disabled={disabled}
          placeholder={placeholder}
          value={text}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            setText(String(value));
          }}
          onChange={(e) => {
            let raw = e.target.value.replace(integer ? /[^\d-]/g : /[^\d.-]/g, '');
            // one leading minus at most, one dot at most
            raw = raw.replace(/(?!^)-/g, '').replace(/(\..*)\./g, '$1');
            setText(raw);
            if (raw === '' || raw === '-' || raw === '.' || raw.endsWith('.')) return;
            const n = Number(raw);
            if (!Number.isFinite(n)) return;
            let next = integer ? Math.round(n) : n;
            if (min !== undefined && next < min) next = min;
            if (max !== undefined && next > max) next = max;
            onChange(next);
          }}
          data-step={step}
          className={`${field} tabular-nums ${unit ? 'pe-12' : ''}`}
        />
        {unit && (
          <span aria-hidden="true" className="pointer-events-none absolute end-2.5 top-1/2 -translate-y-1/2 text-[11px] text-zinc-500">
            {unit}
          </span>
        )}
      </div>
      {preview && (
        <span className="shrink-0 text-[11px] text-gold tabular-nums whitespace-nowrap" dir="ltr">
          {preview}
        </span>
      )}
    </div>
  );
}

export function TextBox({
  value,
  onChange,
  placeholder,
  id,
  ariaLabel,
  disabled,
  mono,
  invalid,
  rtl,
  list,
  onBlur,
  onEnter,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  id?: string;
  ariaLabel?: string;
  disabled?: boolean;
  mono?: boolean;
  invalid?: boolean;
  /** A translated name reads in its own direction; keys and codes stay LTR. */
  rtl?: boolean;
  /** id of a <datalist> offering known values (suggestions, never a constraint). */
  list?: string;
  onBlur?: () => void;
  /** Enter commits (a key rename, a lookup) without a form around the box. */
  onEnter?: () => void;
}) {
  return (
    <input
      id={id}
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      type="text"
      dir={rtl ? 'rtl' : 'ltr'}
      disabled={disabled}
      placeholder={placeholder}
      value={value}
      list={list}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && onEnter) {
          e.preventDefault();
          onEnter();
        }
      }}
      autoComplete="off"
      spellCheck={false}
      className={`${field} ${mono ? 'font-mono' : ''} ${invalid ? 'border-red-500/60' : ''}`}
    />
  );
}

/** The panel's primary action: the house gold on black, never the product form's purple. */
export const btnGold = `${btn} bg-gold hover:bg-[#c9b57a] text-black`;

/** A boolean as a switch, in the panel's gold. `label` is the state word (on / off) the admin reads. */
export function Switch({
  checked,
  onChange,
  label,
  id,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  id?: string;
  disabled?: boolean;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`flex items-center justify-between gap-3 w-full min-w-0 h-10 px-2.5 rounded-lg border text-[13px] text-start transition-colors disabled:opacity-50 ${
        checked ? 'bg-gold/10 border-gold/50 text-white' : 'bg-zinc-800/40 border-zinc-700 text-zinc-300'
      }`}
    >
      <span className="min-w-0 truncate">{label}</span>
      <span
        aria-hidden="true"
        className={`relative w-9 h-5 rounded-full shrink-0 transition-colors motion-reduce:transition-none ${checked ? 'bg-gold' : 'bg-zinc-600'}`}
      >
        <span
          className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all motion-reduce:transition-none ${checked ? 'start-[18px]' : 'start-0.5'}`}
        />
      </span>
    </button>
  );
}

/** A list of string keys as removable chips with an add box. */
export function ChipEditor({
  value,
  onChange,
  s,
  suggestions,
  id,
  placeholder,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  s: FarmAdminStrings;
  /** Known keys (e.g. material keys) offered as a datalist. */
  suggestions?: string[];
  id?: string;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState('');
  const listId = useId();
  const add = () => {
    const k = draft.trim();
    if (!k) return;
    if (!value.includes(k)) onChange([...value, k]);
    setDraft('');
  };
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap gap-1.5 mb-1.5 min-h-[1.5rem]">
        {value.length === 0 && <span className="text-[11px] text-zinc-600">{s.emptyList}</span>}
        {value.map((k) => (
          <span
            key={k}
            className="inline-flex items-center gap-1 h-7 ps-2.5 pe-1 rounded-full bg-zinc-800 border border-zinc-700 text-[12px] text-zinc-100 font-mono"
            dir="ltr"
          >
            {k}
            <button
              type="button"
              aria-label={s.removeChip(k)}
              onClick={() => onChange(value.filter((x) => x !== k))}
              className="w-5 h-5 rounded-full grid place-items-center text-zinc-400 hover:text-red-300 hover:bg-zinc-700"
            >
              <X className="w-3 h-3" aria-hidden="true" />
            </button>
          </span>
        ))}
      </div>
      <div className="flex items-center gap-2 min-w-0">
        <input
          id={id}
          type="text"
          dir="ltr"
          list={suggestions && suggestions.length ? listId : undefined}
          value={draft}
          placeholder={placeholder ?? s.chipPlaceholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          autoComplete="off"
          spellCheck={false}
          className={`${field} font-mono`}
        />
        {suggestions && suggestions.length > 0 && (
          <datalist id={listId}>
            {suggestions.map((k) => (
              <option key={k} value={k} />
            ))}
          </datalist>
        )}
        <button type="button" onClick={add} className={`${btnGhost} h-10`} aria-label={s.addChip}>
          <Plus className="w-4 h-4" aria-hidden="true" />
          <span className="hidden sm:inline">{s.addChip}</span>
        </button>
      </div>
    </div>
  );
}

/** A list of numbers (spool sizes, level thresholds, a [x, y, z] volume) as small boxes. */
export function NumListEditor({
  value,
  onChange,
  s,
  integer,
  unit,
  defaults,
  fixedLength,
  id,
}: {
  value: number[];
  onChange: (v: number[]) => void;
  s: FarmAdminStrings;
  integer: boolean;
  unit?: string;
  defaults?: number[];
  /** A tuple (volume, size, range) keeps its length. */
  fixedLength?: boolean;
  id?: string;
}) {
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap gap-1.5 items-center">
        {value.length === 0 && <span className="text-[11px] text-zinc-600">{s.emptyList}</span>}
        {value.map((n, i) => (
          <div key={i} className="flex items-center gap-1 min-w-0">
            <NumInput
              id={i === 0 ? id : undefined}
              ariaLabel={`${i + 1}`}
              value={n}
              integer={integer}
              unit={unit}
              placeholder={defaults && typeof defaults[i] === 'number' ? String(defaults[i]) : undefined}
              onChange={(v) => onChange(value.map((x, j) => (j === i ? v : x)))}
              className="w-28"
            />
            {!fixedLength && (
              <button
                type="button"
                aria-label={s.removeNumber(i + 1)}
                onClick={() => onChange(value.filter((_, j) => j !== i))}
                className="w-7 h-7 rounded-md grid place-items-center text-zinc-500 hover:text-red-300 hover:bg-zinc-800"
              >
                <X className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
        ))}
        {!fixedLength && (
          <button
            type="button"
            onClick={() => onChange([...value, value.length ? value[value.length - 1] : 0])}
            className={`${btnGhost} h-8 px-2.5 text-[12px]`}
          >
            <Plus className="w-3.5 h-3.5" aria-hidden="true" />
            {s.addNumber}
          </button>
        )}
      </div>
    </div>
  );
}
