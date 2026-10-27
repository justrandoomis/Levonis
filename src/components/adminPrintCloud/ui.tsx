/**
 * PRINT CLOUD ADMIN — the pieces every section shares, built on the admin kit
 * (src/components/adminProducts/theme.ts: `T.input`, `T.select`, `T.btn*`,
 * `T.chip`, `T.surface`, `T.pageBtn`) and the house primitives
 * (src/components/ui/*: StatusChip, Money, EmptyState, ErrorState, Spinner).
 * No hand-drawn control: the clay census counts admin screens too.
 *
 * Every utility class here is one the app already compiles — this console
 * adds rules to nobody's first stylesheet.
 */
import React, { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, RefreshCw } from 'lucide-react';
import * as T from '../adminProducts/theme';
import { StatusChip, type Tone } from '../ui/Badge';
import { EmptyState, ErrorState } from '../ui/AsyncStates';
import Spinner from '../ui/Spinner';
import { useLanguage } from '../../LanguageContext';
import { pick, tri, labelOf, type Lang, type Tri } from './i18n';
import { pcRefusal } from './refusal';
import { shortId } from './format';

export { T };

/** The reader's language as this console's key. */
export function usePcLang(): { lang: Lang; dir: 'rtl' | 'ltr'; t: (x: Tri) => string } {
  const { lang, dir } = useLanguage();
  const l: Lang = lang === 'en' || lang === 'ckb' ? lang : 'ar';
  return { lang: l, dir, t: (x: Tri) => pick(x, l) };
}

export const W = {
  refresh: tri('تحديث', 'Refresh', 'نوێکردنەوە'),
  loading: tri('جارٍ التحميل…', 'Loading…', 'بارکردن…'),
  save: tri('حفظ', 'Save', 'پاشەکەوتکردن'),
  saving: tri('جارٍ الحفظ…', 'Saving…', 'پاشەکەوت دەکرێت…'),
  cancel: tri('إلغاء', 'Cancel', 'هەڵوەشاندنەوە'),
  close: tri('إغلاق', 'Close', 'داخستن'),
  back: tri('رجوع', 'Back', 'گەڕانەوە'),
  open: tri('فتح', 'Open', 'کردنەوە'),
  edit: tri('تعديل', 'Edit', 'دەستکاری'),
  create: tri('إنشاء', 'Create', 'دروستکردن'),
  yes: tri('نعم', 'Yes', 'بەڵێ'),
  no: tri('لا', 'No', 'نەخێر'),
  all: tri('الكل', 'All', 'هەموو'),
  none: tri('لا شيء', 'None', 'هیچ'),
  copy: tri('نسخ', 'Copy', 'لەبەرگرتنەوە'),
  copied: tri('نُسخ', 'Copied', 'لەبەرگیرایەوە'),
  failed: tri('تعذّر التنفيذ — حاول مجدداً.', 'That did not go through — try again.', 'ئەنجام نەدرا — دووبارە هەوڵ بدەرەوە.'),
  loadFailed: tri('تعذّر التحميل.', 'Could not load.', 'نەتوانرا بار بکرێت.'),
  done: tri('تم.', 'Done.', 'ئەنجامدرا.'),
  moneyOnly: tri('هذا للمالك أو المدير المالي.', 'This is for the owner or a full admin.', 'ئەمە بۆ خاوەن یان بەڕێوەبەری داراییە.'),
  ownerOnly: tri('هذا للمالك وحده.', 'This is the owner’s alone.', 'ئەمە تەنها هی خاوەنە.'),
  required: tri('مطلوب', 'Required', 'پێویستە'),
  optional: tri('اختياري', 'Optional', 'ئارەزوومەندانە'),
  reason: tri('السبب', 'Reason', 'هۆکار'),
  note: tri('ملاحظة', 'Note', 'تێبینی'),
  prev: tri('السابق', 'Previous', 'پێشوو'),
  next: tri('التالي', 'Next', 'دواتر'),
  page: tri('صفحة', 'Page', 'پەڕە'),
  of: tri('من', 'of', 'لە'),
  user: tri('العميل', 'Customer', 'کڕیار'),
  created: tri('أُنشئ', 'Created', 'دروستکرا'),
  status: tri('الحالة', 'Status', 'دۆخ'),
  actions: tri('إجراءات', 'Actions', 'کردارەکان'),
  details: tri('التفاصيل', 'Details', 'وردەکاری'),
  emptyTitle: tri('لا شيء هنا بعد', 'Nothing here yet', 'هێشتا هیچ شتێک لێرە نییە'),
  readOnly: tri('للقراءة فقط', 'Read only', 'تەنها خوێندنەوە'),
  search: tri('بحث', 'Search', 'گەڕان'),
  id: tri('المعرّف', 'ID', 'ناسنامە'),
};

// ------------------------------------------------------------------ data loading

export interface Loaded<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => Promise<void>;
  setData: React.Dispatch<React.SetStateAction<T | null>>;
}

/**
 * One read, with its four states kept apart (never `[]` for "not loaded"):
 * `data` is null until the first answer, `error` is the last failure. A late
 * answer from an earlier call never overwrites a newer one.
 */
export function useLoad<T>(load: () => Promise<T>, deps: React.DependencyList, enabled = true): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(enabled);
  const seq = useRef(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(load, deps);
  const reload = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const out = await run();
      if (mine === seq.current) setData(out);
    } catch (e) {
      if (mine === seq.current) setError(e);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [run]);
  /** An answer to a read made before this moment is dropped (a newer read, or the screen left). */
  const invalidate = useCallback(() => {
    seq.current++;
  }, []);
  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    void reload();
    return invalidate;
  }, [reload, enabled, invalidate]);
  return { data, error, loading, reload, setData };
}

/** Loading, a failure with retry, or the content — never the empty state for a failed read. */
export function LoadState<T>({ state, children, compact = true }: { state: Loaded<T>; children: (data: T) => ReactNode; compact?: boolean }) {
  const { t } = usePcLang();
  if (state.data === null && state.loading) {
    return (
      <div role="status" className={`flex items-center justify-center gap-2 py-10 text-[13px] ${T.text3}`}>
        <Spinner size="sm" delayMs={0} decorative />
        {t(W.loading)}
      </div>
    );
  }
  if (state.data === null) return <ErrorState error={state.error} onRetry={() => void state.reload()} compact={compact} />;
  return (
    <>
      {state.error !== null && <ErrorState error={state.error} onRetry={() => void state.reload()} compact className="mb-3" />}
      {children(state.data)}
    </>
  );
}

export function Empty({ title, description, icon }: { title?: string; description?: string; icon?: ReactNode }) {
  const { t } = usePcLang();
  return <EmptyState compact icon={icon} title={title ?? t(W.emptyTitle)} description={description} />;
}

// ------------------------------------------------------------------ layout

/** A section's title row: the heading, one quiet line, and its actions at the inline end. */
export function SectionHead({ title, description, actions, level = 2 }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; level?: 2 | 3 }) {
  const H = level === 2 ? 'h2' : 'h3';
  return (
    <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <H className={`${level === 2 ? 'text-[17px]' : 'text-[15px]'} font-bold ${T.text1}`}>{title}</H>
        {description && <p className={`mt-1 max-w-3xl text-[12.5px] leading-relaxed ${T.text3}`}>{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** A tray: one group of related content on the canvas. */
export function Tray({ title, description, actions, children, className = '' }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`${T.surface} min-w-0 p-4 ${className}`}>
      {(title || actions) && <SectionHead level={3} title={title} description={description} actions={actions} />}
      {children}
    </section>
  );
}

/** Label / value pairs. */
export function KV({ rows }: { rows: Array<[ReactNode, ReactNode] | null | false> }) {
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-[13px] sm:grid-cols-2">
      {rows.filter((r): r is [ReactNode, ReactNode] => !!r).map(([k, v], i) => (
        <div key={i} className="min-w-0">
          <dt className={`text-[11.5px] font-semibold ${T.text3}`}>{k}</dt>
          <dd className={`min-w-0 break-words ${T.text1}`}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A line that tells the reader what they cannot do here, and why. */
export function Note({ tone = 'info', children }: { tone?: 'info' | 'warning' | 'danger' | 'success'; children: ReactNode }) {
  return (
    <p role={tone === 'danger' ? 'alert' : 'note'} className={`lv-alert lv-alert-${tone} text-[12.5px] leading-relaxed ${T.text1}`}>
      {children}
    </p>
  );
}

// ------------------------------------------------------------------ small values

/** An id: short in the cell, whole in the title and the copy. */
export function Id({ value, copy = false }: { value: string | null | undefined; copy?: boolean }) {
  if (!value) return <span className={T.text3}>—</span>;
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <bdi dir="ltr" title={value} className="font-mono text-[12px]">
        {shortId(value)}
      </bdi>
      {copy && <CopyButton value={value} />}
    </span>
  );
}

export function CopyButton({ value, label }: { value: string; label?: string }) {
  const { t } = usePcLang();
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={T.btnIconGhost}
      aria-label={`${label ?? t(W.copy)}${done ? ` — ${t(W.copied)}` : ''}`}
      title={label ?? t(W.copy)}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(
          () => {
            setDone(true);
            window.setTimeout(() => setDone(false), 1600);
          },
          () => undefined
        );
      }}
    >
      {done ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
    </button>
  );
}

/** A server state as a word, a dot and a tint (`StatusChip`); an unknown code prints as itself. */
export function State({ table, code, tone }: { table: Readonly<Record<string, Tri>>; code: string | null | undefined; tone?: Tone }) {
  const { lang } = usePcLang();
  return <StatusChip tone={tone ?? 'neutral'}>{labelOf(table, code, lang)}</StatusChip>;
}

/** A yes/no as a word. */
export function YesNo({ value }: { value: unknown }) {
  const { t } = usePcLang();
  const on = value === true || value === 1;
  return <StatusChip tone={on ? 'success' : 'neutral'}>{t(on ? W.yes : W.no)}</StatusChip>;
}

/** JSON evidence, left to right, as the server sent it. */
export function Json({ value }: { value: unknown }) {
  return (
    <pre dir="ltr" className={`max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-[var(--ap-radius-sm)] bg-[var(--ap-surface-2)] p-2 font-mono text-[11.5px] ${T.text2}`}>
      {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

// ------------------------------------------------------------------ controls

/** A button on the admin kit that stays busy while the promise it returns runs (no double submit). */
export function Act({
  kind = 'secondary',
  onClick,
  disabled,
  children,
  icon,
  title,
  type = 'button',
}: {
  kind?: 'primary' | 'secondary' | 'ghost' | 'danger';
  onClick?: () => unknown;
  disabled?: boolean;
  children: ReactNode;
  icon?: ReactNode;
  title?: string;
  type?: 'button' | 'submit';
}) {
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const cls = kind === 'primary' ? T.btnPrimary : kind === 'danger' ? T.btnDanger : kind === 'ghost' ? T.btnGhost : T.btnSecondary;
  return (
    <button
      type={type}
      className={cls}
      disabled={disabled}
      title={title}
      aria-busy={busy || undefined}
      onClick={(e) => {
        if (!onClick) return;
        if (inFlight.current) {
          e.preventDefault();
          return;
        }
        const out = onClick();
        if (out && typeof (out as PromiseLike<unknown>).then === 'function') {
          inFlight.current = true;
          setBusy(true);
          const settle = () => {
            inFlight.current = false;
            setBusy(false);
          };
          (out as PromiseLike<unknown>).then(settle, settle);
        }
      }}
    >
      {busy ? <Spinner size="sm" delayMs={0} decorative /> : icon}
      {children}
    </button>
  );
}

export function RefreshButton({ onClick, loading }: { onClick: () => unknown; loading?: boolean }) {
  const { t } = usePcLang();
  return (
    <Act onClick={onClick} disabled={loading} icon={<RefreshCw size={14} aria-hidden />}>
      {t(W.refresh)}
    </Act>
  );
}

/** A labelled control: the label bound to it, a hint, and the error beside it. */
export function Labeled({
  label,
  hint,
  error,
  children,
  className = '',
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: (id: string, describedBy: string | undefined) => ReactNode;
  className?: string;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className={`flex min-w-0 flex-col gap-1.5 ${className}`}>
      <label htmlFor={id} className={`text-[12px] font-semibold ${T.text2}`}>
        {label}
      </label>
      {children(id, [hintId, errorId].filter(Boolean).join(' ') || undefined)}
      {error ? (
        <p id={errorId} className="lv-field-error">
          {error}
        </p>
      ) : (
        hint && (
          <p id={hintId} className={`text-[11px] leading-[1.5] ${T.text3}`}>
            {hint}
          </p>
        )
      )}
    </div>
  );
}

export function TextField({
  label,
  value,
  onChange,
  hint,
  error,
  ltr,
  disabled,
  placeholder,
  maxLength,
  className,
  inputMode,
  type = 'text',
}: {
  label: ReactNode;
  value: string;
  onChange: (v: string) => void;
  hint?: ReactNode;
  error?: string | null;
  ltr?: boolean;
  disabled?: boolean;
  placeholder?: string;
  maxLength?: number;
  className?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
  type?: 'text' | 'email' | 'date' | 'datetime-local';
}) {
  return (
    <Labeled label={label} hint={hint} error={error} className={className}>
      {(id, describedBy) => (
        <input
          id={id}
          type={type}
          className={T.input}
          dir={ltr ? 'ltr' : undefined}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          maxLength={maxLength}
          inputMode={inputMode}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          autoComplete="off"
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Labeled>
  );
}

export function TextArea({
  label,
  value,
  onChange,
  hint,
  error,
  ltr,
  disabled,
  rows = 3,
  maxLength,
  className,
}: {
  label: ReactNode;
  value: string;
  onChange: (v: string) => void;
  hint?: ReactNode;
  error?: string | null;
  ltr?: boolean;
  disabled?: boolean;
  rows?: number;
  maxLength?: number;
  className?: string;
}) {
  return (
    <Labeled label={label} hint={hint} error={error} className={className}>
      {(id, describedBy) => (
        <textarea
          id={id}
          className={`${T.input} w-full h-auto min-h-[64px] py-2 leading-relaxed resize-y`}
          dir={ltr ? 'ltr' : undefined}
          rows={rows}
          value={value}
          disabled={disabled}
          maxLength={maxLength}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Labeled>
  );
}

/** A whole-number box: what was typed stays typed; `null` is "nothing entered", never zero. */
export function IntField({
  label,
  value,
  onChange,
  hint,
  error,
  disabled,
  unit,
  allowNegative = false,
  className,
}: {
  label: ReactNode;
  value: number | null;
  onChange: (v: number | null) => void;
  hint?: ReactNode;
  error?: string | null;
  disabled?: boolean;
  unit?: string;
  allowNegative?: boolean;
  className?: string;
}) {
  const [text, setText] = useState(value === null ? '' : String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(value === null ? '' : String(value));
  }, [value, focused]);
  return (
    <Labeled
      label={
        unit ? (
          <>
            {label} <span className={T.text3}>({unit})</span>
          </>
        ) : (
          label
        )
      }
      hint={hint}
      error={error}
      className={className}
    >
      {(id, describedBy) => (
        <input
          id={id}
          className={`${T.input} tabular-nums`}
          dir="ltr"
          inputMode={allowNegative ? 'text' : 'numeric'}
          value={text}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          autoComplete="off"
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => {
            const ascii = e.target.value
              .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
              .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
              .replace(/[,٬\s]/g, '');
            const cleaned = allowNegative ? ascii.replace(/[^\d-]/g, '').replace(/(?!^)-/g, '') : ascii.replace(/[^\d]/g, '');
            setText(cleaned);
            if (cleaned === '' || cleaned === '-') onChange(null);
            else {
              const n = Number(cleaned);
              onChange(Number.isSafeInteger(n) ? n : null);
            }
          }}
        />
      )}
    </Labeled>
  );
}

export function SelectField({
  label,
  value,
  onChange,
  options,
  hint,
  error,
  disabled,
  placeholder,
  className,
}: {
  label: ReactNode;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  hint?: ReactNode;
  error?: string | null;
  disabled?: boolean;
  /** An empty first option («—»), for an optional choice. */
  placeholder?: string;
  className?: string;
}) {
  return (
    <Labeled label={label} hint={hint} error={error} className={className}>
      {(id, describedBy) => (
        <select
          id={id}
          className={T.select}
          value={value}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
        >
          {placeholder !== undefined && <option value="">{placeholder}</option>}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </Labeled>
  );
}

// ------------------------------------------------------------------ lists

export interface PcColumn<R> {
  id: string;
  header: ReactNode;
  cell: (row: R) => ReactNode;
  /**
   * Its part on a phone's card: the row's name (`title`), a chip beside it
   * (`badge`), a quiet line under it (`meta`), a label/value pair (`field`,
   * the default) — or the table only (`hidden`).
   */
  card?: 'title' | 'badge' | 'meta' | 'field' | 'hidden';
  /** Money, counts, durations: end-aligned and tabular in the table. */
  numeric?: boolean;
}

export interface PcAction {
  id: string;
  label: string;
  onSelect: () => void;
}

const CELL = 'px-3 py-2.5 text-[13px] align-middle';
const CELL_HEAD = `${CELL} text-start font-semibold text-[11.5px] whitespace-nowrap`;
/**
 * The actions column stays against the inline-end edge while a wide table
 * scrolls (the admin's other tables do the same: in RTL the last column is
 * the one that would leave the screen).
 */
const STICKY_ACTIONS = [
  '[&_tr>*:last-child]:sticky',
  '[&_tr>*:last-child]:end-0',
  '[&_tr>*:last-child]:z-[1]',
  '[&_tbody_tr>*:last-child]:bg-[var(--ap-surface-1)]',
  '[&_thead_tr>*:last-child]:bg-[var(--ap-surface-2)]',
].join(' ');

/**
 * A list of server rows: cards on a phone, a table from `sm` up. Its four
 * states are kept apart — loading, a failure with retry, an empty answer and
 * the rows — and a failed read is never shown as an empty list. Built from
 * the admin kit only (it adds no rule to any stylesheet).
 */
export function PcList<R>({
  label,
  columns,
  rows,
  rowKey,
  loading,
  error,
  onRetry,
  empty,
  rowLabel,
  rowActions,
}: {
  label: string;
  columns: PcColumn<R>[];
  /** null/undefined until the first answer — never `[]` for «not loaded». */
  rows: readonly R[] | null | undefined;
  rowKey: (row: R) => string;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  empty?: { title?: string; description?: string; icon?: ReactNode };
  rowLabel?: (row: R) => string;
  rowActions?: (row: R) => PcAction[];
}) {
  const { t } = usePcLang();
  const failure = error !== null && error !== undefined ? <ErrorState error={error} onRetry={onRetry} compact /> : null;
  if (!rows) {
    if (failure && !loading) return failure;
    return (
      <div role="status" className={`flex items-center justify-center gap-2 py-10 text-[13px] ${T.text3}`}>
        <Spinner size="sm" delayMs={0} decorative />
        {t(W.loading)}
      </div>
    );
  }
  if (rows.length === 0) return failure ?? <EmptyState compact icon={empty?.icon} title={empty?.title ?? t(W.emptyTitle)} description={empty?.description} />;
  const title = columns.find((c) => c.card === 'title');
  const badges = columns.filter((c) => c.card === 'badge');
  const metas = columns.filter((c) => c.card === 'meta');
  const fields = columns.filter((c) => !c.card || c.card === 'field');
  const buttons = (r: R) =>
    (rowActions?.(r) ?? []).map((a) => (
      <button key={a.id} type="button" className={T.btnGhostSm} aria-label={rowLabel ? `${a.label} — ${rowLabel(r)}` : undefined} onClick={a.onSelect}>
        {a.label}
      </button>
    ));
  return (
    <div className="space-y-2" aria-busy={loading || undefined}>
      {failure}
      <ul aria-label={label} className="space-y-2 sm:hidden">
        {rows.map((r) => (
          <li key={rowKey(r)} className={`${T.surface} space-y-1.5 p-3 text-[13px]`}>
            <div className="flex items-start justify-between gap-2">
              <div className={`min-w-0 font-semibold ${T.text1}`}>{title?.cell(r)}</div>
              {badges.map((c) => (
                <span key={c.id} className="shrink-0">
                  {c.cell(r)}
                </span>
              ))}
            </div>
            {metas.map((c) => (
              <p key={c.id} className={`text-[11.5px] ${T.text3}`}>
                {c.cell(r)}
              </p>
            ))}
            {fields.length > 0 && (
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
                {fields.map((c) => (
                  <div key={c.id} className="min-w-0">
                    <dt className={`text-[11px] ${T.text3}`}>{c.header}</dt>
                    <dd className={`min-w-0 break-words ${T.text1} ${c.numeric ? 'tabular-nums' : ''}`}>{c.cell(r)}</dd>
                  </div>
                ))}
              </dl>
            )}
            {rowActions && <div className="flex flex-wrap gap-1">{buttons(r)}</div>}
          </li>
        ))}
      </ul>
      <div className={`${T.surface} hidden overflow-x-auto sm:block`}>
        <table className={`w-full border-collapse ${rowActions ? STICKY_ACTIONS : ''}`} style={{ minWidth: 640 }}>
          <caption className="sr-only">{label}</caption>
          <thead className={T.tableHead}>
            <tr>
              {columns.map((c) => (
                <th key={c.id} scope="col" className={`${CELL_HEAD} ${c.numeric ? 'text-end' : ''}`}>
                  {c.header}
                </th>
              ))}
              {rowActions && (
                <th scope="col" className={CELL_HEAD}>
                  <span className="sr-only">{t(W.actions)}</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--ap-hairline)]">
            {rows.map((r) => (
              <tr key={rowKey(r)} className={T.tableRow}>
                {columns.map((c) => (
                  <td key={c.id} className={`${CELL} ${T.text1} ${c.numeric ? 'text-end tabular-nums' : ''}`}>
                    {c.cell(r)}
                  </td>
                ))}
                {rowActions && (
                  <td className={`${CELL} text-end`}>
                    <div className="flex justify-end gap-1">{buttons(r)}</div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** A row of filter chips (one pressed). */
export function Chips<V extends string>({ items, value, onChange, label }: { items: Array<{ id: V; label: ReactNode; count?: number }>; value: V; onChange: (v: V) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="flex gap-1.5 overflow-x-auto py-1">
      {items.map((it) => (
        <button key={it.id} type="button" className={`${T.chip} shrink-0`} aria-pressed={it.id === value} onClick={() => onChange(it.id)}>
          {it.label}
          {typeof it.count === 'number' && <span className="tabular-nums opacity-70">{it.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Client-side pages over a list the server returned whole (its own cap is stated by the caller). */
export function usePaged<R>(rows: readonly R[] | null, size = 50) {
  const [page, setPage] = useState(0);
  const total = rows ? Math.max(1, Math.ceil(rows.length / size)) : 1;
  useEffect(() => {
    if (page > total - 1) setPage(0);
  }, [page, total]);
  const slice = rows ? rows.slice(page * size, page * size + size) : null;
  return { page, setPage, total, slice };
}

export function Pager({ page, total, onPage }: { page: number; total: number; onPage: (p: number) => void }) {
  const { t } = usePcLang();
  if (total <= 1) return null;
  return (
    <nav aria-label={t(W.page)} className="mt-3 flex items-center justify-center gap-2">
      <button type="button" className={T.pageBtn} disabled={page === 0} onClick={() => onPage(page - 1)}>
        {t(W.prev)}
      </button>
      <span className={`text-[12px] tabular-nums ${T.text3}`}>
        {t(W.page)} {page + 1} {t(W.of)} {total}
      </span>
      <button type="button" className={T.pageBtn} disabled={page >= total - 1} onClick={() => onPage(page + 1)}>
        {t(W.next)}
      </button>
    </nav>
  );
}

/** A plain bar for a share (0–1): no chart library, the figure beside it is the fact. */
export function Bar({ share }: { share: number }) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(share) ? share : 0)) * 100;
  return (
    <div aria-hidden className="h-2 w-full overflow-hidden rounded-full bg-[var(--ap-surface-3)]">
      <div className="h-full rounded-full bg-[var(--ap-accent)]" style={{ width: `${pct}%` }} />
    </div>
  );
}

/** The last action's outcome as a line (success, or the refusal in the reader's language). */
export function useOutcome() {
  const { lang } = usePcLang();
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);
  const fail = useCallback((e: unknown, fallback: string, fieldLabel?: (f: string) => string | null) => setOutcome({ ok: false, text: pcRefusal(e, lang, fallback, fieldLabel) }), [lang]);
  const ok = useCallback((text: string) => setOutcome({ ok: true, text }), []);
  return { outcome, ok, fail, clear: () => setOutcome(null) };
}

export function Outcome({ value }: { value: { ok: boolean; text: string } | null }) {
  if (!value) return null;
  return <Note tone={value.ok ? 'success' : 'danger'}>{value.text}</Note>;
}
