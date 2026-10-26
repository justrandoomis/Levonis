/**
 * THE COMMUNITY FIELDS (community UI plan B1; tokens.md §6 rows 14–17, 24).
 *
 * D-4: a TEXT field stays a well with its 3:1 line (`.lv-input`, the scoped
 * `--clay-field`), 48px; the reference draws them raised with no line, and
 * that one departure is deliberate (WCAG 1.4.11). What opens something is a
 * CONTROL and is raised: the search button that opens the search overlay,
 * the select row that opens a list.
 *
 *   SearchField   a well with the search glyph and a clear ×, typing in
 *                 place (with an optional debounce); or, with `onOpen`, the
 *                 raised button that opens the overlay
 *   CountedField  a labelled input or textarea with a clear × and the
 *                 «n / max» counter (read aloud as a sentence, warning at
 *                 90%, danger at the limit)
 *   SelectButton  a raised row: icon, label over value, optional swatch,
 *                 chevron; `aria-haspopup="listbox"`
 *   DropZone      a sunk zone that takes a click, the keyboard, a drop, and
 *                 on a touch screen the camera
 */
import React, { useEffect, useId, useRef, useState } from 'react';
import { Camera, ChevronDown, Search, UploadCloud, X } from 'lucide-react';
import { usePointerFine } from '../../../lib/useMediaQuery';
import { useKitStrings } from './strings';

const CLEAR =
  'absolute end-0.5 inline-flex h-11 w-11 items-center justify-center rounded-full text-text-muted transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';

export interface SearchFieldProps extends Omit<React.ComponentPropsWithRef<'input'>, 'value' | 'onChange' | 'type'> {
  /** The accessible name (the placeholder is an example, not a name). */
  label: string;
  value?: string;
  onValueChange?: (value: string) => void;
  /** Called once typing pauses for `debounceMs`. */
  onSettled?: (value: string) => void;
  debounceMs?: number;
  /** The overlay door: the field is a raised button that opens it. */
  onOpen?: () => void;
}

export function SearchField({ label, value = '', onValueChange, onSettled, debounceMs = 250, onOpen, placeholder, className = '', ...rest }: SearchFieldProps) {
  const s = useKitStrings();
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!onSettled) return;
    const t = setTimeout(() => onSettled(value), debounceMs);
    return () => clearTimeout(t);
  }, [value, debounceMs, onSettled]);

  if (onOpen) {
    return (
      <button type="button" onClick={onOpen} aria-haspopup="dialog" className={`cm-raised flex min-h-12 w-full items-center gap-3 rounded-md px-3.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${className}`}>
        <Search aria-hidden="true" className="h-5 w-5 shrink-0 text-text-secondary" />
        <span className="min-w-0 flex-1 truncate text-start text-[15px] text-text-muted">{placeholder ?? label}</span>
        <span className="sr-only">{label}</span>
      </button>
    );
  }
  return (
    <div className={`relative ${className}`}>
      <Search aria-hidden="true" className="pointer-events-none absolute start-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-text-muted" />
      <input
        {...rest}
        ref={input}
        type="search"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onValueChange?.(e.currentTarget.value)}
        className="lv-input cm-field min-h-12 ps-11 pe-11"
      />
      {value && (
        <button
          type="button"
          aria-label={s.clearSearch}
          onClick={() => {
            onValueChange?.('');
            input.current?.focus();
          }}
          className={`${CLEAR} top-1/2 -translate-y-1/2`}
        >
          <X aria-hidden="true" className="h-[18px] w-[18px]" />
        </button>
      )}
    </div>
  );
}

export interface CountedFieldProps {
  label: React.ReactNode;
  value: string;
  onValueChange: (value: string) => void;
  /** The server limit: the counter, and `maxLength`. */
  max?: number;
  multiline?: boolean;
  rows?: number;
  /** Writes «(اختياري)» after the label. */
  optional?: boolean;
  placeholder?: string;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  /** The clear × while there is a value (default on). */
  clearable?: boolean;
  disabled?: boolean;
  required?: boolean;
  id?: string;
  /** Left-to-right content in any language (a URL). */
  ltr?: boolean;
  className?: string;
}

/** «عنوان المشروع ٢١ / ١٠٠»: a labelled field, a clear ×, and the counter. */
export function CountedField({
  label,
  value,
  onValueChange,
  max,
  multiline = false,
  rows = 4,
  optional = false,
  placeholder,
  hint,
  error,
  clearable = true,
  disabled = false,
  required = false,
  id: idProp,
  ltr = false,
  className = '',
}: CountedFieldProps) {
  const s = useKitStrings();
  const auto = useId();
  const id = idProp ?? `cm-field-${auto}`;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const countId = max ? `${id}-count` : undefined;
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const n = [...value].length;
  const tone = max && n >= max ? 'text-danger' : max && n >= max * 0.9 ? 'text-warning' : 'text-text-muted';
  const common = {
    id,
    value,
    placeholder,
    disabled,
    required: required || undefined,
    maxLength: max,
    dir: ltr ? 'ltr' : undefined,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': [hintId, errorId, countId].filter(Boolean).join(' ') || undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onValueChange(e.currentTarget.value),
  };
  return (
    <div className={`min-w-0 ${className}`}>
      <label htmlFor={id} className="mb-2 block text-[15px] font-bold text-text-primary">
        {label}
        {optional && <span className="ms-1.5 font-normal text-text-muted">{s.optional}</span>}
      </label>
      <div className="relative">
        {multiline ? (
          <textarea {...common} ref={ref} rows={rows} className={`lv-input min-h-[120px] resize-y py-3 leading-relaxed disabled:cursor-not-allowed disabled:opacity-40 ${clearable ? 'pe-11' : ''}`} />
        ) : (
          <input {...common} ref={ref} type="text" className={`lv-input min-h-12 disabled:cursor-not-allowed disabled:opacity-40 ${clearable ? 'pe-11' : ''}`} />
        )}
        {clearable && value && !disabled && (
          <button
            type="button"
            aria-label={s.clear}
            onClick={() => {
              onValueChange('');
              ref.current?.focus();
            }}
            className={`${CLEAR} ${multiline ? 'top-0.5' : 'top-1/2 -translate-y-1/2'}`}
          >
            <X aria-hidden="true" className="h-[18px] w-[18px]" />
          </button>
        )}
      </div>
      {(hint || max) && (
        <div className="mt-1.5 flex items-start justify-between gap-3">
          {hint ? <p id={hintId} className="min-w-0 text-ui-xs text-text-muted">{hint}</p> : <span />}
          {max ? (
            <>
              <span aria-hidden="true" dir="ltr" className={`shrink-0 text-ui-xs tabular-nums ${tone}`}>
                {n} / {max}
              </span>
              <span id={countId} className="sr-only">
                {s.counter(n, max)}
              </span>
            </>
          ) : null}
        </div>
      )}
      {error && (
        <p id={errorId} className="lv-field-error">
          {error}
        </p>
      )}
    </div>
  );
}

export interface SelectButtonProps extends Omit<React.ComponentPropsWithRef<'button'>, 'value' | 'children'> {
  /** The small label over the value («الخامة»), or none for a bare value row. */
  label?: React.ReactNode;
  value?: React.ReactNode;
  /** Shown muted while there is no value (defaults to «اختر»). */
  placeholder?: React.ReactNode;
  icon?: React.ReactNode;
  /** A CSS colour: the 24px swatch before the chevron (a filament colour). */
  swatch?: string;
  expanded?: boolean;
}

/** «الخامة PETG ⌄»: a raised control that opens a list (a sheet or a menu). */
export function SelectButton({ label, value, placeholder, icon, swatch, expanded, className = '', type = 'button', ...rest }: SelectButtonProps) {
  const s = useKitStrings();
  const empty = value === undefined || value === null || value === '';
  return (
    <button
      {...rest}
      type={type}
      aria-haspopup="listbox"
      aria-expanded={expanded}
      className={`cm-raised flex w-full items-center gap-3 rounded-md px-3.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${label ? 'min-h-14' : 'min-h-12'} ${className}`}
    >
      {icon && (
        <span aria-hidden="true" className="shrink-0 text-text-secondary">
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1 text-start">
        {label && <span className="block text-ui-xs text-text-muted">{label}</span>}
        <span className={`block truncate text-[15px] ${empty ? 'text-text-muted' : ''}`}>{empty ? (placeholder ?? s.choose) : value}</span>
      </span>
      {swatch && <span aria-hidden="true" className="cm-line size-6 shrink-0 rounded-full" style={{ background: swatch }} />}
      <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-text-secondary" />
    </button>
  );
}

export interface DropZoneProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** The formats line under the zone («الصيغ المدعومة: STL · 3MF …»). */
  formats?: React.ReactNode;
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  onFiles: (files: File[]) => void;
  /** On a touch screen, a second door straight to the camera. */
  cameraLabel?: string;
  className?: string;
}

/** «أضف ملفًا أو صورة»: click, Enter or Space, drag and drop, or the camera on touch. */
export function DropZone({ title, subtitle, formats, accept, multiple = true, disabled = false, onFiles, cameraLabel, className = '' }: DropZoneProps) {
  const fine = usePointerFine();
  const [over, setOver] = useState(false);
  const pick = useRef<HTMLInputElement | null>(null);
  const shoot = useRef<HTMLInputElement | null>(null);
  const take = (list: FileList | null) => {
    const files = list ? Array.from(list) : [];
    if (files.length) onFiles(multiple ? files : files.slice(0, 1));
  };
  const formatsId = useId();
  return (
    <div className={className}>
      <button
        type="button"
        disabled={disabled}
        data-over={over || undefined}
        aria-describedby={formats ? formatsId : undefined}
        onClick={() => pick.current?.click()}
        onDragOver={(e) => {
          if (disabled) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (!disabled) take(e.dataTransfer.files);
        }}
        className="cm-drop flex min-h-28 w-full flex-col items-center justify-center gap-1 rounded-md p-3 text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-40"
      >
        <UploadCloud aria-hidden="true" className="h-8 w-8 text-text-secondary" strokeWidth={1.5} />
        <span className="text-[15px] font-bold text-text-primary">{title}</span>
        {subtitle && <span className="text-ui-sm text-text-muted">{subtitle}</span>}
      </button>
      <input ref={pick} type="file" hidden accept={accept} multiple={multiple} onChange={(e) => take(e.currentTarget.files)} />
      {cameraLabel && !fine && (
        <>
          <button type="button" disabled={disabled} onClick={() => shoot.current?.click()} className="mt-1 inline-flex min-h-11 items-center gap-1 text-[13px] font-semibold text-gold">
            <Camera aria-hidden="true" className="h-4 w-4" />
            <span>{cameraLabel}</span>
          </button>
          <input ref={shoot} type="file" hidden accept="image/*" capture="environment" onChange={(e) => take(e.currentTarget.files)} />
        </>
      )}
      {formats && (
        <p id={formatsId} className="mt-2 text-center text-ui-xs text-text-muted">
          {formats}
        </p>
      )}
    </div>
  );
}
